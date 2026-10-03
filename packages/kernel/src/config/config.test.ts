import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defaultProjectConfig } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect, Result, type Scope } from 'effect'
import { ConfigError } from '../errors.js'
import { Config, ConfigLive, type ConfigShape } from './config.js'
import { defaultProjectConfigText } from './template.js'

const PROJECT_FILE = 'bytebureau.json'
const USER_FILE = 'config.json'

interface Workspace {
  readonly config: ConfigShape
  readonly home: string
  readonly project: string
}

// Fixture directories are removed when the scope of their test closes
function tempDir(prefix: string): Effect.Effect<string, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), prefix))),
    (directory) =>
      Effect.sync(() => {
        rmSync(directory, { recursive: true, force: true })
      }),
  )
}

// Strings are written as they are, every other value as JSON
function write(directory: string, name: string, content: unknown): string {
  const file = path.join(directory, name)
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  return file
}

// ConfigLive is passed as a value: new-cap reports every call of a capitalised function
const configIn = (home: string): Effect.Effect<ConfigShape> =>
  Effect.succeed(home).pipe(
    Effect.map(ConfigLive),
    Effect.flatMap((layer) => Effect.provide(Config, layer)),
  )

function workspace(): Effect.Effect<Workspace, never, Scope.Scope> {
  return Effect.gen(function* emptyWorkspace() {
    const home = yield* tempDir('bb-home-')
    const project = yield* tempDir('bb-project-')
    const config = yield* configIn(home)
    return { config, home, project }
  })
}

// A user file, a project file with comments and a local file: every layer except the environment and the flags
function layered(): Effect.Effect<Workspace, never, Scope.Scope> {
  return Effect.gen(function* writeLayers() {
    const space = yield* workspace()
    write(space.home, USER_FILE, { logging: { level: 'warn' }, defaults: { provider: 'fake' } })
    write(
      space.project,
      'bytebureau.jsonc',
      `{
  // project file wins over the user file
  "version": 1,
  "project": { "name": "demo", "defaultBranch": "develop" },
  "employees": { "dev": { "name": "Dev", "provider": "fake", "model": "m", "permissionMode": "autonomous" } },
  "defaults": { "employee": "dev" },
  "logging": { "level": "info" }
}`,
    )
    const local = { logging: { level: 'debug' }, workspace: { copyIgnored: ['.env.local'] } }
    write(space.project, 'bytebureau.local.json', local)
    return space
  })
}

// An unknown top-level key and a level outside the enum, next to otherwise valid sections
function broken(): Effect.Effect<Workspace, never, Scope.Scope> {
  return Effect.gen(function* writeBrokenProject() {
    const space = yield* workspace()
    const content = {
      version: 1,
      project: { name: 'x' },
      employees: {},
      logging: { level: 'loud' },
      extra: true,
    }
    write(space.project, PROJECT_FILE, content)
    return space
  })
}

it.effect('layers local over project over user over the defaults', () =>
  Effect.gen(function* layersFiles() {
    const { config, project } = yield* layered()
    const plain = yield* config.load({ projectPath: project })
    assert.deepStrictEqual(plain.project.logging, { level: 'debug' })
    assert.strictEqual(plain.project.project.defaultBranch, 'develop')
    assert.deepStrictEqual(plain.project.workspace, {
      runtime: 'local',
      copyIgnored: ['.env.local'],
      retainDays: 7,
    })
    assert.deepStrictEqual(plain.user.defaults, { provider: 'fake' })
  }),
)

it.effect('layers the environment over the files and the flags over the environment', () =>
  Effect.gen(function* layersEnvironmentAndFlags() {
    const { config, home, project } = yield* layered()
    const env = { BYTEBUREAU_LOG_LEVEL: 'error' }
    const withEnv = yield* config.load({ projectPath: project, env })
    assert.deepStrictEqual(withEnv.project.logging, { level: 'error' })
    const withFlags = yield* config.load({
      projectPath: project,
      env,
      flags: { logLevel: 'trace' },
    })
    assert.deepStrictEqual(withFlags.project.logging, { level: 'trace' })
    assert.strictEqual(withFlags.files.project, path.join(project, 'bytebureau.jsonc'))
    assert.strictEqual(withFlags.files.local, path.join(project, 'bytebureau.local.json'))
    assert.strictEqual(withFlags.files.user, path.join(home, USER_FILE))
  }),
)

it.effect('lets the project file override the user file', () =>
  Effect.gen(function* projectOverUser() {
    const { config, home, project } = yield* workspace()
    write(home, USER_FILE, { logging: { level: 'warn' } })
    write(project, PROJECT_FILE, { logging: { level: 'info' } })
    const resolved = yield* config.load({ projectPath: project })
    assert.deepStrictEqual(resolved.project.logging, { level: 'info' })
  }),
)

it.effect('maps every environment variable and flag to its section and skips empty values', () =>
  Effect.gen(function* mapsOverrides() {
    const { config, project } = yield* layered()
    const env = {
      BYTEBUREAU_EMPLOYEE: 'ops',
      BYTEBUREAU_BRANCH: 'release',
      BYTEBUREAU_WORKSPACE_RUNTIME: 'docker',
      BYTEBUREAU_LOG_LEVEL: '',
    }
    const fromEnv = yield* config.load({ projectPath: project, env })
    assert.deepStrictEqual(fromEnv.project.defaults, { employee: 'ops', branch: 'release' })
    assert.deepStrictEqual(fromEnv.project.workspace, {
      runtime: 'docker',
      copyIgnored: ['.env.local'],
      retainDays: 7,
    })
    assert.deepStrictEqual(fromEnv.project.logging, { level: 'debug' })
    const flags = { employee: 'lead', branch: 'hotfix' }
    const fromFlags = yield* config.load({ projectPath: project, env, flags })
    assert.deepStrictEqual(fromFlags.project.defaults, flags)
  }),
)

