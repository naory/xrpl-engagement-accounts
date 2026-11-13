// The web demo's simulated "Hotel stay" transcript (spec §7.2). Each of the eight HotelFlow paths runs in-process
// through a real CosignerService with the real pol_hotel@2.0.0, over a FixtureLedgerSource whose snapshot
// (closeTime, ledger index, balance, Tickets, Credentials, account existence) this generator advances step by step.
// Every decision, failing list and rule row in the transcript is the co-signer's; nothing is hand-written. The only
// thing simulated here is the ledger: a closing Batch applies when its multisig weight reaches the quorum (7).
//
// Step labels and order mirror packages/cosigner/src/hotel/flow.ts so the simulated and live transcripts look alike;
// a tick()'s results keep the co-signer's order, so a path's closing step is not necessarily its last.
//
// Clock: a three-night stay (checkIn 2026-11-11, checkOut 2026-11-14) on the stock policy's rulingWindow of 432000 s
// (5 days). Keys are deterministic and TEST ONLY; statement nonces are counters, so the output is reproducible.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import xrpl from 'xrpl'
import * as keypairs from 'ripple-keypairs'
import { encodeForMultisigning } from 'ripple-binary-codec'
import { Amount, formatAmount, localSigner, parseAmount, signStatement, type AssetDef, type Statement, type Template } from '@eng/core'
import { ruleExplanations, type EngagementRecord, type LedgerSnapshot, type PolicyDoc } from '@eng/policy'
import {
  CosignerService, DEMO_HOTEL_BOOKING, FixtureLedgerSource, HOTEL_PATHS,
  buildCloseBatch, combine, currencyHex, memo, multisignBlob, receiptOf,
  type DecideResponse, type HotelReceipt, type Fees, type HotelBooking, type HotelPath, type HotelStepResult, type TickResult,
} from '@eng/cosigner'

type Json = Record<string, unknown>
type Wallet = InstanceType<typeof xrpl.Wallet>
type Payout = { to: string; value: string }

/** A transcript step: a HotelFlow step plus the simulated ledger closeTime it happened at. */
export interface HotelSimStep extends HotelStepResult { at: string }

