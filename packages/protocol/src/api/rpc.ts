import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import { AskAnswer } from '../ask.js'
import { Id } from '../common.js'
import { PromptInput } from '../employee.js'
import { EventEnvelope } from '../events.js'
import {
  ProfileDto,
  ProfileStatusDto,
  ProjectDto,
  PruneReportDto,
  SessionDto,
  TurnDto,
  UsageSnapshotDto,
} from './dto.js'
import { Problem } from './problem.js'
import {
  AddProfileBody,
  CreateSessionBody,
  EventsFilter,
  ProfileIdParam,
  RegisterProjectBody,
  SessionRef,
} from './requests.js'

const PrunePayload = Schema.Struct({ projectId: Schema.optionalKey(Id) })

// The purge of a profile's removal is a boolean here, as a JSON payload carries it; the query string of REST carries text
const RemoveProfilePayload = Schema.Struct({
  ...ProfileIdParam.fields,
  purge: Schema.optionalKey(Schema.Boolean),
})

// The WebSocket contract: a streaming subscription, one procedure per mutation and the reads of a profile; every procedure but the subscription fails with a Problem
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
  Rpc.make('profiles.list', { success: Schema.Array(ProfileDto), error: Problem }),
  Rpc.make('profiles.add', { payload: AddProfileBody, success: ProfileDto, error: Problem }),
  Rpc.make('profiles.remove', { payload: RemoveProfilePayload, error: Problem }),
  Rpc.make('profiles.setDefault', { payload: ProfileIdParam, error: Problem }),
  Rpc.make('profiles.status', {
    payload: ProfileIdParam,
    success: ProfileStatusDto,
    error: Problem,
  }),
  Rpc.make('usage.profile', { payload: ProfileIdParam, success: UsageSnapshotDto, error: Problem }),
)

export const RPC_TAGS: readonly string[] = [...BureauRpcs.requests.keys()]
