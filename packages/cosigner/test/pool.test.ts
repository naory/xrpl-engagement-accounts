// Offline proof of the pool lifecycle with a mocked ledger, in BOTH funding modes:
// mint → age → ready → lease → reclaim. Asserts the state machine, the create/config/reclaim tx
// order, that config is master-signed and reclaim is service-signed (master disabled last), and
// the self-funded vs XLS-68-sponsored shapes. No network: PoolManager depends only on injected
// interfaces (the Temporal-activity seam).
import { describe, it, expect } from 'vitest'
import xrpl from 'xrpl'
import codec from 'ripple-binary-codec'
import { PoolManager } from '../src/pool.ts'
import type { PoolLedger, PoolStateStore, SeedStore, Keys, PoolAccount, PoolConfig } from '../src/pool.ts'

const { decode } = codec
const TF_SPONSOR_CREATED_ACCOUNT = 0x00080000

function memState(): PoolStateStore {
  const m = new Map<string, PoolAccount>()
  return { async all() { return [...m.values()] }, async get(a) { return m.get(a) }, async put(x) { m.set(x.address, { ...x }) }, async remove(a) { m.delete(a) } }
}
function memSeeds(): SeedStore & { has(a: string): boolean } {
  const m = new Map<string, string>()
  return { async save(a, s) { m.set(a, s) }, async load(a) { return m.get(a) }, async delete(a) { m.delete(a) }, has(a) { return m.has(a) } }
}
function mockLedger(start: number) {
  const submitted: Array<Record<string, any>> = []
  let now = start
  const seq = new Map<string, number>()
  const api: PoolLedger = {
    async currentLedger() { return now },
    async accountSequence(a) { return seq.has(a) ? seq.get(a)! : null },
    async autofill(tx) { return { ...tx, Sequence: 1, Fee: tx.TransactionType === 'AccountDelete' ? '2000000' : '12', LastLedgerSequence: now + 20 } },
    async submit(blob) {
      const d = decode(blob) as Record<string, any>
      submitted.push(d)
      if (d.TransactionType === 'Payment' && !seq.has(d.Destination)) seq.set(d.Destination, now) // account now exists
      return { hash: 'H' + submitted.length, prelim: 'tesSUCCESS', final: 'tesSUCCESS', validated: true, ledger: now }
    },
  }
  return { api, submitted, advance(n: number) { now += n } }
}

const keys: Keys = {
  generate() { const w = xrpl.Wallet.generate(); return { address: w.address, seed: w.seed as string } },
  wallet(s) { return xrpl.Wallet.fromSeed(s) },
}

async function runLifecycle(sponsored: boolean) {
  const sponsor = xrpl.Wallet.generate()
  const service = xrpl.Wallet.generate()
  const config: PoolConfig = { rlusd: { currency: 'RLUSD', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', limit: '1000000000' }, createAmountDrops: '3000000', agingLedgers: 256, target: 3, sponsored }
  const state = memState(), seeds = memSeeds(), ledger = mockLedger(1000)
  const pm = new PoolManager({ ledger: ledger.api, state, seeds, keys, sponsor, service, config })

  const minted = await pm.mint()
  const masterPub = keys.wallet((await seeds.load(minted.address))!).publicKey
  await pm.refresh(); const mid = (await state.get(minted.address))!.status // still aging (not yet past window)
  ledger.advance(256); await pm.refresh(); const aged = (await state.get(minted.address))!.status // now ready
  const leased = await pm.lease('deal-1')
  const before = ledger.submitted.length
  await pm.reclaim(minted.address)
  const final = (await state.get(minted.address))!.status // closed
  return { sponsor, service, state, seeds, ledger, minted, masterPub, mid, aged, leased, final, reclaim: ledger.submitted.slice(before) }
}

describe('PoolManager lifecycle (offline, mocked ledger)', () => {
  it('self-funded: master-signed config in order, service-signed reclaim to the operating account', async () => {
    const r = await runLifecycle(false)
    // create (plain Payment, no sponsor flag) → trust line → RegularKey → disable master (LAST)
    expect(r.ledger.submitted.slice(0, 4).map((d) => d.TransactionType)).toEqual(['Payment', 'TrustSet', 'SetRegularKey', 'AccountSet'])
    expect(Number(r.ledger.submitted[0].Flags ?? 0) & TF_SPONSOR_CREATED_ACCOUNT).toBe(0)
    for (const d of r.ledger.submitted.slice(1, 4)) {
      expect(d.SponsorSignature, 'self-funded config is not co-signed').toBeUndefined()
      expect(d.SigningPubKey, 'config signed by the account master').toBe(r.masterPub)
    }
    expect(r.mid).toBe('aging')      // not promoted before the window
    expect(r.aged).toBe('ready')     // promoted after advance(256)
    expect(r.leased?.address).toBe(r.minted.address)
    // reclaim: trust line removed + AccountDelete, SERVICE-signed (master is disabled), to the operating account
    expect(r.reclaim.map((d) => d.TransactionType)).toEqual(['TrustSet', 'AccountDelete'])
    for (const d of r.reclaim) expect(d.SigningPubKey, 'reclaim signed by the service RegularKey').toBe(r.service.publicKey)
    expect(r.reclaim[1].Destination).toBe(r.sponsor.address)
    expect(r.final).toBe('closed')
    expect((r.seeds as any).has(r.minted.address)).toBe(false)
  })

  it('sponsored: create carries tfSponsorCreatedAccount; config + reclaim are sponsor co-signed', async () => {
    const r = await runLifecycle(true)
    expect(Number(r.ledger.submitted[0].Flags) & TF_SPONSOR_CREATED_ACCOUNT).toBe(TF_SPONSOR_CREATED_ACCOUNT)
    for (const d of r.ledger.submitted.slice(1, 4)) {
      expect(d.Sponsor).toBe(r.sponsor.address)
      expect(d.SponsorSignature).toBeTruthy()
    }
    expect(r.reclaim.map((d) => d.TransactionType)).toEqual(['TrustSet', 'AccountDelete'])
    for (const d of r.reclaim) { expect(d.Sponsor).toBe(r.sponsor.address); expect(d.SponsorSignature).toBeTruthy() }
    expect(r.reclaim[1].Destination).toBe(r.sponsor.address)
  })

  it('leases nothing when no account is ready', async () => {
    const sponsor = xrpl.Wallet.generate(), service = xrpl.Wallet.generate()
    const config: PoolConfig = { rlusd: { currency: 'RLUSD', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B', limit: '1' }, createAmountDrops: '3000000', agingLedgers: 256, target: 1, sponsored: false }
    const pm = new PoolManager({ ledger: mockLedger(1000).api, state: memState(), seeds: memSeeds(), keys, sponsor, service, config })
    expect(await pm.lease('deal-x')).toBeNull()
  })
})
