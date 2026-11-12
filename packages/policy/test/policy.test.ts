import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signStatement, verifyStatement } from '@eng/core'
import { Assets, REGISTRY, REGISTRY_VERSION, TxFacts, decide, decisionStatementBody, lintPolicy, type DecideInput, type Decision, type PolicyDoc } from '@eng/policy'
import {
  LEDGER_INDEX, NOW, W, b1Approval, b1Challenge, b1Engagement, b1Invoice, b1Ledger, b1Mandate, b1Payment, closeBatch, confirmation,
  historyEntry, hotelEngagement, hotelLedger, hotelMandate, inflight, memo, policies, review, templates,
} from './fixtures.ts'

const fails = (d: Decision) => d.failing
const result = (d: Decision, id: string) => d.results.find((r) => r.id === id)

// ── B1: procurement agent (owner-wallet) ─────────────────────────────────────
function b1(over: Partial<DecideInput> = {}): DecideInput {
  return {
    stage: 'spend',
    proposedTx: b1Payment(W.vendorA.address, '800', { invoice: 'inv:2026-Q4-0042' }),
    engagement: b1Engagement(),
    template: templates.procurement,
    layers: [policies.baseline, policies.procurement],
    mandate: b1Mandate(),
    statements: [b1Invoice()],
    ledger: b1Ledger(),
    inflight: [],
    ...over,
  }
}
const assets = new Assets(policies.procurement.assets!)
const intentOf = (input: DecideInput) => new TxFacts(input.proposedTx!, { eng: input.engagement, template: input.template, assets, ledger: input.ledger }).intentHash()

describe('B1 spend — happy path', () => {
  it('signs a small in-mandate payment with a matching invoice', () => {
    const d = decide(b1())
    expect(fails(d)).toEqual([])
    expect(d.decision).toBe('SIGN')
    expect(result(d, 'W5')!.result).toBe('n/a') // below the approval threshold
    expect(result(d, 'B11')!.result).toBe('n/a') // not a pre-signed stage
    expect(d.statementsUsed).toHaveLength(2) // mandate + invoice
  })

  it('is deterministic: same inputs → same results and inputsHash', () => {
    const input = b1()
    const a = decide(input)
    const b = decide(structuredClone(input))
    expect(b.inputsHash).toBe(a.inputsHash)
    expect(b.results).toEqual(a.results)
    expect(b.policy.effectiveHash).toBe(a.policy.effectiveHash)
  })

  it('emits a signable cosigner.decision/1 statement', () => {
    const d = decide(b1())
    const body = decisionStatementBody(d, { account: W.cosigner.address }, '00'.repeat(16), intentOf(b1()))
    const s = signStatement(body, W.cosigner)
    const v = verifyStatement(s)
    expect(v.ok).toBe(true)
    expect(s.claim.decision).toBe('SIGN')
    expect(s.claim.inputsHash).toBe(d.inputsHash)
  })
})

describe('B1 spend — stateful counters (W3/W4, E12)', () => {
  it('refuses when today’s validated outflow + this payment exceeds the daily cap', () => {
    const d = decide(b1({ ledger: b1Ledger({ history: [historyEntry('9500', '2026-11-18T01:00:00Z')] }) }))
    expect(fails(d)).toEqual(['W3'])
  })
  it('does not count outflow older than 24h against the daily cap, but does against the budget', () => {
    const old = [historyEntry('9500', '2026-11-16T01:00:00Z'), historyEntry('40000', '2026-10-01T00:00:00Z')]
    const d = decide(b1({ ledger: b1Ledger({ history: old }) }))
    expect(fails(d)).toEqual(['W4'])
  })
  it('counts in-flight signed-but-unvalidated payments (race protection)', () => {
    const d = decide(b1({ inflight: [inflight('9500')] }))
    expect(fails(d)).toEqual(['W3'])
    expect(d.inflightCounted).toEqual(['att:INFLIGHT1'])
    expect(result(d, 'B9')!.result).toBe('pass') // spend is a concurrent stage
  })
})

