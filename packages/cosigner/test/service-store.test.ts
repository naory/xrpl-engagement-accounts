// CosignerService on a StateStore (durable co-signer design §2, §2a): every mutation is committed to the store before
// memory changes or anything is returned; open() rebuilds the service from the store, quarantines engagements whose
// pinned policy layers or template are gone, and refuses a different signer.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import xrpl from 'xrpl'
import { documentHash, localSigner, type Statement } from '@eng/core'
import { CosignerService, FixtureLedgerSource, MemoryStateStore, SqliteStateStore, combine, type CosignerOptions, type SnapshotRequest, type StateStore, type StoreSnapshot, type StoreTx } from '@eng/cosigner'
import { layerHash, type LedgerSnapshot } from '@eng/policy'
import {
  W, b1Approval, b1Engagement, b1Invoice, b1Ledger, b1Mandate, b1Payment, checkin, guestCheckin, historyEntry, hotel2Close, hotel2Confirmation, hotel2Engagement, hotel2Ledger, hotel2Mandate, memo, policies, templates,
} from '../../policy/test/fixtures.ts'
import { Assets, TxFacts } from '@eng/policy'

type Json = Record<string, unknown>
const B1 = 'eng_b1_fixture'
const H2 = 'eng_hotel2_fixture'

/** A store whose transactions run their writes and then fail (so the staged writes are discarded) while `failing`. */
class FlakyStore implements StateStore {
  failing = false
  constructor(readonly inner: StateStore = new MemoryStateStore()) {}
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    if (!this.failing) return this.inner.transaction(fn)
    return this.inner.transaction(async (tx) => { await fn(tx); throw new Error('disk full') })
  }
  loadAll(): Promise<StoreSnapshot> { return this.inner.loadAll() }
  close(): Promise<void> { return this.inner.close() }
}

/** Routes each snapshot request to the b1 or hotel@2 fixture ledger by account. */
class RoutedSource {
  constructor(public b1: LedgerSnapshot = b1Ledger(), public h2: LedgerSnapshot = hotel2Ledger({ closeTime: '2026-11-01T09:31:00Z' })) {}
  async snapshot(q: SnapshotRequest): Promise<LedgerSnapshot> { return structuredClone(q.account === W.engB1.address ? this.b1 : this.h2) }
}

const baseOpts = (source: { snapshot(q: SnapshotRequest): Promise<LedgerSnapshot> }, store: StateStore, over: Partial<CosignerOptions> = {}): CosignerOptions => ({
  signer: localSigner(W.cosigner), source, store,
  templates: [templates.procurement, templates.hotel2], policies: [policies.baseline, policies.procurement, policies.hotel2], ...over,
})

const pay = (value: string, seq: number, invoice = 'inv:2026-Q4-0042', to = W.vendorA.address) => ({ ...b1Payment(to, value, { invoice }), Sequence: seq })
const intent = (tx: Json) => new TxFacts(tx, { eng: b1Engagement(), template: templates.procurement, assets: new Assets(policies.procurement.assets!), ledger: b1Ledger() }).intentHash()
const releaseTx = (): Json => hotel2Close([{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }, { to: W.dana.address, value: '150' }], { tickets: true, memos: [memo('eng/basis', 'default.release')] })
const presign = (tx: Json, wallets = [W.dana, W.atlas]) => combine(wallets.map((w) => w.sign(structuredClone(tx) as never, true).tx_blob))
const canonical = (blob: string) => { const { TxnSignature: _t, ...tx } = xrpl.decode(blob) as Json; void _t; return xrpl.encode({ ...tx, SigningPubKey: '' } as never) }

async function b1Svc(store: StateStore = new MemoryStateStore(), ledger = b1Ledger()) {
  const source = new RoutedSource(ledger)
  const svc = new CosignerService(baseOpts(source, store))
  await svc.register(b1Engagement(), b1Mandate())
  return { svc, source, store }
}

/** hotel@2 with confirmation, check-in and the guest's acknowledgement receipted, then the clock at `closeTime`. */
async function hotelCheckedIn(closeTime: string, store: StateStore = new MemoryStateStore()) {
  const source = new RoutedSource()
  const svc = new CosignerService(baseOpts(source, store))
  await svc.register(hotel2Engagement(), hotel2Mandate())
  await svc.ingest(H2, hotel2Confirmation())
  source.h2.closeTime = '2026-11-11T15:01:00Z'
  await svc.ingest(H2, checkin('checked_in'))
  await svc.ingest(H2, guestCheckin())
  source.h2 = hotel2Ledger({ balance: '562', closeTime })
  return { svc, source, store }
}

