import { describe, expect, test } from 'bun:test'
import { chunkText } from '../src/chunk.js'

describe('outbound chunking', () => {
  test('short text is a single chunk', () => {
    expect(chunkText('hello')).toEqual(['hello'])
  })

  test('text at the limit is not split', () => {
    const s = 'x'.repeat(4000)
    expect(chunkText(s)).toHaveLength(1)
  })

  test('over-limit text is split and every chunk fits', () => {
    const chunks = chunkText('y'.repeat(9500))
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000)
  })

  test('no content is lost when there are no newlines to break on', () => {
    const s = 'z'.repeat(9500)
    expect(chunkText(s).join('')).toBe(s)
  })

  test('splits on a newline when one is reasonably placed', () => {
    const s = 'a'.repeat(3900) + '\n' + 'b'.repeat(300)
    const chunks = chunkText(s)
    expect(chunks[0]).toBe('a'.repeat(3900))
    expect(chunks[1]).toBe('b'.repeat(300))
  })

  test('falls back to a hard cut when the newline is too early to be useful', () => {
    // A newline in the first half would waste most of the chunk; cut at the limit.
    const s = 'a'.repeat(100) + '\n' + 'b'.repeat(8000)
    for (const c of chunkText(s)) expect(c.length).toBeLessThanOrEqual(4000)
  })

  test('respects a custom limit', () => {
    for (const c of chunkText('q'.repeat(250), 100)) expect(c.length).toBeLessThanOrEqual(100)
  })
})
