// The policy co-signer service (docs/spec/policy.md §6–§8, §12): for each request it pins a
// validated ledger, runs decide(), signs a cosigner.decision/1 record, and — only on SIGN — adds
// its multisig signature to exactly the transaction it evaluated.
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import xrpl from 'xrpl'
import * as keypairs from 'ripple-keypairs'
import { encodeForMultisigning } from 'ripple-binary-codec'
import { Amount, documentHash, formatAmount, newNonce, parseAmount, signStatementAsync, signerBlob, verifyStatement, zero, type AssetDef, type Signer, type Statement, type Template } from '@eng/core'
import {
  Assets, LedgerFacts, REGISTRY, TxFacts, baselineFor, canonicalTrust, celDurationMs, decide, decisionStatementBody, isClassicAddress, layerHash, nightsElapsed, resolvePolicy, resolvedAssets, withCanonicalTrust,
  type Decision, type EngagementRecord, type InflightEntry, type LedgerSnapshot, type PolicyDoc, verifyStatements,
} from '@eng/policy'
import type { LedgerSource } from './snapshot.ts'
import { combine, unsigned } from './xrpl-io.ts'
import { MemoryStateStore } from './store/memory.ts'
import { pinsOf, readDecisionsJsonl, resolvePins } from './store/restore.ts'
import type { DecideRequest, DecideResponse } from '@eng/ledger/decide'
import type { StateStore, StoreTx } from './store/types.ts'

type Json = Record<string, unknown>

// Compatibility shim. DecideRequest and DecideResponse live in @eng/ledger.
export type { DecideRequest, DecideResponse }

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

/** One stored pre-signed default, evaluated by tick(). */
export interface TickResult {
  outcome: string
  stage: string
  decision: 'SIGN' | 'REFUSE'
  failing: string[]
  /** Signed cosigner.decision/1 record. */
  record: Statement
  /** SIGN only: the fully signed, submittable blob (stored signatures + the co-signer's). */
  blob?: string
}

/** Proof that the co-signer received a statement in time: a co-signer-signed cosigner.receipt/1. */
export interface Receipt {
  statement: Statement
}

interface EngagementState {
  record: EngagementRecord
  /** The registration exactly as received; a re-registration must match it (R30). */
  registered: { record: EngagementRecord; mandate: Statement | null }
  mandate: Statement | null
  layers: PolicyDoc[]
  template: Template
  /** Receipted ("posted") attestations, keyed by statement id. Kept out of `record` (hashed into inputsHash). */
  attestations: Map<string, { statement: Statement; receipt: Receipt }>
  /** Pre-signed default blobs (all signatures but the finalSigner's), keyed by outcome name. */
  presigned: Map<string, string>
  /** tick() SIGN results keyed by proposedTxHash; returned again while that decision is in flight. */
  completed: Map<string, TickResult>
  /** Fingerprint (outcome + ':' + sorted failing ids) of the last logged tick refusal, keyed by outcome (quiet ticks). */
  lastRefusal: Map<string, string>
  /** Marked closed (its account is gone): still readable, no longer ticked. */
  closed: boolean
}

/**
 * An engagement restored with a pinned policy layer or template no longer in the library (design §2a.1): it still
 * answers reads, but decide / tick / ingest / storePresigned fail closed with ENGAGEMENT_STALE.
 */
interface StaleEngagement {
  record: EngagementRecord
  registered: { record: EngagementRecord; mandate: Statement | null }
  attestations: Map<string, { statement: Statement; receipt: Receipt }>
  closed: boolean
}

/**
 * One operation's changes to one engagement, staged (design §2a.2): the store writes are committed in one transaction
 * first, and only then are the staged values swapped into memory. A failed commit leaves memory as it was.
 */
interface Draft {
  st: EngagementState
  record: EngagementRecord
  /** This engagement's in-flight entries. */
  inflight: InflightRecord[]
  presigned: Map<string, string>
  completed: Map<string, TickResult>
  lastRefusal: Map<string, string>
  /** Decision records to append to the log. */
  log: Statement[]
  writes: Array<(tx: StoreTx) => Promise<unknown>>
}

export interface CosignerOptions {
  /** The co-signer's signer (a SignerList entry; never funded). Local or Privy-custodied. */
  signer: Signer
  source: LedgerSource
  templates: Template[]
  /** Policy library: the baseline plus template / engagement layers. */
  policies: PolicyDoc[]
  /** Optional directory for a best-effort export of the decision log (decisions.jsonl); the store is the source of truth. */
  dataDir?: string
  /** Durable state (default: a fresh MemoryStateStore). Only CosignerService.open() restores from it. */
  store?: StateStore
  historySecs?: number
  accreditation?: { issuer: string; credentialType: string }
  /**
   * Deploy config: slot name → classic address (ENG_RLUSD_ISSUER, ENG_ARBITER_ACCREDITOR, ENG_KYB_ISSUER).
   * The server always passes this map. With none of those variables set it is `{}`, including on loopback;
   * it is not left unset. An empty map means no deploy addresses: register() uses the record's own trust.
   * A non-empty map must match that trust. A missing slot on the record still fails with UNRESOLVED_SLOT.
   */
  trust?: Record<string, string>
}

const DAY = 86400

/** register() could not read the ledger it needs (the neutrality gate): retryable, not a verdict on the deal (HTTP 503). */
export class LedgerUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`LEDGER_UNAVAILABLE: ${String((cause as Error)?.message ?? cause)}`)
    this.name = 'LedgerUnavailableError'
  }
}
/** A statement may not be received more than this long after its issuedAt (bounds backdating). */
const MAX_ISSUE_LAG_SECS = 300

export class CosignerService {
  private readonly engagements = new Map<string, EngagementState>()
  /** Quarantined at restore (ENGAGEMENT_STALE); readable only. */
  private readonly stale = new Map<string, StaleEngagement>()
  private inflight: InflightRecord[] = []
  private readonly log: Statement[] = []
  /** Serialize decisions per engagement so in-flight accounting is race-free. */
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly trustDriftLogged = new Set<string>()
  private readonly store: StateStore
  private closing = false

  /**
   * A service with empty state, writing through to `o.store` (default: in memory). Durable stores must be opened with
   * `CosignerService.open` (it restores state and records/checks the signer).
   */
  constructor(private readonly o: CosignerOptions) {
    this.store = o.store ?? new MemoryStateStore()
  }

  /**
   * Open a service on `o.store` and rebuild its state (design §2.4, §2a): checks the store's signer (SIGNER_MISMATCH),
   * re-resolves each engagement's pinned layers and template (quarantining any that are gone or changed), and imports
   * `<dataDir>/decisions.jsonl` once into a store that has never recorded decisions.
   */
  static async open(o: CosignerOptions): Promise<CosignerService> {
    const svc = new CosignerService(o)
    await svc.restore()
    return svc
  }

  private async restore(): Promise<void> {
    const snap = await this.store.loadAll()
    const signer = snap.meta['signer.address']
    if (signer !== undefined && signer !== this.address) throw new Error(`SIGNER_MISMATCH: the store belongs to co-signer ${signer}, the configured signer is ${this.address}`)
    // One-time import of a pre-store decisions.jsonl. It runs at most once per store: jsonl.imported is written even when
    // the file is missing (count 0), so the jsonl this service later exports is never imported back.
    const importJsonl = this.o.dataDir !== undefined && snap.meta['jsonl.imported'] === undefined && !snap.decisions.length
    const imported = importJsonl ? readDecisionsJsonl(this.o.dataDir!) : undefined
    if (signer === undefined || imported) {
      await this.store.transaction(async (tx) => {
        if (signer === undefined) await tx.setMeta('signer.address', this.address)
        if (imported) {
          for (const s of imported) await tx.appendDecision(s)
          await tx.setMeta('jsonl.imported', String(imported.length))
        }
      })
    }
    const of = <T extends { engagementId: string }>(rows: T[], id: string): T[] => rows.filter((r) => r.engagementId === id)
    for (const e of snap.engagements) {
      const id = e.engagementId
      // The store returns these lists in insertion order, so the rebuilt Maps iterate as before the restart.
      const attestations = new Map(of(snap.attestations, id).map((a) => [a.statement.id, { statement: a.statement, receipt: a.receipt }]))
      const pinned = resolvePins(e.pins, this.o.policies, this.o.templates)
      this.noteTrustDrift(e.record)
      if ('reason' in pinned) {
        this.stale.set(id, { record: e.record, registered: e.registered, attestations, closed: e.closed })
        console.warn(`ENGAGEMENT_STALE: ${id}: ${pinned.reason}; quarantined (reads only)`)
        continue
      }
      this.engagements.set(id, {
        record: e.record, registered: e.registered, mandate: e.registered.mandate, layers: pinned.layers, template: pinned.template, attestations,
        presigned: new Map(of(snap.presigned, id).map((p) => [p.outcome, p.blob])),
        completed: new Map(of(snap.completed, id).map((c) => [c.txHash, c.result])),
        lastRefusal: new Map(of(snap.lastRefusal, id).map((r) => [r.outcome, r.fingerprint])),
        closed: e.closed,
      })
    }
    this.inflight = snap.inflight
    this.log.push(...snap.decisions.sort((a, b) => a.seq - b.seq).map((d) => d.statement), ...(imported ?? []))
  }

