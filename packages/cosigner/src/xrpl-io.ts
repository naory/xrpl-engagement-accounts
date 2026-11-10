// XRPL transaction builders and I/O helpers (TypeScript port of spike/src/lib.js).
// Builders return plain transaction JSON; signing uses xrpl.js wallets.
import xrpl from 'xrpl'

type Json = Record<string, unknown>
type Client = InstanceType<typeof xrpl.Client>
type Wallet = InstanceType<typeof xrpl.Wallet>

export const TF_INNER_BATCH = 0x40000000
export const TF_ALL_OR_NOTHING = 0x00010000
export const TF_SET_NO_RIPPLE = 0x00020000 // TrustSet
export const TF_PARTIAL_PAYMENT = 0x00020000 // Payment
export const ASF_DISABLE_MASTER = 4
export const ASF_DEFAULT_RIPPLE = 8
export const LSF_DISABLE_MASTER = 0x00100000
export const LSF_ACCEPTED = 0x00010000 // Credential

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()
export const unhex = (h: unknown) => (typeof h === 'string' ? Buffer.from(h, 'hex').toString('utf8') : '')

/** Non-standard currency code → 40 hex chars. */
export function currencyHex(code: string): string {
  return code.length === 3 ? code : Buffer.from(code, 'ascii').toString('hex').toUpperCase().padEnd(40, '0')
}
export function iou(currency: string, issuer: string, value: string | number) {
  return { currency, issuer, value: String(value) }
}
export function memo(type: string, data: string) {
  return { Memo: { MemoType: hex(type), MemoData: hex(data) } }
}

export function inner(tx: Json, seqOrTicket: { Sequence?: number; TicketSequence?: number }): { RawTransaction: Json } {
  const base = { ...tx, Flags: (Number(tx.Flags ?? 0) | TF_INNER_BATCH) >>> 0, Fee: '0', SigningPubKey: '' }
  if (seqOrTicket.TicketSequence != null) return { RawTransaction: { ...base, Sequence: 0, TicketSequence: seqOrTicket.TicketSequence } }
  return { RawTransaction: { ...base, Sequence: seqOrTicket.Sequence } }
}

export interface Fees { base: number; reserveBase: number; inc: number }

/** Batch fee (XLS-56): 2×base + Σ inner fees + base × signatures; inner AccountDelete costs one reserve increment. */
export function batchFee(o: { base: number; inc: number; innerTxs: Array<{ RawTransaction: Json }>; signatures: number; headroom?: number }): string {
  const deletes = o.innerTxs.filter((t) => t.RawTransaction.TransactionType === 'AccountDelete').length
  const units = 2 + (o.innerTxs.length - deletes) + o.signatures
  return String(deletes * o.inc + Math.ceil(o.base * units * (o.headroom ?? 1.5)))
}
/** Multisigned single transaction fee: base × (1 + signatures). */
export function multisigFee(base: number, signatures: number, headroom = 1.5): string {
  return String(Math.ceil(base * (1 + signatures) * headroom))
}

/** Open Batch for an owner-wallet or escrow account (see spike/F1: master disabled at pre-create). */
export function buildOpenBatch(o: {
  eng: string; funder: string; currency: string; issuer: string; amount: string
  signerEntries: Array<[string, number]>; quorum: number; seq: number; funderSeq: number; ticketCount: number; memos: Json[]; fees: Fees
}): { tx: Json; tickets: number[] } {
  const raw = [
    inner({ TransactionType: 'Payment', Account: o.funder, Destination: o.eng, Amount: iou(o.currency, o.issuer, o.amount) }, { Sequence: o.funderSeq }),
    inner({ TransactionType: 'SignerListSet', Account: o.eng, SignerQuorum: o.quorum, SignerEntries: o.signerEntries.map(([Account, SignerWeight]) => ({ SignerEntry: { Account, SignerWeight } })) }, { Sequence: o.seq + 1 }),
    ...(o.ticketCount > 0 ? [inner({ TransactionType: 'TicketCreate', Account: o.eng, TicketCount: o.ticketCount }, { Sequence: o.seq + 2 })] : []),
    inner({ TransactionType: 'SetRegularKey', Account: o.eng }, { Sequence: o.ticketCount > 0 ? o.seq + 3 + o.ticketCount : o.seq + 2 }),
  ]
  const tickets = Array.from({ length: o.ticketCount }, (_, i) => o.seq + 3 + i)
  const tx: Json = { TransactionType: 'Batch', Account: o.eng, Flags: TF_ALL_OR_NOTHING, Sequence: o.seq, RawTransactions: raw, Memos: o.memos }
  tx.Fee = batchFee({ base: o.fees.base, inc: o.fees.inc, innerTxs: raw, signatures: 1, headroom: 2 })
  return { tx, tickets }
}

