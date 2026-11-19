import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import { SqliteStateStore } from '../src/store/sqlite.ts'
import { runStoreContract } from './store-contract.ts'

const dir = mkdtempSync(join(tmpdir(), 'cosigner-sqlite-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const newFile = (): string => join(dir, `s${n++}.db`)

const files = new Map<SqliteStateStore, string>()
runStoreContract('sqlite', async () => {
  const file = newFile()
  const s = await SqliteStateStore.open({ file })
  files.set(s, file)
  return s
}, { reopen: async (s) => SqliteStateStore.open({ file: files.get(s as SqliteStateStore)! }) })

describe('SqliteStateStore lease', () => {
  it('a second open on the same file rejects STORE_LOCKED', async () => {
    const file = newFile()
    const a = await SqliteStateStore.open({ file })
    await expect(SqliteStateStore.open({ file })).rejects.toThrow(/STORE_LOCKED/)
    await a.close()
  })

  it('opens after the holder closes', async () => {
    const file = newFile()
    const a = await SqliteStateStore.open({ file })
    await a.close()
    const b = await SqliteStateStore.open({ file })
    await b.close()
  })

  it('opens over a stale heartbeat', async () => {
    const file = newFile()
    const a = await SqliteStateStore.open({ file, leaseMs: 15000 })
    const raw = new Database(file)
    raw.prepare("update meta set value = ? where key = 'lease.heartbeat'").run(String(Date.now() - 60000))
    raw.close()
    const b = await SqliteStateStore.open({ file, leaseMs: 15000 })
    await b.close()
    await a.close() // must not clear b's (already cleared) lease or throw
  })

  it('a second open from the same process is refused while the first is live, and the first keeps working', async () => {
    const file = newFile()
    const a = await SqliteStateStore.open({ file })
    await expect(SqliteStateStore.open({ file })).rejects.toThrow(/STORE_LOCKED/)
    await a.transaction(async (tx) => { await tx.setMeta('k', 'v') })
    expect((await a.loadAll()).meta).toEqual({ k: 'v' })
    await a.close()
  })

  it('concurrent opens: exactly one wins', async () => {
    const file = newFile()
    const rs = await Promise.allSettled([SqliteStateStore.open({ file }), SqliteStateStore.open({ file })])
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const lost = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(String(lost.reason)).toMatch(/STORE_LOCKED/)
    for (const r of rs) if (r.status === 'fulfilled') await r.value.close()
  })

  it('a store that lost its lease rejects later transactions with STORE_LOCKED', async () => {
    const file = newFile()
    const a = await SqliteStateStore.open({ file })
    const raw = new Database(file)
    raw.prepare("update meta set value = ? where key = 'lease.heartbeat'").run(String(Date.now() - 60000))
    raw.close()
    const b = await SqliteStateStore.open({ file })
    await a.renewNow()
    await expect(a.transaction(async (tx) => { await tx.setMeta('k', 'v') })).rejects.toThrow(/STORE_LOCKED/)
    await a.close() // must not release b's lease
    await expect(SqliteStateStore.open({ file })).rejects.toThrow(/STORE_LOCKED/)
    await b.close()
  })

  it('renews the heartbeat while open, and keeps lease rows out of loadAll().meta', async () => {
    const file = newFile()
    const a = await SqliteStateStore.open({ file, leaseMs: 60 })
    const read = (): number => {
      const raw = new Database(file, { readonly: true })
      try { return Number((raw.prepare("select value from meta where key = 'lease.heartbeat'").get() as { value: string }).value) } finally { raw.close() }
    }
    const first = read()
    await new Promise((r) => setTimeout(r, 120))
    expect(read()).toBeGreaterThan(first)
    expect((await a.loadAll()).meta).toEqual({})
    await a.close()
  })

  it('persists across instances (durability)', async () => {
    const file = newFile()
    const a = await SqliteStateStore.open({ file })
    await a.transaction(async (tx) => { await tx.setMeta('k', 'v'); await tx.appendDecision({ id: 'd', type: 't' } as never) })
    await a.close()
    const b = await SqliteStateStore.open({ file })
    expect((await b.loadAll()).meta).toEqual({ k: 'v' })
    await b.close()
  })
})
