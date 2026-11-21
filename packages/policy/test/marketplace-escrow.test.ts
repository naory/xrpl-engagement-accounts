import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MIN_INSPECT_GAP_SECS, MIN_SHIP_WINDOW_SECS, documentHash, signStatement, type Statement, type Template } from '@eng/core'
import {
  baselineFor, celDurationMs, decide, layerHash, lintPolicy,
  type DecideInput, type Decision, type EngagementRecord, type LedgerSnapshot, type PolicyDoc,
} from '@eng/policy'
import { LEDGER_INDEX, W, closeBatch, fixtureTrust, memo, policies, wallet } from './fixtures.ts'

const root = new URL('../../../', import.meta.url)
const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(new URL(p, root), 'utf8')) as T

const template = readJson<Template>('templates/marketplace-escrow@1.json')
const policy = readJson<PolicyDoc>('policies/marketplace-escrow@1.0.0.json')
const baseline12 = readJson<PolicyDoc>('policies/baseline@1.2.0.json')
/** hotel@1 / hotel@2 / baseline@1.1.0 hashes at the time baseline@1.2.0 was added. These files stay byte-identical. */
const HOTEL1_TEMPLATE_HASH = 'att:CC728BCD9853CF75FFC3CEAB7704E6496FC95AF32E7E18177B1E52B9A05648BC'
const HOTEL2_TEMPLATE_HASH = 'att:1BAD00F1DD2A4CE693E21A8E18BCF6A60CBD323B5020A65B38CFAC36D6A2E0A6'
const BASELINE_11_HASH = 'att:D378635B36159F619C6029AECE7A5AA4C49969148044EE803E88591ADE4D9B59'
const eng = wallet('marketplace-escrow-account')
const carrier = wallet('marketplace-escrow-carrier')
const ENG = 'eng_marketplace_escrow_fixture'
const OPEN = '2026-11-01T00:00:00Z'
const SHIP_BY = '2026-11-04T00:00:00Z'
const INSPECT_BY = '2026-11-11T00:00:00Z'
const AFTER_SHIP = '2026-11-04T00:00:01Z'
const AFTER_INSPECT = '2026-11-11T00:00:01Z'

function engagement(): EngagementRecord {
  return {
    engagementId: ENG,
    template: template.templateId,
    account: eng.address,
    asset: 'RLUSD',
    parties: {
      principal: W.dana.address,
      counterparty: W.atlas.address,
      arbiter: W.arbiter.address,
      cosigner: W.cosigner.address,
    },
    fee: { bps: 50, to: W.service.address },
    deleteTo: W.service.address,
    amount: { asset: 'RLUSD', value: '2.00' },
    timers: { open: OPEN, shipBy: SHIP_BY, inspectBy: INSPECT_BY },
    attesters: { shipping: { accounts: [carrier.address], kind: 'SHIPPING' } },
    state: 'OPEN',
    consumed: [],
    trust: fixtureTrust([baseline12, policy]),
  }
}

function ledger(closeTime: string, balance: string, sequence?: number): LedgerSnapshot {
  return {
    index: LEDGER_INDEX,
    hash: 'D'.repeat(64),
    closeTime,
    baseFeeDrops: '10',
    reserveIncDrops: '200000',
    accounts: {
      [eng.address]: {
        exists: true,
        masterDisabled: true,
        regularKey: null,
        ...(sequence != null ? { sequence } : {}),
        ownerObjects: { trustlines: 1, signerList: true, tickets: Array.from({ length: 16 }, (_, i) => 101 + i), other: 0 },
      },
    },
    balances: { [eng.address]: { RLUSD: balance } },
    credentials: [],
    history: {},
  }
}

function at(closeTime: string): string {
  return new Date(Date.parse(closeTime) - 60_000).toISOString().replace('.000Z', 'Z')
}

