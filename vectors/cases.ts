// Conformance case definitions. `vectors/build.ts` turns these into vectors/*.json using the
// reference implementation, after checking each case's declared expectation. Keys are derived
// from fixed strings (packages/policy/test/fixtures.ts): TEST ONLY, never fund them anywhere.
import fs from 'node:fs'
import xrpl from 'xrpl'
import type { Statement, StatementBody, Template } from '@eng/core'
import { Assets, TxFacts, type DecideInput } from '@eng/policy'
import {
  LEDGER_INDEX, W, b1Approval, b1Challenge, b1Engagement, b1Invoice, b1Ledger, b1Mandate, b1Payment, closeBatch, confirmation,
  checkin, claim, concession, dispute, hotel2Close, hotel2Confirmation, hotel2Input, hotel2Ledger, ruling,
  historyEntry, hotelEngagement, hotelLedger, hotelMandate, inflight, memo, policies, review, statement, templates,
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

// hotel@2 (deposit, entry disputes, claims, backup ruling): mirrors packages/policy/test/hotel2.test.ts
const h2 = (over: Partial<DecideInput> & { stage: string }): DecideInput => hotel2Input(over)
const h2basis = (b: string) => [memo('eng/basis', b)]
const H2 = { hotel: W.atlas.address, guest: W.dana.address, fee: W.service.address }
const r2 = (over: Partial<DecideInput> = {}): DecideInput => ({
  stage: 'spend', proposedTx: r2Payment(W.vendorA.address, '800'), engagement: r2Engagement(),
  template: templates.shopping, layers: [policies.baseline, policies.shopping], mandate: r2Mandate(),
  statements: [r2Category(W.vendorA.address, 'retail.grocery'), r2Category(W.vendorB.address, 'retail.books')], ledger: r2Ledger(), inflight: [], ...over,
})

export function policyCases(): PolicyCase[] {
  const hm = hotelMandate()
  const confirm = (city: string): DecideInput => hotel({ stage: 'confirm', proposedTx: null, mandate: hm, engagement: hotelEngagement({ state: 'OPEN', mandateId: hm.id }), statements: [confirmation(city, hm.id)], ledger: hotelLedger({ closeTime: '2026-10-20T09:40:00Z' }) })
  const h2CheckIn = (balance: string): DecideInput => h2({ stage: 'checkin', statements: [hotel2Confirmation(), checkin('checked_in')], ledger: hotel2Ledger({ balance, closeTime: '2026-11-11T16:00:00Z' }) })
  const h2Settle = (payouts: Array<{ to: string; value: string }>): DecideInput => {
    const rv = review(W.dana, 'eng_hotel2_fixture')
    return h2({
      stage: 'settle', proposedTx: hotel2Close(payouts, { memos: [memo('eng/basis', 'settle.agreed'), memo('eng/review', rv.id)] }),
      statements: [hotel2Confirmation(), checkin('checked_in'), claim([{ kind: 'minibar', amount: '58.00' }]), rv], ledger: hotel2Ledger({ balance: '562' }),
    })
  }
  const h2Conceded = (o: { conceded?: boolean; phase?: 'entry' | 'settlement'; closeTime?: string; hotelCredential?: boolean } = {}): DecideInput => {
    const d = dispute(o.phase ?? 'entry')
    const ledger = hotel2Ledger({ balance: '422', dispute: !o.hotelCredential, closeTime: o.closeTime ?? '2026-11-12T10:00:00Z' })
    if (o.hotelCredential) ledger.credentials.push({ issuer: H2.hotel, subject: W.engHotel2.address, type: 'ENG/DISPUTE', accepted: false, expiration: null })
    return h2({ stage: 'refund.conceded', proposedTx: hotel2Close([{ to: H2.guest, value: '422' }], { memos: h2basis('refund.conceded') }), ledger, statements: [hotel2Confirmation(), d, ...(o.conceded === false ? [] : [concession(d.id)])] })
  }
  const h2RefundTx = hotel2Close([{ to: H2.guest, value: '412' }], { tickets: true, memos: h2basis('default.refund') })
  const h2RefundLedger = hotel2Ledger({ closeTime: '2026-11-01T11:00:01Z' })
  const H2_AFTER = '2026-11-12T11:00:01Z'
  const h2NoShow = (statements: Statement[] = [hotel2Confirmation()], ledger = hotel2Ledger({ closeTime: H2_AFTER })): DecideInput => h2({
    stage: 'default.noshow', statements, ledger,
    proposedTx: hotel2Close([{ to: H2.hotel, value: '409.94' }, { to: H2.fee, value: '2.06' }], { tickets: true, memos: h2basis('default.noshow') }),
  })
  const h2Release = (extra: Statement[] = [], balance = '562'): DecideInput => h2({
    stage: 'default.release', statements: [hotel2Confirmation(), checkin('checked_in'), ...extra], ledger: hotel2Ledger({ balance }),
    proposedTx: hotel2Close([{ to: H2.hotel, value: '409.94' }, { to: H2.fee, value: '2.06' }, { to: H2.guest, value: '150' }], { tickets: true, memos: h2basis('default.release') }),
  })
  const H2_RULED = [{ to: H2.hotel, value: '467.65' }, { to: H2.fee, value: '2.35' }, { to: H2.guest, value: '102.00' }]
  const H2_NOFEE = [{ to: H2.hotel, value: '470.00' }, { to: H2.guest, value: '102.00' }]
  const h2Backup = (closeTime: string, o: { extra?: Statement[]; disputes?: Statement[]; tx?: Record<string, unknown>; ruled?: Array<{ to: string; value: string }>; rulingAt?: string } = {}): DecideInput => h2({
    stage: 'ruling.backup', proposedTx: o.tx ?? hotel2Close(H2_RULED, { memos: h2basis('ruling.backup') }),
    statements: [hotel2Confirmation(), checkin('checked_in'), claim([{ kind: 'minibar', amount: '58.00' }]), ...(o.disputes ?? [dispute('settlement')]), ruling(W.backupArbiter, o.ruled ?? H2_RULED, o.rulingAt), ...(o.extra ?? [])],
    ledger: hotel2Ledger({ balance: '572', dispute: true, closeTime }),
  })
  const h2ClaimOnly = (closeTime: string): DecideInput => {
    const cp = [{ to: H2.hotel, value: '467.65' }, { to: H2.fee, value: '2.35' }, { to: H2.guest, value: '92.00' }]
    return h2({
      stage: 'ruling.backup', proposedTx: hotel2Close(cp, { memos: h2basis('ruling.backup') }),
      statements: [hotel2Confirmation(), checkin('checked_in'), claim([{ kind: 'minibar', amount: '58.00' }]), ruling(W.backupArbiter, cp)], ledger: hotel2Ledger({ balance: '562', closeTime }),
    })
  }
  const h2RulingDefault = (amount: string): DecideInput => h2({
    stage: 'ruling.default', proposedTx: hotel2Close([{ to: H2.hotel, value: '467.65' }, { to: H2.fee, value: '2.35' }, { to: H2.guest, value: '92.00' }], { memos: h2basis('ruling.default') }),
    statements: [hotel2Confirmation(), checkin('checked_in'), claim([{ kind: 'damage', amount }])], ledger: hotel2Ledger({ balance: '562' }),
  })
  // Final-review fixes (R28, R29): the first confirmation counts; a check-in counts only once the deposit is in.
  const h2CheckinAt = (status: 'checked_in' | 'refused', t: string): Statement => statement(W.atlas, {
    kind: 'COUNTERPARTY', type: 'party.checkin/1', engagementId: 'eng_hotel2_fixture', subject: { bookingId: 'ATL-60417' },
    claim: { status, room: '204', deposit: { currency: 'RLUSD', value: '150.00' } }, observedAt: t, issuedAt: t,
  })
  const h2Reissued = (() => {
    const c = hotel2Confirmation({ deposit: '100.00' })
    return statement(W.atlas, { kind: 'COUNTERPARTY', type: 'party.confirmation/1', engagementId: 'eng_hotel2_fixture', subject: c.subject, claim: c.claim, observedAt: '2026-11-11T16:00:00Z', issuedAt: '2026-11-11T16:00:00Z' })
  })()
  const h2EntryLate = (stage: 'ruling.backup' | 'refund.conceded'): DecideInput => {
    const d = dispute('entry')
    const payouts = [{ to: H2.guest, value: '422' }]
    return h2({
      stage, proposedTx: hotel2Close(payouts, { memos: h2basis(stage) }),
      statements: [hotel2Confirmation(), d, h2CheckinAt('checked_in', '2026-11-11T21:00:00Z'), stage === 'ruling.backup' ? ruling(W.backupArbiter, payouts) : concession(d.id)],
      ledger: hotel2Ledger({ balance: '422', dispute: true, closeTime: stage === 'ruling.backup' ? '2026-11-21T00:00:00Z' : '2026-11-12T10:00:00Z' }),
    })
  }
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

    // hotel@2 deposit hotel (escrow): confirm / checkin / settle
    { name: 'hotel2.confirm.deposit-within-cap', description: 'Confirmed deposit 150 is within the mandate cap 200', input: h2({ stage: 'confirm', ledger: hotel2Ledger({ closeTime: '2026-11-01T09:40:00Z' }), statements: [hotel2Confirmation()] }), expectFailing: [] },
    { name: 'hotel2.confirm.deposit-over-cap', description: 'Confirmed deposit 250 exceeds the mandate cap 200', input: h2({ stage: 'confirm', ledger: hotel2Ledger({ closeTime: '2026-11-01T09:40:00Z' }), statements: [hotel2Confirmation({ deposit: '250.00' })] }), expectFailing: ['C5'] },
    { name: 'hotel2.checkin.ok', description: 'Check-in once the deposit is on-ledger (balance 562)', input: h2CheckIn('562'), expectFailing: [] },
    { name: 'hotel2.checkin.deposit-missing', description: 'Check-in while the deposit has not arrived (balance 412)', input: h2CheckIn('412'), expectFailing: ['K1', 'K2'] },
    { name: 'hotel2.settle.ok', description: 'Agreed split paying the 58.00 claim, with fee and review', input: h2Settle([{ to: H2.hotel, value: '467.65' }, { to: H2.fee, value: '2.35' }, { to: H2.guest, value: '92.00' }]), expectFailing: [] },
    { name: 'hotel2.settle.unknown-payee', description: 'Payout to an account that is neither guest, hotel nor fee account', input: h2Settle([{ to: H2.hotel, value: '467.65' }, { to: H2.fee, value: '2.35' }, { to: H2.guest, value: '91.00' }, { to: W.arbiter.address, value: '1.00' }]), expectFailing: ['S2', 'S6'] },
    // refund.conceded
    { name: 'hotel2.refund.conceded.ok', description: 'Hotel concedes an entry dispute: full refund', input: h2Conceded(), expectFailing: [] },
    { name: 'hotel2.refund.conceded.no-concession', description: 'Entry dispute without a hotel concession', input: h2Conceded({ conceded: false }), expectFailing: ['F1'] },
    { name: 'hotel2.refund.conceded.settlement-phase', description: 'Concession of a settlement-phase dispute does not authorise a refund', input: h2Conceded({ phase: 'settlement', closeTime: '2026-11-16T11:00:00Z' }), expectFailing: ['F1'] },
    { name: 'hotel2.refund.conceded.hotel-issued-credential', description: 'Dispute Credential issued by the hotel, not the guest', input: h2Conceded({ hotelCredential: true }), expectFailing: ['F1'] },
    // default.refund
    { name: 'hotel2.default.refund.ok', description: 'Never confirmed: refund after confirmBy', input: h2({ stage: 'default.refund', proposedTx: h2RefundTx, ledger: h2RefundLedger }), expectFailing: [] },
    { name: 'hotel2.default.refund.confirmed', description: 'Refund default refused once the booking is confirmed', input: h2({ stage: 'default.refund', proposedTx: h2RefundTx, ledger: h2RefundLedger, statements: [hotel2Confirmation()] }), expectFailing: ['R1'] },
    { name: 'hotel2.default.refund.over-cap-confirmation', description: 'The only confirmation states a deposit over the cap, so it does not count', input: h2({ stage: 'default.refund', proposedTx: h2RefundTx, ledger: h2RefundLedger, statements: [hotel2Confirmation({ deposit: '250.00' })] }), expectFailing: [] },
    // default.noshow
    { name: 'hotel2.default.noshow.ok', description: 'Confirmed, not checked in, after entryDisputeBy: room released to the hotel', input: h2NoShow(), expectFailing: [] },
    { name: 'hotel2.default.noshow.checked-in', description: 'Guest checked in and paid the deposit', input: h2NoShow([hotel2Confirmation(), checkin('checked_in')], hotel2Ledger({ closeTime: H2_AFTER, balance: '562' })), expectFailing: ['B7', 'B11', 'N3', 'N5'] },
    { name: 'hotel2.default.noshow.checked-in-no-deposit', description: 'Hotel posted checked_in but the guest never paid the deposit: not a stay, the no-show applies', input: h2NoShow([hotel2Confirmation(), checkin('checked_in')]), expectFailing: [] },
    { name: 'hotel2.default.noshow.checked-in-then-refused', description: 'The latest check-in statement (refused) counts; the paid deposit still blocks the no-show', input: h2NoShow([hotel2Confirmation(), checkin('checked_in'), h2CheckinAt('refused', '2026-11-11T15:05:00Z')], hotel2Ledger({ closeTime: H2_AFTER, balance: '562' })), expectFailing: ['B7', 'B11', 'N5'] },
    { name: 'hotel2.default.noshow.dispute-bonded', description: 'Guest dispute open and the bond changed the balance', input: h2NoShow([hotel2Confirmation(), dispute('entry')], hotel2Ledger({ closeTime: H2_AFTER, dispute: true, balance: '422' })), expectFailing: ['B7', 'B11', 'N4', 'N5'] },
    { name: 'hotel2.default.noshow.credential-without-attestation', description: 'Dispute Credential with no dispute attestation is ignored', input: h2NoShow([hotel2Confirmation()], hotel2Ledger({ closeTime: H2_AFTER, dispute: true, balance: '412' })), expectFailing: [] },
    { name: 'hotel2.default.noshow.no-bond', description: 'Dispute Credential and attestation but no bond posted: ignored', input: h2NoShow([hotel2Confirmation(), dispute('entry')], hotel2Ledger({ closeTime: H2_AFTER, dispute: true, balance: '412' })), expectFailing: [] },
    { name: 'hotel2.default.noshow.too-early', description: 'checkInBy passed but entryDisputeBy has not', input: h2NoShow([hotel2Confirmation()], hotel2Ledger({ closeTime: '2026-11-12T11:00:00Z' })), expectFailing: ['N1'] },
    { name: 'hotel2.default.noshow.deposit-over-cap', description: 'Confirmed deposit exceeds the mandate cap', input: h2NoShow([hotel2Confirmation({ deposit: '250.00' })]), expectFailing: ['N2'] },
    // default.release
    { name: 'hotel2.default.release.ok', description: 'Room to the hotel, deposit to the guest after the window', input: h2Release(), expectFailing: [] },
    { name: 'hotel2.default.release.claim-posted', description: 'A hotel claim is posted', input: h2Release([claim([{ kind: 'minibar', amount: '58.00' }])]), expectFailing: ['L5'] },
    { name: 'hotel2.default.release.stray-funds', description: 'Stray RLUSD changed the balance (exact-balance lock)', input: h2Release([], '563'), expectFailing: ['B7', 'B11', 'L3'] },
    { name: 'hotel2.default.release.dispute-open', description: 'Settlement dispute with bond: balance 572', input: { ...h2Release([dispute('settlement')]), ledger: hotel2Ledger({ balance: '572', dispute: true }) }, expectFailing: ['B7', 'B11', 'L2', 'L3'] },
    { name: 'hotel2.default.release.reissued-confirmation-ignored', description: 'A re-issued confirmation (deposit 100) does not move the deposit: the first one counts', input: h2Release([h2Reissued]), expectFailing: [] },
    { name: 'hotel2.default.release.reissued-confirmation-payout', description: 'Paying only the re-issued deposit (100) back to the guest is refused', input: { ...h2Release([h2Reissued]), proposedTx: hotel2Close([{ to: H2.hotel, value: '459.69' }, { to: H2.fee, value: '2.31' }, { to: H2.guest, value: '100' }], { tickets: true, memos: h2basis('default.release') }) }, expectFailing: ['L6'] },
    { name: 'hotel2.default.release.at-window-end', description: 'Exactly at disputeWindowEnds: refused (strict deadline)', input: { ...h2Release(), ledger: hotel2Ledger({ balance: '562', closeTime: '2026-11-17T11:00:00Z' }) }, expectFailing: ['L1'] },
    { name: 'hotel2.default.release.after-window-end', description: 'One second after disputeWindowEnds: signs', input: { ...h2Release(), ledger: hotel2Ledger({ balance: '562', closeTime: '2026-11-17T11:00:01Z' }) }, expectFailing: [] },
    // ruling.backup
    { name: 'hotel2.ruling.backup.before-window', description: '1 s before the ruling window elapses', input: h2Backup('2026-11-21T09:59:59Z'), expectFailing: ['U1'] },
    { name: 'hotel2.ruling.backup.at-window-end', description: 'Exactly at the end of the ruling window: refused', input: h2Backup('2026-11-21T10:00:00Z'), expectFailing: ['U1'] },
    { name: 'hotel2.ruling.backup.ok', description: 'After the window, tx matches the backup arbiter ruling', input: h2Backup('2026-11-21T10:00:01Z'), expectFailing: [] },
    { name: 'hotel2.ruling.backup.primary-ruled', description: 'The primary arbiter has ruled', input: h2Backup('2026-11-21T10:00:01Z', { extra: [ruling(W.arbiter, H2_RULED)] }), expectFailing: ['U2'] },
    { name: 'hotel2.ruling.backup.backdated-dispute', description: 'Dispute backdated to 11-02 is floored at deliveryBy: backup cannot rule right after filing', input: h2Backup('2026-11-16T10:05:00Z', { disputes: [dispute('settlement', '2026-11-02T00:00:00Z')], rulingAt: '2026-11-16T10:01:00Z' }), expectFailing: ['U1'] },
    { name: 'hotel2.ruling.backup.settlement-dispute-own-filing', description: 'Window runs from the settlement dispute, not an older entry-phase attestation', input: h2Backup('2026-11-17T00:00:00Z', { disputes: [dispute('entry'), dispute('settlement')], rulingAt: '2026-11-16T10:01:00Z' }), expectFailing: ['U1'] },
    { name: 'hotel2.ruling.backup.extra-payee', description: 'Tx pays an account the ruling does not name', input: h2Backup('2026-11-21T10:00:01Z', { tx: hotel2Close([{ to: H2.hotel, value: '467.65' }, { to: H2.fee, value: '2.35' }, { to: H2.guest, value: '101.00' }, { to: W.arbiter.address, value: '1.00' }], { memos: h2basis('ruling.backup') }) }), expectFailing: ['U4', 'U5'] },
    { name: 'hotel2.ruling.backup.duplicate-payee', description: 'Ruling names the hotel twice', input: h2Backup('2026-11-21T10:00:01Z', { ruled: [{ to: H2.hotel, value: '467.65' }, { to: H2.hotel, value: '0' }, { to: H2.guest, value: '102.00' }] }), expectFailing: ['U4'] },
    { name: 'hotel2.ruling.backup.no-fee', description: 'Ruling with no service fee on what the hotel receives', input: h2Backup('2026-11-21T10:00:01Z', { ruled: H2_NOFEE, tx: hotel2Close(H2_NOFEE, { memos: h2basis('ruling.backup') }) }), expectFailing: ['U6'] },
    { name: 'hotel2.ruling.backup.entry-dispute-late-checkin', description: 'A checked_in after a bonded entry dispute (no deposit paid) does not stop the dispute counting', input: h2EntryLate('ruling.backup'), expectFailing: [] },
    { name: 'hotel2.refund.conceded.late-checkin', description: 'The hotel can still concede an entry dispute after posting checked_in without the deposit', input: h2EntryLate('refund.conceded'), expectFailing: [] },
    { name: 'hotel2.ruling.backup.claim-only-at-end', description: 'Claim-only branch: exactly at disputeWindowEnds + rulingWindow is refused', input: h2ClaimOnly('2026-11-22T11:00:00Z'), expectFailing: ['U1'] },
    { name: 'hotel2.ruling.backup.claim-only-after', description: 'Claim-only branch: one second later signs', input: h2ClaimOnly('2026-11-22T11:00:01Z'), expectFailing: [] },
    // ruling.default (advisory)
    { name: 'hotel2.ruling.default.ok', description: 'Unanswered 58.00 claim paid exactly after the window', input: h2RulingDefault('58.00'), expectFailing: [] },
    { name: 'hotel2.ruling.default.claim-over-deposit', description: 'Claim above the deposit', input: h2RulingDefault('160.00'), expectFailing: ['D4', 'D5'] },
    { name: 'hotel2.ruling.default.claim-mismatch', description: 'Payouts do not match the claim', input: h2RulingDefault('50.00'), expectFailing: ['D5'] },
  ]
}

