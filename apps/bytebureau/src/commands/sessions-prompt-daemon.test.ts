import { describe, expect, it } from 'vitest'
import { jsonLines } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import {
  promptedAgain,
  ready,
  resumedSession,
  resumedSlowSession,
  slowTurn,
  stoppedInProcess,
  stoppedSession,
  turnsOf,
  WAITING,
  WORKING,
} from '../testing/session-bench.js'
import { NO_DAEMON } from '../testing/workbench.js'

describe('bytebureau sessions resume and prompt through the daemon', () => {
  it('resumes a stopped session', async () => {
    expect.hasAssertions()
    const session = await stoppedSession({}, WAITING)
    const stopped = await runCli(['sessions', 'show', session.id], session.env)
    const resumed = await runCli(['sessions', 'resume', session.id], session.env)
    const shown = await ready(session)
    expect(stopped.stdout).toMatch(/^status\s+stopped$/mu)
    expect([resumed.code, resumed.stdout.trim()]).toStrictEqual([0, `resume: ${session.id}`])
    expect(shown.stdout).toMatch(/^status\s+ready$/mu)
    await session.daemon.stop()
  })

  it('prompts it again, to the end of the new turn', async () => {
    expect.hasAssertions()
    const session = await resumedSession()
    const prompted = await promptedAgain(session, 'again')
    expect([prompted.code, jsonLines(prompted.stdout).at(-1)]).toMatchObject([
      0,
      { type: 'turn.completed' },
    ])
    await session.daemon.stop()
  })

  it('follows the new turn only: nothing of the turn before it, nor of the stop', async () => {
    expect.hasAssertions()
    const session = await resumedSession()
    const prompted = await promptedAgain(session, 'again')
    const types = jsonLines(prompted.stdout).map((record) => record['type'])
    expect(types).toStrictEqual(expect.arrayContaining(['ask.requested', 'ask.answered']))
    expect(types).not.toContain('session.stopped')
    expect(turnsOf(prompted.stdout)).toHaveLength(1)
    expect(turnsOf(prompted.stdout)).not.toStrictEqual(turnsOf(session.first.stdout))
    await session.daemon.stop()
  })

  it('leaves the session ready, for any number of prompts, until it is stopped', async () => {
    expect.hasAssertions()
    const session = await resumedSession()
    const second = await promptedAgain(session, 'again')
    const third = await promptedAgain(session, 'once more')
    const shown = await ready(session)
    const turns = [session.first, second, third].flatMap((result) => turnsOf(result.stdout))
    expect([second.code, third.code]).toStrictEqual([0, 0])
    expect(shown.stdout).toMatch(/^status\s+ready$/mu)
    expect(new Set(turns).size).toBe(3)
    await session.daemon.stop()
  })
})

describe('bytebureau sessions prompt and a signal', () => {
  it('stops the session on SIGTERM while it follows a prompt, and exits 3 at the stop', async () => {
    expect.hasAssertions()
    const session = await resumedSlowSession()
    const prompt = ['sessions', 'prompt', session.id, 'go on', '--json']
    const prompted = await runCli(prompt, session.env, { signal: 'SIGTERM', afterStdout: WORKING })
    const shown = await runCli(['sessions', 'show', session.id], session.env)
    const types = jsonLines(prompted.stdout).map((record) => record['type'])
    expect([prompted.code, types.at(-1)]).toStrictEqual([3, 'session.stopped'])
    expect(types).toContain('turn.interrupted')
    expect(shown.stdout).toMatch(/^status\s+stopped$/mu)
    await session.daemon.stop()
  })

  it('ends with exit code 3 when the turn it follows is interrupted, and the session is ready again', async () => {
    expect.hasAssertions()
    const slow = await slowTurn()
    const interrupted = await runCli(['sessions', 'interrupt', slow.id], slow.env)
    const prompted = await slow.prompting
    const shown = await ready(slow)
    expect([interrupted.code, interrupted.stdout.trim()]).toStrictEqual([
      0,
      `interrupt: ${slow.id}`,
    ])
    const types = jsonLines(prompted.stdout).map((record) => record['type'])
    expect([prompted.code, types.slice(-2)]).toStrictEqual([
      3,
      ['turn.interrupted', 'session.ready'],
    ])
    expect(shown.stdout).toMatch(/^status\s+ready$/mu)
    await slow.daemon.stop()
  })

  it('stops a session that is ready, and tells it in one line', async () => {
    expect.hasAssertions()
    const session = await resumedSession()
    await ready(session)
    const stopped = await runCli(['sessions', 'stop', session.id], session.env)
    const shown = await runCli(['sessions', 'show', session.id], session.env)
    expect([stopped.code, stopped.stdout.trim()]).toStrictEqual([0, `stop: ${session.id}`])
    expect(shown.stdout).toMatch(/^status\s+stopped$/mu)
    await session.daemon.stop()
  })
})

describe('bytebureau sessions resume and prompt in the process of the command', () => {
  it('resumes a stopped session', async () => {
    expect.hasAssertions()
    const { env, id } = await stoppedInProcess()
    const resumed = await runCli(['sessions', 'resume', id, NO_DAEMON], env)
    const shown = await runCli(['sessions', 'show', id, NO_DAEMON], env)
    expect([resumed.code, resumed.stdout.trim()]).toStrictEqual([0, `resume: ${id}`])
    expect(shown.stdout).toMatch(/^status\s+ready$/mu)
  })

  it('prompts a resumed session, and follows the turn to its end', async () => {
    expect.hasAssertions()
    const { env, id } = await stoppedInProcess()
    await runCli(['sessions', 'resume', id, NO_DAEMON], env)
    const prompt = ['sessions', 'prompt', id, 'again', '--json', '--yes', NO_DAEMON]
    const prompted = await runCli(prompt, env)
    expect([prompted.code, jsonLines(prompted.stdout).at(-1)]).toMatchObject([
      0,
      { type: 'turn.completed' },
    ])
  })
})
