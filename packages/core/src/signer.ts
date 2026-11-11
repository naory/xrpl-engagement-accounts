// Sign-not-export signing abstraction. A Signer proves control of an XRPL account and can
// "XRPL-sign a message" (ECDSA/EdDSA over sha512Half(message), DER for secp256k1) without ever
// exposing a private key — so a local keypair, an HSM/KMS, or a Privy-custodied key all satisfy it.
import { createHash } from 'node:crypto'
import * as keypairs from 'ripple-keypairs'
import { encode, encodeForMultisigning } from 'ripple-binary-codec'

export interface Signer {
  readonly address: string
  readonly publicKey: string          // compressed hex (secp256k1) or ED-prefixed (ed25519)
  readonly source: string             // 'local' | 'privy' | 'kms' — for audit/logs
  /** XRPL-sign a hex message: returns the signature hex (DER for secp256k1) over sha512Half(message). */
  signHex(messageHex: string): Promise<string>
}

/** A Signer backed by a local keypair (an xrpl.js Wallet satisfies the input shape). Holds the key. */
export function localSigner(
  w: { address?: string; classicAddress?: string; publicKey: string; privateKey: string },
  source = 'local',
): Signer {
  const address = w.address ?? w.classicAddress
  if (!address) throw new Error('localSigner: wallet has no address')
  return { address, publicKey: w.publicKey, source, signHex: async (m) => keypairs.sign(m, w.privateKey) }
}

/** The 32-byte digest a secp256k1 signer signs for an XRPL message (what ripple-keypairs hashes). */
export function signerHashOf(messageHex: string): Buffer {
  return createHash('sha512').update(Buffer.from(messageHex, 'hex')).digest().subarray(0, 32)
}

/** Multisign `tx` with one {@link Signer}: returns a serialized tx_blob carrying that single Signer
 *  entry. Combine several via `xrpl.multisign([...])` (which sorts + merges) before submitting. */
export async function signerBlob(signer: Signer, tx: Record<string, unknown>): Promise<string> {
  const { Signers: _s, TxnSignature: _t, ...rest } = tx
  void _s; void _t
  const base = { ...rest, SigningPubKey: '' }
  const signature = await signer.signHex(encodeForMultisigning(base as never, signer.address))
  const signed = { ...base, Signers: [{ Signer: { Account: signer.address, SigningPubKey: signer.publicKey, TxnSignature: signature } }] }
  return encode(signed as never)
}

const SECP_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141')

/** secp256k1 compact r‖s → canonical low-S DER (uppercase hex), as XRPL's TxnSignature requires. */
export function derFromCompact(rsHex: string): { der: string; normalized: boolean } {
  const rs = Buffer.from(rsHex.replace(/^0x/, ''), 'hex')
  if (rs.length !== 64) throw new Error(`expected 64-byte r||s, got ${rs.length}`)
  const r = BigInt('0x' + rs.subarray(0, 32).toString('hex'))
  let s = BigInt('0x' + rs.subarray(32).toString('hex'))
  let normalized = false
  if (s > SECP_N / 2n) { s = SECP_N - s; normalized = true } // XRPL requires fully-canonical (low-S)
  const intBytes = (x: bigint) => {
    let h = x.toString(16); if (h.length % 2) h = '0' + h
    let b = Buffer.from(h, 'hex')
    if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]) // keep it a positive integer
    return b
  }
  const rb = intBytes(r), sb = intBytes(s)
  const seq = Buffer.concat([Buffer.from([0x02, rb.length]), rb, Buffer.from([0x02, sb.length]), sb])
  return { der: Buffer.concat([Buffer.from([0x30, seq.length]), seq]).toString('hex').toUpperCase(), normalized }
}
