// End-to-end MPP purchase from an engagement account, in process, ledger mocked:
//   merchant 402 (WWW-Authenticate: Payment) → agent builds the engagement Payment
//   with the XRPL InvoiceID bound to the MPP invoiceId → co-signer checks W7
//   (scheme "mpp") and co-signs → (agent submits) → merchant confirms the
//   validated transaction by hash + InvoiceID → resource delivered.
// Real co-signer decisions and real adapter verification (push → confirmExactSettlement);
// only ledger I/O is faked.
import { describe, expect, it } from "vitest";
import type { XrplPaymentTransaction } from "x402-xrpl-settlement-adapter";
import { invoiceIdToField } from "x402-xrpl-settlement-adapter/exact";
import { CosignerService, FixtureLedgerSource } from "@eng/cosigner";
import { createMppMerchant } from "./merchant.ts";
import {
  RLUSD_HEX, W, b1Challenge, b1Engagement, b1Invoice, b1Ledger, b1Mandate, b1Payment, policies, templates,
} from "../../../policy/test/fixtures.ts";

const NETWORK = "xrpl:1";
const INVOICE = "inv:mpp-demo-1";
const PRICE = { amount: "800.00", asset: { kind: "IOU" as const, currency: RLUSD_HEX, issuer: W.issuer.address } };

function cosigner(ledger = b1Ledger()) {
  const svc = new CosignerService({
    wallet: W.cosigner,
    source: new FixtureLedgerSource(ledger),
    templates: [templates.procurement, templates.hotel],
    policies: [policies.baseline, policies.procurement],
  });
  svc.register(b1Engagement(), b1Mandate());
  return svc;
}

/** The agent's engagement Payment: vendor payment + engagement memos + the XRPL InvoiceID binding. */
function agentPayment(invoiceId: string, over: { to?: string; value?: string } = {}) {
  const tx = b1Payment(over.to ?? W.vendorA.address, over.value ?? "800", { invoice: INVOICE });
  tx.InvoiceID = invoiceIdToField(invoiceId); // MPP push binds on the signature-covered InvoiceID field
  return tx;
}

/** Build the validated-transaction view the merchant's `fetchTransaction` would return. */
function settled(tx: Record<string, unknown>, over: Record<string, unknown> = {}): XrplPaymentTransaction {
  return {
    validated: true,
    TransactionType: "Payment",
    Account: W.engB1.address,
    Destination: String(tx.Destination),
    Amount: tx.Amount as XrplPaymentTransaction["Amount"],
    InvoiceID: tx.InvoiceID as string,
    Memos: tx.Memos as XrplPaymentTransaction["Memos"],
    meta: { TransactionResult: "tesSUCCESS", delivered_amount: tx.Amount as XrplPaymentTransaction["Amount"] },
    ...over,
  } as XrplPaymentTransaction;
}

/** The MPP push credential header the agent sends back: Authorization: Payment <base64url JSON>. */
function authHeader(challengeToken: string, hash: string, source?: string): string {
  const cred = { challenge: challengeToken, payload: { type: "hash", hash }, ...(source ? { source } : {}) };
  return `Payment ${Buffer.from(JSON.stringify(cred), "utf8").toString("base64url")}`;
}

