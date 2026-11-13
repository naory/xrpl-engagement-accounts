// provisionHotel leases from the warm pool only when it can supply every path; otherwise it falls back to pre-creating.
import { describe, expect, it } from 'vitest'
import { hotelPoolSupply } from '../src/orchestrator.ts'

const stub = (ready: number, opts: { refreshFails?: boolean } = {}) => {
  const calls: string[] = []
  return {
    calls,
    pool: {
      refresh: async () => { calls.push('refresh'); if (opts.refreshFails) throw new Error('ledger down') },
      status: async () => { calls.push('status'); return { minting: 0, configuring: 0, aging: 0, ready, leased: 0, closing: 0, closed: 0, error: 0, total: ready } },
    },
  }
}

describe('hotelPoolSupply', () => {
  it('an empty pool cannot supply the run (fallback)', async () => {
    expect(await hotelPoolSupply(stub(0).pool, 8)).toMatchObject({ ok: false, ready: 0 })
  })

  it('a pool short of one account per path cannot supply the run', async () => {
    expect(await hotelPoolSupply(stub(7).pool, 8)).toMatchObject({ ok: false, ready: 7 })
  })

  it('a pool with an account per path supplies the run, after promoting aged accounts', async () => {
    const s = stub(8)
    expect(await hotelPoolSupply(s.pool, 8)).toMatchObject({ ok: true, ready: 8 })
    expect(s.calls).toEqual(['refresh', 'status'])
  })

  it('a pool error means fallback, not a failed provision', async () => {
    const r = await hotelPoolSupply(stub(8, { refreshFails: true }).pool, 8)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('ledger down')
  })
})
