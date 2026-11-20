// Local co-signer (`npm run cosigner:local`). No network: the ledger and the websocket probe are injected.
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import xrpl from 'xrpl'
import { b1Engagement, b1Ledger, b1Mandate, W } from '../../policy/test/fixtures.ts'
import { FixtureLedgerSource, TESTNET_ENDPOINTS, type TestnetConnect } from '../src/index.ts'
import { ensureLocalSeed, findRepoRoot, startLocalCosigner, type LocalCosigner, type LocalDiscovery } from '../src/local.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const acceptTestnet: TestnetConnect = async (url) => {
  if (!(TESTNET_ENDPOINTS as readonly string[]).includes(url)) throw new Error(`unexpected probe ${url}`)
}

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosigner-local-'))
  scratch.push(dir)
  return dir
}

function source(): FixtureLedgerSource {
  return new FixtureLedgerSource(b1Ledger())
}

async function boot(env: NodeJS.ProcessEnv, opts: { connect?: TestnetConnect; log?: (line: string) => void; warn?: (line: string) => void } = {}): Promise<LocalCosigner> {
  return startLocalCosigner({
    env,
    connect: opts.connect ?? acceptTestnet,
    source: source(),
    log: opts.log ?? (() => {}),
    warn: opts.warn ?? (() => {}),
  })
}

function discovery(running: LocalCosigner): LocalDiscovery {
  return JSON.parse(fs.readFileSync(running.discoveryPath, 'utf8')) as LocalDiscovery
}

function tokenOf(running: LocalCosigner): string {
  return fs.readFileSync(running.tokenPath, 'utf8').trim()
}

