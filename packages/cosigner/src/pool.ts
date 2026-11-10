// Pre-created engagement-account pool (the README `accounts/` buffer). Keeps a set of pre-aged
// accounts so a deal never waits on account creation or the ~256-ledger AccountDelete window.
// Accounts move: minting → configuring → aging → ready → leased → closing → closed.
//
// Two funding modes (config.sponsored):
//   • sponsored (XLS-68): the operating account carries reserves + fees; the pooled account holds
//     zero XRP; needs the Sponsor amendment on the target network (see xls68.ts).
//   • self-funded (plain): the operating account funds each account's reserve in XRP with ordinary
//     txs; reserves return to it on AccountDelete. Runs anywhere (e.g. Testnet today; see precreate.ts).
// Both share one lifecycle. Pre-create config is master-signed in the order trust line → RegularKey
// → disable master (LAST); afterwards the account is controlled by the service RegularKey, so
// reclaim is signed by the service key.
//
// PORTABILITY (production → Temporal): PoolManager holds only orchestration + state transitions.
// Every side effect — ledger I/O, key generation, seed storage, durable state — is behind an
// injected interface (PoolLedger / Keys / SeedStore / PoolStateStore), each mapping 1:1 onto a
// Temporal activity. No network, clock, or randomness is used directly here. State is persisted
// after every transition and the seed is saved before any funding, so a retried run never orphans funds.
import xrpl from 'xrpl'
import {
  buildSponsoredCreate, buildSetServiceRegularKey, buildDisableMaster,
  buildOpenTrustline, buildRemoveTrustline, buildReclaimDelete, sponsorCosign,
} from './xls68.ts'
import {
  buildFundCreate, buildSetServiceRegularKeyPlain, buildDisableMasterPlain,
  buildOpenTrustlinePlain, buildRemoveTrustlinePlain, buildReclaimDeletePlain,
} from './precreate.ts'
import type { SubmitResult } from './xrpl-io.ts'

type Json = Record<string, unknown>
type Wallet = InstanceType<typeof xrpl.Wallet>

export type PoolStatus = 'minting' | 'configuring' | 'aging' | 'ready' | 'leased' | 'closing' | 'closed' | 'error'

export interface PoolAccount {
  address: string
  status: PoolStatus
  /** Ledger index at creation (≈ the account's Sequence); the aging reference for AccountDelete. */
  createdLedger?: number
  leasedBy?: string
  lastError?: string
}

export interface PoolConfig {
  rlusd: { currency: string; issuer: string; limit: string }
  /** XRP (drops) the operating account funds at creation. Self-funded: base + object reserves + fees. */
  createAmountDrops: string
  /** Ledgers an account must age before AccountDelete is allowed (ledger rule: Sequence ≤ now − 256). */
  agingLedgers: number
  /** Desired number of warm (aging + ready) accounts to keep. */
  target: number
  /** true → XLS-68 sponsored (needs the Sponsor amendment); false → self-funded plain txs. */
  sponsored: boolean
}

/** Durable pool state (NO seeds). In production this is owned by the workflow engine. */
export interface PoolStateStore {
  all(): Promise<PoolAccount[]>
  get(address: string): Promise<PoolAccount | undefined>
  put(a: PoolAccount): Promise<void>
  remove(address: string): Promise<void>
}

/** Secret seed storage. LocalFileSeedStore now; KmsSeedStore is the production hardening TODO. */
export interface SeedStore {
  save(address: string, seed: string): Promise<void>
  load(address: string): Promise<string | undefined>
  delete(address: string): Promise<void>
}

/** Key operations. generate() is non-deterministic → a Temporal activity; wallet() is pure derivation. */
export interface Keys {
  generate(): { address: string; seed: string }
  wallet(seed: string): Wallet
}

/** Ledger I/O — the network side effects → Temporal activities. */
export interface PoolLedger {
  currentLedger(): Promise<number>
  accountSequence(address: string): Promise<number | null>
  autofill(tx: Json): Promise<Json>
  submit(signedBlob: string): Promise<SubmitResult>
}

export interface PoolDeps {
  ledger: PoolLedger
  state: PoolStateStore
  seeds: SeedStore
  keys: Keys
  /** Operating account: funds reserves (+ fees, in sponsored mode) and receives every reclaim. */
  sponsor: Wallet
  /** Service account whose key is installed as each pooled account's RegularKey; signs reclaim (and the demo's open). */
  service: Wallet
  config: PoolConfig
}

export class PoolManager {
  constructor(private readonly d: PoolDeps) {}
  private get sponsored(): boolean { return this.d.config.sponsored }

  async status(): Promise<Record<PoolStatus, number> & { total: number }> {
    const all = await this.d.state.all()
    const c = { minting: 0, configuring: 0, aging: 0, ready: 0, leased: 0, closing: 0, closed: 0, error: 0, total: all.length } as Record<PoolStatus, number> & { total: number }
    for (const a of all) c[a.status]++
    return c
  }

