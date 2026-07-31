import { test, expect, describe, beforeAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildImageAttachment,
  assertSendable,
  sanitizeAttachmentName,
  MAX_INLINE_IMAGE_BYTES,
} from '../src/attach.js'

let root: string
let stateDir: string
let png: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'msteams-attach-'))
  stateDir = join(root, 'state')
  for (const dir of ['inbox', 'conversations']) {
    mkdirSync(join(stateDir, dir), { recursive: true })
  }
  png = join(root, 'chart.png')
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
})

describe('buildImageAttachment', () => {
  test('an image becomes a base64 data URI Teams accepts inline', () => {
    const attachment = buildImageAttachment(png, stateDir)

    expect(attachment.contentType).toBe('image/png')
    expect(attachment.name).toBe('chart.png')
    expect(attachment.contentUrl).toBe(`data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`)
  })

  test('extension casing does not matter', () => {
    const upper = join(root, 'SHOT.PNG')
    writeFileSync(upper, 'x')
    expect(buildImageAttachment(upper, stateDir).contentType).toBe('image/png')
  })

  test('a non-image is refused with an actionable message, not silently dropped', () => {
    const pdf = join(root, 'report.pdf')
    writeFileSync(pdf, 'x')

    // Teams requires a consent round trip for these; the sender must be told
    // why nothing arrived rather than being left waiting.
    expect(() => buildImageAttachment(pdf, stateDir)).toThrow(/only accepts images inline/)
  })

  test('an image at or over the 4MB inline limit is refused', () => {
    const big = join(root, 'huge.png')
    writeFileSync(big, Buffer.alloc(MAX_INLINE_IMAGE_BYTES))

    expect(() => buildImageAttachment(big, stateDir)).toThrow(/exceeds the 4MB inline limit/)
  })

  test('a missing file surfaces a read error rather than sending nothing', () => {
    expect(() => buildImageAttachment(join(root, 'gone.png'), stateDir)).toThrow()
  })
})

describe('assertSendable', () => {
  test('refuses the credentials file', () => {
    const env = join(stateDir, '.env')
    writeFileSync(env, 'MSTEAMS_APP_PASSWORD=secret')

    expect(() => assertSendable(env, stateDir)).toThrow(/refusing to send channel state/)
  })

  test('refuses a stored conversation reference', () => {
    // These are proactive-send targets; leaking one hands over a way to post
    // as the bot.
    const ref = join(stateDir, 'conversations', 'abc.json')
    writeFileSync(ref, '{}')

    expect(() => assertSendable(ref, stateDir)).toThrow(/refusing to send channel state/)
  })

  test('allows inbox files, which are inbound downloads', () => {
    const inbound = join(stateDir, 'inbox', 'photo.png')
    writeFileSync(inbound, 'x')

    expect(() => assertSendable(inbound, stateDir)).not.toThrow()
  })

  test('allows a file outside the state dir', () => {
    expect(() => assertSendable(png, stateDir)).not.toThrow()
  })

  test('a symlink pointing into the state dir is still refused', () => {
    // realpath is why: the guard must not be defeatable by indirection.
    const bait = join(root, 'innocent.png')
    symlinkSync(join(stateDir, '.env'), bait)

    expect(() => assertSendable(bait, stateDir)).toThrow(/refusing to send channel state/)
  })

  test('the guard runs before anything is read', () => {
    const env = join(stateDir, '.env')
    expect(() => buildImageAttachment(env, stateDir)).toThrow(/refusing to send channel state/)
  })
})

describe('sanitizeAttachmentName', () => {
  test('keeps only the basename so no path reaches the client', () => {
    expect(sanitizeAttachmentName('/etc/passwd')).toBe('passwd')
  })

  test('strips control characters', () => {
    expect(sanitizeAttachmentName('re\x00\x1bport.png')).toBe('report.png')
  })

  test('never returns empty', () => {
    expect(sanitizeAttachmentName('')).toBe('file')
  })
})
