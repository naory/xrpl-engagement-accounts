import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import { CosignerService, FixtureLedgerSource, createServer, currencyHex, type Fees, type SubmitResult } from '@eng/cosigner'
import { localSigner } from '@eng/core'
import { W, LEDGER_INDEX, b1Engagement, b1Invoice, b1Mandate, b1Ledger, policies, templates } from '../../policy/test/fixtures.ts'
import { EngagementAgent, type Chain } from '../src/agent.ts'
import { CosignerClient } from '../src/client.ts'

const ENG = 'eng_b1_fixture'
const ASSET = { code: 'RLUSD', currency: currencyHex('RLUSD'), issuer: W.issuer.address }

/** A fresh in-process co-signer registered on the B1 fixture engagement. */
function service(ledger = b1Ledger()): CosignerService {
  const svc = new CosignerService({ wallet: W.cosigner, source: new FixtureLedgerSource(ledger), templates: [templates.procurement, templates.hotel], policies: [policies.baseline, policies.procurement, policies.hotel] })
  svc.register(b1Engagement(), b1Mandate())
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
    const agent = agentFor(service(), new FakeChain(21))
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
    const agent = agentFor(service(), new FakeChain())
    const p = await agent.proposePayment({ destination: W.stranger.address, amount: '100.00', invoiceRef: 'inv:X', statements: [b1Invoice(W.stranger, '100.00', 'inv:X')] })
    expect(p.decision.decision).toBe('REFUSE')
    expect(p.combined).toBeUndefined()
  })

  it('payVendor settles a signed payment, broadcasting exactly the quorum blob', async () => {
    const chain = new FakeChain(21)
    const { proposal, submit } = await agentFor(service(), chain).payVendor({ destination: W.vendorA.address, amount: '800.00', invoiceRef: 'inv:2026-Q4-0042', statements: [b1Invoice()] })
    expect(proposal.decision.decision).toBe('SIGN')
    expect(submit?.final).toBe('tesSUCCESS')
    expect(chain.submitted).toEqual([proposal.combined])
  })

  it('payVendor does not broadcast when the co-signer refuses', async () => {
    const chain = new FakeChain()
    const { proposal, submit } = await agentFor(service(), chain).payVendor({ destination: W.stranger.address, amount: '100.00', statements: [] })
    expect(proposal.decision.decision).toBe('REFUSE')
    expect(submit).toBeUndefined()
    expect(chain.submitted).toEqual([])
  })

  it('submit requires a chain', async () => {
    await expect(agentFor(service()).submit('DEADBEEF')).rejects.toThrow(/requires a chain/)
  })

  it('drives a remote co-signer over HTTP through CosignerClient (same Decider seam)', async () => {
    const svc = service()
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
})
