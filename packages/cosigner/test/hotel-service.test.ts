// Co-signer attestation store (spec §5.2a): "posted" means "receipted by the co-signer". Ingest checks the
// statement, judges its window on the snapshot's closeTime, stores it, and returns a signed receipt.
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import * as keypairs from 'ripple-keypairs'
import { encodeForMultisigning } from 'ripple-binary-codec'
import { localSigner, verifyStatement, type Statement } from '@eng/core'
import { CosignerService, FixtureLedgerSource, combine, createServer, type Receipt, type TickResult } from '@eng/cosigner'
import {
  LEDGER_INDEX, NOW, W, checkin, claim, dispute, hotel2Confirmation, hotel2Close, hotel2Engagement, hotel2Ledger, hotel2Mandate, memo, policies, review, statement, templates,
} from '../../policy/test/fixtures.ts'

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

  it('decide() drops a window-governed statement passed only in the request (NOT_RECEIPTED)', async () => {
    const { svc, source } = setup('2026-11-11T15:01:00Z')
    await svc.ingest(ENG, checkin('checked_in'))
    source.snap.closeTime = NOW // after disputeWindowEnds
    const late = claimAt('2026-11-18T09:30:00Z', [{ amount: '40.00' }], '40.00')
    await expect(svc.ingest(ENG, late)).rejects.toThrow(/LATE/)
    const d = await svc.decide({ engagementId: ENG, stage: 'default.release', statements: [late] })
    expect(d.results.find((r) => r.id === 'L5')?.result).toBe('pass')
    expect(d.statementsRejected).toContainEqual({ id: late.id, type: 'party.claim/1', code: 'NOT_RECEIPTED' })
    expect(d.record.claim.statementsRejected).toContainEqual({ id: late.id, type: 'party.claim/1', code: 'NOT_RECEIPTED' })
    expect(d.record.claim.statementsUsed).not.toContain(late.id)
  })

  it('decide() still counts a receipted claim passed again in the request, once', async () => {
    const { svc, source } = setup('2026-11-14T15:01:00Z')
    const c = claim([{ kind: 'minibar', amount: '40.00' }])
    await svc.ingest(ENG, c)
    source.snap.closeTime = NOW
    const d = await svc.decide({ engagementId: ENG, stage: 'default.release', statements: [c] })
    expect(d.results.find((r) => r.id === 'L5')?.result).toBe('fail')
    expect(d.statementsRejected.filter((r) => r.id === c.id)).toEqual([])
    expect((d.record.claim.statementsUsed as string[]).filter((id) => id === c.id)).toEqual([c.id])
  })

  it('decide() still accepts non-governed statements passed only in the request (review)', async () => {
    const { svc } = setup(NOW)
    const r = review(W.dana, ENG)
    const d = await svc.decide({ engagementId: ENG, stage: 'default.release', statements: [r] })
    expect(d.statementsRejected).toEqual([])
    expect(d.record.claim.statementsUsed).toContain(r.id)
  })

  it('rejects a dispute whose phase is missing or names no window (BAD_PHASE)', async () => {
    const { svc } = setup(NOW)
    const disputeWith = (phase?: string) => statement(W.dana, {
      kind: 'PRINCIPAL', type: 'party.dispute/1', engagementId: ENG, subject: { bookingId: 'ATL-60417' },
      claim: { ...(phase ? { phase } : {}), reason: 'x', bond: { currency: 'RLUSD', value: '10.00' }, evidenceHashes: [] },
      observedAt: '2026-11-18T09:30:00Z', issuedAt: '2026-11-18T09:30:00Z',
    })
    await expect(svc.ingest(ENG, disputeWith('late'))).rejects.toThrow(/BAD_PHASE/)
    await expect(svc.ingest(ENG, disputeWith())).rejects.toThrow(/BAD_PHASE/)
    expect(svc.statements(ENG)).toEqual([])
  })

  it('rejects at ingest what the policy pipeline rejects at the receipt ledger (REJECTED: <code>)', async () => {
    const { svc, source } = setup('2026-11-11T15:01:00Z')
    const futureObserved = statement(W.atlas, {
      kind: 'COUNTERPARTY', type: 'party.checkin/1', engagementId: ENG, subject: { bookingId: 'ATL-60417' },
      claim: { status: 'checked_in', room: '204', deposit: { currency: 'RLUSD', value: '150.00' } },
      observedAt: '2026-11-11T15:10:00Z', issuedAt: '2026-11-11T15:00:00Z',
    })
    await expect(svc.ingest(ENG, futureObserved)).rejects.toThrow(/REJECTED: FUTURE_DATED/)
    // The hotel's master key is disabled on the ledger; only its RegularKey may sign.
    source.snap.accounts[W.atlas.address] = { exists: true, masterDisabled: true, regularKey: W.stranger.address }
    await expect(svc.ingest(ENG, checkin('checked_in'))).rejects.toThrow(/REJECTED: KEY_NOT_AUTHORIZED/)
    expect(svc.statements(ENG)).toEqual([])
  })
})

