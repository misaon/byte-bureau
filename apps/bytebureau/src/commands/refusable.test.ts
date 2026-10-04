import { ApiError } from '@bytebureau/client'
import {
  AskError,
  ConfigError,
  ProviderError,
  SessionError,
  StoreError,
  WorkspaceError,
} from '@bytebureau/kernel'
import { describe, expect, it } from 'vitest'
import type { Bureau } from '../bureau/bureau.js'
import { createContext, type Context } from '../context.js'
import { projectsStub, refusingStub } from '../testing/health-stub.js'
import { problemError } from '../testing/records.js'
import { captureConsole, contextOf, keepExitCode, rejecting } from '../testing/scripted-kernel.js'
import { testHome, tokenFile } from '../testing/temp-repo.js'
import { refusable, withBureauRefusable } from './refusable.js'

const succeeding = async (): Promise<string> => {
  await Promise.resolve()
  return 'done'
}

describe(refusable, () => {
  it('gives the result of the work and says nothing when it succeeds', async () => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    await expect(refusable(contextOf(), succeeding)).resolves.toBe('done')
    expect([printed.out(), printed.err(), process.exitCode]).toStrictEqual([[], [], undefined])
  })

  it.each([
    [404, 'session_not_found', 'session s1 is not running'],
    [409, 'session_invalid_transition', 'cannot stop a completed session'],
    [422, 'ask_invalid_answer', 'ask a1 has no option nope'],
  ])('tells the detail of a %d problem and ends with exit code 1', async (status, code, detail) => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    const work = rejecting(problemError(status, code, detail))
    await expect(refusable(contextOf(), work)).resolves.toBeUndefined()
    expect([printed.err(), printed.out(), process.exitCode]).toStrictEqual([[detail], [], 1])
  })

  it('tells the refusal as a JSON record on stderr when the output is machine-readable', async () => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    await refusable(contextOf(true), rejecting(problemError(409, 'x', 'it is taken')))
    expect(printed.err()).toStrictEqual([JSON.stringify({ level: 'warn', message: 'it is taken' })])
  })
})

describe('refusable and the kernel in the process of the command', () => {
  it.each([
    [
      'a session',
      new SessionError({ code: 'invalid_transition', reason: 'cannot prompt a completed session' }),
    ],
    ['an ask', new AskError({ code: 'not_pending', reason: 'ask a1 is answered' })],
    [
      'a provider that is missing',
      new ProviderError({
        kind: 'missing',
        reason: 'provider "claude" is not available; available: fake',
        retryable: false,
      }),
    ],
    [
      'a workspace',
      new WorkspaceError({ code: 'has_sessions', reason: 'project repo still has 1 session' }),
    ],
  ])(
    'tells the reason of the kernel refusing %s, and ends with exit code 1',
    async (_what, refusal) => {
      expect.hasAssertions()
      keepExitCode()
      const printed = captureConsole()
      await expect(refusable(contextOf(), rejecting(refusal))).resolves.toBeUndefined()
      expect([printed.err(), process.exitCode]).toStrictEqual([[refusal.reason], 1])
    },
  )
})

describe('refusable and what the kernel says in its own way', () => {
  it('tells an invalid configuration as the daemon does: the file and the pointer, then the reason', async () => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    const invalid = new ConfigError({
      file: 'bytebureau.json',
      pointer: '/employees/developer',
      reason: 'provider is required',
    })
    await expect(refusable(contextOf(), rejecting(invalid))).resolves.toBeUndefined()
    expect(printed.err()).toStrictEqual([
      'bytebureau.json/employees/developer: provider is required',
    ])
    expect(process.exitCode).toBe(1)
  })

  it('tells a reason that spans lines as one line', async () => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    const git = new WorkspaceError({
      code: 'git_failed',
      reason: 'git failed\nhint: commit first\n',
    })
    await refusable(contextOf(), rejecting(git))
    expect(printed.err()).toStrictEqual(['git failed; hint: commit first'])
  })
})

describe('refusable and the failures that are no refusal', () => {
  it.each([
    [
      'a problem of the daemon that is its own failure',
      problemError(500, 'internal', 'unexpected'),
    ],
    ['a provider that failed behind the daemon', problemError(502, 'provider_crash', 'it exited')],
    ['a daemon that cannot be reached', new ApiError(0, undefined, 'http://127.0.0.1:9/api/v1/x')],
    [
      'an answer that is no problem',
      new ApiError(404, undefined, 'http://127.0.0.1:4747/api/v1/x'),
    ],
    [
      'a provider that crashed',
      new ProviderError({ kind: 'crash', reason: 'it', retryable: true }),
    ],
    [
      'a provider that is not logged in',
      new ProviderError({ kind: 'auth', reason: 'it', retryable: false }),
    ],
    ['the store of the kernel', new StoreError({ cause: new Error('disk full') })],
    ['any other error', new Error('boom')],
  ])('passes %s on and leaves the exit code alone', async (_what, failure) => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    await expect(refusable(contextOf(), rejecting(failure))).rejects.toBe(failure)
    expect([printed.err(), process.exitCode]).toStrictEqual([[], undefined])
  })
})

// The context of a command on the home: never the home of the person who runs the tests
const contextIn = (home: string): Context =>
  createContext({ json: false, color: false, yes: false }, { BYTEBUREAU_HOME: home }, false)

const projectsOf = async (bureau: Bureau): Promise<unknown> => {
  const projects = await bureau.projects.list()
  return projects
}

describe(withBureauRefusable, () => {
  it('opens the Bureau of the flags for the work, and gives what the work gives', async () => {
    expect.hasAssertions()
    const stub = await projectsStub()
    const flags = { daemon: true, host: '127.0.0.1', port: stub.port, tokenFile: tokenFile() }
    const context = contextIn(testHome())
    await expect(withBureauRefusable(context, flags, projectsOf)).resolves.toStrictEqual([])
  })

  it('tells the problem the daemon refuses the request of the work with, and ends with exit code 1', async () => {
    expect.hasAssertions()
    keepExitCode()
    const port = await refusingStub(409, 'project_locked', 'the project is locked')
    const printed = captureConsole()
    const flags = { daemon: true, host: '127.0.0.1', port, tokenFile: tokenFile() }
    const result = await withBureauRefusable(contextIn(testHome()), flags, projectsOf)
    expect([result, printed.err(), process.exitCode]).toStrictEqual([
      undefined,
      ['the project is locked'],
      1,
    ])
  })

  it('tells a daemon named on the command line that refuses the token where its token goes', async () => {
    expect.hasAssertions()
    keepExitCode()
    const port = await refusingStub(401, 'unauthorized', 'a valid API token is required')
    const printed = captureConsole()
    const flags = { daemon: true, host: '127.0.0.1', port, tokenFile: tokenFile('wrong') }
    await withBureauRefusable(contextIn(testHome()), flags, projectsOf)
    const hint = 'a valid API token is required (pass the token of that daemon with --token-file)'
    expect([printed.err(), process.exitCode]).toStrictEqual([[hint], 1])
  })
})
