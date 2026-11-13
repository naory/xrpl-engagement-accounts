// Regenerates packages/web/public/policy-text.json, the policies' own check labels for the demo (npm run web:policy-text).
import fs from 'node:fs'
import { buildPolicyText } from '../src/policy-text.ts'

const out = new URL('../public/policy-text.json', import.meta.url)
const t = buildPolicyText()
fs.writeFileSync(out, JSON.stringify(t, null, 2) + '\n')
console.log(`wrote ${out.pathname} (${Object.keys(t.rules).length} rules from ${t.policies.join(', ')})`)
