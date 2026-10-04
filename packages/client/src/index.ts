import type {
  AskAnswer,
  AskRecord,
  CreateSessionBody,
  EventEnvelope,
  EventsFilter,
  HealthDto,
  PluginStatusDto,
  ProjectDto,
  PromptInput,
  ProviderDto,
  PruneReportDto,
  RegisterProjectBody,
  SessionDto,
  SessionUsageDto,
  TurnDto,
  WorkspaceInfoDto,
} from '@bytebureau/protocol'
import {
  asksAnswer,
  asksGet,
  asksPending,
  healthCheck,
  pluginsList,
  pluginsProviders,
  projectsGet,
  projectsList,
  projectsRegister,
  projectsRemove,
  sessionsComplete,
  sessionsCreate,
  sessionsGet,
  sessionsInterrupt,
  sessionsList,
  sessionsPrompt,
  sessionsResume,
  sessionsStop,
  usageSession,
  workspacesList,
  workspacesPrune,
} from './gen/sdk.gen.js'
import { answerBody, http, promptBody, type Http } from './http.js'
import { connectRpc, type RpcConnection } from './rpc/connection.js'
import { subscribeEvents } from './sse.js'

export { ApiError, isProblem, type RequestTarget } from './errors.js'
export { connectRpc, type RpcConnection, type RpcOptions } from './rpc/connection.js'
export { subscribeEvents, type SubscribeOptions } from './sse.js'

export interface ClientOptions {
  // The daemon, as http://<host>:<port>
  readonly baseUrl: string
  readonly token: string
  readonly fetch?: typeof fetch | undefined
  // How long an event subscription may keep failing to reconnect before it gives up; 30 s by default
  readonly retryFor?: number | undefined
}

export interface EventsOptions {
  readonly signal?: AbortSignal | undefined
  readonly retryFor?: number | undefined
}

// The API of the daemon in ByteBureau's names and the protocol's types; a refusal is thrown as an ApiError
export interface BureauClient {
  readonly projects: {
    readonly list: () => Promise<readonly ProjectDto[]>
    readonly register: (body: RegisterProjectBody) => Promise<ProjectDto>
    readonly get: (id: string) => Promise<ProjectDto | undefined>
    readonly remove: (id: string) => Promise<void>
  }
  readonly sessions: {
    readonly list: () => Promise<readonly SessionDto[]>
    readonly create: (body: CreateSessionBody) => Promise<SessionDto>
    readonly get: (id: string) => Promise<SessionDto | undefined>
    readonly prompt: (id: string, input: PromptInput) => Promise<TurnDto>
    readonly interrupt: (id: string) => Promise<void>
    readonly stop: (id: string) => Promise<void>
    readonly resume: (id: string) => Promise<SessionDto>
    readonly complete: (id: string) => Promise<void>
  }
  readonly asks: {
    // The asks waiting for an answer, of one session or of all
    readonly pending: (sessionId?: string) => Promise<readonly AskRecord[]>
    readonly get: (id: string) => Promise<AskRecord | undefined>
    readonly answer: (id: string, answer: AskAnswer) => Promise<void>
  }
  readonly usage: { readonly session: (sessionId: string) => Promise<SessionUsageDto> }
  readonly workspaces: {
    // The worktrees of one project or of all
    readonly list: (projectId?: string) => Promise<readonly WorkspaceInfoDto[]>
    readonly prune: (projectId?: string) => Promise<PruneReportDto>
  }
  readonly plugins: {
    readonly list: () => Promise<readonly PluginStatusDto[]>
    readonly providers: () => Promise<readonly ProviderDto[]>
  }
  readonly health: { readonly check: () => Promise<HealthDto> }
  readonly events: {
    // Durable events after since replayed, then live ones, resumed across lost connections; ephemeral: false drops seq 0
    readonly subscribe: (
      filter: EventsFilter,
      options?: EventsOptions,
    ) => AsyncIterable<EventEnvelope>
  }
  readonly rpc: { readonly connect: () => Promise<RpcConnection> }
  // Nothing to release over fetch; a subscription ends with its signal and an RPC connection with its close
  readonly close: () => Promise<void>
}

