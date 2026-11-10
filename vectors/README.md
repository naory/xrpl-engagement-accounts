# Conformance vectors

Test vectors for anyone implementing the engagement-account specs in another language, or checking
that a co-signer behaves like the reference one. They come from the reference implementation
(`packages/*`), and each case declares its own expected outcome. The build stops if the
implementation disagrees with that expectation, so a vector can't silently record a bug.

| File | Spec | Cases | What to compare |
|---|---|---|---|
| `statements.json` | [attestations](../docs/spec/attestations.md) §3–§4 | 6 | JCS bytes, digest, `id`, signature verification (including tampered and wrong-key) |
| `templates.json` | [policy](../docs/spec/policy.md), [hotel](../docs/use-cases/hotel-booking.md) §2 (V1–V12) | 10 | `ok`, error / warning / disclosure ids, minimal winning sets, tickets needed, reserve |
| `policy.json` | [policy](../docs/spec/policy.md) §3–§8 | 41 | `decision`, `failing`, per-rule `results` (layer, id, result, reason), statements used / rejected, `inputsHash`, `effectiveHash` |

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
