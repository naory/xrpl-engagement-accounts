# Durable Co-signer State + Tick Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the policy co-signer restart-safe (state in a `StateStore`: in-memory or SQLite now, Postgres-ready), prove it with kill/restart tests, and run `tick()` on a schedule.

**Architecture:** A narrow async `StateStore` interface with one method per state change; `CosignerService` commits every change to the store before mutating its in-memory cache or returning, and rebuilds the cache from the store on boot. SQLite via Kysely + better-sqlite3 with portable SQL and Kysely migrations, verified by a shared contract test suite any future Postgres store must also pass. A scheduler loops `tick()` over open engagements.

**Tech Stack:** TypeScript (Node ≥ 22.12), vitest, Kysely, better-sqlite3, xrpl.js.

**Spec:** `docs/superpowers/specs/2026-11-19-durable-cosigner-design.md` (binding; read §2 and §2a).

## Global Constraints

- The service talks only to `StateStore`; no SQL outside the SQLite store module.
- Portable SQL only: column types `text`, `integer`, `bigint`; JSON as `text`; upserts via Kysely `onConflict`; no `INSERT OR REPLACE`, `AUTOINCREMENT` or `PRAGMA` in queries (connection setup may set pragmas); migrations via Kysely `Migrator`.
- Persist before anything leaves: store transaction commits first, then the in-memory state changes, then the call returns. On a store error the call throws, memory is unchanged, and no signed blob is returned.
- `decisions.seq` assigned in the insert transaction (max + 1).
- Default store when none configured: `MemoryStateStore` (today's behaviour). Server: `DATA_DIR` → `<DATA_DIR>/cosigner.db`; `COSIGNER_STORE=memory` opts out; `COSIGNER_TICK_MS` starts the scheduler; `COSIGNER_TICK_SUBMIT=1` submits completed blobs.
- Error codes (exact): `ENGAGEMENT_STALE`, `SIGNER_MISMATCH`, `STORE_LOCKED`.
- Use Node (not Python) for scripted edits. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch `feat/durable-cosigner`.
- After every task: `npm test`, `npm run typecheck`, `npm run lint-policies`, `npm run validate-templates`, `npm run vectors:check` clean.

## Review Focus

1. **A store write that fails mid-decision** → the call throws, no blob is returned, no in-flight/log/completed change remains in memory or store. Test in Task 3.
2. **Restart while a signed payment is in flight** → the restarted co-signer still counts it against the cap. Test in Task 4.
3. **Two processes opening the same `cosigner.db`** → the second fails `STORE_LOCKED`; after the first closes (or its lease goes stale) it opens. Test in Task 2.
4. **Policy library changed between runs** (a pinned layer missing or rehashed) → that engagement is quarantined (`ENGAGEMENT_STALE` on decide/tick/ingest); others work. Test in Task 3.
5. **Scheduler tick racing an HTTP decide on the same engagement** → serialized by the per-engagement lock; no double sign, one in-flight entry. Test in Task 5.

---

### Task 1: `StateStore` interface, `MemoryStateStore`, contract suite

**Files:** Create `packages/cosigner/src/store/types.ts`, `packages/cosigner/src/store/memory.ts`, `packages/cosigner/test/store-contract.ts` (exported suite), `packages/cosigner/test/store-memory.test.ts`; export from `packages/cosigner/src/index.ts`.

**Interfaces — Produces:**
```ts
export interface StoredEngagement {
  engagementId: string
  registered: { record: EngagementRecord; mandate: Statement | null } // immutable, as received
  record: EngagementRecord                                            // mutable (consumed)
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
  appendDecision(statement: Statement): Promise<number>          // returns seq
  setLastRefusal(engagementId: string, outcome: string, fingerprint: string): Promise<void>
  setMeta(key: string, value: string): Promise<void>
}
export interface StateStore {
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>     // all-or-nothing
  loadAll(): Promise<StoreSnapshot>
  close(): Promise<void>
}
```
`MemoryStateStore` implements it with staged copies so a throwing `fn` leaves nothing behind.

- [ ] **Step 1:** Write `runStoreContract(name, makeStore: () => Promise<StateStore>)` — tests: round-trip of every entity through `loadAll`; upsert semantics (same key twice → one row, last wins); `removeInflight`/`deletePresigned`/`deleteCompleted`; `appendDecision` seq strictly increasing and `loadAll().decisions` ordered by seq; **a transaction whose fn throws persists nothing** (atomicity); `setMeta` overwrite. Wire it in `store-memory.test.ts`. Run → FAIL (module missing).
- [ ] **Step 2:** Implement types + `MemoryStateStore`. Run → PASS. All checks. **Commit** `feat(cosigner): StateStore interface, in-memory store, contract suite`.

---

### Task 2: `SqliteStateStore` (Kysely + better-sqlite3)

**Files:** Create `packages/cosigner/src/store/sqlite.ts`, `packages/cosigner/src/store/migrations.ts`, `packages/cosigner/test/store-sqlite.test.ts`; add deps `kysely`, `better-sqlite3`, `@types/better-sqlite3` (pin exact versions in package.json).

**Interfaces — Produces:** `SqliteStateStore.open(o: { file: string; ownerId?: string; leaseMs?: number }): Promise<SqliteStateStore>`; tables `meta`, `engagements`, `attestations`, `presigned`, `completed`, `inflight`, `decisions(seq bigint primary key, …)`, `last_refusal`; migrations in `migrations.ts` run on open via Kysely `Migrator` with an in-code provider. Lease: meta keys `lease.owner`, `lease.heartbeat` (ms); open fails `STORE_LOCKED` if another owner's heartbeat is newer than `leaseMs` (default 15000); heartbeat renewed every `leaseMs/3`; `close()` clears the lease.

- [ ] **Step 1:** `store-sqlite.test.ts`: `runStoreContract('sqlite', …)` on a temp file; **Review Focus 3** — second `open` on the same file → rejects `/STORE_LOCKED/`; after `close()` → opens; with a stale heartbeat (backdate the meta row) → opens; reopen after close restores every entity written before (durability across instances). Run → FAIL.
- [ ] **Step 2:** Implement (portable SQL per Global Constraints; JSON columns `text`). Run → PASS. All checks. **Commit** `feat(cosigner): SQLite state store via Kysely (portable, Postgres-ready)`.

---

### Task 3: `CosignerService` write-through, restore, quarantine, signer check

**Files:** Modify `packages/cosigner/src/service.ts` (every mutation point: register ~178, ingest ~265, storePresigned ~523, tick ~564–587, decide ~669–671, resolveInflight ~701–711, log append ~722); Test `packages/cosigner/test/service-store.test.ts`.

**Interfaces:**
- Consumes: Task 1 `StateStore`, Task 2 `SqliteStateStore`.
- Produces: `CosignerOptions.store?: StateStore` (default `new MemoryStateStore()`); `static async CosignerService.open(o: CosignerOptions): Promise<CosignerService>` — loads the snapshot, checks meta `signer.address` (sets it on first open; mismatch → throws `SIGNER_MISMATCH`), rebuilds every engagement (layers by pinned hashes from `o.policies`, template by id + hash from `o.templates`; any missing/mismatched → engagement quarantined), imports `<dataDir>/decisions.jsonl` once when meta `jsonl.imported` is unset and the store is empty of decisions; `svc.close(): Promise<void>`. Quarantined engagements: `decide`/`tick`/`ingest`/`storePresigned` throw `ENGAGEMENT_STALE: <id>`. `tick(id, o?: { quiet?: boolean })` — quiet: a REFUSE whose fingerprint (outcome + sorted failing ids) equals the stored `lastRefusal` is returned but not logged.
- Ordering rule (Global Constraints): build every row change for an operation, commit one `store.transaction`, then apply to memory, then return. `decisions.jsonl` append stays as best-effort export after commit.

- [ ] **Step 1: Failing tests:** state written through each mutation point is in `store.loadAll()` (register incl. `registered` immutable + pins; ingest attestation+receipt; storePresigned; tick completed + inflight; decide inflight + decision; resolveInflight consumed + removal; presigned deletion on TICKET_CONSUMED); **Review Focus 1** — a store whose transaction rejects during `decide` SIGN → `decide` rejects, `inflightFor` empty, `decisions()` unchanged, store unchanged; **Review Focus 4** — reopen with a policy library missing a pinned layer → that engagement's `decide` rejects `/ENGAGEMENT_STALE/`, another engagement still decides; `SIGNER_MISMATCH` on reopen with a different signer; quiet tick logs a repeated identical refusal once. Run → FAIL.
- [ ] **Step 2:** Implement; keep every existing test green (callers using `new CosignerService(o)` still work with the in-memory default; `open()` is the restore path). All checks. **Commit** `feat(cosigner): write-through state store, restore on boot, quarantine and signer checks`.

---

### Task 4: Restart tests (T11)

**Files:** Test `packages/cosigner/test/restart.test.ts` (SQLite temp file; "kill" = `close()` the service + store and `CosignerService.open()` a fresh one on the same file; hotel@2 and B1 fixtures from `packages/policy/test/fixtures.ts`).

- [ ] **Step 1: Tests** (spec §3), each restarting at the named point:
  - mid-dispute: bonded settlement dispute receipted + chargeback blob stored → restart → before the deadline `tick` refuses with the same rule ids as before the restart; after it, `default.chargebackClaim` SIGNs with the same payouts.
  - mid-ruling window: arbiter ruling receipted → restart → every default still refuses; a post-deadline ruling → `LATE`.
  - **Review Focus 2** — in-flight spends: B1 payment SIGNed (not yet validated) → restart → a second payment that only fits the daily cap without the first → REFUSE (W3); once the ledger shows the first validated, its in-flight entry resolves.
  - receipts/idempotency: re-ingest a receipted statement → same receipt; `ALREADY_DISPUTED` still holds.
  - decision log order identical before/after restart.
- [ ] **Step 2:** Run → PASS (fix any gaps in Task 3's restore found here, in this task's commit). All checks. **Commit** `test(cosigner): kill/restart tests — no lost receipts, defaults or caps`.

---

### Task 5: Tick scheduler (T12) + server wiring

**Files:** Create `packages/cosigner/src/scheduler.ts`; Modify `packages/cosigner/src/server.ts` (entrypoint), `.env.example`; Test `packages/cosigner/test/scheduler.test.ts`.

**Interfaces — Produces:** `startTickScheduler(svc: CosignerService, o: { intervalMs: number; onResult?: (engagementId: string, r: TickResult) => Promise<void> | void; now?: () => number }): { stop(): Promise<void> }` — each round ticks every open engagement in quiet mode, sequentially; a tick returning `[]` because the account is gone marks it closed (`svc` exposes `openEngagementIds()` and closes via the store); errors on one engagement are logged and don't stop the round; `stop()` waits for the current round. Server entrypoint: `DATA_DIR` → `SqliteStateStore.open({ file: <DATA_DIR>/cosigner.db })` unless `COSIGNER_STORE=memory`; `CosignerService.open`; `COSIGNER_TICK_MS` → scheduler; `COSIGNER_TICK_SUBMIT=1` → `onResult` submits `r.blob` via the server's XRPL client (`submit` from xrpl-io), else logs it; graceful shutdown stops the scheduler and closes the service.

- [ ] **Step 1: Failing tests** (vitest fake timers, MemoryStateStore): a due default is SIGNed and passed to `onResult` within one interval; a not-due one isn't logged twice across rounds (quiet); a deleted-account engagement is marked closed and skipped next round; **Review Focus 5** — a scheduler round and a concurrent `svc.decide` on the same engagement → one in-flight entry, no double sign; `stop()` resolves after the in-flight round. Run → FAIL.
- [ ] **Step 2:** Implement + server wiring; `.env.example` documents `COSIGNER_STORE`, `COSIGNER_TICK_MS`, `COSIGNER_TICK_SUBMIT`. All checks. **Commit** `feat(cosigner): tick scheduler and durable store in the server`.

---

### Task 6: Docs

**Files:** Modify `README.md` (co-signer section + remove the "in-memory state" limitation), `ROADMAP.md` (T10–T12 done), `docs/superpowers/specs/2026-11-12-hotel-stay-escrow-design.md` / `docs/use-cases/hotel-booking.md` known-limitation notes, `packages/cosigner` docs if present; add a short "Upgrading the store to Postgres" note (implement `StateStore` with Kysely `PostgresDialect`, reuse migrations, pass `runStoreContract`).

- [ ] **Step 1:** Write. **Step 2:** `npm test` + the CI docs drift checks green. **Commit** `docs: durable co-signer state and tick scheduler`.
