// CSpell:ignore locael
import path from 'node:path'
import { decodeProjectConfig, defaultProjectConfig } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { loadConfig } from 'c12'
import { Effect, Result, type Scope } from 'effect'
import { ConfigError } from '../errors.js'
import type { ConfigIssue } from './config.js'
import {
  LOCAL_FILE,
  PROJECT_FILE,
  PROJECT_JSONC,
  USER_FILE,
  workspace,
  write,
  type Workspace,
} from './config-fixtures.js'
import { defaultProjectConfigText } from './template.js'

const SCHEMA_URL = 'https://bytebureau.dev/schema/v1/config.json'
const LEVEL = '/logging/level'

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

const where = (issues: readonly ConfigIssue[]): readonly (readonly [string, string])[] =>
  issues.map((issue) => [issue.file, issue.pointer] as const)

it.effect('reports unknown keys and bad values with file and JSON pointer', () =>
  Effect.gen(function* reportsPointers() {
    const { config, project } = yield* broken()
    const issues = yield* config.validate(project)
    assert.deepStrictEqual(issues.map((issue) => issue.pointer).toSorted(), ['/extra', LEVEL])
    assert.ok(issues.every((issue) => issue.file.endsWith(PROJECT_FILE)))
    const failure = yield* Effect.result(config.load({ projectPath: project }))
    assert.isTrue(Result.isFailure(failure))
  }),
)

