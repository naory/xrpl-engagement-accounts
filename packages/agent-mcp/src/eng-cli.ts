// `eng open` — Testnet only. Seeds go to stdout (and an opt-in file outside the repo).
// The co-signer URL comes from local.json and must be loopback. The bearer is never printed.
import fs from 'node:fs'
import path from 'node:path'
import { DEMO_INVOICE_AMOUNT, DEMO_INVOICE_REF, DEMO_INVOICE_TTL_MS, issueVendorInvoice, type Statement } from '@eng/core'
import { CosignerError, CosignerClient } from './client.ts'
import { resolveCosignerToken } from './cosigner-token.ts'
import { runInvoice } from './invoice-cmd.ts'
import {
  DEMO_IOU_NOTE, OpenPartialError, PROCUREMENT_TEMPLATE, provisionOnEndpoint,
  type OpenDraft, type Provisioned,
} from './open-procurement.ts'
import {
  assertKnownTestnetEndpoint, findRepoRoot, resolveDataDir, resolveTestnetEndpoint,
  TESTNET_ENDPOINTS, type TestnetConnect,
} from '@eng/ledger'

export const TESTNET_SEED_BANNER = 'TESTNET ONLY. These seeds are XRPL Testnet seeds. Do not use them on any other network.'
export const VENDOR_SEED_NOTE = 'VENDOR_SEED signs party.invoice/1 for this vendor. An agent that holds it can forge invoices and defeat W6. Do not put it in the agent client env or an MCP config.'
export const REGISTER_BACKOFF_MS = [1_000, 2_000] as const
export const FETCH_TIMEOUT_MS = 10_000
const CONNECTION_CODES = /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ECONNABORTED|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/

export const HELP = `eng open — open a Testnet owner-wallet/procurement@1 engagement

TESTNET ONLY. Refuses Devnet, mainnet, and any websocket that is not in the Testnet allowlist.
The co-signer is the local one from \`npm run cosigner:local\` (local.json). A hosted URL is refused.
Seeds are printed to stdout. The bearer token is never printed; COSIGNER_API_TOKEN_FILE is the path.
There is no --resume. A retry opens a new account.

Usage:
  npm run eng -- open --template procurement@1 [--endpoint <wss>] [--cosigner-dir <dir>] [--json] [--out <file>]

--template       procurement@1 or owner-wallet/procurement@1
--endpoint       Testnet websocket. Default: the endpoint in local.json
--cosigner-dir   Directory containing local.json. Default: DATA_DIR, or <repo>/.cosigner
--json           JSON on stdout, including the TESTNET ONLY banner.
                 npm prints its own lines first. Use \`npm run --silent eng -- open --json\`, or --out.
--out <file>     Also write that JSON outside this repo, mode 0600
`

export interface EngOpenFlags {
  help: boolean
  template: string | null
  endpoint: string | null
  cosignerDir: string | null
  json: boolean
  out: string | null
}

