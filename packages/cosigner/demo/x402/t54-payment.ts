// The RLUSD payment t54 settled and the committed co-signer will sign.
// Three memos: t54's untyped invoice binding, plus eng/basis (B8) and eng/invoice (W6).
import { createHash } from "node:crypto";
import { T54_RLUSD_CURRENCY, T54_RLUSD_ISSUER, T54_SOURCE_TAG } from "./facilitator.ts";

export function invoiceIdField(invoiceId: string): string {
  return createHash("sha256").update(invoiceId, "utf8").digest("hex").toUpperCase();
}

function typedMemo(type: string, data: string) {
  return {
    Memo: {
      MemoType: Buffer.from(type, "utf8").toString("hex").toUpperCase(),
      MemoData: Buffer.from(data, "utf8").toString("hex").toUpperCase(),
    },
  };
}

export function buildT54Payment(o: {
  account: string;
  destination: string;
  amount: string;
  invoiceId: string;
  sequence: number;
  fee: string;
  lastLedgerSequence: number;
  openLedger: number;
  issuer?: string;
}) {
  if (o.lastLedgerSequence > o.openLedger + 30) {
    throw new Error(`LastLedgerSequence ${o.lastLedgerSequence} is past open ledger ${o.openLedger} plus 30`);
  }
  const amount = { currency: T54_RLUSD_CURRENCY, issuer: o.issuer ?? T54_RLUSD_ISSUER, value: o.amount };
  return {
    TransactionType: "Payment",
    Account: o.account,
    Destination: o.destination,
    Amount: amount,
    SendMax: { ...amount },
    Flags: 0,
    InvoiceID: invoiceIdField(o.invoiceId),
    SourceTag: T54_SOURCE_TAG,
    Sequence: o.sequence,
    LastLedgerSequence: o.lastLedgerSequence,
    Fee: o.fee,
    SigningPubKey: "",
    Memos: [
      { Memo: { MemoData: Buffer.from(o.invoiceId, "utf8").toString("hex").toUpperCase() } },
      typedMemo("eng/basis", "spend"),
      typedMemo("eng/invoice", o.invoiceId),
    ],
  };
}
