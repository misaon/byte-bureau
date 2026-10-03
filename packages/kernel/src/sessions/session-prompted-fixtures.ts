import type { PromptInput } from '@bytebureau/protocol'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import type { ProviderError, SessionError, StoreError } from '../errors.js'
import { sessionOfKernel, type ScriptedSession } from '../testing/scripted-provider.js'
import type { Driven } from './session-script-fixtures.js'
import { START_LIMIT } from './session-start.js'
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

type PromptFailure = SessionError | ProviderError | StoreError

// A prompt whose provider session never starts, followed for as long as the kernel waits for it; what the prompt fails with
export const promptWhileStartHangs = (
  world: Driven,
  session: Session,
): Effect.Effect<PromptFailure, Turn, SessionManager> =>
  Effect.gen(function* promptsWhileStartHangs() {
    const sessions = yield* SessionManager
    const prompting = yield* Effect.forkChild(sessions.prompt(session.id, GO), {
      startImmediately: true,
    })
    yield* world.scripted.asked.await
    yield* TestClock.adjust(START_LIMIT)
    return yield* Effect.flip(Fiber.join(prompting))
  })
