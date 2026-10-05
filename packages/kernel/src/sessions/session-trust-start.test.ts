import { writeFileSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { Config } from '../config/config.js'
import { warnings } from '../plugins/log-fixtures.js'
import { ProjectRegistry } from '../projects/project-registry.js'
import { payloadsOf, startSession } from './session-fixtures.js'
import { prompted } from './session-prompted-fixtures.js'
import { driven } from './session-script-fixtures.js'
import { resolveOnPath, trustHintOf } from './session-trust.js'

const DEVELOPER = {
  name: 'Developer',
  provider: 'scripted',
  model: 'm',
  permissionMode: 'supervised',
}
const SECTION = {
  command: 'sh',
  args: ['-c', 'echo pwned'],
  env: { PATH: 'bin' },
  flavour: 'plain',
}
const CONFIG = {
  version: 1,
  project: { name: 'cloned' },
  employees: { developer: DEVELOPER },
  providers: { scripted: SECTION },
}
const AGENT = { providerId: 'scripted' } as const

const world = driven()

// The user configuration of the kernel's home, as the person wrote it before the session starts its agent
const userTrusts = (trust: Readonly<Record<string, unknown>>): Effect.Effect<void, never, Config> =>
  Effect.gen(function* writesUserConfig() {
    writeFileSync((yield* Config).userFile, JSON.stringify({ trust }))
  })

// The path of the project of a session, as the registry keeps it
const projectPathOf = (projectId: string): Effect.Effect<string, unknown, ProjectRegistry> =>
  Effect.map(
    ProjectRegistry.use((registry) => registry.get(projectId)),
    (project) => (project === undefined ? '' : project.path),
  )

// What the start says it did not use of the section, and why
const toldOf = (projectPath: string, userFile: string): readonly string[] => [
  `not using providers.scripted.command, providers.scripted.args of the project ${projectPath}: ${trustHintOf(userFile)}`,
  `not using providers.scripted.env of the project ${projectPath}: only a project the user configuration trusts sets them: add the project to trust.projects in ${userFile}`,
]

it.layer(world.layer)('SessionManager start of a project the user does not trust', (suite) => {
  suite.effect(
    'withholds what the project names, and tells why in the log and as a warning of the session',
    () =>
      Effect.gen(function* withholdsCommand() {
        const records = yield* warnings
        const session = yield* startSession(AGENT, CONFIG)
        const told = toldOf(yield* projectPathOf(session.projectId), (yield* Config).userFile)
        const { agent } = yield* prompted(world, session)
        assert.deepStrictEqual(
          [agent.request.providerConfig, agent.request.trust.withheld],
          [{ flavour: 'plain' }, ['command', 'args', 'env']],
        )
        const logged = records.map((record) => String(record.message[0]))
        assert.deepStrictEqual(
          logged.filter((line) => line.startsWith('not using')),
          told,
        )
        const warned = yield* payloadsOf(session.id, 'session.warning')
        assert.deepStrictEqual(
          warned,
          told.map((message) => ({ kind: 'trust', message })),
        )
      }),
  )
})

it.layer(world.layer)('SessionManager start of a project the user trusts', (suite) => {
  suite.effect(
    'hands the whole section to the agent as written and tells the agent the project is trusted',
    () =>
      Effect.gen(function* honoursProject() {
        const session = yield* startSession(AGENT, CONFIG)
        yield* userTrusts({ projects: [yield* projectPathOf(session.projectId)] })
        const { agent } = yield* prompted(world, session)
        assert.deepStrictEqual(agent.request.providerConfig, SECTION)
        assert.deepStrictEqual(
          [agent.request.trust.project, agent.request.trust.withheld],
          [true, []],
        )
        assert.deepStrictEqual(yield* payloadsOf(session.id, 'session.warning'), [])
      }),
  )
})

it.layer(world.layer)(
  'SessionManager start of a project whose command the user trusts',
  (suite) => {
    suite.effect(
      'runs the command by the path the daemon finds, with its arguments, and withholds its environment',
      () =>
        Effect.gen(function* honoursCommand() {
          yield* userTrusts({ commands: ['sh'] })
          const session = yield* startSession(AGENT, CONFIG)
          const { agent } = yield* prompted(world, session)
          const sh = resolveOnPath('sh', process.env['PATH'] ?? '')
          assert.deepStrictEqual(agent.request.providerConfig, {
            command: sh,
            args: SECTION.args,
            flavour: 'plain',
          })
          assert.deepStrictEqual(
            [agent.request.trust.project, agent.request.trust.withheld],
            [false, ['env']],
          )
        }),
    )
  },
)
