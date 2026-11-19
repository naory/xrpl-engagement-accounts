import type { Statement } from '@eng/core'
import type { EngagementRecord } from '@eng/policy'
import type { InflightRecord, Receipt, TickResult } from '../service.ts'

export interface StoredEngagement {
  engagementId: string
  registered: { record: EngagementRecord; mandate: Statement | null } // immutable, as received
  record: EngagementRecord // mutable (consumed)
  pins: { layerHashes: string[]; templateId: string; templateHash: string }
  closed: boolean
}
export interface StoredAttestation { engagementId: string; statement: Statement; receipt: Receipt }
export interface StoreSnapshot {
  meta: Record<string, string>
  engagements: StoredEngagement[]
  attestations: StoredAttestation[]
  presigned: Array<{ engagementId: string; outcome: string; blob: string }>
  completed: Array<{ engagementId: string; txHash: string; result: TickResult }>
  inflight: InflightRecord[]
  decisions: Array<{ seq: number; statement: Statement }>
  lastRefusal: Array<{ engagementId: string; outcome: string; fingerprint: string }>
}
export interface StoreTx {
  putEngagement(e: StoredEngagement): Promise<void>
  setConsumed(engagementId: string, consumed: string[]): Promise<void>
  setClosed(engagementId: string): Promise<void>
  putAttestation(a: StoredAttestation): Promise<void>
  putPresigned(engagementId: string, outcome: string, blob: string): Promise<void>
  deletePresigned(engagementId: string, outcome: string): Promise<void>
  putCompleted(engagementId: string, txHash: string, result: TickResult): Promise<void>
  deleteCompleted(engagementId: string, txHash: string): Promise<void>
  addInflight(r: InflightRecord): Promise<void>
  removeInflight(engagementId: string, proposedTxHash: string): Promise<void>
  appendDecision(statement: Statement): Promise<number> // returns seq
  setLastRefusal(engagementId: string, outcome: string, fingerprint: string): Promise<void>
  setMeta(key: string, value: string): Promise<void>
}
export interface StateStore {
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> // all-or-nothing
  loadAll(): Promise<StoreSnapshot>
  close(): Promise<void>
}
