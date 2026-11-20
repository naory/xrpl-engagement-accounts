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
COSIGNER_URL=http://127.0.0.1:8787 COSIGNER_API_TOKEN_FILE=.cosigner/cosigner.token \
AGENT_SEED=s… ENGAGEMENT_ID=eng_… ENGAGEMENT_ACCOUNT=r… ASSET_ISSUER=r… \
npm run mcp

# live (testnet) — broadcasting enabled
XRPL_URL=wss://s.altnet.rippletest.net:51233 AGENT_ALLOW_SUBMIT=1 \
COSIGNER_URL=http://127.0.0.1:8787 COSIGNER_API_TOKEN_FILE=.cosigner/cosigner.token \
AGENT_SEED=s… ENGAGEMENT_ID=eng_… ENGAGEMENT_ACCOUNT=r… ASSET_ISSUER=r… ASSET_CODE=RLUSD \
npm run mcp
```

`COSIGNER_API_TOKEN`, when set, wins over `COSIGNER_API_TOKEN_FILE`. The process prints
`COSIGNER_API_TOKEN is in use; COSIGNER_API_TOKEN_FILE is ignored` and does not print the token.

### Environment

| Var | Required | Default | Meaning |
|-----|----------|---------|---------|
| `AGENT_SEED` | local key | — | Seed of the agent's signing key (a `SignerList` entry, never funded). Wins over `AGENT_SEED_FILE`. |
| `AGENT_SEED_FILE` | local key | — | Path of a one-line seed file. Read once. When `AGENT_SEED` is also set, stderr gets `AGENT_SEED is in use; AGENT_SEED_FILE is ignored` and the seed is not printed. Not used when `AGENT_KEY_SOURCE=privy`. |
| `ENGAGEMENT_ID` | yes | — | The engagement to act on. |
| `ENGAGEMENT_ACCOUNT` | yes | — | The engagement account (sender of every payment). |
| `ASSET_ISSUER` | yes | — | IOU issuer of the spending asset. |
| `ASSET_CODE` | no | `RLUSD` | Human currency code (→ 40-hex for non-standard codes). |
| `COSIGNER_URL` | no | `http://127.0.0.1:8787` | Co-signer base URL. `eng open` only accepts a loopback URL from `local.json`. |
| `COSIGNER_API_TOKEN` | no | — | Bearer token. Wins over `COSIGNER_API_TOKEN_FILE`. |
| `COSIGNER_API_TOKEN_FILE` | no | — | Path of the bearer file (`cosigner.token` from `npm run cosigner:local`). The token is not printed. |
| `XRPL_URL` | no | — | rippled/Clio endpoint. Present ⇒ live build + submit possible. |
| `AGENT_ALLOW_SUBMIT` | no | off | `1`/`true` **and** `XRPL_URL` ⇒ `submit_payment`/`pay_vendor` enabled. |
| `AGENT_STAGE` | no | `spend` | Policy stage to evaluate against. |

`npm run mcp` starts the same server through `src/bin/eng-mcp.ts`. npm writes its own lines to stdout, so that script is not a client command. Stdout has to stay JSON-RPC. Use the packed bin below.

## Packed server (pre-publish)

`@eng/agent-mcp` is not on the npm registry (`private: true`, `0.1.0`). `npx --package` of the agent-mcp tarball alone does not install `@eng/core`, `@eng/policy`, or `@eng/ledger`.

`npm run pack-smoke` installs the four tarballs together in a scratch directory. It also installs `@eng/provisioning`, which this server does not import. The same install:

```bash
npm install ./eng-core-0.1.0.tgz ./eng-policy-0.1.0.tgz ./eng-ledger-0.1.0.tgz ./eng-agent-mcp-0.1.0.tgz
npx --no-install eng-mcp
```

`node_modules/.bin/eng-mcp` is that same command. pack-smoke runs both, with `XRPL_URL` unset and no co-signer token, and `tools/list` returns `propose_payment`, `submit_payment`, `pay_vendor`, and `engagement_status`. The process does not open a ledger connection. A later tool call that needs the co-signer or the ledger returns an error. Every stdout line is JSON-RPC. A missing env var and the seed and token notices go to stderr.

