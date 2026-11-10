// Probe: is the XLS-68 "Sponsored Fees and Reserves" amendment live on the target network?
//
//   npm run probe:sponsor
//   XRPL_URL=wss://s.devnet.rippletest.net:51233 npm run probe:sponsor
//
// Two independent signals, both written to demo/results/:
//   1. feature-list check — ask the node to name any enabled amendment matching /sponsor/i
//      (admin-only on most clusters; skipped gracefully if the node refuses).
//   2. behavioural check (authoritative) — actually submit sponsored transactions to a fresh
//      faucet account and read the engine_result:
//        A. Payment + tfSponsorCreatedAccount       (sponsor-signed sponsored account creation)
//        B. AccountSet + Sponsor/SponsorFlags, account-signed then sponsor co-signed
//           (exercises the Sponsor field + SponsorSignature co-sign path)
//      If the amendment is disabled the node rejects at preflight (temDISABLED / temMALFORMED /
//      temINVALID_FLAG); if it is enabled the tx reaches tesSUCCESS or a tec* apply result.
// Throwaway Testnet keys only; a few XRP of faucet funds. See docs/pool.md §XLS-68.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import xrpl from 'xrpl'
import { submit, serverFees, sleep } from '../src/xrpl-io.ts'
import { buildSponsoredCreate, sponsorCosign, SPF_SPONSOR_FEE } from '../src/xls68.ts'

type Json = Record<string, unknown>
const here = path.dirname(fileURLToPath(import.meta.url))
const URL_ = process.env.XRPL_URL ?? 'wss://s.altnet.rippletest.net:51233'
const out: Json & { checks: Json[] } = { probe: 'xls-68 sponsor availability', url: URL_, startedAt: new Date().toISOString(), checks: [] }

// temDISABLED/temMALFORMED/temINVALID_FLAG at preflight ⇒ the amendment is not enabled here.
const DISABLED = /^tem(DISABLED|MALFORMED|INVALID_FLAG)/
const interpret = (engine: string) =>
  DISABLED.test(engine) ? 'amendment NOT enabled' : /^tes|^tec/.test(engine) ? 'amendment ENABLED (field/flag accepted)' : `inconclusive (${engine})`

async function fund(client: InstanceType<typeof xrpl.Client>, label: string) {
  for (let i = 0; i < 5; i++) {
    try { const { wallet } = await client.fundWallet(); console.log(`   · funded ${label}: ${wallet.address}`); return wallet } catch (e) { console.log(`   · faucet retry ${label}: ${(e as Error).message}`); await sleep(5000) }
  }
  throw new Error(`faucet failed for ${label}`)
}

async function main() {
  const client = new xrpl.Client(URL_)
  await client.connect()

  // 1. feature-list check (best-effort; admin-only on most public clusters).
  try {
    const r = await client.request({ command: 'feature' } as never)
    const feats = (r as { result?: { features?: Record<string, { name?: string; enabled?: boolean }> } }).result?.features ?? {}
    const hits = Object.entries(feats).filter(([, v]) => /sponsor/i.test(v?.name ?? '')).map(([id, v]) => ({ id, name: v.name, enabled: v.enabled }))
    out.checks.push({ check: 'feature-list', available: true, sponsorAmendments: hits })
    console.log(`feature-list → ${hits.length ? JSON.stringify(hits) : 'no amendment matching /sponsor/i'}`)
  } catch (e) {
    out.checks.push({ check: 'feature-list', available: false, reason: (e as { data?: { error?: string } })?.data?.error ?? (e as Error).message })
    console.log(`feature-list → unavailable (${(e as { data?: { error?: string } })?.data?.error ?? (e as Error).message}); relying on the behavioural check`)
  }

  const fees = await serverFees(client)
  const sponsor = await fund(client, 'sponsor (operating account)')

  // 2A. Sponsored account creation via tfSponsorCreatedAccount, sponsor-signed.
  try {
    const dest = xrpl.Wallet.generate()
    const create = buildSponsoredCreate({ sponsor: sponsor.address, account: dest.address, amountDrops: '10000000' })
    const prepared = await client.autofill(create as never)
    const res = await submit(client, sponsor.sign(prepared as never).tx_blob)
    const engine = res.prelim || res.final
    out.checks.push({ check: 'A: Payment+tfSponsorCreatedAccount', engine_result: engine, final: res.final, verdict: interpret(engine), hash: res.hash })
    console.log(`A (sponsored create) → ${engine} / ${res.final}  ⇒ ${interpret(engine)}`)
  } catch (e) {
    out.checks.push({ check: 'A: Payment+tfSponsorCreatedAccount', error: (e as Error).message })
    console.log(`A (sponsored create) → error: ${(e as Error).message}`)
  }

  // 2B. Sponsor field + SponsorSignature co-sign path: account signs, sponsor co-signs.
  try {
    const acct = await fund(client, 'sponsored account')
    const tx: Json = { TransactionType: 'AccountSet', Account: acct.address, Sponsor: sponsor.address, SponsorFlags: SPF_SPONSOR_FEE }
    const prepared = await client.autofill(tx as never)
    const accountSigned = acct.sign(prepared as never).tx_blob
    const cosigned = sponsorCosign(sponsor, accountSigned)
    const res = await submit(client, cosigned)
    const engine = res.prelim || res.final
    out.checks.push({ check: 'B: Sponsor field + SponsorSignature co-sign', engine_result: engine, final: res.final, verdict: interpret(engine), hash: res.hash })
    console.log(`B (Sponsor field + co-sign) → ${engine} / ${res.final}  ⇒ ${interpret(engine)}`)
  } catch (e) {
    out.checks.push({ check: 'B: Sponsor field + SponsorSignature co-sign', error: (e as Error).message })
    console.log(`B (Sponsor field + co-sign) → error: ${(e as Error).message}`)
  }

  void fees
  await client.disconnect()
  const behavioural = out.checks.filter((c) => (c as Json).verdict).map((c) => String((c as Json).verdict))
  out.conclusion = behavioural.some((v) => v.startsWith('amendment ENABLED')) ? 'XLS-68 Sponsor appears ENABLED on this network'
    : behavioural.some((v) => v.startsWith('amendment NOT')) ? 'XLS-68 Sponsor is NOT enabled on this network'
    : 'inconclusive — see per-check results'
  console.log(`\nConclusion: ${out.conclusion}`)
  const dir = path.join(here, 'results')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `sponsor-probe-${String(out.startedAt).replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  console.log(`Results: ${path.relative(path.resolve(here, '../../..'), file)}`)
}

main().catch((e) => { console.error('probe aborted:', e); process.exit(1) })
