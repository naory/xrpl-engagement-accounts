# Lean Arbiter Neutrality + Chargeback Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the backup arbiter with chargeback-style pre-signed defaults that fire when the arbiter misses its ruling deadline, and refuse to register any deal whose arbiter isn't accredited by the service.

**Architecture:** hotel@2 / pol_hotel@2.0.0 are amended in place: the `backupArbiter` role and `ruling.backup` stage go; three chargeback outcomes (entry, claim, stay — the stay one with one pre-signed variant per night) arrive, each completed by the co-signer only when a bonded guest dispute has outlived the arbiter's deadline unanswered. Accreditation issuers live in the policy's params (pinned by hash); the co-signer's now-async `register()` is the single gate.

**Tech Stack:** TypeScript (Node ≥ 22.12, tsx), vitest, xrpl.js 4 (Batch/XLS-56, Tickets, Credentials/XLS-70).

**Spec:** `docs/superpowers/specs/2026-11-14-arbiter-chargeback-design.md` — binding; §2 decisions, §3 assumptions, §4 mechanics, §4.5 settled details, §5 not enforced.

## Global Constraints

- Signers after the change: principal 3, counterparty 3, arbiter 4, cosigner 2 — quorum 7. No `backupArbiter` anywhere in hotel@2 code paths.
- Accreditation: credential type `ENG/ARBITER`, accepted and unexpired at the decision ledger's closeTime, issuer ∈ `params.arbiterIssuers`; arbiter ≠ principal and ≠ counterparty; if the mandate claim has `allowedArbiters`, the arbiter must be in it.
- Ruling deadline: default `params.rulingWindow` = `"432000s"` (5 days); a deal may pin its own value; norms flag < 3 days and > 7 days.
- Chargeback defaults (spec §2.3): entry → everything to the guest; claim → room to hotel (less fee), rest to guest; stay mid-stay → *k* nights to hotel (less fee), rest to guest; stay after checkout or in the last night → as claim. Stays > 14 nights get no stay variants.
- nightly = floor(room ÷ nights) in the asset's minor units; nights start at the **scheduled** `timers.checkIn` + i·24h; the dispute's night is computed from its `issuedAt` (bounded to receipt by STALE_ISSUED).
- One dispute per deal; once checked in (check-in recorded and deposit in) an `entry` dispute is refused; a ruling counts only once the arbiter's `party.ruling/1` is receipted.
- Every new or changed rule has a plain-English `title` + `message` (lint L8). Template outcomes/timers keep `description`s.
- Use Node (not Python) for scripted edits. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch `feat/arbiter-neutrality`.
- After every task: `npm test`, `npm run typecheck`, `npm run lint-policies`, `npm run validate-templates`, `npm run vectors:check` all clean.

## Review Focus

1. **A ruling posted after the deadline** must not block a due chargeback (the receipt-time rule, ingest LATE) — test in Task 4.
2. **A guest who files `entry` after a night's stay** to get the full refund → refused at ingest (`NOT_ENTRY`) — test in Task 4.
3. **A stay dispute exactly at a night boundary** → counted in the night that has begun (night *i* starts at checkIn + i·24h, inclusive) — test in Task 3.
4. **Chargeback when the arbiter did rule in time** (ruling receipted) → every chargeback variant refuses forever — test in Task 3.
5. **Registration while the ledger is unreachable** → `register()` rejects and registers nothing — test in Task 4.

---

### Task 1: Follow-ups from the sweep review

**Files:** Modify `packages/policy/src/facts.ts` (`minorRounded`), `docs/superpowers/specs/2026-11-12-hotel-stay-escrow-design.md` §5.3 (line ~192); Test `packages/policy/test/policy.test.ts`.

- [ ] **Step 1: Failing test** `it('B11: trust-line dust beyond 36 decimals does not block a payee with room')`: payee line balance `'1e-50'`, limit `'1000000'`, 100 RLUSD payout → `wouldSucceed()` true.
- [ ] **Step 2:** run → FAIL ("too many decimals").
- [ ] **Step 3:** `minorRounded` truncates digits beyond its working precision instead of throwing (floor/ceil semantics kept). Rewrite §5.3: after a recorded `checked_in`, a later `refused` is rejected (`CHECKIN_FINAL`); a guest who doesn't pay the deposit still ends as a no-show because check-in only counts once the deposit is in.
- [ ] **Step 4:** all checks → PASS. **Commit** `fix(policy): B11 tolerates trust-line dust; spec §5.3 check-in wording`.

---

### Task 2: Engine support — night counting and per-night variant tickets

**Files:** Modify `packages/policy/src/env.ts`, `packages/core/src/template.ts`; Test `packages/policy/test/policy.test.ts`, `packages/core/test/core.test.ts`.

