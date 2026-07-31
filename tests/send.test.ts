/**
 * Contract test for the `send.ts` CLI, spawned as a real process.
 *
 * This CLI is a **frozen surface**: the hermit integration shells out to it and
 * reads its exit codes rather than the state dir, so the flags and the codes
 * are the API. Every claim about them rested on reading the source until this
 * file existed.
 *
 * Everything here is offline. The gate refusals and usage errors all return
 * before any credential is used, so no tenant is reachable and none is needed —
 * which is also the point: a refusal must cost zero network.
 */

import { test, expect, describe, beforeEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ConversationRef } from '../src/conversations.js'
import { CONVERSATION_VERSION } from '../src/conversations.js'
import { createHash } from 'crypto'
import type { Access } from '../src/gate.js'

const SEND = join(import.meta.dir, '..', 'send.ts')
const SENDER = '11111111-2222-3333-4444-555555555555'
const DM_ID = 'a:1dmconversation'
const CHANNEL_ID = '19:abc123@thread.tacv2'

let stateDir: string

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'msteams-send-'))
  mkdirSync(join(stateDir, 'conversations'), { recursive: true })
})

/** Writes a reference the way ConversationStore does — same hashed filename. */
function putRef(ref: Partial<ConversationRef> & { conversationId: string }): void {
  const full: ConversationRef = {
    version: CONVERSATION_VERSION,
    conversationType: 'personal',
    tenantId: 'tenant-1',
    serviceUrl: 'https://smba.trafficmanager.net/emea/',
    updatedAt: '2026-07-31T12:00:00.000Z',
    ...ref,
  }
  const hash = createHash('sha256').update(full.conversationId).digest('hex').slice(0, 32)
  writeFileSync(join(stateDir, 'conversations', `${hash}.json`), JSON.stringify(full, null, 2))
}

function putAccess(access: Partial<Access>): void {
  writeFileSync(
    join(stateDir, 'access.json'),
    JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [], groups: {}, pending: {}, ...access }),
  )
}

/** Credentials good enough to get past the configured check; never used. */
function putCredentials(): void {
  writeFileSync(
    join(stateDir, '.env'),
    'MSTEAMS_APP_ID=00000000-0000-0000-0000-000000000000\n' +
      'MSTEAMS_APP_PASSWORD=not-a-real-secret\n' +
      'MSTEAMS_TENANT_ID=tenant-1\n',
    { mode: 0o600 },
  )
}

async function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', SEND, ...args], {
    // A clean env: inherited MSTEAMS_* would otherwise decide the test's
    // outcome, and the credential check reads process.env.
    env: { PATH: process.env.PATH ?? '', HOME: stateDir, MSTEAMS_STATE_DIR: stateDir },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

describe('--list', () => {
  test('says so plainly when nothing is on record', async () => {
    const { code, stdout } = await run('--list')
    expect(code).toBe(0)
    expect(stdout).toContain('no conversations on record')
  })

  test('marks an allowed DM reachable', async () => {
    putRef({ conversationId: DM_ID, senderId: SENDER })
    putAccess({ allowFrom: [SENDER] })
    const { code, stdout } = await run('--list')
    expect(code).toBe(0)
    const [id, type, status] = stdout.trim().split('\t')
    expect(id).toBe(DM_ID)
    expect(type).toBe('personal')
    expect(status).toBe('reachable')
  })

  test('marks a revoked DM unreachable, with the reason', async () => {
    // The M4 review's finding: --list once advertised a revoked conversation as
    // reachable, so the operator got a positive signal and then exit 3.
    putRef({ conversationId: DM_ID, senderId: SENDER })
    putAccess({ allowFrom: [] })
    const { stdout } = await run('--list')
    expect(stdout).toContain('unreachable:sender_not_allowed')
    expect(stdout).not.toContain('\treachable\t')
  })

  test('a channel is unreachable until it is opted in', async () => {
    putRef({ conversationId: CHANNEL_ID, conversationType: 'channel' })
    putAccess({})
    expect((await run('--list')).stdout).toContain('unreachable:conversation_not_opted_in')

    putAccess({ groups: { [CHANNEL_ID]: { requireMention: false, allowFrom: [] } } })
    expect((await run('--list')).stdout).toContain('\treachable\t')
  })

  test('kill-switch: dmPolicy disabled makes everything unreachable', async () => {
    putRef({ conversationId: DM_ID, senderId: SENDER })
    putRef({ conversationId: CHANNEL_ID, conversationType: 'channel' })
    putAccess({
      dmPolicy: 'disabled',
      allowFrom: [SENDER],
      groups: { [CHANNEL_ID]: { requireMention: false, allowFrom: [] } },
    })
    const { stdout } = await run('--list')
    expect(stdout).not.toContain('\treachable\t')
    expect(stdout.trim().split('\n')).toHaveLength(2)
  })

  test('listing needs no credentials', async () => {
    // An operator diagnosing "is anything reachable" should not first have to
    // finish provisioning.
    putRef({ conversationId: DM_ID, senderId: SENDER })
    putAccess({ allowFrom: [SENDER] })
    expect((await run('--list')).code).toBe(0)
  })
})

describe('exit 1 — bad usage', () => {
  test('no arguments at all', async () => {
    const { code, stderr } = await run()
    expect(code).toBe(1)
    expect(stderr).toContain('usage:')
  })

  test('a conversation with no message', async () => {
    // stdin is closed, so there is nothing to fall back to.
    const { code, stderr } = await run('--conversation', DM_ID)
    expect(code).toBe(1)
    expect(stderr).toContain('nothing to send')
  })

  test('whitespace is not a message', async () => {
    const { code, stderr } = await run('--conversation', DM_ID, '--text', '   \n  ')
    expect(code).toBe(1)
    expect(stderr).toContain('nothing to send')
  })

  test('a swallowed id is a usage error, not a gate refusal', async () => {
    // `--conversation --text hi` used to take "--text" as the conversation id
    // and report "no inbound conversation on record" (exit 3), pointing the
    // caller at access rather than at their own command line.
    const { code, stderr } = await run('--conversation', '--text', 'hi')
    expect(code).toBe(1)
    expect(stderr).toContain('--conversation needs a value')
  })
})

