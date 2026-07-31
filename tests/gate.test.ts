import { describe, expect, test } from 'bun:test'
import {
  gate,
  mentionsBot,
  normalizeConversationId,
  normalizeSenderId,
  DEFAULT_ACCESS,
  type Access,
  type GateInput,
  type GroupPolicy,
} from '../src/gate.js'

const TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const SENDER = '00000000-1111-2222-3333-444444444444'
const BOT = '28:00000000-aaaa-bbbb-cccc-dddddddddddd'

const access = (over: Partial<Access> = {}): Access => ({ ...DEFAULT_ACCESS, ...over })

const dm = (over: Partial<GateInput> = {}): GateInput => ({
  tenantId: TENANT,
  conversationId: 'a:1conv',
  conversationType: 'personal',
  senderAadObjectId: SENDER,
  mentionsBot: false,
  ...over,
})

describe('conversation id normalization', () => {
  test('strips the thread messageid suffix', () => {
    expect(normalizeConversationId('19:abc@thread.tacv2;messageid=1700000000000')).toBe(
      '19:abc@thread.tacv2',
    )
  })

  test('leaves a plain id untouched', () => {
    expect(normalizeConversationId('a:1conv')).toBe('a:1conv')
  })

  test('preserves case — these ids are opaque and case-sensitive', () => {
    expect(normalizeConversationId('19:AbCdEf@thread.tacv2')).toBe('19:AbCdEf@thread.tacv2')
  })

  test('a thread and its parent resolve to the same conversation', () => {
    const parent = '19:abc@thread.tacv2'
    expect(normalizeConversationId(`${parent};messageid=1`)).toBe(
      normalizeConversationId(`${parent};messageid=2`),
    )
  })
})

describe('sender id normalization', () => {
  test('lowercases and trims (AAD object ids are case-insensitive)', () => {
    expect(normalizeSenderId('  ABCD-1234  ')).toBe('abcd-1234')
  })
})

describe('tenant boundary', () => {
  test('an activity from another tenant is refused', () => {
    const v = gate(dm({ tenantId: 'ffffffff-0000-0000-0000-000000000000' }), access({ allowFrom: [SENDER] }), TENANT)
    expect(v).toEqual({ allowed: false, reason: 'tenant_mismatch' })
  })

  test('a missing tenant is refused', () => {
    const v = gate(dm({ tenantId: undefined }), access({ allowFrom: [SENDER] }), TENANT)
    expect(v).toEqual({ allowed: false, reason: 'tenant_mismatch' })
  })

  test('tenant comparison is case-insensitive', () => {
    const v = gate(dm({ tenantId: TENANT.toUpperCase() }), access({ allowFrom: [SENDER] }), TENANT)
    expect(v.allowed).toBe(true)
  })

  test('tenant is checked before sender — a foreign tenant never reports sender_not_allowed', () => {
    const v = gate(dm({ tenantId: 'other', senderAadObjectId: undefined }), access(), TENANT)
    expect(v).toEqual({ allowed: false, reason: 'tenant_mismatch' })
  })
})

describe('sender identity', () => {
  test('an allowlisted sender passes in a DM', () => {
    expect(gate(dm(), access({ allowFrom: [SENDER] }), TENANT).allowed).toBe(true)
  })

  test('an unlisted sender is refused', () => {
    expect(gate(dm(), access(), TENANT)).toEqual({ allowed: false, reason: 'sender_not_allowed' })
  })

  test('a principal with no AAD object id is refused — names never grant access', () => {
    const v = gate(dm({ senderAadObjectId: undefined }), access({ allowFrom: [SENDER] }), TENANT)
    expect(v).toEqual({ allowed: false, reason: 'no_sender_identity' })
  })

  test('allowlist matching is case-insensitive on the sender id', () => {
    const v = gate(dm({ senderAadObjectId: SENDER.toUpperCase() }), access({ allowFrom: [SENDER] }), TENANT)
    expect(v.allowed).toBe(true)
  })
})

describe('dm policy', () => {
  test('disabled refuses even an allowlisted sender', () => {
    const v = gate(dm(), access({ dmPolicy: 'disabled', allowFrom: [SENDER] }), TENANT)
    expect(v).toEqual({ allowed: false, reason: 'dm_disabled' })
  })

  test('pairing still refuses an unknown sender until they are added', () => {
    const v = gate(dm(), access({ dmPolicy: 'pairing' }), TENANT)
    expect(v).toEqual({ allowed: false, reason: 'sender_not_allowed' })
  })

  test('disabled is a global kill switch, not just a DM setting', () => {
    // Matches discord, whose ACCESS.md states it plainly: "Drop everything,
    // including allowlisted users and guild channels." An operator reaching for
    // this wants the bot off; leaving channels answering would fail in the
    // dangerous direction.
    const off = access({
      dmPolicy: 'disabled',
      allowFrom: [SENDER],
      groups: { '19:abc@thread.tacv2': { requireMention: false, allowFrom: [] } },
    })
    expect(gate(dm(), off, TENANT)).toEqual({ allowed: false, reason: 'dm_disabled' })
    expect(
      gate(
        dm({
          conversationType: 'groupChat',
          conversationId: '19:abc@thread.tacv2',
          mentionsBot: true,
        }),
        off,
        TENANT,
      ),
    ).toEqual({ allowed: false, reason: 'dm_disabled' })
  })
})

