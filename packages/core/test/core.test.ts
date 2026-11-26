import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import xrpl from 'xrpl'
import {
  Amount, AssetMismatchError, bps, canonicalize, formatAmount, parseAmount, toMinor,
  signStatement, verifyStatement, statementId, newNonce, validateTemplate, minimalWinningSets, weightOf,
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
  it('accepts hotel@2: no backup arbiter, chargeback defaults with 13 per-night stay variants, arbiter + co-signer not winning', () => {
    const r = validateTemplate(load('hotel@2.json'))
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    // refund 4 + noshow exact 5 + noshow sweep 6 + release 6 + chargebackEntry 4 + chargebackClaim 6 + chargebackStay 13 × 6
    expect(r.ticketsNeeded).toBe(109)
    expect(r.minimalWinningSets).toEqual([['counterparty', 'arbiter'], ['principal', 'arbiter'], ['principal', 'counterparty', 'cosigner']])
    expect(r.minimalWinningSets.flat()).not.toContain('backupArbiter')
    expect(r.minimalWinningSets).not.toContainEqual(['arbiter', 'cosigner'])
    expect(r.disclosures.filter((d) => d.id === 'V11')).toEqual([])
  })
  it('V15: every arbiter role declares service accreditation', () => {
    const t = structuredClone(load('hotel@2.json'))
    delete (t.roles.arbiter as { accreditation?: string }).accreditation
    expect(validateTemplate(t).errors.map((e) => e.id)).toEqual(['V15'])
    ;(t.roles.arbiter as { accreditation?: string }).accreditation = 'self'
    expect(validateTemplate(t).errors.map((e) => e.id)).toEqual(['V15'])
    expect(validateTemplate(load('hotel@1.json')).errors).toEqual([])
  })
  it('V8 counts per-night variants as max x (1 + steps)', () => {
    const t = structuredClone(load('hotel@2.json'))
    const base = validateTemplate(t).ticketsNeeded
    const [name, o] = Object.entries(t.outcomes).find(([, x]: any) => x.presigned) as [string, any]
    const steps = t.blueprints[o.blueprint].steps.length
    o.variants = { perNight: true, max: 13 }
    expect(validateTemplate(t).ticketsNeeded).toBe(base - (1 + steps) + 13 * (1 + steps))
    void name
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
    t.roles.arbiter2 = { weight: 3, kind: 'arbiter', operatedBy: 'external', accreditation: 'service' }
    expect(validateTemplate(t).errors.map((e) => e.id)).toContain('V11')
  })
  it('E4 backup-arbiter scheme P3·C3·A1 4·A2 2·S2·Q7 passes, with the documented disclosures', () => {
    const t = hotel()
    t.quorum = 7
    t.roles = {
      principal: { weight: 3, kind: 'principal', operatedBy: 'external' },
      counterparty: { weight: 3, kind: 'counterparty', operatedBy: 'external' },
      arbiter: { weight: 4, kind: 'arbiter', operatedBy: 'external', accreditation: 'service' },
      arbiter2: { weight: 2, kind: 'arbiter', operatedBy: 'external', accreditation: 'service' },
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

  const marketplace = () => structuredClone(load('marketplace-escrow@1.json'))
  it('accepts marketplace-escrow@1: hotel@2 winning sets, 15 Tickets, 4.4 XRP, only the V10 disclosure', () => {
    const t = marketplace()
    const r = validateTemplate(t)
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.minimalWinningSets).toEqual([['counterparty', 'arbiter'], ['principal', 'arbiter'], ['principal', 'counterparty', 'cosigner']])
    expect(r.ticketsNeeded).toBe(15)
    expect(r.reserveDrops).toBe(4_400_000n)
    expect(r.disclosures).toEqual([{ id: 'V10', message: '{counterparty, arbiter} can move funds without the principal' }])
    expect(r.warnings).toEqual([])
    expect(t.timers!.rulingDueBy.onExpire).toBe('escalate')
    expect(t.dispute?.lateRuling).toBe('accept')
    expect(t.dispute?.overdueTimer).toBe('rulingDueBy')
    // buyer+seller, arbiter+co-signer, and seller+co-signer are below quorum (ME13)
    for (const set of [['principal', 'counterparty'], ['arbiter', 'cosigner'], ['counterparty', 'cosigner']]) {
      expect(weightOf(t, set)).toBeLessThan(t.quorum)
      expect(r.minimalWinningSets).not.toContainEqual(set)
    }
  })
  it('V14: shipBy must end strictly before inspectBy; the 24h and 7d floors are policy params, not V14', () => {
    const badOrder = marketplace()
    badOrder.timers!.inspectBy.durationSecs = badOrder.timers!.shipBy.durationSecs
    expect(validateTemplate(badOrder).errors.map((e) => e.id)).toContain('V14')

    const differentAnchor = marketplace()
    differentAnchor.timers!.inspectBy.from = 'shipBy'
    expect(validateTemplate(differentAnchor).errors.map((e) => e.id)).toContain('V14')

    // A 1h ship window and a 1h inspect gap still order correctly. Register rejects them via minShipWindow / minInspectGap.
    const short = marketplace()
    short.timers!.shipBy.durationSecs = 3600
    short.timers!.inspectBy.durationSecs = 7200
    expect(validateTemplate(short).errors).toEqual([])
    expect(validateTemplate(marketplace()).errors).toEqual([])
  })
  it('V16: dispute.by names template roles, and plusParam names a policy param', () => {
    const unknown = marketplace()
    unknown.dispute!.by = ['guest']
    expect(validateTemplate(unknown).errors.map((e) => e.id)).toContain('V16')
    const params = { minDisputeBond: '0.50', serviceFeeBps: 50 }
    const missing = marketplace()
    missing.dispute!.bond.plusParam = 'noSuchParam'
    expect(validateTemplate(missing, { policyParams: params }).errors.map((e) => e.id)).toEqual(['V16'])
    expect(validateTemplate(marketplace(), { policyParams: params }).errors).toEqual([])
  })
  it('V6: the dispute overdue timer is escalate, so arbiter silence is not a pre-signed outcome', () => {
    const silent = marketplace()
    silent.timers!.rulingDueBy.onExpire = 'default.release'
    expect(validateTemplate(silent).errors.map((e) => e.id)).toContain('V6')
    expect(validateTemplate(marketplace()).errors).toEqual([])
  })

  // Option (a) live marketplace, inlined. Every outcome is signed when it runs; no Tickets.
  const liveMarketplace = (): Template => structuredClone({
    templateId: 'settlement-vault/marketplace-escrow@1',
    class: 'escrow',
    asset: { code: 'RLUSD' },
    roles: {
      principal: { weight: 3, kind: 'principal', operatedBy: 'external' },
      counterparty: { weight: 3, kind: 'counterparty', operatedBy: 'external' },
      arbiter: { weight: 4, kind: 'arbiter', operatedBy: 'external', accreditation: 'service' },
      cosigner: { weight: 2, kind: 'cosigner', operatedBy: 'service' },
    },
    quorum: 7,
    outcomes: {
      'release.confirm': { signers: [['principal', 'counterparty', 'cosigner']], blueprint: 'close.split', policyStage: 'release.confirm', enforcement: 'ledger' },
      'refund.agreed': { signers: [['principal', 'counterparty', 'cosigner']], blueprint: 'close.refundAll', policyStage: 'refund.agreed', enforcement: 'ledger' },
      'dispute.refund': { signers: [['arbiter', 'principal']], blueprint: 'close.refundAll', policyStage: null, enforcement: 'none', requires: 'ruling' },
      'dispute.release': { signers: [['arbiter', 'counterparty']], blueprint: 'close.split', policyStage: null, enforcement: 'none', requires: 'ruling' },
      'default.refund': {
        signers: [['arbiter', 'principal'], ['arbiter', 'counterparty']],
        blueprint: 'close.refundAll', policyStage: 'default.refund', enforcement: 'advisory', requires: 'timeout',
      },
      'default.release': {
        signers: [['arbiter', 'principal'], ['arbiter', 'counterparty']],
        blueprint: 'close.split', policyStage: 'default.release', enforcement: 'advisory', requires: 'timeout',
      },
    },
    timers: {
      shipBy: { from: 'open', durationSecs: 259200, onExpire: 'default.refund' },
      inspectBy: { from: 'open', durationSecs: 864000, onExpire: 'default.release' },
      rulingDueBy: { from: 'disputeOpened', durationSecs: 432000, onExpire: 'escalate' },
    },
    attestationWindows: { 'shipping.shipped/1': 'shipBy', 'party.dispute/1': 'inspectBy' },
    dispute: { by: ['principal'], bond: { base: 'amount', plusParam: 'minDisputeBond' }, lateRuling: 'accept', overdueTimer: 'rulingDueBy' },
    blueprints: {
      'close.split': { steps: ['pay.counterparty?', 'pay.serviceFee?', 'pay.principal?', 'trustline.remove', 'account.delete'], closes: true },
      'close.refundAll': { steps: ['pay.principal', 'trustline.remove', 'account.delete'], closes: true },
    },
    reserveObjects: { trustlines: 1, signerList: 1 },
    fees: { serviceFeeBps: 50, paidBy: 'counterparty' },
    policyRef: 'pol_marketplace-escrow@1.1.0',
    baselineRef: 'pol_baseline@1.2.0',
    signing: 'live',
  } as Template)
  const ids = (t: Template) => validateTemplate(t).errors.map((e) => e.id)

  it('live marketplace: 0 Tickets, 1.4 XRP, only the V10 disclosure', () => {
    const r = validateTemplate(liveMarketplace())
    expect(r.errors).toEqual([])
    expect(r.ticketsNeeded).toBe(0)
    expect(r.reserveDrops).toBe(1_400_000n)
    expect(r.disclosures.map((d) => d.id)).toEqual(['V10'])
  })
  it('option (a) live marketplace passes with no errors and no Tickets', () => {
    const r = validateTemplate(liveMarketplace())
    expect(r.errors).toEqual([])
    expect(r.ticketsNeeded).toBe(0)
  })
  it('V6: a live timeout on a template without signing "live" is refused', () => {
    const t = liveMarketplace()
    delete (t as { signing?: string }).signing
    expect(ids(t)).toEqual(['V6', 'V6'])
  })
  it('V6: a live timeout with policyStage null is refused', () => {
    const t = liveMarketplace()
    t.outcomes['default.refund'].policyStage = null
    expect(ids(t)).toEqual(['V6'])
  })
  it('V6: a live timeout with no arbiter in a signer set is refused', () => {
    const t = liveMarketplace()
    t.outcomes['default.release'].signers = [['arbiter', 'counterparty'], ['principal', 'counterparty', 'cosigner']]
    expect(ids(t)).toContain('V6')
  })
  it('V6: requires other than timeout is refused', () => {
    const t = liveMarketplace()
    t.outcomes['default.refund'].requires = 'ruling'
    expect(ids(t)).toEqual(['V6'])
  })
  it('V6: enforcement other than advisory is refused', () => {
    const t = liveMarketplace()
    t.outcomes['default.refund'].enforcement = 'none'
    expect(ids(t)).toEqual(['V6'])
  })
  it('V17: a pre-signed outcome on a live template is refused, and so are its Tickets', () => {
    const t = liveMarketplace()
    t.outcomes['default.refund'] = {
      ...t.outcomes['default.refund'],
      presigned: true,
      finalSigner: 'cosigner',
      signers: [['principal', 'counterparty', 'cosigner']],
      enforcement: 'final-signature',
      requires: undefined,
    }
    const e = ids(t)
    expect(e.filter((x) => x === 'V17')).toHaveLength(2)
  })
  it('V17: a stray finalSigner alone is refused', () => {
    const t = liveMarketplace()
    t.outcomes['default.release'].finalSigner = 'cosigner'
    expect(ids(t)).toContain('V17')
  })
  it('non-live templates are unchanged', () => {
    const shipped: Array<[string, number]> = [
      ['hotel@1.json', 9],
      ['hotel@2.json', 109],
      ['marketplace-escrow@1.json', 15],
      ['procurement@1.json', 0],
      ['shopping@1.json', 0],
    ]
    for (const [file, tickets] of shipped) {
      const r = validateTemplate(load(file))
      expect(r.errors, file).toEqual([])
      expect(r.ticketsNeeded, file).toBe(tickets)
    }
  })
})
