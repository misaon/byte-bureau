import type { AgentEvent, KernelEvent } from '@bytebureau/protocol'
import { Effect } from 'effect'
import type { StoreError } from '../errors.js'
import type { Live } from './live-sessions.js'
import type { SessionDeps } from './session-deps.js'
import { toolNameOf } from './session-tools.js'
import { translate, type Lookups } from './translate.js'

// What the kernel knows about the session that the translation of an event needs
const lookupsOf = (live: Live): Lookups => ({
  toolName: (toolId) => toolNameOf(live, toolId),
  profileId: live.session.profileId,
})

export const turnIdOf = (live: Live): string | null =>
  live.turn === null ? null : live.turn.turnId

// An event of the provider belongs to its session, the project of that and the turn that is running
const publish = (
  deps: SessionDeps,
  live: Live,
  event: KernelEvent,
): Effect.Effect<void, StoreError> => {
  const turnId = turnIdOf(live)
  return Effect.asVoid(
    deps.log.publish({
      ...event,
      sessionId: live.session.id,
      projectId: live.session.projectId,
      ...(turnId === null ? {} : { turnId }),
    }),
  )
}

// What the catalogue has for the event, if it has anything
// The turn and the tool names are those of the moment the event is told
export const announce = (
  deps: SessionDeps,
  live: Live,
  event: AgentEvent,
): Effect.Effect<void, StoreError> =>
  Effect.suspend(() => {
    const translated = translate(event, live.turn, lookupsOf(live))
    return translated === null ? Effect.void : publish(deps, live, translated)
  })
