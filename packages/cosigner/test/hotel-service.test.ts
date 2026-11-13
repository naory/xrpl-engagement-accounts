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
  LEDGER_INDEX, NOW, W, checkin, claim, dispute, hotel2Confirmation, hotel2Close, hotel2Engagement, hotel2Ledger, hotel2Mandate, memo, policies, review, ruling, statement, templates,
} from '../../policy/test/fixtures.ts'

const ENG = 'eng_hotel2_fixture'

function setup(closeTime: string) {
  const source = new FixtureLedgerSource(hotel2Ledger({ closeTime }))
  const svc = new CosignerService({ signer: localSigner(W.cosigner), source, templates: [templates.hotel2], policies: [policies.baseline, policies.hotel2] })
  svc.register(hotel2Engagement(), hotel2Mandate())
  return { svc, source }
}

/** setup(), with the hotel's confirmation receipted before confirmBy; then the clock moves to `closeTime` (balance optional). */
async function confirmedSetup(closeTime: string, balance?: string) {
  const { svc, source } = setup('2026-11-01T09:31:00Z')
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
    const { svc } = await confirmedSetup('2026-11-15T11:00:00Z')
    const s = claimAt('2026-11-15T10:59:00Z', [{ amount: '40.00' }], '40.00')
    expectReceiptFor(await svc.ingest(ENG, s), s, '2026-11-15T11:00:00Z')
    expect(svc.statements(ENG)).toHaveLength(2)
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
    const { svc, conf } = await confirmedSetup('2026-11-14T15:01:00Z')
    await expect(svc.ingest(ENG, claimAt('2026-11-14T15:00:00Z', [{ amount: '0.10' }, { amount: '0.20' }], '0.30000001'))).rejects.toThrow(/CLAIM_TOTAL/)
    await expect(svc.ingest(ENG, claimAt('2026-11-14T15:00:00Z', [{ amount: '40.00' }, { amount: '25.50' }], '65.49'))).rejects.toThrow(/CLAIM_TOTAL/)
    expect(svc.statements(ENG)).toEqual([conf])
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
      const { svc } = setup(NOW)
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
    const { svc, source } = setup('2026-11-01T12:01:00Z')
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

  it('R29a: once the deposit is in, checked_in then refused lets neither default take it', async () => {
    const { svc, source } = await confirmedSetup('2026-11-11T15:01:00Z')
    await svc.ingest(ENG, checkin('checked_in'))
    source.snap.closeTime = '2026-11-11T15:06:00Z'
    await svc.ingest(ENG, checkinAt('refused', '2026-11-11T15:05:00Z'))
    source.snap = hotel2Ledger({ balance: '562', closeTime: '2026-11-17T12:00:00Z' })
    await svc.storePresigned(ENG, 'default.release', presign(releaseTx()))
    await svc.storePresigned(ENG, 'default.noshow', presign(noshowTx()))
    const byOutcome = Object.fromEntries((await svc.tick(ENG)).map((r) => [r.outcome, r]))
    expect(byOutcome['default.release'].failing).toContain('L1') // latest statement is refused: not checked in
    expect(byOutcome['default.noshow'].failing).toContain('N5') // and the deposit is not the hotel's either
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
    const payouts = [{ to: W.dana.address, value: '422' }]
    const r = ruling(W.backupArbiter, payouts, '2026-11-20T23:59:00Z')
    const d = await svc.decide({ engagementId: ENG, stage: 'ruling.backup', tx: hotel2Close(payouts, { memos: [memo('eng/basis', 'ruling.backup')] }), statements: [r] })
    expect(d.failing).toEqual([])
  })

  it('R38: only the hotel confirms — a guest-posted confirmation is NOT_COUNTERPARTY and cannot lock the hotel out', async () => {
    const { svc, source } = setup('2026-11-01T09:31:00Z')
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

  it('R39a: an entry dispute without the Credential and bond does not freeze check-in', async () => {
    for (const ledger of [{ dispute: false, balance: '422' }, { dispute: true, balance: '412' }]) {
      const { svc, source } = await confirmedSetup('2026-11-11T14:31:00Z')
      source.snap = hotel2Ledger({ closeTime: '2026-11-11T14:31:00Z', ...ledger })
      await svc.ingest(ENG, dispute('entry', '2026-11-11T14:30:00Z')) // receipted
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
    expect(svc.register(hotel2Engagement(), hotel2Mandate()).ok).toBe(true)
    expect(svc.statements(ENG)).toHaveLength(2)
    expect(await svc.tick(ENG)).toHaveLength(1) // the stored default survived
    expect(() => svc.register(hotel2Engagement({ amount: { asset: 'RLUSD', value: '1.00' } }), hotel2Mandate())).toThrow(/ALREADY_REGISTERED/)
    expect(() => svc.register(hotel2Engagement(), null)).toThrow(/ALREADY_REGISTERED/)
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
    const { svc: unconfirmed } = setup('2026-11-14T15:01:00Z')
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
