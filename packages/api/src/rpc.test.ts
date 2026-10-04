import { EventLog, type StoreError } from '@bytebureau/kernel'
import { createTempRepo } from '@bytebureau/kernel/testing'
import { ProjectDto, PruneReportDto, SessionDto, type EventEnvelope } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect, Schema, type Cause, type Scope } from 'effect'
import type { HttpServer } from 'effect/http'
import { UNAUTHORIZED } from './auth.js'
import { ApiTestLayer, get, TEST_TOKEN } from './testing.js'
import { createdSession, registeredProject, UNKNOWN_ID } from './testing-sessions.js'
import {
  called,
  connected,
  envelopesOf,
  readUntil,
  request,
  tagOf,
  type WsClient,
  type WsMessage,
} from './testing-ws.js'

// Far longer than an event takes to reach a subscriber that is free to receive it
const QUIET = '300 millis'

interface Subscribed {
  readonly client: WsClient
  readonly first: WsMessage
}

// A client subscribed to the events of a session since the start, and the first message of the stream
const subscribed = (
  sessionId: string,
  id: string,
): Effect.Effect<Subscribed, Error | Cause.Done, HttpServer.HttpServer | Scope.Scope> =>
  Effect.gen(function* subscribes() {
    const client = yield* connected()
    const payload = { sessionId, since: 0 }
    client.send(request({ id, tag: 'events.subscribe', payload, token: TEST_TOKEN }))
    return { client, first: yield* client.next }
  })

// A durable event of the session, published while its subscription waits for an ack
const warned = (sessionId: string): Effect.Effect<EventEnvelope, StoreError, EventLog> =>
  EventLog.use((log) =>
    log.publish({
      type: 'session.warning',
      sessionId,
      payload: { kind: 'probe', message: 'published while a chunk waits for its ack' },
    }),
  )

const isExit = (message: WsMessage): boolean => tagOf(message) === 'Exit'

const isWarning = (message: WsMessage): boolean =>
  envelopesOf(message).some((event) => event.type === 'session.warning')

// The exits of a register, a create and a prune as a client reads them, through the protocol's schemas
const Registered = Schema.Struct({ exit: Schema.Struct({ value: ProjectDto }) })
const Created = Schema.Struct({ exit: Schema.Struct({ value: SessionDto }) })
const Pruned = Schema.Struct({ exit: Schema.Struct({ value: PruneReportDto }) })

interface CreatedOver {
  readonly session: SessionDto
  readonly worktree: string
}

// A session of the project created over the socket, and the path of its worktree
const createdOver = (
  client: WsClient,
  projectId: string,
): Effect.Effect<CreatedOver, Cause.Done | Cause.NoSuchElementError> =>
  Effect.gen(function* creates() {
    const payload = { projectId, title: 'Over the socket' }
    const answer = yield* called(client, {
      id: 'create',
      tag: 'sessions.create',
      payload,
      token: TEST_TOKEN,
    })
    const session = Schema.decodeUnknownSync(Created)(answer).exit.value
    const workspace = yield* Effect.fromNullishOr(session.workspace)
    return { session, worktree: workspace.path }
  })

// What the prune of a project over the socket reports
const prunedOver = (
  client: WsClient,
  projectId: string,
): Effect.Effect<PruneReportDto, Cause.Done> =>
  called(client, {
    id: 'prune',
    tag: 'workspaces.prune',
    payload: { projectId },
    token: TEST_TOKEN,
  }).pipe(Effect.map((answer) => Schema.decodeUnknownSync(Pruned)(answer).exit.value))

const SUCCEEDED = { exit: { _tag: 'Success' } }

// The failure of a procedure the kernel refused, told by the code of its problem
const refusedWith = (code: string): object => ({
  exit: { _tag: 'Failure', cause: [{ _tag: 'Fail', error: { code } }] },
})

// The other procedures on a ready session, in an order the kernel accepts, and what each answers
const lifecycle = (sessionId: string): [string, object, object][] => [
  ['sessions.interrupt', { sessionId }, refusedWith('session_not_found')],
  ['sessions.stop', { sessionId }, SUCCEEDED],
  ['sessions.resume', { sessionId }, { exit: { value: { id: sessionId, status: 'ready' } } }],
  ['sessions.complete', { sessionId }, SUCCEEDED],
  [
    'sessions.prompt',
    { sessionId, input: { text: 'more' } },
    refusedWith('session_invalid_transition'),
  ],
  ['asks.answer', { askId: UNKNOWN_ID, answer: { selected: ['x'] } }, refusedWith('ask_not_found')],
]

// What a refused request carries: no authorization header, or a token that is not the daemon's
const REFUSED: [string, string | undefined][] = [
  ['no token', undefined],
  ['a wrong token', 'not-the-token'],
]

