import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import * as keypairs from 'ripple-keypairs'
import { encodeForMultisigning } from 'ripple-binary-codec'
import { verifyStatement, localSigner, type Statement } from '@eng/core'
import { CosignerService, FixtureLedgerSource, createServer } from '@eng/cosigner'
import { W, LEDGER_INDEX, b1Approval, b1Engagement, b1Invoice, b1Ledger, b1Mandate, b1Payment, historyEntry, policies, templates } from '../../policy/test/fixtures.ts'
import { Assets, TxFacts } from '@eng/policy'

function setup(ledger = b1Ledger(), dataDir?: string) {
  const source = new FixtureLedgerSource(ledger)
  const svc = new CosignerService({ signer: localSigner(W.cosigner), source, templates: [templates.procurement, templates.hotel], policies: [policies.baseline, policies.procurement, policies.hotel], dataDir })
  svc.register(b1Engagement(), b1Mandate())
  return { svc, source }
}
const pay = (value: string, seq: number, invoice = 'inv:2026-Q4-0042', to = W.vendorA.address) => ({ ...b1Payment(to, value, { invoice }), Sequence: seq })
const intent = (tx: Record<string, unknown>) =>
  new TxFacts(tx, { eng: b1Engagement(), template: templates.procurement, assets: new Assets(policies.procurement.assets!), ledger: b1Ledger() }).intentHash()

