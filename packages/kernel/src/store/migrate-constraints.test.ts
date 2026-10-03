import { assert, it } from '@effect/vitest'
import { Effect, Result } from 'effect'
import { SqlClient } from 'effect/sql'
import { StoreTest } from './store-test.js'

const NOW = '2026-10-03T00:00:00.000Z'

// One project with one session, which the rows of the other tables hang on; the store is shared, so each test names its own
const seed = (sql: SqlClient.SqlClient, name: string): Effect.Effect<void, unknown> =>
  Effect.gen(function* seedsRows() {
    yield* sql`INSERT INTO projects (id, name, path, default_branch, config_json, created_at, updated_at) VALUES (${name}, ${name}, ${`/${name}`}, 'main', '{}', ${NOW}, ${NOW})`
    yield* sql`INSERT INTO sessions (id, project_id, title, employee_json, provider_id, workspace_json, status, created_at) VALUES (${`s-${name}`}, ${name}, 't', '{}', 'fake', '{}', 'created', ${NOW})`
    yield* sql`INSERT INTO turns (id, session_id, idx, prompt_json, status, started_at) VALUES (${`t-${name}`}, ${`s-${name}`}, 0, '{}', 'running', ${NOW})`
  })

// Every column that references another table leads an index of its own table
const FOREIGN_KEYS = [
  ['sessions', 'project_id'],
  ['sessions', 'profile_id'],
  ['sessions', 'parent_session_id'],
  ['turns', 'session_id'],
  ['messages', 'session_id'],
  ['messages', 'turn_id'],
  ['tool_calls', 'session_id'],
  ['tool_calls', 'turn_id'],
  ['asks', 'session_id'],
  ['asks', 'turn_id'],
] as const

const fails = (statement: Effect.Effect<unknown, unknown>): Effect.Effect<boolean> =>
  Effect.map(Effect.result(statement), (result) => Result.isFailure(result))

it.layer(StoreTest)('Store constraints', (suite) => {
  suite.effect('refuses statuses, kinds and sources the protocol does not know', () =>
    Effect.gen(function* refusesUnknownValues() {
      const sql = yield* SqlClient.SqlClient
      yield* seed(sql, 'values')
      const refused = [
        yield* fails(sql`UPDATE sessions SET status = 'sleeping' WHERE id = 's-values'`),
        yield* fails(sql`UPDATE turns SET status = 'paused' WHERE id = 't-values'`),
        yield* fails(
          sql`INSERT INTO tool_calls (id, session_id, tool_name, kind, input_json, status, started_at) VALUES ('c', 's-values', 'Bash', 'shell', '{}', 'running', ${NOW})`,
        ),
        yield* fails(
          sql`INSERT INTO asks (id, session_id, kind, payload_json, status, recommendation_source, created_at) VALUES ('a', 's-values', 'question', '{}', 'waiting', 'agent', ${NOW})`,
        ),
        yield* fails(
          sql`INSERT INTO asks (id, session_id, kind, payload_json, status, recommendation_source, created_at) VALUES ('b', 's-values', 'question', '{}', 'pending', 'guess', ${NOW})`,
        ),
      ]
      assert.deepStrictEqual(refused, [true, true, true, true, true])
      const known = yield* fails(
        sql`UPDATE sessions SET status = 'waiting_for_human' WHERE id = 's-values'`,
      )
      assert.isFalse(known)
    }),
  )

  suite.effect('gives every turn of a session an index of its own', () =>
    Effect.gen(function* refusesDuplicateIndex() {
      const sql = yield* SqlClient.SqlClient
      yield* seed(sql, 'turns')
      const duplicate = yield* fails(
        sql`INSERT INTO turns (id, session_id, idx, prompt_json, status, started_at) VALUES ('t1', 's-turns', 0, '{}', 'running', ${NOW})`,
      )
      const next = yield* fails(
        sql`INSERT INTO turns (id, session_id, idx, prompt_json, status, started_at) VALUES ('t2', 's-turns', 1, '{}', 'running', ${NOW})`,
      )
      assert.deepStrictEqual([duplicate, next], [true, false])
    }),
  )
})

it.layer(StoreTest)('Store indexes', (suite) => {
  suite.effect('indexes the foreign keys of the child tables', () =>
    Effect.gen(function* indexesForeignKeys() {
      const sql = yield* SqlClient.SqlClient
      const verdicts = yield* Effect.all(
        FOREIGN_KEYS.map(([table, column]) =>
          Effect.map(
            sql<{ readonly leading: string }>`
              SELECT info.name AS leading FROM pragma_index_list(${table}) AS list
              JOIN pragma_index_info(list.name) AS info WHERE info.seqno = 0`,
            (indexes) => ({
              table,
              column,
              indexed: indexes.some((index) => index.leading === column),
            }),
          ),
        ),
      )
      assert.deepStrictEqual(
        verdicts.filter((verdict) => !verdict.indexed),
        [],
      )
    }),
  )
})
