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
}

export interface OutcomeDef {
  /** Each entry is one set of roles that may jointly authorize this outcome. */
  signers: string[][]
  blueprint: string
  presigned?: boolean
  /** For pre-signed outcomes: the role that withholds the last signature until policy passes. */
  finalSigner?: string
  policyStage?: string | null
  enforcement?: Enforcement
  requires?: string
}

export interface TimerDef {
  from: string
  durationSecs: number
  /** A pre-signed outcome name, "arbiter" / "escalate", or "none" (a window that only closes). */
  onExpire: string
}

export interface BlueprintDef {
  /** Ordered inner steps, e.g. ["pay.counterparty", "pay.serviceFee", "trustline.remove", "account.delete"]. */
  steps: string[]
  closes: boolean
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
}

export interface ValidationOptions {
  reserveBaseDrops?: bigint
  reserveIncDrops?: bigint
  preCreateFundingDrops?: bigint
  feeHeadroomDrops?: bigint
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
    const o = t.outcomes[tm.onExpire]
    if (!o) err('V6', `timer ${tn}: onExpire ${tm.onExpire} is not an outcome`)
    else if (!o.presigned) err('V6', `timer ${tn}: onExpire outcome ${tm.onExpire} is not pre-signed`)
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
  for (const o of Object.values(t.outcomes)) if (o.presigned && t.blueprints[o.blueprint]) tickets += 1 + t.blueprints[o.blueprint].steps.length
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

  if (t.class === 'escrow' && !arbiters.length) warnings.push({ id: 'W1', message: 'escrow template without an arbiter role' })

  return { ok: errors.length === 0, errors, warnings, disclosures, minimalWinningSets: mws, ticketsNeeded: tickets, reserveDrops: reserve }
}
