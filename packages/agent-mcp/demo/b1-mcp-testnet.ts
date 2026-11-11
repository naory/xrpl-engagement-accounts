// M1 demo (MCP): an AI agent drives a co-signed engagement account entirely through the
// @eng/agent-mcp tool surface. A real MCP client spawns the agent-mcp server over stdio — exactly
// how an agent runtime would — which talks to a running policy co-signer (its §6 HTTP API) and
// settles on XRPL Testnet. This is the on-ledger counterpart to demo:b1, proving the four tools
// (propose_payment, submit_payment, pay_vendor, engagement_status) end to end.
//
//   npm install && npm run demo:mcp                 (from the repo root; ~3 min, leaves the account open)
//   XRPL_URL=wss://s.devnet.rippletest.net:51233 npm run demo:mcp
//
// All keys are generated fresh per run (faucet-funded test accounts); nothing is persisted except
// the results file and the co-signer's decision log under demo/results/.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import xrpl from 'xrpl'
import { localSigner, parseAmount, signStatement, newNonce, type Statement, type StatementBody, type Template } from '@eng/core'
import { intentHashOf, layerHash, type EngagementRecord, type PolicyDoc } from '@eng/policy'
import {
  CosignerService, XrplLedgerSource, createServer,
  ASF_DEFAULT_RIPPLE, ASF_DISABLE_MASTER, LSF_DISABLE_MASTER, TF_SET_NO_RIPPLE,
  accountInfo, addBatchSigner, buildOpenBatch, currencyHex, hex, iou, iouBalance, memo, sendSimple, serverFees, sleep, submit, innerResults,
} from '@eng/cosigner'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

type Wallet = InstanceType<typeof xrpl.Wallet>
type Json = Record<string, unknown>

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const URL_ = process.env.XRPL_URL ?? 'wss://s.altnet.rippletest.net:51233'
const EXPLORER = URL_.includes('devnet') ? 'https://devnet.xrpl.org/transactions/' : 'https://testnet.xrpl.org/transactions/'
const CUR = currencyHex('RLUSD')
const ENG_ID = `eng_mcp_${Date.now().toString(36)}`
const TOKEN = 'demo-' + Math.random().toString(36).slice(2)

