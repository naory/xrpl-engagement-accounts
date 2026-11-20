# Clip 3: hotel dispute

A Testnet recording of two `settlement-vault/hotel@2` endings, driven against the local co-signer
(`npm run cosigner:local`). The hotel template and `pol_hotel@2.0.0` are unchanged. This is a
walkthrough of outcomes that `npm run demo:hotel` already runs in-process.

```bash
COSIGNER_TICK_SUBMIT=1 COSIGNER_TICK_MS=10000 npm run cosigner:local
npm run demo:hotel-dispute
```

The first command is the prerequisite. Leave it running. It must be the loopback co-signer, on a
known Testnet websocket, with no `ENG_RLUSD_ISSUER`, `ENG_ARBITER_ACCREDITOR`, or `ENG_KYB_ISSUER`.
`COSIGNER_TICK_SUBMIT=1` is what submits the refund. `COSIGNER_TICK_MS=10000` keeps the pause after
the deadline short (unset, the local co-signer ticks every 30000 ms).

`npm run demo:hotel-dispute` is the clip. It refuses a `XRPL_URL` or a `local.json` endpoint that
is not a known Testnet host. Stdout shows addresses, decisions, transaction hashes, and
`https://testnet.xrpl.org/transactions/…` links. It does not print seeds, the bearer token, or
signed blobs. The script does not prompt.

The asset is a test IOU the script issues (`currencyHex('RLUSD')`), the same shape as
`npm run demo:hotel`, not Ripple's RLUSD. The booking figures are `DEMO_HOTEL_BOOKING` in
`packages/cosigner/src/hotel/flow.ts`: room 400, deposit 100, bond 10. The bond is the hotel
policy's minimum dispute bond, `10.00` (`policies/hotel@2.0.0.json:29`). It is not a marketplace
collateral bond.

Preparation (faucet, accreditation, and the ledger's `AccountDelete` age) prints before the
banner. Start the recording at the banner. The banner and the two sub-steps are:

```
Clip 3: hotel dispute

1. Arbiter ruling (H5)

2. Hotel never confirms: refund default (H2)
```

Signer weights are guest 3, hotel 3, arbiter 4, co-signer 2, quorum 7
(`templates/hotel@2.json:7`-`templates/hotel@2.json:12`). The service fee is 50 bps of what the
hotel receives, paid by the hotel (`templates/hotel@2.json:49`, `policies/hotel@2.0.0.json:28`).

## 1. Arbiter ruling (H5)

The guest is downgraded and opens an entry dispute. The arbiter rules with the guest. That
outcome is `settle.ruling`: signers `[arbiter, principal]` or `[arbiter, counterparty]`,
`enforcement` `none`, so the co-signer does not sign
(`templates/hotel@2.json:16`). The blueprint is `close.split`: pay the hotel, the fee, and the
guest, remove the trust line, delete the account (`templates/hotel@2.json:43`).

The ruling pays the hotel the room minus the deposit, less the 50 bps fee, and pays the guest
the deposit plus the bond. On `DEMO_HOTEL_BOOKING` that is 298.5 to the hotel, 1.5 to the fee
account, and 110 to the guest (300 gross × 50 / 10000 = 1.5). The account is deleted. The clip
prints the balances of the guest, the hotel, the fee account, the arbiter, and the engagement
account before that transaction and after it.

This sub-step does not wait out a chargeback. The template's ruling window is 432000 seconds,
and a deal may pin one only inside 259200–604800 seconds
(`policies/hotel@2.0.0.json:30`-`policies/hotel@2.0.0.json:32`). The arbiter rules in the clip,
while those deadlines are still far off.

## 2. Hotel never confirms: refund default (H2)

This sub-step is not a dispute. The hotel never posts `party.confirmation/1`. The template's
`confirmBy` timer runs from open for 7200 seconds and its `onExpire` is `default.refund`
(`templates/hotel@2.json:26`). That outcome is pre-signed, the co-signer is the final signer,
and the stage is `default.refund` (`templates/hotel@2.json:17`). The blueprint `close.refundAll`
pays the guest, removes the trust line, and deletes the account (`templates/hotel@2.json:45`).
There is no fee (`policies/hotel@2.0.0.json:206`-`policies/hotel@2.0.0.json:210`).

Rule **R1** (`NOT_DUE`) is due only when ledger close time is past `eng.timers.confirmBy` and
the hotel has not confirmed (`policies/hotel@2.0.0.json:185`-`policies/hotel@2.0.0.json:188`).
The clip writes that record field to 60 seconds after the open ledger's close time so the
default fires during the recording. Sixty seconds is not a policy parameter. `cosigner:local`
loads the committed `pol_hotel@2.0.0`. The script does not copy a policy and does not pass
`policyLayers`.

The local scheduler evaluates the stored pre-signed refund. Before `confirmBy` the clip prints:

```
REFUSE R1 NOT_DUE
```

After `confirmBy`, with `COSIGNER_TICK_SUBMIT=1`, the scheduler signs and submits. The clip
prints `PASS default.refund tesSUCCESS` and the explorer link. The guest receives the whole
balance (the room, 400, on this booking). The script does not call `POST /tick` and does not
submit the refund itself.

Baseline **B11** signs a pre-signed close only when the account is already old enough to delete
(`policies/baseline@1.1.0.json:197`-`policies/baseline@1.1.0.json:202`). The script opens both
accounts only after that wait. Opening earlier would leave the refund refused `B11`
`WOULD_FAIL` even once R1 had passed.

## Out of scope

`default.chargebackClaim` (H8) is not in this clip. A marketplace collateral bond is not in
this clip. Killing or restarting the co-signer is not in this clip.

Results land in `packages/cosigner/demo/results/hotel-dispute-run-*.json` (gitignored):
addresses, the refusal, both headline hashes, and the before/after balances. No seeds, tokens,
or signed blobs.
