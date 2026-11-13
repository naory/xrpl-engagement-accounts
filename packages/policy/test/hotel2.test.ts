import { describe, expect, it } from 'vitest'
import type { Statement } from '@eng/core'
import { decide } from '@eng/policy'
import {
  W, checkin, claim, concession, dispute, hotel2Close, hotel2Confirmation, hotel2Input, hotel2Ledger, memo, review, ruling, statement,
} from './fixtures.ts'

const checkinAt = (status: 'checked_in' | 'refused', t: string): Statement => statement(W.atlas, {
  kind: 'COUNTERPARTY', type: 'party.checkin/1', engagementId: 'eng_hotel2_fixture', subject: { bookingId: 'ATL-60417' },
  claim: { status, room: '204', deposit: { currency: 'RLUSD', value: '150.00' } }, observedAt: t, issuedAt: t,
})
const hotel2ConfirmationAt = (t: string, deposit: string): Statement => {
  const c = hotel2Confirmation({ deposit })
  return statement(W.atlas, { kind: 'COUNTERPARTY', type: 'party.confirmation/1', engagementId: 'eng_hotel2_fixture', subject: c.subject, claim: c.claim, observedAt: t, issuedAt: t })
}
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
  it('refuses while the deposit is missing (K2; K1 too: a check-in counts only with the deposit in, R29)', () => {
    expect(failing(input('412'))).toEqual(['K1', 'K2'])
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
  it('refuses a concession of a settlement-phase dispute (F1)', () => {
    const d = dispute('settlement')
    const l = hotel2Ledger({ balance: '422', dispute: true, closeTime: '2026-11-16T11:00:00Z' })
    expect(failing({ stage: 'refund.conceded', proposedTx: tx, ledger: l, statements: [hotel2Confirmation(), d, concession(d.id)] })).toEqual(['F1'])
  })
  it('refuses when only the hotel issued the dispute Credential (F1)', () => {
    const l = hotel2Ledger({ balance: '422', closeTime: '2026-11-12T10:00:00Z' })
    l.credentials.push({ issuer: hotel, subject: W.engHotel2.address, type: 'ENG/DISPUTE', accepted: false, expiration: null })
    const d = dispute('entry')
    expect(failing({ stage: 'refund.conceded', proposedTx: tx, ledger: l, statements: [hotel2Confirmation(), d, concession(d.id)] })).toEqual(['F1'])
  })
})

describe('hotel@2 — default.refund', () => {
  const tx = hotel2Close([{ to: guest, value: '412' }], { tickets: true, memos: basis('default.refund') })
  const ledger = hotel2Ledger({ closeTime: '2026-11-01T11:00:01Z' })
  it('completes after confirmBy when never confirmed', () => {
    expect(failing({ stage: 'default.refund', proposedTx: tx, ledger })).toEqual([])
  })
  it('refuses once the booking is confirmed (R1)', () => {
    expect(failing({ stage: 'default.refund', proposedTx: tx, ledger, statements: [hotel2Confirmation()] })).toEqual(['R1'])
  })
  it('refunds after confirmBy when the only confirmation states a deposit over the cap', () => {
    expect(failing({ stage: 'default.refund', proposedTx: tx, ledger, statements: [hotel2Confirmation({ deposit: '250.00' })] })).toEqual([])
  })
})

