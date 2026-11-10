# On-Chain Cosigner (`Cosign` amendment): notes and implications

> Research notes, October 9, 2026. Sources: XRPL-Standards Discussion #589 (draft spec) and the rippled `develop` branch @ `3857ce2`.

## 1. What it is

**On-Chain Cosigner** moves multi-signature *collection* onto the ledger. Today, multisig coordination happens off-chain. Someone builds a transaction, passes it around, gathers signatures, and submits. That process is slow and error-prone. A lapsed `LastLedgerSequence` forces a full restart, and the coordinator is a single point of failure. The proposal fixes this by storing the unsigned transaction on-ledger and letting each signer add a signature independently.

| | |
|---|---|
| Spec | XRPL-Standards Discussion #589, *Amendment XLS: On-Chain Cosigner*. Authors Shawn Xie, Zhiyuan Wang, Chenna Keshava B S. Created 2026-07-14, posted 2026-07-23. **Draft, XLS number TBD.** The draft says it depends on XLS-49 (Multiple Signer Lists). |
| Amendment | `Cosign` in rippled `develop` (`Supported::No`, `DefaultNo`): **work in progress, not votable yet.** |
| Implemented so far | `TransactionProposalCreate` (tx type 95) and the `TransactionProposal` ledger entry (0x0091). `TransactionProposalSign` and `TransactionProposalCancel` are referenced as TODO and don't exist in code yet. |

### Building blocks

- **`TransactionProposal` ledger entry**: holds the unsigned transaction (`ProposedTransaction`), an `Owner`, and an `Expiration`. Keyed by *(target account, ticket/sequence)*, so there is at most one live proposal per ticket.
- **`TransactionProposalCreate`**: posts the unsigned transaction plus an expiration. The proposer owns the object and pays its reserve.
- **`TransactionProposalSign`** (spec): a signer adds one signature for one account the payload needs (`SigningFor`). The signature is validated and written straight into the payload's own fields: `Signers`, `BatchSigners`, `SponsorSignature`, or `CounterpartySignature`.
- **`TransactionProposalCancel`** (spec): the proposer can cancel while the proposal is open. Anyone can clean up a terminal one.
- **No execute step.** Once quorum and any auxiliary signatures are present, the stored transaction is an ordinary fully signed transaction that **anyone can copy and submit**. Applying it consumes the ticket, which deletes the proposal and refunds its reserve.

### Rules worth knowing

- **Expiration** is a "not after" bound only. A proposal becomes terminal at `Expiration` or once the payload's `LastLedgerSequence` passes. There is **no "not before"**.
- **Signer weights** are read from the live SignerList at signing and at submission. Changing the SignerList changes whether a proposal is complete.
- **Collected signatures are not revocable.** Cancelling the proposal object doesn't invalidate signatures already gathered. A completed payload can still be submitted until its ticket is consumed or `LastLedgerSequence` passes (draft §13.4).
- **Reserve**: 5 owner-reserve increments for an ordinary transaction (≈1 XRP at 0.2 XRP/increment), 10 for a Batch (≈2 XRP). The code also attaches a Sponsor to the proposal entry (`addSponsorToLedgerEntry`), so XLS-68 sponsorship applies.
- **Batch is the main motivating case**, including multi-account Batches: the outer account signs via `Signers`, other accounts via `BatchSigners`, each single- or multi-sign, collected in any order. Up to 8 inner transactions and 24 BatchSigners.
- **Sponsor co-signatures** (XLS-68) are collected the same way (`SponsorSignature`).
- **The implementation is stricter than the draft.** rippled `develop`:
  - requires the proposed transaction to be **ticket-based** (`TicketSequence` set, `Sequence` = 0, else `temSEQ_AND_TICKET`), where the draft only recommends tickets;
  - restricts the **proposer** to the target account, one of its signers, or an authorized delegate (V1 anti-spam/squatting scope), where the draft says anyone can propose;
  - re-runs the proposed transaction's own preflight at create time, so obviously invalid proposals are rejected up front.
- **Privacy**: payloads and collected signatures are public ledger state. The draft has no privacy section.

## 2. Implications for engagement accounts

