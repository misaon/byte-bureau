import { assert, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import {
  gatedLog,
  heldAtGate,
  labelOf,
  makeGate,
  subscriber,
  textDelta,
  toolCall,
} from './event-log-fixtures.js'

const AFTER_INSERT = { marker: 'INSERT INTO events', after: true }
const BEFORE_REPLAY = { marker: 'SELECT seq, id, ts', after: false }

it.effect(
  'replays a straggler stored before the subscription opened once, and offers it live never',
  () =>
    Effect.gen(function* replaysStraggler() {
      const gate = yield* makeGate
      const log = yield* gatedLog({ ...AFTER_INSERT, marker: 'straggler' }, gate)
      const publishing = yield* heldAtGate(log.publish(toolCall('straggler')), gate)
      yield* log.publish(toolCall('later'))
      const reading = yield* subscriber(log, { sessionId: 's' }, 3)
      yield* gate.release.open
      yield* Fiber.join(publishing)
      yield* log.publish(toolCall('last'))
      const seen = yield* Fiber.join(reading)
      assert.deepStrictEqual(
        seen.map((envelope) => labelOf(envelope)),
        ['straggler', 'later', 'last'],
      )
    }),
)

it.effect('offers a live subscriber every event, a straggler after a later one, each once', () =>
  Effect.gen(function* offersStraggler() {
    const gate = yield* makeGate
    const log = yield* gatedLog({ ...AFTER_INSERT, marker: 'straggler' }, gate)
    const reading = yield* subscriber(log, { sessionId: 's' }, 2)
    const publishing = yield* heldAtGate(log.publish(toolCall('straggler')), gate)
    const later = yield* log.publish(toolCall('later'))
    yield* gate.release.open
    const straggler = yield* Fiber.join(publishing)
    const seen = yield* Fiber.join(reading)
    assert.deepStrictEqual(
      seen.map((envelope) => labelOf(envelope)),
      ['later', 'straggler'],
    )
    assert.isBelow(straggler.seq, later.seq)
  }),
)

it.effect('delivers an ephemeral event published during the replay after the replayed rows', () =>
  Effect.gen(function* queuesEphemeral() {
    const gate = yield* makeGate
    const log = yield* gatedLog(BEFORE_REPLAY, gate)
    yield* log.publish(toolCall('stored'))
    const reading = yield* subscriber(log, { sessionId: 's' }, 2)
    yield* gate.entered.await
    yield* log.publish(textDelta('live'))
    yield* gate.release.open
    const seen = yield* Fiber.join(reading)
    assert.deepStrictEqual(
      seen.map((envelope) => [labelOf(envelope), envelope.seq > 0]),
      [
        ['stored', true],
        ['live', false],
      ],
    )
  }),
)

it.effect('offers a stored event to live subscribers even when its publisher is interrupted', () =>
  Effect.gen(function* publishesAtomically() {
    const gate = yield* makeGate
    const log = yield* gatedLog(AFTER_INSERT, gate)
    const reading = yield* subscriber(log, { sessionId: 's' }, 1)
    const publishing = yield* heldAtGate(log.publish(toolCall('interrupted')), gate)
    const interrupting = yield* Effect.forkChild(Fiber.interrupt(publishing), {
      startImmediately: true,
    })
    yield* gate.release.open
    yield* Fiber.join(interrupting)
    const seen = yield* Fiber.join(reading)
    assert.deepStrictEqual(
      seen.map((envelope) => labelOf(envelope)),
      ['interrupted'],
    )
  }),
)
