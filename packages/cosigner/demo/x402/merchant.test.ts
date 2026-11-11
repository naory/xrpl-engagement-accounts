// End-to-end x402 purchase from an engagement account, in process, ledger mocked:
//   merchant 402 → agent builds payment → co-signer checks W7 and co-signs →
//   (settles) → merchant verifies the validated transaction → resource delivered.
// Real co-signer decisions and real adapter verification; only ledger I/O is faked.
import { describe, expect, it } from "vitest";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  type PaymentPayload,
  type XrplPaymentTransaction,
} from "x402-xrpl-settlement-adapter";
import { CosignerService, FixtureLedgerSource, memo } from "@eng/cosigner";
import { localSigner } from "@eng/core";
import { createMerchant } from "./merchant.ts";
import {
  RLUSD_HEX, W, b1Challenge, b1Engagement, b1Invoice, b1Ledger, b1Mandate, b1Payment, policies, templates,
} from "../../../policy/test/fixtures.ts";

const NETWORK = "xrpl:1";
const INVOICE = "inv:x402-demo-1";
const PRICE = { amount: "800.00", asset: { kind: "IOU" as const, currency: RLUSD_HEX, issuer: W.issuer.address } };

function cosigner(ledger = b1Ledger()) {
  const svc = new CosignerService({
    signer: localSigner(W.cosigner),
    source: new FixtureLedgerSource(ledger),
    templates: [templates.procurement, templates.hotel],
    policies: [policies.baseline, policies.procurement],
  });
  svc.register(b1Engagement(), b1Mandate());
  return svc;
}

/** The agent's engagement-account Payment: vendor payment + engagement memos + the merchant's x402 memo. */
function agentPayment(merchantMemo: ReturnType<ReturnType<typeof createMerchant>["memoFor"]>, over: { to?: string; value?: string } = {}) {
  const tx = b1Payment(over.to ?? W.vendorA.address, over.value ?? "800", { invoice: INVOICE });
  ;(tx.Memos as unknown[]).push(merchantMemo);
  return tx;
}

/** Build the validated-transaction view a merchant's `fetchTransaction` would return. */
function settled(tx: Record<string, unknown>, over: Partial<XrplPaymentTransaction> = {}): XrplPaymentTransaction {
  return {
    validated: true,
    TransactionType: "Payment",
    Account: W.engB1.address,
    Destination: String(tx.Destination),
    Amount: tx.Amount as XrplPaymentTransaction["Amount"],
    Memos: tx.Memos as XrplPaymentTransaction["Memos"],
    meta: { TransactionResult: "tesSUCCESS", delivered_amount: tx.Amount as XrplPaymentTransaction["Amount"] },
    ...over,
  };
}

function paymentSignatureHeader(paymentRequiredHeader: string, txHash: string): string {
  const required = decodePaymentRequiredHeader(paymentRequiredHeader);
  const payload: PaymentPayload = { x402Version: 2, accepted: required.accepts[0], payload: { txHash } };
  return encodePaymentSignatureHeader(payload);
}