**Interfaces — Produces:**
- CEL function `nightsElapsed(start: google.protobuf.Timestamp, at: google.protobuf.Timestamp): int` = number of 24 h boundaries from `start` that are ≤ `at` (so `at == start` → 0; `start + 24h` → 1; `at < start` → 0).
- `OutcomeDef.variants?: { perNight: true; max: number }` — a presigned outcome pre-signed once per night (up to `max`). Validator V8 counts its Tickets as `max × (1 + steps)`; V4/V5 apply per variant as to any outcome.
- [ ] **Step 1: Failing tests:** `nightsElapsed` at start, start+24h−1s, start+24h (Review Focus 3 boundary: → 0, 0, 1), and before start → 0; V8 on a synthetic template with a 5-step outcome `variants: { perNight: true, max: 13 }` adds `13 × 6` Tickets.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS.
- [ ] **Step 5: Commit** `feat(engine): nightsElapsed() for CEL; per-night presigned variants in the template validator`.

---

### Task 3: hotel@2 rework — drop the backup arbiter, add chargebacks and accreditation params

**Files:** Modify `templates/hotel@2.json`, `policies/hotel@2.0.0.json`, `policies/baseline@1.1.0.json` (drop `ruling.backup` allowedTypes; add the three chargeback stages to `allowedTypes` and `presignedStages`), `norms/hotel@1.json`, `packages/core/src/template.ts` (V15), `packages/policy/src/types.ts`, `packages/policy/src/disclosure.ts`, `packages/policy/test/fixtures.ts`, `packages/policy/test/hotel2.test.ts`, `packages/policy/test/disclosure.test.ts`, `packages/core/test/core.test.ts`, `vectors/cases.ts`.

**Interfaces — Produces:**
- Template: roles `principal`, `counterparty`, `arbiter` (`"accreditation": "service"`), `cosigner`; no `ruling.backup`. New presigned outcomes (finalSigner cosigner, signers `[[principal, counterparty, cosigner]]`, each with a `description` from spec §2.3):
  - `default.chargebackEntry` — blueprint `close.refundAll` (single guest payment as a residual sweep)
  - `default.chargebackClaim` — blueprint `close.releaseWithDeposit` (hotel exact, fee exact, guest residual sweep)
  - `default.chargebackStay` — blueprint `close.releaseWithDeposit`, `variants: { perNight: true, max: 13 }`
- Validator **V15**: every `kind: 'arbiter'` role declares `accreditation` (value `"service"`).
- `EngagementRecord.terms?: { nights: number; nightly: string; rulingWindow?: string }` (record-pinned per deal; `rulingWindow` defaults to `params.rulingWindow`).
- Policy params: `arbiterCredentialType: "ENG/ARBITER"`, `arbiterIssuers: ["rArbiterAccreditorPlaceholderXXXXXX"]` (fixtures substitute `W.accreditor`, like `withIssuer`), `maxStayVariantNights: 14`.
- Policy definitions (names fixed): `arbiterRuling` (receipted `party.ruling/1` from role `arbiter`), `rulingWindow`, `rulingDue` (`def.disputeOpen && now > disputeOpenedAt + rulingWindow`), `stayDispute`, `stayNight` (= `nightsElapsed(timestamp(eng.timers.checkIn), timestamp(stayDispute.issuedAt)) + 1`), `nightly` (`amt(eng.terms.nightly,…)`). `disputeOpenedAt` covers the new `stay` phase.
- Stages (all `final-signature`), rule ids and meaning:

| Stage | Rules |
|---|---|
| `default.chargebackEntry` | E1 NOT_DUE (entry dispute open & `rulingDue`); E2 RULED (`arbiterRuling == null`); E3 TX_SHAPE (`close.refundAll`); E4 NOT_FULL_REFUND (guest receives the whole balance) |
| `default.chargebackClaim` | G1 NOT_DUE (`rulingDue` and the dispute is `settlement`, or `stay` with `stayNight >= eng.terms.nights`); G2 RULED; G3 TX_SHAPE (`close.releaseWithDeposit`); G4 HOTEL_LEG (hotel + fee == booked; S4 fee rule); G5 RESIDUAL (guest leg is the sweep) |
| `default.chargebackStay` | Y1 NOT_DUE (`stay` dispute open, `rulingDue`, `stayNight < eng.terms.nights`, `eng.terms.nights <= params.maxStayVariantNights`); Y2 RULED; Y3 TX_SHAPE; Y4 HOTEL_LEG (hotel + fee == `nightly * stayNight`; fee rule); Y5 RESIDUAL |

  Remove stage `ruling.backup` (U1–U7). `ruling.default` D-rules unchanged.
