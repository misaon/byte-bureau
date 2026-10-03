import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { eventLines, payloadOf } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
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