describe('co-signer service', () => {
  it('signs exactly the evaluated transaction; the signature combines with the agent’s into a quorum blob', async () => {
    const { svc } = setup()
    const tx = pay('800', 21)
    const agentBlob = W.agent.sign(structuredClone(tx) as never, true).tx_blob
    const r = await svc.decide({ engagementId: 'eng_b1_fixture', stage: 'spend', txBlob: agentBlob, statements: [b1Invoice()] })
    expect(r.decision).toBe('SIGN')
    expect(r.signerBlob).toBeDefined()
    const combined = xrpl.decode(xrpl.multisign([agentBlob, r.signerBlob!])) as { Signers: Array<{ Signer: { Account: string } }> }
    expect(combined.Signers.map((s) => s.Signer.Account).sort()).toEqual([W.agent.address, W.cosigner.address].sort())
    // The co-signer's signature is valid over the multisigning payload of the evaluated transaction.
    const signed = xrpl.decode(r.signerBlob!) as Record<string, unknown> & { Signers: Array<{ Signer: { Account: string; SigningPubKey: string; TxnSignature: string } }> }
    const { Signers, ...body } = signed
    expect(body).toEqual(r.tx)
    const s = Signers[0].Signer
    expect(keypairs.verify(encodeForMultisigning(body as never, s.Account), s.TxnSignature, s.SigningPubKey)).toBe(true)
    expect(verifyStatement(r.record).ok).toBe(true)
    expect(r.record.claim.decision).toBe('SIGN')
  })

  it('refuses without signing and still records the decision', async () => {
    const { svc } = setup()
    const r = await svc.decide({ engagementId: 'eng_b1_fixture', stage: 'spend', tx: pay('800', 21, 'inv:2026-Q4-0042', W.stranger.address), statements: [b1Invoice()] })
    expect(r.decision).toBe('REFUSE')
    expect(r.signerBlob).toBeUndefined()
    expect(svc.decisions('eng_b1_fixture')).toHaveLength(1)
    expect(svc.inflightFor('eng_b1_fixture')).toHaveLength(0)
  })

  it('counts its own in-flight signatures against the daily cap until they validate or expire', async () => {
    const { svc, source } = setup(b1Ledger({ history: [historyEntry('9000', '2026-11-18T02:00:00Z')] }))
    const inv = (v: string, ref: string) => b1Invoice(W.vendorA, v, ref)
    const a = await svc.decide({ engagementId: 'eng_b1_fixture', stage: 'spend', tx: pay('600', 21, 'inv:A'), statements: [inv('600.00', 'inv:A')] })
    expect(a.decision).toBe('SIGN')
    const b = await svc.decide({ engagementId: 'eng_b1_fixture', stage: 'spend', tx: pay('600', 22, 'inv:B'), statements: [inv('600.00', 'inv:B')] })
    expect(b.failing).toEqual(['W3']) // 9000 + 600 in flight + 600 > 10000
    // The first payment validates: sequence advances, history shows it.
    source.snap.accounts[W.engB1.address].sequence = 22
    source.snap.history[W.engB1.address].push({ ...historyEntry('600', '2026-11-18T09:33:00Z'), sequence: 21 })
    const c = await svc.decide({ engagementId: 'eng_b1_fixture', stage: 'spend', tx: pay('400', 22, 'inv:C'), statements: [inv('400.00', 'inv:C')] })
    expect(c.decision).toBe('SIGN') // 9600 validated + 400 = 10000 ≤ cap
    expect(svc.inflightFor('eng_b1_fixture').map((i) => i.outer.sequence)).toEqual([22])
  })

  it('serialises concurrent requests per engagement (no double-spend of the cap)', async () => {
    const { svc } = setup(b1Ledger({ history: [historyEntry('9000', '2026-11-18T02:00:00Z')] }))
    const [x, y] = await Promise.all([
      svc.decide({ engagementId: 'eng_b1_fixture', stage: 'spend', tx: pay('600', 21, 'inv:A'), statements: [b1Invoice(W.vendorA, '600.00', 'inv:A')] }),
      svc.decide({ engagementId: 'eng_b1_fixture', stage: 'spend', tx: pay('600', 22, 'inv:B'), statements: [b1Invoice(W.vendorA, '600.00', 'inv:B')] }),
    ])
    expect([x.decision, y.decision].sort()).toEqual(['REFUSE', 'SIGN'])
  })

  it('is idempotent for a re-request of the same transaction', async () => {
    const { svc } = setup(b1Ledger({ history: [historyEntry('9000', '2026-11-18T02:00:00Z')] }))
    const req = { engagementId: 'eng_b1_fixture', stage: 'spend', tx: pay('600', 21, 'inv:A'), statements: [b1Invoice(W.vendorA, '600.00', 'inv:A')] }
    expect((await svc.decide(req)).decision).toBe('SIGN')
    expect((await svc.decide(req)).decision).toBe('SIGN')
    expect(svc.inflightFor('eng_b1_fixture')).toHaveLength(1)
  })

  it('reserves a single-use approval while in flight; releases it on expiry; consumes it on success', async () => {
    const { svc, source } = setup()
    const tx1 = pay('1500', 21)
    const appr = b1Approval(intent(tx1))
    const invoice = b1Invoice(W.vendorA, '1500.00')
    const r1 = await svc.decide({ engagementId: 'eng_b1_fixture', stage: 'spend', tx: tx1, statements: [invoice, appr] })
    expect(r1.decision).toBe('SIGN')
    // Same intent, different sequence: the approval is reserved by the first decision.
    const tx2 = pay('1500', 22)
    const r2 = await svc.decide({ engagementId: 'eng_b1_fixture', stage: 'spend', tx: tx2, statements: [invoice, appr] })
    expect(r2.decision).toBe('REFUSE')
    expect(r2.statementsRejected.map((s) => s.code)).toEqual(['CONSUMED', 'CONSUMED'])
    // tx1 expires unsubmitted (ledger passes its LastLedgerSequence): reservations are released.
    source.snap.index = LEDGER_INDEX + 25
    const tx3 = { ...pay('1500', 21), LastLedgerSequence: LEDGER_INDEX + 45 }
    const r3 = await svc.decide({ engagementId: 'eng_b1_fixture', stage: 'spend', tx: tx3, statements: [invoice, appr] })
    expect(r3.decision).toBe('SIGN')
    // tx3 validates → the approval and invoice are consumed for good.
    source.snap.accounts[W.engB1.address].sequence = 22
    source.snap.history[W.engB1.address].push({ ...historyEntry('1500', '2026-11-18T09:33:05Z'), sequence: 21 })
    const r4 = await svc.decide({ engagementId: 'eng_b1_fixture', stage: 'spend', tx: { ...tx2, LastLedgerSequence: LEDGER_INDEX + 45 }, statements: [invoice, appr] })
    expect(r4.decision).toBe('REFUSE')
    expect(svc.engagement('eng_b1_fixture')!.consumed).toEqual(expect.arrayContaining([appr.id, invoice.id]))
  })

  it('writes an append-only, individually verifiable decision log', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosigner-'))
    const { svc } = setup(b1Ledger(), dir)
    await svc.decide({ engagementId: 'eng_b1_fixture', stage: 'spend', tx: pay('800', 21), statements: [b1Invoice()] })
    await svc.decide({ engagementId: 'eng_b1_fixture', stage: 'spend', tx: pay('800', 22, 'inv:X', W.stranger.address), statements: [] })
    const lines = fs.readFileSync(path.join(dir, 'decisions.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Statement)
    expect(lines.map((l) => l.claim.decision)).toEqual(['SIGN', 'REFUSE'])
    expect(lines.every((l) => verifyStatement(l).ok)).toBe(true)
  })

  it('evaluates but does not sign advisory stages (owner close)', async () => {
    const { svc } = setup()
    const eng = W.engB1.address
    const inner = (t: Record<string, unknown>, seq: number) => ({ RawTransaction: { ...t, Fee: '0', SigningPubKey: '', Sequence: seq, Flags: (Number(t.Flags ?? 0) | 0x40000000) >>> 0 } })
    const iouAmt = (v: string) => ({ currency: '524C555344000000000000000000000000000000', issuer: W.issuer.address, value: v })
    const close = {
      TransactionType: 'Batch', Account: eng, Flags: 0x00010000, Fee: '200075', Sequence: 30, LastLedgerSequence: LEDGER_INDEX + 20, SigningPubKey: '',
      RawTransactions: [
        inner({ TransactionType: 'Payment', Account: eng, Destination: W.treasury.address, Amount: iouAmt('1000000000'), Flags: 0x00020000 }, 31),
        inner({ TransactionType: 'TrustSet', Account: eng, LimitAmount: iouAmt('0'), Flags: 0x00020000 }, 32),
        inner({ TransactionType: 'AccountDelete', Account: eng, Destination: W.service.address }, 33),
      ],
      Memos: [{ Memo: { MemoType: Buffer.from('eng/basis').toString('hex').toUpperCase(), MemoData: Buffer.from('owner.close').toString('hex').toUpperCase() } }],
    }
    const svc2 = new CosignerService({ signer: localSigner(W.cosigner), source: new FixtureLedgerSource(b1Ledger()), templates: [templates.procurement], policies: [policies.baseline, policies.procurement] })
    svc2.register(b1Engagement({ deleteTo: W.service.address }), b1Mandate())
    const r = await svc2.decide({ engagementId: 'eng_b1_fixture', stage: 'close.owner', tx: close })
    expect(r.failing).toEqual([])
    expect(r.decision).toBe('SIGN')
    expect(r.advisory).toBe(true)
    expect(r.signerBlob).toBeUndefined()
    expect(svc2.inflightFor('eng_b1_fixture')).toHaveLength(0)
    void svc
  })

  it('rejects engagements naming another co-signer or an unknown template', () => {
    const { svc } = setup()
    expect(() => svc.register(b1Engagement({ engagementId: 'x', parties: { ...b1Engagement().parties, cosigner: W.agent.address } }))).toThrow(/different co-signer/)
    expect(() => svc.register(b1Engagement({ engagementId: 'y', template: 'nope@1' }))).toThrow(/unknown template/)
  })

  it('serves the same decisions over HTTP', async () => {
    const { svc } = setup()
    const server = createServer(svc).listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const r = await fetch(`${base}/v1/decide`, { method: 'POST', body: JSON.stringify({ engagementId: 'eng_b1_fixture', stage: 'spend', tx: pay('800', 21), statements: [b1Invoice()] }) })
      const d = (await r.json()) as { decision: string; signerBlob?: string }
      expect(d.decision).toBe('SIGN')
      expect(d.signerBlob).toMatch(/^[0-9A-F]+$/)
      const log = (await (await fetch(`${base}/v1/engagements/eng_b1_fixture/decisions`)).json()) as Statement[]
      expect(log).toHaveLength(1)
      const bad = await fetch(`${base}/v1/decide`, { method: 'POST', body: JSON.stringify({ engagementId: 'nope', stage: 'spend' }) })
      expect(bad.status).toBe(400)
    } finally {
      server.close()
    }
  })
})
