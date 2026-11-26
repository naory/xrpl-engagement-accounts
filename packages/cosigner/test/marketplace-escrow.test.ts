// marketplace-escrow@1 intake, receipt freshness, disputes, and the lateRuling gate.
// Hotel's own suites cover the unchanged hotel path, including a late ruling staying LATE.
import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { localSigner, signStatement, type Statement, type Template } from '@eng/core'
import { CosignerService, FixtureLedgerSource, LedgerUnavailableError, MemoryStateStore, multisignBlob, reportRulingOverdue, startTickScheduler, type RulingOverdue } from '@eng/cosigner'
import { arbiterAccreditation, closeBatch, fixtureTrust, memo, wallet, LEDGER_INDEX, W } from '../../policy/test/fixtures.ts'
import type { EngagementRecord, LedgerSnapshot, PolicyDoc } from '@eng/policy'

const root = new URL('../../../', import.meta.url)
const readJson = <T>(rel: string): T => JSON.parse(fs.readFileSync(new URL(rel, root), 'utf8')) as T
const template = readJson<Template>('templates/marketplace-escrow@1.json')
const policy = readJson<PolicyDoc>('policies/marketplace-escrow@1.1.0.json')
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
      { issuer: W.accreditor.address, subject: carrier.address, type: 'ENG/ATTESTER/SHIPPING', accepted: true, expiration: INSPECT_BY },
      ...(over.dispute ? [{ issuer: W.dana.address, subject: eng.address, type: 'ENG/DISPUTE', accepted: true, expiration: null }] : []),
    ],
    history: {},
  }
}

function mandate(over: { maximum?: string; payee?: string } = {}): Statement {
  return signStatement({
    v: 'eng.att/1', type: 'party.mandate/1', engagementId: ENG,
    subject: { mandateId: 'mnd_me' },
    claim: { maximum: over.maximum ?? '2.00', payee: over.payee ?? W.atlas.address },
    observedAt: OPEN, issuedAt: OPEN, nonce: 'me-mandate',
    attester: { account: W.dana.address, kind: 'PRINCIPAL' },
  }, W.dana)
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
  await svc.register(rec, mandate())
  return { svc, source }
}

