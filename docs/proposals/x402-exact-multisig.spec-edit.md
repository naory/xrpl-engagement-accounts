<!--
Ready-to-paste amendment to specs/schemes/exact/scheme_exact_xrpl.md (x402-foundation/x402).
Three inserts; each "## Insertion … → …" header says where it goes. The text UNDER each header is
plain markdown — copy it straight in (nothing to strip). Renumber to match the live file at merge
time. House style: MUST/SHOULD/MAY keywords, JSON examples, reference core types rather than redefine
them. Single-signer verification, the PaymentPayload envelope, and the Memos/Delegate rules are
unchanged by all three inserts.
-->

# In-format amendment to `scheme_exact_xrpl.md`

## Insertion A → new subsection under **§10 Signature Validation**

### 10.1 Multisig Validation (SignerList)

A payer MAY be a multi-signing account. In that case the decoded transaction carries a non-empty
`Signers` array and an empty top-level `SigningPubKey`. When `tx_json.Signers` is a non-empty array,
the facilitator MUST verify it **offline**, against the payer's `SignerList` at the same validated
ledger used in §7 (Expiry and Account Sequencing), in addition to every other check in this section:

1. **Empty transaction key.** `tx_json.SigningPubKey` MUST be the empty string `""`. A non-empty
   value alongside `Signers` is malformed and MUST be rejected.
2. **Account and SignerList.** `tx_json.Account` MUST exist at the validated ledger and MUST have a
   `SignerList` with a positive `SignerQuorum`; otherwise verification MUST fail.
3. **Per-signer verification**, matching `rippled`'s `checkMultiSign`. Construct the multi-signing
   payload: the transaction with `SigningPubKey` set to `""` and the `Signers` and `TxnSignature`
   fields removed. `Signers` MUST contain 1–32 entries, sorted by `Account` ascending, with no
   duplicate accounts, and MUST NOT include the payer account itself. For each `Signers[i].Signer`:
   - its `Account` MUST be a `SignerEntry` on the payer's `SignerList`; otherwise verification MUST
     fail;
   - its `TxnSignature` MUST verify over `encodeForMultisigning(payload, Signer.Account)` using the
     entry's `SigningPubKey` — a canonical public key with a fully-canonical signature;
   - the `SigningPubKey` MUST be authorized for `Signer.Account`. The signer's account **need not
     exist** on the ledger: if it does not exist, the `SigningPubKey` MUST derive to `Signer.Account`
     (its implicit master key); if it exists, the key MUST be its `RegularKey`, or its master key
     unless `lsfDisableMaster` is set. Unlike `checkSingleSign` (post `fixMasterKeyAsRegularKey`),
     `checkMultiSign` does not treat a `RegularKey` equal to the account as a master-key substitute:
     a signer's own master key is refused when that account has `lsfDisableMaster`.
4. **Quorum.** Sum `SignerEntry.SignerWeight` over the distinct, verified signers. The total MUST be
   greater than or equal to the account's `SignerQuorum`; otherwise verification MUST fail. The
   facilitator MUST sum weights against the quorum rather than count signatures, so a set of valid
   but insufficient signatures is rejected.

A single-signed transaction (no `Signers`) is validated exactly as above with the account's own
signing key. The `PaymentPayload` is unchanged: `payload.signedTxBlob` already carries `Signers` and
the empty top-level `SigningPubKey`.

`simulate` (§11) is complementary, not a substitute: simulation does not check signatures, so the
offline `SignerList`/quorum verification above remains REQUIRED.

**Example** — the decoded transaction of a 2-of-N multisigned payment (hex truncated):

```json
{
  "TransactionType": "Payment",
  "Account": "rPayerEngagementAccount...",
  "Destination": "rMerchant...",
  "Amount": "1000",
  "InvoiceID": "A6C1...E11",
  "SigningPubKey": "",
  "Signers": [
    { "Signer": { "Account": "rAgent...",    "SigningPubKey": "ED75...", "TxnSignature": "BCF9..." } },
    { "Signer": { "Account": "rCoSigner...", "SigningPubKey": "EDA0...", "TxnSignature": "0238..." } }
  ]
}
```

The signer accounts (`rAgent…`, `rCoSigner…`) need not be funded or exist on the ledger; each
`SigningPubKey` deriving to its `Signer.Account` is sufficient (step 3).

Suggested rejection identifiers (the scheme currently defines only `duplicate_settlement`, so these
are proposed, not existing): `multisig_signer_not_authorized`, `multisig_quorum_not_met`,
`multisig_signature_invalid`, `multisig_account_not_found`.

---

## Insertion B → new item under **§9 Safety Checks (MUST)**

- **Unverified multisig.** A transaction carrying a non-empty `Signers` array that the facilitator
  does not verify as in §10.1 MUST be rejected. A facilitator that has not implemented multisig
  verification MUST reject `Signers` and MUST NOT return a `valid` result for such a transaction.

---

## Insertion C → new subsection under **Security Considerations**

### Multisig Authorization Scope

Multisig authorization is read from the payer's `SignerList` at a validated ledger, exactly as
single-signer authorization is read from the account's master-key / `RegularKey` state. A
`SignerList` can change between `/verify` and `/settle` — the same race that already exists for a
`RegularKey` — so `/settle` MUST re-run verification, and the validated ledger remains the final
arbiter. Facilitators MUST reject signer accounts that are absent from the `SignerList` and duplicate
signer entries, and MUST compare summed `SignerWeight` against `SignerQuorum` rather than counting
signatures, so that a below-quorum set of otherwise-valid signatures does not verify.

---

## Conformance (for the PR description, not necessarily the spec)

Negative cases a conforming `/verify` MUST reject, offered as vectors: below quorum; a signer not on
the `SignerList`; a transaction tampered after signing; and (for single-sig) a tampered or
unauthorized-key transaction. A reference verifier and a re-runnable Testnet probe exercising these
are available (`x402-xrpl-settlement-adapter`, `./exact` → `verifyExactPayload`).
