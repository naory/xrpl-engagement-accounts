// Pre-booking disclosure (non-normative). Derives a deal's terms from the template, the policy and the
// merchant's offer — so nothing in the summary is hand-written — and compares them with a published norms
// profile (norms/*.json). Only deviations come back, each with a severity hint; whether to escalate to the
// person is the guest's agent's decision.
import { isService, minimalWinningSets, type Template } from '@eng/core'
import type { PolicyDoc } from './types.ts'

export type Appointer = 'service' | 'principal' | 'counterparty'
export interface ArbiterOffer { account: string; accredited: boolean; appointedBy: Appointer }

/** What the merchant offers for one booking (amounts as decimal strings in the template asset). */
export interface HotelOffer {
  room: string
  deposit: string
  arbiter: ArbiterOffer
  backupArbiter?: ArbiterOffer
  /** Deadline overrides in seconds, keyed by template timer name (defaults come from the template). */
  timers?: Record<string, number>
}

export interface DealTerms {
  template: string
  policy: string
  money: { asset: string; room: string; deposit: string; bond: string; feeBps: number }
  deadlines: Array<{ timer: string; seconds: number; from: string; onExpire: string; description?: string }>
  /** Minimal sets of roles that can move the money together. */
  whoCanMoveMoney: Array<{ roles: string[]; weight: number; includesGuest: boolean; includesCosigner: boolean; plain: string }>
  /** What happens automatically when a deadline passes with nobody acting. */
  silence: Array<{ timer: string; outcome: string; description?: string }>
  arbiters: { arbiter: ArbiterOffer; backupArbiter?: ArbiterOffer }
  /** Flat facts the norms refer to by `term`. */
  facts: Record<string, number | string | boolean>
}

export interface Norm {
  id: string
  term: string
  severity: 'info' | 'warn' | 'serious'
  title: string
  why: string
  unit?: string
  min?: number
  max?: number
  equals?: number | string | boolean
  oneOf?: Array<number | string | boolean>
  /** Plain-English labels for enum values (e.g. "counterparty" → "the hotel"). */
  valueLabels?: Record<string, string>
}
export interface NormsProfile { normsId: string; description?: string; appliesTo: string[]; norms: Norm[] }

export interface Deviation {
  normId: string
  term: string
  severity: Norm['severity']
  title: string
  why: string
  /** The norm, in words (e.g. "at least 2 days"). */
  expected: string
  actual: number | string | boolean | null
  /** The actual value, in words. */
  actualText: string
}

