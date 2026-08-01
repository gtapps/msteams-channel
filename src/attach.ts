/**
 * Outbound file attachments.
 *
 * Teams has no single "send a file" call. Which route applies depends on the
 * conversation type, the content type and the size (OpenClaw MIT 32b2e161a5a,
 * `extensions/msteams/src/file-consent-helpers.ts:106`):
 *
 *   personal + (large || not an image)  -> FileConsentCard round trip
 *   channel/group + not an image        -> SharePoint upload via Graph
 *   anything else, i.e. a small image   -> inline `data:` URI, one call
 *
 * Only the last route is synchronous, and it is the one that matters for an
 * agent: charts, screenshots and diagrams are images. So that is what we
 * implement, and the other two return an explanation rather than failing
 * obscurely — the same "degradable" stance we take for `react`.
 *
 * Not `src/attachments.ts`: that one handles INBOUND attachments (classifying
 * and fetching what senders sent). This one only builds outbound payloads.
 */

import { readFileSync, realpathSync, statSync } from 'fs'
import { extname, basename, join, sep } from 'path'

/**
 * Teams switches to the consent flow at 4MB. We reject at the same boundary
 * rather than sending a data URI Teams would refuse.
 */
export const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024

/**
 * Each attachment reaches ~5.3MB in memory after base64 inflation, and every
 * one is built before any send. Without a count limit an arbitrarily long
 * `files` array holds that multiplied in memory at once — this bounds the
 * array the same way the byte cap bounds a single file.
 */
export const MAX_ATTACHMENTS = 10

/** Teams only accepts base64 data URIs for images, so this list is the gate. */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

export type Attachment = {
  name: string
  contentType: string
  contentUrl: string
}

/** Strip anything that could confuse Teams or a downstream client. */
export function sanitizeAttachmentName(name: string): string {
  return (
    basename(name)
      .replace(/[\x00-\x1f\x7f]/g, '')
      .replace(/[\\/]/g, '_')
      .slice(0, 200) || 'file'
  )
}

/**
 * Refuse to send the channel's own state. Adapted from the telegram plugin:
 * `.env` holds the Entra credentials and `conversations/` holds proactive-send
 * targets, so those are the one set of paths Claude has no legitimate reason to
 * hand to a chat. `inbox/` is exempt — that is where inbound downloads land, so
 * sending one back is normal.
 */
export function assertSendable(path: string, stateDir: string): void {
  let real: string
  let stateReal: string
  try {
    real = realpathSync(path)
    stateReal = realpathSync(stateDir)
  } catch {
    // Missing file, or no state dir yet: the read below reports it properly.
    return
  }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${path}`)
  }
}

/**
 * Build an inline attachment, or throw an error worded for the sender.
 *
 * Throwing rather than returning undefined is deliberate: a silently skipped
 * attachment reads to Claude as a successful send, and the sender is left
 * waiting for a file that never arrives.
 */
export function buildImageAttachment(path: string, stateDir: string): Attachment {
  assertSendable(path, stateDir)

  const contentType = IMAGE_MIME[extname(path).toLowerCase()]
  if (!contentType) {
    throw new Error(
      `cannot attach ${basename(path)}: Teams only accepts images inline. Non-image files need ` +
        `the recipient's consent, which this channel does not implement yet — paste the contents ` +
        `into the message instead.`,
    )
  }

  const size = statSync(path).size
  if (size >= MAX_INLINE_IMAGE_BYTES) {
    throw new Error(
      `cannot attach ${basename(path)}: ${(size / 1024 / 1024).toFixed(1)}MB exceeds the 4MB ` +
        `inline limit. Larger files need the recipient's consent, which this channel does not ` +
        `implement yet — send a smaller or downscaled copy.`,
    )
  }

  return {
    name: sanitizeAttachmentName(path),
    contentType,
    contentUrl: `data:${contentType};base64,${readFileSync(path).toString('base64')}`,
  }
}
