# For platforms

This page is for a platform deciding whether to run this protocol. It states what this repository contains. Citations look like `symbol` (`path:line`). The line is for a reader looking at the file. The websocket list has no mainnet endpoint (`Testnet` (`packages/ledger/src/testnet-endpoint.ts:8`), `TESTNET_ENDPOINTS` (`packages/ledger/src/testnet-endpoint.ts:12`)).

## What is not built

There is no hosted co-signer. `cosigner:local` refuses a bind that is not loopback (`isLoopback` (`packages/cosigner/src/local.ts:226`)). The HTTP server can listen off loopback only with one shared bearer (`COSIGNER_API_TOKEN` (`packages/cosigner/src/server.ts:241`)). Per-user accounts on that API are out of scope (`RBAC` (`docs/SCOPE.md:72`)). The MPP demo constructs the co-signer in the same process (`CosignerService` (`docs/demo/mpp-purchase.md:46`)).

There is no mainnet deployment in this repository. `cosigner:local` accepts only a known Testnet websocket (`assertKnownTestnetEndpoint` (`packages/ledger/src/testnet-endpoint.ts:128`)) and, when `ENG_NETWORK` is set, only `xrpl:1` (`ENG_NETWORK` (`packages/cosigner/src/local.ts:230`)). A set `XRPL_URL` is returned unchanged by `resolveTestnetEndpoint` (`XRPL_URL` (`packages/ledger/src/testnet-endpoint.ts:41`)). `cosigner:local` checks the host before using that return (`assertKnownTestnetEndpoint` (`packages/cosigner/src/local.ts:181`)). The `npm run cosigner` entrypoint opens `XRPL_URL` or the altnet Testnet URL (`XRPL_URL` (`packages/cosigner/src/server.ts:270`)). Hotel booking is Research, designed and tested on Testnet (`Research` (`docs/SCOPE.md:7`)).

The indexer is planned (`Indexer` (`docs/SCOPE.md:62`)). The arbiter service is planned (`Arbiter` (`docs/SCOPE.md:61`)). The `engagement` x402 scheme is planned (`engagement` (`docs/SCOPE.md:63`)). The facilitator store and the open-stage rules are planned (`Facilitator` (`docs/SCOPE.md:60`)). Sponsored accounts, on-ledger cosign, and Smart Escrows are Research (`Research` (`docs/SCOPE.md:64`)).

`settle.ruling` is not enforced by the co-signer. Its `enforcement` is `none` (`enforcement` (`templates/hotel@2.json:16`)). `signsStage` does not sign an outcome whose enforcement is `none` (`signsStage` (`packages/cosigner/src/service.ts:929`), `enforcement` (`packages/cosigner/src/service.ts:932`)).

A stay of 15 nights or more is not refused at registration. `registerLocked` rejects the terms only when `stayTermsFindings` returns a problem (`stayTermsFindings` (`packages/cosigner/src/service.ts:303`)). The 14-night cap and the Ticket figures are in [Per-deal costs](costs.md) (`stayTermsFindings` (`docs/costs.md:17`)).

`signerProviderFromEnv` throws when `COSIGNER_KEY_SOURCE` is `kms`. No KMS or HSM provider is bundled (`COSIGNER_KEY_SOURCE` (`packages/cosigner/src/keys.ts:31`)). `KmsSeedStore` is a comment, not a class (`KmsSeedStore` (`packages/cosigner/src/pool.ts:64`)).

`neutralityFindings` runs from `registerLocked` (`neutralityFindings` (`packages/cosigner/src/service.ts:311`)). `decide` is a separate entry point (`decide` (`packages/cosigner/src/service.ts:371`)). The trust model records that `decide` does not run the check again (`decide` (`docs/trust-model.md:92`)).

This repository does not submit `CredentialDelete` (`CredentialDelete` (`docs/spec/attestations.md:3`)). What that leaves on an open deal is the revocation section below.

## What a facilitator runs

