// An MCP (Model Context Protocol) server that gives an AI agent exactly four tools over a
// policy co-signed engagement account: propose a payment, submit a signed one, pay in one
// step, and read status. The agent never holds quorum — propose_payment returns the co-signer's
// verdict and, on SIGN, a ready-to-submit quorum blob — and broadcasting is fail-closed: it is
// refused unless the operator explicitly turns it on (XRPL_URL + AGENT_ALLOW_SUBMIT=1).
//
//   COSIGNER_URL=http://127.0.0.1:8787 COSIGNER_API_TOKEN=… \
//   AGENT_SEED=s… ENGAGEMENT_ID=eng_… ENGAGEMENT_ACCOUNT=r… ASSET_ISSUER=r… \
//   [ASSET_CODE=RLUSD] [XRPL_URL=wss://…] [AGENT_ALLOW_SUBMIT=1] npm run mcp
import path from 'node:path'
import xrpl from 'xrpl'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { localSigner, type Statement } from '@eng/core'
import { currencyHex, privySignerFromEnv } from '@eng/cosigner'
import { EngagementAgent, XrplChain, type Chain, type Proposal } from './agent.ts'
import { CosignerClient } from './client.ts'

export interface AgentServerConfig {
  cosignerUrl: string
  token: string | null
  engagementId: string
  account: string
  seed: string
  /** Key custody: `privy` → Privy-held key (PRIVY_* env); otherwise a local seed. */
  keySource: string
  asset: { code: string; currency: string; issuer: string }
  xrplUrl: string | null
  /** Live broadcasting allowed — requires xrplUrl and AGENT_ALLOW_SUBMIT. */
  allowSubmit: boolean
  stage: string
}

/** Resolve server config from the environment (fail-closed on submission). */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AgentServerConfig {
  const need = (k: string): string => { const v = env[k]; if (!v) throw new Error(`missing required env ${k}`); return v }
  const code = env.ASSET_CODE ?? 'RLUSD'
  const xrplUrl = env.XRPL_URL ?? null
  const allow = /^(1|true|yes)$/i.test(env.AGENT_ALLOW_SUBMIT ?? '')
  return {
    cosignerUrl: env.COSIGNER_URL ?? 'http://127.0.0.1:8787',
    token: env.COSIGNER_API_TOKEN || null,
    engagementId: need('ENGAGEMENT_ID'),
    account: need('ENGAGEMENT_ACCOUNT'),
    keySource: env.AGENT_KEY_SOURCE ?? 'local',
    seed: env.AGENT_KEY_SOURCE === 'privy' ? '' : need('AGENT_SEED'),
    asset: { code, currency: currencyHex(code), issuer: need('ASSET_ISSUER') },
    xrplUrl,
    allowSubmit: allow && xrplUrl != null,
    stage: env.AGENT_STAGE ?? 'spend',
  }
}

function summarize(p: Proposal): Record<string, unknown> {
  return {
    decision: p.decision.decision,
    failing: p.decision.failing,
    statementsRejected: p.decision.statementsRejected.map((s) => s.code),
    advisory: p.decision.advisory ?? false,
    recordId: p.decision.record.id,
    combinedBlob: p.combined ?? null,
    txHash: p.combined ? xrpl.hashes.hashSignedTx(p.combined) : null,
  }
}

