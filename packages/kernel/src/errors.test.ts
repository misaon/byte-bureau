import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { describe, expect, it as test } from 'vitest'
import {
  AskError,
  ConfigError,
  configErrorLine,
  PluginError,
  ProviderError,
  SessionError,
  StoreError,
  WorkspaceError,
} from './errors.js'

const config = new ConfigError({ file: '/repo/bytebureau.json', pointer: '/x', reason: 'bad x' })
const store = new StoreError({ cause: new Error('disk full') })
const workspace = new WorkspaceError({ code: 'dirty', reason: 'uncommitted changes' })
const provider = new ProviderError({ kind: 'auth', reason: 'not logged in', retryable: false })
const ask = new AskError({ code: 'not_found', reason: 'no such ask' })
const plugin = new PluginError({ plugin: 'demo', reason: 'setup failed' })
const session = new SessionError({ code: 'not_found', reason: 'no such session' })

describe('the tagged errors of the kernel', () => {
  test.each([
    { name: 'ConfigError', error: config, type: ConfigError, message: 'bad x' },
    { name: 'StoreError', error: store, type: StoreError, message: 'disk full' },
    {
      name: 'WorkspaceError',
      error: workspace,
      type: WorkspaceError,
      message: 'uncommitted changes',
    },
    { name: 'ProviderError', error: provider, type: ProviderError, message: 'not logged in' },
    { name: 'AskError', error: ask, type: AskError, message: 'no such ask' },
    { name: 'PluginError', error: plugin, type: PluginError, message: 'setup failed' },
    { name: 'SessionError', error: session, type: SessionError, message: 'no such session' },
  ])(
    '$name is an Error of its class whose message is $message',
    ({ name, error, type, message }) => {
      expect(error).toBeInstanceOf(type)
      expect(error).toBeInstanceOf(Error)
      expect([error.name, error.message]).toStrictEqual([name, message])
    },
  )

  test('says why it failed wherever an Error is printed', () => {
    expect(String(config)).toBe('ConfigError: bad x')
    expect(String(session)).toBe('SessionError: no such session')
  })

  test('takes the message of a store failure from its cause, whatever was thrown', () => {
    expect([store.message, new StoreError({ cause: 'the log is full' }).message]).toStrictEqual([
      'disk full',
      'the log is full',
    ])
  })

  test('keeps its fields as they were given', () => {
    expect(config).toMatchObject({ file: '/repo/bytebureau.json', pointer: '/x', reason: 'bad x' })
    expect(provider).toMatchObject({ kind: 'auth', retryable: false })
  })
})

type KernelFailure =
  | ConfigError
  | StoreError
  | WorkspaceError
  | ProviderError
  | AskError
  | PluginError
  | SessionError

// What the handler of its own tag makes of a failure
const handled = (error: KernelFailure): Effect.Effect<string> =>
  Effect.fail(error).pipe(
    Effect.catchTags({
      ConfigError: (failure) => Effect.succeed(failure.file),
      StoreError: () => Effect.succeed('store'),
      WorkspaceError: (failure) => Effect.succeed(failure.code),
      ProviderError: (failure) => Effect.succeed(failure.kind),
      AskError: (failure) => Effect.succeed(failure.code),
      PluginError: (failure) => Effect.succeed(failure.plugin),
      SessionError: (failure) => Effect.succeed(failure.code),
    }),
  )

it.effect('is caught by its tag and by nothing else', () =>
  Effect.gen(function* catchesByTag() {
    const all = [config, store, workspace, provider, ask, plugin, session]
    const each = yield* Effect.all(all.map((error) => handled(error)))
    assert.deepStrictEqual(each, [
      '/repo/bytebureau.json',
      'store',
      'dirty',
      'auth',
      'not_found',
      'demo',
      'not_found',
    ])
    const failing: Effect.Effect<never, WorkspaceError | SessionError> = Effect.fail(workspace)
    const uncaught = yield* Effect.flip(
      failing.pipe(Effect.catchTag('SessionError', () => Effect.succeed('session'))),
    )
    assert.strictEqual(uncaught, workspace)
  }),
)

describe(configErrorLine, () => {
  it('tells where, then why, and a reason that names the place already only once', () => {
    const issues =
      'bytebureau.json/employees/x: provider is required; bytebureau.json/version: expected 1'
    const fromIssues = new ConfigError({
      file: 'bytebureau.json',
      pointer: '/employees/x',
      reason: issues,
    })
    expect([configErrorLine(config), configErrorLine(fromIssues)]).toStrictEqual([
      '/repo/bytebureau.json/x: bad x',
      issues,
    ])
  })
})
