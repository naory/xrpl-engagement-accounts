// A remote policy co-signer, reached over the §6 HTTP API (packages/cosigner/src/server.ts).
// It implements Decider, so an EngagementAgent cannot tell a local CosignerService from a
// remote one, and adds the register/read endpoints the MCP server surfaces. Transport only —
// no signing, no keys: the co-signer holds its own key behind this boundary.
import type { Statement } from '@eng/core'
import type { EngagementRecord } from '@eng/policy'
import type { DecideRequest, DecideResponse } from '@eng/cosigner'
import type { Decider } from './agent.ts'

export interface CosignerClientOptions {
  /** Base URL of the co-signer, e.g. http://127.0.0.1:8787 (a trailing slash is trimmed). */
  baseUrl: string
  /** Shared bearer token (the server requires one off loopback). */
  token?: string | null
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetch?: typeof fetch
}

export interface EngagementView {
  engagement: EngagementRecord
  inflight: unknown[]
}

export class CosignerError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}

export class CosignerClient implements Decider {
  private readonly base: string
  private readonly token: string | null
  private readonly doFetch: typeof fetch
  constructor(opts: CosignerClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '')
    this.token = opts.token ?? null
    this.doFetch = opts.fetch ?? fetch
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }
  }
  private async parse<T>(res: Response): Promise<T> {
    const body = await res.text()
    const data = body ? JSON.parse(body) : {}
    if (!res.ok) throw new CosignerError(res.status, (data as { error?: string }).error ?? `HTTP ${res.status}`)
    return data as T
  }

  /** Register an engagement with the co-signer (POST /v1/engagements). */
  async register(engagement: EngagementRecord, mandate?: Statement | null): Promise<{ ok: true; layers: string[] }> {
    const res = await this.doFetch(`${this.base}/v1/engagements`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ engagement, mandate: mandate ?? null }) })
    return this.parse(res)
  }

  /** Evaluate (and, on SIGN, co-sign) a proposed transaction (POST /v1/decide). */
  async decide(req: DecideRequest): Promise<DecideResponse> {
    const res = await this.doFetch(`${this.base}/v1/decide`, { method: 'POST', headers: this.headers(), body: JSON.stringify(req) })
    return this.parse(res)
  }

  /** The engagement record and in-flight decisions (GET /v1/engagements/:id). */
  async engagement(id: string): Promise<EngagementView> {
    const res = await this.doFetch(`${this.base}/v1/engagements/${encodeURIComponent(id)}`, { headers: this.headers() })
    return this.parse(res)
  }

  /** The signed cosigner.decision/1 records for an engagement (GET …/decisions). */
  async decisions(id: string): Promise<Statement[]> {
    const res = await this.doFetch(`${this.base}/v1/engagements/${encodeURIComponent(id)}/decisions`, { headers: this.headers() })
    return this.parse(res)
  }

  /** Liveness probe (GET /healthz). */
  async health(): Promise<{ ok: boolean; cosigner: string }> {
    return this.parse(await this.doFetch(`${this.base}/healthz`))
  }
}
