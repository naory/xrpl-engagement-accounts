// Opt-in Testnet demo: a capped RLUSD payment settled by t54's facilitator.
// Prepaid X1–X4 stay on demo:x402. This script does not broadcast; t54 /settle does.
//
//   npm run demo:x402:t54
//
// Clip 1 settles 1.00 RLUSD (under the 1000.00 approval threshold).
// Clip 2 is an over-cap payment and a redirected destination. The co-signer refuses both.
// Optional: a blob signed inside the 30-ledger window, then offered to t54 after it expires.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import xrpl from "xrpl";
import { localSigner, newNonce, signStatement, type Statement, type StatementBody } from "@eng/core";
import { startLocalCosigner } from "../../src/index.ts";
import { CosignerClient } from "../../../agent-mcp/src/client.ts";
import { EngagementAgent } from "../../../agent-mcp/src/agent.ts";
import { createMerchant } from "./merchant.ts";
import { buildT54Payment } from "./t54-payment.ts";
import { T54_RLUSD_CURRENCY, T54_RLUSD_ISSUER, T54_SOURCE_TAG } from "./facilitator.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const ISSUER = T54_RLUSD_ISSUER;
const AMOUNT = "1.00";
const ASF_DISABLE_MASTER = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function txResult(meta: unknown): string {
  return meta && typeof meta === "object" && "TransactionResult" in meta ? String(meta.TransactionResult ?? "") : "";
}
const iou = (value: string) => ({ currency: T54_RLUSD_CURRENCY, issuer: ISSUER, value });

type Wallet = InstanceType<typeof xrpl.Wallet>;
type Client = InstanceType<typeof xrpl.Client>;

async function fund(client: Client, label: string): Promise<Wallet> {
  for (let i = 0; i < 5; i++) {
    try {
      const { wallet } = await client.fundWallet();
      console.log(`   · funded ${label}: ${wallet.address}`);
      return wallet;
    } catch (e) {
      console.log(`   · faucet retry ${label}: ${e instanceof Error ? e.message : "failed"}`);
      await sleep(5000);
    }
  }
  throw new Error(`faucet failed for ${label}`);
}

async function submit(client: Client, wallet: Wallet, tx: Record<string, unknown>, label: string) {
  const prepared = await client.autofill(tx as never);
  const signed = wallet.sign(prepared);
  const sub = await client.request({ command: "submit", tx_blob: signed.tx_blob });
  const prelim = sub.result.engine_result;
  const hash = sub.result.tx_json?.hash ?? xrpl.hashes.hashSignedTx(signed.tx_blob);
  console.log(`   · ${label}: ${prelim} ${hash}`);
  if (/^(tef|tem|tel)/.test(prelim)) throw new Error(`${label} ${prelim} ${hash}`);
  const start = (await client.request({ command: "ledger_current" })).result.ledger_current_index;
  for (;;) {
    await sleep(1000);
    try {
      const t = await client.request({ command: "tx", transaction: hash });
      if (t.result.validated) {
        const final = txResult(t.result.meta);
        console.log(`   · ${label}: ${final} https://testnet.xrpl.org/transactions/${hash}`);
        if (final !== "tesSUCCESS") throw new Error(`${label} ${final} ${hash}`);
        return hash;
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith(label)) throw e;
    }
    if ((await client.request({ command: "ledger_current" })).result.ledger_current_index > start + 25) {
      throw new Error(`${label} not validated ${hash}`);
    }
  }
}

function stmt(signer: Wallet, kind: string, type: string, engagementId: string, subject: Record<string, unknown>, claim: Record<string, unknown>): Statement {
  const t = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const body: StatementBody = {
    v: "eng.att/1", type, engagementId, subject, claim, observedAt: t, issuedAt: t, nonce: newNonce(),
    attester: { account: signer.address, kind },
  };
  return signStatement(body, signer);
}

