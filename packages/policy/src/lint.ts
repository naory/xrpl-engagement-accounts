// Policy lint (docs/spec/policy.md §11): L1 parse/type/float ban, L2 stage coverage, L3 statement
// types in the registry, L5 enforcement vs template, L7 unique rule ids. (L4 static cost bound and
// L6 layer monotonicity are follow-ups.)
import type { Template } from '@eng/core'
import { Assets } from './facts.ts'
import { containsFloat, createEnvironment } from './env.ts'
import { REGISTRY } from './pipeline.ts'
import type { PolicyDoc } from './types.ts'

export interface LintFinding { id: string; where: string; message: string }

export function lintPolicy(p: PolicyDoc, template?: Template): LintFinding[] {
  const out: LintFinding[] = []
  const env = createEnvironment({ assets: new Assets(p.assets ?? {}) })
  // definitions are visible to rules as `def.<name>`
  const exprs: Array<{ where: string; expr: string }> = []
  for (const [n, e] of Object.entries(p.definitions ?? {})) exprs.push({ where: `definitions.${n}`, expr: e })
  const seen = new Set<string>()
  for (const [stage, def] of Object.entries(p.stages)) {
    for (const r of def.rules) {
      if (seen.has(r.id)) out.push({ id: 'L7', where: `${stage}/${r.id}`, message: `duplicate rule id ${r.id}` })
      seen.add(r.id)
      if (r.when) exprs.push({ where: `${stage}/${r.id}.when`, expr: r.when })
      exprs.push({ where: `${stage}/${r.id}.check`, expr: r.check })
      if (!r.reason) out.push({ id: 'L7', where: `${stage}/${r.id}`, message: 'missing reason code' })
    }
  }
  for (const { where, expr } of exprs) {
    let ast: unknown
    try {
      ast = (env.parse(expr) as unknown as { ast: unknown }).ast
    } catch (e) {
      out.push({ id: 'L1', where, message: `parse error: ${String((e as Error).message).split('\n')[0]}` })
      continue
    }
    if (containsFloat(ast)) out.push({ id: 'L1', where, message: 'floating-point values are not allowed in cel-eng/1' })
    const c = env.check(expr) as { valid: boolean; error?: { message: string }; type?: unknown }
    if (!c.valid) out.push({ id: 'L1', where, message: `type error: ${String(c.error?.message).split('\n')[0]}` })
    // L3: statement types referenced by att.* must exist in the registry
    for (const m of expr.matchAll(/att\.(?:list|latest|only|quorum)\(\s*'([^']+)'/g)) {
      if (!REGISTRY[m[1]]) out.push({ id: 'L3', where, message: `unknown statement type ${m[1]}` })
    }
  }
  if (template) {
    // L2: every stage the template references has rules; L5: enforcement agrees with the template.
    for (const [on, o] of Object.entries(template.outcomes)) {
      if (!o.policyStage) continue
      const st = p.stages[o.policyStage]
      if (!st) { out.push({ id: 'L2', where: on, message: `template stage ${o.policyStage} has no rules` }); continue }
      if (o.enforcement && st.enforcement !== o.enforcement && !(o.enforcement === 'advisory' && st.enforcement === 'advisory')) {
        out.push({ id: 'L5', where: on, message: `policy declares ${st.enforcement} but template declares ${o.enforcement}` })
      }
    }
  }
  return out
}
