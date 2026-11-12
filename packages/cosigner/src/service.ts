// The policy co-signer service (docs/spec/policy.md §6–§8, §12): for each request it pins a
// validated ledger, runs decide(), signs a cosigner.decision/1 record, and — only on SIGN — adds
// its multisig signature to exactly the transaction it evaluated.
import fs from 'node:fs'
import path from 'node:path'
import xrpl from 'xrpl'
import { documentHash, newNonce, parseAmount, signStatementAsync, signerBlob, verifyStatement, zero, type AssetDef, type Signer, type Statement, type Template } from '@eng/core'
import {
  Assets, REGISTRY, TxFacts, decide, decisionStatementBody, layerHash,
  type Decision, type EngagementRecord, type InflightEntry, type LedgerSnapshot, type PolicyDoc, verifyStatements,
} from '@eng/policy'
import type { LedgerSource } from './snapshot.ts'
import { unsigned } from './xrpl-io.ts'

type Json = Record<string, unknown>

export interface InflightRecord extends InflightEntry {
  engagementId: string
  /** Outer Sequence / TicketSequence the transaction consumes. */
  outer: { sequence?: number; ticket?: number }
  /** Sequence / TicketSequence of each payout (inner payments for a Batch). */
  payments: Array<{ sequence?: number; ticket?: number }>
  /** Single-use statements reserved by this decision (consumed on success, released otherwise). */
  reserved: string[]
  decidedAtLedger: number
  /** documentHash of the evaluated transaction: re-requests for the same transaction are idempotent. */
  proposedTxHash: string
}

export interface DecideRequest {
  engagementId: string
  stage: string
  /** Transaction JSON, or a (partially) signed blob from another signer. */
  tx?: Json | null
  txBlob?: string
  statements?: Statement[]
}

export interface DecideResponse {
  decision: Decision['decision']
  failing: string[]
  results: Decision['results']
  statementsRejected: Decision['statementsRejected']
  /** Signed cosigner.decision/1 record. */
  record: Statement
  /** The co-signer's multisig signature on the evaluated transaction (SIGN only); combine with xrpl.multisign. */
  signerBlob?: string
  /** The exact transaction evaluated and signed. */
  tx?: Json | null
  /** Set when the stage is not one the co-signer signs (advisory evaluation only). */
  advisory?: true
}

/** Proof that the co-signer received a statement in time: a co-signer-signed cosigner.receipt/1. */
export interface Receipt {
  statement: Statement
}

interface EngagementState {
  record: EngagementRecord
  mandate: Statement | null
  layers: PolicyDoc[]
  template: Template
  /** Receipted ("posted") attestations, keyed by statement id. Kept out of `record` (hashed into inputsHash). */
  attestations: Map<string, { statement: Statement; receipt: Receipt }>
}

export interface CosignerOptions {
  /** The co-signer's signer (a SignerList entry; never funded). Local or Privy-custodied. */
  signer: Signer
  source: LedgerSource
  templates: Template[]
  /** Policy library: the baseline plus template / engagement layers. */
  policies: PolicyDoc[]
  /** Optional directory for the append-only decision log (decisions.jsonl). */
  dataDir?: string
  historySecs?: number
  accreditation?: { issuer: string; credentialType: string }
}

const DAY = 86400
/** A statement may not be received more than this long after its issuedAt (bounds backdating). */
const MAX_ISSUE_LAG_SECS = 300

export class CosignerService {
  private readonly engagements = new Map<string, EngagementState>()
  private readonly inflight: InflightRecord[] = []
  private readonly log: Statement[] = []
  /** Serialize decisions per engagement so in-flight accounting is race-free. */
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(private readonly o: CosignerOptions) {}

  get address(): string { return this.o.signer.address }

  /** Register an engagement (normally done by the service at open, from the signed engagement record). */
  register(record: EngagementRecord, mandate: Statement | null = null): { ok: true; layers: string[] } {
    const template = this.o.templates.find((t) => t.templateId === record.template)
    if (!template) throw new Error(`unknown template ${record.template}`)
    if (record.parties.cosigner && record.parties.cosigner !== this.address) throw new Error(`engagement names a different co-signer (${record.parties.cosigner})`)
    if (mandate && !verifyStatement(mandate).ok) throw new Error('mandate signature invalid')
    const baseline = this.o.policies.find((p) => p.layer === 'baseline')
    if (!baseline) throw new Error('no baseline policy loaded')
    let layers: PolicyDoc[]
    if (record.policyLayers?.length) {
      layers = record.policyLayers.map((h) => {
        const p = this.o.policies.find((x) => layerHash(x) === h)
        if (!p) throw new Error(`policy layer ${h} not available`)
        return p
      })
    } else {
      const p = this.o.policies.find((x) => x.layer === 'template' && x.appliesTo.includes(record.template))
      if (!p) throw new Error(`no template policy for ${record.template}`)
      layers = [p]
    }
    this.engagements.set(record.engagementId, { record: structuredClone({ consumed: [], ...record }), mandate, layers: [baseline, ...layers], template, attestations: new Map() })
    return { ok: true, layers: [baseline, ...layers].map((l) => `${l.policyId}@${l.version} ${layerHash(l)}`) }
  }

