# MPP purchase from an engagement account

An end-to-end **Machine Payments Protocol (MPP)** payment where the payer is an
**engagement account** (multisig, agent + policy co-signer), paying an MPP
merchant over the **XRPL charge** method in **push** mode. It is the MPP sibling
of [`../x402`](../x402), reusing the same three pieces:

- the **co-signer** (`@eng/cosigner`) with rule **W7**, which binds the
  co-signature to the `payment.challenge/1` the agent declares — rail-neutral, so
  it covers `scheme: "mpp"` exactly as it covers `scheme: "x402"`;
- the **settlement adapter** (`x402-xrpl-settlement-adapter`), whose
  `confirmExactSettlement` the merchant uses to confirm the push payment on-ledger;
- the **engagement account** mechanics (single-use, multisig, quorum-enforced).

## Why this merchant, and not the reference `xrpl-mpp-sdk`

MPP settlement for engagement accounts is decided in
[docs/research/mpp.md §6](../../../../docs/research/mpp.md): the only
engagement-specific work is the co-signer binding (shipped as
`payment.challenge/1`); *settlement* — "read the validated transaction by hash +
`InvoiceID` binding" — is the reference SDK's job and needs no new primitive.

The reference [`xrpl-mpp-sdk`](https://www.npmjs.com/package/xrpl-mpp-sdk)
(`0.1.0-beta.4`) **peers on `xrpl >=4 <5`** (and `mppx >=0.8 <0.10`), while this
repo is on `xrpl@5`, so it cannot be added to the tree without a broken
resolution — exactly the "pull a beta dependency into a published package" cost
§6 warned about. So this merchant speaks the MPP XRPL charge **wire format** —
pinned in §1.2 and verified field-for-field against `xrpl-mpp-sdk@0.1.0-beta.4`'s
`charge` schema — and bridges **push** settlement to the adapter's
`confirmExactSettlement` (the "thin bridge" §6 left open). No `xrpl-mpp-sdk`
dependency; it is used only as the spec oracle for the wire format.

## Push mode, and why memos are fine

Engagement-account payments carry `eng/basis` and `eng/invoice` memos (baseline
rule B8 requires the basis memo). MPP **push** = the agent submits its own
multisigned `Payment` and presents the transaction hash; the server confirms the
*validated* transaction and binds via the signature-covered XRPL **`InvoiceID`**
field. Unlike the x402 `exact` scheme (offline verify, which forbids memos),
`confirmExactSettlement` reads the already-validated transaction, so the payment
keeps its engagement memos **and** carries the `InvoiceID` binding. Multisig needs
no special handling — the ledger enforced the SignerList and quorum before the
hash existed.

## The flow

```
merchant.challenge()                     → 402 WWW-Authenticate: Payment
                                           method="xrpl" intent="charge" request=<b64url JCS>
                                           challenge=<HMAC-bound token>
agent builds Payment to the vendor:        eng/basis + eng/invoice=invoiceId
                                           + InvoiceID = SHA-256(invoiceId)   (push binding)
agent → co-signer /decide (stage spend)  → B1–B11, W0–W7; W7 checks the payment matches the
                                           declared payment.challenge/1 (scheme "mpp":
                                           destination, amount, invoice)
agent combines agent + co-signer sigs, submits to XRPL, waits for validation
agent → merchant.handle(Authorization:   → challenge token verified (HMAC + expiry),
        Payment { payload:{type:"hash",    then confirmExactSettlement: validated + tesSUCCESS,
        hash} })                           destination, delivered amount, InvoiceID binding, replay
                                         → 200 + Payment-Receipt: <b64url JSON> { reference: hash }
```

The challenge token is HMAC-bound: a tampered or expired one is rejected
fail-closed (401) before any settlement lookup, mirroring how `mppx` rejects a
bad challenge. The merchant always verifies against the requirements for the
invoice id **it** issued, never the client's echo.

## Running

These depend on `x402-xrpl-settlement-adapter` (≥ 0.3.0) and are kept out of the
default `npm test` / `npm run typecheck` so the repo builds without it. (The MPP
demo files are type-checked by `npm run typecheck:x402`, which globs all demos.)

1. Install the adapter: `npm i -D x402-xrpl-settlement-adapter`.

2. Run the in-process integration test (no network — ledger mocked):

   ```bash
   npm run test:mpp         # merchant.test.ts
   npm run typecheck:x402   # also type-checks this demo
   ```

   It exercises the real co-signer decision (W7, scheme `mpp`) and real adapter
   verification, with only ledger I/O faked: the happy path (402 → co-sign →
   confirm by hash → deliver), idempotent replay, a W7 refusal when the payment
   doesn't match the challenge, a merchant rejection on an amount mismatch, a
   rejection on an `InvoiceID` that doesn't bind, and a tampered-challenge
   rejection.

3. Run the live Testnet demo (fresh faucet accounts, real submit + on-ledger
   confirm; ~2–3 min). Runs from a machine that can reach Testnet:

   ```bash
   npm run demo:mpp
   XRPL_URL=wss://s.devnet.rippletest.net:51233 npm run demo:mpp   # devnet
   ```

   It opens a single-use engagement account (master disabled, SignerList
   {owner 2, agent 1, co-signer 1}, quorum 2) and runs: M1 open · M2 the full
   402 → co-sign (W7) → submit → on-ledger confirm (hash + `InvoiceID`) → deliver
   round trip · M3 idempotent push-credential replay · M4 a W7 refusal when the
   declared challenge names a different payee. Results and the co-signer decision
   log are written under `demo/results/`. The account is left open (close is
   covered by `demo:b1`).

## Status

- ✅ `merchant.ts` + `merchant.test.ts` — the full chain, verified in process (5/5).
- ✅ `b1-mpp-testnet.ts` (`demo:mpp`) — the live Testnet script. Ready; a live run
  needs the adapter installed and a machine that can reach Testnet.