  /** Stop accepting mutating calls (they reject with "service closed"), wait for pending ones, then close the store. */
  async close(): Promise<void> {
    this.closing = true
    await Promise.all([...this.locks.values()])
    await this.store.close()
  }

  get address(): string { return this.o.signer.address }

  /** Registered engagements that are neither quarantined nor closed (the tick scheduler's work list). */
  openEngagementIds(): string[] {
    return [...this.engagements.values()].filter((s) => !s.closed).map((s) => s.record.engagementId)
  }

  /** Whether the engagement has any stored pre-signed default (without one a tick can never complete anything). */
  hasPendingDefaults(engagementId: string): boolean {
    return this.live(engagementId).presigned.size > 0
  }

  /** Whether the engagement's account is still on the ledger (a tick returns [] both for "gone" and "nothing due"). */
  async accountExists(engagementId: string): Promise<boolean> {
    const st = this.live(engagementId)
    const ledger = await this.o.source.snapshot({
      account: st.record.account, assets: this.assetsOf(st.layers, st.record), accounts: [], credentialSubjects: [], historySecs: this.o.historySecs ?? 90 * DAY,
    })
    return ledger.accounts[st.record.account]?.exists === true
  }

  /** Mark an engagement closed (its account is gone): persisted, then dropped from openEngagementIds(); reads still answer. */
  async markClosed(engagementId: string): Promise<void> {
    return this.serialized(engagementId, async () => {
      const st = this.engagements.get(engagementId) ?? this.stale.get(engagementId)
      if (!st) throw new Error(`unknown engagement ${engagementId}`)
      if (st.closed) return
      await this.store.transaction((tx) => tx.setClosed(engagementId))
      st.closed = true
    })
  }

  /** The engagement's working state; a quarantined engagement fails closed. */
  private live(engagementId: string): EngagementState {
    if (this.stale.has(engagementId)) throw new Error(`ENGAGEMENT_STALE: ${engagementId}`)
    const st = this.engagements.get(engagementId)
    if (!st) throw new Error(`unknown engagement ${engagementId}`)
    return st
  }

  /**
   * Register an engagement (normally done by the service at open, from the signed engagement record).
   * Registering an existing engagementId again is accepted only with the identical record and mandate, and keeps
   * all state (receipts, pre-signed defaults, completed decisions); anything else is ALREADY_REGISTERED.
   */
  async register(record: EngagementRecord, mandate: Statement | null = null): Promise<{ ok: true; layers: string[] }> {
    return this.serialized(record?.engagementId, () => this.registerLocked(record, mandate))
  }

  /**
   * Arbiter neutrality (chargeback spec §4.2): for a template with a role declaring `accreditation: "service"`, read a
   * fresh validated ledger and require that role's account to hold an accepted, unexpired credential of the effective
   * policy's `arbiterCredentialType` from one of its `arbiterIssuers`, to be none of the other parties, and to be in the
   * mandate's `allowedArbiters` when it lists any. Otherwise NOT_NEUTRAL and nothing is registered (a ledger error
   * is a LedgerUnavailableError, also registering nothing). For a template with per-night outcomes, the record's
   * terms must also check out first (stayTermsFindings, R30), or INVALID_TERMS and nothing is registered.
   */
  private async registerLocked(record: EngagementRecord, mandate: Statement | null): Promise<{ ok: true; layers: string[] }> {
    if (this.stale.has(record?.engagementId)) throw new Error(`ENGAGEMENT_STALE: ${record.engagementId}`)
    const existing = this.engagements.get(record?.engagementId)
    if (existing) {
      if (!isDeepStrictEqual(existing.registered, jsonCopy({ record, mandate }))) throw new Error(`ALREADY_REGISTERED: ${record.engagementId} is registered with a different record`)
      return { ok: true, layers: existing.layers.map((l) => `${l.policyId}@${l.version} ${layerHash(l)}`) }
    }
    const template = this.o.templates.find((t) => t.templateId === record.template)
    if (!template) throw new Error(`unknown template ${record.template}`)
    if (record.parties.cosigner && record.parties.cosigner !== this.address) throw new Error(`engagement names a different co-signer (${record.parties.cosigner})`)
    if (mandate && !verifyStatement(mandate).ok) throw new Error('mandate signature invalid')
    const baseline = baselineFor(template, this.o.policies)
    if (!baseline) throw new Error(template.baselineRef ? `baseline ${template.baselineRef} not available` : 'no baseline policy loaded')
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
    const all = [baseline, ...layers]
    // Canonical trust (sorted keys, exactly the slots these layers name). Throws UNRESOLVED_SLOT / BAD_ADDRESS / TRUST_KEY.
    const bound = withCanonicalTrust(record, all)
    this.requireConfiguredTrust(bound)
    const termsError = stayTermsFindings(bound, mandate, template, all)
    if (termsError) throw new Error(`INVALID_TERMS: ${termsError}`)
    const accredited = Object.entries(template.roles).filter(([, r]) => r.accreditation === 'service').map(([n]) => n)
    if (accredited.length) {
      const assets = this.assetsOf(all, bound)
      const subjects = accredited.map((r) => bound.parties[r]).filter((a): a is string => typeof a === 'string')
      let ledger: LedgerSnapshot
      try { ledger = await this.o.source.snapshot({ account: bound.account, assets, accounts: [], credentialSubjects: subjects, historySecs: 0 }) } catch (e) { throw new LedgerUnavailableError(e) }
      const codes = neutralityFindings(bound, mandate, accredited, all, new LedgerFacts(ledger, new Assets(assets)))
      if (codes.length) throw new Error(`NOT_NEUTRAL: ${codes.join(', ')}`)
    }
    const st: EngagementState = {
      record: structuredClone({ consumed: [], ...bound }), registered: jsonCopy({ record: bound, mandate }), mandate, layers: all, template,
      attestations: new Map(), presigned: new Map(), completed: new Map(), lastRefusal: new Map(), closed: false,
    }
    await this.store.transaction((tx) => tx.putEngagement({ engagementId: bound.engagementId, registered: st.registered, record: st.record, pins: pinsOf(all, template), closed: false }))
    this.engagements.set(bound.engagementId, st)
    return { ok: true, layers: all.map((l) => `${l.policyId}@${l.version} ${layerHash(l)}`) }
  }

  /** When deploy config is loaded, the record's addresses must be that config. Logs nothing: this is a refusal. */
  private requireConfiguredTrust(record: EngagementRecord): void {
    const cfg = this.o.trust
    // `{}` is what the server passes when no ENG_* address is set (loopback included). That is not a configured deployment.
    if (!cfg || Object.keys(cfg).length === 0) return
    for (const name of Object.keys(record.trust ?? {})) {
      const configured = cfg[name]
      const got = record.trust![name]
      if (configured === undefined) throw new Error(`UNRESOLVED_SLOT: ${name}`)
      if (!isClassicAddress(configured)) throw new Error(`BAD_ADDRESS: ${name}`)
      if (configured !== got) throw new Error(`TRUST_MISMATCH: ${name} record ${got} configured ${configured}`)
    }
  }

  /**
   * Stored trust against the current env. Warn only: the deal keeps the addresses it committed to.
   * The line is the slot name and the two addresses, nothing else from the record.
   */
  private noteTrustDrift(record: EngagementRecord): void {
    const cfg = this.o.trust
    if (!cfg || !record.trust) return
    for (const name of Object.keys(record.trust).sort()) {
      const stored = record.trust[name]
      const configured = cfg[name]
      if (configured === undefined || configured === stored) continue
      const line = `trust differs from env: slot ${name} stored ${stored} configured ${configured}`
      if (this.trustDriftLogged.has(line)) continue
      this.trustDriftLogged.add(line)
      console.warn(line)
    }
  }

  engagement(id: string): EngagementRecord | undefined { return (this.engagements.get(id) ?? this.stale.get(id))?.record }
  decisions(engagementId?: string): Statement[] { return engagementId ? this.log.filter((s) => s.engagementId === engagementId) : [...this.log] }
  inflightFor(engagementId: string): InflightRecord[] { return this.inflight.filter((i) => i.engagementId === engagementId) }

