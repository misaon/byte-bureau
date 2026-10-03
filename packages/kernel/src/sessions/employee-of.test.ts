import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { decodeProjectConfig, type EmployeeConfig } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { SessionError } from '../errors.js'
import type { Project } from '../projects/project-registry.js'
import { warnings } from '../plugins/log-fixtures.js'
import { tempDir } from '../testing/temp-repo.js'
import { employeeOf } from './employee-of.js'

const PREFIX = 'bb-employee-'

const DEVELOPER: EmployeeConfig = {
  name: 'Developer',
  provider: 'claude',
  model: 'm',
  permissionMode: 'supervised',
}

const projectOf = (
  dir: string,
  employees: Readonly<Record<string, EmployeeConfig>>,
  defaults: Record<string, unknown> = {},
): Project => ({
  id: 'project-1',
  name: 'fixture',
  path: dir,
  defaultBranch: 'main',
  config: decodeProjectConfig({
    version: 1,
    project: { name: 'fixture' },
    employees,
    defaults,
  }),
  createdAt: 't',
  updatedAt: 't',
})

// The system prompt an employee gets from a prompt file of a project
const promptOf = (dir: string, prompt: string): Effect.Effect<string, SessionError> =>
  Effect.map(
    employeeOf(projectOf(dir, { developer: { ...DEVELOPER, prompt } }), {
      employeeId: 'developer',
    }),
    (employee) => employee.systemPrompt,
  )

const codeOf = (failure: unknown): string => (failure instanceof SessionError ? failure.code : '')

it.effect(
  'describes the employee of the configuration with the defaults of what it leaves out',
  () =>
    Effect.gen(function* describesEmployee() {
      const project = projectOf(tempDir(PREFIX), { developer: DEVELOPER })
      const employee = yield* employeeOf(project, { employeeId: 'developer' })
      assert.deepStrictEqual(employee, {
        id: 'developer',
        name: 'Developer',
        provider: 'claude',
        model: 'm',
        effort: null,
        systemPrompt: '',
        tools: { allow: [], deny: [] },
        permissionMode: 'supervised',
        skills: [],
        askTimeout: '30m',
        appearance: {},
      })
    }),
)

it.effect('keeps what the configuration sets and lets the caller choose the provider', () =>
  Effect.gen(function* keepsSettings() {
    const configured: EmployeeConfig = {
      ...DEVELOPER,
      effort: 'high',
      systemPrompt: 'Be brief.',
      tools: { allow: ['Read'], deny: ['Bash'] },
      skills: ['review'],
      maxTurns: 5,
      askTimeout: '10m',
      appearance: { hair: 'red' },
    }
    const project = projectOf(tempDir(PREFIX), { developer: configured })
    const employee = yield* employeeOf(project, { employeeId: 'developer', providerId: 'fake' })
    assert.deepStrictEqual(employee, {
      id: 'developer',
      name: 'Developer',
      provider: 'fake',
      model: 'm',
      effort: 'high',
      systemPrompt: 'Be brief.',
      tools: { allow: ['Read'], deny: ['Bash'] },
      permissionMode: 'supervised',
      skills: ['review'],
      maxTurns: 5,
      askTimeout: '10m',
      appearance: { hair: 'red' },
    })
  }),
)

it.effect(
  'takes the employee that the project names as its default, and the developer otherwise',
  () =>
    Effect.gen(function* takesDefault() {
      const dir = tempDir(PREFIX)
      const employees = { developer: DEVELOPER, lead: { ...DEVELOPER, name: 'Lead' } }
      const named = projectOf(dir, employees, { employee: 'lead' })
      const byDefault = yield* employeeOf(named, {})
      const fallback = yield* employeeOf(projectOf(dir, employees), {})
      const asked = yield* employeeOf(named, { employeeId: 'developer' })
      assert.deepStrictEqual(
        [byDefault.name, fallback.name, asked.name],
        ['Lead', 'Developer', 'Developer'],
      )
    }),
)

