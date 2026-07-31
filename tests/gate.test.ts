import { describe, expect, test } from 'bun:test'
import {
  gate,
  mentionsBot,
  normalizeConversationId,
  normalizeSenderId,
  DEFAULT_ACCESS,
  type Access,
  type GateInput,
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
})

describe('group and channel gating', () => {
  const group = (over: Partial<GateInput> = {}): GateInput =>
    dm({ conversationType: 'groupChat', conversationId: '19:abc@thread.tacv2', ...over })

  test('a conversation the operator never opted into is refused', () => {
    const v = gate(group({ mentionsBot: true }), access({ allowFrom: [SENDER] }), TENANT)
    expect(v).toEqual({ allowed: false, reason: 'conversation_not_opted_in' })
  })

  test('an opted-in conversation with a mention passes', () => {
    const v = gate(
      group({ mentionsBot: true }),
      access({ allowFrom: [SENDER], allowConversations: ['19:abc@thread.tacv2'] }),
      TENANT,
    )
    expect(v.allowed).toBe(true)
  })

  test('an opted-in conversation without a mention is refused', () => {
    const v = gate(
      group({ mentionsBot: false }),
      access({ allowFrom: [SENDER], allowConversations: ['19:abc@thread.tacv2'] }),
      TENANT,
    )
    expect(v).toEqual({ allowed: false, reason: 'mention_required' })
  })

  test('requireMention off allows an unmentioned message in an opted-in conversation', () => {
    const v = gate(
      group({ mentionsBot: false }),
      access({ allowFrom: [SENDER], allowConversations: ['19:abc@thread.tacv2'], requireMention: false }),
      TENANT,
    )
    expect(v.allowed).toBe(true)
  })

  test('opting in a conversation does not admit a non-allowlisted sender', () => {
    const v = gate(
      group({ mentionsBot: true, senderAadObjectId: 'someone-else' }),
      access({ allowFrom: [SENDER], allowConversations: ['19:abc@thread.tacv2'] }),
      TENANT,
    )
    expect(v).toEqual({ allowed: false, reason: 'sender_not_allowed' })
  })

  test('a thread reply matches its parent conversation opt-in', () => {
    const v = gate(
      group({ conversationId: '19:abc@thread.tacv2;messageid=170000', mentionsBot: true }),
      access({ allowFrom: [SENDER], allowConversations: ['19:abc@thread.tacv2'] }),
      TENANT,
    )
    expect(v.allowed).toBe(true)
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