function httpCall(port: number, opts: { path: string; method?: string; host?: string; origin?: string; token?: string; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (opts.host) headers.host = opts.host
    if (opts.origin !== undefined) headers.origin = opts.origin
    if (opts.token) headers.authorization = `Bearer ${opts.token}`
    if (opts.body) headers['content-type'] = 'application/json'
    const req = http.request({ hostname: '127.0.0.1', port, path: opts.path, method: opts.method ?? 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(chunk as Buffer))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}

describe('local co-signer', () => {
  it('starts from an empty data dir, prints the url and address, and keeps an ed25519 key at mode 0600', async () => {
    const dataDir = tempDir()
    const lines: string[] = []
    const running = await boot({ PORT: '0', DATA_DIR: dataDir }, { log: (line) => lines.push(line) })
    try {
      expect(lines).toContain(`local co-signer ${running.url} ${running.address}`)
      const health = await (await fetch(`${running.url}/healthz`)).json() as { cosigner: string }
      expect(health.cosigner).toBe(running.address)
      expect((fs.statSync(running.seedPath).mode & 0o777)).toBe(0o600)
      const seed = fs.readFileSync(running.seedPath, 'utf8').trim()
      // Boolean checks so a failure does not print the seed.
      expect(seed.startsWith('sEd')).toBe(true)
      expect(running.publicKey.startsWith('ED')).toBe(true)
      const wallet = xrpl.Wallet.fromSeed(seed)
      expect(wallet.address).toBe(running.address)
      expect(wallet.publicKey).toBe(running.publicKey)
      const body = discovery(running)
      expect(body).toMatchObject({
        version: 1,
        url: running.url,
        address: running.address,
        publicKey: running.publicKey,
        network: 'xrpl:1',
        endpoint: TESTNET_ENDPOINTS[0],
        pid: process.pid,
      })
      expect(body.tokenPath).toBe(path.resolve(dataDir, 'cosigner.token'))
      expect(body.trust).toBeUndefined()
      expect((fs.statSync(running.tokenPath).mode & 0o777)).toBe(0o600)
      const token = tokenOf(running)
      expect(JSON.stringify(body).includes(token)).toBe(false)
      expect(lines.join('\n').includes(token)).toBe(false)
      expect(Number.isNaN(Date.parse(body.startedAt))).toBe(false)
      expect(JSON.stringify(body).includes(seed)).toBe(false)
      expect(lines.join('\n').includes(seed)).toBe(false)
      const listening = lines.map((line) => { try { return JSON.parse(line) as { msg?: string; tickMs?: number } } catch { return null } }).find((row) => row?.msg === 'listening')
      expect(listening?.tickMs).toBe(30_000)
    } finally {
      await running.close()
    }
  })

  it('removes local.json on close()', async () => {
    const dataDir = tempDir()
    const running = await boot({ PORT: '0', DATA_DIR: dataDir })
    expect(fs.existsSync(running.discoveryPath)).toBe(true)
    await running.close()
    expect(fs.existsSync(running.discoveryPath)).toBe(false)
    expect(fs.existsSync(running.seedPath)).toBe(true)
  })

  it('restarts with the same address, the same key, and the engagement still present', async () => {
    const dataDir = tempDir()
    const first = await boot({ PORT: '0', DATA_DIR: dataDir })
    const seedBefore = fs.readFileSync(first.seedPath)
    const tokenBefore = fs.readFileSync(first.tokenPath)
    const record = b1Engagement()
    record.parties = { ...record.parties, cosigner: first.address }
    const posted = await httpCall(first.port, {
      method: 'POST', path: '/v1/engagements', token: tokenOf(first),
      body: JSON.stringify({ engagement: record, mandate: b1Mandate() }),
    })
    expect(posted.status).toBe(200)
    await first.close()
    expect(fs.existsSync(first.discoveryPath)).toBe(false)

    const second = await boot({ PORT: '0', DATA_DIR: dataDir })
    try {
      expect(second.address).toBe(first.address)
      expect(fs.readFileSync(second.seedPath).equals(seedBefore)).toBe(true)
      expect(fs.readFileSync(second.tokenPath).equals(tokenBefore)).toBe(true)
      const health = await (await fetch(`${second.url}/healthz`)).json() as { cosigner: string }
      expect(health.cosigner).toBe(first.address)
      const got = JSON.parse((await httpCall(second.port, { path: '/v1/engagements/eng_b1_fixture', token: tokenOf(second) })).body) as { engagement: { engagementId: string; parties: { cosigner: string } } }
      expect(got.engagement.engagementId).toBe('eng_b1_fixture')
      expect(got.engagement.parties.cosigner).toBe(first.address)
      expect(discovery(second).address).toBe(first.address)
    } finally {
      await second.close()
    }
  })

  it('requires a bearer token, rejects a foreign Host or any Origin, and leaves /healthz unauthenticated', async () => {
    const dataDir = tempDir()
    const running = await boot({ PORT: '0', DATA_DIR: dataDir })
    try {
      const token = tokenOf(running)
      const missing = await httpCall(running.port, { path: '/v1/engagements/missing' })
      expect(missing.status).toBe(401)
      const record = b1Engagement()
      record.parties = { ...record.parties, cosigner: running.address }
      const posted = await httpCall(running.port, {
        method: 'POST', path: '/v1/engagements', token,
        body: JSON.stringify({ engagement: record, mandate: b1Mandate() }),
      })
      expect(posted.status).toBe(200)
      const wrongHost = await httpCall(running.port, { path: '/v1/engagements/eng_b1_fixture', host: `evil.example:${running.port}`, token })
      expect(wrongHost.status).toBe(403)
      const origin = await httpCall(running.port, { path: '/v1/engagements/eng_b1_fixture', token, origin: 'http://evil.example' })
      expect(origin.status).toBe(403)
      const health = await httpCall(running.port, { path: '/healthz' })
      expect(health.status).toBe(200)
      const healthHost = await httpCall(running.port, { path: '/healthz', host: `evil.example:${running.port}` })
      expect(healthHost.status).toBe(403)
    } finally {
      await running.close()
    }
  })

  it('does not write the bearer token to stdout, stderr, or local.json, and keeps it across a restart', async () => {
    const lines: string[] = []
    const take = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    const spyLog = vi.spyOn(console, 'log').mockImplementation(take)
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(take)
    const spyErr = vi.spyOn(console, 'error').mockImplementation(take)
    const dataDir = tempDir()
    try {
      const first = await startLocalCosigner({ env: { PORT: '0', DATA_DIR: dataDir }, connect: acceptTestnet, source: source() })
      const token = tokenOf(first)
      const secretEnv = 'SENTINEL-API-TOKEN-VALUE'
      try {
        expect(lines.join('\n').includes(token)).toBe(false)
        expect(fs.readFileSync(first.discoveryPath, 'utf8').includes(token)).toBe(false)
        expect(discovery(first).tokenPath).toBe(first.tokenPath)
      } finally {
        await first.close()
      }
      lines.length = 0
      const second = await startLocalCosigner({
        env: { PORT: '0', DATA_DIR: dataDir, COSIGNER_API_TOKEN: secretEnv },
        connect: acceptTestnet,
        source: source(),
      })
      try {
        const text = lines.join('\n')
        expect(text).toContain('COSIGNER_API_TOKEN is in use')
        expect(text.includes(secretEnv)).toBe(false)
        expect(text.includes(token)).toBe(false)
        expect(fs.readFileSync(second.discoveryPath, 'utf8').includes(secretEnv)).toBe(false)
        expect(fs.readFileSync(second.discoveryPath, 'utf8').includes(token)).toBe(false)
        const withEnv = await httpCall(second.port, { path: '/v1/engagements/missing', token: secretEnv })
        expect(withEnv.status).toBe(404)
        const withFile = await httpCall(second.port, { path: '/v1/engagements/missing', token })
        expect(withFile.status).toBe(401)
      } finally {
        await second.close()
      }
    } finally {
      spyLog.mockRestore()
      spyWarn.mockRestore()
      spyErr.mockRestore()
    }
  })

  it('warns and uses 30000 when COSIGNER_TICK_MS is not a positive integer', async () => {
    const dataDir = tempDir()
    const warnings: string[] = []
    const lines: string[] = []
    const running = await boot(
      { PORT: '0', DATA_DIR: dataDir, COSIGNER_TICK_MS: 'abc' },
      { warn: (line) => warnings.push(line), log: (line) => lines.push(line) },
    )
    try {
      expect(warnings).toEqual(['COSIGNER_TICK_MS abc is not a positive integer; using 30000'])
      const listening = lines.map((line) => { try { return JSON.parse(line) as { msg?: string; tickMs?: number } } catch { return null } }).find((row) => row?.msg === 'listening')
      expect(listening?.tickMs).toBe(30_000)
    } finally {
      await running.close()
    }
  })

  it('refuses a key that is readable by group or other', () => {
    const dir = tempDir()
    const file = path.join(dir, 'cosigner.seed')
    fs.writeFileSync(file, 'not-a-seed\n', { mode: 0o600 })
    fs.chmodSync(file, 0o644)
    expect(() => ensureLocalSeed(dir)).toThrow(/readable by group or other/)
  })

  it('ends two concurrent first starts with one key', async () => {
    const dir = tempDir()
    const child = path.join(here, 'local-seed-child.ts')
    const run = () => new Promise<string>((resolve, reject) => {
      const proc = spawn(process.execPath, ['--import', 'tsx', child, dir], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      proc.stdout.on('data', (chunk) => { out += chunk })
      proc.stderr.on('data', (chunk) => { err += chunk })
      proc.on('error', reject)
      proc.on('exit', (code) => {
        if (code === 0) resolve(out.trim())
        else reject(new Error(`seed child exited ${code}: ${err}`))
      })
    })
    const [left, right] = await Promise.all([run(), run()])
    expect(left).toBe(right)
    expect(left).toMatch(/^[0-9a-f]{64}$/)
    expect(fs.readdirSync(dir).filter((name) => !name.startsWith('.'))).toEqual(['cosigner.seed'])
    expect(fs.readdirSync(dir).some((name) => name.endsWith('.tmp'))).toBe(false)
    expect((fs.statSync(path.join(dir, 'cosigner.seed')).mode & 0o777)).toBe(0o600)
    const seed = fs.readFileSync(path.join(dir, 'cosigner.seed'), 'utf8').trim()
    expect(createHash('sha256').update(seed).digest('hex') === left).toBe(true)
  })

  it('ignores COSIGNER_SEED and does not echo the value', async () => {
    const secret = 'SENTINEL-COSIGNER-SEED-VALUE'
    const lines: string[] = []
    const take = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
    const spyLog = vi.spyOn(console, 'log').mockImplementation(take)
    const spyWarn = vi.spyOn(console, 'warn').mockImplementation(take)
    const spyErr = vi.spyOn(console, 'error').mockImplementation(take)
    const dataDir = tempDir()
    try {
      const running = await startLocalCosigner({
        env: { PORT: '0', DATA_DIR: dataDir, COSIGNER_SEED: secret },
        connect: acceptTestnet,
        source: source(),
      })
      try {
        const text = lines.join('\n')
        expect(text).toContain('COSIGNER_SEED is ignored')
        expect(text).toContain(path.join(dataDir, 'cosigner.seed'))
        expect(text.includes(secret)).toBe(false)
        expect(fs.readFileSync(running.seedPath, 'utf8').includes(secret)).toBe(false)
      } finally {
        await running.close()
      }
    } finally {
      spyLog.mockRestore()
      spyWarn.mockRestore()
      spyErr.mockRestore()
    }
  })

  it('accepts a mixed-case Testnet URL with a trailing slash and does not probe it', async () => {
    const connect = vi.fn<TestnetConnect>(async () => { throw new Error('should not connect') })
    const dataDir = tempDir()
    const running = await boot(
      { PORT: '0', DATA_DIR: dataDir, XRPL_URL: 'WSS://Testnet.XRPL-Labs.com/' },
      { connect },
    )
    try {
      expect(connect).not.toHaveBeenCalled()
      expect(running.endpoint).toBe('wss://testnet.xrpl-labs.com')
      expect(discovery(running).endpoint).toBe('wss://testnet.xrpl-labs.com')
    } finally {
      await running.close()
    }
  })

  it('refuses a Devnet URL before connecting', async () => {
    const connect = vi.fn<TestnetConnect>(async () => { throw new Error('should not connect') })
    const dataDir = tempDir()
    await expect(boot(
      { PORT: '0', DATA_DIR: dataDir, XRPL_URL: 'wss://s.devnet.rippletest.net:51233' },
      { connect },
    )).rejects.toThrow(/not a known Testnet host/)
    expect(connect).not.toHaveBeenCalled()
  })

  it('falls back to the second Testnet endpoint when the first probe fails', async () => {
    const connect = vi.fn<TestnetConnect>(async (url) => {
      if (url === TESTNET_ENDPOINTS[0]) throw new Error('down')
    })
    const dataDir = tempDir()
    const running = await boot({ PORT: '0', DATA_DIR: dataDir }, { connect })
    try {
      expect(running.endpoint).toBe(TESTNET_ENDPOINTS[1])
      expect(connect.mock.calls.map((call) => call[0])).toEqual([...TESTNET_ENDPOINTS])
    } finally {
      await running.close()
    }
  })

  it('refuses ENG_NETWORK other than xrpl:1 and a non-loopback bind', async () => {
    const dataDir = tempDir()
    await expect(boot({ PORT: '0', DATA_DIR: dataDir, ENG_NETWORK: 'xrpl:2' })).rejects.toThrow(/ENG_NETWORK must be xrpl:1/)
    await expect(boot({ PORT: '0', DATA_DIR: dataDir, COSIGNER_BIND: '0.0.0.0' })).rejects.toThrow(/binds loopback only/)
    await expect(boot({ PORT: '0', DATA_DIR: dataDir, COSIGNER_STORE: 'memory' })).rejects.toThrow(/SQLite/)
  })

  it('records a configured demo issuer and rejects a bad address', async () => {
    const dataDir = tempDir()
    const running = await boot({ PORT: '0', DATA_DIR: dataDir, ENG_RLUSD_ISSUER: W.issuer.address })
    try {
      expect(discovery(running).trust).toEqual({ 'rlusd.issuer': W.issuer.address })
      expect(running.trust).toEqual({ 'rlusd.issuer': W.issuer.address })
    } finally {
      await running.close()
    }
    await expect(boot({ PORT: '0', DATA_DIR: tempDir(), ENG_RLUSD_ISSUER: 'not-an-address' })).rejects.toThrow(/not a classic address/)
  })

  it('resolves a relative DATA_DIR against the repo root when started from a subdirectory', async () => {
    const root = findRepoRoot(process.cwd())
    const sub = path.join(root, 'packages', 'cosigner')
    const rel = path.join('.cosigner', 'cwd-probe')
    const expected = path.join(root, rel)
    const parent = path.dirname(expected)
    const parentExisted = fs.existsSync(parent)
    const prev = process.cwd()
    process.chdir(sub)
    try {
      const running = await startLocalCosigner({
        env: { PORT: '0', DATA_DIR: rel },
        connect: acceptTestnet,
        source: source(),
        log: () => {},
        warn: () => {},
      })
      try {
        expect(running.dataDir).toBe(expected)
        expect(fs.existsSync(path.join(expected, 'cosigner.seed'))).toBe(true)
        expect(fs.existsSync(path.join(sub, '.cosigner'))).toBe(false)
      } finally {
        await running.close()
      }
    } finally {
      process.chdir(prev)
      fs.rmSync(expected, { recursive: true, force: true })
      if (!parentExisted) fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('uses an absolute DATA_DIR as given, even from a subdirectory', async () => {
    const root = findRepoRoot(process.cwd())
    const abs = tempDir()
    const prev = process.cwd()
    process.chdir(path.join(root, 'packages', 'policy'))
    try {
      const running = await boot({ PORT: '0', DATA_DIR: abs })
      try {
        expect(running.dataDir).toBe(path.resolve(abs))
        expect(fs.existsSync(path.join(abs, 'cosigner.seed'))).toBe(true)
      } finally {
        await running.close()
      }
    } finally {
      process.chdir(prev)
    }
  })
})