// ── Template validator cases ─────────────────────────────────────────────────
export interface TemplateCase { name: string; description: string; template: Template; options?: { preCreateFundingDrops?: string }; expectErrors: string[] }

export function templateCases(): TemplateCase[] {
  const h = () => structuredClone(templates.hotel)
  const mut = (f: (t: Template) => void) => { const t = h(); f(t); return t }
  return [
    { name: 'hotel.ok', description: 'Shipped hotel template', template: h(), options: { preCreateFundingDrops: '6000000' }, expectErrors: [] },
    { name: 'hotel2.ok', description: 'Shipped hotel@2 template (deposit, backup arbiter)', template: structuredClone(templates.hotel2), options: { preCreateFundingDrops: '6000000' }, expectErrors: [] },
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
    { name: 'V13.window-unknown-timer', description: 'An attestation window names a timer the engagement does not carry', template: (() => { const t = structuredClone(templates.hotel2); t.attestationWindows = { ...t.attestationWindows, 'party.claim/1': 'claimByTypo' }; return t })(), expectErrors: ['V13'] },
    { name: 'V13.window-not-a-type', description: 'An attestation window key is not a statement type', template: (() => { const t = structuredClone(templates.hotel2); t.attestationWindows = { ...t.attestationWindows, 'claim#': 'claimBy' }; return t })(), expectErrors: ['V13'] },
    { name: 'V14.entry-dispute-before-checkin', description: 'entryDisputeBy closes before checkInBy (same anchor)', template: (() => { const t = structuredClone(templates.hotel2); t.timers!.entryDisputeBy.durationSecs = 3600; return t })(), expectErrors: ['V14'] },
    { name: 'V14.claim-not-before-dispute-end', description: 'claimBy does not close before disputeWindowEnds (same anchor)', template: (() => { const t = structuredClone(templates.hotel2); t.timers!.claimBy.durationSecs = 259200; return t })(), expectErrors: ['V14'] },
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
