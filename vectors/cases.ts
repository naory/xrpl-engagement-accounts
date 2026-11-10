// Conformance case definitions. `vectors/build.ts` turns these into vectors/*.json using the
// reference implementation, after checking each case's declared expectation. Keys are derived
// from fixed strings (packages/policy/test/fixtures.ts): TEST ONLY, never fund them anywhere.
import fs from 'node:fs'
import xrpl from 'xrpl'
import type { StatementBody, Template } from '@eng/core'
import { Assets, TxFacts, type DecideInput } from '@eng/policy'
import {
  LEDGER_INDEX, W, b1Approval, b1Challenge, b1Engagement, b1Invoice, b1Ledger, b1Mandate, b1Payment, closeBatch, confirmation,
  historyEntry, hotelEngagement, hotelLedger, hotelMandate, inflight, memo, policies, review, templates,
  r2Category, r2Challenge, r2Engagement, r2Ledger, r2Mandate, r2Payment,
} from '../packages/policy/test/fixtures.ts'

export interface PolicyCase { name: string; description: string; input: DecideInput; expectFailing: string[] }

const b1 = (over: Partial<DecideInput> = {}): DecideInput => ({
  stage: 'spend', proposedTx: b1Payment(W.vendorA.address, '800', { invoice: 'inv:2026-Q4-0042' }), engagement: b1Engagement(),
  template: templates.procurement, layers: [policies.baseline, policies.procurement], mandate: b1Mandate(),
  statements: [b1Invoice()], ledger: b1Ledger(), inflight: [], ...over,
})
const assets = new Assets(policies.procurement.assets!)
const intentOf = (i: DecideInput) => new TxFacts(i.proposedTx!, { eng: i.engagement, template: i.template, assets, ledger: i.ledger }).intentHash()
const big = (): DecideInput => b1({ proposedTx: b1Payment(W.vendorA.address, '1500', { invoice: 'inv:2026-Q4-0042' }), statements: [b1Invoice(W.vendorA, '1500.00')] })
const withStmt = (i: DecideInput, f: (i: DecideInput) => DecideInput['statements'][number], over: Partial<DecideInput> = {}): DecideInput => {
  i.statements.push(f(i))
  return { ...i, ...over }
}

const hotel = (over: Partial<DecideInput> & { payouts?: Array<{ to: string; value: string; partial?: boolean }>; closeOpts?: Parameters<typeof closeBatch>[1]; withReview?: boolean } = {}): DecideInput => {
  const rv = review()
  const { payouts, closeOpts, withReview = true, ...rest } = over
  return {
    stage: 'settle',
    proposedTx: closeBatch(payouts ?? [{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }], { memos: [memo('eng/basis', 'settle.agreed'), memo('eng/review', rv.id)], ...closeOpts }),
    engagement: hotelEngagement(), template: templates.hotel, layers: [policies.baseline, policies.hotel], mandate: hotelMandate(),
    statements: withReview ? [rv] : [], ledger: hotelLedger(), inflight: [], ...rest,
  }
}
const refundTx = () => closeBatch([{ to: W.dana.address, value: '412' }], { tickets: true, memos: [memo('eng/basis', 'default.refund')] })
const releaseTx = () => closeBatch([{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }], { tickets: true, memos: [memo('eng/basis', 'default.release')] })
const r2 = (over: Partial<DecideInput> = {}): DecideInput => ({
  stage: 'spend', proposedTx: r2Payment(W.vendorA.address, '800'), engagement: r2Engagement(),
  template: templates.shopping, layers: [policies.baseline, policies.shopping], mandate: r2Mandate(),
  statements: [r2Category(W.vendorA.address, 'retail.grocery'), r2Category(W.vendorB.address, 'retail.books')], ledger: r2Ledger(), inflight: [], ...over,
})

