## Title

The form prepends `[Feature]: ` automatically, so type only:

> specify offline multisig (SignerList/quorum) verification in the exact XRPL `/verify`

## Field — "Problem or use case"

The `exact` XRPL scheme (`specs/schemes/exact/scheme_exact_xrpl.md`) requires `/verify` to validate
the signature offline (§10) but says nothing about **multisig** — `Signers`, `SigningPubKey`, or the
account `SignerList`. So there is no rule for a facilitator to conform to when a payer is a
multi-signing account.

Multisig is the norm for the accounts agentic payments most want to serve: institutional/custodial
XRPL accounts, co-signed treasuries, and bounded agent wallets (master key disabled, a `SignerList`
+ quorum, every `Payment` carrying `Signers` with an empty `SigningPubKey`). None of these can use
`exact` today — the reference facilitator (`@x402/xrpl`, 2.26.0 / 2.28.0) rejects any `Signers`
(`...multisig_not_supported`) and any empty `SigningPubKey`, so a master-disabled multisig account is
locked out.

This is XRPL-mechanism-specific — it touches `scheme_exact_xrpl.md` and `@x402/xrpl`, not the core
spec or the chain-agnostic `exact` overview. I've discussed the XRPL multisig case with t54, who are
supportive of specifying it.

## Field — "Proposed solution"

Add to **§10 Signature Validation**: when `tx_json.Signers` is non-empty, verify offline, exactly as
`rippled`'s `checkMultiSign` does, against the payer's `SignerList` at the validated ledger —

- `SigningPubKey` empty; 1–32 `Signers` sorted by account, no duplicates, and the payer not signing
  for itself;
- each `TxnSignature` valid (canonical key, fully-canonical signature) over
  `encodeForMultisigning(tx, signerAccount)`;
- each signer authorized: if the signer's account exists on the ledger, its `RegularKey` or its
  master key unless `lsfDisableMaster`; if it does not exist, the key must derive to the signer's
  address (its implicit master key);
- summed `SignerWeight` ≥ `SignerQuorum`.

Plus one rule in **§9 Safety Checks**: *a facilitator that does not implement multisig verification
MUST reject `Signers`, not return `valid`.* Additive — single-signer and the `PaymentPayload`
envelope are unchanged. (Error identifiers would be a proposal; the spec currently defines only
`duplicate_settlement`.) Scope is multisig verification only — not `Memos`/`Delegate`, and separate
from any `engagement`-scheme idea.

I can bring a full write-up (algorithm, offline-safety rationale, security notes), a ready-to-paste
in-format amendment to `scheme_exact_xrpl.md` (§10 + §9 + Security Considerations), and an Apache-2.0
reference verifier (`x402-xrpl-settlement-adapter`, `./exact` → `verifyExactPayload`) that implements
it offline, with deterministic negative conformance vectors (below-quorum, a signer not on the
`SignerList`, tampered-after-signing). Happy to open the PR against `scheme_exact_xrpl.md` once the
approach looks right.

_Disclosure: this proposal and its reference materials were drafted with AI assistance and reviewed
by me before posting._
