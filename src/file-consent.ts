/**
 * FileConsentCard: how a bot sends a non-image file into a personal chat.
 *
 * Teams will not let a bot push arbitrary bytes at a person. It posts a consent
 * card instead; if the recipient clicks Accept, Teams allocates a OneDrive
 * upload session and delivers a `fileConsent/invoke` carrying the URL, which
 * the bot then PUTs to. Adapted from OpenClaw (MIT, 32b2e161a5a,
 * `extensions/msteams/src/file-consent.ts` and `file-consent-invoke.ts`), with
 * three deliberate differences:
 *
 *   1. **The invoke passes the inbound gate.** OpenClaw honors a consent invoke
 *      from anyone in the conversation; a revoked sender must not be able to
 *      drive an upload here.
 *   2. **The claim is atomic.** OpenClaw reads its pending record, awaits the
 *      upload, and deletes afterwards, so two deliveries of the same Accept can
 *      both upload. See `PendingUploadStore.claim`.
 *   3. **Errors never carry the URL.** `uploadInfo.uploadUrl` is a live
 *      pre-authorized upload credential, in the same class as an inbound
 *      `tempauth` download URL: never logged, never persisted, never put in a
 *      message. `fetch` puts the request URL in its own error text, which is
 *      why every failure here is re-thrown as a sanitized one.
 */

import { lookup } from 'dns/promises'
import { fileTypeOf } from './attach.js'
import { gate, type Access, type ConversationType } from './gate.js'
import type { PendingUploadStore } from './pending-uploads.js'

/**
 * Where Teams is allowed to send us. An upload URL arrives inside a message
 * from the network, so it is attacker-influenced input until proven otherwise:
 * without this list a forged invoke would turn the bot into a file-exfiltration
 * proxy pointed at any host the attacker likes.
 */
export const CONSENT_UPLOAD_HOST_ALLOWLIST = [
  'sharepoint.com',
  'sharepoint.us',
  'sharepoint.de',
  'sharepoint.cn',
  'sharepoint-df.com',
  'storage.live.com',
  'onedrive.com',
  '1drv.ms',
  'graph.microsoft.com',
  'graph.microsoft.us',
  'graph.microsoft.de',
  'graph.microsoft.cn',
] as const

const CONSENT_CARD_CONTENT_TYPE = 'application/vnd.microsoft.teams.card.file.consent'
const FILE_INFO_CARD_CONTENT_TYPE = 'application/vnd.microsoft.teams.card.file.info'

/** Teams-facing copy. Both are sent to a sender the gate has already accepted. */
const EXPIRED_MESSAGE = 'That file offer has expired — ask Claude to send the file again.'
const FAILED_MESSAGE = 'File upload failed — ask Claude to send the file again.'

/** How long a handled invoke is remembered, so a redelivery stays silent. */
const SETTLED_MEMORY_MS = 10 * 60 * 1000

export type ConsentCard = {
  contentType: typeof CONSENT_CARD_CONTENT_TYPE
  name: string
  content: {
    description: string
    sizeInBytes: number
    acceptContext: { uploadId: string }
    declineContext: { uploadId: string }
  }
}

export type FileInfoCard = {
  contentType: typeof FILE_INFO_CARD_CONTENT_TYPE
  contentUrl: string
  name: string
  content: { uniqueId: string; fileType: string }
}

/**
 * The card that asks for consent. `acceptContext` and `declineContext` come
 * back verbatim in the invoke — the upload id is the only thing correlating
 * that invoke to the bytes we snapshotted, and nothing else goes in there.
 */
export function buildFileConsentCard(p: {
  filename: string
  sizeInBytes: number
  uploadId: string
  description?: string
}): ConsentCard {
  return {
    contentType: CONSENT_CARD_CONTENT_TYPE,
    name: p.filename,
    content: {
      description: p.description || `File from Claude: ${p.filename}`,
      sizeInBytes: p.sizeInBytes,
      acceptContext: { uploadId: p.uploadId },
      declineContext: { uploadId: p.uploadId },
    },
  }
}

