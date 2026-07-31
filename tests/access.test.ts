import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  readAccess,
  saveAccess,
  pruneExpired,
  issuePairingCode,
  bootStaticAccess,
  takeApprovals,
  PAIRING_TTL_MS,
  MAX_PENDING,
} from '../src/access.js'
import { DEFAULT_ACCESS, type Access } from '../src/gate.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'msteams-access-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const fresh = (): Access => ({ ...DEFAULT_ACCESS, allowFrom: [], groups: {}, pending: {} })

describe('reading access.json', () => {
  test('an absent file yields the defaults, not an error', () => {
    // First boot: pairing on, nobody allowed, nothing opted in.
    expect(readAccess(dir)).toEqual(DEFAULT_ACCESS)
  })

  test('a partial file is filled in rather than rejected', () => {
    writeFileSync(join(dir, 'access.json'), JSON.stringify({ allowFrom: ['abc'] }))
    const a = readAccess(dir)
    expect(a.allowFrom).toEqual(['abc'])
    expect(a.dmPolicy).toBe('pairing')
    expect(a.groups).toEqual({})
    expect(a.pending).toEqual({})
  })

  test('a corrupt file is moved aside, not deleted', () => {
    // It is the operator's allowlist. Starting fresh while destroying the
    // evidence would be the worst of both worlds.
    writeFileSync(join(dir, 'access.json'), '{ not json')
    expect(readAccess(dir)).toEqual(DEFAULT_ACCESS)
    const saved = readdirSync(dir).filter(n => n.includes('corrupt'))
    expect(saved).toHaveLength(1)
    expect(readFileSync(join(dir, saved[0]!), 'utf8')).toBe('{ not json')
  })
})

describe('writing access.json', () => {
  test('round-trips and is written 0600', () => {
    const a = fresh()
    a.allowFrom = ['sender-1']
    a.groups = { '19:x@thread.tacv2': { requireMention: false, allowFrom: [] } }
    saveAccess(dir, a)

    expect(readAccess(dir)).toEqual(a)
    // Names everyone who may drive the session — not world-readable.
    expect(statSync(join(dir, 'access.json')).mode & 0o777).toBe(0o600)
  })
})

describe('pairing codes', () => {
  test('an unknown sender gets a fresh 6-hex code', () => {
    const a = fresh()
    const r = issuePairingCode(a, 'sender-1', 'a:1conv')

    expect(r).toMatchObject({ action: 'pair', isResend: false })
    if (r.action !== 'pair') throw new Error('unreachable')
    expect(r.code).toMatch(/^[0-9a-f]{6}$/)
    expect(a.pending[r.code]).toMatchObject({ senderId: 'sender-1', conversationId: 'a:1conv' })
  })

  test('the same sender gets the SAME code back, not a second one', () => {
    // Two live codes for one person would be ambiguous for the operator.
    const a = fresh()
    const first = issuePairingCode(a, 'sender-1', 'a:1conv')
    const second = issuePairingCode(a, 'sender-1', 'a:1conv')

    expect(second).toMatchObject({ action: 'pair', isResend: true })
    if (first.action !== 'pair' || second.action !== 'pair') throw new Error('unreachable')
    expect(second.code).toBe(first.code)
    expect(Object.keys(a.pending)).toHaveLength(1)
  })

  test('after two replies the sender is met with silence', () => {
    // Initial + one reminder. Beyond that a stranger could use us as an echo.
    const a = fresh()
    issuePairingCode(a, 'sender-1', 'a:1conv')
    issuePairingCode(a, 'sender-1', 'a:1conv')
    expect(issuePairingCode(a, 'sender-1', 'a:1conv')).toEqual({ action: 'drop' })
  })

  test('a fourth distinct stranger is dropped', () => {
    const a = fresh()
    for (let i = 0; i < MAX_PENDING; i++) {
      expect(issuePairingCode(a, `sender-${i}`, 'a:1conv').action).toBe('pair')
    }
    expect(issuePairingCode(a, 'sender-overflow', 'a:1conv')).toEqual({ action: 'drop' })
  })

  test('the cap is on live codes, so expiry reopens a slot', () => {
    const a = fresh()
    const t0 = 1_000_000
    for (let i = 0; i < MAX_PENDING; i++) issuePairingCode(a, `sender-${i}`, 'a:1conv', t0)
    expect(issuePairingCode(a, 'newcomer', 'a:1conv', t0)).toEqual({ action: 'drop' })

    const later = t0 + PAIRING_TTL_MS + 1
    expect(pruneExpired(a, later)).toBe(true)
    expect(a.pending).toEqual({})
    expect(issuePairingCode(a, 'newcomer', 'a:1conv', later).action).toBe('pair')
  })

  test('pruning reports whether it changed anything', () => {
    const a = fresh()
    issuePairingCode(a, 'sender-1', 'a:1conv', 1_000_000)
    expect(pruneExpired(a, 1_000_001)).toBe(false)
    expect(pruneExpired(a, 1_000_000 + PAIRING_TTL_MS + 1)).toBe(true)
  })
})

describe('static mode', () => {
  test('pairing is downgraded to allowlist and pending is cleared', () => {
    // Static mode never writes, so a code handed out could never be approved.
    // Downgrading is honest; handing out dead codes is not.
    const a = fresh()
    issuePairingCode(a, 'sender-1', 'a:1conv')
    a.allowFrom = ['already-approved']
    saveAccess(dir, a)

    const booted = bootStaticAccess(dir)
    expect(booted.dmPolicy).toBe('allowlist')
    expect(booted.pending).toEqual({})
    expect(booted.allowFrom).toEqual(['already-approved'])
  })

  test('an explicit allowlist policy is left alone', () => {
    saveAccess(dir, { ...fresh(), dmPolicy: 'allowlist' })
    expect(bootStaticAccess(dir).dmPolicy).toBe('allowlist')
  })

  test('disabled is left alone', () => {
    saveAccess(dir, { ...fresh(), dmPolicy: 'disabled' })
    expect(bootStaticAccess(dir).dmPolicy).toBe('disabled')
  })
})

describe('approval dropfiles', () => {
  test('an approval is read and the file consumed', () => {
    writeFileSync(join(dir, 'sender-1'), 'a:1conv\n')
    expect(takeApprovals(dir)).toEqual([{ senderId: 'sender-1', conversationId: 'a:1conv' }])
    // Consumed, so the confirmation is sent once rather than every poll.
    expect(readdirSync(dir)).toEqual([])
  })

  test('an empty file is dropped rather than retried forever', () => {
    // No conversation id means nothing to confirm into. Leaving it would make
    // every 5s poll retry a send that can never succeed.
    writeFileSync(join(dir, 'sender-1'), '   \n')
    expect(takeApprovals(dir)).toEqual([])
    expect(readdirSync(dir)).toEqual([])
  })

  test('an absent directory is not an error', () => {
    expect(takeApprovals(join(dir, 'nope'))).toEqual([])
  })

  test('several approvals come back together', () => {
    writeFileSync(join(dir, 'sender-1'), 'a:1conv')
    writeFileSync(join(dir, 'sender-2'), 'a:2conv')
    expect(takeApprovals(dir).map(a => a.senderId).sort()).toEqual(['sender-1', 'sender-2'])
  })
})
