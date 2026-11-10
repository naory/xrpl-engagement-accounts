// Statement verification pipeline (docs/spec/attestations.md §10.1). Deterministic at the pinned
// ledger. M1 scope: steps 1–3 and 5–12; anchoring (step 4) is recorded as "unanchored → evaluation
// ledger is the trust ledger", which is the spec's rule for statements without an anchor.
import { verifyStatement, type Statement } from '@eng/core'
import type { EngagementRecord, LedgerSnapshot, StatementRejection } from './types.ts'

export interface TypeMeta {
  scope: 'engagement' | 'global'
  /** never: a party may not issue it; corroborate: party-issued needs an independent statement; always: party statements OK. */
  selfAttest: 'never' | 'corroborate' | 'always'
  singleUse: boolean
  maxLagSecs: number | null
}

/** Claim-type registry (attestations spec §8), pinned as "att-registry@2026.10". */
export const REGISTRY_VERSION = 'att-registry@2026.10'
export const REGISTRY: Record<string, TypeMeta> = {
  'shipping.shipped/1': { scope: 'engagement', selfAttest: 'never', singleUse: false, maxLagSecs: 86400 },
  'shipping.delivered/1': { scope: 'engagement', selfAttest: 'never', singleUse: false, maxLagSecs: 86400 },
  'inspection.milestone/1': { scope: 'engagement', selfAttest: 'never', singleUse: true, maxLagSecs: 259200 },
  'inspection.certificate/1': { scope: 'engagement', selfAttest: 'never', singleUse: true, maxLagSecs: 259200 },
  'trade.ebl/1': { scope: 'engagement', selfAttest: 'never', singleUse: true, maxLagSecs: 86400 },
  'registry.transfer/1': { scope: 'engagement', selfAttest: 'never', singleUse: true, maxLagSecs: 21600 },
  'service.uptime/1': { scope: 'global', selfAttest: 'never', singleUse: true, maxLagSecs: 86400 },
  'ad.delivery/1': { scope: 'engagement', selfAttest: 'never', singleUse: true, maxLagSecs: 259200 },
  'merchant.category/1': { scope: 'global', selfAttest: 'never', singleUse: false, maxLagSecs: null },
  'production.started/1': { scope: 'engagement', selfAttest: 'corroborate', singleUse: false, maxLagSecs: 86400 },
  'approval.payment/1': { scope: 'engagement', selfAttest: 'never', singleUse: true, maxLagSecs: 3600 },
  'party.mandate/1': { scope: 'engagement', selfAttest: 'always', singleUse: false, maxLagSecs: null },
  'party.confirmation/1': { scope: 'engagement', selfAttest: 'always', singleUse: false, maxLagSecs: null },
  'party.invoice/1': { scope: 'engagement', selfAttest: 'always', singleUse: true, maxLagSecs: null },
  'party.review/1': { scope: 'engagement', selfAttest: 'always', singleUse: false, maxLagSecs: null },
  'party.dispute/1': { scope: 'engagement', selfAttest: 'always', singleUse: false, maxLagSecs: null },
  'party.ruling/1': { scope: 'engagement', selfAttest: 'always', singleUse: true, maxLagSecs: null },
  'party.amendment/1': { scope: 'engagement', selfAttest: 'always', singleUse: true, maxLagSecs: null },
  // The agent's record of the x402 challenge it is paying (destination, amount, invoiceId,
  // resource). Self-attested: it binds the co-signature to a specific purchase (W7); it is not a
  // trust claim about the merchant, which the mandate/vendor rules and the merchant's own x402
  // verify still govern.
  'payment.challenge/1': { scope: 'engagement', selfAttest: 'always', singleUse: false, maxLagSecs: null },
}

const CLOCK_SKEW_SECS = 300

export interface VerifiedStatement {
  statement: Statement
  roles: string[]
}

export interface PipelineResult {
  verified: VerifiedStatement[]
  rejected: StatementRejection[]
}

function keyAuthorized(ledger: LedgerSnapshot, account: string, signerAddress: string): boolean {
  const a = ledger.accounts[account]
  // An account that doesn't exist on the ledger can still sign with its master key (as multisig signers do).
  if (!a || !a.exists) return signerAddress === account
  if (signerAddress === account) return !a.masterDisabled
  return a.regularKey === signerAddress
}

