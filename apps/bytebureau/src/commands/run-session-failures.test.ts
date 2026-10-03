import { ProviderError, SessionError, WorkspaceError } from '@bytebureau/kernel'
import { describe, expect, it } from 'vitest'
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
    const { kernel, calls } = scripted([COMPLETED])
    await expect(runSession(kernel, { ...OPTIONS, provider: 'nope' }, contextOf())).resolves.toBe(4)
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
    const { kernel } = scripted([COMPLETED], { create: rejecting(refusal) })
    await expect(runSession(kernel, OPTIONS, contextOf())).resolves.toBe(4)
    expect(printed.err()).toStrictEqual([
      'SessionError: provider "claude" is not available; available: fake (provider_missing)',
    ])
  })

  it('exits 4 when the provider cannot be started', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const crash = new ProviderError({ kind: 'crash', reason: 'claude exited', retryable: true })
    const { kernel } = scripted([COMPLETED], { prompt: rejecting(crash) })
    await expect(runSession(kernel, OPTIONS, contextOf())).resolves.toBe(4)
    expect(printed.err()).toStrictEqual(['ProviderError: claude exited (crash)'])
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
  const { kernel, calls } = scripted([COMPLETED], {
    register: rejecting(new WorkspaceError({ code, reason })),
  })
  const exit = await runSession(kernel, OPTIONS, contextOf())
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
    const { kernel } = scripted([COMPLETED], { create: rejecting(failed) })
    await expect(runSession(kernel, OPTIONS, contextOf())).resolves.toBe(4)
    expect(printed.err()).toStrictEqual([
      'WorkspaceError: git worktree add failed (128): fatal: invalid reference: main; hint: commit first (git_failed)',
    ])
  })

  it('passes any other failure on', async () => {
    expect.hasAssertions()
    captureConsole()
    const gone = new SessionError({ code: 'not_found', reason: 'project p1 is not registered' })
    const { kernel } = scripted([COMPLETED], { create: rejecting(gone) })
    await expect(runSession(kernel, OPTIONS, contextOf())).rejects.toBe(gone)
  })
})

type Interrupt = (signal: 'SIGINT') => void

// The listeners a run put on SIGINT: those that were there before it are not its own
function addedSince(before: ReadonlySet<unknown>): readonly Interrupt[] {
  return process.listeners('SIGINT').filter((listener) => !before.has(listener))
}

function sendCtrlC(before: ReadonlySet<unknown>): void {
  for (const interrupt of addedSince(before)) {
    interrupt('SIGINT')
  }
}

interface Interrupted {
  readonly code: number
  readonly calls: readonly string[]
  readonly listeners: number
}

// A run whose events wait at a gate: it is sent Ctrl-C once it has prompted, and then the gate opens
async function interruptedRun(stop?: Overrides['stop']): Promise<Interrupted> {
  const gate = latch()
  const prompted = latch()
  const before = new Set(process.listeners('SIGINT'))
  const { kernel, calls } = scripted([STOPPED], {
    gate: gate.opened,
    ...(stop === undefined ? {} : { stop }),
    prompt: async () => {
      await Promise.resolve()
      prompted.open()
    },
  })
  const run = runSession(kernel, OPTIONS, contextOf())
  await prompted.opened
  sendCtrlC(before)
  gate.open()
  const code = await run
  return { code, calls, listeners: addedSince(before).length }
}

describe('runSession and Ctrl-C', () => {
  it('stops the session when SIGINT comes, and the run ends as a stopped one does', async () => {
    expect.hasAssertions()
    captureConsole()
    const { code, calls } = await interruptedRun()
    expect(code).toBe(3)
    expect(calls).toContain('stop s1')
  })

  it('listens no more once the run is over', async () => {
    expect.hasAssertions()
    captureConsole()
    const { listeners } = await interruptedRun()
    expect(listeners).toBe(0)
  })

  it('reports a stop that fails and keeps following the session', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { code } = await interruptedRun(rejecting(new Error('the store is locked')))
    expect(code).toBe(3)
    expect(printed.err()).toStrictEqual(['the store is locked'])
  })

  it('listens no more once the run has failed', async () => {
    expect.hasAssertions()
    captureConsole()
    const before = new Set(process.listeners('SIGINT'))
    const { kernel } = scripted([COMPLETED], {
      prompt: rejecting(new Error('the prompt was lost')),
    })
    await expect(runSession(kernel, OPTIONS, contextOf())).rejects.toThrow('the prompt was lost')
    expect(addedSince(before)).toHaveLength(0)
  })
})
