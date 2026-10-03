import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ConfigError } from '../errors.js'
import { PROJECT_FILE, PROJECT_JSONC, workspace, write } from './config-fixtures.js'

const BOM = '\uFEFF'
const SCRIPTS = ['payload.mjs', 'payload.ts'] as const

const NON_OBJECT_ROOTS = [
  [PROJECT_FILE, '[1, 2]'],
  [PROJECT_FILE, 'null'],
  [PROJECT_FILE, '42'],
  [PROJECT_FILE, '"text"'],
  [PROJECT_FILE, 'true'],
  [PROJECT_FILE, ''],
  [PROJECT_JSONC, '// a comment in front\nnull'],
  [PROJECT_JSONC, '/* empty */ []'],
  [PROJECT_JSONC, '// only a comment\n'],
] as const

// A script that writes a marker file when it runs and names a project when it is loaded as configuration
const payload = (marker: string): string => `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(marker)}, '')
export default { project: { name: 'from-script' } }
`

// A link named like the project file that points at such a script
function linkedScript(project: string, name: string): { marker: string; link: string } {
  const marker = path.join(project, 'ran')
  const target = write(project, name, payload(marker))
  const link = path.join(project, PROJECT_FILE)
  symlinkSync(target, link)
  return { marker, link }
}

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

it.effect('reads comments and trailing commas in a .json file too', () =>
  Effect.gen(function* readsCommentedJson() {
    const { config, project } = yield* workspace()
    write(project, PROJECT_FILE, '{ "project": { "name": "plain", }, // note\n}')
    const resolved = yield* config.load({ projectPath: project })
    assert.strictEqual(resolved.project.project.name, 'plain')
  }),
)

it.effect('reads files that start with a byte order mark', () =>
  Effect.gen(function* readsBom() {
    for (const name of [PROJECT_FILE, PROJECT_JSONC]) {
      const { config, project } = yield* workspace()
      write(project, name, `${BOM}${JSON.stringify({ project: { name: 'bom' } })}`)
      const resolved = yield* config.load({ projectPath: project })
      assert.strictEqual(resolved.project.project.name, 'bom')
    }
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
    write(project, 'bytebureau.mjs', payload(marker))
    const file = write(project, PROJECT_FILE, { project: { name: 'from-json' } })
    const resolved = yield* config.load({ projectPath: project })
    assert.strictEqual(resolved.project.project.name, 'from-json')
    assert.strictEqual(resolved.files.project, file)
    assert.isFalse(existsSync(marker))
  }),
)

it.effect('never runs the target of a link named like the config', () =>
  Effect.gen(function* ignoresLinkedScripts() {
    for (const name of SCRIPTS) {
      const { config, project } = yield* workspace()
      const { marker, link } = linkedScript(project, name)
      const issues = yield* config.validate(project)
      assert.deepStrictEqual(
        issues.map((issue) => issue.file),
        [link],
      )
      const error = yield* Effect.flip(config.load({ projectPath: project }))
      assert.strictEqual(error.file, link)
      assert.isFalse(existsSync(marker))
    }
  }),
)

it.effect('follows a link named like the config to a regular JSON file', () =>
  Effect.gen(function* followsLink() {
    const { config, project } = yield* workspace()
    const target = write(project, 'shared.json', { project: { name: 'linked' } })
    const link = path.join(project, PROJECT_FILE)
    symlinkSync(target, link)
    const resolved = yield* config.load({ projectPath: project })
    assert.strictEqual(resolved.project.project.name, 'linked')
    assert.strictEqual(resolved.files.project, link)
  }),
)

it.effect('fails for a link named like the config whose target does not exist', () =>
  Effect.gen(function* rejectsDanglingLink() {
    const { config, project } = yield* workspace()
    const link = path.join(project, PROJECT_FILE)
    symlinkSync(path.join(project, 'missing.json'), link)
    const error = yield* Effect.flip(config.load({ projectPath: project }))
    assert.deepStrictEqual(
      { file: error.file, pointer: error.pointer },
      { file: link, pointer: '' },
    )
    assert.include(error.reason, 'target does not exist')
    const issues = yield* config.validate(project)
    assert.deepStrictEqual(issues, [{ file: link, pointer: '', message: error.reason }])
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

it.effect('names the error, the line and the column of a syntax error', () =>
  Effect.gen(function* namesSyntaxPosition() {
    const { config, project } = yield* workspace()
    const file = write(project, PROJECT_FILE, '{"a": }')
    const single = yield* Effect.flip(config.load({ projectPath: project }))
    assert.deepStrictEqual([single.file, single.pointer], [file, ''])
    assert.strictEqual(single.reason, 'ValueExpected at line 1, column 7')
    write(project, PROJECT_FILE, '{\n  "a": }')
    const spread = yield* Effect.flip(config.load({ projectPath: project }))
    assert.strictEqual(spread.reason, 'ValueExpected at line 2, column 8')
  }),
)

it.effect('reports an array, null, scalar or empty root as one issue at the root of its file', () =>
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

// Every "/* " opens a comment that never closes; rescanning the rest of the file per opener takes minutes on a megabyte
it.effect('reports a large unterminated comment as a syntax error without stalling', () =>
  Effect.gen(function* rejectsLargeComment() {
    const { config, project } = yield* workspace()
    const file = write(project, PROJECT_FILE, `{} ${'/* '.repeat(350_000)}`)
    const issues = yield* config.validate(project)
    const message = 'UnexpectedEndOfComment at line 1, column 4'
    assert.deepStrictEqual(issues, [{ file, pointer: '', message }])
  }),
)

// The parser recurses; far beyond any real document its stack runs out, and that must stay an issue, not a crash
it.effect('reports a document nested beyond the parser as one issue', () =>
  Effect.gen(function* rejectsDeepNesting() {
    const { config, project } = yield* workspace()
    const file = write(project, PROJECT_FILE, `${'{"a":'.repeat(100_000)}1${'}'.repeat(100_000)}`)
    const issues = yield* config.validate(project)
    assert.deepStrictEqual(
      issues.map((issue) => issue.file),
      [file],
    )
    assert.include(issues.map((issue) => issue.message).join('; '), 'RangeError')
  }),
)
