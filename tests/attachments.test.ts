import { test, expect, describe, beforeEach } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AttachmentHandles,
  isBodyOrCard,
  safeInboxName,
  HANDLE_TTL_MS,
  TEAMS_FILE_DOWNLOAD_INFO,
} from '../src/attachments.js'

const FIXTURES = join(import.meta.dir, 'fixtures')
const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, any>

const DM = load('dm-text.json')
const ATTACHMENT = load('dm-attachment-image.json')
const DM_PASTED = load('dm-pasted-image.json')
const GROUP_PASTED = load('groupchat-pasted-image.json')

let inbox: string
beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), 'msteams-inbox-'))
})

describe('classification', () => {
  test('the message body attachment is not a file', () => {
    // Every Teams message carries one, so getting this wrong means claiming a
    // file was attached to literally every message.
    expect(isBodyOrCard('text/html')).toBe(true)
    expect(isBodyOrCard('application/vnd.microsoft.card.adaptive')).toBe(true)
    expect(isBodyOrCard('application/vnd.microsoft.teams.card.list')).toBe(true)
    expect(isBodyOrCard(TEAMS_FILE_DOWNLOAD_INFO)).toBe(false)
  })

  test('a plain text DM registers no attachments', () => {
    expect(new AttachmentHandles().register(DM)).toHaveLength(0)
  })

  test('a real file registers exactly one, classified by its type', () => {
    const files = new AttachmentHandles().register(ATTACHMENT)

    expect(files).toHaveLength(1)
    expect(files[0].kind).toBe('image')
    expect(files[0].name).toBe('test-image.jpg')
  })

  test('the same activity always yields the same handle', () => {
    const first = new AttachmentHandles().register(ATTACHMENT)[0]
    const second = new AttachmentHandles().register(ATTACHMENT)[0]
    expect(first.id).toBe(second.id)
  })
})

describe('the download URL is a credential', () => {
  test('it never reaches what the model is given', () => {
    // The fixture's URL is redacted, but the shape is what matters: whatever
    // is in content.downloadUrl must not appear on the returned object.
    const handles = new AttachmentHandles()
    const files = handles.register(ATTACHMENT)

    const exposed = JSON.stringify(files)
    expect(exposed).not.toContain('downloadUrl')
    expect(exposed).not.toContain('REDACTED_ATTACHMENT_URL')
  })

  test('a failed download does not put it in the error', async () => {
    const handles = new AttachmentHandles()
    const id = handles.register(ATTACHMENT)[0].id

    // example.invalid never resolves, so this exercises the fetch failure path.
    const err = await handles.download(id, inbox).catch((e: Error) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain('REDACTED_ATTACHMENT_URL')
    expect((err as Error).message).not.toContain('http')
  })
})

describe('handles', () => {
  test('an unknown id is rejected, not silently ignored', async () => {
    await expect(new AttachmentHandles().download('nope', inbox)).rejects.toThrow(/unknown attachment id/)
  })

  test('handles expire, because the token inside them does', async () => {
    const handles = new AttachmentHandles()
    const id = handles.register(ATTACHMENT, 0)[0].id

    // Within the window the handle resolves, so the failure is the fetch (the
    // fixture URL is redacted to example.invalid) rather than a missing handle.
    const inWindow = await handles.download(id, inbox, HANDLE_TTL_MS - 1).catch((e: Error) => e)
    expect((inWindow as Error).message).not.toMatch(/unknown attachment id/)

    // Past it, the handle is gone — expired and never-existed look the same
    // to a caller, which is the point.
    await expect(handles.download(id, inbox, HANDLE_TTL_MS + 1)).rejects.toThrow(/unknown attachment id/)
  })

  test('nothing is written to the inbox on a failed download', async () => {
    const handles = new AttachmentHandles()
    const id = handles.register(ATTACHMENT)[0].id

    await handles.download(id, inbox).catch(() => {})

    expect(readdirSync(inbox)).toHaveLength(0)
  })
})

describe('pasted images', () => {
  // A screenshot pasted into the compose box (no paperclip) arrives as an
  // `image/*` attachment whose contentUrl is on Bot Framework, plus the same
  // image as an <img> in the text/html body. DMs and group chats look the same.
  const BF_URL = (a: Record<string, any>) => a.attachments[0].contentUrl as string
  const withContentUrl = (url: string) => {
    const activity = structuredClone(DM_PASTED)
    activity.attachments[0].contentUrl = url
    return activity
  }

  // Captures what fetch was called with, and answers as Bot Framework would.
  async function withFetch(run: (calls: { url: string; auth?: string }[]) => Promise<void>) {
    const calls: { url: string; auth?: string }[] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.Authorization })
      return new Response(new Uint8Array([255, 216, 255, 224]))
    }) as typeof fetch
    try {
      await run(calls)
    } finally {
      globalThis.fetch = real
    }
  }

  test('a DM paste registers as one image; the html body copy is ignored', () => {
    const files = new AttachmentHandles().register(DM_PASTED)
    expect(files).toHaveLength(1)
    expect(files[0].kind).toBe('image')
    expect(JSON.stringify(files)).not.toContain('trafficmanager')
  })

  test('a group chat paste arrives the same way', () => {
    const files = new AttachmentHandles().register(GROUP_PASTED)
    expect(files).toHaveLength(1)
    expect(files[0].kind).toBe('image')
  })

  test('a contentUrl off Bot Framework is dropped, so the bot token cannot be sent there', () => {
    for (const url of [
      'https://evil.example/x.png',
      'http://smba.trafficmanager.net/x',
      'https://smba.trafficmanager.net.evil.example/x',
      'not a url',
    ]) {
      expect(new AttachmentHandles().register(withContentUrl(url))).toHaveLength(0)
    }
  })

  test('it downloads with the bot token', async () => {
    await withFetch(async calls => {
      const handles = new AttachmentHandles(async () => 'BOT_TOKEN')
      const path = await handles.download(handles.register(GROUP_PASTED)[0].id, inbox)
      expect(calls).toEqual([{ url: BF_URL(GROUP_PASTED), auth: 'Bearer BOT_TOKEN' }])
      expect(readFileSync(path)).toEqual(Buffer.from([255, 216, 255, 224]))
    })
  })

  test('a paperclip file never gets the bot token', async () => {
    await withFetch(async calls => {
      const handles = new AttachmentHandles(async () => 'BOT_TOKEN')
      await handles.download(handles.register(ATTACHMENT)[0].id, inbox)
      expect(calls[0].auth).toBeUndefined()
    })
  })

  test('without a token source a pasted image fails cleanly', async () => {
    const handles = new AttachmentHandles()
    const id = handles.register(DM_PASTED)[0].id
    await expect(handles.download(id, inbox)).rejects.toThrow(/no bot credentials/)
  })
})

describe('safeInboxName', () => {
  test('the sender never controls the filename, only its extension', () => {
    // The id is ours and filename-safe; the name is the sender's.
    const name = safeInboxName('abc123', { name: '../../etc/passwd', fileType: 'jpg' })
    expect(name).toBe('abc123.jpg')
  })

  test('a hostile extension is stripped to nothing usable', () => {
    expect(safeInboxName('abc123', { name: 'x', fileType: '../../evil' })).toBe('abc123.evil')
  })

  test('no extension is fine', () => {
    expect(safeInboxName('abc123', {})).toBe('abc123')
  })
})
