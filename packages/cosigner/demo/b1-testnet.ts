// M1 demo, catalog B1: an enterprise procurement agent spends from a single-use, owner-wallet
// engagement account on XRPL Testnet, with the policy co-signer as the second signature.
//
//   npm install && npm run demo:b1          (from the repo root; ~20 min with the close step)
//   SKIP_CLOSE=1 npm run demo:b1            (~3 min; leaves the account open)
//   XRPL_URL=wss://s.devnet.rippletest.net:51233 npm run demo:b1
//
// All keys are generated fresh per run (faucet-funded test accounts); nothing is persisted except
// the results file and the co-signer's decision log under demo/results/.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import xrpl from 'xrpl'
import { localSigner, parseAmount, signStatement, newNonce, type Statement, type StatementBody, type Template } from '@eng/core'
import { intentHashOf, layerHash, type EngagementRecord, type PolicyDoc } from '@eng/policy'
import { CosignerService, XrplLedgerSource, type DecideResponse } from '../src/index.ts'
import {
  ASF_DEFAULT_RIPPLE, ASF_DISABLE_MASTER, LSF_DISABLE_MASTER, TF_SET_NO_RIPPLE,
  accountInfo, addBatchSigner, buildCloseBatch, buildOpenBatch, combine, currencyHex, currentLedger, hex, inner, iou, iouBalance,
  memo, multisigFee, multisignBlob, sendSimple, serverFees, sleep, submit, innerResults, type SubmitResult,
} from '../src/xrpl-io.ts'

type Wallet = InstanceType<typeof xrpl.Wallet>
type Json = Record<string, unknown>

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const URL_ = process.env.XRPL_URL ?? 'wss://s.altnet.rippletest.net:51233'
const EXPLORER = URL_.includes('devnet') ? 'https://devnet.xrpl.org/transactions/' : 'https://testnet.xrpl.org/transactions/'
const CUR = currencyHex('RLUSD')
const ENG_ID = `eng_b1_${Date.now().toString(36)}`