afterEach(() => { vi.restoreAllMocks() })

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'cosigner-store-'))

describe('CosignerService write-through', () => {
  it('register persists the immutable registration, the mutable record and the pins', async () => {
    const store = new MemoryStateStore()
    const mandate = b1Mandate()
    await new CosignerService(baseOpts(new RoutedSource(), store)).register(b1Engagement(), mandate)
    const snap = await store.loadAll()
    expect(snap.engagements).toHaveLength(1)
    const e = snap.engagements[0]
    expect(e.engagementId).toBe(B1)
    expect(e.registered).toEqual({ record: b1Engagement(), mandate })
    expect(e.record).toEqual({ consumed: [], ...b1Engagement() })
    expect(e.closed).toBe(false)
    const tplLayer = policies.procurement
    expect(e.pins).toEqual({ layerHashes: [layerHash(policies.baseline), layerHash(tplLayer)], templateId: templates.procurement.templateId, templateHash: documentHash(templates.procurement) })
  })

  it('ingest persists the statement with its receipt', async () => {
    const { svc, store } = await hotelCheckedIn('2026-11-17T11:00:00Z')
    const snap = await store.loadAll()
    expect(snap.attestations.map((a) => a.statement.id).sort()).toEqual(svc.statements(H2).map((s) => s.id).sort())
    for (const a of svc.attestations(H2)) expect(snap.attestations.find((x) => x.statement.id === a.statement.id)).toEqual({ engagementId: H2, ...a })
  })

  it('storePresigned persists the canonical blob', async () => {
    const { svc, store } = await hotelCheckedIn('2026-11-17T11:00:00Z')
    const blob = presign(releaseTx())
    await svc.storePresigned(H2, 'default.release', blob)
    expect((await store.loadAll()).presigned).toEqual([{ engagementId: H2, outcome: 'default.release', blob: canonical(blob) }])
  })

  it('decide persists the decision record and the in-flight entry; resolution persists consumed and the removal', async () => {
    const { svc, source, store } = await b1Svc()
    const tx1 = pay('1500', 21)
    const appr = b1Approval(intent(tx1))
    const invoice = b1Invoice(W.vendorA, '1500.00')
    const r = await svc.decide({ engagementId: B1, stage: 'spend', tx: tx1, statements: [invoice, appr] })
    expect(r.decision).toBe('SIGN')
    let snap = await store.loadAll()
    expect(snap.decisions.map((d) => d.statement)).toEqual(svc.decisions())
    expect(snap.inflight).toEqual(svc.inflightFor(B1))
    expect(snap.inflight).toHaveLength(1)
    // It validates: the next decision resolves it, consuming the reserved statements.
    source.b1.accounts[W.engB1.address].sequence = 22
    source.b1.history[W.engB1.address].push({ ...historyEntry('1500', '2026-11-18T09:33:05Z'), sequence: 21 })
    await svc.decide({ engagementId: B1, stage: 'spend', tx: pay('100', 22, 'inv:X', W.stranger.address) })
    snap = await store.loadAll()
    expect(snap.inflight).toEqual([])
    expect(snap.engagements[0].record.consumed).toEqual(expect.arrayContaining([appr.id, invoice.id]))
    expect(snap.engagements[0].record).toEqual(svc.engagement(B1))
    expect(snap.engagements[0].registered.record).toEqual(b1Engagement()) // the registration stays as received
    expect(snap.decisions.map((d) => d.statement)).toEqual(svc.decisions())
  })

  it('tick persists the completed result, its in-flight entry and its decision; TICKET_CONSUMED deletes the blob', async () => {
    const { svc, source, store } = await hotelCheckedIn('2026-11-17T12:00:00Z')
    await svc.storePresigned(H2, 'default.release', presign(releaseTx()))
    const [a] = await svc.tick(H2)
    expect(a.decision).toBe('SIGN')
    let snap = await store.loadAll()
    expect(snap.completed).toEqual([{ engagementId: H2, txHash: svc.inflightFor(H2)[0].proposedTxHash, result: a }])
    expect(snap.inflight).toEqual(svc.inflightFor(H2))
    expect(snap.decisions.at(-1)!.statement).toEqual(a.record)
    const o = source.h2.accounts[W.engHotel2.address].ownerObjects!
    o.tickets = o.tickets.filter((t) => t !== 101)
    const [b] = await svc.tick(H2)
    expect(b.failing).toEqual(['TICKET_CONSUMED'])
    snap = await store.loadAll()
    expect(snap.presigned).toEqual([])
    expect(snap.inflight).toEqual([])
    expect(snap.decisions.at(-1)!.statement).toEqual(b.record)
  })
})

