// Tick scheduler: pre-signed defaults complete on a timer, quietly, without overlapping rounds or double-signing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import xrpl from 'xrpl'
import { localSigner } from '@eng/core'
import { CosignerService, MemoryStateStore, combine, startTickScheduler, type SnapshotRequest, type TickResult } from '@eng/cosigner'
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

  it('marks an engagement whose account is gone closed and skips it afterwards', async () => {
    const ledger = new Ledger()
    const svc = await disputed(ledger)
    const snap = vi.spyOn(ledger, 'snapshot')
    ledger.h2.accounts[W.engHotel2.address].exists = false
    const s = startTickScheduler(svc, { intervalMs: INTERVAL })
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(svc.openEngagementIds()).toEqual([])
    const calls = snap.mock.calls.length
    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(snap.mock.calls.length).toBe(calls)
    await s.stop()
    await svc.close()
  })

  it('never closes an engagement that merely has nothing due', async () => {
    const svc = await CosignerService.open({
      signer: localSigner(W.cosigner), source: new Ledger(), store: new MemoryStateStore(),
      templates: [templates.hotel2], policies: [policies.baseline, policies.hotel2],
    })
    await svc.register(hotel2Engagement(), hotel2Mandate())
    const s = startTickScheduler(svc, { intervalMs: INTERVAL })
    await vi.advanceTimersByTimeAsync(INTERVAL * 2)
    expect(svc.openEngagementIds()).toEqual([H2])
    await s.stop()
    await svc.close()
  })

  it('a round and a concurrent decide on the same engagement leave one in-flight entry and settle on no further signing', async () => {
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
    // The two calls are serialized per engagement. Re-requesting the same transaction replaces its in-flight entry
    // (it never counts against itself), so at most these two decisions sign it, and later rounds sign nothing more.
    const settled = signs()
    expect(settled - before).toBeGreaterThanOrEqual(1)
    expect(settled - before).toBeLessThanOrEqual(2)
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
