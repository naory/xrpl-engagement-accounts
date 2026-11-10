# Use-case catalog

> A broad set of retail (B2C) and business (B2B) scenarios used to **test the design**, not to market it. Each card gives the actors, a template sketch, the flow, what it stresses, and a verdict. Cards that need something the design doesn't have yet point to the **extension register** (§4).
> Status: design draft, October 2026. Detailed worked specs exist for: [R1 hotel booking](hotel-booking.md).

**Notation.** P = principal (payer), C = counterparty (payee), A = arbiter, S = service co-signer, Q = quorum. "Pre-signed default" = an outcome signed at open up to Q − weight(S), completed by S's final signature when its policy stage passes (see the hotel spec §5.3, §7.4). "Close" = an `ALLORNOTHING` Batch ending in `AccountDelete`. Verdicts: ✅ fits as designed · ⚠️ fits with named extensions · ❌ don't use engagements.

**Template classes** emerged while writing the cards:
- **Escrow** (R1, R3–R6, B2–B8): P and C both protected. P + C < Q, arbiter + either party ≥ Q.
- **Owner-controlled wallet** (R2, B1): only the payer is protected. The owner alone reaches Q *by design*, and payees are not signers. The template validator needs this class to relax invariant V2 ("no single role reaches quorum") for the owner.
- **Group-owned** (R7): N peers, k-of-N, no counterparty or arbiter.

---

## 1. Index

| # | Use case | Class | Parties | Duration | Evidence | Payout shape | Verdict | Extensions |
|---|---|---|---|---|---|---|---|---|
| R1 | Agent-booked hotel | Escrow | P, C, A, S | Weeks | Mandate vs. confirmation | All / split | ✅ | none ([spec](hotel-booking.md)) |
| R2 | Personal shopping agent | Owner wallet | P, agent, S | Months | Per-spend policy | Many small spends | ✅ | E2, E12 |
| R3 | Second-hand purchase (P2P) | Escrow | P, C, A, S | Days–weeks | Carrier tracking | All / split / conditional | ✅ | E2 |
| R4 | Home renovation milestones | Escrow | P, C, A, S + inspector | Months | Inspector certificates | Milestones + retainage | ⚠️ | E1, E2, E3 |
| R5 | Rental security deposit | Escrow | P, C, A1, A2, S | 12+ months | Move-out report | Refund / deductions | ⚠️ | E4, E11 |
| R6 | Refundable pre-order deposit | Escrow | P, C, A, S | Weeks–months | Production / delivery events | Refund / apply / forfeit | ✅ | E2, E3 |
| R7 | Group trip kitty | Group-owned | 6 peers | Weeks | None | Spends + proportional leftover | ✅ | E7 |
| B1 | Enterprise procurement agent | Owner wallet | Company, agent, S | Quarter | Invoices, approvals | Many vendor payments | ✅ | E2, E10, E12 ([spec](../demo/b1-procurement.md)) |
| B2 | Cross-border agency milestones | Escrow | P, C, A, S | Months | Invoices, acceptance | Milestones, FX payout | ⚠️ | E1, E5, E9 |
| B3 | Trade finance light | Escrow | P, C, A, S + attesters | 1–3 months | eBL, inspection cert | Tranches against documents | ⚠️ | E1, E2, E11 |
| B4 | Compute/data with SLA | Escrow | P, C, A, S + monitor | 30 days | Uptime attestations | Computed refund | ⚠️ | E2, E6 |
| B5 | Marketplace collateral bond | Escrow | Provider, marketplace, A, S | 90 days | Claims + rulings | Repeated slashes + residual | ⚠️ | E1, E9 |
| B6 | Multi-agent subcontracting | Escrow graph | K, O, sub-agents, A, S | Days | Delivery acceptance | Tree of payouts | ⚠️ | E7, E8 |
| B7 | Ad campaign vs. verified delivery | Escrow | P, C, A, S + measurement | Weeks | Impression attestations | Recurring variable payouts | ⚠️ (hard) | E1, E2, E6 |
| B8 | Digital asset sale with holdback | Escrow ×2 | P, C, A, S + registry | Days + 60 days | DNS/registry attestation | Main + holdback | ✅ | E2 |
| X1 | Concert ticket pre-sale | n/a | 1 organizer, thousands of buyers | Months | n/a | n/a | ❌ | E7 (cost floor) |
| X2 | All-or-nothing crowdfunding | n/a | Hundreds of backers | Weeks | Funding target | All refund / all release | ❌ (native escrow) | E7 |
| X3 | On-ledger DvP | n/a | Two traders | Seconds | n/a | Atomic swap | ❌ (plain Batch) | n/a |
| X4 | Real-estate earnest money | Escrow | Buyer, seller, licensed agent | Months | Closing docs | All / forfeit | ❌ alone, ⚠️ with a licensed operator | E11 |

