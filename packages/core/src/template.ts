// Engagement templates and their validator (docs/use-cases/hotel-booking.md §2, catalog §0, E4).
// A template is a reusable deal shape: roles + weights + quorum + outcomes. The non-custodial claim
// rests on these weights, so every template is checked against hard invariants before use.

export type TemplateClass = 'escrow' | 'owner-wallet' | 'group'
export type RoleKind = 'principal' | 'counterparty' | 'arbiter' | 'cosigner' | 'owner' | 'agent' | 'member'
export type Enforcement = 'service' | 'ledger' | 'final-signature' | 'advisory' | 'none'

export interface RoleDef {
  weight: number
  kind: RoleKind
  /** "service" = operated by the engagement service; "external"; or "licensed:<type>" (E11). */
  operatedBy: 'service' | 'external' | `licensed:${string}`
  /** Arbiter roles: who accredits whoever fills the role. "service" = the engagement service (ENG/ARBITER, V15). */
  accreditation?: 'service'
}

export interface OutcomeDef {
  /** Plain-English summary for people and agents reviewing a deal (non-normative). */
  description?: string
  /** Each entry is one set of roles that may jointly authorize this outcome. */
  signers: string[][]
  blueprint: string
  presigned?: boolean
  /** A pre-signed outcome signed once per night (nights 0..max-1); each variant needs its own Tickets. */
  variants?: { perNight: true; max: number }
  /** For pre-signed outcomes: the role that withholds the last signature until policy passes. */
  finalSigner?: string
  policyStage?: string | null
  enforcement?: Enforcement
  requires?: string
}

export interface TimerDef {
  /** Plain-English summary for people and agents reviewing a deal (non-normative). */
  description?: string
  from: string
  durationSecs: number
  /**
   * A pre-signed outcome name, "arbiter" / "escalate", or "none" (a window that only closes). A list names several
   * mutually exclusive pre-signed outcomes, of which the policy lets at most the one that fits the deal complete.
   */
  onExpire: string | string[]
}

export interface BlueprintDef {
  /** Ordered inner steps, e.g. ["pay.counterparty", "pay.serviceFee", "trustline.remove", "account.delete"]. */
  steps: string[]
  closes: boolean
}

export interface DisputeBond {
  /** "amount" = the deal amount, plus the named policy param. */
  base: string
  plusParam: string
}

/**
 * Template-declared dispute (marketplace-escrow@1). Absent on hotel@1 and hotel@2, which keep
 * their own dispute path. Arbiter silence is not an outcome: `overdueTimer` must be `escalate`.
 */
export interface DisputeDef {
  /** Roles allowed to open the one dispute. */
  by: string[]
  bond: DisputeBond
  /** "accept" still receipts a ruling after the SLA. Anything else keeps the refusal. */
  lateRuling?: string
  /** Timer whose expiry only pages ops. Must be `onExpire: "escalate"`. */
  overdueTimer?: string
}

export interface Template {
  templateId: string
  class: TemplateClass
  description?: string
  asset: { code: string }
  roles: Record<string, RoleDef>
  quorum: number
  outcomes: Record<string, OutcomeDef>
  timers?: Record<string, TimerDef>
  blueprints: Record<string, BlueprintDef>
  /** Object counts the engagement account holds while open (besides tickets), for the reserve check. */
  reserveObjects?: { trustlines: number; signerList: number }
  fees?: { serviceFeeBps: number; paidBy: string }
  /** Statement-type (or `type#phase`) -> timer name whose expiry closes the window in which it may be posted. */
  attestationWindows?: Record<string, string>
  policyRef?: string
  /**
   * Baseline this deal is evaluated with (`pol_baseline@1.2.0`). Absent means baseline 1.1.0,
   * which is what hotel@1 and hotel@2 stay pinned to.
   */
  baselineRef?: string
  /** Present only when the template declares its own dispute. Hotel templates omit this. */
  dispute?: DisputeDef
  /** "live": no outcome may be pre-signed and the deal books no Tickets (V17). */
  signing?: 'live'
}

