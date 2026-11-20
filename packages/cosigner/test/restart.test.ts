// Kill/restart tests (durable co-signer design §3): a restart never loses a receipt, a stored default or a spending
// cap. "Kill" = close the service and its store, then CosignerService.open() a fresh pair on the same SQLite file with
// the same signer, policies and templates and a ledger source that carries over the mock ledger state.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import { localSigner, type Statement } from '@eng/core'
import { CosignerService, SqliteStateStore, combine, type CosignerOptions, type SnapshotRequest, type TickResult } from '@eng/cosigner'
import { type LedgerSnapshot } from '@eng/policy'
import {
  W, b1Engagement, b1Invoice, b1Ledger, b1Mandate, b1Payment, checkin, claim, dispute, guestCheckin, historyEntry, hotel2Close, hotel2Confirmation, hotel2Engagement, hotel2Ledger, hotel2Mandate, memo, policies, ruling, templates,
} from '../../policy/test/fixtures.ts'

type Json = Record<string, unknown>
const H2 = 'eng_hotel2_fixture'
const B1 = 'eng_b1_fixture'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosigner-restart-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
let n = 0
const newFile = (): string => path.join(dir, `r${n++}.db`)

/** Routes snapshot requests to the b1 or hotel@2 mock ledger by account; the ledger state outlives a restart. */
class Ledger {
  constructor(public b1: LedgerSnapshot = b1Ledger(), public h2: LedgerSnapshot = hotel2Ledger({ closeTime: '2026-11-01T09:31:00Z' })) {}
  async snapshot(q: SnapshotRequest): Promise<LedgerSnapshot> { return structuredClone(q.account === W.engB1.address ? this.b1 : this.h2) }
}

const opts = (ledger: Ledger, store: SqliteStateStore): CosignerOptions => ({
  signer: localSigner(W.cosigner), source: ledger, store,
  templates: [templates.procurement, templates.hotel2], policies: [policies.baseline, policies.procurement, policies.hotel2],
})

/** One running co-signer on a SQLite file; `restart()` is the kill: close service and store, reopen on the same file. */
class Node {
  private constructor(readonly file: string, readonly ledger: Ledger, public svc: CosignerService, private store: SqliteStateStore) {}
  static async boot(ledger: Ledger, file = newFile()): Promise<Node> {
    const store = await SqliteStateStore.open({ file })
    return new Node(file, ledger, await CosignerService.open(opts(ledger, store)), store)
  }
  async restart(): Promise<void> {
    await this.svc.close() // closes the store it was given
    this.store = await SqliteStateStore.open({ file: this.file })
    this.svc = await CosignerService.open(opts(this.ledger, this.store))
  }
  async stop(): Promise<void> { await this.svc.close() }
}

const presign = (tx: Json, wallets = [W.dana, W.atlas]) => combine(wallets.map((w) => w.sign(structuredClone(tx) as never, true).tx_blob))
const sweep = { to: W.dana.address, value: '0', partial: true }
const claimCb = () => presign(hotel2Close([{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }, sweep], { tickets: true, memos: [memo('eng/basis', 'default.chargebackClaim')] }))
const releaseBlob = () => presign(hotel2Close([{ to: W.atlas.address, value: '409.94' }, { to: W.service.address, value: '2.06' }, { to: W.dana.address, value: '150' }], { tickets: true, memos: [memo('eng/basis', 'default.release')] }))
const arbiterRuling = (t: string) => ruling(W.arbiter, [{ to: W.atlas.address, value: '470.00' }], t)

/** The payouts a SIGN delivers: every Payment destination and amount in the signed blob, plus its outcome. */
const payouts = (r: TickResult) => {
  const tx = xrpl.decode(r.blob!) as unknown as { Destination?: string; Amount?: unknown; Signers?: unknown }
  return { outcome: r.outcome, stage: r.stage, decision: r.decision, failing: r.failing, tx: { ...tx, Signers: undefined } }
}
const summary = (rs: TickResult[]) => rs.map((r) => ({ outcome: r.outcome, decision: r.decision, failing: r.failing }))

