// Local implementations of the pool's injected interfaces (for the demo / CLI on a developer's
// machine). The live ledger activity (XrplPoolLedger, backed by an xrpl Client) lives with the CLI,
// since it needs a network connection; these are the offline-safe pieces: seed storage, durable
// state, and key operations.
import fs from 'node:fs'
import path from 'node:path'
import xrpl from 'xrpl'
import type { SeedStore, PoolStateStore, PoolAccount, Keys } from './pool.ts'

/**
 * Seeds on local disk, as a gitignored JSON file (mode 0600).
 *
 * PRODUCTION HARDENING TODO: replace with a KmsSeedStore backed by the cloud KMS / secrets manager
 * (envelope-encrypted, access-controlled, audited). The SeedStore interface is the single swap
 * point — no PoolManager logic changes. Never commit the seed file.
 */
export class LocalFileSeedStore implements SeedStore {
  constructor(private readonly file: string) {}
  private read(): Record<string, string> {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { return {} }
  }
  private write(m: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(m, null, 2), { mode: 0o600 })
  }
  async save(address: string, seed: string): Promise<void> { const m = this.read(); m[address] = seed; this.write(m) }
  async load(address: string): Promise<string | undefined> { return this.read()[address] }
  async delete(address: string): Promise<void> { const m = this.read(); delete m[address]; this.write(m) }
}

/**
 * Durable pool state as a gitignored JSON file. Also writes a seed-free `<file>.status.json`
 * (address + status only) that is safe to read or share.
 */
export class FilePoolStateStore implements PoolStateStore {
  constructor(private readonly file: string) {}
  private read(): PoolAccount[] {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { return [] }
  }
  private write(list: PoolAccount[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(list, null, 2))
    const redacted = list.map(({ address, status, createdLedger, leasedBy }) => ({ address, status, createdLedger, leasedBy }))
    fs.writeFileSync(this.file.replace(/\.json$/, '') + '.status.json', JSON.stringify(redacted, null, 2))
  }
  async all(): Promise<PoolAccount[]> { return this.read() }
  async get(address: string): Promise<PoolAccount | undefined> { return this.read().find((a) => a.address === address) }
  async put(a: PoolAccount): Promise<void> { const l = this.read().filter((x) => x.address !== a.address); l.push(a); this.write(l) }
  async remove(address: string): Promise<void> { this.write(this.read().filter((a) => a.address !== address)) }
}

/** Key operations backed by xrpl.Wallet. generate() is the non-deterministic step (a Temporal activity). */
export const LocalKeys: Keys = {
  generate() { const w = xrpl.Wallet.generate(); return { address: w.address, seed: w.seed as string } },
  wallet(seed: string) { return xrpl.Wallet.fromSeed(seed) },
}
