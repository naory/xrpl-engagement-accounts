# Use case: an enterprise procurement agent (B1)

> The lead product. An AI agent spends from a bounded, single-use engagement account; the
> policy co-signer is the second signature and refuses anything outside the owner's mandate; the
> owner can always act alone. This is the owner-wallet template class.
>
> Runs end to end on XRPL Testnet: [`packages/cosigner/demo/b1-testnet.ts`](../../packages/cosigner/demo/b1-testnet.ts)
> (`npm run demo:b1`), 11/11 (D1–D11). For paying x402 merchants from this account, see
> [x402-purchase.md](x402-purchase.md).

## 0. The deal in one paragraph

A company (the **treasury/owner**) gives an **agent** a Q4 budget to spend with approved vendors.
Rather than hand the agent a key to a treasury wallet, it opens an **engagement account** funded
with exactly the budget and governed by a SignerList: owner weight 2, agent weight 1, policy
co-signer weight 1, quorum 2. The agent can only move funds **together with the co-signer**, and
the co-signer signs only when the payment satisfies the owner's signed mandate (vendor allowlist,
KYB, per-day and total caps, an approval for large amounts, a matching invoice). The owner alone
(weight 2 = quorum) can always sweep and close. The balance *is* the budget: a compromised agent
can lose at most what's in the account, and never to anyone outside the mandate.

## 1. Cast and accounts

| Party | Who | On the SignerList? | Role in policy |
|---|---|---|---|
| **Treasury / owner** | The company's existing wallet | **yes, weight 2** | Signs the mandate (PRINCIPAL). Funds the account. Can act alone. |
| **Agent** | The AI agent's key (generated, never funded) | **yes, weight 1** | Proposes and co-signs spends. Self-attests the x402 challenge (W7). |
| **Policy co-signer** | The service | **yes, weight 1** | Signs a spend only if every policy rule passes. Can't reach quorum alone. |
| **Controller** | A human approver | no (statements only) | Signs `approval.payment/1` for amounts over the threshold (APPROVER). |
| **Vendor A / Vendor B** | Approved suppliers | no (payees) | Hold a `KYB_VERIFIED` credential; issue `party.invoice/1` statements (VENDOR). |
| **KYB issuer** | A credential issuer | no | Issues the vendors' `KYB_VERIFIED` credentials. |
| **Service** | The engagement service | no (holds the pre-create `RegularKey`, removed at open) | Pre-creates and opens the account; receives the reserve at `AccountDelete`. |
| **Engagement account** | Fresh per deal, `rEng…` | — (it *is* the account) | Master key disabled, no RegularKey, holds the RLUSD budget. |

The only key the service holds is the co-signer's weight-1 slot (plus the throwaway pre-create
`RegularKey`, which is removed in the open Batch). The service never reaches quorum. That is the
non-custodial claim, and it is checkable from the SignerList on-ledger.

## 2. The template

[`templates/procurement@1.json`](../../templates/procurement@1.json) — class `owner-wallet`:

```
roles:    owner (w2, external) · agent (w1, external) · cosigner (w1, service)
quorum:   2
outcomes:
  spend        signers [agent, cosigner]   blueprint spend.payments   stage spend        enforcement ledger
  owner.close  signers [owner]             blueprint close.sweep      stage close.owner  enforcement advisory
blueprints:
  spend.payments  pay.vendor ×1–4                               closes: false
  close.sweep     pay.owner, trustline.remove, account.delete   closes: true
reserveObjects: trustlines 1, signerList 1
policyRef: pol_procurement@1.3.0
```

Two ways funds can move, and only two: **agent + co-signer** reach quorum for an in-policy spend
(1–4 vendor payments), or the **owner alone** (weight 2) sweeps and closes. The agent can never
move funds without the co-signer; the co-signer can never move funds at all.

**Validation.** The template passes the validator (V1–V12): the only signer sets that reach
quorum are `{agent, cosigner}` and `{owner}`; the co-signer is never in a winning set by itself;
the reserve and ticket counts are declared; the close blueprint drains and deletes.

