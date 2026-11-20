// Child process for the crash test in restart.test.ts (not a test file itself). It opens a co-signer on the given
// SQLite file, SIGNs one b1 payment (an in-flight spend), prints the result as one JSON line and then idles until the
// parent SIGKILLs it: no close(), no lease release, no clean shutdown.
// Usage: node --conditions=source --import tsx crash-child.ts <file> <leaseMs>
import { localSigner } from '@eng/core'
import { CosignerService, SqliteStateStore, type SnapshotRequest } from '@eng/cosigner'
import { W, b1Engagement, b1Invoice, b1Ledger, b1Mandate, b1Payment, historyEntry, policies, templates } from '../../policy/test/fixtures.ts'

const [file, leaseMs] = [process.argv[2]!, Number(process.argv[3])]
const ledger = b1Ledger({ history: [historyEntry('9000', '2026-11-18T02:00:00Z')] })
const store = await SqliteStateStore.open({ file, leaseMs })
const svc = await CosignerService.open({
  signer: localSigner(W.cosigner), store,
  source: { snapshot: async (_q: SnapshotRequest) => structuredClone(ledger) },
  templates: [templates.procurement], policies: [policies.baseline, policies.procurement],
})
await svc.register(b1Engagement(), b1Mandate())
const r = await svc.decide({
  engagementId: 'eng_b1_fixture', stage: 'spend',
  tx: { ...b1Payment(W.vendorA.address, '600', { invoice: 'inv:A' }), Sequence: 21 },
  statements: [b1Invoice(W.vendorA, '600.00', 'inv:A')],
})
process.stdout.write(JSON.stringify({ decision: r.decision, inflight: svc.inflightFor('eng_b1_fixture') }) + '\n')
setInterval(() => {}, 1 << 30) // stay alive (and keep renewing the lease) until killed
