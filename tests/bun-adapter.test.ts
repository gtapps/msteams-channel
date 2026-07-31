import { describe, expect, test, afterEach } from 'bun:test'
import { BunHttpAdapter } from '../src/bun-adapter.js'

let adapter: BunHttpAdapter | undefined
afterEach(async () => {
  await adapter?.stop()
  adapter = undefined
})

const PORT = 3987
const URL = `http://127.0.0.1:${PORT}/api/messages`
const AUTH = { authorization: 'Bearer fake.jwt.value' }

async function serve(handler: Parameters<BunHttpAdapter['registerRoute']>[2], onError?: (e: unknown) => void) {
  adapter = new BunHttpAdapter({ onError })
  adapter.registerRoute('POST', '/api/messages', handler)
  await adapter.start(PORT)
  return adapter
}

const ok = async () => ({ status: 200, body: { ok: true } })

describe('routing', () => {
  test('a registered route is served', async () => {
    await serve(ok)
    const res = await fetch(URL, { method: 'POST', headers: AUTH, body: '{}' })
    expect(res.status).toBe(200)
  })

  test('an unregistered path is 404', async () => {
    await serve(ok)
    const res = await fetch(`http://127.0.0.1:${PORT}/nope`, { method: 'POST', headers: AUTH, body: '{}' })
    expect(res.status).toBe(404)
  })

  test('body and headers reach the handler', async () => {
    let seen: any
    await serve(async req => {
      seen = req
      return { status: 200 }
    })
    await fetch(URL, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'message', id: 'a1' }),
    })
    expect(seen.body).toEqual({ type: 'message', id: 'a1' })
    expect(seen.headers.authorization).toBe(AUTH.authorization)
  })
})

describe('bearer pre-gate', () => {
  test('a request with no authorization header is 401 without reaching the handler', async () => {
    let reached = false
    await serve(async () => {
      reached = true
      return { status: 200 }
    })
    const res = await fetch(URL, { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
    expect(reached).toBe(false)
  })

  test('a non-bearer scheme is 401', async () => {
    await serve(ok)
    const res = await fetch(URL, { method: 'POST', headers: { authorization: 'Basic abc' }, body: '{}' })
    expect(res.status).toBe(401)
  })

  test('an empty bearer value is 401', async () => {
    await serve(ok)
    const res = await fetch(URL, { method: 'POST', headers: { authorization: 'Bearer ' }, body: '{}' })
    expect(res.status).toBe(401)
  })

  test('the pre-gate is case-insensitive on the scheme', async () => {
    await serve(ok)
    const res = await fetch(URL, { method: 'POST', headers: { authorization: 'bearer x.y.z' }, body: '{}' })
    expect(res.status).toBe(200)
  })
})

describe('body bounds', () => {
  test('an oversized body is refused with 413', async () => {
    let reached = false
    adapter = new BunHttpAdapter({ maxBodyBytes: 100 })
    adapter.registerRoute('POST', '/api/messages', async () => {
      reached = true
      return { status: 200 }
    })
    await adapter.start(PORT)
    const res = await fetch(URL, { method: 'POST', headers: AUTH, body: 'x'.repeat(5000) })
    expect(res.status).toBe(413)
    expect(reached).toBe(false)
  })

  test('malformed json is 400, not a crash', async () => {
    await serve(ok)
    const res = await fetch(URL, { method: 'POST', headers: AUTH, body: '{not json' })
    expect(res.status).toBe(400)
  })
})

describe('ingress failure', () => {
  test('a throwing handler becomes 500 so Bot Framework retries', async () => {
    // This is the persist-before-ack contract: a failed queue append must NOT
    // be acked, or the message is silently lost.
    await serve(async () => {
      throw new Error('disk full')
    })
    const res = await fetch(URL, { method: 'POST', headers: AUTH, body: '{}' })
    expect(res.status).toBe(500)
  })

  test('the failure is surfaced to onError rather than swallowed', async () => {
    const errors: unknown[] = []
    await serve(async () => {
      throw new Error('disk full')
    }, e => errors.push(e))
    await fetch(URL, { method: 'POST', headers: AUTH, body: '{}' })
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('disk full')
  })
})

describe('binding', () => {
  test('binds loopback only by default', async () => {
    await serve(ok)
    expect(adapter!.port).toBe(PORT)
    // Reachable on loopback...
    expect((await fetch(URL, { method: 'POST', headers: AUTH, body: '{}' })).status).toBe(200)
  })

  test('hostname is configurable — a container must be able to bind 0.0.0.0', async () => {
    // Loopback inside a container is the container's own; a host-side reverse
    // proxy cannot reach it, so a containerized deploy has to widen the bind.
    adapter = new BunHttpAdapter({ hostname: '0.0.0.0' })
    adapter.registerRoute('POST', '/api/messages', ok)
    await adapter.start(PORT)
    const res = await fetch(URL, { method: 'POST', headers: AUTH, body: '{}' })
    expect(res.status).toBe(200)
  })

  test('stop releases the port', async () => {
    await serve(ok)
    await adapter!.stop()
    adapter = undefined
    const again = new BunHttpAdapter()
    again.registerRoute('POST', '/api/messages', ok)
    await again.start(PORT) // would throw EADDRINUSE if the port leaked
    await again.stop()
  })
})
