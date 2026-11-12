// Deterministic fixtures for policy tests and conformance vectors.
// Keys come from fixed entropy: TEST-ONLY, never fund these on any network.
import fs from 'node:fs'
import xrpl from 'xrpl'
import { createHash } from 'node:crypto'
import { signStatement, type Statement, type StatementBody, type Template } from '@eng/core'
import type { DecideInput, EngagementRecord, InflightEntry, LedgerSnapshot, PolicyDoc } from '@eng/policy'

const root = new URL('../../../', import.meta.url)
const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(new URL(p, root), 'utf8')) as T

export function wallet(name: string, algorithm: 'ed25519' | 'ecdsa-secp256k1' = 'ed25519'): InstanceType<typeof xrpl.Wallet> {
  const entropy = createHash('sha256').update(`engagement-accounts-fixture:${name}`).digest().subarray(0, 16)
  return xrpl.Wallet.fromEntropy(entropy, { algorithm: algorithm as never })
}

export const W = {
  issuer: wallet('issuer'),
  fakeIssuer: wallet('fake-issuer'),
  service: wallet('service'),
  cosigner: wallet('cosigner'),
  kybIssuer: wallet('kyb-issuer'),
  // B1
  treasury: wallet('treasury'),
  agent: wallet('agent'),
  controller: wallet('controller'),
  vendorA: wallet('vendor-a'),
  vendorB: wallet('vendor-b'),
  stranger: wallet('stranger'),
  engB1: wallet('eng-b1'),
  // R2 consumer shopping
  classifier: wallet('classifier'),
  engR2: wallet('eng-r2'),
  // hotel
  dana: wallet('dana'),
  atlas: wallet('atlas'),
  arbiter: wallet('arbiter'),
  engHotel: wallet('eng-hotel'),
  // hotel@2
  backupArbiter: wallet('backup-arbiter'),
  engHotel2: wallet('eng-hotel2'),
}

export const RLUSD_HEX = '524C555344000000000000000000000000000000'
export const NOW = '2026-11-18T09:33:10Z'
export const LEDGER_INDEX = 98811234

export function withIssuer(p: PolicyDoc, issuer = W.issuer.address): PolicyDoc {
  const c = structuredClone(p)
  for (const a of Object.values(c.assets ?? {})) if (a.kind === 'IOU') a.issuer = issuer
  if (c.params && 'kybIssuers' in c.params) c.params.kybIssuers = [W.kybIssuer.address]
  return c
}

export const templates = {
  procurement: readJson<Template>('templates/procurement@1.json'),
  hotel: readJson<Template>('templates/hotel@1.json'),
  hotel2: readJson<Template>('templates/hotel@2.json'),
  shopping: readJson<Template>('templates/shopping@1.json'),
}
export const policies = {
  baseline: readJson<PolicyDoc>('policies/baseline@1.1.0.json'),
  procurement: withIssuer(readJson<PolicyDoc>('policies/procurement@1.3.0.json')),
  hotel: withIssuer(readJson<PolicyDoc>('policies/hotel@1.1.0.json')),
  hotel2: withIssuer(readJson<PolicyDoc>('policies/hotel@2.0.0.json')),
  shopping: withIssuer(readJson<PolicyDoc>('policies/shopping@1.0.0.json')),
}

let nonceCounter = 0
const nonce = () => (++nonceCounter).toString(16).padStart(32, '0')

export function statement(signer: InstanceType<typeof xrpl.Wallet>, body: Omit<StatementBody, 'v' | 'nonce' | 'attester' | 'observedAt' | 'issuedAt'> & { kind: string; observedAt?: string; issuedAt?: string }): Statement {
  const { kind, ...rest } = body
  return signStatement(
    { v: 'eng.att/1', observedAt: body.observedAt ?? '2026-11-18T09:00:00Z', issuedAt: body.issuedAt ?? '2026-11-18T09:00:01Z', nonce: nonce(), attester: { account: signer.address, kind }, ...rest } as StatementBody,
    signer,
  )
}

export const iou = (value: string, issuer = W.issuer.address) => ({ currency: RLUSD_HEX, issuer, value })
export const memo = (type: string, data: string) => ({ Memo: { MemoType: Buffer.from(type).toString('hex').toUpperCase(), MemoData: Buffer.from(data).toString('hex').toUpperCase() } })
const INNER = 0x40000000
const AON = 0x00010000

