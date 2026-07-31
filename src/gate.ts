/**
 * Inbound gate: decides whether an activity is allowed to reach the session.
 *
 * Identity rules, adapted from OpenClaw's msteams access handling (MIT,
 * 32b2e161a5a) and the official telegram plugin's access model:
 *
 *   - Senders are matched on **AAD object id only**. Display names are
 *     attacker-controlled and never grant access.
 *   - Conversation ids are normalized before comparison — Teams appends
 *     `;messageid=…` for thread scoping, so the raw id is not stable.
 *   - Group chats and channels are opt-in, and gated on an explicit @mention of
 *     the bot unless the operator disables that.
 *
 * The same predicate backs the OUTBOUND gate: a reply may only target a
 * conversation this gate would have accepted inbound. That is what stops a
 * malicious message from talking the bot into posting somewhere new.
 */

export type ConversationType = 'personal' | 'groupChat' | 'channel'

/**
 * Per-conversation policy for a group chat or channel, keyed on the normalized
 * conversation id. Shape matches discord's `groups` and telegram's equivalent.
 *
 * **`allowFrom: []` means anyone in that conversation may speak to the bot** —
 * it does not fall back to the top-level `allowFrom`. That is deliberate and it
 * is how both official plugins behave: opting a channel in is itself the trust
 * decision, because requiring every colleague to separately pair by DM would
 * make a shared channel unusable. Narrow it by listing AAD object ids here.
 */
export type GroupPolicy = {
  /** Require an @mention of the bot in this conversation. */
  requireMention: boolean
  /** Lowercased AAD object ids. Empty = any sender in this conversation. */
  allowFrom: string[]
}

/**
 * A pairing code awaiting `/msteams:access pair`. Defined here rather than in
 * access.ts: access.ts already imports Access from this file, and a type import
 * in the other direction would make gate.ts — meant to stay the pure half —
 * depend back on the stateful one.
 */
