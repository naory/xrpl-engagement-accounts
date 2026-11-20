// Reusable StateStore contract: every store implementation (memory, SQLite) must pass it.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Statement } from '@eng/core'
import type { EngagementRecord } from '@eng/policy'
import type { InflightRecord, Receipt, TickResult } from '../src/service.ts'
import type { StateStore, StoreTx, StoredAttestation, StoredEngagement } from '../src/store/types.ts'

const stmt = (id: string, extra: Record<string, unknown> = {}): Statement => ({ id, type: 'test.statement/1', ...extra }) as unknown as Statement
const record = (id: string, consumed: string[] = []): EngagementRecord => ({ id, state: 'open', consumed }) as unknown as EngagementRecord
const engagement = (id: string, over: Partial<StoredEngagement> = {}): StoredEngagement => ({
  engagementId: id,
  registered: { record: record(id), mandate: stmt(`mandate-${id}`) },
  record: record(id),
  pins: { layerHashes: ['h1', 'h2'], templateId: 'hotel@2', templateHash: 'th' },
  closed: false,
  ...over,
})
const tickResult = (outcome: string): TickResult => ({ outcome, stage: 'execute', decision: 'SIGN', failing: [], record: stmt(`dec-${outcome}`), blob: 'BLOB' })
const inflight = (engagementId: string, hash: string, decisionId = 'd1'): InflightRecord => ({
  decisionId, txHash: hash, lastLedgerSequence: 99, payouts: [{ to: 'rX', asset: 'XRP', value: '1' }],
  engagementId, outer: { ticket: 5 }, payments: [{ sequence: 1 }], reserved: ['s1'], decidedAtLedger: 10, proposedTxHash: hash,
})

