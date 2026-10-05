import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ProviderError } from '../errors.js'
import { turnStatesOf, turnsOf } from './session-db-fixtures.js'
import { payloadsOf, sessionOf, startSession, typesOf, waitFor } from './session-fixtures.js'
import { freeWorktree } from './session-helper-fixtures.js'
import { FINISH } from './session-push-fixtures.js'
import { SessionManager } from './session-manager.js'
import { prompted } from './session-prompted-fixtures.js'
import { driven } from './session-script-fixtures.js'

const ERRORED = 'session.errored'

const AUTH = {
  type: 'session.error',
  kind: 'auth',
  message: 'logged out',
  retryable: false,
} as const

// What the agent still says after it reported its error: nothing of it counts
const LATE = [
  { type: 'tool.started', id: 'late', name: 'Bash', kind: 'bash', input: null },
  FINISH,
] as const

const AGENT = { providerId: 'scripted' } as const

const NO_EARS = async (): Promise<void> => {
  await Promise.resolve()
  throw new Error('no ears')
}

const failingToStart = driven({ startFailure: new Error('no binary') })

it.layer(failingToStart.layer)('SessionManager provider that cannot start', (suite) => {
  suite.effect('fails the prompt with the reason and leaves the session ready and unrecorded', () =>
    Effect.gen(function* failsToStart() {
      const sessions = yield* SessionManager
      const session = yield* startSession({ providerId: 'scripted' })
      const error = yield* Effect.flip(sessions.prompt(session.id, { text: 'go' }))
      assert.ok(error instanceof ProviderError)
      assert.deepStrictEqual(
        [error.kind, error.retryable, error.reason],
        ['crash', true, 'no binary'],
      )
      assert.strictEqual((yield* sessionOf(session.id)).status, 'ready')
      assert.deepStrictEqual(yield* turnsOf(session.id), [])
      assert.ok(!(yield* typesOf(session.id)).includes('message.user'))
    }),
  )
})

const rejecting = driven({ onPrompt: NO_EARS })

it.layer(rejecting.layer)('SessionManager agent that does not take the prompt', (suite) => {
  suite.effect('crashes the session, errors the turn and lets the agent go', () =>
    Effect.gen(function* crashesOnPrompt() {
      const session = yield* startSession({ providerId: 'scripted' })
      const { agent } = yield* prompted(rejecting, session)
      yield* waitFor(session.id, ERRORED)
      assert.deepStrictEqual(yield* payloadsOf(session.id, ERRORED), [
        {
          status: 'errored',
          kind: 'crash',
          message: 'the agent did not take the prompt: no ears',
          retryable: true,
        },
      ])
      assert.deepStrictEqual(yield* turnStatesOf(session.id), [['errored', 'crash']])
      assert.strictEqual((yield* sessionOf(session.id)).status, 'errored')
      assert.ok(agent.closed)
    }),
  )
})

const plain = driven()

it.layer(plain.layer)('SessionManager agent that reports an error', (suite) => {
  suite.effect('crashes the session with the error of the agent', () =>
    Effect.gen(function* crashesOnError() {
      const session = yield* startSession({ providerId: 'scripted' })
      const { agent } = yield* prompted(plain, session)
      agent.queue.push(AUTH, ...LATE)
      yield* waitFor(session.id, ERRORED)
      assert.deepStrictEqual(yield* payloadsOf(session.id, ERRORED), [
        { status: 'errored', kind: 'auth', message: 'logged out', retryable: false },
      ])
      assert.deepStrictEqual(yield* turnStatesOf(session.id), [['errored', 'auth']])
      assert.ok(agent.closed)
    }),
  )

  suite.effect('drops what the agent says after its error', () =>
    Effect.gen(function* dropsLateEvents() {
      const session = yield* startSession({ providerId: 'scripted' })
      const { agent } = yield* prompted(plain, session)
      agent.queue.push(AUTH, ...LATE)
      yield* waitFor(session.id, ERRORED)
      yield* agent.queue.finished.await
      const types = yield* typesOf(session.id)
      assert.deepStrictEqual(
        types.filter((type) => type === 'tool.started' || type === 'turn.completed'),
        [],
      )
    }),
  )

  suite.effect('attaches a new agent to a session that is resumed after a crash', () =>
    Effect.gen(function* attachesAfterCrash() {
      const sessions = yield* SessionManager
      const session = yield* startSession({ providerId: 'scripted' })
      const first = yield* prompted(plain, session)
      first.agent.queue.push(AUTH)
      yield* waitFor(session.id, ERRORED)
      yield* sessions.resume(session.id)
      const second = yield* prompted(plain, session, { text: 'again' })
      assert.ok(first.agent.closed && !second.agent.closed && second.agent !== first.agent)
    }),
  )
})