// ── B1: owner-wallet procurement ─────────────────────────────────────────────
export function b1Engagement(over: Partial<EngagementRecord> = {}): EngagementRecord {
  return {
    engagementId: 'eng_b1_fixture',
    template: 'owner-wallet/procurement@1',
    account: W.engB1.address,
    asset: 'RLUSD',
    parties: { owner: W.treasury.address, agent: W.agent.address, cosigner: W.cosigner.address },
    attesters: { approver: { accounts: [W.controller.address] }, vendor: { accounts: [W.vendorA.address, W.vendorB.address] } },
    state: 'OPEN',
    consumed: [],
    ...over,
  }
}

export function b1Mandate(over: Record<string, unknown> = {}, signer = W.treasury): Statement {
  return statement(signer, {
    kind: 'PRINCIPAL', type: 'party.mandate/1', engagementId: 'eng_b1_fixture', subject: { mandateId: 'mnd_q4_cloud' },
    claim: { purpose: 'Q4 cloud & data spend', budget: '50000.00', dailyCap: '10000.00', vendors: [W.vendorA.address, W.vendorB.address], expires: '2026-12-31T23:59:59Z', ...over },
  })
}

export function b1Ledger(over: { history?: LedgerSnapshot['history'][string]; balance?: string; kyb?: string[]; extraCreds?: LedgerSnapshot['credentials'] } = {}): LedgerSnapshot {
  const kyb = over.kyb ?? [W.vendorA.address, W.vendorB.address]
  return {
    index: LEDGER_INDEX,
    hash: 'A'.repeat(64),
    closeTime: NOW,
    baseFeeDrops: '10',
    reserveIncDrops: '200000',
    accounts: { [W.engB1.address]: { exists: true, masterDisabled: true, regularKey: null, ownerObjects: { trustlines: 1, signerList: true, tickets: [], other: 0 } } },
    balances: { [W.engB1.address]: { RLUSD: over.balance ?? '50000' } },
    credentials: [
      ...kyb.map((s) => ({ issuer: W.kybIssuer.address, subject: s, type: 'KYB_VERIFIED', accepted: true, expiration: null })),
      ...(over.extraCreds ?? []),
    ],
    history: { [W.engB1.address]: over.history ?? [] },
  }
}

export function b1Payment(to: string, value: string, opts: { invoice?: string; fee?: string; lls?: number | null; issuer?: string; noBasis?: boolean } = {}): Record<string, unknown> {
  const tx: Record<string, unknown> = {
    TransactionType: 'Payment', Account: W.engB1.address, Destination: to, Amount: iou(value, opts.issuer),
    Fee: opts.fee ?? '15', Sequence: 21, Flags: 0, SigningPubKey: '',
    Memos: [...(opts.noBasis ? [] : [memo('eng/basis', 'spend')]), ...(opts.invoice ? [memo('eng/invoice', opts.invoice)] : [])],
  }
  if (opts.lls !== null) tx.LastLedgerSequence = opts.lls ?? LEDGER_INDEX + 20
  return tx
}

export function b1Invoice(vendor = W.vendorA, amount = '800.00', invoiceRef = 'inv:2026-Q4-0042'): Statement {
  return statement(vendor, { kind: 'VENDOR', type: 'party.invoice/1', engagementId: 'eng_b1_fixture', subject: { invoiceRef }, claim: { invoiceRef, amount, currency: 'RLUSD', po: 'PO-7731' } })
}

export function b1Approval(intentHash: string, signer = W.controller, notAfter = '2026-11-20T00:00:00Z', at = '2026-11-18T09:31:00Z'): Statement {
  return statement(signer, {
    kind: 'APPROVER', type: 'approval.payment/1', engagementId: 'eng_b1_fixture', subject: { intentHash },
    claim: { approverRole: 'controller', notAfter, comment: 'fixture approval' }, observedAt: at, issuedAt: at,
  })
}

