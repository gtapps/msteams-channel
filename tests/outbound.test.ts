import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  planOutboundFiles,
  deliverOutbound,
  describeDelivery,
  describeFailure,
  MAX_OUTBOUND_FILE_BYTES,
  type DeliverParams,
} from '../src/outbound.js'
import { MAX_INLINE_IMAGE_BYTES } from '../src/attach.js'
import { PendingUploadStore } from '../src/pending-uploads.js'

const SITE = 'contoso.sharepoint.com,site-guid,web-guid'
const CONV = '19:room@thread.tacv2'

let root: string
let stateDir: string
let pendingDir: string
let pending: PendingUploadStore

function file(name: string, contents: Buffer | string = 'x'): string {
  const path = join(root, name)
  writeFileSync(path, contents)
  return path
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'msteams-outbound-'))
  stateDir = join(root, 'state')
  pendingDir = join(stateDir, 'pending-uploads')
  mkdirSync(pendingDir, { recursive: true })
  pending = new PendingUploadStore(pendingDir)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('planOutboundFiles routing', () => {
  const plan = (paths: string[], conversationType: string, sharePointSiteId?: string) =>
    planOutboundFiles(paths, { conversationType, stateDir, sharePointSiteId })

  test('a small image goes inline everywhere', () => {
    const png = file('chart.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    for (const type of ['personal', 'groupChat', 'channel']) {
      expect(plan([png], type, SITE)[0].kind).toBe('inline')
    }
  })

  test('a document in a DM is offered by consent card', () => {
    const [entry] = plan([file('report.pdf', '%PDF')], 'personal')

    expect(entry.kind).toBe('consent')
    expect(entry.kind === 'consent' && entry.contentType).toBe('application/pdf')
  })

  test('a document in a channel or group chat goes through SharePoint', () => {
    for (const type of ['channel', 'groupChat']) {
      expect(plan([file('report.pdf', '%PDF')], type, SITE)[0].kind).toBe('sharepoint')
    }
  })

  test('a large image outside a DM goes through SharePoint, not inline', () => {
    // OpenClaw's router falls through to the inline branch here and emits a
    // data URI Teams rejects for being too big. This is the pin against
    // re-importing that bug.
    const big = file('huge.png', Buffer.alloc(MAX_INLINE_IMAGE_BYTES))

    expect(plan([big], 'channel', SITE)[0].kind).toBe('sharepoint')
    expect(plan([big], 'personal')[0].kind).toBe('consent')
  })

  test('an unknown file type still travels, as octet-stream', () => {
    const [entry] = plan([file('build.tar.zst', 'binary')], 'personal')

    expect(entry.kind === 'consent' && entry.contentType).toBe('application/octet-stream')
  })
})

describe('planOutboundFiles refusals', () => {
  test('a channel file with no site configured names the setting and what still works', () => {
    const err = (() => {
      try {
        planOutboundFiles([file('report.pdf', '%PDF')], { conversationType: 'channel', stateDir })
      } catch (e) {
        return e as Error & { code?: string }
      }
    })()

    // send.ts maps this discriminant to "not configured" rather than "bad usage".
    expect(err?.code).toBe('sharepoint_unconfigured')
    expect(err?.message).toMatch(/MSTEAMS_SHAREPOINT_SITE_ID/)
    expect(err?.message).toMatch(/SETUP\.md/)
    expect(err?.message).toMatch(/DM file sends are unaffected/)
  })

  test('group-chat files degrade with an explanation when the preview API is not relied on', () => {
    expect(() =>
      planOutboundFiles([file('report.pdf', '%PDF')], {
        conversationType: 'groupChat',
        stateDir,
        sharePointSiteId: SITE,
        groupChatFiles: false,
      }),
    ).toThrow(/Files work in DMs and channels/)
  })

  test('an unrecognized conversation type is refused rather than guessed', () => {
    expect(() =>
      planOutboundFiles([file('report.pdf')], { conversationType: 'weird', stateDir }),
    ).toThrow(/unrecognized conversation type/)
  })

  test('more than ten files is refused before anything is read', () => {
    const paths = Array.from({ length: 11 }, (_, i) => file(`f${i}.pdf`))

    expect(() => planOutboundFiles(paths, { conversationType: 'personal', stateDir })).toThrow(
      /exceeds the 10-attachment limit/,
    )
  })

  test('an empty file is refused rather than offered', () => {
    expect(() =>
      planOutboundFiles([file('empty.pdf', '')], { conversationType: 'personal', stateDir }),
    ).toThrow(/the file is empty/)
  })

  test('the channel state dir is never sendable', () => {
    writeFileSync(join(stateDir, '.env'), 'MSTEAMS_APP_PASSWORD=secret')

    expect(() =>
      planOutboundFiles([join(stateDir, '.env')], { conversationType: 'personal', stateDir }),
    ).toThrow(/refusing to send channel state/)
  })

  test('the per-file ceiling is Teams\' own', () => {
    expect(MAX_OUTBOUND_FILE_BYTES).toBe(100 * 1024 * 1024)
  })
})

