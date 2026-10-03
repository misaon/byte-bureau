import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { ConfigError, StoreError, WorkspaceError } from '../errors.js'
import { EventLog } from '../events/event-log.js'
import { createTempRepo, tempDir } from '../testing/temp-repo.js'
import { ProjectRegistry } from './project-registry.js'
import {
  namedRepo,
  registerAt,
  TestLayer,
  trackingDevelop,
  writeProjectFile,
} from './project-registry-fixtures.js'

it.layer(TestLayer)('ProjectRegistry register', (suite) => {
  suite.effect('registers a repository once, whichever directory inside it is given', () =>
    Effect.gen(function* registersOnce() {
      const registry = yield* ProjectRegistry
      const repo = createTempRepo()
      mkdirSync(path.join(repo, 'src'), { recursive: true })
      const first = yield* registry.register(path.join(repo, 'src'))
      const second = yield* registry.register(repo)
      assert.strictEqual(second.id, first.id)
      const registered = [first.path, first.name, first.defaultBranch]
      assert.deepStrictEqual(registered, [repo, path.basename(repo), 'main'])
      const stored = (yield* registry.list()).filter((project) => project.path === repo)
      assert.deepStrictEqual(stored, [second])
    }),
  )

  suite.effect('announces the registration and every later update with the stored identity', () =>
    Effect.gen(function* announcesProject() {
      const registry = yield* ProjectRegistry
      const log = yield* EventLog
      const repo = createTempRepo()
      const first = yield* registry.register(repo)
      yield* registry.register(repo)
      const events = yield* log.read({ projectId: first.id }, { from: 0 })
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ['project.registered', 'project.updated'],
      )
      const identity = { id: first.id, name: first.name, path: repo, defaultBranch: 'main' }
      const payloads = events.map((event) => event.payload)
      assert.deepStrictEqual(payloads, [identity, identity])
    }),
  )

  suite.effect(
    'names the project after its project file and keeps the resolved configuration',
    () =>
      Effect.gen(function* snapshotsConfiguration() {
        const registry = yield* ProjectRegistry
        const project = yield* registry.register(namedRepo('Demo'))
        assert.strictEqual(project.name, 'Demo')
        assert.strictEqual(project.config.project.name, 'Demo')
        assert.deepStrictEqual(project.config.defaults, { employee: 'developer' })
        assert.deepStrictEqual(yield* registry.get(project.id), project)
      }),
  )
})

it.layer(TestLayer)('ProjectRegistry refresh', (suite) => {
  suite.effect('refreshes the name, default branch and configuration of a known repository', () =>
    Effect.gen(function* refreshesProject() {
      const registry = yield* ProjectRegistry
      const repo = createTempRepo()
      const first = yield* registerAt(registry, repo, '2026-10-03T08:00:00.000Z')
      writeProjectFile(repo, { name: 'renamed', defaultBranch: 'develop' })
      const second = yield* registerAt(registry, repo, '2026-10-03T09:30:00.000Z')
      assert.deepStrictEqual(
        [second.id, second.createdAt, second.updatedAt],
        [first.id, '2026-10-03T08:00:00.000Z', '2026-10-03T09:30:00.000Z'],
      )
      assert.deepStrictEqual([second.name, second.defaultBranch], ['renamed', 'develop'])
      assert.deepStrictEqual(second.config.project, { name: 'renamed', defaultBranch: 'develop' })
      assert.deepStrictEqual(yield* registry.get(first.id), second)
    }),
  )

  suite.effect('takes the default branch from the configuration, else from origin/HEAD', () =>
    Effect.gen(function* resolvesDefaultBranch() {
      const registry = yield* ProjectRegistry
      const detected = trackingDevelop()
      const configured = trackingDevelop()
      writeProjectFile(configured, { name: 'configured', defaultBranch: 'trunk' })
      assert.strictEqual((yield* registry.register(detected)).defaultBranch, 'develop')
      assert.strictEqual((yield* registry.register(configured)).defaultBranch, 'trunk')
    }),
  )
})

it.layer(TestLayer)('ProjectRegistry refusals', (suite) => {
  suite.effect('refuses directories that are not repositories or are ByteBureau worktrees', () =>
    Effect.gen(function* refusesDirectories() {
      const registry = yield* ProjectRegistry
      const before = yield* registry.list()
      const plain = yield* Effect.flip(registry.register(tempDir('bb-plain-')))
      const repo = createTempRepo()
      writeFileSync(path.join(repo, '.bytebureau-session.json'), '{}')
      const worktree = yield* Effect.flip(registry.register(repo))
      assert.instanceOf(plain, WorkspaceError)
      assert.instanceOf(worktree, WorkspaceError)
      assert.deepStrictEqual(
        [plain.code, worktree.code],
        ['not_a_repository', 'is_bytebureau_worktree'],
      )
      assert.deepStrictEqual(yield* registry.list(), before)
    }),
  )

  suite.effect('fails with the configuration error and stores nothing for an invalid file', () =>
    Effect.gen(function* refusesInvalidConfiguration() {
      const registry = yield* ProjectRegistry
      const before = yield* registry.list()
      const repo = createTempRepo()
      writeProjectFile(repo, { name: 'x', extra: true })
      const failure = yield* Effect.flip(registry.register(repo))
      assert.instanceOf(failure, ConfigError)
      assert.strictEqual(failure.pointer, '/project/extra')
      assert.deepStrictEqual(yield* registry.list(), before)
    }),
  )
})

it.layer(TestLayer)('ProjectRegistry list, get and remove', (suite) => {
  suite.effect('lists projects by name and finds none for an unknown id', () =>
    Effect.gen(function* listsByName() {
      const registry = yield* ProjectRegistry
      const beta = yield* registry.register(namedRepo('beta'))
      const alpha = yield* registry.register(namedRepo('alpha'))
      const ids = new Set([alpha.id, beta.id])
      const ours = (yield* registry.list()).filter((project) => ids.has(project.id))
      assert.deepStrictEqual(ours, [alpha, beta])
      assert.strictEqual(yield* registry.get('unknown'), undefined)
    }),
  )

  suite.effect(
    'removes a project and announces it, and announces nothing for an id nobody holds',
    () =>
      Effect.gen(function* removesProject() {
        const registry = yield* ProjectRegistry
        const log = yield* EventLog
        const project = yield* registry.register(createTempRepo())
        yield* registry.remove(project.id)
        yield* registry.remove('unknown')
        assert.strictEqual(yield* registry.get(project.id), undefined)
        const known = yield* log.read({ projectId: project.id }, { from: 0 })
        const unknown = yield* log.read({ projectId: 'unknown' }, { from: 0 })
        const types = [known, unknown].map((events) => events.map((event) => event.type))
        assert.deepStrictEqual(types, [['project.registered', 'project.removed'], []])
      }),
  )
})

it.effect('reports a failing statement as a StoreError from every operation', () =>
  Effect.gen(function* failsWithStoreError() {
    const sql = yield* SqlClient.SqlClient
    const registry = yield* ProjectRegistry
    yield* sql`DROP TABLE projects`
    const failures = [
      yield* Effect.flip(registry.register(createTempRepo())),
      yield* Effect.flip(registry.list()),
      yield* Effect.flip(registry.get('x')),
      yield* Effect.flip(registry.remove('x')),
    ]
    for (const failure of failures) {
      assert.instanceOf(failure, StoreError)
    }
  }).pipe(Effect.provide(TestLayer)),
)
