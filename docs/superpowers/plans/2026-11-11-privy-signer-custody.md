# Privy Signer (sign-not-export custody) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agent and the policy co-signer sign XRPL multisig transactions **and** decision/statement attestations with a key they never hold locally (custodied in Privy), by replacing the private-key-export signing seam with a sign-not-export `Signer` abstraction.

**Architecture:** Replace the `{ publicKey, privateKey }` `Signer` in `@eng/core` with `{ address, publicKey, source, signHex(messageHex): Promise<string> }` — "XRPL-sign this message for me" (ECDSA/EdDSA over `sha512Half(message)`, DER for secp256k1). Two implementations: `localSigner(wallet)` (today's keypair, wraps `ripple-keypairs.sign`) and `privySigner(...)` (Privy `raw_sign` + DER/low-S, proven in the spike). A shared `signerBlob(signer, tx)` builds a one-Signer multisigned blob; `signStatement` becomes async and uses `signHex`. Agent and co-signer take a `Signer` instead of a `Wallet`.

**Tech Stack:** TypeScript (ESM, `tsx`/`vitest`), `xrpl@5.3.0`, `ripple-binary-codec@2.11.0` (`encodeForMultisigning`, `encode`), `ripple-keypairs@3.x`, Node `fetch` (Privy REST). Node ≥ 22.12.

**Spec:** This plan's design was agreed in-conversation (2026-11-11) and is proven end-to-end by the spike `packages/cosigner/demo/privy-multisign-probe.ts` (archive repo): Privy `raw_sign` → DER + low-S → `tesSUCCESS` on Testnet, cross-checked offline with `ripple-keypairs.verify`. The spike is the reference for the crypto in Task 4.

## Global Constraints

- **Privy facts (verified):** `POST /v1/wallets {chain_type:"xrpl"}` → `{ id, address, public_key }`; `public_key` is **33-byte compressed secp256k1** (hex). `POST /v1/wallets/{id}/raw_sign {params:{hash:"0x<hex>"}}` → `{ data:{ signature } }` as **compact `r‖s` hex**. Auth: `Authorization: Basic base64(APP_ID:APP_SECRET)` + `privy-app-id`. `privy-authorization-signature` only if the app enforces it (Testnet app here does not).
- **Canonicalization:** XRPL requires fully-canonical (low-S). Normalize `s > n/2 → n − s`, `n = 0xFFFFFFFF…364141`. Privy already returns low-S; normalization is a safety net and must still be correct.
- **No key export:** nothing in the new path may read a `privateKey` off a Privy signer. `localSigner` is the only `Signer` that holds a key.
- **Env (gitignored .env):** `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, optional `PRIVY_AUTHORIZATION_SIGNATURE`. Co-signer selects custody via `COSIGNER_KEY_SOURCE` (`env`|`file`|`privy`); agent via `AGENT_KEY_SOURCE`.
- **Secp256k1 only for Privy:** Privy XRPL wallets are secp256k1; `privySigner` rejects a non-secp context. `localSigner` supports both (ed25519 default wallets unaffected).

## Review Focus

- **High-S signature** → `derFromCompact` must normalize to low-S and still verify (Task 1 test forces it).
- **DER integer padding** → an `r` or `s` whose top bit is set must get a `0x00` prefix (positive int), else the ledger rejects the signature (Task 1 test uses a high-bit vector).
- **Signer entry ordering** → `xrpl.multisign` sorts `Signers` by account; a hand-built blob that isn't combined through it could submit out of order → `tefBAD_SIGNATURE`. Always combine via `xrpl.multisign`/`combine` (Task 3 test asserts a 2-signer combine validates).
- **Async statement signing left unawaited** → a caller that forgets `await signStatement` now stores a `Promise` as a record (Task 2 updates every call-site; a lint/type check catches a bare Promise).
- **Privy `raw_sign` rejected (auth policy)** → surface Privy's status+body, don't submit a malformed Signer (Task 4 test asserts the error propagates with the response body).

---

### Task 1: New `Signer` interface, `localSigner`, and the DER/low-S helper

**Files:**
- Modify: `packages/core/src/statement.ts:47-52` (replace the `Signer` interface)
- Create: `packages/core/src/signer.ts` (the `Signer` type re-export, `localSigner`, `derFromCompact`, `signerHashOf`)
- Test: `packages/core/test/signer.test.ts`

**Interfaces:**
- Produces:
  - `interface Signer { readonly address: string; readonly publicKey: string; readonly source: string; signHex(messageHex: string): Promise<string> }`
  - `function localSigner(wallet: { address: string; publicKey: string; privateKey: string }, source?: string): Signer`
  - `function derFromCompact(rsHex: string): { der: string; normalized: boolean }` (low-S + DER, uppercase hex)
  - `function signerHashOf(messageHex: string): Buffer` (`sha512Half(bytes(messageHex))` — the 32 bytes a secp signer signs)

- [ ] **Step 1: Write failing tests** in `signer.test.ts`:
  - `localSigner(w).signHex(m)` resolves to `ripple-keypairs.sign(m, w.privateKey)` for a generated secp256k1 wallet (parity).
  - `derFromCompact` on a known low-S `r‖s` returns the expected DER and `normalized:false`.
  - `derFromCompact` on the high-S twin (`s' = n − s`) returns the **same** DER and `normalized:true`.
  - `derFromCompact` on an `r` with top bit set yields a DER whose `r` is `0x00`-prefixed (length byte accounts for it).
- [ ] **Step 2: Run** `npx vitest run packages/core/test/signer.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `packages/core/src/signer.ts`. `derFromCompact`/`signerHashOf` port verbatim from the spike (`privy-multisign-probe.ts`). `localSigner.signHex = async (m) => keypairs.sign(m, wallet.privateKey)`. Replace the `Signer` interface in `statement.ts` and `export type { Signer } from './signer.ts'` (keep one definition).
- [ ] **Step 4: Run** the test → PASS.
- [ ] **Step 5: Commit** `feat(core): sign-not-export Signer + DER/low-S helper`.

### Task 2: Make `signStatement` async; update every call-site

**Files:**
- Modify: `packages/core/src/statement.ts:79-90` (`signStatement` → async, uses `signHex`)
- Modify (callers, add `await` + wrap wallets with `localSigner`): `cosigner/src/service.ts:152`, `web/src/orchestrator.ts:156`, `cosigner/demo/{b1-testnet,x402/b1-x402-testnet,mpp/b1-mpp-testnet}.ts`, `agent-mcp/demo/b1-mcp-testnet.ts`, and tests `policy/test/{policy.test.ts:53,fixtures.ts:69}`, `provisioning/test/provisioning.test.ts:63`, `core/test/core.test.ts:51`
- Test: `packages/core/test/core.test.ts` (existing sign/verify, now async)

**Interfaces:**
- Consumes: `Signer`, `localSigner` (Task 1).
- Produces: `async function signStatement(body: StatementBody, signer: Signer): Promise<Statement>` (same `proof`/`id` shape; `proof.signature = await signer.signHex(statementDigest(body).hex)`, `proof.alg` from `signer.publicKey`).

- [ ] **Step 1: Update** `core.test.ts:51` to `await signStatement(body(w), localSigner(w))`; keep the `verifyStatement` assertion. Run → FAIL (returns a Promise).
- [ ] **Step 2: Implement** the async `signStatement` (await `signer.signHex`); `verifyStatement` is unchanged.
- [ ] **Step 3:** Update the remaining 9 call-sites: `await`, and wrap any `xrpl.Wallet`/`{privateKey}` argument in `localSigner(...)`.
- [ ] **Step 4: Run** `npm test` → the statement, policy, provisioning, and core suites PASS.
- [ ] **Step 5: Commit** `refactor(core)!: signStatement is async (sign-not-export)`.

### Task 3: Shared multisig assembly `signerBlob(signer, tx)`

**Files:**
- Create: `packages/core/src/signer.ts` (add `signerBlob`) — or co-locate in Task 1's file
- Modify: `agent-mcp/src/agent.ts:139`, `cosigner/src/service.ts:158` (use `signerBlob`)
- Test: `packages/core/test/signer.test.ts`

**Interfaces:**
- Produces: `async function signerBlob(signer: Signer, tx: Record<string, unknown>): Promise<string>` — returns `encode({ ...tx, SigningPubKey: '', Signers: [{ Signer: { Account: signer.address, SigningPubKey: signer.publicKey, TxnSignature: await signer.signHex(encodeForMultisigning(txNoSigs, signer.address)) } }] })`.

- [ ] **Step 1: Write failing test:** for a local secp256k1 signer and a sample Payment, `xrpl.multisign([await signerBlob(sA, tx), await signerBlob(sB, tx)])` decodes to a tx whose two `Signers` each `ripple-keypairs.verify` against their `encodeForMultisigning`. (Mirrors the spike's offline check, no network.)
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `signerBlob` (strip any `Signers`/`TxnSignature` before `encodeForMultisigning`).
- [ ] **Step 4: Run** → PASS; then swap `agent.ts:139` and `service.ts:158` to `await signerBlob(this.cfg.signer, tx)` / `await signerBlob(this.o.signer, tx)` (wiring completes in Tasks 5–6).
- [ ] **Step 5: Commit** `feat(core): signerBlob multisig assembly`.

### Task 4: `privySigner` (Privy raw-sign implementation)

**Files:**
- Create: `packages/cosigner/src/privy-signer.ts`
- Test: `packages/cosigner/test/privy-signer.test.ts` (mocked `fetch`)

**Interfaces:**
- Consumes: `Signer`, `derFromCompact`, `signerHashOf` (Task 1).
- Produces:
  - `function privySigner(o: { appId: string; appSecret: string; walletId: string; address: string; publicKey: string; authorizationSignature?: string; fetchImpl?: typeof fetch }): Signer` (`source:'privy'`; `signHex(m)` → `raw_sign(signerHashOf(m))` → `derFromCompact`).
  - `async function createPrivyXrplWallet(o: { appId; appSecret; fetchImpl? }): Promise<{ id: string; address: string; publicKey: string }>`
  - `function privySignerFromEnv(env?): Signer | undefined` (reads `PRIVY_*`; needs a wallet id — provisioned or `PRIVY_WALLET_ID`).

- [ ] **Step 1: Write failing tests** with a mocked `fetch`:
  - `raw_sign` returns a fixed `r‖s`; `signHex(m)` returns a DER that `ripple-keypairs.verify(m, der, publicKey)` accepts (use a real local keypair to produce the fixture `r‖s`, so verification is meaningful).
  - forced high-S fixture → `signHex` still verifies (normalization path).
  - `raw_sign` 4xx → `signHex` rejects with an error containing the status + body.
- [ ] **Step 2: Run** `npx vitest run packages/cosigner/test/privy-signer.test.ts` → FAIL.
- [ ] **Step 3: Implement** `privy-signer.ts` (port the Privy REST + DER from the spike; inject `fetchImpl` for tests).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(cosigner): privySigner (Privy raw-sign custody)`.

### Task 5: Migrate the agent to `Signer`

**Files:**
- Modify: `agent-mcp/src/agent.ts:59-64` (`AgentConfig.wallet: Wallet` → `signer: Signer`), `:139` (done in Task 3), `agent-mcp/src/server.ts:137-144` (build `localSigner`/`privySigner` from env)
- Test: `packages/agent-mcp/test/agent.test.ts`

**Interfaces:**
- Consumes: `Signer`, `localSigner`, `signerBlob` (Tasks 1–3), `privySignerFromEnv` (Task 4).
- Produces: `AgentConfig.signer: Signer`; `server.ts` picks `AGENT_KEY_SOURCE=privy` → `privySignerFromEnv()` else `localSigner(Wallet.fromSeed(cfg.seed))`.

- [ ] **Step 1: Update** `agent.test.ts` to construct `EngagementAgent` with `signer: localSigner(wallet)`; assert `proposePayment` yields a `combined` blob whose Signers verify (reuse Task 3's check). Run → FAIL (config shape).
- [ ] **Step 2: Implement** the `AgentConfig` change and `server.ts` wiring.
- [ ] **Step 3: Run** `npx vitest run packages/agent-mcp` → PASS.
- [ ] **Step 4: Commit** `refactor(agent-mcp)!: agent signs through a Signer (Privy-capable)`.

### Task 6: Migrate the co-signer to a `Signer` provider

**Files:**
- Modify: `cosigner/src/service.ts:62-64` (`CosignerOptions.wallet` → `signer: Signer`), `:86` (`address` from `signer.address`), `:152`/`:158` (await; done in Tasks 2–3), `cosigner/src/keys.ts` (`KeyProvider.getWallet` → `SignerProvider.getSigner(): Promise<Signer>`; add `COSIGNER_KEY_SOURCE=privy` branch → `privySignerFromEnv`), `cosigner/src/server.ts:175-179`, and the demos that `new CosignerService({ wallet })`
- Test: `packages/cosigner/test/service.test.ts`, `server.test.ts`

**Interfaces:**
- Consumes: `Signer`, `localSigner`, `signerBlob`, async `signStatement`, `privySignerFromEnv`.
- Produces: `CosignerOptions.signer: Signer`; `interface SignerProvider { readonly source: string; getSigner(): Promise<Signer> }`; `signerProviderFromEnv(env?): SignerProvider` (env/file → `localSigner`; `privy` → `privySigner`).

- [ ] **Step 1: Update** `service.test.ts` to build `CosignerService({ signer: localSigner(cosignerWallet), ... })`; assert a SIGN decision returns a `signerBlob` **and** an attestation `record` whose `verifyStatement` passes (both now async). Run → FAIL.
- [ ] **Step 2: Implement** the `CosignerOptions`/`keys.ts`/`server.ts` changes and the `privy` branch; update the demos.
- [ ] **Step 3: Run** `npm test` (full suite) → PASS.
- [ ] **Step 4: Commit** `refactor(cosigner)!: co-signer signs through a Signer provider (Privy-capable)`.

### Task 7: Opt-in live Testnet integration (agent + Privy co-signer)

**Files:**
- Create: `packages/cosigner/demo/privy-engagement-testnet.ts` (opt-in; skips unless `PRIVY_APP_ID` set)
- Modify: root `package.json` scripts (`"demo:privy"`)

**Interfaces:**
- Consumes: everything above; the spike's account/SignerList setup.

- [ ] **Step 1:** Provision a Privy wallet as the **co-signer**; open an engagement account with SignerList `{agent(local) w1, co-signer(privy) w1}` q2; run the agent's `proposePayment` for an in-policy spend; co-signer SIGNs (attestation via Privy `signHex`, multisig via Privy `signerBlob`); combine; submit.
- [ ] **Step 2: Run** `npm run demo:privy` on Testnet → `tesSUCCESS`; the decision record `verifyStatement` passes. (Manual/opt-in; not in CI.)
- [ ] **Step 3: Commit** `test(cosigner): opt-in live Privy co-signer engagement on Testnet`.

---

## Notes / out of scope
- **Provisioning PoP signing:** ✅ done (feat/privy-hardening-pop) — `makeEnrolmentWithSigner(session, role, signer)` lets a Privy-custodied key enrol by proof-of-possession.
- **Production auth:** ✅ authorization keys done (feat/privy-hardening-pop) — `PRIVY_AUTHORIZATION_KEY` (owner P-256 key) generates a `privy-authorization-signature` per `raw_sign`.
- **Privy wallet policies: deliberately not adopted.** We `raw_sign` a locally computed sha512Half digest, so Privy sees only a 32-byte hash and its policy engine can't inspect XRPL transaction fields — it could only allow/deny `raw_sign` wholesale, not restate the `policyCoSigner` rules. `policyCoSigner` stays the single policy layer. Co-signer-host compromise is bounded instead by the on-ledger SignerList quorum (co-signer weight alone < quorum), non-exportable keys, and holding the authorization key apart from the app secret (KMS / separate process; optionally a Privy key quorum). Remaining hardening = authorization-key placement, not policies.