`npm install -g` of those four tarballs puts `eng-mcp` on the PATH. pack-smoke uses the scratch directory, not a machine-wide `-g`.

Node >= 22.13. On Windows the scratch shim is `eng-mcp.cmd`.

TESTNET ONLY. A seed in a desktop config is a Testnet throwaway. Prefer `AGENT_SEED_FILE` (one line, mode 0600) so the file holds a path. `COSIGNER_API_TOKEN_FILE` is the bearer path. Do not put either value in the JSON. Do not put `VENDOR_SEED` in this config: that seed signs invoices, and an agent that holds it can forge them and defeat W6. `VENDOR_ADDRESS` is the payee address from `eng open`, not a seed.

Claude Desktop reads `claude_desktop_config.json`. Cursor reads `.cursor/mcp.json`. Same `mcpServers` object. This is the command pack-smoke runs, via the absolute shim:

```json
{
  "mcpServers": {
    "eng": {
      "command": "/absolute/path/node_modules/.bin/eng-mcp",
      "env": {
        "ENGAGEMENT_ID": "eng_…",
        "ENGAGEMENT_ACCOUNT": "r…",
        "AGENT_SEED_FILE": "/absolute/path/agent.seed",
        "ASSET_ISSUER": "r…",
        "VENDOR_ADDRESS": "r…",
        "COSIGNER_URL": "http://127.0.0.1:8787",
        "COSIGNER_API_TOKEN_FILE": "/absolute/path/cosigner.token"
      }
    }
  }
}
```

## After publish (T26)

Not what pack-smoke runs. Once the packages are on the registry, the client command is `npx --yes --package @eng/agent-mcp eng-mcp`.

```json
{
  "mcpServers": {
    "eng": {
      "command": "npx",
      "args": ["--yes", "--package", "@eng/agent-mcp", "eng-mcp"],
      "env": {
        "ENGAGEMENT_ID": "eng_…",
        "ENGAGEMENT_ACCOUNT": "r…",
        "AGENT_SEED_FILE": "/absolute/path/agent.seed",
        "ASSET_ISSUER": "r…",
        "VENDOR_ADDRESS": "r…",
        "COSIGNER_URL": "http://127.0.0.1:8787",
        "COSIGNER_API_TOKEN_FILE": "/absolute/path/cosigner.token"
      }
    }
  }
}
```

On Windows, `"command"` is `npx.cmd`. Node >= 22.13. TESTNET ONLY, same as above: the seed file is a Testnet throwaway, and the config stores the path.

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

## Own-agent payment (TESTNET ONLY)

This is the path where your MCP client is the agent. The demo vendor is its own Testnet wallet. Its seed signs `party.invoice/1`. An agent that holds that seed can forge invoices and defeat rule W6, so the seed is not part of the agent env and it is not in the MCP config below.

`npm run cosigner:local`, then:

```bash
npm run eng -- open --template procurement@1
```

Stdout has three parts:

1. **Agent env.** The `ENGAGEMENT_*`, `AGENT_SEED`, `ASSET_*`, `COSIGNER_*`, `XRPL_URL`, `AGENT_ALLOW_SUBMIT`, and `VENDOR_ADDRESS` lines. `VENDOR_ADDRESS` is the payee. Paste those into the client. Do not paste `VENDOR_SEED`.
2. **Invoice.** One `party.invoice/1` JSON document for `pay_vendor`. It is bound to this engagement id and `VENDOR_ADDRESS`, for `800.00` (under the `1000.00` approval threshold), with `validUntil` 24 hours out and `invoiceRef` `inv:open-001`. An invoice is not a secret.
3. **Operator only.** `VENDOR_SEED`, under the TESTNET ONLY banner, after the heading `Operator only`. `--out <file>` writes the same document outside the repo, mode 0600. That file is the other place the vendor seed is written. Keep it off the agent.

`npm run` prints its own lines before the command's stdout. `npm run --silent eng -- open --json` is one JSON document: copy `env` and `invoice`, and leave `operator` out of the client.

Point the MCP client at the packed `eng-mcp` (see below) with that agent env. Then call `pay_vendor`:

