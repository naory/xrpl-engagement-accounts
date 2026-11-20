import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import { CosignerError } from '../src/client.ts'
import { TOKEN_FILE_IGNORED } from '../src/cosigner-token.ts'
import {
  HELP, TESTNET_SEED_BANNER, assertEngNetwork, assertLoopbackCosignerUrl, assertOutsideRepo, assertTokenInsideDataDir,
  formatOpen, isRetryableRegisterError, parseDiscovery, parseEngArgs, printedOpen, registerWithBackoff,
  resolveOpenEndpoint, retryCommand, runEng, writeOutFile, type EngIo,
} from '../src/eng-cli.ts'
import {
  DEMO_IOU_NOTE, OpenPartialError, buildProcurementMandate, buildProcurementRecord, provisionProcurement,
  type OpenIo, type Provisioned,
} from '../src/open-procurement.ts'
import { configFromEnv } from '../src/server.ts'
import { LSF_DISABLE_MASTER, TESTNET_ENDPOINTS, findRepoRoot } from '@eng/ledger'

const TOKEN = 'sekret-token-value'
const FILE_TOKEN = 'file-token-value'
const root = findRepoRoot(process.cwd())

function wallet() {
  return xrpl.Wallet.generate()
}

function discovery(over: Record<string, unknown> = {}) {
  const address = wallet().address
  return {
    version: 1,
    url: 'http://127.0.0.1:8787',
    address,
    publicKey: 'ED' + 'ab'.repeat(32),
    network: 'xrpl:1',
    endpoint: TESTNET_ENDPOINTS[0],
    tokenPath: path.join(os.tmpdir(), 'cosigner.token'),
    ...over,
  }
}

function provisioned(cosignerAddress: string): Provisioned {
  const issuer = wallet()
  const treasury = wallet()
  const service = wallet()
  const vendorA = wallet()
  const vendorB = wallet()
  const kyb = wallet()
  const agent = wallet()
  const controller = wallet()
  const engagement = wallet()
  const mandate = buildProcurementMandate({ engagementId: 'eng_open_test', owner: treasury, vendors: [vendorA.address, vendorB.address], now: new Date('2026-01-01T00:00:00Z') })
  const record = buildProcurementRecord({
    engagementId: 'eng_open_test', engagement, treasury, agent, service, controller, vendorA, vendorB, issuer, kyb, cosignerAddress, mandate,
  })
  return {
    engagementId: 'eng_open_test', currency: '524C555344000000000000000000000000000000',
    issuer, treasury, service, vendorA, vendorB, stranger: null, kyb, agent, controller, engagement, cosignerAddress,
    record, mandate,
    open: { ok: true, final: 'tesSUCCESS', hash: 'ABC', inner: 'tesSUCCESS,tesSUCCESS,tesSUCCESS', regularKey: 'none', quorum: 2, balance: '5000' },
  }
}

function io(over: Partial<EngIo> & { doc?: Record<string, unknown>; token?: string } = {}): EngIo & { out: string; err: string; provisioned: boolean; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-open-'))
  const tokenFile = path.join(dir, 'cosigner.token')
  const token = over.token ?? `${FILE_TOKEN}\n`
  fs.writeFileSync(tokenFile, token, { mode: 0o600 })
  const doc: Record<string, unknown> = { ...(over.doc ?? discovery()), tokenPath: tokenFile }
  const { doc: _doc, token: _token, env: envOver, ...rest } = over
  void _doc
  void _token
  const state = { out: '', err: '', provisioned: false }
  const base: EngIo = {
    env: { DATA_DIR: dir, ...envOver },
    cwd: root,
    stdout: (text) => { state.out += text },
    stderr: (text) => { state.err += text },
    readFile: (file) => file.endsWith('local.json') ? JSON.stringify(doc) : (file === tokenFile || file === fs.realpathSync(tokenFile)) ? token : (() => { throw new Error(`unexpected read ${file}`) })(),
    fetch: async (input) => {
      const url = String(input)
      if (url.endsWith('/healthz')) return new Response(JSON.stringify({ ok: true, cosigner: doc.address }), { status: 200 })
      if (url.endsWith('/v1/engagements')) return new Response(JSON.stringify({ ok: true, layers: [] }), { status: 200 })
      throw new Error(`unexpected ${url}`)
    },
    sleep: async () => {},
    provision: async () => {
      state.provisioned = true
      return provisioned(String(doc.address))
    },
    now: () => new Date('2026-01-01T00:00:00Z'),
    ...rest,
  }
  const view = base as EngIo & { out: string; err: string; provisioned: boolean; dir: string }
  Object.defineProperty(view, 'out', { get: () => state.out })
  Object.defineProperty(view, 'err', { get: () => state.err })
  Object.defineProperty(view, 'provisioned', { get: () => state.provisioned })
  Object.defineProperty(view, 'dir', { get: () => dir })
  return view
}

