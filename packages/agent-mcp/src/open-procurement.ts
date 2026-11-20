// Open an owner-wallet/procurement@1 engagement on XRPL Testnet.
// The IOU minted here is a demo token. It is not RLUSD.
import xrpl from 'xrpl'
import { newNonce, signStatement, type Statement, type StatementBody } from '@eng/core'
import type { EngagementRecord } from '@eng/policy'
import {
  ASF_DEFAULT_RIPPLE, ASF_DISABLE_MASTER, LSF_DISABLE_MASTER, TF_SET_NO_RIPPLE,
  accountInfo, addBatchSigner, buildOpenBatch, currencyHex, hex, innerResults, iou, iouBalance, memo,
  sendSimple, serverFees, sleep, submit,
  type Fees,
} from '@eng/ledger'

type Json = Record<string, unknown>
type Wallet = InstanceType<typeof xrpl.Wallet>
type Client = InstanceType<typeof xrpl.Client>

export const DEMO_IOU_NOTE = 'Demo IOU minted for this Testnet engagement. Not RLUSD.'
export const PROCUREMENT_TEMPLATE = 'owner-wallet/procurement@1' as const
const OPEN_AMOUNT = '5000'
const FAUCET_ATTEMPTS = 5

export interface OpenIo {
  fund(): Promise<Wallet>
  send(wallet: Wallet, tx: Json): Promise<{ final: string; hash: string }>
  submit(blob: string): Promise<{ final: string; hash: string }>
  accountInfo(account: string): Promise<Json | null>
  fees(): Promise<Fees>
  iouBalance(account: string, currency: string, issuer: string): Promise<string | null>
  innerResults(batch: Json): Promise<Array<{ applied: boolean; result: string | null }>>
  addBatchSigner(wallet: Wallet, tx: Json): void
  signBlob(wallet: Wallet, tx: Json): string
}

export interface OpenCheck {
  ok: boolean
  final: string
  hash: string
  inner: string
  regularKey: string
  quorum: unknown
  balance: string
}

export interface Provisioned {
  engagementId: string
  currency: string
  issuer: Wallet
  treasury: Wallet
  service: Wallet
  vendorA: Wallet
  vendorB: Wallet
  stranger: Wallet | null
  kyb: Wallet
  agent: Wallet
  controller: Wallet
  engagement: Wallet
  cosignerAddress: string
  record: EngagementRecord
  mandate: Statement
  open: OpenCheck
}

/** Keys and the engagement id, filled in as steps succeed. */
export interface OpenDraft {
  engagementId: string
  cosignerAddress: string
  currency: string
  issuer?: Wallet
  treasury?: Wallet
  service?: Wallet
  vendorA?: Wallet
  vendorB?: Wallet
  stranger?: Wallet | null
  kyb?: Wallet
  agent?: Wallet
  controller?: Wallet
  engagement?: Wallet
  record?: EngagementRecord
  mandate?: Statement
  open?: OpenCheck
}

export class OpenPartialError extends Error {
  readonly stage: 'cast' | 'open' | 'register'
  readonly draft: OpenDraft
  constructor(message: string, stage: 'cast' | 'open' | 'register', draft: OpenDraft) {
    super(message)
    this.name = 'OpenPartialError'
    this.stage = stage
    this.draft = draft
  }
}

