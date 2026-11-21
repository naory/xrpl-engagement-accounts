// One-command local co-signer (`npm run cosigner:local`).
// Loopback only. Testnet only. The key is generated once into DATA_DIR and never funded.
// `npm run cosigner` (server.ts) is unchanged: it still requires a seed and can bind off loopback.
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import xrpl from 'xrpl'
import { localSigner } from '@eng/core'
import { loadEnv } from './env.ts'
import { startTickScheduler, submitUntilValidated } from './scheduler.ts'
import { createServer, loadLibrary, loadTrustConfig, assertDeployTrust, reportRulingOverdue, serverOptionsFromEnv, type ServerOptions } from './server.ts'
import { CosignerService } from './service.ts'
import { XrplLedgerSource, type LedgerSource } from './snapshot.ts'
import { SqliteStateStore } from './store/sqlite.ts'
import { findRepoRoot, resolveDataDir } from '@eng/ledger'
import { assertKnownTestnetEndpoint, resolveServiceEndpoint, type TestnetConnect } from './testnet-endpoint.ts'
import { lookupTx, submit } from './xrpl-io.ts'

export { findRepoRoot, resolveDataDir }

const SEED_NAME = 'cosigner.seed'
const TOKEN_NAME = 'cosigner.token'
const DISCOVERY_NAME = 'local.json'
const HOST = '127.0.0.1'
const DEFAULT_TICK_MS = 30_000

export interface LocalDiscovery {
  version: 1
  url: string
  address: string
  publicKey: string
  /** CAIP-2. This command only ever writes Testnet. */
  network: 'xrpl:1'
  endpoint: string
  pid: number
  startedAt: string
  /** Absolute path of the bearer-token file. The token itself is not in this document. */
  tokenPath: string
  /** Present only when at least one T13 slot is configured. */
  trust?: Record<string, string>
}

export interface LocalCosigner {
  url: string
  address: string
  publicKey: string
  dataDir: string
  seedPath: string
  tokenPath: string
  discoveryPath: string
  endpoint: string
  network: 'xrpl:1'
  trust: Record<string, string>
  port: number
  close(): Promise<void>
}