describe('exit 2 — not configured', () => {
  test('missing credentials are reported before any gate work', async () => {
    const { code, stderr } = await run('--conversation', DM_ID, '--text', 'hello')
    expect(code).toBe(2)
    expect(stderr).toContain('not configured')
    expect(stderr).toContain('/msteams:configure')
  })

  test('partial credentials still count as unconfigured', async () => {
    writeFileSync(join(stateDir, '.env'), 'MSTEAMS_APP_ID=00000000-0000-0000-0000-000000000000\n')
    const { code, stderr } = await run('--conversation', DM_ID, '--text', 'hello')
    expect(code).toBe(2)
    expect(stderr).toContain('not configured')
  })
})

describe('exit 3 — the outbound gate', () => {
  beforeEach(putCredentials)

  test('an unknown conversation is refused', async () => {
    // Half one of the gate: no stored reference means no inbound activity was
    // ever accepted from here, so this CLI must not be a way to reach it.
    const { code, stderr } = await run('--conversation', 'a:never-seen', '--text', 'hello')
    expect(code).toBe(3)
    expect(stderr).toContain('no inbound conversation on record')
  })

  test('a stored reference is NOT sufficient once access is revoked', async () => {
    // Half two, and the anti-exfiltration property that matters most: a
    // reference is a claim about the past. `/msteams:access remove` must stop
    // this CLI, not merely stop new inbound.
    putRef({ conversationId: DM_ID, senderId: SENDER })
    putAccess({ allowFrom: [] })
    const { code, stderr } = await run('--conversation', DM_ID, '--text', 'hello')
    expect(code).toBe(3)
    expect(stderr).toContain('sender_not_allowed')
    expect(stderr).toContain('/msteams:access')
  })

  test('dmPolicy disabled refuses an otherwise-allowlisted DM', async () => {
    putRef({ conversationId: DM_ID, senderId: SENDER })
    putAccess({ dmPolicy: 'disabled', allowFrom: [SENDER] })
    const { code, stderr } = await run('--conversation', DM_ID, '--text', 'hello')
    expect(code).toBe(3)
    expect(stderr).toContain('dm_disabled')
  })

  test('dmPolicy disabled refuses an opted-in channel too', async () => {
    // The kill switch is global, matching discord. A channel staying live after
    // the operator disabled the bot is a failure in the dangerous direction.
    putRef({ conversationId: CHANNEL_ID, conversationType: 'channel' })
    putAccess({
      dmPolicy: 'disabled',
      groups: { [CHANNEL_ID]: { requireMention: false, allowFrom: [] } },
    })
    const { code, stderr } = await run('--conversation', CHANNEL_ID, '--text', 'hello')
    expect(code).toBe(3)
    expect(stderr).toContain('dm_disabled')
  })

  test('a channel that was never opted in is refused', async () => {
    putRef({ conversationId: CHANNEL_ID, conversationType: 'channel' })
    putAccess({})
    const { code, stderr } = await run('--conversation', CHANNEL_ID, '--text', 'hello')
    expect(code).toBe(3)
    expect(stderr).toContain('conversation_not_opted_in')
  })

  test('a reference predating senderId fails closed', async () => {
    // Refs written before Phase 4 carry no senderId, so the DM gate cannot
    // identify who is on the other end. One inbound message repairs it.
    putRef({ conversationId: DM_ID })
    putAccess({ allowFrom: [SENDER] })
    const { code, stderr } = await run('--conversation', DM_ID, '--text', 'hello')
    expect(code).toBe(3)
    expect(stderr).toContain('no_sender_identity')
  })

  test('a refusal never reaches the network', async () => {
    // The credentials are fake, so anything that got as far as acquiring a
    // token would fail differently (exit 4) and take seconds doing it.
    putRef({ conversationId: DM_ID, senderId: SENDER })
    putAccess({ allowFrom: [] })
    const started = performance.now()
    const { code } = await run('--conversation', DM_ID, '--text', 'hello')
    expect(code).toBe(3)
    expect(performance.now() - started).toBeLessThan(5000)
  })
})

describe('state-dir contract', () => {
  test('MSTEAMS_STATE_DIR relocates everything the CLI reads', async () => {
    // The hermit slice depends on this: it points the CLI at a state dir and
    // never parses what is inside it.
    putRef({ conversationId: DM_ID, senderId: SENDER })
    putAccess({ allowFrom: [SENDER] })
    const { stdout } = await run('--list')
    expect(stdout).toContain(DM_ID)

    // A different state dir knows nothing about it.
    stateDir = mkdtempSync(join(tmpdir(), 'msteams-send-other-'))
    expect((await run('--list')).stdout).toContain('no conversations on record')
  })

  test('credentials are read from the state dir, never from argv', async () => {
    // Passing them on the command line must not configure the CLI — argv is
    // world-readable in /proc, which is the whole reason for the .env file.
    const { code, stderr } = await run(
      '--conversation', DM_ID,
      '--text', 'hello',
      '--app-id', '00000000-0000-0000-0000-000000000000',
      '--app-password', 'not-a-real-secret',
      '--tenant-id', 'tenant-1',
    )
    expect(code).toBe(2)
    expect(stderr).toContain('not configured')
  })
})
