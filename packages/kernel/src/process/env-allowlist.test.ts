import { describe, expect, it } from 'vitest'
import { allowlistEnv, bytebureauEnv } from './env-allowlist.js'

// A daemon's environment: the documented variables, an extra one, and what must not reach an agent
const DAEMON_ENV = {
  PATH: '/bin',
  HOME: '/h',
  USER: 'dev',
  LANG: 'cs_CZ.UTF-8',
  LC_ALL: 'C',
  TMPDIR: '/t',
  TERM: 'xterm',
  SSH_AUTH_SOCK: '/tmp/agent.sock',
  ANTHROPIC_API_KEY: 'not-a-real-key',
  AWS_SECRET: 'y',
  BYTEBUREAU_HOME: '/bb',
  TRACEPARENT: '00-a-b-01',
  CUSTOM: 'c',
}

describe(allowlistEnv, () => {
  it('keeps only the documented variables and explicit extras', () => {
    const env = allowlistEnv(DAEMON_ENV, ['CUSTOM'])
    expect(Object.keys(env).toSorted()).toStrictEqual([
      'BYTEBUREAU_HOME',
      'CUSTOM',
      'HOME',
      'LANG',
      'LC_ALL',
      'PATH',
      'SSH_AUTH_SOCK',
      'TERM',
      'TMPDIR',
      'TRACEPARENT',
      'USER',
    ])
  })

  it('drops look-alike names, unset variables and extras the source does not have', () => {
    const env = allowlistEnv(
      {
        PATHS: '/x',
        path: '/lower',
        LC: 'x',
        BYTEBUREAU: 'y',
        SSH_AUTH_SOCKET: '/z',
        USERNAME: 'dev',
        HOME: undefined,
        LANG: 'C',
      },
      ['MISSING'],
    )
    expect(env).toStrictEqual({ LANG: 'C' })
  })
})

describe(bytebureauEnv, () => {
  it('keeps only the names of ByteBureau, whatever else the source holds', () => {
    const env = bytebureauEnv({
      PATH: '/evil',
      HOME: '/evil',
      LANG: 'evil',
      LC_ALL: 'evil',
      TMPDIR: '/evil',
      TERM: 'evil',
      SSH_AUTH_SOCK: '/evil',
      TRACEPARENT: 'evil',
      BYTEBUREAU_FAKE_SCRIPT: 'slow',
      BYTEBUREAU_COLOUR: 'green',
    })
    expect(env).toStrictEqual({ BYTEBUREAU_FAKE_SCRIPT: 'slow', BYTEBUREAU_COLOUR: 'green' })
  })

  it("drops the kernel's own names, which only the kernel's environment gives an agent", () => {
    const env = bytebureauEnv({
      BYTEBUREAU_HOME: '/another/home',
      BYTEBUREAU_LOG_LEVEL: 'debug',
      BYTEBUREAU_WORKSPACE_RUNTIME: 'elsewhere',
      BYTEBUREAU_EMPLOYEE: 'reviewer',
    })
    expect(env).toStrictEqual({ BYTEBUREAU_EMPLOYEE: 'reviewer' })
  })

  it('drops look-alike names and unset variables', () => {
    const env = bytebureauEnv({
      BYTEBUREAU: 'a',
      bytebureau_lower: 'b',
      NOT_BYTEBUREAU_PREFIX: 'c',
      BYTEBUREAU_UNSET: undefined,
      BYTEBUREAU_SET: 'd',
    })
    expect(env).toStrictEqual({ BYTEBUREAU_SET: 'd' })
  })
})