export function policyCases(): PolicyCase[] {
  const hm = hotelMandate()
  const confirm = (city: string): DecideInput => hotel({ stage: 'confirm', proposedTx: null, mandate: hm, engagement: hotelEngagement({ state: 'OPEN', mandateId: hm.id }), statements: [confirmation(city, hm.id)], ledger: hotelLedger({ closeTime: '2026-10-20T09:40:00Z' }) })
  const extraObj = hotelLedger()
  extraObj.accounts[W.engHotel.address].ownerObjects!.other = 1
  const smuggle = (() => {
    const pay = b1Payment(W.vendorA.address, '800', { invoice: 'inv:2026-Q4-0042' })
    const inner = (t: Record<string, unknown>) => ({ RawTransaction: { ...t, Fee: '0', SigningPubKey: '', Flags: 0x40000000 } })
    const { Memos: _m, LastLedgerSequence: _l, ...p } = pay
    void _m; void _l
    return {
      TransactionType: 'Batch', Account: W.engB1.address, Flags: 0x00010000, Fee: '60', Sequence: 21, LastLedgerSequence: LEDGER_INDEX + 20, SigningPubKey: '',
      RawTransactions: [inner({ ...p, Sequence: 22 }), inner({ TransactionType: 'SetRegularKey', Account: W.engB1.address, RegularKey: W.agent.address, Sequence: 23 })],
      Memos: [memo('eng/basis', 'spend'), memo('eng/invoice', 'inv:2026-Q4-0042')],
    }
  })()

  return [
    // B1 procurement (owner-wallet)
    { name: 'b1.spend.ok', description: 'In-mandate 800 RLUSD payment to a KYB’d vendor with a matching invoice', input: b1(), expectFailing: [] },
    { name: 'b1.spend.x402-ok', description: 'Payment matches the agent’s x402 challenge (destination, amount, invoice)', input: b1({ statements: [b1Invoice(), b1Challenge()] }), expectFailing: [] },
    { name: 'b1.spend.x402-wrong-destination', description: 'x402 challenge names a different merchant than the payee', input: b1({ statements: [b1Invoice(), b1Challenge({ payTo: W.vendorB.address })] }), expectFailing: ['W7'] },
    { name: 'b1.spend.x402-wrong-amount', description: 'x402 challenge amount differs from the payment', input: b1({ statements: [b1Invoice(), b1Challenge({ amount: '799.00' })] }), expectFailing: ['W7'] },
    { name: 'b1.spend.daily-cap', description: '9,500 already paid today; 800 more exceeds the 10,000 daily cap', input: b1({ ledger: b1Ledger({ history: [historyEntry('9500', '2026-11-18T01:00:00Z')] }) }), expectFailing: ['W3'] },
    { name: 'b1.spend.budget', description: 'Older outflow is outside the 24h window but inside the 90-day budget', input: b1({ ledger: b1Ledger({ history: [historyEntry('9500', '2026-11-16T01:00:00Z'), historyEntry('40000', '2026-10-01T00:00:00Z')] }) }), expectFailing: ['W4'] },
    { name: 'b1.spend.inflight', description: 'A signed-but-unvalidated 9,500 payment counts against the cap', input: b1({ inflight: [inflight('9500')] }), expectFailing: ['W3'] },
    { name: 'b1.spend.approval-missing', description: '1,500 is above the 1,000 approval threshold; no approval', input: big(), expectFailing: ['W5'] },
    { name: 'b1.spend.approval-ok', description: 'Controller approval bound to the payment intent', input: withStmt(big(), (i) => b1Approval(intentOf(i))), expectFailing: [] },
    { name: 'b1.spend.approval-wrong-intent', description: 'Approval bound to a 1,400 payment does not cover 1,500', input: withStmt(big(), () => b1Approval(intentOf(b1({ proposedTx: b1Payment(W.vendorA.address, '1400', { invoice: 'inv:2026-Q4-0042' }) })))), expectFailing: ['W5'] },
    { name: 'b1.spend.approval-expired', description: 'Approval notAfter is before the ledger close', input: withStmt(big(), (i) => b1Approval(intentOf(i), W.controller, '2026-11-18T09:32:00Z')), expectFailing: ['W5'] },
    { name: 'b1.spend.approval-not-in-terms', description: 'Approval signed by an account the deal terms do not name', input: withStmt(big(), (i) => b1Approval(intentOf(i), W.stranger)), expectFailing: ['W5'] },
    { name: 'b1.spend.approval-stale', description: 'Approval observed more than 1h before the ledger close (maxLag)', input: withStmt(big(), (i) => b1Approval(intentOf(i), W.controller, '2026-11-20T00:00:00Z', '2026-11-18T08:00:00Z')), expectFailing: ['W5'] },
    (() => {
      const i = big()
      const a = b1Approval(intentOf(i))
      i.statements.push(a)
      return { name: 'b1.spend.approval-consumed', description: 'Single-use approval already consumed by an earlier payment', input: { ...i, engagement: b1Engagement({ consumed: [a.id] }) }, expectFailing: ['W5'] }
    })(),
    { name: 'b1.spend.non-vendor', description: 'Payee is not a mandate vendor', input: b1({ proposedTx: b1Payment(W.stranger.address, '800', { invoice: 'inv:2026-Q4-0042' }) }), expectFailing: ['B6', 'W2', 'W6'] },
    { name: 'b1.spend.no-kyb', description: 'Vendor lacks the KYB credential', input: b1({ ledger: b1Ledger({ kyb: [W.vendorB.address] }) }), expectFailing: ['W2'] },
    { name: 'b1.spend.kyb-wrong-issuer', description: 'KYB credential from an issuer the policy does not accept', input: b1({ ledger: b1Ledger({ kyb: [], extraCreds: [{ issuer: W.fakeIssuer.address, subject: W.vendorA.address, type: 'KYB_VERIFIED', accepted: true, expiration: null }] }) }), expectFailing: ['W2'] },
    { name: 'b1.spend.invoice-amount', description: 'Invoice amount differs by 0.01', input: b1({ statements: [b1Invoice(W.vendorA, '799.99')] }), expectFailing: ['W6'] },
    { name: 'b1.spend.invoice-foreign', description: 'Invoice signed by a different vendor than the payee', input: b1({ statements: [b1Invoice(W.vendorB, '800.00')] }), expectFailing: ['W6'] },
    { name: 'b1.spend.wrong-issuer', description: 'IOU with the right currency code from the wrong issuer', input: b1({ proposedTx: b1Payment(W.vendorA.address, '800', { invoice: 'inv:2026-Q4-0042', issuer: W.fakeIssuer.address }) }), expectFailing: ['B10'] },
    { name: 'b1.spend.setregularkey-smuggle', description: 'Batch hides a SetRegularKey next to a valid payment', input: b1({ proposedTx: smuggle }), expectFailing: ['B2', 'W1'] },
    { name: 'b1.spend.fee-cap', description: 'Fee above the baseline cap', input: b1({ proposedTx: b1Payment(W.vendorA.address, '800', { invoice: 'inv:2026-Q4-0042', fee: '50000' }) }), expectFailing: ['B3'] },
    { name: 'b1.spend.no-lls', description: 'Live-stage transaction without LastLedgerSequence', input: b1({ proposedTx: b1Payment(W.vendorA.address, '800', { invoice: 'inv:2026-Q4-0042', lls: null }) }), expectFailing: ['B4'] },
    { name: 'b1.spend.mandate-expired', description: 'Mandate expired before the ledger close', input: b1({ mandate: b1Mandate({ expires: '2026-11-18T09:00:00Z' }) }), expectFailing: ['W0'] },
    { name: 'b1.stage.unknown', description: 'No layer defines the requested stage', input: b1({ stage: 'bogus' }), expectFailing: ['NO_RULES_FOR_STAGE', 'B2'] },
    // Hotel (escrow)
    { name: 'hotel.settle.ok', description: 'Agreed settle: 409.94 to the merchant, 2.06 (50 bps) fee, review attached', input: hotel(), expectFailing: [] },
    { name: 'hotel.settle.no-review', description: 'Agreed settle without the guest’s review', input: hotel({ withReview: false }), expectFailing: ['S5'] },
    { name: 'hotel.settle.dispute-open', description: 'A dispute credential exists on the account', input: hotel({ ledger: hotelLedger({ dispute: true }) }), expectFailing: ['S1'] },
    { name: 'hotel.settle.fee-mismatch', description: 'Fee 2.00 instead of 50 bps', input: hotel({ payouts: [{ to: W.atlas.address, value: '410' }, { to: W.service.address, value: '2' }] }), expectFailing: ['S4'] },
    { name: 'hotel.settle.leaves-funds', description: 'Close that does not drain the account', input: hotel({ payouts: [{ to: W.atlas.address, value: '400' }, { to: W.service.address, value: '2.01' }] }), expectFailing: ['B7', 'S4'] },
    { name: 'hotel.settle.residual-sweep', description: 'Stray 5 RLUSD swept to the guest with tfPartialPayment (E9)', input: hotel({ payouts: [{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }, { to: W.dana.address, value: '0', partial: true }], ledger: hotelLedger({ balance: '417' }) }), expectFailing: [] },
    { name: 'hotel.settle.bad-delete-destination', description: 'AccountDelete to the merchant instead of the agreed destination', input: hotel({ closeOpts: { deleteTo: W.atlas.address } }), expectFailing: ['B7'] },
    { name: 'hotel.settle.not-atomic', description: 'Batch in ONLYONE mode instead of ALLORNOTHING', input: hotel({ closeOpts: { flags: 0x00040000 } }), expectFailing: ['B5'] },
    { name: 'hotel.confirm.ok', description: 'Merchant confirmation matches the mandate', input: confirm('Lisbon'), expectFailing: [] },
    { name: 'hotel.confirm.wrong-city', description: 'Merchant confirmed Porto; the mandate says Lisbon', input: confirm('Porto'), expectFailing: ['C2'] },
    { name: 'hotel.default.refund.early', description: 'Refund default requested before confirmBy', input: hotel({ stage: 'default.refund', proposedTx: refundTx(), engagement: hotelEngagement({ state: 'OPEN' }), withReview: false, ledger: hotelLedger({ closeTime: '2026-10-20T10:00:00Z' }) }), expectFailing: ['R1'] },
    { name: 'hotel.default.refund.ok', description: 'Refund default after confirmBy; ticketed, no LastLedgerSequence', input: hotel({ stage: 'default.refund', proposedTx: refundTx(), engagement: hotelEngagement({ state: 'OPEN' }), withReview: false, ledger: hotelLedger({ closeTime: '2026-10-20T11:00:01Z' }) }), expectFailing: [] },
    { name: 'hotel.default.release.ok', description: 'Release default after the dispute window', input: hotel({ stage: 'default.release', proposedTx: releaseTx(), withReview: false }), expectFailing: [] },
    { name: 'hotel.default.release.dispute', description: 'Release default while a dispute is open', input: hotel({ stage: 'default.release', proposedTx: releaseTx(), withReview: false, ledger: hotelLedger({ dispute: true }) }), expectFailing: ['L2'] },
    { name: 'hotel.default.release.balance-changed', description: 'Dispute bond changed the balance (exact-balance lock)', input: hotel({ stage: 'default.release', proposedTx: releaseTx(), withReview: false, ledger: hotelLedger({ balance: '422' }) }), expectFailing: ['B7', 'B11', 'L3'] },
    { name: 'hotel.default.release.extra-object', description: 'An extra owned object would make AccountDelete fail (single-shot, F2)', input: hotel({ stage: 'default.release', proposedTx: releaseTx(), withReview: false, ledger: extraObj }), expectFailing: ['B11'] },

    // R2 consumer shopping (owner-wallet, same engine as B1)
    { name: 'r2.spend.ok', description: '800 RLUSD to a category-approved grocery merchant, within the weekly cap', input: r2(), expectFailing: [] },
    { name: 'r2.spend.category-missing', description: 'The payee has no merchant.category classification', input: r2({ statements: [r2Category(W.vendorB.address, 'retail.books')] }), expectFailing: ['SH2'] },
    { name: 'r2.spend.category-forbidden', description: 'Merchant classified into a category the mandate does not allow', input: r2({ statements: [r2Category(W.vendorA.address, 'gambling.casino'), r2Category(W.vendorB.address, 'retail.books')] }), expectFailing: ['SH2'] },
    { name: 'r2.spend.weekly-cap', description: '1,800 already spent this week; 800 more exceeds the 2,000 weekly cap', input: r2({ ledger: r2Ledger({ history: [historyEntry('1800', '2026-11-16T09:00:00Z')] }) }), expectFailing: ['SH3'] },
    { name: 'r2.spend.budget', description: 'Outflow outside the 7-day window but over the 90-day budget', input: r2({ ledger: r2Ledger({ history: [historyEntry('19500', '2026-10-25T09:00:00Z')] }) }), expectFailing: ['SH4'] },
    { name: 'r2.spend.non-allowed-destination', description: 'Payee is neither a mandate merchant nor classified', input: r2({ proposedTx: r2Payment(W.stranger.address, '800') }), expectFailing: ['B6', 'SH2'] },
    { name: 'r2.spend.mpp-challenge-ok', description: 'Payment matches the agent’s MPP challenge (rail-neutral SH5)', input: r2({ proposedTx: r2Payment(W.vendorA.address, '800', { invoice: 'inv:shop-2026-11-0007' }), statements: [r2Category(W.vendorA.address, 'retail.grocery'), r2Challenge()] }), expectFailing: [] },
    { name: 'r2.spend.challenge-mismatch', description: 'MPP challenge names a different merchant than the payee', input: r2({ proposedTx: r2Payment(W.vendorA.address, '800', { invoice: 'inv:shop-2026-11-0007' }), statements: [r2Category(W.vendorA.address, 'retail.grocery'), r2Challenge({ payTo: W.vendorB.address })] }), expectFailing: ['SH5'] },
    { name: 'r2.spend.mandate-expired', description: 'Shopping mandate expired before the ledger close', input: r2({ mandate: r2Mandate({ expires: '2026-11-18T09:00:00Z' }) }), expectFailing: ['SH0'] },
  ]
}

