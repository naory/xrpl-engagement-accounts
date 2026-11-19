// Hotel fix-round-4 sweep (R20, R21): phase × timing × action.
// Out of the default suite. `npm test` excludes this file; `npm run test:sweep` runs it,
// and the nightly workflow runs that script.
import { describe, expect, it } from 'vitest'
import { localSigner, type Statement } from '@eng/core'
import { CosignerService, FixtureLedgerSource, combine, type TickResult } from '@eng/cosigner'
import {
  W, checkin, claim, dispute, guestCheckin, hotel2Close, hotel2Confirmation, hotel2Engagement, hotel2Ledger, hotel2Mandate, memo, policies, ruling, statement, templates,
} from '../../policy/test/fixtures.ts'

const ENG = 'eng_hotel2_fixture'

async function setup(closeTime: string) {
  const source = new FixtureLedgerSource(hotel2Ledger({ closeTime }))
  const svc = new CosignerService({ signer: localSigner(W.cosigner), source, templates: [templates.hotel2], policies: [policies.baseline, policies.hotel2] })
  await svc.register(hotel2Engagement(), hotel2Mandate())
  return { svc, source }
}

/** setup(), with the hotel's confirmation receipted before confirmBy; then the clock moves to `closeTime` (balance optional). */
async function confirmedSetup(closeTime: string, balance?: string) {
  const { svc, source } = await setup('2026-11-01T09:31:00Z')
  const conf = hotel2Confirmation()
  await svc.ingest(ENG, conf)
  source.snap = hotel2Ledger({ closeTime, ...(balance ? { balance } : {}) })
  return { svc, source, conf }
}

/** A hotel claim issued at `issuedAt` (the fixture's `claim()` has a fixed posting time). */
function claimAt(issuedAt: string, items: Array<{ amount: string }>, total: string): Statement {
  return statement(W.atlas, {
    kind: 'COUNTERPARTY', type: 'party.claim/1', engagementId: ENG, subject: { bookingId: 'ATL-60417' },
    claim: { items: items.map((i) => ({ kind: 'minibar', amount: { currency: 'RLUSD', value: i.amount }, evidenceHashes: [] })), total: { currency: 'RLUSD', value: total } },
    observedAt: issuedAt, issuedAt,
  })
}

type Json = Record<string, unknown>
const presign = (tx: Json, wallets = [W.dana, W.atlas]) => combine(wallets.map((w) => w.sign(structuredClone(tx) as never, true).tx_blob))

