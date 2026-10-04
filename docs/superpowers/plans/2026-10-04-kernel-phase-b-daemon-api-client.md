# Kernel & agent runtime — Phase B (daemon, API, client) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the daemon of sub-project 1 so that `bytebureau serve` runs the Phase A kernel behind an HTTP API under `/api/v1` (OpenAPI 3.1, RFC 9457 problems, bearer token), streams the event log over SSE with `Last-Event-ID` resume and over `effect/rpc` on a WebSocket, and so that the CLI becomes a thin client of that daemon — started on demand, `run` and every other command working through the API with the same exit codes and output as in Phase A — while `--no-daemon` keeps the in-process kernel.

**Architecture:** Hexagonal, as the spec draws it: `packages/api` is the primary adapter (an `effect/http-api` definition over the kernel's Effect services, served by `@effect/platform-bun` in the binary and by `@effect/platform-node` under Vitest), `packages/protocol` gains the API contract (DTOs, request bodies, problem details, `server.json`, the RPC group), `packages/client` is the Effect-free client generated with hey-api from the OpenAPI document plus a hand-rolled SSE subscription and an RPC connection, and `apps/bytebureau` wires the daemon lifecycle (`serve`, `server.json`, detached start, stop) and talks to it through a `Bureau` interface that the in-process kernel implements as well. The kernel gains what a long-lived process needs: `Health`, recovery of sessions a previous process left running, a persisted session environment, payload redaction at publish and a Bun layer export.

**Tech Stack:** Bun 1.4.2, TypeScript 7.0.2, Effect 4.0.0 (`effect/http-api`, `effect/http`, `effect/rpc`, `effect/socket`, `effect/encoding` SSE), `@effect/platform-bun` 4.0.0 (binary), `@effect/platform-node` 4.0.0 (tests), `@hey-api/openapi-ts` 0.99.0 run from `tools/client-codegen` on `@typescript/typescript6` 6.0.2, `eventsource-parser` 4.1.1, citty 0.2.2 + @clack/prompts 1.8.1 (CLI), Vitest 5 + `@effect/vitest` 4.0.0, LogTape 2.3.10.

**Spec:** `docs/superpowers/specs/2026-10-02-kernel-and-agent-runtime-design.md` (sections 2, 3, 4 (`Health`), 5.2 (`sessions.env_json`), 11 (API, client, CLI: `serve`, the bare command, `sessions`, `ask`, `plugins`), 12 (redaction of payloads), 13 (server security), 14 (daemon restart), 15 (integration tests), 16 (criteria 1 through the daemon, 4, 7 health, 9)). Verified stack facts: `docs/research/2026-10-02-reports/16-sp1-phase-b-stack.md` (every fact with two online sources and executed probes on Bun 1.4.2, Node 24 and Node 26). Phase A's plan and the archived ledger rulings stand: `docs/superpowers/plans/2026-10-02-kernel-phase-a-core.md`.

## Global Constraints

- Dependency rules (dependency-cruiser, enforced): only `packages/kernel`, `packages/api`, `packages/protocol` import `effect`; `plugins/*` import only `@bytebureau/plugin-api`, `@bytebureau/protocol` and third-party packages; nothing imports from `apps/*`; `apps/bytebureau` never imports `effect` (ADR-0003) — the daemon's Effect composition lives in `packages/api/src/bun.ts`; `packages/client` has no runtime dependency on Effect (its generated code is bundled, its protocol imports are type-only); no circular dependencies.
- Licences: `packages/protocol`, `packages/plugin-api`, `packages/client` are `"license": "MIT"`; `packages/kernel`, `packages/api`, `plugins/*`, `apps/*`, `tools/*` stay `"license": "FSL-1.1-MIT"` (`scripts/license.test.ts` enumerates every manifest; the MIT set gains `packages/client`).
- API: base path `/api/v1`; the server binds `127.0.0.1` and port `4747` unless the flags or the user configuration's `server.host`/`server.port` say otherwise (the Bun layer must be given the hostname — Bun binds every interface by default); a 32-byte token (64 hex characters) generated at the first start, kept across restarts, stored in `~/.bytebureau/server.json` (mode 0600, written atomically) and required as `Authorization: Bearer` on every request except `GET /api/v1/health` and `GET /api/v1/openapi.json`; `--host` outside loopback prints the LAN warning; CORS only for configured origins (none by default); request bodies at most 10 MB; mutations rate limited per client (60 at once, 60 a minute); errors are RFC 9457 problems (`application/problem+json`) with a ByteBureau `code`; the OpenAPI 3.1 document is committed at `packages/api/openapi.json` and the generated client at `packages/client/src/gen`, both checked for drift in CI.
- Events: durable events are never dropped on the way to a client; ephemeral ones (`seq` 0) may be, oldest first, beyond a per-client capacity of 64; SSE frames carry `id: <seq>` on durable events, `event: <type>`, the envelope as `data`, and an `event: heartbeat` frame every 15 s; `Last-Event-ID` wins over `since`.
- Daemon: one daemon per home (an exclusive lock file plus `server.json` with a live pid); `serve` detaches by default, `--no-daemonize` stays in the foreground, `--stop` ends the daemon of the home; at start the daemon loads the plugins and recovers sessions a previous process left running (`stopped`, turn `interrupted` with reason `daemon_restart`, asks cancelled); the store has one writer, so `--no-daemon` is refused (exit 1) while a daemon is alive on the same home; a detached daemon logs to `<home>/logs/daemon.log`; the home, the lock, the log and `server.json` are for the user alone (0700/0600).
- CLI: every command talks to the daemon unless `--no-daemon`; a daemon is started on demand unless `--host`/`--port` name one; `run` exits 0 on completion, 3 when stopped (also on SIGINT, SIGTERM, SIGHUP), 4 when refused (project, worktree, provider; through the daemon the problems `workspace_*`, `provider_*`, `session_provider_missing`) or when the session errors, 2 when the daemon cannot be reached (the line names the URL), 1 when `--no-daemon` is refused; `--json` is NDJSON, a non-TTY run without `--json` is plain text; a request the daemon refuses with a `4xx` problem ends a command with exit 1 and the problem's detail; stdout is drained before the process exits.
- Session statuses, turn statuses, ask statuses, IDs (UUIDv7), timestamps (ISO-8601 UTC), the SQLite pragmas, the data location (`~/.bytebureau`, override `BYTEBUREAU_HOME`), the worktree rules, the ask contract and the environment allowlist stay as Phase A's Global Constraints say; migrations only add (`0002_session_env_owner`).
- Logging categories gain `bb.api`; no secrets in events (redacted once at publish, ADR-0012), logs, problems, `--json` output or `server.json`'s siblings; the token never travels in a URL.
- Tests run under Node (Vitest 5): API tests over `@effect/platform-node`'s server on port 0 and `KernelTest`; CLI tests run the CLI (and the daemon) from source in Bun subprocesses with a temp `BYTEBUREAU_HOME`; no test ever touches `~/.bytebureau`; no real agent is spawned in CI.
- SP0/SP1 gates stay green on a fresh clone: `bun run check` (oxlint every category at error and type-aware, oxfmt, cspell en+cs, markdownlint, ls-lint, knip, dependency-cruiser, typecheck, Vitest with 80 % line/branch coverage over `packages/*/src`, `plugins/*/src` and the listed CLI modules, ESLint long tail), `bun run lint:actions` when workflows change; exact dependency pins, nothing published in the last day (`minimumReleaseAge` 86400, raised to 259200 at the end of stabilisation); Conventional Commits with the workspace scopes (`api` and `client` are new); comments only where needed and short; every new file passes the lint caps (`max-lines` 300, `max-statements` 10, `max-lines-per-function` 50, `import/max-dependencies` 10, one class per file, no `?.`, no `as` but `as const`, no `!`, named generator functions).

## Review Focus

1. A client resuming with a `Last-Event-ID` (or `since`) beyond the latest seq must get a live-only stream with heartbeats, never an error or a replay — pinned in Task 5 (`events.test.ts`, the heartbeat test subscribes with `since=1000000`).
2. A daemon killed with `SIGKILL` leaves a stale `server.json` and lock; the next `serve` or `run` must detect the dead pid, take over and start a fresh daemon — pinned in Task 8 (`server-info.test.ts` stale records and the lock take-over) and Task 9 (`run` starts a daemon when none is alive).
3. A request body over 10 MB must be refused with `413` and never reach a handler — pinned in Task 3 (`auth.test.ts` gains a case posting an 11 MB body to `/api/v1/projects` and expecting `413`).
4. Two runs through one daemon at the same time (spec criterion 4) must both complete and `sessions ls` must list both — pinned in Task 9 (`run-daemon.test.ts` gains a test running two `run`s in parallel on two repositories).
5. A daemon that dies while a run waits on an ask must not hang the run: the subscription gives up after `retryFor` and the run exits 2 naming the daemon's URL; the next daemon start stops the session — pinned in Task 9 (`run-daemon.test.ts` gains a test that kills the daemon with `SIGKILL` mid-run and expects exit 2 within 20 s) and Task 2 (recovery).

---

## File structure (what gets created and why)

```
packages/protocol/src/api/{dto,requests,problem,server-info,rpc}.ts      the API contract: DTOs, bodies, RFC 9457 problems, server.json, the RPC group
packages/kernel/src/health/health.ts                                   Health service (quick_check + plugin counts)
packages/kernel/src/sessions/{session-recover,session-owner,session-environment}.ts   owner-aware recovery at boot; environment restored on resume
packages/kernel/src/process/pid-alive.ts                               is a pid alive (signal 0; EPERM counts as alive)
packages/kernel/src/facade/apis.ts                                     the facade's api constructors, grouped for the import cap
packages/kernel/src/logging/redact-value.ts                            payload redaction (ADR-0012), applied in events/event-log.ts
packages/kernel/src/facade/health.ts, bun.ts (kernelBunLayer)          facade additions and the Bun layer the daemon composes
packages/api/{package.json,tsconfig.json,vitest.config.ts,openapi.json}
packages/api/src/{api,config,problems,auth,validation,token-bucket,rate-limit,openapi,layer,index}.ts
packages/api/src/groups/{health,schemas,projects,sessions,asks,usage,workspaces,plugins,events}.ts   endpoint definitions
packages/api/src/handlers/{health,schemas,projects,sessions,asks,usage,workspaces,plugins,events,found}.ts   implementations
packages/api/src/events/{delivery-buffer,buffered,sse}.ts              per-client buffer, buffered stream, SSE shapes
packages/api/src/rpc/{group,auth,handlers,route}.ts                    effect/rpc over WebSocket
packages/api/src/{testing,testing-sessions,testing-sse,testing-ws}.ts  Node test server over KernelTest and the test clients
packages/api/src/{bun,bun-address}.ts                                  startDaemon on Bun
packages/api/scripts/generate-openapi.ts                               writes openapi.json
tools/client-codegen/{package.json,openapi-ts.config.ts}               hey-api on TypeScript 6
packages/client/{package.json,tsconfig.json,vitest.config.ts}
packages/client/src/{index,errors,http,sse}.ts, src/rpc/{codec,connection}.ts, src/gen/**   the client
apps/bytebureau/src/daemon/{server-info,token,exec-args,spawn,wait,stop,foreground}.ts    daemon lifecycle
apps/bytebureau/src/bureau/{bureau,local,remote,resolve,ensure-daemon,with-bureau}.ts      the Bureau the commands use
apps/bytebureau/src/commands/{serve,sessions,sessions-prompt,ask,plugins,status,refusable}.ts   new commands
apps/bytebureau/src/render/tables.ts                                   plain-text columns
apps/bytebureau/src/testing/daemon.ts                                  startDaemonProcess for tests
apps/docs/src/content/docs/daemon-and-api.md                           the docs page
docs/decisions/0012-event-payloads-are-redacted-at-publish.md, 0013-api-transports.md
```

## Task order and interfaces at a glance

| # | Task | Produces (names later tasks rely on) |
|---|---|---|
| 1 | protocol: API contract | `ProjectDto`, `SessionDto`, `TurnDto`, `WorkspaceInfoDto`, `PruneReportDto`, `SessionUsageDto`, `PluginStatusDto`, `ProviderDto`, `HealthDto`, `RegisterProjectBody`, `CreateSessionBody`, `PromptBody`, `AnswerAskBody`, `EventsQuery`, `EventsFilter`, `SessionRef`, `Problem`, `PROBLEM_CODES`, `problemType`, `ServerInfo`, `decodeServerInfo`, `serverUrl`, `BureauRpcs`, `RPC_TAGS` |
| 2 | kernel: daemon additions | `Health`/`HealthLive`/`HealthReport`, `SessionManager.recover`, `loadEnvironment`, `redactValue`, `ContextDeps.services`, `Kernel.health/plugins/sessions.recover`, `kernelBunLayer`, testing re-exports |
| 3 | api: scaffold, problems, auth, health, schemas, OpenAPI | `BureauApi`, `ApiOptions`, `ApiConfig`, `DEFAULT_API_OPTIONS`, `ApiLive`, `serveApi`, `Authorization`, `RequestValidation`, `MutationLimit`, `problem`, `toProblem`, `orProblem`, `PROBLEM_SCHEMAS`, `openApiDocument`, `ApiTestLayer`, `baseUrl`, `authorized`, `json`, `TEST_TOKEN` |
| 4 | api: resource groups | the endpoints of projects, sessions, asks, usage, workspaces, plugins; `found`; `AskService.get`; `fakeProjectConfig`, `createdSession`, `firstEvent` |
| 5 | api: SSE | `GET /api/v1/events`, `DeliveryBuffer`, `buffered`, `toSseEvent`, `heartbeatEvent`, `filterOf`, `readSse` |
| 6 | api: RPC over WebSocket | `GET /api/v1/ws`, `BureauRpcsWithAuth`, `RpcAuthorization`, `RpcRoute`, `WS_PATH`, `wsClient` |
| 7 | client + codegen | `createBureauClient`, `BureauClient`, `ApiError`, `subscribeEvents`, `connectRpc`, `RpcConnection`, `tools/client-codegen`, `generate:client` |
| 8 | daemon | `startDaemon`, `server.json` helpers, the lock, `tokenFor`, `daemonExecArgs`, `spawnDaemon`, `waitForDaemon`, `stopDaemon`, `serveForeground`, the `serve` command, `startDaemonProcess` |
| 9 | CLI thin client | `Bureau`, `localBureau`, `remoteBureau`, `resolveServer`, `ensureDaemon`, `withBureau`, `bureauFlags`, remote refusals, stdout drain |
| 10 | CLI commands | `sessions`, `ask`, `plugins`, the bare status, `table` |
| 11 | gates, CI, docs, spec | green fresh clone, daemon smoke on three platforms, docs page, architecture, CONTRIBUTING, README, research index, spec amendments |

---

### Task 1: `packages/protocol` — the API contract: DTOs, request bodies, problem details, server info, the RPC group

**Files:**
- Create: `packages/protocol/src/api/dto.ts`, `packages/protocol/src/api/requests.ts`, `packages/protocol/src/api/problem.ts`, `packages/protocol/src/api/server-info.ts`, `packages/protocol/src/api/rpc.ts`, `packages/protocol/src/api/dto.test.ts`, `packages/protocol/src/api/problem.test.ts`, `packages/protocol/src/api/rpc.test.ts`, `packages/protocol/src/api/server-info.test.ts`
- Modify: `packages/protocol/src/index.ts` (re-export the five modules), `cspell-words.txt` (add `ndjson` if the spell check asks for it)

**Interfaces:**
- Consumes: `Id`, `Timestamp`, `SessionStatus`, `TurnStatus`, `AnsweredVia` (`common.ts`); `EmployeeSpec`, `PromptInput` (`employee.ts`); `Ask`, `AskAnswer`, `AskRecord` (`ask.ts`); `Usage`, `RateLimit` (`agent-event.ts`); `EventEnvelope` (`events.ts`); `ProjectConfig` (`config.ts`).
- Produces (names every later task uses): schemas and derived types `ProjectDto`, `WorkspaceHandleDto`, `ExternalRefDto`, `SessionDto`, `TurnDto`, `WorkspaceInfoDto`, `PruneReportDto`, `SessionUsageDto`, `PluginStatusDto`, `ProviderDto`, `HealthDto`, `RegisterProjectBody`, `CreateSessionBody`, `PromptBody`, `AnswerAskBody`, `EventsQuery`, `EventsFilter`, `SessionRef`, `Problem`, `ProblemCode`, `PROBLEM_CODES`, `problemType()`, `ServerInfo`, `decodeServerInfo()`, `serverUrl()`, `BureauRpcs` (the `effect/rpc` group), `RPC_TAGS`.

Verified facts this task relies on (fact sheet §1, §4): `effect@4.0.0` exports `Rpc` and `RpcGroup` from `effect/rpc` (`Rpc.make(tag, { payload, success, error, stream })`, `RpcGroup.make(...rpcs)`, `group.requests` is a `ReadonlyMap<string, Rpc>`); `Schema.fromJsonString`, `Schema.optionalKey`, `Schema.NullOr`, `Schema.Literals`, `Schema.Record`, `Schema.Int`, `Schema.Finite`, `Schema.Union`, `Schema.decodeUnknownSync` exist in `effect` 4.0.0 (used by Phase A). Every schema here is a plain `Schema.Struct`, so `Schema.toJsonSchemaDocument` (OpenAPI generation in Task 3) renders it as a closed object the same way `schemas/events.json` is rendered today.

Semantics: the DTOs mirror the kernel records field for field (`Session`, `Turn`, `Project`, `WorkspaceInfo`, `PruneReport`, `SessionUsage`, `PluginStatus` in `packages/kernel/src`); Task 4 pins the mirror with `Schema.encodeSync(SessionDto)(session)` calls that only type-check while the two stay identical. `null` means "absent" on the wire, exactly as the kernel records say it. `Problem` is RFC 9457: `type` is `https://bytebureau.dev/problems/<code>`, `status` the HTTP status, `code` a ByteBureau error code (a string; the well-known ones are listed in `PROBLEM_CODES` and documented, new ones may appear as `workspace_<code>` or `provider_<kind>`), `detail` the one-line reason. `ServerInfo` is the record of `~/.bytebureau/server.json`; the token inside is a secret and is never logged (Task 8 writes the file with mode 0600). `BureauRpcs` is the WebSocket contract (Task 6 serves it, Task 7 speaks it): one streaming procedure `events.subscribe` plus one procedure per mutation; every mutation fails with a `Problem`.

Semantics (as shipped, commit 5febde0): the gates reshaped the brief in four places — `PrunePayload` is a named constant in `rpc.ts` (`unicorn/max-nested-calls`), the tests call `expect.hasAssertions()` and use lower-case `describe` titles, the snake-case check of `problem.test.ts` is a per-word check instead of the brief's regex (`security/detect-unsafe-regex` of the long-tail ESLint), and `server-info.test.ts` covers the IPv6 bracketing of `serverUrl` and the strict refusal of `decodeServerInfo`. `PROBLEM_CODES` gains `workspace_runtime_missing` in Task 3.

- [ ] **Step 1: Write the failing DTO and request tests**

`packages/protocol/src/api/dto.test.ts`:
```ts
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { HealthDto, PluginStatusDto, SessionDto, TurnDto } from './dto.js'
import { CreateSessionBody, EventsQuery } from './requests.js'

const employee = {
  id: 'developer',
  name: 'Developer',
  provider: 'fake',
  model: 'any',
  effort: null,
  systemPrompt: '',
  tools: { allow: [], deny: [] },
  permissionMode: 'supervised',
  skills: [],
  appearance: {},
}

const session = {
  id: '0192f0a0-0000-7000-8000-000000000001',
  projectId: '0192f0a0-0000-7000-8000-000000000002',
  title: 'Create hello',
  employee,
  providerId: 'fake',
  profileId: null,
  workspace: {
    id: '0192f0a0-0000-7000-8000-000000000001',
    runtimeId: 'local',
    path: '/tmp/repo/.bytebureau/worktrees/x',
    branch: 'bb/create-hello',
    baseRef: 'main',
  },
  externalRef: null,
  status: 'ready',
  createdAt: '2026-10-04T10:00:00.000Z',
  startedAt: null,
  endedAt: null,
}

describe('the API DTO schemas', () => {
  it('decodes a session with a workspace and no external ref', () => {
    expect(Schema.decodeUnknownSync(SessionDto)(session)).toStrictEqual(session)
  })

  it('refuses a session with an unknown field', () => {
    expect(() =>
      Schema.decodeUnknownSync(SessionDto)({ ...session, extra: 1 }, { onExcessProperty: 'error' }),
    ).toThrow(/extra/u)
  })

  it('decodes a turn whose usage is null and a plugin status without a reason', () => {
    const turn = {
      id: '0192f0a0-0000-7000-8000-000000000003',
      sessionId: session.id,
      index: 0,
      prompt: { text: 'hi' },
      status: 'completed',
      stopReason: 'end_turn',
      usage: null,
      startedAt: '2026-10-04T10:00:00.000Z',
      endedAt: '2026-10-04T10:00:01.000Z',
    }
    expect(Schema.decodeUnknownSync(TurnDto)(turn)).toStrictEqual(turn)
    const plugin = {
      name: 'fake-agent',
      version: '0.0.0',
      state: 'loaded',
      ports: ['agentProvider'],
    }
    expect(Schema.decodeUnknownSync(PluginStatusDto)(plugin)).toStrictEqual(plugin)
  })

  it('decodes a degraded health report', () => {
    const health = {
      status: 'degraded',
      version: '0.1.0',
      startedAt: '2026-10-04T10:00:00.000Z',
      checks: { store: 'failed', plugins: { loaded: 2, failed: 1 } },
    }
    expect(Schema.decodeUnknownSync(HealthDto)(health)).toStrictEqual(health)
  })
})

describe('the API request schemas', () => {
  it('accepts a session creation with only the required fields', () => {
    const body = { projectId: session.projectId, title: 'x' }
    expect(Schema.decodeUnknownSync(CreateSessionBody)(body)).toStrictEqual(body)
  })

  it('accepts an events query with every filter and with none', () => {
    const full = {
      since: 12,
      session: session.id,
      project: session.projectId,
      types: 'turn.started,turn.completed',
    }
    expect(Schema.decodeUnknownSync(EventsQuery)(full)).toStrictEqual(full)
    expect(Schema.decodeUnknownSync(EventsQuery)({})).toStrictEqual({})
  })
})
```

`packages/protocol/src/api/problem.test.ts`:
```ts
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { PROBLEM_CODES, Problem, problemType } from './problem.js'

describe('problem details', () => {
  it('names the type of a code under the ByteBureau problems base', () => {
    expect(problemType('not_found')).toBe('https://bytebureau.dev/problems/not_found')
  })

  it('decodes a problem with and without an instance', () => {
    const problem = {
      type: problemType('session_not_found'),
      title: 'Not Found',
      status: 404,
      detail: 'no session 42',
      code: 'session_not_found',
    }
    expect(Schema.decodeUnknownSync(Problem)(problem)).toStrictEqual(problem)
    const located = { ...problem, instance: '/api/v1/sessions/42' }
    expect(Schema.decodeUnknownSync(Problem)(located)).toStrictEqual(located)
  })

  it('lists the well-known codes once each, in snake case', () => {
    expect.hasAssertions()
    expect(new Set(PROBLEM_CODES).size).toBe(PROBLEM_CODES.length)
    for (const code of PROBLEM_CODES) {
      for (const word of code.split('_')) {
        expect(word, code).toMatch(/^[a-z]+$/u)
      }
    }
  })
})
```

`packages/protocol/src/api/rpc.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { BureauRpcs, RPC_TAGS } from './rpc.js'

describe('the RPC group', () => {
  it('declares one streaming subscription and one procedure per mutation of the API', () => {
    expect(RPC_TAGS).toStrictEqual([
      'events.subscribe',
      'projects.register',
      'projects.remove',
      'sessions.create',
      'sessions.prompt',
      'sessions.interrupt',
      'sessions.stop',
      'sessions.resume',
      'sessions.complete',
      'asks.answer',
      'workspaces.prune',
    ])
    expect([...BureauRpcs.requests.keys()]).toStrictEqual(RPC_TAGS)
  })
})
```

`packages/protocol/src/api/server-info.test.ts` (added during execution):
```ts
import { describe, expect, it } from 'vitest'
import { decodeServerInfo, serverUrl } from './server-info.js'

const info = {
  version: '0.1.0',
  host: '127.0.0.1',
  port: 4747,
  pid: 4242,
  token: 'test-token',
  startedAt: '2026-10-04T10:00:00.000Z',
}

describe(serverUrl, () => {
  it('names an IPv4 host as it is and brackets an IPv6 host', () => {
    expect(serverUrl(info)).toBe('http://127.0.0.1:4747')
    expect(serverUrl({ host: '::1', port: 4747 })).toBe('http://[::1]:4747')
  })
})

describe(decodeServerInfo, () => {
  it('reads the record of the server file', () => {
    expect(decodeServerInfo(info)).toStrictEqual(info)
  })

  it('refuses a record with a field it does not know or without one it needs', () => {
    expect(() => decodeServerInfo({ ...info, extra: 1 })).toThrow(/extra/u)
    expect(() => decodeServerInfo({ ...info, token: undefined })).toThrow(/token/u)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run build:i18n && bunx vitest run --project protocol`
Expected: FAIL — the `./dto.js`, `./requests.js`, `./problem.js` and `./rpc.js` modules do not exist.

- [ ] **Step 3: Write the DTO schemas**

`packages/protocol/src/api/dto.ts`:
```ts
import { Schema } from 'effect'
import { Usage } from '../agent-event.js'
import { Id, SessionStatus, Timestamp, TurnStatus } from '../common.js'
import { ProjectConfig } from '../config.js'
import { EmployeeSpec, PromptInput } from '../employee.js'

export const ProjectDto = Schema.Struct({
  id: Id,
  name: Schema.String,
  path: Schema.String,
  defaultBranch: Schema.String,
  config: ProjectConfig,
  createdAt: Timestamp,
  updatedAt: Timestamp,
}).annotate({ title: 'Project' })

// The handle of a worktree as the kernel keeps it: the id is the session id
export const WorkspaceHandleDto = Schema.Struct({
  id: Schema.String,
  runtimeId: Schema.String,
  path: Schema.String,
  branch: Schema.String,
  baseRef: Schema.String,
}).annotate({ title: 'WorkspaceHandle' })

export const ExternalRefDto = Schema.Struct({
  providerId: Schema.String,
  ref: Schema.String,
}).annotate({ title: 'ExternalSessionRef' })

export const SessionDto = Schema.Struct({
  id: Id,
  projectId: Id,
  title: Schema.String,
  employee: EmployeeSpec,
  providerId: Schema.String,
  profileId: Schema.NullOr(Schema.String),
  workspace: Schema.NullOr(WorkspaceHandleDto),
  externalRef: Schema.NullOr(ExternalRefDto),
  status: SessionStatus,
  createdAt: Timestamp,
  startedAt: Schema.NullOr(Timestamp),
  endedAt: Schema.NullOr(Timestamp),
}).annotate({ title: 'Session' })

export const TurnDto = Schema.Struct({
  id: Id,
  sessionId: Id,
  index: Schema.Int,
  prompt: PromptInput,
  status: TurnStatus,
  stopReason: Schema.NullOr(Schema.String),
  usage: Schema.NullOr(Usage),
  startedAt: Timestamp,
  endedAt: Schema.NullOr(Timestamp),
}).annotate({ title: 'Turn' })

export const WorkspaceInfoDto = Schema.Struct({
  sessionId: Id,
  projectId: Id,
  path: Schema.String,
  branch: Schema.String,
  baseRef: Schema.String,
  sessionStatus: Schema.String,
  exists: Schema.Boolean,
}).annotate({ title: 'WorkspaceInfo' })

export const PruneReportDto = Schema.Struct({
  removed: Schema.Array(Schema.String),
  retained: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
}).annotate({ title: 'PruneReport' })

export const SessionUsageDto = Schema.Struct({
  turns: Schema.Int,
  inputTokens: Schema.Int,
  outputTokens: Schema.Int,
  costUsd: Schema.NullOr(Schema.Finite),
  contextPct: Schema.NullOr(Schema.Finite),
}).annotate({ title: 'SessionUsage' })

export const PluginStatusDto = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  state: Schema.Literals(['loaded', 'failed']),
  reason: Schema.optionalKey(Schema.String),
  ports: Schema.Array(Schema.String),
}).annotate({ title: 'PluginStatus' })

export const ProviderDto = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
}).annotate({ title: 'Provider' })

export const HealthDto = Schema.Struct({
  status: Schema.Literals(['ok', 'degraded']),
  version: Schema.String,
  startedAt: Timestamp,
  checks: Schema.Struct({
    store: Schema.Literals(['ok', 'failed']),
    plugins: Schema.Struct({ loaded: Schema.Int, failed: Schema.Int }),
  }),
}).annotate({ title: 'Health' })

export type ProjectDto = typeof ProjectDto.Type
export type WorkspaceHandleDto = typeof WorkspaceHandleDto.Type
export type ExternalRefDto = typeof ExternalRefDto.Type
export type SessionDto = typeof SessionDto.Type
export type TurnDto = typeof TurnDto.Type
export type WorkspaceInfoDto = typeof WorkspaceInfoDto.Type
export type PruneReportDto = typeof PruneReportDto.Type
export type SessionUsageDto = typeof SessionUsageDto.Type
export type PluginStatusDto = typeof PluginStatusDto.Type
export type ProviderDto = typeof ProviderDto.Type
export type HealthDto = typeof HealthDto.Type
```

- [ ] **Step 4: Write the request schemas**

`packages/protocol/src/api/requests.ts`:
```ts
import { Schema } from 'effect'
import { AskAnswer } from '../ask.js'
import { Id } from '../common.js'
import { PromptInput } from '../employee.js'

export const RegisterProjectBody = Schema.Struct({ path: Schema.String }).annotate({
  title: 'RegisterProject',
})

// The same fields as the kernel's CreateSessionInput; env carries BYTEBUREAU_* names only, the kernel drops the rest
export const CreateSessionBody = Schema.Struct({
  projectId: Id,
  title: Schema.String,
  employeeId: Schema.optionalKey(Schema.String),
  providerId: Schema.optionalKey(Schema.String),
  profileId: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
}).annotate({ title: 'CreateSession' })

export const PromptBody = PromptInput
export const AnswerAskBody = AskAnswer

export const SessionRef = Schema.Struct({ sessionId: Id }).annotate({ title: 'SessionRef' })

// The query string of GET /events: types is comma-separated, since is the last seq the client has seen
// HttpApiEndpoint decodes a query through a string-tree codec, so Schema.Int reads ?since=12
export const EventsQuery = Schema.Struct({
  since: Schema.optionalKey(Schema.Int),
  session: Schema.optionalKey(Id),
  project: Schema.optionalKey(Id),
  types: Schema.optionalKey(Schema.String),
}).annotate({ title: 'EventsQuery' })

// The filter of the RPC subscription, the shape of the kernel's EventFilter
export const EventsFilter = Schema.Struct({
  since: Schema.optionalKey(Schema.Int),
  sessionId: Schema.optionalKey(Id),
  projectId: Schema.optionalKey(Id),
  types: Schema.optionalKey(Schema.Array(Schema.String)),
  ephemeral: Schema.optionalKey(Schema.Boolean),
}).annotate({ title: 'EventsFilter' })

export type RegisterProjectBody = typeof RegisterProjectBody.Type
export type CreateSessionBody = typeof CreateSessionBody.Type
export type PromptBody = typeof PromptBody.Type
export type AnswerAskBody = typeof AnswerAskBody.Type
export type SessionRef = typeof SessionRef.Type
export type EventsQuery = typeof EventsQuery.Type
export type EventsFilter = typeof EventsFilter.Type
```

- [ ] **Step 5: Write the problem details and the server info schemas**

`packages/protocol/src/api/problem.ts`:
```ts
import { Schema } from 'effect'

export const PROBLEM_TYPE_BASE = 'https://bytebureau.dev/problems/'

// The well-known codes; the API also forms workspace_<code> and provider_<kind> from the kernel's errors
export const PROBLEM_CODES = [
  'request_invalid',
  'unauthorized',
  'forbidden',
  'not_found',
  'payload_too_large',
  'rate_limited',
  'internal',
  'config_invalid',
  'store_unavailable',
  'plugin_failed',
  'session_not_found',
  'session_invalid_transition',
  'session_provider_missing',
  'session_yolo_refused',
  'session_employee_missing',
  'ask_not_found',
  'ask_not_pending',
  'ask_invalid_answer',
  'provider_auth',
  'provider_ratelimit',
  'provider_crash',
  'provider_protocol',
  'provider_missing',
  'workspace_dirty',
  'workspace_locked',
  'workspace_has_sessions',
  'workspace_not_a_repository',
  'workspace_is_bytebureau_worktree',
  'workspace_git_too_old',
  'workspace_git_failed',
  'workspace_fs_failed',
] as const

export type ProblemCode = (typeof PROBLEM_CODES)[number]

export const problemType = (code: string): string => `${PROBLEM_TYPE_BASE}${code}`

// RFC 9457 problem details; code is a ByteBureau error code and type is derived from it
export const Problem = Schema.Struct({
  type: Schema.String,
  title: Schema.String,
  status: Schema.Int,
  detail: Schema.String,
  code: Schema.String,
  instance: Schema.optionalKey(Schema.String),
}).annotate({
  title: 'Problem',
  description: 'RFC 9457 problem details with a ByteBureau error code',
})

export type Problem = typeof Problem.Type
```

`packages/protocol/src/api/server-info.ts`:
```ts
import { Schema } from 'effect'
import { Timestamp } from '../common.js'

// The record of <home>/server.json: where the daemon listens and how to talk to it; the token is a secret
export const ServerInfo = Schema.Struct({
  version: Schema.String,
  host: Schema.String,
  port: Schema.Int,
  pid: Schema.Int,
  token: Schema.String,
  startedAt: Timestamp,
}).annotate({ title: 'ServerInfo' })

export type ServerInfo = typeof ServerInfo.Type

export const decodeServerInfo = (input: unknown): ServerInfo =>
  Schema.decodeUnknownSync(ServerInfo)(input, { onExcessProperty: 'error' })

// An IPv6 host is bracketed in a URL
export const serverUrl = ({ host, port }: Pick<ServerInfo, 'host' | 'port'>): string =>
  `http://${host.includes(':') ? `[${host}]` : host}:${port}`
```

- [ ] **Step 6: Write the RPC group**

`packages/protocol/src/api/rpc.ts`:
```ts
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
```

Append to `packages/protocol/src/index.ts`:
```ts
export * from './api/dto.js'
export * from './api/requests.js'
export * from './api/problem.js'
export * from './api/server-info.js'
export * from './api/rpc.js'
```

- [ ] **Step 7: Run the tests, the type check and the lint**

Run: `bunx vitest run --project protocol && bun run typecheck && bun run lint && bun run format:check && bun run spell`
Expected: PASS. If `RPC_TAGS` comes back in a different order, `RpcGroup.make` keeps insertion order in its `requests` map — the order of the `Rpc.make` calls above is the order the test expects; do not reorder the test, reorder the group. If the spell check flags a word, add it to `cspell-words.txt`.

- [ ] **Step 8: Commit**

```bash
git add packages/protocol/src cspell-words.txt
git commit -m "feat(protocol): add the API contract: DTOs, requests, problem details, server info and the RPC group"
```

### Task 2: Kernel additions for a long-lived daemon — `Health`, recovery at boot, persisted session environment, event payload redaction (ADR-0012), plugin context on the kernel's services, Bun layer export

**Files:**
- Create: `packages/kernel/src/health/health.ts`, `packages/kernel/src/health/health.test.ts`, `packages/kernel/src/sessions/session-recover.ts`, `packages/kernel/src/sessions/session-recover.test.ts`, `packages/kernel/src/sessions/session-environment.ts`, `packages/kernel/src/logging/redact-value.ts`, `packages/kernel/src/logging/redact-value.test.ts`, `packages/kernel/src/events/event-log-redaction.test.ts`, `packages/kernel/src/facade/health.ts`, `docs/decisions/0012-event-payloads-are-redacted-at-publish.md`
- Modify: `packages/kernel/src/store/migrations.ts` (`0002_session_env_owner`), `packages/kernel/src/store/migrate.test.ts`, `packages/kernel/src/sessions/session-records.ts` (`env_json`, `loadEnvironment`), `packages/kernel/src/sessions/session-new.ts` (passes the creation env to the insert), `packages/kernel/src/sessions/session-end.ts` (`makeResume` restores the environment), `packages/kernel/src/sessions/session-environment.test.ts` (new expectation), `packages/kernel/src/sessions/session-shape.ts` + `session-manager.ts` (`recover`), `packages/kernel/src/events/event-log.ts` (redacts the payload at publish), `packages/kernel/src/plugins/plugin-context.ts` + `plugin-host.ts` (`services` in `ContextDeps`), `packages/kernel/src/kernel-live.ts` (`HealthLive`, `Health` in `KernelServices`), `packages/kernel/src/facade/types.ts`, `packages/kernel/src/facade/plugins.ts`, `packages/kernel/src/facade/sessions.ts`, `packages/kernel/src/facade.ts` (boot recovers), `packages/kernel/src/bun.ts` (`kernelBunLayer`), `packages/kernel/src/kernel-test.ts` (re-exports the temp-dir helpers), `packages/kernel/src/index.ts`, `apps/docs/src/content/docs/architecture.md` (one line under Phase A decisions pointing at ADR-0012; the deferred list is rewritten in Task 11)

**Interfaces:**
- Consumes: `SessionDeps`, `settle`, `cancelAsks`, `move`, `listSessions`, `insertSession`, `requireProject`, `currentProject`, `passEnvOf`, `bytebureauEnv`, `REDACTED_FIELDS`, `SECRET_PATTERNS`, `PluginHost`, `SqlClient`, `KernelOptions`, `createKernelFrom`, `prepareHome`, `restrictDatabase`, `bootLevel`, `configureKernelLogging` (all Phase A).
- Produces: `Health` service (`check(): Effect<HealthReport>`), `HealthLive`, `HealthReport { status: 'ok' | 'degraded'; checks: { store: 'ok' | 'failed'; plugins: { loaded: number; failed: number } } }`; `SessionManagerShape.recover(): Effect<readonly string[], SessionError | StoreError>`; `loadEnvironment(sql, sessionId)`; `redactValue(value: unknown): unknown`; `ContextDeps.services`; `Kernel.health.check()`, `Kernel.plugins.list()`, `Kernel.sessions.recover()`; `kernelBunLayer(options): Promise<Layer.Layer<Services>>` from `@bytebureau/kernel/bun`; `tempDir`, `createTempRepo`, `git`, `writeConfig` from `@bytebureau/kernel/testing`.

Verified facts this task relies on: SQLite's `ALTER TABLE … ADD COLUMN … NOT NULL DEFAULT '{}'` is one statement (the migration splitter cuts at `;`); `PRAGMA quick_check` returns one row whose single column reads `ok` on a sound database; `Effect.runPromiseWith(context)(effect)` and `Stream.provideContext(context)` exist in `effect@4.0.0` (`dist/Effect.d.ts` line 16740, `dist/Stream.d.ts` line 13992); `String.prototype.replace` with a global RegExp starts from index 0, so the `g`-flagged `SECRET_PATTERNS` can be reused; `Effect.context<R>()` captures the services of the running layer (Phase A's facade does this already).

Semantics: **Health** — `status` is `ok` when the store answers `quick_check` with `ok` and no plugin failed to load, else `degraded`; the API's `/health` (Task 3) adds the version and the start time. **Recovery** — `recover()` finds every session left in `provisioning`, `running`, `waiting_for_human` or `paused_usage_limit` by a previous process (a session attached in this process is left alone), ends its running turn as `interrupted` with stop reason `daemon_restart`, cancels its pending asks, unlocks its worktree and moves it to `stopped` (publishing `turn.interrupted`, `ask.cancelled` and `session.stopped`), and returns the ids; the Promise facade runs it at boot after the plugins have loaded and logs the ids at info; this is spec §14 "daemon restart" with `stopped` standing in for the spec's "interrupted" (ruling of the plan: `stopped` is the resumable terminal status the state machine already has). **Session environment** — the `BYTEBUREAU_*` entries given at creation are stored in `sessions.env_json` and a resume reads them back, together with `passEnv` of the provider from the current project configuration, so a session resumed by a later process gives its agent the same extra variables as its first start (this reverses Phase A's "a resumed session starts without the environment of its creation"; the test changes accordingly). **Redaction** — every payload goes through `redactValue` once, at `EventLog.publish`, before it is stored or fanned out: a field whose name matches `REDACTED_FIELDS` becomes `[REDACTED]`, a string matching a `SECRET_PATTERNS` pattern is replaced inside, ten levels deep; log sinks keep redacting what they print (defence in depth) — ADR-0012 records the decision. **Plugin context** — the promises a plugin context bridges (`events.publish`, `events.subscribe`, `kv`, `process.spawn`) run with the services captured when the host was built (`Effect.runPromiseWith(deps.services)`, `Stream.provideContext(deps.services)`), so a helper a plugin spawns through the supervisor inherits the kernel's tracer context like any kernel fiber. **Bun layer** — `kernelBunLayer(options)` prepares the home (0700), resolves the log level, configures LogTape and returns the layer of the services over `StoreLive`; `createKernel` is now `createKernelFrom(await kernelBunLayer(options), …)`, and the daemon of Task 8 composes the same layer with the API.

Semantics (as shipped, commits cecde20, 4a88625, 25bd844): recovery is **owner-aware** — the migration `0002_session_env_owner` adds `env_json`, `owner_pid` and `owner_instance` to `sessions`; every kernel layer has one instance id (`live-sessions.ts`), written with the row at registration, claimed on resume (after the environment is read, so a refused resume claims nothing) and claimed by the kernel that attaches the agent on prompt (`session-agent.ts`, inside the session's lock, before the move to `running`); `recover()` (`session-recover.ts`, predicate in `session-owner.ts`, liveness in `process/pid-alive.ts`) selects the five recoverable statuses in SQL (`created` included), stops a session only when nothing of it is attached in this process and its owner is gone (null pid, dead pid, or this pid with another instance id), re-checks under the session lock, logs and skips an unreadable row or a session it cannot settle, and returns the ids it stopped; the tests are `session-recover.test.ts`, `session-recover-owner.test.ts`, `session-recover-failures.test.ts` with `session-recover-fixtures.ts`. The database is made owner-only inside `kernelBunLayer`'s layer right after the store opens it (restricting a file that does not exist yet left a fresh database at 0644); `resume`'s error type gains `ConfigError`; the facade's api constructors live in `facade/apis.ts` (import cap); `health.ts` uses `Effect.match`. Known costs (ledger): a crashed owner's pid reused by an unrelated process keeps its session unrecovered until that pid ends; a session that cannot be settled is retried and skipped at every start; across processes a refused move can leave a stale owner claim in a window of milliseconds (final fix wave: write the owner columns in the same `UPDATE` as the status move); a development home migrated by `cecde20` alone does not open any more (`0002_session_env` was renamed before release — remove that database).

- [ ] **Step 1: Migration and session records**

Append to `MIGRATIONS` in `packages/kernel/src/store/migrations.ts`:
```ts
  {
    id: '0002_session_env',
    // The BYTEBUREAU_* variables given at creation, read back when a later process resumes the session
    sql: `ALTER TABLE sessions ADD COLUMN env_json TEXT NOT NULL DEFAULT '{}'`,
  },
```

In `packages/kernel/src/store/migrate.test.ts` add to the `Store` suite:
```ts
  suite.effect('gives a session an empty environment unless one is stored', () =>
    Effect.gen(function* defaultsEnvironment() {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(PROJECT)
      yield* sql.unsafe(session('s-env', 'p'))
      const rows = yield* sql<{ readonly env_json: string }>`SELECT env_json FROM sessions WHERE id = 's-env'`
      assert.deepStrictEqual(
        rows.map((row) => row.env_json),
        ['{}'],
      )
    }),
  )
```

`packages/kernel/src/sessions/session-records.ts`: add `env_json: Schema.String` to `Stored` (the environment is read by `loadEnvironment`, not carried on `Session`), change `insertSession` to take the environment and store its ByteBureau names only, and add `loadEnvironment`:
```ts
import type { ExternalSessionRef } from '@bytebureau/plugin-api'
import { EmployeeSpec, SessionStatus } from '@bytebureau/protocol'
import { Effect, Schema, type Result } from 'effect'
import type { SqlClient } from 'effect/sql'
import { SessionError, StoreError, toStoreError } from '../errors.js'
import { nowIso } from '../ids.js'
import { bytebureauEnv } from '../process/env-allowlist.js'
import { decodeHandle } from '../workspace/workspace-records.js'
import type { KernelInstance } from './live-sessions.js'
import type { Session } from './types.js'

// A session that has no workspace yet carries this record
const NO_WORKSPACE = '{}'

const ExternalRef = Schema.Struct({ providerId: Schema.String, ref: Schema.String })

// The columns of a session row; the JSON ones are read back with the schemas that wrote them
const Stored = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  title: Schema.String,
  employee_json: Schema.fromJsonString(EmployeeSpec),
  provider_id: Schema.String,
  profile_id: Schema.NullOr(Schema.String),
  workspace_json: Schema.String,
  external_ref: Schema.NullOr(Schema.fromJsonString(ExternalRef)),
  status: SessionStatus,
  created_at: Schema.String,
  started_at: Schema.NullOr(Schema.String),
  ended_at: Schema.NullOr(Schema.String),
  env_json: Schema.String,
  owner_pid: Schema.NullOr(Schema.Number),
  owner_instance: Schema.NullOr(Schema.String),
})

const decodeStored = Schema.decodeUnknownEffect(Stored)

const Environment = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))
const decodeEnvironment = Schema.decodeUnknownEffect(Environment)

// A row that does not fit the protocol is a failure of the store, not a defect
const unreadable = (cause: unknown): StoreError =>
  new StoreError({ cause: new Error('a session record is unreadable', { cause }) })

const workspaceOf = (json: string): ReturnType<typeof decodeHandle> | Effect.Effect<null> =>
  json === NO_WORKSPACE ? Effect.succeed(null) : decodeHandle(json)

const sessionFrom = (stored: typeof Stored.Type): Effect.Effect<Session, Schema.SchemaError> =>
  Effect.map(workspaceOf(stored.workspace_json), (workspace) => ({
    id: stored.id,
    projectId: stored.project_id,
    title: stored.title,
    employee: stored.employee_json,
    providerId: stored.provider_id,
    profileId: stored.profile_id,
    workspace,
    externalRef: stored.external_ref,
    status: stored.status,
    createdAt: stored.created_at,
    startedAt: stored.started_at,
    endedAt: stored.ended_at,
  }))

const toSession = (row: unknown): Effect.Effect<Session, StoreError> =>
  decodeStored(row).pipe(Effect.flatMap(sessionFrom), Effect.mapError(unreadable))

// Who works on a session: the process and the kernel that registered, resumed or prompted it last; nobody for a row from before owners were recorded
export interface SessionOwner {
  readonly pid: number | null
  readonly instance: string | null
}

export interface OwnedSession {
  readonly session: Session
  readonly owner: SessionOwner
}

const toOwned = (row: unknown): Effect.Effect<OwnedSession, StoreError> =>
  decodeStored(row).pipe(
    Effect.flatMap((stored) =>
      Effect.map(sessionFrom(stored), (session) => ({
        session,
        owner: { pid: stored.owner_pid, instance: stored.owner_instance },
      })),
    ),
    Effect.mapError(unreadable),
  )

// The session of the first row; a query that finds no row, or an update that claims none, has none
const firstSession = (rows: readonly unknown[]): Effect.Effect<Session | undefined, StoreError> => {
  const [row] = rows
  return row === undefined ? Effect.undefined : toSession(row)
}

export const loadSession = (
  sql: SqlClient.SqlClient,
  sessionId: string,
): Effect.Effect<Session | undefined, StoreError> =>
  sql`SELECT * FROM sessions WHERE id = ${sessionId}`.pipe(
    Effect.mapError(toStoreError),
    Effect.flatMap((rows) => firstSession(rows)),
  )

export const requireSession = (
  sql: SqlClient.SqlClient,
  sessionId: string,
): Effect.Effect<Session, SessionError | StoreError> =>
  loadSession(sql, sessionId).pipe(
    Effect.flatMap((session) =>
      session === undefined
        ? Effect.fail(
            new SessionError({ code: 'not_found', reason: `session ${sessionId} does not exist` }),
          )
        : Effect.succeed(session),
    ),
  )

// Newest first; the id breaks a tie because uuidv7 ids grow with time
export const listSessions = (
  sql: SqlClient.SqlClient,
): Effect.Effect<readonly Session[], StoreError> =>
  sql`SELECT * FROM sessions ORDER BY created_at DESC, id DESC`.pipe(
    Effect.mapError(toStoreError),
    Effect.flatMap((rows) => Effect.all(rows.map((row) => toSession(row)))),
  )

// What a session is registered with: the environment given at creation and the kernel that owns it
export interface Registration {
  readonly env: Readonly<Record<string, string>>
  readonly owner: KernelInstance
}

// The workspace stays empty until provisioning has made one; only the BYTEBUREAU_* names of the environment are kept
// The owner goes in with the row, so no recovery of another kernel ever sees the session without one
export const insertSession = (
  sql: SqlClient.SqlClient,
  session: Session,
  { env, owner }: Registration,
): Effect.Effect<void, StoreError> =>
  sql`
    INSERT INTO sessions (id, project_id, title, employee_json, provider_id, profile_id, workspace_json, status, created_at, env_json, owner_pid, owner_instance)
    VALUES (${session.id}, ${session.projectId}, ${session.title}, ${JSON.stringify(session.employee)}, ${session.providerId}, ${session.profileId}, ${NO_WORKSPACE}, ${session.status}, ${session.createdAt}, ${JSON.stringify(bytebureauEnv(env))}, ${owner.pid}, ${owner.id})`.pipe(
    Effect.asVoid,
    Effect.mapError(toStoreError),
  )

// The kernel that resumes a session, or attaches its agent, owns it from then on
export const claimOwner = (
  sql: SqlClient.SqlClient,
  sessionId: string,
  owner: KernelInstance,
): Effect.Effect<void, StoreError> =>
  sql`UPDATE sessions SET owner_pid = ${owner.pid}, owner_instance = ${owner.id} WHERE id = ${sessionId}`.pipe(
    Effect.asVoid,
    Effect.mapError(toStoreError),
  )

// A row read on its own: one that does not fit keeps its failure, so it does not hide the others
export interface OwnedRead {
  readonly id: string
  readonly owned: Result.Result<OwnedSession, StoreError>
}

// The sessions in the statuses, with their owners, oldest first
export const listOwned = (
  sql: SqlClient.SqlClient,
  statuses: readonly SessionStatus[],
): Effect.Effect<readonly OwnedRead[], StoreError> =>
  sql<{
    readonly id: string
  }>`SELECT * FROM sessions WHERE ${sql.in('status', statuses)} ORDER BY created_at, id`.pipe(
    Effect.mapError(toStoreError),
    Effect.flatMap((rows) =>
      Effect.all(
        rows.map((row) =>
          Effect.map(Effect.result(toOwned(row)), (owned) => ({ id: row.id, owned })),
        ),
      ),
    ),
  )

export const loadOwned = (
  sql: SqlClient.SqlClient,
  sessionId: string,
): Effect.Effect<OwnedSession | undefined, StoreError> =>
  sql`SELECT * FROM sessions WHERE id = ${sessionId}`.pipe(
    Effect.mapError(toStoreError),
    Effect.flatMap(([row]) => (row === undefined ? Effect.undefined : toOwned(row))),
  )

// The environment stored at creation; a record that does not fit is a failure of the store
export const loadEnvironment = (
  sql: SqlClient.SqlClient,
  sessionId: string,
): Effect.Effect<Readonly<Record<string, string>>, StoreError> =>
  sql<{ readonly env_json: string }>`SELECT env_json FROM sessions WHERE id = ${sessionId}`.pipe(
    Effect.mapError(toStoreError),
    Effect.map(([row]) => (row === undefined ? '{}' : row.env_json)),
    Effect.flatMap((json) => decodeEnvironment(json).pipe(Effect.mapError(unreadable))),
  )

const ENDED = new Set<string>(['completed', 'stopped', 'errored'])

// The session moves only when it is still in the status the caller saw, so a stale decision claims nothing
// A session starts when it first runs and ends when it completes, stops or fails; resuming clears the end
export const claimStatus = (
  sql: SqlClient.SqlClient,
  session: Session,
  next: SessionStatus,
): Effect.Effect<Session | undefined, StoreError> => {
  const now = nowIso()
  const startedAt = next === 'running' ? now : null
  const endedAt = ENDED.has(next) ? now : null
  return sql`
    UPDATE sessions SET status = ${next}, started_at = COALESCE(started_at, ${startedAt}), ended_at = ${endedAt}
    WHERE id = ${session.id} AND status = ${session.status} RETURNING *`.pipe(
    Effect.mapError(toStoreError),
    Effect.flatMap((rows) => firstSession(rows)),
  )
}

export const saveExternalRef = (
  sql: SqlClient.SqlClient,
  sessionId: string,
  ref: ExternalSessionRef,
): Effect.Effect<void, StoreError> =>
  sql`UPDATE sessions SET external_ref = ${JSON.stringify(ref)} WHERE id = ${sessionId}`.pipe(
    Effect.asVoid,
    Effect.mapError(toStoreError),
  )
```
`bytebureauEnv` is the Phase A filter in `packages/kernel/src/process/env-allowlist.ts` that keeps the `BYTEBUREAU_*` names; if its signature takes `Readonly<Record<string, string | undefined>>`, pass `env` as it is. In `packages/kernel/src/sessions/session-new.ts`, the one call of `insertSession` gains the third argument `input.env ?? {}` (the `Creation` carries `input`). If `session-records.ts` crosses 300 lines, move `insertSession` and `loadEnvironment` to a new `session-environment-records.ts` and import them where `insertSession` was imported.

- [ ] **Step 2: Resume restores the environment**

`packages/kernel/src/sessions/session-environment.ts`:
```ts
import { Effect } from 'effect'
import type { ConfigError, SessionError, StoreError } from '../errors.js'
import type { SessionEnvironment } from './live-sessions.js'
import type { SessionDeps } from './session-deps.js'
import { currentProject, passEnvOf, requireProject } from './session-project.js'
import { loadEnvironment } from './session-records.js'
import type { Session } from './types.js'

// A session resumed by a later process gives its agent what its first start had: the stored BYTEBUREAU_* variables and the passEnv names of its provider as the project configures them now
export const storedEnvironment = (
  deps: SessionDeps,
  session: Session,
): Effect.Effect<SessionEnvironment, SessionError | StoreError | ConfigError> =>
  Effect.gen(function* readsEnvironment() {
    const extra = yield* loadEnvironment(deps.sql, session.id)
    const registered = yield* requireProject(deps, session.projectId)
    const project = yield* currentProject(deps, registered)
    return { extra, passEnv: passEnvOf(project, session.providerId) }
  })
```
If `requireProject`/`currentProject` fail with a type the resume shape does not declare, widen `SessionManagerShape.resume` to `SessionError | StoreError | WorkspaceError | ConfigError` — the facade and the API map every one of them.

`packages/kernel/src/sessions/session-end.ts`, `makeResume`:
```ts
export const makeResume =
  (deps: SessionDeps): SessionManagerShape['resume'] =>
  (sessionId) =>
    deps.live.exclusive(
      sessionId,
      Effect.gen(function* resumesSession() {
        const session = yield* move(deps, sessionId, 'resume')
        yield* restoreEnvironment(deps, session)
        return session
      }),
    )
```

`packages/kernel/src/sessions/session-environment.test.ts`: the second test becomes
```ts
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { withEnv } from '../process/supervisor-fixtures.js'
import { startSession } from './session-fixtures.js'
import { SessionManager } from './session-manager.js'
import { prompted } from './session-prompted-fixtures.js'
import { driven } from './session-script-fixtures.js'

const DEVELOPER = {
  name: 'Developer',
  provider: 'scripted',
  model: 'm',
  permissionMode: 'supervised',
}
const CONFIG = {
  version: 1,
  project: { name: 'passing' },
  employees: { developer: DEVELOPER },
  providers: { scripted: { passEnv: ['BB_PASSED'], other: 'for the plugin' } },
}

const world = driven()

it.layer(world.layer)('SessionManager passEnv of a provider', (suite) => {
  suite.effect('passes the variables the provider names in passEnv, and no other', () =>
    Effect.gen(function* passesNamedVariables() {
      yield* withEnv('BB_PASSED', 'yes')
      yield* withEnv('BB_NOT_NAMED', 'no')
      const session = yield* startSession({ providerId: 'scripted' }, CONFIG)
      const { env } = (yield* prompted(world, session)).agent.request
      assert.deepStrictEqual([env['BB_PASSED'], env['BB_NOT_NAMED']], ['yes', undefined])
    }),
  )

  suite.effect(
    'starts the agent of a session resumed after a stop with the environment of its creation, read back from its record',
    () =>
      Effect.gen(function* restoresEnvironment() {
        yield* withEnv('BB_PASSED', 'yes')
        const sessions = yield* SessionManager
        const env = { BYTEBUREAU_EXTRA: '1', NOT_KEPT: 'dropped' }
        const session = yield* startSession({ providerId: 'scripted', env }, CONFIG)
        const first = (yield* prompted(world, session)).agent.request.env
        yield* sessions.stop(session.id)
        yield* sessions.resume(session.id)
        const second = (yield* prompted(world, session, { text: 'again' })).agent.request.env
        assert.deepStrictEqual(
          [
            first['BYTEBUREAU_EXTRA'],
            first['BB_PASSED'],
            first['NOT_KEPT'],
            second['BYTEBUREAU_EXTRA'],
            second['BB_PASSED'],
            second['NOT_KEPT'],
          ],
          ['1', 'yes', undefined, '1', 'yes', undefined],
        )
      }),
  )
})
```

- [ ] **Step 3: Write the failing recovery test**

`packages/kernel/src/sessions/session-recover.test.ts` (the fixtures named here exist in Phase A: `sessionLayer` in `session-layer-fixtures.ts`, `registerRepo`/`typesOf` in `session-fixtures.ts`, `turnStatesOf` in `session-db-fixtures.ts`; read them before writing):
```ts
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { request } from '../asks/ask-fixtures.js'
import { AskService } from '../asks/ask-service.js'
import { WorkspaceManager } from '../workspace/workspace-manager.js'
import { turnStatesOf } from './session-db-fixtures.js'
import { payloadsOf, registerRepo, sessionOf, typesOf } from './session-fixtures.js'
import { sessionLayer } from './session-layer-fixtures.js'
import { SessionManager } from './session-manager.js'
import { leftBehind, provisionedLeft, type Left } from './session-recover-fixtures.js'

// A session left in each status of work by a process that recorded no owner, the waiting one with its question, and a ready one; then the kernel recovers
const recovery = Effect.gen(function* recovers() {
  const project = yield* registerRepo()
  const left = yield* Effect.all({
    created: leftBehind(project.id, 'created'),
    provisioning: leftBehind(project.id, 'provisioning'),
    running: leftBehind(project.id, 'running'),
    waiting: leftBehind(project.id, 'waiting_for_human'),
    paused: leftBehind(project.id, 'paused_usage_limit'),
  })
  const ready = yield* leftBehind(project.id, 'ready')
  const opened = request(left.waiting.sessionId, { turnId: left.waiting.turnId })
  const ask = yield* AskService.use((asks) => asks.open(opened))
  const recovered = yield* SessionManager.use((sessions) => sessions.recover())
  return { left, ready, askId: ask.id, recovered }
})

const statusOf = (left: Left): Effect.Effect<string, unknown, SessionManager> =>
  Effect.map(sessionOf(left.sessionId), (session) => session.status)

const INTERRUPTED = [['interrupted', 'daemon_restart']] as const

it.layer(sessionLayer())('SessionManager.recover', (suite) => {
  suite.effect('stops a session left in each status of work, and leaves a ready one alone', () =>
    Effect.gen(function* stopsLeftBehind() {
      const { left, ready, recovered } = yield* recovery
      const atWork = Object.values(left)
      const statuses = yield* Effect.forEach([...atWork, ready], statusOf)
      assert.deepStrictEqual(recovered.toSorted(), atWork.map((each) => each.sessionId).toSorted())
      assert.deepStrictEqual(statuses, [
        'stopped',
        'stopped',
        'stopped',
        'stopped',
        'stopped',
        'ready',
      ])
    }),
  )

  suite.effect('interrupts the running turns for the restart and cancels the pending ask', () =>
    Effect.gen(function* settlesLeftBehind() {
      const { left, askId } = yield* recovery
      const working = [left.running, left.waiting, left.paused]
      const turns = yield* Effect.all(working.map((each) => turnStatesOf(each.sessionId)))
      const pending = yield* AskService.use((asks) => asks.pending(left.waiting.sessionId))
      assert.deepStrictEqual(turns, [INTERRUPTED, INTERRUPTED, INTERRUPTED])
      assert.deepStrictEqual(pending, [])
      assert.deepStrictEqual(yield* payloadsOf(left.waiting.sessionId, 'ask.cancelled'), [
        { askId },
      ])
    }),
  )

  suite.effect('tells of the interrupted turn, the cancelled ask and the stop, in that order', () =>
    Effect.gen(function* announcesRecovery() {
      const { left } = yield* recovery
      assert.deepStrictEqual(yield* typesOf(left.waiting.sessionId), [
        'ask.requested',
        'turn.interrupted',
        'ask.cancelled',
        'session.stopped',
      ])
      assert.deepStrictEqual(yield* typesOf(left.created.sessionId), ['session.stopped'])
    }),
  )
})

it.layer(sessionLayer())('SessionManager.recover, once more and with a worktree', (suite) => {
  suite.effect('finds nothing left a second time', () =>
    Effect.gen(function* recoversOnce() {
      yield* recovery
      assert.deepStrictEqual(yield* SessionManager.use((sessions) => sessions.recover()), [])
    }),
  )

  suite.effect('unlocks the worktree of a session it stops, so the worktree can go', () =>
    Effect.gen(function* unlocksWorktree() {
      const project = yield* registerRepo()
      const { left, handle } = yield* provisionedLeft(project, 'paused_usage_limit')
      const workspaces = yield* WorkspaceManager
      yield* workspaces.lock(left.sessionId)
      yield* SessionManager.use((sessions) => sessions.recover())
      const outcome = yield* workspaces.destroy(left.sessionId, handle)
      assert.deepStrictEqual([yield* statusOf(left), outcome], ['stopped', { removed: true }])
    }),
  )
})
```
The `?.` in `statusOf` is refused by the lint; write it with a `find` and an `if`. If `turnStatesOf` returns another shape (it exists for Phase A tests), assert on what it returns: the turn's status must be `interrupted` and its stop reason `daemon_restart`. If `OpenAskInput` has other required fields, fill them as `ask-service-fixtures.ts` does.

- [ ] **Step 4: Run it to verify it fails**

Run: `bunx vitest run --project kernel src/sessions/session-recover.test.ts`
Expected: FAIL — `recover` is not a function of the session manager.

- [ ] **Step 5: Recovery**

`packages/kernel/src/sessions/session-recover.ts`:
```ts
import { Effect, Result } from 'effect'
import type { SessionError, StoreError } from '../errors.js'
import type { SessionDeps } from './session-deps.js'
import { settle } from './session-live.js'
import { logger } from './session-logger.js'
import { isLeftBehind, RECOVERABLE } from './session-owner.js'
import { listOwned, loadOwned, type OwnedRead, type OwnedSession } from './session-records.js'
import type { SessionManagerShape } from './session-shape.js'
import { move } from './session-status.js'
import type { Outcome } from './session-turns.js'

const DAEMON_RESTART: Outcome = { status: 'interrupted', stopReason: 'daemon_restart', usage: null }

// A row that cannot be read is told and passed over; the next start finds it again
const readable = ({ id, owned }: OwnedRead): readonly OwnedSession[] => {
  if (Result.isSuccess(owned)) {
    return [owned.success]
  }
  logger.warn('a session left at work cannot be read and is not recovered', {
    sessionId: id,
    reason: owned.failure.message,
  })
  return []
}

// The decision is taken again under the lock of the session, on its row as it stands now: one that moved or found an owner meanwhile is left alone
// Its turn is interrupted, its asks are cancelled, its worktree is unlocked and the session is stopped: resumable, as after any stop
const recoverOne = (
  deps: SessionDeps,
  sessionId: string,
): Effect.Effect<boolean, SessionError | StoreError> =>
  deps.live.exclusive(
    sessionId,
    Effect.gen(function* recoversOne() {
      const current = yield* loadOwned(deps.sql, sessionId)
      if (current === undefined || !isLeftBehind(deps, current)) {
        return false
      }
      yield* settle(deps, current.session, DAEMON_RESTART)
      yield* move(deps, sessionId, 'stop')
      return true
    }),
  )

// A session that cannot be recovered is told and passed over, so the others still are
const attemptOne = (deps: SessionDeps, sessionId: string): Effect.Effect<readonly string[]> =>
  Effect.match(recoverOne(deps, sessionId), {
    onFailure: (failure) => {
      logger.warn('a session left at work could not be recovered', {
        sessionId,
        reason: failure.message,
      })
      return []
    },
    onSuccess: (stopped) => (stopped ? [sessionId] : []),
  })

// Only the sessions in a status of work are read; the ids of those that were stopped are given back
export const makeRecover =
  (deps: SessionDeps): SessionManagerShape['recover'] =>
  () =>
    Effect.gen(function* recoversSessions() {
      const reads = yield* listOwned(deps.sql, RECOVERABLE)
      const left = reads
        .flatMap((read) => readable(read))
        .filter((owned) => isLeftBehind(deps, owned))
      const stopped = yield* Effect.all(left.map(({ session }) => attemptOne(deps, session.id)))
      return stopped.flat()
    })
```
`session-shape.ts` gains `readonly recover: () => Effect.Effect<readonly string[], SessionError | StoreError>`; `session-manager.ts` adds `recover: makeRecover(deps)` to the service.

- [ ] **Step 6: Health**

`packages/kernel/src/health/health.test.ts`:
```ts
import { definePlugin } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { SqlClient, SqlError } from 'effect/sql'
import { hostOver } from '../plugins/plugin-fixtures.js'
import { PluginHost } from '../plugins/plugin-host.js'
import { sessionLayer, withPlugins } from '../sessions/session-layer-fixtures.js'
import { StoreTest } from '../store/store-test.js'
import { Health, HealthLive } from './health.js'

const broken = definePlugin({
  manifest: { name: 'broken', version: '0.0.0', hostApi: '^0.0.0', kind: 'in-process' },
  setup: () => {
    throw new Error('no setup today')
  },
})

const damaged = new SqlError.SqlError({
  reason: new SqlError.UnknownError({
    cause: 'damaged',
    message: 'database disk image is malformed',
    operation: 'quick_check',
  }),
})

// The in-memory store, except that its integrity check fails as a damaged database would
const damagedStore = Layer.effect(
  SqlClient.SqlClient,
  Effect.gen(function* damagesStore() {
    const sql = yield* SqlClient.SqlClient
    return new Proxy(sql, {
      apply: (target, self: unknown, args: unknown[]): unknown =>
        String(args[0]).includes('quick_check')
          ? Effect.fail(damaged)
          : Reflect.apply(target, self, args),
    })
  }),
).pipe(Layer.provide(StoreTest))

it.layer(sessionLayer())('Health over a sound kernel', (suite) => {
  suite.effect('is ok and counts the bundled plugins', () =>
    Effect.gen(function* checks() {
      yield* PluginHost.use((host) => host.load())
      const report = yield* Health.use((health) => health.check())
      assert.deepStrictEqual(report, {
        status: 'ok',
        checks: { store: 'ok', plugins: { loaded: 2, failed: 0 } },
      })
    }),
  )
})

it.layer(withPlugins([broken]))('Health over a kernel with a failed plugin', (suite) => {
  suite.effect('is degraded and counts the failure', () =>
    Effect.gen(function* checks() {
      yield* PluginHost.use((host) => host.load())
      const report = yield* Health.use((health) => health.check())
      assert.deepStrictEqual(report, {
        status: 'degraded',
        checks: { store: 'ok', plugins: { loaded: 2, failed: 1 } },
      })
    }),
  )
})

// The health of that store beside the plugin host of a sound one
const overDamagedStore = HealthLive.pipe(
  Layer.provide(damagedStore),
  Layer.provideMerge(hostOver()),
)

it.layer(overDamagedStore)('Health over a store that fails its check', (suite) => {
  suite.effect('is degraded and names the store', () =>
    Effect.gen(function* checks() {
      yield* PluginHost.use((host) => host.load())
      const report = yield* Health.use((health) => health.check())
      assert.deepStrictEqual(report, {
        status: 'degraded',
        checks: { store: 'failed', plugins: { loaded: 2, failed: 0 } },
      })
    }),
  )
})
```
`definePlugin`'s manifest shape is the one of `packages/plugin-api/src/plugin.ts` (Phase A); copy the fields the type requires from `fake-agent-plugin.ts` if the manifest above misses one.

`packages/kernel/src/health/health.ts`:
```ts
import { Context, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { PluginHost } from '../plugins/plugin-host.js'

type Check = 'ok' | 'failed'

export interface HealthReport {
  readonly status: 'ok' | 'degraded'
  readonly checks: {
    readonly store: Check
    readonly plugins: { readonly loaded: number; readonly failed: number }
  }
}

export interface HealthShape {
  readonly check: () => Effect.Effect<HealthReport>
}

export class Health extends Context.Service<Health, HealthShape>()('bb/Health') {}

// A sound database answers quick_check with one row that says ok; anything else, or a failure to ask, is a failed store
const storeCheck = (sql: SqlClient.SqlClient): Effect.Effect<Check> =>
  sql<{ readonly quick_check: string }>`PRAGMA quick_check`.pipe(
    Effect.match({
      onFailure: (): Check => 'failed',
      onSuccess: (rows): Check =>
        rows.length === 1 && rows[0] !== undefined && rows[0].quick_check === 'ok'
          ? 'ok'
          : 'failed',
    }),
  )

const make = Effect.gen(function* makeHealth() {
  const sql = yield* SqlClient.SqlClient
  const host = yield* PluginHost
  return Health.of({
    check: () =>
      Effect.map(storeCheck(sql), (store): HealthReport => {
        const statuses = host.plugins()
        const failed = statuses.filter((plugin) => plugin.state === 'failed').length
        const plugins = { loaded: statuses.length - failed, failed }
        const status = store === 'ok' && failed === 0 ? 'ok' : 'degraded'
        return { status, checks: { store, plugins } }
      }),
  })
})

export const HealthLive: Layer.Layer<Health, never, SqlClient.SqlClient | PluginHost> =
  Layer.effect(Health, make)
```
`'failed' as const` is the one `as const` the lint allows; if `Effect.catch` is exported as `catch_`, Phase A imports it as `catch` (`import { catch as catch_ }`) — follow the kernel's existing usage. `kernel-live.ts`: add `HealthLive` to the `Layer.mergeAll(ProjectRegistryLive, WorkspaceManagerLive, AskServiceLive)` call (it needs the plugin host, which that merge is provided with) and `Health` to `KernelServices`.

- [ ] **Step 7: Payload redaction**

`packages/kernel/src/logging/redact-value.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { redactValue } from './redact-value.js'

const DEEP_SECRET = 'sk-ant-deep-secret-1234'
// Eleven levels of nesting with the secret at the bottom
const PATH = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
]

// One record per key around the value, the last key innermost
function nested(keys: readonly string[], value: unknown): unknown {
  let inner = value
  for (const key of keys.toReversed()) {
    inner = { [key]: inner }
  }
  return inner
}

// The value at the end of the path, read without trusting the shape of what holds it
function valueAt(value: unknown, keys: readonly string[]): unknown {
  let current = value
  for (const key of keys) {
    current =
      typeof current === 'object' && current !== null ? Reflect.get(current, key) : undefined
  }
  return current
}

describe(redactValue, () => {
  it('replaces the value of a secret-named field and a secret inside a string', () => {
    expect(
      redactValue({
        input: { command: 'curl -H "Authorization: Bearer abc.def-ghi" https://x', api_key: 'k' },
        text: 'use sk-ant-api03-abcdefghij and ghp_abcdefghijklmnop',
        env: { ANTHROPIC_API_KEY: 'sk-ant-zzzzzzzzzz' },
      }),
    ).toStrictEqual({
      input: {
        command: 'curl -H "Authorization: Bearer [REDACTED]" https://x',
        api_key: '[REDACTED]',
      },
      text: 'use [REDACTED] and [REDACTED]',
      env: { ANTHROPIC_API_KEY: '[REDACTED]' },
    })
  })

  it('leaves a payload without secrets as it was, arrays and nulls included', () => {
    const payload = {
      status: 'ready',
      model: null,
      tools: ['Read', 'Write'],
      usage: { inputTokens: 3 },
    }
    expect(redactValue(payload)).toStrictEqual(payload)
  })

  it('stops ten levels deep and keeps what lies deeper', () => {
    const redacted = redactValue(nested(PATH, DEEP_SECRET))
    expect(valueAt(redacted, PATH)).toBe(DEEP_SECRET)
  })
})
```
The `as typeof deep` in the last test is refused by the lint (`no-unsafe-type-assertion`); read the nested value with a small helper that walks `Reflect.get` instead.

`packages/kernel/src/logging/redact-value.ts`:
```ts
import { REDACTED_FIELDS, SECRET_PATTERNS } from './redaction.js'

const MARK = '[REDACTED]'
// Levels the walk descends; what lies deeper is kept as it is
const MAX_DEPTH = 10

const isSecretName = (key: string): boolean => REDACTED_FIELDS.some((pattern) => pattern.test(key))

// The patterns are global, and replace starts each of them at the beginning of the text
function redactString(text: string): string {
  let redacted = text
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement)
  }
  return redacted
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function walk(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return redactString(value)
  }
  if (depth >= MAX_DEPTH) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => walk(item, depth + 1))
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSecretName(key) ? MARK : walk(item, depth + 1),
      ]),
    )
  }
  return value
}

// A JSON value with its secrets replaced: the value of a field named like a secret, and every secret-shaped run of text
export const redactValue = (value: unknown): unknown => walk(value, 0)
```
The `SECRET_PATTERNS` replacement of the URL userinfo pattern uses the `$<scheme>` reference, which `String.prototype.replace` understands; nothing else is needed.

`packages/kernel/src/events/event-log.ts`, `makePublish`: the first line of `publishEvent` becomes `const safe = { ...event, payload: redactValue(event.payload) }` and every later use of `event` in that generator reads `safe` (the insert, the envelope). Import `redactValue` from `../logging/redact-value.js`.

`packages/kernel/src/events/event-log-redaction.test.ts`:
```ts
import { assert, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { StoreTest } from '../store/store-test.js'
import { EventLog, EventLogLive } from './event-log.js'

it.layer(EventLogLive.pipe(Layer.provideMerge(StoreTest)))('EventLog redaction', (suite) => {
  suite.effect('stores and fans out a payload with its secrets replaced', () =>
    Effect.gen(function* redacts() {
      const log = yield* EventLog
      const published = yield* log.publish({
        type: 'tool.started',
        payload: {
          id: 't1',
          name: 'Bash',
          kind: 'bash',
          input: { command: 'export GITHUB_TOKEN=ghp_abcdefghijklmnop', token: 'x' },
        },
      })
      const expected = {
        id: 't1',
        name: 'Bash',
        kind: 'bash',
        input: { command: 'export GITHUB_TOKEN=[REDACTED]', token: '[REDACTED]' },
      }
      assert.deepStrictEqual(published.payload, expected)
      const [stored] = yield* log.read({}, { from: 0 })
      assert.deepStrictEqual(stored === undefined ? undefined : stored.payload, expected)
    }),
  )
})
```
Add `import { Layer } from 'effect'` to it; `event-log.test.ts` is near the 300-line cap, which is why this is a sibling file.

- [ ] **Step 8: The plugin context runs on the kernel's services**

`packages/kernel/src/plugins/plugin-context.ts`: `ContextDeps` gains `readonly services: Context.Context<EventLog | Supervisor | SqlClient.SqlClient>` (import `Context` from `effect`, the `EventLog` and `Supervisor` service classes as types); every `Effect.runPromise(x)` in the file becomes `Effect.runPromiseWith(deps.services)(x)` (pass `deps` to `kvOf` and to the spawner bridge instead of `sql`/`supervisor` alone, or pass `deps.services` beside them), and `eventsOf` ends its stream with `.pipe(Stream.provideContext(deps.services))` before `Stream.toAsyncIterable`. `packages/kernel/src/plugins/plugin-host.ts`, `make`: `const services = yield* Effect.context<EventLog | Supervisor | SqlClient.SqlClient>()` and `const deps = { log, supervisor, sql, secrets, signal: controller.signal, services }`. The Phase A tests of the context (`plugin-context*.test.ts`, `plugin-host*.test.ts`) keep passing; they are the coverage of this step.

- [ ] **Step 9: Facade, Bun layer, exports, ADR**

`packages/kernel/src/facade/types.ts`: add to `Kernel`
```ts
import type { AnsweredVia, Ask, AskAnswer, EventEnvelope, PromptInput } from '@bytebureau/protocol'
import type { ConfigIssue, ResolvedConfig } from '../config/config.js'
import type { EventFilter } from '../events/event-log.js'
import type { HealthReport } from '../health/health.js'
import type { KernelLayerOptions } from '../kernel-live.js'
import type { PluginStatus } from '../plugins/plugin-host.js'
import type { Project } from '../projects/project-registry.js'
import type { CreateSessionInput, Session, Turn } from '../sessions/types.js'
import type { SessionUsage } from '../usage/usage-service.js'
import type { PruneReport, WorkspaceInfo } from '../workspace/workspace-manager.js'

// The log level of the layer comes from logging.level, a string as the command line gives it
export interface KernelOptions extends Omit<KernelLayerOptions, 'logLevel'> {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly logging?:
    | {
        readonly debug?: string | undefined
        readonly level?: string | undefined
        readonly json?: boolean | undefined
      }
    | undefined
}

export interface Kernel {
  readonly projects: {
    readonly register: (path: string) => Promise<Project>
    readonly list: () => Promise<readonly Project[]>
    readonly get: (id: string) => Promise<Project | undefined>
    readonly remove: (id: string) => Promise<void>
  }
  readonly config: {
    readonly load: (projectPath?: string) => Promise<ResolvedConfig>
    readonly validate: (projectPath: string) => Promise<readonly ConfigIssue[]>
    readonly schema: () => Record<string, unknown>
  }
  readonly sessions: {
    readonly create: (input: CreateSessionInput) => Promise<Session>
    readonly prompt: (sessionId: string, input: PromptInput) => Promise<Turn>
    readonly interrupt: (sessionId: string) => Promise<void>
    readonly stop: (sessionId: string) => Promise<void>
    readonly complete: (sessionId: string) => Promise<void>
    readonly resume: (sessionId: string) => Promise<Session>
    readonly list: () => Promise<readonly Session[]>
    readonly get: (id: string) => Promise<Session | undefined>
    /**
     * Stops the sessions left at work by kernels that are gone and resolves with their ids.
     * Meant for the start of a process: the kernel runs it once as it starts, and a session that a running kernel owns is left alone.
     */
    readonly recover: () => Promise<readonly string[]>
  }
  readonly asks: {
    readonly pending: (sessionId?: string) => Promise<readonly Ask[]>
    readonly answer: (askId: string, answer: AskAnswer, via: AnsweredVia) => Promise<void>
  }
  readonly events: {
    /**
     * Replays the durable events after filter.since, all of them when since is left out, and then follows them live.
     * Pass the last seq a consumer has seen as since to resume without a gap or a duplicate.
     */
    readonly subscribe: (filter: EventFilter) => AsyncIterable<EventEnvelope>
    readonly read: (
      filter: EventFilter,
      range: { readonly from: number; readonly to?: number },
    ) => Promise<readonly EventEnvelope[]>
  }
  readonly workspaces: {
    readonly list: (projectId?: string) => Promise<readonly WorkspaceInfo[]>
    readonly prune: (projectId?: string) => Promise<PruneReport>
  }
  readonly usage: { readonly session: (sessionId: string) => Promise<SessionUsage> }
  readonly providers: {
    readonly list: () => readonly { readonly id: string; readonly displayName: string }[]
  }
  readonly plugins: { readonly list: () => readonly PluginStatus[] }
  readonly health: { readonly check: () => Promise<HealthReport> }
  /** Stops the agents and ends the open event subscriptions; a call made after it may reject. */
  readonly close: () => Promise<void>
}
```
(`import type { HealthReport } from '../health/health.js'`, `import type { PluginStatus } from '../plugins/plugin-host.js'`; keep `providers` as it is).

`packages/kernel/src/facade/sessions.ts`: `recover: promised(SessionManager, (sessions) => sessions.recover())`. `packages/kernel/src/facade/plugins.ts`:
```ts
import { Context } from 'effect'
import { PluginHost } from '../plugins/plugin-host.js'
import type { Promised, Services } from './promised.js'
import type { Kernel } from './types.js'

// A plugin that fails to load is reported by the host and does not stop the kernel
export async function loadPlugins(promised: Promised): Promise<void> {
  await promised(PluginHost, (host) => host.load())()
}

// What the host made of each plugin, read without a promise like the providers
export const pluginsApi = (services: Context.Context<Services>): Kernel['plugins'] => ({
  list: () => Context.get(services, PluginHost).plugins(),
})

export const providersApi = (services: Context.Context<Services>): Kernel['providers'] => ({
  list: () =>
    Context.get(services, PluginHost)
      .agentProviders()
      .map((provider) => ({ id: provider.id, displayName: provider.displayName })),
})
```
`packages/kernel/src/facade/health.ts`:
```ts
import { Health } from '../health/health.js'
import type { Promised } from './promised.js'
import type { Kernel } from './types.js'

export const healthApi = (promised: Promised): Kernel['health'] => ({
  check: promised(Health, (health) => health.check()),
})
```
`packages/kernel/src/facade.ts`, `boot`: after `await loadPlugins(promised)`:
```ts
  const recovered = await promised(SessionManager, (sessions) => sessions.recover())()
  if (recovered.length > 0) {
    kernelLogger(['bb', 'core']).info('recovered sessions left by a previous process', { sessions: recovered })
  }
```
and the returned object gains `plugins: pluginsApi(services)`, `health: healthApi(promised)`. (`facade.ts` has `import/max-dependencies` 10 to respect: if the count is exceeded, group the api constructors in `facade/apis.ts` and import that.)

`packages/kernel/src/bun.ts`:
```ts
import path from 'node:path'
import { Effect, Layer } from 'effect'
import type { SqlClient } from 'effect/sql'
import { bootLevel, configureKernelLogging } from './facade/boot-logging.js'
import type { Services } from './facade/promised.js'
import { createKernelFrom, type Kernel, type KernelOptions } from './facade.js'
import { KernelLayer } from './kernel-live.js'
import { effectLevelOf, kernelLogger, type KernelLogLevel } from './logging/logging.js'
import { prepareHome, restrictDatabase } from './store/home.js'
import { StoreLive } from './store/store-live.js'

export { StoreLive } from './store/store-live.js'
export type { Kernel, KernelOptions } from './facade.js'

// What could not be made private is a warning: the start goes on
const warnAll = (warnings: readonly string[]): void => {
  const logger = kernelLogger(['bb', 'store'])
  for (const warning of warnings) {
    logger.warn(warning)
  }
}

// The database, its WAL and its shared memory exist once the store has opened and migrated it; they are narrowed to the user then
const privateStore = (database: string): Layer.Layer<SqlClient.SqlClient> =>
  StoreLive(database).pipe(
    Layer.tap(() =>
      Effect.sync(() => {
        warnAll(restrictDatabase(database))
      }),
    ),
  )

// The services over the store in the database; Effect drops its records below the level LogTape logs at, or below debug with --debug
function layerOf(
  options: KernelOptions,
  level: KernelLogLevel,
  database: string,
): Layer.Layer<Services> {
  const debug = options.logging === undefined ? undefined : options.logging.debug
  const layer = KernelLayer({ ...options, logLevel: effectLevelOf(level, debug) })
  return layer.pipe(Layer.provideMerge(privateStore(database)))
}

// The layer of the binary and of the daemon: the services over the database under the home of the user, with LogTape configured and the home made private
// The log level is resolved once, so LogTape and Effect's own minimum agree; what could not be made private is logged once logging is configured
export async function kernelBunLayer(options: KernelOptions): Promise<Layer.Layer<Services>> {
  const home = prepareHome(options.home)
  const level = await bootLevel(options)
  await configureKernelLogging({ ...options, logging: { ...options.logging, level } })
  warnAll(home.warnings)
  return layerOf(options, level, path.join(home.data, 'bytebureau.db'))
}

// The kernel of the binary; the level is resolved before the layer, so the configuration is read once
export async function createKernel(options: KernelOptions): Promise<Kernel> {
  const level = await bootLevel(options)
  const resolved = { ...options, logging: { ...options.logging, level } }
  return createKernelFrom(await kernelBunLayer(resolved), resolved)
}
```
`createKernelFrom` configures logging again through `boot`; `configureLogging` is idempotent in Phase A (it resets the sinks), so the double call is harmless — if it is not, give `createKernelFrom` an option `{ logging: 'configured' }` to skip it. `restrictDatabase` runs before the store opens the file: it chmods an existing database and says nothing of a missing one (Phase A behaviour), so the order is unchanged.

`packages/kernel/src/kernel-test.ts` appends:
```ts
export { createTempRepo, git, tempDir } from './testing/temp-repo.js'
export { writeConfig } from './testing/repo-config.js'
```
`packages/kernel/src/index.ts` appends `export { Health, HealthLive, type HealthReport, type HealthShape } from './health/health.js'` and `export { redactValue } from './logging/redact-value.js'`.

`docs/decisions/0012-event-payloads-are-redacted-at-publish.md` (same shape as ADR-0011: title, date, status, context, decision, consequences):
```markdown
# Event payloads are redacted once, at publish

- Status: accepted
- Date: 2026-10-04

## Context and problem statement

Phase A stored event payloads as the kernel's services and plugins handed them in and redacted secrets only in the log sinks that print records. The event log is read by the CLI, by the API of Phase B (REST, SSE and RPC), later by the web UI, the phone client and the diagnostic bundle. Each reader redacting on its own would repeat the same code and the first one to forget it would leak. Secrets never belong in events (spec §13); redaction is the second line of defence, not the contract.

## Decision

`EventLog.publish` passes every payload through `redactValue` before it is stored or fanned out: a field whose name matches the kernel's `REDACTED_FIELDS` becomes `[REDACTED]`, a run of text matching `SECRET_PATTERNS` is replaced inside the string, ten levels deep. The same field list and patterns drive the log sinks, which keep redacting what they print. Readers of the log do not redact.

## Consequences

- One place to audit; a reader cannot forget.
- Each payload is redacted on its own: a secret split across two `message.assistant.delta` events reaches live subscribers whole, while the completed message that follows is redacted.
- Redaction is lossy for legitimate text that looks like a secret (a document quoting `sk-ant-…`); the UI shows `[REDACTED]` there. Acceptable: no feature of ByteBureau needs the raw secret, and the agent's own context is unaffected (events are a projection).
- A payload field named like a secret but holding none (`token` counting tokens, say) is replaced too; event schemas use `inputTokens`/`outputTokens`, which do not match `token$`. New schemas must avoid the reserved names, which `redact-value.test.ts` documents.
```
`apps/docs/src/content/docs/architecture.md`: add one line to the Phase A decisions list: "Event payloads are redacted once, at publish ([ADR-0012](../decisions/0012-event-payloads-are-redacted-at-publish/))".

- [ ] **Step 10: Run the kernel suite and the gates**

Run: `bunx vitest run --project kernel && bun run typecheck && bun run lint && bun run format:check && bun run lint:md && bun run spell && bun run knip`
Expected: PASS. The `facade*.test.ts` of Phase A may count the kernel's calls at boot (recovery adds one `SessionManager.recover` call) — adjust the expectation, not the boot.

- [ ] **Step 11: Commit**

```bash
git add packages/kernel docs/decisions/0012-event-payloads-are-redacted-at-publish.md apps/docs/src/content/docs/architecture.md
git commit -m "feat(kernel): add health, boot recovery, a persisted session environment, payload redaction and the bun layer for the daemon"
```

### Task 3: `packages/api` — scaffold, problem details, bearer auth, request validation, rate limit, health and schemas groups, OpenAPI document, Node test server

**Files:**
- Create: `packages/api/package.json`, `packages/api/tsconfig.json`, `packages/api/vitest.config.ts`, `packages/api/src/index.ts`, `packages/api/src/config.ts`, `packages/api/src/problems.ts`, `packages/api/src/auth.ts`, `packages/api/src/validation.ts`, `packages/api/src/token-bucket.ts`, `packages/api/src/rate-limit.ts`, `packages/api/src/groups/health.ts`, `packages/api/src/groups/schemas.ts`, `packages/api/src/api.ts`, `packages/api/src/handlers/health.ts`, `packages/api/src/handlers/schemas.ts`, `packages/api/src/openapi.ts`, `packages/api/src/layer.ts`, `packages/api/src/testing.ts`, `packages/api/scripts/generate-openapi.ts`, `packages/api/openapi.json` (generated, committed), `packages/api/src/problems.test.ts`, `packages/api/src/token-bucket.test.ts`, `packages/api/src/health.test.ts`, `packages/api/src/auth.test.ts`, `packages/api/src/openapi.test.ts`
- Modify: `vitest.config.ts` (project `packages/api`), `knip.ts` (workspace `packages/api` with `scripts/*.ts` entries), `turbo.json` (`@bytebureau/api#build` writes `openapi.json`, inputs exclude it), `.oxlintrc.jsonc` (`packages/api/src/**` joins the `unicorn/no-null` override; it is already in the `no-redeclare` one), `.oxfmtrc.json` (ignore `packages/api/openapi.json` if the formatter touches it), `cspell-words.txt`

**Interfaces:**
- Consumes: `KernelServices`, `KernelLayer`, `Health` (Task 2), the kernel error classes (`SessionError`, `AskError`, `ProviderError`, `WorkspaceError`, `ConfigError`, `PluginError`, `StoreError`), `KernelTest`, `tempDir` (`@bytebureau/kernel/testing`, Task 2 re-exports it); `HealthDto`, `Problem`, `problemType`, `configJsonSchema`, `eventsJsonSchema` (protocol).
- Produces: `BureauApi` (the `HttpApi`; Tasks 4–6 add groups to its `.add(...)` call), `ApiOptions`, `ApiConfig`, `DEFAULT_API_OPTIONS`, `ApiLive(options)`, `serveApi(options)`, `Authorization` + `AuthorizationLive(token)`, `RequestValidation`, `MutationLimit`, `problem()`, `toProblem()`, `orProblem()`, `PROBLEM_SCHEMAS`, `Problem400 … Problem503`, `ApiProblem`, `openApiDocument()`, and for tests `ApiTestLayer(home, overrides?)`, `baseUrl`, `authorized()`, `TEST_TOKEN`, `testOptions()`.

Verified facts this task relies on (fact sheet `docs/research/2026-10-02-reports/16-sp1-phase-b-stack.md` §1, §2, §5, §10): in `effect@4.0.0` the HTTP API DSL lives in `effect/http-api` (`HttpApi.make(id).add(...groups).prefix(path).annotate(key, value)`, `HttpApiGroup.make(id).add(...endpoints).middleware(Service)`, `HttpApiEndpoint.get|post|put|patch|del|head|options(identifier, path, { params, query, headers, payload, success, error })` (`del` declares a DELETE endpoint; `HttpApiEndpoint.make(method)` builds any other), `HttpApiBuilder.group(api, groupId, (handlers) => handlers.handle(endpointId, ({ params, query, payload, headers, request }) => effect))`, `HttpApiBuilder.layer(api, { openapiPath })`, `HttpApiMiddleware.Service<Self>()(id, { security, error })`, `HttpApiMiddleware.layerSchemaErrorTransform(service, transform)`, `HttpApiSecurity.bearer`, `HttpApiSchema.status(code)`, `HttpApiSchema.asJson({ contentType })`, `OpenApi.fromApi(api)` returning an object whose `openapi` field is `"3.1.0"`, `OpenApi.Title`/`OpenApi.Description`/`OpenApi.Version` annotation keys); the server side lives in `effect/http` (`HttpRouter.serve(layer, { disableLogger })`, `HttpRouter.use((router) => router.addGlobalMiddleware(...))`, `HttpMiddleware.cors({ allowedOrigins, allowedMethods, allowedHeaders })`, `HttpIncomingMessage.MaxBodySize` — a `Context.Reference<ByteSize | undefined>` set with `Layer.succeed`, `HttpServerRequest` with `remoteAddress: Option<string>`, `HttpServer.addressFormattedWith(f)`); `@effect/platform-bun@4.0.0` has `BunHttpServer.layer({ hostname, port })` (Task 8) and `@effect/platform-node@4.0.0` has `NodeHttpServer.layer(() => createServer(), { port: 0 })` for Vitest; both were published on 2026-10-01, older than the one-day `minimumReleaseAge`. The `ServiceClass` produced by `HttpApiMiddleware.Service` is a `Context.Service` class, so `Layer.succeed(Service, implementation)` provides it. Phase A sets a Context reference the same way: `Layer.succeed(References.MinimumLogLevel, level)` in `packages/kernel/src/logging/logging.ts`.

Semantics: the API is one `HttpApi` under `/api/v1`; every group except `health` carries the `Authorization` middleware (bearer token, constant-time comparison), every group carries `RequestValidation` (a body, query or path the schema refuses answers `400` with a `request_invalid` problem) and every mutation endpoint (Task 4) carries `MutationLimit` (a token bucket per remote address, `429` with `rate_limited` when it runs dry). Errors are RFC 9457 problems with `content-type: application/problem+json`; one schema per status, told apart by the literal `status`, so the API encodes a problem with the status it carries; `toProblem` maps the kernel's tagged errors to codes and statuses (`SessionError` → `session_<code>`, `AskError` → `ask_<code>`, `ProviderError` → `provider_<kind>`, `WorkspaceError` → `workspace_<code>`, `ConfigError` → `config_invalid` 422, `PluginError` → `plugin_failed` 500, `StoreError` → `store_unavailable` 503, anything else → `internal` 500 with the detail `unexpected failure` and the cause logged, never sent). A request without any `Authorization` header is refused by the security scheme itself with an empty `401`; a request with a wrong token gets the `unauthorized` problem. Request bodies are capped at 10 MB. The OpenAPI 3.1 document is served at `/api/v1/openapi.json` (unauthenticated, it holds no secret) and written to `packages/api/openapi.json` at build time, with a drift test (the same arrangement as `packages/protocol/schemas`). Tests run the real API on `@effect/platform-node`'s server on an ephemeral port over `KernelTest`, and talk to it with the global `fetch`.

Semantics (as shipped, commits 2d7290d, 0ffa99c, 16a75ab): a request without any `Authorization` header gets the `unauthorized` 401 problem as well (Effect hands the middleware an empty credential); `sameToken` is false for an empty expected token and `AuthorizationLive` dies when built with one; `toProblem`/`orProblem` are typed `ApiProblem<KernelStatus>` over `KERNEL_STATUSES = [403, 404, 409, 422, 500, 502, 503]`, the one list `PROBLEM_SCHEMAS` is built from, so every endpoint that calls the kernel declares `error: PROBLEM_SCHEMAS`; `problem()` redacts the detail with the kernel's `redactValue` (the unauthorized detail reads `a valid API token is required`; a project name or path containing an `sk-` word and git's `Bearer realm=` output come out partly `[REDACTED]` — accepted, final wave may narrow the pattern); `RequestValidation` answers the response-side schema error kinds (`Body`, `ResponseHeaders`) with a logged `500 internal`; the API's log lines carry the category `bb.api` (`logging.ts`) and a store failure's cause is logged at warn; the token bucket clamps the elapsed time at 0 and stores a refused state; CORS checks the origin against the list itself (`layer.ts`; Effect would echo a single configured origin to every caller) and there is no CORS layer without origins; problem schemas carry `identifier` annotations and appear under `components.schemas`; the middlewares are composed in `middlewares.ts`, the handler layers in `handlers/all.ts`, the test kernel's temp home in `testing-kernel.ts`, and `ApiTestLayer(overrides?)` takes no home and loads the plugins itself (the kernel's `tempDir` throws when `it.layer` calls it at collection time). The 413 test is `it.effect.skip` until Task 4 adds the content-length precheck. Effect's empty `404`/`500` for unknown routes and defects are accepted for Phase B. `api` joined the `semantic-pr.yml` scopes here (a parity test asked for it).

- [ ] **Step 1: Package scaffold and repository configuration**

`packages/api/package.json`:
```json
{
  "name": "@bytebureau/api",
  "version": "0.0.0",
  "private": true,
  "description": "ByteBureau API: the HTTP API, SSE and RPC adapters over the kernel",
  "license": "FSL-1.1-MIT",
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    },
    "./testing": {
      "types": "./src/testing.ts",
      "default": "./src/testing.ts"
    }
  },
  "scripts": {
    "build": "bun run scripts/generate-openapi.ts",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@bytebureau/kernel": "workspace:*",
    "@bytebureau/protocol": "workspace:*",
    "@effect/platform-bun": "4.0.0",
    "effect": "4.0.0"
  },
  "devDependencies": {
    "@bytebureau/tsconfig": "workspace:*",
    "@effect/platform-node": "4.0.0",
    "@effect/vitest": "4.0.0"
  }
}
```

`packages/api/tsconfig.json`:
```json
{
  "extends": "@bytebureau/tsconfig/effect.json",
  "compilerOptions": { "types": ["bun"] },
  "include": ["src/**/*.ts", "scripts/**/*.ts"]
}
```

`packages/api/vitest.config.ts`:
```ts
import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'api',
    include: ['src/**/*.test.ts'],
    // The node:sqlite module behind the in-memory store warns on Node; the warning is noise in test output
    execArgv: ['--disable-warning=ExperimentalWarning'],
    testTimeout: 20_000,
  },
})
```

Root `vitest.config.ts`: add `'packages/api'` to `projects` after `'packages/kernel'`. Root `knip.ts`: add `'packages/api': { entry: ['scripts/*.ts'], project: ['src/**/*.ts', 'scripts/**/*.ts'] }`. Root `turbo.json`: add
```json
"@bytebureau/api#build": {
  "dependsOn": ["^build"],
  "inputs": ["$TURBO_DEFAULT$", "!openapi.json"],
  "outputs": ["openapi.json"]
}
```
`.oxlintrc.jsonc`: add `"packages/api/src/**"` to the `files` list of the `unicorn/no-null` override (the DTOs carry `null`). Then `bun install` (the lockfile gains `@effect/platform-bun`, `@effect/platform-node`, `@effect/platform-node-shared`, `undici`, `ws`, `@types/ws`; all of them were published more than a day before, see the fact sheet §9).

- [ ] **Step 2: Write the failing unit tests for problems and the token bucket**

`packages/api/src/problems.test.ts`:
```ts
import {
  AskError,
  ConfigError,
  PluginError,
  ProviderError,
  SessionError,
  StoreError,
  WorkspaceError,
} from '@bytebureau/kernel'
import { Effect, Logger, References } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  KERNEL_STATUSES,
  orProblem,
  problem,
  toProblem,
  type ApiProblem,
  type KernelStatus,
  type PROBLEM_SCHEMAS,
} from './problems.js'

const NO_SESSION = 'no session 42'
const API_KEY = 'sk-ant-api03-abcdefghij'

// The typed errors of the kernel with the status, the code and the detail each is told with
const KERNEL_FAILURES: {
  readonly failure: unknown
  readonly status: number
  readonly code: string
  readonly detail: string
}[] = [
  {
    failure: new SessionError({ code: 'not_found', reason: NO_SESSION }),
    status: 404,
    code: 'session_not_found',
    detail: NO_SESSION,
  },
  {
    failure: new SessionError({ code: 'invalid_transition', reason: 'x' }),
    status: 409,
    code: 'session_invalid_transition',
    detail: 'x',
  },
  {
    failure: new SessionError({ code: 'provider_missing', reason: 'x' }),
    status: 422,
    code: 'session_provider_missing',
    detail: 'x',
  },
  {
    failure: new SessionError({ code: 'yolo_refused', reason: 'x' }),
    status: 403,
    code: 'session_yolo_refused',
    detail: 'x',
  },
  {
    failure: new AskError({ code: 'not_pending', reason: 'x' }),
    status: 409,
    code: 'ask_not_pending',
    detail: 'x',
  },
  {
    failure: new AskError({ code: 'invalid_answer', reason: 'x' }),
    status: 422,
    code: 'ask_invalid_answer',
    detail: 'x',
  },
  {
    failure: new ProviderError({
      kind: 'auth',
      reason: `${API_KEY} was refused`,
      retryable: false,
    }),
    status: 502,
    code: 'provider_auth',
    detail: '[REDACTED] was refused',
  },
  {
    failure: new ProviderError({ kind: 'missing', reason: 'x', retryable: false }),
    status: 422,
    code: 'provider_missing',
    detail: 'x',
  },
  {
    failure: new WorkspaceError({ code: 'dirty', reason: 'x' }),
    status: 409,
    code: 'workspace_dirty',
    detail: 'x',
  },
  {
    failure: new WorkspaceError({ code: 'locked', reason: 'x' }),
    status: 409,
    code: 'workspace_locked',
    detail: 'x',
  },
  {
    failure: new WorkspaceError({ code: 'has_sessions', reason: 'x' }),
    status: 409,
    code: 'workspace_has_sessions',
    detail: 'x',
  },
  {
    failure: new WorkspaceError({ code: 'not_a_repository', reason: 'x' }),
    status: 422,
    code: 'workspace_not_a_repository',
    detail: 'x',
  },
  {
    failure: new ConfigError({ file: '/p/bytebureau.json', pointer: '/version', reason: 'bad' }),
    status: 422,
    code: 'config_invalid',
    detail: '/p/bytebureau.json/version: bad',
  },
  {
    failure: new PluginError({ plugin: 'p', reason: 'x' }),
    status: 500,
    code: 'plugin_failed',
    detail: 'p: x',
  },
  // The cause of a store failure (here "disk full") is logged, never told
  {
    failure: new StoreError({ cause: new Error('disk full') }),
    status: 503,
    code: 'store_unavailable',
    detail: 'the store is unavailable',
  },
]

describe('problem details of the API', () => {
  it('builds a problem whose type names its code and whose title names its status', () => {
    expect(problem(404, 'session_not_found', NO_SESSION)).toStrictEqual({
      type: 'https://bytebureau.dev/problems/session_not_found',
      title: 'Not Found',
      status: 404,
      detail: NO_SESSION,
      code: 'session_not_found',
    })
  })

  it.each(KERNEL_FAILURES)('maps $failure to $status $code', ({ failure, ...told }) => {
    expect(toProblem(failure)).toMatchObject(told)
  })

  it('tells nothing of an unknown failure beyond that it was unexpected', () => {
    expect(toProblem(new Error('ENOENT /etc/secret'))).toStrictEqual({
      type: 'https://bytebureau.dev/problems/internal',
      title: 'Internal Server Error',
      status: 500,
      detail: 'unexpected failure',
      code: 'internal',
    })
  })

  it('tells a kernel failure only with a status the endpoints that call the kernel declare', () => {
    // Typed on purpose: a handler's failure must fit the error schemas of PROBLEM_SCHEMAS, or tsc refuses the handler
    const told: ApiProblem<KernelStatus> = toProblem(new StoreError({ cause: 'x' }))
    const declared: (typeof PROBLEM_SCHEMAS)[number]['Type'] = told
    expect(KERNEL_STATUSES).toContain(declared.status)
  })
})

interface LogLine {
  readonly level: string
  readonly message: unknown
  readonly category: unknown
}

// The problem a kernel call that fails so is answered with; the lines logged meanwhile are collected
const problemOf = (failure: unknown, logged: LogLine[]): unknown => {
  const logger = Logger.make((options) => {
    const annotations = options.fiber.getRef(References.CurrentLogAnnotations)
    logged.push({
      level: options.logLevel,
      message: options.message,
      category: annotations['category'],
    })
  })
  const call = Effect.flip(orProblem(Effect.fail(failure)))
  return Effect.runSync(Effect.provide(call, Logger.layer([logger])))
}

describe(orProblem, () => {
  it('turns the failure of a kernel call into its problem and logs under bb.api what it does not tell', () => {
    const logged: LogLine[] = []
    const typed = new AskError({ code: 'not_pending', reason: 'answered already' })
    expect(problemOf(typed, logged)).toMatchObject({ status: 409, code: 'ask_not_pending' })
    expect(logged).toStrictEqual([])
    const full = new Error('disk full')
    const store = problemOf(new StoreError({ cause: full }), logged)
    expect(store).toMatchObject({ status: 503, code: 'store_unavailable' })
    const unexpected = new Error('ENOENT /etc/secret')
    expect(problemOf(unexpected, logged)).toMatchObject({ status: 500, code: 'internal' })
    expect(logged).toStrictEqual([
      { level: 'Warn', message: ['the store failed under an API call', full], category: 'bb.api' },
      {
        level: 'Error',
        message: ['unexpected failure in an API handler', unexpected],
        category: 'bb.api',
      },
    ])
  })
})
```

`packages/api/src/token-bucket.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { TokenBuckets } from './token-bucket.js'

describe(TokenBuckets, () => {
  it('allows capacity calls at once, refuses the next and says when to retry', () => {
    let now = 0
    const buckets = new TokenBuckets({ capacity: 3, perMinute: 60, now: (): number => now })
    expect(buckets.take('a')).toStrictEqual({ allowed: true, retryAfterSec: 0 })
    buckets.take('a')
    buckets.take('a')
    expect(buckets.take('a')).toStrictEqual({ allowed: false, retryAfterSec: 1 })
    now = 1000
    expect(buckets.take('a')).toStrictEqual({ allowed: true, retryAfterSec: 0 })
  })

  it('keeps one bucket per key and forgets a key that is full again', () => {
    let now = 0
    const buckets = new TokenBuckets({ capacity: 1, perMinute: 60, now: (): number => now })
    buckets.take('a')
    expect(buckets.take('b')).toStrictEqual({ allowed: true, retryAfterSec: 0 })
    expect(buckets.size()).toBe(2)
    now = 60_000
    buckets.take('a')
    expect(buckets.size()).toBe(1)
  })

  it('takes no tokens away and keeps refilling when the clock steps back', () => {
    let now = 60_000
    const buckets = new TokenBuckets({ capacity: 1, perMinute: 60, now: (): number => now })
    buckets.take('a')
    now = 0
    expect(buckets.take('a')).toStrictEqual({ allowed: false, retryAfterSec: 1 })
    now = 1000
    expect(buckets.take('a')).toStrictEqual({ allowed: true, retryAfterSec: 0 })
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `bunx vitest run --project api`
Expected: FAIL — the modules do not exist (the project itself must be picked up: if Vitest reports "no test files", the root `vitest.config.ts` edit of Step 1 is missing).

- [ ] **Step 4: Problems, config, auth, validation, rate limit**

`packages/api/src/problems.ts`:
```ts
import {
  AskError,
  ConfigError,
  PluginError,
  ProviderError,
  redactValue,
  SessionError,
  StoreError,
  WorkspaceError,
} from '@bytebureau/kernel'
import { problemType, type Problem } from '@bytebureau/protocol'
import { Effect, Schema } from 'effect'
import { HttpApiSchema } from 'effect/http-api'
import { logApiError, logApiWarning } from './logging.js'

export const PROBLEM_STATUSES = [400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503] as const
export type ProblemStatus = (typeof PROBLEM_STATUSES)[number]

// Every status a kernel failure can turn into; the endpoints that call the kernel declare them all
export const KERNEL_STATUSES = [403, 404, 409, 422, 500, 502, 503] as const
export type KernelStatus = (typeof KERNEL_STATUSES)[number]

const TITLES: Readonly<Record<ProblemStatus, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Content Too Large',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
}

export interface ApiProblem<Status extends ProblemStatus = ProblemStatus> extends Omit<
  Problem,
  'status'
> {
  readonly status: Status
}

type ProblemSchema<Status extends ProblemStatus> = Schema.Struct<{
  readonly type: Schema.String
  readonly title: Schema.String
  readonly status: Schema.Literal<Status>
  readonly detail: Schema.String
  readonly code: Schema.String
  readonly instance: Schema.optionalKey<Schema.String>
}>

// One schema per status, told apart by the literal status, so the API encodes a problem with the status it carries
// The identifier names it under components.schemas of the OpenAPI document
const problemSchema = <Status extends ProblemStatus>(status: Status): ProblemSchema<Status> =>
  Schema.Struct({
    type: Schema.String,
    title: Schema.String,
    status: Schema.Literal(status),
    detail: Schema.String,
    code: Schema.String,
    instance: Schema.optionalKey(Schema.String),
  })
    .annotate({
      identifier: `Problem${status}`,
      title: `Problem${status}`,
      description: 'RFC 9457 problem details',
    })
    .pipe(
      HttpApiSchema.status(status),
      HttpApiSchema.asJson({ contentType: 'application/problem+json' }),
    )

export const Problem400 = problemSchema(400)
export const Problem401 = problemSchema(401)
export const Problem403 = problemSchema(403)
export const Problem404 = problemSchema(404)
export const Problem409 = problemSchema(409)
export const Problem413 = problemSchema(413)
export const Problem422 = problemSchema(422)
export const Problem429 = problemSchema(429)
export const Problem500 = problemSchema(500)
export const Problem502 = problemSchema(502)
export const Problem503 = problemSchema(503)

// The schema of each status; the endpoints and the middlewares that declare a status share its one instance
const SCHEMAS: { readonly [Status in ProblemStatus]: ProblemSchema<Status> } = {
  400: Problem400,
  401: Problem401,
  403: Problem403,
  404: Problem404,
  409: Problem409,
  413: Problem413,
  422: Problem422,
  429: Problem429,
  500: Problem500,
  502: Problem502,
  503: Problem503,
}

// The error schemas of an endpoint that calls the kernel: one per status of KERNEL_STATUSES
export const PROBLEM_SCHEMAS: readonly (typeof SCHEMAS)[KernelStatus][] = KERNEL_STATUSES.map(
  (status) => SCHEMAS[status],
)

// The detail is told with every secret-shaped run of text replaced: it carries reasons from git, plugins and providers
export const problem = <Status extends ProblemStatus>(
  status: Status,
  code: string,
  detail: string,
): ApiProblem<Status> => ({
  type: problemType(code),
  title: TITLES[status],
  status,
  detail: String(redactValue(detail)),
  code,
})

export const UNEXPECTED_FAILURE = problem(500, 'internal', 'unexpected failure')

const SESSION_STATUS: Readonly<Record<SessionError['code'], KernelStatus>> = {
  not_found: 404,
  invalid_transition: 409,
  provider_missing: 422,
  yolo_refused: 403,
  employee_missing: 422,
}
const ASK_STATUS: Readonly<Record<AskError['code'], KernelStatus>> = {
  not_found: 404,
  not_pending: 409,
  invalid_answer: 422,
}
const PROVIDER_STATUS: Readonly<Record<ProviderError['kind'], KernelStatus>> = {
  auth: 502,
  ratelimit: 502,
  crash: 502,
  protocol: 502,
  missing: 422,
}
const CONFLICTS: ReadonlySet<string> = new Set(['locked', 'dirty', 'has_sessions'])
const workspaceStatus = (code: string): KernelStatus => (CONFLICTS.has(code) ? 409 : 422)

const toProblemOfRest = (error: unknown): ApiProblem<KernelStatus> => {
  if (error instanceof ConfigError) {
    return problem(422, 'config_invalid', `${error.file}${error.pointer}: ${error.reason}`)
  }
  if (error instanceof PluginError) {
    return problem(500, 'plugin_failed', `${error.plugin}: ${error.reason}`)
  }
  if (error instanceof StoreError) {
    return problem(503, 'store_unavailable', 'the store is unavailable')
  }
  return UNEXPECTED_FAILURE
}

// The problem a kernel failure is told as; an unknown failure is not described, only logged by the caller
export const toProblem = (error: unknown): ApiProblem<KernelStatus> => {
  if (error instanceof SessionError) {
    return problem(SESSION_STATUS[error.code], `session_${error.code}`, error.reason)
  }
  if (error instanceof AskError) {
    return problem(ASK_STATUS[error.code], `ask_${error.code}`, error.reason)
  }
  if (error instanceof ProviderError) {
    return problem(PROVIDER_STATUS[error.kind], `provider_${error.kind}`, error.reason)
  }
  if (error instanceof WorkspaceError) {
    return problem(workspaceStatus(error.code), `workspace_${error.code}`, error.reason)
  }
  return toProblemOfRest(error)
}

// What the client is not told is logged: the cause behind an unavailable store, and a failure the API did not expect
const logUntold = (failure: unknown): Effect.Effect<void> => {
  if (failure instanceof StoreError) {
    return logApiWarning('the store failed under an API call', failure.cause)
  }
  return toProblem(failure).code === 'internal'
    ? logApiError('unexpected failure in an API handler', failure)
    : Effect.void
}

// A kernel call inside a handler: its failure becomes a problem with a status the endpoint declares
export const orProblem = <Value, Failure, Requirements>(
  effect: Effect.Effect<Value, Failure, Requirements>,
): Effect.Effect<Value, ApiProblem<KernelStatus>, Requirements> =>
  effect.pipe(Effect.tapError(logUntold), Effect.mapError(toProblem))
```

`packages/api/src/config.ts`:
```ts
import { Context, type Duration, type Redacted } from 'effect'

export interface MutationLimitOptions {
  // Calls a client may make at once, and how many tokens a minute flow back
  readonly capacity: number
  readonly perMinute: number
}

export interface ApiOptions {
  readonly version: string
  readonly startedAt: string
  readonly token: Redacted.Redacted
  // Origins browsers may call the API from; empty means none (the embedded UI of SP2 is same-origin)
  readonly corsOrigins: readonly string[]
  readonly heartbeat: Duration.Input
  readonly mutationLimit: MutationLimitOptions
}

export class ApiConfig extends Context.Service<ApiConfig, ApiOptions>()('bb/api/ApiConfig') {}

export const DEFAULT_API_OPTIONS: Omit<ApiOptions, 'version' | 'startedAt' | 'token'> = {
  corsOrigins: [],
  heartbeat: '15 seconds',
  mutationLimit: { capacity: 60, perMinute: 60 },
}
```

`packages/api/src/auth.ts`:
```ts
import { timingSafeEqual } from 'node:crypto'
import { Effect, Layer, Redacted } from 'effect'
import { HttpApiMiddleware, HttpApiSecurity } from 'effect/http-api'
import { Problem401, problem } from './problems.js'

export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
  'bb/api/Authorization',
  { security: { bearer: HttpApiSecurity.bearer }, error: Problem401 },
) {}

// Worded so the redaction of details leaves it alone: it hides any "Bearer <word>"
const UNAUTHORIZED = problem(401, 'unauthorized', 'a valid API token is required')

// An empty token matches nothing, since a request without the header arrives with an empty one
// Otherwise lengths first, then a constant-time comparison: the daemon never tells how much of a token was right
export const sameToken = (given: string, expected: string): boolean => {
  const left = Buffer.from(given, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return right.length > 0 && left.length === right.length && timingSafeEqual(left, right)
}

// A daemon without a token would let every request in, so the layer refuses to build; the caller made a mistake
export const AuthorizationLive = (token: Redacted.Redacted): Layer.Layer<Authorization> => {
  if (Redacted.value(token).length === 0) {
    return Layer.effect(Authorization, Effect.die(new Error('the API token must not be empty')))
  }
  return Layer.succeed(Authorization, {
    bearer: (httpEffect, { credential }) =>
      sameToken(Redacted.value(credential), Redacted.value(token))
        ? httpEffect
        : Effect.fail(UNAUTHORIZED),
  })
}
```

`packages/api/src/validation.ts`:
```ts
import { Effect, type Layer } from 'effect'
import { HttpApiMiddleware } from 'effect/http-api'
import { logApiError } from './logging.js'
import { Problem400, Problem500, problem, UNEXPECTED_FAILURE } from './problems.js'

// A body, query, path or header the schema refuses is a 400 problem that names the part and the reason
export class RequestValidation extends HttpApiMiddleware.Service<RequestValidation>()(
  'bb/api/RequestValidation',
  { error: [Problem400, Problem500] },
) {}

// A response its own schema refuses is a fault of the server: logged, and told as an unexpected failure
const RESPONSE_PARTS: ReadonlySet<string> = new Set(['Body', 'ResponseHeaders'])

export const RequestValidationLive: Layer.Layer<RequestValidation> =
  HttpApiMiddleware.layerSchemaErrorTransform(RequestValidation, (refused) =>
    RESPONSE_PARTS.has(refused.kind)
      ? logApiError('a response its schema refuses', refused.cause).pipe(
          Effect.andThen(Effect.fail(UNEXPECTED_FAILURE)),
        )
      : Effect.fail(problem(400, 'request_invalid', `${refused.kind}: ${refused.cause.message}`)),
  )
```

`packages/api/src/token-bucket.ts`:
```ts
export interface TokenBucketOptions {
  readonly capacity: number
  readonly perMinute: number
  // Milliseconds; injectable so tests move time by hand
  readonly now: () => number
}

export interface Verdict {
  readonly allowed: boolean
  readonly retryAfterSec: number
}

interface Bucket {
  readonly tokens: number
  readonly updatedAt: number
}

const MS_PER_MINUTE = 60_000

// A token bucket per key: a call takes a token, tokens flow back at a steady rate, a full bucket is forgotten
export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>()
  private readonly options: TokenBucketOptions

  public constructor(options: TokenBucketOptions) {
    this.options = options
  }

  public take(key: string): Verdict {
    const now = this.options.now()
    this.forgetFull(now)
    const known = this.buckets.get(key)
    const tokens = known === undefined ? this.options.capacity : this.refilled(known, now)
    const allowed = tokens >= 1
    // Stored with the time of this call even when refused, so after a clock that stepped back tokens flow from there
    this.buckets.set(key, { tokens: allowed ? tokens - 1 : tokens, updatedAt: now })
    if (allowed) {
      return { allowed: true, retryAfterSec: 0 }
    }
    const perMs = this.options.perMinute / MS_PER_MINUTE
    return { allowed: false, retryAfterSec: Math.ceil((1 - tokens) / perMs / 1000) }
  }

  public size(): number {
    return this.buckets.size
  }

  // The tokens of a bucket with what flowed back since it was last seen, at most the capacity; a clock that stepped back takes none away
  private refilled(bucket: Bucket, now: number): number {
    const elapsed = Math.max(0, now - bucket.updatedAt)
    const flowed = (elapsed * this.options.perMinute) / MS_PER_MINUTE
    return Math.min(this.options.capacity, bucket.tokens + flowed)
  }

  // A full bucket is the same as none, so the map keeps only the clients that called lately
  private forgetFull(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (this.refilled(bucket, now) >= this.options.capacity) {
        this.buckets.delete(key)
      }
    }
  }
}
```

`packages/api/src/rate-limit.ts`:
```ts
import { Effect, Layer, Option } from 'effect'
import { HttpServerRequest } from 'effect/http'
import { HttpApiMiddleware } from 'effect/http-api'
import { ApiConfig } from './config.js'
import { Problem429, problem } from './problems.js'
import { TokenBuckets } from './token-bucket.js'

// Mutations are rate limited per client; a client that runs dry gets a 429 problem that says when to retry
export class MutationLimit extends HttpApiMiddleware.Service<MutationLimit>()(
  'bb/api/MutationLimit',
  { error: Problem429 },
) {}

const clientKey = (request: HttpServerRequest.HttpServerRequest): string =>
  Option.getOrElse(request.remoteAddress, () => 'local')

export const MutationLimitLive: Layer.Layer<MutationLimit, never, ApiConfig> = Layer.effect(
  MutationLimit,
  Effect.gen(function* makeMutationLimit() {
    const { mutationLimit } = yield* ApiConfig
    const buckets = new TokenBuckets({ ...mutationLimit, now: Date.now })
    return (httpEffect) =>
      Effect.gen(function* limitsMutation() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const verdict = buckets.take(clientKey(request))
        if (!verdict.allowed) {
          return yield* Effect.fail(
            problem(429, 'rate_limited', `retry after ${verdict.retryAfterSec} s`),
          )
        }
        return yield* httpEffect
      })
  }),
)
```

- [ ] **Step 5: Groups, API, handlers, OpenAPI**

`packages/api/src/groups/health.ts`:
```ts
import { HealthDto } from '@bytebureau/protocol'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { RequestValidation } from '../validation.js'

// The one group without a bearer token: a client checks the daemon with it before it has read the token
export const HealthGroup = HttpApiGroup.make('health')
  .add(HttpApiEndpoint.get('check', '/health', { success: HealthDto }))
  .middleware(RequestValidation)
```

`packages/api/src/groups/schemas.ts`:
```ts
import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { Authorization } from '../auth.js'
import { RequestValidation } from '../validation.js'

const JsonObject = Schema.Record(Schema.String, Schema.Unknown).annotate({
  title: 'JsonSchemaDocument',
})

export const SchemasGroup = HttpApiGroup.make('schemas')
  .add(
    HttpApiEndpoint.get('config', '/schemas/config.json', { success: JsonObject }),
    HttpApiEndpoint.get('events', '/schemas/events.json', { success: JsonObject }),
  )
  .middleware(Authorization)
  .middleware(RequestValidation)
```

`packages/api/src/api.ts` (Tasks 4–6 add their groups to the `.add(...)` call):
```ts
import { HttpApi, OpenApi } from 'effect/http-api'
import { HealthGroup } from './groups/health.js'
import { SchemasGroup } from './groups/schemas.js'

export const API_PREFIX = '/api/v1'

export const BureauApi = HttpApi.make('bytebureau')
  .add(HealthGroup, SchemasGroup)
  .prefix(API_PREFIX)
  .annotate(OpenApi.Title, 'ByteBureau API')
  .annotate(OpenApi.Version, 'v1')
  .annotate(
    OpenApi.Description,
    'The local daemon of ByteBureau: projects, sessions, asks, usage, workspaces, plugins and the event stream.',
  )
```

`packages/api/src/handlers/health.ts`:
```ts
import { Health } from '@bytebureau/kernel'
import { Effect } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { BureauApi } from '../api.js'
import { ApiConfig } from '../config.js'

export const HealthHandlers = HttpApiBuilder.group(BureauApi, 'health', (handlers) =>
  handlers.handle('check', () =>
    Effect.gen(function* checksHealth() {
      const { version, startedAt } = yield* ApiConfig
      const report = yield* Health.use((health) => health.check())
      return { status: report.status, version, startedAt, checks: report.checks }
    }),
  ),
)
```

`packages/api/src/handlers/schemas.ts`:
```ts
import { configJsonSchema, eventsJsonSchema } from '@bytebureau/protocol'
import { Effect } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { BureauApi } from '../api.js'

export const SchemasHandlers = HttpApiBuilder.group(BureauApi, 'schemas', (handlers) =>
  handlers
    .handle('config', () => Effect.sync(() => configJsonSchema()))
    .handle('events', () => Effect.sync(() => eventsJsonSchema())),
)
```

`packages/api/src/openapi.ts`:
```ts
import { OpenApi } from 'effect/http-api'
import { BureauApi } from './api.js'

// The OpenAPI 3.1 document of the API; written to openapi.json at build time and served at /api/v1/openapi.json
export const openApiDocument = (): OpenApi.OpenAPISpec => OpenApi.fromApi(BureauApi)
```

`packages/api/scripts/generate-openapi.ts`:
```ts
#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { openApiDocument } from '../src/openapi.js'

writeFileSync(
  path.join(import.meta.dirname, '..', 'openapi.json'),
  `${JSON.stringify(openApiDocument(), undefined, 2)}\n`,
)
```

- [ ] **Step 6: The layers and the test server**

`packages/api/src/layer.ts`:
```ts
import type { KernelServices } from '@bytebureau/kernel'
import { ByteSize, Layer, type FileSystem, type Path } from 'effect'
import {
  HttpIncomingMessage,
  HttpMiddleware,
  HttpRouter,
  type Etag,
  type HttpPlatform,
  type HttpServer,
} from 'effect/http'
import { HttpApiBuilder } from 'effect/http-api'
import type { SqlClient } from 'effect/sql'
import { API_PREFIX, BureauApi } from './api.js'
import { ApiConfig, type ApiOptions } from './config.js'
import { Handlers } from './handlers/all.js'
import { Middlewares } from './middlewares.js'

export const OPENAPI_PATH = `${API_PREFIX}/openapi.json` as const
const MAX_BODY = ByteSize.megabytes(10)

// What the platform layer of the server provides (BunHttpServer.layer in the binary, NodeHttpServer.layer under Vitest)
export type ServerPlatform =
  | HttpPlatform.HttpPlatform
  | FileSystem.FileSystem
  | Path.Path
  | Etag.Generator

// A handler reads the kernel when a request comes (a requirement of the request) or when the routes are built
export type ApiRequirements =
  | HttpRouter.HttpRouter
  | ServerPlatform
  | KernelServices
  | SqlClient.SqlClient
  | HttpRouter.Request.From<'Requires', KernelServices>

// The endpoints of the API with their handlers and middlewares
// One configuration layer serves the middlewares, built with it, and the handlers, which read it with each request
const Routes = (options: ApiOptions): Layer.Layer<never, never, ApiRequirements> => {
  const config = Layer.succeed(ApiConfig, options)
  const middlewares = Middlewares(options.token).pipe(Layer.provide(config))
  return HttpApiBuilder.layer(BureauApi, { openapiPath: OPENAPI_PATH }).pipe(
    Layer.provide(Handlers),
    Layer.provide(middlewares),
    HttpRouter.provideRequest(config),
  )
}

// Browsers may call the API only from the listed origins; with none listed there is no CORS at all (the embedded UI of SP2 is same-origin)
// A predicate rather than the list: with a list of one, Effect would name that origin to every requester
const Cors = (origins: readonly string[]): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  origins.length === 0
    ? Layer.empty
    : HttpRouter.use((router) =>
        router.addGlobalMiddleware(
          HttpMiddleware.cors({
            allowedOrigins: (origin) => origins.includes(origin),
            allowedMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['authorization', 'content-type', 'last-event-id'],
          }),
        ),
      )

const BodyLimit = Layer.succeed(HttpIncomingMessage.MaxBodySize, MAX_BODY)

// The routes of the API on the router of the environment; the OpenAPI document is served next to them
export const ApiLive = (options: ApiOptions): Layer.Layer<never, never, ApiRequirements> =>
  Layer.mergeAll(Routes(options), Cors(options.corsOrigins)).pipe(Layer.provide(BodyLimit))

// The API served by the HttpServer of the environment; the router is private to it
export const serveApi = (
  options: ApiOptions,
): Layer.Layer<
  never,
  never,
  HttpServer.HttpServer | ServerPlatform | KernelServices | SqlClient.SqlClient
> => HttpRouter.serve(ApiLive(options), { disableLogger: true })
```
If the compiler names a service the alias misses (or one it does not need), adjust `ServerPlatform`; the shape of the layer is the point, not the exact alias. `Layer.empty` is the layer that provides nothing; if `effect@4.0.0` spells it differently (`Layer.succeedContext(Context.empty())`), use that. Body size: `MaxBodySize` bounds the bodies the Node server of the tests reads; on Bun the limit that counts is `maxRequestBodySize` of `BunHttpServer.layer` (fact sheet §1.8, §5), which Task 8 sets to the same 10 MB — Bun answers an oversized body with an empty `413`, a documented exception to the problem bodies.

`packages/api/src/middlewares.ts` (added during execution):
```ts
import { Layer, type Redacted } from 'effect'
import { AuthorizationLive, type Authorization } from './auth.js'
import type { ApiConfig } from './config.js'
import { MutationLimitLive, type MutationLimit } from './rate-limit.js'
import { RequestValidationLive, type RequestValidation } from './validation.js'

// The middlewares the groups declare: the bearer token, the validation of requests and the limit on mutations
export const Middlewares = (
  token: Redacted.Redacted,
): Layer.Layer<Authorization | RequestValidation | MutationLimit, never, ApiConfig> =>
  Layer.mergeAll(AuthorizationLive(token), RequestValidationLive, MutationLimitLive)
```
`packages/api/src/handlers/all.ts` (added during execution):
```ts
import { Layer } from 'effect'
import { HealthHandlers } from './health.js'
import { SchemasHandlers } from './schemas.js'

// The handler layers of every group; Tasks 4–6 add theirs here
export const Handlers = Layer.mergeAll(HealthHandlers, SchemasHandlers)
```
`packages/api/src/logging.ts` (added during execution):
```ts
import { Effect } from 'effect'

// The kernel's LogTape bridge files a log line under its category annotation; the API's own lines go to bb.api
const underApi = Effect.annotateLogs('category', 'bb.api')

export const logApiError = (...parts: readonly unknown[]): Effect.Effect<void> =>
  underApi(Effect.logError(...parts))

export const logApiWarning = (...parts: readonly unknown[]): Effect.Effect<void> =>
  underApi(Effect.logWarning(...parts))
```
`packages/api/src/testing-kernel.ts` (added during execution):
```ts
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PluginHost, type KernelServices } from '@bytebureau/kernel'
import { KernelTest } from '@bytebureau/kernel/testing'
import { Effect, Layer } from 'effect'
import type { SqlClient } from 'effect/sql'

// A home of its own for the kernel of a suite, removed when the layer is released; the kernel's tempDir lives only as long as one test
const tempHome = Effect.acquireRelease(
  Effect.sync(() => {
    const created = mkdtempSync(path.join(tmpdir(), 'bb-api-'))
    return realpathSync(created)
  }),
  (home) =>
    Effect.sync(() => {
      rmSync(home, { recursive: true, force: true })
    }),
)

// The test kernel over the home with its plugins loaded, as the daemon loads them at start
const bootedOver = (home: string): Layer.Layer<KernelServices | SqlClient.SqlClient> =>
  Layer.effectDiscard(PluginHost.use((host) => host.load())).pipe(
    Layer.provideMerge(KernelTest({ home, env: {} })),
  )

export const BootedKernel: Layer.Layer<KernelServices | SqlClient.SqlClient> = Layer.unwrap(
  tempHome.pipe(Effect.map((home) => bootedOver(home))),
)
```
`packages/api/src/cors.test.ts` (added during execution):
```ts
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ApiTestLayer, baseUrl, fetched } from './testing.js'

const UI = 'http://ui.test'

// The preflight a browser sends from the origin before it reads the events schema
const preflight = (origin: string): RequestInit => ({
  method: 'OPTIONS',
  headers: { origin, 'access-control-request-method': 'GET' },
})

it.layer(ApiTestLayer({ corsOrigins: [UI] }))('CORS for a configured origin', (suite) => {
  suite.effect('answers the preflight of the origin with the origin and the token header', () =>
    Effect.gen(function* answersPreflight() {
      const base = yield* baseUrl
      const response = yield* fetched(`${base}/api/v1/schemas/events.json`, preflight(UI))
      assert.strictEqual(response.status, 204)
      assert.strictEqual(response.headers.get('access-control-allow-origin'), UI)
      assert.include(response.headers.get('access-control-allow-headers'), 'authorization')
    }),
  )

  suite.effect('names no origin to an origin off the list', () =>
    Effect.gen(function* refusesOthers() {
      const base = yield* baseUrl
      const other = preflight('http://elsewhere.test')
      const response = yield* fetched(`${base}/api/v1/schemas/events.json`, other)
      assert.isNull(response.headers.get('access-control-allow-origin'))
    }),
  )
})

it.layer(ApiTestLayer())('CORS by default', (suite) => {
  suite.effect('lets no browser origin read an answer', () =>
    Effect.gen(function* refusesOrigins() {
      const base = yield* baseUrl
      const response = yield* fetched(`${base}/api/v1/health`, { headers: { origin: UI } })
      assert.strictEqual(response.status, 200)
      assert.isNull(response.headers.get('access-control-allow-origin'))
    }),
  )
})
```
`packages/api/src/validation.test.ts` (added during execution):
```ts
import { createServer } from 'node:http'
import { NodeHttpServer } from '@effect/platform-node'
import { assert, it } from '@effect/vitest'
import { Effect, Layer, Logger, References, Schema } from 'effect'
import { HttpRouter } from 'effect/http'
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { baseUrl, bodyOf, fetched } from './testing.js'
import { RequestValidation, RequestValidationLive } from './validation.js'

// An endpoint that reads a number from its query, and one whose answer its own schema refuses
const Probe = HttpApi.make('probe').add(
  HttpApiGroup.make('probe')
    .add(
      HttpApiEndpoint.get('since', '/since', {
        query: { since: Schema.FiniteFromString },
        success: Schema.Finite,
      }),
      HttpApiEndpoint.get('broken', '/broken', { success: Schema.Int }),
    )
    .middleware(RequestValidation),
)

const ProbeHandlers = HttpApiBuilder.group(Probe, 'probe', (handlers) =>
  handlers
    .handle('since', ({ query }) => Effect.succeed(query.since))
    .handle('broken', () => Effect.succeed(0.5)),
)

// The categories of the lines the server logs
const categories: unknown[] = []
const capture = Logger.make((options) => {
  categories.push(options.fiber.getRef(References.CurrentLogAnnotations)['category'])
})

const ProbeServer = HttpRouter.serve(
  HttpApiBuilder.layer(Probe).pipe(
    Layer.provide(ProbeHandlers),
    Layer.provide(RequestValidationLive),
  ),
  { disableLogger: true, disableListenLog: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port: 0, host: '127.0.0.1' })),
  Layer.provide(Logger.layer([capture])),
)

it.layer(ProbeServer)('RequestValidation', (suite) => {
  suite.effect('answers input the schema refuses with a 400 problem that names the part', () =>
    Effect.gen(function* refusesInput() {
      const base = yield* baseUrl
      const response = yield* fetched(`${base}/since?since=soon`)
      assert.strictEqual(response.status, 400)
      assert.include(response.headers.get('content-type'), 'application/problem+json')
      assert.containSubset(yield* bodyOf(response), {
        code: 'request_invalid',
        detail: 'Query: Expected a finite number\n  at ["since"]',
      })
    }),
  )

  suite.effect('answers a response its schema refuses as an internal failure and logs it', () =>
    Effect.gen(function* refusesResponse() {
      const base = yield* baseUrl
      const response = yield* fetched(`${base}/broken`)
      assert.strictEqual(response.status, 500)
      assert.deepStrictEqual(yield* bodyOf(response), {
        type: 'https://bytebureau.dev/problems/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'unexpected failure',
        code: 'internal',
      })
      assert.deepStrictEqual(categories, ['bb.api'])
    }),
  )
})
```

`packages/api/src/index.ts`:
```ts
export { BureauApi, API_PREFIX } from './api.js'
export {
  ApiConfig,
  DEFAULT_API_OPTIONS,
  type ApiOptions,
  type MutationLimitOptions,
} from './config.js'
export {
  ApiLive,
  serveApi,
  OPENAPI_PATH,
  type ApiRequirements,
  type ServerPlatform,
} from './layer.js'
export { Authorization, AuthorizationLive, sameToken } from './auth.js'
export { RequestValidation } from './validation.js'
export { MutationLimit } from './rate-limit.js'
export { openApiDocument } from './openapi.js'
export {
  problem,
  toProblem,
  orProblem,
  PROBLEM_SCHEMAS,
  PROBLEM_STATUSES,
  KERNEL_STATUSES,
  Problem400,
  Problem401,
  Problem403,
  Problem404,
  Problem409,
  Problem413,
  Problem422,
  Problem429,
  Problem500,
  Problem502,
  Problem503,
  type ApiProblem,
  type KernelStatus,
  type ProblemStatus,
} from './problems.js'
```

`packages/api/src/testing.ts`:
```ts
import { createServer } from 'node:http'
import type { KernelServices } from '@bytebureau/kernel'
import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer, Redacted } from 'effect'
import { HttpServer, type HttpServerError } from 'effect/http'
import type { SqlClient } from 'effect/sql'
import { DEFAULT_API_OPTIONS, type ApiOptions } from './config.js'
import { serveApi } from './layer.js'
import { BootedKernel } from './testing-kernel.js'

export const TEST_TOKEN = 'test-token-0123456789abcdef0123456789abcdef0123456789abcdef'

export const testOptions = (overrides: Partial<ApiOptions> = {}): ApiOptions => ({
  ...DEFAULT_API_OPTIONS,
  version: '0.0.0-test',
  startedAt: '2026-10-04T00:00:00.000Z',
  token: Redacted.make(TEST_TOKEN),
  ...overrides,
})

// The API over the test kernel on an ephemeral loopback port of the Node server; a test reads the address from HttpServer
export const ApiTestLayer = (
  overrides: Partial<ApiOptions> = {},
): Layer.Layer<
  HttpServer.HttpServer | KernelServices | SqlClient.SqlClient,
  HttpServerError.ServeError
> =>
  serveApi(testOptions(overrides)).pipe(
    Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port: 0, host: '127.0.0.1' })),
    Layer.provideMerge(BootedKernel),
  )

// http://127.0.0.1:<port>, whatever form the platform prints the address in
export const baseUrl: Effect.Effect<string, never, HttpServer.HttpServer> =
  HttpServer.addressFormattedWith((address) =>
    Effect.succeed(address.startsWith('http') ? address : `http://${address}`),
  )

// The request with the bearer token of the tests added to the headers it already has
export const authorized = (init: RequestInit = {}): RequestInit => {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${TEST_TOKEN}`)
  return { ...init, headers }
}

export const json = (body: unknown): RequestInit =>
  authorized({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

// What the server answers, as an effect a test yields
export const fetched = (url: string, init?: RequestInit): Effect.Effect<Response> =>
  Effect.promise(async () => {
    const response = await fetch(url, init)
    return response
  })

// The JSON body of an answer
export const bodyOf = (response: Response): Effect.Effect<unknown> =>
  Effect.promise(async () => {
    const body: unknown = await response.json()
    return body
  })
```
`Layer.provideMerge(KernelTest(...))` exposes the kernel services too, so a test can call the kernel directly next to the HTTP calls; the declared type may need `HttpServer.HttpServer | KernelServices | SqlClient.SqlClient` — widen it if the compiler asks.

- [ ] **Step 7: Write the failing server tests**

`packages/api/src/health.test.ts`:
```ts
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ApiTestLayer, baseUrl, bodyOf, fetched } from './testing.js'

it.layer(ApiTestLayer())('GET /api/v1/health over the test kernel', (suite) => {
  suite.effect('answers without a token with the status, the version and the checks', () =>
    Effect.gen(function* checksHealth() {
      const base = yield* baseUrl
      const response = yield* fetched(`${base}/api/v1/health`)
      assert.strictEqual(response.status, 200)
      assert.include(response.headers.get('content-type'), 'application/json')
      assert.deepStrictEqual(yield* bodyOf(response), {
        status: 'ok',
        version: '0.0.0-test',
        startedAt: '2026-10-04T00:00:00.000Z',
        checks: { store: 'ok', plugins: { loaded: 2, failed: 0 } },
      })
    }),
  )

  suite.effect('serves the OpenAPI document without a token', () =>
    Effect.gen(function* readsOpenApi() {
      const base = yield* baseUrl
      const response = yield* fetched(`${base}/api/v1/openapi.json`)
      assert.strictEqual(response.status, 200)
      assert.containSubset(yield* bodyOf(response), {
        openapi: '3.1.0',
        info: { title: 'ByteBureau API' },
      })
    }),
  )
})
```
The two loaded plugins are the bundled `workspace-local` and the fake agent (`BUNDLED_PLUGINS` in the kernel); if the kernel of Task 2 reports another count, the test follows the kernel.

`packages/api/src/auth.test.ts`:
```ts
import { configJsonSchema, eventsJsonSchema } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Cause, Effect, Exit, Layer, Redacted } from 'effect'
import { describe, expect } from 'vitest'
import { AuthorizationLive, sameToken } from './auth.js'
import { ApiTestLayer, authorized, baseUrl, bodyOf, fetched, json } from './testing.js'

const EVENTS_SCHEMA = '/api/v1/schemas/events.json'

// What a refused request carries in its Authorization header: nothing, an empty bearer token, a wrong one
const REFUSED: [string, Record<string, string>][] = [
  ['no Authorization header', {}],
  ['an empty bearer token', { authorization: 'Bearer ' }],
  ['a wrong token', { authorization: 'Bearer not-the-token' }],
]

// What building the layer dies with, or nothing when it builds
const buildFailure = <Out>(layer: Layer.Layer<Out>): string => {
  const built = Effect.runSyncExit(Effect.scoped(Layer.build(layer)))
  return Exit.match(built, { onFailure: (cause) => Cause.pretty(cause), onSuccess: () => '' })
}

describe(sameToken, () => {
  it('is true only for the same token, whatever the length of the other, and never for an empty one', () => {
    expect(sameToken('abc', 'abc')).toBe(true)
    expect(sameToken('abc', 'abd')).toBe(false)
    expect(sameToken('ab', 'abc')).toBe(false)
    expect(sameToken('', '')).toBe(false)
  })
})

describe(AuthorizationLive, () => {
  it('refuses to build without a token, which would let every request in', () => {
    const withoutToken = AuthorizationLive(Redacted.make(''))
    expect(buildFailure(withoutToken)).toContain('the API token must not be empty')
    const withToken = AuthorizationLive(Redacted.make('token'))
    expect(buildFailure(withToken)).toBe('')
  })
})

it.layer(ApiTestLayer())('the bearer token on a protected endpoint', (suite) => {
  suite.effect.each(REFUSED)('refuses %s with the 401 problem', ([, headers]) =>
    Effect.gen(function* refuses() {
      const base = yield* baseUrl
      const response = yield* fetched(`${base}${EVENTS_SCHEMA}`, { headers })
      assert.strictEqual(response.status, 401)
      assert.include(response.headers.get('content-type'), 'application/problem+json')
      assert.deepStrictEqual(yield* bodyOf(response), {
        type: 'https://bytebureau.dev/problems/unauthorized',
        title: 'Unauthorized',
        status: 401,
        detail: 'a valid API token is required',
        code: 'unauthorized',
      })
    }),
  )

  // POST /api/v1/projects arrives with Task 4, which un-skips this test
  suite.effect.skip('refuses a body over 10 MB with 413 before any handler runs', () =>
    Effect.gen(function* refusesBig() {
      const base = yield* baseUrl
      const oversized = json({ path: 'x'.repeat(11 * 1024 * 1024) })
      const response = yield* fetched(`${base}/api/v1/projects`, oversized)
      assert.strictEqual(response.status, 413)
    }),
  )

  suite.effect('opens the endpoints: the schemas are the ones the protocol publishes', () =>
    Effect.gen(function* serves() {
      const base = yield* baseUrl
      const events = yield* fetched(`${base}${EVENTS_SCHEMA}`, authorized())
      assert.strictEqual(events.status, 200)
      assert.deepStrictEqual(yield* bodyOf(events), eventsJsonSchema())
      const config = yield* fetched(`${base}/api/v1/schemas/config.json`, authorized())
      assert.deepStrictEqual(yield* bodyOf(config), configJsonSchema())
    }),
  )
})
```

`packages/api/src/openapi.test.ts`:
```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { openApiDocument } from './openapi.js'

const committed = fileURLToPath(new URL('../openapi.json', import.meta.url))

describe('the OpenAPI document', () => {
  it('is OpenAPI 3.1 with the title and the bearer scheme, and openapi.json is up to date', () => {
    const document = openApiDocument()
    expect(document.openapi).toBe('3.1.0')
    expect(document.info).toMatchObject({ title: 'ByteBureau API', version: 'v1' })
    expect(document.components.securitySchemes).toHaveProperty('bearer')
    expect(document.components.schemas).toHaveProperty('Problem401')
    // The text the build writes, so a stale or reformatted openapi.json fails as well
    expect(readFileSync(committed, 'utf8')).toBe(`${JSON.stringify(document, undefined, 2)}\n`)
  })

  it('lists the health check and the schemas under /api/v1', () => {
    const { paths } = openApiDocument()
    expect(paths).toHaveProperty(['/api/v1/health', 'get'])
    expect(paths).toHaveProperty(['/api/v1/schemas/config.json', 'get'])
    expect(paths).toHaveProperty(['/api/v1/schemas/events.json', 'get'])
  })
})
```
The `413` comes from `MaxBodySize` on the Node server (the request is refused while the body is read, so no handler runs); if the status surfaces as a different `4xx` on Node, assert on what `HttpServerError` renders and keep the Bun limit of Task 8 as the one that holds in the binary. The `/api/v1/projects` route exists from Task 4 on; until then the test may target `/api/v1/schemas/events.json` with a POST — a `405`/`404` would hide the point, so write this test in Task 3 and expect it to pass once Task 4 lands (mark it `it.effect.skip` until then, with a comment naming Task 4). If `securitySchemes` keys the scheme differently (for example by the middleware id), assert on the key the document shows after reading it once — the point is that a bearer scheme is declared.

- [ ] **Step 8: Generate the document, run everything**

Run: `bun run --cwd packages/api build && bunx vitest run --project api && bun run typecheck && bun run lint && bun run format:check && bun run knip && bun run depcruise && bun run spell`
Expected: PASS. Common corrections: the `Layer` requirement aliases (see Step 6), the `Layer.succeed(Authorization, …)` call needing `Authorization.of(...)` (use it if the compiler asks), oxfmt reformatting `openapi.json` (add it to `.oxfmtrc.json` `ignorePatterns` like `packages/protocol/schemas`), cspell words (`openapi`, `problem+json` parts). knip must not report the `./testing` export unused: it is used by Task 4's tests; until then, keep `testing.ts` listed as an `entry` of the `packages/api` workspace in `knip.ts` (`entry: ['scripts/*.ts', 'src/testing.ts']`).

- [ ] **Step 9: Commit**

```bash
git add packages/api vitest.config.ts knip.ts turbo.json .oxlintrc.jsonc .oxfmtrc.json cspell-words.txt bun.lock
git commit -m "feat(api): scaffold the API package with problems, bearer auth, validation, rate limit, health and schemas"
```

### Task 4: `packages/api` — the resource groups: projects, sessions, asks, usage, workspaces, plugins

**Files:**
- Create: `packages/api/src/groups/projects.ts`, `packages/api/src/groups/sessions.ts`, `packages/api/src/groups/asks.ts`, `packages/api/src/groups/usage.ts`, `packages/api/src/groups/workspaces.ts`, `packages/api/src/groups/plugins.ts`, `packages/api/src/handlers/found.ts`, `packages/api/src/handlers/projects.ts`, `packages/api/src/handlers/sessions.ts`, `packages/api/src/handlers/asks.ts`, `packages/api/src/handlers/usage.ts`, `packages/api/src/handlers/workspaces.ts`, `packages/api/src/handlers/plugins.ts`, `packages/api/src/testing-sessions.ts`, `packages/api/src/projects.test.ts`, `packages/api/src/sessions.test.ts`, `packages/api/src/asks.test.ts`, `packages/api/src/workspaces-plugins.test.ts`, `packages/api/src/rate-limit.test.ts`
- Modify: `packages/api/src/api.ts` (the groups join the `.add(...)` call), `packages/api/src/layer.ts` (the handler layers join `Handlers`), `packages/api/openapi.json` (regenerated), `packages/kernel/src/asks/ask-service.ts` (+ `ask-service` shape: `get(askId)`), `packages/kernel/src/index.ts` if `AskRecord` helpers need exporting

**Interfaces:**
- Consumes: kernel services `ProjectRegistry`, `SessionManager`, `AskService`, `UsageService`, `WorkspaceManager`, `PluginHost` and their shapes (Phase A, with `recover` from Task 2); `orProblem`, `problem`, `PROBLEM_SCHEMAS`, `KernelStatus`, `Authorization`, `RequestValidation`, `MutationLimit`, `BureauApi`, `ApiTestLayer(overrides?)`, `baseUrl`, `authorized`, `json` (Task 3; `json` is the authorised POST helper — if Task 3 named it differently, use its name); the DTO and request schemas of Task 1; `tempDir`, `createTempRepo`, `writeConfig` (`@bytebureau/kernel/testing`).
- Produces: the endpoints listed below (the OpenAPI document and the client of Task 7 are generated from them), `found()`, `AskServiceShape.get(askId): Effect<AskRecord | undefined, StoreError>`, and for tests `fakeProjectConfig`, `createdSession()`, `firstEvent()`.

Endpoints (every one under `/api/v1`, bearer token required, bodies and queries validated; `M` marks a mutation, rate limited):
| Group | Endpoint | Success | Notes |
|---|---|---|---|
| projects | `GET /projects` | `ProjectDto[]` | |
| projects | `POST /projects` M | `201 ProjectDto` | body `RegisterProjectBody`; a path that is not a repository → `422 workspace_not_a_repository`; a ByteBureau worktree → `422 workspace_is_bytebureau_worktree` |
| projects | `GET /projects/:id` | `ProjectDto` | `404 not_found` |
| projects | `DELETE /projects/:id` M | `204` | `404 not_found`, `409 workspace_has_sessions` |
| sessions | `GET /sessions` | `SessionDto[]` | |
| sessions | `POST /sessions` M | `201 SessionDto` | body `CreateSessionBody`; the session is provisioned (`ready`) when the response comes; refusals as the kernel says them (`422 session_provider_missing`, `422 session_employee_missing`, `403 session_yolo_refused`, `422 workspace_*`, `422 config_invalid`) |
| sessions | `GET /sessions/:id` | `SessionDto` | `404 session_not_found` |
| sessions | `POST /sessions/:id/prompt` M | `TurnDto` | body `PromptBody`; `409 session_invalid_transition` when the session is not `ready` |
| sessions | `POST /sessions/:id/interrupt` M | `204` | |
| sessions | `POST /sessions/:id/stop` M | `204` | |
| sessions | `POST /sessions/:id/resume` M | `SessionDto` | |
| sessions | `POST /sessions/:id/complete` M | `204` | |
| asks | `GET /asks?session=<id>` | `AskRecord[]` | the pending asks, of one session when `session` is given |
| asks | `GET /asks/:id` | `AskRecord` | pending or settled; `404 ask_not_found` |
| asks | `POST /asks/:id/answer` M | `204` | body `AnswerAskBody`; recorded with `answered_via: 'api'`; `409 ask_not_pending`, `422 ask_invalid_answer` |
| usage | `GET /usage/sessions/:id` | `SessionUsageDto` | |
| workspaces | `GET /workspaces?project=<id>` | `WorkspaceInfoDto[]` | |
| workspaces | `POST /workspaces/prune` M | `PruneReportDto` | body `{ projectId? }` |
| plugins | `GET /plugins` | `PluginStatusDto[]` | |
| plugins | `GET /providers` | `ProviderDto[]` | the agent providers the loaded plugins offer |

Profile endpoints (`profiles` group) and per-profile usage snapshots arrive with the profiles of Phase C; the spec's `usage` group ships its session part here.

Semantics: handlers call the kernel's Effect services directly (no Promise facade in the daemon) and turn every typed failure into a problem with `orProblem` (typed `ApiProblem<KernelStatus>` since Task 3's fix round, so every endpoint that calls the kernel — the list endpoints included — declares `error: PROBLEM_SCHEMAS`; the handler layers join `Handlers` in `handlers/all.ts`; `ApiTestLayer(overrides?)` takes no home and loads the plugins itself); `found(entity, code, detail)` turns an `undefined` lookup into a `404`. `POST /sessions` is synchronous up to `ready`, like `SessionManager.create` (the worktree is provisioned before the response), so a client can prompt right after; `POST /sessions/:id/prompt` returns as soon as the turn is recorded, and the turn's progress arrives on the event stream (Task 5). The kernel records answer the DTO schemas field for field; the handlers return them as they are, and `Schema.encodeSync(SessionDto)` in `testing-sessions.ts` pins the mirror at compile time. Every mutation carries `MutationLimit`.

Semantics (as shipped, commits 5cca25c, e4f9770, e2f03c9): the 201 success schemas are `Schema.suspend(() => Dto).pipe(HttpApiSchema.status(201))` (the plain form made the OpenAPI document emit `Project_1`/`Session_1` duplicates; `openapi.test.ts` guards against numbered components); `PruneBody` is private to `groups/workspaces.ts` with an identifier and `POST /workspaces/prune` requires a JSON body (`{}` at least); `interrupt` on a session with no agent attached answers `404 session_not_found` (the kernel's semantics — a follow-up may map it to 409 or a no-op 204); `GET /usage/sessions/:id` answers zeros for an unknown session (final wave: a `found` precheck); a relative `POST /projects` path resolves in the daemon's working directory, so the CLI sends absolute paths (Task 9); the body limit lives in `body-limit.ts` (a content-length precheck answering the `413 payload_too_large` problem, registered after CORS; `MaxBodySize` reads the same constant as the backstop); the tests use the `get`/`post(path, body?)`/`remove` helpers of `testing.ts` and `UNKNOWN_ID`, `registeredWith`, `recommendedOption`, `askedSession` of `testing-sessions.ts`; the 401-on-every-protected-operation and 429-on-exactly-the-mutations tests are derived from the OpenAPI document; `firstEvent` has no timeout of its own because the suite runs on the TestClock (a missing event shows as a Vitest timeout). Known minors (final wave): the 429 test depends on wall time (three registrations within one second — use `perMinute: 1` or feed the bucket from the Effect `Clock`); no 413 in the OpenAPI document; no chunked-body test for the precheck; the interrupt test does not assert `ready` afterwards; `config_invalid` details repeat the file pointer (Task 3's mapper prefixes what the reason holds).

- [ ] **Step 0: The 10 MB body limit answers a problem**

Add a global middleware (`packages/api/src/body-limit.ts`, registered next to CORS in `layer.ts`) that reads the request's `content-length` header and, when it is a number above `MAX_BODY_BYTES` (10 MB, the value `layer.ts` already uses for `MaxBodySize`), answers at once with the `413` problem `payload_too_large` (`application/problem+json`, built with `problem(413, 'payload_too_large', 'the request body exceeds 10 MB')` and `HttpServerResponse.jsonUnsafe(problem, { status: 413, contentType: 'application/problem+json' })` or the equivalent) without reading the body. `MaxBodySize` stays as the backstop for bodies that arrive without a length (Node drops such a connection, Bun answers an empty `413`). Un-skip the 413 test of `auth.test.ts` (Task 3 left it `it.effect.skip`) and let it assert `413` and `{ code: 'payload_too_large' }` on a POST to `/api/v1/projects` with an 11 MB body.

- [ ] **Step 1: `AskService.get` in the kernel**

`packages/kernel/src/asks/ask-service.ts`: add `readonly get: (askId: string) => Effect.Effect<AskRecord | undefined, StoreError>` to `AskServiceShape` and implement it with the existing `loadAsk` of `ask-records.ts` (it reads one row; if it fails with `AskError not_found` for a missing row, map that case to `undefined` — the API wants `undefined`, not a failure, for a lookup). Add one test to `ask-service.test.ts` (or a sibling if it is at the line cap): an opened ask is found, a random id is `undefined`.

- [ ] **Step 2: Group definitions**

`packages/api/src/groups/projects.ts`:
```ts
import { Id, ProjectDto, RegisterProjectBody } from '@bytebureau/protocol'
import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api'
import { Authorization } from '../auth.js'
import { PROBLEM_SCHEMAS } from '../problems.js'
import { MutationLimit } from '../rate-limit.js'
import { RequestValidation } from '../validation.js'

// The status is an annotation, and an annotated schema is a copy of its own; a suspended one keeps naming the one component of the OpenAPI document
const Created = Schema.suspend(() => ProjectDto).pipe(HttpApiSchema.status(201))

export const ProjectsGroup = HttpApiGroup.make('projects')
  .add(
    HttpApiEndpoint.get('list', '/projects', {
      success: Schema.Array(ProjectDto),
      error: PROBLEM_SCHEMAS,
    }),
    HttpApiEndpoint.post('register', '/projects', {
      payload: RegisterProjectBody,
      success: Created,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
    HttpApiEndpoint.get('get', '/projects/:id', {
      params: { id: Id },
      success: ProjectDto,
      error: PROBLEM_SCHEMAS,
    }),
    HttpApiEndpoint.delete('remove', '/projects/:id', {
      params: { id: Id },
      success: HttpApiSchema.NoContent,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
  )
  .middleware(Authorization)
  .middleware(RequestValidation)
```

`packages/api/src/groups/sessions.ts`:
```ts
import { CreateSessionBody, Id, PromptBody, SessionDto, TurnDto } from '@bytebureau/protocol'
import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api'
import { Authorization } from '../auth.js'
import { PROBLEM_SCHEMAS } from '../problems.js'
import { MutationLimit } from '../rate-limit.js'
import { RequestValidation } from '../validation.js'

const byId = { id: Id }

// The status is an annotation, and an annotated schema is a copy of its own; a suspended one keeps naming the one component of the OpenAPI document
const Created = Schema.suspend(() => SessionDto).pipe(HttpApiSchema.status(201))

export const SessionsGroup = HttpApiGroup.make('sessions')
  .add(
    HttpApiEndpoint.get('list', '/sessions', {
      success: Schema.Array(SessionDto),
      error: PROBLEM_SCHEMAS,
    }),
    HttpApiEndpoint.post('create', '/sessions', {
      payload: CreateSessionBody,
      success: Created,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
    HttpApiEndpoint.get('get', '/sessions/:id', {
      params: byId,
      success: SessionDto,
      error: PROBLEM_SCHEMAS,
    }),
    HttpApiEndpoint.post('prompt', '/sessions/:id/prompt', {
      params: byId,
      payload: PromptBody,
      success: TurnDto,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
    HttpApiEndpoint.post('interrupt', '/sessions/:id/interrupt', {
      params: byId,
      success: HttpApiSchema.NoContent,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
    HttpApiEndpoint.post('stop', '/sessions/:id/stop', {
      params: byId,
      success: HttpApiSchema.NoContent,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
    HttpApiEndpoint.post('resume', '/sessions/:id/resume', {
      params: byId,
      success: SessionDto,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
    HttpApiEndpoint.post('complete', '/sessions/:id/complete', {
      params: byId,
      success: HttpApiSchema.NoContent,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
  )
  .middleware(Authorization)
  .middleware(RequestValidation)
```
If the generic `command` helper upsets the endpoint's literal types, write the three endpoints out in full the way `prompt` is; the helper is a convenience, not a requirement.

`packages/api/src/groups/asks.ts`:
```ts
import { AnswerAskBody, AskRecord, Id } from '@bytebureau/protocol'
import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api'
import { Authorization } from '../auth.js'
import { PROBLEM_SCHEMAS } from '../problems.js'
import { MutationLimit } from '../rate-limit.js'
import { RequestValidation } from '../validation.js'

export const AsksGroup = HttpApiGroup.make('asks')
  .add(
    HttpApiEndpoint.get('pending', '/asks', {
      query: { session: Schema.optionalKey(Id) },
      success: Schema.Array(AskRecord),
      error: PROBLEM_SCHEMAS,
    }),
    HttpApiEndpoint.get('get', '/asks/:id', {
      params: { id: Id },
      success: AskRecord,
      error: PROBLEM_SCHEMAS,
    }),
    HttpApiEndpoint.post('answer', '/asks/:id/answer', {
      params: { id: Id },
      payload: AnswerAskBody,
      success: HttpApiSchema.NoContent,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
  )
  .middleware(Authorization)
  .middleware(RequestValidation)
```

`packages/api/src/groups/usage.ts`:
```ts
import { Id, SessionUsageDto } from '@bytebureau/protocol'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { Authorization } from '../auth.js'
import { PROBLEM_SCHEMAS } from '../problems.js'
import { RequestValidation } from '../validation.js'

export const UsageGroup = HttpApiGroup.make('usage')
  .add(
    HttpApiEndpoint.get('session', '/usage/sessions/:id', {
      params: { id: Id },
      success: SessionUsageDto,
      error: PROBLEM_SCHEMAS,
    }),
  )
  .middleware(Authorization)
  .middleware(RequestValidation)
```

`packages/api/src/groups/workspaces.ts`:
```ts
import { Id, PruneReportDto, WorkspaceInfoDto } from '@bytebureau/protocol'
import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { Authorization } from '../auth.js'
import { PROBLEM_SCHEMAS } from '../problems.js'
import { MutationLimit } from '../rate-limit.js'
import { RequestValidation } from '../validation.js'

const PruneBody = Schema.Struct({ projectId: Schema.optionalKey(Id) }).annotate({
  title: 'PruneWorkspaces',
  identifier: 'PruneWorkspaces',
})

export const WorkspacesGroup = HttpApiGroup.make('workspaces')
  .add(
    HttpApiEndpoint.get('list', '/workspaces', {
      query: { project: Schema.optionalKey(Id) },
      success: Schema.Array(WorkspaceInfoDto),
      error: PROBLEM_SCHEMAS,
    }),
    HttpApiEndpoint.post('prune', '/workspaces/prune', {
      payload: PruneBody,
      success: PruneReportDto,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
  )
  .middleware(Authorization)
  .middleware(RequestValidation)
```

`packages/api/src/groups/plugins.ts`:
```ts
import { PluginStatusDto, ProviderDto } from '@bytebureau/protocol'
import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { Authorization } from '../auth.js'
import { RequestValidation } from '../validation.js'

export const PluginsGroup = HttpApiGroup.make('plugins')
  .add(
    HttpApiEndpoint.get('list', '/plugins', { success: Schema.Array(PluginStatusDto) }),
    HttpApiEndpoint.get('providers', '/providers', { success: Schema.Array(ProviderDto) }),
  )
  .middleware(Authorization)
  .middleware(RequestValidation)
```

`packages/api/src/api.ts`: the `.add(...)` call becomes `.add(HealthGroup, SchemasGroup, ProjectsGroup, SessionsGroup, AsksGroup, UsageGroup, WorkspacesGroup, PluginsGroup)` with the imports.

- [ ] **Step 3: Handlers**

`packages/api/src/handlers/found.ts`:
```ts
import { Effect } from 'effect'
import { problem, type ApiProblem } from '../problems.js'

// A lookup that found nothing is a 404 problem with the code of the resource
export const found = <Entity>(
  entity: Entity | undefined,
  code: string,
  detail: string,
): Effect.Effect<Entity, ApiProblem<404>> =>
  entity === undefined ? Effect.fail(problem(404, code, detail)) : Effect.succeed(entity)
```

`packages/api/src/handlers/projects.ts`:
```ts
import { ProjectRegistry, type Project } from '@bytebureau/kernel'
import { Effect } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { BureauApi } from '../api.js'
import { orProblem, type ApiProblem, type KernelStatus } from '../problems.js'
import { found } from './found.js'

// The project, or the 404 problem when nobody holds the id
const projectOf = (id: string): Effect.Effect<Project, ApiProblem<KernelStatus>, ProjectRegistry> =>
  orProblem(ProjectRegistry.use((registry) => registry.get(id))).pipe(
    Effect.flatMap((project) => found(project, 'not_found', `no project ${id}`)),
  )

export const ProjectsHandlers = HttpApiBuilder.group(BureauApi, 'projects', (handlers) =>
  handlers
    .handle('list', () => orProblem(ProjectRegistry.use((registry) => registry.list())))
    .handle('register', ({ payload }) =>
      orProblem(ProjectRegistry.use((registry) => registry.register(payload.path))),
    )
    .handle('get', ({ params }) => projectOf(params.id))
    .handle('remove', ({ params }) =>
      projectOf(params.id).pipe(
        Effect.flatMap(() =>
          orProblem(ProjectRegistry.use((registry) => registry.remove(params.id))),
        ),
      ),
    ),
)
```
`list` succeeds with `readonly Project[]`, which the `Schema.Array(ProjectDto)` success type accepts; if the compiler wants a mutable array, map with `[...projects]`.

`packages/api/src/handlers/sessions.ts`:
```ts
import { SessionManager, type SessionManagerShape } from '@bytebureau/kernel'
import { Effect } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { BureauApi } from '../api.js'
import { orProblem, type ApiProblem, type KernelStatus } from '../problems.js'
import { found } from './found.js'

const sessions = <Value, Failure>(
  call: (manager: SessionManagerShape) => Effect.Effect<Value, Failure>,
): Effect.Effect<Value, ApiProblem<KernelStatus>, SessionManager> =>
  orProblem(SessionManager.use(call))

export const SessionsHandlers = HttpApiBuilder.group(BureauApi, 'sessions', (handlers) =>
  handlers
    .handle('list', () => sessions((manager) => manager.list()))
    .handle('create', ({ payload }) => sessions((manager) => manager.create(payload)))
    .handle('get', ({ params }) =>
      sessions((manager) => manager.get(params.id)).pipe(
        Effect.flatMap((session) => found(session, 'session_not_found', `no session ${params.id}`)),
      ),
    )
    .handle('prompt', ({ params, payload }) =>
      sessions((manager) => manager.prompt(params.id, payload)),
    )
    .handle('interrupt', ({ params }) => sessions((manager) => manager.interrupt(params.id)))
    .handle('stop', ({ params }) => sessions((manager) => manager.stop(params.id)))
    .handle('resume', ({ params }) => sessions((manager) => manager.resume(params.id)))
    .handle('complete', ({ params }) => sessions((manager) => manager.complete(params.id))),
)
```
`SessionManager['Service']` is the shape type of a `Context.Service` class in Effect 4 (Phase A writes `Supervisor['Service']` in `plugin-context.ts`).

`packages/api/src/handlers/asks.ts`:
```ts
import { AskService } from '@bytebureau/kernel'
import { Effect } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { BureauApi } from '../api.js'
import { orProblem } from '../problems.js'
import { found } from './found.js'

export const AsksHandlers = HttpApiBuilder.group(BureauApi, 'asks', (handlers) =>
  handlers
    .handle('pending', ({ query }) =>
      orProblem(AskService.use((asks) => asks.pending(query.session))),
    )
    .handle('get', ({ params }) =>
      orProblem(AskService.use((asks) => asks.get(params.id))).pipe(
        Effect.flatMap((ask) => found(ask, 'ask_not_found', `no ask ${params.id}`)),
      ),
    )
    .handle('answer', ({ params, payload }) =>
      orProblem(AskService.use((asks) => asks.answer(params.id, payload, 'api'))).pipe(
        Effect.asVoid,
      ),
    ),
)
```

`packages/api/src/handlers/usage.ts`:
```ts
import { UsageService } from '@bytebureau/kernel'
import { HttpApiBuilder } from 'effect/http-api'
import { BureauApi } from '../api.js'
import { orProblem } from '../problems.js'

export const UsageHandlers = HttpApiBuilder.group(BureauApi, 'usage', (handlers) =>
  handlers.handle('session', ({ params }) =>
    orProblem(UsageService.use((usage) => usage.sessionUsage(params.id))),
  ),
)
```

`packages/api/src/handlers/workspaces.ts`:
```ts
import { WorkspaceManager } from '@bytebureau/kernel'
import { HttpApiBuilder } from 'effect/http-api'
import { BureauApi } from '../api.js'
import { orProblem } from '../problems.js'

export const WorkspacesHandlers = HttpApiBuilder.group(BureauApi, 'workspaces', (handlers) =>
  handlers
    .handle('list', ({ query }) =>
      orProblem(WorkspaceManager.use((workspaces) => workspaces.list(query.project))),
    )
    .handle('prune', ({ payload }) =>
      orProblem(WorkspaceManager.use((workspaces) => workspaces.prune(payload.projectId))),
    ),
)
```

`packages/api/src/handlers/plugins.ts`:
```ts
import { PluginHost } from '@bytebureau/kernel'
import { HttpApiBuilder } from 'effect/http-api'
import { BureauApi } from '../api.js'

export const PluginsHandlers = HttpApiBuilder.group(BureauApi, 'plugins', (handlers) =>
  handlers
    .handle('list', () => PluginHost.useSync((host) => host.plugins()))
    .handle('providers', () =>
      PluginHost.useSync((host) =>
        host
          .agentProviders()
          .map((provider) => ({ id: provider.id, displayName: provider.displayName })),
      ),
    ),
)
```
`PluginHost.asEffect()` is the Effect 4 accessor of a service class (Phase A code reads a service with `yield* PluginHost`; `Effect.map(PluginHost, …)` works as well — use whichever the kernel uses).

`packages/api/src/layer.ts`: `const Handlers = Layer.mergeAll(HealthHandlers, SchemasHandlers, ProjectsHandlers, SessionsHandlers, AsksHandlers, UsageHandlers, WorkspacesHandlers, PluginsHandlers)`. If `layer.ts` exceeds the import cap (`import/max-dependencies` 10), move `Handlers` to `handlers/index.ts` (`oxc/no-barrel-file` is off only for `packages/*/src/index.ts`, so name it `handlers/all.ts` and export one constant).

- [ ] **Step 4: Test helpers and the failing tests**

`packages/api/src/testing-sessions.ts`:
```ts
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
```
`Schema` comes from `effect` (the protocol barrel does not re-export it; the api package may import `effect`). `Stream.runCollect` returns an array in Effect 4 (`dist/Stream.d.ts` line 14891).

`packages/api/src/projects.test.ts`:
```ts
import { createTempRepo, tempDir, writeConfig } from '@bytebureau/kernel/testing'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ApiTestLayer, get, post, remove } from './testing.js'
import { createdSession, fakeProjectConfig, registeredProject } from './testing-sessions.js'

it.layer(ApiTestLayer())('POST /api/v1/projects over the test kernel', (suite) => {
  suite.effect('registers a repository with 201 and tells it as the kernel keeps it', () =>
    Effect.gen(function* registers() {
      const { repo, project, status } = yield* registeredProject
      assert.strictEqual(status, 201)
      const { name } = fakeProjectConfig.project
      assert.containSubset(project, { path: repo, name, defaultBranch: 'main' })
      assert.containSubset(project.config, {
        defaults: { employee: 'developer' },
        employees: { developer: { provider: 'fake', model: 'any' } },
      })
    }),
  )
})

it.layer(ApiTestLayer())('the refusals of POST /api/v1/projects over the test kernel', (suite) => {
  suite.effect('refuses a directory that is no repository with 422 and the kernel reason', () =>
    Effect.gen(function* refusesDirectory() {
      const plain = tempDir('bb-plain-')
      const refused = yield* post('/projects', { path: plain })
      assert.strictEqual(refused.status, 422)
      assert.include(refused.type, 'application/problem+json')
      assert.containSubset(refused.body, {
        code: 'workspace_not_a_repository',
        detail: `${plain} is not inside a git repository`,
      })
    }),
  )

  suite.effect('refuses a ByteBureau worktree with 422 workspace_is_bytebureau_worktree', () =>
    Effect.gen(function* refusesWorktree() {
      const { session } = yield* createdSession
      const workspace = yield* Effect.fromNullishOr(session.workspace)
      const refused = yield* post('/projects', { path: workspace.path })
      assert.strictEqual(refused.status, 422)
      assert.containSubset(refused.body, { code: 'workspace_is_bytebureau_worktree' })
    }),
  )

  suite.effect('refuses a project file the schema does not know with 422 config_invalid', () =>
    Effect.gen(function* refusesFile() {
      const repo = createTempRepo()
      writeConfig(repo, { version: 99 })
      const refused = yield* post('/projects', { path: repo })
      assert.strictEqual(refused.status, 422)
      assert.containSubset(refused.body, { code: 'config_invalid' })
      assert.include(JSON.stringify(refused.body), `${repo}/bytebureau.json/version`)
    }),
  )

  suite.effect('refuses a body the schema does not know with 400 request_invalid', () =>
    Effect.gen(function* refusesBody() {
      const refused = yield* post('/projects', { directory: '/x' })
      assert.strictEqual(refused.status, 400)
      assert.include(refused.type, 'application/problem+json')
      assert.containSubset(refused.body, {
        code: 'request_invalid',
        detail: 'Payload: Missing key\n  at ["path"]',
      })
    }),
  )
})

it.layer(ApiTestLayer())('GET and DELETE /api/v1/projects/:id over the test kernel', (suite) => {
  suite.effect('lists a registered project and reads it by its id', () =>
    Effect.gen(function* reads() {
      const { project } = yield* registeredProject
      const listed = yield* get('/projects')
      assert.strictEqual(listed.status, 200)
      assert.containSubset(listed.body, [{ id: project.id }])
      const read = yield* get(`/projects/${project.id}`)
      assert.strictEqual(read.status, 200)
      assert.deepStrictEqual(read.body, project)
    }),
  )

  suite.effect('removes a project with 204 and answers 404 not_found for it afterwards', () =>
    Effect.gen(function* removes() {
      const { project } = yield* registeredProject
      assert.strictEqual((yield* remove(`/projects/${project.id}`)).status, 204)
      const gone = yield* get(`/projects/${project.id}`)
      assert.strictEqual(gone.status, 404)
      assert.include(gone.type, 'application/problem+json')
      assert.containSubset(gone.body, { code: 'not_found', status: 404 })
      assert.strictEqual((yield* remove(`/projects/${project.id}`)).status, 404)
    }),
  )

  suite.effect('does not remove a project that has sessions: 409 workspace_has_sessions', () =>
    Effect.gen(function* keeps() {
      const { project } = yield* createdSession
      const refused = yield* remove(`/projects/${project.id}`)
      assert.strictEqual(refused.status, 409)
      assert.containSubset(refused.body, { code: 'workspace_has_sessions' })
      assert.strictEqual((yield* get(`/projects/${project.id}`)).status, 200)
    }),
  )
})
```
The exact `detail` of the not-a-repository refusal is the kernel's `WorkspaceError.reason` from Phase A (the CLI test `projects.test.ts` asserts `${plain} is not inside a git repository`); keep the two in step.

`packages/api/src/sessions.test.ts`:
```ts
import { EventLog, SessionManager } from '@bytebureau/kernel'
import { SessionDto, TurnDto } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { ApiTestLayer, get, post } from './testing.js'
import {
  askedSession,
  createdSession,
  firstEvent,
  recommendedOption,
  registeredProject,
  UNKNOWN_ID,
} from './testing-sessions.js'

it.layer(ApiTestLayer())('POST and GET /api/v1/sessions over the fake provider', (suite) => {
  suite.effect('creates a ready session with its worktree, as the kernel keeps it', () =>
    Effect.gen(function* creates() {
      const { session, status } = yield* createdSession
      assert.strictEqual(status, 201)
      assert.strictEqual(session.status, 'ready')
      assert.containSubset(session.workspace, { runtimeId: 'local', branch: 'bb/create-hello' })
      const record = yield* SessionManager.use((manager) => manager.get(session.id))
      const kept = Schema.encodeSync(SessionDto)(yield* Effect.fromNullishOr(record))
      assert.deepStrictEqual(kept, session)
      const events = yield* EventLog.use((log) => log.read({ sessionId: session.id }, { from: 0 }))
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ['session.created', 'session.provisioning', 'workspace.provisioned', 'session.ready'],
      )
    }),
  )

  suite.effect('lists the sessions and reads one by its id, 404 for an unknown one', () =>
    Effect.gen(function* reads() {
      const { session } = yield* createdSession
      assert.containSubset((yield* get('/sessions')).body, [{ id: session.id }])
      const read = yield* get(`/sessions/${session.id}`)
      assert.deepStrictEqual(read.body, session)
      const missing = yield* get(`/sessions/${UNKNOWN_ID}`)
      assert.strictEqual(missing.status, 404)
      assert.include(missing.type, 'application/problem+json')
      assert.containSubset(missing.body, { code: 'session_not_found' })
    }),
  )
})

it.layer(ApiTestLayer())('POST /api/v1/sessions/:id/prompt over the fake provider', (suite) => {
  suite.effect('prompts a ready session and answers with the turn it began', () =>
    Effect.gen(function* prompts() {
      const { session } = yield* createdSession
      const text = 'Create src/hello.ts exporting hello()'
      const prompted = yield* post(`/sessions/${session.id}/prompt`, { text })
      assert.strictEqual(prompted.status, 200)
      const turn = Schema.decodeUnknownSync(TurnDto)(prompted.body)
      const expected = { sessionId: session.id, index: 0, status: 'running', prompt: { text } }
      assert.containSubset(turn, expected)
    }),
  )

  suite.effect('takes the answer of its question, completes it and reads its usage', () =>
    Effect.gen(function* runsOne() {
      const { session, ask } = yield* askedSession
      const option = yield* recommendedOption(ask)
      const answered = yield* post(`/asks/${ask.id}/answer`, { selected: [option.id] })
      assert.strictEqual(answered.status, 204)
      yield* firstEvent(session.id, 'turn.completed')
      assert.strictEqual((yield* post(`/sessions/${session.id}/complete`)).status, 204)
      assert.containSubset((yield* get(`/sessions/${session.id}`)).body, { status: 'completed' })
      const usage = { turns: 1, inputTokens: 120, outputTokens: 40, costUsd: 0.002, contextPct: 3 }
      assert.deepStrictEqual((yield* get(`/usage/sessions/${session.id}`)).body, usage)
    }),
  )
})

it.layer(ApiTestLayer())('the commands on a session over the fake provider', (suite) => {
  suite.effect('refuses a prompt on a stopped session with 409, an unknown one with 404', () =>
    Effect.gen(function* refuses() {
      const { session } = yield* createdSession
      assert.strictEqual((yield* post(`/sessions/${session.id}/stop`)).status, 204)
      const prompted = yield* post(`/sessions/${session.id}/prompt`, { text: 'x' })
      assert.strictEqual(prompted.status, 409)
      assert.containSubset(prompted.body, { code: 'session_invalid_transition' })
      const missing = yield* post(`/sessions/${UNKNOWN_ID}/stop`)
      assert.strictEqual(missing.status, 404)
      assert.containSubset(missing.body, { code: 'session_not_found' })
    }),
  )

  suite.effect('stops a session, resumes it and refuses to resume one that is ready', () =>
    Effect.gen(function* stopsAndResumes() {
      const { session } = yield* createdSession
      yield* post(`/sessions/${session.id}/stop`)
      assert.containSubset((yield* get(`/sessions/${session.id}`)).body, { status: 'stopped' })
      const resumed = yield* post(`/sessions/${session.id}/resume`)
      assert.strictEqual(resumed.status, 200)
      assert.containSubset(resumed.body, { id: session.id, status: 'ready' })
      const again = yield* post(`/sessions/${session.id}/resume`)
      assert.strictEqual(again.status, 409)
      assert.containSubset(again.body, { code: 'session_invalid_transition' })
    }),
  )

  suite.effect('interrupts a turn that is running, and the session is ready again', () =>
    Effect.gen(function* interrupts() {
      const { project } = yield* registeredProject
      const env = { BYTEBUREAU_FAKE_SCRIPT: 'slow' }
      const created = yield* post('/sessions', { projectId: project.id, title: 'Slow', env })
      const { id } = Schema.decodeUnknownSync(SessionDto)(created.body)
      yield* post(`/sessions/${id}/prompt`, { text: 'go' })
      yield* firstEvent(id, 'turn.started')
      assert.strictEqual((yield* post(`/sessions/${id}/interrupt`)).status, 204)
      yield* firstEvent(id, 'turn.interrupted')
      assert.strictEqual((yield* post(`/sessions/${id}/complete`)).status, 204)
    }),
  )
})

it.layer(ApiTestLayer())('GET /api/v1/usage/sessions/:id over the fake provider', (suite) => {
  suite.effect('reads no usage of a session that has had no turn, the costs as null', () =>
    Effect.gen(function* readsNothing() {
      const { session } = yield* createdSession
      const usage = yield* get(`/usage/sessions/${session.id}`)
      assert.strictEqual(usage.status, 200)
      const none = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: null, contextPct: null }
      assert.deepStrictEqual(usage.body, none)
    }),
  )
})
```
The option id the fake provider's question offers is the one `packages/kernel/src/testing/fake-ask.ts` exports (`exportQuestion`): read it and use its recommended option id in place of `'yes'`; the answered ask then lets the hello script write `src/hello.ts` and complete the turn.

`packages/api/src/asks.test.ts`:
```ts
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ApiTestLayer, get, post } from './testing.js'
import { askedSession, recommendedOption, UNKNOWN_ID } from './testing-sessions.js'

it.layer(ApiTestLayer())('GET /api/v1/asks over the fake provider', (suite) => {
  suite.effect(
    'lists the pending ask of a session, and the asks of every session without a filter',
    () =>
      Effect.gen(function* lists() {
        const first = yield* askedSession
        const second = yield* askedSession
        const own = yield* get(`/asks?session=${first.session.id}`)
        assert.strictEqual(own.status, 200)
        assert.deepStrictEqual(own.body, [first.ask])
        const all = yield* get('/asks')
        assert.containSubset(all.body, [{ id: first.ask.id }, { id: second.ask.id }])
      }),
  )

  suite.effect('answers 404 ask_not_found for an unknown ask, read or answered', () =>
    Effect.gen(function* missing() {
      const read = yield* get(`/asks/${UNKNOWN_ID}`)
      assert.strictEqual(read.status, 404)
      assert.containSubset(read.body, { code: 'ask_not_found' })
      const answered = yield* post(`/asks/${UNKNOWN_ID}/answer`, { selected: ['yes'] })
      assert.strictEqual(answered.status, 404)
      assert.containSubset(answered.body, { code: 'ask_not_found' })
    }),
  )
})

it.layer(ApiTestLayer())('POST /api/v1/asks/:id/answer over the fake provider', (suite) => {
  suite.effect('refuses an option the ask does not offer with 422 and leaves it pending', () =>
    Effect.gen(function* refuses() {
      const { ask } = yield* askedSession
      const refused = yield* post(`/asks/${ask.id}/answer`, { selected: ['no-such-option'] })
      assert.strictEqual(refused.status, 422)
      assert.containSubset(refused.body, {
        code: 'ask_invalid_answer',
        detail: `ask ${ask.id} has no option no-such-option`,
      })
      assert.containSubset((yield* get(`/asks/${ask.id}`)).body, { status: 'pending' })
    }),
  )

  suite.effect(
    'takes an answer once, reads it back answered via api and refuses a second one',
    () =>
      Effect.gen(function* answers() {
        const { session, ask } = yield* askedSession
        const answer = { selected: [(yield* recommendedOption(ask)).id] }
        assert.strictEqual((yield* post(`/asks/${ask.id}/answer`, answer)).status, 204)
        const again = yield* post(`/asks/${ask.id}/answer`, answer)
        assert.strictEqual(again.status, 409)
        assert.containSubset(again.body, { code: 'ask_not_pending' })
        const read = yield* get(`/asks/${ask.id}`)
        assert.containSubset(read.body, { status: 'answered', answeredVia: 'api', answer })
        assert.deepStrictEqual((yield* get(`/asks?session=${session.id}`)).body, [])
      }),
  )
})
```
The `?.` and `??` chains above are refused by the lint (`oxc/no-optional-chaining`); write them with `find` and an `if` that throws when the fixture is not as expected.

`packages/api/src/workspaces-plugins.test.ts`:
```ts
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { ApiTestLayer, get, post } from './testing.js'
import { createdSession } from './testing-sessions.js'

// A worktree is kept for seven days after its session ended, unless the project says otherwise
const EIGHT_DAYS = 8 * 24 * 60 * 60 * 1000

it.layer(ApiTestLayer())('GET /api/v1/workspaces and POST /api/v1/workspaces/prune', (suite) => {
  suite.effect('lists the worktree of a session, of its project and of every project', () =>
    Effect.gen(function* lists() {
      const { session, project } = yield* createdSession
      const workspace = yield* Effect.fromNullishOr(session.workspace)
      const info = {
        sessionId: session.id,
        projectId: project.id,
        path: workspace.path,
        branch: 'bb/create-hello',
        baseRef: 'main',
        sessionStatus: 'ready',
        exists: true,
      }
      assert.deepStrictEqual((yield* get(`/workspaces?project=${project.id}`)).body, [info])
      assert.containSubset((yield* get('/workspaces')).body, [info])
    }),
  )

  suite.effect('prunes nothing while its session is at work, and says why', () =>
    Effect.gen(function* prunesNothing() {
      const { session, project } = yield* createdSession
      const workspace = yield* Effect.fromNullishOr(session.workspace)
      const pruned = yield* post('/workspaces/prune', { projectId: project.id })
      assert.strictEqual(pruned.status, 200)
      assert.deepStrictEqual(pruned.body, {
        removed: [],
        retained: [{ path: workspace.path, reason: 'session is ready' }],
      })
      assert.containSubset((yield* post('/workspaces/prune', {})).body, { removed: [] })
    }),
  )
})

it.layer(ApiTestLayer())('GET /api/v1/plugins and GET /api/v1/providers', (suite) => {
  suite.effect('lists the bundled plugins as loaded, with the ports each offers', () =>
    Effect.gen(function* listsPlugins() {
      const listed = yield* get('/plugins')
      assert.strictEqual(listed.status, 200)
      assert.deepStrictEqual(listed.body, [
        {
          name: 'workspace-local',
          version: '0.0.0',
          state: 'loaded',
          ports: ['workspaceRuntimes:local'],
        },
        { name: 'agent-fake', version: '0.0.0', state: 'loaded', ports: ['agentProviders:fake'] },
      ])
    }),
  )

  suite.effect('lists the fake provider among the agent providers the plugins offer', () =>
    Effect.gen(function* listsProviders() {
      const listed = yield* get('/providers')
      assert.strictEqual(listed.status, 200)
      assert.deepStrictEqual(listed.body, [
        { id: 'fake', displayName: 'Fake agent (tests and CI)' },
      ])
    }),
  )
})

// The clock of the suite is the test clock the handlers read, so the retention can run out at once
it.layer(ApiTestLayer())('POST /api/v1/workspaces/prune after the retention', (suite) => {
  suite.effect('removes the worktree of a session that ended long ago', () =>
    Effect.gen(function* prunesOld() {
      const { session, project } = yield* createdSession
      const workspace = yield* Effect.fromNullishOr(session.workspace)
      assert.strictEqual((yield* post(`/sessions/${session.id}/stop`)).status, 204)
      yield* TestClock.setTime(Date.now() + EIGHT_DAYS)
      const pruned = yield* post('/workspaces/prune', { projectId: project.id })
      assert.deepStrictEqual(pruned.body, { removed: [workspace.path], retained: [] })
      const listed = yield* get(`/workspaces?project=${project.id}`)
      assert.containSubset(listed.body, [{ sessionId: session.id, exists: false }])
    }),
  )
})
```

`packages/api/src/rate-limit.test.ts`:
```ts
import { createTempRepo } from '@bytebureau/kernel/testing'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ApiTestLayer, baseUrl, fetched, get, post } from './testing.js'

const TWO_TOKENS = ApiTestLayer({ mutationLimit: { capacity: 2, perMinute: 60 } })

it.layer(TWO_TOKENS)('the mutation rate limit with two tokens', (suite) => {
  suite.effect(
    'answers the third mutation in a row with 429 rate_limited and still serves reads',
    () =>
      Effect.gen(function* limits() {
        const repos = [createTempRepo(), createTempRepo(), createTempRepo()]
        const replies = yield* Effect.all(repos.map((path) => post('/projects', { path })))
        assert.deepStrictEqual(
          replies.map((reply) => reply.status),
          [201, 201, 429],
        )
        const limited = yield* Effect.fromNullishOr(replies[2])
        assert.include(limited.type, 'application/problem+json')
        assert.containSubset(limited.body, {
          code: 'rate_limited',
          status: 429,
          detail: 'retry after 1 s',
        })
        assert.strictEqual((yield* get('/projects')).status, 200)
      }),
  )
})

it.layer(TWO_TOKENS)('the mutation rate limit and the bearer token', (suite) => {
  suite.effect('does not count a request without the token against the limit', () =>
    Effect.gen(function* keepsTokens() {
      const base = yield* baseUrl
      const refused = yield* Effect.forEach([1, 2, 3], () =>
        fetched(`${base}/api/v1/projects`, { method: 'POST' }),
      )
      assert.deepStrictEqual(
        refused.map((response) => response.status),
        [401, 401, 401],
      )
      const replies = yield* Effect.forEach([createTempRepo(), createTempRepo()], (path) =>
        post('/projects', { path }),
      )
      assert.deepStrictEqual(
        replies.map((reply) => reply.status),
        [201, 201],
      )
    }),
  )
})
```

`packages/api/src/body-limit.ts` (added during execution):
```ts
import { ByteSize, Effect } from 'effect'
import { HttpServerRequest, HttpServerResponse } from 'effect/http'
import { problem } from './problems.js'

// Decimal megabytes, as the platform limit (MaxBodySize) counts them
export const MAX_BODY_BYTES = ByteSize.toNumberUnsafe(ByteSize.megabytes(10))

const tooLarge = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(
    problem(413, 'payload_too_large', 'the request body exceeds 10 MB'),
    { status: 413, contentType: 'application/problem+json' },
  )

// A request without a length, or with one that is no number, is left to the platform limit
const declaredLength = (request: HttpServerRequest.HttpServerRequest): number =>
  Number(request.headers['content-length'])

// A body that declares itself larger than the limit is refused with a problem before any of it is read
// The platform limit stays as the backstop for a body without a length: Node drops that connection and Bun answers an empty 413
export const bodyLimit = <Failure, Requirements>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, Failure, Requirements>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Failure,
  Requirements | HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* limitsBody() {
    const request = yield* HttpServerRequest.HttpServerRequest
    return declaredLength(request) > MAX_BODY_BYTES ? tooLarge() : yield* app
  })
```

`packages/api/src/sessions-refusals.test.ts` (added during execution):
```ts
import { SessionDto } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { ApiTestLayer, get, post } from './testing.js'
import { fakeProjectConfig, registeredWith } from './testing-sessions.js'

interface Refusal {
  readonly title: string
  readonly config: Record<string, unknown>
  readonly body: Record<string, unknown>
  readonly status: number
  readonly code: string
  readonly detail: string
}

const { developer } = fakeProjectConfig.employees
const YOLO = {
  ...fakeProjectConfig,
  employees: { developer: { ...developer, permissionMode: 'yolo' } },
}

// What the kernel refuses a session for, with the status and the code the API tells it as
const REFUSALS: Refusal[] = [
  {
    title: 'a provider nobody offers',
    config: fakeProjectConfig,
    body: { providerId: 'nobody' },
    status: 422,
    code: 'session_provider_missing',
    detail: 'provider "nobody" is not available; available: fake',
  },
  {
    title: 'an employee the project does not have',
    config: fakeProjectConfig,
    body: { employeeId: 'nobody' },
    status: 422,
    code: 'session_employee_missing',
    detail: 'employee "nobody" is not defined in bytebureau.json',
  },
  {
    title: 'permission mode yolo on the local runtime',
    config: YOLO,
    body: {},
    status: 403,
    code: 'session_yolo_refused',
    detail:
      'permission mode "yolo" is refused on the "local" runtime (isolation: none); container runtimes enable it later',
  },
]

it.layer(ApiTestLayer())('the refusals of POST /api/v1/sessions', (suite) => {
  suite.effect.each(REFUSALS)('refuses $title with $status $code and creates nothing', (refusal) =>
    Effect.gen(function* refuses() {
      const { project } = yield* registeredWith(refusal.config)
      const body = { projectId: project.id, title: 'x', ...refusal.body }
      const refused = yield* post('/sessions', body)
      assert.strictEqual(refused.status, refusal.status)
      assert.include(refused.type, 'application/problem+json')
      assert.containSubset(refused.body, { code: refusal.code, detail: refusal.detail })
      const listed = Schema.decodeUnknownSync(Schema.Array(SessionDto))(
        (yield* get('/sessions')).body,
      )
      assert.deepStrictEqual(
        listed.filter((session) => session.projectId === project.id),
        [],
      )
    }),
  )
})
```

- [ ] **Step 5: Run the tests to verify they fail, then make them pass**

Run: `bunx vitest run --project api`
Expected: FAIL first (unknown routes answer 404 without a problem body); after Steps 1–3, PASS.

Then regenerate and verify the document: `bun run --cwd packages/api build && bunx vitest run --project api src/openapi.test.ts`. Extend `openapi.test.ts` with one assertion per group that its paths exist (`/api/v1/projects`, `/api/v1/sessions/{id}/prompt`, `/api/v1/asks/{id}/answer`, `/api/v1/usage/sessions/{id}`, `/api/v1/workspaces/prune`, `/api/v1/plugins`, `/api/v1/providers`) and that `POST /api/v1/projects` declares the `201` response and the `422` problem.

- [ ] **Step 6: Gates and commit**

Run: `bun run typecheck && bun run lint && bun run format:check && bun run knip && bun run depcruise && bun run spell && bunx vitest run --project api --project kernel`
Expected: PASS.

```bash
git add packages/api packages/kernel/src/asks
git commit -m "feat(api): add the projects, sessions, asks, usage, workspaces and plugins groups"
```

### Task 5: `packages/api` — the SSE event stream: replay then live, `Last-Event-ID` resume, heartbeat, per-client delivery buffer

**Files:**
- Create: `packages/api/src/events/delivery-buffer.ts`, `packages/api/src/events/delivery-buffer.test.ts`, `packages/api/src/events/buffered.ts`, `packages/api/src/events/sse.ts`, `packages/api/src/groups/events.ts`, `packages/api/src/handlers/events.ts`, `packages/api/src/testing-sse.ts`, `packages/api/src/events.test.ts`
- Modify: `packages/api/src/api.ts` (`EventsGroup` joins the API), `packages/api/src/layer.ts` or `handlers/all.ts` (`EventsHandlers`), `packages/api/openapi.json` (regenerated), `packages/api/src/openapi.test.ts` (the `/api/v1/events` path with `text/event-stream`)

**Interfaces:**
- Consumes: `EventLog` (`subscribe(filter)`), `EventFilter`, `uuidv7`, `nowIso` (kernel); `EventEnvelope`, `EventsQuery` (protocol); `ApiConfig.heartbeat`, `Authorization`, `RequestValidation`, `BureauApi` (Tasks 3–4).
- Produces: `GET /api/v1/events?since&session&project&types` (`text/event-stream`; `id: <seq>` on durable events, no `id` on ephemeral ones, `event: <type>`, `data: <EventEnvelope JSON>`, an `event: heartbeat` frame every `heartbeat`), `DeliveryBuffer`, `buffered(stream, capacity?)`, `toSseEvent()`, `heartbeatEvent()`, `sinceOf()`, and for tests `readSse(response, until, signal?)`.

Verified facts this task relies on (fact sheet §3): `effect@4.0.0` ships SSE natively — `HttpApiSchema.StreamSse({ events })` declares a `text/event-stream` success whose handler returns a `Stream` of events, each event's schema being an `Sse.EventCodec` (encoded as `{ id?: string; event?: string; data: string }`); `Schema.fromJsonString(EventEnvelope)` turns the envelope into the `data` string; `Stream.tick(interval)` emits once at once and then at the interval, `Stream.merge(left, right, { haltStrategy })` ends the merge as the strategy says, `Stream.fromQueue`, `Queue.unbounded`, `Queue.end` exist (`dist/Stream.d.ts`, `dist/Queue.d.ts`); an endpoint's `headers` schema reads request headers by lower-case name.

Semantics: the SSE suite is built with `{ excludeTestServices: true }` so the heartbeat runs on the live clock (`@effect/vitest`'s `it.layer` provides the TestClock otherwise, and handlers see it — Task 4 verified the clock reads 0 under the default layer). A client that passes `since=<seq>` or `Last-Event-ID: <seq>` (the header wins) gets every durable event after that seq replayed from the log in order, then the live ones; the kernel's `EventLog.subscribe` already opens the subscription before reading the replay, so nothing published meanwhile is lost (Phase A Task 6). Ephemeral events (`seq` 0: text deltas, tool progress, heartbeats) carry no `id`, so a browser's automatic reconnect resends the last durable seq. A heartbeat frame goes out every `heartbeat` (15 s by default; tests shorten it) so proxies and clients see a live connection; it is an `event: heartbeat` frame with an envelope of type `heartbeat`, not an SSE comment, because the schema encodes events only. Backpressure (spec §11.1 "drop oldest ephemeral deltas first"): each connection has a `DeliveryBuffer` — durable events are never dropped, ephemeral events are kept up to a capacity (64) and the oldest ephemeral one goes when a new one arrives above it; a client that reads slowly therefore misses deltas, never durable facts. A failure of the subscription ends the stream (the client resumes with its last id); a client that goes away ends the subscription (the stream's scope closes with the response).

- [ ] **Step 1: Write the failing buffer test**

`packages/api/src/events/delivery-buffer.test.ts`:
```ts
import type { EventEnvelope } from '@bytebureau/protocol'
import { describe, expect, it } from 'vitest'
import { DeliveryBuffer } from './delivery-buffer.js'

const event = (seq: number, type: string): EventEnvelope => ({
  seq,
  id: `e${seq}-${type}`,
  ts: '2026-10-04T00:00:00.000Z',
  type,
  payload: {},
})

describe(DeliveryBuffer, () => {
  it('hands events out in the order they came while nothing is dropped', () => {
    const buffer = new DeliveryBuffer(3)
    buffer.push(event(1, 'a'))
    buffer.push(event(0, 'delta'))
    buffer.push(event(2, 'b'))
    expect(buffer.drain().map((item) => item.id)).toStrictEqual(['e1-a', 'e0-delta', 'e2-b'])
    expect(buffer.drain()).toStrictEqual([])
  })

  it('drops the oldest ephemeral event above the capacity and keeps every durable one', () => {
    const buffer = new DeliveryBuffer(2)
    buffer.push(event(1, 'a'))
    buffer.push({ ...event(0, 'delta'), id: 'd1' })
    buffer.push({ ...event(0, 'delta'), id: 'd2' })
    buffer.push(event(2, 'b'))
    buffer.push({ ...event(0, 'delta'), id: 'd3' })
    buffer.push(event(3, 'c'))
    expect(buffer.drain().map((item) => item.id)).toStrictEqual(['e1-a', 'd2', 'e2-b', 'd3', 'e3-c'])
    expect(buffer.dropped).toBe(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx vitest run --project api src/events/delivery-buffer.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: The buffer and the buffered stream**

`packages/api/src/events/delivery-buffer.ts`:
```ts
import type { EventEnvelope } from '@bytebureau/protocol'

// What one client has not read yet: durable events are never dropped, ephemeral ones above the capacity push the oldest ephemeral out
export class DeliveryBuffer {
  public dropped = 0
  private items: EventEnvelope[] = []
  private ephemeral = 0
  private readonly capacity: number

  public constructor(capacity: number) {
    this.capacity = capacity
  }

  public push(event: EventEnvelope): void {
    if (event.seq === 0) {
      this.ephemeral += 1
      if (this.ephemeral > this.capacity) {
        this.evictOldestEphemeral()
      }
    }
    this.items.push(event)
  }

  public drain(): readonly EventEnvelope[] {
    const drained = this.items
    this.items = []
    this.ephemeral = 0
    return drained
  }

  private evictOldestEphemeral(): void {
    const index = this.items.findIndex((item) => item.seq === 0)
    if (index !== -1) {
      this.items.splice(index, 1)
      this.ephemeral -= 1
      this.dropped += 1
    }
  }
}
```

`packages/api/src/events/buffered.ts`:
```ts
import type { EventEnvelope } from '@bytebureau/protocol'
import { Effect, Queue, Stream } from 'effect'
import { DeliveryBuffer } from './delivery-buffer.js'

export const EPHEMERAL_CAPACITY = 64

// The source is read as fast as it comes into the buffer; the client takes what the buffer holds whenever it is ready
// A failure of the source is logged and ends the stream: an SSE client resumes from its last id
export const buffered = <Failure>(
  source: Stream.Stream<EventEnvelope, Failure>,
  capacity: number = EPHEMERAL_CAPACITY,
): Stream.Stream<EventEnvelope> =>
  Stream.unwrap(
    Effect.gen(function* startsBuffering() {
      const buffer = new DeliveryBuffer(capacity)
      const signal = yield* Queue.unbounded<void>()
      const fill = source.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            buffer.push(event)
          }).pipe(Effect.andThen(Queue.offer(signal, undefined))),
        ),
        Effect.catchCause((cause) => Effect.logWarning('an event subscription ended with a failure', cause)),
        Effect.ensuring(Queue.end(signal)),
      )
      yield* Effect.forkScoped(fill)
      return Stream.fromQueue(signal).pipe(
        Stream.flatMap(() => Stream.fromIterable(buffer.drain())),
      )
    }),
  )
```
`Queue.unbounded<void>()` may need the `Done` error type for `Queue.end` (`Queue.unbounded<void, Cause.Done>()`); follow what the compiler asks, as Phase A's `EventQueue` fixture does.

- [ ] **Step 4: SSE shapes, the group and the handler**

`packages/api/src/events/sse.ts`:
```ts
import { nowIso, uuidv7, type EventFilter } from '@bytebureau/kernel'
import { EventEnvelope, type EventsQuery } from '@bytebureau/protocol'
import { Schema } from 'effect'

// One frame of the stream: the seq as the id of a durable event, the type as the event name, the envelope as the data
export const SseEvent = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  event: Schema.String,
  data: Schema.fromJsonString(EventEnvelope),
})
export type SseEvent = typeof SseEvent.Type

export const toSseEvent = (envelope: EventEnvelope): SseEvent =>
  envelope.seq === 0
    ? { event: envelope.type, data: envelope }
    : { id: String(envelope.seq), event: envelope.type, data: envelope }

// A heartbeat is an ephemeral envelope of its own type, so every frame of the stream decodes as an event
export const heartbeatEvent = (): SseEvent => ({
  event: 'heartbeat',
  data: { seq: 0, id: uuidv7(), ts: nowIso(), type: 'heartbeat', payload: { at: nowIso() } },
})

// The header of a resuming client wins over the query; anything that is not a whole number is ignored
export const sinceOf = (query: EventsQuery, lastEventId: string | undefined): number => {
  const fromHeader = lastEventId === undefined ? Number.NaN : Number(lastEventId)
  if (Number.isInteger(fromHeader) && fromHeader >= 0) {
    return fromHeader
  }
  return query.since ?? 0
}

export const filterOf = (query: EventsQuery, lastEventId: string | undefined): EventFilter => ({
  since: sinceOf(query, lastEventId),
  ...(query.session === undefined ? {} : { sessionId: query.session }),
  ...(query.project === undefined ? {} : { projectId: query.project }),
  ...(query.types === undefined ? {} : { types: query.types.split(',').filter((type) => type !== '') }),
})
```

`packages/api/src/groups/events.ts`:
```ts
import { EventsQuery } from '@bytebureau/protocol'
import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api'
import { Authorization } from '../auth.js'
import { SseEvent } from '../events/sse.js'
import { RequestValidation } from '../validation.js'

export const EventsGroup = HttpApiGroup.make('events')
  .add(
    HttpApiEndpoint.get('stream', '/events', {
      query: EventsQuery,
      headers: { 'last-event-id': Schema.optionalKey(Schema.String) },
      success: HttpApiSchema.StreamSse({ events: SseEvent }),
    }),
  )
  .middleware(Authorization)
  .middleware(RequestValidation)
```

`packages/api/src/handlers/events.ts`:
```ts
import { EventLog } from '@bytebureau/kernel'
import { Effect, Stream } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { BureauApi } from '../api.js'
import { ApiConfig } from '../config.js'
import { buffered } from '../events/buffered.js'
import { filterOf, heartbeatEvent, toSseEvent } from '../events/sse.js'

export const EventsHandlers = HttpApiBuilder.group(BureauApi, 'events', (handlers) =>
  handlers.handle('stream', ({ query, headers }) =>
    Effect.gen(function* opensStream() {
      const { heartbeat } = yield* ApiConfig
      const log = yield* EventLog
      const events = buffered(log.subscribe(filterOf(query, headers['last-event-id']))).pipe(
        Stream.map(toSseEvent),
      )
      // The first tick comes at once and then every heartbeat; the beats stop when the events end, so the response ends with them
      const beats = Stream.tick(heartbeat).pipe(
        Stream.drop(1),
        Stream.map(() => heartbeatEvent()),
      )
      return Stream.merge(events, beats, { haltStrategy: 'left' })
    }),
  ),
)
```
`Stream.merge` takes `{ haltStrategy: 'left' }` in `effect@4.0.0` (`dist/Stream.d.ts` line 3229: "By default, the merged stream ends when both streams end. Use haltStrategy to change the termination behavior"); if the literal is spelled differently in the `HaltStrategy` type, use the member that ends the merge when the left stream ends. `api.ts` gains `EventsGroup`; the handlers merge gains `EventsHandlers`.

- [ ] **Step 5: The SSE reader for tests and the failing stream tests**

`packages/api/src/testing-sse.ts`:
```ts
export interface SseFrame {
  readonly id: string | undefined
  readonly event: string
  readonly data: string
}

// One SSE frame from its lines; a line without a colon is a field with an empty value
const parseFrame = (block: string): SseFrame => {
  const fields = new Map<string, string>()
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':')
    const key = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /u, '')
    fields.set(key, fields.has(key) && key === 'data' ? `${fields.get(key) ?? ''}\n${value}` : value)
  }
  return { id: fields.get('id'), event: fields.get('event') ?? 'message', data: fields.get('data') ?? '' }
}

// Reads frames from a text/event-stream response until the predicate says enough; the response is cancelled afterwards
export async function readSse(
  response: Response,
  until: (frames: readonly SseFrame[]) => boolean,
): Promise<SseFrame[]> {
  if (response.body === null) {
    throw new Error('the response has no body')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const frames: SseFrame[] = []
  let pending = ''
  try {
    while (!until(frames)) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      pending += decoder.decode(value, { stream: true })
      const blocks = pending.split('\n\n')
      pending = blocks.pop() ?? ''
      frames.push(...blocks.filter((block) => block.trim() !== '').map(parseFrame))
    }
  } finally {
    await reader.cancel()
  }
  return frames
}
```
The `??` operators are fine (only `?.` is refused); `max-statements` may ask for the loop body to become a helper.

`packages/api/src/events.test.ts`:
```ts
import { EventLog } from '@bytebureau/kernel'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { describe, expect } from 'vitest'
import { ApiTestLayer, authorized, baseUrl, json } from './testing.js'
import { createdSession } from './testing-sessions.js'
import { readSse, type SseFrame } from './testing-sse.js'

const seqOf = (frame: SseFrame): number => Number(frame.id)
const typesOf = (frames: readonly SseFrame[]): string[] => frames.map((frame) => frame.event)

describe('GET /api/v1/events', () => {
  // The test layer would otherwise run on the TestClock (Task 4 found handlers see it), and Stream.tick never ticks there
  it.layer(ApiTestLayer({ heartbeat: '100 millis' }), { excludeTestServices: true })('over the fake provider', (it) => {
    it.effect('replays the durable events of a session with their seq as id, then streams the live ones', () =>
      Effect.gen(function* streams() {
        const base = yield* baseUrl
        const { session } = yield* createdSession
        const response = yield* Effect.promise(() =>
          fetch(`${base}/api/v1/events?session=${session.id}&since=0`, authorized()),
        )
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('text/event-stream')
        yield* Effect.promise(() => fetch(`${base}/api/v1/sessions/${session.id}/prompt`, json({ text: 'go' })))
        const frames = yield* Effect.promise(() =>
          readSse(response, (seen) => seen.some((frame) => frame.event === 'turn.started')),
        )
        const durable = frames.filter((frame) => frame.id !== undefined)
        expect(typesOf(durable).slice(0, 3)).toStrictEqual(['session.created', 'session.provisioning', 'workspace.provisioned'])
        expect(durable.map(seqOf)).toStrictEqual([...durable.map(seqOf)].sort((left, right) => left - right))
        expect(JSON.parse(durable[0]?.data ?? '{}')).toMatchObject({ type: 'session.created', sessionId: session.id })
      }),
    )

    it.effect('sends a heartbeat frame without an id while nothing happens', () =>
      Effect.gen(function* beats() {
        const base = yield* baseUrl
        const response = yield* Effect.promise(() =>
          fetch(`${base}/api/v1/events?since=1000000`, authorized()),
        )
        const frames = yield* Effect.promise(() =>
          readSse(response, (seen) => seen.some((frame) => frame.event === 'heartbeat')),
        )
        const beat = frames.find((frame) => frame.event === 'heartbeat')
        expect(beat).toBeDefined()
        expect(beat === undefined ? 'x' : beat.id).toBeUndefined()
        expect(JSON.parse(beat === undefined ? '{}' : beat.data)).toMatchObject({ type: 'heartbeat', seq: 0, payload: { at: expect.any(String) } })
      }),
    )

    it.effect('resumes from Last-Event-ID without a gap and without a duplicate', () =>
      Effect.gen(function* resumes() {
        const base = yield* baseUrl
        const { session } = yield* createdSession
        const first = yield* Effect.promise(() =>
          fetch(`${base}/api/v1/events?session=${session.id}`, authorized()),
        )
        const head = yield* Effect.promise(() => readSse(first, (seen) => seen.filter((frame) => frame.id !== undefined).length >= 2))
        const lastSeen = Math.max(...head.filter((frame) => frame.id !== undefined).map(seqOf))
        const second = yield* Effect.promise(() =>
          fetch(`${base}/api/v1/events?session=${session.id}`, authorized({ headers: { 'last-event-id': String(lastSeen) } })),
        )
        const log = yield* EventLog
        const all = yield* log.read({ sessionId: session.id }, { from: 0 })
        const tail = yield* Effect.promise(() =>
          readSse(second, (seen) => seen.filter((frame) => frame.id !== undefined).length >= all.length - head.filter((frame) => frame.id !== undefined).length),
        )
        const resumed = tail.filter((frame) => frame.id !== undefined).map(seqOf)
        expect(resumed).toStrictEqual(all.map((event) => event.seq).filter((seq) => seq > lastSeen))
      }),
    )

    it.effect('refuses a missing token with 401 and a since that is no number with 400', () =>
      Effect.gen(function* refuses() {
        const base = yield* baseUrl
        const noToken = yield* Effect.promise(() => fetch(`${base}/api/v1/events`))
        expect(noToken.status).toBe(401)
        const badSince = yield* Effect.promise(() => fetch(`${base}/api/v1/events?since=soon`, authorized()))
        expect(badSince.status).toBe(400)
        expect(yield* Effect.promise(() => badSince.json())).toMatchObject({ code: 'request_invalid' })
      }),
    )
  })
})
```
`authorized({ headers })` merges its own header into the given ones (Task 3 wrote it so); the `?.`/`??` pairs on `durable[0]` need the lint-friendly form (`const [firstFrame] = durable; if (firstFrame === undefined) throw …`). The exact first three durable types come from the kernel's create path (`session.created`, `session.provisioning`, `workspace.provisioned`, `session.ready`, …): read what `EventLog.read` returns once and pin that order.

- [ ] **Step 6: Run the tests, regenerate the document, run the gates**

Run: `bunx vitest run --project api && bun run --cwd packages/api build && bunx vitest run --project api src/openapi.test.ts && bun run typecheck && bun run lint && bun run format:check && bun run knip && bun run spell`
Expected: PASS. Add to `openapi.test.ts`: `expect(paths).toHaveProperty(['/api/v1/events', 'get'])` and that its `200` response lists `text/event-stream` content. If `StreamSse` does not render the content type the way the assertion expects, assert on what `OpenApi.fromApi` produces after reading it once (the content type must be `text/event-stream`).

- [ ] **Step 7: Commit**

```bash
git add packages/api
git commit -m "feat(api): stream events over SSE with resume, heartbeat and a per-client delivery buffer"
```

### Task 6: `packages/api` — RPC over WebSocket (`effect/rpc`, JSON envelopes), per-request bearer middleware, origin check

**Files:**
- Create: `packages/api/src/rpc/group.ts`, `packages/api/src/rpc/auth.ts`, `packages/api/src/rpc/handlers.ts`, `packages/api/src/rpc/route.ts`, `packages/api/src/testing-ws.ts`, `packages/api/src/rpc.test.ts`, `docs/decisions/0013-api-transports.md`
- Modify: `packages/api/src/layer.ts` (`RpcRoute(options)` joins `ApiLive`), `packages/api/src/index.ts` (exports `RpcAuthorization`, `BureauRpcsWithAuth`, `WS_PATH`), `cspell-words.txt`

**Interfaces:**
- Consumes: `BureauRpcs` (Task 1), `buffered` (Task 5), `orProblem`, `UNAUTHORIZED`, `sameToken`, `ApiConfig` (Tasks 3–4), the kernel services.
- Produces: `GET /api/v1/ws` — a WebSocket speaking `effect/rpc` with `RpcSerialization.json` (one JSON message per frame); `BureauRpcsWithAuth`, `RpcAuthorization` + `RpcAuthorizationLive(token)`, `WS_PATH`, and for tests `wsClient(url)` (a tiny client of the wire protocol used by Task 7's real client as a reference).

Verified facts this task relies on (fact sheet §4): in `effect@4.0.0`, `effect/rpc` exports `RpcServer.toHttpEffectWebsocket(group)` (an effect that starts the RPC server for the group and yields the HTTP effect that upgrades the current request to the websocket protocol; requires `Scope`, `RpcSerialization`, the group's handlers and middleware), `RpcSerialization.layerJson` ("use when the transport already frames messages" — a WebSocket does), `RpcMiddleware.Service<Self>()(name, { error, requiredForClient })` whose implementation is a function `(effect, { client, requestId, rpc, payload, headers }) => Effect`, `RpcGroup.middleware(Service)`, `RpcGroup.toLayer(handlers)`; the wire messages are the `RpcMessage` encoded shapes: from the client `{ _tag: 'Request', id, tag, payload, headers: [[name, value]] }`, `{ _tag: 'Ack', requestId }`, `{ _tag: 'Interrupt', requestId }`, `{ _tag: 'Ping' }`, `{ _tag: 'Eof' }`; from the server `{ _tag: 'Chunk', requestId, values: [...] }`, `{ _tag: 'Exit', requestId, exit: { _tag: 'Success', value } | { _tag: 'Failure', cause: [{ _tag: 'Fail', error } | { _tag: 'Die', defect } | { _tag: 'Interrupt', fiberId }] } }`, `{ _tag: 'Defect', defect }`, `{ _tag: 'Pong' }`, `{ _tag: 'ClientProtocolError', error }` (`dist/rpc/RpcMessage.d.ts`; the fact sheet §4.7–4.8 ran this exchange against `RpcSerialization.layerJson` on Bun 1.4.2: an `Exit` for a stream arrived only after the `Ack`, a `Ping` was answered with a `Pong`, and a frame may carry one message or an array of them); `HttpServerRequest.headers` is a `Headers` record read with `Headers.get(headers, name)`; `@effect/platform-node`'s server upgrades websockets through `ws` (a dependency of `@effect/platform-node-shared`), Bun's natively.

Semantics (ADR-0013): the spec's "effect/rpc over WebSocket" is served as the spec says it (ruling of the plan: the fact sheet §4 recommends a hand-written JSON protocol instead, because every `effect/rpc` export is marked unstable and a stream waits for the client's acknowledgement of each chunk — the first holds for all of `effect/http-api` as well, and the second is the flow control the client implements in Task 7; if `rpc.test.ts` cannot be made green against the envelopes below within this task's fix rounds, the fallback is that hand-written protocol with the message schemas in the protocol package, ledgered as a ruling), with the JSON serialization so that a client without Effect can speak it — the envelopes above are small and typed, and Task 7's client implements them in one module. Authentication is per request: every `Request` envelope carries `["authorization", "Bearer <token>"]` in its `headers`, and `RpcAuthorization` refuses a request without a valid token with the `unauthorized` problem as the request's failure; the upgrade itself is unauthenticated (the server listens on loopback and the token never travels in the URL), but a browser's `Origin` header is checked at the upgrade: an origin outside `corsOrigins` is refused with `403` before the socket opens, a request without `Origin` (the CLI, Node, Bun) passes. Streams (`events.subscribe`) are delivered as `Chunk` messages; the server waits for the client's `Ack` of a chunk before it sends the next, which is the per-client backpressure of spec §11.1 together with the `buffered` delivery (oldest ephemeral deltas go first). `Interrupt` ends a subscription; closing the socket ends them all. A client's `Ping` gets a `Pong`.

- [ ] **Step 1: The group with middleware, the middleware, the handlers**

`packages/api/src/rpc/group.ts`:
```ts
import { BureauRpcs } from '@bytebureau/protocol'
import { RpcAuthorization } from './auth.js'

export const WS_PATH = '/api/v1/ws'

// Every procedure, the subscription included, carries the bearer token in the headers of its request
export const BureauRpcsWithAuth = BureauRpcs.middleware(RpcAuthorization)
```

`packages/api/src/rpc/auth.ts`:
```ts
import { Problem } from '@bytebureau/protocol'
import { Effect, Layer, Option, Redacted } from 'effect'
import { Headers } from 'effect/http'
import { RpcMiddleware } from 'effect/rpc'
import { sameToken, UNAUTHORIZED } from '../auth.js'
// Task 3 stopped exporting UNAUTHORIZED while nothing used it: export it from auth.ts again here

export class RpcAuthorization extends RpcMiddleware.Service<RpcAuthorization>()(
  'bb/api/RpcAuthorization',
  { error: Problem, requiredForClient: true },
) {}

const BEARER = 'bearer '

// The token of a request: the authorization header of its envelope, whatever the case of the scheme
export const bearerOf = (headers: Headers.Headers): string | undefined => {
  const value = Option.getOrUndefined(Headers.get(headers, 'authorization'))
  if (value === undefined || !value.toLowerCase().startsWith(BEARER)) {
    return undefined
  }
  return value.slice(BEARER.length).trim()
}

// Built the way AuthorizationLive is: an empty token is a programming error and dies at construction
export const RpcAuthorizationLive = (
  token: Redacted.Redacted<string>,
): Layer.Layer<RpcAuthorization> =>
  Layer.effect(
    RpcAuthorization,
    Redacted.value(token) === ''
      ? Effect.die(new Error('the API token must not be empty'))
      : Effect.succeed((effect, { headers }) => {
          const given = bearerOf(headers)
          return given !== undefined && sameToken(given, Redacted.value(token))
            ? effect
            : Effect.fail(UNAUTHORIZED)
        }),
  )
```
If `Headers.get` returns `string | undefined` rather than an `Option`, drop the `Option.getOrUndefined`.

`packages/api/src/rpc/handlers.ts`:
```ts
import {
  AskService,
  EventLog,
  ProjectRegistry,
  SessionManager,
  WorkspaceManager,
} from '@bytebureau/kernel'
import { Effect, Stream } from 'effect'
import { buffered } from '../events/buffered.js'
import { orProblem } from '../problems.js'
import { BureauRpcsWithAuth } from './group.js'

// The same kernel calls as the REST handlers, reached over the socket
export const RpcHandlers = BureauRpcsWithAuth.toLayer({
  'events.subscribe': (filter) =>
    Stream.unwrap(EventLog.use((log) => Effect.succeed(buffered(log.subscribe(filter))))),
  'projects.register': ({ path }) =>
    orProblem(ProjectRegistry.use((registry) => registry.register(path))),
  'projects.remove': ({ id }) => orProblem(ProjectRegistry.use((registry) => registry.remove(id))),
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
```
The subscription's stream must fail with nothing (`events.subscribe` declares no error); `buffered` ends on a failure instead of failing, so the types line up. `EventFilter`'s optional keys are `string | undefined` while the RPC payload's are absent-or-string; if the compiler objects, spread the payload into a fresh `EventFilter` the way `filterOf` does in Task 5.

- [ ] **Step 2: The route with the origin guard**

`packages/api/src/rpc/route.ts`:
```ts
import { Effect, Layer, Option, type Redacted } from 'effect'
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { RpcAuthorizationLive } from './auth.js'
import { BureauRpcsWithAuth, WS_PATH } from './group.js'
import { RpcHandlers } from './handlers.js'

export interface RpcRouteOptions {
  readonly token: Redacted.Redacted<string>
  readonly corsOrigins: readonly string[]
}

// A browser says where it comes from; an origin the daemon does not serve is turned away before the socket opens
const originAllowed = (headers: Headers.Headers, origins: readonly string[]): boolean => {
  const origin = Option.getOrUndefined(Headers.get(headers, 'origin'))
  return origin === undefined || origins.includes(origin)
}

export const RpcRoute = (options: RpcRouteOptions) =>
  HttpRouter.use((router) =>
    Effect.gen(function* registersRpc() {
      const upgrade = yield* RpcServer.toHttpEffectWebsocket(BureauRpcsWithAuth)
      yield* router.add(
        'GET',
        WS_PATH,
        Effect.gen(function* guardsUpgrade() {
          const request = yield* HttpServerRequest.HttpServerRequest
          return originAllowed(request.headers, options.corsOrigins)
            ? yield* upgrade
            : HttpServerResponse.empty({ status: 403 })
        }),
      )
    }),
  ).pipe(
    Layer.provide(RpcHandlers),
    Layer.provide(RpcAuthorizationLive(options.token)),
    Layer.provide(RpcSerialization.layerJson),
  )
```
`packages/api/src/layer.ts`: `ApiLive` merges `RpcRoute({ token: options.token, corsOrigins: options.corsOrigins })` next to the API builder layer and the CORS layer. Export the route's requirements through the same `ApiRequirements` alias (the handlers need the kernel services the alias already names).

- [ ] **Step 3: A test client of the wire protocol and the failing tests**

`packages/api/src/testing-ws.ts`:
```ts
export interface WsMessage {
  readonly _tag: string
  readonly [key: string]: unknown
}

// A frame holds one message or a batch of them
const messagesOf = (text: string): WsMessage[] => {
  const parsed: unknown = JSON.parse(text)
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (item): item is WsMessage => typeof item === 'object' && item !== null && '_tag' in item,
  )
}

export interface WsClient {
  readonly send: (message: object) => void
  readonly next: () => Promise<WsMessage>
  readonly close: () => void
}

// The global WebSocket of Node and Bun; messages are queued so a test reads them in order
export async function wsClient(url: string, headers: Record<string, string> = {}): Promise<WsClient> {
  const socket = new WebSocket(url, Object.keys(headers).length === 0 ? undefined : { headers })
  const queue: WsMessage[] = []
  const waiting: ((message: WsMessage) => void)[] = []
  socket.addEventListener('message', (event) => {
    for (const message of messagesOf(String(event.data))) {
      const waiter = waiting.shift()
      if (waiter === undefined) {
        queue.push(message)
      } else {
        waiter(message)
      }
    }
  })
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error(`cannot open ${url}`)), { once: true })
  })
  return {
    send: (message) => socket.send(JSON.stringify(message)),
    next: () => {
      const queued = queue.shift()
      return queued === undefined ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve(queued)
    },
    close: () => socket.close(),
  }
}

export const request = (id: string, tag: string, payload: unknown, token?: string): object => ({
  _tag: 'Request',
  id,
  tag,
  payload,
  headers: token === undefined ? [] : [['authorization', `Bearer ${token}`]],
})
```
Both Bun's and Node's (undici) global `WebSocket` accept a non-standard `{ headers }` second argument (fact sheet §4.4, verified on Node 24, Node 26 and Bun 1.4.2); browsers do not, which is why the token travels in the RPC request headers and not in the upgrade. The `as` cast is avoided by the type guard; `Object(event.data)` is not needed since `event.data` is a string for text frames.

`packages/api/src/rpc.test.ts`:
```ts
import { createTempRepo } from '@bytebureau/kernel/testing'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { describe, expect } from 'vitest'
import { ApiTestLayer, baseUrl, TEST_TOKEN } from './testing.js'
import { createdSession } from './testing-sessions.js'
import { request, wsClient } from './testing-ws.js'

const wsUrl = (base: string): string => `${base.replace(/^http/u, 'ws')}/api/v1/ws`

describe('GET /api/v1/ws (effect/rpc over WebSocket)', () => {
  it.layer(ApiTestLayer())('over the test kernel', (it) => {
    it.effect('runs a procedure with the token in the request headers and answers with its exit', () =>
      Effect.gen(function* calls() {
        const base = yield* baseUrl
        const client = yield* Effect.promise(() => wsClient(wsUrl(base)))
        const repo = createTempRepo()
        client.send(request('1', 'projects.register', { path: repo }, TEST_TOKEN))
        const exit = yield* Effect.promise(() => client.next())
        expect(exit).toMatchObject({ _tag: 'Exit', requestId: '1', exit: { _tag: 'Success', value: { path: repo } } })
        client.close()
      }),
    )

    it.effect('refuses a request without a valid token with the unauthorized problem as its failure', () =>
      Effect.gen(function* refuses() {
        const base = yield* baseUrl
        const client = yield* Effect.promise(() => wsClient(wsUrl(base)))
        client.send(request('2', 'projects.register', { path: createTempRepo() }))
        const exit = yield* Effect.promise(() => client.next())
        expect(exit).toMatchObject({
          _tag: 'Exit',
          requestId: '2',
          exit: { _tag: 'Failure', cause: [{ _tag: 'Fail', error: { code: 'unauthorized', status: 401 } }] },
        })
        client.close()
      }),
    )

    it.effect('streams the events of a session in chunks, waits for acks and ends on interrupt', () =>
      Effect.gen(function* streams() {
        const base = yield* baseUrl
        const { session } = yield* createdSession
        const client = yield* Effect.promise(() => wsClient(wsUrl(base)))
        client.send(request('3', 'events.subscribe', { sessionId: session.id, since: 0 }, TEST_TOKEN))
        const first = yield* Effect.promise(() => client.next())
        expect(first).toMatchObject({ _tag: 'Chunk', requestId: '3' })
        const values = Reflect.get(first, 'values')
        expect(Array.isArray(values) && values.length > 0).toBe(true)
        expect(values).toMatchObject([{ type: 'session.created', sessionId: session.id }])
        client.send({ _tag: 'Ack', requestId: '3' })
        client.send({ _tag: 'Interrupt', requestId: '3' })
        const ended = yield* Effect.promise(() => client.next())
        expect(ended).toMatchObject({ _tag: 'Exit', requestId: '3' })
        client.close()
      }),
    )

    it.effect('answers a ping with a pong', () =>
      Effect.gen(function* pings() {
        const base = yield* baseUrl
        const client = yield* Effect.promise(() => wsClient(wsUrl(base)))
        client.send({ _tag: 'Ping' })
        expect(yield* Effect.promise(() => client.next())).toMatchObject({ _tag: 'Pong' })
        client.close()
      }),
    )

    it.effect('turns a browser away whose origin the daemon does not serve', () =>
      Effect.gen(function* refusesOrigin() {
        const base = yield* baseUrl
        const response = yield* Effect.promise(() =>
          fetch(`${base}/api/v1/ws`, { headers: { origin: 'http://evil.example', upgrade: 'websocket' } }),
        )
        expect(response.status).toBe(403)
      }),
    )
  })
})
```
If a `Chunk` arrives in several frames or the first chunk holds more events than `session.created`, assert that the first value is `session.created` and keep reading until `Exit`; the interrupt may also surface as an `Exit` with an `Interrupt` cause — assert on `_tag: 'Exit'` and the request id only.

- [ ] **Step 4: Run, fix, record the decision**

Run: `bunx vitest run --project api src/rpc.test.ts`
Expected: FAIL before Steps 1–2 (no route), PASS after.

`docs/decisions/0013-api-transports.md`:
```markdown
# API transports: HTTP API with OpenAPI, SSE for the event stream, effect/rpc over WebSocket with JSON envelopes

- Status: accepted
- Date: 2026-10-04

## Context and problem statement

Spec §11 asks for an OpenAPI 3.1 REST API, an SSE endpoint that resumes with `Last-Event-ID`, and `effect/rpc` over WebSocket, consumed by a client package that must not depend on Effect at runtime (§3). Effect 4 ships all three on the server. The question was how a plain-TypeScript client speaks the RPC side.

## Decision

The daemon serves `effect/rpc` on `/api/v1/ws` with `RpcSerialization.json`: each WebSocket frame is one JSON envelope of the documented `RpcMessage` shapes (`Request`, `Ack`, `Interrupt`, `Ping` from the client; `Chunk`, `Exit`, `Defect`, `Pong` from the server). The client package implements those envelopes in one module and keeps Effect out of its runtime; the REST and SSE parts are generated from the OpenAPI document and read with `fetch`. The bearer token travels in the `headers` of every RPC request, never in the URL; the upgrade checks a browser's `Origin`.

## Consequences

- One contract (`BureauRpcs` in the protocol) for the server and the client; the wire shapes are pinned by `rpc.test.ts` and by the client's codec tests, so a change in Effect's envelopes is caught at upgrade time.
- A browser client (SP2) needs no header on the upgrade, so no token in the URL and no subprotocol trick.
- Streams need the client to acknowledge chunks; a client that forgets to ack sees one chunk and then silence, which the client package hides.
```
`apps/docs/src/content/docs/architecture.md` gets a pointer to ADR-0013 in Task 11 together with the rest of the Phase B text.

Run: `bun run --cwd packages/api build && bunx vitest run --project api && bun run typecheck && bun run lint && bun run format:check && bun run lint:md && bun run knip && bun run spell`
Expected: PASS (the OpenAPI document does not change: the WebSocket route is not an `HttpApi` endpoint).

- [ ] **Step 5: Commit**

```bash
git add packages/api docs/decisions/0013-api-transports.md cspell-words.txt
git commit -m "feat(api): serve effect/rpc over websocket with per-request bearer auth and an origin check"
```

### Task 7: `packages/client` — generated REST client (hey-api), SSE subscription with resume, RPC connection; `tools/client-codegen`

**Files:**
- Create: `tools/client-codegen/package.json`, `tools/client-codegen/openapi-ts.config.ts`, `tools/client-codegen/bun.lock` (by `bun install`), `packages/client/package.json`, `packages/client/tsconfig.json`, `packages/client/vitest.config.ts`, `packages/client/src/index.ts`, `packages/client/src/errors.ts`, `packages/client/src/errors.test.ts`, `packages/client/src/http.ts`, `packages/client/src/sse.ts`, `packages/client/src/sse.test.ts`, `packages/client/src/rpc/codec.ts`, `packages/client/src/rpc/codec.test.ts`, `packages/client/src/rpc/connection.ts`, `packages/client/src/gen/**` (generated, committed), `packages/api/src/client.test.ts`, `packages/api/src/client-events.test.ts`
- Modify: root `package.json` (`generate:client` script), `vitest.config.ts` (project `packages/client`; coverage excludes `**/gen/**`), `knip.ts`, `.oxlintrc.jsonc` (`ignorePatterns` for `packages/client/src/gen/**`), `.oxfmtrc.json`, `cspell.json` (ignore `packages/client/src/gen/**`), `scripts/license.test.ts` (`packages/client/package.json` is MIT), `packages/api/package.json` (`@bytebureau/client` devDependency), `.gitignore` (`tools/client-codegen/node_modules` is covered by `node_modules/`)

**Interfaces:**
- Consumes: `packages/api/openapi.json` (Tasks 3–5), the wire envelopes of Task 6, the protocol types.
- Produces: `createBureauClient(options: ClientOptions): BureauClient` with `projects.{list,register,get,remove}`, `sessions.{list,create,get,prompt,interrupt,stop,resume,complete}`, `asks.{pending,get,answer}`, `usage.session`, `workspaces.{list,prune}`, `plugins.{list,providers}`, `health.check`, `events.subscribe(filter, { signal })`, `rpc.connect()`, `close()`; `ApiError`; `subscribeEvents(options)`; `connectRpc(options)`; `RpcConnection { call, stream, close }`; the generated SDK under `src/gen` (an implementation detail of the package).

Verified facts this task relies on (fact sheet §6, §7, §4.4–4.8): `@hey-api/openapi-ts@0.99.0` (pinned exactly, "please pin an exact version") generates TypeScript types, an SDK and a fetch client that is written into the output (no runtime dependency since v0.73), supports OpenAPI 3.1, is configured by `openapi-ts.config.ts` with `defineConfig({ input, output: { path }, plugins: ['@hey-api/client-fetch', '@hey-api/sdk', '@hey-api/typescript'] })`, and uses the TypeScript compiler API at generation time, which TypeScript 7 no longer ships — so it runs from its own tools workspace pinned to `typescript: npm:@typescript/typescript6@6.0.2`, exactly like `tools/eslint-long-tail`; the generated client is configured with `client.setConfig({ baseUrl, auth, fetch })` and returns `{ data, error, response }` without throwing. Neither Bun 1.4.2 nor Node 26 (without a flag) has a global `EventSource`, and neither could send the bearer header if it had, so the subscription is hand-rolled over `fetch` with `eventsource-parser@4.1.1` (`EventSourceParserStream` from `eventsource-parser/stream`, a `TransformStream<string, { id?, event?, data }>`). Bun's and Node's `WebSocket` accept `{ headers }`; browsers do not, so the RPC token travels in the request envelopes (Task 6).

Semantics: the REST surface is the generated SDK wrapped once, so a consumer sees ByteBureau's names and the protocol's types, never hey-api's; a problem answer becomes an `ApiError(status, problem)`, a `404` on a `get` becomes `undefined`, a network failure becomes `ApiError(0, undefined, url)` whose message is `cannot reach the daemon at <url>`. `subscribeEvents` yields `EventEnvelope`s: it opens `GET /api/v1/events` with the bearer header, resumes with `Last-Event-ID` after any end of the stream (error or clean close), backs off 500 ms doubling to 30 s and resets after a successful open, stops with an `ApiError` on `401`/`403`, stops silently on the signal, and gives up with `ApiError(0, undefined, url)` once reconnecting has failed for longer than `retryFor` (30 s by default; the CLI passes 15 s); `ephemeral: false` drops `seq === 0` events (heartbeats included) client-side. `connectRpc` speaks the envelopes of Task 6: `call(tag, payload)` resolves with the `Exit`'s value or rejects with an `ApiError` built from the `Fail` error (a `Problem`) or an `Error` for a defect or an interrupt; `stream(tag, payload, signal)` yields each value of every `Chunk`, acknowledges every chunk, sends `Interrupt` when the signal aborts, and ends on the `Exit`; the connection pings every 30 s while open.

- [ ] **Step 1: The codegen tool and the client scaffold**

`tools/client-codegen/package.json`:
```json
{
  "name": "@bytebureau/client-codegen",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "generate": "openapi-ts"
  },
  "devDependencies": {
    "@hey-api/openapi-ts": "0.99.0",
    "typescript": "npm:@typescript/typescript6@6.0.2"
  }
}
```
`tools/client-codegen/openapi-ts.config.ts`:
```ts
import { defineConfig } from '@hey-api/openapi-ts'

// The generated client is bundled into the output: packages/client has no runtime dependency on hey-api
export default defineConfig({
  input: '../../packages/api/openapi.json',
  output: { path: '../../packages/client/src/gen' },
  plugins: ['@hey-api/client-fetch', '@hey-api/sdk', '@hey-api/typescript'],
})
```
Root `package.json` scripts: `"generate:client": "bun install --frozen-lockfile --cwd tools/client-codegen && bun run --cwd tools/client-codegen generate"`. Run `bun install --cwd tools/client-codegen` once to create its `bun.lock`, then `bun run generate:client` (the generator's bin is a Node script; the pinned Node 26 runs it). Commit `packages/client/src/gen/**` as generated. Read `packages/client/src/gen/sdk.gen.ts` once: the SDK function names derive from the operationIds of `openapi.json` (Effect names an operation `<group>.<endpoint>`; hey-api turns `projects.list` into a camel-case function such as `projectsList`) — `http.ts` below imports whatever names the file exports; the shape of the wrapper does not depend on them.

`packages/client/package.json`:
```json
{
  "name": "@bytebureau/client",
  "version": "0.0.0",
  "private": true,
  "description": "ByteBureau client: the generated API client, the event subscription and the RPC connection (no Effect at runtime)",
  "license": "MIT",
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    }
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@bytebureau/protocol": "workspace:*",
    "eventsource-parser": "4.1.1"
  },
  "devDependencies": {
    "@bytebureau/tsconfig": "workspace:*"
  }
}
```
`@bytebureau/protocol` is a type-only dependency at runtime (`import type` everywhere in this package), kept as a dependency so the published types resolve. `packages/client/tsconfig.json`: `{ "extends": "@bytebureau/tsconfig/library.json", "include": ["src/**/*.ts"] }` — if the generated code fails under `exactOptionalPropertyTypes`, add `"compilerOptions": { "exactOptionalPropertyTypes": false }` to this one tsconfig and record the ruling in the ledger (fact sheet open question 2). `packages/client/vitest.config.ts`: `defineProject({ test: { name: 'client', include: ['src/**/*.test.ts'] } })`. Repository configuration: `vitest.config.ts` adds `'packages/client'` to `projects` and `'**/gen/**'` to `coverage.exclude`; `knip.ts` adds `'packages/client': { project: ['src/**/*.ts'], ignore: ['src/gen/**'] }` and `'tools/client-codegen': { entry: ['openapi-ts.config.ts'], project: ['*.ts'] }` (or the `ignoreWorkspaces` form knip prefers for a tool with its own install — follow what knip accepts for `tools/eslint-long-tail`, which is not a workspace of the root manifest); `.oxlintrc.jsonc` `ignorePatterns` gets `"packages/client/src/gen/**"`; `.oxfmtrc.json` ignores the same; `cspell.json` `ignorePaths` gets `packages/client/src/gen/**`; `scripts/license.test.ts` adds `'packages/client/package.json'` to `MIT_MANIFESTS`; `.dependency-cruiser.cjs` `no-orphans` must not flag generated files (they import each other) — add `packages/client/src/gen` to its `pathNot` if it does; `lint:long-tail` (`apps packages plugins scripts`) needs `packages/client/src/gen` ignored in `tools/eslint-long-tail/eslint.config.ts` (`ignores`).

- [ ] **Step 2: Errors and the HTTP wrapper — tests first**

`packages/client/src/errors.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { ApiError } from './errors.js'

describe(ApiError, () => {
  it('tells a problem by its detail and code', () => {
    const error = new ApiError(404, {
      type: 'https://bytebureau.dev/problems/session_not_found',
      title: 'Not Found',
      status: 404,
      detail: 'no session 42',
      code: 'session_not_found',
    })
    expect(error.message).toBe('no session 42 (session_not_found)')
    expect(error.status).toBe(404)
  })

  it('tells an unreachable daemon by its url and an unknown answer by its status', () => {
    expect(new ApiError(0, undefined, 'http://127.0.0.1:1/api/v1/health').message).toBe(
      'cannot reach the daemon at http://127.0.0.1:1/api/v1/health',
    )
    expect(new ApiError(502, undefined).message).toBe('the daemon answered 502')
  })
})
```

`packages/client/src/errors.ts`:
```ts
import type { Problem } from '@bytebureau/protocol'

const messageOf = (status: number, problem: Problem | undefined, url: string | undefined): string => {
  if (problem !== undefined) {
    return `${problem.detail} (${problem.code})`
  }
  return status === 0 ? `cannot reach the daemon at ${url ?? 'an unknown url'}` : `the daemon answered ${status}`
}

// What the daemon said no with: a problem, a bare status, or nothing at all because it could not be reached (status 0)
export class ApiError extends Error {
  public override readonly name = 'ApiError'
  public readonly status: number
  public readonly problem: Problem | undefined
  public readonly url: string | undefined

  public constructor(status: number, problem: Problem | undefined, url?: string) {
    super(messageOf(status, problem, url))
    this.status = status
    this.problem = problem
    this.url = url
  }
}

export const isProblem = (value: unknown): value is Problem =>
  typeof value === 'object' && value !== null && 'code' in value && 'status' in value && 'detail' in value
```

`packages/client/src/http.ts` — the wrapper over the generated SDK (names of the generated functions as `sdk.gen.ts` exports them; the shape below uses the hey-api result convention `{ data, error, response }`):
```ts
import type {
  AskAnswer, AskRecord, CreateSessionBody, HealthDto, PluginStatusDto, ProjectDto, PromptInput, ProviderDto,
  PruneReportDto, SessionDto, SessionUsageDto, TurnDto, WorkspaceInfoDto,
} from '@bytebureau/protocol'
import { client } from './gen/client.gen.js'
import * as sdk from './gen/sdk.gen.js'
import { ApiError, isProblem } from './errors.js'

export interface HttpOptions {
  readonly baseUrl: string
  readonly token: string
  readonly fetch?: typeof fetch | undefined
}

interface Answer<Data> {
  readonly data?: Data | undefined
  readonly error?: unknown
  readonly response: Response
}

// A problem is thrown as an ApiError; a connection failure becomes an ApiError with status 0 and the url
const unwrap = async <Data>(url: string, call: () => Promise<Answer<Data>>): Promise<Data> => {
  let answer: Answer<Data>
  try {
    answer = await call()
  } catch (cause) {
    throw new ApiError(0, undefined, url, { cause })
  }
  if (answer.response.ok) {
    return answer.data as Data
  }
  throw new ApiError(answer.response.status, isProblem(answer.error) ? answer.error : undefined, url)
}

// A lookup the daemon answers 404 to is nothing, not a failure
const optional = async <Data>(lookup: Promise<Data>): Promise<Data | undefined> => {
  try {
    return await lookup
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return undefined
    }
    throw error
  }
}

export const configureClient = ({ baseUrl, token, fetch: fetchImpl }: HttpOptions): void => {
  client.setConfig({ baseUrl, auth: () => token, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) })
}
```
The `as Data` is the one cast the lint will refuse; replace it with a guard (`if (answer.data === undefined) throw new ApiError(answer.response.status, undefined, url)` — a `204` carries no data and its callers return `void`, so route the no-content calls through a `done()` variant that ignores `data`). `ApiError` takes an options object as a fourth argument only if the class is given one (`super(message, { cause })`); add it. The resource objects (`projects`, `sessions`, …) are built in `index.ts` from `unwrap`/`optional` and the SDK functions, e.g. `list: () => unwrap(`${baseUrl}/api/v1/projects`, () => sdk.projectsList())`, `register: (body) => unwrap(url, () => sdk.projectsRegister({ body }))`, `get: (id) => optional(unwrap(url, () => sdk.projectsGet({ path: { id } })))`. `workspaces.prune(projectId?)` always sends a JSON body (`{}` when no project is given — the endpoint requires one); hey-api's SDK takes `{ path, query, body }` options and returns the `{ data, error, response }` answer; one generated client instance (`client`) is configured by `configureClient`, so `createBureauClient` is effectively a singleton per process — acceptable for the CLI; a later consumer that needs two daemons at once uses `createClient` from `gen/client` (note it in the index JSDoc).

- [ ] **Step 3: The SSE subscription — test first**

`packages/client/src/sse.test.ts` (a `node:http` server that plays the daemon):
```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, onTestFinished } from 'vitest'
import { ApiError } from './errors.js'
import { subscribeEvents } from './sse.js'

const frame = (seq: number, type: string): string =>
  `${seq === 0 ? '' : `id: ${seq}\n`}event: ${type}\ndata: ${JSON.stringify({ seq, id: `e${seq}`, ts: 't', type, payload: {} })}\n\n`

interface Served {
  readonly url: string
  readonly requests: { readonly lastEventId: string | undefined; readonly authorization: string | undefined }[]
}

// Each connection gets what the script says for its turn, then the server ends the response
const serve = async (script: ((response: ServerResponse, turn: number) => void)[]): Promise<Served> => {
  const requests: Served['requests'] = []
  let turn = 0
  const server: Server = createServer((request: IncomingMessage, response) => {
    requests.push({ lastEventId: request.headers['last-event-id']?.toString(), authorization: request.headers.authorization })
    const step = script[Math.min(turn, script.length - 1)]
    turn += 1
    if (step !== undefined) {
      step(response, turn)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, requests }
}

const sse = (response: ServerResponse, body: string, end = true): void => {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(body)
  if (end) {
    response.end()
  }
}

describe(subscribeEvents, () => {
  it('yields the events, resumes with the last id after the server closes, and sends the bearer token', async () => {
    const served = await serve([
      (response) => sse(response, frame(1, 'session.created') + frame(0, 'message.assistant.delta') + frame(2, 'turn.started')),
      (response) => sse(response, frame(3, 'turn.completed')),
    ])
    const seen: number[] = []
    for await (const event of subscribeEvents({ baseUrl: served.url, token: 'tok', filter: { since: 0 }, backoffMs: 10 })) {
      seen.push(event.seq)
      if (event.seq === 3) {
        break
      }
    }
    expect(seen).toStrictEqual([1, 0, 2, 3])
    expect(served.requests.map((request) => request.lastEventId)).toStrictEqual([undefined, '2'])
    expect(served.requests[0]?.authorization).toBe('Bearer tok')
  })

  it('drops ephemeral events when the filter says ephemeral: false', async () => {
    const served = await serve([(response) => sse(response, frame(1, 'a') + frame(0, 'heartbeat') + frame(2, 'b'))])
    const seen: number[] = []
    for await (const event of subscribeEvents({ baseUrl: served.url, token: 'tok', filter: { since: 0, ephemeral: false }, backoffMs: 10 })) {
      seen.push(event.seq)
      if (event.seq === 2) {
        break
      }
    }
    expect(seen).toStrictEqual([1, 2])
  })

  it('stops with an ApiError on 401 and gives up once reconnecting fails for longer than retryFor', async () => {
    const denied = await serve([(response) => { response.writeHead(401).end() }])
    await expect(async () => {
      for await (const _event of subscribeEvents({ baseUrl: denied.url, token: 'bad', filter: {} })) {
        // Nothing arrives
      }
    }).rejects.toBeInstanceOf(ApiError)
    const gone = await serve([(response) => { response.destroy() }])
    const started = Date.now()
    await expect(async () => {
      for await (const _event of subscribeEvents({ baseUrl: gone.url, token: 'tok', filter: {}, backoffMs: 10, retryFor: 300 })) {
        // Nothing arrives
      }
    }).rejects.toMatchObject({ status: 0 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
  })

  it('ends quietly when the signal aborts', async () => {
    const served = await serve([(response) => sse(response, frame(1, 'a'), false)])
    const controller = new AbortController()
    const seen: number[] = []
    for await (const event of subscribeEvents({ baseUrl: served.url, token: 'tok', filter: {}, signal: controller.signal })) {
      seen.push(event.seq)
      controller.abort()
    }
    expect(seen).toStrictEqual([1])
  })
})
```
The `?.` reads and the `as AddressInfo` cast need their lint-friendly forms (a helper that throws when the address is not an object). The test file will cross 300 lines once written that way; split the server fixture into `sse-fixture.ts`.

`packages/client/src/sse.ts`:
```ts
import type { EventEnvelope, EventsFilter } from '@bytebureau/protocol'
import { EventSourceParserStream } from 'eventsource-parser/stream'
import { ApiError } from './errors.js'

export interface SubscribeOptions {
  readonly baseUrl: string
  readonly token: string
  readonly filter: EventsFilter
  readonly signal?: AbortSignal | undefined
  readonly fetch?: typeof fetch | undefined
  // The first pause before a reconnect; it doubles up to 30 s
  readonly backoffMs?: number | undefined
  // How long reconnecting may keep failing before the subscription gives up
  readonly retryFor?: number | undefined
}

const MAX_BACKOFF_MS = 30_000

const queryOf = (filter: EventsFilter, since: number | undefined): string => {
  const params = new URLSearchParams()
  if (since !== undefined) {
    params.set('since', String(since))
  }
  if (filter.sessionId !== undefined) {
    params.set('session', filter.sessionId)
  }
  if (filter.projectId !== undefined) {
    params.set('project', filter.projectId)
  }
  if (filter.types !== undefined && filter.types.length > 0) {
    params.set('types', filter.types.join(','))
  }
  const text = params.toString()
  return text === '' ? '' : `?${text}`
}

const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })

// One connection: the frames it carries, as envelopes; ends when the server ends it
async function* connection(url: string, options: SubscribeOptions, since: number | undefined): AsyncGenerator<EventEnvelope> {
  const fetchImpl = options.fetch ?? fetch
  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${options.token}`,
      accept: 'text/event-stream',
      ...(since === undefined ? {} : { 'last-event-id': String(since) }),
    },
    signal: options.signal,
  })
  if (response.status === 401 || response.status === 403) {
    throw new ApiError(response.status, undefined, url)
  }
  if (!response.ok || response.body === null) {
    throw new Error(`http ${response.status}`)
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).getReader()
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    const parsed: unknown = JSON.parse(read.value.data)
    yield parsed as EventEnvelope
  }
}

// The events of the daemon from since on, resumed after every end of the connection until the signal aborts or reconnecting keeps failing
export async function* subscribeEvents(options: SubscribeOptions): AsyncGenerator<EventEnvelope> {
  const { signal } = options
  let since = options.filter.since
  let backoff = options.backoffMs ?? 500
  let failingSince: number | undefined
  while (signal === undefined || !signal.aborted) {
    const url = `${options.baseUrl}/api/v1/events${queryOf(options.filter, since)}`
    try {
      for await (const event of connection(url, options, since)) {
        failingSince = undefined
        backoff = options.backoffMs ?? 500
        if (event.seq !== 0) {
          since = event.seq
        }
        if (options.filter.ephemeral !== false || event.seq !== 0) {
          yield event
        }
      }
    } catch (error) {
      if (signal?.aborted === true) {
        return
      }
      if (error instanceof ApiError) {
        throw error
      }
      failingSince ??= Date.now()
      if (Date.now() - failingSince > (options.retryFor ?? 30_000)) {
        throw new ApiError(0, undefined, url, { cause: error })
      }
    }
    await sleep(backoff, signal)
    backoff = Math.min(MAX_BACKOFF_MS, backoff * 2)
  }
}
```
Replace `yield parsed as EventEnvelope` with a decode through the protocol's `EventEnvelope` schema? The client has no Effect: write a small structural guard (`isEnvelope(value)`: `seq` number, `id`, `ts`, `type` strings) and skip a frame that fails it. The `?.` calls become `if` statements. A `heartbeat` frame is an envelope of type `heartbeat` and is yielded like any other (consumers that want liveness read it; `ephemeral: false` drops it).

- [ ] **Step 4: The RPC codec and connection — codec test first**

`packages/client/src/rpc/codec.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { decodeFrame, encodeAck, encodeInterrupt, encodePing, encodeRequest } from './codec.js'

describe('the RPC envelopes', () => {
  it('encodes a request with the token in its headers', () => {
    expect(JSON.parse(encodeRequest('1', 'projects.register', { path: '/r' }, 'tok'))).toStrictEqual({
      _tag: 'Request',
      id: '1',
      tag: 'projects.register',
      payload: { path: '/r' },
      headers: [['authorization', 'Bearer tok']],
    })
    expect(JSON.parse(encodeAck('1'))).toStrictEqual({ _tag: 'Ack', requestId: '1' })
    expect(JSON.parse(encodeInterrupt('1'))).toStrictEqual({ _tag: 'Interrupt', requestId: '1' })
    expect(JSON.parse(encodePing())).toStrictEqual({ _tag: 'Ping' })
  })

  it('decodes one message or a batch per frame and ignores what is not an envelope', () => {
    const exit = { _tag: 'Exit', requestId: '1', exit: { _tag: 'Success', value: 'echo:hi' } }
    const chunk = { _tag: 'Chunk', requestId: '2', values: [1, 2, 3] }
    expect(decodeFrame(JSON.stringify(exit))).toStrictEqual([exit])
    expect(decodeFrame(JSON.stringify([chunk, { _tag: 'Pong' }]))).toStrictEqual([chunk, { _tag: 'Pong' }])
    expect(decodeFrame('{"nope":1}')).toStrictEqual([])
  })
})
```
`packages/client/src/rpc/codec.ts`:
```ts
export interface ChunkMessage { readonly _tag: 'Chunk'; readonly requestId: string | number; readonly values: readonly unknown[] }
export interface ExitMessage {
  readonly _tag: 'Exit'
  readonly requestId: string | number
  readonly exit:
    | { readonly _tag: 'Success'; readonly value: unknown }
    | { readonly _tag: 'Failure'; readonly cause: readonly { readonly _tag: string; readonly error?: unknown; readonly defect?: unknown }[] }
}
export interface DefectMessage { readonly _tag: 'Defect'; readonly defect: unknown }
export interface PongMessage { readonly _tag: 'Pong' }
export interface OtherMessage { readonly _tag: string }
export type ServerMessage = ChunkMessage | ExitMessage | DefectMessage | PongMessage | OtherMessage

const isTagged = (value: unknown): value is OtherMessage =>
  typeof value === 'object' && value !== null && '_tag' in value && typeof Reflect.get(value, '_tag') === 'string'

// A frame holds one message or a batch of them; anything else is noise the connection ignores
export const decodeFrame = (text: string): ServerMessage[] => {
  const parsed: unknown = JSON.parse(text)
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((item) => isTagged(item))
}

export const encodeRequest = (id: string, tag: string, payload: unknown, token: string): string =>
  JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [['authorization', `Bearer ${token}`]] })
export const encodeAck = (requestId: string): string => JSON.stringify({ _tag: 'Ack', requestId })
export const encodeInterrupt = (requestId: string): string => JSON.stringify({ _tag: 'Interrupt', requestId })
export const encodePing = (): string => JSON.stringify({ _tag: 'Ping' })
```
`packages/client/src/rpc/connection.ts`:
```ts
import { ApiError, isProblem } from '../errors.js'
import { decodeFrame, encodeAck, encodeInterrupt, encodePing, encodeRequest, type ExitMessage, type ServerMessage } from './codec.js'

export interface RpcOptions {
  readonly url: string
  readonly token: string
  readonly WebSocket?: typeof WebSocket | undefined
  readonly pingMs?: number | undefined
}

export interface RpcConnection {
  readonly call: <Value>(tag: string, payload: unknown) => Promise<Value>
  readonly stream: <Value>(tag: string, payload: unknown, signal?: AbortSignal) => AsyncIterable<Value>
  readonly close: () => void
}

interface Pending {
  readonly onMessage: (message: ServerMessage) => void
}

// The failure of an Exit as an error: a Problem the daemon said no with, or what else ended the request
const errorOf = (exit: ExitMessage['exit'], url: string): Error => {
  if (exit._tag === 'Success') {
    return new Error('not a failure')
  }
  const failure = exit.cause.find((part) => part._tag === 'Fail')
  if (failure !== undefined && isProblem(failure.error)) {
    return new ApiError(failure.error.status, failure.error, url)
  }
  const interrupted = exit.cause.some((part) => part._tag === 'Interrupt')
  return new Error(interrupted ? 'the request was interrupted' : 'the daemon failed with a defect')
}

export async function connectRpc(options: RpcOptions): Promise<RpcConnection> {
  const Socket = options.WebSocket ?? WebSocket
  const socket = new Socket(options.url)
  const pending = new Map<string, Pending>()
  let nextId = 0
  socket.addEventListener('message', (event) => {
    for (const message of decodeFrame(String(event.data))) {
      const requestId = Reflect.get(message, 'requestId')
      const waiter = typeof requestId === 'string' || typeof requestId === 'number' ? pending.get(String(requestId)) : undefined
      waiter?.onMessage(message)
    }
  })
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new ApiError(0, undefined, options.url)), { once: true })
  })
  const ping = setInterval(() => socket.send(encodePing()), options.pingMs ?? 30_000)
  const send = (text: string): void => socket.send(text)
  return {
    call: (tag, payload) => new Promise((resolve, reject) => {
      const id = String((nextId += 1))
      pending.set(id, { onMessage: (message) => {
        if (message._tag !== 'Exit') { return }
        pending.delete(id)
        const { exit } = message as ExitMessage
        if (exit._tag === 'Success') { resolve(exit.value as never) } else { reject(errorOf(exit, options.url)) }
      } })
      send(encodeRequest(id, tag, payload, options.token))
    }),
    stream: (tag, payload, signal) => streamOf(send, pending, String((nextId += 1)), tag, payload, options, signal),
    close: () => { clearInterval(ping); socket.close() },
  }
}
```
`streamOf` (same file or `stream.ts`) returns an async generator: it registers a `Pending` whose `onMessage` pushes a `Chunk`'s values into a queue (and `send(encodeAck(id))` right away), resolves the end on `Exit` (or rejects with `errorOf`), sends `encodeInterrupt(id)` when `signal` aborts, and yields from the queue until the end. The `as ExitMessage` / `as never` casts are refused by the lint: narrow with a type guard on `_tag` and give `call` a generic parameter the caller supplies (`call<ProjectDto>(...)`), returning `exit.value` through a guard function the caller passes or through `unknown`. `?.` becomes `if`.

- [ ] **Step 5: The index and the integration tests against the daemon**

`packages/client/src/index.ts` builds `createBureauClient(options)` from `configureClient`, the resource objects of Step 2, `events.subscribe(filter, { signal }) → subscribeEvents({ ...options, filter, signal, retryFor })`, `rpc.connect() → connectRpc({ url: options.baseUrl.replace(/^http/u, 'ws') + '/api/v1/ws', token })` and `close()` (a no-op for fetch; closes nothing the caller did not open). It exports `BureauClient`, `ClientOptions { baseUrl, token, fetch?, retryFor? }`, `ApiError`, `subscribeEvents`, `connectRpc`, `RpcConnection`.

`packages/api/src/client.test.ts` (criterion 9: the client round-trips every endpoint; `@bytebureau/client` is a devDependency of `packages/api`):
```ts
import { createTempRepo, writeConfig } from '@bytebureau/kernel/testing'
import { ApiError, createBureauClient } from '@bytebureau/client'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { describe, expect } from 'vitest'
import { ApiTestLayer, baseUrl, TEST_TOKEN } from './testing.js'
import { fakeProjectConfig, firstEvent } from './testing-sessions.js'

describe('@bytebureau/client against the API', () => {
  it.layer(ApiTestLayer())('round-trips every endpoint', (it) => {
    it.effect('projects, sessions, asks, usage, workspaces, plugins and health', () =>
      Effect.gen(function* roundTrips() {
        const client = createBureauClient({ baseUrl: yield* baseUrl, token: TEST_TOKEN })
        const repo = createTempRepo()
        writeConfig(repo, fakeProjectConfig)
        const project = yield* Effect.promise(() => client.projects.register(repo))
        expect(yield* Effect.promise(() => client.projects.list())).toMatchObject([{ id: project.id }])
        expect(yield* Effect.promise(() => client.projects.get(project.id))).toMatchObject({ path: repo })
        expect(yield* Effect.promise(() => client.projects.get('0192f0a0-0000-7000-8000-000000000009'))).toBeUndefined()
        const session = yield* Effect.promise(() => client.sessions.create({ projectId: project.id, title: 'Create hello' }))
        expect(session.status).toBe('ready')
        const turn = yield* Effect.promise(() => client.sessions.prompt(session.id, { text: 'go' }))
        expect(turn.index).toBe(0)
        yield* firstEvent(session.id, 'ask.requested')
        const [ask] = yield* Effect.promise(() => client.asks.pending(session.id))
        if (ask === undefined) { throw new Error('no ask') }
        const recommended = ask.questions.flatMap((question) => question.options).find((option) => option.recommended)
        if (recommended === undefined) { throw new Error('no recommended option') }
        yield* Effect.promise(() => client.asks.answer(ask.id, { selected: [recommended.id] }))
        expect(yield* Effect.promise(() => client.asks.get(ask.id))).toMatchObject({ status: 'answered' })
        yield* firstEvent(session.id, 'turn.completed')
        yield* Effect.promise(() => client.sessions.complete(session.id))
        expect(yield* Effect.promise(() => client.sessions.get(session.id))).toMatchObject({ status: 'completed' })
        expect(yield* Effect.promise(() => client.usage.session(session.id))).toMatchObject({ turns: 1 })
        expect(yield* Effect.promise(() => client.workspaces.list(project.id))).toMatchObject([{ sessionId: session.id }])
        expect(yield* Effect.promise(() => client.workspaces.prune(project.id))).toMatchObject({ removed: [] })
        expect((yield* Effect.promise(() => client.plugins.list())).map((plugin) => plugin.state)).toStrictEqual(['loaded', 'loaded'])
        expect(yield* Effect.promise(() => client.plugins.providers())).toMatchObject([{ id: 'fake' }])
        expect(yield* Effect.promise(() => client.health.check())).toMatchObject({ status: 'ok' })
        yield* Effect.promise(() => client.sessions.resume(session.id))
        yield* Effect.promise(() => client.sessions.stop(session.id))
        yield* Effect.promise(() => client.sessions.resume(session.id))
        yield* Effect.promise(() => client.sessions.interrupt(session.id)).pipe(Effect.ignore)
        const refused = yield* Effect.promise(() => client.sessions.prompt('0192f0a0-0000-7000-8000-000000000009', { text: 'x' }).catch((error: unknown) => error))
        expect(refused).toBeInstanceOf(ApiError)
        expect(refused).toMatchObject({ status: 404, problem: { code: 'session_not_found' } })
        yield* Effect.promise(() => client.projects.remove(project.id)).pipe(Effect.ignore)
      }),
    )
  })
})
```
`interrupt` on a `ready` session and `remove` of a project with sessions are refusals the test ignores on purpose: the point is that every method is wired; `sessions.test.ts` of Task 4 asserts their semantics.

`packages/api/src/client-events.test.ts`: over `ApiTestLayer(home, { heartbeat: '100 millis' })`, `client.events.subscribe({ sessionId, since: 0 }, { signal })` yields the durable events of a created session in seq order and then a live `turn.started` after a prompt; a second subscription with `{ ephemeral: false }` yields no `heartbeat`; `client.rpc.connect()` then `call('projects.register', { path })` resolves with the project, `stream('events.subscribe', { sessionId, since: 0 }, signal)` yields `session.created` first and ends when the signal aborts, `call` without a valid token (a second `connectRpc` with `token: 'bad'`) rejects with `ApiError` 401.

- [ ] **Step 6: Run everything**

Run: `bun run build && bun run generate:client && git diff --exit-code -- packages/client/src/gen && bunx vitest run --project client --project api && bun run typecheck && bun run lint && bun run format:check && bun run knip && bun run depcruise && bun run spell && bun run lint:long-tail`
Expected: PASS. The generated code is excluded from the linters and from coverage; the hand-written modules keep the thresholds (`sse.ts`, `errors.ts`, `rpc/codec.ts` have unit tests; `http.ts`, `rpc/connection.ts`, `index.ts` are covered through the api tests, which run in the api project — coverage is collected per root run, so they count).

- [ ] **Step 7: Commit**

```bash
git add tools/client-codegen packages/client packages/api package.json vitest.config.ts knip.ts .oxlintrc.jsonc .oxfmtrc.json cspell.json scripts/license.test.ts tools/eslint-long-tail/eslint.config.ts bun.lock
git commit -m "feat(client): add the generated API client with an SSE subscription and an RPC connection"
```

### Task 8: The daemon — `startDaemon` on Bun, `server.json`, `bytebureau serve [--host --port --no-daemonize --stop]`

**Files:**
- Create: `packages/api/src/bun.ts`, `packages/api/src/bun-address.ts`, `packages/api/src/bun-address.test.ts`, `apps/bytebureau/src/daemon/server-info.ts`, `apps/bytebureau/src/daemon/server-info.test.ts`, `apps/bytebureau/src/daemon/token.ts`, `apps/bytebureau/src/daemon/token.test.ts`, `apps/bytebureau/src/daemon/exec-args.ts`, `apps/bytebureau/src/daemon/exec-args.test.ts`, `apps/bytebureau/src/daemon/spawn.ts`, `apps/bytebureau/src/daemon/wait.ts`, `apps/bytebureau/src/daemon/stop.ts`, `apps/bytebureau/src/daemon/foreground.ts`, `apps/bytebureau/src/commands/serve.ts`, `apps/bytebureau/src/testing/daemon.ts`, `apps/bytebureau/src/commands/serve.test.ts`
- Modify: `packages/api/package.json` (`./bun` export), `apps/bytebureau/package.json` (`@bytebureau/api` dependency), `apps/bytebureau/src/main.ts` (`serve` command), `packages/i18n/messages/en.json` + `cs.json` (new keys), `vitest.config.ts` (coverage include for the daemon modules), `.oxlintrc.jsonc` if `packages/api/src/bun.ts` needs the `no-console` override (it does not: it logs through LogTape)

**Interfaces:**
- Consumes: `kernelBunLayer` (`@bytebureau/kernel/bun`, Task 2), `serveApi`, `DEFAULT_API_OPTIONS` (Task 3), `PluginHost`, `SessionManager`, `Config`, `nowIso`, `kernelLogger` (kernel), `BunHttpServer` (`@effect/platform-bun`), `ServerInfo`, `decodeServerInfo`, `serverUrl` (protocol), `kernelHome` and the CLI `Context`/`Output`.
- Produces: `startDaemon(options: DaemonOptions): Promise<RunningDaemon>` from `@bytebureau/api/bun`; `readServerInfo(home)`, `writeServerInfo(home, info)`, `removeServerInfo(home)`, `isAlive(pid)`, `serverInfoPath(home)`; `freshToken()`, `tokenFor(home)`; `daemonExecArgs(process, extra)`; `spawnDaemon(home, env, extra)`, `waitForDaemon(home, timeoutMs)`; `stopDaemon(home)`; `serveForeground(options)`; the `serve` command; for tests `startDaemonProcess(home)`.

Verified facts this task relies on (fact sheet §1, §4.3, §8): `@effect/platform-bun@4.0.0` `BunHttpServer.layer({ hostname, port })` provides `HttpServer | HttpPlatform | Etag.Generator | BunServices`; `HttpServer.addressFormattedWith(f)` reads the bound address (port 0 becomes the real port); on Bun 1.4.2 `child_process.spawn(cmd, args, { detached: true, stdio: ['ignore', 'ignore', fd] })` plus `child.unref()` leaves a child in its own process group that outlives the parent (verified on 2026-10-04 on the owner's machine: the child kept running after the parent exited, `pgid` equal to its own pid); `process.kill(pid, 0)` throws `ESRCH` for a dead pid and `EPERM` for a live one of another user; `crypto.randomBytes(32).toString('hex')` is a 64-character token; `process.execPath` is the compiled binary when the CLI runs compiled and the `bun` executable when it runs from source (`process.argv[1]` then names the script).

Semantics: **`startDaemon`** (Effect, in `packages/api` so that `apps/bytebureau` imports no Effect, ADR-0003) composes `serveApi(options)` over `BunHttpServer.layer({ hostname, port })` over `kernelBunLayer(...)`, builds the runtime, loads the plugins, runs the recovery of Task 2, and returns the bound address and a `close()` that disposes the runtime (which stops the server, the agents and the store). The host and port come from the flags, else the user configuration's `server.host`/`server.port` (read through the kernel's `Config` so that one loader serves both), else `127.0.0.1` and `4747`. **`server.json`** — `<home>/server.json`, mode 0600, holds `ServerInfo` (`version`, `host`, `port`, `pid`, `token`, `startedAt`); it is written after the server is bound (so the port is the real one) by an atomic rename of a temp file, and removed when the daemon ends; a file whose `pid` is not alive is stale and is replaced. The token is generated at the first start and kept across restarts (spec §11.1 "generated on first start"), so a client that read it keeps working. **`serve`** — by default starts the daemon detached (the same executable with `serve --no-daemonize` and the same flags, stdin and stdout ignored, stderr appended to `<home>/logs/daemon.log`), waits up to ten seconds for `server.json` and a healthy `/api/v1/health`, prints the URL and exits 0; `--no-daemonize` runs in the foreground until `SIGINT`, `SIGTERM` or `SIGHUP`, then stops the sessions and removes `server.json`; `--stop` sends `SIGTERM` to the pid of `server.json` and waits up to five seconds for it to end; a second daemon on the same home is refused with exit 1 and the pid of the running one (one writer per store, ADR-0010); `--host` other than a loopback address prints the LAN warning of spec §11.1. `--json` prints one record `{ command: 'serve', url, pid, version }` on stdout.

- [ ] **Step 1: `startDaemon` in `packages/api`**

`packages/api/package.json` exports gain `"./bun": { "types": "./src/bun.ts", "default": "./src/bun.ts" }`.

`packages/api/src/bun-address.ts`:
```ts
export interface BoundAddress {
  readonly host: string
  readonly port: number
}

// The host and port of the address the platform prints, with or without a scheme; an IPv6 host loses its brackets
export const boundAddress = (formatted: string): BoundAddress => {
  const url = new URL(formatted.startsWith('http') ? formatted : `http://${formatted}`)
  return { host: url.hostname.replace(/^\[|\]$/gu, ''), port: Number(url.port) }
}
```
`packages/api/src/bun-address.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { boundAddress } from './bun-address.js'

describe(boundAddress, () => {
  it('reads host and port from a URL and from a bare address', () => {
    expect(boundAddress('http://127.0.0.1:4747')).toStrictEqual({ host: '127.0.0.1', port: 4747 })
    expect(boundAddress('127.0.0.1:51234')).toStrictEqual({ host: '127.0.0.1', port: 51234 })
    expect(boundAddress('http://[::1]:4747')).toStrictEqual({ host: '::1', port: 4747 })
  })
})
```

`packages/api/src/bun.ts`:
```ts
import { kernelBunLayer, type KernelOptions } from '@bytebureau/kernel/bun'
import { Config, nowIso, PluginHost, SessionManager, kernelLogger } from '@bytebureau/kernel'
import { BunHttpServer } from '@effect/platform-bun'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'
import { HttpServer } from 'effect/http'
import { boundAddress, type BoundAddress } from './bun-address.js'
import { DEFAULT_API_OPTIONS } from './config.js'
import { serveApi } from './layer.js'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 4747
const MAX_BODY_BYTES = 10 * 1024 * 1024

// Bun's own knobs (fact sheet §1.6–1.9, §4.3): the hostname must be passed (Bun binds every interface otherwise), its 10 s idle timeout would cut an SSE stream,
// maxRequestBodySize is the body limit that holds on Bun, open streams must not delay a shutdown by the 20 s default, and a WebSocket client that stops reading is closed instead of buffered without bound
const serveOptions = (hostname: string, port: number) => ({
  hostname,
  port,
  idleTimeout: 60,
  maxRequestBodySize: MAX_BODY_BYTES,
  gracefulShutdownTimeout: '2 seconds',
  websocket: { closeOnBackpressureLimit: true, backpressureLimit: 1024 * 1024 },
})

export interface DaemonOptions extends KernelOptions {
  readonly version: string
  // Plain text here: the CLI that passes it imports no Effect; it is wrapped in Redacted at once
  readonly token: string
  // Flags win; what is absent comes from the user configuration, then the defaults
  readonly host?: string | undefined
  readonly port?: number | undefined
  readonly corsOrigins?: readonly string[] | undefined
}

export interface RunningDaemon {
  readonly address: BoundAddress
  readonly startedAt: string
  readonly close: () => Promise<void>
}

// The server section of the user configuration, empty when the configuration cannot be read (the kernel logs why)
const configuredServer = (
  options: DaemonOptions,
): Effect.Effect<{ readonly host?: string | undefined; readonly port?: number | undefined }, never, Config> =>
  Config.use((config) => config.load({ env: options.env })).pipe(
    Effect.map((resolved) => resolved.user.server ?? {}),
    Effect.catch(() => Effect.succeed({})),
  )

const logger = kernelLogger(['bb', 'api'])

// The kernel, the API and the Bun server as one layer; the plugins load and the sessions of a previous process are recovered before the address is given out
export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const kernel = await kernelBunLayer(options)
  const startedAt = nowIso()
  const configured = await Effect.runPromise(configuredServer(options).pipe(Effect.provide(kernel)))
  const hostname = options.host ?? configured.host ?? DEFAULT_HOST
  const port = options.port ?? configured.port ?? DEFAULT_PORT
  const api = serveApi({
    ...DEFAULT_API_OPTIONS,
    version: options.version,
    startedAt,
    token: Redacted.make(options.token),
    corsOrigins: options.corsOrigins ?? DEFAULT_API_OPTIONS.corsOrigins,
  })
  const runtime = ManagedRuntime.make(
    api.pipe(Layer.provideMerge(BunHttpServer.layer(serveOptions(hostname, port))), Layer.provideMerge(kernel)),
  )
  try {
    await runtime.runPromise(PluginHost.use((host) => host.load()))
    const recovered = await runtime.runPromise(SessionManager.use((sessions) => sessions.recover()))
    if (recovered.length > 0) {
      logger.info('recovered sessions left by a previous process', { sessions: recovered })
    }
    const formatted = await runtime.runPromise(HttpServer.addressFormattedWith((address) => Effect.succeed(address)))
    return { address: boundAddress(formatted), startedAt, close: () => runtime.dispose() }
  } catch (error) {
    await Promise.allSettled([runtime.dispose()])
    throw portInUse(error, port) ?? error
  }
}
```
A port that is taken surfaces from `Bun.serve` as a defect, not as `ServeError` (fact sheet §1.9): `portInUse(error, port)` reads the message of the cause for `EADDRINUSE` or "Is port" and returns `new Error(`port ${port} is already in use`)` for it, `undefined` otherwise, so `serve` can print one line. `configuredServer` runs over a second build of the kernel layer only if `Effect.provide(kernel)` builds it afresh — avoid that: run it inside the same runtime instead (`runtime.runPromise(configuredServer(options))`) and choose host and port before building the server layer by making the server layer depend on an effect: `Layer.unwrap(Effect.map(configuredServer(options), (configured) => BunHttpServer.layer({ hostname: options.host ?? configured.host ?? DEFAULT_HOST, port: options.port ?? configured.port ?? DEFAULT_PORT })))` provided with the kernel. Write it that way; the sketch above only names the pieces. `max-statements` (10) asks for the body of `startDaemon` to be split: `resolveServer`, `buildRuntime`, `announce`. `Effect.catch` is the kernel's import alias of Effect 4's `catch_` (see Task 2).

- [ ] **Step 2: `server.json`, the token, the exec arguments — tests first**

`apps/bytebureau/src/daemon/server-info.test.ts`:
```ts
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../testing/temp-repo.js'
import { acquireLock, isAlive, lockPath, readServerInfo, releaseLock, removeServerInfo, serverInfoPath, writeServerInfo } from './server-info.js'

const info = {
  version: '0.1.0',
  host: '127.0.0.1',
  port: 4747,
  pid: process.pid,
  token: 'a'.repeat(64),
  startedAt: '2026-10-04T10:00:00.000Z',
}

describe('server.json', () => {
  it('is written for the user alone and read back', () => {
    const home = tempDir('bb-home-')
    writeServerInfo(home, info)
    expect(statSync(serverInfoPath(home)).mode & 0o777).toBe(0o600)
    expect(readServerInfo(home)).toStrictEqual({ state: 'alive', info })
    expect(JSON.parse(readFileSync(serverInfoPath(home), 'utf8'))).toStrictEqual(info)
  })

  it('is absent when no daemon ever ran, stale when its pid is gone, and removed on request', () => {
    const home = tempDir('bb-home-')
    expect(readServerInfo(home)).toStrictEqual({ state: 'absent' })
    writeServerInfo(home, { ...info, pid: 2_147_483_000 })
    expect(readServerInfo(home)).toStrictEqual({ state: 'stale', info: { ...info, pid: 2_147_483_000 } })
    removeServerInfo(home)
    expect(existsSync(path.join(home, 'server.json'))).toBe(false)
  })

  it('reports a file that is not a server record as stale with no info', () => {
    const home = tempDir('bb-home-')
    writeServerInfo(home, info)
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(serverInfoPath(home), '{"nope":1}')
    expect(readServerInfo(home)).toStrictEqual({ state: 'stale' })
  })

  it('knows a live pid from a dead one', () => {
    expect(isAlive(process.pid)).toBe(true)
    expect(isAlive(2_147_483_000)).toBe(false)
  })

  it('hands the lock to one holder, names a live holder to the next, and takes over a dead one', () => {
    const home = tempDir('bb-home-')
    expect(acquireLock(home)).toStrictEqual({ acquired: true })
    expect(acquireLock(home)).toStrictEqual({ acquired: false, pid: process.pid })
    releaseLock(home)
    writeFileSync(lockPath(home), '2147483000')
    expect(acquireLock(home)).toStrictEqual({ acquired: true })
    releaseLock(home)
  })
})
```
Import `writeFileSync` at the top instead of the `require` line (it is only there to show intent); the lint refuses `require` and the `as`.

`apps/bytebureau/src/daemon/token.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { tempDir } from '../testing/temp-repo.js'
import { writeServerInfo } from './server-info.js'
import { freshToken, tokenFor } from './token.js'

describe('the daemon token', () => {
  it('is 64 hex characters and differs every time', () => {
    expect(freshToken()).toMatch(/^[0-9a-f]{64}$/u)
    expect(freshToken()).not.toBe(freshToken())
  })

  it('is kept across restarts when server.json still has one, fresh otherwise', () => {
    const home = tempDir('bb-home-')
    const first = tokenFor(home)
    writeServerInfo(home, { version: '0', host: '127.0.0.1', port: 1, pid: 2_147_483_000, token: first, startedAt: 't' })
    expect(tokenFor(home)).toBe(first)
    expect(tokenFor(tempDir('bb-home-'))).not.toBe(first)
  })
})
```

`apps/bytebureau/src/daemon/exec-args.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { daemonExecArgs } from './exec-args.js'

describe(daemonExecArgs, () => {
  it('runs the compiled binary itself with serve --no-daemonize and the flags', () => {
    expect(daemonExecArgs({ execPath: '/opt/bytebureau', argv: ['/opt/bytebureau', 'serve'] }, ['--port', '4747'])).toStrictEqual({
      command: '/opt/bytebureau',
      args: ['serve', '--no-daemonize', '--port', '4747'],
    })
  })

  it('runs the source through bun when the CLI runs from a .ts entry', () => {
    expect(daemonExecArgs({ execPath: '/usr/bin/bun', argv: ['/usr/bin/bun', '/repo/apps/bytebureau/src/main.ts', 'serve'] }, [])).toStrictEqual({
      command: '/usr/bin/bun',
      args: ['run', '/repo/apps/bytebureau/src/main.ts', 'serve', '--no-daemonize'],
    })
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `bunx vitest run --project bytebureau src/daemon`
Expected: FAIL — the modules do not exist.

- [ ] **Step 4: The daemon modules of the CLI**

`apps/bytebureau/src/daemon/server-info.ts`:
```ts
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import path from 'node:path'
import { decodeServerInfo, type ServerInfo } from '@bytebureau/protocol'

export const serverInfoPath = (home: string): string => path.join(home, 'server.json')

export type ServerRecord =
  | { readonly state: 'absent' }
  | { readonly state: 'alive'; readonly info: ServerInfo }
  // The daemon the file names is gone, or the file is not a record at all
  | { readonly state: 'stale'; readonly info?: ServerInfo }

// Signal 0 tests the pid: a dead one throws ESRCH, a live one of another user throws EPERM
export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

const readRecord = (home: string): ServerInfo | undefined => {
  try {
    return decodeServerInfo(JSON.parse(readFileSync(serverInfoPath(home), 'utf8')))
  } catch {
    return undefined
  }
}

const exists = (file: string): boolean => {
  try {
    readFileSync(file)
    return true
  } catch {
    return false
  }
}

export const readServerInfo = (home: string): ServerRecord => {
  if (!exists(serverInfoPath(home))) {
    return { state: 'absent' }
  }
  const info = readRecord(home)
  if (info === undefined) {
    return { state: 'stale' }
  }
  return isAlive(info.pid) ? { state: 'alive', info } : { state: 'stale', info }
}

// Written beside its final name, flushed and renamed into place, so a reader never sees half a record; for the user alone
export const writeServerInfo = (home: string, info: ServerInfo): void => {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const target = serverInfoPath(home)
  const temp = `${target}.${process.pid}.tmp`
  const fd = openSync(temp, 'w', 0o600)
  try {
    writeSync(fd, `${JSON.stringify(info, undefined, 2)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  chmodSync(temp, 0o600)
  renameSync(temp, target)
}

export const lockPath = (home: string): string => path.join(home, 'daemon.lock')

// One daemon per home, decided atomically: the lock file is created exclusively (O_EXCL) with the pid inside; a lock whose pid is dead is stale and is taken over
export const acquireLock = (home: string): { readonly acquired: true } | { readonly acquired: false; readonly pid: number } => {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath(home), 'wx', 0o600)
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return { acquired: true }
    } catch {
      const holder = Number(readFileSync(lockPath(home), 'utf8').trim())
      if (Number.isInteger(holder) && isAlive(holder)) {
        return { acquired: false, pid: holder }
      }
      unlinkSync(lockPath(home))
    }
  }
  return { acquired: false, pid: 0 }
}

export const releaseLock = (home: string): void => {
  try {
    unlinkSync(lockPath(home))
  } catch {
    // Already gone
  }
}

export const removeServerInfo = (home: string): void => {
  try {
    unlinkSync(serverInfoPath(home))
  } catch {
    // Already gone
  }
}
```
Sort the `node:fs` import names as the lint wants (`sort-imports` is off, `import/order` may not be; follow oxfmt).

`apps/bytebureau/src/daemon/token.ts`:
```ts
import { randomBytes } from 'node:crypto'
import { readServerInfo } from './server-info.js'

export const freshToken = (): string => randomBytes(32).toString('hex')

// The token of the home: the one a previous daemon left in server.json, so clients that read it keep working; fresh otherwise
export const tokenFor = (home: string): string => {
  const record = readServerInfo(home)
  return record.state === 'absent' || record.info === undefined ? freshToken() : record.info.token
}
```

`apps/bytebureau/src/daemon/exec-args.ts`:
```ts
export interface ProcessLike {
  readonly execPath: string
  readonly argv: readonly string[]
}

export interface ExecArgs {
  readonly command: string
  readonly args: readonly string[]
}

// The daemon is this very program run again in the foreground: the compiled binary, or bun with the source entry
export const daemonExecArgs = (current: ProcessLike, extra: readonly string[]): ExecArgs => {
  const entry = current.argv[1]
  const fromSource = entry !== undefined && /\.[cm]?[jt]s$/u.test(entry)
  return fromSource
    ? { command: current.execPath, args: ['run', entry, 'serve', '--no-daemonize', ...extra] }
    : { command: current.execPath, args: ['serve', '--no-daemonize', ...extra] }
}
```

`apps/bytebureau/src/daemon/spawn.ts`:
```ts
import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import path from 'node:path'
import { daemonExecArgs } from './exec-args.js'

export const daemonLogPath = (home: string): string => path.join(home, 'logs', 'daemon.log')

// The daemon starts in its own process group with nothing of this terminal: its stderr goes to the log of the home
export const spawnDaemon = (
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  extra: readonly string[],
): number | undefined => {
  mkdirSync(path.dirname(daemonLogPath(home)), { recursive: true, mode: 0o700 })
  const log = openSync(daemonLogPath(home), 'a', 0o600)
  const { command, args } = daemonExecArgs(process, extra)
  const child = spawn(command, args, {
    detached: true,
    // Bun moves a detached child without a cwd to $HOME (Bun issue 44372, one source): the home is as good a place as any
    cwd: home,
    stdio: ['ignore', log, log],
    env: { ...env, BYTEBUREAU_HOME: home },
  })
  child.unref()
  return child.pid
}
```

`apps/bytebureau/src/daemon/wait.ts`:
```ts
import { serverUrl, type ServerInfo } from '@bytebureau/protocol'
import { readServerInfo } from './server-info.js'

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const healthy = async (info: ServerInfo): Promise<boolean> => {
  try {
    const response = await fetch(`${serverUrl(info)}/api/v1/health`, { signal: AbortSignal.timeout(1000) })
    return response.ok
  } catch {
    return false
  }
}

// The daemon is up once server.json names a live pid and its health answers; a daemon that takes longer than the limit is given up on
export const waitForDaemon = async (home: string, timeoutMs = 10_000): Promise<ServerInfo | undefined> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const record = readServerInfo(home)
    if (record.state === 'alive' && (await healthy(record.info))) {
      return record.info
    }
    await sleep(100)
  }
  return undefined
}
```
Note `BYTEBUREAU_HOME` of the child is the resolved home, so a relative `BYTEBUREAU_HOME` of the parent still means the same directory. `await` inside the loop is intended (`no-await-in-loop` is an oxlint rule: disable it for that line with a comment that says why, or write the loop with a recursive helper).

`apps/bytebureau/src/daemon/stop.ts`:
```ts
import { isAlive, readServerInfo, removeServerInfo, type ServerRecord } from './server-info.js'

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export type StopOutcome =
  | { readonly outcome: 'stopped'; readonly pid: number }
  | { readonly outcome: 'not_running' }
  | { readonly outcome: 'still_running'; readonly pid: number }

// SIGTERM lets the daemon end its sessions and remove its record; a stale record is removed here
export const stopDaemon = async (home: string, timeoutMs = 5000): Promise<StopOutcome> => {
  const record: ServerRecord = readServerInfo(home)
  if (record.state !== 'alive') {
    removeServerInfo(home)
    return { outcome: 'not_running' }
  }
  const { pid } = record.info
  process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      removeServerInfo(home)
      return { outcome: 'stopped', pid }
    }
    await sleep(100)
  }
  return { outcome: 'still_running', pid }
}
```

`apps/bytebureau/src/daemon/foreground.ts`:
```ts
import { startDaemon } from '@bytebureau/api/bun'
import { serverUrl, type ServerInfo } from '@bytebureau/protocol'
import type { Context } from '../context.js'
import { version } from '../version.js'
import { acquireLock, releaseLock, removeServerInfo, writeServerInfo } from './server-info.js'
import { tokenFor } from './token.js'

export interface ForegroundOptions {
  readonly home: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly host?: string | undefined
  readonly port?: number | undefined
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

const isLoopback = (host: string): boolean =>
  host === '127.0.0.1' || host === 'localhost' || host === '::1'

// One daemon per home: the lock decides, atomically, and names the pid of the one that holds it
const refusal = (home: string): string | undefined => {
  const lock = acquireLock(home)
  return lock.acquired ? undefined : `a daemon is already running (pid ${lock.pid})`
}

// Runs until a signal arrives; the record exists from the moment the server is bound to the moment it is gone
export async function serveForeground(options: ForegroundOptions, context: Context): Promise<number> {
  const refused = refusal(options.home)
  if (refused !== undefined) {
    context.output.warn(refused)
    return 1
  }
  const token = tokenFor(options.home)
  const daemon = await startDaemon({ ...options, version, token, logging: context.logging })
  const info: ServerInfo = { version, host: daemon.address.host, port: daemon.address.port, pid: process.pid, token, startedAt: daemon.startedAt }
  writeServerInfo(options.home, info)
  announce(info, context)
  await signalled()
  await daemon.close()
  removeServerInfo(options.home)
  releaseLock(options.home)
  return 0
}
```
The lock is released on every way out (a failed `startDaemon` included — wrap the start in `try/finally` around `releaseLock`), and the detached start of `serve` waits for `server.json`, which the daemon writes only once it holds the lock and is bound.
`startDaemon` takes the token as a plain string and wraps it in `Redacted` itself, because the CLI imports no Effect (ADR-0003) — so the call reads `startDaemon({ ...options, version, token, logging: context.logging })`. `announce` prints `listening on <url>` through `context.output.print` (or emits `{ command: 'serve', url, pid, version }` with `--json`) and warns `the daemon listens on <host>: anyone on the network who has the token can use it` when `!isLoopback(host)`. `signalled()` resolves on the first of `SIGNALS` (`process.once` for each). Split the function as `max-statements` asks.

- [ ] **Step 5: The `serve` command and the test helper**

`apps/bytebureau/src/commands/serve.ts`:
```ts
import { m } from '@bytebureau/i18n'
import { serverUrl } from '@bytebureau/protocol'
import { defineCommand } from 'citty'
import { globalArgs, processContext } from '../context.js'
import { serveForeground } from '../daemon/foreground.js'
import { readServerInfo } from '../daemon/server-info.js'
import { spawnDaemon } from '../daemon/spawn.js'
import { stopDaemon } from '../daemon/stop.js'
import { waitForDaemon } from '../daemon/wait.js'
import { kernelHome } from '../kernel-home.js'

export const serveCommand = defineCommand({
  meta: { name: 'serve', description: 'Start the ByteBureau daemon (detached unless --no-daemonize)' },
  args: {
    ...globalArgs,
    host: { type: 'string', description: 'Address to listen on (default: 127.0.0.1 or server.host)' },
    port: { type: 'string', description: 'Port to listen on (default: 4747 or server.port; 0 picks a free one)' },
    daemonize: { type: 'boolean', description: 'Detach; pass --no-daemonize to stay in the foreground', default: true },
    stop: { type: 'boolean', description: 'Stop the running daemon of this home', default: false },
  },
  async run({ args }) {
    const context = processContext(args)
    const home = kernelHome(process.env)
    if (args.stop) {
      process.exitCode = await stop(home, context)
      return
    }
    const port = args.port === undefined ? undefined : Number(args.port)
    if (!args.daemonize) {
      process.exitCode = await serveForeground({ home, env: process.env, host: args.host, port }, context)
      return
    }
    process.exitCode = await detach(home, args, context)
  },
})
```
with the two helpers in the same file: `stop` prints `m.serve_stopped({ pid })` / `m.serve_not_running()` / warns `m.serve_still_running({ pid })` (exit 1); `detach` refuses when `readServerInfo(home).state === 'alive'` (prints `m.serve_already_running({ pid, url })`, exit 0 — a running daemon is what was asked for), else `spawnDaemon(home, process.env, flagsOf(args))` with `--host`/`--port`/`--log-level`/`--debug` carried over, then `waitForDaemon(home)`; success prints `m.serve_started({ url })` (or emits `{ command: 'serve', url, pid, version }`), a timeout warns `m.serve_timeout({ log: daemonLogPath(home) })` and exits 1. Register `serve: serveCommand` in `main.ts`.

New messages (`en.json` / `cs.json`): `serve_started` = "Daemon listening on {url}" / "Démon naslouchá na {url}", `serve_already_running` = "Daemon already running on {url} (pid {pid})" / "Démon už běží na {url} (pid {pid})", `serve_stopped` = "Stopped daemon (pid {pid})" / "Démon zastaven (pid {pid})", `serve_not_running` = "No daemon is running" / "Žádný démon neběží", `serve_still_running` = "Daemon (pid {pid}) did not stop in time" / "Démon (pid {pid}) se včas nezastavil", `serve_timeout` = "The daemon did not come up in time; see {log}" / "Démon se včas nespustil; viz {log}", `serve_lan_warning` = "Listening on {host}: anyone on the network with the token can use this daemon" / "Naslouchá na {host}: kdokoli v síti s tokenem může tohoto démona používat".

`apps/bytebureau/src/testing/daemon.ts`:
```ts
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { serverUrl, type ServerInfo } from '@bytebureau/protocol'
import { onTestFinished } from 'vitest'
import { readServerInfo } from '../daemon/server-info.js'
import { childEnv } from './run-cli.js'

const CLI_DIRECTORY = fileURLToPath(new URL('../..', import.meta.url))

export interface DaemonProcess {
  readonly info: ServerInfo
  readonly url: string
  readonly child: ChildProcess
  readonly stderr: () => string
  readonly stop: () => Promise<number | null>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

// A foreground daemon on a free port in the home; killed when the test ends if it is still there
export async function startDaemonProcess(home: string, extra: readonly string[] = []): Promise<DaemonProcess> {
  const child = spawn('bun', ['run', 'src/main.ts', 'serve', '--no-daemonize', '--port', '0', ...extra], {
    cwd: CLI_DIRECTORY,
    env: childEnv({ BYTEBUREAU_HOME: home }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  onTestFinished(() => { child.kill('SIGKILL') })
  const exited = new Promise<number | null>((resolve) => { child.once('close', (code) => resolve(code)) })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const record = readServerInfo(home)
    if (record.state === 'alive' && record.info.pid === child.pid) {
      return { info: record.info, url: serverUrl(record.info), child, stderr: () => stderr, stop: async () => { child.kill('SIGTERM'); return exited } }
    }
    await sleep(100)
  }
  throw new Error(`the daemon did not write server.json in time: ${stderr}`)
}
```

`apps/bytebureau/src/commands/serve.test.ts`:
```ts
import { existsSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readServerInfo, serverInfoPath } from '../daemon/server-info.js'
import { startDaemonProcess } from '../testing/daemon.js'
import { jsonLines } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import { tempDir } from '../testing/temp-repo.js'

describe('bytebureau serve --no-daemonize', () => {
  it('writes server.json for the user alone, answers health with and without the token, and cleans up on SIGTERM', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const daemon = await startDaemonProcess(home)
    expect(statSync(serverInfoPath(home)).mode & 0o777).toBe(0o600)
    expect(daemon.info.token).toMatch(/^[0-9a-f]{64}$/u)
    expect(daemon.info.host).toBe('127.0.0.1')
    const health = await fetch(`${daemon.url}/api/v1/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ status: 'ok' })
    const denied = await fetch(`${daemon.url}/api/v1/projects`)
    expect(denied.status).toBe(401)
    const allowed = await fetch(`${daemon.url}/api/v1/projects`, { headers: { authorization: `Bearer ${daemon.info.token}` } })
    expect(await allowed.json()).toStrictEqual([])
    expect(await daemon.stop()).toBe(0)
    expect(existsSync(serverInfoPath(home))).toBe(false)
  })

  it('refuses a second daemon on the same home with exit 1 and the pid of the first', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const daemon = await startDaemonProcess(home)
    const second = await runCli(['serve', '--no-daemonize', '--port', '0'], { BYTEBUREAU_HOME: home })
    expect(second.code).toBe(1)
    expect(second.stderr.trim()).toBe(`a daemon is already running (pid ${daemon.info.pid})`)
    await daemon.stop()
  })

  it('keeps the token across a restart', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const first = await startDaemonProcess(home)
    const token = first.info.token
    await first.stop()
    const second = await startDaemonProcess(home)
    expect(second.info.token).toBe(token)
    await second.stop()
  })
})

describe('bytebureau serve (detached) and serve --stop', () => {
  it('starts the daemon detached, reports its url as JSON, and --stop ends it', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const started = await runCli(['serve', '--port', '0', '--json'], { BYTEBUREAU_HOME: home })
    expect(started.code).toBe(0)
    const [record] = jsonLines(started.stdout)
    expect(record).toMatchObject({ command: 'serve', url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u) })
    const alive = readServerInfo(home)
    expect(alive.state).toBe('alive')
    const again = await runCli(['serve', '--port', '0'], { BYTEBUREAU_HOME: home })
    expect(again.code).toBe(0)
    expect(again.stdout).toMatch(/^Daemon already running on /u)
    const stopped = await runCli(['serve', '--stop'], { BYTEBUREAU_HOME: home })
    expect(stopped.code).toBe(0)
    expect(stopped.stdout.trim()).toMatch(/^Stopped daemon \(pid \d+\)$/u)
    expect(readServerInfo(home).state).toBe('absent')
    const none = await runCli(['serve', '--stop'], { BYTEBUREAU_HOME: home })
    expect(none.stdout.trim()).toBe('No daemon is running')
  })
})
```
The detached daemon of the last test is stopped by `--stop`; should an assertion fail before that line, the test's `tempDir` home still names it in `server.json` — add `onTestFinished(() => { stopDaemon(home) })` at the top of that test so no daemon outlives the test run.

- [ ] **Step 6: Run everything**

Run: `bun run build:i18n && bunx vitest run --project bytebureau --project api && bun run typecheck && bun run lint && bun run format:check && bun run knip && bun run depcruise && bun run spell`
Expected: PASS. `depcruise` must stay clean: `apps/bytebureau` imports `@bytebureau/api/bun` (a workspace package, allowed) and never `effect` (the `effect-only-in-core` rule covers `apps/`). Coverage: add `apps/bytebureau/src/daemon/**/*.ts` and `apps/bytebureau/src/commands/serve.ts` to the `include` list of the root `vitest.config.ts` (the CLI tests run them in a subprocess, which coverage does not see — the unit-tested modules carry the include; the subprocess-only ones are excluded like `main.ts`: list `daemon/server-info.ts`, `daemon/token.ts`, `daemon/exec-args.ts`, `daemon/stop.ts`, `daemon/wait.ts`).

- [ ] **Step 7: Commit**

```bash
git add packages/api apps/bytebureau packages/i18n/messages vitest.config.ts bun.lock
git commit -m "feat(cli): add the daemon: startDaemon on bun, server.json and bytebureau serve"
```

### Task 9: The CLI as a thin client — `Bureau` over the daemon or in-process, daemon on demand, `run` through the API

**Files:**
- Create: `apps/bytebureau/src/bureau/bureau.ts`, `apps/bytebureau/src/bureau/local.ts`, `apps/bytebureau/src/bureau/remote.ts`, `apps/bytebureau/src/bureau/remote.test.ts`, `apps/bytebureau/src/bureau/resolve.ts`, `apps/bytebureau/src/bureau/resolve.test.ts`, `apps/bytebureau/src/bureau/ensure-daemon.ts`, `apps/bytebureau/src/bureau/with-bureau.ts`, `apps/bytebureau/src/bureau/with-bureau.test.ts`, `apps/bytebureau/src/commands/run-daemon.test.ts`
- Modify: `apps/bytebureau/src/context.ts` (`globalArgs`: `daemon`, `host`, `port`, `token-file`), `apps/bytebureau/src/kernel.ts` (`openKernel` only; `withKernel` goes), `apps/bytebureau/src/commands/run.ts`, `run-session.ts` (`Bureau` instead of `RunKernel`, remote refusals, SIGTERM/SIGHUP), `projects.ts`, `workspaces.ts`, `config.ts` (through `withBureau` where a kernel is needed), `apps/bytebureau/src/errors.ts` (`ApiError`), `apps/bytebureau/src/main.ts` (drain stdout before exit), `apps/bytebureau/src/testing/scripted-kernel.ts` (`Bureau` shape), the Phase A CLI tests that spell `--no-daemon` or `RunKernel`, `apps/bytebureau/package.json` (`@bytebureau/client`), `packages/i18n/messages/{en,cs}.json`, `vitest.config.ts` (coverage include for `bureau/*.ts`)

**Interfaces:**
- Consumes: `createBureauClient`, `BureauClient`, `ApiError` (Task 7); `Kernel` (`createKernel`, Task 2); `readServerInfo`, `spawnDaemon`, `waitForDaemon`, `daemonLogPath` (Task 8); `serverUrl`, the DTOs (protocol).
- Produces: `Bureau` (the interface every command talks to), `localBureau(kernel)`, `remoteBureau(client)`, `resolveServer(flags, env, home)`, `ensureDaemon(home, env)`, `withBureau(context, flags, env, work)`, `isRefusal()` covering remote problems, `describeError()` covering `ApiError`.

Semantics: a command opens a `Bureau` and works with it, never with a kernel or a client directly. Without `--no-daemon` the Bureau is remote: `server.json` of the home names a live daemon, or one is started on demand (the same detached start as `serve`) and waited for; `--host`/`--port` name a daemon elsewhere (no start on demand; the token comes from `--token-file`, else from this home's `server.json`); a daemon that cannot be reached ends the command with exit 2 and a line that names the URL and the daemon log. With `--no-daemon` the Bureau is the in-process kernel of Phase A — refused with exit 1 while a daemon is alive on the same home, because the store has one writer (ADR-0010). `run` keeps its contract (exit 0 completed, 3 stopped, 4 refused or errored, `--json` NDJSON, plain text off a terminal) whichever Bureau serves it; through the daemon the events come over SSE with resume, so a daemon restart in the middle of a run resumes the stream at the last seq and the run ends as the recovered session says (`session.stopped`, exit 3). A problem the API answers with is a refusal when the kernel's error would have been one (`workspace_*`, `provider_*`, `session_provider_missing`); any other problem is reported as `ApiError` with its title, detail and code. `SIGTERM` and `SIGHUP` stop the session like `SIGINT` does. Before the process exits, stdout is drained, so a run whose NDJSON goes into a pipe never loses its last lines (Bun writes to a pipe asynchronously).

- [ ] **Step 1: The `Bureau` interface and the local adapter**

`apps/bytebureau/src/bureau/bureau.ts`:
```ts
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
  SessionDto,
  SessionUsageDto,
  TurnDto,
  WorkspaceInfoDto,
} from '@bytebureau/protocol'

// What a command asks of ByteBureau; the daemon answers it over the API, the in-process kernel directly
export interface Bureau {
  readonly projects: {
    readonly register: (path: string) => Promise<ProjectDto>
    readonly list: () => Promise<readonly ProjectDto[]>
    readonly get: (id: string) => Promise<ProjectDto | undefined>
    readonly remove: (id: string) => Promise<void>
  }
  readonly sessions: {
    readonly create: (body: CreateSessionBody) => Promise<SessionDto>
    readonly prompt: (sessionId: string, input: PromptInput) => Promise<TurnDto>
    readonly interrupt: (sessionId: string) => Promise<void>
    readonly stop: (sessionId: string) => Promise<void>
    readonly complete: (sessionId: string) => Promise<void>
    readonly resume: (sessionId: string) => Promise<SessionDto>
    readonly list: () => Promise<readonly SessionDto[]>
    readonly get: (id: string) => Promise<SessionDto | undefined>
  }
  readonly asks: {
    readonly pending: (sessionId?: string) => Promise<readonly AskRecord[]>
    readonly get: (id: string) => Promise<AskRecord | undefined>
    readonly answer: (askId: string, answer: AskAnswer) => Promise<void>
  }
  readonly events: {
    // Durable events after since replayed, then live; ephemeral ones unless the filter says ephemeral: false
    readonly subscribe: (filter: EventsFilter, signal?: AbortSignal) => AsyncIterable<EventEnvelope>
  }
  readonly workspaces: {
    readonly list: (projectId?: string) => Promise<readonly WorkspaceInfoDto[]>
    readonly prune: (projectId?: string) => Promise<PruneReportDto>
  }
  readonly usage: { readonly session: (sessionId: string) => Promise<SessionUsageDto> }
  readonly plugins: {
    readonly list: () => Promise<readonly PluginStatusDto[]>
    readonly providers: () => Promise<readonly ProviderDto[]>
  }
  readonly health: { readonly check: () => Promise<HealthDto> }
  // Where the commands talk to: the daemon's URL, or in-process
  readonly where: { readonly kind: 'daemon'; readonly url: string } | { readonly kind: 'in-process' }
  readonly close: () => Promise<void>
}
```
`import/max-dependencies` counts modules, not names, so the one protocol import is fine.

`apps/bytebureau/src/bureau/local.ts`:
```ts
import type { Kernel } from '@bytebureau/kernel/bun'
import type { Bureau } from './bureau.js'

// The kernel of this process as a Bureau; answers given here are the CLI's
export const localBureau = (kernel: Kernel, version: string): Bureau => ({
  projects: kernel.projects,
  sessions: kernel.sessions,
  asks: {
    pending: kernel.asks.pending,
    get: async (id) => {
      const pending = await kernel.asks.pending()
      return pending.find((ask) => ask.id === id)
    },
    answer: (askId, answer) => kernel.asks.answer(askId, answer, 'cli'),
  },
  events: { subscribe: (filter) => kernel.events.subscribe(filter) },
  workspaces: kernel.workspaces,
  usage: kernel.usage,
  plugins: {
    list: async () => {
      const listed = await Promise.resolve(kernel.plugins.list())
      return listed
    },
    providers: async () => {
      const providers = await Promise.resolve(kernel.providers.list())
      return providers
    },
  },
  health: {
    check: async () => {
      const report = await kernel.health.check()
      return { ...report, version, startedAt: new Date().toISOString() }
    },
  },
  where: { kind: 'in-process' },
  close: kernel.close,
})
```
`kernel.asks.get` does not exist on the facade (Task 2 added `AskService.get` to the Effect service only); either add `get` to the facade's `asksApi` in this task (one line: `get: promised(AskService, (asks, id) => asks.get(id))`) and use it here, or keep the `pending` lookup — add it to the facade. The kernel's `Session`/`Project` records are assignable to the DTO types (Task 4 pinned that); if the compiler disagrees on a field, the DTO is wrong, not the kernel.

- [ ] **Step 2: The remote adapter and the refusals — tests first**

`apps/bytebureau/src/bureau/remote.test.ts` (a fake `BureauClient` object with the methods the adapter calls; the real client is tested in Task 7 and against the daemon in `run-daemon.test.ts`):
```ts
import { ApiError } from '@bytebureau/client'
import { describe, expect, it } from 'vitest'
import { isRefusal } from '../commands/run-session.js'
import { describeError } from '../errors.js'

const problem = (status: number, code: string, detail: string): ApiError =>
  new ApiError(status, { type: `https://bytebureau.dev/problems/${code}`, title: 'T', status, detail, code })

describe('problems of the daemon in the CLI', () => {
  it('counts a workspace, provider or missing-provider problem as a refusal and nothing else', () => {
    expect(isRefusal(problem(422, 'workspace_not_a_repository', 'x'))).toBe(true)
    expect(isRefusal(problem(502, 'provider_crash', 'x'))).toBe(true)
    expect(isRefusal(problem(422, 'session_provider_missing', 'x'))).toBe(true)
    expect(isRefusal(problem(409, 'session_invalid_transition', 'x'))).toBe(false)
    expect(isRefusal(problem(503, 'store_unavailable', 'x'))).toBe(false)
  })

  it('describes a problem with its detail and code, and a connection failure with its url', () => {
    expect(describeError(problem(404, 'session_not_found', 'no session 42'))).toBe('no session 42 (session_not_found)')
    expect(describeError(new ApiError(0, undefined, 'http://127.0.0.1:1/api/v1/health'))).toBe(
      'cannot reach the daemon at http://127.0.0.1:1/api/v1/health',
    )
  })
})
```
The `ApiError` constructor shape `(status, problem | undefined, url?)` is the one Task 7 defines; keep the two in step.

`apps/bytebureau/src/bureau/resolve.test.ts`:
```ts
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeServerInfo } from '../daemon/server-info.js'
import { tempDir } from '../testing/temp-repo.js'
import { resolveServer } from './resolve.js'

const info = { version: '0', host: '127.0.0.1', port: 4747, pid: process.pid, token: 't'.repeat(64), startedAt: 's' }

describe(resolveServer, () => {
  it('names the live daemon of the home', () => {
    const home = tempDir('bb-home-')
    writeServerInfo(home, info)
    expect(resolveServer({}, home)).toStrictEqual({ kind: 'known', url: 'http://127.0.0.1:4747', token: info.token })
  })

  it('names nothing when no daemon is alive, so one can be started', () => {
    expect(resolveServer({}, tempDir('bb-home-'))).toStrictEqual({ kind: 'none' })
  })

  it('prefers --host and --port, with the token of --token-file, and never starts a daemon for them', () => {
    const home = tempDir('bb-home-')
    const tokenFile = path.join(home, 'token')
    writeFileSync(tokenFile, 'abc\n')
    expect(resolveServer({ host: '10.0.0.5', port: 4800, tokenFile }, home)).toStrictEqual({
      kind: 'explicit',
      url: 'http://10.0.0.5:4800',
      token: 'abc',
    })
  })

  it('takes the token of the home for --host and --port without a token file', () => {
    const home = tempDir('bb-home-')
    writeServerInfo(home, info)
    expect(resolveServer({ host: '127.0.0.1', port: 5000 }, home)).toStrictEqual({ kind: 'explicit', url: 'http://127.0.0.1:5000', token: info.token })
  })
})
```

- [ ] **Step 3: Remote adapter, resolution, daemon on demand, `withBureau`**

`apps/bytebureau/src/bureau/resolve.ts`:
```ts
import { readFileSync } from 'node:fs'
import { serverUrl } from '@bytebureau/protocol'
import { readServerInfo } from '../daemon/server-info.js'

export interface ServerFlags {
  readonly host?: string | undefined
  readonly port?: number | undefined
  readonly tokenFile?: string | undefined
}

export type ResolvedServer =
  // A daemon named on the command line: used as it is, never started
  | { readonly kind: 'explicit'; readonly url: string; readonly token: string }
  // The live daemon of the home
  | { readonly kind: 'known'; readonly url: string; readonly token: string }
  | { readonly kind: 'none' }

const tokenOf = (flags: ServerFlags, home: string): string => {
  if (flags.tokenFile !== undefined) {
    return readFileSync(flags.tokenFile, 'utf8').trim()
  }
  const record = readServerInfo(home)
  return record.state === 'absent' || record.info === undefined ? '' : record.info.token
}

export const resolveServer = (flags: ServerFlags, home: string): ResolvedServer => {
  if (flags.host !== undefined || flags.port !== undefined) {
    const host = flags.host ?? '127.0.0.1'
    const port = flags.port ?? 4747
    return { kind: 'explicit', url: serverUrl({ host, port }), token: tokenOf(flags, home) }
  }
  const record = readServerInfo(home)
  return record.state === 'alive'
    ? { kind: 'known', url: serverUrl(record.info), token: record.info.token }
    : { kind: 'none' }
}
```

`apps/bytebureau/src/bureau/ensure-daemon.ts`:
```ts
import { serverUrl, type ServerInfo } from '@bytebureau/protocol'
import { readServerInfo } from '../daemon/server-info.js'
import { daemonLogPath, spawnDaemon } from '../daemon/spawn.js'
import { waitForDaemon } from '../daemon/wait.js'

export class DaemonUnavailable extends Error {
  public override readonly name = 'DaemonUnavailable'
}

// The daemon of the home, started detached when none is alive; a start that does not come up in time is a failure that names the log
export const ensureDaemon = async (
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ServerInfo> => {
  const record = readServerInfo(home)
  if (record.state === 'alive') {
    return record.info
  }
  spawnDaemon(home, env, [])
  const info = await waitForDaemon(home)
  if (info === undefined) {
    throw new DaemonUnavailable(`the daemon did not start; see ${daemonLogPath(home)}`)
  }
  return info
}

export const urlOf = (info: ServerInfo): string => serverUrl(info)
```

`apps/bytebureau/src/bureau/remote.ts`:
```ts
import type { BureauClient } from '@bytebureau/client'
import type { Bureau } from './bureau.js'

// The daemon as a Bureau: every call is one request; a lookup that the API answers 404 to is undefined here
export const remoteBureau = (client: BureauClient, url: string): Bureau => ({
  projects: {
    register: (path) => client.projects.register({ path }),
    list: client.projects.list,
    get: (id) => client.projects.get(id),
    remove: (id) => client.projects.remove(id),
  },
  sessions: {
    create: (body) => client.sessions.create(body),
    prompt: (sessionId, input) => client.sessions.prompt(sessionId, input),
    interrupt: (sessionId) => client.sessions.interrupt(sessionId),
    stop: (sessionId) => client.sessions.stop(sessionId),
    complete: (sessionId) => client.sessions.complete(sessionId),
    resume: (sessionId) => client.sessions.resume(sessionId),
    list: client.sessions.list,
    get: (id) => client.sessions.get(id),
  },
  asks: {
    pending: (sessionId) => client.asks.pending(sessionId),
    get: (id) => client.asks.get(id),
    answer: (askId, answer) => client.asks.answer(askId, answer),
  },
  // A run gives up on a daemon that stays unreachable for fifteen seconds; the next daemon start recovers the session
  events: { subscribe: (filter, signal) => client.events.subscribe(filter, { signal, retryFor: 15_000 }) },
  workspaces: {
    list: (projectId) => client.workspaces.list(projectId),
    prune: (projectId) => client.workspaces.prune(projectId),
  },
  usage: { session: (sessionId) => client.usage.session(sessionId) },
  plugins: { list: client.plugins.list, providers: client.plugins.providers },
  health: { check: client.health.check },
  where: { kind: 'daemon', url },
  close: async () => {
    await client.close()
  },
})
```
Task 7's `client.projects.get(id)` resolves `undefined` on a 404 and throws `ApiError` on any other problem; `client.events.subscribe(filter, { signal })` applies `ephemeral: false` by dropping `seq === 0` events client-side (the SSE endpoint has no such query).

`apps/bytebureau/src/bureau/with-bureau.ts`:
```ts
import { createBureauClient } from '@bytebureau/client'
import { m } from '@bytebureau/i18n'
import type { Context } from '../context.js'
import { readServerInfo } from '../daemon/server-info.js'
import { kernelHome } from '../kernel-home.js'
import { openKernel } from '../kernel.js'
import { withResource } from '../resource.js'
import { version } from '../version.js'
import type { Bureau } from './bureau.js'
import { ensureDaemon, urlOf } from './ensure-daemon.js'
import { localBureau } from './local.js'
import { remoteBureau } from './remote.js'
import { resolveServer, type ServerFlags } from './resolve.js'

export interface BureauFlags extends ServerFlags {
  readonly daemon: boolean
}

export class DaemonRunning extends Error {
  public override readonly name = 'DaemonRunning'
}

// The store has one writer: an in-process kernel is refused while the daemon of the same home is alive
const openLocal = async (context: Context, env: Readonly<Record<string, string | undefined>>): Promise<Bureau> => {
  const home = kernelHome(env)
  const record = readServerInfo(home)
  if (record.state === 'alive') {
    throw new DaemonRunning(m.bureau_daemon_running({ pid: record.info.pid, url: urlOf(record.info) }))
  }
  return localBureau(await openKernel(context, env), version)
}

const openRemote = async (flags: ServerFlags, env: Readonly<Record<string, string | undefined>>): Promise<Bureau> => {
  const home = kernelHome(env)
  const resolved = resolveServer(flags, home)
  if (resolved.kind !== 'none') {
    return remoteBureau(createBureauClient({ baseUrl: resolved.url, token: resolved.token }), resolved.url)
  }
  const info = await ensureDaemon(home, env)
  return remoteBureau(createBureauClient({ baseUrl: urlOf(info), token: info.token }), urlOf(info))
}

// A Bureau for the length of the work: the daemon's unless --no-daemon
export const withBureau = <Result>(
  context: Context,
  flags: BureauFlags,
  env: Readonly<Record<string, string | undefined>>,
  work: (bureau: Bureau) => Promise<Result>,
): Promise<Result> =>
  withResource(() => (flags.daemon ? openRemote(flags, env) : openLocal(context, env)), work)
```
`apps/bytebureau/src/kernel.ts` keeps only `openKernel(context, env): Promise<Kernel>` (the body of the former `open`). `DaemonRunning` and `DaemonUnavailable` end a command with exit 1 (a refusal with a reason) — `run.ts` (the citty runner) maps them: add to its `catch`: `if (error instanceof DaemonRunning) { console.error(error.message); return 1 }` and `DaemonUnavailable` → exit 2 with the message (the generic path already does that; only `DaemonRunning` needs the branch). `errors.ts`: `describeError` gains `ApiError`: a problem is told as `${detail} (${code})`, a connection failure as `cannot reach the daemon at ${url}`.

`apps/bytebureau/src/context.ts`, `globalArgs` gain:
```ts
  daemon: { type: 'boolean', description: 'Talk to the daemon (started on demand); pass --no-daemon to run the kernel in-process', default: true },
  host: { type: 'string', description: 'Host of a daemon to talk to (never started on demand)' },
  port: { type: 'string', description: 'Port of that daemon' },
  'token-file': { type: 'string', description: 'File holding the bearer token of that daemon' },
```
and `GlobalArgs` the matching fields; `bureauFlags(args): BureauFlags` (a helper in `context.ts`) turns them into `{ daemon, host, port: Number | undefined, tokenFile }`. The `run` command drops its own `no-daemon` argument (the global one replaces it; `--no-daemon` keeps working because citty's boolean `daemon` accepts `--no-daemon`).

- [ ] **Step 4: Commands and the run through a Bureau**

`run-session.ts`: `RunKernel` is replaced by `Bureau` (import the type); the project path is made absolute with `path.resolve` before `bureau.projects.register` (the daemon resolves a relative path in its own working directory — the `run` command and `projects add` resolve `args.project`/`args.path` against the CLI's cwd, and the Phase A tests pass absolute temp paths already); `unknownProvider` awaits `bureau.plugins.providers()`, `answerAsk` calls `bureau.asks.answer(ask.id, answer)`, `followSession` subscribes with `bureau.events.subscribe({ sessionId, since: 0, ephemeral: false }, controller.signal)` and aborts the controller in its `finally`, and the signal handling covers `SIGINT`, `SIGTERM` and `SIGHUP` (one `stop` for the three, `process.once` each, `process.off` each in `finally`). `isRefusal` is exported and gains:
```ts
const REMOTE_REFUSALS = /^(?:workspace_|provider_|session_provider_missing$)/u
if (error instanceof ApiError) {
  return error.problem !== undefined && REMOTE_REFUSALS.test(error.problem.code)
}
```
`run.ts` (the command), `projects.ts`, `workspaces.ts` call `withBureau(context, bureauFlags(args), process.env, …)` instead of `withKernel`; `config.ts` keeps the in-process kernel for `validate`/`schema` (they read files, no daemon needed) through `openKernel` — `config` is the one command that never talks to a daemon. `projects rm`'s `has_sessions` refusal is now either the kernel's `WorkspaceError` or an `ApiError` with code `workspace_has_sessions`: match both. `main.ts`: before `process.exit(...)`, `await drained()` where `drained = () => new Promise<void>((resolve) => { process.stdout.write('', () => resolve()) })`.

`apps/bytebureau/src/testing/scripted-kernel.ts`: the fake implements `Bureau` (the fields the run uses: `plugins.providers`, `projects.register`, `sessions.create|prompt|stop|complete`, `asks.answer`, `events.subscribe`; fill the rest with functions that throw `new Error('not scripted')`), so `run-session*.test.ts` keep running without a daemon.

New messages: `bureau_daemon_running` = "A daemon is running on {url} (pid {pid}); drop --no-daemon or stop it with bytebureau serve --stop" / "Běží démon na {url} (pid {pid}); vynechte --no-daemon nebo ho zastavte přes bytebureau serve --stop".

- [ ] **Step 5: The failing daemon-backed CLI tests**

`apps/bytebureau/src/commands/run-daemon.test.ts`:
```ts
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readServerInfo } from '../daemon/server-info.js'
import { stopDaemon } from '../daemon/stop.js'
import { startDaemonProcess } from '../testing/daemon.js'
import { jsonLines } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import { tempDir } from '../testing/temp-repo.js'
import { FAKE, PROMPT, workbench, worktreesOf } from '../testing/workbench.js'

describe('bytebureau run through the daemon', () => {
  it('runs the fake provider end to end over the API and streams NDJSON events', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const daemon = await startDaemonProcess(home)
    const result = await runCli(['run', PROMPT, '--project', repo, ...FAKE], { BYTEBUREAU_HOME: home })
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    const types = jsonLines(result.stdout).map((record) => record['type'])
    expect(types).toContain('session.created')
    expect(types).toContain('ask.requested')
    expect(types.at(-1)).toBe('session.completed')
    expect(existsSync(worktreesOf(repo))).toBe(true)
    const listed = await runCli(['projects', 'ls', '--json'], { BYTEBUREAU_HOME: home })
    expect(jsonLines(listed.stdout)).toMatchObject([{ projects: [{ path: repo }] }])
    await daemon.stop()
  })

  it('starts the daemon on demand when none runs, and leaves it running', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    expect(readServerInfo(home).state).toBe('absent')
    const result = await runCli(['run', PROMPT, '--project', repo, ...FAKE], { BYTEBUREAU_HOME: home })
    expect(result.code).toBe(0)
    expect(readServerInfo(home).state).toBe('alive')
    expect(await stopDaemon(home)).toMatchObject({ outcome: 'stopped' })
  })

  it('refuses --no-daemon while the daemon is alive, with exit 1 and the way out', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const daemon = await startDaemonProcess(home)
    const result = await runCli(['run', PROMPT, '--project', repo, '--no-daemon', ...FAKE], { BYTEBUREAU_HOME: home })
    expect(result.code).toBe(1)
    expect(result.stderr.trim()).toMatch(/^A daemon is running on http:\/\/127\.0\.0\.1:\d+ \(pid \d+\); drop --no-daemon/u)
    await daemon.stop()
  })

  it('fails with exit 2 and the url when --host and --port name a daemon that is not there', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const result = await runCli(['projects', 'ls', '--host', '127.0.0.1', '--port', '9'], { BYTEBUREAU_HOME: home })
    expect(result.code).toBe(2)
    expect(result.stderr.trim()).toBe('cannot reach the daemon at http://127.0.0.1:9/api/v1/projects')
    expect(readServerInfo(home).state).toBe('absent')
  })

  it('runs two sessions through one daemon at the same time and lists both', async () => {
    expect.hasAssertions()
    const first = workbench()
    const second = { repo: workbench().repo, home: first.home }
    const daemon = await startDaemonProcess(first.home)
    const env = { BYTEBUREAU_HOME: first.home }
    const [left, right] = await Promise.all([
      runCli(['run', PROMPT, '--project', first.repo, ...FAKE], env),
      runCli(['run', PROMPT, '--project', second.repo, ...FAKE], env),
    ])
    expect([left.code, right.code]).toStrictEqual([0, 0])
    const listed = await runCli(['sessions', 'ls', '--json'], env)
    const [record] = jsonLines(listed.stdout)
    const sessions: unknown = record === undefined ? [] : record['sessions']
    expect(Array.isArray(sessions) ? sessions.length : 0).toBe(2)
    await daemon.stop()
  })

  it('ends a run with exit 2 and the url when the daemon dies while the run waits on an ask', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const daemon = await startDaemonProcess(home)
    const env = { BYTEBUREAU_HOME: home }
    // Without --yes and off a terminal the run waits on the fake provider's question; the daemon is killed meanwhile
    const running = runCli(['run', PROMPT, '--project', repo, '--provider', 'fake', '--json'], env, {
      signal: 'SIGKILL',
      afterStdout: '"type":"ask.requested"',
      target: daemon.child,
    })
    const result = await running
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/^cannot reach the daemon at http:\/\/127\.0\.0\.1:\d+\/api\/v1\/events/mu)
  }, 30_000)

  it('still runs in-process with --no-daemon when no daemon is alive', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const result = await runCli(['run', PROMPT, '--project', repo, '--no-daemon', ...FAKE], { BYTEBUREAU_HOME: home })
    expect(result.code).toBe(0)
    expect(readServerInfo(home).state).toBe('absent')
  })
})
```
`runCli`'s `Interruption` (Phase A's `testing/run-cli.ts`) signals the CLI child once its stdout contains a text; this test needs the signal sent to another process — extend `Interruption` with an optional `target: ChildProcess` that receives the signal instead of the CLI child. The `sessions ls` listing comes from Task 10; until then the parallel-run test asserts on the two exit codes and on two worktrees under each repository. The remote adapter passes `retryFor: 15_000` to `subscribeEvents`, so a run gives up fifteen seconds after the daemon stops answering, and the next `serve` recovers the session as `stopped` (Task 2).

The Phase A `run.test.ts`, `projects.test.ts`, `workspaces.test.ts` and `config.test.ts` run the CLI without a daemon alive and without `--no-daemon`: under the new default they would start a daemon on demand in every test — pass `--no-daemon` in their `runCli` calls (one edit in `workbench.ts`'s `FAKE`/`fakeRun` and in the tests that spell their own arguments), so the Phase A tests keep testing the in-process path and the daemon path has the tests above. If a `workbench` run starts a daemon anyway, `run-daemon.test.ts`'s second test is the one that wants it.

- [ ] **Step 6: Run everything**

Run: `bun run build:i18n && bunx vitest run --project bytebureau && bun run typecheck && bun run lint && bun run format:check && bun run knip && bun run depcruise && bun run spell`
Expected: PASS. `knip` must see `@bytebureau/client` used (it is, by `with-bureau.ts`); coverage keeps its thresholds with `bureau/resolve.ts`, `bureau/remote.ts`, `bureau/local.ts` in the include list.

- [ ] **Step 7: Commit**

```bash
git add apps/bytebureau packages/i18n/messages vitest.config.ts bun.lock
git commit -m "feat(cli): talk to the daemon through a bureau, start it on demand and keep --no-daemon in-process"
```

### Task 10: New commands — `sessions`, `ask`, `plugins`, and the bare `bytebureau` status

**Files:**
- Create: `apps/bytebureau/src/commands/sessions.ts`, `apps/bytebureau/src/commands/sessions-prompt.ts`, `apps/bytebureau/src/commands/ask.ts`, `apps/bytebureau/src/commands/plugins.ts`, `apps/bytebureau/src/commands/status.ts`, `apps/bytebureau/src/render/tables.ts`, `apps/bytebureau/src/render/tables.test.ts`, `apps/bytebureau/src/commands/sessions.test.ts`, `apps/bytebureau/src/commands/ask.test.ts`, `apps/bytebureau/src/commands/plugins-status.test.ts`
- Modify: `apps/bytebureau/src/main.ts` (subcommands and the root `run`), `apps/bytebureau/src/commands/run-session.ts` (export `follow`/`conclude` for `sessions prompt`, or move them to `run-follow.ts`), `packages/i18n/messages/{en,cs}.json`, `vitest.config.ts` (coverage include for `render/tables.ts`)

**Interfaces:**
- Consumes: `Bureau`, `withBureau`, `bureauFlags` (Task 9); `promptAsk` (Phase A); `ensureDaemon` (Task 9) for the status; the DTOs.
- Produces: the commands below; `table(rows, columns)` (plain-text columns for terminals).

Commands (spec §11.3; every one takes the global flags, `--json` emits one record or NDJSON):
- `bytebureau` (no sub-command): ensures the daemon is running (starts it on demand), prints `Daemon: <url> (pid <pid>, up since <startedAt>)`, `Projects: <n>`, `Sessions: <running> running, <waiting> waiting for you, <total> in all`, `Pending asks: <n>`; `--json` emits `{ command: 'status', daemon: { url, pid, version, startedAt }, projects, sessions: { running, waiting, total }, pendingAsks }`.
- `sessions ls` — `id  status  title  project` per session (`No sessions` when empty); `sessions show <id>` — the session's fields one per line and its pending asks; `sessions prompt <id> "<text>"` — prompts and follows the turn like `run` does (exit 0 when the turn completes, 3 stopped, 4 errored); `sessions interrupt|stop|resume <id>`.
- `ask ls [--session <id>]` — the pending asks (`id  session  title  recommended option`); `ask answer <id> [--option <id>]... [--other <text>]` — answers; without `--option`/`--other` an interactive prompt at a terminal (`--yes` picks the recommended option), a refusal otherwise.
- `plugins ls` — `name  version  state  ports` (a failed plugin shows its reason).
A command whose request the daemon refuses (`409`, `404`, `422` problems) prints the problem's detail and exits 1 — the same shape as `projects rm` of Phase A (`sessions interrupt` on a session with no agent attached is such a refusal: the kernel answers `session_not_found`).

- [ ] **Step 1: The table renderer — test first**

`apps/bytebureau/src/render/tables.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { table } from './tables.js'

describe(table, () => {
  it('pads every column to its widest cell with two spaces between columns', () => {
    expect(table([['a', 'bb', 'c'], ['dddd', 'e', 'f']])).toStrictEqual(['a     bb  c', 'dddd  e   f'])
  })

  it('leaves the last column unpadded and renders no rows as no lines', () => {
    expect(table([['x', 'y']])).toStrictEqual(['x  y'])
    expect(table([])).toStrictEqual([])
  })
})
```
`apps/bytebureau/src/render/tables.ts`:
```ts
// Plain columns for a terminal: no borders, so a line stays easy to grep
export const table = (rows: readonly (readonly string[])[]): string[] => {
  const widths = rows.reduce<number[]>((acc, row) => row.map((cell, index) => Math.max(acc[index] ?? 0, cell.length)), [])
  return rows.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join('  ')
      .trimEnd(),
  )
}
```

- [ ] **Step 2: The commands**

`apps/bytebureau/src/commands/sessions.ts`:
```ts
import { m } from '@bytebureau/i18n'
import { defineCommand } from 'citty'
import { withBureau } from '../bureau/with-bureau.js'
import { bureauFlags, globalArgs, processContext } from '../context.js'
import { table } from '../render/tables.js'
import { promptCommand } from './sessions-prompt.js'

const id = { id: { type: 'positional', description: 'Session id', required: true } } as const

const ls = defineCommand({
  meta: { name: 'ls', description: 'List sessions' },
  args: { ...globalArgs },
  async run({ args }) {
    const context = processContext(args)
    const sessions = await withBureau(context, bureauFlags(args), process.env, (bureau) => bureau.sessions.list())
    context.output.emit({ command: 'sessions.ls', sessions })
    if (sessions.length === 0) {
      context.output.print(m.sessions_none())
      return
    }
    for (const line of table(sessions.map((session) => [session.id, session.status, session.title, session.projectId]))) {
      context.output.print(line)
    }
  },
})

const show = defineCommand({
  meta: { name: 'show', description: 'Show one session and its pending asks' },
  args: { ...globalArgs, ...id },
  async run({ args }) {
    const context = processContext(args)
    const shown = await withBureau(context, bureauFlags(args), process.env, async (bureau) => {
      const session = await bureau.sessions.get(args.id)
      const asks = session === undefined ? [] : await bureau.asks.pending(session.id)
      return { session, asks }
    })
    if (shown.session === undefined) {
      context.output.warn(m.sessions_missing({ id: args.id }))
      process.exitCode = 1
      return
    }
    context.output.emit({ command: 'sessions.show', ...shown })
    const { session } = shown
    for (const line of table([
      ['id', session.id], ['status', session.status], ['title', session.title], ['project', session.projectId],
      ['employee', session.employee.id], ['provider', session.providerId],
      ['worktree', session.workspace === null ? '-' : session.workspace.path], ['created', session.createdAt],
    ])) {
      context.output.print(line)
    }
    for (const ask of shown.asks) {
      context.output.print(m.sessions_pending_ask({ id: ask.id, title: ask.title }))
    }
  },
})

// interrupt, stop and resume: one request, one line
const command = (name: 'interrupt' | 'stop' | 'resume', description: string) =>
  defineCommand({
    meta: { name, description },
    args: { ...globalArgs, ...id },
    async run({ args }) {
      const context = processContext(args)
      await withBureau(context, bureauFlags(args), process.env, (bureau) => bureau.sessions[name](args.id))
      context.output.emit({ command: `sessions.${name}`, id: args.id })
      context.output.print(m.sessions_done({ action: name, id: args.id }))
    },
  })

export const sessionsCommand = defineCommand({
  meta: { name: 'sessions', description: 'List, inspect and steer sessions' },
  subCommands: {
    ls,
    show,
    prompt: promptCommand,
    interrupt: command('interrupt', 'Interrupt the running turn of a session'),
    stop: command('stop', 'Stop a session (resumable later)'),
    resume: command('resume', 'Resume a stopped or errored session'),
  },
})
```
A refusal of the daemon (`ApiError` with a `4xx` problem) or of the kernel (`SessionError`) must end these commands with exit 1 and the detail on stderr: wrap the `withBureau` calls in a shared `refusable(context, work)` helper in `commands/refusable.ts` that catches `ApiError` with `status < 500` and the kernel's `SessionError`/`AskError`/`WorkspaceError`, prints `describeError(error)` with `output.warn`, sets `process.exitCode = 1` and returns `undefined`; `projects rm` adopts it too.

`apps/bytebureau/src/commands/sessions-prompt.ts`: `prompt <id> <text>` — opens the Bureau, subscribes to the session's events with `since` = the latest seq (so the earlier turns are not replayed: read `bureau.events`? there is no "latest seq" call — subscribe with `since: 0`, filter the events to those with `turnId` of the new turn once `turn.started` names it, and show only those), prompts, follows with the `follow`/`react`/`conclude` of `run-session.ts` (export them, or lift them into `commands/run-follow.ts` that both import) and exits with the run's codes. Terminal events for a prompt: `turn.completed` (0), `turn.interrupted` (3), `session.errored`/`session.stopped` (4/3) — `conclude` takes the terminal set as a parameter.

`apps/bytebureau/src/commands/ask.ts`:
```ts
import { m } from '@bytebureau/i18n'
import type { AskAnswer, AskRecord } from '@bytebureau/protocol'
import { defineCommand } from 'citty'
import { withBureau } from '../bureau/with-bureau.js'
import { bureauFlags, globalArgs, processContext, type Context } from '../context.js'
import { promptAsk } from '../render/ask-prompt.js'
import { table } from '../render/tables.js'
import { refusable } from './refusable.js'

const recommendedOf = (ask: AskRecord): string =>
  ask.questions
    .flatMap((question) => question.options.filter((option) => option.recommended).map((option) => option.label))
    .join(', ')

const ls = defineCommand({
  meta: { name: 'ls', description: 'List the asks waiting for an answer' },
  args: { ...globalArgs, session: { type: 'string', description: 'Only the asks of this session' } },
  async run({ args }) {
    const context = processContext(args)
    const asks = await withBureau(context, bureauFlags(args), process.env, (bureau) => bureau.asks.pending(args.session))
    context.output.emit({ command: 'ask.ls', asks })
    if (asks.length === 0) {
      context.output.print(m.ask_none())
      return
    }
    for (const line of table(asks.map((ask) => [ask.id, ask.sessionId, ask.title, recommendedOf(ask)]))) {
      context.output.print(line)
    }
  },
})

// The answer the flags spell; none means the person is asked, which only a terminal can do
const answerOf = (
  options: readonly string[],
  other: string | undefined,
  ask: AskRecord,
  context: Context,
  yes: boolean,
): Promise<AskAnswer | undefined> => {
  if (other !== undefined) {
    return Promise.resolve({ selected: 'other', otherText: other })
  }
  if (options.length > 0) {
    return Promise.resolve({ selected: [...options] })
  }
  return promptAsk(ask, { yes, interactive: context.interactive })
}

const answer = defineCommand({
  meta: { name: 'answer', description: 'Answer an ask by id' },
  args: {
    ...globalArgs,
    id: { type: 'positional', description: 'Ask id', required: true },
    option: { type: 'string', description: 'Option id to select (repeatable)' },
    other: { type: 'string', description: 'Free-text answer when the ask allows it' },
  },
  async run({ args }) {
    const context = processContext(args)
    const options = typeof args.option === 'string' ? [args.option] : Array.isArray(args.option) ? args.option : []
    await refusable(context, () =>
      withBureau(context, bureauFlags(args), process.env, async (bureau) => {
        const ask = await bureau.asks.get(args.id)
        if (ask === undefined || ask.status !== 'pending') {
          context.output.warn(m.ask_not_pending({ id: args.id }))
          process.exitCode = 1
          return
        }
        const chosen = await answerOf(options, args.other, ask, context, args.yes)
        if (chosen === undefined) {
          context.output.warn(m.ask_needs_answer({ id: args.id }))
          process.exitCode = 1
          return
        }
        await bureau.asks.answer(ask.id, chosen)
        context.output.emit({ command: 'ask.answer', id: ask.id, answer: chosen })
        context.output.print(m.ask_answered({ id: ask.id }))
      }),
    )
  },
})

export const askCommand = defineCommand({
  meta: { name: 'ask', description: 'List and answer asks' },
  subCommands: { ls, answer },
})
```
citty gives a repeated `--option` either as a string or as an array; the nested ternary is refused by `unicorn/no-nested-ternary` — write it as a small `optionsOf(value)` function with two `if`s.

`apps/bytebureau/src/commands/plugins.ts`:
```ts
import { m } from '@bytebureau/i18n'
import { defineCommand } from 'citty'
import { withBureau } from '../bureau/with-bureau.js'
import { bureauFlags, globalArgs, processContext } from '../context.js'
import { table } from '../render/tables.js'

const ls = defineCommand({
  meta: { name: 'ls', description: 'List the loaded plugins and the ports they offer' },
  args: { ...globalArgs },
  async run({ args }) {
    const context = processContext(args)
    const plugins = await withBureau(context, bureauFlags(args), process.env, (bureau) => bureau.plugins.list())
    context.output.emit({ command: 'plugins.ls', plugins })
    if (plugins.length === 0) {
      context.output.print(m.plugins_none())
      return
    }
    for (const line of table(
      plugins.map((plugin) => [plugin.name, plugin.version, plugin.state, plugin.state === 'failed' ? (plugin.reason ?? '') : plugin.ports.join(',')]),
    )) {
      context.output.print(line)
    }
  },
})

export const pluginsCommand = defineCommand({
  meta: { name: 'plugins', description: 'Inspect plugins' },
  subCommands: { ls },
})
```

`apps/bytebureau/src/commands/status.ts`:
```ts
import { m } from '@bytebureau/i18n'
import { withBureau } from '../bureau/with-bureau.js'
import { bureauFlags, processContext, type GlobalArgs } from '../context.js'
import { readServerInfo } from '../daemon/server-info.js'
import { kernelHome } from '../kernel-home.js'

// What bytebureau says when it is called with nothing else: the daemon (started on demand), its projects, sessions and asks
export async function status(args: GlobalArgs): Promise<void> {
  const context = processContext(args)
  const counts = await withBureau(context, bureauFlags(args), process.env, async (bureau) => {
    const [projects, sessions, asks, health] = await Promise.all([
      bureau.projects.list(), bureau.sessions.list(), bureau.asks.pending(), bureau.health.check(),
    ])
    const running = sessions.filter((session) => session.status === 'running').length
    const waiting = sessions.filter((session) => session.status === 'waiting_for_human').length
    return { where: bureau.where, health, projects: projects.length, sessions: { running, waiting, total: sessions.length }, pendingAsks: asks.length }
  })
  const record = readServerInfo(kernelHome(process.env))
  const daemon = record.state === 'alive' ? { url: counts.where.kind === 'daemon' ? counts.where.url : '', pid: record.info.pid, version: record.info.version, startedAt: record.info.startedAt } : undefined
  context.output.emit({ command: 'status', daemon, ...counts })
  context.output.print(daemon === undefined ? m.status_in_process() : m.status_daemon({ url: daemon.url, pid: daemon.pid, since: daemon.startedAt }))
  context.output.print(m.status_projects({ count: counts.projects }))
  context.output.print(m.status_sessions(counts.sessions))
  context.output.print(m.status_asks({ count: counts.pendingAsks }))
}
```
`max-statements` wants the body split (`gather`, `daemonOf`, `print`). `main.ts`: the root command gets `args: { ...globalArgs }` and `run({ args }) { await status(args) }`, and the sub-commands `sessions`, `ask`, `plugins` next to `serve`. citty runs the root `run` only when no sub-command is named.

New messages (en / cs): `sessions_none` "No sessions" / "Žádné sezení"; `sessions_missing` "No session {id}" / "Sezení {id} neexistuje"; `sessions_pending_ask` "Waiting for your answer: {title} ({id})" / "Čeká na vaši odpověď: {title} ({id})"; `sessions_done` "{action}: {id}" / "{action}: {id}"; `ask_none` "No asks waiting" / "Žádné otázky nečekají"; `ask_not_pending` "Ask {id} is not pending" / "Otázka {id} nečeká na odpověď"; `ask_needs_answer` "Ask {id} needs --option or --other outside a terminal" / "Otázka {id} potřebuje mimo terminál --option nebo --other"; `ask_answered` "Answered {id}" / "Odpovězeno: {id}"; `plugins_none` "No plugins loaded" / "Žádné pluginy"; `status_daemon` "Daemon: {url} (pid {pid}, up since {since})" / "Démon: {url} (pid {pid}, běží od {since})"; `status_in_process` "Daemon: not running (in-process)" / "Démon: neběží (v procesu)"; `status_projects` "Projects: {count}" / "Projekty: {count}"; `status_sessions` "Sessions: {running} running, {waiting} waiting for you, {total} in all" / "Sezení: {running} běží, {waiting} čeká na vás, {total} celkem"; `status_asks` "Pending asks: {count}" / "Čekající otázky: {count}".

- [ ] **Step 3: The failing command tests**

`apps/bytebureau/src/commands/sessions.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { startDaemonProcess } from '../testing/daemon.js'
import { jsonLines } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import { FAKE, PROMPT, workbench } from '../testing/workbench.js'

describe('bytebureau sessions', () => {
  it('lists nothing, then the completed session of a run, shows it, and refuses to stop a completed one', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const daemon = await startDaemonProcess(home)
    const env = { BYTEBUREAU_HOME: home }
    expect((await runCli(['sessions', 'ls'], env)).stdout.trim()).toBe('No sessions')
    expect((await runCli(['run', PROMPT, '--project', repo, ...FAKE], env)).code).toBe(0)
    const listed = await runCli(['sessions', 'ls', '--json'], env)
    const [record] = jsonLines(listed.stdout)
    expect(record).toMatchObject({ command: 'sessions.ls', sessions: [{ status: 'completed', title: 'Create hello' }] })
    const sessions: unknown = record === undefined ? [] : record['sessions']
    const id = Array.isArray(sessions) ? String(Reflect.get(Object(sessions[0]), 'id')) : ''
    const shown = await runCli(['sessions', 'show', id], env)
    expect(shown.code).toBe(0)
    expect(shown.stdout).toMatch(/^status\s+completed$/mu)
    const stopped = await runCli(['sessions', 'stop', id], env)
    expect(stopped.code).toBe(1)
    expect(stopped.stderr.trim()).toMatch(/\(session_invalid_transition\)$/u)
    const missing = await runCli(['sessions', 'show', '0192f0a0-0000-7000-8000-000000000009'], env)
    expect(missing.code).toBe(1)
    await daemon.stop()
  })

  it('prompts an existing session again and follows the turn to its end', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const daemon = await startDaemonProcess(home)
    const env = { BYTEBUREAU_HOME: home }
    await runCli(['run', PROMPT, '--project', repo, ...FAKE], env)
    const [record] = jsonLines((await runCli(['sessions', 'ls', '--json'], env)).stdout)
    const sessions: unknown = record === undefined ? [] : record['sessions']
    const id = Array.isArray(sessions) ? String(Reflect.get(Object(sessions[0]), 'id')) : ''
    expect((await runCli(['sessions', 'resume', id], env)).code).toBe(0)
    const prompted = await runCli(['sessions', 'prompt', id, 'again', '--json', '--yes'], env)
    expect(prompted.code).toBe(0)
    expect(jsonLines(prompted.stdout).map((event) => event['type'])).toContain('turn.completed')
    await daemon.stop()
  })
})
```
`FAKE` of the workbench carries `--provider fake --json --yes`; after Task 9 it also carries `--no-daemon` for the Phase A tests — this test wants the daemon, so spell the flags here without `--no-daemon` (`['--provider', 'fake', '--json', '--yes']`).

`apps/bytebureau/src/commands/ask.test.ts`:
```ts
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { startDaemonProcess } from '../testing/daemon.js'
import { jsonLines } from '../testing/json-lines.js'
import { childEnv, runCli } from '../testing/run-cli.js'
import { PROMPT, workbench } from '../testing/workbench.js'

const CLI_DIRECTORY = fileURLToPath(new URL('../..', import.meta.url))

describe('bytebureau ask', () => {
  it('lists the ask a run waits on, answers it from another process, and the run completes', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const daemon = await startDaemonProcess(home)
    const env = { BYTEBUREAU_HOME: home }
    expect((await runCli(['ask', 'ls'], env)).stdout.trim()).toBe('No asks waiting')
    // A run off a terminal without --yes leaves its ask for someone else
    const run = spawn('bun', ['run', 'src/main.ts', 'run', PROMPT, '--project', repo, '--provider', 'fake', '--json'], {
      cwd: CLI_DIRECTORY, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    run.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    const exited = new Promise<number | null>((resolve) => { run.once('close', (code) => resolve(code)) })
    const deadline = Date.now() + 15_000
    let asks: Record<string, unknown>[] = []
    while (asks.length === 0 && Date.now() < deadline) {
      const [record] = jsonLines((await runCli(['ask', 'ls', '--json'], env)).stdout)
      const listed: unknown = record === undefined ? [] : record['asks']
      asks = Array.isArray(listed) ? listed : []
      if (asks.length === 0) {
        await new Promise((resolve) => { setTimeout(resolve, 200) })
      }
    }
    expect(asks).toHaveLength(1)
    const [ask] = asks
    const id = String(ask === undefined ? '' : ask['id'])
    const refused = await runCli(['ask', 'answer', id], env)
    expect(refused.code).toBe(1)
    expect(refused.stderr.trim()).toBe(`Ask ${id} needs --option or --other outside a terminal`)
    const answered = await runCli(['ask', 'answer', id, '--yes'], env)
    expect(answered.code).toBe(0)
    expect(answered.stdout.trim()).toBe(`Answered ${id}`)
    expect(await exited).toBe(0)
    expect(jsonLines(stdout).map((event) => event['type']).at(-1)).toBe('session.completed')
    const again = await runCli(['ask', 'answer', id, '--yes'], env)
    expect(again.code).toBe(1)
    expect(again.stderr.trim()).toBe(`Ask ${id} is not pending`)
    await daemon.stop()
  })
})
```
`--yes` picks the recommended option even off a terminal (Phase A's `promptAsk` does that), which is what the second `ask answer` relies on. The polling loop with `await` needs the `no-await-in-loop` treatment of Task 8.

`apps/bytebureau/src/commands/plugins-status.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { readServerInfo } from '../daemon/server-info.js'
import { stopDaemon } from '../daemon/stop.js'
import { startDaemonProcess } from '../testing/daemon.js'
import { jsonLines } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import { tempDir } from '../testing/temp-repo.js'

describe('bytebureau plugins ls and the bare status', () => {
  it('lists the bundled plugins as loaded', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const daemon = await startDaemonProcess(home)
    const listed = await runCli(['plugins', 'ls', '--json'], { BYTEBUREAU_HOME: home })
    expect(jsonLines(listed.stdout)).toMatchObject([{ command: 'plugins.ls', plugins: [{ state: 'loaded' }, { state: 'loaded' }] }])
    const text = await runCli(['plugins', 'ls'], { BYTEBUREAU_HOME: home })
    expect(text.stdout).toMatch(/^workspace-local\s+\S+\s+loaded\s+workspaceRuntime/mu)
    await daemon.stop()
  })

  it('starts the daemon on demand and reports counts', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const result = await runCli(['--json'], { BYTEBUREAU_HOME: home })
    expect(result.code).toBe(0)
    expect(jsonLines(result.stdout)).toMatchObject([
      { command: 'status', daemon: { url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u) }, projects: 0, sessions: { running: 0, waiting: 0, total: 0 }, pendingAsks: 0 },
    ])
    expect(readServerInfo(home).state).toBe('alive')
    const text = await runCli([], { BYTEBUREAU_HOME: home })
    expect(text.stdout).toMatch(/^Daemon: http:\/\/127\.0\.0\.1:\d+ \(pid \d+, up since /u)
    expect(await stopDaemon(home)).toMatchObject({ outcome: 'stopped' })
  })
})
```
The plugin names and ports are the bundled ones (`workspace-local` offering `workspaceRuntime`, the fake agent offering `agentProvider`); read `PluginStatus.ports` of one `plugins ls --json` once and pin the exact strings.

- [ ] **Step 4: Run, then the gates**

Run: `bun run build:i18n && bunx vitest run --project bytebureau && bun run typecheck && bun run lint && bun run format:check && bun run knip && bun run depcruise && bun run spell`
Expected: PASS. `cli.test.ts` of Phase A asserts the `--help` output: it now lists `serve`, `sessions`, `ask`, `plugins` — update its expectation.

- [ ] **Step 5: Commit**

```bash
git add apps/bytebureau packages/i18n/messages vitest.config.ts
git commit -m "feat(cli): add sessions, ask and plugins commands and the bare status"
```

### Task 11: Gates, CI smoke of the daemon, docs, spec sync, deferrals

**Files:**
- Create: `apps/docs/src/content/docs/daemon-and-api.md`
- Modify: `.github/workflows/ci.yml` (contract drift step; daemon smoke in `build-smoke`, `smoke-arm64`, `smoke-macos`), `.github/workflows/semantic-pr.yml` (scopes `api`, `client`), `.github/labeler.yml` (`area: api`, `area: client`), `apps/docs/astro.config.mjs` (sidebar entry), `apps/docs/src/content/docs/architecture.md` (package table, run flow, Phase B decisions, the deferred list), `CONTRIBUTING.md` ("Working in the API and the client"), `README.md` + `README.cs.md` (status line), `docs/superpowers/specs/2026-10-02-kernel-and-agent-runtime-design.md` (amendments listed below), `docs/superpowers/plans/2026-10-04-kernel-phase-b-daemon-api-client.md` (this plan: the controller syncs the fences after the task)

**Interfaces:**
- Consumes: everything Tasks 1–10 shipped.
- Produces: a green `bun run check` and `bun run lint:actions` on a fresh clone, CI that runs the daemon end to end on three platforms, and documentation that describes what shipped.

Semantics: Phase B is done when a fresh clone passes every gate, the compiled binary serves and is driven through the daemon on Linux x64, Linux arm64 and macOS in CI, and the docs, the spec and the research index say what the code does. The spec is amended where a ruling of this plan changed it (one sentence each, marked "amended in Phase B"); the architecture page's "Deferred to later phases" list is rewritten to what is still deferred after Phase B.

- [ ] **Step 1: CI**

`.github/workflows/ci.yml`, job `static`, after `bun run typecheck`:
```yaml
      - name: generated contracts are up to date
        run: |
          set -euo pipefail
          bun run build
          bun run generate:client
          git diff --exit-code -- packages/protocol/schemas packages/api/openapi.json packages/client/src/gen
```
Every smoke job (`build-smoke` x64, `smoke-arm64`, `smoke-macos`) gains, after the existing fake-provider run, a daemon step with the same `BIN`, `REPO` and `HOME_DIR` conventions:
```yaml
      - name: smoke (daemon: serve, run through the API, sessions ls, stop)
        run: |
          set -euo pipefail
          BIN=(dist/bytebureau-*-linux-x64)
          [ "${#BIN[@]}" -eq 1 ]
          REPO=$(mktemp -d)
          HOME_DIR=$(mktemp -d)
          git -C "$REPO" init -q -b main
          git -C "$REPO" -c user.name=ci -c user.email=ci@example.com commit -q --allow-empty -m init
          export BYTEBUREAU_HOME="$HOME_DIR"
          "${BIN[0]}" serve --port 0 --json > serve.ndjson
          grep -q '"command":"serve"' serve.ndjson || { cat serve.ndjson; cat "$HOME_DIR"/logs/daemon.log; exit 1; }
          "${BIN[0]}" run "Create src/hello.ts exporting hello()" --project "$REPO" --provider fake --json --yes > events.ndjson
          grep -q '"type":"session.completed"' events.ndjson || { tail -n 3 events.ndjson; cat "$HOME_DIR"/logs/daemon.log; exit 1; }
          "${BIN[0]}" sessions ls --json | grep -q '"status":"completed"'
          "${BIN[0]}" --json | grep -q '"command":"status"'
          "${BIN[0]}" serve --stop
          test ! -f "$HOME_DIR"/server.json
```
(`linux-arm64` and `darwin-arm64` in the other two jobs; the arm64 job `chmod +x` first as today.) The existing in-process smoke keeps running with `--no-daemon` added to its `run` line, so both paths are covered. `.github/workflows/semantic-pr.yml`: the `scopes` list gains `api`, `client` (and `client-codegen` is not a scope: commits to `tools/` use `repo`). `.github/labeler.yml`: `'area: api': packages/api/**`, `'area: client': [packages/client/**, tools/client-codegen/**]`. Run `bun run lint:actions` (actionlint + zizmor pedantic) and fix what it says.

- [ ] **Step 2: Docs**

`apps/docs/src/content/docs/daemon-and-api.md` (English; the Czech site has only the introduction today, so the sidebar entry gets a Czech label only): title "Daemon and API"; sections — *The daemon* (`bytebureau serve`, detached by default, `--no-daemonize`, `--stop`, `--host`/`--port`, `server.json` with its fields and mode, the log at `~/.bytebureau/logs/daemon.log`, one daemon per home, what happens to running sessions at a restart); *Talking to it* (bearer token from `server.json`, `--host`/`--port`/`--token-file` for a daemon elsewhere, `--no-daemon` and when it is refused); *The API* (base path, the groups and endpoints table of Task 4, problem details with the code list, rate limit, body limit, `/api/v1/openapi.json`, `/api/v1/health` without a token); *Events over SSE* (`since`, `Last-Event-ID`, ids, heartbeat, what a slow client misses); *RPC over WebSocket* (the envelopes, the token in request headers, acks, interrupts, origin check); *The client package* (`createBureauClient`, `subscribeEvents`, `connectRpc`, regenerating with `bun run generate:client`). `apps/docs/astro.config.mjs`: add `'daemon-and-api'` after `'architecture'` with `translations: { cs: 'Démon a API' }` in the item form the sidebar uses for labels (`{ label: 'Daemon and API', translations: { cs: 'Démon a API' }, link: '/daemon-and-api/' }`).

`apps/docs/src/content/docs/architecture.md`: the package table gains `packages/api` (FSL, "the HTTP API, SSE and RPC adapters over the kernel") and `packages/client` (MIT, "the generated client, the event subscription and the RPC connection; no Effect at runtime") and `tools/client-codegen`; the run flow paragraph says the CLI talks to the daemon by default and runs the kernel in-process with `--no-daemon`; a "Phase B decisions" list: health at `/api/v1/health` without a token (the one exception), problems per status with literal statuses, the token kept across restarts, `stopped` for sessions a restart interrupted (spec §14), payload redaction at publish (ADR-0012), `effect/rpc` with JSON envelopes and a plain client (ADR-0013), hey-api from a TypeScript 6 tools workspace, `--no-daemon` refused while a daemon runs, `serve --stop`, the bare command as status, heartbeat as an event rather than a comment; the "Deferred to later phases" list is rewritten: the supervisor restart policy (Phase C), profile variables and the `profiles` group (Phase C), the `^0` host API semver policy and `publint`/`arethetypeswrong` (before the first publish), the shared test-support package (the kernel's `testing` export now serves the API; the CLI and the plugin keep their copies until a fifth copy would appear), Scalar docs UI (development only, later), CORS beyond an empty list (SP2), `extends` for configuration presets, timer restoration for asks left pending (sessions a restart interrupted are stopped instead), WebSocket authentication for browsers (first message or ticket, SP2); `plugins add`/`plugins rm` (installing third-party plugins, with the manifest capabilities shown and confirmed) and `doctor`, `diag bundle`, `service`, `upgrade`, `completions` (Phase D); `--output-format` and `--log-file` (Phase D with the full logging).

`CONTRIBUTING.md`, after "Working in the kernel", "Working in the API and the client": `packages/api` may import `effect` and the kernel; handlers call kernel services and map failures with `orProblem`; `bun run --cwd packages/api build` regenerates `openapi.json`, `bun run generate:client` regenerates `packages/client/src/gen` (both committed, both checked in CI); `packages/client` has no Effect at runtime and its generated code is not linted; API tests run the real server on `@effect/platform-node` over `KernelTest`; CLI tests that need the daemon start one with `startDaemonProcess`; never run the daemon tests against `~/.bytebureau` (every helper uses a temp home). `README.md` / `README.cs.md` status line: "Phase B in place: `bytebureau serve` runs the daemon with the HTTP API, SSE and RPC; the CLI talks to it (or runs in-process with `--no-daemon`)" and its Czech twin. (`docs/research/2026-10-02-reports/README.md` already lists report 16; leave it.)

- [ ] **Step 3: Spec amendments**

In `docs/superpowers/specs/2026-10-02-kernel-and-agent-runtime-design.md`, each marked "(amended in Phase B …)":
- §4 `Health`: the check returns `status`, `store` and plugin counts; the API adds version and start time.
- §5.2 `sessions`: `env_json` (the `BYTEBUREAU_*` variables given at creation, read back on resume).
- §5.4 / §12: event payloads are redacted once at publish (ADR-0012).
- §11.1: health is `GET /api/v1/health` (unauthenticated, the one exception); the OpenAPI document is served unauthenticated; errors are one problem schema per status; mutations are rate limited per client (60 at once, 60 a minute); the WebSocket token travels in the RPC request headers and the upgrade checks `Origin`; CORS applies only to configured origins (none by default); the heartbeat is an `event: heartbeat` frame.
- §11.3: `serve` detaches by default (`--no-daemonize` for the foreground) and has `--stop`; the bare command is the status; `--no-daemon` is refused while a daemon runs on the same home; `run` exits 2 with the URL when a daemon named by `--host`/`--port` cannot be reached.
- §14 "Daemon restart": sessions left running are `stopped` (turn `interrupted`, reason `daemon_restart`, asks cancelled), resumable with `resume`.
- §3 / §11.2: the client is generated with hey-api from `packages/api/openapi.json` via `tools/client-codegen`; `publint`/`arethetypeswrong` run before the first publish.

- [ ] **Step 4: Fresh-clone gate and the binary**

Run, from a fresh clone in a temp directory (`git clone <repo> "$TMP" && cd "$TMP" && git checkout <branch>`): `bun install --frozen-lockfile && bun run check && bun run lint:actions && bun run build:binaries --host`, then with `BYTEBUREAU_HOME=$(mktemp -d)` the daemon smoke sequence of Step 1 against `dist/bytebureau-*-darwin-arm64`.
Expected: every command exits 0; `check` reports the coverage thresholds met; the smoke prints `session.completed` and `server.json` is gone after `serve --stop`. If a gate fails, fix it in the task that owns the code and come back.

- [ ] **Step 5: Commit**

```bash
git add .github apps/docs CONTRIBUTING.md README.md README.cs.md docs
git commit -m "docs(repo): describe the daemon, the API and the client; run the daemon in the CI smoke"
```