---

## 2. Retail (B2C)

### R1 · Agent-booked hotel

Fully specified in [hotel-booking.md](hotel-booking.md). It's the reference for the escrow class: P2 · C2 · A3 · S1 · Q5, mandate matching at confirmation, refund and release defaults, a dispute bond that locks the release default on-ledger, and an arbiter ruling without the service.

### R2 · Personal shopping agent with a weekly budget

**Actors:** Dana (owner), Nova (her agent), service co-signer. Merchants and x402 APIs are payees, not signers.
**Amounts / time:** 300 RLUSD per week, topped up weekly; mandate valid 3 months, one account for its lifetime.
**Template sketch:** Dana 2 · Nova 1 · S 1 · **Q2**. Nova + S = in-policy spend. Dana alone = anything (sweep, close). S alone or Nova alone can't move funds.

**Flow**
1. Dana signs a shopping mandate: categories, merchant allowlist, per-tx cap 80, per-day cap 150, per-week budget 300.
2. Open: SignerList installed, service RegularKey removed (master disabled at pre-create), first 300 RLUSD funded.
3. Nova finds an item and builds a payment. The co-signer checks caps over rolling windows computed from the account's ledger history, plus the allowlist and category. It signs, and Nova + S submit.
4. Paying x402 APIs: Nova builds a multisigned (Nova + S) `Payment` and pays the merchant through the settlement adapter's `prepaid` scheme — the agent submits and the merchant verifies the validated transaction on-ledger, with the co-signer's W7 binding the co-signature to the merchant's x402 challenge. See [x402-purchase.md](../demo/x402-purchase.md).
5. Merchant refunds simply arrive in the account.
6. Each Monday Dana's top-up arrives (an incoming payment, which needs no quorum).
7. At mandate end, Dana alone signs the close: sweep to herself, then `AccountDelete`.

**Stresses:** high transaction frequency; **stateful policy** (rolling counters, which must be derived deterministically from ledger history so decisions can be replayed); x402 payments from a multisig account; no counterparty protection by design.
**Verdict:** ✅. Needs E2 (merchant category attestations) and E12 (stateful policy counters). x402 payments use the settlement adapter's `prepaid` scheme (the same path as [B1](../demo/b1-procurement.md)).

### R3 · High-value second-hand purchase from a private seller

**Actors:** buyer P, private seller C, arbiter A, co-signer S, carrier-tracking attester.
**Amounts / time:** 1,800 RLUSD camera; ship within 3 days; inspection window 48 h after delivery.
**Template sketch:** hotel weights (P2 · C2 · A3 · S1 · Q5).

**Flow**
1. Open with the buyer's funds. Pre-signed defaults: **refund** if there's no "shipped" attestation by `shipBy`, and **release** at `delivered + 48 h` if no dispute.
2. Seller ships and registers the tracking number. The tracking attester signs `shipped` and later `delivered(at, postcodeHash)`.
3. The `delivered` attestation **anchors the inspection timer**: an event-anchored timer rather than a fixed date.
4. Happy path: the buyer accepts (P + C + S) or stays silent (release default).
5. Dispute ("lens scratched"): bond + Credential locks the release default. The arbiter can rule **conditionally**: "refund after the item is returned", which completes only on a `delivered-back` attestation.