/** The agent's self-attested payment challenge (W7): what it is paying, and for which resource. */
export function b1Challenge(over: Record<string, unknown> = {}, signer = W.agent): Statement {
  const invoiceId = (over.invoiceId as string) ?? 'inv:2026-Q4-0042'
  return statement(signer, {
    kind: 'AGENT', type: 'payment.challenge/1', engagementId: 'eng_b1_fixture', subject: { invoiceId },
    claim: { scheme: 'x402', payTo: W.vendorA.address, amount: '800.00', asset: 'RLUSD', invoiceId, resource: 'https://vendor.example/data', ...over },
  })
}

export function inflight(value: string, id = 'att:INFLIGHT1'): InflightEntry {
  return { decisionId: id, lastLedgerSequence: LEDGER_INDEX + 10, payouts: [{ to: W.vendorA.address, asset: 'RLUSD', value }] }
}

export function historyEntry(value: string, closeTime: string, to = W.vendorA.address) {
  return { hash: createHash('sha256').update(value + closeTime).digest('hex').toUpperCase(), ledgerIndex: LEDGER_INDEX - 100, closeTime, payouts: [{ to, asset: 'RLUSD', value }] }
}

// ── Hotel: escrow ────────────────────────────────────────────────────────────
export function hotelEngagement(over: Partial<EngagementRecord> = {}): EngagementRecord {
  return {
    engagementId: 'eng_hotel_fixture',
    template: 'settlement-vault/hotel@1',
    account: W.engHotel.address,
    asset: 'RLUSD',
    parties: { principal: W.dana.address, counterparty: W.atlas.address, arbiter: W.arbiter.address, cosigner: W.cosigner.address },
    fee: { bps: 50, to: W.service.address },
    deleteTo: W.service.address,
    amount: { asset: 'RLUSD', value: '412.00' },
    timers: { openedAt: '2026-10-20T09:00:00Z', confirmBy: '2026-10-20T11:00:00Z', deliveryBy: '2026-11-14T11:00:00Z', disputeWindowEnds: '2026-11-17T11:00:00Z' },
    state: 'AWAITING_SETTLEMENT',
    consumed: [],
    mandateId: 'att:MANDATE',
    ...over,
  }
}

export function hotelLedger(over: { balance?: string; dispute?: boolean; closeTime?: string } = {}): LedgerSnapshot {
  return {
    index: LEDGER_INDEX,
    hash: 'B'.repeat(64),
    closeTime: over.closeTime ?? NOW,
    baseFeeDrops: '10',
    reserveIncDrops: '200000',
    accounts: { [W.engHotel.address]: { exists: true, masterDisabled: true, regularKey: null, ownerObjects: { trustlines: 1, signerList: true, tickets: [101, 102, 103, 104, 105, 106, 107, 108, 109], other: 0 } } },
    balances: { [W.engHotel.address]: { RLUSD: over.balance ?? '412' } },
    credentials: over.dispute ? [{ issuer: W.dana.address, subject: W.engHotel.address, type: 'ENG/DISPUTE', accepted: false, expiration: null }] : [],
    history: {},
  }
}

export function closeBatch(payouts: Array<{ to: string; value: string; partial?: boolean }>, opts: { account?: string; deleteTo?: string; tickets?: boolean; memos?: Array<ReturnType<typeof memo>>; fee?: string; flags?: number; lls?: number } = {}): Record<string, unknown> {
  const eng = opts.account ?? W.engHotel.address
  const steps: Record<string, unknown>[] = [
    ...payouts.map((p) => ({ TransactionType: 'Payment', Account: eng, Destination: p.to, Amount: iou(p.partial ? '1000000000' : p.value), Flags: INNER | (p.partial ? 0x00020000 : 0) })),
    { TransactionType: 'TrustSet', Account: eng, LimitAmount: iou('0'), Flags: INNER | 0x00020000 },
    { TransactionType: 'AccountDelete', Account: eng, Destination: opts.deleteTo ?? W.service.address, Flags: INNER },
  ]
  const raw = steps.map((s, i) => ({ RawTransaction: { ...s, Fee: '0', SigningPubKey: '', ...(opts.tickets ? { Sequence: 0, TicketSequence: 102 + i } : { Sequence: 31 + i }) } }))
  return {
    TransactionType: 'Batch', Account: eng, Flags: opts.flags ?? AON, Fee: opts.fee ?? '200120', SigningPubKey: '',
    ...(opts.tickets ? { Sequence: 0, TicketSequence: 101 } : { Sequence: 30, LastLedgerSequence: opts.lls ?? LEDGER_INDEX + 20 }),
    RawTransactions: raw,
    Memos: opts.memos ?? [memo('eng/basis', 'settle.agreed')],
  }
}

