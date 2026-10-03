import type { Hook, Logger } from '@bytebureau/plugin-api'
import { Effect } from 'effect'
import { reasonOf } from './reason.js'

interface Entry<Input, Output> {
  readonly plugin: string
  readonly hook: Hook<Input, Output>
}

type Rest<Input, Output> = (input: Input) => Effect.Effect<Output>

// A hook that failed after passing on leaves what the rest of the chain produced; otherwise the chain goes on without it
const resumed = <Output>(
  passedOn: Promise<Output> | undefined,
  without: () => Effect.Effect<Output>,
): Effect.Effect<Output> =>
  passedOn === undefined
    ? without()
    : Effect.promise(async () => {
        const result = await passedOn
        return result
      })

// The hooks of one name in registration order; each one decides whether to pass on to the next
export class HookChain<Input, Output> {
  private readonly entries: Entry<Input, Output>[] = []
  private readonly logger: Logger
  private readonly name: string

  public constructor(logger: Logger, name: string) {
    this.logger = logger
    this.name = name
  }

  public add(plugin: string, hook: Hook<Input, Output>): void {
    this.entries.push({ plugin, hook })
  }

  public run(input: Input, terminal: Rest<Input, Output>): Effect.Effect<Output> {
    return this.from(0, input, terminal)
  }

  private from(
    index: number,
    current: Input,
    terminal: Rest<Input, Output>,
  ): Effect.Effect<Output> {
    const entry = this.entries[index]
    if (entry === undefined) {
      return terminal(current)
    }
    return this.attempt(entry, current, (value) => this.from(index + 1, value, terminal))
  }

  // A failure that came from further down the chain is not the hook's own, so it is passed on and never reported as one
  private attempt(
    entry: Entry<Input, Output>,
    current: Input,
    rest: Rest<Input, Output>,
  ): Effect.Effect<Output> {
    const passedOn: Promise<Output>[] = []
    const downstreamFailed = { value: false }
    const next = async (value: Input): Promise<Output> => {
      const downstream = Effect.runPromise(rest(value))
      passedOn.push(downstream)
      try {
        return await downstream
      } catch (error) {
        downstreamFailed.value = true
        throw error
      }
    }
    const call = Effect.tryPromise({
      try: async () => {
        const result = await entry.hook(current, next)
        return result
      },
      catch: (failure) => failure,
    })
    return Effect.matchEffect(call, {
      onFailure: (failure) => {
        if (!downstreamFailed.value) {
          this.report(entry, failure)
        }
        return resumed(passedOn.at(-1), () => rest(current))
      },
      onSuccess: (result) => Effect.succeed(result),
    })
  }

  private report(entry: Entry<Input, Output>, failure: unknown): void {
    this.logger.warn('hook failed; continuing', {
      plugin: entry.plugin,
      hook: this.name,
      cause: reasonOf(failure),
    })
  }
}
