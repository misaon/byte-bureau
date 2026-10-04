import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { tempDir } from '../testing/temp-repo.js'
import { daemonLogPath, rotateDaemonLog } from './daemon-log.js'
import { lockPath } from './server-info.js'

const LOG_MODULE = fileURLToPath(new URL('daemon-log.ts', import.meta.url))

// A log a run wrote, a minute ago
const logOf = (home: string, text: string): void => {
  mkdirSync(path.dirname(daemonLogPath(home)), { recursive: true })
  writeFileSync(daemonLogPath(home), text)
  const aMinuteAgo = new Date(Date.now() - 60_000)
  utimesSync(daemonLogPath(home), aMinuteAgo, aMinuteAgo)
}

const previous = (home: string): string => readFileSync(`${daemonLogPath(home)}.1`, 'utf8')

describe(rotateDaemonLog, () => {
  it('keeps the log of the previous run as daemon.log.1, and only that one', () => {
    const home = tempDir('bb-home-')
    rotateDaemonLog(home)
    expect(existsSync(daemonLogPath(home))).toBe(false)
    logOf(home, 'first run\n')
    rotateDaemonLog(home)
    logOf(home, 'second run\n')
    rotateDaemonLog(home)
    expect([existsSync(daemonLogPath(home)), previous(home)]).toStrictEqual([false, 'second run\n'])
  })

  it('leaves the log alone while a live process holds the lock of the home', () => {
    const home = tempDir('bb-home-')
    logOf(home, 'the run of the daemon\n')
    writeFileSync(lockPath(home), String(process.pid))
    rotateDaemonLog(home)
    expect(readFileSync(daemonLogPath(home), 'utf8')).toBe('the run of the daemon\n')
  })

  it('leaves a log written a moment ago to the start that is writing it', () => {
    const home = tempDir('bb-home-')
    mkdirSync(path.dirname(daemonLogPath(home)), { recursive: true })
    writeFileSync(daemonLogPath(home), 'a start under way\n')
    rotateDaemonLog(home)
    expect(existsSync(`${daemonLogPath(home)}.1`)).toBe(false)
  })
})

// A start in a process of its own that rotates the log of the home at the moment given; its exit code says how that went
async function rotation(home: string, at: number): Promise<number | null> {
  const script = [
    `import { rotateDaemonLog } from ${JSON.stringify(LOG_MODULE)}`,
    `await Bun.sleep(Math.max(0, ${at} - 20 - Date.now()))`,
    `while (Date.now() < ${at}) {}`,
    `rotateDaemonLog(${JSON.stringify(home)})`,
  ].join('\n')
  const child = spawn('bun', ['-e', script], { stdio: 'ignore' })
  onTestFinished(() => {
    child.kill('SIGKILL')
  })
  const { promise, resolve } = Promise.withResolvers<number | null>()
  child.once('exit', resolve)
  const code = await promise
  return code
}

describe('rotateDaemonLog in starts that run at the same moment', () => {
  it('rotates the log once, and none of the starts fails over the log another moved first', async () => {
    expect.hasAssertions()
    const homes = [tempDir('bb-home-'), tempDir('bb-home-'), tempDir('bb-home-')]
    for (const home of homes) {
      logOf(home, 'the previous run\n')
    }
    // Four starts on each home, let go at once once all of them are ready
    const at = Date.now() + 2000
    const starts = homes.flatMap((home) => [home, home, home, home])
    const codes = await Promise.all(
      starts.map(async (home) => {
        const code = await rotation(home, at)
        return code
      }),
    )
    expect(codes).toStrictEqual(starts.map(() => 0))
    expect(homes.map((home) => [existsSync(daemonLogPath(home)), previous(home)])).toStrictEqual(
      homes.map(() => [false, 'the previous run\n']),
    )
  })
})
