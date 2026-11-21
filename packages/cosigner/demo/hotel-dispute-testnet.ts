// Clip 3: hotel dispute. Testnet walkthrough of two hotel@2 outcomes against the local co-signer.
//
//   COSIGNER_TICK_SUBMIT=1 COSIGNER_TICK_MS=10000 npm run cosigner:local
//   npm run demo:hotel-dispute
//
// Sub-step 1 is H5: an arbiter ruling on an entry dispute (settle.ruling). Sub-step 2 is H2: the
// hotel never confirms, so default.refund fires. confirmBy on that record is 60 seconds after the
// open ledger's close time. The local co-signer keeps the committed pol_hotel@2.0.0; this script
// does not write or load a policy copy. The scheduler submits the refund (COSIGNER_TICK_SUBMIT=1).
//
// Stdout is addresses, decisions, hashes, and https://testnet.xrpl.org links. No seeds, bearer
// tokens, or signed blobs.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import xrpl from 'xrpl'
import { parseAmount, type AssetDef, type Statement } from '@eng/core'
import type { DecideRequest, DecideResponse } from '@eng/ledger/decide'
import type { EngagementRecord } from '@eng/policy'
import {
  DEMO_HOTEL_BOOKING, HotelFlow, findRepoRoot, hotelOpenSequences, ledgerClock, resolveDataDir,
  type CosignerService, type HotelCast, type HotelStepResult, type Receipt,
} from '../src/index.ts'
import {
  ASF_DEFAULT_RIPPLE, accountInfo, currencyHex, innerResults, iou, iouBalance, lookupTx, sendSimple, serverFees, sleep, unhex,
  type Fees,
} from '../src/xrpl-io.ts'
import { assertKnownTestnetEndpoint } from '../src/testnet-endpoint.ts'

type Wallet = InstanceType<typeof xrpl.Wallet>
type Client = InstanceType<typeof xrpl.Client>
type Json = Record<string, unknown>

const here = path.dirname(fileURLToPath(import.meta.url))
const EXPLORER = 'https://testnet.xrpl.org/transactions/'
const PAUSE_MS = 2000
const CONFIRM_BY_SECS = 60
const FAR_SECS = 3600
const CUR = currencyHex('RLUSD')

const results: Json & { tests: Json[]; balances: Json; txs: Json[] } = {
  demo: 'Clip 3: hotel dispute',
  startedAt: new Date().toISOString(),
  tests: [],
  balances: {},
  txs: [],
}

