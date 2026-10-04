import {
  AskService,
  EventLog,
  ProjectRegistry,
  SessionManager,
  WorkspaceManager,
} from '@bytebureau/kernel'
import { Effect, Stream } from 'effect'
import { buffered } from '../events/buffered.js'
import { absolutePath, projectOf } from '../handlers/found.js'
import { orProblem } from '../problems.js'
import { BureauRpcsWithAuth } from './group.js'

// The same kernel calls as the REST handlers, reached over the socket
export const RpcHandlers = BureauRpcsWithAuth.toLayer({
  'events.subscribe': (filter) =>
    Stream.unwrap(EventLog.use((log) => Effect.succeed(buffered(log.subscribe(filter))))),
  'projects.register': ({ path }) =>
    absolutePath(path).pipe(
      Effect.flatMap((directory) =>
        orProblem(ProjectRegistry.use((registry) => registry.register(directory))),
      ),
    ),
  'projects.remove': ({ id }) =>
    projectOf(id).pipe(
      Effect.flatMap(() => orProblem(ProjectRegistry.use((registry) => registry.remove(id)))),
    ),
  'sessions.create': (body) => orProblem(SessionManager.use((sessions) => sessions.create(body))),
  'sessions.prompt': ({ sessionId, input }) =>
    orProblem(SessionManager.use((sessions) => sessions.prompt(sessionId, input))),
  'sessions.interrupt': ({ sessionId }) =>
    orProblem(SessionManager.use((sessions) => sessions.interrupt(sessionId))),
  'sessions.stop': ({ sessionId }) =>
    orProblem(SessionManager.use((sessions) => sessions.stop(sessionId))),
  'sessions.resume': ({ sessionId }) =>
    orProblem(SessionManager.use((sessions) => sessions.resume(sessionId))),
  'sessions.complete': ({ sessionId }) =>
    orProblem(SessionManager.use((sessions) => sessions.complete(sessionId))),
  'asks.answer': ({ askId, answer }) =>
    orProblem(AskService.use((asks) => asks.answer(askId, answer, 'api'))).pipe(Effect.asVoid),
  'workspaces.prune': ({ projectId }) =>
    orProblem(WorkspaceManager.use((workspaces) => workspaces.prune(projectId))),
})
