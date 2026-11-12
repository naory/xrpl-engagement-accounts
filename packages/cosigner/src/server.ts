// HTTP front for the co-signer. Safe to bind to loopback for local dev with no
// token; to bind anywhere else it requires a shared bearer token (enforced at
// startup). Still a single-tenant front — one co-signer, one shared secret —
// not a multi-user API.
//
//   COSIGNER_SEED=s… XRPL_URL=wss://s.altnet.rippletest.net:51233 \
//   COSIGNER_API_TOKEN=… COSIGNER_BIND=0.0.0.0 npm run cosigner
//
//   POST /v1/engagements          { engagement, mandate? }                         → { ok, layers }
//   POST /v1/decide               { engagementId, stage, tx | txBlob, statements } → DecideResponse
//   GET  /v1/engagements/:id      → engagement record + in-flight decisions
//   GET  /v1/engagements/:id/decisions → signed cosigner.decision/1 records
//   POST /v1/engagements/:id/attestations { statement }                     → Receipt (signed cosigner.receipt/1)
//   POST /v1/engagements/:id/presigned    { outcome, blob }                 → { ok: true }
//   POST /v1/engagements/:id/tick                                           → TickResult[] (completed defaults carry `blob`)
//   GET  /healthz                 → liveness  (open, never rate-limited)
//   GET  /readyz                  → readiness (open, reflects ledger connectivity)
//
// Auth (when a token is set): Authorization: Bearer <token> on every /v1 route.
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import xrpl from 'xrpl'
import type { Template } from '@eng/core'
import type { PolicyDoc } from '@eng/policy'
import { CosignerService } from './service.ts'
import { signerProviderFromEnv, type SignerProvider } from './keys.ts'
import { XrplLedgerSource } from './snapshot.ts'

export function loadLibrary(root: string, extraPolicies: PolicyDoc[] = []): { templates: Template[]; policies: PolicyDoc[] } {
  const read = <T>(dir: string) => fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(root, dir, f), 'utf8')) as T)
  return { templates: read<Template>('templates'), policies: [...read<PolicyDoc>('policies'), ...extraPolicies] }
}

export interface ServerOptions {
  /** Shared bearer token required on every /v1 route. Null/absent ⇒ open (loopback dev only). */
  token?: string | null
  /** Fixed-window per-client-IP rate limit on /v1 routes. Null ⇒ unlimited. */
  rateLimit?: { windowMs: number; max: number } | null
  /** Readiness probe for /readyz, e.g. ledger connectivity. Default: always ready. */
  readiness?: () => boolean | Promise<boolean>
  /** Structured log sink; one object per request. Default: silent (the entrypoint wires stdout). */
  log?: (entry: Record<string, unknown>) => void
  /** Clock, injectable for tests. */
  now?: () => number
}

const json = (res: http.ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(code, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
}

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 1_000_000) throw new BodyTooLarge()
    chunks.push(c as Buffer)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

class BodyTooLarge extends Error { constructor() { super('body too large') } }

/** Constant-time string compare (length is not secret for a shared token). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

/** A minimal fixed-window per-key limiter. In-memory, single-process. */
class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>()
  constructor(private readonly windowMs: number, private readonly max: number, private readonly now: () => number) {}
  /** @returns remaining ms until reset when blocked, or null when allowed. */
  check(key: string): number | null {
    const t = this.now()
    let e = this.hits.get(key)
    if (!e || t >= e.resetAt) { e = { count: 0, resetAt: t + this.windowMs }; this.hits.set(key, e) }
    e.count++
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (t >= v.resetAt) this.hits.delete(k)
    return e.count > this.max ? e.resetAt - t : null
  }
}