function say(line: string): void {
  const clean = line.replace(/sEd[1-9A-HJ-NP-Za-km-z]+/g, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  process.stdout.write(`${clean}\n`)
}
const pause = () => sleep(PAUSE_MS)
const resultsDir = path.join(here, 'results')
const stamp = String(results.startedAt).replace(/[:.]/g, '-')
function save(): string {
  fs.mkdirSync(resultsDir, { recursive: true })
  const file = path.join(resultsDir, `hotel-dispute-run-${stamp}.json`)
  fs.writeFileSync(file, JSON.stringify(results, null, 2))
  return file
}
function record(id: string, name: string, expected: string, actual: string, pass: boolean, extra: Json = {}): void {
  results.tests.push({ id, name, expected, actual, pass, ...extra })
  say(`${pass ? '✅' : '❌'} ${id} ${name}`)
  say(`     expected: ${expected}`)
  say(`     actual:   ${actual}`)
}

interface Discovery {
  version: number
  url: string
  address: string
  endpoint: string
  network: string
  tokenPath: string
  trust?: Record<string, string>
}

function loadDiscovery(): { discovery: Discovery; token: string; endpoint: string } {
  const root = findRepoRoot(process.cwd())
  const dataDir = resolveDataDir(process.env.DATA_DIR, root)
  const file = path.join(dataDir, 'local.json')
  if (!fs.existsSync(file)) throw new Error(`refusing to start: ${file} is missing; start npm run cosigner:local first`)
  const discovery = JSON.parse(fs.readFileSync(file, 'utf8')) as Discovery
  if (discovery.version !== 1) throw new Error('refusing to start: local.json version is not 1')
  if (discovery.network !== 'xrpl:1') throw new Error('refusing to start: local.json network must be xrpl:1')
  if (discovery.trust && Object.keys(discovery.trust).length > 0) {
    throw new Error('refusing to start: local co-signer has trust slots set; start cosigner:local without ENG_RLUSD_ISSUER, ENG_ARBITER_ACCREDITOR, or ENG_KYB_ISSUER')
  }
  const endpoint = assertKnownTestnetEndpoint(discovery.endpoint)
  const fromEnv = process.env.XRPL_URL?.trim()
  if (fromEnv && assertKnownTestnetEndpoint(fromEnv) !== endpoint) {
    throw new Error('refusing to start: XRPL_URL does not match the local co-signer endpoint')
  }
  const host = new URL(discovery.url).hostname
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('refusing to start: co-signer URL is not loopback')
  const token = fs.readFileSync(discovery.tokenPath, 'utf8').trim()
  if (!token) throw new Error('refusing to start: bearer file is empty')
  return { discovery, token, endpoint }
}

class LocalApi {
  lastLayers: string[] = []
  constructor(private readonly base: string, private readonly token: string, readonly address: string) {}
  private async call<T>(method: string, pathName: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${pathName}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    let parsed: Json = {}
    try { parsed = text ? JSON.parse(text) as Json : {} } catch { parsed = {} }
    if (!res.ok) {
      const msg = typeof parsed.error === 'string' ? parsed.error : `HTTP ${res.status}`
      throw new Error(msg.split('\n')[0].slice(0, 300))
    }
    return parsed as T
  }
  async register(engagement: EngagementRecord, mandate: Statement | null): Promise<{ ok: true; layers: string[] }> {
    const res = await this.call<{ ok: true; layers: string[] }>('POST', '/v1/engagements', { engagement, mandate })
    this.lastLayers = res.layers
    return res
  }
  storePresigned(id: string, outcome: string, blob: string): Promise<{ ok: true }> {
    return this.call('POST', `/v1/engagements/${encodeURIComponent(id)}/presigned`, { outcome, blob })
  }
  decide(req: DecideRequest): Promise<DecideResponse> {
    return this.call('POST', '/v1/decide', req)
  }
  ingest(id: string, statement: Statement): Promise<Receipt> {
    return this.call('POST', `/v1/engagements/${encodeURIComponent(id)}/attestations`, { statement })
  }
  decisions(id: string): Promise<Statement[]> {
    return this.call('GET', `/v1/engagements/${encodeURIComponent(id)}/decisions`)
  }
  engagement(id: string): Promise<{ engagement: EngagementRecord }> {
    return this.call('GET', `/v1/engagements/${encodeURIComponent(id)}`)
  }
}

function refundBrief(rows: Statement[]): { decision: string; r1: string; failing: string[] } | undefined {
  const hits = rows.flatMap((s) => {
    if (s.type !== 'cosigner.decision/1') return []
    const subject = s.subject as { stage?: string }
    if (subject.stage !== 'default.refund') return []
    const claim = s.claim as { decision?: string; results?: Array<{ id?: string; result?: string; reason?: string }> }
    const results = claim.results ?? []
    const r1 = results.find((r) => r.id === 'R1')
    const failing = results.filter((r) => r.result === 'fail' || r.result === 'error').map((r) => `${r.id} ${r.reason ?? r.result}`)
    return [{ decision: String(claim.decision), r1: r1 ? `${r1.result}${r1.reason ? ` ${r1.reason}` : ''}` : 'absent', failing }]
  })
  return hits.at(-1)
}

async function fund(client: Client, label: string): Promise<Wallet> {
  for (let i = 0; i < 5; i++) {
    try {
      const { wallet } = await client.fundWallet()
      say(`   · funded ${label} ${wallet.address}`)
      return wallet
    } catch (e) {
      say(`   · faucet retry ${label}: ${String((e as Error).message ?? e).split('\n')[0]}`)
      await sleep(5000)
    }
  }
  throw new Error(`faucet failed for ${label}`)
}

async function partyBalances(client: Client, cast: HotelCast, engagement: string): Promise<Record<string, string>> {
  const one = async (account: string): Promise<string> => {
    const info = await accountInfo(client, account)
    if (!info) return 'deleted'
    const balance = await iouBalance(client, account, CUR, cast.issuer.address)
    return balance ?? '0'
  }
  return {
    guest: await one(cast.guest.address),
    hotel: await one(cast.hotel.address),
    fee: await one(cast.service.address),
    arbiter: await one(cast.arbiter.address),
    engagement: await one(engagement),
  }
}
function showBalances(label: string, rows: Record<string, string>): void {
  say(`   · ${label} guest ${rows.guest} hotel ${rows.hotel} fee ${rows.fee} arbiter ${rows.arbiter} engagement ${rows.engagement}`)
}

function basisOf(tx: Json): string {
  const memos = (tx.Memos ?? []) as Array<{ Memo?: { MemoType?: string; MemoData?: string } }>
  for (const m of memos) {
    if (unhex(m.Memo?.MemoType) === 'eng/basis') return unhex(m.Memo?.MemoData)
  }
  return ''
}

async function findValidatedBasis(client: Client, account: string, basis: string): Promise<{ hash: string; tx: Json } | undefined> {
  const r = await client.request({ command: 'account_tx', account, ledger_index_min: -1, ledger_index_max: -1, limit: 40 })
  for (const row of r.result.transactions as unknown as Json[]) {
    const tx = (row.tx_json ?? row.tx) as Json | undefined
    const meta = row.meta as Json | undefined
    const hash = String(row.hash ?? (tx?.hash ?? ''))
    if (!tx || tx.TransactionType !== 'Batch' || row.validated === false) continue
    if (String(meta?.TransactionResult) !== 'tesSUCCESS') continue
    if (basisOf(tx) === basis && hash) return { hash, tx }
  }
  return undefined
}

async function delivered(client: Client, tx: Json): Promise<Array<{ to: string; value: string }>> {
  const out: Array<{ to: string; value: string }> = []
  for (const row of await innerResults(client, tx)) {
    if (!row.applied || row.result !== 'tesSUCCESS') continue
    const t = await lookupTx(client, row.hash)
    const txj = (t?.tx_json ?? t) as Json | undefined
    if (txj?.TransactionType !== 'Payment') continue
    const meta = t?.meta as Json | undefined
    const raw = (meta?.delivered_amount ?? txj.DeliverMax ?? txj.Amount) as { value?: string } | string
    const value = typeof raw === 'object' && raw ? String(raw.value) : String(raw)
    out.push({ to: String(txj.Destination), value })
  }
  return out
}

const near = (a: string, b: string) => Math.abs(Number(a) - Number(b)) < 1e-6

async function main(): Promise<void> {
  const { discovery, token, endpoint } = loadDiscovery()
  const health = await fetch(`${discovery.url}/healthz`, { signal: AbortSignal.timeout(30_000) })
  if (!health.ok) throw new Error('refusing to start: local co-signer /healthz is not ok')
  say('preparing Testnet accounts (the clip starts at the banner)')
  say(`   · co-signer ${discovery.address}`)
  say(`   · endpoint ${endpoint}`)
  const client = new xrpl.Client(endpoint, { timeout: 60_000 })
  await client.connect()
  results.endpoint = endpoint
  results.cosigner = discovery.address
  const fees: Fees = await serverFees(client)

  const issuer = await fund(client, 'issuer')
  const guest = await fund(client, 'guest')
  const hotel = await fund(client, 'hotel')
  const service = await fund(client, 'service')
  const arbiter = await fund(client, 'arbiter')
  const accreditor = await fund(client, 'accreditor')
  const must = async (label: string, run: Promise<{ final: string; hash: string }>) => {
    const r = await run
    results.txs.push({ label, hash: r.hash, final: r.final })
    if (r.final !== 'tesSUCCESS') throw new Error(`${label} ${r.final} ${r.hash}`)
  }
  await must('issuer DefaultRipple', sendSimple(client, issuer, { TransactionType: 'AccountSet', Account: issuer.address, SetFlag: ASF_DEFAULT_RIPPLE }))
  for (const w of [guest, hotel, service]) {
    await must(`trust ${w.address}`, sendSimple(client, w, { TransactionType: 'TrustSet', Account: w.address, LimitAmount: iou(CUR, issuer.address, '10000000') }))
  }
  await must('issue', sendSimple(client, issuer, { TransactionType: 'Payment', Account: issuer.address, Destination: guest.address, Amount: iou(CUR, issuer.address, '10000') }))

  const api = new LocalApi(discovery.url, token, discovery.address)
  const svc = api as unknown as CosignerService
  const cast: HotelCast = { issuer, guest, hotel, arbiter, accreditor, service, currency: CUR }
  const runId = Date.now().toString(36)
  const asset: AssetDef = { code: 'RLUSD', kind: 'IOU', currency: CUR, issuer: issuer.address, decimals: 6 }
  const micro = (v: string) => parseAmount(v, asset).minor
  const log = (m: string) => say(`   · ${m}`)
  const onTx = (label: string, r: { hash: string; final: string }) => { results.txs.push({ label, hash: r.hash, final: r.final }) }
  const h5 = new HotelFlow({
    client, fees, svc, cast, runId, log, onTx,
    timers: { confirmBy: FAR_SECS, checkIn: 20, checkInBy: FAR_SECS, entryDisputeBy: FAR_SECS, deliveryBy: FAR_SECS, claimBy: FAR_SECS, disputeWindowEnds: FAR_SECS },
  })
  const h2 = new HotelFlow({
    client, fees, svc, cast, runId, log, onTx,
    timers: { confirmBy: CONFIRM_BY_SECS, checkIn: FAR_SECS, checkInBy: FAR_SECS, entryDisputeBy: FAR_SECS, deliveryBy: FAR_SECS, claimBy: FAR_SECS, disputeWindowEnds: FAR_SECS },
  })

  for (const s of await h5.accredit()) {
    say(`   · ${s.step} ${s.final ?? ''} ${s.tx ?? ''}`)
    if (s.final !== 'tesSUCCESS') throw new Error(`accreditation ${s.final}`)
  }
  const need = HotelFlow.precreateDrops(fees, 1) * 2 + 15_000_000
  for (let i = 0; i < 5; i++) {
    const have = Number(((await accountInfo(client, service.address))!.account_data as Json).Balance)
    if (have >= need + fees.reserveBase) break
    say(`   · service holds ${have} drops, needs ${need + fees.reserveBase}`)
    try { await client.fundWallet(service) } catch (e) { say(`   · faucet top-up: ${String((e as Error).message ?? e).split('\n')[0]}`); await sleep(5000) }
  }
  const [rulingAccount, refundAccount] = await h5.precreate([1, 1])
  say(`   · ruling account ${rulingAccount.address}`)
  say(`   · refund account ${refundAccount.address}`)
  await h5.waitUntilAged([rulingAccount.address, refundAccount.address], hotelOpenSequences(1) + 4)
  say('   · both accounts are old enough to close')

  say('')
  say('Clip 3: hotel dispute')
  await pause()

  say('')
  say('1. Arbiter ruling (H5)')
  await pause()
  const openedRuling = await h5.open(rulingAccount, 'entryRuled')
  if (openedRuling.step !== 'open' || openedRuling.final !== 'tesSUCCESS') throw new Error(`H5 open ${openedRuling.step} ${openedRuling.final}`)
  const layerNames = api.lastLayers.map((l) => l.split(' ')[0])
  if (!layerNames.includes('pol_hotel@2.0.0') || layerNames.some((l) => l.includes('demo'))) {
    throw new Error(`co-signer registered ${layerNames.join(', ') || 'no layers'}; expected committed pol_hotel@2.0.0`)
  }
  say(`   · policy ${layerNames.join(', ')}`)
  say(`   · guest ${guest.address}`)
  say(`   · hotel ${hotel.address}`)
  say(`   · arbiter ${arbiter.address}`)
  say(`   · engagement ${rulingAccount.address} ${h5.engagementId}`)
  const confirmed = await h5.confirm()
  say(`   · confirm ${confirmed.decision ?? ''} ${confirmed.final ?? ''}`)
  say('   · waiting until the scheduled check-in')
  await h5.waitPast('checkIn')
  const disputed = await h5.openDispute('entry')
  say(`   · dispute entry ${disputed.final ?? ''} ${disputed.tx ?? ''}`)
  if (disputed.tx) say(`${EXPLORER}${disputed.tx}`)
  if (disputed.final !== 'tesSUCCESS') throw new Error(`H5 dispute ${disputed.final}`)
  await pause()
  const { room, deposit, bond } = DEMO_HOTEL_BOOKING
  const want = h5.split(micro(room) - micro(deposit), micro(deposit) + micro(bond))
  const beforeRuling = await partyBalances(client, cast, rulingAccount.address)
  results.balances.h5Before = beforeRuling
  showBalances('before ruling', beforeRuling)
  const ruled = await h5.ruling(want)
  say(`   · ruling settle.ruling ${ruled.final ?? ''} ${ruled.tx ?? ''}`)
  if (ruled.tx) say(`${EXPLORER}${ruled.tx}`)
  await pause()
  const afterRuling = await partyBalances(client, cast, rulingAccount.address)
  results.balances.h5After = afterRuling
  showBalances('after ruling', afterRuling)
  const rulingPay = (ruled.payouts ?? []).map((p) => `${p.value}→${p.to === hotel.address ? 'hotel' : p.to === service.address ? 'fee' : p.to === guest.address ? 'guest' : p.to}`).join(', ')
  const rulingOk = ruled.final === 'tesSUCCESS'
    && afterRuling.engagement === 'deleted'
    && want.every((w) => (ruled.payouts ?? []).some((p) => p.to === w.to && near(p.value, w.value)))
  record('H5', 'Entry dispute: the arbiter splits 300 gross to the hotel, and 100 of the room plus the 10 bond to the guest',
    `tesSUCCESS; payouts ${want.map((w) => w.value).join('+')}; engagement deleted`,
    `${ruled.final}; payouts ${rulingPay || 'none'}; engagement ${afterRuling.engagement}`,
    rulingOk, { tx: ruled.tx })
  if (!rulingOk) throw new Error('H5 did not validate')

  say('')
  say('2. Hotel never confirms: refund default (H2)')
  await pause()
  const openedRefund = await h2.open(refundAccount, 'unconfirmed')
  if (openedRefund.step !== 'open' || openedRefund.final !== 'tesSUCCESS') throw new Error(`H2 open ${openedRefund.step} ${openedRefund.final}`)
  say(`   · engagement ${refundAccount.address} ${h2.engagementId}`)
  say('   · the hotel never confirms the booking')
  const beforeRefund = await partyBalances(client, cast, refundAccount.address)
  results.balances.h2Before = beforeRefund
  showBalances('before refund', beforeRefund)
  const recordTimers = (await api.engagement(h2.engagementId)).engagement.timers ?? {}
  const confirmBy = Date.parse(String(recordTimers.confirmBy ?? ''))
  if (!Number.isFinite(confirmBy)) throw new Error('H2 record has no confirmBy')
  const remainMs = confirmBy - (await ledgerClock(client)).time
  say(`   · confirmBy ${recordTimers.confirmBy} (${Math.round(remainMs / 1000)}s of ledger time left)`)
  if (remainMs < 15_000) throw new Error('confirmBy is too close; the refusal would not be visible')

  let refused: { decision: string; r1: string; failing: string[] } | undefined
  for (let i = 0; i < 30 && !refused; i++) {
    const brief = refundBrief(await api.decisions(h2.engagementId))
    if (brief?.decision === 'REFUSE' && brief.r1 === 'fail NOT_DUE') refused = brief
    else await sleep(2000)
  }
  if (!refused) throw new Error('scheduler did not refuse default.refund with R1 NOT_DUE')
  say('REFUSE R1 NOT_DUE')
  if (refused.failing.some((f) => f !== 'R1 NOT_DUE')) say(`   · also failing: ${refused.failing.filter((f) => f !== 'R1 NOT_DUE').join(', ')}`)
  results.refuse = { decision: refused.decision, r1: refused.r1, failing: refused.failing }
  await pause()

  const waitStarted = Date.now()
  const maxWaitMs = 120_000
  for (;;) {
    const { time } = await ledgerClock(client)
    if (time > confirmBy) break
    if (Date.now() - waitStarted > maxWaitMs) {
      throw new Error(`ledger close time did not pass confirmBy ${String(recordTimers.confirmBy)} within ${maxWaitMs / 1000}s`)
    }
    say(`   · waiting ${Math.ceil((confirmBy - time) / 1000)}s of ledger time for the hotel's confirmation deadline`)
    await sleep(3000)
  }
  let passed: { hash: string; tx: Json } | undefined
  for (let i = 0; i < 40 && !passed; i++) {
    passed = await findValidatedBasis(client, refundAccount.address, 'default.refund')
    if (!passed) await sleep(2000)
  }
  if (!passed) throw new Error('default.refund did not validate; cosigner:local must be running with COSIGNER_TICK_SUBMIT=1')
  const refundPay = await delivered(client, passed.tx)
  say(`PASS default.refund tesSUCCESS ${passed.hash}`)
  say(`${EXPLORER}${passed.hash}`)
  await pause()
  const afterRefund = await partyBalances(client, cast, refundAccount.address)
  results.balances.h2After = afterRefund
  showBalances('after refund', afterRefund)
  const toGuest = refundPay.find((p) => p.to === guest.address)
  const refundOk = afterRefund.engagement === 'deleted'
    && refundPay.length === 1
    && !!toGuest
    && near(toGuest.value, beforeRefund.engagement)
  record('H2', 'Hotel never confirms, so the scheduler submits default.refund',
    `REFUSE R1 NOT_DUE, then tesSUCCESS paying ${beforeRefund.engagement} to the guest; engagement deleted`,
    `REFUSE R1 NOT_DUE; tesSUCCESS ${toGuest ? toGuest.value : 'no guest payout'}; engagement ${afterRefund.engagement}`,
    refundOk, { tx: passed.hash })

  await client.disconnect()
  results.finishedAt = new Date().toISOString()
  const file = save()
  const passedN = results.tests.filter((t) => t.pass).length
  say('')
  say(`${passedN}/${results.tests.length} passed. Results: ${path.relative(findRepoRoot(process.cwd()), file)}`)
  if (!rulingOk || !refundOk) process.exit(1)
}

main().catch((e) => {
  say(`Demo aborted: ${String((e as Error).message ?? e).split('\n')[0].slice(0, 400)}`)
  results.error = String((e as Error).message ?? e).split('\n')[0].slice(0, 400)
  try { say(`Partial results: ${save()}`) } catch { /* ignore */ }
  process.exit(1)
})
