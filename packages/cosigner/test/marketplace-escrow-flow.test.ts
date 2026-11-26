// Ticket plan and payout math for marketplace-escrow@1. Live submit is the Testnet demo.
import { describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import { MarketplaceEscrowFlow, currencyHex, marketplaceReleasePayouts, type CosignerService } from '@eng/cosigner'
import { wallet, W } from '../../policy/test/fixtures.ts'

const TF_PARTIAL_PAYMENT = 0x00020000
const CUR = currencyHex('RLUSD')

describe('marketplace-escrow flow', () => {
  it('pre-creates the reserve plus 1 XRP and books no Tickets', () => {
    const fees = { base: 10, reserveBase: 1_000_000, inc: 200_000 }
    expect(MarketplaceEscrowFlow.precreateDrops(fees)).toBe(2_400_000)
  })

  it('pays the seller 1.99 and the fee 0.01 on a 2.00 price at 50 bps', () => {
    expect(marketplaceReleasePayouts('2.00', 50, 'seller', 'fee')).toEqual([
      { to: 'seller', value: '1.99' },
      { to: 'fee', value: '0.01' },
    ])
  })

  it('timeoutSettle returns the refusal and does not submit', async () => {
    let submitted = false
    const client = { request: async () => { submitted = true; throw new Error('submitted') } }
    const flow = new MarketplaceEscrowFlow({
      client: client as never,
      svc: { proposeTimeout: async () => ({ decision: 'REFUSE', failing: ['NOT_DUE'] }) } as unknown as CosignerService,
      cast: {
        issuer: W.issuer, buyer: W.dana, seller: W.atlas, arbiter: W.arbiter,
        accreditor: wallet('marketplace-escrow-accreditor'), carrier: wallet('marketplace-escrow-carrier'),
        service: W.service, currency: CUR,
      },
      fees: { base: 10, reserveBase: 1_000_000, inc: 200_000 },
      price: '2.00',
      issuerAddress: W.issuer.address,
    })
    const refused = await flow.timeoutSettle('refund')
    expect(refused).toEqual({ step: 'default.refund', decision: 'REFUSE', failing: ['NOT_DUE'] })
    expect(submitted).toBe(false)
  })

  it('disputeSettle release sweeps a balance above price plus bond, and an exact balance drains with no sweep', async () => {
    const payments = async (balance: string) => {
      let blob = ''
      const client = {
        request: async (req: { command: string; tx_blob?: string }) => {
          if (req.command === 'account_lines') return { result: { lines: [{ account: W.issuer.address, currency: CUR, balance }] } }
          if (req.command === 'account_info') return { result: { account_data: { Sequence: 20 } } }
          if (req.command === 'ledger_current') return { result: { ledger_current_index: 1000 } }
          if (req.command === 'submit') {
            blob = req.tx_blob ?? ''
            return { result: { engine_result: 'telINSUF_FEE', tx_json: {} } }
          }
          throw new Error(`unexpected ${req.command}`)
        },
      }
      const flow = new MarketplaceEscrowFlow({
        client: client as never,
        svc: {} as CosignerService,
        cast: {
          issuer: W.issuer, buyer: W.dana, seller: W.atlas, arbiter: W.arbiter,
          accreditor: wallet('marketplace-escrow-accreditor'), carrier: wallet('marketplace-escrow-carrier'),
          service: W.service, currency: CUR,
        },
        fees: { base: 10, reserveBase: 1_000_000, inc: 200_000 },
        price: '2.00',
        issuerAddress: W.issuer.address,
      })
      ;(flow as unknown as { eng: string }).eng = wallet('marketplace-escrow-account').address
      await flow.disputeSettle('release', '0.50')
      const decoded = xrpl.decode(blob) as { RawTransactions: Array<{ RawTransaction: { TransactionType: string; Destination?: string; Amount?: { value: string }; Flags?: number } }> }
      return decoded.RawTransactions.map((r) => r.RawTransaction).filter((t) => t.TransactionType === 'Payment')
    }

    const exact = await payments('2.50')
    expect(exact.map((p) => ({ to: p.Destination, value: p.Amount?.value, partial: ((p.Flags ?? 0) & TF_PARTIAL_PAYMENT) !== 0 }))).toEqual([
      { to: W.atlas.address, value: '2.49', partial: false },
      { to: W.service.address, value: '0.01', partial: false },
    ])

    const extra = await payments('3.00')
    expect(extra.map((p) => ({ to: p.Destination, value: p.Amount?.value, partial: ((p.Flags ?? 0) & TF_PARTIAL_PAYMENT) !== 0 }))).toEqual([
      { to: W.atlas.address, value: '2.49', partial: false },
      { to: W.service.address, value: '0.01', partial: false },
      { to: W.dana.address, value: '1000000000', partial: true },
    ])
  })

})
