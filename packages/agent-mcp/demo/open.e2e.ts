// Opt-in Testnet run. Not part of npm test.
//   ENG_OPEN_TESTNET=1 npm run test:open
// Requires `npm run cosigner:local` and a reachable Testnet faucet.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { findRepoRoot } from '@eng/ledger'

const live = process.env.ENG_OPEN_TESTNET === '1'

describe.skipIf(!live)('eng open on Testnet', () => {
  it('prints the banner and the engagement id, and not the bearer', () => {
    const root = findRepoRoot(process.cwd())
    const dataDir = process.env.DATA_DIR ?? path.join(root, '.cosigner')
    const discoveryPath = path.join(dataDir, 'local.json')
    const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8')) as { tokenPath: string }
    const token = fs.readFileSync(discovery.tokenPath, 'utf8').trim()
    const result = spawnSync(path.join(root, 'node_modules/.bin/tsx'), ['--conditions=source', 'packages/agent-mcp/src/eng.ts', 'open', '--template', 'procurement@1', '--json', '--cosigner-dir', dataDir], {
      cwd: root,
      env: { ...process.env, DATA_DIR: dataDir },
      encoding: 'utf8',
      timeout: 600_000,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('TESTNET ONLY')
    expect(result.stdout).not.toContain(token)
    const parsed = JSON.parse(result.stdout) as { env: { ENGAGEMENT_ID: string; ENGAGEMENT_ACCOUNT: string; COSIGNER_API_TOKEN_FILE: string } }
    expect(parsed.env.ENGAGEMENT_ID.startsWith('eng_open_')).toBe(true)
    expect(parsed.env.ENGAGEMENT_ACCOUNT.startsWith('r')).toBe(true)
    expect(parsed.env.COSIGNER_API_TOKEN_FILE).toBe(path.resolve(discovery.tokenPath))
  }, 600_000)
})
