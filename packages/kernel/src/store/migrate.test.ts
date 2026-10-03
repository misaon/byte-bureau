import { assert, it } from '@effect/vitest'
import { Effect, Result } from 'effect'
import { SqlClient } from 'effect/sql'
import { applyMigration, MIGRATIONS, runMigrations } from './migrate.js'
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

const PROJECT = `INSERT INTO projects (id, name, path, default_branch, config_json, created_at, updated_at) VALUES ('p', 'p', '/p', 'main', '{}', 't', 't')`
const session = (id: string, project: string): string =>
  `INSERT INTO sessions (id, project_id, title, employee_json, provider_id, profile_id, workspace_json, status, created_at) VALUES ('${id}', '${project}', 't', '{}', 'fake', NULL, '{}', 'created', '2026-10-02T00:00:00.000Z')`

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

  suite.effect('creates the SP1 tables with foreign keys on and synchronous NORMAL', () =>
    Effect.gen(function* createsTables() {
      const sql = yield* SqlClient.SqlClient
      const tables = yield* sql<{
        readonly name: string
      }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
      const names = tables.map((row) => row.name)
      for (const expected of SP1_TABLES) {
        assert.include(names, expected)
      }
      const fk = yield* sql<{ readonly foreign_keys: number }>`PRAGMA foreign_keys`
      const synchronous = yield* sql<{ readonly synchronous: number }>`PRAGMA synchronous`
      assert.deepStrictEqual(
        [...fk.map((row) => row.foreign_keys), ...synchronous.map((row) => row.synchronous)],
        [1, 1],
      )
    }),
  )

  suite.effect('refuses a row whose foreign key points nowhere and takes one that does not', () =>
    Effect.gen(function* enforcesForeignKeys() {
      const sql = yield* SqlClient.SqlClient
      const orphan = yield* Effect.result(sql.unsafe(session('orphan', 'missing')))
      yield* sql.unsafe(PROJECT)
      const owned = yield* Effect.result(sql.unsafe(session('owned', 'p')))
      assert.deepStrictEqual([Result.isFailure(orphan), Result.isSuccess(owned)], [true, true])
    }),
  )
})

it.layer(StoreTest)('Store migration runner', (suite) => {
  suite.effect(
    'skips a migration that was recorded meanwhile, checking inside its transaction',
    () =>
      Effect.gen(function* skipsRecorded() {
        const sql = yield* SqlClient.SqlClient
        const initial = yield* Effect.fromNullishOr(MIGRATIONS[0])
        yield* applyMigration(sql, initial)
        const recorded = yield* sql<{
          readonly total: number
        }>`SELECT count(*) AS total FROM bb_migrations`
        assert.deepStrictEqual(
          recorded.map((row) => row.total),
          [MIGRATIONS.length],
        )
      }),
  )

  suite.effect('names the migration that failed, and records nothing of it', () =>
    Effect.gen(function* namesFailedMigration() {
      const sql = yield* SqlClient.SqlClient
      const broken = { id: '9999_broken', sql: 'CREATE TABLE broken (id TEXT);\nCREATE TABLE (' }
      const failure = yield* Effect.flip(applyMigration(sql, broken))
      assert.match(failure.message, /^migration 9999_broken failed: /u)
      const leftovers = yield* sql<{
        readonly name: string
      }>`SELECT name FROM sqlite_master WHERE name = 'broken' UNION ALL SELECT id FROM bb_migrations WHERE id = '9999_broken'`
      assert.deepStrictEqual(leftovers, [])
    }),
  )
})
