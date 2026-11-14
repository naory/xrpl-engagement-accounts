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
  LEDGER_INDEX, NOW, W, b1Engagement, b1Mandate, checkin, claim, dispute, hotel2Confirmation, hotel2Close, hotel2Engagement, hotel2Ledger, hotel2Mandate, memo, policies, review, ruling, statement, templates,
} from '../../policy/test/fixtures.ts'

const ENG = 'eng_hotel2_fixture'

async function setup(closeTime: string) {
  const source = new FixtureLedgerSource(hotel2Ledger({ closeTime }))
  const svc = new CosignerService({ signer: localSigner(W.cosigner), source, templates: [templates.hotel2], policies: [policies.baseline, policies.hotel2] })
  await svc.register(hotel2Engagement(), hotel2Mandate())
  return { svc, source }
}

/** setup(), with the hotel's confirmation receipted before confirmBy; then the clock moves to `closeTime` (balance optional). */
async function confirmedSetup(closeTime: string, balance?: string) {
  const { svc, source } = await setup('2026-11-01T09:31:00Z')
  const conf = hotel2Confirmation()
  await svc.ingest(ENG, conf)
  source.snap = hotel2Ledger({ closeTime, ...(balance ? { balance } : {}) })
  return { svc, source, conf }
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
    const { svc, source, conf } = await confirmedSetup('2026-11-11T15:01:00Z', '562')
    const before = await svc.decide({ engagementId: ENG, stage: 'checkin' })
    expect(before.failing).toContain('K1')
    const s = checkin('checked_in')
    const r = await svc.ingest(ENG, s)
    expectReceiptFor(r, s, '2026-11-11T15:01:00Z')
    expect(svc.statements(ENG).map((x) => x.id)).toEqual([conf.id, s.id])
    source.snap.closeTime = '2026-11-11T15:05:00Z'
    const after = await svc.decide({ engagementId: ENG, stage: 'checkin' })
    expect(after.failing).not.toContain('K1')
  })

  it('decide() deduplicates stored and request statements by id', async () => {
    const { svc } = await confirmedSetup('2026-11-11T15:01:00Z', '562')
    const s = checkin('checked_in')
    await svc.ingest(ENG, s)
    const d = await svc.decide({ engagementId: ENG, stage: 'checkin', statements: [s] })
    expect(d.failing).not.toContain('K1')
    expect(d.statementsRejected).toEqual([])
    expect((d.record.claim.statementsUsed as string[]).filter((id) => id === s.id)).toEqual([s.id])
  })

  it('is idempotent: the same statement twice returns the first receipt and is stored once', async () => {
    const { svc, source } = await setup('2026-11-11T15:01:00Z')
    const s = checkin('checked_in')
    const r1 = await svc.ingest(ENG, s)
    source.snap.closeTime = '2026-11-11T23:30:00Z' // even past checkInBy, a re-post returns the original receipt
    source.snap.index = LEDGER_INDEX + 99
    const r2 = await svc.ingest(ENG, s)
    expect(r2).toEqual(r1)
    expect(svc.statements(ENG)).toHaveLength(1)
  })

  it('rejects a claim posted after claimBy', async () => {
    const { svc } = await setup('2026-11-15T11:00:01Z')
    await expect(svc.ingest(ENG, claimAt('2026-11-15T11:00:00Z', [{ amount: '40.00' }], '40.00'))).rejects.toThrow(/LATE: party\.claim\/1 after claimBy/)
    await expect(svc.ingest(ENG, claim([{ kind: 'minibar', amount: '40.00' }]))).rejects.toThrow(/LATE/)
    expect(svc.statements(ENG)).toEqual([])
  })

  it('accepts a claim received exactly at claimBy (windows are inclusive)', async () => {
    const { svc } = await confirmedSetup('2026-11-15T11:00:00Z')
    const s = claimAt('2026-11-15T10:59:00Z', [{ amount: '40.00' }], '40.00')
    expectReceiptFor(await svc.ingest(ENG, s), s, '2026-11-15T11:00:00Z')
    expect(svc.statements(ENG)).toHaveLength(2)
  })

  it('picks the window by dispute phase (type#phase)', async () => {
    // 2026-11-15: past entryDisputeBy (11-12T11:00) but inside disputeWindowEnds (11-17T11:00); Credential + bond posted.
    const { svc, source } = await setup('2026-11-15T10:00:00Z')
    source.snap = hotel2Ledger({ closeTime: '2026-11-15T10:00:00Z', dispute: true, balance: '422' })
    await expect(svc.ingest(ENG, dispute('entry', '2026-11-15T09:59:00Z'))).rejects.toThrow(/LATE: party\.dispute\/1 after entryDisputeBy/)
    const s = dispute('settlement', '2026-11-15T09:59:00Z')
    expectReceiptFor(await svc.ingest(ENG, s), s, '2026-11-15T10:00:00Z')
    expect(svc.statements(ENG).map((x) => x.id)).toEqual([s.id])
  })

  it('rejects a statement issued more than 300 s before it is received (backdating)', async () => {
    const { svc, source } = await setup('2026-11-16T10:05:01Z')
    source.snap = hotel2Ledger({ closeTime: '2026-11-16T10:05:01Z', dispute: true, balance: '422' })
    await expect(svc.ingest(ENG, dispute('settlement', '2026-11-16T10:00:00Z'))).rejects.toThrow(/STALE_ISSUED/)
    const s = dispute('settlement', '2026-11-16T10:00:01Z') // exactly 300 s: accepted
    expectReceiptFor(await svc.ingest(ENG, s), s, '2026-11-16T10:05:01Z')
    expect(svc.statements(ENG).map((x) => x.id)).toEqual([s.id])
  })

  it('rejects a claim whose total is not the exact sum of its items', async () => {
    const { svc, conf } = await confirmedSetup('2026-11-14T15:01:00Z')
    await expect(svc.ingest(ENG, claimAt('2026-11-14T15:00:00Z', [{ amount: '0.10' }, { amount: '0.20' }], '0.30000001'))).rejects.toThrow(/CLAIM_TOTAL/)
    await expect(svc.ingest(ENG, claimAt('2026-11-14T15:00:00Z', [{ amount: '40.00' }, { amount: '25.50' }], '65.49'))).rejects.toThrow(/CLAIM_TOTAL/)
    expect(svc.statements(ENG)).toEqual([conf])
    const s = claimAt('2026-11-14T15:00:00Z', [{ amount: '0.10' }, { amount: '0.20' }], '0.3')
    expectReceiptFor(await svc.ingest(ENG, s), s, '2026-11-14T15:01:00Z')
  })

  it('rejects a statement from a non-party', async () => {
    const { svc } = await setup('2026-11-11T15:01:00Z')
    const s = statement(W.stranger, {
      kind: 'COUNTERPARTY', type: 'party.checkin/1', engagementId: ENG, subject: { bookingId: 'ATL-60417' },
      claim: { status: 'checked_in', room: '204', deposit: { currency: 'RLUSD', value: '150.00' } },
      observedAt: '2026-11-11T15:00:00Z', issuedAt: '2026-11-11T15:00:00Z',
    })
    await expect(svc.ingest(ENG, s)).rejects.toThrow(/NOT_A_PARTY/)
    expect(svc.statements(ENG)).toEqual([])
  })

  it('rejects a statement for another engagement', async () => {
    const { svc } = await setup('2026-11-11T15:01:00Z')
    const s = statement(W.atlas, {
      kind: 'COUNTERPARTY', type: 'party.checkin/1', engagementId: 'eng_other', subject: { bookingId: 'ATL-60417' },
      claim: { status: 'checked_in', room: '204', deposit: { currency: 'RLUSD', value: '150.00' } },
      observedAt: '2026-11-11T15:00:00Z', issuedAt: '2026-11-11T15:00:00Z',
    })
    await expect(svc.ingest(ENG, s)).rejects.toThrow(/WRONG_ENGAGEMENT/)
    expect(svc.statements(ENG)).toEqual([])
  })

  it('rejects a statement whose signature does not verify', async () => {
    const { svc } = await setup('2026-11-11T15:01:00Z')
    const s = checkin('checked_in')
    await expect(svc.ingest(ENG, { ...s, claim: { ...s.claim, status: 'refused' } })).rejects.toThrow(/BAD_STATEMENT/)
    expect(svc.statements(ENG)).toEqual([])
  })

  it('HTTP route stores and returns the receipt', async () => {
    const { svc } = await setup('2026-11-11T15:01:00Z')
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
    const { svc, source } = await setup('2026-11-11T15:01:00Z')
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
    const { svc, source } = await confirmedSetup('2026-11-14T15:01:00Z')
    const c = claim([{ kind: 'minibar', amount: '40.00' }])
    await svc.ingest(ENG, c)
    source.snap.closeTime = NOW
    const d = await svc.decide({ engagementId: ENG, stage: 'default.release', statements: [c] })
    expect(d.results.find((r) => r.id === 'L5')?.result).toBe('fail')
    expect(d.statementsRejected.filter((r) => r.id === c.id)).toEqual([])
    expect((d.record.claim.statementsUsed as string[]).filter((id) => id === c.id)).toEqual([c.id])
  })

  it('decide() still accepts non-governed statements passed only in the request (review)', async () => {
    const { svc } = await setup(NOW)
    const r = review(W.dana, ENG)
    const d = await svc.decide({ engagementId: ENG, stage: 'default.release', statements: [r] })
    expect(d.statementsRejected).toEqual([])
    expect(d.record.claim.statementsUsed).toContain(r.id)
  })

  it('rejects a dispute whose phase is missing or names no window (BAD_PHASE)', async () => {
    const { svc } = await setup(NOW)
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
    const { svc, source } = await setup('2026-11-11T15:01:00Z')
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
  const { svc, source } = await setup('2026-11-01T09:31:00Z')
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
    await svc.storePresigned(ENG, 'default.release', stored)

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
    await svc.storePresigned(ENG, 'default.release', presign(releaseTx()))
    const [a] = await svc.tick(ENG)
    const decisions = svc.decisions(ENG).length
    const [b] = await svc.tick(ENG)
    expect(a.decision).toBe('SIGN')
    expect(b).toEqual(a)
    expect(svc.inflightFor(ENG)).toHaveLength(1)
    expect(svc.decisions(ENG)).toHaveLength(decisions) // not re-decided, not re-signed
  })

  const signRecords = (svc: CosignerService) => svc.decisions(ENG).filter((d) => d.claim.decision === 'SIGN').length
  const burn = (source: FixtureLedgerSource, ticket: number) => {
    const o = source.snap.accounts[W.engHotel2.address].ownerObjects!
    o.tickets = o.tickets.filter((t) => t !== ticket)
  }

  it('retires a default whose outer ticket was consumed: TICKET_CONSUMED once, never re-signed (R22)', async () => {
    const { svc, source } = await checkedIn('2026-11-17T12:00:00Z')
    await svc.storePresigned(ENG, 'default.release', presign(releaseTx()))
    const [a] = await svc.tick(ENG)
    expect(a.decision).toBe('SIGN')
    expect(signRecords(svc)).toBe(1)
    burn(source, 101) // e.g. a burned ALLORNOTHING submission
    const [b] = await svc.tick(ENG)
    expect(b).toMatchObject({ outcome: 'default.release', stage: 'default.release', decision: 'REFUSE', failing: ['TICKET_CONSUMED'] })
    expect(b.blob).toBeUndefined()
    expect(verifyStatement(b.record).ok).toBe(true)
    expect(b.record.claim.failing).toEqual(['TICKET_CONSUMED'])
    expect(svc.inflightFor(ENG)).toEqual([])
    expect(await svc.tick(ENG)).toEqual([])
    expect(signRecords(svc)).toBe(1) // no new SIGN after the ticket is consumed
  })

  it('retires a default when one of its inner tickets is gone, before ever signing', async () => {
    const { svc, source } = await checkedIn('2026-11-17T12:00:00Z')
    await svc.storePresigned(ENG, 'default.release', presign(releaseTx()))
    burn(source, 104)
    const [r] = await svc.tick(ENG)
    expect(r).toMatchObject({ decision: 'REFUSE', failing: ['TICKET_CONSUMED'] })
    expect(signRecords(svc)).toBe(0)
    expect(svc.inflightFor(ENG)).toEqual([])
  })

  it('storePresigned refuses to overwrite an outcome with a SIGN in flight (R23)', async () => {
    const { svc } = await checkedIn('2026-11-17T12:00:00Z')
    const first = presign(releaseTx())
    await svc.storePresigned(ENG, 'default.release', first)
    const [a] = await svc.tick(ENG)
    expect(a.decision).toBe('SIGN')
    const other = presign({ ...releaseTx(), Memos: [memo('eng/basis', 'default.release'), memo('x', 'y')] })
    await expect(svc.storePresigned(ENG, 'default.release', other)).rejects.toThrow(/IN_FLIGHT/)
    await svc.storePresigned(ENG, 'default.release', first) // re-storing the same blob is a no-op
    const [b] = await svc.tick(ENG)
    expect(b).toEqual(a)
    expect(svc.inflightFor(ENG)).toHaveLength(1)
  })

  it('normalizes a blob with an outer SigningPubKey or TxnSignature; a later tick neither throws nor orphans (R21)', async () => {
    for (const poison of [{ SigningPubKey: W.dana.publicKey }, { TxnSignature: 'AB'.repeat(35) }]) {
      const { svc } = await checkedIn('2026-11-17T12:00:00Z')
      const good = presign(releaseTx())
      await svc.storePresigned(ENG, 'default.release', xrpl.encode({ ...(xrpl.decode(good) as Json), ...poison } as never))
      const [r] = await svc.tick(ENG)
      expect(r.decision).toBe('SIGN')
      const out = xrpl.decode(r.blob!) as Json
      expect(out.SigningPubKey).toBe('')
      expect(out.TxnSignature).toBeUndefined()
      expect(signersOf(r.blob!)).toHaveLength(3)
      expect(svc.inflightFor(ENG)).toHaveLength(1)
    }
  })

  it('isolates a failing outcome in tick: error result, no orphaned in-flight entry, others still evaluated', async () => {
    const { svc } = await checkedIn('2026-11-17T12:00:00Z')
    await svc.storePresigned(ENG, 'default.refund', presign(hotel2Close([{ to: W.dana.address, value: '562' }], { tickets: true, memos: [memo('eng/basis', 'default.refund')] })))
    // Bypass storePresigned's normalization to plant a blob that combine() rejects after policy SIGNs.
    const poisoned = xrpl.encode({ ...(xrpl.decode(presign(releaseTx())) as Json), SigningPubKey: W.dana.publicKey } as never)
    ;(svc as unknown as { engagements: Map<string, { presigned: Map<string, string> }> }).engagements.get(ENG)!.presigned.set('default.release', poisoned)
    const results = await svc.tick(ENG)
    const byOutcome = Object.fromEntries(results.map((r) => [r.outcome, r]))
    expect(byOutcome['default.refund'].decision).toBe('REFUSE')
    expect(byOutcome['default.refund'].failing).not.toContain('TICK_ERROR')
    expect(byOutcome['default.release']).toMatchObject({ decision: 'REFUSE', failing: ['TICK_ERROR'] })
    expect(byOutcome['default.release'].blob).toBeUndefined()
    expect(verifyStatement(byOutcome['default.release'].record).ok).toBe(true)
    expect(svc.inflightFor(ENG)).toEqual([])
    await expect(svc.tick(ENG)).resolves.toHaveLength(2)
    expect(svc.inflightFor(ENG)).toEqual([])
  })

  it('tick on a deleted account returns []', async () => {
    const { svc, source } = await checkedIn('2026-11-17T12:00:00Z')
    await svc.storePresigned(ENG, 'default.release', presign(releaseTx()))
    source.snap.accounts[W.engHotel2.address].exists = false
    expect(await svc.tick(ENG)).toEqual([])
  })

  it('tick with nothing stored returns []', async () => {
    const { svc } = await checkedIn('2026-11-17T12:00:00Z')
    expect(await svc.tick(ENG)).toEqual([])
  })

  describe('storePresigned rejects', () => {
    const rejects = async (fn: (svc: CosignerService) => Promise<void>, re: RegExp) => {
      const { svc } = await setup(NOW)
      await expect(fn(svc)).rejects.toThrow(re)
      return svc
    }
    const nothingStored = async (svc: CosignerService) => expect(await svc.tick(ENG)).toEqual([])

    it('a blob signed by guest only', async () => {
      await nothingStored(await rejects((svc) => svc.storePresigned(ENG, 'default.release', presign(releaseTx(), [W.dana])), /SIGNERS/))
    })
    it('a blob also carrying a stranger or the co-signer', async () => {
      await nothingStored(await rejects((svc) => svc.storePresigned(ENG, 'default.release', presign(releaseTx(), [W.dana, W.atlas, W.stranger])), /SIGNERS/))
      await nothingStored(await rejects((svc) => svc.storePresigned(ENG, 'default.release', presign(releaseTx(), [W.dana, W.atlas, W.cosigner])), /SIGNERS/))
    })
    it('a tampered signature', async () => {
      const tx = xrpl.decode(presign(releaseTx())) as Json & { Signers: SignerEntry[] }
      const sig = tx.Signers[0].Signer.TxnSignature
      tx.Signers[0].Signer.TxnSignature = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)
      await nothingStored(await rejects((svc) => svc.storePresigned(ENG, 'default.release', xrpl.encode(tx as never)), /BAD_SIGNATURE/))
    })
    it('a signature over a different transaction (memo changed after signing)', async () => {
      const tx = xrpl.decode(presign(releaseTx())) as Json & { RawTransactions: Array<{ RawTransaction: Json }> }
      tx.Memos = [memo('eng/basis', 'other')]
      await nothingStored(await rejects((svc) => svc.storePresigned(ENG, 'default.release', xrpl.encode(tx as never)), /BAD_SIGNATURE/))
    })
    it('a close.split blob stored as default.release', async () => {
      const split = hotel2Close([{ to: W.atlas.address, value: '557.19' }, { to: W.service.address, value: '2.81' }], { tickets: true, memos: [memo('eng/basis', 'default.release')] })
      await nothingStored(await rejects((svc) => svc.storePresigned(ENG, 'default.release', presign(split)), /BLUEPRINT/))
    })
    it('a blob with LastLedgerSequence, or without Tickets', async () => {
      await nothingStored(await rejects((svc) => svc.storePresigned(ENG, 'default.release', presign(releaseTx({ lls: LEDGER_INDEX + 20 }))), /TICKETS/))
      const seq = hotel2Close([{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }, { to: W.dana.address, value: '150' }], { memos: [memo('eng/basis', 'default.release')] })
      await nothingStored(await rejects((svc) => svc.storePresigned(ENG, 'default.release', presign(seq)), /TICKETS/))
    })
    it('an outcome that is not pre-signed, or unknown', async () => {
      await nothingStored(await rejects((svc) => svc.storePresigned(ENG, 'settle.agreed', presign(releaseTx())), /NOT_PRESIGNED/))
      await nothingStored(await rejects((svc) => svc.storePresigned(ENG, 'default.nope', presign(releaseTx())), /NOT_PRESIGNED/))
    })
    it('a blob for another account', async () => {
      const other = { ...releaseTx(), Account: W.engHotel.address }
      await nothingStored(await rejects((svc) => svc.storePresigned(ENG, 'default.release', presign(other)), /WRONG_ACCOUNT/))
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

// ── Final-review fixes: no side wins by silence or timing (R28–R35) ───────────
describe('co-signer closes the last silence/timing wins', () => {
  const refundTx = () => hotel2Close([{ to: W.dana.address, value: '412' }], { tickets: true, memos: [memo('eng/basis', 'default.refund')] })
  const noshowTx = () => hotel2Close([{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }], { tickets: true, memos: [memo('eng/basis', 'default.noshow')] })
  const confirmationAt = (t: string, deposit = '150.00') => {
    const c = hotel2Confirmation({ deposit })
    return statement(W.atlas, { kind: 'COUNTERPARTY', type: 'party.confirmation/1', engagementId: ENG, subject: c.subject, claim: c.claim, observedAt: t, issuedAt: t })
  }
  const checkinAt = (status: 'checked_in' | 'refused', t: string) => statement(W.atlas, {
    kind: 'COUNTERPARTY', type: 'party.checkin/1', engagementId: ENG, subject: { bookingId: 'ATL-60417' },
    claim: { status, room: '204', deposit: { currency: 'RLUSD', value: '150.00' } }, observedAt: t, issuedAt: t,
  })

  it('R28: a confirmation after confirmBy is LATE, and default.refund still completes', async () => {
    const { svc, source } = await setup('2026-11-01T12:01:00Z')
    await svc.storePresigned(ENG, 'default.refund', presign(refundTx()))
    await expect(svc.ingest(ENG, confirmationAt('2026-11-01T12:00:00Z'))).rejects.toThrow(/LATE: party\.confirmation\/1 after confirmBy/)
    expect(svc.statements(ENG)).toEqual([])
    source.snap.closeTime = '2026-11-01T12:02:00Z'
    const [r] = await svc.tick(ENG)
    expect(r).toMatchObject({ outcome: 'default.refund', decision: 'SIGN', failing: [] })
  })

  it('R28: a second confirmation is ALREADY_CONFIRMED and never stored', async () => {
    const { svc, source } = await confirmedSetup('2026-11-01T09:45:00Z')
    await expect(svc.ingest(ENG, confirmationAt('2026-11-01T09:44:00Z', '100.00'))).rejects.toThrow(/ALREADY_CONFIRMED/)
    source.snap.closeTime = '2026-11-11T15:01:00Z' // after confirmBy it is LATE first
    await expect(svc.ingest(ENG, confirmationAt('2026-11-11T15:00:00Z', '100.00'))).rejects.toThrow(/LATE/)
    expect(svc.statements(ENG).map((s) => s.type)).toEqual(['party.confirmation/1'])
  })

  it('R29a: a hotel-only checked_in with no deposit paid does not block the no-show', async () => {
    const { svc, source } = await confirmedSetup('2026-11-11T15:01:00Z')
    await svc.storePresigned(ENG, 'default.noshow', presign(noshowTx()))
    await svc.ingest(ENG, checkin('checked_in'))
    source.snap.closeTime = '2026-11-12T12:00:00Z'
    const [r] = await svc.tick(ENG)
    expect(r).toMatchObject({ outcome: 'default.noshow', decision: 'SIGN', failing: [] })
  })

  it('CHECKIN_FINAL: after a receipted checked_in, a later refused is rejected; a checked-in stay cannot be no-showed', async () => {
    const { svc, source } = await confirmedSetup('2026-11-11T15:01:00Z', '562') // room + full deposit
    await svc.ingest(ENG, checkin('checked_in'))
    await svc.storePresigned(ENG, 'default.noshow', presign(noshowTx()))
    const sweep = hotel2Close([{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }, { to: W.dana.address, value: '0', partial: true }], { tickets: true, memos: [memo('eng/basis', 'default.noshowSweep')] })
    await svc.storePresigned(ENG, 'default.noshowSweep', presign(sweep))
    source.snap.closeTime = '2026-11-11T22:59:00Z' // just before checkInBy
    await expect(svc.ingest(ENG, checkinAt('refused', '2026-11-11T22:58:30Z'))).rejects.toThrow(/CHECKIN_FINAL/)
    expect(svc.statements(ENG).filter((s) => s.type === 'party.checkin/1').map((s) => (s.claim as { status: string }).status)).toEqual(['checked_in'])
    source.snap.closeTime = '2026-11-12T11:00:01Z' // past checkInBy and entryDisputeBy
    const byOutcome = Object.fromEntries((await svc.tick(ENG)).map((r) => [r.outcome, r]))
    for (const o of ['default.noshow', 'default.noshowSweep']) {
      expect(byOutcome[o].decision).toBe('REFUSE')
      expect(byOutcome[o].failing).toContain('N3')
    }
  })

  it('CHECKIN_FINAL applies even before the deposit lands; a refused with no prior checked_in is accepted', async () => {
    const { svc, source } = await confirmedSetup('2026-11-11T15:01:00Z')
    await svc.ingest(ENG, checkin('checked_in')) // no deposit yet
    source.snap.closeTime = '2026-11-11T15:06:00Z'
    await expect(svc.ingest(ENG, checkinAt('refused', '2026-11-11T15:05:00Z'))).rejects.toThrow(/CHECKIN_FINAL/)
    const other = await confirmedSetup('2026-11-11T15:01:00Z', '452')
    const r = await other.svc.ingest(ENG, checkinAt('refused', '2026-11-11T15:00:00Z'))
    expect(r.statement.subject.statementType).toBe('party.checkin/1')
  })

  it('R29b: a checked_in after a receipted entry dispute is ENTRY_DISPUTED; the dispute keeps counting', async () => {
    const { svc, source } = await confirmedSetup('2026-11-11T14:31:00Z')
    source.snap = hotel2Ledger({ closeTime: '2026-11-11T14:31:00Z', dispute: true, balance: '422' })
    await svc.ingest(ENG, dispute('entry', '2026-11-11T14:30:00Z'))
    source.snap.closeTime = '2026-11-11T15:01:00Z'
    await expect(svc.ingest(ENG, checkin('checked_in'))).rejects.toThrow(/ENTRY_DISPUTED/)
    expect(svc.statements(ENG).some((s) => s.type === 'party.checkin/1')).toBe(false)
    // A refusal is still recordable (it does not deny the dispute).
    await svc.ingest(ENG, checkin('refused'))
    source.snap.closeTime = '2026-11-21T00:00:00Z'
    // the arbiter never ruled: past its deadline the entry chargeback returns everything (room + bond) to the guest
    const sweep = [{ to: W.dana.address, value: '0', partial: true }]
    const d = await svc.decide({ engagementId: ENG, stage: 'default.chargebackEntry', tx: hotel2Close(sweep, { tickets: true, memos: [memo('eng/basis', 'default.chargebackEntry')] }) })
    expect(d.failing).toEqual([])
  })

  it('R38: only the hotel confirms — a guest-posted confirmation is NOT_COUNTERPARTY and cannot lock the hotel out', async () => {
    const { svc, source } = await setup('2026-11-01T09:31:00Z')
    const c = hotel2Confirmation()
    const byGuest = statement(W.dana, { kind: 'PRINCIPAL', type: 'party.confirmation/1', engagementId: ENG, subject: c.subject, claim: c.claim, observedAt: '2026-11-01T09:30:00Z', issuedAt: '2026-11-01T09:30:00Z' })
    await expect(svc.ingest(ENG, byGuest)).rejects.toThrow(/NOT_COUNTERPARTY/)
    await svc.ingest(ENG, c)
    expect(svc.statements(ENG)).toEqual([c])
    source.snap.closeTime = '2026-11-01T12:01:00Z'
    const d = await svc.decide({ engagementId: ENG, stage: 'default.refund', tx: refundTx() })
    expect(d.failing).toContain('R1')
  })

  it('R39b: an entry dispute received before checkIn is TOO_EARLY', async () => {
    const { svc, source } = await confirmedSetup('2026-11-02T10:01:00Z')
    await expect(svc.ingest(ENG, dispute('entry', '2026-11-02T10:00:00Z'))).rejects.toThrow(/TOO_EARLY/)
    source.snap = hotel2Ledger({ closeTime: '2026-11-11T13:59:59Z', dispute: true, balance: '422' })
    await expect(svc.ingest(ENG, dispute('entry', '2026-11-11T13:59:00Z'))).rejects.toThrow(/TOO_EARLY/) // bonded but still early
    source.snap.closeTime = '2026-11-11T14:00:00Z' // from checkIn on (inclusive)
    await svc.ingest(ENG, dispute('entry', '2026-11-11T13:59:30Z'))
    expect(svc.statements(ENG).filter((x) => x.type === 'party.dispute/1')).toHaveLength(1)
  })

  it('R39a/R12: an entry dispute without the Credential and bond is NOT_BONDED (never receipted) and does not freeze check-in', async () => {
    for (const ledger of [{ dispute: false, balance: '422' }, { dispute: true, balance: '412' }]) {
      const { svc, source } = await confirmedSetup('2026-11-11T14:31:00Z')
      source.snap = hotel2Ledger({ closeTime: '2026-11-11T14:31:00Z', ...ledger })
      await expect(svc.ingest(ENG, dispute('entry', '2026-11-11T14:30:00Z'))).rejects.toThrow(/NOT_BONDED/)
      expect(svc.statements(ENG).some((x) => x.type === 'party.dispute/1')).toBe(false)
      source.snap.closeTime = '2026-11-11T15:01:00Z'
      const ci = checkin('checked_in')
      const r = await svc.ingest(ENG, ci)
      expect(r.statement.subject.statementId).toBe(ci.id)
    }
  })

  it('R39a: with the Credential and the bond on the ledger, checked_in is ENTRY_DISPUTED', async () => {
    const { svc, source } = await confirmedSetup('2026-11-11T14:31:00Z')
    source.snap = hotel2Ledger({ closeTime: '2026-11-11T14:31:00Z', dispute: true, balance: '422' })
    await svc.ingest(ENG, dispute('entry', '2026-11-11T14:30:00Z'))
    source.snap.closeTime = '2026-11-11T15:01:00Z'
    await expect(svc.ingest(ENG, checkin('checked_in'))).rejects.toThrow(/ENTRY_DISPUTED/)
  })

  it('R30: re-registering the identical record keeps all state; a different record is ALREADY_REGISTERED', async () => {
    const { svc } = await confirmedSetup('2026-11-11T15:01:00Z')
    await svc.ingest(ENG, checkin('checked_in'))
    await svc.storePresigned(ENG, 'default.noshow', presign(noshowTx()))
    expect((await svc.register(hotel2Engagement(), hotel2Mandate())).ok).toBe(true)
    expect(svc.statements(ENG)).toHaveLength(2)
    expect(await svc.tick(ENG)).toHaveLength(1) // the stored default survived
    await expect(svc.register(hotel2Engagement({ amount: { asset: 'RLUSD', value: '1.00' } }), hotel2Mandate())).rejects.toThrow(/ALREADY_REGISTERED/)
    await expect(svc.register(hotel2Engagement(), null)).rejects.toThrow(/ALREADY_REGISTERED/)
    expect(svc.statements(ENG)).toHaveLength(2)
    expect(svc.engagement(ENG)!.amount?.value).toBe('412.00')
  })

  it('R31: GET /v1/engagements/:id/attestations returns statements with their receipts, behind auth', async () => {
    const { svc } = await confirmedSetup('2026-11-11T15:01:00Z')
    const receipt = await svc.ingest(ENG, checkin('checked_in'))
    const server = createServer(svc, { token: 'tok', rateLimit: { windowMs: 60_000, max: 3 } }).listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const auth = { authorization: 'Bearer tok' }
    try {
      expect((await fetch(`${base}/v1/engagements/${ENG}/attestations`)).status).toBe(401)
      const ok = await fetch(`${base}/v1/engagements/${ENG}/attestations`, { headers: auth })
      expect(ok.status).toBe(200)
      const list = (await ok.json()) as Array<{ statement: Statement; receipt: Receipt }>
      expect(list.map((a) => a.statement.type)).toEqual(['party.confirmation/1', 'party.checkin/1'])
      expect(list[1].receipt).toEqual(receipt)
      expect(list.every((a) => verifyStatement(a.receipt.statement).ok && a.receipt.statement.subject.statementId === a.statement.id)).toBe(true)
      expect((await fetch(`${base}/v1/engagements/nope/attestations`, { headers: auth })).status).toBe(404)
      expect((await fetch(`${base}/v1/engagements/${ENG}/attestations`, { headers: auth })).status).toBe(429)
    } finally {
      server.close()
    }
  })

  it('R32: storePresigned waits for the per-engagement lock (a replacement cannot slip in before a pending tick signs)', async () => {
    const { svc } = await checkedIn('2026-11-17T12:00:00Z')
    await svc.storePresigned(ENG, 'default.release', presign(releaseTx()))
    const other = presign({ ...releaseTx(), Memos: [memo('eng/basis', 'default.release'), memo('x', 'y')] })
    const ticking = svc.tick(ENG)
    const replacing = svc.storePresigned(ENG, 'default.release', other)
    const [a] = await ticking
    expect(a.decision).toBe('SIGN')
    await expect(replacing).rejects.toThrow(/IN_FLIGHT/)
  })

  it('R33: claims must be itemized, positive and within the confirmed deposit', async () => {
    const t = '2026-11-14T15:00:00Z'
    const { svc } = await confirmedSetup('2026-11-14T15:01:00Z')
    await expect(svc.ingest(ENG, claimAt(t, [], '0'))).rejects.toThrow(/CLAIM_INVALID/)
    await expect(svc.ingest(ENG, claimAt(t, [{ amount: '0' }], '0'))).rejects.toThrow(/CLAIM_INVALID/)
    await expect(svc.ingest(ENG, claimAt(t, [{ amount: '60.00' }, { amount: '-10.00' }], '50.00'))).rejects.toThrow(/CLAIM_INVALID/)
    await expect(svc.ingest(ENG, claimAt(t, [{ amount: '100.00' }, { amount: '50.01' }], '150.01'))).rejects.toThrow(/CLAIM_OVER_DEPOSIT/)
    const exact = claimAt(t, [{ amount: '100.00' }, { amount: '50.00' }], '150.00')
    expectReceiptFor(await svc.ingest(ENG, exact), exact, '2026-11-14T15:01:00Z')
    expect(svc.statements(ENG).filter((s) => s.type === 'party.claim/1')).toEqual([exact])
    const { svc: unconfirmed } = await setup('2026-11-14T15:01:00Z')
    await expect(unconfirmed.ingest(ENG, claimAt(t, [{ amount: '1.00' }], '1.00'))).rejects.toThrow(/CLAIM_OVER_DEPOSIT/)
  })

  it('R35: tick skips the Ticket check when the snapshot has no owner objects (does not retire)', async () => {
    const { svc, source } = await checkedIn('2026-11-17T12:00:00Z')
    await svc.storePresigned(ENG, 'default.release', presign(releaseTx()))
    const owned = source.snap.accounts[W.engHotel2.address].ownerObjects
    delete source.snap.accounts[W.engHotel2.address].ownerObjects
    const [a] = await svc.tick(ENG)
    expect(a.failing).not.toContain('TICKET_CONSUMED')
    source.snap.accounts[W.engHotel2.address].ownerObjects = owned
    const again = await svc.tick(ENG)
    expect(again).toHaveLength(1) // still stored
    expect(again[0].outcome).toBe('default.release')
  })
})

// ── Automatic endings return extra money to the guest (residual sweep) ───────
describe('co-signer: automatic endings sweep extra money back to the guest', () => {
  const sweep = { to: W.dana.address, value: '0', partial: true }
  const room = [{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }]
  const tx = (payouts: Array<{ to: string; value: string; partial?: boolean }>, basis: string) => hotel2Close(payouts, { tickets: true, memos: [memo('eng/basis', basis)] })
  const presign2 = (t: Json) => combine([W.dana, W.atlas].map((w) => w.sign(structuredClone(t) as never, true).tx_blob))
  const byOutcome = (rs: TickResult[]) => Object.fromEntries(rs.map((r) => [r.outcome, r]))
  const refusedAt = (t: string) => statement(W.atlas, {
    kind: 'COUNTERPARTY', type: 'party.checkin/1', engagementId: ENG, subject: { bookingId: 'ATL-60417' },
    claim: { status: 'refused', room: '204', deposit: { currency: 'RLUSD', value: '150.00' } }, observedAt: t, issuedAt: t,
  })
  /** Inner Payments of a completed blob: [destination, partial?]. */
  const pays = (blob: string) => ((xrpl.decode(blob) as { RawTransactions: Array<{ RawTransaction: Json }> }).RawTransactions)
    .map((r) => r.RawTransaction).filter((i) => i.TransactionType === 'Payment').map((i) => [i.Destination, (Number(i.Flags) & 0x00020000) !== 0])

  async function storeNoShows(svc: CosignerService) {
    await svc.storePresigned(ENG, 'default.noshow', presign2(tx(room, 'default.noshow')))
    await svc.storePresigned(ENG, 'default.noshowSweep', presign2(tx([...room, sweep], 'default.noshowSweep')))
  }

  it('partial deposit + refused check-in: the sweep no-show SIGNs (hotel room less fee, fee, guest gets the 40 back); the exact one REFUSEs', async () => {
    const { svc, source } = await confirmedSetup('2026-11-11T15:01:00Z', '452') // room 412 + a partial deposit of 40
    await storeNoShows(svc)
    await svc.ingest(ENG, refusedAt('2026-11-11T15:00:00Z'))
    source.snap.closeTime = '2026-11-12T11:00:01Z' // past checkInBy and entryDisputeBy
    const r = byOutcome(await svc.tick(ENG))
    expect(r['default.noshow']).toMatchObject({ decision: 'REFUSE' })
    expect(r['default.noshow'].failing).toContain('N8')
    expect(r['default.noshowSweep']).toMatchObject({ stage: 'default.noshow', decision: 'SIGN' })
    expect(r['default.noshowSweep'].failing).toEqual([])
    expect(pays(r['default.noshowSweep'].blob!)).toEqual([[W.atlas.address, false], [W.service.address, false], [W.dana.address, true]])
    expect(signersOf(r['default.noshowSweep'].blob!)).toHaveLength(3)
  })

  it('no extra money: the exact no-show SIGNs; the sweep one REFUSEs because the sweep would deliver nothing (B11)', async () => {
    const { svc, source } = await confirmedSetup('2026-11-11T15:01:00Z')
    await storeNoShows(svc)
    source.snap.closeTime = '2026-11-12T11:00:01Z'
    const r = byOutcome(await svc.tick(ENG))
    expect(r['default.noshow']).toMatchObject({ decision: 'SIGN', failing: [] })
    expect(r['default.noshowSweep'].decision).toBe('REFUSE')
    expect(r['default.noshowSweep'].failing).toContain('B11')
    expect(r['default.noshowSweep'].blob).toBeUndefined()
  })

  it('stray 1 RLUSD on an unconfirmed booking: the refund SIGNs and sweeps room + 1 to the guest', async () => {
    const { svc, source } = await setup('2026-11-01T09:31:00Z')
    await svc.storePresigned(ENG, 'default.refund', presign2(tx([sweep], 'default.refund')))
    source.snap = hotel2Ledger({ balance: '413', closeTime: '2026-11-01T11:00:01Z' })
    const [r] = await svc.tick(ENG)
    expect(r).toMatchObject({ outcome: 'default.refund', decision: 'SIGN', failing: [] })
    expect(pays(r.blob!)).toEqual([[W.dana.address, true]])
  })

  it('stray RLUSD after a normal stay: the release SIGNs; the guest gets the deposit plus the extra', async () => {
    const { svc, source } = await checkedIn('2026-11-17T11:00:01Z')
    await svc.storePresigned(ENG, 'default.release', presign2(tx([...room, sweep], 'default.release')))
    source.snap = hotel2Ledger({ balance: '563', closeTime: '2026-11-17T11:00:01Z' })
    const [r] = await svc.tick(ENG)
    expect(r).toMatchObject({ outcome: 'default.release', decision: 'SIGN', failing: [] })
    expect(pays(r.blob!)).toEqual([[W.atlas.address, false], [W.service.address, false], [W.dana.address, true]])
  })

  it('an open dispute still blocks every automatic ending', async () => {
    // Entry dispute (Credential + receipted statement + bond) on a confirmed booking with a partial deposit.
    const { svc, source } = await confirmedSetup('2026-11-11T14:31:00Z')
    source.snap = hotel2Ledger({ closeTime: '2026-11-11T14:31:00Z', dispute: true, balance: '462' })
    await svc.ingest(ENG, dispute('entry', '2026-11-11T14:30:00Z'))
    await storeNoShows(svc)
    await svc.storePresigned(ENG, 'default.refund', presign2(tx([sweep], 'default.refund')))
    source.snap.closeTime = '2026-11-12T11:00:01Z'
    const r = byOutcome(await svc.tick(ENG))
    expect(r['default.noshow'].failing).toContain('N4')
    expect(r['default.noshowSweep'].failing).toContain('N4')
    expect(r['default.refund'].failing).toContain('R1') // confirmed: never a refund
    expect(Object.values(r).every((x) => x.decision === 'REFUSE')).toBe(true)

    // Settlement dispute after a stay: the release (sweep) is blocked too.
    const c = await checkedIn('2026-11-16T10:00:01Z')
    c.source.snap = hotel2Ledger({ closeTime: '2026-11-16T10:00:01Z', dispute: true, balance: '573' })
    await c.svc.ingest(ENG, dispute('settlement', '2026-11-16T10:00:00Z'))
    await c.svc.storePresigned(ENG, 'default.release', presign2(tx([...room, sweep], 'default.release')))
    c.source.snap.closeTime = '2026-11-17T11:00:01Z'
    const [rel] = await c.svc.tick(ENG)
    expect(rel).toMatchObject({ outcome: 'default.release', decision: 'REFUSE' })
    expect(rel.failing).toContain('L2')
  })
})

describe('co-signer: a payee who cannot receive makes tick() refuse instead of burning the Tickets (B11)', () => {
  it('guest with DepositAuth or no trust line: the refund sweep is refused; with a line it signs; payees reach the snapshot source', async () => {
    const { svc, source } = await setup('2026-11-01T09:31:00Z')
    const requested: string[][] = []
    const snap = source.snapshot.bind(source)
    source.snapshot = async (q?: unknown) => { requested.push((q as { payees?: string[] } | undefined)?.payees ?? []); return snap() }
    const refund = hotel2Close([{ to: W.dana.address, value: '0', partial: true }], { tickets: true, memos: [memo('eng/basis', 'default.refund')] })
    await svc.storePresigned(ENG, 'default.refund', combine([W.dana, W.atlas].map((w) => w.sign(structuredClone(refund) as never, true).tx_blob)))
    source.snap = hotel2Ledger({ balance: '413', closeTime: '2026-11-01T11:00:01Z' })
    const line = { RLUSD: { balance: '0', limit: '1000000' } }
    for (const receive of [{ depositAuth: true, lines: line }, { depositAuth: false, lines: {} }]) {
      source.snap.accounts[W.dana.address] = { exists: true, receive }
      const [r] = await svc.tick(ENG)
      expect(r).toMatchObject({ outcome: 'default.refund', decision: 'REFUSE', failing: ['B11'] })
      expect(svc.inflightFor(ENG)).toEqual([])
    }
    expect(requested.some((p) => p.includes(W.dana.address))).toBe(true)
    source.snap.accounts[W.dana.address] = { exists: true, receive: { depositAuth: false, lines: line } }
    const [ok] = await svc.tick(ENG)
    expect(ok).toMatchObject({ decision: 'SIGN', failing: [] })
  })
})

// ── Arbiter neutrality, one dispute per deal, chargeback-style defaults (chargeback spec §4.2, §4.3, §4.5) ─────
describe('co-signer: register() refuses an arbiter that is not neutral (accreditation gate)', () => {
  const service = (snap = hotel2Ledger({ closeTime: '2026-11-01T09:01:00Z' })) => {
    const source = new FixtureLedgerSource(snap)
    return { source, svc: new CosignerService({ signer: localSigner(W.cosigner), source, templates: [templates.hotel2, templates.procurement], policies: [policies.baseline, policies.hotel2, policies.procurement] }) }
  }
  const mandateWith = (claimOver: Record<string, unknown>) => {
    const m = hotel2Mandate()
    return statement(W.dana, { kind: 'PRINCIPAL', type: 'party.mandate/1', engagementId: ENG, subject: m.subject, claim: { ...m.claim, ...claimOver }, observedAt: m.observedAt, issuedAt: m.issuedAt })
  }
  const notRegistered = (svc: CosignerService) => expect(svc.engagement(ENG)).toBeUndefined()

  it('a neutral hotel@2 record registers (accepted, unexpired ENG/ARBITER from a listed issuer)', async () => {
    const { svc } = service()
    const r = await svc.register(hotel2Engagement(), hotel2Mandate())
    expect(r.ok).toBe(true)
    expect(r.layers.map((l) => l.split(' ')[0])).toEqual(['pol_baseline@1.1.0', 'pol_hotel@2.0.0'])
    expect(svc.engagement(ENG)?.engagementId).toBe(ENG)
  })

  it('an arbiter without ENG/ARBITER: NOT_NEUTRAL ARBITER_NOT_ACCREDITED, nothing registered', async () => {
    const { svc, source } = service()
    source.snap.credentials = []
    await expect(svc.register(hotel2Engagement(), hotel2Mandate())).rejects.toThrow(/NOT_NEUTRAL: .*ARBITER_NOT_ACCREDITED/)
    notRegistered(svc)
  })

  it('a credential issued by the hotel (not a listed issuer), unaccepted, expired or of another type: ARBITER_NOT_ACCREDITED', async () => {
    const base = { issuer: W.accreditor.address, subject: W.arbiter.address, type: 'ENG/ARBITER', accepted: true, expiration: null as string | null }
    for (const cred of [
      { ...base, issuer: W.atlas.address },
      { ...base, accepted: false },
      { ...base, expiration: '2026-11-01T09:01:00Z' }, // expires at the snapshot's closeTime: no longer valid
      { ...base, type: 'ENG/APPROVER' },
    ]) {
      const { svc, source } = service()
      source.snap.credentials = [cred]
      await expect(svc.register(hotel2Engagement(), hotel2Mandate())).rejects.toThrow(/NOT_NEUTRAL: .*ARBITER_NOT_ACCREDITED/)
      notRegistered(svc)
    }
    const { svc, source } = service()
    source.snap.credentials = [{ ...base, expiration: '2026-11-01T09:01:01Z' }]
    expect((await svc.register(hotel2Engagement(), hotel2Mandate())).ok).toBe(true)
  })

  it('an arbiter that is the hotel (or the guest): ARBITER_IS_PARTY, even when accredited', async () => {
    for (const who of [W.atlas, W.dana]) {
      const { svc, source } = service()
      source.snap.credentials.push({ issuer: W.accreditor.address, subject: who.address, type: 'ENG/ARBITER', accepted: true, expiration: null })
      const rec = hotel2Engagement({ parties: { ...hotel2Engagement().parties, arbiter: who.address } })
      const err = await svc.register(rec, hotel2Mandate()).then(() => null, (e: Error) => e.message)
      expect(err).toMatch(/^NOT_NEUTRAL: /)
      expect(err).toContain('ARBITER_IS_PARTY')
      expect(err).not.toContain('ARBITER_NOT_ACCREDITED')
      notRegistered(svc)
    }
  })

  it('a mandate whose allowedArbiters excludes the arbiter: ARBITER_NOT_ALLOWED; one that lists it registers', async () => {
    const { svc } = service()
    await expect(svc.register(hotel2Engagement(), mandateWith({ allowedArbiters: [W.stranger.address] }))).rejects.toThrow(/NOT_NEUTRAL: .*ARBITER_NOT_ALLOWED/)
    notRegistered(svc)
    const ok = service()
    expect((await ok.svc.register(hotel2Engagement(), mandateWith({ allowedArbiters: [W.stranger.address, W.arbiter.address] }))).ok).toBe(true)
  })

  it('lists every failing code at once', async () => {
    const { svc, source } = service()
    source.snap.credentials = []
    const rec = hotel2Engagement({ parties: { ...hotel2Engagement().parties, arbiter: W.atlas.address } })
    await expect(svc.register(rec, mandateWith({ allowedArbiters: [W.arbiter.address] }))).rejects.toThrow(/^NOT_NEUTRAL: ARBITER_NOT_ACCREDITED, ARBITER_IS_PARTY, ARBITER_NOT_ALLOWED$/)
  })

  it('the ledger is unreachable: register rejects and registers nothing (Review Focus 5)', async () => {
    const { svc, source } = service()
    source.snapshot = async () => { throw new Error('ledger unreachable') }
    await expect(svc.register(hotel2Engagement(), hotel2Mandate())).rejects.toThrow(/ledger unreachable/)
    notRegistered(svc)
    await expect(svc.ingest(ENG, hotel2Confirmation())).rejects.toThrow(/unknown engagement/)
  })

  it('reads the arbiter\'s Credentials at a fresh snapshot (the arbiter is a credential subject)', async () => {
    const { svc, source } = service()
    const asked: unknown[] = []
    const snap = source.snapshot.bind(source)
    source.snapshot = async (q?: unknown) => { asked.push(q); return snap() }
    await svc.register(hotel2Engagement(), hotel2Mandate())
    expect(asked).toHaveLength(1)
    expect((asked[0] as { credentialSubjects: string[] }).credentialSubjects).toContain(W.arbiter.address)
  })

  it('templates without an accredited role register without reading the ledger', async () => {
    const { svc, source } = service()
    source.snapshot = async () => { throw new Error('ledger unreachable') }
    expect((await svc.register(b1Engagement(), b1Mandate())).ok).toBe(true)
  })
})

describe('co-signer: dispute ingest rules (one dispute per deal; kind fixed by when it is filed)', () => {
  /** Confirmed, checked in, deposit and bond in (room 412 + deposit 150 + bond 10), clock at `closeTime`. */
  async function stayed(closeTime: string) {
    const { svc, source } = await checkedIn(closeTime)
    source.snap = hotel2Ledger({ balance: '572', dispute: true, closeTime })
    return { svc, source }
  }

  it('NOT_ENTRY: an entry dispute once checked in (check-in recorded and deposit in) is refused (Review Focus 2)', async () => {
    const { svc } = await stayed('2026-11-12T10:00:30Z') // before entryDisputeBy (11-12T11:00), a night in
    await expect(svc.ingest(ENG, dispute('entry', '2026-11-12T10:00:00Z'))).rejects.toThrow(/NOT_ENTRY/)
    expect(svc.statements(ENG).some((s) => s.type === 'party.dispute/1')).toBe(false)
    // the stay dispute is the one to file
    const s = dispute('stay', '2026-11-12T10:00:00Z')
    expectReceiptFor(await svc.ingest(ENG, s), s, '2026-11-12T10:00:30Z')
  })

  it('an entry dispute after a checked_in but before the deposit is still accepted (not yet checked in)', async () => {
    const { svc, source } = await confirmedSetup('2026-11-11T15:01:00Z')
    await svc.ingest(ENG, checkin('checked_in'))
    source.snap = hotel2Ledger({ balance: '422', dispute: true, closeTime: '2026-11-11T15:30:00Z' })
    const s = dispute('entry', '2026-11-11T15:29:00Z')
    expectReceiptFor(await svc.ingest(ENG, s), s, '2026-11-11T15:30:00Z')
  })

  it('a stay dispute is posted until checkout (deliveryBy, inclusive); after it, LATE', async () => {
    const { svc, source } = await stayed('2026-11-14T11:00:00Z')
    const s = dispute('stay', '2026-11-14T10:59:00Z')
    expectReceiptFor(await svc.ingest(ENG, s), s, '2026-11-14T11:00:00Z')
    const other = await stayed('2026-11-14T11:00:01Z')
    await expect(other.svc.ingest(ENG, dispute('stay', '2026-11-14T10:59:30Z'))).rejects.toThrow(/LATE: party\.dispute\/1 after deliveryBy/)
    void source
  })

  it('NOT_CHECKED_IN: a stay dispute before the guest is checked in is refused (only entry applies then)', async () => {
    const { svc, source } = await confirmedSetup('2026-11-11T15:01:00Z')
    source.snap = hotel2Ledger({ balance: '422', dispute: true, closeTime: '2026-11-11T15:01:00Z' })
    await expect(svc.ingest(ENG, dispute('stay', '2026-11-11T15:00:00Z'))).rejects.toThrow(/NOT_CHECKED_IN/)
    await svc.ingest(ENG, checkin('checked_in')) // recorded, but no deposit yet
    await expect(svc.ingest(ENG, dispute('stay', '2026-11-11T15:00:30Z'))).rejects.toThrow(/NOT_CHECKED_IN/)
  })

  it('ALREADY_DISPUTED: a second principal dispute of any phase is refused; re-posting the first returns its receipt', async () => {
    const { svc, source } = await stayed('2026-11-12T10:00:30Z')
    const first = dispute('stay', '2026-11-12T10:00:00Z')
    const r = await svc.ingest(ENG, first)
    await expect(svc.ingest(ENG, dispute('stay', '2026-11-12T10:00:10Z'))).rejects.toThrow(/ALREADY_DISPUTED/)
    source.snap.closeTime = '2026-11-16T10:00:30Z'
    await expect(svc.ingest(ENG, dispute('settlement', '2026-11-16T10:00:00Z'))).rejects.toThrow(/ALREADY_DISPUTED/)
    expect(await svc.ingest(ENG, first)).toEqual(r)
    expect(svc.statements(ENG).filter((s) => s.type === 'party.dispute/1')).toEqual([first])
  })

  it('NIGHT_MISMATCH: a stay dispute issued in an earlier night than its receipt is refused (no backdating across a night boundary)', async () => {
    // night 2 begins at checkIn + 24 h = 11-12T14:00
    const { svc } = await stayed('2026-11-12T14:01:00Z')
    await expect(svc.ingest(ENG, dispute('stay', '2026-11-12T13:59:59Z'))).rejects.toThrow(/NIGHT_MISMATCH/)
    const s = dispute('stay', '2026-11-12T14:00:00Z') // the boundary instant belongs to night 2
    expectReceiptFor(await svc.ingest(ENG, s), s, '2026-11-12T14:01:00Z')
  })

  describe('LATE rulings cannot block a due chargeback (Review Focus 1)', () => {
    // settlement dispute issued 11-16T10:00:00, receipted 10:00:30 → ruling deadline 11-21T10:00:00 (5 days from issuedAt)
    const sweep = { to: W.dana.address, value: '0', partial: true }
    const claimCb = () => presign(hotel2Close([{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }, sweep], { tickets: true, memos: [memo('eng/basis', 'default.chargebackClaim')] }))
    async function disputed() {
      const s = await stayed('2026-11-14T15:01:00Z')
      await s.svc.ingest(ENG, claim([{ kind: 'minibar', amount: '58.00' }]))
      s.source.snap.closeTime = '2026-11-16T10:00:30Z'
      await s.svc.ingest(ENG, dispute('settlement', '2026-11-16T10:00:00Z'))
      await s.svc.storePresigned(ENG, 'default.chargebackClaim', claimCb())
      return s
    }
    const arbiterRuling = (t: string) => ruling(W.arbiter, [{ to: W.atlas.address, value: '470.00' }], t)

    it('a ruling received after the deadline is LATE; the claim chargeback then SIGNs on tick', async () => {
      const { svc, source } = await disputed()
      source.snap.closeTime = '2026-11-21T10:00:01Z'
      await expect(svc.ingest(ENG, arbiterRuling('2026-11-21T09:59:59Z'))).rejects.toThrow(/LATE: party\.ruling\/1 after the ruling deadline/)
      expect(svc.statements(ENG).some((s) => s.type === 'party.ruling/1')).toBe(false)
      const [r] = await svc.tick(ENG)
      expect(r).toMatchObject({ outcome: 'default.chargebackClaim', stage: 'default.chargebackClaim', decision: 'SIGN', failing: [] })
      expect(signersOf(r.blob!)).toHaveLength(3)
    })

    it('a ruling received exactly at the deadline is receipted and blocks the chargeback for good', async () => {
      const { svc, source } = await disputed()
      source.snap.closeTime = '2026-11-21T10:00:00Z'
      await svc.ingest(ENG, arbiterRuling('2026-11-21T09:59:00Z'))
      source.snap.closeTime = '2026-12-30T00:00:00Z'
      const [r] = await svc.tick(ENG)
      expect(r).toMatchObject({ outcome: 'default.chargebackClaim', decision: 'REFUSE' })
      expect(r.failing).toContain('G2')
    })

    it('uses the deal\'s pinned rulingWindow (3 days → deadline 11-19T10:00:00)', async () => {
      const source = new FixtureLedgerSource(hotel2Ledger({ closeTime: '2026-11-01T09:31:00Z' }))
      const svc = new CosignerService({ signer: localSigner(W.cosigner), source, templates: [templates.hotel2], policies: [policies.baseline, policies.hotel2] })
      await svc.register(hotel2Engagement({ terms: { nights: 3, nightly: '137.333333', rulingWindow: '259200s' } }), hotel2Mandate())
      await svc.ingest(ENG, hotel2Confirmation())
      source.snap.closeTime = '2026-11-11T15:01:00Z'
      await svc.ingest(ENG, checkin('checked_in'))
      source.snap = hotel2Ledger({ balance: '572', dispute: true, closeTime: '2026-11-16T10:00:30Z' })
      await svc.ingest(ENG, dispute('settlement', '2026-11-16T10:00:00Z'))
      source.snap.closeTime = '2026-11-19T10:00:01Z'
      await expect(svc.ingest(ENG, arbiterRuling('2026-11-19T10:00:00Z'))).rejects.toThrow(/LATE/)
    })

    it('the deadline counts from checkout for a settlement dispute issued (within 300 s) before it (the disputeOpenedAt floor)', async () => {
      const { svc, source } = await stayed('2026-11-14T11:00:00Z')
      await svc.ingest(ENG, dispute('settlement', '2026-11-14T10:58:00Z')) // deadline 11-14T11:00 + 5 d = 11-19T11:00
      source.snap.closeTime = '2026-11-19T11:00:00Z'
      await svc.ingest(ENG, arbiterRuling('2026-11-19T10:59:00Z'))
      expect(svc.statements(ENG).filter((s) => s.type === 'party.ruling/1')).toHaveLength(1)
    })

    it('an unanswered claim: a ruling after disputeWindowEnds + rulingWindow is LATE (the claim has lapsed, R6)', async () => {
      const { svc, source } = await checkedIn('2026-11-14T15:01:00Z')
      await svc.ingest(ENG, claim([{ kind: 'minibar', amount: '58.00' }]))
      source.snap.closeTime = '2026-11-22T11:00:01Z' // disputeWindowEnds 11-17T11:00 + 5 d
      await expect(svc.ingest(ENG, arbiterRuling('2026-11-22T11:00:00Z'))).rejects.toThrow(/LATE: party\.ruling\/1/)
      source.snap.closeTime = '2026-11-22T11:00:00Z'
      await svc.ingest(ENG, arbiterRuling('2026-11-22T10:59:00Z'))
    })
  })
})

describe('co-signer: per-night chargeback variants (default.chargebackStay#k)', () => {
  // 3 nights, room 412, nightly 137.333333; nights begin at the scheduled checkIn 11-11T14:00 + i·24h.
  const sweep = { to: W.dana.address, value: '0', partial: true }
  /** A stay variant paying the hotel `grossMinor` (6-decimal minor units) less the 50 bps fee, the rest swept to the guest. */
  const stayBlob = (grossMinor: bigint, basis = 'default.chargebackStay') => {
    const fee = (grossMinor * 50n) / 10000n
    const fmt = (m: bigint) => `${m / 1000000n}.${(m % 1000000n).toString().padStart(6, '0')}`
    return presign(hotel2Close([{ to: W.atlas.address, value: fmt(grossMinor - fee) }, { to: W.service.address, value: fmt(fee) }, sweep], { tickets: true, memos: [memo('eng/basis', basis)] }))
  }
  const stayVariant = (k: 1 | 2) => {
    const [hotel, fee] = k === 1 ? ['136.646667', '0.686666'] : ['273.293333', '1.373333']
    return presign(hotel2Close([{ to: W.atlas.address, value: hotel }, { to: W.service.address, value: fee }, sweep], { tickets: true, memos: [memo('eng/basis', 'default.chargebackStay')] }))
  }

  it('dispute in night 1 of 3: tick SIGNs only #1; #2 REFUSEs on the hotel leg (Y4)', async () => {
    const { svc, source } = await checkedIn('2026-11-11T15:02:00Z')
    await svc.storePresigned(ENG, 'default.chargebackStay#1', stayVariant(1))
    await svc.storePresigned(ENG, 'default.chargebackStay#2', stayVariant(2))
    source.snap = hotel2Ledger({ balance: '572', dispute: true, closeTime: '2026-11-12T10:00:30Z' })
    await svc.ingest(ENG, dispute('stay', '2026-11-12T10:00:00Z')) // night 1 (before 11-12T14:00); deadline 11-17T10:00
    source.snap.closeTime = '2026-11-17T10:00:00Z'
    expect((await svc.tick(ENG)).map((r) => [r.outcome, r.decision])).toEqual([['default.chargebackStay#1', 'REFUSE'], ['default.chargebackStay#2', 'REFUSE']])
    source.snap.closeTime = '2026-11-17T10:00:01Z'
    const r = Object.fromEntries((await svc.tick(ENG)).map((x) => [x.outcome, x]))
    expect(r['default.chargebackStay#1']).toMatchObject({ stage: 'default.chargebackStay', decision: 'SIGN', failing: [] })
    expect(signersOf(r['default.chargebackStay#1'].blob!)).toHaveLength(3)
    expect(r['default.chargebackStay#2']).toMatchObject({ stage: 'default.chargebackStay', decision: 'REFUSE' })
    expect(r['default.chargebackStay#2'].failing).toContain('Y4')
    expect(r['default.chargebackStay#2'].blob).toBeUndefined()
  })

  it('storePresigned accepts #1 … #(nights − 1) of a per-night outcome and refuses anything else (nothing stored)', async () => {
    const { svc } = await checkedIn('2026-11-11T15:02:00Z')
    for (const name of ['default.chargebackStay', 'default.chargebackStay#0', 'default.chargebackStay#3', 'default.chargebackStay#14', 'default.chargebackStay#01', 'default.chargebackStay#1.5', 'default.chargebackStay#x', 'default.release#1', 'default.nope#1']) {
      await expect(svc.storePresigned(ENG, name, stayVariant(1))).rejects.toThrow(/BAD_VARIANT|NOT_PRESIGNED/)
    }
    expect(await svc.tick(ENG)).toEqual([])
    await svc.storePresigned(ENG, 'default.chargebackStay#2', stayVariant(2))
    expect((await svc.tick(ENG)).map((r) => r.outcome)).toEqual(['default.chargebackStay#2'])
  })

  it('14 nights: #1 … #13; a longer stay (over the cap, max 13) or a deal without terms has no stay variants', async () => {
    const source = new FixtureLedgerSource(hotel2Ledger({ closeTime: '2026-11-01T09:31:00Z' }))
    const make = async (rec: ReturnType<typeof hotel2Engagement>) => {
      const svc = new CosignerService({ signer: localSigner(W.cosigner), source, templates: [templates.hotel2], policies: [policies.baseline, policies.hotel2] })
      await svc.register(rec, hotel2Mandate())
      return svc
    }
    const fourteen = await make(hotel2Engagement({ terms: { nights: 14, nightly: '29.428571' } }))
    await expect(fourteen.storePresigned(ENG, 'default.chargebackStay#13', stayBlob(13n * 29428571n))).resolves.toBeUndefined()
    await expect(fourteen.storePresigned(ENG, 'default.chargebackStay#14', stayBlob(14n * 29428571n))).rejects.toThrow(/BAD_VARIANT/)
    const fifteen = await make(hotel2Engagement({ terms: { nights: 15, nightly: '27.466666' } }))
    for (const k of [1, 13]) await expect(fifteen.storePresigned(ENG, `default.chargebackStay#${k}`, stayVariant(1))).rejects.toThrow(/BAD_VARIANT/)
    const { terms: _t, ...noTerms } = hotel2Engagement()
    void _t
    const bare = await make(noTerms)
    await expect(bare.storePresigned(ENG, 'default.chargebackStay#1', stayVariant(1))).rejects.toThrow(/BAD_VARIANT/)
  })
})

// ── Fix round 1 (R10–R14): no lockup, no pre-blocking, no late-bond clock, kind fixed by time, blobs match slots ──
describe('co-signer: review fixes R10–R14', () => {
  const sweep = { to: W.dana.address, value: '0', partial: true }
  const room = [{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }]
  const blob = (payouts: Array<{ to: string; value: string; partial?: boolean }>, basis: string) => presign(hotel2Close(payouts, { tickets: true, memos: [memo('eng/basis', basis)] }))
  const arb = (t: string) => ruling(W.arbiter, [{ to: W.atlas.address, value: '470.00' }], t)
  const summary = (rs: TickResult[]) => Object.fromEntries(rs.map((r) => [r.outcome, r.failing.length ? `${r.decision}:${r.failing.join('|')}` : r.decision]))

  it('R15: hotel checked_in → bonded entry dispute → anyone tops up the deposit → arbiter silent: the entry chargeback SIGNs, the claim one refuses', async () => {
    for (const balance of ['422', '572']) {
      const { svc, source } = await confirmedSetup('2026-11-11T15:01:00Z')
      await svc.ingest(ENG, checkin('checked_in'))
      source.snap = hotel2Ledger({ balance: '422', dispute: true, closeTime: '2026-11-11T15:30:00Z' })
      await svc.ingest(ENG, dispute('entry', '2026-11-11T15:29:30Z')) // deadline 11-16T15:29:30
      await svc.storePresigned(ENG, 'default.chargebackEntry', blob([sweep], 'default.chargebackEntry'))
      await svc.storePresigned(ENG, 'default.chargebackClaim', blob([...room, sweep], 'default.chargebackClaim'))
      if (balance === '572') {
        source.snap = hotel2Ledger({ balance, dispute: true, closeTime: '2026-11-12T10:00:00Z' }) // the deposit lands
        await expect(svc.ingest(ENG, dispute('stay', '2026-11-12T09:59:30Z'))).rejects.toThrow(/ALREADY_DISPUTED/)
      }
      source.snap = hotel2Ledger({ balance, dispute: true, closeTime: '2026-11-16T15:29:30Z' })
      expect(summary(await svc.tick(ENG))['default.chargebackEntry']).toMatch(/^REFUSE:.*E1/)
      source.snap.closeTime = '2026-11-16T15:29:31Z'
      const r = summary(await svc.tick(ENG))
      expect(r['default.chargebackEntry']).toBe('SIGN')
      expect(r['default.chargebackClaim']).toMatch(/^REFUSE:.*G1/)
    }
  })

  it('R16: an arbiter ruling issued before the case opened is EARLY_RULING (a receipted ruling always counts)', async () => {
    // a settlement dispute future-dated within the clock skew: the case opens at its issuedAt 10:04:50
    const { svc, source } = await checkedIn('2026-11-14T15:01:00Z')
    await svc.ingest(ENG, claim([{ kind: 'minibar', amount: '58.00' }])) // claim issued 11-14T15:00
    source.snap.closeTime = '2026-11-14T15:01:30Z'
    await expect(svc.ingest(ENG, arb('2026-11-14T14:59:59Z'))).rejects.toThrow(/EARLY_RULING/) // before the claim
    source.snap = hotel2Ledger({ balance: '572', dispute: true, closeTime: '2026-11-15T10:00:00Z' })
    await svc.ingest(ENG, dispute('settlement', '2026-11-15T10:04:50Z'))
    source.snap.closeTime = '2026-11-15T10:02:00Z'
    await expect(svc.ingest(ENG, arb('2026-11-15T10:01:30Z'))).rejects.toThrow(/EARLY_RULING: .*2026-11-15T10:04:50/)
    expect(svc.statements(ENG).some((s) => s.type === 'party.ruling/1')).toBe(false)
    source.snap.closeTime = '2026-11-15T10:05:00Z'
    await svc.ingest(ENG, arb('2026-11-15T10:04:50Z')) // at the case-open instant: receipted, and it counts
    await svc.storePresigned(ENG, 'default.chargebackClaim', blob([...room, sweep], 'default.chargebackClaim'))
    source.snap.closeTime = '2026-11-20T10:05:00Z'
    expect(summary(await svc.tick(ENG))['default.chargebackClaim']).toBe('REFUSE:G2')
  })

  it('R11a: an arbiter ruling with no receipted dispute or claim is NO_CASE', async () => {
    const { svc, source } = await confirmedSetup('2026-11-05T10:00:00Z')
    await expect(svc.ingest(ENG, arb('2026-11-05T09:59:00Z'))).rejects.toThrow(/NO_CASE/)
    expect(svc.statements(ENG).some((s) => s.type === 'party.ruling/1')).toBe(false)
    // a ruling by a non-arbiter party is not an arbiter ruling: not NO_CASE (the policy ignores it by role)
    source.snap.closeTime = '2026-11-05T10:01:00Z'
    await svc.ingest(ENG, ruling(W.atlas, [{ to: W.atlas.address, value: '1.00' }], '2026-11-05T10:00:30Z'))
  })

  it('R11b: a ruling receipted on the claim, dated before the guest\'s dispute, does not block the dispute\'s chargeback', async () => {
    const { svc, source } = await checkedIn('2026-11-14T15:01:00Z')
    await svc.ingest(ENG, claim([{ kind: 'minibar', amount: '58.00' }]))
    source.snap.closeTime = '2026-11-15T09:00:30Z'
    await svc.ingest(ENG, arb('2026-11-15T09:00:00Z')) // a case exists (the claim): receipted
    source.snap = hotel2Ledger({ balance: '572', dispute: true, closeTime: '2026-11-16T10:00:30Z' })
    await svc.ingest(ENG, dispute('settlement', '2026-11-16T10:00:00Z')) // deadline 11-21T10:00
    await svc.storePresigned(ENG, 'default.chargebackClaim', blob([...room, sweep], 'default.chargebackClaim'))
    source.snap.closeTime = '2026-11-21T10:00:01Z'
    expect(summary(await svc.tick(ENG))['default.chargebackClaim']).toBe('SIGN')
  })

  it('R12: a dispute is NOT_BONDED unless Credential and bond are on the ledger (with the deposit once checked in); a late bond starts no clock', async () => {
    const { svc, source } = await checkedIn('2026-11-14T15:01:00Z')
    await svc.ingest(ENG, claim([{ kind: 'minibar', amount: '58.00' }]))
    await svc.storePresigned(ENG, 'default.release', blob([...room, { to: W.dana.address, value: '150' }], 'default.release'))
    source.snap.closeTime = '2026-11-16T10:00:30Z' // no Credential, no bond
    await expect(svc.ingest(ENG, dispute('settlement', '2026-11-16T10:00:00Z'))).rejects.toThrow(/NOT_BONDED/)
    source.snap = hotel2Ledger({ balance: '571', dispute: true, closeTime: '2026-11-16T10:01:30Z' }) // Credential, but 1 short of 412 + 150 + 10
    await expect(svc.ingest(ENG, dispute('settlement', '2026-11-16T10:01:00Z'))).rejects.toThrow(/NOT_BONDED/)
    expect(svc.statements(ENG).some((s) => s.type === 'party.dispute/1')).toBe(false)
    // no dispute ever opened: the arbiter's silence lets the claim lapse (R6/R9) and the deposit goes back
    source.snap = hotel2Ledger({ balance: '562', closeTime: '2026-11-22T11:00:01Z' })
    expect(summary(await svc.tick(ENG))['default.release']).toBe('SIGN')
    // bonding after the dispute window can't start a clock either: the dispute is LATE
    source.snap = hotel2Ledger({ balance: '572', dispute: true, closeTime: '2026-11-22T11:01:00Z' })
    await expect(svc.ingest(ENG, dispute('settlement', '2026-11-22T11:00:30Z'))).rejects.toThrow(/LATE/)
  })

  it('R13: a settlement dispute before checkout is TOO_EARLY; the no-show then fires normally', async () => {
    const { svc, source } = await confirmedSetup('2026-11-05T10:00:00Z')
    source.snap = hotel2Ledger({ balance: '422', dispute: true, closeTime: '2026-11-05T10:00:00Z' })
    await expect(svc.ingest(ENG, dispute('settlement', '2026-11-05T09:59:30Z'))).rejects.toThrow(/TOO_EARLY: a settlement dispute/)
    source.snap.closeTime = '2026-11-14T10:59:59Z'
    await expect(svc.ingest(ENG, dispute('settlement', '2026-11-14T10:59:30Z'))).rejects.toThrow(/TOO_EARLY/)
    await svc.storePresigned(ENG, 'default.noshowSweep', blob([...room, sweep], 'default.noshowSweep'))
    source.snap.closeTime = '2026-12-30T00:00:00Z'
    expect(summary(await svc.tick(ENG))['default.noshowSweep']).toBe('SIGN')
  })

  it('R14: storePresigned refuses a chargeback blob that does not match its slot (SLOT_MISMATCH); nothing stored', async () => {
    const { svc } = await checkedIn('2026-11-11T15:02:00Z')
    const night = (k: bigint) => {
      const gross = k * 137333333n
      const fee = (gross * 50n) / 10000n
      const f = (m: bigint) => `${m / 1000000n}.${(m % 1000000n).toString().padStart(6, '0')}`
      return [{ to: W.atlas.address, value: f(gross - fee) }, { to: W.service.address, value: f(fee) }, sweep]
    }
    await expect(svc.storePresigned(ENG, 'default.chargebackStay#1', blob(night(2n), 'default.chargebackStay'))).rejects.toThrow(/SLOT_MISMATCH: .*2 nights|SLOT_MISMATCH: default.chargebackStay#1/)
    await expect(svc.storePresigned(ENG, 'default.chargebackStay#1', blob([...room, sweep], 'default.chargebackClaim'))).rejects.toThrow(/SLOT_MISMATCH: blob's eng\/basis/)
    await expect(svc.storePresigned(ENG, 'default.chargebackStay#1', blob(night(1n), 'default.chargebackClaim'))).rejects.toThrow(/SLOT_MISMATCH/)
    await expect(svc.storePresigned(ENG, 'default.chargebackClaim', blob([...room, sweep], 'default.release'))).rejects.toThrow(/SLOT_MISMATCH/)
    await expect(svc.storePresigned(ENG, 'default.chargebackEntry', blob([sweep], 'default.refund'))).rejects.toThrow(/SLOT_MISMATCH/)
    expect(await svc.tick(ENG)).toEqual([])
    await svc.storePresigned(ENG, 'default.chargebackStay#1', blob(night(1n), 'default.chargebackStay'))
    await svc.storePresigned(ENG, 'default.chargebackStay#2', blob(night(2n), 'default.chargebackStay'))
    expect((await svc.tick(ENG)).map((r) => r.outcome)).toEqual(['default.chargebackStay#1', 'default.chargebackStay#2'])
  })
})
