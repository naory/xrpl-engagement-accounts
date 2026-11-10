# x402 purchase from an engagement account

An end-to-end x402 payment where the payer is an **engagement account** (multisig,
agent + policy co-signer), paying an x402 merchant. It ties together the three
pieces built across this project:

- the **co-signer** (`@eng/cosigner`) with rule **W7**, which binds the
  co-signature to the x402 challenge the agent declares;
- the **settlement adapter** (`x402-xrpl-settlement-adapter`), which the merchant
  uses to verify the payment;
- the **engagement account** mechanics (single-use, multisig, quorum-enforced).

## Scheme: `prepaid`, not `exact`

Engagement-account payments carry `eng/basis` and `eng/invoice` memos (baseline
rule B8 requires the basis memo), and the standard x402 `exact` scheme **forbids
memos**. So this flow uses the adapter's **`prepaid`** scheme: the agent submits
its own multisigned `Payment` and returns the transaction hash; the merchant
verifies the *validated* transaction on-ledger. Multisig needs no special handling
— the ledger already enforced the SignerList and quorum, so verifying the
validated transaction is enough. The payment also carries the adapter's x402 memo
(`paymentId`), which is what the merchant binds.

(The `exact` scheme — adapter `./exact`, with offline signature + quorum
verification — is the interop path for ordinary single-signed x402 clients.)

## The flow

```
merchant.challenge()                     → 402 PAYMENT-REQUIRED (scheme "prepaid", invoiceId)
agent builds Payment to the vendor:        eng/basis + eng/invoice=invoiceId + x402 memo(paymentId=invoiceId)
agent → co-signer /decide (stage spend)  → B1–B11, W0–W7; W7 checks the payment matches the
                                           declared payment.challenge/1 (destination, amount, invoice)
agent combines agent + co-signer sigs, submits to XRPL, waits for validation
agent → merchant.handle({ txHash })      → verifySettlement: destination, amount, memo binding,
                                           tesSUCCESS, replay → delivers the resource
                                         → 200 PAYMENT-RESPONSE
```

`merchant.ts` always verifies against the merchant's **own** requirements for the
invoice id it issued, never the client's echoed `accepted` — a client cannot lower
the price or invent an invoice id.

## Running

These depend on `x402-xrpl-settlement-adapter` (≥ 0.3.0) and are kept out of the
default `npm test` / `npm run typecheck` so the repo builds without it.

1. Install the adapter. Once it is published: `npm i -D x402-xrpl-settlement-adapter`.
   Until then, from a local build of the adapter repo:

   ```bash
   (cd ../x402-xrpl && pnpm build && npm pack)      # → x402-xrpl-settlement-adapter-0.3.0.tgz
   npm i ../x402-xrpl/x402-xrpl-settlement-adapter-0.3.0.tgz
   ```

2. Run the in-process integration test (no network — ledger mocked):

   ```bash
   npm run test:x402        # merchant.test.ts
   npm run typecheck:x402
   ```

   It exercises the real co-signer decision (W7) and real adapter verification,
   with only ledger I/O faked: the happy path (402 → co-sign → verify → deliver),
   idempotent replay, a W7 refusal when the payment doesn't match the challenge,
   a merchant rejection on an amount mismatch, and an unknown-invoice rejection.

3. Run the live Testnet demo (fresh faucet accounts, real submit + on-ledger
   verification; ~2–3 min). Runs from a machine that can reach Testnet:

   ```bash
   npm run demo:x402
   XRPL_URL=wss://s.devnet.rippletest.net:51233 npm run demo:x402   # devnet
   ```

   It opens a single-use engagement account (master disabled, SignerList
   {owner 2, agent 1, co-signer 1}, quorum 2) and runs: X1 open · X2 the full
   402 → co-sign (W7) → submit → on-ledger verify → deliver round trip · X3
   idempotent receipt replay · X4 a W7 refusal when the declared challenge names
   a different payee. Results and the co-signer decision log are written under
   `demo/results/`. The account is left open (close is covered by `demo:b1`).

## Status

- ✅ `merchant.ts` + `merchant.test.ts` — the full chain, verified in process.
- ✅ `b1-x402-testnet.ts` (`demo:x402`) — the live Testnet script. Ready; a live
  run needs the adapter installed and a machine that can reach Testnet.
