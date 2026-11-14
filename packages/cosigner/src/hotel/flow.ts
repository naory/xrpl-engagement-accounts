// HotelFlow: drives one hotel@2 stay-escrow engagement on a live XRPL network through the policy
// co-signer (spec §5, §7.1). One instance per engagement account; `run(path)` plays a whole path.
// Timers are seconds from the open ledger's closeTime and every wait is on validated-ledger closeTime,
// which is the co-signer's clock.
import xrpl from 'xrpl'
import { Amount, formatAmount, newNonce, parseAmount, signStatement, type AssetDef, type Statement, type StatementBody } from '@eng/core'
import type { EngagementRecord } from '@eng/policy'
import type { CosignerService, DecideResponse, Receipt, TickResult } from '../service.ts'
import {
  ASF_DISABLE_MASTER, TF_ALL_OR_NOTHING, TF_SET_NO_RIPPLE,
  accountInfo, addBatchSigner, batchFee, buildCloseBatch, buildOpenBatch, combine, currentLedger, hex, inner, innerResults, iou,
  lookupTx, memo, multisignBlob, sendSimple, sleep, submit, type Fees, type SubmitResult,
} from '../xrpl-io.ts'

type Json = Record<string, unknown>
type Client = InstanceType<typeof xrpl.Client>
type Wallet = InstanceType<typeof xrpl.Wallet>

export type HotelPath = 'happy' | 'unconfirmed' | 'noshow' | 'entryConceded' | 'entryRuled' | 'silence' | 'claimUnanswered' | 'partialDeposit' | 'arbiterSilent' | 'staySilent'
export const HOTEL_PATHS: HotelPath[] = ['happy', 'unconfirmed', 'noshow', 'entryConceded', 'entryRuled', 'silence', 'claimUnanswered', 'partialDeposit', 'arbiterSilent', 'staySilent']

/** Nights booked on a path: `staySilent` books 3 nights (so it has stay chargeback variants #1, #2); every other path 1. */
export function hotelPathNights(path: HotelPath): number { return path === 'staySilent' ? 3 : 1 }

export interface HotelStepResult {
  step: string
  stage?: string
  decision?: 'SIGN' | 'REFUSE'
  failing?: string[]
  rules?: Array<{ id: string; result: string; reason?: string }>
  tx?: string
  final?: string
  payouts?: Array<{ to: string; value: string }>
  /** Posting steps: the co-signer's signed cosigner.receipt/1 for the posted statement (the poster's proof). */
  receipt?: HotelReceipt
}

export interface HotelReceipt { statementId: string; statementType: string; receivedAt: string; ledgerIndex: number }

/** Seconds from open. */
export interface HotelTimerOffsets {
  confirmBy: number
  checkIn: number
  checkInBy: number
  entryDisputeBy: number
  deliveryBy: number
  claimBy: number
  disputeWindowEnds: number
}
export const DEMO_HOTEL_TIMERS: HotelTimerOffsets = { confirmBy: 40, checkIn: 60, checkInBy: 90, entryDisputeBy: 120, deliveryBy: 150, claimBy: 180, disputeWindowEnds: 210 }

export interface HotelCast {
  issuer: Wallet
  guest: Wallet
  hotel: Wallet
  /** Funded: it accepts its ENG/ARBITER accreditation (CredentialAccept); otherwise it only signs. */
  arbiter: Wallet
  /** The service's arbiter accreditor (funded): issues the arbiter's ENG/ARBITER; listed in the policy's arbiterIssuers. */
  accreditor: Wallet
  /** Pre-creates engagement accounts; the fee account and AccountDelete destination. */
  service: Wallet
  /** Hex currency code of the booking asset (RLUSD). */
  currency: string
}

/** `partialDeposit`: what the guest pays at check-in on the partialDeposit path (less than `deposit`; the hotel refuses check-in). */
export interface HotelBooking { room: string; deposit: string; bond: string; claim: string; maxDeposit: string; partialDeposit: string }
export const DEMO_HOTEL_BOOKING: HotelBooking = { room: '400', deposit: '100', bond: '10', claim: '20', maxDeposit: '200', partialDeposit: '40' }

/** A deal's Ticket plan: each pre-signed default's [start, end) slice of the Tickets reserved at open, and their count. */
export interface HotelTicketPlan { slices: Record<string, readonly [number, number]>; count: number }

/** hotel@2's default.chargebackStay variants.max: stays of more than max + 1 (14) nights get no stay variants. */
const STAY_VARIANT_MAX = 13

/**
 * Tickets reserved at open (spec §5.4), sized from the stay: outer + inner Tickets of each pre-signed default — refund 4,
 * no-show 5, no-show sweep 6, release 6, chargeback entry 4, chargeback claim 6, and 6 per stay variant
 * default.chargebackStay#k, k = 1 … nights − 1 (none beyond 14 nights). The no-show is pre-signed twice: exact (the
 * account holds just the room) and with a residual sweep returning anything extra to the guest; the co-signer completes
 * whichever fits the balance and the other dies at AccountDelete.
 */
export function hotelTickets(nights: number): HotelTicketPlan {
  const sizes: Array<[string, number]> = [
    ['default.refund', 4], ['default.noshow', 5], ['default.noshowSweep', 6], ['default.release', 6],
    ['default.chargebackEntry', 4], ['default.chargebackClaim', 6],
  ]
  if (nights - 1 <= STAY_VARIANT_MAX) for (let k = 1; k < nights; k++) sizes.push([`default.chargebackStay#${k}`, 6])
  const slices: Record<string, readonly [number, number]> = {}
  let at = 0
  for (const [outcome, n] of sizes) { slices[outcome] = [at, at + n]; at += n }
  return { slices, count: at }
}