The opt-in facilitator path is t54's `exact` scheme (`scheme` (`packages/cosigner/demo/x402/facilitator.ts:36`)). The agent obtains a co-signature with `proposePayment` (`proposePayment` (`packages/agent-mcp/src/agent.ts:137`)). The merchant submits the signed blob through `settlePresigned` and does not broadcast it itself (`settlePresigned` (`packages/cosigner/demo/x402/merchant.ts:153`)). The Testnet script calls those two (`proposePayment` (`packages/cosigner/demo/x402/b1-x402-t54-testnet.ts:188`), `settlePresigned` (`packages/cosigner/demo/x402/b1-x402-t54-testnet.ts:206`)).

Prepaid stays the facilitator-free option. On a merchant with no `exact` config, `challenge` and `handle` do not call a facilitator (`handle` (`packages/cosigner/demo/x402/merchant.ts:58`)). The challenge scheme is `prepaid` (`prepaid` (`packages/cosigner/demo/x402/merchant.ts:127`)). The agent broadcasts that payment itself (`submit` (`packages/agent-mcp/src/agent.ts:148`)). The merchant then checks the validated transaction (`verifySettlement` (`packages/cosigner/demo/x402/merchant.ts:192`)).

## The x402 sequence

`proposePayment` adds the agent's signature and asks the co-signer to `decide` (`decide` (`packages/agent-mcp/src/agent.ts:140`)). A SIGN verdict is merged into one blob (`combine` (`packages/agent-mcp/src/agent.ts:143`)). `settlePresigned` posts that blob to the facilitator `/verify` (`verify` (`packages/cosigner/demo/x402/merchant.ts:165`)). It posts to `/settle` only when `isValid` is true (`isValid` (`packages/cosigner/demo/x402/merchant.ts:166`), `settle` (`packages/cosigner/demo/x402/merchant.ts:169`)). The client sends those two paths (`verify` (`packages/cosigner/demo/x402/facilitator.ts:78`), `settle` (`packages/cosigner/demo/x402/facilitator.ts:79`)).

t54 here is the Testnet facilitator. The default URL is `https://xrpl-facilitator-testnet.t54.ai` (`DEFAULT_FACILITATOR_URL` (`packages/cosigner/demo/x402/facilitator.ts:5`)). The requirement `network` is `xrpl:1` (`network` (`packages/cosigner/demo/x402/facilitator.ts:37`)). That facilitator reports `environment` `rewards-testnet` and `nonProduction` true on the settle attestation (`nonProduction` (`docs/research/x402-multisig.md:123`)).

## Merchant changes

The payment sets `SendMax` to the same currency, issuer, and value as `Amount` (`Amount` (`packages/cosigner/demo/x402/t54-payment.ts:38`), `SendMax` (`packages/cosigner/demo/x402/t54-payment.ts:39`)). `Memos` has three entries (`Memos` (`packages/cosigner/demo/x402/t54-payment.ts:47`)). The first is t54's untyped memo, whose only field is `MemoData` (`MemoData` (`packages/cosigner/demo/x402/t54-payment.ts:48`)). The second is a typed `eng/basis` memo (`typedMemo` (`packages/cosigner/demo/x402/t54-payment.ts:49`)). The third is a typed `eng/invoice` memo (`typedMemo` (`packages/cosigner/demo/x402/t54-payment.ts:50`)).

The co-signer reads `MemoType` and stores the memo only when that type decodes to a non-empty string (`MemoType` (`packages/policy/src/facts.ts:83`), `MemoData` (`packages/policy/src/facts.ts:84`)). The untyped memo has no `MemoType`, so it does not satisfy those rules. Baseline B8 requires an `eng/basis` memo (`basis` (`policies/baseline@1.1.0.json:177`)). Procurement W6 requires `eng/invoice` to equal the vendor invoice (`invoice` (`policies/procurement@1.3.0.json:80`)).

## What the arbiter runs

The arbiter in the hotel demo is a key. The script funds an account, and that account signs (`arbiter` (`packages/cosigner/demo/hotel-testnet.ts:99`)). No arbiter-service package is shipped; the component is planned (`Arbiter` (`docs/SCOPE.md:61`)).

