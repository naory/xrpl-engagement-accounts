// The "before booking" check shown in the Hotel stay demo: the deal's terms derived from the hotel@2 template,
// pol_hotel@2.0.0 and an offer, compared with norms/hotel@1. Two offers — a standard one and an unusual one —
// published as public/hotel-disclosure.json (npm run web:disclosure; a test keeps it in sync).
// Uses the product deadlines from the template, not the demo's compressed seconds-apart timers.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Template } from '@eng/core'
import { DEMO_HOTEL_BOOKING } from '@eng/cosigner'
import { checkNorms, dealTerms, type DealTerms, type Deviation, type HotelOffer, type NormsProfile, type PolicyDoc } from '@eng/policy'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')) as T
const fixed = (v: string): string => Number(v).toFixed(2)

export const STANDARD_OFFER: HotelOffer = {
  room: fixed(DEMO_HOTEL_BOOKING.room), deposit: fixed(DEMO_HOTEL_BOOKING.deposit),
  arbiter: { account: 'Fairwind Arbitration', accredited: true, appointedBy: 'counterparty' },
  backupArbiter: { account: 'Northgate Dispute Services', accredited: true, appointedBy: 'service' },
}
/** Same booking, with three terms a guest's agent should notice. */
export const UNUSUAL_OFFER: HotelOffer = {
  ...STANDARD_OFFER, deposit: '300.00', timers: { disputeWindowEnds: 7200 },
  backupArbiter: { account: 'Hotel Partners Mediation', accredited: true, appointedBy: 'counterparty' },
}

export interface OfferCheck { label: string; offer: HotelOffer; terms: DealTerms; deviations: Deviation[] }
export interface HotelDisclosure { generatedBy: string; norms: string; standard: OfferCheck; unusual: OfferCheck }

export function buildHotelDisclosure(): HotelDisclosure {
  const template = read<Template>('templates/hotel@2.json')
  const policy = read<PolicyDoc>('policies/hotel@2.0.0.json')
  const norms = read<NormsProfile>('norms/hotel@1.json')
  const check = (label: string, offer: HotelOffer): OfferCheck => {
    const terms = dealTerms({ template, policy, offer })
    return { label, offer, terms, deviations: checkNorms(terms, norms) }
  }
  return {
    generatedBy: 'npm run web:disclosure (packages/web/src/hotel-disclosure.ts)',
    norms: norms.normsId,
    standard: check('Standard offer', STANDARD_OFFER),
    unusual: check('Unusual offer', UNUSUAL_OFFER),
  }
}
