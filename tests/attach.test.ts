import { test, expect, describe, beforeAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildImageAttachment,
  loadSendableFile,
  assertSendable,
  sanitizeAttachmentName,
  fileTypeOf,
  MAX_INLINE_IMAGE_BYTES,
} from '../src/attach.js'

let root: string
let stateDir: string
let png: string

const HUGE = 100 * 1024 * 1024

/** Most tests want the snapshot of a path, with no size ceiling in the way. */
const snapshot = (path: string) => loadSendableFile(path, stateDir, HUGE)

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
    const attachment = buildImageAttachment(snapshot(png))

    expect(attachment.contentType).toBe('image/png')
    expect(attachment.name).toBe('chart.png')
    expect(attachment.contentUrl).toBe(`data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`)
  })

  test('extension casing does not matter', () => {
    const upper = join(root, 'SHOT.PNG')
    writeFileSync(upper, 'x')
    expect(buildImageAttachment(snapshot(upper)).contentType).toBe('image/png')
  })

  test('a non-image is refused with an actionable message, not silently dropped', () => {
    const pdf = join(root, 'report.pdf')
    writeFileSync(pdf, 'x')

    // Routing sends these to the consent or SharePoint flow long before here,
    // so this is the "that routing broke" message.
    expect(() => buildImageAttachment(snapshot(pdf))).toThrow(/only accepts images inline/)
  })

  test('an image at or over the 4MB inline limit is refused', () => {
    const big = join(root, 'huge.png')
    writeFileSync(big, Buffer.alloc(MAX_INLINE_IMAGE_BYTES))

    expect(() => buildImageAttachment(snapshot(big))).toThrow(/exceeds the 4MB inline limit/)
  })
})

describe('loadSendableFile', () => {
  test('the snapshot is the bytes on disk at that moment', () => {
    const path = join(root, 'notes.txt')
    writeFileSync(path, 'first')

    const file = loadSendableFile(path, stateDir, HUGE)
    writeFileSync(path, 'second, much longer')

    // What gets sent is what was read, not whatever the path points at later.
    expect(file.bytes.toString()).toBe('first')
    expect(file.size).toBe(5)
    expect(file.filename).toBe('notes.txt')
  })

  test('an oversized file is refused without being read into memory', () => {
    const path = join(root, 'big.bin')
    writeFileSync(path, Buffer.alloc(2048))

    expect(() => loadSendableFile(path, stateDir, 1024)).toThrow(/2KB exceeds the 1KB limit/)
  })

  test('a missing file surfaces a read error rather than sending nothing', () => {
    expect(() => snapshot(join(root, 'gone.png'))).toThrow()
  })

  test('anything that is not a regular file is refused', () => {
    // A fifo would block the read forever; a directory would fail obscurely.
    expect(() => snapshot(join(root))).toThrow(/not a regular file/)
  })

  test('the state-dir guard runs before anything is opened', () => {
    const env = join(stateDir, '.env')
    writeFileSync(env, 'MSTEAMS_APP_PASSWORD=secret')

    expect(() => snapshot(env)).toThrow(/refusing to send channel state/)
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

  test('refuses a snapshot of a file already offered to someone else', () => {
    mkdirSync(join(stateDir, 'pending-uploads'), { recursive: true })
    const snap = join(stateDir, 'pending-uploads', 'abc.bin')
    writeFileSync(snap, 'someone elses file')

    expect(() => assertSendable(snap, stateDir)).toThrow(/refusing to send channel state/)
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

describe('fileTypeOf', () => {
  test('is the lowercased extension Teams uses for the file icon', () => {
    expect(fileTypeOf('Quarterly.Report.PDF')).toBe('pdf')
    expect(fileTypeOf('README')).toBe('')
  })
})
