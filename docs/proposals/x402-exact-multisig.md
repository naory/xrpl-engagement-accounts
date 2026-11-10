# Proposal: multisig (SignerList) verification for the XRPL `exact` scheme

> A proposed, backward-compatible amendment to the x402 `exact` XRPL scheme
> ([`scheme_exact_xrpl.md`](https://raw.githubusercontent.com/x402-foundation/x402/main/specs/schemes/exact/scheme_exact_xrpl.md))
> adding a normative offline algorithm for verifying a `Payment` that carries a `Signers` array
> against the payer account's `SignerList` and quorum. Submitted by the
> [`xrpl-engagement-accounts`](../../README.md) project. Contact: `<contact>`.
>
> Scope: **the XRPL chain-implementation spec only** — specifically §10 (Signature Validation) and
> the Security Considerations of `scheme_exact_xrpl.md`. It does **not** change the core x402 spec,
> the chain-agnostic `exact` overview, or the `PaymentPayload` envelope, and it leaves the scheme's
> no-`Memos`/no-`Delegate` rules untouched. Multisig verification only, and independent of the
> separate `engagement`-scheme idea.
>
> Submission kit: a ready-to-paste GitHub issue
> ([`x402-exact-multisig.issue.md`](x402-exact-multisig.issue.md)) and the in-format spec amendment
> ([`x402-exact-multisig.spec-edit.md`](x402-exact-multisig.spec-edit.md)).


## 1. Summary

The `exact` XRPL scheme requires `/verify` to "validate the signature offline" (§10) but says
nothing about **multisig**: `Signers`, `SigningPubKey`, or the account `SignerList`. With no
normative rule, implementations have diverged, and the reference facilitator rejects multisig payments outright (§4). We propose adding a precise offline
algorithm so a facilitator can verify a multisigned XRPL `Payment` — the signatures against the
payer's `SignerList` entries and the summed weights against the quorum, all at a pinned validated
ledger — exactly as it already verifies a single signer's authorization today. The change is purely
additive: payments without `Signers` are unaffected, and the `PaymentPayload` envelope is unchanged.
A working, Apache-2.0 reference verifier and a conformance probe are offered (§6).

**Scope and venue.** This amends the **XRPL chain-implementation** spec
(`specs/schemes/exact/scheme_exact_xrpl.md`) and its reference mechanism (`@x402/xrpl`), not the
core spec or the chain-agnostic `exact` overview — the whole mechanism (`SignerList`, quorum,
`encodeForMultisigning`) is XRPL-native. The reviewers are therefore the XRPL mechanism maintainers,
**t54** (hosted facilitators + the `x402-xrpl` Python SDK), and **Ripple's** XRPL agentic-payments
team — not a cross-chain audience. It is **not** an XRPL-Standards (XLS) matter: the ledger already
enforces multisig; this is facilitator-side verification. The one chain-agnostic idea here — that a
facilitator unable to verify a signature form MUST reject rather than return `valid` (§5) — is noted
as an optional follow-up against the core `/verify` contract, since threshold/multisig recurs on
other chains.

## 2. Motivation

**Multisig is the norm for the accounts x402 most wants to serve.** Institutional and custodial
XRPL accounts, co-signed treasuries, and bounded agent wallets are multisig by construction: the
master key is disabled, no `RegularKey` is set, and every `Payment` carries a `Signers` array with
an empty `SigningPubKey`, authorized by a `SignerList` + quorum. These are precisely the payers an
agentic-payments standard should accommodate — yet none of them can use `exact` today.

Our own case is a concrete instance: an **engagement account** is a single-use account opened with
the master key disabled and a `SignerList {owner, agent, co-signer}` at quorum 2, so an agent's
payment is only valid once a policy co-signer adds the second signature the ledger requires. That
is a general shape (an agent key that cannot move funds alone), not a quirk of ours.

## 3. The spec is silent; `/verify` "MUST validate the signature offline"

`scheme_exact_xrpl.md` §10 is normative: *"/verify MUST validate the signature offline."* §9 lists
the fields a facilitator MUST reject (`Memos`, `Delegate`, `SendMax` for XRP, `Paths`,
`DeliverMin`, `tfPartialPayment`, fee over policy, both/neither `Amount`/`DeliverMax`). The document
**does not mention** `Signers`, `SigningPubKey`, or `SignerList` anywhere. So how a facilitator
treats a multisigned transaction is unspecified — left to each implementation.

## 4. The cost of leaving it unspecified

With no normative rule, the shipped XRPL `exact` reference implementation locks these accounts out:

**The reference facilitator rejects all multisig — locking the accounts out.**
`@x402/xrpl` (x402 Foundation monorepo, `typescript/packages/mechanisms/xrpl`, inspected at 2.26.0
and 2.28.0, `dist/cjs/exact/facilitator/index.js`) rejects:

- `transaction.Signers !== undefined` → `invalid_exact_xrpl_payload_multisig_not_supported`;
- an empty `SigningPubKey` → `invalid_exact_xrpl_payload_signature`;
- a signing key that is not the (non-disabled) master key or the account's `RegularKey`.

A master-disabled multisig account satisfies none of these, so every multisigned payment is refused.

The root cause is the absence of a normative algorithm to conform to: the reference facilitator fails closed and excludes a large, legitimate class of payers. A specified algorithm fixes that.

## 5. Proposed normative change

Add a **Multisig** subsection to the `exact` XRPL scheme. When a `Payment`'s `Signers` is a
non-empty array, `/verify` performs this offline check **in addition to** all existing `exact`
checks (destination, amount/asset, forbidden fields, sequence/ticket, `LastLedgerSequence` window,
fee policy, invoice binding), which are unchanged:

1. **`SigningPubKey` MUST be empty.** A non-empty `SigningPubKey` alongside `Signers` is malformed →
   reject (`invalid_transaction`).
2. **Read the payer's account state at a pinned validated ledger.** The payer MUST exist and MUST
   have a non-empty `SignerList`; otherwise reject (`account_not_found` / `signer_not_authorized`).
   (This is the same validated-ledger read `exact` already performs to check `Sequence` and the
   single-signer authorization.)
3. **Verify each `Signers[i].Signer` against the SignerList**, matching `rippled`'s `checkMultiSign`.
   Construct the multisigning payload — the transaction with `SigningPubKey` set to `""` and
   `Signers`/`TxnSignature` removed. The `Signers` array MUST hold 1–32 entries, sorted by account
   ascending, with no duplicate accounts, and the payer MUST NOT sign for itself. For each entry:
   - the `Account` MUST appear on the payer's `SignerList` (else `signer_not_authorized`);
   - its `TxnSignature` MUST verify over `encodeForMultisigning(payload, Signer.Account)` using the
     entry's `SigningPubKey`, which MUST be a canonical public key with a fully-canonical signature
     (else `signature_invalid`);
   - the key MUST be authorized **for that signer account**, which — unlike the payer — **need not
     exist on the ledger**: if the signer account does **not** exist, the `SigningPubKey` MUST derive
     to the signer's address (its implicit master key); if it **does** exist, the key MUST be its
     `RegularKey`, or its master key unless `lsfDisableMaster` is set. Note `checkMultiSign` does
     **not** apply `checkSingleSign`'s post-`fixMasterKeyAsRegularKey` relaxation: a signer's own
     master key is refused when that account has `lsfDisableMaster`, even if its `RegularKey` equals
     its own address.
4. **Quorum.** Sum the `SignerList` weights of the verified signers; the total MUST be ≥ the
   `SignerList`'s `SignerQuorum`, else reject (`quorum_not_met`).

> The unfunded-signer rule matters in practice: a bounded agent wallet's signer keys (e.g. an
> engagement account's agent and co-signer) are typically **not** funded accounts, so requiring each
> signer's account to exist would wrongly reject the exact payers this proposal exists to serve.

Error identifiers are a **proposal**: the published `scheme_exact_xrpl.md` defines only
`duplicate_settlement`, so there is no error taxonomy to extend (the `invalid_exact_xrpl_payload_*`
strings in §4 are the *reference implementation's*, not the spec's). Suggested:
`multisig_signer_not_authorized`, `multisig_quorum_not_met`, `multisig_signature_invalid`,
`multisig_account_not_found`. The behavior is the normative part; the names can follow whatever
convention the maintainers prefer.

**One normative anti-footgun:** *a facilitator that does not implement
multisig verification MUST reject a transaction carrying `Signers` (as the reference facilitator
does) and MUST NOT return `valid`.* Silent acceptance of an unverified multisig payment is
non-conforming.

**`/settle`.** A `SignerList` can change between `/verify` and `/settle` — the same race that
already exists for a single signer's `RegularKey`. `/settle` re-checks against the ledger at
submission, and the validated ledger remains the final arbiter; this proposal does not change that.

## 6. Why offline verification is sufficient and safe

This adds no new trust assumption. Single-signer `exact` already reads the payer's validated-ledger
account state to confirm the signing key is the master or `RegularKey`; multisig verification reads
the same account's `SignerList` and quorum instead, and checks each signature with the standard XRPL
`encodeForMultisigning` serialization. It is the exact computation `rippled` itself performs to admit
a multisigned transaction, done offline against a pinned validated ledger. No mempool, no
submission, no extra endpoints.

## 7. Backward compatibility

- **Additive.** A transaction with no `Signers` takes the existing single-signer path unchanged.
- **Envelope unchanged.** The `PaymentPayload` is the same base64 JSON with `payload.signedTxBlob`;
  a multisigned blob already carries `Signers` and an empty top-level `SigningPubKey`. No new fields.
- **Opt-in signalling (optional).** A facilitator MAY advertise multisig support via a capability
  flag; absent support, §5's anti-footgun rule requires it to reject `Signers` rather than accept.
- **No change to `Memos`/`Delegate`.** `exact` keeps forbidding both. Memo-carrying flows (e.g. an
  engagement payment that also needs `eng/basis`/`eng/invoice` memos) are **out of scope** here;
  they settle through other means (a push/`prepaid`-style flow, or a future `engagement` scheme).
  The target of this proposal is a memo-free multisigned `exact` payment — which, with memos handled
  separately, is enough to admit multisig payers to `exact`.

## 8. Reference implementation and conformance

A working reference verifier implementing §5 exactly is published, Apache-2.0:
[`x402-xrpl-settlement-adapter`](https://www.npmjs.com/package/x402-xrpl-settlement-adapter)
→ `verifyExactPayload` (module `./exact`). It verifies `Signers` against the `SignerList` at a
pinned validated ledger, enforces quorum, de-duplicates signers, checks per-signer key
authorization, and applies the invoice binding (`InvoiceID == SHA-256(invoiceId)`) and all other
`exact` checks. It runs fully offline given a `fetchAccountState(network, account)` reader.

(One correction surfaced in review: a signer's account need not exist on the ledger — its key need
only derive to the signer's address — so the reference verifier's per-signer authorization must
accept **unfunded** signers. A regression test covering the unfunded-signer case, and the
`lsfDisableMaster`/`RegularKey`-equals-self edge from §5 step 3, is being added to the adapter.)

Offered as conformance material:

- deterministic positive/negative **test vectors** over the §5 algorithm;
- the Testnet **probe** (`npm run probe:x402`) with deterministic negative cases (N1/N2/N3/N5/N6/N7) that a conforming `/verify` MUST reject. These make a good baseline
  for a scheme conformance suite.

## 9. Suggested spec edits

1. Extend **§10 Signature Validation** of `scheme_exact_xrpl.md` with the multisig algorithm (§5
   steps 1–4), including a `Signers` JSON example; the single-signer path is unchanged.
2. Add the anti-footgun MUST to **§9 Safety Checks (MUST)**: a facilitator that does not implement
   multisig verification MUST reject a transaction carrying `Signers` and MUST NOT return `valid`.
3. Add a **"Multisig Authorization Scope"** note under **Security Considerations** (SignerList read
   at the validated ledger, quorum, duplicate-signer and key-authorization checks, and re-check at
   `/settle` since a `SignerList` can change between verify and settle).
4. Add negative multisig cases to the conformance set (below-quorum, non-SignerList signer,
   tampered-after-signing). The ready-to-paste amendment text for 1–3 is in
   [`x402-exact-multisig.spec-edit.md`](x402-exact-multisig.spec-edit.md).

## 10. What this is not

- Not a change to `Memos`, `Delegate`, partial payments, paths, or the envelope.
- Not the `engagement` scheme (conditional, multi-party, escrowed deals) — that is a separate,
  larger proposal; this is the minimal step that unblocks ordinary multisig payers on `exact`.

## Sources

- x402 `exact` XRPL scheme: <https://raw.githubusercontent.com/x402-foundation/x402/main/specs/schemes/exact/scheme_exact_xrpl.md>
- `@x402/xrpl` on npm (2.26.0, 2.28.0), `dist/cjs/exact/facilitator/index.js`
- Reference verifier: `x402-xrpl-settlement-adapter` (`./exact` → `verifyExactPayload`) — <https://www.npmjs.com/package/x402-xrpl-settlement-adapter>
- Probe + findings: [`docs/research/x402-multisig.md`](../research/x402-multisig.md), [`packages/cosigner/demo/x402-probe.ts`](../../packages/cosigner/demo/x402-probe.ts)
- XRPL multisigning (`encodeForMultisigning`, `SignerListSet`): <https://xrpl.org/docs/concepts/accounts/multi-signing>
