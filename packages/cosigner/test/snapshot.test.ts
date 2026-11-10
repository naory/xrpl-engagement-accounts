// XrplLedgerSource against canned rippled API-v2 responses (no network).
import { describe, expect, it } from 'vitest'
import { XrplLedgerSource, LSF_ACCEPTED, LSF_DISABLE_MASTER, hex } from '@eng/cosigner'
import { W, RLUSD_HEX, policies } from '../../policy/test/fixtures.ts'

const ENG = W.engB1.address
const LEDGER = 1000
const rt = (iso: string) => Date.parse(iso) / 1000 - 946684800

function fakeClient() {
  const calls: Array<Record<string, unknown>> = []
  const notFound = () => Object.assign(new Error('actNotFound'), { data: { error: 'actNotFound' } })
  const request = async (r: Record<string, unknown>) => {
    calls.push(r)
    if (r.ledger_index !== undefined && r.command !== 'ledger' && r.command !== 'account_tx' && r.ledger_index !== LEDGER) throw new Error(`not pinned: ${JSON.stringify(r)}`)
    switch (r.command) {
      case 'ledger': return { result: { ledger_index: LEDGER, ledger_hash: 'C'.repeat(64), ledger: { close_time_iso: '2026-11-18T09:33:10Z' } } }
      case 'ledger_entry': return { result: { node: { BaseFeeDrops: '10', ReserveIncrementDrops: '200000' } } }
      case 'account_info':
        if (r.account === ENG) return { result: { account_data: { Account: ENG, Sequence: 25, Flags: LSF_DISABLE_MASTER, Balance: '1400000' } } }
        if (r.account === W.treasury.address) return { result: { account_data: { Account: r.account, Sequence: 7, Flags: 0, RegularKey: W.agent.address, Balance: '99000000' } } }
        throw notFound()
      case 'account_objects':
        if (r.account === ENG && !r.type) return { result: { account_objects: [{ LedgerEntryType: 'RippleState' }, { LedgerEntryType: 'SignerList' }, { LedgerEntryType: 'Ticket', TicketSequence: 12 }, { LedgerEntryType: 'Credential', Subject: ENG }] } }
        if (r.type === 'credential' && r.account === W.vendorA.address) {
          return { result: { account_objects: [
            { LedgerEntryType: 'Credential', Issuer: W.kybIssuer.address, Subject: W.vendorA.address, CredentialType: hex('KYB_VERIFIED'), Flags: LSF_ACCEPTED, Expiration: rt('2027-01-01T00:00:00Z') },
            { LedgerEntryType: 'Credential', Issuer: W.vendorA.address, Subject: W.stranger.address, CredentialType: hex('OTHER'), Flags: 0 }, // vendorA as issuer: ignored
          ] } }
        }
        if (r.type === 'credential') return { result: { account_objects: [] } }
        throw notFound()
      case 'account_lines': return { result: { lines: [{ account: W.issuer.address, currency: RLUSD_HEX, balance: '48800' }, { account: W.fakeIssuer.address, currency: RLUSD_HEX, balance: '5' }] } }
      case 'account_tx': {
        const pay = (seq: number, to: string, value: string, iso: string, result = 'tesSUCCESS', issuer = W.issuer.address) => ({
          tx_json: { TransactionType: 'Payment', Account: ENG, Destination: to, DeliverMax: { currency: RLUSD_HEX, issuer, value }, Sequence: seq },
          meta: { TransactionResult: result, delivered_amount: { currency: RLUSD_HEX, issuer, value } }, hash: `H${seq}`, ledger_index: 900 + seq, close_time_iso: iso,
        })
        return { result: { transactions: [
          pay(24, W.vendorA.address, '700', '2026-11-18T09:00:00Z'),
          pay(23, W.vendorA.address, '50', '2026-11-18T08:00:00Z', 'tecPATH_DRY'), // failed: not outflow
          pay(22, W.vendorB.address, '500', '2026-11-17T08:00:00Z'),
          { tx_json: { TransactionType: 'Payment', Account: W.treasury.address, Destination: ENG, Sequence: 3 }, meta: { TransactionResult: 'tesSUCCESS', delivered_amount: { currency: RLUSD_HEX, issuer: W.issuer.address, value: '50000' } }, hash: 'IN', ledger_index: 850, close_time_iso: '2026-11-10T00:00:00Z' },
          pay(21, W.vendorA.address, '9999', '2026-07-01T00:00:00Z'), // outside the window: stops paging
        ] } }
      }
    }
    throw new Error(`unexpected ${String(r.command)}`)
  }
  return { client: { request } as never, calls }
}

describe('XrplLedgerSource', () => {
  it('reads every fact at one validated ledger and maps it to a snapshot', async () => {
    const { client, calls } = fakeClient()
    const snap = await new XrplLedgerSource(client).snapshot({
      account: ENG, assets: policies.procurement.assets!, accounts: [W.treasury.address, W.controller.address],
      credentialSubjects: [W.vendorA.address, W.vendorB.address], historySecs: 90 * 86400,
    })
    expect(snap.index).toBe(LEDGER)
    expect(snap.closeTime).toBe('2026-11-18T09:33:10Z')
    expect(snap.reserveIncDrops).toBe('200000')
    expect(snap.accounts[ENG]).toEqual({ exists: true, sequence: 25, masterDisabled: true, regularKey: null, ownerObjects: { trustlines: 1, signerList: true, tickets: [12], other: 0 } })
    expect(snap.accounts[W.treasury.address]).toMatchObject({ exists: true, masterDisabled: false, regularKey: W.agent.address })
    expect(snap.accounts[W.controller.address]).toEqual({ exists: false })
    expect(snap.balances[ENG]).toEqual({ RLUSD: '48800' }) // the fake-issuer line is ignored
    expect(snap.credentials).toEqual([{ issuer: W.kybIssuer.address, subject: W.vendorA.address, type: 'KYB_VERIFIED', accepted: true, expiration: '2027-01-01T00:00:00.000Z' }])
    expect(snap.history[ENG].map((h) => [h.sequence, h.payouts[0].value])).toEqual([[24, '700'], [22, '500']])
    expect(calls.filter((c) => c.command === 'ledger').length).toBe(1)
    expect(calls.filter((c) => c.command === 'account_tx').every((c) => c.ledger_index_max === LEDGER)).toBe(true)
  })
})
