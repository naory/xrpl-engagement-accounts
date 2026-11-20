import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import { currencyHex, type Fees, type SubmitResult } from '@eng/ledger'
import { CosignerService, FixtureLedgerSource, createServer } from '@eng/cosigner'
import { issueVendorInvoice, localSigner, signStatement, vendorInvoiceBody, type Statement } from '@eng/core'
import { W, LEDGER_INDEX, b1Engagement, b1Invoice, b1Mandate, b1Ledger, policies, templates } from '../../policy/test/fixtures.ts'
import { EngagementAgent, type Chain } from '../src/agent.ts'
import { CosignerClient } from '../src/client.ts'

const ENG = 'eng_b1_fixture'
const ASSET = { code: 'RLUSD', currency: currencyHex('RLUSD'), issuer: W.issuer.address }

/** A fresh in-process co-signer registered on the B1 fixture engagement. */
async function service(ledger = b1Ledger()): Promise<CosignerService> {
  const svc = new CosignerService({ signer: localSigner(W.cosigner), source: new FixtureLedgerSource(ledger), templates: [templates.procurement, templates.hotel], policies: [policies.baseline, policies.procurement, policies.hotel] })
  await svc.register(b1Engagement(), b1Mandate())
  return svc
}

/** A chain that never touches the network: fixed fees/ledger, records every submitted blob. */
class FakeChain implements Chain {
  readonly submitted: string[] = []
  constructor(private readonly seq = 21) {}
  async fees(): Promise<Fees> { return { base: 10, reserveBase: 1_000_000, inc: 200_000 } }
  async currentLedger(): Promise<number> { return LEDGER_INDEX }
  async accountSequence(): Promise<number> { return this.seq }
  async submit(blob: string): Promise<SubmitResult> {
    this.submitted.push(blob)
    return { hash: xrpl.hashes.hashSignedTx(blob), prelim: 'tesSUCCESS', final: 'tesSUCCESS', validated: true, ledger: LEDGER_INDEX }
  }
}

const agentFor = (svc: CosignerService, chain?: Chain) =>
  new EngagementAgent({ engagementId: ENG, account: W.engB1.address, signer: localSigner(W.agent), asset: ASSET, decider: svc, chain })

