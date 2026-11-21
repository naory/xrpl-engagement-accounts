// Demo scripts refuse any network that is not XRPL Testnet or Devnet.
// The check reads server_info.network_id. A URL, including XRPL_URL, is not evidence.

/** Ripple's published network ids. Mainnet is 0 and is refused. */
export const TESTNET_NETWORK_ID = 1
export const DEVNET_NETWORK_ID = 2

export function assertDemoNetworkId(networkId: unknown): 1 | 2 {
  if (networkId === TESTNET_NETWORK_ID || networkId === DEVNET_NETWORK_ID) return networkId
  throw new Error(`refusing to start: server network_id ${JSON.stringify(networkId)} is not Testnet (1) or Devnet (2)`)
}

export interface ServerInfoClient {
  request(req: { command: 'server_info' }): Promise<{ result: { info?: { network_id?: unknown } } }>
}

/** Ask the connected server who it is. Call this after connect, before any transaction. */
export async function assertDemoNetwork(client: ServerInfoClient): Promise<1 | 2> {
  const res = await client.request({ command: 'server_info' })
  return assertDemoNetworkId(res.result.info?.network_id)
}
