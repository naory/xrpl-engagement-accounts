import { randomUUID } from 'node:crypto'
import path from 'node:path'
import Database from 'better-sqlite3'
import { Kysely, SqliteDialect, type Transaction } from 'kysely'
import { Migrator } from 'kysely/migration'
import type { Statement } from '@eng/core'
import type { InflightRecord, TickResult } from '../service.ts'
import { migrationProvider } from './migrations.ts'
import type { StateStore, StoreSnapshot, StoreTx, StoredAttestation, StoredEngagement } from './types.ts'

// Row shapes. Column types stay within text / integer / bigint so the same queries run on Postgres.
interface Tables {
  meta: { key: string; value: string }
  engagements: { engagement_id: string; registered_record: string; registered_mandate: string | null; record: string; pins: string; closed: number }
  attestations: { engagement_id: string; statement_id: string; statement: string; receipt: string; ord: number }
  presigned: { engagement_id: string; outcome: string; blob: string; ord: number }
  completed: { engagement_id: string; tx_hash: string; result: string; ord: number }
  inflight: { engagement_id: string; proposed_tx_hash: string; record: string; ord: number }
  decisions: { seq: number; statement: string }
  last_refusal: { engagement_id: string; outcome: string; fingerprint: string }
}
type Q = Kysely<Tables> | Transaction<Tables>

const LEASE_OWNER = 'lease.owner'
const LEASE_HEARTBEAT = 'lease.heartbeat'
const isLeaseKey = (k: string): boolean => k === LEASE_OWNER || k === LEASE_HEARTBEAT

export interface SqliteStoreOptions { file: string; leaseMs?: number }

/**
 * In-process opens of one file run one at a time. better-sqlite3 waits for a busy lock synchronously, which blocks the
 * event loop, so two same-process opens migrating at once would stall until busy_timeout. Other processes are
 * unaffected (they have their own event loop) and are still arbitrated by the lease.
 */
const opening = new Map<string, Promise<unknown>>()

/** Durable StateStore on SQLite (Kysely + better-sqlite3), guarded by a single-owner heartbeat lease. */
export class SqliteStateStore implements StateStore {
  private queue: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | undefined
  private closed = false
  private lost = false

  private constructor(private readonly db: Kysely<Tables>, private readonly token: string) {}

  static open(o: SqliteStoreOptions): Promise<SqliteStateStore> {
    const file = path.resolve(o.file)
    const prev = opening.get(file) ?? Promise.resolve()
    const run = prev.then(() => SqliteStateStore.openNow(o), () => SqliteStateStore.openNow(o))
    const settled = run.catch(() => undefined)
    opening.set(file, settled)
    void settled.then(() => { if (opening.get(file) === settled) opening.delete(file) })
    return run
  }

  private static async openNow(o: SqliteStoreOptions): Promise<SqliteStateStore> {
    const token = randomUUID() // per-instance lease token: two opens never share ownership
    const leaseMs = o.leaseMs ?? 15000
    const sqlite = new Database(o.file, { timeout: 5000 }) // busy_timeout
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('synchronous = FULL')
    const db = new Kysely<Tables>({ dialect: new SqliteDialect({ database: sqlite }) })
    try {
      await migrate(db)
      await claimLease(db, token, leaseMs, o.file)
    } catch (e) {
      await db.destroy()
      throw e
    }
    const store = new SqliteStateStore(db, token)
    store.timer = setInterval(() => { void store.renewNow() }, Math.max(1, Math.floor(leaseMs / 3)))
    store.timer.unref()
    return store
  }

