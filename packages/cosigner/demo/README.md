# Co-signer demos (Testnet)

Both scripts run from the **repo root** on a machine that can reach XRPL Testnet over WebSocket (port 51233). Every account is created fresh from the faucet on each run, and the script never needs a seed. Results land in `demo/results/`.

```bash
npm install
npm run demo:b1        # B1 procurement agent, ~20 min including the AccountDelete wait
npm run demo:hotel     # hotel@2 stay escrow, every path (H1–H17), ~25 min including the AccountDelete wait
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

## `hotel-testnet.ts`: what it checks

The hotel@2 stay escrow (specs `docs/superpowers/specs/2026-11-12-hotel-stay-escrow-design.md` §5, §7.1 and `docs/superpowers/specs/2026-11-14-arbiter-chargeback-design.md`), driven by `HotelFlow` (`src/hotel/flow.ts`). Signers: guest 3, hotel 3, arbiter 4, co-signer 2; quorum 7. The guest books a 400 RLUSD room with a 100 deposit (40 on the partial-deposit path); disputes carry a 10 bond; claims are a 20 minibar charge; the service fee is 50 bps of everything the hotel receives. Every path books one night, except `staySilent`, which books three (nightly = floor(400 ÷ 3) = 133.333333).

**Accredited arbiter.** The co-signer registers a deal only if its arbiter holds an accepted, unexpired `ENG/ARBITER` Credential from an issuer in the policy's `arbiterIssuers`. The script funds an accreditor (standing in for the engagement service), which issues the arbiter an `ENG/ARBITER` Credential; the arbiter (funded for this) accepts it. A deal naming an arbiter nobody accredited is refused at registration (`NOT_NEUTRAL`), before its account is ever funded (H16).

The co-signer loads a copy of `pol_hotel@2.0.0` as version `2.0.0-demo` with `params.rulingWindow: "60s"`, this run's accreditor in `params.arbiterIssuers` and this run's RLUSD issuer, pinned in every engagement record through `policyLayers`. Records carry the deal's `terms` (`nights`, `nightly`). Timers are seconds from open, judged on validated-ledger close time: `confirmBy` 40, `checkIn` 60, `checkInBy` 90, `entryDisputeBy` 120, `deliveryBy` 150, `claimBy` 180, `disputeWindowEnds` 210; the arbiter's ruling deadline is 60 s after a dispute opens.

The script pre-creates one engagement account per path (its reserve sized from the path's nights), waits until each can be deleted (`Sequence + 256 ≤ ledger index`, counting the Sequence numbers the open Batch consumes), then runs the paths concurrently. Each path opens its own account when it starts, because timers count from open. The open Batch reserves the deal's Tickets (`hotelTickets(nights)`): `default.refund` 4, `default.noshow` 5, `default.noshowSweep` 6 and `default.chargebackEntry` 4 (pre-signed at open); `default.release` 6, `default.chargebackClaim` 6 and 6 per stay variant `default.chargebackStay#k`, *k* = 1 … nights − 1 (pre-signed at check-in). That is 31 Tickets for one night and 43 for three; all reserve returns at `AccountDelete`.

**Check-in order.** The hotel posts `checked_in`; the guest posts its own `checked_in` acknowledgement once it has the keys; only then do guest and hotel pre-sign the release, the claim chargeback and the stay variants, and only after those are stored does the guest pay the deposit. Nothing is pre-signed on the hotel's word alone.

**Arbiter silent.** If the arbiter misses its ruling deadline on an open (bonded) dispute, the co-signer completes the chargeback-style default for it: an arrival dispute refunds everything; a claim (or after-checkout) dispute pays the hotel the room and returns the deposit and bond; a mid-stay dispute in night *k* pays the hotel *k* nights and returns the rest. A receipted arbiter ruling blocks them (on `entryRuled` the arbiter rules in time, so its 60 s deadline never fires the entry chargeback).

Automatic endings return any extra money to the guest with a residual sweep (a `tfPartialPayment` that delivers whatever the fixed payouts leave): the refund sweeps the whole balance, the release sweeps the deposit plus anything extra. A sweep that can deliver nothing fails on-ledger and burns the default, so the no-show is pre-signed twice, exact and with a sweep, and the co-signer completes whichever fits the balance (B11 refuses the other); the unused one dies at `AccountDelete`. A recorded check-in is final (a later `refused` is rejected, `CHECKIN_FINAL`), and B11 also refuses an ending whose payee can't receive (DepositAuth, no or capped trust line) rather than burning it.

| # | Path | Expected |
|---|---|---|
| H1 | Happy: confirm → check-in + deposit → minibar claim → guest accepts → settle with review | `settle` SIGN, tesSUCCESS, payouts exact, account deleted |
| H2 | Hotel never confirms | `default.refund` completed by `tick()`, guest refunded |
| H3 | Guest never shows | `default.noshow`, hotel paid less the fee |
| H4 | No room at check-in → entry dispute → hotel concedes | `refund.conceded`, guest gets room + bond |
| H5 | Downgraded room → entry dispute → arbiter partial refund | arbiter + guest ruling closes |
| H6 | Stay, no claim, silence | `default.release`, deposit back to the guest |
| H7 | Claim posted, guest silent | arbiter + hotel default ruling pays the claim (advisory `ruling.default` recorded) |
| H8 | Claim posted, guest disputes it, arbiter silent past its deadline (`arbiterSilent`) | `default.chargebackClaim` SIGN: room to the hotel less the fee, deposit + bond to the guest, account deleted |
| H9 | `default.chargebackClaim` before the ruling deadline | REFUSE `G1` (`NOT_DUE`); nothing submitted |
| H10 | Guest + hotel alone | `tefBAD_QUORUM` |
| H11 | `default.release` while a claim is posted | REFUSE `L5` (`CLAIM_POSTED`) |
| H12 | Open-time `default.refund` / both `default.noshow` variants after check-in + deposit | REFUSE `R1` (confirmed) / `N3` (`CHECKED_IN`) |
| H13 | `default.noshow` while an entry dispute is open | REFUSE `N4` (`DISPUTE_OPEN`) |
| H14 | Arbiter + co-signer alone (weight 6 < quorum 7) | `tefBAD_QUORUM` |
| H15 | Guest pays a partial deposit, hotel posts `refused` | exact `default.noshow` REFUSE `N8`; `default.noshowSweep` SIGN: hotel paid the room less the fee, the 40 swept back to the guest inside the ticketed ALLORNOTHING Batch |
| H16 | A deal naming an unaccredited arbiter | `register()` refuses `NOT_NEUTRAL` (`ARBITER_NOT_ACCREDITED`); nothing registered, the account never funded |
| H17 | 3-night stay, guest disputes in night 1, arbiter silent (`staySilent`) | `default.chargebackStay#1` SIGN: one night (133.333333) to the hotel less the fee, the other two nights + deposit + bond (376.666667) to the guest, account deleted |

Results go to `demo/results/hotel-run-*.json`: every transaction hash, each path's steps (with the rule results from the co-signer's decision records), and the checks. The signed decision log is written next to them.

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
