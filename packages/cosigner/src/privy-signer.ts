// A Signer whose key lives in Privy (sign-not-export): we compute the XRPL multisigning/attestation
// digest locally, send just that hash to Privy's raw_sign, and DER-encode + low-S normalize the
// compact r||s it returns. Privy XRPL wallets are secp256k1 and return a 33-byte compressed pubkey.
// Proven end to end on Testnet by demo/privy-engagement-testnet.ts.
import { type Signer, signerHashOf, derFromCompact } from '@eng/core'

const PRIVY = 'https://api.privy.io/v1'
type Json = Record<string, unknown>

export interface PrivySignerConfig {
  appId: string
  appSecret: string
  walletId: string
  address: string
  publicKey: string
  authorizationSignature?: string
  fetchImpl?: typeof fetch
}

function authHeaders(o: { appId: string; appSecret: string; authorizationSignature?: string }): Record<string, string> {
  return {
    Authorization: 'Basic ' + Buffer.from(`${o.appId}:${o.appSecret}`).toString('base64'),
    'privy-app-id': o.appId,
    'content-type': 'application/json',
    ...(o.authorizationSignature ? { 'privy-authorization-signature': o.authorizationSignature } : {}),
  }
}

async function post(f: typeof fetch, url: string, headers: Record<string, string>, body: unknown): Promise<Json> {
  const r = await f(url, { method: 'POST', headers, body: JSON.stringify(body) })
  let j: Json
  try { j = (await r.json()) as Json } catch { j = { raw: await r.text().catch(() => '') } }
  if (!r.ok) throw new Error(`Privy ${url} → ${r.status}: ${JSON.stringify(j)}`)
  return j
}

/** A Privy-custodied {@link Signer}. The private key never leaves Privy; we only send it a hash. */
export function privySigner(o: PrivySignerConfig): Signer {
  const f = o.fetchImpl ?? fetch
  const headers = authHeaders(o)
  return {
    address: o.address,
    publicKey: o.publicKey.toUpperCase(),
    source: 'privy',
    signHex: async (messageHex) => {
      const hash = signerHashOf(messageHex).toString('hex')
      const j = await post(f, `${PRIVY}/wallets/${o.walletId}/raw_sign`, headers, { params: { hash: '0x' + hash } })
      const rs = String(((j.data as Json) ?? j).signature ?? '')
      if (!rs) throw new Error(`Privy raw_sign: no signature in response ${JSON.stringify(j)}`)
      return derFromCompact(rs).der
    },
  }
}

/** Create a new XRPL wallet in Privy and read back its address + compressed public key. */
export async function createPrivyXrplWallet(o: { appId: string; appSecret: string; fetchImpl?: typeof fetch }): Promise<{ id: string; address: string; publicKey: string }> {
  const j = await post(o.fetchImpl ?? fetch, `${PRIVY}/wallets`, authHeaders(o), { chain_type: 'xrpl' })
  const w = ((j.wallet as Json) ?? j)
  return { id: String(w.id), address: String(w.address), publicKey: String(w.public_key) }
}

/** Resolve a Privy {@link Signer} from the environment, or undefined if not configured. */
export function privySignerFromEnv(env: NodeJS.ProcessEnv = process.env): Signer | undefined {
  const { PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_WALLET_ID, PRIVY_WALLET_ADDRESS, PRIVY_WALLET_PUBKEY, PRIVY_AUTHORIZATION_SIGNATURE } = env
  if (!PRIVY_APP_ID || !PRIVY_APP_SECRET || !PRIVY_WALLET_ID || !PRIVY_WALLET_ADDRESS || !PRIVY_WALLET_PUBKEY) return undefined
  return privySigner({
    appId: PRIVY_APP_ID, appSecret: PRIVY_APP_SECRET, walletId: PRIVY_WALLET_ID,
    address: PRIVY_WALLET_ADDRESS, publicKey: PRIVY_WALLET_PUBKEY, authorizationSignature: PRIVY_AUTHORIZATION_SIGNATURE,
  })
}
