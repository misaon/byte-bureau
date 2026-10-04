import { ApiError, connectRpc, type BureauClient, type RpcConnection } from '@bytebureau/client'
import { createTempRepo, writeConfig } from '@bytebureau/kernel/testing'
import { ProjectDto, type SessionDto } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect, Schedule, Schema } from 'effect'
import { ApiTestLayer, TEST_TOKEN } from './testing.js'
import { awaited, client, opened, refused, wsUrl } from './testing-client.js'
import { createdSession, fakeProjectConfig } from './testing-sessions.js'

const LIVE = { excludeTestServices: true }

// The streaming procedure of the daemon
const SUBSCRIBE = 'events.subscribe'

// The type of an event a stream gave, read without trusting its shape
const typeOf = (value: unknown): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, 'type') : undefined

// A session of a project registered over the socket
const createdOver = (api: BureauClient, connection: RpcConnection): Effect.Effect<SessionDto> =>
  Effect.gen(function* creates() {
    const repo = createTempRepo()
    writeConfig(repo, fakeProjectConfig)
    const registered = yield* awaited(connection.call('projects.register', { path: repo }))
    const project = Schema.decodeUnknownSync(ProjectDto)(registered)
    assert.strictEqual(project.path, repo)
    return yield* awaited(api.sessions.create({ projectId: project.id, title: 'Over the socket' }))
  })

interface TurnStream {
  readonly api: BureauClient
  readonly sessionId: string
  readonly controller: AbortController
  readonly values: AsyncIterable<unknown>
}

// The values of a stream through a live turn, which comes in a later chunk than the replay
// The prompt goes out once the replay has reached session.ready; the signal aborts at turn.started
const throughTurn = async ({
  api,
  sessionId,
  controller,
  values,
}: TurnStream): Promise<unknown[]> => {
  const seen: unknown[] = []
  const prompts: Promise<unknown>[] = []
  for await (const value of values) {
    seen.push(value)
    if (typeOf(value) === 'session.ready') {
      prompts.push(api.sessions.prompt(sessionId, { text: 'go' }))
    }
    if (typeOf(value) === 'turn.started') {
      controller.abort()
    }
  }
  await Promise.all(prompts)
  return seen
}

// The values of a stream whose signal aborts at the first one
const abortedAtFirst = async (
  values: AsyncIterable<unknown>,
  controller: AbortController,
): Promise<unknown[]> => {
  const seen: unknown[] = []
  for await (const value of values) {
    seen.push(value)
    controller.abort()
  }
  return seen
}

// Reads a stream to its end and gives what it failed with
const streamFailure = async (values: AsyncIterable<unknown>): Promise<unknown> => {
  try {
    for await (const value of values) {
      return value
    }
  } catch (error) {
    return error
  }
  return 'not refused'
}

interface ClosedUnder {
  readonly read: readonly unknown[]
  readonly failure: unknown
}

// Closes the connection as soon as the stream gives a value: what the stream gave, and what it then failed with
const closedUnder = async (
  values: AsyncIterable<unknown>,
  connection: RpcConnection,
): Promise<ClosedUnder> => {
  const read: unknown[] = []
  try {
    for await (const value of values) {
      read.push(value)
      connection.close()
    }
  } catch (error) {
    return { read, failure: error }
  }
  return { read, failure: 'not failed' }
}

// The messages of every frame a recording socket has received; the client keeps what it ignores to itself
const received: string[] = []

const messagesReceived = (): unknown[] =>
  received.flatMap((frame) => {
    const parsed: unknown = JSON.parse(frame)
    const messages: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
    return messages
  })

// A socket that records the frames it receives
class RecordingSocket extends WebSocket {
  public constructor(url: string | URL) {
    super(url)
    this.addEventListener('message', (event) => {
      received.push(typeof event.data === 'string' ? event.data : '')
    })
  }
}

const INTERRUPTED = { _tag: 'Exit', exit: { _tag: 'Failure', cause: [{ _tag: 'Interrupt' }] } }

const isInterruptedExit = (message: unknown, requestId: string): boolean =>
  typeof message === 'object' &&
  message !== null &&
  Reflect.get(message, 'requestId') === requestId &&
  JSON.stringify(message).includes('"_tag":"Interrupt"')

// The exit the daemon ended an interrupted request with, once it has come
const interruptedExit = (requestId: string): Effect.Effect<unknown> =>
  Effect.sync(() =>
    messagesReceived().find((message) => isInterruptedExit(message, requestId)),
  ).pipe(
    Effect.repeat({ until: (exit) => exit !== undefined, schedule: Schedule.spaced('10 millis') }),
    Effect.timeout('5 seconds'),
    Effect.orDie,
  )