export function runStoreContract(name: string, makeStore: () => Promise<StateStore>, opts: { reopen?: (s: StateStore) => Promise<StateStore> } = {}): void {
  describe(`StateStore contract: ${name}`, () => {
    let store: StateStore
    beforeEach(async () => { store = await makeStore() })

    it('starts empty', async () => {
      expect(await store.loadAll()).toEqual({ meta: {}, engagements: [], attestations: [], presigned: [], completed: [], inflight: [], decisions: [], lastRefusal: [] })
    })

    it('round-trips every entity through loadAll', async () => {
      const e = engagement('e1')
      const att: StoredAttestation = { engagementId: 'e1', statement: stmt('a1'), receipt: { statement: stmt('r1') } as Receipt }
      const inf = inflight('e1', 'tx1')
      const res = tickResult('refund')
      let seq = 0
      await store.transaction(async (tx) => {
        await tx.putEngagement(e)
        await tx.putAttestation(att)
        await tx.putPresigned('e1', 'refund', 'blob-1')
        await tx.putCompleted('e1', 'tx1', res)
        await tx.addInflight(inf)
        seq = await tx.appendDecision(stmt('dec1'))
        await tx.setLastRefusal('e1', 'refund', 'fp1')
        await tx.setMeta('k', 'v')
      })
      const snap = await store.loadAll()
      expect(snap.engagements).toEqual([e])
      expect(snap.attestations).toEqual([att])
      expect(snap.presigned).toEqual([{ engagementId: 'e1', outcome: 'refund', blob: 'blob-1' }])
      expect(snap.completed).toEqual([{ engagementId: 'e1', txHash: 'tx1', result: res }])
      expect(snap.inflight).toEqual([inf])
      expect(snap.decisions).toEqual([{ seq, statement: stmt('dec1') }])
      expect(snap.lastRefusal).toEqual([{ engagementId: 'e1', outcome: 'refund', fingerprint: 'fp1' }])
      expect(snap.meta).toEqual({ k: 'v' })
    })

    it('setConsumed updates the mutable record only; setClosed closes', async () => {
      await store.transaction(async (tx) => { await tx.putEngagement(engagement('e1')) })
      await store.transaction(async (tx) => { await tx.setConsumed('e1', ['s1', 's2']); await tx.setClosed('e1') })
      const [e] = (await store.loadAll()).engagements
      expect(e.record.consumed).toEqual(['s1', 's2'])
      expect(e.registered.record.consumed).toEqual([])
      expect(e.closed).toBe(true)
    })

    it('upsert: the same key twice yields one row, last wins', async () => {
      await store.transaction(async (tx) => {
        await tx.putEngagement(engagement('e1'))
        await tx.putEngagement(engagement('e1', { closed: true }))
        await tx.putAttestation({ engagementId: 'e1', statement: stmt('a1', { v: 1 }), receipt: { statement: stmt('r1') } })
        await tx.putAttestation({ engagementId: 'e1', statement: stmt('a1', { v: 2 }), receipt: { statement: stmt('r1') } })
        await tx.putPresigned('e1', 'refund', 'old')
        await tx.putPresigned('e1', 'refund', 'new')
        await tx.putCompleted('e1', 'tx1', tickResult('a'))
        await tx.putCompleted('e1', 'tx1', tickResult('b'))
        await tx.addInflight(inflight('e1', 'tx1', 'old'))
        await tx.addInflight(inflight('e1', 'tx1', 'new'))
        await tx.setLastRefusal('e1', 'refund', 'fp1')
        await tx.setLastRefusal('e1', 'refund', 'fp2')
      })
      const snap = await store.loadAll()
      expect(snap.engagements).toHaveLength(1)
      expect(snap.engagements[0].closed).toBe(true)
      expect(snap.attestations).toHaveLength(1)
      expect(snap.attestations[0].statement).toEqual(stmt('a1', { v: 2 }))
      expect(snap.presigned).toEqual([{ engagementId: 'e1', outcome: 'refund', blob: 'new' }])
      expect(snap.completed).toHaveLength(1)
      expect(snap.completed[0].result.outcome).toBe('b')
      expect(snap.inflight).toHaveLength(1)
      expect(snap.inflight[0].decisionId).toBe('new')
      expect(snap.lastRefusal).toEqual([{ engagementId: 'e1', outcome: 'refund', fingerprint: 'fp2' }])
    })

    it('loadAll keeps insertion order for attestations, presigned, completed and inflight; an upsert keeps its position', async () => {
      const ids = ['m', 'c', 'x', 'a'] // deliberately not alphabetical
      await store.transaction(async (tx) => {
        for (const id of ids.slice(0, 2)) {
          await tx.putAttestation({ engagementId: 'e1', statement: stmt(id), receipt: { statement: stmt('r') } })
          await tx.putPresigned('e1', id, 'b')
          await tx.putCompleted('e1', id, tickResult(id))
          await tx.addInflight(inflight('e1', id))
        }
      })
      await store.transaction(async (tx) => {
        for (const id of ids.slice(2)) {
          await tx.putAttestation({ engagementId: 'e1', statement: stmt(id), receipt: { statement: stmt('r') } })
          await tx.putPresigned('e1', id, 'b')
          await tx.putCompleted('e1', id, tickResult(id))
          await tx.addInflight(inflight('e1', id))
        }
        // upsert the first row of each list: it stays first
        await tx.putAttestation({ engagementId: 'e1', statement: stmt('m', { v: 2 }), receipt: { statement: stmt('r') } })
        await tx.putPresigned('e1', 'm', 'b2')
        await tx.putCompleted('e1', 'm', tickResult('m2'))
        await tx.addInflight(inflight('e1', 'm', 'd2'))
      })
      const check = async (s: StateStore) => {
        const snap = await s.loadAll()
        expect(snap.attestations.map((a) => a.statement.id)).toEqual(ids)
        expect(snap.presigned.map((p) => p.outcome)).toEqual(ids)
        expect(snap.completed.map((c) => c.txHash)).toEqual(ids)
        expect(snap.inflight.map((i) => i.proposedTxHash)).toEqual(ids)
        expect(snap.presigned[0].blob).toBe('b2')
        expect(snap.inflight[0].decisionId).toBe('d2')
      }
      await check(store)
      // delete + re-add moves a row to the end (as Map delete + set does)
      await store.transaction(async (tx) => { await tx.deletePresigned('e1', 'c'); await tx.putPresigned('e1', 'c', 'b') })
      expect((await store.loadAll()).presigned.map((p) => p.outcome)).toEqual(['m', 'x', 'a', 'c'])
      await store.transaction(async (tx) => { await tx.deletePresigned('e1', 'c'); await tx.putPresigned('e1', 'c', 'b') })
      if (opts.reopen) {
        await store.close()
        store = await opts.reopen(store)
        expect((await store.loadAll()).presigned.map((p) => p.outcome)).toEqual(['m', 'x', 'a', 'c'])
        await store.transaction(async (tx) => { await tx.putPresigned('e1', 'z', 'b') })
        expect((await store.loadAll()).presigned.map((p) => p.outcome)).toEqual(['m', 'x', 'a', 'c', 'z'])
        expect((await store.loadAll()).attestations.map((a) => a.statement.id)).toEqual(ids)
      }
    })

    it('deleteLastRefusal removes only its row; a missing row is a no-op', async () => {
      await store.transaction(async (tx) => {
        await tx.setLastRefusal('e1', 'refund', 'f1')
        await tx.setLastRefusal('e1', 'release', 'f2')
      })
      await store.transaction(async (tx) => { await tx.deleteLastRefusal('e1', 'refund'); await tx.deleteLastRefusal('e1', 'nope') })
      expect((await store.loadAll()).lastRefusal).toEqual([{ engagementId: 'e1', outcome: 'release', fingerprint: 'f2' }])
    })

    it('removeInflight / deletePresigned / deleteCompleted remove only their row', async () => {
      await store.transaction(async (tx) => {
        await tx.putPresigned('e1', 'refund', 'b1')
        await tx.putPresigned('e1', 'release', 'b2')
        await tx.putCompleted('e1', 'tx1', tickResult('a'))
        await tx.putCompleted('e1', 'tx2', tickResult('b'))
        await tx.addInflight(inflight('e1', 'tx1'))
        await tx.addInflight(inflight('e1', 'tx2'))
      })
      await store.transaction(async (tx) => {
        await tx.removeInflight('e1', 'tx1')
        await tx.deletePresigned('e1', 'refund')
        await tx.deleteCompleted('e1', 'tx1')
        await tx.removeInflight('e1', 'nope') // missing: no-op
      })
      const snap = await store.loadAll()
      expect(snap.inflight.map((i) => i.proposedTxHash)).toEqual(['tx2'])
      expect(snap.presigned.map((p) => p.outcome)).toEqual(['release'])
      expect(snap.completed.map((c) => c.txHash)).toEqual(['tx2'])
    })

    it('appendDecision seq is strictly increasing across transactions; decisions ordered by seq', async () => {
      const seqs: number[] = []
      await store.transaction(async (tx) => { seqs.push(await tx.appendDecision(stmt('d1'))); seqs.push(await tx.appendDecision(stmt('d2'))) })
      await store.transaction(async (tx) => { seqs.push(await tx.appendDecision(stmt('d3'))) })
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
      const { decisions } = await store.loadAll()
      expect(decisions.map((d) => d.statement.id)).toEqual(['d1', 'd2', 'd3'])
      expect(decisions.map((d) => d.seq)).toEqual(seqs)
    })

    it('a transaction whose fn throws persists nothing', async () => {
      await store.transaction(async (tx) => { await tx.setMeta('k', 'before'); await tx.appendDecision(stmt('d1')) })
      await expect(store.transaction(async (tx) => {
        await tx.putEngagement(engagement('e1'))
        await tx.putAttestation({ engagementId: 'e1', statement: stmt('a1'), receipt: { statement: stmt('r1') } })
        await tx.putPresigned('e1', 'refund', 'b')
        await tx.putCompleted('e1', 'tx1', tickResult('a'))
        await tx.addInflight(inflight('e1', 'tx1'))
        await tx.appendDecision(stmt('d2'))
        await tx.setLastRefusal('e1', 'refund', 'fp')
        await tx.setMeta('k', 'after')
        throw new Error('boom')
      })).rejects.toThrow('boom')
      const snap = await store.loadAll()
      expect(snap).toEqual({ meta: { k: 'before' }, engagements: [], attestations: [], presigned: [], completed: [], inflight: [], decisions: [{ seq: snap.decisions[0].seq, statement: stmt('d1') }], lastRefusal: [] })
      // the rolled-back seq is not visible: the next decision still orders after d1
      await store.transaction(async (tx) => { await tx.appendDecision(stmt('d3')) })
      expect((await store.loadAll()).decisions.map((d) => d.statement.id)).toEqual(['d1', 'd3'])
    })

    it('setMeta overwrites', async () => {
      await store.transaction(async (tx) => { await tx.setMeta('k', 'a') })
      await store.transaction(async (tx) => { await tx.setMeta('k', 'b'); await tx.setMeta('j', 'x') })
      expect((await store.loadAll()).meta).toEqual({ k: 'b', j: 'x' })
    })

    it('transactions are serialized', async () => {
      const order: string[] = []
      const slow = store.transaction(async (tx) => { order.push('a:start'); await new Promise((r) => setTimeout(r, 20)); await tx.setMeta('k', 'a'); order.push('a:end') })
      const fast = store.transaction(async (tx) => { order.push('b:start'); await tx.setMeta('k', 'b'); order.push('b:end') })
      await Promise.all([slow, fast])
      expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
      expect((await store.loadAll()).meta.k).toBe('b')
    })

    it('a failed transaction does not block later ones', async () => {
      await expect(store.transaction(async () => { throw new Error('x') })).rejects.toThrow('x')
      await store.transaction(async (tx) => { await tx.setMeta('k', 'ok') })
      expect((await store.loadAll()).meta.k).toBe('ok')
    })

    it('key granularity: rows differing in any key component are all kept', async () => {
      await store.transaction(async (tx) => {
        await tx.putAttestation({ engagementId: 'e1', statement: stmt('a1'), receipt: { statement: stmt('r') } })
        await tx.putAttestation({ engagementId: 'e1', statement: stmt('a2'), receipt: { statement: stmt('r') } })
        await tx.putAttestation({ engagementId: 'e2', statement: stmt('a1'), receipt: { statement: stmt('r') } })
        for (const e of ['e1', 'e2']) {
          await tx.putPresigned(e, 'refund', 'b-' + e)
          await tx.putCompleted(e, 'tx1', tickResult('o-' + e))
          await tx.addInflight(inflight(e, 'tx1', 'd-' + e))
        }
        await tx.setLastRefusal('e1', 'refund', 'f1')
        await tx.setLastRefusal('e1', 'release', 'f2')
        await tx.setLastRefusal('e2', 'refund', 'f3')
      })
      const snap = await store.loadAll()
      expect(snap.attestations.map((a) => [a.engagementId, a.statement.id]).sort()).toEqual([['e1', 'a1'], ['e1', 'a2'], ['e2', 'a1']])
      expect(snap.presigned.map((p) => p.blob).sort()).toEqual(['b-e1', 'b-e2'])
      expect(snap.completed.map((c) => c.result.outcome).sort()).toEqual(['o-e1', 'o-e2'])
      expect(snap.inflight.map((i) => i.decisionId).sort()).toEqual(['d-e1', 'd-e2'])
      expect(snap.lastRefusal.map((r) => r.fingerprint).sort()).toEqual(['f1', 'f2', 'f3'])
    })

    it('setConsumed / setClosed on a missing engagement reject, and a transaction failing there persists nothing', async () => {
      await expect(store.transaction(async (tx) => { await tx.setConsumed('missing', ['s']) })).rejects.toThrow()
      await expect(store.transaction(async (tx) => { await tx.setClosed('missing') })).rejects.toThrow()
      for (const bad of [(tx: StoreTx) => tx.setConsumed('missing', ['s']), (tx: StoreTx) => tx.setClosed('missing')]) {
        await expect(store.transaction(async (tx) => {
          await tx.putEngagement(engagement('e1'))
          await tx.setMeta('k', 'v')
          await tx.appendDecision(stmt('d1'))
          await bad(tx)
        })).rejects.toThrow()
        const snap = await store.loadAll()
        expect(snap.engagements).toEqual([])
        expect(snap.meta).toEqual({})
        expect(snap.decisions).toEqual([])
      }
    })

    it('round-trips a null mandate as null', async () => {
      await store.transaction(async (tx) => { await tx.putEngagement(engagement('e1', { registered: { record: record('e1'), mandate: null } })) })
      const [e] = (await store.loadAll()).engagements
      expect(e.registered.mandate).toBeNull()
    })

    it('a tx used after its transaction settled throws', async () => {
      let leaked!: StoreTx
      await store.transaction(async (tx) => { leaked = tx })
      await expect(leaked.setMeta('k', 'v')).rejects.toThrow(/transaction closed/)
      let leaked2!: StoreTx
      await expect(store.transaction(async (tx) => { leaked2 = tx; throw new Error('x') })).rejects.toThrow('x')
      await expect(leaked2.setMeta('k', 'v')).rejects.toThrow(/transaction closed/)
      expect((await store.loadAll()).meta).toEqual({})
    })

    if (opts.reopen) {
      it('survives close and reopen with seq continuing', async () => {
        const e = engagement('e1', { registered: { record: record('e1'), mandate: null } })
        const att: StoredAttestation = { engagementId: 'e1', statement: stmt('a1'), receipt: { statement: stmt('r1') } }
        const inf = inflight('e1', 'tx1')
        let seq = 0
        await store.transaction(async (tx) => {
          await tx.putEngagement(e)
          await tx.setConsumed('e1', ['s1'])
          await tx.setClosed('e1')
          await tx.putAttestation(att)
          await tx.putPresigned('e1', 'refund', 'b')
          await tx.putCompleted('e1', 'tx1', tickResult('a'))
          await tx.addInflight(inf)
          seq = await tx.appendDecision(stmt('d1'))
          await tx.setLastRefusal('e1', 'refund', 'fp')
          await tx.setMeta('k', 'v')
        })
        const before = await store.loadAll()
        await store.close()
        store = await opts.reopen!(store)
        expect(await store.loadAll()).toEqual(before)
        expect(before.engagements[0].registered.mandate).toBeNull()
        let next = 0
        await store.transaction(async (tx) => { next = await tx.appendDecision(stmt('d2')) })
        expect(next).toBeGreaterThan(seq)
      })
    }

    it('loadAll returns copies: mutating a snapshot does not change the store', async () => {
      await store.transaction(async (tx) => { await tx.putEngagement(engagement('e1')) })
      const snap = await store.loadAll()
      snap.engagements[0].record.consumed!.push('hack')
      snap.engagements[0].closed = true
      const again = await store.loadAll()
      expect(again.engagements[0].record.consumed).toEqual([])
      expect(again.engagements[0].closed).toBe(false)
    })
  })
}
