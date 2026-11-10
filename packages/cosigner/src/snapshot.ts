// Ledger snapshot sources (policy spec P2): every fact a decision uses is read at ONE validated
// ledger index, so the decision can be replayed later by anyone with a full-history server.
import xrpl from 'xrpl'
import { formatAmount, Amount, type AssetDef } from '@eng/core'
import type { HistoryEntry, LedgerAccountState, LedgerCredential, LedgerSnapshot } from '@eng/policy'
import { LSF_ACCEPTED, LSF_DISABLE_MASTER, unhex } from './xrpl-io.ts'

type Json = Record<string, unknown>
type Client = InstanceType<typeof xrpl.Client>

export interface SnapshotRequest {
  /** The engagement account (balances, objects, history). */
  account: string
  /** Asset definitions (for IOU balance lookup and history decoding). */
  assets: Record<string, AssetDef>
  /** Accounts whose key state is needed (statement attesters). */
  accounts: string[]
  /** Accounts whose Credentials (as subject) are needed: payees, attesters, the engagement account. */
  credentialSubjects: string[]
  /** How far back to read validated payments for stateful counters. */
  historySecs: number
}

export interface LedgerSource {
  snapshot(req: SnapshotRequest): Promise<LedgerSnapshot>
}

/** Test/vector source: returns a fixed snapshot (callers may mutate it between calls). */
export class FixtureLedgerSource implements LedgerSource {
  constructor(public snap: LedgerSnapshot) {}
  async snapshot(): Promise<LedgerSnapshot> {
    return structuredClone(this.snap)
  }
}

// FeeSettings singleton ledger entry
const FEE_SETTINGS = '4BC50C9B0D8515D3EAAE1E74B29A95804346C491EE1A95BF25E4AAB854A6A651'

/** Reads a snapshot from a rippled / Clio server, pinned to the latest validated ledger. */
export class XrplLedgerSource implements LedgerSource {
  constructor(private readonly client: Client, private readonly opts: { historyPageLimit?: number; maxHistoryPages?: number } = {}) {}

  private async req<T = Json>(r: Json): Promise<T> {
    return ((await this.client.request(r as never)) as unknown as { result: T }).result
  }
  private async tryReq<T = Json>(r: Json): Promise<T | null> {
    try {
      return await this.req<T>(r)
    } catch (e) {
      const code = String((e as { data?: { error?: string } })?.data?.error ?? (e as Error)?.message)
      if (/actNotFound|entryNotFound|objectNotFound/.test(code)) return null
      throw e
    }
  }
  private async objects(account: string, ledger: number, type?: string): Promise<Json[] | null> {
    const out: Json[] = []
    let marker: unknown
    do {
      const r = await this.tryReq<{ account_objects: Json[]; marker?: unknown }>({ command: 'account_objects', account, ledger_index: ledger, limit: 400, ...(type ? { type } : {}), ...(marker ? { marker } : {}) })
      if (!r) return null
      out.push(...r.account_objects)
      marker = r.marker
    } while (marker)
    return out
  }

