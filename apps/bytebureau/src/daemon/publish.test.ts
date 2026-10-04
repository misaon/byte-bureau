import type { RunningDaemon } from '@bytebureau/api/bun'
import { describe, expect, it, vi } from 'vitest'
import { createContext } from '../context.js'
import { tempDir } from '../testing/temp-repo.js'
import { publish } from './publish.js'
import { readServerInfo } from './server-info.js'

const TOKEN = 'b'.repeat(64)

const daemonOn = (host: string): RunningDaemon => ({
  address: { host, port: 4747 },
  startedAt: '2026-10-04T10:00:00.000Z',
  close: async () => {
    // Nothing runs behind this stand-in
  },
})

describe(publish, () => {
  it('records the loopback for a daemon bound to every interface, and warns with the address it is bound to', () => {
    vi.spyOn(console, 'log').mockReturnValue()
    const error = vi.spyOn(console, 'error').mockReturnValue()
    const home = tempDir('bb-home-')
    publish(
      home,
      { daemon: daemonOn('0.0.0.0'), token: TOKEN },
      createContext({ json: false, color: false, yes: false }, {}, false),
    )
    expect(readServerInfo(home)).toMatchObject({
      state: 'alive',
      info: { host: '127.0.0.1', port: 4747, pid: process.pid, token: TOKEN },
    })
    expect(error.mock.calls).toStrictEqual([
      ['Listening on 0.0.0.0: anyone on the network with the token can use this daemon'],
    ])
  })

  it('records a daemon bound to the loopback as it is bound, without a warning', () => {
    const log = vi.spyOn(console, 'log').mockReturnValue()
    const error = vi.spyOn(console, 'error').mockReturnValue()
    const home = tempDir('bb-home-')
    publish(
      home,
      { daemon: daemonOn('::1'), token: TOKEN },
      createContext({ json: false, color: false, yes: false }, {}, false),
    )
    expect(readServerInfo(home)).toMatchObject({ state: 'alive', info: { host: '::1' } })
    expect([log.mock.calls, error.mock.calls]).toStrictEqual([
      [['Daemon listening on http://[::1]:4747']],
      [],
    ])
  })
})
