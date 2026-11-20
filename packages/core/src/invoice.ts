// party.invoice/1 for an owner-wallet procurement payment.
// Signing is signStatement. This file adds no signature scheme.
import { parseAmount, type AssetDef } from './amount.ts'
import { newNonce, signStatement, type Statement, type StatementBody } from './statement.ts'

/** RLUSD-shaped demo IOU. The issuer is the engagement's own demo issuer, not Ripple's RLUSD. */
export const DEMO_RLUSD: AssetDef = {
  code: 'RLUSD',
  kind: 'IOU',
  currency: '524C555344000000000000000000000000000000',
  decimals: 6,
}

/**
 * `policies/procurement@1.3.0.json` params.approvalThreshold.
 * A payment at or above this needs approval.payment/1. The first demo invoice stays under it.
 */
export const PROCUREMENT_APPROVAL_THRESHOLD = '1000.00'

/** Under PROCUREMENT_APPROVAL_THRESHOLD. The amount eng open puts on the first demo invoice. */
export const DEMO_INVOICE_AMOUNT = '800.00'

/** invoiceRef on the invoice eng open prints for the agent. */
export const DEMO_INVOICE_REF = 'inv:open-001'

export const DEMO_INVOICE_TTL_MS = 24 * 60 * 60 * 1000

export interface InvoiceSigner {
  address?: string
  classicAddress?: string
  publicKey: string
  privateKey: string
}

export interface VendorInvoiceInput {
  engagementId: string
  vendorAddress: string
  amount: string
  invoiceRef: string
  observedAt: string
  issuedAt: string
  nonce: string
  /** Statement validUntil. Omit it only for fixtures that predate the expiry field. */
  validUntil?: string
  po?: string
}

export function vendorInvoiceBody(input: VendorInvoiceInput): StatementBody {
  const body: StatementBody = {
    v: 'eng.att/1',
    observedAt: input.observedAt,
    issuedAt: input.issuedAt,
    nonce: input.nonce,
    attester: { account: input.vendorAddress, kind: 'VENDOR' },
    type: 'party.invoice/1',
    engagementId: input.engagementId,
    subject: { invoiceRef: input.invoiceRef },
    claim: {
      invoiceRef: input.invoiceRef,
      amount: input.amount,
      currency: 'RLUSD',
      po: input.po ?? 'PO-7731',
    },
  }
  if (input.validUntil !== undefined) body.validUntil = input.validUntil
  return body
}

/** Sign a party.invoice/1. The signer must be the vendor; the address is the attester. */
export function signVendorInvoice(input: VendorInvoiceInput, signer: InvoiceSigner): Statement {
  const address = signer.address ?? signer.classicAddress
  if (address && address !== input.vendorAddress) {
    throw new Error('refusing to invoice: vendor address does not match the signing key')
  }
  return signStatement(vendorInvoiceBody(input), signer)
}

/** Build a party.invoice/1, drawing a nonce when the caller does not pin one. */
export function issueVendorInvoice(input: Omit<VendorInvoiceInput, 'nonce'> & { nonce?: string }, signer: InvoiceSigner): Statement {
  return signVendorInvoice({ ...input, nonce: input.nonce ?? newNonce() }, signer)
}

/**
 * The demo invoice has to clear W6 on its own. At or above the approval threshold, W5 also
 * demands an approval statement, which this helper does not issue.
 */
export function assertInvoiceAmountUnderCap(amount: string): void {
  let value
  try {
    value = parseAmount(amount, DEMO_RLUSD)
  } catch {
    throw new Error(`refusing to invoice: amount ${JSON.stringify(amount)} is not a 6-decimal RLUSD amount`)
  }
  if (value.minor <= 0n) throw new Error('refusing to invoice: amount must be greater than zero')
  const cap = parseAmount(PROCUREMENT_APPROVAL_THRESHOLD, DEMO_RLUSD)
  if (value.cmp(cap) >= 0) {
    throw new Error(`refusing to invoice: amount ${amount} is not under the approval threshold ${PROCUREMENT_APPROVAL_THRESHOLD}`)
  }
}

/** Keep a caller-supplied expiry when it parses and is strictly after `now`. */
export function assertInvoiceExpiry(expires: string, now: Date): string {
  const text = expires.trim()
  const t = Date.parse(text)
  if (!text || Number.isNaN(t)) throw new Error('refusing to invoice: expires is not an ISO-8601 time')
  if (t <= now.getTime()) throw new Error('refusing to invoice: expires is not in the future')
  return text
}
