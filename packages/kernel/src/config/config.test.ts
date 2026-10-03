import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { defaultProjectConfig, type ProjectConfig } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect, type Scope } from 'effect'
import { ConfigError } from '../errors.js'
import { Config, ConfigLive } from './config.js'
import {
  LOCAL_FILE,
  PROJECT_FILE,
  PROJECT_JSONC,
  USER_FILE,
  workspace,
  write,
  type Workspace,
} from './config-fixtures.js'

// A user file, a project file with comments and a local file: every layer except the environment and the flags
function layered(): Effect.Effect<Workspace, never, Scope.Scope> {
  return Effect.gen(function* writeLayers() {
    const space = yield* workspace()
    write(space.home, USER_FILE, { logging: { level: 'warn' }, defaults: { provider: 'fake' } })
    write(
      space.project,
      PROJECT_JSONC,
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
    write(space.project, LOCAL_FILE, local)
    return space
  })
}

function settingSources(project: ProjectConfig): unknown {
  const claude = project.providers === undefined ? undefined : project.providers['claude']
  return claude === undefined ? undefined : claude['settingSources']
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
    assert.strictEqual(withFlags.files.project, path.join(project, PROJECT_JSONC))
    assert.strictEqual(withFlags.files.local, path.join(project, LOCAL_FILE))
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

it.effect('applies a local file when there is no project file', () =>
  Effect.gen(function* appliesLocalAlone() {
    const { config, project } = yield* workspace()
    const local = write(project, LOCAL_FILE, { logging: { level: 'debug' } })
    const resolved = yield* config.load({ projectPath: project })
    assert.deepStrictEqual(resolved.project.logging, { level: 'debug' })
    assert.strictEqual(resolved.project.project.name, path.basename(project))
    assert.deepStrictEqual(resolved.files, { user: null, project: null, local })
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
    const relative = path.relative(process.cwd(), home)
    const config = yield* Effect.provide(Config, ConfigLive(relative))
    const resolved = yield* config.load({})
    assert.strictEqual(resolved.files.user, userFile)
  }),
)

it.effect('reads comments and trailing commas in a .jsonc file', () =>
  Effect.gen(function* readsJsonc() {
    const { config, project } = yield* workspace()
    write(
      project,
      PROJECT_JSONC,
      `{
  // a line comment
  "project": { "name": "commented", /* an inline comment */ },
  "logging": { "level": "warn", },
}`,
    )
    const resolved = yield* config.load({ projectPath: project })
    assert.strictEqual(resolved.project.project.name, 'commented')
    assert.deepStrictEqual(resolved.project.logging, { level: 'warn' })
  }),
)

it.effect('shares no array with the protocol defaults', () =>
  Effect.gen(function* copiesDefaults() {
    const { config, project } = yield* workspace()
    const resolved = yield* config.load({ projectPath: project })
    assert.deepStrictEqual(settingSources(resolved.project), ['user', 'project', 'local'])
    assert.notStrictEqual(settingSources(resolved.project), settingSources(defaultProjectConfig))
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

it.effect('never runs a script named like the config', () =>
  Effect.gen(function* ignoresScripts() {
    const { config, project } = yield* workspace()
    const marker = path.join(project, 'ran')
    const script = `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(marker)}, '')
export default { project: { name: 'from-script' } }
`
    write(project, 'bytebureau.mjs', script)
    const file = write(project, PROJECT_FILE, { project: { name: 'from-json' } })
    const resolved = yield* config.load({ projectPath: project })
    assert.strictEqual(resolved.project.project.name, 'from-json')
    assert.strictEqual(resolved.files.project, file)
    assert.isFalse(existsSync(marker))
  }),
)

it.effect('ignores a directory named like the config file', () =>
  Effect.gen(function* ignoresDirectory() {
    const { config, project } = yield* workspace()
    mkdirSync(path.join(project, PROJECT_FILE))
    const without = yield* config.load({ projectPath: project })
    assert.strictEqual(without.files.project, null)
    const file = write(project, PROJECT_JSONC, { project: { name: 'beside' } })
    const withFile = yield* config.load({ projectPath: project })
    assert.strictEqual(withFile.files.project, file)
  }),
)

it.effect('refuses a name that exists as both .json and .jsonc', () =>
  Effect.gen(function* refusesBothVariants() {
    const { config, project } = yield* workspace()
    const json = write(project, PROJECT_FILE, {})
    const jsonc = write(project, PROJECT_JSONC, {})
    const error = yield* Effect.flip(config.load({ projectPath: project }))
    assert.deepStrictEqual(
      { file: error.file, pointer: error.pointer },
      { file: json, pointer: '' },
    )
    assert.include(error.reason, json)
    assert.include(error.reason, jsonc)
    const issues = yield* config.validate(project)
    assert.deepStrictEqual(issues, [{ file: json, pointer: '', message: error.reason }])
  }),
)

it.effect('fails for a project path that does not exist or is not a directory', () =>
  Effect.gen(function* rejectsProjectPath() {
    const { config, project } = yield* workspace()
    const missing = path.join(project, 'missing')
    const plain = write(project, 'plain-file', 'text')
    for (const [target, reason] of [
      [missing, 'does not exist'],
      [plain, 'not a directory'],
    ] as const) {
      const error = yield* Effect.flip(config.load({ projectPath: target }))
      assert.instanceOf(error, ConfigError)
      assert.deepStrictEqual(
        { file: error.file, pointer: error.pointer },
        { file: target, pointer: '' },
      )
      assert.include(error.reason, reason)
      const issues = yield* config.validate(target)
      assert.deepStrictEqual(issues, [{ file: target, pointer: '', message: error.reason }])
    }
  }),
)

it.effect('serves the JSON Schema of the project file', () =>
  Effect.gen(function* servesSchema() {
    const { config } = yield* workspace()
    assert.strictEqual(config.schema()['$id'], 'https://bytebureau.dev/schema/v1/config.json')
  }),
)
