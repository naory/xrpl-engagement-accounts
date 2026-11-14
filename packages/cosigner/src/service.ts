// The policy co-signer service (docs/spec/policy.md §6–§8, §12): for each request it pins a
// validated ledger, runs decide(), signs a cosigner.decision/1 record, and — only on SIGN — adds
// its multisig signature to exactly the transaction it evaluated.
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import xrpl from 'xrpl'
import * as keypairs from 'ripple-keypairs'
import { encodeForMultisigning } from 'ripple-binary-codec'
import { documentHash, newNonce, parseAmount, signStatementAsync, signerBlob, verifyStatement, zero, type AssetDef, type Signer, type Statement, type Template } from '@eng/core'
import {
  Assets, LedgerFacts, REGISTRY, TxFacts, celDurationMs, decide, decisionStatementBody, layerHash, nightsElapsed,
  type Decision, type EngagementRecord, type InflightEntry, type LedgerSnapshot, type PolicyDoc, verifyStatements,
} from '@eng/policy'
import type { LedgerSource } from './snapshot.ts'
import { combine, unsigned } from './xrpl-io.ts'

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
   * propagates, also registering nothing).
   */
  private async registerLocked(record: EngagementRecord, mandate: Statement | null): Promise<{ ok: true; layers: string[] }> {
    const existing = this.engagements.get(record?.engagementId)
    if (existing) {
      if (!isDeepStrictEqual(existing.registered, { record, mandate })) throw new Error(`ALREADY_REGISTERED: ${record.engagementId} is registered with a different record`)
      return { ok: true, layers: existing.layers.map((l) => `${l.policyId}@${l.version} ${layerHash(l)}`) }
    }
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
    const accredited = Object.entries(template.roles).filter(([, r]) => r.accreditation === 'service').map(([n]) => n)
    if (accredited.length) {
      const all = [baseline, ...layers]
      const assets = this.assetsOf(all)
      const subjects = accredited.map((r) => record.parties[r]).filter((a): a is string => typeof a === 'string')
      const ledger = await this.o.source.snapshot({ account: record.account, assets, accounts: [], credentialSubjects: subjects, historySecs: 0 })
      const codes = neutralityFindings(record, mandate, accredited, all, new LedgerFacts(ledger, new Assets(assets)))
      if (codes.length) throw new Error(`NOT_NEUTRAL: ${codes.join(', ')}`)
    }
    this.engagements.set(record.engagementId, { record: structuredClone({ consumed: [], ...record }), registered: structuredClone({ record, mandate }), mandate, layers: [baseline, ...layers], template, attestations: new Map(), presigned: new Map(), completed: new Map() })
    return { ok: true, layers: [baseline, ...layers].map((l) => `${l.policyId}@${l.version} ${layerHash(l)}`) }
  }

  engagement(id: string): EngagementRecord | undefined { return this.engagements.get(id)?.record }
  decisions(engagementId?: string): Statement[] { return engagementId ? this.log.filter((s) => s.engagementId === engagementId) : [...this.log] }
  inflightFor(engagementId: string): InflightRecord[] { return this.inflight.filter((i) => i.engagementId === engagementId) }

  /** Receipted statements with their receipts, in ingest order. */
  attestations(engagementId: string): Array<{ statement: Statement; receipt: Receipt }> {
    const st = this.engagements.get(engagementId)
    if (!st) throw new Error(`unknown engagement ${engagementId}`)
    return [...st.attestations.values()]
  }

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
    if (s.type === 'party.ruling/1' && attester === st.record.parties.arbiter) {
      // A ruling is about a case: a receipted guest dispute or hotel claim. Otherwise an arbiter could pre-block defaults.
      const opened = this.caseOpenedAt(st)
      if (!opened) throw new Error('NO_CASE: no receipted dispute or claim for the arbiter to rule on')
      // The policy counts only rulings issued at/after the case opened: refuse one it would ignore, so a receipted ruling always counts.
      if (Date.parse(s.issuedAt) < opened.at) throw new Error(`EARLY_RULING: issued ${s.issuedAt}, before the case opened (${new Date(opened.at).toISOString()})`)
      // A ruling counts only if receipted by the deal's ruling deadline, so a late one can't block a due default.
      const due = this.rulingDeadline(st)
      if (due != null && received > due) throw new Error(`LATE: party.ruling/1 after the ruling deadline (${new Date(due).toISOString()})`)
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
    st.attestations.set(s.id, { statement: s, receipt })
    return receipt
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
    if (s.type === 'party.dispute/1') {
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
      if (isPrincipalDispute(s) && !this.disputeBonded(st, posted, assets, ledger, phase)) throw new Error('NOT_BONDED: post the ENG/DISPUTE Credential and the bond (room, plus the deposit for a stay or settlement dispute, plus minDisputeBond in the account) before the dispute statement')
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
      const anchor = Date.parse(((d.claim as { phase?: unknown }).phase === 'settlement' ? timers?.deliveryBy : timers?.checkIn) ?? '')
      const issued = Date.parse(d.issuedAt)
      return { kind: 'dispute', at: Number.isNaN(anchor) ? issued : Math.max(issued, anchor) }
    }
    const claims = posted.filter((p) => p.type === 'party.claim/1' && p.attester.account === parties.counterparty).map((p) => Date.parse(p.issuedAt))
    return claims.length ? { kind: 'claim', at: Math.max(...claims) } : undefined
  }

  /**
   * Whether a principal dispute may be receipted (R12), at this ledger: the principal's ENG/DISPUTE Credential is on the
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
    if (!facts.credentialExists(parties.principal!, account, 'ENG/DISPUTE')) return false
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
    return this.serialized(engagementId, async () => this.storePresignedLocked(engagementId, outcome, blob))
  }

  private storePresignedLocked(engagementId: string, outcome: string, blob: string): void {
    const st = this.engagements.get(engagementId)
    if (!st) throw new Error(`unknown engagement ${engagementId}`)
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

    const facts = new TxFacts(tx, { eng: st.record, template: st.template, assets: new Assets(this.assetsOf(st.layers)), ledger: emptyLedger(st.record.account) })
    if (!facts.matchesBlueprint(o.blueprint)) throw new Error(`BLUEPRINT: blob does not match ${o.blueprint}`)
    // A chargeback blob must match its slot: its eng/basis names the outcome, and a per-night variant #k pays the
    // hotel (with the fee) exactly k nights, so the stored name says what the transaction does.
    if (base.startsWith('default.chargeback') || o.variants?.perNight) {
      const basis = facts.memo('eng/basis')
      if (basis !== base) throw new Error(`SLOT_MISMATCH: blob's eng/basis is ${JSON.stringify(basis)}, expected ${base}`)
      if (variant !== undefined) {
        const code = st.template.asset.code
        const asset = this.assetsOf(st.layers)[code]
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
    st.presigned.set(outcome, canonical)
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
  async tick(engagementId: string): Promise<TickResult[]> {
    return this.serialized(engagementId, () => this.tickLocked(engagementId))
  }

  private async tickLocked(engagementId: string): Promise<TickResult[]> {
    const st = this.engagements.get(engagementId)
    if (!st) throw new Error(`unknown engagement ${engagementId}`)
    if (!st.presigned.size) return []
    const ledger = await this.o.source.snapshot({
      account: st.record.account, assets: this.assetsOf(st.layers), accounts: [], credentialSubjects: [], historySecs: this.o.historySecs ?? 90 * DAY,
    })
    if (!ledger.accounts[st.record.account]?.exists) return []
    this.resolveInflight(st, ledger)

    const out: TickResult[] = []
    // A snapshot without owner objects says nothing about Tickets: skip the check rather than retire (R35).
    const owned = ledger.accounts[st.record.account]?.ownerObjects
    const tickets = owned ? new Set(owned.tickets ?? []) : null
    for (const [outcome, stored] of [...st.presigned]) {
      // A per-night variant ("<outcome>#k") is decided under its outcome's stage; the result keeps the #k name.
      const base = splitVariant(outcome)[0]
      const stage = st.template.outcomes[base]?.policyStage ?? base
      const tx = unsigned(xrpl.decode(stored) as Json)
      const txHash = documentHash(tx)
      const prior = st.completed.get(txHash)
      if (prior && this.inflightFor(engagementId).some((i) => i.proposedTxHash === txHash)) { out.push(prior); continue }
      st.completed.delete(txHash)

      const used = [tx, ...((tx.RawTransactions ?? []) as Array<{ RawTransaction: Json }>).map((r) => r.RawTransaction)].map((t) => Number(t.TicketSequence))
      const gone = tickets ? used.filter((t) => !tickets.has(t)) : []
      if (gone.length) {
        st.presigned.delete(outcome)
        const record = await this.refusalRecord(st, ledger, stage, txHash, { id: 'TICKET_CONSUMED', result: 'fail', reason: 'TICKET_CONSUMED', message: `Tickets ${gone.join(', ')} are no longer on the account; the pre-signed default can never apply.` })
        out.push({ outcome, stage, decision: 'REFUSE', failing: ['TICKET_CONSUMED'], record })
        continue
      }

      let r: DecideResponse | undefined
      try {
        r = await this.decideLocked({ engagementId, stage, txBlob: stored })
        const res: TickResult = { outcome, stage, decision: r.decision, failing: r.failing, record: r.record }
        if (r.decision === 'SIGN' && r.signerBlob) {
          res.blob = combine([stored, r.signerBlob])
          st.completed.set(txHash, res)
        }
        out.push(res)
      } catch (e) {
        // Never leave a signed-but-undelivered decision in flight: it would block other outcomes (B9).
        const i = r ? this.inflight.findIndex((f) => f.engagementId === engagementId && f.decisionId === r!.record.id) : -1
        if (i >= 0) this.inflight.splice(i, 1)
        const message = String((e as Error)?.message ?? e)
        const record = await this.refusalRecord(st, ledger, stage, txHash, { id: 'TICK_ERROR', result: 'error', reason: 'TICK_ERROR', message, error: message.split('\n')[0] })
        out.push({ outcome, stage, decision: 'REFUSE', failing: ['TICK_ERROR'], record })
      }
    }
    return out
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
    const record = await signStatementAsync(decisionStatementBody(d, { account: this.address, accreditation: this.o.accreditation }, newNonce()), this.o.signer)
    this.append(record)
    return record
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
      account: st.record.account, assets, accounts: attesters, credentialSubjects: [...payees, ...attesters], payees,
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

/** "default.chargebackStay#2" → ["default.chargebackStay", "2"]; a name without '#' → [name, undefined]. */
function splitVariant(outcome: string): [string, string | undefined] {
  const i = outcome.indexOf('#')
  return i < 0 ? [outcome, undefined] : [outcome.slice(0, i), outcome.slice(i + 1)]
}

/** A policy parameter from the effective policy (the last layer that sets it wins). */
function effectiveParam(layers: PolicyDoc[], name: string): unknown {
  return [...layers].reverse().map((l) => (l.params as Record<string, unknown> | undefined)?.[name]).find((v) => v !== undefined)
}

/** Neutrality findings for each service-accredited role (chargeback spec §4.2); empty = neutral. */
function neutralityFindings(record: EngagementRecord, mandate: Statement | null, roles: string[], layers: PolicyDoc[], facts: LedgerFacts): string[] {
  const type = effectiveParam(layers, 'arbiterCredentialType')
  const issuers = effectiveParam(layers, 'arbiterIssuers')
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

function seqOf(tx: Json): { sequence?: number; ticket?: number } {
  return Number(tx.TicketSequence ?? 0) > 0 ? { ticket: Number(tx.TicketSequence) } : { sequence: Number(tx.Sequence) }
}

function emptyLedger(account: string): LedgerSnapshot {
  return { index: 0, hash: '', closeTime: new Date(0).toISOString(), baseFeeDrops: '10', reserveIncDrops: '0', accounts: {}, balances: { [account]: {} }, credentials: [], history: {} }
}
