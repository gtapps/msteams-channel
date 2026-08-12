/**
 * Sending a file into a channel or group chat, via SharePoint.
 *
 * A bot has no `/me/drive` — that resource needs a signed-in user, and this
 * channel authenticates as the application — so outside personal chats there is
 * nowhere to put bytes except a site the operator designates. The shape is
 * OpenClaw's (MIT, 32b2e161a5a, `extensions/msteams/src/graph-upload.ts`):
 * upload to the site's default drive, create a sharing link so the recipients
 * can actually open it, then post a native Teams file card pointing at it.
 *
 * Three deliberate differences from the reference:
 *
 *   1. **Uploads never overwrite.** OpenClaw PUTs the plain filename, and
 *      Graph's default conflict behavior is `replace` — so resending
 *      `report.pdf` silently rewrites what last week's file card still points
 *      at. Every upload here gets 64 bits of randomness in its name and asks
 *      Graph to fail rather than replace.
 *   2. **A half-published file is cleaned up.** If the sharing link, the
 *      property read, or the card post fails, the drive item is deleted: an
 *      item nobody can see and nobody was told about is litter in the
 *      operator's site.
 *   3. **Raw `fetch`, not `app.graph.http`.** The SDK's HTTP client copies its
 *      default `Content-Type: application/json` over any per-request header, so
 *      a binary PUT through it uploads bytes labelled as JSON. Do not
 *      "simplify" this back.
 *
 * Requests are `redirect: 'error'` throughout: these carry a bearer token, and
 * following a redirect would hand it to whatever answered.
 */

import { randomBytes } from 'crypto'
import { extname } from 'path'
import { fileTypeOf } from './attach.js'
// The consent flow owns Teams' file-card vocabulary and the upload timeout
// formula; both routes post the same card and move files the same size.
import { uploadTimeoutMs, type FileInfoCard } from './file-consent.js'

const GRAPH_V1 = 'https://graph.microsoft.com/v1.0'
// Per-user sharing links exist only in beta. Microsoft marks beta unsupported
// for production, which is why group-chat file sends are gated separately.
const GRAPH_BETA = 'https://graph.microsoft.com/beta'

/** Everything this channel uploads lands here, in the site's default drive. */
export const SHAREPOINT_FOLDER = 'AgentShared'

/** What `App.graph` provides: a client whose token factory yields app-only auth. */
export type GraphTokenSource = { http: { token?: unknown } }

export type SharingScope = 'organization' | 'users'

/**
 * Turn the SDK's token field into a plain bearer string.
 *
 * `http.token` is typed as string | StringLike | TokenFactory, and the App
 * builds it as a factory, so all three shapes are handled. The token itself is
 * never logged or put in an error.
 */
export function graphTokenGetter(graph: GraphTokenSource): () => Promise<string> {
  return async () => {
    const token = graph.http?.token
    const resolved = typeof token === 'function' ? await (token as (c: unknown) => unknown)({}) : token
    const value = resolved == null ? '' : String(resolved)
    if (!value) {
      throw new Error(
        'no Microsoft Graph token available — the channel is running without credentials',
      )
    }
    return value
  }
}

/**
 * `report.pdf` -> `report-3f9a1c2b4d5e6f70.pdf`.
 *
 * The suffix is what makes a posted file card permanent: the bytes behind it
 * can never be replaced by a later send of the same name.
 */
