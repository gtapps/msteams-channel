#!/usr/bin/env bun
/**
 * Proactive send, for consumers with no live turn (Experiment 4).
 *
 * A hermit sending a notice is not replying to anything, so there is no turn
 * context and no MCP session — just a stored conversation reference and the
 * app's own client credentials. Same outbound gate as the `reply` tool: the
 * only reachable conversations are ones the inbound gate already accepted,
 * because that is the only way a reference gets written.
 *
 * **This interface is a contract surface.** The hermit integration shells out
 * to this CLI and must never parse the state dir itself, so the flags and the
 * exit codes are the API, and the on-disk format stays free to change.
 *
 * Usage:
 *   bun send.ts --conversation <id> --text <message> [--thread <thread_id>]
 *   bun send.ts --list
 *
 * Text may also arrive on stdin, which is what a caller with a long or
 * shell-hostile message should use:
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

const STATE_DIR = process.env.MSTEAMS_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'msteams')

function die(code: number, message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
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
  for (const ref of all) {
    process.stdout.write(`${ref.conversationId}\t${ref.conversationType}\t${ref.updatedAt}\n`)
  }
  process.exit(0)
}

const conversationId = flag('conversation')
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

// OUTBOUND GATE, identical in effect to the reply tool's: a reference exists
// only for conversations the inbound gate accepted.
const ref = conversations.get(conversationId)
if (!ref) {
  die(3, `refused: no inbound conversation on record for that id — run --list to see what is reachable`)
}

const app = new App({ clientId: APP_ID, clientSecret: APP_PASSWORD, tenantId: TENANT_ID })
const threadId = flag('thread')

try {
  const ids: string[] = []
  for (const chunk of chunkText(text)) {
    const activity = { type: 'message', text: chunk, textFormat: 'markdown' } as any
    const sent = threadId
      ? await app.reply(ref.conversationId, threadId, activity)
      : await app.send(ref.conversationId, activity)
    if (sent?.id) ids.push(String(sent.id))
  }
  process.stdout.write(`${ids.join(' ')}\n`)
  process.exit(0)
} catch (err) {
  die(4, `send failed: ${err instanceof Error ? err.message : String(err)}`)
}