  /** Receipted statements with their receipts, in ingest order. */
  attestations(engagementId: string): Array<{ statement: Statement; receipt: Receipt }> {
    const st = this.engagements.get(engagementId) ?? this.stale.get(engagementId)
    if (!st) throw new Error(`unknown engagement ${engagementId}`)
    return [...st.attestations.values()]
  }

  /** Receipted statements for an engagement, in ingest order. */
  statements(engagementId: string): Statement[] {
    return [...((this.engagements.get(engagementId) ?? this.stale.get(engagementId))?.attestations.values() ?? [])].map((a) => a.statement)
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
    const st = this.live(engagementId)
    const v = verifyStatement(s)
    if (!v.ok) throw new Error(`BAD_STATEMENT: ${v.reason}`)
    const prior = st.attestations.get(s.id)
    if (prior) return prior.receipt
    if (s.engagementId !== engagementId) throw new Error(`WRONG_ENGAGEMENT: statement is for ${s.engagementId}`)
    const attester = s.attester.account
    const party = Object.values(st.record.parties).includes(attester)
    // Named by account, not by accreditation kind: a kind-only attester is still NOT_A_PARTY.
    const named = Object.values(st.record.attesters ?? {}).filter((t) => t.accounts?.includes(attester))
    if (!party && named.length === 0) throw new Error(`NOT_A_PARTY: ${attester}`)
    for (const terms of named) {
      if (terms.types && !terms.types.includes(s.type)) throw new Error(`TYPE_NOT_ALLOWED: ${s.type} is not in this attester's types`)
    }

    const assets = this.assetsOf(st.layers, st.record)
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
    if (s.type === 'party.ruling/1' && attester === st.record.parties.arbiter) {
      // A ruling is about a case: a receipted guest dispute or hotel claim. Otherwise an arbiter could pre-block defaults.
      const opened = this.caseOpenedAt(st)
      if (!opened) throw new Error('NO_CASE: no receipted dispute or claim for the arbiter to rule on')
      // The policy counts only rulings issued at/after the case opened: refuse one it would ignore, so a receipted ruling always counts.
      if (Date.parse(s.issuedAt) < opened.at) throw new Error(`EARLY_RULING: issued ${s.issuedAt}, before the case opened (${new Date(opened.at).toISOString()})`)
      // A ruling counts only if receipted by the deal's ruling deadline, so a late one can't block a due default.
      const due = this.rulingDeadline(st)
      // dispute.lateRuling "accept" (marketplace-escrow@1) still receipts a late ruling. Hotel has no dispute
      // block, so a ruling after the deadline stays LATE and cannot block a chargeback.
      if (st.template.dispute?.lateRuling !== 'accept' && due != null && received > due) throw new Error(`LATE: party.ruling/1 after the ruling deadline (${new Date(due).toISOString()})`)
    }
    const issued = Date.parse(s.issuedAt)
    if (Number.isNaN(issued) || received - issued > MAX_ISSUE_LAG_SECS * 1000) throw new Error(`STALE_ISSUED: issued ${s.issuedAt}, received ${ledger.closeTime}`)
    this.checkSequence(st, s, assets, ledger)
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
    await this.store.transaction((tx) => tx.putAttestation({ engagementId, statement: s, receipt }))
    st.attestations.set(s.id, { statement: s, receipt })
    return receipt
  }

  /**
   * marketplace-escrow@1 shipment order: nothing before open, and only the first receipted shipment counts.
   * Hotel has no `dispute` block, so it never reaches here.
   */
  private checkShipmentSequence(st: EngagementState, ledger: LedgerSnapshot): void {
    const open = Date.parse(st.record.timers?.open ?? '')
    if (Number.isNaN(open)) throw new Error('NO_DEADLINE: engagement has no timer open')
    if (Date.parse(ledger.closeTime) < open) throw new Error(`TOO_EARLY: a shipment cannot be receipted before open (${st.record.timers!.open})`)
    const posted = [...st.attestations.values()].map((a) => a.statement)
    if (posted.some((p) => p.type === 'shipping.shipped/1')) throw new Error('ALREADY_SHIPPED: only the first receipted shipment counts')
  }

  /**
   * A template-declared dispute (marketplace-escrow@1): one dispute, only from `dispute.by`, bonded as
   * amount + minDisputeBond with that party's ENG/DISPUTE credential. Hotel phase rules do not run.
   */
  private checkDeclaredDispute(st: EngagementState, s: Statement, assets: Record<string, AssetDef>, ledger: LedgerSnapshot): void {
    const dispute = st.template.dispute
    if (!dispute) return
    const { parties, account, amount } = st.record
    const posted = [...st.attestations.values()].map((a) => a.statement)
    if (posted.some((p) => p.type === 'party.dispute/1')) throw new Error('ALREADY_DISPUTED: this deal already has a receipted dispute; one dispute per deal')
    const role = Object.entries(parties).find(([, a]) => a === s.attester.account)?.[0]
    if (!role || !dispute.by.includes(role)) throw new Error(`NOT_DISPUTANT: ${s.attester.account}`)
    const asset = Object.values(assets).find((a) => a.code === (amount?.asset ?? st.record.asset))
    if (!asset || !amount) throw new Error('NOT_BONDED: the deal has no amount to bond against')
    const facts = new LedgerFacts(ledger, new Assets(assets))
    if (!facts.credentialExists(parties[role]!, account, disputeCredentialType(st.layers))) {
      throw new Error(`NOT_BONDED: post the ${disputeCredentialType(st.layers)} Credential and the bond (amount plus minDisputeBond) before the dispute statement`)
    }
    const bond = effectiveParam(st.layers, 'minDisputeBond')
    const base = dispute.bond?.base === 'amount' ? parseAmount(amount.value, asset) : undefined
    if (!base) throw new Error(`NOT_BONDED: dispute bond base ${JSON.stringify(dispute.bond?.base ?? null)} is not "amount"`)
    let need = base
    if (typeof bond === 'string') need = need.add(parseAmount(bond, asset))
    if (facts.balance(account, asset.code).cmp(need) < 0) {
      throw new Error(`NOT_BONDED: post the ${disputeCredentialType(st.layers)} Credential and the bond (amount plus minDisputeBond) before the dispute statement`)
    }
  }

  /** Receipt time and whether the attester is a party, for statements already stored. */
  private receiptAnchors(st: EngagementState): Map<string, { receivedAt: string; attesterIsParty: boolean }> {
    const parties = new Set(Object.values(st.record.parties))
    const map = new Map<string, { receivedAt: string; attesterIsParty: boolean }>()
    for (const { statement, receipt } of st.attestations.values()) {
      const receivedAt = (receipt.statement.claim as { receivedAt?: unknown }).receivedAt
      if (typeof receivedAt !== 'string') continue
      map.set(statement.id, { receivedAt, attesterIsParty: parties.has(statement.attester.account) })
    }
    return map
  }

