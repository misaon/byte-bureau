import { describe, expect, it } from 'vitest'
import {
  bureauFlags,
  createContext,
  globalArgs,
  refuseBureauFlags,
  type GlobalArgs,
} from './context.js'
import { usageError } from './usage-error.js'

const QUIET: GlobalArgs = { json: false, color: false, yes: false }

describe(createContext, () => {
  it('passes --debug and --log-level on, unchanged, as the logging of the context', () => {
    const args = { ...QUIET, debug: 'bb.agent,!bb.store', 'log-level': 'warn' }
    expect(createContext(args, {}, false).logging).toStrictEqual({
      debug: 'bb.agent,!bb.store',
      level: 'warn',
    })
  })

  it('leaves the logging to the defaults of the kernel when neither flag is given', () => {
    expect(createContext(QUIET, {}, false).logging).toStrictEqual({
      debug: undefined,
      level: undefined,
    })
  })

  it('keeps an empty --debug, which asks for every category', () => {
    expect(createContext({ ...QUIET, debug: '' }, {}, false).logging).toStrictEqual({
      debug: '',
      level: undefined,
    })
  })

  it('is interactive at a terminal, and not when the output is JSON or goes to a pipe', () => {
    expect(createContext(QUIET, {}, true).interactive).toBe(true)
    expect(createContext({ ...QUIET, json: true }, {}, true).interactive).toBe(false)
    expect(createContext(QUIET, {}, false).interactive).toBe(false)
  })

  it('keeps the environment it was made with, the home of the command among it', () => {
    const env = { BYTEBUREAU_HOME: '/data/bytebureau' }
    expect(createContext(QUIET, env, false).env).toStrictEqual(env)
  })
})

describe(bureauFlags, () => {
  it('talks to the daemon unless --no-daemon says otherwise', () => {
    const none = { daemon: true, host: undefined, port: undefined, tokenFile: undefined }
    expect(bureauFlags(QUIET)).toStrictEqual(none)
    expect(bureauFlags({ ...QUIET, daemon: false })).toStrictEqual({ ...none, daemon: false })
  })

  it('names a daemon by its host, its port as a number and the file of its token', () => {
    const named = { ...QUIET, daemon: true, host: '10.0.0.5', port: '4800', 'token-file': 't' }
    expect(bureauFlags(named)).toStrictEqual({
      daemon: true,
      host: '10.0.0.5',
      port: 4800,
      tokenFile: 't',
    })
  })

  it('refuses --token-file without --host or --port, as a usage error', () => {
    expect(() => bureauFlags({ ...QUIET, 'token-file': 't' })).toThrow(
      expect.objectContaining({
        name: 'CLIError',
        message:
          '--token-file goes with --host or --port: it holds the token of the daemon they name',
      }),
    )
  })

  it.each(['80a', '-1', '65536', ''])('refuses %j as a port, as a usage error', (port) => {
    expect(() => bureauFlags({ ...QUIET, port })).toThrow(
      expect.objectContaining({
        name: 'CLIError',
        message: `--port takes a whole number from 0 to 65535, not ${port}`,
      }),
    )
  })
})

describe('the global flags', () => {
  it('names the flags the way a person types them', () => {
    expect(Object.keys(globalArgs)).toStrictEqual([
      'lang',
      'json',
      'color',
      'yes',
      'debug',
      'log-level',
      'daemon',
      'host',
      'port',
      'token-file',
    ])
  })

  it('says what --yes does: it answers only the asks that have a recommended option', () => {
    expect(globalArgs.yes.description).toBe(
      'Answer every ask that has a recommended option with it',
    )
  })
})

describe(refuseBureauFlags, () => {
  it.each([
    ['--host', ['--host', 'h']],
    ['--port', ['--port=4800']],
    ['--no-daemon', ['--no-daemon']],
    ['--daemon', ['--daemon']],
    ['--token-file', ['--token-file', 't']],
  ])('refuses %s for a command that talks to no daemon, as a usage error', (flag, rawArgs) => {
    expect(() => {
      refuseBureauFlags('hello', rawArgs)
    }).toThrow(usageError(`hello talks to no daemon: it takes no ${flag}`))
  })

  it('keeps the flags a command takes in a sense of its own, and what follows --', () => {
    expect(() => {
      refuseBureauFlags('serve', ['--host', '0.0.0.0', '--port', '0'], ['--host', '--port'])
      refuseBureauFlags('hello', ['--lang', 'cs', '--', '--host'])
    }).not.toThrow()
    expect(() => {
      refuseBureauFlags('serve', ['--port', '0', '--token-file', 't'], ['--host', '--port'])
    }).toThrow(usageError('serve talks to no daemon: it takes no --token-file'))
  })
})
