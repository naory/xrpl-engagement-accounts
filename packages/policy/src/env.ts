// The cel-eng/1 environment (docs/spec/policy.md §3–§4): CEL + Amount + domain helpers.
import { Environment } from '@marcbachmann/cel-js'
import { Amount, bps as bpsFn, zero } from '@eng/core'
import { Assets, HistoryFacts, InflightFacts, LedgerFacts, Payouts, TxFacts } from './facts.ts'
import { toCel } from './convert.ts'
import type { VerifiedStatement } from './pipeline.ts'

export class ConflictError extends Error {
  constructor(type: string, role: string, n: number) { super(`CONFLICT: expected exactly one ${type} from ${role}, found ${n}`) }
}

/** Verified statements, queryable by type and role (`att`). */
export class AttFacts {
  constructor(private readonly verified: VerifiedStatement[]) {}
  private pick(type: string, role: string) {
    return this.verified.filter((v) => v.statement.type === type && (role === '*' || v.roles.includes(role)))
  }
  all(type: string, role: string): unknown[] {
    return this.pick(type, role)
      .sort((a, b) => Date.parse(a.statement.issuedAt) - Date.parse(b.statement.issuedAt))
      .map((v) => toCel({ ...v.statement, roles: v.roles }))
  }
  latest(type: string, role: string): unknown {
    const all = this.all(type, role)
    return all.length ? all[all.length - 1] : null
  }
  only(type: string, role: string): unknown {
    const all = this.all(type, role)
    if (all.length !== 1) throw new ConflictError(type, role, all.length)
    return all[0]
  }
  /** True if ≥ m distinct attesters agree on claim[field]. */
  quorum(type: string, role: string, m: bigint, field: string): boolean {
    const byValue = new Map<string, Set<string>>()
    for (const v of this.pick(type, role)) {
      const val = JSON.stringify((v.statement.claim as Record<string, unknown>)[field] ?? null)
      if (!byValue.has(val)) byValue.set(val, new Set())
      byValue.get(val)!.add(v.statement.attester.account)
    }
    return [...byValue.values()].some((s) => BigInt(s.size) >= m)
  }
  ids(): string[] { return this.verified.map((v) => v.statement.id) }
}

/** Per-decision context holder, so `amt()` knows asset precision. */
export interface EnvContext { assets: Assets }

type Fn = (...args: never[]) => unknown