/** The card that replaces the consent card once the bytes are in place. */
export function buildFileInfoCard(p: {
  filename: string
  contentUrl: string
  uniqueId: string
  fileType: string
}): FileInfoCard {
  return {
    contentType: FILE_INFO_CARD_CONTENT_TYPE,
    contentUrl: p.contentUrl,
    name: p.filename,
    content: { uniqueId: p.uniqueId, fileType: p.fileType },
  }
}

export type ConsentUploadInfo = {
  name: string
  uploadUrl: string
  contentUrl: string
  uniqueId: string
  fileType: string
}

export type ConsentInvoke =
  | { action: 'decline'; uploadId?: string }
  | { action: 'accept'; uploadId?: string; uploadInfo: ConsentUploadInfo }

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Read a `fileConsent/invoke`, or return undefined.
 *
 * Strict on purpose: every field of the SDK's `FileUploadInfo` is optional, so
 * an accept whose upload info is incomplete has to be treated as malformed
 * rather than dereferenced. Malformed invokes are answered with silence.
 */
export function parseFileConsentInvoke(activity: Record<string, any>): ConsentInvoke | undefined {
  if (activity?.type !== 'invoke' || activity?.name !== 'fileConsent/invoke') return undefined

  const value = activity.value
  if (value?.type !== 'fileUpload') return undefined

  const uploadId = nonEmpty(value.context?.uploadId) ? String(value.context.uploadId) : undefined
  if (value.action !== 'accept') return { action: 'decline', uploadId }

  const info = value.uploadInfo
  if (!nonEmpty(info?.uploadUrl) || !nonEmpty(info?.contentUrl) || !nonEmpty(info?.uniqueId)) {
    return undefined
  }
  return {
    action: 'accept',
    uploadId,
    uploadInfo: {
      name: nonEmpty(info.name) ? info.name : '',
      uploadUrl: info.uploadUrl,
      contentUrl: info.contentUrl,
      uniqueId: info.uniqueId,
      fileType: nonEmpty(info.fileType) ? info.fileType : '',
    },
  }
}

/**
 * Is this address one we must never send a credential-bearing PUT to?
 *
 * Unparseable input answers true: the only safe default when we cannot tell
 * what an address is.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const addr = ip.trim().toLowerCase()
  if (!addr) return true

  // A v4-mapped v6 address is the classic bypass: it looks like v6 to a naive
  // check but routes to v4, so it has to be judged by the v4 rules.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr)
  if (mapped) return isPrivateOrReservedIp(mapped[1])

  return addr.includes(':') ? isReservedV6(addr) : isReservedV4(addr)
}

function isReservedV4(addr: string): boolean {
  const parts = addr.split('.')
  if (parts.length !== 4) return true
  const octets = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  if (octets.some(n => Number.isNaN(n) || n > 255)) return true
  // Only the first three decide which range an address falls in.
  const [a, b, c] = octets

  if (a === 0 || a === 10 || a === 127) return true // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
  if (a === 169 && b === 254) return true // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true // IETF protocol, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3
  if (a >= 224) return true // multicast and reserved, incl. broadcast
  return false
}

function isReservedV6(addr: string): boolean {
  const bare = addr.split('%')[0] // drop any zone index
  if (bare === '::' || bare === '::1') return true
  if (/^f[cd]/.test(bare)) return true // fc00::/7 unique local
  if (/^fe[89ab]/.test(bare)) return true // fe80::/10 link-local
  if (/^ff/.test(bare)) return true // ff00::/8 multicast
  if (bare.startsWith('2001:db8')) return true // documentation
  // Any other v4-mapped form (hex rather than dotted) cannot be cheaply
  // decoded here, and a Microsoft host has no reason to resolve to one.
  if (bare.startsWith('::ffff:')) return true
  return false
}

export type ResolveFn = (hostname: string) => Promise<{ address: string }[]>

/**
 * Reject an upload URL we should not send bytes to: wrong scheme, a host
 * outside Microsoft's upload estate, or one that resolves anywhere internal.
 *
 * No error here names the URL or its host. The host alone identifies the
 * tenant's SharePoint, and these messages reach logs and, indirectly, chat.
 */