/** hotel@2, confirmed, checked in with the deposit and bond in, a claim and a bonded settlement dispute receipted, the chargeback blob stored. */
async function disputed(): Promise<Node & { filed: Statement }> {
  const node = await Node.boot(new Ledger())
  const { svc, ledger } = node
  await svc.register(hotel2Engagement(), hotel2Mandate())
  await svc.ingest(H2, hotel2Confirmation())
  ledger.h2.closeTime = '2026-11-11T15:01:00Z'
  await svc.ingest(H2, checkin('checked_in'))
  await svc.ingest(H2, guestCheckin())
  ledger.h2 = hotel2Ledger({ balance: '572', dispute: true, closeTime: '2026-11-14T15:01:00Z' })
  await svc.ingest(H2, claim([{ kind: 'minibar', amount: '58.00' }]))
  ledger.h2.closeTime = '2026-11-16T10:00:30Z'
  const filed = dispute('settlement', '2026-11-16T10:00:00Z')
  await svc.ingest(H2, filed) // ruling deadline 11-21T10:00:00
  await svc.storePresigned(H2, 'default.chargebackClaim', claimCb())
  return Object.assign(node, { filed })
}

describe('restart: mid-dispute', () => {
  it('before the deadline tick refuses with the same rule ids; after it the chargeback SIGNs with the same payouts', async () => {
    const node = await disputed()
    const control = await disputed()
    try {
      const before = summary(await node.svc.tick(H2))
      expect(before).toEqual(summary(await control.svc.tick(H2)))
      expect(before[0].decision).toBe('REFUSE')
      expect(before[0].failing.length).toBeGreaterThan(0)
      const receipts = node.svc.attestations(H2)
      const log = node.svc.decisions()
      await node.restart()
      expect(node.svc.attestations(H2)).toEqual(receipts)
      expect(node.svc.decisions()).toEqual(log)
      expect(summary(await node.svc.tick(H2))).toEqual(before)
      for (const x of [node, control]) x.ledger.h2.closeTime = '2026-11-21T10:00:01Z'
      const [after] = await node.svc.tick(H2)
      const [expected] = await control.svc.tick(H2)
      expect(after).toMatchObject({ outcome: 'default.chargebackClaim', decision: 'SIGN', failing: [] })
      expect(payouts(after)).toEqual(payouts(expected))
    } finally { await node.stop(); await control.stop() }
  })
})

describe('restart: mid ruling window', () => {
  it('a receipted ruling keeps every default refused; a post-deadline ruling is still LATE', async () => {
    const node = await disputed()
    try {
      node.ledger.h2.closeTime = '2026-11-18T10:00:00Z'
      const rl = arbiterRuling('2026-11-18T09:59:00Z')
      const receipt = await node.svc.ingest(H2, rl)
      node.ledger.h2.closeTime = '2026-12-30T00:00:00Z'
      const before = summary(await node.svc.tick(H2))
      expect(before[0].decision).toBe('REFUSE')
      expect(before[0].failing).toContain('G2')
      const receipts = node.svc.attestations(H2)
      await node.restart()
      expect(node.svc.attestations(H2)).toEqual(receipts)
      expect(await node.svc.ingest(H2, rl)).toEqual(receipt)
      expect(summary(await node.svc.tick(H2))).toEqual(before)
    } finally { await node.stop() }
  })

  it('a ruling after the deadline is LATE after a restart, and the claim chargeback then SIGNs', async () => {
    const node = await disputed()
    const control = await disputed()
    try {
      await node.restart()
      for (const x of [node, control]) x.ledger.h2.closeTime = '2026-11-21T10:00:01Z'
      await expect(node.svc.ingest(H2, arbiterRuling('2026-11-21T09:59:59Z'))).rejects.toThrow(/LATE: party\.ruling\/1 after the ruling deadline/)
      expect(node.svc.statements(H2).some((s) => s.type === 'party.ruling/1')).toBe(false)
      const [r] = await node.svc.tick(H2)
      expect(r).toMatchObject({ outcome: 'default.chargebackClaim', decision: 'SIGN', failing: [] })
      expect(payouts(r)).toEqual(payouts((await control.svc.tick(H2))[0]))
    } finally { await node.stop(); await control.stop() }
  })
})

