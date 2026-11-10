# Use case: an engagement account pays an x402 merchant

> How a bounded, multisig engagement account (the [B1](b1-procurement.md) agent) pays an x402
> merchant, end to end. It ties together the co-signer (rule **W7**), the settlement adapter
> ([`x402-xrpl-settlement-adapter`](https://www.npmjs.com/package/x402-xrpl-settlement-adapter)),
> and the engagement-account mechanics.
>
> Runs on XRPL Testnet: [`packages/cosigner/demo/x402/b1-x402-testnet.ts`](../../packages/cosigner/demo/x402/b1-x402-testnet.ts)
> (`npm run demo:x402`), X1–X4. In-process integration test:
> [`merchant.test.ts`](../../packages/cosigner/demo/x402/merchant.test.ts) (`npm run test:x402`).
> Why we ship our own adapter: [x402-multisig research](../research/x402-multisig.md).

## 0. The deal in one paragraph

An agent needs to buy a resource from an x402 merchant, and it pays from a [B1](b1-procurement.md)
engagement account — a single-use, multisig account (master disabled, SignerList {owner 2, agent
1, co-signer 1}, quorum 2) funded with the owner's budget. The merchant answers the agent's
request with an HTTP **402** challenge. The agent builds the payment, the **policy co-signer
co-signs it only if it matches the challenge** (rule W7), the agent submits the multisigned
`Payment` to XRPL, and then hands the merchant the transaction hash. The merchant **verifies the
validated transaction on-ledger** and serves the resource. The agent never gets the resource
without paying the exact amount to the exact merchant, and the engagement account can never be
made to co-sign a payment that doesn't settle the purchase it was told about.

## 1. Cast and accounts

| Party | Who | Role |
|---|---|---|
| **Engagement account** | the [B1](b1-procurement.md) account, `rEng…` | multisig payer (master disabled, quorum 2) |
| **Agent** | agent key (SignerList weight 1) | builds the payment, declares the x402 challenge, submits, calls the merchant |
| **Policy co-signer** | the service (weight 1) | co-signs only if W7 and the rest of the policy pass |
| **Merchant** | an x402 seller, `rVendorA…` | issues the 402 challenge, verifies settlement, delivers |
| **Owner, KYB issuer, …** | as in [B1](b1-procurement.md) | the merchant is a mandate vendor holding a `KYB_VERIFIED` credential |

The merchant is an ordinary payee (a mandate vendor). It is **not** on the SignerList — it never
signs the payer's transaction; it only reads the ledger to confirm it was paid.

## 2. Scheme: `prepaid`, not `exact`

The adapter carries two x402 schemes. Engagement accounts use `prepaid`.

| | `exact` | `prepaid` (used here) |
|---|---|---|
| Who submits | the facilitator settles the client's signed blob | the **payer** submits its own transaction |
| Verification | offline: signature (incl. `Signers` vs the SignerList) + `InvoiceID = sha256(invoiceId)` | on-ledger: the merchant reads the **validated** transaction |
| Memos | **forbidden** | allowed — the payment keeps `eng/basis` + `eng/invoice` |
| Multisig | supported offline, for single-blob clients | nothing special — the ledger already enforced the SignerList and quorum |

An engagement-account payment must carry an `eng/basis` memo (baseline B8) and an `eng/invoice`
memo (W6), which the `exact` scheme rejects outright. And because the payment is multisigned by
the engagement quorum, the cleanest proof that it is valid and final is that **the ledger already
accepted it**. So the engagement path is `prepaid`: the agent submits, the merchant verifies the
validated transaction. (`exact` remains the interop path for ordinary single-signed x402 clients.)

## 3. The adapter

[`x402-xrpl-settlement-adapter`](https://www.npmjs.com/package/x402-xrpl-settlement-adapter) (0.3.0)
provides the x402 v2 envelope (header encode/decode, `PaymentRequired` / `PaymentPayload` /
`SettlementResponse`), `createChallenge` / `toPaymentRequirements`, the `prepaid` settlement
verifier `verifySettlement`, and a replay store. The demo merchant
([`merchant.ts`](../../packages/cosigner/demo/x402/merchant.ts)) is a thin wrapper over it.

## 4. The messages

Standard x402 v2 over HTTP headers (base64 JSON):

1. **`PAYMENT-REQUIRED`** (merchant → agent, `402`). The merchant's `accepts[0]` requirement:
   scheme `prepaid`, network (CAIP-2, e.g. `xrpl:1`), `amount`, `asset` (RLUSD issuer), `payTo`
   (the merchant), `maxTimeoutSeconds`, and an `invoiceId` the merchant minted. The merchant also
   tells the agent which XRPL memo to attach (the adapter's x402 memo carrying `paymentId =
   invoiceId`).
2. **`PAYMENT-SIGNATURE`** (agent → merchant, the retry). The `prepaid` payload is simply
   `{ txHash }` — the hash of the validated payment — echoing the accepted requirement.
3. **`PAYMENT-RESPONSE`** (merchant → agent, `200`). A `SettlementResponse`: success, the
   transaction hash, network, payer, amount. The resource body is delivered alongside.

The merchant always rebuilds and verifies against **its own** requirement for the invoice id it
issued, never the client's echoed copy — a client can't lower the price or invent an invoice id.

## 5. The payment

A `Payment` from the engagement account to the merchant, built by the agent:

- `Amount` = the challenge amount in RLUSD;
- `Destination` = the merchant (`payTo`);
- `Memos` = `eng/basis = spend` (B8), `eng/invoice = <invoiceId>` (W6), **and** the adapter's x402
  memo (`paymentId = invoiceId`), which is what the merchant binds;
- `SigningPubKey: ""`, `Signers` = [agent, co-signer] once co-signed.

Before co-signing, the agent declares a self-attested **`payment.challenge/1`** statement (scheme `x402`)
(`payTo`, `amount`, `invoiceId`, `resource`). Rule **W7** fires because a challenge is present and
requires: exactly one payout, its destination ∈ the payment's destinations and equal to the
challenge `payTo`, its amount equal to the challenge amount, and `tx.boundToInvoice(invoiceId)`
(the `eng/invoice` memo equals the invoice id). If any of that doesn't hold, the co-signer
refuses and produces no signature.

## 6. Merchant verification (`prepaid` settlement)

Given `{ txHash }`, the merchant calls `verifySettlement`, which reads the transaction from the
ledger and checks:

- it is **validated** and `meta.TransactionResult == tesSUCCESS`;
- `Destination` is the merchant and `delivered_amount` equals the challenge amount and asset;
- the x402 memo binds the transaction to this `invoiceId`;
- the receipt hasn't been seen before (a replay store makes delivery **idempotent**).

Multisig needs no special handling at this step: the ledger already enforced the SignerList and
quorum when it validated the transaction, so a validated `tesSUCCESS` payment to the merchant for
the right amount is proof of payment.

## 7. The sequence

1. The **trust service / owner** has already opened the engagement account for the agent (see
   [B1 §6](b1-procurement.md#6-xrpl-transactions)): master disabled, SignerList {owner 2, agent 1,
   co-signer 1}, quorum 2, funded with RLUSD, the merchant a KYB'd mandate vendor.
2. The **agent** requests the resource; the **merchant** replies `402 PAYMENT-REQUIRED` (scheme
   `prepaid`, amount, `payTo`, a fresh `invoiceId`, the required memo).
3. The **agent** builds the `Payment` to the merchant with the three memos, and declares the
   `payment.challenge/1` statement.
4. The **agent** sends the multisigned blob + statements to the **co-signer**, which evaluates the
   baseline + procurement policy; **W7** binds its signature to the challenge. On pass it returns
   its signature.
5. The **agent** combines the agent + co-signer signatures and **submits** to XRPL; the ledger
   validates the multisig and applies the payment.
6. The **agent** retries the merchant with `PAYMENT-SIGNATURE = { txHash }`.
7. The **merchant** verifies the validated transaction on-ledger and returns `200
   PAYMENT-RESPONSE` with the resource. A repeat of the same receipt returns `200` idempotently
   and does not re-deliver.

## 8. The live demo (`npm run demo:x402`)

Fresh faucet accounts; opens the engagement account, then runs the round trip against an
in-process merchant built on the adapter, with a real on-ledger `fetchTransaction`.

| # | Step | Expected | What it proves |
|---|---|---|---|
| **X1** | Open the engagement account | tesSUCCESS; master disabled, quorum 2, funded | The payer is a real, correctly governed engagement account. |
| **X2** | 402 → agent + co-signer pay 800 (W7 binds the co-signature to the challenge) → submit → merchant verifies the validated tx on-ledger → deliver | SIGN; W7 pass; tesSUCCESS; merchant `200` with the resource; merchant +800 | The whole chain works: policy-bound co-signature, real multisig settlement, on-ledger verification, delivery. |
| **X3** | Agent replays the same receipt | `200`, idempotent, no re-delivery | Settlement verification is replay-safe. |
| **X4** | Agent declares a challenge paying vendor B but the payment pays vendor A | REFUSE incl. `W7`; no co-signature | The co-signer won't sign a payment that doesn't match the declared purchase. |

The in-process test ([`merchant.test.ts`](../../packages/cosigner/demo/x402/merchant.test.ts))
additionally covers a merchant-side amount mismatch (`502 invalid_amount`) and an unknown-invoice
rejection (`402`), with only ledger I/O mocked.

## 9. Trust assumptions

| Step | Trusted to… | Enforced by |
|---|---|---|
| Co-sign | the co-signer applies W7 and the rest of the policy honestly | the ledger still enforces quorum; W7 is deterministic and logged in the decision record |
| Submit | nobody — the agent submits its own transaction | the ledger validates the multisig |
| Verify | the merchant reads the ledger honestly for its own benefit | the transaction is public and validated; the merchant gains nothing by misreading its own receipt |
| Deliver | the merchant to deliver on a valid receipt | outside the ledger — the usual x402 merchant-trust assumption, unchanged by engagement accounts |

Compared with ordinary x402, the engagement account **adds** guarantees on the payer side: funds
move only under quorum, only to the challenged merchant, only for the challenged amount, and only
within the owner's mandate — none of which plain x402 provides.

## 10. Edge cases

- **Idempotent replay** (X3): the replay store keys on the receipt, so re-presenting it returns
  success without charging or re-delivering.
- **Challenge mismatch** (X4): wrong `payTo`, wrong amount, or a payment not bound to the invoice
  makes W7 fail — the co-signer produces no signature, so the payment is never even submitted.
- **Amount mismatch at settlement**: if a validated payment's delivered amount doesn't match the
  merchant's requirement, `verifySettlement` fails and the merchant returns `502`
  (`invalid_amount`) rather than delivering.
- **Unknown invoice**: a `PAYMENT-SIGNATURE` for an invoice id the merchant never issued is
  rejected (`402`) — a client can't invent an invoice id.
- **Not yet validated**: if the transaction isn't validated when the merchant checks, settlement
  is a soft `402` ("pay or wait"); the agent retries once the ledger catches up.
