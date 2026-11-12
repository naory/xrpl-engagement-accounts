// Facts derived from the proposed transaction and the ledger snapshot. These are the "trusted
// computing base" behind the helper functions rules call (tx.*, ledger.*, history.*, inflight.*).
import { createHash } from 'node:crypto'
import { Amount, formatAmount, parseAmount, sha256Jcs, zero, type AssetDef, type Template } from '@eng/core'
import type { EngagementRecord, InflightEntry, LedgerSnapshot } from './types.ts'
import { toCel } from './convert.ts'

export const TF_ALL_OR_NOTHING = 0x00010000
export const TF_BATCH_MODES = 0x00010000 | 0x00020000 | 0x00040000 | 0x00080000
export const TF_PARTIAL_PAYMENT = 0x00020000
/** XRPL: AccountDelete requires the account's Sequence + 256 <= current ledger index. */
export const ACCOUNT_DELETE_MIN_AGE = 256

export function hexToUtf8(h: unknown): string {
  return typeof h === 'string' ? Buffer.from(h, 'hex').toString('utf8') : ''
}

type Json = Record<string, unknown>

export interface Payout {
  to: string
  asset: string
  value: string
  amount: Amount
  partial: boolean
  issuer: string | null
  issuerValid: boolean
}

export class Assets {
  constructor(readonly defs: Record<string, AssetDef>) {}
  get(code: string): AssetDef {
    const d = this.defs[code]
    if (!d) throw new Error(`unknown asset ${code}`)
    return d
  }
  /** Map an XRPL Amount field to (code, value, issuer). */
  fromXrpl(a: unknown): { code: string; value: string; issuer: string | null; known: boolean } {
    if (typeof a === 'string') return { code: 'XRP', value: formatAmount(new Amount('XRP', BigInt(a)), 6), issuer: null, known: Boolean(this.defs.XRP) }
    const o = a as { currency: string; issuer: string; value: string }
    const def = Object.values(this.defs).find((d) => d.kind === 'IOU' && d.currency.toUpperCase() === o.currency.toUpperCase())
    return { code: def?.code ?? o.currency, value: o.value, issuer: o.issuer, known: Boolean(def) }
  }
  amount(code: string, value: string): Amount {
    return parseAmount(value, this.get(code))
  }
}

/** The proposed transaction as rules see it (`tx`). */
export class TxFacts {
  readonly raw: Json
  readonly type: string
  readonly account: string
  readonly fee: bigint
  readonly flags: bigint
  readonly hasLastLedgerSequence: boolean
  readonly lastLedgerSequence: bigint
  readonly usesTicket: boolean
  readonly isBatch: boolean
  /** CEL view (integers as BigInt). */
  readonly inner: unknown[]
  /** Raw XRPL JSON of the inner transactions (or [tx] for a non-Batch). */
  readonly innerRaw: Json[]
  readonly payouts: Payouts
  readonly memos: Record<string, string>

  constructor(tx: Json, private readonly ctx: { eng: EngagementRecord; template: Template; assets: Assets; ledger: LedgerSnapshot }) {
    this.raw = tx
    this.type = String(tx.TransactionType)
    this.account = String(tx.Account)
    this.fee = BigInt(String(tx.Fee ?? '0'))
    this.flags = BigInt(Number(tx.Flags ?? 0))
    this.hasLastLedgerSequence = tx.LastLedgerSequence != null
    this.lastLedgerSequence = BigInt(Number(tx.LastLedgerSequence ?? 0))
    this.usesTicket = tx.TicketSequence != null
    this.isBatch = this.type === 'Batch'
    this.innerRaw = this.isBatch
      ? ((tx.RawTransactions as Array<{ RawTransaction: Json }>) ?? []).map((r) => r.RawTransaction)
      : [tx]
    this.inner = toCel(this.innerRaw) as unknown[]
    this.memos = {}
    for (const m of (tx.Memos as Array<{ Memo: { MemoType?: string; MemoData?: string } }>) ?? []) {
      const t = hexToUtf8(m.Memo?.MemoType)
      if (t) this.memos[t] = hexToUtf8(m.Memo?.MemoData)
    }
    const eng = ctx.eng
    const items: Payout[] = []
    for (const i of this.innerRaw) {
      if (i.TransactionType !== 'Payment' || i.Account !== eng.account) continue
      const a = ctx.assets.fromXrpl(i.Amount)
      const partial = (Number(i.Flags ?? 0) & TF_PARTIAL_PAYMENT) !== 0
      const def = ctx.assets.defs[a.code]
      let amount: Amount
      try {
        amount = def ? parseAmount(a.value, def) : new Amount(a.code, 0n)
      } catch {
        amount = new Amount(a.code, 0n)
      }
      if (partial) {
        // A residual sweep (E9) delivers whatever is left after the fixed payouts.
        amount = new Amount(a.code, -1n) // placeholder, resolved below
      }
      items.push({
        to: String(i.Destination),
        asset: a.code,
        value: a.value,
        amount,
        partial,
        issuer: a.issuer,
        issuerValid: a.known && (def?.kind === 'XRP' || (def?.issuer ?? null) === a.issuer),
      })
    }
    // Resolve residual amounts against the ledger balance at the pinned index.
    for (const p of items.filter((x) => x.partial)) {
      const bal = ledgerBalance(ctx.ledger, ctx.assets, eng.account, p.asset)
      const fixed = items.filter((x) => !x.partial && x.asset === p.asset).reduce((s, x) => s.add(x.amount), zero(p.asset))
      const residual = bal.sub(fixed)
      p.amount = residual.minor < 0n ? zero(p.asset) : residual
      p.value = formatAmount(p.amount, ctx.assets.defs[p.asset]?.decimals ?? 6)
    }
    this.payouts = new Payouts(items)
  }

