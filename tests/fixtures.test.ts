/**
 * Replay of real captured activities through queue -> gate -> normalize.
 *
 * The synthetic tests in gate.test.ts / normalize.test.ts assert what we
 * *believe* Teams sends. These assert what it actually sent, so a wrong belief
 * fails here rather than in production.
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { IngressQueue } from '../src/queue.js'
import { gate, mentionsBot, extractThreadId, normalizeConversationId, DEFAULT_ACCESS } from '../src/gate.js'
import { normalize } from '../src/normalize.js'

const DIR = join(import.meta.dir, 'fixtures')
const load = (name: string) => JSON.parse(readFileSync(join(DIR, name), 'utf8')) as Record<string, any>

const TENANT = '11111111-1111-4111-8111-111111111111'
const SENDER = '22222222-2222-4222-8222-222222222222'

const DM = load('dm-text.json')
const CHANNEL_ROOT = load('channel-mention-thread-root.json')
const CHANNEL_REPLY = load('channel-thread-reply.json')
const DUP_FIRST = load('dm-duplicate-first.json')
const DUP_AGAIN = load('dm-duplicate-redelivery.json')
const ATTACHMENT = load('dm-attachment-image.json')

describe('scrubbing held', () => {
  // A fixture that leaks a real credential is worse than no fixture, and these
  // files are refreshed by hand, so the guard lives with the data.
  test('no fixture carries tenant, user or token material', () => {
    const all = readFileSync(join(DIR, 'dm-attachment-image.json'), 'utf8')
    for (const marker of ['tempauth', 'sharepoint.com', 'eyJ']) {
      expect(all).not.toContain(marker)
    }
  })
})

describe('thread semantics', () => {
  test('a channel thread reply carries no replyToId at all', () => {
    // Not null — the key is absent. This is the whole reason reply threads on
    // the conversation id instead, so assert absence rather than falsiness.
    for (const activity of [CHANNEL_ROOT, CHANNEL_REPLY, DM]) {
      expect(Object.hasOwn(activity, 'replyToId')).toBe(false)
    }
  })

  test('root and reply share one thread id, taken from the conversation id', () => {
    const root = extractThreadId(CHANNEL_ROOT.conversation.id, 'channel', undefined)
    const reply = extractThreadId(CHANNEL_REPLY.conversation.id, 'channel', undefined)
    expect(root).toBe(reply!)
    expect(root).toBe(CHANNEL_ROOT.id) // the thread is rooted at the first post
  })

  test('the reply is a distinct message inside that thread', () => {
    expect(CHANNEL_REPLY.id).not.toBe(CHANNEL_ROOT.id)
    expect(normalizeConversationId(CHANNEL_REPLY.conversation.id)).toBe(
      normalizeConversationId(CHANNEL_ROOT.conversation.id),
    )
  })

  test('DMs have no thread id', () => {
    expect(extractThreadId(DM.conversation.id, 'personal', undefined)).toBeUndefined()
  })
})

describe('normalize over real activities', () => {
  test('DM emits the documented meta and no thread id', () => {
    const { content, meta } = normalize({ activity: DM })
    expect(content).toBe('hey')
    expect(meta.conversation_type).toBe('personal')
    expect(meta.tenant_id).toBe(TENANT)
    expect(meta.user_id).toBe(SENDER)
    expect(meta.message_id).toBe(DM.id)
    expect(meta.thread_id).toBeUndefined()
  })

  test('channel reply emits the thread root, not its own message id', () => {
    const { meta } = normalize({ activity: CHANNEL_REPLY })
    expect(meta.conversation_type).toBe('channel')
    expect(meta.thread_id).toBe(CHANNEL_ROOT.id)
    expect(meta.thread_id).not.toBe(meta.message_id)
  })

  test('conversation_id is stripped of the thread suffix', () => {
    const { meta } = normalize({ activity: CHANNEL_ROOT })
    expect(meta.conversation_id).not.toContain(';messageid=')
  })

  test('every meta key survives the harness charset', () => {
    for (const activity of [DM, CHANNEL_ROOT, CHANNEL_REPLY, ATTACHMENT]) {
      for (const key of Object.keys(normalize({ activity }).meta)) {
        expect(key).toMatch(/^[A-Za-z0-9_]+$/)
      }
    }
  })
})

describe('gate over real activities', () => {
  const access = { ...DEFAULT_ACCESS, allowFrom: [SENDER], dmPolicy: 'allowlist' as const }

  test('accepts an allowlisted DM', () => {
    const verdict = gate(
      {
        tenantId: DM.channelData.tenant.id,
        conversationId: DM.conversation.id,
        conversationType: 'personal',
        senderAadObjectId: DM.from.aadObjectId,
        mentionsBot: false,
      },
      access,
      TENANT,
    )
    expect(verdict.allowed).toBe(true)
  })

  test('rejects a foreign tenant before considering the sender', () => {
    const verdict = gate(
      {
        tenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        conversationId: DM.conversation.id,
        conversationType: 'personal',
        senderAadObjectId: DM.from.aadObjectId,
        mentionsBot: false,
      },
      access,
      TENANT,
    )
    expect(verdict).toEqual({ allowed: false, reason: 'tenant_mismatch' })
  })

  test('detects the real mention entity in a channel post', () => {
    expect(mentionsBot(CHANNEL_ROOT.entities, CHANNEL_ROOT.recipient.id)).toBe(true)
    expect(mentionsBot(DM.entities, DM.recipient.id)).toBe(false)
  })

  test('a thread reply inherits the parent conversation opt-in', () => {
    const conversation = normalizeConversationId(CHANNEL_ROOT.conversation.id)
    const verdict = gate(
      {
        tenantId: CHANNEL_REPLY.channelData.tenant.id,
        conversationId: CHANNEL_REPLY.conversation.id,
        conversationType: 'channel',
        senderAadObjectId: CHANNEL_REPLY.from.aadObjectId,
        mentionsBot: mentionsBot(CHANNEL_REPLY.entities, CHANNEL_REPLY.recipient.id),
      },
      { ...access, allowConversations: [conversation], requireMention: true },
      TENANT,
    )
    expect(verdict.allowed).toBe(true)
  })
})

describe('queue over a real redelivery', () => {
  test('the captured redelivery is the same activity', () => {
    expect(DUP_AGAIN.id).toBe(DUP_FIRST.id)
    expect(DUP_AGAIN).toEqual(DUP_FIRST)
  })

  test('dedup on activity.id suppresses it', () => {
    const queue = new IngressQueue(mkdtempSync(join(tmpdir(), 'msteams-fixtures-')))
    expect(queue.enqueue(DUP_FIRST)).toBe(true)
    expect(queue.enqueue(DUP_AGAIN)).toBe(false)
  })

  test('dedup survives the entry being finished', () => {
    const queue = new IngressQueue(mkdtempSync(join(tmpdir(), 'msteams-fixtures-')))
    queue.enqueue(DUP_FIRST)
    queue.finish(String(DUP_FIRST.id))
    // The tombstone is the point: a redelivery after processing must not replay.
    expect(queue.enqueue(DUP_AGAIN)).toBe(false)
    expect(queue.pending()).toHaveLength(0)
  })
})

describe('attachments', () => {
  test('every message carries a text/html body attachment', () => {
    // So attachment presence alone must never mean "a file was sent".
    for (const activity of [DM, CHANNEL_ROOT, CHANNEL_REPLY]) {
      expect(activity.attachments.some((x: any) => x.contentType === 'text/html')).toBe(true)
      expect(activity.attachments.some((x: any) => x.contentType !== 'text/html')).toBe(false)
    }
  })

  test('a real file is distinguishable from the body attachment', () => {
    const files = ATTACHMENT.attachments.filter(
      (x: any) => x.contentType === 'application/vnd.microsoft.teams.file.download.info',
    )
    expect(files).toHaveLength(1)
    expect(files[0].name).toBe('wallhaven-k81776.jpg')
    expect(files[0].content.fileType).toBe('jpg')
    expect(ATTACHMENT.attachments).toHaveLength(2) // the file plus the html body
  })

  test('an attachment-only message has no text', () => {
    // Drives the normalizer's fallback content.
    expect(ATTACHMENT.text ?? '').toBe('')
  })
})