const releaseExact = () => closeBatch(
  [{ to: W.atlas.address, value: '1.99' }, { to: W.service.address, value: '0.01' }],
  { account: eng.address, memos: [memo('eng/basis', 'default.release')] },
)
const refundAll = () => closeBatch(
  [{ to: W.dana.address, value: '0', partial: true }],
  { account: eng.address, memos: [memo('eng/basis', 'default.refund')] },
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
    const d = await svc.decide({ engagementId: ENG, stage: 'default.refund', tx: refundAll() })
    expect(d.decision).toBe('SIGN')
    expect(d.failing).toEqual([])
  })

  it('a receipted shipment observed before shipBy still releases at inspectBy, including after the carrier rotates its key', async () => {
    const observed = '2026-11-03T00:00:00Z'
    // Receipt is a day before shipBy. inspectBy is eight days after observedAt, past the 1-day maxLag.
    const { svc, source } = await setup('2026-11-03T00:01:00Z', '2.00', false)
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

describe('marketplace-escrow register terms', () => {
  async function bare(closeTime = OPEN) {
    const source = new FixtureLedgerSource(snap({ closeTime }))
    const svc = new CosignerService({
      signer: localSigner(W.cosigner), source, templates: [template], policies: [baseline12, policy],
    })
    return svc
  }

  it('rejects a ship window under 24h, an inspect gap under 7d, a missing carrier, rulingWindow, and a bad mandate', async () => {
    const shortShip = record()
    shortShip.timers = { open: OPEN, shipBy: '2026-11-01T23:59:59Z', inspectBy: '2026-11-08T23:59:59Z' }
    await expect((await bare()).register(shortShip, mandate())).rejects.toThrow(/INVALID_TERMS: shipBy − open is under minShipWindow/)

    const shortGap = record()
    shortGap.timers = { open: OPEN, shipBy: '2026-11-02T00:00:00Z', inspectBy: '2026-11-08T23:59:59Z' }
    await expect((await bare()).register(shortGap, mandate())).rejects.toThrow(/INVALID_TERMS: inspectBy − shipBy is under minInspectGap/)

    const noCarrier = record()
    noCarrier.attesters = { shipping: { accounts: [], kind: 'SHIPPING', types: ['shipping.shipped/1'] } }
    await expect((await bare()).register(noCarrier, mandate())).rejects.toThrow(/INVALID_TERMS: record.attesters.shipping.accounts/)

    const windowed = record()
    windowed.terms = { nights: 1, nightly: '0', rulingWindow: '3600s' }
    await expect((await bare()).register(windowed, mandate())).rejects.toThrow(/INVALID_TERMS: terms.rulingWindow/)

    await expect((await bare()).register(record(), mandate({ maximum: '1.99' }))).rejects.toThrow(/INVALID_TERMS: the amount is over the mandate maximum/)
    await expect((await bare()).register(record(), mandate({ payee: W.dana.address }))).rejects.toThrow(/INVALID_TERMS: the seller is not the mandate payee/)
    await expect((await bare()).register(record(), null)).rejects.toThrow(/INVALID_TERMS: the buyer's mandate is required/)

    const exact = record()
    exact.timers = { open: OPEN, shipBy: '2026-11-02T00:00:00Z', inspectBy: '2026-11-09T00:00:00Z' }
    await expect((await bare()).register(exact, mandate())).resolves.toMatchObject({ ok: true })
  })

  it('rejects a seller-signed mandate, a wrong type, a wrong engagement, and a constraints-only or wrong-currency maximum', async () => {
    const seller = signStatement({
      v: 'eng.att/1', type: 'party.mandate/1', engagementId: ENG,
      subject: { mandateId: 'mnd_seller' }, claim: { maximum: '2.00', payee: W.atlas.address },
      observedAt: OPEN, issuedAt: OPEN, nonce: 'me-mandate-seller',
      attester: { account: W.atlas.address, kind: 'COUNTERPARTY' },
    }, W.atlas)
    await expect((await bare()).register(record(), seller)).rejects.toThrow(/INVALID_TERMS: the mandate attester must be the principal/)

    const wrongType = signStatement({
      v: 'eng.att/1', type: 'party.review/1', engagementId: ENG,
      subject: { mandateId: 'mnd_type' }, claim: { maximum: '2.00', payee: W.atlas.address },
      observedAt: OPEN, issuedAt: OPEN, nonce: 'me-mandate-type',
      attester: { account: W.dana.address, kind: 'PRINCIPAL' },
    }, W.dana)
    await expect((await bare()).register(record(), wrongType)).rejects.toThrow(/INVALID_TERMS: the mandate type must be party.mandate\/1/)

    const wrongEng = signStatement({
      v: 'eng.att/1', type: 'party.mandate/1', engagementId: 'eng_other',
      subject: { mandateId: 'mnd_eng' }, claim: { maximum: '2.00', payee: W.atlas.address },
      observedAt: OPEN, issuedAt: OPEN, nonce: 'me-mandate-eng',
      attester: { account: W.dana.address, kind: 'PRINCIPAL' },
    }, W.dana)
    await expect((await bare()).register(record(), wrongEng)).rejects.toThrow(/INVALID_TERMS: the mandate is for a different engagement/)

    const legacy = signStatement({
      v: 'eng.att/1', type: 'party.mandate/1', engagementId: ENG,
      subject: { mandateId: 'mnd_legacy' },
      claim: { constraints: { payee: W.atlas.address, maxTotal: { currency: 'RLUSD', value: '2.00' } } },
      observedAt: OPEN, issuedAt: OPEN, nonce: 'me-mandate-legacy',
      attester: { account: W.dana.address, kind: 'PRINCIPAL' },
    }, W.dana)
    await expect((await bare()).register(record(), legacy)).rejects.toThrow(/INVALID_TERMS: the seller is not the mandate payee/)

    const wrongCurrency = signStatement({
      v: 'eng.att/1', type: 'party.mandate/1', engagementId: ENG,
      subject: { mandateId: 'mnd_usd' },
      claim: { payee: W.atlas.address, maximum: { currency: 'USD', value: '2.00' } },
      observedAt: OPEN, issuedAt: OPEN, nonce: 'me-mandate-usd',
      attester: { account: W.dana.address, kind: 'PRINCIPAL' },
    }, W.dana)
    await expect((await bare()).register(record(), wrongCurrency)).rejects.toThrow(/INVALID_TERMS: the mandate maximum currency must be RLUSD/)

    const objectMax = signStatement({
      v: 'eng.att/1', type: 'party.mandate/1', engagementId: ENG,
      subject: { mandateId: 'mnd_obj' },
      claim: { payee: W.atlas.address, maximum: { currency: 'RLUSD', value: '2.00' } },
      observedAt: OPEN, issuedAt: OPEN, nonce: 'me-mandate-obj',
      attester: { account: W.dana.address, kind: 'PRINCIPAL' },
    }, W.dana)
    await expect((await bare()).register(record(), objectMax)).resolves.toMatchObject({ ok: true })
  })

  it('refuses a mandate whose attester account is not the principal, even when the principal key signed it', async () => {
    const mismatched = signStatement({
      v: 'eng.att/1', type: 'party.mandate/1', engagementId: ENG,
      subject: { mandateId: 'mnd_attester' }, claim: { maximum: '2.00', payee: W.atlas.address },
      observedAt: OPEN, issuedAt: OPEN, nonce: 'me-mandate-attester',
      attester: { account: W.atlas.address, kind: 'PRINCIPAL' },
    }, W.dana)
    await expect((await bare()).register(record(), mismatched)).rejects.toThrow(/INVALID_TERMS: the mandate attester must be the principal/)
  })

  it('register stores nothing when the ledger cannot be read', async () => {
    const svc = new CosignerService({
      signer: localSigner(W.cosigner),
      source: { snapshot: async () => { throw new Error('socket down') } },
      templates: [template], policies: [baseline12, policy],
    })
    await expect(svc.register(record(), mandate())).rejects.toBeInstanceOf(LedgerUnavailableError)
    await expect(svc.decide({ engagementId: ENG, stage: 'release.confirm', tx: {} })).rejects.toThrow(/unknown engagement/)
  })

  it('accepts a mandate signed by the principal RegularKey when the master key is disabled', async () => {
    const ledger = snap({ closeTime: OPEN })
    ledger.accounts[W.dana.address] = { exists: true, masterDisabled: true, regularKey: rotated.address }
    const svc = new CosignerService({
      signer: localSigner(W.cosigner), source: new FixtureLedgerSource(ledger),
      templates: [template], policies: [baseline12, policy],
    })
    const byRegular = signStatement({
      v: 'eng.att/1', type: 'party.mandate/1', engagementId: ENG,
      subject: { mandateId: 'mnd_reg' }, claim: { maximum: '2.00', payee: W.atlas.address },
      observedAt: OPEN, issuedAt: OPEN, nonce: 'me-mandate-reg',
      attester: { account: W.dana.address, kind: 'PRINCIPAL' },
    }, rotated)
    await expect(svc.register(record(), byRegular)).resolves.toMatchObject({ ok: true })
  })

  it('refuses a mandate key that is neither the principal master key nor its current RegularKey', async () => {
    const ledger = snap({ closeTime: OPEN })
    ledger.accounts[W.dana.address] = { exists: true, masterDisabled: true, regularKey: rotated.address }
    const svc = new CosignerService({
      signer: localSigner(W.cosigner), source: new FixtureLedgerSource(ledger),
      templates: [template], policies: [baseline12, policy],
    })
    const body = {
      v: 'eng.att/1' as const, type: 'party.mandate/1', engagementId: ENG,
      subject: { mandateId: 'mnd_key' }, claim: { maximum: '2.00', payee: W.atlas.address },
      observedAt: OPEN, issuedAt: OPEN,
      attester: { account: W.dana.address, kind: 'PRINCIPAL' },
    }
    const strangerKey = signStatement({ ...body, nonce: 'me-mandate-stranger-key' }, stranger)
    await expect(svc.register(record(), strangerKey)).rejects.toThrow(/INVALID_TERMS: the mandate must be signed by the principal$/)
    const disabledMaster = signStatement({ ...body, nonce: 'me-mandate-disabled-master' }, W.dana)
    await expect(svc.register(record(), disabledMaster)).rejects.toThrow(/INVALID_TERMS: the mandate must be signed by the principal$/)
  })

  it('rejects an ENG/ATTESTER/SHIPPING credential that expires before inspectBy', async () => {
    const ledger = snap({ closeTime: OPEN })
    const cred = ledger.credentials.find((c) => c.type === 'ENG/ATTESTER/SHIPPING')!
    cred.expiration = '2026-11-10T23:59:59Z'
    const svc = new CosignerService({
      signer: localSigner(W.cosigner), source: new FixtureLedgerSource(ledger),
      templates: [template], policies: [baseline12, policy],
    })
    await expect(svc.register(record(), mandate())).rejects.toThrow(/INVALID_TERMS: ENG\/ATTESTER\/SHIPPING credential/)
  })
})

describe('shipment rules follow the shipping window, and the bond reads plusParam', () => {
  it('runs TOO_EARLY and ALREADY_SHIPPED without a dispute block, and skips them when the window is absent', async () => {
    const noDispute = structuredClone(template)
    delete noDispute.dispute
    const early = new CosignerService({
      signer: localSigner(W.cosigner), source: new FixtureLedgerSource(snap({ closeTime: '2026-10-31T23:00:00Z' })),
      templates: [noDispute], policies: [baseline12, policy],
    })
    await early.register(record(), mandate())
    await expect(early.ingest(ENG, signed(carrier, 'shipping.shipped/1', '2026-10-31T22:59:00Z', 'me-win-early'))).rejects.toThrow(/TOO_EARLY/)

    const shippedTpl = structuredClone(template)
    delete shippedTpl.dispute
    const shipped = new CosignerService({
      signer: localSigner(W.cosigner), source: new FixtureLedgerSource(snap({ closeTime: '2026-11-02T12:00:00Z' })),
      templates: [shippedTpl], policies: [baseline12, policy],
    })
    await shipped.register(record(), mandate())
    await shipped.ingest(ENG, signed(carrier, 'shipping.shipped/1', '2026-11-02T11:59:00Z', 'me-win-1'))
    await expect(shipped.ingest(ENG, signed(carrier, 'shipping.shipped/1', '2026-11-02T11:59:30Z', 'me-win-2'))).rejects.toThrow(/ALREADY_SHIPPED/)

    const unwinnowed = structuredClone(template)
    delete unwinnowed.attestationWindows!['shipping.shipped/1']
    const open = new CosignerService({
      signer: localSigner(W.cosigner), source: new FixtureLedgerSource(snap({ closeTime: '2026-10-31T23:00:00Z' })),
      templates: [unwinnowed], policies: [baseline12, policy],
    })
    await open.register(record(), mandate())
    await open.ingest(ENG, signed(carrier, 'shipping.shipped/1', '2026-10-31T22:59:00Z', 'me-nowin-1'))
    await open.ingest(ENG, signed(carrier, 'shipping.shipped/1', '2026-10-31T22:59:30Z', 'me-nowin-2'))
    expect(open.statements(ENG)).toHaveLength(2)
  })

  it('bonds amount plus dispute.bond.plusParam, and refuses when that param is missing', async () => {
    const renamed = structuredClone(template)
    renamed.dispute!.bond.plusParam = 'escrowBond'
    const layered = structuredClone(policy)
    layered.params = { ...layered.params, escrowBond: '1.00' }
    delete layered.params.minDisputeBond
    const source = new FixtureLedgerSource(snap({ closeTime: '2026-11-05T12:00:00Z', balance: '2.50', dispute: true }))
    const svc = new CosignerService({
      signer: localSigner(W.cosigner), source, templates: [renamed], policies: [baseline12, layered],
    })
    await svc.register(record(), mandate())
    const dispute = signed(W.dana, 'party.dispute/1', '2026-11-05T11:59:00Z', 'me-plus-1', { reason: 'not received' })
    await expect(svc.ingest(ENG, dispute)).rejects.toThrow(/NOT_BONDED/)

    source.snap = snap({ closeTime: '2026-11-05T12:00:00Z', balance: '3.00', dispute: true })
    await svc.ingest(ENG, dispute)

    const missing = structuredClone(policy)
    delete missing.params!.minDisputeBond
    const bare = new FixtureLedgerSource(snap({ closeTime: '2026-11-05T12:00:00Z', balance: '2.50', dispute: true }))
    const uncovered = new CosignerService({
      signer: localSigner(W.cosigner), source: bare, templates: [template], policies: [baseline12, missing],
    })
    await uncovered.register(record(), mandate())
    await expect(uncovered.ingest(ENG, signed(W.dana, 'party.dispute/1', '2026-11-05T11:59:00Z', 'me-plus-missing', { reason: 'not received' }))).rejects.toThrow(/NOT_BONDED: policy param minDisputeBond is missing/)
  })
})

describe('attester type allowlist', () => {
  it('allows a type when any naming entry allows it, at intake and at decide', async () => {
    const both = record()
    both.attesters = {
      shipping: { accounts: [carrier.address], kind: 'SHIPPING', types: ['shipping.shipped/1'] },
      qa: { accounts: [carrier.address], kind: 'QA', types: ['party.review/1'] },
    }
    const { svc } = await setup('2026-11-02T12:00:00Z')
    const rec = record()
    rec.engagementId = 'eng_marketplace_allow'
    rec.attesters = both.attesters
    const allow = new CosignerService({
      signer: localSigner(W.cosigner),
      source: new FixtureLedgerSource(snap({ closeTime: '2026-11-02T12:00:00Z' })),
      templates: [template], policies: [baseline12, policy],
    })
    await allow.register(rec, signStatement({
      v: 'eng.att/1', type: 'party.mandate/1', engagementId: rec.engagementId,
      subject: { mandateId: 'mnd_allow' }, claim: { maximum: '2.00', payee: W.atlas.address },
      observedAt: OPEN, issuedAt: OPEN, nonce: 'me-mandate-allow',
      attester: { account: W.dana.address, kind: 'PRINCIPAL' },
    }, W.dana))
    const review = signStatement({
      v: 'eng.att/1', type: 'party.review/1', engagementId: rec.engagementId,
      subject: { item: 'sku-1' }, claim: { rating: 5 },
      observedAt: '2026-11-02T11:59:00Z', issuedAt: '2026-11-02T11:59:00Z', nonce: 'me-review-ok',
      attester: { account: carrier.address, kind: 'QA' },
    }, carrier)
    await allow.ingest(rec.engagementId, review)
    await expect(allow.ingest(rec.engagementId, signStatement({
      v: 'eng.att/1', type: 'party.invoice/1', engagementId: rec.engagementId,
      subject: { item: 'sku-1' }, claim: { amount: '2.00' },
      observedAt: '2026-11-02T11:59:10Z', issuedAt: '2026-11-02T11:59:10Z', nonce: 'me-invoice-no',
      attester: { account: carrier.address, kind: 'QA' },
    }, carrier))).rejects.toThrow(/TYPE_NOT_ALLOWED/)

    const passed = signStatement({
      v: 'eng.att/1', type: 'party.review/1', engagementId: ENG,
      subject: { item: 'sku-1' }, claim: { rating: 1 },
      observedAt: '2026-11-02T11:59:00Z', issuedAt: '2026-11-02T11:59:00Z', nonce: 'me-review-decide',
      attester: { account: carrier.address, kind: 'SHIPPING' },
    }, carrier)
    const blocked = await svc.decide({ engagementId: ENG, stage: 'default.refund', tx: refundAll(), statements: [passed] })
    expect(blocked.statementsRejected.map((r) => r.code)).toContain('TYPE_NOT_ALLOWED')

    const opened = await allow.decide({ engagementId: rec.engagementId, stage: 'default.refund', tx: refundAll(), statements: [review] })
    expect(opened.statementsRejected.map((r) => r.code)).not.toContain('TYPE_NOT_ALLOWED')
  })
})

describe('stored statement wins over a re-signed copy', () => {
  it('a stranger re-signing the receipted shipment cannot ride the key skip', async () => {
    const observed = '2026-11-03T00:00:00Z'
    const body = {
      v: 'eng.att/1' as const, type: 'shipping.shipped/1', engagementId: ENG,
      subject: { item: 'sku-1' }, claim: { status: 'shipped' },
      observedAt: observed, issuedAt: observed, nonce: 'me-stored-wins',
      attester: { account: carrier.address, kind: 'SHIPPING' },
    }
    const original = signStatement(body, carrier)
    const forged = signStatement(body, stranger)
    expect(forged.id).toBe(original.id)
    const { svc, source } = await setup('2026-11-03T00:01:00Z')
    await svc.ingest(ENG, original)
    source.snap = snap({
      closeTime: '2026-11-11T00:00:01Z',
      carrier: { exists: true, masterDisabled: true, regularKey: rotated.address },
    })
    const d = await svc.decide({ engagementId: ENG, stage: 'default.release', tx: releaseExact(), statements: [forged] })
    expect(d.statementsRejected.map((r) => r.code)).not.toContain('KEY_NOT_AUTHORIZED')
    expect(d.decision).toBe('SIGN')
  })
})

describe('ruling overdue alert', () => {
  const issued = '2026-11-05T11:59:00Z'
  const due = '2026-11-10T11:59:00Z'

  async function opened(closeTime: string) {
    const source = new FixtureLedgerSource(snap({ closeTime: '2026-11-05T12:00:00Z', balance: '2.50', dispute: true }))
    const store = new MemoryStateStore()
    const svc = await CosignerService.open({
      signer: localSigner(W.cosigner), source, store,
      templates: [template], policies: [baseline12, policy],
    })
    await svc.register(record(), mandate())
    await svc.ingest(ENG, signed(W.dana, 'party.dispute/1', issued, 'me-overdue', { reason: 'not received' }))
    source.snap = snap({ closeTime, balance: '2.50', dispute: true })
    return { svc, source, store }
  }

  it('fires at the deadline, repeats after 24h, keeps firing after a ruling, and stops when the account is gone', async () => {
    const early = await opened(due)
    expect(await early.svc.overdue(ENG)).toBeNull()
    await early.svc.close()

    const { svc, source, store } = await opened('2026-11-10T11:59:01Z')
    const first = await svc.overdue(ENG)
    expect(first).toMatchObject({
      alert: 'RULING_OVERDUE', engagementId: ENG, rulingReceipted: false,
      caseOpenedAt: '2026-11-05T11:59:00.000Z', dueAt: '2026-11-10T11:59:00.000Z',
    })
    expect(await svc.overdue(ENG)).toBeNull()
    expect(await svc.tick(ENG)).toEqual([])
    await svc.close()

    const again = await CosignerService.open({
      signer: localSigner(W.cosigner), source, store,
      templates: [template], policies: [baseline12, policy],
    })
    expect(await again.overdue(ENG)).toBeNull()
    source.snap = snap({ closeTime: '2026-11-11T11:59:01Z', balance: '2.50', dispute: true })
    expect((await again.overdue(ENG))?.rulingReceipted).toBe(false)

    source.snap = snap({ closeTime: '2026-11-11T12:00:00Z', balance: '2.50', dispute: true })
    await again.ingest(ENG, signed(W.arbiter, 'party.ruling/1', '2026-11-11T11:59:30Z', 'me-overdue-ruling', { outcome: 'refund' }))
    source.snap = snap({ closeTime: '2026-11-12T12:00:00Z', balance: '2.50', dispute: true })
    expect((await again.overdue(ENG))?.rulingReceipted).toBe(true)

    source.snap.accounts[eng.address]!.exists = false
    expect(await again.overdue(ENG)).toBeNull()
    await again.close()
  })

  it('the scheduler pages onAlert and does not sign', async () => {
    const { svc } = await opened('2026-11-10T11:59:01Z')
    const alerts: RulingOverdue[] = []
    const signs: unknown[] = []
    vi.useFakeTimers()
    try {
      const stop = startTickScheduler(svc, {
        intervalMs: 1000,
        onAlert: (_id, alert) => { alerts.push(alert) },
        onResult: (_id, r) => { signs.push(r) },
      })
      await vi.advanceTimersByTimeAsync(1000)
      expect(alerts.map((a) => a.alert)).toEqual(['RULING_OVERDUE'])
      expect(signs).toEqual([])
      await vi.advanceTimersByTimeAsync(1000)
      expect(alerts).toHaveLength(1)
      await stop.stop()
    } finally {
      vi.useRealTimers()
    }
    await svc.close()
  })

  it('repeats after 24h when rulingOverdueRepeat is missing', async () => {
    const missing = structuredClone(policy)
    delete missing.params!.rulingOverdueRepeat
    const source = new FixtureLedgerSource(snap({ closeTime: '2026-11-05T12:00:00Z', balance: '2.50', dispute: true }))
    const svc = await CosignerService.open({
      signer: localSigner(W.cosigner), source, store: new MemoryStateStore(),
      templates: [template], policies: [baseline12, missing],
    })
    await svc.register(record(), mandate())
    await svc.ingest(ENG, signed(W.dana, 'party.dispute/1', issued, 'me-overdue-fallback', { reason: 'not received' }))
    source.snap = snap({ closeTime: '2026-11-10T11:59:01Z', balance: '2.50', dispute: true })
    expect((await svc.overdue(ENG))?.alert).toBe('RULING_OVERDUE')
    expect(await svc.overdue(ENG)).toBeNull()
    source.snap = snap({ closeTime: '2026-11-11T11:59:00Z', balance: '2.50', dispute: true })
    expect(await svc.overdue(ENG)).toBeNull()
    source.snap = snap({ closeTime: '2026-11-11T11:59:01Z', balance: '2.50', dispute: true })
    expect((await svc.overdue(ENG))?.alert).toBe('RULING_OVERDUE')
    await svc.close()
  })

  it('retries a failed alert delivery after one minute, not after 24h', async () => {
    const { svc, source } = await opened('2026-11-10T11:59:01Z')
    expect((await svc.overdue(ENG))?.alert).toBe('RULING_OVERDUE')
    await svc.noteAlertDelivery(ENG, false)
    source.snap = snap({ closeTime: '2026-11-10T11:59:31Z', balance: '2.50', dispute: true })
    expect(await svc.overdue(ENG)).toBeNull()
    source.snap = snap({ closeTime: '2026-11-10T12:00:01Z', balance: '2.50', dispute: true })
    expect((await svc.overdue(ENG))?.alert).toBe('RULING_OVERDUE')
    await svc.close()
  })

  it('logs ruling overdue and posts the webhook when one is set', async () => {
    const lines: Record<string, unknown>[] = []
    let posted = ''
    const fetchImpl: typeof fetch = async (_input, init) => {
      posted = String(init?.body ?? '')
      return new Response(null, { status: 204 })
    }
    const alert: RulingOverdue = { alert: 'RULING_OVERDUE', engagementId: ENG, caseOpenedAt: issued, dueAt: due, rulingReceipted: false }
    await reportRulingOverdue(alert, (e) => lines.push(e), 'https://alerts.example/hook', fetchImpl)
    expect(lines[0]).toMatchObject({ level: 'error', msg: 'ruling overdue', engagementId: ENG, rulingReceipted: false })
    expect(JSON.parse(posted).alert).toBe('RULING_OVERDUE')
  })

  it('a due live deal notices once, proposes a sweep, and drops a tec proposal', async () => {
    const early = await setup('2026-11-02T00:00:00Z')
    expect(await early.svc.timeouts(ENG)).toBeNull()
    expect((await early.svc.proposeTimeout(ENG, 'default.refund')).failing).toContain('NOT_DUE')
    await expect(early.svc.storePresigned(ENG, 'default.refund', '00')).rejects.toThrow(/NOT_PRESIGNED/)
    expect(await early.svc.tick(ENG)).toEqual([])

    const { svc, source } = await setup('2026-11-04T00:00:01Z')
    source.snap.accounts[eng.address].sequence = 40
    const notice = await svc.timeouts(ENG)
    expect(notice?.outcome).toBe('default.refund')
    expect(svc.decisions(ENG).filter((s) => s.type === 'cosigner.timeout/1')).toHaveLength(1)
    expect(await svc.timeouts(ENG)).toBeNull()

    const proposed = await svc.proposeTimeout(ENG, 'default.refund')
    expect(proposed.decision).toBe('SIGN')
    expect(proposed.proposal?.txJson.TicketSequence).toBeUndefined()
    expect(proposed.proposal?.lastLedgerSequence).toBe(LEDGER_INDEX + 30)
    const tx = proposed.proposal!.txJson
    const hash = proposed.proposal!.proposedTxHash
    await expect(svc.submitTimeoutSignature(ENG, hash, multisignBlob(W.arbiter, tx))).rejects.toThrow(/ORDER/)
    expect((await svc.submitTimeoutSignature(ENG, hash, multisignBlob(W.dana, tx))).ready).toBe(false)
    expect((await svc.verifyTimeout(ENG, { outcome: 'default.refund', tx, builtAtLedger: proposed.proposal!.builtAtLedger, partyAccount: W.dana.address, statements: [] })).ok).toBe(true)
    await expect(svc.submitTimeoutSignature(ENG, hash, multisignBlob(W.arbiter, tx), async () => ({ hash: 'AB', final: 'tecPATH_DRY', validated: true }))).rejects.toThrow(/DEAD tecPATH_DRY/)
    await expect(svc.submitTimeoutSignature(ENG, hash, multisignBlob(W.dana, tx))).rejects.toThrow(/UNKNOWN_PROPOSAL/)
  })

  it('a receipted dispute blocks release only when the arbiter ledger also holds the bond', async () => {
    const { svc, source } = await setup('2026-11-03T00:01:00Z')
    await svc.ingest(ENG, signed(carrier, 'shipping.shipped/1', '2026-11-03T00:00:00Z', 'me-timeout-ship'))
    source.snap = snap({ closeTime: '2026-11-11T00:00:01Z', balance: '2.00' })
    source.snap.accounts[eng.address].sequence = 40
    const exact = await svc.proposeTimeout(ENG, 'default.release')
    expect(exact.decision).toBe('SIGN')
    const presented = {
      statement: signed(W.dana, 'party.dispute/1', '2026-11-05T00:00:00Z', 'me-timeout-dispute', { reason: 'no' }),
      receipt: signStatement({
        v: 'eng.att/1', type: 'cosigner.receipt/1', engagementId: ENG,
        subject: { statementId: 'att:receipt' }, claim: { receivedAt: '2026-11-05T00:00:00Z', ledgerIndex: LEDGER_INDEX },
        observedAt: '2026-11-05T00:00:00Z', issuedAt: '2026-11-05T00:00:00Z', nonce: 'me-timeout-receipt',
        attester: { account: W.cosigner.address, kind: 'COSIGNER' },
      }, W.cosigner),
    }
    const open = await svc.verifyTimeout(ENG, {
      outcome: 'default.release', tx: exact.proposal!.txJson, builtAtLedger: exact.proposal!.builtAtLedger,
      statements: svc.statements(ENG), presentedDispute: presented, partyAccount: W.atlas.address,
    })
    expect(open).toEqual({ ok: true })
    source.snap = snap({ closeTime: '2026-11-11T00:00:01Z', balance: '2.50' })
    source.snap.accounts[eng.address].sequence = 40
    const swept = await svc.proposeTimeout(ENG, 'default.release')
    expect(swept.decision).toBe('SIGN')
    const blocked = await svc.verifyTimeout(ENG, {
      outcome: 'default.release', tx: swept.proposal!.txJson, builtAtLedger: swept.proposal!.builtAtLedger,
      statements: svc.statements(ENG), presentedDispute: presented, partyAccount: W.atlas.address,
    })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.check).toBe(4)
  })

  it('does not propose a release while a receipted dispute is bonded', async () => {
    const { svc, source } = await setup('2026-11-03T00:01:00Z')
    await svc.ingest(ENG, signed(carrier, 'shipping.shipped/1', '2026-11-03T00:00:00Z', 'me-bonded-ship'))
    source.snap = snap({ closeTime: '2026-11-05T00:00:01Z', balance: '2.50', dispute: true })
    await svc.ingest(ENG, signed(W.dana, 'party.dispute/1', '2026-11-05T00:00:00Z', 'me-bonded-dispute', { reason: 'no' }))
    source.snap = snap({ closeTime: '2026-11-11T00:00:01Z', balance: '2.50' })
    source.snap.accounts[eng.address].sequence = 40
    const proposed = await svc.proposeTimeout(ENG, 'default.release')
    expect(proposed).toMatchObject({ decision: 'REFUSE', failing: ['NOT_DUE'] })
    expect(proposed.proposal).toBeUndefined()
  })

  it('restores a timeout notice and does not log the same fingerprint twice', async () => {
    const store = new MemoryStateStore()
    const source = new FixtureLedgerSource(snap({ closeTime: '2026-11-04T00:00:01Z' }))
    source.snap.accounts[eng.address].sequence = 40
    const opts = { signer: localSigner(W.cosigner), source, templates: [template], policies: [baseline12, policy], store }
    const svc = new CosignerService(opts)
    await svc.register(record(), mandate())
    const notice = await svc.timeouts(ENG)
    const restored = await CosignerService.open(opts)
    expect(restored.latestTimeout(ENG)?.fingerprint).toBe(notice?.fingerprint)
    expect(restored.decisions(ENG).filter((s) => s.type === 'cosigner.timeout/1')).toHaveLength(1)
    expect(await restored.timeouts(ENG)).toBeNull()
    const proposed = await restored.proposeTimeout(ENG, 'default.refund')
    expect(proposed.decision).toBe('SIGN')
    source.snap.index = LEDGER_INDEX + 31
    const expired = await CosignerService.open(opts)
    await expect(expired.submitTimeoutSignature(ENG, proposed.proposal!.proposedTxHash, '00')).rejects.toThrow(/UNKNOWN_PROPOSAL/)
    await expired.close()
    await restored.close()
  })

  it('the scheduler delivers onTimeout and closes a missing live account after two rounds', async () => {
    const { svc, source } = await setup('2026-11-04T00:00:01Z')
    vi.useFakeTimers()
    const seen: string[] = []
    const s = startTickScheduler(svc, { intervalMs: 1000, onTimeout: (_id, n) => { seen.push(n.outcome) } })
    await vi.advanceTimersByTimeAsync(1000)
    expect(seen).toEqual(['default.refund'])
    source.snap.accounts[eng.address].exists = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(svc.openEngagementIds()).toEqual([ENG])
    await vi.advanceTimersByTimeAsync(1000)
    expect(svc.openEngagementIds()).toEqual([])
    await s.stop()
  })

  it('logs the overdue line before retrying a failed webhook on a bounded backoff', async () => {
    const order: string[] = []
    const sleeps: number[] = []
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      order.push('fetch')
      calls += 1
      if (calls < 3) return new Response(null, { status: 502 })
      return new Response(null, { status: 204 })
    }
    const alert: RulingOverdue = { alert: 'RULING_OVERDUE', engagementId: ENG, caseOpenedAt: issued, dueAt: due, rulingReceipted: false }
    await reportRulingOverdue(alert, (e) => order.push(String(e.msg)), 'https://alerts.example/hook', fetchImpl, async (ms) => { sleeps.push(ms) })
    expect(order[0]).toBe('ruling overdue')
    expect(calls).toBe(3)
    expect(sleeps).toEqual([200, 400])
    expect(order.indexOf('fetch')).toBeGreaterThan(order.indexOf('ruling overdue'))
  })
})

afterEach(() => { vi.useRealTimers() })