## 3. Documents (off-ledger, signed; anchored on-ledger)

Every input to a decision is a signed **statement** (attestation envelope, [spec](../spec/attestations.md)).
None of their content lives on-ledger; the co-signer verifies the signature and the binding.

| Statement | Type | Signed by | Carries |
|---|---|---|---|
| **Mandate** | `party.mandate/1` | owner (PRINCIPAL) | purpose, `budget`, `dailyCap`, `vendors`, `expires`. The root authority for the engagement. |
| **Invoice** | `party.invoice/1` | vendor (VENDOR) | `invoiceRef`, `amount`, `currency`, `po`. One per payment. |
| **Approval** | `approval.payment/1` | controller (APPROVER) | `intentHash` of (destination, amount, invoiceRef), `notAfter`. Single-use, for amounts over the threshold. |
| **payment challenge** | `payment.challenge/1` | agent (AGENT) | `scheme` (`x402` \| `mpp`), `payTo`, `amount`, `invoiceId`, `resource`. Only when paying an x402/MPP merchant (W7); see [x402-purchase.md](x402-purchase.md). |

The approval binds to `tx.intentHash()` — a hash of *destination + amount + invoice reference*,
not the transaction hash — so re-sequencing or re-fee'ing the payment doesn't invalidate it, but
changing who gets paid or how much does.

## 4. Engagement record and state machine

The co-signer is registered with an **engagement record**: the template, the account, the parties
(owner/agent/cosigner), the attesters (approver accounts, vendor accounts), the mandate id, and
the pinned policy-layer hashes. State is simple for an owner wallet:

```
PRE-CREATE ──▶ OPEN ──▶ ACTIVE ──(many spends)──▶ owner close ──▶ (account deleted)
```

There is no counterparty, arbiter or dispute path (those belong to the escrow class). The account
stays `OPEN` across any number of in-policy spends until the owner closes it.

## 5. The policy and how the co-signer evaluates it

Two layers apply, in order: the **baseline** (non-overridable safety) and the **procurement**
template policy. A spend is signed only if **every** rule in both layers passes.

### 5.1 Baseline — [`policies/baseline@1.0.0.json`](../../policies/baseline@1.0.0.json) (B1–B11)

Non-overridable. They protect the account regardless of template.

| Rule | Reason | What it checks |
|---|---|---|
| **B1** | WRONG_ACCOUNT | Every inner transaction is from the engagement account (plus the funder, at open only). |
| **B2** | TX_TYPE_NOT_ALLOWED | Only transaction types allowed for this stage; **installing a `RegularKey` is never allowed**. |
| **B3** | FEE_TOO_HIGH | Fee is under the cap (plus one reserve increment when the tx closes the account). |
| **B4** | NO_EXPIRY | A live transaction carries a short `LastLedgerSequence` (pre-signed stages are exempt). |
| **B5** | NOT_ALL_OR_NOTHING | A Batch must be `ALLORNOTHING`. |
| **B6** | UNAUTHORIZED_DESTINATION | Payouts only to engagement parties, the fee account, child engagements, or mandate vendors. |
| **B7** | UNCLEAN_CLOSE | A closing Batch drains the asset exactly, removes the trust line, and deletes to the service/sponsor. |
| **B8** | NO_BASIS_MEMO | Every co-signed transaction carries an `eng/basis` memo recording why it ran. |
| **B9** | OUTCOME_IN_FLIGHT | No other co-signed outcome is in flight (except in concurrent stages like `spend`). |
| **B10** | WRONG_ISSUER | Every amount uses the policy's declared issuer. |
| **B11** | WOULD_FAIL | Pre-signed outcomes complete only when ledger state makes them succeed exactly. |

### 5.2 Procurement — [`policies/procurement@1.3.0.json`](../../policies/procurement@1.3.0.json) (spend stage, W0–W7)

