// Pack the publishable packages, install the tarballs outside the repo, and
// import them with Node. No --conditions=source: the tarball's "default"
// export is dist/. Run `npm run build` first. dist/ is gitignored and is
// absent when `npm test` runs.
//
// The MCP check installs those tarballs and lists tools from the packed
// `eng-mcp` bin. It does not publish and it does not run the registry command
// `npx --yes --package <name> eng-mcp`. That command is T26.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { deserializeMessage, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import xrpl from 'xrpl'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHEBANG = '#!/usr/bin/env node'
const TOOLS = ['engagement_status', 'pay_vendor', 'propose_payment', 'submit_payment']
const TOOL_TIMEOUT_MS = 20_000

interface Packed {
  dir: string
  /** Paths that must be present inside the tarball, under its package root. */
  required?: string[]
  /** Paths that must not be packed. The CLIs stay source-only. */
  forbid?: string[]
}

interface PackageMeta {
  name: string
  version: string
  private: boolean
}

const CLI_OUT = ['dist/cli.js', 'dist/cli.d.ts', 'dist/cli.js.map', 'dist/cli.d.ts.map']

const PACKED: Packed[] = [
  { dir: 'core', forbid: CLI_OUT },
  { dir: 'policy', forbid: CLI_OUT },
  { dir: 'ledger' },
  { dir: 'provisioning' },
  { dir: 'agent-mcp', required: ['dist/index.js', 'dist/server.js', 'dist/eng.js', 'dist/bin/eng.js', 'dist/bin/eng-mcp.js'] },
]

/** Spawn in its own process group. The timeout and the finally both kill that group, so an `npx` child (`sh`, `node`) does not survive. */
function run(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let timer: NodeJS.Timeout | undefined
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => { stdout += chunk })
  child.stderr?.on('data', (chunk: string) => { stderr += chunk })
  const result = new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    let settled = false
    const finish = (status: number) => {
      if (settled) return
      settled = true
      resolve({ status, stdout, stderr })
    }
    timer = setTimeout(() => {
      killChild(child)
      finish(1)
    }, TOOL_TIMEOUT_MS)
    child.on('error', () => finish(1))
    child.on('close', (code) => finish(code === null ? 1 : code))
  })
  return result.finally(() => {
    if (timer) clearTimeout(timer)
    killChild(child)
  })
}

function fail(message: string): never {
  throw new Error(message)
}

function assertOutsideRepo(dir: string): void {
  const rel = path.relative(root, path.resolve(dir))
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    fail(`refusing to install inside the repo: ${dir}`)
  }
}

function packageMeta(dir: string): PackageMeta {
  const file = path.join(root, 'packages', dir, 'package.json')
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!raw || typeof raw !== 'object' || typeof (raw as { name?: unknown }).name !== 'string') {
    fail(`${file} has no name`)
  }
  const rec = raw as { name: string; version?: unknown; private?: unknown }
  return {
    name: rec.name,
    version: typeof rec.version === 'string' ? rec.version : '',
    private: rec.private === true,
  }
}

function assertShebang(file: string): void {
  const text = fs.readFileSync(file, 'utf8')
  const line = text.split('\n', 1)[0]?.replace(/\r$/, '') ?? ''
  if (line !== SHEBANG) fail(`${file} line 1 is ${JSON.stringify(line)}, expected ${SHEBANG}`)
}

/** Bins emitted by `tsc -b`. Absent until the bin sources exist. */
function assertBuiltBins(pkgDir: string): void {
  const binDir = path.join(pkgDir, 'dist', 'bin')
  if (!fs.existsSync(binDir)) fail(`no dist/bin after tsc -b: ${binDir} (no eng-mcp shim)`)
  const js = fs.readdirSync(binDir).filter((name) => name.endsWith('.js')).sort()
  if (!js.includes('eng.js') || !js.includes('eng-mcp.js')) {
    fail(`dist/bin is missing eng.js or eng-mcp.js: ${js.join(', ') || '(empty)'} (no eng-mcp shim)`)
  }
  for (const name of js) assertShebang(path.join(binDir, name))
}

function chmodDistBins(pkgDir: string): void {
  const binDir = path.join(pkgDir, 'dist', 'bin')
  if (!fs.existsSync(binDir)) return
  for (const name of fs.readdirSync(binDir)) {
    if (name.endsWith('.js')) fs.chmodSync(path.join(binDir, name), 0o755)
  }
}

