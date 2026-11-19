# Scope: what's supported, when

Which use cases from the [catalog](use-cases/catalog.md) the project supports, at which tier, and what's missing for the rest. The aim is to say "supported" only for cases the code, the policies and a live Testnet run all cover, and to keep everything else visible with its blockers.

## Product status

**Research: designed and tested on Testnet, not maintained for production or new features.**

Hotel uses that sentence in full. Bonds, group pots and consumer use cases use the same Research label, and are not maintained for production or new features. Procurement (B1), x402 and MPP stay on their current rows. The status column below still records what is built. A Research tier on those cards is this label.

- **Hotel.** Catalog R1, `settlement-vault/hotel@2`, and the Hotel stay scenario in `packages/web`. The R1 status cell is the description of what `HotelFlow` runs on Testnet. **Process rule: no new hotel features are merged.** At the 14-night cap the template needs 109 Tickets and 23.2 XRP of reserve (`npm run validate-templates`; the breakdown is on [the roadmap](../ROADMAP.md#research)).
- **Bonds.** Catalog B5 and the bonded-marketplace scenario in `packages/web`. No bond template is in `templates/`.
- **Group pots.** Catalog R7. No group-pot template is in `templates/`.
- **Consumer use cases.** Catalog R2–R6. R2 ships `owner-wallet/shopping@1`, `pol_shopping` and 9 vectors.

## Tiers

| Tier | Meaning | Gate to enter |
|---|---|---|
| **v1** | Supported: template + policy shipped, conformance vectors, Testnet demo passes | Vectors reproduce; demo green on Testnet |
| **v1.1** | Next: same template classes, needs one more piece (an attester type or a second engagement) | Extension implemented + vectors |
| **v2** | Needs a catalog extension (E1–E12) that changes the template or the transaction shapes | Extension spec + spike |
| **Research** | Not maintained for production or new features. The hotel vertical was designed and tested on Testnet. Bonds, group pots and consumer use cases carry this label too. Ledger features that don't exist yet stay here. | Not a maintained product. Ledger-feature rows still wait on the amendment or the decision. |
| **Not supported** | Engagements are the wrong tool (catalog §4) | — |

## Use cases

| Card | Class | Tier | Status | Missing for the tier |
|---|---|---|---|---|
| **B1** Enterprise procurement agent | Owner wallet | **v1** | Built and live on Testnet: template, policy, co-signer, vectors; demo D1–D11 passed (11/11). x402 purchase via the settlement adapter, X1–X4 (4/4) ([walkthrough](demo/b1-procurement.md)) | — |
| **R2** Personal shopping agent | Owner wallet | **Research** | Same class and engine as B1 | ✅ consumer policy (weekly cap + `merchant.category/1`), `owner-wallet/shopping@1` + `pol_shopping`, fixtures, 9 vectors |
| **R1** Agent-booked hotel | Escrow | **Research** | `settlement-vault/hotel@2`, `pol_hotel@2.0.0` and the hotel@2 vectors are built. `HotelFlow` (`packages/cosigner/src/hotel/flow.ts`) runs confirm, check-in, settle, a conceded refund, the residual-sweep defaults, the chargeback-style defaults and the accreditation gate through the co-signer. `npm run demo:hotel` checks that path as H1–H17 (`packages/cosigner/demo/hotel-testnet.ts`). The asset in that script is a test IOU the script itself issues (`currencyHex('RLUSD')`), not Ripple's RLUSD. | Facilitator store, and the `open` and `amend` stage rules ([policy spec §15](spec/policy.md#15-reference-implementation)). No arbiter-service package; the demo's arbiter is a key the script holds. |
| **R6** Refundable pre-order deposit | Escrow | **Research** | Hotel-shaped: refund / apply / forfeit defaults | Template + policy (`production.started/1` corroborated, delivery events), vectors. Fixed terms only (no amendments) |
| **R3** Second-hand purchase (P2P) | Escrow | **Research** | — | Accredited carrier attester (`shipping.delivered/1`), inspection-window timer anchored on delivery (attestations §6) |
| **B8** Digital asset sale with holdback | Escrow ×2 | v1.1 | — | Two engagements opened in one Batch, registry attester (`registry.transfer/1`) |
| R4 Home renovation milestones | Escrow | **Research** | — | E1 tranches, E3 amendments, inspector attester |
| R5 Rental security deposit | Escrow | **Research** | Backup-arbiter weights validated (V11, E4 vector) | E4 default refresh, E11 licensed deposit scheme |
| R7 Group trip kitty | Group-owned | **Research** | — | Group class policy, E7 scale limits |
| B2 Cross-border agency milestones | Escrow | v2 | — | E1, E5 cross-currency payouts, E9 in policy (sweep verified on Testnet) |
| B3 Trade finance light | Escrow | v2 | — | E1, E2 document attesters, E11 licensed operator |
| B4 Compute/data with SLA | Escrow | v2 | — | E6 outcome ladder |
| B5 Marketplace collateral bond | Escrow | **Research** | — | E1 repeated slashes, E9 |
| B6 Multi-agent subcontracting | Escrow graph | v2 | — | E8 engagement graphs |
| B7 Ad campaign vs. verified delivery | Escrow | v2 (hard) | — | E1, E2, E6 |
| X1–X4 | — | Not supported | — | Cost floor, native escrow, plain Batch, or licensing ([catalog §4](use-cases/catalog.md#4-boundary-cases-where-engagements-are-the-wrong-tool)) |

## Components

| Component | State | Where |
|---|---|---|
| Ledger mechanics (pre-create, atomic open, ticketed defaults, settle-and-close) | ✅ proven on Testnet (21/21) | spike (kept local; not reproducible from this repo yet; see T27) |
| Template validator (V1–V15, disclosures, reserve) | ✅ | `packages/core` |
| Statement envelope (JCS, `ENGA\0`, XRPL keys) | ✅ | `packages/core` |
| Policy engine `cel-eng/1`, attestation pipeline, lint | ✅ | `packages/policy` |
| Baseline B1–B11, procurement (incl. W7 x402-challenge binding), hotel, and consumer-shopping (R2) policies | ✅ | `policies/` |
| Co-signer service (pinned snapshots, in-flight, reservations, decision log, HTTP) | ✅ (loopback open; bearer-token auth + per-IP rate limit required off loopback) | `packages/cosigner` |
| Conformance vectors (181: 158 policy, of which 108 are hotel@2; 17 template; 6 statement) | ✅ | [`vectors/`](../vectors/README.md) |
| B1 Testnet demo | ✅ D1–D11 passed (11/11) | [`b1-procurement.md`](demo/b1-procurement.md) |
| x402 engagement purchase | ✅ via `x402-xrpl-settlement-adapter` (prepaid + exact), X1–X4 on Testnet; the reference `exact` facilitator can't carry engagement payments | [research](research/x402-multisig.md), [walkthrough](demo/x402-purchase.md) |
| MPP engagement purchase (XRPL charge, push) | ✅ in process (5/5) via `x402-xrpl-settlement-adapter` + co-signer W7 (scheme `mpp`); live script `demo:mpp` ready; `xrpl-mpp-sdk` peers on xrpl<5 so the demo bridges the wire format | [research](research/mpp.md), [walkthrough](demo/mpp-purchase.md) |
| Facilitator / engagement store, open-stage rules | ⏳ planned | — |
| Arbiter service | ⏳ planned | — |
| Indexer (reviews, rulings) | ⏳ planned | — |
| `engagement` x402 scheme | ⏳ planned | README §8 |
| Sponsored accounts (XLS-68), on-ledger cosign, Smart Escrows | Research | [README §14](../README.md#14-future-research) |

## Explicitly out of scope for v1

- **Reusing accounts across deals.** Every engagement is a fresh account deleted at close (README §3).
- **Amendments** (E3) and **tranches** (E1). v1 deals have fixed terms and a single close.
- **Non-RLUSD assets in policies.** The engine is asset-generic (`Amount` with declared decimals), but shipped policies and vectors cover RLUSD only.
- **Production key custody for the co-signer.** Keys load through a `SignerProvider` seam (env seed, seed file, or a Privy-custodied key today); HSM/KMS signing and accreditation (`ENG/COSIGNER` credential) implement the same interface later.
- **Multi-tenant auth / RBAC on the co-signer API.** The server now takes a shared bearer token with per-IP rate limiting (required when bound off loopback) and exposes readiness/liveness probes; per-user accounts, scopes and audit beyond the signed decision log are out of scope for v1.