| Rule | Reason | What it checks |
|---|---|---|
| **W0** | MANDATE_INVALID | A valid, unexpired owner mandate exists. |
| **W1** | TX_SHAPE | The spend is 1–4 vendor payments (`spend.payments` blueprint). |
| **W2** | VENDOR_NOT_ALLOWED | Every payee is a mandate vendor **and** holds a `KYB_VERIFIED` credential from an accepted issuer. |
| **W3** | DAILY_CAP | Validated outflow over the last 24 h + in-flight + this spend ≤ `mandate.dailyCap`. |
| **W4** | BUDGET_EXHAUSTED | The same over 90 days ≤ `mandate.budget`. |
| **W5** | APPROVAL_REQUIRED | If this spend is over the threshold, it is a single payment with a single-use `approval.payment/1` bound to its intent hash. |
| **W6** | NO_MATCHING_INVOICE | Each payment matches a vendor-signed invoice: payee, amount, and the `eng/invoice` memo equal the invoice reference. |
| **W7** | X402_CHALLENGE_MISMATCH | *When* the agent declares a `payment.challenge/1` (x402 or MPP): the single payout's destination and amount match it, and the payment is bound to its invoice. See [x402-purchase.md](x402-purchase.md). |

### 5.3 Evaluation model

- **One pinned ledger per decision.** The co-signer reads balances, owned objects, credentials
  and the account's payment history at a single validated ledger index, so a decision is a pure
  function of (request, statements, ledger snapshot) and can be replayed from the decision record.
- **In-flight accounting.** `spend` is a concurrent stage: a co-signed payment that hasn't
  validated yet still counts toward the rolling caps (W3/W4), and a single-use approval is
  reserved the moment it's used, so two requests can't both spend the same headroom or reuse the
  same approval.
- **Serialised per engagement.** Requests for one engagement are handled one at a time.
- **Signed decision records.** Every decision — SIGN or REFUSE — is written as a signed
  `cosigner.decision/1` record with the failing rule ids and the inputs hash. Advisory stages
  (the owner close) get a decision but **no signature**.

### 5.4 When the co-signer runs

The agent builds the payment, multisigns it with its own weight-1 key, and sends the blob plus
the supporting statements to the co-signer. The co-signer evaluates the two layers against the
pinned ledger; on SIGN it returns its signature, the agent combines the two and submits; on
REFUSE it returns the failing rule ids and no signature.

## 6. XRPL transactions

### 6.1 Pre-create (service, master-signed)

Fund a fresh account with reserve XRP, add its RLUSD trust line, install the service's
`RegularKey`, and **disable the master key**. (Disabling the master key can't run inside a Batch,
so it's a normal master-signed transaction here.) Until it's opened, the account holds only
reserve XRP under the service's regular key.

### 6.2 Open Batch (one atomic `ALLORNOTHING` Batch)

- `SignerListSet` → {owner 2, agent 1, co-signer 1}, quorum 2;
- the owner's RLUSD funding payment (a multi-account inner transaction signed through
  `BatchSigners`);
- `SetRegularKey` with no key → **removes the service's key**.

After this the account is governed only by the SignerList, funded with exactly the budget, with
the master key disabled and no RegularKey — all or nothing.

### 6.3 A spend (agent + co-signer)

A `Payment` from the engagement account to a vendor, `SigningPubKey: ""`, carrying
`eng/basis = spend` (B8) and `eng/invoice = <invoiceRef>` (W6), a short `LastLedgerSequence`
(B4), and `Signers` = [agent, co-signer]. Weight 1 + 1 = quorum 2, so the ledger applies it.

### 6.4 Owner close (owner alone)

One `ALLORNOTHING` Batch signed only by the owner (weight 2 = quorum): sweep the residual RLUSD
to the owner, remove the trust line (zero balance), and `AccountDelete` last (destination: the
service, so the reserve comes back). `AccountDelete` also removes the SignerList and any leftover
objects, so nothing from the deal can outlive it. The co-signer gives an advisory decision here
but no signature — the owner needs none.

## 7. The live demo (`npm run demo:b1`)

Every account is funded fresh from the Testnet faucet; the co-signer runs in-process against a
`XrplLedgerSource` pinned to the latest validated ledger and writes a decision record per request.
Mandate: budget 5,000 RLUSD, daily cap 3,000, approval above 1,000, vendors A and B (both KYB).

