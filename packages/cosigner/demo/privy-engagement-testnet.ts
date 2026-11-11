// Opt-in live Testnet check of the PRODUCTION signer path with a Privy-custodied co-signer.
// Skips unless PRIVY_APP_ID / PRIVY_APP_SECRET are set in the repo-root .env.
//
//   npm run demo:privy
//
// Proves, end to end on XRPL Testnet, that a key held in Privy (never exported) can act as a policy
// co-signer through the productionized abstractions: it signs the decision-record attestation via
// signStatementAsync and the multisigned payment via signerBlob; the attestation verifies offline
// and the combined transaction returns tesSUCCESS. The offline unit suite covers the full policy
// engine; this is the live wiring check for the Privy custody path.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import xrpl from 'xrpl'
import { localSigner, signerBlob, signStatementAsync, verifyStatement, newNonce, type StatementBody } from '@eng/core'
import { createPrivyXrplWallet, privySigner } from '../src/privy-signer.ts'
import { loadEnv } from '../src/env.ts'
import { serverFees, submit, multisigFee } from '../src/xrpl-io.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
loadEnv([path.resolve(here, '../../..')])
const APP_ID = process.env.PRIVY_APP_ID
const APP_SECRET = process.env.PRIVY_APP_SECRET
if (!APP_ID || !APP_SECRET) { console.log('skip: set PRIVY_APP_ID and PRIVY_APP_SECRET in .env to run this live Testnet check'); process.exit(0) }

async function main() {
  const client = new xrpl.Client(process.env.XRPL_URL ?? 'wss://s.altnet.rippletest.net:51233')
  await client.connect()
  const fees = await serverFees(client)

  // 1. Privy-custodied co-signer; local agent.
  const pw = await createPrivyXrplWallet({ appId: APP_ID!, appSecret: APP_SECRET! })
  const cosigner = privySigner({ appId: APP_ID!, appSecret: APP_SECRET!, walletId: pw.id, address: pw.address, publicKey: pw.publicKey })
  const agent = localSigner(xrpl.Wallet.generate('ecdsa-secp256k1' as never))
  console.log(`co-signer (Privy): ${cosigner.address}\nagent (local):     ${agent.address}`)

  // 2. Engagement account + destination (faucet); SignerList {agent:1, cosigner:1} quorum 2.
  const { wallet: eng } = await client.fundWallet()
  const { wallet: dest } = await client.fundWallet()
  const sls = await client.autofill({ TransactionType: 'SignerListSet', Account: eng.address, SignerQuorum: 2,
    SignerEntries: [{ SignerEntry: { Account: agent.address, SignerWeight: 1 } }, { SignerEntry: { Account: cosigner.address, SignerWeight: 1 } }] } as never)
  const slr = await submit(client, eng.sign(sls as never).tx_blob)
  if (slr.final !== 'tesSUCCESS') throw new Error(`SignerListSet: ${slr.final}`)
  console.log(`engagement: ${eng.address} (SignerList set)`)

  // 3. The payment to co-sign.
  const prepared = await client.autofill({ TransactionType: 'Payment', Account: eng.address, Destination: dest.address, Amount: '100000' } as never) as Record<string, unknown>
  const tx: Record<string, unknown> = { ...prepared, Fee: multisigFee(fees.base, 2), SigningPubKey: '' }
  delete tx.TxnSignature

  // 4. The Privy co-signer: decision-record attestation (signStatementAsync) + multisig (signerBlob).
  const body: StatementBody = {
    v: 'eng.att/1', type: 'cosigner.decision/1', engagementId: 'eng_privy_demo',
    subject: { account: eng.address }, claim: { decision: 'SIGN', amount: '0.1', asset: 'XRP' },
    observedAt: new Date().toISOString(), issuedAt: new Date().toISOString(), nonce: newNonce(),
    attester: { account: cosigner.address, kind: 'COSIGNER' },
  }
  const record = await signStatementAsync(body, cosigner)
  const attestationOk = verifyStatement(record).ok
  console.log(`co-signer decision record (signed via Privy) verifies offline: ${attestationOk}`)

  // 5. Combine agent + Privy co-signer and submit.
  const combined = xrpl.multisign([await signerBlob(agent, tx), await signerBlob(cosigner, tx)])
  const res = await submit(client, combined)
  console.log(`${res.final}  https://testnet.xrpl.org/transactions/${res.hash}`)

  const proven = res.final === 'tesSUCCESS' && attestationOk
  console.log(proven
    ? '\n✅ PROVEN — a Privy-custodied co-signer produced a verifiable attestation AND an accepted multisig, live.'
    : `\n❌ not proven — submit=${res.final}, attestation=${attestationOk}`)
  await client.disconnect()
  process.exit(proven ? 0 : 1)
}
main().catch((e) => { console.error('aborted:', e instanceof Error ? e.message : e); process.exit(1) })
