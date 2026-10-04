import type { EventEnvelope } from '@bytebureau/protocol'
import { Effect, Queue, Stream, type Cause } from 'effect'
import { logApiDebug, logApiWarning } from '../logging.js'
import { DeliveryBuffer, type DeliveryLimits } from './delivery-buffer.js'

const LIMITS: DeliveryLimits = { capacity: 64, durable: 10_000 }

// The events of one take, and a line at debug level for ephemeral ones a slow reader lost meanwhile
const taken = (buffer: DeliveryBuffer): Effect.Effect<readonly EventEnvelope[]> => {
  const events = buffer.drain()
  const lost = buffer.takeDropped()
  return lost === 0
    ? Effect.succeed(events)
    : Effect.as(
        logApiDebug('a reader too slow for the stream lost ephemeral events', { lost }),
        events,
      )
}

// A reader that lags too far behind is let go: its stream ends after what waits for it, and it resumes from its last id
const letGoIfBehind = (buffer: DeliveryBuffer): Effect.Effect<void> =>
  buffer.overflowed
    ? logApiWarning(
        'a reader fell too far behind the stream, which ends; it resumes from its last id',
      )
    : Effect.void

// The source is read as fast as it comes into the buffer; the client takes what the buffer holds whenever it is ready
// A failure of the source is logged and ends the stream: an SSE client resumes from its last id
export const buffered = <Failure>(
  source: Stream.Stream<EventEnvelope, Failure>,
  limits: DeliveryLimits = LIMITS,
): Stream.Stream<EventEnvelope> =>
  Stream.unwrap(
    Effect.gen(function* startsBuffering() {
      const buffer = new DeliveryBuffer(limits)
      // One pending wake-up says there is something to take; a take empties the buffer, so more would only pile up
      const wake = yield* Queue.dropping<null, Cause.Done>(1)
      const fill = source.pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            buffer.push(event)
            Queue.offerUnsafe(wake, null)
          }),
        ),
        Stream.takeUntil(() => buffer.overflowed),
        Stream.runDrain,
        Effect.andThen(Effect.suspend(() => letGoIfBehind(buffer))),
        Effect.catchCause((cause) =>
          logApiWarning('an event subscription ended with a failure', cause),
        ),
        Effect.ensuring(Queue.end(wake)),
      )
      yield* Effect.forkScoped(fill)
      return Stream.fromQueue(wake).pipe(
        Stream.mapEffect(() => taken(buffer)),
        Stream.flattenIterable,
      )
    }),
  )
