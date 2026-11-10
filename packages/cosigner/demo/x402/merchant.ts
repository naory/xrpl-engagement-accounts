// A minimal x402 merchant for the engagement-account demo, built on the
// published settlement adapter (`x402-xrpl-settlement-adapter`).
//
// Engagement accounts pay with the **prepaid** scheme: the agent submits its own
// multisigned Payment (co-signed by the policy co-signer) and returns the
// transaction hash; the merchant verifies the *validated* transaction on-ledger.
// Multisig needs no special handling here — the ledger already enforced the
// SignerList and quorum, so verifying the validated transaction is enough. The
// payment keeps its engagement memos (`eng/basis`, `eng/invoice`) and also
// carries the adapter's x402 memo (paymentId), which is what the merchant binds.
//
// The `exact` scheme (adapter `./exact`) is the interop path for ordinary
// single-signed x402 clients; it is not used here because it forbids memos.
import {
  buildXrplMemo,
  canonicalNetwork,
  createChallenge,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodeReceiptHeader,
  InMemoryReplayStore,
  toPaymentRequirements,
  verifySettlement,
  type ChallengeAsset,
  type FetchTransaction,
  type ReplayStore,
  type SettlementResponse,
  type XrplMemoContainer,
} from "x402-xrpl-settlement-adapter";

export interface MerchantConfig {
  /** The resource id/URL being sold. */
  resource: string;
  /** CAIP-2 network, e.g. "xrpl:1" (testnet). */
  network: string;
  /** Merchant (payee) classic address. */
  payTo: string;
  /** Price the merchant charges. */
  price: { amount: string; asset: ChallengeAsset };
  /** How long a challenge is valid, seconds (default 120). */
  maxTimeoutSeconds?: number;
  /** Reads a validated transaction by hash (e.g. via fromRippledTx over a `tx` call). */
  fetchTransaction: FetchTransaction;
  /** Produces the paid resource body once settlement is confirmed. */
  deliver: (ctx: { invoiceId: string; payer?: string; txHash: string }) => unknown;
  /** Shared across requests; defaults to an in-memory store. */
  replayStore?: ReplayStore;
  /** Seconds a receipt may arrive after expiry (default 60). */
  settlementGraceSeconds?: number;
  /** Clock, for tests. */
  now?: () => Date;
  /** Mints a unique invoice id per challenge (default: random). */
  newInvoiceId?: () => string;
}

export interface Challenge402 {
  status: 402;
  /** Value for the `PAYMENT-REQUIRED` response header. */
  paymentRequiredHeader: string;
  /** The invoice id the client must bind its payment to. */
  invoiceId: string;
  /** The XRPL Memo the client must attach so the merchant can bind the payment. */
  requiredMemo: XrplMemoContainer;
}

export type HandleResult =
  | { status: 200; paymentResponseHeader: string; response: SettlementResponse; body: unknown; idempotent: boolean }
  | { status: 402 | 502; error: string; code?: string };

export interface Merchant {
  /** Issue a 402 challenge for the resource. */
  challenge(): Challenge402;
  /** Handle a retry carrying a `PAYMENT-SIGNATURE` header (prepaid payload: `{ txHash }`). */
  handle(paymentSignatureHeader: string): Promise<HandleResult>;
  /** The XRPL Memo a client must attach for a given invoice id. */
  memoFor(invoiceId: string): XrplMemoContainer;
}

export function createMerchant(cfg: MerchantConfig): Merchant {
  const replayStore = cfg.replayStore ?? new InMemoryReplayStore();
  const maxTimeoutSeconds = cfg.maxTimeoutSeconds ?? 120;
  const now = cfg.now ?? (() => new Date());
  const newInvoiceId = cfg.newInvoiceId ?? (() => `inv-${now().getTime().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  // Invoice ids the merchant actually issued. A client cannot invent one.
  const issued = new Set<string>();

  // The merchant always verifies against its OWN requirements, never the client's echo.
  function challengeFor(invoiceId: string) {
    const expiresAt = new Date(now().getTime() + maxTimeoutSeconds * 1000).toISOString();
    const challenge = createChallenge({
      network: cfg.network as never,
      amount: cfg.price.amount,
      asset: cfg.price.asset,
      destination: cfg.payTo,
      expiresAt,
      paymentId: invoiceId,
    });
    const extra: Record<string, unknown> = { areFeesSponsored: false, invoiceId };
    if (cfg.price.asset.kind === "IOU") extra.issuer = cfg.price.asset.issuer;
    const requirements = toPaymentRequirements(challenge, { scheme: "prepaid", maxTimeoutSeconds, extra });
    return { challenge, requirements };
  }

  function memoFor(invoiceId: string): XrplMemoContainer {
    return buildXrplMemo(createChallenge({
      network: cfg.network as never,
      amount: cfg.price.amount,
      asset: cfg.price.asset,
      destination: cfg.payTo,
      expiresAt: new Date(now().getTime() + maxTimeoutSeconds * 1000).toISOString(),
      paymentId: invoiceId,
    }));
  }

  return {
    challenge(): Challenge402 {
      const invoiceId = newInvoiceId();
      issued.add(invoiceId);
      const { requirements } = challengeFor(invoiceId);
      const header = encodePaymentRequiredHeader({ x402Version: 2, resource: cfg.resource, accepts: [requirements] });
      return { status: 402, paymentRequiredHeader: header, invoiceId, requiredMemo: memoFor(invoiceId) };
    },

    memoFor,

    async handle(paymentSignatureHeader: string): Promise<HandleResult> {
      let invoiceId: string;
      let txHash: string;
      try {
        const payload = decodePaymentSignatureHeader(paymentSignatureHeader);
        invoiceId = String(payload.accepted.extra?.invoiceId ?? "");
        txHash = String((payload.payload as { txHash?: unknown }).txHash ?? "");
        if (!invoiceId || !txHash) return { status: 402, error: "payload must carry accepted.extra.invoiceId and payload.txHash" };
      } catch (e) {
        return { status: 402, error: `invalid PAYMENT-SIGNATURE: ${(e as Error).message}` };
      }
      // The invoice id must be one this merchant issued — a client cannot invent one.
      if (!issued.has(invoiceId)) return { status: 402, error: "unknown or expired invoiceId" };

      const { challenge } = challengeFor(invoiceId);
      const receiptHeaderValue = encodeReceiptHeader({ network: canonicalNetwork(cfg.network as never), txHash, paymentId: invoiceId });
      try {
        const result = await verifySettlement({
          challenge,
          receiptHeaderValue,
          fetchTransaction: cfg.fetchTransaction,
          replayStore,
          now: now(),
          settlementGraceSeconds: cfg.settlementGraceSeconds,
        });
        const response: SettlementResponse = {
          success: true,
          transaction: result.receipt.txHash,
          network: canonicalNetwork(cfg.network as never),
          payer: result.payerAccount,
          amount: cfg.price.amount,
        };
        const body = result.idempotent ? undefined : cfg.deliver({ invoiceId, payer: result.payerAccount, txHash });
        return { status: 200, paymentResponseHeader: encodePaymentResponseHeader(response), response, body, idempotent: result.idempotent };
      } catch (e) {
        const code = (e as { code?: string }).code;
        // Not-yet-validated / not-found is a soft "pay or wait"; a real mismatch is a hard failure.
        const soft = code === "tx_not_found" || code === "tx_not_validated";
        return { status: soft ? 402 : 502, error: (e as Error).message, code };
      }
    },
  };
}