describe('restart: in-flight spends (Review Focus 2)', () => {
  const pay = (value: string, seq: number, invoice: string) => ({ ...b1Payment(W.vendorA.address, value, { invoice }), Sequence: seq })
  const spend = (node: Node, value: string, seq: number, invoice: string) =>
    node.svc.decide({ engagementId: B1, stage: 'spend', tx: pay(value, seq, invoice), statements: [b1Invoice(W.vendorA, `${value}.00`, invoice)] })

  it('a SIGNed, not yet validated payment still counts against the daily cap after a restart; it resolves once validated', async () => {
    const ledger = new Ledger(b1Ledger({ history: [historyEntry('9000', '2026-11-18T02:00:00Z')] }))
    const node = await Node.boot(ledger)
    try {
      await node.svc.register(b1Engagement(), b1Mandate())
      const invA = b1Invoice(W.vendorA, '600.00', 'inv:A')
      const first = await node.svc.decide({ engagementId: B1, stage: 'spend', tx: pay('600', 21, 'inv:A'), statements: [invA] })
      expect(first.decision).toBe('SIGN')
      const inflight = node.svc.inflightFor(B1)
      expect(inflight).toHaveLength(1)
      await node.restart()
      expect(node.svc.inflightFor(B1)).toEqual(inflight)
      const second = await spend(node, '600', 22, 'inv:B')
      expect(second.decision).toBe('REFUSE')
      expect(second.failing).toEqual(['W3'])
      // Without the first payment the same second payment fits the cap: a fresh engagement with no in-flight entry signs it.
      const fresh = await Node.boot(new Ledger(b1Ledger({ history: [historyEntry('9000', '2026-11-18T02:00:00Z')] })))
      try {
        await fresh.svc.register(b1Engagement(), b1Mandate())
        expect((await spend(fresh, '600', 22, 'inv:B')).decision).toBe('SIGN')
      } finally { await fresh.stop() }
      // The first payment validates; the next decision resolves its in-flight entry (also after another restart).
      ledger.b1.accounts[W.engB1.address].sequence = 22
      ledger.b1.history[W.engB1.address].push({ ...historyEntry('600', '2026-11-18T09:33:05Z'), sequence: 21 })
      await node.restart()
      const c = await spend(node, '100', 22, 'inv:C')
      expect(c.decision).toBe('SIGN')
      expect(node.svc.inflightFor(B1).map((e) => e.outer.sequence)).not.toContain(21)
      expect(node.svc.engagement(B1)!.consumed).toEqual(expect.arrayContaining([invA.id]))
      // The consumed invoice and the validated 600 survive another restart.
      await node.restart()
      expect(node.svc.engagement(B1)!.consumed).toEqual(expect.arrayContaining([invA.id]))
      const replay = await node.svc.decide({ engagementId: B1, stage: 'spend', tx: pay('600', 23, 'inv:A'), statements: [invA] })
      expect(replay.decision).toBe('REFUSE')
      expect(replay.failing).toEqual(['W3', 'W6']) // W6: the invoice is already consumed (W3 too: the replay would exceed the cap)
      // 9000 + 600 validated + 100 in flight leaves 300 of the 10000 cap: 400 is refused (it would fit if the 600 were lost), 300 fits.
      const over = await spend(node, '400', 23, 'inv:D')
      expect(over.failing).toEqual(['W3'])
      expect((await spend(node, '300', 23, 'inv:E')).decision).toBe('SIGN')
    } finally { await node.stop() }
  })
})

describe('restart: receipts and idempotency', () => {
  it('re-ingesting a receipted statement returns the same receipt; ALREADY_DISPUTED still holds; stored defaults survive', async () => {
    const node = await disputed()
    try {
      const first = node.filed
      const receipts = node.svc.attestations(H2)
      const original = receipts.find((a) => a.statement.id === first.id)!
      expect(original).toBeDefined()
      await node.restart()
      node.ledger.h2.closeTime = '2026-11-16T10:30:00Z' // later than the original receipt: the first receipt must come back
      expect(await node.svc.ingest(H2, first)).toEqual(original.receipt)
      await expect(node.svc.ingest(H2, dispute('settlement', '2026-11-16T10:29:50Z'))).rejects.toThrow(/ALREADY_DISPUTED/)
      expect(node.svc.attestations(H2)).toEqual(receipts)
      expect(node.svc.statements(H2).filter((s) => s.type === 'party.dispute/1')).toEqual([first])
      expect((await node.svc.tick(H2)).map((r) => r.outcome)).toEqual(['default.chargebackClaim'])
    } finally { await node.stop() }
  })
})

