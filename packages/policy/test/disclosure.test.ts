// Pre-booking disclosure: the deal's terms derived from template + policy + offer, checked against a
// published norms profile. Only deviations come back; a normal deal yields none.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Template } from '@eng/core'
import { checkNorms, dealTerms, type HotelOffer, type NormsProfile, type PolicyDoc } from '@eng/policy'

const root = path.resolve(import.meta.dirname, '../../..')
const read = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')) as T
const template = read<Template>('templates/hotel@2.json')
const policy = read<PolicyDoc>('policies/hotel@2.0.0.json')
const norms = read<NormsProfile>('norms/hotel@1.json')

const standard: HotelOffer = {
  room: '400.00', deposit: '100.00',
  arbiter: { account: 'rArbiter', accredited: true, appointedBy: 'service' },
  backupArbiter: { account: 'rBackup', accredited: true, appointedBy: 'service' },
}

describe('deal terms', () => {
  it('derives money, deadlines, who can move money, and silence outcomes from template + policy + offer', () => {
    const t = dealTerms({ template, policy, offer: standard })
    expect(t.money).toEqual({ asset: 'RLUSD', room: '400.00', deposit: '100.00', bond: '10.00', feeBps: 50 })
    expect(t.deadlines.find((d) => d.timer === 'disputeWindowEnds')).toMatchObject({ seconds: 259200, from: 'deliveryBy', onExpire: 'default.release' })
    expect(t.deadlines.every((d) => d.description)).toBe(true)
    // arbiter + hotel can pay without the guest; guest + hotel can't act alone
    expect(t.whoCanMoveMoney.some((s) => s.roles.join() === 'counterparty,arbiter' && !s.includesGuest)).toBe(true)
    expect(t.whoCanMoveMoney.some((s) => s.roles.join() === 'principal,counterparty')).toBe(false)
    expect(t.facts['merchantWithoutGuestOrNeutral']).toBe(false)
    expect(t.silence.map((s) => s.outcome)).toEqual(['default.refund', 'default.noshow', 'default.release'])
  })
  it('lets the offer override a deadline (e.g. a hotel offering a shorter dispute window)', () => {
    const t = dealTerms({ template, policy, offer: { ...standard, timers: { disputeWindowEnds: 7200 } } })
    expect(t.facts['timers.disputeWindowEnds']).toBe(7200)
  })
})

describe('norms check', () => {
  it('a standard hotel deal has no deviations', () => {
    expect(checkNorms(dealTerms({ template, policy, offer: standard }), norms)).toEqual([])
  })
  it('flags an unusual offer with the norm, actual value, why it matters, and a severity hint', () => {
    const unusual: HotelOffer = {
      ...standard, deposit: '300.00', timers: { disputeWindowEnds: 7200 },
      backupArbiter: { account: 'rBackup', accredited: true, appointedBy: 'counterparty' },
    }
    const dev = checkNorms(dealTerms({ template, policy, offer: unusual }), norms)
    const byTerm = Object.fromEntries(dev.map((d) => [d.term, d]))
    expect(Object.keys(byTerm).sort()).toEqual(['backupArbiter.appointedBy', 'depositBps', 'timers.disputeWindowEnds'])
    expect(byTerm['timers.disputeWindowEnds']).toMatchObject({ severity: 'serious', actual: 7200 })
    expect(byTerm['backupArbiter.appointedBy']).toMatchObject({ severity: 'serious', actual: 'counterparty' })
    expect(byTerm['depositBps'].severity).toBe('warn')
    for (const d of dev) { expect(d.title).toBeTruthy(); expect(d.why).toBeTruthy(); expect(d.expected).toBeTruthy() }
  })
  it('flags an unaccredited arbiter as serious', () => {
    const dev = checkNorms(dealTerms({ template, policy, offer: { ...standard, arbiter: { account: 'rX', accredited: false, appointedBy: 'counterparty' } } }), norms)
    expect(dev.map((d) => [d.term, d.severity])).toEqual([['arbiter.accredited', 'serious']])
  })
})
