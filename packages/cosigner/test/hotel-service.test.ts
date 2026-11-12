// Co-signer attestation store (spec §5.2a): "posted" means "receipted by the co-signer". Ingest checks the
// statement, judges its window on the snapshot's closeTime, stores it, and returns a signed receipt.
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { localSigner, verifyStatement, type Statement } from '@eng/core'
import { CosignerService, FixtureLedgerSource, createServer, type Receipt } from '@eng/cosigner'
import { LEDGER_INDEX, W, checkin, claim, dispute, hotel2Engagement, hotel2Ledger, hotel2Mandate, policies, statement, templates } from '../../policy/test/fixtures.ts'

const ENG = 'eng_hotel2_fixture'

function setup(closeTime: string) {
  const source = new FixtureLedgerSource(hotel2Ledger({ closeTime }))
  const svc = new CosignerService({ signer: localSigner(W.cosigner), source, templates: [templates.hotel2], policies: [policies.baseline, policies.hotel2] })
  svc.register(hotel2Engagement(), hotel2Mandate())
  return { svc, source }
}

/** A hotel claim issued at `issuedAt` (the fixture's `claim()` has a fixed posting time). */
function claimAt(issuedAt: string, items: Array<{ amount: string }>, total: string): Statement {
  return statement(W.atlas, {
    kind: 'COUNTERPARTY', type: 'party.claim/1', engagementId: ENG, subject: { bookingId: 'ATL-60417' },
    claim: { items: items.map((i) => ({ kind: 'minibar', amount: { currency: 'RLUSD', value: i.amount }, evidenceHashes: [] })), total: { currency: 'RLUSD', value: total } },
    observedAt: issuedAt, issuedAt,
  })
}

function expectReceiptFor(r: Receipt, s: Statement, receivedAt: string) {
  expect(verifyStatement(r.statement).ok).toBe(true)
  expect(r.statement.type).toBe('cosigner.receipt/1')
  expect(r.statement.attester.account).toBe(W.cosigner.address)
  expect(r.statement.engagementId).toBe(ENG)
  expect(r.statement.subject).toEqual({ statementId: s.id, statementType: s.type })
  expect(r.statement.claim).toEqual({ receivedAt, ledgerIndex: LEDGER_INDEX })
}

