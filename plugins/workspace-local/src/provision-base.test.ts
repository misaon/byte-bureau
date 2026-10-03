import path from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  createRuntime,
  recordingLogger,
  scriptedSpawner,
  spySpawner,
  versionSpawner,
  workspaceSpec,
  type SpawnCall,
} from './testing/fixtures.js'
import { nodeSpawner } from './testing/node-spawner.js'
import { createTempRepo, git, tempDir } from './testing/temp-repo.js'

const fetches = (calls: readonly SpawnCall[]): readonly SpawnCall[] =>
  calls.filter((call) => call.args[0] === 'fetch')

// Pushes one commit to origin from a second clone and returns its id
function pushFromElsewhere(repo: string): string {
  const clone = path.join(tempDir('bb-clone-'), 'work')
  git(repo, 'clone', '-q', git(repo, 'remote', 'get-url', 'origin'), clone)
  git(clone, 'commit', '--allow-empty', '-q', '-m', 'from elsewhere')
  git(clone, 'push', '-q', 'origin', 'main')
  return git(clone, 'rev-parse', 'HEAD')
}

describe('base ref', () => {
  it('starts from the freshly fetched origin/<branch> when a remote exists', async () => {
    expect.hasAssertions()
    const repo = createTempRepo({ withRemote: true })
    const pushed = pushFromElsewhere(repo)
    const handle = await createRuntime().provision(workspaceSpec(repo))
    expect(handle.baseRef).toBe('origin/main')
    expect(git(handle.path, 'rev-parse', 'HEAD')).toBe(pushed)
    expect(git(repo, 'rev-parse', 'main')).not.toBe(pushed)
  })

  it('falls back to the local branch when the remote does not have it', async () => {
    expect.hasAssertions()
    const repo = createTempRepo({ withRemote: true })
    git(repo, 'branch', 'develop')
    const spec = workspaceSpec(repo, { baseBranch: 'develop' })
    const handle = await createRuntime().provision(spec)
    expect(handle.baseRef).toBe('develop')
  })
})

describe('new branch', () => {
  it('has no upstream, so a push does not aim at the base branch', async () => {
    expect.hasAssertions()
    const repo = createTempRepo({ withRemote: true })
    const handle = await createRuntime().provision(workspaceSpec(repo))
    expect(handle.baseRef).toBe('origin/main')
    expect(git(repo, 'for-each-ref', '--format=%(upstream)', 'refs/heads/bb/add-hello')).toBe('')
  })
})

describe('git environment', () => {
  it('runs every git command without a terminal prompt', async () => {
    expect.hasAssertions()
    const { spawner, calls } = spySpawner()
    const spec = workspaceSpec(createTempRepo({ withRemote: true }))
    await createRuntime(spawner).provision(spec)
    expect(fetches(calls)).toHaveLength(1)
    expect(calls.filter((call) => call.env['GIT_TERMINAL_PROMPT'] !== '0')).toStrictEqual([])
  })
})

describe('fetching', () => {
  it('fetches once per minute and project', async () => {
    expect.hasAssertions()
    const first = createTempRepo({ withRemote: true })
    const second = createTempRepo({ withRemote: true })
    const { spawner, calls } = spySpawner()
    const runtime = createRuntime(spawner)
    await runtime.provision(workspaceSpec(first, { sessionId: 'one', branch: 'bb/one' }))
    await runtime.provision(workspaceSpec(first, { sessionId: 'two', branch: 'bb/two' }))
    await runtime.provision(workspaceSpec(second))
    expect(fetches(calls)).toHaveLength(2)
  })

  it('fetches again once a minute has passed', async () => {
    expect.hasAssertions()
    vi.useFakeTimers({ toFake: ['Date'] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const repo = createTempRepo({ withRemote: true })
    const { spawner, calls } = spySpawner()
    const runtime = createRuntime(spawner)
    await runtime.provision(workspaceSpec(repo, { sessionId: 'one', branch: 'bb/one' }))
    vi.setSystemTime(Date.now() + 61_000)
    await runtime.provision(workspaceSpec(repo, { sessionId: 'two', branch: 'bb/two' }))
    expect(fetches(calls)).toHaveLength(2)
  })

  it('goes on with the last known refs and tells the session when the fetch fails', async () => {
    expect.hasAssertions()
    const repo = createTempRepo({ withRemote: true })
    git(repo, 'remote', 'set-url', 'origin', path.join(tempDir('bb-gone-'), 'missing'))
    const session = recordingLogger()
    const daemon = recordingLogger()
    const spec = workspaceSpec(repo, { logger: session.logger })
    const handle = await createRuntime(nodeSpawner, daemon.logger).provision(spec)
    expect(handle.baseRef).toBe('origin/main')
    expect(session.entries.filter((entry) => entry.level === 'warn')).toHaveLength(1)
    expect(daemon.entries.filter((entry) => entry.level === 'warn')).toStrictEqual([])
  })
})

describe('git version', () => {
  it('treats a git that fails to run as too old', async () => {
    expect.hasAssertions()
    const runtime = createRuntime(scriptedSpawner(() => 'process.exit(127)'))
    const failure = runtime.provision(workspaceSpec(tempDir('bb-plain-')))
    await expect(failure).rejects.toMatchObject({ code: 'git_too_old' })
  })

  it.each([
    ['1.9.9', 'git_too_old'],
    ['2.39.5', 'git_too_old'],
    ['unknown', 'git_too_old'],
    ['2.40.0', 'not_a_repository'],
    ['3.1.0', 'not_a_repository'],
  ])('with git %s, provisioning fails with %s', async (version, code) => {
    expect.hasAssertions()
    const runtime = createRuntime(versionSpawner(version))
    const failure = runtime.provision(workspaceSpec(tempDir('bb-plain-')))
    await expect(failure).rejects.toMatchObject({ code })
  })
})