export function uniqueUploadName(sanitized: string): string {
  const suffix = randomBytes(8).toString('hex')
  const ext = extname(sanitized)
  const stem = ext ? sanitized.slice(0, -ext.length) : sanitized
  return `${stem || 'file'}-${suffix}${ext}`
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

function httpFailure(status: number, what: string): Error & { status: number } {
  const err = new Error(`${what} failed: HTTP ${status}`) as Error & { status: number }
  err.status = status
  return err
}

export type UploadedItem = { itemId: string; webUrl: string; name: string }

/**
 * PUT a file into the site's default drive under {@link SHAREPOINT_FOLDER}.
 *
 * Retries once on 409: the name carries 64 random bits, so a conflict means
 * either an astronomically unlucky collision or a name that already existed,
 * and a second suffix settles both.
 */
export async function uploadToSharePoint(p: {
  bytes: Buffer
  /** Sanitized base name; the random suffix is added here. */
  filename: string
  contentType: string
  siteId: string
  getToken: () => Promise<string>
  fetchFn?: typeof fetch
  timeoutMs?: number
}): Promise<UploadedItem> {
  const fetchFn = p.fetchFn ?? fetch

  for (let attempt = 0; attempt < 2; attempt++) {
    const name = uniqueUploadName(p.filename)
    const url =
      `${GRAPH_V1}/sites/${encodeURIComponent(p.siteId)}/drive/root:` +
      `/${SHAREPOINT_FOLDER}/${encodeURIComponent(name)}:/content` +
      // Graph replaces by default; an overwritten file would silently change
      // what an already-posted file card serves.
      `?@microsoft.graph.conflictBehavior=fail`

    const res = await fetchFn(url, {
      method: 'PUT',
      headers: { ...authHeaders(await p.getToken()), 'Content-Type': p.contentType },
      body: new Uint8Array(p.bytes),
      redirect: 'error',
      signal: AbortSignal.timeout(p.timeoutMs ?? uploadTimeoutMs(p.bytes.length)),
    })

    if (res.status === 409 && attempt === 0) continue
    if (!res.ok) throw httpFailure(res.status, 'SharePoint upload')

    const data = (await res.json()) as { id?: string; webUrl?: string; name?: string }
    if (!data.id || !data.webUrl || !data.name) {
      throw new Error('SharePoint upload returned no drive item')
    }
    return { itemId: data.id, webUrl: data.webUrl, name: data.name }
  }
  throw new Error('SharePoint upload failed: the file name kept colliding')
}

export type DriveItemProperties = { eTag: string; webDavUrl: string; name: string }

/** A native file card needs the eTag and the WebDAV URL, which the PUT does not return. */
export async function getDriveItemProperties(p: {
  siteId: string
  itemId: string
  getToken: () => Promise<string>
  fetchFn?: typeof fetch
}): Promise<DriveItemProperties> {
  const url =
    `${GRAPH_V1}/sites/${encodeURIComponent(p.siteId)}/drive/items/` +
    `${encodeURIComponent(p.itemId)}?$select=eTag,webDavUrl,name`

  const res = await (p.fetchFn ?? fetch)(url, {
    headers: authHeaders(await p.getToken()),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw httpFailure(res.status, 'SharePoint item lookup')

  const data = (await res.json()) as Partial<DriveItemProperties>
  if (!data.eTag || !data.webDavUrl || !data.name) {
    throw new Error('SharePoint item lookup returned no eTag or WebDAV URL')
  }
  return { eTag: data.eTag, webDavUrl: data.webDavUrl, name: data.name }
}

/**
 * Grant access to the uploaded file.
 *
 * A channel's members are whoever is in the team, so an organization-scope
 * link matches what the channel already implies. A group chat is a closed set
 * of people, so its link is scoped to exactly those people — which is only
 * available in beta.
 */
export async function createSharingLink(p: {
  siteId: string
  itemId: string
  scope: SharingScope
  recipientObjectIds?: string[]
  getToken: () => Promise<string>
  fetchFn?: typeof fetch
}): Promise<{ webUrl: string }> {
  const root = p.scope === 'users' ? GRAPH_BETA : GRAPH_V1
  const body: Record<string, unknown> = { type: 'view', scope: p.scope }
  if (p.scope === 'users') {
    if (!p.recipientObjectIds?.length) {
      throw new Error('per-user sharing needs at least one recipient')
    }
    body.recipients = p.recipientObjectIds.map(id => ({ objectId: id }))
  }

  const res = await (p.fetchFn ?? fetch)(
    `${root}/sites/${encodeURIComponent(p.siteId)}/drive/items/${encodeURIComponent(p.itemId)}/createLink`,
    {
      method: 'POST',
      headers: { ...authHeaders(await p.getToken()), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    },
  )
  if (!res.ok) throw httpFailure(res.status, 'SharePoint sharing link')

  const data = (await res.json()) as { link?: { webUrl?: string } }
  if (!data.link?.webUrl) throw new Error('SharePoint sharing link returned no URL')
  return { webUrl: data.link.webUrl }
}

/**
 * Best-effort cleanup of a file that never got published. Failures are
 * reported to the caller's log and otherwise ignored: the original error is
 * what the sender needs to hear about.
 */
export async function deleteDriveItem(p: {
  siteId: string
  itemId: string
  getToken: () => Promise<string>
  fetchFn?: typeof fetch
}): Promise<void> {
  await (p.fetchFn ?? fetch)(
    `${GRAPH_V1}/sites/${encodeURIComponent(p.siteId)}/drive/items/${encodeURIComponent(p.itemId)}`,
    {
      method: 'DELETE',
      headers: authHeaders(await p.getToken()),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    },
  )
}

/**
 * Graph's eTag is quoted and braced (`"{GUID},1"`); a file card wants the bare
 * identity.
 */
export function cleanETag(eTag: string): string {
  const bare = eTag.replace(/["']/g, '').replace(/[{}]/g, '')
  return bare.split(',')[0] || eTag
}

/** The native Teams file card: renders inline, opens in SharePoint. */
export function buildSharePointFileCard(item: DriveItemProperties): FileInfoCard {
  return {
    contentType: 'application/vnd.microsoft.teams.card.file.info',
    contentUrl: item.webDavUrl,
    name: item.name,
    content: { uniqueId: cleanETag(item.eTag), fileType: fileTypeOf(item.name) },
  }
}

/**
 * Upload, grant access, and post the card — as one transaction.
 *
 * The post lives inside this function precisely so the failure path can undo
 * the upload: from the caller's side either the file is in the chat, or
 * nothing happened at all.
 */
export async function publishFileToConversation(p: {
  bytes: Buffer
  filename: string
  contentType: string
  siteId: string
  scope: SharingScope
  recipientObjectIds?: string[]
  getToken: () => Promise<string>
  post: (activity: Record<string, unknown>) => Promise<{ id?: string } | undefined>
  fetchFn?: typeof fetch
  log?: (line: string) => void
}): Promise<{ sentId?: string }> {
  const uploaded = await uploadToSharePoint({
    bytes: p.bytes,
    filename: p.filename,
    contentType: p.contentType,
    siteId: p.siteId,
    getToken: p.getToken,
    fetchFn: p.fetchFn,
  })

  try {
    const props = await getDriveItemProperties({
      siteId: p.siteId,
      itemId: uploaded.itemId,
      getToken: p.getToken,
      fetchFn: p.fetchFn,
    })
    // Before the card: a card the recipients cannot open is worse than an error.
    await createSharingLink({
      siteId: p.siteId,
      itemId: uploaded.itemId,
      scope: p.scope,
      recipientObjectIds: p.recipientObjectIds,
      getToken: p.getToken,
      fetchFn: p.fetchFn,
    })
    const sent = await p.post({
      type: 'message',
      attachments: [buildSharePointFileCard(props)],
    })
    return { sentId: sent?.id ? String(sent.id) : undefined }
  } catch (err) {
    await deleteDriveItem({
      siteId: p.siteId,
      itemId: uploaded.itemId,
      getToken: p.getToken,
      fetchFn: p.fetchFn,
    }).catch(cleanupErr => {
      p.log?.(`sharepoint cleanup failed for ${uploaded.name}: ${cleanupErr}`)
    })
    throw err
  }
}

/**
 * Turn a Graph failure into something the operator can act on.
 *
 * Deliberately not `describeGraphFailure` from graph.ts: that one's copy is
 * about reactions being impossible, which would be actively misleading here.
 */
export function describeSharePointFailure(err: unknown): string {
  const status = (err as { status?: number })?.status
  const message = err instanceof Error ? err.message : String(err)

  if (status === 401 || status === 403) {
    return (
      `SharePoint refused the request (HTTP ${status}). The app needs write access to the ` +
      'configured site: grant it Sites.Selected on that site and check MSTEAMS_SHAREPOINT_SITE_ID ' +
      'names the same one. See SETUP.md, "File sending to channels and group chats".'
    )
  }
  if (status === 404) {
    return (
      'SharePoint could not find the configured site or file (HTTP 404). Check ' +
      'MSTEAMS_SHAREPOINT_SITE_ID in the state dir .env — see SETUP.md, "File sending to ' +
      'channels and group chats".'
    )
  }
  return message
}