describe('B1 spend — approval above threshold (W5)', () => {
  const big = () => b1({ proposedTx: b1Payment(W.vendorA.address, '1500', { invoice: 'inv:2026-Q4-0042' }), statements: [b1Invoice(W.vendorA, '1500.00')] })

  it('refuses without an approval', () => {
    expect(fails(decide(big()))).toEqual(['W5'])
  })
  it('signs with a controller approval bound to the payment intent', () => {
    const input = big()
    input.statements.push(b1Approval(intentOf(input)))
    const d = decide(input)
    expect(fails(d)).toEqual([])
  })
  it('refuses an approval bound to a different intent (other amount)', () => {
    const input = big()
    const other = b1({ proposedTx: b1Payment(W.vendorA.address, '1400', { invoice: 'inv:2026-Q4-0042' }) })
    input.statements.push(b1Approval(intentOf(other)))
    expect(fails(decide(input))).toEqual(['W5'])
  })
  it('refuses an approval past its notAfter', () => {
    const input = big()
    input.statements.push(b1Approval(intentOf(input), W.controller, '2026-11-18T09:32:00Z'))
    expect(fails(decide(input))).toEqual(['W5'])
  })
  it('rejects an approval from an account not named in the deal terms', () => {
    const input = big()
    input.statements.push(b1Approval(intentOf(input), W.stranger))
    const d = decide(input)
    expect(fails(d)).toEqual(['W5'])
    expect(d.statementsRejected.map((r) => r.code)).toEqual(['ATTESTER_NOT_IN_TERMS'])
  })
  it('rejects an approval already consumed by an earlier payment (single-use)', () => {
    const input = big()
    const appr = b1Approval(intentOf(input))
    input.statements.push(appr)
    input.engagement = b1Engagement({ consumed: [appr.id] })
    const d = decide(input)
    expect(fails(d)).toEqual(['W5'])
    expect(d.statementsRejected).toEqual([{ id: appr.id, type: 'approval.payment/1', code: 'CONSUMED' }])
  })
  it('rejects a stale approval (observed more than 1h before the ledger close)', () => {
    const input = big()
    input.statements.push(b1Approval(intentOf(input), W.controller, '2026-11-20T00:00:00Z', '2026-11-18T08:00:00Z'))
    const d = decide(input)
    expect(d.statementsRejected.map((r) => r.code)).toEqual(['STALE'])
    expect(fails(d)).toEqual(['W5'])
  })
})

describe('B1 spend — payees, invoices and mandate', () => {
  it('refuses a payee that is not a mandate vendor', () => {
    const d = decide(b1({ proposedTx: b1Payment(W.stranger.address, '800', { invoice: 'inv:2026-Q4-0042' }) }))
    expect(fails(d)).toEqual(['B6', 'W2', 'W6'])
  })
  it('refuses a mandate vendor whose KYB credential is missing', () => {
    const d = decide(b1({ ledger: b1Ledger({ kyb: [W.vendorB.address] }) }))
    expect(fails(d)).toEqual(['W2'])
  })
  it('refuses a KYB credential from an issuer the policy does not accept', () => {
    const fakeKyb = [{ issuer: W.fakeIssuer.address, subject: W.vendorA.address, type: 'KYB_VERIFIED', accepted: true, expiration: null }]
    const d = decide(b1({ ledger: b1Ledger({ kyb: [], extraCreds: fakeKyb }) }))
    expect(fails(d)).toEqual(['W2'])
  })
  it('refuses when the invoice amount does not match', () => {
    const d = decide(b1({ statements: [b1Invoice(W.vendorA, '799.99')] }))
    expect(fails(d)).toEqual(['W6'])
  })
  it('refuses when the invoice reference memo does not match', () => {
    const d = decide(b1({ proposedTx: b1Payment(W.vendorA.address, '800', { invoice: 'inv:OTHER' }) }))
    expect(fails(d)).toEqual(['W6'])
  })
  it('refuses an invoice signed by someone other than the payee', () => {
    const forged = b1Invoice(W.vendorB, '800.00') // vendor B invoicing for a payment to vendor A
    expect(fails(decide(b1({ statements: [forged] })))).toEqual(['W6'])
  })
  it('refuses when the mandate is signed by the agent instead of the owner', () => {
    const d = decide(b1({ mandate: b1Mandate({}, W.agent) }))
    expect(d.decision).toBe('REFUSE')
    expect(fails(d)).toContain('W0')
  })
  it('refuses after the mandate expires', () => {
    const d = decide(b1({ mandate: b1Mandate({ expires: '2026-11-18T09:00:00Z' }) }))
    expect(fails(d)).toEqual(['W0'])
  })
  it('refuses an IOU from the wrong issuer even if the currency code matches', () => {
    const d = decide(b1({ proposedTx: b1Payment(W.vendorA.address, '800', { invoice: 'inv:2026-Q4-0042', issuer: W.fakeIssuer.address }) }))
    expect(fails(d)).toEqual(['B10'])
  })
})

