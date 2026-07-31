/**
 * Reactions, via Microsoft Graph.
 *
 * Bot Framework has no "react to a message" activity, so this is the one MVP
 * feature that has to go through Graph — and Graph makes it awkward in three
 * ways, each verified rather than assumed:
 *
 * 1. **`setReaction` is beta only.** Not in v1.0.
 * 2. **A channel message is not addressed by conversation id.** Graph wants
 *    `/teams/{teamId}/channels/{channelId}/messages/{id}`, which the Bot
 *    Framework conversation id cannot produce — hence the ids captured on the
 *    conversation reference. Chats use `/chats/{id}/messages/{id}`.
 *    (OpenClaw MIT 32b2e161a5a, `graph-messages.ts:97` resolveConversationPath.)
 * 3. **Writes require a *delegated* token.** OpenClaw passes
 *    `preferDelegated: true` for exactly this call. We authenticate with
 *    single-tenant client credentials — an *application* token — and delegated
 *    auth is explicitly out of MVP scope. So this may be unavailable no matter
 *    what the operator grants, which is why the failure text says so instead of
 *    only naming a permission to add.
 *
 * Everything here degrades: a hermit that cannot add a thumbs-up is mildly
 * worse; one that fails to reply is broken.
 */

import { normalizeConversationId } from './gate.js'

export type ReactResult = { ok: true } | { ok: false; reason: string }

/** Graph's own names. Anything else is rejected before a request is made. */
export const GRAPH_REACTIONS = ['like', 'angry', 'sad', 'laugh', 'heart', 'surprised'] as const
export type GraphReaction = (typeof GRAPH_REACTIONS)[number]

export function isGraphReaction(value: string): value is GraphReaction {
  return (GRAPH_REACTIONS as readonly string[]).includes(value)
}

/**
 * The slice of the SDK's GraphClient we use — `@microsoft/teams.graph`'s
 * `Client`, whose `.http` is an axios-style client "pre-configured with Graph
 * base URL and headers". It has no `.api()`; an earlier version of this file
 * assumed the Microsoft Graph JS SDK's fluent shape and failed at runtime.
 */
export type GraphLike = {
  http: {
    post(url: string, data?: unknown, config?: unknown): Promise<{ status?: number }>
  }
}

/** Where a message lives, in Graph's addressing rather than Bot Framework's. */
export function reactionEndpoint(
  target: { conversationId: string; teamId?: string; channelId?: string },
  messageId: string,
): string {
  const base =
    target.teamId && target.channelId
      ? `/teams/${encodeURIComponent(target.teamId)}/channels/${encodeURIComponent(target.channelId)}`
      : `/chats/${encodeURIComponent(normalizeConversationId(target.conversationId))}`
  // Beta: setReaction does not exist in v1.0.
  return `https://graph.microsoft.com/beta${base}/messages/${encodeURIComponent(messageId)}/setReaction`
}

export async function react(
  graph: GraphLike,
  target: { conversationId: string; teamId?: string; channelId?: string },
  messageId: string,
  reaction: string,
): Promise<ReactResult> {
  if (!isGraphReaction(reaction)) {
    return { ok: false, reason: `Teams only accepts these reactions: ${GRAPH_REACTIONS.join(', ')}` }
  }
  if (!messageId) return { ok: false, reason: 'message_id is required' }

  try {
    await graph.http.post(reactionEndpoint(target, messageId), { reactionType: reaction })
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: describeGraphFailure(err) }
  }
}

/**
 * Turn a Graph error into something the operator can act on.
 *
 * The status is read from the error object when present — axios puts it on
 * `response.status` — and only falls back to scraping the message, because a
 * message that happens to contain a number is not a status code.
 */
export function describeGraphFailure(err: unknown): string {
  const response = (err as { response?: { status?: number } })?.response
  const message = err instanceof Error ? err.message : String(err)
  const status = response?.status ?? Number(/\b(40[0-9]|50[0-9])\b/.exec(message)?.[1])

  if (status === 401 || status === 403) {
    return (
      'reactions were refused. Graph requires a delegated (signed-in user) token to set a ' +
      'reaction, and this channel authenticates as the application — so this may not be ' +
      'available at all until delegated auth is supported. If you want to try anyway, grant ' +
      'ChatMessage.ReadWrite.All (application) in Entra and admin-consent it. Everything else ' +
      'in this channel works without reactions.'
    )
  }
  if (status === 404) {
    return 'that message could not be found — it may be too old, or in a conversation the app cannot read'
  }
  return `reaction failed: ${message}`
}