async function main() {
  const resultsDir = path.join(here, "..", "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const local = await startLocalCosigner({
    env: { ...process.env, DATA_DIR: path.join(resultsDir, `t54-cosigner-${Date.now()}`), PORT: "0", ENG_NETWORK: "xrpl:1" },
    cwd: path.resolve(here, "../../../.."),
    log: (line) => console.log(line.includes("seed") ? "   · co-signer key file ready" : line),
  });
  if (!local.endpoint.includes("testnet") && !local.endpoint.includes("altnet")) {
    throw new Error(`refusing non-testnet endpoint ${local.endpoint}`);
  }
  const token = fs.readFileSync(local.tokenPath, "utf8").trim();
  const client = new xrpl.Client(local.endpoint);
  await client.connect();
  console.log(`co-signer ${local.url} ${local.address}`);
  console.log(`endpoint ${local.endpoint}`);
  const validated = (await client.request({ command: "server_state" })).result.state.validated_ledger;
  if (!validated) throw new Error("no validated ledger");
  const base = Number(validated.base_fee);
  const fee = String(base * 3 + 6);

  const payer = await fund(client, "payer");
  const vendorA = await fund(client, "vendor A");
  const vendorB = await fund(client, "vendor B");
  const kyb = await fund(client, "kyb issuer");
  const owner = xrpl.Wallet.generate();
  const agentKey = xrpl.Wallet.generate();
  console.log(`owner ${owner.address}`);
  console.log(`agent ${agentKey.address}`);

  for (const [wallet, label] of [[payer, "payer"], [vendorA, "vendor A"], [vendorB, "vendor B"]] as const) {
    await submit(client, wallet, { TransactionType: "TrustSet", Account: wallet.address, LimitAmount: iou("1000000") }, `${label} trust`);
  }
  const cred = Buffer.from("KYB_VERIFIED", "utf8").toString("hex").toUpperCase();
  for (const vendor of [vendorA, vendorB]) {
    await submit(client, kyb, { TransactionType: "CredentialCreate", Account: kyb.address, Subject: vendor.address, CredentialType: cred }, "KYB create");
    await submit(client, vendor, { TransactionType: "CredentialAccept", Account: vendor.address, Issuer: kyb.address, CredentialType: cred }, "KYB accept");
  }
  const buy = iou("2.00");
  const found = await client.request({
    command: "ripple_path_find", source_account: payer.address, destination_account: payer.address,
    destination_amount: buy, source_currencies: [{ currency: "XRP" }],
  });
  const alt = found.result.alternatives?.[0];
  const drops = typeof alt?.source_amount === "string" ? Number(alt.source_amount) : NaN;
  if (!alt || !Number.isFinite(drops) || drops > 50_000_000) throw new Error("no RLUSD path within 50 XRP");
  console.log(`   · buying 2.00 RLUSD for ${drops} drops`);
  await submit(client, payer, {
    TransactionType: "Payment", Account: payer.address, Destination: payer.address,
    Amount: buy, SendMax: alt.source_amount, Paths: alt.paths_computed,
  }, "buy RLUSD");
  const signers = [agentKey, { address: local.address }].sort((a, b) => Buffer.compare(Buffer.from(xrpl.decodeAccountID(a.address)), Buffer.from(xrpl.decodeAccountID(b.address))));
  await submit(client, payer, {
    TransactionType: "SignerListSet", Account: payer.address, SignerQuorum: 2,
    SignerEntries: signers.map((w) => ({ SignerEntry: { Account: w.address, SignerWeight: 1 } })),
  }, "SignerListSet");
  await submit(client, payer, { TransactionType: "AccountSet", Account: payer.address, SetFlag: ASF_DISABLE_MASTER }, "disable master");

  const engagementId = `eng_t47_${Date.now().toString(36)}`;
  const expires = new Date(Date.now() + 7 * 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const mandate = stmt(owner, "PRINCIPAL", "party.mandate/1", engagementId, { mandateId: "mnd_t47" }, {
    purpose: "t47 capped RLUSD", budget: "5000.00", dailyCap: "3000.00", vendors: [vendorA.address, vendorB.address], expires,
  });
  const api = new CosignerClient({ baseUrl: local.url, token });
  await api.register({
    engagementId, template: "owner-wallet/procurement@1", account: payer.address, asset: "RLUSD",
    parties: { owner: owner.address, agent: agentKey.address, cosigner: local.address },
    attesters: { approver: { accounts: [owner.address] }, vendor: { accounts: [vendorA.address, vendorB.address] } },
    deleteTo: owner.address, state: "OPEN", consumed: [], mandateId: mandate.id,
    trust: { "kyb.issuer": kyb.address, "rlusd.issuer": ISSUER },
  }, mandate);

  let verifyCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/verify")) verifyCalls += 1;
    return fetch(input, init);
  };
  const merchant = createMerchant({
    resource: "https://example.invalid/t47", network: "xrpl:1", payTo: vendorA.address,
    price: { amount: AMOUNT, asset: { kind: "IOU", currency: T54_RLUSD_CURRENCY, issuer: ISSUER } },
    fetchTransaction: async () => null, deliver: () => ({ ok: true }),
    exact: { asset: T54_RLUSD_CURRENCY, issuer: ISSUER, sourceTag: T54_SOURCE_TAG, fetchImpl },
  });
  const agent = new EngagementAgent({
    engagementId, account: payer.address, signer: localSigner(agentKey),
    asset: { code: "RLUSD", currency: T54_RLUSD_CURRENCY, issuer: ISSUER },
    decider: api, stage: "spend", ttlLedgers: 20,
  });

  async function openLedger() {
    return (await client.request({ command: "ledger_current" })).result.ledger_current_index;
  }
  async function sequence() {
    const info = await client.request({ command: "account_info", account: payer.address, ledger_index: "validated" });
    return Number(info.result.account_data.Sequence);
  }
  async function propose(amount: string, destination: string, invoiceId: string, statements: Statement[], lastLedger?: number) {
    const open = await openLedger();
    const lls = lastLedger ?? open + 20;
    const tx = buildT54Payment({
      account: payer.address, destination, amount, invoiceId, sequence: await sequence(), fee,
      lastLedgerSequence: lls, openLedger: open,
    });
    const proposal = await agent.proposePayment({ destination, amount, invoiceRef: invoiceId, tx, statements });
    return { proposal, open, lls };
  }

  const evidence: Record<string, unknown> = { payer: payer.address, vendorA: vendorA.address, vendorB: vendorB.address };

  console.log("\n======== Clip 1: capped payment via t54 ========");
  const inv1 = `inv-t47-${Date.now()}`;
  const clip1 = await propose(AMOUNT, vendorA.address, inv1, [
    stmt(vendorA, "VENDOR", "party.invoice/1", engagementId, { invoiceRef: inv1 }, { invoiceRef: inv1, amount: AMOUNT, currency: "RLUSD", po: "PO-T47" }),
    stmt(agentKey, "AGENT", "payment.challenge/1", engagementId, { invoiceId: inv1 }, { scheme: "x402", payTo: vendorA.address, amount: AMOUNT, asset: "RLUSD", invoiceId: inv1, resource: "https://example.invalid/t47" }),
  ]);
  if (clip1.proposal.decision.decision !== "SIGN" || !clip1.proposal.combined) {
    throw new Error(`clip 1 refused ${(clip1.proposal.decision.failing ?? []).join(",")}`);
  }
  const settled = await merchant.settlePresigned({ signedTxBlob: clip1.proposal.combined, invoiceId: inv1 });
  console.log(`   · co-signer SIGN  B8=${clip1.proposal.decision.results.find((r) => r.id === "B8")?.result} W6=${clip1.proposal.decision.results.find((r) => r.id === "W6")?.result}`);
  console.log(`   · /verify ${settled.verify.status} id=${settled.verify.requestId} ${JSON.stringify(settled.verify.body)}`);
  console.log(`   · /settle ${settled.settle?.status} id=${settled.settle?.requestId} ${JSON.stringify(settled.settle?.body)}`);
  if (!settled.accepted || !settled.transaction) throw new Error("clip 1 settle was not accepted");
  let ledgerResult = "NOT_VALIDATED";
  for (let i = 0; i < 20; i++) {
    try {
      const t = await client.request({ command: "tx", transaction: settled.transaction });
      if (t.result.validated) {
        ledgerResult = txResult(t.result.meta);
        break;
      }
    } catch { /* not in a validated ledger yet */ }
    await sleep(1000);
  }
  console.log(`   · ${ledgerResult}`);
  console.log(`   · https://testnet.xrpl.org/transactions/${settled.transaction}`);
  if (ledgerResult !== "tesSUCCESS") throw new Error(`clip 1 ${ledgerResult}`);
  evidence.clip1 = { hash: settled.transaction, verifyRequestId: settled.verify.requestId, settleRequestId: settled.settle?.requestId, ledgerResult };

  await sleep(1500);
  console.log("\n======== Clip 2: rogue agent refused ========");
  const before = verifyCalls;
  const invOver = `inv-t47-over-${Date.now()}`;
  const over = await propose("1500.00", vendorA.address, invOver, [
    stmt(vendorA, "VENDOR", "party.invoice/1", engagementId, { invoiceRef: invOver }, { invoiceRef: invOver, amount: "1500.00", currency: "RLUSD", po: "PO-OVER" }),
    stmt(agentKey, "AGENT", "payment.challenge/1", engagementId, { invoiceId: invOver }, { scheme: "x402", payTo: vendorA.address, amount: "1500.00", asset: "RLUSD", invoiceId: invOver, resource: "https://example.invalid/t47" }),
  ]);
  console.log(`   · over-cap 1500.00 ${over.proposal.decision.decision} ${(over.proposal.decision.failing ?? []).join(",")}`);
  const invRedir = `inv-t47-redir-${Date.now()}`;
  const redir = await propose(AMOUNT, vendorB.address, invRedir, [
    stmt(vendorB, "VENDOR", "party.invoice/1", engagementId, { invoiceRef: invRedir }, { invoiceRef: invRedir, amount: AMOUNT, currency: "RLUSD", po: "PO-REDIR" }),
    stmt(agentKey, "AGENT", "payment.challenge/1", engagementId, { invoiceId: invRedir }, { scheme: "x402", payTo: vendorA.address, amount: AMOUNT, asset: "RLUSD", invoiceId: invRedir, resource: "https://example.invalid/t47" }),
  ]);
  console.log(`   · redirected destination ${redir.proposal.decision.decision} ${(redir.proposal.decision.failing ?? []).join(",")}`);
  if (over.proposal.decision.decision !== "REFUSE" || !over.proposal.decision.failing.includes("W5")) throw new Error("over-cap was not refused by W5");
  if (redir.proposal.decision.decision !== "REFUSE" || !redir.proposal.decision.failing.includes("W7")) throw new Error("redirect was not refused by W7");
  if (verifyCalls !== before) throw new Error(`facilitator was called ${verifyCalls - before} times`);
  console.log("facilitator not called");
  evidence.clip2 = { overCap: over.proposal.decision.failing, redirected: redir.proposal.decision.failing, verifyCalls: verifyCalls - before };

  console.log("\n======== Optional: expired blob refused ========");
  const invOld = `inv-t47-expired-${Date.now()}`;
  const open = await openLedger();
  const expired = await propose(AMOUNT, vendorA.address, invOld, [
    stmt(vendorA, "VENDOR", "party.invoice/1", engagementId, { invoiceRef: invOld }, { invoiceRef: invOld, amount: AMOUNT, currency: "RLUSD", po: "PO-OLD" }),
    stmt(agentKey, "AGENT", "payment.challenge/1", engagementId, { invoiceId: invOld }, { scheme: "x402", payTo: vendorA.address, amount: AMOUNT, asset: "RLUSD", invoiceId: invOld, resource: "https://example.invalid/t47" }),
  ], open + 2);
  if (expired.proposal.decision.decision !== "SIGN" || !expired.proposal.combined) {
    throw new Error(`expired blob was not signed ${(expired.proposal.decision.failing ?? []).join(",")}`);
  }
  for (;;) {
    const now = await openLedger();
    if (now > expired.lls) break;
    await sleep(1000);
  }
  const late = await merchant.settlePresigned({ signedTxBlob: expired.proposal.combined, invoiceId: invOld });
  console.log(`   · /verify ${late.verify.status} id=${late.verify.requestId} ${JSON.stringify(late.verify.body)}`);
  if (late.settle) console.log(`   · /settle ${late.settle.status} id=${late.settle.requestId} ${JSON.stringify(late.settle.body)}`);
  let expiredOk = !late.accepted;
  if (late.transaction) {
    for (let i = 0; i < 15; i++) {
      try {
        const t = await client.request({ command: "tx", transaction: late.transaction });
        if (t.result.validated) {
          const final = txResult(t.result.meta);
          console.log(`   · ${final} https://testnet.xrpl.org/transactions/${late.transaction}`);
          expiredOk = final !== "tesSUCCESS";
          break;
        }
      } catch { /* waiting */ }
      await sleep(1000);
    }
  }
  if (!expiredOk) throw new Error("expired blob validated tesSUCCESS");
  evidence.expired = { verifyRequestId: late.verify.requestId, settleRequestId: late.settle?.requestId ?? null, accepted: late.accepted };

  const out = path.join(resultsDir, `t54-run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
  console.log(`\nResults: ${path.relative(path.resolve(here, "../../../.."), out)}`);
  await client.disconnect();
  await local.close();
}

main().catch((e) => {
  console.error("demo aborted:", e instanceof Error ? e.message : "failed");
  process.exit(1);
});