describe('co-signer attestation store', () => {
  it('ingest returns a verifiable receipt and the statement then counts in decide()', async () => {
    const { svc, source } = setup('2026-11-11T15:01:00Z')
    const before = await svc.decide({ engagementId: ENG, stage: 'checkin' })
    expect(before.failing).toContain('K1')
    const s = checkin('checked_in')
    const r = await svc.ingest(ENG, s)
    expectReceiptFor(r, s, '2026-11-11T15:01:00Z')
    expect(svc.statements(ENG).map((x) => x.id)).toEqual([s.id])
    source.snap.closeTime = '2026-11-11T15:05:00Z'
    const after = await svc.decide({ engagementId: ENG, stage: 'checkin' })
    expect(after.failing).not.toContain('K1')
  })

  it('decide() deduplicates stored and request statements by id', async () => {
    const { svc } = setup('2026-11-11T15:01:00Z')
    const s = checkin('checked_in')
    await svc.ingest(ENG, s)
    const d = await svc.decide({ engagementId: ENG, stage: 'checkin', statements: [s] })
    expect(d.failing).not.toContain('K1')
    expect(d.statementsRejected).toEqual([])
    expect((d.record.claim.statementsUsed as string[]).filter((id) => id === s.id)).toEqual([s.id])
  })

  it('is idempotent: the same statement twice returns the first receipt and is stored once', async () => {
    const { svc, source } = setup('2026-11-11T15:01:00Z')
    const s = checkin('checked_in')
    const r1 = await svc.ingest(ENG, s)
    source.snap.closeTime = '2026-11-11T23:30:00Z' // even past checkInBy, a re-post returns the original receipt
    source.snap.index = LEDGER_INDEX + 99
    const r2 = await svc.ingest(ENG, s)
    expect(r2).toEqual(r1)
    expect(svc.statements(ENG)).toHaveLength(1)
  })

  it('rejects a claim posted after claimBy', async () => {
    const { svc } = setup('2026-11-15T11:00:01Z')
    await expect(svc.ingest(ENG, claimAt('2026-11-15T11:00:00Z', [{ amount: '40.00' }], '40.00'))).rejects.toThrow(/LATE: party\.claim\/1 after claimBy/)
    await expect(svc.ingest(ENG, claim([{ kind: 'minibar', amount: '40.00' }]))).rejects.toThrow(/LATE/)
    expect(svc.statements(ENG)).toEqual([])
  })

  it('accepts a claim received exactly at claimBy (windows are inclusive)', async () => {
    const { svc } = setup('2026-11-15T11:00:00Z')
    const s = claimAt('2026-11-15T10:59:00Z', [{ amount: '40.00' }], '40.00')
    expectReceiptFor(await svc.ingest(ENG, s), s, '2026-11-15T11:00:00Z')
    expect(svc.statements(ENG)).toHaveLength(1)
  })

  it('picks the window by dispute phase (type#phase)', async () => {
    // 2026-11-13: past entryDisputeBy (11-12T11:00) but inside disputeWindowEnds (11-17T11:00).
    const { svc } = setup('2026-11-13T10:00:00Z')
    await expect(svc.ingest(ENG, dispute('entry', '2026-11-13T09:59:00Z'))).rejects.toThrow(/LATE: party\.dispute\/1 after entryDisputeBy/)
    const s = dispute('settlement', '2026-11-13T09:59:00Z')
    expectReceiptFor(await svc.ingest(ENG, s), s, '2026-11-13T10:00:00Z')
    expect(svc.statements(ENG).map((x) => x.id)).toEqual([s.id])
  })

  it('rejects a statement issued more than 300 s before it is received (backdating)', async () => {
    const { svc } = setup('2026-11-16T10:05:01Z')
    await expect(svc.ingest(ENG, dispute('settlement', '2026-11-16T10:00:00Z'))).rejects.toThrow(/STALE_ISSUED/)
    const s = dispute('settlement', '2026-11-16T10:00:01Z') // exactly 300 s: accepted
    expectReceiptFor(await svc.ingest(ENG, s), s, '2026-11-16T10:05:01Z')
    expect(svc.statements(ENG).map((x) => x.id)).toEqual([s.id])
  })

  it('rejects a claim whose total is not the exact sum of its items', async () => {
    const { svc } = setup('2026-11-14T15:01:00Z')
    await expect(svc.ingest(ENG, claimAt('2026-11-14T15:00:00Z', [{ amount: '0.10' }, { amount: '0.20' }], '0.30000001'))).rejects.toThrow(/CLAIM_TOTAL/)
    await expect(svc.ingest(ENG, claimAt('2026-11-14T15:00:00Z', [{ amount: '40.00' }, { amount: '25.50' }], '65.49'))).rejects.toThrow(/CLAIM_TOTAL/)
    expect(svc.statements(ENG)).toEqual([])
    const s = claimAt('2026-11-14T15:00:00Z', [{ amount: '0.10' }, { amount: '0.20' }], '0.3')
    expectReceiptFor(await svc.ingest(ENG, s), s, '2026-11-14T15:01:00Z')
  })

  it('rejects a statement from a non-party', async () => {
    const { svc } = setup('2026-11-11T15:01:00Z')
    const s = statement(W.stranger, {
      kind: 'COUNTERPARTY', type: 'party.checkin/1', engagementId: ENG, subject: { bookingId: 'ATL-60417' },
      claim: { status: 'checked_in', room: '204', deposit: { currency: 'RLUSD', value: '150.00' } },
      observedAt: '2026-11-11T15:00:00Z', issuedAt: '2026-11-11T15:00:00Z',
    })
    await expect(svc.ingest(ENG, s)).rejects.toThrow(/NOT_A_PARTY/)
    expect(svc.statements(ENG)).toEqual([])
  })

  it('rejects a statement for another engagement', async () => {
    const { svc } = setup('2026-11-11T15:01:00Z')
    const s = statement(W.atlas, {
      kind: 'COUNTERPARTY', type: 'party.checkin/1', engagementId: 'eng_other', subject: { bookingId: 'ATL-60417' },
      claim: { status: 'checked_in', room: '204', deposit: { currency: 'RLUSD', value: '150.00' } },
      observedAt: '2026-11-11T15:00:00Z', issuedAt: '2026-11-11T15:00:00Z',
    })
    await expect(svc.ingest(ENG, s)).rejects.toThrow(/WRONG_ENGAGEMENT/)
    expect(svc.statements(ENG)).toEqual([])
  })

  it('rejects a statement whose signature does not verify', async () => {
    const { svc } = setup('2026-11-11T15:01:00Z')
    const s = checkin('checked_in')
    await expect(svc.ingest(ENG, { ...s, claim: { ...s.claim, status: 'refused' } })).rejects.toThrow(/BAD_STATEMENT/)
    expect(svc.statements(ENG)).toEqual([])
  })

  it('HTTP route stores and returns the receipt', async () => {
    const { svc } = setup('2026-11-11T15:01:00Z')
    const server = createServer(svc).listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const s = checkin('checked_in')
      const r = await fetch(`${base}/v1/engagements/${ENG}/attestations`, { method: 'POST', body: JSON.stringify({ statement: s }) })
      expect(r.status).toBe(200)
      expectReceiptFor((await r.json()) as Receipt, s, '2026-11-11T15:01:00Z')
      expect(svc.statements(ENG).map((x) => x.id)).toEqual([s.id])
      const bad = await fetch(`${base}/v1/engagements/${ENG}/attestations`, { method: 'POST', body: JSON.stringify({ statement: claimAt('2026-11-11T15:00:00Z', [{ amount: '1.00' }], '2.00') }) })
      expect(bad.status).toBe(400)
      expect(((await bad.json()) as { error: string }).error).toMatch(/CLAIM_TOTAL/)
    } finally {
      server.close()
    }
  })
})
