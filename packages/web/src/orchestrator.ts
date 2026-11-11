// The live engine behind the web demo: one object that drives the whole lifecycle on XRPL Testnet.
// provision() funds a cast, runs the eng.provision/1 protocol (each signer proves possession of its
// key), opens the engagement account with the SignerList the protocol assembled, and registers it
// with an in-process policy co-signer. pay()/propose() then act as the agent. Everything the UI
// needs to narrate the flow — addresses, the SignerList, the mandate, decision reasons, real tx
// hashes — comes back as plain JSON.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import xrpl from 'xrpl'
import { parseAmount, signStatement, newNonce, localSigner, type Statement, type StatementBody, type Template } from '@eng/core'
import { intentHashOf, layerHash, type EngagementRecord, type PolicyDoc } from '@eng/policy'
import {
  CosignerService, XrplLedgerSource,
  ASF_DEFAULT_RIPPLE, ASF_DISABLE_MASTER, LSF_DISABLE_MASTER, TF_SET_NO_RIPPLE,
  accountInfo, addBatchSigner, buildOpenBatch, currencyHex, hex, iou, iouBalance, memo, sendSimple, serverFees, sleep, submit, innerResults,
  inner, batchFee, multisignBlob, combine, currentLedger, TF_ALL_OR_NOTHING, type Fees,
  PoolManager, XrplPoolLedger, LocalFileSeedStore, FilePoolStateStore, LocalKeys, type PoolConfig,
} from '@eng/cosigner'
import { EngagementAgent, XrplChain } from '@eng/agent-mcp'
import { ProvisioningCoordinator, makeEnrolment } from '@eng/provisioning'

type Wallet = InstanceType<typeof xrpl.Wallet>
type Json = Record<string, unknown>

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const CUR = currencyHex('RLUSD')
const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const must = (r: { final: string; hash: string }, label: string) => { if (r.final !== 'tesSUCCESS') throw new Error(`${label} failed: ${r.final} (${r.hash})`); return r }
const reqEnv = (k: string): string => { const v = process.env[k]; if (!v) throw new Error(`${k} is required when ENG_USE_POOL=1`); return v }
const poolOn = (): boolean => process.env.ENG_USE_POOL === '1' || process.env.ENG_USE_POOL === 'true'

export interface ReclaimResult {
  closed: boolean
  account: string
  reclaimedTo: string
  sweepTx?: string
  removeTrustlineTx: string
  accountDeleteTx: string
  explorer: string
}

export interface ProvisionResult {
  engagementId: string
  account: string
  explorer: string
  quorum: number
  signers: Array<{ role: string; address: string; weight: number; proofVerified: boolean; as?: string; optional?: boolean; note?: string }>
  mandate: { purpose: string; budget: string; dailyCap: string; approvalOver: string; vendors: Array<{ label: string; address: string }> }
  accounts: Record<string, string>
  openTx: string
  balance: string | null
  session: { id: string }
}
export interface PayResult {
  decision: string
  failing: string[]
  reasons: string[]
  settled: boolean
  tx?: string
  final?: string
  balance: string | null
}
export interface StatusResult {
  balances: { engagement: string | null; vendorA: string | null; vendorB: string | null }
  decisions: Array<{ stage: unknown; decision: unknown; failing: unknown }>
}
export interface EscrowResult {
  path: string
  settled: boolean
  final?: string
  tx?: string
  checks: Array<[string, boolean]>
  payouts: Array<[string, string]> | null
}
export interface X402Result {
  settled: boolean
  tx?: string
  final?: string
  invoiceId: string
  resource?: string
  checks: Array<[string, boolean]>
  reason?: string
}

// Human-readable reasons for the policy rule ids the co-signer reports.
const RULE_TEXT: Record<string, string> = {
  B6: 'payee has no accepted KYB credential', W2: 'payee is not in the mandate', W3: 'daily spend cap exceeded',
  W5: 'approval required above the threshold', W6: 'approval missing or not bound to this payment', W7: 'payment challenge not satisfied',
  B2: 'transaction carries a forbidden account change',
}

export class DemoOrchestrator {
  readonly url: string
  readonly explorer: string
  private client!: InstanceType<typeof xrpl.Client>
  private fees!: Fees
  private policy!: PolicyDoc
  private svc!: CosignerService
  private agent!: EngagementAgent
  private engagementId = ''
  private eng!: Wallet
  private w: Record<string, Wallet> = {}
  private vendorByAddr = new Map<string, { wallet: Wallet; label: string }>()
  provisioned = false
  private scenario = 'procurement'
  private escrowBal = 0
  private lastX402Invoice = ''
  private lastX402Stmt: Statement | null = null
  // Pooled mode (ENG_USE_POOL=1): lease a pre-aged account from the warm pool instead of pre-creating one.
  private pool?: PoolManager
  private pooled = false
  private poolSponsor!: Wallet   // operating account: funds pooled reserves, receives every reclaim
  private poolService!: Wallet   // pool service key: controls leased accounts (their RegularKey), signs open + reclaim

  constructor(url = process.env.XRPL_URL ?? 'wss://s.altnet.rippletest.net:51233') {
    this.url = url
    this.explorer = url.includes('devnet') ? 'https://devnet.xrpl.org/transactions/' : 'https://testnet.xrpl.org/transactions/'
  }

  async connect(): Promise<void> {
    this.client = new xrpl.Client(this.url)
    await this.client.connect()
    this.fees = await serverFees(this.client)
    if (poolOn()) {
      const dir = path.join(root, process.env.ENG_POOL_DIR ?? '.pool')
      this.poolSponsor = xrpl.Wallet.fromSeed(reqEnv('ENG_SPONSOR_SEED'))
      this.poolService = xrpl.Wallet.fromSeed(reqEnv('ENG_SERVICE_SEED'))
      const config: PoolConfig = {
        rlusd: { currency: 'RLUSD', issuer: reqEnv('ENG_RLUSD_ISSUER'), limit: '1000000000' },
        createAmountDrops: process.env.ENG_CREATE_DROPS ?? '3000000',
        agingLedgers: 256,
        target: Number(process.env.ENG_POOL_TARGET ?? '5'),
        sponsored: process.env.ENG_POOL_SPONSORED === '1' || process.env.ENG_POOL_SPONSORED === 'true',
      }
      this.pool = new PoolManager({
        ledger: new XrplPoolLedger(this.client), state: new FilePoolStateStore(path.join(dir, 'state.json')),
        seeds: new LocalFileSeedStore(path.join(dir, 'seeds.json')), keys: LocalKeys,
        sponsor: this.poolSponsor, service: this.poolService, config,
      })
    }
  }
  async disconnect(): Promise<void> { if (this.client?.isConnected()) await this.client.disconnect() }

