// Co-signer trust config: assetsOf does not mutate the hashed policy, startup checks, drift warning.
import { describe, expect, it, vi } from 'vitest'
import { localSigner } from '@eng/core'
import {
  CosignerService, FixtureLedgerSource, MemoryStateStore, assertDeployTrust, loadTrustConfig,
  type LedgerSource, type SnapshotRequest,
} from '@eng/cosigner'
import { isClassicAddress, layerHash, type PolicyDoc } from '@eng/policy'
import {
  W, b1Engagement, b1Invoice, b1Ledger, b1Mandate, b1Payment, policies, templates,
} from '../../policy/test/fixtures.ts'

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

class RecordingSource implements LedgerSource {
  seen: SnapshotRequest[] = []
  constructor(private readonly inner: FixtureLedgerSource) {}
  async snapshot(req: SnapshotRequest) {
    this.seen.push(req)
    return this.inner.snapshot()
  }
}

const library = () => ({
  templates: [templates.procurement],
  policies: [policies.baseline, policies.procurement],
})

describe('assetsOf leaves the hashed policy byte-identical', () => {
  it('resolves the issuer for the ledger read and does not write it back', async () => {
    const baseline = deepFreeze(structuredClone(policies.baseline))
    const policy = deepFreeze(structuredClone(policies.procurement))
    const before = JSON.stringify(policy)
    const source = new RecordingSource(new FixtureLedgerSource(b1Ledger()))
    const svc = new CosignerService({
      signer: localSigner(W.cosigner), source, templates: [templates.procurement], policies: [baseline, policy],
    })
    await svc.register(b1Engagement(), b1Mandate())
    const tx = { ...b1Payment(W.vendorA.address, '800', { invoice: 'inv:2026-Q4-0042' }), Sequence: 21 }
    const r = await svc.decide({
      engagementId: 'eng_b1_fixture', stage: 'spend', tx, statements: [b1Invoice()],
    })
    expect(r.decision).toBe('SIGN')
    expect(JSON.stringify(policy)).toBe(before)
    expect(policy.assets!.RLUSD.issuer).toBe('$slot:rlusd.issuer')
    expect(layerHash(policy)).toBe(layerHash(policies.procurement))
    expect(source.seen.some((req) => req.assets.RLUSD.issuer === W.issuer.address)).toBe(true)
    expect(source.seen.every((req) => req.assets.RLUSD.issuer !== '$slot:rlusd.issuer')).toBe(true)
  })
})

describe('register trust', () => {
  it('treats an empty deploy map as no config, the way loopback startup passes {}', async () => {
    const svc = new CosignerService({
      signer: localSigner(W.cosigner), source: new FixtureLedgerSource(b1Ledger()), ...library(), trust: {},
    })
    await expect(svc.register(b1Engagement(), b1Mandate())).resolves.toMatchObject({ ok: true })
  })

  it('UNRESOLVED_SLOT when the record has no trust (loopback, no deploy config)', async () => {
    const svc = new CosignerService({
      signer: localSigner(W.cosigner), source: new FixtureLedgerSource(b1Ledger()), ...library(),
    })
    const { trust: _drop, ...bare } = b1Engagement()
    await expect(svc.register(bare, b1Mandate())).rejects.toThrow(/UNRESOLVED_SLOT/)
    expect(svc.engagement('eng_b1_fixture')).toBeUndefined()
  })

  it('TRUST_MISMATCH names the slot and both addresses, and nothing else from the record', async () => {
    const svc = new CosignerService({
      signer: localSigner(W.cosigner), source: new FixtureLedgerSource(b1Ledger()), ...library(),
      trust: { 'kyb.issuer': W.kybIssuer.address, 'rlusd.issuer': W.fakeIssuer.address },
    })
    await expect(svc.register(b1Engagement(), b1Mandate())).rejects.toThrow(
      new RegExp(`TRUST_MISMATCH: rlusd\\.issuer record ${W.issuer.address} configured ${W.fakeIssuer.address}`),
    )
    try {
      await svc.register(b1Engagement(), b1Mandate())
    } catch (e) {
      expect(String((e as Error).message)).not.toMatch(/eng_b1_fixture/)
    }
  })
})

describe('pre-T13 pins', () => {
  it('quarantines an engagement pinned to the pre-slot policy hash', async () => {
    const store = new MemoryStateStore()
    const source = new FixtureLedgerSource(b1Ledger())
    const opts = {
      signer: localSigner(W.cosigner), source, templates: [templates.procurement],
      policies: [policies.baseline, policies.procurement], store,
    }
    const svc = await CosignerService.open(opts)
    await svc.register(b1Engagement(), b1Mandate())
    const snap = await store.loadAll()
    const saved = snap.engagements[0]
    // On-disk pol_procurement@1.3.0 hash while the RLUSD issuer was still the placeholder string.
    const preT13 = 'att:F0D5BBA2FD0DB86143C266CDD757F7FF67F5A5BDD8EB9403453A4D9C5E635E13'
    saved.pins = {
      ...saved.pins,
      layerHashes: saved.pins.layerHashes.map((h) => (h === layerHash(policies.procurement) ? preT13 : h)),
    }
    await store.transaction((tx) => tx.putEngagement(saved))
    await svc.close()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const again = await CosignerService.open(opts)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ENGAGEMENT_STALE: eng_b1_fixture: pinned policy layer att:F0D5BBA2/))
    await expect(again.decide({
      engagementId: 'eng_b1_fixture', stage: 'spend',
      tx: { ...b1Payment(W.vendorA.address, '800', { invoice: 'inv:2026-Q4-0042' }), Sequence: 21 },
      statements: [b1Invoice()],
    })).rejects.toThrow(/ENGAGEMENT_STALE: eng_b1_fixture/)
    expect(again.engagement('eng_b1_fixture')?.engagementId).toBe('eng_b1_fixture')
    warn.mockRestore()
    await again.close()
  })
})

