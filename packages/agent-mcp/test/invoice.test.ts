import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import { verifyStatement } from '@eng/core'
import { runEng, type EngIo } from '../src/eng-cli.ts'
import { INVOICE_HELP } from '../src/invoice-cmd.ts'

function io(readFile: (file: string) => string, now = new Date('2026-01-01T00:00:00Z')): EngIo & { out: string; err: string } {
  const state = { out: '', err: '' }
  const base: EngIo = {
    env: {},
    cwd: process.cwd(),
    stdout: (text) => { state.out += text },
    stderr: (text) => { state.err += text },
    readFile,
    fetch: async () => { throw new Error('invoice does not fetch') },
    sleep: async () => {},
    provision: async () => { throw new Error('invoice does not provision') },
    now: () => now,
  }
  const view = base as EngIo & { out: string; err: string }
  Object.defineProperty(view, 'out', { get: () => state.out })
  Object.defineProperty(view, 'err', { get: () => state.err })
  return view
}

describe('eng invoice', () => {
  it('prints TESTNET ONLY help and does not require a seed', async () => {
    const deps = io(() => { throw new Error('help reads no file') })
    expect(await runEng(['invoice', '--help'], deps)).toBe(0)
    expect(deps.out).toBe(INVOICE_HELP.endsWith('\n') ? INVOICE_HELP : `${INVOICE_HELP}\n`)
    expect(deps.out).toContain('TESTNET ONLY')
    expect(deps.out).toContain('--vendor-seed-file')
    expect(deps.out).toContain('defeat W6')
    expect(deps.err).toBe('')
  })

  it('prints the invoice JSON and keeps the vendor seed off stdout', async () => {
    const vendor = xrpl.Wallet.generate()
    const file = path.join(os.tmpdir(), `vendor-seed-${process.pid}.txt`)
    fs.writeFileSync(file, `${vendor.seed}\n`, { mode: 0o600 })
    try {
      const deps = io((p) => {
        if (p !== file) throw new Error(`unexpected read ${p}`)
        return fs.readFileSync(p, 'utf8')
      })
      expect(await runEng([
        'invoice', '--vendor-seed-file', file, '--engagement-id', 'eng_cli',
        '--amount', '800.00', '--expires', '2026-01-02T00:00:00Z', '--invoice-ref', 'inv:cli-001',
      ], deps)).toBe(0)
      expect(deps.out).not.toContain(vendor.seed)
      expect(deps.err).toContain('TESTNET ONLY')
      expect(deps.err).toContain('was not printed')
      const invoice = JSON.parse(deps.out) as { engagementId: string; validUntil: string; attester: { account: string }; claim: { amount: string; invoiceRef: string } }
      expect(verifyStatement(invoice as never).ok).toBe(true)
      expect(invoice.engagementId).toBe('eng_cli')
      expect(invoice.attester.account).toBe(vendor.address)
      expect(invoice.claim.amount).toBe('800.00')
      expect(invoice.claim.invoiceRef).toBe('inv:cli-001')
      expect(invoice.validUntil).toBe('2026-01-02T00:00:00Z')
    } finally {
      fs.rmSync(file, { force: true })
    }
  })

  it('refuses an amount at the cap, and a bad seed file does not echo the contents', async () => {
    const file = path.join(os.tmpdir(), `vendor-seed-bad-${process.pid}.txt`)
    fs.writeFileSync(file, 'not-a-seed-value\n', { mode: 0o600 })
    try {
      const over = io((p) => fs.readFileSync(p, 'utf8'))
      await expect(runEng([
        'invoice', '--vendor-seed-file', file, '--engagement-id', 'eng_cli',
        '--amount', '1000.00', '--expires', '2026-01-02T00:00:00Z',
      ], over)).rejects.toThrow(/not under the approval threshold/)
      expect(over.out).toBe('')
      const bad = io((p) => fs.readFileSync(p, 'utf8'))
      await expect(runEng([
        'invoice', '--vendor-seed-file', file, '--engagement-id', 'eng_cli',
        '--amount', '800.00', '--expires', '2026-01-02T00:00:00Z',
      ], bad)).rejects.toThrow('vendor seed file does not contain a valid seed')
      expect(bad.out).toBe('')
      expect(`${bad.err}${bad.out}`).not.toContain('not-a-seed-value')
    } finally {
      fs.rmSync(file, { force: true })
    }
  })
})
