// Local co-signer (`npm run cosigner:local`). No network: the ledger and the websocket probe are injected.
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
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
      expect(body.trust).toBeUndefined()
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
    const record = b1Engagement()
    record.parties = { ...record.parties, cosigner: first.address }
    const posted = await fetch(`${first.url}/v1/engagements`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engagement: record, mandate: b1Mandate() }),
    })
    expect(posted.status).toBe(200)
    await first.close()
    expect(fs.existsSync(first.discoveryPath)).toBe(false)

    const second = await boot({ PORT: '0', DATA_DIR: dataDir })
    try {
      expect(second.address).toBe(first.address)
      expect(fs.readFileSync(second.seedPath).equals(seedBefore)).toBe(true)
      const health = await (await fetch(`${second.url}/healthz`)).json() as { cosigner: string }
      expect(health.cosigner).toBe(first.address)
      const got = await (await fetch(`${second.url}/v1/engagements/eng_b1_fixture`)).json() as { engagement: { engagementId: string; parties: { cosigner: string } } }
      expect(got.engagement.engagementId).toBe('eng_b1_fixture')
      expect(got.engagement.parties.cosigner).toBe(first.address)
      expect(discovery(second).address).toBe(first.address)
    } finally {
      await second.close()
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
