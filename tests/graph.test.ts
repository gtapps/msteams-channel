import { test, expect, describe } from 'bun:test'
import { react, describeGraphFailure, reactionEndpoint, isGraphReaction, type GraphLike } from '../src/graph.js'

/** A GraphClient that records what it was asked, or fails on cue. */
function fakeGraph(behaviour?: () => never): { graph: GraphLike; calls: { path: string; body: unknown }[] } {
  const calls: { path: string; body: unknown }[] = []
  return {
    calls,
    graph: {
      api: (path: string) => ({
        post: async (body: unknown) => {
          calls.push({ path, body })
          if (behaviour) behaviour()
          return {}
        },
      }),
    },
  }
}

describe('react', () => {
  test('posts the reaction to the message endpoint', async () => {
    const { graph, calls } = fakeGraph()

    const result = await react(graph, '19:abc@thread.tacv2', '1785517947373', 'like')

    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toEqual({ reactionType: 'like' })
  })

  test('an unsupported reaction is refused before any network call', async () => {
    const { graph, calls } = fakeGraph()

    const result = await react(graph, '19:abc@thread.tacv2', '1', '🚀')

    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  test('the thread suffix is stripped from the conversation id', () => {
    // The reaction targets a message, not a thread, so ;messageid= would
    // address the wrong resource.
    expect(reactionEndpoint('19:abc@thread.tacv2;messageid=999', '111')).not.toContain('messageid')
  })

  test('only Graph\'s own reaction names are accepted', () => {
    expect(isGraphReaction('like')).toBe(true)
    expect(isGraphReaction('thumbsup')).toBe(false)
  })
})

describe('degrading without consent', () => {
  test('a 403 names the permission to grant rather than leaking a stack', async () => {
    // This is the whole point of the degradable design: an operator who never
    // granted the Graph scope gets told what to do, and everything else works.
    const { graph } = fakeGraph(() => {
      throw new Error('Request failed with status code 403')
    })

    const result = await react(graph, '19:abc@thread.tacv2', '1', 'like')

    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toContain('ChatMessage.ReadWrite.All')
  })

  test('a 401 is treated the same as a 403', () => {
    expect(describeGraphFailure(new Error('401 Unauthorized'))).toContain('ChatMessage.ReadWrite.All')
  })

  test('a 404 says the message is gone, not that consent is missing', () => {
    expect(describeGraphFailure(new Error('404 Not Found'))).toContain('could not be found')
  })

  test('anything else is reported verbatim rather than guessed at', () => {
    expect(describeGraphFailure(new Error('socket hang up'))).toContain('socket hang up')
  })
})
