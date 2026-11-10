// A minimal MPP (Machine Payments Protocol) merchant for the engagement-account
// demo, for the XRPL **charge** method in **push** mode.
//
// Why this exists instead of importing the reference `xrpl-mpp-sdk` server:
// that package peers on `xrpl >=4 <5` (and `mppx`), while this repo is on
// `xrpl@5`, so it cannot go into the tree without a broken resolution. Per
// docs/research/mpp.md §6 the engagement-specific work for MPP is only the
// co-signer binding (shipped as `payment.challenge/1`, scheme `mpp`);
// *settlement* is "read the validated transaction by hash + InvoiceID binding",
// which the published `x402-xrpl-settlement-adapter` already does via
// `confirmExactSettlement`. So this merchant speaks the MPP wire format (pinned
// in §1.2 and verified against `xrpl-mpp-sdk@0.1.0-beta.4`) and bridges push
// settlement to that verifier — the "thin bridge" §6 left open.
//
// The engagement payment is multisigned (co-signed by the policy co-signer).
// Push mode makes multisig moot here: the ledger enforced the SignerList and
// quorum before the hash existed, and the merchant only reads the validated
// transaction. Unlike the x402 `exact` scheme, `confirmExactSettlement` does
// not forbid memos, so the payment keeps `eng/basis` (B8) and `eng/invoice`
// (W6) **and** carries the XRPL `InvoiceID` binding.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  canonicalNetwork,
  createChallenge,
  toPaymentRequirements,
  InMemoryReplayStore,
  SCHEME_EXACT,
  type ChallengeAsset,
  type FetchTransaction,
  type PaymentRequirements,
  type ReplayStore,
} from "x402-xrpl-settlement-adapter";
import { confirmExactSettlement, invoiceIdToField } from "x402-xrpl-settlement-adapter/exact";

export interface MppMerchantConfig {
  /** The resource id/URL being sold. */
  resource: string;
  /** CAIP-2 network, e.g. "xrpl:1" (testnet). */
  network: string;
  /** Merchant (recipient) classic address. */
  recipient: string;
  /** Price the merchant charges (amount is token units for IOU / drops for XRP). */
  price: { amount: string; asset: ChallengeAsset };
  /** Authentication realm advertised in the 402 (default "mpp"). */
  realm?: string;
  /** Secret the merchant HMACs its challenge token with (demo default: random). */
  challengeSecret?: string;
  /** How long a challenge is valid, seconds (default 120). */
  maxTimeoutSeconds?: number;
  /** Reads a validated transaction by hash (e.g. via `fromRippledTx` over a `tx` call). */
  fetchTransaction: FetchTransaction;
  /** Produces the paid resource body once settlement is confirmed. */
  deliver: (ctx: { invoiceId: string; payer?: string; txHash: string }) => unknown;
  /** Shared across requests; defaults to an in-memory store. */
  replayStore?: ReplayStore;
  /** Clock, for tests. */
  now?: () => Date;
  /** Mints a unique invoice id per challenge (default: random). */
  newInvoiceId?: () => string;
}

/** MPP XRPL charge `request` object (base64url-JCS in `WWW-Authenticate: Payment`). */
export interface MppChargeRequest {
  amount: string;
  currency: string;
  recipient: string;
  description?: string;
  methodDetails: { invoiceId: string; network: string };
}

export interface MppChallenge {
  status: 402;
  /** Value for the `WWW-Authenticate` response header. */
  wwwAuthenticate: string;
  /** The invoice id the client must bind its payment to. */
  invoiceId: string;
  /** The XRPL `InvoiceID` field the client must set on its Payment (= SHA-256(invoiceId)). */
  invoiceIdField: string;
  /** The HMAC-bound challenge token the client echoes back in its credential. */
  challengeToken: string;
  /** The decoded charge request, for convenience. */
  request: MppChargeRequest;
}

/** MPP push credential: `Authorization: Payment <base64url JSON>`. */
export interface MppCredential {
  challenge: string;
  payload: { type: "hash"; hash: string } | { type: "transaction"; blob: string };
  source?: string;
}

export type MppResult =
  | { status: 200; paymentReceiptHeader: string; receipt: MppReceipt; body: unknown; idempotent: boolean; payer?: string }
  | { status: 401 | 402 | 502; error: string; code?: string };

export interface MppReceipt {
  method: "xrpl";
  status: "success";
  timestamp: string;
  /** The settling transaction hash. */
  reference: string;
}

// ── base64url-JCS envelope (IETF draft-ryan-httpauth-payment core scheme) ──
// JCS (RFC 8785): object keys sorted by code unit, no insignificant whitespace.
// Our values are strings / integers / nested objects, so sorted-key JSON is JCS.
function jcs(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs((value as Record<string, unknown>)[k])}`).join(",")}}`;
}
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64url = (s: string) => Buffer.from(s, "base64url").toString("utf8");
const encode = (value: unknown) => b64url(jcs(value));
const decode = <T>(s: string): T => JSON.parse(unb64url(s)) as T;

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

interface ChallengeBody {
  v: 1;
  id: string;
  invoiceId: string;
  exp: number; // epoch seconds
  amount: string;
  currency: string;
  recipient: string;
  resource: string;
}

