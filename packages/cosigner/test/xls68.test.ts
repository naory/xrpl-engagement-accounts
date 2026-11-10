// Offline proof of the XLS-68 sponsored pool lifecycle: each pooled-account transaction is signed
// by the account, co-signed by the operating (sponsor) account, and round-trips through the binary
// codec with both signatures, the right Sponsor, and the right SponsorFlags. No network required.
import { describe, it, expect } from 'vitest'
import xrpl from 'xrpl'
import codec from 'ripple-binary-codec'
import {
  buildSponsoredCreate, buildSetServiceRegularKey, buildDisableMaster, buildOpenTrustline,
  buildRemoveTrustline, buildReclaimDelete, sponsorCosign,
  TF_SPONSOR_CREATED_ACCOUNT, SPF_SPONSOR_FEE, SPF_SPONSOR_RESERVE,
} from '../src/xls68.ts'

const { decode } = codec
const { Wallet } = xrpl
const ISSUER = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' // placeholder RLUSD issuer for encoding only

describe('XLS-68 sponsored pool lifecycle', () => {
  const account = Wallet.generate()
  const sponsor = Wallet.generate()
  const service = Wallet.generate()

  // account signs, sponsor co-signs, decode and assert both signatures + sponsorship fields
  function cosigned(tx: Record<string, unknown>, flags: number): Record<string, any> {
    const signed = account.sign({ ...tx, Sequence: 1, Fee: '12' } as never)
    const blob = sponsorCosign(sponsor, signed.tx_blob)
    const d = decode(blob) as Record<string, any>
    expect(d.TxnSignature, 'account signature present').toBeTruthy()
    expect(d.SponsorSignature, 'sponsor co-signature present').toBeTruthy()
    expect(d.Sponsor).toBe(sponsor.address)
    expect(Number(d.SponsorFlags)).toBe(flags)
    return d
  }

  it('creates the account with tfSponsorCreatedAccount, sponsor-signed', () => {
    const tx = buildSponsoredCreate({ sponsor: sponsor.address, account: account.address, amountDrops: '1000000' })
    const d = decode(sponsor.sign({ ...tx, Sequence: 1, Fee: '12' } as never).tx_blob) as Record<string, any>
    expect(Number(d.Flags) & TF_SPONSOR_CREATED_ACCOUNT).toBe(TF_SPONSOR_CREATED_ACCOUNT)
    expect(d.Destination).toBe(account.address)
  })

  it('installs the service RegularKey (fee sponsored)', () => {
    cosigned(buildSetServiceRegularKey({ account: account.address, sponsor: sponsor.address, serviceKey: service.address }), SPF_SPONSOR_FEE)
  })

  it('disables the master key (fee sponsored)', () => {
    cosigned(buildDisableMaster({ account: account.address, sponsor: sponsor.address }), SPF_SPONSOR_FEE)
  })

  it('opens the RLUSD trust line (fee + reserve sponsored)', () => {
    cosigned(buildOpenTrustline({ account: account.address, sponsor: sponsor.address, currency: 'RLUSD', issuer: ISSUER, limit: '1000000000' }), SPF_SPONSOR_FEE | SPF_SPONSOR_RESERVE)
  })

  it('removes the trust line on reclaim (fee sponsored)', () => {
    cosigned(buildRemoveTrustline({ account: account.address, sponsor: sponsor.address, currency: 'RLUSD', issuer: ISSUER }), SPF_SPONSOR_FEE)
  })

  it('deletes the account back to the sponsor (reserves reclaimed)', () => {
    const d = cosigned(buildReclaimDelete({ account: account.address, sponsor: sponsor.address }), SPF_SPONSOR_FEE)
    expect(d.Destination, 'reserves reclaimed to the operating account').toBe(sponsor.address)
  })
})
