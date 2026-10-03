import { existsSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { AskService } from '../asks/ask-service.js'
import { turnStatesOf, turnsOf } from './session-db-fixtures.js'
import { sessionOf, startSession, typesOf, waitFor } from './session-fixtures.js'
import { helloFileOf, refusalOf, workspaceOf } from './session-helpers.js'
import { sessionLayer } from './session-layers.js'
import { SessionManager } from './session-manager.js'

const SLOW = { BYTEBUREAU_FAKE_SCRIPT: 'slow' }
const READY = 'session.ready'

const countOf = (types: readonly string[], type: string): number =>
  types.filter((candidate) => candidate === type).length

it.layer(sessionLayer())('SessionManager prompts', (suite) => {
  suite.effect('refuses a second prompt while a turn is running and records only the first', () =>
    Effect.gen(function* refusesSecondPrompt() {
      const sessions = yield* SessionManager
      const session = yield* startSession({ env: SLOW })
      yield* sessions.prompt(session.id, { text: 'first' })
      const refused = yield* refusalOf(sessions.prompt(session.id, { text: 'second' }))
      assert.strictEqual(refused, 'invalid_transition: cannot prompt a running session')
      assert.strictEqual((yield* turnsOf(session.id)).length, 1)
      assert.strictEqual(countOf(yield* typesOf(session.id), 'message.user'), 1)
      yield* sessions.stop(session.id)
    }),
  )

  suite.effect('refuses a prompt for a session that does not exist', () =>
    Effect.gen(function* refusesUnknown() {
      const sessions = yield* SessionManager
      const refused = yield* refusalOf(sessions.prompt('missing', { text: 'x' }))
      assert.strictEqual(refused, 'not_found: session missing does not exist')
    }),
  )
})

it.layer(sessionLayer())('SessionManager interrupt', (suite) => {
  suite.effect(
    'interrupts a running turn: the turn is interrupted and the session is ready again',
    () =>
      Effect.gen(function* interruptsTurn() {
        const sessions = yield* SessionManager
        const session = yield* startSession({ env: SLOW })
        yield* sessions.prompt(session.id, { text: 'take your time' })
        yield* waitFor(session.id, 'turn.started')
        yield* sessions.interrupt(session.id)
        yield* waitFor(session.id, READY, 1)
        assert.deepStrictEqual(yield* turnStatesOf(session.id), [['interrupted', 'interrupted']])
        assert.strictEqual((yield* sessionOf(session.id)).status, 'ready')
        assert.strictEqual((yield* sessions.prompt(session.id, { text: 'again' })).index, 1)
        yield* sessions.stop(session.id)
      }),
  )

  suite.effect('cannot interrupt a session that is not running', () =>
    Effect.gen(function* cannotInterrupt() {
      const sessions = yield* SessionManager
      const session = yield* startSession()
      const refused = yield* refusalOf(sessions.interrupt(session.id))
      assert.strictEqual(refused, `not_found: session ${session.id} is not running`)
    }),
  )
})

it.layer(sessionLayer())('SessionManager interrupt a question', (suite) => {
  suite.effect(
    'cancels the question, ends the turn as interrupted and makes the session ready',
    () =>
      Effect.gen(function* interruptsWaitingSession() {
        const sessions = yield* SessionManager
        const session = yield* startSession()
        yield* sessions.prompt(session.id, { text: 'go' })
        yield* waitFor(session.id, 'session.waiting')
        yield* sessions.interrupt(session.id)
        yield* waitFor(session.id, READY, 1)
        assert.strictEqual((yield* sessionOf(session.id)).status, 'ready')
        assert.deepStrictEqual(yield* turnStatesOf(session.id), [['interrupted', 'interrupted']])
        assert.ok(!existsSync(helloFileOf(session)))
        yield* sessions.stop(session.id)
      }),
  )
})

it.layer(sessionLayer())('SessionManager stop', (suite) => {
  suite.effect('stops a session that is ready: the worktree stays and no turn is reported', () =>
    Effect.gen(function* stopsReadySession() {
      const sessions = yield* SessionManager
      const session = yield* startSession()
      yield* sessions.stop(session.id)
      assert.strictEqual((yield* sessionOf(session.id)).status, 'stopped')
      assert.ok(existsSync(workspaceOf(session)))
      const types = yield* typesOf(session.id)
      assert.deepStrictEqual(types.slice(-2), [READY, 'session.stopped'])
    }),
  )

  suite.effect('refuses to stop a session twice and leaves the first stop as it was', () =>
    Effect.gen(function* refusesSecondStop() {
      const sessions = yield* SessionManager
      const session = yield* startSession()
      yield* sessions.stop(session.id)
      const refused = yield* refusalOf(sessions.stop(session.id))
      assert.strictEqual(refused, 'invalid_transition: cannot stop a stopped session')
      assert.strictEqual(countOf(yield* typesOf(session.id), 'session.stopped'), 1)
    }),
  )
})

it.layer(sessionLayer())('SessionManager stop a question', (suite) => {
  suite.effect(
    'cancels the question a session waits on, interrupts the turn and keeps the worktree',
    () =>
      Effect.gen(function* stopsWaitingSession() {
        const sessions = yield* SessionManager
        const asks = yield* AskService
        const session = yield* startSession()
        yield* sessions.prompt(session.id, { text: 'go' })
        yield* waitFor(session.id, 'session.waiting')
        yield* sessions.stop(session.id)
        assert.deepStrictEqual(yield* asks.pending(session.id), [])
        const types = yield* typesOf(session.id)
        assert.deepStrictEqual(types.slice(-4), [
          'session.waiting',
          'turn.interrupted',
          'ask.cancelled',
          'session.stopped',
        ])
        assert.ok(existsSync(workspaceOf(session)))
      }),
  )
})

it.layer(sessionLayer())('SessionManager complete', (suite) => {
  suite.effect('completes a session that is ready and refuses anything after it', () =>
    Effect.gen(function* completesSession() {
      const sessions = yield* SessionManager
      const session = yield* startSession()
      yield* sessions.complete(session.id)
      const completed = yield* sessionOf(session.id)
      assert.ok(completed.status === 'completed' && completed.endedAt !== null)
      const prompt = yield* refusalOf(sessions.prompt(session.id, { text: 'x' }))
      const resume = yield* refusalOf(sessions.resume(session.id))
      const stop = yield* refusalOf(sessions.stop(session.id))
      assert.deepStrictEqual(
        [prompt, resume, stop],
        [
          'invalid_transition: cannot prompt a completed session',
          'invalid_transition: cannot resume a completed session',
          'invalid_transition: cannot stop a completed session',
        ],
      )
    }),
  )

  suite.effect('refuses to complete a running session and leaves its agent running', () =>
    Effect.gen(function* refusesCompletion() {
      const sessions = yield* SessionManager
      const session = yield* startSession({ env: SLOW })
      yield* sessions.prompt(session.id, { text: 'take your time' })
      const refused = yield* refusalOf(sessions.complete(session.id))
      assert.strictEqual(refused, 'invalid_transition: cannot complete a running session')
      yield* sessions.interrupt(session.id)
      yield* waitFor(session.id, READY, 1)
      yield* sessions.complete(session.id)
    }),
  )
})

it.layer(sessionLayer())('SessionManager resume', (suite) => {
  suite.effect('refuses to resume a session that is ready', () =>
    Effect.gen(function* refusesResume() {
      const sessions = yield* SessionManager
      const session = yield* startSession()
      const refused = yield* refusalOf(sessions.resume(session.id))
      assert.strictEqual(refused, 'invalid_transition: cannot resume a ready session')
    }),
  )

  suite.effect('resumes a stopped session and announces it', () =>
    Effect.gen(function* resumesStopped() {
      const sessions = yield* SessionManager
      const session = yield* startSession()
      yield* sessions.stop(session.id)
      const resumed = yield* sessions.resume(session.id)
      assert.deepStrictEqual([resumed.status, resumed.endedAt], ['ready', null])
      const types = yield* typesOf(session.id)
      assert.deepStrictEqual(types.slice(-3), [READY, 'session.stopped', 'session.resumed'])
    }),
  )
})