it.effect('refuses an employee the project does not define, an inherited property included', () =>
  Effect.gen(function* refusesMissing() {
    const project = projectOf(tempDir(PREFIX), { developer: DEVELOPER })
    const missing = yield* Effect.flip(employeeOf(project, { employeeId: 'ghost' }))
    const inherited = yield* Effect.flip(employeeOf(project, { employeeId: 'toString' }))
    assert.deepStrictEqual(
      [codeOf(missing), codeOf(inherited)],
      ['employee_missing', 'employee_missing'],
    )
    assert.strictEqual(missing.reason, 'employee "ghost" is not defined in bytebureau.json')
  }),
)

it.effect('prefers the system prompt written in the configuration to a prompt file', () =>
  Effect.gen(function* prefersInline() {
    const dir = tempDir(PREFIX)
    writeFileSync(path.join(dir, 'prompt.md'), 'from the file')
    const config = { ...DEVELOPER, prompt: 'prompt.md', systemPrompt: 'inline' }
    const employee = yield* employeeOf(projectOf(dir, { developer: config }), {
      employeeId: 'developer',
    })
    assert.strictEqual(employee.systemPrompt, 'inline')
  }),
)

it.effect('reads the prompt file of the project, whose path is relative to the project', () =>
  Effect.gen(function* readsPromptFile() {
    const dir = tempDir(PREFIX)
    mkdirSync(path.join(dir, '.bytebureau', 'employees'), { recursive: true })
    writeFileSync(path.join(dir, '.bytebureau', 'employees', 'developer.md'), 'You write tests.\n')
    assert.strictEqual(
      yield* promptOf(dir, './.bytebureau/employees/developer.md'),
      'You write tests.\n',
    )
  }),
)

it.effect('reads a prompt file whose name merely starts with dots', () =>
  Effect.gen(function* readsDottedName() {
    const dir = tempDir(PREFIX)
    writeFileSync(path.join(dir, '..prompt.md'), 'dotted')
    assert.strictEqual(yield* promptOf(dir, '..prompt.md'), 'dotted')
  }),
)

it.effect('gives no system prompt for a prompt file that is missing or is not a file', () =>
  Effect.gen(function* ignoresMissingFile() {
    const dir = tempDir(PREFIX)
    mkdirSync(path.join(dir, 'folder'))
    assert.deepStrictEqual(
      [yield* promptOf(dir, 'nowhere.md'), yield* promptOf(dir, 'folder')],
      ['', ''],
    )
  }),
)

it.effect(
  'never reads a prompt file outside the project, by dots, by an absolute path or by a link',
  () =>
    Effect.gen(function* confinesPromptFile() {
      const outside = tempDir('bb-outside-')
      writeFileSync(path.join(outside, 'secret.md'), 'do not send this to a model')
      const dir = tempDir(PREFIX)
      symlinkSync(path.join(outside, 'secret.md'), path.join(dir, 'link.md'))
      const reads = [
        yield* promptOf(dir, path.relative(dir, path.join(outside, 'secret.md'))),
        yield* promptOf(dir, path.join(outside, 'secret.md')),
        yield* promptOf(dir, 'link.md'),
      ]
      assert.deepStrictEqual(reads, ['', '', ''])
    }),
)

it.effect(
  'warns about a configured prompt file that is missing, never about the built-in default',
  () =>
    Effect.gen(function* warnsAboutConfiguredPrompt() {
      const records = yield* warnings
      const dir = tempDir(PREFIX)
      const prompts = [
        yield* promptOf(dir, './.bytebureau/employees/developer.md'),
        yield* promptOf(dir, 'prompts/reviewer.md'),
      ]
      assert.deepStrictEqual(prompts, ['', ''])
      assert.deepStrictEqual(
        records.map((record) => [record.message[0], record.properties['promptPath']]),
        [['employee prompt unreadable', 'prompts/reviewer.md']],
      )
    }),
)

it.effect('warns about the built-in default prompt file when it is there but cannot be read', () =>
  Effect.gen(function* warnsAboutUnreadableDefault() {
    const records = yield* warnings
    const dir = tempDir(PREFIX)
    mkdirSync(path.join(dir, '.bytebureau', 'employees', 'developer.md'), { recursive: true })
    assert.strictEqual(yield* promptOf(dir, './.bytebureau/employees/developer.md'), '')
    assert.deepStrictEqual(
      records.map((record) => record.message[0]),
      ['employee prompt unreadable'],
    )
  }),
)
