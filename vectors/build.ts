// Builds the conformance vectors from vectors/cases.ts with the reference implementation.
//   npm run vectors:build      (rewrites vectors/*.json; review the git diff)
// Each case declares its expected failing rules; the build aborts if the implementation disagrees,
// so a vector can never silently encode a bug.
import fs from 'node:fs'
import xrpl from 'xrpl'
import { canonicalize, signStatement, statementDigest, validateTemplate, verifyStatement, type Statement, type Template } from '@eng/core'
import { decide, layerHash, type DecideInput, type Decision, type PolicyDoc } from '@eng/policy'
import { policyCases, statementCases, templateCases } from './cases.ts'

/** Pretty JSON that keeps short objects/arrays on one line (smaller files, readable diffs). */
export function stringify(v: unknown, indent = ''): string {
  const flat = JSON.stringify(v)
  if (flat === undefined) return 'null'
  if (v === null || typeof v !== 'object' || flat.length + indent.length <= 110) return flat
  const next = indent + '  '
  if (Array.isArray(v)) return `[\n${v.map((x) => next + stringify(x, next)).join(',\n')}\n${indent}]`
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
  return `{\n${entries.map(([k, x]) => `${next}${JSON.stringify(k)}: ${stringify(x, next)}`).join(',\n')}\n${indent}}`
}

const out = (name: string, data: unknown) => {
  fs.writeFileSync(new URL(name, import.meta.url), stringify(data) + '\n')
  console.log(`wrote vectors/${name}`)
}

export function expectedOf(d: Decision) {
  return {
    decision: d.decision,
    failing: d.failing,
    results: d.results.map((r) => ({ layer: r.layer, id: r.id, result: r.result, ...(r.result !== 'pass' && r.result !== 'n/a' && r.reason ? { reason: r.reason } : {}) })),
    statementsUsed: d.statementsUsed,
    statementsRejected: d.statementsRejected,
    inputsHash: d.inputsHash,
    effectiveHash: d.policy.effectiveHash,
  }
}

export function serializeInput(i: DecideInput) {
  const { template, layers, ...rest } = i
  return { ...rest, template: template.templateId, layers: layers.map(layerHash) }
}

export function deserializeInput(v: ReturnType<typeof serializeInput>, ctx: { templates: Record<string, Template>; layers: Record<string, PolicyDoc> }): DecideInput {
  return { ...(v as unknown as DecideInput), template: ctx.templates[v.template], layers: v.layers.map((h) => ctx.layers[h]) }
}

function buildPolicy() {
  const templates: Record<string, Template> = {}
  const layers: Record<string, PolicyDoc> = {}
  const cases = policyCases().map((c) => {
    templates[c.input.template.templateId] = c.input.template
    for (const l of c.input.layers) layers[layerHash(l)] = l
    const d = decide(c.input)
    if (JSON.stringify(d.failing) !== JSON.stringify(c.expectFailing)) {
      throw new Error(`${c.name}: expected failing ${JSON.stringify(c.expectFailing)}, got ${JSON.stringify(d.failing)}\n${JSON.stringify(d.results.filter((r) => r.result !== 'pass'), null, 1)}`)
    }
    return { name: c.name, description: c.description, input: serializeInput(c.input), expect: expectedOf(d) }
  })
  out('policy.json', {
    format: 'eng-vectors/policy@1',
    language: 'cel-eng/1',
    note: 'Inputs reference context.templates by templateId and context.layers by layer hash. Compare decision, failing, results (layer, id, result, reason), statementsUsed, statementsRejected, inputsHash and effectiveHash. Cost units and messages are implementation-defined.',
    context: { templates, layers },
    cases,
  })
  return cases.length
}

function buildTemplates() {
  const cases = templateCases().map((c) => {
    const r = validateTemplate(c.template, c.options?.preCreateFundingDrops ? { preCreateFundingDrops: BigInt(c.options.preCreateFundingDrops) } : {})
    const errs = [...new Set(r.errors.map((e) => e.id))].sort()
    if (JSON.stringify(errs) !== JSON.stringify([...c.expectErrors].sort())) throw new Error(`${c.name}: expected errors ${c.expectErrors}, got ${errs}`)
    return {
      name: c.name, description: c.description, template: c.template, options: c.options ?? {},
      expect: { ok: r.ok, errors: errs, warnings: [...new Set(r.warnings.map((w) => w.id))].sort(), disclosures: r.disclosures.map((x) => x.id), minimalWinningSets: r.minimalWinningSets, ticketsNeeded: r.ticketsNeeded, reserveDrops: r.reserveDrops.toString() },
    }
  })
  out('templates.json', { format: 'eng-vectors/templates@1', cases })
  return cases.length
}

function buildStatements() {
  const cases: unknown[] = []
  for (const c of statementCases()) {
    const w = xrpl.Wallet.fromSeed(c.seed, { algorithm: c.algorithm as never })
    const s = signStatement(c.body, w)
    const v = verifyStatement(s)
    if (!v.ok || v.signerAddress !== w.address) throw new Error(`${c.name}: does not verify`)
    cases.push({ name: c.name, valid: true, keyDerivation: c.derivation, jcs: canonicalize(c.body), digest: statementDigest(c.body).toString('hex').toUpperCase(), statement: s, expect: { ok: true, signerAddress: w.address } })
    const tampered: Statement = { ...s, claim: { ...s.claim, approverRole: 'cfo' } }
    cases.push({ name: `${c.name}.tampered-claim`, valid: false, statement: tampered, expect: verifyStatement(tampered) })
    const other = xrpl.Wallet.fromEntropy(Buffer.alloc(16, 9), { algorithm: c.algorithm as never })
    const forged: Statement = { ...s, proof: { ...s.proof, publicKey: other.publicKey } }
    cases.push({ name: `${c.name}.wrong-key`, valid: false, statement: forged, expect: verifyStatement(forged) })
  }
  out('statements.json', { format: 'eng-vectors/statements@1', prefix: 'ENGA\\0', note: 'digest = SHA-512Half("ENGA\\0" || JCS(body)); id = "att:" + digest; signature = XRPL key over digest', cases })
  return cases.length
}

if (process.argv[1]?.endsWith('build.ts')) {
  const n = [buildPolicy(), buildTemplates(), buildStatements()]
  console.log(`policy ${n[0]}, templates ${n[1]}, statements ${n[2]} vectors`)
}
