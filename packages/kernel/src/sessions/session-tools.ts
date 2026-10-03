import type { AgentEvent } from '@bytebureau/protocol'
import { Effect } from 'effect'
import type { SqlClient } from 'effect/sql'
import { toStoreError, type StoreError } from '../errors.js'
import { nowIso, uuidv7 } from '../ids.js'
import type { Live } from './live-sessions.js'

type ToolStarted = Extract<AgentEvent, { readonly type: 'tool.started' }>
type ToolEnded = Extract<AgentEvent, { readonly type: 'tool.completed' | 'tool.failed' }>

// Only a capped summary of what a tool returned is kept (spec §5.2)
const SUMMARY_LIMIT = 32_768

// The name a tool call was started under, empty for a call nobody saw start
export const toolNameOf = (live: Live, toolId: string): string => {
  const note = live.tools.get(toolId)
  return note === undefined ? '' : note.name
}

const jsonOf = (value: unknown): string => (value === undefined ? 'null' : JSON.stringify(value))

// A tool call is recorded when it starts, under an id of its own: providers may reuse theirs from one turn to the next
export const startTool = (
  sql: SqlClient.SqlClient,
  live: Live,
  event: ToolStarted,
): Effect.Effect<void, StoreError> =>
  Effect.suspend(() => {
    const rowId = uuidv7()
    const input = jsonOf(event.input)
    live.tools.set(event.id, { rowId, name: event.name })
    return sql`
      INSERT INTO tool_calls (id, session_id, turn_id, tool_name, kind, input_json, input_bytes, status, started_at)
      VALUES (${rowId}, ${live.session.id}, ${live.turn === null ? null : live.turn.turnId}, ${event.name}, ${event.kind}, ${input}, ${Buffer.byteLength(input)}, 'running', ${nowIso()})`.pipe(
      Effect.asVoid,
      Effect.mapError(toStoreError),
    )
  })

const resultOf = (
  event: ToolEnded,
): { readonly status: string; readonly summary: string; readonly bytes: number } =>
  event.type === 'tool.failed'
    ? { status: 'failed', summary: event.error, bytes: 0 }
    : {
        status: 'completed',
        summary: event.outputSummary.slice(0, SUMMARY_LIMIT),
        bytes: event.bytes,
      }

// The end of a call closes its row; a call nobody saw start has none
export const endTool = (
  sql: SqlClient.SqlClient,
  live: Live,
  event: ToolEnded,
): Effect.Effect<void, StoreError> =>
  Effect.suspend(() => {
    const note = live.tools.get(event.id)
    if (note === undefined) {
      return Effect.void
    }
    const { status, summary, bytes } = resultOf(event)
    return sql`
      UPDATE tool_calls SET status = ${status}, output_summary = ${summary}, output_bytes = ${bytes}, ended_at = ${nowIso()}
      WHERE id = ${note.rowId}`.pipe(Effect.asVoid, Effect.mapError(toStoreError))
  })
