import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { jsonLines } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import { tempDir } from '../testing/temp-repo.js'
import { fakeRun, NO_DAEMON, projectIdIn, workbench } from '../testing/workbench.js'

describe('bytebureau projects', () => {
  it('lists nothing before a project is registered', async () => {
    expect.hasAssertions()
    const result = await runCli(['projects', 'ls', NO_DAEMON], {
      BYTEBUREAU_HOME: tempDir('bb-home-'),
    })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('No projects registered')
  })

  it('registers a project and lists it with its path and default branch', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const env = { BYTEBUREAU_HOME: home }
    const added = await runCli(['projects', 'add', repo, NO_DAEMON], env)
    expect(added.code).toBe(0)
    expect(added.stdout).toMatch(/^Registered .+ \(.+\)$/mu)
    const listed = await runCli(['projects', 'ls', '--json', NO_DAEMON], env)
    expect(jsonLines(listed.stdout)).toMatchObject([
      { command: 'projects.ls', projects: [{ path: repo, defaultBranch: 'main' }] },
    ])
  })

  it('removes a project again', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const env = { BYTEBUREAU_HOME: home }
    await runCli(['projects', 'add', repo, NO_DAEMON], env)
    const id = await projectIdIn(home)
    const removed = await runCli(['projects', 'rm', id, NO_DAEMON], env)
    expect(removed.code).toBe(0)
    expect(removed.stdout.trim()).toBe(`Removed ${id}`)
    const after = await runCli(['projects', 'ls', NO_DAEMON], env)
    expect(after.stdout.trim()).toBe('No projects registered')
  })
})

describe('bytebureau projects when it cannot do what it is asked', () => {
  it('refuses a path that is no git repository with the reason, and registers nothing', async () => {
    expect.hasAssertions()
    const env = { BYTEBUREAU_HOME: tempDir('bb-home-') }
    const plain = tempDir('bb-plain-')
    const added = await runCli(['projects', 'add', plain, NO_DAEMON], env)
    expect(added.code).toBe(1)
    expect(added.stderr.trim()).toBe(`${plain} is not inside a git repository`)
    const listed = await runCli(['projects', 'ls', NO_DAEMON], env)
    expect(listed.stdout.trim()).toBe('No projects registered')
  })

  it('refuses to remove a project nobody registered, as the daemon does, with exit 1', async () => {
    expect.hasAssertions()
    const env = { BYTEBUREAU_HOME: tempDir('bb-home-') }
    const removed = await runCli(['projects', 'rm', 'p-unknown', NO_DAEMON], env)
    expect([removed.code, removed.stderr.trim(), removed.stdout]).toStrictEqual([
      1,
      'no project p-unknown',
      '',
    ])
  })

  it('does not remove a project that has sessions, says why in one line and exits 1', async () => {
    expect.hasAssertions()
    const bench = workbench()
    await fakeRun(bench)
    const id = await projectIdIn(bench.home)
    const env = { BYTEBUREAU_HOME: bench.home }
    const removed = await runCli(['projects', 'rm', id, NO_DAEMON], env)
    expect(removed.code).toBe(1)
    expect(removed.stderr.trim()).toBe(`project ${path.basename(bench.repo)} still has 1 session`)
    const listed = await runCli(['projects', 'ls', '--json', NO_DAEMON], env)
    expect(jsonLines(listed.stdout)).toMatchObject([{ projects: [{ id }] }])
  })
})
