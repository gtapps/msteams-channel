/**
 * Persist-before-ack ingress queue ("lite").
 *
 * Contract, adapted from OpenClaw's msteams ingress (MIT, commit 32b2e161a5a)
 * but reimplemented over plain files rather than its plugin-sdk queue:
 *
 *   1. The raw activity is written to disk BEFORE the webhook is acked. If the
 *      write fails we reject the webhook so Bot Framework retries.
 *   2. Redeliveries are deduped by `activity.id`.
 *   3. Anything persisted but not finished replays on boot, without needing a
 *      live turn context.
 *
 * Accepted gap: while the listener is down, messages are lost — Bot Framework
 * retries are shallow. The consumer is an always-on session, so the window is
 * restart-sized.
 *
 * One file per activity. A pending entry holds the full activity; a finished
 * one is replaced by a small tombstone so dedup still works after a restart
 * without the directory growing without bound.
 */

import { readdirSync, readFileSync, writeFileSync, renameSync, statSync, rmSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'

export const QUEUE_VERSION = 1

/** How long a tombstone keeps suppressing redeliveries of the same activity. */
export const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000

export type QueueEntry = {
  version: number
  receivedAt: string
  rawActivity: Record<string, unknown>
}

type Tombstone = { version: number; done: true; at: string }

/**
 * Activity ids contain characters that are not filename-safe (`:` `/` `=`).
 * Slug for readability, hash for collision-freedom.
 */
export function entryFilename(activityId: string): string {
  const slug = activityId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)
  const hash = createHash('sha256').update(activityId).digest('hex').slice(0, 16)
  return `${slug}.${hash}.json`
}

function isTombstone(parsed: unknown): parsed is Tombstone {
  return typeof parsed === 'object' && parsed !== null && (parsed as Tombstone).done === true
}

export class IngressQueue {
  constructor(private readonly dir: string) {}

  private pathFor(activityId: string): string {
    return join(this.dir, entryFilename(activityId))
  }

  /**
   * Persist an activity. Returns false when this id was already seen (pending
   * or recently finished) — the caller should ack without reprocessing.
   *
   * Throws if the write fails. Callers MUST let that propagate into a non-2xx
   * webhook response: a swallowed failure is a silently dropped message.
   */
  enqueue(activity: Record<string, unknown>): boolean {
    const id = String(activity.id ?? '')
    if (!id) throw new Error('activity has no id; cannot dedup')

    const target = this.pathFor(id)
    try {
      statSync(target)
      return false // pending or tombstoned — duplicate delivery
    } catch {}

    const entry: QueueEntry = {
      version: QUEUE_VERSION,
      receivedAt: new Date().toISOString(),
      rawActivity: activity,
    }
    this.writeAtomic(target, entry)
    return true
  }

  /** Replace a finished entry with a tombstone so redeliveries stay deduped. */
  finish(activityId: string): void {
    const tombstone: Tombstone = { version: QUEUE_VERSION, done: true, at: new Date().toISOString() }
    this.writeAtomic(this.pathFor(activityId), tombstone)
  }

  /**
   * Write to a temp name then rename: a crash mid-write must not leave a
   * half-written entry that replay would choke on.
   */
  private writeAtomic(target: string, data: unknown): void {
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
    renameSync(tmp, target)
  }

  /** Entries persisted but never finished — replayed on boot. */
  pending(): QueueEntry[] {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return []
    }
    const out: QueueEntry[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(readFileSync(join(this.dir, name), 'utf8'))
        if (isTombstone(parsed)) continue
        if (parsed?.version === QUEUE_VERSION && parsed.rawActivity) out.push(parsed as QueueEntry)
      } catch {
        // Unreadable/corrupt entry: skip it rather than wedging boot.
      }
    }
    return out.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
  }

  /** Drop tombstones past the dedup window. Safe to call on boot. */
  pruneTombstones(now = Date.now(), ttlMs = TOMBSTONE_TTL_MS): number {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return 0
    }
    let pruned = 0
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const full = join(this.dir, name)
      try {
        const parsed = JSON.parse(readFileSync(full, 'utf8'))
        if (!isTombstone(parsed)) continue
        if (now - Date.parse(parsed.at) > ttlMs) {
          rmSync(full)
          pruned++
        }
      } catch {}
    }
    return pruned
  }
}
