import { describe, expect, it } from 'vitest'
import { eventLines, firstField, jsonLines, payloadOf } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import { benchWithDaemon, finished, waitingRun, type Waiting } from '../testing/session-bench.js'
import { testHome } from '../testing/temp-repo.js'
import { NO_DAEMON } from '../testing/workbench.js'

// The two exit codes of an ask answered with the arguments, and what the events of the run tell of the answer
async function answeredWith(
  waiting: Waiting,
  answer: readonly string[],
): Promise<readonly unknown[]> {
  const answered = await runCli(['ask', 'answer', waiting.id, ...answer], waiting.env)
  const run = await waiting.run
  await waiting.daemon.stop()
  return [answered.code, run.code, payloadOf(eventLines(run.stdout), 'ask.answered')]
}

describe('bytebureau ask ls through the daemon', () => {
  it('lists nothing while no ask waits', async () => {
    expect.hasAssertions()
    const { env, daemon } = await benchWithDaemon()
    const none = await runCli(['ask', 'ls'], env)
    expect([none.code, none.stdout.trim()]).toStrictEqual([0, 'No asks waiting'])
    await daemon.stop()
  })

  it('lists the ask a run waits on: as JSON, and as a row with the option it recommends', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    const text = await runCli(['ask', 'ls'], waiting.env)
    const sessionId = firstField(waiting.listed, 'asks', 'sessionId')
    expect(jsonLines(waiting.listed)).toMatchObject([
      { command: 'ask.ls', asks: [{ status: 'pending', title: 'Export style' }] },
    ])
    expect(text.stdout.trim().split('  ')).toStrictEqual([
      waiting.id,
      sessionId,
      'Export style',
      'Named export (Recommended)',
    ])
    await finished(waiting)
    await waiting.daemon.stop()
  })

  it('lists only the asks of the session it is given', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    const sessionId = firstField(waiting.listed, 'asks', 'sessionId')
    const ofSession = await runCli(['ask', 'ls', '--session', sessionId], waiting.env)
    const ofOther = await runCli(['ask', 'ls', '--session', 'nobody'], waiting.env)
    expect(ofSession.stdout.trim().split('  ')[0]).toBe(waiting.id)
    expect(ofOther.stdout.trim()).toBe('No asks waiting')
    await finished(waiting)
    await waiting.daemon.stop()
  })
})

describe('bytebureau sessions show and the status, for a run that waits on its ask', () => {
  it('shows the ask that waits for an answer in its session', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    const sessionId = firstField(waiting.listed, 'asks', 'sessionId')
    const shown = await runCli(['sessions', 'show', sessionId], waiting.env)
    const json = await runCli(['sessions', 'show', sessionId, '--json'], waiting.env)
    expect(shown.stdout).toMatch(/^status\s+waiting_for_human$/mu)
    expect(shown.stdout).toContain(`Waiting for your answer: Export style (${waiting.id})`)
    expect(jsonLines(json.stdout)).toMatchObject([
      { command: 'sessions.show', asks: [{ id: waiting.id }] },
    ])
    await finished(waiting)
    await waiting.daemon.stop()
  })

  it('tells the ask that waits, and the counts, in Czech', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    const sessionId = firstField(waiting.listed, 'asks', 'sessionId')
    const shown = await runCli(['sessions', 'show', sessionId, '--lang', 'cs'], waiting.env)
    const status = await runCli(['--lang', 'cs'], waiting.env)
    expect(shown.stdout).toContain(`Čeká na Vaši odpověď: Export style (${waiting.id})`)
    expect(status.stdout.trim().split('\n').slice(2)).toStrictEqual([
      'Relace: celkem 1, běžící 0, čekající na Vás 1',
      'Čekající otázky: 1',
    ])
    await finished(waiting)
    await waiting.daemon.stop()
  })

  it('counts the session and the ask in the status', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    const status = await runCli([], waiting.env)
    expect(status.stdout.trim().split('\n').slice(1)).toStrictEqual([
      'Projects: 1',
      'Sessions: 0 running, 1 waiting for you, 1 in all',
      'Pending asks: 1',
    ])
    await finished(waiting)
    await waiting.daemon.stop()
  })
})

describe('bytebureau ask answer through the daemon', () => {
  it('refuses to answer with nothing to answer with, and with an option the ask does not have', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    const { id, env } = waiting
    const needs = await runCli(['ask', 'answer', id], env)
    const unknown = await runCli(['ask', 'answer', id, '--option', 'nope'], env)
    expect([needs.code, needs.stderr.trim()]).toStrictEqual([
      1,
      `Ask ${id} needs --option or --other outside a terminal`,
    ])
    expect([unknown.code, unknown.stderr.trim()]).toStrictEqual([1, `ask ${id} has no option nope`])
    await finished(waiting)
    await waiting.daemon.stop()
  })

  it('answers with the recommended option for --yes, and the run completes', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    const { id, env } = waiting
    const answered = await runCli(['ask', 'answer', id, '--yes'], env)
    const run = await waiting.run
    expect([answered.code, answered.stdout.trim()]).toStrictEqual([0, `Answered ${id}`])
    expect([run.code, jsonLines(run.stdout).at(-1)]).toMatchObject([
      0,
      { type: 'session.completed' },
    ])
    await waiting.daemon.stop()
  })

  it('refuses an ask that is answered already', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    await finished(waiting)
    const { id, env } = waiting
    const again = await runCli(['ask', 'answer', id, '--yes'], env)
    expect([again.code, again.stderr.trim()]).toStrictEqual([1, `Ask ${id} is not pending`])
    await waiting.daemon.stop()
  })
})

describe('bytebureau ask answer with a global flag before the group', () => {
  it('keeps --other with no text from taking the flag that moved behind the group for its text', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    const { id, env } = waiting
    const refused = await runCli(['--json', 'ask', 'answer', id, '--other'], env)
    expect([refused.code, refused.stdout]).toStrictEqual([1, ''])
    expect(jsonLines(refused.stderr)).toStrictEqual([
      { level: 'warn', message: `Ask ${id} needs --option or --other outside a terminal` },
    ])
    await finished(waiting)
    await waiting.daemon.stop()
  })
})

describe('bytebureau ask answer with options and words', () => {
  it('answers with an option for each question, spelled apart from its id or with an equals sign', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    const answered = await answeredWith(waiting, ['--option', 'yes', '--option=default'])
    expect(answered).toMatchObject([0, 0, { answer: { selected: ['yes', 'default'] } }])
  })

  it('answers with the words of the person when the ask allows them', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    const answered = await answeredWith(waiting, ['--other', 'A barrel file'])
    expect(answered).toMatchObject([
      0,
      0,
      { answer: { selected: 'other', otherText: 'A barrel file' } },
    ])
  })
})

describe('bytebureau ask in the process of the command', () => {
  it('lists nothing, as JSON', async () => {
    expect.hasAssertions()
    const listed = await runCli(['ask', 'ls', '--json', NO_DAEMON], { BYTEBUREAU_HOME: testHome() })
    expect(jsonLines(listed.stdout)).toStrictEqual([{ command: 'ask.ls', asks: [] }])
  })

  it('refuses an ask that is not there', async () => {
    expect.hasAssertions()
    const env = { BYTEBUREAU_HOME: testHome() }
    const missing = await runCli(['ask', 'answer', 'a0', '--yes', NO_DAEMON], env)
    expect([missing.code, missing.stderr.trim()]).toStrictEqual([1, 'Ask a0 is not pending'])
  })
})
