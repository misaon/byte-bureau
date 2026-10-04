import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { startDaemonProcess } from '../testing/daemon.js'
import { eventLines, payloadOf } from '../testing/json-lines.js'
import { runCli, type CliResult } from '../testing/run-cli.js'
import { FAKE, PROMPT, workbench } from '../testing/workbench.js'

const DEVELOPER = {
  name: 'Developer',
  provider: 'fake',
  model: 'any',
  permissionMode: 'supervised',
}

// A project file with two employees, the developer by default
function twoEmployees(repo: string): void {
  const employees = { developer: DEVELOPER, reviewer: { ...DEVELOPER, name: 'Reviewer' } }
  const config = { version: 1, project: { name: 'fixture' }, employees }
  writeFileSync(path.join(repo, 'bytebureau.json'), JSON.stringify(config))
}

describe('bytebureau run and the environment', () => {
  it('runs the employee BYTEBUREAU_EMPLOYEE names, and the one --employee names over it', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    twoEmployees(repo)
    const env = { BYTEBUREAU_HOME: home, BYTEBUREAU_EMPLOYEE: 'reviewer' }
    const byEnv = await runCli(['run', PROMPT, '--project', repo, ...FAKE], env)
    const byFlag = await runCli(
      ['run', PROMPT, '--project', repo, ...FAKE, '--employee', 'developer'],
      env,
    )
    expect([byEnv.code, byFlag.code]).toStrictEqual([0, 0])
    const employees = [byEnv, byFlag].map((result) =>
      payloadOf(eventLines(result.stdout), 'session.created'),
    )
    expect(employees).toMatchObject([{ employeeId: 'reviewer' }, { employeeId: 'developer' }])
  })
})

// A run whose environment names the slow script and the reviewer, stopped once its turn has started
async function slowReviewerRun(repo: string, home: string): Promise<CliResult> {
  const env = {
    BYTEBUREAU_HOME: home,
    BYTEBUREAU_FAKE_SCRIPT: 'slow',
    BYTEBUREAU_EMPLOYEE: 'reviewer',
  }
  const result = await runCli(
    ['run', PROMPT, '--project', repo, '--provider', 'fake', '--json', '--yes'],
    env,
    { signal: 'SIGTERM', afterStdout: '"type":"turn.started"' },
  )
  return result
}

describe('bytebureau run through the daemon and the environment of the command', () => {
  it('hands its BYTEBUREAU_* variables to the session, and runs the employee they name', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    twoEmployees(repo)
    // The daemon has neither variable: the run brings them
    const daemon = await startDaemonProcess(home)
    const result = await slowReviewerRun(repo, home)
    const events = eventLines(result.stdout)
    // The slow script works until it is stopped, without a word; the default one asks before it writes
    expect(events.map((event) => event.type)).not.toContain('ask.requested')
    expect(payloadOf(events, 'session.created')).toMatchObject({ employeeId: 'reviewer' })
    expect([result.code, events.at(-1)]).toMatchObject([3, { type: 'session.stopped' }])
    await daemon.stop()
  })
})
