import type { ExecSpec } from '@bytebureau/plugin-api'
import { Effect } from 'effect'

// What a promise of a plugin resolves to
export const resolved = <Value>(promise: Promise<Value>): Effect.Effect<Value> =>
  Effect.promise(async () => {
    const value = await promise
    return value
  })

// What a promise of a plugin rejects with; one that resolves fails the test
export const rejected = (promise: Promise<unknown>): Effect.Effect<unknown, unknown> =>
  Effect.flip(
    Effect.tryPromise({
      try: async () => {
        const value = await promise
        return value
      },
      catch: (cause) => cause,
    }),
  )

export const linesOf = (lines: AsyncIterable<string>): Effect.Effect<readonly string[]> =>
  Effect.promise(async () => {
    const seen: string[] = []
    for await (const line of lines) {
      seen.push(line)
    }
    return seen
  })

// The first items of a subscription; leaving the loop ends it
export const takeFrom = <Item>(
  items: AsyncIterable<Item>,
  count: number,
): Effect.Effect<readonly Item[]> =>
  Effect.promise(async () => {
    const taken: Item[] = []
    for await (const item of items) {
      taken.push(item)
      if (taken.length === count) {
        break
      }
    }
    return taken
  })

// A Node script as a command a plugin can spawn
export const nodeExec = (
  script: string,
  extra: Partial<ExecSpec> = {},
): ExecSpec & { readonly cwd: string } => ({
  command: process.execPath,
  args: ['-e', script],
  cwd: process.cwd(),
  ...extra,
})
