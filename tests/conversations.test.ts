import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConversationStore } from '../src/conversations.js'

const TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

let dir: string
let store: ConversationStore

const activity = (over: Record<string, any> = {}) => ({
  id: 'a1',
  serviceUrl: 'https://smba.trafficmanager.net/teams/',
  conversation: { id: 'a:1conv', conversationType: 'personal', tenantId: TENANT },
  recipient: { id: '28:bot', name: 'test-bot' },
  channelData: { tenant: { id: TENANT } },
  ...over,
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'msteams-conv-'))
  store = new ConversationStore(dir)
})
afterEach(() => {
  try {
    rmSync(dir, { recursive: true })
  } catch {}
})

test('an inbound activity is stored and retrievable', () => {
  store.upsert(activity())
  const ref = store.get('a:1conv')
  expect(ref?.conversationId).toBe('a:1conv')
  expect(ref?.tenantId).toBe(TENANT)
  expect(ref?.serviceUrl).toBe('https://smba.trafficmanager.net/teams/')
  expect(ref?.botId).toBe('28:bot')
})

test('upsert overwrites — the newest service url wins', () => {
  store.upsert(activity())
  store.upsert(activity({ serviceUrl: 'https://smba.trafficmanager.net/emea/' }))
  expect(store.get('a:1conv')?.serviceUrl).toBe('https://smba.trafficmanager.net/emea/')
  expect(store.list()).toHaveLength(1)
})

test('a thread reply updates the parent conversation, not a new entry', () => {
  store.upsert(activity())
  store.upsert(activity({ conversation: { id: 'a:1conv;messageid=17000', conversationType: 'personal' } }))
  expect(store.list()).toHaveLength(1)
})

test('a threaded id retrieves the parent reference', () => {
  store.upsert(activity())
  expect(store.get('a:1conv;messageid=17000')?.conversationId).toBe('a:1conv')
})

test('distinct conversations are stored separately', () => {
  store.upsert(activity())
  store.upsert(activity({ conversation: { id: '19:abc@thread.tacv2', conversationType: 'channel' } }))
  expect(store.list()).toHaveLength(2)
})

test('an unknown conversation returns undefined rather than throwing', () => {
  expect(store.get('a:nope')).toBeUndefined()
})

test('an activity with no conversation id is ignored', () => {
  expect(store.upsert({ id: 'a1', conversation: {} })).toBeUndefined()
  expect(store.list()).toHaveLength(0)
})

test('the store survives a restart', () => {
  store.upsert(activity())
  expect(new ConversationStore(dir).get('a:1conv')?.conversationId).toBe('a:1conv')
})

test('ids with path separators cannot escape the store dir', () => {
  store.upsert(activity({ conversation: { id: '../../etc/passwd', conversationType: 'personal' } }))
  expect(store.get('../../etc/passwd')?.conversationId).toBe('../../etc/passwd')
  expect(store.list()).toHaveLength(1)
})

test('a corrupt entry is skipped by list rather than throwing', () => {
  store.upsert(activity())
  Bun.write(join(dir, 'garbage.json'), '{not json')
  expect(store.list()).toHaveLength(1)
})
