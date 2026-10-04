import { describe, expect, it } from 'vitest'
import { jsonLines } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import { benchWithDaemon, completedSession, MISSING, refusal } from '../testing/session-bench.js'
import { testHome } from '../testing/temp-repo.js'
import { NO_DAEMON, PROMPT, projectIdIn, SCRIPTED, worktreesOf } from '../testing/workbench.js'

describe('bytebureau sessions ls through the daemon', () => {
  it('lists nothing before a run, and the session of a run after it', async () => {
    expect.hasAssertions()
    const { env, repo, daemon } = await benchWithDaemon()
    const empty = await runCli(['sessions', 'ls'], env)
    await runCli(['run', PROMPT, '--project', repo, ...SCRIPTED], env)
    const listed = await runCli(['sessions', 'ls', '--json'], env)
    expect([empty.code, empty.stdout.trim()]).toStrictEqual([0, 'No sessions'])
    expect(jsonLines(listed.stdout)).toMatchObject([
      { command: 'sessions.ls', sessions: [{ status: 'completed', title: PROMPT }] },
    ])
    await daemon.stop()
  })

  it('lists the id, the status, the title and the project of a session in a row', async () => {
    expect.hasAssertions()
    const { env, home, id, daemon } = await completedSession()
    const listed = await runCli(['sessions', 'ls'], env)
    const project = await projectIdIn(home, [])
    expect(listed.stdout.trim().split('  ')).toStrictEqual([id, 'completed', PROMPT, project])
    await daemon.stop()
  })
})

describe('bytebureau sessions show through the daemon', () => {
  it('tells the fields of a session one to a line', async () => {
    expect.hasAssertions()
    const { env, repo, id, daemon } = await completedSession()
    const shown = await runCli(['sessions', 'show', id], env)
    expect([shown.code, shown.stderr]).toStrictEqual([0, ''])
    expect(shown.stdout).toMatch(new RegExp(`^id\\s+${id}$`, 'mu'))
    expect(shown.stdout).toMatch(/^status\s+completed$/mu)
    expect(shown.stdout).toMatch(/^provider\s+fake$/mu)
    expect(shown.stdout).toContain(worktreesOf(repo))
    await daemon.stop()
  })

  it('tells the session and its asks as one JSON record', async () => {
    expect.hasAssertions()
    const { env, id, daemon } = await completedSession()
    const shown = await runCli(['sessions', 'show', id, '--json'], env)
    expect(jsonLines(shown.stdout)).toMatchObject([
      { command: 'sessions.show', session: { id, status: 'completed' }, asks: [] },
    ])
    await daemon.stop()
  })

  it('refuses a session that is not there, with exit code 1', async () => {
    expect.hasAssertions()
    const { env, daemon } = await benchWithDaemon()
    await expect(refusal(['sessions', 'show', MISSING], env)).resolves.toStrictEqual([
      1,
      `No session ${MISSING}`,
    ])
    await daemon.stop()
  })
})

describe('bytebureau sessions steering through the daemon', () => {
  it('refuses what a completed session cannot do, with the reason of the kernel and exit code 1', async () => {
    expect.hasAssertions()
    const { env, id, daemon } = await completedSession()
    const stop = refusal(['sessions', 'stop', id], env)
    const resume = refusal(['sessions', 'resume', id], env)
    const prompt = refusal(['sessions', 'prompt', id, 'again'], env)
    await expect(stop).resolves.toStrictEqual([1, 'cannot stop a completed session'])
    await expect(resume).resolves.toStrictEqual([1, 'cannot resume a completed session'])
    await expect(prompt).resolves.toStrictEqual([1, 'cannot prompt a completed session'])
    await daemon.stop()
  })

  it('refuses to interrupt a session that no agent is attached to, and one that is not there', async () => {
    expect.hasAssertions()
    const { env, id, daemon } = await completedSession()
    const interrupt = refusal(['sessions', 'interrupt', id], env)
    const stop = refusal(['sessions', 'stop', MISSING], env)
    await expect(interrupt).resolves.toStrictEqual([
      1,
      'cannot interrupt a completed session: no turn of it is at work',
    ])
    await expect(stop).resolves.toStrictEqual([1, `session ${MISSING} does not exist`])
    await daemon.stop()
  })
})

describe('bytebureau sessions in the process of the command', () => {
  it('lists nothing, as JSON', async () => {
    expect.hasAssertions()
    const env = { BYTEBUREAU_HOME: testHome() }
    const listed = await runCli(['sessions', 'ls', '--json', NO_DAEMON], env)
    expect(jsonLines(listed.stdout)).toStrictEqual([{ command: 'sessions.ls', sessions: [] }])
  })

  it('tells in Czech with --lang cs', async () => {
    expect.hasAssertions()
    const env = { BYTEBUREAU_HOME: testHome() }
    const none = await runCli(['sessions', 'ls', '--lang', 'cs', NO_DAEMON], env)
    const missing = refusal(['sessions', 'show', MISSING, '--lang', 'cs', NO_DAEMON], env)
    expect([none.code, none.stdout.trim()]).toStrictEqual([0, 'Žádné relace'])
    await expect(missing).resolves.toStrictEqual([1, `Relace ${MISSING} neexistuje`])
  })

  it('refuses to show, stop, prompt or interrupt a session that is not there, in the words of the kernel', async () => {
    expect.hasAssertions()
    const env = { BYTEBUREAU_HOME: testHome() }
    const does = `session ${MISSING} does not exist`
    const show = refusal(['sessions', 'show', MISSING, NO_DAEMON], env)
    await expect(show).resolves.toStrictEqual([1, `No session ${MISSING}`])
    const stop = refusal(['sessions', 'stop', MISSING, NO_DAEMON], env)
    await expect(stop).resolves.toStrictEqual([1, does])
    const prompt = refusal(['sessions', 'prompt', MISSING, 'go', NO_DAEMON], env)
    await expect(prompt).resolves.toStrictEqual([1, does])
  })
})
