// HTTP hardening for the co-signer front: auth, per-IP rate limiting, the
// bind-safety rule, readiness vs liveness, and the body cap. Policy behaviour is
// covered by service.test.ts; here the service is a stub so the HTTP layer is
// tested in isolation.
import type { AddressInfo } from 'node:net'
import type http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { CosignerService, createServer, serverOptionsFromEnv, type ServerOptions } from '@eng/cosigner'

const stub = () =>
  ({
    address: 'rCoSignerStub',
    register: () => ({ ok: true, layers: [] }),
    decide: async () => ({ decision: 'SIGN', failing: [], results: [], statementsRejected: [], record: { id: 'rec' } }),
    engagement: (id: string) => (id === 'eng1' ? { engagementId: 'eng1' } : undefined),
    decisions: () => [],
    inflightFor: () => [],
  }) as unknown as CosignerService

const servers: http.Server[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })

async function serve(opts: ServerOptions = {}): Promise<string> {
  const server = createServer(stub(), opts).listen(0, '127.0.0.1')
  servers.push(server)
  await new Promise((r) => server.once('listening', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('co-signer HTTP hardening', () => {
  it('serves liveness on /healthz without auth or rate limiting', async () => {
    const base = await serve({ token: 'secret', rateLimit: { windowMs: 1000, max: 1 } })
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${base}/healthz`)
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ ok: true, cosigner: 'rCoSignerStub' })
    }
  })

  it('reports readiness on /readyz', async () => {
    const down = await serve({ readiness: () => false })
    expect((await fetch(`${down}/readyz`)).status).toBe(503)
    const up = await serve({ readiness: () => true })
    const r = await fetch(`${up}/readyz`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ready: true, cosigner: 'rCoSignerStub' })
  })

  it('requires a bearer token on /v1 routes when one is configured', async () => {
    const base = await serve({ token: 'sh-secret' })
    const noauth = await fetch(`${base}/v1/engagements/eng1`)
    expect(noauth.status).toBe(401)
    expect(noauth.headers.get('www-authenticate')).toBe('Bearer')
    expect((await fetch(`${base}/v1/engagements/eng1`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    const ok = await fetch(`${base}/v1/engagements/eng1`, { headers: { authorization: 'Bearer sh-secret' } })
    expect(ok.status).toBe(200)
    expect((await ok.json()).engagement).toEqual({ engagementId: 'eng1' })
  })

  it('leaves /v1 open when no token is set (loopback dev)', async () => {
    const base = await serve()
    expect((await fetch(`${base}/v1/engagements/eng1`)).status).toBe(200)
  })

  it('rate-limits /v1 per client within a fixed window, then recovers', async () => {
    let t = 0
    const base = await serve({ rateLimit: { windowMs: 1000, max: 2 }, now: () => t })
    expect((await fetch(`${base}/v1/engagements/eng1`)).status).toBe(200)
    expect((await fetch(`${base}/v1/engagements/eng1`)).status).toBe(200)
    const limited = await fetch(`${base}/v1/engagements/eng1`)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    // Probes are exempt even while /v1 is limited.
    expect((await fetch(`${base}/healthz`)).status).toBe(200)
    // Next window: allowed again.
    t += 1001
    expect((await fetch(`${base}/v1/engagements/eng1`)).status).toBe(200)
  })

  it('rejects bodies over the 1MB cap with 413', async () => {
    const base = await serve()
    const big = 'x'.repeat(1_000_001)
    const r = await fetch(`${base}/v1/decide`, { method: 'POST', body: JSON.stringify({ blob: big }) })
    expect(r.status).toBe(413)
  })
})

describe('serverOptionsFromEnv bind-safety', () => {
  it('refuses a non-loopback bind without a token', () => {
    expect(() => serverOptionsFromEnv('0.0.0.0', {})).toThrow(/COSIGNER_API_TOKEN/)
  })
  it('allows a non-loopback bind with a token', () => {
    const o = serverOptionsFromEnv('0.0.0.0', { COSIGNER_API_TOKEN: 'tok' })
    expect(o.token).toBe('tok')
  })
  it('allows loopback with no token and defaults the rate limit', () => {
    const o = serverOptionsFromEnv('127.0.0.1', {})
    expect(o.token).toBeNull()
    expect(o.rateLimit).toEqual({ windowMs: 60_000, max: 120 })
  })
  it('disables the rate limit when COSIGNER_RATE_MAX=0', () => {
    expect(serverOptionsFromEnv('127.0.0.1', { COSIGNER_RATE_MAX: '0' }).rateLimit).toBeNull()
  })
})