const projectsOf = ({ client, data, lookup, done }: Http): BureauClient['projects'] => ({
  list: data(projectsList, () => ({ client })),
  register: data(projectsRegister, (body: RegisterProjectBody) => ({ client, body })),
  get: lookup(projectsGet, (id: string) => ({ client, path: { id } })),
  remove: done(projectsRemove, (id: string) => ({ client, path: { id } })),
})

const sessionsOf = ({ client, data, lookup, done }: Http): BureauClient['sessions'] => ({
  list: data(sessionsList, () => ({ client })),
  create: data(sessionsCreate, (body: CreateSessionBody) => ({ client, body })),
  get: lookup(sessionsGet, (id: string) => ({ client, path: { id } })),
  prompt: data(sessionsPrompt, (id: string, input: PromptInput) => ({
    client,
    path: { id },
    body: promptBody(input),
  })),
  interrupt: done(sessionsInterrupt, (id: string) => ({ client, path: { id } })),
  stop: done(sessionsStop, (id: string) => ({ client, path: { id } })),
  resume: data(sessionsResume, (id: string) => ({ client, path: { id } })),
  complete: done(sessionsComplete, (id: string) => ({ client, path: { id } })),
})

const asksOf = ({ client, data, lookup, done }: Http): BureauClient['asks'] => ({
  pending: data(asksPending, (sessionId?: string) => ({
    client,
    ...(sessionId === undefined ? {} : { query: { session: sessionId } }),
  })),
  get: lookup(asksGet, (id: string) => ({ client, path: { id } })),
  answer: done(asksAnswer, (id: string, answer: AskAnswer) => ({
    client,
    path: { id },
    body: answerBody(answer),
  })),
})

// The workspaces, the usage, the plugins and the health of the daemon
const daemonOf = ({
  client,
  data,
}: Http): Pick<BureauClient, 'health' | 'plugins' | 'usage' | 'workspaces'> => ({
  usage: { session: data(usageSession, (id: string) => ({ client, path: { id } })) },
  workspaces: {
    list: data(workspacesList, (projectId?: string) => ({
      client,
      ...(projectId === undefined ? {} : { query: { project: projectId } }),
    })),
    // The endpoint takes a body even when it names no project
    prune: data(workspacesPrune, (projectId?: string) => ({
      client,
      body: projectId === undefined ? {} : { projectId },
    })),
  },
  plugins: {
    list: data(pluginsList, () => ({ client })),
    providers: data(pluginsProviders, () => ({ client })),
  },
  health: { check: data(healthCheck, () => ({ client })) },
})

/**
 * A client of the daemon at the base url: the REST API through the generated SDK, the event subscription over SSE
 * and the RPC connection over WebSocket. Each client has a generated client of its own, so one process may talk to
 * several daemons at once.
 */
export function createBureauClient(options: ClientOptions): BureauClient {
  const { token } = options
  // The paths are joined to the base url, so a slash at its end would double theirs
  const baseUrl = options.baseUrl.replace(/\/+$/u, '')
  const calls = http({ ...options, baseUrl })
  return {
    projects: projectsOf(calls),
    sessions: sessionsOf(calls),
    asks: asksOf(calls),
    ...daemonOf(calls),
    events: {
      subscribe: (filter, { signal, retryFor = options.retryFor } = {}) =>
        subscribeEvents({ baseUrl, token, filter, signal, retryFor, fetch: options.fetch }),
    },
    rpc: {
      connect: async () => {
        const connection = await connectRpc({
          url: `${baseUrl.replace(/^http/u, 'ws')}/api/v1/ws`,
          token,
        })
        return connection
      },
    },
    close: async () => {
      // Nothing to release
    },
  }
}
