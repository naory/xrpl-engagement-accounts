// marketplace-escrow@1 on XRPL Testnet (spec C9). The co-signer runs in this process.
// Wallets come from the Testnet faucet. Seeds are never printed or written.
//
//   npm run demo:marketplace-escrow
//   npm run demo:marketplace-escrow-dispute
//
// The shipped template and policy stay as they are. This run uses an in-memory copy with
// a 45s ship window, a 110s inspect deadline, a 20s ruling SLA, and a 15s alert repeat.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import xrpl from 'xrpl'
import * as keypairs from 'ripple-keypairs'
import { encodeForMultisigning } from 'ripple-binary-codec'
import { localSigner, signStatement, type Template } from '@eng/core'
import { layerHash, type PolicyDoc } from '@eng/policy'
import {
  CosignerService, MarketplaceEscrowFlow, XrplLedgerSource, ledgerClock, resolveTestnetEndpoint,
  type MarketplaceCast, type MarketplaceStepResult,
} from '../src/index.ts'
import {
  ASF_DEFAULT_RIPPLE, accountInfo, buildCloseBatch, currencyHex, currentLedger, hex, iou, memo, multisignBlob, sendSimple, serverFees, sleep, submit, combine,
  type Fees, type SubmitResult,
} from '../src/xrpl-io.ts'

type Wallet = InstanceType<typeof xrpl.Wallet>
type Client = InstanceType<typeof xrpl.Client>
type Json = Record<string, unknown>

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const CLIP3 = process.argv.includes('--clip3')
const RIPPLE_ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV'
const CUR = currencyHex('RLUSD')
const SHIP_SECS = 45
const INSPECT_SECS = 110
const RULING_SECS = 20
const PRICE = '2.00'
const BOND = '0.50'
const XRP_CAP = 50_000_000
let EXPLORER = 'https://testnet.xrpl.org/transactions/'
let liveFees: Fees = { base: 10, reserveBase: 1_000_000, inc: 200_000 }

