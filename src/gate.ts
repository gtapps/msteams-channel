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

export type Access = {
  /** How unknown senders are treated in 1:1 chats. */
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  /** Lowercased AAD object ids allowed to talk to the bot. */
  allowFrom: string[]
  /** Normalized conversation ids the operator opted in (groups/channels). */
  allowConversations: string[]
  /** Require an @mention of the bot in group/channel conversations. */
  requireMention: boolean
}

export const DEFAULT_ACCESS: Access = {
  dmPolicy: 'pairing',
  allowFrom: [],
  allowConversations: [],
  requireMention: true,
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

/** AAD object ids are case-insensitive GUIDs; compare them lowercased. */
export function normalizeSenderId(aadObjectId: string): string {
  return aadObjectId.trim().toLowerCase()
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
  const sender = normalizeSenderId(input.senderAadObjectId)
  const senderAllowed = access.allowFrom.includes(sender)

  if (input.conversationType === 'personal') {
    if (access.dmPolicy === 'disabled') return { allowed: false, reason: 'dm_disabled' }
    // Under 'pairing' an unknown sender is still refused here; the pairing
    // handshake runs alongside the gate and adds them to allowFrom on approval.
    return senderAllowed ? { allowed: true } : { allowed: false, reason: 'sender_not_allowed' }
  }

  // Group chat or channel.
  const conversation = normalizeConversationId(input.conversationId)
  if (!access.allowConversations.includes(conversation)) {
    return { allowed: false, reason: 'conversation_not_opted_in' }
  }
  if (!senderAllowed) return { allowed: false, reason: 'sender_not_allowed' }
  if (access.requireMention && !input.mentionsBot) {
    return { allowed: false, reason: 'mention_required' }
  }
  return { allowed: true }
}

type MentionEntity = { type?: string; mentioned?: { id?: string } }

/**
 * A mention counts only when the mentioned id is the bot's own id (the
 * activity `recipient.id`) — matching on the display name would let anyone
 * trigger the bot by typing its name as plain text.
 */
export function mentionsBot(entities: unknown, recipientId: string | undefined): boolean {
  if (!Array.isArray(entities) || !recipientId) return false
  return entities.some(
    (e: MentionEntity) => e?.type === 'mention' && e?.mentioned?.id === recipientId,
  )
}