export function review(signer = W.dana, engagementId = 'eng_hotel_fixture'): Statement {
  return statement(signer, { kind: 'PRINCIPAL', type: 'party.review/1', engagementId, subject: { bookingId: 'ATL-55821' }, claim: { stayed: true, rating: 5, text: 'Lovely stay' } })
}

export function hotelMandate(): Statement {
  return statement(W.dana, {
    kind: 'PRINCIPAL', type: 'party.mandate/1', engagementId: 'eng_hotel_fixture', subject: { mandateId: 'mnd_8K2' },
    claim: { purpose: 'lodging', constraints: { city: 'Lisbon', country: 'PT', checkIn: '2026-11-11', checkOut: '2026-11-14', maxTotal: { currency: 'RLUSD', value: '450.00' } }, expires: '2026-10-21T00:00:00Z' },
    observedAt: '2026-10-20T08:55:00Z', issuedAt: '2026-10-20T08:55:01Z',
  })
}

export function confirmation(city: string, mandateId: string): Statement {
  return statement(W.atlas, {
    kind: 'COUNTERPARTY', type: 'party.confirmation/1', engagementId: 'eng_hotel_fixture', subject: { bookingId: 'ATL-55821' },
    claim: { mandateHash: mandateId, bookingId: 'ATL-55821', property: 'Casa Alfama', city, country: 'PT', checkIn: '2026-11-11', checkOut: '2026-11-14', total: { currency: 'RLUSD', value: '412.00' } },
    observedAt: '2026-10-20T09:30:00Z', issuedAt: '2026-10-20T09:30:01Z',
  })
}

// ── Hotel@2: stay escrow (deposit, entry disputes, claims, backup arbiter) ────
const ENG2 = 'eng_hotel2_fixture'
type Wallet = InstanceType<typeof xrpl.Wallet>
const rlusd = (value: string) => ({ currency: 'RLUSD', value })
const at = (t: string) => ({ observedAt: t, issuedAt: t })

export function hotel2Engagement(over: Partial<EngagementRecord> = {}): EngagementRecord {
  return {
    engagementId: ENG2,
    template: 'settlement-vault/hotel@2',
    account: W.engHotel2.address,
    asset: 'RLUSD',
    parties: { principal: W.dana.address, counterparty: W.atlas.address, arbiter: W.arbiter.address, backupArbiter: W.backupArbiter.address, cosigner: W.cosigner.address },
    fee: { bps: 50, to: W.service.address },
    deleteTo: W.service.address,
    amount: { asset: 'RLUSD', value: '412.00' },
    timers: {
      openedAt: '2026-11-01T09:00:00Z', confirmBy: '2026-11-01T11:00:00Z',
      checkIn: '2026-11-11T14:00:00Z', checkInBy: '2026-11-11T23:00:00Z', entryDisputeBy: '2026-11-12T11:00:00Z',
      deliveryBy: '2026-11-14T11:00:00Z', claimBy: '2026-11-15T11:00:00Z', disputeWindowEnds: '2026-11-17T11:00:00Z',
    },
    state: 'OPEN',
    consumed: [],
    mandateId: hotel2Mandate().id,
    ...over,
  }
}

export function hotel2Ledger(over: { balance?: string; dispute?: boolean; closeTime?: string; sequence?: number } = {}): LedgerSnapshot {
  return {
    index: LEDGER_INDEX,
    hash: 'C'.repeat(64),
    closeTime: over.closeTime ?? NOW,
    baseFeeDrops: '10',
    reserveIncDrops: '200000',
    accounts: {
      [W.engHotel2.address]: {
        exists: true, masterDisabled: true, regularKey: null,
        ...(over.sequence != null ? { sequence: over.sequence } : {}),
        ownerObjects: { trustlines: 1, signerList: true, tickets: Array.from({ length: 15 }, (_, i) => 101 + i), other: 0 },
      },
    },
    balances: { [W.engHotel2.address]: { RLUSD: over.balance ?? '412' } },
    credentials: over.dispute ? [{ issuer: W.dana.address, subject: W.engHotel2.address, type: 'ENG/DISPUTE', accepted: false, expiration: null }] : [],
    history: {},
  }
}