describe('eng open flags', () => {
  it('prints TESTNET ONLY help', async () => {
    const deps = io()
    expect(await runEng(['open', '--help'], deps)).toBe(0)
    expect(deps.out).toContain('TESTNET ONLY')
    expect(deps.out).toContain('--template')
    expect(deps.out).not.toContain(TOKEN)
    expect(HELP).toContain('no --resume')
  })

  it('refuses --resume, an unknown template, and a non-Testnet network', () => {
    expect(() => parseEngArgs(['open', '--resume'])).toThrow(/--resume is not supported/)
    expect(() => parseEngArgs(['open', '--template'])).toThrow(/needs a value/)
    expect(parseEngArgs(['--help']).help).toBe(true)
    expect(() => assertEngNetwork('xrpl:0')).toThrow(/ENG_NETWORK must be xrpl:1/)
    expect(() => assertEngNetwork('xrpl:mainnet')).toThrow(/ENG_NETWORK must be xrpl:1/)
    expect(() => assertEngNetwork(undefined)).not.toThrow()
  })

  it('refuses Devnet, mainnet, and a hosted co-signer URL', async () => {
    await expect(resolveOpenEndpoint({ flag: 'wss://s.devnet.rippletest.net:51233', discoveryEndpoint: TESTNET_ENDPOINTS[0] })).rejects.toThrow(/not a known Testnet host/)
    await expect(resolveOpenEndpoint({ flag: 'wss://xrplcluster.com', discoveryEndpoint: TESTNET_ENDPOINTS[0] })).rejects.toThrow(/not a known Testnet host/)
    await expect(resolveOpenEndpoint({ flag: 'wss://s1.ripple.com', discoveryEndpoint: TESTNET_ENDPOINTS[0] })).rejects.toThrow(/not a known Testnet host/)
    expect(assertLoopbackCosignerUrl('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787')
    expect(() => assertLoopbackCosignerUrl('https://cosigner.example')).toThrow(/not loopback/)
    expect(() => parseDiscovery(discovery({ url: 'http://example.com:8787' }), os.tmpdir())).toThrow(/not loopback/)
    expect(() => parseDiscovery(discovery({ endpoint: 'wss://s.devnet.rippletest.net:51233', network: 'xrpl:2' }), os.tmpdir())).toThrow(/local\.json network must be xrpl:1/)
    expect(() => parseDiscovery(discovery({ trust: { 'rlusd.issuer': wallet().address } }), os.tmpdir())).toThrow(/ENG_RLUSD_ISSUER/)
    expect(() => parseDiscovery(discovery({ trust: { 'arbiter.accreditor': wallet().address } }), os.tmpdir())).toThrow(/ENG_ARBITER_ACCREDITOR/)
  })
})

describe('token file must stay inside the data dir', () => {
  it('refuses an absolute path outside the data dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-tok-'))
    try {
      expect(() => parseDiscovery(discovery({ tokenPath: '/etc/hostname' }), dir)).toThrow(/outside the co-signer data dir/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a .. escape', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-tok-'))
    const outside = path.join(dir, '..', `eng-escaped-${process.pid}`)
    fs.writeFileSync(outside, 'nope\n')
    try {
      expect(() => parseDiscovery(discovery({ tokenPath: outside }), dir)).toThrow(/outside the co-signer data dir/)
      expect(() => parseDiscovery(discovery({ tokenPath: path.join('..', path.basename(outside)) }), dir)).toThrow(/outside the co-signer data dir/)
    } finally {
      fs.rmSync(outside, { force: true })
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts a token when a parent of the data dir is a symlink', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-x-'))
    const real = path.join(base, 'real')
    const link = path.join(base, 'link')
    fs.mkdirSync(real)
    fs.symlinkSync(real, link)
    const data = path.join(link, 'data')
    fs.mkdirSync(data)
    const token = path.join(data, 'cosigner.token')
    fs.writeFileSync(token, 'inside\n', { mode: 0o600 })
    try {
      const got = assertTokenInsideDataDir(token, data)
      expect(got).toBe(fs.realpathSync(token))
      expect(parseDiscovery(discovery({ tokenPath: token }), data).tokenPath).toBe(got)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('refuses a symlink inside the dir that points outside', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-tok-'))
    const outside = path.join(os.tmpdir(), `eng-secret-${process.pid}`)
    fs.writeFileSync(outside, 'sekret-outside\n')
    const link = path.join(dir, 'cosigner.token')
    fs.symlinkSync(outside, link)
    try {
      expect(() => parseDiscovery(discovery({ tokenPath: link }), dir)).toThrow(/symlink/)
    } finally {
      fs.rmSync(link, { force: true })
      fs.rmSync(outside, { force: true })
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('register backoff', () => {
  it('retries 503 and connection errors three times and never retries 4xx', async () => {
    const sleeps: number[] = []
    const pause = async (ms: number) => { sleeps.push(ms) }
    let calls = 0
    await registerWithBackoff(async () => {
      calls++
      if (calls < 3) throw new CosignerError(503, 'ledger')
      return 'ok'
    }, { sleep: pause })
    expect(calls).toBe(3)
    expect(sleeps).toEqual([1_000, 2_000])

    calls = 0
    await expect(registerWithBackoff(async () => {
      calls++
      throw new CosignerError(400, 'bad record')
    }, { sleep: pause })).rejects.toThrow(/bad record/)
    expect(calls).toBe(1)

    calls = 0
    await expect(registerWithBackoff(async () => {
      calls++
      throw new CosignerError(401, 'unauthorized')
    }, { sleep: pause })).rejects.toThrow(/unauthorized/)
    expect(calls).toBe(1)

    calls = 0
    await expect(registerWithBackoff(async () => {
      calls++
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    }, { sleep: pause })).rejects.toThrow(/fetch failed/)
    expect(calls).toBe(3)
    expect(isRetryableRegisterError(new CosignerError(429, 'rate'))).toBe(false)
    expect(isRetryableRegisterError(Object.assign(new Error('down'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isRetryableRegisterError(new TypeError('not a connection'))).toBe(false)
    expect(isRetryableRegisterError(new TypeError('fetch failed'))).toBe(false)
  })
})

describe('output', () => {
  it('puts the TESTNET ONLY banner in text and JSON and never the token', () => {
    const opened = provisioned('rCosigner')
    const doc = printedOpen({
      draft: opened,
      cosignerUrl: 'http://127.0.0.1:8787',
      tokenPath: '/tmp/cosigner.token',
      endpoint: TESTNET_ENDPOINTS[0],
      partial: { error: 'registration failed: ledger', retryCommand: 'npm run eng -- open --template procurement@1 --cosigner-dir /tmp/c' },
    })
    const human = formatOpen(doc, false)
    const json = formatOpen(doc, true)
    expect(human.startsWith(TESTNET_SEED_BANNER)).toBe(true)
    expect(human).toContain('Retry (full re-open, creates a new account): npm run eng -- open --template procurement@1')
    expect(human).toContain('AGENT_SEED=')
    expect(human).not.toContain(TOKEN)
    expect(human).not.toContain(FILE_TOKEN)
    const parsed = JSON.parse(json) as { banner: string; partial: boolean; retryCommand: string; env: { COSIGNER_API_TOKEN_FILE: string } }
    expect(parsed.banner).toBe(TESTNET_SEED_BANNER)
    expect(Object.keys(parsed)[0]).toBe('banner')
    expect(parsed.partial).toBe(true)
    expect(parsed.retryCommand).toContain('--template procurement@1')
    expect(parsed.env.COSIGNER_API_TOKEN_FILE).toBe('/tmp/cosigner.token')
    expect(json).not.toContain(TOKEN)
    expect(retryCommand({ template: 'owner-wallet/procurement@1', cosignerDir: '/tmp/my dir', endpoint: null, json: true })).toBe("npm run --silent eng -- open --template procurement@1 --cosigner-dir '/tmp/my dir' --json")
  })

  it('refuses a symlink into the repo and a name that merely starts with ..', () => {
    const link = path.join(os.tmpdir(), `eng-repo-link-${process.pid}`)
    fs.symlinkSync(root, link)
    try {
      expect(() => assertOutsideRepo(path.join(link, 'x.json'), root)).toThrow(/inside the repo/)
    } finally {
      fs.unlinkSync(link)
    }
    expect(() => assertOutsideRepo(path.join(root, '..leak.json'), root)).toThrow(/inside the repo/)
  })

  it('refuses an --out path inside the repo and writes 0600 outside it', () => {
    expect(() => assertOutsideRepo(path.join(root, 'eng-open.out'), root)).toThrow(/inside the repo/)
    const file = path.join(os.tmpdir(), `eng-open-${process.pid}.json`)
    fs.rmSync(file, { force: true })
    try {
      writeOutFile(file, root, `${JSON.stringify({ banner: TESTNET_SEED_BANNER })}\n`)
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      expect(fs.readFileSync(file, 'utf8')).toContain('TESTNET ONLY')
    } finally {
      fs.rmSync(file, { force: true })
    }
  })
})

describe('runEng', () => {
  it('registers with backoff and prints seeds without the token', async () => {
    const doc = discovery()
    let registers = 0
    let auth = ''
    const sleeps: number[] = []
    const deps = io({
      doc,
      fetch: async (input, init) => {
        const url = String(input)
        if (url.endsWith('/healthz')) return new Response(JSON.stringify({ ok: true, cosigner: doc.address }), { status: 200 })
        registers++
        auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '')
        if (registers < 3) return new Response(JSON.stringify({ error: 'ledger' }), { status: 503 })
        return new Response(JSON.stringify({ ok: true, layers: [] }), { status: 200 })
      },
      sleep: async (ms) => { sleeps.push(ms) },
    })
    expect(await runEng(['open', '--template', 'procurement@1', '--json'], deps)).toBe(0)
    expect(deps.provisioned).toBe(true)
    expect(registers).toBe(3)
    expect(sleeps).toEqual([1_000, 2_000])
    expect(auth).toBe(`Bearer ${FILE_TOKEN}`)
    const parsed = JSON.parse(deps.out) as { banner: string; env: Record<string, string> }
    expect(parsed.banner).toContain('TESTNET ONLY')
    expect(parsed.env.ENGAGEMENT_ID).toBe('eng_open_test')
    expect(parsed.env.COSIGNER_API_TOKEN_FILE).toBe(fs.realpathSync(path.join(deps.dir, 'cosigner.token')))
    expect(parsed.env.ASSET_CODE).toBe('RLUSD')
    expect(deps.out).not.toContain(FILE_TOKEN)
    expect(deps.err).toContain(TESTNET_SEED_BANNER)
  })

  it('does not retry a 400 and prints the retry command', async () => {
    const doc = discovery()
    let registers = 0
    const deps = io({
      doc,
      fetch: async (input) => {
        const url = String(input)
        if (url.endsWith('/healthz')) return new Response(JSON.stringify({ ok: true, cosigner: doc.address }), { status: 200 })
        registers++
        return new Response(JSON.stringify({ error: 'bad record' }), { status: 400 })
      },
    })
    expect(await runEng(['open', '--template', 'owner-wallet/procurement@1'], deps)).toBe(1)
    expect(registers).toBe(1)
    expect(deps.out).toContain(TESTNET_SEED_BANNER)
    expect(deps.out).toContain('Retry (full re-open, creates a new account): npm run eng -- open --template procurement@1')
    expect(deps.out).toContain('AGENT_SEED=')
    expect(deps.out).not.toContain(FILE_TOKEN)
  })

  it('lets COSIGNER_API_TOKEN win and says so without printing either token', async () => {
    const doc = discovery()
    let auth = ''
    const deps = io({
      doc,
      env: { COSIGNER_API_TOKEN: TOKEN },
      fetch: async (input, init) => {
        const url = String(input)
        if (url.endsWith('/healthz')) return new Response(JSON.stringify({ ok: true, cosigner: doc.address }), { status: 200 })
        auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '')
        return new Response(JSON.stringify({ ok: true, layers: [] }), { status: 200 })
      },
    })
    expect(await runEng(['open', '--template', 'procurement@1'], deps)).toBe(0)
    expect(auth).toBe(`Bearer ${TOKEN}`)
    expect(deps.err).toContain(TOKEN_FILE_IGNORED)
    expect(deps.out).toContain(`COSIGNER_API_TOKEN_FILE=${fs.realpathSync(path.join(deps.dir, 'cosigner.token'))}`)
    expect(deps.out).not.toContain(TOKEN)
    expect(deps.out).not.toContain(FILE_TOKEN)
    expect(deps.err).not.toContain(TOKEN)
  })

  it('stops before the faucet when the co-signer has ENG_RLUSD_ISSUER or the endpoint is Devnet', async () => {
    const refused = io({ doc: discovery({ trust: { 'rlusd.issuer': wallet().address } }) })
    await expect(runEng(['open', '--template', 'procurement@1'], refused)).rejects.toThrow(/ENG_RLUSD_ISSUER/)
    expect(refused.provisioned).toBe(false)
    const devnet = io({ doc: discovery({ endpoint: 'wss://s.devnet.rippletest.net:51233' }) })
    await expect(runEng(['open', '--template', 'procurement@1'], devnet)).rejects.toThrow(/not a known Testnet host/)
    expect(devnet.provisioned).toBe(false)
  })

  it('refuses an existing --out file, including a dangling symlink, before the faucet', async () => {
    const file = path.join(os.tmpdir(), `eng-exists-${process.pid}.json`)
    const dangling = path.join(os.tmpdir(), `eng-dangling-${process.pid}.json`)
    fs.writeFileSync(file, 'old')
    fs.symlinkSync(path.join(os.tmpdir(), `eng-missing-${process.pid}`), dangling)
    const deps = io()
    const again = io()
    try {
      await expect(runEng(['open', '--template', 'procurement@1', '--out', file], deps)).rejects.toThrow(/already exists/)
      expect(deps.provisioned).toBe(false)
      await expect(runEng(['open', '--template', 'procurement@1', '--out', dangling], again)).rejects.toThrow(/already exists/)
      expect(again.provisioned).toBe(false)
    } finally {
      fs.rmSync(file, { force: true })
      fs.rmSync(dangling, { force: true })
      fs.rmSync(deps.dir, { recursive: true, force: true })
      fs.rmSync(again.dir, { recursive: true, force: true })
    }
  })

  it('does not resubmit a failed Batch, prints seeds, and omits the token and AGENT_ALLOW_SUBMIT', async () => {
    let submits = 0
    const deps = io({
      provision: async (_endpoint, opts) => {
        const fake: OpenIo = {
          fund: async () => wallet(),
          send: async () => ({ final: 'tesSUCCESS', hash: 'h' }),
          submit: async () => { submits += 1; return { final: 'tecUNFUNDED_PAYMENT', hash: 'BATCH' } },
          accountInfo: async () => ({ account_data: { Sequence: 4, Flags: LSF_DISABLE_MASTER }, signer_lists: [{ SignerQuorum: 2 }] }),
          fees: async () => ({ base: 10, reserveBase: 1, inc: 1 }),
          iouBalance: async () => '0',
          innerResults: async () => [{ applied: false, result: 'tecUNFUNDED_PAYMENT' }],
          addBatchSigner: () => {},
          signBlob: () => 'blob',
        }
        return provisionProcurement({
          io: fake,
          cosignerAddress: opts.cosignerAddress,
          engagementId: opts.engagementId,
          sleep: async () => {},
          log: () => {},
          now: () => new Date('2026-01-01T00:00:00Z'),
        })
      },
    })
    try {
      expect(await runEng(['open', '--template', 'procurement@1'], deps)).toBe(1)
      expect(submits).toBe(1)
      expect(deps.out).toContain(TESTNET_SEED_BANNER)
      expect(deps.out).toContain('AGENT_SEED=')
      expect(deps.out).toContain('Retry (full re-open, creates a new account)')
      expect(deps.out).not.toContain('AGENT_ALLOW_SUBMIT')
      expect(`${deps.out}\n${deps.err}`).not.toContain(FILE_TOKEN)
    } finally {
      fs.rmSync(deps.dir, { recursive: true, force: true })
    }
  })
})

describe('configFromEnv token file', () => {
  it('reads COSIGNER_API_TOKEN_FILE and lets the env token win', () => {
    const notes: string[] = []
    const file = path.join(os.tmpdir(), `token-${process.pid}.txt`)
    fs.writeFileSync(file, `${FILE_TOKEN}\n`, { mode: 0o600 })
    try {
      const fromFile = configFromEnv({
        ENGAGEMENT_ID: 'eng', ENGAGEMENT_ACCOUNT: 'rA', AGENT_SEED: 'sSeed', ASSET_ISSUER: 'rI',
        COSIGNER_API_TOKEN_FILE: file,
      }, { warn: (line) => notes.push(line) })
      expect(fromFile.token).toBe(FILE_TOKEN)
      expect(notes).toEqual([])
      const fromEnv = configFromEnv({
        ENGAGEMENT_ID: 'eng', ENGAGEMENT_ACCOUNT: 'rA', AGENT_SEED: 'sSeed', ASSET_ISSUER: 'rI',
        COSIGNER_API_TOKEN: TOKEN, COSIGNER_API_TOKEN_FILE: file,
      }, { warn: (line) => notes.push(line) })
      expect(fromEnv.token).toBe(TOKEN)
      expect(notes).toEqual([TOKEN_FILE_IGNORED])
      expect(notes.join('\n')).not.toContain(TOKEN)
    } finally {
      fs.rmSync(file, { force: true })
    }
  })
})

describe('provisionProcurement', () => {
  it('mints a demo IOU, opens the batch, and retries the faucet', async () => {
    const cosigner = wallet().address
    const sent: string[] = []
    let batch = ''
    let fails = 2
    const sleeps: number[] = []
    const logs: string[] = []
    const ioFake: OpenIo = {
      fund: async () => {
        if (fails > 0) { fails--; throw new Error('faucet down') }
        return wallet()
      },
      send: async (_wallet, tx) => { sent.push(String(tx.TransactionType)); return { final: 'tesSUCCESS', hash: 'h' } },
      submit: async () => ({ final: 'tesSUCCESS', hash: 'BATCH' }),
      accountInfo: async () => ({ account_data: { Sequence: 4, Flags: LSF_DISABLE_MASTER }, signer_lists: [{ SignerQuorum: 2 }] }),
      fees: async () => ({ base: 10, reserveBase: 1_000_000, inc: 200_000 }),
      iouBalance: async () => '5000',
      innerResults: async () => [{ applied: true, result: 'tesSUCCESS' }, { applied: true, result: 'tesSUCCESS' }, { applied: true, result: 'tesSUCCESS' }],
      addBatchSigner: (_wallet, tx) => { batch = JSON.stringify(tx) },
      signBlob: () => 'blob',
    }
    const opened = await provisionProcurement({
      io: ioFake,
      cosignerAddress: cosigner,
      engagementId: 'eng_unit',
      sleep: async (ms) => { sleeps.push(ms) },
      log: (line) => logs.push(line),
      now: () => new Date('2026-01-01T00:00:00Z'),
    })
    expect(sleeps).toEqual([5_000, 5_000])
    expect(sent).toContain('AccountSet')
    expect(sent).toContain('TrustSet')
    expect(sent).toContain('Payment')
    expect(sent).toContain('CredentialCreate')
    expect(sent.filter((type) => type === 'CredentialAccept')).toHaveLength(2)
    expect(logs).toContain(DEMO_IOU_NOTE)
    expect(batch).toContain(cosigner)
    expect(batch).toContain(Buffer.from('eng_unit|template=owner-wallet/procurement@1', 'utf8').toString('hex').toUpperCase())
    expect(opened.open.ok).toBe(true)
    expect(opened.record.template).toBe('owner-wallet/procurement@1')
    expect(opened.record.parties.cosigner).toBe(cosigner)
    expect(opened.record.policyLayers).toBeUndefined()
    expect(opened.record.trust?.['rlusd.issuer']).toBe(opened.issuer.address)
    expect(opened.mandate.claim.budget).toBe('5000.00')
  })

  it('stops after five faucet failures', async () => {
    const ioFake: OpenIo = {
      fund: async () => { throw new Error('faucet down') },
      send: async () => ({ final: 'tesSUCCESS', hash: 'h' }),
      submit: async () => ({ final: 'tesSUCCESS', hash: 'h' }),
      accountInfo: async () => null,
      fees: async () => ({ base: 10, reserveBase: 1, inc: 1 }),
      iouBalance: async () => null,
      innerResults: async () => [],
      addBatchSigner: () => {},
      signBlob: () => 'blob',
    }
    await expect(provisionProcurement({
      io: ioFake, cosignerAddress: 'rC', engagementId: 'eng', sleep: async () => {}, log: () => {},
    })).rejects.toBeInstanceOf(OpenPartialError)
  })
})
