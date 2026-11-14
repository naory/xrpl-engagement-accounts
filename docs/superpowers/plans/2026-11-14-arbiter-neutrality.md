# Arbiter Neutrality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No account with an arbiter role can open unless each arbiter is accredited by a recognised outside body on the template's trust list, allowed by the guest's mandate, independent of the parties, and the backup was not picked by the merchant — plus refuse lapsed backups and flag lapsed primary rulings.

**Architecture:** One pure check, `checkArbiterNeutrality()` in `@eng/policy`, runs over a credential snapshot and is called by both gates: the provisioning coordinator's `plan()` (before the SignerList exists) and the co-signer's `register()` (backstop). Trust lists are versioned JSON files referenced by templates and pinned into each engagement record by content hash. Two policy rules handle accreditation lost mid-deal.

**Tech Stack:** TypeScript (Node ≥ 22.12, tsx), vitest, xrpl.js 4 (Credentials / XLS-70).

**Spec:** `docs/superpowers/specs/2026-11-13-arbiter-neutrality-design.md` (binding; read §2, §3, §3a, §4).

## Global Constraints

- Credential type for accreditation: `ENG/ARBITER`. Must be **accepted** by the arbiter and unexpired at the check's ledger `closeTime`.
- Accrediting issuers come only from the template's trust list; the guest's mandate can only narrow (`allowedArbiters` accounts, `allowedArbiterIssuers` issuers); absent list = any accredited arbiter.
- Backup appointer must be `service` or `principal`; the merchant (`counterparty`) never appoints the backup. The primary may be appointed by `counterparty`.
- An arbiter may not be the principal's or counterparty's account; primary and backup must differ.
- Trust lists are pinned per engagement by content hash (`documentHash` from `@eng/core`), like policy layers. Mid-deal checks use the pinned list + current ledger credential state.
- Every new or changed policy rule carries a plain-English `title` and `message` (lint L8).
- Templates `hotel@1` and `hotel@2` are amended in place (pre-release); vectors regenerated.
- Use Node (not Python) for scripted edits. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch: `feat/arbiter-neutrality`.
- After every task: `npm test`, `npm run typecheck`, `npm run lint-policies`, `npm run validate-templates`, `npm run vectors:check` clean.

## Review Focus

1. **A credential that exists but expired** (Expiration ≤ closeTime) → treated as not accredited. Test in Task 3.
2. **A credential issued but not accepted** by the arbiter → not accredited. Test in Task 3.
3. **An `ENG/ARBITER` credential from an issuer not on the pinned trust list** — e.g. the hotel accrediting its own arbiter → not accredited. Test in Task 3.
4. **A backup enrolled under an account other than the one the service (or the mandate) designated** → `plan()` refuses. Test in Task 6.
5. **The ledger is unreachable when registering** → `register()` throws (fails closed), never registers. Test in Task 4.

---

### Task 1: Follow-ups from the sweep review

**Files:** Modify `packages/policy/src/facts.ts:256` (`minorRounded`), `docs/superpowers/specs/2026-11-12-hotel-stay-escrow-design.md:192`; Test `packages/policy/test/policy.test.ts`.

- [ ] **Step 1: Failing test** `it('B11: trust-line dust beyond 36 decimals does not block a payee with room')` — a payee whose line `balance` is `'1e-50'` and limit `'1000000'` receiving a 100 RLUSD payout: `wouldSucceed()` true (today it throws "too many decimals" and B11 fails).
- [ ] **Step 2: Run** `npx vitest run packages/policy/test/policy.test.ts -t dust` → FAIL.
- [ ] **Step 3: Fix** `minorRounded` to truncate digits beyond its working precision before converting (keep `floor`/`ceil` semantics), never throw on long fractions.
- [ ] **Step 4:** Rewrite spec §5.3 line 192: after a hotel `checked_in`, a later `refused` is rejected (`CHECKIN_FINAL`); a guest who doesn't pay the deposit still ends as a no-show because check-in only counts once the deposit is in.
- [ ] **Step 5: Run** all checks → PASS. **Commit** `fix(policy): B11 tolerates trust-line dust; spec §5.3 check-in wording`.

---

### Task 2: Trust lists and template references

**Files:**
- Create: `trust/arbiters.hotel@1.json`
- Modify: `packages/core/src/template.ts` (types + validator), `templates/hotel@1.json`, `templates/hotel@2.json`
- Test: `packages/core/test/core.test.ts`

**Interfaces:**
- Produces (in `packages/core/src/template.ts`, exported):
  - `RoleDef.accreditation?: { trustListRef: string }`
  - `interface TrustList { trustListId: string; description?: string; credentialType: string; issuers: Array<{ account: string; name: string }>; requires?: Array<{ type: string; issuers: string[]; description?: string }> }`
  - Validator **V15**: every role with `kind: 'arbiter'` declares `accreditation.trustListRef` (error `V15`).
