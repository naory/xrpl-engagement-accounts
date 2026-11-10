// Live PoolLedger backed by an xrpl Client — the one network-touching activity behind PoolManager
// (→ a Temporal activity in production). Kept separate from pool-local.ts, which is offline-safe.
import xrpl from 'xrpl'
import type { PoolLedger } from './pool.ts'
import { submit, currentLedger, accountInfo, type SubmitResult } from './xrpl-io.ts'

type Client = InstanceType<typeof xrpl.Client>
type Json = Record<string, unknown>

export class XrplPoolLedger implements PoolLedger {
  constructor(private readonly client: Client) {}

  async currentLedger(): Promise<number> {
    return currentLedger(this.client)
  }

  async accountSequence(address: string): Promise<number | null> {
    const r = await accountInfo(this.client, address)
    return r ? Number((r as { account_data: { Sequence: number } }).account_data.Sequence) : null
  }

  /** xrpl.js autofill fills Sequence / Fee / LastLedgerSequence (and the special AccountDelete fee). */
  async autofill(tx: Json): Promise<Json> {
    return (await this.client.autofill(tx as never)) as unknown as Json
  }

  async submit(signedBlob: string): Promise<SubmitResult> {
    return submit(this.client, signedBlob)
  }
}
