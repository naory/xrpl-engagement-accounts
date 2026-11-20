import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import { verifyStatement } from '@eng/core'
import {
  DEMO_INVOICE_AMOUNT, DEMO_INVOICE_REF, PROCUREMENT_APPROVAL_THRESHOLD,
  assertInvoiceAmountUnderCap, assertInvoiceExpiry, issueVendorInvoice, signVendorInvoice,
} from '../src/invoice.ts'

const root = new URL('../../../', import.meta.url)

describe('vendor invoice', () => {
  it('binds the engagement, the vendor address, the amount, and the expiry', () => {
    const vendor = xrpl.Wallet.generate()
    const invoice = signVendorInvoice({
      engagementId: 'eng_demo',
      vendorAddress: vendor.address,
      amount: DEMO_INVOICE_AMOUNT,
      invoiceRef: DEMO_INVOICE_REF,
      observedAt: '2026-01-01T00:00:00Z',
      issuedAt: '2026-01-01T00:00:00Z',
      validUntil: '2026-01-02T00:00:00Z',
      nonce: 'abc',
      po: 'PO-OPEN',
    }, vendor)
    expect(verifyStatement(invoice).ok).toBe(true)
    expect(invoice.type).toBe('party.invoice/1')
    expect(invoice.engagementId).toBe('eng_demo')
    expect(invoice.attester).toEqual({ account: vendor.address, kind: 'VENDOR' })
    expect(invoice.claim).toMatchObject({ amount: '800.00', invoiceRef: DEMO_INVOICE_REF, currency: 'RLUSD' })
    expect(invoice.validUntil).toBe('2026-01-02T00:00:00Z')
    expect(JSON.stringify(invoice)).not.toContain(vendor.seed!)
  })

  it('refuses an amount at the approval threshold and an expiry that is not in the future', () => {
    expect(assertInvoiceAmountUnderCap('800.00')).toBeUndefined()
    expect(assertInvoiceAmountUnderCap('999.999999')).toBeUndefined()
    expect(() => assertInvoiceAmountUnderCap(PROCUREMENT_APPROVAL_THRESHOLD)).toThrow(/not under the approval threshold/)
    expect(() => assertInvoiceAmountUnderCap('0')).toThrow(/greater than zero/)
    expect(() => assertInvoiceAmountUnderCap('nope')).toThrow(/not a 6-decimal/)
    const now = new Date('2026-01-01T00:00:00Z')
    expect(assertInvoiceExpiry('2026-01-02T00:00:00Z', now)).toBe('2026-01-02T00:00:00.000Z')
    expect(assertInvoiceExpiry('2026-01-02T05:00:00+05:00', now)).toBe('2026-01-02T00:00:00.000Z')
    expect(() => assertInvoiceExpiry('2026-01-01T00:00:00Z', now)).toThrow(/not in the future/)
    expect(() => assertInvoiceExpiry('tomorrow', now)).toThrow(/full ISO-8601 time with a zone/)
    // Date.parse('2027') used to succeed and the literal "2027" was stored as validUntil.
    expect(() => assertInvoiceExpiry('2027', now)).toThrow(/full ISO-8601 time with a zone/)
    expect(() => assertInvoiceExpiry('2026-01-02', now)).toThrow(/full ISO-8601 time with a zone/)
    expect(() => assertInvoiceExpiry('2026-02-31T00:00:00Z', now)).toThrow(/full ISO-8601 time with a zone/)
    expect(() => assertInvoiceExpiry('9999-12-31T00:00:00Z', now)).toThrow(/after 2026-01-08T00:00:00.000Z/)
    expect(() => assertInvoiceExpiry('2026-01-05T00:00:00Z', now, '2026-01-03T00:00:00Z')).toThrow(/after 2026-01-03T00:00:00.000Z/)
    expect(assertInvoiceExpiry('2026-01-02T00:00:00Z', now, '2026-01-03T00:00:00Z')).toBe('2026-01-02T00:00:00.000Z')
  })

  it('matches the shipped procurement approval threshold', () => {
    const policy = JSON.parse(fs.readFileSync(new URL('policies/procurement@1.3.0.json', root), 'utf8')) as { params: { approvalThreshold: string } }
    expect(policy.params.approvalThreshold).toBe(PROCUREMENT_APPROVAL_THRESHOLD)
  })

  it('refuses a vendor address that is not the signing key', () => {
    const vendor = xrpl.Wallet.generate()
    const other = xrpl.Wallet.generate()
    expect(() => issueVendorInvoice({
      engagementId: 'eng_demo',
      vendorAddress: other.address,
      amount: '800.00',
      invoiceRef: 'inv:x',
      observedAt: '2026-01-01T00:00:00Z',
      issuedAt: '2026-01-01T00:00:00Z',
      nonce: 'n',
    }, vendor)).toThrow(/does not match the signing key/)
  })
})

describe('seed file path stays out of the statement', () => {
  it('does not embed the seed file path', () => {
    const vendor = xrpl.Wallet.generate()
    const file = path.join('/tmp', 'vendor.seed')
    const invoice = issueVendorInvoice({
      engagementId: 'eng_demo',
      vendorAddress: vendor.address,
      amount: '1.00',
      invoiceRef: 'inv:x',
      observedAt: '2026-01-01T00:00:00Z',
      issuedAt: '2026-01-01T00:00:00Z',
      nonce: 'n',
    }, vendor)
    expect(JSON.stringify(invoice)).not.toContain(file)
    expect(JSON.stringify(invoice)).not.toContain(vendor.seed!)
  })
})
