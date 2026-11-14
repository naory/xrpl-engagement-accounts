# Arbiter neutrality (design)

Status: design, 2026-11-13. Applies to **every template with an arbiter role** (today `settlement-vault/hotel@1`
and `@2`; future escrow and bond templates). The hotel is the first user.

## 1. Intent

In every template with an arbiter, **the arbiter plus one party can move the money without the policy
co-signer**. That is deliberate: rulings must work even when the service is down. It also means the
arbiter's neutrality can't be enforced by the co-signer refusing a ruling. It has to be settled **before any
money goes into the account**, and it has to rest on more than the merchant's say-so.

Real-world shape (decided with the user): a merchant may contract its own arbiter provider, but that provider
must be **accredited by a recognised outside body**, the guest's side must accept it, and the merchant must not
also pick the backup arbiter.

**Anti-goals:** the hotel (or any merchant) can put an arbiter of its own choosing on the deal without outside
accreditation; the merchant picks both arbiters; an accreditation check that only the demo performs; a
neutrality claim the system can't actually back.

## 2. Decisions

1. **Accreditation is an XRPL Credential** (XLS-70), consistent with how attesters are accredited
   (`docs/spec/attestations.md` D4): issued by an accrediting body to the arbiter's XRPL account, type
   **`ENG/ARBITER`** (my call; the original hotel design called it `ARBITER_ACCREDITED`, renamed to match the
   `ENG/…` namespace), checked at the pinned ledger, expirable and revocable by the issuer. It must be
   **accepted** by the arbiter (unlike dispute credentials).