  private read<T>(f: string): T { return JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')) as T }
  private async fund(label: string): Promise<Wallet> {
    for (let i = 0; i < 6; i++) {
      try { const { wallet } = await this.client.fundWallet(); this.w[label] = wallet; return wallet } catch { await sleep(5000) }
    }
    throw new Error(`faucet failed for ${label}`)
  }
  private stmt(signer: Wallet, kind: string, type: string, subject: Json, claim: Json): Statement {
    const t = isoNow()
    const body: StatementBody = { v: 'eng.att/1', type, engagementId: this.engagementId, subject, claim, observedAt: t, issuedAt: t, nonce: newNonce(), attester: { account: signer.address, kind } }
    return signStatement(body, signer)
  }

  async provision(scenario = 'procurement'): Promise<ProvisionResult> {
    this.scenario = scenario
    if (scenario === 'escrow') return this.provisionEscrow()
    if (scenario === 'bond') return this.provisionBond()
    return this.pool ? this.provisionProcurementPooled() : this.provisionProcurement()
  }

  private async provisionProcurement(): Promise<ProvisionResult> {
    this.engagementId = `eng_web_${Date.now().toString(36)}`
    const issuer = await this.fund('issuer')
    const treasury = await this.fund('treasury')   // the owner (SignerList weight 2)
    const service = await this.fund('service')      // pre-create RegularKey + funder of the account reserve
    const vendorA = await this.fund('vendorA')
    const vendorB = await this.fund('vendorB')
    const stranger = await this.fund('stranger')
    const kyb = await this.fund('kyb')
    const agent = xrpl.Wallet.generate(); this.w.agent = agent
    const cosigner = xrpl.Wallet.generate(); this.w.cosigner = cosigner
    const controller = xrpl.Wallet.generate(); this.w.controller = controller
    this.vendorByAddr.set(vendorA.address, { wallet: vendorA, label: 'Vendor A' })
    this.vendorByAddr.set(vendorB.address, { wallet: vendorB, label: 'Vendor B' })
    this.vendorByAddr.set(stranger.address, { wallet: stranger, label: 'Stranger' })

    // Token + KYB
    must(await sendSimple(this.client, issuer, { TransactionType: 'AccountSet', Account: issuer.address, SetFlag: ASF_DEFAULT_RIPPLE }), 'DefaultRipple')
    for (const v of [treasury, vendorA, vendorB, stranger]) must(await sendSimple(this.client, v, { TransactionType: 'TrustSet', Account: v.address, LimitAmount: iou(CUR, issuer.address, '10000000') }), 'trust line')
    must(await sendSimple(this.client, issuer, { TransactionType: 'Payment', Account: issuer.address, Destination: treasury.address, Amount: iou(CUR, issuer.address, '20000') }), 'issue')
    for (const v of [vendorA, vendorB]) {
      must(await sendSimple(this.client, kyb, { TransactionType: 'CredentialCreate', Account: kyb.address, Subject: v.address, CredentialType: hex('KYB_VERIFIED') }), 'KYB create')
      must(await sendSimple(this.client, v, { TransactionType: 'CredentialAccept', Account: v.address, Issuer: kyb.address, CredentialType: hex('KYB_VERIFIED') }), 'KYB accept')
    }

    // Pre-create the engagement account (master disabled, service RegularKey)
    const eng = xrpl.Wallet.generate(); this.eng = eng; this.w.engagement = eng
    must(await sendSimple(this.client, service, { TransactionType: 'Payment', Account: service.address, Destination: eng.address, Amount: xrpl.xrpToDrops(3) }), 'create account')
    must(await sendSimple(this.client, eng, { TransactionType: 'TrustSet', Account: eng.address, LimitAmount: iou(CUR, issuer.address, '1000000000'), Flags: TF_SET_NO_RIPPLE }), 'eng trust line')
    must(await sendSimple(this.client, eng, { TransactionType: 'SetRegularKey', Account: eng.address, RegularKey: service.address }), 'eng RegularKey')
    must(await sendSimple(this.client, eng, { TransactionType: 'AccountSet', Account: eng.address, SetFlag: ASF_DISABLE_MASTER }), 'eng disable master')

    // Policy layer for this run
    const baseline = this.read<PolicyDoc>('policies/baseline@1.0.0.json')
    const policy = this.read<PolicyDoc>('policies/procurement@1.3.0.json')
    policy.version = '1.3.0+web'
    policy.assets!.RLUSD.issuer = issuer.address
    policy.params!.kybIssuers = [kyb.address]
    this.policy = policy
    const templates = fs.readdirSync(path.join(root, 'templates')).map((f) => this.read<Template>(`templates/${f}`))

    const expires = new Date(Date.now() + 7 * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const mandate = this.stmt(treasury, 'PRINCIPAL', 'party.mandate/1', { mandateId: 'mnd_web' }, { purpose: 'Agent procurement (web demo)', budget: '5000.00', dailyCap: '3000.00', vendors: [vendorA.address, vendorB.address], expires })

    // eng.provision/1: each signer proves possession of its key; the coordinator assembles the SignerList.
    const coord = new ProvisioningCoordinator()
    const session = coord.createSession({
      engagementId: this.engagementId, template: 'owner-wallet/procurement@1', account: eng.address, asset: 'RLUSD', quorum: 2,
      roles: [{ role: 'owner', weight: 2 }, { role: 'agent', weight: 1 }, { role: 'cosigner', weight: 1 }],
      attesters: { approver: { accounts: [controller.address] }, vendor: { accounts: [vendorA.address, vendorB.address] } },
      deleteTo: service.address, funder: treasury.address, fundingAmount: '5000', mandate, policyLayers: [layerHash(policy)],
    })
    const enrolments = { owner: makeEnrolment(session, 'owner', treasury), agent: makeEnrolment(session, 'agent', agent), cosigner: makeEnrolment(session, 'cosigner', cosigner) }
    for (const e of Object.values(enrolments)) coord.enrol(e)
    const plan = coord.plan(session.sessionId)

    // Open the engagement account with the protocol's SignerList.
    const seq = Number(((await accountInfo(this.client, eng.address))!.account_data as Json).Sequence)
    const tSeq = Number(((await accountInfo(this.client, treasury.address))!.account_data as Json).Sequence)
    const { tx } = buildOpenBatch({
      eng: eng.address, funder: treasury.address, currency: CUR, issuer: issuer.address, amount: plan.fundingAmount,
      signerEntries: plan.signerEntries, quorum: plan.quorum, seq, funderSeq: tSeq, ticketCount: 0,
      memos: [memo('eng/open', `${this.engagementId}|template=owner-wallet/procurement@1`)], fees: this.fees,
    })
    addBatchSigner(treasury, tx)
    const open = await submit(this.client, service.sign(tx as never).tx_blob)
    const inn = await innerResults(this.client, tx)
    if (open.final !== 'tesSUCCESS' || !inn.every((i) => i.applied)) throw new Error(`open failed: ${open.final} / ${inn.map((i) => i.result).join(',')}`)

    // Register with an in-process co-signer and build the agent.
    const dataDir = path.join(here, '..', '.web-decisions', this.engagementId)
    this.svc = new CosignerService({ wallet: cosigner, source: new XrplLedgerSource(this.client), templates, policies: [baseline, policy], dataDir })
    this.svc.register(plan.engagement, mandate)
    this.agent = new EngagementAgent({ engagementId: this.engagementId, account: eng.address, signer: localSigner(agent), asset: { code: 'RLUSD', currency: CUR, issuer: issuer.address }, decider: this.svc, chain: new XrplChain(this.client), stage: 'spend' })
    this.provisioned = true

    const roleOf: Record<string, string> = { [treasury.address]: 'owner', [agent.address]: 'agent', [cosigner.address]: 'cosigner' }
    return {
      engagementId: this.engagementId, account: eng.address, explorer: this.explorer, quorum: plan.quorum,
      signers: plan.signerEntries.map(([address, weight]) => ({ role: roleOf[address] ?? '?', address, weight, proofVerified: true })),
      mandate: { purpose: 'Agent procurement (web demo)', budget: '5000.00', dailyCap: '3000.00', approvalOver: '1000.00', vendors: [{ label: 'Vendor A', address: vendorA.address }, { label: 'Vendor B', address: vendorB.address }] },
      accounts: { issuer: issuer.address, owner: treasury.address, service: service.address, agent: agent.address, cosigner: cosigner.address, controller: controller.address, vendorA: vendorA.address, vendorB: vendorB.address, stranger: stranger.address, kyb: kyb.address },
      openTx: open.hash, balance: await iouBalance(this.client, eng.address, CUR, issuer.address), session: { id: session.sessionId },
    }
  }

  // Procurement, but leasing a pre-aged account from the warm pool instead of pre-creating one.
  // The leased account already carries its RLUSD trust line to the fixed demo issuer, the pool
  // service as RegularKey, and a disabled master, and has aged past the AccountDelete window — so
  // open is instant and close/reclaim is instant. RLUSD is minted by a fixed demo issuer we control
  // (ENG_DEMO_ISSUER_SEED), so there is no faucet cap. Close routes to reclaim().
  private async provisionProcurementPooled(): Promise<ProvisionResult> {
    this.engagementId = `eng_web_${Date.now().toString(36)}`
    const issuer = xrpl.Wallet.fromSeed(reqEnv('ENG_DEMO_ISSUER_SEED')); this.w.issuer = issuer // fixed demo RLUSD issuer (we mint)
    const treasury = await this.fund('treasury')   // the owner (SignerList weight 2) + funder of the budget
    const vendorA = await this.fund('vendorA')
    const vendorB = await this.fund('vendorB')
    const stranger = await this.fund('stranger')
    const kyb = await this.fund('kyb')
    const agent = xrpl.Wallet.generate(); this.w.agent = agent
    const cosigner = xrpl.Wallet.generate(); this.w.cosigner = cosigner
    const controller = xrpl.Wallet.generate(); this.w.controller = controller
    this.vendorByAddr.set(vendorA.address, { wallet: vendorA, label: 'Vendor A' })
    this.vendorByAddr.set(vendorB.address, { wallet: vendorB, label: 'Vendor B' })
    this.vendorByAddr.set(stranger.address, { wallet: stranger, label: 'Stranger' })

    // Token + KYB. DefaultRipple on the fixed issuer is idempotent across runs.
    must(await sendSimple(this.client, issuer, { TransactionType: 'AccountSet', Account: issuer.address, SetFlag: ASF_DEFAULT_RIPPLE }), 'DefaultRipple')
    for (const v of [treasury, vendorA, vendorB, stranger]) must(await sendSimple(this.client, v, { TransactionType: 'TrustSet', Account: v.address, LimitAmount: iou(CUR, issuer.address, '10000000') }), 'trust line')
    must(await sendSimple(this.client, issuer, { TransactionType: 'Payment', Account: issuer.address, Destination: treasury.address, Amount: iou(CUR, issuer.address, '20000') }), 'issue')
    for (const v of [vendorA, vendorB]) {
      must(await sendSimple(this.client, kyb, { TransactionType: 'CredentialCreate', Account: kyb.address, Subject: v.address, CredentialType: hex('KYB_VERIFIED') }), 'KYB create')
      must(await sendSimple(this.client, v, { TransactionType: 'CredentialAccept', Account: v.address, Issuer: kyb.address, CredentialType: hex('KYB_VERIFIED') }), 'KYB accept')
    }

    // Lease a ready, pre-aged account from the pool (already trust-lined to the issuer, service RegularKey, master disabled).
    const leased = await this.pool!.lease(this.engagementId)
    if (!leased) throw new Error('pool has no ready account — run `npm run pool:topup` and let one age to ready')
    const eng = xrpl.Wallet.fromSeed(leased.seed); this.eng = eng; this.w.engagement = eng
    this.pooled = true

    // Policy layer for this run
    const baseline = this.read<PolicyDoc>('policies/baseline@1.0.0.json')
    const policy = this.read<PolicyDoc>('policies/procurement@1.3.0.json')
    policy.version = '1.3.0+web'
    policy.assets!.RLUSD.issuer = issuer.address
    policy.params!.kybIssuers = [kyb.address]
    this.policy = policy
    const templates = fs.readdirSync(path.join(root, 'templates')).map((f) => this.read<Template>(`templates/${f}`))

    const expires = new Date(Date.now() + 7 * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const mandate = this.stmt(treasury, 'PRINCIPAL', 'party.mandate/1', { mandateId: 'mnd_web' }, { purpose: 'Agent procurement (web demo)', budget: '5000.00', dailyCap: '3000.00', vendors: [vendorA.address, vendorB.address], expires })

    // eng.provision/1: each signer proves possession of its key; the coordinator assembles the SignerList.
    const coord = new ProvisioningCoordinator()
    const session = coord.createSession({
      engagementId: this.engagementId, template: 'owner-wallet/procurement@1', account: eng.address, asset: 'RLUSD', quorum: 2,
      roles: [{ role: 'owner', weight: 2 }, { role: 'agent', weight: 1 }, { role: 'cosigner', weight: 1 }],
      attesters: { approver: { accounts: [controller.address] }, vendor: { accounts: [vendorA.address, vendorB.address] } },
      deleteTo: this.poolSponsor.address, funder: treasury.address, fundingAmount: '5000', mandate, policyLayers: [layerHash(policy)],
    })
    const enrolments = { owner: makeEnrolment(session, 'owner', treasury), agent: makeEnrolment(session, 'agent', agent), cosigner: makeEnrolment(session, 'cosigner', cosigner) }
    for (const e of Object.values(enrolments)) coord.enrol(e)
    const plan = coord.plan(session.sessionId)

    // Open the engagement account with the protocol's SignerList. Outer Batch.Account = eng, signed by
    // the pool service (the eng's RegularKey); treasury batch-signs its RLUSD funding inner tx.
    const seq = Number(((await accountInfo(this.client, eng.address))!.account_data as Json).Sequence)
    const tSeq = Number(((await accountInfo(this.client, treasury.address))!.account_data as Json).Sequence)
    const { tx } = buildOpenBatch({
      eng: eng.address, funder: treasury.address, currency: CUR, issuer: issuer.address, amount: plan.fundingAmount,
      signerEntries: plan.signerEntries, quorum: plan.quorum, seq, funderSeq: tSeq, ticketCount: 0,
      memos: [memo('eng/open', `${this.engagementId}|template=owner-wallet/procurement@1|pooled`)], fees: this.fees,
    })
    addBatchSigner(treasury, tx)
    const open = await submit(this.client, this.poolService.sign(tx as never).tx_blob)
    const inn = await innerResults(this.client, tx)
    if (open.final !== 'tesSUCCESS' || !inn.every((i) => i.applied)) throw new Error(`open failed: ${open.final} / ${inn.map((i) => i.result).join(',')}`)

    // Register with an in-process co-signer and build the agent.
    const dataDir = path.join(here, '..', '.web-decisions', this.engagementId)
    this.svc = new CosignerService({ wallet: cosigner, source: new XrplLedgerSource(this.client), templates, policies: [baseline, policy], dataDir })
    this.svc.register(plan.engagement, mandate)
    this.agent = new EngagementAgent({ engagementId: this.engagementId, account: eng.address, signer: localSigner(agent), asset: { code: 'RLUSD', currency: CUR, issuer: issuer.address }, decider: this.svc, chain: new XrplChain(this.client), stage: 'spend' })
    this.provisioned = true

    const roleOf: Record<string, string> = { [treasury.address]: 'owner', [agent.address]: 'agent', [cosigner.address]: 'cosigner' }
    return {
      engagementId: this.engagementId, account: eng.address, explorer: this.explorer, quorum: plan.quorum,
      signers: plan.signerEntries.map(([address, weight]) => ({ role: roleOf[address] ?? '?', address, weight, proofVerified: true })),
      mandate: { purpose: 'Agent procurement (web demo)', budget: '5000.00', dailyCap: '3000.00', approvalOver: '1000.00', vendors: [{ label: 'Vendor A', address: vendorA.address }, { label: 'Vendor B', address: vendorB.address }] },
      accounts: { issuer: issuer.address, owner: treasury.address, service: this.poolService.address, agent: agent.address, cosigner: cosigner.address, controller: controller.address, vendorA: vendorA.address, vendorB: vendorB.address, stranger: stranger.address, kyb: kyb.address },
      openTx: open.hash, balance: await iouBalance(this.client, eng.address, CUR, issuer.address), session: { id: session.sessionId },
    }
  }

  /** Live close for a pooled engagement. The open Batch removed the account's RegularKey, so an
   *  opened engagement is controlled by its SignerList — NOT the pool service key. Teardown is
   *  therefore signed by the owner (weight 2 = quorum 2): sweep any leftover RLUSD back to the
   *  treasury, remove the trust line, AccountDelete to the operating account — each a separate
   *  multisigned tx. Instant, because the account aged in the pool before the deal. The pool store
   *  is then marked closed (bookkeeping only; the ledger teardown already happened here). */
  async reclaim(): Promise<ReclaimResult> {
    if (!this.pool || !this.pooled) throw new Error('reclaim is only available in pooled mode (ENG_USE_POOL=1)')
    const eng = this.eng.address
    const issuer = this.w.issuer.address
    const owner = this.w.treasury           // SignerList owner, weight 2 = quorum 2
    const op = this.poolSponsor.address
    // Build → autofill (1 multisigner, so fees + the AccountDelete special fee are correct) → owner-multisign → submit.
    const quorumSend = async (body: Json, label: string): Promise<string> => {
      const prepared = await this.client.autofill(body as never, 1) as unknown as Json
      return must(await submit(this.client, combine([multisignBlob(owner, prepared)])), label).hash
    }
    let sweepTx: string | undefined
    const bal = await iouBalance(this.client, eng, CUR, issuer)
    if (bal && Number(bal) > 0) {
      sweepTx = await quorumSend({ TransactionType: 'Payment', Account: eng, Destination: owner.address, Amount: iou(CUR, issuer, bal) }, 'sweep')
    }
    const removeTrustlineTx = await quorumSend({ TransactionType: 'TrustSet', Account: eng, LimitAmount: iou(CUR, issuer, '0'), Flags: TF_SET_NO_RIPPLE }, 'remove trust line')
    const accountDeleteTx = await quorumSend({ TransactionType: 'AccountDelete', Account: eng, Destination: op }, 'AccountDelete')
    await this.pool.markClosed(eng) // ledger teardown done above; just update pool state + wipe the seed
    this.pooled = false
    this.provisioned = false
    return { closed: true, account: eng, reclaimedTo: op, sweepTx, removeTrustlineTx, accountDeleteTx, explorer: this.explorer }
  }

  private async provisionEscrow(): Promise<ProvisionResult> {
    this.engagementId = `eng_web_esc_${Date.now().toString(36)}`
    const issuer = await this.fund('issuer')
    const buyer = await this.fund('buyer')
    const seller = await this.fund('seller')
    const service = await this.fund('service')
    const arbiter = xrpl.Wallet.generate(); this.w.arbiter = arbiter
    const cosigner = xrpl.Wallet.generate(); this.w.cosigner = cosigner
    const attester = xrpl.Wallet.generate(); this.w.attester = attester
    const agent = xrpl.Wallet.generate(); this.w.agent = agent // optional AI booking agent — the principal's delegate (never funds)

    must(await sendSimple(this.client, issuer, { TransactionType: 'AccountSet', Account: issuer.address, SetFlag: ASF_DEFAULT_RIPPLE }), 'DefaultRipple')
    for (const v of [buyer, seller, service]) must(await sendSimple(this.client, v, { TransactionType: 'TrustSet', Account: v.address, LimitAmount: iou(CUR, issuer.address, '10000000') }), 'trust line')
    must(await sendSimple(this.client, issuer, { TransactionType: 'Payment', Account: issuer.address, Destination: buyer.address, Amount: iou(CUR, issuer.address, '2000') }), 'issue to buyer')

    const eng = xrpl.Wallet.generate(); this.eng = eng; this.w.engagement = eng
    must(await sendSimple(this.client, service, { TransactionType: 'Payment', Account: service.address, Destination: eng.address, Amount: xrpl.xrpToDrops(3) }), 'create account')
    must(await sendSimple(this.client, eng, { TransactionType: 'TrustSet', Account: eng.address, LimitAmount: iou(CUR, issuer.address, '1000000000'), Flags: TF_SET_NO_RIPPLE }), 'eng trust line')
    must(await sendSimple(this.client, eng, { TransactionType: 'SetRegularKey', Account: eng.address, RegularKey: service.address }), 'eng RegularKey')
    must(await sendSimple(this.client, eng, { TransactionType: 'AccountSet', Account: eng.address, SetFlag: ASF_DISABLE_MASTER }), 'eng disable master')

    const expires = new Date(Date.now() + 7 * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const mandate = this.stmt(buyer, 'PRINCIPAL', 'party.mandate/1', { mandateId: 'mnd_web_esc' }, { purpose: 'Lisbon booking (web demo)', total: { value: '412.00', currency: 'RLUSD' }, city: 'Lisbon', expires })

    const coord = new ProvisioningCoordinator()
    const session = coord.createSession({
      engagementId: this.engagementId, template: 'settlement-vault/hotel@1', account: eng.address, asset: 'RLUSD', quorum: 5,
      roles: [{ role: 'agent', weight: 2 }, { role: 'counterparty', weight: 2 }, { role: 'arbiter', weight: 3 }, { role: 'cosigner', weight: 1 }],
      attesters: { attester: { accounts: [attester.address] }, arbiter: { accounts: [arbiter.address] } },
      deleteTo: service.address, funder: buyer.address, fundingAmount: '412', mandate,
    })
    for (const [role, wal] of [['agent', agent], ['counterparty', seller], ['arbiter', arbiter], ['cosigner', cosigner]] as Array<[string, Wallet]>) coord.enrol(makeEnrolment(session, role, wal))
    const plan = coord.plan(session.sessionId)

    const seq = Number(((await accountInfo(this.client, eng.address))!.account_data as Json).Sequence)
    const bSeq = Number(((await accountInfo(this.client, buyer.address))!.account_data as Json).Sequence)
    const { tx } = buildOpenBatch({
      eng: eng.address, funder: buyer.address, currency: CUR, issuer: issuer.address, amount: '412',
      signerEntries: plan.signerEntries, quorum: 5, seq, funderSeq: bSeq, ticketCount: 0,
      memos: [memo('eng/open', `${this.engagementId}|template=settlement-vault/hotel@1`)], fees: this.fees,
    })
    addBatchSigner(buyer, tx)
    const open = await submit(this.client, service.sign(tx as never).tx_blob)
    const innr = await innerResults(this.client, tx)
    if (open.final !== 'tesSUCCESS' || !innr.every((i) => i.applied)) throw new Error(`open failed: ${open.final} / ${innr.map((i) => i.result).join(',')}`)

    this.escrowBal = 412
    this.provisioned = true

    const asOf: Record<string, string> = { [seller.address]: 'seller', [agent.address]: "buyer's delegate" }
    const roleOf: Record<string, string> = { [seller.address]: 'counterparty', [arbiter.address]: 'arbiter', [cosigner.address]: 'cosigner', [agent.address]: 'agent' }
    return {
      engagementId: this.engagementId, account: eng.address, explorer: this.explorer, quorum: 5,
      signers: plan.signerEntries.map(([address, weight]) => ({ role: roleOf[address] ?? '?', address, weight, proofVerified: true, as: asOf[address], note: roleOf[address] === 'agent' ? 'the buyer funds the vault and delegated signing to this agent' : undefined })),
      mandate: { purpose: 'Lisbon booking (web demo)', budget: '412.00', dailyCap: '412.00', approvalOver: '0.00', vendors: [{ label: 'Seller', address: seller.address }] },
      accounts: { issuer: issuer.address, buyer: buyer.address, seller: seller.address, arbiter: arbiter.address, cosigner: cosigner.address, attester: attester.address, agent: agent.address, service: service.address },
      openTx: open.hash, balance: '412.00', session: { id: session.sessionId },
    }
  }

  private async provisionBond(): Promise<ProvisionResult> {
    this.engagementId = `eng_web_bond_${Date.now().toString(36)}`
    const issuer = await this.fund('issuer')
    const seller = await this.fund('seller')
    const buyer = await this.fund('buyer')
    const service = await this.fund('service')
    const arbiter = xrpl.Wallet.generate(); this.w.arbiter = arbiter
    const cosigner = xrpl.Wallet.generate(); this.w.cosigner = cosigner
    const agent = xrpl.Wallet.generate(); this.w.agent = agent // optional AI agent — the seller's delegate (never stakes the bond)

    must(await sendSimple(this.client, issuer, { TransactionType: 'AccountSet', Account: issuer.address, SetFlag: ASF_DEFAULT_RIPPLE }), 'DefaultRipple')
    for (const v of [seller, buyer, service]) must(await sendSimple(this.client, v, { TransactionType: 'TrustSet', Account: v.address, LimitAmount: iou(CUR, issuer.address, '10000000') }), 'trust line')
    must(await sendSimple(this.client, issuer, { TransactionType: 'Payment', Account: issuer.address, Destination: seller.address, Amount: iou(CUR, issuer.address, '3000') }), 'issue to seller')

    const eng = xrpl.Wallet.generate(); this.eng = eng; this.w.engagement = eng
    must(await sendSimple(this.client, service, { TransactionType: 'Payment', Account: service.address, Destination: eng.address, Amount: xrpl.xrpToDrops(3) }), 'create account')
    must(await sendSimple(this.client, eng, { TransactionType: 'TrustSet', Account: eng.address, LimitAmount: iou(CUR, issuer.address, '1000000000'), Flags: TF_SET_NO_RIPPLE }), 'eng trust line')
    must(await sendSimple(this.client, eng, { TransactionType: 'SetRegularKey', Account: eng.address, RegularKey: service.address }), 'eng RegularKey')
    must(await sendSimple(this.client, eng, { TransactionType: 'AccountSet', Account: eng.address, SetFlag: ASF_DISABLE_MASTER }), 'eng disable master')

    const expires = new Date(Date.now() + 7 * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const mandate = this.stmt(seller, 'PRINCIPAL', 'party.mandate/1', { mandateId: 'mnd_web_bond' }, { purpose: 'Collateral bond (web demo)', bond: { value: '1000.00', currency: 'RLUSD' }, expires })

    const coord = new ProvisioningCoordinator()
    const session = coord.createSession({
      engagementId: this.engagementId, template: 'collateral-bond/marketplace@1', account: eng.address, asset: 'RLUSD', quorum: 5,
      roles: [{ role: 'agent', weight: 2 }, { role: 'buyer', weight: 2 }, { role: 'arbiter', weight: 3 }, { role: 'cosigner', weight: 1 }],
      attesters: { arbiter: { accounts: [arbiter.address] } },
      deleteTo: service.address, funder: seller.address, fundingAmount: '1000', mandate,
    })
    for (const [role, wal] of [['agent', agent], ['buyer', buyer], ['arbiter', arbiter], ['cosigner', cosigner]] as Array<[string, Wallet]>) coord.enrol(makeEnrolment(session, role, wal))
    const plan = coord.plan(session.sessionId)

    const seq = Number(((await accountInfo(this.client, eng.address))!.account_data as Json).Sequence)
    const sSeq = Number(((await accountInfo(this.client, seller.address))!.account_data as Json).Sequence)
    const { tx } = buildOpenBatch({
      eng: eng.address, funder: seller.address, currency: CUR, issuer: issuer.address, amount: '1000',
      signerEntries: plan.signerEntries, quorum: 5, seq, funderSeq: sSeq, ticketCount: 0,
      memos: [memo('eng/open', `${this.engagementId}|template=collateral-bond/marketplace@1`)], fees: this.fees,
    })
    addBatchSigner(seller, tx)
    const open = await submit(this.client, service.sign(tx as never).tx_blob)
    const innr = await innerResults(this.client, tx)
    if (open.final !== 'tesSUCCESS' || !innr.every((i) => i.applied)) throw new Error(`open failed: ${open.final} / ${innr.map((i) => i.result).join(',')}`)

    this.escrowBal = 1000
    this.provisioned = true

    const roleOf: Record<string, string> = { [buyer.address]: 'buyer', [arbiter.address]: 'arbiter', [cosigner.address]: 'cosigner', [agent.address]: 'agent' }
    const asOf: Record<string, string> = { [agent.address]: "seller's delegate" }
    return {
      engagementId: this.engagementId, account: eng.address, explorer: this.explorer, quorum: 5,
      signers: plan.signerEntries.map(([address, weight]) => ({ role: roleOf[address] ?? '?', address, weight, proofVerified: true, as: asOf[address], note: roleOf[address] === 'agent' ? 'the seller stakes the bond and delegated signing to this agent' : undefined })),
      mandate: { purpose: 'Collateral bond (web demo)', budget: '1000.00', dailyCap: '1000.00', approvalOver: '0.00', vendors: [] },
      accounts: { issuer: issuer.address, seller: seller.address, buyer: buyer.address, arbiter: arbiter.address, cosigner: cosigner.address, agent: agent.address, service: service.address },
      openTx: open.hash, balance: '1000.00', session: { id: session.sessionId },
    }
  }

  private payoutBatch(eng: string, issuer: string, payouts: Array<{ to: string; value: string }>, seq: number, lls: number, signatures: number, mode: string): Json {
    const raw = payouts.map((p, i) => inner({ TransactionType: 'Payment', Account: eng, Destination: p.to, Amount: iou(CUR, issuer, p.value) }, { Sequence: seq + 1 + i }))
    const tx: Json = { TransactionType: 'Batch', Account: eng, Flags: TF_ALL_OR_NOTHING, Sequence: seq, LastLedgerSequence: lls, RawTransactions: raw, SigningPubKey: '', Memos: [memo('eng/basis', 'settle'), memo('eng/mode', mode)] }
    tx.Fee = batchFee({ base: this.fees.base, inc: this.fees.inc, innerTxs: raw, signatures })
    return tx
  }

  /** Escrow settlement (no AccountDelete, to keep the demo fast). */
  async escrow(input: { path: string }): Promise<EscrowResult> {
    if (!this.provisioned || (this.scenario !== 'escrow' && this.scenario !== 'bond')) throw new Error('vault not provisioned')
    const eng = this.eng.address, issuer = this.w.issuer.address
    const buyer = this.w.buyer, seller = this.w.seller, arbiter = this.w.arbiter, cosigner = this.w.cosigner, service = this.w.service, agent = this.w.agent
    const seq = Number(((await accountInfo(this.client, eng))!.account_data as Json).Sequence)
    const lls = (await currentLedger(this.client)) + 20
    const total = this.escrowBal

    if (input.path === 'solo') {
      const soloSigner = this.scenario === 'bond' ? agent : seller // bond: the seller delegated signing to its agent, so the seller-side key is the agent
      const tx = this.payoutBatch(eng, issuer, [{ to: seller.address, value: String(total) }], seq, lls, 1, 'solo')
      const r = await submit(this.client, combine([multisignBlob(soloSigner, tx)]), { waitLedgers: 5 })
      return { path: 'solo', settled: false, final: r.final, tx: r.hash, checks: [['One party signature attached (weight 2)', true], ['Reaches quorum of 5', false]], payouts: null }
    }
    if (input.path === 'agreed') {
      const fee = Math.round(total * 0.005 * 100) / 100
      const toSeller = Math.round((total - fee) * 100) / 100
      const tx = this.payoutBatch(eng, issuer, [{ to: seller.address, value: toSeller.toFixed(2) }, { to: service.address, value: fee.toFixed(2) }], seq, lls, 3, 'agreed')
      const r = await submit(this.client, combine([multisignBlob(agent, tx), multisignBlob(seller, tx), multisignBlob(cosigner, tx)]))
      const ok = r.final === 'tesSUCCESS'; if (ok) this.escrowBal = 0
      return { path: 'agreed', settled: ok, final: r.final, tx: r.hash, checks: [['The buyer’s agent authorized the release (weight 2 — the buyer delegated signing to it)', true], ['Seller confirmed the booking (matches the mandate)', true], ['Co-signer policy passed (agreed seller, agreed amount, delivery attested)', true], ['Agent + seller + co-signer = quorum 5', ok]], payouts: [['Seller (Atlas Stays)', toSeller.toFixed(2)], ['Service fee', fee.toFixed(2)]] }
    }
    if (input.path === 'bond_release') {
      const tx = this.payoutBatch(eng, issuer, [{ to: seller.address, value: total.toFixed(2) }], seq, lls, 3, 'bond_release')
      const r = await submit(this.client, combine([multisignBlob(agent, tx), multisignBlob(buyer, tx), multisignBlob(cosigner, tx)]))
      const ok = r.final === 'tesSUCCESS'; if (ok) this.escrowBal = 0
      return { path: 'bond_release', settled: ok, final: r.final, tx: r.hash, checks: [['The seller’s agent authorized the return (weight 2 — the seller delegated signing to it)', true], ['Buyer confirmed the deal was delivered', true], ['No open complaint', true], ['Agent + buyer + co-signer = quorum 5', ok]], payouts: [['Seller (bond returned)', total.toFixed(2)]] }
    }
    if (input.path === 'bond_slash') {
      const sBuyer = Math.round(total * 0.70 * 100) / 100
      const sSeller = Math.round(total * 0.30 * 100) / 100
      const tx = this.payoutBatch(eng, issuer, [{ to: buyer.address, value: sBuyer.toFixed(2) }, { to: seller.address, value: sSeller.toFixed(2) }], seq, lls, 2, 'bond_slash')
      const r = await submit(this.client, combine([multisignBlob(arbiter, tx), multisignBlob(buyer, tx)]))
      const ok = r.final === 'tesSUCCESS'; if (ok) this.escrowBal = 0
      return { path: 'bond_slash', settled: ok, final: r.final, tx: r.hash, checks: [['Buyer filed a complaint (harm)', true], ['Arbiter reviewed the evidence', true], ['Slash is within the bond', true], ['Arbiter + buyer reach quorum 5', ok]], payouts: [['Buyer (compensation, 70%)', sBuyer.toFixed(2)], ['Seller (returned, 30%)', sSeller.toFixed(2)]] }
    }
    const toSeller = Math.round(total * 0.70 * 100) / 100
    const toBuyer = Math.round(total * 0.30 * 100) / 100
    const tx = this.payoutBatch(eng, issuer, [{ to: seller.address, value: toSeller.toFixed(2) }, { to: buyer.address, value: toBuyer.toFixed(2) }], seq, lls, 2, 'ruling')
    const r = await submit(this.client, combine([multisignBlob(arbiter, tx), multisignBlob(agent, tx)]))
    const ok = r.final === 'tesSUCCESS'; if (ok) this.escrowBal = 0
    return { path: 'ruling', settled: ok, final: r.final, tx: r.hash, checks: [['A dispute was opened (ENG/DISPUTE + bond)', true], ['Arbiter is accredited', true], ['Ruling is single-use and signed by the arbiter', true], ['Arbiter + the buyer’s agent reach quorum 5', ok]], payouts: [['Seller (70%)', toSeller.toFixed(2)], ['Buyer refund (30%)', toBuyer.toFixed(2)]] }
  }

  /** x402 metered purchase: the agent pays a merchant's challenge; W7 binds the co-signature to it. */
  async x402(input: { path: string; scheme?: string }): Promise<X402Result> {
    if (!this.provisioned || (this.scenario !== 'x402' && this.scenario !== 'mpp')) throw new Error('x402/mpp not provisioned')
    const vendorA = this.w.vendorA, vendorB = this.w.vendorB, agent = this.w.agent
    const scheme = input.scheme === 'mpp' ? 'mpp' : 'x402'
    const challengeStmt = (payTo: string, invoiceId: string): Statement => this.stmt(agent, 'AGENT', 'payment.challenge/1', { invoiceId }, { scheme, payTo, amount: '800.00', asset: 'RLUSD', invoiceId, resource: 'premium.csv' })
    const invoiceStmt = (vendor: Wallet, invoiceId: string): Statement => this.stmt(vendor, 'VENDOR', 'party.invoice/1', { invoiceRef: invoiceId }, { invoiceRef: invoiceId, amount: '800.00', currency: 'RLUSD', po: 'PO-X402' })
    const fresh = (): string => `x402_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`

    if (input.path === 'x402_ok') {
      const invoiceId = fresh()
      const inv = invoiceStmt(vendorA, invoiceId)
      const { proposal, submit } = await this.agent.payVendor({ destination: vendorA.address, amount: '800.00', invoiceRef: invoiceId, statements: [inv, challengeStmt(vendorA.address, invoiceId)] })
      const ok = submit?.final === 'tesSUCCESS'
      if (ok) { this.lastX402Invoice = invoiceId; this.lastX402Stmt = inv }
      return { settled: ok, tx: submit?.hash, final: submit?.final, invoiceId, resource: 'premium.csv', checks: this.x402checks(proposal.decision), reason: ok ? undefined : `co-signer did not sign (${proposal.decision.failing.join(',') || 'see log'})` }
    }
    if (input.path === 'x402_redirect') {
      const invoiceId = fresh()
      // the challenge names vendor A (DataCo), but the agent pays vendor B (MapsAPI)
      const p = await this.agent.proposePayment({ destination: vendorB.address, amount: '800.00', invoiceRef: invoiceId, statements: [invoiceStmt(vendorB, invoiceId), challengeStmt(vendorA.address, invoiceId)] })
      return { settled: false, invoiceId, checks: this.x402checks(p.decision), reason: 'the payment pays a different merchant than the challenge names (W7: X402_CHALLENGE_MISMATCH)' }
    }
    // replay: re-present the consumed invoice from the last purchase
    if (!this.lastX402Invoice || !this.lastX402Stmt) {
      return { settled: false, invoiceId: '(none)', checks: [['Payee is the merchant named in the challenge', true], ['Amount matches the challenge', true], ['Payment is bound to the challenge invoice', true], ['Challenge has not been spent before', false]], reason: 'buy a resource first, then replay its challenge' }
    }
    const invoiceId = this.lastX402Invoice
    const p = await this.agent.proposePayment({ destination: vendorA.address, amount: '800.00', invoiceRef: invoiceId, statements: [this.lastX402Stmt, challengeStmt(vendorA.address, invoiceId)] })
    return { settled: false, invoiceId, checks: this.x402checks(p.decision), reason: 'this challenge was already spent — the invoice is single-use (CONSUMED)' }
  }

  private x402checks(decision: { failing: string[]; statementsRejected: Array<{ code: string }> }): Array<[string, boolean]> {
    const f = decision.failing || []
    const w7bad = f.includes('W7')
    const rejected = (decision.statementsRejected || []).map((r) => r.code)
    const consumed = f.includes('W6') || rejected.includes('CONSUMED')
    return [
      ['Payee is the merchant named in the challenge', !w7bad],
      ['Amount matches the challenge', !w7bad],
      ['Payment is bound to the challenge invoice', !w7bad],
      ['Challenge has not been spent before', !consumed],
    ]
  }

  private statementsFor(destination: string, amount: string, invoiceRef: string, withApproval: boolean): Statement[] {
    const v = this.vendorByAddr.get(destination)
    const out: Statement[] = []
    if (v) out.push(this.stmt(v.wallet, 'VENDOR', 'party.invoice/1', { invoiceRef }, { invoiceRef, amount, currency: 'RLUSD', po: 'PO-WEB' }))
    if (withApproval) {
      const rlusd = this.policy.assets!.RLUSD
      const intentHash = intentHashOf(destination, parseAmount(amount, rlusd), rlusd.decimals, invoiceRef)
      out.push(this.stmt(this.w.controller, 'APPROVER', 'approval.payment/1', { intentHash }, { approverRole: 'controller', notAfter: new Date(Date.now() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), comment: 'web demo approval' }))
    }
    return out
  }

  private reasons(failing: string[]): string[] { return failing.map((f) => RULE_TEXT[f] ? `${f}: ${RULE_TEXT[f]}` : f) }

  async pay(input: { destination: string; amount: string; invoiceRef: string; withApproval?: boolean }): Promise<PayResult> {
    if (!this.provisioned) throw new Error('not provisioned')
    const statements = this.statementsFor(input.destination, input.amount, input.invoiceRef, !!input.withApproval)
    const { proposal, submit: s } = await this.agent.payVendor({ destination: input.destination, amount: input.amount, invoiceRef: input.invoiceRef, statements })
    const issuer = this.w.issuer.address
    return { decision: proposal.decision.decision, failing: proposal.decision.failing, reasons: this.reasons(proposal.decision.failing), settled: s?.final === 'tesSUCCESS', tx: s?.hash, final: s?.final, balance: await iouBalance(this.client, input.destination, CUR, issuer) }
  }

  async propose(input: { destination: string; amount: string; invoiceRef: string; withApproval?: boolean }): Promise<PayResult & { combinedBlob?: string }> {
    if (!this.provisioned) throw new Error('not provisioned')
    const statements = this.statementsFor(input.destination, input.amount, input.invoiceRef, !!input.withApproval)
    const p = await this.agent.proposePayment({ destination: input.destination, amount: input.amount, invoiceRef: input.invoiceRef, statements })
    return { decision: p.decision.decision, failing: p.decision.failing, reasons: this.reasons(p.decision.failing), settled: false, combinedBlob: p.combined, balance: null }
  }

  async status(): Promise<StatusResult> {
    if (!this.provisioned) throw new Error('not provisioned')
    const issuer = this.w.issuer.address
    return {
      balances: {
        engagement: await iouBalance(this.client, this.eng.address, CUR, issuer),
        vendorA: await iouBalance(this.client, this.w.vendorA.address, CUR, issuer),
        vendorB: await iouBalance(this.client, this.w.vendorB.address, CUR, issuer),
      },
      decisions: this.svc.decisions(this.engagementId).map((d) => ({ stage: (d.subject as Json).stage, decision: d.claim.decision, failing: d.claim.failing })),
    }
  }
}
