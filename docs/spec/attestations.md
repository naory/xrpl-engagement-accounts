# Attestation format (extension E2)

> **Status:** design draft (October 2026). **Depends on:** [hotel-booking use case](../use-cases/hotel-booking.md) (co-signer model, §5) and the [use-case catalog](../use-cases/catalog.md) (requirements, E2).
> **Purpose:** one format for every signed, off-ledger statement that the co-signer's policy, the arbiter or the indexer acts on, whether it comes from a carrier, an inspector, a registry, a monitor or an internal approver.

---

## 0. Scope

**In scope:** the envelope, signing and verification, attester identity and accreditation, binding to an engagement, time semantics, on-ledger anchoring, the claim-type registry, conflicts and corrections, policy integration, privacy, and attester accountability.

**Out of scope:** how attesters observe the world (carrier APIs, RDAP, probes), transport details beyond one facilitator endpoint, and selective disclosure (future work, §13).

**Party documents use the same envelope.** Mandates, confirmations, reviews, rulings, invoices and amendments are statements too, signed by a party instead of a third party. One envelope, one verifier, one store. The hotel spec's documents (§3) become `party.*` types under this format.

---

## 1. Requirements (from the catalog)

| # | Requirement | Driven by |
|---|---|---|
| Q1 | **Trigger money movement** by satisfying a co-signer policy stage (release on compliant documents, ladder rung selection) | B3, B4, B7, B8 |
| Q2 | **Anchor timers** to observed events (inspection window starts at delivery) | R3, R6, R4 |
| Q3 | **Gate actions on approvals** bound to one specific payment | B1 (E10) |
| Q4 | **Classify counterparties** with long-lived facts (merchant category, KYB) | R2, B1 |
| Q5 | Be **deterministic to verify**, so co-signer decisions can be replayed (pure function, pinned ledger index) | Hotel §5.2 |
| Q6 | Make attesters **identifiable, accredited, revocable and accountable** | All |
| Q7 | Prevent **replay, backdating and reuse** across engagements | All |
| Q8 | Keep **personal data off-ledger**, with only hashes public | R3, R5, B8 |
| Q9 | Be **forward-compatible with Smart Escrows**, where the ledger itself checks facts | Evolution stage 3 |
| Q10 | **Interoperate** with existing credential ecosystems where it's cheap to do so | Positioning |

---

## 2. Design decisions

