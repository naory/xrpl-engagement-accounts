// Plain-English check labels for the procurement-family demo scenarios, taken from the policies themselves
// (each rule's `title` and `message`, required by lint L8). Published as public/policy-text.json so the static
// page shows the policy's own words; regenerate with `npm run web:policy-text`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ruleExplanations, type PolicyDoc } from '@eng/policy'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const POLICY_FILES = ['policies/baseline@1.1.0.json', 'policies/procurement@1.3.0.json']

export interface PolicyText {
  generatedBy: string
  policies: string[]
  rules: Record<string, { title?: string; message?: string }>
}

export function procurementPolicies(): PolicyDoc[] {
  return POLICY_FILES.map((f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')) as PolicyDoc)
}

export function buildPolicyText(): PolicyText {
  const layers = procurementPolicies()
  return {
    generatedBy: 'npm run web:policy-text (packages/web/src/policy-text.ts)',
    policies: layers.map((l) => `${l.policyId}@${l.version}`),
    rules: ruleExplanations(layers),
  }
}
