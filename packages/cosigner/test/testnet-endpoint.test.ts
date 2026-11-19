import { describe, expect, it, vi } from 'vitest'
import { resolveServiceEndpoint, resolveTestnetEndpoint, TESTNET_CONNECT_TIMEOUT_MS, TESTNET_ENDPOINTS, type TestnetConnect } from '../src/testnet-endpoint.ts'

const PRIMARY = TESTNET_ENDPOINTS[0]
const FALLBACK = TESTNET_ENDPOINTS[1]
const quiet = { warn: () => {} }

describe('resolveTestnetEndpoint', () => {
  it('uses XRPL_URL and does not probe', async () => {
    const connect = vi.fn(async () => { throw new Error('should not connect') })
    const url = await resolveTestnetEndpoint({ env: { XRPL_URL: 'wss://example.test/explicit' }, connect })
    expect(url).toBe('wss://example.test/explicit')
    expect(connect).not.toHaveBeenCalled()
  })

  it('falls back when the primary is unreachable', async () => {
    const connect = vi.fn<TestnetConnect>(async (url) => {
      if (url === PRIMARY) throw new Error('ECONNREFUSED')
    })
    const url = await resolveTestnetEndpoint({ env: {}, connect, ...quiet })
    expect(url).toBe(FALLBACK)
    expect(connect.mock.calls.map((c) => c[0])).toEqual([PRIMARY, FALLBACK])
    expect(connect.mock.calls[0]?.[1]).toBe(TESTNET_CONNECT_TIMEOUT_MS)
  })

  it('falls back when the primary connect times out', async () => {
    const connect = vi.fn((url: string) => {
      if (url === PRIMARY) return new Promise<void>(() => {})
      return Promise.resolve()
    })
    const url = await resolveTestnetEndpoint({ env: {}, connect, timeoutMs: 30, ...quiet })
    expect(url).toBe(FALLBACK)
    expect(connect.mock.calls.map((c) => c[0])).toEqual([PRIMARY, FALLBACK])
  })

  it('throws a clear error when every endpoint is unreachable', async () => {
    const connect = vi.fn(async () => { throw new Error('down') })
    await expect(resolveTestnetEndpoint({ env: {}, connect, ...quiet })).rejects.toThrow(
      `No reachable XRPL Testnet endpoint. Tried ${PRIMARY} (down); ${FALLBACK} (down). Set XRPL_URL to a reachable endpoint.`,
    )
  })
})

describe('resolveServiceEndpoint', () => {
  it('uses the override as-is and does not probe', async () => {
    const connect = vi.fn(async () => { throw new Error('should not connect') })
    const log = vi.fn()
    const url = await resolveServiceEndpoint({
      overrideVar: 'ENG_XRPL_WSS',
      env: { ENG_XRPL_WSS: '  wss://example.test/pool  ', XRPL_URL: 'wss://example.test/other' },
      connect,
      log,
    })
    expect(url).toBe('wss://example.test/pool')
    expect(connect).not.toHaveBeenCalled()
    expect(log.mock.calls).toEqual([['XRPL endpoint: wss://example.test/pool']])
  })

  it('a blank override is unset, so XRPL_URL wins without probing', async () => {
    const connect = vi.fn(async () => { throw new Error('should not connect') })
    const log = vi.fn()
    const url = await resolveServiceEndpoint({
      overrideVar: 'ENG_XRPL_WSS',
      env: { ENG_XRPL_WSS: '   ', XRPL_URL: 'wss://example.test/explicit' },
      connect,
      log,
    })
    expect(url).toBe('wss://example.test/explicit')
    expect(connect).not.toHaveBeenCalled()
    expect(log.mock.calls).toEqual([['XRPL endpoint: wss://example.test/explicit']])
  })

  it('falls back when the primary is unreachable and no override is set', async () => {
    const connect = vi.fn<TestnetConnect>(async (url) => {
      if (url === PRIMARY) throw new Error('ECONNREFUSED')
    })
    const log = vi.fn()
    const url = await resolveServiceEndpoint({ overrideVar: 'ENG_XRPL_WSS', env: {}, connect, log, ...quiet })
    expect(url).toBe(FALLBACK)
    expect(connect.mock.calls.map((c) => c[0])).toEqual([PRIMARY, FALLBACK])
    expect(log.mock.calls).toEqual([[`XRPL endpoint: ${FALLBACK}`]])
  })
})
