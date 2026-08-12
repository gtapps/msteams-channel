/**
 * What a reply actually does with text and files.
 *
 * Both adapters — the `reply` MCP tool and the `send.ts` CLI — plan and deliver
 * through here. They differ only in where the result is rendered (an MCP text
 * block, or stdout plus an exit code). Keeping ordering, partial-failure
 * accounting and the consent bookkeeping in one place is deliberate: the CLI is
 * a frozen contract surface, and two copies of this logic would drift.
 *
 * The routing table, which is where Teams' three delivery mechanisms meet:
 *
 *                        | personal chat | channel / group chat
 *   image < 4MB          | inline        | inline
 *   image >= 4MB         | consent card  | SharePoint
 *   any other file       | consent card  | SharePoint
 *
 * The large-image cell outside personal chats is a deliberate divergence from
 * OpenClaw, whose router falls through to the inline branch there and emits a
 * data URI that Teams rejects for being too big.
 */

import { chunkText } from './chunk.js'
import {
  buildImageAttachment,
  imageMimeFor,
  loadSendableFile,
  MAX_ATTACHMENTS,
  MAX_INLINE_IMAGE_BYTES,
  type Attachment,
} from './attach.js'
import { buildFileConsentCard } from './file-consent.js'
import type { PendingUploadStore } from './pending-uploads.js'
import {
  describeSharePointFailure,
  publishFileToConversation,
  type SharingScope,
} from './sharepoint.js'

/** Teams' own ceiling for a file a bot sends. */
export const MAX_OUTBOUND_FILE_BYTES = 100 * 1024 * 1024

/**
 * Every file in a reply is held in memory at once, because all of them are
 * validated before any of them is sent. This bounds that.
 */
export const MAX_OUTBOUND_TOTAL_BYTES = 200 * 1024 * 1024

/**
 * Whether group-chat file sends are available.
 *
 * They depend on the beta `createLink` with per-user recipients, which
 * Microsoft marks unsupported for production; the live probe in SETUP.md's
 * file-sending section is what decides this. Set false to degrade group chats
 * with an explanation while DMs and channels keep working.
 */
export const GROUP_CHAT_FILES_ENABLED = true

/**
 * Content types for the files worth naming. Anything else uploads as
 * octet-stream, which Teams renders by extension anyway; this only sets the
 * Content-Type header on the PUT.
 */
const OUTBOUND_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export type OutboundFilePlan =
  | { kind: 'inline'; filename: string; attachment: Attachment }
  | { kind: 'consent'; filename: string; contentType: string; bytes: Buffer }
  | { kind: 'sharepoint'; filename: string; contentType: string; bytes: Buffer }

export type PlanOptions = {
  conversationType: string
  stateDir: string
  sharePointSiteId?: string
  /** Overrides {@link GROUP_CHAT_FILES_ENABLED}; the probe switch, and testable. */
  groupChatFiles?: boolean
}

/** Thrown when the SharePoint route is needed but not configured. */
export type UnconfiguredError = Error & { code: 'sharepoint_unconfigured' }

function unconfigured(message: string): UnconfiguredError {
  return Object.assign(new Error(message), { code: 'sharepoint_unconfigured' as const })
}

/**
 * Decide how each file travels, and fail before anything is sent.
 *
 * Every throw here happens with nothing delivered, which is the property the
 * callers depend on: a reply either sends what it promised or sends nothing.
 */
