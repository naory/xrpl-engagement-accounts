// Pack the publishable packages, install the tarballs outside the repo, and
// import them with Node. No --conditions=source: the tarball's "default"
// export is dist/. Run `npm run build` first. dist/ is gitignored and is
// absent when `npm test` runs.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

interface Packed {
  name: string
  dir: string
  /** Paths that must be present inside the tarball, under its package root. */
  required?: string[]
  /** Paths that must not be packed. The CLIs stay source-only. */
  forbid?: string[]
}

const CLI_OUT = ['dist/cli.js', 'dist/cli.d.ts', 'dist/cli.js.map', 'dist/cli.d.ts.map']

const PACKED: Packed[] = [
  { name: '@eng/core', dir: 'core', forbid: CLI_OUT },
  { name: '@eng/policy', dir: 'policy', forbid: CLI_OUT },
  { name: '@eng/ledger', dir: 'ledger' },
  { name: '@eng/provisioning', dir: 'provisioning' },
  { name: '@eng/agent-mcp', dir: 'agent-mcp', required: ['dist/index.js', 'dist/server.js', 'dist/eng.js'] },
]

function run(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' })
  return { status: result.status === null ? 1 : result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function assertOutsideRepo(dir: string): void {
  const rel = path.relative(root, path.resolve(dir))
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    fail(`refusing to install inside the repo: ${dir}`)
  }
}

function assertArchive(tgz: string, required: string[], forbid: string[]): void {
  const listed = run('tar', ['-tzf', tgz], root)
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

function pack(pkg: Packed, dest: string): string {
  const built = path.join(root, 'packages', pkg.dir, 'dist', 'index.js')
  if (!fs.existsSync(built)) fail(`${pkg.name} has no ${built}. Run npm run build first.`)
  const out = fs.mkdtempSync(path.join(dest, 'tgz-'))
  const packed = run('npm', ['pack', '--json', '--pack-destination', out], path.join(root, 'packages', pkg.dir))
  if (packed.status !== 0) fail(`npm pack ${pkg.name} failed:\n${packed.stderr || packed.stdout}`)
  let filename = ''
  try {
    const meta: unknown = JSON.parse(packed.stdout)
    const row = Array.isArray(meta) ? meta[0] : meta
    if (row && typeof row === 'object' && 'filename' in row && typeof row.filename === 'string') filename = row.filename
  } catch {
    fail(`npm pack ${pkg.name} did not print JSON:\n${packed.stdout}`)
  }
  if (!filename) fail(`npm pack ${pkg.name} JSON has no filename`)
  const tgz = path.join(out, filename)
  assertArchive(tgz, pkg.required ?? ['dist/index.js'], pkg.forbid ?? [])
  return tgz
}

function smokeSource(): string {
  return `
import { parseAmount } from '@eng/core'
import { layerHash } from '@eng/policy'
import { currencyHex } from '@eng/ledger'
import { ProvisioningCoordinator } from '@eng/provisioning'

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

function main(): void {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-pack-'))
  assertOutsideRepo(scratch)
  console.log(`pack dir ${scratch}`)
  const tarballs = new Map<string, string>()
  for (const pkg of PACKED) tarballs.set(pkg.name, pack(pkg, scratch))

  const installDir = path.join(scratch, 'install')
  fs.mkdirSync(installDir)
  assertOutsideRepo(installDir)
  const dependencies = Object.fromEntries([...tarballs].map(([name, tgz]) => [name, `file:${tgz}`]))
  fs.writeFileSync(path.join(installDir, 'package.json'), JSON.stringify({
    name: 'eng-pack-smoke',
    private: true,
    type: 'module',
    dependencies,
  }, null, 2))
  const cleanEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }
  const installed = run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], installDir, cleanEnv)
  if (installed.status !== 0) fail(`npm install failed:\n${installed.stderr || installed.stdout}`)
  fs.writeFileSync(path.join(installDir, 'smoke.mjs'), smokeSource())
  const smoked = run(process.execPath, ['smoke.mjs'], installDir, cleanEnv)
  if (smoked.stdout) process.stdout.write(smoked.stdout)
  if (smoked.status !== 0) fail(`import smoke failed (exit ${smoked.status}):\n${smoked.stderr}`)
  const server = run(process.execPath, ['node_modules/@eng/agent-mcp/dist/server.js'], installDir, cleanEnv)
  const serverErr = server.stderr.trim()
  if (server.status !== 1 || !serverErr.includes('missing required env ENGAGEMENT_ID')) {
    fail(`agent-mcp entry expected exit 1 and missing ENGAGEMENT_ID, got exit ${server.status}:\n${server.stdout}${serverErr}`)
  }
  console.log(`agent-mcp entry exit ${server.status}: ${serverErr}`)
  const help = run(process.execPath, ['node_modules/@eng/agent-mcp/dist/eng.js', 'open', '--help'], installDir, cleanEnv)
  const helpOut = `${help.stdout}\n${help.stderr}`
  if (help.status !== 0 || !help.stdout.includes('TESTNET ONLY') || !help.stdout.includes('--template')) {
    fail(`eng open --help expected exit 0 and TESTNET ONLY help, got exit ${help.status}:\n${helpOut}`)
  }
  console.log('eng open --help exit 0')
  console.log('pack-smoke passed')
}

main()
