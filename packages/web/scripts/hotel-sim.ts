// Regenerates packages/web/public/hotel-sim.json, the simulated "Hotel stay" transcript (npm run web:hotel-sim).
import fs from 'node:fs'
import { buildHotelTranscript } from '../src/hotel-sim.ts'
import { describeStep, HOTEL_PATHS } from '@eng/cosigner'

const out = new URL('../public/hotel-sim.json', import.meta.url)
const t = await buildHotelTranscript()
fs.writeFileSync(out, JSON.stringify(t, null, 2) + '\n')
// The close that applied (payouts set); not necessarily the last step, since tick() results keep the co-signer's order.
for (const p of HOTEL_PATHS) console.log(`${p}: ${describeStep(t.paths[p].find((s) => s.payouts?.length)!)}`)
console.log(`wrote ${out.pathname}`)
