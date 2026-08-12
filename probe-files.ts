#!/usr/bin/env bun
/**
 * Release gate for outbound file sending. Throwaway: not part of the plugin.
 *
 * Everything here exercises the exact calls src/sharepoint.ts makes, in the
 * same order and with the same query parameters, so a PASS means the shipped
 * code path works rather than something adjacent to it.
 *
 * Credentials come from the state dir .env, same as the server.
 *
 * Usage:
 *   bun probe-files.ts --resolve-site contoso.sharepoint.com:/sites/BotFiles
 *   bun probe-files.ts --site "contoso.sharepoint.com,<guid>,<guid>" \
 *       [--recipient <aad-object-id>] [--conversation <conversation-id>]
 */

import { join } from 'path'
import { loadEnvFile } from './src/env.js'
import { stateDir } from './src/state.js'

const STATE_DIR = stateDir()
loadEnvFile(join(STATE_DIR, '.env'))

const APP_ID = process.env.MSTEAMS_APP_ID
const APP_PASSWORD = process.env.MSTEAMS_APP_PASSWORD
const TENANT_ID = process.env.MSTEAMS_TENANT_ID
if (!APP_ID || !APP_PASSWORD || !TENANT_ID) {
  console.error(`not configured: no credentials in ${join(STATE_DIR, '.env')}`)
  process.exit(2)
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

const GRAPH_V1 = 'https://graph.microsoft.com/v1.0'
const GRAPH_BETA = 'https://graph.microsoft.com/beta'

let passed = 0
let failed = 0
function report(name: string, ok: boolean, detail = ''): boolean {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  ok ? passed++ : failed++
  return ok
}

async function token(): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: APP_ID!,
      client_secret: APP_PASSWORD!,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  })
  const data = (await res.json()) as { access_token?: string; error_description?: string }
  if (!data.access_token) throw new Error(data.error_description ?? 'no token')
  return data.access_token
}

const bearer = await token()
const auth = { Authorization: `Bearer ${bearer}` }

// --- site id lookup ---------------------------------------------------------
const resolve = arg('resolve-site')
if (resolve) {
  const res = await fetch(`${GRAPH_V1}/sites/${resolve}?$select=id,webUrl`, { headers: auth })
  const body = await res.text()
  console.log(res.ok ? `site id: ${body}` : `lookup failed (HTTP ${res.status}): ${body}`)
  process.exit(res.ok ? 0 : 1)
}

// --- list what the channel has actually uploaded --------------------------
if (process.argv.includes('--ls')) {
  const site = arg('site')
  if (!site) {
    console.error('usage: bun probe-files.ts --ls --site "<site-id>"')
    process.exit(1)
  }
  const res = await fetch(
    `${GRAPH_V1}/sites/${encodeURIComponent(site)}/drive/root:/AgentShared:/children` +
      `?$select=name,size,createdDateTime`,
    { headers: auth },
  )
  const data = (await res.json()) as { value?: { name: string; size: number; createdDateTime: string }[]; error?: unknown }
  if (!res.ok) {
    console.log(`AgentShared: HTTP ${res.status}`, JSON.stringify(data).slice(0, 200))
    process.exit(1)
  }
  const items = data.value ?? []
  console.log(`AgentShared holds ${items.length} file(s):`)
  for (const f of items) console.log(`  ${f.name}  ${f.size} bytes  ${f.createdDateTime}`)
  process.exit(0)
}

const siteId = arg('site')
if (!siteId) {
  console.error('usage: bun probe-files.ts --site "<site-id>" [--recipient <aad-object-id>] [--conversation <id>]')
  console.error('       bun probe-files.ts --resolve-site contoso.sharepoint.com:/sites/BotFiles')
  process.exit(1)
}

const name = `claude-probe-${Date.now()}.txt`
const uploadUrl =
  `${GRAPH_V1}/sites/${encodeURIComponent(siteId)}/drive/root:` +
  `/AgentShared/${encodeURIComponent(name)}:/content?@microsoft.graph.conflictBehavior=fail`

console.log(`\nProbing site ${siteId}\n`)