export function parseEngArgs(argv: string[]): EngOpenFlags {
  const flags: EngOpenFlags = { help: false, template: null, endpoint: null, cosignerDir: null, json: false, out: null }
  const rest = [...argv]
  if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
    flags.help = true
    return flags
  }
  if (rest[0] !== 'open') throw new Error(`unknown command ${rest[0]}. ${HELP}`)
  rest.shift()
  const take = (name: string): string => {
    const value = rest.shift()
    if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`)
    return value
  }
  while (rest.length) {
    const arg = rest.shift()!
    if (arg === '--help' || arg === '-h') flags.help = true
    else if (arg === '--json') flags.json = true
    else if (arg === '--template') flags.template = take('--template')
    else if (arg === '--endpoint') flags.endpoint = take('--endpoint')
    else if (arg === '--cosigner-dir') flags.cosignerDir = take('--cosigner-dir')
    else if (arg === '--out') flags.out = take('--out')
    else if (arg === '--resume') throw new Error('refusing to open: --resume is not supported. Re-run eng open to open a new account.')
    else throw new Error(`unknown argument ${arg}`)
  }
  return flags
}

export function normalizeTemplate(raw: string): typeof PROCUREMENT_TEMPLATE {
  if (raw === 'procurement@1' || raw === PROCUREMENT_TEMPLATE) return PROCUREMENT_TEMPLATE
  throw new Error(`refusing to open: template ${raw} is not supported (procurement@1 only)`)
}

export function assertEngNetwork(value: string | undefined): void {
  const network = value?.trim()
  if (network && network !== 'xrpl:1') throw new Error('refusing to start: ENG_NETWORK must be xrpl:1')
}

export function assertLoopbackCosignerUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('refusing to start: co-signer URL is not loopback')
  }
  if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') || url.username || url.password) {
    throw new Error('refusing to start: co-signer URL is not loopback')
  }
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export interface Discovery {
  url: string
  address: string
  endpoint: string
  tokenPath: string
  network: 'xrpl:1'
}

/** True when `rel` is not strictly inside `root` after both have been realpathed. */
function isOutside(rootReal: string, candidate: string): boolean {
  const rel = path.relative(rootReal, candidate)
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
}

/**
 * The bearer file must be a regular file inside the co-signer data dir.
 * The escape check is lexical on the unresolved data dir, so a symlink above that
 * dir (/tmp → /private/tmp, a symlinked TMPDIR) does not make an in-dir token look outside.
 * The lstat walk runs on the realpath of the data dir and refuses a symlink in the token path.
 */
export function assertTokenInsideDataDir(tokenPath: string, dataDir: string): string {
  const unresolved = path.resolve(dataDir)
  const rel = path.relative(unresolved, path.resolve(unresolved, tokenPath))
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('refusing to start: token file is outside the co-signer data dir')
  }
  let dataReal: string
  try {
    dataReal = fs.realpathSync(unresolved)
  } catch {
    throw new Error(`refusing to start: co-signer data dir is not a directory: ${dataDir}`)
  }
  let cur = dataReal
  for (const part of rel.split(path.sep)) {
    if (part === '' || part === '.' || part === '..') throw new Error('refusing to start: token file is outside the co-signer data dir')
    cur = path.join(cur, part)
    let st: fs.Stats
    try {
      st = fs.lstatSync(cur)
    } catch {
      throw new Error('refusing to start: token file is outside the co-signer data dir')
    }
    if (st.isSymbolicLink()) throw new Error('refusing to start: token path contains a symlink')
  }
  const tokenReal = fs.realpathSync(cur)
  if (isOutside(dataReal, tokenReal)) throw new Error('refusing to start: token file is outside the co-signer data dir')
  return tokenReal
}

export function parseDiscovery(raw: unknown, dataDir: string): Discovery {
  if (!raw || typeof raw !== 'object') throw new Error('refusing to start: local.json is not an object')
  const doc = raw as Record<string, unknown>
  if (doc.version !== 1) throw new Error('refusing to start: local.json version is not 1')
  if (doc.network !== 'xrpl:1') throw new Error('refusing to start: local.json network must be xrpl:1')
  for (const key of ['url', 'address', 'endpoint', 'tokenPath'] as const) {
    if (typeof doc[key] !== 'string' || !(doc[key] as string).trim()) throw new Error(`refusing to start: local.json ${key} is missing`)
  }
  if (doc.trust != null) {
    if (typeof doc.trust !== 'object' || Array.isArray(doc.trust)) throw new Error('refusing to start: local.json trust is not an object')
    const set = Object.values(doc.trust as Record<string, unknown>).some((value) => typeof value === 'string' && value.trim() !== '')
    if (set) {
      throw new Error('refusing to start: local.json trust is set (ENG_RLUSD_ISSUER, ENG_KYB_ISSUER, or ENG_ARBITER_ACCREDITOR). Start npm run cosigner:local without those variables so the demo issuer can bind.')
    }
  }
  return {
    url: assertLoopbackCosignerUrl(doc.url as string),
    address: doc.address as string,
    endpoint: doc.endpoint as string,
    tokenPath: assertTokenInsideDataDir(doc.tokenPath as string, dataDir),
    network: 'xrpl:1',
  }
}

export async function resolveOpenEndpoint(opts: {
  flag?: string | null
  discoveryEndpoint: string
  connect?: TestnetConnect
}): Promise<string> {
  const chosen = opts.flag?.trim() || opts.discoveryEndpoint.trim()
  if (chosen) return assertKnownTestnetEndpoint(chosen)
  return assertKnownTestnetEndpoint(await resolveTestnetEndpoint({ env: {}, connect: opts.connect, endpoints: TESTNET_ENDPOINTS }))
}

export function assertOutsideRepo(file: string, root: string): string {
  // Both sides of the comparison are realpathed. The parent is realpathed before
  // the basename is joined, so a symlink above the repo is not compared to an unresolved path.
  const rootReal = fs.realpathSync(root)
  const parent = path.dirname(path.resolve(file))
  let parentReal: string
  try {
    parentReal = fs.realpathSync(parent)
  } catch {
    throw new Error(`refusing to write seeds: directory does not exist: ${parent}`)
  }
  const resolved = path.join(parentReal, path.basename(path.resolve(file)))
  if (!isOutside(rootReal, resolved)) throw new Error(`refusing to write seeds inside the repo: ${resolved}`)
  return resolved
}

/** True when a path entry exists. A symlink counts, including a dangling one. ENOENT is absent. */
export function pathOccupied(file: string): boolean {
  try {
    fs.lstatSync(file)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}

export function writeOutFile(file: string, root: string, body: string): string {
  const abs = assertOutsideRepo(file, root)
  const fd = fs.openSync(abs, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, body.endsWith('\n') ? body : `${body}\n`)
    fs.fchmodSync(fd, 0o600)
  } finally {
    fs.closeSync(fd)
  }
  return abs
}

export function isRetryableRegisterError(error: unknown): boolean {
  if (error instanceof CosignerError) return error.status === 503
  if (error instanceof DOMException && error.name === 'TimeoutError') return true
  const err = error as { code?: unknown; cause?: { code?: unknown }; message?: string }
  const code = String(err.code ?? err.cause?.code ?? '')
  if (CONNECTION_CODES.test(code)) return true
  // A TypeError is retried only when it is undici's 'fetch failed' with a connection code above.
  // Any other TypeError is not a connection failure.
  return false
}

export function fetchWithTimeout(doFetch: typeof fetch, input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  if (init?.signal) return doFetch(input, init)
  return doFetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
}

export async function registerWithBackoff<T>(fn: () => Promise<T>, opts?: {
  sleep?: (ms: number) => Promise<void>
  delays?: readonly number[]
}): Promise<T> {
  const pause = opts?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const delays = opts?.delays ?? REGISTER_BACKOFF_MS
  const attempts = delays.length + 1
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (error) {
      if (!isRetryableRegisterError(error) || i === attempts - 1) throw error
      await pause(delays[i] ?? delays[delays.length - 1]!)
    }
  }
  throw new Error('register failed')
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function retryCommand(opts: { template: string; cosignerDir: string; endpoint: string | null; json: boolean }): string {
  const parts = [opts.json ? 'npm run --silent eng -- open' : 'npm run eng -- open', `--template ${opts.template === PROCUREMENT_TEMPLATE ? 'procurement@1' : opts.template}`, `--cosigner-dir ${shellQuote(opts.cosignerDir)}`]
  if (opts.endpoint) parts.push(`--endpoint ${shellQuote(opts.endpoint)}`)
  if (opts.json) parts.push('--json')
  return parts.join(' ')
}

function seedOf(wallet: { seed?: string | null } | undefined, label: string): string {
  const seed = wallet?.seed
  if (!seed) throw new Error(`refusing to print: ${label} has no seed`)
  return seed
}

export interface PrintedOpen {
  banner: string
  network: 'xrpl:1'
  demoIou: string
  partial?: boolean
  error?: string
  /** Present on a partial failure. A retry is a new open, not a resume. */
  retryNote?: string
  retryCommand?: string
  /** Vendor seed. Absent from `env`. The agent client and the MCP config must not receive it. */
  operator?: { note: string; VENDOR_SEED: string }
  /** First demo invoice. Not a secret. Present when the vendor wallet exists. */
  invoice?: Statement
  env: {
    ENGAGEMENT_ID: string
    ENGAGEMENT_ACCOUNT: string
    AGENT_SEED: string
    ASSET_ISSUER: string
    ASSET_CODE: 'RLUSD'
    COSIGNER_URL: string
    COSIGNER_API_TOKEN_FILE: string
    XRPL_URL: string
    /** Omitted when the open Batch did not succeed. */
    AGENT_ALLOW_SUBMIT?: '1'
    /** Payee for the demo invoice. An address, not a seed. */
    VENDOR_ADDRESS?: string
    OWNER_SEED: string
    CONTROLLER_SEED: string
    SERVICE_SEED: string
    ISSUER_SEED: string
  }
}

function isoNoMillis(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function printedOpen(opts: {
  draft: OpenDraft
  cosignerUrl: string
  tokenPath: string
  endpoint: string
  /** False when the open Batch did not succeed. Registration failure still allows submit. */
  allowSubmit?: boolean
  partial?: { error: string; retryCommand: string }
  /** Clock for the demo invoice expiry. Defaults to the current time. */
  now?: Date
}): PrintedOpen {
  const account = opts.draft.engagement?.address ?? opts.draft.record?.account
  if (!account || !opts.draft.agent || !opts.draft.treasury || !opts.draft.controller || !opts.draft.service || !opts.draft.issuer) {
    throw new Error('refusing to print: open did not produce the account seeds')
  }
  const vendor = opts.draft.vendorA
  const now = opts.now ?? new Date()
  const issued = isoNoMillis(now)
  const invoice = vendor ? issueVendorInvoice({
    engagementId: opts.draft.engagementId,
    vendorAddress: vendor.address,
    amount: DEMO_INVOICE_AMOUNT,
    invoiceRef: DEMO_INVOICE_REF,
    observedAt: issued,
    issuedAt: issued,
    validUntil: isoNoMillis(new Date(now.getTime() + DEMO_INVOICE_TTL_MS)),
    po: 'PO-OPEN',
  }, vendor) : undefined
  const vendorSeed = vendor ? seedOf(vendor, 'vendor') : undefined
  return {
    banner: TESTNET_SEED_BANNER,
    network: 'xrpl:1',
    demoIou: DEMO_IOU_NOTE,
    ...(opts.partial ? { partial: true, error: opts.partial.error, retryNote: 'full re-open, creates a new account', retryCommand: opts.partial.retryCommand } : {}),
    ...(vendorSeed ? { operator: { note: VENDOR_SEED_NOTE, VENDOR_SEED: vendorSeed } } : {}),
    ...(invoice ? { invoice } : {}),
    env: {
      ENGAGEMENT_ID: opts.draft.engagementId,
      ENGAGEMENT_ACCOUNT: account,
      AGENT_SEED: seedOf(opts.draft.agent, 'agent'),
      ASSET_ISSUER: opts.draft.issuer.address,
      ASSET_CODE: 'RLUSD',
      COSIGNER_URL: opts.cosignerUrl,
      COSIGNER_API_TOKEN_FILE: opts.tokenPath,
      XRPL_URL: opts.endpoint,
      ...(opts.allowSubmit === false ? {} : { AGENT_ALLOW_SUBMIT: '1' as const }),
      ...(vendor ? { VENDOR_ADDRESS: vendor.address } : {}),
      OWNER_SEED: seedOf(opts.draft.treasury, 'owner'),
      CONTROLLER_SEED: seedOf(opts.draft.controller, 'controller'),
      SERVICE_SEED: seedOf(opts.draft.service, 'service'),
      ISSUER_SEED: seedOf(opts.draft.issuer, 'issuer'),
    },
  }
}

export function formatOpen(doc: PrintedOpen, asJson: boolean): string {
  if (asJson) return `${JSON.stringify(doc, null, 2)}\n`
  const env = doc.env
  const lines = [
    doc.banner,
    doc.demoIou,
    '',
  ]
  if (doc.partial) {
    lines.push(`Partial failure. ${doc.error}`, `Retry (full re-open, creates a new account): ${doc.retryCommand}`, '')
  }
  lines.push(
    'Agent env. Paste these lines into the MCP client. No vendor seed.',
    `ENGAGEMENT_ID=${env.ENGAGEMENT_ID}`,
    `ENGAGEMENT_ACCOUNT=${env.ENGAGEMENT_ACCOUNT}`,
    `AGENT_SEED=${env.AGENT_SEED}`,
    `ASSET_ISSUER=${env.ASSET_ISSUER}`,
    `ASSET_CODE=${env.ASSET_CODE}`,
    `COSIGNER_URL=${env.COSIGNER_URL}`,
    `COSIGNER_API_TOKEN_FILE=${env.COSIGNER_API_TOKEN_FILE}`,
    `XRPL_URL=${env.XRPL_URL}`,
  )
  if (env.AGENT_ALLOW_SUBMIT) lines.push(`AGENT_ALLOW_SUBMIT=${env.AGENT_ALLOW_SUBMIT}`)
  if (env.VENDOR_ADDRESS) lines.push(`VENDOR_ADDRESS=${env.VENDOR_ADDRESS}`)
  lines.push('')
  if (doc.invoice) {
    lines.push(
      `Invoice for pay_vendor (not a secret). Amount ${DEMO_INVOICE_AMOUNT} is under the approval threshold. validUntil is the expiry. Bound to ${env.ENGAGEMENT_ID} and ${env.VENDOR_ADDRESS}.`,
      JSON.stringify(doc.invoice, null, 2),
      '',
    )
  }
  lines.push(
    'These seeds are not the agent env and are not read by npm run mcp.',
    `OWNER_SEED=${env.OWNER_SEED}`,
    `CONTROLLER_SEED=${env.CONTROLLER_SEED}`,
    `SERVICE_SEED=${env.SERVICE_SEED}`,
    `ISSUER_SEED=${env.ISSUER_SEED}`,
    '',
  )
  if (doc.operator) {
    lines.push(
      'Operator only. Do not paste this into the agent client or an MCP config.',
      doc.operator.note,
      `VENDOR_SEED=${doc.operator.VENDOR_SEED}`,
      '',
    )
  }
  return lines.join('\n')
}

export interface EngIo {
  env: NodeJS.ProcessEnv
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
  readFile: (file: string) => string
  fetch: typeof fetch
  connect?: TestnetConnect
  sleep: (ms: number) => Promise<void>
  provision: typeof provisionOnEndpoint
  now: () => Date
}

function draftOf(opened: Provisioned): OpenDraft {
  return { ...opened, stranger: opened.stranger }
}

async function health(url: string, address: string, doFetch: typeof fetch): Promise<void> {
  let res: Response
  try {
    res = await fetchWithTimeout(doFetch, `${url}/healthz`)
  } catch {
    throw new Error(`refusing to start: local co-signer is not reachable at ${url}`)
  }
  if (!res.ok) throw new Error(`refusing to start: local co-signer health returned ${res.status}`)
  const body = await res.json() as { cosigner?: string }
  if (body.cosigner !== address) throw new Error('refusing to start: local co-signer address does not match local.json')
}

export async function runEng(argv: string[], io: EngIo): Promise<number> {
  if (argv[0] === 'invoice') {
    return runInvoice(argv.slice(1), { stdout: io.stdout, stderr: io.stderr, readFile: io.readFile, now: io.now })
  }
  const flags = parseEngArgs(argv)
  if (flags.help) {
    io.stdout(HELP.endsWith('\n') ? HELP : `${HELP}\n`)
    return 0
  }
  assertEngNetwork(io.env.ENG_NETWORK)
  if (!flags.template) throw new Error('--template is required. procurement@1 only.')
  const template = normalizeTemplate(flags.template)
  const root = findRepoRoot(io.cwd)
  const dataDir = flags.cosignerDir
    ? (path.isAbsolute(flags.cosignerDir) ? path.resolve(flags.cosignerDir) : path.resolve(root, flags.cosignerDir))
    : resolveDataDir(io.env.DATA_DIR, root)
  const discoveryPath = path.join(dataDir, 'local.json')
  let raw: unknown
  try {
    raw = JSON.parse(io.readFile(discoveryPath))
  } catch {
    throw new Error(`refusing to start: no local.json at ${discoveryPath}. Run npm run cosigner:local first.`)
  }
  const discovery = parseDiscovery(raw, dataDir)
  const endpoint = await resolveOpenEndpoint({ flag: flags.endpoint, discoveryEndpoint: discovery.endpoint, connect: io.connect })
  let outPath: string | null = null
  if (flags.out) {
    outPath = assertOutsideRepo(flags.out, root)
    if (pathOccupied(outPath)) throw new Error(`refusing to write seeds: ${outPath} already exists`)
  }
  const token = resolveCosignerToken(io.env, { filePath: discovery.tokenPath, warn: io.stderr, readFile: io.readFile })
  if (!token) throw new Error(`refusing to start: no bearer at ${discovery.tokenPath}`)
  await health(discovery.url, discovery.address, io.fetch)
  const engagementId = `eng_open_${io.now().getTime().toString(36)}`
  const retry = retryCommand({
    template,
    cosignerDir: dataDir,
    endpoint: flags.endpoint,
    json: flags.json,
  })
  const emit = (draft: OpenDraft, partial?: { error: string; allowSubmit: boolean }): number => {
    const doc = printedOpen({
      draft,
      cosignerUrl: discovery.url,
      tokenPath: discovery.tokenPath,
      endpoint,
      allowSubmit: partial ? partial.allowSubmit : true,
      partial: partial ? { error: partial.error, retryCommand: retry } : undefined,
      now: io.now(),
    })
    const text = formatOpen(doc, flags.json)
    io.stdout(text)
    if (flags.json) io.stderr(`${TESTNET_SEED_BANNER}\n`)
    if (outPath) {
      const written = writeOutFile(outPath, root, text)
      io.stderr(`wrote ${written} mode 0600\n`)
    }
    return partial ? 1 : 0
  }
  let opened: Provisioned
  try {
    opened = await io.provision(endpoint, {
      cosignerAddress: discovery.address,
      engagementId,
      log: (line) => io.stderr(`${line}\n`),
      now: io.now,
    })
  } catch (error) {
    if (error instanceof OpenPartialError && error.draft.agent && error.draft.engagement) {
      return emit(error.draft, { error: error.message, allowSubmit: false })
    }
    throw error
  }
  try {
    const client = new CosignerClient({
      baseUrl: discovery.url,
      token,
      fetch: (input, init) => fetchWithTimeout(io.fetch, input, init),
    })
    await registerWithBackoff(() => client.register(opened.record, opened.mandate), { sleep: io.sleep })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return emit(draftOf(opened), { error: `registration failed: ${message}`, allowSubmit: true })
  }
  return emit(draftOf(opened))
}

export function defaultEngIo(over: Partial<EngIo> = {}): EngIo {
  return {
    env: process.env,
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readFile: (file) => fs.readFileSync(file, 'utf8'),
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    provision: provisionOnEndpoint,
    now: () => new Date(),
    ...over,
  }
}
