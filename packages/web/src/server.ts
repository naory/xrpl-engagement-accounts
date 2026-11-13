// The web demo server: serves the single-page UI and a small REST API backed by DemoOrchestrator
// (live XRPL Testnet). Loopback by default. When it serves the page it injects window.__ENG_API__
// so the UI switches from its built-in simulation to driving this backend for real.
//
//   npm run web                                   # http://127.0.0.1:8080
//   XRPL_URL=wss://s.devnet.rippletest.net:51233 PORT=8080 npm run web
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv, type HotelPath } from '@eng/cosigner'
import { DemoOrchestrator } from './orchestrator.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
loadEnv([path.resolve(here, '../../..')]) // pick up repo-root .env before reading any config below
const INDEX = path.join(here, '..', 'public', 'index.html')
const LANDING = path.join(here, '..', 'public', 'landing.html')
const PORT = Number(process.env.PORT ?? 8080)
const HOST = process.env.WEB_BIND ?? '127.0.0.1'

const json = (res: http.ServerResponse, code: number, bodyVal: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(bodyVal, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
}
async function readBody<T = Record<string, unknown>>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) { size += (c as Buffer).length; if (size > 1_000_000) throw new Error('body too large'); chunks.push(c as Buffer) }
  return (chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) as T
}

function servePage(res: http.ServerResponse, file: string, inject: string): void {
  const fragment = fs.readFileSync(file, 'utf8')
  const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Engagement Accounts</title>${inject}</head><body>${fragment}</body></html>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(doc)
}

const orch = new DemoOrchestrator()
let connecting: Promise<void> | null = null
const ensureConnected = (): Promise<void> => (connecting ??= orch.connect())

type PayBody = { destination: string; amount: string; invoiceRef: string; withApproval?: boolean }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const m = req.method ?? 'GET'
  try {
    if (m === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return servePage(res, LANDING, '<script>window.__DEMO_URL__="/demo"</script>')
    if (m === 'GET' && (url.pathname === '/demo' || url.pathname === '/demo.html')) return servePage(res, INDEX, `<script>window.__ENG_API__=${JSON.stringify({ live: true, explorer: orch.explorer, pooled: process.env.ENG_USE_POOL === '1' || process.env.ENG_USE_POOL === 'true' })}</script>`)
    if (url.pathname.startsWith('/api/')) {
      await ensureConnected()
      if (m === 'POST' && url.pathname === '/api/provision') return json(res, 200, await orch.provision((await readBody<{ scenario?: string }>(req)).scenario))
      if (m === 'POST' && url.pathname === '/api/escrow') return json(res, 200, await orch.escrow(await readBody<{ path: string }>(req)))
      if (m === 'POST' && url.pathname === '/api/hotel') return json(res, 200, await orch.hotel(await readBody<{ path: HotelPath }>(req)))
      if (m === 'GET' && url.pathname === '/api/hotel') return json(res, 200, orch.hotelStatus())
      if (m === 'POST' && url.pathname === '/api/x402') return json(res, 200, await orch.x402(await readBody<{ path: string; scheme?: string }>(req)))
      if (m === 'POST' && url.pathname === '/api/propose') return json(res, 200, await orch.propose(await readBody<PayBody>(req)))
      if (m === 'POST' && url.pathname === '/api/pay') return json(res, 200, await orch.pay(await readBody<PayBody>(req)))
      if (m === 'POST' && url.pathname === '/api/reclaim') return json(res, 200, await orch.reclaim())
      if (m === 'GET' && url.pathname === '/api/status') return json(res, 200, await orch.status())
      return json(res, 404, { error: 'not found' })
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  } catch (e) {
    json(res, 500, { error: String((e as Error).message ?? e) })
  }
})

const poolMode = process.env.ENG_USE_POOL === '1' || process.env.ENG_USE_POOL === 'true'
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use — another demo server is probably still running.\n  • free it:        lsof -ti tcp:${PORT} | xargs kill\n  • or pick another: PORT=8090 npm run web\n`)
    process.exit(1)
  }
  throw e
})
server.listen(PORT, HOST, () => console.log(`eng web demo → http://${HOST}:${PORT}   (ledger ${orch.url})   pool: ${poolMode ? 'ON — leasing pre-aged accounts (ENG_USE_POOL)' : 'off — self-contained per-run faucet'}`))
process.on('SIGINT', () => { void orch.disconnect().finally(() => process.exit(0)) })