const ROLE_NAMES: Record<string, string> = { principal: 'you', counterparty: 'the hotel', arbiter: 'the arbiter', backupArbiter: 'the backup arbiter', cosigner: 'the policy co-signer' }
const roleName = (r: string): string => ROLE_NAMES[r] ?? r
const listWords = (xs: string[]): string => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`

/** Decimal string → integer minor units (6 decimals), no floats. */
function minor(v: string): bigint {
  const [i, f = ''] = v.split('.')
  return BigInt(i) * 1_000_000n + BigInt((f + '000000').slice(0, 6))
}

export function dealTerms(o: { template: Template; policy: PolicyDoc; offer: HotelOffer }): DealTerms {
  const { template: t, policy: p, offer } = o
  const feeBps = t.fees?.serviceFeeBps ?? Number(p.params?.serviceFeeBps ?? 0)
  const bond = String(p.params?.minDisputeBond ?? '0')
  const deadlines = Object.entries(t.timers ?? {}).map(([timer, d]) => ({
    timer, seconds: offer.timers?.[timer] ?? d.durationSecs, from: d.from, onExpire: d.onExpire, ...(d.description ? { description: d.description } : {}),
  }))
  const kindOf = (r: string) => t.roles[r]?.kind
  const whoCanMoveMoney = minimalWinningSets(t).map((roles) => {
    const weight = roles.reduce((s, r) => s + (t.roles[r]?.weight ?? 0), 0)
    return { roles, weight, includesGuest: roles.some((r) => kindOf(r) === 'principal'), includesCosigner: roles.some((r) => isService(t, r)), plain: `${listWords(roles.map(roleName))} together` }
  })
  const silence = Object.entries(t.timers ?? {})
    .filter(([, d]) => t.outcomes[d.onExpire])
    .map(([timer, d]) => ({ timer, outcome: d.onExpire, ...(t.outcomes[d.onExpire].description ? { description: t.outcomes[d.onExpire].description } : {}) }))

  const merchantRoles = Object.keys(t.roles).filter((r) => kindOf(r) === 'counterparty')
  const guestRoles = Object.keys(t.roles).filter((r) => kindOf(r) === 'principal')
  const facts: DealTerms['facts'] = {
    'money.feeBps': feeBps,
    depositBps: Number((minor(offer.deposit) * 10000n) / (minor(offer.room) || 1n)),
    'arbiter.accredited': offer.arbiter.accredited,
    'arbiter.appointedBy': offer.arbiter.appointedBy,
    // A set of merchant roles alone reaching quorum: the hotel could pay itself with no guest, arbiter or policy.
    merchantWithoutGuestOrNeutral: whoCanMoveMoney.some((s) => s.roles.every((r) => merchantRoles.includes(r))),
    // Guest + hotel alone reaching quorum: the agreed policy could be bypassed.
    guestAndHotelBypassPolicy: whoCanMoveMoney.some((s) => s.roles.every((r) => merchantRoles.includes(r) || guestRoles.includes(r))),
  }
  if (offer.backupArbiter) {
    facts['backupArbiter.accredited'] = offer.backupArbiter.accredited
    facts['backupArbiter.appointedBy'] = offer.backupArbiter.appointedBy
  }
  for (const d of deadlines) facts[`timers.${d.timer}`] = d.seconds

  return {
    template: t.templateId,
    policy: `${p.policyId}@${p.version}`,
    money: { asset: t.asset.code, room: offer.room, deposit: offer.deposit, bond, feeBps },
    deadlines, whoCanMoveMoney, silence,
    arbiters: { arbiter: offer.arbiter, ...(offer.backupArbiter ? { backupArbiter: offer.backupArbiter } : {}) },
    facts,
  }
}

/** "2 days", "9 hours", "45 minutes". */
export function humanDuration(secs: number): string {
  const units: Array<[number, string]> = [[86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']]
  for (const [n, u] of units) if (secs >= n && secs % n === 0) { const k = secs / n; return `${k} ${u}${k === 1 ? '' : 's'}` }
  const h = Math.round((secs / 3600) * 10) / 10
  return `${h} hours`
}

function valueText(n: Norm, v: unknown): string {
  if (v == null) return 'not stated'
  if (n.unit === 'seconds' && typeof v === 'number') return humanDuration(v)
  if (n.unit?.startsWith('bps') && typeof v === 'number') return `${v / 100}%${n.unit.includes('room') ? ' of the room price' : ''}`
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  return n.valueLabels?.[String(v)] ?? String(v)
}

function expectedText(n: Norm): string {
  if (n.min != null && n.max != null) return `between ${valueText(n, n.min)} and ${valueText(n, n.max)}`
  if (n.min != null) return `at least ${valueText(n, n.min)}`
  if (n.max != null) return `at most ${valueText(n, n.max)}`
  if (n.oneOf) return n.oneOf.map((x) => valueText(n, x)).join(' or ')
  return valueText(n, n.equals)
}

/** The deal's deviations from the norms profile (empty for a normal deal). A missing fact is a deviation. */
export function checkNorms(terms: DealTerms, profile: NormsProfile): Deviation[] {
  const out: Deviation[] = []
  for (const n of profile.norms) {
    const v = terms.facts[n.term]
    const ok = v !== undefined && (
      (n.min == null || (typeof v === 'number' && v >= n.min)) &&
      (n.max == null || (typeof v === 'number' && v <= n.max)) &&
      (n.equals === undefined || v === n.equals) &&
      (n.oneOf == null || n.oneOf.includes(v)))
    if (!ok) out.push({ normId: n.id, term: n.term, severity: n.severity, title: n.title, why: n.why, expected: expectedText(n), actual: v ?? null, actualText: valueText(n, v) })
  }
  return out
}
