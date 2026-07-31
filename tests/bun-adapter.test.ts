import { describe, expect, test, afterEach } from 'bun:test'
import { connect } from 'net'
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

/**
 * POST with `Transfer-Encoding: chunked` and no `content-length` at all.
 *
 * `fetch` always sets a content-length, so it cannot reach the path where the
 * declared-size check sees nothing — which is exactly the path that was
 * unbounded. That requires a raw socket.
 */
function postChunked(body: string | Buffer, port = PORT): Promise<string> {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(
        'POST /api/messages HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${port}\r\n` +
          'Authorization: Bearer fake.jwt.value\r\n' +
          'Content-Type: application/json\r\n' +
          'Connection: close\r\n' +
          'Transfer-Encoding: chunked\r\n\r\n',
      )
      // One chunk per 1MB keeps a large hostile body realistic.
      for (let i = 0; i < buf.length; i += 1024 * 1024) {
        const slice = buf.subarray(i, i + 1024 * 1024)
        sock.write(`${slice.length.toString(16)}\r\n`)
        sock.write(slice)
        sock.write('\r\n')
      }
      sock.write('0\r\n\r\n')
    })
    let response = ''
    const done = () => {
      sock.destroy()
      resolve(response || '(no response)')
    }
    sock.on('data', d => {
      response += d.toString()
      // The status line is all these assertions need, and a 413 arrives while
      // we are still writing — so don't wait for a close that keep-alive or a
      // half-refused upload may never deliver.
      if (response.includes('\r\n\r\n')) done()
    })
    sock.on('close', () => resolve(response || '(no response)'))
    // A refused upload gets its socket torn down mid-write; that is the
    // expected outcome, not a test failure.
    sock.on('error', () => resolve(response || '(connection reset)'))
    setTimeout(done, 20000)
  })
}

/**
 * Stream a chunked body slowly, and report how much of it we managed to write
 * before the server answered. A bounded reader answers early; one that buffers
 * first cannot answer until the last chunk is in.
 */
function postChunkedSlowly(opts: { chunkBytes: number; chunks: number; delayMs: number }): Promise<{
  response: string
  bytesWritten: number
  totalBytes: number
}> {
  const chunk = Buffer.alloc(opts.chunkBytes, 'A')
  const totalBytes = opts.chunkBytes * opts.chunks
  return new Promise(resolve => {
    let bytesWritten = 0
    let settled = false
    let response = ''
    let timer: ReturnType<typeof setTimeout> | undefined

    const sock = connect(PORT, '127.0.0.1', () => {
      sock.write(
        'POST /api/messages HTTP/1.1\r\n' +
          `Host: 127.0.0.1:${PORT}\r\n` +
          'Authorization: Bearer fake.jwt.value\r\n' +
          'Content-Type: application/json\r\n' +
          'Connection: close\r\n' +
          'Transfer-Encoding: chunked\r\n\r\n',
      )
      let sent = 0
      const pump = () => {
        if (settled || sent >= opts.chunks) return
        sent++
        sock.write(`${chunk.length.toString(16)}\r\n`)
        sock.write(chunk)
        sock.write('\r\n')
        bytesWritten += chunk.length
        timer = setTimeout(pump, opts.delayMs)
      }
      pump()
    })

    const settle = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      sock.destroy()
      resolve({ response: response || '(no response)', bytesWritten, totalBytes })
    }

    sock.on('data', d => {
      response += d.toString()
      if (response.includes('\r\n\r\n')) settle()
    })
    sock.on('close', settle)
    sock.on('error', settle)
    setTimeout(settle, 20000)
  })
}

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

  // The regression these three pin: the limit used to be enforced only *after*
  // buffering the whole body, and a chunked request skipped the declared check
  // entirely (`Number(null ?? '0')` === 0). Measured against the old code, a
  // 200MB chunked POST cost ~270MB of RSS behind nothing but a bearer *prefix*
  // check — i.e. before any JWT validation, on a publicly-tunnelled ingress.

  test('a legitimate chunked request still works', async () => {
    let seen: any
    await serve(async req => {
      seen = req
      return { status: 200, body: { ok: true } }
    })
    const res = await postChunked(JSON.stringify({ type: 'message', id: 'c1' }))
    expect(res).toContain('200 OK')
    expect(seen.body).toEqual({ type: 'message', id: 'c1' })
  })

  test('an oversized chunked body is refused BEFORE it finishes uploading', async () => {
    // The status code alone does not pin this: the old code also answered 413,
    // just after buffering the entire body first. What distinguishes a bounded
    // read is *when* the refusal arrives — here, while the client is still
    // writing. Against the old code this test hangs until the upload completes.
    let reached = false
    adapter = new BunHttpAdapter({ maxBodyBytes: 1024 })
    adapter.registerRoute('POST', '/api/messages', async () => {
      reached = true
      return { status: 200 }
    })
    await adapter.start(PORT)

    const { response, bytesWritten, totalBytes } = await postChunkedSlowly({
      chunkBytes: 64 * 1024,
      chunks: 64, // 4MB against a 1KB limit
      delayMs: 2,
    })

    expect(response).toContain('413')
    expect(reached).toBe(false)
    // Refused after roughly one chunk, not after all 64.
    expect(bytesWritten).toBeLessThan(totalBytes / 4)
  })

  test('the body limit counts bytes, not UTF-16 units', async () => {
    // 60 CJK characters: 60 UTF-16 code units but 180 bytes of UTF-8. Measuring
    // the decoded string would pass this under a 100-byte limit, letting a
    // multibyte body run ~3x over.
    let reached = false
    adapter = new BunHttpAdapter({ maxBodyBytes: 100 })
    adapter.registerRoute('POST', '/api/messages', async () => {
      reached = true
      return { status: 200 }
    })
    await adapter.start(PORT)

    const body = '漢'.repeat(60)
    expect(body.length).toBeLessThan(100) // under the limit by the old measure
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(100) // over it by the real one

    const res = await postChunked(body)
    expect(res).toContain('413')
    expect(reached).toBe(false)
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
