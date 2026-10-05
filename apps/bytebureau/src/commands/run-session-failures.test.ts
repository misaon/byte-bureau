import { setTimeout as sleep } from 'node:timers/promises'
import { ApiError } from '@bytebureau/client'
import { ProfileError, ProviderError, SessionError, WorkspaceError } from '@bytebureau/kernel'
import { describe, expect, it } from 'vitest'
import { problemError, TURN } from '../testing/records.js'
import {
  captureConsole,
  COMPLETED,
  contextOf,
  latch,
  OPTIONS,
  rejecting,
  scripted,
  STOPPED,
  type Overrides,
} from '../testing/scripted-kernel.js'
import { runSession } from './run-session.js'

describe('runSession when the provider is missing or fails', () => {
  it('exits 4 before registering anything when the named provider is unknown', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau, calls } = scripted([COMPLETED])
    await expect(runSession(bureau, { ...OPTIONS, provider: 'nope' }, contextOf())).resolves.toBe(4)
    expect(calls).toStrictEqual([])
    expect(printed.err()).toStrictEqual(['Provider "nope" is not available. Available: fake'])
  })

  it('exits 4 when the kernel refuses the provider of the employee', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const refusal = new SessionError({
      code: 'provider_missing',
      reason: 'provider "claude" is not available; available: fake',
    })
    const { bureau } = scripted([COMPLETED], { create: rejecting(refusal) })
    await expect(runSession(bureau, OPTIONS, contextOf())).resolves.toBe(4)
    expect(printed.err()).toStrictEqual([
      'SessionError: provider "claude" is not available; available: fake (provider_missing)',
    ])
  })

  it('exits 4 when the provider cannot be started', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const crash = new ProviderError({ kind: 'crash', reason: 'claude exited', retryable: true })
    const { bureau } = scripted([COMPLETED], { prompt: rejecting(crash) })
    await expect(runSession(bureau, OPTIONS, contextOf())).resolves.toBe(4)
    expect(printed.err()).toStrictEqual(['ProviderError: claude exited (crash)'])
  })
})

describe('runSession when the profile is refused', () => {
  it('exits 4 with the reason when the kernel or the daemon knows no such profile', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const missing = new ProfileError({ code: 'not_found', reason: 'no profile "fake/nope"' })
    const gone = problemError(404, 'profile_not_found', 'no profile "fake/nope"')
    const local = scripted([COMPLETED], { create: rejecting(missing) })
    const remote = scripted([COMPLETED], { create: rejecting(gone) })
    await expect(runSession(local.bureau, OPTIONS, contextOf())).resolves.toBe(4)
    await expect(runSession(remote.bureau, OPTIONS, contextOf())).resolves.toBe(4)
    expect(printed.err()).toStrictEqual([
      'ProfileError: no profile "fake/nope" (not_found)',
      'no profile "fake/nope" (profile_not_found)',
    ])
  })
})

interface Refused {
  readonly exit: number
  readonly calls: readonly string[]
  readonly printed: readonly string[]
}

// A run whose project the kernel refuses to register
async function refusedProject(code: string, reason: string): Promise<Refused> {
  const printed = captureConsole()
  const { bureau, calls } = scripted([COMPLETED], {
    register: rejecting(new WorkspaceError({ code, reason })),
  })
  const exit = await runSession(bureau, OPTIONS, contextOf())
  return { exit, calls, printed: printed.err() }
}

describe('runSession when the project is refused', () => {
  it('exits 4 with a one-line reason when the project is no repository', async () => {
    expect.hasAssertions()
    const { exit, calls, printed } = await refusedProject(
      'not_a_repository',
      '/x is not inside a git repository',
    )
    expect(exit).toBe(4)
    expect(calls).toStrictEqual([])
    expect(printed).toStrictEqual([
      'WorkspaceError: /x is not inside a git repository (not_a_repository)',
    ])
  })

  it('exits 4 with a one-line reason when the project is a worktree of a session', async () => {
    expect.hasAssertions()
    const { exit, printed } = await refusedProject(
      'is_bytebureau_worktree',
      '/y is a ByteBureau session worktree',
    )
    expect(exit).toBe(4)
    expect(printed).toStrictEqual([
      'WorkspaceError: /y is a ByteBureau session worktree (is_bytebureau_worktree)',
    ])
  })

  it('exits 4 with a one-line reason when the worktree cannot be provisioned', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const reason =
      'git worktree add failed (128): fatal: invalid reference: main\nhint: commit first'
    const failed = new WorkspaceError({ code: 'git_failed', reason })
    const { bureau } = scripted([COMPLETED], { create: rejecting(failed) })
    await expect(runSession(bureau, OPTIONS, contextOf())).resolves.toBe(4)
    expect(printed.err()).toStrictEqual([
      'WorkspaceError: git worktree add failed (128): fatal: invalid reference: main; hint: commit first (git_failed)',
    ])
  })

  it('passes any other failure on', async () => {
    expect.hasAssertions()
    captureConsole()
    const gone = new SessionError({ code: 'not_found', reason: 'project p1 is not registered' })
    const { bureau } = scripted([COMPLETED], { create: rejecting(gone) })
    await expect(runSession(bureau, OPTIONS, contextOf())).rejects.toBe(gone)
  })
})

