// Hotel stay escrow (hotel@2) on XRPL Testnet: every path of spec §7.1 through the policy co-signer.
//
//   npm install && npm run demo:hotel        (from the repo root; ~25 min, most of it the AccountDelete age wait)
//   XRPL_URL=wss://s.devnet.rippletest.net:51233 npm run demo:hotel
//
// The service's accreditor first issues the arbiter an ENG/ARBITER Credential (the arbiter accepts it); a deal naming an
// unaccredited arbiter is refused at registration inside HotelFlow.open(), before the open Batch moves any money (H16). All engagement accounts are pre-created
// (reserves sized from each path's nights), then the script waits until each can be deleted (Sequence + 256 ≤ ledger
// index, counting the open Batch's Sequence numbers), then the ten paths run concurrently, each opening its own account
// when it starts (timers count from open). Keys are fresh per run; results land in demo/results/hotel-run-*.json, with
// the co-signer's decision log beside them.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import xrpl from 'xrpl'
import { localSigner, type Template } from '@eng/core'
import { layerHash, type PolicyDoc } from '@eng/policy'
import {
  CosignerService, DEMO_HOTEL_BOOKING, DEMO_HOTEL_TIMERS, HOTEL_PATHS, HotelFlow, XrplLedgerSource, hotelPathNights, hotelTerms, resolveTestnetEndpoint,
  type HotelCast, type HotelPath, type HotelStepResult,
} from '../src/index.ts'
import { ASF_DEFAULT_RIPPLE, accountInfo, currencyHex, iou, iouBalance, sendSimple, serverFees, sleep, type Fees, type SubmitResult } from '../src/xrpl-io.ts'

type Wallet = InstanceType<typeof xrpl.Wallet>
type Json = Record<string, unknown>

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
let URL_ = ''
let EXPLORER = 'https://testnet.xrpl.org/transactions/'
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

/** Top the service up from the faucet until it holds `drops` (+ its own reserve): pre-creating funds every account's Tickets. */
async function ensureXrp(client: InstanceType<typeof xrpl.Client>, w: Wallet, drops: number, fees: Fees): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const have = Number(((await accountInfo(client, w.address))!.account_data as Json).Balance)
    if (have >= drops + fees.reserveBase) return
    log(`service holds ${have / 1e6} XRP, needs ${(drops + fees.reserveBase) / 1e6}: faucet top-up`)
    try { await client.fundWallet(w) } catch (e) { log(`faucet top-up retry: ${(e as Error).message}`); await sleep(5000) }
  }
  throw new Error('could not fund the service for pre-creating the engagement accounts')
}