describe('deliverOutbound', () => {
  const ITEM = { id: 'item-1', webUrl: 'https://contoso.sharepoint.com/x', name: 'report-abc.pdf' }
  const PROPS = {
    eTag: '"{abc},1"',
    webDavUrl: 'https://contoso.sharepoint.com/AgentShared/report-abc.pdf',
    name: 'report-abc.pdf',
  }

  let posted: Record<string, any>[]
  let graphCalls: string[]

  const graphFetch = (async (url: string, init: any) => {
    graphCalls.push(`${init?.method ?? 'GET'} ${url.includes('createLink') ? 'createLink' : url.includes('/content') ? 'upload' : 'props'}`)
    if (init?.method === 'PUT') return new Response(JSON.stringify(ITEM), { status: 201 })
    if (url.includes('createLink')) {
      return new Response(JSON.stringify({ link: { webUrl: 'https://share/x' } }), { status: 200 })
    }
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    return new Response(JSON.stringify(PROPS), { status: 200 })
  }) as unknown as typeof fetch

  function params(overrides: Partial<DeliverParams> = {}): DeliverParams {
    return {
      text: '',
      plan: [],
      conversationId: CONV,
      pending,
      post: async activity => {
        posted.push(activity)
        return { id: `sent-${posted.length}` }
      },
      ...overrides,
    }
  }

  const sharepoint = (conversationType: string, listMemberIds = async () => ['user-a']) => ({
    siteId: SITE,
    conversationType,
    getToken: async () => 'token',
    listMemberIds,
    fetchFn: graphFetch,
  })

  beforeEach(() => {
    posted = []
    graphCalls = []
  })

  test('a file-only reply sends no empty message ahead of the file', () => {
    // chunkText('') yields one empty chunk; posting it would put a blank
    // message above the attachment.
    return deliverOutbound(
      params({
        plan: planOutboundFiles([file('chart.png', Buffer.from([0x89, 0x50]))], {
          conversationType: 'personal',
          stateDir,
        }),
      }),
    ).then(result => {
      expect(posted).toHaveLength(1)
      expect(posted[0].attachments).toBeDefined()
      expect(result.failed).toBeUndefined()
    })
  })

  test('text, then images, then SharePoint cards, then consent cards', async () => {
    const plan = planOutboundFiles(
      [file('chart.png', Buffer.from([0x89, 0x50])), file('report.pdf', '%PDF')],
      { conversationType: 'channel', stateDir, sharePointSiteId: SITE },
    )

    await deliverOutbound(params({ text: 'here you go', plan, sharepoint: sharepoint('channel') }))

    expect(posted.map(a => (a.text ? 'text' : a.attachments[0].contentType))).toEqual([
      'text',
      'image/png',
      'application/vnd.microsoft.teams.card.file.info',
    ])
  })

  test('a consent offer is recorded so the Accept can find its bytes', async () => {
    const plan = planOutboundFiles([file('report.pdf', '%PDF')], {
      conversationType: 'personal',
      stateDir,
    })

    const result = await deliverOutbound(params({ plan }))

    expect(result.offered).toEqual(['report.pdf'])
    const uploadId = posted[0].attachments[0].content.acceptContext.uploadId
    const claimed = pending.claim(uploadId, CONV)
    expect(claimed?.bytes.toString()).toBe('%PDF')
    // Recorded so the file card can replace the consent card in place.
    expect(claimed?.meta.consentCardActivityId).toBe('sent-1')
  })

  test('a consent card that fails to post leaves no snapshot behind', async () => {
    const plan = planOutboundFiles([file('report.pdf', '%PDF')], {
      conversationType: 'personal',
      stateDir,
    })

    const result = await deliverOutbound(
      params({
        plan,
        post: async () => {
          throw new Error('Teams rejected the card')
        },
      }),
    )

    expect(result.failed?.detail).toMatch(/Teams rejected/)
    expect(readdirSync(pendingDir)).toHaveLength(0)
  })

  test('a failure names the offers already sitting in the chat', async () => {
    const plan = planOutboundFiles([file('a.pdf', '%PDF'), file('b.pdf', '%PDF')], {
      conversationType: 'personal',
      stateDir,
    })

    const result = await deliverOutbound(
      params({
        plan,
        post: async activity => {
          posted.push(activity)
          if (posted.length > 1) throw new Error('rate limited')
          return { id: 'sent-1' }
        },
      }),
    )

    // The first card landed, so a caller that retries the whole reply would
    // offer a.pdf twice.
    expect(result.offered).toEqual(['a.pdf'])
    expect(result.failed?.after).toBe(1)
    expect(describeFailure(result.failed!, result.offered)).toMatch(/already offered.*a\.pdf/)
  })

  test('group-chat members are resolved once, before anything is uploaded', async () => {
    let lookups = 0
    const plan = planOutboundFiles([file('a.pdf', '%PDF'), file('b.pdf', '%PDF')], {
      conversationType: 'groupChat',
      stateDir,
      sharePointSiteId: SITE,
    })

    await deliverOutbound(
      params({
        plan,
        sharepoint: sharepoint('groupChat', async () => {
          lookups++
          return ['user-a', 'user-b', 'user-a']
        }),
      }),
    )

    // One lookup for the whole delivery: two files shared with the same people.
    expect(lookups).toBe(1)
    expect(graphCalls[0]).toContain('upload')
  })

  test('an empty member list sends nothing at all, not even the text', async () => {
    const plan = planOutboundFiles([file('report.pdf', '%PDF')], {
      conversationType: 'groupChat',
      stateDir,
      sharePointSiteId: SITE,
    })

    const result = await deliverOutbound(
      params({ text: 'here', plan, sharepoint: sharepoint('groupChat', async () => []) }),
    )

    expect(posted).toHaveLength(0)
    expect(graphCalls).toHaveLength(0)
    expect(result.failed?.detail).toMatch(/member list came back empty/)
  })

  test('a member lookup that throws is fail-closed too', async () => {
    const plan = planOutboundFiles([file('report.pdf', '%PDF')], {
      conversationType: 'groupChat',
      stateDir,
      sharePointSiteId: SITE,
    })

    const result = await deliverOutbound(
      params({
        plan,
        sharepoint: sharepoint('groupChat', async () => {
          throw new Error('members unavailable')
        }),
      }),
    )

    expect(posted).toHaveLength(0)
    expect(result.failed?.detail).toMatch(/members unavailable/)
  })

  test('a channel shares organization-wide without looking up members', async () => {
    let lookups = 0
    const plan = planOutboundFiles([file('report.pdf', '%PDF')], {
      conversationType: 'channel',
      stateDir,
      sharePointSiteId: SITE,
    })

    await deliverOutbound(
      params({
        plan,
        sharepoint: sharepoint('channel', async () => {
          lookups++
          return ['user-a']
        }),
      }),
    )

    expect(lookups).toBe(0)
  })

  test('partial failure reports what already landed', async () => {
    const plan = planOutboundFiles([file('chart.png', Buffer.from([0x89, 0x50]))], {
      conversationType: 'personal',
      stateDir,
    })

    const result = await deliverOutbound(
      params({
        text: 'one\n\n' + 'x'.repeat(5000),
        plan,
        post: async activity => {
          posted.push(activity)
          if (posted.length > 1) throw new Error('rate limited')
          return { id: 'sent-1' }
        },
      }),
    )

    expect(result.sentIds).toEqual(['sent-1'])
    expect(result.failed).toEqual({ after: 1, of: 3, detail: 'rate limited' })
  })

  test('a SharePoint refusal is reported in the operator\'s terms', async () => {
    const plan = planOutboundFiles([file('report.pdf', '%PDF')], {
      conversationType: 'channel',
      stateDir,
      sharePointSiteId: SITE,
    })

    const result = await deliverOutbound(
      params({
        plan,
        sharepoint: {
          ...sharepoint('channel'),
          fetchFn: (async () => new Response(null, { status: 403 })) as unknown as typeof fetch,
        },
      }),
    )

    expect(result.failed?.detail).toMatch(/Sites\.Selected/)
  })
})

describe('describeDelivery', () => {
  test('one part reads as one message', () => {
    expect(describeDelivery({ sentIds: ['a'], offered: [] })).toBe('sent (id: a)')
  })

  test('several parts list their ids', () => {
    expect(describeDelivery({ sentIds: ['a', 'b'], offered: [] })).toBe('sent 2 parts (ids: a, b)')
  })

  test('an offer says plainly that nothing more will happen', () => {
    const described = describeDelivery({ sentIds: ['a'], offered: ['report.pdf'] })

    expect(described).toMatch(/offered report\.pdf/)
    expect(described).toMatch(/do not wait or retry/)
  })

  test('a file-only offer does not claim anything was sent', () => {
    expect(describeDelivery({ sentIds: [], offered: ['report.pdf'] })).toStartWith('offered')
  })
})
