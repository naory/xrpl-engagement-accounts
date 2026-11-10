# @eng/agent-mcp — the agent's side of a co-signed engagement account

An [MCP](https://modelcontextprotocol.io) server that lets an AI agent spend from an
**engagement account** through the policy co-signer, with no way to move funds on its own.

The agent's key is a `SignerList` entry whose weight is **below quorum**. On its own it signs
nothing the ledger will accept. To pay, the agent proposes a transaction and the co-signer
(`@eng/cosigner`, reached over its [§6 HTTP API](../cosigner/src/server.ts)) evaluates it against
the engagement's policy; only on `SIGN` does it return its signature, and the two combine into a
quorum blob. A compromised agent therefore cannot pay anyone the policy would not itself have
signed for — the whole point of the design, now reachable by any MCP-speaking agent runtime.

## The four tools

| Tool | What it does | Broadcasts? |
|------|--------------|-------------|
| `propose_payment` | Build a payment, add the agent's signature, ask the co-signer. On `SIGN`, returns the quorum blob as `combinedBlob` and the on-ledger `txHash`. | no |
| `submit_payment`  | Broadcast a `combinedBlob` from `propose_payment` and wait for validation. | yes (gated) |
| `pay_vendor`      | `propose_payment` + `submit_payment` in one step. | yes (gated) |
| `engagement_status` | The engagement record, in-flight count, and recent co-signer verdicts. | no |

Every verdict is a signed `cosigner.decision/1` record (`recordId`); `failing` lists the policy
rule ids on a `REFUSE`, and `statementsRejected` the statements the co-signer would not accept.

## Two modes

- **Propose-only (default).** No `XRPL_URL`. The agent builds, co-signs, and hands back a quorum
  blob — a human or another system submits it. Safe for untrusted agents and for dry runs.
- **Live.** Set `XRPL_URL` **and** `AGENT_ALLOW_SUBMIT=1` to enable `submit_payment` / `pay_vendor`.
  Submission is **fail-closed**: without both, those two tools refuse and point you at
  `propose_payment`.

```bash
# propose-only against a local co-signer
COSIGNER_URL=http://127.0.0.1:8787 COSIGNER_API_TOKEN=… \
AGENT_SEED=s… ENGAGEMENT_ID=eng_… ENGAGEMENT_ACCOUNT=r… ASSET_ISSUER=r… \
npm run mcp

# live (testnet) — broadcasting enabled
XRPL_URL=wss://s.altnet.rippletest.net:51233 AGENT_ALLOW_SUBMIT=1 \
COSIGNER_URL=http://127.0.0.1:8787 COSIGNER_API_TOKEN=… \
AGENT_SEED=s… ENGAGEMENT_ID=eng_… ENGAGEMENT_ACCOUNT=r… ASSET_ISSUER=r… ASSET_CODE=RLUSD \
npm run mcp
```

### Environment

| Var | Required | Default | Meaning |
|-----|----------|---------|---------|
| `AGENT_SEED` | yes | — | Seed of the agent's signing key (a `SignerList` entry, never funded). |
| `ENGAGEMENT_ID` | yes | — | The engagement to act on. |
| `ENGAGEMENT_ACCOUNT` | yes | — | The engagement account (sender of every payment). |
| `ASSET_ISSUER` | yes | — | IOU issuer of the spending asset. |
| `ASSET_CODE` | no | `RLUSD` | Human currency code (→ 40-hex for non-standard codes). |
| `COSIGNER_URL` | no | `http://127.0.0.1:8787` | Co-signer base URL. |
| `COSIGNER_API_TOKEN` | no | — | Bearer token (the co-signer requires one off loopback). |
| `XRPL_URL` | no | — | rippled/Clio endpoint. Present ⇒ live build + submit possible. |
| `AGENT_ALLOW_SUBMIT` | no | off | `1`/`true` **and** `XRPL_URL` ⇒ `submit_payment`/`pay_vendor` enabled. |
| `AGENT_STAGE` | no | `spend` | Policy stage to evaluate against. |

## Library

The server is a thin wrapper; the flow is a transport-free core you can embed directly.

```ts
import { EngagementAgent, XrplChain, CosignerClient } from '@eng/agent-mcp'

const agent = new EngagementAgent({
  engagementId, account, wallet,            // wallet = the agent's SignerList key
  asset: { code: 'RLUSD', currency: currencyHex('RLUSD'), issuer },
  decider: new CosignerClient({ baseUrl, token }),   // or a local CosignerService
  chain: new XrplChain(await connected()),           // omit for propose-only
})

const { decision, combined } = await agent.proposePayment({ destination, amount: '800.00', invoiceRef, statements })
if (combined) await agent.submit(combined)
```

`decider` is a one-method seam (`Decider`): a local `CosignerService` and a remote
`CosignerClient` are interchangeable, which is why the tests drive both. `chain` is the ledger
seam (`Chain`): `XrplChain` for production, a fake for tests. This mirrors the reference flow in
[`demo/b1-testnet.ts`](../cosigner/demo/b1-testnet.ts) (`multisignBlob` → `decide` → `combine` → `submit`).

## Tests

`npm test` (or `npx vitest run packages/agent-mcp`) runs the suite in-process — no network, no
live ledger — against the real `CosignerService` on the B1 fixture: an in-policy payment SIGNs and
yields a 2-of-n quorum blob, an out-of-mandate payee is refused with no blob, `payVendor` settles
only on `SIGN`, and the same flow runs over the real HTTP server through `CosignerClient`.

## Live demo (Testnet)

`npm run demo:mcp` runs the whole stack on XRPL Testnet: it funds a cast, opens an owner-wallet
engagement account (owner 2 . agent 1 . co-signer 1, quorum 2), starts the co-signer's HTTP
service, then **spawns this MCP server over stdio and drives it with a real MCP client** - exactly
how an agent runtime connects. The agent calls `propose_payment` + `submit_payment` (800, under the
approval threshold), `pay_vendor` without and then with the controller's approval (1,500, above the
threshold), `propose_payment` to a payee outside the mandate (refused, no blob), and
`engagement_status`. Results and the signed decision log land in `demo/results/`.

Needs direct XRPL websocket egress (wss to `s.altnet.rippletest.net:51233`), so run it from a normal
network - not a proxy-only sandbox. `XRPL_URL=...` points it at Devnet or a local rippled.

## Roadmap

- Non-`spend` stages as tools (close / sweep) once an agent-initiated close is in scope.
- XRP (native) payments in addition to IOU assets.
- An optional server-side allowlist of destinations, as defense-in-depth beside the policy.
