/**
 * Access persistence and the pairing handshake.
 *
 * `gate()` stays pure and decides yes/no; everything that has to *write*
 * something — issuing a pairing code, pruning an expired one, snapshotting for
 * static mode — lives here. Structure and every constant mirror the official
 * discord and telegram plugins (`external_plugins/{discord,telegram}/server.ts`
 * @ db253f26), because an operator who has run one of those should find this
 * one already familiar.
 *
 * The pairing flow, end to end:
 *
 *   1. An unknown sender DMs the bot. `gate()` refuses (`sender_not_allowed`).
 *   2. Under `dmPolicy: 'pairing'`, the server calls `issuePairingCode()` and
 *      replies with the code. Nothing is delivered to the session.
 *   3. The operator runs `/msteams:access pair <code>` in their terminal. The
 *      skill moves the sender into `allowFrom` and drops a file at
 *      `approved/<senderId>` whose contents are the conversation id.
 *   4. `takeApprovals()` finds the file within ~5s, the server sends a
 *      confirmation, and subsequent messages pass the gate normally.
 *
 * Step 3 is deliberately terminal-only. A Teams message can never approve
 * itself — that is the request a prompt injection would make.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { DEFAULT_ACCESS, type Access, type PendingEntry } from './gate.js'

export type { PendingEntry }

/** 1 hour, matching discord/telegram. Long enough to walk to a terminal. */
export const PAIRING_TTL_MS = 60 * 60 * 1000
/** Beyond this many unapproved codes, further strangers are dropped silently. */
export const MAX_PENDING = 3
/** Initial reply plus one reminder, then silence. Stops a stranger looping us. */
export const MAX_PAIRING_REPLIES = 2

export type PairResult =
  | { action: 'pair'; code: string; isResend: boolean }
  | { action: 'drop' }

function accessFile(dir: string): string {
  return join(dir, 'access.json')
}

/**
 * Read access.json, tolerating absence and corruption.
 *
 * A corrupt file is moved aside rather than deleted — it is the operator's
 * allowlist, and silently starting from empty while leaving no evidence would
 * be the worst of both worlds.
 */
export function readAccess(dir: string): Access {
  let raw: string
  try {
    raw = readFileSync(accessFile(dir), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_ACCESS }
    throw err
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? DEFAULT_ACCESS.dmPolicy,
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
    }
  } catch {
    try {
      renameSync(accessFile(dir), `${accessFile(dir)}.corrupt-${Date.now()}`)
    } catch {}
    process.stderr.write('msteams channel: access.json is corrupt, moved aside. Starting fresh.\n')
    return { ...DEFAULT_ACCESS }
  }
}

export function saveAccess(dir: string, a: Access): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = accessFile(dir)
  const tmp = `${target}.tmp`
  // 0600: this file names everyone allowed to drive the session.
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, target)
}

/** Drop timed-out pairing codes. Returns whether anything changed. */
export function pruneExpired(a: Access, now = Date.now()): boolean {
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

/**
 * Issue (or re-surface) a pairing code for an unknown DM sender.
 *
 * Mutates `a` — the caller persists. Returns `drop` when the sender has already
 * been told twice, or when too many codes are outstanding; both are silent by
 * design, since a reply confirms the bot exists to someone not authorized to
 * know that.
 */
export function issuePairingCode(
  a: Access,
  senderId: string,
  conversationId: string,
  now = Date.now(),
): PairResult {
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.senderId === senderId) {
      if ((p.replies ?? 1) >= MAX_PAIRING_REPLIES) return { action: 'drop' }
      p.replies = (p.replies ?? 1) + 1
      // Re-surface the original code rather than minting a second one, so the
      // operator never sees two live codes for one person.
      return { action: 'pair', code, isResend: true }
    }
  }

  if (Object.keys(a.pending).length >= MAX_PENDING) return { action: 'drop' }

  const code = randomBytes(3).toString('hex') // 6 hex chars
  a.pending[code] = {
    senderId,
    conversationId,
    createdAt: now,
    expiresAt: now + PAIRING_TTL_MS,
    replies: 1,
  }
  return { action: 'pair', code, isResend: false }
}

/**
 * Static mode: snapshot access at boot, never re-read, never write.
 *
 * Pairing needs runtime mutation, so it is downgraded to `allowlist` with a
 * warning. Handing out codes that can never be approved would look like the
 * feature works while quietly going nowhere.
 */
export function bootStaticAccess(dir: string): Access {
  const a = readAccess(dir)
  if (a.dmPolicy === 'pairing') {
    process.stderr.write(
      'msteams channel: static mode — dmPolicy "pairing" downgraded to "allowlist"\n',
    )
    a.dmPolicy = 'allowlist'
  }
  a.pending = {}
  return a
}

export type Approval = { senderId: string; conversationId: string }

/**
 * Collect and clear approval dropfiles written by the access skill.
 *
 * Files are removed as they are read, including malformed ones — a file that
 * cannot be acted on would otherwise be retried every poll forever. The
 * filename is the sender id and the contents are the conversation id to confirm
 * into.
 */
export function takeApprovals(dir: string): Approval[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }

  const out: Approval[] = []
  for (const senderId of names) {
    const file = join(dir, senderId)
    let conversationId = ''
    try {
      conversationId = readFileSync(file, 'utf8').trim()
    } catch {}
    rmSync(file, { force: true })
    if (conversationId) out.push({ senderId, conversationId })
  }
  return out
}