  /** Extend the lease if we still hold it; otherwise mark the store lease-lost (all later transactions reject). */
  async renewNow(): Promise<void> {
    if (this.closed || this.lost) return
    try {
      const r = await this.db.updateTable('meta').set({ value: String(Date.now()) })
        .where('key', '=', LEASE_HEARTBEAT)
        .where(({ exists, selectFrom }) => exists(selectFrom('meta').select('key').where('key', '=', LEASE_OWNER).where('value', '=', this.token)))
        .executeTakeFirst()
      if (Number(r.numUpdatedRows) === 0) this.lost = true
    } catch {
      this.lost = true
    }
  }

  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.lost) throw new Error('STORE_LOCKED: lease lost to another owner')
      const live = { open: true }
      try {
        return await this.db.transaction().execute(async (trx) => fn(guard(txFor(trx), live)))
      } finally {
        live.open = false
      }
    }
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => undefined)
    return result
  }

  async loadAll(): Promise<StoreSnapshot> {
    await this.queue
    return this.db.transaction().execute(async (t) => {
      const meta = await t.selectFrom('meta').selectAll().orderBy('key').execute()
      const eng = await t.selectFrom('engagements').selectAll().orderBy('engagement_id').execute()
      // insertion order (ord), then key order for rows that predate the ord column
      const att = await t.selectFrom('attestations').selectAll().orderBy('ord').orderBy('engagement_id').orderBy('statement_id').execute()
      const pre = await t.selectFrom('presigned').selectAll().orderBy('ord').orderBy('engagement_id').orderBy('outcome').execute()
      const com = await t.selectFrom('completed').selectAll().orderBy('ord').orderBy('engagement_id').orderBy('tx_hash').execute()
      const inf = await t.selectFrom('inflight').selectAll().orderBy('ord').orderBy('engagement_id').orderBy('proposed_tx_hash').execute()
      const dec = await t.selectFrom('decisions').selectAll().orderBy('seq').execute()
      const ref = await t.selectFrom('last_refusal').selectAll().orderBy('engagement_id').orderBy('outcome').execute()
      return {
        // lease rows are internal: filtered out of the snapshot
        meta: Object.fromEntries(meta.filter((r) => !isLeaseKey(r.key)).map((r) => [r.key, r.value])),
        engagements: eng.map((r): StoredEngagement => ({
          engagementId: r.engagement_id,
          registered: { record: JSON.parse(r.registered_record), mandate: r.registered_mandate === null ? null : JSON.parse(r.registered_mandate) },
          record: JSON.parse(r.record),
          pins: JSON.parse(r.pins),
          closed: r.closed === 1,
        })),
        attestations: att.map((r): StoredAttestation => ({ engagementId: r.engagement_id, statement: JSON.parse(r.statement), receipt: JSON.parse(r.receipt) })),
        presigned: pre.map((r) => ({ engagementId: r.engagement_id, outcome: r.outcome, blob: r.blob })),
        completed: com.map((r) => ({ engagementId: r.engagement_id, txHash: r.tx_hash, result: JSON.parse(r.result) as TickResult })),
        inflight: inf.map((r) => JSON.parse(r.record) as InflightRecord),
        decisions: dec.map((r) => ({ seq: Number(r.seq), statement: JSON.parse(r.statement) as Statement })),
        lastRefusal: ref.map((r) => ({ engagementId: r.engagement_id, outcome: r.outcome, fingerprint: r.fingerprint })),
      }
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    await this.queue
    try {
      // Release the lease only if we still hold it.
      const owner = await this.db.selectFrom('meta').select('value').where('key', '=', LEASE_OWNER).executeTakeFirst()
      if (owner?.value === this.token && !this.lost) await this.db.deleteFrom('meta').where('key', 'in', [LEASE_OWNER, LEASE_HEARTBEAT]).execute()
    } finally {
      await this.db.destroy()
    }
  }
}

/** Run migrations; a concurrent opener may have applied them first, so retry (a re-run sees them applied). */
async function migrate(db: Kysely<Tables>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const { error } = await new Migrator({ db, provider: migrationProvider }).migrateToLatest()
    if (!error) return
    if (attempt >= 3) throw error
  }
}

/** Atomic claim: one conditional upsert on the heartbeat row succeeds only if no row exists or it is stale. */
async function claimLease(db: Kysely<Tables>, token: string, leaseMs: number, file: string): Promise<void> {
  const locked = (): Error => new Error(`STORE_LOCKED: ${file} is held by another owner`)
  const now = Date.now()
  try {
    await db.transaction().execute(async (trx) => {
      const r = await trx.insertInto('meta').values({ key: LEASE_HEARTBEAT, value: String(now) })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value: String(now) })
          .where((eb) => eb(eb.cast<number>(eb.ref('meta.value'), 'bigint'), '<', now - leaseMs)))
        .executeTakeFirst()
      if (Number(r.numInsertedOrUpdatedRows ?? 0) === 0) throw locked()
      await upsertMeta(trx, LEASE_OWNER, token)
    })
  } catch (e) {
    if (e instanceof Error && /SQLITE_BUSY|database is locked/i.test(`${(e as { code?: string }).code ?? ''} ${e.message}`)) throw locked()
    throw e
  }
}

const upsertMeta = (q: Q, key: string, value: string): Promise<unknown> =>
  q.insertInto('meta').values({ key, value }).onConflict((oc) => oc.column('key').doUpdateSet({ value })).execute()

/** Reject any use of a tx after its transaction has settled. */
function guard(tx: StoreTx, live: { open: boolean }): StoreTx {
  const out = {} as Record<string, unknown>
  for (const [name, f] of Object.entries(tx)) {
    out[name] = (...args: unknown[]) => {
      if (!live.open) return Promise.reject(new Error('transaction closed'))
      return (f as (...a: unknown[]) => Promise<unknown>)(...args)
    }
  }
  return out as unknown as StoreTx
}