export interface HotelTranscript {
  generatedBy: string
  policy: string
  cast: { issuer: string; guest: string; hotel: string; arbiter: string; backupArbiter: string; service: string; cosigner: string }
  booking: HotelBooking
  timers: Record<string, string>
  /** Human-readable rule names and explanations from the policy layers (title, message), keyed by rule id. */
  explanations: Record<string, { title?: string; message?: string }>
  paths: Record<HotelPath, HotelSimStep[]>
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')) as T

/** Deterministic keys (same derivation as packages/policy/test/fixtures.ts, own namespace). TEST ONLY: never fund. */
function wallet(name: string): Wallet {
  const entropy = createHash('sha256').update(`engagement-accounts-hotel-sim:${name}`).digest().subarray(0, 16)
  return xrpl.Wallet.fromEntropy(entropy, { algorithm: 'ed25519' as never })
}

const W = {
  issuer: wallet('issuer'), guest: wallet('guest'), hotel: wallet('hotel'), arbiter: wallet('arbiter'),
  backupArbiter: wallet('backup-arbiter'), service: wallet('service'), cosigner: wallet('cosigner'),
}
const WEIGHTS: Record<string, number> = { [W.guest.address]: 3, [W.hotel.address]: 3, [W.arbiter.address]: 4, [W.backupArbiter.address]: 2, [W.cosigner.address]: 2 }
const QUORUM = 7

const TEMPLATE = 'settlement-vault/hotel@2'
const CURRENCY = currencyHex('RLUSD')
const ASSET: AssetDef = { code: 'RLUSD', kind: 'IOU', currency: CURRENCY, issuer: W.issuer.address, decimals: 6 }
const FEES: Fees = { base: 10, reserveBase: 1_000_000, inc: 200_000 }
const FEE_BPS = 50n
const BOOKING = DEMO_HOTEL_BOOKING
const RULING_WINDOW_SECS = 432000

const TIMERS = {
  openedAt: '2026-11-01T09:00:00Z', confirmBy: '2026-11-01T11:00:00Z',
  checkIn: '2026-11-11T14:00:00Z', checkInBy: '2026-11-11T23:00:00Z', entryDisputeBy: '2026-11-12T11:00:00Z',
  deliveryBy: '2026-11-14T11:00:00Z', claimBy: '2026-11-15T11:00:00Z', disputeWindowEnds: '2026-11-17T11:00:00Z',
}
const STAY = { checkIn: '2026-11-11', checkOut: '2026-11-14' }

/** Ledger index at open; the simulated ledger closes every 4 s. */
const OPEN_INDEX = 99_000_000
/** The pre-created account's Sequence (an account starts at the index it was created in, here ~27 min before open). */
const PRECREATED_SEQ = OPEN_INDEX - 400
/** Tickets reserved at open (outer + inner of each pre-signed default, spec §5.4) and Sequences the open Batch uses. */
const TICKETS = { 'default.refund': [0, 4], 'default.noshow': [4, 9], 'default.release': [9, 15] } as const
const TICKET_COUNT = 15
const OPEN_SEQUENCES = 4 + TICKET_COUNT

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const micro = (v: string) => parseAmount(v, ASSET).minor
const fmt = (m: bigint) => formatAmount(new Amount('RLUSD', m), ASSET.decimals)
const money = (v: string) => ({ currency: 'RLUSD', value: v })

function loadLibrary(): { template: Template; policies: PolicyDoc[]; policy: PolicyDoc } {
  const policy = readJson<PolicyDoc>('policies/hotel@2.0.0.json')
  for (const a of Object.values(policy.assets ?? {})) if (a.kind === 'IOU') a.issuer = W.issuer.address
  if (policy.params?.rulingWindow !== `${RULING_WINDOW_SECS}s`) throw new Error(`hotel-sim assumes rulingWindow ${RULING_WINDOW_SECS}s, policy has ${String(policy.params?.rulingWindow)}`)
  return { template: readJson<Template>('templates/hotel@2.json'), policies: [readJson<PolicyDoc>('policies/baseline@1.1.0.json'), policy], policy }
}

/** close.split payouts in blueprint order: hotel (gross less 50 bps), fee, guest. Zero legs are dropped. */
function split(toHotelGross: bigint, toGuest: bigint): Payout[] {
  const fee = (toHotelGross * FEE_BPS) / 10000n
  return [
    { to: W.hotel.address, value: toHotelGross - fee },
    { to: W.service.address, value: fee },
    { to: W.guest.address, value: toGuest },
  ].filter((p) => p.value > 0n).map((p) => ({ to: p.to, value: fmt(p.value) }))
}

/** One path: a co-signer, a fixture ledger, and the engagement driven through it. */
class PathSim {
  readonly steps: HotelSimStep[] = []
  private readonly source: FixtureLedgerSource
  private readonly svc: CosignerService
  private readonly eng: Wallet
  private readonly id: string
  private readonly bookingId: string
  private nonce = 0
  private seq = PRECREATED_SEQ
  private tickets: number[] = []
  private mandate?: Statement
  private dispute?: Statement
  private claim?: Statement
  private readonly rulings = new Map<string, Statement>()

  constructor(private readonly path: HotelPath, lib: ReturnType<typeof loadLibrary>) {
    this.eng = wallet(`eng-${path}`)
    this.id = `eng_hotel_${path}_sim`
    this.bookingId = `BK-${path}`
    // Pre-created (spec §5.1): reserves, the asset trust line, the service's RegularKey, master disabled; no RLUSD yet.
    this.source = new FixtureLedgerSource({
      index: OPEN_INDEX, hash: '', closeTime: TIMERS.openedAt, baseFeeDrops: String(FEES.base), reserveIncDrops: String(FEES.inc),
      accounts: { [this.eng.address]: { exists: true, masterDisabled: true, regularKey: W.service.address, sequence: this.seq, ownerObjects: { trustlines: 1, signerList: false, tickets: [], other: 0 } } },
      balances: { [this.eng.address]: { RLUSD: '0' } },
      credentials: [], history: {},
    })
    this.setClock(TIMERS.openedAt)
    this.svc = new CosignerService({ signer: localSigner(W.cosigner), source: this.source, templates: [lib.template], policies: lib.policies })
  }

