import type { Statement } from '@eng/core'
import type { InflightRecord, TickResult } from '../service.ts'
import type { StateStore, StoreSnapshot, StoreTx, StoredAttestation, StoredEngagement } from './types.ts'

interface MemState {
  meta: Map<string, string>
  engagements: Map<string, StoredEngagement>
  attestations: Map<string, StoredAttestation>
  presigned: Map<string, { engagementId: string; outcome: string; blob: string }>
  completed: Map<string, { engagementId: string; txHash: string; result: TickResult }>
  inflight: Map<string, InflightRecord>
  decisions: Array<{ seq: number; statement: Statement }>
  nextSeq: number
  lastRefusal: Map<string, { engagementId: string; outcome: string; fingerprint: string }>
}

const key = (...parts: string[]): string => JSON.stringify(parts)

const emptyState = (): MemState => ({
  meta: new Map(), engagements: new Map(), attestations: new Map(), presigned: new Map(), completed: new Map(),
  inflight: new Map(), decisions: [], nextSeq: 1, lastRefusal: new Map(),
})

const cloneState = (s: MemState): MemState => structuredClone(s)

/** In-memory StateStore. A transaction works on a staged copy that replaces the live state only if `fn` resolves. */
export class MemoryStateStore implements StateStore {
  private state: MemState = emptyState()
  private queue: Promise<unknown> = Promise.resolve()

  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const staged = cloneState(this.state)
      const out = await fn(this.txFor(staged))
      this.state = staged
      return out
    }
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => undefined)
    return result
  }

  async loadAll(): Promise<StoreSnapshot> {
    const s = this.state
    return structuredClone({
      meta: Object.fromEntries(s.meta),
      engagements: [...s.engagements.values()],
      attestations: [...s.attestations.values()],
      presigned: [...s.presigned.values()],
      completed: [...s.completed.values()],
      inflight: [...s.inflight.values()],
      decisions: [...s.decisions].sort((a, b) => a.seq - b.seq),
      lastRefusal: [...s.lastRefusal.values()],
    })
  }

  async close(): Promise<void> { await this.queue }

  private txFor(s: MemState): StoreTx {
    const engagement = (id: string): StoredEngagement => {
      const e = s.engagements.get(id)
      if (!e) throw new Error(`unknown engagement ${id}`)
      return e
    }
    return {
      putEngagement: async (e) => { s.engagements.set(e.engagementId, structuredClone(e)) },
      setConsumed: async (id, consumed) => { engagement(id).record.consumed = structuredClone(consumed) },
      setClosed: async (id) => { engagement(id).closed = true },
      putAttestation: async (a) => { s.attestations.set(key(a.engagementId, a.statement.id), structuredClone(a)) },
      putPresigned: async (engagementId, outcome, blob) => { s.presigned.set(key(engagementId, outcome), { engagementId, outcome, blob }) },
      deletePresigned: async (engagementId, outcome) => { s.presigned.delete(key(engagementId, outcome)) },
      putCompleted: async (engagementId, txHash, result) => { s.completed.set(key(engagementId, txHash), { engagementId, txHash, result: structuredClone(result) }) },
      deleteCompleted: async (engagementId, txHash) => { s.completed.delete(key(engagementId, txHash)) },
      addInflight: async (r) => { s.inflight.set(key(r.engagementId, r.proposedTxHash), structuredClone(r)) },
      removeInflight: async (engagementId, proposedTxHash) => { s.inflight.delete(key(engagementId, proposedTxHash)) },
      appendDecision: async (statement) => {
        const seq = s.nextSeq++
        s.decisions.push({ seq, statement: structuredClone(statement) })
        return seq
      },
      setLastRefusal: async (engagementId, outcome, fingerprint) => { s.lastRefusal.set(key(engagementId, outcome), { engagementId, outcome, fingerprint }) },
      setMeta: async (k, v) => { s.meta.set(k, v) },
    }
  }
}
