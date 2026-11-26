# Clip 3: marketplace purchase dispute

Script text only. No recording. The banner is `Clip 3: marketplace purchase dispute`. "Purchase" is the deal, not an identifier. There is no hotel default in this clip.

The run is `npm run demo:marketplace-escrow-dispute` on XRPL Testnet. The co-signer is the local process. The item is about 2 RLUSD and the bond about 0.50 RLUSD, bought from Ripple's Testnet RLUSD issuer under a 50 XRP cap when that path is available.

Timers in this run are shortened for Testnet: ship 45 s, inspect 110 s, ruling 20 s, alert repeat 15 s. The shipped template uses 72 h, 10 d and 5 d, with a 24 h repeat.

v4 signs missed deadlines live. The open books no Tickets and stores no pre-signed transactions. The reserve is 1.4 XRP. `parties.principal` (the buyer) signs `party.mandate/1`. Option (a): the arbiter plus either party can sign a default, and the payout is still checked for the winner.

1. Open. The buyer has signed `party.mandate/1`, naming the seller as payee with a 2 RLUSD maximum. The open batch funds 2 RLUSD and sets the 3/3/4/2 signer list with quorum 7. It books no Tickets. The carrier is named on the deal.
2. The stand-in carrier records `shipping.shipped/1`. The co-signer receipts it.
3. The buyer posts the dispute credential and the 0.50 RLUSD bond, then `party.dispute/1`.
4. `inspectBy` passes. The co-signer does not publish a `default.release` notice, and `POST /v1/engagements/:id/timeout/proposal` refuses `NOT_DUE`. Nothing is signed or submitted. A bonded dispute is not a due release.
5. `rulingDueBy` passes. The co-signer logs `ruling overdue`. It does not sign. The alert repeats on the demo interval.
6. The arbiter rules a refund. The ruling is receipted even though it is late.
7. The arbiter rotates its regular key. The engagement signer list is not changed.
8. The new regular key and the buyer sign `dispute.refund`. The buyer receives the price and the bond. The account is deleted, and the alert stops.

That is ME6 followed by ME4. A missed deadline that is due, with no open dispute, is the other demo: a `cosigner.timeout/1` notice, an on-demand proposal, the party signs first, the arbiter reads its own ledger, and `POST /v1/engagements/:id/timeout/signatures` submits. The proposal's last ledger is 30 ledgers out.
