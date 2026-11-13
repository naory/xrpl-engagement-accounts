// Hotel stay escrow (hotel@2) on XRPL Testnet: every path of spec §7.1 through the policy co-signer.
//
//   npm install && npm run demo:hotel        (from the repo root; ~25 min, most of it the AccountDelete age wait)
//   XRPL_URL=wss://s.devnet.rippletest.net:51233 npm run demo:hotel
//
// All engagement accounts are pre-created first, then the script waits until each can be deleted
// (Sequence + 256 ≤ ledger index, counting the open Batch's Sequence numbers), then the eight paths run
// concurrently, each opening its own account when it starts (timers count from open). Keys are fresh per
// run; results land in demo/results/hotel-run-*.json, with the co-signer's decision log beside them.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import xrpl from 'xrpl'
import { localSigner, type Template } from '@eng/core'
import { layerHash, type PolicyDoc } from '@eng/policy'
import {
  CosignerService, DEMO_HOTEL_BOOKING, DEMO_HOTEL_TIMERS, HOTEL_PATHS, HotelFlow, XrplLedgerSource,
  type HotelCast, type HotelPath, type HotelStepResult,
} from '../src/index.ts'
import { ASF_DEFAULT_RIPPLE, accountInfo, currencyHex, iou, sendSimple, serverFees, sleep, type SubmitResult } from '../src/xrpl-io.ts'

type Wallet = InstanceType<typeof xrpl.Wallet>
type Json = Record<string, unknown>

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const URL_ = process.env.XRPL_URL ?? 'wss://s.altnet.rippletest.net:51233'
const EXPLORER = URL_.includes('devnet') ? 'https://devnet.xrpl.org/transactions/' : 'https://testnet.xrpl.org/transactions/'
const CUR = currencyHex('RLUSD')
const RUN = Date.now().toString(36)

// ── Results ────────────────────────────────────────────────────────────────
const results: Json & { tests: Json[]; accounts: Record<string, string>; txs: Json[]; paths: Record<string, Json> } = {
  demo: 'hotel@2 stay escrow (all paths)', url: URL_, startedAt: new Date().toISOString(), accounts: {}, txs: [], paths: {}, tests: [],
}
function record(id: string, name: string, expected: string, actual: string, pass: boolean, extra: Json = {}) {
  results.tests.push({ id, name, expected, actual, pass, ...extra })
  console.log(`${pass ? '✅' : '❌'} ${id} ${name}\n     expected: ${expected}\n     actual:   ${actual}${extra.tx ? `\n     tx: ${EXPLORER}${extra.tx}` : ''}`)
}
const log = (...a: unknown[]) => console.log('   ·', ...a)
const resultsDir = path.join(here, 'results')
const stamp = String(results.startedAt).replace(/[:.]/g, '-')
function save(): string {
  fs.mkdirSync(resultsDir, { recursive: true })
  const f = path.join(resultsDir, `hotel-run-${stamp}.json`)
  fs.writeFileSync(f, JSON.stringify(results, null, 2))
  return f
}
function must(r: SubmitResult, label: string): SubmitResult {
  results.txs.push({ label, hash: r.hash, final: r.final })
  if (r.final !== 'tesSUCCESS') throw new Error(`${label} failed: ${r.final} (${r.hash})`)
  return r
}
const near = (a: unknown, b: string) => Math.abs(Number(a) - Number(b)) < 1e-9

async function fund(client: InstanceType<typeof xrpl.Client>, label: string): Promise<Wallet> {
  for (let i = 0; i < 5; i++) {
    try {
      const { wallet } = await client.fundWallet()
      results.accounts[label] = wallet.address
      log(`funded ${label}: ${wallet.address}`)
      return wallet
    } catch (e) {
      log(`faucet retry ${label}: ${(e as Error).message}`)
      await sleep(5000)
    }
  }
  throw new Error(`faucet failed for ${label}`)
}

