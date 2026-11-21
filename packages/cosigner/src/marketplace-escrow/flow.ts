// MarketplaceEscrowFlow: one marketplace-escrow@1 deal on a live XRPL network (spec §6–§7).
// Ticket plan is flat: default.refund 4, default.release 5, default.releaseSweep 6. Pre-create funding
// is the reserve plus 1 XRP, the same pattern as hotel. No Testnet script lives here; that is the demo.
import xrpl from 'xrpl'
import { Amount, formatAmount, newNonce, parseAmount, signStatement, type AssetDef, type Statement, type StatementBody } from '@eng/core'
import type { EngagementRecord } from '@eng/policy'
import templateJson from '../../../../templates/marketplace-escrow@1.json' with { type: 'json' }
import type { CosignerService, Receipt } from '../service.ts'
import {
  ASF_DISABLE_MASTER, TF_ALL_OR_NOTHING, TF_SET_NO_RIPPLE,
  accountInfo, addBatchSigner, batchFee, buildCloseBatch, buildOpenBatch, combine, currentLedger, hex, inner, innerResults, iou,
  lookupTx, memo, multisignBlob, sendSimple, submit, type Fees, type SubmitResult,
} from '../xrpl-io.ts'

type Json = Record<string, unknown>
type Client = InstanceType<typeof xrpl.Client>
type Wallet = InstanceType<typeof xrpl.Wallet>
type Payout = { to: string; value?: string; partial?: boolean }

const TEMPLATE = 'settlement-vault/marketplace-escrow@1'
const FEE_BPS = 50

export interface MarketplaceTicketPlan {
  slices: Record<string, readonly [number, number]>
  count: number
}

/** 15 Tickets: refund 4, exact release 5, release-with-sweep 6. */
export function marketplaceTickets(): MarketplaceTicketPlan {
  const sizes: Array<[string, number]> = [
    ['default.refund', 4],
    ['default.release', 5],
    ['default.releaseSweep', 6],
  ]
  const slices: Record<string, readonly [number, number]> = {}
  let at = 0
  for (const [outcome, n] of sizes) { slices[outcome] = [at, at + n]; at += n }
  return { slices, count: at }
}

/** Seller receives price − fee, the fee account receives the bps. Zero legs are dropped. */
export function marketplaceReleasePayouts(price: string, feeBps: number, seller: string, feeTo: string): Array<{ to: string; value: string }> {
  const asset: AssetDef = { code: 'RLUSD', kind: 'IOU', currency: 'RLUSD', issuer: '', decimals: 6 }
  const gross = parseAmount(price, asset).minor
  const fee = (gross * BigInt(feeBps)) / 10_000n
  return [
    { to: seller, value: formatAmount(new Amount('RLUSD', gross - fee), 6) },
    { to: feeTo, value: formatAmount(new Amount('RLUSD', fee), 6) },
  ].filter((p) => p.value !== '0' && !p.value.startsWith('-'))
}

export interface MarketplaceCast {
  issuer: Wallet
  buyer: Wallet
  seller: Wallet
  arbiter: Wallet
  accreditor: Wallet
  carrier: Wallet
  service: Wallet
  currency: string
}

export interface MarketplaceStepResult {
  step: string
  stage?: string
  decision?: 'SIGN' | 'REFUSE'
  failing?: string[]
  tx?: string
  final?: string
  payouts?: Array<{ to: string; value: string }>
  receipt?: { statementId: string; statementType: string; receivedAt: string; ledgerIndex: number }
}

