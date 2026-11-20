// Deploy-time trust slots: checksummed addresses, canonical trust, hash independence.
import { describe, expect, it } from 'vitest'
import { documentHash } from '@eng/core'
import { canonicalTrust, decide, isClassicAddress, layerHash, lintPolicy, type DecideInput, type PolicyDoc } from '@eng/policy'
import {
  W, b1Engagement, b1Invoice, b1Ledger, b1Mandate, b1Payment, fixtureTrust, policies, templates,
} from './fixtures.ts'

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function b1(over: Partial<DecideInput> = {}): DecideInput {
  return {
    stage: 'spend',
    proposedTx: b1Payment(W.vendorA.address, '800', { invoice: 'inv:2026-Q4-0042' }),
    engagement: b1Engagement(),
    template: templates.procurement,
    layers: [policies.baseline, policies.procurement],
    mandate: b1Mandate(),
    statements: [b1Invoice()],
    ledger: b1Ledger(),
    inflight: [],
    ...over,
  }
}

/** A classic-looking address whose checksum does not match. */
function badChecksum(address: string): string {
  const alphabet = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz'
  for (const ch of alphabet) {
    if (ch === address.at(-1)) continue
    const candidate = address.slice(0, -1) + ch
    if (!isClassicAddress(candidate)) return candidate
  }
  throw new Error('could not derive a bad-checksum address')
}

describe('classic address check', () => {
  it('accepts a fixture classic address and rejects a bad checksum', () => {
    expect(isClassicAddress(W.issuer.address)).toBe(true)
    const bad = badChecksum(W.issuer.address)
    expect(bad).not.toBe(W.issuer.address)
    expect(isClassicAddress(bad)).toBe(false)
    expect(isClassicAddress('rArbiterAccreditorPlaceholderXXXXXX')).toBe(false)
    expect(isClassicAddress('rRLUSDissuerPlaceholderXXXXXXXXXX')).toBe(false)
  })
})

describe('trust slots and the hash rule', () => {
  const layers = [policies.baseline, policies.procurement]

  it('rejects a bad-checksum trust value', () => {
    const trust = { ...fixtureTrust(layers)!, 'rlusd.issuer': badChecksum(W.issuer.address) }
    expect(() => decide(b1({ engagement: b1Engagement({ trust }) }))).toThrow(/BAD_ADDRESS: rlusd\.issuer/)
  })

  it('rejects a trust key that is not a slot in the pinned layers', () => {
    const trust = { ...fixtureTrust(layers)!, 'arbiter.accreditor': W.accreditor.address }
    expect(() => decide(b1({ engagement: b1Engagement({ trust }) }))).toThrow(/TRUST_KEY: arbiter\.accreditor/)
  })

  it('fails clearly with UNRESOLVED_SLOT when a slotted policy has no trust', () => {
    const { trust: _drop, ...bare } = b1Engagement()
    expect(() => decide(b1({ engagement: bare }))).toThrow(/^TrustError: UNRESOLVED_SLOT: |^UNRESOLVED_SLOT: /)
    try {
      decide(b1({ engagement: bare }))
    } catch (e) {
      expect(String((e as Error).message)).toMatch(/UNRESOLVED_SLOT: (kyb\.issuer|rlusd\.issuer)/)
    }
  })

  it('sorts trust keys so inputsHash does not depend on insertion order', () => {
    const input = b1()
    const forward = {
      ...input.engagement,
      trust: { 'rlusd.issuer': W.issuer.address, 'kyb.issuer': W.kybIssuer.address },
    }
    const reverse = {
      ...input.engagement,
      trust: { 'kyb.issuer': W.kybIssuer.address, 'rlusd.issuer': W.issuer.address },
    }
    const a = decide({ ...input, engagement: forward })
    const b = decide({ ...input, engagement: reverse })
    expect(a.inputsHash).toBe(b.inputsHash)
    expect(a.decision).toBe('SIGN')
  })

  it('keeps the layer hash stable when the resolved addresses change, and does not hash the resolved copy', () => {
    const policy = policies.procurement
    const before = layerHash(policy)
    const other = b1Engagement({
      trust: { 'kyb.issuer': W.kybIssuer.address, 'rlusd.issuer': W.fakeIssuer.address },
    })
    const frozen = deepFreeze(structuredClone(policy))
    const baseline = deepFreeze(structuredClone(policies.baseline))
    const bytes = JSON.stringify(frozen)
    const d = decide(b1({
      engagement: other,
      layers: [baseline, frozen],
      ledger: b1Ledger(),
      proposedTx: b1Payment(W.vendorA.address, '800', { invoice: 'inv:2026-Q4-0042', issuer: W.fakeIssuer.address }),
    }))
    expect(JSON.stringify(frozen)).toBe(bytes)
    expect(layerHash(frozen)).toBe(before)
    expect(layerHash(policy)).toBe(before)
    expect(d.policy.effectiveHash).toBe(documentHash([baseline, frozen]))
    const resolved = structuredClone(frozen)
    resolved.assets!.RLUSD.issuer = W.fakeIssuer.address
    expect(documentHash(resolved)).not.toBe(layerHash(frozen))
    expect(d.policy.layers.join(' ')).toContain(layerHash(frozen))
    expect(d.policy.effectiveHash).not.toBe(documentHash([baseline, resolved]))
  })
})

