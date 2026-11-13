// Regenerates packages/web/public/hotel-disclosure.json, the demo's "before booking" check (npm run web:disclosure).
import fs from 'node:fs'
import { buildHotelDisclosure } from '../src/hotel-disclosure.ts'

const out = new URL('../public/hotel-disclosure.json', import.meta.url)
const d = buildHotelDisclosure()
fs.writeFileSync(out, JSON.stringify(d, null, 2) + '\n')
for (const k of ['standard', 'unusual'] as const) console.log(`${d[k].label}: ${d[k].deviations.length ? d[k].deviations.map((x) => `${x.severity} ${x.title}`).join('; ') : 'within norms'}`)
console.log(`wrote ${out.pathname}`)
