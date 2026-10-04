import type { EventEnvelope } from '@bytebureau/protocol'
import { Effect, Queue, Stream, type Cause } from 'effect'
import { logApiWarning } from '../logging.js'
import { DeliveryBuffer } from './delivery-buffer.js'

const EPHEMERAL_CAPACITY = 64

// The source is read as fast as it comes into the buffer; the client takes what the buffer holds whenever it is ready
// A failure of the source is logged and ends the stream: an SSE client resumes from its last id
export const buffered = <Failure>(
  source: Stream.Stream<EventEnvelope, Failure>,
  capacity: number = EPHEMERAL_CAPACITY,
): Stream.Stream<EventEnvelope> =>
  Stream.unwrap(
    Effect.gen(function* startsBuffering() {
      const buffer = new DeliveryBuffer(capacity)
      // One pending wake-up says there is something to take; a take empties the buffer, so more would only pile up
      const wake = yield* Queue.dropping<null, Cause.Done>(1)
      const fill = source.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            buffer.push(event)
            Queue.offerUnsafe(wake, null)
          }),
        ),
        Effect.catchCause((cause) =>
          logApiWarning('an event subscription ended with a failure', cause),
        ),
        Effect.ensuring(Queue.end(wake)),
      )
      yield* Effect.forkScoped(fill)
      return Stream.fromQueue(wake).pipe(
        Stream.map(() => buffer.drain()),
        Stream.flattenIterable,
      )
    }),
  )
