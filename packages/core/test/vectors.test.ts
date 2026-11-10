// Conformance runner for the statement envelope and the template validator.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { canonicalize, statementDigest, validateTemplate, verifyStatement, type Statement } from '@eng/core'

const read = (n: string) => JSON.parse(fs.readFileSync(new URL(`../../../vectors/${n}`, import.meta.url), 'utf8'))

describe('statement vectors', () => {
  for (const c of read('statements.json').cases) {
    it(c.name, () => {
      const s = c.statement as Statement
      expect(verifyStatement(s)).toEqual(c.expect)
      if (c.valid) {
        const { proof: _p, id: _i, ...body } = s
        expect(canonicalize(body)).toBe(c.jcs)
        expect(statementDigest(body).toString('hex').toUpperCase()).toBe(c.digest)
        expect(s.id).toBe(`att:${c.digest}`)
      }
    })
  }
})

describe('template vectors', () => {
  for (const c of read('templates.json').cases) {
    it(c.name, () => {
      const r = validateTemplate(c.template, c.options.preCreateFundingDrops ? { preCreateFundingDrops: BigInt(c.options.preCreateFundingDrops) } : {})
      expect({
        ok: r.ok, errors: [...new Set(r.errors.map((e) => e.id))].sort(), warnings: [...new Set(r.warnings.map((w) => w.id))].sort(),
        disclosures: r.disclosures.map((x) => x.id), minimalWinningSets: r.minimalWinningSets, ticketsNeeded: r.ticketsNeeded, reserveDrops: r.reserveDrops.toString(),
      }).toEqual(c.expect)
    })
  }
})
