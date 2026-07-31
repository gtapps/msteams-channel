/**
 * Reactions, via Microsoft Graph.
 *
 * Reactions are the one MVP feature Bot Framework cannot do: there is no
 * activity for "react to a message", only Graph's `setReaction` on
 * chats/teams messages, which is **beta** and needs an admin-granted
 * application permission (`ChatMessage.ReadWrite.All` or
 * `TeamworkAppSettings.ReadWrite.All` depending on scope).
 *
 * So this is written to degrade, per the plan: if consent is absent, `react`
 * returns a message naming what to grant and nothing else breaks. A hermit
 * that cannot add a thumbs-up is mildly worse; one that fails to reply because
 * an unrelated Graph scope is missing is broken.
 */

import { normalizeConversationId } from './gate.js'

export type ReactResult = { ok: true } | { ok: false; reason: string }

/** Graph's own names. Teams renders anything else as a generic reaction. */
export const GRAPH_REACTIONS = ['like', 'angry', 'sad', 'laugh', 'heart', 'surprised'] as const
export type GraphReaction = (typeof GRAPH_REACTIONS)[number]

export function isGraphReaction(value: string): value is GraphReaction {
  return (GRAPH_REACTIONS as readonly string[]).includes(value)
}

/**
 * A conversation id tells us which Graph collection the message lives in.
 * Channel threads are `19:...@thread.tacv2` and belong to a team; personal and
 * group chats are addressed as chats.
 */
export function reactionEndpoint(conversationId: string, messageId: string): string {
  const conversation = normalizeConversationId(conversationId)
  return `/chats/${encodeURIComponent(conversation)}/messages/${encodeURIComponent(messageId)}/setReaction`
}

/**
 * The slice of the SDK's GraphClient this needs. Structural rather than the
 * SDK type so a test can pass a fake and drive the failure paths, which are
 * the paths that actually matter here.
 */
export type GraphLike = {
  api(path: string): { post(body: unknown): Promise<unknown> }
}

/**
 * `graph` is the SDK's GraphClient (`app.graph`), which already carries the
 * app's client-credentials token — we deliberately do not mint our own.
 */
export async function react(
  graph: GraphLike,
  conversationId: string,
  messageId: string,
  reaction: string,
): Promise<ReactResult> {
  if (!isGraphReaction(reaction)) {
    return {
      ok: false,
      reason: `Teams only accepts these reactions: ${GRAPH_REACTIONS.join(', ')}`,
    }
  }

  try {
    await graph.api(reactionEndpoint(conversationId, messageId)).post({ reactionType: reaction })
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: describeGraphFailure(err) }
  }
}

/**
 * Turn a Graph error into something the operator can act on. A 403 here almost
 * always means the app registration lacks the permission rather than anything
 * being wrong with the request, and saying so saves a long debugging detour.
 */
export function describeGraphFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const status = /\b(40[13]|404)\b/.exec(message)?.[1]

  if (status === '401' || status === '403') {
    return (
      'reactions need a Graph permission this app registration does not have. Grant ' +
      'ChatMessage.ReadWrite.All (application) in Entra and admin-consent it. Everything ' +
      'else in this channel keeps working without it.'
    )
  }
  if (status === '404') {
    return 'that message could not be found — it may be too old, or in a conversation the app cannot read'
  }
  return `reaction failed: ${message}`
}