| # | Step | Rules exercised | Expected | What it proves |
|---|---|---|---|---|
| **D1** | Open the account (owner funding + SignerListSet + clear RegularKey) | baseline open stage | tesSUCCESS; master disabled, no RegularKey, quorum 2, balance 5,000 | The atomic open leaves a correctly governed, funded account. |
| **D2** | Agent + co-signer pay vendor A 800 (invoice attached, under threshold) | W1, W2, W6, baseline | SIGN; tesSUCCESS; A +800 | The ordinary in-policy spend works at quorum. |
| **D3** | 1,500 to vendor B with no approval | W5 | REFUSE `W5` | Over-threshold payments need an approval. |
| **D4** | Same payment, with the controller's approval bound to the intent | W5 | SIGN; tesSUCCESS; B +1,500 | A single-use approval bound to (dest, amount, invoice) unlocks it. |
| **D5** | Two 400 payments requested before either validates | W3 + in-flight | first SIGN (tesSUCCESS); second REFUSE `W3` | In-flight spends count toward the cap, so headroom can't be double-spent. |
| **D6** | 900 more the same day (2,700 already out) | W3 | REFUSE `W3` | The rolling daily cap holds across validated spends. |
| **D7** | Replay D4's approval and invoice for a second 1,500 | reservations | REFUSE; both statements `CONSUMED` | Single-use statements can't be replayed. |
| **D8** | Pay a non-vendor (no KYB, not in the mandate) | B6, W2 | REFUSE incl. `B6`, `W2` | Funds can't leave to anyone outside the mandate. |
| **D9** | Agent submits with only its own signature | ledger quorum | `tefBAD_QUORUM` | The ledger — not the service — enforces quorum. |
| **D10** | A Batch hiding a `SetRegularKey` next to a valid payment | B2 | REFUSE incl. `B2` | The co-signer won't sign a transaction that would install a backdoor key. |
| **D11** | Owner alone sweeps the residual (2,300), removes the trust line, deletes the account | close.owner (advisory) | tesSUCCESS; account deleted; owner +2,300; co-signer advisory SIGN, no signature | The owner can always exit alone; the account is single-use and leaves nothing behind. |

## 8. Paying x402 merchants

When a spend settles an x402 or MPP purchase, the agent additionally declares a `payment.challenge/1`
statement and rule **W7** binds the co-signature to it: the single payout's destination and amount
must match the challenge, and the payment must be bound to the invoice. The payment itself is
carried through the settlement adapter's `prepaid` scheme. Full walkthrough:
[x402-purchase.md](x402-purchase.md).

## 9. Trust assumptions

| Stage | Trusted to… | Enforced by |
|---|---|---|
| Pre-create | the service, to disable the master key and install only its own RegularKey | master-signed tx, checkable on-ledger |
| Open | the atomic Batch, to install the SignerList and remove the service key together | `ALLORNOTHING` Batch |
| Spend | the co-signer, to apply the policy honestly | the ledger still enforces quorum; a compromised co-signer can at worst co-sign a payment the agent also signed, and only to a mandate vendor (B6/W2) within caps (W3/W4) |
| Close | nobody beyond the owner | the owner alone reaches quorum |

The worst case if the agent's key leaks is the account balance, spent only to mandate vendors
within the caps. The worst case if the co-signer is compromised is the same — it still can't move
funds alone, and the baseline rules (B2/B6/B7) still bind. The owner can sweep at any time.

## 10. Edge cases and what this surfaces for the specs

- **In-flight races** (D5) require the co-signer to count un-validated co-signed payments; this is
  why decisions pin a ledger and reserve approvals.
- **Statement replay** (D7) requires single-use tracking of approvals and invoices.
- **Smuggled authority** (D10) is why B2 forbids `SetRegularKey` outright and the baseline, not the
  template, owns it.
- **Owner escape hatch** (D9, D11) is a property of the weights, not of the service: the ledger
  rejects the under-quorum agent, and the owner alone meets quorum.
