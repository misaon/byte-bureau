import { Effect } from 'effect'
import type { SqlClient } from 'effect/sql'
import { ProfileError, toStoreError, type StoreError } from '../errors.js'
import type { Profile } from './profile-types.js'

interface Row {
  readonly id: string
  readonly provider_id: string
  readonly name: string
  readonly kind: string
  readonly config_dir: string | null
  readonly is_default: number
  readonly created_at: string
}

const profileOf = (row: Row): Profile => ({
  id: row.id,
  providerId: row.provider_id,
  name: row.name,
  kind: row.kind === 'api_key' ? 'api_key' : 'login',
  configDir: row.config_dir,
  isDefault: row.is_default === 1,
  createdAt: row.created_at,
})

// The profile of the first row; a query that finds none has none
const firstProfile = (rows: readonly Row[]): Profile | undefined => {
  const [row] = rows
  return row === undefined ? undefined : profileOf(row)
}

const missing = (id: string): ProfileError =>
  new ProfileError({ code: 'not_found', reason: `no profile "${id}"` })

// By provider, then in the order they were added; the rowid parts two added within one millisecond
export const listProfiles = (
  sql: SqlClient.SqlClient,
): Effect.Effect<readonly Profile[], StoreError> =>
  sql<Row>`SELECT * FROM profiles ORDER BY provider_id, created_at, rowid`.pipe(
    Effect.mapError(toStoreError),
    Effect.map((rows) => rows.map((row) => profileOf(row))),
  )

export const loadProfile = (
  sql: SqlClient.SqlClient,
  id: string,
): Effect.Effect<Profile | undefined, StoreError> =>
  sql<Row>`SELECT * FROM profiles WHERE id = ${id}`.pipe(
    Effect.mapError(toStoreError),
    Effect.map(firstProfile),
  )

export const requireProfile = (
  sql: SqlClient.SqlClient,
  id: string,
): Effect.Effect<Profile, ProfileError | StoreError> =>
  Effect.flatMap(loadProfile(sql, id), (profile) =>
    profile === undefined ? Effect.fail(missing(id)) : Effect.succeed(profile),
  )

export const defaultProfileOf = (
  sql: SqlClient.SqlClient,
  providerId: string,
): Effect.Effect<Profile | undefined, StoreError> =>
  sql<Row>`SELECT * FROM profiles WHERE provider_id = ${providerId} AND is_default = 1 ORDER BY created_at, rowid`.pipe(
    Effect.mapError(toStoreError),
    Effect.map(firstProfile),
  )

// The oldest profile of a provider, which inherits the default when the default goes
export const oldestProfileOf = (
  sql: SqlClient.SqlClient,
  providerId: string,
): Effect.Effect<Profile | undefined, StoreError> =>
  sql<Row>`SELECT * FROM profiles WHERE provider_id = ${providerId} ORDER BY created_at, rowid LIMIT 1`.pipe(
    Effect.mapError(toStoreError),
    Effect.map(firstProfile),
  )

// The row claims the id, not yet as the default; a second profile of the id inserts nothing, which the result tells
export const claimProfile = (
  sql: SqlClient.SqlClient,
  profile: Profile,
): Effect.Effect<boolean, StoreError> =>
  sql`
    INSERT INTO profiles (id, provider_id, name, kind, config_dir, is_default, created_at)
    VALUES (${profile.id}, ${profile.providerId}, ${profile.name}, ${profile.kind}, ${profile.configDir}, 0, ${profile.createdAt})
    ON CONFLICT (id) DO NOTHING RETURNING id`.pipe(
    Effect.mapError(toStoreError),
    Effect.map((rows) => rows.length > 0),
  )

// The row of a profile whose key or directory could not be kept
export const forgetProfile = (
  sql: SqlClient.SqlClient,
  id: string,
): Effect.Effect<void, StoreError> =>
  sql`DELETE FROM profiles WHERE id = ${id}`.pipe(Effect.asVoid, Effect.mapError(toStoreError))

// One default per provider: the one statement sets the flag on this profile and clears it on every other
export const markDefault = (
  sql: SqlClient.SqlClient,
  providerId: string,
  id: string,
): Effect.Effect<void, StoreError> =>
  sql`UPDATE profiles SET is_default = (id = ${id}) WHERE provider_id = ${providerId}`.pipe(
    Effect.asVoid,
    Effect.mapError(toStoreError),
  )

export const makeDefault = (
  sql: SqlClient.SqlClient,
  id: string,
): Effect.Effect<void, ProfileError | StoreError> =>
  Effect.flatMap(requireProfile(sql, id), (profile) => markDefault(sql, profile.providerId, id))

// The sessions under a profile that run or can still resume: every one but a completed session, as a stopped or errored one resumes
const holdingSessionsOf = (
  sql: SqlClient.SqlClient,
  id: string,
): Effect.Effect<number, StoreError> =>
  sql<{
    readonly holding: number
  }>`SELECT COUNT(*) AS holding FROM sessions WHERE profile_id = ${id} AND status <> 'completed'`.pipe(
    Effect.mapError(toStoreError),
    Effect.map(([row]) => (row === undefined ? 0 : row.holding)),
  )

const inUse = (id: string, holding: number): ProfileError =>
  new ProfileError({
    code: 'in_use',
    reason: `profile "${id}" is in use: ${holding} session(s) still run under it or can resume; complete or remove them first`,
  })

// A session that runs or can resume keeps its profile; the completed ones let go of it, as the store refers to no profile that is gone
// The count, the release and the delete share one transaction, so a session created in between cannot slip past
export const deleteProfile = (
  sql: SqlClient.SqlClient,
  id: string,
): Effect.Effect<Profile, ProfileError | StoreError> =>
  sql
    .withTransaction(
      Effect.gen(function* deletesProfile() {
        const holding = yield* holdingSessionsOf(sql, id)
        if (holding > 0) {
          return yield* inUse(id, holding)
        }
        yield* sql`UPDATE sessions SET profile_id = NULL WHERE profile_id = ${id} AND status = 'completed'`.pipe(
          Effect.mapError(toStoreError),
        )
        const deleted = yield* sql<Row>`DELETE FROM profiles WHERE id = ${id} RETURNING *`.pipe(
          Effect.mapError(toStoreError),
          Effect.map(firstProfile),
        )
        if (deleted === undefined) {
          return yield* missing(id)
        }
        return deleted
      }),
    )
    .pipe(Effect.catchTag('SqlError', (failure) => Effect.fail(toStoreError(failure))))