- Norms: drop H9/H10 (backup); H4 gains `"min": 259200` (3 days) alongside `max: 604800`, `why` updated. `dealTerms`/`HotelOffer` drop `backupArbiter`.
- [ ] **Step 1: Failing tests** (`hotel2.test.ts`, `failing` lists exact):
  - entry chargeback: bonded entry dispute, past deadline, no ruling, guest gets everything → `[]`; 1 s before deadline → `['E1']`; with a receipted arbiter ruling → `['E2']` (Review Focus 4)
  - claim chargeback: settlement dispute past deadline → `[]`; hotel leg short by 1 → contains `G4`
  - stay chargeback on a 3-night deal (nightly 133.33 for room 400): dispute in night 1 → variant paying 133.33 (less fee) `[]`; same blob with the dispute in night 2 → contains `Y4`; dispute in night 3 → stay variant `['Y1']` and claim variant `[]`
  - 15-night deal → stay variant `['Y1']`
  - every chargeback refuses with the ruling present; with no dispute open → its NOT_DUE rule
  - `core.test.ts`: V15 (arbiter role without `accreditation` → error); hotel@2 validates; `minimalWinningSets` no longer contains `backupArbiter`; arbiter + cosigner not winning
  - `disclosure.test.ts`: standard offer within norms; a 2-day ruling window flagged (H4, warn)
- [ ] **Step 2:** run → FAIL. **Step 3:** implement; update fixtures (`hotel2Engagement` gains `terms`, parties lose `backupArbiter`, ledgers gain accepted `ENG/ARBITER` from `W.accreditor`); port vector cases (remove `ruling.backup` cases, add the chargeback cases above).
- [ ] **Step 4:** `npm run vectors:build` + all checks → PASS.
- [ ] **Step 5: Commit** `feat(hotel@2): chargeback-style defaults replace the backup arbiter; accreditation params`.

---

### Task 4: Co-signer — accreditation gate, dispute rules, per-night variants

**Files:** Modify `packages/cosigner/src/service.ts`, `packages/cosigner/src/server.ts`, all `register(` callers (`packages/agent-mcp/{demo,test}`, `packages/cosigner/{demo,test}`, `packages/web/src/{hotel-sim,orchestrator}.ts`); Test `packages/cosigner/test/hotel-service.test.ts`.