### 2.1 Signature coordination moves on-ledger

Today, each engagement needs off-ledger coordination: build the payout or close Batch, gather Dana's, the merchant's and the arbiter's signatures, and submit before `LastLedgerSequence` lapses. With Cosign, the service *proposes* and each party *signs on its own time*: Dana from her wallet, the merchant from its backend, the arbiter from its service. Nobody has to be online at the same moment, and there's no coordinator who can stall or lose data.

The **`xrpl-multi-sign-manager`** project changes from a signature *coordinator* into a **UI and notifier over on-ledger proposals**. **`xrpl-monitor`** watches `TransactionProposal` objects for engagement accounts.

### 2.2 Outcome options: mutually exclusive proposals

This is the most interesting pattern. Because proposals are keyed by ticket, an engagement can hold **several competing outcome proposals at once**, one per ticket:

| Ticket | Proposal (each an `ALLORNOTHING` Batch ending in `AccountDelete`) |
|---|---|
| T1 | **Release**: 100% to merchant → remove trust line → delete account |
| T2 | **Refund**: 100% to Dana → remove trust line → delete account |
| T3 | **Split** (proposed after a ruling): x% / y% → … → delete account |

Since every outcome ends with **`AccountDelete`**, the first one that reaches quorum and is submitted **makes all the others impossible to execute**: the account and its remaining tickets no longer exist. Mutually exclusive outcomes are enforced by the ledger, without smart contracts.

- **Happy path**: Dana and the merchant sign T1.
- **Dispute**: the arbiter rules by **signing the winning proposal** (T2 or a new T3) with the winning party.
- **Rulings become on-ledger events**: which proposal the arbiter signed, and when. The arbiter's reputation can be computed directly from ledger history.

### 2.3 Pre-signed defaults no longer need custody

The current design (§6 of the README) keeps pre-signed default transactions in the service's custody, because XRPL can't express "not before time T". Cosign helps with the custody half but not the time half:

- Defaults can live **on-ledger** as proposals instead of in our database. That's auditable, can't be lost, and anyone can submit once complete.
- Because `Expiration` is only "not after", a **completed** default is submittable immediately. The pattern becomes **"all but the last signature"**: parties pre-sign the default proposal up to quorum − 1, and a **time-gated final signer** (the arbiter, or a dedicated timer/oracle signer below quorum on its own) adds the last signature only after T. The time condition is still trust-based, but the trust is narrowed to *when* one signature is added, and everything else is visible on-ledger.
- Real ledger-enforced time conditions still need **Token Escrow** (`FinishAfter`/`CancelAfter`) or, later, **Smart Escrows** (XLS-100).

### 2.4 The policy co-signer becomes an on-ledger participant

The co-signer watches proposals on accounts where it's a signer, evaluates policy, and either submits `TransactionProposalSign` or doesn't. Its decisions become **publicly observable** (signed / not signed, with timestamps). Reason codes still need a side channel, for example a memo or our indexer.

### 2.5 Agents and x402

- **Nova** (the agent) can be a proposer, since a signer on the engagement account may propose. It drafts outcome proposals instead of building and coordinating signatures itself.
- In the x402 `engagement` scheme, the facilitator can return **proposal IDs** (the ledger keys of T1/T2) for the merchant and principal to sign, instead of collecting signatures over HTTP.

### 2.6 New risks and design rules

