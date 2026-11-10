// eng.provision/1 — a non-custodial provisioning protocol for engagement-account SignerLists.
// Each signer generates its own key and proves control of it (proof-of-possession: a signature
// over a session challenge that both verifies against the submitted public key AND derives to the
// submitted address). The coordinator — which holds no secrets — assembles the SignerList and the
// engagement record once every role has enrolled; the owner then opens the account on-ledger.
//
// PoP is what makes enrolment safe: you can only enrol an address you can sign for, so no party can
// slip in its own key under another role or register an address it does not control.
import * as keypairs from 'ripple-keypairs'
import type { Statement } from '@eng/core'
import type { EngagementRecord } from '@eng/policy'

const PROTOCOL = 'eng.provision/1'
const hex = (s: string): string => Buffer.from(s, 'utf8').toString('hex').toUpperCase()

export interface RoleSpec { role: string; weight: number }

export interface SessionSpec {
  engagementId: string
  template: string
  /** The pre-created engagement account (the funds account whose SignerList we build). */
  account: string
  asset: string
  quorum: number
  /** Signer roles to enrol, with their SignerList weights (owner, agent, cosigner, …). */
  roles: RoleSpec[]
  attesters?: Record<string, { accounts?: string[]; accreditors?: string[] }>
  deleteTo: string
  /** Who funds the open Batch and how much (carried into the plan for the opener). */
  funder: string
  fundingAmount: string
  mandate?: Statement | null
  policyLayers?: string[]
}

export interface Enrollment {
  sessionId: string
  role: string
  address: string
  publicKey: string
  /** Signature over the enrolment message, proving control of the key for `address`. */
  proof: string
}

export interface EnrollResult { ok: true; role: string; enrolled: string[]; remaining: string[] }

export interface OpenPlan {
  engagementId: string
  account: string
  asset: string
  /** SignerList entries, sorted by address (XRPL requires SignerEntries sorted by Account). */
  signerEntries: Array<[string, number]>
  quorum: number
  engagement: EngagementRecord
  mandate: Statement | null
  funder: string
  fundingAmount: string
}

export interface CreatedSession {
  sessionId: string
  /** The per-session nonce each signer signs (with its role + address) to prove possession. */
  challenge: string
  roles: RoleSpec[]
  spec: SessionSpec
}

export interface SessionStatus { complete: boolean; enrolled: string[]; remaining: string[] }

interface SessionState {
  spec: SessionSpec
  challenge: string
  enrolled: Map<string, { address: string; publicKey: string }>
}

/** The canonical message a signer signs to enrol (hex-encoded). */
export function enrolmentMessage(sessionId: string, challenge: string, role: string, address: string): string {
  return hex([PROTOCOL, sessionId, role, address, challenge].join('|'))
}

/** Verify an enrolment's proof-of-possession with no coordinator state. */
export function verifyEnrolment(sessionId: string, challenge: string, e: Enrollment): { ok: boolean; reason?: string } {
  if (e.sessionId !== sessionId) return { ok: false, reason: 'session mismatch' }
  let derived: string
  try { derived = keypairs.deriveAddress(e.publicKey) } catch { return { ok: false, reason: 'bad public key' } }
  if (derived !== e.address) return { ok: false, reason: 'public key does not derive to address' }
  let ok = false
  try { ok = keypairs.verify(enrolmentMessage(sessionId, challenge, e.role, e.address), e.proof, e.publicKey) } catch { ok = false }
  return ok ? { ok: true } : { ok: false, reason: 'proof does not verify' }
}

/** Signer side: build an enrolment from a wallet-like key. The private key never leaves this call. */
export function makeEnrolment(
  session: { sessionId: string; challenge: string },
  role: string,
  wallet: { address: string; publicKey: string; privateKey: string },
): Enrollment {
  const msg = enrolmentMessage(session.sessionId, session.challenge, role, wallet.address)
  return { sessionId: session.sessionId, role, address: wallet.address, publicKey: wallet.publicKey, proof: keypairs.sign(msg, wallet.privateKey) }
}

export class ProvisioningCoordinator {
  private readonly sessions = new Map<string, SessionState>()
  constructor(private readonly o: { nonce?: () => string } = {}) {}

  private id(prefix: string): string {
    const rnd = (this.o.nonce ?? (() => Math.random().toString(16).slice(2) + Date.now().toString(36)))()
    return `${prefix}_${rnd}`
  }

  createSession(spec: SessionSpec): CreatedSession {
    if (!spec.roles.length) throw new Error('no roles to provision')
    if (spec.quorum <= 0) throw new Error('quorum must be positive')
    const sessionId = this.id('prov')
    const challenge = this.id('chal')
    this.sessions.set(sessionId, { spec, challenge, enrolled: new Map() })
    return { sessionId, challenge, roles: spec.roles, spec }
  }

  session(sessionId: string): CreatedSession | undefined {
    const s = this.sessions.get(sessionId)
    return s ? { sessionId, challenge: s.challenge, roles: s.spec.roles, spec: s.spec } : undefined
  }

  enrol(e: Enrollment): EnrollResult {
    const s = this.sessions.get(e.sessionId)
    if (!s) throw new Error(`unknown session ${e.sessionId}`)
    if (!s.spec.roles.some((r) => r.role === e.role)) throw new Error(`role ${e.role} is not part of this session`)
    if (s.enrolled.has(e.role)) throw new Error(`role ${e.role} already enrolled`)
    const v = verifyEnrolment(e.sessionId, s.challenge, e)
    if (!v.ok) throw new Error(`enrolment rejected: ${v.reason}`)
    s.enrolled.set(e.role, { address: e.address, publicKey: e.publicKey })
    return { ok: true, role: e.role, enrolled: [...s.enrolled.keys()], remaining: this.status(e.sessionId).remaining }
  }

  isComplete(sessionId: string): boolean {
    const s = this.sessions.get(sessionId)
    return !!s && s.spec.roles.every((r) => s.enrolled.has(r.role))
  }

  status(sessionId: string): SessionStatus {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error(`unknown session ${sessionId}`)
    return { complete: this.isComplete(sessionId), enrolled: [...s.enrolled.keys()], remaining: s.spec.roles.map((r) => r.role).filter((r) => !s.enrolled.has(r)) }
  }

  /** The assembled, authorised open plan: SignerList + engagement record. Throws until complete. */
  plan(sessionId: string): OpenPlan {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error(`unknown session ${sessionId}`)
    if (!this.isComplete(sessionId)) throw new Error(`session ${sessionId} incomplete: missing ${this.status(sessionId).remaining.join(', ')}`)
    const weightOf = new Map(s.spec.roles.map((r) => [r.role, r.weight]))
    const signerEntries = [...s.enrolled.entries()]
      .map(([role, v]) => [v.address, weightOf.get(role)!] as [string, number])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    const parties: Record<string, string> = Object.fromEntries([...s.enrolled.entries()].map(([role, v]) => [role, v.address]))
    const engagement: EngagementRecord = {
      engagementId: s.spec.engagementId, template: s.spec.template, account: s.spec.account, asset: s.spec.asset,
      parties, attesters: s.spec.attesters, deleteTo: s.spec.deleteTo, state: 'OPEN', consumed: [],
      policyLayers: s.spec.policyLayers, mandateId: s.spec.mandate?.id,
    }
    return { engagementId: s.spec.engagementId, account: s.spec.account, asset: s.spec.asset, signerEntries, quorum: s.spec.quorum, engagement, mandate: s.spec.mandate ?? null, funder: s.spec.funder, fundingAmount: s.spec.fundingAmount }
  }
}
