import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import { AskAnswer } from '../ask.js'
import { Id } from '../common.js'
import { PromptInput } from '../employee.js'
import { EventEnvelope } from '../events.js'
import { ProjectDto, PruneReportDto, SessionDto, TurnDto } from './dto.js'
import { Problem } from './problem.js'
import { CreateSessionBody, EventsFilter, RegisterProjectBody, SessionRef } from './requests.js'

const PrunePayload = Schema.Struct({ projectId: Schema.optionalKey(Id) })

// The WebSocket contract: a streaming subscription and one procedure per mutation; every mutation fails with a Problem
export const BureauRpcs = RpcGroup.make(
  Rpc.make('events.subscribe', { payload: EventsFilter, success: EventEnvelope, stream: true }),
  Rpc.make('projects.register', {
    payload: RegisterProjectBody,
    success: ProjectDto,
    error: Problem,
  }),
  Rpc.make('projects.remove', { payload: Schema.Struct({ id: Id }), error: Problem }),
  Rpc.make('sessions.create', { payload: CreateSessionBody, success: SessionDto, error: Problem }),
  Rpc.make('sessions.prompt', {
    payload: Schema.Struct({ sessionId: Id, input: PromptInput }),
    success: TurnDto,
    error: Problem,
  }),
  Rpc.make('sessions.interrupt', { payload: SessionRef, error: Problem }),
  Rpc.make('sessions.stop', { payload: SessionRef, error: Problem }),
  Rpc.make('sessions.resume', { payload: SessionRef, success: SessionDto, error: Problem }),
  Rpc.make('sessions.complete', { payload: SessionRef, error: Problem }),
  Rpc.make('asks.answer', {
    payload: Schema.Struct({ askId: Id, answer: AskAnswer }),
    error: Problem,
  }),
  Rpc.make('workspaces.prune', { payload: PrunePayload, success: PruneReportDto, error: Problem }),
)

export const RPC_TAGS: readonly string[] = [...BureauRpcs.requests.keys()]
