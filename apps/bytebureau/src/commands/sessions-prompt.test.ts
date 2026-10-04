import { SessionError, WorkspaceError } from '@bytebureau/kernel'
import { describe, expect, it } from 'vitest'
import { askOf, event, inTurn, option, question } from '../testing/events.js'
import { frames } from '../testing/frames.js'
import { problemError } from '../testing/records.js'
import {
  captureConsole,
  captureTerminal,
  contextOf,
  ERRORED,
  rejecting,
  scripted,
  STOPPED,
} from '../testing/scripted-kernel.js'
import { promptSession, type PromptOptions } from './sessions-prompt.js'

const PROMPT: PromptOptions = { id: 's1', text: 'And again', yes: false }

// The scripted Bureau answers a prompt with the turn u1; u0 is the turn before it
const USAGE = { inputTokens: 10, outputTokens: 5 }
const FIRST_TURN = [
  inTurn('u0', event('message.user', { text: 'First' }, 1)),
  inTurn(
    'u0',
    event(
      'turn.completed',
      { turnId: 'u0', index: 0, status: 'completed', stopReason: 'end_turn', usage: USAGE },
      2,
    ),
  ),
]
// A session that was stopped, and resumed, between the turns
const STOP_BETWEEN = [
  event('session.stopped', { status: 'stopped' }, 3),
  event('session.resumed', { status: 'ready' }, 4),
]
const RUNNING = event('session.running', { status: 'running' }, 5)
const ASKED = inTurn('u1', event('message.user', { text: 'And again' }, 6))
const WORKING = inTurn(
  'u1',
  event('turn.started', { turnId: 'u1', index: 1, status: 'running' }, 7),
)
const SAID = inTurn(
  'u1',
  event('message.assistant.completed', { text: 'Fixed it', content: [] }, 8),
)
const DONE = inTurn(
  'u1',
  event(
    'turn.completed',
    { turnId: 'u1', index: 1, status: 'completed', stopReason: 'end_turn', usage: USAGE },
    9,
  ),
)
const INTERRUPTED = inTurn(
  'u1',
  event('turn.interrupted', { turnId: 'u1', index: 1, status: 'interrupted' }, 9),
)
const CRASHED = inTurn(
  'u1',
  event('turn.interrupted', { turnId: 'u1', index: 1, status: 'errored' }, 9),
)

const READY = event('session.ready', { status: 'ready' }, 10)
const CANCELLED = inTurn('u1', event('ask.cancelled', { askId: 'a1' }, 9))

const BEGUN = [RUNNING, ASKED, WORKING]
const HISTORY = [...FIRST_TURN, ...STOP_BETWEEN]

describe(promptSession, () => {
  it('prompts the session and follows its new turn only, which leaves the session ready', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau, calls } = scripted([...HISTORY, ...BEGUN, SAID, DONE])
    await expect(promptSession(bureau, PROMPT, contextOf())).resolves.toBe(0)
    expect(calls).toStrictEqual([
      'subscribe {"sessionId":"s1","since":0,"ephemeral":false}',
      'prompt s1 And again',
    ])
    expect(printed.out()).toStrictEqual([
      'The employee is working…',
      'Fixed it',
      'Done — turns: 1, input tokens: 10, output tokens: 5',
    ])
  })

  it('prints the events of that turn as JSON lines, and nothing of the turns before it', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([...HISTORY, ...BEGUN, SAID, DONE])
    await expect(promptSession(bureau, PROMPT, contextOf(true))).resolves.toBe(0)
    const turn = [ASKED, WORKING, SAID, DONE]
    expect(printed.out()).toStrictEqual(turn.map((each) => JSON.stringify(each)))
    expect(printed.err()).toStrictEqual([])
  })

  it('takes no stop or error of an earlier day for the end of the turn', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const earlier = [...HISTORY, ERRORED, STOPPED]
    const { bureau } = scripted([...earlier, ...BEGUN, DONE])
    await expect(promptSession(bureau, PROMPT, contextOf())).resolves.toBe(0)
    expect(printed.err()).toStrictEqual([])
  })

  it('subscribes with a signal of its own and aborts it once the turn has ended', async () => {
    expect.hasAssertions()
    captureConsole()
    const script = scripted([...BEGUN, DONE])
    await promptSession(script.bureau, PROMPT, contextOf())
    expect(script.signals).toHaveLength(1)
    expect(script.signals[0]).toMatchObject({ aborted: true })
  })
})

