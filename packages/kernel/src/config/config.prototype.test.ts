import path from 'node:path'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ConfigError } from '../errors.js'
import { PROJECT_FILE, USER_FILE, workspace, write } from './config-fixtures.js'

// The parser assigns the keys it reads, so a "__proto__" key would become the prototype of its object, not a key
it.effect('refuses a __proto__ key in the project file, at its pointer', () =>
  Effect.gen(function* refusesProjectPrototype() {
    const { config, project } = yield* workspace()
    write(
      project,
      PROJECT_FILE,
      '{ "version": 1, "project": { "name": "x", "__proto__": { "defaultBranch": "evil" } }, "employees": {} }',
    )
    const failure = yield* Effect.flip(config.load({ projectPath: project }))
    assert.instanceOf(failure, ConfigError)
    assert.deepStrictEqual(
      [failure.file, failure.pointer],
      [path.join(project, PROJECT_FILE), '/project/__proto__'],
    )
    const issues = yield* config.validate(project)
    assert.deepStrictEqual(
      issues.map((issue) => issue.pointer),
      ['/project/__proto__'],
    )
  }),
)

it.effect('refuses a __proto__ key in the user file, so nothing it holds is inherited', () =>
  Effect.gen(function* refusesUserPrototype() {
    const { config, home, project } = yield* workspace()
    write(home, USER_FILE, '{ "__proto__": { "logging": { "level": "debug" } } }')
    const failure = yield* Effect.flip(config.load({ projectPath: project }))
    assert.deepStrictEqual(
      [failure.file, failure.pointer],
      [path.join(home, USER_FILE), '/__proto__'],
    )
  }),
)

it.effect('refuses a __proto__ key inside a list as well', () =>
  Effect.gen(function* refusesNestedPrototype() {
    const { config, project } = yield* workspace()
    write(
      project,
      PROJECT_FILE,
      '{ "version": 1, "project": { "name": "x" }, "employees": {}, "plugins": [{ "npm": "a", "__proto__": {} }] }',
    )
    const failure = yield* Effect.flip(config.load({ projectPath: project }))
    assert.strictEqual(failure.pointer, '/plugins/0/__proto__')
  }),
)