describe('persist before anything leaves (Review Focus 1)', () => {
  it('a failed commit during decide SIGN: decide rejects, no in-flight entry, no decision, store unchanged', async () => {
    const store = new FlakyStore()
    const { svc } = await b1Svc(store)
    const before = await store.loadAll()
    const log = svc.decisions()
    store.failing = true
    await expect(svc.decide({ engagementId: B1, stage: 'spend', tx: pay('800', 21), statements: [b1Invoice()] })).rejects.toThrow(/disk full/)
    expect(svc.inflightFor(B1)).toEqual([])
    expect(svc.decisions()).toEqual(log)
    expect(await store.loadAll()).toEqual(before)
    store.failing = false
    expect((await svc.decide({ engagementId: B1, stage: 'spend', tx: pay('800', 21), statements: [b1Invoice()] })).decision).toBe('SIGN')
  })

  it('a failed commit during resolution leaves consumed and in-flight untouched', async () => {
    const store = new FlakyStore()
    const { svc, source } = await b1Svc(store)
    const tx1 = pay('1500', 21)
    const appr = b1Approval(intent(tx1))
    await svc.decide({ engagementId: B1, stage: 'spend', tx: tx1, statements: [b1Invoice(W.vendorA, '1500.00'), appr] })
    const inflight = svc.inflightFor(B1)
    source.b1.accounts[W.engB1.address].sequence = 22
    source.b1.history[W.engB1.address].push({ ...historyEntry('1500', '2026-11-18T09:33:05Z'), sequence: 21 })
    store.failing = true
    await expect(svc.decide({ engagementId: B1, stage: 'spend', tx: pay('100', 22) })).rejects.toThrow(/disk full/)
    expect(svc.inflightFor(B1)).toEqual(inflight)
    expect(svc.engagement(B1)!.consumed).toEqual([])
  })

  it('a failed commit during tick: no blob, nothing completed or in flight; the next tick signs', async () => {
    const store = new FlakyStore()
    const { svc } = await hotelCheckedIn('2026-11-17T12:00:00Z', store)
    await svc.storePresigned(H2, 'default.release', presign(releaseTx()))
    const before = await store.loadAll()
    const log = svc.decisions()
    store.failing = true
    await expect(svc.tick(H2)).rejects.toThrow(/disk full/)
    expect(svc.inflightFor(H2)).toEqual([])
    expect(svc.decisions()).toEqual(log)
    expect(await store.loadAll()).toEqual(before)
    store.failing = false
    const [r] = await svc.tick(H2)
    expect(r.decision).toBe('SIGN')
    expect(r.blob).toBeDefined()
  })

  it('failed commits for register, ingest and storePresigned change nothing', async () => {
    const store = new FlakyStore()
    const source = new RoutedSource()
    const svc = new CosignerService(baseOpts(source, store))
    store.failing = true
    await expect(svc.register(hotel2Engagement(), hotel2Mandate())).rejects.toThrow(/disk full/)
    expect(svc.engagement(H2)).toBeUndefined()
    store.failing = false
    await svc.register(hotel2Engagement(), hotel2Mandate())
    store.failing = true
    await expect(svc.ingest(H2, hotel2Confirmation())).rejects.toThrow(/disk full/)
    expect(svc.statements(H2)).toEqual([])
    await expect(svc.storePresigned(H2, 'default.release', presign(releaseTx()))).rejects.toThrow(/disk full/)
    store.failing = false
    expect((await store.loadAll()).presigned).toEqual([])
    expect(await svc.tick(H2)).toEqual([]) // nothing was stored in memory either
  })
})

