#!/usr/bin/env bun
/**
 * Proactive send, for consumers with no live turn.
 *
 * An agent sending a notice is not replying to anything, so there is no turn
 * context and no MCP session — just a stored conversation reference and the
 * app's own client credentials. Same outbound gate as the `reply` tool: a
 * conversation must both have been accepted inbound at some point (which is
 * the only way a reference gets written) and still be allowed by the current
 * access.json.
 *
 * **This interface is a contract surface.** The consuming agent shells out
 * to this CLI and must never parse the state dir itself, so the flags and the
 * exit codes are the API, and the on-disk format stays free to change.
 *
 * Usage:
 *   bun send.ts --conversation <id> --text <message> [--thread <thread_id>]
 *   bun send.ts --conversation <id> --files <path> [--files <path> ...]
 *   bun send.ts --list
 *
 * Text may also arrive on stdin, which is what a caller with a long,
 * shell-hostile, or sensitive message should use — argv is world-readable in
 * /proc, so `--text` puts the message body where any local user can read it:
 *   echo "..." | bun send.ts --conversation <id>
 *
 * A file sent to a DM is *offered*: the recipient sees a consent card and the
 * bytes only move once they Accept, which the long-running channel server
 * handles. This command exits as soon as the card is posted, so the server has
 * to be running for the transfer to complete.
 *
 * Exit codes: 0 sent · 1 bad usage · 2 not configured · 3 refused by the
 * outbound gate · 4 send failed.
 */

import { App } from '@microsoft/teams.apps'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { ConversationStore } from './src/conversations.js'
import { loadEnvFile } from './src/env.js'
import { outboundAllowed } from './src/gate.js'
import { readAccess } from './src/access.js'
import { stateDir } from './src/state.js'
import { PendingUploadStore } from './src/pending-uploads.js'
import { planOutboundFiles, deliverOutbound } from './src/outbound.js'
import { graphTokenGetter } from './src/sharepoint.js'

const STATE_DIR = stateDir()

