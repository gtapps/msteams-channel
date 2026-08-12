/**
 * Outbound files awaiting the recipient's Accept.
 *
 * Teams' FileConsentCard flow is asynchronous: the bot offers a file, the
 * recipient clicks Accept some minutes later, and only then does Teams hand
 * back an upload URL. The bytes have to survive that gap on disk, not in
 * memory, for two reasons:
 *
 *   1. `send.ts` posts the card and exits — the `fileConsent/invoke` is
 *      delivered to the long-running server, a different process entirely.
 *   2. A restart between offer and Accept must not strand a consent card that
 *      is still sitting in someone's chat.
 *
 * Snapshotting the bytes rather than re-reading the path at Accept time is
 * deliberate: what gets uploaded is exactly what Claude offered, even if the
 * source file changed or was deleted meanwhile.
 *
 * Only our own outbound bytes live here. Nothing from the invoke is ever
 * persisted — `uploadInfo.uploadUrl` is a live upload credential (CLAUDE.md).
 *
 * Layout, one record per offer:
 *   <id>.json          metadata, written last: its presence is the commit
 *   <id>.json.claimed  the same metadata, renamed by claim() — see below
 *   <id>.bin           the snapshot
 */

import { randomBytes } from 'crypto'
import { readdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { normalizeConversationId } from './gate.js'

export const PENDING_UPLOAD_VERSION = 1

/**
 * How long an offer stays claimable. An hour rather than OpenClaw's five
 * minutes: their bound is storage pressure, ours is a human who stepped away
 * from Teams and comes back to a card that must still work.
 */
export const PENDING_UPLOAD_TTL_MS = 60 * 60 * 1000

/**
 * Caps are refusals, never evictions. Dropping the oldest record to make room
 * would leave its consent card visible in a chat with nothing behind it, so a
 * new offer fails loudly instead — the sender can see that and act.
 */
export const MAX_PENDING_UPLOADS = 20
export const MAX_PENDING_TOTAL_BYTES = 500 * 1024 * 1024

export type PendingUpload = {
  version: number
  id: string
  filename: string
  contentType: string
  /** Normalized: the invoke's conversation id carries a `;messageid=` suffix. */
  conversationId: string
  /** Set once the card is posted, so the upload can replace it in place. */
  consentCardActivityId?: string
  createdAt: number
  byteLength: number
}

/** Ids are opaque tokens echoed back by Teams — never trust one as a path. */
const ID_RE = /^[a-f0-9]{32}$/

export class PendingUploadStore {
  constructor(
    private readonly dir: string,
    private readonly ttlMs = PENDING_UPLOAD_TTL_MS,
  ) {}

  private metaPath(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  private claimedPath(id: string): string {
    return join(this.dir, `${id}.json.claimed`)
  }

  private binPath(id: string): string {
    return join(this.dir, `${id}.bin`)
  }

  /**
   * Offer a file. Returns the id to put in the consent card's context; that id
   * is the only thing correlating a later invoke back to these bytes, so it is
   * 128 bits of randomness rather than a counter.
   */
  store(
    rec: { bytes: Buffer; filename: string; contentType: string; conversationId: string },
    now = Date.now(),
  ): string {
    const live = this.pruneAndListLive(now)
    if (live.length + 1 > MAX_PENDING_UPLOADS) {
      throw new Error(
        `cannot offer ${rec.filename}: ${live.length} file offers are already awaiting Accept ` +
          `(limit ${MAX_PENDING_UPLOADS}) — ask the recipient to accept or decline one, or wait ` +
          `for them to expire after an hour.`,
      )
    }
    const held = live.reduce((sum, meta) => sum + meta.byteLength, 0)
    if (held + rec.bytes.length > MAX_PENDING_TOTAL_BYTES) {
      throw new Error(
        `cannot offer ${rec.filename}: pending file offers already hold ` +
          `${(held / 1024 / 1024).toFixed(0)}MB (limit ` +
          `${MAX_PENDING_TOTAL_BYTES / 1024 / 1024}MB) — ask the recipient to accept or decline ` +
          `an earlier offer.`,
      )
    }

    const id = randomBytes(16).toString('hex')
    const meta: PendingUpload = {
      version: PENDING_UPLOAD_VERSION,
      id,
      filename: rec.filename,
      contentType: rec.contentType,
      conversationId: normalizeConversationId(rec.conversationId),
      createdAt: now,
      byteLength: rec.bytes.length,
    }
    // Bytes first, metadata second: a crash in between leaves an orphan .bin
    // that prune() collects, never a record pointing at bytes that do not exist.
    writeAtomic(this.binPath(id), rec.bytes)
    writeAtomic(this.metaPath(id), Buffer.from(JSON.stringify(meta)))
    return id
  }

  /**
   * Take exclusive ownership of an offer, or return undefined.
   *
   * The rename is the whole concurrency story: Teams can deliver the same
   * Accept twice (retry, double-click), and both deliveries would otherwise
   * read the record, both pass every check, and both upload. `renameSync`
   * cannot succeed twice, so exactly one caller ever gets the bytes.
   *
   * The conversation check happens BEFORE the rename on purpose. A replayed
   * invoke from another conversation must not be able to consume — and thereby
   * cancel — an offer that is still legitimately pending somewhere else.
   *
   * Undefined therefore covers, indistinguishably by design: unknown id, lost
   * race, already settled, expired, and conversation mismatch.
   */
  claim(
    id: string,
    expectedConversationId: string,
    now = Date.now(),
  ): { meta: PendingUpload; bytes: Buffer } | undefined {
    if (!ID_RE.test(id)) return undefined

    const meta = readMeta(this.metaPath(id))
    if (!meta) return undefined

    if (now - meta.createdAt > this.ttlMs) {
      this.settle(id)
      return undefined
    }
    if (meta.conversationId !== normalizeConversationId(expectedConversationId)) return undefined

    try {
      renameSync(this.metaPath(id), this.claimedPath(id))
    } catch {
      return undefined // another delivery won the race, or it just expired away
    }

    let bytes: Buffer
    try {
      bytes = readFileSync(this.binPath(id))
    } catch {
      // Metadata without bytes is unusable; drop the whole record.
      this.settle(id)
      return undefined
    }
    return { meta, bytes }
  }

  /** Drop a record and its bytes. Idempotent — settling twice is normal. */
  settle(id: string): void {
    if (!ID_RE.test(id)) return
    for (const path of [this.claimedPath(id), this.metaPath(id), this.binPath(id)]) {
      try {
        rmSync(path)
      } catch {}
    }
  }

  /**
   * Record which activity carries the consent card, so a successful upload can
   * replace that card in place instead of posting a second one.
   */
  setConsentCardActivityId(id: string, activityId: string, now = Date.now()): void {
    if (!ID_RE.test(id)) return
    const meta = readMeta(this.metaPath(id))
    if (!meta || now - meta.createdAt > this.ttlMs) return
    writeAtomic(this.metaPath(id), Buffer.from(JSON.stringify({ ...meta, consentCardActivityId: activityId })))
  }

  /** Drop expired and unusable records. Never touches a live one. */
  prune(now = Date.now()): void {
    this.pruneAndListLive(now)
  }

  /**
   * Prune, and hand back what survived.
   *
   * One scan serves both callers: `store()` needs the live set immediately
   * after pruning, and re-reading the directory it just walked would double
   * every offer's disk work for nothing.
   *
   * Claimed records are pruned on the same clock: a crash mid-upload otherwise
   * leaves `<id>.json.claimed` that nothing can claim and nothing deletes,
   * holding its snapshot (up to 100MB) on disk forever.
   */
  private pruneAndListLive(now: number): PendingUpload[] {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return []
    }

    const live = new Map<string, PendingUpload>()
    for (const name of names) {
      if (!name.endsWith('.json') && !name.endsWith('.json.claimed')) continue
      const id = name.replace(/\.json(\.claimed)?$/, '')
      const meta = readMeta(join(this.dir, name))
      // Corrupt or version-mismatched metadata can never be claimed, so it is
      // dropped rather than left holding a slot against the cap.
      if (!meta || now - meta.createdAt > this.ttlMs) {
        this.settle(id)
        continue
      }
      live.set(id, meta)
    }

    for (const name of names) {
      const full = join(this.dir, name)
      // Bytes whose metadata is gone (crash between the two writes in store(),
      // or a settle that died halfway) can never be claimed by anyone.
      if (name.endsWith('.bin') && !live.has(name.slice(0, -'.bin'.length))) {
        try {
          rmSync(full)
        } catch {}
        continue
      }
      // A half-written temp file from a crashed write. Age-checked so a
      // concurrent store() in another process is not robbed mid-write.
      if (name.endsWith('.tmp')) {
        try {
          if (now - statSync(full).mtimeMs > this.ttlMs) rmSync(full)
        } catch {}
      }
    }

    return [...live.values()]
  }
}

function readMeta(path: string): PendingUpload | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed?.version !== PENDING_UPLOAD_VERSION) return undefined
    if (typeof parsed.id !== 'string' || typeof parsed.conversationId !== 'string') return undefined
    return parsed as PendingUpload
  } catch {
    return undefined
  }
}

/** Same tmp+rename discipline as the ingress queue: no half-written record. */
function writeAtomic(target: string, data: Buffer): void {
  const tmp = `${target}.tmp`
  writeFileSync(tmp, data, { mode: 0o600 })
  renameSync(tmp, target)
}
