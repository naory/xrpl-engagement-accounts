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

/** In-memory StateStore. StoreTx has no reads, so a transaction records its writes (values cloned at call time) and applies
 * them to the live state, in order, only if `fn` resolves: all-or-nothing without copying the whole state. */
export class MemoryStateStore implements StateStore {
  private state: MemState = emptyState()
  private queue: Promise<unknown> = Promise.resolve()

  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const ops: Array<(s: MemState) => void> = []
      const live = { open: true }
      try {
        const out = await fn(this.guard(this.txFor(ops), live))
        for (const op of ops) op(this.state) // validated when recorded: cannot throw here
        return out
      } finally {
        live.open = false
      }
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

  /** Reject any use of a tx after its transaction has settled. */
  private guard(tx: StoreTx, live: { open: boolean }): StoreTx {
    const out = {} as Record<string, unknown>
    for (const [name, f] of Object.entries(tx)) {
      out[name] = (...args: unknown[]) => {
        if (!live.open) return Promise.reject(new Error('transaction closed'))
        return (f as (...a: unknown[]) => Promise<unknown>)(...args)
      }
    }
    return out as unknown as StoreTx
  }

  /** A StoreTx that records ops. Map.set keeps an existing key's position, so an upsert keeps insertion order. */
  private txFor(ops: Array<(s: MemState) => void>): StoreTx {
    const put = new Set<string>() // engagements put earlier in this transaction
    let appended = 0
    const requireEngagement = (id: string): void => {
      if (!this.state.engagements.has(id) && !put.has(id)) throw new Error(`unknown engagement ${id}`)
    }
    const op = async (f: (s: MemState) => void): Promise<void> => { ops.push(f) }
    return {
      putEngagement: (e) => { const v = structuredClone(e); put.add(v.engagementId); return op((s) => { s.engagements.set(v.engagementId, v) }) },
      setConsumed: async (id, consumed) => { requireEngagement(id); const v = structuredClone(consumed); ops.push((s) => { s.engagements.get(id)!.record.consumed = v }) },
      setClosed: async (id) => { requireEngagement(id); ops.push((s) => { s.engagements.get(id)!.closed = true }) },
      putAttestation: (a) => { const v = structuredClone(a); return op((s) => { s.attestations.set(key(v.engagementId, v.statement.id), v) }) },
      putPresigned: (engagementId, outcome, blob) => op((s) => { s.presigned.set(key(engagementId, outcome), { engagementId, outcome, blob }) }),
      deletePresigned: (engagementId, outcome) => op((s) => { s.presigned.delete(key(engagementId, outcome)) }),
      putCompleted: (engagementId, txHash, result) => { const v = structuredClone(result); return op((s) => { s.completed.set(key(engagementId, txHash), { engagementId, txHash, result: v }) }) },
      deleteCompleted: (engagementId, txHash) => op((s) => { s.completed.delete(key(engagementId, txHash)) }),
      addInflight: (r) => { const v = structuredClone(r); return op((s) => { s.inflight.set(key(v.engagementId, v.proposedTxHash), v) }) },
      removeInflight: (engagementId, proposedTxHash) => op((s) => { s.inflight.delete(key(engagementId, proposedTxHash)) }),
      appendDecision: async (statement) => {
        const v = structuredClone(statement)
        const seq = this.state.nextSeq + appended++
        ops.push((s) => { s.decisions.push({ seq, statement: v }); s.nextSeq = seq + 1 })
        return seq
      },
      setLastRefusal: (engagementId, outcome, fingerprint) => op((s) => { s.lastRefusal.set(key(engagementId, outcome), { engagementId, outcome, fingerprint }) }),
      deleteLastRefusal: (engagementId, outcome) => op((s) => { s.lastRefusal.delete(key(engagementId, outcome)) }),
      setMeta: (k, v) => op((s) => { s.meta.set(k, v) }),
    }
  }
}