it.layer(ApiTestLayer())('procedures over the WebSocket of /api/v1/ws', (suite) => {
  suite.effect('runs a procedure with the token in its headers and answers with its exit', () =>
    Effect.gen(function* calls() {
      const client = yield* connected()
      const repo = createTempRepo()
      const register = { id: '1', tag: 'projects.register', payload: { path: repo } }
      assert.containSubset(yield* called(client, { ...register, token: TEST_TOKEN }), {
        _tag: 'Exit',
        requestId: '1',
        exit: { _tag: 'Success', value: { path: repo } },
      })
    }),
  )

  suite.effect('fails a procedure with its problem: a project removed twice is not found', () =>
    Effect.gen(function* refusesRemoval() {
      const client = yield* connected()
      const payload = { path: createTempRepo() }
      const register = { id: '5', tag: 'projects.register', payload, token: TEST_TOKEN }
      const { exit } = Schema.decodeUnknownSync(Registered)(yield* called(client, register))
      const removal = { tag: 'projects.remove', payload: { id: exit.value.id }, token: TEST_TOKEN }
      const removed = yield* called(client, { ...removal, id: '6' })
      assert.containSubset(removed, { requestId: '6', exit: { _tag: 'Success' } })
      const notFound = { _tag: 'Fail', error: { status: 404, code: 'not_found' } }
      const again = yield* called(client, { ...removal, id: '7' })
      assert.containSubset(again, { requestId: '7', exit: { _tag: 'Failure', cause: [notFound] } })
    }),
  )

  suite.effect('answers a ping with a pong', () =>
    Effect.gen(function* pings() {
      const client = yield* connected()
      client.send({ _tag: 'Ping' })
      assert.deepStrictEqual(yield* client.next, { _tag: 'Pong' })
    }),
  )
})

it.layer(ApiTestLayer())(
  'the bearer token in the headers of each request on /api/v1/ws',
  (suite) => {
    suite.effect.each(REFUSED)(
      'refuses a request with %s: its failure is the unauthorized problem',
      ([, token]) =>
        Effect.gen(function* refuses() {
          const client = yield* connected()
          const repo = createTempRepo()
          const register = { id: '2', tag: 'projects.register', payload: { path: repo }, token }
          assert.containSubset(yield* called(client, register), {
            _tag: 'Exit',
            requestId: '2',
            exit: { _tag: 'Failure', cause: [{ _tag: 'Fail', error: UNAUTHORIZED }] },
          })
          const { body } = yield* get('/projects')
          assert.notInclude(JSON.stringify(body), repo)
        }),
    )
  },
)

it.layer(ApiTestLayer())('the session procedures over the WebSocket of /api/v1/ws', (suite) => {
  suite.effect('creates a session over the socket and reaches every procedure on it', () =>
    Effect.gen(function* drivesSession() {
      const { project } = yield* registeredProject
      const client = yield* connected()
      const { session, worktree } = yield* createdOver(client, project.id)
      assert.strictEqual(session.status, 'ready')
      for (const [tag, input, answer] of lifecycle(session.id)) {
        const done = yield* called(client, { id: tag, tag, payload: input, token: TEST_TOKEN })
        assert.containSubset(done, { requestId: tag, ...answer })
      }
      const retained = [{ path: worktree, reason: 'younger than 7 days' }]
      assert.deepStrictEqual(yield* prunedOver(client, project.id), { removed: [], retained })
      assert.containSubset((yield* get(`/sessions/${session.id}`)).body, { status: 'completed' })
    }),
  )
})

// On the live clock: the test waits a while to see that nothing comes before the ack
it.layer(ApiTestLayer(), { excludeTestServices: true })(
  'the event subscription over the WebSocket of /api/v1/ws',
  (suite) => {
    suite.effect('streams the events of a session in chunks and ends the stream on interrupt', () =>
      Effect.gen(function* streams() {
        const { session } = yield* createdSession
        const { client, first } = yield* subscribed(session.id, '3')
        assert.containSubset(first, { _tag: 'Chunk', requestId: '3' })
        assert.containSubset(envelopesOf(first).at(0), {
          type: 'session.created',
          sessionId: session.id,
        })
        client.send({ _tag: 'Ack', requestId: '3' })
        client.send({ _tag: 'Interrupt', requestId: '3' })
        const read = yield* readUntil(client, isExit)
        assert.containSubset(read.at(-1), { _tag: 'Exit', requestId: '3' })
      }),
    )

    suite.effect('sends the next chunk only once the client has acknowledged the last one', () =>
      Effect.gen(function* holdsChunks() {
        const { session } = yield* createdSession
        const { client, first } = yield* subscribed(session.id, '4')
        assert.containSubset(first, { _tag: 'Chunk', requestId: '4' })
        yield* warned(session.id)
        yield* Effect.sleep(QUIET)
        client.send({ _tag: 'Ping' })
        assert.deepStrictEqual(yield* client.next, { _tag: 'Pong' })
        client.send({ _tag: 'Ack', requestId: '4' })
        const read = yield* readUntil(
          client,
          (message) => isExit(message) || isWarning(message),
          '4',
        )
        assert.containSubset(read.at(-1), { _tag: 'Chunk', requestId: '4' })
      }),
    )
  },
)