function shipment(closeTime: string): Statement {
  const issuedAt = at(closeTime)
  return signStatement({
    v: 'eng.att/1', type: 'shipping.shipped/1', engagementId: ENG,
    subject: { tracking: 'TRK-1' }, claim: { status: 'shipped' },
    observedAt: issuedAt, issuedAt, nonce: 'me-ship-0001',
    attester: { account: carrier.address, kind: 'SHIPPING' },
  }, carrier)
}

function dispute(): Statement {
  return signStatement({
    v: 'eng.att/1', type: 'party.dispute/1', engagementId: ENG,
    subject: { item: 'sku-1' }, claim: { reason: 'not as described' },
    observedAt: '2026-11-05T00:00:00Z', issuedAt: '2026-11-05T00:00:00Z', nonce: 'me-dispute-0001',
    attester: { account: W.dana.address, kind: 'PRINCIPAL' },
  }, W.dana)
}

const basis = (stage: string) => [memo('eng/basis', stage)]

function refundTx(value: string, stage: string, tickets = true) {
  return closeBatch([{ to: W.dana.address, value }], { account: eng.address, tickets, memos: basis(stage) })
}

function releaseExact() {
  return closeBatch(
    [{ to: W.atlas.address, value: '1.99' }, { to: W.service.address, value: '0.01' }],
    { account: eng.address, tickets: true, memos: basis('default.release') },
  )
}

function releaseSweep() {
  return closeBatch(
    [{ to: W.atlas.address, value: '1.99' }, { to: W.service.address, value: '0.01' }, { to: W.dana.address, value: '0', partial: true }],
    { account: eng.address, tickets: true, memos: basis('default.release') },
  )
}

function confirmTx(payouts: Array<{ to: string; value: string }>) {
  return closeBatch(payouts, { account: eng.address, memos: basis('release.confirm') })
}

function input(over: Partial<DecideInput> = {}): DecideInput {
  return {
    stage: 'default.refund',
    proposedTx: refundTx('2.00', 'default.refund'),
    engagement: engagement(),
    template,
    layers: [baseline12, policy],
    mandate: null,
    statements: [],
    ledger: ledger(AFTER_SHIP, '2.00'),
    inflight: [],
    ...over,
  }
}

const failing = (d: Decision) => d.failing
const reasons = (d: Decision) => d.results.filter((r) => r.result === 'fail' || r.result === 'error').map((r) => r.reason)