  engagement(id: string): EngagementRecord | undefined { return this.engagements.get(id)?.record }
  decisions(engagementId?: string): Statement[] { return engagementId ? this.log.filter((s) => s.engagementId === engagementId) : [...this.log] }
  inflightFor(engagementId: string): InflightRecord[] { return this.inflight.filter((i) => i.engagementId === engagementId) }

  /** Receipted statements for an engagement, in ingest order. */
  statements(engagementId: string): Statement[] {
    return [...(this.engagements.get(engagementId)?.attestations.values() ?? [])].map((a) => a.statement)
  }

  async decide(req: DecideRequest): Promise<DecideResponse> {
    return this.serialized(req.engagementId, () => this.decideLocked(req))
  }

  /**
   * Store a party's attestation and return a signed receipt (spec §5.2a). "Posted" means receipted:
   * the window is judged on a fresh validated ledger's closeTime (inclusive), and a late statement is
   * rejected and never stored. Re-ingesting a stored statement returns its original receipt.
   */
  async ingest(engagementId: string, s: Statement): Promise<Receipt> {
    return this.serialized(engagementId, () => this.ingestLocked(engagementId, s))
  }

  private async ingestLocked(engagementId: string, s: Statement): Promise<Receipt> {
    const st = this.engagements.get(engagementId)
    if (!st) throw new Error(`unknown engagement ${engagementId}`)
    const v = verifyStatement(s)
    if (!v.ok) throw new Error(`BAD_STATEMENT: ${v.reason}`)
    const prior = st.attestations.get(s.id)
    if (prior) return prior.receipt
    if (s.engagementId !== engagementId) throw new Error(`WRONG_ENGAGEMENT: statement is for ${s.engagementId}`)
    const attester = s.attester.account
    if (!Object.values(st.record.parties).includes(attester)) throw new Error(`NOT_A_PARTY: ${attester}`)

    const assets = this.assetsOf(st.layers)
    const ledger = await this.o.source.snapshot({ account: st.record.account, assets, accounts: [attester], credentialSubjects: [attester], historySecs: 0 })
    const received = Date.parse(ledger.closeTime)

    const windows = st.template.attestationWindows ?? {}
    const phase = (s.claim as { phase?: unknown }).phase
    let window: string | undefined
    if (Object.keys(windows).some((k) => k.startsWith(`${s.type}#`))) {
      // Phased type: the phase must name one of its windows, or the statement would escape every deadline.
      window = typeof phase === 'string' ? windows[`${s.type}#${phase}`] : undefined
      if (!window) throw new Error(`BAD_PHASE: ${s.type} phase ${JSON.stringify(phase ?? null)} has no window`)
    } else window = windows[s.type]
    if (window) {
      const deadline = Date.parse(st.record.timers?.[window] ?? '')
      if (Number.isNaN(deadline)) throw new Error(`NO_DEADLINE: engagement has no timer ${window}`)
      if (received > deadline) throw new Error(`LATE: ${s.type} after ${window}`)
    }
    const issued = Date.parse(s.issuedAt)
    if (Number.isNaN(issued) || received - issued > MAX_ISSUE_LAG_SECS * 1000) throw new Error(`STALE_ISSUED: issued ${s.issuedAt}, received ${ledger.closeTime}`)
    if (s.type === 'party.claim/1') checkClaimTotal(s, assets)
    // Key authorization, role, binding and time checks of the policy pipeline, at the receipt ledger.
    const rejected = verifyStatements([s], st.record, ledger).rejected[0]
    if (rejected) throw new Error(`REJECTED: ${rejected.code}`)

    const receipt: Receipt = {
      statement: await signStatementAsync({
        v: 'eng.att/1', type: 'cosigner.receipt/1', engagementId,
        subject: { statementId: s.id, statementType: s.type },
        claim: { receivedAt: ledger.closeTime, ledgerIndex: ledger.index },
        observedAt: ledger.closeTime, issuedAt: ledger.closeTime, nonce: newNonce(),
        attester: { account: this.address, kind: 'COSIGNER', ...(this.o.accreditation ? { accreditation: this.o.accreditation } : {}) },
      }, this.o.signer),
    }
    st.attestations.set(s.id, { statement: s, receipt })
    return receipt
  }

