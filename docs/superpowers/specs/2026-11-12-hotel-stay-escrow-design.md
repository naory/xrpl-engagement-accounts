# Hotel stay escrow — end to end through the co-signer (design)

Status: design, 2026-11-12. Builds on `docs/use-cases/hotel-booking.md` (the "Dana books Lisbon" use case, paths A–D),
`templates/hotel@1.json` and `policies/hotel@1.1.0.json`. This document is the delta: what the hotel flow becomes, and what
must be built to run it for real.

## 1. Intent

The hotel use case is fully designed on paper, but nothing runs it end to end. The web demo's "escrow with arbiter" scenario
claims the hotel template while never calling the co-signer (its checks are hard-coded strings), no code creates the pre-signed
Ticket defaults, nothing advances an engagement's state, and nothing creates the on-ledger dispute Credential.

This work makes the hotel stay real, and widens it to match how a hotel stay actually goes wrong:

- **A security deposit taken at check-in**, like a card hold: the hotel can claim incidentals (minibar, late checkout, damage)
  against it after checkout; the remainder returns to the guest.
- **Complaints from either side, at three moments**: at entry (no room, cancelled reservation, materially different room),
  mid-stay (recorded as they happen), and at the end (deposit claims, overcharges, service failures). **Only the guest opens
  formal disputes** (decided): the hotel's channels are refusing check-in (fraud, mismatched booking, refused disclosed charges)
  and itemized claims against the deposit. A hotel dispute would let it freeze the deposit without itemizing, or reach beyond
  the deposit cap.
- **Serious entry failures end the deal immediately** with a refund — decided by the arbiter, or conceded by the hotel.
- **A backup arbiter** takes over if the primary misses its ruling deadline.

### The governing principle (anti-goal)

**No side may quietly win by doing nothing.** Every waiting point has a deadline, and silence costs the silent party its own
position, never the other side's. The wronged party only ever has to *raise a flag before a deadline*. A path where inaction
moves money toward the inactive party, against the other side's raised flag, is a failure even if every test passes.

## 2. Goals, non-goals, anti-goals

**Goals**
1. A new hotel template + policy (`settlement-vault/hotel@2`, `pol_hotel@2.0.0`) covering booking, confirmation, check-in with
   deposit, entry disputes with early termination, mid-stay issue records, checkout with deposit claims, all silence rules,
   default rulings, and a backup arbiter.
2. The co-signer runs the whole lifecycle: derives engagement state, stores pre-signed defaults, completes them when due, and
   refuses every out-of-order or out-of-policy signature.
3. **Live Testnet script** (`npm run demo:hotel`) exercising every path and every refusal, with numbered checks in the style of
   `packages/cosigner/demo/b1-testnet.ts`.
4. **Web demo scenario** "Hotel stay" driven through the real `CosignerService`, in both simulated and live modes.
5. Conformance vectors for the new policy.

**Non-goals** (this build)
- A real arbiter service, evidence API or AI/human queue. Arbiters are scripted parties (a key that signs a fixed ruling).
- The indexer / reputation records.
- Persistent engagement store or a production "keeper" daemon. In-memory + an explicit tick is enough.
- Mainnet, Privy custody for parties, XLS-68 sponsored mode, the x402 `engagement` scheme.
- Recovering hotel claims larger than the deposit. Claims are capped at the deposit; anything beyond is off-ledger.

**Anti-goals** (failure even if it "works")
- Any party winning by silence (§1).
- Demo checks that are hard-coded rather than produced by the policy engine and the ledger.
- Giving either arbiter more power than §4 states.
- A default or ruling path that can strand funds permanently with no actor able to unlock them.

## 3. Constraints (from the ledger and the existing code)

- **Exact-balance close.** A close Batch pays out the exact RLUSD balance, removes the trust line, and deletes the account
  (`AccountDelete` last, `ALLORNOTHING`). Any extra RLUSD in the account (deposit, dispute bond) makes a previously signed
  default unexecutable on-ledger. This is a feature: deposits and bonds lock stale defaults.