let hotel2MandateCache: Statement | undefined
/** The guest's mandate. Built once so its id (bound into the engagement and the confirmation) is stable. */
export function hotel2Mandate(): Statement {
  hotel2MandateCache ??= statement(W.dana, {
    kind: 'PRINCIPAL', type: 'party.mandate/1', engagementId: ENG2, subject: { mandateId: 'mnd_9H4' },
    claim: { purpose: 'lodging', constraints: { city: 'Lisbon', country: 'PT', checkIn: '2026-11-11', checkOut: '2026-11-14', maxTotal: rlusd('450.00'), maxDeposit: rlusd('200.00') }, expires: '2026-11-02T00:00:00Z' },
    ...at('2026-11-01T08:55:00Z'),
  })
  return hotel2MandateCache
}

export function hotel2Confirmation(over: { deposit?: string; city?: string } = {}): Statement {
  return statement(W.atlas, {
    kind: 'COUNTERPARTY', type: 'party.confirmation/1', engagementId: ENG2, subject: { bookingId: 'ATL-60417' },
    claim: { mandateHash: hotel2Mandate().id, bookingId: 'ATL-60417', property: 'Casa Alfama', city: over.city ?? 'Lisbon', country: 'PT', checkIn: '2026-11-11', checkOut: '2026-11-14', total: rlusd('412.00'), deposit: rlusd(over.deposit ?? '150.00') },
    ...at('2026-11-01T09:30:00Z'),
  })
}

export function checkin(status: 'checked_in' | 'refused'): Statement {
  return statement(W.atlas, {
    kind: 'COUNTERPARTY', type: 'party.checkin/1', engagementId: ENG2, subject: { bookingId: 'ATL-60417' },
    claim: { status, room: '204', deposit: rlusd('150.00') },
    ...at('2026-11-11T15:00:00Z'),
  })
}

/** The hotel's deposit claim, posted before claimBy. Amounts become {currency, value}; `total` is the exact sum of the items. */
export function claim(items: Array<{ kind: string; amount: string }>): Statement {
  const cents = (v: string) => { const [w, f = ''] = v.split('.'); return BigInt(w) * 100n + BigInt((f + '00').slice(0, 2)) }
  const minor = items.reduce((s, i) => s + cents(i.amount), 0n)
  const total = `${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')}`
  return statement(W.atlas, {
    kind: 'COUNTERPARTY', type: 'party.claim/1', engagementId: ENG2, subject: { bookingId: 'ATL-60417' },
    claim: { items: items.map((i) => ({ kind: i.kind, amount: rlusd(i.amount), evidenceHashes: [] })), total: rlusd(total) },
    ...at('2026-11-14T15:00:00Z'),
  })
}

/**
 * The guest's dispute attestation. Pair with `hotel2Ledger({ dispute: true })` for the Credential and a balance
 * that includes the 10.00 bond. `issuedAt` overrides the default posting time (e.g. to model backdating).
 */
export function dispute(phase: 'entry' | 'settlement', issuedAt?: string): Statement {
  return statement(W.dana, {
    kind: 'PRINCIPAL', type: 'party.dispute/1', engagementId: ENG2, subject: { bookingId: 'ATL-60417' },
    claim: { phase, reason: phase === 'entry' ? 'room not as booked' : 'claim disputed', bond: rlusd('10.00'), evidenceHashes: [] },
    ...at(issuedAt ?? (phase === 'entry' ? '2026-11-11T20:00:00Z' : '2026-11-16T10:00:00Z')),
  })
}

export function concession(disputeId: string): Statement {
  return statement(W.atlas, {
    kind: 'COUNTERPARTY', type: 'party.concession/1', engagementId: ENG2, subject: { bookingId: 'ATL-60417' },
    claim: { disputeRef: disputeId },
    ...at('2026-11-12T09:00:00Z'),
  })
}

export function ruling(signer: Wallet, payouts: Array<{ to: string; value: string }>, issuedAt = '2026-11-20T09:00:00Z'): Statement {
  return statement(signer, {
    kind: 'ARBITER', type: 'party.ruling/1', engagementId: ENG2, subject: { bookingId: 'ATL-60417' },
    claim: { payouts, rationale: 'fixture ruling' },
    ...at(issuedAt),
  })
}

