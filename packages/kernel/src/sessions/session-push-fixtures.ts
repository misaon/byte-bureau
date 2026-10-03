import type { AgentEvent } from '@bytebureau/protocol'
import { Effect, type Cause } from 'effect'
import type { StoreError } from '../errors.js'
import type { EventLog } from '../events/event-log.js'
import { uuidv7 } from '../ids.js'
import type { ScriptedSession } from '../testing/scripted-provider.js'
import { waitUntil } from './session-fixtures.js'

const hasMessage = (payload: unknown, message: string): boolean =>
  typeof payload === 'object' &&
  payload !== null &&
  'message' in payload &&
  payload.message === message

// Pushes events into a session and waits until the kernel has applied them all
// A warning that nothing else produces goes in last; the events of a session are applied in order, so seeing it means the others are done
export const push = (
  sessionId: string,
  agent: ScriptedSession,
  ...events: readonly AgentEvent[]
): Effect.Effect<void, StoreError | Cause.NoSuchElementError, EventLog> => {
  const message = `marker-${uuidv7()}`
  agent.queue.push(...events, { type: 'session.warning', kind: 'marker', message })
  const marked = (event: { readonly type: string; readonly payload: unknown }): boolean =>
    event.type === 'session.warning' && hasMessage(event.payload, message)
  return Effect.asVoid(waitUntil(sessionId, marked))
}
