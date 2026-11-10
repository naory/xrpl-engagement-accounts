// Usage: tsx packages/policy/src/cli.ts lint   (lints policies/*.json against templates/*.json)
import fs from 'node:fs'
import path from 'node:path'
import type { Template } from '@eng/core'
import { lintPolicy } from './lint.ts'
import { layerHash } from './decide.ts'
import type { PolicyDoc } from './types.ts'

const root = process.cwd()
const templates = fs.readdirSync(path.join(root, 'templates')).map((f) => JSON.parse(fs.readFileSync(path.join(root, 'templates', f), 'utf8')) as Template)
let bad = 0
for (const f of fs.readdirSync(path.join(root, 'policies')).filter((x) => x.endsWith('.json'))) {
  const p = JSON.parse(fs.readFileSync(path.join(root, 'policies', f), 'utf8')) as PolicyDoc
  const t = templates.find((x) => p.appliesTo.includes(x.templateId))
  const findings = lintPolicy(p, t)
  console.log(`${findings.length ? '❌' : '✅'} ${p.policyId}@${p.version}  ${layerHash(p).slice(0, 20)}…  ${t ? `(template ${t.templateId})` : ''}`)
  for (const x of findings) console.log(`   ${x.id} ${x.where}: ${x.message}`)
  if (findings.length) bad++
}
process.exit(bad ? 1 : 0)