export function createMppMerchant(cfg: MppMerchantConfig) {
  const replayStore = cfg.replayStore ?? new InMemoryReplayStore();
  const maxTimeoutSeconds = cfg.maxTimeoutSeconds ?? 120;
  const realm = cfg.realm ?? "mpp";
  const secret = cfg.challengeSecret ?? createHash("sha256").update(`${Math.random()}:${Date.now()}`).digest("hex");
  const now = cfg.now ?? (() => new Date());
  const newInvoiceId = cfg.newInvoiceId ?? (() => `inv-${now().getTime().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const currencyCode = cfg.price.asset.kind === "IOU" ? cfg.price.asset.currency : "XRP";

  const sign = (body: ChallengeBody) => createHmac("sha256", secret).update(jcs(body)).digest("hex");
  /** The HMAC-bound token the client echoes; mppx rejects a tampered/expired one fail-closed. */
  const mintToken = (body: ChallengeBody) => encode({ body, sig: sign(body) });

  function requirementsFor(invoiceId: string): PaymentRequirements {
    const expiresAt = new Date(now().getTime() + maxTimeoutSeconds * 1000).toISOString();
    const challenge = createChallenge({
      network: cfg.network as never,
      amount: cfg.price.amount,
      asset: cfg.price.asset,
      destination: cfg.recipient,
      expiresAt,
      paymentId: invoiceId,
    });
    const extra: Record<string, unknown> = { areFeesSponsored: false, invoiceId };
    if (cfg.price.asset.kind === "IOU") extra.issuer = cfg.price.asset.issuer;
    // The push credential is verified against the `exact` scheme's on-ledger path
    // (`confirmExactSettlement`), which binds on the XRPL InvoiceID field.
    return toPaymentRequirements(challenge, { scheme: SCHEME_EXACT, maxTimeoutSeconds, extra });
  }

  function verifyToken(token: string): { ok: true; body: ChallengeBody } | { ok: false; error: string } {
    let parsed: { body: ChallengeBody; sig: string };
    try {
      parsed = decode<{ body: ChallengeBody; sig: string }>(token);
    } catch {
      return { ok: false, error: "malformed challenge token" };
    }
    if (!parsed.body || typeof parsed.sig !== "string") return { ok: false, error: "malformed challenge token" };
    if (!safeEqualHex(parsed.sig, sign(parsed.body))) return { ok: false, error: "challenge signature invalid" };
    if (parsed.body.exp * 1000 < now().getTime()) return { ok: false, error: "challenge expired" };
    return { ok: true, body: parsed.body };
  }

  return {
    /** Issue a 402 `WWW-Authenticate: Payment` challenge for the resource. */
    challenge(): MppChallenge {
      const invoiceId = newInvoiceId();
      const id = createHash("sha256").update(`${invoiceId}:${now().getTime()}`).digest("hex").slice(0, 24);
      const exp = Math.floor(now().getTime() / 1000) + maxTimeoutSeconds;
      const request: MppChargeRequest = {
        amount: cfg.price.amount,
        currency: currencyCode,
        recipient: cfg.recipient,
        description: cfg.resource,
        methodDetails: { invoiceId, network: canonicalNetwork(cfg.network as never) },
      };
      const token = mintToken({ v: 1, id, invoiceId, exp, amount: cfg.price.amount, currency: currencyCode, recipient: cfg.recipient, resource: cfg.resource });
      const params = [
        `id="${id}"`,
        `realm="${realm}"`,
        `method="xrpl"`,
        `intent="charge"`,
        `request="${encode(request)}"`,
        `challenge="${token}"`,
      ].join(", ");
      return { status: 402, wwwAuthenticate: `Payment ${params}`, invoiceId, invoiceIdField: invoiceIdToField(invoiceId), challengeToken: token, request };
    },

    /** The XRPL `InvoiceID` the client must set for a given invoice id. */
    invoiceIdField: (invoiceId: string) => invoiceIdToField(invoiceId),

    /** Handle a retry carrying an `Authorization: Payment …` credential (push: `{type:"hash",hash}`). */
    async handle(authorizationHeader: string): Promise<MppResult> {
      let cred: MppCredential;
      try {
        const raw = authorizationHeader.replace(/^Payment\s+/i, "").trim();
        cred = decode<MppCredential>(raw);
      } catch (e) {
        return { status: 401, error: `invalid Authorization: ${(e as Error).message}`, code: "malformed_credential" };
      }
      // The challenge token is HMAC-bound; reject a tampered/expired one before settling.
      const v = verifyToken(cred.challenge);
      if (!v.ok) return { status: 401, error: v.error, code: "challenge_rejected" };
      if (!cred.payload || cred.payload.type !== "hash" || !cred.payload.hash) {
        return { status: 402, error: "engagement accounts settle in push mode: payload must be { type: 'hash', hash }", code: "unsupported_payload" };
      }
      const invoiceId = v.body.invoiceId;
      const requirements = requirementsFor(invoiceId);
      try {
        const result = await confirmExactSettlement({
          requirements,
          txHash: cred.payload.hash,
          fetchTransaction: cfg.fetchTransaction,
          replayStore,
          paymentId: invoiceId,
        });
        const receipt: MppReceipt = { method: "xrpl", status: "success", timestamp: now().toISOString(), reference: result.txHash };
        const body = result.idempotent ? undefined : cfg.deliver({ invoiceId, payer: result.payerAccount, txHash: result.txHash });
        return { status: 200, paymentReceiptHeader: encode(receipt), receipt, body, idempotent: result.idempotent, payer: result.payerAccount };
      } catch (e) {
        const code = (e as { code?: string }).code;
        const msg = (e as Error).message ?? String(e);
        // Not-yet-visible / not-validated is a soft "pay or wait"; a real mismatch is a hard failure.
        const soft = /not found|not a validated|did not succeed/i.test(msg);
        return { status: soft ? 402 : 502, error: msg, code };
      }
    },
  };
}

export type MppMerchant = ReturnType<typeof createMppMerchant>;
