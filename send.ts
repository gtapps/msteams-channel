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
 *   bun send.ts --list
 *
 * Text may also arrive on stdin, which is what a caller with a long,
 * shell-hostile, or sensitive message should use — argv is world-readable in
 * /proc, so `--text` puts the message body where any local user can read it:
 *   echo "..." | bun send.ts --conversation <id>
 *
 * Exit codes: 0 sent · 1 bad usage · 2 not configured · 3 refused by the
 * outbound gate · 4 send failed.
 */

import { App } from '@microsoft/teams.apps'
import { homedir } from 'os'
import { join } from 'path'
import { ConversationStore } from './src/conversations.js'
import { chunkText } from './src/chunk.js'
import { loadEnvFile } from './src/env.js'
import { outboundAllowed } from './src/gate.js'
import { readAccess } from './src/access.js'

const STATE_DIR = process.env.MSTEAMS_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'msteams')

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
  die(1, 'usage: bun send.ts --conversation <id> --text <message> [--thread <thread_id>]\n       bun send.ts --list')
}

const text = flag('text') ?? (!process.stdin.isTTY ? await Bun.stdin.text() : '')
if (!text.trim()) die(1, 'nothing to send: pass --text or pipe the message on stdin')

const APP_ID = process.env.MSTEAMS_APP_ID
const APP_PASSWORD = process.env.MSTEAMS_APP_PASSWORD
const TENANT_ID = process.env.MSTEAMS_TENANT_ID
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

const app = new App({ clientId: APP_ID, clientSecret: APP_PASSWORD, tenantId: TENANT_ID })
const threadId = idFlag('thread')

// Declared outside the try so a failure can report what already landed. Which
// parts got through matters: the recipient has seen them, so re-running the
// same command would repeat text rather than resume it. The reply tool reports
// the same way.
const chunks = chunkText(text)
const ids: string[] = []

try {
  for (const chunk of chunks) {
    const activity = { type: 'message', text: chunk, textFormat: 'markdown' } as any
    const sent = threadId
      ? await app.reply(ref.conversationId, threadId, activity)
      : await app.send(ref.conversationId, activity)
    if (sent?.id) ids.push(String(sent.id))
  }
  process.stdout.write(`${ids.join(' ')}\n`)
  process.exit(0)
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err)
  die(4, `send failed after ${ids.length} of ${chunks.length} part(s) sent: ${detail}`)
}
