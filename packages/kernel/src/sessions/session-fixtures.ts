import type { EventEnvelope } from '@bytebureau/protocol'
import { Effect, Stream, type Cause } from 'effect'
import type {
  ConfigError,
  ProfileError,
  SessionError,
  StoreError,
  WorkspaceError,
} from '../errors.js'
import { EventLog } from '../events/event-log.js'
import { PluginHost } from '../plugins/plugin-host.js'
import { ProjectRegistry, type Project } from '../projects/project-registry.js'
import { writeConfig } from '../testing/repo-config.js'
import { createTempRepo } from '../testing/temp-repo.js'
import { SessionManager } from './session-manager.js'
import type { CreateSessionInput, Session } from './types.js'

type RegisterFailure = WorkspaceError | ConfigError | StoreError
type CreateFailure = SessionError | ProfileError | RegisterFailure

// A fresh repository registered as a project, with the project file it is given; the plugins are loaded first
export const registerRepo = (
  config?: Record<string, unknown>,
): Effect.Effect<Project, RegisterFailure, PluginHost | ProjectRegistry> =>
  Effect.gen(function* registersRepo() {
    yield* (yield* PluginHost).load()
    const repo = createTempRepo()
    if (config !== undefined) {
      writeConfig(repo, config)
    }
    return yield* (yield* ProjectRegistry).register(repo)
  })

// A session of a fresh repository, ready for its first prompt
export const startSession = (
  input: Partial<CreateSessionInput> = {},
  config?: Record<string, unknown>,
): Effect.Effect<Session, CreateFailure, SessionManager | PluginHost | ProjectRegistry> =>
  Effect.gen(function* startsSession() {
    const project = yield* registerRepo(config)
    const sessions = yield* SessionManager
    return yield* sessions.create({
      projectId: project.id,
      title: 'Add hello',
      providerId: 'fake',
      ...input,
    })
  })

// The types of the events a session has published, oldest first
export const typesOf = (
  sessionId: string,
): Effect.Effect<readonly string[], StoreError, EventLog> =>
  Effect.gen(function* readsTypes() {
    const log = yield* EventLog
    const events = yield* log.read({ sessionId }, { from: 0 })
    return events.map((event) => event.type)
  })

// Waits on the event log for the first event of the session that the predicate accepts
export const waitUntil = (
  sessionId: string,
  accepts: (event: EventEnvelope) => boolean,
): Effect.Effect<EventEnvelope, StoreError | Cause.NoSuchElementError, EventLog> =>
  Effect.gen(function* waitsForEvent() {
    const log = yield* EventLog
    const matching = log.subscribe({ sessionId, since: 0 }).pipe(Stream.filter(accepts))
    return yield* Effect.flatMap(Stream.runHead(matching), Effect.fromOption)
  })

// Waits for the next event of a type, after the given number of earlier ones of that type
export const waitFor = (
  sessionId: string,
  type: string,
  skip = 0,
): Effect.Effect<EventEnvelope, StoreError | Cause.NoSuchElementError, EventLog> =>
  Effect.gen(function* waitsForType() {
    const log = yield* EventLog
    const matching = log.subscribe({ sessionId, types: [type], since: 0 }).pipe(Stream.drop(skip))
    return yield* Effect.flatMap(Stream.runHead(matching), Effect.fromOption)
  })

// The payloads of the events of a type that a session has published, oldest first
export const payloadsOf = (
  sessionId: string,
  type: string,
): Effect.Effect<readonly unknown[], StoreError, EventLog> =>
  Effect.gen(function* readsPayloads() {
    const log = yield* EventLog
    const events = yield* log.read({ sessionId, types: [type] }, { from: 0 })
    return events.map((event) => event.payload)
  })

export const sessionOf = (
  id: string,
): Effect.Effect<Session, StoreError | Cause.NoSuchElementError, SessionManager> =>
  Effect.gen(function* readsSession() {
    const sessions = yield* SessionManager
    return yield* Effect.fromNullishOr(yield* sessions.get(id))
  })