describe('CosignerService.open (restore)', () => {
  it('rebuilds receipts, presigned blobs, completed results, in-flight entries and the log', async () => {
    const { svc, source, store } = await hotelCheckedIn('2026-11-17T12:00:00Z')
    await svc.storePresigned(H2, 'default.release', presign(releaseTx()))
    const [a] = await svc.tick(H2)
    expect(a.decision).toBe('SIGN')
    const again = await CosignerService.open(baseOpts(source, store))
    expect(again.engagement(H2)).toEqual(svc.engagement(H2))
    expect(again.attestations(H2)).toEqual(expect.arrayContaining(svc.attestations(H2)))
    expect(again.inflightFor(H2)).toEqual(svc.inflightFor(H2))
    expect(again.decisions()).toEqual(svc.decisions())
    const [b] = await again.tick(H2)
    expect(b).toEqual(a) // still in flight: the stored completed result, not re-signed
    expect(again.decisions()).toEqual(svc.decisions())
  })

  it('restores from SQLite: an in-flight spend still counts against the daily cap after a restart', async () => {
    const file = path.join(tmp(), 'cosigner.db')
    const store1 = await SqliteStateStore.open({ file })
    const { svc } = await b1Svc(store1, b1Ledger({ history: [historyEntry('9000', '2026-11-18T02:00:00Z')] }))
    expect((await svc.decide({ engagementId: B1, stage: 'spend', tx: pay('600', 21, 'inv:A'), statements: [b1Invoice(W.vendorA, '600.00', 'inv:A')] })).decision).toBe('SIGN')
    await svc.close()
    const store2 = await SqliteStateStore.open({ file })
    const again = await CosignerService.open(baseOpts(new RoutedSource(b1Ledger({ history: [historyEntry('9000', '2026-11-18T02:00:00Z')] })), store2))
    expect(again.inflightFor(B1)).toEqual(svc.inflightFor(B1))
    const b = await again.decide({ engagementId: B1, stage: 'spend', tx: pay('600', 22, 'inv:B'), statements: [b1Invoice(W.vendorA, '600.00', 'inv:B')] })
    expect(b.failing).toEqual(['W3'])
    expect(again.decisions()).toHaveLength(2)
    await again.close()
  })

  it('quarantines an engagement whose pinned layer is gone (Review Focus 4); others still decide', async () => {
    const store = new MemoryStateStore()
    const source = new RoutedSource()
    const svc = new CosignerService(baseOpts(source, store))
    await svc.register(b1Engagement(), b1Mandate())
    await svc.register(hotel2Engagement(), hotel2Mandate())
    await svc.decide({ engagementId: H2, stage: 'checkin' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const again = await CosignerService.open(baseOpts(source, store, { policies: [policies.baseline, policies.procurement] }))
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ENGAGEMENT_STALE: eng_hotel2_fixture/))
    await expect(again.decide({ engagementId: H2, stage: 'checkin' })).rejects.toThrow(/ENGAGEMENT_STALE/)
    await expect(again.tick(H2)).rejects.toThrow(/ENGAGEMENT_STALE: eng_hotel2_fixture/)
    await expect(again.ingest(H2, hotel2Confirmation())).rejects.toThrow(/ENGAGEMENT_STALE/)
    await expect(again.storePresigned(H2, 'default.release', presign(releaseTx()))).rejects.toThrow(/ENGAGEMENT_STALE/)
    expect(again.engagement(H2)).toEqual(svc.engagement(H2)) // reads still answer
    expect(again.decisions(H2)).toEqual(svc.decisions(H2))
    expect(again.openEngagementIds()).toEqual([B1])
    expect((await again.decide({ engagementId: B1, stage: 'spend', tx: pay('800', 21), statements: [b1Invoice()] })).decision).toBe('SIGN')
  })

  it('quarantines an engagement whose template changed under the same id', async () => {
    const store = new MemoryStateStore()
    const source = new RoutedSource()
    await (await b1Svc(store)).svc.register(hotel2Engagement(), hotel2Mandate())
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const changed = { ...templates.hotel2, description: 'edited' }
    const again = await CosignerService.open(baseOpts(source, store, { templates: [templates.procurement, changed] }))
    await expect(again.decide({ engagementId: H2, stage: 'checkin' })).rejects.toThrow(/ENGAGEMENT_STALE/)
    expect(again.openEngagementIds()).toEqual([B1])
  })

  it('records the signer on first open and refuses a different one (SIGNER_MISMATCH)', async () => {
    const store = new MemoryStateStore()
    const source = new RoutedSource()
    await CosignerService.open(baseOpts(source, store))
    expect((await store.loadAll()).meta['signer.address']).toBe(W.cosigner.address)
    await expect(CosignerService.open(baseOpts(source, store, { signer: localSigner(W.agent) }))).rejects.toThrow(/SIGNER_MISMATCH/)
    await expect(CosignerService.open(baseOpts(source, store))).resolves.toBeInstanceOf(CosignerService)
  })

  it('imports decisions.jsonl once into an empty store; later appends are a best-effort export', async () => {
    const dir = tmp()
    const { svc } = await b1Svc()
    await svc.decide({ engagementId: B1, stage: 'spend', tx: pay('800', 21), statements: [b1Invoice()] })
    await svc.decide({ engagementId: B1, stage: 'spend', tx: pay('800', 22, 'inv:X', W.stranger.address) })
    const old = svc.decisions()
    fs.writeFileSync(path.join(dir, 'decisions.jsonl'), old.map((s) => JSON.stringify(s)).join('\n') + '\n')
    const store = new MemoryStateStore()
    const a = await CosignerService.open(baseOpts(new RoutedSource(), store, { dataDir: dir }))
    expect(a.decisions()).toEqual(old)
    expect((await store.loadAll()).meta['jsonl.imported']).toBeDefined()
    const b = await CosignerService.open(baseOpts(new RoutedSource(), store, { dataDir: dir }))
    expect(b.decisions()).toEqual(old) // not imported twice
    await b.register(b1Engagement(), b1Mandate())
    await b.decide({ engagementId: B1, stage: 'spend', tx: pay('800', 23), statements: [b1Invoice()] })
    const lines = fs.readFileSync(path.join(dir, 'decisions.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect((await store.loadAll()).decisions.map((d) => d.statement)).toEqual(b.decisions())
  })

  it('a failed decisions.jsonl export is warned about, never fatal', async () => {
    const file = path.join(tmp(), 'not-a-dir')
    fs.writeFileSync(file, '')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const svc = new CosignerService(baseOpts(new RoutedSource(), new MemoryStateStore(), { dataDir: file }))
    await svc.register(b1Engagement(), b1Mandate())
    const r = await svc.decide({ engagementId: B1, stage: 'spend', tx: pay('800', 21), statements: [b1Invoice()] })
    expect(r.decision).toBe('SIGN')
    expect(svc.decisions()).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
  })
})

describe('closed engagements and quiet ticks', () => {
  it('markClosed persists, drops the engagement from openEngagementIds, keeps reads; tick returns []', async () => {
    const { svc, store } = await hotelCheckedIn('2026-11-17T12:00:00Z')
    await svc.storePresigned(H2, 'default.release', presign(releaseTx()))
    expect(svc.openEngagementIds()).toEqual([H2])
    await svc.markClosed(H2)
    expect((await store.loadAll()).engagements[0].closed).toBe(true)
    expect(svc.openEngagementIds()).toEqual([])
    expect(svc.engagement(H2)).toBeDefined()
    expect(await svc.tick(H2)).toEqual([])
    const again = await CosignerService.open(baseOpts(new RoutedSource(), store))
    expect(again.openEngagementIds()).toEqual([])
    expect(again.engagement(H2)).toEqual(svc.engagement(H2))
  })

  it('a quiet tick logs a repeated identical refusal once; a non-quiet tick logs as today', async () => {
    const { svc, store } = await hotelCheckedIn('2026-11-17T11:00:00Z')
    await svc.storePresigned(H2, 'default.release', presign(releaseTx()))
    const n = svc.decisions(H2).length
    const [a] = await svc.tick(H2, { quiet: true })
    expect(a).toMatchObject({ decision: 'REFUSE', failing: ['L1'] })
    expect(svc.decisions(H2)).toHaveLength(n + 1)
    const [b] = await svc.tick(H2, { quiet: true })
    expect(b).toMatchObject({ decision: 'REFUSE', failing: ['L1'] })
    expect(svc.decisions(H2)).toHaveLength(n + 1) // returned, not logged
    expect((await store.loadAll()).lastRefusal).toEqual([{ engagementId: H2, outcome: 'default.release', fingerprint: 'default.release:L1' }])
    await svc.tick(H2)
    expect(svc.decisions(H2)).toHaveLength(n + 2)
    await svc.tick(H2, { quiet: true })
    expect(svc.decisions(H2)).toHaveLength(n + 2)
    // The fingerprint survives a restart.
    const again = await CosignerService.open(baseOpts(new RoutedSource(undefined, hotel2Ledger({ balance: '562', closeTime: '2026-11-17T11:00:00Z' })), store))
    await again.tick(H2, { quiet: true })
    expect(again.decisions(H2)).toHaveLength(n + 2)
    expect((await store.loadAll()).decisions).toHaveLength(svc.decisions().length)
  })
})
