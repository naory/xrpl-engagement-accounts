# Scope: what's supported, when

Which use cases from the [catalog](use-cases/catalog.md) the project supports, at which tier, and what's missing for the rest. The aim is to say "supported" only for cases the code, the policies and a live Testnet run all cover, and to keep everything else visible with its blockers.

## Tiers

| Tier | Meaning | Gate to enter |
|---|---|---|
| **v1** | Supported: template + policy shipped, conformance vectors, Testnet demo passes | Vectors reproduce; demo green on Testnet |
| **v1.1** | Next: same template classes, needs one more piece (an attester type or a second engagement) | Extension implemented + vectors |
| **v2** | Needs a catalog extension (E1–E12) that changes the template or the transaction shapes | Extension spec + spike |
| **Research** | Depends on ledger features that don't exist yet, or on unresolved design questions | Amendment availability / decision |
| **Not supported** | Engagements are the wrong tool (catalog §4) | — |

## Use cases

| Card | Class | Tier | Status | Missing for the tier |
|---|---|---|---|---|
| **B1** Enterprise procurement agent | Owner wallet | **v1** | Built and live on Testnet: template, policy, co-signer, vectors; demo D1–D11 passed (11/11). x402 purchase via the settlement adapter, X1–X4 (4/4) ([walkthrough](demo/b1-procurement.md)) | — |
| **R2** Personal shopping agent | Owner wallet | **v1** | Same class and engine as B1 | ✅ consumer policy (weekly cap + `merchant.category/1`), `owner-wallet/shopping@1` + `pol_shopping`, fixtures, 9 vectors |
| **R1** Agent-booked hotel | Escrow | **v1** | Template, policy (confirm / settle / defaults) and vectors built. Mechanics proven on Testnet | Open-stage rules, facilitator store, arbiter flow, end-to-end Testnet run through the co-signer |
| **R6** Refundable pre-order deposit | Escrow | **v1** | Hotel-shaped: refund / apply / forfeit defaults | Template + policy (`production.started/1` corroborated, delivery events), vectors. Fixed terms only (no amendments) |
| **R3** Second-hand purchase (P2P) | Escrow | v1.1 | — | Accredited carrier attester (`shipping.delivered/1`), inspection-window timer anchored on delivery (attestations §6) |
| **B8** Digital asset sale with holdback | Escrow ×2 | v1.1 | — | Two engagements opened in one Batch, registry attester (`registry.transfer/1`) |
| R4 Home renovation milestones | Escrow | v2 | — | E1 tranches, E3 amendments, inspector attester |
| R5 Rental security deposit | Escrow | v2 | Backup-arbiter weights validated (V11, E4 vector) | E4 default refresh, E11 licensed deposit scheme |
| R7 Group trip kitty | Group-owned | v2 | — | Group class policy, E7 scale limits |
| B2 Cross-border agency milestones | Escrow | v2 | — | E1, E5 cross-currency payouts, E9 in policy (sweep verified on Testnet) |
| B3 Trade finance light | Escrow | v2 | — | E1, E2 document attesters, E11 licensed operator |
| B4 Compute/data with SLA | Escrow | v2 | — | E6 outcome ladder |
| B5 Marketplace collateral bond | Escrow | v2 | — | E1 repeated slashes, E9 |
| B6 Multi-agent subcontracting | Escrow graph | v2 | — | E8 engagement graphs |
| B7 Ad campaign vs. verified delivery | Escrow | v2 (hard) | — | E1, E2, E6 |
| X1–X4 | — | Not supported | — | Cost floor, native escrow, plain Batch, or licensing ([catalog §4](use-cases/catalog.md#4-boundary-cases-where-engagements-are-the-wrong-tool)) |

## Components

| Component | State | Where |
|---|---|---|
| Ledger mechanics (pre-create, atomic open, ticketed defaults, settle-and-close) | ✅ proven on Testnet (21/21) | spike (kept local) |
| Template validator (V1–V12, disclosures, reserve) | ✅ | `packages/core` |
| Statement envelope (JCS, `ENGA\0`, XRPL keys) | ✅ | `packages/core` |
| Policy engine `cel-eng/1`, attestation pipeline, lint | ✅ | `packages/policy` |
| Baseline B1–B11, procurement (incl. W7 x402-challenge binding), hotel, and consumer-shopping (R2) policies | ✅ | `policies/` |
| Co-signer service (pinned snapshots, in-flight, reservations, decision log, HTTP) | ✅ (loopback open; bearer-token auth + per-IP rate limit required off loopback) | `packages/cosigner` |
| Conformance vectors (67) | ✅ | [`vectors/`](../vectors/README.md) |
| B1 Testnet demo | ✅ D1–D11 passed (11/11) | [`b1-procurement.md`](demo/b1-procurement.md) |
| x402 engagement purchase | ✅ via `x402-xrpl-settlement-adapter` (prepaid + exact), X1–X4 on Testnet; the reference `exact` facilitator can't carry engagement payments | [research](research/x402-multisig.md), [walkthrough](demo/x402-purchase.md) |
| MPP engagement purchase (XRPL charge, push) | ✅ in process (5/5) via `x402-xrpl-settlement-adapter` + co-signer W7 (scheme `mpp`); live script `demo:mpp` ready; `xrpl-mpp-sdk` peers on xrpl<5 so the demo bridges the wire format | [research](research/mpp.md), [walkthrough](demo/mpp-purchase.md) |
| Facilitator / engagement store, open-stage rules | ⏳ planned | — |
| Arbiter service | ⏳ planned | — |
| Indexer (reviews, rulings) | ⏳ planned | — |
| `engagement` x402 scheme | ⏳ planned | README §8 |
| Sponsored accounts (XLS-68), on-ledger cosign, Smart Escrows | Research | README §16 |

## Explicitly out of scope for v1

- **Reusing accounts across deals.** Every engagement is a fresh account deleted at close (README §3).
- **Amendments** (E3) and **tranches** (E1). v1 deals have fixed terms and a single close.
- **Non-RLUSD assets in policies.** The engine is asset-generic (`Amount` with declared decimals), but shipped policies and vectors cover RLUSD only.
- **Production key custody for the co-signer.** Keys load through a `KeyProvider` seam (env seed or seed file today); HSM/KMS signing and accreditation (`ENG/COSIGNER` credential) implement the same interface later.
- **Multi-tenant auth / RBAC on the co-signer API.** The server now takes a shared bearer token with per-IP rate limiting (required when bound off loopback) and exposes readiness/liveness probes; per-user accounts, scopes and audit beyond the signed decision log are out of scope for v1.
