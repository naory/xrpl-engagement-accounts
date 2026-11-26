# Why Engagement Accounts

**Recourse and policy-enforced escrow for AI agent payments on XRPL.**

> XRPL Testnet reference implementation; not for mainnet funds.

## 1. The problem, and the one-paragraph answer

Agent payments work well when fulfillment is instant: an agent calls an API, pays per request over x402, and the exchange is finished. The model breaks once fulfillment is delayed, as with goods that ship, a job that must be delivered and checked, or a supplier that must clear customs. A push payment is final when it settles, so the buyer's agent either pays up front and hopes, or doesn't pay. There is no refund, no partial outcome, no delivery check and no one to appeal to.

An **Engagement Account** is an ordinary XRPL account created for **one deal** and deleted when it ends. Its **master key is disabled**; only a **SignerList** of buyer, seller, an **always-on arbiter** and a **policy co-signer** controls it. The co-signer signs only when the deal's policy passes, fed by signed facts from neutral **attesters** (a carrier, a test suite, a registrar). Every payout needs a quorum that **the XRP Ledger enforces, not our servers**. Close is atomic: one **Batch** pays the parties, removes the trust line and runs **AccountDelete**, returning the reserve. Nobody custodies the funds, and no single party can move them.

## 2. Engagement Accounts vs. other solutions

| | Plain x402 / direct transfer | Native XRPL Escrow alone | Custodial platform escrow | EVM smart-contract escrow | Card rails & chargebacks | **Engagement Account** |
|---|---|---|---|---|---|---|
| **Non-custodial isolation** | Yes, but funds leave immediately | Yes | No: the platform holds pooled funds | Yes, per contract | No: card networks and banks are the intermediaries | **Yes: one account per deal, master key disabled** |
| **Policy gate before release** | None | None: release rests on a time or crypto-condition | Platform's internal rules, off-ledger | Whatever the contract code checks | Issuer risk rules, not agent mandates | **Co-signer checks a versioned policy before it signs** |
| **Dispute recourse** | None: settlement is final | None: no judged outcome | Platform decides | Only if it was coded in | Yes, through slow consumer chargeback cycles | **Bonded dispute, ruled by an accredited arbiter** |
| **Custom smart-contract risk** | None | None | None on-chain; operational and custody risk instead | High: custom code to write, audit and upgrade | None | **None: native XRPL features only** |
| **Variable / delayed settlement** | No | All-or-nothing to one destination | Yes | Yes, if coded | Holds and partial captures, built for card payments | **Yes: exact split built live at close, surplus swept back** |
| **Setup / reserve overhead** | Lowest | Low | Platform overhead plus compliance | Gas plus audit cost per deal shape | Card network and acquirer fees | **1.4 XRP refundable reserve, ~0.2 XRP burned at close** |

**Plain x402 / direct stablecoin transfer.** The right tool for instant micro-payments, and we keep using it there. It settles with finality: no delivery check, no refund, no dispute. If fulfillment can fail after payment, the buyer carries all the risk.

**Native XRPL Escrow alone.** A low-reserve, strong primitive, but all-or-nothing to one destination, and a refund waits for `CancelAfter`. There is no co-signer policy check before release, and a single finish/cancel condition can't express "buyer, seller and policy agree, or an arbiter rules" without handing one holder unilateral control.

**Custodial platform escrow / omnibus wallets.** Holding user funds brings custody, commingling and the regulatory exposure that comes with them. Engagement Accounts isolate each deal in its own ledger account, and the template validator rejects any template where a service-run signer reaches quorum alone. Neither the platform nor any single party can move the money.

**EVM / smart-contract escrows.** Each new deal shape means custom code to write, audit, deploy and upgrade, and every line is attack surface. Engagement Accounts use only native XRPL features (**SignerList multisig, master-key disable, Batch, Credentials, AccountDelete**) with no custom on-chain code. Deal logic lives in declarative templates and versioned policies the co-signer evaluates.

**Traditional card rails and chargebacks.** Card disputes give real recourse, but were built for human consumers: slow cycles, friendly fraud, no programmable agent mandate ("this agent may pay this seller at most this amount"), and no instant stablecoin settlement. Engagement Accounts keep the useful part, a neutral party who can reverse a bad outcome, and make it programmable for agents.

## 3. Architecture and economics (zero-Ticket, live-signing model)

**Nothing is pre-signed, and no Tickets are used.** Every outcome is signed live against the account's current state, including deadline defaults. So the reserve does not grow with deal length or with the number of possible payout shapes:

