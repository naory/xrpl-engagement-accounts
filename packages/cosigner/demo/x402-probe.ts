// Probe: does an XRPL x402 `exact` facilitator accept a MULTISIGNED payment blob?
//
//   npm run probe:x402
//   FACILITATOR_URLS=https://xrpl-facilitator-testnet.t54.ai,http://127.0.0.1:8011 npm run probe:x402
//   SETTLE=1 npm run probe:x402      (also calls /settle on variants that verify)
//
// Builds payments to a fresh merchant on Testnet, each bound to the invoice with InvoiceID
// (sha256(invoiceId)) and carrying the requirement's SourceTag:
//   P0 control       single-signed by a normal account  → must verify, or the envelope is wrong
//   P1 multisig      2-of-2 SignerList, master disabled  → the question
//   P2/P3 + memos    invoice memo / B1-shaped memos      → do engagement memos survive?
//   N1–N4 negatives  below quorum, outsider signer, tampered, memos without invoice id
//   N7 negative      no valid signer at all
//   N5–N6 negatives  single-signed controls (tampered, wrong key), for comparison
//                    → a facilitator that checks signatures must reject every negative
// With SETTLE=1, positives that verify are settled and their ledger result is read back.
// The reference facilitator (@x402/xrpl ≥ 2.26) rejects P1 by code
// ("invalid_exact_xrpl_payload_multisig_not_supported") and P2 for memos; t54's hosted facilitator
// is closed-source, so this script asks it directly. See docs/research/x402-multisig.md.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import xrpl from 'xrpl'
import { ASF_DISABLE_MASTER, accountInfo, combine, currentLedger, lookupTx, memo, multisignBlob, sendSimple, serverFees, sleep } from '../src/xrpl-io.ts'

type Json = Record<string, unknown>
const here = path.dirname(fileURLToPath(import.meta.url))
const URL_ = process.env.XRPL_URL ?? 'wss://s.altnet.rippletest.net:51233'
const FACILITATORS = (process.env.FACILITATOR_URLS ?? 'https://xrpl-facilitator-testnet.t54.ai').split(',').map((s) => s.trim()).filter(Boolean)
const SOURCE_TAG = 804681468

const out: Json & { probes: Json[] } = { probe: 'x402 exact + multisig', url: URL_, facilitators: FACILITATORS, startedAt: new Date().toISOString(), probes: [] }

async function post(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let json: unknown
  try { json = await r.json() } catch { json = await r.text().catch(() => null) }
  return { status: r.status, json }
}

async function fund(client: InstanceType<typeof xrpl.Client>, label: string) {
  for (let i = 0; i < 5; i++) {
    try { const { wallet } = await client.fundWallet(); console.log(`   · funded ${label}: ${wallet.address}`); return wallet } catch (e) { console.log(`   · faucet retry ${label}: ${(e as Error).message}`); await sleep(5000) }
  }
  throw new Error(`faucet failed for ${label}`)
}

