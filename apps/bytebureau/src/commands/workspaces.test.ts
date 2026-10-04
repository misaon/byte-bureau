import { describe, expect, it } from 'vitest'
import { jsonLines } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import { tempDir } from '../testing/temp-repo.js'
import { fakeRun, NO_DAEMON, workbench, worktreesOf } from '../testing/workbench.js'

describe('bytebureau workspaces', () => {
  it('lists nothing before any session ran', async () => {
    expect.hasAssertions()
    const listed = await runCli(['workspaces', 'ls', NO_DAEMON], {
      BYTEBUREAU_HOME: tempDir('bb-home-'),
    })
    expect(listed.stdout.trim()).toBe('No workspaces')
  })

  it('lists the worktree of a session with its branch and the status of the session', async () => {
    expect.hasAssertions()
    const bench = workbench()
    await fakeRun(bench)
    const listed = await runCli(['workspaces', 'ls', NO_DAEMON], {
      BYTEBUREAU_HOME: bench.home,
    })
    expect(listed.code).toBe(0)
    const [line = ''] = listed.stdout.trim().split('\n')
    expect(line).toMatch(/^\S+ {2}bb\/\S+ {2}completed {2}/u)
    expect(line).toContain(worktreesOf(bench.repo))
  })

  it('tells the worktrees as JSON, with whether each is still on disk', async () => {
    expect.hasAssertions()
    const bench = workbench()
    await fakeRun(bench)
    const listed = await runCli(['workspaces', 'ls', '--json', NO_DAEMON], {
      BYTEBUREAU_HOME: bench.home,
    })
    expect(jsonLines(listed.stdout)).toMatchObject([
      {
        command: 'workspaces.ls',
        workspaces: [{ sessionStatus: 'completed', exists: true, baseRef: 'main' }],
      },
    ])
  })

  it('lists only the worktrees of the project it is asked for', async () => {
    expect.hasAssertions()
    const bench = workbench()
    await fakeRun(bench)
    const listed = await runCli(['workspaces', 'ls', '--project', 'nobody', NO_DAEMON], {
      BYTEBUREAU_HOME: bench.home,
    })
    expect(listed.stdout.trim()).toBe('No workspaces')
  })
})

describe('bytebureau workspaces prune', () => {
  it('has nothing to prune before any session ran', async () => {
    expect.hasAssertions()
    const pruned = await runCli(['workspaces', 'prune', NO_DAEMON], {
      BYTEBUREAU_HOME: tempDir('bb-home-'),
    })
    expect(pruned.code).toBe(0)
    expect(pruned.stdout.trim()).toBe('Removed 0 worktree(s), kept 0')
  })

  it('keeps the worktree of a session that ended a moment ago and says why', async () => {
    expect.hasAssertions()
    const bench = workbench()
    await fakeRun(bench)
    const pruned = await runCli(['workspaces', 'prune', NO_DAEMON], {
      BYTEBUREAU_HOME: bench.home,
    })
    expect(pruned.code).toBe(0)
    const lines = pruned.stdout.trim().split('\n')
    expect(lines[0]).toMatch(/^.+: younger than 7 days$/u)
    expect(lines.at(-1)).toBe('Removed 0 worktree(s), kept 1')
  })
})