| Cost item | Amount | Notes |
|---|---|---|
| Reserve locked per deal | **1.4 XRP, flat** | Base reserve + trust line + SignerList. Refunded by AccountDelete at close |
| Pre-funding per account | 2.4 XRP | Reserve plus 1 XRP of headroom |
| Open (one Batch) | **120 drops** | Funds the deal, sets the SignerList, removes the regular key in a single step |
| Close (one Batch) | **~0.2 XRP burned** | Almost all of it is the network's AccountDelete fee |

Figures assume today's network reserves (1 XRP base, 0.2 XRP per owned object), which the network sets and can change. Accounts are pre-created, so the ledger's 256-ledger deletion wait never holds up a short deal.

**Signer weights:** buyer 3, seller 3, arbiter 4, co-signer 2, quorum 7.

| Path | Signers | Weight |
|---|---|---|
| Normal close (confirm, or mutual refund) | buyer + seller + co-signer | 8 |
| Dispute ruling | arbiter + the party the ruling favors | 7 |
| Missed deadline | arbiter + either party, paying out only to the winner as the policy dictates | 7 |
| Co-signer alone, arbiter + co-signer, or any single party | — | ≤ 6, cannot move funds |

**The trust model, stated plainly:**

- **The co-signer is the policy gate.** On normal closes it signs only when the policy passes (payees, amounts, fee, a clean close). It also keeps the deal's timers and issues a signed notice when a default outcome falls due.
- **The arbiter handles exceptions.** It rules on disputes and signs missed-deadline defaults live, after checking the facts against its own validated-ledger read rather than trusting the co-signer. So **arbiter + one party can move funds without the other party or the co-signer**: the same trust boundary as a card network's dispute arbiter, disclosed rather than hidden. Arbiters must hold an accreditation credential and cannot be a party to the deal.
- **Liveness, disclosed.** The arbiter is on the critical path for any timed-out deal, and a default also needs one party online to sign. The buyer can confirm receipt and close early at any time.

**Options already in the design, not built yet:**

- **Cure windows:** an optional grace period agreed at open, during which the co-signer warns the side that missed a deadline before the default falls due. Documented as a future template option, not in current templates.
- **What gets simpler later, XLS-68 sponsored fees and reserves:** an XRPL amendment that would let the service carry every XRP cost so parties only handle the stablecoin. **Not live on mainnet today**; on our roadmap, pending activation.

## 4. Use cases

All six share one engine: a per-deal account, a co-signer policy gate, neutral attesters, timers with default outcomes, and an arbiter. Settlement is in RLUSD.

### Use Case 1: Marketplace escrowed purchase (`marketplace-escrow@1`), flagship demo

**Status: verified on XRPL Testnet, 23/23. Option (a) is the signer rule.** A missed deadline is signed live by the arbiter and either party, and the payout still goes to the winner. This is the deal the Clip 3 script walks through.

- **Deal shape:** A buyer's agent buys an item from a seller. The full price is locked in the engagement account at open, under a signed buyer mandate that names the seller and a maximum amount.
- **Roles and attester:** buyer agent, seller, a **carrier** named at open as the shipment attester, the policy co-signer, and an accredited arbiter.
- **Deadlines and outcomes:**
  - *Confirm:* the buyer confirms receipt. The seller is paid the price minus the service fee, and any surplus goes back to the buyer. Buyer, seller and co-signer sign together.
  - *`shipBy` missed:* there is no receipted shipment, so the whole balance is swept back to the buyer. The arbiter signs that default with either party.
  - *`inspectBy` passes with no dispute:* the seller is paid the price minus the fee, and any surplus is swept back to the buyer. The arbiter signs that default with either party.
  - *Dispute:* the buyer posts a dispute credential and a **bond** before `inspectBy`. The release default is not proposed, the arbiter rules, and the bond goes to the winner.
- **Why an Engagement Account wins:** the buyer gets delivery-based recourse without trusting the seller or the platform with custody. If the buyer goes quiet after a shipment, the seller is still paid: the arbiter and either party sign a live release, and the payout still goes to the seller. The payout is built **live from the actual balance**, so stray extra funds are swept back to the buyer instead of breaking the close.

### Use Case 2: SLA-backed agent jobs (compute, data, audits, research)

**Status: roadmap template.**

- **Deal shape:** A buyer's agent hires a specialist agent or vendor for a batch job, such as a dataset build, a model evaluation, a code audit or a research report.
- **Roles and attester:** buyer agent, provider, co-signer, arbiter. The attester is a **verifier** that signs an artifact hash, an automated test or eval-suite result, or an acceptance check.
- **Deadlines and outcomes:** a delivery deadline, then a verification window. Missed delivery refunds the buyer. Passing verification, or a lapsed window, releases payment to the provider. A disputed result goes to the arbiter.
- **Why an Engagement Account wins:** completion is objectively checkable, so most deals settle with no human involved; the mandate caps what the agent commits, and the provider sees the funds locked before work starts.

