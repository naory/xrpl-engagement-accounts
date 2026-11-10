// Conformance runner: replays vectors/policy.json through decide() and compares the normative fields.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decide } from '@eng/policy'
import { deserializeInput, expectedOf } from '../../../vectors/build.ts'

const v = JSON.parse(fs.readFileSync(new URL('../../../vectors/policy.json', import.meta.url), 'utf8'))

describe(`policy vectors (${v.format})`, () => {
  for (const c of v.cases) {
    it(`${c.name}: ${c.expect.decision}${c.expect.failing.length ? ' ' + c.expect.failing.join(',') : ''}`, () => {
      expect(expectedOf(decide(deserializeInput(c.input, v.context)))).toEqual(c.expect)
    })
  }
})