| Risk | Rule |
|---|---|
| **Signatures can't be revoked**: once Dana signs "release", she can't take it back if a problem shows up later. | Parties sign an outcome proposal **only when they intend it to happen now**. The exception is deliberate defaults signed to quorum − 1. Set tight `Expiration` and `LastLedgerSequence`. |
| **A SignerList change flips completeness**, because weights are read live. | Engagement SignerLists are **frozen after open** by template. Changing the signer list itself requires full quorum. |
| **Proposal squatting / spam** | Mostly handled by V1's proposer restriction (target, signer or delegate only). |
| **Reserve load**: ≈1 XRP per proposal, ≈2 XRP per Batch proposal, × several outcome options | The proposer pays the reserve and gets it back when the proposal executes. The losing outcome proposals become terminal once the account is deleted. Their reserve stays with the proposer until someone cleans them up (`TransactionProposalCancel`, not implemented yet). Budget for it, or sponsor it via XLS-68. |
| **Proposals blocking `AccountDelete`** | A proposal is stored in the **proposer's** owner directory, and `TransactionProposal` is *not* in `AccountDelete`'s list of auto-deletable objects (develop). If the engagement account proposed against itself, its own proposals would be obligations that **block its deletion**. **Rule: proposals are always created by a signer account (the service or Nova), never by the engagement account.** The losing proposals then sit on the proposer, not on the account being deleted. |
| **Public payloads**: amounts, destinations and pending outcomes are visible before settlement | Acceptable. Settlement is public anyway. Keep personal data off-ledger (hashes only). |
| **Ticket requirement** (implementation) + **Tickets not sponsorable in XLS-68 v1** | Each outcome ticket needs ~0.2 XRP of unsponsored reserve in the engagement account. Budget for it until sponsorship covers Tickets. |

## 3. Evolution path

| Stage | Ledger features | What the service does | What the ledger does |
|---|---|---|---|
| **0: Today** | Multisig, Tickets, Credentials, Token Escrow, **Batch** | Coordinates signatures off-ledger. Holds pre-signed defaults. Funds reserves. Runs co-signer, arbiter, indexer. | Enforces quorum. Atomic open/settle/close via Batch. |
| **1: + Sponsor (XLS-68)** | Sponsored accounts, reserves, fees | Carries all XRP costs; users touch only RLUSD. Still coordinates signatures. | Returns reserves to the sponsor on delete. |
| **2: + Cosign** | On-ledger proposals | **Proposes outcome options and notifies parties.** Final time-gated signer. Co-signer and arbiter sign on-ledger. No off-ledger signature custody. | Stores proposals and collects signatures. Mutually exclusive outcomes via ticket + `AccountDelete`. Public ruling history. |
| **3: + Smart Escrows (XLS-100)** | WASM release predicates | Templates + predicates. The arbiter handles only real disputes. | Enforces time/"not before", review-present, and dispute-flag conditions. |
| **4: + Smart contracts (XLS-101)** | General contracts | Thin layer: templates, policy, arbitration, indexing. | Could host the whole engagement logic in one contract. Per-deal accounts may become unnecessary. |

**Where this ends up:** the "service" shrinks to *templates + policy co-signer + arbiter + reserve sponsor + indexer*. Stage 2 is the big step. It removes the last piece of off-ledger state that matters (who holds which signatures) and turns the engagement into an object anyone can inspect: the account, its signer list, its competing outcome proposals, and the history of who signed what.

## 4. Open questions

- Will `AccountDelete` ever auto-remove `TransactionProposal` entries? Today (develop) they aren't in its deletable list, so a self-owned proposal blocks deletion (hence the "signer proposes" rule above). Cosign is unfinished, so recheck this.
- Will the XLS-49 (Multiple Signer Lists) dependency ship first? Per-transaction-type signer lists would also let a template say "Payments need 2-of-3, `AccountDelete` needs everyone".
- Will `TransactionProposalSign` allow attaching a memo or reason code? That would put co-signer and arbiter rationale on-ledger.
- Draft §12 open questions: a first-class revoke-signature operation, which would remove the biggest risk for our use case, and recurring/standing orders.

## Sources

- XRPL-Standards Discussion #589, On-Chain Cosigner: https://github.com/XRPLF/XRPL-Standards/discussions/589
- rippled `TransactionProposalCreate.cpp` (develop): https://github.com/XRPLF/rippled/blob/develop/src/libxrpl/tx/transactors/proposal/TransactionProposalCreate.cpp
- rippled `ProposalHelpers.h` (develop): https://github.com/XRPLF/rippled/blob/develop/include/xrpl/ledger/helpers/ProposalHelpers.h
- U.Today coverage: https://u.today/xrp-ledger-eyes-major-multisig-upgrade-targeting-institutional-custody
- CoinTurk coverage: https://en.coin-turk.com/xrp-ledger-eyes-upgrade-for-fully-on-chain-multisig-coordination/
