// The web demo's simulated "Hotel stay" transcript: every decision comes from a real CosignerService running
// pol_hotel@2.0.0 over a fixture ledger the generator advances step by step.
import fs from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { HOTEL_PATHS, type HotelPath } from '@eng/cosigner'
import { buildHotelTranscript, type HotelTranscript } from '../src/hotel-sim.ts'

let t: HotelTranscript
beforeAll(async () => { t = await buildHotelTranscript() })

const last = (p: HotelPath) => t.paths[p].at(-1)!

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
  ] as Array<[HotelPath, string]>)('%s ends with %s SIGN and closes the account', (path, stage) => {
    const s = last(path)
    expect(s).toMatchObject({ stage, decision: 'SIGN', failing: [], final: 'tesSUCCESS' })
    expect(s.rules!.length).toBeGreaterThan(0)
    expect(s.rules!.every((r) => r.result === 'pass' || r.result === 'n/a')).toBe(true)
    expect(s.payouts!.length).toBeGreaterThan(0)
  })

  it('entryRuled ends with the arbiter ruling: no co-signer decision, payouts set', () => {
    const s = last('entryRuled')
    expect(s.step).toBe('ruling:arbiter')
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

  it('claimUnanswered: the release default is refused while the claim stands (L5)', () => {
    expect(t.paths.claimUnanswered.find((s) => s.stage === 'default.release')).toMatchObject({ decision: 'REFUSE', failing: ['L5'] })
  })

  it('happy: a guest + hotel close without the co-signer is below quorum', () => {
    expect(t.paths.happy.find((s) => s.step === 'probe:principal+counterparty')).toMatchObject({ final: 'tefBAD_QUORUM' })
  })

  it('every hotel payout carries the 50 bps fee', () => {
    const fee = t.cast.service
    for (const p of HOTEL_PATHS) for (const s of t.paths[p]) {
      if (!s.payouts?.some((x) => x.to === t.cast.hotel)) continue
      const hotel = Number(s.payouts.find((x) => x.to === t.cast.hotel)!.value)
      const toFee = Number(s.payouts.find((x) => x.to === fee)!.value)
      expect(toFee).toBeCloseTo(((hotel + toFee) * 50) / 10000, 6)
    }
  })

  it('the clock only moves forward within a path', () => {
    for (const p of HOTEL_PATHS) {
      const at = t.paths[p].map((s) => Date.parse(s.at))
      expect(at).toEqual([...at].sort((a, b) => a - b))
    }
  })

  it('the committed public/hotel-sim.json is exactly a fresh build', async () => {
    const committed = JSON.parse(fs.readFileSync(new URL('../public/hotel-sim.json', import.meta.url), 'utf8'))
    expect(committed).toEqual(JSON.parse(JSON.stringify(await buildHotelTranscript())))
  })
})
