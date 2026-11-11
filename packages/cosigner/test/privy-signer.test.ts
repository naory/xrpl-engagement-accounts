import { describe, expect, it } from 'vitest'
import * as keypairs from 'ripple-keypairs'
import { signerHashOf } from '@eng/core'
import { privySigner, createPrivyXrplWallet } from '../src/privy-signer.ts'

const SECP_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141')
function derToCompact(derHex: string): { r: string; s: string } {
  const b = Buffer.from(derHex, 'hex'); let i = 2
  const rlen = b[i + 1]!; const r = b.subarray(i + 2, i + 2 + rlen); i = i + 2 + rlen
  const slen = b[i + 1]!; const s = b.subarray(i + 2, i + 2 + slen)
  const strip = (x: Buffer) => x.toString('hex').replace(/^00/, '').padStart(64, '0')
  return { r: strip(r), s: strip(s) }
}

// A Privy wallet is really a local keypair here; the mock raw_sign returns a real r||s over the hash
// Privy would sign (sha512half(message) = signerHashOf(message)), extracted from ripple-keypairs.sign.
const kp = keypairs.deriveKeypair(keypairs.generateSeed({ algorithm: 'ecdsa-secp256k1' }))
const address = keypairs.deriveAddress(kp.publicKey)
const msg = Buffer.from('privy raw-sign unit test').toString('hex').toUpperCase()
const refDer = keypairs.sign(msg, kp.privateKey).toUpperCase()
const { r, s } = derToCompact(refDer)

function mockFetch(reply: { status: number; body: unknown }, captured: Record<string, unknown> = {}) {
  return (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    captured.url = url; captured.body = JSON.parse(init.body); captured.headers = init.headers
    return new Response(JSON.stringify(reply.body), { status: reply.status })
  }) as unknown as typeof fetch
}
const cfg = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
  privySigner({ appId: 'app1', appSecret: 'sec1', walletId: 'w1', address, publicKey: kp.publicKey, fetchImpl, ...extra })

describe('privySigner', () => {
  it('signHex: raw_sign r||s → canonical DER that verifies; sends the right hash + auth', async () => {
    const cap: Record<string, unknown> = {}
    const der = await cfg(mockFetch({ status: 200, body: { data: { signature: r + s, encoding: 'hex' } }, }, cap)).signHex(msg)
    expect(keypairs.verify(msg, der, kp.publicKey)).toBe(true)
    expect(der).toBe(refDer) // parity with the local signature
    expect(String(cap.url)).toBe('https://api.privy.io/v1/wallets/w1/raw_sign')
    expect((cap.body as { params: { hash: string } }).params.hash).toBe('0x' + signerHashOf(msg).toString('hex'))
    const h = cap.headers as Record<string, string>
    expect(h['privy-app-id']).toBe('app1')
    expect(h.Authorization ?? h.authorization).toBe('Basic ' + Buffer.from('app1:sec1').toString('base64'))
  })

  it('signHex: normalizes a high-S raw_sign result', async () => {
    const sHigh = (SECP_N - BigInt('0x' + s)).toString(16).padStart(64, '0')
    const der = await cfg(mockFetch({ status: 200, body: { data: { signature: r + sHigh } } })).signHex(msg)
    expect(der).toBe(refDer)
    expect(keypairs.verify(msg, der, kp.publicKey)).toBe(true)
  })

  it('signHex: includes privy-authorization-signature when configured', async () => {
    const cap: Record<string, unknown> = {}
    await cfg(mockFetch({ status: 200, body: { data: { signature: r + s } } }, cap), { authorizationSignature: 'sig-abc' }).signHex(msg)
    expect((cap.headers as Record<string, string>)['privy-authorization-signature']).toBe('sig-abc')
  })

  it('signHex: rejects on a raw_sign error, surfacing status + body', async () => {
    const signer = cfg(mockFetch({ status: 403, body: { error: 'authorization_required' } }))
    await expect(signer.signHex(msg)).rejects.toThrow(/403.*authorization_required/)
  })

  it('signHex: rejects a 2xx response missing the signature', async () => {
    const signer = cfg(mockFetch({ status: 200, body: { data: { encoding: 'hex' } } }))
    await expect(signer.signHex(msg)).rejects.toThrow(/no signature/)
  })

  it('createPrivyXrplWallet maps address + public_key from the response', async () => {
    const w = await createPrivyXrplWallet({ appId: 'a', appSecret: 's', fetchImpl: mockFetch({ status: 200, body: { id: 'wX', address: 'rXYZ', public_key: 'ABCD' } }) })
    expect(w).toEqual({ id: 'wX', address: 'rXYZ', publicKey: 'ABCD' })
  })
})
