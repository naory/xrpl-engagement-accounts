// Ticket plan and payout math for marketplace-escrow@1. Live submit is the Testnet demo.
import { describe, expect, it } from 'vitest'
import { MarketplaceEscrowFlow, marketplaceReleasePayouts, marketplaceTickets } from '@eng/cosigner'

describe('marketplace-escrow flow', () => {
  it('books 15 Tickets and pre-creates the reserve plus 1 XRP', () => {
    const plan = marketplaceTickets()
    expect(plan.slices['default.refund']).toEqual([0, 4])
    expect(plan.slices['default.release']).toEqual([4, 9])
    expect(plan.slices['default.releaseSweep']).toEqual([9, 15])
    expect(plan.count).toBe(15)
    const fees = { base: 10, reserveBase: 1_000_000, inc: 200_000 }
    expect(MarketplaceEscrowFlow.precreateDrops(fees)).toBe(5_400_000)
  })

  it('pays the seller 1.99 and the fee 0.01 on a 2.00 price at 50 bps', () => {
    expect(marketplaceReleasePayouts('2.00', 50, 'seller', 'fee')).toEqual([
      { to: 'seller', value: '1.99' },
      { to: 'fee', value: '0.01' },
    ])
  })
})
