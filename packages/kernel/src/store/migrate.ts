import { Effect } from 'effect'
import { SqlClient, SqlError } from 'effect/sql'
import { MIGRATIONS, type Migration } from './migrations.js'

export { MIGRATIONS } from './migrations.js'

function statements(migration: Migration): readonly string[] {
  return migration.sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '')
}

const isApplied = (
  sql: SqlClient.SqlClient,
  migration: Migration,
): Effect.Effect<boolean, SqlError.SqlError> =>
  Effect.map(
    sql<{ readonly id: string }>`SELECT id FROM bb_migrations WHERE id = ${migration.id}`,
    (rows) => rows.length > 0,
  )

// A failed migration says which one it was; the store cannot open without it
const failedMigration =
  (migration: Migration) =>
  (error: SqlError.SqlError): SqlError.SqlError =>
    new SqlError.SqlError({
      reason: new SqlError.UnknownError({
        cause: error,
        message: `migration ${migration.id} failed: ${error.message}`,
        operation: `migration ${migration.id}`,
      }),
    })

// The transaction begins IMMEDIATE, so the second of two kernels that start together sees the first one's record and skips
export const applyMigration = (
  sql: SqlClient.SqlClient,
  migration: Migration,
): Effect.Effect<void, SqlError.SqlError> =>
  sql
    .withTransaction(
      Effect.gen(function* applyOnce() {
        if (yield* isApplied(sql, migration)) {
          return
        }
        for (const statement of statements(migration)) {
          yield* sql.unsafe(statement)
        }
        yield* sql`INSERT INTO bb_migrations (id, applied_at) VALUES (${migration.id}, ${new Date().toISOString()})`
      }),
    )
    .pipe(Effect.mapError(failedMigration(migration)))

// Idempotent: every migration runs once, inside its own transaction, in array order
export const runMigrations: Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> =
  Effect.gen(function* runPending() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE IF NOT EXISTS bb_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`
    const applied = yield* sql<{ readonly id: string }>`SELECT id FROM bb_migrations`
    const done = new Set(applied.map((row) => row.id))
    for (const migration of MIGRATIONS) {
      if (!done.has(migration.id)) {
        yield* applyMigration(sql, migration)
      }
    }
  })