export interface ProvisionOptions {
  io: OpenIo
  cosignerAddress: string
  engagementId: string
  /** Pin these layer hashes. Omit them and the running co-signer selects the template policy. */
  policyLayers?: string[]
  mandateId?: string
  purpose?: string
  /** Fund an extra account the demo pays outside the mandate. */
  stranger?: boolean
  log?: (line: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
  onAccount?: (label: string, address: string) => void
}

const must = (r: { final: string; hash: string }, label: string) => {
  if (r.final !== 'tesSUCCESS') throw new Error(`${label} failed: ${r.final} (${r.hash})`)
  return r
}

const near = (a: unknown, b: number) => Math.abs(Number(a) - b) < 1e-9

function iso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function buildProcurementMandate(o: {
  engagementId: string
  owner: Wallet
  vendors: string[]
  mandateId?: string
  purpose?: string
  now?: Date
}): Statement {
  const now = o.now ?? new Date()
  const t = iso(now)
  const expires = iso(new Date(now.getTime() + 7 * 86400_000))
  const body: StatementBody = {
    v: 'eng.att/1',
    type: 'party.mandate/1',
    engagementId: o.engagementId,
    subject: { mandateId: o.mandateId ?? 'mnd_open' },
    claim: {
      purpose: o.purpose ?? 'agent spend via eng open (Testnet demo)',
      budget: '5000.00',
      dailyCap: '3000.00',
      vendors: o.vendors,
      expires,
    },
    observedAt: t,
    issuedAt: t,
    nonce: newNonce(),
    attester: { account: o.owner.address, kind: 'PRINCIPAL' },
  }
  return signStatement(body, o.owner)
}

export function buildProcurementRecord(o: {
  engagementId: string
  engagement: Wallet
  treasury: Wallet
  agent: Wallet
  service: Wallet
  controller: Wallet
  vendorA: Wallet
  vendorB: Wallet
  issuer: Wallet
  kyb: Wallet
  cosignerAddress: string
  mandate: Statement
  policyLayers?: string[]
}): EngagementRecord {
  const trust = { 'kyb.issuer': o.kyb.address, 'rlusd.issuer': o.issuer.address }
  return {
    engagementId: o.engagementId,
    template: PROCUREMENT_TEMPLATE,
    account: o.engagement.address,
    asset: 'RLUSD',
    parties: { owner: o.treasury.address, agent: o.agent.address, cosigner: o.cosignerAddress },
    attesters: {
      approver: { accounts: [o.controller.address] },
      vendor: { accounts: [o.vendorA.address, o.vendorB.address] },
    },
    deleteTo: o.service.address,
    state: 'OPEN',
    consumed: [],
    ...(o.policyLayers?.length ? { policyLayers: o.policyLayers } : {}),
    mandateId: o.mandate.id,
    trust,
  }
}

async function fundLabeled(opts: ProvisionOptions, draft: OpenDraft, label: string): Promise<Wallet> {
  const pause = opts.sleep ?? sleep
  const log = opts.log ?? (() => {})
  let last = 'unknown'
  for (let i = 0; i < FAUCET_ATTEMPTS; i++) {
    try {
      const wallet = await opts.io.fund()
      opts.onAccount?.(label, wallet.address)
      log(`funded ${label}: ${wallet.address}`)
      return wallet
    } catch (e) {
      last = (e as Error).message
      log(`faucet retry ${label}: ${last}`)
      await pause(5_000)
    }
  }
  throw new OpenPartialError(`faucet failed for ${label}: ${last}`, 'cast', draft)
}

function generated(opts: ProvisionOptions, draft: OpenDraft, label: string): Wallet {
  const wallet = xrpl.Wallet.generate()
  opts.onAccount?.(label, wallet.address)
  return wallet
}

/** Faucet, demo-IOU mint, KYB, pre-create, and the open Batch. Does not register. */
export async function provisionProcurement(opts: ProvisionOptions): Promise<Provisioned> {
  const log = opts.log ?? (() => {})
  const currency = currencyHex('RLUSD')
  const draft: OpenDraft = { engagementId: opts.engagementId, cosignerAddress: opts.cosignerAddress, currency }
  const fail = (e: unknown): never => {
    if (e instanceof OpenPartialError) throw e
    throw new OpenPartialError((e as Error).message, draft.engagement ? 'open' : 'cast', draft)
  }
  try {
    draft.issuer = await fundLabeled(opts, draft, 'issuer')
    draft.treasury = await fundLabeled(opts, draft, 'treasury (owner)')
    draft.service = await fundLabeled(opts, draft, 'service')
    draft.vendorA = await fundLabeled(opts, draft, 'vendorA')
    draft.vendorB = await fundLabeled(opts, draft, 'vendorB')
    if (opts.stranger) draft.stranger = await fundLabeled(opts, draft, 'stranger')
    draft.kyb = await fundLabeled(opts, draft, 'kybIssuer')
    draft.agent = generated(opts, draft, 'agent')
    draft.controller = generated(opts, draft, 'controller')
    const issuer = draft.issuer
    const treasury = draft.treasury
    const service = draft.service
    const vendorA = draft.vendorA
    const vendorB = draft.vendorB
    const kyb = draft.kyb
    const agent = draft.agent
    const controller = draft.controller

    must(await opts.io.send(issuer, { TransactionType: 'AccountSet', Account: issuer.address, SetFlag: ASF_DEFAULT_RIPPLE }), 'DefaultRipple')
    const holders = [treasury, vendorA, vendorB, ...(draft.stranger ? [draft.stranger] : [])]
    for (const w of holders) {
      must(await opts.io.send(w, { TransactionType: 'TrustSet', Account: w.address, LimitAmount: iou(currency, issuer.address, '10000000') }), 'trust line')
    }
    must(await opts.io.send(issuer, { TransactionType: 'Payment', Account: issuer.address, Destination: treasury.address, Amount: iou(currency, issuer.address, '20000') }), 'issue to treasury')
    log(DEMO_IOU_NOTE)
    for (const v of [vendorA, vendorB]) {
      must(await opts.io.send(kyb, { TransactionType: 'CredentialCreate', Account: kyb.address, Subject: v.address, CredentialType: hex('KYB_VERIFIED') }), 'KYB CredentialCreate')
      must(await opts.io.send(v, { TransactionType: 'CredentialAccept', Account: v.address, Issuer: kyb.address, CredentialType: hex('KYB_VERIFIED') }), 'KYB CredentialAccept')
    }

    const engagement = xrpl.Wallet.generate()
    draft.engagement = engagement
    opts.onAccount?.('engagement', engagement.address)
    must(await opts.io.send(service, { TransactionType: 'Payment', Account: service.address, Destination: engagement.address, Amount: xrpl.xrpToDrops(3) }), 'create engagement account')
    must(await opts.io.send(engagement, { TransactionType: 'TrustSet', Account: engagement.address, LimitAmount: iou(currency, issuer.address, '1000000000'), Flags: TF_SET_NO_RIPPLE }), 'engagement trust line')
    must(await opts.io.send(engagement, { TransactionType: 'SetRegularKey', Account: engagement.address, RegularKey: service.address }), 'pre-create SetRegularKey')
    must(await opts.io.send(engagement, { TransactionType: 'AccountSet', Account: engagement.address, SetFlag: ASF_DISABLE_MASTER }), 'pre-create disable master')
    log(`pre-created ${engagement.address} (master disabled, service RegularKey)`)

    const fees = await opts.io.fees()
    const engInfo = await opts.io.accountInfo(engagement.address)
    const treasuryInfo = await opts.io.accountInfo(treasury.address)
    if (!engInfo || !treasuryInfo) throw new Error('account missing before open Batch')
    const seq = Number((engInfo.account_data as Json).Sequence)
    const funderSeq = Number((treasuryInfo.account_data as Json).Sequence)
    const { tx } = buildOpenBatch({
      eng: engagement.address, funder: treasury.address, currency, issuer: issuer.address, amount: OPEN_AMOUNT,
      signerEntries: [[treasury.address, 2], [agent.address, 1], [opts.cosignerAddress, 1]], quorum: 2,
      seq, funderSeq, ticketCount: 0,
      memos: [memo('eng/open', `${opts.engagementId}|template=${PROCUREMENT_TEMPLATE}`)], fees,
    })
    opts.io.addBatchSigner(treasury, tx)
    const submitted = await opts.io.submit(opts.io.signBlob(service, tx))
    const inn = await opts.io.innerResults(tx)
    const info = await opts.io.accountInfo(engagement.address)
    const d = (info?.account_data ?? {}) as Json
    const lists = (info?.signer_lists ?? d.signer_lists) as Json[] | undefined
    const sl = lists?.[0]
    const bal = await opts.io.iouBalance(engagement.address, currency, issuer.address)
    const open: OpenCheck = {
      ok: submitted.final === 'tesSUCCESS' && inn.every((i) => i.applied) && (Number(d.Flags) & LSF_DISABLE_MASTER) !== 0 && d.RegularKey == null && sl?.SignerQuorum === 2 && near(bal, 5000),
      final: submitted.final,
      hash: submitted.hash,
      inner: inn.map((i) => i.result).join(','),
      regularKey: d.RegularKey == null ? 'none' : String(d.RegularKey),
      quorum: sl?.SignerQuorum,
      balance: bal ?? 'none',
    }
    draft.open = open
    const mandate = buildProcurementMandate({
      engagementId: opts.engagementId,
      owner: treasury,
      vendors: [vendorA.address, vendorB.address],
      mandateId: opts.mandateId,
      purpose: opts.purpose,
      now: opts.now?.(),
    })
    const record = buildProcurementRecord({
      engagementId: opts.engagementId,
      engagement, treasury, agent, service, controller, vendorA, vendorB, issuer, kyb,
      cosignerAddress: opts.cosignerAddress,
      mandate,
      policyLayers: opts.policyLayers,
    })
    draft.mandate = mandate
    draft.record = record
    const provisioned: Provisioned = {
      engagementId: opts.engagementId,
      currency,
      issuer, treasury, service, vendorA, vendorB,
      stranger: draft.stranger ?? null,
      kyb, agent, controller, engagement,
      cosignerAddress: opts.cosignerAddress,
      record, mandate, open,
    }
    if (!open.ok) throw new OpenPartialError(`open Batch did not satisfy the procurement checks (${open.final})`, 'open', draft)
    return provisioned
  } catch (e) {
    return fail(e)
  }
}

export function xrplOpenIo(client: Client): OpenIo {
  return {
    fund: async () => (await client.fundWallet()).wallet,
    send: (wallet, tx) => sendSimple(client, wallet, tx),
    submit: (blob) => submit(client, blob),
    accountInfo: (account) => accountInfo(client, account),
    fees: () => serverFees(client),
    iouBalance: (account, currency, issuer) => iouBalance(client, account, currency, issuer),
    innerResults: (batch) => innerResults(client, batch),
    addBatchSigner: (wallet, tx) => { addBatchSigner(wallet, tx) },
    signBlob: (wallet, tx) => wallet.sign(tx as never).tx_blob,
  }
}

export async function provisionOnEndpoint(endpoint: string, opts: Omit<ProvisionOptions, 'io'>): Promise<Provisioned> {
  const client = new xrpl.Client(endpoint)
  await client.connect()
  try {
    return await provisionProcurement({ ...opts, io: xrplOpenIo(client) })
  } finally {
    await client.disconnect().catch(() => {})
  }
}