export function hotel2Close(payouts: Array<{ to: string; value: string; partial?: boolean }>, opts: Omit<Parameters<typeof closeBatch>[1], 'account'> = {}): Record<string, unknown> {
  return closeBatch(payouts, { ...opts, account: W.engHotel2.address })
}

export function hotel2Input(over: Partial<DecideInput> = {}): DecideInput {
  return {
    stage: 'confirm',
    proposedTx: null,
    engagement: hotel2Engagement(),
    template: templates.hotel2,
    layers: [policies.baseline, policies.hotel2],
    mandate: hotel2Mandate(),
    statements: [],
    ledger: hotel2Ledger(),
    inflight: [],
    ...over,
  }
}

// ── R2: owner-wallet consumer shopping ─────────────────────────────
export function r2Engagement(over: Partial<EngagementRecord> = {}): EngagementRecord {
  return {
    engagementId: 'eng_r2_fixture',
    template: 'owner-wallet/shopping@1',
    account: W.engR2.address,
    asset: 'RLUSD',
    parties: { owner: W.treasury.address, agent: W.agent.address, cosigner: W.cosigner.address },
    attesters: { classifier: { accounts: [W.classifier.address] } },
    state: 'OPEN',
    consumed: [],
    ...over,
  }
}

export function r2Mandate(over: Record<string, unknown> = {}, signer = W.treasury): Statement {
  return statement(signer, {
    kind: 'PRINCIPAL', type: 'party.mandate/1', engagementId: 'eng_r2_fixture', subject: { mandateId: 'mnd_shopping' },
    claim: { purpose: 'weekly household shopping', weeklyCap: '2000.00', budget: '20000.00', vendors: [W.vendorA.address, W.vendorB.address], categories: ['retail.grocery', 'retail.books'], expires: '2026-12-31T23:59:59Z', ...over },
  })
}

export function r2Ledger(over: { history?: LedgerSnapshot['history'][string]; balance?: string } = {}): LedgerSnapshot {
  return {
    index: LEDGER_INDEX, hash: 'A'.repeat(64), closeTime: NOW, baseFeeDrops: '10', reserveIncDrops: '200000',
    accounts: { [W.engR2.address]: { exists: true, masterDisabled: true, regularKey: null, ownerObjects: { trustlines: 1, signerList: true, tickets: [], other: 0 } } },
    balances: { [W.engR2.address]: { RLUSD: over.balance ?? '20000' } },
    credentials: [],
    history: { [W.engR2.address]: over.history ?? [] },
  }
}

/** A classifier's merchant.category/1 statement (global classification; subject = the merchant). */
export function r2Category(merchant: string, category = 'retail.grocery', signer = W.classifier): Statement {
  return statement(signer, { kind: 'CLASSIFIER', type: 'merchant.category/1', engagementId: 'eng_r2_fixture', subject: { account: merchant }, claim: { category } })
}

export function r2Payment(to: string, value: string, opts: { invoice?: string; fee?: string; lls?: number | null; issuer?: string } = {}): Record<string, unknown> {
  const tx: Record<string, unknown> = {
    TransactionType: 'Payment', Account: W.engR2.address, Destination: to, Amount: iou(value, opts.issuer),
    Fee: opts.fee ?? '15', Sequence: 21, Flags: 0, SigningPubKey: '',
    Memos: [memo('eng/basis', 'spend'), ...(opts.invoice ? [memo('eng/invoice', opts.invoice)] : [])],
  }
  if (opts.lls !== null) tx.LastLedgerSequence = opts.lls ?? LEDGER_INDEX + 20
  return tx
}

/** The agent's self-attested payment challenge (SH5), rail-neutral (x402 | mpp). */
export function r2Challenge(over: Record<string, unknown> = {}, signer = W.agent): Statement {
  const invoiceId = (over.invoiceId as string) ?? 'inv:shop-2026-11-0007'
  return statement(signer, {
    kind: 'AGENT', type: 'payment.challenge/1', engagementId: 'eng_r2_fixture', subject: { invoiceId },
    claim: { scheme: 'mpp', payTo: W.vendorA.address, amount: '800.00', asset: 'RLUSD', invoiceId, resource: 'https://merchant.example/cart/987', ...over },
  })
}
