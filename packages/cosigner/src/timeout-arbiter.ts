// Independent checks an arbiter runs before it signs a live timeout (spec §3.4).
// The ledger argument is the arbiter's own validated read. The co-signer's notice is not trusted.
import { parseAmount, verifyStatement, type Statement, type Template } from '@eng/core'
import { decide, type EngagementRecord, type LedgerSnapshot, type PolicyDoc } from '@eng/policy'
import { unhex } from './xrpl-io.ts'

type Json = Record<string, unknown>

export interface PresentedReceipt {
  statement: Statement
  /** Signed cosigner.receipt/1. claim.receivedAt is the receipt time. */
  receipt: Statement
}

export interface ArbiterTimeoutInput {
  outcome: 'default.refund' | 'default.release'
  record: EngagementRecord
  template: Template
  layers: PolicyDoc[]
  /** The arbiter's own snapshot. */
  ledger: LedgerSnapshot
  tx: Json
  builtAtLedger: number
  /** Statements the arbiter verified itself. A presented shipment is included here so decide() can see it. */
  statements: Statement[]
  /** Buyer-presented party.dispute/1 plus its receipt. Blocks release only together with the bond on this ledger. */
  presentedDispute?: PresentedReceipt | null
  /** The party that already signed. Either party is allowed; the payout is still checked for the winner. */
  partyAccount: string
  /** Receipt anchors so a shipment receipted inside its window still counts later. */
  receipted?: ReadonlyMap<string, { receivedAt: string; attesterIsParty: boolean; signerPublicKey?: string }>
}

export type ArbiterTimeoutResult = { ok: true } | { ok: false; check: number; reason: string }

const refuse = (check: number, reason: string): ArbiterTimeoutResult => ({ ok: false, check, reason })

function memo(tx: Json, type: string): string | undefined {
  for (const m of (tx.Memos as Array<{ Memo?: { MemoType?: string; MemoData?: string } }>) ?? []) {
    if (unhex(m.Memo?.MemoType) === type) return unhex(m.Memo?.MemoData)
  }
  return undefined
}

function param(layers: PolicyDoc[], name: string): unknown {
  return [...layers].reverse().map((l) => (l.params as Record<string, unknown> | undefined)?.[name]).find((v) => v !== undefined)
}

/** Price plus the policy's minimum dispute bond, in the deal asset's minor units. */
function bonded(record: EngagementRecord, layers: PolicyDoc[], ledger: LedgerSnapshot): boolean {
  const code = record.asset ?? record.amount?.asset
  const asset = layers.flatMap((l) => Object.values(l.assets ?? {})).find((a) => a.code === code)
  if (!asset || typeof record.amount?.value !== 'string') return false
  const bond = param(layers, 'minDisputeBond')
  let need
  try {
    need = parseAmount(record.amount.value, asset)
    if (typeof bond === 'string') need = need.add(parseAmount(bond, asset))
  } catch { return false }
  const raw = ledger.balances[record.account]?.[asset.code]
  if (typeof raw !== 'string') return false
  try { return parseAmount(raw, asset).cmp(need) >= 0 } catch { return false }
}

function receiptTime(receipt: Statement): number {
  const at = (receipt.claim as { receivedAt?: unknown } | undefined)?.receivedAt
  return typeof at === 'string' ? Date.parse(at) : Number.NaN
}

/**
 * The nine checks. A receipted dispute blocks `default.release` only when this ledger also holds
 * at least the price plus the minimum dispute bond.
 */
export function verifyArbiterTimeout(input: ArbiterTimeoutInput): ArbiterTimeoutResult {
  const { outcome, record, template, layers, ledger, tx, statements, partyAccount } = input
  const account = record.account
  const state = ledger.accounts[account]
  if (!state?.exists) return refuse(1, 'the engagement account is not on the arbiter ledger')

  const decision = decide({
    stage: outcome, proposedTx: tx, engagement: record, template, layers, mandate: null,
    statements, ledger, inflight: [], receipted: input.receipted,
  })
  if (decision.decision !== 'SIGN') return refuse(2, decision.failing.join(',') || 'REFUSE')

  const closeMs = Date.parse(ledger.closeTime)
  const deadline = Date.parse(outcome === 'default.refund' ? (record.timers?.shipBy ?? '') : (record.timers?.inspectBy ?? ''))
  if (Number.isNaN(closeMs) || Number.isNaN(deadline) || closeMs <= deadline) return refuse(3, 'the deadline has not passed on the arbiter ledger')

  if (outcome === 'default.release') {
    const principal = record.parties.principal
    const inspect = Date.parse(record.timers?.inspectBy ?? '')
    const onLedger = ledger.credentials.some((c) =>
      c.type === 'ENG/DISPUTE' && c.accepted && c.subject === account && c.issuer === principal &&
      typeof c.createdAt === 'string' && Date.parse(c.createdAt) <= inspect)
    const held = bonded(record, layers, ledger)
    const presented = input.presentedDispute
    const presentedOk = Boolean(presented && presented.statement.type === 'party.dispute/1' &&
      presented.statement.attester.account === principal && verifyStatement(presented.statement).ok &&
      presented.receipt.type === 'cosigner.receipt/1' && verifyStatement(presented.receipt).ok &&
      receiptTime(presented.receipt) <= inspect)
    if ((onLedger && held) || (presentedOk && held)) return refuse(4, 'DISPUTE_OPEN')
  }

  const carriers = new Set(record.attesters?.shipping?.accounts ?? [])
  for (const s of statements) {
    if (s.type !== 'shipping.shipped/1') continue
    const v = verifyStatement(s)
    if (!v.ok || !carriers.has(s.attester.account) || v.signerAddress !== s.attester.account) return refuse(5, 'a shipment does not verify for a named carrier')
  }

  const allowed = new Set([record.parties.principal, record.parties.counterparty, record.fee?.to].filter((a): a is string => typeof a === 'string'))
  const inners = ((tx.RawTransactions ?? []) as Array<{ RawTransaction?: Json }>).map((r) => r.RawTransaction ?? {})
  for (const inner of inners) {
    if (inner.TransactionType !== 'Payment' || inner.Account !== account) continue
    if (!allowed.has(String(inner.Destination))) return refuse(6, 'a payout is not to a party or the fee account')
  }

  const seq = state.sequence
  if (typeof seq !== 'number' || Number(tx.Sequence) !== seq) return refuse(7, 'the outer Sequence is not the validated account Sequence')
  if (inners.some((inner, i) => Number(inner.Sequence) !== seq + 1 + i)) return refuse(7, 'an inner Sequence is not the next account Sequence')

  const window = Number(param(layers, 'maxLedgerWindow') ?? 30)
  const maxAge = Number(param(layers, 'proposalMaxAge') ?? 20)
  const lls = Number(tx.LastLedgerSequence)
  if (!(lls > ledger.index && lls <= ledger.index + window && ledger.index - input.builtAtLedger <= maxAge)) {
    return refuse(8, 'the proposal is not inside its ledger window')
  }

  if (memo(tx, 'eng/basis') !== outcome) return refuse(9, 'the basis memo is not this outcome')
  const sets = template.outcomes[outcome]?.signers ?? []
  const roleOf = (addr: string) => Object.entries(record.parties).find(([, a]) => a === addr)?.[0]
  const partyRole = roleOf(partyAccount)
  const arbiterRole = roleOf(record.parties.arbiter ?? '')
  const inSet = partyRole && sets.some((set) => set.includes(partyRole) && (!arbiterRole || set.includes(arbiterRole)))
  if (!inSet) return refuse(9, 'the signing party is not in a signer set for this outcome')
  return { ok: true }
}