describe('engagement agent', () => {
  it('proposes an in-policy payment: the co-signer SIGNs and the two signatures combine into a quorum blob', async () => {
    const agent = agentFor(await service(), new FakeChain(21))
    const p = await agent.proposePayment({ destination: W.vendorA.address, amount: '800.00', invoiceRef: 'inv:2026-Q4-0042', statements: [b1Invoice()] })
    expect(p.decision.decision).toBe('SIGN')
    expect(p.combined).toBeDefined()
    // The combined blob carries exactly the agent's and the co-signer's signatures (quorum 2).
    const decoded = xrpl.decode(p.combined!) as { Signers: Array<{ Signer: { Account: string } }> }
    expect(decoded.Signers.map((s) => s.Signer.Account).sort()).toEqual([W.agent.address, W.cosigner.address].sort())
    // The agent built the live sequence + deadline off the chain.
    expect(p.tx.Sequence).toBe(21)
    expect(p.tx.LastLedgerSequence).toBe(LEDGER_INDEX + 20)
  })

  it('refuses an out-of-mandate payee without producing a quorum blob', async () => {
    const agent = agentFor(await service(), new FakeChain())
    const p = await agent.proposePayment({ destination: W.stranger.address, amount: '100.00', invoiceRef: 'inv:X', statements: [b1Invoice(W.stranger, '100.00', 'inv:X')] })
    expect(p.decision.decision).toBe('REFUSE')
    expect(p.combined).toBeUndefined()
  })

  it('payVendor settles a signed payment, broadcasting exactly the quorum blob', async () => {
    const chain = new FakeChain(21)
    const { proposal, submit } = await agentFor(await service(), chain).payVendor({ destination: W.vendorA.address, amount: '800.00', invoiceRef: 'inv:2026-Q4-0042', statements: [b1Invoice()] })
    expect(proposal.decision.decision).toBe('SIGN')
    expect(submit?.final).toBe('tesSUCCESS')
    expect(chain.submitted).toEqual([proposal.combined])
  })

  it('payVendor does not broadcast when the co-signer refuses', async () => {
    const chain = new FakeChain()
    const { proposal, submit } = await agentFor(await service(), chain).payVendor({ destination: W.stranger.address, amount: '100.00', statements: [] })
    expect(proposal.decision.decision).toBe('REFUSE')
    expect(submit).toBeUndefined()
    expect(chain.submitted).toEqual([])
  })

  it('submit requires a chain', async () => {
    await expect(agentFor(await service()).submit('DEADBEEF')).rejects.toThrow(/requires a chain/)
  })

  it('drives a remote co-signer over HTTP through CosignerClient (same Decider seam)', async () => {
    const svc = await service()
    const server = createServer(svc).listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const client = new CosignerClient({ baseUrl: base })
      const agent = new EngagementAgent({ engagementId: ENG, account: W.engB1.address, signer: localSigner(W.agent), asset: ASSET, decider: client })
      const p = await agent.proposePayment({ destination: W.vendorA.address, amount: '800.00', invoiceRef: 'inv:2026-Q4-0042', sequence: 21, lastLedgerSequence: LEDGER_INDEX + 20, statements: [b1Invoice()] })
      expect(p.decision.decision).toBe('SIGN')
      expect(p.combined).toBeDefined()
      const view = await client.engagement(ENG)
      expect(view.engagement.engagementId).toBe(ENG)
      expect((await client.decisions(ENG)).length).toBeGreaterThanOrEqual(1)
    } finally { server.close() }
  })

  it('payVendor refuses W6 without an invoice, then settles with the demo invoice', async () => {
    const chain = new FakeChain(21)
    const agent = agentFor(await service(), chain)
    const refused = await agent.payVendor({ destination: W.vendorA.address, amount: '800.00', invoiceRef: 'inv:demo-001', statements: [] })
    expect(refused.proposal.decision.decision).toBe('REFUSE')
    expect(refused.proposal.decision.failing).toContain('W6')
    expect(refused.submit).toBeUndefined()
    expect(chain.submitted).toEqual([])
    const invoice = issueVendorInvoice({
      engagementId: ENG,
      vendorAddress: W.vendorA.address,
      amount: '800.00',
      invoiceRef: 'inv:demo-001',
      observedAt: '2026-11-18T09:00:00Z',
      issuedAt: '2026-11-18T09:00:01Z',
      validUntil: '2026-11-19T09:00:01Z',
      po: 'PO-OPEN',
      nonce: 'demo-invoice',
    }, W.vendorA)
    const settled = await agent.payVendor({
      destination: W.vendorA.address, amount: '800.00', invoiceRef: 'inv:demo-001', statements: [invoice],
    })
    expect(settled.proposal.decision.decision).toBe('SIGN')
    expect(settled.submit?.final).toBe('tesSUCCESS')
    expect(chain.submitted).toEqual([settled.proposal.combined])
  })

  it('refuses a second payment of the same signed invoice while it is reserved', async () => {
    const svc = await service()
    let seq = 21
    const submitted: string[] = []
    const chain: Chain = {
      async fees() { return { base: 10, reserveBase: 1_000_000, inc: 200_000 } },
      async currentLedger() { return LEDGER_INDEX },
      async accountSequence() { return seq },
      async submit(blob: string) {
        submitted.push(blob)
        seq = 22
        return { hash: xrpl.hashes.hashSignedTx(blob), prelim: 'tesSUCCESS', final: 'tesSUCCESS', validated: true, ledger: LEDGER_INDEX }
      },
    }
    const agent = agentFor(svc, chain)
    const invoice = issueVendorInvoice({
      engagementId: ENG,
      vendorAddress: W.vendorA.address,
      amount: '800.00',
      invoiceRef: 'inv:replay-001',
      observedAt: '2026-11-18T09:00:00Z',
      issuedAt: '2026-11-18T09:00:01Z',
      validUntil: '2026-11-19T09:00:01Z',
      po: 'PO-OPEN',
      nonce: 'replay-invoice',
    }, W.vendorA)
    const first = await agent.payVendor({ destination: W.vendorA.address, amount: '800.00', invoiceRef: 'inv:replay-001', statements: [invoice] })
    expect(first.proposal.decision.decision).toBe('SIGN')
    const second = await agent.payVendor({ destination: W.vendorA.address, amount: '800.00', invoiceRef: 'inv:replay-001', statements: [invoice] })
    expect(second.proposal.decision.decision).toBe('REFUSE')
    expect(second.proposal.decision.statementsRejected.map((s) => s.code)).toContain('CONSUMED')
    expect(second.submit).toBeUndefined()
    expect(submitted).toHaveLength(1)
  })

  function demoInvoice(over: Partial<Parameters<typeof issueVendorInvoice>[0]> = {}, signer: InstanceType<typeof xrpl.Wallet> = W.vendorA): Statement {
    return issueVendorInvoice({
      engagementId: ENG,
      vendorAddress: signer.address,
      amount: '800.00',
      invoiceRef: 'inv:neg-001',
      observedAt: '2026-11-18T09:00:00Z',
      issuedAt: '2026-11-18T09:00:01Z',
      validUntil: '2026-11-19T09:00:01Z',
      po: 'PO-OPEN',
      nonce: 'neg-invoice',
      ...over,
    }, signer)
  }

  async function refused(statements: Statement[], amount = '800.00', destination = W.vendorA.address) {
    const chain = new FakeChain(21)
    const agent = agentFor(await service(), chain)
    const result = await agent.payVendor({ destination, amount, invoiceRef: 'inv:neg-001', statements })
    expect(result.proposal.decision.decision).toBe('REFUSE')
    expect(result.submit).toBeUndefined()
    expect(chain.submitted).toEqual([])
    return result.proposal.decision
  }

  it('refuses an invoice bound to another engagement (NOT_BOUND) and submits nothing', async () => {
    const decision = await refused([demoInvoice({ engagementId: 'eng_other', nonce: 'other-eng' })])
    expect(decision.statementsRejected.map((s) => s.code)).toContain('NOT_BOUND')
  })

  it('refuses another vendor\'s invoice when paying vendor A (W6) and submits nothing', async () => {
    const decision = await refused([demoInvoice({ nonce: 'vendor-b' }, W.vendorB)])
    expect(decision.failing).toContain('W6')
    expect(decision.statementsRejected).toEqual([])
  })

  it('refuses an invoice for 800 when the payment is 900 (W6) and submits nothing', async () => {
    const decision = await refused([demoInvoice()], '900.00')
    expect(decision.failing).toContain('W6')
    expect(decision.statementsRejected).toEqual([])
  })

  it('refuses an expired invoice (EXPIRED) and submits nothing', async () => {
    const decision = await refused([demoInvoice({
      observedAt: '2026-11-18T08:00:00Z',
      issuedAt: '2026-11-18T08:00:01Z',
      validUntil: '2026-11-18T09:00:00Z',
      nonce: 'expired',
    })])
    expect(decision.statementsRejected.map((s) => s.code)).toContain('EXPIRED')
  })

  it('refuses a tampered claim (BAD_ID) and submits nothing', async () => {
    const invoice = demoInvoice({ nonce: 'tamper-claim' })
    invoice.claim = { ...invoice.claim, amount: '1.00' }
    const decision = await refused([invoice])
    expect(decision.statementsRejected.map((s) => s.code)).toContain('BAD_ID')
  })

  it('refuses a tampered signature (BAD_SIGNATURE) and submits nothing', async () => {
    const invoice = demoInvoice({ nonce: 'tamper-sig' })
    const sig = invoice.proof.signature
    invoice.proof = { ...invoice.proof, signature: `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}` }
    const decision = await refused([invoice])
    expect(decision.statementsRejected.map((s) => s.code)).toContain('BAD_SIGNATURE')
  })

  it('refuses an invoice the agent signed as the vendor (KEY_NOT_AUTHORIZED) and submits nothing', async () => {
    const body = vendorInvoiceBody({
      engagementId: ENG,
      vendorAddress: W.vendorA.address,
      amount: '800.00',
      invoiceRef: 'inv:neg-001',
      observedAt: '2026-11-18T09:00:00Z',
      issuedAt: '2026-11-18T09:00:01Z',
      validUntil: '2026-11-19T09:00:01Z',
      nonce: 'agent-as-vendor',
      po: 'PO-OPEN',
    })
    const decision = await refused([signStatement(body, W.agent)])
    expect(decision.statementsRejected.map((s) => s.code)).toContain('KEY_NOT_AUTHORIZED')
  })
})
