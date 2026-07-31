/**
 * Conversation-reference store.
 *
 * A proactive send (a notice, or any reply outside a live turn) needs the
 * conversation reference Teams handed us on a previous inbound activity. We
 * upsert on every accepted inbound so the newest service URL wins.
 *
 * This format is INTERNAL. The `send` CLI in this repo reads it; nothing
 * outside this repo may parse it — consumers shell out to the CLI instead, so
 * the shape stays free to change.
 */

import { readFileSync, writeFileSync, renameSync, readdirSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { normalizeConversationId, normalizeSenderId } from './gate.js'

export const CONVERSATION_VERSION = 1

export type ConversationRef = {
  version: number
  conversationId: string
  conversationType: string
  tenantId: string
  serviceUrl: string
  botId?: string
  botName?: string
  /**
   * Channels only. Graph addresses a channel message as
   * `/teams/{teamId}/channels/{channelId}/messages/...`, which the Bot
   * Framework conversation id alone cannot produce — so capture both while the
   * activity is in front of us.
   */
  teamId?: string
  channelId?: string
  /**
   * 1:1 chats only: the AAD object id on the other end, lowercased.
   *
   * The permission relay has to find "the DM belonging to this allowlisted
   * sender", and a Teams personal conversation id is not derivable from an AAD
   * object id. Recorded only for `personal` conversations — in a group the
   * sender is whoever spoke last, which would be meaningless here.
   */
  senderId?: string
  updatedAt: string
}

function fileFor(dir: string, conversationId: string): string {
  const hash = createHash('sha256').update(conversationId).digest('hex').slice(0, 32)
  return join(dir, `${hash}.json`)
}

export class ConversationStore {
  constructor(private readonly dir: string) {}

  upsert(activity: Record<string, any>): ConversationRef | undefined {
    const rawId = String(activity.conversation?.id ?? '')
    if (!rawId) return undefined
    const conversationId = normalizeConversationId(rawId)
    const conversationType = String(activity.conversation?.conversationType ?? 'personal')
    const ref: ConversationRef = {
      version: CONVERSATION_VERSION,
      conversationId,
      conversationType,
      tenantId: String(activity.channelData?.tenant?.id ?? activity.conversation?.tenantId ?? ''),
      serviceUrl: String(activity.serviceUrl ?? ''),
      botId: activity.recipient?.id ? String(activity.recipient.id) : undefined,
      botName: activity.recipient?.name ? String(activity.recipient.name) : undefined,
      teamId: activity.channelData?.team?.aadGroupId
        ? String(activity.channelData.team.aadGroupId)
        : undefined,
      channelId: activity.channelData?.teamsChannelId
        ? String(activity.channelData.teamsChannelId)
        : undefined,
      senderId:
        conversationType === 'personal' && activity.from?.aadObjectId
          ? normalizeSenderId(String(activity.from.aadObjectId))
          : undefined,
      updatedAt: new Date().toISOString(),
    }
    const target = fileFor(this.dir, conversationId)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(ref, null, 2), { mode: 0o600 })
    renameSync(tmp, target)
    return ref
  }

  get(conversationId: string): ConversationRef | undefined {
    try {
      const parsed = JSON.parse(
        readFileSync(fileFor(this.dir, normalizeConversationId(conversationId)), 'utf8'),
      )
      return parsed?.version === CONVERSATION_VERSION ? (parsed as ConversationRef) : undefined
    } catch {
      return undefined
    }
  }

  list(): ConversationRef[] {
    try {
      return readdirSync(this.dir)
        .filter(n => n.endsWith('.json'))
        .map(n => {
          try {
            return JSON.parse(readFileSync(join(this.dir, n), 'utf8'))
          } catch {
            return undefined
          }
        })
        .filter((r): r is ConversationRef => r?.version === CONVERSATION_VERSION)
    } catch {
      return []
    }
  }
}
