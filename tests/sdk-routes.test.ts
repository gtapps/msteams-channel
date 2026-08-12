/**
 * The SDK route names this channel depends on, pinned.
 *
 * `app.on('file.consent.accept', ...)` is an alias the SDK derives from an
 * invoke's `name` and `value.action`; nothing checks that the alias exists.
 * If a release renamed it, registration would still succeed, the route would
 * never match, and every file offered in a DM would sit there doing nothing
 * when the recipient clicks Accept — with no error anywhere. Same reasoning as
 * `auth-coverage.test.ts`: fail here, loudly, at the next SDK bump.
 *
 * Offline: constructing an App does no network, and nothing is started.
 */

import { test, expect, describe } from 'bun:test'
import { App } from '@microsoft/teams.apps'

function router(): { select: (activity: Record<string, unknown>) => unknown[] } {
  const app = new App({
    clientId: '00000000-0000-0000-0000-000000000000',
    clientSecret: 'not-a-real-secret',
    tenantId: '00000000-0000-0000-0000-000000000000',
  })
  app.on('file.consent.accept' as never, (() => {}) as never)
  app.on('file.consent.decline' as never, (() => {}) as never)
  return (app as unknown as { router: { select: (a: Record<string, unknown>) => unknown[] } }).router
}

function consentInvoke(action: 'accept' | 'decline'): Record<string, unknown> {
  return {
    type: 'invoke',
    name: 'fileConsent/invoke',
    value: { type: 'fileUpload', action, context: { uploadId: 'x' } },
  }
}

describe('fileConsent invoke routing', () => {
  test.each([['accept'], ['decline']] as const)('an %s invoke reaches a handler', action => {
    expect(router().select(consentInvoke(action))).toHaveLength(1)
  })

  test('accept and decline do not both fire for one invoke', () => {
    // They share a handler here, but a single invoke matching both routes would
    // mean the upload runs twice.
    expect(router().select(consentInvoke('accept'))).toHaveLength(1)
  })

  test('an ordinary message does not reach the consent handler', () => {
    expect(router().select({ type: 'message', text: 'hello' })).toHaveLength(0)
  })
})