describe('marketplace-escrow@1 policy', () => {
  it('lints, has the Dev Lead windows, and has no rulingWindow or ruling-absence rule', () => {
    expect(lintPolicy(policy, template)).toEqual([])
    expect(policy.params).not.toHaveProperty('rulingWindow')
    expect(celDurationMs(String(policy.params!.minShipWindow))).toBe(MIN_SHIP_WINDOW_SECS * 1000)
    expect(celDurationMs(String(policy.params!.minInspectGap))).toBe(MIN_INSPECT_GAP_SECS * 1000)
    expect(celDurationMs(String(policy.params!.rulingOverdueRepeat))).toBe(86_400 * 1000)
    expect(policy.params!.serviceFeeBps).toBe(50)
    // Confirmed bond. The deal-timer check against these params is TODO(PR3) next to V14 in template.ts (spec §3).
    expect(policy.params!.minDisputeBond).toBe('0.50')
    expect(template.baselineRef).toBe('pol_baseline@1.2.0')
    expect(policy.baselineRef).toBe('pol_baseline@1.2.0')
    const checks = Object.values(policy.stages).flatMap((s) => s.rules.map((r) => `${r.when ?? ''} ${r.check}`))
    expect(checks.join('\n')).not.toMatch(/ruling|party\.ruling/)
  })

  it('L11 fails when baselineRef drifts and passes when the policy matches the template', () => {
    const drifted = structuredClone(policy)
    drifted.baselineRef = 'pol_baseline@1.1.0'
    expect(lintPolicy(drifted, template).map((f) => `${f.id} ${f.where}`)).toEqual(['L11 baselineRef'])
    expect(lintPolicy(policy, template).filter((f) => f.id === 'L11')).toEqual([])
  })

  it('refuses default.refund before shipBy and signs it after, with no shipment', () => {
    const early = decide(input({ ledger: ledger('2026-11-03T23:59:59Z', '2.00') }))
    expect(early.decision).toBe('REFUSE')
    expect(reasons(early)).toContain('NOT_DUE')

    const due = decide(input())
    expect(failing(due)).toEqual([])
    expect(due.decision).toBe('SIGN')
  })

  it('refuses default.refund once a shipment is receipted, and still signs it when a dispute is open', () => {
    const shipped = decide(input({ statements: [shipment(AFTER_SHIP)] }))
    expect(shipped.decision).toBe('REFUSE')
    expect(reasons(shipped)).toContain('SHIPPED')
    expect(reasons(shipped)).not.toContain('NOT_DUE')

    const disputed = decide(input({
      proposedTx: refundTx('2.50', 'default.refund'),
      statements: [dispute()],
      ledger: ledger(AFTER_SHIP, '2.50'),
    }))
    expect(failing(disputed)).toEqual([])
    expect(disputed.decision).toBe('SIGN')
  })

  it('refuses default.release before inspectBy and when nothing was shipped', () => {
    const early = decide(input({
      stage: 'default.release',
      proposedTx: releaseExact(),
      statements: [shipment('2026-11-10T00:00:00Z')],
      ledger: ledger('2026-11-10T00:00:00Z', '2.00'),
    }))
    expect(early.decision).toBe('REFUSE')
    expect(reasons(early)).toContain('NOT_DUE')
    expect(reasons(early)).not.toContain('NOT_SHIPPED')

    const unshipped = decide(input({
      stage: 'default.release',
      proposedTx: releaseExact(),
      ledger: ledger(AFTER_INSPECT, '2.00'),
    }))
    expect(unshipped.decision).toBe('REFUSE')
    expect(reasons(unshipped)).toContain('NOT_SHIPPED')
  })

  it('signs an exact release after inspectBy and refuses it while a bonded dispute is open', () => {
    const released = decide(input({
      stage: 'default.release',
      proposedTx: releaseExact(),
      statements: [shipment(AFTER_INSPECT)],
      ledger: ledger(AFTER_INSPECT, '2.00'),
    }))
    expect(failing(released)).toEqual([])
    expect(released.decision).toBe('SIGN')

    const open = decide(input({
      stage: 'default.release',
      proposedTx: releaseSweep(),
      statements: [shipment(AFTER_INSPECT), dispute()],
      ledger: ledger(AFTER_INSPECT, '2.50'),
    }))
    expect(open.decision).toBe('REFUSE')
    expect(reasons(open)).toContain('DISPUTE_OPEN')
    expect(reasons(open)).not.toContain('NOT_DUE')
    expect(reasons(open)).not.toContain('PAYOUT_MISMATCH')
  })

  it('refuses the exact release when extra RLUSD is in the account and signs the sweep', () => {
    const exact = decide(input({
      stage: 'default.release',
      proposedTx: releaseExact(),
      statements: [shipment(AFTER_INSPECT)],
      ledger: ledger(AFTER_INSPECT, '2.50'),
    }))
    expect(exact.decision).toBe('REFUSE')
    expect(reasons(exact)).toContain('PAYOUT_MISMATCH')

    const sweep = decide(input({
      stage: 'default.release',
      proposedTx: releaseSweep(),
      statements: [shipment(AFTER_INSPECT)],
      ledger: ledger(AFTER_INSPECT, '2.50'),
    }))
    expect(failing(sweep)).toEqual([])
    expect(sweep.decision).toBe('SIGN')
  })

  it('baseline@1.2.0 B2 signs release.confirm and refund.agreed, and refuses a bad fee or payee', () => {
    const b2 = (d: Decision) => d.results.find((r) => r.id === 'B2')
    const confirmed = decide(input({
      stage: 'release.confirm',
      proposedTx: confirmTx([{ to: W.atlas.address, value: '1.99' }, { to: W.service.address, value: '0.01' }]),
      ledger: ledger(OPEN, '2.00'),
    }))
    expect(failing(confirmed)).toEqual([])
    expect(confirmed.decision).toBe('SIGN')
    expect(b2(confirmed)).toMatchObject({ layer: 'pol_baseline@1.2.0', result: 'pass' })

    const fee = decide(input({
      stage: 'release.confirm',
      proposedTx: confirmTx([{ to: W.atlas.address, value: '1.98' }, { to: W.service.address, value: '0.02' }]),
      ledger: ledger(OPEN, '2.00'),
    }))
    expect(fee.decision).toBe('REFUSE')
    expect(reasons(fee)).toContain('FEE_MISMATCH')
    expect(b2(fee)?.result).toBe('pass')

    const stranger = wallet('marketplace-escrow-stranger')
    const payee = decide(input({
      stage: 'release.confirm',
      proposedTx: confirmTx([{ to: stranger.address, value: '1.99' }, { to: W.service.address, value: '0.01' }]),
      ledger: ledger(OPEN, '2.00'),
    }))
    expect(payee.decision).toBe('REFUSE')
    expect(reasons(payee)).toContain('BAD_PAYEE')

    const agreed = decide(input({
      stage: 'refund.agreed',
      proposedTx: refundTx('2.00', 'refund.agreed', false),
      ledger: ledger(OPEN, '2.00'),
    }))
    expect(failing(agreed)).toEqual([])
    expect(agreed.decision).toBe('SIGN')
    expect(b2(agreed)).toMatchObject({ layer: 'pol_baseline@1.2.0', result: 'pass' })
  })

  it('pins hotel@1, hotel@2 and baseline@1.1.0 hashes, and keeps hotel on 1.1.0 when 1.2.0 is also loaded', () => {
    expect(documentHash(readJson('templates/hotel@1.json'))).toBe(HOTEL1_TEMPLATE_HASH)
    expect(documentHash(readJson('templates/hotel@2.json'))).toBe(HOTEL2_TEMPLATE_HASH)
    expect(layerHash(readJson('policies/baseline@1.1.0.json'))).toBe(BASELINE_11_HASH)
    expect(layerHash(baseline12)).not.toBe(BASELINE_11_HASH)
    const hotel1 = readJson<Template>('templates/hotel@1.json')
    const hotel2 = readJson<Template>('templates/hotel@2.json')
    const both = [baseline12, policies.baseline]
    expect(baselineFor(template, both)?.version).toBe('1.2.0')
    expect(baselineFor(hotel1, both)?.version).toBe('1.1.0')
    expect(baselineFor(hotel2, both)?.version).toBe('1.1.0')
    expect(hotel1.baselineRef).toBeUndefined()
    expect(hotel2.baselineRef).toBeUndefined()
  })

  it('baseline B11 refuses a pre-signed release the ledger would not accept, and B2 refuses SetRegularKey', () => {
    const young = decide(input({
      stage: 'default.release',
      proposedTx: releaseExact(),
      statements: [shipment(AFTER_INSPECT)],
      ledger: ledger(AFTER_INSPECT, '2.00', LEDGER_INDEX - 255),
    }))
    expect(young.decision).toBe('REFUSE')
    expect(reasons(young)).toContain('WOULD_FAIL')

    const tx = releaseExact()
    const raw = tx.RawTransactions as Array<{ RawTransaction: Record<string, unknown> }>
    raw.splice(raw.length - 1, 0, {
      RawTransaction: {
        TransactionType: 'SetRegularKey', Account: eng.address, RegularKey: W.atlas.address,
        Fee: '0', Sequence: 0, TicketSequence: 110, SigningPubKey: '',
      },
    })
    const keyed = decide(input({
      stage: 'default.release',
      proposedTx: tx,
      statements: [shipment(AFTER_INSPECT)],
      ledger: ledger(AFTER_INSPECT, '2.00'),
    }))
    expect(keyed.decision).toBe('REFUSE')
    expect(reasons(keyed)).toContain('TX_TYPE_NOT_ALLOWED')
  })
})
