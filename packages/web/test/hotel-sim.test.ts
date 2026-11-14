// The web demo's simulated "Hotel stay" transcript: every decision comes from a real CosignerService running
// pol_hotel@2.0.0 over a fixture ledger the generator advances step by step.
import fs from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { HOTEL_PATHS, type HotelPath } from '@eng/cosigner'
import { parseAmount } from '@eng/core'
import { buildHotelTranscript, type HotelSimStep, type HotelTranscript } from '../src/hotel-sim.ts'

let t: HotelTranscript
beforeAll(async () => { t = await buildHotelTranscript() })

/** The step for `stage` with `decision` (tick() results keep the co-signer's order, so it need not be the last). */
const outcome = (p: HotelPath, stage: string, decision = 'SIGN'): HotelSimStep => {
  const s = t.paths[p].find((x) => x.stage === stage && x.decision === decision)
  if (!s) throw new Error(`${p}: no ${stage} ${decision} step`)
  return s
}
const minor = (v: string) => parseAmount(v, { code: 'RLUSD', kind: 'IOU', currency: 'RLUSD', issuer: '', decimals: 6 }).minor

describe('hotel stay simulated transcript', () => {
  it('covers every path', () => {
    expect(Object.keys(t.paths).sort()).toEqual([...HOTEL_PATHS].sort())
  })

  it.each([
    ['happy', 'settle'],
    ['unconfirmed', 'default.refund'],
    ['noshow', 'default.noshow'],
    ['entryConceded', 'refund.conceded'],
    ['silence', 'default.release'],
    ['claimUnanswered', 'ruling.default'],
    ['partialDeposit', 'default.noshow'],
  ] as Array<[HotelPath, string]>)('%s closes with %s SIGN', (path, stage) => {
    const s = outcome(path, stage)
    expect(s).toMatchObject({ stage, decision: 'SIGN', failing: [], final: 'tesSUCCESS' })
    expect(s.rules!.length).toBeGreaterThan(0)
    expect(s.rules!.every((r) => r.result === 'pass' || r.result === 'n/a')).toBe(true)
    expect(s.payouts!.length).toBeGreaterThan(0)
  })

  it('entryRuled ends with the arbiter ruling: no co-signer decision, payouts set', () => {
    const s = t.paths.entryRuled.find((x) => x.step === 'ruling:arbiter')!
    expect(s.stage).toBeUndefined()
    expect(s.decision).toBeUndefined()
    expect(s).toMatchObject({ final: 'tesSUCCESS' })
    expect(s.payouts!.length).toBeGreaterThan(0)
    // the open no-show default is refused while the entry dispute is open (H13)
    expect(t.paths.entryRuled.find((x) => x.stage === 'default.noshow')).toMatchObject({ decision: 'REFUSE', failing: expect.arrayContaining(['N4']) })
  })

  it('unconfirmed: tick order is kept, the refund SIGN comes before the no-show refusal it put in flight (B9)', () => {
    const steps = t.paths.unconfirmed
    const refund = steps.indexOf(outcome('unconfirmed', 'default.refund'))
    const noshow = steps.indexOf(outcome('unconfirmed', 'default.noshow', 'REFUSE'))
    expect(refund).toBeLessThan(noshow)
    expect(steps[noshow].failing).toContain('B9')
  })

  it('claimUnanswered: the release default is refused while the claim stands (L5)', () => {
    expect(t.paths.claimUnanswered.find((s) => s.stage === 'default.release')).toMatchObject({ decision: 'REFUSE', failing: ['L5'] })
  })

  it('happy: a guest + hotel close without the co-signer is below quorum', () => {
    expect(t.paths.happy.find((s) => s.step === 'probe:principal+counterparty')).toMatchObject({ final: 'tefBAD_QUORUM' })
  })

  it('partialDeposit: refused check-in ends as a no-show; the sweep variant returns the partial deposit, the exact one is refused (N8)', () => {
    const steps = t.paths.partialDeposit
    const exact = steps.find((s) => s.step === 'tick default.noshow')!
    expect(exact).toMatchObject({ decision: 'REFUSE' })
    expect(exact.failing).toContain('N8')
    const sweep = steps.find((s) => s.step === 'tick default.noshowSweep')!
    expect(sweep).toMatchObject({ stage: 'default.noshow', decision: 'SIGN', failing: [], final: 'tesSUCCESS' })
    const pay = Object.fromEntries(sweep.payouts!.map((p) => [p.to, minor(p.value)]))
    expect(pay[t.cast.guest]).toBe(minor(t.booking.partialDeposit))
    expect(pay[t.cast.hotel] + pay[t.cast.service]).toBe(minor(t.booking.room))
  })

  it('noshow: the exact variant pays the hotel; the sweep variant is refused because it would deliver nothing (B11)', () => {
    expect(t.paths.noshow.find((s) => s.step === 'tick default.noshow')).toMatchObject({ decision: 'SIGN', final: 'tesSUCCESS' })
    expect(t.paths.noshow.find((s) => s.step === 'tick default.noshowSweep')!.failing).toContain('B11')
  })

  it('silence: the release sweep returns exactly the deposit', () => {
    const s = outcome('silence', 'default.release')
    expect(minor(s.payouts!.find((p) => p.to === t.cast.guest)!.value)).toBe(minor(t.booking.deposit))
  })

  it('every hotel payout carries exactly the 50 bps fee (minor units)', () => {
    let checked = 0
    for (const p of HOTEL_PATHS) for (const s of t.paths[p]) {
      const hotel = s.payouts?.find((x) => x.to === t.cast.hotel)
      if (!hotel) continue
      const fee = minor(s.payouts!.find((x) => x.to === t.cast.service)!.value)
      expect(fee).toBe(((minor(hotel.value) + fee) * 50n) / 10000n)
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('the committed public/hotel-sim.json is exactly a fresh build', async () => {
    const committed = JSON.parse(fs.readFileSync(new URL('../public/hotel-sim.json', import.meta.url), 'utf8'))
    expect(committed).toEqual(JSON.parse(JSON.stringify(await buildHotelTranscript())))
  })
})
