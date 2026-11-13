import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import xrpl from 'xrpl'
import {
  Amount, AssetMismatchError, bps, canonicalize, formatAmount, parseAmount, toMinor,
  signStatement, verifyStatement, statementId, newNonce, validateTemplate, minimalWinningSets,
  type StatementBody, type Template,
} from '../src/index.ts'

const RLUSD = { code: 'RLUSD', kind: 'IOU' as const, currency: 'RLUSD', issuer: 'rI', decimals: 6 }
const load = (f: string) => JSON.parse(fs.readFileSync(new URL(`../../../templates/${f}`, import.meta.url), 'utf8')) as Template

describe('amounts', () => {
  it('parses decimals exactly', () => {
    expect(toMinor('412', 6)).toBe(412_000_000n)
    expect(toMinor('409.94', 6)).toBe(409_940_000n)
    expect(toMinor('1e-6', 6)).toBe(1n)
    expect(toMinor('2.5e2', 6)).toBe(250_000_000n)
    expect(toMinor('-3.5', 6)).toBe(-3_500_000n)
    expect(() => toMinor('0.0000001', 6)).toThrow(/too many decimals/)
    expect(() => toMinor('abc', 6)).toThrow()
  })
  it('formats and rounds bps down', () => {
    const a = parseAmount('288.40', RLUSD)
    expect(formatAmount(bps(a, 50n), 6)).toBe('1.442')
    expect(formatAmount(parseAmount('409.94', RLUSD), 6)).toBe('409.94')
  })
  it('refuses to mix assets', () => {
    expect(() => new Amount('RLUSD', 1n).add(new Amount('USDC', 1n))).toThrow(AssetMismatchError)
  })
})

