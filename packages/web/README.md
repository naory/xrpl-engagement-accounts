# @eng/web — the end-to-end demo (one UI, two modes)

A single page that tells the whole story: three parties are provisioned into an engagement
account's SignerList, the account opens on-ledger, and an AI agent then tries to spend — settling
when the mandate allows and getting blocked when it doesn't, with the co-signer withholding its
signature.

## Two modes, one file

`public/index.html` runs either way:

- **Simulated** — opened on its own (e.g. the published artifact), it animates the flow with
  illustrative data. No backend, no network; reliable for a talk. Clearly marked as simulated.
- **Live** — served by this backend (`npm run web`), the same page drives real XRPL Testnet:
  provisioning runs the `eng.provision/1` protocol for real, the account opens on-ledger, and each
  agent request is a real multisigned payment the co-signer co-signs only on `SIGN`. Transaction
  hashes link to the public explorer.

The backend injects `window.__ENG_API__` when it serves the page; that flag is what flips the UI
from simulation to live.

## Run it live

```bash
npm run web                                             # http://127.0.0.1:8080
XRPL_URL=wss://s.devnet.rippletest.net:51233 PORT=8080 npm run web
```

Needs direct XRPL websocket egress (so run it on a normal network). First `Provision & open` funds a
cast from the Testnet faucet and opens the account (~30–60s); then the four buttons exercise the
policy: pay Vendor A (in policy → settles), pay Vendor B over the threshold with no approval
(refused), approve and retry (settles), pay a stranger (refused).

## API

| Route | Does |
|-------|------|
| `POST /api/provision` | funds the cast, runs `eng.provision/1`, opens the account, registers it with an in-process co-signer |
| `POST /api/pay` | the agent proposes + settles a payment (the co-signer co-signs only if the policy passes) |
| `POST /api/escrow` | escrow settlement: release (buyer + seller + co-signer), arbiter ruling split (arbiter + buyer), or a blocked seller-alone attempt |
| `POST /api/x402` | an x402 metered purchase bound to a merchant challenge (buy / redirect-blocked / replay-blocked) |
| `POST /api/propose` | propose + co-sign without broadcasting (returns the quorum blob) |
| `GET /api/status` | balances + the signed decision log |

The orchestration lives in `src/orchestrator.ts`, composing `@eng/provisioning`, `@eng/cosigner`,
and `@eng/agent-mcp` over a live `XrplChain`. It keeps its keys and co-signer in memory for one demo
session; it is a demo, not a service.

## Scenarios

A template dropdown switches between five scenarios, both in simulated and live mode:

- **Procurement agent** (owner wallet, quorum 2): the agent spends repeatedly; the co-signer signs
  in-policy payments and refuses the rest.
- **Escrow with arbiter** (settlement vault, quorum 5): buyer (2), seller (2), arbiter (3), co-signer
  (1), plus a delivery attester. Three endings — happy release (buyer + seller + co-signer), arbiter
  ruling 70/30 (arbiter + buyer), and a seller-alone attempt that the ledger rejects below quorum.
- **Bonded marketplace** (collateral + slashing, quorum 5): the *seller* stakes a bond (seller 2,
  buyer 2, arbiter 3, co-signer 1). Three endings — the bond returns to the seller on delivery
  (buyer + seller + co-signer), the arbiter slashes it 70% to the buyer on harm (arbiter + buyer),
  and a seller-alone reclaim the ledger rejects below quorum. Settled fast (no AccountDelete), like escrow.
- **x402 metered purchase** (owner wallet, quorum 2): an agent pays a merchant per request. The
  co-signer's **W7** rule binds the co-signature to the merchant's x402 challenge (right merchant,
  amount, invoice) — so a buy settles, a payment redirected to a different merchant is refused, and a
  replayed (spent) challenge is refused. Reuses the procurement engagement + policy; no adapter needed.
- **MPP push payment** (owner wallet, quorum 2): the same account and co-signer on a different rail
  — the agent *pushes* a charge to a Stripe/Tempo (MPP) merchant and the co-signer binds it with the
  same rail-neutral W7 rule (`scheme: mpp`). Proves the governance is rail-neutral: the push settles,
  a redirected charge is refused. Shares the x402 backend (a `scheme` param).

**Live escrow settles without the final `AccountDelete`.** XRPL requires an account to be ~256
ledgers old before deletion (~15 minutes) — too slow for a live demo — so the co-signed release and
the arbiter split are real on-ledger settlements, but the escrow account is left open rather than
deleted. Simulated mode narrates the full close.

## Landing page

`public/landing.html` is a scroll-told launch page — the hard questions, the product reveal, then a
single live-demo call to action. `npm run web` serves it at `/` and the interactive demo at `/demo`;
the landing's **Demo** button points at `/demo` when served locally, or at the published demo
artifact when the landing page is shared on its own.
