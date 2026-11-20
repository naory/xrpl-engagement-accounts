// Boot-time helpers for CosignerService.open() (durable co-signer design §2.4, §2a.1, §2a.5).
import fs from 'node:fs'
import path from 'node:path'
import { documentHash, type Statement, type Template } from '@eng/core'
import { layerHash, type PolicyDoc } from '@eng/policy'
import type { StoredEngagement } from './types.ts'

export type Pins = StoredEngagement['pins']

/** The pins a registration records: its resolved layers' hashes (baseline first) and its template's hash. */
export function pinsOf(layers: PolicyDoc[], template: Template): Pins {
  return { layerHashes: layers.map(layerHash), templateId: template.templateId, templateHash: documentHash(template) }
}

/**
 * The layers and template an engagement was registered with, found again in the loaded library by hash. Any pin that is
 * missing or hashes differently gives a reason instead: the engagement is then quarantined, never re-resolved.
 */
export function resolvePins(pins: Pins, policies: PolicyDoc[], templates: Template[]): { layers: PolicyDoc[]; template: Template } | { reason: string } {
  if (!pins.layerHashes.length) return { reason: 'no pinned policy layers' }
  const layers: PolicyDoc[] = []
  for (const h of pins.layerHashes) {
    const p = policies.find((x) => layerHash(x) === h)
    if (!p) return { reason: `pinned policy layer ${h} is not in the library` }
    layers.push(p)
  }
  const template = templates.find((t) => t.templateId === pins.templateId)
  if (!template) return { reason: `pinned template ${pins.templateId} is not loaded` }
  const hash = documentHash(template)
  if (hash !== pins.templateHash) return { reason: `template ${pins.templateId} hashes ${hash}, pinned ${pins.templateHash}` }
  return { layers, template }
}

/** The statements in `<dataDir>/decisions.jsonl`, in file order; none if the file is absent. Unparsable lines are skipped with a warning. */
export function readDecisionsJsonl(dataDir: string): Statement[] {
  const file = path.join(dataDir, 'decisions.jsonl')
  if (!fs.existsSync(file)) return []
  const out: Statement[] = []
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (!line.trim()) return
    try { out.push(JSON.parse(line) as Statement) } catch { console.warn(`decisions.jsonl line ${i + 1} is not JSON; not imported`) }
  })
  return out
}
