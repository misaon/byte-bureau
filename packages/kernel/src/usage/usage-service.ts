import { Usage, type RateLimit } from '@bytebureau/protocol'
import { Context, Effect, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { StoreError, toStoreError } from '../errors.js'
import { nowIso } from '../ids.js'

export interface SessionUsage {
  readonly turns: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd: number | null
  readonly contextPct: number | null
}

export interface UsageSnapshot {
  readonly profileId: string
  readonly rateLimit: RateLimit
  readonly observedAt: string
}

export interface UsageServiceShape {
  readonly sessionUsage: (sessionId: string) => Effect.Effect<SessionUsage, StoreError>
  readonly record: (
    profileId: string | null,
    rateLimit: RateLimit,
  ) => Effect.Effect<void, StoreError>
  readonly snapshot: (profileId: string) => Effect.Effect<UsageSnapshot | undefined, StoreError>
}

export class UsageService extends Context.Service<UsageService, UsageServiceShape>()(
  'bb/UsageService',
) {}

// Snapshots of a session that has no profile are filed under this one
const DEFAULT_PROFILE = 'default'

interface TurnRow {
  readonly usage_json: string | null
}

interface SnapshotRow {
  readonly five_hour_pct: number | null
  readonly five_hour_resets_at: string | null
  readonly seven_day_pct: number | null
  readonly seven_day_resets_at: string | null
  readonly observed_at: string
}

const decodeUsage = Schema.decodeUnknownEffect(Schema.fromJsonString(Usage))

// A usage record that does not fit the protocol is a failure of the store, not a defect
const unreadable = (cause: unknown): StoreError =>
  new StoreError({ cause: new Error('a usage record is unreadable', { cause }) })

const usageOf = (row: TurnRow): Effect.Effect<readonly Usage[], StoreError> =>
  row.usage_json === null
    ? Effect.succeed([])
    : decodeUsage(row.usage_json).pipe(
        Effect.map((usage) => [usage]),
        Effect.mapError(unreadable),
      )

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

// Costs and context percentages are optional on a turn: none reported is null, not zero
const totalsOf = (turns: number, usages: readonly Usage[]): SessionUsage => {
  const costs = usages.flatMap((usage) => (usage.costUsd === undefined ? [] : [usage.costUsd]))
  const contexts = usages.flatMap((usage) =>
    usage.contextPct === undefined ? [] : [usage.contextPct],
  )
  return {
    turns,
    inputTokens: sum(usages.map((usage) => usage.inputTokens)),
    outputTokens: sum(usages.map((usage) => usage.outputTokens)),
    costUsd: costs.length === 0 ? null : sum(costs),
    contextPct: contexts.at(-1) ?? null,
  }
}

const makeSessionUsage =
  (sql: SqlClient.SqlClient): UsageServiceShape['sessionUsage'] =>
  (sessionId) =>
    sql<TurnRow>`SELECT usage_json FROM turns WHERE session_id = ${sessionId} ORDER BY idx`.pipe(
      Effect.mapError(toStoreError),
      Effect.flatMap((rows) => Effect.all(rows.map((row) => usageOf(row)))),
      Effect.map((usages) => totalsOf(usages.length, usages.flat())),
    )

const makeRecord =
  (sql: SqlClient.SqlClient): UsageServiceShape['record'] =>
  (profileId, rateLimit) =>
    sql`
      INSERT INTO usage_snapshots (profile_id, five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at, source, observed_at)
      VALUES (${profileId ?? DEFAULT_PROFILE}, ${rateLimit.fiveHourPct ?? null}, ${rateLimit.fiveHourResetsAt ?? null}, ${rateLimit.sevenDayPct ?? null}, ${rateLimit.sevenDayResetsAt ?? null}, 'provider', ${nowIso()})`.pipe(
      Effect.asVoid,
      Effect.mapError(toStoreError),
    )

// A column that holds null is left out of the rate limit, as the protocol declares its keys optional
const rateLimitOf = (row: SnapshotRow): RateLimit => ({
  ...(row.five_hour_pct === null ? {} : { fiveHourPct: row.five_hour_pct }),
  ...(row.five_hour_resets_at === null ? {} : { fiveHourResetsAt: row.five_hour_resets_at }),
  ...(row.seven_day_pct === null ? {} : { sevenDayPct: row.seven_day_pct }),
  ...(row.seven_day_resets_at === null ? {} : { sevenDayResetsAt: row.seven_day_resets_at }),
})

// The newest row wins; the row id breaks a tie between two snapshots taken in the same millisecond
const makeSnapshot =
  (sql: SqlClient.SqlClient): UsageServiceShape['snapshot'] =>
  (profileId) =>
    sql<SnapshotRow>`
      SELECT five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at, observed_at
      FROM usage_snapshots WHERE profile_id = ${profileId} ORDER BY observed_at DESC, rowid DESC LIMIT 1`.pipe(
      Effect.mapError(toStoreError),
      Effect.map(([row]) =>
        row === undefined
          ? undefined
          : { profileId, rateLimit: rateLimitOf(row), observedAt: row.observed_at },
      ),
    )

const make = Effect.gen(function* makeUsageService() {
  const sql = yield* SqlClient.SqlClient
  return UsageService.of({
    sessionUsage: makeSessionUsage(sql),
    record: makeRecord(sql),
    snapshot: makeSnapshot(sql),
  })
})

export const UsageServiceLive: Layer.Layer<UsageService, never, SqlClient.SqlClient> = Layer.effect(
  UsageService,
  make,
)