  /**
   * Ordering rules no single statement can show (R28–R33, R38, R39): only the hotel confirms, and only once; an
   * entry dispute is filed from check-in on, and a receipted one (bonded at ingest: principal's ENG/DISPUTE Credential on
   * the account and the bond on the ledger) freezes the stay for good — no check-in can be recorded by either side, even
   * if the Credential is later deleted (R27); a recorded
   * check-in is final — once the hotel's checked_in is receipted it cannot be followed by refused (or anything else),
   * so a stay can't be turned into a no-show; a claim is posted from checkout on, once per deal,
   * itemized, positive, and capped at the deposit of the (first) confirmation.
   */
  private checkSequence(st: EngagementState, s: Statement, assets: Record<string, AssetDef>, ledger: LedgerSnapshot): void {
    const { parties } = st.record
    const posted = [...st.attestations.values()].map((a) => a.statement)
    const isConfirmation = (p: Statement) => p.type === 'party.confirmation/1' && p.attester.account === parties.counterparty
    const firstConfirmation = posted.find(isConfirmation)
    if (s.type === 'party.confirmation/1') {
      if (s.attester.account !== parties.counterparty) throw new Error(`NOT_COUNTERPARTY: only the counterparty confirms the booking (${s.attester.account})`)
      if (firstConfirmation) throw new Error('ALREADY_CONFIRMED: the booking already has a receipted confirmation')
    }
    if (st.template.dispute && s.type === 'shipping.shipped/1') this.checkShipmentSequence(st, ledger)
    if (s.type === 'party.dispute/1' && st.template.dispute) {
      this.checkDeclaredDispute(st, s, assets, ledger)
    } else if (s.type === 'party.dispute/1') {
      const isPrincipalDispute = (p: Statement) => p.type === 'party.dispute/1' && p.attester.account === parties.principal
      if (isPrincipalDispute(s) && posted.some(isPrincipalDispute)) throw new Error('ALREADY_DISPUTED: the guest already has a receipted dispute on this deal; one dispute per deal')
      const phase = (s.claim as { phase?: unknown }).phase
      const checkIn = Date.parse(st.record.timers?.checkIn ?? '')
      const deliveryBy = Date.parse(st.record.timers?.deliveryBy ?? '')
      const received = Date.parse(ledger.closeTime)
      // A dispute filed after the arbiter ruled on the hotel's claim would re-date the case and void that ruling. A claim
      // (and so a ruling with no dispute) exists only from checkout on, so this never blocks an entry or stay dispute
      // before checkout; at the checkout instant itself a stay dispute would re-date the case just the same.
      const ruled = posted.some((p) => p.type === 'party.ruling/1' && p.attester.account === parties.arbiter)
      if (isPrincipalDispute(s) && ruled && (phase === 'settlement' || (!Number.isNaN(deliveryBy) && received >= deliveryBy))) throw new Error('ALREADY_RULED: the arbiter has already ruled on the hotel\'s claim; a later dispute cannot reopen it')
      if (phase === 'entry') {
        if (!Number.isNaN(checkIn) && received < checkIn) throw new Error(`TOO_EARLY: an entry dispute can be filed from checkIn (${st.record.timers!.checkIn})`)
        // The guest's own acknowledgement (it has the keys) contradicts an arrival dispute, whatever the deposit (R29).
        const acknowledged = posted.some((p) => p.type === 'party.checkin/1' && p.attester.account === parties.principal && p.attester.account !== parties.counterparty && (p.claim as { status?: unknown }).status === 'checked_in')
        if (acknowledged) throw new Error('ACKNOWLEDGED: the guest acknowledged the check-in (it has the keys); an entry dispute no longer applies — file a stay dispute once the deposit is in')
        if (this.checkedIn(st, posted, assets, ledger)) throw new Error('NOT_ENTRY: the guest is checked in (check-in recorded and deposit in); file a stay dispute instead')
      }
      if (phase === 'settlement') {
        if (!Number.isNaN(deliveryBy) && received < deliveryBy) throw new Error(`TOO_EARLY: a settlement dispute can be filed from checkout (deliveryBy ${st.record.timers!.deliveryBy})`)
        // A guest never checked in has no stay to dispute (the entry/no-show track applies), and the bond threshold —
        // room + deposit + bond for a settlement dispute — must not depend on a deposit paid in after filing.
        if (!this.checkedIn(st, posted, assets, ledger)) throw new Error('NOT_CHECKED_IN: a settlement dispute needs a recorded check-in with the deposit in')
      }
      if (phase === 'stay') {
        if (!this.checkedIn(st, posted, assets, ledger)) throw new Error('NOT_CHECKED_IN: a stay dispute needs a recorded check-in with the deposit in; before that, file an entry dispute')
        // The stay chargeback is timed from issuedAt; it must fall in the same night (from the scheduled checkIn) as the receipt.
        if (Number.isNaN(checkIn)) throw new Error('NO_DEADLINE: engagement has no timer checkIn')
        const nIssued = nightsElapsed(checkIn, Date.parse(s.issuedAt))
        const nReceived = nightsElapsed(checkIn, received)
        if (nIssued !== nReceived) throw new Error(`NIGHT_MISMATCH: issued in night ${nIssued + 1} (${s.issuedAt}), received in night ${nReceived + 1} (${ledger.closeTime})`)
      }
      // The ruling clock starts only on an open dispute: the Credential and the bond must already be on the ledger.
      if (isPrincipalDispute(s) && !this.disputeBonded(st, posted, assets, ledger, phase)) throw new Error(`NOT_BONDED: post the ${disputeCredentialType(st.layers)} Credential and the bond (room, plus the deposit for a stay or settlement dispute, plus minDisputeBond in the account) before the dispute statement`)
    }
    const hotelCheckedIn = (p: Statement) => p.type === 'party.checkin/1' && p.attester.account === parties.counterparty && (p.claim as { status?: unknown }).status === 'checked_in'
    if (s.type === 'party.checkin/1' && s.attester.account === parties.counterparty && (s.claim as { status?: unknown }).status === 'checked_in') {
      // The hotel can't record a check-in before the scheduled check-in time, so it can't foreclose the entry window early.
      const checkIn = Date.parse(st.record.timers?.checkIn ?? '')
      if (!Number.isNaN(checkIn) && Date.parse(ledger.closeTime) < checkIn) throw new Error(`TOO_EARLY: the hotel can record a check-in from checkIn (${st.record.timers!.checkIn})`)
    }
    if (s.type === 'party.checkin/1' && s.attester.account === parties.principal && s.attester.account !== parties.counterparty) {
      // The guest's own acknowledgement (it has the keys): only "checked_in", and only after the hotel recorded the check-in.
      if ((s.claim as { status?: unknown }).status !== 'checked_in') throw new Error('BAD_CHECKIN: the guest\'s party.checkin/1 acknowledges a check-in (status "checked_in")')
      if (!posted.some(hotelCheckedIn)) throw new Error('NO_HOTEL_CHECKIN: the guest acknowledges a check-in only after the hotel has recorded it')
    }
    if (s.type === 'party.checkin/1' && s.attester.account === parties.counterparty && (s.claim as { status?: unknown }).status !== 'checked_in') {
      if (posted.some(hotelCheckedIn)) throw new Error(`CHECKIN_FINAL: the hotel already recorded the guest as checked in; a later ${String((s.claim as { status?: unknown }).status)} is not accepted`)
    }
    if (s.type === 'party.checkin/1' && (s.claim as { status?: unknown }).status === 'checked_in') {
      const entryDispute = posted.some((p) => p.type === 'party.dispute/1' && p.attester.account === parties.principal && (p.claim as { phase?: unknown }).phase === 'entry')
      // Any receipted entry dispute (bonded at ingest, R12) freezes the check-in for good: deleting the Credential later
      // withdraws nothing (R27), so neither the hotel nor the guest can record a check-in after it.
      if (entryDispute) throw new Error('ENTRY_DISPUTED: the guest disputed entry; a check-in can no longer be recorded')
    }
    if (s.type === 'party.claim/1') {
      // Claims are post-checkout by design: an early claim would open a "case" an arbiter could rule on before the guest
      // has anything to dispute, and a receipted ruling blocks the guest's later dispute (ALREADY_RULED).
      const deliveryBy = Date.parse(st.record.timers?.deliveryBy ?? '')
      if (s.attester.account === parties.counterparty && !Number.isNaN(deliveryBy) && Date.parse(ledger.closeTime) < deliveryBy) throw new Error(`TOO_EARLY: a claim can be posted from checkout (deliveryBy ${st.record.timers!.deliveryBy})`)
      if (s.attester.account === parties.counterparty && posted.some((p) => p.type === 'party.claim/1' && p.attester.account === parties.counterparty)) throw new Error('ALREADY_CLAIMED: the hotel already has a receipted claim on this deal; one claim per deal')
      checkClaimTotal(s, assets)
      const c = s.claim as { items: Array<{ amount: { value: string } }>; total: { currency: string; value: string } }
      const asset = Object.values(assets).find((a) => a.code === c.total.currency)!
      if (!c.items.length) throw new Error('CLAIM_INVALID: a claim needs at least one item')
      if (c.items.some((i) => parseAmount(i.amount.value, asset).cmp(zero(asset.code)) <= 0)) throw new Error('CLAIM_INVALID: every item amount must be positive')
      const dep = (firstConfirmation?.claim as { deposit?: { currency?: string; value?: string } } | undefined)?.deposit
      let cap
      try { cap = dep?.currency === asset.code && typeof dep.value === 'string' ? parseAmount(dep.value, asset) : undefined } catch { cap = undefined }
      if (!cap) throw new Error('CLAIM_OVER_DEPOSIT: no confirmed deposit to claim against')
      if (parseAmount(c.total.value, asset).cmp(cap) > 0) throw new Error(`CLAIM_OVER_DEPOSIT: claim ${c.total.value} exceeds the confirmed deposit ${dep!.value}`)
    }
  }

  /**
   * Checked in (as the policy's def.checkedIn): the hotel's checked_in and the guest's own acknowledgement (a principal
   * party.checkin/1 "checked_in", R23) are receipted, and the balance covers booked + the first confirmation's deposit —
   * so a hotel paying the deposit in itself can't put a guest who never got the keys on the stay track.
   */
  private checkedIn(st: EngagementState, posted: Statement[], assets: Record<string, AssetDef>, ledger: LedgerSnapshot): boolean {
    const { parties, account, amount } = st.record
    const conf = posted.find((p) => p.type === 'party.confirmation/1' && p.attester.account === parties.counterparty)
    const says = (role: string) => posted.some((p) => p.type === 'party.checkin/1' && p.attester.account === parties[role] && (p.claim as { status?: unknown }).status === 'checked_in')
    if (!conf || !says('counterparty') || !says('principal')) return false
    const asset = Object.values(assets).find((a) => a.code === (amount?.asset ?? st.record.asset))
    const dep = (conf.claim as { deposit?: { currency?: string; value?: string } }).deposit
    if (!asset || !amount || dep?.currency !== asset.code || typeof dep.value !== 'string') return false
    try {
      const need = parseAmount(amount.value, asset).add(parseAmount(dep.value, asset))
      return new LedgerFacts(ledger, new Assets(assets)).balance(account, asset.code).cmp(need) >= 0
    } catch {
      return false
    }
  }

