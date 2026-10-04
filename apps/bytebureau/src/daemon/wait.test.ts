import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { healthStub, recordOn } from '../testing/health-stub.js'
import { tempDir } from '../testing/temp-repo.js'
import { writeServerInfo } from './server-info.js'
import { daemonAnswers, runningDaemon, waitForDaemon } from './wait.js'

// Nothing listens on port 1 of the loopback: a connection there is refused at once
const NOBODY = 1

describe(waitForDaemon, () => {
  it('gives the record once its daemon has written it and answers, and nothing when none comes up in time', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const port = await healthStub()
    await expect(waitForDaemon(home, 300)).resolves.toBeUndefined()
    const waited = waitForDaemon(home, 5000)
    await sleep(200)
    writeServerInfo(home, recordOn(port))
    await expect(waited).resolves.toStrictEqual(recordOn(port))
  })

  it('takes no answer from another start, or from a port without a daemon, for the daemon of the record', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const port = await healthStub('2026-10-04T09:00:00.000Z')
    writeServerInfo(home, recordOn(port))
    await expect(daemonAnswers(recordOn(port))).resolves.toBe(false)
    await expect(daemonAnswers(recordOn(NOBODY))).resolves.toBe(false)
    await expect(waitForDaemon(home, 300)).resolves.toBeUndefined()
  })
})

describe(runningDaemon, () => {
  it('names the daemon of the home only while its pid lives and its health answers', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const port = await healthStub()
    await expect(runningDaemon(home)).resolves.toBeUndefined()
    writeServerInfo(home, recordOn(port))
    await expect(runningDaemon(home)).resolves.toStrictEqual(recordOn(port))
    writeServerInfo(home, recordOn(NOBODY))
    await expect(runningDaemon(home)).resolves.toBeUndefined()
    writeServerInfo(home, recordOn(port, 2_147_483_000))
    await expect(runningDaemon(home)).resolves.toBeUndefined()
  })
})
