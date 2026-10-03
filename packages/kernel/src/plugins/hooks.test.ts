import type { AgentSpawnInput, PromptSendInput } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect, Exit } from 'effect'
import { HookBus } from './hooks.js'
import { warnings } from './log-fixtures.js'
import { noting, passOn } from './plugin-fixtures.js'

const SEND = 'prompt.beforeSend'

const prompt = (text: string): PromptSendInput => ({ sessionId: 's', input: { text } })

const echo = (input: PromptSendInput): Effect.Effect<PromptSendInput> => Effect.succeed(input)

const agent: AgentSpawnInput = {
  sessionId: 's',
  providerId: 'p',
  command: 'agent',
  args: [],
  env: {},
}

// A hook that notes its turn, appends its mark to the text and passes on
const marking =
  (order: string[], mark: string) =>
  async (
    input: Readonly<PromptSendInput>,
    proceed: (input: PromptSendInput) => Promise<PromptSendInput>,
  ): Promise<PromptSendInput> => {
    order.push(mark)
    const result = await proceed({ ...input, input: { text: `${input.input.text}+${mark}` } })
    return result
  }

// A terminal that notes every input it is given
const recording =
  (seen: string[]) =>
  (input: PromptSendInput): Effect.Effect<PromptSendInput> =>
    Effect.sync(() => {
      seen.push(input.input.text)
      return input
    })

it.effect('runs hooks in registration order and continues when a hook throws', () =>
  Effect.gen(function* runsInOrder() {
    const bus = new HookBus(['bb', 'test'])
    const order: string[] = []
    bus.register('a', SEND, marking(order, 'a'))
    bus.register('b', SEND, () => {
      order.push('b')
      throw new Error('boom')
    })
    bus.register('c', SEND, marking(order, 'c'))
    const result = yield* bus.run(SEND, prompt('x'), echo)
    assert.deepStrictEqual(order, ['a', 'b', 'c'])
    assert.strictEqual(result.input.text, 'x+a+c')
  }),
)

it.effect('runs the terminal alone when no hook is registered', () =>
  Effect.gen(function* runsTerminalAlone() {
    const bus = new HookBus(['bb', 'test'])
    const result = yield* bus.run(SEND, prompt('x'), echo)
    assert.deepStrictEqual(result, prompt('x'))
  }),
)

it.effect('skips a hook that rejects, the way it skips one that throws', () =>
  Effect.gen(function* skipsRejection() {
    const bus = new HookBus(['bb', 'test'])
    const order: string[] = []
    bus.register('late', SEND, async () => {
      await Promise.resolve()
      throw new Error('rejected')
    })
    bus.register('c', SEND, marking(order, 'c'))
    const result = yield* bus.run(SEND, prompt('x'), echo)
    assert.deepStrictEqual(order, ['c'])
    assert.strictEqual(result.input.text, 'x+c')
  }),
)

it.effect('logs a failing hook at warn with its plugin, the hook and the reason', () =>
  Effect.gen(function* logsFailure() {
    const records = yield* warnings
    const bus = new HookBus(['bb', 'test'])
    bus.register('flaky', SEND, () => {
      throw new Error('boom')
    })
    yield* bus.run(SEND, prompt('x'), echo)
    const logged = records.map((record) => [
      record.category.join('.'),
      record.level,
      record.message[0],
      record.properties,
    ])
    assert.deepStrictEqual(logged, [
      [
        'bb.test.hooks',
        'warning',
        'hook failed; continuing',
        { plugin: 'flaky', hook: SEND, cause: 'boom' },
      ],
    ])
  }),
)

it.effect('lets a hook answer for the chain, and nothing after it runs', () =>
  Effect.gen(function* answersForChain() {
    const bus = new HookBus(['bb', 'test'])
    const reached: string[] = []
    bus.register('guard', 'agent.beforeSpawn', async () => {
      await Promise.resolve()
      return { deny: 'not today' }
    })
    const result = yield* bus.run('agent.beforeSpawn', agent, (input) =>
      Effect.sync(() => {
        reached.push(input.command)
        return input
      }),
    )
    assert.deepStrictEqual(result, { deny: 'not today' })
    assert.deepStrictEqual(reached, [])
  }),
)

it.effect('hands the result back through the hooks that passed on', () =>
  Effect.gen(function* handsResultBack() {
    const bus = new HookBus(['bb', 'test'])
    bus.register('shout', SEND, async (input, proceed) => {
      const result = await proceed(input)
      return { ...result, input: { text: result.input.text.toUpperCase() } }
    })
    const result = yield* bus.run(SEND, prompt('x'), (input) =>
      Effect.succeed(prompt(`${input.input.text}-terminal`)),
    )
    assert.strictEqual(result.input.text, 'X-TERMINAL')
  }),
)

it.effect('keeps the hooks of one name out of the chain of another', () =>
  Effect.gen(function* keepsNamesApart() {
    const bus = new HookBus(['bb', 'test'])
    const order: string[] = []
    bus.register('creator', 'session.beforeCreate', noting(order, 'creator'))
    const seen: string[] = []
    yield* bus.run(SEND, prompt('x'), recording(seen))
    assert.deepStrictEqual([order, seen], [[], ['x']])
  }),
)

it.effect('does not run the rest of the chain again when a hook fails after passing on', () =>
  Effect.gen(function* runsRestOnce() {
    const bus = new HookBus(['bb', 'test'])
    bus.register('late', SEND, async (input, proceed) => {
      await proceed(input)
      throw new Error('too late')
    })
    const seen: string[] = []
    const result = yield* bus.run(SEND, prompt('x'), recording(seen))
    assert.deepStrictEqual(seen, ['x'])
    assert.strictEqual(result.input.text, 'x')
  }),
)

it.effect('does not run a terminal again that has failed while a hook waited for it', () =>
  Effect.gen(function* runsFailingTerminalOnce() {
    const bus = new HookBus(['bb', 'test'])
    bus.register('a', SEND, passOn)
    const calls: string[] = []
    const failing = (): Effect.Effect<PromptSendInput> =>
      Effect.sync(() => {
        calls.push('terminal')
        throw new Error('terminal failed')
      })
    const exit = yield* Effect.exit(bus.run(SEND, prompt('x'), failing))
    assert.isTrue(Exit.isFailure(exit))
    assert.deepStrictEqual(calls, ['terminal'])
  }),
)

it.effect('passes a terminal defect through the hooks that passed on without blaming them', () =>
  Effect.gen(function* passesDefectOn() {
    const records = yield* warnings
    const bus = new HookBus(['bb', 'test'])
    bus.register('a', SEND, passOn)
    bus.register('b', SEND, passOn)
    const exit = yield* Effect.exit(
      bus.run(SEND, prompt('x'), () => Effect.die(new Error('terminal died'))),
    )
    assert.isTrue(Exit.hasDies(exit))
    assert.deepStrictEqual(records, [])
  }),
)