// ── Pre-signed defaults and tick() (spec §5.4) ────────────────────────────────
type Json = Record<string, unknown>
type SignerEntry = { Signer: { Account: string; SigningPubKey: string; TxnSignature: string } }
const releaseTx = (opts: { lls?: number } = {}): Json => {
  const tx = hotel2Close([{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }, { to: W.dana.address, value: '150' }], { tickets: true, memos: [memo('eng/basis', 'default.release')] })
  return opts.lls ? { ...tx, LastLedgerSequence: opts.lls } : tx
}
const presign = (tx: Json, wallets = [W.dana, W.atlas]) => combine(wallets.map((w) => w.sign(structuredClone(tx) as never, true).tx_blob))
const signersOf = (blob: string) => (xrpl.decode(blob) as { Signers: SignerEntry[] }).Signers

/** Ingest the confirmation and the check-in at their posting times, then move the clock to `closeTime` with the deposit in. */
async function checkedIn(closeTime: string) {
  const { svc, source } = setup('2026-11-01T09:31:00Z')
  await svc.ingest(ENG, hotel2Confirmation())
  source.snap.closeTime = '2026-11-11T15:01:00Z'
  await svc.ingest(ENG, checkin('checked_in'))
  source.snap = hotel2Ledger({ balance: '562', closeTime })
  return { svc, source }
}

