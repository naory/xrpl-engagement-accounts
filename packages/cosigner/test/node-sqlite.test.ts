// The node:sqlite adapter for Kysely: affected-row counts (the lease renewal reads them), RETURNING rows, and a quiet
// load (no "SQLite is an experimental feature" warning on stderr).
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { Kysely, SqliteDialect, sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { kyselyDatabase, openSqlite } from '../src/store/node-sqlite.ts'

interface T { kv: { k: string; v: string } }
const db = (): Kysely<T> => new Kysely<T>({ dialect: new SqliteDialect({ database: kyselyDatabase(openSqlite(':memory:')) }) })

describe('node:sqlite adapter', () => {
  it('reports affected rows for writes, 0 when nothing matches', async () => {
    const k = db()
    await k.schema.createTable('kv').addColumn('k', 'text', (c) => c.primaryKey()).addColumn('v', 'text').execute()
    const ins = await k.insertInto('kv').values([{ k: 'a', v: '1' }, { k: 'b', v: '2' }]).executeTakeFirst()
    expect(ins.numInsertedOrUpdatedRows).toBe(2n)
    expect((await k.updateTable('kv').set({ v: '9' }).where('k', '=', 'a').executeTakeFirst()).numUpdatedRows).toBe(1n)
    expect((await k.updateTable('kv').set({ v: '9' }).where('k', '=', 'zz').executeTakeFirst()).numUpdatedRows).toBe(0n)
    expect((await k.deleteFrom('kv').where('k', '=', 'b').executeTakeFirst()).numDeletedRows).toBe(1n)
    await k.destroy()
  })

  it('returns rows for SELECT, WITH, PRAGMA and RETURNING', async () => {
    const k = db()
    await k.schema.createTable('kv').addColumn('k', 'text', (c) => c.primaryKey()).addColumn('v', 'text').execute()
    expect(await k.insertInto('kv').values({ k: 'a', v: '1' }).returning(['k', 'v']).execute()).toEqual([{ k: 'a', v: '1' }])
    expect(await k.updateTable('kv').set({ v: '2' }).returning('v').execute()).toEqual([{ v: '2' }])
    expect(await k.selectFrom('kv').selectAll().execute()).toEqual([{ k: 'a', v: '2' }])
    expect(await k.with('x', (q) => q.selectFrom('kv').select('v')).selectFrom('x').selectAll().execute()).toEqual([{ v: '2' }])
    expect((await sql<{ journal_mode: string }>`pragma journal_mode`.execute(k)).rows).toEqual([{ journal_mode: 'memory' }])
    await k.destroy()
  })

  it('loads without printing the SQLite ExperimentalWarning', () => {
    const mod = path.join(__dirname, '../src/store/node-sqlite.ts')
    const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', `import(${JSON.stringify(mod)}).then((m) => { m.openSqlite(':memory:').close(); process.emitWarning('other warning') })`], { encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stderr).not.toMatch(/SQLite is an experimental feature/)
    expect(r.stderr).toMatch(/other warning/) // other warnings still pass through
  })
})
