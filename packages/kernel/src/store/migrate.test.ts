import { assert, it } from '@effect/vitest'
import { Effect, Result } from 'effect'
import { SqlClient } from 'effect/sql'
import { MIGRATIONS, runMigrations } from './migrate.js'
import { StoreTest } from './store-test.js'

const SP1_TABLES = [
  'projects',
  'profiles',
  'sessions',
  'turns',
  'messages',
  'tool_calls',
  'asks',
  'events',
  'usage_snapshots',
  'plugin_kv',
]

it.layer(StoreTest)('Store', (suite) => {
  suite.effect('applies every migration once and records them', () =>
    Effect.gen(function* recordsMigrations() {
      const sql = yield* SqlClient.SqlClient
      const applied = yield* sql<{ readonly id: string }>`SELECT id FROM bb_migrations ORDER BY id`
      assert.deepStrictEqual(
        applied.map((row) => row.id),
        MIGRATIONS.map((migration) => migration.id),
      )
      yield* runMigrations
      const again = yield* sql<{
        readonly total: number
      }>`SELECT count(*) AS total FROM bb_migrations`
      assert.deepStrictEqual(
        again.map((row) => row.total),
        [MIGRATIONS.length],
      )
    }),
  )

  suite.effect('creates the SP1 tables with foreign keys enforced', () =>
    Effect.gen(function* enforcesForeignKeys() {
      const sql = yield* SqlClient.SqlClient
      const tables = yield* sql<{
        readonly name: string
      }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
      const names = tables.map((row) => row.name)
      for (const expected of SP1_TABLES) {
        assert.include(names, expected)
      }
      const fk = yield* sql<{ readonly foreign_keys: number }>`PRAGMA foreign_keys`
      assert.deepStrictEqual(
        fk.map((row) => row.foreign_keys),
        [1],
      )
      const orphan = yield* Effect.result(
        sql`INSERT INTO sessions (id, project_id, title, employee_json, provider_id, profile_id, workspace_json, status, created_at) VALUES ('s', 'missing', 't', '{}', 'fake', NULL, '{}', 'created', '2026-10-02T00:00:00.000Z')`,
      )
      assert.isTrue(Result.isFailure(orphan))
    }),
  )
})