export interface ValidationOptions {
  reserveBaseDrops?: bigint
  reserveIncDrops?: bigint
  preCreateFundingDrops?: bigint
  feeHeadroomDrops?: bigint
  /** When set, dispute.bond.plusParam must name one of these policy params. */
  policyParams?: Record<string, unknown>
}

export interface Finding { id: string; message: string }

export interface ValidationResult {
  ok: boolean
  errors: Finding[]
  warnings: Finding[]
  /** Facts to show the principal at signing (V10, E4). */
  disclosures: Finding[]
  minimalWinningSets: string[][]
  ticketsNeeded: number
  reserveDrops: bigint
}

const MAX_SIGNERS = 32 // XRPL ExpandedSignerList
const MAX_BATCH_INNER = 8 // XLS-56
const MAX_TICKETS = 250 // per account

export function weightOf(t: Template, set: Iterable<string>): number {
  let w = 0
  for (const r of set) w += t.roles[r]?.weight ?? 0
  return w
}

export function isService(t: Template, role: string): boolean {
  return t.roles[role]?.operatedBy === 'service'
}

/** All minimal role sets whose weight reaches the quorum (no proper subset does). */
export function minimalWinningSets(t: Template): string[][] {
  const names = Object.keys(t.roles)
  if (names.length > 16) throw new Error('too many roles to enumerate (max 16)')
  const winning: number[] = []
  for (let mask = 1; mask < 1 << names.length; mask++) {
    let w = 0
    for (let i = 0; i < names.length; i++) if (mask & (1 << i)) w += t.roles[names[i]].weight
    if (w >= t.quorum) winning.push(mask)
  }
  const minimal = winning.filter((m) => !winning.some((o) => o !== m && (o & m) === o))
  return minimal
    .map((m) => names.filter((_, i) => m & (1 << i)))
    .sort((a, b) => a.length - b.length || a.join().localeCompare(b.join()))
}

/**
 * A live timeout outcome (v4.1): only on a `signing: "live"` template; advisory with a named policy stage the
 * co-signer evaluates; an arbiter in every signer set. Signed after expiry, never pre-signed.
 */
function isLiveTimeout(t: Template, o: OutcomeDef): boolean {
  return t.signing === 'live' && o.requires === 'timeout' && o.enforcement === 'advisory' &&
    typeof o.policyStage === 'string' && o.policyStage.length > 0 && o.signers.length > 0 &&
    o.signers.every((set) => set.some((r) => t.roles[r]?.kind === 'arbiter'))
}