**Stresses:** individuals without KYB (higher risk, so the template should cap the amount); event-anchored timers; **conditional rulings** (a ruling whose execution waits on an attestation); return logistics.
**Verdict:** ✅ with E2. Conditional rulings fit as "ruling + pre-signed execution completed by S on the attestation", which reuses the default pattern.

### R4 · Home renovation with milestones

**Actors:** homeowner P, contractor C, licensed inspector (attester), arbiter A, co-signer S.
**Amounts / time:** 36,000 RLUSD; 3 milestones (demolition 8k, rough-in 12k, finish 12k) + 4k retainage held for 30 days after final inspection; 3 months.
**Template sketch:** hotel weights. The inspector is an **attester, not a signer**: making it a signer creates collusion paths (contractor + inspector + …).

**Flow**
1. Open: one **engagement per tranche** (4 accounts funded together in one multi-account open Batch), or one account with partial releases (see E1).
2. Milestone k: the contractor requests payment, and the inspector signs `milestone-k passed`. Release = P + C + S, or a pre-signed milestone default completed by S at `certified + 7 days` if the homeowner is silent.
3. **Change order** (homeowner adds an island, +3,000 RLUSD): a new mandate version signed by P and C. An amendment Batch funds the difference, consumes the superseded tickets, creates new ones and re-signs the affected defaults (E3).
4. Retainage released 30 days after the final certificate unless a defect claim is open.
5. Disputes go to the arbiter with the inspector's report as evidence.

**Stresses:** non-closing releases; **amendments mid-deal**; a third-party verifier; partial defaults don't drain the account, so the hotel's **exact-balance dispute lock doesn't apply** to them (only the co-signer's withheld signature protects them).
**Verdict:** ⚠️ needs **E1** (tranches) and **E3** (amendments). One engagement per tranche is the recommended shape: it keeps every hotel property per tranche.

### R5 · Rental security deposit

**Actors:** tenant P, landlord C, primary arbiter A1, backup arbiter A2, co-signer S.
**Amounts / time:** 2,400 RLUSD; 12-month lease; 14-day settlement window after move-out.
**Template sketch:** **P3 · C3 · A1 4 · A2 2 · S2 · Q7** (the backup-arbiter scheme from E4).

**Flow**
1. Open at lease signing. The default direction is the **reverse of the hotel**: a pre-signed **full refund to the tenant** at `moveOut + 14 days`.
2. To deduct, the landlord files a claim Credential + claim bond before the window ends. The extra deposit locks the refund default on-ledger, just as the dispute bond does in the hotel case.
3. Agreed deductions: P + C + S. Contested: A1 + either party.
4. If A1 misses its SLA or has lost accreditation during the year: A2 + one party + S (S checks that escalation conditions hold).
5. If network fees have drifted since open, the defaults are re-signed before their window (E4).

**Stresses:** **12-month liveness**: pre-signed fees, arbiter continuity, parties changing keys (fine: SignerList entries are accounts, which can rotate their own keys); a default that favors the payer; **deposit-protection law** (some jurisdictions require deposits in segregated, protected or interest-bearing schemes).
**Verdict:** ⚠️ needs **E4** (backup arbiter, default refresh) and a jurisdiction check, possibly **E11** (a licensed deposit scheme operating the S or A slot).

### R6 · Refundable pre-order deposit

**Actors:** buyer P, dealer/maker C, arbiter A, co-signer S; dealer's production-status attestations.
**Amounts / time:** 2,000 RLUSD deposit on a 20,000 custom order; delivery promised in 10 weeks with 2 weeks' grace.
**Template sketch:** hotel weights.

