import { existsSync } from 'node:fs'
import path from 'node:path'
import { assert, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { SessionError } from '../errors.js'
import { SessionManager } from './session-manager.js'
import { answerPending, collectUntilCompleted } from './session-ask-fixtures.js'
import { registerRepo, sessionOf, startSession, typesOf, waitFor } from './session-fixtures.js'
import { helloFileOf, workspaceOf } from './session-helpers.js'
import { sessionLayer } from './session-layers.js'

const PROMPT = 'Create src/hello.ts exporting hello()\r\nwith čeština and an emoji 🚀'
const SLOW = { BYTEBUREAU_FAKE_SCRIPT: 'slow' }

// Everything a session publishes from creation to completion, in order; the ephemeral deltas are not part of it
const EXPECTED_TYPES = [
  'session.created',
  'session.provisioning',
  'workspace.provisioned',
  'session.ready',
  'session.running',
  'message.user',
  'turn.started',
  'tool.started',
  'ask.requested',
  'session.waiting',
  'ask.answered',
  'session.running',
  'tool.completed',
  'message.assistant.completed',
  'usage.updated',
  'turn.completed',
  'session.ready',
  'session.completed',
]

const COWBOY = {
  version: 1,
  project: { name: 'yolo-test' },
  employees: {
    cowboy: { name: 'Cowboy', provider: 'fake', model: 'm', permissionMode: 'yolo' },
  },
}

// The ephemeral events carry seq 0; the persisted ones must follow one another
const persistedSequence = (events: readonly { readonly seq: number }[]): number[] =>
  events.map((event) => event.seq).filter((seq) => seq !== 0)

const isAscending = (values: readonly number[]): boolean =>
  values.every((value, index) => index === 0 || value > (values[index - 1] ?? 0))

// A prompt through the fake provider, the question answered as recommended, the session completed
const runWholeSession = Effect.gen(function* runsWholeSession() {
  const sessions = yield* SessionManager
  const session = yield* startSession()
  const collected = yield* collectUntilCompleted(session.id)
  const turn = yield* sessions.prompt(session.id, { text: PROMPT })
  const ask = yield* answerPending(session.id, ['yes'])
  yield* waitFor(session.id, 'session.ready', 1)
  yield* sessions.complete(session.id)
  return { session, turn, ask, events: yield* Fiber.join(collected) }
})

it.layer(sessionLayer())('SessionManager', (suite) => {
  suite.effect('creates a session in a worktree and announces each step', () =>
    Effect.gen(function* createsSession() {
      const session = yield* startSession()
      assert.strictEqual(session.status, 'ready')
      assert.ok(existsSync(workspaceOf(session)))
      assert.deepStrictEqual(yield* typesOf(session.id), [
        'session.created',
        'session.provisioning',
        'workspace.provisioned',
        'session.ready',
      ])
    }),
  )

  suite.effect(
    'runs a prompt through the fake provider: worktree, events, ask, file, usage, completion',
    () =>
      Effect.gen(function* runsPrompt() {
        const { session, turn, ask, events } = yield* runWholeSession
        assert.strictEqual(turn.index, 0)
        assert.strictEqual(
          ask.questions
            .flatMap((question) => question.options)
            .filter((option) => option.recommended).length,
          1,
        )
        const types = events.map((event) => event.type)
        assert.deepStrictEqual(
          types.filter((type) => type !== 'message.assistant.delta'),
          EXPECTED_TYPES,
        )
        assert.ok(isAscending(persistedSequence(events)))
        const user = events.find((event) => event.type === 'message.user')
        assert.deepStrictEqual(user === undefined ? null : user.payload, { text: PROMPT })
        assert.ok(existsSync(helloFileOf(session)))
      }),
  )
})

it.layer(sessionLayer())('SessionManager refusals', (suite) => {
  suite.effect('refuses yolo on the local runtime and unknown providers before provisioning', () =>
    Effect.gen(function* refusesYolo() {
      const project = yield* registerRepo(COWBOY)
      const sessions = yield* SessionManager
      const base = { projectId: project.id, title: 'x', employeeId: 'cowboy' }
      const yolo = yield* Effect.flip(sessions.create(base))
      assert.ok(yolo instanceof SessionError)
      assert.match(yolo.reason, /yolo.*local/u)
      const missing = yield* Effect.flip(sessions.create({ ...base, providerId: 'nope' }))
      assert.ok(missing instanceof SessionError && missing.code === 'provider_missing')
      assert.ok(!existsSync(path.join(project.path, '.bytebureau', 'worktrees')))
    }),
  )
})

it.layer(sessionLayer())('SessionManager stop and resume', (suite) => {
  suite.effect(
    'stop marks the running turn interrupted, keeps the worktree and resume returns to ready',
    () =>
      Effect.gen(function* stopsAndResumes() {
        const sessions = yield* SessionManager
        const session = yield* startSession({ env: SLOW })
        yield* sessions.prompt(session.id, { text: 'take your time' })
        yield* sessions.stop(session.id)
        assert.strictEqual((yield* sessionOf(session.id)).status, 'stopped')
        assert.ok(existsSync(workspaceOf(session)))
        const types = yield* typesOf(session.id)
        assert.deepStrictEqual(
          types.filter((type) => type === 'turn.interrupted' || type === 'session.stopped'),
          ['turn.interrupted', 'session.stopped'],
        )
        assert.strictEqual((yield* sessions.resume(session.id)).status, 'ready')
      }),
  )
})
