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
    ['backupRuling', 'ruling.backup'],
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

  it('backupRuling: the backup arbiter is refused before the ruling window (U1), then signed', () => {
    const steps = t.paths.backupRuling
    const refused = steps.findIndex((s) => s.stage === 'ruling.backup' && s.decision === 'REFUSE')
    const signed = steps.findIndex((s) => s.stage === 'ruling.backup' && s.decision === 'SIGN')
    expect(refused).toBeGreaterThanOrEqual(0)
    expect(steps[refused].failing).toEqual(['U1'])
    expect(steps[refused].rules!.find((r) => r.id === 'U1')).toMatchObject({ result: 'fail', reason: 'NOT_DUE' })
    expect(signed).toBeGreaterThan(refused)
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
