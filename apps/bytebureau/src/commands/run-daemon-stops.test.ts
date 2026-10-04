import { describe, expect, it } from 'vitest'
import { jsonLines } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import { untilStatus, waitingRun } from '../testing/session-bench.js'

// The last line a command printed
function lastLine(stdout: string): string | undefined {
  return stdout.trim().split('\n').at(-1)
}

describe('bytebureau run when another command interrupts its turn', () => {
  it('ends with exit code 3 and the line that the turn was interrupted, and the session is ready', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun([])
    const { env, sessionId } = waiting
    const interrupted = await runCli(['sessions', 'interrupt', sessionId], env)
    const run = await waiting.run
    const shown = await untilStatus({ env, id: sessionId }, 'ready')
    expect([interrupted.code, interrupted.stdout.trim()]).toStrictEqual([
      0,
      `interrupt: ${sessionId}`,
    ])
    expect([run.code, lastLine(run.stdout)]).toStrictEqual([3, 'Turn interrupted'])
    expect(shown.stdout).toMatch(/^status\s+ready$/mu)
    await waiting.daemon.stop()
  })

  it('leaves the session ready in the listing as well, for another prompt', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun([])
    const { env, sessionId } = waiting
    await runCli(['sessions', 'interrupt', sessionId], env)
    await waiting.run
    await untilStatus({ env, id: sessionId }, 'ready')
    const listed = await runCli(['sessions', 'ls'], env)
    expect(listed.stdout.trim().split('  ').slice(0, 2)).toStrictEqual([sessionId, 'ready'])
    await waiting.daemon.stop()
  })
})

describe('bytebureau run when another command stops its session', () => {
  it('ends with exit code 3 and the line that the session was stopped', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun([])
    const { env, sessionId } = waiting
    const stopped = await runCli(['sessions', 'stop', sessionId], env)
    const run = await waiting.run
    expect([stopped.code, stopped.stdout.trim()]).toStrictEqual([0, `stop: ${sessionId}`])
    expect([run.code, lastLine(run.stdout)]).toStrictEqual([3, 'Session stopped'])
    await waiting.daemon.stop()
  })

  it('ends with the stop in its events as well, as JSON lines', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    await runCli(['sessions', 'stop', waiting.sessionId], waiting.env)
    const run = await waiting.run
    const types = jsonLines(run.stdout).map((record) => record['type'])
    expect(run.code).toBe(3)
    expect(types.slice(-3)).toStrictEqual(['turn.interrupted', 'ask.cancelled', 'session.stopped'])
    await waiting.daemon.stop()
  })
})
