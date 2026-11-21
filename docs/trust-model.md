# Trust model

This page says what the XRP Ledger enforces and what the policy co-signer enforces, for the templates in this repository. The split is ledger-enforced quorum plus policy co-signer. The runs this repository ships are on Testnet.

Hotel (`hotel@1`, `hotel@2`) is Research. See [product status](SCOPE.md#product-status) and the [roadmap](../ROADMAP.md#research). Citations look like `symbol` (`path:line`). The line is for a reader looking at the file.

## What the ledger enforces

Once an open Batch is validated, the ledger checks the SignerList. `buildOpenBatch` puts `SignerListSet` (`SignerQuorum`, `SignerEntries`) and a `SetRegularKey` with no key in an all-or-nothing Batch (`buildOpenBatch` (`packages/ledger/src/xrpl-io.ts:54`), `SignerQuorum` (`packages/ledger/src/xrpl-io.ts:60`)).

Before that open, pre-create disables the master key. `buildDisableMasterPlain` is an `AccountSet` with `ASF_DISABLE_MASTER`, and it is master-signed last, after the trust line and the service `RegularKey` (`buildDisableMasterPlain` (`packages/cosigner/src/precreate.ts:27`), `ASF_DISABLE_MASTER` (`packages/cosigner/src/precreate.ts:28`)). `HotelFlow.precreate` does the same steps (`precreate` (`packages/cosigner/src/hotel/flow.ts:183`)). After the open Batch clears `RegularKey`, the SignerList is what can authorize the account.

`AccountDelete` has a ledger age rule. The hotel flow waits until sequence plus `ACCOUNT_DELETE_MIN_AGE` (256) is within the validated index (`ACCOUNT_DELETE_MIN_AGE` (`packages/cosigner/src/hotel/flow.ts:107`)).

The ledger stores Credential objects. It does not read spend caps, mandates, or the meaning of `ENG/ARBITER`. A set of SignerList weights that adds up to the quorum can submit a transaction the account is allowed to submit. Transaction-type limits, destination limits, and credential meaning are co-signer checks, and only on outcomes the co-signer actually signs.

## Shipped weights

`minimalWinningSets` enumerates the minimal role sets whose weights reach the quorum (`minimalWinningSets` (`packages/core/src/template.ts:127`)). The validator rejects a service-operated weight that reaches quorum on its own (`serviceWeight` (`packages/core/src/template.ts:167`)).

| Template | Weights | Quorum | Minimal winning sets |
|---|---|---|---|
| `settlement-vault/hotel@2` | principal 3, counterparty 3, arbiter 4, co-signer 2 | 7 | `{counterparty, arbiter}`, `{principal, arbiter}`, `{principal, counterparty, cosigner}` |
| `settlement-vault/hotel@1` | principal 2, counterparty 2, arbiter 3, co-signer 1 | 5 | the same three shapes |
| `owner-wallet/procurement@1` | owner 2, agent 1, co-signer 1 | 2 | `{owner}`, `{agent, cosigner}` |
| `owner-wallet/shopping@1` | owner 2, agent 1, co-signer 1 | 2 | `{owner}`, `{agent, cosigner}` |

Sources: `weight` (`templates/hotel@2.json:6`), `quorum` (`templates/hotel@2.json:11`), `weight` (`templates/hotel@1.json:6`), `quorum` (`templates/hotel@1.json:11`), `weight` (`templates/procurement@1.json:7`), `quorum` (`templates/procurement@1.json:11`), `weight` (`templates/shopping@1.json:7`), `quorum` (`templates/shopping@1.json:11`). The hotel@2 sets are the ones the template test expects (`minimalWinningSets` (`packages/core/test/core.test.ts:84`)). Arbiter plus co-signer is not one of those sets (`minimalWinningSets` (`packages/core/test/core.test.ts:86`)).

## hotel@2: arbiter and counterparty reach quorum

On `hotel@2`, counterparty weight is 3 (`weight` (`templates/hotel@2.json:7`)) and arbiter weight is 4 (`weight` (`templates/hotel@2.json:8`)). 3 + 4 = 7, and the quorum is 7 (`quorum` (`templates/hotel@2.json:11`)). Arbiter and counterparty (for example the hotel) together meet the ledger quorum. The guest's signature is not required. The co-signer's signature is not required.

`settle.ruling` is signed by arbiter plus principal, or by arbiter plus counterparty. Its `enforcement` is `"none"` (`enforcement` (`templates/hotel@2.json:16`)). `signsStage` does not sign an outcome whose enforcement is `none` (`signsStage` (`packages/cosigner/src/service.ts:949`)). `settle.ruling` is not co-signed. Arbiter plus one party is the intended ruling path, so the real risk is an arbiter who isn't neutral, not the weights themselves.

The template check records a V10 disclosure for every escrow winning set that excludes the principal: `{counterparty, arbiter}` can move funds without the principal (`V10` (`packages/core/src/template.ts:248`)).

`hotel@1` is the same shape with smaller numbers: counterparty 2 plus arbiter 3 equals quorum 5 (`weight` (`templates/hotel@1.json:7`), `weight` (`templates/hotel@1.json:8`), `quorum` (`templates/hotel@1.json:11`)), and `settle.ruling` is also `enforcement` `"none"` (`enforcement` (`templates/hotel@1.json:15`)).

A longer neutrality design (several outside accreditors, a trust-list file) is not in this tree. See [Re-check arbiter neutrality at decide time](../ROADMAP.md#re-check-arbiter-neutrality-at-decide-time) and [Revocation leaves the SignerList unchanged](../ROADMAP.md#revocation-leaves-the-signerlist-unchanged), which would limit a captured arbiter, and [Accreditor address is not the service account](../ROADMAP.md#accreditor-address-is-not-the-service-account).

## What the policy co-signer enforces

`signsStage` signs a stage only when a template outcome maps to it, a signer set includes the co-signer, and enforcement is not `advisory` or `none` (`signsStage` (`packages/cosigner/src/service.ts:949`)). Other stages can still get a decision record. They do not get a signature.

On the owner wallets, owner weight 2 equals quorum 2 (`quorum` (`templates/procurement@1.json:11`)). `owner.close` is `enforcement` `advisory` (`enforcement` (`templates/procurement@1.json:14`), `enforcement` (`templates/shopping@1.json:14`)). The owner can sweep and delete the account without the co-signer. Caps below apply to agent spends, which need the co-signer to reach quorum (`enforcement` (`templates/procurement@1.json:13`)).

Procurement spend rules, evaluated when the co-signer signs: the mandate must be unexpired (`dailyCap` is the mandate field the daily rule reads), every payee must be on `mandate.vendors` and hold `KYB_VERIFIED` from `params.kybIssuers`, the last 24 hours stay within `dailyCap`, and the last 2160 hours stay within `budget` (`kybIssuers` (`policies/procurement@1.3.0.json:30`), `dailyCap` (`policies/procurement@1.3.0.json:61`)). A payment over `approvalThreshold` needs an `approval.payment/1` statement (`approvalThreshold` (`policies/procurement@1.3.0.json:28`)). Shopping uses a 168-hour `weeklyCap` and the same 2160-hour budget (`weeklyCap` (`policies/shopping@1.0.0.json:24`)).

Baseline rules on signed stages include: no new `RegularKey` (`setsRegularKey` (`policies/baseline@1.1.0.json:129`)), a fee cap of `feeCapDrops` 20000 (`feeCapDrops` (`policies/baseline@1.1.0.json:10`)), and `maxLedgerWindow` 30 for a live transaction (`maxLedgerWindow` (`policies/baseline@1.1.0.json:11`)). `setsRegularKey` is true when an inner transaction is `SetRegularKey` with a key set (`setsRegularKey` (`packages/policy/src/facts.ts:128`)). Those rules bind when the co-signer signs. They do not bind `settle.ruling`.

KYB is re-read on each spend. `hasCredential` requires an accepted credential from a listed issuer that is not expired at the snapshot close time (`hasCredential` (`packages/policy/src/facts.ts:323`)).

Hotel defaults the co-signer does sign are the pre-signed outcomes with `enforcement` `final-signature` (`enforcement` (`templates/hotel@2.json:17`)). Template timers, in seconds from their anchor: confirm 7200, check-in window 32400, entry dispute 75600, claim 86400, dispute window 259200, ruling 432000 (`durationSecs` (`templates/hotel@2.json:26`), `durationSecs` (`templates/hotel@2.json:31`)). The policy's `rulingWindow` is 432000s, with `minRulingWindow` 259200s and `maxRulingWindow` 604800s (`rulingWindow` (`policies/hotel@2.0.0.json:30`), `minRulingWindow` (`policies/hotel@2.0.0.json:31`), `maxRulingWindow` (`policies/hotel@2.0.0.json:32`)). A statement received more than `MAX_ISSUE_LAG_SECS` (300) after `issuedAt` is rejected (`MAX_ISSUE_LAG_SECS` (`packages/cosigner/src/service.ts:156`)). The tick scheduler runs only when `COSIGNER_TICK_MS` is set above 0 (`COSIGNER_TICK_MS` (`packages/cosigner/src/server.ts:276`), `COSIGNER_TICK_MS` (`.env.example:55`)).

## Trust slots

Policies name deploy-time accounts as `$slot:` tokens. `layerHash` covers that token. The address is not written into the policy (`layerHash` (`packages/policy/src/decide.ts:12`)). `KNOWN_SLOTS` is the closed set `arbiter.accreditor`, `kyb.issuer`, `rlusd.issuer`. One accreditor per deployment (`KNOWN_SLOTS` (`packages/policy/src/trust.ts:11`)).

`loadTrustConfig` reads three environment variables: `ENG_ARBITER_ACCREDITOR`, `ENG_KYB_ISSUER`, and `ENG_RLUSD_ISSUER` (`loadTrustConfig` (`packages/cosigner/src/server.ts:189`), `ENG_ARBITER_ACCREDITOR` (`packages/cosigner/src/server.ts:183`), `ENG_KYB_ISSUER` (`packages/cosigner/src/server.ts:184`), `ENG_RLUSD_ISSUER` (`packages/cosigner/src/server.ts:185`)). The same names are in `.env.example` (`ENG_RLUSD_ISSUER` (`.env.example:10`), `ENG_ARBITER_ACCREDITOR` (`.env.example:49`), `ENG_KYB_ISSUER` (`.env.example:50`)).

`record.trust` is slot name to classic address. It is part of `inputsHash` and not part of the policy layer hash (`inputsHash` (`packages/policy/src/types.ts:70`)). `withCanonicalTrust` sorts the keys and keeps exactly the slots the layers name, before `inputsHash` is taken (`withCanonicalTrust` (`packages/policy/src/decide.ts:33`), `inputsHash` (`packages/policy/src/decide.ts:118`)). `canonicalTrust` rejects an unknown name (`UNKNOWN_SLOT` or `TRUST_KEY`), an empty, token, or placeholder value (`UNRESOLVED_SLOT`), and a value that is not a checksummed classic address (`BAD_ADDRESS`) (`canonicalTrust` (`packages/policy/src/trust.ts:120`)).

Hotel records set `arbiter.accreditor` and `rlusd.issuer` only (`recordFor` (`packages/cosigner/src/hotel/flow.ts:295`)). Procurement names `rlusd.issuer` and `kyb.issuer` (`kybIssuers` (`policies/procurement@1.3.0.json:30`)). Shopping names `rlusd.issuer` (`issuer` (`policies/shopping@1.0.0.json:9`)). Provisioning copies a caller-supplied `trust` onto the record. It does not read the environment (`plan` (`packages/provisioning/src/protocol.ts:162`)).

Off loopback, `assertDeployTrust` refuses to bind until every slot in the loaded policies is a classic address (`assertDeployTrust` (`packages/cosigner/src/server.ts:203`)). Loopback may start with an empty map. A slotted policy then fails later with `UNRESOLVED_SLOT`. A value that is set must still be a classic address. When deploy config is non-empty, `requireConfiguredTrust` throws `TRUST_MISMATCH` if the record's address differs (`requireConfiguredTrust` (`packages/cosigner/src/service.ts:344`), `TRUST_MISMATCH` (`packages/cosigner/src/service.ts:353`)). After registration, `noteTrustDrift` warns and leaves the stored addresses in place (`noteTrustDrift` (`packages/cosigner/src/service.ts:361`)).

`ENG_RLUSD_ISSUER` is also the pool trust-line issuer. Unset, the pool CLI uses Testnet RLUSD `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` (`TESTNET_RLUSD_ISSUER` (`packages/cosigner/src/pool-cli.ts:34`)). The hotel Testnet script issues its own test IOU. It does not spend that default issuer. See [The RLUSD issuer name is used twice](../ROADMAP.md#the-rlusd-issuer-name-is-used-twice).

## Who accredits arbiters

The accreditor is the classic address in `ENG_ARBITER_ACCREDITOR`. The co-signer does not check that this address is the service account. The chargeback design assumes the service is that issuer. The code accepts any classic address. See [Accreditor address is not the service account](../ROADMAP.md#accreditor-address-is-not-the-service-account).

Hotel policies put that one slot in `arbiterIssuers`, with `arbiterCredentialType` `ENG/ARBITER` (`arbiterCredentialType` (`policies/hotel@2.0.0.json:33`), `arbiterIssuers` (`policies/hotel@2.0.0.json:35`)). The demo accreditor submits `CredentialCreate`, and the arbiter submits `CredentialAccept` (`CredentialCreate` (`packages/cosigner/src/hotel/flow.ts:222`), `CredentialAccept` (`packages/cosigner/src/hotel/flow.ts:226`)). The co-signer does not issue the credential.

`registerLocked` runs `neutralityFindings` for roles whose template says `accreditation` `"service"` (`neutralityFindings` (`packages/cosigner/src/service.ts:1093`), `accreditation` (`templates/hotel@2.json:8`)). The arbiter account must hold an accepted, unexpired credential of that type from a resolved issuer (`hasCredential` (`packages/policy/src/facts.ts:323`)). It must not be another party (`ARBITER_IS_PARTY` (`packages/cosigner/src/service.ts:1104`)). If the mandate lists `allowedArbiters`, the account must be in that list (`allowedArbiters` (`packages/cosigner/src/service.ts:1105`)). Otherwise `register` throws `NOT_NEUTRAL` and stores nothing (`NOT_NEUTRAL` (`packages/cosigner/src/service.ts:332`)).

`HotelFlow.open` calls `register` before it submits the open Batch. An unaccredited arbiter gets no SignerList and no room payment (`NOT_NEUTRAL` (`packages/cosigner/src/hotel/flow.ts:244`)).

This check runs at register. `decide` does not run it again. See [Re-check arbiter neutrality at decide time](../ROADMAP.md#re-check-arbiter-neutrality-at-decide-time).

## Revocation

This repository does not submit `CredentialDelete`. `XrplLedgerSource` copies credential objects the ledger returns for the subjects it was asked about (`XrplLedgerSource` (`packages/cosigner/src/snapshot.ts:42`), `LSF_ACCEPTED` (`packages/cosigner/src/snapshot.ts:154`)). `hasCredential` drops a credential that is missing, not accepted, from a different issuer, or expired at the snapshot close time (`expired` (`packages/policy/src/facts.ts:328`)).

That matters in two places the co-signer already reads credentials. A new `register` fails `NOT_NEUTRAL` when the arbiter credential is missing or expired. A later procurement spend fails the KYB rule when the vendor credential is missing or expired (`hasCredential` (`packages/policy/src/facts.ts:323`)).

It does not take an arbiter off a SignerList that is already installed. Arbiter weight stays. Arbiter plus counterparty still meet quorum on `hotel@2`, and `settle.ruling` is still not co-signed. The not-yet-consumed rule in the attestation draft is not what this code does. See [Revocation leaves the SignerList unchanged](../ROADMAP.md#revocation-leaves-the-signerlist-unchanged) and the note at the top of [docs/spec/attestations.md](spec/attestations.md).

## Arbiter neutrality: limits

Arbiter neutrality is checked only at registration. `registerLocked` runs `neutralityFindings` and throws `NOT_NEUTRAL` before it stores the engagement (`registerLocked` (`packages/cosigner/src/service.ts:274`), `neutralityFindings` (`packages/cosigner/src/service.ts:311`), `NOT_NEUTRAL` (`packages/cosigner/src/service.ts:312`)). `decide` does not run `neutralityFindings` (`decide` (`packages/cosigner/src/service.ts:371`)).

An arbiter revoked later stays on the signer list. `buildOpenBatch` installs that list once (`SignerListSet` (`packages/ledger/src/xrpl-io.ts:60`)). Nothing after open removes the arbiter entry, and this repository does not submit `CredentialDelete`. Arbiter plus one party can still sign: on `hotel@2`, the arbiter's weight is 4 and each party's weight is 3, and 4 + 3 meets quorum 7 (`weight` (`templates/hotel@2.json:9`), `weight` (`templates/hotel@2.json:7`), `quorum` (`templates/hotel@2.json:12`)), and `settle.ruling` is not co-signed (`signsStage` (`packages/cosigner/src/service.ts:929`)).

## Not in this tree

`signerProviderFromEnv` throws when `COSIGNER_KEY_SOURCE` is `kms`. No KMS or HSM provider is bundled (`signerProviderFromEnv` (`packages/cosigner/src/keys.ts:30`), `COSIGNER_KEY_SOURCE` (`packages/cosigner/src/keys.ts:31`)). Pool seeds are `LocalFileSeedStore`. `KmsSeedStore` is a comment on the interface, not a class in this tree (`LocalFileSeedStore` (`packages/cosigner/src/pool-local.ts:17`), `KmsSeedStore` (`packages/cosigner/src/pool.ts:64`)).

The co-signer HTTP server can bind off loopback with one shared bearer token (`COSIGNER_API_TOKEN` (`packages/cosigner/src/server.ts:227`)). A hosted multi-tenant co-signer is not what the demos run. The MPP demo constructs `CosignerService` in the same process (`CosignerService` (`docs/demo/mpp-purchase.md:46`)). Per-user accounts on that API are out of scope ([scope](SCOPE.md)). There is no arbiter-service package ([scope](SCOPE.md)). There is no trust-list file. `record.trust` is the slot map above, not a list id plus a hash.
