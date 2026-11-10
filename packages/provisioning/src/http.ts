// HTTP front for the provisioning coordinator (eng.provision/1). Single-tenant, loopback dev use;
// put it behind the same bearer-token pattern as the co-signer before exposing it off loopback.
//
//   POST /v1/provision/sessions                  { spec }                        → CreatedSession
//   POST /v1/provision/sessions/:id/enroll       Enrollment                       → EnrollResult
//   GET  /v1/provision/sessions/:id              → { complete, enrolled, remaining, plan? }
//   GET  /healthz
import http from 'node:http'
import { ProvisioningCoordinator, type Enrollment, type SessionSpec } from './protocol.ts'

const json = (res: http.ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
}
async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 1_000_000) throw new Error('body too large')
    chunks.push(c as Buffer)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

export function createProvisioningServer(coord: ProvisioningCoordinator): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean)
    const method = req.method ?? 'GET'
    try {
      if (method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true })
      if (method === 'POST' && url.pathname === '/v1/provision/sessions') {
        const b = await readBody(req)
        return json(res, 200, coord.createSession(b.spec as SessionSpec))
      }
      if (parts[0] === 'v1' && parts[1] === 'provision' && parts[2] === 'sessions' && parts[3]) {
        const id = decodeURIComponent(parts[3])
        if (method === 'POST' && parts[4] === 'enroll') {
          const b = await readBody(req)
          return json(res, 200, coord.enrol({ ...(b as unknown as Enrollment), sessionId: id }))
        }
        if (method === 'GET' && !parts[4]) {
          const status = coord.status(id)
          return json(res, 200, { ...status, plan: status.complete ? coord.plan(id) : null })
        }
      }
      return json(res, 404, { error: 'not found' })
    } catch (e) {
      return json(res, 400, { error: String((e as Error).message ?? e) })
    }
  })
}
