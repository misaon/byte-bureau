import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { freePort, startDaemonProcess, type DaemonProcess } from '../testing/daemon.js'
import { eventLines } from '../testing/json-lines.js'
import { runCli, type CliResult } from '../testing/run-cli.js'
import { PROMPT, workbench } from '../testing/workbench.js'

interface Restarted {
  readonly result: CliResult
  // The daemon that came up in place of the first
  readonly second: DaemonProcess
}

// The first daemon ends while the run waits on the ask; the next one comes up on the same port and stops the session it finds left at work
async function runAcrossRestart(repo: string, home: string): Promise<Restarted> {
  const port = ['--port', String(await freePort())]
  const first = await startDaemonProcess(home, port)
  const ended = once(first.child, 'close')
  const running = runCli(
    ['run', PROMPT, '--project', repo, '--provider', 'fake', '--json'],
    { BYTEBUREAU_HOME: home },
    { signal: 'SIGTERM', afterStdout: '"type":"ask.requested"', target: first.child },
  )
  await ended
  const second = await startDaemonProcess(home, port)
  const result = await running
  return { result, second }
}

describe('bytebureau run across a restart of the daemon', () => {
  it('resumes the events where they stopped and ends as the recovered session says', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const { result, second } = await runAcrossRestart(repo, home)
    const types = eventLines(result.stdout).map((line) => line.type)
    expect([result.code, types.at(-1)]).toStrictEqual([3, 'session.stopped'])
    // Only the recovery of the next daemon cancels the ask: the events after the restart reached the run
    expect(types).toContain('ask.cancelled')
    await second.stop()
  }, 30_000)
})