async function main() {
  URL_ = await resolveTestnetEndpoint()
  EXPLORER = URL_.includes('devnet') ? 'https://devnet.xrpl.org/transactions/' : 'https://testnet.xrpl.org/transactions/'
  results.url = URL_
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
  const arbiter = await fund(client, 'arbiter (accepts its accreditation, then only signs)')
  const accreditor = await fund(client, 'accreditor (the service\'s arbiter accreditor)')
  const cosigner = xrpl.Wallet.generate() // signs only
  const unaccredited = xrpl.Wallet.generate() // an arbiter nobody accredited (H16); never funded
  Object.assign(results.accounts, { cosigner: cosigner.address, 'unaccredited arbiter': unaccredited.address })

  must(await sendSimple(client, issuer, { TransactionType: 'AccountSet', Account: issuer.address, SetFlag: ASF_DEFAULT_RIPPLE }), 'issuer DefaultRipple')
  for (const w of [guest, hotel, service]) must(await sendSimple(client, w, { TransactionType: 'TrustSet', Account: w.address, LimitAmount: iou(CUR, issuer.address, '10000000') }), `trust line ${w.address}`)
  must(await sendSimple(client, issuer, { TransactionType: 'Payment', Account: issuer.address, Destination: guest.address, Amount: iou(CUR, issuer.address, '10000') }), 'issue 10,000 RLUSD to the guest')

  // ── Co-signer: baseline + a demo copy of pol_hotel@2.0.0 (this run's issuer and accreditor, rulingWindow 60 s) ──
  const read = <T>(f: string) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')) as T
  const baseline = read<PolicyDoc>('policies/baseline@1.1.0.json')
  const policy = read<PolicyDoc>('policies/hotel@2.0.0.json')
  policy.version = '2.0.0-demo'
  policy.assets!.RLUSD.issuer = issuer.address
  policy.params!.rulingWindow = '60s'
  // The demo's own ruling-window bounds around its 60 s window (the stock policy allows 3–7 days; register() checks them).
  policy.params!.minRulingWindow = '30s'
  policy.params!.maxRulingWindow = '120s'
  policy.params!.arbiterIssuers = [accreditor.address]
  const template = read<Template>('templates/hotel@2.json')
  const dataDir = path.join(resultsDir, `decisions-hotel-${stamp}`)
  const svc = new CosignerService({ signer: localSigner(cosigner), source: new XrplLedgerSource(client), templates: [template], policies: [baseline, policy], dataDir })
  log(`co-signer ${cosigner.address}; policy layer pol_hotel@2.0.0-demo ${layerHash(policy)} (rulingWindow 60s, arbiterIssuers [${accreditor.address}])`)

  const cast: HotelCast = { issuer, guest, hotel, arbiter, accreditor, service, currency: CUR }
  const onTx = (label: string, r: SubmitResult) => results.txs.push({ label, hash: r.hash, final: r.final })
  const flows = Object.fromEntries(HOTEL_PATHS.map((p) => [p, new HotelFlow({
    client, fees, svc, cast, timers: DEMO_HOTEL_TIMERS, policyLayers: [layerHash(policy)], rulingWindowSecs: 60, runId: RUN,
    log: (m) => log(m), onTx, probeCosigner: cosigner,
  })])) as Record<HotelPath, HotelFlow>

  // ── Accreditation: the accreditor issues ENG/ARBITER to the arbiter, who accepts it ──
  for (const s of await flows.happy.accredit()) if (s.final !== 'tesSUCCESS') throw new Error(`${s.step} failed: ${s.final} (${s.tx})`)
  log(`arbiter ${arbiter.address} accredited by ${accreditor.address} (ENG/ARBITER, accepted)`)

  // ── Pre-create every engagement account (reserves sized from each path's nights), plus one for H16 ──
  await ensureXrp(client, service, [...HOTEL_PATHS.map(hotelPathNights), 1].reduce((n, k) => n + HotelFlow.precreateDrops(fees, k), 0) + 10_000_000, fees)
  const [h16Account] = await flows.happy.precreate([1])
  results.accounts['engagement:unaccredited (H16)'] = h16Account.address

  // ── H16: the real deal flow (HotelFlow.open) with an unaccredited arbiter: the co-signer's gate refuses before money moves ──
  {
    const h16Txs: SubmitResult[] = []
    const h16 = new HotelFlow({
      client, fees, svc, cast: { ...cast, arbiter: unaccredited }, timers: DEMO_HOTEL_TIMERS, policyLayers: [layerHash(policy)], rulingWindowSecs: 60,
      runId: `${RUN}_unaccredited`, log: (m) => log(m), onTx: (label, r) => { if (label.includes('_unaccredited')) h16Txs.push(r); onTx(label, r) },
    })
    const rl = () => iouBalance(client, guest.address, CUR, issuer.address)
    const before = await rl()
    const steps = await h16.run('happy', h16Account)
    await sleep(8000) // a couple of ledgers: anything submitted would have validated by now
    const after = await rl()
    const engRlusd = await iouBalance(client, h16Account.address, CUR, issuer.address)
    results.paths['unaccredited (H16)'] = { engagementId: h16.engagementId, account: h16Account.address, steps }
    const s = steps[0]
    const refused = steps.length === 1 && s?.step === 'register' && !!s.final?.startsWith('NOT_NEUTRAL') && !!s.final?.includes('ARBITER_NOT_ACCREDITED')
    record('H16', 'Unaccredited arbiter in the real deal flow (HotelFlow.open) → the co-signer refuses to register, before any money moves',
      'open(): register() refuses NOT_NEUTRAL (ARBITER_NOT_ACCREDITED); no open Batch submitted; the guest\'s RLUSD unchanged; the engagement account holds no RLUSD',
      `${s?.step}: ${s?.final}; transactions submitted ${h16Txs.length}; guest RLUSD ${before} → ${after}; engagement account RLUSD ${engRlusd}`,
      refused && h16Txs.length === 0 && before === after && Number(engRlusd ?? 0) === 0, { path: 'unaccredited (H16)' })
  }

  // ── Wait until every path's account can be deleted ──
  const accounts = await flows.happy.precreate(HOTEL_PATHS.map(hotelPathNights))
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
  const { room, deposit, bond, claim, partialDeposit } = DEMO_HOTEL_BOOKING
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
  // H8/H9/H14/H17: the arbiter never rules → chargeback-style defaults, completed by the co-signer (chargeback spec §4.3).
  await closed('H8', 'Claim disputed, arbiter silent past its ruling deadline → default.chargebackClaim', 'arbiterSilent', S('arbiterSilent', 'tick default.chargebackClaim', 1),
    want(m(room), m(deposit) + m(bond)), 'default.chargebackClaim SIGN; tesSUCCESS; room to the hotel less the fee, deposit + bond to the guest')
  {
    const s = S('arbiterSilent', 'tick default.chargebackClaim', 0)
    record('H9', 'default.chargebackClaim before the ruling deadline', 'REFUSE incl. G1 (NOT_DUE); nothing submitted', `${fmt(s)}; ${reasons(s, ['G1'])}`,
      s?.decision === 'REFUSE' && !!s.failing?.includes('G1') && s.rules?.find((x) => x.id === 'G1')?.reason === 'NOT_DUE' && !s.tx, { path: 'arbiterSilent' })
  }
  {
    const s = S('arbiterSilent', 'probe:arbiter+cosigner')
    record('H14', 'Arbiter + co-signer alone (weight 6 < quorum 7)', 'tefBAD_QUORUM', fmt(s), s?.final === 'tefBAD_QUORUM', { tx: s?.tx, path: 'arbiterSilent' })
  }
  {
    // 3 nights at floor(400 ÷ 3) = 133.333333; disputed in night 1 → one night to the hotel (less the fee), the rest to the guest.
    const night = BigInt(Math.round(Number(hotelTerms(room, 3).nightly) * 1e6))
    const total = BigInt(Math.round((m(room) + m(deposit) + m(bond)) * 1e6))
    await closed('H17', 'Mid-stay dispute (night 1 of 3), arbiter silent → default.chargebackStay#1', 'staySilent', S('staySilent', 'tick default.chargebackStay#1'),
      flow.split(night, total - night), 'default.chargebackStay#1 SIGN; tesSUCCESS; one night to the hotel less the fee, the remaining nights + deposit + bond to the guest')
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
    // Extra money no longer jams a default (it is swept back to the guest), so after check-in the open-time defaults are
    // refused for what they are: the booking was confirmed (R1) and the guest checked in (N3).
    const r = S('happy', 'tick default.refund'), n = S('happy', 'tick default.noshow'), ns = S('happy', 'tick default.noshowSweep')
    record('H12', 'Open-time default.refund / both default.noshow variants after check-in + deposit', 'all REFUSE: refund R1 (NOT_DUE: confirmed), no-shows N3 (CHECKED_IN)',
      `refund ${fmt(r)} (${reasons(r, ['R1'])}); noshow ${fmt(n)} (${reasons(n, ['N3'])}); noshowSweep ${fmt(ns)} (${reasons(ns, ['N3'])})`,
      r?.decision === 'REFUSE' && !!r.failing?.includes('R1') && [n, ns].every((x) => x?.decision === 'REFUSE' && !!x.failing?.includes('N3')), { path: 'happy' })
  }
  {
    const s = S('entryRuled', 'tick default.noshow')
    record('H13', 'default.noshow while an entry dispute is open (past checkInBy and entryDisputeBy)', 'REFUSE incl. N4 (DISPUTE_OPEN)', `${fmt(s)}; ${reasons(s, ['N4'])}`,
      s?.decision === 'REFUSE' && !!s.failing?.includes('N4'), { path: 'entryRuled' })
  }

  {
    // H15: partial deposit + refused check-in → no-show; the sweep variant returns the partial deposit inside a ticketed
    // ALLORNOTHING Batch (tfPartialPayment), and the exact variant is refused.
    const exact = S('partialDeposit', 'tick default.noshow')
    await closed('H15', 'Partial deposit, hotel refuses check-in → no-show; the guest\'s partial deposit swept back', 'partialDeposit', S('partialDeposit', 'tick default.noshowSweep'),
      [...want(m(room), 0), { to: guest.address, value: partialDeposit }], `exact default.noshow REFUSE incl. N8 (was ${fmt(exact)}); default.noshowSweep SIGN; tesSUCCESS`)
    if (!(exact?.decision === 'REFUSE' && exact.failing?.includes('N8'))) record('H15b', 'Exact no-show refused when the account holds more than the room', 'REFUSE incl. N8', fmt(exact), false, { path: 'partialDeposit' })
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
