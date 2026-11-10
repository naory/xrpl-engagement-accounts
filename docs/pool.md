# Pre-created account pool

A cache of pre-aged engagement accounts so a deal never waits on account creation or the
~256-ledger `AccountDelete` window. One `PoolManager` + lifecycle, **two funding modes**:

- **Self-funded (default).** The operating account funds each account's reserve in XRP with
  ordinary transactions; the reserve returns to it on `AccountDelete`. Runs on **any** network —
  including **XRPL Testnet today**, which has RLUSD but not the Sponsor amendment. Builders in `precreate.ts`.
- **XLS-68 sponsored** (`ENG_POOL_SPONSORED=1`). The operating (**sponsor**) account carries every
  XRP cost via **Sponsored Fees and Reserves**: a pooled account holds **zero XRP** of its own, and
  its reserves return to the sponsor on close. The **production** target; needs the `Sponsor`
  amendment enabled on the network (not on Testnet as of this writing). Builders in `xls68.ts`.

Code: `packages/cosigner/src/precreate.ts` (self-funded builders), `xls68.ts` (sponsored builders +
`sponsorCosign`), `pool.ts` (`PoolManager` + interfaces), `pool-local.ts` (local stores + keys),
`xrpl-pool-ledger.ts` (live ledger), `pool-cli.ts`.

## Lifecycle

```
minting → configuring → aging → ready → leased → closing → closed
```