**Interfaces — Produces:**
- `register(record, mandate?): Promise<{ ok: true; layers: string[] }>`. For templates with a role declaring `accreditation: "service"`: a fresh snapshot with the arbiter in `credentialSubjects`; throws `NOT_NEUTRAL: <codes>` (codes `ARBITER_NOT_ACCREDITED`, `ARBITER_IS_PARTY`, `ARBITER_NOT_ALLOWED`) and registers nothing. Credential validity as `LedgerFacts.hasCredential` against the effective policy layer's `arbiterIssuers`/`arbiterCredentialType`. Other templates unchanged (still awaited).
- Ingest additions: `party.dispute/1` with `phase: "stay"` (window `deliveryBy`, add `"party.dispute/1#stay": "deliveryBy"` to the template's `attestationWindows`); `NOT_ENTRY` when an `entry` dispute arrives once checked in (a counterparty `checked_in` receipted and balance ≥ booked + deposit at the ingest snapshot); `ALREADY_DISPUTED` for any second principal dispute; a counterparty-or-principal `party.ruling/1` from the arbiter after the deal's ruling deadline → `LATE` (so a late ruling can't block a due chargeback).
- Variants: `storePresigned(engagementId, 'default.chargebackStay#<k>', blob)` for k = 1 … nights−1 (outcome name before `#` must be a `variants.perNight` outcome; k ≤ max); `tick()` decides each stored variant under its outcome's `policyStage`, and returns `outcome` with the `#k` suffix.
- [ ] **Step 1: Failing tests:** neutral hotel@2 record registers; arbiter without `ENG/ARBITER` → rejects `/NOT_NEUTRAL: .*ARBITER_NOT_ACCREDITED/` and `svc.engagement(id)` is undefined; credential issued by the hotel → same; arbiter account = hotel → `ARBITER_IS_PARTY`; mandate `allowedArbiters` excluding it → `ARBITER_NOT_ALLOWED`; `snapshot` rejecting → `register` rejects, nothing registered (Review Focus 5); `entry` dispute after check-in → `NOT_ENTRY` (Review Focus 2); second dispute → `ALREADY_DISPUTED`; arbiter ruling after the deadline → `LATE`, and the claim chargeback then SIGNs on `tick` (Review Focus 1); stored stay variants #1/#2 on a 3-night deal: dispute in night 1 → `tick` SIGNs only `#1`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement; `await` every caller. **Step 4:** all checks → PASS.
- [ ] **Step 5: Commit** `feat(cosigner): register refuses unaccredited arbiters; stay disputes, one dispute per deal, per-night chargeback variants`.

---

### Task 5: HotelFlow + Testnet demo — accreditor, chargeback paths, live run

**Files:** Modify `packages/cosigner/src/hotel/flow.ts`, `packages/cosigner/demo/hotel-testnet.ts`, `packages/cosigner/demo/README.md`.

**Interfaces:**
- Consumes Tasks 3–4.
- Produces:
  - `HotelPath`: replace `backupRuling` with `arbiterSilent` (claim disputed, arbiter silent → `default.chargebackClaim`); add `staySilent` (mid-stay dispute on a 3-night booking, arbiter silent → `default.chargebackStay#1`).
  - `HotelCast` gains `accreditor`, loses `backupArbiter`.
  - Ticket allocation is computed per deal from `nights` (refund 4, no-show 5, no-show sweep 6, release 6, chargeback entry 4, chargeback claim 6, + 6 per stay variant); exported as `hotelTickets(nights: number)` replacing the fixed `HOTEL_TICKETS` / `HOTEL_TICKET_COUNT`.
  - Setup: the accreditor issues `ENG/ARBITER` to the arbiter, who accepts it. The demo policy copy substitutes the accreditor into `arbiterIssuers` and keeps its short `rulingWindow`. Records carry `terms`. The chargeback entry blob is pre-signed at open; the claim blob and stay variants at check-in, before the deposit.
- H checks:
  - **H8** becomes: arbiter silent on a disputed claim → chargeback claim completes. Payouts: room to hotel less fee, deposit and bond to guest.
  - **H9** becomes: the chargeback before the deadline → refused, `G1`.
  - **H14** becomes: arbiter + co-signer → `tefBAD_QUORUM`.
  - **H16:** unaccredited arbiter → `register()` refuses `NOT_NEUTRAL` before any funding.
  - **H17:** mid-stay dispute, arbiter silent → `chargebackStay#1`. Payouts: one night to hotel less fee, the rest to guest.
  - All other H checks keep passing.
- [ ] **Step 1:** implement; `npm run typecheck`.
- [ ] **Step 2: Live run** `npm run demo:hotel` in the background (log to the scratchpad) → all H checks pass; record the results file.
- [ ] **Step 3: Commit** `feat(demo): chargeback paths and accredited arbiter on Testnet (H8/H9/H14 updated, H16, H17)`.

---

### Task 6: Web demo — transcript, live scenario, page

**Files:** Modify `packages/web/src/hotel-sim.ts`, `packages/web/src/orchestrator.ts`, `packages/web/src/hotel-disclosure.ts`, `packages/web/public/index.html`, `packages/web/README.md`, web tests; regenerate `public/hotel-sim.json`, `public/hotel-disclosure.json`.

**Interfaces:**
- Consumes Task 5's `HotelPath`s.
- The page:
  - **Signer list:** drop the backup arbiter.
  - **Path buttons:** `arbiterSilent` ("Claim disputed, arbiter silent", shows: "The guest disputes the hotel's claim and the arbiter never rules. Like a card chargeback, the deposit and bond go back to the guest automatically.") and `staySilent` ("Problem mid-stay, arbiter silent", shows: "The guest disputes on night 1 and the arbiter never rules. The hotel keeps the night used; the remaining nights, deposit and bond go back to the guest.").
  - **`STEP_WHY` entries** for the new steps.
  - **Pre-booking panel:** the unusual offer now flags a short ruling window (replacing the backup-appointer flag).
- [ ] **Step 1:** update tests first:
  - `hotel-sim.test.ts`: terminal stages for the new paths are `default.chargebackClaim` / `default.chargebackStay` SIGN; the committed JSON equals a fresh build.
  - `hotel-disclosure.test.ts`: the unusual offer's flags are exactly `timers.disputeWindowEnds` serious, `depositBps` warn, `timers.rulingDueBy` warn.

  Run them and confirm they FAIL.
- [ ] **Step 2:** implement; `npm run web:hotel-sim && npm run web:disclosure`; all checks → PASS. Headless-DOM check of all paths: every step has a sentence and every check expands.
- [ ] **Step 3: Commit** `feat(web): chargeback paths replace the backup-arbiter path in the Hotel stay demo`.

---

### Task 7: Docs

**Files:** Modify `README.md` §12 (hotel entry: chargebacks, accredited arbiter, §3 assumptions + §5 not-enforced summarised), `ROADMAP.md` (Done; follow-ups: outside accreditation bodies, replacing a lapsed arbiter), `docs/superpowers/specs/2026-11-12-hotel-stay-escrow-design.md` (§4 weights and §5.8 point to the chargeback design), `docs/use-cases/hotel-booking.md` (status note), `docs/spec/attestations.md` §5 (`ENG/ARBITER`).

- [ ] **Step 1:** write; mark every chargeback/accreditation parameter as an assumption pending a real business (spec §3).
- [ ] **Step 2:** `npm test` green; links resolve. **Commit** `docs: chargeback-style arbiter defaults and service accreditation (assumptions marked)`.
