import { EventLog, type StoreError } from '@bytebureau/kernel'
import { createTempRepo, writeConfig } from '@bytebureau/kernel/testing'
import {
  AskRecord,
  ProjectDto,
  SessionDto,
  type AskOption,
  type EventEnvelope,
} from '@bytebureau/protocol'
import { assert } from '@effect/vitest'
import { Effect, Schema, Stream, type Cause } from 'effect'
import type { HttpServer } from 'effect/http'
import { get, post, type Reply } from './testing.js'

// An id no project, session or ask has
export const UNKNOWN_ID = '0192f0a0-0000-7000-8000-000000000009'

// A project file whose default employee works with the bundled fake provider
export const fakeProjectConfig = {
  version: 1,
  project: { name: 'fixture' },
  employees: {
    developer: { name: 'Developer', provider: 'fake', model: 'any', permissionMode: 'supervised' },
  },
  defaults: { employee: 'developer' },
}

// A call that was meant to work fails the test with what the server answered
const succeeded = (reply: Reply, status: number): Reply => {
  assert.strictEqual(reply.status, status, JSON.stringify(reply.body))
  return reply
}

interface Registered {
  readonly repo: string
  readonly project: ProjectDto
  readonly status: number
}

// A repository with the project file as given, registered through the API
export const registeredWith = (
  config: Record<string, unknown>,
): Effect.Effect<Registered, never, HttpServer.HttpServer> =>
  Effect.gen(function* registers() {
    const repo = createTempRepo()
    writeConfig(repo, config)
    const { status, body } = succeeded(yield* post('/projects', { path: repo }), 201)
    return { repo, project: Schema.decodeUnknownSync(ProjectDto)(body), status }
  })

// A repository configured for the fake provider, registered through the API
export const registeredProject = registeredWith(fakeProjectConfig)

// A session created through the API, ready to be prompted
export const createdSession = Effect.gen(function* creates() {
  const { project } = yield* registeredProject
  const created = yield* post('/sessions', { projectId: project.id, title: 'Create hello' })
  const { status, body } = succeeded(created, 201)
  return { project, session: Schema.decodeUnknownSync(SessionDto)(body), status }
})

// The first event of the type the session has had or will have, from the kernel behind the API
// Only the timeout of the test bounds the wait: the clock of a suite is the test clock
export const firstEvent = (
  sessionId: string,
  type: string,
): Effect.Effect<EventEnvelope, StoreError | Cause.NoSuchElementError, EventLog> =>
  EventLog.use((log) =>
    Stream.runHead(log.subscribe({ sessionId, types: [type], since: 0 })).pipe(
      Effect.flatMap(Effect.fromOption),
    ),
  )

// The option an ask recommends
export const recommendedOption = (
  ask: AskRecord,
): Effect.Effect<AskOption, Cause.NoSuchElementError> =>
  Effect.fromNullishOr(
    ask.questions.flatMap((question) => question.options).find((option) => option.recommended),
  )

// A session whose first turn has raised its question, and the ask as it waits for an answer
export const askedSession = Effect.gen(function* asks() {
  const { project, session } = yield* createdSession
  const text = 'Create src/hello.ts exporting hello()'
  succeeded(yield* post(`/sessions/${session.id}/prompt`, { text }), 200)
  yield* firstEvent(session.id, 'ask.requested')
  const pending = yield* get(`/asks?session=${session.id}`)
  const [ask] = Schema.decodeUnknownSync(Schema.Array(AskRecord))(succeeded(pending, 200).body)
  return { project, session, ask: yield* Effect.fromNullishOr(ask) }
})
