import { describe, expect, it } from 'vitest'
import { askOf, event, option, question } from '../testing/events.js'
import {
  captureConsole,
  COMPLETED,
  contextOf,
  ERRORED,
  OPTIONS,
  scripted,
  STOPPED,
  TURN_DONE,
} from '../testing/scripted-kernel.js'
import { runSession } from './run-session.js'

describe(runSession, () => {
  it('registers, creates, prompts and follows the session; completes it after its turn', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau, calls } = scripted([TURN_DONE, COMPLETED])
    await expect(runSession(bureau, OPTIONS, contextOf())).resolves.toBe(0)
    expect(calls).toStrictEqual([
      'register /repo',
      'create Fix the build',
      'subscribe {"sessionId":"s1","since":0,"ephemeral":false}',
      'prompt s1 Fix the build',
      'complete s1',
    ])
    expect(printed.out()).toStrictEqual(['Done — turns: 1, input tokens: 10, output tokens: 5'])
  })

  it('hands the prompt on as it was typed and takes the first line of it as the title', async () => {
    expect.hasAssertions()
    captureConsole()
    const typed = 'Vytvoř soubor 😀\r\nA druhý řádek'
    const { bureau, calls } = scripted([COMPLETED])
    await runSession(bureau, { ...OPTIONS, prompt: typed }, contextOf())
    expect(calls).toContain(`prompt s1 ${typed}`)
    expect(calls).toContain('create Vytvoř soubor 😀')
  })

  it('exits 3 when the session was stopped', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([STOPPED])
    await expect(runSession(bureau, OPTIONS, contextOf())).resolves.toBe(3)
    expect(printed.out()).toStrictEqual(['Session stopped'])
  })
})

describe('runSession when the session ends badly', () => {
  it('exits 4 and says why when the provider errored the session', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([ERRORED])
    await expect(runSession(bureau, OPTIONS, contextOf())).resolves.toBe(4)
    expect(printed.err()).toStrictEqual(['The provider failed: the agent died'])
  })

  it('fails when the events end before the session does', async () => {
    expect.hasAssertions()
    captureConsole()
    const { bureau } = scripted([TURN_DONE])
    await expect(runSession(bureau, OPTIONS, contextOf())).rejects.toThrow(
      'the events ended before the session did',
    )
  })

  it('prints the events as JSON lines and nothing else when the output is machine-readable', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([TURN_DONE, COMPLETED])
    await expect(runSession(bureau, OPTIONS, contextOf(true))).resolves.toBe(0)
    expect(printed.out()).toStrictEqual([JSON.stringify(TURN_DONE), JSON.stringify(COMPLETED)])
    expect(printed.err()).toStrictEqual([])
  })
})

describe('runSession with an ask', () => {
  const recommended = askOf([question([option('yes', true)])])
  const asked = event('ask.requested', { ask: recommended }, 2)

  it('answers with the recommended option when --yes is given', async () => {
    expect.hasAssertions()
    captureConsole()
    const { bureau, answered } = scripted([asked, STOPPED])
    await runSession(bureau, { ...OPTIONS, yes: true }, contextOf())
    expect(answered).toStrictEqual([{ askId: 'a1', answer: { selected: ['yes'] } }])
  })

  it('leaves the ask unanswered and says that the session waits when nobody can answer it', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau, answered } = scripted([asked, STOPPED])
    await runSession(bureau, OPTIONS, contextOf())
    expect(answered).toStrictEqual([])
    expect(printed.err()).toStrictEqual([
      'The employee is waiting for your answer to "Export style" (not answered automatically)',
    ])
  })

  it('leaves an ask without a recommendation to the kernel policy even with --yes', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const unrecommended = askOf([question([option('a', false)])], 'none')
    const { bureau, answered } = scripted([
      event('ask.requested', { ask: unrecommended }, 2),
      STOPPED,
    ])
    await runSession(bureau, { ...OPTIONS, yes: true }, contextOf())
    expect(answered).toStrictEqual([])
    expect(printed.err()).toHaveLength(1)
  })
})
