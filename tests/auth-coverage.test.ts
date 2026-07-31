/**
 * Proof that the SDK's JWT validation is actually wired, not merely present.
 *
 * `bun-adapter.test.ts` covers our own bearer pre-gate, which only checks that
 * *a* token was supplied. That says nothing about whether a forged one would be
 * rejected — the pre-gate is happy with `Bearer x.y.z`. These tests drive the
 * SDK's validators directly and assert both halves: a well-formed token is
 * accepted, and every malformed shape we care about is not.
 *
 * The validators are reached through internal subpaths, which are not part of
 * the SDK's public barrel. That is deliberate: the contract under test is the
 * validator's accept/reject behaviour, and standing up HTTP around it would
 * test the plumbing instead. If a future SDK release moves them, this file
 * fails loudly rather than silently stopping to verify anything.
 *
 * Adapted from OpenClaw's `auth-coverage.test.ts` (MIT, 32b2e161a5a,
 * extensions/msteams/src/auth-coverage.test.ts), ported from vitest to bun and
 * extended with the wrong-signing-key case.
 *
 * `JwksClient.prototype.getSigningKeys` is patched to hand back one in-memory
 * key so nothing here reaches login.botframework.com.
 */

import { test, expect, describe, beforeAll, spyOn } from 'bun:test'
import { createEntraTokenValidator } from '@microsoft/teams.apps/dist/middleware/auth/jwt-validator.js'
import { ServiceTokenValidator } from '@microsoft/teams.apps/dist/middleware/auth/service-token-validator.js'
import type { ILogger } from '@microsoft/teams.common'
import { exportSPKI, generateKeyPair, SignJWT } from 'jose'
import { JwksClient, type SigningKey } from 'jwks-rsa'

/**
 * The SDK logs every rejection at error level, so the negative tests below
 * would print a wall of stack traces on an otherwise green run. Swap `error`
 * for `console.error` when a token is being rejected for a reason you can't
 * work out — the SDK's message names it precisely.
 */
const quiet: ILogger = {
  child: () => quiet,
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  log: () => {},
  trace: () => {},
}

const APP_ID = 'test-app-id'
const TENANT_ID = 'test-tenant-id'
const TEST_KID = 'test-key-id'

let signingKey: CryptoKey
let attackerKey: CryptoKey

async function mint(claims: Record<string, unknown>, key = signingKey): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: TEST_KID })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key)
}

beforeAll(async () => {
  const trusted = await generateKeyPair('RS256', { modulusLength: 2048 })
  // A second, untrusted keypair: the JWKS only advertises the first, so tokens
  // signed with this one must fail signature verification.
  const attacker = await generateKeyPair('RS256', { modulusLength: 2048 })
  signingKey = trusted.privateKey
  attackerKey = attacker.privateKey
  const publicPem = await exportSPKI(trusted.publicKey)

  spyOn(JwksClient.prototype, 'getSigningKeys').mockResolvedValue([
    {
      kid: TEST_KID,
      alg: 'RS256',
      getPublicKey: () => publicPem,
      rsaPublicKey: publicPem,
    } as SigningKey,
  ])
})

describe('inbound Bot Framework tokens', () => {
  const validator = () => new ServiceTokenValidator(APP_ID, undefined, undefined, quiet)

  test('a token whose audience is our app id is accepted', async () => {
    // The positive path: without this, every negative assertion below could
    // pass simply because validation rejects everything.
    const token = await mint({ aud: APP_ID, iss: 'https://api.botframework.com' })

    const result = await validator().check(`Bearer ${token}`, { id: 'activity-ok' })

    expect(result.appId).toBe(APP_ID)
  })

  test('a token signed with an unadvertised key is rejected', async () => {
    // Claims are perfect; only the signature is wrong. This is what proves
    // the signature is verified rather than the claims merely being read.
    const token = await mint({ aud: APP_ID, iss: 'https://api.botframework.com' }, attackerKey)

    await expect(validator().check(`Bearer ${token}`, { id: 'activity-forged' })).rejects.toThrow()
  })

  test('a Connector-audience token is rejected even when its appid is ours', async () => {
    // Confused deputy: this token was issued *for* the Connector resource and
    // happens to name our bot in `appid`. Accepting it inbound would let a
    // token minted for a different resource authenticate as the bot.
    const token = await mint({
      aud: 'https://api.botframework.com',
      iss: 'https://api.botframework.com',
      appid: APP_ID,
      azp: APP_ID,
    })

    await expect(validator().check(`Bearer ${token}`, { id: 'activity-deputy' })).rejects.toThrow()
  })

  test('a token for a different app id is rejected', async () => {
    const token = await mint({ aud: 'some-other-app', iss: 'https://api.botframework.com' })

    await expect(validator().check(`Bearer ${token}`, { id: 'activity-other' })).rejects.toThrow()
  })
})

describe('Entra access tokens', () => {
  const validator = () => createEntraTokenValidator(TENANT_ID, APP_ID, { allowedTenantIds: [TENANT_ID], logger: quiet })

  test('the v2 login.microsoftonline.com issuer is accepted', async () => {
    const token = await mint({ aud: APP_ID, iss: `https://login.microsoftonline.com/${TENANT_ID}/v2.0` })

    expect(await validator().validateAccessToken(token)).not.toBeNull()
  })

  test('the legacy v1 sts.windows.net issuer is accepted', async () => {
    // Both issuer forms are live in real tenants; rejecting v1 would break
    // installs for no security gain.
    const token = await mint({ aud: APP_ID, iss: `https://sts.windows.net/${TENANT_ID}/` })

    const payload = await validator().validateAccessToken(token)

    expect(payload?.iss).toBe(`https://sts.windows.net/${TENANT_ID}/`)
  })

  test('a token from another tenant yields no payload', async () => {
    // This is the single-tenant boundary. The SDK signals rejection by
    // resolving null here rather than throwing.
    const token = await mint({ aud: APP_ID, iss: 'https://sts.windows.net/some-other-tenant/' })

    expect(await validator().validateAccessToken(token)).toBeNull()
  })
})