- Trust list file content: `trustListId: "trust/arbiters.hotel@1"`, `credentialType: "ENG/ARBITER"`, one placeholder issuer `{ "account": "rArbiterAccreditorPlaceholderXXXXXX", "name": "Example Arbitration Accreditation Body" }`, `requires: []`, and a `description` stating that real deployments replace the placeholder with recognised bodies (tests/demos substitute their own accounts, as fixtures do with `withIssuer`).
- Both hotel templates: `arbiter` and (hotel@2) `backupArbiter` roles gain `"accreditation": { "trustListRef": "trust/arbiters.hotel@1" }`.

- [ ] **Step 1: Failing tests** in `core.test.ts`: `it('V15: an arbiter role must reference a trust list')` (clone hotel@2, delete the ref → errors contain `V15`); existing hotel@1/@2 acceptance tests still `ok`.
- [ ] **Step 2: Run** `npx vitest run packages/core` → FAIL.
- [ ] **Step 3: Implement** types, V15, the trust list file, template refs.
- [ ] **Step 4: Run** `npm run vectors:build` then all checks → PASS (template vectors change; expectations hold).
- [ ] **Step 5: Commit** `feat(core): trust lists for arbiter accreditation; V15 requires one per arbiter role`.

---

### Task 3: `checkArbiterNeutrality()` — the shared check

**Files:** Create `packages/policy/src/neutrality.ts` (export from `packages/policy/src/index.ts`); Modify `packages/policy/src/types.ts` (`EngagementRecord`); Test `packages/policy/test/neutrality.test.ts`.

**Interfaces:**
- Produces:
  - `EngagementRecord.appointments?: Record<string, 'service' | 'principal' | 'counterparty'>` (per arbiter role)
  - `EngagementRecord.trust?: { listId: string; hash: string; credentialType: string; arbiterIssuers: string[] }`
  - `pinTrust(list: TrustList): NonNullable<EngagementRecord['trust']>` — hash = `documentHash(list)`.
  - `interface NeutralityFinding { code: string; role?: string; message: string }`
  - `checkArbiterNeutrality(o: { template: Template; trustList: TrustList; parties: Record<string, string>; appointments: EngagementRecord['appointments']; mandateClaim?: { allowedArbiters?: string[]; allowedArbiterIssuers?: string[]; backupArbiter?: string } | null; credentials: LedgerCredential[]; closeTime: string }): NeutralityFinding[]` — empty = neutral.
- Codes (one per failing condition, role-scoped where applicable): `ARBITER_NOT_ACCREDITED`, `MISSING_REQUIRED_CREDENTIAL`, `ARBITER_NOT_ALLOWED`, `BACKUP_APPOINTED_BY_MERCHANT`, `BACKUP_NOT_MANDATE_CHOICE`, `ARBITER_IS_PARTY`, `ARBITERS_SAME`, `APPOINTMENT_MISSING`. Arbiter roles = template roles with `kind: 'arbiter'`; the backup = an arbiter role other than one named `arbiter` (in hotel@2: `backupArbiter`).

- [ ] **Step 1: Failing tests** (`neutrality.test.ts`, fixture accounts from `packages/policy/test/fixtures.ts` `wallet()`), each asserting the exact `code` list:
  - neutral hotel@2 deal (both arbiters hold accepted, unexpired `ENG/ARBITER` from the list issuer; backup appointed by `service`) → `[]`
  - credential expired at closeTime → `['ARBITER_NOT_ACCREDITED']` (Review Focus 1)
  - credential not accepted → `['ARBITER_NOT_ACCREDITED']` (RF 2)
  - `ENG/ARBITER` issued by the hotel's own account → `['ARBITER_NOT_ACCREDITED']` (RF 3)
  - trust list `requires` a `KYB_VERIFIED` the arbiter lacks → `['MISSING_REQUIRED_CREDENTIAL']`
  - mandate `allowedArbiters` excludes the primary → `['ARBITER_NOT_ALLOWED']`; `allowedArbiterIssuers` excluding the list issuer → `ARBITER_NOT_ALLOWED` for both roles
  - `appointments.backupArbiter = 'counterparty'` → `['BACKUP_APPOINTED_BY_MERCHANT']`
  - mandate names a backup account ≠ enrolled backup → `['BACKUP_NOT_MANDATE_CHOICE']`
  - arbiter = counterparty account → includes `ARBITER_IS_PARTY`; arbiter = backup account → includes `ARBITERS_SAME`
  - `pinTrust(list).hash` equals `documentHash(list)` and changes when an issuer is added.
