# Policy specification

> **Status:** design draft (October 2026).
> **Builds on:** [hotel-booking use case](../use-cases/hotel-booking.md) §5, [attestations](attestations.md), [catalog](../use-cases/catalog.md) (E10, E12) and earlier work in MPCP (`mpcp-protocol`).
> **Defines:** what a policy is, the rule language, the input model, standard stages, the evaluation algorithm, baseline safety rules, stateful counters, the decision record, layering with MPCP, and the policy lifecycle.

---

## 0. What a policy is, and what it isn't

A **policy** is a declarative set of rules that the **policy co-signer** evaluates before it adds its signature to a transaction on an engagement account. The co-signer is a pure function plus a signing key:

```
decide(stage, proposedTx, inputs@ledgerIndex) → DecisionRecord { SIGN | REFUSE, ruleResults[], … }
```

- **Policy decides only whether the co-signer signs.** Whether that matters depends on the **template**: if the co-signer's weight is needed for quorum on that outcome, the policy is **ledger-enforced**. If not, it's **advisory** (§9).
- **Policy never decides facts.** Facts come in as verified statements ([attestations](attestations.md)). Conflicting facts make the policy refuse (`CONFLICT`), and the arbiter decides.
- **Policy never holds funds or moves them alone.** Template invariant V1 guarantees the co-signer's weight is below quorum.

---

## 1. Design decisions

| ID | Decision | Rationale | Rejected |
|---|---|---|---|
| P1 | **Rules are expressions in a restricted CEL subset** (Common Expression Language) | Non-Turing-complete, side-effect free, deterministic, with built-in cost estimation and implementations in Go, Java, C++ and JS. Readable by auditors. A subset that **compiles to WASM** later (Smart Escrow finish functions, stage 3) | **Rego/OPA:** powerful but heavier, and harder to bound. **JSONLogic:** unreadable at this size. **Custom DSL:** no ecosystem. **Raw WASM/code now:** not auditable by non-engineers |
| P2 | **Evaluation is a pure function over pinned inputs.** All ledger reads come from one validated ledger index, and `now` is that ledger's close time, **not** the wall clock | Anyone with a full-history node can replay any decision bit-for-bit | Live API calls or wall-clock time during evaluation |
| P3 | **Fail-closed.** Unknown stage, missing input, evaluation error, cost limit exceeded, or any failed rule → `REFUSE` | A co-signer that signs on error is worse than none | "Best effort" |
| P4 | **Policies are layered, and layers only tighten:** baseline ∧ template ∧ engagement (principal constraints) ∧ optional counterparty requirements | The service's safety rules can't be removed by a template, and a principal can restrict further but never loosen | Override semantics |
| P5 | **Policies are content-addressed, versioned and pinned at open.** The effective policy hash goes into the open memo and can only change through an amendment (E3) | No silent policy change mid-deal | Mutable policy references |
| P6 | **Money is exact:** integer minor units per asset (MPCP convention). Floats are banned in the language. Amounts of different assets can't be compared or added | Rounding bugs move money | Decimal floats |
| P7 | **State is derived, not stored:** counters (spent today, payouts so far) are computed from the account's ledger history plus the co-signer's own logged in-flight signatures | Stateful policy (E12) remains replayable | Hidden mutable counters |
| P8 | **Every decision is a signed statement** (`cosigner.decision/1` in the attestation envelope), published to the indexer and referenced from the outcome's `eng/basis` memo | Accountability, replay, dispute evidence | Plain logs |
| P9 | **Evaluate all rules, report all failures** (within the cost budget) rather than stopping at the first | Parties learn everything that's wrong in one round trip | Short-circuit (one error at a time) |
| P10 | **MPCP-compatible constraint block:** the static part of a policy uses MPCP PolicyGrant fields (`allowedRails`, `allowedAssets`, `destinations`, `maxAmountMinor`, `expiresAt`) | One policy vocabulary across MPCP and engagements (§10) | A separate vocabulary |

---

## 2. Policy document