describe('promptSession when the turn is interrupted', () => {
  it('exits 3 and says so, once the session is ready again', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([...BEGUN, INTERRUPTED, READY])
    await expect(promptSession(bureau, PROMPT, contextOf())).resolves.toBe(3)
    expect(printed.out()).toStrictEqual(['The employee is working…', 'Turn interrupted'])
  })

  it('does not end at the interrupted turn: what comes before its session says what became of it is shown', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([...BEGUN, INTERRUPTED, CANCELLED, READY])
    await promptSession(bureau, PROMPT, contextOf(true))
    const shown = [ASKED, WORKING, INTERRUPTED, CANCELLED, READY]
    expect(printed.out()).toStrictEqual(shown.map((each) => JSON.stringify(each)))
  })

  it('ends with the stop that follows, as a stop by its own signal or by another command makes it', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([...BEGUN, INTERRUPTED, CANCELLED, STOPPED])
    await expect(promptSession(bureau, PROMPT, contextOf(true))).resolves.toBe(3)
    expect(printed.out().at(-1)).toBe(JSON.stringify(STOPPED))
  })

  it('takes a session that is ready for no end unless a turn was interrupted', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([...BEGUN, READY, DONE])
    await expect(promptSession(bureau, PROMPT, contextOf())).resolves.toBe(0)
    expect(printed.out().at(-1)).toBe('Done — turns: 1, input tokens: 10, output tokens: 5')
  })

  it('fails when the events end with the interrupted turn and no word of its session', async () => {
    expect.hasAssertions()
    captureConsole()
    const { bureau } = scripted([...BEGUN, INTERRUPTED])
    await expect(promptSession(bureau, PROMPT, contextOf())).rejects.toThrow(
      'the events ended before the session did',
    )
  })
})

describe('promptSession when the turn does not complete otherwise', () => {
  it('exits 3 when the session is stopped, which no turn owns', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([...BEGUN, STOPPED])
    await expect(promptSession(bureau, PROMPT, contextOf())).resolves.toBe(3)
    expect(printed.out()).toStrictEqual(['The employee is working…', 'Session stopped'])
  })

  it('exits 4 and says why when the provider failed, once the errored session tells', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([...BEGUN, CRASHED, ERRORED])
    await expect(promptSession(bureau, PROMPT, contextOf())).resolves.toBe(4)
    expect(printed.out()).toStrictEqual(['The employee is working…'])
    expect(printed.err()).toStrictEqual(['The provider failed: the agent died'])
  })

  it('fails when the events end before the turn does', async () => {
    expect.hasAssertions()
    captureConsole()
    const { bureau } = scripted([...BEGUN, SAID])
    await expect(promptSession(bureau, PROMPT, contextOf())).rejects.toThrow(
      'the events ended before the session did',
    )
  })

  it('fails when the events end with a turn that errored and no session to say why', async () => {
    expect.hasAssertions()
    captureConsole()
    const { bureau } = scripted([...BEGUN, CRASHED])
    await expect(promptSession(bureau, PROMPT, contextOf())).rejects.toThrow(
      'the events ended before the session did',
    )
  })
})

describe('promptSession with an ask', () => {
  const ask = askOf([question([option('yes', true)])])
  const asked = inTurn('u1', event('ask.requested', { ask }, 8))

  it('answers it with the recommended option when --yes is given', async () => {
    expect.hasAssertions()
    captureConsole()
    const { bureau, answered } = scripted([...BEGUN, asked, DONE])
    await promptSession(bureau, { ...PROMPT, yes: true }, contextOf())
    expect(answered).toStrictEqual([{ askId: 'a1', answer: { selected: ['yes'] } }])
  })

  it('leaves it to the kernel policy, and says that the session waits, when nobody can answer it', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau, answered } = scripted([...BEGUN, asked, DONE])
    await expect(promptSession(bureau, PROMPT, contextOf())).resolves.toBe(0)
    expect(answered).toStrictEqual([])
    expect(printed.err()).toStrictEqual([
      'The employee is waiting for your answer to "Export style" (not answered automatically)',
    ])
  })
})

describe('promptSession when the request is refused', () => {
  const provider = new SessionError({
    code: 'provider_missing',
    reason: 'provider "claude" is not available; available: fake',
  })
  const worktree = new WorkspaceError({ code: 'git_failed', reason: 'git worktree add failed' })
  const unprompted = new SessionError({
    code: 'invalid_transition',
    reason: 'cannot prompt a completed session',
  })

  it.each([
    ['the kernel refuses the provider', provider],
    ['the kernel refuses the worktree', worktree],
    ['the kernel refuses a prompt that the session cannot take', unprompted],
    [
      'the daemon refuses the worktree',
      problemError(422, 'workspace_git_failed', 'git worktree add failed'),
    ],
    [
      'the daemon refuses the provider',
      problemError(422, 'session_provider_missing', 'provider "claude" is not available'),
    ],
    [
      'the daemon does not know the session',
      problemError(404, 'session_not_found', 'no session s1'),
    ],
  ])('passes the refusal on, to be told by the command, when %s', async (_what, refusal) => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([DONE], { prompt: rejecting(refusal) })
    await expect(promptSession(bureau, PROMPT, contextOf())).rejects.toBe(refusal)
    expect(printed.err()).toStrictEqual([])
  })
})

describe('promptSession at a terminal', () => {
  it.each([
    ['a failure that is no refusal', new Error('the store is gone')],
    ['a refusal', new SessionError({ code: 'not_found', reason: 'session s1 does not exist' })],
  ])('closes the frame it opened, and lets %s go on', async (_what, failure) => {
    expect.hasAssertions()
    captureConsole()
    const written = captureTerminal()
    const { bureau } = scripted([DONE], { prompt: rejecting(failure) })
    await expect(promptSession(bureau, PROMPT, contextOf(false, true))).rejects.toBe(failure)
    expect(frames(written())).toStrictEqual({ starts: 1, ends: 1 })
  })
})
