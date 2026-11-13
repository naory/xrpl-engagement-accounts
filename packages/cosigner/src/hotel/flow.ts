// HotelFlow: drives one hotel@2 stay-escrow engagement on a live XRPL network through the policy
// co-signer (spec §5, §7.1). One instance per engagement account; `run(path)` plays a whole path.
// Timers are seconds from the open ledger's closeTime and every wait is on validated-ledger closeTime,
// which is the co-signer's clock.
import xrpl from 'xrpl'
import { Amount, formatAmount, newNonce, parseAmount, signStatement, type AssetDef, type Statement, type StatementBody } from '@eng/core'
import type { EngagementRecord } from '@eng/policy'
import type { CosignerService, DecideResponse, TickResult } from '../service.ts'
import {
  ASF_DISABLE_MASTER, TF_ALL_OR_NOTHING, TF_SET_NO_RIPPLE,
  accountInfo, addBatchSigner, batchFee, buildCloseBatch, buildOpenBatch, combine, currentLedger, hex, inner, innerResults, iou,
  lookupTx, memo, multisignBlob, sendSimple, sleep, submit, type Fees, type SubmitResult,
} from '../xrpl-io.ts'

type Json = Record<string, unknown>
type Client = InstanceType<typeof xrpl.Client>
type Wallet = InstanceType<typeof xrpl.Wallet>

export type HotelPath = 'happy' | 'unconfirmed' | 'noshow' | 'entryConceded' | 'entryRuled' | 'silence' | 'claimUnanswered' | 'backupRuling'
export const HOTEL_PATHS: HotelPath[] = ['happy', 'unconfirmed', 'noshow', 'entryConceded', 'entryRuled', 'silence', 'claimUnanswered', 'backupRuling']

export interface HotelStepResult {
  step: string
  stage?: string
  decision?: 'SIGN' | 'REFUSE'
  failing?: string[]
  rules?: Array<{ id: string; result: string; reason?: string }>
  tx?: string
  final?: string
  payouts?: Array<{ to: string; value: string }>
}

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
  /** Signers only (never funded). */
  arbiter: Wallet
  backupArbiter: Wallet
  /** Pre-creates engagement accounts; the fee account and AccountDelete destination. */
  service: Wallet
  /** Hex currency code of the booking asset (RLUSD). */
  currency: string
}

export interface HotelBooking { room: string; deposit: string; bond: string; claim: string; maxDeposit: string }
export const DEMO_HOTEL_BOOKING: HotelBooking = { room: '400', deposit: '100', bond: '10', claim: '20', maxDeposit: '200' }

/** Ticket slices of the 15 reserved at open (spec §5.4): outer + inner Tickets of each pre-signed default. */
const TICKETS = { 'default.refund': [0, 4], 'default.noshow': [4, 9], 'default.release': [9, 15] } as const
const TICKET_COUNT = 15
/** Sequence numbers the open Batch consumes (outer, SignerListSet, TicketCreate + its Tickets, SetRegularKey). */
export const OPEN_SEQUENCES = 4 + TICKET_COUNT
const ACCOUNT_DELETE_MIN_AGE = 256
const FEE_BPS = 50n
const TEMPLATE = 'settlement-vault/hotel@2'

