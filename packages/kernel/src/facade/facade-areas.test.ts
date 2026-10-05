import { describe, expect, it } from 'vitest'
import { AskError, ConfigError, ProfileError, SessionError, WorkspaceError } from '../errors.js'
import { eventsUntil, openKernel, startFakeSession } from './facade-fixtures.js'
import { createTempRepo } from '../testing/temp-repo.js'

describe('the projects of the facade', () => {
  it('registers a repository, lists and reads it, and removes it again', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    const project = await kernel.projects.register(createTempRepo())
    const listed = await kernel.projects.list()
    const found = await kernel.projects.get(project.id)
    await kernel.projects.remove(project.id)
    const gone = await kernel.projects.get(project.id)
    expect([listed, found, gone]).toStrictEqual([[project], project, undefined])
  })
})

describe('the configuration of the facade', () => {
  it('resolves the configuration of a project with the environment it was opened with', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const kernel = await openKernel({ env: { BYTEBUREAU_LOG_LEVEL: 'debug' } })
    const config = await kernel.config.load(repo)
    const issues = await kernel.config.validate(repo)
    expect(config).toMatchObject({ projectPath: repo, project: { logging: { level: 'debug' } } })
    expect(issues).toStrictEqual([])
  })

  it('validates with the environment it was opened with, naming the variable of a bad value', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const kernel = await openKernel({ env: { BYTEBUREAU_LOG_LEVEL: 'loud' } })
    const issues = await kernel.config.validate(repo)
    expect(issues).toMatchObject([{ file: 'env:BYTEBUREAU_LOG_LEVEL', pointer: '/logging/level' }])
  })

  it('offers the JSON schema of the configuration without a promise', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    expect(kernel.config.schema()).toHaveProperty('$schema')
  })
})

describe('the sessions of the facade', () => {
  it('lists and reads its sessions, stops one and resumes it', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    const session = await startFakeSession(kernel)
    const listed = await kernel.sessions.list()
    await kernel.sessions.stop(session.id)
    const stopped = await kernel.sessions.get(session.id)
    const resumed = await kernel.sessions.resume(session.id)
    expect(listed.map((each) => each.id)).toStrictEqual([session.id])
    expect(stopped).toMatchObject({ id: session.id, status: 'stopped' })
    expect(resumed).toMatchObject({ id: session.id, status: 'ready' })
  })

  it('has no ask pending and no usage for a session that has not been prompted', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    const session = await startFakeSession(kernel)
    const pending = await kernel.asks.pending(session.id)
    const usage = await kernel.usage.session(session.id)
    expect(pending).toStrictEqual([])
    expect(usage).toMatchObject({ turns: 0, costUsd: null })
  })

  it('reads the events of a session from the log, in the order they happened', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    const session = await startFakeSession(kernel)
    const events = await kernel.events.read({ sessionId: session.id }, { from: 0 })
    expect(events.map((event) => event.type)).toStrictEqual([
      'session.created',
      'session.provisioning',
      'workspace.provisioned',
      'session.ready',
    ])
  })
})

describe('the asks of the facade', () => {
  it('reads an ask by its id, and nothing for an id nobody holds', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    const session = await startFakeSession(kernel)
    const events = kernel.events.subscribe({ sessionId: session.id, since: 0 })
    await kernel.sessions.prompt(session.id, { text: 'go' })
    await eventsUntil(events, (event) => event.type === 'ask.requested')
    const pending = await kernel.asks.pending(session.id)
    const read = await Promise.all(
      pending.map(async (ask) => {
        const found = await kernel.asks.get(ask.id)
        return found
      }),
    )
    expect([pending.length, read]).toStrictEqual([1, pending])
    await expect(kernel.asks.get('nobody')).resolves.toBeUndefined()
  })
})

describe('the workspaces of the facade', () => {
  it('lists the worktree of a session and keeps it while the session is ready', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    const session = await startFakeSession(kernel)
    const listed = await kernel.workspaces.list(session.projectId)
    const report = await kernel.workspaces.prune(session.projectId)
    expect(listed.map((info) => [info.sessionId, info.sessionStatus, info.exists])).toStrictEqual([
      [session.id, 'ready', true],
    ])
    expect(report.removed).toStrictEqual([])
    expect(report.retained.map((kept) => kept.reason)).toStrictEqual(['session is ready'])
  })
})

describe('the profiles of the facade', () => {
  it('adds, lists, reads, makes the default, tells the status of and removes a profile', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    const work = await kernel.profiles.add({ providerId: 'fake', name: 'work', kind: 'login' })
    const key = await kernel.profiles.add({
      providerId: 'fake',
      name: 'key',
      kind: 'api_key',
      apiKey: 'sk-canary-f',
    })
    await kernel.profiles.setDefault(key.id)
    const status = await kernel.profiles.status(work.id)
    const listed = await kernel.profiles.list()
    await kernel.profiles.remove('fake/key')
    const read = await Promise.all([kernel.profiles.get(work.id), kernel.profiles.get('fake/key')])
    expect([
      status.state,
      listed.map((profile) => [profile.id, profile.isDefault]),
      read,
    ]).toStrictEqual([
      'loggedIn',
      [
        ['fake/work', false],
        ['fake/key', true],
      ],
      [{ ...work, isDefault: true }, undefined],
    ])
  })
})

describe('the usage of the facade', () => {
  it('tells an empty snapshot of a profile no rate limit was seen under, and refuses a profile nobody holds', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    await kernel.profiles.add({ providerId: 'fake', name: 'work', kind: 'login' })
    await expect(kernel.usage.profile('fake/work')).resolves.toStrictEqual({
      profileId: 'fake/work',
      rateLimit: {},
      observedAt: null,
    })
    await expect(kernel.usage.profile('fake/nope')).rejects.toMatchObject({
      _tag: 'ProfileError',
      code: 'not_found',
      reason: 'no profile "fake/nope"',
    })
  })
})

describe('the failures of the facade', () => {
  it('rejects with the errors of the sessions and of the asks as they are', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    await expect(kernel.sessions.prompt('x', { text: 'y' })).rejects.toBeInstanceOf(SessionError)
    await expect(kernel.sessions.interrupt('x')).rejects.toBeInstanceOf(SessionError)
    await expect(kernel.asks.answer('x', { selected: [] }, 'cli')).rejects.toBeInstanceOf(AskError)
  })

  it('rejects with the errors of the projects and of the configuration as they are', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    await expect(kernel.projects.register('/')).rejects.toBeInstanceOf(WorkspaceError)
    await expect(kernel.config.load('/no/such/dir')).rejects.toBeInstanceOf(ConfigError)
  })

  it('rejects with the errors of the profiles as they are', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    await expect(kernel.profiles.remove('fake/nope')).rejects.toBeInstanceOf(ProfileError)
    await expect(kernel.profiles.status('fake/nope')).rejects.toBeInstanceOf(ProfileError)
  })
})
