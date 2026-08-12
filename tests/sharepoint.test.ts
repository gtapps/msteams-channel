import { test, expect, describe } from 'bun:test'
import {
  graphTokenGetter,
  uniqueUploadName,
  uploadToSharePoint,
  getDriveItemProperties,
  createSharingLink,
  publishFileToConversation,
  cleanETag,
  buildSharePointFileCard,
  describeSharePointFailure,
} from '../src/sharepoint.js'

const SITE = 'contoso.sharepoint.com,site-guid,web-guid'
const getToken = async () => 'test-token'

type Call = { url: string; init: any }

/** A fetch that records every request and answers from a per-URL handler. */
function recorder(handler: (url: string, init: any) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchFn = (async (url: string, init: any) => {
    calls.push({ url, init })
    return await handler(url, init)
  }) as unknown as typeof fetch
  return { calls, fetchFn }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const ITEM = { id: 'item-1', webUrl: 'https://contoso.sharepoint.com/x', name: 'report-abc.pdf' }
const PROPS = {
  eTag: '"{11111111-2222-3333-4444-555555555555},3"',
  webDavUrl: 'https://contoso.sharepoint.com/AgentShared/report-abc.pdf',
  name: 'report-abc.pdf',
}

/** Answers the whole upload -> props -> link -> (no delete) sequence. */
function happyPath(): (url: string, init: any) => Response {
  return (url, init) => {
    if (init?.method === 'PUT') return json(ITEM, 201)
    if (url.includes('createLink')) return json({ link: { webUrl: 'https://share/x' } })
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    return json(PROPS)
  }
}

describe('uniqueUploadName', () => {
  test('inserts randomness before the extension', () => {
    expect(uniqueUploadName('report.pdf')).toMatch(/^report-[0-9a-f]{16}\.pdf$/)
  })

  test('two uploads of the same name never collide', () => {
    // This is what keeps an already-posted file card pointing at the bytes it
    // was posted for.
    expect(uniqueUploadName('report.pdf')).not.toBe(uniqueUploadName('report.pdf'))
  })

  test('handles a name with no extension', () => {
    expect(uniqueUploadName('README')).toMatch(/^README-[0-9a-f]{16}$/)
  })
})

describe('uploadToSharePoint', () => {
  test('PUTs into AgentShared and refuses to overwrite', async () => {
    const { calls, fetchFn } = recorder(() => json(ITEM, 201))

    await uploadToSharePoint({
      bytes: Buffer.from('%PDF'),
      filename: 'report.pdf',
      contentType: 'application/pdf',
      siteId: SITE,
      getToken,
      fetchFn,
    })

    const { url, init } = calls[0]
    expect(url).toContain(`/sites/${encodeURIComponent(SITE)}/drive/root:/AgentShared/`)
    expect(url).toContain(':/content?@microsoft.graph.conflictBehavior=fail')
    expect(init.method).toBe('PUT')
    expect(init.headers['Content-Type']).toBe('application/pdf')
    expect(init.headers.Authorization).toBe('Bearer test-token')
    expect(init.redirect).toBe('error')
  })

  test('a name conflict is retried once with fresh randomness', async () => {
    let attempts = 0
    const { calls, fetchFn } = recorder(() => {
      attempts++
      return attempts === 1 ? new Response(null, { status: 409 }) : json(ITEM, 201)
    })

    const uploaded = await uploadToSharePoint({
      bytes: Buffer.from('%PDF'),
      filename: 'report.pdf',
      contentType: 'application/pdf',
      siteId: SITE,
      getToken,
      fetchFn,
    })

    expect(uploaded.itemId).toBe('item-1')
    expect(calls).toHaveLength(2)
    expect(calls[0].url).not.toBe(calls[1].url)
  })

  test('a refusal carries the status for the operator-facing message', async () => {
    const { fetchFn } = recorder(() => new Response(null, { status: 403 }))

    const err = await uploadToSharePoint({
      bytes: Buffer.from('%PDF'),
      filename: 'report.pdf',
      contentType: 'application/pdf',
      siteId: SITE,
      getToken,
      fetchFn,
    }).then(
      () => undefined,
      (e: Error) => e,
    )

    expect(describeSharePointFailure(err)).toMatch(/Sites\.Selected/)
  })
})

describe('getDriveItemProperties', () => {
  test('asks only for what the file card needs', async () => {
    const { calls, fetchFn } = recorder(() => json(PROPS))

    const props = await getDriveItemProperties({ siteId: SITE, itemId: 'item-1', getToken, fetchFn })

    expect(calls[0].url).toContain('/drive/items/item-1?$select=eTag,webDavUrl,name')
    expect(props.webDavUrl).toBe(PROPS.webDavUrl)
  })
})

describe('createSharingLink', () => {
  test('a channel gets an organization link from v1.0', async () => {
    const { calls, fetchFn } = recorder(() => json({ link: { webUrl: 'https://share/x' } }))

    await createSharingLink({ siteId: SITE, itemId: 'item-1', scope: 'organization', getToken, fetchFn })

    expect(calls[0].url).toStartWith('https://graph.microsoft.com/v1.0/')
    expect(JSON.parse(calls[0].init.body)).toEqual({ type: 'view', scope: 'organization' })
  })

  test('a group chat gets a link restricted to its members', async () => {
    const { calls, fetchFn } = recorder(() => json({ link: { webUrl: 'https://share/x' } }))

    await createSharingLink({
      siteId: SITE,
      itemId: 'item-1',
      scope: 'users',
      recipientObjectIds: ['user-a', 'user-b'],
      getToken,
      fetchFn,
    })

    // Per-user links are beta-only.
    expect(calls[0].url).toStartWith('https://graph.microsoft.com/beta/')
    expect(JSON.parse(calls[0].init.body)).toEqual({
      type: 'view',
      scope: 'users',
      recipients: [{ objectId: 'user-a' }, { objectId: 'user-b' }],
    })
  })

  test('per-user sharing with nobody to share with is refused', async () => {
    const { calls, fetchFn } = recorder(() => json({ link: { webUrl: 'https://share/x' } }))

    await expect(
      createSharingLink({ siteId: SITE, itemId: 'item-1', scope: 'users', getToken, fetchFn }),
    ).rejects.toThrow(/at least one recipient/)
    expect(calls).toHaveLength(0)
  })
})

describe('file cards', () => {
  test('the eTag becomes a bare unique id', () => {
    expect(cleanETag('"{ABC-123},42"')).toBe('ABC-123')
    expect(cleanETag('plain-etag')).toBe('plain-etag')
  })

  test('the card points at the WebDAV URL and names the file type', () => {
    const card = buildSharePointFileCard(PROPS)

    expect(card.contentType).toBe('application/vnd.microsoft.teams.card.file.info')
    expect(card.contentUrl).toBe(PROPS.webDavUrl)
    expect(card.content.fileType).toBe('pdf')
    expect(card.content.uniqueId).toBe('11111111-2222-3333-4444-555555555555')
  })
})

describe('publishFileToConversation', () => {
  const file = {
    bytes: Buffer.from('%PDF'),
    filename: 'report.pdf',
    contentType: 'application/pdf',
    siteId: SITE,
    getToken,
  }

  test('uploads, grants access, then posts the card', async () => {
    const order: string[] = []
    const { fetchFn } = recorder((url, init) => {
      if (init?.method === 'PUT') order.push('upload')
      else if (url.includes('createLink')) order.push('link')
      else if (init?.method === 'DELETE') order.push('delete')
      else order.push('props')
      return happyPath()(url, init)
    })
    const posted: Record<string, any>[] = []

    const result = await publishFileToConversation({
      ...file,
      scope: 'organization',
      fetchFn,
      post: async activity => {
        order.push('post')
        posted.push(activity)
        return { id: 'sent-1' }
      },
    })

    // The link must exist before the card, or the recipients cannot open it.
    expect(order).toEqual(['upload', 'props', 'link', 'post'])
    expect(posted[0].attachments[0].contentUrl).toBe(PROPS.webDavUrl)
    expect(result.sentId).toBe('sent-1')
  })

  test.each([
    ['the property lookup', (url: string, init: any) => init?.method === 'GET' || (!init?.method && !url.includes('createLink'))],
    ['the sharing link', (url: string) => url.includes('createLink')],
  ])('a failure in %s deletes the uploaded file', async (_label, shouldFail) => {
    const { calls, fetchFn } = recorder((url, init) => {
      if (init?.method === 'PUT') return json(ITEM, 201)
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      if (shouldFail(url, init)) return new Response(null, { status: 500 })
      return happyPath()(url, init)
    })

    await expect(
      publishFileToConversation({
        ...file,
        scope: 'organization',
        fetchFn,
        post: async () => ({ id: 'sent-1' }),
      }),
    ).rejects.toThrow()

    const deletes = calls.filter(c => c.init?.method === 'DELETE')
    expect(deletes).toHaveLength(1)
    expect(deletes[0].url).toContain('/drive/items/item-1')
  })

  test('a failed card post deletes the uploaded file too', async () => {
    // Nobody was told about it, so leaving it behind is litter in the site.
    const { calls, fetchFn } = recorder(happyPath())

    await expect(
      publishFileToConversation({
        ...file,
        scope: 'organization',
        fetchFn,
        post: async () => {
          throw new Error('Teams rejected the activity')
        },
      }),
    ).rejects.toThrow(/Teams rejected/)

    expect(calls.filter(c => c.init?.method === 'DELETE')).toHaveLength(1)
  })

  test('a successful publish deletes nothing', async () => {
    const { calls, fetchFn } = recorder(happyPath())

    await publishFileToConversation({
      ...file,
      scope: 'organization',
      fetchFn,
      post: async () => ({ id: 'sent-1' }),
    })

    expect(calls.filter(c => c.init?.method === 'DELETE')).toHaveLength(0)
  })
})

describe('graphTokenGetter', () => {
  test('resolves the SDK token factory', async () => {
    const getter = graphTokenGetter({ http: { token: () => 'factory-token' } })
    expect(await getter()).toBe('factory-token')
  })

  test('resolves an object token via toString', async () => {
    const getter = graphTokenGetter({ http: { token: { toString: () => 'object-token' } } })
    expect(await getter()).toBe('object-token')
  })

  test('an absent token is an actionable error, not an empty Bearer header', async () => {
    await expect(graphTokenGetter({ http: {} })()).rejects.toThrow(/no Microsoft Graph token/)
  })
})

describe('describeSharePointFailure', () => {
  test('a 403 points at the grant and the site id', () => {
    const err = Object.assign(new Error('SharePoint upload failed: HTTP 403'), { status: 403 })
    const described = describeSharePointFailure(err)

    expect(described).toMatch(/Sites\.Selected/)
    expect(described).toMatch(/MSTEAMS_SHAREPOINT_SITE_ID/)
    expect(described).toMatch(/SETUP\.md/)
  })

  test('a 404 points at the site id', () => {
    const err = Object.assign(new Error('SharePoint upload failed: HTTP 404'), { status: 404 })
    expect(describeSharePointFailure(err)).toMatch(/MSTEAMS_SHAREPOINT_SITE_ID/)
  })

  test('anything else is passed through', () => {
    expect(describeSharePointFailure(new Error('socket hang up'))).toBe('socket hang up')
  })
})