function assertClientReadme(name: string): void {
  const readme = fs.readFileSync(path.join(root, 'packages/agent-mcp/README.md'), 'utf8')
  const marker = '## After publish (T26)'
  const at = readme.indexOf(marker)
  if (at < 0) fail(`packages/agent-mcp/README.md has no "${marker}"`)
  const before = readme.slice(0, at)
  const after = readme.slice(at)
  const published = `npx --yes --package ${name} eng-mcp`
  if (!after.includes(published)) fail(`after-publish snippet must contain ${published}`)
  if (before.includes('npx --yes --package')) fail('pre-publish docs use the registry npx command')
  if (!before.includes('npx --no-install eng-mcp')) fail('pre-publish docs do not show npx --no-install eng-mcp')
  if (!before.includes('node_modules/.bin/eng-mcp')) fail('pre-publish docs do not show node_modules/.bin/eng-mcp')
  for (const pkg of ['@eng/core', '@eng/policy', '@eng/ledger', name]) {
    if (!before.includes(pkg)) fail(`pre-publish docs missing ${pkg}`)
  }
  if (!before.includes('TESTNET ONLY')) fail('pre-publish docs missing TESTNET ONLY')
  if (!after.includes('npx.cmd')) fail('after-publish docs missing Windows npx.cmd')
  if (!readme.includes('Node >= 22.13')) fail('docs missing Node >= 22.13')
  for (const banned of ['production-ready', 'secure', 'audited']) {
    if (readme.toLowerCase().includes(banned)) fail(`packages/agent-mcp/README.md says ${banned}`)
  }
}

async function assertArchive(tgz: string, required: string[], forbid: string[]): Promise<void> {
  const listed = await run('tar', ['-tzf', tgz], root)
  if (listed.status !== 0) fail(`tar -tzf ${tgz} failed:\n${listed.stderr}`)
  const entries = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  for (const entry of entries) {
    const parts = entry.split('/').filter(Boolean).slice(1)
    const rel = parts.join('/')
    if (parts.includes('src') || parts.includes('test')) fail(`${path.basename(tgz)} contains ${entry}`)
    const file = parts[parts.length - 1] ?? ''
    if (file.endsWith('.ts') && !file.endsWith('.d.ts')) fail(`${path.basename(tgz)} contains TypeScript source ${entry}`)
    if (forbid.some((banned) => rel === banned || rel.endsWith(`/${banned}`))) fail(`${path.basename(tgz)} contains ${entry}`)
  }
  for (const rel of required) {
    if (!entries.some((entry) => entry.endsWith(`/${rel}`))) fail(`${path.basename(tgz)} has no ${rel}`)
  }
  console.log(`tarball ${path.basename(tgz)} ${entries.length} files, no src/ test/ or .ts source`)
}

async function pack(pkg: Packed, dest: string): Promise<string> {
  const pkgDir = path.join(root, 'packages', pkg.dir)
  const built = path.join(pkgDir, 'dist', 'index.js')
  if (!fs.existsSync(built)) fail(`${pkg.dir} has no ${built}. Run npm run build first.`)
  chmodDistBins(pkgDir)
  const out = fs.mkdtempSync(path.join(dest, 'tgz-'))
  const packed = await run('npm', ['pack', '--json', '--pack-destination', out], pkgDir)
  if (packed.status !== 0) fail(`npm pack ${pkg.dir} failed:\n${packed.stderr || packed.stdout}`)
  let filename = ''
  try {
    const meta: unknown = JSON.parse(packed.stdout)
    const row = Array.isArray(meta) ? meta[0] : meta
    if (row && typeof row === 'object' && 'filename' in row && typeof row.filename === 'string') filename = row.filename
  } catch {
    fail(`npm pack ${pkg.dir} did not print JSON:\n${packed.stdout}`)
  }
  if (!filename) fail(`npm pack ${pkg.dir} JSON has no filename`)
  const tgz = path.join(out, filename)
  await assertArchive(tgz, pkg.required ?? ['dist/index.js'], pkg.forbid ?? [])
  return tgz
}

function smokeSource(names: { core: string; policy: string; ledger: string; provisioning: string }): string {
  return `
import { parseAmount } from '${names.core}'
import { layerHash } from '${names.policy}'
import { currencyHex } from '${names.ledger}'
import { ProvisioningCoordinator } from '${names.provisioning}'

const amount = parseAmount('1.50', { code: 'USD', kind: 'IOU', currency: 'USD', decimals: 2 })
if (amount.minor !== 150n) throw new Error('parseAmount(1.50) minor was ' + amount.minor.toString())
const hash = layerHash({ policyId: 'smoke', version: '0', layer: 'baseline', appliesTo: [], language: 'cel-eng/1', stages: {} })
if (!hash.startsWith('att:') || hash.length < 16) throw new Error('layerHash returned ' + hash)
if (currencyHex('USD') !== 'USD') throw new Error('currencyHex(USD) was ' + currencyHex('USD'))
const rlusd = currencyHex('RLUSD')
if (rlusd !== '524C555344'.padEnd(40, '0')) throw new Error('currencyHex(RLUSD) was ' + rlusd)
if (typeof ProvisioningCoordinator !== 'function') throw new Error('ProvisioningCoordinator missing')
console.log('pack-smoke imports ok', hash.slice(0, 12))
`
}

