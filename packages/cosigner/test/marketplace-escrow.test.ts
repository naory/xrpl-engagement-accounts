// marketplace-escrow@1 intake, receipt freshness, disputes, and the lateRuling gate.
// Hotel's own suites cover the unchanged hotel path, including a late ruling staying LATE.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { localSigner, signStatement, type Statement, type Template } from '@eng/core'
import { CosignerService, FixtureLedgerSource } from '@eng/cosigner'
import { arbiterAccreditation, closeBatch, fixtureTrust, memo, wallet, LEDGER_INDEX, W } from '../../policy/test/fixtures.ts'
import type { EngagementRecord, LedgerSnapshot, PolicyDoc } from '@eng/policy'

const root = new URL('../../../', import.meta.url)
const readJson = <T>(rel: string): T => JSON.parse(fs.readFileSync(new URL(rel, root), 'utf8')) as T
const template = readJson<Template>('templates/marketplace-escrow@1.json')
const policy = readJson<PolicyDoc>('policies/marketplace-escrow@1.0.0.json')
const baseline12 = readJson<PolicyDoc>('policies/baseline@1.2.0.json')

const carrier = wallet('marketplace-escrow-carrier')
const stranger = wallet('marketplace-escrow-stranger')
const rotated = wallet('marketplace-escrow-rotated')
const eng = wallet('marketplace-escrow-account')
const ENG = 'eng_marketplace_service'
const OPEN = '2026-11-01T00:00:00Z'
const SHIP_BY = '2026-11-04T00:00:00Z'
const INSPECT_BY = '2026-11-11T00:00:00Z'

function record(): EngagementRecord {
  return {
    engagementId: ENG,
    template: template.templateId,
    account: eng.address,
    asset: 'RLUSD',
    parties: {
      principal: W.dana.address,
      counterparty: W.atlas.address,
      arbiter: W.arbiter.address,
      cosigner: W.cosigner.address,
    },
    fee: { bps: 50, to: W.service.address },
    deleteTo: W.service.address,
    amount: { asset: 'RLUSD', value: '2.00' },
    timers: { open: OPEN, shipBy: SHIP_BY, inspectBy: INSPECT_BY },
    attesters: { shipping: { accounts: [carrier.address], kind: 'SHIPPING', types: ['shipping.shipped/1'] } },
    state: 'OPEN',
    consumed: [],
    trust: fixtureTrust([baseline12, policy]),
  }
}

function snap(over: { closeTime: string; balance?: string; dispute?: boolean; carrier?: LedgerSnapshot['accounts'][string] } ): LedgerSnapshot {
  return {
    index: LEDGER_INDEX,
    hash: 'F'.repeat(64),
    closeTime: over.closeTime,
    baseFeeDrops: '10',
    reserveIncDrops: '200000',
    accounts: {
      [eng.address]: {
        exists: true, masterDisabled: true, regularKey: null,
        ownerObjects: { trustlines: 1, signerList: true, tickets: Array.from({ length: 16 }, (_, i) => 101 + i), other: 0 },
      },
      ...(over.carrier ? { [carrier.address]: over.carrier } : {}),
    },
    balances: { [eng.address]: { RLUSD: over.balance ?? '2.00' } },
    credentials: [
      arbiterAccreditation(),
      ...(over.dispute ? [{ issuer: W.dana.address, subject: eng.address, type: 'ENG/DISPUTE', accepted: true, expiration: null }] : []),
    ],
    history: {},
  }
}

function signed(signer: { address: string; publicKey: string; privateKey: string }, type: string, at: string, nonce: string, claim: Record<string, unknown> = {}): Statement {
  return signStatement({
    v: 'eng.att/1', type, engagementId: ENG,
    subject: { item: 'sku-1' }, claim,
    observedAt: at, issuedAt: at, nonce,
    attester: { account: signer.address, kind: type.startsWith('shipping') ? 'SHIPPING' : signer.address === W.arbiter.address ? 'ARBITER' : 'PARTY' },
  }, signer as never)
}

async function setup(closeTime: string, balance?: string, dispute = false, timers?: EngagementRecord['timers']) {
  const source = new FixtureLedgerSource(snap({ closeTime, balance, dispute }))
  const svc = new CosignerService({
    signer: localSigner(W.cosigner), source,
    templates: [template], policies: [baseline12, policy],
  })
  const rec = record()
  if (timers) rec.timers = timers
  await svc.register(rec, null)
  return { svc, source }
}

const releaseExact = () => closeBatch(
  [{ to: W.atlas.address, value: '1.99' }, { to: W.service.address, value: '0.01' }],
  { account: eng.address, tickets: true, memos: [memo('eng/basis', 'default.release')] },
)
const refundAll = (value: string) => closeBatch(
  [{ to: W.dana.address, value }],
  { account: eng.address, tickets: true, memos: [memo('eng/basis', 'default.refund')] },
)