it.layer(ApiTestLayer(), LIVE)('the RPC connection of @bytebureau/client', (suite) => {
  suite.effect('calls a procedure and streams past the first chunk until the signal aborts', () =>
    Effect.gen(function* streams() {
      const api = yield* client
      const connection = yield* opened(api.rpc.connect())
      const session = yield* createdOver(api, connection)
      const controller = new AbortController()
      const payload = { sessionId: session.id, since: 0 }
      const values = connection.stream(SUBSCRIBE, payload, controller.signal)
      const seen = yield* awaited(throughTurn({ api, sessionId: session.id, controller, values }))
      assert.containSubset(seen.at(0), { type: 'session.created', sessionId: session.id })
      assert.containSubset(seen.at(-1), { type: 'turn.started', sessionId: session.id })
    }),
  )

  suite.effect('interrupts the request on the daemon when the signal aborts', () =>
    Effect.gen(function* interrupts() {
      const url = yield* wsUrl
      const connection = yield* opened(
        connectRpc({ url, token: TEST_TOKEN, WebSocket: RecordingSocket }),
      )
      const { session } = yield* createdSession
      const controller = new AbortController()
      const payload = { sessionId: session.id, since: 0 }
      const values = connection.stream(SUBSCRIBE, payload, controller.signal)
      assert.lengthOf(yield* awaited(abortedAtFirst(values, controller)), 1)
      assert.containSubset(yield* interruptedExit('1'), { ...INTERRUPTED, requestId: '1' })
    }),
  )

  suite.effect('keeps answering between its pings and fails what is asked once it is closed', () =>
    Effect.gen(function* closes() {
      const connection = yield* opened(
        connectRpc({ url: yield* wsUrl, token: TEST_TOKEN, pingMs: 10 }),
      )
      yield* Effect.sleep('50 millis')
      const repo = createTempRepo()
      const registered = yield* awaited(connection.call('projects.register', { path: repo }))
      assert.containSubset(registered, { path: repo })
      const streamCall = yield* refused(connection.call(SUBSCRIBE, { since: 0 }))
      assert.containSubset(streamCall, { message: 'the daemon answered a call with a stream' })
      connection.close()
      const closed = yield* refused(connection.call('projects.register', { path: repo }))
      assert.containSubset(closed, { message: 'the connection is closed' })
    }),
  )
})

it.layer(ApiTestLayer(), LIVE)('the end of a stream of the RPC connection', (suite) => {
  suite.effect('opens no stream for a signal that has aborted already', () =>
    Effect.gen(function* opensNone() {
      const api = yield* client
      const connection = yield* opened(api.rpc.connect())
      const { session } = yield* createdSession
      const controller = new AbortController()
      controller.abort()
      const payload = { sessionId: session.id, since: 0 }
      const none = connection.stream(SUBSCRIBE, payload, controller.signal)
      assert.deepStrictEqual(yield* awaited(abortedAtFirst(none, controller)), [])
    }),
  )

  suite.effect('fails a stream that its connection closes under', () =>
    Effect.gen(function* closesUnder() {
      const api = yield* client
      const connection = yield* opened(api.rpc.connect())
      const { session } = yield* createdSession
      const values = connection.stream(SUBSCRIBE, { sessionId: session.id, since: 0 })
      const { read, failure } = yield* awaited(closedUnder(values, connection))
      assert.containSubset(read.at(0), { type: 'session.created' })
      assert.containSubset(failure, { message: 'the connection is closed' })
    }),
  )
})

it.layer(ApiTestLayer(), LIVE)('the refusals of the RPC connection', (suite) => {
  suite.effect('refuses a call and a stream without a valid token with the 401 problem', () =>
    Effect.gen(function* refuses() {
      const intruder = yield* opened(connectRpc({ url: yield* wsUrl, token: 'bad' }))
      const unauthorized = { status: 401, problem: { code: 'unauthorized' } }
      const called = yield* refused(intruder.call('projects.register', { path: createTempRepo() }))
      assert.instanceOf(called, ApiError)
      assert.containSubset(called, unauthorized)
      const streamed = intruder.stream(SUBSCRIBE, { since: 0 })
      assert.containSubset(yield* awaited(streamFailure(streamed)), unauthorized)
    }),
  )

  suite.effect('rejects with an ApiError of status 0 when the socket does not open', () =>
    Effect.gen(function* unreachable() {
      const url = 'ws://127.0.0.1:1/api/v1/ws'
      const failure = yield* refused(connectRpc({ url, token: TEST_TOKEN }))
      assert.instanceOf(failure, ApiError)
      assert.containSubset(failure, { status: 0, url })
    }),
  )
})
