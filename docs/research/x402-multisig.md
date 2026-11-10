# x402 for engagement accounts: facilitator interoperability

> Status: resolved. Engagement accounts pay through x402 using our own settlement
> adapter, [`x402-xrpl-settlement-adapter`](https://www.npmjs.com/package/x402-xrpl-settlement-adapter)
> (published, 0.3.0). The live flow is walked through in
> [the x402 purchase use case](../demo/x402-purchase.md).

## Why it matters

An engagement account is multisig-only:

- its master key is disabled at pre-create;
- the RegularKey is cleared at open;
- every payment carries a `Signers` array (for example agent + co-signer in B1), with `SigningPubKey: ""`.

The README (§8) and the catalog (B1 card, §6) assumed that small, per-call payments from
such an account could go through ordinary x402 `exact` facilitators, with larger conditional
deals using the proposed `engagement` scheme. That assumption needed testing: can the
facilitators that exist today carry a multisigned payment from a master-disabled account that
also needs to carry engagement memos?

## What the reference facilitator does

**Package:** `@x402/xrpl` (x402 Foundation monorepo, `typescript/packages/mechanisms/xrpl`).
Inspected at 2.26.0 (2026-09-15) and 2.28.0 (2026-09-29), from `dist/cjs/exact/facilitator/index.js`.

| Check | Code (2.28.0) | Effect on an engagement account |
|---|---|---|
| `transaction.Signers !== undefined` → `invalid_exact_xrpl_payload_multisig_not_supported` | explicit reject | **Every engagement payment is refused** |
| Empty `SigningPubKey` → `invalid_exact_xrpl_payload_signature` | `verifySignerAuthorization` | Refused (multisig blobs have an empty `SigningPubKey`) |
| Signing key must be the master key (not disabled) or the account's `RegularKey` | `verifySignerAuthorization` | Refused: the engagement account has neither |
| `transaction.Memos !== undefined` → `invalid_exact_xrpl_payload_memos_not_allowed` | explicit reject | Our `eng/basis` (baseline B8) and `eng/invoice` (B1 W6) memos are refused |
| `Delegate` present → `…delegate_not_allowed` | explicit reject | XLS-75 delegated payments are refused too |
| `tfPartialPayment`, `Paths`, `DeliverMin` rejected; IOUs need `SendMax` (same currency/issuer, ≥ amount) | safety checks | Residual sweeps can't be x402 payments. Fine — they're closes, not purchases |
| Invoice binding: `InvoiceID = SHA-256(invoiceId)` | `invoiceIdToInvoiceIdField` | Usable. This is the binding we adopt (below) |

The scheme spec ([`scheme_exact_xrpl.md`](https://raw.githubusercontent.com/x402-foundation/x402/main/specs/schemes/exact/scheme_exact_xrpl.md)):

- requires `/verify` to "validate the signature offline";
- lists `Memos` and `Delegate` among the fields a facilitator MUST reject;
- does not mention multisig.

So the multisig refusal is the implementation's choice, not something the spec forces. The
spec text leaves room for a facilitator that verifies `Signers` against the account's SignerList.
But as shipped, the reference `exact` facilitator cannot carry an engagement-account payment:
the co-signer's signature is exactly what it rejects, and the engagement memos are rejected too.

## Hosted facilitators

t54 runs the hosted facilitators listed on
[xrpl.org](https://xrpl.org/docs/agents/agentic-payments-x402) and publishes the Python SDK
`x402-xrpl`. We evaluated whether an engagement-account payment — a multisigned blob from a
master-disabled account, carrying the `eng/basis` + `eng/invoice` memos with invoice binding —
is something we could rely on a hosted facilitator to accept and settle:

- the published client/SDK signs with a single `xrpl.wallet.Wallet`; nothing in it handles
  multisig, so the multisigned engagement shape is outside the client's documented path;
- memo handling is conditional (the facilitator's documented rule requires the invoice id to
  appear among decoded memos whenever `Memos` is non-empty), which differs from the reference
  facilitator and is a behaviour we would be depending on rather than a specified guarantee.

A Testnet probe ([`packages/cosigner/demo/x402-probe.ts`](../../packages/cosigner/demo/x402-probe.ts),
`npm run probe:x402`) exercises engagement-shaped payments against a hosted `/verify` so the
behaviour can be re-checked over time. The conclusion of the evaluation was that
**engagement-account payments are not a supported, specified path on the hosted facilitators we
tested, and there is no public roadmap for when multisigned engagement-account settlement would
become one.** Rather than build on unspecified behaviour, we chose to ship our own adapter.

## What we built

[`x402-xrpl-settlement-adapter`](https://www.npmjs.com/package/x402-xrpl-settlement-adapter)
(0.3.0) carries the two schemes an engagement account needs:

1. **`prepaid`** — the engagement path used today. The agent submits its own multisigned
   `Payment` (co-signed by the policy co-signer) and returns the transaction hash; the merchant
   verifies the *validated* transaction on-ledger. Multisig needs no special handling here: the
   ledger has already enforced the SignerList and quorum, so verifying the validated transaction
   is enough. The payment keeps its `eng/basis` and `eng/invoice` memos (which the `exact` scheme
   forbids) and carries the adapter's x402 memo (`paymentId`), which the merchant binds. This is
   the flow B1 and R2 engagement spends use. Full walkthrough:
   [x402 purchase](../demo/x402-purchase.md).
2. **`exact`** — the interop path for ordinary single-signed x402 clients. Offline verification,
   including verifying `Signers` against the account's SignerList at the pinned ledger and the
   `InvoiceID = SHA-256(invoiceId)` binding. This is also the reference for proposing multisig
   support upstream.

## Implications for the design

1. **Invoice binding works for both forms.** `tx.boundToInvoice(ref)` is true when the payment's
   `InvoiceID == SHA-256(ref)` (the `exact` scheme) **or** its `eng/invoice` memo equals `ref`
   (the `prepaid` scheme). The intent hash keeps `invoiceRef` as the vendor-visible string.
2. **W7 binds a co-signature to the x402 challenge.** The agent submits a self-attested
   `payment.challenge/1` statement (destination, amount, invoiceId, resource), and the co-signer
   refuses to sign unless the single payout's destination and amount match it and
   `tx.boundToInvoice(invoiceId)` holds. So the engagement account can't be made to co-sign a
   payment that doesn't settle the purchase it was told about.
3. **Baseline B8 (basis memo) needs an x402 mode.** When a stage's transactions go through a
   no-memo facilitator (`exact`), the basis lives only in the signed decision record
   (`cosigner.decision/1`, whose `subject.proposedTxHash` already binds it). Proposed: a
   `params.memoFreeStages` list under which B8 is `n/a`.
4. **Delegation (XLS-75) doesn't help here.** The reference facilitator rejects `Delegate` too.
   Delegation changes who may *sign for* an account, not what an x402 facilitator will accept.
5. **Upstream path remains open.** The `exact` spec text allows verifying `Signers` against the
   SignerList; our adapter's `exact` verifier is a working reference for proposing that to the
   x402 Foundation. A drafted proposal is at
   [docs/proposals/x402-exact-multisig.md](../proposals/x402-exact-multisig.md). The `engagement`
   scheme (README §8) is the portable long-term home for conditional, multi-party deals.

## Sources

- x402 Foundation, XRPL exact scheme spec: <https://raw.githubusercontent.com/x402-foundation/x402/main/specs/schemes/exact/scheme_exact_xrpl.md>
- `@x402/xrpl` on npm (2.26.0, 2.28.0), `dist/cjs/exact/facilitator/index.js`
- XRPL.org, Agentic payments with x402: <https://xrpl.org/docs/agents/agentic-payments-x402>
- t54 `x402-xrpl` (PyPI): <https://pypi.org/project/x402-xrpl/>
- `x402-xrpl-settlement-adapter` on npm: <https://www.npmjs.com/package/x402-xrpl-settlement-adapter>