const results: Json & { tests: Json[]; accounts: Record<string, string> } = { demo: 'M1 agent-mcp (agent drives the tools over stdio)', url: URL_, startedAt: new Date().toISOString(), accounts: {}, tests: [] }
function record(id: string, name: string, expected: string, actual: string, pass: boolean, extra: Json = {}) {
  results.tests.push({ id, name, expected, actual, pass, ...extra })
  console.log(`${pass ? '✅' : '❌'} ${id} ${name}\n     expected: ${expected}\n     actual:   ${actual}${extra.tx ? `\n     tx: ${EXPLORER}${extra.tx}` : ''}`)
}
const log = (...a: unknown[]) => console.log('   ·', ...a)
const resultsDir = path.join(here, 'results')
function save(): string {
  fs.mkdirSync(resultsDir, { recursive: true })
  const f = path.join(resultsDir, `mcp-run-${String(results.startedAt).replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(f, JSON.stringify(results, null, 2))
  return f
}
const must = (r: { final: string; hash: string }, label: string) => { if (r.final !== 'tesSUCCESS') throw new Error(`${label} failed: ${r.final} (${r.hash})`); return r }
const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const near = (a: unknown, b: number) => Math.abs(Number(a) - b) < 1e-9
const envStrings = (e: NodeJS.ProcessEnv): Record<string, string> => Object.fromEntries(Object.entries(e).filter(([, v]) => typeof v === 'string')) as Record<string, string>

function stmt(signer: Wallet, kind: string, type: string, subject: Json, claim: Json): Statement {
  const t = isoNow()
  const body: StatementBody = { v: 'eng.att/1', type, engagementId: ENG_ID, subject, claim, observedAt: t, issuedAt: t, nonce: newNonce(), attester: { account: signer.address, kind } }
  return signStatement(body, signer)
}

async function fund(client: InstanceType<typeof xrpl.Client>, label: string): Promise<Wallet> {
  for (let i = 0; i < 5; i++) {
    try {
      const { wallet } = await client.fundWallet()
      results.accounts[label] = wallet.address
      log(`funded ${label}: ${wallet.address}`)
      return wallet
    } catch (e) {
      log(`faucet retry ${label}: ${(e as Error).message}`)
      await sleep(5000)
    }
  }
  throw new Error(`faucet failed for ${label}`)
}

async function main() {
  const client = new xrpl.Client(URL_)
  await client.connect()
  console.log(`Connected to ${URL_}\n`)
  const fees = await serverFees(client)

  // ── Cast ──
  const issuer = await fund(client, 'issuer')
  const treasury = await fund(client, 'treasury (owner)')
  const service = await fund(client, 'service')
  const vendorA = await fund(client, 'vendorA')
  const vendorB = await fund(client, 'vendorB')
  const stranger = await fund(client, 'stranger')
  const kyb = await fund(client, 'kybIssuer')
  const agent = xrpl.Wallet.generate()      // signs only, never funded
  const cosigner = xrpl.Wallet.generate()   // signs only, never funded
  const controller = xrpl.Wallet.generate() // approves (statements only)
  Object.assign(results.accounts, { agent: agent.address, cosigner: cosigner.address, controller: controller.address })

  // ── Token + KYB credentials ──
  must(await sendSimple(client, issuer, { TransactionType: 'AccountSet', Account: issuer.address, SetFlag: ASF_DEFAULT_RIPPLE }), 'DefaultRipple')
  for (const w of [treasury, vendorA, vendorB, stranger]) must(await sendSimple(client, w, { TransactionType: 'TrustSet', Account: w.address, LimitAmount: iou(CUR, issuer.address, '10000000') }), 'trust line')
  must(await sendSimple(client, issuer, { TransactionType: 'Payment', Account: issuer.address, Destination: treasury.address, Amount: iou(CUR, issuer.address, '20000') }), 'issue to treasury')
  for (const v of [vendorA, vendorB]) {
    must(await sendSimple(client, kyb, { TransactionType: 'CredentialCreate', Account: kyb.address, Subject: v.address, CredentialType: hex('KYB_VERIFIED') }), 'KYB CredentialCreate')
    must(await sendSimple(client, v, { TransactionType: 'CredentialAccept', Account: v.address, Issuer: kyb.address, CredentialType: hex('KYB_VERIFIED') }), 'KYB CredentialAccept')
  }
  log('vendors A and B hold accepted KYB_VERIFIED credentials; the stranger does not')

  // ── Pre-create (service) ──
  const eng = xrpl.Wallet.generate()
  results.accounts.engagement = eng.address
  must(await sendSimple(client, service, { TransactionType: 'Payment', Account: service.address, Destination: eng.address, Amount: xrpl.xrpToDrops(3) }), 'create engagement account')
  must(await sendSimple(client, eng, { TransactionType: 'TrustSet', Account: eng.address, LimitAmount: iou(CUR, issuer.address, '1000000000'), Flags: TF_SET_NO_RIPPLE }), 'engagement trust line')
  must(await sendSimple(client, eng, { TransactionType: 'SetRegularKey', Account: eng.address, RegularKey: service.address }), 'pre-create SetRegularKey')
  must(await sendSimple(client, eng, { TransactionType: 'AccountSet', Account: eng.address, SetFlag: ASF_DISABLE_MASTER }), 'pre-create disable master')
  log(`pre-created ${eng.address} (master disabled, service RegularKey)`)

  // ── Open: owner funds 5,000 + SignerList {owner 2, agent 1, cosigner 1} quorum 2 + clear RegularKey ──
  {
    const seq = Number(((await accountInfo(client, eng.address))!.account_data as Json).Sequence)
    const tSeq = Number(((await accountInfo(client, treasury.address))!.account_data as Json).Sequence)
    const { tx } = buildOpenBatch({
      eng: eng.address, funder: treasury.address, currency: CUR, issuer: issuer.address, amount: '5000',
      signerEntries: [[treasury.address, 2], [agent.address, 1], [cosigner.address, 1]], quorum: 2, seq, funderSeq: tSeq, ticketCount: 0,
      memos: [memo('eng/open', `${ENG_ID}|template=owner-wallet/procurement@1`)], fees,
    })
    addBatchSigner(treasury, tx)
    const r = await submit(client, service.sign(tx as never).tx_blob)
    const inn = await innerResults(client, tx)
    const info = (await accountInfo(client, eng.address))!
    const d = info.account_data as Json
    const sl = ((info.signer_lists ?? d.signer_lists) as Json[] | undefined)?.[0] as Json | undefined
    const bal = await iouBalance(client, eng.address, CUR, issuer.address)
    const ok = r.final === 'tesSUCCESS' && inn.every((i) => i.applied) && (Number(d.Flags) & LSF_DISABLE_MASTER) !== 0 && d.RegularKey == null && sl?.SignerQuorum === 2 && near(bal, 5000)
    record('D1', 'open Batch: owner funding + SignerListSet (owner 2, agent 1, co-signer 1; quorum 2) + clear RegularKey',
      'tesSUCCESS, all inner applied, master disabled, no RegularKey, quorum 2, balance 5000',
      `${r.final}; inner ${inn.map((i) => i.result).join(',')}; regularKey=${d.RegularKey ?? 'none'}; quorum=${sl?.SignerQuorum}; balance=${bal}`, ok, { tx: r.hash })
    if (!ok) throw new Error('open failed; stopping')
  }

  // ── Co-signer HTTP service (what the MCP server will call) ──
  const read = <T>(f: string) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')) as T
  const baseline = read<PolicyDoc>('policies/baseline@1.0.0.json')
  const policy = read<PolicyDoc>('policies/procurement@1.3.0.json')
  policy.version = '1.3.0+demo'
  policy.assets!.RLUSD.issuer = issuer.address
  policy.params!.kybIssuers = [kyb.address]
  const templates = fs.readdirSync(path.join(root, 'templates')).map((f) => read<Template>(`templates/${f}`))
  const dataDir = path.join(resultsDir, `decisions-${String(results.startedAt).replace(/[:.]/g, '-')}`)
  const svc = new CosignerService({ signer: localSigner(cosigner), source: new XrplLedgerSource(client), templates, policies: [baseline, policy], dataDir })

  const expires = new Date(Date.now() + 7 * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const mandate = stmt(treasury, 'PRINCIPAL', 'party.mandate/1', { mandateId: 'mnd_mcp' }, { purpose: 'agent spend via MCP (demo)', budget: '5000.00', dailyCap: '3000.00', vendors: [vendorA.address, vendorB.address], expires })
  const engagement: EngagementRecord = {
    engagementId: ENG_ID, template: 'owner-wallet/procurement@1', account: eng.address, asset: 'RLUSD',
    parties: { owner: treasury.address, agent: agent.address, cosigner: cosigner.address },
    attesters: { approver: { accounts: [controller.address] }, vendor: { accounts: [vendorA.address, vendorB.address] } },
    deleteTo: service.address, state: 'OPEN', consumed: [], policyLayers: [layerHash(policy)], mandateId: mandate.id,
  }
  svc.register(engagement, mandate)
  const cosignerServer = createServer(svc, { token: TOKEN, readiness: () => client.isConnected() }).listen(0, '127.0.0.1')
  await new Promise((r) => cosignerServer.once('listening', r))
  const cosignerUrl = `http://127.0.0.1:${(cosignerServer.address() as AddressInfo).port}`
  log(`co-signer ${cosigner.address} serving ${cosignerUrl} (token-gated); mandate: budget 5,000 · daily cap 3,000 · approval above 1,000 · vendors A, B`)

  // ── The agent: a real MCP client spawning the agent-mcp server over stdio ──
  const transport = new StdioClientTransport({
    command: path.join(root, 'node_modules/.bin/tsx'),
    args: ['packages/agent-mcp/src/server.ts'],
    cwd: root,
    stderr: 'inherit',
    env: {
      ...envStrings(process.env),
      COSIGNER_URL: cosignerUrl, COSIGNER_API_TOKEN: TOKEN,
      AGENT_SEED: agent.seed!, ENGAGEMENT_ID: ENG_ID, ENGAGEMENT_ACCOUNT: eng.address,
      ASSET_ISSUER: issuer.address, ASSET_CODE: 'RLUSD', XRPL_URL: URL_, AGENT_ALLOW_SUBMIT: '1',
    },
  })
  const mcp = new Client({ name: 'b1-mcp-demo', version: '0.1.0' })
  await mcp.connect(transport)
  log('MCP client connected to the agent-mcp server over stdio')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function call(name: string, args: Json): Promise<any> {
    const res = await mcp.callTool({ name, arguments: args })
    const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? ''
    let data: unknown = text
    try { data = JSON.parse(text) } catch { /* plain error string */ }
    log(`→ ${name}(${JSON.stringify(args).slice(0, 80)}${JSON.stringify(args).length > 80 ? '…' : ''})${res.isError ? ' [isError]' : ''}`)
    return data
  }

  // ── Statements the agent attaches ──
  const rlusd = policy.assets!.RLUSD
  const invoice = (v: Wallet, ref: string, amount: string) => stmt(v, 'VENDOR', 'party.invoice/1', { invoiceRef: ref }, { invoiceRef: ref, amount, currency: 'RLUSD', po: 'PO-MCP' })
  const intent = (to: string, value: string, ref: string) => intentHashOf(to, parseAmount(value, rlusd), rlusd.decimals, ref)
  const approval = (to: string, value: string, ref: string) => stmt(controller, 'APPROVER', 'approval.payment/1', { intentHash: intent(to, value, ref) }, { approverRole: 'controller', notAfter: new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), comment: 'mcp demo approval' })

  // M0: the tool surface
  {
    const tools = (await mcp.listTools()).tools.map((t) => t.name).sort()
    record('M0', 'the agent-mcp server advertises its tools over stdio', 'engagement_status, pay_vendor, propose_payment, submit_payment', tools.join(', '), tools.join(',') === 'engagement_status,pay_vendor,propose_payment,submit_payment')
  }

  // M1: propose_payment then submit_payment (the two-step path)
  {
    const invA = invoice(vendorA, 'inv:A-001', '800.00')
    const pre = await iouBalance(client, vendorA.address, CUR, issuer.address)
    const p = await call('propose_payment', { destination: vendorA.address, amount: '800.00', invoiceRef: 'inv:A-001', statements: [invA] })
    let final = 'not submitted'; let hash: string | undefined
    if (p.decision === 'SIGN' && p.combinedBlob) { const s = await call('submit_payment', { combinedBlob: p.combinedBlob }); final = s.final; hash = s.hash }
    const delta = Number(await iouBalance(client, vendorA.address, CUR, issuer.address)) - Number(pre)
    record('M1', 'propose_payment 800→A (under threshold) then submit_payment the quorum blob', 'SIGN + combinedBlob; tesSUCCESS; A +800', `${p.decision}; blob=${p.combinedBlob ? 'yes' : 'no'}; ${final}; A +${delta}`, p.decision === 'SIGN' && !!p.combinedBlob && final === 'tesSUCCESS' && near(delta, 800), { tx: hash })
  }

  // M2: pay_vendor 1500→B with no approval (one-shot) → REFUSE, nothing broadcast
  const invB = invoice(vendorB, 'inv:B-001', '1500.00')
  {
    const pre = await iouBalance(client, vendorB.address, CUR, issuer.address)
    const p = await call('pay_vendor', { destination: vendorB.address, amount: '1500.00', invoiceRef: 'inv:B-001', statements: [invB] })
    const delta = Number(await iouBalance(client, vendorB.address, CUR, issuer.address)) - Number(pre)
    record('M2', 'pay_vendor 1500→B with no approval (above the 1,000 threshold)', 'REFUSE W5; submit=none; B +0', `${p.decision} ${(p.failing ?? []).join(',')}; submit=${p.submit?.final ?? 'none'}; B +${delta}`, p.decision === 'REFUSE' && (p.failing ?? []).join() === 'W5' && !p.submit && near(delta, 0))
  }

  // M3: pay_vendor 1500→B with the controller's approval bound to the intent → SIGN + settle
  {
    const pre = await iouBalance(client, vendorB.address, CUR, issuer.address)
    const p = await call('pay_vendor', { destination: vendorB.address, amount: '1500.00', invoiceRef: 'inv:B-001', statements: [invB, approval(vendorB.address, '1500.00', 'inv:B-001')] })
    const delta = Number(await iouBalance(client, vendorB.address, CUR, issuer.address)) - Number(pre)
    record('M3', 'pay_vendor 1500→B with the controller’s approval bound to the payment intent', 'SIGN; tesSUCCESS; B +1500', `${p.decision}; ${p.submit?.final}; B +${delta}`, p.decision === 'SIGN' && p.submit?.final === 'tesSUCCESS' && near(delta, 1500), { tx: p.submit?.hash })
  }

  // M4: propose_payment 200→stranger (not in the mandate, no KYB) → REFUSE, no quorum blob
  {
    const p = await call('propose_payment', { destination: stranger.address, amount: '200.00', invoiceRef: 'inv:X-001', statements: [invoice(stranger, 'inv:X-001', '200.00')] })
    record('M4', 'propose_payment 200→stranger (not in the mandate, no KYB credential)', 'REFUSE incl. B6, W2; no quorum blob', `${p.decision} ${(p.failing ?? []).join(',')}; blob=${p.combinedBlob ? 'yes' : 'none'}`, p.decision === 'REFUSE' && (p.failing ?? []).includes('B6') && (p.failing ?? []).includes('W2') && !p.combinedBlob)
  }

  // M5: engagement_status reflects the whole session
  {
    const p = await call('engagement_status', { limit: 10 })
    const decisions = (p.decisions ?? []).map((d: { decision: string }) => d.decision)
    record('M5', 'engagement_status returns the record and the four signed decisions', 'engagement present; decisions SIGN,REFUSE,SIGN,REFUSE', `eng=${p.engagement?.engagementId}; inflight=${p.inflight}; decisions ${decisions.join(',')}`, p.engagement?.engagementId === ENG_ID && decisions.length >= 4)
  }

  await mcp.close()
  cosignerServer.close()
  results.decisionLog = path.relative(root, path.join(dataDir, 'decisions.jsonl'))
  await client.disconnect()
  results.finishedAt = new Date().toISOString()
  const f = save()
  const passed = results.tests.filter((t) => t.pass).length
  console.log(`\n${passed}/${results.tests.length} passed. Results: ${path.relative(root, f)}\nDecision log: ${results.decisionLog}`)
  process.exit(passed === results.tests.length ? 0 : 1)
}

main().catch((e) => {
  console.error('\nDemo aborted:', e)
  results.error = String((e as Error)?.stack ?? e)
  try { console.log('Partial results:', save()) } catch { /* ignore */ }
  process.exit(1)
})
