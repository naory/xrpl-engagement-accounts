import { describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import * as keypairs from 'ripple-keypairs'
import { localSigner, derFromCompact, signerHashOf, signStatement, signStatementAsync, verifyStatement, newNonce, type StatementBody } from '../src/index.ts'

const SECP_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141')

// minimal DER(r,s) decoder, for the round-trip tests
function derToCompact(derHex: string): { r: string; s: string } {
  const b = Buffer.from(derHex, 'hex')
  let i = 2 // skip 0x30, seq-len
  if (b[i] !== 0x02) throw new Error('bad der')
  const rlen = b[i + 1]!; const r = b.subarray(i + 2, i + 2 + rlen); i = i + 2 + rlen
  const slen = b[i + 1]!; const s = b.subarray(i + 2, i + 2 + slen)
  const strip = (x: Buffer) => x.toString('hex').replace(/^00/, '').padStart(64, '0')
  return { r: strip(r), s: strip(s) }
}

describe('signer', () => {
  const seed = keypairs.generateSeed({ algorithm: 'ecdsa-secp256k1' })
  const kp = keypairs.deriveKeypair(seed)
  const address = keypairs.deriveAddress(kp.publicKey)
  const msg = Buffer.from('privy-signer parity test').toString('hex').toUpperCase()

  it('localSigner.signHex matches ripple-keypairs.sign (parity)', async () => {
    const s = localSigner({ address, publicKey: kp.publicKey, privateKey: kp.privateKey })
    expect(await s.signHex(msg)).toBe(keypairs.sign(msg, kp.privateKey))
    expect(s.source).toBe('local')
    expect(s.address).toBe(address)
    expect(s.publicKey).toBe(kp.publicKey)
  })

  it('derFromCompact round-trips a real low-S signature', () => {
    const derRef = keypairs.sign(msg, kp.privateKey).toUpperCase()
    const { r, s } = derToCompact(derRef)
    const out = derFromCompact(r + s)
    expect(out.normalized).toBe(false)
    expect(out.der).toBe(derRef)
    expect(keypairs.verify(msg, out.der, kp.publicKey)).toBe(true)
  })

  it('derFromCompact normalizes a high-S twin back to the same low-S DER', () => {
    const derRef = keypairs.sign(msg, kp.privateKey).toUpperCase()
    const { r, s } = derToCompact(derRef)
    const sHigh = (SECP_N - BigInt('0x' + s)).toString(16).padStart(64, '0')
    const out = derFromCompact(r + sHigh)
    expect(out.normalized).toBe(true)
    expect(out.der).toBe(derRef)
    expect(keypairs.verify(msg, out.der, kp.publicKey)).toBe(true)
  })

  it('DER-encodes a high-bit integer with a 0x00 prefix (keeps it positive)', () => {
    const r = 'FF'.padEnd(64, '0') // top bit set
    const s = '01'.padStart(64, '0')
    const { der } = derFromCompact(r + s)
    expect(der.startsWith('30')).toBe(true)
    expect(der).toContain('022100FF') // INTEGER, len 0x21, 0x00 pad, 0xFF…
  })

  it('signerHashOf is the 32-byte sha512half of the message bytes', () => {
    expect(signerHashOf(msg).length).toBe(32)
  })

  it('signStatementAsync via localSigner equals sync signStatement and verifies', async () => {
    const w = xrpl.Wallet.generate('ecdsa-secp256k1' as never)
    const body: StatementBody = {
      v: 'eng.att/1', type: 'test/1', engagementId: 'e1', subject: {}, claim: {},
      observedAt: '2026-01-01T00:00:00Z', issuedAt: '2026-01-01T00:00:00Z', nonce: newNonce(),
      attester: { account: w.address, kind: 'TEST' },
    }
    const a = await signStatementAsync(body, localSigner(w))
    expect(a).toEqual(signStatement(body, w))
    expect(verifyStatement(a).ok).toBe(true)
  })
})