export function planOutboundFiles(paths: string[], opts: PlanOptions): OutboundFilePlan[] {
  if (paths.length > MAX_ATTACHMENTS) {
    throw new Error(
      `refused: ${paths.length} files exceeds the ${MAX_ATTACHMENTS}-attachment limit per reply — ` +
        `split into separate messages`,
    )
  }
  const type = opts.conversationType
  if (type !== 'personal' && type !== 'groupChat' && type !== 'channel') {
    throw new Error(`cannot attach files: unrecognized conversation type "${type}"`)
  }

  const plans: OutboundFilePlan[] = []
  let total = 0

  for (const path of paths) {
    const file = loadSendableFile(path, opts.stateDir, MAX_OUTBOUND_FILE_BYTES)
    if (file.size === 0) {
      throw new Error(`cannot attach ${file.filename}: the file is empty`)
    }
    total += file.size
    if (total > MAX_OUTBOUND_TOTAL_BYTES) {
      throw new Error(
        `refused: those attachments total more than the ` +
          `${MAX_OUTBOUND_TOTAL_BYTES / 1024 / 1024}MB limit per reply — send them across ` +
          `separate replies`,
      )
    }

    const imageType = imageMimeFor(file.filename)
    if (imageType && file.size < MAX_INLINE_IMAGE_BYTES) {
      plans.push({ kind: 'inline', filename: file.filename, attachment: buildImageAttachment(file) })
      continue
    }

    const contentType =
      imageType ?? OUTBOUND_MIME[extLower(file.filename)] ?? 'application/octet-stream'

    if (type === 'personal') {
      plans.push({ kind: 'consent', filename: file.filename, contentType, bytes: file.bytes })
      continue
    }

    if (type === 'groupChat' && !(opts.groupChatFiles ?? GROUP_CHAT_FILES_ENABLED)) {
      throw new Error(
        `cannot send ${file.filename} to a group chat: a group-chat file needs a sharing link ` +
          `scoped to its members, which Microsoft only offers on a preview API this channel does ` +
          `not rely on. Files work in DMs and channels — paste the contents here instead.`,
      )
    }
    if (!opts.sharePointSiteId) {
      throw unconfigured(
        `cannot send ${file.filename} to a ${type}: files there are shared from a SharePoint ` +
          `site, and MSTEAMS_SHAREPOINT_SITE_ID is not set in the state dir .env — see SETUP.md, ` +
          `"File sending to channels and group chats". Text, inline images and DM file sends are ` +
          `unaffected.`,
      )
    }
    plans.push({ kind: 'sharepoint', filename: file.filename, contentType, bytes: file.bytes })
  }

  return plans
}

function extLower(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}

export type DeliveryResult = {
  /** Ids of everything Teams accepted, in send order. */
  sentIds: string[]
  /** Files now sitting in the chat as consent cards, awaiting Accept. */
  offered: string[]
  /** Set when delivery stopped partway; `after` counts what already landed. */
  failed?: { after: number; of: number; detail: string }
}

export type DeliverParams = {
  text: string
  /** Teams renders markdown by default; 'plain' is for text that must appear literally. */
  textFormat?: 'markdown' | 'plain'
  plan: OutboundFilePlan[]
  conversationId: string
  post: (activity: Record<string, unknown>) => Promise<{ id?: string } | undefined>
  pending: PendingUploadStore
  sharepoint?: {
    siteId: string
    conversationType: string
    getToken: () => Promise<string>
    listMemberIds: (conversationId: string) => Promise<string[]>
    fetchFn?: typeof fetch
  }
  log?: (line: string) => void
}

/**
 * Send the text and the planned files, in an order chosen so that a failure
 * partway through leaves the least confusing chat behind: text, then inline
 * images, then SharePoint cards, then the consent cards that need an answer.
 *
 * Never throws. A failure — including one during the pre-send member lookup,
 * where nothing has been sent at all — comes back as `failed`, so both callers
 * report partial delivery the same way.
 */