it.effect('falls back to defaults named after the directory when no project file exists', () =>
  Effect.gen(function* fallsBackToDefaults() {
    const { config, project } = yield* workspace()
    const resolved = yield* config.load({ projectPath: project })
    assert.strictEqual(resolved.project.project.name, path.basename(project))
    assert.deepStrictEqual(resolved.project.defaults, { employee: 'developer', branch: 'main' })
    assert.deepStrictEqual(resolved.files, { user: null, project: null, local: null })
  }),
)

it.effect('loads the user layer and the defaults when no project path is given', () =>
  Effect.gen(function* loadsWithoutProject() {
    const { config, home } = yield* workspace()
    const userFile = write(home, USER_FILE, { logging: { level: 'error' } })
    const resolved = yield* config.load({})
    assert.strictEqual(resolved.projectPath, null)
    assert.strictEqual(resolved.project.project.name, 'default')
    assert.deepStrictEqual(resolved.project.logging, { level: 'error' })
    assert.deepStrictEqual(resolved.files, { user: userFile, project: null, local: null })
  }),
)

it.effect('reports absolute file paths for a relative home directory', () =>
  Effect.gen(function* resolvesRelativeHome() {
    const { home } = yield* workspace()
    const userFile = write(home, USER_FILE, {})
    const config = yield* configIn(path.relative(process.cwd(), home))
    const resolved = yield* config.load({})
    assert.strictEqual(resolved.files.user, userFile)
  }),
)

it.effect('ignores a file named like the config but without an extension', () =>
  Effect.gen(function* ignoresBareName() {
    const { config, project } = yield* workspace()
    // A release binary downloaded into the project directory carries exactly this name
    write(project, 'bytebureau', '#!/bin/sh\nexit 0\n')
    const file = write(project, PROJECT_FILE, { project: { name: 'beside' } })
    const resolved = yield* config.load({ projectPath: project })
    assert.strictEqual(resolved.project.project.name, 'beside')
    assert.strictEqual(resolved.files.project, file)
  }),
)

it.effect('reports unknown keys and bad values with file and JSON pointer', () =>
  Effect.gen(function* reportsPointers() {
    const { config, project } = yield* broken()
    const issues = yield* config.validate(project)
    assert.deepStrictEqual(issues.map((issue) => issue.pointer).toSorted(), [
      '/extra',
      '/logging/level',
    ])
    assert.ok(issues.every((issue) => issue.file.endsWith(PROJECT_FILE)))
    const failure = yield* Effect.result(config.load({ projectPath: project }))
    assert.isTrue(Result.isFailure(failure))
  }),
)

it.effect('fails the load with one ConfigError that names the file and lists every issue', () =>
  Effect.gen(function* failsWithConfigError() {
    const { config, project } = yield* broken()
    const error = yield* Effect.flip(config.load({ projectPath: project }))
    assert.instanceOf(error, ConfigError)
    assert.strictEqual(error.file, path.join(project, PROJECT_FILE))
    assert.oneOf(error.pointer, ['/extra', '/logging/level'])
    assert.include(error.reason, '/extra: ')
    assert.include(error.reason, '/logging/level: ')
  }),
)

it.effect('escapes slashes and tildes in the segments of a pointer', () =>
  Effect.gen(function* escapesSegments() {
    const { config, project } = yield* workspace()
    write(project, PROJECT_FILE, { project: { name: 'x' }, employees: { 'a/b~c': {} } })
    const issues = yield* config.validate(project)
    assert.deepStrictEqual(
      issues.map((issue) => issue.pointer).toSorted(),
      ['model', 'name', 'permissionMode', 'provider'].map((key) => `/employees/a~1b~0c/${key}`),
    )
  }),
)

it.effect('reports a file that cannot be parsed as one issue instead of an empty document', () =>
  Effect.gen(function* reportsBrokenSyntax() {
    const { config, project } = yield* workspace()
    const file = write(project, PROJECT_FILE, '{ "version": 1,')
    const issues = yield* config.validate(project)
    assert.deepStrictEqual(
      issues.map((issue) => issue.file),
      [file],
    )
    const error = yield* Effect.flip(config.load({ projectPath: project }))
    assert.strictEqual(error.file, file)
  }),
)

// The bad level reaches the project layering too; the user file is still the one to blame
it.effect('names the user file when it breaks the strict user schema', () =>
  Effect.gen(function* rejectsUserFile() {
    const { config, home, project } = yield* workspace()
    const userFile = write(home, USER_FILE, { unknown: true, logging: { level: 'loud' } })
    const error = yield* Effect.flip(config.load({ projectPath: project }))
    assert.instanceOf(error, ConfigError)
    assert.strictEqual(error.file, userFile)
    assert.include(error.reason, 'unknown')
  }),
)

it.effect('loads the init template back as the default project configuration', () =>
  Effect.gen(function* loadsTemplate() {
    const { config, project } = yield* workspace()
    write(project, 'bytebureau.jsonc', defaultProjectConfigText())
    const resolved = yield* config.load({ projectPath: project })
    assert.deepStrictEqual(resolved.project, {
      $schema: 'https://bytebureau.dev/schema/v1/config.json',
      ...defaultProjectConfig,
    })
    assert.deepStrictEqual(yield* config.validate(project), [])
  }),
)

it.effect('serves the JSON Schema of the project file', () =>
  Effect.gen(function* servesSchema() {
    const { config } = yield* workspace()
    assert.strictEqual(config.schema()['$id'], 'https://bytebureau.dev/schema/v1/config.json')
  }),
)