- [ ] **Step 2: Run** `npx vitest run packages/policy/test/neutrality.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Credential validity: same semantics as `LedgerFacts.hasCredential` (subject, type, accepted, issuer in set, not expired at `closeTime`).
- [ ] **Step 4: Run** → PASS; all checks green.
- [ ] **Step 5: Commit** `feat(policy): checkArbiterNeutrality — accreditation, mandate, appointment and independence checks`.

---

### Task 4: Co-signer gate — async `register()` refuses non-neutral deals

**Files:** Modify `packages/cosigner/src/service.ts` (`CosignerOptions`, `register`), `packages/cosigner/src/server.ts` (route + `loadLibrary` reads `trust/`), every `register(` caller (`packages/agent-mcp/{demo,test}`, `packages/cosigner/{demo,test,src/hotel/flow.ts}`, `packages/web/src/{hotel-sim,orchestrator}.ts`); Test `packages/cosigner/test/hotel-service.test.ts`, `packages/policy/test/fixtures.ts`.

**Interfaces:**
- Consumes: Task 2 `TrustList`, Task 3 `checkArbiterNeutrality`, `pinTrust`.
- Produces: `CosignerOptions.trustLists?: TrustList[]`; `register(record, mandate?): Promise<{ ok: true; layers: string[] }>`. For a template with arbiter roles, `register` requires `record.trust` (pinned) whose `hash` matches a loaded list with that `listId` (else `TRUST_LIST_UNKNOWN` / `TRUST_LIST_MISMATCH`), and `record.appointments`; takes a fresh snapshot with `credentialSubjects` = all arbiter accounts (+ required-credential subjects); throws `NOT_NEUTRAL: <codes>` on any finding. Templates without arbiter roles: unchanged behaviour (still awaited). The idempotent re-register path stays.
- Fixtures: hotel@1 and hotel@2 engagement fixtures gain `trust` + `appointments`, and their ledgers gain accepted `ENG/ARBITER` credentials from a fixture accreditor (`W.accreditor = wallet('accreditor')`); `policies`-style helper `trustListFor(issuer)` substitutes the placeholder issuer.

- [ ] **Step 1: Failing tests:** neutral hotel@2 record registers; a record whose backup lacks the credential → rejects `/NOT_NEUTRAL: .*ARBITER_NOT_ACCREDITED/` and the engagement is not registered (`svc.engagement(id)` undefined); a record with a tampered `trust.hash` → `/TRUST_LIST_MISMATCH/`; a `LedgerSource` whose `snapshot` rejects → `register` rejects and nothing is registered (Review Focus 5); a procurement (no-arbiter) record registers as before.
- [ ] **Step 2: Run** `npx vitest run packages/cosigner` → FAIL.
- [ ] **Step 3: Implement**, then update every caller to `await` (callers' own tests must stay green).
- [ ] **Step 4: Run** all checks → PASS.
- [ ] **Step 5: Commit** `feat(cosigner): register refuses engagements whose arbiters aren't neutral (async)`.

---

### Task 5: Mid-deal lapses — refuse lapsed backups, flag lapsed primary rulings

**Files:** Modify `policies/hotel@2.0.0.json`, `policies/baseline@1.1.0.json` (allowedTypes for the new stage), `vectors/cases.ts`; Test `packages/policy/test/hotel2.test.ts`.

**Interfaces:**
- Produces:
  - `ruling.backup` rule **U7** `BACKUP_NOT_ACCREDITED`: `ledger.hasCredential(eng.parties.backupArbiter, eng.trust.credentialType, eng.trust.arbiterIssuers)`; title "Backup arbiter still accredited"; message explaining a lapsed backup can't rule.
  - New advisory stage **`ruling.primary`** (enforcement `advisory`) with rule **A1** `ARBITER_LAPSED`: `ledger.hasCredential(eng.parties.arbiter, eng.trust.credentialType, eng.trust.arbiterIssuers)`; title "Arbiter still accredited"; message: the ruling still counts on-ledger, but this decision record flags it for the indexer and the accrediting body. Baseline `allowedTypes['ruling.primary'] = ["Batch","Payment","TrustSet","AccountDelete"]`. No template outcome maps to it (advisory: the co-signer never signs it).
  - Add A1 to the existing advisory `ruling.default` stage as well.
- [ ] **Step 1: Failing tests:** backup ruling after the window with the backup's credential expired → `failing` contains `U7`; with it valid → no `U7`; `ruling.primary` with a lapsed arbiter → `['A1']`, with a valid one → `[]`; L8 lint still passes.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; add matching vector cases. **Step 4: Run** `npm run vectors:build` + all checks → PASS.
- [ ] **Step 5: Commit** `feat(policy): refuse lapsed backup rulings (U7); flag lapsed primary rulings (A1)`.

---

### Task 6: Provisioning gate — `plan()` refuses non-neutral deals

**Files:** Modify `packages/provisioning/src/protocol.ts`, `packages/provisioning/src/http.ts`, `packages/provisioning/README.md`; Test `packages/provisioning/test/provisioning.test.ts`.

**Interfaces:**
- Consumes: Task 3 check + `pinTrust`; Task 2 types.
- Produces:
  - `new ProvisioningCoordinator(o?: { nonce?; templates?: Template[]; trustLists?: TrustList[]; credentials?: (subjects: string[]) => Promise<{ closeTime: string; credentials: LedgerCredential[] }> })`
  - `SessionSpec.designated?: Record<string, { account: string; by: 'service' | 'principal' }>` — the service designates the backup (and optionally the primary); if the mandate claim names `backupArbiter`, that account is used with `by: 'principal'` and a conflicting service designation is an error.
  - `enrol()` rejects an enrolment for a designated role from any other account (`NOT_DESIGNATED`).
  - `plan(sessionId): Promise<OpenPlan>`. When the coordinator knows the session's template and it has arbiter roles: requires `templates`, `trustLists`, `credentials` (else throws `NEUTRALITY_UNCONFIGURED`); verifies the mandate is signed by the enrolled principal before using its claim; builds `appointments` (designated `by`; undesignated primary → `counterparty`); runs `checkArbiterNeutrality`; throws `NOT_NEUTRAL: <codes>` on findings; otherwise the plan's `engagement` carries `trust` (pinned) and `appointments`. Coordinators constructed without `templates` keep today's behaviour (documented as unchecked; the co-signer gate still applies).
- [ ] **Step 1: Failing tests:** neutral hotel@2 session plans with `engagement.trust.hash` and `appointments.backupArbiter === 'service'`; backup enrolled from a non-designated account → `enrol` throws `NOT_DESIGNATED` (Review Focus 4); unaccredited arbiter → `plan` rejects `NOT_NEUTRAL`; mandate naming a backup conflicting with the service designation → error; arbiter template with an unconfigured coordinator → `NEUTRALITY_UNCONFIGURED`; procurement session unchanged (await).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (+ HTTP route awaits `plan`). **Step 4: Run** all checks → PASS.
- [ ] **Step 5: Commit** `feat(provisioning): plan() enforces arbiter neutrality before the SignerList exists`.

---

### Task 7: Demos — accredited arbiters on Testnet, simulated transcript, live run

**Files:** Modify `packages/cosigner/src/hotel/flow.ts`, `packages/cosigner/demo/hotel-testnet.ts`, `packages/web/src/hotel-sim.ts`, `packages/web/src/orchestrator.ts`, `packages/cosigner/demo/README.md`; regenerate `packages/web/public/hotel-sim.json`.

**Interfaces:** Consumes Tasks 4–6. HotelFlow's cast gains an `accreditor` wallet; setup issues `ENG/ARBITER` (`CredentialCreate`, issuer = accreditor) to the arbiter and backup, who accept it (`CredentialAccept`); records carry `trust` (pinned in-memory trust list with the accreditor's account) and `appointments` (`arbiter: 'counterparty'`, `backupArbiter: 'service'`); the co-signer is constructed with that trust list. Before submitting a primary arbiter ruling, the flow records the advisory `ruling.primary` decision.

