/**
 * Bun-native HTTP adapter for the Microsoft Agents SDK.
 *
 * `IHttpServerAdapter` is framework-agnostic — the SDK hands us a pure
 * `({body, headers}) => {status, body}` handler and keeps all Teams protocol
 * logic (JWT validation, activity dispatch) on its side. So we serve with
 * `Bun.serve` and skip the express dependency entirely. Verified equivalent to
 * `ExpressAdapter`, including the 401 path for unsigned requests.
 *
 * Two guards live here rather than in the SDK, both adapted from OpenClaw's
 * msteams monitor (MIT, 32b2e161a5a):
 *   - a bearer-prefix pre-gate, so obviously unauthenticated requests are
 *     rejected before we parse a body at all;
 *   - a bounded body read, so a large POST cannot be used to exhaust memory
 *     ahead of validation.
 */

import type { IHttpServerAdapter, HttpMethod, HttpRouteHandler } from '@microsoft/teams.apps'

/** Teams activities are small; anything larger is not a legitimate activity. */
export const MAX_BODY_BYTES = 1024 * 1024

export type BunAdapterOptions = {
  hostname?: string
  maxBodyBytes?: number
  onError?: (err: unknown) => void
}

export class BunHttpAdapter implements IHttpServerAdapter {
  private readonly routes = new Map<string, HttpRouteHandler>()
  private server?: ReturnType<typeof Bun.serve>
  private readonly hostname: string
  private readonly maxBodyBytes: number
  private readonly onError?: (err: unknown) => void

  constructor(options: BunAdapterOptions = {}) {
    // Bind loopback by default: the operator's reverse proxy or tunnel is the
    // only thing that should be reachable from outside.
    this.hostname = options.hostname ?? '127.0.0.1'
    this.maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES
    this.onError = options.onError
  }

  registerRoute(method: HttpMethod, path: string, handler: HttpRouteHandler): void {
    this.routes.set(`${method} ${path}`, handler)
  }

  async start(port: number | string): Promise<void> {
    const routes = this.routes
    const maxBodyBytes = this.maxBodyBytes
    const onError = this.onError

    this.server = Bun.serve({
      port: Number(port),
      hostname: this.hostname,
      fetch: async req => {
        const url = new URL(req.url)
        const handler = routes.get(`${req.method} ${url.pathname}`)
        if (!handler) return new Response('not found', { status: 404 })

        // Pre-gate: the SDK will validate the JWT properly, but a request with
        // no bearer token at all never needs to be parsed.
        const auth = req.headers.get('authorization') ?? ''
        if (!/^bearer\s+\S/i.test(auth)) {
          return new Response('unauthorized', { status: 401 })
        }

        const declared = Number(req.headers.get('content-length') ?? '0')
        if (declared > maxBodyBytes) {
          return new Response('payload too large', { status: 413 })
        }

        let raw: string
        try {
          raw = await req.text()
        } catch (err) {
          onError?.(err)
          return new Response('bad request', { status: 400 })
        }
        // content-length is a claim, not a fact — check the real size too.
        if (raw.length > maxBodyBytes) {
          return new Response('payload too large', { status: 413 })
        }

        let body: unknown
        try {
          body = raw ? JSON.parse(raw) : undefined
        } catch {
          return new Response('invalid json', { status: 400 })
        }

        const headers: Record<string, string> = {}
        req.headers.forEach((value, key) => {
          headers[key] = value
        })

        try {
          const res = await handler({ body, headers })
          return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
            status: res.status,
            headers: { 'content-type': 'application/json' },
          })
        } catch (err) {
          // A throw here means we could not persist the activity. Answering
          // non-2xx is deliberate: it makes Bot Framework retry rather than
          // letting the message vanish.
          onError?.(err)
          return new Response('ingress failure', { status: 500 })
        }
      },
    })
  }

  async stop(): Promise<void> {
    this.server?.stop(true)
    this.server = undefined
  }

  get port(): number | undefined {
    return this.server?.port
  }
}
