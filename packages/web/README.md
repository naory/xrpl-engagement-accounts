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
| `POST /api/escrow` | bonded-marketplace settlement: bond release (seller's agent + buyer + co-signer), arbiter slash (arbiter + buyer), or a blocked seller-alone attempt |
| `POST /api/hotel` | runs one hotel-stay path (`{ path }`, one of the eight `HotelPath`s) on its own engagement account through the real co-signer; returns `HotelFlow`'s steps |
| `GET /api/hotel` | hotel readiness: whether the pre-created accounts have aged enough to run, and which paths already ran |
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
- **Hotel stay** (`settlement-vault/hotel@2`, quorum 7): guest (3), hotel (3), arbiter (4), backup
  arbiter (2), co-signer (2), under `pol_hotel@2.0.0`. A path picker runs any of the eight paths
  (happy, unconfirmed, no-show, entry dispute conceded / ruled, silence, claim unanswered, backup
  ruling). Each step shows the co-signer's decision record as it is — stage, SIGN/REFUSE, failing rules,
  and every rule row (id · result · reason) — plus its receipt for posted statements, the transaction
  and the payouts. The page writes no check text of its own. Simulated mode replays
  `public/hotel-sim.json` (`npm run web:hotel-sim`), a transcript the real co-signer produced over a
  fixture ledger with a three-night clock. Live mode runs the path on Testnet with timers seconds apart
  and the demo's 60 s ruling window, through to `AccountDelete`.
- **Bonded marketplace** (collateral + slashing, quorum 5): the *seller* stakes a bond (seller 2,
  buyer 2, arbiter 3, co-signer 1). Three endings — the bond returns to the seller on delivery
  (buyer + seller + co-signer), the arbiter slashes it 70% to the buyer on harm (arbiter + buyer),
  and a seller-alone reclaim the ledger rejects below quorum. Settled fast (no AccountDelete).
- **x402 metered purchase** (owner wallet, quorum 2): an agent pays a merchant per request. The
  co-signer's **W7** rule binds the co-signature to the merchant's x402 challenge (right merchant,
  amount, invoice) — so a buy settles, a payment redirected to a different merchant is refused, and a
  replayed (spent) challenge is refused. Reuses the procurement engagement + policy; no adapter needed.
- **MPP push payment** (owner wallet, quorum 2): the same account and co-signer on a different rail
  — the agent *pushes* a charge to a Stripe/Tempo (MPP) merchant and the co-signer binds it with the
  same rail-neutral W7 rule (`scheme: mpp`). Proves the governance is rail-neutral: the push settles,
  a redirected charge is refused. Shares the x402 backend (a `scheme` param).

**The live bond settles without the final `AccountDelete`.** XRPL requires an account to be ~256
ledgers old before deletion (~15 minutes), too slow for a live demo, so the co-signed release and
the arbiter slash are real on-ledger settlements, but the bond account is left open rather than
deleted. Simulated mode narrates the full close.

**The live hotel stay does close with `AccountDelete`,** so each path needs its own account that is
old enough to delete. Without the pool, `Provision` pre-creates one account per path and the page
reports "waiting for the accounts to age" (~15 min) until they are ready; each path then runs once per
provision (a few minutes each). With `ENG_USE_POOL=1` each path leases a pre-aged account from the
pool when it runs, hands it to the run's service key and tops up its reserve for the SignerList and
15 Tickets.

## Landing page

`public/landing.html` is a scroll-told launch page — the hard questions, the product reveal, then a
single live-demo call to action. `npm run web` serves it at `/` and the interactive demo at `/demo`;
the landing's **Demo** button points at `/demo` when served locally, or at the published demo
artifact when the landing page is shared on its own.
