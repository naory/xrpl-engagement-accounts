import type { Statement } from '@eng/core'
import type { Decision } from '@eng/policy'

type Json = Record<string, unknown>

export interface DecideRequest {
  engagementId: string
  stage: string
  /** Transaction JSON, or a (partially) signed blob from another signer. */
  tx?: Json | null
  txBlob?: string
  statements?: Statement[]
}

export interface DecideResponse {
  decision: Decision['decision']
  failing: string[]
  results: Decision['results']
  statementsRejected: Decision['statementsRejected']
  /** Signed cosigner.decision/1 record. */
  record: Statement
  /** The co-signer's multisig signature on the evaluated transaction (SIGN only); combine with xrpl.multisign. */
  signerBlob?: string
  /** The exact transaction evaluated and signed. */
  tx?: Json | null
  /** Set when the stage is not one the co-signer signs (advisory evaluation only). */
  advisory?: true
}