describe('B1 spend — x402 challenge binding (W7)', () => {
  const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase()

  it('is n/a when the agent declares no x402 challenge', () => {
    const d = decide(b1())
    expect(result(d, 'W7')!.result).toBe('n/a')
    expect(fails(d)).toEqual([])
  })

  it('passes when the payment matches the challenge (memo binding)', () => {
    const d = decide(b1({ statements: [b1Invoice(), b1Challenge()] }))
    expect(result(d, 'W7')!.result).toBe('pass')
    expect(fails(d)).toEqual([])
  })

  it('passes when the payment matches the challenge (InvoiceID binding, exact scheme)', () => {
    const tx = b1Payment(W.vendorA.address, '800', { invoice: 'inv:2026-Q4-0042' })
    tx.InvoiceID = sha256Hex('inv:2026-Q4-0042')
    const d = decide(b1({ proposedTx: tx, statements: [b1Invoice(), b1Challenge()] }))
    expect(result(d, 'W7')!.result).toBe('pass')
    expect(fails(d)).toEqual([])
  })

  it('fails when the challenge destination differs from the payee', () => {
    const d = decide(b1({ statements: [b1Invoice(), b1Challenge({ payTo: W.vendorB.address })] }))
    expect(fails(d)).toEqual(['W7'])
  })

  it('fails when the challenge amount differs from the payment', () => {
    const d = decide(b1({ statements: [b1Invoice(), b1Challenge({ amount: '799.00' })] }))
    expect(fails(d)).toEqual(['W7'])
  })

  it('fails when the payment’s invoice binding does not match the challenge', () => {
    const tx = b1Payment(W.vendorA.address, '800', { invoice: 'inv:OTHER' })
    // W6 would also fail on the invoice; isolate W7 by matching the vendor invoice to inv:OTHER.
    const d = decide(b1({ proposedTx: tx, statements: [b1Invoice(W.vendorA, '800.00', 'inv:OTHER'), b1Challenge()] }))
    expect(fails(d)).toContain('W7')
  })
})