describe("MPP engagement-account purchase (XRPL charge, push mode)", () => {
  it("runs the full chain: 402 → co-sign (W7, scheme mpp) → confirm by hash → deliver", async () => {
    const svc = cosigner();
    const txByHash: Record<string, XrplPaymentTransaction> = {};
    const merchant = createMppMerchant({
      resource: "https://vendor.example/data",
      network: NETWORK,
      recipient: W.vendorA.address,
      price: PRICE,
      fetchTransaction: async (_n, h) => txByHash[h] ?? null,
      deliver: () => ({ report: "the paid bytes" }),
      newInvoiceId: () => INVOICE,
    });

    // 1. Merchant issues the 402 WWW-Authenticate: Payment challenge.
    const challenge = merchant.challenge();
    expect(challenge.status).toBe(402);
    expect(challenge.invoiceId).toBe(INVOICE);
    expect(challenge.wwwAuthenticate).toMatch(/^Payment .*method="xrpl".*intent="charge"/);
    expect(challenge.invoiceIdField).toBe(invoiceIdToField(INVOICE));

    // 2. Agent builds the payment (InvoiceID bound to the challenge) and declares it to the co-signer.
    const tx = agentPayment(challenge.invoiceId);
    expect(tx.InvoiceID).toBe(challenge.invoiceIdField);
    const d = await svc.decide({
      engagementId: "eng_b1_fixture",
      stage: "spend",
      tx,
      statements: [b1Invoice(W.vendorA, "800.00", INVOICE), b1Challenge({ invoiceId: INVOICE, scheme: "mpp" })],
    });
    expect(d.failing).toEqual([]);
    expect(d.decision).toBe("SIGN");
    expect(d.results.find((r) => r.id === "W7")!.result).toBe("pass");
    expect(d.signerBlob).toBeDefined(); // the co-signer's multisig signature

    // 3. The agent combines signatures and submits (mocked); the ledger validates it.
    const txHash = "E2E0000000000000000000000000000000000000000000000000000000000AA1";
    txByHash[txHash] = settled(tx);

    // 4. Agent retries with the MPP push credential (the validated tx hash).
    const res = await merchant.handle(authHeader(challenge.challengeToken, txHash, W.engB1.address));
    expect(res.status).toBe(200);
    if (res.status !== 200) throw new Error(res.error);
    expect(res.receipt.method).toBe("xrpl");
    expect(res.receipt.reference).toBe(txHash);
    expect(res.payer).toBe(W.engB1.address);
    expect(res.body).toEqual({ report: "the paid bytes" });

    // 5. Replaying the same credential is idempotent and does not re-deliver.
    const again = await merchant.handle(authHeader(challenge.challengeToken, txHash, W.engB1.address));
    expect(again.status).toBe(200);
    if (again.status === 200) {
      expect(again.idempotent).toBe(true);
      expect(again.body).toBeUndefined();
    }
  });

  it("co-signer refuses (W7) when the payment does not match the declared mpp challenge", async () => {
    const svc = cosigner();
    const tx = agentPayment(INVOICE);
    // The agent declares an mpp challenge naming a different payee than the payment.
    const d = await svc.decide({
      engagementId: "eng_b1_fixture",
      stage: "spend",
      tx,
      statements: [b1Invoice(W.vendorA, "800.00", INVOICE), b1Challenge({ invoiceId: INVOICE, scheme: "mpp", payTo: W.vendorB.address })],
    });
    expect(d.decision).toBe("REFUSE");
    expect(d.failing).toContain("W7");
    expect(d.signerBlob).toBeUndefined();
  });

  it("merchant rejects a settled payment whose amount does not match (502)", async () => {
    const txHash = "BAD0000000000000000000000000000000000000000000000000000000000AA2";
    const wrong: Record<string, XrplPaymentTransaction> = {};
    const merchant = createMppMerchant({
      resource: "r", network: NETWORK, recipient: W.vendorA.address, price: PRICE,
      fetchTransaction: async (_n, h) => wrong[h] ?? null, deliver: () => ({}), newInvoiceId: () => INVOICE,
    });
    const challenge = merchant.challenge();
    const tx = agentPayment(challenge.invoiceId, { value: "700" });
    wrong[txHash] = settled(tx, {
      Amount: { currency: RLUSD_HEX, issuer: W.issuer.address, value: "700" },
      meta: { TransactionResult: "tesSUCCESS", delivered_amount: { currency: RLUSD_HEX, issuer: W.issuer.address, value: "700" } },
    });
    const res = await merchant.handle(authHeader(challenge.challengeToken, txHash));
    expect(res.status).toBe(502);
    if (res.status === 502) expect(res.code).toBe("amount_mismatch");
  });

  it("merchant rejects a payment whose InvoiceID does not bind to the invoice (502)", async () => {
    const txHash = "BAD0000000000000000000000000000000000000000000000000000000000AA3";
    const wrong: Record<string, XrplPaymentTransaction> = {};
    const merchant = createMppMerchant({
      resource: "r", network: NETWORK, recipient: W.vendorA.address, price: PRICE,
      fetchTransaction: async (_n, h) => wrong[h] ?? null, deliver: () => ({}), newInvoiceId: () => INVOICE,
    });
    const challenge = merchant.challenge();
    const tx = agentPayment("inv:some-other-invoice"); // bound to the wrong invoice id
    wrong[txHash] = settled(tx);
    const res = await merchant.handle(authHeader(challenge.challengeToken, txHash));
    expect(res.status).toBe(502);
    if (res.status === 502) expect(res.code).toBe("invoice_mismatch");
  });

  it("merchant rejects a tampered or forged challenge token (401)", async () => {
    const merchant = createMppMerchant({
      resource: "r", network: NETWORK, recipient: W.vendorA.address, price: PRICE,
      fetchTransaction: async () => null, deliver: () => ({}), newInvoiceId: () => INVOICE,
    });
    // A challenge token the merchant never minted (forged by the client).
    const forged = Buffer.from(JSON.stringify({ body: { v: 1, id: "x", invoiceId: "inv:forged", exp: 9_999_999_999, amount: "800.00", currency: RLUSD_HEX, recipient: W.vendorA.address, resource: "r" }, sig: "00" }), "utf8").toString("base64url");
    const res = await merchant.handle(authHeader(forged, "F00"));
    expect(res.status).toBe(401);
    if (res.status === 401) expect(res.code).toBe("challenge_rejected");
  });
});