A policy document is itself a statement (`policy.document/1`, [attestation envelope](attestations.md#3-the-envelope)) signed by its **author**: the service for baseline and template layers, the principal for engagement constraints (usually inside the mandate). Its `id` (content hash) is the policy hash.

```json
{
  "type": "policy.document/1",
  "claim": {
    "policyId": "pol_hotel",
    "version": "1.1.0",
    "layer": "template",
    "appliesTo": ["settlement-vault/hotel@1"],
    "registry": "att-registry@2026.10",
    "language": "cel-eng/1",
    "assets": {
      "RLUSD": { "kind": "IOU", "currency": "RLUSD", "issuer": "rRLUSD…", "decimals": 6 }
    },
    "constraints": {
      "allowedRails": ["xrpl"],
      "allowedAssets": ["RLUSD"],
      "maxAmountMinor": "5000000000",
      "expiresAt": "2027-12-31T23:59:59Z"
    },
    "params": {
      "serviceFeeBps": 50,
      "minDisputeBondMinor": "10000000",
      "feeCapDrops": "500000",
      "maxLedgerWindow": 30
    },
    "definitions": {
      "balance": "ledger.balance(eng.account, 'RLUSD')",
      "disputeOpen": "ledger.credentialExists(eng.parties.principal, eng.account, 'ENG/DISPUTE') || ledger.credentialExists(eng.parties.counterparty, eng.account, 'ENG/DISPUTE')"
    },
    "stages": {
      "open":    { "enforcement": "service", "rules": [ … ] },
      "confirm": { "enforcement": "service", "rules": [ … ] },
      "settle":  { "enforcement": "ledger",  "rules": [ … ] },
      "default.refund":  { "enforcement": "final-signature", "rules": [ … ] },
      "default.release": { "enforcement": "final-signature", "rules": [ … ] }
    }
  }
}
```

**A rule:**

```json
{ "id": "S2",
  "when": "true",
  "check": "tx.payouts.sum('RLUSD') == def.balance",
  "reason": "PAYOUT_MISMATCH",
  "message": "Payouts {tx.payouts.sum} must equal the account balance {balance}." }
```

| Field | Meaning |
|---|---|
| `id` | Unique within the layer. The decision record reports results per id |
| `when` | Optional guard. If false, the rule is **skipped** (recorded as `n/a`), not passed |
| `check` | Boolean CEL expression. `false` or an error means the rule failed |
| `reason` | Stable machine code returned to parties and the indexer |
| `message` | Human template with `{expr}` interpolation, for explanations only (never evaluated for the decision) |

`definitions` are named expressions that rules reuse, read as `def.<name>`. Each is evaluated once per decision, in declaration order, and may use earlier definitions. A definition that errors does not fail the decision by itself: every rule that **reads** it errors instead (fail-closed), and rules that don't read it still evaluate. This keeps the refusal reasons precise.

---

## 3. Input model

Everything a rule can see. Nothing else is reachable.

| Root | Content | Source |
|---|---|---|
| `stage` | The stage being evaluated | Request |
| `eng` | The **engagement record** (parties, amounts, timers, attesters, tickets, hashes, state) | Facilitator store, hash-checked against the open memo |
| `mandate` | The principal's signed mandate (constraints) | Statement store |
| `tx` | The **proposed transaction**, decoded, with helpers (§3.1) | Request |
| `ledger` | Read-only view at the pinned validated ledger: balances, account flags, SignerList, Tickets, Credentials, trust lines | rippled / Clio at `ledgerIndex` |
| `history` | Derived from the account's validated transactions up to `ledgerIndex` (§6) | Full-history node |
| `inflight` | Co-signer's own SIGN decisions whose transactions are not yet validated and not yet expired | Decision log |
| `att` | Verified statements (attestation pipeline output) and query functions | Statement store + pipeline |
| `now` | Close time of the pinned ledger | Ledger |
| `params`, `assets`, `constraints` | From the effective policy | Policy |

### 3.1 Transaction helpers

| Helper | Meaning |
|---|---|
| `tx.type`, `tx.account`, `tx.flags`, `tx.fee`, `tx.lastLedgerSequence`, `tx.memos` | Raw fields (fees in drops) |
| `tx.inner` | List of inner transactions (Batch), or `[tx]` for a single transaction |
| `tx.payouts.items` | All `Payment`s from `eng.account`, as `{to, asset, value, amount, partial, issuer}`. A residual sweep (`tfPartialPayment`, E9) is resolved to *balance − fixed payouts* at the pinned ledger. Iterate with `tx.payouts.items.all(p, …)` |
| `tx.payouts.sum(asset)`, `.to(account, asset)`, `.destinations()`, `.count()`, `.hasResidual()` | Aggregates |
| `tx.innerTypes()`, `tx.innerAccounts()`, `tx.isAllOrNothing()`, `tx.setsRegularKey()` | Structure (baseline B1, B2, B5) |
| `tx.drainsExactly()`, `tx.deleteDestinationValid()`, `tx.issuersValid()`, `tx.wouldSucceed()` | Close checks (B7, B10, B11) |
| `tx.closes()` | True if the last inner tx is `AccountDelete` from `eng.account` |
| `tx.matchesBlueprint(name)` | Structural match against a named blueprint from the template: inner types in order, flags, destinations as roles, only listed fields present |
| `tx.memo(type)` | Decoded memo data or `null` |
| `tx.intentHash()` | Payment-intent hash used by approvals ([attestations §8.3](attestations.md#83-example-payment-approval-b1-e10)) |

### 3.2 Ledger helpers

`ledger.balance(account, asset)`, `ledger.exists(account)`, `ledger.masterDisabled(account)`, `ledger.hasRegularKey(account)`, `ledger.extraObjects(account)`, `ledger.reserveIncrement()`, `ledger.credentialExists(issuer, subject, type)` (any state, unexpired), `ledger.hasCredential(account, type, issuers)` (accepted, unexpired, from one of `issuers`). All are evaluated at `ledgerIndex`. Arguments are positional (CEL has no named arguments). Planned: `ledger.signerList(account)`, `ledger.ticketsOf(account)`, `ledger.trustline(account, asset)`.

---

## 4. The language: `cel-eng/1`

A subset of CEL with domain types:

- **Types:** bool, int, string, timestamp, duration, list, map, plus **`Amount`** (asset + integer minor units). Accounts are classic-address strings. `now` is a `google.protobuf.Timestamp` and windows are `google.protobuf.Duration` (`duration('24h')`). All JSON numbers in inputs become `int`; a non-integer number in any input is rejected.
- **Amount arithmetic:** `+ - ` between same-asset amounts, `* int`, and `bps(amount, n)` (rounds **down** to the minor unit, with the remainder going to the payee side by convention, declared per policy). Comparing or adding different assets is a type error, so the rule fails.
- **Allowed functions:** CEL standard (`size`, `in`, `has`, `all`, `exists`, `exists_one`, `filter`, `map`, string `startsWith`/`endsWith`/`matches` with RE2), time (`timestamp`, `duration`), plus the helpers in §3, the `att.*` functions from the attestation spec, and `asset()`, `amt()`, `bps()`.
- **Banned:** floats (`double`), wall-clock time, any network or file access, and recursion (CEL has none).
- **Cost limit:** each decision has a cost budget (CEL cost units, default 100k). Policies are checked statically at publish time against a worst-case input size (§11). Exceeding the budget at runtime means `REFUSE: COST_EXCEEDED`.
- **Determinism:** one pinned evaluator implementation per `language` version (`@marcbachmann/cel-js` 8.0.0), plus published conformance vectors ([`vectors/`](../../vectors/README.md)) that every evaluator must reproduce exactly.

---

## 5. Standard stages

Templates map each outcome and lifecycle step to a stage. Policies must cover every stage the template references (lint rule L2, §11).

| Stage | Trigger | Proposed object | Typical rules | Enforcement (escrow class) |
|---|---|---|---|---|
| `open` | Facilitator `prepare` | Open Batch + pre-signed outcomes | Mandate valid, terms authorized, counterparty credentials, attesters named, blueprints match | Service (before quorum exists) |
| `confirm` | Counterparty confirmation statement | Statement only (no tx) | Confirmation matches mandate | Service state + withheld final signatures |
| `spend` | Agent proposes a payment (owner-wallet class) | Single Payment or small Batch | Caps, rolling windows, allowlists, categories, approvals over a threshold | **Ledger** (agent + co-signer = quorum) |
| `settle` | Parties propose an agreed close | Close Batch | Exact drain, destinations, fee, review present, no dispute | **Ledger** (P + C < Q without S) |
| `default.<name>` | Timer or event | Completing a pre-signed outcome | Due, state, no dispute, balance unchanged, triggering statements verified | **Final signature** (blob is 1 short without S) |
| `ladder` | Measurement statement | Completing one rung | Exactly one measurement, rung matches | Final signature |
| `release.<name>` | Document or event trigger (LC-style) | Completing a pre-signed release | Document compliance rules | Final signature |
| `amend` | Change order | Amendment Batch | Both parties' amendment statement, ticket consumption, re-signed outcomes, policy hash update | **Ledger** |
| `close.owner` | Owner closes the wallet (owner class) | Close Batch | Advisory only (owner alone has quorum) | Advisory |

---

## 6. Stateful policy: derived counters (E12)

Rolling limits are **functions of history**, never stored values:

```
history.outflow(asset, window)        // sum of validated payouts from eng.account with close time in (now - window, now]
history.count(window)                 // number of validated outgoing payments
history.paidTo(account, asset, window)
inflight.outflow(asset)               // amounts in co-signer SIGN decisions not yet validated and not expired
inflight.count()
```

The **effective spend** for a limit check is `history.outflow(...) + inflight.outflow(...) + tx.payouts.sum(...)`. Counting in-flight signatures closes the race where the agent gets two payments co-signed before either validates. In-flight entries expire automatically at their `LastLedgerSequence`. That's why baseline rule B4 requires one, with a short window, for every ledger-enforced stage.

**In-flight resolution** (reference co-signer). Before each decision the co-signer re-reads the account at the pinned ledger and drops entries whose outer `Sequence`/`TicketSequence` has been consumed, or whose `LastLedgerSequence` has passed:

- consumed **and** a matching validated payment is in history → success: the decision's single-use statements (approvals, invoices) are marked **consumed** in the engagement record;
- consumed without a matching payment (e.g. `tec` result), or expired → the reservations are **released**.

While a decision is in flight, the single-use statements it relied on are **reserved**: a second request citing the same approval is refused (`CONSUMED`) even before the first payment validates. Requests for one engagement are serialised, and a re-request for the same transaction (same `proposedTxHash`) is idempotent and does not count against itself.

**Example** (owner wallet, R2 / B1):

```json
{ "id": "W3",
  "check": "history.outflow('RLUSD', duration('24h')) + inflight.outflow('RLUSD') + tx.payouts.sum('RLUSD') <= amt('150.00', 'RLUSD')",
  "reason": "DAILY_CAP" }
```

Replay needs the same history, so every decision record includes `ledgerIndex` and `ledgerHash`, plus the list of in-flight decision ids it counted.

---

## 7. Baseline safety rules (non-overridable)

Authored by the service and applied **before** template and engagement layers to every stage with a transaction. They protect against a co-signer being tricked into signing something structurally dangerous, even if a template is badly written.

| ID | Rule | Prevents |
|---|---|---|
| B1 | `tx.account == eng.account`, and every inner tx is from `eng.account` or an account the stage explicitly allows (e.g. the principal's funding at open) | Co-signing for the wrong account |
| B2 | Inner/outer transaction **types allowlisted per stage**. `SignerListSet`, `SetRegularKey`, `AccountSet` flag changes, `DepositPreauth`, `DelegateSet`, `TicketCreate`, `CredentialAccept`, `OfferCreate` are only allowed in stages that list them (`open`, `amend`). In `open`, `SetRegularKey` is allowed **only without a `RegularKey` field** (removing the service's pre-create key), never to install one | Quietly changing who controls the account |
| B3 | `tx.fee <= params.feeCapDrops` (+ the `AccountDelete` increment on closing Batches) | Draining reserve XRP through fees |
| B4 | Ledger-enforced stages: `LastLedgerSequence` present and `≤ ledgerIndex + params.maxLedgerWindow`. Pre-signed outcomes are exempt by design (ticket-based, no LLS) | Signatures that stay valid indefinitely |
| B5 | Batches must be `tfAllOrNothing` | Partial execution (e.g. payout executes, close doesn't) |
| B6 | Payout destinations ⊆ `{eng.parties.*, eng.fee.to, eng.children[*]}` with **roles** checked per blueprint | Paying anyone else |
| B7 | If `tx.closes()`: payouts drain the RLUSD balance **exactly**, the trust line is removed, `AccountDelete` is last, and its destination is the service or sponsor | Leaving funds behind or sweeping them wrongly |
| B8 | The transaction carries an `eng/basis` memo naming the stage/outcome. The full list of statements and the decision id live in the decision record (§12), which the facilitator can reference in the memo | Unexplained money movement. *Note:* the x402 `exact` scheme forbids memos; see [x402 multisig research](../research/x402-multisig.md) for the planned InvoiceID-based alternative |
| B9 | **One outcome at a time:** no SIGN on an engagement while another SIGN decision for it is in-flight, unless the stage declares it can run concurrently (`spend` can) | Racing two conflicting outcomes (matters for non-closing payouts, E1) |
| B10 | Asset issuer of every amount equals the policy's declared issuer for that asset | Fake RLUSD from a look-alike issuer |
| B11 | **Pre-signed outcomes are single-shot** (a failed `ALLORNOTHING` Batch still consumes its outer Ticket, confirmed on testnet, spike finding F2). Before adding a final signature, the co-signer requires the ledger state at the pinned ledger to make the outcome succeed exactly (balance, trust line, no extra objects) | Burning a default by completing it into a guaranteed failure |

---

## 8. Evaluation algorithm

```
1  Receive (engagementId, stage, proposedTx?)          ── reject unknown engagement/stage
2  Load engagement record; check its hash matches the open memo
3  Load effective policy = baseline ∧ template ∧ engagement layers
   (hashes pinned in the engagement record)            ── mismatch → REFUSE: POLICY_PIN
4  Pin ledger: latest validated index L, its hash and close time (now)
5  Build inputs at L: ledger view, history, inflight, mandate
6  Run the attestation verification pipeline → att (verified set + rejections)
7  Evaluate rules in order: baseline → template → engagement
   - evaluate `definitions` once, in order (`def.<name>`; an erroring definition errors its readers)
   - for each rule: when? → check → pass / fail / n/a / error
   - cost meter across all layers
8  decision = SIGN iff (no fail, no error, cost within budget)
9  Write DecisionRecord (signed statement); append to log
10 If SIGN and the co-signer signs this stage (a template outcome maps to it, includes
   a co-signer role, and is not advisory): sign proposedTx as a multisig signer
   (Signers entry), record it as in-flight, reserve its single-use statements.
   Advisory stages (e.g. `close.owner`) get a decision record but no signature.
11 Return DecisionRecord (+ signature) to the facilitator
```

**Idempotence:** the same `(stage, proposedTx, L)` gives the same decision. Re-requests at a later ledger are new decisions, with their own records. Decisions for one engagement are serialised (no two evaluate concurrently), which is what makes the in-flight count race-free.

**Timers** are not cron jobs inside policy. The facilitator *requests* a `default.*` evaluation when a timer is due. The policy's `now >= …` check makes early requests fail harmlessly.

---

## 9. Enforcement levels by template class

| Class | Stage | Who reaches quorum without the co-signer? | Policy is… |
|---|---|---|---|
| Escrow (hotel weights P2·C2·A3·S1·Q5) | `settle` | Only with the arbiter (P+C+A, A+P, A+C) | **Ledger-enforced** for two-party agreement |
| Escrow | `default.*`, `ladder`, `release.*` | Nobody: blobs are signed to Q − 1 | **Ledger-enforced** (final signature) |
| Escrow | arbiter ruling | A + P or A + C | Not involved (arbiter accountability) |
| Owner wallet (Owner2·Agent1·S1·Q2) | `spend` | Owner alone | **Ledger-enforced** against the agent, **advisory** against the owner |
| Group-owned | any | k-of-N members | Advisory, unless an S slot is required by the template |
| Any | `open`, `confirm` | n/a (no quorum yet, or no transaction) | Service-enforced |

Templates must declare each stage's enforcement, and the validator checks the declaration against the weights (lint rule L5).

---

## 10. Layering with MPCP

The engagement design reuses artifacts from MPCP — earlier work (`mpcp-protocol`) — and adds ledger enforcement:

| MPCP | Engagements | Note |
|---|---|---|
| **Policy Authority** | Author of baseline and template layers | Same service can play both roles (`mpcp-policy-authority`) |
| **PolicyGrant** (rails, assets, expiry, purposes) | `constraints` block + principal's **mandate** | Mandate = a PolicyGrant scoped to one engagement, signed by the principal |
| **SignedBudgetAuthorization** (per-payment envelope) | A `spend` proposal in owner wallets | The agent can submit an SBA as a statement (`ext.mpcp.sba/1`). Policy rules check `tx` against it (`amount ≤ sba.maxAmountMinor`, `destination ∈ sba.destinationAllowlist`) |
| **Trust Gateway** (verifies chain, executes payment) | **Policy co-signer** | The difference: the gateway *executes* (custodial path), while the co-signer *co-signs* a multisig the ledger checks (non-custodial). A co-signer is a Trust Gateway whose verdict is enforced by XRPL quorum |
| `mpcp/grant-id` memo | `eng/basis` memo (+ `mpcp/grant-id` when an MPCP grant is involved) | Audit trail stays compatible with `mpcp verify` |
| Canonical JSON + SHA-256 | JCS + SHA-512Half with `ENGA\0` prefix for statements | Hash functions differ by design (domain separation). MPCP artifacts are imported as statements by wrapping them, keeping their original hash in the claim |

The outcome is that an MPCP-governed machine wallet can **graduate** to an owner-wallet engagement. The same policy and grants apply, and the gateway's verdict becomes ledger-enforced instead of trusted.

---

## 11. Policy lifecycle

**Authoring → lint → test → publish → pin → (amend) → retire**

**Lint rules** (run by the publisher and again by the co-signer when loading a policy):

| ID | Lint |
|---|---|
| L1 | Parses as `cel-eng/1`. Every identifier is in the input model. No floats |
| L2 | **Stage coverage:** every stage the template references has rules. No rules for stages the template doesn't have |
| L3 | **Statement types** used in `att.*` exist in the pinned registry, with the roles defined in the template's `attesters` block |
| L4 | **Cost bound:** static worst-case cost under the declared max input sizes (≤ 8 inner txs, ≤ 32 signers, ≤ N statements) is below budget |
| L5 | **Enforcement declarations** agree with template weights (§9) |
| L6 | **Layer monotonicity:** an engagement layer may add rules and tighten `constraints` (smaller `maxAmountMinor`, subset of assets/destinations, earlier `expiresAt`), never remove or loosen them |
| L7 | Each `reason` code is unique per layer and documented |
| L8 | **Plain English:** every rule has a short `title` and a `message` explaining what it protects, for the people deciding or reviewing a deal. Non-normative: the CEL `check` is what decides |

**Testing:** every policy ships **test vectors**: `{inputs, stage, proposedTx, expected decision, expected failing rule ids}`. They include the four hotel paths, at least one negative case per rule, and the baseline B1–B10 attacks. The co-signer refuses to load a policy whose vectors don't reproduce.

**Publishing:** sign as `policy.document/1`, which gives the content hash. Optionally anchor (memo, or MPCP's NFT/HCS anchoring).

**Pinning:** the effective policy (all layer hashes) is pinned in the engagement record and the open memo.

**Amendment:** a new layer version applies to an open engagement only through an `amend` stage Batch signed by P + C + S (E3).

**Retirement:** old versions stay resolvable for replay for as long as any engagement that pinned them can still be disputed.

---

## 12. Decision record

```json
{
  "v": "eng.att/1",
  "type": "cosigner.decision/1",
  "engagementId": "eng_01JE…",
  "subject": { "stage": "spend", "proposedTxHash": "C0FFEE…", "intentHash": "sha256:7d13…" },
  "claim": {
    "decision": "SIGN",
    "policy": { "effectiveHash": "att:91aa…", "layers": ["att:b0b0… (baseline 1.0.0)", "att:4e4e… (procurement 1.2.0)", "att:7c7c… (mandate)"] },
    "language": "cel-eng/1", "registry": "att-registry@2026.10", "evaluator": "cel-eng-js@1.0.3",
    "ledger": { "index": 98811234, "hash": "9A3F…", "closeTime": "2026-11-18T09:33:10Z" },
    "inputsHash": "sha256:5151…",
    "statementsUsed": ["att:aa01… (approval.payment/1)", "att:aa02… (party.invoice/1)", "att:aa03… (merchant.category/1)"],
    "inflightCounted": [],
    "results": [
      { "id": "B1", "result": "pass" }, { "id": "B3", "result": "pass" }, { "id": "B4", "result": "pass" },
      { "id": "W1", "result": "pass" }, { "id": "W3", "result": "pass" },
      { "id": "W5", "result": "pass", "note": "approval required above 1,000.00 RLUSD; found att:aa01…" }
    ],
    "costUnits": 18422
  },
  "observedAt": "2026-11-18T09:33:10Z", "issuedAt": "2026-11-18T09:33:11Z",
  "attester": { "account": "rCoSign…", "kind": "COSIGNER", "accreditation": { "issuer": "rEngageRoot…", "credentialType": "ENG/COSIGNER" } },
  "nonce": "…", "proof": { "…": "…" }, "id": "att:dd01…"
}
```

- **`inputsHash`** = hash of the canonical input bundle (engagement record, statements, proposed tx, ledger index/hash). Large ledger views are referenced by index and hash, not copied.
- **Refusals are records too**, with failing rule ids and messages. They're returned to the parties, so a REFUSE always comes with "what to fix".
- The outcome transaction's `eng/basis` memo includes the decision id, so the ledger links money movement → decision → policy → statements.

---

## 13. Worked example: enterprise procurement spend (B1)

**Template:** owner wallet, Treasury 2 · Agent 1 · S 1 · Q2. **Mandate:** Q4 cloud & data budget, 50,000 RLUSD, vendors with `KYB_VERIFIED`, approval needed above 1,000.

```json
"definitions": { "spendNow": "tx.payouts.sum('RLUSD')" },
"stages": {
  "spend": { "enforcement": "ledger", "rules": [
    { "id": "W0", "check": "has(mandate.expires) && now < timestamp(mandate.expires)", "reason": "MANDATE_INVALID" },
    { "id": "W1", "check": "tx.matchesBlueprint('spend.payments') && tx.payouts.count() >= 1", "reason": "TX_SHAPE" },
    { "id": "W2", "check": "tx.payouts.destinations().all(d, d in mandate.vendors && ledger.hasCredential(d, params.kybType, params.kybIssuers))", "reason": "VENDOR_NOT_ALLOWED" },
    { "id": "W3", "check": "history.outflow('RLUSD', duration('24h')) + inflight.outflow('RLUSD') + def.spendNow <= amt(mandate.dailyCap, 'RLUSD')", "reason": "DAILY_CAP" },
    { "id": "W4", "check": "history.outflow('RLUSD', duration('2160h')) + inflight.outflow('RLUSD') + def.spendNow <= amt(mandate.budget, 'RLUSD')", "reason": "BUDGET_EXHAUSTED" },
    { "id": "W5", "when": "def.spendNow > amt(params.approvalThreshold, 'RLUSD')",
      "check": "tx.payouts.count() == 1 && att.list('approval.payment/1', 'approver').exists(a, a.subject.intentHash == tx.intentHash() && now < timestamp(a.claim.notAfter))", "reason": "APPROVAL_REQUIRED" },
    { "id": "W6", "check": "tx.payouts.items.all(p, att.list('party.invoice/1', 'vendor').exists(i, i.attester.account == p.to && amt(i.claim.amount, 'RLUSD') == p.amount && i.claim.invoiceRef == tx.memo('eng/invoice')))", "reason": "NO_MATCHING_INVOICE" },
    { "id": "W7", "when": "hasTx && att.list('payment.challenge/1', 'agent').size() > 0",
      "check": "tx.payouts.count() == 1 && def.paymentChallenge.claim.payTo in tx.payouts.destinations() && tx.payouts.to(def.paymentChallenge.claim.payTo, 'RLUSD') == amt(def.paymentChallenge.claim.amount, 'RLUSD') && tx.boundToInvoice(def.paymentChallenge.claim.invoiceId)", "reason": "X402_CHALLENGE_MISMATCH" }
  ]}
}
```

`definitions.paymentChallenge = att.latest('payment.challenge/1', 'agent')`.

The shipped version is [`policies/procurement@1.3.0.json`](../../policies/procurement@1.3.0.json): the caps come from the signed mandate (`mandate.dailyCap`, `mandate.budget`), and `tx.intentHash()` binds an approval to (destination, amount, invoice reference), not to the transaction hash, so re-sequencing or re-fee'ing doesn't invalidate it.

**W7** binds the co-signature to the purchase. When the agent pays an x402 or MPP merchant it submits a self-attested [`payment.challenge/1`](attestations.md#8-the-claim-type-registry) statement (destination, amount, `invoiceId`, resource); W7 then refuses to sign unless the single payout's destination and amount match it and `tx.boundToInvoice(invoiceId)` holds — true when the payment carries `InvoiceID == SHA-256(invoiceId)` (the x402 `exact` scheme) or an `eng/invoice` memo equal to `invoiceId` (the `prepaid` scheme). It is `n/a` for ordinary vendor payments that declare no challenge. This is a consistency guard: it keeps the engagement account from co-signing a payment that doesn't settle the purchase the agent was told about ([x402 research](../research/x402-multisig.md)). It does not add trust about the merchant — the mandate/vendor rules (W2) and the merchant's own x402 verify still govern that.

**Trace** for an 18,500 RLUSD annual data-licence payment:

| Rule | Evaluates to | Result |
|---|---|---|
| B1–B10 | single Payment from the budget account, fee 15 drops, LLS +20, destination is a mandate vendor | pass |
| W0 | mandate signed by the owner, not expired | pass |
| W1 | matches `spend.payments` | pass |
| W2 | `rVendorData…` in vendors, holds `KYB_VERIFIED` from an accepted issuer | pass |
| W3 | 0 + 0 + 18,500 ≤ 10,000? | **fail: `DAILY_CAP`** |
| W4 | 21,300 + 0 + 18,500 ≤ 50,000 | pass |
| W5 | 18,500 > 1,000 → controller approval with matching `intentHash` found | pass |
| W7 | no x402 challenge submitted for this direct vendor payment | n/a |
| W6 | invoice `inv:2026-Q4-0042` for 18,500 from the vendor | pass |

**Decision: REFUSE** (`W3: DAILY_CAP`). The policy did its job: the mandate caps daily outflow at 10k. The fixes are explicit: treasury signs it directly (owner weight 2 = quorum, and the indexer flags it as an owner override), or the mandate is amended to raise the cap for named large invoices. Either way the record shows why.

---

## 14. Open questions

1. ~~**Evaluator choice**~~ *(`@marcbachmann/cel-js` 8.0.0 is pinned; conformance vectors are published in [`vectors/`](../../vectors/README.md). Open: a second, independent evaluator, e.g. cel-go, to cross-check them.)*
2. **History availability:** replay needs full history for the engagement account. Clio/full-history servers are public, but should decision records embed the relevant transaction ids so replay doesn't depend on any particular history server?
3. **Two co-signers:** for high value, two independent co-signers (e.g. the service + a regulated partner, E11) each with weight 1 and both required. That needs new weight patterns and validator rules.
4. **Policy privacy:** policies are shared with the parties but may reveal business terms. Should they be published only as hashes, with the document disclosed to an arbiter on demand?
5. **WASM compilation:** which subset of `cel-eng/1` maps cleanly to Smart Escrow finish functions (no history, no off-ledger statements beyond projected Credentials).
6. **Rounding convention for `bps()`:** where the remainder goes (payee, fee or principal) must be fixed per template, so payouts always sum exactly to the balance.
7. **x402 binding without memos:** the x402 `exact` scheme rejects `Memos` and multisigned blobs ([research](../research/x402-multisig.md)). For engagement payments made through x402, should invoice binding move from the `eng/invoice` memo to `InvoiceID = sha256(invoiceRef)`, with the basis carried only by the decision record?

---

## 15. Reference implementation

| Spec | Code |
|---|---|
| §2 policy document, §3 input model | [`packages/policy/src/types.ts`](../../packages/policy/src/types.ts) |
| §3.1–§3.2 helpers, §6 counters | [`packages/policy/src/facts.ts`](../../packages/policy/src/facts.ts) |
| §4 `cel-eng/1` environment | [`packages/policy/src/env.ts`](../../packages/policy/src/env.ts) |
| Attestation pipeline (attestations §10) | [`packages/policy/src/pipeline.ts`](../../packages/policy/src/pipeline.ts) |
| §8 evaluation, §12 decision record | [`packages/policy/src/decide.ts`](../../packages/policy/src/decide.ts) |
| §11 lint (L1, L2, L3, L5, L7, L8) | [`packages/policy/src/lint.ts`](../../packages/policy/src/lint.ts) |
| §6 in-flight, §8 steps 4–11 | [`packages/cosigner/src/service.ts`](../../packages/cosigner/src/service.ts), ledger snapshot in [`snapshot.ts`](../../packages/cosigner/src/snapshot.ts) |
| §7 baseline, template policies | [`policies/`](../../policies) |
| §11 test vectors | [`vectors/`](../../vectors/README.md) |

Not yet implemented: lint L4 (static cost bound) and L6 (layer monotonicity); policy loading from signed `policy.document/1` statements (layers are loaded from files and pinned by hash); the `open` and `amend` stage rules.
