import type { Readable } from 'node:stream'
import { Effect, Option, type Latch } from 'effect'

// How long the pipes of an exited process get to run dry; a grandchild that holds one can keep it open for good
const DRAIN = '2 seconds'

interface Pipes {
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  // Opened once every pipe of the child is released
  readonly closed: Latch.Latch
}

const destroy = (pipe: Readable | null): void => {
  if (pipe !== null) {
    pipe.destroy()
  }
}

// After the drain the pipes are destroyed: a writer that still holds one gets EPIPE, and no descriptor stays open
export const drain = (pipes: Pipes): Effect.Effect<void> =>
  Effect.timeoutOption(pipes.closed.await, DRAIN).pipe(
    Effect.flatMap((released) =>
      Option.isSome(released)
        ? Effect.void
        : Effect.sync(() => {
            destroy(pipes.stdout)
            destroy(pipes.stderr)
          }),
    ),
  )
