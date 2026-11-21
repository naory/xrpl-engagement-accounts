// Co-signer decisions against the three-memo RLUSD payment, with a mocked facilitator.
// No network. The first half of the fail-then-pass must not call fetch.
import { describe, expect, it } from "vitest";
import { localSigner, signVendorInvoice } from "@eng/core";
import { CosignerService, FixtureLedgerSource } from "@eng/cosigner";
import { EngagementAgent } from "../../../agent-mcp/src/agent.ts";
import {
  LEDGER_INDEX, W, b1Challenge, b1Engagement, b1Ledger, b1Mandate, policies, templates,
} from "../../../policy/test/fixtures.ts";
import { T54_RLUSD_ISSUER } from "./facilitator.ts";
import { createMerchant } from "./merchant.ts";
import { buildT54Payment } from "./t54-payment.ts";

const ENG = "eng_b1_fixture";

async function service() {
  const svc = new CosignerService({
    signer: localSigner(W.cosigner),
    source: new FixtureLedgerSource(b1Ledger({ balance: "5000" })),
    templates: [templates.procurement, templates.hotel],
    policies: [policies.baseline, policies.procurement],
  });
  const engagement = b1Engagement();
  engagement.trust = { ...engagement.trust, "rlusd.issuer": T54_RLUSD_ISSUER };
  await svc.register(engagement, b1Mandate());
  return svc;
}

function agentFor(svc: CosignerService) {
  return new EngagementAgent({
    engagementId: ENG, account: W.engB1.address, signer: localSigner(W.agent),
    asset: { code: "RLUSD", currency: "524C555344000000000000000000000000000000", issuer: T54_RLUSD_ISSUER },
    decider: svc, stage: "spend", ttlLedgers: 20,
  });
}

function payment(amount: string, invoiceId: string, destination = W.vendorA.address, lls = LEDGER_INDEX + 20) {
  return buildT54Payment({
    account: W.engB1.address, destination, amount, invoiceId, sequence: 21, fee: "36",
    lastLedgerSequence: lls, openLedger: LEDGER_INDEX,
  });
}

function invoice(amount: string, invoiceRef: string, vendor = W.vendorA) {
  return signVendorInvoice({
    engagementId: ENG, vendorAddress: vendor.address, amount, invoiceRef,
    observedAt: "2026-11-18T09:00:00Z", issuedAt: "2026-11-18T09:00:01Z", nonce: invoiceRef, po: "PO-T54",
  }, vendor);
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", "x-request-id": "mock" } });
}

describe("t54 exact path", () => {
  it("refuses an over-cap payment before the facilitator, then settles an in-cap one", async () => {
    const svc = await service();
    const agent = agentFor(svc);
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/verify")) return jsonResponse({ isValid: true, invalidReason: null, payer: W.engB1.address });
      return jsonResponse({ success: true, transaction: "AABB", network: "xrpl:1", payer: W.engB1.address, errorReason: null });
    };
    const merchant = createMerchant({
      resource: "https://vendor.example/data", network: "xrpl:1", payTo: W.vendorA.address,
      price: { amount: "1.00", asset: { kind: "IOU", currency: "524C555344000000000000000000000000000000", issuer: T54_RLUSD_ISSUER } },
      fetchTransaction: async () => null, deliver: () => ({ ok: true }),
      exact: { asset: "524C555344000000000000000000000000000000", issuer: T54_RLUSD_ISSUER, fetchImpl },
    });

    const over = await agent.proposePayment({
      destination: W.vendorA.address, amount: "1500.00", invoiceRef: "inv-over",
      tx: payment("1500.00", "inv-over"),
      statements: [invoice("1500.00", "inv-over"), b1Challenge({ invoiceId: "inv-over", amount: "1500.00" })],
    });
    expect(over.decision.decision).toBe("REFUSE");
    expect(over.decision.failing).toContain("W5");
    expect(over.combined).toBeUndefined();
    expect(calls).toEqual([]);

    const ok = await agent.proposePayment({
      destination: W.vendorA.address, amount: "1.00", invoiceRef: "inv-ok",
      tx: payment("1.00", "inv-ok"),
      statements: [invoice("1.00", "inv-ok"), b1Challenge({ invoiceId: "inv-ok", amount: "1.00" })],
    });
    expect(ok.decision.decision).toBe("SIGN");
    expect(ok.decision.failing).toEqual([]);
    expect(ok.decision.results.find((r) => r.id === "B8")!.result).toBe("pass");
    expect(ok.decision.results.find((r) => r.id === "W6")!.result).toBe("pass");
    expect(ok.combined).toBeTruthy();
    const settled = await merchant.settlePresigned({ signedTxBlob: ok.combined!, invoiceId: "inv-ok" });
    expect(settled.accepted).toBe(true);
    expect(settled.transaction).toBe("AABB");
    expect(calls.map((u) => u.endsWith("/verify") ? "verify" : "settle")).toEqual(["verify", "settle"]);
  });

  it("refuses a redirected destination and does not call the facilitator", async () => {
    const svc = await service();
    const agent = agentFor(svc);
    let called = false;
    const fetchImpl: typeof fetch = async () => { called = true; return jsonResponse({}); };
    const merchant = createMerchant({
      resource: "r", network: "xrpl:1", payTo: W.vendorA.address,
      price: { amount: "1.00", asset: { kind: "IOU", currency: "524C555344000000000000000000000000000000", issuer: T54_RLUSD_ISSUER } },
      fetchTransaction: async () => null, deliver: () => ({}),
      exact: { asset: "524C555344000000000000000000000000000000", issuer: T54_RLUSD_ISSUER, fetchImpl },
    });
    const proposal = await agent.proposePayment({
      destination: W.vendorB.address, amount: "1.00", invoiceRef: "inv-redirect",
      tx: payment("1.00", "inv-redirect", W.vendorB.address),
      statements: [invoice("1.00", "inv-redirect", W.vendorB), b1Challenge({ invoiceId: "inv-redirect", amount: "1.00", payTo: W.vendorA.address })],
    });
    expect(proposal.decision.decision).toBe("REFUSE");
    expect(proposal.decision.failing).toContain("W7");
    expect(proposal.combined).toBeUndefined();
    expect(called).toBe(false);
    expect(merchant).toBeTruthy();
  });

  it("asks the facilitator about an already-expired blob and does not settle when verify is invalid", async () => {
    const svc = await service();
    const agent = agentFor(svc);
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return jsonResponse({ isValid: false, invalidReason: "missing_last_ledger_sequence", payer: W.engB1.address });
    };
    const merchant = createMerchant({
      resource: "r", network: "xrpl:1", payTo: W.vendorA.address,
      price: { amount: "1.00", asset: { kind: "IOU", currency: "524C555344000000000000000000000000000000", issuer: T54_RLUSD_ISSUER } },
      fetchTransaction: async () => null, deliver: () => ({}),
      exact: { asset: "524C555344000000000000000000000000000000", issuer: T54_RLUSD_ISSUER, fetchImpl },
    });
    const proposal = await agent.proposePayment({
      destination: W.vendorA.address, amount: "1.00", invoiceRef: "inv-old",
      tx: payment("1.00", "inv-old", W.vendorA.address, LEDGER_INDEX - 1),
      statements: [invoice("1.00", "inv-old"), b1Challenge({ invoiceId: "inv-old", amount: "1.00" })],
    });
    expect(proposal.decision.decision).toBe("SIGN");
    const settled = await merchant.settlePresigned({ signedTxBlob: proposal.combined!, invoiceId: "inv-old" });
    expect(settled.accepted).toBe(false);
    expect(settled.settle).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/\/verify$/);
  });
});