```json
{
  "destination": "<VENDOR_ADDRESS>",
  "amount": "800.00",
  "invoiceRef": "inv:open-001",
  "statements": ["<the invoice JSON>"]
}
```

Without `statements`, `pay_vendor` is refused on W6 and nothing is submitted. The same signed invoice a second time is refused `CONSUMED` (the type is single-use). A later invoice is a new signature:

```bash
npm run eng -- invoice --vendor-seed-file /absolute/path/vendor.seed --engagement-id eng_… --amount 800.00 --expires 2026-01-02T00:00:00Z --invoice-ref inv:open-002
```

`--vendor-seed-file` is one line. The command reads it and does not print it. Stdout is the invoice JSON. `--amount` has to be greater than zero and under `1000.00`. `--expires` is a full ISO-8601 time with a zone (`2026-01-02T00:00:00Z`). It has to be strictly after now, and it is stored as UTC `toISOString()`. A bare year is rejected. An expiry after the earlier of `--mandate-expires` and 7 days from now is rejected, not shortened.

The ledger checks the SignerList quorum. The policy co-signer checks the invoice, the cap, and the expiry: ledger-enforced quorum plus policy co-signer.

## Open a Testnet account

`npm run cosigner:local` writes `<DATA_DIR>/local.json`. Then:

```bash
npm run eng -- open --template procurement@1
```

TESTNET ONLY. The command refuses Devnet, mainnet, a non-loopback co-signer URL, and a local co-signer whose `local.json` `trust` is set (`ENG_RLUSD_ISSUER`, `ENG_KYB_ISSUER`, or `ENG_ARBITER_ACCREDITOR`). It faucet-funds a cast, mints a **demo IOU (not RLUSD)**, opens `owner-wallet/procurement@1`, and `POST`s `/v1/engagements` with the bearer from `tokenPath`. A 503 or a connection error is retried three times (1s, then 2s). A 4xx is not retried.

`npm run` writes its own lines before the command's stdout, so the TESTNET ONLY banner is not the first line of the terminal. The banner is the first field of the JSON from `npm run --silent eng -- open --json`, and `--out <file>` writes that same document outside the repo, mode 0600. A path inside the repo is refused. The agent env lists `ENGAGEMENT_ID`, `ENGAGEMENT_ACCOUNT`, `AGENT_SEED`, `ASSET_ISSUER`, `COSIGNER_URL`, `COSIGNER_API_TOKEN_FILE`, `XRPL_URL`, and `VENDOR_ADDRESS`. The invoice is the `invoice` field. `VENDOR_SEED` is under `operator`, not in `env`. The bearer is not printed. There is no `--resume`. If the Batch lands and registration still fails, the output's Retry line is a full re-open that creates a new account.

`npm run mcp` with the printed env keeps working after `cosigner:local` is restarted: the registration is in `<DATA_DIR>/cosigner.db`, and the next start rewrites `local.json` with the same address and token path.

## Live demo (Testnet)

`npm run demo:mcp` runs the whole stack on XRPL Testnet: it funds a cast, opens an owner-wallet
engagement account (owner 2 . agent 1 . co-signer 1, quorum 2), starts the co-signer's HTTP
service, then **spawns this MCP server over stdio and drives it with a real MCP client** - exactly
how an agent runtime connects. The agent calls `propose_payment` + `submit_payment` (800, under the
approval threshold), `pay_vendor` without and then with the controller's approval (1,500, above the
threshold), `propose_payment` to a payee outside the mandate (refused, no blob), and
`engagement_status`. Results and the signed decision log land in `demo/results/`.

Needs direct XRPL websocket egress. With no `XRPL_URL`, the demo tries
`wss://testnet.xrpl-labs.com` and then `wss://s.altnet.rippletest.net:51233`
(`resolveTestnetEndpoint` in `@eng/ledger`). `XRPL_URL=...` points it at Devnet or a
local rippled. `eng open` does not: it accepts only the Testnet allowlist. Run the demo from a normal network, not a proxy-only sandbox.

## Roadmap

- Non-`spend` stages as tools (close / sweep) once an agent-initiated close is in scope.
- XRP (native) payments in addition to IOU assets.
- An optional server-side allowlist of destinations, as defense-in-depth beside the policy.
