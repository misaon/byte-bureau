import type { ProfileStatusDto } from '@bytebureau/protocol'
import { describe, expect, it } from 'vitest'
import type { Bureau } from '../bureau/bureau.js'
import { PROFILE, PROFILE_STATUS, problemError } from '../testing/records.js'
import { captureConsole, contextOf, rejecting, scripted } from '../testing/scripted-kernel.js'
import { tellAdded } from './profiles-add.js'

const HINT = 'CLAUDE_CONFIG_DIR=/home/me/.bytebureau/profiles/fake/work claude /login'
const LOGGED_OUT: ProfileStatusDto = { ...PROFILE_STATUS, state: 'loggedOut', hint: HINT }
const ADDED_LOGIN = `Profile fake/work added. Log in with: ${HINT}`
const STORE_DOWN = problemError(503, 'store_unavailable', 'the store is unavailable')

interface Statuses {
  readonly bureau: Bureau
  // The profiles whose status was asked, in order
  readonly asked: string[]
}

// A Bureau that answers the statuses one after the other
function answering(...statuses: ProfileStatusDto[]): Statuses {
  const { bureau } = scripted([])
  const asked: string[] = []
  const status = async (id: string): Promise<ProfileStatusDto> => {
    asked.push(id)
    await Promise.resolve()
    return statuses[asked.length - 1] ?? PROFILE_STATUS
  }
  return { bureau: { ...bureau, profiles: { ...bureau.profiles, status } }, asked }
}

// A Bureau whose first status is logged out and whose next one fails, as a store that went down meanwhile
function failingOnRecheck(): Bureau {
  const { bureau } = scripted([])
  const state = { calls: 0 }
  const status = async (): Promise<ProfileStatusDto> => {
    state.calls += 1
    await Promise.resolve()
    if (state.calls > 1) {
      throw STORE_DOWN
    }
    return LOGGED_OUT
  }
  return { ...bureau, profiles: { ...bureau.profiles, status } }
}

const saying = (done: boolean) => async (): Promise<boolean> => {
  await Promise.resolve()
  return done
}

describe(tellAdded, () => {
  it('tells where to log in when the status of a login profile has a hint, and waits for nothing off a terminal', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau, asked } = answering(LOGGED_OUT)
    await tellAdded(bureau, PROFILE, { context: contextOf(), wait: undefined })
    expect([printed.out(), asked]).toStrictEqual([[ADDED_LOGIN], ['fake/work']])
  })

  it('checks the login again once the person says they have logged in, and tells what it finds', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau, asked } = answering(LOGGED_OUT, {
      ...PROFILE_STATUS,
      account: 'me@example.com',
    })
    await tellAdded(bureau, PROFILE, { context: contextOf(), wait: saying(true) })
    expect(printed.out()).toStrictEqual([ADDED_LOGIN, 'fake/work  loggedIn  me@example.com'])
    expect(asked).toStrictEqual(['fake/work', 'fake/work'])
  })

  it('warns when the login cannot be checked again once the person says they have logged in', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    await tellAdded(failingOnRecheck(), PROFILE, { context: contextOf(), wait: saying(true) })
    expect([printed.out(), printed.err()]).toStrictEqual([
      [ADDED_LOGIN],
      [
        expect.stringContaining(
          'The login of fake/work could not be checked again: the store is unavailable (store_unavailable)',
        ),
      ],
    ])
  })

  it('checks nothing more when the person does not say they have logged in', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau, asked } = answering(LOGGED_OUT)
    await tellAdded(bureau, PROFILE, { context: contextOf(), wait: saying(false) })
    expect([printed.out(), asked]).toStrictEqual([[ADDED_LOGIN], ['fake/work']])
  })
})

describe('tellAdded and a profile that needs no login', () => {
  it('tells a login profile without a hint as added, and an API-key one without asking its status', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const login = answering(PROFILE_STATUS)
    const key = answering()
    await tellAdded(login.bureau, PROFILE, { context: contextOf(), wait: saying(true) })
    const keyed = { ...PROFILE, id: 'fake/key', kind: 'api_key' } as const
    await tellAdded(key.bureau, keyed, { context: contextOf(), wait: saying(true) })
    expect(printed.out()).toStrictEqual([
      'Profile fake/work added',
      'fake/work  loggedIn  -',
      'Profile fake/key added',
    ])
    expect([login.asked, key.asked]).toStrictEqual([['fake/work'], []])
  })

  it('tells the status of a login profile as a JSON record, without words', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = answering(LOGGED_OUT)
    await tellAdded(bureau, PROFILE, { context: contextOf(true), wait: undefined })
    expect(printed.out()).toStrictEqual([
      JSON.stringify({ command: 'profiles.status', statuses: [LOGGED_OUT] }),
    ])
  })
})

describe('tellAdded and a status that tells no login to perform', () => {
  it('tells a state other than logged out as added with its status row, never as a login, and waits for nothing', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const reason = 'claude is not installed; install it first'
    const { bureau, asked } = answering({ ...PROFILE_STATUS, state: 'unknown', hint: reason })
    await tellAdded(bureau, PROFILE, { context: contextOf(), wait: saying(true) })
    expect(printed.out()).toStrictEqual([
      'Profile fake/work added',
      `fake/work  unknown  -  ${reason}`,
    ])
    expect(asked).toStrictEqual(['fake/work'])
  })

  it('ends as added when the status cannot be had after the add, which a retry would refuse as existing', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([])
    const status = rejecting(problemError(503, 'store_unavailable', 'the store is unavailable'))
    const failing = { ...bureau, profiles: { ...bureau.profiles, status } }
    await expect(
      tellAdded(failing, PROFILE, { context: contextOf(), wait: saying(true) }),
    ).resolves.toBeUndefined()
    expect([printed.out(), printed.err()]).toStrictEqual([['Profile fake/work added'], []])
  })
})
