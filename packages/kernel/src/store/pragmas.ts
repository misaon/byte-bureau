import { Effect } from 'effect'
import { SqlClient, type SqlError } from 'effect/sql'

// The sqlite layers set journal_mode=WAL and busy_timeout themselves; these are the remaining spec pragmas
export const applyPragmas: Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> = Effect.gen(
  function* setPragmas() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`PRAGMA foreign_keys = ON`
    yield* sql`PRAGMA synchronous = NORMAL`
  },
)