describe('stored trust vs env', () => {
  it('warns with the slot and both addresses only, and still decides against the stored issuer', async () => {
    const store = new MemoryStateStore()
    const source = new FixtureLedgerSource(b1Ledger())
    const first = await CosignerService.open({
      signer: localSigner(W.cosigner), source, ...library(), store,
      trust: { 'kyb.issuer': W.kybIssuer.address, 'rlusd.issuer': W.issuer.address },
    })
    await first.register(b1Engagement(), b1Mandate())
    await first.close()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const again = await CosignerService.open({
      signer: localSigner(W.cosigner), source, ...library(), store,
      trust: { 'kyb.issuer': W.kybIssuer.address, 'rlusd.issuer': W.fakeIssuer.address },
    })
    const lines = warn.mock.calls.map((c) => c.map(String).join(' '))
    expect(lines).toEqual([
      `trust differs from env: slot rlusd.issuer stored ${W.issuer.address} configured ${W.fakeIssuer.address}`,
    ])
    expect(lines.join('\n')).not.toMatch(/eng_|mandate|parties/)
    const tx = { ...b1Payment(W.vendorA.address, '800', { invoice: 'inv:2026-Q4-0042' }), Sequence: 21 }
    const r = await again.decide({ engagementId: 'eng_b1_fixture', stage: 'spend', tx, statements: [b1Invoice()] })
    expect(r.decision).toBe('SIGN')
    warn.mockRestore()
    await again.close()
  })
})

describe('off-loopback startup', () => {
  const host = '0.0.0.0'
  const slotted = [policies.baseline, policies.procurement, policies.hotel2, policies.shopping]

  it('fails on a missing slot and on a placeholder still in a policy', () => {
    expect(() => assertDeployTrust(host, slotted, {})).toThrow(/unresolved slot rlusd\.issuer/)
    expect(() => assertDeployTrust(host, slotted, loadTrustConfig({
      ENG_RLUSD_ISSUER: W.issuer.address,
      ENG_KYB_ISSUER: W.kybIssuer.address,
    }))).toThrow(/unresolved slot arbiter\.accreditor/)
    const withPlaceholder: PolicyDoc[] = [structuredClone(policies.shopping)]
    withPlaceholder[0].assets!.RLUSD.issuer = 'rRLUSDissuerPlaceholderXXXXXXXXXX'
    expect(() => assertDeployTrust(host, withPlaceholder, {})).toThrow(/placeholder rRLUSDissuerPlaceholderXXXXXXXXXX/)
  })

  it('fails on a bad-checksum address even on loopback, and allows loopback with no config', () => {
    const alphabet = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz'
    let bad = ''
    for (const ch of alphabet) {
      if (ch === W.issuer.address.at(-1)) continue
      const candidate = W.issuer.address.slice(0, -1) + ch
      if (!isClassicAddress(candidate)) { bad = candidate; break }
    }
    expect(bad).not.toBe('')
    expect(() => assertDeployTrust('127.0.0.1', slotted, { 'rlusd.issuer': bad })).toThrow(/not a classic address/)
    expect(() => assertDeployTrust('127.0.0.1', slotted, {})).not.toThrow()
  })

  it('rejects a malformed token, a slot in the wrong field, and an unknown name, including on loopback', () => {
    const malformed = structuredClone(policies.shopping)
    malformed.assets!.RLUSD.issuer = '$slot:RLUSD.issuer'
    expect(() => assertDeployTrust('127.0.0.1', [malformed], {})).toThrow(/unknown slot \$slot:RLUSD\.issuer/)

    const wrong = structuredClone(policies.shopping)
    wrong.stages.spend.rules[0].message += ' $slot:rlusd.issuer'
    expect(() => assertDeployTrust('127.0.0.1', [wrong], {})).toThrow(/only allowed/)

    const unknown = structuredClone(policies.shopping)
    unknown.assets!.RLUSD.issuer = '$slot:foo.bar'
    expect(() => assertDeployTrust(host, [unknown], { 'foo.bar': W.issuer.address })).toThrow(/unknown slot \$slot:foo\.bar/)
  })

  it('starts the check when every slot is a classic Testnet-shaped address', () => {
    const config = loadTrustConfig({
      ENG_RLUSD_ISSUER: W.issuer.address,
      ENG_ARBITER_ACCREDITOR: W.accreditor.address,
      ENG_KYB_ISSUER: W.kybIssuer.address,
    })
    expect(() => assertDeployTrust(host, slotted, config)).not.toThrow()
  })
})