export function validateTemplate(t: Template, opts: ValidationOptions = {}): ValidationResult {
  const errors: Finding[] = []
  const warnings: Finding[] = []
  const disclosures: Finding[] = []
  const err = (id: string, message: string) => errors.push({ id, message })

  const roleNames = Object.keys(t.roles)
  // ── Structural ──
  if (!t.templateId) err('S0', 'templateId missing')
  if (!['escrow', 'owner-wallet', 'group'].includes(t.class)) err('S0', `unknown class ${t.class}`)
  if (roleNames.length === 0) err('S1', 'no roles')
  if (roleNames.length > MAX_SIGNERS) err('S1', `${roleNames.length} roles exceed the SignerList maximum of ${MAX_SIGNERS}`)
  if (!Number.isInteger(t.quorum) || t.quorum < 1) err('S2', 'quorum must be a positive integer')
  for (const [n, r] of Object.entries(t.roles)) {
    if (!Number.isInteger(r.weight) || r.weight < 1 || r.weight > 65535) err('S3', `role ${n}: weight must be 1..65535`)
  }
  const total = roleNames.reduce((s, n) => s + t.roles[n].weight, 0)
  if (total < t.quorum) err('S4', `quorum ${t.quorum} unreachable (total weight ${total})`)
  if (errors.length) return { ok: false, errors, warnings, disclosures, minimalWinningSets: [], ticketsNeeded: 0, reserveDrops: 0n }

  const mws = minimalWinningSets(t)
  const serviceRoles = roleNames.filter((n) => isService(t, n))
  const serviceWeight = weightOf(t, serviceRoles)

  // V1: the service alone can never reach quorum.
  if (serviceWeight >= t.quorum) err('V1', `service-operated weight ${serviceWeight} reaches quorum ${t.quorum}`)
  for (const s of mws) if (s.every((r) => isService(t, r))) err('V1', `winning set {${s}} is entirely service-operated`)

  // V2: no single role reaches quorum, except the owner of an owner-controlled wallet.
  for (const n of roleNames) {
    if (t.roles[n].weight >= t.quorum) {
      const allowed = t.class === 'owner-wallet' && t.roles[n].kind === 'owner'
      if (!allowed) err('V2', `role ${n} (weight ${t.roles[n].weight}) reaches quorum alone`)
    }
  }
  if (t.class === 'owner-wallet' && !roleNames.some((n) => t.roles[n].kind === 'owner')) err('V2', 'owner-wallet template needs an owner role')

  // V3: liveness without the service.
  if (!mws.some((s) => s.every((r) => !isService(t, r)))) err('V3', 'no winning set excludes the service: deals would stall if the service is down')

  // V4: outcome signer sets are known roles and winning.
  for (const [on, o] of Object.entries(t.outcomes)) {
    if (!o.signers?.length) err('V4', `outcome ${on}: no signer sets`)
    for (const set of o.signers ?? []) {
      const unknown = set.filter((r) => !t.roles[r])
      if (unknown.length) err('V4', `outcome ${on}: unknown roles ${unknown}`)
      if (weightOf(t, set) < t.quorum) err('V4', `outcome ${on}: signer set {${set}} has weight ${weightOf(t, set)} < quorum ${t.quorum}`)
    }
    if (!t.blueprints[o.blueprint]) err('V4', `outcome ${on}: unknown blueprint ${o.blueprint}`)
  }

  // V5: pre-signed outcomes are exactly one final signature short of quorum.
  for (const [on, o] of Object.entries(t.outcomes)) {
    if (!o.presigned) continue
    if (!o.finalSigner || !t.roles[o.finalSigner]) { err('V5', `outcome ${on}: pre-signed outcome needs a finalSigner role`); continue }
    const fs = t.roles[o.finalSigner]
    if (!(fs.operatedBy === 'service' || fs.kind === 'arbiter' || fs.operatedBy.startsWith('licensed:'))) {
      err('V5', `outcome ${on}: finalSigner ${o.finalSigner} must be service-operated, licensed, or the arbiter`)
    }
    for (const set of o.signers) {
      if (!set.includes(o.finalSigner)) { err('V5', `outcome ${on}: finalSigner not in signer set {${set}}`); continue }
      const others = weightOf(t, set.filter((r) => r !== o.finalSigner))
      if (others >= t.quorum) err('V5', `outcome ${on}: blob is submittable without the final signature (others ${others} ≥ quorum)`)
    }
  }

  // V6: every timer resolves to a pre-signed outcome or is explicitly arbiter-resolved.
  for (const [tn, tm] of Object.entries(t.timers ?? {})) {
    if (tm.onExpire === 'arbiter' || tm.onExpire === 'escalate' || tm.onExpire === 'none') continue
    const names = Array.isArray(tm.onExpire) ? tm.onExpire : [tm.onExpire]
    if (!names.length) err('V6', `timer ${tn}: onExpire lists no outcomes`)
    for (const n of names) {
      const o = t.outcomes[n]
      if (!o) err('V6', `timer ${tn}: onExpire ${n} is not an outcome`)
      else if (!o.presigned && !isLiveTimeout(t, o)) err('V6', `timer ${tn}: onExpire outcome ${n} is neither pre-signed nor a live arbiter timeout (signing "live", requires "timeout", advisory, a policyStage, arbiter in every signer set)`)
    }
  }

  // V7: blueprints fit in one Batch; closing blueprints remove the trust line and delete last.
  for (const [bn, b] of Object.entries(t.blueprints)) {
    if (b.steps.length > MAX_BATCH_INNER) err('V7', `blueprint ${bn}: ${b.steps.length} inner steps > ${MAX_BATCH_INNER}`)
    if (b.closes) {
      if (b.steps.at(-1) !== 'account.delete') err('V7', `blueprint ${bn}: closing blueprint must end with account.delete`)
      const tl = b.steps.indexOf('trustline.remove')
      if (tl < 0 || tl > b.steps.length - 2) err('V7', `blueprint ${bn}: closing blueprint must remove the trust line before account.delete`)
    }
  }

  // V8: tickets for pre-signed outcomes (outer + every inner uses a Ticket).
  let tickets = 0
  for (const o of Object.values(t.outcomes)) if (o.presigned && t.blueprints[o.blueprint]) tickets += (o.variants?.max ?? 1) * (1 + t.blueprints[o.blueprint].steps.length)
  if (tickets > MAX_TICKETS) err('V8', `${tickets} tickets exceed the per-account maximum of ${MAX_TICKETS}`)

  // V9: reserve budget fits the pre-create funding.
  const base = opts.reserveBaseDrops ?? 1_000_000n
  const inc = opts.reserveIncDrops ?? 200_000n
  const objs = t.reserveObjects ?? { trustlines: 1, signerList: 1 }
  const reserve = base + inc * BigInt(objs.trustlines + objs.signerList + tickets)
  if (opts.preCreateFundingDrops != null) {
    const need = reserve + (opts.feeHeadroomDrops ?? 500_000n)
    if (need > opts.preCreateFundingDrops) err('V9', `reserve ${reserve} + fee headroom exceeds funding ${opts.preCreateFundingDrops} drops`)
  }

  // V10: disclosure of winning sets that exclude the principal (escrow).
  if (t.class === 'escrow') {
    const principals = roleNames.filter((n) => t.roles[n].kind === 'principal')
    for (const s of mws) if (!s.some((r) => principals.includes(r))) disclosures.push({ id: 'V10', message: `{${s.join(', ')}} can move funds without the principal` })
  }

  // V11 (E4): arbiters alone must never reach quorum; arbiter + service combinations are disclosed.
  const arbiters = roleNames.filter((n) => t.roles[n].kind === 'arbiter')
  for (const s of mws) {
    if (s.length > 0 && s.every((r) => arbiters.includes(r))) err('V11', `arbiters {${s}} can move funds without any party`)
    else if (s.every((r) => arbiters.includes(r) || isService(t, r)) && s.some((r) => arbiters.includes(r))) {
      disclosures.push({ id: 'V11', message: `{${s.join(', ')}} (arbiters + service) can move funds without any party` })
    }
  }

  // V12: enforcement declarations agree with the weights (policy spec §9, lint L5).
  for (const [on, o] of Object.entries(t.outcomes)) {
    if (o.enforcement === 'ledger') {
      for (const set of o.signers) {
        const cos = set.filter((r) => t.roles[r]?.kind === 'cosigner')
        if (!cos.length) err('V12', `outcome ${on}: declared ledger-enforced but signer set {${set}} has no co-signer`)
        else if (weightOf(t, set.filter((r) => !cos.includes(r))) >= t.quorum) err('V12', `outcome ${on}: declared ledger-enforced but {${set}} reaches quorum without the co-signer`)
      }
    }
    if (o.enforcement === 'final-signature' && !o.presigned) err('V12', `outcome ${on}: final-signature enforcement requires a pre-signed outcome`)
  }

  // V13: attestation windows name a statement type (optionally `#phase`) and a timer the engagement carries
  // (a template timer, or an anchor a template timer runs `from`); a window without a deadline never closes.
  const timers = t.timers ?? {}
  const knownTimers = new Set([...Object.keys(timers), ...Object.values(timers).map((tm) => tm.from)])
  for (const [key, timer] of Object.entries(t.attestationWindows ?? {})) {
    const [type, phase, ...rest] = key.split('#')
    if (!/^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+\/\d+$/.test(type) || rest.length || phase === '') err('V13', `attestationWindows: "${key}" does not name a statement type (type/version, optionally #phase)`)
    if (typeof timer !== 'string' || !knownTimers.has(timer)) err('V13', `attestationWindows["${key}"]: unknown timer ${JSON.stringify(timer)}`)
  }
  // V14: window ordering. The entry-dispute window may not close before check-in does (a guest denied entry
  // could be shut out), and the hotel's claim window must close before the guest's last chance to dispute it.
  const ordered = (early: string, late: string, strict: boolean, why: string) => {
    const a = timers[early], b = timers[late]
    if (!a || !b || a.from !== b.from) return
    if (strict ? !(a.durationSecs < b.durationSecs) : !(a.durationSecs <= b.durationSecs)) err('V14', `timer ${late} (${b.durationSecs}s) must ${strict ? 'end after' : 'not end before'} ${early} (${a.durationSecs}s) from ${a.from}: ${why}`)
  }
  ordered('checkInBy', 'entryDisputeBy', false, 'the guest must be able to dispute entry until check-in closes')
  ordered('claimBy', 'disputeWindowEnds', true, 'the guest must be able to answer the last possible claim')
  // marketplace-escrow@1: shipBy ends strictly before inspectBy, and both run from the same anchor.
  // The 24h ship window and 7d inspect gap are policy params (minShipWindow, minInspectGap). Core does not
  // import the policy package. marketplaceEscrowTermsFindings checks the deal's record.timers against those
  // params at register(). docs/specs/marketplace-escrow-at-1.md §3 items 2–3 and §8 C7.
  ordered('shipBy', 'inspectBy', true, 'the buyer must be able to inspect after the last possible shipment')
  const shipBy = timers.shipBy
  const inspectBy = timers.inspectBy
  if (shipBy && inspectBy && shipBy.from !== inspectBy.from) {
    err('V14', `timers shipBy (from ${shipBy.from}) and inspectBy (from ${inspectBy.from}) must share an anchor: the buyer must be able to inspect after the last possible shipment`)
  }
  // A declared dispute pages ops when its timer expires. That timer must not name a pre-signed outcome:
  // arbiter silence moves no money.
  if (t.dispute) {
    const name = t.dispute.overdueTimer
    const tm = name ? timers[name] : undefined
    if (!tm) err('V6', `dispute.overdueTimer ${JSON.stringify(name ?? null)} is not a timer`)
    else if (tm.onExpire !== 'escalate') err('V6', `timer ${name}: dispute overdue must be onExpire "escalate" (arbiter silence moves no money)`)
    const by = t.dispute.by
    if (!Array.isArray(by) || by.length === 0) err('V16', 'dispute.by must name at least one role defined on this template')
    else for (const role of by) if (!t.roles[role]) err('V16', `dispute.by role ${JSON.stringify(role)} is not a role on this template`)
    if (opts.policyParams) {
      const plus = t.dispute.bond?.plusParam
      if (typeof plus !== 'string' || !Object.prototype.hasOwnProperty.call(opts.policyParams, plus)) {
        err('V16', `dispute.bond.plusParam ${JSON.stringify(plus ?? null)} is not a policy param`)
      }
    }
  }

  // V17: a live-signing template has no pre-signed outcome and books no Tickets.
  if (t.signing === 'live') {
    for (const [on, o] of Object.entries(t.outcomes)) if (o.presigned || o.finalSigner || o.variants) err('V17', `outcome ${on}: signing is "live", so no outcome may be pre-signed`)
    if (tickets !== 0) err('V17', `signing is "live" but the template books ${tickets} Tickets`)
  }

  // V15: every arbiter role opts into the service's accreditation gate (the co-signer registers a deal only when
  // the arbiter holds an accepted, unexpired ENG/ARBITER credential from an issuer the policy lists).
  for (const n of arbiters) {
    const a = t.roles[n].accreditation
    if (a !== 'service') err('V15', `arbiter role ${n}: must declare "accreditation": "service" (got ${JSON.stringify(a ?? null)})`)
  }

  if (t.class === 'escrow' && !arbiters.length) warnings.push({ id: 'W1', message: 'escrow template without an arbiter role' })

  return { ok: errors.length === 0, errors, warnings, disclosures, minimalWinningSets: mws, ticketsNeeded: tickets, reserveDrops: reserve }
}
