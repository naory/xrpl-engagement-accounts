# Lean arbiter neutrality + chargeback-style defaults (design)

Status: design, 2026-11-14. **Supersedes** `2026-11-13-arbiter-neutrality-design.md` (kept for the reasoning).
Applies to `settlement-vault/hotel@2` / `pol_hotel@2.0.0` (amended in place — pre-release) and is the pattern for
future arbiter templates.

## 1. Intent

Model the arbiter on how disputes work today, without over-engineering decentralised neutrality:

| Real world | Here |
|---|---|
| Card network sets the rules and decides who may handle disputes | The **engagement service accredits arbiters** (`ENG/ARBITER` credential) |
| Card issuer's dispute desk | The **arbiter** — may be a provider the hotel contracts, but must be accredited by the service |
| Chargeback: if the merchant can't make its case in time, the cardholder gets the money back | **Arbiter silence = chargeback-style default**: if the arbiter misses its ruling deadline, a pre-signed ending returns the money in dispute to the guest |
| Courts as the last resort | Off-ledger. No on-ledger backup arbiter |

The one property that is **not** optional: in these templates the arbiter + one party can move the money without
the co-signer (rulings work even when the service is down). So the arbiter must not be the merchant's puppet. That
— not "perfect neutrality" — is the bar.

## 2. Decisions (user)

1. **Lean neutrality.** The service is the accreditor; one gate (co-signer registration); the guest's mandate may
   narrow; the pre-booking check flags the rest. No outside-body trust lists, no KYB/KYA requirements, no separate
   provisioning gate.
2. **No backup arbiter.** Arbiter silence past the ruling deadline triggers a chargeback-style default instead.
3. **What the guest gets back when the arbiter is silent:**

| Guest disputed… | Default when the arbiter misses its deadline |
|---|---|
| a problem at entry (no room / wrong room) | **Full refund**: room, any deposit and the bond to the guest |
| the hotel's claim against the deposit | **Claim rejected**: room to the hotel (less fee); deposit and bond to the guest |
| the stay, **mid-stay** | **Remaining nights refunded**: nights before the dispute to the hotel (less fee); remaining nights, deposit and bond to the guest |
| the stay, **after checkout** | No remaining nights → same as "claim rejected" |

4. **Ruling deadline:** 5 days from the dispute by default; the hotel's offer may set it within norms (at least
   3 days, so the hotel can answer; at most 7 days, so the guest's money isn't locked long).

## 3. Assumptions (to revisit when a real business implements this)

All of the following are reasonable defaults for the demo, **not** validated business terms:

