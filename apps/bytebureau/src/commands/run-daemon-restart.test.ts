import { once } from 'node:events'
import { createBureauClient } from '@bytebureau/client'
import { describe, expect, it } from 'vitest'
import { freePort, startDaemonProcess, type DaemonProcess } from '../testing/daemon.js'
import { eventLines, jsonLines } from '../testing/json-lines.js'
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

// The session the events of a run belong to
function sessionOf(stdout: string): string {
  const [first] = jsonLines(stdout)
  const id: unknown = first === undefined ? undefined : first['sessionId']
  return typeof id === 'string' ? id : ''
}

// The seq of every durable event of the session as the daemon keeps them, up to its stop
async function loggedSequence(daemon: DaemonProcess, sessionId: string): Promise<number[]> {
  const client = createBureauClient({ baseUrl: daemon.url, token: daemon.info.token })
  const sequence: number[] = []
  for await (const event of client.events.subscribe({ sessionId, since: 0, ephemeral: false })) {
    sequence.push(event.seq)
    if (event.type === 'session.stopped') {
      break
    }
  }
  return sequence
}

describe('bytebureau run across a restart of the daemon', () => {
  it('resumes the events where they stopped and ends as the recovered session says', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const { result, second } = await runAcrossRestart(repo, home)
    const events = eventLines(result.stdout)
    const sequence = events.map((event) => event.seq)
    expect([result.code, events.at(-1)]).toMatchObject([3, { type: 'session.stopped' }])
    // Only the recovery of the next daemon cancels the ask: the events after the restart reached the run
    expect(events.map((event) => event.type)).toContain('ask.cancelled')
    // Every durable event of the session, before the restart and after it, once and in order
    expect(sequence).toStrictEqual([...new Set(sequence)].toSorted((left, right) => left - right))
    expect(sequence).toStrictEqual(await loggedSequence(second, sessionOf(result.stdout)))
    await second.stop()
  }, 30_000)
})
