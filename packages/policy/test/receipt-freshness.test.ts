// Receipt-time freshness and key checks (marketplace-escrow@1 §4.2). Window-governed receipted
// statements are judged against the receipt; everything else stays on the evaluation ledger.
import { describe, expect, it } from 'vitest'
import { signStatement, type Statement } from '@eng/core'
import { verifyStatements, type EngagementRecord, type LedgerSnapshot } from '@eng/policy'
import { LEDGER_INDEX, W, wallet } from './fixtures.ts'

const carrier = wallet('marketplace-escrow-carrier')
const rotated = wallet('marketplace-escrow-rotated')
const stranger = wallet('marketplace-escrow-stranger')
const ENG = 'eng_me_fresh'
const EVAL = '2026-11-11T00:00:01Z'
const OBSERVED = '2026-11-08T00:00:00Z' // three days before the evaluation ledger
const RECEIVED = '2026-11-08T00:01:00Z'

function eng(over: Partial<EngagementRecord> = {}): EngagementRecord {
  return {
    engagementId: ENG,
    template: 'settlement-vault/marketplace-escrow@1',
    account: W.engHotel.address,
    asset: 'RLUSD',
    parties: { principal: W.dana.address, counterparty: W.atlas.address, arbiter: W.arbiter.address, cosigner: W.cosigner.address },
    state: 'OPEN',
    consumed: [],
    attesters: { shipping: { accounts: [carrier.address], kind: 'SHIPPING', types: ['shipping.shipped/1'] } },
    ...over,
  }
}

function ledger(closeTime: string, accounts: LedgerSnapshot['accounts'] = {}): LedgerSnapshot {
  return {
    index: LEDGER_INDEX, hash: 'E'.repeat(64), closeTime,
    baseFeeDrops: '10', reserveIncDrops: '200000',
    accounts, balances: {}, credentials: [], history: {},
  }
}

function ship(signer = carrier, observedAt = OBSERVED): Statement {
  return signStatement({
    v: 'eng.att/1', type: 'shipping.shipped/1', engagementId: ENG,
    subject: { tracking: 'TRK-1' }, claim: { status: 'shipped' },
    observedAt, issuedAt: observedAt, nonce: 'fresh-ship-1',
    attester: { account: carrier.address, kind: 'SHIPPING' },
  }, signer)
}

const windows = { 'shipping.shipped/1': 'shipBy', 'party.dispute/1': 'inspectBy' }