- **Pre-create.** Create the account (self-funded: a plain `Payment` of `ENG_CREATE_DROPS`;
  sponsored: a `Payment` with `tfSponsorCreatedAccount`, reserve check waived, `AccountRoot.Sponsor`
  = sponsor). Then configure it with **master-signed** standalone txs (spike finding **F1**: these
  can't be Batch inners) in order: `TrustSet` RLUSD → `SetRegularKey` (service) →
  `AccountSet asfDisableMaster` **(last)**. Order matters: the master opens the trust line and
  installs the service key *before* disabling itself. In sponsored mode each config tx also carries
  `Sponsor` + `SponsorFlags` (`spfSponsorFee` / `spfSponsorReserve`) and is co-signed by the sponsor
  with `xrpl.signAsSponsor`.
- **Aging.** `ready` once `currentLedger − accountSequence ≥ 256`.
- **Lease.** A `ready` account is handed to a deal to open.
- **Reclaim.** `TrustSet` (remove line) + `AccountDelete`, **signed by the service `RegularKey`**
  (the master is disabled). `Destination` = the operating/sponsor account, which recovers the reserve.

Verified offline against `xrpl@5.3.0` / `ripple-binary-codec@2.11.0` (`npm test` →
`packages/cosigner/test/xls68.test.ts`, `pool.test.ts` — the latter asserts both modes, the config
order, master-signed config, and service-signed reclaim).

## Running

> **Self-funded mode (default)** runs anywhere — e.g. XRPL Testnet. Both `ENG_SPONSOR_SEED` and
> `ENG_SERVICE_SEED` must be **real, funded** account seeds (fund from <https://faucet.altnet.rippletest.net>).
>
> **Sponsored mode** (`ENG_POOL_SPONSORED=1`) additionally requires the **`Sponsor` amendment** to be
> **enabled on the target network**. It is in rippled `develop` / `DefaultNo` and is **not** on
> Testnet, so `topup` there fails with `temDISABLED` — use self-funded on Testnet.
>
> Run on a machine with network access to the node (your Mac), not from CI/sandbox.

Configuration goes in a repo-root **`.env`** (copy `.env.example`, fill in, `git`-ignored — never
commit seeds). Both `npm run pool:*` and `npm run web` load it automatically, so no inline env is
needed (an inline `VAR=x npm run …` still overrides). The variables:

| var | meaning | default |
|---|---|---|
| `ENG_XRPL_WSS` | wss endpoint | `wss://s.altnet.rippletest.net:51233` |
| `ENG_SPONSOR_SEED` | operating account seed — funds reserves, receives every reclaim (**required**) | — |
| `ENG_SERVICE_SEED` | service account seed — installed as each account's `RegularKey`, signs reclaim (**required**) | — |
| `ENG_POOL_SPONSORED` | `1`/`true` → XLS-68 sponsored; else self-funded | _(self-funded)_ |
| `ENG_RLUSD_ISSUER` | RLUSD issuer address | `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` (Testnet RLUSD) |
| `ENG_RLUSD_CURRENCY` | currency code | `RLUSD` |
| `ENG_RLUSD_LIMIT` | trust line limit | `1000000000` |
| `ENG_CREATE_DROPS` | XRP drops funded at create (self-funded: base + object reserves + fees; reclaimed at close) | `3000000` |
| `ENG_POOL_TARGET` | desired warm pool size | `5` |
| `ENG_POOL_DIR` | pool store directory | `.pool` |

```
# self-funded on Testnet (default): fund the two seeds from the faucet first
npm run pool:topup   -- --count 5
npm run pool:status
npm run pool:reclaim -- --all          # or: --address rXXXX
```

## Secrets

Account seeds live in the **gitignored** `.pool/` store (`LocalFileSeedStore`, mode `0600`); a
seed-free `.pool/state.status.json` is safe to read. The sponsor seed comes from `ENG_SPONSOR_SEED`.
**Never commit either.**

> **Production hardening TODO:** replace `LocalFileSeedStore` with a `KmsSeedStore` backed by the
> cloud KMS / secrets manager (envelope-encrypted, access-controlled, audited). The `SeedStore`
> interface is the single swap point — no `PoolManager` logic changes.

## Production: durable workflow (Temporal)

`PoolManager` is pure orchestration over injected interfaces (`PoolLedger`, `Keys`, `SeedStore`,
`PoolStateStore`), each mapping 1:1 onto a Temporal **activity**. It uses no network, clock, or
randomness directly, so migration is: lift each method into a workflow and expose the interfaces as
activities. State is persisted after every transition and the seed is saved *before* funding, so a
crashed/retried run resumes without orphaning funds.

## Key decisions (Testnet demo)

Two constraints shaped the Testnet demo path:

1. **Testnet has no XLS-68 → self-funded mode.** A sponsored topup on Testnet fails with
   `temDISABLED` (the `Sponsor` amendment isn't enabled there). So the live demo uses **self-funded**
   mode; sponsored stays the production design for a `Sponsor`-enabled network.
2. **A pre-created pool needs a *fixed* issuer → a self-controlled mock RLUSD issuer.** Trust lines
   are set at pre-create, so the issuer must be known in advance (the self-contained demo's per-run
   faucet issuer can't be pre-trusted). Ripple's **real** Testnet RLUSD (`rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`)
   is external — we can't self-mint it, and its faucet (<https://tryrlusd.com/>) needs GitHub auth and
   caps at **10 RLUSD / 24h**, too little for iterative runs. So the demo uses a **fixed demo RLUSD
   issuer we control** (`ENG_DEMO_ISSUER_SEED`): same `RLUSD` currency code, minted with no cap, the
   one issuer the pool trust-lines to. Clearly demo-ware, separate from any real account.

## Pooled live demo (implemented, `ENG_USE_POOL=1`)

Wired into `packages/web` behind `ENG_USE_POOL` (default off, so the self-contained demo is
untouched). Procurement provisioning (`DemoOrchestrator.provisionProcurementPooled`):

- **Lease, don't create.** `PoolManager.lease(engagementId)` hands over a pre-aged account that
  already has its RLUSD trust line (to the fixed demo issuer), the pool service as `RegularKey`, and
  a disabled master — so open is instant and close needs no ~256-ledger wait.
- **Mint the budget.** The fixed demo issuer (`ENG_DEMO_ISSUER_SEED`) sets `DefaultRipple`
  (idempotent) and mints RLUSD to a per-run faucet treasury, which funds the deal — no faucet cap.
- **Open.** `buildOpenBatch` funds RLUSD + installs the SignerList; the outer Batch's account is the
  leased account, **signed by the pool service `RegularKey`**, with the treasury batch-signing its
  funding inner tx.
- **Close = real reclaim.** `POST /api/reclaim` → `DemoOrchestrator.reclaim()`. The open Batch's
  final inner is a keyless `SetRegularKey` that **removes** the account's RegularKey, so an *opened*
  engagement is controlled only by its SignerList — not the pool service key. Teardown is therefore
  signed by the **owner (weight 2 = quorum 2)**: sweep any leftover RLUSD back to the treasury,
  remove the trust line, `AccountDelete` to the operating account — each a separate owner-multisigned
  tx — then `PoolManager.markClosed` (bookkeeping only). Instant, because the account aged in the
  pool first. `PoolManager.reclaim` (service-signed) stays for *un-opened* pool accounts (the CLI).
  The UI's **Close & reclaim** shows the real tx hashes; with `ENG_USE_POOL` unset it keeps the
  simulated batch teardown.

**Env for the pooled demo** — put these in the repo-root `.env` (see `.env.example`):

- `ENG_USE_POOL=1` — turn on the pooled path (default off).
- `ENG_SPONSOR_SEED` — the operating account: funds each pooled account's XRP reserve, receives every reclaim.
- `ENG_SERVICE_SEED` — the pool service key: each pooled account's `RegularKey`; signs pre-create + pool-only reclaim.
- `ENG_DEMO_ISSUER_SEED` — the fixed demo RLUSD issuer the orchestrator mints from.
- `ENG_RLUSD_ISSUER` — that issuer's **address**; must match what the pool was topped up against so the leased trust lines line up.

```
# one-time: cp .env.example .env  and fill in the five values above
npm run pool:topup -- --count 2     # warm the pool (reads .env); let them age to ready
npm run web                         # reads .env → http://127.0.0.1:8080/demo → Procurement
```

The server prints `pool: ON` / `pool: off` at startup so you can see which mode you're in.

## Status

- Full self-funded lifecycle **validated live on Testnet**, both via the CLI (create → configure →
  age → `ready` → reclaim) and via the web demo (lease → open → pay → **owner-multisigned close**:
  sweep + remove trust line + `AccountDelete`, reserves returned to the operating account).
- Deferred: the XLS-68 sponsored path needs a `Sponsor`-enabled network to run live; `KmsSeedStore`;
  porting `PoolManager` to Temporal.