function die(code: number, message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

/**
 * An id flag whose value cannot be the next flag.
 *
 * `--conversation --text hi` otherwise takes `"--text"` as the conversation id
 * and fails as "no inbound conversation on record" — a usage error reported as
 * a gate refusal, which sends the caller looking in the wrong place. Applied
 * only to ids: a *message* legitimately starts with `--`.
 */
function idFlag(name: string): string | undefined {
  const value = flag(name)
  if (value?.startsWith('--')) die(1, `--${name} needs a value`)
  return value
}

/** A flag that may appear more than once, each time with a path. */
function pathFlags(name: string): string[] {
  const out: string[] = []
  process.argv.forEach((arg, i) => {
    if (arg !== `--${name}`) return
    const value = process.argv[i + 1]
    if (!value || value.startsWith('--')) die(1, `--${name} needs a value`)
    out.push(value)
  })
  return out
}

// Credentials come from the state dir only — argv is world-readable in /proc.
loadEnvFile(join(STATE_DIR, '.env'))

const conversations = new ConversationStore(join(STATE_DIR, 'conversations'))

if (process.argv.includes('--list')) {
  // Operators need a way to discover ids without reading the store's format.
  const all = conversations.list()
  if (!all.length) {
    process.stdout.write('no conversations on record — message the bot from Teams first\n')
    process.exit(0)
  }
  // Marked against current access, not merely "a reference exists". Listing a
  // revoked conversation as reachable would be worse than omitting it: the
  // operator would read a positive signal and then get exit 3.
  const listAccess = readAccess(STATE_DIR)
  for (const ref of all) {
    const verdict = outboundAllowed(ref, listAccess)
    const status = verdict.allowed ? 'reachable' : `unreachable:${verdict.reason}`
    process.stdout.write(
      `${ref.conversationId}\t${ref.conversationType}\t${status}\t${ref.updatedAt}\n`,
    )
  }
  process.exit(0)
}

const conversationId = idFlag('conversation')
if (!conversationId) {
  die(1, 'usage: bun send.ts --conversation <id> [--text <message>] [--files <path>] [--thread <thread_id>]\n       bun send.ts --list')
}

const files = pathFlags('files')
const text = flag('text') ?? (!process.stdin.isTTY ? await Bun.stdin.text() : '')
if (!text.trim() && files.length === 0) {
  die(1, 'nothing to send: pass --text, pipe the message on stdin, or pass --files')
}

const APP_ID = process.env.MSTEAMS_APP_ID
const APP_PASSWORD = process.env.MSTEAMS_APP_PASSWORD
const TENANT_ID = process.env.MSTEAMS_TENANT_ID
const SHAREPOINT_SITE_ID = process.env.MSTEAMS_SHAREPOINT_SITE_ID
if (!APP_ID || !APP_PASSWORD || !TENANT_ID) {
  die(2, `msteams is not configured — set credentials in ${join(STATE_DIR, '.env')} (run /msteams:configure)`)
}

// OUTBOUND GATE, the same two checks the reply tool runs. A stored reference
// proves the inbound gate once accepted this conversation; re-reading access
// proves the operator has not revoked it since. Without the second check,
// `/msteams:access remove` would leave this CLI able to post forever.
const ref = conversations.get(conversationId)
if (!ref) {
  die(3, `refused: no inbound conversation on record for that id — run --list to see what is reachable`)
}

const outbound = outboundAllowed(ref, readAccess(STATE_DIR))
if (!outbound.allowed) {
  die(3, `refused: that conversation is no longer allowed (${outbound.reason}) — manage access with /msteams:access`)
}

// How each file travels depends on where it is going, so this needs the
// reference. Nothing has been sent yet, so any refusal here is total.
const plan = (() => {
  try {
    return planOutboundFiles(files, {
      conversationType: ref.conversationType,
      stateDir: STATE_DIR,
      sharePointSiteId: SHAREPOINT_SITE_ID,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // A missing SharePoint site is a configuration gap, not a bad command.
    die((err as { code?: string })?.code === 'sharepoint_unconfigured' ? 2 : 1, message)
  }
})()

const app = new App({ clientId: APP_ID, clientSecret: APP_PASSWORD, tenantId: TENANT_ID })
const threadId = idFlag('thread')

// Shared with the running server, which is what receives the Accept and
// performs the upload after this process has exited.
const pendingDir = join(STATE_DIR, 'pending-uploads')
mkdirSync(pendingDir, { recursive: true, mode: 0o700 })

const result = await deliverOutbound({
  text,
  plan,
  conversationId: ref.conversationId,
  post: activity =>
    threadId
      ? app.reply(ref.conversationId, threadId, activity as any)
      : app.send(ref.conversationId, activity as any),
  pending: new PendingUploadStore(pendingDir),
  sharepoint: SHAREPOINT_SITE_ID
    ? {
        siteId: SHAREPOINT_SITE_ID,
        conversationType: ref.conversationType,
        getToken: graphTokenGetter(app.graph),
        listMemberIds: async id =>
          (await app.api.conversations.getMembers(id))
            .map(member => member.aadObjectId ?? '')
            .filter(Boolean),
      }
    : undefined,
  log: line => process.stderr.write(`${line}\n`),
})

if (result.failed) {
  // Which parts landed matters: the recipient has seen them, so re-running the
  // same command would repeat text rather than resume it.
  die(
    4,
    `send failed after ${result.failed.after} of ${result.failed.of} part(s) sent: ${result.failed.detail}`,
  )
}

if (result.sentIds.length) process.stdout.write(`${result.sentIds.join(' ')}\n`)
if (result.offered.length) {
  process.stdout.write(
    `offered ${result.offered.join(', ')} — awaiting Accept in Teams (the channel server must be running to complete the transfer)\n`,
  )
}
process.exit(0)
