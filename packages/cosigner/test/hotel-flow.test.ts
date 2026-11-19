// HotelFlow's per-deal bookkeeping (offline): Ticket allocation from the stay's nights, the deal's terms, and which
// paths book a multi-night stay. The flow itself runs live (npm run demo:hotel).
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import { localSigner } from '@eng/core'
import { CosignerService, DEMO_HOTEL_TIMERS, FixtureLedgerSource, HOTEL_PATHS, HotelFlow, hotelOpenSequences, hotelPathNights, hotelTerms, hotelTickets, type HotelCast } from '@eng/cosigner'
import { W, hotel2Ledger, policies, templates } from '../../policy/test/fixtures.ts'

const template = JSON.parse(fs.readFileSync(new URL('../../../templates/hotel@2.json', import.meta.url), 'utf8')) as { outcomes: Record<string, { presigned?: boolean; variants?: { perNight?: boolean; max: number } }> }

describe('hotelTickets(nights)', () => {
  it('a one-night stay: refund 4, no-show 5, no-show sweep 6, release 6, chargeback entry 4, chargeback claim 6 — 31, contiguous', () => {
    const t = hotelTickets(1)
    expect(t.count).toBe(31)
    expect(t.slices).toEqual({
      'default.refund': [0, 4], 'default.noshow': [4, 9], 'default.noshowSweep': [9, 15], 'default.release': [15, 21],
      'default.chargebackEntry': [21, 25], 'default.chargebackClaim': [25, 31],
    })
  })

  it('adds 6 Tickets per stay variant #1 … #(nights − 1)', () => {
    const t = hotelTickets(3)
    expect(t.count).toBe(43)
    expect(t.slices['default.chargebackStay#1']).toEqual([31, 37])
    expect(t.slices['default.chargebackStay#2']).toEqual([37, 43])
    expect(t.slices['default.chargebackStay#3']).toBeUndefined()
  })

  it('caps at the template\'s variants.max: 14 nights get 13 variants (109 Tickets); longer stays get none', () => {
    const max = template.outcomes['default.chargebackStay'].variants!.max
    expect(max).toBe(13)
    expect(hotelTickets(14).count).toBe(31 + 6 * 13)
    expect(hotelTickets(15).count).toBe(31)
    expect(Object.keys(hotelTickets(15).slices).some((k) => k.startsWith('default.chargebackStay'))).toBe(false)
  })

  it('covers every pre-signed outcome of hotel@2', () => {
    const presigned = Object.entries(template.outcomes).filter(([, o]) => o.presigned).map(([n]) => n)
    const slots = Object.keys(hotelTickets(2).slices).map((k) => k.split('#')[0])
    expect([...new Set(slots)].sort()).toEqual(presigned.sort())
  })

  it('the open Batch uses 4 Sequences plus the Tickets', () => {
    expect(hotelOpenSequences(1)).toBe(35)
    expect(hotelOpenSequences(3)).toBe(47)
  })
})

describe('deal terms', () => {
  it('nightly = floor(room ÷ nights) in 6-decimal minor units', () => {
    expect(hotelTerms('400', 3)).toEqual({ nights: 3, nightly: '133.333333' })
    expect(hotelTerms('400', 1)).toEqual({ nights: 1, nightly: '400' })
  })

  it('only staySilent books a multi-night (3-night) stay', () => {
    expect(HOTEL_PATHS).toContain('arbiterSilent')
    expect(HOTEL_PATHS).toContain('staySilent')
    expect(Object.fromEntries(HOTEL_PATHS.map((p) => [p, hotelPathNights(p)]))).toMatchObject({ staySilent: 3, arbiterSilent: 1, happy: 1 })
    expect(HOTEL_PATHS.filter((p) => hotelPathNights(p) !== 1)).toEqual(['staySilent'])
  })
})

describe('HotelFlow.open: the neutrality gate runs before any money moves', () => {
  /** A fake XRPL client that records every request; answers only `ledger` (the clock) and stops the flow at anything else. */
  function fakeClient(calls: string[]) {
    return {
      request: async (r: { command: string }) => {
        calls.push(r.command)
        if (r.command === 'ledger') return { result: { ledger_index: 98811234, ledger: { close_time_iso: '2026-11-01T09:00:00Z' } } }
        throw new Error(`stop: ${r.command}`)
      },
    }
  }
  function flowWith(arbiter: InstanceType<typeof xrpl.Wallet>, calls: string[]) {
    const snap = hotel2Ledger({ closeTime: '2026-11-01T09:00:00Z' })
    const svc = new CosignerService({ signer: localSigner(W.cosigner), source: new FixtureLedgerSource(snap), templates: [templates.hotel2], policies: [policies.baseline, policies.hotel2] })
    const register = svc.register.bind(svc)
    svc.register = async (...a: Parameters<CosignerService['register']>) => { calls.push('register'); return register(...a) }
    const cast = { issuer: W.issuer, guest: W.dana, hotel: W.atlas, arbiter, accreditor: W.accreditor, service: W.service, currency: 'RLUSD' } as unknown as HotelCast
    const flow = new HotelFlow({ client: fakeClient(calls) as never, fees: { base: 10, reserveBase: 1_000_000, inc: 200_000 }, svc, cast, timers: DEMO_HOTEL_TIMERS, runId: 't' })
    return { flow, svc }
  }

  it('an unaccredited arbiter: register() refuses NOT_NEUTRAL and open() never reads or submits anything for the open Batch', async () => {
    const calls: string[] = []
    const unaccredited = xrpl.Wallet.generate()
    const { flow, svc } = flowWith(unaccredited, calls)
    const steps = await flow.run('happy', W.engHotel2 as never)
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ step: 'register' })
    expect(steps[0].final).toMatch(/^NOT_NEUTRAL: .*ARBITER_NOT_ACCREDITED/)
    expect(steps[0].tx).toBeUndefined()
    expect(calls).toEqual(['ledger', 'register'])
    expect(svc.engagement(flow.engagementId)).toBeUndefined()
  })

  it('an accredited arbiter: registered first, and only then does open() touch the ledger for the Batch', async () => {
    const calls: string[] = []
    const { flow, svc } = flowWith(W.arbiter as never, calls)
    await expect(flow.open(W.engHotel2 as never, 'happy')).rejects.toThrow(/stop: account_info/)
    expect(calls).toEqual(['ledger', 'register', 'account_info'])
    expect(svc.engagement(flow.engagementId)?.terms).toEqual({ nights: 1, nightly: '400' })
  })
})
