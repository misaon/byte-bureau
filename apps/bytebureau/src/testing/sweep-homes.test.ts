import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { isAlive, lockPath } from '../daemon/server-info.js'
import { scratchOf, sweepHomes } from './sweep-homes.js'

// A home the sweep owns: not one of tempDir, which would remove it a second time
const homeOfTheSweep = (): string => {
  const created = mkdtempSync(path.join(tmpdir(), 'bb-swept-'))
  return realpathSync(created)
}

// A process that stands in for a daemon left running, killed when the test ends if the sweep missed it
async function leftRunning(): Promise<number> {
  const child = spawn(process.execPath, ['-e', "setInterval(() => {}, 1000); console.log('up')"], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  onTestFinished(() => {
    child.kill('SIGKILL')
  })
  await once(child.stdout, 'data')
  return child.pid ?? 0
}

describe(sweepHomes, () => {
  it('ends a daemon a test left in its home, and removes the home', async () => {
    expect.hasAssertions()
    const home = homeOfTheSweep()
    const pid = await leftRunning()
    writeFileSync(lockPath(home), String(pid))
    await expect(sweepHomes([home])).resolves.toStrictEqual([pid])
    expect([isAlive(pid), existsSync(home)]).toStrictEqual([false, false])
  })

  it('signals neither the process that sweeps nor pid 1', async () => {
    expect.hasAssertions()
    const mine = homeOfTheSweep()
    const init = homeOfTheSweep()
    writeFileSync(lockPath(mine), String(process.pid))
    writeFileSync(lockPath(init), '1')
    await expect(sweepHomes([mine, init])).resolves.toStrictEqual([])
    expect([existsSync(mine), existsSync(init)]).toStrictEqual([false, false])
  })
})

describe(scratchOf, () => {
  it('reads the directories the tests wrote down, and none from a run that wrote none', () => {
    const run = homeOfTheSweep()
    onTestFinished(async () => {
      await sweepHomes([run])
    })
    expect(scratchOf(run)).toStrictEqual([])
    writeFileSync(path.join(run, 'homes'), '/tmp/a\n/tmp/b\n')
    expect(scratchOf(run)).toStrictEqual(['/tmp/a', '/tmp/b'])
  })
})