describe('co-signer: fix round 4 (R20, R21) — no action flips which default fires', () => {
  const sweep = { to: W.dana.address, value: '0', partial: true }
  const room = [{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }]
  const blob = (payouts: Array<{ to: string; value: string; partial?: boolean }>, basis: string) => presign(hotel2Close(payouts, { tickets: true, memos: [memo('eng/basis', basis)] }))
  const arb = (t: string) => ruling(W.arbiter, [{ to: W.atlas.address, value: '470.00' }], t)
  /** Stay variant #k of the 3-night fixture deal: k × nightly 137.333333 to the hotel (less the 50 bps fee), the rest swept to the guest. */
  const night = (k: bigint) => {
    const gross = k * 137333333n
    const f = (gross * 50n) / 10000n
    const fmt = (m: bigint) => `${m / 1000000n}.${(m % 1000000n).toString().padStart(6, '0')}`
    return blob([{ to: W.atlas.address, value: fmt(gross - f) }, { to: W.service.address, value: fmt(f) }, sweep], 'default.chargebackStay')
  }
  /** Every automatic ending of the deal, pre-signed and stored, so a tick shows which of them (if any) fires. */
  async function storeAll(svc: CosignerService) {
    await svc.storePresigned(ENG, 'default.chargebackEntry', blob([sweep], 'default.chargebackEntry'))
    await svc.storePresigned(ENG, 'default.chargebackClaim', blob([...room, sweep], 'default.chargebackClaim'))
    await svc.storePresigned(ENG, 'default.chargebackStay#1', night(1n))
    await svc.storePresigned(ENG, 'default.chargebackStay#2', night(2n))
    await svc.storePresigned(ENG, 'default.release', blob([...room, sweep], 'default.release'))
    await svc.storePresigned(ENG, 'default.noshow', blob(room, 'default.noshow'))
    await svc.storePresigned(ENG, 'default.noshowSweep', blob([...room, sweep], 'default.noshowSweep'))
  }
  const signed = (rs: TickResult[]) => rs.filter((r) => r.decision === 'SIGN').map((r) => r.outcome)
  const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z')
  const plus = (t: string, secs: number) => iso(Date.parse(t) + secs * 1000)
  const add = (a: string, b: string) => {
    const m = (v: string) => { const [i, d = ''] = v.split('.'); return BigInt(i) * 1000000n + BigInt(d.padEnd(6, '0')) }
    const s = m(a) + m(b)
    return `${s / 1000000n}.${(s % 1000000n).toString().padStart(6, '0')}`
  }

  // Sweep: phase × timing × action. Each case files one bonded dispute, optionally adds a hotel claim (after checkout) or
  // an arbiter ruling (before the deadline), then anyone tops up the account by `topUp`. Every tick before the ruling
  // deadline must sign nothing; 1 s after it exactly the phase's chargeback signs (or, after a receipted ruling, nothing
  // ever does: the arbiter and the winning party close).
  type Scenario = { name: string; checkedIn: boolean; checkinPosted: boolean; hotelPaysDeposit?: boolean; phase: 'entry' | 'stay' | 'settlement'; issued: string; balance: string; deadline: string; expect: string }
  const scenarios: Scenario[] = [
    { name: 'entry, no check-in recorded', checkedIn: false, checkinPosted: false, phase: 'entry', issued: '2026-11-11T15:29:30Z', balance: '422', deadline: '2026-11-16T15:29:30Z', expect: 'default.chargebackEntry' },
    { name: 'entry, checked_in posted but no deposit', checkedIn: false, checkinPosted: true, phase: 'entry', issued: '2026-11-11T15:29:30Z', balance: '422', deadline: '2026-11-16T15:29:30Z', expect: 'default.chargebackEntry' },
    { name: 'entry, hotel posted checked_in and paid the deposit itself, no guest acknowledgement (R23)', checkedIn: false, checkinPosted: true, hotelPaysDeposit: true, phase: 'entry', issued: '2026-11-11T15:29:30Z', balance: '572', deadline: '2026-11-16T15:29:30Z', expect: 'default.chargebackEntry' },
    { name: 'stay, night 1', checkedIn: true, checkinPosted: true, phase: 'stay', issued: '2026-11-12T10:00:00Z', balance: '572', deadline: '2026-11-17T10:00:00Z', expect: 'default.chargebackStay#1' },
    { name: 'stay, night 2', checkedIn: true, checkinPosted: true, phase: 'stay', issued: '2026-11-12T15:00:00Z', balance: '572', deadline: '2026-11-17T15:00:00Z', expect: 'default.chargebackStay#2' },
    { name: 'stay, last night', checkedIn: true, checkinPosted: true, phase: 'stay', issued: '2026-11-14T10:00:00Z', balance: '572', deadline: '2026-11-19T10:00:00Z', expect: 'default.chargebackClaim' },
    { name: 'settlement, after checkout', checkedIn: true, checkinPosted: true, phase: 'settlement', issued: '2026-11-16T10:00:00Z', balance: '572', deadline: '2026-11-21T10:00:00Z', expect: 'default.chargebackClaim' },
  ]
  const TOP_UPS = ['0', '0.000001', '9.999999', '139.999999', '140', '150', '1000']
  // after entryDisputeBy / checkInBy, after checkout, after claimBy, after disputeWindowEnds, after the unanswered-claim lapse
  const CHECKPOINTS = ['2026-11-12T11:00:01Z', '2026-11-14T11:00:01Z', '2026-11-15T11:00:01Z', '2026-11-17T11:00:01Z', '2026-11-22T11:00:01Z']

  async function filed(sc: Scenario, action: 'none' | 'claim' | 'ruling') {
    const { svc, source } = await confirmedSetup('2026-11-11T15:01:00Z')
    if (sc.checkinPosted) await svc.ingest(ENG, checkin('checked_in'))
    if (sc.checkedIn) await svc.ingest(ENG, guestCheckin())
    if (sc.hotelPaysDeposit) source.snap = hotel2Ledger({ balance: '562', closeTime: '2026-11-11T15:10:00Z' })
    const received = plus(sc.issued, 30)
    const claimFirst = action === 'claim' && sc.phase === 'settlement'
    if (claimFirst) {
      source.snap = hotel2Ledger({ balance: sc.balance, closeTime: '2026-11-14T15:01:00Z' })
      await svc.ingest(ENG, claim([{ kind: 'minibar', amount: '58.00' }]))
    }
    source.snap = hotel2Ledger({ balance: sc.balance, dispute: true, closeTime: received })
    await svc.ingest(ENG, dispute(sc.phase, sc.issued))
    if (action === 'claim' && !claimFirst) {
      source.snap = hotel2Ledger({ balance: sc.balance, dispute: true, closeTime: '2026-11-14T15:01:00Z' })
      await svc.ingest(ENG, claim([{ kind: 'minibar', amount: '58.00' }]))
    }
    if (action === 'ruling') {
      source.snap = hotel2Ledger({ balance: sc.balance, dispute: true, closeTime: plus(sc.issued, 86400 + 30) })
      await svc.ingest(ENG, arb(plus(sc.issued, 86400)))
    }
    await storeAll(svc)
    return { svc, source }
  }

  for (const sc of scenarios) {
    it(`sweep — ${sc.name}: top-ups ${TOP_UPS.join('/')} (± a hotel claim) never move or block the ${sc.expect} default`, async () => {
      for (const action of ['none', 'claim'] as const) {
        for (const topUp of TOP_UPS) {
          const { svc, source } = await filed(sc, action)
          const balance = add(sc.balance, topUp)
          const label = `${action} +${topUp}`
          for (const t of [...CHECKPOINTS.filter((c) => c > plus(sc.issued, 30) && c < sc.deadline), sc.deadline]) {
            source.snap = hotel2Ledger({ balance, dispute: true, closeTime: t })
            expect(signed(await svc.tick(ENG)), `${label} at ${t}`).toEqual([])
          }
          source.snap = hotel2Ledger({ balance, dispute: true, closeTime: plus(sc.deadline, 1) })
          expect(signed(await svc.tick(ENG)), `${label} after the deadline`).toEqual([sc.expect])
        }
      }
    }, 120_000)

    it(`sweep — ${sc.name}: a ruling receipted before the deadline blocks every default for good, whatever is paid in`, async () => {
      for (const topUp of ['0', '150', '1000']) {
        const { svc, source } = await filed(sc, 'ruling')
        const balance = add(sc.balance, topUp)
        for (const t of [...CHECKPOINTS.filter((c) => c > plus(sc.issued, 86400 + 30)), plus(sc.deadline, 1), '2027-03-01T00:00:00Z']) {
          source.snap = hotel2Ledger({ balance, dispute: true, closeTime: t })
          expect(signed(await svc.tick(ENG)), `+${topUp} at ${t}`).toEqual([])
        }
      }
    }, 60_000)
  }

  it('sweep — second statements: a second dispute (any phase) is ALREADY_DISPUTED, a second claim ALREADY_CLAIMED, and the original default still fires', async () => {
    const { svc, source } = await filed(scenarios.find((x) => x.name === 'stay, night 1')!, 'claim') // stay night 1 + a post-checkout claim
    source.snap = hotel2Ledger({ balance: '572', dispute: true, closeTime: '2026-11-14T10:00:30Z' })
    await expect(svc.ingest(ENG, dispute('stay', '2026-11-14T10:00:00Z'))).rejects.toThrow(/ALREADY_DISPUTED/)
    source.snap.closeTime = '2026-11-15T10:00:30Z'
    await expect(svc.ingest(ENG, claimAt('2026-11-15T10:00:00Z', [{ amount: '20.00' }], '20.00'))).rejects.toThrow(/ALREADY_CLAIMED/)
    source.snap.closeTime = '2026-11-16T10:00:30Z'
    await expect(svc.ingest(ENG, dispute('settlement', '2026-11-16T10:00:00Z'))).rejects.toThrow(/ALREADY_DISPUTED/)
    source.snap = hotel2Ledger({ balance: '572', dispute: true, closeTime: '2026-11-17T10:00:01Z' })
    expect(signed(await svc.tick(ENG))).toEqual(['default.chargebackStay#1'])
  })
})