describe('B1 spend — baseline safety (B1–B10)', () => {
  it('refuses a Batch that smuggles a SetRegularKey', () => {
    const pay = b1Payment(W.vendorA.address, '800', { invoice: 'inv:2026-Q4-0042' })
    const inner = (t: Record<string, unknown>) => ({ RawTransaction: { ...t, Fee: '0', SigningPubKey: '', Flags: 0x40000000 } })
    const tx = {
      TransactionType: 'Batch', Account: W.engB1.address, Flags: 0x00010000, Fee: '60', Sequence: 21, LastLedgerSequence: LEDGER_INDEX + 20, SigningPubKey: '',
      RawTransactions: [inner({ ...pay, Sequence: 22, Memos: undefined, LastLedgerSequence: undefined }), inner({ TransactionType: 'SetRegularKey', Account: W.engB1.address, RegularKey: W.agent.address, Sequence: 23 })],
      Memos: [memo('eng/basis', 'spend'), memo('eng/invoice', 'inv:2026-Q4-0042')],
    }
    const d = decide(b1({ proposedTx: tx }))
    expect(fails(d)).toContain('B2')
    expect(d.decision).toBe('REFUSE')
  })
  it('refuses a fee above the cap', () => {
    expect(fails(decide(b1({ proposedTx: b1Payment(W.vendorA.address, '800', { invoice: 'inv:2026-Q4-0042', fee: '50000' }) })))).toEqual(['B3'])
  })
  it('refuses a live-stage transaction without LastLedgerSequence', () => {
    expect(fails(decide(b1({ proposedTx: b1Payment(W.vendorA.address, '800', { invoice: 'inv:2026-Q4-0042', lls: null }) })))).toEqual(['B4'])
  })
  it('refuses a LastLedgerSequence beyond the window', () => {
    expect(fails(decide(b1({ proposedTx: b1Payment(W.vendorA.address, '800', { invoice: 'inv:2026-Q4-0042', lls: LEDGER_INDEX + 500 }) })))).toEqual(['B4'])
  })
  it('refuses a transaction from a different account', () => {
    const tx = { ...b1Payment(W.vendorA.address, '800', { invoice: 'inv:2026-Q4-0042' }), Account: W.treasury.address }
    expect(fails(decide(b1({ proposedTx: tx })))).toContain('B1')
  })
  it('refuses a transaction without a basis memo', () => {
    expect(fails(decide(b1({ proposedTx: b1Payment(W.vendorA.address, '800', { invoice: 'inv:2026-Q4-0042', noBasis: true }) })))).toEqual(['B8'])
  })
  it('refuses an unknown stage', () => {
    const d = decide(b1({ stage: 'bogus' }))
    expect(d.decision).toBe('REFUSE')
    expect(fails(d)).toContain('NO_RULES_FOR_STAGE')
  })
  it('fails closed when the cost budget is exceeded', () => {
    const d = decide(b1({ costBudget: 50 }))
    expect(d.decision).toBe('REFUSE')
    expect(d.results.some((r) => r.reason === 'COST_EXCEEDED')).toBe(true)
  })
  it('rejects layers that redefine an asset', () => {
    const evil: PolicyDoc = { ...policies.procurement, policyId: 'pol_evil', layer: 'engagement', assets: { RLUSD: { ...policies.procurement.assets!.RLUSD, issuer: W.fakeIssuer.address } } }
    expect(() => decide(b1({ layers: [policies.baseline, policies.procurement, evil] }))).toThrow(/redefined/)
  })
})

// ── Hotel (escrow) ───────────────────────────────────────────────────────────
function hotel(over: Partial<DecideInput> = {}): DecideInput {
  const rv = review()
  const eng = hotelEngagement()
  return {
    stage: 'settle',
    proposedTx: closeBatch([{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }], { memos: [memo('eng/basis', 'settle.agreed'), memo('eng/review', rv.id)] }),
    engagement: eng,
    template: templates.hotel,
    layers: [policies.baseline, policies.hotel],
    mandate: hotelMandate(),
    statements: [rv],
    ledger: hotelLedger(),
    inflight: [],
    ...over,
  }
}

