import type { SessionStatus } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { request } from '../asks/ask-fixtures.js'
import { AskService } from '../asks/ask-service.js'
import { turnStatesOf } from './session-db-fixtures.js'
import { payloadsOf, registerRepo, sessionOf, startSession, typesOf } from './session-fixtures.js'
import { sessionLayer } from './session-layer-fixtures.js'
import { SessionManager } from './session-manager.js'
import { leftBehind, type Left } from './session-recover-fixtures.js'

const SLOW = { BYTEBUREAU_FAKE_SCRIPT: 'slow' }

// One session left running, one waiting for the answer to its ask and one ready; then the kernel recovers
const recovery = Effect.gen(function* recovers() {
  const project = yield* registerRepo()
  const running = yield* leftBehind(project.id, 'running')
  const waiting = yield* leftBehind(project.id, 'waiting_for_human')
  const ready = yield* leftBehind(project.id, 'ready')
  const opened = request(waiting.sessionId, { turnId: waiting.turnId })
  const ask = yield* AskService.use((asks) => asks.open(opened))
  const recovered = yield* SessionManager.use((sessions) => sessions.recover())
  return { running, waiting, ready, askId: ask.id, recovered }
})

const statusOf = (left: Left): Effect.Effect<SessionStatus, unknown, SessionManager> =>
  Effect.map(sessionOf(left.sessionId), (session) => session.status)

it.layer(sessionLayer())('SessionManager.recover', (suite) => {
  suite.effect('stops what a previous process left running or waiting, and leaves the rest', () =>
    Effect.gen(function* stopsLeftBehind() {
      const { running, waiting, ready, recovered } = yield* recovery
      const statuses = yield* Effect.forEach([running, waiting, ready], statusOf)
      assert.deepStrictEqual(
        recovered.toSorted(),
        [running.sessionId, waiting.sessionId].toSorted(),
      )
      assert.deepStrictEqual(statuses, ['stopped', 'stopped', 'ready'])
    }),
  )

  suite.effect('interrupts the running turn for the restart and cancels the pending ask', () =>
    Effect.gen(function* settlesLeftBehind() {
      const { running, waiting, askId } = yield* recovery
      const pending = yield* AskService.use((asks) => asks.pending(waiting.sessionId))
      assert.deepStrictEqual(yield* turnStatesOf(running.sessionId), [
        ['interrupted', 'daemon_restart'],
      ])
      assert.deepStrictEqual(pending, [])
      assert.deepStrictEqual(yield* payloadsOf(waiting.sessionId, 'ask.cancelled'), [{ askId }])
    }),
  )

  suite.effect('tells of the interrupted turn, the cancelled ask and the stop, in that order', () =>
    Effect.gen(function* announcesRecovery() {
      const { waiting } = yield* recovery
      assert.deepStrictEqual(yield* typesOf(waiting.sessionId), [
        'ask.requested',
        'turn.interrupted',
        'ask.cancelled',
        'session.stopped',
      ])
    }),
  )
})

it.layer(sessionLayer())('SessionManager.recover in a kernel that runs sessions', (suite) => {
  suite.effect('finds nothing left a second time', () =>
    Effect.gen(function* recoversOnce() {
      yield* recovery
      assert.deepStrictEqual(yield* SessionManager.use((sessions) => sessions.recover()), [])
    }),
  )

  suite.effect('leaves a session alone that runs in this process', () =>
    Effect.gen(function* leavesLiveAlone() {
      const sessions = yield* SessionManager
      const session = yield* startSession({ env: SLOW })
      yield* sessions.prompt(session.id, { text: 'take your time' })
      const recovered = yield* sessions.recover()
      const { status } = yield* sessionOf(session.id)
      yield* sessions.stop(session.id)
      assert.deepStrictEqual([recovered, status], [[], 'running'])
    }),
  )
})