| ID | Decision | Rationale | Alternatives rejected |
|---|---|---|---|
| D1 | **Native JSON envelope**, canonicalized with RFC 8785 (JCS), signed with the attester's **XRPL account key** (secp256k1 or ed25519) | Same keys and tooling as the rest of the system. Deterministic. Small. Attester identity *is* an XRPL account, so key rotation, accreditation and revocation all live on-ledger | **W3C VC 2.0 + Data Integrity** as the core: standard cryptosuites don't cover secp256k1, the most common XRPL key type, and the format is heavier than needed. Offered as an **export** instead (§12). **JWS/JWT:** fine for transport, but key binding to XRPL accounts would be custom anyway |
| D2 | **Domain-separated signing:** digest = SHA-512Half(`"ENGA\0"` ‖ JCS bytes) | An attestation signature must **never** be valid as an XRPL transaction signature (`"STX\0"` prefix) or vice versa, because attesters sign with the same keys | Signing raw JCS bytes (cross-protocol replay risk) |
| D3 | **Content-addressed IDs:** `id = "att:" + hex(digest)` | Same content means same id. Storage and transport become untrusted, and anyone can re-submit a lost attestation | Random UUIDs (need a trusted registry) |
| D4 | **Attester accreditation = an XRPL Credential** (XLS-70) issued by an accreditor to the attester account, type `ENG/ATTESTER/<KIND>` | On-ledger, revocable by the issuer, expirable, visible to everyone. Accreditors can be the service, an industry body or a licensed entity (E11) | Off-ledger allowlists (not auditable) |
| D5 | **Trust time = anchor time.** Key validity and accreditation are checked at the ledger where the attestation was **anchored**. Unanchored attestations are checked at the evaluation ledger | An attester can't backdate its way around a revoked key or accreditation. Declared timestamps are only claims | Trusting an `issuedLedger` field (backdating) |
| D6 | **Two anchoring modes:** `memo` (hash in a transaction memo, cheap, Stage 0) and `credential` (an on-ledger projection as a Credential on the engagement account, readable by Smart Escrows later) | Memo anchoring gives existence-by-time cheaply. Credential projection makes the fact a **ledger object**, which is what WASM finish functions can read | Requiring credentials always (reserve cost per fact); no anchoring (no trustworthy time) |
| D7 | **Attesters are deal terms:** the specific attesters (or accepted kinds + accreditors) are named in the engagement record whose hash is in the open memo | Both parties agree up front who decides facts. No attester can be swapped mid-deal without an amendment (E3) | Global "any accredited attester" (lets one party shop for a friendly attester) |
| D8 | **Self-attestation policy per claim type:** `never`, `corroborate` (accepted from a party only alongside an independent statement), or `always` | A party saying something that helps itself ("I shipped") needs corroboration. A party binding itself ("booking confirmed at this price") doesn't | Banning party statements (loses confirmations and invoices) |
| D9 | **Fail-closed conflict handling:** contradictory valid attestations make the policy stage `REFUSE` with a `CONFLICT` reason, which routes the case to the arbiter | Deterministic. The co-signer never picks a winner among facts | Precedence heuristics in the co-signer |
| D10 | **PII only as salted hashes** in claims (salt from the engagement record). Raw evidence lives off-ledger under access control | Facts stay checkable by parties without becoming public or linkable across deals | Plain hashes (dictionary attacks on postcodes and names) |

---

## 3. The envelope

```json
{
  "v": "eng.att/1",
  "type": "shipping.delivered/1",
  "engagementId": "eng_01JC…",
  "subject": { "trackingRef": "trk:9f41…" },
  "claim": {
    "carrier": "ExampleParcel",
    "deliveredAt": "2026-11-03T14:12:00Z",
    "postcodeHash": "sha256s:b77e…",
    "signedFor": true
  },
  "observedAt": "2026-11-03T14:12:00Z",
  "issuedAt": "2026-11-03T14:20:41Z",
  "validUntil": null,
  "evidence": [
    { "mediaType": "application/json", "hash": "sha256:51c0…", "uri": null, "label": "carrier-api-response" }
  ],
  "supersedes": null,
  "nonce": "b2d6c1…",
  "attester": {
    "account": "rTrackOracle…",
    "kind": "SHIPPING",
    "accreditation": { "issuer": "rEngageRoot…", "credentialType": "ENG/ATTESTER/SHIPPING" }
  },
  "proof": {
    "alg": "xrpl-secp256k1",
    "publicKey": "02A1…",
    "signature": "3045…"
  },
  "id": "att:5e0c…"
}
```