// 1. Upload, the exact call uploadToSharePoint makes.
const up = await fetch(uploadUrl, {
  method: 'PUT',
  headers: { ...auth, 'Content-Type': 'text/plain' },
  body: new Uint8Array(Buffer.from('probe')),
  redirect: 'error',
})
const uploaded = up.ok ? ((await up.json()) as { id: string; name: string }) : undefined
if (!report('upload to /AgentShared (Sites.Selected write)', up.ok, `HTTP ${up.status}`)) {
  console.log('\n  -> the app has no write grant on this site, or the site id is wrong.')
  console.log('     See SETUP.md, "File sending to channels and group chats".')
  process.exit(1)
}
const itemId = uploaded!.id

// 2. The same name again must be refused, not silently replace the first.
const clash = await fetch(uploadUrl, {
  method: 'PUT',
  headers: { ...auth, 'Content-Type': 'text/plain' },
  body: new Uint8Array(Buffer.from('second')),
  redirect: 'error',
})
report(
  'conflictBehavior=fail is honored (409 on a repeat name)',
  clash.status === 409,
  `HTTP ${clash.status}${clash.status === 201 ? ' — it REPLACED; file cards would not be immutable' : ''}`,
)

// 3. Properties the file card is built from.
const props = await fetch(
  `${GRAPH_V1}/sites/${encodeURIComponent(siteId)}/drive/items/${itemId}?$select=eTag,webDavUrl,name`,
  { headers: auth },
)
const propsBody = props.ok ? ((await props.json()) as Record<string, string>) : undefined
report(
  'driveItem lookup returns eTag and webDavUrl',
  Boolean(propsBody?.eTag && propsBody?.webDavUrl),
  `HTTP ${props.status}`,
)

// 4. Channel sharing: organization scope, v1.0.
const orgLink = await fetch(
  `${GRAPH_V1}/sites/${encodeURIComponent(siteId)}/drive/items/${itemId}/createLink`,
  {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'view', scope: 'organization' }),
    redirect: 'error',
  },
)
report('organization sharing link (channels)', orgLink.ok, `HTTP ${orgLink.status}`)

// 5. Group-chat sharing: per-user scope, beta. This is the gated one.
const recipient = arg('recipient')
if (recipient) {
  const userLink = await fetch(
    `${GRAPH_BETA}/sites/${encodeURIComponent(siteId)}/drive/items/${itemId}/createLink`,
    {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'view', scope: 'users', recipients: [{ objectId: recipient }] }),
      redirect: 'error',
    },
  )
  const ok = report('per-user sharing link, beta (group chats)', userLink.ok, `HTTP ${userLink.status}`)
  if (!ok) {
    console.log('  -> set GROUP_CHAT_FILES_ENABLED = false in src/outbound.ts.')
    console.log('     DMs and channels are unaffected.')
  }
} else {
  console.log('  SKIP  per-user sharing link — pass --recipient <aad-object-id> to probe it')
}

// 6. Cleanup, which is also the compensating delete the code relies on.
const del = await fetch(`${GRAPH_V1}/sites/${encodeURIComponent(siteId)}/drive/items/${itemId}`, {
  method: 'DELETE',
  headers: auth,
  redirect: 'error',
})
report('delete (the cleanup a failed publish depends on)', del.ok, `HTTP ${del.status}`)

// 7. Bot Framework membership, exactly as the shipped code resolves it.
const conversation = arg('conversation')
if (conversation) {
  const { App } = await import('@microsoft/teams.apps')
  const app = new App({ clientId: APP_ID, clientSecret: APP_PASSWORD, tenantId: TENANT_ID })
  try {
    const members = await app.api.conversations.getMembers(conversation)
    const ids = members.map(m => m.aadObjectId).filter(Boolean)
    report(
      'Bot Framework getMembers returns AAD object ids',
      ids.length > 0,
      `${ids.length}/${members.length} members carry an aadObjectId`,
    )
  } catch (err) {
    report('Bot Framework getMembers', false, String(err))
    console.log('  -> fall back to binding the stored ConversationRef.serviceUrl, or Graph')
    console.log('     /chats/{id}/members with ChatMember.Read.All.')
  }
} else {
  console.log('  SKIP  group-chat members — pass --conversation <id> (bun send.ts --list) to probe it')
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)
