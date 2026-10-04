import { EventLog } from '@bytebureau/kernel'
import { KernelEventSchemas } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import type { HttpServer } from 'effect/http'
import { API_PREFIX } from './api.js'
import { ApiTestLayer, baseUrl, bodyOf, fetched, get, post } from './testing.js'
import { createdSession } from './testing-sessions.js'
import {
  durableOf,
  envelopeOf,
  framesUntil,
  opened,
  seqNumbersOf,
  type SseFrame,
} from './testing-sse.js'

// The suites run on the live clock: under the test clock the Stream.tick of the heartbeat would never tick
const LIVE = { excludeTestServices: true }
const BEATING = ApiTestLayer({ heartbeat: '100 millis' })

const hasEvent =
  (type: string) =>
  (seen: readonly SseFrame[]): boolean =>
    seen.some((frame) => frame.event === type)

const beats = hasEvent('heartbeat')

const firstOf = (frames: readonly SseFrame[], type: string): SseFrame | undefined =>
  frames.find((frame) => frame.event === type)

const CREATED = ['session.created', 'session.provisioning', 'workspace.provisioned']

// Read until the durable events have come, and a heartbeat after them shows that nothing else is on its way
const replayedWithBeat =
  (count: number) =>
  (seen: readonly SseFrame[]): boolean =>
    seqNumbersOf(seen).length >= count && beats(seen)

// The seq numbers the log holds for a session
const loggedSeqNumbers = (sessionId: string): Effect.Effect<number[], never, EventLog> =>
  EventLog.use((log) => log.read({ sessionId }, { from: 0 })).pipe(
    Effect.map((events) => events.map((event) => event.seq)),
    Effect.orDie,
  )

// A prompt starts a turn; the frames of the stream are read up to its start
const throughTurn = (
  sessionId: string,
  response: Response,
): Effect.Effect<SseFrame[], never, HttpServer.HttpServer> =>
  Effect.gen(function* prompts() {
    yield* post(`/sessions/${sessionId}/prompt`, { text: 'go' })
    return yield* framesUntil(response, hasEvent('turn.started'))
  })

it.layer(BEATING, LIVE)('GET /api/v1/events over the fake provider', (suite) => {
  suite.effect(
    'replays the durable events of a session with their seq as id, then the live ones',
    () =>
      Effect.gen(function* streams() {
        const { session } = yield* createdSession
        const response = yield* opened(`session=${session.id}&since=0`)
        assert.strictEqual(response.status, 200)
        assert.include(response.headers.get('content-type'), 'text/event-stream')
        const frames = yield* throughTurn(session.id, response)
        const durable = durableOf(frames).map((frame) => frame.event)
        assert.deepStrictEqual(durable.slice(0, 3), CREATED)
        const logged = yield* loggedSeqNumbers(session.id)
        assert.deepStrictEqual(seqNumbersOf(frames), logged.slice(0, seqNumbersOf(frames).length))
        assert.isAbove(seqNumbersOf(frames).length, 4)
      }),
  )

  suite.effect(
    'sends the envelope as the data of each frame, and no id with an ephemeral one',
    () =>
      Effect.gen(function* streamsDeltas() {
        const { session } = yield* createdSession
        const response = yield* opened(`session=${session.id}`)
        yield* post(`/sessions/${session.id}/prompt`, { text: 'go' })
        const frames = yield* framesUntil(response, hasEvent('tool.started'))
        const delta = yield* Effect.fromNullishOr(firstOf(frames, 'message.assistant.delta'))
        assert.isUndefined(delta.id)
        assert.strictEqual(envelopeOf(delta).seq, 0)
        for (const frame of durableOf(frames)) {
          assert.containSubset(envelopeOf(frame), { type: frame.event, seq: Number(frame.id) })
        }
      }),
  )
})

// How a client says where it resumes: the query, the header, both with the header winning, or a header that says nothing
const RESUMING: [string, (seq: number) => { query: string; headers: Record<string, string> }][] = [
  ['the since query', (seq) => ({ query: `&since=${seq}`, headers: {} })],
  ['the Last-Event-ID header', (seq) => ({ query: '', headers: { 'last-event-id': String(seq) } })],
  [
    'the header over the query',
    (seq) => ({ query: '&since=0', headers: { 'last-event-id': String(seq) } }),
  ],
  [
    'the query beside a header of no number',
    (seq) => ({ query: `&since=${seq}`, headers: { 'last-event-id': 'soon' } }),
  ],
]