// ── Results ────────────────────────────────────────────────────────────────
const results: Json & { tests: Json[]; accounts: Record<string, string> } = { demo: 'B1 procurement agent (owner-wallet)', url: URL_, startedAt: new Date().toISOString(), accounts: {}, tests: [] }
function record(id: string, name: string, expected: string, actual: string, pass: boolean, extra: Json = {}) {
  results.tests.push({ id, name, expected, actual, pass, ...extra })
  console.log(`${pass ? '✅' : '❌'} ${id} ${name}\n     expected: ${expected}\n     actual:   ${actual}${extra.tx ? `\n     tx: ${EXPLORER}${extra.tx}` : ''}`)
}
const log = (...a: unknown[]) => console.log('   ·', ...a)
const resultsDir = path.join(here, 'results')
function save(): string {
  fs.mkdirSync(resultsDir, { recursive: true })
  const f = path.join(resultsDir, `b1-run-${String(results.startedAt).replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(f, JSON.stringify(results, null, 2))
  return f
}
function must(r: SubmitResult, label: string): SubmitResult {
  if (r.final !== 'tesSUCCESS') throw new Error(`${label} failed: ${r.final} (${r.hash})`)
  return r
}
const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const near = (a: unknown, b: number) => Math.abs(Number(a) - b) < 1e-9

// ── Statements ─────────────────────────────────────────────────────────────
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
  const vendorA = await fund(client, 'vendorA')
  const vendorB = await fund(client, 'vendorB')
  const stranger = await fund(client, 'stranger')
  const kyb = await fund(client, 'kybIssuer')
  const agent = xrpl.Wallet.generate() // signs only, never funded
  const cosigner = xrpl.Wallet.generate() // signs only, never funded
  const controller = xrpl.Wallet.generate() // approves (statements only)
  Object.assign(results.accounts, { agent: agent.address, cosigner: cosigner.address, controller: controller.address })

  // ── Token + KYB credentials ──
  must(await sendSimple(client, issuer, { TransactionType: 'AccountSet', Account: issuer.address, SetFlag: ASF_DEFAULT_RIPPLE }), 'DefaultRipple')
  for (const w of [treasury, vendorA, vendorB, stranger]) must(await sendSimple(client, w, { TransactionType: 'TrustSet', Account: w.address, LimitAmount: iou(CUR, issuer.address, '10000000') }), 'trust line')
  must(await sendSimple(client, issuer, { TransactionType: 'Payment', Account: issuer.address, Destination: treasury.address, Amount: iou(CUR, issuer.address, '20000') }), 'issue to treasury')
  for (const v of [vendorA, vendorB]) {
    must(await sendSimple(client, kyb, { TransactionType: 'CredentialCreate', Account: kyb.address, Subject: v.address, CredentialType: hex('KYB_VERIFIED') }), 'KYB CredentialCreate')
    must(await sendSimple(client, v, { TransactionType: 'CredentialAccept', Account: v.address, Issuer: kyb.address, CredentialType: hex('KYB_VERIFIED') }), 'KYB CredentialAccept')
  }
  log('vendors A and B hold accepted KYB_VERIFIED credentials; the stranger does not')

  // ── Pre-create (service) ──
  const eng = xrpl.Wallet.generate()
  results.accounts.engagement = eng.address
  must(await sendSimple(client, service, { TransactionType: 'Payment', Account: service.address, Destination: eng.address, Amount: xrpl.xrpToDrops(3) }), 'create engagement account')
  must(await sendSimple(client, eng, { TransactionType: 'TrustSet', Account: eng.address, LimitAmount: iou(CUR, issuer.address, '1000000000'), Flags: TF_SET_NO_RIPPLE }), 'engagement trust line')
  must(await sendSimple(client, eng, { TransactionType: 'SetRegularKey', Account: eng.address, RegularKey: service.address }), 'pre-create SetRegularKey')
  must(await sendSimple(client, eng, { TransactionType: 'AccountSet', Account: eng.address, SetFlag: ASF_DISABLE_MASTER }), 'pre-create disable master')
  log(`pre-created ${eng.address} (master disabled, service RegularKey)`)

  // ── Open: owner funds 5,000 + SignerList {owner 2, agent 1, cosigner 1} quorum 2 + clear RegularKey ──
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
    const inn = await innerResults(client, tx)
    const info = (await accountInfo(client, eng.address))!
    const d = info.account_data as Json
    const sl = ((info.signer_lists ?? d.signer_lists) as Json[] | undefined)?.[0] as Json | undefined
    const bal = await iouBalance(client, eng.address, CUR, issuer.address)
    const ok = r.final === 'tesSUCCESS' && inn.every((i) => i.applied) && (Number(d.Flags) & LSF_DISABLE_MASTER) !== 0 && d.RegularKey == null && sl?.SignerQuorum === 2 && near(bal, 5000)
    record('D1', 'open Batch: owner funding + SignerListSet (owner 2, agent 1, co-signer 1; quorum 2) + clear RegularKey',
      'tesSUCCESS, all inner applied, master disabled, no RegularKey, quorum 2, balance 5000',
      `${r.final}; inner ${inn.map((i) => i.result).join(',')}; regularKey=${d.RegularKey ?? 'none'}; quorum=${sl?.SignerQuorum}; balance=${bal}`, ok, { tx: r.hash })
    if (!ok) throw new Error('open failed; stopping')
  }

  // ── Co-signer with a demo policy layer (RLUSD issuer + KYB issuer of this run) ──
  const read = <T>(f: string) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')) as T
  const baseline = read<PolicyDoc>('policies/baseline@1.1.0.json')
  const policy = read<PolicyDoc>('policies/procurement@1.3.0.json')
  policy.version = '1.3.0+demo'
  policy.assets!.RLUSD.issuer = issuer.address
  policy.params!.kybIssuers = [kyb.address]
  const templates = fs.readdirSync(path.join(root, 'templates')).map((f) => read<Template>(`templates/${f}`))
  const dataDir = path.join(resultsDir, `decisions-${String(results.startedAt).replace(/[:.]/g, '-')}`)
  const svc = new CosignerService({ signer: localSigner(cosigner), source: new XrplLedgerSource(client), templates, policies: [baseline, policy], dataDir })

  const expires = new Date(Date.now() + 7 * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const mandate = stmt(treasury, 'PRINCIPAL', 'party.mandate/1', { mandateId: 'mnd_demo' }, { purpose: 'Q4 cloud & data spend (demo)', budget: '5000.00', dailyCap: '3000.00', vendors: [vendorA.address, vendorB.address], expires })
  const engagement: EngagementRecord = {
    engagementId: ENG_ID, template: 'owner-wallet/procurement@1', account: eng.address, asset: 'RLUSD',
    parties: { owner: treasury.address, agent: agent.address, cosigner: cosigner.address },
    attesters: { approver: { accounts: [controller.address] }, vendor: { accounts: [vendorA.address, vendorB.address] } },
    deleteTo: service.address, state: 'OPEN', consumed: [], policyLayers: [layerHash(policy)], mandateId: mandate.id,
  }
  const reg = svc.register(engagement, mandate)
  log(`co-signer ${cosigner.address} registered ${ENG_ID} with layers:\n       ${reg.layers.join('\n       ')}`)
  log('mandate: budget 5,000 · daily cap 3,000 · approval above 1,000 · vendors A, B')

  // ── Spend helper ──
  const rlusd = policy.assets!.RLUSD
  const invoice = (v: Wallet, ref: string, amount: string) => stmt(v, 'VENDOR', 'party.invoice/1', { invoiceRef: ref }, { invoiceRef: ref, amount, currency: 'RLUSD', po: 'PO-DEMO' })
  const intent = (to: string, value: string, ref: string) => intentHashOf(to, parseAmount(value, rlusd), rlusd.decimals, ref)
  let nextSeq = Number(((await accountInfo(client, eng.address))!.account_data as Json).Sequence)
  const refreshSeq = async () => { nextSeq = Number(((await accountInfo(client, eng.address))!.account_data as Json).Sequence) }
  const payment = async (to: string, value: string, ref: string, seq: number): Promise<Json> => ({
    TransactionType: 'Payment', Account: eng.address, Destination: to, Amount: iou(CUR, issuer.address, value),
    Fee: multisigFee(fees.base, 2), Sequence: seq, LastLedgerSequence: (await currentLedger(client)) + 20, SigningPubKey: '', Flags: 0,
    Memos: [memo('eng/basis', 'spend'), memo('eng/invoice', ref)],
  })
  async function ask(tx: Json, statements: Statement[], stage = 'spend'): Promise<{ r: DecideResponse; agentBlob: string }> {
    const agentBlob = multisignBlob(agent, tx)
    const r = await svc.decide({ engagementId: ENG_ID, stage, txBlob: agentBlob, statements })
    log(`co-signer: ${r.decision}${r.failing.length ? ' ' + r.failing.join(',') : ''}${r.statementsRejected.length ? ` · rejected ${r.statementsRejected.map((s) => s.code).join(',')}` : ''} · record ${r.record.id.slice(0, 16)}…`)
    return { r, agentBlob }
  }
  const settle = async (agentBlob: string, r: DecideResponse) => submit(client, combine([agentBlob, r.signerBlob!]))

  // D2: in-policy spend
  {
    const invA = invoice(vendorA, 'inv:A-001', '800.00')
    const pre = await iouBalance(client, vendorA.address, CUR, issuer.address)
    const { r, agentBlob } = await ask(await payment(vendorA.address, '800', 'inv:A-001', nextSeq), [invA])
    const s = r.decision === 'SIGN' ? await settle(agentBlob, r) : null
    const delta = Number(await iouBalance(client, vendorA.address, CUR, issuer.address)) - Number(pre)
    record('D2', 'agent + co-signer pay vendor A 800 (invoice attached, under the approval threshold)', 'SIGN; tesSUCCESS; vendor A +800', `${r.decision}; ${s?.final}; vendor A +${delta}`, r.decision === 'SIGN' && s?.final === 'tesSUCCESS' && near(delta, 800), { tx: s?.hash })
    await refreshSeq()
  }

  // D3 + D4: above threshold → approval required, then present
  const invB = invoice(vendorB, 'inv:B-001', '1500.00')
  let approval: Statement
  {
    const { r } = await ask(await payment(vendorB.address, '1500', 'inv:B-001', nextSeq), [invB])
    record('D3', '1,500 to vendor B without an approval', 'REFUSE W5 (APPROVAL_REQUIRED)', `${r.decision} ${r.failing.join(',')}`, r.decision === 'REFUSE' && r.failing.join() === 'W5')
    approval = stmt(controller, 'APPROVER', 'approval.payment/1', { intentHash: intent(vendorB.address, '1500', 'inv:B-001') }, { approverRole: 'controller', notAfter: new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), comment: 'demo approval' })
    const pre = await iouBalance(client, vendorB.address, CUR, issuer.address)
    const a = await ask(await payment(vendorB.address, '1500', 'inv:B-001', nextSeq), [invB, approval])
    const s = a.r.decision === 'SIGN' ? await settle(a.agentBlob, a.r) : null
    const delta = Number(await iouBalance(client, vendorB.address, CUR, issuer.address)) - Number(pre)
    record('D4', 'same payment with the controller’s approval bound to the payment intent', 'SIGN; tesSUCCESS; vendor B +1500', `${a.r.decision}; ${s?.final}; vendor B +${delta}`, a.r.decision === 'SIGN' && s?.final === 'tesSUCCESS' && near(delta, 1500), { tx: s?.hash })
    await refreshSeq()
  }

  // D5: in-flight race — two 400 payments, only 700 left today
  {
    const r1 = await ask(await payment(vendorA.address, '400', 'inv:A-002', nextSeq), [invoice(vendorA, 'inv:A-002', '400.00')])
    const r2 = await ask(await payment(vendorA.address, '400', 'inv:A-003', nextSeq + 1), [invoice(vendorA, 'inv:A-003', '400.00')])
    const s = r1.r.decision === 'SIGN' ? await settle(r1.agentBlob, r1.r) : null
    record('D5', 'race: two 400 payments requested before either validates (2,300 spent, cap 3,000)',
      'first SIGN (and tesSUCCESS); second REFUSE W3 because the first is counted in flight',
      `first ${r1.r.decision} (${s?.final}); second ${r2.r.decision} ${r2.r.failing.join(',')}`,
      r1.r.decision === 'SIGN' && s?.final === 'tesSUCCESS' && r2.r.decision === 'REFUSE' && r2.r.failing.join() === 'W3', { tx: s?.hash })
    await refreshSeq()
  }

  // D6: daily cap
  {
    const { r } = await ask(await payment(vendorA.address, '900', 'inv:A-004', nextSeq), [invoice(vendorA, 'inv:A-004', '900.00')])
    record('D6', '900 more today (2,700 validated + 900 > 3,000)', 'REFUSE W3 (DAILY_CAP)', `${r.decision} ${r.failing.join(',')}`, r.decision === 'REFUSE' && r.failing.join() === 'W3')
  }

  // D7: replay the consumed approval + invoice
  {
    const { r } = await ask(await payment(vendorB.address, '1500', 'inv:B-001', nextSeq), [invB, approval])
    const codes = r.statementsRejected.map((s) => s.code)
    record('D7', 'replay D4’s approval and invoice for a second 1,500 payment', 'REFUSE; both statements rejected as CONSUMED', `${r.decision} ${r.failing.join(',')}; rejected ${codes.join(',')}`, r.decision === 'REFUSE' && codes.filter((c) => c === 'CONSUMED').length === 2)
  }

  // D8: payee outside the mandate
  {
    const { r } = await ask(await payment(stranger.address, '100', 'inv:X-001', nextSeq), [invoice(stranger, 'inv:X-001', '100.00')])
    record('D8', 'pay a non-vendor (no KYB credential, not in the mandate)', 'REFUSE incl. B6, W2', `${r.decision} ${r.failing.join(',')}`, r.decision === 'REFUSE' && r.failing.includes('B6') && r.failing.includes('W2'))
  }

  // D9: agent alone
  {
    const tx = await payment(vendorA.address, '100', 'inv:A-005', nextSeq)
    const s = await submit(client, combine([multisignBlob(agent, tx)]), { waitLedgers: 5 })
    record('D9', 'agent submits with only its own signature (weight 1 < quorum 2)', 'tefBAD_QUORUM', s.final, s.final === 'tefBAD_QUORUM', { tx: s.hash })
  }

  // D10: smuggled SetRegularKey
  {
    const pay = await payment(vendorA.address, '100', 'inv:A-006', nextSeq + 1)
    const { Memos: _m, LastLedgerSequence: _l, Fee: _f, SigningPubKey: _k, Sequence: _s, ...p } = pay
    void _m; void _l; void _f; void _k; void _s
    const raw = [inner(p, { Sequence: nextSeq + 1 }), inner({ TransactionType: 'SetRegularKey', Account: eng.address, RegularKey: agent.address }, { Sequence: nextSeq + 2 })]
    const batch: Json = {
      TransactionType: 'Batch', Account: eng.address, Flags: 0x00010000, Sequence: nextSeq, LastLedgerSequence: (await currentLedger(client)) + 20, SigningPubKey: '',
      Fee: String(Math.ceil(fees.base * (2 + 2 + 2) * 1.5)), RawTransactions: raw, Memos: [memo('eng/basis', 'spend'), memo('eng/invoice', 'inv:A-006')],
    }
    const { r } = await ask(batch, [invoice(vendorA, 'inv:A-006', '100.00')])
    record('D10', 'Batch hides a SetRegularKey (agent key) next to a valid payment', 'REFUSE incl. B2', `${r.decision} ${r.failing.join(',')}`, r.decision === 'REFUSE' && r.failing.includes('B2'))
  }

  // D11: owner closes alone (sweep residual → remove line → AccountDelete)
  if (process.env.SKIP_CLOSE) {
    log('SKIP_CLOSE set: leaving the engagement account open')
  } else {
    await refreshSeq()
    const need = nextSeq + 256 + 2
    for (;;) {
      const cur = await currentLedger(client)
      if (cur >= need) break
      process.stdout.write(`\r   · waiting for AccountDelete eligibility: ledger ${cur} / ${need} (~${Math.round(((need - cur) * 3.7) / 60)} min)   `)
      await sleep(15000)
    }
    console.log('\n')
    await refreshSeq()
    const preT = await iouBalance(client, treasury.address, CUR, issuer.address)
    const left = await iouBalance(client, eng.address, CUR, issuer.address)
    const close = buildCloseBatch({
      eng: eng.address, currency: CUR, issuer: issuer.address, payouts: [{ to: treasury.address, partial: true }], deleteTo: service.address,
      seq: nextSeq, lastLedgerSequence: (await currentLedger(client)) + 20, memos: [memo('eng/basis', 'owner.close')], fees, signatures: 1,
    })
    const adv = await svc.decide({ engagementId: ENG_ID, stage: 'close.owner', tx: close, statements: [] })
    log(`co-signer (advisory) on close.owner: ${adv.decision}${adv.failing.length ? ' ' + adv.failing.join(',') : ''}`)
    const s = await submit(client, combine([multisignBlob(treasury, close)]))
    const gone = (await accountInfo(client, eng.address)) === null
    const delta = Number(await iouBalance(client, treasury.address, CUR, issuer.address)) - Number(preT)
    record('D11', 'owner alone (weight 2 = quorum) sweeps the residual, removes the line and deletes the account',
      `tesSUCCESS; account deleted; treasury +${left}; co-signer advisory SIGN`, `${s.final}; deleted=${gone}; treasury +${delta}; advisory ${adv.decision}`,
      s.final === 'tesSUCCESS' && gone && near(delta, Number(left)) && adv.decision === 'SIGN', { tx: s.hash })
  }

  results.decisionLog = path.relative(root, path.join(dataDir, 'decisions.jsonl'))
  results.decisions = svc.decisions(ENG_ID).map((d) => ({ id: d.id, stage: (d.subject as Json).stage, decision: d.claim.decision, failing: d.claim.failing }))
  await client.disconnect()
  results.finishedAt = new Date().toISOString()
  const f = save()
  const passed = results.tests.filter((t) => t.pass).length
  console.log(`\n${passed}/${results.tests.length} passed. Results: ${path.relative(root, f)}\nDecision log: ${results.decisionLog}`)
  process.exit(passed === results.tests.length ? 0 : 1)
}

main().catch((e) => {
  console.error('\nDemo aborted:', e)
  results.error = String((e as Error)?.stack ?? e)
  try { console.log('Partial results:', save()) } catch { /* ignore */ }
  process.exit(1)
})
