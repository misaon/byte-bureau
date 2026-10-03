import { describe, expect, it } from 'vitest'
import { allowlistEnv } from './env-allowlist.js'

describe(allowlistEnv, () => {
  it('keeps only the documented variables and explicit extras', () => {
    const env = allowlistEnv(
      {
        PATH: '/bin',
        HOME: '/h',
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
      },
      ['CUSTOM'],
    )
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
        HOME: undefined,
        LANG: 'C',
      },
      ['MISSING'],
    )
    expect(env).toStrictEqual({ LANG: 'C' })
  })
})
