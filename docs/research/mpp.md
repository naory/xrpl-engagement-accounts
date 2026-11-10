# MPP and the Open Wallet Standard: notes and implications

> Prompted by Ripple's **XRPL AI Starter Kit v1.1** (2026-09-17, beta), which added the
> **Machine Payments Protocol (MPP)** — co-authored by **Stripe and Tempo** — and the
> **Open Wallet Standard (OWS)**. XRPL had already added **x402** in June, so the kit now speaks
> both. This note is a read of what they are and where engagement accounts sit relative to them,
> updated after reading the MPP XRPL method docs and the OWS overview. The one thing still
> genuinely open is whether OWS's policy engine admits a **remote/external** policy service (its
> docs don't say); the rest is confirmed below.

## 1. What MPP is

MPP is a **method-pluggable HTTP-402 umbrella**, built on IETF Internet-Drafts
([`tempoxyz/mpp-specs`](https://github.com/tempoxyz/mpp-specs), rendered at
[paymentauth.org](https://paymentauth.org)). It is deliberately neutral to the underlying rail.

- **Core** — "The 'Payment' HTTP Authentication Scheme." The flow:
  1. client `GET /resource`;
  2. server `402` with `WWW-Authenticate: Payment` listing supported options;
  3. client fulfils payment (sign a tx / pay an invoice / card);
  4. client retries with `Authorization: Payment` carrying a **payment credential** (proof of payment);
  5. server verifies and returns `200` with a `Payment-Receipt` header (proof of delivery).
  Idempotency, security and receipts are first-class.
- **Intents** — **Charge** (one-time), **Session** (deposit once, authorise incrementally,
  settle the accumulated total), **Subscription**.
- **Methods** — concrete per-network bindings, **including XRPL** (alongside Tempo, EVM, Solana,
  Stellar, Lightning, Stripe, Card, …). Any currency.
- **Extensions** — Discovery, Identity (agent identity in the `mppx` SDK).
- SDKs: `mppx` (TypeScript, reference), `pympp`, `mpp-rs`, `mpp-go` (Tempo Labs / Wevm).

**Relationship to x402.** MPP is the broader envelope and **interoperates with x402**: it ships
x402-compatibility modules and can carry x402 `exact` flows from one SDK. The 402 handshake is the
same shape we already implement, with different header/credential names (`WWW-Authenticate:
Payment` / `Authorization: Payment` / `Payment-Receipt` vs x402's `PAYMENT-REQUIRED` /
`PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`).

What MPP (like x402) does **not** provide: escrow, refunds-as-protocol, disputes, partial
outcomes, multi-party settlement, or ledger-enforced bounded delegation. Its policy story is the
Open Wallet Standard (below).

### 1.1 The MPP **XRPL** method (from mpp.dev)

- **Charge** — an immediate on-chain `Payment` (~3–5 s). Two modes:
  - **Pull (default):** the client signs the `Payment` and hands over the **serialised blob**; the
    **server submits** it and observes the result.
  - **Push:** the **client submits** the transaction itself and presents the **transaction hash**;
    the server polls the ledger for it. Binding uses the XRPL **`InvoiceID`** field (signature-
    covered, ledger-indexed) and is **mandatory** in push mode. `methodDetails` also carries
    `invoiceId` and `destinationTag`, which the SDK checks against the route.
  - Assets: **XRP** (drops), **issued currencies/IOUs** (`currency` = `{currency, issuer}`, so
    RLUSD works), and **MPTs** (`mpt_issuance_id`). Memos are not required and not forbidden.
  - Multisig isn't called out in the SDK (examples use a single `Wallet`), but **push mode makes
    it moot** for engagement accounts: the ledger validated the multisig before the hash exists
    (see §3).
- **Session** — off-chain vouchers over a **native XRPL Payment Channel**, **XRP-only**: open the
  channel on-chain, sign cumulative one-way vouchers off-chain, settle with one closing
  transaction (two on-chain txs settle an unbounded number of off-chain payments).

### 1.2 XRPL charge wire format (pinned from `xrpl-mpp-sdk`)

The reference XRPL method SDK (`xrpl-mpp-sdk`, method name `"xrpl"`) fixes the charge wire format,
on top of the core "Payment" auth scheme (IETF `draft-ryan-httpauth-payment`: base64url JCS JSON,
scheme token `Payment`, headers `WWW-Authenticate` / `Authorization` / `Payment-Receipt`):

- **402 challenge** — `WWW-Authenticate: Payment id=…, realm=…, method="xrpl", intent="charge",
  request=<base64url JCS>`. The `request` JSON is `{ amount, currency, recipient, description?,
  externalId?, methodDetails?: { invoiceId?, destinationTag?, sourceTag?, network?, reference?,
  memos?[] } }`. `amount` is drops for XRP / token units for IOU/MPT; `currency` is `"XRP"` or the
  issued-currency code.
- **Credential** — `Authorization: Payment <base64url JSON>` = `{ challenge, payload, source? }`.
  The XRPL charge `payload` is a discriminated union on `type`:
  - `{ type: "hash", hash }` — **push**: the client already submitted; `hash` is the validated
    transaction. ⇒ maps to our `prepaid`.
  - `{ type: "transaction", blob }` — **pull**: a signed transaction blob the server submits. ⇒
    maps to our `exact`.
- **Receipt** — `Payment-Receipt: <base64url JSON>` = `{ method: "xrpl", status: "success",
  timestamp, reference (the tx hash), … }`.

There is **no top-level `network` or `scheme` field** — the rail is `challenge.method` (`"xrpl"`),
the intent is `challenge.intent` (`"charge"`), and the invoice id lives in
`request.methodDetails.invoiceId`.

## 2. What the Open Wallet Standard is

OWS is a **wallet-layer interface standard** (MoonPay-originated, **MIT-licensed**, on GitHub with
Node/Python SDKs, a CLI and an MCP server — not a custody product). It lets an agent hold value,
sign and pay **without the key ever being exposed** to the agent process, the model context or the
parent app. Seven modular sub-specs: **storage format, signing interface** (`sign`,
`signAndSend`, `signMessage`), **policy engine, agent access, key isolation, wallet lifecycle,
supported chains** (chain-family adapters including **XRP Ledger**; Ripple is a contributor).

- **Policy engine** runs **before signing**: spending limits, asset-type restrictions, counterparty
  **whitelist** (= approved destinations), and declarative circuit breakers.
- **Key isolation:** keys encrypted at rest (AES-256-GCM), decrypted only to produce a signature,
  never swapped to disk; agents reach the wallet via MCP under scoped permissions.

So OWS enforces policy **in the wallet, pre-sign, against a locally-held key** — the Privy /
Sardis / PolicyLayer pattern, now an open standard. It is "the wallet layer underneath, not the
payment protocol on top."

## 3. Implications for engagement accounts

1. **Engagement accounts settle MPP in push mode — which is exactly our `prepaid` scheme.**
   MPP **push** = the client submits its own XRPL transaction and presents the hash; the server
   confirms it on-ledger and binds via `InvoiceID`. That is precisely what
   [`x402-xrpl-settlement-adapter`](https://www.npmjs.com/package/x402-xrpl-settlement-adapter)'s
   `prepaid` scheme already does, and the engagement payment is multisigned — so **push sidesteps
   the multisig question the same way it did for x402**: the ledger has already enforced the
   SignerList and quorum, and the server only reads the validated transaction. Pull mode (server
   submits the client's blob) would hand submission — of a multisigned blob — to the server, so
   push is the cleaner fit for engagement accounts.
   - **Binding lines up with what we already have.** MPP push binds on the XRPL `InvoiceID` field;
     our `tx.boundToInvoice(ref)` already accepts `InvoiceID == sha256(ref)` (the `exact`-scheme
     binding). And because MPP doesn't forbid memos, the payment can keep `eng/basis` (B8) and
     `eng/invoice` (W6) **and** carry the `InvoiceID` binding. We therefore settle MPP via the
     reference SDK rather than adding an envelope module to our adapter — see §6.
2. **W7 binds an MPP charge the same as an x402 challenge.** A charge quote carries destination,
   amount and `invoiceId` — the fields W7 checks. **Done:** the co-signer's challenge statement is
   now the scheme-neutral `payment.challenge/1` (`scheme` = `x402` | `mpp`), and W7 binds to it
   regardless of rail.
3. **MPP Sessions are XRPL Payment Channels — a different primitive, cleanly complementary.**
   A session streams XRP micropayments to **one** destination over a PayChan (XRP-only). An
   engagement account is a **multisig, multi-payee, RLUSD budget** with policy and recourse.
   Neither substitutes for the other: payment channels for high-frequency XRP streaming to a
   single payee; engagement accounts for bounded, conditional, multi-vendor spend with
   ledger-enforced limits. (This also pins down why MPP's "sessions" are XRP-only: PayChan has no
   IOU/RLUSD support on XRPL today.)
4. **OWS is both a surface to ride and the thing we differentiate from.** OWS gives the agent a
   clean, key-isolated wallet with a *pre-sign, locally-enforced* policy engine. An engagement
   account + co-signer is the **ledger-enforced** layer: the quorum lives on the SignerList, not in
   the wallet's custody.
   - *Ride it:* the agent's OWS wallet holds the agent's **weight-1 key on an engagement account**,
     and its policy engine mirrors (or defers to) the co-signer — "an OWS wallet whose limits are
     ledger-enforced." OWS's policy engine **can** defer to a remote co-signer — via its
     custom-executable escape hatch, as a fail-closed allow/deny gate, never as a second signer.
     Confirmed against the spec; see [docs/research/ows.md](ows.md).
   - *Differentiate:* OWS limits are only as strong as the wallet holding the key; engagement-
     account limits are read from the ledger. Same distinction we draw against Privy / Sardis.

## 4. Positioning

Ripple backing **x402 and MPP and OWS** together validates the category and argues for being
**scheme-agnostic**: settlement spans x402 (our adapter) and MPP (the reference SDK), and the
co-signer's binding rule is scheme-neutral. The README's "thin layers" (§1), x402 section (§8) and prior-art
table (§11) should name MPP / Tempo and OWS / MoonPay as the emerging XRPL-native agent-payment
standards that the engagement layer **settles on and sits above** — recourse, ledger-enforced
bounded delegation, stake and multi-party settlement are still unserved by any of them.

## 5. Still open

- ~~The exact XRPL credential field names~~ — **pinned** from the reference SDK (`xrpl-mpp-sdk`)
  and the IETF core draft; see §1.2.
- Whether an MPP XRPL **relay explicitly supports multisigned payers** (not called out in the SDK;
  push mode makes it moot for us, but worth confirming before relying on pull mode).
- ~~Whether the **OWS policy engine** admits a **remote/external** policy service (a co-signer)~~
  — **answered:** only via the custom-executable escape hatch, and only as an allow/deny verdict
  (not a signature); see [docs/research/ows.md](ows.md).

## 6. Decision: settle MPP via the reference SDK

We do **not** add an MPP envelope to `x402-xrpl-settlement-adapter`. The reference
[`xrpl-mpp-sdk`](https://www.npmjs.com/package/xrpl-mpp-sdk) already implements the XRPL charge
method (base64url-JCS envelope, HMAC-bound challenge, push/pull), and in **push mode** a multisig
engagement-account payer works through it transparently — the server settles by reading the
*validated* transaction by hash, so the quorum the ledger already enforced needs no special
handling. Re-implementing the envelope (JCS + HMAC) in our adapter would duplicate the SDK for no
gain and pull a beta dependency into a published package.

**The engagement-account MPP flow, then:**

1. The merchant runs an `xrpl-mpp-sdk` server and answers the agent with `402 WWW-Authenticate:
   Payment method="xrpl" intent="charge"` (amount, recipient, `methodDetails.invoiceId`).
2. The agent builds the engagement `Payment` to the merchant with the XRPL `InvoiceID` bound to
   `invoiceId` (plus the usual `eng/basis` + `eng/invoice` memos), and declares a
   `payment.challenge/1` statement with `scheme: "mpp"` to the co-signer.
3. The co-signer's **W7** binds its signature to that challenge (destination, amount, invoice) —
   rail-neutral, so it covers MPP exactly as it covers x402.
4. The agent submits the multisigned `Payment`, then returns the tx hash as the MPP **push**
   credential (`payload { type: "hash", hash }`). The `xrpl-mpp-sdk` server confirms the validated
   transaction and delivers.

So the only engagement-specific work for MPP is the co-signer binding (shipped as
`payment.challenge/1`); settlement is the reference SDK's job. If we later want one verify API
across x402 and MPP in our adapter, the thin-bridge option (depend on `xrpl-mpp-sdk`, route
`push -> confirmExactSettlement`) stays open.

**Confirmed while building `demo:mpp`.** The reference `xrpl-mpp-sdk@0.1.0-beta.4` peers on
`xrpl >=4 <5` (and `mppx >=0.8 <0.10`), while this repo is on `xrpl@5` — so it cannot be added to
the tree without a broken resolution. This is the concrete form of the "pull a beta dependency"
cost above, and it settles the direction: the demo merchant speaks the §1.2 wire format (verified
field-for-field against the SDK's `charge` schema) and routes push → `confirmExactSettlement`;
`xrpl-mpp-sdk` is used only as the spec oracle. The engagement-account → MPP push path is shown
end to end in [`packages/cosigner/demo/mpp/`](../../packages/cosigner/demo/mpp/) — in-process test
5/5 (`test:mpp`) and a live Testnet script (`demo:mpp`); see the
[walkthrough](../demo/mpp-purchase.md).

## Sources

- Stripe, Introducing the Machine Payments Protocol: <https://stripe.com/blog/machine-payments-protocol>
- MPP overview, XRPL method, spec index: <https://mpp.dev/overview> · <https://mpp.dev/payment-methods/xrpl> · <https://mpp.dev/payment-methods/xrpl/charge> · <https://paymentauth.org> · <https://github.com/tempoxyz/mpp-specs>
- CoinDesk, Ripple adds XRP payments to Stripe and Tempo's AI standard (2026-09-17): <https://www.coindesk.com/tech/2026/09/17/ripple-adds-xrp-payments-to-stripe-and-tempo-s-ai-standard-in-new-developer-kit>
- MoonPay, Open Wallet Standard: <https://www.moonpay.com/newsroom/open-wallet-standard> · overview: <https://blockeden.xyz/blog/2026/04/03/moonpay-open-wallet-standard-ai-agent-universal-wallet-infrastructure/>
- Core auth scheme (IETF draft): <https://datatracker.ietf.org/doc/html/draft-ryan-httpauth-payment>
- Reference XRPL method SDK: `xrpl-mpp-sdk` on npm (0.1.0-beta.4) — charge/session schemas, method name `xrpl`