describe('restart: quiet-tick refusal fingerprint', () => {
  it('a quiet tick repeating the last logged refusal is not logged again after a restart', async () => {
    const node = await Node.boot(new Ledger())
    try {
      const { svc, ledger } = node
      await svc.register(hotel2Engagement(), hotel2Mandate())
      await svc.ingest(H2, hotel2Confirmation())
      ledger.h2.closeTime = '2026-11-11T15:01:00Z'
      await svc.ingest(H2, checkin('checked_in'))
      await svc.ingest(H2, guestCheckin())
      ledger.h2 = hotel2Ledger({ balance: '562', closeTime: '2026-11-17T11:00:00Z' })
      await svc.storePresigned(H2, 'default.release', releaseBlob())
      const [a] = await svc.tick(H2, { quiet: true })
      expect(a).toMatchObject({ decision: 'REFUSE', failing: ['L1'] })
      const n = svc.decisions(H2).length
      await node.restart()
      const [b] = await node.svc.tick(H2, { quiet: true })
      expect(b).toMatchObject({ decision: 'REFUSE', failing: ['L1'] })
      expect(node.svc.decisions(H2)).toHaveLength(n)
    } finally { await node.stop() }
  })
})

describe('restart: decision log', () => {
  it('the log has the same order and content after every restart, and appends continue after it', async () => {
    const node = await disputed()
    try {
      await node.svc.decide({ engagementId: H2, stage: 'checkin' })
      await node.svc.tick(H2)
      node.ledger.h2.closeTime = '2026-11-17T10:00:00Z'
      await node.svc.tick(H2)
      const log = node.svc.decisions()
      expect(log.length).toBeGreaterThan(2)
      await node.restart()
      expect(node.svc.decisions()).toEqual(log)
      expect(node.svc.decisions(H2)).toEqual(log.filter((s) => s.engagementId === H2))
      await node.restart()
      expect(node.svc.decisions()).toEqual(log)
      await node.svc.tick(H2)
      expect(node.svc.decisions().slice(0, log.length)).toEqual(log)
      expect(node.svc.decisions()).toHaveLength(log.length + 1)
    } finally { await node.stop() }
  })
})

describe('restart: crash (SIGKILL, no close)', () => {
  // A real crash: a child process signs a payment and is killed with SIGKILL, so nothing is closed, flushed by us or
  // released. The lease must hold off a new owner until it expires, then the new owner sees every committed write.
  it('a killed co-signer keeps its lease until it expires; the next owner then recovers the in-flight spend', async () => {
    const file = newFile()
    const leaseMs = 800
    // node --import tsx (not the tsx CLI, which forks a second node that SIGKILL would not reach)
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, 'crash-child.ts'), file, String(leaseMs)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => { err += d })
    const line = await new Promise<string>((resolve, reject) => {
      let out = ''
      child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve(out.split('\n')[0]!) })
      child.on('exit', (code) => reject(new Error(`child exited ${code} before signing: ${err}`)))
    })
    const signed = JSON.parse(line) as { decision: string; inflight: unknown[] }
    expect(signed.decision).toBe('SIGN')
    expect(signed.inflight).toHaveLength(1)
    const killedAt = Date.now()
    await new Promise<void>((resolve) => { child.on('exit', () => resolve()); child.kill('SIGKILL') })

    // Within the lease window the dead owner still holds the file.
    await expect(SqliteStateStore.open({ file, leaseMs })).rejects.toThrow(/^STORE_LOCKED/)
    // After it expires the next owner claims it (retry, as a supervisor would).
    let store: SqliteStateStore | undefined
    while (!store) {
      try { store = await SqliteStateStore.open({ file, leaseMs }) } catch (e) {
        if (!/^STORE_LOCKED/.test(String((e as Error).message)) || Date.now() - killedAt > leaseMs * 5) throw e
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    expect(Date.now() - killedAt).toBeGreaterThanOrEqual(leaseMs - 200)
    const ledger = new Ledger(b1Ledger({ history: [historyEntry('9000', '2026-11-18T02:00:00Z')] }))
    const svc = await CosignerService.open(opts(ledger, store))
    try {
      // The in-flight spend committed before the kill survives it and still counts against the cap.
      expect(svc.inflightFor(B1)).toEqual(signed.inflight)
      const second = await svc.decide({ engagementId: B1, stage: 'spend', tx: { ...b1Payment(W.vendorA.address, '600', { invoice: 'inv:B' }), Sequence: 22 }, statements: [b1Invoice(W.vendorA, '600.00', 'inv:B')] })
      expect(second.decision).toBe('REFUSE')
      expect(second.failing).toEqual(['W3'])
    } finally { await svc.close() }
  }, 30_000)
})
