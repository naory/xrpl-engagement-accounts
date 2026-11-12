import { describe, expect, it } from 'vitest'
import { decide } from '@eng/policy'
import {
  W, checkin, claim, concession, dispute, hotel2Close, hotel2Confirmation, hotel2Input, hotel2Ledger, memo, review, ruling,
} from './fixtures.ts'

const failing = (...args: Parameters<typeof hotel2Input>) => decide(hotel2Input(...args)).failing
const basis = (b: string) => [memo('eng/basis', b)]
const hotel = W.atlas.address
const guest = W.dana.address
const fee = W.service.address

describe('hotel@2 — confirm', () => {
  const at = { stage: 'confirm', ledger: hotel2Ledger({ closeTime: '2026-11-01T09:40:00Z' }) }
  it('accepts a deposit within the mandate cap (150 ≤ 200)', () => {
    expect(failing({ ...at, statements: [hotel2Confirmation()] })).toEqual([])
  })
  it('refuses a deposit over the mandate cap (C5)', () => {
    expect(failing({ ...at, statements: [hotel2Confirmation({ deposit: '250.00' })] })).toEqual(['C5'])
  })
})

describe('hotel@2 — checkin', () => {
  const input = (balance: string) => ({ stage: 'checkin', statements: [hotel2Confirmation(), checkin('checked_in')], ledger: hotel2Ledger({ balance, closeTime: '2026-11-11T16:00:00Z' }) })
  it('accepts a check-in once the deposit is on-ledger (balance 562)', () => {
    expect(failing(input('562'))).toEqual([])
  })
  it('refuses while the deposit is missing (K2)', () => {
    expect(failing(input('412'))).toEqual(['K2'])
  })
})

describe('hotel@2 — settle (agreed)', () => {
  const settle = (payouts: Array<{ to: string; value: string }>) => {
    const rv = review(W.dana, 'eng_hotel2_fixture')
    return {
      stage: 'settle',
      proposedTx: hotel2Close(payouts, { memos: [memo('eng/basis', 'settle.agreed'), memo('eng/review', rv.id)] }),
      statements: [hotel2Confirmation(), checkin('checked_in'), claim([{ kind: 'minibar', amount: '58.00' }]), rv],
      ledger: hotel2Ledger({ balance: '562' }),
    }
  }
  it('signs an agreed split paying the claim, with fee and review', () => {
    expect(failing(settle([{ to: hotel, value: '467.65' }, { to: fee, value: '2.35' }, { to: guest, value: '92.00' }]))).toEqual([])
  })
  it('refuses a payout to anyone but guest, hotel or fee account (S6)', () => {
    const f = failing(settle([{ to: hotel, value: '467.65' }, { to: fee, value: '2.35' }, { to: guest, value: '91.00' }, { to: W.arbiter.address, value: '1.00' }]))
    expect(f).toContain('S6')
  })
})

describe('hotel@2 — refund.conceded', () => {
  const tx = hotel2Close([{ to: guest, value: '422' }], { memos: basis('refund.conceded') })
  const ledger = hotel2Ledger({ balance: '422', dispute: true, closeTime: '2026-11-12T10:00:00Z' })
  it('refunds everything when the hotel concedes an entry dispute', () => {
    const d = dispute('entry')
    expect(failing({ stage: 'refund.conceded', proposedTx: tx, ledger, statements: [hotel2Confirmation(), d, concession(d.id)] })).toEqual([])
  })
  it('refuses without a concession (F1)', () => {
    expect(failing({ stage: 'refund.conceded', proposedTx: tx, ledger, statements: [hotel2Confirmation(), dispute('entry')] })).toEqual(['F1'])
  })
})

describe('hotel@2 — default.refund', () => {
  it('completes after confirmBy when never confirmed', () => {
    const tx = hotel2Close([{ to: guest, value: '412' }], { tickets: true, memos: basis('default.refund') })
    expect(failing({ stage: 'default.refund', proposedTx: tx, ledger: hotel2Ledger({ closeTime: '2026-11-01T11:00:01Z' }) })).toEqual([])
  })
})

