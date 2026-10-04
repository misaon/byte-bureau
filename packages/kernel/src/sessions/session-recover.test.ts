import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { request } from '../asks/ask-fixtures.js'
import { AskService } from '../asks/ask-service.js'
import { WorkspaceManager } from '../workspace/workspace-manager.js'
import { turnStatesOf } from './session-db-fixtures.js'
import { payloadsOf, registerRepo, sessionOf, typesOf } from './session-fixtures.js'
import { sessionLayer } from './session-layer-fixtures.js'
import { SessionManager } from './session-manager.js'
import { leftBehind, provisionedLeft, type Left } from './session-recover-fixtures.js'

// A session left in each status of work by a process that recorded no owner, the waiting one with its question, and a ready one; then the kernel recovers
const recovery = Effect.gen(function* recovers() {
  const project = yield* registerRepo()
  const left = yield* Effect.all({
    created: leftBehind(project.id, 'created'),
    provisioning: leftBehind(project.id, 'provisioning'),
    running: leftBehind(project.id, 'running'),
    waiting: leftBehind(project.id, 'waiting_for_human'),
    paused: leftBehind(project.id, 'paused_usage_limit'),
  })
  const ready = yield* leftBehind(project.id, 'ready')
  const opened = request(left.waiting.sessionId, { turnId: left.waiting.turnId })
  const ask = yield* AskService.use((asks) => asks.open(opened))
  const recovered = yield* SessionManager.use((sessions) => sessions.recover())
  return { left, ready, askId: ask.id, recovered }
})

const statusOf = (left: Left): Effect.Effect<string, unknown, SessionManager> =>
  Effect.map(sessionOf(left.sessionId), (session) => session.status)

const INTERRUPTED = [['interrupted', 'daemon_restart']] as const

it.layer(sessionLayer())('SessionManager.recover', (suite) => {
  suite.effect('stops a session left in each status of work, and leaves a ready one alone', () =>
    Effect.gen(function* stopsLeftBehind() {
      const { left, ready, recovered } = yield* recovery
      const atWork = Object.values(left)
      const statuses = yield* Effect.forEach([...atWork, ready], statusOf)
      assert.deepStrictEqual(recovered.toSorted(), atWork.map((each) => each.sessionId).toSorted())
      assert.deepStrictEqual(statuses, [
        'stopped',
        'stopped',
        'stopped',
        'stopped',
        'stopped',
        'ready',
      ])
    }),
  )

  suite.effect('interrupts the running turns for the restart and cancels the pending ask', () =>
    Effect.gen(function* settlesLeftBehind() {
      const { left, askId } = yield* recovery
      const working = [left.running, left.waiting, left.paused]
      const turns = yield* Effect.all(working.map((each) => turnStatesOf(each.sessionId)))
      const pending = yield* AskService.use((asks) => asks.pending(left.waiting.sessionId))
      assert.deepStrictEqual(turns, [INTERRUPTED, INTERRUPTED, INTERRUPTED])
      assert.deepStrictEqual(pending, [])
      assert.deepStrictEqual(yield* payloadsOf(left.waiting.sessionId, 'ask.cancelled'), [
        { askId },
      ])
    }),
  )

  suite.effect('tells of the interrupted turn, the cancelled ask and the stop, in that order', () =>
    Effect.gen(function* announcesRecovery() {
      const { left } = yield* recovery
      assert.deepStrictEqual(yield* typesOf(left.waiting.sessionId), [
        'ask.requested',
        'turn.interrupted',
        'ask.cancelled',
        'session.stopped',
      ])
      assert.deepStrictEqual(yield* typesOf(left.created.sessionId), ['session.stopped'])
    }),
  )
})

it.layer(sessionLayer())('SessionManager.recover, once more and with a worktree', (suite) => {
  suite.effect('finds nothing left a second time', () =>
    Effect.gen(function* recoversOnce() {
      yield* recovery
      assert.deepStrictEqual(yield* SessionManager.use((sessions) => sessions.recover()), [])
    }),
  )

  suite.effect('unlocks the worktree of a session it stops, so the worktree can go', () =>
    Effect.gen(function* unlocksWorktree() {
      const project = yield* registerRepo()
      const { left, handle } = yield* provisionedLeft(project, 'paused_usage_limit')
      const workspaces = yield* WorkspaceManager
      yield* workspaces.lock(left.sessionId)
      yield* SessionManager.use((sessions) => sessions.recover())
      const outcome = yield* workspaces.destroy(left.sessionId, handle)
      assert.deepStrictEqual([yield* statusOf(left), outcome], ['stopped', { removed: true }])
    }),
  )
})
