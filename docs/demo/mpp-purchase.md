# Use case: an engagement account pays an MPP merchant

An agent pays a merchant that charges for each request over MPP. The agent cannot
complete that payment alone. Its key is below the account's quorum, so the ledger
rejects a payment signed only by the agent. The policy co-signer adds its signature
only when the payment matches the challenge the agent declared for
that request — the same destination, the same amount, and the same invoice — and when
the spend stays inside the owner's caps. The cap and the match are the co-signer's
rules. The ledger does not read them. It rejects the payment while the co-signer's
signature is missing, which is what stops the agent paying a different destination or
a different amount than the challenge it declared.

The co-signer does not call the merchant. It checks the challenge statement the agent
submits with the payment.

## Run it

From the repo root:

```bash
npm install
npm run test:mpp
npm run demo:mpp
```

`npm run test:mpp` is in-process and does not use the network. It passed 5 tests.
`npm run demo:mpp` is the live Testnet script. It needs a machine that can reach
Testnet. This page does not report a live pass: the repo has no committed
`mpp-run-*.json` (that directory is gitignored).

With no `XRPL_URL`, the script calls `resolveTestnetEndpoint` (`@eng/core`). That
tries `wss://testnet.xrpl-labs.com` and, if the connect fails or times out, falls
back to `wss://s.altnet.rippletest.net:51233`. Set `XRPL_URL` to use a specific
endpoint instead of that list.

## What this is, and what it is not

