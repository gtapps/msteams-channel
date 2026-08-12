import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildFileConsentCard,
  buildFileInfoCard,
  parseFileConsentInvoke,
  isPrivateOrReservedIp,
  validateConsentUploadUrl,
  uploadToConsentUrl,
  uploadTimeoutMs,
  handleFileConsentInvoke,
  type ConsentInvokeDeps,
} from '../src/file-consent.js'
import { PendingUploadStore } from '../src/pending-uploads.js'
import type { Access } from '../src/gate.js'

/** Await a promise expected to reject, and hand back the error it threw. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (err) {
    return err as Error
  }
  throw new Error('expected a rejection, got none')
}

const TENANT = '11111111-1111-1111-1111-111111111111'
const SENDER = '22222222-2222-2222-2222-222222222222'
const CONV = '19:dm@unq.gbl.spaces'
const UPLOAD_URL = 'https://contoso.sharepoint.com/_api/upload?tempauth=REDACTED'

describe('cards', () => {
  test('the consent card carries only the upload id as context', () => {
    const card = buildFileConsentCard({ filename: 'report.pdf', sizeInBytes: 1234, uploadId: 'abc' })

    expect(card.contentType).toBe('application/vnd.microsoft.teams.card.file.consent')
    expect(card.name).toBe('report.pdf')
    expect(card.content.sizeInBytes).toBe(1234)
    expect(card.content.acceptContext).toEqual({ uploadId: 'abc' })
    expect(card.content.declineContext).toEqual({ uploadId: 'abc' })
  })

  test('the info card points at the content URL Teams allocated', () => {
    const card = buildFileInfoCard({
      filename: 'report.pdf',
      contentUrl: 'https://contoso.sharepoint.com/personal/file.pdf',
      uniqueId: 'unique-1',
      fileType: 'pdf',
    })

    expect(card.contentType).toBe('application/vnd.microsoft.teams.card.file.info')
    expect(card.contentUrl).toBe('https://contoso.sharepoint.com/personal/file.pdf')
    expect(card.content).toEqual({ uniqueId: 'unique-1', fileType: 'pdf' })
  })
})

describe('parseFileConsentInvoke', () => {
  const base = {
    type: 'invoke',
    name: 'fileConsent/invoke',
    value: {
      type: 'fileUpload',
      action: 'accept',
      uploadInfo: {
        name: 'report.pdf',
        uploadUrl: UPLOAD_URL,
        contentUrl: 'https://contoso.sharepoint.com/file.pdf',
        uniqueId: 'unique-1',
        fileType: 'pdf',
      },
      context: { uploadId: 'upload-1' },
    },
  }

  test('reads a well-formed accept', () => {
    const parsed = parseFileConsentInvoke(base)

    expect(parsed?.action).toBe('accept')
    expect(parsed?.uploadId).toBe('upload-1')
    expect(parsed?.action === 'accept' && parsed.uploadInfo.uploadUrl).toBe(UPLOAD_URL)
  })

  test('reads a decline, which carries no upload info at all', () => {
    const parsed = parseFileConsentInvoke({
      ...base,
      value: { type: 'fileUpload', action: 'decline', context: { uploadId: 'upload-1' } },
    })

    expect(parsed).toEqual({ action: 'decline', uploadId: 'upload-1' })
  })

  test.each([['uploadUrl'], ['contentUrl'], ['uniqueId']])(
    'an accept missing %s is malformed, not something to dereference',
    field => {
      // Every field of the SDK's FileUploadInfo is optional.
      const uploadInfo = { ...base.value.uploadInfo, [field]: undefined }
      expect(parseFileConsentInvoke({ ...base, value: { ...base.value, uploadInfo } })).toBeUndefined()
    },
  )

  test('ignores anything that is not this invoke', () => {
    expect(parseFileConsentInvoke({ type: 'message', text: 'hi' })).toBeUndefined()
    expect(parseFileConsentInvoke({ ...base, name: 'signin/verifyState' })).toBeUndefined()
    expect(
      parseFileConsentInvoke({ ...base, value: { ...base.value, type: 'somethingElse' } }),
    ).toBeUndefined()
  })
})

describe('isPrivateOrReservedIp', () => {
  test.each([
    ['127.0.0.1'],
    ['10.1.2.3'],
    ['172.16.0.1'],
    ['192.168.1.1'],
    ['169.254.169.254'], // cloud metadata
    ['100.64.0.1'],
    ['0.0.0.0'],
    ['224.0.0.1'],
    ['255.255.255.255'],
    ['::1'],
    ['::'],
    ['fe80::1'],
    ['fd00::1'],
    ['::ffff:10.0.0.1'], // v4-mapped bypass
    ['not-an-ip'],
    [''],
  ])('%s is refused', ip => {
    expect(isPrivateOrReservedIp(ip)).toBe(true)
  })

  test.each([['13.107.136.9'], ['52.109.8.1'], ['2620:1ec:8f8::1']])('%s is allowed', ip => {
    expect(isPrivateOrReservedIp(ip)).toBe(false)
  })
})

describe('validateConsentUploadUrl', () => {
  const publicDns = async () => [{ address: '13.107.136.9' }]

  test('accepts a Microsoft upload host', async () => {
    await expect(
      validateConsentUploadUrl(UPLOAD_URL, { resolveFn: publicDns }),
    ).resolves.toBeUndefined()
  })

  test('refuses plain http', async () => {
    await expect(
      validateConsentUploadUrl('http://contoso.sharepoint.com/x', { resolveFn: publicDns }),
    ).rejects.toThrow(/not https/)
  })

  test('refuses a host outside the allowlist', async () => {
    await expect(
      validateConsentUploadUrl('https://evil.example/x', { resolveFn: publicDns }),
    ).rejects.toThrow(/not a Microsoft upload host/)
  })

  test('a suffix that merely contains an allowed host is not an allowed host', async () => {
    await expect(
      validateConsentUploadUrl('https://sharepoint.com.evil.example/x', { resolveFn: publicDns }),
    ).rejects.toThrow(/not a Microsoft upload host/)
  })

  test('refuses when any answer is internal, not just the first', async () => {
    await expect(
      validateConsentUploadUrl(UPLOAD_URL, {
        resolveFn: async () => [{ address: '13.107.136.9' }, { address: '10.0.0.5' }],
      }),
    ).rejects.toThrow(/internal address/)
  })

  test('refuses when the host does not resolve', async () => {
    await expect(
      validateConsentUploadUrl(UPLOAD_URL, {
        resolveFn: async () => {
          throw new Error('ENOTFOUND')
        },
      }),
    ).rejects.toThrow(/did not resolve/)
  })

  test('the real resolver refuses a host that points at loopback', async () => {
    // No injected resolver: this exercises Bun's own node:dns/promises lookup,
    // which the SSRF check depends on behaving like Node's.
    const err = await rejection(
      validateConsentUploadUrl('https://localhost/upload', { allowlist: ['localhost'] }),
    )

    expect(err.message).toMatch(/internal address|did not resolve/)
  })

  test('errors never name the URL or its host', async () => {
    const secret = 'https://contoso.sharepoint.com/_api/upload?tempauth=SECRET'
    const err = await rejection(
      validateConsentUploadUrl(secret, { resolveFn: async () => [{ address: '10.0.0.5' }] }),
    )

    expect(err.message).not.toContain('SECRET')
    expect(err.message).not.toContain('contoso')
  })
})

describe('uploadToConsentUrl', () => {
  const publicDns = async () => [{ address: '13.107.136.9' }]

  test('PUTs the bytes with a content range and refuses redirects', async () => {
    let seen: { url: string; init: any } | undefined
    await uploadToConsentUrl({
      url: UPLOAD_URL,
      bytes: Buffer.from('hello'),
      contentType: 'application/pdf',
      resolveFn: publicDns,
      fetchFn: (async (url: string, init: any) => {
        seen = { url, init }
        return new Response(null, { status: 201 })
      }) as unknown as typeof fetch,
    })

    expect(seen?.init.method).toBe('PUT')
    expect(seen?.init.headers['Content-Range']).toBe('bytes 0-4/5')
    expect(seen?.init.headers['Content-Type']).toBe('application/pdf')
    // Following a redirect would carry the bytes and the credential elsewhere.
    expect(seen?.init.redirect).toBe('error')
  })

  test('a failed PUT reports the status and nothing else', async () => {
    const err = await rejection(
      uploadToConsentUrl({
        url: UPLOAD_URL,
        bytes: Buffer.from('hello'),
        contentType: 'application/pdf',
        resolveFn: publicDns,
        fetchFn: (async () => new Response(null, { status: 403 })) as unknown as typeof fetch,
      }),
    )

    expect(err.message).toBe('file upload failed: HTTP 403')
  })

  test('a network error never leaks the URL fetch put in its message', async () => {
    const err = await rejection(
      uploadToConsentUrl({
        url: UPLOAD_URL,
        bytes: Buffer.from('hello'),
        contentType: 'application/pdf',
        resolveFn: publicDns,
        fetchFn: (async () => {
          throw new Error(`connect ECONNREFUSED for ${UPLOAD_URL}`)
        }) as unknown as typeof fetch,
      }),
    )

    expect(err.message).not.toContain('tempauth')
    expect(err.message).not.toContain('contoso')
  })

  test('the timeout scales with size', () => {
    expect(uploadTimeoutMs(0)).toBe(300_000)
    expect(uploadTimeoutMs(100 * 1024 * 1024)).toBe(700_000)
  })
})

describe('handleFileConsentInvoke', () => {
  let dir: string
  let store: PendingUploadStore
  let uploads: { url: string; bytes: Buffer }[]
  let sent: Record<string, any>[]
  let updates: { activityId: string; activity: Record<string, any> }[]
  let logs: string[]
  let deps: ConsentInvokeDeps

  const access: Access = {
    dmPolicy: 'allowlist',
    allowFrom: [SENDER],
    groups: {},
    pending: {},
  }

  function invoke(overrides: Record<string, any> = {}, value: Record<string, any> = {}) {
    return {
      type: 'invoke',
      name: 'fileConsent/invoke',
      conversation: { id: `${CONV};messageid=1700000000000`, conversationType: 'personal' },
      channelData: { tenant: { id: TENANT } },
      from: { aadObjectId: SENDER },
      value: {
        type: 'fileUpload',
        action: 'accept',
        uploadInfo: {
          name: 'report.pdf',
          uploadUrl: UPLOAD_URL,
          contentUrl: 'https://contoso.sharepoint.com/file.pdf',
          uniqueId: 'unique-1',
          fileType: 'pdf',
        },
        ...value,
      },
      ...overrides,
    }
  }

  function offer(conversationId = CONV): string {
    return store.store({
      bytes: Buffer.from('%PDF-1.7'),
      filename: 'report.pdf',
      contentType: 'application/pdf',
      conversationId,
    })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'msteams-consent-'))
    store = new PendingUploadStore(dir)
    uploads = []
    sent = []
    updates = []
    logs = []
    deps = {
      access,
      configuredTenantId: TENANT,
      store,
      upload: async p => {
        uploads.push({ url: p.url, bytes: p.bytes })
      },
      send: async activity => {
        sent.push(activity)
        return { id: 'sent-1' }
      },
      update: async (activityId, activity) => {
        updates.push({ activityId, activity })
        return { id: activityId }
      },
      settled: new Map(),
      log: line => logs.push(line),
    }
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('an accept uploads the snapshot and posts the file card', async () => {
    const id = offer()

    await handleFileConsentInvoke(invoke({}, { context: { uploadId: id } }), deps)

    expect(uploads).toHaveLength(1)
    expect(uploads[0].bytes.toString()).toBe('%PDF-1.7')
    expect(sent[0].attachments[0].contentType).toBe(
      'application/vnd.microsoft.teams.card.file.info',
    )
    expect(readdirSync(dir)).toHaveLength(0) // record settled
  })

  test('the file card replaces the consent card when we know its id', async () => {
    const id = offer()
    store.setConsentCardActivityId(id, 'card-activity-1')

    await handleFileConsentInvoke(invoke({}, { context: { uploadId: id } }), deps)

    expect(updates[0].activityId).toBe('card-activity-1')
    expect(sent).toHaveLength(0)
  })

  test('a failed card update still gets the file card into the chat', async () => {
    const id = offer()
    store.setConsentCardActivityId(id, 'card-activity-1')
    deps.update = async () => {
      throw new Error('activity too old to edit')
    }

    await handleFileConsentInvoke(invoke({}, { context: { uploadId: id } }), deps)

    expect(sent[0].attachments[0].contentType).toBe(
      'application/vnd.microsoft.teams.card.file.info',
    )
  })

  test('a gate refusal is silent toward Teams and touches nothing', async () => {
    const id = offer()
    const stranger = invoke({ from: { aadObjectId: 'unknown-sender' } }, { context: { uploadId: id } })

    await handleFileConsentInvoke(stranger, deps)

    expect(uploads).toHaveLength(0)
    expect(sent).toHaveLength(0)
    // The offer survives: the real recipient can still accept it.
    expect(store.claim(id, CONV)).toBeDefined()
  })

  test('a foreign tenant is refused before the store is touched', async () => {
    const id = offer()
    const foreign = invoke(
      { channelData: { tenant: { id: 'other-tenant' } } },
      { context: { uploadId: id } },
    )

    await handleFileConsentInvoke(foreign, deps)

    expect(uploads).toHaveLength(0)
    expect(sent).toHaveLength(0)
    expect(store.claim(id, CONV)).toBeDefined()
  })

  test('two deliveries of the same accept upload exactly once', async () => {
    const id = offer()
    const activity = invoke({}, { context: { uploadId: id } })

    await Promise.all([
      handleFileConsentInvoke(activity, deps),
      handleFileConsentInvoke(activity, deps),
    ])

    expect(uploads).toHaveLength(1)
    // And the loser says nothing: the file arrived, so a stray line under it
    // would be worse than silence.
    expect(sent.filter(a => typeof a.text === 'string')).toHaveLength(0)
  })

  test('an accept replayed from another conversation gets nothing and cancels nothing', async () => {
    const id = offer()
    const elsewhere = invoke(
      { conversation: { id: '19:other@thread.tacv2', conversationType: 'personal' } },
      { context: { uploadId: id } },
    )

    await handleFileConsentInvoke(elsewhere, deps)

    expect(uploads).toHaveLength(0)
    expect(sent[0].text).toMatch(/expired/)
    // The real offer is untouched.
    expect(store.claim(id, CONV)).toBeDefined()
  })

  test('an accept for an unknown offer says so once', async () => {
    await handleFileConsentInvoke(
      invoke({}, { context: { uploadId: 'f'.repeat(32) } }),
      deps,
    )

    expect(sent[0].text).toMatch(/expired/)
    expect(uploads).toHaveLength(0)
  })

  test('a redelivered accept after a successful upload stays quiet', async () => {
    const id = offer()
    const activity = invoke({}, { context: { uploadId: id } })
    await handleFileConsentInvoke(activity, deps)
    sent.length = 0

    await handleFileConsentInvoke(activity, deps)

    expect(sent).toHaveLength(0)
    expect(uploads).toHaveLength(1)
  })

  test('a decline drops the snapshot without a word', async () => {
    const id = offer()

    await handleFileConsentInvoke(
      invoke({}, { action: 'decline', uploadInfo: undefined, context: { uploadId: id } }),
      deps,
    )

    expect(sent).toHaveLength(0)
    expect(uploads).toHaveLength(0)
    expect(readdirSync(dir)).toHaveLength(0)
  })

  test('a decline replaces the card, so it cannot be answered twice', async () => {
    // Observed live: Teams leaves a declined card on screen with its buttons
    // live, so the recipient cannot tell the click registered and clicks again.
    const id = offer()
    store.setConsentCardActivityId(id, 'card-activity-1')

    await handleFileConsentInvoke(
      invoke({}, { action: 'decline', uploadInfo: undefined, context: { uploadId: id } }),
      deps,
    )

    expect(updates[0].activityId).toBe('card-activity-1')
    expect(String(updates[0].activity.text)).toMatch(/declined/i)
    expect(String(updates[0].activity.text)).toContain('report.pdf')
    expect(sent).toHaveLength(0)
  })

  test('a decline whose card cannot be edited says nothing instead', async () => {
    // A second message under a card the recipient already answered is noise.
    const id = offer()
    store.setConsentCardActivityId(id, 'card-activity-1')
    deps.update = async () => {
      throw new Error('activity too old to edit')
    }

    await handleFileConsentInvoke(
      invoke({}, { action: 'decline', uploadInfo: undefined, context: { uploadId: id } }),
      deps,
    )

    expect(sent).toHaveLength(0)
    expect(readdirSync(dir)).toHaveLength(0)
  })

  test('an upload failure tells the recipient and frees the record', async () => {
    const id = offer()
    deps.upload = async () => {
      throw new Error('file upload failed: HTTP 403')
    }

    await handleFileConsentInvoke(invoke({}, { context: { uploadId: id } }), deps)

    expect(sent[0].text).toMatch(/upload failed/i)
    expect(readdirSync(dir)).toHaveLength(0)
  })

  test('a malformed invoke is answered with silence', async () => {
    const id = offer()

    await handleFileConsentInvoke(
      invoke({}, { uploadInfo: { name: 'report.pdf' }, context: { uploadId: id } }),
      deps,
    )

    expect(sent).toHaveLength(0)
    expect(uploads).toHaveLength(0)
    expect(store.claim(id, CONV)).toBeDefined()
  })

  test('no log line ever carries the upload URL', async () => {
    const id = offer()
    deps.upload = async () => {
      throw new Error('file upload failed: HTTP 500')
    }

    await handleFileConsentInvoke(invoke({}, { context: { uploadId: id } }), deps)

    for (const line of logs) {
      expect(line).not.toContain('tempauth')
      expect(line).not.toContain('contoso')
    }
  })
})