describe('Hotel — settle (agreed)', () => {
  it('signs a correct split with the 50 bps fee and a review', () => {
    const d = decide(hotel())
    expect(fails(d)).toEqual([])
  })
  it('refuses without a review (S5)', () => {
    const input = hotel({ statements: [] })
    expect(fails(decide(input))).toEqual(['S5'])
  })
  it('refuses a review signed by the merchant instead of the guest', () => {
    const rv = review(W.atlas)
    const input = hotel({ statements: [rv], proposedTx: closeBatch([{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }], { memos: [memo('eng/basis', 'settle.agreed'), memo('eng/review', rv.id)] }) })
    expect(fails(decide(input))).toEqual(['S5'])
  })
  it('refuses while a dispute credential exists (S1)', () => {
    expect(fails(decide(hotel({ ledger: hotelLedger({ dispute: true }) })))).toEqual(['S1'])
  })
  it('refuses a wrong service fee (S4)', () => {
    const rv = review()
    const tx = closeBatch([{ to: W.atlas.address, value: '410' }, { to: W.service.address, value: '2' }], { memos: [memo('eng/basis', 'settle.agreed'), memo('eng/review', rv.id)] })
    expect(fails(decide(hotel({ proposedTx: tx, statements: [rv] })))).toEqual(['S4'])
  })
  it('refuses a close that leaves funds behind (B7)', () => {
    const rv = review()
    const tx = closeBatch([{ to: W.atlas.address, value: '400' }, { to: W.service.address, value: '2.01' }], { memos: [memo('eng/basis', 'settle.agreed'), memo('eng/review', rv.id)] })
    const d = decide(hotel({ proposedTx: tx, statements: [rv] }))
    expect(fails(d)).toContain('B7')
  })
  it('accepts a residual sweep (partial payment) that drains the account', () => {
    const rv = review()
    const tx = closeBatch([{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }, { to: W.dana.address, value: '0', partial: true }], { memos: [memo('eng/basis', 'settle.agreed'), memo('eng/review', rv.id)] })
    // balance grew by a stray 5 RLUSD; the sweep returns it to the guest
    const d = decide(hotel({ proposedTx: tx, statements: [rv], ledger: hotelLedger({ balance: '417' }) }))
    expect(fails(d)).toEqual([])
  })
  it('refuses an AccountDelete to anyone but the agreed destination (B7)', () => {
    const rv = review()
    const tx = closeBatch([{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }], { deleteTo: W.atlas.address, memos: [memo('eng/basis', 'settle.agreed'), memo('eng/review', rv.id)] })
    expect(fails(decide(hotel({ proposedTx: tx, statements: [rv] })))).toEqual(['B7'])
  })
  it('refuses a non-atomic Batch mode (B5)', () => {
    const rv = review()
    const tx = closeBatch([{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }], { flags: 0x00040000, memos: [memo('eng/basis', 'settle.agreed'), memo('eng/review', rv.id)] })
    expect(fails(decide(hotel({ proposedTx: tx, statements: [rv] })))).toEqual(['B5'])
  })
  it('makes rules that depend on a failing definition error, and leaves the rest evaluated', () => {
    const input = hotel({ engagement: hotelEngagement({ fee: undefined }) })
    const d = decide(input)
    expect(result(d, 'S4')!.result).toBe('error')
    expect(result(d, 'S4')!.error).toMatch(/definition toFee failed/)
    expect(result(d, 'S1')!.result).toBe('pass')
    expect(d.decision).toBe('REFUSE')
  })
})

describe('Hotel — confirm stage (no transaction)', () => {
  const mandate = hotelMandate()
  const input = (city: string): DecideInput => hotel({ stage: 'confirm', proposedTx: null, mandate, engagement: hotelEngagement({ state: 'OPEN', mandateId: mandate.id }), statements: [confirmation(city, mandate.id)], ledger: hotelLedger({ closeTime: '2026-10-20T09:40:00Z' }) })
  it('accepts a confirmation that matches the mandate', () => {
    const d = decide(input('Lisbon'))
    expect(fails(d)).toEqual([])
    expect(d.results.filter((r) => r.id.startsWith('B')).every((r) => r.result === 'n/a')).toBe(true)
  })
  it('refuses a confirmation for the wrong city', () => {
    expect(fails(decide(input('Porto')))).toEqual(['C2'])
  })
})

