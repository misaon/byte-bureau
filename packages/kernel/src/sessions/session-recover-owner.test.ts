import type { SessionStatus } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { isAlive } from '../process/pid-alive.js'
import { registerRepo, sessionOf, startSession } from './session-fixtures.js'
import { sessionLayer, type SessionServices } from './session-layer-fixtures.js'
import { SessionManager } from './session-manager.js'
import {
  GONE,
  leftBehind,
  nameOwner,
  ownerOf,
  provisionedLeft,
  type Left,
  type SeededOwner,
} from './session-recover-fixtures.js'

// The status of a session the owner left in a status of work, once this kernel has recovered
const afterRecovery = (
  status: SessionStatus,
  owner: SeededOwner,
): Effect.Effect<SessionStatus, unknown, SessionServices> =>
  Effect.gen(function* recoversOwned() {
    const project = yield* registerRepo()
    const { sessionId } = yield* leftBehind(project.id, status, owner)
    yield* SessionManager.use((sessions) => sessions.recover())
    return (yield* sessionOf(sessionId)).status
  })

// The owner this kernel records, read back from a session it creates
const thisKernel: Effect.Effect<SeededOwner, unknown, SessionServices> = Effect.flatMap(
  startSession(),
  (session) => ownerOf(session.id),
)

it.layer(sessionLayer())('SessionManager.recover and the owner of a session', (suite) => {
  suite.effect('leaves alone a session this kernel owns, though nothing of it is attached', () =>
    Effect.gen(function* leavesOwn() {
      const own = yield* thisKernel
      assert.deepStrictEqual(
        [own.pid, yield* afterRecovery('running', own)],
        [process.pid, 'running'],
      )
    }),
  )

  suite.effect('leaves alone a session that a process which still runs owns', () =>
    Effect.gen(function* leavesForeign() {
      const parent = { pid: process.ppid, instance: 'parent' }
      assert.deepStrictEqual(
        [isAlive(parent.pid), yield* afterRecovery('running', parent)],
        [true, 'running'],
      )
    }),
  )

  suite.effect(
    'stops a session whose process is gone, and one of an earlier kernel of this process',
    () =>
      Effect.gen(function* stopsOrphans() {
        const gone = yield* afterRecovery('running', GONE)
        const earlier = yield* afterRecovery('waiting_for_human', {
          pid: process.pid,
          instance: 'old',
        })
        assert.deepStrictEqual([gone, earlier], ['stopped', 'stopped'])
      }),
  )

  suite.effect('stops a created session whose process is gone', () =>
    Effect.gen(function* stopsCreated() {
      assert.strictEqual(yield* afterRecovery('created', GONE), 'stopped')
    }),
  )
})

// A ready session that a kernel which is gone left behind with its worktree, prompted here
const promptedLeft: Effect.Effect<Left, unknown, SessionServices> = Effect.gen(
  function* promptsLeft() {
    const project = yield* registerRepo()
    const { left } = yield* provisionedLeft(project, 'ready', GONE)
    yield* SessionManager.use((sessions) => sessions.prompt(left.sessionId, { text: 'go' }))
    return left
  },
)

it.layer(sessionLayer())('SessionManager and the sessions it prompts', (suite) => {
  suite.effect('claims a session it prompts: the row names this process and this kernel', () =>
    Effect.gen(function* claimsPrompted() {
      const own = yield* thisKernel
      const { sessionId } = yield* promptedLeft
      const owner = yield* ownerOf(sessionId)
      yield* SessionManager.use((sessions) => sessions.stop(sessionId))
      assert.deepStrictEqual([own.pid, owner], [process.pid, own])
    }),
  )

  suite.effect('leaves alone a session attached here, even when its row names a kernel gone', () =>
    Effect.gen(function* leavesAttached() {
      const { sessionId } = yield* promptedLeft
      yield* nameOwner(sessionId, GONE)
      const sessions = yield* SessionManager
      const recovered = yield* sessions.recover()
      const { status } = yield* sessionOf(sessionId)
      yield* sessions.stop(sessionId)
      assert.deepStrictEqual([recovered, status === 'stopped'], [[], false])
    }),
  )
})

it.layer(sessionLayer())('SessionManager and the sessions it creates or resumes', (suite) => {
  suite.effect(
    'records this kernel as the owner of a session it creates and of one it resumes',
    () =>
      Effect.gen(function* claimsSessions() {
        const own = yield* thisKernel
        const project = yield* registerRepo()
        const { sessionId } = yield* leftBehind(project.id, 'stopped', GONE)
        yield* SessionManager.use((sessions) => sessions.resume(sessionId))
        assert.deepStrictEqual([own.pid, yield* ownerOf(sessionId)], [process.pid, own])
      }),
  )
})