/** Sequence numbers the open Batch consumes (outer, SignerListSet, TicketCreate + its Tickets, SetRegularKey). */
export function hotelOpenSequences(nights: number): number { return 4 + hotelTickets(nights).count }

/** The deal's per-night terms pinned in the record: nightly = floor(room ÷ nights) in the asset's minor units (6 decimals). */
export function hotelTerms(room: string, nights: number): { nights: number; nightly: string } {
  const asset: AssetDef = { code: 'RLUSD', kind: 'IOU', currency: 'RLUSD', issuer: '', decimals: 6 }
  return { nights, nightly: formatAmount(new Amount('RLUSD', parseAmount(room, asset).minor / BigInt(nights)), 6) }
}
const ACCOUNT_DELETE_MIN_AGE = 256
const FEE_BPS = 50n
const TEMPLATE = 'settlement-vault/hotel@2'

type Role = 'principal' | 'counterparty' | 'arbiter' | 'cosigner'
type Payout = { to: string; value: string }
/** A pre-signed payout: a fixed amount, or a residual sweep (tfPartialPayment) of whatever is left. */
type PresignPayout = { to: string; value?: string; partial?: boolean }

// Per-account submission lock: paths run concurrently and share the cast's accounts (Sequence numbers).
const locks = new Map<string, Promise<unknown>>()
function withLock<T>(account: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(account) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  locks.set(account, run.catch(() => undefined))
  return run
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** Close time (ms) and index of a validated ledger (the latest, or `index`). */
export async function ledgerClock(client: Client, index?: number): Promise<{ index: number; time: number }> {
  const r = (await client.request({ command: 'ledger', ledger_index: index ?? 'validated' } as never)) as unknown as { result: { ledger_index: number; ledger: { close_time_iso?: string; close_time?: number } } }
  const l = r.result.ledger
  return { index: Number(r.result.ledger_index), time: l.close_time_iso ? Date.parse(l.close_time_iso) : (Number(l.close_time) + 946684800) * 1000 }
}

export class HotelFlow {
  private eng = ''
  private id = ''
  private t0 = 0
  private tickets: number[] = []
  private nights = 1
  private plan: HotelTicketPlan = hotelTickets(1)
  private record?: EngagementRecord
  private mandate?: Statement
  private dispute?: Statement
  private claim?: Statement
  private checkedIn = false
  private readonly rulings = new Map<string, Statement>()
  private readonly asset: AssetDef

  constructor(private readonly o: {
    client: Client; fees: Fees; svc: CosignerService; cast: HotelCast; timers: HotelTimerOffsets
    /** Policy layer hashes pinned in the engagement record (e.g. the demo's rulingWindow layer). */
    policyLayers?: string[]
    booking?: HotelBooking
    /** Must equal the pinned policy's params.rulingWindow; default 60 (the demo layer). */
    rulingWindowSecs?: number
    runId?: string
    log?: (msg: string) => void
    /** Called for every submitted transaction (results files list every hash). */
    onTx?: (label: string, r: SubmitResult) => void
    /**
     * DEMO ONLY — never enable outside `npm run demo:hotel`. The co-signer's raw key, used solely by the H14 quorum
     * probe: quorumProbe(['arbiter', 'cosigner']) signs a LIVE close transaction with this key outside decide(), i.e.
     * bypassing every policy check, to show arbiter (4) + co-signer (2) stay below quorum 7 (tefBAD_QUORUM). Anywhere
     * the co-signer's key must stay behind its policy engine (production, the web demo), leave this unset.
     */
    probeCosigner?: Wallet
  }) {
    this.asset = { code: 'RLUSD', kind: 'IOU', currency: o.cast.currency, issuer: o.cast.issuer.address, decimals: 6 }
  }

  get engagementId(): string { return this.id }
  get account(): string { return this.eng }
  get booking(): HotelBooking { return this.o.booking ?? DEMO_HOTEL_BOOKING }

  // ── Setup ────────────────────────────────────────────────────────────────
  /** XRP a pre-created account needs for a stay of `nights`: base reserve, trust line + SignerList, its Tickets, 1 XRP for fees. */
  static precreateDrops(fees: Fees, nights: number): number { return fees.reserveBase + fees.inc * (2 + hotelTickets(nights).count) + 1_000_000 }

  /**
   * Pre-create one engagement account per entry of `nights` (the stay it will hold): XRP for reserves (Tickets grow with
   * the nights), the asset trust line, service RegularKey, master disabled.
   */
  async precreate(nights: number[]): Promise<Wallet[]> {
    const { client, fees, cast } = this.o
    return Promise.all(nights.map(async (n) => {
      const drops = HotelFlow.precreateDrops(fees, n)
      const eng = xrpl.Wallet.generate()
      await withLock(cast.service.address, async () => this.must(await sendSimple(client, cast.service, { TransactionType: 'Payment', Account: cast.service.address, Destination: eng.address, Amount: String(drops) }), 'pre-create fund'))
      this.must(await sendSimple(client, eng, { TransactionType: 'TrustSet', Account: eng.address, LimitAmount: iou(cast.currency, cast.issuer.address, '1000000000'), Flags: TF_SET_NO_RIPPLE }), 'pre-create trust line')
      this.must(await sendSimple(client, eng, { TransactionType: 'SetRegularKey', Account: eng.address, RegularKey: cast.service.address }), 'pre-create SetRegularKey')
      this.must(await sendSimple(client, eng, { TransactionType: 'AccountSet', Account: eng.address, SetFlag: ASF_DISABLE_MASTER }), 'pre-create disable master')
      return eng
    }))
  }

  /**
   * Poll until every account can be deleted: Sequence + 256 ≤ validated index, counting the `headroom`
   * Sequence numbers the open Batch will still consume (AccountDelete compares the account's current Sequence).
   */
  async waitUntilAged(accounts: string[], headroom = Math.max(...HOTEL_PATHS.map((p) => hotelOpenSequences(hotelPathNights(p))))): Promise<void> {
    for (;;) {
      const { index } = await ledgerClock(this.o.client)
      let need = 0
      for (const a of accounts) {
        const seq = Number(((await accountInfo(this.o.client, a))!.account_data as Json).Sequence)
        need = Math.max(need, seq + headroom + ACCOUNT_DELETE_MIN_AGE)
      }
      if (index >= need) return
      this.log(`waiting for AccountDelete eligibility: ledger ${index} / ${need} (~${Math.ceil(((need - index) * 3.8) / 60)} min)`)
      await sleep(20_000)
    }
  }

  /**
   * Accreditation (once per cast): the service's accreditor issues the arbiter an ENG/ARBITER Credential and the
   * arbiter accepts it, so the co-signer registers engagements naming this arbiter (chargeback spec §4.2).
   */
  async accredit(): Promise<HotelStepResult[]> {
    const { client, cast } = this.o
    const type = hex('ENG/ARBITER')
    const issued = await withLock(cast.accreditor.address, async () => this.track('accreditation: ENG/ARBITER issued', await sendSimple(client, cast.accreditor, {
      TransactionType: 'CredentialCreate', Account: cast.accreditor.address, Subject: cast.arbiter.address, CredentialType: type, URI: hex('accreditation:hotel-arbiter'),
    })))
    if (issued.final !== 'tesSUCCESS') return [{ step: 'accreditation issued', tx: issued.hash, final: issued.final }]
    const accepted = await withLock(cast.arbiter.address, async () => this.track('accreditation: ENG/ARBITER accepted', await sendSimple(client, cast.arbiter, {
      TransactionType: 'CredentialAccept', Account: cast.arbiter.address, Issuer: cast.accreditor.address, CredentialType: type,
    })))
    return [{ step: 'accreditation issued', tx: issued.hash, final: issued.final }, { step: 'accreditation accepted', tx: accepted.hash, final: accepted.final }]
  }

  // ── Steps ────────────────────────────────────────────────────────────────
  /**
   * Open Batch (guest funds the room, SignerList, the deal's Tickets — sized from its nights — RegularKey cleared),
   * register, pre-sign the open-time defaults (refund, both no-shows, the entry chargeback).
   */
  async open(eng: Wallet, path: HotelPath): Promise<HotelStepResult> {
    const { client, fees, cast, svc } = this.o
    this.eng = eng.address
    this.id = `eng_hotel_${path}_${this.o.runId ?? Date.now().toString(36)}`
    this.nights = hotelPathNights(path)
    this.plan = hotelTickets(this.nights)
    // The co-signer's neutrality gate runs before any money moves: register() needs no on-ledger account, so the record
    // is registered first, and the open Batch — which funds the room and installs the SignerList giving the arbiter
    // weight 4 — is submitted only once registration succeeded. An unaccredited arbiter is refused NOT_NEUTRAL here and
    // nothing is submitted. Both run under the guest's lock (paths queue there for their open Batch), so the timers are
    // anchored at the validated close time just before this deal's own Batch, not before the queue.
    const opened = await withLock(cast.guest.address, async () => {
      this.t0 = (await ledgerClock(client)).time
      this.mandate = this.mandateFor(this.id, path, this.t0, this.nights)
      this.record = this.recordFor(this.id, eng.address, this.t0, this.nights, this.mandate, cast.arbiter.address)
      try {
        await svc.register(this.record, this.mandate)
      } catch (e) {
        return { refused: (e as Error).message }
      }
      const seq = Number(((await accountInfo(client, eng.address))!.account_data as Json).Sequence)
      const funderSeq = Number(((await accountInfo(client, cast.guest.address))!.account_data as Json).Sequence)
      const built = buildOpenBatch({
        eng: eng.address, funder: cast.guest.address, currency: cast.currency, issuer: cast.issuer.address, amount: this.booking.room,
        signerEntries: [[cast.guest.address, 3], [cast.hotel.address, 3], [cast.arbiter.address, 4], [svc.address, 2]],
        quorum: 7, seq, funderSeq, ticketCount: this.plan.count, memos: [memo('eng/open', `${this.id}|template=${TEMPLATE}`)], fees,
      })
      this.tickets = built.tickets
      addBatchSigner(cast.guest, built.tx)
      return { r: this.track('open', await submit(client, cast.service.sign(built.tx as never).tx_blob)), tx: built.tx }
    })
    if ('refused' in opened) {
      this.log(`register refused, nothing submitted: ${opened.refused}`)
      return { step: 'register', final: opened.refused }
    }
    const { r, tx } = opened
    const final = await this.batchFinal(r, tx)
    if (final !== 'tesSUCCESS') return { step: 'open', tx: r.hash, final }
    // Automatic endings return any extra money to the guest (residual sweep). The refund sweeps everything; the no-show
    // is signed exact and with a sweep, since a sweep that delivers nothing would fail on-ledger and burn its Tickets.
    // The entry chargeback (arbiter silent on an arrival dispute) returns everything to the guest.
    await this.presign('default.refund', [this.sweepToGuest()])
    await this.presign('default.noshow', this.split(this.micro(this.booking.room), 0n))
    await this.presign('default.noshowSweep', [...this.split(this.micro(this.booking.room), 0n), this.sweepToGuest()])
    await this.presign('default.chargebackEntry', [this.sweepToGuest()])
    this.log(`opened ${this.id} at ${eng.address} (t0 ${iso(this.t0)}, ${this.nights} night(s), ${this.plan.count} Tickets); default.refund, default.noshow (exact and sweep), default.chargebackEntry pre-signed`)
    return { step: 'open', tx: r.hash, final }
  }

  /** The guest's mandate for a stay of `nights` from the day of `t0`. */
  private mandateFor(id: string, path: string, t0: number, nights: number): Statement {
    const day = (ms: number) => iso(ms).slice(0, 10)
    return this.stmt(this.o.cast.guest, 'PRINCIPAL', 'party.mandate/1', { mandateId: `mnd_${path}` }, {
      purpose: 'lodging', expires: iso(t0 + 86400_000),
      constraints: { city: 'Lisbon', country: 'PT', checkIn: day(t0), checkOut: day(t0 + nights * 86400_000), maxTotal: this.money('450'), maxDeposit: this.money(this.booking.maxDeposit) },
    }, id)
  }

  /** The engagement record: parties, fee, timers from `t0`, and the per-night terms pinned at booking. */
  private recordFor(id: string, account: string, t0: number, nights: number, mandate: Statement, arbiter: string): EngagementRecord {
    const { cast, svc } = this.o
    const t = this.o.timers
    const at = (s: number) => iso(t0 + s * 1000)
    return {
      engagementId: id, template: TEMPLATE, account, asset: 'RLUSD',
      parties: { principal: cast.guest.address, counterparty: cast.hotel.address, arbiter, cosigner: svc.address },
      fee: { bps: Number(FEE_BPS), to: cast.service.address }, deleteTo: cast.service.address,
      amount: { asset: 'RLUSD', value: this.booking.room },
      timers: {
        openedAt: at(0), confirmBy: at(t.confirmBy), checkIn: at(t.checkIn), checkInBy: at(t.checkInBy), entryDisputeBy: at(t.entryDisputeBy),
        deliveryBy: at(t.deliveryBy), claimBy: at(t.claimBy), disputeWindowEnds: at(t.disputeWindowEnds),
      },
      terms: hotelTerms(this.booking.room, nights),
      state: 'OPEN', consumed: [], mandateId: mandate.id,
      ...(this.o.policyLayers ? { policyLayers: this.o.policyLayers } : {}),
    }
  }

  /** Hotel posts its confirmation; advisory `confirm` decision. */
  async confirm(): Promise<HotelStepResult> {
    const b = this.booking
    const m = this.mandate!.claim as { constraints: { city: string; checkIn: string; checkOut: string } }
    const receipt = await this.post(this.stmt(this.o.cast.hotel, 'COUNTERPARTY', 'party.confirmation/1', { bookingId: this.bookingId }, {
      mandateHash: this.mandate!.id, bookingId: this.bookingId, property: 'Casa Alfama', city: m.constraints.city, country: 'PT',
      checkIn: m.constraints.checkIn, checkOut: m.constraints.checkOut, total: this.money(b.room), deposit: this.money(b.deposit),
    }))
    return { ...this.decided('confirm', await this.o.svc.decide({ engagementId: this.id, stage: 'confirm' })), receipt }
  }

  /**
   * Spec §5.3 order: the hotel's check-in attestation → the guest's own acknowledgement once it has the keys (R23) →
   * guest + hotel pre-sign default.release, default.chargebackClaim and the stay variants default.chargebackStay#k →
   * stored → the guest pays the deposit → `checkin`. Nothing is pre-signed on the hotel's checked_in alone.
   */
  async checkIn(): Promise<HotelStepResult[]> {
    const { cast, client } = this.o
    const out: HotelStepResult[] = []
    const receipt = await this.post(this.stmt(cast.hotel, 'COUNTERPARTY', 'party.checkin/1', { bookingId: this.bookingId }, { status: 'checked_in', room: '204', deposit: this.money(this.booking.deposit) }))
    out.push({ step: 'checkin attestation', final: 'RECEIPTED', receipt })
    const ack = await this.post(this.stmt(cast.guest, 'PRINCIPAL', 'party.checkin/1', { bookingId: this.bookingId }, { status: 'checked_in', room: '204' }))
    out.push({ step: 'guest acknowledges check-in', final: 'RECEIPTED', receipt: ack })
    const room = this.micro(this.booking.room)
    await this.presign('default.release', [...this.split(room, 0n), this.sweepToGuest()]) // deposit + anything extra
    out.push({ step: 'default.release pre-signed', final: 'STORED' })
    // Arbiter silent on a claim/after-checkout dispute: room to the hotel (less fee), deposit + bond + any extra to the guest.
    await this.presign('default.chargebackClaim', [...this.split(room, 0n), this.sweepToGuest()])
    // Arbiter silent on a mid-stay dispute in night k: k nights to the hotel (less fee), the rest to the guest.
    const variants = Object.keys(this.plan.slices).filter((k) => k.startsWith('default.chargebackStay#'))
    const nightly = this.micro(this.record!.terms!.nightly)
    for (const v of variants) await this.presign(v, [...this.split(nightly * BigInt(v.split('#')[1]), 0n), this.sweepToGuest()])
    out.push({ step: `default.chargebackClaim${variants.length ? ` + ${variants.length} stay variant(s)` : ''} pre-signed`, final: 'STORED' })
    const r = await withLock(cast.guest.address, async () => this.track('deposit', await sendSimple(client, cast.guest, {
      TransactionType: 'Payment', Account: cast.guest.address, Destination: this.eng, Amount: iou(cast.currency, cast.issuer.address, this.booking.deposit), Memos: [memo('eng/deposit', this.id)],
    })))
    out.push({ step: 'deposit', tx: r.hash, final: r.final })
    this.checkedIn = true
    out.push(this.decided('checkin', await this.o.svc.decide({ engagementId: this.id, stage: 'checkin' })))
    return out
  }

  /**
   * The guest pays only part of the deposit (`booking.partialDeposit`); the hotel refuses check-in. Not a stay: after
   * the deadlines it ends as a no-show, and the sweep variant returns the partial deposit to the guest.
   */
  async partialDepositRefused(): Promise<HotelStepResult[]> {
    const { cast, client } = this.o
    const out: HotelStepResult[] = []
    const r = await withLock(cast.guest.address, async () => this.track('deposit (partial)', await sendSimple(client, cast.guest, {
      TransactionType: 'Payment', Account: cast.guest.address, Destination: this.eng, Amount: iou(cast.currency, cast.issuer.address, this.booking.partialDeposit), Memos: [memo('eng/deposit', this.id)],
    })))
    out.push({ step: 'deposit (partial)', tx: r.hash, final: r.final })
    const receipt = await this.post(this.stmt(cast.hotel, 'COUNTERPARTY', 'party.checkin/1', { bookingId: this.bookingId }, { status: 'refused', room: '204', deposit: this.money(this.booking.deposit) }))
    out.push({ step: 'checkin refused', final: 'RECEIPTED', receipt })
    return out
  }

  /** Guest's single-account Batch: ENG/DISPUTE Credential on the engagement account + the bond; then the dispute attestation. */
  async openDispute(phase: 'entry' | 'stay' | 'settlement'): Promise<HotelStepResult> {
    const { cast, client, fees } = this.o
    const g = cast.guest
    const { r, tx } = await withLock(g.address, async () => {
      const s = Number(((await accountInfo(client, g.address))!.account_data as Json).Sequence)
      const raw = [
        inner({ TransactionType: 'CredentialCreate', Account: g.address, Subject: this.eng, CredentialType: hex('ENG/DISPUTE'), URI: hex(`evidence:${this.id}:${phase}`) }, { Sequence: s + 1 }),
        inner({ TransactionType: 'Payment', Account: g.address, Destination: this.eng, Amount: iou(cast.currency, cast.issuer.address, this.booking.bond), Memos: [memo('eng/bond', this.id)] }, { Sequence: s + 2 }),
      ]
      const tx: Json = { TransactionType: 'Batch', Account: g.address, Flags: TF_ALL_OR_NOTHING, Sequence: s, LastLedgerSequence: (await currentLedger(client)) + 20, RawTransactions: raw }
      tx.Fee = batchFee({ base: fees.base, inc: fees.inc, innerTxs: raw, signatures: 1, headroom: 2 })
      return { r: this.track(`dispute (${phase})`, await submit(client, g.sign(tx as never).tx_blob)), tx }
    })
    const final = await this.batchFinal(r, tx)
    if (final !== 'tesSUCCESS') return { step: `dispute (${phase})`, tx: r.hash, final }
    this.dispute = this.stmt(g, 'PRINCIPAL', 'party.dispute/1', { bookingId: this.bookingId }, {
      phase, reason: phase === 'entry' ? 'room not as booked' : phase === 'stay' ? 'no hot water since check-in' : 'claim disputed', bond: this.money(this.booking.bond), evidenceHashes: [],
    })
    const receipt = await this.post(this.dispute)
    return { step: `dispute (${phase})`, tx: r.hash, final, receipt }
  }

  /** Hotel concedes the entry dispute: guest + hotel + co-signer refund everything to the guest (`refund.conceded`). */
  async concede(): Promise<HotelStepResult> {
    const { cast } = this.o
    await this.post(this.stmt(cast.hotel, 'COUNTERPARTY', 'party.concession/1', { bookingId: this.bookingId }, { disputeRef: this.dispute!.id }))
    const tx = await this.liveClose([{ to: cast.guest.address, value: await this.balance() }], 'refund.conceded', 3)
    return this.cosigned('refund.conceded', 'refund.conceded', tx, [cast.guest, cast.hotel])
  }

  /** Hotel posts a deposit claim (receipted before claimBy). */
  async postClaim(items: Array<{ kind: string; amount: string }>): Promise<HotelStepResult> {
    const total = items.reduce((s, i) => s + this.micro(i.amount), 0n)
    this.claim = this.stmt(this.o.cast.hotel, 'COUNTERPARTY', 'party.claim/1', { bookingId: this.bookingId }, {
      items: items.map((i) => ({ kind: i.kind, amount: this.money(i.amount), evidenceHashes: [] })), total: this.money(this.fmt(total)),
    })
    const receipt = await this.post(this.claim)
    return { step: 'claim', final: 'RECEIPTED', receipt }
  }

  /** Guest accepts the claim (if any) and reviews; guest + hotel + co-signer settle (`settle`). */
  async settleAgreed(): Promise<HotelStepResult> {
    const { cast } = this.o
    const review = this.stmt(cast.guest, 'PRINCIPAL', 'party.review/1', { bookingId: this.bookingId }, { stayed: true, rating: 5, text: 'Lovely stay; minibar charge accepted' })
    await this.post(review)
    const claimed = this.claimTotal()
    const payouts = this.split(this.micro(this.booking.room) + claimed, this.micro(this.booking.deposit) - claimed)
    const tx = await this.liveClose(payouts, 'settle.agreed', 3, [memo('eng/review', review.id)])
    return this.cosigned('settle', 'settle', tx, [cast.guest, cast.hotel])
  }

  /**
   * A ruling closes the account: arbiter + one party, no co-signer (an optional advisory stage is recorded, e.g.
   * `ruling.default`).
   */
  async ruling(payouts: Payout[], opts: { party?: 'principal' | 'counterparty'; advisory?: string } = {}): Promise<HotelStepResult> {
    const { cast, svc } = this.o
    const arb = cast.arbiter
    if (!this.rulings.has('arbiter')) await this.postRuling(payouts)
    const party = opts.party === 'counterparty' ? cast.hotel : cast.guest
    const tx = await this.liveClose(payouts, 'settle.ruling', 2)
    const blobs = [multisignBlob(arb, tx), multisignBlob(party, tx)]
    const adv = opts.advisory ? await svc.decide({ engagementId: this.id, stage: opts.advisory, txBlob: blobs[0] }) : undefined
    const r = this.track('ruling (arbiter)', await submit(this.o.client, combine(blobs)))
    return { ...(adv ? this.decided(opts.advisory!, adv) : {}), ...(await this.closeResult(r, tx)), step: 'ruling:arbiter' }
  }

  /** The arbiter's party.ruling/1, receipted (before its deadline it blocks every chargeback default). Posted once. */
  async postRuling(payouts: Payout[]): Promise<HotelStepResult> {
    const st = this.stmt(this.o.cast.arbiter, 'ARBITER', 'party.ruling/1', { bookingId: this.bookingId }, { payouts, rationale: 'arbiter ruling' })
    const receipt = await this.post(st)
    this.rulings.set('arbiter', st)
    return { step: 'ruling statement', final: 'RECEIPTED', receipt }
  }

  /** tick() the co-signer; submit every completed default. */
  async tickAndSubmit(): Promise<HotelStepResult[]> {
    const out: HotelStepResult[] = []
    for (const t of await this.o.svc.tick(this.id)) {
      const res = this.decided(t.stage, t, `tick ${t.outcome}`)
      if (t.decision === 'SIGN' && t.blob) {
        const r = this.track(t.outcome, await submit(this.o.client, t.blob))
        Object.assign(res, await this.closeResult(r, xrpl.decode(t.blob) as Json))
      }
      out.push(res)
    }
    return out
  }

  /** Submit a close signed only by `roles` (expected below quorum: tefBAD_QUORUM). */
  async quorumProbe(roles: Role[]): Promise<HotelStepResult> {
    const { cast } = this.o
    const w: Partial<Record<Role, Wallet>> = { principal: cast.guest, counterparty: cast.hotel, arbiter: cast.arbiter, cosigner: this.o.probeCosigner }
    const missing = roles.filter((x) => !w[x])
    if (missing.length) throw new Error(`quorumProbe: no key for ${missing.join(', ')}`)
    const tx = await this.liveClose([{ to: cast.guest.address, value: await this.balance() }], 'probe', roles.length)
    const r = this.track(`probe ${roles.join('+')}`, await submit(this.o.client, combine(roles.map((x) => multisignBlob(w[x]!, tx))), { waitLedgers: 5 }))
    return { step: `probe:${roles.join('+')}`, tx: r.hash, final: r.final }
  }

  /** Wait until the validated ledger's closeTime is strictly after timer `name` (+ `extraSecs`). */
  async waitPast(name: keyof HotelTimerOffsets | 'disputeOpenedAt', extraSecs = 0): Promise<void> {
    const base = name === 'disputeOpenedAt' ? this.disputeOpenedAt() : Date.parse(this.record!.timers![name])
    await this.waitUntil(base + extraSecs * 1000)
  }

  async run(path: HotelPath, eng: Wallet): Promise<HotelStepResult[]> {
    const steps: HotelStepResult[] = []
    const add = (s: HotelStepResult | HotelStepResult[]) => { for (const x of [s].flat()) { steps.push(x); this.log(describeStep(x)) } }
    const opened = await this.open(eng, path)
    add(opened)
    if (opened.final !== 'tesSUCCESS') return steps
    const b = this.booking
    const room = this.micro(b.room), deposit = this.micro(b.deposit), bond = this.micro(b.bond), claim = this.micro(b.claim)
    switch (path) {
      case 'happy':
        add(await this.confirm())
        await this.waitPast('checkIn')
        add(await this.checkIn())
        add(await this.tickAndSubmit()) // H12: open-time defaults after the deposit
        await this.waitPast('deliveryBy')
        add(await this.postClaim([{ kind: 'minibar', amount: b.claim }]))
        add(await this.quorumProbe(['principal', 'counterparty'])) // H10
        add(await this.settleAgreed()) // H1
        break
      case 'unconfirmed':
        await this.waitPast('confirmBy')
        add(await this.tickAndSubmit()) // H2
        break
      case 'noshow':
        add(await this.confirm())
        await this.waitPast(this.o.timers.entryDisputeBy >= this.o.timers.checkInBy ? 'entryDisputeBy' : 'checkInBy')
        add(await this.tickAndSubmit()) // H3
        break
      case 'entryConceded':
        add(await this.confirm())
        await this.waitPast('checkIn')
        add(await this.openDispute('entry'))
        add(await this.concede()) // H4
        break
      case 'entryRuled':
        add(await this.confirm())
        await this.waitPast('checkIn')
        add(await this.openDispute('entry'))
        add(await this.postRuling(this.split(room - deposit, deposit + bond))) // the arbiter rules in time: no chargeback
        await this.waitPast('entryDisputeBy')
        add(await this.tickAndSubmit()) // H13: no-show while the entry dispute is open
        add(await this.ruling(this.split(room - deposit, deposit + bond))) // H5: downgrade, partial refund + bond back
        break
      case 'silence':
        add(await this.confirm())
        await this.waitPast('checkIn')
        add(await this.checkIn())
        await this.waitPast('disputeWindowEnds')
        add(await this.tickAndSubmit()) // H6
        break
      case 'claimUnanswered':
        add(await this.confirm())
        await this.waitPast('checkIn')
        add(await this.checkIn())
        await this.waitPast('deliveryBy')
        add(await this.postClaim([{ kind: 'minibar', amount: b.claim }]))
        await this.waitPast('disputeWindowEnds')
        add(await this.tickAndSubmit()) // H11: release refused while a claim is posted
        add(await this.ruling(this.split(room + claim, deposit - claim), { party: 'counterparty', advisory: 'ruling.default' })) // H7
        break
      case 'partialDeposit':
        add(await this.confirm())
        await this.waitPast('checkIn')
        add(await this.partialDepositRefused())
        await this.waitPast(this.o.timers.entryDisputeBy >= this.o.timers.checkInBy ? 'entryDisputeBy' : 'checkInBy')
        add(await this.tickAndSubmit()) // H15: the sweep no-show returns the partial deposit; the exact one is refused
        break
      case 'arbiterSilent':
        add(await this.confirm())
        await this.waitPast('checkIn')
        add(await this.checkIn())
        await this.waitPast('deliveryBy')
        add(await this.postClaim([{ kind: 'minibar', amount: b.claim }]))
        add(await this.openDispute('settlement'))
        add(await this.tickAndSubmit()) // H9: the claim chargeback before the ruling deadline is refused
        if (this.o.probeCosigner) add(await this.quorumProbe(['arbiter', 'cosigner'])) // H14
        await this.waitPast('disputeOpenedAt', this.rulingWindowSecs())
        add(await this.tickAndSubmit()) // H8: arbiter silent → default.chargebackClaim
        break
      case 'staySilent':
        add(await this.confirm())
        await this.waitPast('checkIn')
        add(await this.checkIn())
        add(await this.openDispute('stay')) // night 1 of 3
        await this.waitPast('disputeOpenedAt', this.rulingWindowSecs())
        add(await this.tickAndSubmit()) // H17: arbiter silent → default.chargebackStay#1
        break
    }
    return steps
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  private get bookingId(): string { return `BK-${this.id.slice(-6)}` }
  private log(msg: string): void { this.o.log?.(`${this.id || 'hotel'}: ${msg}`) }
  private must(r: SubmitResult, label: string): SubmitResult {
    this.o.onTx?.(label, r)
    if (r.final !== 'tesSUCCESS') throw new Error(`${label} failed: ${r.final} (${r.hash})`)
    return r
  }
  private track(label: string, r: SubmitResult): SubmitResult {
    this.o.onTx?.(`${this.id} ${label}`, r)
    return r
  }

  private money(v: string) { return { currency: 'RLUSD', value: v } }
  private micro(v: string): bigint { return parseAmount(v, this.asset).minor }
  private fmt(m: bigint): string { return formatAmount(new Amount('RLUSD', m), this.asset.decimals) }
  private claimTotal(): bigint { return this.claim ? this.micro((this.claim.claim as { total: { value: string } }).total.value) : 0n }

  /** close.split payouts in blueprint order: hotel (gross less fee), fee (50 bps of gross), guest. Zero legs are dropped. */
  split(toHotelGross: bigint, toGuest: bigint): Payout[] {
    const { cast } = this.o
    const fee = (toHotelGross * FEE_BPS) / 10000n
    return [
      { to: cast.hotel.address, value: toHotelGross - fee },
      { to: cast.service.address, value: fee },
      { to: cast.guest.address, value: toGuest },
    ].filter((p) => p.value > 0n).map((p) => ({ to: p.to, value: this.fmt(p.value) }))
  }

  /** A residual sweep to the guest: tfPartialPayment of whatever the fixed payouts leave in the account. */
  private sweepToGuest(): PresignPayout { return { to: this.o.cast.guest.address, partial: true } }

  /** The pinned policy's params.rulingWindow (the flow only uses it to know how long to wait). */
  private rulingWindowSecs(): number { return this.o.rulingWindowSecs ?? 60 }

  /** As the policy's def.disputeOpenedAt: the dispute's issuedAt, but no earlier than deliveryBy (settlement) / checkIn (entry, stay). */
  private disputeOpenedAt(): number {
    const d = this.dispute!
    const floor = Date.parse(this.record!.timers![(d.claim as { phase: string }).phase === 'settlement' ? 'deliveryBy' : 'checkIn'])
    return Math.max(Date.parse(d.issuedAt), floor)
  }

  private async waitUntil(ms: number): Promise<void> {
    let last = 0
    for (;;) {
      const { time } = await ledgerClock(this.o.client)
      if (time > ms) return
      if (Date.now() - last > 30_000) { this.log(`waiting ${Math.ceil((ms - time) / 1000)} s of ledger time`); last = Date.now() }
      await sleep(3000)
    }
  }

  private stmt(signer: Wallet, kind: string, type: string, subject: Json, claim: Json, engagementId = this.id): Statement {
    const t = iso(Date.now())
    const body: StatementBody = { v: 'eng.att/1', type, engagementId, subject, claim, observedAt: t, issuedAt: t, nonce: newNonce(), attester: { account: signer.address, kind } }
    return signStatement(body, signer)
  }

  /** Post = ingest; the co-signer's receipt is the poster's proof. */
  private async post(s: Statement): Promise<HotelReceipt> {
    const receipt = receiptOf(await this.o.svc.ingest(this.id, s))
    this.log(`${s.type} receipted at ${receipt.receivedAt}`)
    return receipt
  }

  /** Guest + hotel pre-sign the default in Ticket slot `slot` (an outcome, or a stay variant "<outcome>#k") and store it. */
  private async presign(slot: string, payouts: PresignPayout[]): Promise<void> {
    const { cast, fees, svc } = this.o
    const range = this.plan.slices[slot]
    if (!range) throw new Error(`no Ticket slot for ${slot} in a ${this.nights}-night deal`)
    const outcome = slot.split('#')[0]
    const tx = buildCloseBatch({
      eng: this.eng, currency: cast.currency, issuer: cast.issuer.address, payouts, deleteTo: cast.service.address,
      tickets: this.tickets.slice(range[0], range[1]), memos: [memo('eng/basis', outcome)], fees, signatures: 3,
    })
    await svc.storePresigned(this.id, slot, combine([multisignBlob(cast.guest, tx), multisignBlob(cast.hotel, tx)]))
  }

  private async balance(): Promise<string> {
    const r = await this.o.client.request({ command: 'account_lines', account: this.eng, peer: this.o.cast.issuer.address, ledger_index: 'validated' })
    return r.result.lines.find((l) => l.currency === this.o.cast.currency)?.balance ?? '0'
  }

  /** A live (Sequence + short LastLedgerSequence) close Batch, payouts in blueprint order. */
  private async liveClose(payouts: Payout[], basis: string, signatures: number, extraMemos: Json[] = []): Promise<Json> {
    const { client, cast, fees } = this.o
    const seq = Number(((await accountInfo(client, this.eng))!.account_data as Json).Sequence)
    const order = [cast.hotel.address, cast.service.address, cast.guest.address]
    const sorted = [...payouts].sort((x, y) => order.indexOf(x.to) - order.indexOf(y.to))
    return buildCloseBatch({
      eng: this.eng, currency: cast.currency, issuer: cast.issuer.address, payouts: sorted, deleteTo: cast.service.address,
      seq, lastLedgerSequence: (await currentLedger(client)) + 20, memos: [memo('eng/basis', basis), ...extraMemos], fees, signatures,
    })
  }

  /** Ask the co-signer for `stage` on a tx signed by `wallets`; on SIGN submit with its signature. */
  private async cosigned(step: string, stage: string, tx: Json, wallets: Wallet[]): Promise<HotelStepResult> {
    const blobs = wallets.map((w) => multisignBlob(w, tx))
    const d = await this.o.svc.decide({ engagementId: this.id, stage, txBlob: blobs[0] })
    const res = this.decided(stage, d, step)
    if (d.decision !== 'SIGN' || !d.signerBlob) return res
    const r = this.track(step, await submit(this.o.client, combine([...blobs, d.signerBlob])))
    return { ...res, ...(await this.closeResult(r, tx)) }
  }

  private decided(stage: string, d: DecideResponse | TickResult, step = stage): HotelStepResult {
    const results = ((d.record.claim as Json).results ?? []) as Array<{ id: string; result: string; reason?: string }>
    return { step, stage, decision: d.decision, failing: d.failing, rules: results.map(({ id, result, reason }) => ({ id, result, ...(reason ? { reason } : {}) })) }
  }

  /** Outer result, downgraded unless every inner transaction applied with tesSUCCESS. */
  private async batchFinal(r: SubmitResult, tx: Json): Promise<string> {
    if (r.final !== 'tesSUCCESS') return r.final
    const inn = await innerResults(this.o.client, tx)
    return inn.every((i) => i.applied && i.result === 'tesSUCCESS') ? 'tesSUCCESS' : `${r.final} (inner ${inn.map((i) => i.result ?? 'not applied').join(',')})`
  }

  /** Final result of a close Batch plus the payouts actually delivered (from validated inner Payments). */
  private async closeResult(r: SubmitResult, tx: Json): Promise<Pick<HotelStepResult, 'tx' | 'final' | 'payouts'>> {
    const final = await this.batchFinal(r, tx)
    const payouts: Payout[] = []
    if (final === 'tesSUCCESS') {
      for (const i of await innerResults(this.o.client, tx)) {
        const t = await lookupTx(this.o.client, i.hash)
        const txj = (t?.tx_json ?? t) as Json | undefined
        if (txj?.TransactionType !== 'Payment') continue
        const d = ((t!.meta as Json).delivered_amount ?? txj.DeliverMax ?? txj.Amount) as { value?: string }
        payouts.push({ to: String(txj.Destination), value: String(d?.value) })
      }
    }
    return { tx: r.hash, final, payouts }
  }
}

/** The fields of a co-signer receipt (cosigner.receipt/1) a step carries. */
export function receiptOf(r: Receipt): HotelReceipt {
  const subject = r.statement.subject as { statementId: string; statementType: string }
  const claim = r.statement.claim as { receivedAt: string; ledgerIndex: number }
  return { statementId: subject.statementId, statementType: subject.statementType, receivedAt: claim.receivedAt, ledgerIndex: claim.ledgerIndex }
}

export function describeStep(s: HotelStepResult): string {
  return [s.step, s.decision, s.failing?.length ? `[${s.failing.join(',')}]` : '', s.final, s.payouts?.length ? s.payouts.map((p) => `${p.value}→${p.to.slice(0, 6)}…`).join(' ') : '', s.tx ? `tx ${s.tx}` : '']
    .filter(Boolean).join(' · ')
}
