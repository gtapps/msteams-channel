/**
 * Permission-relay grammar and pending-request bookkeeping.
 *
 * Split out of server.ts so the two security-relevant properties — what counts
 * as a verdict, and that a verdict fires at most once — are unit-testable
 * without a live tenant.
 */

/**
 * From the same spec the official plugins inline (anthropics/claude-cli-internal
 * `src/services/mcp/channelPermissions.ts`): five lowercase letters with 'l'
 * excluded so it cannot be misread as '1'. Case-insensitive, because phone
 * keyboards capitalize the first word.
 *
 * Anchored at both ends deliberately. A bare "yes", or "yes do it abcde", is
 * conversation and must reach the session as chat — silently swallowing it as a
 * verdict would be both a lost message and an unintended approval.
 */
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

export type Verdict = { requestId: string; behavior: 'allow' | 'deny' }

/** Parse a message as a permission verdict, or undefined if it is just chat. */
export function parseVerdict(text: string): Verdict | undefined {
  const m = PERMISSION_REPLY_RE.exec(text)
  if (!m) return undefined
  return {
    requestId: m[2]!.toLowerCase(),
    behavior: m[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
  }
}

/**
 * Live permission requests awaiting a verdict.
 *
 * `take` is the one-shot gate: it returns true at most once per request id, so
 * a duplicate Bot Framework redelivery, or the sender simply typing the same
 * answer twice, cannot emit a second verdict for the same request.
 */
export class PendingPermissions {
  private readonly live = new Map<string, { toolName: string }>()

  add(requestId: string, toolName: string): void {
    this.live.set(requestId, { toolName })
  }

  /** Claim a request. True only for the first caller. */
  take(requestId: string): boolean {
    return this.live.delete(requestId)
  }

  get size(): number {
    return this.live.size
  }
}