describe('marketplace-escrow intake and disputes', () => {
  it('receipts a named carrier and refuses a seller, a stranger, a late post, a second shipment, and a disallowed type', async () => {
    const { svc } = await setup('2026-11-02T12:00:00Z')
    const shipped = signed(carrier, 'shipping.shipped/1', '2026-11-02T11:59:00Z', 'me-ship-1')
    await svc.ingest(ENG, shipped)
    expect(svc.statements(ENG).map((s) => s.id)).toEqual([shipped.id])

    const again = await setup('2026-11-02T12:00:00Z')
    const seller = signed(W.atlas, 'shipping.shipped/1', '2026-11-02T11:59:00Z', 'me-ship-seller')
    await expect(again.svc.ingest(ENG, seller)).rejects.toThrow(/REJECTED: SELF_ATTESTED/)
    const third = signed(stranger, 'shipping.shipped/1', '2026-11-02T11:59:00Z', 'me-ship-stranger')
    await expect(again.svc.ingest(ENG, third)).rejects.toThrow(/NOT_A_PARTY/)
    const wrongType = signed(carrier, 'party.dispute/1', '2026-11-02T11:59:00Z', 'me-ship-type', { reason: 'no' })
    await expect(again.svc.ingest(ENG, wrongType)).rejects.toThrow(/TYPE_NOT_ALLOWED/)

    const late = await setup('2026-11-04T00:00:01Z')
    await expect(late.svc.ingest(ENG, signed(carrier, 'shipping.shipped/1', '2026-11-04T00:00:00Z', 'me-ship-late'))).rejects.toThrow(/LATE: shipping.shipped\/1 after shipBy/)
    const early = await setup('2026-10-31T23:00:00Z')
    await expect(early.svc.ingest(ENG, signed(carrier, 'shipping.shipped/1', '2026-10-31T22:59:00Z', 'me-ship-early'))).rejects.toThrow(/TOO_EARLY/)

    await expect(svc.ingest(ENG, signed(carrier, 'shipping.shipped/1', '2026-11-02T12:00:00Z', 'me-ship-2'))).rejects.toThrow(/ALREADY_SHIPPED/)
  })

  it('a shipment posted after shipBy is LATE, and default.refund then signs', async () => {
    const { svc } = await setup('2026-11-04T00:00:01Z')
    await expect(svc.ingest(ENG, signed(carrier, 'shipping.shipped/1', '2026-11-04T00:00:00Z', 'me-ship-after'))).rejects.toThrow(/LATE/)
    const d = await svc.decide({ engagementId: ENG, stage: 'default.refund', tx: refundAll('2.00') })
    expect(d.decision).toBe('SIGN')
    expect(d.failing).toEqual([])
  })

  it('a receipted shipment observed three days before inspectBy still releases, including after the carrier rotates its key', async () => {
    const observed = '2026-11-08T00:00:00Z'
    // shipBy stays after the receipt; inspectBy is three days after observedAt. The 1-day maxLag would drop it at inspectBy.
    const { svc, source } = await setup('2026-11-08T00:01:00Z', '2.00', false, {
      open: OPEN, shipBy: '2026-11-09T00:00:00Z', inspectBy: '2026-11-11T00:00:00Z',
    })
    await svc.ingest(ENG, signed(carrier, 'shipping.shipped/1', observed, 'me-ship-old'))
    source.snap = snap({
      closeTime: '2026-11-11T00:00:01Z',
      carrier: { exists: true, masterDisabled: true, regularKey: rotated.address },
    })
    const d = await svc.decide({ engagementId: ENG, stage: 'default.release', tx: releaseExact() })
    expect(d.failing).toEqual([])
    expect(d.decision).toBe('SIGN')
  })

  it('only the buyer can dispute, and only once bonded; a late ruling is still receipted', async () => {
    const { svc, source } = await setup('2026-11-05T12:00:00Z', '2.00')
    const sellerDispute = signed(W.atlas, 'party.dispute/1', '2026-11-05T11:59:00Z', 'me-dispute-seller', { reason: 'no' })
    await expect(svc.ingest(ENG, sellerDispute)).rejects.toThrow(/NOT_DISPUTANT/)
    const bare = signed(W.dana, 'party.dispute/1', '2026-11-05T11:59:00Z', 'me-dispute-bare', { reason: 'not received' })
    await expect(svc.ingest(ENG, bare)).rejects.toThrow(/NOT_BONDED/)

    source.snap = snap({ closeTime: '2026-11-05T12:00:00Z', balance: '2.50', dispute: true })
    const opened = signed(W.dana, 'party.dispute/1', '2026-11-05T11:59:00Z', 'me-dispute-open', { reason: 'not received' })
    await svc.ingest(ENG, opened)
    await expect(svc.ingest(ENG, signed(W.dana, 'party.dispute/1', '2026-11-05T11:59:30Z', 'me-dispute-2', { reason: 'again' }))).rejects.toThrow(/ALREADY_DISPUTED/)

    source.snap = snap({ closeTime: '2026-11-20T12:00:00Z', balance: '2.50', dispute: true })
    const ruling = signed(W.arbiter, 'party.ruling/1', '2026-11-20T11:59:00Z', 'me-ruling-late', { outcome: 'refund' })
    await svc.ingest(ENG, ruling)
    expect(svc.statements(ENG).some((s) => s.type === 'party.ruling/1')).toBe(true)
  })
})