  private get snap(): LedgerSnapshot { return this.source.snap }
  private get now(): string { return this.snap.closeTime }
  private get acct() { return this.snap.accounts[this.eng.address] }
  private get balance(): bigint { return micro(this.snap.balances[this.eng.address].RLUSD ?? '0') }
  private set balance(m: bigint) { this.snap.balances[this.eng.address].RLUSD = fmt(m) }

  /** Advance the validated ledger to `t` (index follows at one ledger per 4 s). */
  private setClock(t: string): void {
    const ms = Date.parse(t)
    if (ms < Date.parse(this.snap.closeTime)) throw new Error(`clock moving backwards to ${t}`)
    this.snap.closeTime = t
    this.snap.index = OPEN_INDEX + Math.floor((ms - Date.parse(TIMERS.openedAt)) / 4000)
    this.snap.hash = createHash('sha256').update(`hotel-sim:${this.snap.index}`).digest('hex').toUpperCase()
  }

  private add(s: HotelStepResult | HotelStepResult[]): void {
    for (const x of [s].flat()) this.steps.push({ ...x, at: this.now })
  }

  // ── Steps (as HotelFlow) ─────────────────────────────────────────────────
  /** Open Batch applied: room funded, SignerList, 15 Tickets, RegularKey cleared. Register; pre-sign the open-time defaults. */
  async open(): Promise<void> {
    this.tickets = Array.from({ length: TICKET_COUNT }, (_, i) => this.seq + 3 + i) // outer, SignerListSet, TicketCreate, then its Tickets
    this.seq += OPEN_SEQUENCES
    Object.assign(this.acct, { regularKey: null, sequence: this.seq, ownerObjects: { trustlines: 1, signerList: true, tickets: [...this.tickets], other: 0 } })
    this.balance = micro(BOOKING.room)
    const t0 = Date.parse(TIMERS.openedAt)
    this.mandate = this.stmt(W.guest, 'PRINCIPAL', 'party.mandate/1', { mandateId: `mnd_${this.path}` }, {
      purpose: 'lodging', expires: iso(t0 + 86400_000),
      constraints: { city: 'Lisbon', country: 'PT', ...STAY, maxTotal: money('450'), maxDeposit: money(BOOKING.maxDeposit) },
    })
    const record: EngagementRecord = {
      engagementId: this.id, template: TEMPLATE, account: this.eng.address, asset: 'RLUSD',
      parties: { principal: W.guest.address, counterparty: W.hotel.address, arbiter: W.arbiter.address, backupArbiter: W.backupArbiter.address, cosigner: W.cosigner.address },
      fee: { bps: Number(FEE_BPS), to: W.service.address }, deleteTo: W.service.address,
      amount: { asset: 'RLUSD', value: BOOKING.room }, timers: { ...TIMERS }, state: 'OPEN', consumed: [], mandateId: this.mandate.id,
    }
    this.svc.register(record, this.mandate)
    await this.presign('default.refund', [{ to: W.guest.address, value: BOOKING.room }])
    await this.presign('default.noshow', split(micro(BOOKING.room), 0n))
    this.add({ step: 'open', final: 'tesSUCCESS' })
  }

  async confirm(): Promise<void> {
    const receipt = await this.post(this.stmt(W.hotel, 'COUNTERPARTY', 'party.confirmation/1', { bookingId: this.bookingId }, {
      mandateHash: this.mandate!.id, bookingId: this.bookingId, property: 'Casa Alfama', city: 'Lisbon', country: 'PT',
      ...STAY, total: money(BOOKING.room), deposit: money(BOOKING.deposit),
    }))
    this.add({ ...this.decided('confirm', await this.svc.decide({ engagementId: this.id, stage: 'confirm' })), receipt })
  }

