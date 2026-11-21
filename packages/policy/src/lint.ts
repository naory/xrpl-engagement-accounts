// Policy lint (docs/spec/policy.md §11): L1 parse/type/float ban, L2 stage coverage, L3 statement
// types in the registry, L5 enforcement vs template, L7 unique rule ids, L8 plain-English text, L9 stay-terms
// consistency (per-night variant cap vs maxStayVariantNights; rulingWindow within its bounds), L10 slot placement,
// L11 baselineRef agreement between a template policy and its template,
// L12 the template's default ship window and inspect gap against minShipWindow / minInspectGap.
// (L4 static cost bound and L6 layer monotonicity are follow-ups.)
import type { Template } from '@eng/core'
import { Assets } from './facts.ts'
import { celDurationMs, containsFloat, createEnvironment } from './env.ts'
import { REGISTRY } from './pipeline.ts'
import type { PolicyDoc } from './types.ts'
import { PLACEHOLDERS, slotViolations } from './trust.ts'

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
      // L8: every rule carries plain-English text (non-normative; shown to people deciding or reviewing a deal)
      const missing = [!r.title?.trim() && 'title', !r.message?.trim() && 'message'].filter(Boolean)
      if (missing.length) out.push({ id: 'L8', where: `${stage}/${r.id}`, message: `missing plain-English ${missing.join(' and ')}` })
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
      // L9: a per-night outcome covers stays of up to variants.max + 1 nights; the policy must state the same cap.
      const cap = p.params?.maxStayVariantNights
      if (o.variants?.perNight && cap !== undefined && cap !== o.variants.max + 1) {
        out.push({ id: 'L9', where: on, message: `variants.max ${o.variants.max} covers stays of up to ${o.variants.max + 1} nights, but the policy's maxStayVariantNights is ${JSON.stringify(cap)}` })
      }
    }
  }
  out.push(...rulingWindowFindings(p))
  out.push(...slotFindings(p))
  out.push(...baselineRefFindings(p, template))
  out.push(...shipWindowFindings(p, template))
  return out
}

/**
 * L12: when the policy sets minShipWindow / minInspectGap and the template has those timers, the
 * template defaults have to meet them. The floors are not copied into the template validator.
 */
function shipWindowFindings(p: PolicyDoc, template?: Template): LintFinding[] {
  const ship = template?.timers?.shipBy
  const inspect = template?.timers?.inspectBy
  if (!ship || !inspect) return []
  const out: LintFinding[] = []
  const window = p.params?.minShipWindow
  const gap = p.params?.minInspectGap
  if (typeof window === 'string') {
    let ms: number
    try { ms = celDurationMs(window) } catch {
      return [{ id: 'L12', where: 'params.minShipWindow', message: `${JSON.stringify(window)} is not a duration` }]
    }
    if (ship.durationSecs * 1000 < ms) out.push({ id: 'L12', where: 'timers.shipBy', message: `shipBy ${ship.durationSecs}s is shorter than minShipWindow ${window}` })
  }
  if (typeof gap === 'string') {
    let ms: number
    try { ms = celDurationMs(gap) } catch {
      out.push({ id: 'L12', where: 'params.minInspectGap', message: `${JSON.stringify(gap)} is not a duration` })
      return out
    }
    const span = inspect.durationSecs - ship.durationSecs
    if (ship.from === inspect.from && span * 1000 < ms) out.push({ id: 'L12', where: 'timers.inspectBy', message: `inspectBy − shipBy ${span}s is shorter than minInspectGap ${gap}` })
  }
  return out
}

/** L11: a template policy's baselineRef matches the template it applies to. Hotel omits both. */
function baselineRefFindings(p: PolicyDoc, template?: Template): LintFinding[] {
  if (!template || p.layer !== 'template') return []
  if (p.baselineRef === undefined && template.baselineRef === undefined) return []
  if (p.baselineRef === template.baselineRef) return []
  return [{
    id: 'L11',
    where: 'baselineRef',
    message: `policy baselineRef ${JSON.stringify(p.baselineRef ?? null)} does not match template baselineRef ${JSON.stringify(template.baselineRef ?? null)}`,
  }]
}

/** L10: `$slot:` only on an asset issuer or in params.arbiterIssuers / params.kybIssuers, and only a known name. */
function slotFindings(p: PolicyDoc): LintFinding[] {
  const out: LintFinding[] = slotViolations(p).map((v) => ({ id: 'L10', where: v.where, message: v.message }))
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if ((PLACEHOLDERS as readonly string[]).includes(value)) {
        out.push({ id: 'L10', where: path || '(root)', message: `placeholder account ${value} belongs in deploy config, not the policy` })
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`))
      return
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key)
    }
  }
  walk(p, '')
  return out
}

/** L9: params.rulingWindow (when set) lies within params.minRulingWindow / maxRulingWindow (when set), all durations. */
function rulingWindowFindings(p: PolicyDoc): LintFinding[] {
  const out: LintFinding[] = []
  const ms: Record<string, number | undefined> = {}
  for (const k of ['rulingWindow', 'minRulingWindow', 'maxRulingWindow']) {
    const v = p.params?.[k]
    if (v === undefined) continue
    try { ms[k] = celDurationMs(String(v)) } catch { out.push({ id: 'L9', where: `params.${k}`, message: `${JSON.stringify(v)} is not a duration` }) }
  }
  const w = ms.rulingWindow
  if (w !== undefined && ((ms.minRulingWindow !== undefined && w < ms.minRulingWindow) || (ms.maxRulingWindow !== undefined && w > ms.maxRulingWindow))) {
    out.push({ id: 'L9', where: 'params.rulingWindow', message: `${String(p.params!.rulingWindow)} is outside [${String(p.params!.minRulingWindow ?? '-')}, ${String(p.params!.maxRulingWindow ?? '-')}]` })
  }
  return out
}

/** Human-readable rule names and explanations (`title`, `message`) keyed by rule id, for UIs. Not normative. */
export function ruleExplanations(layers: PolicyDoc[]): Record<string, { title?: string; message?: string }> {
  const out: Record<string, { title?: string; message?: string }> = {}
  for (const l of layers) for (const st of Object.values(l.stages)) for (const r of st.rules) {
    if (r.title || r.message) out[r.id] = { ...(r.title ? { title: r.title } : {}), ...(r.message ? { message: r.message } : {}) }
  }
  return out
}
