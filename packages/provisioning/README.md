# @eng/provisioning — non-custodial signer enrolment (`eng.provision/1`)

Before an engagement account can be opened, its `SignerList` has to be assembled from the owner's,
agent's, and co-signer's keys. This package is the protocol that does that **without any party
handing over a secret** — each signer generates its own key and proves it holds it.

## Proof-of-possession

A signer enrols by submitting its address + public key + a signature over a per-session challenge
(`eng.provision/1 | sessionId | role | address | challenge`). The coordinator accepts it only if:

1. the public key **derives to** the submitted address, and
2. the signature **verifies** against that public key.

So you can only enrol an address you can actually sign for. No party can slip its own key in under
another role, and nobody can register an address they do not control — which matters, because a
wrong `agent` address in the SignerList is either a key that can never pay or an attacker who can.

## Flow

```ts
import { ProvisioningCoordinator, makeEnrolment } from '@eng/provisioning'

const coord = new ProvisioningCoordinator()
const session = coord.createSession({
  engagementId, template: 'owner-wallet/procurement@1', account: engAccountAddress, asset: 'RLUSD',
  quorum: 2, roles: [{ role: 'owner', weight: 2 }, { role: 'agent', weight: 1 }, { role: 'cosigner', weight: 1 }],
  attesters, deleteTo, funder, fundingAmount: '5000', mandate, policyLayers,
})

// each signer, holding its own key, runs this locally — the private key never leaves:
coord.enrol(makeEnrolment(session, 'owner', ownerWallet))
coord.enrol(makeEnrolment(session, 'agent', agentWallet))
coord.enrol(makeEnrolment(session, 'cosigner', cosignerWallet))

const plan = coord.plan(session.sessionId)   // throws until every role has enrolled
// → { signerEntries (sorted by address), quorum, engagement record, mandate, funder, fundingAmount }
```

The owner then builds the open Batch from `plan.signerEntries` (see `@eng/cosigner`'s `buildOpenBatch`)
and submits it; `plan.engagement` is what the co-signer registers.

## HTTP

`createProvisioningServer(coord)` exposes the same protocol:

| Route | Body | Returns |
|-------|------|---------|
| `POST /v1/provision/sessions` | `{ spec }` | `CreatedSession` (id + challenge) |
| `POST /v1/provision/sessions/:id/enroll` | `Enrollment` | `{ ok, enrolled, remaining }` |
| `GET /v1/provision/sessions/:id` | — | `{ complete, enrolled, remaining, plan? }` |

Loopback/dev as written; put it behind the co-signer's bearer-token pattern before exposing it.

## Tests

`npx vitest run packages/provisioning` — enrolment by PoP assembles the right SignerList + engagement
record; a mismatched address, a tampered proof, and an unknown role are all rejected; the plan throws
until complete; the HTTP path round-trips. No network.

## Roadmap

- Coordinator-signed plans (so the opener can verify the SignerList's provenance).
- A short enrolment TTL and single-use sessions.
- Threshold/weight policies beyond the owner-wallet default.