function installedPkg(installDir: string, name: string): string {
  return path.join(installDir, 'node_modules', ...name.split('/'))
}

function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  const pid = child.pid
  if (pid === undefined) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch { /* already exited */ }
  }
}

class RecordingStdio implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  /** Stdout lines that parsed as JSON-RPC. A banner or a blank line is not counted. */
  readonly jsonRpcLines: string[] = []
  /** Parse failures. listPackedTools fails when this is not empty. */
  readonly stdoutErrors: string[] = []
  stderrText = ''
  private buf = ''

  constructor(private readonly child: ChildProcess, private readonly secret: string) {}

  async start(): Promise<void> {
    this.child.stderr?.setEncoding('utf8')
    this.child.stderr?.on('data', (chunk: string) => { this.stderrText += chunk })
    this.child.stdout?.setEncoding('utf8')
    this.child.stdout?.on('data', (chunk: string) => this.onStdout(chunk))
    this.child.on('error', (err) => this.note(err.message))
    this.child.on('exit', () => this.onclose?.())
  }

  note(message: string): void {
    if (!this.stdoutErrors.includes(message)) this.stdoutErrors.push(message)
    this.onerror?.(new Error(message))
  }

  private onStdout(chunk: string): void {
    this.buf += chunk
    let nl = this.buf.indexOf('\n')
    while (nl >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '')
      this.buf = this.buf.slice(nl + 1)
      nl = this.buf.indexOf('\n')
      if (line.length === 0) {
        this.note('eng-mcp wrote a blank stdout line')
        continue
      }
      if (this.secret && line.includes(this.secret)) {
        this.note('eng-mcp stdout contains the agent seed')
        continue
      }
      try {
        const msg = deserializeMessage(line)
        this.jsonRpcLines.push(line)
        this.onmessage?.(msg)
      } catch {
        this.note(`eng-mcp stdout is not JSON-RPC: ${line.slice(0, 180)}`)
      }
    }
  }

  leftover(): string {
    return this.buf
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child.stdin
    if (!stdin) throw new Error('eng-mcp stdin is closed')
    const payload = serializeMessage(message)
    if (!stdin.write(payload)) await new Promise<void>((resolve) => stdin.once('drain', () => resolve()))
  }

  async close(): Promise<void> {
    killChild(this.child)
  }
}

function serverEnv(seed: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NO_UPDATE_NOTIFIER: '1',
    ENGAGEMENT_ID: 'eng_pack_smoke',
    ENGAGEMENT_ACCOUNT: 'rPackSmokeAccount',
    ASSET_ISSUER: 'rPackSmokeIssuer',
    AGENT_SEED: seed,
  }
}

function freshSeed(): string {
  const seed = xrpl.Wallet.generate().seed
  if (!seed) fail('could not generate a throwaway Testnet seed for pack-smoke')
  return seed
}

/** Spawn the packed bin, list tools, require JSON-RPC stdout, then always kill the child. */
async function listPackedTools(cwd: string, command: string, args: string[], seed: string): Promise<string[]> {
  const child = spawn(command, args, {
    cwd,
    env: serverEnv(seed),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  })
  const transport = new RecordingStdio(child, seed)
  const client = new Client({ name: 'pack-smoke', version: '0.1.0' })
  client.onerror = (error) => {
    const message = error instanceof Error ? error.message : String(error)
    if (!transport.stdoutErrors.includes(message)) transport.stdoutErrors.push(message)
  }
  let timer: NodeJS.Timeout | undefined
  try {
    const listed = await Promise.race([
      (async () => {
        await client.connect(transport)
        return client.listTools()
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('eng-mcp tools/list timed out after 20s')), TOOL_TIMEOUT_MS)
      }),
    ])
    if (transport.stdoutErrors.length > 0) throw new Error(transport.stdoutErrors.join('\n'))
    if (child.exitCode !== null) throw new Error(`eng-mcp exited ${child.exitCode} before tools/list finished`)
    const leftover = transport.leftover()
    if (leftover.length > 0) throw new Error(`eng-mcp left a partial stdout line: ${leftover.slice(0, 180)}`)
    if (seed && transport.stderrText.includes(seed)) throw new Error('eng-mcp stderr contains the agent seed')
    const readyDeadline = Date.now() + 2_000
    while (!transport.stderrText.includes('"msg":"agent-mcp ready"') && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    if (!transport.stderrText.includes('"live":false')) throw new Error('eng-mcp ready log did not report "live":false')
    if (transport.stderrText.includes('"live":true')) throw new Error('eng-mcp ready log reported a live ledger')
    const names = listed.tools.map((tool) => tool.name).sort()
    console.log(`eng-mcp ${command} ${args.join(' ')} tools ${names.join(', ')} (${transport.jsonRpcLines.length} json-rpc stdout lines)`)
    return names
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const stderr = seed && transport.stderrText.includes(seed) ? '[stderr redacted]' : transport.stderrText
    throw new Error(`${detail}\n${stderr}`)
  } finally {
    if (timer) clearTimeout(timer)
    try { await client.close() } catch { /* closing a dead pipe */ }
    killChild(child)
    await Promise.race([
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve()
        else child.once('exit', () => resolve())
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ])
  }
}