function txFor(t: Transaction<Tables>): StoreTx {
  const json = JSON.stringify
  const requireRow = (n: number | bigint, id: string): void => { if (Number(n) === 0) throw new Error(`unknown engagement ${id}`) }
  /** Next insertion position in an ordered table (max + 1, inside this transaction). An upsert does not change it. */
  const nextOrd = async (table: 'attestations' | 'presigned' | 'completed' | 'inflight'): Promise<number> => {
    const m = await t.selectFrom(table).select((eb) => eb.fn.max('ord').as('m')).executeTakeFirst()
    return Number(m?.m ?? 0) + 1
  }
  return {
    putEngagement: async (e) => {
      const row = {
        registered_record: json(e.registered.record),
        registered_mandate: e.registered.mandate === null ? null : json(e.registered.mandate),
        record: json(e.record), pins: json(e.pins), closed: e.closed ? 1 : 0,
      }
      await t.insertInto('engagements').values({ engagement_id: e.engagementId, ...row })
        .onConflict((oc) => oc.column('engagement_id').doUpdateSet(row)).execute()
    },
    setConsumed: async (id, consumed) => {
      const cur = await t.selectFrom('engagements').select('record').where('engagement_id', '=', id).executeTakeFirst()
      if (!cur) throw new Error(`unknown engagement ${id}`)
      const record = { ...JSON.parse(cur.record), consumed }
      const r = await t.updateTable('engagements').set({ record: json(record) }).where('engagement_id', '=', id).executeTakeFirst()
      requireRow(r.numUpdatedRows, id)
    },
    setClosed: async (id) => {
      const r = await t.updateTable('engagements').set({ closed: 1 }).where('engagement_id', '=', id).executeTakeFirst()
      requireRow(r.numUpdatedRows, id)
    },
    putAttestation: async (a) => {
      const row = { statement: json(a.statement), receipt: json(a.receipt) }
      await t.insertInto('attestations').values({ engagement_id: a.engagementId, statement_id: a.statement.id, ...row, ord: await nextOrd('attestations') })
        .onConflict((oc) => oc.columns(['engagement_id', 'statement_id']).doUpdateSet(row)).execute()
    },
    putPresigned: async (engagementId, outcome, blob) => {
      await t.insertInto('presigned').values({ engagement_id: engagementId, outcome, blob, ord: await nextOrd('presigned') })
        .onConflict((oc) => oc.columns(['engagement_id', 'outcome']).doUpdateSet({ blob })).execute()
    },
    deletePresigned: async (engagementId, outcome) => {
      await t.deleteFrom('presigned').where('engagement_id', '=', engagementId).where('outcome', '=', outcome).execute()
    },
    putCompleted: async (engagementId, txHash, result) => {
      await t.insertInto('completed').values({ engagement_id: engagementId, tx_hash: txHash, result: json(result), ord: await nextOrd('completed') })
        .onConflict((oc) => oc.columns(['engagement_id', 'tx_hash']).doUpdateSet({ result: json(result) })).execute()
    },
    deleteCompleted: async (engagementId, txHash) => {
      await t.deleteFrom('completed').where('engagement_id', '=', engagementId).where('tx_hash', '=', txHash).execute()
    },
    addInflight: async (r) => {
      await t.insertInto('inflight').values({ engagement_id: r.engagementId, proposed_tx_hash: r.proposedTxHash, record: json(r), ord: await nextOrd('inflight') })
        .onConflict((oc) => oc.columns(['engagement_id', 'proposed_tx_hash']).doUpdateSet({ record: json(r) })).execute()
    },
    removeInflight: async (engagementId, proposedTxHash) => {
      await t.deleteFrom('inflight').where('engagement_id', '=', engagementId).where('proposed_tx_hash', '=', proposedTxHash).execute()
    },
    appendDecision: async (statement) => {
      const m = await t.selectFrom('decisions').select((eb) => eb.fn.max('seq').as('m')).executeTakeFirst()
      const seq = Number(m?.m ?? 0) + 1
      await t.insertInto('decisions').values({ seq, statement: json(statement) }).execute()
      return seq
    },
    setLastRefusal: async (engagementId, outcome, fingerprint) => {
      await t.insertInto('last_refusal').values({ engagement_id: engagementId, outcome, fingerprint })
        .onConflict((oc) => oc.columns(['engagement_id', 'outcome']).doUpdateSet({ fingerprint })).execute()
    },
    deleteLastRefusal: async (engagementId, outcome) => {
      await t.deleteFrom('last_refusal').where('engagement_id', '=', engagementId).where('outcome', '=', outcome).execute()
    },
    setMeta: async (k, v) => { await upsertMeta(t, k, v) },
  }
}