`ruling` closes with the arbiter and one party (`ruling` (`packages/cosigner/src/hotel/flow.ts:433`)). It multisigns those two keys (`multisignBlob` (`packages/cosigner/src/hotel/flow.ts:439`)) and submits that blob (`submit` (`packages/cosigner/src/hotel/flow.ts:441`)). `settle.ruling` has `enforcement` `none` (`enforcement` (`templates/hotel@2.json:16`)). `signsStage` skips an outcome whose `enforcement` is `none` (`signsStage` (`packages/cosigner/src/service.ts:929`), `enforcement` (`packages/cosigner/src/service.ts:932`)).

## Who holds which keys

`owner-wallet/procurement@1` gives the owner weight 2, operated outside the service (`weight` (`templates/procurement@1.json:7`), `operatedBy` (`templates/procurement@1.json:7`)). The agent has weight 1, also external (`weight` (`templates/procurement@1.json:8`), `operatedBy` (`templates/procurement@1.json:8`)). The co-signer has weight 1, operated by the service (`weight` (`templates/procurement@1.json:9`), `operatedBy` (`templates/procurement@1.json:9`)). The quorum is 2 (`quorum` (`templates/procurement@1.json:11`)).

`owner-wallet/shopping@1` uses the same weights and the same operators: owner 2, agent 1, co-signer 1, quorum 2 (`weight` (`templates/shopping@1.json:7`), `weight` (`templates/shopping@1.json:8`), `weight` (`templates/shopping@1.json:9`), `operatedBy` (`templates/shopping@1.json:9`), `quorum` (`templates/shopping@1.json:11`)).

The owner's weight is 2 and the quorum is 2 (`weight` (`templates/procurement@1.json:7`), `quorum` (`templates/procurement@1.json:11`)). The agent's weight is 1 (`weight` (`templates/procurement@1.json:8`)). The agent weight and the co-signer weight are 1 and 1 (`weight` (`templates/procurement@1.json:9`)). The service operates the co-signer slot (`operatedBy` (`templates/procurement@1.json:9`), `operatedBy` (`templates/shopping@1.json:9`)). The owner slot and the agent slot are external (`operatedBy` (`templates/procurement@1.json:7`), `operatedBy` (`templates/procurement@1.json:8`), `operatedBy` (`templates/shopping@1.json:7`), `operatedBy` (`templates/shopping@1.json:8`)).

`settlement-vault/hotel@2` gives the principal weight 3, external (`weight` (`templates/hotel@2.json:7`), `operatedBy` (`templates/hotel@2.json:7`)). The counterparty has weight 3, external (`weight` (`templates/hotel@2.json:8`), `operatedBy` (`templates/hotel@2.json:8`)). The arbiter has weight 4, external (`weight` (`templates/hotel@2.json:9`), `operatedBy` (`templates/hotel@2.json:9`)). The co-signer has weight 2, operated by the service (`weight` (`templates/hotel@2.json:10`), `operatedBy` (`templates/hotel@2.json:10`)). The quorum is 7 (`quorum` (`templates/hotel@2.json:12`)).

The hotel demo generates the co-signer wallet on its own, and the comment says that key signs only (`cosigner` (`packages/cosigner/demo/hotel-testnet.ts:101`)).

## The revocation limit

Removing or expiring the credential does not take an arbiter off a SignerList that is already installed. The arbiter's weight stays, and `settle.ruling` is still not co-signed (`SignerList` (`docs/trust-model.md:88`)).

`buildOpenBatch` installs that list once, in the open Batch (`SignerListSet` (`packages/ledger/src/xrpl-io.ts:60`)). The draft notes that this code does not submit `CredentialDelete` (`CredentialDelete` (`docs/spec/attestations.md:3`)).

## Cost

One deal's reserve, Ticket count, and open and close fees are the sheet in [Per-deal costs](costs.md) (`hotelTickets` (`docs/costs.md:3`)).