export async function validateConsentUploadUrl(
  url: string,
  opts?: { allowlist?: readonly string[]; resolveFn?: ResolveFn },
): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('the upload URL Teams supplied is not a valid URL')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('the upload URL Teams supplied is not https')
  }

  const host = parsed.hostname.toLowerCase()
  const allowlist = opts?.allowlist ?? CONSENT_UPLOAD_HOST_ALLOWLIST
  // Exact match or a real subdomain — never a bare suffix, or
  // `sharepoint.com.attacker.example` would pass.
  if (!allowlist.some(entry => host === entry || host.endsWith(`.${entry}`))) {
    throw new Error('the upload URL Teams supplied is not a Microsoft upload host')
  }

  const resolveFn = opts?.resolveFn ?? (h => lookup(h, { all: true }))
  let addresses: { address: string }[]
  try {
    addresses = await resolveFn(host)
  } catch {
    throw new Error('the upload host Teams supplied did not resolve')
  }
  if (!addresses.length) throw new Error('the upload host Teams supplied did not resolve')
  // Every answer, not just the first: a mixed public/private response would
  // otherwise be a bypass.
  for (const entry of addresses) {
    if (isPrivateOrReservedIp(entry.address)) {
      throw new Error('the upload host Teams supplied resolves to an internal address')
    }
  }
}

/**
 * Base five minutes plus a second per 256KiB, matching OpenClaw. A 100MB
 * upload gets ~12 minutes, which is the ceiling this channel allows anyway.
 */
export function uploadTimeoutMs(bytes: number): number {
  return 300_000 + Math.ceil(bytes / (256 * 1024)) * 1000
}

/**
 * PUT the snapshot to the URL Teams handed back.
 *
 * `redirect: 'error'` matters as much as the allowlist: the default is to
 * follow, so an allowlisted host could otherwise bounce the request — bytes,
 * credential header and all — anywhere it liked.
 */
export async function uploadToConsentUrl(p: {
  url: string
  bytes: Buffer
  contentType: string
  fetchFn?: typeof fetch
  allowlist?: readonly string[]
  resolveFn?: ResolveFn
  timeoutMs?: number
}): Promise<void> {
  await validateConsentUploadUrl(p.url, { allowlist: p.allowlist, resolveFn: p.resolveFn })

  const headers: Record<string, string> = { 'Content-Type': p.contentType }
  if (p.bytes.length > 0) {
    headers['Content-Range'] = `bytes 0-${p.bytes.length - 1}/${p.bytes.length}`
  }

  let res: Response
  try {
    res = await (p.fetchFn ?? fetch)(p.url, {
      method: 'PUT',
      headers,
      body: new Uint8Array(p.bytes),
      redirect: 'error',
      signal: AbortSignal.timeout(p.timeoutMs ?? uploadTimeoutMs(p.bytes.length)),
    })
  } catch {
    // Deliberately swallowing the cause: fetch puts the request URL in its
    // message, and that URL is a credential.
    throw new Error('file upload failed: the upload request did not complete')
  }

  await res.body?.cancel().catch(() => undefined)
  if (!res.ok) throw new Error(`file upload failed: HTTP ${res.status}`)
}

export type ConsentInvokeDeps = {
  access: Access
  configuredTenantId: string
  store: PendingUploadStore
  upload: (p: { url: string; bytes: Buffer; contentType: string }) => Promise<void>
  /** Bound to the invoke's own conversation by the caller. */
  send: (activity: Record<string, unknown>) => Promise<unknown>
  update: (activityId: string, activity: Record<string, unknown>) => Promise<unknown>
  /**
   * Upload ids this process has handled or is handling right now, so a
   * redelivered or concurrent invoke stays silent.
   */
  settled: Map<string, number>
  log: (line: string) => void
  now?: () => number
}

/**
 * Handle one `fileConsent/invoke`.
 *
 * Never reaches Claude and never touches the ingress queue: the queue persists
 * raw activities verbatim, and this activity carries an upload credential.
 * The caller acks the invoke synchronously and runs this detached.
 */
