import { describe, expect, it } from "vitest";
import {
  DEFAULT_FACILITATOR_URL, T54_RLUSD_CURRENCY, T54_RLUSD_ISSUER, T54_SOURCE_TAG,
  createFacilitatorClient, t54Envelope, t54Requirements,
} from "./facilitator.ts";

function jsonResponse(body: unknown, status = 200, requestId = "req-1") {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": requestId } });
}

describe("t54 facilitator client", () => {
  it("posts the documented envelope to the default Testnet URL", async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      const path = String(input);
      if (path.endsWith("/verify")) return jsonResponse({ isValid: true, invalidReason: null, payer: "rPayer" }, 200, "verify-id");
      return jsonResponse({ success: true, transaction: "AB", network: "xrpl:1", payer: "rPayer", errorReason: null }, 200, "settle-id");
    };
    const client = createFacilitatorClient({ fetchImpl });
    expect(client.url).toBe(DEFAULT_FACILITATOR_URL);
    const requirements = t54Requirements({ payTo: "rMerchant", amount: "1.00", invoiceId: "inv-1" });
    expect(requirements.asset).toBe(T54_RLUSD_CURRENCY);
    expect(requirements.extra).toEqual({ sourceTag: T54_SOURCE_TAG, issuer: T54_RLUSD_ISSUER, invoiceId: "inv-1" });
    expect(requirements.extra).not.toHaveProperty("areFeesSponsored");
    const envelope = t54Envelope({ requirements, signedTxBlob: "BLOB", invoiceId: "inv-1" });
    const verify = await client.verify(envelope);
    const settle = await client.settle(envelope);
    expect(verify).toEqual({ status: 200, body: { isValid: true, invalidReason: null, payer: "rPayer" }, requestId: "verify-id" });
    expect(settle.requestId).toBe("settle-id");
    expect(seen.map((s) => s.url)).toEqual([
      `${DEFAULT_FACILITATOR_URL}/verify`,
      `${DEFAULT_FACILITATOR_URL}/settle`,
    ]);
    expect(seen[0].body).toEqual(envelope);
  });

  it("returns the HTTP status and body when verify is not valid", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ isValid: false, invalidReason: "unsupported_payment_features" }, 200, "nope");
    const client = createFacilitatorClient({ url: "https://facilitator.example/base/", fetchImpl });
    const result = await client.verify({ paymentPayload: {}, paymentRequirements: {} });
    expect(client.url).toBe("https://facilitator.example/base");
    expect(result.status).toBe(200);
    expect(result.requestId).toBe("nope");
    expect(result.body).toEqual({ isValid: false, invalidReason: "unsupported_payment_features" });
  });
});
