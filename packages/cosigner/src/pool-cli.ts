// Pool CLI — pre-create, inspect, and reclaim the engagement-account pool.
// Two funding modes: self-funded (default; runs on XRPL Testnet today) and XLS-68 sponsored
// (set ENG_POOL_SPONSORED=1; needs the Sponsor amendment on the target network — your Mac).
//
//   npm run pool:status
//   npm run pool:topup   -- --count 5
//   npm run pool:ensure                      (top up to ENG_POOL_TARGET warm accounts)
//   npm run pool:reclaim -- --all           (or: --address rXXXX)
//   npm run pool:gc                          (drop spent entries: closed / orphaned-leased / error)
//
// Config via environment (secrets never committed):
//   ENG_XRPL_WSS         wss endpoint            (default wss://s.altnet.rippletest.net:51233)
//   ENG_SPONSOR_SEED     operating account seed — funds reserves, receives every reclaim (REQUIRED for topup/reclaim)
//   ENG_SERVICE_SEED     service account seed — installed as each pooled account's RegularKey; signs reclaim (REQUIRED for topup/reclaim)
//   ENG_POOL_SPONSORED   "1"/"true" → XLS-68 sponsored mode; anything else → self-funded (default)
//   ENG_RLUSD_ISSUER     RLUSD issuer address    (default Testnet RLUSD)
//   ENG_RLUSD_CURRENCY   currency code           (default RLUSD)
//   ENG_RLUSD_LIMIT      trust line limit        (default 1000000000)
//   ENG_CREATE_DROPS     XRP drops funded at create (self-funded: base+object reserves+fees; default 3000000)
//   ENG_POOL_TARGET      desired warm pool size  (default 5)
//   ENG_POOL_DIR         pool store directory    (default .pool)
import path from 'node:path'
import xrpl from 'xrpl'
import { loadEnv } from './env.ts'
import { PoolManager, type PoolConfig } from './pool.ts'
import { LocalFileSeedStore, FilePoolStateStore, LocalKeys } from './pool-local.ts'
import { XrplPoolLedger } from './xrpl-pool-ledger.ts'

loadEnv() // pick up a .env in the working directory (repo root), so topup/reclaim need no inline env

// Ripple's documented XRPL Testnet RLUSD issuer (override with ENG_RLUSD_ISSUER for other networks).
const TESTNET_RLUSD_ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV'

const env = (k: string, d?: string): string | undefined => process.env[k] ?? d
function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return undefined
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : undefined
}
const hasFlag = (name: string): boolean => process.argv.includes('--' + name)

async function main(): Promise<void> {
  const cmd = process.argv[2]
  const dir = env('ENG_POOL_DIR', '.pool')!
  const seeds = new LocalFileSeedStore(path.join(dir, 'seeds.json'))
  const state = new FilePoolStateStore(path.join(dir, 'state.json'))

  if (cmd === 'status') {
    const all = await state.all()
    const counts: Record<string, number> = {}
    for (const a of all) counts[a.status] = (counts[a.status] ?? 0) + 1
    console.log(`pool: ${all.length} account(s) ${JSON.stringify(counts)}`)
    for (const a of all) console.log(`  ${a.status.padEnd(11)} ${a.address}${a.leasedBy ? '  (' + a.leasedBy + ')' : ''}`)
    console.log('(run pool:topup to refresh aging→ready against the ledger)')
    return
  }

  if (cmd === 'gc') {
    // Local only: drop spent entries (closed / orphaned-leased / error) and wipe any stray seeds. No network.
    const all = await state.all()
    const drop = all.filter((a) => a.status === 'closed' || a.status === 'leased' || a.status === 'error')
    for (const a of drop) { try { await seeds.delete(a.address) } catch { /* no seed to wipe */ } await state.remove(a.address) }
    const left = await state.all()
    const counts: Record<string, number> = {}
    for (const a of left) counts[a.status] = (counts[a.status] ?? 0) + 1
    console.log(`gc: removed ${drop.length} spent entr${drop.length === 1 ? 'y' : 'ies'}${drop.length ? ' (' + drop.map((a) => a.status).join(', ') + ')' : ''}`)
    console.log(`remaining: ${left.length} ${JSON.stringify(counts)}`)
    return
  }

  if (cmd !== 'topup' && cmd !== 'reclaim' && cmd !== 'ensure') {
    console.log('usage: pool-cli.ts <status | topup --count N | ensure | reclaim --all|--address rXXXX | gc>')
    process.exit(cmd ? 1 : 0)
  }

  const sponsorSeed = env('ENG_SPONSOR_SEED')
  if (!sponsorSeed) throw new Error('ENG_SPONSOR_SEED is required for ' + cmd)
  const sponsor = xrpl.Wallet.fromSeed(sponsorSeed)
  const serviceSeed = env('ENG_SERVICE_SEED')
  if (!serviceSeed) throw new Error('ENG_SERVICE_SEED is required for ' + cmd)
  const service = xrpl.Wallet.fromSeed(serviceSeed)
  const sponsored = env('ENG_POOL_SPONSORED', '') === '1' || env('ENG_POOL_SPONSORED', '') === 'true'
  const config: PoolConfig = {
    rlusd: { currency: env('ENG_RLUSD_CURRENCY', 'RLUSD')!, issuer: env('ENG_RLUSD_ISSUER', TESTNET_RLUSD_ISSUER)!, limit: env('ENG_RLUSD_LIMIT', '1000000000')! },
    createAmountDrops: env('ENG_CREATE_DROPS', '3000000')!,
    agingLedgers: 256,
    target: Number(env('ENG_POOL_TARGET', '5')),
    sponsored,
  }

  const client = new xrpl.Client(env('ENG_XRPL_WSS', 'wss://s.altnet.rippletest.net:51233')!)
  await client.connect()
  try {
    const pm = new PoolManager({ ledger: new XrplPoolLedger(client), state, seeds, keys: LocalKeys, sponsor, service, config })
    console.log(`mode: ${sponsored ? 'XLS-68 sponsored' : 'self-funded'} · operating ${sponsor.address} · service ${service.address}`)

    if (cmd === 'topup' || cmd === 'ensure') {
      let count = Number(flagValue('count') ?? 1)
      if (cmd === 'ensure') {
        const warm = (await state.all()).filter((a) => a.status === 'ready' || a.status === 'aging').length
        count = Math.max(0, config.target - warm)
        console.log(`ensure: target ${config.target}, warm ${warm} → minting ${count}`)
      }
      for (let i = 0; i < count; i++) {
        const a = await pm.mint()
        const how = sponsored ? `reserves + fees sponsored by ${sponsor.address}` : `funded ${config.createAmountDrops} drops from ${sponsor.address}`
        console.log(`minted ${a.address} → ${a.status} (${how})`)
      }
      await pm.refresh()
      console.log('status:', JSON.stringify(await pm.status()))
    } else {
      const all = await state.all()
      const targets = hasFlag('all')
        ? all.filter((a) => a.status !== 'closed').map((a) => a.address)
        : (flagValue('address') ? [flagValue('address')!] : [])
      if (!targets.length) throw new Error('pass --all or --address rXXXX')
      for (const address of targets) {
        console.log('reclaiming', address, '…')
        await pm.reclaim(address)
        console.log('  closed; reserves returned to', sponsor.address)
      }
    }
  } finally {
    await client.disconnect()
  }
}

main().catch((e) => { console.error('pool-cli error:', e?.message ?? e); process.exit(1) })