- [ ] **Step 1:** Implement; keep H1–H15 passing; add **H16**: an engagement whose arbiter holds no accreditation → `register()` rejects `NOT_NEUTRAL` (no account funded); **H17**: a backup whose credential carries a short `Expiration` that passes before its ruling → the co-signer refuses the backup ruling with `U7`.
- [ ] **Step 2:** `npm run web:hotel-sim` (equality test guards it); the orchestrator's live hotel provisioning passes `templates`, `trustLists` and a `credentials` function (via `XrplLedgerSource`) to its coordinator.
- [ ] **Step 3: Live run** `npm run demo:hotel` in the background (log to the scratchpad) → H1–H17 all pass; record the results-file path.
- [ ] **Step 4:** All checks → PASS. **Commit** `feat(demo): accredited arbiters on Testnet; H16 unaccredited refused, H17 lapsed backup refused`.

---

### Task 8: Docs

**Files:** Modify `README.md` (§12 Built + the "not enforced" note), `ROADMAP.md` (move arbiter neutrality to Done; add "replace a lapsed arbiter" as a follow-up), `docs/spec/attestations.md` §5 (note `ENG/ARBITER` alongside attester accreditation), `docs/use-cases/hotel-booking.md` §9 (arbiter identity row now matches).

- [ ] **Step 1:** Write the plain "deliberately not enforced" section from spec §4 into the README hotel entry (lapsed arbiter can still rule with one party — never alone; hidden ties; fees), linking the spec.
- [ ] **Step 2:** `npm test` green; links resolve. **Commit** `docs: arbiter neutrality — what's enforced and what deliberately isn't`.
