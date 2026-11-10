# Engagement Accounts
### Bounded, accountable payments for AI agents — enforced by the XRP Ledger

**The problem.** AI agents can now pay (x402, MPP) and hold keys (embedded wallets), but nothing
gives an agent a *bounded mandate with recourse*. A funded agent key is only as safe as the wallet
holding it, and payment rails don't do escrow, disputes, or multi-party settlement. For anything
high-value — or between parties who don't fully trust each other — "give the agent a wallet with
limits" isn't enough.

**What it is.** A single-use XRPL account, opened per deal:

- master key disabled — no standing admin key;
- a `SignerList {owner, agent, policy co-signer}` at quorum 2;
- funded with a bounded budget, then closed and deleted at settlement.

The agent holds only a **weight-1** key — it **cannot move funds alone**. A **policy co-signer**
supplies the second signature the ledger requires, and only when the payment matches the declared
mandate (payee, amount, invoice, caps). The quorum is enforced by XRPL consensus, so the mandate
holds *even if the agent's wallet is compromised or misconfigured*.

**Why it's different**

- **Ledger-enforced, not wallet-enforced.** Limits live on the SignerList — independent of any wallet
  vendor or key-custody choice.
- **Recourse by design.** Escrow, dispute → arbiter co-sign → partial refund, and collateral bonds:
  settlement with a path back, not just a payment.
- **Rail- and wallet-neutral.** Settles over **x402** and **MPP**, and rides embedded-wallet platforms
  (e.g., **Privy**) that hold the agent's key. It sits *on top of* the rails and *above* the wallet —
  not competing with either.

**Where it fits**

| Rails — x402, MPP | Wallets — Privy, OWS | **Engagement accounts** |
|---|---|---|
| move the money | hold the agent's key; limits pre-sign | **ledger-enforced mandate + recourse** |

**Proven on XRPL Testnet**

- **Bounded procurement agent — 11/11** end to end: in-policy spends, approval bound to the payment,
  daily caps, replay protection, agent-alone rejection (`tefBAD_QUORUM`), and owner close + account
  delete.
- **x402 purchase 4/4**; an **MPP push-settlement demo**; **core ledger mechanics 21/21** (pre-create,
  atomic open, settle-and-close).
- Deterministic policy engine (`cel-eng/1`) with a policy co-signer; a multisig-verification amendment
  proposed upstream to the x402 `exact` XRPL scheme.

*(Escrow, arbiter, and collateral bonds are designed and on the near-term roadmap; the bounded-spend
flow above runs today.)*

**Use cases.** Bounded procurement agents · consumer shopping with weekly caps · escrow-with-recourse
marketplaces · any high-value or multi-party agent deal where trusting the wallet alone isn't enough.

**Status.** Working Testnet reference implementation; open to pilots and design partners.

**Contact:** `[ name · email · GitHub ]`