  /** Spec §5.3 order: check-in attestation → default.release pre-signed and stored → deposit → `checkin`. */
  async checkIn(): Promise<void> {
    const receipt = await this.post(this.stmt(W.hotel, 'COUNTERPARTY', 'party.checkin/1', { bookingId: this.bookingId }, { status: 'checked_in', room: '204', deposit: money(BOOKING.deposit) }))
    this.add({ step: 'checkin attestation', final: 'RECEIPTED', receipt })
    await this.presign('default.release', split(micro(BOOKING.room), micro(BOOKING.deposit)))
    this.add({ step: 'default.release pre-signed', final: 'STORED' })
    this.balance += micro(BOOKING.deposit)
    this.add({ step: 'deposit', final: 'tesSUCCESS' })
    this.add(this.decided('checkin', await this.svc.decide({ engagementId: this.id, stage: 'checkin' })))
  }

  /** Guest's Batch applied (ENG/DISPUTE Credential on the account + the bond); then the dispute attestation. */
  async openDispute(phase: 'entry' | 'settlement'): Promise<void> {
    this.snap.credentials.push({ issuer: W.guest.address, subject: this.eng.address, type: 'ENG/DISPUTE', accepted: false, expiration: null })
    this.balance += micro(BOOKING.bond)
    this.dispute = this.stmt(W.guest, 'PRINCIPAL', 'party.dispute/1', { bookingId: this.bookingId }, {
      phase, reason: phase === 'entry' ? 'room not as booked' : 'claim disputed', bond: money(BOOKING.bond), evidenceHashes: [],
    })
    const receipt = await this.post(this.dispute)
    this.add({ step: `dispute (${phase})`, final: 'tesSUCCESS', receipt })
  }

  async concede(): Promise<void> {
    await this.post(this.stmt(W.hotel, 'COUNTERPARTY', 'party.concession/1', { bookingId: this.bookingId }, { disputeRef: this.dispute!.id }))
    const tx = this.liveClose([{ to: W.guest.address, value: fmt(this.balance) }], 'refund.conceded', 3)
    this.add(await this.cosigned('refund.conceded', 'refund.conceded', tx, [W.guest, W.hotel]))
  }

  async postClaim(items: Array<{ kind: string; amount: string }>): Promise<void> {
    const total = items.reduce((s, i) => s + micro(i.amount), 0n)
    this.claim = this.stmt(W.hotel, 'COUNTERPARTY', 'party.claim/1', { bookingId: this.bookingId }, {
      items: items.map((i) => ({ kind: i.kind, amount: money(i.amount), evidenceHashes: [] })), total: money(fmt(total)),
    })
    const receipt = await this.post(this.claim)
    this.add({ step: 'claim', final: 'RECEIPTED', receipt })
  }

  async settleAgreed(): Promise<void> {
    const review = this.stmt(W.guest, 'PRINCIPAL', 'party.review/1', { bookingId: this.bookingId }, { stayed: true, rating: 5, text: 'Lovely stay; minibar charge accepted' })
    await this.post(review)
    const claimed = this.claim ? micro((this.claim.claim as { total: { value: string } }).total.value) : 0n
    const tx = this.liveClose(split(micro(BOOKING.room) + claimed, micro(BOOKING.deposit) - claimed), 'settle.agreed', 3, [memo('eng/review', review.id)])
    this.add(await this.cosigned('settle', 'settle', tx, [W.guest, W.hotel]))
  }

