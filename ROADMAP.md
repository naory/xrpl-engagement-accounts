# Roadmap

Forward plan for **xrpl-engagement-accounts**. What's built and verified lives in the
[README §12 "Built and verified"](README.md#12-roadmap) (B1 live on Testnet 11/11, x402 purchase
4/4, hotel stay escrow 14/14, ledger mechanics 21/21, co-signer, policies, vectors, the published
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

Hotel stay → production-ready (the flow itself is built and live; these close its known gaps):

- **Automatic endings return extra money to the guest** *(in progress)*. Pre-signed defaults are
  signed for an exact balance, so any extra RLUSD (a partial deposit, stray funds) jams them. Each
  ending sweeps the remainder back to the guest instead; a partial deposit then ends like real life —
  no keys, a no-show, the partial deposit returned.
- **Persistent co-signer state.** Receipts, stored statements and pre-signed defaults are in memory;
  a restart drops them, so a restarted co-signer could complete a default over a claim it had
  receipted. Needs a persistent store and a restart test.
- **Arbiter neutrality safeguards.** At open, require an accredited arbiter on the guest's
  `allowedArbiters`; the backup arbiter is appointed by the service (or the guest's side), never by
  the merchant; arbiter fees are flat. The pre-booking check already *flags* these; this *enforces*
  them.

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

## Research track

- **MPP + Open Wallet Standard** — [docs/research/mpp.md](docs/research/mpp.md). MPP settles via the
  reference SDK (decided); the OWS remote-policy question is answered ([ows.md](docs/research/ows.md)).
- **Smart Escrows (XLS-100)**, **Sponsored fees & reserves (XLS-68)**, **on-ledger Cosign** —
  [README §14](README.md#14-future-research), [docs/research/cosign.md](docs/research/cosign.md).

## Done (recent)

- **Hotel stay escrow, end to end — live on Testnet 14/14.** `settlement-vault/hotel@2` +
  `pol_hotel@2.0.0`: security deposit at check-in, entry disputes that end the deal early, deposit
  claims capped at the deposit, guest-only disputes, silence defaults pre-signed with Tickets, default
  and backup arbiter rulings. The co-signer ingests party statements with signed receipts and
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