  innerTypes(): string[] { return this.innerRaw.map((i) => String(i.TransactionType)) }
  innerAccounts(): string[] { return this.innerRaw.map((i) => String(i.Account)) }
  memo(type: string): string | null { return this.memos[type] ?? null }
  isAllOrNothing(): boolean { return (this.flags & BigInt(TF_BATCH_MODES)) === BigInt(TF_ALL_OR_NOTHING) }
  setsRegularKey(): boolean { return this.innerRaw.some((i) => i.TransactionType === 'SetRegularKey' && i.RegularKey != null) }
  closes(): boolean {
    const last = this.innerRaw.at(-1)
    return Boolean(last && last.TransactionType === 'AccountDelete' && last.Account === this.ctx.eng.account)
  }
  deleteDestinationValid(): boolean {
    if (!this.closes()) return true
    const dest = String(this.innerRaw.at(-1)!.Destination)
    const allowed = this.ctx.eng.deleteTo ?? this.ctx.eng.fee?.to ?? this.ctx.eng.parties.service
    return dest === allowed
  }
  issuersValid(): boolean { return this.payouts.items.every((p) => p.issuerValid) }

  /** Close Batches must drain the engagement asset exactly and remove the trust line (B7). */
  drainsExactly(): boolean {
    if (!this.closes()) return true
    const code = this.ctx.eng.asset
    const bal = ledgerBalance(this.ctx.ledger, this.ctx.assets, this.ctx.eng.account, code)
    const paid = this.payouts.sum(code)
    const removesLine = this.innerRaw.some((i) => i.TransactionType === 'TrustSet' && (i.LimitAmount as { value?: string })?.value === '0')
    return removesLine && paid.cmp(bal) === 0
  }

  /** B11: a pre-signed outcome must certainly succeed at the pinned ledger (single-shot, F2). */
  wouldSucceed(): boolean {
    const code = this.ctx.eng.asset
    if (this.closes()) {
      const seq = this.ctx.ledger.accounts[this.ctx.eng.account]?.sequence
      const oldEnough = seq == null || seq + ACCOUNT_DELETE_MIN_AGE <= this.ctx.ledger.index
      return oldEnough && this.drainsExactly() && extraObjects(this.ctx.ledger, this.ctx.eng.account) === 0
    }
    const bal = ledgerBalance(this.ctx.ledger, this.ctx.assets, this.ctx.eng.account, code)
    return this.payouts.sum(code).cmp(bal) <= 0
  }

  /** Map inner transactions to blueprint tokens and match against the template blueprint. */
  matchesBlueprint(name: string): boolean {
    const bp = this.ctx.template.blueprints[name]
    if (!bp) return false
    const tokens = this.innerRaw.map((i) => this.tokenOf(i))
    return matchTokens(bp.steps, tokens)
  }

  private tokenOf(i: Json): string {
    const eng = this.ctx.eng
    switch (i.TransactionType) {
      case 'Payment': {
        if (i.Account !== eng.account) return `pay.from:${String(i.Account)}`
        const to = String(i.Destination)
        if (eng.fee && to === eng.fee.to) return 'pay.serviceFee'
        const role = Object.entries(eng.parties).find(([, a]) => a === to)?.[0]
        if (role) return `pay.${role}`
        return 'pay.vendor'
      }
      case 'TrustSet':
        return (i.LimitAmount as { value?: string })?.value === '0' ? 'trustline.remove' : 'trustline.set'
      case 'AccountDelete':
        return 'account.delete'
      default:
        return `other:${String(i.TransactionType)}`
    }
  }

  /** Payment-intent hash (attestations spec §8.3): bound to destination, amount and invoice, not to the tx hash. */
  intentHash(): string {
    const p = this.payouts.items
    if (p.length !== 1) return ''
    return intentHashOf(p[0].to, p[0].amount, this.ctx.assets.defs[p[0].asset]?.decimals ?? 6, this.memo('eng/invoice'))
  }

  /** The `InvoiceID` of the single engagement-account payment (exact scheme), uppercase hex, or null. */
  invoiceField(): string | null {
    const pays = this.innerRaw.filter((i) => i.TransactionType === 'Payment' && i.Account === this.ctx.eng.account)
    const v = pays.length === 1 ? pays[0].InvoiceID : undefined
    return typeof v === 'string' ? v.toUpperCase() : null
  }

