import { test, expect, describe } from 'bun:test'
import { react, describeGraphFailure, reactionEndpoint, isGraphReaction, type GraphLike } from '../src/graph.js'

/**
 * A stand-in for the SDK's GraphClient.
 *
 * Typed as `GraphLike` deliberately: the first version of this file invented a
 * `.api()` fluent shape, tested a fake that matched the invention, and passed
 * while the real call failed with "graph.api is not a function". A fake only
 * proves anything if the same type is checked where the real client is passed
 * in — which `server.ts` now does without a cast.
 */
function fakeGraph(fail?: () => never): { graph: GraphLike; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = []
  return {
    calls,
    graph: {
      http: {
        post: async (url: string, data?: unknown) => {
          calls.push({ url, body: data })
          if (fail) fail()
          return { status: 200 }
        },
      },
    },
  }
}

const CHAT = { conversationId: 'a:1personal' }
const CHANNEL = {
  conversationId: '19:abc@thread.tacv2;messageid=111',
  teamId: '59e7c505-802c-476a-9452-bfe8b5a8c2ea',
  channelId: '19:abc@thread.tacv2',
}

describe('addressing', () => {
  test('a chat message is addressed under /chats', () => {
    expect(reactionEndpoint(CHAT, '999')).toContain('/chats/')
  })

  test('a channel message is addressed under /teams/.../channels', () => {
    // Graph cannot reach a channel message via the conversation id, so getting
    // this wrong is a 404 rather than an obvious failure.
    const url = reactionEndpoint(CHANNEL, '999')
    expect(url).toContain(`/teams/${encodeURIComponent(CHANNEL.teamId)}/channels/`)
    expect(url).not.toContain('/chats/')
  })

  test('the thread suffix never reaches Graph', () => {
    // The reaction targets a message, not a thread.
    expect(reactionEndpoint({ conversationId: '19:x@thread.tacv2;messageid=999' }, '111')).not.toContain(
      'messageid',
    )
  })

  test('it targets beta, where setReaction actually exists', () => {
    expect(reactionEndpoint(CHAT, '999')).toStartWith('https://graph.microsoft.com/beta/')
  })
})

describe('react', () => {
  test('posts the reaction to the message endpoint', async () => {
    const { graph, calls } = fakeGraph()

    const result = await react(graph, CHAT, '1785517947373', 'like')

    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toEqual({ reactionType: 'like' })
  })

  test('an unsupported reaction is refused before any network call', async () => {
    const { graph, calls } = fakeGraph()

    expect((await react(graph, CHAT, '1', '🚀')).ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  test('a missing message id is refused before any network call', async () => {
    const { graph, calls } = fakeGraph()

    expect((await react(graph, CHAT, '', 'like')).ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  test("only Graph's own reaction names are accepted", () => {
    expect(isGraphReaction('like')).toBe(true)
    expect(isGraphReaction('thumbsup')).toBe(false)
  })
})

describe('degrading', () => {
  test('a 403 explains that reactions need a delegated token, not just a grant', async () => {
    // The whole point: Graph requires a signed-in-user token for setReaction
    // and this channel authenticates as the application, so telling the
    // operator to grant a permission would send them somewhere that may not
    // fix it.
    const { graph } = fakeGraph(() => {
      throw Object.assign(new Error('Request failed'), { response: { status: 403 } })
    })

    const result = await react(graph, CHAT, '1', 'like')

    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toContain('delegated')
  })

  test('the status is read from the error object, not scraped from its text', () => {
    // A message containing a stray number must not be mistaken for a status.
    const reason = describeGraphFailure(
      Object.assign(new Error('conversation 404040 unavailable'), { response: { status: 503 } }),
    )
    expect(reason).not.toContain('delegated')
    expect(reason).toContain('conversation 404040')
  })

  test('a 401 is treated like a 403', () => {
    expect(describeGraphFailure({ response: { status: 401 } })).toContain('delegated')
  })

  test('a 412 names both possible causes rather than guessing one', () => {
    // Observed against a live tenant. The token was accepted and the message
    // resolved, so telling the operator to grant an Entra permission would be
    // wrong; one of the two named causes is actionable and one is not.
    const reason = describeGraphFailure({ response: { status: 412 } })

    expect(reason).toContain('delegated')
    expect(reason).toContain('resourceSpecific')
    expect(reason).not.toMatch(/grant ChatMessage\.ReadWrite\.All/)
  })

  test('a 404 says the message is gone, not that consent is missing', () => {
    expect(describeGraphFailure({ response: { status: 404 } })).toContain('could not be found')
  })

  test('anything else is reported verbatim rather than guessed at', () => {
    expect(describeGraphFailure(new Error('socket hang up'))).toContain('socket hang up')
  })
})