| Field | Required | Meaning |
|---|---|---|
| `v` | ✅ | Envelope version |
| `type` | ✅ | Claim type id with version (§8). Determines the `claim` schema and the self-attestation rule |
| `engagementId` | ✅ unless the type is `scope: global` | Binds the statement to one engagement (Q7) |
| `subject` | ✅ | What the claim is about, in identifiers the engagement record registers (tracking ref, domain, milestone id, invoice no.) |
| `claim` | ✅ | Type-specific payload, validated against the type's JSON Schema |
| `observedAt` | ✅ | When the fact happened (the attester's claim) |
| `issuedAt` | ✅ | When the statement was signed (the attester's claim) |
| `validUntil` | optional | Expiry for facts that go stale (KYB, merchant category, uptime snapshot) |
| `evidence[]` | optional | Hashes of raw material (PDF eBL, photos, API responses). `uri` is optional and access-controlled. Evidence content is **never** a policy input, only for the arbiter |
| `supersedes` | optional | `id` of an earlier statement *by the same attester* that this one corrects |
| `nonce` | ✅ | 16 random bytes, so that two identical observations get distinct ids |
| `attester` | ✅ | XRPL account, kind, and the accreditation it relies on |
| `proof` | ✅ | Signature over the digest (§4). Excluded from the signed bytes |
| `id` | ✅ | `"att:" + hex(digest)`. Excluded from the signed bytes, and must match the recomputed digest |

---

## 4. Signing and verification

**Signing input:**

```
body    = envelope without "proof" and "id"
bytes   = JCS(body)                      // RFC 8785
digest  = SHA-512Half("ENGA\0" || bytes) // 32 bytes, XRPL-style hash with our own prefix
id      = "att:" + hex(digest)
proof.signature = Sign(attesterKey, digest)   // secp256k1 (DER) or ed25519
```

`SHA-512Half` and the key types are what XRPL tooling already provides, so attesters sign with existing XRPL libraries. The `"ENGA\0"` prefix is the domain separator (D2). Party documents use the same prefix: a signed mandate can't be replayed as a transaction, and a transaction signature can't be replayed as a mandate.

**Key authorization:** `proof.publicKey` must derive to `attester.account`'s **master key (if not disabled) or its current `RegularKey`**, at the **trust ledger** (D5):
- **anchored** → the ledger in which the anchor was validated;
- **not anchored** → the co-signer's pinned evaluation ledger.

Multisig attester accounts (e.g. an inspection panel) aren't supported in v1. A panel uses one designated signing account, or several single attestations with an M-of-N rule in policy.

---

## 5. Attester identity and accreditation

**An attester is an XRPL account.** Its accreditation is an **XRPL Credential**:

| Credential field | Value |
|---|---|
| `Issuer` | Accreditor account (service root, industry body, licensed entity) |
| `Subject` | Attester account |
| `CredentialType` | `ENG/ATTESTER/<KIND>` (hex-encoded on-ledger), e.g. `ENG/ATTESTER/SHIPPING`, `…/INSPECTION`, `…/EBL`, `…/REGISTRY`, `…/UPTIME`, `…/MEASUREMENT`, `…/CLASSIFICATION`, `ENG/APPROVER` |
| `URI` | Hash of the **attester profile**: legal entity, jurisdictions, scope (which claim types, value limits), methodology documents, contact, bond reference (§11) |
| `Expiration` | Accreditation term |
| Accepted | Must be accepted by the attester (`lsfAccepted`) to count |

**Validity rule:** the accreditation must exist, be accepted and be unexpired **at the trust ledger**. An accreditor revokes with `CredentialDelete`. Revocation invalidates every **not-yet-consumed** attestation from that attester whose trust ledger is at or after the revocation. Attestations already consumed by an executed outcome stand: the ledger can't un-pay. Revocation *for cause* can additionally be published as a statement of type `registry.revocation/1` listing tainted attestation ids, which the arbiter can use in later disputes.

**Which attesters a deal accepts** (D7). The engagement record gets an `attesters` block, hashed into the open memo with everything else:

```json
"attesters": {
  "shipping": { "accounts": ["rTrackOracle…"] },
  "inspection": { "accreditors": ["rEngageRoot…", "rInspectorsGuild…"], "kind": "INSPECTION" },
  "approver": { "accounts": ["rCFO…", "rController…"], "kind": "APPROVER" }
}
```

A role may name **specific accounts** (preferred when both sides know them) or **accreditor + kind** (any attester accredited by one of these accreditors). Changing the set is an amendment (E3).

---

## 6. Binding, time and replay

**Binding.** A statement applies to an engagement if:
1. `engagementId` equals the engagement's id, **or** the type is `scope: global` (KYB, merchant category, provider uptime feed) **and** its `subject` matches identifiers registered in the engagement record (counterparty account, service id); **and**
2. its `attester` is allowed for that role by the engagement's `attesters` block.

**Time semantics.** Three clocks, used deliberately:

| Clock | Source | Used for |
|---|---|---|
| `observedAt` | Attester claim | **Timer anchors** (inspection window starts at `deliveredAt`), but only within the lag bound below |
| `issuedAt` | Attester claim | Lag check |
| Trust ledger close time | Ledger | Key and accreditation validity. **Upper bound** for both claimed times |

Each claim type declares `maxLagSecs`, the longest allowed gap between `observedAt` and the trust-ledger time. Beyond it, the statement is rejected (`STALE`) or, if the type allows, its timer anchor is clamped to `trustLedgerTime − maxLagSecs`. This stops an attester shortening a buyer's inspection window by backdating `deliveredAt`. `issuedAt` and `observedAt` can never be later than the trust-ledger time (allowing small clock skew).

**Replay and reuse.**
- **Content addressing** means the same statement is the same id everywhere.
- **Engagement binding** stops cross-deal reuse of engagement-scoped statements.
- **Consumption:** types marked `singleUse` (approvals, milestone certificates, ladder measurements) are recorded as consumed when an outcome that relied on them executes. The outcome's Batch memo lists them (§7). A consumed statement can't satisfy another policy stage.
- **Supersession:** a statement with `supersedes: X` from the same attester replaces X for evaluation. Chains resolve to the latest. Supersession from a *different* attester isn't allowed. That's a conflict (§9).

---

## 7. Anchoring and on-ledger projection

Each claim type declares its **anchoring requirement**. The template or policy can only make it stricter.

| Mode | How | Cost | Gives you | Use for |
|---|---|---|---|---|
| `none` | Statement only off-ledger | 0 | Nothing beyond the signature | Context for the arbiter; low-stakes facts |
| `memo` | Any transaction from the attester, a party or the service account with memo `eng/anchor` = `{engagementId, attestationId}` | ~1 tx fee | **Trustworthy time** (D5) and public existence | Stage 0 triggers and timer anchors |
| `credential` | `CredentialCreate` from the **attester** to the **engagement account**: `CredentialType` = `"ENGA:" + hex(digest[0..24])` (53 bytes ≤ 64), `URI` = `id` (75 bytes ≤ 256) | 0.2 XRP reserve (issuer pays, recoverable with `CredentialDelete`) + fee | Trust time, **plus the fact is a ledger object** that Smart Escrow finish functions can read | Stage 3 readiness; high-value triggers |

Notes:
- A Credential is unique per *(subject, issuer, type)*. Putting the digest prefix in `CredentialType` lets one attester project several facts (e.g. three milestone certificates) onto the same engagement account.
- **Anyone** can create a Credential pointing at the engagement account, so a projection only counts if its issuer passes the §5 accreditation and §6 binding checks.
- Projections don't need to be accepted by the engagement account: acceptance would need quorum, and existence + issuer is enough.
- **Outcome memos record what triggered them.** Every outcome Batch (settle, default, ladder rung) carries `eng/basis` = the list of consumed attestation ids, or their Merkle root if they don't fit the 1 KB memo budget. The indexer then has an on-ledger audit trail of *why* money moved.
- **Lifecycle (verified, spike F3):** `AccountDelete` of the engagement account removes projection Credentials issued to it, even unaccepted ones, and releases the attester's 0.2 XRP reserve automatically. A projection is a **live-deal** object. The durable record is the `CredentialCreate` transaction plus the outcome's `eng/basis` memo.

---

## 8. Claim-type registry

Each type is a JSON Schema plus metadata. The registry is versioned and itself published as a signed statement (`registry.types/1`) by the service, so the co-signer pins an exact registry version per engagement.

| Type | Attester kind | Scope | Self-attestation | Anchoring | Single-use | maxLag | Used by |
|---|---|---|---|---|---|---|---|
| `shipping.shipped/1` | SHIPPING | engagement | `never` | memo | no | 24 h | R3 |
| `shipping.delivered/1` | SHIPPING | engagement | `never` | memo | no | 24 h | R3, R6 |
| `inspection.milestone/1` | INSPECTION | engagement | `never` | memo / credential | ✅ | 72 h | R4 |
| `inspection.certificate/1` | INSPECTION | engagement | `never` | credential | ✅ | 72 h | B3 |
| `trade.ebl/1` | EBL | engagement | `never` | credential | ✅ | 24 h | B3 |
| `registry.transfer/1` | REGISTRY | engagement | `never` | memo | ✅ | 6 h | B8 |
| `service.uptime/1` | UPTIME | global (service id) | `never` | memo | ✅ per period | 24 h | B4 |
| `ad.delivery/1` | MEASUREMENT | engagement | `never` | memo | ✅ per period | 72 h | B7 |
| `merchant.category/1` | CLASSIFICATION | global (account) | `never` | none (`validUntil`) | no | n/a | R2, B1 |
| `production.started/1` | (counterparty) | engagement | `corroborate`* | memo | no | 24 h | R6 |
| `approval.payment/1` | APPROVER | engagement | n/a (approvers aren't parties) | none (bound to intent) | ✅ | 1 h | B1 |
| `party.mandate/1` | principal | engagement | `always` | memo (open) | no | n/a | All |
| `party.confirmation/1` | counterparty | engagement | `always` (binds the signer) | memo | no | n/a | R1 |
| `party.invoice/1` | counterparty | engagement | `always` (a claim to be paid, so never a trigger alone) | none | ✅ | n/a | B1, B2 |
| `party.review/1` | principal | engagement | `always` | hash in settle memo | no | n/a | R1 |
| `party.dispute/1` | either party | engagement | `always` | dispute Credential URI | no | n/a | All |
| `party.ruling/1` | arbiter | engagement | n/a | hash in outcome memo | ✅ | n/a | All |
| `party.amendment/1` | P + C (two proofs) | engagement | `always` | memo | ✅ | n/a | R4, R6, B2 |
| `payment.challenge/1` | AGENT (self) | engagement | `always` | none | — | n/a | B1, R2 (x402/MPP) |

\* A dealer saying "production started" increases what the buyer forfeits on cancellation. That's **in the dealer's interest**, so it's accepted only together with the buyer's acknowledgement or an independent `inspection.*` statement. Party statements that **bind the signer** (confirmation, invoice amount, amendment) are `always`.

### 8.1 Example: delivery (R3)

Shown in §3. Policy use:

```json
{ "id": "I1", "stage": "default.release",
  "check": "att.latest('shipping.delivered/1', role: 'shipping') != null && now >= att.latest('shipping.delivered/1', role: 'shipping').anchorTime(inspectionWindow) + duration('48h')",
  "reason": "INSPECTION_WINDOW_OPEN" }
```

`anchorTime()` returns `observedAt`, clamped by the type's `maxLag` against the trust-ledger time (§6).

### 8.2 Example: compliant documents (B3)

```json
{
  "v": "eng.att/1", "type": "trade.ebl/1", "engagementId": "eng_01JD…",
  "subject": { "blRef": "bl:4c9a…" },
  "claim": {
    "platform": "ExampleEBL",
    "status": "issued",
    "onBoardDate": "2026-12-02",
    "portOfLoading": "VNSGN", "portOfDischarge": "NLRTM",
    "goodsDescriptionHash": "sha256s:a0e2…",
    "quantity": { "value": 18000, "unit": "KGM" },
    "holderIsConsigneeBank": false,
    "transferableTo": "importer"
  },
  "observedAt": "2026-12-02T08:00:00Z", "issuedAt": "2026-12-02T08:05:12Z",
  "attester": { "account": "rEBLPlatform…", "kind": "EBL", "accreditation": { "issuer": "rTradeBody…", "credentialType": "ENG/ATTESTER/EBL" } },
  "nonce": "…", "proof": { "alg": "xrpl-ed25519", "publicKey": "ED…", "signature": "…" }, "id": "att:…"
}
```

Policy (the co-signer acting as document examiner, LC-style):

```json
[
  { "id": "D1", "stage": "release.documents", "check": "att.latest('trade.ebl/1', role:'ebl').claim.status == 'issued' && att.latest('trade.ebl/1', role:'ebl').claim.portOfLoading == mandate.goods.portOfLoading", "reason": "EBL_NONCOMPLIANT" },
  { "id": "D2", "stage": "release.documents", "check": "att.latest('inspection.certificate/1', role:'inspection').claim.result == 'pass' && att.latest('inspection.certificate/1', role:'inspection').claim.quantity.value >= mandate.goods.minQuantity", "reason": "INSPECTION_NONCOMPLIANT" },
  { "id": "D3", "stage": "release.documents", "check": "att.latest('trade.ebl/1', role:'ebl').claim.onBoardDate <= mandate.goods.latestShipmentDate", "reason": "LATE_SHIPMENT" },
  { "id": "D4", "stage": "release.documents", "check": "att.consistent(['trade.ebl/1','inspection.certificate/1'], on: 'goodsDescriptionHash')", "reason": "DOCUMENT_DISCREPANCY" }
]
```

### 8.3 Example: payment approval (B1, E10)

An approval is bound to one **payment intent**, not to a transaction hash. The hash changes with sequence numbers and signatures, while the intent doesn't:

```json
{
  "v": "eng.att/1", "type": "approval.payment/1", "engagementId": "eng_01JE…",
  "subject": { "intentHash": "sha256:7d13…" },
  "claim": {
    "intent": { "destination": "rVendorCloud…", "amount": { "asset": "RLUSD", "value": "18500" }, "invoiceRef": "inv:2026-Q4-0042" },
    "notAfter": "2026-11-20T00:00:00Z",
    "approverRole": "controller",
    "comment": "Annual data licence, budget line 4.2"
  },
  "observedAt": "2026-11-18T09:31:00Z", "issuedAt": "2026-11-18T09:31:02Z",
  "attester": { "account": "rController…", "kind": "APPROVER", "accreditation": { "issuer": "rAcmeTreasury…", "credentialType": "ENG/APPROVER" } },
  "nonce": "…", "proof": { "alg": "xrpl-secp256k1", "publicKey": "03…", "signature": "…" }, "id": "att:…"
}
```

The co-signer recomputes `intentHash = SHA-256(JCS(intent))` from the **proposed transaction** (its single payout's destination, its amount as the asset code plus the canonical decimal value with no trailing zeros, and the `eng/invoice` memo) and requires an equal value. `notAfter` sits **outside** the hashed intent: the approver states it separately, and the policy checks `now < notAfter` against the pinned ledger's close time. That way the same intent can be re-approved with a new deadline without changing its hash. Approvals cover single-payout transactions only (W5 requires `tx.payouts.count() == 1`). The approval is `singleUse`, and approver accreditation is issued by the **company's own** treasury account. The service doesn't decide who may approve.

### 8.4 Example: uptime measurement → ladder rung (B4)

```json
{ "type": "service.uptime/1", "subject": { "serviceId": "svc:gpu-pool-eu-1", "period": { "from": "2026-11-01T00:00:00Z", "to": "2026-12-01T00:00:00Z" } },
  "claim": { "uptimePct": 99.42, "probes": 43200, "methodologyHash": "sha256:0f9e…" }, "…": "…" }
```

```json
{ "id": "U1", "stage": "ladder", "check": "rung == ladder.select(att.only('service.uptime/1', role:'monitor', period: eng.period).claim.uptimePct)", "reason": "WRONG_RUNG" }
```

`att.only()` requires **exactly one** valid, non-superseded statement for that period. Zero or several (from different monitors) is a `CONFLICT` → arbiter (D9).

---

## 9. Conflicts, corrections and negative facts

- **Negative facts are first-class.** `inspection.milestone/1` with `result: "fail"` and `shipping.delivered/1` with `claim.status: "returned"` are as valid as positive ones.
- **Corrections:** only the original attester can supersede its own statement. A supersession after the original was **consumed** is accepted for the record, but the outcome stands. The arbiter decides on any remedy, and the indexer flags the attester.
- **Conflicts** (D9): two valid, non-superseded statements of the same type and subject that disagree on a policy-relevant field, or `att.only()` finding more than one, make the stage `REFUSE: CONFLICT`. The co-signer never resolves facts. The arbiter does, with the evidence.
- **Corroboration:** a policy can require **M of N** attesters (`att.quorum(type, role, m)`). That's how inspection panels and self-serving party claims (§8, `production.started`) are handled.

---

## 10. Policy integration

### 10.1 Verification pipeline

Runs inside the co-signer's `decide()` before any rule. It's deterministic at the pinned ledger index:

| Step | Check | Failure code |
|---|---|---|
| 1 | Envelope + claim-type JSON Schema (registry version pinned by the engagement) | `MALFORMED` |
| 2 | Recompute digest; `id` matches | `BAD_ID` |
| 3 | Signature valid for `proof.publicKey` under `alg` | `BAD_SIGNATURE` |
| 4 | Determine trust ledger: anchor ledger if anchored, else evaluation ledger. Check the anchoring requirement is met | `UNANCHORED` |
| 5 | `publicKey` authorized for `attester.account` at the trust ledger | `KEY_NOT_AUTHORIZED` |
| 6 | Accreditation Credential exists, accepted, unexpired at the trust ledger, and not revoked before the evaluation ledger (for unconsumed statements) | `NOT_ACCREDITED` / `REVOKED` |
| 7 | Attester allowed for the role by the engagement's `attesters` block | `ATTESTER_NOT_IN_TERMS` |
| 8 | Binding (engagementId, or global scope + registered subject) | `NOT_BOUND` |
| 9 | Time: `observedAt ≤ issuedAt ≤ trustTime + skew`, lag ≤ `maxLagSecs`, `validUntil` not passed | `STALE` / `FUTURE_DATED` / `EXPIRED` |
| 10 | Self-attestation rule for the type | `SELF_ATTESTED` |
| 11 | Supersession resolution | n/a |
| 12 | Single-use statements not already consumed | `CONSUMED` |

The output is the **verified set**, plus a rejection list with codes. Both go into the decision log, so any decision can be replayed from the same statements and ledger index.

### 10.2 Query functions available to rules

| Function | Returns | Shipped |
|---|---|---|
| `att.latest(type, role)` | Newest verified, non-superseded statement, or `null` | ✅ |
| `att.only(type, role)` | Exactly one, else `CONFLICT` | ✅ |
| `att.list(type, role)` | List, oldest first (`role` `'*'` = any) | ✅ |
| `att.quorum(type, role, m, field)` | True if ≥ m distinct attesters agree on `claim[field]` | ✅ |
| `att.consistent(types[], field)` | True if the field agrees across the given types | planned |
| `x.anchorTime(timerName)` | Timer anchor per §6 (clamped `observedAt`) | planned |
| `x.trustTime()` | Ledger close time of the trust ledger | planned |

Arguments are positional: CEL has no named arguments, so the `role:` / `on:` forms in the examples of §6–§8 are shorthand for the positional call. The list function is `att.list`, not `att.all`, because `all(x, p)` is a CEL macro and a method named `all` collides with it. Each returned statement carries an extra `roles` field with the roles it was verified for. Subject filtering is done in the rule (`.exists(a, a.subject.intentHash == tx.intentHash())`).

### 10.3 Ingestion

`POST /v1/engagements/{id}/statements` accepts any envelope. Attesters can also push to a webhook the facilitator registers with them. Storage is content-addressed and treated as untrusted: anyone can re-submit by id, and the indexer mirrors every statement referenced in an `eng/anchor` or `eng/basis` memo.

---

## 11. Accountability

- **Track record:** the indexer joins every consumed statement with the outcome it triggered and any later ruling. Per attester it publishes volume, conflicts, overturned-by-ruling rate, corrections after consumption, and median lag.
- **Attester bonds:** an attester can post a bond in an **engagement account of its own** (catalog B5 template: attester, accreditor, arbiter, co-signer), slashable by ruling for a false statement. The accreditation profile (`URI`) references the bond. Templates can require bonded attesters above a deal size: *"high-value triggers need an attester with ≥ X RLUSD bonded"*.
- **Liability:** an attester's profile states its liability terms. A licensed attester (inspection agency, eBL platform) usually has legal liability already, which is part of why E11 matters.

---

## 12. Privacy

- **Salted hashes** for personal data: `sha256s:` = SHA-256(engagementSalt ‖ value). The salt is in the (private) engagement record and shared with the parties and the relevant attesters, so the same postcode hashes differently in every deal.
- **Evidence** (`evidence[]`) carries hashes only. Content is shared on a need-to-know basis with the arbiter and parties.
- **On-ledger footprint:** attestation ids (hashes) in anchor and basis memos, and optional projection Credentials holding a digest prefix. No claim content.
- **Indexer:** publishes statistics and ids. Claim content is visible only to engagement parties.
- **Future:** selective disclosure (SD-JWT-style per-field salts) so a party can prove one field (e.g. "delivered in the right postcode") without revealing the rest.

---

## 13. Interoperability (cheap mappings, not dependencies)

| Ecosystem | Mapping |
|---|---|
| **W3C Verifiable Credentials 2.0** | Export: `issuer` = `did:xrpl:<network>:<attester account>`; `credentialSubject` = `{id: engagement or subject, …claim}`; `validFrom` = `observedAt`; proof wraps our signature in a custom cryptosuite (or re-signs with ed25519 under `eddsa-jcs-2022` for ed25519 attesters). Import: a VC from an accredited issuer can be wrapped as `ext.vc/1`, with the VC as evidence |
| **XRPL DID (XLS-40)** | Attester profiles may publish keys and service endpoints as a DID document, referenced from the accreditation `URI` |
| **ERC-8004 Validation Registry / EAS** | Responses from validators can be imported as statements of type `ext.validation/1` when the validator's address is linked to an accredited XRPL attester account |
| **Mastercard Verifiable Intent / AP2 mandates** | Treated as **evidence** attached to `party.mandate/1`. The co-signer checks our envelope, while the external credential is kept for issuer-side checks and disputes |
| **KYA tokens (Skyfire, t54)** | Imported as `ext.kya/1` statements via an accredited bridge attester, so agent identity enters policy the same way as any other fact |

---

## 14. Open questions and testnet checks

1. ~~AccountDelete vs. Credentials issued to the engagement account~~: **resolved** (spike F3). They're removed with the account, and the issuer's reserve is released.
2. **Smart Escrow host functions:** confirm against the XLS-102 host-function list that a finish function can read a Credential by issuer/subject/type, so projection-mode attestations are truly Stage-3 ready.
3. **Registry governance:** who publishes and signs claim-type versions once there are external accreditors? Start with the service, and move to a multi-party registry later.
4. **Clock skew and lag defaults** per type need real data (carrier APIs can lag hours).
5. **Multisig attesters** (v2): accept statements signed by an attester account's SignerList quorum.
6. **Attester economics:** who pays attesters (per statement, per deal, subscription), and whether that fee belongs in the template.
7. **Memo budget:** the max number of ids before switching `eng/basis` to a Merkle root, and the Merkle format (sorted leaves, SHA-512Half).
