// Usage: tsx --conditions=source packages/core/src/cli.ts validate-template <file.json> [...]
import fs from 'node:fs'
import path from 'node:path'
import { validateTemplate, type Template } from './template.ts'

/** Params of the policy named by template.policyRef (`policyId@version`), if that file is in policies/. */
function policyParamsFor(templateFile: string, t: Template): Record<string, unknown> | undefined {
  if (!t.policyRef) return undefined
  const dir = path.resolve(path.dirname(templateFile), '..', 'policies')
  if (!fs.existsSync(dir)) return undefined
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const doc = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as { policyId?: string; version?: string; params?: Record<string, unknown> }
    if (`${doc.policyId}@${doc.version}` === t.policyRef) return doc.params
  }
  return undefined
}

const [cmd, ...files] = process.argv.slice(2)
if (cmd !== 'validate-template' || files.length === 0) {
  console.error('usage: validate-template <template.json> [...]')
  process.exit(2)
}
let failed = 0
for (const f of files) {
  const t = JSON.parse(fs.readFileSync(f, 'utf8')) as Template
  // 25 XRP covers hotel@2 at its 14-night cap (109 Tickets: 23.2 XRP reserve + fee headroom); all of it returns at close.
  const r = validateTemplate(t, { preCreateFundingDrops: 25_000_000n, policyParams: policyParamsFor(f, t) })
  console.log(`\n${r.ok ? '✅' : '❌'} ${t.templateId}  (${f})`)
  console.log(`   minimal winning sets: ${r.minimalWinningSets.map((s) => `{${s.join(', ')}}`).join('  ')}`)
  console.log(`   tickets needed: ${r.ticketsNeeded}, reserve: ${Number(r.reserveDrops) / 1e6} XRP`)
  for (const e of r.errors) console.log(`   ERROR ${e.id}: ${e.message}`)
  for (const w of r.warnings) console.log(`   warn  ${w.id}: ${w.message}`)
  for (const d of r.disclosures) console.log(`   disclose ${d.id}: ${d.message}`)
  if (!r.ok) failed++
}
process.exit(failed ? 1 : 0)
