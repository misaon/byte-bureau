import {
  AskError,
  ConfigError,
  PluginError,
  ProfileError,
  ProviderError,
  SessionError,
  StoreError,
  WorkspaceError,
} from '@bytebureau/kernel'
import { Effect, Logger, References } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  KERNEL_STATUSES,
  orProblem,
  problem,
  toProblem,
  type ApiProblem,
  type KernelStatus,
  type PROBLEM_SCHEMAS,
} from './problems.js'

const NO_SESSION = 'no session 42'
const API_KEY = `sk-ant-api03-${'abcdefghij'.repeat(4)}`

// The typed errors of the kernel with the status, the code and the detail each is told with
const KERNEL_FAILURES: {
  readonly failure: unknown
  readonly status: number
  readonly code: string
  readonly detail: string
}[] = [
  {
    failure: new SessionError({ code: 'not_found', reason: NO_SESSION }),
    status: 404,
    code: 'session_not_found',
    detail: NO_SESSION,
  },
  {
    failure: new SessionError({ code: 'invalid_transition', reason: 'x' }),
    status: 409,
    code: 'session_invalid_transition',
    detail: 'x',
  },
  {
    failure: new SessionError({ code: 'provider_missing', reason: 'x' }),
    status: 422,
    code: 'session_provider_missing',
    detail: 'x',
  },
  {
    failure: new SessionError({ code: 'yolo_refused', reason: 'x' }),
    status: 403,
    code: 'session_yolo_refused',
    detail: 'x',
  },
  {
    failure: new AskError({ code: 'not_pending', reason: 'x' }),
    status: 409,
    code: 'ask_not_pending',
    detail: 'x',
  },
  {
    failure: new AskError({ code: 'invalid_answer', reason: 'x' }),
    status: 422,
    code: 'ask_invalid_answer',
    detail: 'x',
  },
  {
    failure: new ProviderError({
      kind: 'auth',
      reason: `${API_KEY} was refused`,
      retryable: false,
    }),
    status: 502,
    code: 'provider_auth',
    detail: '[REDACTED] was refused',
  },
  {
    failure: new ProviderError({ kind: 'missing', reason: 'x', retryable: false }),
    status: 422,
    code: 'provider_missing',
    detail: 'x',
  },
  {
    failure: new ProfileError({ code: 'not_found', reason: 'no profile "fake/nope"' }),
    status: 404,
    code: 'profile_not_found',
    detail: 'no profile "fake/nope"',
  },
  {
    failure: new ProfileError({ code: 'exists', reason: 'x' }),
    status: 409,
    code: 'profile_exists',
    detail: 'x',
  },
  {
    failure: new ProfileError({ code: 'in_use', reason: 'x' }),
    status: 409,
    code: 'profile_in_use',
    detail: 'x',
  },
  {
    failure: new ProfileError({ code: 'invalid', reason: 'a login profile takes no key' }),
    status: 422,
    code: 'profile_invalid',
    detail: 'a login profile takes no key',
  },
  {
    failure: new WorkspaceError({ code: 'dirty', reason: 'x' }),
    status: 409,
    code: 'workspace_dirty',
    detail: 'x',
  },
  {
    failure: new WorkspaceError({ code: 'locked', reason: 'x' }),
    status: 409,
    code: 'workspace_locked',
    detail: 'x',
  },
  {
    failure: new WorkspaceError({ code: 'has_sessions', reason: 'x' }),
    status: 409,
    code: 'workspace_has_sessions',
    detail: 'x',
  },
  {
    failure: new WorkspaceError({ code: 'not_a_repository', reason: 'x' }),
    status: 422,
    code: 'workspace_not_a_repository',
    detail: 'x',
  },
  {
    failure: new WorkspaceError({ code: 'not_found', reason: 'no project p' }),
    status: 404,
    code: 'workspace_not_found',
    detail: 'no project p',
  },
  {
    failure: new WorkspaceError({ code: 'git_failed', reason: 'x' }),
    status: 502,
    code: 'workspace_git_failed',
    detail: 'x',
  },
  {
    failure: new WorkspaceError({ code: 'fs_failed', reason: 'x' }),
    status: 500,
    code: 'workspace_fs_failed',
    detail: 'x',
  },
  {
    failure: new WorkspaceError({ code: 'constructor', reason: 'x' }),
    status: 422,
    code: 'workspace_constructor',
    detail: 'x',
  },
  {
    failure: new ConfigError({ file: '/p/bytebureau.json', pointer: '/version', reason: 'bad' }),
    status: 422,
    code: 'config_invalid',
    detail: '/p/bytebureau.json/version: bad',
  },
  // The issues of a file name their places themselves: the first is not named twice
  {
    failure: new ConfigError({
      file: '/p/bytebureau.json',
      pointer: '/version',
      reason: '/p/bytebureau.json/version: expected 1; /p/bytebureau.json/project: missing',
    }),
    status: 422,
    code: 'config_invalid',
    detail: '/p/bytebureau.json/version: expected 1; /p/bytebureau.json/project: missing',
  },
  {
    failure: new PluginError({ plugin: 'p', reason: 'x' }),
    status: 500,
    code: 'plugin_failed',
    detail: 'p: x',
  },
  // The cause of a store failure (here "disk full") is logged, never told
  {
    failure: new StoreError({ cause: new Error('disk full') }),
    status: 503,
    code: 'store_unavailable',
    detail: 'the store is unavailable',
  },
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

  it.each(KERNEL_FAILURES)('maps $failure to $status $code', ({ failure, ...told }) => {
    expect(toProblem(failure)).toMatchObject(told)
  })

  it('tells the reason of a refused profile with any run of text shaped like a key hidden', () => {
    const reason = `${API_KEY} is no key of the provider`
    expect(toProblem(new ProfileError({ code: 'invalid', reason }))).toMatchObject({
      status: 422,
      code: 'profile_invalid',
      detail: '[REDACTED] is no key of the provider',
    })
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

  it('tells a kernel failure only with a status the endpoints that call the kernel declare', () => {
    // Typed on purpose: a handler's failure must fit the error schemas of PROBLEM_SCHEMAS, or tsc refuses the handler
    const told: ApiProblem<KernelStatus> = toProblem(new StoreError({ cause: 'x' }))
    const declared: (typeof PROBLEM_SCHEMAS)[number]['Type'] = told
    expect(KERNEL_STATUSES).toContain(declared.status)
  })
})

interface LogLine {
  readonly level: string
  readonly message: unknown
  readonly category: unknown
}

// The problem a kernel call that fails so is answered with; the lines logged meanwhile are collected
const problemOf = (failure: unknown, logged: LogLine[]): unknown => {
  const logger = Logger.make((options) => {
    const annotations = options.fiber.getRef(References.CurrentLogAnnotations)
    logged.push({
      level: options.logLevel,
      message: options.message,
      category: annotations['category'],
    })
  })
  const call = Effect.flip(orProblem(Effect.fail(failure)))
  return Effect.runSync(Effect.provide(call, Logger.layer([logger])))
}

describe(orProblem, () => {
  it('turns the failure of a kernel call into its problem and logs under bb.api what it does not tell', () => {
    const logged: LogLine[] = []
    const typed = new AskError({ code: 'not_pending', reason: 'answered already' })
    expect(problemOf(typed, logged)).toMatchObject({ status: 409, code: 'ask_not_pending' })
    expect(logged).toStrictEqual([])
    const full = new Error('disk full')
    const store = problemOf(new StoreError({ cause: full }), logged)
    expect(store).toMatchObject({ status: 503, code: 'store_unavailable' })
    const unexpected = new Error('ENOENT /etc/secret')
    expect(problemOf(unexpected, logged)).toMatchObject({ status: 500, code: 'internal' })
    expect(logged).toStrictEqual([
      { level: 'Warn', message: ['the store failed under an API call', full], category: 'bb.api' },
      {
        level: 'Error',
        message: ['unexpected failure in an API handler', unexpected],
        category: 'bb.api',
      },
    ])
  })
})