describe('Hotel — pre-signed defaults (final signature)', () => {
  const refund = () => closeBatch([{ to: W.dana.address, value: '412' }], { tickets: true, memos: [memo('eng/basis', 'default.refund')] })
  const release = () => closeBatch([{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }], { tickets: true, memos: [memo('eng/basis', 'default.release')] })

  it('refund: refuses before confirmBy', () => {
    const d = decide(hotel({ stage: 'default.refund', proposedTx: refund(), engagement: hotelEngagement({ state: 'OPEN' }), statements: [], ledger: hotelLedger({ closeTime: '2026-10-20T10:00:00Z' }) }))
    expect(fails(d)).toEqual(['R1'])
  })
  it('refund: signs after confirmBy (ticket-based, no LastLedgerSequence)', () => {
    const d = decide(hotel({ stage: 'default.refund', proposedTx: refund(), engagement: hotelEngagement({ state: 'OPEN' }), statements: [], ledger: hotelLedger({ closeTime: '2026-10-20T11:00:01Z' }) }))
    expect(fails(d)).toEqual([])
    expect(result(d, 'B11')!.result).toBe('pass')
  })
  it('release: signs after the dispute window', () => {
    const d = decide(hotel({ stage: 'default.release', proposedTx: release(), statements: [] }))
    expect(fails(d)).toEqual([])
  })
  it('release: refuses while a dispute is open', () => {
    const d = decide(hotel({ stage: 'default.release', proposedTx: release(), statements: [], ledger: hotelLedger({ dispute: true }) }))
    expect(fails(d)).toEqual(['L2'])
  })
  it('release: refuses when the balance changed (exact-balance lock)', () => {
    const d = decide(hotel({ stage: 'default.release', proposedTx: release(), statements: [], ledger: hotelLedger({ balance: '422' }) }))
    expect(fails(d)).toEqual(['B7', 'B11', 'L3'])
  })
  it('release: refuses when an extra ledger object would block AccountDelete (B11, single-shot)', () => {
    const ledger = hotelLedger()
    ledger.accounts[W.engHotel.address].ownerObjects!.other = 1
    const d = decide(hotel({ stage: 'default.release', proposedTx: release(), statements: [], ledger }))
    expect(fails(d)).toEqual(['B11'])
  })
})

describe('Task 1 prerequisites', () => {
  const release = () => closeBatch([{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }], { tickets: true, memos: [memo('eng/basis', 'default.release')] })
  const releaseInput = (ledger = hotelLedger()) => hotel({ stage: 'default.release', proposedTx: release(), statements: [], ledger })
  it('B11: a closing pre-signed default is refused while the account is younger than 256 ledgers', () => {
    const young = hotelLedger(); young.accounts[W.engHotel.address].sequence = LEDGER_INDEX - 100
    expect(fails(decide(releaseInput(young)))).toContain('B11')
    const old = hotelLedger(); old.accounts[W.engHotel.address].sequence = LEDGER_INDEX - 300
    expect(fails(decide(releaseInput(old)))).not.toContain('B11')
  })
  it('registry knows the hotel@2 attestation types', () => {
    for (const t of ['party.checkin/1', 'party.concession/1', 'party.issue/1', 'party.claim/1']) expect(REGISTRY[t]).toBeDefined()
    expect(REGISTRY_VERSION).toBe('att-registry@2026.11')
  })
})

describe('lint', () => {
  it('passes the shipped policies', () => {
    expect(lintPolicy(policies.baseline)).toEqual([])
    expect(lintPolicy(policies.procurement, templates.procurement)).toEqual([])
    expect(lintPolicy(policies.hotel, templates.hotel)).toEqual([])
  })
  it('flags floats, unknown statement types, duplicate ids and missing stages', () => {
    const bad: PolicyDoc = structuredClone(policies.procurement)
    bad.stages.spend.rules.push({ id: 'X1', reason: 'R', check: 'minor(def.spendNow) < 1.5' })
    bad.stages.spend.rules.push({ id: 'X1', reason: 'R', check: "att.list('nope/1', 'vendor').size() == 0" })
    delete (bad.stages as Record<string, unknown>)['close.owner']
    const ids = lintPolicy(bad, templates.procurement).map((f) => f.id)
    expect(ids).toContain('L1')
    expect(ids).toContain('L3')
    expect(ids).toContain('L7')
    expect(ids).toContain('L2')
  })
})

// keep NOW referenced for readers: fixtures pin the ledger close to NOW
void NOW