  /**
   * The deal's ruling deadline (epoch ms), as the policy computes it: the principal's dispute's issuedAt, floored at
   * checkout (settlement) or the scheduled check-in (entry, stay), plus the ruling window (the record's
   * terms.rulingWindow, else the policy's params.rulingWindow). With no dispute but a hotel claim posted, the claim
   * lapses at disputeWindowEnds + the ruling window. Undefined when neither applies or the deal has no ruling window.
   */
  private rulingDeadline(st: EngagementState): number | undefined {
    const raw = st.record.terms?.rulingWindow ?? effectiveParam(st.layers, 'rulingWindow')
    if (typeof raw !== 'string') return undefined
    let window: number
    try { window = celDurationMs(raw) } catch { throw new Error(`NO_DEADLINE: rulingWindow ${JSON.stringify(raw)} is not a duration`) }
    const opened = this.caseOpenedAt(st)
    if (!opened) return undefined
    if (opened.kind === 'dispute') return opened.at + window
    const end = Date.parse(st.record.timers?.disputeWindowEnds ?? '')
    return Number.isNaN(end) ? undefined : end + window
  }

  /**
   * When the case the arbiter rules on opened, as the policy's def.arbiterRulings filter sees it: the principal's
   * dispute's issuedAt floored at checkout (settlement) or the scheduled check-in (entry, stay) — def.disputeOpenedAt —
   * else the latest (by issuedAt) hotel claim's issuedAt. Undefined when neither is receipted.
   */
  private caseOpenedAt(st: EngagementState): { kind: 'dispute' | 'claim'; at: number } | undefined {
    const { parties, timers } = st.record
    const posted = [...st.attestations.values()].map((a) => a.statement)
    const d = posted.find((p) => p.type === 'party.dispute/1' && p.attester.account === parties.principal)
    if (d) {
      // A template-declared dispute (marketplace-escrow@1) opens at the dispute's issuedAt. No hotel anchor.
      if (st.template.dispute) return { kind: 'dispute', at: Date.parse(d.issuedAt) }
      const anchor = Date.parse(((d.claim as { phase?: unknown }).phase === 'settlement' ? timers?.deliveryBy : timers?.checkIn) ?? '')
      const issued = Date.parse(d.issuedAt)
      return { kind: 'dispute', at: Number.isNaN(anchor) ? issued : Math.max(issued, anchor) }
    }
    const claims = posted.filter((p) => p.type === 'party.claim/1' && p.attester.account === parties.counterparty).map((p) => Date.parse(p.issuedAt))
    return claims.length ? { kind: 'claim', at: Math.max(...claims) } : undefined
  }

  /**
   * Whether a principal dispute may be receipted (R12), at this ledger: the principal's Credential of the policy's
   * disputeCredentialType (ENG/DISPUTE) is on the
   * account and the balance covers booked + minDisputeBond, plus the first confirmation's deposit for a stay or settlement dispute (never
   * for an entry dispute). The term is fixed by the dispute's phase, not by whether the guest is checked in, so no
   * payment into the account can move an open dispute's threshold. Only ingest checks the Credential: once receipted, a
   * dispute stays open on the balance threshold alone (the policy's def.disputeOpen, R27) — deleting the Credential
   * withdraws nothing, so a dispute can't be withdrawn and revived after the arbiter's deadline.
   */
  private disputeBonded(st: EngagementState, posted: Statement[], assets: Record<string, AssetDef>, ledger: LedgerSnapshot, phase: unknown): boolean {
    const { parties, account, amount } = st.record
    const asset = Object.values(assets).find((a) => a.code === (amount?.asset ?? st.record.asset))
    if (!asset || !amount) return false
    const facts = new LedgerFacts(ledger, new Assets(assets))
    if (!facts.credentialExists(parties.principal!, account, disputeCredentialType(st.layers))) return false
    const bond = [...st.layers].reverse().map((l) => (l.params as { minDisputeBond?: unknown } | undefined)?.minDisputeBond).find((b) => typeof b === 'string') as string | undefined
    let need = parseAmount(amount.value, asset).add(bond ? parseAmount(bond, asset) : zero(asset.code))
    if (phase !== 'entry') {
      const conf = posted.find((p) => p.type === 'party.confirmation/1' && p.attester.account === parties.counterparty)
      const dep = (conf?.claim as { deposit?: { currency?: string; value?: string } } | undefined)?.deposit
      if (dep?.currency !== asset.code || typeof dep.value !== 'string') return false
      try { need = need.add(parseAmount(dep.value, asset)) } catch { return false }
    }
    return facts.balance(account, asset.code).cmp(need) >= 0
  }

  /**
   * Store a pre-signed default (spec §5.4): the blob must carry exactly the outcome's signer set minus its
   * finalSigner, each signature valid over this exact transaction, and be a Ticket-based transaction (no
   * LastLedgerSequence) of the engagement account matching the outcome's blueprint. Otherwise nothing is stored.
   */
  async storePresigned(engagementId: string, outcome: string, blob: string): Promise<void> {
    return this.serialized(engagementId, () => this.storePresignedLocked(engagementId, outcome, blob))
  }

