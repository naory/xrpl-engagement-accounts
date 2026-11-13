// The demo's "before booking" panel data: derived by the real dealTerms/checkNorms, kept in sync with the file.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildHotelDisclosure } from '../src/hotel-disclosure.ts'

describe('hotel-disclosure.json', () => {
  it('the standard offer is within norms; the unusual one is flagged on exactly its three unusual terms', () => {
    const d = buildHotelDisclosure()
    expect(d.standard.deviations).toEqual([])
    expect(d.unusual.deviations.map((x) => [x.term, x.severity])).toEqual([
      ['timers.disputeWindowEnds', 'serious'], ['depositBps', 'warn'], ['backupArbiter.appointedBy', 'serious'],
    ])
  })
  it('the committed file matches a fresh build (run npm run web:disclosure)', () => {
    const committed = JSON.parse(fs.readFileSync(new URL('../public/hotel-disclosure.json', import.meta.url), 'utf8'))
    expect(committed).toEqual(buildHotelDisclosure())
  })
})