describe('co-signer pre-signed defaults and tick()', () => {
  it('stores a guest+hotel release blob and completes it once due', async () => {
    const { svc, source } = await checkedIn('2026-11-17T11:00:00Z')
    const stored = presign(releaseTx())
    svc.storePresigned(ENG, 'default.release', stored)

    const before = await svc.tick(ENG)
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({ outcome: 'default.release', stage: 'default.release', decision: 'REFUSE', failing: ['L1'] })
    expect(before[0].blob).toBeUndefined()
    expect(verifyStatement(before[0].record).ok).toBe(true)
    expect(svc.inflightFor(ENG)).toHaveLength(0)

    source.snap.closeTime = '2026-11-17T11:00:01Z'
    const [after] = await svc.tick(ENG)
    expect(after).toMatchObject({ outcome: 'default.release', decision: 'SIGN', failing: [] })
    expect(after.record.claim.decision).toBe('SIGN')
    const signers = signersOf(after.blob!)
    expect(new Set(signers.map((s) => s.Signer.Account))).toEqual(new Set([W.dana.address, W.atlas.address, W.cosigner.address]))
    const { Signers: _s, ...body } = xrpl.decode(after.blob!) as Json
    const { Signers: _t, ...storedBody } = xrpl.decode(stored) as Json
    void _s; void _t
    expect(body).toEqual(storedBody) // exactly the stored transaction, nothing re-built
    for (const { Signer: s } of signers) expect(keypairs.verify(encodeForMultisigning(body as never, s.Account), s.TxnSignature, s.SigningPubKey)).toBe(true)
    expect(svc.inflightFor(ENG)).toHaveLength(1)
  })

  it('tick twice returns the same blob, no second in-flight entry', async () => {
    const { svc } = await checkedIn('2026-11-17T12:00:00Z')
    svc.storePresigned(ENG, 'default.release', presign(releaseTx()))
    const [a] = await svc.tick(ENG)
    const decisions = svc.decisions(ENG).length
    const [b] = await svc.tick(ENG)
    expect(a.decision).toBe('SIGN')
    expect(b).toEqual(a)
    expect(svc.inflightFor(ENG)).toHaveLength(1)
    expect(svc.decisions(ENG)).toHaveLength(decisions) // not re-decided, not re-signed
  })

  it('tick re-decides once the in-flight default left the set (ticket consumed)', async () => {
    const { svc, source } = await checkedIn('2026-11-17T12:00:00Z')
    svc.storePresigned(ENG, 'default.release', presign(releaseTx()))
    const [a] = await svc.tick(ENG)
    expect(a.decision).toBe('SIGN')
    source.snap.accounts[W.engHotel2.address].ownerObjects!.tickets = source.snap.accounts[W.engHotel2.address].ownerObjects!.tickets.filter((t) => t !== 101)
    const [b] = await svc.tick(ENG)
    expect(b.record.id).not.toBe(a.record.id)
    expect(svc.inflightFor(ENG).filter((i) => i.decisionId === a.record.id)).toEqual([])
  })

  it('tick on a deleted account returns []', async () => {
    const { svc, source } = await checkedIn('2026-11-17T12:00:00Z')
    svc.storePresigned(ENG, 'default.release', presign(releaseTx()))
    source.snap.accounts[W.engHotel2.address].exists = false
    expect(await svc.tick(ENG)).toEqual([])
  })

  it('tick with nothing stored returns []', async () => {
    const { svc } = await checkedIn('2026-11-17T12:00:00Z')
    expect(await svc.tick(ENG)).toEqual([])
  })

  describe('storePresigned rejects', () => {
    const rejects = (fn: (svc: CosignerService) => void, re: RegExp) => {
      const { svc } = setup(NOW)
      expect(() => fn(svc)).toThrow(re)
      return svc
    }
    const nothingStored = async (svc: CosignerService) => expect(await svc.tick(ENG)).toEqual([])

    it('a blob signed by guest only', async () => {
      await nothingStored(rejects((svc) => svc.storePresigned(ENG, 'default.release', presign(releaseTx(), [W.dana])), /SIGNERS/))
    })
    it('a blob also carrying a stranger or the co-signer', async () => {
      await nothingStored(rejects((svc) => svc.storePresigned(ENG, 'default.release', presign(releaseTx(), [W.dana, W.atlas, W.stranger])), /SIGNERS/))
      await nothingStored(rejects((svc) => svc.storePresigned(ENG, 'default.release', presign(releaseTx(), [W.dana, W.atlas, W.cosigner])), /SIGNERS/))
    })
    it('a tampered signature', async () => {
      const tx = xrpl.decode(presign(releaseTx())) as Json & { Signers: SignerEntry[] }
      const sig = tx.Signers[0].Signer.TxnSignature
      tx.Signers[0].Signer.TxnSignature = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)
      await nothingStored(rejects((svc) => svc.storePresigned(ENG, 'default.release', xrpl.encode(tx as never)), /BAD_SIGNATURE/))
    })
    it('a signature over a different transaction (amounts changed after signing)', async () => {
      const tx = xrpl.decode(presign(releaseTx())) as Json & { RawTransactions: Array<{ RawTransaction: Json }> }
      tx.Memos = [memo('eng/basis', 'other')]
      await nothingStored(rejects((svc) => svc.storePresigned(ENG, 'default.release', xrpl.encode(tx as never)), /BAD_SIGNATURE/))
    })
    it('a close.split blob stored as default.release', async () => {
      const split = hotel2Close([{ to: W.atlas.address, value: '557.19' }, { to: W.service.address, value: '2.81' }], { tickets: true, memos: [memo('eng/basis', 'default.release')] })
      await nothingStored(rejects((svc) => svc.storePresigned(ENG, 'default.release', presign(split)), /BLUEPRINT/))
    })
    it('a blob with LastLedgerSequence, or without Tickets', async () => {
      await nothingStored(rejects((svc) => svc.storePresigned(ENG, 'default.release', presign(releaseTx({ lls: LEDGER_INDEX + 20 }))), /TICKETS/))
      const seq = hotel2Close([{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }, { to: W.dana.address, value: '150' }], { memos: [memo('eng/basis', 'default.release')] })
      await nothingStored(rejects((svc) => svc.storePresigned(ENG, 'default.release', presign(seq)), /TICKETS/))
    })
    it('an outcome that is not pre-signed, or unknown', async () => {
      await nothingStored(rejects((svc) => svc.storePresigned(ENG, 'settle.agreed', presign(releaseTx())), /NOT_PRESIGNED/))
      await nothingStored(rejects((svc) => svc.storePresigned(ENG, 'default.nope', presign(releaseTx())), /NOT_PRESIGNED/))
    })
    it('a blob for another account', async () => {
      const other = { ...releaseTx(), Account: W.engHotel.address }
      await nothingStored(rejects((svc) => svc.storePresigned(ENG, 'default.release', presign(other)), /WRONG_ACCOUNT/))
    })
  })

  it('HTTP routes store a blob and tick it', async () => {
    const { svc } = await checkedIn('2026-11-17T12:00:00Z')
    const server = createServer(svc).listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const bad = await fetch(`${base}/v1/engagements/${ENG}/presigned`, { method: 'POST', body: JSON.stringify({ outcome: 'default.release', blob: presign(releaseTx(), [W.dana]) }) })
      expect(bad.status).toBe(400)
      const ok = await fetch(`${base}/v1/engagements/${ENG}/presigned`, { method: 'POST', body: JSON.stringify({ outcome: 'default.release', blob: presign(releaseTx()) }) })
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({ ok: true })
      const t = await fetch(`${base}/v1/engagements/${ENG}/tick`, { method: 'POST' })
      expect(t.status).toBe(200)
      const [r] = (await t.json()) as TickResult[]
      expect(r).toMatchObject({ outcome: 'default.release', decision: 'SIGN' })
      expect(signersOf(r.blob!)).toHaveLength(3)
    } finally {
      server.close()
    }
  })
})