export function createServer(svc: CosignerService, opts: ServerOptions = {}): http.Server {
  const now = opts.now ?? Date.now
  const readiness = opts.readiness ?? (() => true)
  const log = opts.log ?? (() => {})
  const limiter = opts.rateLimit ? new RateLimiter(opts.rateLimit.windowMs, opts.rateLimit.max, now) : null
  const token = opts.token ?? null

  return http.createServer(async (req, res) => {
    const started = now()
    const url = new URL(req.url ?? '/', 'http://localhost')
    const ip = req.socket.remoteAddress ?? '?'
    const method = req.method ?? 'GET'
    const send = (code: number, bod: unknown, headers?: Record<string, string>) => {
      json(res, code, bod, headers)
      log({ level: code >= 500 ? 'error' : code >= 400 ? 'warn' : 'info', ip, method, path: url.pathname, status: code, ms: now() - started })
    }
    try {
      const parts = url.pathname.split('/').filter(Boolean)

      // Probes: open, never rate-limited, no auth.
      if (method === 'GET' && url.pathname === '/healthz') return send(200, { ok: true, cosigner: svc.address })
      if (method === 'GET' && url.pathname === '/readyz') {
        const ok = await readiness()
        return send(ok ? 200 : 503, { ready: ok, cosigner: svc.address })
      }

      const isV1 = parts[0] === 'v1'
      if (isV1 && limiter) {
        const retry = limiter.check(ip)
        if (retry != null) return send(429, { error: 'rate limited' }, { 'retry-after': String(Math.ceil(retry / 1000)) })
      }
      if (isV1 && token) {
        const auth = req.headers.authorization ?? ''
        const presented = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        if (!presented || !safeEqual(presented, token)) return send(401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' })
      }

      if (method === 'POST' && url.pathname === '/v1/engagements') {
        const b = await body(req)
        return send(200, svc.register(b.engagement as never, (b.mandate as never) ?? null))
      }
      if (method === 'POST' && url.pathname === '/v1/decide') {
        const b = await body(req)
        return send(200, await svc.decide(b as never))
      }
      if (method === 'POST' && isV1 && parts[1] === 'engagements' && parts[2] && parts[3] === 'attestations' && parts.length === 4) {
        const b = await body(req)
        return send(200, await svc.ingest(decodeURIComponent(parts[2]), b.statement as never))
      }
      if (method === 'POST' && isV1 && parts[1] === 'engagements' && parts[2] && parts[3] === 'presigned' && parts.length === 4) {
        const b = await body(req)
        svc.storePresigned(decodeURIComponent(parts[2]), b.outcome as never, b.blob as never)
        return send(200, { ok: true })
      }
      if (method === 'POST' && isV1 && parts[1] === 'engagements' && parts[2] && parts[3] === 'tick' && parts.length === 4) {
        return send(200, await svc.tick(decodeURIComponent(parts[2])))
      }
      if (method === 'GET' && isV1 && parts[1] === 'engagements' && parts[2]) {
        const id = decodeURIComponent(parts[2])
        if (parts[3] === 'decisions') return send(200, svc.decisions(id))
        const e = svc.engagement(id)
        return e ? send(200, { engagement: e, inflight: svc.inflightFor(id) }) : send(404, { error: 'not found' })
      }
      return send(404, { error: 'not found' })
    } catch (e) {
      if (e instanceof BodyTooLarge) return send(413, { error: e.message })
      return send(400, { error: String((e as Error).message ?? e) })
    }
  })
}

/** Resolve server options from the environment and enforce the bind-safety rule. */
export function serverOptionsFromEnv(host: string, env: NodeJS.ProcessEnv = process.env): ServerOptions {
  const token = env.COSIGNER_API_TOKEN || null
  if (!isLoopback(host) && !token) {
    throw new Error(`refusing to bind ${host} without COSIGNER_API_TOKEN (a token is required off loopback)`)
  }
  const max = Number(env.COSIGNER_RATE_MAX ?? 120)
  return {
    token,
    rateLimit: max > 0 ? { windowMs: 60_000, max } : null,
  }
}

// Entrypoint
if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const host = process.env.COSIGNER_BIND ?? '127.0.0.1'
  let options: ServerOptions
  let keys: SignerProvider
  try {
    options = serverOptionsFromEnv(host)
    keys = signerProviderFromEnv()
  } catch (e) {
    console.error(String((e as Error).message ?? e))
    process.exit(1)
  }
  const signer = await keys.getSigner()
  const client = new xrpl.Client(process.env.XRPL_URL ?? 'wss://s.altnet.rippletest.net:51233')
  await client.connect()
  const lib = loadLibrary(process.cwd())
  const svc = new CosignerService({ signer, source: new XrplLedgerSource(client), ...lib, dataDir: process.env.DATA_DIR ?? '.cosigner' })
  const port = Number(process.env.PORT ?? 8787)
  const server = createServer(svc, {
    ...options,
    readiness: () => client.isConnected(),
    log: (e) => console.log(JSON.stringify({ t: new Date().toISOString(), ...e })),
  })
  server.listen(port, host, () =>
    console.log(JSON.stringify({ t: new Date().toISOString(), level: 'info', msg: 'listening', cosigner: signer.address, host, port, key: keys.source, auth: options.token ? 'required' : 'open', rate: options.rateLimit?.max ?? null })),
  )
}