describe('hotel@2 — default.noshow', () => {
  const tx = hotel2Close([{ to: hotel, value: '409.94' }, { to: fee, value: '2.06' }], { tickets: true, memos: basis('default.noshow') })
  const after = '2026-11-12T11:00:01Z'
  const input = (statements = [hotel2Confirmation()], ledger = hotel2Ledger({ closeTime: after })) => ({ stage: 'default.noshow', proposedTx: tx, statements, ledger })
  it('releases the room to the hotel after entryDisputeBy when confirmed and not checked in', () => {
    expect(failing(input())).toEqual([])
  })
  it('refuses once the guest checked in and paid the deposit (N3; the deposit also trips N5)', () => {
    const f = failing(input([hotel2Confirmation(), checkin('checked_in')], hotel2Ledger({ closeTime: after, balance: '562' })))
    expect(f).toContain('N3')
    expect(f).toContain('N5')
  })
  it('a hotel-only checked_in with no deposit paid does not block the no-show (R29)', () => {
    expect(failing(input([hotel2Confirmation(), checkin('checked_in')]))).toEqual([])
  })
  it('the latest check-in statement counts: checked_in then refused is not checked in (R29)', () => {
    const refused = checkinAt('refused', '2026-11-11T15:05:00Z')
    const f = failing(input([hotel2Confirmation(), checkin('checked_in'), refused], hotel2Ledger({ closeTime: after, balance: '562' })))
    expect(f).not.toContain('N3')
    expect(f).toContain('N5') // the deposit is in, so the no-show still cannot take it
  })
  it('refuses while a guest dispute is open and the bond changed the balance (N4, N5)', () => {
    const f = failing(input([hotel2Confirmation(), dispute('entry')], hotel2Ledger({ closeTime: after, dispute: true, balance: '422' })))
    expect(f).toContain('N4')
    expect(f).toContain('N5')
  })
  it('ignores a dispute Credential with no dispute attestation', () => {
    expect(failing(input([hotel2Confirmation()], hotel2Ledger({ closeTime: after, dispute: true, balance: '412' })))).toEqual([])
  })
  it('ignores a dispute with Credential and attestation but no bond posted', () => {
    expect(failing(input([hotel2Confirmation(), dispute('entry')], hotel2Ledger({ closeTime: after, dispute: true, balance: '412' })))).toEqual([])
  })
  it('refuses before entryDisputeBy even though checkInBy passed (N1)', () => {
    expect(failing(input([hotel2Confirmation()], hotel2Ledger({ closeTime: '2026-11-12T11:00:00Z' })))).toEqual(['N1'])
  })
  it('refuses when the confirmed deposit exceeds the mandate cap (N2)', () => {
    expect(failing(input([hotel2Confirmation({ deposit: '250.00' })]))).toEqual(['N2'])
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
  it('refuses while a guest dispute is open (L2)', () => {
    // room + deposit + 10.00 bond; the bond also trips the exact-balance locks (L3, B7, B11)
    const i = { ...input([dispute('settlement')]), ledger: hotel2Ledger({ balance: '572', dispute: true }) }
    expect(failing(i)).toContain('L2')
  })
  it('uses the first confirmation: a re-issued one cannot move the deposit (R28)', () => {
    const second = hotel2ConfirmationAt('2026-11-11T16:00:00Z', '100.00')
    expect(failing(input([second]))).toEqual([])
    const tx100 = hotel2Close([{ to: hotel, value: '459.69' }, { to: fee, value: '2.31' }, { to: guest, value: '100' }], { tickets: true, memos: basis('default.release') })
    expect(failing({ ...input([second]), proposedTx: tx100 })).toContain('L6')
  })
  it('acts strictly after disputeWindowEnds: refuses exactly at it, signs 1 s later (L1)', () => {
    expect(failing({ ...input(), ledger: hotel2Ledger({ balance: '562', closeTime: '2026-11-17T11:00:00Z' }) })).toEqual(['L1'])
    expect(failing({ ...input(), ledger: hotel2Ledger({ balance: '562', closeTime: '2026-11-17T11:00:01Z' }) })).toEqual([])
  })
})

describe('hotel@2 — an entry dispute survives a later checked_in (R29)', () => {
  // Entry dispute with bond, no deposit (balance 412 + 10). A checked_in posted after it must not lift the
  // disputeOpen threshold by the deposit (it is not on the ledger), so the dispute keeps counting.
  const ledger = (closeTime: string) => hotel2Ledger({ balance: '422', dispute: true, closeTime })
  it('backup arbiter can still rule on the entry dispute', () => {
    const payouts = [{ to: guest, value: '422' }]
    const d = dispute('entry')
    expect(failing({
      stage: 'ruling.backup', proposedTx: hotel2Close(payouts, { memos: basis('ruling.backup') }),
      statements: [hotel2Confirmation(), d, checkinAt('checked_in', '2026-11-11T21:00:00Z'), ruling(W.backupArbiter, payouts)],
      ledger: ledger('2026-11-21T00:00:00Z'),
    })).toEqual([])
  })
  it('the hotel can still concede it', () => {
    const d = dispute('entry')
    expect(failing({
      stage: 'refund.conceded', proposedTx: hotel2Close([{ to: guest, value: '422' }], { memos: basis('refund.conceded') }),
      statements: [hotel2Confirmation(), d, checkinAt('checked_in', '2026-11-11T21:00:00Z'), concession(d.id)],
      ledger: ledger('2026-11-12T10:00:00Z'),
    })).toEqual([])
  })
})

describe('hotel@2 — ruling.backup', () => {
  // settlement dispute posted 2026-11-16T10:00:00Z; rulingWindow 432000 s → backup may act after 2026-11-21T10:00:00Z
  const payouts = [{ to: hotel, value: '467.65' }, { to: fee, value: '2.35' }, { to: guest, value: '102.00' }]
  const tx = hotel2Close(payouts, { memos: basis('ruling.backup') })
  const input = (closeTime: string, extra: Statement[] = [], disputes = [dispute('settlement')], proposedTx = tx, backup = payouts, rulingAt?: string) => ({
    stage: 'ruling.backup',
    proposedTx,
    statements: [hotel2Confirmation(), checkin('checked_in'), claim([{ kind: 'minibar', amount: '58.00' }]), ...disputes, ruling(W.backupArbiter, backup, rulingAt), ...extra],
    ledger: hotel2Ledger({ balance: '572', dispute: true, closeTime }),
  })
  it('refuses 1 s before the ruling window elapses (U1)', () => {
    expect(failing(input('2026-11-21T09:59:59Z'))).toEqual(['U1'])
  })
  it('refuses exactly at the end of the ruling window (U1)', () => {
    expect(failing(input('2026-11-21T10:00:00Z'))).toEqual(['U1'])
  })
  it('signs after the window when the tx matches the backup ruling', () => {
    expect(failing(input('2026-11-21T10:00:01Z'))).toEqual([])
  })
  it('refuses when the primary arbiter has ruled (U2)', () => {
    expect(failing(input('2026-11-21T10:00:01Z', [ruling(W.arbiter, payouts)]))).toEqual(['U2'])
  })
  it('floors a backdated dispute at deliveryBy, so the backup cannot rule right after filing (U1)', () => {
    // filed 11-16T10:00 but issuedAt backdated to 11-02; backup ruling signed a minute after filing
    expect(failing(input('2026-11-16T10:05:00Z', [], [dispute('settlement', '2026-11-02T00:00:00Z')], tx, payouts, '2026-11-16T10:01:00Z'))).toEqual(['U1'])
  })
  it('times a settlement dispute from its own filing, not an older entry-phase attestation (U1)', () => {
    // the entry attestation (11-11T20:00) alone would make the window end 11-16T20:00
    expect(failing(input('2026-11-17T00:00:00Z', [], [dispute('entry'), dispute('settlement')], tx, payouts, '2026-11-16T10:01:00Z'))).toEqual(['U1'])
  })
  it('refuses a tx with an extra payee not in the ruling (U4)', () => {
    const extra = hotel2Close([{ to: hotel, value: '467.65' }, { to: fee, value: '2.35' }, { to: guest, value: '101.00' }, { to: W.arbiter.address, value: '1.00' }], { memos: basis('ruling.backup') })
    expect(failing(input('2026-11-21T10:00:01Z', [], undefined, extra))).toContain('U4')
  })
  it('refuses a ruling that names a payee twice (U4)', () => {
    const t = hotel2Close([{ to: hotel, value: '467.65' }, { to: fee, value: '2.35' }, { to: guest, value: '102.00' }], { memos: basis('ruling.backup') })
    const dup = [{ to: hotel, value: '467.65' }, { to: hotel, value: '0' }, { to: guest, value: '102.00' }]
    expect(failing(input('2026-11-21T10:00:01Z', [], undefined, t, dup))).toEqual(['U4'])
  })
  it('refuses a ruling whose fee is not 50 bps of what the hotel receives (U6)', () => {
    const noFee = [{ to: hotel, value: '470.00' }, { to: guest, value: '102.00' }]
    expect(failing(input('2026-11-21T10:00:01Z', [], undefined, hotel2Close(noFee, { memos: basis('ruling.backup') }), noFee))).toEqual(['U6'])
  })
  it('claim-only branch: acts strictly after disputeWindowEnds + rulingWindow (U1)', () => {
    const cp = [{ to: hotel, value: '467.65' }, { to: fee, value: '2.35' }, { to: guest, value: '92.00' }]
    const at = (closeTime: string) => ({
      stage: 'ruling.backup',
      proposedTx: hotel2Close(cp, { memos: basis('ruling.backup') }),
      statements: [hotel2Confirmation(), checkin('checked_in'), claim([{ kind: 'minibar', amount: '58.00' }]), ruling(W.backupArbiter, cp)],
      ledger: hotel2Ledger({ balance: '562', closeTime }),
    })
    expect(failing(at('2026-11-22T11:00:00Z'))).toEqual(['U1'])
    expect(failing(at('2026-11-22T11:00:01Z'))).toEqual([])
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
  it('flags payouts that do not match the claim (D5)', () => {
    expect(failing(input('50.00'))).toEqual(['D5'])
  })
})