type Role = 'principal' | 'counterparty' | 'arbiter' | 'backupArbiter'
type Payout = { to: string; value: string }

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
  }) {
    this.asset = { code: 'RLUSD', kind: 'IOU', currency: o.cast.currency, issuer: o.cast.issuer.address, decimals: 6 }
  }

  get engagementId(): string { return this.id }
  get account(): string { return this.eng }
  get booking(): HotelBooking { return this.o.booking ?? DEMO_HOTEL_BOOKING }

  // ── Setup ────────────────────────────────────────────────────────────────
  /** Pre-create `n` engagement accounts: XRP for reserves, the asset trust line, service RegularKey, master disabled. */
  async precreate(n: number): Promise<Wallet[]> {
    const { client, fees, cast } = this.o
    const drops = fees.reserveBase + fees.inc * (2 + TICKET_COUNT) + 1_000_000
    return Promise.all(Array.from({ length: n }, async () => {
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
  async waitUntilAged(accounts: string[], headroom = OPEN_SEQUENCES): Promise<void> {
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

  // ── Steps ────────────────────────────────────────────────────────────────
  /** Open Batch (guest funds the room, SignerList, 15 Tickets, RegularKey cleared), register, pre-sign the open-time defaults. */
  async open(eng: Wallet, path: HotelPath): Promise<HotelStepResult> {
    const { client, fees, cast, svc } = this.o
    this.eng = eng.address
    this.id = `eng_hotel_${path}_${this.o.runId ?? Date.now().toString(36)}`
    const { r, tx } = await withLock(cast.guest.address, async () => {
      const seq = Number(((await accountInfo(client, eng.address))!.account_data as Json).Sequence)
      const funderSeq = Number(((await accountInfo(client, cast.guest.address))!.account_data as Json).Sequence)
      const built = buildOpenBatch({
        eng: eng.address, funder: cast.guest.address, currency: cast.currency, issuer: cast.issuer.address, amount: this.booking.room,
        signerEntries: [[cast.guest.address, 3], [cast.hotel.address, 3], [cast.arbiter.address, 4], [cast.backupArbiter.address, 2], [svc.address, 2]],
        quorum: 7, seq, funderSeq, ticketCount: TICKET_COUNT, memos: [memo('eng/open', `${this.id}|template=${TEMPLATE}`)], fees,
      })
      this.tickets = built.tickets
      addBatchSigner(cast.guest, built.tx)
      return { r: this.track('open', await submit(client, cast.service.sign(built.tx as never).tx_blob)), tx: built.tx }
    })
    const final = await this.batchFinal(r, tx)
    if (final !== 'tesSUCCESS') return { step: 'open', tx: r.hash, final }

    this.t0 = (await ledgerClock(client, r.ledger)).time
    const t = this.o.timers
    const at = (s: number) => iso(this.t0 + s * 1000)
    const day = (ms: number) => iso(ms).slice(0, 10)
    this.mandate = this.stmt(cast.guest, 'PRINCIPAL', 'party.mandate/1', { mandateId: `mnd_${path}` }, {
      purpose: 'lodging', expires: at(86400),
      constraints: { city: 'Lisbon', country: 'PT', checkIn: day(this.t0), checkOut: day(this.t0 + 86400_000), maxTotal: this.money('450'), maxDeposit: this.money(this.booking.maxDeposit) },
    })
    this.record = {
      engagementId: this.id, template: TEMPLATE, account: eng.address, asset: 'RLUSD',
      parties: { principal: cast.guest.address, counterparty: cast.hotel.address, arbiter: cast.arbiter.address, backupArbiter: cast.backupArbiter.address, cosigner: svc.address },
      fee: { bps: Number(FEE_BPS), to: cast.service.address }, deleteTo: cast.service.address,
      amount: { asset: 'RLUSD', value: this.booking.room },
      timers: {
        openedAt: at(0), confirmBy: at(t.confirmBy), checkIn: at(t.checkIn), checkInBy: at(t.checkInBy), entryDisputeBy: at(t.entryDisputeBy),
        deliveryBy: at(t.deliveryBy), claimBy: at(t.claimBy), disputeWindowEnds: at(t.disputeWindowEnds),
      },
      state: 'OPEN', consumed: [], mandateId: this.mandate.id,
      ...(this.o.policyLayers ? { policyLayers: this.o.policyLayers } : {}),
    }
    svc.register(this.record, this.mandate)
    this.presign('default.refund', [{ to: cast.guest.address, value: this.booking.room }])
    this.presign('default.noshow', this.split(this.micro(this.booking.room), 0n))
    this.log(`opened ${this.id} at ${eng.address} (t0 ${at(0)}); default.refund + default.noshow pre-signed`)
    return { step: 'open', tx: r.hash, final }
  }

  /** Hotel posts its confirmation; advisory `confirm` decision. */
  async confirm(): Promise<HotelStepResult> {
    const b = this.booking
    const m = this.mandate!.claim as { constraints: { city: string; checkIn: string; checkOut: string } }
    await this.post(this.stmt(this.o.cast.hotel, 'COUNTERPARTY', 'party.confirmation/1', { bookingId: this.bookingId }, {
      mandateHash: this.mandate!.id, bookingId: this.bookingId, property: 'Casa Alfama', city: m.constraints.city, country: 'PT',
      checkIn: m.constraints.checkIn, checkOut: m.constraints.checkOut, total: this.money(b.room), deposit: this.money(b.deposit),
    }))
    return this.decided('confirm', await this.o.svc.decide({ engagementId: this.id, stage: 'confirm' }))
  }

  /** Spec §5.3 order: check-in attestation → guest + hotel pre-sign default.release → stored → guest pays the deposit → `checkin`. */
  async checkIn(): Promise<HotelStepResult[]> {
    const { cast, client } = this.o
    const out: HotelStepResult[] = []
    await this.post(this.stmt(cast.hotel, 'COUNTERPARTY', 'party.checkin/1', { bookingId: this.bookingId }, { status: 'checked_in', room: '204', deposit: this.money(this.booking.deposit) }))
    out.push({ step: 'checkin attestation', final: 'RECEIPTED' })
    this.presign('default.release', this.split(this.micro(this.booking.room), this.micro(this.booking.deposit)))
    out.push({ step: 'default.release pre-signed', final: 'STORED' })
    const r = await withLock(cast.guest.address, async () => this.track('deposit', await sendSimple(client, cast.guest, {
      TransactionType: 'Payment', Account: cast.guest.address, Destination: this.eng, Amount: iou(cast.currency, cast.issuer.address, this.booking.deposit), Memos: [memo('eng/deposit', this.id)],
    })))
    out.push({ step: 'deposit', tx: r.hash, final: r.final })
    this.checkedIn = true
    out.push(this.decided('checkin', await this.o.svc.decide({ engagementId: this.id, stage: 'checkin' })))
    return out
  }

  /** Guest's single-account Batch: ENG/DISPUTE Credential on the engagement account + the bond; then the dispute attestation. */
  async openDispute(phase: 'entry' | 'settlement'): Promise<HotelStepResult> {
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
      phase, reason: phase === 'entry' ? 'room not as booked' : 'claim disputed', bond: this.money(this.booking.bond), evidenceHashes: [],
    })
    await this.post(this.dispute)
    return { step: `dispute (${phase})`, tx: r.hash, final }
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
    await this.post(this.claim)
    return { step: 'claim', final: 'RECEIPTED' }
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
   * A ruling closes the account. Primary arbiter: arbiter + one party (no co-signer; an optional advisory stage is
   * recorded, e.g. `ruling.default`). Backup arbiter: backup + one party + co-signer (`ruling.backup`).
   */
  async ruling(by: 'arbiter' | 'backupArbiter', payouts: Payout[], opts: { party?: 'principal' | 'counterparty'; advisory?: string } = {}): Promise<HotelStepResult> {
    const { cast, svc } = this.o
    const arb = by === 'arbiter' ? cast.arbiter : cast.backupArbiter
    let st = this.rulings.get(by)
    if (!st) {
      st = this.stmt(arb, 'ARBITER', 'party.ruling/1', { bookingId: this.bookingId }, { payouts, rationale: by === 'arbiter' ? 'primary ruling' : 'backup ruling after the primary ruling window' })
      await this.post(st)
      this.rulings.set(by, st)
    }
    const party = opts.party === 'counterparty' ? cast.hotel : cast.guest
    if (by === 'backupArbiter') {
      const tx = await this.liveClose(payouts, 'ruling.backup', 3)
      return this.cosigned('ruling:backupArbiter', 'ruling.backup', tx, [arb, party])
    }
    const tx = await this.liveClose(payouts, 'settle.ruling', 2)
    const blobs = [multisignBlob(arb, tx), multisignBlob(party, tx)]
    const adv = opts.advisory ? await svc.decide({ engagementId: this.id, stage: opts.advisory, txBlob: blobs[0] }) : undefined
    const r = this.track('ruling (arbiter)', await submit(this.o.client, combine(blobs)))
    return { ...(adv ? this.decided(opts.advisory!, adv) : {}), ...(await this.closeResult(r, tx)), step: 'ruling:arbiter' }
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
    const w: Record<Role, Wallet> = { principal: cast.guest, counterparty: cast.hotel, arbiter: cast.arbiter, backupArbiter: cast.backupArbiter }
    const tx = await this.liveClose([{ to: cast.guest.address, value: await this.balance() }], 'probe', roles.length)
    const r = this.track(`probe ${roles.join('+')}`, await submit(this.o.client, combine(roles.map((x) => multisignBlob(w[x], tx))), { waitLedgers: 5 }))
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
        await this.waitPast('entryDisputeBy')
        add(await this.tickAndSubmit()) // H13: no-show while the entry dispute is open
        add(await this.ruling('arbiter', this.split(room - deposit, deposit + bond))) // H5: downgrade, partial refund + bond back
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
        add(await this.ruling('arbiter', this.split(room + claim, deposit - claim), { party: 'counterparty', advisory: 'ruling.default' })) // H7
        break
      case 'backupRuling': {
        add(await this.confirm())
        await this.waitPast('checkIn')
        add(await this.checkIn())
        await this.waitPast('deliveryBy')
        add(await this.postClaim([{ kind: 'minibar', amount: b.claim }]))
        add(await this.openDispute('settlement'))
        const payouts = this.split(room, deposit + bond)
        add(await this.ruling('backupArbiter', payouts)) // H9: before rulingDueBy
        add(await this.quorumProbe(['arbiter', 'backupArbiter'])) // H14
        await this.waitPast('disputeOpenedAt', this.rulingWindowSecs())
        add(await this.ruling('backupArbiter', payouts)) // H8
        break
      }
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

  /** The pinned policy's params.rulingWindow (the flow only uses it to know how long to wait). */
  private rulingWindowSecs(): number { return this.o.rulingWindowSecs ?? 60 }

  /** As the policy's def.disputeOpenedAt: the dispute's issuedAt, but no earlier than deliveryBy (settlement) / checkIn (entry). */
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

  private stmt(signer: Wallet, kind: string, type: string, subject: Json, claim: Json): Statement {
    const t = iso(Date.now())
    const body: StatementBody = { v: 'eng.att/1', type, engagementId: this.id, subject, claim, observedAt: t, issuedAt: t, nonce: newNonce(), attester: { account: signer.address, kind } }
    return signStatement(body, signer)
  }

  /** Post = ingest; the co-signer's receipt is the poster's proof. */
  private async post(s: Statement): Promise<void> {
    const r = await this.o.svc.ingest(this.id, s)
    this.log(`${s.type} receipted at ${String((r.statement.claim as Json).receivedAt)}`)
  }

  private presign(outcome: keyof typeof TICKETS, payouts: Payout[]): void {
    const { cast, fees, svc } = this.o
    const [a, b] = TICKETS[outcome]
    const tx = buildCloseBatch({
      eng: this.eng, currency: cast.currency, issuer: cast.issuer.address, payouts, deleteTo: cast.service.address,
      tickets: this.tickets.slice(a, b), memos: [memo('eng/basis', outcome)], fees, signatures: 3,
    })
    svc.storePresigned(this.id, outcome, combine([multisignBlob(cast.guest, tx), multisignBlob(cast.hotel, tx)]))
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

export function describeStep(s: HotelStepResult): string {
  return [s.step, s.decision, s.failing?.length ? `[${s.failing.join(',')}]` : '', s.final, s.payouts?.length ? s.payouts.map((p) => `${p.value}→${p.to.slice(0, 6)}…`).join(' ') : '', s.tx ? `tx ${s.tx}` : '']
    .filter(Boolean).join(' · ')
}
