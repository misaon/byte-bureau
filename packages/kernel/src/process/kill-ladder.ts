import { Effect, Option, type Duration } from 'effect'

export type KillSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL'

// A signal and how long the process gets to exit before the next, harsher one
interface Rung {
  readonly signal: KillSignal
  readonly grace: Duration.Input | null
}

export const GRACEFUL_LADDER: readonly Rung[] = [
  { signal: 'SIGINT', grace: '5 seconds' },
  { signal: 'SIGTERM', grace: '10 seconds' },
  { signal: 'SIGKILL', grace: null },
]

// A closing scope skips the polite SIGINT
export const TERMINATE_LADDER: readonly Rung[] = GRACEFUL_LADDER.slice(1)

export const ladderFor = (signal?: KillSignal): readonly Rung[] =>
  signal === undefined ? GRACEFUL_LADDER : [{ signal, grace: null }]

// Sends each signal in turn; a rung with a grace period gives the process that long to exit first
export const climb = (
  rungs: readonly Rung[],
  send: (signal: KillSignal) => void,
  exited: Effect.Effect<unknown>,
): Effect.Effect<void> =>
  Effect.gen(function* climbLadder() {
    for (const { signal, grace } of rungs) {
      send(signal)
      if (grace === null) {
        return
      }
      const gone = yield* Effect.timeoutOption(exited, grace)
      if (Option.isSome(gone)) {
        return
      }
    }
  })