### Use Case 3: B2B cross-border trade and supplier invoices (a programmable letter of credit)

**Status: roadmap template.**

- **Deal shape:** A procurement agent locks RLUSD against a supplier order or invoice.
- **Roles and attester:** importer, exporter, co-signer, arbiter. Attesters are a **carrier** (bill of lading), **customs clearance**, or an **inspection firm**.
- **Deadlines and outcomes:** ship-by and document deadlines. Funds release when the required documents are attested. A missed shipment refunds the importer, and discrepancies go to the arbiter.
- **Why an Engagement Account wins:** carriers, customs and inspection firms are established neutral witnesses, deal sizes make the per-deal cost negligible, and settlement is in RLUSD on XRPL. *Boundary:* depending on jurisdiction, a licensed operator may need to run the arbiter or co-signer role; the design plans for externally operated role slots.

### Use Case 4: Metered cloud, GPU and API commitments with SLA rebates

**Status: roadmap template, made practical by live signing.**

- **Deal shape:** An agent pre-funds a monthly compute, GPU or API commitment.
- **Roles and attester:** buyer agent, provider, co-signer, arbiter. Independent **metering and uptime monitors** act as attesters.
- **Deadlines and outcomes:** at period end, a live `close.split` pays the provider for exact metered usage minus any attested downtime credits, and sweeps the unused balance back to the buyer. Disputed measurements go to the arbiter.
- **Why an Engagement Account wins:** the final split isn't known at open, which made this shape awkward to pre-sign. With live signing, the exact amount is computed and policy-checked at close: the buyer never pays for unused capacity, and the provider's committed revenue is locked.

### Use Case 5: Software bounties, security audits and contractor milestones

**Status: roadmap template.**

- **Deal shape:** Funding a dev shop, an auditor or a coding agent against defined deliverables.
- **Roles and attester:** client, contractor, co-signer, and a **technical arbiter**. Evidence comes from **Git and CI**: a merged pull request, a passing pipeline, or a signed audit report.
- **Deadlines and outcomes:** a delivery deadline plus an acceptance window. Release can be for the exact amount. Staged milestones use one engagement per stage, opened together, because each account has a single signer quorum.
- **Why an Engagement Account wins:** trust friction is high on both sides, the evidence is already machine-readable, and a technical arbiter is a natural fit for the role.

### Use Case 6: Digital asset, domain and enterprise license transfers

**Status: roadmap template.**

- **Deal shape:** A high-value transfer, such as a domain, a dataset, a code repository or IP, or an enterprise license, where the handover takes hours or days.
- **Roles and attester:** buyer, seller, co-signer, arbiter. **Registrar, WHOIS or registry records, or an organization-transfer record** serve as proof.
- **Deadlines and outcomes:** a transfer-by deadline. A missed transfer refunds the buyer, and a confirmed transfer releases payment. An optional holdback runs as a second engagement opened at the same time.
- **Why an Engagement Account wins:** fraud risk is high and proof of transfer is clean and external; neither side goes first on trust, and a contested transfer has a clear route to the arbiter.

## 5. When not to use an Engagement Account

- **Sub-$20 micro-payments and instant, atomic API calls.** Plain x402 is simpler and cheaper. A refundable reserve and a ~0.2 XRP close fee only make sense when the deal is large enough and fulfillment is delayed.
- **Subjective, in-person services with no neutral witness.** If no attester can say whether the service happened, every deadline becomes one side's word against the other's. Timeouts can't be automated cleanly, and every case ends up with the arbiter.
- **On-ledger swaps or mass-market consumer sales.** An atomic Batch or DEX offer already handles the first; existing card protections serve thousands of small buyers better than per-buyer accounts.

## 6. See it, then pilot it

The demo package is a **three-clip walkthrough on XRPL Testnet**:

1. **Capped agent payment via t54:** an owner-wallet agent pays an x402 merchant inside a daily cap. The co-signer signs first, then the facilitator verifies and settles.
2. **Rogue agent refused:** an over-cap payment and a payment redirected away from the invoiced merchant are both refused by policy, and the facilitator is never called.
3. **Marketplace purchase dispute:** a bonded dispute blocks automatic release, the arbiter rules a refund, and the account settles and deletes itself.

Engagement-account payments also work with Machine Payments Protocol merchants (verified in process). The same co-signer binds each payment to the merchant's challenge.

**We're looking for pilot partners**: payment platforms, x402 facilitators and B2B or agentic-commerce teams that want chargeback-style protection on stablecoin payments without taking custody. Bring a deal shape with delayed fulfillment and a neutral attester, and we'll map it onto a Testnet template with you.

*XRPL Testnet reference implementation; not for mainnet funds. The co-signer and arbiter verifier are reference implementations, not hosted production services.*