describe('runSession when the daemon says no', () => {
  it('exits 4 with the detail and the code of a problem the kernel would have refused with', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const refusal = problemError(
      422,
      'workspace_not_a_repository',
      '/x is not inside a git repository',
    )
    const { bureau, calls } = scripted([COMPLETED], { register: rejecting(refusal) })
    await expect(runSession(bureau, OPTIONS, contextOf())).resolves.toBe(4)
    expect(calls).toStrictEqual([])
    expect(printed.err()).toStrictEqual([
      '/x is not inside a git repository (workspace_not_a_repository)',
    ])
  })

  it('passes any other problem on, and a daemon that cannot be reached', async () => {
    expect.hasAssertions()
    captureConsole()
    const gone = problemError(404, 'project_not_found', 'no project p1')
    const unreachable = new ApiError(0, undefined, 'http://127.0.0.1:9/api/v1/sessions')
    const first = scripted([COMPLETED], { create: rejecting(gone) })
    const second = scripted([COMPLETED], { register: rejecting(unreachable) })
    await expect(runSession(first.bureau, OPTIONS, contextOf())).rejects.toBe(gone)
    await expect(runSession(second.bureau, OPTIONS, contextOf())).rejects.toBe(unreachable)
  })
})

type StopSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP'

const STOP_SIGNALS: readonly StopSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

type Listener = (signal: StopSignal) => void

// The listeners of the stop signals before a run, which are not its own
function listenersNow(): ReadonlySet<unknown> {
  return new Set(STOP_SIGNALS.flatMap((signal) => process.listeners(signal)))
}

function addedSince(before: ReadonlySet<unknown>, signal: StopSignal): readonly Listener[] {
  return process.listeners(signal).filter((listener) => !before.has(listener))
}

// How many listeners the run has left on the stop signals
function listening(before: ReadonlySet<unknown>): number {
  return STOP_SIGNALS.reduce((count, signal) => count + addedSince(before, signal).length, 0)
}

// The signals, one after the other, to the listeners the run put on them
function send(signals: readonly StopSignal[], before: ReadonlySet<unknown>): void {
  for (const signal of signals) {
    for (const listener of addedSince(before, signal)) {
      listener(signal)
    }
  }
}

interface Interrupted {
  readonly code: number
  readonly calls: readonly string[]
  readonly listeners: number
}

// A run whose events wait at a gate: it is sent the signals once it has prompted, and then the gate opens
async function interruptedRun(
  signals: readonly StopSignal[],
  stop?: Overrides['stop'],
): Promise<Interrupted> {
  const gate = latch()
  const prompted = latch()
  const before = listenersNow()
  const { bureau, calls } = scripted([STOPPED], {
    gate: gate.opened,
    ...(stop === undefined ? {} : { stop }),
    prompt: async () => {
      await Promise.resolve()
      prompted.open()
      return TURN
    },
  })
  const run = runSession(bureau, OPTIONS, contextOf())
  await prompted.opened
  send(signals, before)
  gate.open()
  const code = await run
  return { code, calls, listeners: listening(before) }
}

describe('runSession and the signals that stop it', () => {
  it.each(STOP_SIGNALS)(
    'stops the session when %s comes, and the run ends as a stopped one does',
    async (signal) => {
      expect.hasAssertions()
      captureConsole()
      const { code, calls } = await interruptedRun([signal])
      const stops = calls.filter((call) => call.startsWith('stop'))
      expect([code, stops]).toStrictEqual([3, ['stop s1']])
    },
  )

  it('listens to none of them once the run is over', async () => {
    expect.hasAssertions()
    captureConsole()
    const { listeners } = await interruptedRun(['SIGINT'])
    expect(listeners).toBe(0)
  })

  it('reports a stop that fails and keeps following the session', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { code } = await interruptedRun(['SIGTERM'], rejecting(new Error('the store is locked')))
    expect(code).toBe(3)
    expect(printed.err()).toStrictEqual(['the store is locked'])
  })

  it('listens to none of them once the run has failed', async () => {
    expect.hasAssertions()
    captureConsole()
    const before = listenersNow()
    const { bureau } = scripted([COMPLETED], {
      prompt: rejecting(new Error('the prompt was lost')),
    })
    await expect(runSession(bureau, OPTIONS, contextOf())).rejects.toThrow('the prompt was lost')
    expect(listening(before)).toBe(0)
  })
})

describe('runSession and a second signal', () => {
  it('stops once, for the first signal: one of another kind after it does nothing, and the run waits for that stop', async () => {
    expect.hasAssertions()
    captureConsole()
    const order: string[] = []
    const slowStop = async (): Promise<void> => {
      order.push('stop')
      await sleep(20)
      order.push('stopped')
    }
    await interruptedRun(['SIGINT', 'SIGHUP'], slowStop)
    order.push('run ended')
    expect(order).toStrictEqual(['stop', 'stopped', 'run ended'])
  })
})
