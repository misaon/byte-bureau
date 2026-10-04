import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../testing/temp-repo.js'
import { daemonLogPath, rotateDaemonLog } from './daemon-log.js'
import { lockPath } from './server-info.js'

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
