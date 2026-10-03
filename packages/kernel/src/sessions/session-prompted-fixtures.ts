import type { PromptInput } from '@bytebureau/protocol'
import { Effect } from 'effect'
import type { ProviderError, SessionError, StoreError } from '../errors.js'
import { sessionOfKernel, type ScriptedSession } from '../testing/scripted-provider.js'
import type { Driven } from './session-script-fixtures.js'
import { SessionManager } from './session-manager.js'
import type { Session, Turn } from './types.js'

// A session of the driven provider that has been prompted, and the agent behind it
export interface Prompted {
  readonly turn: Turn
  readonly agent: ScriptedSession
}

const GO: PromptInput = { text: 'go' }

export const prompted = (
  world: Driven,
  session: Session,
  input: PromptInput = GO,
): Effect.Effect<Prompted, SessionError | ProviderError | StoreError, SessionManager> =>
  Effect.gen(function* promptsSession() {
    const sessions = yield* SessionManager
    const turn = yield* sessions.prompt(session.id, input)
    return { turn, agent: sessionOfKernel(world.scripted, session.id) }
  })
