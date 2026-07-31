import { describe, expect, test } from 'bun:test'
import { parseVerdict, PendingPermissions } from '../src/permissions.js'

describe('verdict grammar', () => {
  test('the four accepted forms parse', () => {
    expect(parseVerdict('y abcde')).toEqual({ requestId: 'abcde', behavior: 'allow' })
    expect(parseVerdict('yes abcde')).toEqual({ requestId: 'abcde', behavior: 'allow' })
    expect(parseVerdict('n abcde')).toEqual({ requestId: 'abcde', behavior: 'deny' })
    expect(parseVerdict('no abcde')).toEqual({ requestId: 'abcde', behavior: 'deny' })
  })

  test('phone keyboards capitalize, so case is ignored', () => {
    expect(parseVerdict('Y ABCDE')).toEqual({ requestId: 'abcde', behavior: 'allow' })
  })

  test('surrounding whitespace is tolerated', () => {
    expect(parseVerdict('  y abcde  ')).toEqual({ requestId: 'abcde', behavior: 'allow' })
  })

  test('a bare yes is conversation, not a verdict', () => {
    // This is the load-bearing case: swallowing it would both lose a message
    // and grant a permission the sender never named.
    expect(parseVerdict('yes')).toBeUndefined()
    expect(parseVerdict('no')).toBeUndefined()
    expect(parseVerdict('yes please')).toBeUndefined()
  })

  test('chatter around a code does not count', () => {
    expect(parseVerdict('yes abcde do it')).toBeUndefined()
    expect(parseVerdict('I think yes abcde')).toBeUndefined()
  })

  test("'l' is excluded from the alphabet so it cannot be read as '1'", () => {
    expect(parseVerdict('y abcdl')).toBeUndefined()
    expect(parseVerdict('y abcd1')).toBeUndefined()
  })

  test('the id is exactly five letters', () => {
    expect(parseVerdict('y abcd')).toBeUndefined()
    expect(parseVerdict('y abcdef')).toBeUndefined()
  })

  test('a maybe is not a verdict', () => {
    expect(parseVerdict('maybe abcde')).toBeUndefined()
    expect(parseVerdict('yep abcde')).toBeUndefined()
  })
})

describe('one-shot semantics', () => {
  test('a request can be claimed exactly once', () => {
    // A Bot Framework redelivery of the same activity, or the sender typing the
    // same answer twice, must not emit a second verdict.
    const pending = new PendingPermissions()
    pending.add('abcde', 'Bash')

    expect(pending.take('abcde')).toBe(true)
    expect(pending.take('abcde')).toBe(false)
  })

  test('a verdict for a request that was never issued is refused', () => {
    // Otherwise a sender could guess ids and approve requests at random.
    const pending = new PendingPermissions()
    expect(pending.take('abcde')).toBe(false)
  })

  test('claiming one request leaves the others live', () => {
    const pending = new PendingPermissions()
    pending.add('abcde', 'Bash')
    pending.add('fghij', 'Write')

    expect(pending.take('abcde')).toBe(true)
    expect(pending.size).toBe(1)
    expect(pending.take('fghij')).toBe(true)
  })
})