const locks = new Map<string, Promise<unknown>>()
function withLock<T>(account: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(account) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  locks.set(account, run.catch(() => undefined))
  return run
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

export class MarketplaceEscrowFlow {
  private id = ''
  private eng = ''
  private record: EngagementRecord | null = null
  private mandate: Statement | null = null
  private tickets: number[] = []
  private readonly plan = marketplaceTickets()
  private readonly asset: AssetDef
  private readonly price: string

  constructor(private readonly o: {
    client: Client
    svc: CosignerService
    cast: MarketplaceCast
    fees: Fees
    price?: string
    log?: (line: string) => void
  }) {
    this.price = o.price ?? '2.00'
    this.asset = { code: 'RLUSD', kind: 'IOU', currency: o.cast.currency, issuer: o.cast.issuer.address, decimals: 6 }
  }

  get engagementId(): string { return this.id }
  get account(): string { return this.eng }

  /** XRP a pre-created account needs: base reserve, trust line + SignerList, 15 Tickets, 1 XRP for fees. */
  static precreateDrops(fees: Fees): number {
    return fees.reserveBase + fees.inc * (2 + marketplaceTickets().count) + 1_000_000
  }

  /** Fund one engagement account, set the RLUSD trust line, point RegularKey at the service, and disable master. */
  async precreate(): Promise<Wallet> {
    const { client, fees, cast } = this.o
    const drops = MarketplaceEscrowFlow.precreateDrops(fees)
    const eng = xrpl.Wallet.generate()
    await withLock(cast.service.address, async () => this.must(await sendSimple(client, cast.service, {
      TransactionType: 'Payment', Account: cast.service.address, Destination: eng.address, Amount: String(drops),
    }), 'pre-create fund'))
    this.must(await sendSimple(client, eng, {
      TransactionType: 'TrustSet', Account: eng.address, LimitAmount: iou(cast.currency, cast.issuer.address, '1000000000'), Flags: TF_SET_NO_RIPPLE,
    }), 'pre-create trust line')
    this.must(await sendSimple(client, eng, { TransactionType: 'SetRegularKey', Account: eng.address, RegularKey: cast.service.address }), 'pre-create SetRegularKey')
    this.must(await sendSimple(client, eng, { TransactionType: 'AccountSet', Account: eng.address, SetFlag: ASF_DISABLE_MASTER }), 'pre-create disable master')
    return eng
  }

  /**
   * Register, open the account (SignerList, Tickets, funding, RegularKey removed), and pre-sign the three defaults.
   * `t0` is the open ledger's close time in ms.
   */
  async open(eng: Wallet, t0: number): Promise<MarketplaceStepResult> {
    const { client, svc, cast, fees } = this.o
    this.eng = eng.address
    this.id = `eng_${eng.address.slice(1, 9)}`
    this.mandate = this.mandateFor()
    this.record = this.recordFor(t0)
    try {
      await svc.register(this.record, this.mandate)
    } catch (e) {
      return { step: 'register', final: (e as Error).message }
    }
    const opened = await withLock(eng.address, async () => {
      const seq = Number(((await accountInfo(client, eng.address))!.account_data as Json).Sequence)
      const funderSeq = Number(((await accountInfo(client, cast.buyer.address))!.account_data as Json).Sequence)
      const built = buildOpenBatch({
        eng: eng.address, funder: cast.buyer.address, currency: cast.currency, issuer: cast.issuer.address, amount: this.price,
        signerEntries: [[cast.buyer.address, 3], [cast.seller.address, 3], [cast.arbiter.address, 4], [svc.address, 2]],
        quorum: 7, seq, funderSeq, ticketCount: this.plan.count, memos: [memo('eng/open', `${this.id}|template=${TEMPLATE}`)], fees,
      })
      this.tickets = built.tickets
      addBatchSigner(cast.buyer, built.tx)
      return { r: await submit(client, cast.service.sign(built.tx as never).tx_blob), tx: built.tx }
    })
    const final = await this.batchFinal(opened.r, opened.tx)
    if (final !== 'tesSUCCESS') return { step: 'open', tx: opened.r.hash, final }
    const release = marketplaceReleasePayouts(this.price, FEE_BPS, cast.seller.address, cast.service.address)
    await this.presign('default.refund', [{ to: cast.buyer.address, partial: true }])
    await this.presign('default.release', release)
    await this.presign('default.releaseSweep', [...release, { to: cast.buyer.address, partial: true }])
    this.o.log?.(`${this.id}: opened ${eng.address} with ${this.plan.count} Tickets`)
    return { step: 'open', tx: opened.r.hash, final }
  }

  /** Carrier posts shipping.shipped/1. */
  async ship(observedAt?: string): Promise<MarketplaceStepResult> {
    const at = observedAt ?? iso(Date.now())
    const s = this.stmt(this.o.cast.carrier, 'SHIPPING', 'shipping.shipped/1', { item: 'sku-1' }, { status: 'shipped' }, at)
    const receipt = await this.post(s)
    return { step: 'ship', final: 'RECEIPTED', receipt }
  }

  /** Buyer posts the ENG/DISPUTE credential and the bond, then the dispute statement. */
  async openDispute(bond: string): Promise<MarketplaceStepResult> {
    const { cast, client, fees } = this.o
    const buyer = cast.buyer
    const { r, tx } = await withLock(buyer.address, async () => {
      const s = Number(((await accountInfo(client, buyer.address))!.account_data as Json).Sequence)
      const raw = [
        inner({ TransactionType: 'CredentialCreate', Account: buyer.address, Subject: this.eng, CredentialType: hex('ENG/DISPUTE') }, { Sequence: s + 1 }),
        inner({ TransactionType: 'Payment', Account: buyer.address, Destination: this.eng, Amount: iou(cast.currency, cast.issuer.address, bond), Memos: [memo('eng/bond', this.id)] }, { Sequence: s + 2 }),
      ]
      const tx: Json = { TransactionType: 'Batch', Account: buyer.address, Flags: TF_ALL_OR_NOTHING, Sequence: s, LastLedgerSequence: (await currentLedger(client)) + 20, RawTransactions: raw }
      tx.Fee = batchFee({ base: fees.base, inc: fees.inc, innerTxs: raw, signatures: 1, headroom: 2 })
      return { r: await submit(client, buyer.sign(tx as never).tx_blob), tx }
    })
    const final = await this.batchFinal(r, tx)
    if (final !== 'tesSUCCESS') return { step: 'dispute', tx: r.hash, final }
    const at = iso(Date.now())
    const receipt = await this.post(this.stmt(buyer, 'PRINCIPAL', 'party.dispute/1', { item: 'sku-1' }, { reason: 'not received', bond: { currency: 'RLUSD', value: bond } }, at))
    return { step: 'dispute', tx: r.hash, final, receipt }
  }

  /** Buyer confirms: seller + fee, any extra back to the buyer. Buyer, seller, and the co-signer. */
  async releaseConfirm(): Promise<MarketplaceStepResult> {
    const { cast } = this.o
    const payouts: Payout[] = [...marketplaceReleasePayouts(this.price, FEE_BPS, cast.seller.address, cast.service.address), { to: cast.buyer.address, partial: true }]
    const tx = await this.liveClose(payouts, 'release.confirm', 3)
    return this.cosigned('release.confirm', tx, [cast.buyer, cast.seller])
  }

  /** Mutual cancel: the whole balance back to the buyer. Buyer, seller, and the co-signer. */
  async refundAgreed(): Promise<MarketplaceStepResult> {
    const { cast } = this.o
    const tx = await this.liveClose([{ to: cast.buyer.address, value: await this.balance() }], 'refund.agreed', 3)
    return this.cosigned('refund.agreed', tx, [cast.buyer, cast.seller])
  }

  /** tick() the co-signer and submit every completed default. */
  async tickAndSubmit(): Promise<MarketplaceStepResult[]> {
    const out: MarketplaceStepResult[] = []
    for (const t of await this.o.svc.tick(this.id)) {
      const res: MarketplaceStepResult = { step: `tick ${t.outcome}`, stage: t.stage, decision: t.decision, failing: t.failing }
      if (t.decision === 'SIGN' && t.blob) {
        const r = await submit(this.o.client, t.blob)
        Object.assign(res, await this.closeResult(r, xrpl.decode(t.blob) as Json))
      }
      out.push(res)
    }
    return out
  }

  private mandateFor(): Statement {
    const at = iso(Date.now())
    return this.stmt(this.o.cast.buyer, 'PRINCIPAL', 'party.mandate/1', { mandateId: `mnd_${this.id}` }, {
      maximum: this.price, payee: this.o.cast.seller.address, expires: at,
    }, at)
  }

  private recordFor(t0: number): EngagementRecord {
    const { cast, svc } = this.o
    const timers = (templateJson as { timers: Record<string, { durationSecs: number }> }).timers
    const at = (name: string) => iso(t0 + timers[name].durationSecs * 1000)
    return {
      engagementId: this.id, template: TEMPLATE, account: this.eng, asset: 'RLUSD',
      parties: { principal: cast.buyer.address, counterparty: cast.seller.address, arbiter: cast.arbiter.address, cosigner: svc.address },
      fee: { bps: FEE_BPS, to: cast.service.address }, deleteTo: cast.service.address,
      amount: { asset: 'RLUSD', value: this.price },
      timers: { open: iso(t0), shipBy: at('shipBy'), inspectBy: at('inspectBy') },
      attesters: { shipping: { accounts: [cast.carrier.address], kind: 'SHIPPING', types: ['shipping.shipped/1'] } },
      state: 'OPEN', consumed: [], mandateId: this.mandate!.id,
      trust: { 'arbiter.accreditor': cast.accreditor.address, 'rlusd.issuer': cast.issuer.address },
    }
  }

  private async presign(outcome: string, payouts: Payout[]): Promise<void> {
    const { cast, fees, svc } = this.o
    const range = this.plan.slices[outcome]
    if (!range) throw new Error(`no Ticket slot for ${outcome}`)
    const tx = buildCloseBatch({
      eng: this.eng, currency: cast.currency, issuer: cast.issuer.address, payouts, deleteTo: cast.service.address,
      tickets: this.tickets.slice(range[0], range[1]), memos: [memo('eng/basis', outcome)], fees, signatures: 3,
    })
    await svc.storePresigned(this.id, outcome, combine([multisignBlob(cast.buyer, tx), multisignBlob(cast.seller, tx)]))
  }

  private async liveClose(payouts: Payout[], basis: string, signatures: number): Promise<Json> {
    const { client, cast, fees } = this.o
    const seq = Number(((await accountInfo(client, this.eng))!.account_data as Json).Sequence)
    return buildCloseBatch({
      eng: this.eng, currency: cast.currency, issuer: cast.issuer.address, payouts, deleteTo: cast.service.address,
      seq, lastLedgerSequence: (await currentLedger(client)) + 20, memos: [memo('eng/basis', basis)], fees, signatures,
    })
  }

  private async cosigned(stage: string, tx: Json, signers: Wallet[]): Promise<MarketplaceStepResult> {
    const { svc } = this.o
    const blobs = signers.map((w) => multisignBlob(w, tx))
    const d = await svc.decide({ engagementId: this.id, stage, txBlob: blobs[0] })
    if (d.decision !== 'SIGN' || !d.signerBlob) return { step: stage, stage, decision: d.decision, failing: d.failing }
    const r = await submit(this.o.client, combine([...blobs, d.signerBlob]))
    return { step: stage, stage, decision: d.decision, failing: d.failing, ...(await this.closeResult(r, tx)) }
  }

  private async balance(): Promise<string> {
    const r = await this.o.client.request({ command: 'account_lines', account: this.eng, peer: this.o.cast.issuer.address, ledger_index: 'validated' })
    return r.result.lines.find((l) => l.currency === this.o.cast.currency)?.balance ?? '0'
  }

  private stmt(signer: Wallet, kind: string, type: string, subject: Json, claim: Json, at: string): Statement {
    const body: StatementBody = {
      v: 'eng.att/1', type, engagementId: this.id, subject, claim, observedAt: at, issuedAt: at, nonce: newNonce(),
      attester: { account: signer.address, kind },
    }
    return signStatement(body, signer)
  }

  private async post(s: Statement): Promise<NonNullable<MarketplaceStepResult['receipt']>> {
    const r: Receipt = await this.o.svc.ingest(this.id, s)
    const subject = r.statement.subject as { statementId: string; statementType: string }
    const claim = r.statement.claim as { receivedAt: string; ledgerIndex: number }
    return { statementId: subject.statementId, statementType: subject.statementType, receivedAt: claim.receivedAt, ledgerIndex: claim.ledgerIndex }
  }

  private must(r: SubmitResult, label: string): SubmitResult {
    if (r.final !== 'tesSUCCESS') throw new Error(`${label} failed: ${r.final} (${r.hash})`)
    return r
  }

  private async batchFinal(r: SubmitResult, tx: Json): Promise<string> {
    if (r.final !== 'tesSUCCESS') return r.final
    const inn = await innerResults(this.o.client, tx)
    return inn.every((i) => i.applied && i.result === 'tesSUCCESS') ? 'tesSUCCESS' : `${r.final} (inner ${inn.map((i) => i.result ?? 'not applied').join(',')})`
  }

  private async closeResult(r: SubmitResult, tx: Json): Promise<Pick<MarketplaceStepResult, 'tx' | 'final' | 'payouts'>> {
    const final = await this.batchFinal(r, tx)
    const payouts: Array<{ to: string; value: string }> = []
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
