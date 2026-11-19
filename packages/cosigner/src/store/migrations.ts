import type { Kysely } from 'kysely'
import type { Migration, MigrationProvider } from 'kysely/migration'

// Portable DDL only: text / integer / bigint columns, composite primary keys, no AUTOINCREMENT.
// JSON documents are stored as text.
const m001: Migration = {
  async up(db: Kysely<any>) {
    await db.schema.createTable('meta')
      .addColumn('key', 'text', (c) => c.primaryKey())
      .addColumn('value', 'text', (c) => c.notNull())
      .execute()
    await db.schema.createTable('engagements')
      .addColumn('engagement_id', 'text', (c) => c.primaryKey())
      .addColumn('registered_record', 'text', (c) => c.notNull())
      .addColumn('registered_mandate', 'text')
      .addColumn('record', 'text', (c) => c.notNull())
      .addColumn('pins', 'text', (c) => c.notNull())
      .addColumn('closed', 'integer', (c) => c.notNull())
      .execute()
    await db.schema.createTable('attestations')
      .addColumn('engagement_id', 'text', (c) => c.notNull())
      .addColumn('statement_id', 'text', (c) => c.notNull())
      .addColumn('statement', 'text', (c) => c.notNull())
      .addColumn('receipt', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('attestations_pk', ['engagement_id', 'statement_id'])
      .execute()
    await db.schema.createTable('presigned')
      .addColumn('engagement_id', 'text', (c) => c.notNull())
      .addColumn('outcome', 'text', (c) => c.notNull())
      .addColumn('blob', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('presigned_pk', ['engagement_id', 'outcome'])
      .execute()
    await db.schema.createTable('completed')
      .addColumn('engagement_id', 'text', (c) => c.notNull())
      .addColumn('tx_hash', 'text', (c) => c.notNull())
      .addColumn('result', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('completed_pk', ['engagement_id', 'tx_hash'])
      .execute()
    await db.schema.createTable('inflight')
      .addColumn('engagement_id', 'text', (c) => c.notNull())
      .addColumn('proposed_tx_hash', 'text', (c) => c.notNull())
      .addColumn('record', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('inflight_pk', ['engagement_id', 'proposed_tx_hash'])
      .execute()
    await db.schema.createTable('decisions')
      .addColumn('seq', 'bigint', (c) => c.primaryKey())
      .addColumn('statement', 'text', (c) => c.notNull())
      .execute()
    await db.schema.createTable('last_refusal')
      .addColumn('engagement_id', 'text', (c) => c.notNull())
      .addColumn('outcome', 'text', (c) => c.notNull())
      .addColumn('fingerprint', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('last_refusal_pk', ['engagement_id', 'outcome'])
      .execute()
  },
}

export const migrationProvider: MigrationProvider = {
  async getMigrations() { return { '001_init': m001 } },
}