function assertTools(names: string[]): void {
  if (names.join(',') !== TOOLS.join(',')) fail(`tools/list was ${names.join(', ') || '(none)'}; expected ${TOOLS.join(', ')}`)
}

async function main(): Promise<void> {
  const agent = packageMeta('agent-mcp')
  if (!agent.private) fail(`${agent.name} must stay private:true`)
  if (agent.version !== '0.1.0') fail(`${agent.name} version must stay 0.1.0`)
  assertBuiltBins(path.join(root, 'packages', 'agent-mcp'))
  assertClientReadme(agent.name)

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-pack-'))
  try {
    assertOutsideRepo(scratch)
    console.log(`pack dir ${scratch}`)
    const names = new Map(PACKED.map((pkg) => [pkg.dir, packageMeta(pkg.dir).name]))
    const tarballs = new Map<string, string>()
    for (const pkg of PACKED) tarballs.set(names.get(pkg.dir)!, await pack(pkg, scratch))

    const installDir = path.join(scratch, 'install')
    fs.mkdirSync(installDir)
    assertOutsideRepo(installDir)
    fs.writeFileSync(path.join(installDir, 'package.json'), JSON.stringify({ name: 'eng-pack-smoke', private: true, type: 'module' }, null, 2))
    const cleanEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NO_UPDATE_NOTIFIER: '1' }
    const installed = await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs.values()], installDir, cleanEnv)
    if (installed.status !== 0) fail(`npm install failed:\n${installed.stderr || installed.stdout}`)
    const agentDir = installedPkg(installDir, agent.name)
    assertBuiltBins(agentDir)
    for (const bin of ['eng', 'eng-mcp']) {
      const shim = path.join(installDir, 'node_modules', '.bin', bin)
      if (!fs.existsSync(shim)) fail(`installed .bin/${bin} is missing (no shim)`)
      try { fs.accessSync(shim, fs.constants.X_OK) } catch { fail(`installed .bin/${bin} is not executable`) }
    }

    fs.writeFileSync(path.join(installDir, 'smoke.mjs'), smokeSource({
      core: names.get('core')!,
      policy: names.get('policy')!,
      ledger: names.get('ledger')!,
      provisioning: names.get('provisioning')!,
    }))
    const smoked = await run(process.execPath, ['smoke.mjs'], installDir, cleanEnv)
    if (smoked.stdout) process.stdout.write(smoked.stdout)
    if (smoked.status !== 0) fail(`import smoke failed (exit ${smoked.status}):\n${smoked.stderr}`)

    const shim = path.join(installDir, 'node_modules', '.bin', 'eng-mcp')
    const missing = await run('npx', ['--no-install', 'eng-mcp'], installDir, cleanEnv)
    if (missing.status !== 1 || !missing.stderr.includes('missing required env ENGAGEMENT_ID') || missing.stdout.trim() !== '') {
      fail(`eng-mcp with no env expected exit 1, empty stdout, and missing ENGAGEMENT_ID, got exit ${missing.status}:\n${missing.stdout}${missing.stderr}`)
    }
    console.log(`eng-mcp missing env exit ${missing.status}: ${missing.stderr.trim()}`)

    const help = await run('npx', ['--no-install', 'eng', 'open', '--help'], installDir, cleanEnv)
    const helpOut = `${help.stdout}\n${help.stderr}`
    if (help.status !== 0 || !help.stdout.includes('TESTNET ONLY') || !help.stdout.includes('--template')) {
      fail(`eng open --help expected exit 0 and TESTNET ONLY help, got exit ${help.status}:\n${helpOut}`)
    }
    console.log('eng open --help exit 0')

    assertTools(await listPackedTools(installDir, 'npx', ['--no-install', 'eng-mcp'], freshSeed()))
    assertTools(await listPackedTools(installDir, shim, [], freshSeed()))
    console.log('pack-smoke passed')
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).stack ?? String(error))
  process.exit(1)
})
