// The procurement demo's check labels come from the policies' own plain-English text (title, message),
// published as public/policy-text.json — never from strings written in the page.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildPolicyText } from '../src/policy-text.ts'

describe('policy-text.json', () => {
  it('carries the baseline and procurement policies’ own titles and explanations', () => {
    const t = buildPolicyText()
    expect(t.policies).toEqual(['pol_baseline@1.1.0', 'pol_procurement@1.3.0'])
    expect(t.rules.W2.title).toBe('Approved, verified vendor')
    expect(t.rules.B6.title).toBe('Pays only people in the deal')
    for (const id of ['B1', 'B6', 'B11', 'W0', 'W2', 'W3', 'W5', 'W6', 'W7', 'O1']) {
      expect(t.rules[id]?.title, id).toBeTruthy()
      expect(t.rules[id]?.message, id).toBeTruthy()
    }
  })
  it('the committed file matches a fresh build (run npm run web:policy-text)', () => {
    const committed = JSON.parse(fs.readFileSync(new URL('../public/policy-text.json', import.meta.url), 'utf8'))
    expect(committed).toEqual(buildPolicyText())
  })
})