async function main() {
  const client = new xrpl.Client(URL_)
  await client.connect()
  const fees = await serverFees(client)

  for (const f of FACILITATORS) {
    try {
      const r = await fetch(f.replace(/\/$/, '') + '/supported')
      out[`supported:${f}`] = await r.json()
      console.log(`${f}/supported → ${JSON.stringify(out[`supported:${f}`])}`)
    } catch (e) { console.log(`${f}/supported failed: ${(e as Error).message}`) }
  }

  const merchant = await fund(client, 'merchant')
  const single = await fund(client, 'payer (single-sign)')
  const multi = await fund(client, 'payer (multisig)')
  const s1 = xrpl.Wallet.generate()
  const s2 = xrpl.Wallet.generate()
  const ok = (r: { final: string }, l: string) => { if (r.final !== 'tesSUCCESS') throw new Error(`${l}: ${r.final}`) }
  ok(await sendSimple(client, multi, { TransactionType: 'SignerListSet', Account: multi.address, SignerQuorum: 2, SignerEntries: [{ SignerEntry: { Account: s1.address, SignerWeight: 1 } }, { SignerEntry: { Account: s2.address, SignerWeight: 1 } }] }), 'SignerListSet')
  ok(await sendSimple(client, multi, { TransactionType: 'AccountSet', Account: multi.address, SetFlag: ASF_DISABLE_MASTER }), 'disable master')
  console.log(`   · ${multi.address}: SignerList 2-of-2, master disabled (like an engagement account)`)

  const invoiceId = `inv-probe-${Date.now()}`
  const requirements = {
    scheme: 'exact', network: 'xrpl:1', amount: '1000', asset: 'XRP', payTo: merchant.address, maxTimeoutSeconds: 60,
    extra: { invoiceId, areFeesSponsored: false, sourceTag: SOURCE_TAG },
  }
  const base = async (account: string): Promise<Json> => ({
    TransactionType: 'Payment', Account: account, Destination: merchant.address, Amount: '1000', Flags: 0,
    InvoiceID: createHash('sha256').update(invoiceId, 'utf8').digest('hex').toUpperCase(), SourceTag: SOURCE_TAG,
    Sequence: Number(((await accountInfo(client, account))!.account_data as Json).Sequence),
    LastLedgerSequence: (await currentLedger(client)) + 10,
  })

  const outsider = xrpl.Wallet.generate() // not on the SignerList
  const outsider2 = xrpl.Wallet.generate()
  const msFee = String(fees.base * 3 + 6)
  const ms = async (extra: Json = {}) => ({ ...(await base(multi.address)), Fee: msFee, SigningPubKey: '', ...extra })
  const invoiceMemo = { Memo: { MemoData: Buffer.from(invoiceId).toString('hex').toUpperCase() } }
  // expect: what a facilitator that really checks the multisig should answer.
  const variants: Array<{ id: string; name: string; expect: 'valid' | 'invalid'; blob: () => Promise<string> }> = [
    { id: 'P0', name: 'control: single-signed', expect: 'valid', blob: async () => single.sign((await client.autofill((await base(single.address)) as never)) as never).tx_blob },
    { id: 'P1', name: 'multisigned (2 of 2, master disabled)', expect: 'valid', blob: async () => { const tx = await ms(); return combine([multisignBlob(s1, tx), multisignBlob(s2, tx)]) } },
    { id: 'P2', name: 'multisigned + invoice memo + eng/basis memo', expect: 'valid', blob: async () => { const tx = await ms({ Memos: [invoiceMemo, memo('eng/basis', 'spend')] }); return combine([multisignBlob(s1, tx), multisignBlob(s2, tx)]) } },
    { id: 'P3', name: 'B1-shaped memos (eng/basis + eng/invoice = invoiceId)', expect: 'valid', blob: async () => { const tx = await ms({ Memos: [memo('eng/basis', 'spend'), memo('eng/invoice', invoiceId)] }); return combine([multisignBlob(s1, tx), multisignBlob(s2, tx)]) } },
    { id: 'N1', name: 'NEGATIVE: below quorum (1 of 2 signatures)', expect: 'invalid', blob: async () => combine([multisignBlob(s1, await ms())]) },
    { id: 'N2', name: 'NEGATIVE: second signer not on the SignerList', expect: 'invalid', blob: async () => { const tx = await ms(); return combine([multisignBlob(s1, tx), multisignBlob(outsider, tx)]) } },
    { id: 'N3', name: 'NEGATIVE: tampered after signing (Fee + 1)', expect: 'invalid', blob: async () => {
      const tx = await ms()
      const d = xrpl.decode(combine([multisignBlob(s1, tx), multisignBlob(s2, tx)])) as Json
      return xrpl.encode({ ...d, Fee: String(Number(d.Fee) + 1) } as never)
    } },
    { id: 'N4', name: 'NEGATIVE: memos without the invoice id', expect: 'invalid', blob: async () => { const tx = await ms({ Memos: [memo('eng/basis', 'spend')] }); return combine([multisignBlob(s1, tx), multisignBlob(s2, tx)]) } },
    { id: 'N7', name: 'NEGATIVE: no valid signer at all (two accounts not on the SignerList)', expect: 'invalid', blob: async () => { const tx = await ms(); return combine([multisignBlob(outsider, tx), multisignBlob(outsider2, tx)]) } },
    // Single-sign controls, to compare behaviour with the multisig cases.
    { id: 'N5', name: 'NEGATIVE: single-signed, tampered after signing (Fee + 1)', expect: 'invalid', blob: async () => {
      const d = xrpl.decode(single.sign((await client.autofill((await base(single.address)) as never)) as never).tx_blob) as Json
      return xrpl.encode({ ...d, Fee: String(Number(d.Fee) + 1) } as never)
    } },
    { id: 'N6', name: 'NEGATIVE: single-signed by a key that does not control the account', expect: 'invalid', blob: async () => outsider.sign((await client.autofill((await base(single.address)) as never)) as never).tx_blob },
  ]

  for (const f of FACILITATORS) {
    for (const v of variants) {
      const signedTxBlob = await v.blob()
      const paymentPayload = { x402Version: 2, resource: { url: 'https://example.invalid/probe', description: 'multisig probe', mimeType: 'application/json' }, accepted: requirements, payload: { signedTxBlob, invoiceId } }
      const body = { paymentPayload, paymentRequirements: requirements }
      let verify: unknown
      let settle: unknown
      let onLedger: unknown
      try {
        verify = await post(f.replace(/\/$/, '') + '/verify', body)
        const valid = (verify as { json?: { isValid?: boolean } }).json?.isValid === true
        // Settle only the variants a correct facilitator should accept (never submit the negatives on purpose).
        if (valid && v.expect === 'valid' && process.env.SETTLE) {
          settle = await post(f.replace(/\/$/, '') + '/settle', body)
          const h = (settle as { json?: { transaction?: string } }).json?.transaction
          if (h) {
            for (let i = 0; i < 10 && !onLedger; i++) {
              const t = await lookupTx(client, h)
              if (t?.validated) onLedger = { hash: h, result: (t.meta as Json).TransactionResult, ledger: t.ledger_index }
              else await sleep(3000)
            }
          }
        }
      } catch (e) { verify = { error: (e as Error).message } }
      const isValid = (verify as { json?: { isValid?: boolean } }).json?.isValid
      const verdict = isValid === undefined ? 'error' : (isValid ? 'valid' : 'invalid') === v.expect ? 'as expected' : 'UNEXPECTED'
      const row = { facilitator: f, id: v.id, name: v.name, expect: v.expect, verdict, verify, settle, onLedger, tx: xrpl.decode(signedTxBlob) }
      out.probes.push(row)
      const j = (verify as { status?: number; json?: Json }).json
      console.log(`${verdict === 'as expected' ? '✅' : '⚠️ '} ${v.id} ${v.name} @ ${f}  (expect ${v.expect})\n     /verify → ${JSON.stringify(j ?? verify)}${settle ? `\n     /settle → ${JSON.stringify((settle as { json: unknown }).json)}` : ''}${onLedger ? `\n     ledger  → ${JSON.stringify(onLedger)}` : ''}`)
    }
  }

  await client.disconnect()
  const dir = path.join(here, 'results')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `x402-probe-${String(out.startedAt).replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  console.log(`\nResults: ${path.relative(path.resolve(here, '../../..'), file)}`)
}

main().catch((e) => { console.error('probe aborted:', e); process.exit(1) })