export function createEnvironment(ctx: EnvContext): Environment {
  const env = new Environment({ unlistedVariablesAreDyn: false })
  const recv = (receiverType: string, name: string, params: Array<[string, string]>, returnType: string, handler: Fn) =>
    env.registerFunction({ name, receiverType, returnType, params: params.map(([n, type]) => ({ name: n, type })), handler: handler as never })

  env.registerType('Amount', Amount)
  env.registerType('Tx', { ctor: TxFacts, fields: { type: 'string', account: 'string', fee: 'int', flags: 'int', hasLastLedgerSequence: 'bool', lastLedgerSequence: 'int', usesTicket: 'bool', isBatch: 'bool', inner: 'list<map>', payouts: 'Payouts' } } as never)
  env.registerType('Payouts', { ctor: Payouts, fields: { items: 'list<map>' } } as never)
  env.registerType('Ledger', LedgerFacts)
  env.registerType('History', HistoryFacts)
  env.registerType('Inflight', InflightFacts)
  env.registerType('Att', AttFacts)

  // Amount arithmetic: same-asset only (mixing throws → the rule errors → fail-closed).
  env.registerOperator('Amount + Amount', (a: Amount, b: Amount) => a.add(b))
  env.registerOperator('Amount - Amount', (a: Amount, b: Amount) => a.sub(b))
  env.registerOperator('Amount * int', (a: Amount, n: bigint) => new Amount(a.asset, a.minor * n))
  env.registerOperator('Amount == Amount', (a: Amount, b: Amount) => a.cmp(b) === 0)
  env.registerOperator('Amount < Amount', (a: Amount, b: Amount) => a.cmp(b) < 0)
  env.registerOperator('Amount <= Amount', (a: Amount, b: Amount) => a.cmp(b) <= 0)
  env.registerOperator('Amount > Amount', (a: Amount, b: Amount) => a.cmp(b) > 0)
  env.registerOperator('Amount >= Amount', (a: Amount, b: Amount) => a.cmp(b) >= 0)
  env.registerFunction('amt(string, string): Amount', (v: string, code: string) => ctx.assets.amount(code, v))
  env.registerFunction('zero(string): Amount', (code: string) => { ctx.assets.get(code); return zero(code) })
  env.registerFunction('asset(string): string', (code: string) => { ctx.assets.get(code); return code })
  env.registerFunction('bps(Amount, int): Amount', (a: Amount, n: bigint) => bpsFn(a, n))
  env.registerFunction('minor(Amount): int', (a: Amount) => a.minor)
  env.registerFunction('assetOf(Amount): string', (a: Amount) => a.asset)

  // tx.*
  recv('Tx', 'closes', [], 'bool', (t: TxFacts) => t.closes())
  recv('Tx', 'matchesBlueprint', [['name', 'string']], 'bool', (t: TxFacts, n: string) => t.matchesBlueprint(n))
  recv('Tx', 'memo', [['type', 'string']], 'dyn', (t: TxFacts, m: string) => t.memo(m))
  recv('Tx', 'intentHash', [], 'string', (t: TxFacts) => t.intentHash())
  recv('Tx', 'boundToInvoice', [['invoiceId', 'string']], 'bool', (t: TxFacts, i: string) => t.boundToInvoice(i))
  recv('Tx', 'innerTypes', [], 'list<string>', (t: TxFacts) => t.innerTypes())
  recv('Tx', 'innerAccounts', [], 'list<string>', (t: TxFacts) => t.innerAccounts())
  recv('Tx', 'isAllOrNothing', [], 'bool', (t: TxFacts) => t.isAllOrNothing())
  recv('Tx', 'setsRegularKey', [], 'bool', (t: TxFacts) => t.setsRegularKey())
  recv('Tx', 'issuersValid', [], 'bool', (t: TxFacts) => t.issuersValid())
  recv('Tx', 'drainsExactly', [], 'bool', (t: TxFacts) => t.drainsExactly())
  recv('Tx', 'deleteDestinationValid', [], 'bool', (t: TxFacts) => t.deleteDestinationValid())
  recv('Tx', 'wouldSucceed', [], 'bool', (t: TxFacts) => t.wouldSucceed())
  // tx.payouts.*
  recv('Payouts', 'sum', [['asset', 'string']], 'Amount', (p: Payouts, a: string) => p.sum(a))
  recv('Payouts', 'to', [['account', 'string'], ['asset', 'string']], 'Amount', (p: Payouts, acct: string, a: string) => p.to(acct, a))
  recv('Payouts', 'destinations', [], 'list<string>', (p: Payouts) => p.destinations())
  recv('Payouts', 'count', [], 'int', (p: Payouts) => BigInt(p.count()))
  recv('Payouts', 'hasResidual', [], 'bool', (p: Payouts) => p.hasResidual())
  // ledger.*
  recv('Ledger', 'balance', [['account', 'string'], ['asset', 'string']], 'Amount', (l: LedgerFacts, acct: string, a: string) => l.balance(acct, a))
  recv('Ledger', 'exists', [['account', 'string']], 'bool', (l: LedgerFacts, a: string) => l.exists(a))
  recv('Ledger', 'masterDisabled', [['account', 'string']], 'bool', (l: LedgerFacts, a: string) => l.masterDisabled(a))
  recv('Ledger', 'hasRegularKey', [['account', 'string']], 'bool', (l: LedgerFacts, a: string) => l.hasRegularKey(a))
  recv('Ledger', 'extraObjects', [['account', 'string']], 'int', (l: LedgerFacts, a: string) => BigInt(l.extraObjects(a)))
  recv('Ledger', 'reserveIncrement', [], 'int', (l: LedgerFacts) => l.reserveIncrement())
  recv('Ledger', 'credentialExists', [['issuer', 'string'], ['subject', 'string'], ['type', 'string']], 'bool', (l: LedgerFacts, i: string, s: string, t: string) => l.credentialExists(i, s, t))
  recv('Ledger', 'hasCredential', [['account', 'string'], ['type', 'string'], ['issuers', 'list<string>']], 'bool', (l: LedgerFacts, a: string, t: string, is: string[]) => l.hasCredential(a, t, is))
  // history.* / inflight.*  (durations are CEL google.protobuf.Duration)
  recv('History', 'outflow', [['asset', 'string'], ['window', 'google.protobuf.Duration']], 'Amount', (h: HistoryFacts, a: string, w: { seconds: bigint }) => h.outflow(a, w.seconds))
  recv('History', 'count', [['window', 'google.protobuf.Duration']], 'int', (h: HistoryFacts, w: { seconds: bigint }) => BigInt(h.count(w.seconds)))
  recv('History', 'paidTo', [['account', 'string'], ['asset', 'string'], ['window', 'google.protobuf.Duration']], 'Amount', (h: HistoryFacts, acct: string, a: string, w: { seconds: bigint }) => h.paidTo(acct, a, w.seconds))
  recv('Inflight', 'outflow', [['asset', 'string']], 'Amount', (i: InflightFacts, a: string) => i.outflow(a))
  recv('Inflight', 'count', [], 'int', (i: InflightFacts) => BigInt(i.count()))
  // att.*
  recv('Att', 'list', [['type', 'string'], ['role', 'string']], 'list<map>', (a: AttFacts, t: string, r: string) => a.all(t, r))
  recv('Att', 'latest', [['type', 'string'], ['role', 'string']], 'dyn', (a: AttFacts, t: string, r: string) => a.latest(t, r))
  recv('Att', 'only', [['type', 'string'], ['role', 'string']], 'dyn', (a: AttFacts, t: string, r: string) => a.only(t, r))
  recv('Att', 'quorum', [['type', 'string'], ['role', 'string'], ['m', 'int'], ['field', 'string']], 'bool', (a: AttFacts, t: string, r: string, m: bigint, f: string) => a.quorum(t, r, m, f))

  // Variables (the input model, policy spec §3)
  env.registerVariable('stage', 'string')
  env.registerVariable('hasTx', 'bool')
  env.registerVariable('eng', 'map')
  env.registerVariable('mandate', 'map')
  env.registerVariable('tx', 'Tx')
  env.registerVariable('ledger', 'Ledger')
  env.registerVariable('history', 'History')
  env.registerVariable('inflight', 'Inflight')
  env.registerVariable('att', 'Att')
  env.registerVariable('now', 'google.protobuf.Timestamp')
  env.registerVariable('ledgerIndex', 'int')
  env.registerVariable('params', 'map')
  env.registerVariable('constraints', 'map')
  env.registerVariable('def', 'map')
  return env
}

/** Lint helper: does the parsed expression contain a float literal or a double() conversion? */
export function containsFloat(ast: unknown): boolean {
  let found = false
  const walk = (n: unknown): void => {
    if (found || n == null) return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (typeof n !== 'object') return
    const node = n as { op?: string; args?: unknown }
    if (node.op === 'value' && typeof node.args === 'number') { found = true; return }
    if (node.op === 'call' && Array.isArray(node.args) && node.args[0] === 'double') { found = true; return }
    walk(node.args)
  }
  walk(ast)
  return found
}

/** Count AST nodes (cost proxy). */
export function astSize(ast: unknown): number {
  let n = 0
  const walk = (x: unknown): void => {
    if (x == null) return
    if (Array.isArray(x)) { x.forEach(walk); return }
    if (typeof x === 'object') { n++; walk((x as { args?: unknown }).args) }
  }
  walk(ast)
  return n
}
