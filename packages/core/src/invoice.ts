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

/** Hard ceiling on `validUntil`. A mandate that ends sooner tightens this. */
export const INVOICE_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Full ISO-8601 date-time with a zone. Bare years (`2027`), dates without a time,
 * and offsets without a colon are rejected. Fractional seconds are 1–3 digits.
 */
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/

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

function parseStrictIso(text: string, label: string): Date {
  const m = ISO_TIME.exec(text.trim())
  if (!m) throw new Error(`refusing to invoice: ${label} must be a full ISO-8601 time with a zone`)
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hour = Number(m[4])
  const minute = Number(m[5])
  const second = Number(m[6])
  const ms = Number((m[7] ?? '').padEnd(3, '0') || '0')
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    throw new Error(`refusing to invoice: ${label} must be a full ISO-8601 time with a zone`)
  }
  let offsetMin = 0
  if (m[8] !== 'Z') {
    const sign = m[8]!.startsWith('+') ? 1 : -1
    const oh = Number(m[9])
    const om = Number(m[10])
    if (oh > 23 || om > 59) throw new Error(`refusing to invoice: ${label} must be a full ISO-8601 time with a zone`)
    offsetMin = sign * (oh * 60 + om)
  }
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMin * 60_000
  const shifted = new Date(utc + offsetMin * 60_000)
  if (
    shifted.getUTCFullYear() !== year
    || shifted.getUTCMonth() !== month - 1
    || shifted.getUTCDate() !== day
    || shifted.getUTCHours() !== hour
    || shifted.getUTCMinutes() !== minute
    || shifted.getUTCSeconds() !== second
  ) {
    throw new Error(`refusing to invoice: ${label} must be a full ISO-8601 time with a zone`)
  }
  return new Date(utc)
}

/**
 * The latest `validUntil` this helper will sign: the earlier of the mandate expiry
 * (when the caller supplies one) and `now` plus 7 days.
 */
export function invoiceExpiryCap(now: Date, mandateExpires?: string): Date {
  const week = new Date(now.getTime() + INVOICE_MAX_TTL_MS)
  if (!mandateExpires) return week
  const mandate = parseStrictIso(mandateExpires, 'mandate expiry')
  return mandate.getTime() < week.getTime() ? mandate : week
}

/**
 * Parse `expires`, require it to be strictly after `now`, and return `Date.toISOString()`.
 *
 * Over-cap values are rejected, not clamped. Clamping would store a shorter expiry than
 * the caller asked for and still exit 0. A bare year such as `2027` used to pass
 * `Date.parse` and was stored as the literal `"2027"`.
 */
export function assertInvoiceExpiry(expires: string, now: Date, mandateExpires?: string): string {
  const at = parseStrictIso(expires, 'expires')
  if (at.getTime() <= now.getTime()) throw new Error('refusing to invoice: expires is not in the future')
  const cap = invoiceExpiryCap(now, mandateExpires)
  if (at.getTime() > cap.getTime()) {
    throw new Error(`refusing to invoice: expires is after ${cap.toISOString()} (the earlier of the mandate expiry and 7 days from now)`)
  }
  return at.toISOString()
}