describe("x402 engagement-account purchase (prepaid scheme)", () => {
  it("runs the full chain: 402 → co-sign (W7) → verify → deliver", async () => {
    const svc = cosigner();
    const txByHash: Record<string, XrplPaymentTransaction> = {};
    const merchant = createMerchant({
      resource: "https://vendor.example/data",
      network: NETWORK,
      payTo: W.vendorA.address,
      price: PRICE,
      fetchTransaction: async (_n, h) => txByHash[h] ?? null,
      deliver: () => ({ report: "the paid bytes" }),
      newInvoiceId: () => INVOICE,
    });

    // 1. Merchant issues the 402 challenge.
    const challenge = merchant.challenge();
    expect(challenge.status).toBe(402);
    expect(challenge.invoiceId).toBe(INVOICE);

    // 2. Agent builds the payment (bound to the challenge) and declares it to the co-signer.
    const tx = agentPayment(challenge.requiredMemo);
    const d = await svc.decide({
      engagementId: "eng_b1_fixture",
      stage: "spend",
      tx,
      statements: [b1Invoice(W.vendorA, "800.00", INVOICE), b1Challenge({ invoiceId: INVOICE })],
    });
    expect(d.failing).toEqual([]);
    expect(d.decision).toBe("SIGN");
    expect(d.results.find((r) => r.id === "W7")!.result).toBe("pass");
    expect(d.signerBlob).toBeDefined(); // the co-signer's multisig signature

    // 3. The agent combines signatures and submits (mocked); the ledger validates it.
    const txHash = "E2E0000000000000000000000000000000000000000000000000000000000001";
    txByHash[txHash] = settled(tx);

    // 4. Agent retries the merchant with the receipt.
    const res = await merchant.handle(paymentSignatureHeader(challenge.paymentRequiredHeader, txHash));
    expect(res.status).toBe(200);
    if (res.status !== 200) throw new Error(res.error);
    expect(res.response.success).toBe(true);
    expect(res.response.payer).toBe(W.engB1.address);
    expect(res.body).toEqual({ report: "the paid bytes" });

    // 5. Replaying the same receipt is idempotent and does not re-deliver.
    const again = await merchant.handle(paymentSignatureHeader(challenge.paymentRequiredHeader, txHash));
    expect(again.status).toBe(200);
    if (again.status === 200) {
      expect(again.idempotent).toBe(true);
      expect(again.body).toBeUndefined();
    }
  });

  it("co-signer refuses (W7) when the payment does not match the declared challenge", async () => {
    const svc = cosigner();
    const merchant = createMerchant({ resource: "r", network: NETWORK, payTo: W.vendorA.address, price: PRICE, fetchTransaction: async () => null, deliver: () => ({}), newInvoiceId: () => INVOICE });
    const tx = agentPayment(merchant.memoFor(INVOICE));
    // The agent declares an x402 challenge naming a different merchant than the payee.
    const d = await svc.decide({
      engagementId: "eng_b1_fixture",
      stage: "spend",
      tx,
      statements: [b1Invoice(W.vendorA, "800.00", INVOICE), b1Challenge({ invoiceId: INVOICE, payTo: W.vendorB.address })],
    });
    expect(d.decision).toBe("REFUSE");
    expect(d.failing).toContain("W7");
    expect(d.signerBlob).toBeUndefined();
  });

  it("merchant rejects a settled payment whose amount does not match (502)", async () => {
    const merchant = createMerchant({ resource: "r", network: NETWORK, payTo: W.vendorA.address, price: PRICE, fetchTransaction: async (_n, h) => wrong[h] ?? null, deliver: () => ({}), newInvoiceId: () => INVOICE });
    const challenge = merchant.challenge();
    const tx = agentPayment(challenge.requiredMemo, { value: "700" });
    const txHash = "BAD0000000000000000000000000000000000000000000000000000000000002";
    const wrong: Record<string, XrplPaymentTransaction> = {
      [txHash]: settled(tx, { Amount: { currency: RLUSD_HEX, issuer: W.issuer.address, value: "700" }, meta: { TransactionResult: "tesSUCCESS", delivered_amount: { currency: RLUSD_HEX, issuer: W.issuer.address, value: "700" } } }),
    };
    const res = await merchant.handle(paymentSignatureHeader(challenge.paymentRequiredHeader, txHash));
    expect(res.status).toBe(502);
    if (res.status === 502) expect(res.code).toBe("invalid_amount");
  });

  it("merchant rejects an invoiceId it never issued", async () => {
    const merchant = createMerchant({ resource: "r", network: NETWORK, payTo: W.vendorA.address, price: PRICE, fetchTransaction: async () => null, deliver: () => ({}), newInvoiceId: () => INVOICE });
    // Build a PAYMENT-SIGNATURE for an invoice the merchant did not mint (no challenge() call).
    const forged = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: { scheme: "prepaid", network: NETWORK, amount: "800", asset: RLUSD_HEX, payTo: W.vendorA.address, maxTimeoutSeconds: 120, extra: { invoiceId: "inv:forged" } },
      payload: { txHash: "F00" },
    });
    const res = await merchant.handle(forged);
    expect(res.status).toBe(402);
    if (res.status === 402) expect(res.error).toMatch(/unknown or expired/);
  });
});