  /** Primary arbiter: arbiter + one party, no co-signer (optional advisory stage). Backup: backup + party + co-signer. */
  async ruling(by: 'arbiter' | 'backupArbiter', payouts: Payout[], opts: { party?: 'principal' | 'counterparty'; advisory?: string } = {}): Promise<void> {
    const arb = by === 'arbiter' ? W.arbiter : W.backupArbiter
    if (!this.rulings.has(by)) {
      const st = this.stmt(arb, 'ARBITER', 'party.ruling/1', { bookingId: this.bookingId }, { payouts, rationale: by === 'arbiter' ? 'primary ruling' : 'backup ruling after the primary ruling window' })
      await this.post(st)
      this.rulings.set(by, st)
    }
    const party = opts.party === 'counterparty' ? W.hotel : W.guest
    if (by === 'backupArbiter') {
      this.add(await this.cosigned('ruling:backupArbiter', 'ruling.backup', this.liveClose(payouts, 'ruling.backup', 3), [arb, party]))
      return
    }
    const tx = this.liveClose(payouts, 'settle.ruling', 2)
    const blobs = [multisignBlob(arb, tx), multisignBlob(party, tx)]
    const adv = opts.advisory ? await this.svc.decide({ engagementId: this.id, stage: opts.advisory, txBlob: blobs[0] }) : undefined
    this.add({ ...(adv ? this.decided(opts.advisory!, adv) : {}), ...this.submit(combine(blobs)), step: 'ruling:arbiter' })
  }

  /** tick() the co-signer and submit every completed default, in the co-signer's result order. */
  async tickAndSubmit(): Promise<void> {
    for (const t of await this.svc.tick(this.id)) {
      const res = this.decided(t.stage, t, `tick ${t.outcome}`)
      this.add(t.decision === 'SIGN' && t.blob ? { ...res, ...this.submit(t.blob) } : res)
    }
  }

  /** A close signed only by `roles`. */
  async quorumProbe(roles: Array<'principal' | 'counterparty' | 'arbiter' | 'backupArbiter'>): Promise<void> {
    const w = { principal: W.guest, counterparty: W.hotel, arbiter: W.arbiter, backupArbiter: W.backupArbiter }
    const tx = this.liveClose([{ to: W.guest.address, value: fmt(this.balance) }], 'probe', roles.length)
    const { tx: hash, final } = this.submit(combine(roles.map((r) => multisignBlob(w[r], tx))))
    this.add({ step: `probe:${roles.join('+')}`, tx: hash, final })
  }

  /** Move the clock to `t`. */
  at(t: string): this { this.setClock(t); return this }

  // ── Helpers ──────────────────────────────────────────────────────────────
  private stmt(signer: Wallet, kind: string, type: string, subject: Json, claim: Json): Statement {
    const t = iso(Date.parse(this.now) - 30_000) // issued half a minute before it is posted
    const nonce = createHash('sha256').update(`${this.id}:${++this.nonce}`).digest('hex').slice(0, 32)
    return signStatement({ v: 'eng.att/1', type, engagementId: this.id, subject, claim, observedAt: t, issuedAt: t, nonce, attester: { account: signer.address, kind } }, signer)
  }

  /** Posted = receipted by the co-signer (ingest judges the window on the snapshot's closeTime). */
  private async post(s: Statement): Promise<HotelReceipt> { return receiptOf(await this.svc.ingest(this.id, s)) }

  private async presign(outcome: keyof typeof TICKETS, payouts: Payout[]): Promise<void> {
    const [a, b] = TICKETS[outcome]
    const tx = buildCloseBatch({
      eng: this.eng.address, currency: CURRENCY, issuer: W.issuer.address, payouts, deleteTo: W.service.address,
      tickets: this.tickets.slice(a, b), memos: [memo('eng/basis', outcome)], fees: FEES, signatures: 3,
    })
    await this.svc.storePresigned(this.id, outcome, combine([multisignBlob(W.guest, tx), multisignBlob(W.hotel, tx)]))
  }

  /** A live close (Sequence + short LastLedgerSequence), payouts in blueprint order. */
  private liveClose(payouts: Payout[], basis: string, signatures: number, extraMemos: Json[] = []): Json {
    const order = [W.hotel.address, W.service.address, W.guest.address]
    return buildCloseBatch({
      eng: this.eng.address, currency: CURRENCY, issuer: W.issuer.address, payouts: [...payouts].sort((x, y) => order.indexOf(x.to) - order.indexOf(y.to)),
      deleteTo: W.service.address, seq: this.seq, lastLedgerSequence: this.snap.index + 20, memos: [memo('eng/basis', basis), ...extraMemos], fees: FEES, signatures,
    })
  }

