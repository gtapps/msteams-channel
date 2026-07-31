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
  /** Set only for images we eagerly downloaded AFTER the gate passed. */
  imagePath?: string
  /** Lazily-referenced attachment the model can fetch via download_attachment. */
  attachment?: Attachment
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

  // Present when this activity is itself a reply inside a thread.
  put(meta, 'reply_to_id', a.replyToId)

  if (input.imagePath) put(meta, 'image_path', input.imagePath)

  if (input.attachment) {
    put(meta, 'attachment_id', input.attachment.id)
    put(meta, 'attachment_kind', input.attachment.kind)
    if (input.attachment.size != null) put(meta, 'attachment_size', String(input.attachment.size))
    put(meta, 'attachment_mime', input.attachment.mime)
    if (input.attachment.name) put(meta, 'attachment_name', sanitizeFilename(input.attachment.name))
  }

  const text = typeof a.text === 'string' ? a.text : ''
  const fallback = input.attachment?.name
    ? `(${sanitizeFilename(input.attachment.name)})`
    : input.imagePath
      ? '(image)'
      : ''

  return { content: text || fallback, meta }
}
