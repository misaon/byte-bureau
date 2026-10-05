import { writeFileSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { Config } from '../config/config.js'
import { warnings } from '../plugins/log-fixtures.js'
import { ProjectRegistry } from '../projects/project-registry.js'
import { startSession } from './session-fixtures.js'
import { prompted } from './session-prompted-fixtures.js'
import { driven } from './session-script-fixtures.js'
import { trustHintOf } from './session-trust.js'

const DEVELOPER = {
  name: 'Developer',
  provider: 'scripted',
  model: 'm',
  permissionMode: 'supervised',
}
const SECTION = { command: 'sh', args: ['-c', 'echo pwned'], flavour: 'plain' }
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

it.layer(world.layer)('SessionManager start of a project the user does not trust', (suite) => {
  suite.effect(
    'withholds the command the project names and says which keys and how to trust them',
    () =>
      Effect.gen(function* withholdsCommand() {
        const records = yield* warnings
        const session = yield* startSession(AGENT, CONFIG)
        const project = yield* (yield* ProjectRegistry).get(session.projectId)
        const { agent } = yield* prompted(world, session)
        const hint = trustHintOf((yield* Config).userFile)
        assert.deepStrictEqual(agent.request.providerConfig, { flavour: 'plain' })
        assert.deepStrictEqual(agent.request.trust, {
          project: false,
          withheld: ['command', 'args'],
          hint,
        })
        const told = records.filter((record) => String(record.message[0]).startsWith('not using'))
        assert.deepStrictEqual(
          told.map((record) => [record.message[0], record.properties['commands']]),
          [
            [
              `not using providers.scripted.command, providers.scripted.args of the project ${project === undefined ? '' : project.path}: ${hint}`,
              ['sh'],
            ],
          ],
        )
      }),
  )
})

it.layer(world.layer)('SessionManager start of a project the user trusts', (suite) => {
  suite.effect('hands the whole section to the agent and tells it the project is trusted', () =>
    Effect.gen(function* honoursProject() {
      const session = yield* startSession(AGENT, CONFIG)
      const project = yield* (yield* ProjectRegistry).get(session.projectId)
      yield* userTrusts({ projects: [project === undefined ? '' : project.path] })
      const { agent } = yield* prompted(world, session)
      assert.deepStrictEqual(agent.request.providerConfig, SECTION)
      assert.deepStrictEqual(
        [agent.request.trust.project, agent.request.trust.withheld],
        [true, []],
      )
    }),
  )
})

it.layer(world.layer)(
  'SessionManager start of a project whose command the user trusts',
  (suite) => {
    suite.effect('hands the section to the agent, the project itself still untrusted', () =>
      Effect.gen(function* honoursCommand() {
        yield* userTrusts({ commands: ['sh'] })
        const session = yield* startSession(AGENT, CONFIG)
        const { agent } = yield* prompted(world, session)
        assert.deepStrictEqual(agent.request.providerConfig, SECTION)
        assert.deepStrictEqual(
          [agent.request.trust.project, agent.request.trust.withheld],
          [false, []],
        )
      }),
    )
  },
)
