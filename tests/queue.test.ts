import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, chmodSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { IngressQueue, entryFilename, TOMBSTONE_TTL_MS } from '../src/queue.js'

let dir: string
let queue: IngressQueue

const activity = (id: string, text = 'hi') => ({
  type: 'message',
  id,
  text,
  conversation: { id: 'a:1conv', conversationType: 'personal' },
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'msteams-queue-'))
  queue = new IngressQueue(dir)
})
afterEach(() => {
  try {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true })
  } catch {}
})

describe('dedup', () => {
  test('a first delivery is accepted', () => {
    expect(queue.enqueue(activity('a1'))).toBe(true)
  })

  test('a redelivery of the same activity id is refused', () => {
    queue.enqueue(activity('a1'))
    expect(queue.enqueue(activity('a1'))).toBe(false)
  })

  test('dedup survives completion — a redelivery after finish is still refused', () => {
    queue.enqueue(activity('a1'))
    queue.finish('a1')
    expect(queue.enqueue(activity('a1'))).toBe(false)
  })

  test('dedup survives a restart (new instance, same dir)', () => {
    queue.enqueue(activity('a1'))
    queue.finish('a1')
    expect(new IngressQueue(dir).enqueue(activity('a1'))).toBe(false)
  })

  test('distinct ids are independent', () => {
    expect(queue.enqueue(activity('a1'))).toBe(true)
    expect(queue.enqueue(activity('a2'))).toBe(true)
  })

  test('an activity with no id is refused loudly rather than silently deduped', () => {
    expect(() => queue.enqueue({ type: 'message' })).toThrow(/no id/)
  })
})

describe('crash replay', () => {
  test('an entry persisted but never finished replays on boot', () => {
    queue.enqueue(activity('a1', 'unprocessed'))
    const pending = new IngressQueue(dir).pending()
    expect(pending).toHaveLength(1)
    expect(pending[0].rawActivity.text).toBe('unprocessed')
  })

  test('a finished entry does not replay', () => {
    queue.enqueue(activity('a1'))
    queue.finish('a1')
    expect(new IngressQueue(dir).pending()).toHaveLength(0)
  })

  test('crash between ack and process: only the unfinished entry replays', () => {
    queue.enqueue(activity('a1', 'done'))
    queue.enqueue(activity('a2', 'interrupted'))
    queue.finish('a1') // a2 was mid-flight when the process died
    const pending = new IngressQueue(dir).pending()
    expect(pending.map(p => p.rawActivity.text)).toEqual(['interrupted'])
  })

  test('replay is ordered oldest-first', () => {
    queue.enqueue({ ...activity('a1'), id: 'a1' })
    queue.enqueue({ ...activity('a2'), id: 'a2' })
    const order = queue.pending().map(p => p.rawActivity.id)
    expect(order).toEqual(['a1', 'a2'])
  })

  test('a corrupt entry is skipped rather than wedging boot', () => {
    queue.enqueue(activity('good'))
    Bun.write(join(dir, entryFilename('corrupt')), '{not json')
    expect(queue.pending().map(p => p.rawActivity.id)).toEqual(['good'])
  })
})

describe('failed append', () => {
  test('an unwritable queue dir throws so the caller can reject the webhook', () => {
    chmodSync(dir, 0o500) // read+execute, no write
    expect(() => queue.enqueue(activity('a1'))).toThrow()
  })

  test('a failed append leaves no entry behind', () => {
    chmodSync(dir, 0o500)
    try {
      queue.enqueue(activity('a1'))
    } catch {}
    chmodSync(dir, 0o700)
    expect(queue.pending()).toHaveLength(0)
  })
})

describe('tombstone pruning', () => {
  test('a fresh tombstone is kept', () => {
    queue.enqueue(activity('a1'))
    queue.finish('a1')
    expect(queue.pruneTombstones()).toBe(0)
    expect(queue.enqueue(activity('a1'))).toBe(false)
  })

  test('an expired tombstone is pruned and the id becomes acceptable again', () => {
    queue.enqueue(activity('a1'))
    queue.finish('a1')
    expect(queue.pruneTombstones(Date.now() + TOMBSTONE_TTL_MS + 1000)).toBe(1)
    expect(queue.enqueue(activity('a1'))).toBe(true)
  })

  test('pruning never removes a pending entry', () => {
    queue.enqueue(activity('a1'))
    expect(queue.pruneTombstones(Date.now() + TOMBSTONE_TTL_MS * 10)).toBe(0)
    expect(queue.pending()).toHaveLength(1)
  })
})

describe('filename safety', () => {
  test('ids with path separators and colons cannot escape the queue dir', () => {
    const name = entryFilename('../../etc/passwd:1;messageid=2')
    expect(name).not.toContain('/')
    expect(name).not.toContain('..')
    queue.enqueue(activity('../../etc/passwd:1'))
    expect(readdirSync(dir).every(f => !f.includes('/'))).toBe(true)
  })

  test('two different long ids sharing a prefix do not collide', () => {
    const a = 'x'.repeat(80) + 'A'
    const b = 'x'.repeat(80) + 'B'
    expect(entryFilename(a)).not.toBe(entryFilename(b))
  })
})