  async snapshot(q: SnapshotRequest): Promise<LedgerSnapshot> {
    const led = await this.req<{ ledger_index: number; ledger_hash: string; ledger: { close_time_iso?: string; close_time?: number } }>({ command: 'ledger', ledger_index: 'validated' })
    const index = led.ledger_index
    const closeTime = led.ledger.close_time_iso ?? new Date((Number(led.ledger.close_time) + 946684800) * 1000).toISOString()

    const fee = (await this.tryReq<{ node: Json }>({ command: 'ledger_entry', index: FEE_SETTINGS, ledger_index: index }))?.node ?? {}
    const baseFeeDrops = String(fee.BaseFeeDrops ?? (fee.BaseFee ? BigInt('0x' + String(fee.BaseFee)) : 10))
    const reserveIncDrops = String(fee.ReserveIncrementDrops ?? fee.ReserveIncrement ?? 200000)

    const accounts: Record<string, LedgerAccountState> = {}
    for (const a of new Set([q.account, ...q.accounts])) {
      const info = await this.tryReq<{ account_data: Json }>({ command: 'account_info', account: a, ledger_index: index })
      if (!info) { accounts[a] = { exists: false }; continue }
      const d = info.account_data
      accounts[a] = { exists: true, sequence: Number(d.Sequence), masterDisabled: (Number(d.Flags) & LSF_DISABLE_MASTER) !== 0, regularKey: (d.RegularKey as string) ?? null }
    }
    // Engagement-account objects (for drain / delete checks)
    const objs = accounts[q.account].exists ? await this.objects(q.account, index) : []
    if (objs) {
      const o = { trustlines: 0, signerList: false, tickets: [] as number[], other: 0 }
      for (const x of objs) {
        switch (x.LedgerEntryType) {
          case 'RippleState': o.trustlines++; break
          case 'SignerList': o.signerList = true; break
          case 'Ticket': o.tickets.push(Number(x.TicketSequence)); break
          case 'Credential': break // removed by AccountDelete (spike F3)
          default: o.other++
        }
      }
      o.tickets.sort((a, b) => a - b)
      accounts[q.account].ownerObjects = o
    }

    // Balances of the engagement account
    const balances: Record<string, Record<string, string>> = { [q.account]: {} }
    if (accounts[q.account].exists) {
      const lines: Json[] = []
      let marker: unknown
      do {
        const r = await this.req<{ lines: Json[]; marker?: unknown }>({ command: 'account_lines', account: q.account, ledger_index: index, limit: 400, ...(marker ? { marker } : {}) })
        lines.push(...r.lines)
        marker = r.marker
      } while (marker)
      for (const def of Object.values(q.assets)) {
        if (def.kind === 'XRP') {
          const info = await this.req<{ account_data: Json }>({ command: 'account_info', account: q.account, ledger_index: index })
          balances[q.account][def.code] = formatAmount(new Amount(def.code, BigInt(String(info.account_data.Balance))), 6)
        } else {
          const l = lines.find((x) => String(x.currency).toUpperCase() === def.currency.toUpperCase() && x.account === def.issuer)
          if (l) balances[q.account][def.code] = String(l.balance)
        }
      }
    }

    // Credentials held by the subjects we care about
    const credentials: LedgerCredential[] = []
    for (const s of new Set([q.account, ...q.credentialSubjects])) {
      const cs = await this.objects(s, index, 'credential')
      for (const c of cs ?? []) {
        if (c.Subject !== s) continue
        credentials.push({
          issuer: String(c.Issuer), subject: s, type: unhex(c.CredentialType),
          accepted: (Number(c.Flags) & LSF_ACCEPTED) !== 0,
          expiration: c.Expiration != null ? new Date((Number(c.Expiration) + 946684800) * 1000).toISOString() : null,
        })
      }
    }

    // Validated outgoing payments of the engagement account within the window (E12)
    const history: HistoryEntry[] = []
    if (accounts[q.account].exists) {
      const from = Date.parse(closeTime) - q.historySecs * 1000
      let marker: unknown
      let pages = 0
      outer: do {
        const r = await this.req<{ transactions: Array<Json>; marker?: unknown }>({ command: 'account_tx', account: q.account, ledger_index_min: -1, ledger_index_max: index, forward: false, limit: this.opts.historyPageLimit ?? 200, ...(marker ? { marker } : {}) })
        for (const t of r.transactions) {
          const tx = (t.tx_json ?? t.tx) as Json
          const meta = t.meta as Json
          const ct = (t.close_time_iso as string) ?? (tx.date != null ? new Date((Number(tx.date) + 946684800) * 1000).toISOString() : closeTime)
          if (Date.parse(ct) <= from) break outer
          if (tx.TransactionType !== 'Payment' || tx.Account !== q.account || meta?.TransactionResult !== 'tesSUCCESS') continue
          const d = (meta.delivered_amount ?? tx.DeliverMax ?? tx.Amount) as unknown
          const decoded = decode(d, q.assets)
          if (!decoded) continue
          history.push({
            hash: String(t.hash ?? tx.hash), ledgerIndex: Number(t.ledger_index ?? tx.ledger_index), closeTime: ct,
            ...(Number(tx.TicketSequence ?? 0) > 0 ? { ticket: Number(tx.TicketSequence) } : { sequence: Number(tx.Sequence) }),
            payouts: [{ to: String(tx.Destination), asset: decoded.code, value: decoded.value }],
          })
        }
        marker = r.marker
      } while (marker && ++pages < (this.opts.maxHistoryPages ?? 20))
    }

    return { index, hash: led.ledger_hash, closeTime, baseFeeDrops, reserveIncDrops, accounts, balances, credentials, history: { [q.account]: history } }
  }
}

function decode(a: unknown, assets: Record<string, AssetDef>): { code: string; value: string } | null {
  if (typeof a === 'string') {
    const xrp = Object.values(assets).find((d) => d.kind === 'XRP')
    return xrp ? { code: xrp.code, value: formatAmount(new Amount(xrp.code, BigInt(a)), 6) } : null
  }
  const o = a as { currency?: string; issuer?: string; value?: string } | null
  if (!o?.currency) return null
  const def = Object.values(assets).find((d) => d.kind === 'IOU' && d.currency.toUpperCase() === o.currency!.toUpperCase() && d.issuer === o.issuer)
  return def ? { code: def.code, value: String(o.value) } : null
}