const results: Json & { tests: Json[]; accounts: Record<string, string>; faucet: Record<string, string>; txs: Json[] } = {
  demo: CLIP3 ? 'Clip 3: marketplace purchase dispute' : 'marketplace-escrow@1',
  startedAt: new Date().toISOString(), accounts: {}, faucet: {}, txs: [], tests: [],
}
const log = (...a: unknown[]) => console.log('   ·', ...a)
function record(id: string, name: string, expected: string, actual: string, pass: boolean, extra: Json = {}) {
  results.tests.push({ id, name, expected, actual, pass, ...extra })
  const link = extra.tx ? `\n     tx: ${EXPLORER}${extra.tx}` : ''
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name}\n     expected: ${expected}\n     actual:   ${actual}${link}`)
}
function save(): void {
  const dir = path.join(here, 'results')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `marketplace-escrow-${String(results.startedAt).replace(/[:.]/g, '-')}.json`), JSON.stringify(results, null, 2))
}
function noted(label: string, r: SubmitResult): SubmitResult {
  results.txs.push({ label, hash: r.hash, final: r.final, explorer: `${EXPLORER}${r.hash}` })
  if (r.final !== 'tesSUCCESS') throw new Error(`${label} failed: ${r.final} (${r.hash})`)
  return r
}
const text = (s?: MarketplaceStepResult) => s ? [s.decision, s.failing?.join(','), s.final].filter(Boolean).join(' ') : 'missing'
function reasons(record: { claim?: unknown } | undefined): string[] {
  const rows = ((record?.claim as { results?: Array<{ reason?: string; result?: string }> } | undefined)?.results) ?? []
  return rows.filter((r) => r.result === 'fail').map((r) => r.reason ?? '')
}

async function fund(client: Client, label: string): Promise<Wallet> {
  for (let i = 0; i < 6; i++) {
    try {
      const funded = await client.fundWallet()
      results.accounts[label] = funded.wallet.address
      results.faucet[label] = String(funded.balance)
      log(`faucet ${label}: ${funded.wallet.address} payout ${funded.balance} XRP`)
      return funded.wallet
    } catch (e) {
      log(`faucet retry ${label}: ${(e as Error).message}`)
      await sleep(4000)
    }
  }
  throw new Error(`faucet failed for ${label}`)
}

async function topUp(client: Client, w: Wallet, label: string, minDrops: number): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const have = Number(((await accountInfo(client, w.address))!.account_data as Json).Balance)
    if (have >= minDrops) return
    try {
      const funded = await client.fundWallet(w)
      results.faucet[`${label} top-up ${i + 1}`] = String(funded.balance)
      log(`faucet ${label} top-up ${i + 1}: ${funded.balance} XRP`)
    } catch (e) { log(`top-up retry: ${(e as Error).message}`) }
    await sleep(2000)
  }
  throw new Error(`could not fund ${label}`)
}

async function buyRlusd(client: Client, buyer: Wallet, issuer: string, value: string): Promise<{ ok: true; hash: string; drops: number } | { ok: false; reason: string }> {
  const found = await client.request({
    command: 'ripple_path_find', source_account: buyer.address, destination_account: buyer.address,
    destination_amount: { currency: CUR, issuer, value }, source_currencies: [{ currency: 'XRP' }],
  })
  const alt = found.result.alternatives?.[0]
  const drops = typeof alt?.source_amount === 'string' ? Number(alt.source_amount) : NaN
  if (!alt || !Number.isFinite(drops)) return { ok: false, reason: `no path for ${value} RLUSD` }
  if (drops > XRP_CAP) return { ok: false, reason: `${value} RLUSD costs ${drops} drops, over the 50 XRP cap` }
  const prepared = await client.autofill({
    TransactionType: 'Payment', Account: buyer.address, Destination: buyer.address,
    Amount: { currency: CUR, issuer, value }, SendMax: alt.source_amount, Paths: alt.paths_computed,
  })
  const signed = buyer.sign(prepared)
  const submitted = await client.submitAndWait(signed.tx_blob)
  const hash = submitted.result.hash
  const final = (submitted.result.meta as { TransactionResult?: string }).TransactionResult
  results.txs.push({ label: `buy ${value} RLUSD`, hash, final, explorer: `${EXPLORER}${hash}`, drops })
  if (final !== 'tesSUCCESS') return { ok: false, reason: `buy ${value} ${final}` }
  log(`bought ${value} RLUSD for ${drops} drops`)
  return { ok: true, hash, drops }
}

function library(): { template: Template; policies: PolicyDoc[] } {
  const read = <T>(f: string) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')) as T
  const policy = read<PolicyDoc>('policies/marketplace-escrow@1.0.0.json')
  policy.version = '1.0.0-demo'
  policy.params!.minShipWindow = '30s'
  policy.params!.minInspectGap = '50s'
  policy.params!.rulingOverdueRepeat = '15s'
  const template = read<Template>('templates/marketplace-escrow@1.json')
  template.timers!.shipBy.durationSecs = SHIP_SECS
  template.timers!.inspectBy.durationSecs = INSPECT_SECS
  template.timers!.rulingDueBy.durationSecs = RULING_SECS
  return { template, policies: [read<PolicyDoc>('policies/baseline@1.2.0.json'), policy] }
}

async function waitAged(client: Client, accounts: string[]): Promise<void> {
  const headroom = 4 + 15
  for (;;) {
    const { index } = await ledgerClock(client)
    let need = 0
    for (const a of accounts) {
      const info = await accountInfo(client, a)
      need = Math.max(need, Number((info!.account_data as Json).Sequence) + headroom + 256)
    }
    if (index >= need) return
    log(`AccountDelete age: ledger ${index} / ${need}`)
    save()
    await sleep(20_000)
  }
}

function stmt(signer: Wallet, type: string, engagementId: string, claim: Json) {
  const at = new Date().toISOString()
  return signStatement({
    v: 'eng.att/1', type, engagementId, subject: { item: 'sku-1' }, claim,
    observedAt: at, issuedAt: at, nonce: `${type}-${Date.now()}-${signer.address.slice(1, 5)}`,
    attester: { account: signer.address, kind: type.startsWith('shipping') ? 'SHIPPING' : 'PARTY' },
  }, signer)
}

function signFor(account: string, signer: Wallet, tx: Json): string {
  const prepared = { ...tx, SigningPubKey: '' }
  const signature = keypairs.sign(encodeForMultisigning(prepared as never, account), signer.privateKey)
  const blob = xrpl.encode({
    ...prepared,
    Signers: [{ Signer: { Account: account, SigningPubKey: signer.publicKey, TxnSignature: signature } }],
  } as never)
  return blob
}

async function main(): Promise<void> {
  const url = await resolveTestnetEndpoint()
  EXPLORER = url.includes('devnet') ? 'https://devnet.xrpl.org/transactions/' : 'https://testnet.xrpl.org/transactions/'
  results.url = url
  const client = new xrpl.Client(url, { timeout: 60_000 })
  await client.connect()
  log(`connected ${url}`)
  const fees = liveFees = await serverFees(client)
  const buyer = await fund(client, 'buyer')
  const seller = await fund(client, 'seller')
  const carrier = await fund(client, 'carrier')
  const arbiter = await fund(client, 'arbiter')
  const accreditor = await fund(client, 'accreditor')
  const service = await fund(client, 'service')
  const cosigner = xrpl.Wallet.generate()
  results.accounts.cosigner = cosigner.address
  results.faucet.cosigner = 'not funded (signs only)'

  let issuer = RIPPLE_ISSUER
  let ripple = true
  for (const w of [buyer, seller, service]) noted(`${w.address} trust`, await sendSimple(client, w, { TransactionType: 'TrustSet', Account: w.address, LimitAmount: iou(CUR, issuer, '1000000') }))
  const cred = hex('ENG/ARBITER')
  noted('ENG/ARBITER create', await sendSimple(client, accreditor, { TransactionType: 'CredentialCreate', Account: accreditor.address, Subject: arbiter.address, CredentialType: cred }))
  noted('ENG/ARBITER accept', await sendSimple(client, arbiter, { TransactionType: 'CredentialAccept', Account: arbiter.address, Issuer: accreditor.address, CredentialType: cred }))

  const firstBuy = await buyRlusd(client, buyer, issuer, '2.00')
  if (!firstBuy.ok) {
    ripple = false
    results.me16 = `Ripple Testnet RLUSD was not usable (${firstBuy.reason}). Fell back to a run-created issuer.`
    log(results.me16)
    const created = await fund(client, 'run-created issuer')
    issuer = created.address
    noted('DefaultRipple', await sendSimple(client, created, { TransactionType: 'AccountSet', Account: created.address, SetFlag: ASF_DEFAULT_RIPPLE }))
    for (const w of [buyer, seller, service]) noted('fallback trust', await sendSimple(client, w, { TransactionType: 'TrustSet', Account: w.address, LimitAmount: iou(CUR, issuer, '1000000') }))
    noted('issue RLUSD', await sendSimple(client, created, { TransactionType: 'Payment', Account: created.address, Destination: buyer.address, Amount: iou(CUR, issuer, '40') }))
  } else {
    results.me16 = 'buying Ripple Testnet RLUSD under the 50 XRP cap'
    await topUp(client, buyer, 'buyer', 200_000_000)
    for (const value of ['2', '2', '2', '2', '2', '2', '0.5', '0.5', '0.5', '0.5']) {
      const more = await buyRlusd(client, buyer, issuer, value)
      if (!more.ok) {
        results.me16 = `Ripple RLUSD buy stopped (${more.reason}) after a successful first buy`
        break
      }
    }
  }
  results.issuer = issuer
  results.rippleIssuer = ripple

  const { template, policies } = library()
  const trust = { 'arbiter.accreditor': accreditor.address, 'rlusd.issuer': issuer }
  const svc = new CosignerService({ signer: localSigner(cosigner), source: new XrplLedgerSource(client), templates: [template], policies, trust })
  const cast: MarketplaceCast = { issuer: service, buyer, seller, arbiter, accreditor, carrier, service, currency: CUR }
  const make = (label: string) => new MarketplaceEscrowFlow({
    client, svc, cast, fees, price: PRICE, timers: { shipBy: SHIP_SECS, inspectBy: INSPECT_SECS }, issuerAddress: issuer,
    log: (m) => log(`${label} ${m}`),
  })

  const n = CLIP3 ? 1 : 7
  await topUp(client, service, 'service', MarketplaceEscrowFlow.precreateDrops(fees) * (n + 2))
  const accounts: Wallet[] = []
  for (let i = 0; i < n; i++) accounts.push(await make('pre').precreate())
  accounts.forEach((a, i) => { results.accounts[`deal ${i}`] = a.address })

  if (!CLIP3) {
    const unaccredited = xrpl.Wallet.generate()
    results.accounts['unaccredited arbiter'] = unaccredited.address
    results.faucet['unaccredited arbiter'] = 'not funded'
    const refused = await new MarketplaceEscrowFlow({
      client, svc, cast: { ...cast, arbiter: unaccredited }, fees, price: PRICE, issuerAddress: issuer,
      timers: { shipBy: SHIP_SECS, inspectBy: INSPECT_SECS },
    }).open(xrpl.Wallet.generate(), Date.now())
    record('ME17', 'unaccredited arbiter', 'NOT_NEUTRAL and no open batch', text(refused), (refused.final ?? '').includes('NOT_NEUTRAL') && !refused.tx)
    await refusals(client, svc, make('refusals'), cast)
  }

  await waitAged(client, accounts.map((a) => a.address))
  if (CLIP3) await clip3(client, svc, accounts[0], make('clip3'), cast)
  else await closes(client, svc, accounts, make, cast, ripple)
  save()
  const failed = (results.tests as Array<{ pass: boolean }>).filter((t) => !t.pass).length
  console.log(`\n${results.tests.length - failed}/${results.tests.length} passed`)
  console.log(`faucet: ${JSON.stringify(results.faucet)}`)
  console.log(`issuer: ${issuer} ripple=${ripple}`)
  console.log(`ME16 note: ${results.me16}`)
  await svc.close()
  await client.disconnect()
  if (failed) process.exitCode = 1
}

async function refusals(client: Client, svc: CosignerService, f: MarketplaceEscrowFlow, cast: MarketplaceCast): Promise<void> {
  const young = await f.precreate()
  results.accounts['refusal deal'] = young.address
  const opened = await f.open(young, (await ledgerClock(client)).time)
  record('open refusals', 'open the refusal deal', 'tesSUCCESS', text(opened), opened.final === 'tesSUCCESS', { tx: opened.tx })
  const early = await svc.tick(f.engagementId)
  const refund = early.find((t) => t.outcome === 'default.refund')
  const refundReasons = reasons(refund?.record)
  record('ME7', 'default.refund before shipBy', 'REFUSE NOT_DUE', `${refund?.decision} ${refundReasons.join(',')}`, refund?.decision === 'REFUSE' && refundReasons.includes('NOT_DUE'))
  const releaseEarly = early.find((t) => t.outcome === 'default.release')
  const releaseReasons = reasons(releaseEarly?.record)
  record('ME9', 'default.release before inspectBy', 'REFUSE NOT_DUE', `${releaseEarly?.decision} ${releaseReasons.join(',')}`, releaseEarly?.decision === 'REFUSE' && releaseReasons.includes('NOT_DUE'))
  const sellerShip = await svc.ingest(f.engagementId, stmt(cast.seller, 'shipping.shipped/1', f.engagementId, { status: 'shipped' })).then(() => 'receipted', (e) => (e as Error).message)
  record('ME11', 'seller signs a shipment', 'SELF_ATTESTED', sellerShip, /SELF_ATTESTED/.test(sellerShip))
  const stranger = xrpl.Wallet.generate()
  const third = await svc.ingest(f.engagementId, stmt(stranger, 'shipping.shipped/1', f.engagementId, { status: 'shipped' })).then(() => 'receipted', (e) => (e as Error).message)
  record('ME20', 'unnamed attester signs a shipment', 'NOT_A_PARTY', third, /NOT_A_PARTY/.test(third))
  const sellerDispute = await svc.ingest(f.engagementId, stmt(cast.seller, 'party.dispute/1', f.engagementId, { reason: 'no' })).then(() => 'receipted', (e) => (e as Error).message)
  record('ME19', 'seller disputes', 'NOT_DISPUTANT', sellerDispute, /NOT_DISPUTANT/.test(sellerDispute))
  const shipped = await f.ship()
  record('carrier', 'carrier shipment receipts before shipBy', 'RECEIPTED', text(shipped), shipped.final === 'RECEIPTED')
  await sleep((SHIP_SECS + 8) * 1000)
  const later = await svc.tick(f.engagementId)
  const after = later.find((t) => t.outcome === 'default.refund')
  const afterReasons = reasons(after?.record)
  record('ME8', 'default.refund after a shipment', 'REFUSE SHIPPED', `${after?.decision} ${afterReasons.join(',')}`, after?.decision === 'REFUSE' && afterReasons.includes('SHIPPED'))
  const quiet = makeQuiet(client, svc, cast)
  const quietAccount = await quiet.precreate()
  results.accounts['never shipped'] = quietAccount.address
  const quietOpen = await quiet.open(quietAccount, (await ledgerClock(client)).time)
  record('ME10 setup', 'open a deal that never gets a shipment', 'tesSUCCESS', text(quietOpen), quietOpen.final === 'tesSUCCESS', { tx: quietOpen.tx })
  await sleep((INSPECT_SECS + 8) * 1000)
  const due = await svc.tick(quiet.engagementId)
  const noShip = due.find((t) => t.outcome === 'default.release')
  const noShipReasons = reasons(noShip?.record)
  record('ME10', 'default.release with no shipment', 'REFUSE NOT_SHIPPED', `${noShip?.decision} ${noShipReasons.join(',')}`, noShip?.decision === 'REFUSE' && noShipReasons.includes('NOT_SHIPPED'))
}

function makeQuiet(client: Client, svc: CosignerService, cast: MarketplaceCast): MarketplaceEscrowFlow {
  return new MarketplaceEscrowFlow({
    client, svc, cast, fees: liveFees, price: PRICE,
    timers: { shipBy: SHIP_SECS, inspectBy: INSPECT_SECS }, issuerAddress: results.issuer as string,
  })
}

async function closes(client: Client, svc: CosignerService, accounts: Wallet[], make: (label: string) => MarketplaceEscrowFlow, cast: MarketplaceCast, ripple: boolean): Promise<void> {
  const openAt = async (f: MarketplaceEscrowFlow, account: Wallet) => {
    const step = await f.open(account, (await ledgerClock(client)).time)
    if (step.final !== 'tesSUCCESS') throw new Error(`open failed ${text(step)}`)
    return step
  }
  const deleted = async (address: string) => (await accountInfo(client, address)) === null

  const me1 = make('me1')
  const o1 = await openAt(me1, accounts[0])
  await me1.ship()
  const confirm = await me1.releaseConfirm()
  const gone1 = await deleted(accounts[0].address)
  record('ME1', 'shipped, buyer confirms', 'release.confirm SIGN, account deleted', `${text(confirm)} deleted=${gone1}`, confirm.decision === 'SIGN' && confirm.final === 'tesSUCCESS' && gone1, { tx: confirm.tx })
  record('ME16', 'close on the issuer this run used', ripple ? 'Ripple Testnet RLUSD trust line removed and AccountDelete tesSUCCESS' : 'run-created issuer, because the Ripple buy did not complete', `${results.me16}; ME1 deleted=${gone1}`, gone1 && confirm.final === 'tesSUCCESS' && ripple, { tx: confirm.tx })

  const me2 = make('me2')
  await openAt(me2, accounts[1])
  await sleep((SHIP_SECS + 8) * 1000)
  const ticks2 = await me2.tickAndSubmit()
  const refund = ticks2.find((s) => s.step.includes('default.refund'))
  record('ME2', 'never shipped', 'default.refund SIGN', text(refund), refund?.decision === 'SIGN' && refund.final === 'tesSUCCESS', { tx: refund?.tx })

  const me15 = make('me15')
  await openAt(me15, accounts[2])
  const agreed = await me15.refundAgreed()
  record('ME15', 'mutual cancel before shipping', 'refund.agreed SIGN', text(agreed), agreed.decision === 'SIGN' && agreed.final === 'tesSUCCESS', { tx: agreed.tx })

  const me3 = make('me3')
  await openAt(me3, accounts[3])
  await me3.ship()
  await sleep((INSPECT_SECS + 8) * 1000)
  const ticks3 = await me3.tickAndSubmit()
  const rel = ticks3.find((s) => s.decision === 'SIGN')
  record('ME3', 'shipped, then silence', 'default.release SIGN. The shipment is not 24 wall-clock hours old; Testnet close time cannot be backdated.', text(rel), rel?.decision === 'SIGN' && (rel.step ?? '').includes('default.release'), { tx: rel?.tx })

  const me18 = make('me18')
  await openAt(me18, accounts[4])
  await me18.openDispute(BOND)
  await sleep((SHIP_SECS + 8) * 1000)
  const ticks18 = await me18.tickAndSubmit()
  const drefund = ticks18.find((s) => s.step.includes('default.refund'))
  record('ME18', 'dispute before shipping, seller never ships', 'default.refund SIGN', text(drefund), drefund?.decision === 'SIGN' && drefund.final === 'tesSUCCESS', { tx: drefund?.tx })

  const me5 = make('me5')
  await openAt(me5, accounts[5])
  await me5.ship()
  await me5.openDispute(BOND)
  const releaseRuling = await me5.disputeSettle('release', BOND)
  record('ME5', 'arbiter rules a release', 'dispute.release tesSUCCESS', text(releaseRuling), releaseRuling.final === 'tesSUCCESS', { tx: releaseRuling.tx })

  await clip3(client, svc, accounts[6], make('me6'), cast)
}

async function clip3(client: Client, svc: CosignerService, account: Wallet, f: MarketplaceEscrowFlow, cast: MarketplaceCast): Promise<void> {
  const opened = await f.open(account, (await ledgerClock(client)).time)
  if (opened.final !== 'tesSUCCESS') throw new Error(`clip3 open ${text(opened)}`)
  await f.ship()
  await f.openDispute(BOND)
  await sleep((INSPECT_SECS + 8) * 1000)
  const blocked = await svc.tick(f.engagementId)
  const release = blocked.find((t) => t.outcome === 'default.release')
  const releaseWhy = reasons(release?.record)
  record('ME6 release', 'inspectBy passes with a dispute open', 'REFUSE DISPUTE_OPEN', `${release?.decision} ${releaseWhy.join(',')}`, release?.decision === 'REFUSE' && releaseWhy.includes('DISPUTE_OPEN'))
  await sleep((RULING_SECS + 5) * 1000)
  const first = await svc.overdue(f.engagementId)
  record('ME6 alert', 'ruling overdue pages and does not sign', 'RULING_OVERDUE', first?.alert ?? 'none', first?.alert === 'RULING_OVERDUE')
  await sleep(16_000)
  const again = await svc.overdue(f.engagementId)
  record('ME6 repeat', 'the alert repeats', 'RULING_OVERDUE', again?.alert ?? 'none', again?.alert === 'RULING_OVERDUE')
  const late = await svc.ingest(f.engagementId, stmt(cast.arbiter, 'party.ruling/1', f.engagementId, { outcome: 'refund' })).then(() => 'receipted', (e) => (e as Error).message)
  record('ME6 ruling', 'a late ruling is receipted', 'receipted', late, late === 'receipted')
  const rotated = xrpl.Wallet.generate()
  noted('arbiter SetRegularKey', await sendSimple(client, cast.arbiter, { TransactionType: 'SetRegularKey', Account: cast.arbiter.address, RegularKey: rotated.address }))
  const objects = await client.request({ command: 'account_objects', account: account.address, ledger_index: 'validated', type: 'signer_list' })
  const list = JSON.stringify(objects.result.account_objects ?? [])
  const signerListUnchanged = list.includes(cast.arbiter.address) && !list.includes(rotated.address)
  results.arbiterKeyRotation = { regularKey: rotated.address, signerListUnchanged }
  const settled = await settleRefund(client, f, account.address, cast, rotated)
  const gone = (await accountInfo(client, account.address)) === null
  record('ME4', 'arbiter rules a refund; the new RegularKey signs and the SignerList is untouched', 'tesSUCCESS and account deleted', `${settled.final} deleted=${gone} signerListUnchanged=${signerListUnchanged}`, settled.final === 'tesSUCCESS' && gone && signerListUnchanged, { tx: settled.hash })
}

async function settleRefund(client: Client, f: MarketplaceEscrowFlow, eng: string, cast: MarketplaceCast, arbiterKey: Wallet): Promise<SubmitResult> {
  const lines = await client.request({ command: 'account_lines', account: eng, ledger_index: 'validated' })
  const balance = lines.result.lines.find((l) => l.account === (results.issuer as string))?.balance ?? PRICE
  const seq = Number(((await accountInfo(client, eng))!.account_data as Json).Sequence)
  const fees = await serverFees(client)
  const tx = buildCloseBatch({
    eng, currency: CUR, issuer: results.issuer as string, payouts: [{ to: cast.buyer.address, value: balance }],
    deleteTo: cast.service.address, seq, lastLedgerSequence: (await currentLedger(client)) + 20,
    memos: [memo('eng/basis', 'dispute.refund')], fees, signatures: 2,
  })
  const arbiterBlob = signFor(cast.arbiter.address, arbiterKey, tx)
  const buyerBlob = multisignBlob(cast.buyer, tx)
  const r = await submit(client, combine([arbiterBlob, buyerBlob]))
  results.txs.push({ label: 'ME4 dispute.refund', hash: r.hash, final: r.final, explorer: `${EXPLORER}${r.hash}` })
  void f
  return r
}

main().catch((e) => { console.error(e); save(); process.exit(1) })
