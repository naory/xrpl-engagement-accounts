// Tick scheduler: pre-signed defaults complete on a timer, quietly, without overlapping rounds or double-signing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import xrpl from 'xrpl'
import { localSigner } from '@eng/core'
import { CosignerService, MemoryStateStore, combine, startTickScheduler, submitUntilValidated, type SubmitIo, type SnapshotRequest, type TickResult } from '@eng/cosigner'
import { type LedgerSnapshot } from '@eng/policy'
import { W, hotel2Close, hotel2Confirmation, hotel2Engagement, hotel2Ledger, hotel2Mandate, memo, checkin, claim, dispute, guestCheckin, policies, templates } from '../../policy/test/fixtures.ts'

type Json = Record<string, unknown>
const H2 = 'eng_hotel2_fixture'
const INTERVAL = 1000

class Ledger {
  constructor(public h2: LedgerSnapshot = hotel2Ledger({ closeTime: '2026-11-01T09:31:00Z' })) {}
  async snapshot(_q: SnapshotRequest): Promise<LedgerSnapshot> { return structuredClone(this.h2) }
}

const presign = (tx: Json) => combine([W.dana, W.atlas].map((w) => w.sign(structuredClone(tx) as never, true).tx_blob))
const claimCb = () => presign(hotel2Close([{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }, { to: W.dana.address, value: '0', partial: true }], { tickets: true, memos: [memo('eng/basis', 'default.chargebackClaim')] }))