**Flow**
1. Open. Pre-signed defaults: **refund** at `deliveryBy + grace` if there's no `delivered` attestation.
2. The forfeiture rules live in policy: before the `production-started` attestation the buyer can cancel for a full refund (P + C + S, or P + A if the dealer stalls); after it, cancelling forfeits 50% (a split per the policy).
3. On delivery the deposit is applied: release to the dealer (P + C + S). The remaining 18k may be paid outside the engagement.
4. A price change before delivery is an amendment (E3).

**Stresses:** asymmetric, state-dependent forfeiture written as policy; event-anchored state (`production-started`); a hybrid deal where only the deposit is in the engagement.
**Verdict:** ✅ with E2. E3 only if prices can change.

### R7 · Group trip kitty

**Actors:** 6 friends. No counterparty, arbiter or service.
**Amounts / time:** contributions of 150–400 RLUSD each; 4 weeks.
**Template sketch:** 6 × weight 1 · **Q4**. An optional S slot could enforce per-spend caps.

**Flow**
1. Open by the organizer. Members contribute over time (incoming payments).
2. Spends: any 4 members sign (Cosign would make collection easy; in Stage 0 it's off-ledger).
3. Close: leftover split **in proportion to contributions**, computed from ledger history. The payouts (6) + `TrustSet` + `AccountDelete` = **8 inner transactions, exactly the Batch limit**.

**Stresses:** N principals; Batch limits (a 7th member breaks the one-Batch close); a member dropping out can't be removed without quorum.
**Verdict:** ✅ up to 6 members in a single close. Larger groups need **E7** (multi-step close).

---

## 3. Business (B2B)

### B1 · Enterprise procurement or treasury agent

**Actors:** company treasury (owner), procurement agent, co-signer S, approved vendors (payees), named human approvers.
**Amounts / time:** 50,000 RLUSD quarterly budget per agent mandate (e.g. "Q4 cloud & data spend").
**Template sketch:** Treasury 2 · Agent 1 · S 1 · **Q2**. Tiers aren't expressible in weights, because weights don't depend on amount. So **S enforces tiers**: spends under 1,000 auto-approve; above that they need a signed approval attestation from a named approver (controller or CFO key).

**Flow**
1. Treasury opens a budget account per mandate. Vendors must hold `KYB_VERIFIED` Credentials and be on the allowlist.
2. The agent receives an invoice (attestation: vendor-signed, PO-matched) and builds the payment. S checks the vendor, the PO match, the caps, and an approval attestation if the amount is over the threshold.
3. SaaS/API purchases pay x402 merchants through the settlement adapter's `prepaid` scheme, with the co-signer's W7 binding ([x402-purchase.md](../demo/x402-purchase.md)).
4. Month end: the indexer exports the decision log + payments to the ERP. Each account is effectively a **cost-center budget with a ledger-enforced ceiling**.
5. Quarter end: treasury sweeps and closes.

**Stresses:** internal approval chains: **XRPL multisig doesn't nest**, so the company's own approval hierarchy can't sit behind one signer entry. Approvers become attestation signers to S (E10). Also audit and ERP integration, and vendor identity.
**Verdict:** ✅ the lead product; built and live on Testnet. Full walkthrough: [b1-procurement.md](../demo/b1-procurement.md). Needs E2, **E10**, E12.

### B2 · Cross-border agency contract with milestones

**Actors:** client P (pays in RLUSD), agency C (wants a EUR stablecoin), arbiter A, co-signer S.
**Amounts / time:** 40,000 RLUSD across 3 milestones (10k / 15k / 15k); 4 months; 10-day acceptance window per milestone.
**Template sketch:** hotel weights; one engagement per milestone (E1).

**Flow**
1. Open three tranche engagements in one Batch.
2. Agency delivers milestone k with an invoice attestation. The client accepts (P + C + S) or is silent (release default at `delivered + 10 days`).
3. **FX at payout:** the release is a cross-currency `Payment` (RLUSD → EUR stablecoin via the DEX/AMM) with `SendMax` = the tranche's whole RLUSD balance and `DeliverMin` set by policy (slippage cap).
4. Disputes go to the arbiter, with deliverables as evidence.

**Stresses:** **draining exactly to zero across currencies**. A cross-currency payment may not spend all of `SendMax`, and any dust left breaks the trust-line removal and the close. Pre-signed defaults also can't fix an exchange rate weeks ahead.
**Verdict:** ⚠️ needs **E1**, **E5** (FX payouts) and possibly **E9** (residual sweep).

### B3 · Trade finance light (importer prepays exporter)

**Actors:** importer P, exporter C, arbiter A, co-signer S, attesters: eBL platform (bill of lading) and inspection agency.
**Amounts / time:** 250,000 RLUSD; 2 shipments; 90-day validity.
**Template sketch:** hotel weights. This is a **letter-of-credit semantic**: the importer pre-signs, at open, a release **against compliant documents**. That's the pre-signed default pattern, triggered by documents instead of a timer.

**Flow**
1. Open with two tranche engagements (one per shipment, E1). Pre-signed per tranche: **release** on compliant documents, **refund** at expiry with no compliant documents.
2. The exporter ships. The eBL platform attests the bill of lading, and the inspection agency attests a quality/quantity certificate.
3. S examines the documents against the mandate (goods, quantity, ports, dates). If compliant, it completes the release, **even if the importer objects**, as with an LC.
4. Quality issues on arrival go to the arbiter, with the inspection report.
5. Expiry with no compliant documents: S completes the refund.

**Stresses:** the largest amounts; **S as document examiner carries bank-like trust**; multiple independent attesters and an attester registry; partial shipments.
**Verdict:** ⚠️ structurally fits via document-triggered defaults. Needs **E1**, **E2** and probably **E11**: a regulated bank or trade-finance provider operating the S slot. A strong case for "the template lets a licensed party take a role".

### B4 · Agent buys a month of compute/data with an SLA

**Actors:** buyer agent P, provider agent C, arbiter A, co-signer S, independent uptime monitor (attester).
**Amounts / time:** 3,000 RLUSD commitment for 30 days; overage paid per call via x402 `exact`.
**Template sketch:** hotel weights. *Why an arbiter for a deterministic SLA?* Pre-signed outcomes must stay **one signature short of quorum** (V5), so P + C < Q. Liveness without the service then needs a party that, together with P or C, reaches quorum. That's an arbiter.

**Flow**
1. Open. Pre-sign an **outcome ladder** (E6), each rung a close on its own Tickets:

   | Measured uptime | To provider | Refund to buyer |
   |---|---|---|
   | ≥ 99.9% | 100% | 0% |
   | ≥ 99.0% | 90% | 10% |
   | ≥ 95.0% | 75% | 25% |
   | < 95.0% | 50% | 50% |

2. During the month: per-call usage beyond the commitment via standard x402.
3. Month end: the monitor attests uptime (e.g. 99.4%). S completes **exactly the matching rung**, and its policy refuses all others.
4. Disputed measurement goes to the arbiter.

**Stresses:** computed outcomes (a formula can't be pre-signed, only discretized); ticket cost (4 rungs × 5 Tickets ≈ 4 XRP reserve); combining the engagement with plain x402.
**Verdict:** ⚠️ needs **E6** (outcome ladder), which is a general pattern. Exact formulas wait for later stages (Smart Escrows / XLS-101).

### B5 · Collateral bond on an agent marketplace

**Actors:** provider agent (posts the bond), marketplace M, arbiter A, co-signer S; harmed buyers as claimants (not signers).
**Amounts / time:** 5,000 RLUSD bond for a 90-day listing term; top-ups allowed.
**Template sketch:** Provider 2 · M 2 · A 3 · S 1 · Q5.

**Flow**
1. Open: the provider funds the bond. The marketplace shows the bond size as a trust signal.
2. A buyer files a claim. A rules, and A + M (= 5) pay the claimant from the bond: a **non-closing** payout.
3. More claims may follow within the term. The provider may top up.
4. Term end with no open claims: release the **residual** to the provider (pre-signed release completed by S, or P + M + S).

**Stresses:** many claims inside one engagement; the residual amount isn't known at open, so an exact-amount pre-signed release breaks after the first slash. Either re-sign after each slash, or use a **residual sweep** (E9). A sweep, though, would also sweep any deposits made to lock the release, so the bond-lock trick is lost.
**Verdict:** ⚠️ needs **E1** (non-closing payouts) and **E9**. It challenges "one deal = one close", acceptable as "one *term* = one engagement".

### B6 · Multi-agent subcontracting chain

**Actors:** client K, orchestrator agent O, sub-agents S1–S3, arbiter A, co-signer S.
**Amounts / time:** 6,000 RLUSD job; O subcontracts 3 parts (1,500 each); days.
**Template sketch:** parent engagement E0 (K → O) and child engagements E1–E3 (O → Si), each with escrow weights.

**Flow**
1. K opens E0. O opens E1–E3, funded either from O's own float or by a **policy-approved partial release from E0 whose destination is a child engagement account**.
2. Sub-agents deliver. O accepts each child and delivers the assembled result to K.
3. **Atomic tree settlement:** one Batch whose inner transactions come from E0 and E1–E3, each engagement account authorizing via a multisig `BatchSigners` entry. Either the whole tree settles or nothing does.
4. A sub-agent's failure is handled within its child engagement. O carries the risk toward K.

**Stresses:** engagements depending on each other; Batch limits (8 inner transactions and 24 `BatchSigners` cap the tree at about 2–3 children in one atomic settlement); child engagement accounts as allowed destinations.
**Verdict:** ⚠️ needs **E8** (engagement graphs) and **E7** (limits). Small trees can settle atomically today; larger ones settle level by level.

### B7 · Ad campaign prepaid against verified delivery

**Actors:** advertiser P, publisher or agency C, measurement vendor (attester), arbiter A, co-signer S.
**Amounts / time:** 50,000 RLUSD over 5 weeks at a fixed CPM; invalid-traffic deductions; unspent budget refunded.
**Template sketch:** one engagement **per flight week** (E1), escrow weights, each with an outcome ladder (E6) over delivered-impression bands.

**Flow**
1. Open 5 weekly engagements (10k each).
2. Weekly: the measurement vendor attests valid impressions. S completes the matching band (e.g. 80–90% delivered → 85% paid, the rest refunded).
3. Invalid-traffic disputes go to the arbiter, with the vendor's raw reports as evidence.
4. Underdelivery in one week is refunded per week. There's no carry-over unless a mandate amendment adds it (E3).

**Stresses:** recurring **variable** payouts where the payee is protected. That's the hardest shape: true pay-per-impression is a formula, and bands only approximate it.
**Verdict:** ⚠️ hard. It works with E1 + E6 + E2 at band precision. A more realistic near-term alternative is the **payer-side B1 model** (the advertiser's agent pays invoices within policy), which gives up payee protection.

### B8 · Digital asset sale with a holdback (domain, website, app)

**Actors:** buyer P, seller C, arbiter A, co-signer S, registry/DNS attester (RDAP/WHOIS check of the registrant change).
**Amounts / time:** 40,000 RLUSD; transfer within 7 days; 10% holdback for 60 days.
**Template sketch:** **two engagements**: main (36k) and holdback (4k), both with escrow weights.

**Flow**
1. Open both. Main: pre-signed release on a `registrant = buyer` attestation, and a refund if there's no transfer by day 7. Holdback: pre-signed release at day 60 unless there's a claim.
2. The seller initiates the transfer. The registry attester confirms it, and S completes the main release.
3. Undisclosed issues within 60 days (e.g. domain blacklisted): a claim locks the holdback release, and the arbiter rules.

**Stresses:** proof of transfer from off the ledger; two-stage release. It shows the **"one engagement per tranche"** pattern being cleaner than partial releases.
**Verdict:** ✅ with E2. This is the core market of classic escrow services, and the closest to product-market fit after B1.

---

## 4. Boundary cases (where engagements are the wrong tool)

### X1 · Concert ticket pre-sale (thousands of buyers, ~80 RLUSD each)

Each engagement locks ~3–4 XRP of reserves and burns ~0.21 XRP. Across 5,000 buyers that's ~20k XRP locked and ~1k XRP burned. Every buyer also needs an XRPL wallet with RLUSD, and card chargebacks already cover this market. **❌.** A better framing flips it: **one** engagement in which the *organizer* posts a cancellation bond (B5-style) covering refunds. That's one account instead of thousands.

### X2 · All-or-nothing crowdfunding (hundreds of backers)

The 32-signer limit and the 8-payout Batch limit make "refund everyone" impossible in one engagement, and one engagement per backer is X1's problem again. **❌. Native XRPL escrow fits better:** each backer creates a Token Escrow of RLUSD to the project with a crypto-condition and a `CancelAfter` at the deadline. The platform reveals the fulfillment only if the target is met. Otherwise backers cancel and get their funds back. This trusts the platform with the preimage but never with custody.

### X3 · Swapping two on-ledger assets (RLUSD for a tokenized T-bill)

Both legs are on the ledger, so a multi-account `ALLORNOTHING` Batch, or a DEX offer, is already atomic delivery-vs-payment. **❌.** Engagements matter only when one leg is off the ledger, which makes it B8.

### X4 · Real-estate earnest money

Licensed escrow or title agents are mandatory in most jurisdictions. **❌ as an independent service. ⚠️ if a licensed escrow agent operates the A and/or S slot** (E11). That's the same lever as B3 and R5.

---

## 5. Extension register

What the catalog demands beyond the hotel spec, in priority order (by number of cards).

| ID | Extension | Needed by | Proposed approach | Open risk |
|---|---|---|---|---|
| **E2** | **External attestations** ([spec](../spec/attestations.md)) | R2, R3, R4, R6, B1, B3, B4, B7, B8 | Signed statements `{type, engagementId, claim, observedAt, attester, sig}` from registered attesters (Credential `ATTESTER_<KIND>`). Policy rules reference attestation types. Attestations can **anchor timers** (inspection after `delivered`) and **trigger defaults** (release on compliant documents). | Attester honesty, and an attester registry with accountability. |
| **E1** | **Tranches / partial releases** | R4, B2, B3, B5, B7 | **Default: one engagement per tranche**, opened together in one multi-account Batch. Each tranche keeps every hotel property (exact-balance lock, single close). **Alternative:** non-closing payouts inside one account, for many or variable tranches, which loses the exact-balance lock on non-final payouts. | Batch limit when opening many tranches at once. |
| **E6** | **Computed outcomes (outcome ladder)** | B4, B7 | Pre-sign N discretized outcomes on separate Tickets. S completes only the rung that matches the attested measurement. ~5 Tickets per rung. | Granularity vs. reserve cost. Exact formulas wait for later ledger features. |
| **E3** | **Amendments (change orders)** | R4, R6, B2, B7 | Amendment Batch (P + C + S): new mandate version hash in the memo, funding delta, a no-op on each superseded Ticket to consume it, new `TicketCreate`, re-sign the affected defaults. | Must fit in 8 inner transactions. Superseded defaults must be consumed *in the same Batch*. |
| **E4** | **Long-lived engagements + backup arbiter** | R5, B5, B3 | **Default refresh** before fee drift (re-sign the outcomes on new Tickets, consume the old ones). **Backup arbiter weights:** P3 · C3 · A1 4 · A2 2 · S2 · Q7. A1 + either party settles; the backup needs S (A2 + P + S = 7); A1 + A2 = 6 < 7, so the two arbiters can't collude alone. **Proof:** with A + P ≥ Q, 2P < Q and 2A < Q for *equal* arbiters, a > p and a < p would both have to hold. So two equal-weight arbiter slots always let the arbiters collude, and the backup must be weaker and gated by S. Disclosed winning sets that exclude P: {A1, C}, {A2, C, S}, {A1, A2, S}. | Three-operator collusion ({A1, A2, S}) must be disclosed. Validator rules need extending for the backup slot. |
| **E7** | **Scale limits** | R7, B6, X1, X2 | 32 signers, 8 inner transactions, 24 `BatchSigners`: multi-step close (pre-cleanup Batch, then final close); cost floor of ~3–4 XRP locked and ~0.21 XRP burned per engagement. A minimum deal size per template. | Atomicity is lost across multi-step closes. |
| **E8** | **Engagement graphs** | B6 | Child engagement accounts as policy-allowed destinations. Atomic tree settlement via a multi-account Batch for small trees; level-by-level otherwise. | Partial failure propagation in larger trees. |
| **E9** | **Residual sweep payout** | B2, B5, (R7) | Pay "whatever is left" with `tfPartialPayment` (`Amount` ≥ any possible balance) so the trust line drains to zero. **✅ Verified on testnet (spike T11: residual of 286.96 delivered exactly, close succeeded).** It conflicts with the exact-balance lock, so choose per outcome. | Partial-payment semantics for issued currencies need confirming. Lock trade-off. |
| **E5** | **Cross-currency payouts** | B2 | Path payment from RLUSD to the payee's currency with policy-bounded `DeliverMin`. Combined with E9 so that no RLUSD dust blocks the close. | Liquidity at payout time. Pre-signed FX defaults can't lock a rate. |
| **E10** | **Non-nested approvals** | B1 | XRPL multisig doesn't nest. An organization's internal approval hierarchy goes either into individual SignerList entries (max 32) or, preferred, into **approval attestations** checked by S. | Approver key management at the customer. |
| **E11** | **Regulated operators in role slots** | B3, R5, X4 | Template roles carry `operatedBy: service \| external \| licensed:<type>`. A bank, licensed escrow agent or deposit scheme can operate S and/or A. | Commercial: finding such partners. Legal: who is the escrow holder. |
| **E12** | **Stateful policy** | R2, B1 | Rolling counters (per-day, per-week spend) derived deterministically from ledger history at a pinned ledger index, so decisions remain replayable. | Performance on active accounts. Clear window semantics. |

---

## 6. What to specify in depth next

| Priority | Card | Why |
|---|---|---|
| 1 | **B1 Enterprise procurement agent** | The lead product. Exercises the owner-wallet class, E2, E10, E12 and x402 with multisig. **Built and live on Testnet:** template, policy, co-signer and vectors; demo D1–D11 (11/11); x402 purchase via the settlement adapter, X1–X4 (4/4). Walkthroughs: [b1-procurement.md](../demo/b1-procurement.md), [x402-purchase.md](../demo/x402-purchase.md). |
| 2 | **B8 Domain sale with holdback** *or* **R4 Renovation** | Settles the E1 design ("one engagement per tranche" vs. partial releases) and the attestation format (E2). B8 is smaller and closer to market; R4 adds amendments (E3). |
| 3 | **B3 Trade finance** | The largest amounts and the strongest test of attesters (E2) and licensed operators (E11). |
| 4 | **B4 SLA** | Proves the outcome ladder (E6), a reusable pattern for any measured outcome. |

The **template validator** should be extended alongside: template classes (escrow, owner-wallet, group), the backup-arbiter rules (E4), per-template minimum deal size (E7), and `operatedBy` roles (E11).
