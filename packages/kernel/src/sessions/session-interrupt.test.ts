import { assert, it } from '@effect/vitest'
import type { AskRecord } from '@bytebureau/protocol'
import { Effect } from 'effect'
import { AskService } from '../asks/ask-service.js'
import { questionRequest } from './session-ask-fixtures.js'
import { sessionOf, startSession, typesOf, waitFor } from './session-fixtures.js'
import { SessionManager } from './session-manager.js'
import { prompted } from './session-prompted-fixtures.js'
import type { SessionServices } from './session-layer-fixtures.js'
import { driven, type Driven } from './session-script-fixtures.js'

const AGENT = { providerId: 'scripted' } as const

interface Asked {
  readonly status: string
  readonly pending: readonly AskRecord[]
  readonly types: readonly string[]
}

// The agent is interrupted and then asks a question; the session waits for a human when the question still counts
const askAfterInterrupt = (world: Driven): Effect.Effect<Asked, unknown, SessionServices> =>
  Effect.gen(function* asksAfterInterrupt() {
    const sessions = yield* SessionManager
    const session = yield* startSession(AGENT)
    const { agent } = yield* prompted(world, session)
    yield* sessions.interrupt(session.id)
    agent.queue.push(questionRequest)
    yield* waitFor(session.id, 'session.waiting')
    const pending = yield* (yield* AskService).pending(session.id)
    const types = yield* typesOf(session.id)
    return { status: (yield* sessionOf(session.id)).status, pending, types }
  })

const unstoppable = driven({ interruptible: false })

it.layer(unstoppable.layer)(
  'SessionManager interrupt of an agent that cannot be interrupted',
  (suite) => {
    suite.effect('keeps the question it asks afterwards, since its turn goes on', () =>
      Effect.gen(function* keepsQuestion() {
        const { status, pending, types } = yield* askAfterInterrupt(unstoppable)
        assert.strictEqual(status, 'waiting_for_human')
        assert.strictEqual(pending.length, 1)
        assert.notInclude(types, 'ask.cancelled')
      }),
    )
  },
)

const refusing = driven({ interruptFailure: new Error('busy') })

it.layer(refusing.layer)('SessionManager interrupt the agent does not take', (suite) => {
  suite.effect('keeps the question it asks afterwards, since its turn goes on', () =>
    Effect.gen(function* keepsQuestionAfterFailure() {
      const { status, pending, types } = yield* askAfterInterrupt(refusing)
      assert.strictEqual(status, 'waiting_for_human')
      assert.strictEqual(pending.length, 1)
      assert.notInclude(types, 'ask.cancelled')
    }),
  )
})