- **Defaults are single-shot.** A failed `ALLORNOTHING` Batch still consumes its outer Ticket (finding F2). The co-signer must
  verify exact ledger state at a pinned validated index before adding the final signature (existing R2/L3 pattern).
- **Pre-signed blobs fix amounts.** A claim amount unknown at signing time can't be in a pre-signed default. Unknown-amount
  outcomes always need live signatures.
- **Batch limit: 8 inner transactions.** The largest outcome here (ruling with bond: 3 payouts + TrustSet + AccountDelete) is 5.
- **Policy engine is complete for hotel@1.1.0** — every `ledger.*`, `att.*`, `tx.*` function it uses exists
  (`packages/policy/src/env.ts`). New rules should reuse them; add functions only where §6 genuinely needs one.
- **Co-signer signs only stages its template routes to it** (`signsStage`, `packages/cosigner/src/service.ts:182`): a stage is
  signed only if a template outcome names it as `policyStage` with a cosigner in a signer set. Other stages are advisory.
- **Dispute Credential counts on creation.** `ledger.credentialExists` doesn't require acceptance
  (`packages/policy/src/facts.ts:258`). Decision: keep it — anyone opening a dispute should freeze defaults immediately,
  without needing the other side to accept anything.
- `hotel@1` and `pol_hotel@1.1.0` stay untouched (vectors and tests depend on them). The new work is a new version.

## 4. Signers and weights (decided)

| Role | Weight |
|---|---|
| principal (guest; agent prepares, guest signs) | 3 |
| counterparty (hotel) | 3 |
| arbiter (primary) | 4 |
| backupArbiter | 2 |
| cosigner (policy co-signer) | 2 |

**Quorum 7.**

| Signer set | Weight | Reaches quorum? | Meaning |
|---|---|---|---|
| guest + hotel + co-signer | 8 | ✅ | Agreed outcomes; policy enforced |
| guest + hotel | 6 | ❌ | Parties can't bypass policy alone |
| guest + hotel + arbiter | 10 | ✅ | Service-unavailable escape hatch (as in hotel@1) |
| arbiter + either party | 7 | ✅ | Primary ruling; no service involved |
| backup + either party + co-signer | 7 | ✅ | Backup ruling — co-signer only signs after the primary's deadline |
| backup + either party | 5 | ❌ | Backup can't act without the deadline check |
| arbiter + backup | 6 | ❌ | Arbiters can't take funds alone |
| co-signer + any one party | 5 | ❌ | Service can't move funds with one party |
| arbiter + co-signer | 6 | ❌ | |
| backup + co-signer | 4 | ❌ | |