  private async storePresignedLocked(engagementId: string, outcome: string, blob: string): Promise<void> {
    const st = this.live(engagementId)
    const [base, variant] = splitVariant(outcome)
    const o = st.template.outcomes[base]
    if (!o?.presigned || !o.finalSigner) throw new Error(`NOT_PRESIGNED: ${base} is not a pre-signed outcome of ${st.template.templateId}`)
    if (o.variants?.perNight || variant !== undefined) {
      // A per-night outcome is stored once per night k = 1 … nights − 1 as "<outcome>#k"; a stay longer than max + 1
      // nights has none (spec §4.5.1). Which variant applies is the policy's call at tick time.
      if (!o.variants?.perNight) throw new Error(`BAD_VARIANT: ${base} has no per-night variants`)
      if (variant === undefined || !/^[1-9]\d*$/.test(variant)) throw new Error(`BAD_VARIANT: name the night of ${base} as ${base}#<k>, k = 1, 2, …`)
      const k = Number(variant)
      const nights = st.record.terms?.nights
      if (typeof nights !== 'number' || !Number.isInteger(nights) || nights < 2) throw new Error(`BAD_VARIANT: the deal has no per-night terms (terms.nights ${JSON.stringify(nights ?? null)})`)
      if (nights - 1 > o.variants.max) throw new Error(`BAD_VARIANT: a ${nights}-night stay has no ${base} variants (at most ${o.variants.max + 1} nights)`)
      if (k > nights - 1) throw new Error(`BAD_VARIANT: ${outcome}: a ${nights}-night stay has variants #1 … #${nights - 1}`)
    }
    let decoded: Json
    try { decoded = xrpl.decode(blob) as Json } catch (e) { throw new Error(`BAD_BLOB: ${(e as Error).message}`) }
    const signers = ((decoded.Signers ?? []) as Array<{ Signer?: { Account?: string; SigningPubKey?: string; TxnSignature?: string } }>).map((s) => s.Signer ?? {})
    const tx = unsigned(decoded)

    if (tx.Account !== st.record.account) throw new Error(`WRONG_ACCOUNT: blob is for ${String(tx.Account)}`)
    const ticketed = (t: Json) => Number(t.TicketSequence ?? 0) > 0 && Number(t.Sequence ?? 0) === 0 && t.LastLedgerSequence == null
    const inner = ((tx.RawTransactions ?? []) as Array<{ RawTransaction: Json }>).map((r) => r.RawTransaction)
    if (!ticketed(tx) || !inner.every(ticketed)) throw new Error('TICKETS: a pre-signed default must use Tickets and no LastLedgerSequence')

    // Signers: exactly one allowed set minus the finalSigner, each account once.
    const accounts = signers.map((s) => s.Account)
    const want = o.signers.filter((set) => set.includes(o.finalSigner!)).map((set) => set.filter((r) => r !== o.finalSigner).map((r) => st.record.parties[r]))
    const exact = (set: Array<string | undefined>) => set.every(Boolean) && set.length === accounts.length && new Set(accounts).size === accounts.length && set.every((a) => accounts.includes(a))
    if (!want.some(exact)) throw new Error(`SIGNERS: blob is signed by {${accounts.join(', ')}}, ${outcome} needs ${want.map((w) => `{${w.join(', ')}}`).join(' or ')}`)
    for (const s of signers) {
      let ok = false
      try {
        ok = keypairs.deriveAddress(s.SigningPubKey!) === s.Account && keypairs.verify(encodeForMultisigning(tx as never, s.Account!), s.TxnSignature!, s.SigningPubKey!)
      } catch { ok = false }
      if (!ok) throw new Error(`BAD_SIGNATURE: ${s.Account} signature does not verify`)
    }

    const facts = new TxFacts(tx, { eng: st.record, template: st.template, assets: new Assets(this.assetsOf(st.layers, st.record)), ledger: emptyLedger(st.record.account) })
    if (!facts.matchesBlueprint(o.blueprint)) throw new Error(`BLUEPRINT: blob does not match ${o.blueprint}`)
    // A chargeback blob must match its slot: its eng/basis names the outcome, and a per-night variant #k pays the
    // hotel (with the fee) exactly k nights, so the stored name says what the transaction does.
    if (base.startsWith('default.chargeback') || o.variants?.perNight) {
      const basis = facts.memo('eng/basis')
      if (basis !== base) throw new Error(`SLOT_MISMATCH: blob's eng/basis is ${JSON.stringify(basis)}, expected ${base}`)
      if (variant !== undefined) {
        const code = st.template.asset.code
        const asset = this.assetsOf(st.layers, st.record)[code]
        let nightly
        try { nightly = parseAmount(String(st.record.terms!.nightly), asset) } catch { throw new Error(`SLOT_MISMATCH: the deal's terms.nightly ${JSON.stringify(st.record.terms!.nightly)} is not an amount`) }
        const hotel = facts.payouts.to(st.record.parties.counterparty!, code).add(facts.payouts.to(st.record.fee!.to, code))
        const want = nightly.minor * BigInt(variant)
        if (hotel.minor !== want) throw new Error(`SLOT_MISMATCH: ${outcome} pays the hotel and fee ${hotel.minor} minor units, ${variant} nights are ${want}`)
      }
    }

    // Store the canonical multisign form (outer SigningPubKey '', no TxnSignature) — exactly what the
    // signatures cover — and prove now that the co-signer's signature will combine with it.
    const canonical = xrpl.encode({ ...tx, Signers: decoded.Signers } as never)
    try {
      combine([canonical, xrpl.encode({ ...tx, Signers: [{ Signer: { Account: this.address, SigningPubKey: this.o.signer.publicKey, TxnSignature: 'AB'.repeat(35) } }] } as never)])
    } catch (e) {
      throw new Error(`BAD_BLOB: does not combine: ${(e as Error).message}`)
    }
    const existing = st.presigned.get(outcome)
    if (existing === canonical) return
    if (existing && this.signedInFlight(st, existing)) throw new Error(`IN_FLIGHT: ${outcome} has a signed transaction in flight; it cannot be replaced`)
    // A new blob for the outcome starts a fresh quiet-tick history: its next refusal is logged.
    const hadRefusal = st.lastRefusal.has(outcome)
    await this.store.transaction(async (tx) => {
      await tx.putPresigned(engagementId, outcome, canonical)
      if (hadRefusal) await tx.deleteLastRefusal(engagementId, outcome)
    })
    st.presigned.set(outcome, canonical)
    st.lastRefusal.delete(outcome)
  }

  private signedInFlight(st: EngagementState, blob: string): boolean {
    const txHash = documentHash(unsigned(xrpl.decode(blob) as Json))
    return this.inflight.some((i) => i.engagementId === st.record.engagementId && i.proposedTxHash === txHash)
  }

  /**
   * Evaluate every stored pre-signed default at a pinned validated ledger (spec §5.4). On SIGN the result
   * carries the completed, submittable blob; submission is the caller's job. A default whose SIGN is still in
   * flight returns the same result rather than being re-signed. A default any of whose Tickets is gone can never
   * apply: it is retired and reported once as TICKET_CONSUMED. One outcome's failure is reported as TICK_ERROR for
   * that outcome and does not stop the others. A deleted account has nothing left to complete.
   */
  async tick(engagementId: string, o: { quiet?: boolean } = {}): Promise<TickResult[]> {
    return this.serialized(engagementId, () => this.tickLocked(engagementId, o.quiet === true))
  }

  /**
   * One tick is one store transaction: every decision record, in-flight change, completed result and retired blob of
   * this tick commits together before any result (or blob) is returned. In quiet mode a REFUSE identical to the last
   * logged one for its outcome (same failing rules) is returned but not logged again (design §2a.4).
   */
  private async tickLocked(engagementId: string, quiet: boolean): Promise<TickResult[]> {
    const st = this.live(engagementId)
    if (st.closed || !st.presigned.size) return []
    const ledger = await this.o.source.snapshot({
      account: st.record.account, assets: this.assetsOf(st.layers, st.record), accounts: [], credentialSubjects: [], historySecs: this.o.historySecs ?? 90 * DAY,
    })
    if (!ledger.accounts[st.record.account]?.exists) return []
    const draft = this.draft(st)
    this.resolveInflight(draft, ledger)

    const out: TickResult[] = []
    // A snapshot without owner objects says nothing about Tickets: skip the check rather than retire (R35).
    const owned = ledger.accounts[st.record.account]?.ownerObjects
    const tickets = owned ? new Set(owned.tickets ?? []) : null
    for (const [outcome, stored] of [...draft.presigned]) {
      // A per-night variant ("<outcome>#k") is decided under its outcome's stage; the result keeps the #k name.
      const base = splitVariant(outcome)[0]
      const stage = st.template.outcomes[base]?.policyStage ?? base
      const tx = unsigned(xrpl.decode(stored) as Json)
      const txHash = documentHash(tx)
      const prior = draft.completed.get(txHash)
      if (prior && draft.inflight.some((i) => i.proposedTxHash === txHash)) { out.push(prior); continue }
      if (draft.completed.delete(txHash)) draft.writes.push((w) => w.deleteCompleted(engagementId, txHash))

      const used = [tx, ...((tx.RawTransactions ?? []) as Array<{ RawTransaction: Json }>).map((r) => r.RawTransaction)].map((t) => Number(t.TicketSequence))
      const gone = tickets ? used.filter((t) => !tickets.has(t)) : []
      if (gone.length) {
        draft.presigned.delete(outcome)
        draft.writes.push((w) => w.deletePresigned(engagementId, outcome))
        // The retired blob's completed results go with it.
        for (const [h, c] of [...draft.completed]) {
          if (c.outcome !== outcome) continue
          draft.completed.delete(h)
          draft.writes.push((w) => w.deleteCompleted(engagementId, h))
        }
        const record = await this.refusalRecord(st, ledger, stage, txHash, { id: 'TICKET_CONSUMED', result: 'fail', reason: 'TICKET_CONSUMED', message: `Tickets ${gone.join(', ')} are no longer on the account; the pre-signed default can never apply.` })
        this.logTickRefusal(draft, outcome, ['TICKET_CONSUMED'], record, quiet)
        out.push({ outcome, stage, decision: 'REFUSE', failing: ['TICKET_CONSUMED'], record })
        continue
      }

      let r: DecideResponse | undefined
      try {
        r = await this.decideDraft(draft, { engagementId, stage, txBlob: stored }, { outcome, quiet })
        const res: TickResult = { outcome, stage, decision: r.decision, failing: r.failing, record: r.record }
        if (r.decision === 'SIGN') this.resetTickRefusal(draft, outcome)
        if (r.decision === 'SIGN' && r.signerBlob) {
          res.blob = combine([stored, r.signerBlob])
          draft.completed.set(txHash, res)
          draft.writes.push((w) => w.putCompleted(engagementId, txHash, res))
        }
        out.push(res)
      } catch (e) {
        // Never leave a signed-but-undelivered decision in flight: it would block other outcomes (B9).
        const i = r ? draft.inflight.findIndex((f) => f.decisionId === r!.record.id) : -1
        if (i >= 0) {
          const [f] = draft.inflight.splice(i, 1)
          draft.writes.push((w) => w.removeInflight(engagementId, f.proposedTxHash))
        }
        const message = String((e as Error)?.message ?? e)
        const record = await this.refusalRecord(st, ledger, stage, txHash, { id: 'TICK_ERROR', result: 'error', reason: 'TICK_ERROR', message, error: message.split('\n')[0] })
        this.logTickRefusal(draft, outcome, ['TICK_ERROR'], record, quiet)
        out.push({ outcome, stage, decision: 'REFUSE', failing: ['TICK_ERROR'], record })
      }
    }
    await this.commit(draft)
    return out
  }

