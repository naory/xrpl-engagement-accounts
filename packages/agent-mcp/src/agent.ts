// The agent-side half of a policy co-signed engagement account (docs/spec §6–§8): an
// autonomous agent proposes a payment from its engagement account, the policy co-signer
// evaluates it and — only on SIGN — returns its multisig signature, and the two signatures
// combine into a quorum blob the ledger accepts. This module is the reusable, transport-free
// core; client.ts wraps a *remote* co-signer over HTTP, and server.ts exposes the flow to an
// agent as MCP tools. The agent key is a SignerList entry below quorum: it can never move
// funds alone, so a compromised agent cannot pay anyone the policy would not have signed for.
import xrpl from 'xrpl'
import type { Statement } from '@eng/core'
import {
  combine, accountInfo, currentLedger, serverFees, multisigFee, multisignBlob, iou, memo, submit,
  type DecideRequest, type DecideResponse, type Fees, type SubmitResult,
} from '@eng/cosigner'

type Json = Record<string, unknown>
type Wallet = InstanceType<typeof xrpl.Wallet>
type XrplClient = InstanceType<typeof xrpl.Client>

/** The co-signer, as the agent sees it: the one call that evaluates and (on SIGN) signs. */
export interface Decider {
  decide(req: DecideRequest): Promise<DecideResponse>
}

/**
 * The ledger, as the agent needs it: enough to build a transaction (fees, the account's
 * sequence, a deadline) and to broadcast one. Live against a rippled/Clio server via
 * XrplChain; a test or a dry run supplies a fake. Absent ⇒ the agent proposes but cannot submit.
 */
export interface Chain {
  fees(): Promise<Fees>
  currentLedger(): Promise<number>
  accountSequence(account: string): Promise<number>
  submit(blob: string): Promise<SubmitResult>
}

/** A live XRPL connection. */
export class XrplChain implements Chain {
  constructor(private readonly client: XrplClient) {}
  fees(): Promise<Fees> { return serverFees(this.client) }
  currentLedger(): Promise<number> { return currentLedger(this.client) }
  async accountSequence(account: string): Promise<number> {
    const info = await accountInfo(this.client, account)
    if (!info) throw new Error(`account ${account} not found on the ledger`)
    return Number((info.account_data as Json).Sequence)
  }
  submit(blob: string): Promise<SubmitResult> { return submit(this.client, blob) }
}

/** The asset an engagement account spends (an IOU — matches the policy's asset definition). */
export interface AssetSpec {
  /** Ledger currency: a 3-char code, or 40 hex chars for a non-standard code. */
  currency: string
  /** IOU issuer address. */
  issuer: string
  /** Human label used in display (e.g. "RLUSD"); defaults to `currency`. */
  code?: string
}

export interface AgentConfig {
  engagementId: string
  /** The engagement account — the sender of every payment. */
  account: string
  /** The agent's signing key: a SignerList entry, weight below quorum, never funded. */
  wallet: Wallet
  asset: AssetSpec
  /** The co-signer (local CosignerService or a remote CosignerClient). */
  decider: Decider
  /** Present ⇒ live build + submit; absent ⇒ offline (caller supplies sequence; no submit). */
  chain?: Chain
  /** Policy stage to evaluate against (default "spend"). */
  stage?: string
  /** How many ledgers a proposed payment stays valid (default 20). */
  ttlLedgers?: number
}

export interface PaymentInput {
  destination: string
  /** Decimal string in the asset's units, e.g. "800.00". */
  amount: string
  /** Reference bound into the eng/invoice memo (an invoice ref / order id). */
  invoiceRef?: string
  /** Signed supporting statements the co-signer needs (invoice, approval, …). */
  statements?: Statement[]
  /** Offline only: the outer Sequence (live mode reads it from the ledger). */
  sequence?: number
  /** Offline only: the LastLedgerSequence deadline (live mode computes it). */
  lastLedgerSequence?: number
  /** Offline only: fee base in drops (live mode reads server fees). Default 10. */
  feeBase?: number
}

export interface Proposal {
  /** The exact transaction evaluated and (on SIGN) signed by both parties. */
  tx: Json
  /** The agent's own multisignature over `tx`. */
  agentBlob: string
  /** The co-signer's verdict and signed decision record. */
  decision: DecideResponse
  /** Agent + co-signer signatures merged into a submittable quorum blob (SIGN only). */
  combined?: string
}

export class EngagementAgent {
  constructor(private readonly cfg: AgentConfig) {}

  get engagementId(): string { return this.cfg.engagementId }
  get account(): string { return this.cfg.account }
  get stage(): string { return this.cfg.stage ?? 'spend' }

  /** Build the payment transaction the agent will propose (no signatures yet). */
  async buildPayment(input: PaymentInput): Promise<Json> {
    const { account, asset, chain } = this.cfg
    const base = chain ? (await chain.fees()).base : (input.feeBase ?? 10)
    const sequence = input.sequence ?? (chain ? await chain.accountSequence(account) : undefined)
    if (sequence == null) throw new Error('no Sequence: provide input.sequence or configure a chain')
    const lls = input.lastLedgerSequence ?? (chain ? (await chain.currentLedger()) + (this.cfg.ttlLedgers ?? 20) : undefined)
    const tx: Json = {
      TransactionType: 'Payment',
      Account: account,
      Destination: input.destination,
      Amount: iou(asset.currency, asset.issuer, input.amount),
      Fee: multisigFee(base, 2),
      Sequence: sequence,
      SigningPubKey: '',
      Flags: 0,
      Memos: [memo('eng/basis', this.stage), ...(input.invoiceRef ? [memo('eng/invoice', input.invoiceRef)] : [])],
    }
    if (lls != null) tx.LastLedgerSequence = lls
    return tx
  }

  /**
   * Propose a payment: build (or accept a prebuilt `tx`), add the agent's signature, ask the
   * co-signer, and — on SIGN — merge the two signatures into a quorum blob. Nothing is
   * broadcast; call submit()/payVendor() to settle.
   */
  async proposePayment(input: PaymentInput & { tx?: Json }): Promise<Proposal> {
    const tx = input.tx ?? await this.buildPayment(input)
    const agentBlob = multisignBlob(this.cfg.wallet, tx)
    const decision = await this.cfg.decider.decide({
      engagementId: this.cfg.engagementId, stage: this.stage, txBlob: agentBlob, statements: input.statements ?? [],
    })
    const combined = decision.decision === 'SIGN' && decision.signerBlob ? combine([agentBlob, decision.signerBlob]) : undefined
    return { tx, agentBlob, decision, combined }
  }

  /** Broadcast a quorum blob. Requires a chain (a live XRPL connection). */
  async submit(combined: string): Promise<SubmitResult> {
    if (!this.cfg.chain) throw new Error('submit requires a chain (configure AgentConfig.chain)')
    return this.cfg.chain.submit(combined)
  }

  /** Propose and, if the co-signer signs, broadcast in one step. Requires a chain. */
  async payVendor(input: PaymentInput): Promise<{ proposal: Proposal; submit?: SubmitResult }> {
    const proposal = await this.proposePayment(input)
    if (!proposal.combined) return { proposal }
    return { proposal, submit: await this.submit(proposal.combined) }
  }
}
