// A Signer whose key lives in Privy (sign-not-export): we compute the XRPL multisigning/attestation
// digest locally, send just that hash to Privy's raw_sign, and DER-encode + low-S normalize the
// compact r||s it returns. Privy XRPL wallets are secp256k1 and return a 33-byte compressed pubkey.
// Proven end to end on Testnet by demo/privy-engagement-testnet.ts.
import { createPrivateKey, sign } from 'node:crypto'
import { type Signer, signerHashOf, derFromCompact, canonicalize } from '@eng/core'

const PRIVY = 'https://api.privy.io/v1'
type Json = Record<string, unknown>

export interface PrivySignerConfig {
  appId: string
  appSecret: string
  walletId: string
  address: string
  publicKey: string
  /** Production hardening: the Privy authorization (owner) key — base64 PKCS8 P-256 private key from
   *  the Dashboard. When set, each signing request carries a generated `privy-authorization-signature`. */
  authorizationKey?: string
  fetchImpl?: typeof fetch
}

function authHeaders(o: { appId: string; appSecret: string }): Record<string, string> {
  return {
    Authorization: 'Basic ' + Buffer.from(`${o.appId}:${o.appSecret}`).toString('base64'),
    'privy-app-id': o.appId,
    'content-type': 'application/json',
  }
}

/** Privy request-authorization signature: ECDSA-P256 over the RFC 8785-canonical payload, base64.
 *  `authKeyB64` is the Dashboard authorization key (base64 PKCS8 DER; a `wallet-auth:` prefix is stripped). */
export function generateAuthorizationSignature(authKeyB64: string, payload: unknown): string {
  const pem = `-----BEGIN PRIVATE KEY-----\n${authKeyB64.replace(/^wallet-auth:/, '')}\n-----END PRIVATE KEY-----`
  const key = createPrivateKey({ key: pem, format: 'pem' })
  return sign('sha256', Buffer.from(canonicalize(payload as never)), key).toString('base64')
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
      const url = `${PRIVY}/wallets/${o.walletId}/raw_sign`
      const body = { params: { hash: '0x' + hash } }
      const reqHeaders = { ...headers }
      if (o.authorizationKey) {
        const payload = { version: 1, method: 'POST', url, body, headers: { 'privy-app-id': o.appId } }
        reqHeaders['privy-authorization-signature'] = generateAuthorizationSignature(o.authorizationKey, payload)
      }
      const j = await post(f, url, reqHeaders, body)
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
  const { PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_WALLET_ID, PRIVY_WALLET_ADDRESS, PRIVY_WALLET_PUBKEY, PRIVY_AUTHORIZATION_KEY } = env
  if (!PRIVY_APP_ID || !PRIVY_APP_SECRET || !PRIVY_WALLET_ID || !PRIVY_WALLET_ADDRESS || !PRIVY_WALLET_PUBKEY) return undefined
  return privySigner({
    appId: PRIVY_APP_ID, appSecret: PRIVY_APP_SECRET, walletId: PRIVY_WALLET_ID,
    address: PRIVY_WALLET_ADDRESS, publicKey: PRIVY_WALLET_PUBKEY, authorizationKey: PRIVY_AUTHORIZATION_KEY,
  })
}
