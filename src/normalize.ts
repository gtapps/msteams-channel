/**
 * Teams activity -> `notifications/claude/channel` payload.
 *
 * Two contract rules that are easy to get wrong and silently lossy:
 *
 *   - `meta` keys must match /^[A-Za-z0-9_]+$/. Hyphenated keys are dropped
 *     without error, so a typo here becomes an invisible bug.
 *   - Every meta value must be a string.
 *
 * File paths go in `meta`, never in `content`. An in-content annotation like
 * "[image attached — read: /path]" is forgeable by any sender who simply types
 * that string; a meta key is not.
 */

import { normalizeConversationId, extractThreadId, type ConversationType } from './gate.js'

export type ChannelNotification = {
  content: string
  meta: Record<string, string>
}

export type Attachment = {
  id: string
  kind: string
  size?: number
  mime?: string
  name?: string
}

export type NormalizeInput = {
  activity: Record<string, any>
  /** Images we eagerly downloaded AFTER the gate passed, in arrival order. */
  imagePaths?: string[]
  /** Every real file on the activity — not just the first of each kind. */
  attachments?: Attachment[]
}

const META_KEY = /^[A-Za-z0-9_]+$/

/** Filenames reach the model as meta; strip path separators and control chars. */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/]/g, '_')
    .slice(0, 200)
}

function put(meta: Record<string, string>, key: string, value: unknown): void {
  if (value === undefined || value === null || value === '') return
  if (!META_KEY.test(key)) {
    // Fail loud in our own tests rather than let the harness drop it silently.
    throw new Error(`meta key "${key}" is not [A-Za-z0-9_]+ and would be dropped`)
  }
  meta[key] = String(value)
}

export function normalize(input: NormalizeInput): ChannelNotification {
  const a = input.activity
  const conversationType = (a.conversation?.conversationType ?? 'personal') as ConversationType
  const meta: Record<string, string> = {}

  const rawConversationId = String(a.conversation?.id ?? '')
  put(meta, 'conversation_id', normalizeConversationId(rawConversationId))
  put(meta, 'conversation_type', conversationType)
  put(meta, 'message_id', a.id)
  // Channels only, and the one value a reply must thread on — see extractThreadId.
  put(meta, 'thread_id', extractThreadId(rawConversationId, conversationType, a.replyToId))
  put(meta, 'user', a.from?.name)
  put(meta, 'user_id', a.from?.aadObjectId)
  put(meta, 'tenant_id', a.channelData?.tenant?.id ?? a.conversation?.tenantId)
  put(meta, 'ts', a.timestamp ?? new Date().toISOString())

  // Never observed on this tenant — Teams leaves it absent even on a genuine
  // thread reply, which is why threading uses the conversation id instead
  // (tests/fixtures.test.ts asserts the absence). Emitted only so a tenant or
  // activity type that does set it is not silently discarded; do not build on it.
  put(meta, 'reply_to_id', a.replyToId)

  const imagePaths = input.imagePaths ?? []
  const attachments = input.attachments ?? []

  // The first of each kind keeps its own key: the overwhelmingly common case is
  // one file, and a single key is what the instructions teach.
  if (imagePaths[0]) put(meta, 'image_path', imagePaths[0])
  if (imagePaths.length > 1) put(meta, 'image_paths', imagePaths.join('; '))

  const firstFile = attachments.find(f => f.kind !== 'image')
  if (firstFile) {
    put(meta, 'attachment_id', firstFile.id)
    put(meta, 'attachment_kind', firstFile.kind)
    if (firstFile.size != null) put(meta, 'attachment_size', String(firstFile.size))
    put(meta, 'attachment_mime', firstFile.mime)
    if (firstFile.name) put(meta, 'attachment_name', sanitizeFilename(firstFile.name))
  }

  // But a second file must not become unreachable. Count plus a listing that
  // carries every handle, matching discord's `attachment_count`/`attachments`
  // pair (external_plugins/discord/server.ts @ db253f26).
  if (attachments.length) {
    put(meta, 'attachment_count', String(attachments.length))
    if (attachments.length > 1) {
      put(
        meta,
        'attachments',
        attachments
          .map(f => `${sanitizeFilename(f.name ?? 'file')} (${f.mime ?? 'unknown'}) id=${f.id}`)
          .join('; '),
      )
    }
  }

  const text = typeof a.text === 'string' ? a.text : ''
  const named = attachments.find(f => f.name)?.name
  const fallback = named ? `(${sanitizeFilename(named)})` : imagePaths.length ? '(image)' : ''

  return { content: text || fallback, meta }
}