it.effect('fails the load with one ConfigError that names the file and lists every issue', () =>
  Effect.gen(function* failsWithConfigError() {
    const { config, project } = yield* broken()
    const file = path.join(project, PROJECT_FILE)
    const error = yield* Effect.flip(config.load({ projectPath: project }))
    assert.instanceOf(error, ConfigError)
    assert.strictEqual(error.file, file)
    assert.oneOf(error.pointer, ['/extra', LEVEL])
    assert.include(error.reason, `${file}/extra: `)
    assert.include(error.reason, `${file}/logging/level: `)
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

const NON_OBJECT_ROOTS = [
  [PROJECT_FILE, '[1, 2]'],
  [PROJECT_FILE, 'null'],
  [PROJECT_JSONC, '// a comment in front\nnull'],
  [PROJECT_JSONC, '/* empty */ []'],
] as const

it.effect('reports an array or null root as one issue at the root of its file', () =>
  Effect.gen(function* rejectsRoots() {
    for (const [name, text] of NON_OBJECT_ROOTS) {
      const { config, project } = yield* workspace()
      const file = write(project, name, text)
      const issues = yield* config.validate(project)
      assert.deepStrictEqual(issues, [{ file, pointer: '', message: 'expected a JSON object' }])
      const error = yield* Effect.flip(config.load({ projectPath: project }))
      assert.deepStrictEqual(
        [error.file, error.pointer, error.reason],
        [file, '', 'expected a JSON object'],
      )
    }
  }),
)

it.effect('names the project file for a bad project value next to a valid local file', () =>
  Effect.gen(function* namesProjectFile() {
    const { config, project } = yield* workspace()
    const file = write(project, PROJECT_FILE, { logging: { level: 'loud' } })
    write(project, LOCAL_FILE, { workspace: { retainDays: 3 } })
    assert.deepStrictEqual(where(yield* config.validate(project)), [[file, LEVEL]])
    const error = yield* Effect.flip(config.load({ projectPath: project }))
    assert.deepStrictEqual([error.file, error.pointer], [file, LEVEL])
  }),
)

it.effect('names the environment variable that carries a bad value', () =>
  Effect.gen(function* namesVariable() {
    const { config, project } = yield* workspace()
    write(project, PROJECT_FILE, { logging: { level: 'info' } })
    const env = { BYTEBUREAU_LOG_LEVEL: 'loud' }
    const error = yield* Effect.flip(config.load({ projectPath: project, env }))
    assert.deepStrictEqual([error.file, error.pointer], ['env:BYTEBUREAU_LOG_LEVEL', LEVEL])
  }),
)

it.effect('names the flag that carries a bad value', () =>
  Effect.gen(function* namesFlag() {
    const { config, project } = yield* workspace()
    const env = { BYTEBUREAU_LOG_LEVEL: 'error' }
    const flags = { logLevel: 'loud' }
    const error = yield* Effect.flip(config.load({ projectPath: project, env, flags }))
    assert.deepStrictEqual([error.file, error.pointer], ['flag:logLevel', LEVEL])
  }),
)

it.effect('lists every issue with the layer it comes from', () =>
  Effect.gen(function* listsLayers() {
    const { config, project } = yield* workspace()
    const file = write(project, PROJECT_FILE, { extra: true })
    const env = { BYTEBUREAU_LOG_LEVEL: 'loud' }
    const error = yield* Effect.flip(config.load({ projectPath: project, env }))
    assert.include(error.reason, `${file}/extra: `)
    assert.include(error.reason, 'env:BYTEBUREAU_LOG_LEVEL/logging/level: ')
  }),
)

it.effect('names the highest file that holds the parent of a missing key', () =>
  Effect.gen(function* namesParentFile() {
    const { config, project } = yield* workspace()
    const file = write(project, PROJECT_FILE, {
      employees: { dev: { name: 'Dev', provider: 'f' } },
    })
    write(project, LOCAL_FILE, { logging: { level: 'debug' } })
    const apart = yield* config.validate(project)
    assert.deepStrictEqual(apart.map((issue) => issue.pointer).toSorted(), [
      '/employees/dev/model',
      '/employees/dev/permissionMode',
    ])
    assert.isTrue(apart.every((issue) => issue.file === file))
    const local = write(project, LOCAL_FILE, { employees: { dev: { model: 'm' } } })
    const shared = where(yield* config.validate(project))
    assert.deepStrictEqual(shared, [[local, '/employees/dev/permissionMode']])
  }),
)

it.effect('names the user file for a bad user value when there are no project files', () =>
  Effect.gen(function* namesUserFile() {
    const { config, home, project } = yield* workspace()
    const userFile = write(home, USER_FILE, { logging: { level: 'loud' } })
    assert.deepStrictEqual(where(yield* config.validate(project)), [[userFile, LEVEL]])
    const error = yield* Effect.flip(config.load({ projectPath: project }))
    assert.deepStrictEqual([error.file, error.pointer], [userFile, LEVEL])
  }),
)

it.effect('reports an unknown user key with its pointer, in the load and in the validation', () =>
  Effect.gen(function* reportsUserPointer() {
    const { config, home, project } = yield* workspace()
    const userFile = write(home, USER_FILE, { locael: 'cs' })
    assert.deepStrictEqual(where(yield* config.validate(project)), [[userFile, '/locael']])
    const error = yield* Effect.flip(config.load({ projectPath: project }))
    assert.instanceOf(error, ConfigError)
    assert.deepStrictEqual([error.file, error.pointer], [userFile, '/locael'])
    assert.include(error.reason, `${userFile}/locael: `)
  }),
)

it.effect('validates a broken user file even when a project file overrides its section', () =>
  Effect.gen(function* validatesUserFile() {
    const { config, home, project } = yield* workspace()
    const userFile = write(home, USER_FILE, { logging: { level: 'loud' } })
    write(project, PROJECT_FILE, { logging: { level: 'info' } })
    assert.deepStrictEqual(where(yield* config.validate(project)), [[userFile, LEVEL]])
    const failure = yield* Effect.result(config.load({ projectPath: project }))
    assert.isTrue(Result.isFailure(failure))
  }),
)

it.effect('leaves a local preset in extends unresolved and reports the key', () =>
  Effect.gen(function* rejectsExtends() {
    const { config, project } = yield* workspace()
    write(project, 'base.json', { workspace: { copyIgnored: ['.a'] } })
    const file = write(project, PROJECT_FILE, { extends: './base.json', project: { name: 'x' } })
    assert.deepStrictEqual(where(yield* config.validate(project)), [[file, '/extends']])
  }),
)

// Nothing listens on port 9 of the loopback address, so a download attempt would fail at once
it.effect('does not fetch a remote source in extends', () =>
  Effect.gen(function* rejectsRemoteExtends() {
    const { config, project } = yield* workspace()
    const file = write(project, PROJECT_FILE, { extends: 'http://127.0.0.1:9/preset' })
    assert.deepStrictEqual(where(yield* config.validate(project)), [[file, '/extends']])
  }),
)

it.effect('loads the init template back as the default project configuration', () =>
  Effect.gen(function* loadsTemplate() {
    const { config, project } = yield* workspace()
    write(project, PROJECT_JSONC, defaultProjectConfigText())
    const resolved = yield* config.load({ projectPath: project })
    assert.deepStrictEqual(resolved.project, { $schema: SCHEMA_URL, ...defaultProjectConfig })
    assert.deepStrictEqual(yield* config.validate(project), [])
  }),
)

it.effect('decodes the init template on its own, with no defaults merged in', () =>
  Effect.gen(function* decodesTemplate() {
    const { project } = yield* workspace()
    write(project, PROJECT_JSONC, defaultProjectConfigText())
    const parsed = yield* Effect.promise(async () => {
      const loaded = await loadConfig({
        name: 'bytebureau',
        cwd: project,
        configFile: PROJECT_JSONC,
      })
      return loaded.config
    })
    assert.deepStrictEqual(decodeProjectConfig(parsed), {
      $schema: SCHEMA_URL,
      ...defaultProjectConfig,
    })
  }),
)
