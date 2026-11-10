// decide(): the co-signer's pure function (docs/spec/policy.md §8).
import { documentHash, sha256Jcs, type AssetDef, type StatementBody } from '@eng/core'
import { Assets, HistoryFacts, InflightFacts, LedgerFacts, TxFacts } from './facts.ts'
import { AttFacts, astSize, createEnvironment } from './env.ts'
import { toCel } from './convert.ts'
import { REGISTRY_VERSION, verifyStatements } from './pipeline.ts'
import type { Decision, DecideInput, PolicyDoc, Rule, RuleResult } from './types.ts'

const DEFAULT_COST_BUDGET = 100_000

export function layerHash(l: PolicyDoc): string {
  return documentHash(l)
}

export function decide(input: DecideInput): Decision {
  const { stage, engagement: eng, template, layers, ledger } = input
  const results: RuleResult[] = []
  const budget = input.costBudget ?? DEFAULT_COST_BUDGET
  let cost = 0

  // Assets: union of all layers' declarations (later layers can't redefine a code differently).
  const assetDefs: Record<string, AssetDef> = {}
  for (const l of layers) for (const [code, def] of Object.entries(l.assets ?? {})) {
    if (assetDefs[code] && JSON.stringify(assetDefs[code]) !== JSON.stringify(def)) throw new Error(`asset ${code} redefined by ${l.policyId}`)
    assetDefs[code] = def
  }
  const assets = new Assets(assetDefs)
  const env = createEnvironment({ assets })

  // Statements → verified set (attestation pipeline). Mandate is a statement too.
  const all = [...(input.mandate ? [input.mandate] : []), ...input.statements]
  const pipeline = verifyStatements(all, eng, ledger)
  const att = new AttFacts(pipeline.verified)
  const mandateOk = input.mandate ? pipeline.verified.find((v) => v.statement.id === input.mandate!.id && v.roles.some((r) => r === 'principal' || r === 'owner')) : undefined

  const now = new Date(ledger.closeTime)
  const tx = input.proposedTx ? new TxFacts(input.proposedTx, { eng, template, assets, ledger }) : null
  const allowedDestinations = [
    ...Object.values(eng.parties),
    ...(eng.fee ? [eng.fee.to] : []),
    ...(eng.children ?? []),
    ...(eng.deleteTo ? [eng.deleteTo] : []),
    ...(template.class === 'owner-wallet' && mandateOk ? ((mandateOk.statement.claim as { vendors?: string[] }).vendors ?? []) : []),
  ]
  const baseCtx: Record<string, unknown> = {
    stage,
    hasTx: tx !== null,
    eng: toCel({ ...eng, class: template.class, allowedDestinations: [...new Set(allowedDestinations)] }),
    mandate: toCel(mandateOk ? mandateOk.statement.claim : {}),
    tx: tx ?? new TxFacts({ TransactionType: 'None', Account: '', Fee: '0' }, { eng, template, assets, ledger }),
    ledger: new LedgerFacts(ledger, assets),
    history: new HistoryFacts(ledger.history[eng.account] ?? [], now, assets),
    inflight: new InflightFacts(input.inflight, assets),
    att,
    now,
    ledgerIndex: BigInt(ledger.index),
  }

  const evalExpr = (expr: string, ctx: Record<string, unknown>): unknown => {
    const parsed = env.parse(expr) as unknown as ((c: Record<string, unknown>) => unknown) & { ast: unknown }
    cost += astSize(parsed.ast)
    if (cost > budget) throw new Error('COST_EXCEEDED')
    return parsed(ctx)
  }
  const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0]

  // Which layers have rules for this stage?
  const stageKnown = layers.some((l) => l.layer !== 'baseline' && l.stages[stage])
  if (!stageKnown) results.push({ layer: '-', id: 'NO_RULES_FOR_STAGE', result: 'fail', reason: 'NO_RULES_FOR_STAGE', message: `no policy layer defines stage "${stage}"` })

  let constraints: Record<string, unknown> = {}
  for (const layer of layers) {
    constraints = { ...constraints, ...(layer.constraints ?? {}) }
    const ctx: Record<string, unknown> = { ...baseCtx, params: toCel(layer.params ?? {}), constraints: toCel(constraints), def: {} }
    // Definitions: evaluated eagerly in order; a failing definition makes the rules that use it error.
    const defs: Record<string, unknown> = {}
    for (const [name, expr] of Object.entries(layer.definitions ?? {})) {
      try { defs[name] = evalExpr(expr, { ...ctx, def: defs }) } catch (e) { defs[name] = new DefinitionError(name, firstLine(e)) }
    }
    ctx.def = new Proxy(defs, {
      get(target, prop: string) {
        const v = target[prop]
        if (v instanceof DefinitionError) throw v
        return v
      },
    })
    const rules: Rule[] = [...(layer.stages['*']?.rules ?? []), ...(layer.stages[stage]?.rules ?? [])]
    for (const r of rules) {
      const res: RuleResult = { layer: `${layer.policyId}@${layer.version}`, id: r.id, result: 'pass' }
      try {
        if (r.when && evalExpr(r.when, ctx) !== true) { res.result = 'n/a'; results.push(res); continue }
        const ok = evalExpr(r.check, ctx)
        if (ok !== true) { res.result = 'fail'; res.reason = r.reason; res.message = r.message }
      } catch (e) {
        res.result = 'error'
        res.reason = r.reason
        res.error = firstLine(e)
        if (res.error === 'COST_EXCEEDED') res.reason = 'COST_EXCEEDED'
      }
      results.push(res)
      if (cost > budget) break
    }
  }

  const failing = results.filter((r) => r.result === 'fail' || r.result === 'error').map((r) => r.id)
  const layerIds = layers.map((l) => `${l.policyId}@${l.version} ${layerHash(l)}`)
  const proposedTxHash = input.proposedTx ? documentHash(input.proposedTx) : null
  const inputsHash = sha256Jcs({
    engagement: eng,
    stage,
    proposedTx: input.proposedTx,
    statements: all.map((s) => s.id),
    ledger: { index: ledger.index, hash: ledger.hash },
    inflight: input.inflight.map((i) => i.decisionId),
    layers: layerIds,
    registry: input.registry ? input.registry : REGISTRY_VERSION,
  })
  return {
    decision: failing.length === 0 ? 'SIGN' : 'REFUSE',
    stage,
    engagementId: eng.engagementId,
    results,
    failing,
    statementsUsed: att.ids(),
    statementsRejected: pipeline.rejected,
    inflightCounted: input.inflight.map((i) => i.decisionId),
    ledger: { index: ledger.index, hash: ledger.hash, closeTime: ledger.closeTime },
    policy: { effectiveHash: documentHash(layers), layers: layerIds },
    inputsHash,
    costUnits: cost,
    proposedTxHash,
  }
}

