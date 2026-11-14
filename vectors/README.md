# Conformance vectors

Test vectors for anyone implementing the engagement-account specs in another language, or checking
that a co-signer behaves like the reference one. They come from the reference implementation
(`packages/*`), and each case declares its own expected outcome. The build stops if the
implementation disagrees with that expectation, so a vector can't silently record a bug.

| File | Spec | Cases | What to compare |
|---|---|---|---|
| `statements.json` | [attestations](../docs/spec/attestations.md) §3–§4 | 6 | JCS bytes, digest, `id`, signature verification (including tampered and wrong-key) |
| `templates.json` | [policy](../docs/spec/policy.md), [hotel](../docs/use-cases/hotel-booking.md) §2 (V1–V12) | 16 | `ok`, error / warning / disclosure ids, minimal winning sets, tickets needed, reserve |
| `policy.json` | [policy](../docs/spec/policy.md) §3–§8 | 155 | `decision`, `failing`, per-rule `results` (layer, id, result, reason), statements used / rejected, `inputsHash`, `effectiveHash` |

## Normative and non-normative fields

- **Normative:** everything under `expect` in the three files.
- **Not normative:**
  - rule `message` and `error` text;
  - `costUnits`, because the cost metric belongs to the implementation and only the "fail closed when over budget" behaviour is specified;
  - English disclosure messages; vectors compare ids only.

## Policy vectors

- `policy.json` has two parts:
  - `context`: templates keyed by `templateId`, and policy layers keyed by their layer hash (`documentHash` of the layer).
  - `cases`: each case's `input` refers to these by reference.
- The procurement and hotel layers have their RLUSD issuer and accepted KYB issuers replaced with fixture accounts. Their layer hashes therefore differ from the files in `policies/`.
- The ledger snapshot inside each input is the complete fact base. Evaluating a vector never touches the network.

The cases cover the following.

**B1 procurement agent** (owner-wallet):
- Rolling daily cap and 90-day budget, including in-flight payments.
- Approval above the threshold, bound to the payment intent. The approval cases cover: wrong intent, expired, attester not named in the terms, stale (max-lag), and consumed (single-use).
- Payee checks: vendor list and KYB credential from an accepted issuer.
- Invoice matching.
- Wrong-issuer IOU.
- A Batch that smuggles in a `SetRegularKey`.
- x402 challenge binding (W7): matching payment, wrong destination, wrong amount.
- Fee cap, missing `LastLedgerSequence`, expired mandate, unknown stage.

**Hotel** (escrow):
- Agreed settle: review required, dispute open, fee mismatch, funds left behind, residual sweep (E9), wrong delete destination, non-atomic Batch.
- Merchant confirmation versus the mandate.
- Pre-signed refund and release defaults: timing, dispute, exact-balance lock, and an extra object that blocks `AccountDelete` (B11, single-shot).

**Hotel@2** (escrow with deposit, `hotel2.*`; template `settlement-vault/hotel@2`, layer `pol_hotel@2.0.0`):
- Confirmation deposit versus the mandate cap (C5) and check-in once the deposit is on-ledger (K2).
- Agreed settle with a claim: fee and review, payees limited to guest, hotel and fee account (S6).
- Conceded entry dispute refund (F1): concession required, entry phase only, dispute Credential issued by the guest.
- Default refund (never confirmed, over-cap confirmation does not count; stray money swept back to the guest, R4; refused under B11 when the guest cannot receive: DepositAuth, no trust line, limit too low) and no-show release (N1 to N8): bonded disputes only, strict deadlines, and the two pre-signed no-show variants: exact room price, or a residual sweep returning a partial deposit or stray money to the guest (refused by B11 when it would deliver nothing); a recorded check-in with the deposit in is final.
- Default release after the dispute window (L1 to L6): open claim, stray funds swept to the guest, open dispute, strict boundary at `disputeWindowEnds`.
- Chargeback-style defaults when the arbiter misses its ruling deadline: entry (E1 to E4, everything to the guest), claim (G1 to G5, room to the hotel less the fee, the rest swept to the guest) and per-night stay variants (Y1 to Y5, the nights used to the hotel; night boundaries from the scheduled check-in, the last night via the claim chargeback, no variants past 14 nights); a receipted arbiter ruling blocks each of them.
- Later hardening vectors: chargeback floors (backdated disputes and receipts), entry-dispute and stay-dispute deposit top-ups that must not flip an outcome, claim lapse (an unanswered claim releases once `disputeWindowEnds` + the ruling window passes; an unbonded dispute does not block it), arbiter rulings that block chargebacks only when they follow the case opening, and a receipted dispute staying open after its Credential is deleted. Accreditation itself is checked by the co-signer at registration, not by a policy vector.
- Advisory `ruling.default`: claim capped at the deposit (D4) and payouts matching the claim (D5).

## Rebuilding and checking

```bash
npm run vectors:build    # rewrites vectors/*.json from vectors/cases.ts
npm run vectors:check    # replays policy.json through decide()
npm test                 # also replays statements.json and templates.json
```

The build is deterministic:
- Keys come from fixed entropy (`packages/policy/test/fixtures.ts`).
- Nonces come from a counter.
- Both signature schemes are deterministic.

A rebuild with no code changes therefore produces byte-identical files. Treat any diff as a behaviour change and review it.

> All keys and seeds in these files are **test-only**, derived from public strings. Never fund them on any network.