- The engagement service is the sole arbiter accreditor (a real deployment may recognise outside bodies).
- Ruling deadline 5 days; norms min 3 days, max 7 days.
- Chargeback-style defaults as in §2.3, including that a stay dispute after checkout falls back to "claim rejected".
- **Nights are prorated equally**: nightly price = room ÷ nights (rounding: the last night absorbs the remainder).
  A night counts as "used" once it has begun: night *i* begins at check-in time + *i*·24 h; the cut-off is the
  co-signer's **receipt time** of the guest's stay dispute (can't be backdated).
- **Cap: 14 nights.** Longer stays get no pre-signed stay variants beyond the cap; such a stay dispute waits for the
  arbiter (and courts).
- The dispute bond (10 RLUSD) is returned to the guest in every chargeback default.
- Fee: 0.5% of whatever the hotel receives (unchanged).

## 4. Mechanics

### 4.1 Signers (hotel@2 amended)
principal 3, counterparty 3, arbiter 4, cosigner 2 — quorum 7. Winning sets: guest+hotel+co-signer (8), arbiter+guest
(7), arbiter+hotel (7), guest+hotel+arbiter (10). Arbiter alone 4, arbiter+co-signer 6, guest+hotel 6: all below
quorum. The `backupArbiter` role, `ruling.backup` outcome/stage (U1–U7) and backup-related norms are removed.

### 4.2 Accreditation gate (co-signer registration)
- `pol_hotel@2.0.0` params gain `arbiterCredentialType: "ENG/ARBITER"` and `arbiterIssuers: [<service accreditor
  account>]` — pinned with the policy by its hash (no separate trust list).
- `register()` becomes async: at a fresh snapshot it requires the arbiter to hold an **accepted, unexpired**
  `ENG/ARBITER` from a listed issuer; the arbiter ≠ guest and ≠ hotel; and, if the guest's mandate lists
  `allowedArbiters`, the arbiter is among them. Otherwise it throws `NOT_NEUTRAL: <codes>` and registers nothing.
  The co-signer then never co-signs anything (no settlement, no defaults) for that engagement.
- The template validator requires every `arbiter`-kind role to declare `"accreditation": "service"` (V15), so
  every arbiter template opts into the gate.

### 4.3 Chargeback defaults (pre-signed, completed by the co-signer)
New presigned outcomes (guest + hotel sign; co-signer adds the final signature only when due):

| Outcome | Signed at | Payout | Due when |
|---|---|---|---|
| `default.chargebackEntry` | open | everything to the guest (residual sweep) | an open entry dispute, ruling deadline passed, no arbiter ruling |
| `default.chargebackClaim` | check-in | room to hotel (less fee), fee, residual (deposit + bond + any extra) to guest | an open settlement dispute (claim, or stay after checkout), deadline passed, no ruling |
| `default.chargebackStay` × (nights − 1), capped | check-in | *k* nights to hotel (less fee), fee, residual to guest — one variant per *k* = 1 … nights − 1 | an open mid-stay dispute whose receipt time falls in night *k*, deadline passed, no ruling (a dispute in the last night uses `chargebackClaim`) |

- "No arbiter ruling" = no `party.ruling/1` from the arbiter receipted. An arbiter ruling signed on-ledger with a
  party can still race the default; whichever closes the account first wins, the other is dead (as today).
- Disputes keep requiring the bond and the on-ledger credential; the dispute statement's `phase` gains `stay`
  (window: until checkout). Post-checkout stay complaints use `phase: settlement`.
- The deadline is the policy's `rulingWindow`, overridable per deal within norms (§2.4); the record pins the
  deal's value.
- Ticket cost grows with the stay (≈ 6 Tickets per stay variant); all reserve returns at close. Per-deal variant
  count means the template declares the stay variant as per-night (`"variants": { "perNight": true, "max": 13 }`)
  and the validator/ticket count accounts for the cap.

### 4.4 Pre-booking check
The norms profile drops the backup-arbiter norms and adds a minimum ruling deadline (3 days). `dealTerms` picks
up the chargeback outcomes' descriptions automatically ("If nobody acts").

## 4.5 Settled details (my calls after the builder check — also assumptions in the §3 sense)

1. **Nights and the cap.** `nights` is fixed at booking from the confirmed check-in/check-out dates. For stays of
   up to 14 nights there are stay variants for *k* = 1 … nights − 1, and a dispute in the last night uses
   `chargebackClaim`. **Stays longer than 14 nights get no stay variants at all**: a mid-stay dispute waits for the
   arbiter (no automatic default — money stays locked until the arbiter rules or the parties agree). Chosen over
   partial coverage, which would either pay the hotel for nights not yet decided or give the guest free nights.
2. **Night anchor.** Nights start at the **scheduled** check-in time (`timers.checkIn`, known at booking), not the
   hotel's recorded check-in; night *i* begins at `checkIn + i·24h`, and checkout (`deliveryBy`) ends the last
   night. All Tickets (including every stay variant's) are created in the open Batch, sized from `nights`.
3. **One dispute per deal, and its kind is fixed by when it's filed.** Once the guest is checked in (check-in
   recorded **and** deposit in), an `entry` dispute is refused at ingest — the guest must file a `stay` dispute
   (so a guest can't stay a night and then claim the full entry refund). Before check-in counts, only `entry`
   applies. After checkout, `settlement`. A second dispute on the same deal is refused (`ALREADY_DISPUTED`).
4. **Precedence.** An open dispute already blocks refund/no-show/release (N4, L2 and the refund's confirmation
   rule). The chargeback variants are mutually exclusive by the dispute's phase and its receipt night. A hotel
   claim posted after a mid-stay dispute is still receipted (the arbiter may award it) but the chargeback default
   ignores it — the deposit goes back to the guest.
5. **The arbiter's clock and notice.** The deadline runs from the co-signer's **receipt** of the dispute statement
   (backdating is already bounded by STALE_ISSUED). The arbiter learns of disputes from the co-signer
   (`GET /v1/engagements/:id/attestations`) and the on-ledger dispute credential; a ruling counts only once the
   arbiter's `party.ruling/1` is **receipted** before the deadline. A receipted ruling blocks the chargeback
   indefinitely: the winning party + arbiter can always close, the losing party can't block them.
6. **Who signs, and if they don't.** Same as the check-in order rule: the entry chargeback is pre-signed at open with
   the refund/no-show; the claim and stay variants at check-in **before** the deposit is paid. A guest who won't
   sign doesn't get the keys (refused check-in → no-show).
7. **Positive residual.** Every chargeback runs only with a bonded dispute open, so the residual sweep to the guest
   is at least the bond (> 0). B11 still refuses any variant whose fixed legs exceed the balance.
8. **Rounding.** nightly = floor(room ÷ nights) in the asset's minor units; for *k* < nights the hotel's leg is
   *k* · nightly (less fee); the last night (via `chargebackClaim`) pays the whole room, absorbing the remainder.
9. **`allowedArbiters`** lives in the guest's `party.mandate/1` claim (already passed to `register()`); absent ⇒
   any accredited arbiter.

## 5. What is deliberately not enforced (document plainly)

- **Accreditation lost mid-deal** (expiry, revocation): the arbiter can still sign a ruling with one party —
  never alone. Not handled beyond the registration-time check; the accreditor revokes and the record shows it.
- **Hidden ties** between an arbiter and the hotel: the accreditor's responsibility.
- **Arbiter fees**: a term of accreditation, not code.
- **Guests who block receiving** push an outcome to the arbiter (already documented in the hotel spec).

## 6. Goals / non-goals

**Goals:** amend hotel@2 + pol_hotel@2.0.0 (drop backup, add chargebacks, accreditation params); async
`register()` gate; validator V15; dispute phase `stay`; norms update; HotelFlow + Testnet demo (replace the
backup-ruling path with "arbiter silent → chargeback", add a mid-stay chargeback and an unaccredited-arbiter
refusal); web demo + transcript; vectors; docs including §3 assumptions and §5.

**Non-goals:** outside accreditation bodies, KYB/KYA for arbiters, a provisioning-coordinator gate, replacing a
lapsed arbiter, the arbiter service itself.

## 7. Left to the builder

Reason codes; exact CEL; rounding helper; how per-night variants are named/stored; ticket allocation; how the
deal's ruling window is pinned (record field vs engagement layer).
