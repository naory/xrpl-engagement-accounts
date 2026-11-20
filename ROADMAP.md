# Roadmap

Forward plan for **xrpl-engagement-accounts**. What's built and verified lives in the
[README §12 "Built and verified"](README.md#12-roadmap) (B1 live on Testnet 11/11, x402 purchase
4/4, hotel stay escrow 17/17, ledger mechanics 21/21, co-signer, policies, vectors, the published
settlement adapter).
This file tracks what's next, highest-leverage first.

## Next

1. **Scenario-1 validation.** 5–10 conversations with XRPL institutions / agent-platform builders
   on the bounded-agent-wallet, and one marketplace on bonds.
2. **Security test matrix.** Turn the README threat-model rows into explicit negative
   vectors/tests (building on D8/D10-style cases), ahead of an external review.
3. **Adapter: `verifyExactPayload` unfunded-signer + `lsfDisableMaster` tests.** Align the reference
   verifier with `rippled`'s `checkMultiSign` (signer accounts need not exist — the key derives to
   the signer address; a signer's own master key is refused under `lsfDisableMaster` even if its
   `RegularKey` equals its address), from the t54 review. Feeds the upstream amendment's conformance
   set.

Demo and agent tooling:

- **`review_deal` MCP tool** — expose the pre-booking check (`dealTerms` + `checkNorms`) to any
  agent through `packages/agent-mcp`.
- **Honest simulated mode everywhere.** The Hotel stay scenario replays real co-signer decisions;
  procurement, x402 and MPP still use hand-written simulated decisions, and the bonded-marketplace
  scenario has no policy behind it.
- **Privy authorization key, live.** Verify the generated `privy-authorization-signature` against a
  Privy app that enforces it (mock-tested only so far).

Product build-out already queued:

- **Arbiter service** (AI + human queue) and evidence API.
- **Indexer** — settlements → reputation records (reviews, rulings, bonds).
- **x402 `engagement` scheme + facilitator** — verify `Signers` against the SignerList at a pinned
  ledger.
- **Collateral bonds** — bond template + slashing by arbiter + harmed party; bond size as a trust
  signal.
- **Co-signer npm package.** `@eng/cosigner` stays private. Packing it waits until
  `packages/cosigner/src/hotel/flow.ts` imports `templates/hotel@2.json` from inside the package.
  `@eng/core`, `@eng/policy`, `@eng/ledger`, `@eng/provisioning`, and `@eng/agent-mcp` build to `dist`.
- **Packaging follow-ups.** (1) Rename the `source` export condition to a project-specific name such as `@eng/source`. A consumer running Node with `--conditions=source` would load this repo's unshipped `src`. (2) `@eng/agent-mcp`'s `.d.ts` references `NodeJS.ProcessEnv`, so a consumer needs `@types/node` or `skipLibCheck`. (3) `@eng/ledger` depends on `@eng/policy` only for a type.

## Trust-model follow-ups

Described in [docs/trust-model.md](docs/trust-model.md). Not implemented.

### Re-check arbiter neutrality at decide time

`neutralityFindings` runs inside `register`. A later `decide` does not read the arbiter credential again. Re-check arbiter neutrality at decide time, and treat a missing, unaccepted, or expired credential as a revocation then, not only at register.

### Revocation leaves the SignerList unchanged

Deleting or expiring an `ENG/ARBITER` credential does not remove that account from the SignerList installed at open. Changing the SignerList needs quorum. The not-yet-consumed revocation rule in [docs/spec/attestations.md](docs/spec/attestations.md) is not implemented for this credential. Chargeback defaults cover a silent arbiter. They do not cover an arbiter who still signs with the counterparty.

### Accreditor address is not the service account

`ENG_ARBITER_ACCREDITOR` is the classic address the deployment sets. The co-signer does not check that it is the service account. The chargeback design assumes the service is that issuer. One address per deployment. A list of outside bodies, and the trust-list file from the neutrality design, remain a follow-up (see the Research limits below).

### The RLUSD issuer name is used twice

`ENG_RLUSD_ISSUER` is the pool CLI trust-line issuer. When it is unset, the pool CLI uses Testnet RLUSD `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`. The same name is the policy slot `$slot:rlusd.issuer`. The hotel Testnet script issues its own test IOU and does not spend that default issuer.

## Research

