// Client for t54's hosted XRPL facilitator (/verify and /settle).
// The body is the presigned exact envelope exercised against Testnet.
// This module never logs the request, the response, or a signed blob.

export const DEFAULT_FACILITATOR_URL = "https://xrpl-facilitator-testnet.t54.ai";

export const T54_RLUSD_CURRENCY = "524C555344000000000000000000000000000000";
export const T54_RLUSD_ISSUER = "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV";
export const T54_SOURCE_TAG = 804681468;

export interface T54Requirements {
  scheme: "exact";
  network: "xrpl:1";
  asset: string;
  payTo: string;
  amount: string;
  maxTimeoutSeconds: number;
  extra: { sourceTag: number; issuer: string; invoiceId: string };
}

export interface FacilitatorResult {
  status: number;
  body: unknown;
  requestId: string | null;
}

export function t54Requirements(o: {
  payTo: string;
  amount: string;
  invoiceId: string;
  asset?: string;
  issuer?: string;
  sourceTag?: number;
}): T54Requirements {
  return {
    scheme: "exact",
    network: "xrpl:1",
    asset: o.asset ?? T54_RLUSD_CURRENCY,
    payTo: o.payTo,
    amount: o.amount,
    maxTimeoutSeconds: 60,
    extra: {
      sourceTag: o.sourceTag ?? T54_SOURCE_TAG,
      issuer: o.issuer ?? T54_RLUSD_ISSUER,
      invoiceId: o.invoiceId,
    },
  };
}

export function t54Envelope(o: { requirements: T54Requirements; signedTxBlob: string; invoiceId: string }) {
  return {
    paymentPayload: {
      x402Version: 2 as const,
      accepted: o.requirements,
      payload: { signedTxBlob: o.signedTxBlob, invoiceId: o.invoiceId },
    },
    paymentRequirements: o.requirements,
  };
}

export function createFacilitatorClient(opts?: { url?: string; fetchImpl?: typeof fetch }) {
  const base = (opts?.url ?? DEFAULT_FACILITATOR_URL).replace(/\/+$/, "");
  const doFetch = opts?.fetchImpl ?? fetch;
  async function post(path: "/verify" | "/settle", body: unknown): Promise<FacilitatorResult> {
    const res = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* non-JSON body is returned as text */ }
    return { status: res.status, body: parsed, requestId: res.headers.get("x-request-id") };
  }
  return {
    url: base,
    verify: (body: unknown) => post("/verify", body),
    settle: (body: unknown) => post("/settle", body),
  };
}
