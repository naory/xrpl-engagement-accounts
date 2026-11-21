# Clip 3: marketplace purchase dispute

Script text only. No recording. The banner is `Clip 3: marketplace purchase dispute`. "Purchase" is the deal, not an identifier. There is no hotel default in this clip.

The run is `npm run demo:marketplace-escrow-dispute` on XRPL Testnet. The co-signer is the local process. The item is about 2 RLUSD and the bond about 0.50 RLUSD, bought from Ripple's Testnet RLUSD issuer under a 50 XRP cap when that path is available.

1. Open. The buyer's owner key has signed `party.mandate/1`. The open batch funds 2 RLUSD, sets the 3/3/4/2 signer list, and reserves 15 tickets. The carrier is named on the deal.
2. The stand-in carrier records `shipping.shipped/1`. The co-signer receipts it.
3. The buyer posts the dispute credential and the 0.50 RLUSD bond, then `party.dispute/1`.
4. `inspectBy` passes. The co-signer ticks `default.release` and refuses it `DISPUTE_OPEN`. Nothing is signed.
5. `rulingDueBy` passes. The co-signer logs `ruling overdue`. It does not sign. The alert repeats on the demo interval.
6. The arbiter rules a refund. The ruling is receipted even though it is late.
7. The arbiter rotates its regular key. The engagement signer list is not changed.
8. The new regular key and the buyer sign `dispute.refund`. The buyer receives the price and the bond. The account is deleted, and the alert stops.

That is ME6 followed by ME4.