**Research: designed and tested on Testnet, not maintained for production or new features.**

Research applies to: hotel (hotel@2, catalog R1).

**Hotel is frozen.** `settlement-vault/hotel@2` and the Hotel stay scenario in the web demo (`packages/web`) are Research. The stay was designed and run on Testnet (Done, below, records 17/17). **Process rule: no new hotel features are merged.**

Known research issue — reserve at the 14-night cap. `npm run validate-templates` reports `tickets needed: 109, reserve: 23.2 XRP` for `settlement-vault/hotel@2`. The validator counts every pre-signed outcome, including 13 stay-chargeback variants (`templates/hotel@2.json` sets `default.chargebackStay.variants.max` to 13). A one-night stay books 31 Tickets and a 14-night stay books 109 (`packages/cosigner/test/hotel-flow.test.ts`). Reserve is 1 XRP plus 0.2 XRP for the trust line, the signer list and each Ticket (`packages/core/src/template.ts`), which is 23.2 XRP at 109 Tickets. The template check allows 25 XRP of pre-create funding for that reserve plus fee headroom (`packages/core/src/cli.ts`).

Automatic endings in `hotel@2` return extra funds to the guest (`default.noshowSweep` and the other pre-signed endings).

Known limits of this vertical:

- **Single-writer store.** Co-signer state is durable in SQLite (one writer, enforced by a lease). Running several co-signer hosts needs the Postgres store, see [README §7](README.md#7-policy-co-signer).
- **Accreditation issuer is one address per deployment.** `pol_hotel@2.0.0` names `$slot:arbiter.accreditor` (`ENG_ARBITER_ACCREDITOR`). The chargeback design assumes that issuer is the engagement service.
- **Accreditor list / trust-list file.** A deployment still names one accreditor. Recognising several outside bodies, and the trust-list file sketched in the neutrality design, remains a follow-up.
- **`vectors:check` does not rebuild.** It replays the committed `vectors/policy.json` and passed at `95c1abb` before the slot regeneration, so a skipped `vectors:build` does not fail that step. CI's rebuild-and-diff is what catches a stale file. Follow-up: compare `vectors:check` against a fresh build, or against the policy files' layer hashes.
- **A lapsed arbiter is not replaced.** The backup arbiter is gone and a SignerList change needs quorum, so a deal whose accreditation lapses mid-stay cannot swap arbiters. Chargeback defaults cover silence only.
- **Chargeback parameters.** Ruling window, split, 14-night cap and bond return are demo assumptions pending a real business.

The same label is in [`docs/SCOPE.md`](docs/SCOPE.md#product-status).

## Research track

- **MPP + Open Wallet Standard** — [docs/research/mpp.md](docs/research/mpp.md). MPP settles via the
  reference SDK (decided); the OWS remote-policy question is answered ([ows.md](docs/research/ows.md)).
- **Smart Escrows (XLS-100)**, **Sponsored fees & reserves (XLS-68)**, **on-ledger Cosign** —
  [README §14](README.md#14-future-research), [docs/research/cosign.md](docs/research/cosign.md).

## Done (recent)

- **`eng open` (T23).** `npm run eng -- open --template procurement@1` funds a Testnet cast, mints a demo IOU (not RLUSD), opens `owner-wallet/procurement@1`, and registers it with the local co-signer from `local.json`. Seeds go to stdout with a TESTNET ONLY banner. The bearer is not printed; `COSIGNER_API_TOKEN_FILE` is the path. Registration retries a 503 or a connection error three times and does not retry 4xx. Devnet and a co-signer started with `ENG_RLUSD_ISSUER` are refused.
- **One-command local co-signer (T17).** `npm run cosigner:local` binds loopback, generates an ed25519 Testnet key and a bearer token under the data dir on first run, keeps SQLite state and the tick scheduler across a restart, and writes `local.json` (url, address, public key, network, token path) for `eng open`. `/v1` requires the bearer. Known Testnet hosts only. `npm run cosigner` is unchanged.

- **Durable co-signer state, restart tests and a tick scheduler (T10–T12).** The co-signer keeps registrations, receipts, pre-signed defaults, in-flight payments and the decision log in a `StateStore` (SQLite by default in the server, in-memory for tests), restores them on boot, quarantines an engagement whose policy library changed, and rejects a second writer. Kill-and-restart tests cover disputes, rulings and in-flight spends. `COSIGNER_TICK_MS` runs `tick()` on a schedule. Postgres is a documented upgrade path — [README §7](README.md#7-policy-co-signer).

Hotel entries below are [Research](#research). No new hotel features are merged.

- **Accredited arbiter and chargeback-style defaults — live on Testnet 17/17.** The backup arbiter is
  removed (guest 3, hotel 3, arbiter 4, co-signer 2, quorum 7). The arbiter must hold an accepted
  `ENG/ARBITER` credential from the service; the co-signer refuses `NOT_NEUTRAL` before money moves.
  A silent arbiter triggers chargeback-style defaults (full refund on entry disputes, room to the hotel
  on claims, nights used on mid-stay disputes), and an unanswered claim lapses. All parameters are
  assumptions pending a real business —
  [design](docs/superpowers/specs/2026-11-14-arbiter-chargeback-design.md).
- **Hotel stay escrow, end to end — live on Testnet 14/14.** `settlement-vault/hotel@2` +
  `pol_hotel@2.0.0`: security deposit at check-in, entry disputes that end the deal early, deposit
  claims capped at the deposit, guest-only disputes, silence defaults pre-signed with Tickets, default
  arbiter rulings (the backup arbiter was later removed). The co-signer ingests party statements with signed receipts and
  deadline windows and completes due defaults on `tick()`. Replaced the demo's old
  escrow-with-arbiter scenario with **Hotel stay**, whose simulated mode replays real co-signer
  decisions — [design](docs/superpowers/specs/2026-11-12-hotel-stay-escrow-design.md).
- **Pre-booking check for the guest's agent.** `dealTerms()` derives a deal's real terms (money,
  deadlines, who can move the money, what happens if nobody acts, who appointed the arbiters) and
  `checkNorms()` flags only what's unusual against `norms/hotel@1.json`, with severity hints;
  escalation is the agent's call. Shown in the Hotel stay demo for a standard and an unusual offer.
- **Plain English everywhere.** Every policy rule carries a `title` and `message` (new lint L8);
  the demo shows a plain sentence per step and named, click-to-explain checks taken from the
  policies' own text.
- **Privy custody hardening.** Authorization keys sign every `raw_sign` request
  (`PRIVY_AUTHORIZATION_KEY`), and Privy-held keys can enrol in `eng.provision/1` by
  proof-of-possession through a `Signer`.
- **End-to-end web demo + provisioning protocol.** A single page ([`packages/web`](packages/web)) that provisions an engagement account, opens it on-ledger, and drives the agent through the policy co-signer — settling in-policy payments and blocking the rest. A template dropdown adds more scenarios — **escrow with arbiter** (since replaced by **Hotel stay**, above), a **bonded marketplace** (the seller stakes a collateral bond; delivery returns it, harm lets the arbiter slash it to the buyer), **x402 metered purchase** (the co-signer's W7 rule binds each payment to the merchant's challenge, so it can't be redirected or replayed), and **MPP push payment** on the Stripe/Tempo rail (the same rail-neutral W7 binding) — proving one governed account works across agentic-payment rails. It runs **simulated** (a shareable artifact (no backend)) and **live** on Testnet (`npm run web`: real provisioning, real multisigned payments, explorer links). Underneath it is `eng.provision/1` ([`packages/provisioning`](packages/provisioning)): non-custodial signer enrolment by proof-of-possession — each signer proves control of its key (pubkey derives to address + challenge signature verifies), the coordinator assembles the SignerList + engagement record, the owner opens. Core + HTTP + 6 tests; full suite 174/174.
- **Agent-side MCP tool** ([packages/agent-mcp](packages/agent-mcp)). An MCP server exposing four tools to an AI agent — `propose_payment` (the agent signs, the co-signer evaluates and on `SIGN` returns its signature, the two combine into a quorum blob), `submit_payment`, `pay_vendor`, and `engagement_status`. The agent's `SignerList` key sits below quorum, so it can never move funds alone; broadcasting is fail-closed (off unless `XRPL_URL` + `AGENT_ALLOW_SUBMIT=1`). The transport-free core (`Decider`/`Chain` seams) is driven in tests against the real co-signer both in-process and over its HTTP API; full suite 168/168. Makes the whole design usable by any MCP-speaking agent runtime.
- **R2 consumer-shopping scenario.** A second scenario on the same owner-wallet engine as B1 —
  weekly cap + a `merchant.category/1` classifier allowlist, with the rail-neutral payment-challenge
  binding (SH5) reused. New `owner-wallet/shopping@1` template + `pol_shopping@1.0.0`, fixtures, and
  9 conformance vectors (50 policy / 11 template total); full suite 162/162, lint + validate green.
  Proves the engine generalizes beyond procurement.
- **x402 `exact` multisig upstream proposal — drafted.** A backward-compatible
  amendment to the XRPL `exact` scheme adding normative offline `Signers`/SignerList/quorum
  verification (aligned with `rippled`'s `checkMultiSign`), with the adapter's `verifyExactPayload` as
  the reference implementation and deterministic negative vectors as conformance material —
  [docs/proposals/x402-exact-multisig.md](docs/proposals/x402-exact-multisig.md). The forward-looking
  spec amendment is welcome upstream now.
- **OWS evaluation spike.** Read the Open Wallet Standard policy-engine sub-spec + reference
  (`ows-core`): the only external-policy path is a local, fail-closed, 5-second allow/deny
  **custom executable** — no native remote/approver/co-signer rule, and it returns a verdict, not a
  signature. Verdict: *ride* OWS as the agent's wallet (a thin executable bridging to the
  co-signer's `/decide`), *differentiate* on the ledger-enforced quorum/recourse a pre-sign wallet
  gate can't provide. Closes the one open question from mpp.md — [docs/research/ows.md](docs/research/ows.md).
- **MPP live demo (`demo:mpp`).** The engagement-account → MPP-merchant push path over the pinned
  XRPL charge wire format, settling via the adapter's `confirmExactSettlement` and the co-signer's
  rail-neutral W7 (`payment.challenge/1`, scheme `mpp`). In-process test 5/5 (`test:mpp`); live
  script `demo:mpp` ready. Confirmed `xrpl-mpp-sdk@0.1.0-beta.4` peers on xrpl<5, so the merchant
  speaks the wire format and bridges to the adapter rather than depending on the beta —
  [walkthrough](docs/demo/mpp-purchase.md).
- **Open-sourcing scaffolding** — `LICENSE` (Apache-2.0), `NOTICE`, `SECURITY.md` (90-day
  coordinated disclosure), `CONTRIBUTING.md`, `CODEOWNERS`, and CI (typecheck, full test suite,
  template/policy lint, x402 integration, a conformance-vector drift gate, advisory `npm audit`).
  Ready to publish; pushing and publishing are the maintainer's step.
- **Co-signer hardening → pilotable.** Bearer-token auth + per-IP rate limiting on `/v1` (required
  when bound off loopback, open on loopback for dev), readiness (`/readyz`) vs liveness
  (`/healthz`) probes, structured per-request logs, and a `SignerProvider` custody seam (env seed /
  seed file now; HSM/KMS + `ENG/COSIGNER` accreditation behind the same interface). 10 new HTTP
  tests; suite 152/152 green.
- Read MPP + the Open Wallet Standard and pinned the MPP XRPL wire format; decided to settle MPP via
  the reference `xrpl-mpp-sdk` (no adapter envelope) — [docs/research/mpp.md](docs/research/mpp.md).
- Made the co-signer rail-neutral: `x402.challenge/1` → `payment.challenge/1` (scheme `x402` | `mpp`).
- Sanitised the docs for sharing, reframed the milestone language, and added the B1 and x402
  walkthroughs (now under `docs/demo/`).

## Pre-created account pool (XLS-68)

A cache of fully sponsored, pre-aged engagement accounts (operating account carries reserves +
fees; reserves reclaimed on close). See `docs/pool.md`. Status: builders + `PoolManager` + CLI
landed and offline-tested. Open items:

- [ ] Wire the pool into the live demo `provision` (fixed RLUSD issuer, pool service signing key,
      `deleteTo = sponsor`, close → `PoolManager.reclaim`) — validate live on a `Sponsor`-enabled network.
- [ ] Harden seed storage: swap `LocalFileSeedStore` → `KmsSeedStore` (cloud KMS / secrets manager).
- [ ] Production orchestration: port `PoolManager` to a Temporal workflow (interfaces → activities).