describe('JCS', () => {
  it('sorts keys and rejects floats/bigints', () => {
    expect(canonicalize({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}')
    expect(() => canonicalize({ x: 1.5 })).toThrow()
    expect(() => canonicalize({ x: 1n })).toThrow()
  })
})

describe('statements', () => {
  const body = (w: { address: string }): StatementBody => ({
    v: 'eng.att/1', type: 'approval.payment/1', engagementId: 'eng_test',
    subject: { intentHash: 'sha256:00' }, claim: { approverRole: 'controller' },
    observedAt: '2026-11-18T09:31:00Z', issuedAt: '2026-11-18T09:31:02Z', nonce: newNonce(),
    attester: { account: w.address, kind: 'APPROVER' },
  })
  for (const algorithm of ['ed25519', 'ecdsa-secp256k1'] as const) {
    it(`signs and verifies (${algorithm})`, () => {
      const w = xrpl.Wallet.generate(algorithm as never)
      const s = signStatement(body(w), w)
      const { proof: _p, id: _i, ...b } = s
      expect(s.id).toBe(statementId(b))
      const r = verifyStatement(s)
      expect(r.ok && r.signerAddress).toBe(w.address)
      expect(verifyStatement({ ...s, claim: { approverRole: 'cfo' } }).ok).toBe(false) // tamper → BAD_ID
      const other = xrpl.Wallet.generate()
      const forged = { ...s, proof: { ...s.proof, publicKey: other.publicKey } }
      expect(verifyStatement(forged)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' })
    })
  }
})

describe('template validator', () => {
  it('accepts the hotel template with the expected winning sets and disclosure', () => {
    const r = validateTemplate(load('hotel@1.json'), { preCreateFundingDrops: 6_000_000n })
    expect(r.errors).toEqual([])
    expect(r.minimalWinningSets).toEqual([['counterparty', 'arbiter'], ['principal', 'arbiter'], ['principal', 'counterparty', 'cosigner']])
    expect(r.ticketsNeeded).toBe(9)
    expect(r.reserveDrops).toBe(3_200_000n)
    expect(r.disclosures.map((d) => d.message)).toContain('{counterparty, arbiter} can move funds without the principal')
  })
  it('accepts the procurement owner-wallet template (owner may act alone)', () => {
    const r = validateTemplate(load('procurement@1.json'))
    expect(r.errors).toEqual([])
    expect(r.minimalWinningSets).toEqual([['owner'], ['agent', 'cosigner']])
  })
  it('accepts hotel@2: 15 tickets, no arbiter-only winning set, arbiters+service disclosed', () => {
    const r = validateTemplate(load('hotel@2.json'))
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.ticketsNeeded).toBe(15)
    expect(r.disclosures.filter((d) => d.id === 'V11').map((d) => d.message)).toEqual([expect.stringContaining('arbiter, backupArbiter, cosigner')])
    expect(r.minimalWinningSets).toContainEqual(['principal', 'arbiter'])
    expect(r.minimalWinningSets).not.toContainEqual(['arbiter', 'backupArbiter'])
  })
  it('V6 accepts onExpire "none" (a window that only closes)', () => {
    const t = structuredClone(load('hotel@1.json'))
    t.timers = { ...t.timers, claimBy: { from: 'deliveryBy', durationSecs: 86400, onExpire: 'none' } }
    expect(validateTemplate(t).errors).toEqual([])
  })
  const hotel = () => structuredClone(load('hotel@1.json'))
  it('V1: rejects a service that can reach quorum', () => {
    const t = hotel(); t.roles.cosigner.weight = 5
    expect(validateTemplate(t).errors.map((e) => e.id)).toContain('V1')
  })
  it('V2: rejects a single external role at quorum in an escrow', () => {
    const t = hotel(); t.roles.arbiter.weight = 5
    expect(validateTemplate(t).errors.map((e) => e.id)).toContain('V2')
  })
  it('V3: rejects templates that stall without the service', () => {
    const t = hotel() // remove the arbiter: now every winning set needs the co-signer
    delete (t.roles as Record<string, unknown>).arbiter
    delete (t.outcomes as Record<string, unknown>)['settle.ruling']
    const ids = validateTemplate(t).errors.map((e) => e.id)
    expect(ids).toContain('V3')
  })
  it('V5: rejects a pre-signed default that is submittable without the final signature', () => {
    const t = hotel(); t.roles.principal.weight = 3 // principal + counterparty = 5
    expect(validateTemplate(t).errors.map((e) => e.id)).toContain('V5')
  })
  it('V7: rejects oversized and badly ordered blueprints', () => {
    const t = hotel()
    t.blueprints['close.refundAll'].steps = ['pay.principal', 'account.delete', 'trustline.remove']
    t.blueprints['close.split'].steps = Array(9).fill('pay.principal?')
    const ids = validateTemplate(t).errors.map((e) => e.id)
    expect(ids.filter((i) => i === 'V7').length).toBeGreaterThanOrEqual(2)
  })
  it('V11 (E4): two equal-weight arbiter slots let the arbiters collude', () => {
    const t = hotel()
    t.roles.arbiter2 = { weight: 3, kind: 'arbiter', operatedBy: 'external' }
    expect(validateTemplate(t).errors.map((e) => e.id)).toContain('V11')
  })
  it('E4 backup-arbiter scheme P3·C3·A1 4·A2 2·S2·Q7 passes, with the documented disclosures', () => {
    const t = hotel()
    t.quorum = 7
    t.roles = {
      principal: { weight: 3, kind: 'principal', operatedBy: 'external' },
      counterparty: { weight: 3, kind: 'counterparty', operatedBy: 'external' },
      arbiter: { weight: 4, kind: 'arbiter', operatedBy: 'external' },
      arbiter2: { weight: 2, kind: 'arbiter', operatedBy: 'external' },
      cosigner: { weight: 2, kind: 'cosigner', operatedBy: 'service' },
    }
    const r = validateTemplate(t)
    expect(r.errors).toEqual([])
    const msgs = r.disclosures.map((d) => d.message)
    expect(msgs).toContain('{counterparty, arbiter} can move funds without the principal')
    expect(msgs).toContain('{counterparty, arbiter2, cosigner} can move funds without the principal')
    expect(msgs).toContain('{arbiter, arbiter2, cosigner} (arbiters + service) can move funds without any party')
  })
  it('V12: rejects a "ledger-enforced" outcome that does not need the co-signer', () => {
    const t = hotel(); t.outcomes['settle.ruling'].enforcement = 'ledger'
    expect(validateTemplate(t).errors.map((e) => e.id)).toContain('V12')
  })
  const hotel2 = () => structuredClone(load('hotel@2.json'))
  it('V13: attestation windows must name a statement type and a known timer', () => {
    const bads: Array<Record<string, string>> = [{ 'party.claim/1': 'claimByTypo' }, { 'claim': 'claimBy' }, { 'party.dispute/1#': 'entryDisputeBy' }, { 'party.dispute/1#a#b': 'entryDisputeBy' }]
    for (const bad of bads) {
      const t = hotel2(); t.attestationWindows = bad
      expect(validateTemplate(t).errors.map((e) => e.id)).toEqual(['V13'])
    }
    const t = hotel2(); t.attestationWindows = { 'party.checkin/1': 'checkIn' } // an anchor a template timer runs from
    expect(validateTemplate(t).errors).toEqual([])
  })
  it('V14: entryDisputeBy may not close before checkInBy; claimBy must close before disputeWindowEnds', () => {
    const a = hotel2(); a.timers!.entryDisputeBy.durationSecs = a.timers!.checkInBy.durationSecs - 1
    expect(validateTemplate(a).errors.map((e) => e.id)).toEqual(['V14'])
    const b = hotel2(); b.timers!.claimBy.durationSecs = b.timers!.disputeWindowEnds.durationSecs
    expect(validateTemplate(b).errors.map((e) => e.id)).toEqual(['V14'])
    const c = hotel2(); c.timers!.entryDisputeBy.durationSecs = c.timers!.checkInBy.durationSecs // equal is allowed
    expect(validateTemplate(c).errors).toEqual([])
    const d = hotel2(); d.timers!.claimBy.from = 'checkIn'; d.timers!.claimBy.durationSecs = 10 ** 7 // different anchors: not compared
    expect(validateTemplate(d).errors).toEqual([])
  })
  it('minimal winning sets exclude supersets', () => {
    const t = hotel()
    const sets = minimalWinningSets(t).map((s) => s.join('+'))
    expect(sets).not.toContain('principal+counterparty+arbiter')
  })
})
