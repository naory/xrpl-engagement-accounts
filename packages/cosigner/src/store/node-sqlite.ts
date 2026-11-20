// Kysely's SqliteDialect over Node's built-in `node:sqlite` (no native dependency). Needs Node >= 22.13, where the
// module loads without --experimental-sqlite.
import { createRequire } from 'node:module'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { SqliteDatabase, SqliteStatement } from 'kysely'

type NodeSqlite = typeof import('node:sqlite')
let mod: NodeSqlite | undefined

/**
 * Load `node:sqlite` once, without its one-time "SQLite is an experimental feature" ExperimentalWarning (the module is
 * stable enough for this store's use; the warning would otherwise land in every co-signer's stderr). Every other
 * warning passes through. A plain require also keeps bundlers from trying to resolve the builtin.
 */
function sqlite(): NodeSqlite {
  if (mod) return mod
  const emit = process.emitWarning
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const message = typeof warning === 'string' ? warning : warning?.message
    if (/SQLite is an experimental feature/.test(String(message))) return
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest)
  } as typeof process.emitWarning
  try {
    mod = createRequire(import.meta.url)('node:sqlite') as NodeSqlite
  } finally {
    process.emitWarning = emit
  }
  return mod
}

/** Open a SQLite file with `node:sqlite`. */
export function openSqlite(file: string): DatabaseSync {
  return new (sqlite().DatabaseSync)(file)
}

/**
 * Whether a statement returns rows. better-sqlite3 exposes this as `stmt.reader`; node:sqlite has no equivalent on
 * Node 22.13 (`columns()` arrived later), so it is read from the SQL. Kysely emits these shapes only: SELECT / WITH
 * ... SELECT, PRAGMA, and INSERT/UPDATE/DELETE ... RETURNING. A misread write would still run, but report no
 * affected-row count, which the lease renewal relies on; store-sqlite tests cover that path.
 */
const READER = /^\s*(select|with|pragma|values|explain)\b|\breturning\b/i

class Statement implements SqliteStatement {
  readonly reader: boolean
  constructor(private readonly stmt: StatementSync, sql: string) { this.reader = READER.test(sql) }
  all(parameters: ReadonlyArray<unknown>): unknown[] { return this.stmt.all(...(parameters as never[])) }
  run(parameters: ReadonlyArray<unknown>): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.stmt.run(...(parameters as never[]))
  }
  iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown> {
    return this.stmt.iterate(...(parameters as never[])) as IterableIterator<unknown>
  }
}

/** Adapt a node:sqlite database to the interface Kysely's SqliteDialect drives. */
export function kyselyDatabase(db: DatabaseSync): SqliteDatabase {
  return { close: () => db.close(), prepare: (sql: string) => new Statement(db.prepare(sql), sql) }
}