class DefinitionError extends Error {
  constructor(name: string, msg: string) { super(`definition ${name} failed: ${msg}`) }
}

/** The decision as a `cosigner.decision/1` statement body (policy spec §12), ready to sign. */
export function decisionStatementBody(d: Decision, cosigner: { account: string; accreditation?: { issuer: string; credentialType: string } }, nonce: string, intentHash?: string): StatementBody {
  return {
    v: 'eng.att/1',
    type: 'cosigner.decision/1',
    engagementId: d.engagementId,
    subject: { stage: d.stage, proposedTxHash: d.proposedTxHash, ...(intentHash ? { intentHash } : {}) },
    claim: {
      decision: d.decision,
      failing: d.failing,
      results: d.results.map((r) => ({ layer: r.layer, id: r.id, result: r.result, ...(r.reason && r.result !== 'pass' ? { reason: r.reason } : {}), ...(r.error ? { error: r.error } : {}) })),
      policy: d.policy,
      language: 'cel-eng/1',
      registry: REGISTRY_VERSION,
      ledger: d.ledger,
      inputsHash: d.inputsHash,
      statementsUsed: d.statementsUsed,
      statementsRejected: d.statementsRejected,
      inflightCounted: d.inflightCounted,
      costUnits: d.costUnits,
    },
    observedAt: d.ledger.closeTime,
    issuedAt: d.ledger.closeTime,
    nonce,
    attester: { account: cosigner.account, kind: 'COSIGNER', ...(cosigner.accreditation ? { accreditation: cosigner.accreditation } : {}) },
  }
}