2. **Who may accredit: recognised outside bodies, listed per template** (user's decision). Each template with
   an arbiter role references a **trust list** — a small, versioned JSON file (e.g.
   `trust/arbiters.hotel@1.json`) naming the accrediting issuers (XRPL accounts, with a display name) and the
   credential type. The engagement service may be one issuer; it is not special. Lists live outside the
   template because they change; the template references one (`roles.<arbiter>.accreditation.trustListRef`,
   matching the `allowlistRef` sketched in `docs/use-cases/hotel-booking.md`).
3. **Identity besides accreditation** (optional per trust list): the trust list may also require KYB for the
   arbiter organisation and, for an AI arbiter, a KYA credential binding the agent's key to its accountable
   operator. Same mechanism: required `{type, issuers}` credentials on the arbiter account. The accreditation
   credential's `URI` may point to a **DID** holding the arbiter's published terms (fee schedule, independence
   statement, ruling deadlines). Nothing resolves DIDs; it is a pointer for people and agents.
4. **The guest can only narrow.** The mandate's `allowedArbiters` may list specific arbiter accounts and/or
   `allowedArbiterIssuers` specific accrediting bodies. It can never admit an arbiter the trust list doesn't.
   An absent list means "any accredited arbiter".
5. **Backup appointment.** The backup arbiter is appointed by the engagement service from the accredited pool,
   unless the guest's mandate names one. Never by the merchant. The engagement record carries
   `appointments: { arbiter: 'counterparty' | 'service' | 'principal', backupArbiter: 'service' | 'principal' }`,
   which the pre-booking check (`dealTerms`) reads.
6. **Fees** are a term of accreditation (flat, never outcome-contingent), stated in the arbiter's published
   terms. Not enforced in code; the accrediting body enforces it.

## 3. Enforcement (before money goes in)

| Where | What | Why there |
|---|---|---|
| **Provisioning coordinator** (`packages/provisioning`) | `plan()` refuses to assemble the SignerList unless, at a fresh ledger snapshot: every arbiter role's enrolled account holds an accepted, unexpired `ENG/ARBITER` from a trust-list issuer (plus any required KYB/KYA); each arbiter is allowed by the mandate; the backup's appointer is `service` or `principal`. Refusal names the failing check. | The coordinator assembles the deal; no SignerList, no account to fund. |
| **Co-signer `register()`** | Same checks; refuses to register. | Backstop: the co-signer never co-signs anything for a non-neutral deal (no settlement, no defaults). |
| **Template validator** | New check: every role of kind `arbiter` declares `accreditation.trustListRef`. | Makes neutrality a property of every arbiter template, not a per-deal option. |
| **Guest's funding signature** | Out of scope: the guest's agent signs the open Batch only after the pre-booking check passes (already shipped: `checkNorms` flags unaccredited arbiters and a merchant-picked backup). | That's the agent's decision. |

## 3a. Settled details (my calls, from the builder check)

- **Who chooses the backup, and how that's trusted.** `appointments` is never supplied by the merchant. The
  coordinator itself picks the backup from the accredited pool (any trust-list-accredited arbiter other than
  the primary), unless the guest's mandate names one. The coordinator writes `appointments` into the record;
  the co-signer re-checks that the backup is accredited and, if the mandate named one, that it matches.
- **The mandate already reaches provisioning** (`SessionSpec.mandate`, a signed `party.mandate/1`). Its claim
  gains optional `allowedArbiters` (accounts) and `allowedArbiterIssuers` (accrediting bodies); the
  coordinator verifies the mandate is signed by the principal before trusting them.
- **Ledger access.** The coordinator gets an optional `LedgerSource` (same interface the co-signer uses) and
  `plan()` becomes async when the template has arbiter roles. The co-signer's check runs in an async
  `register()` (callers updated); it adds the arbiters to the snapshot's `credentialSubjects`.
  `LedgerFacts.hasCredential` already requires accepted + unexpired.
- **The trust list is pinned to the deal**, like policy layers: the record carries the trust list's id and
  content hash, and the accrediting issuers it names (`eng.trust.arbiterIssuers`), so the coordinator and the
  co-signer can't disagree and policy rules can read them. Mid-deal checks use the pinned list plus the
  *current* credential state on the ledger: expiry and revocation by the issuer count as lapses; an issuer
  later dropped from the trust list affects new deals only (the issuer can still revoke individual
  credentials).
- **The lapsed-backup rule** is a policy rule: `ledger.hasCredential(eng.parties.backupArbiter, 'ENG/ARBITER',
  eng.trust.arbiterIssuers)` (plus a plain-English title/message).
- **Basic independence checks** at provisioning and registration: an arbiter may not be the guest's or the
  hotel's account, and the primary and backup must be different accounts.
- **Templates are amended in place** (pre-release project: no live engagements pin them): `hotel@1` and
  `hotel@2` gain `accreditation.trustListRef` on their arbiter roles; vectors are regenerated.
- **Demo:** live mode funds a Testnet "accreditation body" account that issues `ENG/ARBITER` credentials the
  arbiters accept (as the B1 demo does for KYB). Simulated mode and the pre-booking panel keep their static
  offers.

## 4. What is deliberately NOT enforced (document this plainly)

- **Accreditation lost mid-deal** — by expiry (most common), revocation by the issuer, the issuer being dropped
  from the trust list, a lapsed KYB/KYA, or the arbiter shutting down. The arbiter's seat is in the SignerList,
  which doesn't check credentials, so a lapsed arbiter **can still sign a ruling with one party** and the
  ledger accepts it. The arbiter **can't move money alone** (weight 4 < quorum 7; with the co-signer or the
  backup, 6). The residual risk is a merchant colluding with a lapsed arbiter — the existing trust assumption,
  now with an arbiter no longer vouched for. Agreed handling:
  - **Refuse lapsed backups:** the co-signer refuses `ruling.backup` if the backup arbiter's accreditation has
    lapsed at the decision ledger (new policy rule, plain-English title/message).
  - **Flag lapsed rulings:** when a closing transaction signed by an arbiter whose accreditation had lapsed is
    seen, the co-signer records a signed advisory decision flagging it, for the indexer and the accrediting
    body; parties can contest off-ledger.
  - **Not now: replacing the arbiter.** Guest + hotel + co-signer (weight 8) could rewrite the SignerList to
    swap a lapsed arbiter, but a colluding merchant wouldn't agree, and it needs a new template outcome and
    stage. Recorded as a follow-up.
- **Hidden ties.** A credential can't prove an arbiter has no undisclosed relationship with the merchant; the
  accrediting body attests to independence and revokes for violations.
- **Fees** (see 2.6).

## 5. Goals / non-goals

**Goals:** trust-list file(s) + template references; validator check; provisioning and co-signer
registration checks with clear refusal reasons; `appointments` in the engagement record and in `dealTerms`;
the lapsed-backup rule and the lapsed-ruling flag; tests and conformance vectors; docs (the "not enforced"
section above in the README/spec, user's request); the Hotel stay demo provisions an accredited arbiter and a
service-appointed backup (live mode issues and accepts the credentials on Testnet).

**Non-goals:** the arbiter service itself; DID resolution; replacing a lapsed arbiter; fee enforcement; an
accreditation body's own processes.

## 6. Left to the builder

Exact JSON shape of trust lists and the template reference; refusal reason codes; how `appointments` is
supplied to provisioning (session spec field); whether the lapsed-ruling flag runs on `tick()` or on an
explicit "observe close" call; vector cases.
