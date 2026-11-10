// Usage: tsx packages/core/src/cli.ts validate-template <file.json> [...]
import fs from 'node:fs'
import { validateTemplate, type Template } from './template.ts'

const [cmd, ...files] = process.argv.slice(2)
if (cmd !== 'validate-template' || files.length === 0) {
  console.error('usage: validate-template <template.json> [...]')
  process.exit(2)
}
let failed = 0
for (const f of files) {
  const t = JSON.parse(fs.readFileSync(f, 'utf8')) as Template
  const r = validateTemplate(t, { preCreateFundingDrops: 6_000_000n })
  console.log(`\n${r.ok ? '✅' : '❌'} ${t.templateId}  (${f})`)
  console.log(`   minimal winning sets: ${r.minimalWinningSets.map((s) => `{${s.join(', ')}}`).join('  ')}`)
  console.log(`   tickets needed: ${r.ticketsNeeded}, reserve: ${Number(r.reserveDrops) / 1e6} XRP`)
  for (const e of r.errors) console.log(`   ERROR ${e.id}: ${e.message}`)
  for (const w of r.warnings) console.log(`   warn  ${w.id}: ${w.message}`)
  for (const d of r.disclosures) console.log(`   disclose ${d.id}: ${d.message}`)
  if (!r.ok) failed++
}
process.exit(failed ? 1 : 0)