  /**
   * Log a tick refusal and remember its fingerprint for its outcome, unless this is a quiet tick and the fingerprint
   * equals the last logged one (then the refusal is returned to the caller but not logged). A SIGN, or a newly stored
   * blob for the outcome, forgets it (resetTickRefusal, storePresigned).
   */
  private logTickRefusal(draft: Draft, outcome: string, failing: string[], record: Statement, quiet: boolean): void {
    const fingerprint = `${outcome}:${[...failing].sort().join(',')}`
    const last = draft.lastRefusal.get(outcome)
    if (quiet && last === fingerprint) return
    this.logDecision(draft, record)
    if (last !== fingerprint) {
      draft.lastRefusal.set(outcome, fingerprint)
      const id = draft.record.engagementId
      draft.writes.push((w) => w.setLastRefusal(id, outcome, fingerprint))
    }
  }

  /** A tick SIGN for an outcome ends its run of refusals: forget the fingerprint, so the next refusal is logged. */
  private resetTickRefusal(draft: Draft, outcome: string): void {
    if (!draft.lastRefusal.delete(outcome)) return
    const id = draft.record.engagementId
    draft.writes.push((w) => w.deleteLastRefusal(id, outcome))
  }

  /** A signed cosigner.decision/1 REFUSE record for a refusal the co-signer makes itself, outside policy evaluation. */
  private async refusalRecord(st: EngagementState, ledger: LedgerSnapshot, stage: string, proposedTxHash: string, result: Omit<Decision['results'][number], 'layer'>): Promise<Statement> {
    const layers = st.layers.map((l) => `${l.policyId}@${l.version} ${layerHash(l)}`)
    const pinned = { index: ledger.index, hash: ledger.hash, closeTime: ledger.closeTime }
    const d: Decision = {
      decision: 'REFUSE', stage, engagementId: st.record.engagementId,
      results: [{ layer: 'cosigner', ...result }], failing: [result.id],
      statementsUsed: [], statementsRejected: [], inflightCounted: [], ledger: pinned,
      policy: { effectiveHash: documentHash(st.layers), layers },
      inputsHash: documentHash({ engagementId: st.record.engagementId, stage, proposedTxHash, ledger: { index: ledger.index, hash: ledger.hash }, check: result.id }),
      costUnits: 0, proposedTxHash,
    }
    return signStatementAsync(decisionStatementBody(d, { account: this.address, accreditation: this.o.accreditation }, newNonce()), this.o.signer)
  }

  /** Serialize work per engagement so in-flight accounting and the attestation store are race-free. */
  private serialized<T>(engagementId: string, fn: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('CLOSED: the co-signer service is closed'))
    const prev = this.locks.get(engagementId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    this.locks.set(engagementId, run.catch(() => undefined))
    return run
  }

  private async decideLocked(req: DecideRequest): Promise<DecideResponse> {
    const draft = this.draft(this.live(req.engagementId))
    const out = await this.decideDraft(draft, req)
    await this.commit(draft)
    return out
  }

