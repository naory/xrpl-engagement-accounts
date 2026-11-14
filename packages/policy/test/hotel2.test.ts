import { describe, expect, it } from 'vitest'
import type { Statement } from '@eng/core'
import { decide } from '@eng/policy'
import {
  W, checkin, claim, concession, dispute, hotel2Close, hotel2Confirmation, hotel2Engagement, hotel2Input, hotel2Ledger, memo, review, ruling, statement,
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
  it('refuses once the guest checked in and paid the deposit (N3; this exact variant also cannot leave the deposit behind, N8)', () => {
    const f = failing(input([hotel2Confirmation(), checkin('checked_in')], hotel2Ledger({ closeTime: after, balance: '562' })))
    expect(f).toContain('N3')
    expect(f).toContain('N8')
  })
  it('a hotel-only checked_in with no deposit paid does not block the no-show (R29)', () => {
    expect(failing(input([hotel2Confirmation(), checkin('checked_in')]))).toEqual([])
  })
  it('a recorded check-in with the deposit in is final: a later refused statement does not make it a no-show (N3)', () => {
    // The co-signer rejects such a refused at ingest (CHECKIN_FINAL); the policy holds even if one were present.
    const refused = checkinAt('refused', '2026-11-11T15:05:00Z')
    const f = failing(input([hotel2Confirmation(), checkin('checked_in'), refused], hotel2Ledger({ closeTime: after, balance: '562' })))
    expect(f).toContain('N3')
  })
  it('refuses while a guest dispute is open (N4; the exact variant also cannot leave the bond behind, N8)', () => {
    const f = failing(input([hotel2Confirmation(), dispute('entry')], hotel2Ledger({ closeTime: after, dispute: true, balance: '422' })))
    expect(f).toContain('N4')
    expect(f).toContain('N8')
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
  it('refuses a fixed-deposit release that would leave stray RLUSD behind (L6; the sweep variant returns it)', () => {
    expect(failing(input([], '563'))).toContain('L6')
  })
  it('refuses while a guest dispute is open (L2)', () => {
    // room + deposit + 10.00 bond; this fixed-deposit release would also strand the bond (L6, B7, B11)
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
  it('the entry chargeback still fires on it once the arbiter misses its deadline', () => {
    const d = dispute('entry')
    expect(failing({
      stage: 'default.chargebackEntry', proposedTx: hotel2Close([{ to: guest, value: '0', partial: true }], { tickets: true, memos: basis('default.chargebackEntry') }),
      statements: [hotel2Confirmation(), d, checkinAt('checked_in', '2026-11-11T21:00:00Z')],
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

describe('hotel@2 — chargeback-style defaults when the arbiter misses its ruling deadline', () => {
  const sweep = { to: guest, value: '0', partial: true }
  const cb = (stage: string, payouts: Array<{ to: string; value: string; partial?: boolean }>) => hotel2Close(payouts, { tickets: true, memos: basis(stage) })
  const arbiterRuled = (at = '2026-11-14T09:00:00Z') => ruling(W.arbiter, [{ to: guest, value: '1.00' }], at)

  describe('default.chargebackEntry', () => {
    // entry dispute filed 11-11T20:00 (after the scheduled check-in 14:00); rulingWindow 5 days → due after 11-16T20:00
    const tx = cb('default.chargebackEntry', [sweep])
    const input = (closeTime: string, extra: Statement[] = [], o: { disputes?: Statement[]; balance?: string; open?: boolean; proposedTx?: Record<string, unknown>; engagement?: ReturnType<typeof hotel2Engagement> } = {}) => ({
      stage: 'default.chargebackEntry', proposedTx: o.proposedTx ?? tx,
      ...(o.engagement ? { engagement: o.engagement } : {}),
      statements: [hotel2Confirmation(), ...(o.disputes ?? [dispute('entry')]), ...extra],
      ledger: hotel2Ledger({ balance: o.balance ?? '422', dispute: o.open ?? true, closeTime }),
    })
    it('bonded entry dispute, deadline passed, no ruling: everything (room + bond) goes to the guest', () => {
      expect(failing(input('2026-11-16T20:00:01Z'))).toEqual([])
    })
    it('refuses 1 s before the deadline and exactly at it (E1)', () => {
      expect(failing(input('2026-11-16T19:59:59Z'))).toEqual(['E1'])
      expect(failing(input('2026-11-16T20:00:00Z'))).toEqual(['E1'])
    })
    it('refuses for good once the arbiter\'s ruling is receipted (E2), even long after the deadline', () => {
      expect(failing(input('2026-11-16T20:00:01Z', [arbiterRuled()]))).toEqual(['E2'])
      expect(failing(input('2027-03-01T00:00:00Z', [arbiterRuled()]))).toEqual(['E2'])
    })
    it('refuses with no dispute open (E1)', () => {
      expect(failing(input('2026-11-16T20:00:01Z', [], { disputes: [], balance: '412', open: false }))).toEqual(['E1'])
    })
    it('refuses for a stay dispute (E1)', () => {
      expect(failing(input('2026-11-21T20:00:01Z', [checkin('checked_in')], { disputes: [dispute('stay')], balance: '572' }))).toContain('E1')
    })
    it('refuses when more than one dispute is on file: ambiguous, the arbiter decides (E1)', () => {
      expect(failing(input('2026-11-21T20:00:01Z', [], { disputes: [dispute('entry'), dispute('entry', '2026-11-11T21:00:00Z')] }))).toEqual(['E1'])
    })
    it('a fixed payment that leaves the bond behind is refused (E4)', () => {
      expect(failing(input('2026-11-16T20:00:01Z', [], { proposedTx: cb('default.chargebackEntry', [{ to: guest, value: '412' }]) }))).toContain('E4')
    })
    it('uses the deal\'s pinned ruling window when the record has one (3 days → due after 11-14T20:00)', () => {
      const engagement = hotel2Engagement({ terms: { nights: 3, nightly: '137.333333', rulingWindow: '259200s' } })
      expect(failing(input('2026-11-14T20:00:00Z', [], { engagement }))).toEqual(['E1'])
      expect(failing(input('2026-11-14T20:00:01Z', [], { engagement }))).toEqual([])
    })
  })

  describe('default.chargebackClaim', () => {
    // settlement dispute filed 11-16T10:00 (after checkout 11-14T11:00) → due after 11-21T10:00
    const roomToHotel = [{ to: hotel, value: '409.94' }, { to: fee, value: '2.06' }]
    const tx = cb('default.chargebackClaim', [...roomToHotel, sweep])
    const input = (closeTime: string, extra: Statement[] = [], o: { disputes?: Statement[]; balance?: string; open?: boolean; proposedTx?: Record<string, unknown> } = {}) => ({
      stage: 'default.chargebackClaim', proposedTx: o.proposedTx ?? tx,
      statements: [hotel2Confirmation(), checkin('checked_in'), claim([{ kind: 'minibar', amount: '58.00' }]), ...(o.disputes ?? [dispute('settlement')]), ...extra],
      ledger: hotel2Ledger({ balance: o.balance ?? '572', dispute: o.open ?? true, closeTime }),
    })
    it('settlement dispute past the deadline: room to the hotel (less fee), the claim ignored, deposit + bond to the guest', () => {
      expect(failing(input('2026-11-21T10:00:01Z'))).toEqual([])
    })
    it('refuses 1 s before the deadline (G1)', () => {
      expect(failing(input('2026-11-21T09:59:59Z'))).toEqual(['G1'])
    })
    it('refuses a hotel leg 1 short of the room (G4)', () => {
      expect(failing(input('2026-11-21T10:00:01Z', [], { proposedTx: cb('default.chargebackClaim', [{ to: hotel, value: '408.94' }, { to: fee, value: '2.06' }, sweep]) }))).toContain('G4')
    })
    it('refuses when the guest leg is not the residual sweep (G5)', () => {
      const t = cb('default.chargebackClaim', [{ to: hotel, value: '0', partial: true }, { to: fee, value: '2.06' }, { to: guest, value: '160' }])
      expect(failing(input('2026-11-21T10:00:01Z', [], { proposedTx: t }))).toEqual(['G5'])
    })
    it('refuses once the arbiter\'s ruling is receipted (G2)', () => {
      expect(failing(input('2026-11-21T10:00:01Z', [arbiterRuled('2026-11-18T09:00:00Z')]))).toEqual(['G2'])
    })
    it('refuses with no dispute open (G1)', () => {
      expect(failing(input('2026-11-21T10:00:01Z', [], { disputes: [], balance: '562', open: false }))).toContain('G1')
    })
    it('refuses for an entry dispute (G1)', () => {
      expect(failing(input('2026-11-21T10:00:01Z', [], { disputes: [dispute('entry')] }))).toEqual(['G1'])
    })
  })

  describe('default.chargebackStay (per-night variants)', () => {
    // 3-night deal, room 400, nightly 133.33; scheduled check-in 11-11T14:00 → night 1 [11-11T14:00, 11-12T14:00),
    // night 2 [11-12T14:00, 11-13T14:00), night 3 from 11-13T14:00. Balance = room 400 + deposit 150 + bond 10.
    const engagement = (nights = 3, nightly = '133.33') => hotel2Engagement({ amount: { asset: 'RLUSD', value: '400.00' }, terms: { nights, nightly } })
    const variant = (merchant: string, f: string) => cb('default.chargebackStay', [{ to: hotel, value: merchant }, { to: fee, value: f }, sweep])
    const night1 = variant('132.66335', '0.66665') // 133.33 less 0.5%
    const night2 = variant('265.3267', '1.3333') // 266.66 less 0.5%
    const night3 = variant('397.99005', '1.99995') // 399.99: no such variant exists (the last night uses the claim chargeback)
    const claimTx = cb('default.chargebackClaim', [{ to: hotel, value: '398.00' }, { to: fee, value: '2.00' }, sweep])
    const input = (disputeAt: string | null, proposedTx: Record<string, unknown> = night1, o: { nights?: number; nightly?: string; extra?: Statement[]; stage?: string; checkedIn?: boolean } = {}) => ({
      stage: o.stage ?? 'default.chargebackStay', proposedTx, engagement: engagement(o.nights, o.nightly),
      statements: [hotel2Confirmation({ total: '400.00' }), ...(o.checkedIn === false ? [] : [checkin('checked_in')]), ...(disputeAt ? [dispute('stay', disputeAt)] : []), ...(o.extra ?? [])],
      ledger: hotel2Ledger({ balance: disputeAt ? '560' : '550', dispute: disputeAt != null, closeTime: '2026-11-20T00:00:00Z' }),
    })
    it('dispute in night 1: the night-1 variant pays the hotel 133.33 (less fee), the rest to the guest', () => {
      expect(failing(input('2026-11-11T20:00:00Z'))).toEqual([])
    })
    it('the same blob with the dispute in night 2 is refused (Y4); the night-2 variant signs', () => {
      expect(failing(input('2026-11-12T20:00:00Z'))).toContain('Y4')
      expect(failing(input('2026-11-12T20:00:00Z', night2))).toEqual([])
    })
    it('a dispute exactly at a night boundary counts in the night that has begun', () => {
      expect(failing(input('2026-11-12T13:59:59Z'))).toEqual([])
      expect(failing(input('2026-11-12T14:00:00Z'))).toContain('Y4')
      expect(failing(input('2026-11-12T14:00:00Z', night2))).toEqual([])
    })
    it('dispute in the last night: no stay variant applies (Y1); the claim chargeback pays the whole room', () => {
      expect(failing(input('2026-11-13T15:00:00Z', night3))).toEqual(['Y1'])
      expect(failing(input('2026-11-13T15:00:00Z', night2))).toContain('Y1')
      expect(failing(input('2026-11-13T15:00:00Z', claimTx, { stage: 'default.chargebackClaim' }))).toEqual([])
    })
    it('a mid-stay dispute does not open the claim chargeback (G1)', () => {
      expect(failing(input('2026-11-11T20:00:00Z', claimTx, { stage: 'default.chargebackClaim' }))).toEqual(['G1'])
    })
    it('stays over 14 nights get no stay variants (Y1); 14 nights do', () => {
      expect(failing(input('2026-11-11T20:00:00Z', variant('26.5267', '0.1333'), { nights: 15, nightly: '26.66' }))).toEqual(['Y1'])
      expect(failing(input('2026-11-11T20:00:00Z', variant('28.42715', '0.14285'), { nights: 14, nightly: '28.57' }))).toEqual([])
    })
    it('refuses once the arbiter\'s ruling is receipted (Y2)', () => {
      expect(failing(input('2026-11-11T20:00:00Z', night1, { extra: [arbiterRuled('2026-11-13T09:00:00Z')] }))).toEqual(['Y2'])
    })
    it('refuses with no dispute open (Y1)', () => {
      expect(failing(input(null))).toContain('Y1')
    })
    it('refuses a stay dispute with no recorded check-in (Y1)', () => {
      expect(failing(input('2026-11-11T20:00:00Z', night1, { checkedIn: false }))).toContain('Y1')
    })
    it('refuses before the deadline (Y1)', () => {
      expect(failing({ ...input('2026-11-11T20:00:00Z'), ledger: hotel2Ledger({ balance: '560', dispute: true, closeTime: '2026-11-16T20:00:00Z' }) })).toEqual(['Y1'])
    })
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

describe('hotel@2 — automatic endings return extra money to the guest (residual sweep)', () => {
  // Room 412, confirmed deposit 150. A sweep is a tfPartialPayment to the guest whose amount the engine resolves
  // from the ledger balance (whatever is left after the fixed payouts).
  const sweep = { to: guest, value: '0', partial: true }
  const roomToHotel = [{ to: hotel, value: '409.94' }, { to: fee, value: '2.06' }]
  const refundSweep = hotel2Close([sweep], { tickets: true, memos: basis('default.refund') })
  const refundExact = hotel2Close([{ to: guest, value: '412' }], { tickets: true, memos: basis('default.refund') })
  const noshowExact = hotel2Close(roomToHotel, { tickets: true, memos: basis('default.noshow') })
  const noshowSweep = hotel2Close([...roomToHotel, sweep], { tickets: true, memos: basis('default.noshow') })
  const releaseSweep = hotel2Close([...roomToHotel, sweep], { tickets: true, memos: basis('default.release') })
  const releaseExact = hotel2Close([...roomToHotel, { to: guest, value: '150' }], { tickets: true, memos: basis('default.release') })
  const afterConfirmBy = '2026-11-01T11:00:01Z'
  const afterEntry = '2026-11-12T11:00:01Z'
  const refused = checkinAt('refused', '2026-11-11T15:05:00Z')
  const result = (i: Parameters<typeof hotel2Input>[0], id: string) => decide(hotel2Input(i)).results.find((r) => r.id === id)

  describe('default.refund', () => {
    it('stray 1 RLUSD on an unconfirmed booking: the refund signs and returns room + 1 to the guest', () => {
      expect(failing({ stage: 'default.refund', proposedTx: refundSweep, ledger: hotel2Ledger({ balance: '413', closeTime: afterConfirmBy }) })).toEqual([])
    })
    it('with no extra money the sweep still delivers the whole room price', () => {
      expect(failing({ stage: 'default.refund', proposedTx: refundSweep, ledger: hotel2Ledger({ closeTime: afterConfirmBy }) })).toEqual([])
    })
    it('a fixed-amount refund that would leave the extra behind is refused (R4)', () => {
      expect(failing({ stage: 'default.refund', proposedTx: refundExact, ledger: hotel2Ledger({ balance: '413', closeTime: afterConfirmBy }) })).toEqual(['B7', 'B11', 'R4'])
    })
    it('still refuses when less than the room price is in the account (R2)', () => {
      expect(failing({ stage: 'default.refund', proposedTx: refundSweep, ledger: hotel2Ledger({ balance: '400', closeTime: afterConfirmBy }) })).toContain('R2')
    })
  })

  describe('default.noshow', () => {
    const at = (proposedTx: Record<string, unknown>, balance: string, statements: Statement[] = [hotel2Confirmation(), refused], dispute = false) =>
      ({ stage: 'default.noshow', proposedTx, statements, ledger: hotel2Ledger({ balance, dispute, closeTime: afterEntry }) })
    it('partial deposit (40) + refused check-in: the sweep variant pays the hotel the room less fee and returns the 40 to the guest', () => {
      expect(failing(at(noshowSweep, '452'))).toEqual([])
    })
    it('partial deposit + refused check-in: the exact variant is refused (N8; it would also strand the deposit, B7/B11)', () => {
      expect(failing(at(noshowExact, '452'))).toEqual(['B7', 'B11', 'N8'])
    })
    it('a checked-in guest with the full deposit cannot be no-showed, even with a later refused statement (N3)', () => {
      expect(failing(at(noshowSweep, '562', [hotel2Confirmation(), checkin('checked_in'), refused]))).toEqual(['N3'])
    })
    it('a hotel-only checked_in with only a partial deposit is not a stay: the sweep no-show returns the partial deposit', () => {
      expect(failing(at(noshowSweep, '452', [hotel2Confirmation(), checkin('checked_in')]))).toEqual([])
    })
    it('a refused check-in with no deposit at all: the exact no-show signs', () => {
      expect(failing(at(noshowExact, '412'))).toEqual([])
    })
    it('no extra money: the exact variant signs', () => {
      expect(failing(at(noshowExact, '412', [hotel2Confirmation()]))).toEqual([])
    })
    it('no extra money: the sweep variant is refused because the sweep would deliver nothing (B11, N8)', () => {
      expect(failing(at(noshowSweep, '412', [hotel2Confirmation()]))).toEqual(['B11', 'N8'])
      expect(result({ ...at(noshowSweep, '412', [hotel2Confirmation()]) }, 'B11')).toMatchObject({ result: 'fail', reason: 'WOULD_FAIL' })
    })
    it('an unopened "bond" (no Credential, no dispute statement) is just extra money: it goes back to the guest', () => {
      expect(failing(at(noshowSweep, '422', [hotel2Confirmation()]))).toEqual([])
    })
    it('an open entry dispute still blocks both variants (N4)', () => {
      expect(failing(at(noshowSweep, '422', [hotel2Confirmation(), dispute('entry')], true))).toEqual(['N4'])
      expect(failing(at(noshowExact, '422', [hotel2Confirmation(), dispute('entry')], true))).toContain('N4')
    })
    it('the guest who checked in with the full deposit is still not a no-show (N3)', () => {
      expect(failing(at(noshowSweep, '562', [hotel2Confirmation(), checkin('checked_in')]))).toEqual(['N3'])
    })
    it('the hotel is paid the room only: a sweep variant that takes more than the room is refused (N8)', () => {
      const greedy = hotel2Close([{ to: hotel, value: '449.74' }, { to: fee, value: '2.26' }, sweep], { tickets: true, memos: basis('default.noshow') })
      expect(failing(at(greedy, '462'))).toContain('N8')
    })
  })

  describe('default.release', () => {
    const at = (proposedTx: Record<string, unknown>, balance: string, extra: Statement[] = [], dispute = false) =>
      ({ stage: 'default.release', proposedTx, statements: [hotel2Confirmation(), checkin('checked_in'), ...extra], ledger: hotel2Ledger({ balance, dispute }) })
    it('stray RLUSD after a normal stay: the release signs, the guest gets deposit + extra', () => {
      expect(failing(at(releaseSweep, '563'))).toEqual([])
    })
    it('with no extra money the sweep returns exactly the deposit', () => {
      expect(failing(at(releaseSweep, '562'))).toEqual([])
    })
    it('a fixed-deposit release that would leave the extra behind is refused (L6)', () => {
      expect(failing(at(releaseExact, '563'))).toEqual(['B7', 'B11', 'L6'])
    })
    it('an open settlement dispute still blocks it (L2)', () => {
      expect(failing(at(releaseSweep, '572', [dispute('settlement')], true))).toEqual(['L2'])
    })
    it('a posted claim still blocks it (L5)', () => {
      expect(failing(at(releaseSweep, '563', [claim([{ kind: 'minibar', amount: '58.00' }])]))).toEqual(['L5'])
    })
  })
})

describe('hotel@2 — B11: a pre-signed ending is refused when a payee cannot receive the token', () => {
  // A payment the payee cannot accept fails on-ledger, failing the ALLORNOTHING Batch and burning its Tickets (F2).
  const sweep = { to: guest, value: '0', partial: true }
  const refund = hotel2Close([sweep], { tickets: true, memos: basis('default.refund') })
  const release = hotel2Close([{ to: hotel, value: '409.94' }, { to: fee, value: '2.06' }, sweep], { tickets: true, memos: basis('default.release') })
  type Receive = { depositAuth: boolean; lines: Record<string, { balance: string; limit: string }> }
  const withPayee = (l: ReturnType<typeof hotel2Ledger>, account: string, receive: Receive | null) => {
    l.accounts[account] = receive ? { exists: true, receive } : { exists: false }
    return l
  }
  const ok: Receive = { depositAuth: false, lines: { RLUSD: { balance: '0', limit: '1000000' } } }
  const refundAt = (receive: Receive | null) => ({ stage: 'default.refund', proposedTx: refund, ledger: withPayee(hotel2Ledger({ balance: '413', closeTime: '2026-11-01T11:00:01Z' }), guest, receive) })
  const b11 = (i: Parameters<typeof hotel2Input>[0]) => decide(hotel2Input(i)).results.find((r) => r.id === 'B11')

  it('signs when the guest can receive (trust line with room, no DepositAuth)', () => {
    expect(failing(refundAt(ok))).toEqual([])
  })
  it('B11: trust-line dust beyond 36 decimals does not block a payee with room', () => {
    expect(failing(refundAt({ depositAuth: false, lines: { RLUSD: { balance: '1e-50', limit: '1000000' } } }))).toEqual([])
  })
  it('refuses when the guest set DepositAuth', () => {
    expect(failing(refundAt({ ...ok, depositAuth: true }))).toEqual(['B11'])
    expect(b11(refundAt({ ...ok, depositAuth: true }))).toMatchObject({ result: 'fail', reason: 'WOULD_FAIL' })
  })
  it('refuses when the guest has no RLUSD trust line', () => {
    expect(failing(refundAt({ depositAuth: false, lines: {} }))).toEqual(['B11'])
  })
  it('refuses when the guest trust line has no room for the payment (balance + amount > limit)', () => {
    expect(failing(refundAt({ depositAuth: false, lines: { RLUSD: { balance: '0', limit: '412.999999' } } }))).toEqual(['B11'])
    expect(failing(refundAt({ depositAuth: false, lines: { RLUSD: { balance: '587', limit: '1000' } } }))).toEqual([])
    expect(failing(refundAt({ depositAuth: false, lines: { RLUSD: { balance: '588', limit: '1000' } } }))).toEqual(['B11'])
  })
  it('refuses when the guest account does not exist', () => {
    expect(failing(refundAt(null))).toEqual(['B11'])
  })
  it('applies to every payee: a hotel that cannot receive blocks the release', () => {
    const l = withPayee(hotel2Ledger({ balance: '562' }), hotel, { depositAuth: true, lines: { RLUSD: { balance: '0', limit: '1000000' } } })
    expect(failing({ stage: 'default.release', proposedTx: release, statements: [hotel2Confirmation(), checkin('checked_in')], ledger: l })).toEqual(['B11'])
  })
  it('a payee the snapshot says nothing about is not assumed blocked', () => {
    expect(failing({ stage: 'default.refund', proposedTx: refund, ledger: hotel2Ledger({ balance: '413', closeTime: '2026-11-01T11:00:01Z' }) })).toEqual([])
  })
})

describe('minorRounded (trust-line values with extra precision)', () => {
  it('floors and ceils beyond the asset decimals, exact values unchanged', async () => {
    const { minorRounded } = await import('../src/facts.ts')
    expect(minorRounded('412.9999999', 6, 'floor')).toBe(412999999n)
    expect(minorRounded('0.0000001', 6, 'ceil')).toBe(1n)
    expect(minorRounded('1e-7', 6, 'ceil')).toBe(1n)
    expect(minorRounded('1000', 6, 'floor')).toBe(1000000000n)
    expect(minorRounded('9999999999999999e80', 6, 'floor') > 0n).toBe(true)
  })
})
