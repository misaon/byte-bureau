import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ConfigError } from '../errors.js'
import { ProjectRegistry } from '../projects/project-registry.js'
import { sessionOf, startSession, typesOf } from './session-fixtures.js'
import { sessionLayer } from './session-layer-fixtures.js'
import { SessionManager } from './session-manager.js'
import { GONE, nameOwner, ownerOf } from './session-recover-fixtures.js'

it.layer(sessionLayer())(
  'SessionManager.resume and a configuration that cannot be read',
  (suite) => {
    suite.effect(
      'reads the environment before the move: the session stays stopped and claimed by nobody new',
      () =>
        Effect.gen(function* refusesBeforeMoving() {
          const sessions = yield* SessionManager
          const session = yield* startSession()
          yield* sessions.stop(session.id)
          yield* nameOwner(session.id, GONE)
          const project = yield* Effect.fromNullishOr(
            yield* ProjectRegistry.use((registry) => registry.get(session.projectId)),
          )
          writeFileSync(path.join(project.path, 'bytebureau.json'), '{ "version": 1, "broken": ')
          const refused = yield* Effect.flip(sessions.resume(session.id))
          const types = yield* typesOf(session.id)
          assert.instanceOf(refused, ConfigError)
          assert.deepStrictEqual(
            [(yield* sessionOf(session.id)).status, yield* ownerOf(session.id), types.at(-1)],
            ['stopped', GONE, 'session.stopped'],
          )
        }),
    )
  },
)