describe('group and channel gating', () => {
  const group = (over: Partial<GateInput> = {}): GateInput =>
    dm({ conversationType: 'groupChat', conversationId: '19:abc@thread.tacv2', ...over })

  test('a conversation the operator never opted into is refused', () => {
    const v = gate(group({ mentionsBot: true }), access({ allowFrom: [SENDER] }), TENANT)
    expect(v).toEqual({ allowed: false, reason: 'conversation_not_opted_in' })
  })

  const opted = (policy: Partial<GroupPolicy> = {}) =>
    access({
      allowFrom: [SENDER],
      groups: { '19:abc@thread.tacv2': { requireMention: true, allowFrom: [], ...policy } },
    })

  test('an opted-in conversation with a mention passes', () => {
    expect(gate(group({ mentionsBot: true }), opted(), TENANT).allowed).toBe(true)
  })

  test('an opted-in conversation without a mention is refused', () => {
    const v = gate(group({ mentionsBot: false }), opted(), TENANT)
    expect(v).toEqual({ allowed: false, reason: 'mention_required' })
  })

  test('requireMention is per-conversation, not global', () => {
    // The whole point of the groups restructure: quiet in one channel,
    // mention-gated in another, within one access.json.
    const both = access({
      allowFrom: [SENDER],
      groups: {
        '19:abc@thread.tacv2': { requireMention: false, allowFrom: [] },
        '19:other@thread.tacv2': { requireMention: true, allowFrom: [] },
      },
    })
    expect(gate(group({ mentionsBot: false }), both, TENANT).allowed).toBe(true)
    expect(
      gate(group({ conversationId: '19:other@thread.tacv2', mentionsBot: false }), both, TENANT),
    ).toEqual({ allowed: false, reason: 'mention_required' })
  })

  test('an empty group allowFrom admits any sender in that conversation', () => {
    // Matches discord and telegram: opting the conversation in IS the trust
    // decision. Requiring every colleague to pair by DM first would make a
    // shared channel unusable. Note this is looser than the DM path, where an
    // unknown sender is always refused.
    const v = gate(group({ mentionsBot: true, senderAadObjectId: 'someone-else' }), opted(), TENANT)
    expect(v.allowed).toBe(true)
  })

  test('a non-empty group allowFrom narrows to exactly those senders', () => {
    const narrowed = opted({ allowFrom: [SENDER] })
    expect(gate(group({ mentionsBot: true }), narrowed, TENANT).allowed).toBe(true)
    expect(
      gate(group({ mentionsBot: true, senderAadObjectId: 'someone-else' }), narrowed, TENANT),
    ).toEqual({ allowed: false, reason: 'sender_not_allowed' })
  })

  test('the group allowFrom matches case-insensitively in both directions', () => {
    // AAD object ids are GUIDs and arrive in whatever case the source used. An
    // allowlist entry that silently never matches is a lockout the operator
    // cannot see, so both sides are normalized — not just the activity.
    expect(
      gate(
        group({ mentionsBot: true, senderAadObjectId: SENDER.toUpperCase() }),
        opted({ allowFrom: [SENDER] }),
        TENANT,
      ).allowed,
    ).toBe(true)
    expect(
      gate(group({ mentionsBot: true }), opted({ allowFrom: [SENDER.toUpperCase()] }), TENANT)
        .allowed,
    ).toBe(true)
  })

  test('a thread reply matches its parent conversation opt-in', () => {
    const v = gate(
      group({ conversationId: '19:abc@thread.tacv2;messageid=170000', mentionsBot: true }),
      opted(),
      TENANT,
    )
    expect(v.allowed).toBe(true)
  })
})

describe('mentionPatterns', () => {
  // access.json persists these and the access skill offers `set mentionPatterns`,
  // so a version of mentionsBot() that ignored them would ship a documented
  // feature with no consumer — the exact "documented but absent" trap telegram's
  // ACCESS.md falls into.
  test('an operator pattern counts as addressing the bot', () => {
    expect(mentionsBot([], BOT, 'claude, what is up', ['^claude\\b'])).toBe(true)
  })

  test('patterns are case-insensitive', () => {
    expect(mentionsBot([], BOT, 'Claude, hello', ['^claude\\b'])).toBe(true)
  })

  test('text not matching any pattern is not a mention', () => {
    expect(mentionsBot([], BOT, 'talking amongst ourselves', ['^claude\\b'])).toBe(false)
  })

  test('a real mention still wins with no patterns configured', () => {
    expect(mentionsBot([{ type: 'mention', mentioned: { id: BOT } }], BOT, 'hi')).toBe(true)
  })

  test('a malformed pattern disables itself, not the whole gate', () => {
    expect(mentionsBot([], BOT, 'claude hello', ['(unclosed', '^claude\\b'])).toBe(true)
  })

  test('patterns need text to match against', () => {
    expect(mentionsBot([], BOT, undefined, ['^claude\\b'])).toBe(false)
  })
})

describe('mention detection', () => {
  test('a mention of the bot counts', () => {
    const entities = [{ type: 'mention', mentioned: { id: BOT } }]
    expect(mentionsBot(entities, BOT)).toBe(true)
  })

  test('a mention of someone else does not count', () => {
    const entities = [{ type: 'mention', mentioned: { id: '29:other' } }]
    expect(mentionsBot(entities, BOT)).toBe(false)
  })

  test('typing the bot name as plain text does not count', () => {
    expect(mentionsBot([{ type: 'clientInfo' }], BOT)).toBe(false)
    expect(mentionsBot([], BOT)).toBe(false)
  })

  test('missing or malformed entities are handled', () => {
    expect(mentionsBot(undefined, BOT)).toBe(false)
    expect(mentionsBot('not-an-array', BOT)).toBe(false)
    expect(mentionsBot([{ type: 'mention' }], BOT)).toBe(false)
  })

  test('no recipient id means no mention can be confirmed', () => {
    expect(mentionsBot([{ type: 'mention', mentioned: { id: BOT } }], undefined)).toBe(false)
  })
})