// ── Template validator cases ─────────────────────────────────────────────────
export interface TemplateCase { name: string; description: string; template: Template; options?: { preCreateFundingDrops?: string }; expectErrors: string[] }

export function templateCases(): TemplateCase[] {
  const h = () => structuredClone(templates.hotel)
  const mut = (f: (t: Template) => void) => { const t = h(); f(t); return t }
  return [
    { name: 'hotel.ok', description: 'Shipped hotel template', template: h(), options: { preCreateFundingDrops: '6000000' }, expectErrors: [] },
    { name: 'procurement.ok', description: 'Shipped owner-wallet procurement template', template: structuredClone(templates.procurement), expectErrors: [] },
    { name: 'shopping.ok', description: 'Shipped owner-wallet consumer-shopping template', template: structuredClone(templates.shopping), expectErrors: [] },
    { name: 'V1.service-at-quorum', description: 'Co-signer weight reaches quorum alone', template: mut((t) => { t.roles.cosigner.weight = 5 }), expectErrors: ['V1', 'V2'] },
    { name: 'V2.single-external-at-quorum', description: 'Arbiter alone reaches quorum in an escrow', template: mut((t) => { t.roles.arbiter.weight = 5 }), expectErrors: ['V2', 'V11'] },
    { name: 'V3.stalls-without-service', description: 'No arbiter: every winning set needs the service', template: mut((t) => { delete (t.roles as Record<string, unknown>).arbiter; delete (t.outcomes as Record<string, unknown>)['settle.ruling'] }), expectErrors: ['V3'] },
    { name: 'V5.presigned-without-final', description: 'Principal + counterparty alone reach quorum', template: mut((t) => { t.roles.principal.weight = 3 }), expectErrors: ['V5', 'V12'] },
    { name: 'V7.blueprint-order', description: 'AccountDelete not last', template: mut((t) => { t.blueprints['close.refundAll'].steps = ['pay.principal', 'account.delete', 'trustline.remove'] }), expectErrors: ['V7'] },
    { name: 'V11.equal-arbiters', description: 'Two equal-weight arbiters can collude', template: mut((t) => { t.roles.arbiter2 = { weight: 3, kind: 'arbiter', operatedBy: 'external' } }), expectErrors: ['V11'] },
    { name: 'E4.backup-arbiter', description: 'P3·C3·A1 4·A2 2·S2·Q7 passes with disclosures', template: mut((t) => {
      t.quorum = 7
      t.roles = { principal: { weight: 3, kind: 'principal', operatedBy: 'external' }, counterparty: { weight: 3, kind: 'counterparty', operatedBy: 'external' }, arbiter: { weight: 4, kind: 'arbiter', operatedBy: 'external' }, arbiter2: { weight: 2, kind: 'arbiter', operatedBy: 'external' }, cosigner: { weight: 2, kind: 'cosigner', operatedBy: 'service' } }
    }), expectErrors: [] },
    { name: 'V12.ledger-without-cosigner', description: '"ledger" enforcement on an outcome that does not need the co-signer', template: mut((t) => { t.outcomes['settle.ruling'].enforcement = 'ledger' }), expectErrors: ['V12'] },
  ]
}

