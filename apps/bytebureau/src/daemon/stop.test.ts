import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it, onTestFinished } from 'vitest'
import { healthStub, recordOn } from '../testing/health-stub.js'
import { tempDir } from '../testing/temp-repo.js'
import { readServerInfo, writeServerInfo } from './server-info.js'
import { stopDaemon } from './stop.js'

// A process that stands in for the daemon of a record, killed when the test ends; one that ignores SIGTERM outlives a stop
async function standIn(ignoresSigterm: boolean): Promise<number> {
  const handler = ignoresSigterm ? "process.on('SIGTERM', () => {});" : ''
  const script = `${handler} setInterval(() => {}, 1000); console.log('ready')`
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })
  onTestFinished(() => {
    child.kill('SIGKILL')
  })
  await once(child.stdout, 'data')
  return child.pid ?? 0
}

describe(stopDaemon, () => {
  it('finds no daemon in a home without one, and removes a record whose pid is gone', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    await expect(stopDaemon(home)).resolves.toStrictEqual({ outcome: 'not_running' })
    writeServerInfo(home, recordOn(1, 2_147_483_000))
    await expect(stopDaemon(home)).resolves.toStrictEqual({ outcome: 'not_running' })
    expect(readServerInfo(home)).toStrictEqual({ state: 'absent' })
  })

  it('neither signals nor forgets a live pid that does not answer as the daemon of the record', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    // The record names this very process, on a port where no daemon answers: a SIGTERM would end the test run
    writeServerInfo(home, recordOn(1, process.pid))
    await expect(stopDaemon(home)).resolves.toStrictEqual({
      outcome: 'still_running',
      pid: process.pid,
    })
    expect(readServerInfo(home)).toStrictEqual({ state: 'alive', info: recordOn(1, process.pid) })
  })

  it('ends the daemon that answers and removes its record', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const pid = await standIn(false)
    writeServerInfo(home, recordOn(await healthStub(), pid))
    await expect(stopDaemon(home)).resolves.toStrictEqual({ outcome: 'stopped', pid })
    expect(readServerInfo(home)).toStrictEqual({ state: 'absent' })
  })

  it('tells of a daemon that outlives the limit and keeps its record', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const pid = await standIn(true)
    writeServerInfo(home, recordOn(await healthStub(), pid))
    await expect(stopDaemon(home, 300)).resolves.toStrictEqual({ outcome: 'still_running', pid })
    expect(readServerInfo(home).state).toBe('alive')
  })
})