export async function deliverOutbound(p: DeliverParams): Promise<DeliveryResult> {
  // chunkText('') would return one empty chunk, and Teams would show an empty
  // message above the files.
  const chunks = p.text.trim() ? chunkText(p.text) : []
  const parts = chunks.length + p.plan.length
  const sentIds: string[] = []
  const offered: string[] = []

  try {
    // Resolve the audience for per-user sharing links before uploading
    // anything: a membership lookup that fails after the upload would leave a
    // file in the site that nobody was ever told about, and doing it once means
    // every file in this reply is shared with the same people.
    let recipients: string[] | undefined
    if (p.plan.some(entry => entry.kind === 'sharepoint') && p.sharepoint?.conversationType === 'groupChat') {
      recipients = [...new Set((await p.sharepoint.listMemberIds(p.conversationId)).filter(Boolean))]
      if (!recipients.length) {
        throw new Error(
          'cannot share a file with this group chat: its member list came back empty, and a ' +
            'link scoped to nobody would be a link to everyone. Nothing was sent.',
        )
      }
    }

    for (const chunk of chunks) {
      const sent = await p.post({
        type: 'message',
        text: chunk,
        textFormat: p.textFormat ?? 'markdown',
      })
      if (sent?.id) sentIds.push(String(sent.id))
    }

    for (const entry of p.plan) {
      if (entry.kind !== 'inline') continue
      // Attachments follow the text as their own activities, matching the
      // telegram plugin — Teams renders an image with a caption inconsistently.
      const sent = await p.post({ type: 'message', attachments: [entry.attachment] })
      if (sent?.id) sentIds.push(String(sent.id))
    }

    for (const entry of p.plan) {
      if (entry.kind !== 'sharepoint') continue
      const transport = p.sharepoint
      if (!transport) throw new Error('cannot share files: no SharePoint transport configured')
      const scope: SharingScope = transport.conversationType === 'channel' ? 'organization' : 'users'
      try {
        const { sentId } = await publishFileToConversation({
          bytes: entry.bytes,
          filename: entry.filename,
          contentType: entry.contentType,
          siteId: transport.siteId,
          scope,
          recipientObjectIds: recipients,
          getToken: transport.getToken,
          post: p.post,
          fetchFn: transport.fetchFn,
          log: p.log,
        })
        if (sentId) sentIds.push(sentId)
      } catch (err) {
        throw new Error(describeSharePointFailure(err))
      }
    }

    for (const entry of p.plan) {
      if (entry.kind !== 'consent') continue
      const uploadId = p.pending.store({
        bytes: entry.bytes,
        filename: entry.filename,
        contentType: entry.contentType,
        conversationId: p.conversationId,
      })
      try {
        const sent = await p.post({
          type: 'message',
          attachments: [
            buildFileConsentCard({
              filename: entry.filename,
              sizeInBytes: entry.bytes.length,
              uploadId,
            }),
          ],
        })
        if (sent?.id) p.pending.setConsentCardActivityId(uploadId, String(sent.id))
        offered.push(entry.filename)
      } catch (err) {
        // A snapshot with no card in front of it is an hour of dead weight and
        // a confusing Accept later.
        p.pending.settle(uploadId)
        throw err
      }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    p.log?.(`outbound delivery failed: ${detail}`)
    // A posted consent card landed as much as a sent message did, so it counts
    // toward what the recipient has already seen.
    return { sentIds, offered, failed: { after: sentIds.length + offered.length, of: parts, detail } }
  }

  return { sentIds, offered }
}

/**
 * The one-line failure both adapters report.
 *
 * Files already offered are named. Their consent cards are live in the chat,
 * so a caller that reads only "send failed" and retries the whole reply offers
 * them a second time — two cards for one file, and two snapshots held for an
 * hour each.
 */
export function describeFailure(
  failed: NonNullable<DeliveryResult['failed']>,
  offered: string[],
): string {
  const base = `send failed after ${failed.after} of ${failed.of} part(s) sent: ${failed.detail}`
  return offered.length
    ? `${base} — already offered, do not send again: ${offered.join(', ')}`
    : base
}

/**
 * The one-line summary both adapters report. "Offered" is terminal on purpose:
 * the accept or decline happens in Teams and never comes back as an event, so
 * anything waiting for it would wait forever.
 */
export function describeDelivery(result: DeliveryResult): string {
  const ids = result.sentIds.join(', ') || 'unknown'
  const sent =
    result.sentIds.length === 1 ? `sent (id: ${ids})` : `sent ${result.sentIds.length} parts (ids: ${ids})`
  if (!result.offered.length) return sent
  const offered =
    `offered ${result.offered.join(', ')} — awaiting Accept in Teams. Offered is terminal: no ` +
    `event fires either way, so do not wait or retry.`
  return result.sentIds.length ? `${sent}; ${offered}` : offered
}
