// Deploy-time trust slots. A policy names an anchor as "$slot:<name>" instead of an account.
// layerHash covers that token. The engagement record's `trust` map supplies the classic address
// at open, and only a copy of the policy is resolved for evaluation. The hashed object is never written.
import { isValidClassicAddress } from 'ripple-address-codec'
import type { AssetDef } from '@eng/core'
import type { EngagementRecord, PolicyDoc } from './types.ts'

export const SLOT_PREFIX = '$slot:'

/** Closed set. Lint, startup, and canonicalTrust reject any other name. One accreditor per deployment. */
export const KNOWN_SLOTS = ['arbiter.accreditor', 'kyb.issuer', 'rlusd.issuer'] as const
export type KnownSlot = (typeof KNOWN_SLOTS)[number]

/** The account strings that used to ship in the policy files. Not classic addresses. */
export const PLACEHOLDERS = [
  'rArbiterAccreditorPlaceholderXXXXXX',
  'rRLUSDissuerPlaceholderXXXXXXXXXX',
] as const

const SLOT_RE = /^\$slot:([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*)$/
const ALLOWED_SLOT_FIELDS = ['arbiterIssuers', 'kybIssuers'] as const
/** `$slot:` is only legal as an asset issuer or an entry of those two param lists. */
const SLOT_FIELD = /^assets\.[^.]+\.issuer$|^params\.(?:arbiterIssuers|kybIssuers)\[\d+\]$/

export interface SlotViolation { where: string; message: string }

function knownSlot(name: string): boolean {
  return (KNOWN_SLOTS as readonly string[]).includes(name)
}

export class TrustError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TrustError'
  }
}

/** Classic XRPL address: base58 (XRPL alphabet) and checksum. A regex is not enough. */
export function isClassicAddress(address: string): boolean {
  return typeof address === 'string' && isValidClassicAddress(address)
}

export function slotNameOf(value: string): string | undefined {
  return SLOT_RE.exec(value)?.[1]
}

export function isSlotToken(value: string): boolean {
  return SLOT_RE.test(value)
}

/**
 * Every `$slot:` string that is not a known slot in an allowed field. Same rules as lint L10.
 * A token that fails {@link SLOT_RE} (for example `$slot:RLUSD.issuer`) is an unknown slot, not a pass-through.
 */