**Stated trust assumptions**
- Arbiter + hotel can pay the hotel without the guest (as in hotel@1 — that's what an arbiter is).
- **Arbiter + backup + co-signer = 8 reaches quorum without either party.** This is unavoidable: if guest + hotel < Q and
  backup + one party + co-signer ≥ Q and arbiter + one party ≥ Q, then arbiter + backup + co-signer ≥ Q. The co-signer's
  policy never signs that combination; it only matters if the service colludes with both arbiters.
- The primary arbiter's ruling is not policy-checked by the co-signer (arbiter + party reaches quorum alone). The arbiter is
  trusted to rule per its published terms, as in hotel@1 §9.

The template validator (V1–V12, `packages/core`) must accept these weights; if a rule (e.g. "every winning set contains a
party") rejects arbiter+backup+co-signer, the builder adjusts that rule to an explicit, documented exception rather than changing
the weights.

## 5. The lifecycle

### 5.1 States

```
PREPARED ─open Batch→ OPEN
OPEN ─valid confirmation→ CONFIRMED
OPEN ─confirmBy elapsed→ CLOSED_REFUNDED            (default.refund, pre-signed at open)
CONFIRMED ─check-in recorded + deposit funded→ CHECKED_IN
CONFIRMED ─checkInBy elapsed, no check-in, no entry dispute→ CLOSED_NOSHOW   (default.noshow, pre-signed at open)
CONFIRMED|CHECKED_IN ─entry dispute (before entryDisputeBy)→ ENTRY_DISPUTED
ENTRY_DISPUTED ─hotel concedes→ CLOSED_REFUNDED     (refund.conceded: guest + hotel + co-signer)
ENTRY_DISPUTED ─arbiter rules→ CLOSED_RULED         (full/partial refund, or claim rejected)
CHECKED_IN ─checkout (deliveryBy)→ AWAITING_SETTLEMENT
AWAITING_SETTLEMENT ─agreed split + review→ CLOSED_SETTLED          (settle: guest + hotel + co-signer)
AWAITING_SETTLEMENT ─hotel posts claim (before claimBy)→ CLAIM_POSTED
AWAITING_SETTLEMENT ─disputeWindowEnds, no claim, no dispute→ CLOSED_RELEASED   (default.release, pre-signed at check-in)
CLAIM_POSTED ─guest accepts (agreed split)→ CLOSED_SETTLED
CLAIM_POSTED ─guest disputes (before disputeWindowEnds)→ DISPUTED
CLAIM_POSTED ─disputeWindowEnds, no dispute→ AWAITING_DEFAULT_RULING → arbiter + hotel pay the claim → CLOSED_RULED
AWAITING_SETTLEMENT ─guest disputes (mid-stay/end issues)→ DISPUTED
DISPUTED ─arbiter + one party sign ruling→ CLOSED_RULED
ENTRY_DISPUTED|DISPUTED|AWAITING_DEFAULT_RULING ─rulingDueBy elapsed, no ruling→ ESCALATED
ESCALATED ─backup + one party + co-signer sign ruling→ CLOSED_RULED
```

At any point before close — **including while a dispute is open** — guest + hotel + co-signer may settle by agreement (an
agreed split always wins and ends the dispute), and guest + hotel + arbiter remains the service-down escape hatch. This changes
hotel@1's `S1` (which refused to settle while `disputeOpen`).

**State is derived, not stored** (my call). The co-signer computes `eng.state` on every decision from the engagement record,
the attestations it holds, the ledger snapshot at the pinned index, and the clock — then evaluates policy against that. This
avoids the "nothing advances state" gap and lost-update bugs. The record stores facts (timers, attestation ids, pre-signed
blobs), not the state.

### 5.2 Timers (template-relative; values are the builder's, demo uses short ones)

| Timer | From | Meaning |
|---|---|---|
| `confirmBy` | open | Hotel must confirm or the guest is refunded |
| `checkInBy` | check-in date | Last moment check-in can be recorded; after it, no-show |
| `entryDisputeBy` | check-in date | Last moment for an entry dispute (≥ `checkInBy`, so a refused guest always has time) |
| `deliveryBy` | check-out date | Stay over; settlement phase begins |
| `claimBy` | `deliveryBy` | Last moment the hotel can post a deposit claim |
| `disputeWindowEnds` | `deliveryBy` | Last moment for guest disputes and claim responses (> `claimBy`) |
| `rulingDueBy` | dispute opened (entry or settlement phase), or `disputeWindowEnds` for an unanswered claim | Primary arbiter's deadline; after it the backup may rule (§5.8) |

### 5.2a Where attestations live, and how absence is proven (my call)

Several outcomes depend on something **not** having been posted (no claim → release; no `checked_in` → no-show; no primary
ruling → backup). A claim leaves no ledger trace, so "posted" must be defined, or the hotel could lose a claim it did post.

- The co-signer gets an ingest endpoint: `POST /v1/engagements/:id/attestations` (and an in-process `ingest()` method). It
  verifies the statement's signature and issuer role, stores it in the engagement record, and returns a **signed receipt**
  `{ statementId, engagementId, receivedAt, ledgerIndex }` signed by the co-signer key.
- **"Posted" means "receipted by the co-signer".** Deadlines (`claimBy`, `disputeWindowEnds`, …) are judged on the co-signer's
  `receivedAt` clock. The receipt is the poster's proof: if the co-signer later completes a default that ignores a receipted
  statement, the receipt shows service misbehaviour to the arbiter.
- `decide()` and `tick()` evaluate against all stored statements plus any passed in the request (deduplicated by id).
- **Only the guest's dispute counts.** `disputeOpen` in hotel@2 checks only an `ENG/DISPUTE` Credential issued by the principal
  (hotel@1.1.0 also counted the counterparty's). A Credential the hotel creates is ignored by policy; RLUSD the hotel sends in is
  treated like any unregistered deposit (below).
- Disputes additionally need their on-ledger Credential + bond (§5.5) — the ledger part freezes the defaults even if the
  co-signer were unreachable; the attestation carries the claim and phase.
- Unregistered RLUSD sent to the account (dust griefing) is handled as in hotel@1 §12: defaults refuse while the balance is
  off, and it's treated as a dispute without a proper bond.

### 5.3 The deposit

- The mandate caps the deposit (`mandate.constraints.maxDeposit`). The hotel's confirmation states the deposit
  (`party.confirmation/1` gains `deposit`); a new confirm rule checks `deposit ≤ maxDeposit`.
- **Check-in order (my call)** — the release default exists before any deposit money moves, so no one can stall it into a gap:
  1. Hotel posts `party.checkin/1` (`{ status: "checked_in", room, deposit }`) and signs the `default.release` blob.
  2. Guest's agent co-signs the blob and hands it to the co-signer, which checks it's guest + hotel signed, matches
     `close.split` with room → hotel (minus fee) and deposit → guest, and stores it.
  3. Only then does the guest's agent pay exactly the confirmed deposit (memo `eng/deposit`). The agent never pays a deposit
     without a stored release blob.
  4. The `checkin` stage confirms the deposit on-ledger; state → CHECKED_IN.
- If the hotel won't do step 1 → no deposit is paid; the guest's remedy is an entry dispute before `entryDisputeBy`.
  If the guest won't do steps 2–3 → the hotel posts `status: "refused"` → no-show path; the guest may still dispute.
- Service fee (50 bps) applies to **everything the hotel receives** (room and claims), keeping hotel@1's `S4` formula
  `toFee == bps(toMerchant + toFee)` unchanged (my call). Refunds carry no fee.

### 5.4 Pre-signed defaults

| Default | Signed when | By | Pays | Completed by co-signer when |
|---|---|---|---|---|
| `default.refund` | open | guest + hotel (6) | all room money → guest | `confirmBy` passed, never confirmed, balance = room |
| `default.noshow` | open | guest + hotel | room money → hotel (minus fee) | confirmed, `checkInBy` and `entryDisputeBy` passed, no check-in recorded as `checked_in`, no dispute, balance = room |
| `default.release` | check-in | guest + hotel | room → hotel (minus fee), deposit → guest | `disputeWindowEnds` passed, no claim, no dispute, balance = room + deposit |

- Tickets for all three are reserved in the open Batch (`TicketCreate`), so the check-in default can be pre-signed without a
  second engagement-account transaction (my call; costs ~15 Tickets of owner reserve up front, returned at `AccountDelete`).
- The open-time defaults become ledger-dead once the deposit arrives (balance ≠ room); the co-signer also refuses them once a
  check-in exists. Neither layer alone is relied on.
- The co-signer stores the pre-signed blobs (guest + hotel signatures) in the engagement record and exposes a `tick(now)`
  that completes and returns any default whose conditions hold at a pinned validated ledger. Submission is the caller's job
  (the demo, or a future keeper).

### 5.5 Entry disputes (end the deal immediately)

- Trigger: guest creates an `ENG/DISPUTE` Credential on the engagement account (subject = account, `URI` = evidence bundle
  hash) plus a dispute bond payment (`minDisputeBond`), in one single-account Batch from the guest — the hotel@1 §8.C mechanism —
  with a `party.dispute/1` attestation whose claim has `phase: "entry"`.
- **Hotel concedes**: hotel posts `party.concession/1` referencing the dispute. Outcome `refund.conceded`
  (guest + hotel + co-signer): everything in the account (room, any deposit, the bond) → guest. No fee.
- **Arbiter rules**: `party.ruling/1` + arbiter + one party sign a `close.split`. Full refund, partial refund (e.g. downgrade
  difference), or dispute rejected (room to hotel, bond to hotel or per ruling).
- An open entry dispute blocks `default.noshow` (ledger: bond changes balance; policy: `disputeOpen`).

### 5.6 Mid-stay issues

Recorded, not settled. Either party posts `party.issue/1` (`{ phase: "mid-stay", kind, description, evidenceHashes, at }`).
They have no ledger effect; they are evidence for a later agreed settlement, claim, or dispute. A guest who wants money back for
a mid-stay failure opens a dispute in the settlement phase (§5.7).

### 5.7 Checkout and settlement

- At `deliveryBy` the stay is over. The hotel may post `party.claim/1` before `claimBy`:
  `{ items: [{ kind, amount, evidenceHashes, issueRef? }], total }`, `total ≤ deposit`.
- **Guest accepts** (or no claim and both agree): `settle` stage — guest + hotel + co-signer sign a `close.split`. Because both
  parties sign, **their split is authoritative** (e.g. refund an unused night). `settle` enforces only: `close.split` shape,
  payouts sum exactly to the balance, destinations ⊆ {guest, hotel, fee account}, fee = bps of everything the hotel receives
  (S4), review hash present (S5). It does **not** re-check the claim cap — the guest signed. A bond in the account may go to
  either party in an agreed split.
- **Guest disputes** before `disputeWindowEnds` (claim, overcharge, service failure, mid-stay issue): Credential + bond →
  `DISPUTED` → arbiter rules.
- **Guest silent on a claim**: at `disputeWindowEnds` the claim stands. The arbiter issues a **default ruling** paying exactly the
  posted claim (room to hotel minus fee, claim to hotel minus fee, deposit remainder to guest) and signs with the hotel
  (4 + 3 = 7). The co-signer is not on this path (it can't be — arbiter + hotel already reach quorum); the scripted arbiter
  checks claim ≤ deposit and that the window closed. *(Correction to the conversation: earlier I said the co-signer checks this;
  it can't enforce it with these weights. It does record an advisory decision for the audit trail.)*
- **Hotel posts no claim and nobody disputes**: `default.release` (§5.4).
- The co-signer refuses `default.release` while a claim is posted (new rule), so an unanswered claim can't be wiped by the release.

### 5.8 Backup arbiter

- Applies to **every** dispute: entry disputes, settlement disputes, and unanswered-claim default rulings.
- Outcome `ruling.backup`: signers `[[backupArbiter, principal, cosigner], [backupArbiter, counterparty, cosigner]]`,
  `policyStage: "ruling.backup"`.
- Co-signer rules: `now ≥ rulingDueBy`; no primary ruling attestation exists; a `party.ruling/1` from the backup exists and
  the tx payouts match it exactly; tx matches `close.split`.
- A primary ruling that arrives late but before the backup's executes normally (arbiter + party); whichever closes the account
  first wins; the other becomes ledger-dead.

## 6. Policy `pol_hotel@2.0.0` (shape, not final CEL)

Stages the builder writes (each with rules + reason codes, reusing hotel@1.1.0 rules where unchanged):

| Stage | Signed by co-signer? | Covers |
|---|---|---|
| `confirm` | advisory | C1–C4 from hotel@1.1.0 + deposit ≤ `maxDeposit` |
| `checkin` | advisory | check-in attestation present, deposit on-ledger equals confirmed deposit, before `checkInBy` |
| `settle` | yes | state, `close.split`, fee (S4), review (S5), claim ≤ deposit, payouts sum to balance |
| `refund.conceded` | yes | entry dispute open, concession attestation references it, everything → guest, no fee |
| `default.refund` | yes (final) | hotel@1 R1–R3 |
| `default.noshow` | yes (final) | confirmed, past `checkInBy` + `entryDisputeBy`, no `checked_in`, no dispute, balance = room |
| `default.release` | yes (final) | past `disputeWindowEnds`, no claim, no dispute, balance = room + deposit, `close.split` shape |
| `ruling.backup` | yes | §5.8 |
| `ruling.default` | advisory | records the default-ruling decision (§5.7) |

New attestation types to register (`packages/policy/src/pipeline.ts` REGISTRY): `party.checkin/1`, `party.concession/1`,
`party.issue/1`, `party.claim/1`. `party.dispute/1` gains `phase`. `party.ruling/1` gains the arbiter role (primary/backup).

## 7. Demos

### 7.1 Live Testnet script — `packages/cosigner/demo/hotel-testnet.ts`, `npm run demo:hotel`

Same structure as `b1-testnet.ts` (`record`/`must`/`fund`, results JSON in `demo/results/`). Each path needs its own
single-use engagement account. Timers are set seconds-to-minutes apart so the run completes in one sitting. Checks:

| # | Path | Expected |
|---|---|---|
| H1 | Happy: confirm → check-in + deposit → claim (minibar) → guest accepts → settle with review | `tesSUCCESS`, payouts exact, account deleted |
| H2 | Hotel never confirms | `default.refund` completed by co-signer, guest refunded |
| H3 | Guest never shows | `default.noshow`, hotel paid |
| H4 | No room at check-in → entry dispute → hotel concedes | `refund.conceded`, guest gets room + bond back |
| H5 | Downgraded room → entry dispute → arbiter partial refund | arbiter + guest ruling closes |
| H6 | Stay, no claim, silence | `default.release`, deposit back to guest |
| H7 | Claim posted, guest silent | arbiter default ruling, claim paid |
| H8 | Claim disputed, primary arbiter silent past `rulingDueBy` | backup + guest + co-signer ruling closes |
| H9 | Backup ruling *before* `rulingDueBy` | co-signer refuses (`NOT_DUE`) |
| H10 | Guest + hotel alone | `tefBAD_QUORUM` |
| H11 | `default.release` while a claim is posted | co-signer refuses |
| H12 | Open-time `default.refund`/`default.noshow` after deposit | co-signer refuses (`BALANCE_CHANGED`) |
| H13 | `default.noshow` while an entry dispute is open | co-signer refuses (`DISPUTE_OPEN`) |
| H14 | Arbiter + backup alone | `tefBAD_QUORUM` |

### 7.2 Web demo — "Hotel stay" scenario

- **Replaces the "escrow with arbiter" scenario** (my call — it presents itself as the hotel template while faking its checks,
  which is exactly the anti-goal). "Bonded marketplace" is untouched.
- Runs through a real `CosignerService` with the real `pol_hotel@2.0.0`: every check shown in the UI comes from a decision
  record (rule ids, reason codes), never a hard-coded string.
- A path picker (happy / no-show / entry dispute conceded / entry dispute ruled / claim accepted / claim unanswered / backup
  arbiter) and a timeline that advances the clock in simulated mode; live mode uses Testnet with short timers.
- Simulated and live modes, following the existing `LIVE` / `window.__ENG_API__` pattern (`packages/web/README.md`).

## 8. What's left to the builder

- Exact timer values (product and demo), dispute bond size, deposit amount in the demo.
- The concrete CEL for each rule, reason-code names, and whether a new engine function is needed (prefer existing ones).
- How `tick(now)` is exposed (method, HTTP route, or both) and how the demo injects the clock.
- Engagement-record shape additions (deposit, pre-signed blobs per default, Ticket allocation per default).
- Ticket allocation per default and the exact open-Batch `TicketCreate` count.
- Updating `docs/use-cases/hotel-booking.md` (and README §12 "Built"/"Next") to describe hotel@2 once it runs.
- Conformance vectors for `pol_hotel@2.0.0` in `vectors/`.
