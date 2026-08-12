import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  PendingUploadStore,
  PENDING_UPLOAD_TTL_MS,
  MAX_PENDING_UPLOADS,
  MAX_PENDING_TOTAL_BYTES,
} from '../src/pending-uploads.js'

let dir: string
let store: PendingUploadStore

const CONV = '19:abc@thread.tacv2'

function offer(bytes = Buffer.from('hello'), conversationId = CONV, now?: number): string {
  return store.store(
    { bytes, filename: 'report.pdf', contentType: 'application/pdf', conversationId },
    now,
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'msteams-pending-'))
  store = new PendingUploadStore(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('store and claim', () => {
  test('the claimed bytes are exactly the bytes offered', () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff])
    const id = offer(bytes)

    const claimed = store.claim(id, CONV)

    expect(claimed?.bytes).toEqual(bytes)
    expect(claimed?.meta.filename).toBe('report.pdf')
    expect(claimed?.meta.contentType).toBe('application/pdf')
  })

  test('a snapshot survives the source file changing', () => {
    // The whole point of storing bytes rather than a path.
    const id = offer(Buffer.from('original'))
    expect(store.claim(id, CONV)?.bytes.toString()).toBe('original')
  })

  test('the conversation id is normalized on both sides', () => {
    // Teams appends ;messageid= to the invoke's conversation id.
    const id = offer(Buffer.from('x'), CONV)
    expect(store.claim(id, `${CONV};messageid=1700000000000`)).toBeDefined()
  })

  test('claiming twice yields bytes exactly once', () => {
    // This is the at-most-once guarantee: Teams can deliver the same Accept
    // twice, and the second delivery must not upload the file again.
    const id = offer()

    expect(store.claim(id, CONV)).toBeDefined()
    expect(store.claim(id, CONV)).toBeUndefined()
  })

  test('concurrent claims yield exactly one owner', async () => {
    const id = offer()

    const results = await Promise.all(
      Array.from({ length: 5 }, async () => store.claim(id, CONV)),
    )

    expect(results.filter(Boolean)).toHaveLength(1)
  })

  test('a claim from another conversation gets nothing and cancels nothing', () => {
    // A replayed invoke from elsewhere must not consume the offer: the real
    // recipient's Accept has to keep working.
    const id = offer()

    expect(store.claim(id, '19:someone-else@thread.tacv2')).toBeUndefined()
    expect(store.claim(id, CONV)).toBeDefined()
  })

  test('an expired offer cannot be claimed and takes its bytes with it', () => {
    const id = offer(Buffer.from('x'), CONV, 1_000)

    expect(store.claim(id, CONV, 1_000 + PENDING_UPLOAD_TTL_MS + 1)).toBeUndefined()
    expect(readdirSync(dir)).toHaveLength(0)
  })

  test('metadata without bytes is dropped rather than half-claimed', () => {
    const id = offer()
    rmSync(join(dir, `${id}.bin`))

    expect(store.claim(id, CONV)).toBeUndefined()
    expect(readdirSync(dir)).toHaveLength(0)
  })

  test('corrupt metadata is unclaimable', () => {
    const id = offer()
    writeFileSync(join(dir, `${id}.json`), 'not json')

    expect(store.claim(id, CONV)).toBeUndefined()
  })

  test('an id that is not one of ours never touches the disk', () => {
    for (const hostile of ['../escape', 'ABC', 'short', '', 'a'.repeat(32) + '/x']) {
      expect(store.claim(hostile, CONV)).toBeUndefined()
      expect(() => store.settle(hostile)).not.toThrow()
    }
  })

  test('records are 0600 — they hold outbound file contents', () => {
    const id = offer()

    for (const name of [`${id}.json`, `${id}.bin`]) {
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600)
    }
  })
})

describe('caps refuse rather than evict', () => {
  test('a full store refuses the new offer and keeps every existing one', () => {
    // Evicting the oldest would leave its consent card visible in a chat with
    // nothing behind it — the recipient clicks Accept and gets an error.
    const ids = Array.from({ length: MAX_PENDING_UPLOADS }, () => offer(Buffer.from('x')))

    expect(() => offer(Buffer.from('x'))).toThrow(/awaiting Accept/)
    for (const id of ids) expect(readdirSync(dir)).toContain(`${id}.json`)
  })

  test('the byte cap refuses too', () => {
    const big = Buffer.alloc(MAX_PENDING_TOTAL_BYTES / 4)
    for (let i = 0; i < 4; i++) offer(big)

    expect(() => offer(Buffer.from('x'))).toThrow(/pending file offers already hold/)
  })

  test('expired records free their slot', () => {
    for (let i = 0; i < MAX_PENDING_UPLOADS; i++) offer(Buffer.from('x'), CONV, 1_000)

    const later = 1_000 + PENDING_UPLOAD_TTL_MS + 1
    expect(() => offer(Buffer.from('x'), CONV, later)).not.toThrow()
  })
})

describe('prune', () => {
  test('a claim that never finished is not a permanent leak', () => {
    // A crash mid-upload leaves <id>.json.claimed, which nothing can claim and
    // nothing else deletes — with its snapshot still on disk.
    const id = offer(Buffer.alloc(1024), CONV, 1_000)
    store.claim(id, CONV, 1_000)
    expect(readdirSync(dir)).toContain(`${id}.json.claimed`)

    store.prune(1_000 + PENDING_UPLOAD_TTL_MS + 1)

    expect(readdirSync(dir)).toHaveLength(0)
  })

  test('a claim in flight is left alone', () => {
    const id = offer(Buffer.from('x'), CONV, 1_000)
    store.claim(id, CONV, 1_000)

    store.prune(1_000 + 60_000)

    expect(readdirSync(dir)).toContain(`${id}.json.claimed`)
  })

  test('bytes with no metadata are collected', () => {
    writeFileSync(join(dir, `${'a'.repeat(32)}.bin`), 'orphaned')

    store.prune()

    expect(readdirSync(dir)).toHaveLength(0)
  })

  test('a live record is untouched', () => {
    const id = offer()

    store.prune()

    expect(store.claim(id, CONV)).toBeDefined()
  })
})

describe('setConsentCardActivityId', () => {
  test('roundtrips so the upload can replace the card in place', () => {
    const id = offer()

    store.setConsentCardActivityId(id, 'activity-42')

    expect(store.claim(id, CONV)?.meta.consentCardActivityId).toBe('activity-42')
  })

  test('is a no-op once the record is gone', () => {
    const id = offer()
    store.settle(id)

    expect(() => store.setConsentCardActivityId(id, 'activity-42')).not.toThrow()
    expect(readdirSync(dir)).toHaveLength(0)
  })
})

describe('settle', () => {
  test('removes everything and is safe to repeat', () => {
    const id = offer()

    store.settle(id)
    store.settle(id)

    expect(readdirSync(dir)).toHaveLength(0)
  })
})
