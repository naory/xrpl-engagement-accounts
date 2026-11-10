# Co-signer demos (Testnet)

Both scripts run from the **repo root** on a machine that can reach XRPL Testnet over WebSocket (port 51233). Every account is created fresh from the faucet on each run, and the script never needs a seed. Results land in `demo/results/`.

```bash
npm install
npm run demo:b1        # B1 procurement agent, ~20 min including the AccountDelete wait
SKIP_CLOSE=1 npm run demo:b1   # ~3 min, leaves the engagement account open
npm run demo:x402      # x402 engagement-account purchase (needs x402-xrpl-settlement-adapter)
npm run probe:x402     # probe a hosted facilitator for engagement-account support
```

Set `XRPL_URL=wss://s.devnet.rippletest.net:51233` to use Devnet instead.

## `b1-testnet.ts`: what it checks

An owner-wallet engagement account: the owner (treasury) has weight 2, the agent 1 and the co-signer 1, with quorum 2. The owner funds it with 5,000 test RLUSD. The signed mandate sets a budget of 5,000, a daily cap of 3,000, approval above 1,000, and vendors A and B, each holding a `KYB_VERIFIED` credential. The co-signer runs in-process with a `XrplLedgerSource` pinned to the latest validated ledger, and writes a signed `cosigner.decision/1` record for every request.

| # | Step | Expected |
|---|---|---|
| D1 | Open Batch: owner funding, SignerListSet, RegularKey cleared | tesSUCCESS; master disabled, no RegularKey, quorum 2 |
| D2 | Agent + co-signer pay vendor A 800 with an invoice | SIGN, tesSUCCESS |
| D3 | 1,500 to vendor B with no approval | REFUSE `W5` |
| D4 | Same payment, with the controller's approval bound to the payment intent | SIGN, tesSUCCESS |
| D5 | Two 400 payments requested before either validates | First SIGN; second REFUSE `W3` (in flight) |
| D6 | 900 more the same day | REFUSE `W3` |
| D7 | Replay of D4's approval and invoice | REFUSE; both statements `CONSUMED` |
| D8 | Payment to a non-vendor | REFUSE incl. `B6`, `W2` |
| D9 | Agent submits alone | `tefBAD_QUORUM` |
| D10 | Batch hiding a `SetRegularKey` | REFUSE incl. `B2` |
| D11 | Owner alone sweeps, removes the trust line, deletes the account (co-signer advisory only, no signature) | tesSUCCESS; account deleted |

## `x402/b1-x402-testnet.ts`: what it checks

An engagement account pays an x402 merchant through the settlement adapter's `prepaid` scheme. It opens the same owner-wallet account as `b1-testnet.ts`, then runs the x402 round trip. Design and adapter install: [`x402/README.md`](x402/README.md).

| # | Step | Expected |
|---|---|---|
| X1 | Open the engagement account | tesSUCCESS; master disabled, quorum 2, funded |
| X2 | Merchant 402 → agent + co-signer pay 800 (W7 binds the co-signature to the challenge) → merchant verifies the validated tx on-ledger → delivers | SIGN; W7 pass; tesSUCCESS; merchant 200; vendor A +800 |
| X3 | Agent replays the same receipt | 200, idempotent, no re-delivery |
| X4 | Agent declares a challenge paying vendor B but pays vendor A | REFUSE incl. `W7`; no co-signature |

Run with `npm run demo:x402` (needs `x402-xrpl-settlement-adapter`). The in-process integration test is `npm run test:x402`.

## `x402-probe.ts`

A capability probe: does a hosted x402 facilitator accept and settle an **engagement-account-shaped** payment — a multisigned `Payment` from a master-disabled account, with and without the engagement memos (`eng/basis`, `eng/invoice`) and invoice binding? It builds those payments to a fresh Testnet merchant and posts them to a facilitator's `/verify`, alongside a single-signed control that confirms the envelope is right. `FACILITATOR_URLS` takes a comma-separated list; `SETTLE=1` also settles the payments that verify and reads the result back from the ledger (a few thousand drops of Testnet XRP).

This is how we evaluated whether engagement payments are a supported path on the hosted facilitators; the conclusion, and the decision to ship [`x402-xrpl-settlement-adapter`](https://www.npmjs.com/package/x402-xrpl-settlement-adapter), are in [docs/research/x402-multisig.md](../../../docs/research/x402-multisig.md).

> The keys these scripts generate are throwaway Testnet keys. The results files contain addresses and transaction hashes but no secrets, and are kept out of the repo.