  /**
   * True when the payment binds to `invoiceId` either on-chain (InvoiceID == SHA-256(invoiceId),
   * the x402 `exact` scheme) or via the `eng/invoice` memo (the prepaid scheme). Used by W7 to tie
   * a co-signature to the x402 challenge the agent is paying.
   */
  boundToInvoice(invoiceId: string): boolean {
    const want = createHash('sha256').update(invoiceId, 'utf8').digest('hex').toUpperCase()
    return this.invoiceField() === want || this.memo('eng/invoice') === invoiceId
  }
}

/**
 * Payment-intent hash (attestations spec §8.3) = sha256(JCS({destination, amount: {asset, value}, invoiceRef})),
 * value in canonical decimal form (no trailing zeros). An approver computes it from the payment request
 * it is shown; it does not depend on the transaction's Sequence, fee or LastLedgerSequence.
 */
export function intentHashOf(destination: string, amount: Amount, decimals: number, invoiceRef: string | null): string {
  return sha256Jcs({ destination, amount: { asset: amount.asset, value: formatAmount(amount, decimals) }, invoiceRef })
}

export function matchTokens(steps: string[], tokens: string[]): boolean {
  // steps may end with "?" (optional, at most once each). Greedy left-to-right match.
  let t = 0
  for (const s of steps) {
    const optional = s.endsWith('?')
    const want = optional ? s.slice(0, -1) : s
    if (t < tokens.length && tokens[t] === want) t++
    else if (!optional) return false
  }
  return t === tokens.length
}

export class Payouts {
  constructor(readonly items: Payout[]) {}
  sum(asset: string): Amount { return this.items.filter((p) => p.asset === asset).reduce((s, p) => s.add(p.amount), zero(asset)) }
  to(account: string, asset: string): Amount { return this.items.filter((p) => p.to === account && p.asset === asset).reduce((s, p) => s.add(p.amount), zero(asset)) }
  destinations(): string[] { return [...new Set(this.items.map((p) => p.to))] }
  count(): number { return this.items.length }
  hasResidual(): boolean { return this.items.some((p) => p.partial) }
}

export function ledgerBalance(l: LedgerSnapshot, assets: Assets, account: string, code: string): Amount {
  const v = l.balances[account]?.[code]
  return v == null ? zero(code) : assets.amount(code, v)
}

export function extraObjects(l: LedgerSnapshot, account: string): number {
  return l.accounts[account]?.ownerObjects?.other ?? 0
}

export class LedgerFacts {
  constructor(readonly snap: LedgerSnapshot, private readonly assets: Assets) {}
  balance(account: string, asset: string): Amount { return ledgerBalance(this.snap, this.assets, account, asset) }
  exists(account: string): boolean { return this.snap.accounts[account]?.exists ?? false }
  masterDisabled(account: string): boolean { return this.snap.accounts[account]?.masterDisabled ?? false }
  hasRegularKey(account: string): boolean { return Boolean(this.snap.accounts[account]?.regularKey) }
  extraObjects(account: string): number { return extraObjects(this.snap, account) }
  tickets(account: string): number[] { return this.snap.accounts[account]?.ownerObjects?.tickets ?? [] }
  reserveIncrement(): bigint { return BigInt(this.snap.reserveIncDrops) }
  credentialExists(issuer: string, subject: string, type: string): boolean {
    return this.snap.credentials.some((c) => c.issuer === issuer && c.subject === subject && c.type === type && !expired(c.expiration, this.snap.closeTime))
  }
  hasCredential(account: string, type: string, issuers: string[]): boolean {
    return this.snap.credentials.some((c) => c.subject === account && c.type === type && c.accepted && issuers.includes(c.issuer) && !expired(c.expiration, this.snap.closeTime))
  }
}

function expired(exp: string | null | undefined, now: string): boolean {
  return exp != null && Date.parse(exp) <= Date.parse(now)
}

export class HistoryFacts {
  constructor(private readonly entries: LedgerSnapshot['history'][string], private readonly now: Date, private readonly assets: Assets) {}
  private within(windowSecs: bigint) {
    const from = this.now.getTime() - Number(windowSecs) * 1000
    return this.entries.filter((e) => Date.parse(e.closeTime) > from && Date.parse(e.closeTime) <= this.now.getTime())
  }
  outflow(asset: string, windowSecs: bigint): Amount {
    let s = zero(asset)
    for (const e of this.within(windowSecs)) for (const p of e.payouts) if (p.asset === asset) s = s.add(this.assets.amount(asset, p.value))
    return s
  }
  count(windowSecs: bigint): number { return this.within(windowSecs).length }
  paidTo(account: string, asset: string, windowSecs: bigint): Amount {
    let s = zero(asset)
    for (const e of this.within(windowSecs)) for (const p of e.payouts) if (p.asset === asset && p.to === account) s = s.add(this.assets.amount(asset, p.value))
    return s
  }
}

export class InflightFacts {
  constructor(readonly entries: InflightEntry[], private readonly assets: Assets) {}
  outflow(asset: string): Amount {
    let s = zero(asset)
    for (const e of this.entries) for (const p of e.payouts) if (p.asset === asset) s = s.add(this.assets.amount(asset, p.value))
    return s
  }
  count(): number { return this.entries.length }
}