const FIRST = { providerId: 'scripted', ref: 'first' }
const RESTARTED = { providerId: 'scripted', ref: 'restarted' }
const referenced = driven({ externalRef: FIRST })
const unreferenced = driven()

it.layer(referenced.layer)(
  'SessionManager agent whose reference changes before its error',
  (suite) => {
    suite.effect('keeps the reference the agent gave last, for a resume', () =>
      Effect.gen(function* keepsLastReference() {
        const session = yield* startSession(AGENT)
        const { agent } = yield* prompted(referenced, session)
        agent.externalRef = RESTARTED
        agent.queue.push(AUTH)
        yield* waitFor(session.id, ERRORED)
        assert.deepStrictEqual((yield* sessionOf(session.id)).externalRef, RESTARTED)
      }),
    )
  },
)

it.layer(unreferenced.layer)('SessionManager agent that errors in its first turn', (suite) => {
  suite.effect('keeps the reference the agent gave meanwhile', () =>
    Effect.gen(function* keepsFirstReference() {
      const session = yield* startSession(AGENT)
      const { agent } = yield* prompted(unreferenced, session)
      agent.externalRef = FIRST
      agent.queue.push(AUTH)
      yield* waitFor(session.id, ERRORED)
      assert.deepStrictEqual((yield* sessionOf(session.id)).externalRef, FIRST)
    }),
  )
})

const broken = driven({ eventsFailure: new Error('stream broke') })

it.layer(broken.layer)('SessionManager agent whose events fail', (suite) => {
  suite.effect('crashes the session with a protocol error and the reason of the failure', () =>
    Effect.gen(function* crashesOnStreamFailure() {
      const session = yield* startSession({ providerId: 'scripted' })
      yield* prompted(broken, session)
      yield* waitFor(session.id, ERRORED)
      assert.deepStrictEqual(yield* payloadsOf(session.id, ERRORED), [
        { status: 'errored', kind: 'protocol', message: 'stream broke', retryable: true },
      ])
    }),
  )
})

const withoutEvents = driven({ eventsThrow: new Error('no events for you') })

it.layer(withoutEvents.layer)('SessionManager agent that cannot give its events', (suite) => {
  suite.effect('crashes the session instead of leaving it running without a pump', () =>
    Effect.gen(function* crashesOnMissingEvents() {
      const session = yield* startSession(AGENT)
      yield* prompted(withoutEvents, session)
      yield* waitFor(session.id, ERRORED)
      assert.deepStrictEqual(yield* payloadsOf(session.id, ERRORED), [
        { status: 'errored', kind: 'protocol', message: 'no events for you', retryable: true },
      ])
    }),
  )
})

const erroring = driven()

it.layer(erroring.layer)('SessionManager errored session', (suite) => {
  suite.effect('completes the errored session without its agent, and frees its worktree', () =>
    Effect.gen(function* completesErrored() {
      const sessions = yield* SessionManager
      const session = yield* startSession({ providerId: 'scripted' })
      const { agent } = yield* prompted(erroring, session)
      agent.queue.push(AUTH)
      yield* waitFor(session.id, ERRORED)
      yield* sessions.complete(session.id)
      const completed = yield* sessionOf(session.id)
      assert.ok(completed.status === 'completed' && completed.endedAt !== null)
      assert.deepStrictEqual((yield* typesOf(session.id)).slice(-2), [ERRORED, 'session.completed'])
      assert.ok(yield* freeWorktree(session))
    }),
  )
})
