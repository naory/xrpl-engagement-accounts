// Marketplace demos refuse a server that is not Testnet or Devnet.
// The decision is server_info.network_id. The URL, including a set XRPL_URL, is not read.
import { describe, expect, it } from 'vitest'
import { assertDemoNetwork, assertDemoNetworkId } from '../demo/network-guard.ts'

describe('marketplace demo network guard', () => {
  it('accepts Testnet and Devnet network ids and refuses every other identity', () => {
    expect(assertDemoNetworkId(1)).toBe(1)
    expect(assertDemoNetworkId(2)).toBe(2)
    expect(() => assertDemoNetworkId(0)).toThrow(/refusing to start: server network_id 0 is not Testnet \(1\) or Devnet \(2\)/)
    expect(() => assertDemoNetworkId(undefined)).toThrow(/refusing to start: server network_id undefined/)
    expect(() => assertDemoNetworkId(21337)).toThrow(/refusing to start: server network_id 21337/)
    expect(() => assertDemoNetworkId('1')).toThrow(/refusing to start: server network_id "1"/)
  })

  it('reads network_id from server_info and does not look at XRPL_URL', async () => {
    const mainnetUrl = 'wss://xrplcluster.com'
    const asked: string[] = []
    const client = {
      url: mainnetUrl,
      request: async (req: { command: string }) => {
        asked.push(req.command)
        return { result: { info: { network_id: 0 } } }
      },
    }
    await expect(assertDemoNetwork(client)).rejects.toThrow(/network_id 0/)
    expect(asked).toEqual(['server_info'])
    expect(JSON.stringify(client)).toContain(mainnetUrl)

    const devnet = {
      request: async () => ({ result: { info: { network_id: 2 } } }),
    }
    await expect(assertDemoNetwork(devnet)).resolves.toBe(2)
  })
})
