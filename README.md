# XRPL Engagement Accounts

**Single-use, multi-party joint accounts on the XRP Ledger, with quorum enforced by the ledger, for agent payments, escrow-with-recourse, and stake-backed trust.**

**▶ [Try the live demo](https://naory.github.io/xrpl-engagement-accounts/)** — an interactive, simulated walkthrough: an agent spends, gets blocked, settles a dispute, and pays across rails. (The same page also runs against live XRPL Testnet via `npm run web`.)

> Status: **core mechanics proven on Testnet; policy co-signer and x402 shipped** (October 2026). This README is the design document.
> - **Ledger mechanics** — atomic open, pre-signed ticket-based defaults, settle-and-close with `AccountDelete`, and the ruling path without the service — are proven on XRPL Testnet (21/21).
> - **Policy co-signer** — the template validator, the `cel-eng/1` policy engine, the co-signer service and the conformance vectors — is built in [`packages/`](packages). The B1 procurement agent runs end to end on Testnet (11/11). Walkthrough: [`docs/demo/b1-procurement.md`](docs/demo/b1-procurement.md).
> - **x402** — engagement accounts pay x402 merchants today through our own settlement adapter ([`x402-xrpl-settlement-adapter`](https://www.npmjs.com/package/x402-xrpl-settlement-adapter), published), using the `prepaid` scheme with the co-signer's W7 binding; proven on Testnet (4/4). Walkthrough: [`docs/demo/x402-purchase.md`](docs/demo/x402-purchase.md).
> - **Not built yet:** the arbiter, the engagement-store facilitator, and the indexer.
> - What is supported, and when: [`docs/SCOPE.md`](docs/SCOPE.md).

---

## TL;DR

An **engagement account** is an ordinary XRPL account created for **one deal**: a hotel booking, an agent's task budget, a collateral bond, a rental deposit. It is **deleted when the deal concludes**, and accounts are never reused across deals. Its master key is disabled and it is governed only by a **SignerList**: the principal, the counterparty, an arbiter, and optionally a **policy co-signer**. Every outgoing movement of funds requires a quorum, and the **XRP Ledger enforces that quorum**, not our servers.

The service never holds enough signing weight to move funds on its own. It provides:

- **fresh accounts per deal**, pre-created ahead of time so the ledger's deletion wait never delays a short deal. Reserves come back when the account is deleted, and the only burned cost is about 0.2 XRP plus fees per deal, which is negligible for the large payments this targets,
- **templates** (signer sets, weights, quorums, default outcomes) for common deal shapes,
- a **policy co-signer** that signs only when a rule passes, for limits that signer weights cannot express,
- an **arbiter** role for disputes,
- an **x402 integration**, so an agent can open an engagement inline with an HTTP 402 flow,
- an **indexer** that turns settled engagements into a payment-backed reputation record.

---

## 1. Why

x402 made agent payments easy. Payment rails are now largely commoditized: the x402 Foundation sits under the Linux Foundation, and the card networks, Coinbase, Stripe, Ripple and others are members. Several layers above the rails are still thin:

| Thin layer | What's missing today |
|---|---|
| **Recourse** | x402 settles push-style and with finality. There are no refunds, disputes or partial outcomes. EVM experiments (x402r, Okay3) use smart-contract escrow, which XRPL mainnet doesn't have. |
| **Bounded delegation** | "Nova may spend up to 400 RLUSD on a hotel in Lisbon for these dates" is not enforceable at the ledger level. Policy wallets such as Privy, Sardis and PolicyLayer enforce limits off-chain, in the provider's key management, and are mostly EVM. |
| **Stake-backed trust** | Reputation built from feedback is cheap to fake. Slashable bonds exist only as hackathon-stage EVM contracts. |
| **Multi-party settlement** | Native XRPL Escrow is all-or-nothing to one destination, and a refund has to wait for `CancelAfter`. |

XRPL already has the primitives to cover all of this on mainnet today: multisig, master-key disable, Tickets, Credentials, Permissioned Domains, Token Escrow, Batch and RLUSD. What's missing is the **service layer** that makes them usable per engagement.

## 2. Core concept

```
            ┌─────────────────────────────────────────────┐
            │        Engagement Account  rEngage…         │
            │  master key: DISABLED                       │
            │  SignerList (quorum Q):                     │
            │     principal      (Dana / Nova)   w=?      │
            │     counterparty   (merchant)      w=?      │
            │     arbiter        (named at open) w=?      │
            │     policy co-signer (optional)    w=?      │
            │  holds: XRP reserve + RLUSD (or IOU/MPT)    │
            └─────────────────────────────────────────────┘
                 ▲ create / open            │ payouts need quorum
                 │                          ▼
        Engagement Service ───────── XRPL validates multisig
        (accounts, templates, co-signer,
         arbiter, indexer, x402 facilitator)
```

**Invariant:** the service's keys never meet quorum by themselves in any template. That is the non-custodial claim, and it should be checkable from ledger state alone.

### Roles

| Role | Who | Responsibility |
|---|---|---|
| **Principal** | Human (Dana) or her agent (Nova) | Funds the account and authorizes the mandate. |
| **Counterparty** | Merchant, freelancer, landlord, service agent | Delivers, and receives the payout. |
| **Arbiter** | Named at open: AI arbiter, human service, or a panel | Decides disputes. Its rulings are public and build its own reputation. XRPL multisig doesn't nest, so a panel is not a single signer: its members go on the engagement's SignerList as separate entries, with weights and quorum chosen so the panel's majority together counts as one arbiter vote. |
| **Policy co-signer** | A service that signs only if a rule passes | Enforces limits that weights can't express: caps per time window, allowlists, credential checks, mandate matching. |
| **Engagement service** | Us | Creates and opens accounts, runs templates, coordination, indexer and x402 facilitator. Holds at most a minority signer slot (usually the co-signer or the arbiter, never both in a way that reaches quorum). |

## 3. Lifecycle

One account per deal: created, used once, deleted. No account is ever reused across deals.

```
 PRE-CREATE ──▶ OPEN (configure + fund) ──▶ ACTIVE ──┬─ happy path ──▶ SETTLE & CLOSE ──▶ (account deleted)
                                                     ├─ dispute ────▶ ARBITRATE ─▶ SETTLE & CLOSE
                                                     └─ silence ────▶ DEFAULT OUTCOME ─▶ SETTLE & CLOSE
```

1. **Pre-create.** The service keeps a small buffer of fresh, never-used accounts. Each is funded with reserve XRP and has its RLUSD trust line. An account can only be deleted once the ledger index is at least its `Sequence` + 256 (about 15 minutes), and pre-creating ahead of time means that wait never delays a short deal. At pre-create the service also installs its own key as the account's `RegularKey` and **disables the master key** (this must be a normal master-signed transaction; it can't run inside a Batch, spike finding F1). Until it's opened, a pre-created account holds only reserve XRP under the service's regular key.
2. **Open.** One atomic Batch, signed with the service's regular key:
   - `SignerListSet` installs the engagement's signers and quorum;
   - `TicketCreate` reserves Tickets for the pre-signed default outcomes (§6);
   - `SetRegularKey` with no key **removes the service's key**, so from then on only the SignerList can authorize anything;
   - the principal's RLUSD funding payment is included as a multi-account inner transaction signed through `BatchSigners`.

   The account is therefore never configured-but-unfunded or funded-but-unconfigured. The default-outcome transactions are pre-signed by the parties *before* the open Batch is submitted. If a time lock is wanted on top of the multisig, the account can also create a Token Escrow to itself, so the funds come back to the account on release and can still be split.
3. **Active.** Depending on the template, the agent spends within policy, or funds sit until delivery.
4. **Settle and close.** The outcome is a payout split signed by quorum: full release, partial refund, or full refund. It runs as **one atomic Batch (XLS-56) in `ALLORNOTHING` mode** together with closing the account:
   1. the payout(s);
   2. removal of the RLUSD trust line (zero balance, default flags) and of any other objects that would block deletion (escrows, checks, payment channels);
   3. **`AccountDelete`** as the last inner transaction. Its destination is the service, so the reserve comes back.

   Either everyone is paid *and* the account is gone, or nothing happens. `AccountDelete` itself removes the SignerList, any unused Tickets, Credentials, offers and similar objects. **No pre-signed transaction can outlive its deal**, and nothing from one deal can carry over to another. (Batch-inner `AccountDelete` is verified in rippled, see §14.1.)

## 4. Templates

| Template | Signers (weight) · Quorum | Payout rule | Notes |
|---|---|---|---|
| **Bounded agent wallet** | Nova (1), Dana (2), co-signer (1) · Q=2 | Nova + co-signer for in-policy spends. Dana alone can always sweep. | The balance *is* the budget. A compromised agent can lose at most what's in the account. One account per task or mandate. |
| **Settlement vault (escrow with recourse)** | Dana (2), merchant (2), arbiter (3), co-signer (1) · Q=5 | Dana + merchant + co-signer agree (policy enforced), *or* arbiter + either party executes a ruling (no service needed). | Partial and immediate refunds, which native escrow can't do. See §5 and the [worked use case](docs/use-cases/hotel-booking.md). |
| **Agent collateral bond** | Agent (1), marketplace (1), arbiter (1) · Q=2 | Arbiter + harmed party slash. Agent + marketplace release at end of term. | Reputation backed by stake. Counterparties check the bond size before transacting. |
| **Security / rental deposit** | Tenant (1), landlord (1), arbiter (1) · Q=2 | Same as the settlement vault, with long holds. | Damage deductions as partial splits. |
| **Multi-agent job** | Orchestrator, verifier, sub-agents · one quorum per account | Milestone payouts as verifier + orchestrator sign. | A SignerList has a single quorum, so milestones that need different signers get separate engagement accounts. Tackles the multi-hop settlement gap. |
| **Group pot** | N members · Q=k | k of N approve spends. Leftover split at close. | Shared trip kitty in RLUSD. |

Templates are declarative JSON (`templates/*.json`): signer roles, weights, quorum, allowed transaction types, default outcomes and timeouts.

The design is tested against a broader set of 19 retail, business and boundary scenarios in the [use-case catalog](docs/use-cases/catalog.md), which also defines the template classes (escrow, owner-controlled wallet, group-owned) and the register of extensions E1–E12 those scenarios need.

## 5. Worked example: Dana pays Nova to book a hotel

**Goal:** a large, human-initiated payment that an agent executes, with recourse and a mandatory review.

> Full worked specification with every artifact (template + validation, mandate, policy, x402 messages, XRPL transactions, ledger state, indexer records) and all four paths: [`docs/use-cases/hotel-booking.md`](docs/use-cases/hotel-booking.md).

1. **Mandate.** Dana signs a mandate (city, dates, room class, max price, allowed merchant categories). Its hash is the anchor for the whole engagement. Verifiable Intent / AP2-style credentials are the natural carrier.
2. **402.** Nova calls the merchant's booking endpoint. It responds `402 Payment Required` with an **`engagement` scheme** (§8): amount, asset (RLUSD), template `settlement-vault`, arbiter ID, check-out date and dispute window.
3. **Open.** The facilitator takes a fresh pre-created account and submits the open Batch: it installs {Dana 2, merchant 2, arbiter 3, co-signer 1} at Q=5 and moves the funds in. Nova prepares everything. Dana's key signs the funding (and the default-outcome transactions, which are pre-signed before the open Batch is submitted). Nova is not on the SignerList in this template. It acts for Dana, and her signature is what counts on-ledger.
4. **Confirm.** The merchant returns a **signed booking confirmation**. Nova checks its structured fields against the mandate *immediately*. A wrong city is caught in the same minute, not at the hotel door. Hashes of both documents are written to the ledger in memos.
5. **Happy path.** After check-out, Nova prepares a **review** (content kept off-ledger, hash on-ledger) and the payout. Dana signs both. Dana + merchant + the co-signer (which checks the payout against policy) reach quorum and the funds release. The review is *mandatory but its content doesn't gate the money*, so neither side can use it to extort the other.
6. **Dispute path.** Dana issues a `dispute:<engagementID>` **Credential** (with a small refundable dispute bond) before the window closes. Today, that stops the default outcome because the service and the arbiter refuse to release the pre-signed default while the Credential exists (§6). It becomes ledger-enforced only with Smart Escrows (§14.4). The arbiter compares mandate vs. confirmation vs. evidence and co-signs a split with the winning party. For example, "rebooked in a worse room → 30% back" is one atomic Batch: 70% to the merchant, 30% to Dana, close the account, all signed once by the arbiter and the winning party.
7. **Silence path.** If nobody acts within check-out + N days, the service submits the pre-signed default (release to merchant, recorded as "no review").
8. **Close.** Every path ends in the settle-and-close Batch (§3). The account is deleted and its reserve goes back to the service.

**The float problem:** real hotels won't wait until check-out. The realistic counterparty is a booking agent or agentic travel merchant that pays the hotel upfront and carries the receivable. That working capital could later come from an XLS-65 Single Asset Vault + XLS-66 lending pool, with LPs funding the float against a book of engagement receivables.

## 6. Default outcomes and liveness

The classic multisig failure is parties disappearing and funds getting stuck. Mitigations:

- **Pre-signed defaults via Tickets.** At open, the parties sign the default-outcome transaction(s) against reserved Tickets **up to quorum − 1**, and the service stores them. XRPL transactions can't encode "not before time T" on their own, so the **co-signer withholds the final signature** and adds it only at T, and only if no dispute is open. A stored or leaked blob is not submittable without it. The time condition is still a trust assumption on the service (until Smart Escrows), but nobody else can trigger a default early. A default is itself a settle-and-close Batch. Because it's signed before the account's later sequence numbers are known, the outer transaction **and each inner transaction** must use a Ticket (about 4 Tickets per default outcome). Whichever outcome executes first deletes the account, so the alternatives, including any unused defaults, die with it. An alternative is to pair it with a **Token Escrow** whose `FinishAfter` gives a real ledger-enforced time lock.
- **Escrow-wrapped funds.** For high-value engagements the account holds an escrow instead of a raw balance, so the ledger enforces timelines. This becomes much cleaner with **Smart Escrows (XLS-100)** once they ship (§9).
- **Arbiter backstop.** In every arbiter template, the arbiter plus any one party can still settle, even with the service down (template validator invariant V3).
- **Exact-balance defaults.** A default pays out exactly the expected balance and then removes the trust line. Any extra deposit (e.g. a dispute bond) makes it fail on-ledger, so the bond doubles as a ledger-enforced lock.

## 7. Policy co-signer

Signer weights express *who* may act, not *what* they may do. The co-signer closes that gap by refusing to sign anything outside policy:

- caps per transaction, per day, or for the whole engagement,
- allowlisted destinations / merchant categories, and blocklists,
- **mandate matching** (the booking confirmation matches the signed mandate),
- credential checks (counterparty holds a KYB / KYA Credential, is in a Permissioned Domain),
- risk scores from an external engine (e.g. a KYA/risk provider) as an *input*, with the decision made here.

Design rules:

- The co-signer is **deterministic and auditable**. The policy is versioned, its hash is recorded at open, and every decision is logged with a reason code.
- It **can't move funds alone**. If it is compromised, the worst case is approving an in-quorum transaction that another party also signed.
- It is meant to integrate with the **MPCP policy authority** — the earlier project this builds on — so the same Policy → Grant → Budget chain drives both the ledger-level co-signer and off-ledger authorization.

Full specification (rule language, input model, stages, baseline safety rules, stateful counters, decision records, layering with MPCP): [`docs/spec/policy.md`](docs/spec/policy.md). Reference implementation: [`packages/policy`](packages/policy) (engine) and [`packages/cosigner`](packages/cosigner) (service), with the shipped policies in [`policies/`](policies) and conformance vectors in [`vectors/`](vectors/README.md).

## 8. x402 integration

Plain x402 `exact` payments stay as they are for metered, per-call pricing. Engagements are for chunky, conditional, multi-party payments.

**Today — engagement accounts pay x402 merchants** through our own settlement adapter, [`x402-xrpl-settlement-adapter`](https://www.npmjs.com/package/x402-xrpl-settlement-adapter) (published), which carries two schemes:

- **`prepaid`** — the engagement path. The agent builds the payment, the policy co-signer co-signs it (rule **W7** binds the co-signature to the merchant's x402 challenge: destination, amount, invoice), the agent submits the multisigned `Payment`, and the merchant verifies the *validated* transaction on-ledger. Multisig needs no special handling — the ledger has already enforced the SignerList and quorum. The payment keeps its `eng/basis` and `eng/invoice` memos and also carries the adapter's x402 memo. Proven end to end on Testnet (4/4); full walkthrough: [`docs/demo/x402-purchase.md`](docs/demo/x402-purchase.md).
- **`exact`** — the interop path for ordinary single-signed x402 clients: offline signature verification (including `Signers` against the account's SignerList) and `InvoiceID = sha256(invoiceRef)` binding.

**Why our own adapter.** The reference XRPL `exact` facilitator (`@x402/xrpl`) rejects any blob with `Signers` (`multisig_not_supported`) and also rejects `Memos` and `Delegate` — so it cannot carry an engagement-account payment, whose co-signature and engagement memos are exactly what it refuses. The hosted facilitators we evaluated offer no supported, specified path for multisigned engagement-account settlement, and no public roadmap for one, so rather than depend on unspecified behaviour we ship the adapter. Details: [`docs/research/x402-multisig.md`](docs/research/x402-multisig.md).

**MPP too.** Engagement accounts also pay **Machine Payments Protocol** (Stripe/Tempo) merchants — via the reference `xrpl-mpp-sdk` in push mode (the server reads the validated transaction, so a multisig payer is transparent), with the co-signer's **W7** binding the co-signature (`payment.challenge/1`, scheme `mpp`). We don't reimplement the MPP envelope here. See [`docs/research/mpp.md`](docs/research/mpp.md).

**Next — a dedicated `engagement` scheme** for opening a conditional, multi-party deal inline with the 402 flow (roadmap §12). A sketch of its `402` response body (illustrative, not final):

```json
{
  "x402Version": 2,
  "accepts": [{
    "scheme": "engagement",
    "network": "xrpl:mainnet",
    "asset": { "currency": "RLUSD", "issuer": "r…" },
    "maxAmountRequired": "412.00",
    "payTo": "rMerchant…",
    "extra": {
      "template": "settlement-vault@1",
      "arbiter": "did:xrpl:rArbiter…",
      "disputeWindowSecs": 259200,
      "deliveryBy": "2026-11-14T11:00:00Z",
      "mandateHashRequired": true,
      "reviewRequired": true
    }
  }]
}
```

The client replies with its `BatchSigners` signature over the open Batch (which carries the funding payment) plus its signatures over the default-outcome transactions. The **engagement facilitator** verifies the funding, opens a fresh account, submits, and returns an `engagementId` that the merchant uses for confirmation and settlement calls.

## 9. XRPL primitives used

| Primitive | Use here | Status (verify before relying on it) |
|---|---|---|
| Multisig `SignerListSet` (up to 32 signers) | Quorum governance | Mainnet |
| Master key disable (`asfDisableMaster`) + `SetRegularKey` | Master disabled at pre-create (master-signed). Service RegularKey removed inside the open Batch | Mainnet. **Can't run as a Batch inner** (`tecNEED_MASTER_KEY`, F1) |
| Tickets | Out-of-sequence pre-signed defaults | Mainnet |
| Credentials (XLS-70) | Dispute flags, KYA/KYB attestations | Mainnet |
| Permissioned Domains (XLS-80) | Restricting counterparties | Mainnet |
| Token Escrow (XLS-85) | Time-locked RLUSD/IOU/MPT inside an engagement | Mainnet |
| Batch (XLS-56) | Atomic open (configure + fund), atomic settle + close, multi-party payout splits | Mainnet (enabled Oct 9, 2026) |
| `AccountDelete` | Closing the deal, recovering the reserve, removing leftover SignerList/Tickets/Credentials | Mainnet. Allowed as a Batch inner transaction (§14.1) |
| Smart Escrows (XLS-100, WASM) | Ledger-enforced release predicates (review present, arbiter sig, oracle) | **Devnet** (9th build, Oct 2026) |
| Smart contracts (XLS-101) | Long term: single-contract version of this service | Draft |
| Single Asset Vault (XLS-65) / Lending (XLS-66) | Funding merchant float, *not* per-deal custody | SAV mainnet. Check XLS-66 |
| Sponsored Fees and Reserves (XLS-68) | Service carries all XRP costs (§14.2) | Spec final, in rippled `develop`. Check amendment status |
| On-Chain Cosigner (`Cosign`) | On-ledger signature collection, outcome options (§14.3) | Draft, work in progress in `develop` |

Why **not** a Single Asset Vault for custody: it pools funds pro-rata with no per-deal earmarking, share holders can always redeem, and only the asset issuer (via clawback) can override. That's the opposite of what an engagement needs.

## 10. Security and threat model

| Threat | Mitigation |
|---|---|
| Service compromise | Service keys are always below quorum. Before open, the service's key (as `RegularKey`) controls only pre-created accounts holding reserve XRP. The master key is disabled and discarded at pre-create, and the service's key is removed atomically in the open Batch. |
| Agent key compromise | Bounded agent wallet: loss is capped at the balance. The co-signer rejects out-of-policy spends. The principal can sweep. |
| Arbiter collusion | Arbiter + one party is the only path. Use a panel arbiter for high value. Rulings are public and arbiter reputation is indexed. |
| Frivolous disputes / griefing | Refundable dispute bond. A dispute after the window has no effect. |
| Review extortion | Review content never gates release (§5). |
| Stuck funds | Pre-signed defaults, escrow-wrapped funds, arbiter backstop (§6). |
| Stale pre-signed transactions | A pre-signed default is bound to its account and Tickets. Accounts are never reused and are deleted at close (which removes unused Tickets), so a default can't be replayed against another deal, even when merchants and arbiters are repeat players. |
| Linkability / privacy | A fresh account per deal, so there is no cross-deal history on an account. Only hashes on-ledger. Personal data (stays, names) stays off-ledger. |
| Issuer actions | RLUSD issuer freeze/clawback applies to engagement balances too. Document it and don't promise otherwise. |
| Reserve economics | Reserves are locked only for a deal's lifetime and recovered at close. Per deal, about 0.2 XRP (the `AccountDelete` fee) plus tx fees is burned, covered by the service fee. The pre-created buffer is sized to deal throughput. |

## 11. Architecture

```
xrpl-engagement-accounts/
├── packages/
│   ├── core/            # ✅ amounts (BigInt minor units), JCS, statement envelope, template validator (V1–V12)
│   ├── policy/          # ✅ cel-eng/1 engine, attestation pipeline, decide(), decision records, lint
│   ├── cosigner/        # ✅ co-signer service: pinned ledger snapshots, in-flight counters, decision log, HTTP API
│   │   └── demo/        #    B1 Testnet demo, x402 engagement purchase demo, facilitator probe
│   ├── agent-mcp/       # ✅ agent-side MCP server: propose → co-sign → combine → submit (4 tools)
│   ├── provisioning/    # ✅ eng.provision/1: non-custodial signer enrolment (proof-of-possession)
│   ├── web/             # ✅ end-to-end demo UI (simulated + live Testnet) over the stack above
│   ├── accounts/        # ⏳ pre-create buffer, open, settle & close (from spike/src/lib.js)
│   ├── arbiter/         # ⏳ arbiter service + evidence API (AI + human queue)
│   ├── facilitator/     # ⏳ engagement store + x402 `engagement` scheme facilitator
│   ├── indexer/         # ⏳ settlements → reputation records (reviews, rulings, bonds)
│   └── sdk/             # ⏳ client SDK for agents & merchants
├── templates/           # ✅ hotel@1, hotel@2 (settlement vault), procurement@1 (owner wallet)
├── policies/            # ✅ baseline@1.1.0 (B1–B11), hotel@1.1.0, hotel@2.0.0, procurement@1.3.0 (W0–W7 incl. x402 W7)
├── vectors/             # ✅ conformance vectors: 96 policy, 16 template, 6 statement
├── docs/
│   ├── SCOPE.md         # supported use cases by tier, component status
│   ├── use-cases/       # catalog.md (scenarios), hotel-booking.md (worked spec)
│   ├── demo/            # worked demo walkthroughs: b1-procurement.md, x402-purchase.md
│   ├── spec/            # attestations.md, policy.md; next: engagement, templates, transactions, arbiter, x402 scheme, indexer
│   └── research/        # cosign.md, x402-multisig.md
└── spike/               # Testnet spike (xrpl.js), 21/21 — kept local-only (gitignored)
```

Stack: TypeScript (Node ≥ 22.12, `tsx`, `vitest` 5), `xrpl.js` 5.3, `ripple-keypairs`, CEL via `@marcbachmann/cel-js` 8.0.0 (pinned for `cel-eng/1`). Later: Postgres for engagement state, and Rust/`xrpl_wasm_stdlib` for Smart Escrow finish functions.

```bash
npm install
npm test                    # 367 tests: core, policy, co-signer, agent-mcp, provisioning, conformance vectors (Node ≥ 22.12)
npm run typecheck
npm run validate-templates  # V1–V12 report for templates/*.json
npm run lint-policies       # L1–L7 for policies/*.json against their templates
npm run vectors:build       # regenerate vectors/*.json (deterministic; review the diff)
npm run demo:b1             # live B1 procurement demo on Testnet (see packages/cosigner/demo/README.md)
npm run demo:x402           # live x402 engagement-account purchase on Testnet (needs x402-xrpl-settlement-adapter)
npm run demo:mpp            # live MPP (push) engagement-account purchase on Testnet (needs x402-xrpl-settlement-adapter)
npm run probe:x402          # probe a hosted facilitator for engagement-account support
COSIGNER_SEED=s… npm run cosigner   # HTTP co-signer on 127.0.0.1:8787 (test seeds only; set COSIGNER_API_TOKEN + COSIGNER_BIND to expose it)
AGENT_SEED=s… ENGAGEMENT_ID=… ENGAGEMENT_ACCOUNT=r… ASSET_ISSUER=r… npm run mcp   # agent-side MCP server for an AI agent (see packages/agent-mcp/README.md)
npm run web                 # end-to-end demo UI on http://127.0.0.1:8080 (simulated + live Testnet; see packages/web/README.md)
npm run demo:mcp            # agent drives the MCP tools end-to-end on Testnet (see packages/agent-mcp/README.md)
npm run demo:privy          # same agent + co-signer flow with the co-signer key held in Privy (needs a Privy app; skips otherwise)
```

**Key custody.** The Testnet demos above (`demo:mcp`, `demo:b1`, `demo:x402`, `demo:mpp`) run with **local keys** — throwaway wallets funded from the Testnet faucet, no setup and no `.env` needed. For **production**, the agent and policy co-signer sign through **Privy** (sign-not-export: the key is created and held in Privy and never leaves it), selected with `AGENT_KEY_SOURCE=privy` / `COSIGNER_KEY_SOURCE=privy` (see [`.env.example`](.env.example)); `demo:privy` proves that path live on Testnet. Local `AGENT_SEED` / `COSIGNER_SEED` are for development and tests only.

## 12. Roadmap

### Built and verified

- **Ledger mechanics (Testnet, 21/21).** Pre-create + atomic open (signer list, Tickets, `RegularKey` removed, funding); settle-and-close with `AccountDelete` last in one `ALLORNOTHING` Batch, including an arbiter + principal split with a residual sweep; a fully ticket-based pre-signed default completed by the co-signer's final signature, with the other defaults dying at close; failure modes (the dispute bond rolls the default back atomically, a failed default burns its outer Ticket, fees measured).
- **Template validator** V1–V12: minimal winning sets, disclosures, reserve and ticket counts ([`packages/core`](packages/core)).
- **`cel-eng/1` policy engine:** Amount type, attestation pipeline, layered policies, definitions, cost budget, decision records, lint ([`packages/policy`](packages/policy), [spec](docs/spec/policy.md)).
- **Baseline B1–B11** + procurement (W0–W7, including the x402 **W7** challenge binding), hotel, and consumer-shopping (R2) policies ([`policies/`](policies)).
- **Co-signer service** ([`packages/cosigner`](packages/cosigner)): each decision reads the ledger at one pinned validated index; in-flight payments count toward rolling caps and single-use approvals are reserved while in flight; requests per engagement are serialised; every decision is a signed `cosigner.decision/1` record; advisory stages get a decision but no signature; HTTP API with bearer-token auth and per-IP rate limiting (required off loopback), readiness/liveness probes, and a `SignerProvider` seam for Privy or HSM/KMS custody.
- **Conformance vectors:** 96 policy (46 hotel@2), 16 template, 6 statement ([`vectors/`](vectors/README.md)).
- **R2 consumer-shopping scenario** — a second scenario on the **same owner-wallet engine** as B1: a weekly spend cap + a `merchant.category/1` classifier allowlist, with the rail-neutral payment-challenge binding reused. New `owner-wallet/shopping@1` template + `pol_shopping@1.0.0`, fixtures, and 9 conformance vectors. (Policy + vectors; no separate live Testnet run.)
- **B1 procurement agent — live on Testnet, 11/11** (D1–D11): in-policy spends, approval bound to the payment intent, in-flight race, daily cap, consumed-statement replay, non-vendor payee, agent-alone `tefBAD_QUORUM`, smuggled `SetRegularKey`, and the owner-alone sweep + `AccountDelete`. Walkthrough: [`docs/demo/b1-procurement.md`](docs/demo/b1-procurement.md).
- **x402 engagement purchase — live on Testnet, 4/4** (X1–X4). Settlement adapter [`x402-xrpl-settlement-adapter`](https://www.npmjs.com/package/x402-xrpl-settlement-adapter) published (0.3.0), `prepaid` + `exact` schemes, co-signer **W7** binding the co-signature to the merchant's x402 challenge. Walkthrough: [`docs/demo/x402-purchase.md`](docs/demo/x402-purchase.md).
- **MPP engagement purchase — verified in process (5/5), live script ready** (M1–M4). The engagement-account → MPP-merchant **push** path over the pinned XRPL charge wire format (verified against `xrpl-mpp-sdk@0.1.0-beta.4`), settling via the adapter's `confirmExactSettlement` and the co-signer's rail-neutral **W7** (`payment.challenge/1`, scheme `mpp`). `test:mpp` 5/5; live `demo:mpp`. Walkthrough: [`docs/demo/mpp-purchase.md`](docs/demo/mpp-purchase.md).
- **Agent-side MCP tool** ([`packages/agent-mcp`](packages/agent-mcp)): an MCP server giving an AI agent four tools — `propose_payment` (the agent signs, the co-signer evaluates and on `SIGN` returns its signature, the two combine into a quorum blob), `submit_payment`, `pay_vendor`, and `engagement_status`. The agent's `SignerList` key sits **below quorum**, so a compromised agent can never move funds alone; broadcasting is fail-closed (off unless `XRPL_URL` + `AGENT_ALLOW_SUBMIT=1`). The transport-free core is driven in tests against the real co-signer both in-process and over its HTTP API. Suite 174/174.
- **Provisioning protocol** (`eng.provision/1`, [`packages/provisioning`](packages/provisioning)): non-custodial signer enrolment by proof-of-possession — each signer proves it controls the key for its address (the public key derives to the address and a challenge signature verifies), the coordinator assembles the `SignerList` + engagement record, and the owner opens. Core + HTTP + 6 tests.
- **End-to-end web demo** ([`packages/web`](packages/web)): one page, four scenarios (a template dropdown) — the procurement agent, **Hotel stay** (`hotel@2`, replaces the old escrow-with-arbiter scenario; simulated mode replays `packages/web/public/hotel-sim.json`, generated from the real co-signer by `npm run web:hotel-sim`), a **bonded marketplace** (the seller stakes a collateral bond; the arbiter can slash it to the buyer), **x402 metered purchase** (the co-signer binds each payment to the merchant's x402 challenge — the W7 rule — so a payment can't be redirected to another merchant or replayed), and **MPP push payment** (the same account and co-signer on the Stripe/Tempo rail, proving the governance is rail-neutral). It provisions, opens, and drives each through the policy co-signer, settling or blocking every request, with an event-log tab tracing provisioning and settlement. Runs **simulated** (shareable, no backend) or **live** on Testnet via `npm run web` (real provisioning, real multisigned payments, explorer links).
- **Hotel stay escrow, end to end through the co-signer — live on Testnet, 14/14** (H1–H14, `npm run demo:hotel`; results in `packages/cosigner/demo/results/hotel-run-2026-11-13T11-46-32-678Z.json`; the web scenario's live `happy` path also settled `tesSUCCESS`). New `settlement-vault/hotel@2` template (guest 3, hotel 3, arbiter 4, backup arbiter 2, co-signer 2, quorum 7; 15 Tickets) and `pol_hotel@2.0.0` (stages `confirm`, `checkin`, `settle`, `refund.conceded`, `default.refund`, `default.noshow`, `default.release`, `ruling.backup`, `ruling.default`); baseline renamed to `baseline@1.1.0`. The co-signer ingests party statements with signed receipts (`POST /v1/engagements/:id/attestations`) and holds pre-signed default transactions, completing them on `tick()` when a window lapses (`POST /v1/engagements/:id/presigned`, `/tick`). Adds a security deposit at check-in, entry disputes that end the deal early, deposit claims capped at the deposit, guest-only disputes, silence rules, and default and backup rulings. The `HotelFlow` driver runs all eight paths. See the [design spec](docs/superpowers/specs/2026-11-12-hotel-stay-escrow-design.md) and [use case](docs/use-cases/hotel-booking.md). **Known limitation:** the co-signer keeps attestations, receipts and pre-signed defaults in memory. A restart drops them, so a restarted co-signer could complete a default over a claim it had previously receipted. Production needs a persistent store.

### Next

- **Arbiter service** (AI + human queue) and evidence API.
- **Arbiter neutrality safeguards** (for arbiters a merchant contracts). At open, the co-signer checks the arbiter holds `ARBITER_ACCREDITED` from the service root and is on the guest's mandate `allowedArbiters`, and refuses to open otherwise. The backup arbiter is appointed by the service (or nominated by the guest's side), never by the merchant, so a stalled or captured primary doesn't leave the guest with the merchant's pick. Arbiter fees are flat, never contingent on the outcome.
- **Persistent co-signer state.** Attestations, receipts and pre-signed defaults are in memory today; a restart drops them (see the hotel@2 entry above).
- **Indexer:** settlements → reputation records (reviews, rulings, bonds).
- **x402 `engagement` scheme + facilitator.** A facilitator that verifies `Signers` against the account's SignerList at a pinned ledger; a proposal to the x402 Foundation for multisig support in the `exact` scheme (the spec text allows it; the reference code rejects it), with our `exact` verifier as the reference implementation.
- **Collateral bonds.** Bond template + slashing by arbiter + harmed party; bond size exposed as a trust signal (ERC-8004 / KYA cross-reference).
- **Research track (§14):** Smart Escrow variant (XLS-100), sponsored accounts and reserves (XLS-68), on-ledger cosign (`Cosign`).

## 13. Open questions

- **Batch limits.** Per XLS-56, the engagement account signs the outer Batch with ordinary multisig, its own inner transactions need no `BatchSigners`, and other accounts (e.g. Dana funding) sign through `BatchSigners` entries, single- or multi-sign. Still to test: the 8-inner-tx limit. Open needs about 4 inner transactions. Settle-and-close needs payouts (1–2) + trust-line removal + escrow cleanup + `AccountDelete`, which fits. If a template needs more cleanup, a separate pre-cleanup Batch runs first.
- **Time conditions.** Is pre-signed-tx custody plus Token Escrow time locks enough, or does the flow need Smart Escrows before production?
- **Arbiter economics.** Who pays, how much, and how is AI-vs-human escalation decided?
- **Reputation design.** How should reviews be weighted (by amount, by reviewer history, by bond)? How do we resist collusive wash engagements when each fake review costs only fees + float time?
- **Identity.** Which credential formats to accept for parties (KYA tokens, ACK-ID DIDs, ERC-8004 references, XRPL Credentials), and how to bridge them?

## 14. Future research

### 14.1 Verification: `AccountDelete` inside a Batch

The single-use lifecycle (§3) depends on closing the account in the same atomic Batch as settlement.

**Verified: `AccountDelete` is allowed as a Batch inner transaction** (rippled `develop` @ `3857ce2`, 2026-10-09):
- It isn't in `Batch::kDisabledTxTypes`. That list only covers SAV/Lending transactions, and only before `LendingProtocolV1_2`. Apart from that, only nested Batches are rejected.
- `Batch_test::testAccountDelete` covers `tfIndependent` success, `tfIndependent` with a `tecHAS_OBLIGATIONS` failure, and **`tfAllOrNothing`, where a failure after the delete rolls back the whole Batch**.
- The outer account can delete itself inside its own Batch. Inner transactions after the delete fail with `terNO_ACCOUNT`, so **`AccountDelete` must be the last inner tx**.
- The outer fee must include the `AccountDelete` special fee (one owner-reserve increment) on top of the Batch fee.

**Resulting settle-and-close Batch** (`ALLORNOTHING`, signed once by the engagement quorum on the outer tx, up to 8 inner txs):
1. Payout(s): RLUSD to the merchant and/or a refund to Dana
2. `TrustSet` removing the RLUSD trust line (zero balance, default flags)
3. `EscrowFinish`/`EscrowCancel` and removal of any other *blocking* objects (trust lines, escrows, checks, payment channels)
4. `AccountDelete` → destination: the service (or the sponsor, see 16.2)

`AccountDelete` itself removes Offers, the SignerList, Tickets, DepositPreauth, NFT offers, DID, Oracle, **Credentials** and Delegate entries, so those don't need their own inner txs.

Caveat: `AccountDelete` sweeps **all remaining XRP** to its destination. Pre-signed outcomes always pay out first and delete last. Never pre-sign a *standalone* `AccountDelete` for an XRP-denominated deal, because it would sweep the payment to the service. With RLUSD deals, the trust line blocks deletion until settlement has run.

### 14.2 XLS-68 Sponsored Fees and Reserves

Spec **Final** (last updated 2026-09-15), implementation rippled PR #7350. The `Sponsor` amendment is in `develop` (`Supported::Yes`, `DefaultNo`). **Mainnet status: check before relying on it.** It would let the service carry every XRP cost, so users only ever deal in RLUSD:

- **Sponsored account creation.** A `Payment` with `tfSponsorCreatedAccount` creates the engagement account with a `Sponsor` field. The amount doesn't need to meet the reserve. The reserve stays on the service's books and never sits in the jointly controlled account, which closes a small leak in the current design.
- **Sponsored object reserves.** `spfSponsorReserve` covers `TrustSet`, `SignerListSet`, `EscrowCreate`, `CheckCreate`, `PaymentChannelCreate`, `DepositPreauth`, `DelegateSet`, and `Credential` entries can carry a sponsor. That covers everything an engagement needs except Tickets.
- **Sponsored fees.** A pre-funded `Sponsorship` object (`FeeAmount`, `MaxFee`, `RemainingOwnerCount`) or a co-signed sponsor pays tx fees. **But rippled rejects fee sponsorship on Batch inner txs** (`temINVALID_FLAG`), so sponsor the *outer* Batch tx.
- **Deletion.** For a sponsored account, `AccountDelete.Destination` *must* equal the sponsor, so leftover XRP goes back to the service by ledger rule. The service's account can't be deleted while it sponsors anything (`tecHAS_OBLIGATIONS`).
- **Custody.** Sponsees keep full control of their keys. The sponsor gets no signing power, so the non-custodial claim holds.

Issues to work through:
- **Tickets can't be sponsored in v1.** The pre-signed default outcomes (§6) would need some XRP in the account for Ticket reserves. That's about 4 Tickets per pre-signed default outcome (§6), at about 0.2 XRP each, which the service pre-funds. Alternatively, prefer **sponsored escrow time locks** for defaults and reduce the number of Tickets.
- A `Sponsorship` object blocks account deletion for **both** parties. It has to be deleted (`SponsorshipSet`) during close. Mind the 8-inner-tx limit.
- `RemainingOwnerCount` isn't restored when sponsored objects are deleted, so budget it per account.
- Ending sponsorship early (`SponsorshipTransfer` + `tfSponsorshipEnd`) needs the sponsee to cover the reserve. Avoid it and just delete the account.

### 14.3 On-Chain Cosigner (`Cosign` amendment)

Full notes: [`docs/research/cosign.md`](docs/research/cosign.md).

**What:** `TransactionProposalCreate` posts an unsigned transaction on-ledger as a `TransactionProposal`. Parties add signatures independently (`TransactionProposalSign`). Once quorum is reached, anyone can submit it. Draft spec (XRPL-Standards Discussion #589, no XLS number yet). The `Cosign` amendment is in rippled `develop` as **work in progress** (`Supported::No`; only Create is implemented).

**Why it matters here:**
- **Signature coordination moves on-ledger.** Dana, the merchant and the arbiter sign whenever suits them, with no coordinator in the middle.
- **Outcome options.** Competing proposals sit on separate tickets: release / refund / split, each an `ALLORNOTHING` Batch ending in `AccountDelete`. The first one to execute deletes the account, so the others can never run. Mutually exclusive outcomes come from the ledger, with no smart contracts.
- **Arbiter rulings become on-ledger events.** The arbiter rules by signing the winning proposal.
- **Pre-signed defaults leave service custody.** They're held "all but the last signature", and a time-gated final signer adds that one after the deadline. Expiration is only "not after".
- **New risk:** collected signatures can't be revoked. Parties sign an outcome only when they intend it to happen now.

### 14.4 Evolution path

| Stage | Adds | The service… |
|---|---|---|
| 0: today | Multisig, Tickets, Credentials, Token Escrow, Batch | coordinates signatures off-ledger, holds pre-signed defaults, funds reserves |
| 1: + Sponsor (XLS-68) | sponsored accounts, reserves, fees | carries all XRP costs; users only touch RLUSD |
| 2: + Cosign | on-ledger proposals | proposes outcome options and notifies; no off-ledger signature custody |
| 3: + Smart Escrows (XLS-100) | WASM release predicates | supplies templates and predicates; time and review conditions enforced on-ledger |
| 4: + Smart contracts (XLS-101) | general contracts | thin layer; the engagement could become a single contract |

At the end of this path the service is just *templates + policy co-signer + arbiter + reserve sponsor + indexer*, and the engagement is an object anyone can inspect on-ledger.

## 15. References

- x402 Foundation: https://docs.cdp.coinbase.com/x402/support/x402-foundation
- XLS-100 Smart Escrows: https://xls.xrpl.org/xls/XLS-0100-smart-escrows.html
- XLS-102 WASM VM: https://xls.xrpl.org/xls/XLS-0102-wasm-vm.html
- XRPL Single Asset Vaults: https://xrpl.org/docs/concepts/tokens/single-asset-vaults
- t54 + Mastercard Verifiable Intent on XRPL: https://stablecoininsider.org/xrpl-mastercard-verifiable-intent-agent-payments/
- xrpl-agent-wallet-mcp: https://glama.ai/mcp/servers/yfqi0o20uo
- x402r refund protocol: https://www.producthunt.com/products/x402r-refund-protocol
- Bazaar (bonded AI services): https://github.com/Ccheh/bazaar
- Cross-agent payment flows (multi-hop gap): https://presenc.ai/research/cross-agent-payment-flows-2026
- XLS-56 Batch: https://xls.xrpl.org/xls/XLS-0056-batch.html
- XLS-68 Sponsored Fees and Reserves: https://xls.xrpl.org/xls/XLS-0068-sponsored-fees-and-reserves.html
- XRPL docs, sponsored fees and reserves: https://xrpl.org/docs/concepts/accounts/sponsored-fees-and-reserves
- On-Chain Cosigner draft (Discussion #589): https://github.com/XRPLF/XRPL-Standards/discussions/589
- rippled Batch implementation: https://github.com/XRPLF/rippled/blob/develop/src/libxrpl/tx/transactors/system/Batch.cpp

---

## License & contributing

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Contributions welcome ([CONTRIBUTING.md](CONTRIBUTING.md)); report security issues privately per [SECURITY.md](SECURITY.md).

*Author: Naor Yuval. Design drafted October 2026.*
