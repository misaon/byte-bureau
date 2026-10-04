import { describe, expect, it } from 'vitest'
import { daemonEnv, sessionChoices } from './session-env.js'

describe(sessionChoices, () => {
  it('takes the employee and the base branch from the environment when the flags name none', () => {
    const env = { BYTEBUREAU_EMPLOYEE: 'reviewer', BYTEBUREAU_BRANCH: 'develop' }
    expect(sessionChoices({}, env)).toStrictEqual({ employee: 'reviewer', branch: 'develop', env })
  })

  it('lets the flags win over the environment, and takes an empty variable for none, as the kernel does', () => {
    const env = { BYTEBUREAU_EMPLOYEE: 'reviewer', BYTEBUREAU_BRANCH: '' }
    expect(sessionChoices({ employee: 'developer', branch: 'main' }, env)).toMatchObject({
      employee: 'developer',
      branch: 'main',
    })
    expect(sessionChoices({}, env)).toMatchObject({ employee: 'reviewer', branch: undefined })
  })

  it('hands on the BYTEBUREAU_* variables alone but the home, and reads none but the employee and the branch', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/home/someone',
      ANTHROPIC_API_KEY: 'not for the daemon',
      // The agent gets the home of its daemon from the daemon, whatever home the command has
      BYTEBUREAU_HOME: '/home/someone/.bytebureau',
      BYTEBUREAU_FAKE_SCRIPT: 'slow',
      BYTEBUREAU_LOG_LEVEL: 'debug',
      BYTEBUREAU_WORKSPACE_RUNTIME: 'local',
      BYTEBUREAU_UNSET: undefined,
    }
    expect(sessionChoices({}, env)).toStrictEqual({
      employee: undefined,
      branch: undefined,
      env: {
        BYTEBUREAU_FAKE_SCRIPT: 'slow',
        BYTEBUREAU_LOG_LEVEL: 'debug',
        BYTEBUREAU_WORKSPACE_RUNTIME: 'local',
      },
    })
  })
})

describe(daemonEnv, () => {
  it('keeps the BYTEBUREAU_* names of the daemon itself, and drops those that choose for a run', () => {
    const env = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'the agent may need it',
      BYTEBUREAU_HOME: '/data/bytebureau',
      BYTEBUREAU_LOG_LEVEL: 'debug',
      BYTEBUREAU_WORKSPACE_RUNTIME: 'local',
      BYTEBUREAU_EMPLOYEE: 'reviewer',
      BYTEBUREAU_BRANCH: 'develop',
      BYTEBUREAU_FAKE_SCRIPT: 'slow',
    }
    expect(daemonEnv(env)).toStrictEqual({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'the agent may need it',
      BYTEBUREAU_HOME: '/data/bytebureau',
      BYTEBUREAU_LOG_LEVEL: 'debug',
      BYTEBUREAU_WORKSPACE_RUNTIME: 'local',
    })
  })
})