// ── Statement envelope cases ─────────────────────────────────────────────────
export function statementCases(): Array<{ name: string; algorithm: string; seed: string; derivation: string; body: StatementBody }> {
  const body = (account: string): StatementBody => ({
    v: 'eng.att/1', type: 'approval.payment/1', engagementId: 'eng_vectors', subject: { intentHash: 'sha256:' + '00'.repeat(32) },
    claim: { approverRole: 'controller', notAfter: '2026-11-20T00:00:00Z', comment: 'naïve café — ünïcödé' },
    observedAt: '2026-11-18T09:31:00Z', issuedAt: '2026-11-18T09:31:02Z', nonce: '0f'.repeat(16), attester: { account, kind: 'APPROVER' },
  })
  const ed = xrpl.Wallet.fromEntropy(Buffer.alloc(16, 1), { algorithm: 'ed25519' as never })
  const k1 = xrpl.Wallet.fromEntropy(Buffer.alloc(16, 2), { algorithm: 'ecdsa-secp256k1' as never })
  return [
    { name: 'approval.ed25519', algorithm: 'ed25519', seed: ed.seed!, derivation: 'xrpl Wallet.fromEntropy(16 × 0x01, ed25519): TEST ONLY', body: body(ed.address) },
    { name: 'approval.secp256k1', algorithm: 'ecdsa-secp256k1', seed: k1.seed!, derivation: 'xrpl Wallet.fromEntropy(16 × 0x02, secp256k1): TEST ONLY', body: body(k1.address) },
  ]
}

export const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8')) as T