The payer is a B1 engagement account: master key disabled, SignerList {owner 2, agent
1, co-signer 1}, quorum 2. The merchant answers with HTTP 402. The agent builds a
multisigned `Payment`. The co-signer co-signs only if rule W7 (payment must match the
merchant's challenge) passes on the declared `payment.challenge/1` (`scheme: "mpp"`).
The agent submits, then presents the transaction hash. The merchant reads the
validated transaction and delivers.

**In-process, not a hosted co-signer.** Both `npm run test:mpp` and `npm run demo:mpp`
construct `CosignerService` and `createMppMerchant` in the same process. The live
script's co-signer key is `xrpl.Wallet.generate()` passed to `localSigner` — a
throwaway signing key, not a remote service. Nothing here is production hosting,
custody, or a public merchant.

**Test IOU, not Ripple RLUSD.** The live script creates its own faucet-funded issuer
and issues an IOU whose currency code is the non-standard code `RLUSD`
(`currencyHex('RLUSD')`, 40 hex chars). The in-process tests use the same code
(`RLUSD_HEX` in the policy fixtures) and that fixture's issuer wallet. Neither is
Ripple's RLUSD.

## Cast

| Party | In the demo | Role |
|---|---|---|
| Engagement account | fresh account, opened like B1 | multisig payer |
| Owner | faucet wallet `treasury` | weight 2; signs the mandate |
| Agent | generated key, never funded | weight 1; builds and submits the payment |
| Policy co-signer | generated key, `localSigner`, in-process | weight 1; rule W7 |
| Merchant | in-process `createMppMerchant`, paid to `vendorA` | 402 challenge, on-ledger confirm, delivery |
| Issuer | faucet wallet created in the run | issues the test IOU |
| Vendor B | second faucet vendor | the M4 mismatch payee |

The merchant is not on the SignerList. It only reads the ledger.

## The round trip

**Push:** the agent submits the payment and gives the merchant the transaction hash.
**Pull:** the agent gives the merchant a signed transaction and the merchant submits
it. This demo is push only.

1. `merchant.challenge()` returns **402** `WWW-Authenticate: Payment` with
   `method="xrpl"`, `intent="charge"`, a base64url-JCS `request`, and an HMAC-bound
   `challenge` token. The request carries `methodDetails.invoiceId`. The XRPL
   `InvoiceID` the payment must set is `invoiceIdToField(invoiceId)` (SHA-256 of that
   id).
2. The agent builds a `Payment` to the merchant: `Amount` in the test IOU,
   `Destination` the merchant, `InvoiceID` bound to that invoice, memos
   `eng/basis = spend` and `eng/invoice = <invoiceId>`.
3. The agent declares `payment.challenge/1` (`scheme: "mpp"`, `payTo`, `amount`,
   `invoiceId`, `resource`) and asks the co-signer to decide the `spend` stage. W7
   requires one payout, to the challenge destination, for the challenge amount, bound
   to that invoice. Otherwise the decision is `REFUSE` and there is no co-signature.
4. On `SIGN`, the agent combines the two signatures and submits.
5. The agent retries with `Authorization: Payment <base64url JSON>` whose payload is
   `{ type: "hash", hash }`. The merchant checks the HMAC and expiry first (a bad
   token is **401** `challenge_rejected`), then `confirmExactSettlement` on the hash.
6. A confirmed payment returns **200** and a `Payment-Receipt` (`method: "xrpl"`,
   `reference` the hash). The same credential again is **200** with `idempotent: true`
   and no second delivery.

Memos stay on the payment. `confirmExactSettlement` reads a validated transaction, so
the `eng/basis` and `eng/invoice` memos are not stripped. The ledger has already
enforced the SignerList and quorum; the merchant does not re-check signatures.

## In-process cases (`npm run test:mpp`)

`merchant.test.ts` runs the real co-signer and the real adapter check. Only
`fetchTransaction` is faked. Five cases; the run in [Run it](#run-it) passed all five:

| Case | What the test asserts |
|---|---|
| Full chain | 402, co-signer `SIGN` with W7 `pass`, then 200 with the resource and `reference` equal to the presented hash. A second present is 200, `idempotent`, and does not deliver again. |
| Challenge mismatch | Payment to vendor A, declared `payTo` vendor B. Decision `REFUSE`, failing rules include `W7`, no `signerBlob`. |
| Amount mismatch | Settled delivered amount is `700` against a price of `800.00`. Merchant **502** `amount_mismatch`. |
| Invoice binding | `InvoiceID` bound to a different invoice id. Merchant **502** `invoice_mismatch`. |
| Forged challenge | A token the merchant did not mint. Merchant **401** `challenge_rejected`, before any settlement lookup. |

The price in these cases is `800.00` of the fixture IOU. The network string is
`xrpl:1`. This file is not part of the default `npm test` run
(`vitest.mpp.config.ts`).

## Live script (`npm run demo:mpp`)

`b1-mpp-testnet.ts` needs `x402-xrpl-settlement-adapter` installed and a machine that
can reach Testnet. With no `XRPL_URL`, `resolveTestnetEndpoint` tries
`wss://testnet.xrpl-labs.com`, then `wss://s.altnet.rippletest.net:51233`.
`XRPL_URL=wss://s.devnet.rippletest.net:51233` selects devnet (`xrpl:2` in the
script). Every key is generated for that run. The account is left open; close is
`demo:b1`'s job. If the script finishes, it writes
`packages/cosigner/demo/results/mpp-run-*.json`. No such file is in the repo.

The script records a step as passed only when its own checks hold:

| Step | Pass condition written in the script |
|---|---|
| **M1** | Open Batch `tesSUCCESS`, every inner applied, master key disabled, no `RegularKey`, quorum 2, test-IOU balance 5000. |
| **M2** | Co-signer `SIGN` and W7 `pass`; submit `tesSUCCESS`; merchant 200 with the resource; vendor A balance up by 800 of the test IOU. |
| **M3** | Replaying that push credential is 200, `idempotent`, and the body is absent. |
| **M4** | The payment pays vendor A while the declared challenge names vendor B. Decision `REFUSE`, failing rules include `W7`, no co-signature. |

The merchant sells `https://vendor.example/premium-dataset` for `800` of the test IOU.
The co-signer loads `policies/baseline@1.1.0.json` and
`policies/procurement@1.3.0.json`, with that run's issuer and KYB issuer written into
the procurement layer (`version` `1.3.0+mppdemo`). Both vendors get an accepted
`KYB_VERIFIED` credential from the run's KYB issuer before the open.

## Developer notes

The merchant speaks the XRPL charge wire format and confirms the push credential with
the settlement adapter's `confirmExactSettlement`. It does not import `xrpl-mpp-sdk`:
that package at `0.1.0-beta.4` peers on `xrpl >=4 <5`, and this repo is on `xrpl@5`.
A pull payload (`type: "transaction"`) is rejected. Only `{ type: "hash", hash }` is
accepted.

W7 is the procurement rule "Matches the merchant's payment request". It runs only when
the agent has declared a `payment.challenge/1`. The check is one payout, to the
challenge's `payTo`, for the challenge amount, with `tx.boundToInvoice(invoiceId)`
(the XRPL `InvoiceID` is SHA-256 of that id, or the `eng/invoice` memo equals it).
Daily and total caps are separate co-signer rules (W3, W4), not fields the ledger
evaluates.

## See also

- [B1 procurement walkthrough](b1-procurement.md)
- [x402 purchase walkthrough](x402-purchase.md) — the sibling flow
- [In-process tests](../../packages/cosigner/demo/mpp/merchant.test.ts) (`npm run test:mpp`)
- [Live Testnet script](../../packages/cosigner/demo/mpp/b1-mpp-testnet.ts) (`npm run demo:mpp`)
- [Merchant](../../packages/cosigner/demo/mpp/merchant.ts)
- [Why this demo does not depend on `xrpl-mpp-sdk`](../research/mpp.md#6-decision-settle-mpp-via-the-reference-sdk)
- [XRPL charge wire format](../research/mpp.md#12-xrpl-charge-wire-format-pinned-from-xrpl-mpp-sdk)
- [Package notes](../../packages/cosigner/demo/mpp/README.md)