  /** Mint one account: create, then configure (trust line → RegularKey → disable master), then age. */
  async mint(): Promise<PoolAccount> {
    const sp = this.sponsored
    const op = this.d.sponsor.address
    const { address, seed } = this.d.keys.generate()
    await this.d.seeds.save(address, seed) // persist the seed BEFORE funding, so a crash can't orphan funds
    await this.d.state.put({ address, status: 'minting' })

    // 1) create — operating account funds it (sponsored: reserve waived; self-funded: XRP for reserves)
    const create = sp
      ? buildSponsoredCreate({ sponsor: op, account: address, amountDrops: this.d.config.createAmountDrops })
      : buildFundCreate({ operating: op, account: address, amountDrops: this.d.config.createAmountDrops })
    await this.step(create, this.d.sponsor, false)

    // 2) configure — master-signed, in order; master disabled LAST
    await this.transition(address, 'configuring')
    const master = this.d.keys.wallet(seed)
    await this.step(sp ? buildOpenTrustline({ account: address, sponsor: op, ...this.d.config.rlusd })
                       : buildOpenTrustlinePlain({ account: address, ...this.d.config.rlusd }), master, sp)
    await this.step(sp ? buildSetServiceRegularKey({ account: address, sponsor: op, serviceKey: this.d.service.address })
                       : buildSetServiceRegularKeyPlain({ account: address, serviceKey: this.d.service.address }), master, sp)
    await this.step(sp ? buildDisableMaster({ account: address, sponsor: op })
                       : buildDisableMasterPlain({ account: address }), master, sp)

    // 3) start aging from the account's on-ledger Sequence
    const seq = await this.d.ledger.accountSequence(address)
    return this.transition(address, 'aging', { createdLedger: seq ?? undefined })
  }

  /** Promote accounts that have aged past the AccountDelete window to `ready`. */
  async refresh(): Promise<void> {
    const now = await this.d.ledger.currentLedger()
    for (const a of await this.d.state.all()) {
      if (a.status === 'aging' && a.createdLedger != null && now - a.createdLedger >= this.d.config.agingLedgers) {
        await this.transition(a.address, 'ready')
      }
    }
  }

  /** Lease a ready account for a deal; returns its address + seed so the caller can open the engagement. */
  async lease(dealId: string): Promise<{ address: string; seed: string } | null> {
    const ready = (await this.d.state.all()).find((a) => a.status === 'ready')
    if (!ready) return null
    await this.transition(ready.address, 'leased', { leasedBy: dealId })
    const seed = await this.d.seeds.load(ready.address)
    if (!seed) throw new Error(`no seed stored for leased account ${ready.address}`)
    return { address: ready.address, seed }
  }

  /** Reclaim: close the RLUSD trust line, then delete the account — reserves + leftover XRP to the operating account.
   *  The master key is disabled, so these are signed by the service RegularKey. Returns both tx hashes. */
  async reclaim(address: string): Promise<{ removeTrustline: string; accountDelete: string }> {
    const sp = this.sponsored
    const op = this.d.sponsor.address
    await this.transition(address, 'closing')
    const r1 = await this.step(sp ? buildRemoveTrustline({ account: address, sponsor: op, currency: this.d.config.rlusd.currency, issuer: this.d.config.rlusd.issuer })
                       : buildRemoveTrustlinePlain({ account: address, currency: this.d.config.rlusd.currency, issuer: this.d.config.rlusd.issuer }), this.d.service, sp)
    const r2 = await this.step(sp ? buildReclaimDelete({ account: address, sponsor: op })
                       : buildReclaimDeletePlain({ account: address, deleteTo: op }), this.d.service, sp)
    await this.transition(address, 'closed')
    await this.d.seeds.delete(address) // the account is gone; wipe its secret
    return { removeTrustline: r1.hash, accountDelete: r2.hash }
  }

  /** Bookkeeping-only close: mark the account closed and wipe its seed, WITHOUT signing any ledger
   *  teardown here. Use this when the caller has already torn the account down on-ledger by another
   *  authority — e.g. an opened engagement whose teardown must be signed by its SignerList quorum,
   *  not the pool service key (the open Batch removes the RegularKey). */
  async markClosed(address: string): Promise<void> {
    await this.transition(address, 'closed')
    await this.d.seeds.delete(address)
  }

  // ── helpers ──
  /** autofill → sign with `signer` → (sponsored) sponsor co-sign → submit; require tesSUCCESS. */
  private async step(tx: Json, signer: Wallet, cosign: boolean): Promise<SubmitResult> {
    const filled = await this.d.ledger.autofill({ ...tx })
    const signed = signer.sign(filled as never)
    const blob = cosign ? sponsorCosign(this.d.sponsor, signed.tx_blob) : signed.tx_blob
    const r = await this.d.ledger.submit(blob)
    if (!r.validated || !/^tes/.test(r.final)) throw new Error(`submit not successful: ${r.final || r.prelim}`)
    return r
  }
  private async transition(address: string, status: PoolStatus, extra: Partial<PoolAccount> = {}): Promise<PoolAccount> {
    const cur = (await this.d.state.get(address)) ?? { address, status }
    const next: PoolAccount = { ...cur, ...extra, status }
    await this.d.state.put(next)
    return next
  }
}