  /** Serialize work per engagement so in-flight accounting and the attestation store are race-free. */
  private serialized<T>(engagementId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(engagementId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    this.locks.set(engagementId, run.catch(() => undefined))
    return run
  }

  private async decideLocked(req: DecideRequest): Promise<DecideResponse> {
    const st = this.engagements.get(req.engagementId)
    if (!st) throw new Error(`unknown engagement ${req.engagementId}`)
    const tx = req.txBlob ? unsigned(xrpl.decode(req.txBlob) as Json) : req.tx ? unsigned(req.tx) : null
    // Stored (receipted) statements plus those passed in, deduplicated by id. A window-governed statement
    // counts only once receipted ("posted" = receipted), so request copies of unreceipted ones are dropped.
    const stored = this.statements(req.engagementId)
    const notReceipted: Decision['statementsRejected'] = []
    const passed = (req.statements ?? []).filter((s) => {
      if (st.attestations.has(s?.id) || !windowGoverned(st.template, s?.type)) return true
      notReceipted.push({ id: s?.id ?? '(none)', type: s?.type, code: 'NOT_RECEIPTED' })
      return false
    })
    const statements = [...new Map([...stored, ...passed].map((s) => [s?.id, s])).values()]
    const assets = this.assetsOf(st.layers)

    // Snapshot: key state for attesters; credentials for payees, attesters and the account.
    const attesters = [...statements, ...(st.mandate ? [st.mandate] : [])].map((s) => s.attester?.account).filter(Boolean) as string[]
    const payees = tx ? new TxFacts(tx, { eng: st.record, template: st.template, assets: new Assets(assets), ledger: emptyLedger(st.record.account) }).payouts.destinations() : []
    const ledger = await this.o.source.snapshot({
      account: st.record.account, assets, accounts: attesters, credentialSubjects: [...payees, ...attesters],
      historySecs: this.o.historySecs ?? 90 * DAY,
    })

    // Resolve in-flight decisions against this ledger, then reserve single-use statements.
    this.resolveInflight(st, ledger)
    const txHash = tx ? documentHash(tx) : null
    // A re-request for a transaction already signed (same hash, same sequence) must not count against itself.
    const mine = this.inflightFor(st.record.engagementId).filter((i) => i.proposedTxHash !== txHash)
    const reserved = mine.flatMap((i) => i.reserved)
    const engagement: EngagementRecord = { ...st.record, consumed: [...(st.record.consumed ?? []), ...reserved] }

    const decided = decide({
      stage: req.stage, proposedTx: tx, engagement, template: st.template, layers: st.layers,
      mandate: st.mandate, statements, ledger, inflight: mine.map(({ decisionId, txHash, lastLedgerSequence, payouts }) => ({ decisionId, txHash, lastLedgerSequence, payouts })),
    })
    const d: Decision = notReceipted.length ? { ...decided, statementsRejected: [...notReceipted, ...decided.statementsRejected] } : decided

    const intentHash = tx ? new TxFacts(tx, { eng: engagement, template: st.template, assets: new Assets(assets), ledger }).intentHash() : ''
    const record = await signStatementAsync(decisionStatementBody(d, { account: this.address, accreditation: this.o.accreditation }, newNonce(), intentHash || undefined), this.o.signer)
    this.append(record)

    const signs = this.signsStage(st.template, req.stage)
    const out: DecideResponse = { decision: d.decision, failing: d.failing, results: d.results, statementsRejected: d.statementsRejected, record, tx, ...(signs ? {} : { advisory: true }) }
    if (d.decision === 'SIGN' && tx && signs) {
      out.signerBlob = await signerBlob(this.o.signer, tx)
      const facts = new TxFacts(tx, { eng: engagement, template: st.template, assets: new Assets(assets), ledger })
      const used = new Set(d.statementsUsed)
      const dup = this.inflight.findIndex((i) => i.engagementId === st.record.engagementId && i.proposedTxHash === txHash)
      if (dup >= 0) this.inflight.splice(dup, 1)
      this.inflight.push({
        proposedTxHash: txHash!,
        engagementId: st.record.engagementId,
        decisionId: record.id,
        lastLedgerSequence: tx.LastLedgerSequence != null ? Number(tx.LastLedgerSequence) : undefined,
        payouts: facts.payouts.items.map((p) => ({ to: p.to, asset: p.asset, value: p.value })),
        outer: seqOf(tx),
        payments: facts.innerRaw.filter((i) => i.TransactionType === 'Payment').map(seqOf),
        reserved: statements.filter((s) => used.has(s.id) && REGISTRY[s.type]?.singleUse).map((s) => s.id),
        decidedAtLedger: ledger.index,
      })
    }
    return out
  }

  /**
   * The co-signer signs a stage only if a template outcome maps to it, that outcome's signer sets
   * include a co-signer role, and its enforcement is not advisory/none. Other stages get a decision
   * record but no signature (e.g. the owner's solo close in an owner-wallet).
   */
  private signsStage(t: Template, stage: string): boolean {
    const cosignerRoles = Object.entries(t.roles).filter(([, r]) => r.kind === 'cosigner').map(([n]) => n)
    return Object.values(t.outcomes).some((o) =>
      o.policyStage === stage && o.enforcement !== 'advisory' && o.enforcement !== 'none' && o.signers.some((set) => set.some((r) => cosignerRoles.includes(r))))
  }

  /** In-flight entries leave the set when their sequence/ticket is consumed or their LastLedgerSequence passes. */
  private resolveInflight(st: EngagementState, ledger: LedgerSnapshot): void {
    const acct = ledger.accounts[st.record.account]
    const hist = ledger.history[st.record.account] ?? []
    for (let i = this.inflight.length - 1; i >= 0; i--) {
      const f = this.inflight[i]
      if (f.engagementId !== st.record.engagementId) continue
      const consumed = !acct?.exists
        || (f.outer.sequence != null && acct.sequence != null && acct.sequence > f.outer.sequence)
        || (f.outer.ticket != null && !(acct.ownerObjects?.tickets ?? []).includes(f.outer.ticket))
      const expired = f.lastLedgerSequence != null && ledger.index > f.lastLedgerSequence
      if (!consumed && !expired) continue
      const succeeded = consumed && f.payments.some((p) => hist.some((h) => (p.sequence != null && h.sequence === p.sequence) || (p.ticket != null && h.ticket === p.ticket)))
      if (succeeded) st.record.consumed = [...new Set([...(st.record.consumed ?? []), ...f.reserved])]
      this.inflight.splice(i, 1)
    }
  }

  private assetsOf(layers: PolicyDoc[]): Record<string, AssetDef> {
    const a: Record<string, AssetDef> = {}
    for (const l of layers) Object.assign(a, l.assets ?? {})
    return a
  }

  private append(s: Statement): void {
    this.log.push(s)
    if (this.o.dataDir) {
      fs.mkdirSync(this.o.dataDir, { recursive: true })
      fs.appendFileSync(path.join(this.o.dataDir, 'decisions.jsonl'), JSON.stringify(s) + '\n')
    }
  }
}

/** A statement type whose posting is deadline-bound by the template (a `type` or `type#phase` window key). */
function windowGoverned(t: Template, type: unknown): boolean {
  if (typeof type !== 'string') return false
  return Object.keys(t.attestationWindows ?? {}).some((k) => k === type || k.startsWith(`${type}#`))
}

/** A claim's total must equal the exact sum of its items, in the asset's minor units. */
function checkClaimTotal(s: Statement, assets: Record<string, AssetDef>): void {
  const c = s.claim as { items?: Array<{ amount?: { currency?: string; value?: string } }>; total?: { currency?: string; value?: string } }
  const asset = Object.values(assets).find((a) => a.code === c.total?.currency)
  if (!asset || !Array.isArray(c.items) || typeof c.total?.value !== 'string') throw new Error('CLAIM_TOTAL: malformed claim')
  let sum = zero(asset.code)
  try {
    for (const i of c.items) {
      if (i.amount?.currency !== asset.code || typeof i.amount.value !== 'string') throw new Error('item currency differs from total')
      sum = sum.add(parseAmount(i.amount.value, asset))
    }
    if (sum.cmp(parseAmount(c.total.value, asset)) !== 0) throw new Error(`items sum to ${sum.minor} minor units, total is ${c.total.value}`)
  } catch (e) {
    throw new Error(`CLAIM_TOTAL: ${(e as Error).message}`)
  }
}

function seqOf(tx: Json): { sequence?: number; ticket?: number } {
  return Number(tx.TicketSequence ?? 0) > 0 ? { ticket: Number(tx.TicketSequence) } : { sequence: Number(tx.Sequence) }
}

function emptyLedger(account: string): LedgerSnapshot {
  return { index: 0, hash: '', closeTime: new Date(0).toISOString(), baseFeeDrops: '10', reserveIncDrops: '0', accounts: {}, balances: { [account]: {} }, credentials: [], history: {} }
}