/** Close Batch: payouts → remove trust line → AccountDelete (last). Live ({seq, lastLedgerSequence}) or ticketed. */
export function buildCloseBatch(o: {
  eng: string; currency: string; issuer: string; payouts: Array<{ to: string; value?: string; partial?: boolean }>; deleteTo: string
  seq?: number; lastLedgerSequence?: number; tickets?: number[]; memos: Json[]; fees: Fees; signatures: number; headroom?: number
}): Json {
  const steps: Json[] = [
    ...o.payouts.map((p) => ({ TransactionType: 'Payment', Account: o.eng, Destination: p.to, Amount: iou(o.currency, o.issuer, p.partial ? '1000000000' : String(p.value)), ...(p.partial ? { Flags: TF_PARTIAL_PAYMENT } : {}) })),
    { TransactionType: 'TrustSet', Account: o.eng, LimitAmount: iou(o.currency, o.issuer, '0'), Flags: TF_SET_NO_RIPPLE },
    { TransactionType: 'AccountDelete', Account: o.eng, Destination: o.deleteTo },
  ]
  let raw: Array<{ RawTransaction: Json }>
  let outer: Json
  if (o.tickets) {
    if (o.tickets.length !== steps.length + 1) throw new Error(`need ${steps.length + 1} tickets, got ${o.tickets.length}`)
    raw = steps.map((s, i) => inner(s, { TicketSequence: o.tickets![i + 1] }))
    outer = { Sequence: 0, TicketSequence: o.tickets[0] }
  } else {
    raw = steps.map((s, i) => inner(s, { Sequence: o.seq! + 1 + i }))
    outer = { Sequence: o.seq, LastLedgerSequence: o.lastLedgerSequence }
  }
  const tx: Json = { TransactionType: 'Batch', Account: o.eng, Flags: TF_ALL_OR_NOTHING, ...outer, RawTransactions: raw, Memos: o.memos, SigningPubKey: '' }
  tx.Fee = batchFee({ base: o.fees.base, inc: o.fees.inc, innerTxs: raw, signatures: o.signatures, headroom: o.headroom })
  return tx
}

// ── Signing ────────────────────────────────────────────────────────────────
export function multisignBlob(w: Wallet, tx: Json): string {
  return w.sign(structuredClone(tx) as never, true).tx_blob
}
export function combine(blobs: string[]): string {
  return xrpl.multisign(blobs)
}
export function addBatchSigner(w: Wallet, batchTx: Json): Json {
  xrpl.signMultiBatch(w, batchTx as never)
  return batchTx
}
/** Strip signatures so a transaction can be evaluated and signed by another party. */
export function unsigned(tx: Json): Json {
  const { Signers: _s, TxnSignature: _t, ...rest } = tx
  void _s; void _t
  return { ...rest, SigningPubKey: '' }
}

// ── Ledger I/O ─────────────────────────────────────────────────────────────
const notFound = (e: unknown) => String((e as { data?: { error?: string } })?.data?.error ?? (e as Error)?.message).includes('actNotFound')

export async function currentLedger(c: Client): Promise<number> {
  const r = await c.request({ command: 'ledger_current' })
  return r.result.ledger_current_index
}
export async function accountInfo(c: Client, account: string, ledger: number | 'validated' = 'validated'): Promise<Json | null> {
  try {
    const r = await c.request({ command: 'account_info', account, ledger_index: ledger, signer_lists: true } as never)
    return (r as { result: Json }).result
  } catch (e) {
    if (notFound(e)) return null
    throw e
  }
}
export async function iouBalance(c: Client, account: string, currency: string, issuer: string): Promise<string | null> {
  try {
    const r = await c.request({ command: 'account_lines', account, peer: issuer, ledger_index: 'validated' })
    return r.result.lines.find((l) => l.currency === currency)?.balance ?? null
  } catch (e) {
    if (notFound(e)) return null
    throw e
  }
}
export async function serverFees(c: Client): Promise<Fees> {
  const r = await c.request({ command: 'server_state' })
  const v = r.result.state.validated_ledger!
  return { base: Number(v.base_fee), reserveBase: Number(v.reserve_base), inc: Number(v.reserve_inc) }
}
export async function lookupTx(c: Client, hash: string): Promise<Json | null> {
  try {
    return (await c.request({ command: 'tx', transaction: hash })).result as unknown as Json
  } catch {
    return null
  }
}

export interface SubmitResult { hash: string; prelim: string; final: string; validated: boolean; ledger?: number; meta?: Json }

/** Submit a signed blob; wait for validation unless the preliminary result is final (tef/tem/tel). */
export async function submit(c: Client, blob: string, opts: { waitLedgers?: number } = {}): Promise<SubmitResult> {
  const r = await c.request({ command: 'submit', tx_blob: blob })
  const prelim = r.result.engine_result
  const hash = (r.result.tx_json as { hash?: string })?.hash ?? xrpl.hashes.hashSignedTx(blob)
  if (/^(tef|tem|tel)/.test(prelim)) return { hash, prelim, final: prelim, validated: false }
  const start = await currentLedger(c)
  for (;;) {
    await sleep(3000)
    const t = await lookupTx(c, hash)
    if (t?.validated) return { hash, prelim, final: String((t.meta as Json).TransactionResult), validated: true, ledger: Number(t.ledger_index), meta: t.meta as Json }
    if ((await currentLedger(c)) > start + (opts.waitLedgers ?? 15)) return { hash, prelim, final: 'NOT_VALIDATED', validated: false }
  }
}
/** Autofill, single-sign, submit. */
export async function sendSimple(c: Client, w: Wallet, tx: Json): Promise<SubmitResult> {
  const prepared = await c.autofill(tx as never)
  return submit(c, w.sign(prepared).tx_blob)
}
export function innerHashes(batch: Json): string[] {
  return (batch.RawTransactions as Array<{ RawTransaction: Json }>).map((r) => xrpl.hashes.hashSignedTx(r.RawTransaction as never))
}
export async function innerResults(c: Client, batch: Json) {
  const out: Array<{ hash: string; applied: boolean; result: string | null }> = []
  for (const h of innerHashes(batch)) {
    const t = await lookupTx(c, h)
    out.push({ hash: h, applied: Boolean(t?.validated), result: ((t?.meta as Json | undefined)?.TransactionResult as string) ?? null })
  }
  return out
}
