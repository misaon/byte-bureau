import { createInterface, type Interface } from 'node:readline'
import type { Readable } from 'node:stream'
import { Effect, Queue, Stream, type Cause } from 'effect'
import { LineBuffer } from './line-buffer.js'

export interface OutputPump {
  // One consumer at a time: the queue hands each line to whoever takes it
  readonly lines: Stream.Stream<string>
  // The newest lines, whether or not anybody reads the stream
  readonly recent: () => readonly string[]
  // For a line that did not come from the input; it has to come before finish
  readonly append: (line: string) => void
  // The input is done: an input that never signalled its end is closed and the stream ends
  readonly finish: Effect.Effect<void>
}

// Lines are taken from readline's line event, as it emits them, and not from its async iterator
// Once its consumer yields to the event loop the iterator throws ERR_USE_AFTER_CLOSE and loses the last line
// It does so on Bun and on Node 24.14 alike, over 8000 lines from a real pipe
const openReader = (input: Readable | null, onLine: (line: string) => void): Interface | null => {
  if (input === null) {
    return null
  }
  const reader = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
  reader.on('line', onLine)
  // A read error ends the reading; an error event nobody listens to would throw
  reader.on('error', () => {
    reader.close()
  })
  return reader
}

// Reads eagerly into an unbounded queue, so recent() is current even when nobody consumes the stream
// A maxLines of 0 keeps no recent lines at all
export const startPump = (input: Readable | null, maxLines: number): Effect.Effect<OutputPump> =>
  Effect.gen(function* startOutputPump() {
    const queue = yield* Queue.unbounded<string, Cause.Done>()
    const buffer = maxLines > 0 ? new LineBuffer(maxLines) : null
    const record = (line: string): void => {
      if (buffer !== null) {
        buffer.push(line)
      }
      Queue.offerUnsafe(queue, line)
    }
    const reader = openReader(input, record)
    const closeReader = Effect.sync(() => {
      if (reader !== null) {
        reader.close()
      }
    })
    const finish = closeReader.pipe(Effect.andThen(Queue.end(queue)), Effect.asVoid)
    const recent = (): readonly string[] => (buffer === null ? [] : buffer.lines())
    return { lines: Stream.fromQueue(queue), recent, append: record, finish }
  })
