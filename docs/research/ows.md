# OWS spike: can its policy engine call a remote co-signer?

> The one question [docs/research/mpp.md](mpp.md) left open about the **Open Wallet Standard**
> (OWS, MoonPay, MIT): does its policy engine admit a **remote/external** policy service (our
> co-signer), or only local declarative rules? Answered here from the reference implementation and
> the normative sub-spec, not the launch posts.
>
> **Short answer: yes, but only as an allow/deny gate, never as a second signer.** OWS has no
> native remote-policy rule; the only external path is the **custom-executable escape hatch** — a
> local subprocess OWS runs per signing request, which *may itself* make an external API call. It
> returns a boolean verdict; OWS's own local key signs after an allow. That makes OWS a wallet
> layer the engagement co-signer can sit **beside**, not a substitute for the ledger-enforced
> quorum.

## What I read

The repo [`github.com/open-wallet-standard/core`](https://github.com/open-wallet-standard/core)
(MIT): the normative sub-spec [`docs/03-policy-engine.md`](https://github.com/open-wallet-standard/core/blob/main/docs/03-policy-engine.md)
and `docs/04-agent-access-layer.md` / `docs/05-key-isolation.md`, cross-checked against the Rust
reference types in `ows/crates/ows-core/src/policy.rs` (`Policy`, `PolicyRule`, `PolicyContext`,
`PolicyResult`, `PolicyAction`) and the engine in `ows-lib/src/policy_engine.rs`. Published crates:
`ows-lib` 1.4.2, `ows-cli` on docs.rs. The seven sub-specs and the key-isolation / MCP facts are
as summarised in [mpp.md §2](mpp.md); this note only goes deep on the policy engine.

## The policy engine, precisely

**Access tiers.** The caller's credential sets the tier — no bypass flag:

| Caller | Auth | Policy |
|---|---|---|
| **Owner** | passphrase (scrypt-decrypts the wallet) | **none** — full access |
| **Agent** | `ows_key_…` token | **every policy on the API key** is evaluated (AND; short-circuit on first deny) |

The token is both authentication and the decryption capability: at key creation OWS re-encrypts the
wallet secret under `HKDF-SHA256(token)`, so an agent token decrypts only its own copy, and
revocation is deleting that copy. Policy is evaluated **before key decryption** — a denial means
the key material is never touched. This is the agent tier an engagement co-signer would plug into.

**Two kinds of rule:**

1. **Declarative rules** (in-process, microseconds), tagged by `type`:
   - `allowed_chains` — CAIP-2 allowlist;
   - `expires_at` — time-bound;
   - `allowed_typed_data_contracts` — EIP-712 `verifyingContract` allowlist.

   That is the whole built-in set. Notably **per-transaction value caps, recipient allowlists, and
   cumulative daily spend are *not* declarative** — the spec says to use an executable for those.
   So the "spending limits / counterparty whitelists" the launch posts advertise are, in the
   reference implementation, **examples you write as an executable**, not config keys.

2. **Custom executable policies** — the escape hatch, verbatim: *"For anything declarative rules
   can't express — on-chain simulation, **external API calls**, complex business logic."* The
   protocol:
   ```
   echo '<PolicyContext JSON>' | /path/to/policy-executable        # stdin
   → stdout: { "allow": true | false, "reason"?: "…" }             # PolicyResult
   ```
   - `PolicyContext` carries `chain_id`, `wallet_id`, `api_key_id`, `request_type`
     (`sign_transaction` | `sign_message` | `sign_hash` | `sign_typed_data`), a `transaction`
     (`effects[]` + `raw_hex`), a lightweight `spending` (`daily_total`, `date`), `timestamp`, and
     the policy's own static `config` as `policy_config`.
   - **Fail-closed:** non-zero exit, invalid JSON, **>5 s runtime**, or a missing executable all
     → deny. Declarative rules act as a fast pre-filter; the executable only runs if they pass, and
     both must allow.

## The answer to the open question

**OWS can defer to a remote policy service, but only through a custom executable, and only for an
allow/deny verdict.** There is no `remote`, `webhook`, `approver`, `co-signer`, or `threshold`
rule type in the spec or in `PolicyRule`; the single mention of anything off-box is "external API
calls" as a motivating use of the executable. So the realisable shape is: *OWS runs a local
subprocess per signing request; that subprocess calls out to our co-signer; the co-signer answers
allow/deny; OWS then signs with its own local key.*

Three facts bound what that can mean for engagement accounts:

1. **The verdict is a boolean, not a signature.** `PolicyResult` is `{ allow, reason? }`. OWS gates
   its *own* single local key; it has no notion of a *second* signature contributed by the policy.
   The engagement account's guarantee is the opposite shape — a co-signature the **ledger** checks
   against the SignerList quorum. OWS cannot provide that, and a remote executable cannot inject it.
2. **On XRPL the executable must decode the raw transaction itself.** `effects[]` is populated only
   by chains whose signer implements flow analysis (today just Cardano); everywhere else, XRPL
   included, `effects` is empty and `raw_hex` is the whole payload. A policy that needs destination
   or amount has to decode `raw_hex`. Our co-signer already does full XRPL decode + policy, so a
   thin executable can forward `raw_hex` to it.
3. **The 5-second timeout is a real constraint.** The engagement co-signer pins a validated ledger
   and reads account/credential state before deciding — that can exceed 5 s over a public node, and
   an over-run is a **deny**. A remote-co-signer executable would need a fast path (a warm pinned
   snapshot, or a cached recent decision) to stay inside the budget.

## Ride vs differentiate

**Ride it — and it composes cleanly.** Put the agent's **weight-1 engagement-account key** in an
OWS wallet (key isolation: AES-256-GCM at rest, decrypted only to sign, never exposed to the agent
process or the model). Attach one executable policy to the agent's API key that forwards each
signing request to the engagement co-signer's `/decide` (decoding `raw_hex`) and maps **SIGN →
`allow`**, **REFUSE → `{ allow: false, reason }`**. The result is "an OWS wallet whose local-key
signing is gated by the ledger-enforced engagement policy" — the agent gets OWS's key hygiene *and*
the engagement account's bounded mandate, with no change to either side's core.

**Differentiate — the ledger layer is strictly stronger, and this spike proves why.** OWS gates one
local key *in the wallet, pre-sign*; its strongest output is "don't let my key sign." The
engagement account enforces a **quorum on the SignerList**: the co-signer's second signature is
required *by the ledger*, so even if the OWS gate were bypassed, misconfigured, or its executable
failed open, the engagement account's weight-1 key still cannot move funds alone. OWS has no escrow,
refunds, disputes, multi-party settlement, or recourse — exactly the gaps named for x402/MPP in
[mpp.md §1](mpp.md). So the relationship is **complementary, not competitive**: OWS is the
wallet/key-isolation layer underneath; the engagement account + co-signer is the ledger-enforced
quorum-and-recourse layer on top. Same distinction we draw against Privy / Sardis, now confirmed
against the actual spec rather than inferred.

> One caveat on "ride": a defensively written executable can fail **open** on a `request_type` it
> doesn't branch on (the spec documents this trap for `sign_typed_data`). A co-signer-backed
> executable must branch on `request_type`, decode `raw_hex`, and default-deny — i.e. not rely on
> OWS's pre-filter for anything load-bearing.

## Net

The open question is closed: **OWS admits an external co-signer only as a local, fail-closed,
5-second allow/deny subprocess — never as an on-ledger signer.** That is enough to *ride* OWS as the
agent's wallet (a thin executable bridging to `/decide`), and it confirms the *differentiator*: the
engagement account's quorum and recourse live on the ledger, which a pre-sign wallet gate — open or
otherwise — cannot replicate. No change to the co-signer is required to be OWS-rideable; a
reference "OWS policy executable" bridging to `/decide` is a small, optional future artifact, not a
dependency.

## Sources

- OWS repo (MIT): <https://github.com/open-wallet-standard/core> — policy sub-spec
  `docs/03-policy-engine.md`, `docs/04-agent-access-layer.md`, `docs/05-key-isolation.md`; Rust
  types `ows/crates/ows-core/src/policy.rs`.
- Reference crates on docs.rs: `ows-lib` 1.4.2, `ows-cli`.
- MoonPay, Open Wallet Standard launch: <https://www.moonpay.com/newsroom/open-wallet-standard>
- Overview (sub-spec list, MCP, key isolation): <https://blockeden.xyz/blog/2026/04/03/moonpay-open-wallet-standard-ai-agent-universal-wallet-infrastructure/>
