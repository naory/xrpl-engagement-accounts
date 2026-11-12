// Live XRPL Testnet demo: a B1 engagement account pays an MPP merchant
// (Machine Payments Protocol, XRPL charge method, PUSH mode).
//
//   npm i x402-xrpl-settlement-adapter        # once; see ./README.md
//   npm run demo:mpp                           # from the repo root (~2-3 min)
//   XRPL_URL=wss://s.devnet.rippletest.net:51233 npm run demo:mpp
//
// It opens a single-use, owner-wallet engagement account exactly like demo:b1 (master
// disabled, SignerList {owner 2, agent 1, co-signer 1}, quorum 2), then runs the real
// MPP push round trip against an in-process merchant:
//
//   merchant 402 (WWW-Authenticate: Payment, method=xrpl intent=charge) ->
//   agent builds the engagement Payment (eng/basis + eng/invoice + the XRPL InvoiceID
//   bound to the MPP invoiceId) -> co-signer checks W7 (scheme "mpp") and co-signs ->
//   agent submits -> agent returns the tx hash as the MPP push credential
//   (Authorization: Payment { payload: { type:"hash", hash } }) -> merchant confirms the
//   *validated* transaction by hash + InvoiceID -> resource delivered.
//
// Push mode makes multisig moot: the ledger enforced the SignerList and quorum before the
// hash existed, so the merchant only reads the validated transaction. The MPP envelope and
// push verification are the reference `xrpl-mpp-sdk`'s job; because that beta peers on
// xrpl<5 while this repo is on xrpl@5, the merchant here speaks the same pinned wire format
// and bridges push settlement to the adapter's confirmExactSettlement (docs/research/mpp.md §6).
//
// All keys are generated fresh per run (faucet-funded); nothing is persisted except the
// results file under demo/results/. The account is left OPEN (close is covered by demo:b1).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import xrpl from 'xrpl'
import { localSigner, signStatement, newNonce, type Statement, type StatementBody, type Template } from '@eng/core'
import { layerHash, type EngagementRecord, type PolicyDoc } from '@eng/policy'
import { CosignerService, XrplLedgerSource, type DecideResponse } from '../../src/index.ts'
import {
  ASF_DEFAULT_RIPPLE, ASF_DISABLE_MASTER, LSF_DISABLE_MASTER, TF_SET_NO_RIPPLE,
  accountInfo, addBatchSigner, buildOpenBatch, combine, currencyHex, currentLedger, hex, iou, iouBalance,
  memo, multisigFee, multisignBlob, sendSimple, serverFees, sleep, submit, innerResults, type SubmitResult,
} from '../../src/xrpl-io.ts'
import { createMppMerchant } from './merchant.ts'
import type { FetchTransaction, XrplPaymentTransaction } from 'x402-xrpl-settlement-adapter'
import { invoiceIdToField } from 'x402-xrpl-settlement-adapter/exact'

type Wallet = InstanceType<typeof xrpl.Wallet>
type Json = Record<string, unknown>

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../../..')
const URL_ = process.env.XRPL_URL ?? 'wss://s.altnet.rippletest.net:51233'
const EXPLORER = URL_.includes('devnet') ? 'https://devnet.xrpl.org/transactions/' : 'https://testnet.xrpl.org/transactions/'
const NETWORK = URL_.includes('devnet') ? 'xrpl:2' : 'xrpl:1'
const CUR = currencyHex('RLUSD')
const ENG_ID = `eng_b1mpp_${Date.now().toString(36)}`
const RESOURCE = 'https://vendor.example/premium-dataset'
const PRICE = '800'

