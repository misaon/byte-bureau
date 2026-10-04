import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeServerInfo } from '../daemon/server-info.js'
import { tokenPath } from '../daemon/token.js'
import { tempDir } from '../testing/temp-repo.js'
import { resolveServer } from './resolve.js'

const info = {
  version: '0',
  host: '127.0.0.1',
  port: 4747,
  pid: process.pid,
  token: 't'.repeat(64),
  startedAt: 's',
}

// No process has this pid: the highest a system hands out is far below it
const DEAD_PID = 2_147_483_000

describe(resolveServer, () => {
  it('names no daemon without --host and --port, not even one server.json calls alive: only its answer will tell', () => {
    const alive = tempDir('bb-home-')
    const stale = tempDir('bb-home-')
    writeServerInfo(alive, info)
    writeServerInfo(stale, { ...info, pid: DEAD_PID })
    expect(resolveServer({}, alive)).toStrictEqual({ kind: 'none' })
    expect(resolveServer({}, stale)).toStrictEqual({ kind: 'none' })
    expect(resolveServer({}, tempDir('bb-home-'))).toStrictEqual({ kind: 'none' })
  })

  it('prefers --host and --port, with the token of --token-file, and never starts a daemon for them', () => {
    const home = tempDir('bb-home-')
    const tokenFile = path.join(home, 'token')
    writeFileSync(tokenFile, 'abc\n')
    expect(resolveServer({ host: '10.0.0.5', port: 4800, tokenFile }, home)).toStrictEqual({
      kind: 'explicit',
      url: 'http://10.0.0.5:4800',
      token: 'abc',
    })
  })

  it('takes the token of the home for --host and --port without a token file', () => {
    const home = tempDir('bb-home-')
    writeServerInfo(home, info)
    expect(resolveServer({ host: '127.0.0.1', port: 5000 }, home)).toStrictEqual({
      kind: 'explicit',
      url: 'http://127.0.0.1:5000',
      token: info.token,
    })
  })
})

describe('resolveServer for a daemon named on the command line', () => {
  it('takes the token the home keeps when its daemon is not running, and none when it keeps none', () => {
    const home = tempDir('bb-home-')
    writeFileSync(tokenPath(home), `${'k'.repeat(64)}\n`)
    expect(resolveServer({ port: 5000 }, home)).toStrictEqual({
      kind: 'explicit',
      url: 'http://127.0.0.1:5000',
      token: 'k'.repeat(64),
    })
    expect(resolveServer({ port: 5000 }, tempDir('bb-home-'))).toMatchObject({ token: '' })
  })

  it('fills in the loopback for --port alone and the default port for --host alone', () => {
    const home = tempDir('bb-home-')
    expect(resolveServer({ port: 5000 }, home)).toMatchObject({ url: 'http://127.0.0.1:5000' })
    expect(resolveServer({ host: '::1' }, home)).toMatchObject({ url: 'http://[::1]:4747' })
  })
})