describe('receipt-time judgement', () => {
  it('a shipment observed three days before the evaluation ledger is STALE there, and counts at its receipt', () => {
    const s = ship()
    const atEval = verifyStatements([s], eng(), ledger(EVAL))
    expect(atEval.rejected.map((r) => r.code)).toEqual(['STALE'])
    expect(atEval.verified).toEqual([])

    const atReceipt = verifyStatements([s], eng(), ledger(EVAL), new Map([[s.id, { receivedAt: RECEIVED, attesterIsParty: false }]]), windows)
    expect(atReceipt.rejected).toEqual([])
    expect(atReceipt.verified.map((v) => v.statement.id)).toEqual([s.id])
  })

  it('a receipted shipment still counts after the carrier rotates its RegularKey', () => {
    const s = ship(carrier, '2026-11-10T12:00:00Z')
    const rotatedLedger = ledger('2026-11-11T00:00:01Z', {
      [carrier.address]: { exists: true, masterDisabled: true, regularKey: rotated.address },
    })
    const judgedNow = verifyStatements([s], eng(), rotatedLedger, undefined, windows)
    expect(judgedNow.rejected.map((r) => r.code)).toContain('KEY_NOT_AUTHORIZED')

    const judgedThen = verifyStatements([s], eng(), rotatedLedger, new Map([[s.id, { receivedAt: '2026-11-10T12:01:00Z', attesterIsParty: false }]]), windows)
    expect(judgedThen.rejected).toEqual([])
    expect(judgedThen.verified).toHaveLength(1)
  })

  it('a hotel party statement keeps the decision-time key check after a rotation', () => {
    const s = signStatement({
      v: 'eng.att/1', type: 'party.dispute/1', engagementId: ENG,
      subject: { bookingId: 'ATL' }, claim: { phase: 'entry' },
      observedAt: '2026-11-11T20:00:00Z', issuedAt: '2026-11-11T20:00:00Z', nonce: 'fresh-dispute-1',
      attester: { account: W.dana.address, kind: 'PRINCIPAL' },
    }, W.dana)
    const hotelWindows = { 'party.dispute/1#entry': 'entryDisputeBy' }
    const rotatedLedger = ledger('2026-11-11T20:01:00Z', {
      [W.dana.address]: { exists: true, masterDisabled: true, regularKey: rotated.address },
    })
    const out = verifyStatements([s], eng(), rotatedLedger, new Map([[s.id, { receivedAt: '2026-11-11T20:00:30Z', attesterIsParty: true }]]), hotelWindows)
    expect(out.rejected.map((r) => r.code)).toContain('KEY_NOT_AUTHORIZED')
  })

  it('a stored non-window-governed approval.payment/1 still goes STALE after 1h', () => {
    const observedAt = '2026-11-11T00:00:00Z'
    const s = signStatement({
      v: 'eng.att/1', type: 'approval.payment/1', engagementId: ENG,
      subject: { intentHash: 'sha256:00' }, claim: { approverRole: 'controller' },
      observedAt, issuedAt: observedAt, nonce: 'fresh-approval-1',
      attester: { account: W.controller.address, kind: 'APPROVER' },
    }, W.controller)
    const later = ledger('2026-11-11T02:00:01Z')
    const out = verifyStatements(
      [s],
      eng({ attesters: { approver: { accounts: [W.controller.address] } } }),
      later,
      new Map([[s.id, { receivedAt: observedAt, attesterIsParty: false }]]),
      windows,
    )
    expect(out.rejected.map((r) => r.code)).toEqual(['STALE'])
  })

  it('a re-signed copy does not ride a receipt tied to the original signer', () => {
    const original = ship()
    const forged = signStatement({
      v: 'eng.att/1', type: 'shipping.shipped/1', engagementId: ENG,
      subject: { tracking: 'TRK-1' }, claim: { status: 'shipped' },
      observedAt: OBSERVED, issuedAt: OBSERVED, nonce: 'fresh-ship-1',
      attester: { account: carrier.address, kind: 'SHIPPING' },
    }, stranger)
    expect(forged.id).toBe(original.id)
    const rotatedLedger = ledger(EVAL, {
      [carrier.address]: { exists: true, masterDisabled: true, regularKey: rotated.address },
    })
    const out = verifyStatements([forged], eng(), rotatedLedger, new Map([[original.id, {
      receivedAt: RECEIVED, attesterIsParty: false, signerPublicKey: original.proof.publicKey,
    }]]), windows)
    expect(out.rejected.map((r) => r.code)).toContain('KEY_NOT_AUTHORIZED')
    expect(out.verified).toEqual([])
  })

  it('TYPE_NOT_ALLOWED when no naming entry allows the type, and not when one of them does', () => {
    const review = signStatement({
      v: 'eng.att/1', type: 'party.review/1', engagementId: ENG,
      subject: { item: 'sku-1' }, claim: { rating: 1 },
      observedAt: EVAL, issuedAt: EVAL, nonce: 'fresh-review-1',
      attester: { account: carrier.address, kind: 'SHIPPING' },
    }, carrier)
    const onlyShip = verifyStatements([review], eng(), ledger(EVAL))
    expect(onlyShip.rejected.map((r) => r.code)).toContain('TYPE_NOT_ALLOWED')

    const either = verifyStatements([review], eng({
      attesters: {
        shipping: { accounts: [carrier.address], kind: 'SHIPPING', types: ['shipping.shipped/1'] },
        qa: { accounts: [carrier.address], kind: 'QA', types: ['party.review/1'] },
      },
    }), ledger(EVAL))
    expect(either.rejected.map((r) => r.code)).not.toContain('TYPE_NOT_ALLOWED')
    expect(either.verified.map((v) => v.statement.id)).toEqual([review.id])
  })
})
