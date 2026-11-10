import type { AssetDef, Statement, Template } from '@eng/core'

export type Enforcement = 'service' | 'ledger' | 'final-signature' | 'advisory' | 'none'

export interface Rule {
  id: string
  when?: string
  check: string
  reason: string
  message?: string
}

export interface StageDef {
  enforcement: Enforcement
  rules: Rule[]
}

/** The claim of a `policy.document/1` statement (docs/spec/policy.md §2). */
export interface PolicyDoc {
  policyId: string
  version: string
  layer: 'baseline' | 'template' | 'engagement' | 'counterparty'
  appliesTo: string[]
  language: 'cel-eng/1'
  registry?: string
  assets?: Record<string, AssetDef>
  constraints?: Record<string, unknown>
  params?: Record<string, unknown>
  definitions?: Record<string, string>
  /** Rules for every stage ("*"), applied before stage-specific rules. Baseline layer only. */
  stages: Record<string, StageDef>
}

export interface AttesterTerms {
  accounts?: string[]
  accreditors?: string[]
  kind?: string
}

/** The engagement record (hotel spec §4), the object every component reads. */
export interface EngagementRecord {
  engagementId: string
  template: string
  account: string
  asset: string
  parties: Record<string, string>
  fee?: { bps: number; to: string }
  amount?: { asset: string; value: string }
  timers?: Record<string, string>
  attesters?: Record<string, AttesterTerms>
  /** Child engagement accounts that payouts may target (E8). */
  children?: string[]
  /** Accepted sponsor / AccountDelete destination (defaults to the service fee account). */
  deleteTo?: string
  state: string
  /** Statement ids already consumed by executed outcomes (single-use types). */
  consumed?: string[]
  /** Policy layer hashes pinned at open, in evaluation order (baseline excluded: always applied). */
  policyLayers?: string[]
  mandateId?: string
}

export interface LedgerAccountState {
  exists: boolean
  /** Next account Sequence (for in-flight resolution). */
  sequence?: number
  masterDisabled?: boolean
  regularKey?: string | null
  /** Objects the account owns, for drain / deletion checks. */
  ownerObjects?: { trustlines: number; signerList: boolean; tickets: number[]; other: number }
}

export interface LedgerCredential {
  issuer: string
  subject: string
  type: string
  accepted: boolean
  expiration?: string | null
}

export interface HistoryEntry {
  hash: string
  ledgerIndex: number
  closeTime: string
  /** Sequence or TicketSequence the payment used (for in-flight resolution). */
  sequence?: number
  ticket?: number
  payouts: Array<{ to: string; asset: string; value: string }>
}

/** Read-only view of the ledger at one validated index (policy spec P2). */
export interface LedgerSnapshot {
  index: number
  hash: string
  closeTime: string
  baseFeeDrops: string
  reserveIncDrops: string
  accounts: Record<string, LedgerAccountState>
  /** balances[account][assetCode] = decimal string */
  balances: Record<string, Record<string, string>>
  credentials: LedgerCredential[]
  /** Validated outgoing payments of engagement accounts (for stateful counters, E12). */
  history: Record<string, HistoryEntry[]>
}

/** A SIGN decision whose transaction hasn't validated or expired yet (policy spec §6). */
export interface InflightEntry {
  decisionId: string
  txHash?: string
  lastLedgerSequence?: number
  payouts: Array<{ to: string; asset: string; value: string }>
}

export interface DecideInput {
  stage: string
  /** XRPL transaction JSON (decoded). Stages without a transaction (e.g. "confirm") pass null. */
  proposedTx: Record<string, unknown> | null
  engagement: EngagementRecord
  template: Template
  /** Effective layers in order: baseline, template, engagement, … */
  layers: PolicyDoc[]
  mandate?: Statement | null
  statements: Statement[]
  ledger: LedgerSnapshot
  inflight: InflightEntry[]
  registry?: string[]
  /** Cost budget in rule evaluations × AST nodes (rough CEL cost proxy). */
  costBudget?: number
}

export type RuleOutcome = 'pass' | 'fail' | 'n/a' | 'error'

export interface RuleResult {
  layer: string
  id: string
  result: RuleOutcome
  reason?: string
  message?: string
  error?: string
}

export interface StatementRejection { id: string; type?: string; code: string }

export interface Decision {
  decision: 'SIGN' | 'REFUSE'
  stage: string
  engagementId: string
  results: RuleResult[]
  failing: string[]
  statementsUsed: string[]
  statementsRejected: StatementRejection[]
  inflightCounted: string[]
  ledger: { index: number; hash: string; closeTime: string }
  policy: { effectiveHash: string; layers: string[] }
  inputsHash: string
  costUnits: number
  proposedTxHash: string | null
}