  private async cosigned(step: string, stage: string, tx: Json, wallets: Wallet[]): Promise<HotelStepResult> {
    const blobs = wallets.map((w) => multisignBlob(w, tx))
    const d = await this.svc.decide({ engagementId: this.id, stage, txBlob: blobs[0] })
    const res = this.decided(stage, d, step)
    if (d.decision !== 'SIGN' || !d.signerBlob) return res
    return { ...res, ...this.submit(combine([...blobs, d.signerBlob])) }
  }

  private decided(stage: string, d: DecideResponse | TickResult, step = stage): HotelStepResult {
    const results = ((d.record.claim as Json).results ?? []) as Array<{ id: string; result: string; reason?: string }>
    return { step, stage, decision: d.decision, failing: d.failing, rules: results.map(({ id, result, reason }) => ({ id, result, ...(reason ? { reason } : {}) })) }
  }

  /**
   * The simulated ledger. A multisigned closing Batch applies when every signature verifies and the signers'
   * weights reach the quorum; otherwise tefBAD_QUORUM and nothing changes. Applying it pays the inner Payments
   * and deletes the account. Anything else the ledger would reject is a generator bug and throws.
   * NOT simulated: AccountDelete's minimum account age, inner-step order (TrustSet removal before AccountDelete),
   * currency/issuer matching, exact inner Sequence numbers, fee sufficiency, LastLedgerSequence expiry.
   */
  private submit(blob: string): Pick<HotelStepResult, 'tx' | 'final' | 'payouts'> {
    const hash = xrpl.hashes.hashSignedTx(blob)
    const tx = xrpl.decode(blob) as Json & { Signers?: Array<{ Signer: { Account: string; SigningPubKey: string; TxnSignature: string } }>; RawTransactions: Array<{ RawTransaction: Json }> }
    const { Signers: signers = [], ...body } = tx
    for (const { Signer: s } of signers) {
      if (!keypairs.verify(encodeForMultisigning(body as never, s.Account), s.TxnSignature, s.SigningPubKey)) throw new Error(`hotel-sim: bad signature from ${s.Account}`)
    }
    const weight = signers.reduce((n, { Signer: s }) => n + (WEIGHTS[s.Account] ?? 0), 0)
    if (weight < QUORUM) return { tx: hash, final: 'tefBAD_QUORUM' }

    if (!this.acct.exists) throw new Error('hotel-sim: account already deleted')
    const inner = tx.RawTransactions.map((r) => r.RawTransaction)
    const have = new Set(this.acct.ownerObjects!.tickets)
    for (const t of [tx, ...inner]) {
      if (Number(t.TicketSequence ?? 0) > 0 ? !have.has(Number(t.TicketSequence)) : Number(t.Sequence) < this.seq) throw new Error('hotel-sim: Sequence/Ticket not available')
    }
    const payouts = inner.filter((t) => t.TransactionType === 'Payment').map((t) => ({ to: String(t.Destination), value: String((t.Amount as { value: string }).value) }))
    if (payouts.reduce((s, p) => s + micro(p.value), 0n) !== this.balance) throw new Error('hotel-sim: close does not drain the account exactly')
    this.balance = 0n
    Object.assign(this.acct, { exists: false, ownerObjects: { trustlines: 0, signerList: false, tickets: [], other: 0 } })
    return { tx: hash, final: 'tesSUCCESS', payouts }
  }
}

/** HotelFlow.run's path scripts, on the simulated clock. */
async function runPath(p: HotelPath, lib: ReturnType<typeof loadLibrary>): Promise<HotelSimStep[]> {
  const s = new PathSim(p, lib)
  const room = micro(BOOKING.room), deposit = micro(BOOKING.deposit), bond = micro(BOOKING.bond), claim = micro(BOOKING.claim)
  const minibar = [{ kind: 'minibar', amount: BOOKING.claim }]
  await s.open()
  switch (p) {
    case 'happy':
      await s.at('2026-11-01T09:30:00Z').confirm()
      await s.at('2026-11-11T15:00:00Z').checkIn()
      await s.tickAndSubmit() // open-time defaults after the deposit
      await s.at('2026-11-14T15:00:00Z').postClaim(minibar)
      await s.at('2026-11-14T18:00:00Z').quorumProbe(['principal', 'counterparty'])
      await s.settleAgreed()
      break
    case 'unconfirmed':
      await s.at('2026-11-01T11:01:00Z').tickAndSubmit()
      break
    case 'noshow':
      await s.at('2026-11-01T09:30:00Z').confirm()
      await s.at('2026-11-12T11:01:00Z').tickAndSubmit() // past checkInBy and entryDisputeBy
      break
    case 'entryConceded':
      await s.at('2026-11-01T09:30:00Z').confirm()
      await s.at('2026-11-11T20:00:00Z').openDispute('entry')
      await s.at('2026-11-12T09:00:00Z').concede()
      break
    case 'entryRuled':
      await s.at('2026-11-01T09:30:00Z').confirm()
      await s.at('2026-11-11T20:00:00Z').openDispute('entry')
      await s.at('2026-11-12T11:01:00Z').tickAndSubmit() // no-show refused while the entry dispute is open
      await s.at('2026-11-12T15:00:00Z').ruling('arbiter', split(room - deposit, deposit + bond)) // downgrade: partial refund + bond back
      break
    case 'silence':
      await s.at('2026-11-01T09:30:00Z').confirm()
      await s.at('2026-11-11T15:00:00Z').checkIn()
      await s.at('2026-11-17T11:01:00Z').tickAndSubmit()
      break
    case 'claimUnanswered':
      await s.at('2026-11-01T09:30:00Z').confirm()
      await s.at('2026-11-11T15:00:00Z').checkIn()
      await s.at('2026-11-14T15:00:00Z').postClaim(minibar)
      await s.at('2026-11-17T11:01:00Z').tickAndSubmit() // release refused while a claim is posted
      await s.at('2026-11-17T12:00:00Z').ruling('arbiter', split(room + claim, deposit - claim), { party: 'counterparty', advisory: 'ruling.default' })
      break
    case 'backupRuling': {
      const payouts = split(room, deposit + bond)
      await s.at('2026-11-01T09:30:00Z').confirm()
      await s.at('2026-11-11T15:00:00Z').checkIn()
      await s.at('2026-11-14T15:00:00Z').postClaim(minibar)
      await s.at('2026-11-15T10:00:00Z').openDispute('settlement') // disputeOpenedAt 2026-11-15T09:59:30Z
      await s.at('2026-11-16T10:00:00Z').ruling('backupArbiter', payouts) // inside the primary's 5-day window
      await s.quorumProbe(['arbiter', 'backupArbiter'])
      await s.at('2026-11-20T10:00:00Z').ruling('backupArbiter', payouts) // past disputeOpenedAt + 432000 s
      break
    }
  }
  return s.steps
}

export async function buildHotelTranscript(): Promise<HotelTranscript> {
  const lib = loadLibrary()
  const paths = {} as Record<HotelPath, HotelSimStep[]>
  for (const p of HOTEL_PATHS) paths[p] = await runPath(p, lib)
  return {
    generatedBy: 'npm run web:hotel-sim: CosignerService over FixtureLedgerSource (packages/web/src/hotel-sim.ts)',
    policy: `${lib.policy.policyId}@${lib.policy.version} (rulingWindow ${String(lib.policy.params?.rulingWindow)})`,
    explanations: ruleExplanations(lib.policies),
    cast: {
      issuer: W.issuer.address, guest: W.guest.address, hotel: W.hotel.address, arbiter: W.arbiter.address,
      backupArbiter: W.backupArbiter.address, service: W.service.address, cosigner: W.cosigner.address,
    },
    booking: { ...BOOKING },
    timers: { ...TIMERS },
    paths,
  }
}
