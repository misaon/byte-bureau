import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeServerInfo } from '../daemon/server-info.js'
import { tokenPath } from '../daemon/token.js'
import { tempDir, tokenFile } from '../testing/temp-repo.js'
import { usageError } from '../usage-error.js'
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
    const file = path.join(home, 'token')
    writeFileSync(file, 'abc\n')
    expect(resolveServer({ host: '10.0.0.5', port: 4800, tokenFile: file }, home)).toStrictEqual({
      kind: 'explicit',
      url: 'http://10.0.0.5:4800',
      token: 'abc',
    })
  })

  it('takes the token of the home for the daemon its record names, and only for that one', () => {
    const home = tempDir('bb-home-')
    writeServerInfo(home, info)
    expect(resolveServer({ host: '127.0.0.1', port: 4747 }, home)).toStrictEqual({
      kind: 'explicit',
      url: 'http://127.0.0.1:4747',
      token: info.token,
    })
    expect(resolveServer({ port: 4747 }, home)).toMatchObject({ token: info.token })
  })
})

// The usage error a daemon named on the command line that the record of the home does not name is refused with
const refusal = (url: string): Error =>
  usageError(
    `no daemon of this home listens on ${url}: pass the token of the daemon there with --token-file`,
  )

describe('resolveServer for a daemon named on the command line', () => {
  it('refuses another host or port without --token-file, as a usage error: the token of the home goes nowhere else', () => {
    const home = tempDir('bb-home-')
    writeServerInfo(home, info)
    expect(() => resolveServer({ host: '10.0.0.5', port: 4747 }, home)).toThrow(
      refusal('http://10.0.0.5:4747'),
    )
    expect(() => resolveServer({ port: 5000 }, home)).toThrow(refusal('http://127.0.0.1:5000'))
    // Another name of the same address is no record of this home: its token needs the file too
    expect(() => resolveServer({ host: 'localhost', port: 4747 }, home)).toThrow(
      refusal('http://localhost:4747'),
    )
  })

  it('refuses without --token-file when the daemon of the home is not running, whatever token it keeps', () => {
    const home = tempDir('bb-home-')
    writeFileSync(tokenPath(home), `${'k'.repeat(64)}\n`)
    writeServerInfo(home, { ...info, pid: DEAD_PID })
    expect(() => resolveServer({ port: 4747 }, home)).toThrow(refusal('http://127.0.0.1:4747'))
  })

  it('names a token file it cannot read, rather than what the system says of it', () => {
    const file = path.join(tempDir('bb-home-'), 'no-such-token')
    expect(() => resolveServer({ port: 5000, tokenFile: file }, tempDir('bb-home-'))).toThrow(
      new Error(`Cannot read the token file ${file}`),
    )
  })

  it('fills in the loopback for --port alone and the default port for --host alone', () => {
    const home = tempDir('bb-home-')
    const file = tokenFile()
    expect(resolveServer({ port: 5000, tokenFile: file }, home)).toMatchObject({
      url: 'http://127.0.0.1:5000',
    })
    expect(resolveServer({ host: '::1', tokenFile: file }, home)).toMatchObject({
      url: 'http://[::1]:4747',
    })
  })
})