  /**
   * decide() into a draft: the decision record, in-flight resolution and the new in-flight entry are staged, not
   * applied. In a tick (`tick` set) a REFUSE goes through logTickRefusal (quiet mode, fingerprint).
   */
  private async decideDraft(draft: Draft, req: DecideRequest, tick?: { outcome: string; quiet: boolean }): Promise<DecideResponse> {
    const { st } = draft
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
    const assets = this.assetsOf(st.layers, st.record)

    // Snapshot: key state for attesters; credentials for payees, attesters and the account.
    const attesters = [...statements, ...(st.mandate ? [st.mandate] : [])].map((s) => s.attester?.account).filter(Boolean) as string[]
    const payees = tx ? new TxFacts(tx, { eng: st.record, template: st.template, assets: new Assets(assets), ledger: emptyLedger(st.record.account) }).payouts.destinations() : []
    const ledger = await this.o.source.snapshot({
      account: st.record.account, assets, accounts: attesters, credentialSubjects: [...payees, ...attesters], payees,
      historySecs: this.o.historySecs ?? 90 * DAY,
    })

    // Resolve in-flight decisions against this ledger, then reserve single-use statements.
    this.resolveInflight(draft, ledger)
    const txHash = tx ? documentHash(tx) : null
    // A re-request for a transaction already signed (same hash, same sequence) must not count against itself.
    const mine = draft.inflight.filter((i) => i.proposedTxHash !== txHash)
    const reserved = mine.flatMap((i) => i.reserved)
    const engagement: EngagementRecord = { ...draft.record, consumed: [...(draft.record.consumed ?? []), ...reserved] }

    const decided = decide({
      stage: req.stage, proposedTx: tx, engagement, template: st.template, layers: st.layers,
      mandate: st.mandate, statements, ledger, receipted: this.receiptAnchors(st),
      inflight: mine.map(({ decisionId, txHash, lastLedgerSequence, payouts }) => ({ decisionId, txHash, lastLedgerSequence, payouts })),
    })
    const d: Decision = notReceipted.length ? { ...decided, statementsRejected: [...notReceipted, ...decided.statementsRejected] } : decided

    const intentHash = tx ? new TxFacts(tx, { eng: engagement, template: st.template, assets: new Assets(assets), ledger }).intentHash() : ''
    const record = await signStatementAsync(decisionStatementBody(d, { account: this.address, accreditation: this.o.accreditation }, newNonce(), intentHash || undefined), this.o.signer)
    if (tick && d.decision === 'REFUSE') this.logTickRefusal(draft, tick.outcome, d.failing, record, tick.quiet)
    else this.logDecision(draft, record)

    const signs = this.signsStage(st.template, req.stage)
    const out: DecideResponse = { decision: d.decision, failing: d.failing, results: d.results, statementsRejected: d.statementsRejected, record, tx, ...(signs ? {} : { advisory: true }) }
    if (d.decision === 'SIGN' && tx && signs) {
      out.signerBlob = await signerBlob(this.o.signer, tx)
      const facts = new TxFacts(tx, { eng: engagement, template: st.template, assets: new Assets(assets), ledger })
      const used = new Set(d.statementsUsed)
      const dup = draft.inflight.findIndex((i) => i.proposedTxHash === txHash)
      if (dup >= 0) {
        draft.inflight.splice(dup, 1)
        draft.writes.push((w) => w.removeInflight(st.record.engagementId, txHash!))
      }
      const entry: InflightRecord = {
        proposedTxHash: txHash!,
        engagementId: st.record.engagementId,
        decisionId: record.id,
        lastLedgerSequence: tx.LastLedgerSequence != null ? Number(tx.LastLedgerSequence) : undefined,
        payouts: facts.payouts.items.map((p) => ({ to: p.to, asset: p.asset, value: p.value })),
        outer: seqOf(tx),
        payments: facts.innerRaw.filter((i) => i.TransactionType === 'Payment').map(seqOf),
        reserved: statements.filter((s) => used.has(s.id) && REGISTRY[s.type]?.singleUse).map((s) => s.id),
        decidedAtLedger: ledger.index,
      }
      draft.inflight.push(entry)
      draft.writes.push((w) => w.addInflight(entry))
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
  private resolveInflight(draft: Draft, ledger: LedgerSnapshot): void {
    const { account, engagementId } = draft.record
    const acct = ledger.accounts[account]
    const hist = ledger.history[account] ?? []
    for (let i = draft.inflight.length - 1; i >= 0; i--) {
      const f = draft.inflight[i]
      const consumed = !acct?.exists
        || (f.outer.sequence != null && acct.sequence != null && acct.sequence > f.outer.sequence)
        || (f.outer.ticket != null && !(acct.ownerObjects?.tickets ?? []).includes(f.outer.ticket))
      const expired = f.lastLedgerSequence != null && ledger.index > f.lastLedgerSequence
      if (!consumed && !expired) continue
      const succeeded = consumed && f.payments.some((p) => hist.some((h) => (p.sequence != null && h.sequence === p.sequence) || (p.ticket != null && h.ticket === p.ticket)))
      if (succeeded) {
        const next = [...new Set([...(draft.record.consumed ?? []), ...f.reserved])]
        draft.record = { ...draft.record, consumed: next }
        draft.writes.push((w) => w.setConsumed(engagementId, next))
      }
      draft.inflight.splice(i, 1)
      draft.writes.push((w) => w.removeInflight(engagementId, f.proposedTxHash))
    }
  }

  /** Resolved asset map for ledger reads and issuer checks. Does not mutate `layers`. */
  private assetsOf(layers: PolicyDoc[], record: EngagementRecord): Record<string, AssetDef> {
    return resolvedAssets(layers, record.trust)
  }

  /** Stage the engagement's mutable state for one operation (see Draft). */
  private draft(st: EngagementState): Draft {
    return {
      st, record: st.record, inflight: this.inflightFor(st.record.engagementId),
      presigned: new Map(st.presigned), completed: new Map(st.completed), lastRefusal: new Map(st.lastRefusal),
      log: [], writes: [],
    }
  }

  private logDecision(draft: Draft, s: Statement): void {
    draft.log.push(s)
    draft.writes.push((w) => w.appendDecision(s))
  }

  /**
   * Commit a draft: its writes in one store transaction first; only if that commits, swap the staged state into memory.
   * A failed commit throws and leaves memory exactly as it was. The decisions.jsonl export follows, best-effort.
   */
  private async commit(draft: Draft): Promise<void> {
    if (draft.writes.length) {
      await this.store.transaction(async (tx) => {
        for (const write of draft.writes) await write(tx)
      })
    }
    const { st } = draft
    const id = st.record.engagementId
    st.record = draft.record
    st.presigned = draft.presigned
    st.completed = draft.completed
    st.lastRefusal = draft.lastRefusal
    this.inflight = [...this.inflight.filter((i) => i.engagementId !== id), ...draft.inflight]
    this.log.push(...draft.log)
    this.exportDecisions(draft.log)
  }

  /** Append committed decision records to `<dataDir>/decisions.jsonl` (an optional export; a failure is only warned). */
  private exportDecisions(records: Statement[]): void {
    if (!this.o.dataDir || !records.length) return
    try {
      fs.mkdirSync(this.o.dataDir, { recursive: true })
      fs.appendFileSync(path.join(this.o.dataDir, 'decisions.jsonl'), records.map((s) => JSON.stringify(s) + '\n').join(''))
    } catch (e) {
      console.warn(`decisions.jsonl export failed: ${String((e as Error)?.message ?? e)}`)
    }
  }
}

/** "default.chargebackStay#2" → ["default.chargebackStay", "2"]; a name without '#' → [name, undefined]. */
function splitVariant(outcome: string): [string, string | undefined] {
  const i = outcome.indexOf('#')
  return i < 0 ? [outcome, undefined] : [outcome.slice(0, i), outcome.slice(i + 1)]
}

/** A policy parameter from the effective policy (the last layer that sets it wins). */
function effectiveParam(layers: PolicyDoc[], name: string): unknown {
  return [...layers].reverse().map((l) => (l.params as Record<string, unknown> | undefined)?.[name]).find((v) => v !== undefined)
}

/** The policy's dispute Credential type (params.disputeCredentialType); ENG/DISPUTE for policies that predate the param. */
function disputeCredentialType(layers: PolicyDoc[]): string {
  const t = effectiveParam(layers, 'disputeCredentialType')
  return typeof t === 'string' ? t : 'ENG/DISPUTE'
}

/**
 * Per-night terms (R30), for a template with a per-night outcome: the record pins terms; terms.nights is the booked
 * stay (from the confirmation's check-in/check-out dates — none is receipted at registration, and the policy counts a
 * confirmation only with the mandate's dates — so the mandate's); terms.nightly = floor(amount ÷ nights) in the
 * asset's minor units; the ruling window (terms.rulingWindow, else params.rulingWindow) parses and lies within
 * params.minRulingWindow / maxRulingWindow. Returns the first problem, or undefined.
 */
function stayTermsFindings(record: EngagementRecord, mandate: Statement | null, template: Template, layers: PolicyDoc[]): string | undefined {
  if (!Object.values(template.outcomes).some((o) => o.variants?.perNight)) return undefined
  const terms = record.terms
  if (!terms || typeof terms !== 'object') return 'a stay deal pins its per-night terms (record.terms: nights, nightly)'
  const dates = (((mandate?.claim as { constraints?: unknown } | undefined)?.constraints ?? {}) as { checkIn?: unknown; checkOut?: unknown })
  const from = typeof dates.checkIn === 'string' ? Date.parse(`${dates.checkIn.slice(0, 10)}T00:00:00Z`) : NaN
  const to = typeof dates.checkOut === 'string' ? Date.parse(`${dates.checkOut.slice(0, 10)}T00:00:00Z`) : NaN
  if (Number.isNaN(from) || Number.isNaN(to)) return 'no stay dates (the mandate\'s checkIn/checkOut) to check terms.nights against'
  const stay = Math.round((to - from) / (DAY * 1000))
  if (stay < 1) return `the stay dates ${String(dates.checkIn)} → ${String(dates.checkOut)} book no night`
  if (terms.nights !== stay) return `terms.nights ${JSON.stringify(terms.nights ?? null)} is not the booked ${stay}-night stay (${String(dates.checkIn)} → ${String(dates.checkOut)})`
  const assets = resolvedAssets(layers, record.trust)
  const asset = assets[record.amount?.asset ?? record.asset ?? template.asset.code]
  if (!asset || typeof record.amount?.value !== 'string') return 'the deal has no amount in a known asset to derive terms.nightly from'
  let want: bigint
  try { want = parseAmount(record.amount.value, asset).minor / BigInt(stay) } catch { return `the deal's amount ${JSON.stringify(record.amount.value)} is not an amount of ${asset.code}` }
  let nightly: bigint | undefined
  try { nightly = typeof terms.nightly === 'string' ? parseAmount(terms.nightly, asset).minor : undefined } catch { nightly = undefined }
  if (nightly !== want) return `terms.nightly ${JSON.stringify(terms.nightly ?? null)} is not floor(${record.amount.value} ÷ ${stay}) = ${formatAmount(new Amount(asset.code, want), asset.decimals)}`
  const ms = (name: string, v: unknown): number => {
    try { return celDurationMs(String(v)) } catch { throw new Error(`${name} ${JSON.stringify(v)} is not a duration`) }
  }
  try {
    const own = terms.rulingWindow !== undefined
    const raw = own ? terms.rulingWindow : effectiveParam(layers, 'rulingWindow')
    if (raw === undefined) return undefined
    const name = own ? 'terms.rulingWindow' : 'params.rulingWindow'
    const w = ms(name, raw)
    const min = effectiveParam(layers, 'minRulingWindow')
    const max = effectiveParam(layers, 'maxRulingWindow')
    if (min !== undefined && w < ms('params.minRulingWindow', min)) return `${name} ${JSON.stringify(raw)} is shorter than the policy's minRulingWindow ${String(min)}`
    if (max !== undefined && w > ms('params.maxRulingWindow', max)) return `${name} ${JSON.stringify(raw)} is longer than the policy's maxRulingWindow ${String(max)}`
  } catch (e) {
    return (e as Error).message
  }
  return undefined
}

/** Neutrality findings for each service-accredited role (chargeback spec §4.2); empty = neutral. */
function neutralityFindings(record: EngagementRecord, mandate: Statement | null, roles: string[], layers: PolicyDoc[], facts: LedgerFacts): string[] {
  const trust = canonicalTrust(layers, record.trust)
  const resolved = layers.map((l) => resolvePolicy(l, trust))
  const type = effectiveParam(resolved, 'arbiterCredentialType')
  const issuers = effectiveParam(resolved, 'arbiterIssuers')
  const listed = Array.isArray(issuers) ? issuers.filter((i): i is string => typeof i === 'string') : []
  const claim = (mandate?.claim ?? {}) as { allowedArbiters?: unknown }
  const codes = new Set<string>()
  for (const role of roles) {
    const account = record.parties[role]
    if (typeof account !== 'string' || typeof type !== 'string' || !listed.length || !facts.hasCredential(account, type, listed)) codes.add('ARBITER_NOT_ACCREDITED')
    if (Object.entries(record.parties).some(([r, a]) => r !== role && a === account)) codes.add('ARBITER_IS_PARTY')
    if (claim.allowedArbiters !== undefined && !(Array.isArray(claim.allowedArbiters) && claim.allowedArbiters.includes(account))) codes.add('ARBITER_NOT_ALLOWED')
  }
  return ['ARBITER_NOT_ACCREDITED', 'ARBITER_IS_PARTY', 'ARBITER_NOT_ALLOWED'].filter((c) => codes.has(c))
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

/**
 * A JSON-canonical deep copy (undefined-valued keys dropped). The registration is kept and compared in this form, so a
 * re-registration matches the same way before and after a restart from a JSON-backed store (R30).
 */
function jsonCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function seqOf(tx: Json): { sequence?: number; ticket?: number } {
  return Number(tx.TicketSequence ?? 0) > 0 ? { ticket: Number(tx.TicketSequence) } : { sequence: Number(tx.Sequence) }
}

function emptyLedger(account: string): LedgerSnapshot {
  return { index: 0, hash: '', closeTime: new Date(0).toISOString(), baseFeeDrops: '10', reserveIncDrops: '0', accounts: {}, balances: { [account]: {} }, credentials: [], history: {} }
}
