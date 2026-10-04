import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../testing/temp-repo.js'
import {
  acquireLock,
  isAlive,
  lockPath,
  readServerInfo,
  releaseLock,
  removeServerInfo,
  serverInfoPath,
  writeServerInfo,
} from './server-info.js'

const info = {
  version: '0.1.0',
  host: '127.0.0.1',
  port: 4747,
  pid: process.pid,
  token: 'a'.repeat(64),
  startedAt: '2026-10-04T10:00:00.000Z',
}

// No process has this pid: the highest a system hands out is far below it
const DEAD_PID = 2_147_483_000

const modeOf = (file: string): number => statSync(file).mode % 0o1000

describe('server.json', () => {
  it('is written for the user alone and read back', () => {
    const home = tempDir('bb-home-')
    writeServerInfo(home, info)
    const written: unknown = JSON.parse(readFileSync(serverInfoPath(home), 'utf8'))
    expect(modeOf(serverInfoPath(home))).toBe(0o600)
    expect(readServerInfo(home)).toStrictEqual({ state: 'alive', info })
    expect(written).toStrictEqual(info)
  })

  it('is absent when no daemon ever ran, stale when its pid is gone, and removed on request', () => {
    const home = tempDir('bb-home-')
    expect(readServerInfo(home)).toStrictEqual({ state: 'absent' })
    writeServerInfo(home, { ...info, pid: DEAD_PID })
    expect(readServerInfo(home)).toStrictEqual({ state: 'stale', info: { ...info, pid: DEAD_PID } })
    removeServerInfo(home)
    expect(existsSync(path.join(home, 'server.json'))).toBe(false)
    removeServerInfo(home)
  })

  it('reports a file that is not a server record as stale with no info', () => {
    const home = tempDir('bb-home-')
    writeServerInfo(home, info)
    writeFileSync(serverInfoPath(home), '{"nope":1}')
    expect(readServerInfo(home)).toStrictEqual({ state: 'stale' })
    writeFileSync(serverInfoPath(home), 'not json')
    expect(readServerInfo(home)).toStrictEqual({ state: 'stale' })
  })

  it('knows a live pid from a dead one', () => {
    expect(isAlive(process.pid)).toBe(true)
    expect(isAlive(DEAD_PID)).toBe(false)
    // Signal 0 to pid 0 or -1 would reach a whole group of processes: neither is a daemon
    expect(isAlive(0)).toBe(false)
    expect(isAlive(-1)).toBe(false)
  })
})

describe('the daemon lock', () => {
  it('hands the lock to one holder, names a live holder to the next, and takes over a dead one', () => {
    const home = tempDir('bb-home-')
    expect(acquireLock(home)).toStrictEqual({ acquired: true })
    expect(modeOf(lockPath(home))).toBe(0o600)
    expect(acquireLock(home)).toStrictEqual({ acquired: false, pid: process.pid })
    releaseLock(home)
    writeFileSync(lockPath(home), String(DEAD_PID))
    expect(acquireLock(home)).toStrictEqual({ acquired: true })
    releaseLock(home)
    expect(existsSync(lockPath(home))).toBe(false)
  })

  it('takes over a lock that names no process, and leaves the lock of another holder alone', () => {
    const home = tempDir('bb-home-')
    writeFileSync(lockPath(home), 'not a pid')
    expect(acquireLock(home)).toStrictEqual({ acquired: true })
    // Pid 1 is alive on every system and is never this process
    writeFileSync(lockPath(home), '1')
    releaseLock(home)
    expect(readFileSync(lockPath(home), 'utf8')).toBe('1')
  })
})