/** hotel@2 with a receipted claim and settlement dispute and the chargeback default stored; due at 2026-11-21T10:00:00. */
async function disputed(ledger = new Ledger()): Promise<CosignerService> {
  const svc = await CosignerService.open({
    signer: localSigner(W.cosigner), source: ledger, store: new MemoryStateStore(),
    templates: [templates.hotel2], policies: [policies.baseline, policies.hotel2],
  })
  await svc.register(hotel2Engagement(), hotel2Mandate())
  await svc.ingest(H2, hotel2Confirmation())
  ledger.h2.closeTime = '2026-11-11T15:01:00Z'
  await svc.ingest(H2, checkin('checked_in'))
  await svc.ingest(H2, guestCheckin())
  ledger.h2 = hotel2Ledger({ balance: '572', dispute: true, closeTime: '2026-11-14T15:01:00Z' })
  await svc.ingest(H2, claim([{ kind: 'minibar', amount: '58.00' }]))
  ledger.h2.closeTime = '2026-11-16T10:00:30Z'
  await svc.ingest(H2, dispute('settlement', '2026-11-16T10:00:00Z'))
  await svc.storePresigned(H2, 'default.chargebackClaim', claimCb())
  return svc
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('tick scheduler', () => {
  it('SIGNs a due default and hands it to onResult within one interval', async () => {
    const ledger = new Ledger()
    const svc = await disputed(ledger)
    ledger.h2.closeTime = '2026-11-21T10:00:01Z'
    const seen: Array<[string, TickResult]> = []
    const s = startTickScheduler(svc, { intervalMs: INTERVAL, onResult: (id, r) => { seen.push([id, r]) } })
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(seen).toHaveLength(1)
    expect(seen[0][0]).toBe(H2)
    expect(seen[0][1]).toMatchObject({ outcome: 'default.chargebackClaim', decision: 'SIGN' })
    expect(xrpl.decode(seen[0][1].blob!)).toBeTruthy()
    await s.stop()
    await svc.close()
  })

  it('hands a SIGN that stays in flight to onResult once across rounds', async () => {
    const ledger = new Ledger()
    const svc = await disputed(ledger)
    ledger.h2.closeTime = '2026-11-21T10:00:01Z'
    const onResult = vi.fn()
    const s = startTickScheduler(svc, { intervalMs: INTERVAL, onResult })
    await vi.advanceTimersByTimeAsync(INTERVAL * 4)
    expect(onResult).toHaveBeenCalledTimes(1)
    await s.stop()
    await svc.close()
  })

  it('retries onResult next round when it throws', async () => {
    const ledger = new Ledger()
    const svc = await disputed(ledger)
    ledger.h2.closeTime = '2026-11-21T10:00:01Z'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const onResult = vi.fn().mockRejectedValueOnce(new Error('submit down')).mockResolvedValue(undefined)
    const s = startTickScheduler(svc, { intervalMs: INTERVAL, onResult })
    await vi.advanceTimersByTimeAsync(INTERVAL * 4)
    expect(onResult).toHaveBeenCalledTimes(2)
    await s.stop()
    await svc.close()
  })

  it('does not log a not-due refusal again on later rounds (quiet)', async () => {
    const svc = await disputed()
    const s = startTickScheduler(svc, { intervalMs: INTERVAL })
    await vi.advanceTimersByTimeAsync(INTERVAL)
    const logged = svc.decisions(H2).length
    expect(logged).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(svc.decisions(H2).length).toBe(logged)
    await s.stop()
    await svc.close()
  })

  it('closes an engagement only after its account is missing in two consecutive rounds, then skips it', async () => {
    const ledger = new Ledger()
    const svc = await disputed(ledger)
    const snap = vi.spyOn(ledger, 'snapshot')
    const acct = ledger.h2.accounts[W.engHotel2.address]
    acct.exists = false
    const s = startTickScheduler(svc, { intervalMs: INTERVAL })
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(svc.openEngagementIds()).toEqual([H2]) // gone once: not closed
    acct.exists = true
    await vi.advanceTimersByTimeAsync(INTERVAL * 2)
    expect(svc.openEngagementIds()).toEqual([H2]) // seen again: the count reset
    acct.exists = false
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(svc.openEngagementIds()).toEqual([H2]) // gone once again
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(svc.openEngagementIds()).toEqual([]) // gone twice in a row
    const calls = snap.mock.calls.length
    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(snap.mock.calls.length).toBe(calls)
    await s.stop()
    await svc.close()
  })

  it('never closes an engagement that merely has nothing due', async () => {
    const ledger = new Ledger()
    const svc = await CosignerService.open({
      signer: localSigner(W.cosigner), source: ledger, store: new MemoryStateStore(),
      templates: [templates.hotel2], policies: [policies.baseline, policies.hotel2],
    })
    await svc.register(hotel2Engagement(), hotel2Mandate())
    const snap = vi.spyOn(ledger, 'snapshot')
    const s = startTickScheduler(svc, { intervalMs: INTERVAL })
    await vi.advanceTimersByTimeAsync(INTERVAL * 4)
    expect(svc.openEngagementIds()).toEqual([H2])
    expect(snap).not.toHaveBeenCalled() // no stored default: no snapshot at all
    await s.stop()
    await svc.close()
  })

  it('a round and a concurrent decide on the same engagement leave one in-flight entry and one distinct signed tx', async () => {
    const ledger = new Ledger()
    const svc = await disputed(ledger)
    const [probe] = await svc.tick(H2)
    ledger.h2.closeTime = '2026-11-21T10:00:01Z'
    const signs = () => svc.decisions(H2).filter((d) => d.type === 'cosigner.decision/1' && (d.claim as { decision?: string }).decision === 'SIGN').length
    const before = signs()
    const s = startTickScheduler(svc, { intervalMs: INTERVAL })
    const pending = svc.decide({ engagementId: H2, stage: probe.stage, txBlob: claimCb() }).catch((e) => e)
    await vi.advanceTimersByTimeAsync(INTERVAL)
    await pending
    expect(svc.inflightFor(H2)).toHaveLength(1)
    // Serialized per engagement; re-requesting the same transaction replaces its in-flight entry, so exactly one
    // distinct transaction was signed (a repeat decision for the same hash is idempotent) and later rounds add nothing.
    const hashes = () => new Set(svc.decisions(H2).slice(-20).filter((d) => d.type === 'cosigner.decision/1' && (d.claim as { decision?: string }).decision === 'SIGN').map((d) => (d.subject as { proposedTxHash: string }).proposedTxHash))
    const settled = signs()
    expect(settled).toBeGreaterThan(before)
    expect(hashes().size).toBe(1)
    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(signs()).toBe(settled)
    expect(svc.inflightFor(H2)).toHaveLength(1)
    await s.stop()
    await svc.close()
  })

  it('rounds never overlap and stop() resolves after the in-flight round', async () => {
    const svc = await disputed()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let active = 0, maxActive = 0, started = 0
    const orig = svc.tick.bind(svc)
    vi.spyOn(svc, 'tick').mockImplementation(async (id, o) => {
      started++; active++; maxActive = Math.max(maxActive, active)
      await gate
      try { return await orig(id, o) } finally { active-- }
    })
    const s = startTickScheduler(svc, { intervalMs: INTERVAL })
    await vi.advanceTimersByTimeAsync(INTERVAL * 5)
    expect(started).toBe(1)
    let stopped = false
    const stopping = s.stop().then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(stopped).toBe(false)
    release()
    await stopping
    expect(stopped).toBe(true)
    expect(maxActive).toBe(1)
    await vi.advanceTimersByTimeAsync(INTERVAL * 5)
    expect(started).toBe(1)
    await svc.close()
  })

  it('a throwing ledger tick does not exit, and the next tick runs', async () => {
    const ledger = new Ledger()
    const svc = await disputed(ledger)
    let armed = false
    let reads = 0
    const orig = ledger.snapshot.bind(ledger)
    ledger.snapshot = async (q) => {
      if (armed) {
        reads++
        if (reads === 1) throw new Error('LEDGER_UNAVAILABLE: socket hang up')
      }
      return orig(q)
    }
    armed = true
    const errors: Error[] = []
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const s = startTickScheduler(svc, { intervalMs: INTERVAL, onError: (e) => { errors.push(e); process.exit(1) } })
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(reads).toBe(1)
    expect(errors).toEqual([])
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(errors).toEqual([])
    expect(exit).not.toHaveBeenCalled()
    await s.stop()
    await svc.close()
  })

  it('logs an error on one engagement and carries on; STORE_LOCKED stops the scheduler and reaches onError', async () => {
    const svc = await disputed()
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const tick = vi.spyOn(svc, 'tick').mockRejectedValueOnce(new Error('boom'))
    const errors: Error[] = []
    const s = startTickScheduler(svc, { intervalMs: INTERVAL, onError: (e) => { errors.push(e) } })
    await vi.advanceTimersByTimeAsync(INTERVAL * 2)
    expect(errors).toEqual([])
    expect(warn).toHaveBeenCalled()
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(2)
    tick.mockRejectedValue(new Error('STORE_LOCKED: lease lost to another owner'))
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toMatch(/STORE_LOCKED/)
    const calls = tick.mock.calls.length
    await vi.advanceTimersByTimeAsync(INTERVAL * 5)
    expect(tick.mock.calls.length).toBe(calls)
    await s.stop()
    await svc.close()
  })
})

describe('submitUntilValidated (scheduler hand-off)', () => {
  const io = (o: Partial<SubmitIo> = {}): SubmitIo => ({
    lookup: vi.fn(async () => null),
    submit: vi.fn(async () => ({ hash: 'H', prelim: 'tesSUCCESS', final: 'tesSUCCESS', validated: true })),
    ...o,
  })

  it('resolves once validated, with tes or tec', async () => {
    expect(await submitUntilValidated(io(), 'B', 'H')).toEqual({ hash: 'H', final: 'tesSUCCESS', alreadyValidated: false })
    const tec = io({ submit: vi.fn(async () => ({ hash: 'H', prelim: 'tecUNFUNDED_PAYMENT', final: 'tecUNFUNDED_PAYMENT', validated: true })) })
    expect((await submitUntilValidated(tec, 'B', 'H')).final).toBe('tecUNFUNDED_PAYMENT')
  })

  it('throws on tef/tel/tem and on NOT_VALIDATED, so the blob stays retryable', async () => {
    for (const final of ['tefPAST_SEQ', 'telINSUF_FEE_P', 'temMALFORMED', 'NOT_VALIDATED']) {
      const x = io({ submit: vi.fn(async () => ({ hash: 'H', prelim: final === 'NOT_VALIDATED' ? 'tesSUCCESS' : final, final, validated: false })) })
      await expect(submitUntilValidated(x, 'B', 'H')).rejects.toThrow(/^SUBMIT_NOT_VALIDATED /)
    }
  })

  it('does not resubmit a blob that is already in a validated ledger', async () => {
    const x = io({ lookup: vi.fn(async () => ({ validated: true, meta: { TransactionResult: 'tesSUCCESS' } })) })
    expect(await submitUntilValidated(x, 'B', 'H')).toEqual({ hash: 'H', final: 'tesSUCCESS', alreadyValidated: true })
    expect(x.submit).not.toHaveBeenCalled()
  })

  it('through the scheduler: a tel submit is retried next round, then handed off once when validated', async () => {
    const ledger = new Ledger()
    const svc = await disputed(ledger)
    ledger.h2.closeTime = '2026-11-21T10:00:01Z'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const submit = vi.fn()
      .mockResolvedValueOnce({ hash: 'H', prelim: 'telINSUF_FEE_P', final: 'telINSUF_FEE_P', validated: false })
      .mockResolvedValue({ hash: 'H', prelim: 'tesSUCCESS', final: 'tesSUCCESS', validated: true })
    const x = io({ submit })
    const s = startTickScheduler(svc, { intervalMs: INTERVAL, onResult: async (_id, r) => { await submitUntilValidated(x, r.blob!, 'H') } })
    await vi.advanceTimersByTimeAsync(INTERVAL * 5)
    expect(submit).toHaveBeenCalledTimes(2)
    await s.stop()
    await svc.close()
  })
})
