// Statement envelope (docs/spec/attestations.md §3–§4).
//   body   = envelope without "proof" and "id"
//   digest = SHA-512Half("ENGA\0" || JCS(body))
//   id     = "att:" + hex(digest)
//   proof.signature = ripple-keypairs sign(hex(digest)) with the signer's XRPL key
// The "ENGA\0" prefix is a domain separator: a statement signature can never be valid as an XRPL
// transaction signature (prefix "STX\0") and vice versa.
import { createHash, randomBytes } from 'node:crypto'
import * as keypairs from 'ripple-keypairs'
import { canonicalize } from './jcs.ts'

export const STATEMENT_PREFIX = Buffer.from('ENGA\0', 'latin1')

export interface Proof {
  alg: 'xrpl-secp256k1' | 'xrpl-ed25519'
  publicKey: string
  signature: string
}

export interface Attester {
  account: string
  kind: string
  accreditation?: { issuer: string; credentialType: string }
}

export interface StatementBody {
  v: 'eng.att/1'
  type: string
  engagementId?: string | null
  subject: Record<string, unknown>
  claim: Record<string, unknown>
  observedAt: string
  issuedAt: string
  validUntil?: string | null
  evidence?: Array<{ mediaType?: string; hash: string; uri?: string | null; label?: string }>
  supersedes?: string | null
  nonce: string
  attester: Attester
}

export interface Statement extends StatementBody {
  proof: Proof
  id: string
}

/** Local keypair signing shape used by the (still sync) signStatement until Task 2 migrates it to
 *  the async sign-not-export `Signer` (see ./signer.ts). Internal; not exported to avoid collision. */
interface KeyPairSigner {
  address?: string
  classicAddress?: string
  publicKey: string
  privateKey: string
}

export function sha512Half(data: Buffer): Buffer {
  return createHash('sha512').update(data).digest().subarray(0, 32)
}

export function bodyOf(s: StatementBody | Statement): StatementBody {
  const { proof: _p, id: _i, ...body } = s as Statement
  return body as StatementBody
}

export function statementDigest(body: StatementBody): Buffer {
  return sha512Half(Buffer.concat([STATEMENT_PREFIX, Buffer.from(canonicalize(body), 'utf8')]))
}

export function statementId(body: StatementBody): string {
  return 'att:' + statementDigest(body).toString('hex').toUpperCase()
}

export function newNonce(): string {
  return randomBytes(16).toString('hex')
}

function algOf(publicKey: string): Proof['alg'] {
  return publicKey.toUpperCase().startsWith('ED') ? 'xrpl-ed25519' : 'xrpl-secp256k1'
}

export function signStatement(body: StatementBody, signer: KeyPairSigner): Statement {
  const digest = statementDigest(body)
  const signature = keypairs.sign(digest.toString('hex').toUpperCase(), signer.privateKey)
  return {
    ...body,
    proof: { alg: algOf(signer.publicKey), publicKey: signer.publicKey, signature },
    id: 'att:' + digest.toString('hex').toUpperCase(),
  }
}

export type VerifyResult = { ok: true; signerAddress: string } | { ok: false; reason: 'BAD_ID' | 'BAD_SIGNATURE' | 'MALFORMED' }

/**
 * Cryptographic checks only (pipeline steps 2–3). Whether the key is authorized for the attester's
 * account (master or RegularKey at the trust ledger) needs ledger state and is checked by the policy
 * package (step 5).
 */
export function verifyStatement(s: Statement): VerifyResult {
  if (!s || s.v !== 'eng.att/1' || !s.proof || typeof s.id !== 'string') return { ok: false, reason: 'MALFORMED' }
  let digest: Buffer
  try {
    digest = statementDigest(bodyOf(s))
  } catch {
    return { ok: false, reason: 'MALFORMED' }
  }
  if ('att:' + digest.toString('hex').toUpperCase() !== s.id) return { ok: false, reason: 'BAD_ID' }
  let good = false
  try {
    good = keypairs.verify(digest.toString('hex').toUpperCase(), s.proof.signature, s.proof.publicKey)
  } catch {
    good = false
  }
  if (!good) return { ok: false, reason: 'BAD_SIGNATURE' }
  return { ok: true, signerAddress: keypairs.deriveAddress(s.proof.publicKey) }
}

/** Content hash for arbitrary JSON documents (policies, templates, engagement records). */
export function documentHash(doc: unknown): string {
  return 'att:' + sha512Half(Buffer.concat([STATEMENT_PREFIX, Buffer.from(canonicalize(doc), 'utf8')])).toString('hex').toUpperCase()
}

/** SHA-256 over JCS, used for payment-intent hashes (attestations spec §8.3). */
export function sha256Jcs(doc: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonicalize(doc), 'utf8').digest('hex')
}