// ── Results ──────────────────────────────────────────────────────────────────
const results: Json & { tests: Json[]; accounts: Record<string, string> } = {
  demo: 'B1 MPP purchase from an engagement account (XRPL charge, push mode)', url: URL_, startedAt: new Date().toISOString(), accounts: {}, tests: [],
}
function record(id: string, name: string, expected: string, actual: string, pass: boolean, extra: Json = {}) {
  results.tests.push({ id, name, expected, actual, pass, ...extra })
  console.log(`${pass ? '✅' : '❌'} ${id} ${name}\n     expected: ${expected}\n     actual:   ${actual}${extra.tx ? `\n     tx: ${EXPLORER}${extra.tx}` : ''}`)
}
const log = (...a: unknown[]) => console.log('   ·', ...a)
const resultsDir = path.join(here, '..', 'results')
function save(): string {
  fs.mkdirSync(resultsDir, { recursive: true })
  const f = path.join(resultsDir, `mpp-run-${String(results.startedAt).replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(f, JSON.stringify(results, null, 2))
  return f
}
function must(r: SubmitResult, label: string): SubmitResult {
  if (r.final !== 'tesSUCCESS') throw new Error(`${label} failed: ${r.final} (${r.hash})`)
  return r
}
const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const near = (a: unknown, b: number) => Math.abs(Number(a) - b) < 1e-9

function stmt(signer: Wallet, kind: string, type: string, subject: Json, claim: Json): Statement {
  const t = isoNow()
  const body: StatementBody = { v: 'eng.att/1', type, engagementId: ENG_ID, subject, claim, observedAt: t, issuedAt: t, nonce: newNonce(), attester: { account: signer.address, kind } }
  return signStatement(body, signer)
}

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
  const client = new xrpl.Client(URL_)
  await client.connect()
  console.log(`Connected to ${URL_}\n`)
  const fees = await serverFees(client)
  results.fees = fees

  // ── Cast ──
  const issuer = await fund(client, 'issuer')
  const treasury = await fund(client, 'treasury (owner)')
  const service = await fund(client, 'service')
  const vendorA = await fund(client, 'vendorA (merchant)')
  const vendorB = await fund(client, 'vendorB')
  const kyb = await fund(client, 'kybIssuer')
  const agent = xrpl.Wallet.generate()     // signs only, never funded
  const cosigner = xrpl.Wallet.generate()  // signs only, never funded
  const controller = xrpl.Wallet.generate() // approvals only (unused at this price)
  Object.assign(results.accounts, { agent: agent.address, cosigner: cosigner.address, controller: controller.address })

  // ── Token + KYB credentials ──
  must(await sendSimple(client, issuer, { TransactionType: 'AccountSet', Account: issuer.address, SetFlag: ASF_DEFAULT_RIPPLE }), 'DefaultRipple')
  for (const w of [treasury, vendorA, vendorB]) must(await sendSimple(client, w, { TransactionType: 'TrustSet', Account: w.address, LimitAmount: iou(CUR, issuer.address, '10000000') }), 'trust line')
  must(await sendSimple(client, issuer, { TransactionType: 'Payment', Account: issuer.address, Destination: treasury.address, Amount: iou(CUR, issuer.address, '20000') }), 'issue to treasury')
  for (const v of [vendorA, vendorB]) {
    must(await sendSimple(client, kyb, { TransactionType: 'CredentialCreate', Account: kyb.address, Subject: v.address, CredentialType: hex('KYB_VERIFIED') }), 'KYB CredentialCreate')
    must(await sendSimple(client, v, { TransactionType: 'CredentialAccept', Account: v.address, Issuer: kyb.address, CredentialType: hex('KYB_VERIFIED') }), 'KYB CredentialAccept')
  }
  log('vendors A and B hold accepted KYB_VERIFIED credentials')

  // ── Pre-create (service) ──
  const eng = xrpl.Wallet.generate()
  results.accounts.engagement = eng.address
  must(await sendSimple(client, service, { TransactionType: 'Payment', Account: service.address, Destination: eng.address, Amount: xrpl.xrpToDrops(3) }), 'create engagement account')
  must(await sendSimple(client, eng, { TransactionType: 'TrustSet', Account: eng.address, LimitAmount: iou(CUR, issuer.address, '1000000000'), Flags: TF_SET_NO_RIPPLE }), 'engagement trust line')
  must(await sendSimple(client, eng, { TransactionType: 'SetRegularKey', Account: eng.address, RegularKey: service.address }), 'pre-create SetRegularKey')
  must(await sendSimple(client, eng, { TransactionType: 'AccountSet', Account: eng.address, SetFlag: ASF_DISABLE_MASTER }), 'pre-create disable master')
  log(`pre-created ${eng.address} (master disabled, service RegularKey)`)

  // ── M1: open the engagement account ──
  {
    const seq = Number(((await accountInfo(client, eng.address))!.account_data as Json).Sequence)
    const tSeq = Number(((await accountInfo(client, treasury.address))!.account_data as Json).Sequence)
    const { tx } = buildOpenBatch({
      eng: eng.address, funder: treasury.address, currency: CUR, issuer: issuer.address, amount: '5000',
      signerEntries: [[treasury.address, 2], [agent.address, 1], [cosigner.address, 1]], quorum: 2, seq, funderSeq: tSeq, ticketCount: 0,
      memos: [memo('eng/open', `${ENG_ID}|template=owner-wallet/procurement@1`)], fees,
    })
    addBatchSigner(treasury, tx)
    const r = await submit(client, service.sign(tx as never).tx_blob)
    const innr = await innerResults(client, tx)
    const info = (await accountInfo(client, eng.address))!
    const d = info.account_data as Json
    const sl = ((info.signer_lists ?? d.signer_lists) as Json[] | undefined)?.[0] as Json | undefined
    const bal = await iouBalance(client, eng.address, CUR, issuer.address)
    const ok = r.final === 'tesSUCCESS' && innr.every((i) => i.applied) && (Number(d.Flags) & LSF_DISABLE_MASTER) !== 0 && d.RegularKey == null && sl?.SignerQuorum === 2 && near(bal, 5000)
    record('M1', 'open the engagement account (master disabled, quorum 2, funded 5000)',
      'tesSUCCESS, all inner applied, master disabled, no RegularKey, quorum 2, balance 5000',
      `${r.final}; inner ${innr.map((i) => i.result).join(',')}; regularKey=${d.RegularKey ?? 'none'}; quorum=${sl?.SignerQuorum}; balance=${bal}`, ok, { tx: r.hash })
    if (!ok) throw new Error('open failed; stopping')
  }

  // ── Co-signer with a demo policy layer (RLUSD + KYB issuers of this run) ──
  const read = <T>(f: string) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')) as T
  const baseline = read<PolicyDoc>('policies/baseline@1.1.0.json')
  const policy = read<PolicyDoc>('policies/procurement@1.3.0.json')
  policy.version = '1.3.0+mppdemo'
  policy.assets!.RLUSD.issuer = issuer.address
  policy.params!.kybIssuers = [kyb.address]
  const tmpl = fs.readdirSync(path.join(root, 'templates')).map((f) => read<Template>(`templates/${f}`))
  const dataDir = path.join(resultsDir, `decisions-${String(results.startedAt).replace(/[:.]/g, '-')}`)
  const svc = new CosignerService({ signer: localSigner(cosigner), source: new XrplLedgerSource(client), templates: tmpl, policies: [baseline, policy], dataDir })

  const expires = new Date(Date.now() + 7 * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const mandate = stmt(treasury, 'PRINCIPAL', 'party.mandate/1', { mandateId: 'mnd_mpp' }, { purpose: 'agentic MPP data purchases (demo)', budget: '5000.00', dailyCap: '3000.00', vendors: [vendorA.address, vendorB.address], expires })
  const engagement: EngagementRecord = {
    engagementId: ENG_ID, template: 'owner-wallet/procurement@1', account: eng.address, asset: 'RLUSD',
    parties: { owner: treasury.address, agent: agent.address, cosigner: cosigner.address },
    attesters: { approver: { accounts: [controller.address] }, vendor: { accounts: [vendorA.address, vendorB.address] } },
    deleteTo: service.address, state: 'OPEN', consumed: [], policyLayers: [layerHash(policy)], mandateId: mandate.id,
  }
  svc.register(engagement, mandate)
  log(`co-signer ${cosigner.address} registered ${ENG_ID} (W7 payment-challenge binding active, rail-neutral)`)

  // ── An in-process MPP merchant selling RESOURCE for 800 RLUSD, paid to vendor A ──
  const fetchTransaction: FetchTransaction = async (_network, txHash) => {
    try {
      const resp = await client.request({ command: 'tx', transaction: txHash } as never) as { result: Json }
      const r = resp.result as Json
      const t = (r.tx_json as Json) ?? r
      const meta = (r.meta ?? r.metaData) as Json | undefined
      const amount = (t.Amount ?? t.DeliverMax) as XrplPaymentTransaction['Amount']
      return {
        validated: Boolean(r.validated),
        TransactionType: t.TransactionType as string,
        Account: t.Account as string,
        Destination: t.Destination as string,
        Amount: amount,
        InvoiceID: t.InvoiceID as string, // push binding: confirmExactSettlement checks this
        Memos: t.Memos as XrplPaymentTransaction['Memos'],
        meta: meta ? { TransactionResult: meta.TransactionResult as string, delivered_amount: (meta.delivered_amount ?? meta.DeliveredAmount ?? amount) as XrplPaymentTransaction['Amount'] } : undefined,
      } as XrplPaymentTransaction
    } catch (e) {
      const msg = String((e as { data?: { error?: string } })?.data?.error ?? (e as Error).message)
      if (msg.includes('txnNotFound')) return null
      throw e
    }
  }
  const merchant = createMppMerchant({
    resource: RESOURCE, network: NETWORK, recipient: vendorA.address,
    price: { amount: '800.00', asset: { kind: 'IOU', currency: CUR, issuer: issuer.address } },
    fetchTransaction,
    deliver: ({ invoiceId }) => ({ dataset: 'premium.csv', bytes: 1048576, invoiceId }),
  })

  // ── Agent helpers ──
  let nextSeq = Number(((await accountInfo(client, eng.address))!.account_data as Json).Sequence)
  const mppPayment = async (to: string, value: string, invoiceId: string, seq: number): Promise<Json> => ({
    TransactionType: 'Payment', Account: eng.address, Destination: to, Amount: iou(CUR, issuer.address, value),
    Fee: multisigFee(fees.base, 2), Sequence: seq, LastLedgerSequence: (await currentLedger(client)) + 20, SigningPubKey: '', Flags: 0,
    InvoiceID: invoiceIdToField(invoiceId), // signature-covered binding to the MPP invoiceId (push mode)
    Memos: [memo('eng/basis', 'spend'), memo('eng/invoice', invoiceId)],
  })
  const pushCredential = (challengeToken: string, hash: string): string =>
    `Payment ${Buffer.from(JSON.stringify({ challenge: challengeToken, payload: { type: 'hash', hash }, source: eng.address }), 'utf8').toString('base64url')}`

  // ── M2: full round trip — 402 -> co-sign (W7) -> submit -> confirm by hash -> deliver ──
  const challenge = merchant.challenge()
  const invoiceId = challenge.invoiceId
  log(`merchant issued 402 (method=xrpl intent=charge) for ${RESOURCE} · invoiceId ${invoiceId}`)
  {
    const tx = await mppPayment(vendorA.address, PRICE, invoiceId, nextSeq)
    const invoiceStmt = stmt(vendorA, 'VENDOR', 'party.invoice/1', { invoiceRef: invoiceId }, { invoiceRef: invoiceId, amount: '800.00', currency: 'RLUSD', po: 'PO-MPP' })
    const mppStmt = stmt(agent, 'AGENT', 'payment.challenge/1', { invoiceId }, { scheme: 'mpp', payTo: vendorA.address, amount: '800.00', asset: 'RLUSD', invoiceId, resource: RESOURCE })
    const agentBlob = multisignBlob(agent, tx)
    const d: DecideResponse = await svc.decide({ engagementId: ENG_ID, stage: 'spend', txBlob: agentBlob, statements: [invoiceStmt, mppStmt] })
    const w7 = d.results.find((r) => r.id === 'W7')?.result
    log(`co-signer: ${d.decision}${d.failing.length ? ' ' + d.failing.join(',') : ''} · W7=${w7}`)

    const pre = await iouBalance(client, vendorA.address, CUR, issuer.address)
    const s = d.decision === 'SIGN' ? await submit(client, combine([agentBlob, d.signerBlob!])) : null
    const txHash = s?.hash

    // The agent presents the tx hash as the MPP push credential; the merchant confirms on-ledger.
    let res = s?.final === 'tesSUCCESS' && txHash ? await merchant.handle(pushCredential(challenge.challengeToken, txHash)) : undefined
    for (let i = 0; i < 8 && res && res.status === 402 && txHash; i++) {
      await sleep(3000)
      res = await merchant.handle(pushCredential(challenge.challengeToken, txHash))
    }
    const delta = Number(await iouBalance(client, vendorA.address, CUR, issuer.address)) - Number(pre)
    const delivered = res && res.status === 200 ? JSON.stringify(res.body) : res ? `status ${res.status} ${res.error}` : 'status n/a'
    const ok = d.decision === 'SIGN' && w7 === 'pass' && s?.final === 'tesSUCCESS' && res?.status === 200 && near(delta, 800)
    record('M2', 'merchant 402 -> agent+co-signer pay 800 (W7 binds the co-signature to the mpp challenge) -> merchant confirms by hash+InvoiceID -> delivers',
      'SIGN; W7 pass; tesSUCCESS; merchant 200 with the resource; vendor A +800',
      `${d.decision}; W7=${w7}; ${s?.final}; merchant ${res?.status}; vendor A +${delta}; body=${delivered}`, ok, { tx: s?.hash })
    if (!ok) throw new Error('MPP round trip failed; stopping')

    // ── M3: replaying the same push credential is idempotent (no double delivery) ──
    const again = await merchant.handle(pushCredential(challenge.challengeToken, txHash!))
    const idem = again.status === 200 && again.idempotent === true && again.body === undefined
    record('M3', 'the agent replays the same push credential', '200, idempotent, no resource re-delivered',
      `status ${again.status}; idempotent=${again.status === 200 ? again.idempotent : 'n/a'}; body=${again.status === 200 ? String(again.body) : 'n/a'}`, idem)
    nextSeq = Number(((await accountInfo(client, eng.address))!.account_data as Json).Sequence)
  }

  // ── M4: co-signer refuses (W7) when the declared mpp challenge names a different payee ──
  {
    const ch2 = merchant.challenge()
    const inv2 = ch2.invoiceId
    const tx = await mppPayment(vendorA.address, PRICE, inv2, nextSeq)
    const invoiceStmt = stmt(vendorA, 'VENDOR', 'party.invoice/1', { invoiceRef: inv2 }, { invoiceRef: inv2, amount: '800.00', currency: 'RLUSD', po: 'PO-MPPb' })
    // The agent declares an mpp challenge that pays vendor B, while the payment pays vendor A.
    const mppStmt = stmt(agent, 'AGENT', 'payment.challenge/1', { invoiceId: inv2 }, { scheme: 'mpp', payTo: vendorB.address, amount: '800.00', asset: 'RLUSD', invoiceId: inv2, resource: RESOURCE })
    const agentBlob = multisignBlob(agent, tx)
    const d = await svc.decide({ engagementId: ENG_ID, stage: 'spend', txBlob: agentBlob, statements: [invoiceStmt, mppStmt] })
    const ok = d.decision === 'REFUSE' && d.failing.includes('W7') && !d.signerBlob
    record('M4', 'agent declares an mpp challenge paying vendor B but the payment pays vendor A',
      'REFUSE incl. W7; no co-signature produced', `${d.decision} ${d.failing.join(',')}; signerBlob=${d.signerBlob ? 'present' : 'none'}`, ok)
  }

  results.decisionLog = path.relative(root, path.join(dataDir, 'decisions.jsonl'))
  results.decisions = svc.decisions(ENG_ID).map((d) => ({ id: d.id, decision: d.claim.decision, failing: d.claim.failing }))
  await client.disconnect()
  results.finishedAt = new Date().toISOString()
  const f = save()
  const passed = results.tests.filter((t) => t.pass).length
  console.log(`\n${passed}/${results.tests.length} passed. Results: ${path.relative(root, f)}\nDecision log: ${results.decisionLog}`)
  console.log('The engagement account is left OPEN (close is covered by demo:b1).')
  process.exit(passed === results.tests.length ? 0 : 1)
}

main().catch((e) => {
  console.error('\nDemo aborted:', e)
  results.error = String((e as Error)?.stack ?? e)
  try { console.log('Partial results:', save()) } catch { /* ignore */ }
  process.exit(1)
})