export interface LocalCosignerOptions {
  /** Full environment. Defaults to process.env. A value passed here is not merged with process.env. */
  env?: NodeJS.ProcessEnv
  /** Walk start for the repo root. Defaults to process.cwd(). */
  cwd?: string
  /** Repo root. Defaults to the directory walked up from `cwd` whose package.json has `workspaces`. */
  root?: string
  /** Injected probe so tests never open a socket. */
  connect?: TestnetConnect
  /** Ledger source. When set, no XRPL client is opened. */
  source?: LedgerSource
  /** Install SIGINT/SIGTERM handlers that call close(). The CLI sets this. Tests do not. */
  signals?: boolean
  log?: (line: string) => void
  warn?: (line: string) => void
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

function fsyncDirectory(dir: string): void {
  // Windows rejects fsync on a directory handle. The link() is already the atomic commit.
  if (process.platform === 'win32') return
  const fd = fs.openSync(dir, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function readPrivateFile(file: string): string {
  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode
    // Windows reports no Unix group/other bits (the ACL is elsewhere), so this mask cannot
    // see a world-readable secret there. Skip the check on win32.
    if ((mode & 0o077) !== 0) {
      throw new Error(`refusing to start: ${file} is readable by group or other (mode ${(mode & 0o777).toString(8)}); expected 0600`)
    }
  }
  const text = fs.readFileSync(file, 'utf8').trim()
  if (!text) throw new Error(`refusing to start: ${file} is empty`)
  return text
}

/**
 * Publish `create()` into `<dataDir>/<name>` exactly once.
 * The bytes go to a unique temp file (wx, mode 0600), are fchmod'd and fsynced, then hard-linked
 * onto the final name. link fails with EEXIST when another first-run already published the file,
 * and unlike rename it does not overwrite. The loser reads the winner. A later run refuses the
 * file when group or other can read it.
 */
function ensurePrivateFile(dataDir: string, name: string, create: () => string): string {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') fs.chmodSync(dataDir, 0o700)
  const finalPath = path.join(dataDir, name)
  if (fs.existsSync(finalPath)) return readPrivateFile(finalPath)

  const body = create()
  const tmp = path.join(dataDir, `.${name}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`)
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    fs.fchmodSync(fd, 0o600) // mode on open is masked by umask; fchmod is not
    fs.writeFileSync(fd, `${body}\n`)
    fs.fsyncSync(fd)
  } catch (e) {
    fs.closeSync(fd)
    fs.rmSync(tmp, { force: true })
    throw e
  }
  fs.closeSync(fd)
  let linked = false
  try {
    try {
      fs.linkSync(tmp, finalPath)
      linked = true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  } finally {
    fs.rmSync(tmp, { force: true })
  }
  if (linked) fsyncDirectory(dataDir)
  return readPrivateFile(finalPath)
}

/**
 * Create `<dataDir>/cosigner.seed` exactly once.
 * ed25519, named on purpose. xrpl.js 5.3 Wallet.generate defaults to ed25519, and
 * COSIGNER_SEED_FILE loads that seed back through Wallet.fromSeed with no algorithm
 * argument (the seed's sEd prefix selects ed25519). Fixture wallets, including the
 * test co-signer, are ed25519 as well. Privy stays on its own secp256k1 path.
 */
export function ensureLocalSeed(dataDir: string): string {
  return ensurePrivateFile(dataDir, SEED_NAME, () => {
    const generated = xrpl.Wallet.generate(xrpl.ECDSA.ed25519)
    if (!generated.seed) throw new Error('refusing to start: key generation produced no seed')
    return generated.seed
  })
}

/** Create `<dataDir>/cosigner.token` exactly once. 32 random bytes, base64url. */
function ensureLocalToken(dataDir: string): string {
  return ensurePrivateFile(dataDir, TOKEN_NAME, () => crypto.randomBytes(32).toString('base64url'))
}

function tickInterval(raw: string | undefined, warn: (line: string) => void): number {
  const trimmed = raw?.trim() ?? ''
  if (!trimmed) return DEFAULT_TICK_MS
  if (!/^[1-9]\d*$/.test(trimmed)) {
    warn(`COSIGNER_TICK_MS ${trimmed} is not a positive integer; using ${DEFAULT_TICK_MS}`)
    return DEFAULT_TICK_MS
  }
  return Number(trimmed)
}

async function resolveLocalEndpoint(env: NodeJS.ProcessEnv, connect?: TestnetConnect): Promise<string> {
  const configured = env.XRPL_URL?.trim()
  if (configured) {
    // Refuse before resolveServiceEndpoint, which would return XRPL_URL without probing.
    return assertKnownTestnetEndpoint(configured)
  }
  const resolved = await resolveServiceEndpoint({ env, connect, log: () => {}, warn: () => {} })
  return assertKnownTestnetEndpoint(resolved)
}

function writeDiscovery(file: string, body: LocalDiscovery): void {
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${DISCOVERY_NAME}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  const fd = fs.openSync(tmp, 'wx', 0o644)
  try {
    fs.writeFileSync(fd, `${JSON.stringify(body, null, 2)}\n`)
    fs.fsyncSync(fd)
  } catch (e) {
    fs.closeSync(fd)
    fs.rmSync(tmp, { force: true })
    throw e
  }
  fs.closeSync(fd)
  try {
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
  fsyncDirectory(dir)
}

function removeDiscovery(file: string): void {
  fs.rmSync(file, { force: true })
}

/** Start the loopback co-signer. Throws instead of exiting; the CLI maps that to exit 1. */
export async function startLocalCosigner(options: LocalCosignerOptions = {}): Promise<LocalCosigner> {
  const env = options.env ?? process.env
  const log = options.log ?? ((line: string) => console.log(line))
  const warn = options.warn ?? ((line: string) => console.warn(line))
  const root = options.root ?? findRepoRoot(options.cwd ?? process.cwd())
  const dataDir = resolveDataDir(env.DATA_DIR, root)
  const seedPath = path.join(dataDir, SEED_NAME)
  const tokenPath = path.resolve(dataDir, TOKEN_NAME)
  const discoveryPath = path.join(dataDir, DISCOVERY_NAME)
  const tickMs = tickInterval(env.COSIGNER_TICK_MS, warn)

  const bind = env.COSIGNER_BIND?.trim()
  if (bind && !isLoopback(bind)) throw new Error('refusing to start: cosigner:local binds loopback only')
  if (env.COSIGNER_STORE === 'memory') throw new Error('refusing to start: cosigner:local keeps its state in SQLite')

  const networkEnv = env.ENG_NETWORK?.trim()
  if (networkEnv && networkEnv !== 'xrpl:1') throw new Error('refusing to start: ENG_NETWORK must be xrpl:1')
  const network = 'xrpl:1' as const

  const endpoint = await resolveLocalEndpoint(env, options.connect)
  const lib = loadLibrary(root)
  const trust = loadTrustConfig(env)
  assertDeployTrust(HOST, lib.policies, trust)

  // The value is never read and never printed. The path is the only detail.
  if (env.COSIGNER_SEED?.trim()) warn(`COSIGNER_SEED is ignored; the local co-signer key is ${seedPath}`)

  const seed = ensureLocalSeed(dataDir)
  let wallet: InstanceType<typeof xrpl.Wallet>
  try {
    // Same call as COSIGNER_SEED_FILE: no algorithm argument; the seed encoding selects it.
    wallet = xrpl.Wallet.fromSeed(seed)
  } catch {
    throw new Error(`refusing to start: ${seedPath} is not a usable seed`)
  }
  const signer = localSigner(wallet)
  const fileToken = ensureLocalToken(dataDir)
  // The env value is never interpolated into a log line.
  const envToken = env.COSIGNER_API_TOKEN?.trim() ?? ''
  const token = envToken || fileToken
  if (envToken) log('COSIGNER_API_TOKEN is in use')

  const client = options.source ? undefined : new xrpl.Client(endpoint)
  if (client) {
    try {
      await client.connect()
    } catch (e) {
      try { await client.disconnect() } catch { /* the connect already failed */ }
      throw e
    }
  }
  const source = options.source ?? new XrplLedgerSource(client!)

  let store: SqliteStateStore
  try {
    store = await SqliteStateStore.open({
      file: path.join(dataDir, 'cosigner.db'),
      onLeaseLost: () => {
        console.error(JSON.stringify({ t: new Date().toISOString(), level: 'error', msg: 'store lease lost; exiting' }))
        if (options.signals) process.exit(1)
      },
    })
  } catch (e) {
    try { await client?.disconnect() } catch { /* */ }
    throw e
  }
  let svc: CosignerService | undefined
  let server: http.Server | undefined
  let scheduler: { stop(): Promise<void> } | undefined
  let discoveryWritten = false
  const fail = async (e: unknown): Promise<never> => {
    if (discoveryWritten) removeDiscovery(discoveryPath)
    try { scheduler && await scheduler.stop() } catch { /* already failing */ }
    if (server) await new Promise<void>((r) => server!.close(() => r()))
    try { await svc?.close() } catch { /* the store may already be closed */ }
    try { if (!svc) await store.close() } catch { /* */ }
    try { await client?.disconnect() } catch { /* */ }
    throw e
  }

  try {
    svc = await CosignerService.open({ signer, source, ...lib, dataDir, store, trust })
  } catch (e) {
    return fail(e)
  }

  const serverOptions: ServerOptions = {
    ...serverOptionsFromEnv(HOST, env),
    token,
    loopbackRequestGuard: true,
    readiness: () => (client ? client.isConnected() : true),
    log: (entry) => log(JSON.stringify({ t: new Date().toISOString(), ...entry })),
  }
  server = createServer(svc, serverOptions)
  const port = Number(env.PORT ?? 8787)
  try {
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(port, HOST, () => {
        server!.off('error', reject)
        resolve()
      })
    })
  } catch (e) {
    return fail(e)
  }
  const bound = server.address()
  const boundPort = typeof bound === 'object' && bound ? bound.port : port
  const url = `http://${HOST}:${boundPort}`
  const startedAt = new Date().toISOString()
  const discovery: LocalDiscovery = {
    version: 1,
    url,
    address: signer.address,
    publicKey: signer.publicKey,
    network,
    endpoint,
    pid: process.pid,
    startedAt,
    tokenPath,
    ...(Object.keys(trust).length ? { trust } : {}),
  }
  try {
    writeDiscovery(discoveryPath, discovery)
    discoveryWritten = true
  } catch (e) {
    return fail(e)
  }

  log(`local co-signer ${url} ${signer.address}`)
  log(JSON.stringify({
    t: startedAt, level: 'info', msg: 'listening', url, cosigner: signer.address, host: HOST, port: boundPort,
    network, endpoint, discovery: discoveryPath, auth: 'required', tokenSource: envToken ? 'env' : 'file', tickMs,
  }))

  const say = (entry: Record<string, unknown>) => log(JSON.stringify({ t: new Date().toISOString(), ...entry }))
  scheduler = startTickScheduler(svc, {
    intervalMs: tickMs,
    onAlert: (_engagementId, alert) => reportRulingOverdue(alert, say, env.COSIGNER_ALERT_WEBHOOK),
    onResult: async (engagementId, r) => {
      if (!r.blob) return
      const hash = xrpl.hashes.hashSignedTx(r.blob)
      if (env.COSIGNER_TICK_SUBMIT === '1' && client) {
        const sent = await submitUntilValidated(
          { lookup: (h) => lookupTx(client, h), submit: (b) => submit(client, b, { waitLedgers: 4 }) }, r.blob, hash)
        say({ level: 'info', msg: 'tick submitted', engagementId, outcome: r.outcome, ...sent })
      } else say({ level: 'info', msg: 'tick signed (not submitted; COSIGNER_TICK_SUBMIT is unset)', engagementId, outcome: r.outcome, hash })
    },
    // onError is only STORE_LOCKED (scheduler.ts runRound). A ledger read or a submitUntilValidated
    // throw is logged there and retried next interval; it does not reach this callback.
    onError: (e) => {
      console.error(String(e.message ?? e))
      if (options.signals) process.exit(1)
    },
  })

  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (closing) return closing
    closing = (async () => {
      await scheduler?.stop()
      if (server) await new Promise<void>((r) => server!.close(() => r()))
      removeDiscovery(discoveryPath)
      await svc?.close()
      try { await client?.disconnect() } catch { /* */ }
    })()
    return closing
  }

  if (options.signals) {
    let stopping = false
    const shutdown = (): void => {
      if (stopping) return
      stopping = true
      setTimeout(() => { console.error('shutdown timed out'); process.exit(1) }, 10_000).unref()
      void close().then(() => process.exit(0), (e: unknown) => {
        console.error(String((e as Error).message ?? e))
        process.exit(1)
      })
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  }

  return {
    url, address: signer.address, publicKey: signer.publicKey, dataDir, seedPath, tokenPath, discoveryPath,
    endpoint, network, trust, port: boundPort, close,
  }
}

const here = path.dirname(fileURLToPath(import.meta.url))
const isEntrypoint = process.argv[1] !== undefined && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href
if (isEntrypoint) {
  try {
    const root = findRepoRoot(process.cwd())
    loadEnv([root, here])
    await startLocalCosigner({ root, signals: true })
  } catch (e) {
    console.error(String((e as Error).message ?? e))
    process.exit(1)
  }
}
