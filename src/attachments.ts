/**
 * Inbound attachments: classification, and fetching one to the inbox.
 *
 * Two things about Teams make this less obvious than it looks.
 *
 * **Every message carries a `text/html` attachment** holding the rendered
 * message body — a bare "hey" with no file arrives with one. So attachment
 * *presence* never means a file was sent, and classification has to be by
 * content type. Verified against the captured corpus; exclusion list matches
 * OpenClaw's `isAdvertisedFileAttachment` (MIT 32b2e161a5a,
 * `extensions/msteams/src/attachments/shared.ts:301`).
 *
 * **A file's `content.downloadUrl` is a credential, not an identifier.** It
 * embeds a `tempauth=` bearer token granting read access to the sender's
 * OneDrive, valid about an hour. It must never reach a log, an error message,
 * the notification meta, or disk. That is why the handle Claude receives is an
 * opaque id and the URL stays in memory, in this module, keyed by that id.
 *
 * Not `src/attach.ts`: that one builds OUTBOUND attachments to send. This one
 * only classifies and fetches what arrived.
 */

import { writeFileSync } from 'fs'
import { join, extname } from 'path'
import { createHash } from 'crypto'

/** A genuine file sent by a user, as opposed to the rendered message body. */
export const TEAMS_FILE_DOWNLOAD_INFO = 'application/vnd.microsoft.teams.file.download.info'

/** Teams accepts much larger, but an inbound file lands in the operator's home dir. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024

/** How long a download handle stays usable. The token in the URL dies around here anyway. */
export const HANDLE_TTL_MS = 60 * 60 * 1000

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'])

export type InboundAttachment = {
  /** Opaque handle given to the model. Never the URL. */
  id: string
  name?: string
  mime?: string
  kind: 'image' | 'file'
  fileType?: string
}

type Handle = InboundAttachment & { url: string; at: number }

/**
 * Body and card attachments are message rendering, not files. Excluding these
 * is the whole difference between "the user sent a file" and "the user spoke".
 */
export function isBodyOrCard(contentType: string | undefined): boolean {
  const t = (contentType ?? '').toLowerCase()
  return (
    t.startsWith('text/html') ||
    t.startsWith('application/vnd.microsoft.card.') ||
    t.startsWith('application/vnd.microsoft.teams.card.')
  )
}

function kindOf(fileType: string | undefined, name: string | undefined): 'image' | 'file' {
  const ext = (fileType || extname(name ?? '').replace('.', '')).toLowerCase()
  return IMAGE_EXT.has(ext) ? 'image' : 'file'
}

/**
 * In-memory only, deliberately. Persisting these would write live OneDrive
 * bearer tokens to the state dir, which is exactly the leak the fixtures
 * caught in the other direction.
 */
export class AttachmentHandles {
  private readonly handles = new Map<string, Handle>()

  /** Register the files on an activity and return what the model may see. */
  register(activity: Record<string, any>, now = Date.now()): InboundAttachment[] {
    this.prune(now)
    const out: InboundAttachment[] = []

    for (const raw of activity.attachments ?? []) {
      if (isBodyOrCard(raw?.contentType)) continue
      if (raw?.contentType !== TEAMS_FILE_DOWNLOAD_INFO) continue

      const url = String(raw?.content?.downloadUrl ?? '')
      if (!url) continue

      const fileType = raw?.content?.fileType ? String(raw.content.fileType) : undefined
      const name = raw?.name ? String(raw.name) : undefined
      // Derived from the activity + unique id so the same file in the same
      // message always gets the same handle, without exposing either.
      const id = createHash('sha256')
        .update(`${activity.id}:${raw?.content?.uniqueId ?? url}`)
        .digest('hex')
        .slice(0, 32)

      const attachment: InboundAttachment = { id, name, mime: raw?.contentType, kind: kindOf(fileType, name), fileType }
      this.handles.set(id, { ...attachment, url, at: now })
      out.push(attachment)
    }
    return out
  }

  /**
   * Fetch to `inboxDir` and return the local path.
   *
   * Errors deliberately never include the URL — a failed fetch is the most
   * likely place for a credential to end up in a log.
   */
  async download(id: string, inboxDir: string, now = Date.now()): Promise<string> {
    this.prune(now)
    const handle = this.handles.get(id)
    if (!handle) {
      throw new Error(
        'unknown attachment id — it may have expired, or belong to a message from before this session started',
      )
    }

    let res: Response
    try {
      res = await fetch(handle.url)
    } catch {
      throw new Error('attachment download failed: the file could not be reached')
    }
    if (!res.ok) throw new Error(`attachment download failed: HTTP ${res.status}`)

    const tooLarge = () =>
      new Error(`attachment is larger than the ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB limit`)

    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > MAX_DOWNLOAD_BYTES) throw tooLarge()

    // content-length is a claim, not a fact, and the sender chooses what the
    // download URL points at — so cap what we actually read rather than
    // buffering the whole body and checking afterwards. Otherwise the limit
    // only detects an overrun after already allocating it.
    const reader = res.body?.getReader()
    if (!reader) throw new Error('attachment download failed: empty response body')
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_DOWNLOAD_BYTES) throw tooLarge()
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    const bytes = Buffer.concat(chunks)

    const path = join(inboxDir, safeInboxName(id, handle))
    writeFileSync(path, bytes, { mode: 0o600 })
    return path
  }

  private prune(now: number): void {
    for (const [id, handle] of this.handles) {
      if (now - handle.at > HANDLE_TTL_MS) this.handles.delete(id)
    }
  }
}

/**
 * The sender controls `name`, so it never reaches the filesystem intact. The
 * handle id is ours and already filename-safe; the sender's extension is kept
 * only as far as it is alphanumeric, so a `.png` cannot smuggle a path.
 */
export function safeInboxName(id: string, attachment: { name?: string; fileType?: string }): string {
  const raw = attachment.fileType || extname(attachment.name ?? '').replace('.', '')
  const ext = raw.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)
  return ext ? `${id}.${ext}` : id
}
