import type { BureauClient } from '@bytebureau/client'
import type { EventEnvelope, TurnDto } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ApiTestLayer } from './testing.js'
import { awaited, client } from './testing-client.js'
import { createdSession } from './testing-sessions.js'

const CREATED = [
  'session.created',
  'session.provisioning',
  'workspace.provisioned',
  'session.ready',
]

// The events of a session until a live turn has started: the prompt goes out once the replay has reached session.ready
const throughTurn = async (
  api: BureauClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<EventEnvelope[]> => {
  const seen: EventEnvelope[] = []
  const prompts: Promise<TurnDto>[] = []
  for await (const event of api.events.subscribe({ sessionId, since: 0 }, { signal })) {
    seen.push(event)
    if (event.type === 'session.ready') {
      prompts.push(api.sessions.prompt(sessionId, { text: 'go' }))
    }
    if (event.type === 'turn.started') {
      break
    }
  }
  await Promise.all(prompts)
  return seen
}

// The events a subscription yields up to the first of the type given
const eventsUntil = async (
  events: AsyncIterable<EventEnvelope>,
  type: string,
): Promise<EventEnvelope[]> => {
  const seen: EventEnvelope[] = []
  for await (const event of events) {
    seen.push(event)
    if (event.type === type) {
      break
    }
  }
  return seen
}

const durableOf = (events: readonly EventEnvelope[]): EventEnvelope[] =>
  events.filter((event) => event.seq !== 0)

// On the live clock: the heartbeat of the stream ticks every 100 ms
it.layer(ApiTestLayer({ heartbeat: '100 millis' }), { excludeTestServices: true })(
  'the events of the daemon through @bytebureau/client',
  (suite) => {
    suite.effect('replays the durable events of a session in seq order, then a live turn', () =>
      Effect.gen(function* subscribes() {
        const api = yield* client
        const { session } = yield* createdSession
        const controller = new AbortController()
        const seen = yield* awaited(throughTurn(api, session.id, controller.signal))
        assert.containSubset(seen.at(0), { type: 'heartbeat', seq: 0 })
        const durable = durableOf(seen)
        assert.deepStrictEqual(
          durable.slice(0, 4).map((event) => event.type),
          CREATED,
        )
        const order = durable.map((event) => event.seq)
        assert.deepStrictEqual(
          order,
          [...order].toSorted((left, right) => left - right),
        )
        assert.containSubset(seen.at(-1), { type: 'turn.started', sessionId: session.id })
      }),
    )

    suite.effect('drops the heartbeats and every other ephemeral event with ephemeral: false', () =>
      Effect.gen(function* dropsEphemeral() {
        const api = yield* client
        const { session } = yield* createdSession
        const filter = { sessionId: session.id, since: 0, ephemeral: false }
        const events = api.events.subscribe(filter)
        const seen = yield* awaited(eventsUntil(events, 'session.ready'))
        assert.deepStrictEqual(
          seen.map((event) => event.type),
          CREATED,
        )
      }),
    )
  },
)
