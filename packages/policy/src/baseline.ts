// Which baseline a template is evaluated with. Policy versions are bumped, never edited in place:
// hotel@1 and hotel@2 stay on baseline@1.1.0; marketplace-escrow@1 names baseline@1.2.0.
import type { Template } from '@eng/core'
import type { PolicyDoc } from './types.ts'

export function policyVersionRef(p: Pick<PolicyDoc, 'policyId' | 'version'>): string {
  return `${p.policyId}@${p.version}`
}

/**
 * The baseline layer for `template`.
 * A `baselineRef` selects that baseline. Templates that omit it (hotel@1, hotel@2) use baseline
 * 1.1.0 when that version is loaded, so a newer baseline in the same library does not retarget them.
 */
export function baselineFor(template: Template, policies: readonly PolicyDoc[]): PolicyDoc | undefined {
  const ref = template.baselineRef
  if (ref) return policies.find((p) => p.layer === 'baseline' && policyVersionRef(p) === ref)
  return policies.find((p) => p.layer === 'baseline' && p.version === '1.1.0')
    ?? policies.find((p) => p.layer === 'baseline')
}
