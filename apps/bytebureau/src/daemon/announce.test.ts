import { describe, expect, it, vi } from 'vitest'
import { createContext, type GlobalArgs } from '../context.js'
import { recordOn } from '../testing/health-stub.js'
import { alreadyRunning, announce } from './announce.js'

const TEXT: GlobalArgs = { json: false, color: false, yes: false }

describe(announce, () => {
  it('prints where the daemon listens, and warns when the network can reach it', () => {
    const log = vi.spyOn(console, 'log').mockReturnValue()
    const error = vi.spyOn(console, 'error').mockReturnValue()
    const context = createContext(TEXT, {}, false)
    announce(recordOn(4747), context)
    announce({ ...recordOn(4747), host: '192.168.1.5' }, context)
    // Bound to every interface, the daemon is recorded with the loopback clients use, and with the address it is bound to
    announce({ ...recordOn(4747), bind: '0.0.0.0' }, context)
    expect(log.mock.calls).toStrictEqual([
      ['Daemon listening on http://127.0.0.1:4747'],
      ['Daemon listening on http://192.168.1.5:4747'],
      ['Daemon listening on http://127.0.0.1:4747'],
    ])
    expect(error.mock.calls).toStrictEqual([
      ['Listening on 192.168.1.5: anyone on the network with the token can use this daemon'],
      ['Listening on 0.0.0.0: anyone on the network with the token can use this daemon'],
    ])
  })

  it('emits the url, the pid and the version as JSON, never the token', () => {
    const log = vi.spyOn(console, 'log').mockReturnValue()
    const context = createContext({ ...TEXT, json: true }, {}, false)
    announce(recordOn(4747, 42), context)
    alreadyRunning(recordOn(4747, 42), context)
    const record = {
      command: 'serve',
      url: 'http://127.0.0.1:4747',
      pid: 42,
      version: '0.0.0-test',
    }
    expect(log.mock.calls).toStrictEqual([[JSON.stringify(record)], [JSON.stringify(record)]])
  })
})

describe(alreadyRunning, () => {
  it('names the daemon that serves the home already', () => {
    const log = vi.spyOn(console, 'log').mockReturnValue()
    alreadyRunning(recordOn(4747, 42), createContext(TEXT, {}, false))
    expect(log.mock.calls).toStrictEqual([
      ['Daemon already running on http://127.0.0.1:4747 (pid 42)'],
    ])
  })
})