export function slotViolations(doc: PolicyDoc): SlotViolation[] {
  const out: SlotViolation[] = []
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (!value.includes('$slot:')) return
      if (!SLOT_FIELD.test(path)) {
        out.push({ where: path || '(root)', message: '$slot: is only allowed on an asset issuer, params.arbiterIssuers, or params.kybIssuers' })
        return
      }
      const name = slotNameOf(value)
      if (!name || !knownSlot(name)) out.push({ where: path, message: `unknown slot ${value}` })
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`))
      return
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key)
    }
  }
  walk(doc, '')
  return out
}

/** Throw when any loaded policy has a `$slot:` token lint L10 would reject. */
export function assertPolicySlots(docs: PolicyDoc[]): void {
  for (const doc of docs) {
    const bad = slotViolations(doc)
    if (bad.length) throw new TrustError(`BAD_SLOT: ${doc.policyId}@${doc.version} ${bad[0].where}: ${bad[0].message}`)
  }
}

function remember(out: string[], value: unknown): void {
  if (typeof value !== 'string') return
  const name = slotNameOf(value)
  if (name && !out.includes(name)) out.push(name)
}

/** Slot names in the allowlisted fields of one policy, first-seen order. */
export function slotsIn(doc: PolicyDoc): string[] {
  const out: string[] = []
  for (const def of Object.values(doc.assets ?? {})) remember(out, def.issuer)
  const params = doc.params ?? {}
  for (const key of ALLOWED_SLOT_FIELDS) {
    const list = params[key]
    if (Array.isArray(list)) for (const item of list) remember(out, item)
  }
  return out
}

/** Union of slots across layers, first-seen order. */
export function slotsInLayers(layers: PolicyDoc[]): string[] {
  const out: string[] = []
  for (const layer of layers) for (const name of slotsIn(layer)) if (!out.includes(name)) out.push(name)
  return out
}

/**
 * The trust map these layers require.
 * Keys are exactly the slots the layers name, sorted. Each value is a classic address.
 * An unknown key is TRUST_KEY. A missing, empty, slot-token, or placeholder value is UNRESOLVED_SLOT.
 * Anything else that is not a checksummed classic address is BAD_ADDRESS.
 * No slots and no keys → undefined.
 */
export function canonicalTrust(layers: PolicyDoc[], trust: Record<string, string> | undefined): Record<string, string> | undefined {
  const needed = [...slotsInLayers(layers)].sort()
  const given = trust ?? {}
  for (const key of Object.keys(given).sort()) {
    if (!knownSlot(key)) throw new TrustError(`UNKNOWN_SLOT: ${key}`)
    if (!needed.includes(key)) throw new TrustError(`TRUST_KEY: ${key} is not a slot in the pinned layers`)
  }
  if (!needed.length) return undefined
  const out: Record<string, string> = {}
  for (const name of needed) {
    if (!knownSlot(name)) throw new TrustError(`UNKNOWN_SLOT: ${name}`)
    const value = given[name]
    if (typeof value !== 'string' || value.length === 0 || isSlotToken(value) || (PLACEHOLDERS as readonly string[]).includes(value)) {
      throw new TrustError(`UNRESOLVED_SLOT: ${name}`)
    }
    if (!isClassicAddress(value)) throw new TrustError(`BAD_ADDRESS: ${name}`)
    out[name] = value
  }
  return out
}

/** Engagement whose `trust` is the canonical map (sorted keys). Drops `trust` when the layers name no slots. */
export function withCanonicalTrust(eng: EngagementRecord, layers: PolicyDoc[]): EngagementRecord {
  const trust = canonicalTrust(layers, eng.trust)
  if (!trust) {
    if (eng.trust === undefined) return eng
    const { trust: _drop, ...rest } = eng
    return rest
  }
  return { ...eng, trust }
}

function replaceSlot(value: string, trust: Record<string, string>): string {
  if (!value.includes('$slot:')) return value
  const name = slotNameOf(value)
  if (!name || !knownSlot(name)) throw new TrustError(`BAD_SLOT: unknown slot ${value}`)
  const resolved = trust[name]
  if (resolved === undefined) throw new TrustError(`UNRESOLVED_SLOT: ${name}`)
  return resolved
}

/** A copy of `doc` with allowlisted slot tokens replaced. Does not mutate `doc`. Throws on a bad `$slot:` anywhere in the document. */
export function resolvePolicy(doc: PolicyDoc, trust: Record<string, string> | undefined): PolicyDoc {
  assertPolicySlots([doc])
  const map = trust ?? {}
  const copy = structuredClone(doc)
  if (copy.assets) {
    for (const def of Object.values(copy.assets)) {
      if (typeof def.issuer === 'string') def.issuer = replaceSlot(def.issuer, map)
    }
  }
  if (copy.params) {
    for (const key of ALLOWED_SLOT_FIELDS) {
      const list = copy.params[key]
      if (Array.isArray(list)) copy.params[key] = list.map((item) => (typeof item === 'string' ? replaceSlot(item, map) : item))
    }
  }
  return copy
}

/** Asset map for evaluation and ledger reads. Resolved copy only; `layers` are not modified. */
export function resolvedAssets(layers: PolicyDoc[], trust: Record<string, string> | undefined): Record<string, AssetDef> {
  const map = canonicalTrust(layers, trust) ?? {}
  const defs: Record<string, AssetDef> = {}
  for (const layer of layers) {
    for (const [code, def] of Object.entries(resolvePolicy(layer, map).assets ?? {})) {
      if (defs[code] && JSON.stringify(defs[code]) !== JSON.stringify(def)) throw new Error(`asset ${code} redefined by ${layer.policyId}`)
      defs[code] = def
    }
  }
  return defs
}