export async function handleFileConsentInvoke(
  activity: Record<string, any>,
  deps: ConsentInvokeDeps,
): Promise<void> {
  const now = deps.now?.() ?? Date.now()
  for (const [id, at] of deps.settled) {
    if (now - at > SETTLED_MEMORY_MS) deps.settled.delete(id)
  }

  const parsed = parseFileConsentInvoke(activity)
  if (!parsed) {
    deps.log('consent invoke ignored: malformed')
    return
  }

  // The gate, before anything else touches the store. A sender whose access was
  // revoked between the offer and the Accept gets nothing, silently.
  const verdict = gate(
    {
      tenantId: activity.channelData?.tenant?.id ?? activity.conversation?.tenantId,
      conversationId: String(activity.conversation?.id ?? ''),
      conversationType: (activity.conversation?.conversationType ??
        'personal') as ConversationType,
      senderAadObjectId: activity.from?.aadObjectId,
      mentionsBot: false,
    },
    deps.access,
    deps.configuredTenantId,
  )
  if (!verdict.allowed) {
    deps.log(`consent invoke refused (${verdict.reason})`)
    return
  }

  const uploadId = parsed.uploadId
  if (!uploadId) {
    deps.log('consent invoke carries no upload id')
    return
  }
  const short = uploadId.slice(0, 8)

  // One claim decides everything: unknown id, expired offer, a redelivery that
  // lost the race, and an invoke replayed from another conversation all come
  // back undefined, and none of them consume the record.
  const claimed = deps.store.claim(uploadId, String(activity.conversation?.id ?? ''), now)
  if (!claimed) {
    deps.log(`consent invoke ${short}: nothing claimable`)
    // Only for an accept the recipient is still waiting on. A redelivery of an
    // invoke we already handled says nothing, or the chat gets a stray line
    // under a file that arrived perfectly well.
    if (parsed.action === 'accept' && !deps.settled.has(uploadId)) {
      await deps.send({ type: 'message', text: EXPIRED_MESSAGE, textFormat: 'plain' })
    }
    return
  }

  // Marked as soon as the claim succeeds, not when the upload finishes: a
  // second delivery arriving mid-upload would otherwise find nothing claimable
  // and announce that the offer expired, underneath the file that is about to
  // land.
  deps.settled.set(uploadId, now)

  if (parsed.action === 'decline') {
    deps.log(`consent invoke ${short}: declined`)
    deps.store.settle(uploadId)
    deps.settled.set(uploadId, now)
    // Teams does not resolve a declined card: it stays on screen with its
    // buttons live, so the recipient cannot tell the click registered and
    // reasonably clicks again. Replace it. OpenClaw leaves the card alone,
    // which is where that dead-end came from. On failure stay silent rather
    // than adding a second message under a card the sender already answered.
    if (claimed.meta.consentCardActivityId) {
      await deps
        .update(claimed.meta.consentCardActivityId, {
          type: 'message',
          text: `Declined: ${claimed.meta.filename}`,
          textFormat: 'plain',
        })
        .catch(() => {})
    }
    return
  }

  try {
    await deps.upload({
      url: parsed.uploadInfo.uploadUrl,
      bytes: claimed.bytes,
      contentType: claimed.meta.contentType,
    })

    const card = buildFileInfoCard({
      filename: parsed.uploadInfo.name || claimed.meta.filename,
      contentUrl: parsed.uploadInfo.contentUrl,
      uniqueId: parsed.uploadInfo.uniqueId,
      fileType: parsed.uploadInfo.fileType || fileTypeOf(claimed.meta.filename),
    })
    const message = { type: 'message', attachments: [card] }

    // Replacing the consent card is the tidy outcome; a fresh card is the
    // acceptable one. Failing to post anything is not.
    if (claimed.meta.consentCardActivityId) {
      try {
        await deps.update(claimed.meta.consentCardActivityId, message)
      } catch {
        await deps.send(message)
      }
    } else {
      await deps.send(message)
    }
    deps.log(`consent invoke ${short}: uploaded ${claimed.meta.filename}`)
  } catch (err) {
    // The message, not the error object: anything thrown around the upload may
    // have the URL in it.
    deps.log(`consent invoke ${short}: ${err instanceof Error ? err.message : 'upload failed'}`)
    await deps.send({ type: 'message', text: FAILED_MESSAGE, textFormat: 'plain' }).catch(() => {})
  } finally {
    deps.store.settle(uploadId)
    deps.settled.set(uploadId, now)
  }
}