async function main() {
  const client = new xrpl.Client(URL_, { timeout: 60_000 })
  await client.connect()
  console.log(`Connected to ${URL_}\n`)
  const fees = await serverFees(client)
  results.fees = fees

  // ── Cast ──
  const issuer = await fund(client, 'issuer')
  const guest = await fund(client, 'guest (principal)')
  const hotel = await fund(client, 'hotel (counterparty)')
  const service = await fund(client, 'service (fee, AccountDelete destination, pre-create)')
  const arbiter = xrpl.Wallet.generate() // signs only
  const backupArbiter = xrpl.Wallet.generate() // signs only
  const cosigner = xrpl.Wallet.generate() // signs only
  Object.assign(results.accounts, { arbiter: arbiter.address, backupArbiter: backupArbiter.address, cosigner: cosigner.address })

  must(await sendSimple(client, issuer, { TransactionType: 'AccountSet', Account: issuer.address, SetFlag: ASF_DEFAULT_RIPPLE }), 'issuer DefaultRipple')
  for (const w of [guest, hotel, service]) must(await sendSimple(client, w, { TransactionType: 'TrustSet', Account: w.address, LimitAmount: iou(CUR, issuer.address, '10000000') }), `trust line ${w.address}`)
  must(await sendSimple(client, issuer, { TransactionType: 'Payment', Account: issuer.address, Destination: guest.address, Amount: iou(CUR, issuer.address, '10000') }), 'issue 10,000 RLUSD to the guest')

  // ── Co-signer: baseline + a demo copy of pol_hotel@2.0.0 (this run's issuer, rulingWindow 60 s) ──
  const read = <T>(f: string) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')) as T
  const baseline = read<PolicyDoc>('policies/baseline@1.1.0.json')
  const policy = read<PolicyDoc>('policies/hotel@2.0.0.json')
  policy.version = '2.0.0-demo'
  policy.assets!.RLUSD.issuer = issuer.address
  policy.params!.rulingWindow = '60s'
  const template = read<Template>('templates/hotel@2.json')
  const dataDir = path.join(resultsDir, `decisions-hotel-${stamp}`)
  const svc = new CosignerService({ signer: localSigner(cosigner), source: new XrplLedgerSource(client), templates: [template], policies: [baseline, policy], dataDir })
  log(`co-signer ${cosigner.address}; policy layer pol_hotel@2.0.0-demo ${layerHash(policy)} (rulingWindow 60s)`)

  const cast: HotelCast = { issuer, guest, hotel, arbiter, backupArbiter, service, currency: CUR }
  const onTx = (label: string, r: SubmitResult) => results.txs.push({ label, hash: r.hash, final: r.final })
  const flows = Object.fromEntries(HOTEL_PATHS.map((p) => [p, new HotelFlow({
    client, fees, svc, cast, timers: DEMO_HOTEL_TIMERS, policyLayers: [layerHash(policy)], rulingWindowSecs: 60, runId: RUN,
    log: (m) => log(m), onTx,
  })])) as Record<HotelPath, HotelFlow>

  // ── Pre-create every engagement account, then wait until each can be deleted ──
  const accounts = await flows.happy.precreate(HOTEL_PATHS.length)
  HOTEL_PATHS.forEach((p, i) => { results.accounts[`engagement:${p}`] = accounts[i].address })
  log(`pre-created ${accounts.length} engagement accounts`)
  await flows.happy.waitUntilAged(accounts.map((a) => a.address))
  log('all engagement accounts are old enough for AccountDelete')

  // ── Run the paths concurrently (each opens its own account; a few seconds apart) ──
  const runs = await Promise.allSettled(HOTEL_PATHS.map(async (p, i) => {
    await sleep(i * 4000)
    return flows[p].run(p, accounts[i])
  }))
  const steps: Record<HotelPath, HotelStepResult[]> = {} as never
  HOTEL_PATHS.forEach((p, i) => {
    const r = runs[i]
    steps[p] = r.status === 'fulfilled' ? r.value : []
    results.paths[p] = { engagementId: flows[p].engagementId, account: accounts[i].address, steps: steps[p], ...(r.status === 'rejected' ? { error: String((r.reason as Error)?.stack ?? r.reason) } : {}) }
    if (r.status === 'rejected') console.log(`\n❗ path ${p} aborted: ${(r.reason as Error)?.message ?? r.reason}`)
  })
  console.log('')

  // ── Checks (spec §7.1) ──
  const { room, deposit, bond, claim } = DEMO_HOTEL_BOOKING
  const flow = flows.happy
  const S = (p: HotelPath, name: string, nth = 0) => steps[p].filter((s) => s.step === name)[nth]
  const deleted = async (p: HotelPath) => (await accountInfo(client, results.accounts[`engagement:${p}`])) === null
  const fmt = (s?: HotelStepResult) => s ? `${s.decision ?? ''}${s.failing?.length ? ` [${s.failing.join(',')}]` : ''} ${s.final ?? ''}`.trim() : 'step missing'
  const showPay = (s?: HotelStepResult) => (s?.payouts ?? []).map((x) => `${x.value}→${label(x.to)}`).join(', ') || 'none'
  const label = (a: string) => a === guest.address ? 'guest' : a === hotel.address ? 'hotel' : a === service.address ? 'fee' : a
  const exact = (s: HotelStepResult | undefined, want: Array<{ to: string; value: string }>) =>
    !!s?.payouts && s.payouts.length === want.length && want.every((w) => s.payouts!.some((x) => x.to === w.to && near(x.value, w.value)))
  const want = (hotelGross: number, toGuest: number) => flow.split(BigInt(Math.round(hotelGross * 1e6)), BigInt(Math.round(toGuest * 1e6)))
  const m = (v: string) => Number(v)
  const closed = async (id: string, name: string, p: HotelPath, s: HotelStepResult | undefined, payouts: Array<{ to: string; value: string }>, expected: string, needSign = true) => {
    const gone = await deleted(p)
    const ok = (!needSign || s?.decision === 'SIGN') && s?.final === 'tesSUCCESS' && exact(s, payouts) && gone
    record(id, name, `${expected}; payouts ${payouts.map((x) => `${x.value}→${label(x.to)}`).join(', ')}; account deleted`,
      `${fmt(s)}; payouts ${showPay(s)}; deleted=${gone}`, ok, { tx: s?.tx, path: p })
  }

  await closed('H1', 'Happy: confirm → check-in + deposit → minibar claim → guest accepts → settle with review', 'happy', S('happy', 'settle'),
    want(m(room) + m(claim), m(deposit) - m(claim)), 'settle SIGN; tesSUCCESS')
  await closed('H2', 'Hotel never confirms → default.refund completed by the co-signer', 'unconfirmed', S('unconfirmed', 'tick default.refund'),
    [{ to: guest.address, value: room }], 'default.refund SIGN; tesSUCCESS')
  await closed('H3', 'Guest never shows → default.noshow', 'noshow', S('noshow', 'tick default.noshow'),
    want(m(room), 0), 'default.noshow SIGN; tesSUCCESS')
  await closed('H4', 'No room at check-in → entry dispute → hotel concedes (refund.conceded)', 'entryConceded', S('entryConceded', 'refund.conceded'),
    [{ to: guest.address, value: String(m(room) + m(bond)) }], 'refund.conceded SIGN; tesSUCCESS; guest gets room + bond')
  await closed('H5', 'Downgraded room → entry dispute → arbiter + guest partial-refund ruling', 'entryRuled', S('entryRuled', 'ruling:arbiter'),
    want(m(room) - m(deposit), m(deposit) + m(bond)), 'tesSUCCESS (arbiter 4 + guest 3, no co-signer)', false)
  await closed('H6', 'Stay, no claim, silence → default.release', 'silence', S('silence', 'tick default.release'),
    want(m(room), m(deposit)), 'default.release SIGN; tesSUCCESS; deposit back to the guest')
  {
    const s = S('claimUnanswered', 'ruling:arbiter')
    const payouts = want(m(room) + m(claim), m(deposit) - m(claim))
    const gone = await deleted('claimUnanswered')
    const ok = s?.final === 'tesSUCCESS' && exact(s, payouts) && gone && s?.decision === 'SIGN'
    record('H7', 'Claim posted, guest silent → arbiter + hotel default ruling pays the claim (advisory ruling.default recorded)',
      `advisory ruling.default SIGN; tesSUCCESS; payouts ${payouts.map((x) => `${x.value}→${label(x.to)}`).join(', ')}; account deleted`,
      `advisory ${fmt(s)}; payouts ${showPay(s)}; deleted=${gone}`, ok, { tx: s?.tx, path: 'claimUnanswered' })
  }
  await closed('H8', 'Claim disputed, primary arbiter silent past rulingDueBy → backup + guest + co-signer ruling', 'backupRuling', S('backupRuling', 'ruling:backupArbiter', 1),
    want(m(room), m(deposit) + m(bond)), 'ruling.backup SIGN; tesSUCCESS')
  {
    const s = S('backupRuling', 'ruling:backupArbiter', 0)
    record('H9', 'Backup ruling before rulingDueBy', 'REFUSE incl. U1 (NOT_DUE); nothing submitted', `${fmt(s)}; ${reasons(s, ['U1'])}`,
      s?.decision === 'REFUSE' && !!s.failing?.includes('U1') && !s.tx, { path: 'backupRuling' })
  }
  {
    const s = S('happy', 'probe:principal+counterparty')
    record('H10', 'Guest + hotel alone (weight 6 < quorum 7)', 'tefBAD_QUORUM', fmt(s), s?.final === 'tefBAD_QUORUM', { tx: s?.tx, path: 'happy' })
  }
  {
    const s = S('claimUnanswered', 'tick default.release')
    record('H11', 'default.release while a claim is posted', 'REFUSE incl. L5 (CLAIM_POSTED)', `${fmt(s)}; ${reasons(s, ['L5'])}`,
      s?.decision === 'REFUSE' && !!s.failing?.includes('L5'), { path: 'claimUnanswered' })
  }
  {
    const r = S('happy', 'tick default.refund'), n = S('happy', 'tick default.noshow')
    record('H12', 'Open-time default.refund / default.noshow after the deposit', 'both REFUSE incl. BALANCE_CHANGED (R2, N5)',
      `refund ${fmt(r)} (${reasons(r, ['R2'])}); noshow ${fmt(n)} (${reasons(n, ['N5'])})`,
      r?.decision === 'REFUSE' && !!r.failing?.includes('R2') && n?.decision === 'REFUSE' && !!n.failing?.includes('N5'), { path: 'happy' })
  }
  {
    const s = S('entryRuled', 'tick default.noshow')
    record('H13', 'default.noshow while an entry dispute is open (past checkInBy and entryDisputeBy)', 'REFUSE incl. N4 (DISPUTE_OPEN)', `${fmt(s)}; ${reasons(s, ['N4'])}`,
      s?.decision === 'REFUSE' && !!s.failing?.includes('N4'), { path: 'entryRuled' })
  }
  {
    const s = S('backupRuling', 'probe:arbiter+backupArbiter')
    record('H14', 'Arbiter + backup arbiter alone (weight 6 < quorum 7)', 'tefBAD_QUORUM', fmt(s), s?.final === 'tefBAD_QUORUM', { tx: s?.tx, path: 'backupRuling' })
  }

  results.decisionLog = path.relative(root, path.join(dataDir, 'decisions.jsonl'))
  results.decisions = Object.fromEntries(HOTEL_PATHS.map((p) => [p, svc.decisions(flows[p].engagementId).map((d) => ({ id: d.id, stage: (d.subject as Json).stage, decision: d.claim.decision, failing: d.claim.failing }))]))
  await client.disconnect()
  results.finishedAt = new Date().toISOString()
  const f = save()
  const passed = results.tests.filter((t) => t.pass).length
  console.log(`\n${passed}/${results.tests.length} passed. Results: ${path.relative(root, f)}\nDecision log: ${results.decisionLog}`)
  process.exit(passed === results.tests.length ? 0 : 1)
}

/** The reason codes the decision record gives for the named rules (never hard-coded). */
function reasons(s: HotelStepResult | undefined, ids: string[]): string {
  return ids.map((id) => {
    const r = s?.rules?.find((x) => x.id === id)
    return `${id} ${r ? `${r.result}${r.reason ? ` ${r.reason}` : ''}` : 'not evaluated'}`
  }).join(', ')
}

main().catch((e) => {
  console.error('\nDemo aborted:', e)
  results.error = String((e as Error)?.stack ?? e)
  try { console.log('Partial results:', save()) } catch { /* ignore */ }
  process.exit(1)
})
