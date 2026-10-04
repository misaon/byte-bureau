import {
  AskError,
  ConfigError,
  PluginError,
  ProviderError,
  SessionError,
  StoreError,
  WorkspaceError,
} from '@bytebureau/kernel'
import { Effect, Logger } from 'effect'
import { describe, expect, it } from 'vitest'
import { orProblem, problem, toProblem } from './problems.js'

const NO_SESSION = 'no session 42'

// The typed errors of the kernel with the status and the code each is told as
const KERNEL_FAILURES: [unknown, number, string][] = [
  [new SessionError({ code: 'not_found', reason: NO_SESSION }), 404, 'session_not_found'],
  [
    new SessionError({ code: 'invalid_transition', reason: 'x' }),
    409,
    'session_invalid_transition',
  ],
  [new SessionError({ code: 'provider_missing', reason: 'x' }), 422, 'session_provider_missing'],
  [new SessionError({ code: 'yolo_refused', reason: 'x' }), 403, 'session_yolo_refused'],
  [new AskError({ code: 'not_pending', reason: 'x' }), 409, 'ask_not_pending'],
  [new AskError({ code: 'invalid_answer', reason: 'x' }), 422, 'ask_invalid_answer'],
  [new ProviderError({ kind: 'auth', reason: 'x', retryable: false }), 502, 'provider_auth'],
  [new ProviderError({ kind: 'missing', reason: 'x', retryable: false }), 422, 'provider_missing'],
  [new WorkspaceError({ code: 'dirty', reason: 'x' }), 409, 'workspace_dirty'],
  [new WorkspaceError({ code: 'has_sessions', reason: 'x' }), 409, 'workspace_has_sessions'],
  [
    new WorkspaceError({ code: 'not_a_repository', reason: 'x' }),
    422,
    'workspace_not_a_repository',
  ],
  [
    new ConfigError({ file: '/p/bytebureau.json', pointer: '/version', reason: 'bad' }),
    422,
    'config_invalid',
  ],
  [new PluginError({ plugin: 'p', reason: 'x' }), 500, 'plugin_failed'],
  [new StoreError({ cause: new Error('disk full') }), 503, 'store_unavailable'],
]

describe('problem details of the API', () => {
  it('builds a problem whose type names its code and whose title names its status', () => {
    expect(problem(404, 'session_not_found', NO_SESSION)).toStrictEqual({
      type: 'https://bytebureau.dev/problems/session_not_found',
      title: 'Not Found',
      status: 404,
      detail: NO_SESSION,
      code: 'session_not_found',
    })
  })

  it.each(KERNEL_FAILURES)('maps %s to %i %s', (failure, status, code) => {
    expect(toProblem(failure)).toMatchObject({ status, code })
  })

  it('keeps the reason of a typed error as the detail, and the file pointer of a config error', () => {
    expect(toProblem(new SessionError({ code: 'not_found', reason: NO_SESSION })).detail).toBe(
      NO_SESSION,
    )
    expect(
      toProblem(new ConfigError({ file: '/p/bytebureau.json', pointer: '/version', reason: 'bad' }))
        .detail,
    ).toBe('/p/bytebureau.json/version: bad')
  })

  it('tells nothing of an unknown failure beyond that it was unexpected', () => {
    expect(toProblem(new Error('ENOENT /etc/secret'))).toStrictEqual({
      type: 'https://bytebureau.dev/problems/internal',
      title: 'Internal Server Error',
      status: 500,
      detail: 'unexpected failure',
      code: 'internal',
    })
  })
})

// The problem a kernel call that fails so is answered with; the logger collects what is logged meanwhile
const problemOf = (failure: unknown, logged: unknown[]): unknown => {
  const logger = Logger.make((options) => {
    logged.push(options.message)
  })
  const call = Effect.flip(orProblem(Effect.fail(failure)))
  return Effect.runSync(Effect.provide(call, Logger.layer([logger])))
}

describe(orProblem, () => {
  it('turns the failure of a kernel call into its problem and logs only an unexpected one', () => {
    const logged: unknown[] = []
    const typed = new AskError({ code: 'not_pending', reason: 'answered already' })
    expect(problemOf(typed, logged)).toMatchObject({ status: 409, code: 'ask_not_pending' })
    expect(logged).toStrictEqual([])
    const unexpected = new Error('ENOENT /etc/secret')
    expect(problemOf(unexpected, logged)).toMatchObject({
      status: 500,
      detail: 'unexpected failure',
    })
    expect(logged).toStrictEqual([['unexpected failure in an API handler', unexpected]])
  })
})