function credentialValid(ledger: LedgerSnapshot, issuer: string, subject: string, type: string): boolean {
  return ledger.credentials.some(
    (c) => c.issuer === issuer && c.subject === subject && c.type === type && c.accepted && (c.expiration == null || Date.parse(c.expiration) > Date.parse(ledger.closeTime)),
  )
}

export function verifyStatements(statements: Statement[], eng: EngagementRecord, ledger: LedgerSnapshot): PipelineResult {
  const verified: VerifiedStatement[] = []
  const rejected: StatementRejection[] = []
  const reject = (s: Statement, code: string) => rejected.push({ id: s?.id ?? '(none)', type: s?.type, code })
  const now = Date.parse(ledger.closeTime)
  const partyRoles = (acct: string) => Object.entries(eng.parties).filter(([, a]) => a === acct).map(([r]) => r)

  const candidates: VerifiedStatement[] = []
  for (const s of statements) {
    // 1–3: shape, content address, signature
    const meta = REGISTRY[s?.type]
    if (!meta) { reject(s, 'UNKNOWN_TYPE'); continue }
    const v = verifyStatement(s)
    if (!v.ok) { reject(s, v.reason); continue }
    // 5: key authorized for the attester account (trust ledger = evaluation ledger when unanchored)
    if (!keyAuthorized(ledger, s.attester.account, v.signerAddress)) { reject(s, 'KEY_NOT_AUTHORIZED'); continue }
    // 6–7: roles: party roles, plus attester roles from the deal terms (with accreditation if required)
    const roles = partyRoles(s.attester.account)
    let accreditationFailed = false
    for (const [role, terms] of Object.entries(eng.attesters ?? {})) {
      if (terms.accounts?.includes(s.attester.account)) roles.push(role)
      else if (terms.accreditors?.length && terms.kind && s.attester.kind === terms.kind) {
        const type = terms.kind === 'APPROVER' ? 'ENG/APPROVER' : `ENG/ATTESTER/${terms.kind}`
        if (terms.accreditors.some((iss) => credentialValid(ledger, iss, s.attester.account, type))) roles.push(role)
        else accreditationFailed = true
      }
    }
    if (roles.length === 0) { reject(s, accreditationFailed ? 'NOT_ACCREDITED' : 'ATTESTER_NOT_IN_TERMS'); continue }
    // 8: binding
    if (meta.scope === 'engagement' && s.engagementId !== eng.engagementId) { reject(s, 'NOT_BOUND'); continue }
    // 9: time
    const issued = Date.parse(s.issuedAt)
    const observed = Date.parse(s.observedAt)
    if (Number.isNaN(issued) || Number.isNaN(observed)) { reject(s, 'MALFORMED'); continue }
    if (issued > now + CLOCK_SKEW_SECS * 1000 || observed > issued + CLOCK_SKEW_SECS * 1000) { reject(s, 'FUTURE_DATED'); continue }
    if (meta.maxLagSecs != null && now - observed > meta.maxLagSecs * 1000) { reject(s, 'STALE'); continue }
    if (s.validUntil && Date.parse(s.validUntil) <= now) { reject(s, 'EXPIRED'); continue }
    // 10: self-attestation
    const isParty = partyRoles(s.attester.account).length > 0
    if (isParty && meta.selfAttest === 'never') { reject(s, 'SELF_ATTESTED'); continue }
    // 12: consumption of single-use statements
    if (meta.singleUse && eng.consumed?.includes(s.id)) { reject(s, 'CONSUMED'); continue }
    candidates.push({ statement: s, roles: [...new Set(roles)] })
  }
  // 11: supersession, same attester only
  const superseded = new Set<string>()
  for (const c of candidates) {
    const sup = c.statement.supersedes
    if (!sup) continue
    const target = candidates.find((o) => o.statement.id === sup)
    if (target && target.statement.attester.account === c.statement.attester.account) superseded.add(sup)
  }
  for (const c of candidates) {
    if (superseded.has(c.statement.id)) rejected.push({ id: c.statement.id, type: c.statement.type, code: 'SUPERSEDED' })
    else if (c.statement.supersedes && !candidates.some((o) => o.statement.id === c.statement.supersedes && o.statement.attester.account === c.statement.attester.account) && candidates.some((o) => o.statement.id === c.statement.supersedes)) {
      rejected.push({ id: c.statement.id, type: c.statement.type, code: 'FOREIGN_SUPERSESSION' })
    } else verified.push(c)
  }
  return { verified, rejected }
}