describe('hotel@2 — default.noshow', () => {
  const tx = hotel2Close([{ to: hotel, value: '409.94' }, { to: fee, value: '2.06' }], { tickets: true, memos: basis('default.noshow') })
  const after = '2026-11-12T11:00:01Z'
  const input = (statements = [hotel2Confirmation()], ledger = hotel2Ledger({ closeTime: after })) => ({ stage: 'default.noshow', proposedTx: tx, statements, ledger })
  it('releases the room to the hotel after entryDisputeBy when confirmed and not checked in', () => {
    expect(failing(input())).toEqual([])
  })
  it('refuses once the guest checked in (N3)', () => {
    expect(failing(input([hotel2Confirmation(), checkin('checked_in')]))).toEqual(['N3'])
  })
  it('refuses while a guest dispute is open and the bond changed the balance (N4, N5)', () => {
    const f = failing(input([hotel2Confirmation(), dispute('entry')], hotel2Ledger({ closeTime: after, dispute: true, balance: '422' })))
    expect(f).toContain('N4')
    expect(f).toContain('N5')
  })
  it('ignores a dispute Credential with no dispute attestation', () => {
    expect(failing(input([hotel2Confirmation()], hotel2Ledger({ closeTime: after, dispute: true, balance: '412' })))).toEqual([])
  })
})

describe('hotel@2 — default.release', () => {
  const tx = hotel2Close([{ to: hotel, value: '409.94' }, { to: fee, value: '2.06' }, { to: guest, value: '150' }], { tickets: true, memos: basis('default.release') })
  const input = (extra: ReturnType<typeof claim>[] = [], balance = '562') => ({
    stage: 'default.release', proposedTx: tx, statements: [hotel2Confirmation(), checkin('checked_in'), ...extra], ledger: hotel2Ledger({ balance }),
  })
  it('releases room to the hotel and the deposit to the guest after the window', () => {
    expect(failing(input())).toEqual([])
  })
  it('refuses while a claim is posted (L5)', () => {
    expect(failing(input([claim([{ kind: 'minibar', amount: '58.00' }])]))).toEqual(['L5'])
  })
  it('refuses when stray RLUSD changed the balance (L3)', () => {
    expect(failing(input([], '563'))).toContain('L3')
  })
})

describe('hotel@2 — ruling.backup', () => {
  // settlement dispute posted 2026-11-16T10:00:00Z; rulingWindow 432000 s → backup may rule from 2026-11-21T10:00:00Z
  const payouts = [{ to: hotel, value: '467.65' }, { to: fee, value: '2.35' }, { to: guest, value: '102.00' }]
  const tx = hotel2Close(payouts, { memos: basis('ruling.backup') })
  const input = (closeTime: string, extra: ReturnType<typeof ruling>[] = []) => ({
    stage: 'ruling.backup',
    proposedTx: tx,
    statements: [hotel2Confirmation(), checkin('checked_in'), claim([{ kind: 'minibar', amount: '58.00' }]), dispute('settlement'), ruling(W.backupArbiter, payouts), ...extra],
    ledger: hotel2Ledger({ balance: '572', dispute: true, closeTime }),
  })
  it('refuses 1 s before the ruling window elapses (U1)', () => {
    expect(failing(input('2026-11-21T09:59:59Z'))).toEqual(['U1'])
  })
  it('signs after the window when the tx matches the backup ruling', () => {
    expect(failing(input('2026-11-21T10:00:00Z'))).toEqual([])
  })
  it('refuses when the primary arbiter has ruled (U2)', () => {
    expect(failing(input('2026-11-21T10:00:00Z', [ruling(W.arbiter, payouts)]))).toEqual(['U2'])
  })
})

describe('hotel@2 — ruling.default (advisory)', () => {
  const tx = hotel2Close([{ to: hotel, value: '467.65' }, { to: fee, value: '2.35' }, { to: guest, value: '92.00' }], { memos: basis('ruling.default') })
  const input = (amount: string) => ({
    stage: 'ruling.default', proposedTx: tx,
    statements: [hotel2Confirmation(), checkin('checked_in'), claim([{ kind: 'damage', amount }])],
    ledger: hotel2Ledger({ balance: '562' }),
  })
  it('records an unanswered claim paid exactly after the window', () => {
    expect(failing(input('58.00'))).toEqual([])
  })
  it('flags a claim above the deposit (D4)', () => {
    expect(failing(input('160.00'))).toContain('D4')
  })
})
