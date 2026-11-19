# Durable co-signer state + tick scheduler (design)

Status: design, 2026-11-19. Implements plan items **T10** (state store), **T11** (restart tests) and **T12** (tick
scheduler) of the 5/10 → 10/10 plan (M1 "Durable co-signer"). T13, T14 and T17 follow separately.

## 1. Intent

The co-signer keeps everything that decides when money moves **in memory**
(`packages/cosigner/src/service.ts:115–117` and each `EngagementState`): registrations, receipted statements and
their receipts, pre-signed default blobs, completed tick results, in-flight decisions, consumed single-use
statements, and the decision log. A restart drops all of it, so a restarted co-signer could complete a default over
a claim it had receipted, or forget an in-flight payment and let spends exceed a cap. And nothing calls `tick()` on
a schedule: defaults complete only when someone calls `POST /v1/engagements/:id/tick`.

Goal: make the co-signer **restart-safe**, prove it with kill/restart tests, and **schedule** ticks — with a storage
layer that runs on **SQLite now and upgrades to Postgres later** with no change to the service (user's
constraint).

**Anti-goals:** a restart that silently changes an outcome (a lost receipt, a forgotten pre-signed blob, a reset
cap); a storage layer that bakes in SQLite-only behaviour; a scheduler that double-signs or races `decide()`.

## 2. Decisions

1. **`StateStore` interface** (async, in `@eng/cosigner`): the only way the service persists or loads state. Methods
   mirror the service's state changes — `putEngagement`, `updateConsumed`, `putAttestation`, `putPresigned`,
   `deletePresigned`, `putCompleted`, `deleteCompleted`, `addInflight`, `removeInflight`, `appendDecision` — plus
   `loadAll()` for boot and `close()`. (Exact signatures are the builder's; one method per mutation point.)
2. **Implementations:**
   - `MemoryStateStore` — default when no store is configured; keeps unit tests fast and today's behaviour.
   - `SqliteStateStore` — **Kysely** query builder + **better-sqlite3** driver (Kysely's `SqliteDialect`). Chosen
     over `node:sqlite`, which is still experimental and prints warnings on Node 22–24.
   - **Postgres later:** a `PostgresStateStore` = Kysely `PostgresDialect` + `pg` with the **same queries and
     migrations**. To keep that true: portable column types only (`text`, `integer`, `bigint`), JSON stored as
     `text`, no SQLite-only SQL (`INSERT OR REPLACE`, `AUTOINCREMENT`, `PRAGMA` in queries) — upserts via Kysely's
     `onConflict`. Migrations through Kysely's `Migrator`.
   - A **shared contract test suite** runs against every store, so a Postgres store is "done" when it passes.
3. **Write-through, transactional.** Every service mutation happens inside the existing per-engagement lock and is
   persisted (awaited) **before** the call returns; a multi-row change (e.g. a decision that pushes an in-flight
   entry and appends to the log) is one store transaction. The in-memory maps stay as the working cache.
4. **Boot = rebuild from the store.** `CosignerService.restore()` (or a static `open()`) loads every engagement and
   rebuilds `EngagementState` — layers and template from the persisted `policyLayers` / template id, **without**
   re-running the ledger neutrality check (it passed at registration and is recorded) — plus attestations,
   presigned blobs, completed results, in-flight entries and the decision log.
5. **Decision log** moves into the store (`decisions` table). The `decisions.jsonl` file stays as an optional
   export for compatibility, not the source of truth.
6. **Tick scheduler (T12):** `startTickScheduler(svc, { intervalMs, onResult? })` loops over open engagements and
   calls `svc.tick(id)` (which is already lock-serialised and idempotent for in-flight results); `onResult` lets the
   caller submit completed blobs. The server starts it when `COSIGNER_TICK_MS` is set; stopping is clean. An
   engagement whose account is gone is dropped from the loop.
7. **Server wiring:** `DATA_DIR` (already used) → SQLite file `cosigner.db` there by default; `COSIGNER_STORE=memory`
   keeps the old behaviour.

## 2a. Settled details (my calls, from the builder check)

1. **Pinned layers and template.** Registration persists the resolved layer hashes (baseline included) and the
   template's hash. On boot, an engagement whose pinned layers or template are no longer in the library, or hash
   differently, loads **quarantined**: every decide/tick/ingest for it fails closed with `ENGAGEMENT_STALE`; boot
   itself proceeds and logs it.
2. **Persist before anything leaves.** For every mutation the store transaction commits **first**, then the
   in-memory state changes, then the call returns (a signed blob included). If the write fails, the blob is withheld
   and memory is untouched. A decision's log row, its in-flight entry and a tick's `completed` result are one
   transaction.
3. **Everything that mutates is persisted:** `record.consumed` updates and in-flight removals in `resolveInflight`,
   refusal records, presigned deletions (TICKET_CONSUMED), completed set/delete — plus the immutable `registered`
   (record + mandate exactly as received, for the re-registration equality check), stored separately from the
   mutable record.
4. **Scheduler semantics.** "Open" = registered, not quarantined, not marked closed; a tick that finds the account
   gone marks the engagement closed in the store and drops it. Scheduler ticks run in a **quiet** mode: a REFUSE is
   logged only when its result (outcome + failing rules) differs from the last logged one for that outcome, so the
   log doesn't grow every interval. Completed blobs stay retrievable (persisted `completed`, returned by the tick
   endpoint) until their in-flight entry resolves; the server's scheduler **submits** them through its XRPL client
   when `COSIGNER_TICK_SUBMIT=1`, otherwise logs them.
5. **Existing `decisions.jsonl`:** the first boot of a new SQLite store imports it once (recorded in a meta row);
   afterwards the jsonl is a best-effort export (a failed append is logged, never fatal).
6. **Single writer.** The store holds a **lease** (meta row: owner id, heartbeat). Opening fails if another live
   owner holds it; the lease is renewed on an interval and released on `close()`. Portable to Postgres (advisory
   lock or the same row).
7. **Decision order:** the `decisions` table has a `seq` assigned inside the insert transaction (max + 1) — no
   AUTOINCREMENT — so order is identical on Postgres.
8. **Signer identity:** a meta row records the co-signer's address; boot refuses (`SIGNER_MISMATCH`) if the
   configured signer differs.

## 3. Restart guarantees to prove (T11)

Kill the service (drop the instance), open a new one on the same SQLite file, and check — each as a test:
- **Mid-dispute:** a receipted bonded dispute and a stored chargeback blob survive; after the deadline the restarted
  co-signer completes the same chargeback; before it, refuses with the same rule.
- **Mid-ruling window:** a receipted arbiter ruling survives and still blocks every default; a late ruling is still
  LATE.
- **In-flight spends:** a SIGNed payment not yet validated survives as in-flight, so a second spend after restart
  still counts it against the cap (the B1 daily-cap case).
- **Receipts/idempotency:** re-ingesting a receipted statement returns the original receipt; `ALREADY_*` rules hold.
- **Decision log** survives and stays in order.

## 4. Non-goals

The Postgres store itself (only the path to it); multi-instance co-signers / leader election; T13 trust config,
T14 trust-model page, T17 one-command local co-signer (next).

## 5. Left to the builder

Exact `StateStore` signatures and table layout; Kysely version pin; whether the scheduler lives in `service.ts` or
its own file; how `onResult` submission is wired in the server (log-only is acceptable for now).