it.layer(BEATING, LIVE)('GET /api/v1/events resumes a client', (suite) => {
  suite.effect('from its Last-Event-ID after a lost connection, without a gap or a duplicate', () =>
    Effect.gen(function* resumes() {
      const { session } = yield* createdSession
      const first = yield* opened(`session=${session.id}`)
      const head = yield* framesUntil(first, (seen) => seqNumbersOf(seen).length >= 2)
      const lastSeen = yield* Effect.fromNullishOr(seqNumbersOf(head).at(1))
      const headers = { 'last-event-id': String(lastSeen) }
      const second = yield* opened(`session=${session.id}`, { headers })
      const tail = yield* throughTurn(session.id, second)
      const expected = (yield* loggedSeqNumbers(session.id)).filter((seq) => seq > lastSeen)
      assert.deepStrictEqual(seqNumbersOf(tail), expected.slice(0, seqNumbersOf(tail).length))
      assert.isAbove(seqNumbersOf(tail).length, 2)
    }),
  )

  suite.effect.each(RESUMING)('replays what follows the seq it is given by %s', ([, resume]) =>
    Effect.gen(function* replays() {
      const { session } = yield* createdSession
      const logged = yield* loggedSeqNumbers(session.id)
      const seen = yield* Effect.fromNullishOr(logged.at(1))
      const { query, headers } = resume(seen)
      const response = yield* opened(`session=${session.id}${query}`, { headers })
      const unseen = logged.slice(2)
      const frames = yield* framesUntil(response, replayedWithBeat(unseen.length))
      assert.deepStrictEqual(seqNumbersOf(frames), unseen)
    }),
  )
})

// The heartbeat test stays first: with other requests before it, closing the Node server at the end of this suite waited 3 s on a keep-alive connection (a bare http server and fetch do the same)
it.layer(BEATING, LIVE)('GET /api/v1/events beats and narrows', (suite) => {
  suite.effect('sends a heartbeat frame without an id while nothing happens', () =>
    Effect.gen(function* beating() {
      const started = Date.now()
      const response = yield* opened('since=1000000')
      const frames = yield* framesUntil(response, beats)
      // The first beat comes after one interval of 100 ms, not at once
      assert.isAtLeast(Date.now() - started, 90)
      const beat = yield* Effect.fromNullishOr(firstOf(frames, 'heartbeat'))
      assert.isUndefined(beat.id)
      assert.containSubset(envelopeOf(beat), { type: 'heartbeat', seq: 0 })
      const payload = Schema.decodeUnknownSync(KernelEventSchemas.heartbeat)(
        envelopeOf(beat).payload,
      )
      assert.isFalse(Number.isNaN(Date.parse(payload.at)))
    }),
  )

  suite.effect('carries only the project and the types it is asked for', () =>
    Effect.gen(function* narrows() {
      const { project, session } = yield* createdSession
      yield* createdSession
      const response = yield* opened(`project=${project.id}&types=session.created,session.ready`)
      const durable = durableOf(yield* framesUntil(response, replayedWithBeat(2)))
      assert.deepStrictEqual(
        durable.map((frame) => frame.event),
        ['session.created', 'session.ready'],
      )
      const sessions = durable.map((frame) => envelopeOf(frame).sessionId)
      assert.deepStrictEqual(sessions, [session.id, session.id])
    }),
  )
})

it.layer(ApiTestLayer())('GET /api/v1/events refuses', (suite) => {
  suite.effect('a missing token with 401, and a since that is no number with 400', () =>
    Effect.gen(function* refuses() {
      const base = yield* baseUrl
      const noToken = yield* fetched(`${base}${API_PREFIX}/events`)
      assert.strictEqual(noToken.status, 401)
      assert.containSubset(yield* bodyOf(noToken), { code: 'unauthorized' })
      const badSince = yield* get('/events?since=soon')
      assert.strictEqual(badSince.status, 400)
      assert.containSubset(badSince.body, { code: 'request_invalid' })
    }),
  )
})
