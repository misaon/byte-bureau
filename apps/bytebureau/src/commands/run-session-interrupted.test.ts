import { describe, expect, it } from 'vitest'
import {
  captureConsole,
  COMPLETED,
  contextOf,
  OPTIONS,
  READY,
  scripted,
  STOPPED,
  TURN_DONE,
  TURN_INTERRUPTED,
} from '../testing/scripted-kernel.js'
import { runSession } from './run-session.js'

describe('runSession when another command interrupts the turn', () => {
  it('exits 3 and says that the turn was interrupted, once the session is ready again', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau, calls } = scripted([TURN_INTERRUPTED, READY])
    await expect(runSession(bureau, OPTIONS, contextOf())).resolves.toBe(3)
    expect(printed.out()).toStrictEqual(['Turn interrupted'])
    expect(calls).not.toContain('complete s1')
  })

  it('does not end at the interrupted turn: the events that come before its session says what became of it are shown', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([TURN_INTERRUPTED, READY])
    await runSession(bureau, OPTIONS, contextOf(true))
    expect(printed.out()).toStrictEqual([JSON.stringify(TURN_INTERRUPTED), JSON.stringify(READY)])
  })

  it('fails when the events end with the interrupted turn and no word of its session', async () => {
    expect.hasAssertions()
    captureConsole()
    const { bureau } = scripted([TURN_INTERRUPTED])
    await expect(runSession(bureau, OPTIONS, contextOf())).rejects.toThrow(
      'the events ended before the session did',
    )
  })
})

describe('runSession when the session is stopped after an interrupted turn', () => {
  it('ends with the stop, as a stop by its own signal or by another command makes it', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([TURN_INTERRUPTED, STOPPED])
    await expect(runSession(bureau, OPTIONS, contextOf())).resolves.toBe(3)
    expect(printed.out()).toStrictEqual(['Session stopped'])
  })

  it('takes a session that is ready for no end of the run, unless a turn was interrupted', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([READY, TURN_DONE, READY, COMPLETED])
    await expect(runSession(bureau, OPTIONS, contextOf())).resolves.toBe(0)
    expect(printed.out()).toStrictEqual(['Done — turns: 1, input tokens: 10, output tokens: 5'])
  })
})
