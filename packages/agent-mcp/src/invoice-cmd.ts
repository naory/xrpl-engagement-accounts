// `eng invoice` — sign one party.invoice/1 with the vendor seed file.
// The seed is read and never printed. Stdout is the invoice JSON.
import fs from 'node:fs'
import xrpl from 'xrpl'
import {
  assertInvoiceAmountUnderCap, assertInvoiceExpiry, issueVendorInvoice,
  type Statement,
} from '@eng/core'

export const INVOICE_HELP = `eng invoice — sign a Testnet party.invoice/1 for pay_vendor

TESTNET ONLY. The vendor seed file is read and never printed.
An agent that holds the vendor seed can forge invoices and defeat W6, so the seed stays out of the agent env and the MCP config.
The invoice itself is not a secret: it is bound to this engagement id and the vendor address, for an amount under the approval threshold (1000.00), with an expiry.

Usage:
  npm run eng -- invoice --vendor-seed-file <path> --engagement-id <id> --amount <decimal> --expires <ISO-8601> [--invoice-ref <ref>] [--po <text>]

--vendor-seed-file   One-line vendor seed. The address is derived from it.
--engagement-id      Engagement the invoice is bound to.
--amount             Decimal RLUSD amount, greater than zero and under 1000.00.
--expires            validUntil. Must be in the future.
--invoice-ref        Memo ref pay_vendor sends as eng/invoice. Default: inv:open-001
--po                 Claim po. Default: PO-OPEN
`

const DEFAULT_REF = 'inv:open-001'
const DEFAULT_PO = 'PO-OPEN'

export interface InvoiceFlags {
  help: boolean
  vendorSeedFile: string | null
  engagementId: string | null
  amount: string | null
  expires: string | null
  invoiceRef: string | null
  po: string | null
}

export function parseInvoiceArgs(argv: string[]): InvoiceFlags {
  const flags: InvoiceFlags = {
    help: false, vendorSeedFile: null, engagementId: null, amount: null, expires: null, invoiceRef: null, po: null,
  }
  const rest = [...argv]
  const take = (name: string): string => {
    const value = rest.shift()
    if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`)
    return value
  }
  while (rest.length) {
    const arg = rest.shift()!
    if (arg === '--help' || arg === '-h') flags.help = true
    else if (arg === '--vendor-seed-file') flags.vendorSeedFile = take('--vendor-seed-file')
    else if (arg === '--engagement-id') flags.engagementId = take('--engagement-id')
    else if (arg === '--amount') flags.amount = take('--amount')
    else if (arg === '--expires') flags.expires = take('--expires')
    else if (arg === '--invoice-ref') flags.invoiceRef = take('--invoice-ref')
    else if (arg === '--po') flags.po = take('--po')
    else throw new Error(`unknown argument ${arg}`)
  }
  return flags
}

/** One line. The thrown message names the path and does not include the file contents. */
export function readVendorSeedFile(filePath: string, readFile: (file: string) => string = (file) => fs.readFileSync(file, 'utf8')): string {
  let text: string
  try {
    text = readFile(filePath)
  } catch {
    throw new Error(`vendor seed file is not readable: ${filePath}`)
  }
  const seed = text.trim()
  if (!seed || /[\r\n]/.test(seed)) throw new Error(`--vendor-seed-file must be one line: ${filePath}`)
  return seed
}

function walletFromSeed(seed: string): InstanceType<typeof xrpl.Wallet> {
  try {
    return xrpl.Wallet.fromSeed(seed)
  } catch {
    throw new Error('vendor seed file does not contain a valid seed')
  }
}

export function isoNoMillis(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function buildInvoiceFromSeed(opts: {
  seed: string
  engagementId: string
  amount: string
  expires: string
  invoiceRef: string
  po: string
  now: Date
}): Statement {
  assertInvoiceAmountUnderCap(opts.amount)
  const validUntil = assertInvoiceExpiry(opts.expires, opts.now)
  const vendor = walletFromSeed(opts.seed)
  const issued = isoNoMillis(opts.now)
  return issueVendorInvoice({
    engagementId: opts.engagementId,
    vendorAddress: vendor.address,
    amount: opts.amount,
    invoiceRef: opts.invoiceRef,
    observedAt: issued,
    issuedAt: issued,
    validUntil,
    po: opts.po,
  }, vendor)
}

export interface InvoiceIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
  readFile: (file: string) => string
  now: () => Date
}

export function runInvoice(argv: string[], io: InvoiceIo): number {
  const flags = parseInvoiceArgs(argv)
  if (flags.help) {
    io.stdout(INVOICE_HELP.endsWith('\n') ? INVOICE_HELP : `${INVOICE_HELP}\n`)
    return 0
  }
  if (!flags.vendorSeedFile) throw new Error('--vendor-seed-file is required')
  if (!flags.engagementId) throw new Error('--engagement-id is required')
  if (!flags.amount) throw new Error('--amount is required')
  if (!flags.expires) throw new Error('--expires is required')
  const seed = readVendorSeedFile(flags.vendorSeedFile, io.readFile)
  const invoice = buildInvoiceFromSeed({
    seed,
    engagementId: flags.engagementId,
    amount: flags.amount,
    expires: flags.expires,
    invoiceRef: flags.invoiceRef ?? DEFAULT_REF,
    po: flags.po ?? DEFAULT_PO,
    now: io.now(),
  })
  const text = `${JSON.stringify(invoice, null, 2)}\n`
  if (text.includes(seed)) throw new Error('refusing to print: invoice output contains the vendor seed')
  io.stderr('TESTNET ONLY. The vendor seed was read and was not printed.\n')
  io.stdout(text)
  return 0
}
