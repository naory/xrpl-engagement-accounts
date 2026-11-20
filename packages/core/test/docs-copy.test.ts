// The docs copy checker bans "production-ready" in the root README, including a negation.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { collectProblems, readmeCopyProblems } from '../../../scripts/check-trust-model.ts'

const root = new URL('../../../', import.meta.url)

describe('docs copy checker', () => {
  it('fails a README that says not production-ready, then passes the real README', () => {
    const real = fs.readFileSync(new URL('README.md', root), 'utf8')
    const bad = real.replace('not for mainnet funds.', 'not production-ready.')
    expect(bad).not.toBe(real)
    expect(readmeCopyProblems(bad)).toEqual(['README.md: banned words production-ready'])

    expect(readmeCopyProblems(real)).toEqual([])
    expect(collectProblems()).toEqual([])
  })
})