describe('malformed and unknown slots', () => {
  it('decide rejects a malformed token, a slot in the wrong field, and does not pass the token through', () => {
    const malformed = structuredClone(policies.procurement)
    malformed.assets!.RLUSD.issuer = '$slot:RLUSD.issuer'
    expect(() => decide(b1({ layers: [policies.baseline, malformed] }))).toThrow(/BAD_SLOT:.*unknown slot \$slot:RLUSD\.issuer/)

    const wrong = structuredClone(policies.procurement)
    wrong.stages.spend.rules[0].message += ' $slot:rlusd.issuer'
    expect(() => decide(b1({ layers: [policies.baseline, wrong] }))).toThrow(/BAD_SLOT:.*only allowed/)
  })

  it('canonicalTrust rejects a well-formed name outside KNOWN_SLOTS', () => {
    expect(() => canonicalTrust([policies.shopping], { 'foo.bar': W.issuer.address, 'rlusd.issuer': W.issuer.address })).toThrow(/UNKNOWN_SLOT: foo\.bar/)
    const named = structuredClone(policies.shopping)
    named.assets!.RLUSD.issuer = '$slot:foo.bar'
    expect(() => canonicalTrust([named], { 'foo.bar': W.issuer.address })).toThrow(/UNKNOWN_SLOT: foo\.bar/)
    expect(() => decide(b1({
      layers: [policies.baseline, named],
      engagement: b1Engagement({ trust: { 'foo.bar': W.issuer.address } }),
    }))).toThrow(/BAD_SLOT:.*unknown slot \$slot:foo\.bar/)
  })
})

describe('L10 slot lint', () => {
  it('accepts the shipped slotted policies', () => {
    expect(lintPolicy(policies.procurement, templates.procurement).filter((f) => f.id === 'L10')).toEqual([])
    expect(lintPolicy(policies.hotel2, templates.hotel2).filter((f) => f.id === 'L10')).toEqual([])
    expect(lintPolicy(policies.shopping, templates.shopping).filter((f) => f.id === 'L10')).toEqual([])
  })

  it('rejects a slot outside the allowlist, an unknown name, and a placeholder account', () => {
    const outside: PolicyDoc = structuredClone(policies.shopping)
    outside.stages.spend.rules[0].message = 'paid in $slot:rlusd.issuer'
    expect(lintPolicy(outside).some((f) => f.id === 'L10' && f.message.includes('only allowed'))).toBe(true)

    const unknown: PolicyDoc = structuredClone(policies.shopping)
    unknown.assets!.RLUSD.issuer = '$slot:not.a.slot'
    expect(lintPolicy(unknown).some((f) => f.id === 'L10' && f.message.includes('unknown slot'))).toBe(true)

    const placeholder: PolicyDoc = structuredClone(policies.shopping)
    placeholder.assets!.RLUSD.issuer = 'rRLUSDissuerPlaceholderXXXXXXXXXX'
    expect(lintPolicy(placeholder).some((f) => f.id === 'L10' && f.message.includes('placeholder'))).toBe(true)
  })
})