/** Build the MCP server around an agent. `allowSubmit` gates the two broadcasting tools. */
export function createAgentServer(agent: EngagementAgent, opts: { client: CosignerClient; allowSubmit: boolean }): McpServer {
  const server = new McpServer({ name: 'eng-agent', version: '0.1.0' })
  const out = (v: unknown, isError = false) => ({
    content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
    ...(isError ? { isError: true as const } : {}),
  })
  const disabled = 'live submission is disabled — start the MCP server with XRPL_URL set and AGENT_ALLOW_SUBMIT=1 (use propose_payment to evaluate and co-sign without broadcasting)'
  const paymentShape = {
    destination: z.string().describe('XRPL r-address of the payee'),
    amount: z.string().describe('Decimal amount in the asset units, e.g. "800.00"'),
    invoiceRef: z.string().optional().describe('Invoice / order reference bound into the payment memo'),
    statements: z.array(z.any()).optional().describe('Signed supporting statements the policy requires (invoice, approval, …)'),
  }

  server.registerTool('propose_payment', {
    title: 'Propose a payment',
    description: 'Build a payment from the engagement account, add the agent signature, and ask the policy co-signer to evaluate it. On SIGN the two signatures are merged into a quorum blob (combinedBlob) ready for submit_payment. Nothing is broadcast.',
    inputSchema: paymentShape,
  }, async (args) => {
    try {
      const p = await agent.proposePayment({ destination: args.destination, amount: args.amount, invoiceRef: args.invoiceRef, statements: (args.statements as Statement[] | undefined) ?? [] })
      return out(summarize(p))
    } catch (e) { return out(`propose_payment failed: ${(e as Error).message}`, true) }
  })

  server.registerTool('submit_payment', {
    title: 'Submit a signed payment',
    description: 'Broadcast a quorum blob (the combinedBlob returned by propose_payment) to the XRPL and wait for validation.',
    inputSchema: { combinedBlob: z.string().describe('The combined quorum blob from propose_payment') },
  }, async (args) => {
    if (!opts.allowSubmit) return out(disabled, true)
    try { return out(await agent.submit(args.combinedBlob)) } catch (e) { return out(`submit_payment failed: ${(e as Error).message}`, true) }
  })

  server.registerTool('pay_vendor', {
    title: 'Propose and settle a payment',
    description: 'Propose a payment and, if the co-signer signs, broadcast it in one step. Returns both the decision and the settlement result.',
    inputSchema: paymentShape,
  }, async (args) => {
    if (!opts.allowSubmit) return out(disabled, true)
    try {
      const { proposal, submit } = await agent.payVendor({ destination: args.destination, amount: args.amount, invoiceRef: args.invoiceRef, statements: (args.statements as Statement[] | undefined) ?? [] })
      return out({ ...summarize(proposal), submit: submit ?? null })
    } catch (e) { return out(`pay_vendor failed: ${(e as Error).message}`, true) }
  })

  server.registerTool('engagement_status', {
    title: 'Engagement status',
    description: 'Read the engagement record, the count of in-flight decisions, and recent co-signer verdicts.',
    inputSchema: { limit: z.number().int().positive().max(50).optional().describe('How many recent decisions to include (default 10)') },
  }, async (args) => {
    try {
      const id = agent.engagementId
      const view = await opts.client.engagement(id)
      const decisions = await opts.client.decisions(id)
      const limit = args.limit ?? 10
      return out({
        engagement: view.engagement,
        inflight: view.inflight.length,
        decisions: decisions.slice(-limit).map((d) => ({ id: d.id, stage: (d.subject as Record<string, unknown>).stage, decision: d.claim.decision, failing: d.claim.failing })),
      })
    } catch (e) { return out(`engagement_status failed: ${(e as Error).message}`, true) }
  })

  return server
}

// Entrypoint: wire the environment to a stdio MCP server. On a stdio transport stdout is the
// protocol channel, so every log goes to stderr.
if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const cfg = (() => { try { return configFromEnv() } catch (e) { console.error(String((e as Error).message ?? e)); process.exit(1) } })()
  const client = new CosignerClient({ baseUrl: cfg.cosignerUrl, token: cfg.token })
  const signer = cfg.keySource === 'privy'
    ? (privySignerFromEnv() ?? ((): never => { throw new Error('AGENT_KEY_SOURCE=privy but PRIVY_* env is not set') })())
    : localSigner(xrpl.Wallet.fromSeed(cfg.seed))
  let chain: Chain | undefined
  if (cfg.xrplUrl) {
    const xc = new xrpl.Client(cfg.xrplUrl)
    await xc.connect()
    chain = new XrplChain(xc)
  }
  const agent = new EngagementAgent({ engagementId: cfg.engagementId, account: cfg.account, signer, asset: cfg.asset, decider: client, chain, stage: cfg.stage })
  const server = createAgentServer(agent, { client, allowSubmit: cfg.allowSubmit })
  await server.connect(new StdioServerTransport())
  console.error(JSON.stringify({ t: new Date().toISOString(), level: 'info', msg: 'agent-mcp ready', engagement: cfg.engagementId, account: cfg.account, agent: signer.address, cosigner: cfg.cosignerUrl, live: Boolean(chain), submit: cfg.allowSubmit }))
}