export type PendingEntry = {
  senderId: string
  /**
   * The DM conversation id to confirm into. Teams personal conversation ids are
   * distinct from the sender's AAD object id, so — exactly as discord does for
   * its DM channel ids — it has to be stashed at issue time. By the time the
   * approval file appears, `pending` has already been cleared.
   */
  conversationId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type Access = {
  /** How unknown senders are treated in 1:1 chats. */
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  /** Lowercased AAD object ids allowed to DM the bot. */
  allowFrom: string[]
  /** Opted-in group chats and channels, keyed on normalized conversation id. */
  groups: Record<string, GroupPolicy>
  /** Live pairing codes, keyed by code. Managed by src/access.ts. */
  pending: Record<string, PendingEntry>
  /** Extra regexes that count as addressing the bot, beyond a real @mention. */
  mentionPatterns?: string[]
}

export const DEFAULT_ACCESS: Access = {
  dmPolicy: 'pairing',
  allowFrom: [],
  groups: {},
  pending: {},
}

export type GateVerdict =
  | { allowed: true }
  | { allowed: false; reason: GateReason }

export type GateReason =
  | 'tenant_mismatch'
  | 'no_sender_identity'
  | 'sender_not_allowed'
  | 'dm_disabled'
  | 'conversation_not_opted_in'
  | 'mention_required'

/**
 * Teams scopes channel replies by suffixing the conversation id with
 * `;messageid=<id>`. Strip it so a thread and its parent resolve to the same
 * conversation for access decisions. Case is preserved — these ids are opaque
 * and case-sensitive.
 */
export function normalizeConversationId(id: string): string {
  const semi = id.indexOf(';')
  return semi === -1 ? id : id.slice(0, semi)
}

/**
 * The thread a channel activity belongs to, or undefined outside channels.
 *
 * Teams does not populate `activity.replyToId` for channel posts — verified
 * against a live tenant, where a thread root and a reply inside it both omitted
 * the key entirely and carried the SAME `conversation.id` ending
 * `;messageid=<root>`.
 * So the thread identity lives in the conversation id, and `replyToId` is only
 * a fallback for shapes that do set it. Precedence matches OpenClaw
 * (MIT, 32b2e161a5a — `extensions/msteams/src/monitor.ts:691`).
 *
 * Consequence for replies: thread on THIS value, never on `activity.id`. A
 * reply's own id is not a thread root, and sending to it would open a new
 * thread instead of continuing the one being answered.
 */
export function extractThreadId(
  rawConversationId: string,
  conversationType: ConversationType,
  replyToId?: string,
): string | undefined {
  if (conversationType.toLowerCase() !== 'channel') return undefined
  const match = /(?:^|;)messageid=([^;]+)/i.exec(rawConversationId)
  return match?.[1]?.trim() || replyToId || undefined
}

/** AAD object ids are case-insensitive GUIDs; compare them lowercased. */
export function normalizeSenderId(aadObjectId: string): string {
  return aadObjectId.trim().toLowerCase()
}

/**
 * Membership test for an allowlist of AAD object ids.
 *
 * Both sides are normalized, not just the incoming activity: a GUID copied from
 * the Azure portal or typed by hand can carry any case, and an allowlist entry
 * that silently never matches is a lockout the operator cannot see.
 */
function includesSender(list: string[], sender: string): boolean {
  return list.some(entry => normalizeSenderId(entry) === sender)
}

export type GateInput = {
  tenantId?: string
  conversationId: string
  conversationType: ConversationType
  senderAadObjectId?: string
  /** True when the bot was @mentioned in this activity. */
  mentionsBot: boolean
}

export function gate(input: GateInput, access: Access, configuredTenantId: string): GateVerdict {
  // Tenant boundary first: a single-tenant registration should never process an
  // activity claiming a different tenant, whatever else it says.
  if (!input.tenantId || input.tenantId.toLowerCase() !== configuredTenantId.toLowerCase()) {
    return { allowed: false, reason: 'tenant_mismatch' }
  }

  if (!input.senderAadObjectId) {
    // No AAD object id means an unauthenticated or federated principal we
    // cannot pin an identity to. Refuse rather than fall back to a name.
    return { allowed: false, reason: 'no_sender_identity' }
  }
  // 'disabled' is a global kill switch, not just a DM setting — it drops
  // channels and allowlisted senders too. Named for the common case but
  // deliberately total, matching discord and telegram: an operator reaching for
  // it wants the bot off, and a kill switch that left channels answering would
  // fail in the dangerous direction.
  if (access.dmPolicy === 'disabled') return { allowed: false, reason: 'dm_disabled' }

  const sender = normalizeSenderId(input.senderAadObjectId)
  const senderAllowed = includesSender(access.allowFrom, sender)

  if (input.conversationType === 'personal') {
    // Under 'pairing' an unknown sender is still refused here; the pairing
    // handshake runs alongside the gate and adds them to allowFrom on approval.
    return senderAllowed ? { allowed: true } : { allowed: false, reason: 'sender_not_allowed' }
  }

  // Group chat or channel. The conversation must be opted in; who may speak in
  // it is then that conversation's own business (see GroupPolicy).
  const conversation = normalizeConversationId(input.conversationId)
  const policy = access.groups[conversation]
  if (!policy) return { allowed: false, reason: 'conversation_not_opted_in' }

  const groupAllowFrom = policy.allowFrom ?? []
  if (groupAllowFrom.length > 0 && !includesSender(groupAllowFrom, sender)) {
    return { allowed: false, reason: 'sender_not_allowed' }
  }
  if ((policy.requireMention ?? true) && !input.mentionsBot) {
    return { allowed: false, reason: 'mention_required' }
  }
  return { allowed: true }
}

type MentionEntity = { type?: string; mentioned?: { id?: string } }

/**
 * Whether this activity addresses the bot.
 *
 * A real mention counts only when the mentioned id is the bot's own id (the
 * activity `recipient.id`) — matching on the display name would let anyone
 * trigger the bot by typing its name as plain text.
 *
 * `extraPatterns` widens that: operator-supplied regexes tested against the
 * message text, for teams who would rather write "claude, ..." than @-mention.
 * They come from access.json, which only the operator can edit from a terminal,
 * so they are trusted input; an invalid pattern is skipped rather than thrown,
 * matching discord's `isMentioned`.
 */
export function mentionsBot(
  entities: unknown,
  recipientId: string | undefined,
  text?: string,
  extraPatterns?: string[],
): boolean {
  if (
    Array.isArray(entities) &&
    recipientId &&
    entities.some((e: MentionEntity) => e?.type === 'mention' && e?.mentioned?.id === recipientId)
  ) {
    return true
  }

  if (!text) return false
  for (const pattern of extraPatterns ?? []) {
    try {
      if (new RegExp(pattern, 'i').test(text)) return true
    } catch {
      // A malformed regex disables that one pattern, not the whole gate.
    }
  }
  return false
}
