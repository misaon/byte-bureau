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

Semantics (as shipped, commits 4a7f5aa, d3c090d): the **first heartbeat goes out at once** (no `Stream.drop(1)`), so an idle stream flushes its headers immediately and a client that keeps ephemeral events sees a `heartbeat` envelope before `session.created` (Tasks 7 and 9 filter durable frames or subscribe with `ephemeral: false`); `sinceOf` ignores an empty or non-numeric `Last-Event-ID` (digits only); `types=` entries are trimmed and empty names dropped (`types=` alone means no filter); `buffered` wakes its reader through a one-slot dropping queue (push and offer in one `Effect.sync`, so no wake-up is lost and no durable event is ever dropped) and logs a failed subscription once under `bb.api`; `DeliveryBuffer` pushes then evicts (capacity 0 works); `readSse`/`EPHEMERAL_CAPACITY` are not exported (knip) and the tests use `framesUntil` with a predicate that waits for a heartbeat *after* the expected durable frames; the resume test resumes after the second durable event and then streams a live turn (it cannot pass vacuously); extra tests `buffered.test.ts`, `sse.test.ts`, `testing-sse.test.ts`, `events-ending.test.ts` (a subscription that ends or fails). Known for the whole-branch review: the per-connection durable backlog has no bound and eviction scans it; a resume with an id above the log's head waits until the seq passes it (kernel `replayedTo = since`); a client that loses deltas is not logged. For Task 8: an open SSE stream holds the server's graceful shutdown (`gracefulShutdownTimeout`), and a stream without `since`/`Last-Event-ID` replays from seq 0.

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

const ephemeral = (id: string): EventEnvelope => ({ ...event(0, 'delta'), id })

// A buffer of the capacity that has been handed the events one after the other
const filled = (capacity: number, events: readonly EventEnvelope[]): DeliveryBuffer => {
  const buffer = new DeliveryBuffer(capacity)
  for (const item of events) {
    buffer.push(item)
  }
  return buffer
}

const idsOf = (buffer: DeliveryBuffer): string[] => buffer.drain().map((item) => item.id)

describe(DeliveryBuffer, () => {
  it('hands events out in the order they came while nothing is dropped', () => {
    const buffer = filled(3, [event(1, 'a'), event(0, 'delta'), event(2, 'b')])
    expect(idsOf(buffer)).toStrictEqual(['e1-a', 'e0-delta', 'e2-b'])
    expect(buffer.drain()).toStrictEqual([])
  })

  it('drops the oldest ephemeral event above the capacity and keeps every durable one', () => {
    const arrivals = [event(1, 'a'), ephemeral('d1'), ephemeral('d2'), event(2, 'b')]
    const buffer = filled(2, [...arrivals, ephemeral('d3'), event(3, 'c')])
    expect(idsOf(buffer)).toStrictEqual(['e1-a', 'd2', 'e2-b', 'd3', 'e3-c'])
    expect(buffer.dropped).toBe(1)
  })

  it('keeps no ephemeral event with a capacity of 0, and still every durable one', () => {
    const buffer = filled(0, [event(1, 'a'), event(0, 'delta'), event(2, 'b')])
    expect(idsOf(buffer)).toStrictEqual(['e1-a', 'e2-b'])
    expect(buffer.dropped).toBe(1)
  })

  it('makes room for ephemeral events again once the ones it holds are taken', () => {
    const buffer = filled(1, [event(0, 'delta')])
    buffer.drain()
    buffer.push(event(0, 'delta'))
    expect(buffer.drain()).toHaveLength(1)
    expect(buffer.dropped).toBe(0)
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
    this.items.push(event)
    if (event.seq === 0) {
      this.ephemeral += 1
      if (this.ephemeral > this.capacity) {
        this.evictOldestEphemeral()
      }
    }
  }

  public drain(): readonly EventEnvelope[] {
    const drained = this.items
    this.items = []
    this.ephemeral = 0
    return drained
  }

  private evictOldestEphemeral(): void {
    const index = this.items.findIndex((item) => item.seq === 0)
    this.items.splice(index, 1)
    this.ephemeral -= 1
    this.dropped += 1
  }
}
```

`packages/api/src/events/buffered.ts`:
```ts
import type { EventEnvelope } from '@bytebureau/protocol'
import { Effect, Queue, Stream, type Cause } from 'effect'
import { logApiWarning } from '../logging.js'
import { DeliveryBuffer } from './delivery-buffer.js'

const EPHEMERAL_CAPACITY = 64

// The source is read as fast as it comes into the buffer; the client takes what the buffer holds whenever it is ready
// A failure of the source is logged and ends the stream: an SSE client resumes from its last id
export const buffered = <Failure>(
  source: Stream.Stream<EventEnvelope, Failure>,
  capacity: number = EPHEMERAL_CAPACITY,
): Stream.Stream<EventEnvelope> =>
  Stream.unwrap(
    Effect.gen(function* startsBuffering() {
      const buffer = new DeliveryBuffer(capacity)
      // One pending wake-up says there is something to take; a take empties the buffer, so more would only pile up
      const wake = yield* Queue.dropping<null, Cause.Done>(1)
      const fill = source.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            buffer.push(event)
            Queue.offerUnsafe(wake, null)
          }),
        ),
        Effect.catchCause((cause) =>
          logApiWarning('an event subscription ended with a failure', cause),
        ),
        Effect.ensuring(Queue.end(wake)),
      )
      yield* Effect.forkScoped(fill)
      return Stream.fromQueue(wake).pipe(
        Stream.map(() => buffer.drain()),
        Stream.flattenIterable,
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
export const heartbeatEvent = (): SseEvent => {
  const at = nowIso()
  return {
    event: 'heartbeat',
    data: { seq: 0, id: uuidv7(), ts: at, type: 'heartbeat', payload: { at } },
  }
}

// An id this server sent is the digits of a seq; an empty or any other text is no id
const SEQ = /^\d+$/u

const seqOf = (lastEventId: string | undefined): number | undefined => {
  if (lastEventId === undefined || !SEQ.test(lastEventId)) {
    return undefined
  }
  const seq = Number(lastEventId)
  return Number.isSafeInteger(seq) ? seq : undefined
}

// The header of a resuming client wins over the query; anything that is not a whole number is ignored
export const sinceOf = (query: EventsQuery, lastEventId: string | undefined): number =>
  seqOf(lastEventId) ?? query.since ?? 0

// The types are comma-separated, with or without blanks around a name; with none listed the stream is not narrowed by type
const typesOf = (types: string | undefined): readonly string[] | undefined => {
  const names = (types ?? '').split(',').map((name) => name.trim())
  const listed = names.filter((name) => name !== '')
  return listed.length === 0 ? undefined : listed
}

export const filterOf = (query: EventsQuery, lastEventId: string | undefined): EventFilter => {
  const types = typesOf(query.types)
  return {
    since: sinceOf(query, lastEventId),
    ...(query.session === undefined ? {} : { sessionId: query.session }),
    ...(query.project === undefined ? {} : { projectId: query.project }),
    ...(types === undefined ? {} : { types }),
  }
}
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
      // Stream.tick fires at once and then every heartbeat; the first beat leaves with the response, so an idle client has its headers at once
      // The beats stop when the events end, so the response ends with them
      const beats = Stream.tick(heartbeat).pipe(Stream.map(() => heartbeatEvent()))
      return Stream.merge(events, beats, { haltStrategy: 'left' })
    }),
  ),
)
```
`Stream.merge` takes `{ haltStrategy: 'left' }` in `effect@4.0.0` (`dist/Stream.d.ts` line 3229: "By default, the merged stream ends when both streams end. Use haltStrategy to change the termination behavior"); if the literal is spelled differently in the `HaltStrategy` type, use the member that ends the merge when the left stream ends. `api.ts` gains `EventsGroup`; the handlers merge gains `EventsHandlers`.

- [ ] **Step 5: The SSE reader for tests and the failing stream tests**

`packages/api/src/testing-sse.ts`:
```ts
import { EventEnvelope } from '@bytebureau/protocol'
import { Effect, Schema } from 'effect'
import type { HttpServer } from 'effect/http'
import { API_PREFIX } from './api.js'
import { authorized, baseUrl } from './testing.js'

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
    fields.set(
      key,
      fields.has(key) && key === 'data' ? `${fields.get(key) ?? ''}\n${value}` : value,
    )
  }
  return {
    id: fields.get('id'),
    event: fields.get('event') ?? 'message',
    data: fields.get('data') ?? '',
  }
}

const textOf = (response: Response, signal: AbortSignal | undefined): ReadableStream<string> => {
  if (response.body === null) {
    throw new Error('the response has no body')
  }
  const options = signal === undefined ? {} : { signal }
  return response.body.pipeThrough(new TextDecoderStream(), options)
}

// The frames of a text/event-stream response, each as soon as its blank line has come
async function* framesOf(
  response: Response,
  signal: AbortSignal | undefined,
): AsyncGenerator<SseFrame> {
  let pending = ''
  for await (const text of textOf(response, signal)) {
    const blocks = (pending + text).split('\n\n')
    pending = blocks.pop() ?? ''
    yield* blocks.filter((block) => block.trim() !== '').map((block) => parseFrame(block))
  }
}

// Reads frames until the predicate says enough or the stream ends; leaving the loop cancels the response, which closes the connection
// An aborted signal stops the reading the same way, so a test that is interrupted leaves no stream open
async function readSse(
  response: Response,
  until: (frames: readonly SseFrame[]) => boolean,
  signal?: AbortSignal,
): Promise<SseFrame[]> {
  const frames: SseFrame[] = []
  for await (const frame of framesOf(response, signal)) {
    frames.push(frame)
    if (until(frames)) {
      break
    }
  }
  return frames
}

// The event stream as a client opens it: the answer is there once the server has sent its headers
// A test that is interrupted while it waits for them aborts the request
export const opened = (
  query = '',
  init: RequestInit = {},
): Effect.Effect<Response, never, HttpServer.HttpServer> =>
  Effect.gen(function* opens() {
    const base = yield* baseUrl
    const url = `${base}${API_PREFIX}/events${query === '' ? '' : `?${query}`}`
    return yield* Effect.promise(async (signal) => {
      const response = await fetch(url, { ...authorized(init), signal })
      return response
    })
  })

// What an open stream sends until the predicate says enough
export const framesUntil = (
  response: Response,
  until: (frames: readonly SseFrame[]) => boolean,
): Effect.Effect<SseFrame[]> =>
  Effect.promise(async (signal) => {
    const frames = await readSse(response, until, signal)
    return frames
  })

// The frames that carry an id are the durable events; the rest are ephemeral
export const durableOf = (frames: readonly SseFrame[]): SseFrame[] =>
  frames.filter((frame) => frame.id !== undefined)

export const seqNumbersOf = (frames: readonly SseFrame[]): number[] =>
  durableOf(frames).map((frame) => Number(frame.id))

// What a frame carries as its data, read through the protocol's schema
export const envelopeOf = (frame: SseFrame): EventEnvelope =>
  Schema.decodeUnknownSync(Schema.fromJsonString(EventEnvelope))(frame.data)
```
The `??` operators are fine (only `?.` is refused); `max-statements` may ask for the loop body to become a helper.

`packages/api/src/events.test.ts`:
```ts
import { EventLog } from '@bytebureau/kernel'
import { decodeEventPayload } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import type { HttpServer } from 'effect/http'
import { API_PREFIX } from './api.js'
import { ApiTestLayer, baseUrl, bodyOf, fetched, get, post } from './testing.js'
import { createdSession } from './testing-sessions.js'
import {
  durableOf,
  envelopeOf,
  framesUntil,
  opened,
  seqNumbersOf,
  type SseFrame,
} from './testing-sse.js'

// The suites run on the live clock: under the test clock the Stream.tick of the heartbeat would never tick
const LIVE = { excludeTestServices: true }
const BEATING = ApiTestLayer({ heartbeat: '100 millis' })

const hasEvent =
  (type: string) =>
  (seen: readonly SseFrame[]): boolean =>
    seen.some((frame) => frame.event === type)

const beats = hasEvent('heartbeat')

const beatsOf = (frames: readonly SseFrame[]): SseFrame[] =>
  frames.filter((frame) => frame.event === 'heartbeat')

const firstOf = (frames: readonly SseFrame[], type: string): SseFrame | undefined =>
  frames.find((frame) => frame.event === type)

const CREATED = ['session.created', 'session.provisioning', 'workspace.provisioned']

const endsWithBeat = (seen: readonly SseFrame[]): boolean => {
  const latest = seen.at(-1)
  return latest !== undefined && latest.event === 'heartbeat'
}

// Read until the durable events have come and a heartbeat has followed them, which shows that nothing else is on its way
// The first heartbeat leaves at once, so having seen one says nothing about the end of the replay: the latest frame has to be one
const replayedWithBeat =
  (count: number) =>
  (seen: readonly SseFrame[]): boolean =>
    seqNumbersOf(seen).length >= count && endsWithBeat(seen)

// The time a heartbeat says it was made at, read the way a client reads it: a payload with nothing but that field
const beatTime = (frame: SseFrame): number =>
  Date.parse(decodeEventPayload('heartbeat', envelopeOf(frame).payload).at)

// The seq numbers the log holds for a session
const loggedSeqNumbers = (sessionId: string): Effect.Effect<number[], never, EventLog> =>
  EventLog.use((log) => log.read({ sessionId }, { from: 0 })).pipe(
    Effect.map((events) => events.map((event) => event.seq)),
    Effect.orDie,
  )

// A prompt starts a turn; the frames of the stream are read up to its start
const throughTurn = (
  sessionId: string,
  response: Response,
): Effect.Effect<SseFrame[], never, HttpServer.HttpServer> =>
  Effect.gen(function* prompts() {
    yield* post(`/sessions/${sessionId}/prompt`, { text: 'go' })
    return yield* framesUntil(response, hasEvent('turn.started'))
  })

it.layer(BEATING, LIVE)('GET /api/v1/events over the fake provider', (suite) => {
  suite.effect(
    'replays the durable events of a session with their seq as id, then the live ones',
    () =>
      Effect.gen(function* streams() {
        const { session } = yield* createdSession
        const response = yield* opened(`session=${session.id}&since=0`)
        assert.strictEqual(response.status, 200)
        assert.include(response.headers.get('content-type'), 'text/event-stream')
        const frames = yield* throughTurn(session.id, response)
        const durable = durableOf(frames).map((frame) => frame.event)
        assert.deepStrictEqual(durable.slice(0, 3), CREATED)
        const logged = yield* loggedSeqNumbers(session.id)
        assert.deepStrictEqual(seqNumbersOf(frames), logged.slice(0, seqNumbersOf(frames).length))
        assert.isAbove(seqNumbersOf(frames).length, 4)
      }),
  )

  suite.effect(
    'sends the envelope as the data of each frame, and no id with an ephemeral one',
    () =>
      Effect.gen(function* streamsDeltas() {
        const { session } = yield* createdSession
        const response = yield* opened(`session=${session.id}`)
        yield* post(`/sessions/${session.id}/prompt`, { text: 'go' })
        const frames = yield* framesUntil(response, hasEvent('tool.started'))
        const delta = yield* Effect.fromNullishOr(firstOf(frames, 'message.assistant.delta'))
        assert.isUndefined(delta.id)
        assert.strictEqual(envelopeOf(delta).seq, 0)
        for (const frame of durableOf(frames)) {
          assert.containSubset(envelopeOf(frame), { type: frame.event, seq: Number(frame.id) })
        }
      }),
  )
})

// How a client says where it resumes: the query, the header, both with the header winning, or a header that says nothing
const RESUMING: [string, (seq: number) => { query: string; headers: Record<string, string> }][] = [
  ['the since query', (seq) => ({ query: `&since=${seq}`, headers: {} })],
  ['the Last-Event-ID header', (seq) => ({ query: '', headers: { 'last-event-id': String(seq) } })],
  [
    'the header over the query',
    (seq) => ({ query: '&since=0', headers: { 'last-event-id': String(seq) } }),
  ],
  [
    'the query beside a header of no number',
    (seq) => ({ query: `&since=${seq}`, headers: { 'last-event-id': 'soon' } }),
  ],
]

it.layer(BEATING, LIVE)('GET /api/v1/events resumes a client', (suite) => {
  suite.effect('from its Last-Event-ID after a lost connection, without a gap or a duplicate', () =>
    Effect.gen(function* resumes() {
      const { session } = yield* createdSession
      const first = yield* opened(`session=${session.id}`)
      const head = yield* framesUntil(first, (seen) => seqNumbersOf(seen).length >= 2)
      const lastSeen = yield* Effect.fromNullishOr(seqNumbersOf(head).at(1))
      const headers = { 'last-event-id': String(lastSeen) }
      const second = yield* opened(`session=${session.id}`, { headers })
      const tail = yield* throughTurn(session.id, second)
      const expected = (yield* loggedSeqNumbers(session.id)).filter((seq) => seq > lastSeen)
      assert.deepStrictEqual(seqNumbersOf(tail), expected.slice(0, seqNumbersOf(tail).length))
      assert.isAbove(seqNumbersOf(tail).length, 2)
    }),
  )

  suite.effect.each(RESUMING)('replays what follows the seq it is given by %s', ([, resume]) =>
    Effect.gen(function* replays() {
      const { session } = yield* createdSession
      const logged = yield* loggedSeqNumbers(session.id)
      const seen = yield* Effect.fromNullishOr(logged.at(1))
      const { query, headers } = resume(seen)
      const response = yield* opened(`session=${session.id}${query}`, { headers })
      const unseen = logged.slice(2)
      const frames = yield* framesUntil(response, replayedWithBeat(unseen.length))
      assert.deepStrictEqual(seqNumbersOf(frames), unseen)
    }),
  )
})

// The heartbeat test stays first: with other requests before it, closing the Node server at the end of this suite waited 3 s on a keep-alive connection (a bare http server and fetch do the same)
it.layer(BEATING, LIVE)('GET /api/v1/events beats and narrows', (suite) => {
  suite.effect('sends heartbeat frames without an id, one interval apart', () =>
    Effect.gen(function* beating() {
      const response = yield* opened('since=1000000')
      const frames = yield* framesUntil(response, (seen) => beatsOf(seen).length >= 2)
      const first = yield* Effect.fromNullishOr(beatsOf(frames).at(0))
      const second = yield* Effect.fromNullishOr(beatsOf(frames).at(1))
      assert.isUndefined(first.id)
      assert.containSubset(envelopeOf(first), { type: 'heartbeat', seq: 0 })
      assert.isAtLeast(beatTime(second) - beatTime(first), 90)
    }),
  )

  suite.effect('carries only the project and the types it is asked for', () =>
    Effect.gen(function* narrows() {
      const { project, session } = yield* createdSession
      yield* createdSession
      const response = yield* opened(`project=${project.id}&types=session.created,session.ready`)
      const durable = durableOf(yield* framesUntil(response, replayedWithBeat(2)))
      assert.deepStrictEqual(
        durable.map((frame) => frame.event),
        ['session.created', 'session.ready'],
      )
      const sessions = durable.map((frame) => envelopeOf(frame).sessionId)
      assert.deepStrictEqual(sessions, [session.id, session.id])
    }),
  )
})

// A heartbeat an hour apart: only a first beat that leaves at once answers an idle client in time
const IDLE = ApiTestLayer({ heartbeat: '1 hour' })

it.layer(IDLE, LIVE)('GET /api/v1/events of a client that has nothing to replay', (suite) => {
  suite.effect('has its headers and a first heartbeat at once, without waiting an interval', () =>
    Effect.gen(function* opensAtOnce() {
      const response = yield* opened('since=1000000').pipe(Effect.timeout('5 seconds'))
      assert.strictEqual(response.status, 200)
      const frames = yield* framesUntil(response, beats).pipe(Effect.timeout('5 seconds'))
      assert.deepStrictEqual(
        frames.map((frame) => frame.event),
        ['heartbeat'],
      )
    }),
  )
})

it.layer(ApiTestLayer())('GET /api/v1/events refuses', (suite) => {
  suite.effect('a missing token with 401, and a since that is no number with 400', () =>
    Effect.gen(function* refuses() {
      const base = yield* baseUrl
      const noToken = yield* fetched(`${base}${API_PREFIX}/events`)
      assert.strictEqual(noToken.status, 401)
      assert.containSubset(yield* bodyOf(noToken), { code: 'unauthorized' })
      const badSince = yield* get('/events?since=soon')
      assert.strictEqual(badSince.status, 400)
      assert.containSubset(badSince.body, { code: 'request_invalid' })
    }),
  )
})
```
`authorized({ headers })` merges its own header into the given ones (Task 3 wrote it so); the `?.`/`??` pairs on `durable[0]` need the lint-friendly form (`const [firstFrame] = durable; if (firstFrame === undefined) throw …`). The exact first three durable types come from the kernel's create path (`session.created`, `session.provisioning`, `workspace.provisioned`, `session.ready`, …): read what `EventLog.read` returns once and pin that order.

`packages/api/src/events/buffered.test.ts` (added during execution):
```ts
import type { EventEnvelope } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect, Latch, Logger, References, Stream } from 'effect'
import { buffered } from './buffered.js'

const event = (seq: number, id: string): EventEnvelope => ({
  seq,
  id,
  ts: '2026-10-04T00:00:00.000Z',
  type: seq === 0 ? 'message.assistant.delta' : 'turn.started',
  payload: {},
})

const idsOf = (events: readonly EventEnvelope[]): string[] => events.map((item) => item.id)

interface LogLine {
  readonly level: string
  readonly category: unknown
}

it.effect('hands on the events of its source in their order and ends with the source', () =>
  Effect.gen(function* passesOn() {
    const source = Stream.make(event(1, 'a'), event(0, 'd1'), event(2, 'b'))
    const read = yield* Stream.runCollect(buffered(source))
    assert.deepStrictEqual(idsOf(read), ['a', 'd1', 'b'])
  }),
)

it.effect('drops the oldest ephemeral events a reader has not taken, and no durable one', () =>
  Effect.gen(function* outruns() {
    // A source that gives all its events in one go is read to the end before the reader runs
    const events = [event(1, 'a'), event(0, 'd1'), event(0, 'd2'), event(0, 'd3'), event(2, 'b')]
    const read = yield* Stream.runCollect(buffered(Stream.fromIterable(events), 2))
    assert.deepStrictEqual(idsOf(read), ['a', 'd2', 'd3', 'b'])
  }),
)

it.effect('ends instead of failing when its source fails, and logs the failure under bb.api', () =>
  Effect.gen(function* survives() {
    const lines: LogLine[] = []
    const logger = Logger.make((options) => {
      const { category } = options.fiber.getRef(References.CurrentLogAnnotations)
      lines.push({ level: options.logLevel, category })
    })
    const failure = Stream.fail(new Error('gone'))
    const source = Stream.make(event(1, 'a')).pipe(Stream.concat(failure))
    const logging = Logger.layer([logger])
    const read = yield* Stream.runCollect(buffered(source)).pipe(Effect.provide(logging))
    assert.deepStrictEqual(idsOf(read), ['a'])
    assert.deepStrictEqual(lines, [{ level: 'Warn', category: 'bb.api' }])
  }),
)

it.effect('stops reading its source once the reader is gone', () =>
  Effect.gen(function* stops() {
    const stopped = yield* Latch.make()
    const source = Stream.make(event(1, 'a')).pipe(
      Stream.concat(Stream.never),
      Stream.ensuring(stopped.open),
    )
    const firstOnly = buffered(source).pipe(Stream.take(1))
    const read = yield* Stream.runCollect(firstOnly)
    assert.deepStrictEqual(idsOf(read), ['a'])
    assert.isTrue(Latch.isOpen(stopped))
  }),
)
```
`packages/api/src/events/sse.test.ts` (added during execution):
```ts
import type { EventEnvelope } from '@bytebureau/protocol'
import { describe, expect, it } from 'vitest'
import { filterOf, heartbeatEvent, sinceOf, toSseEvent } from './sse.js'

const envelope = (seq: number): EventEnvelope => ({
  seq,
  id: 'e1',
  ts: '2026-10-04T00:00:00.000Z',
  type: 'turn.started',
  payload: {},
})

describe(toSseEvent, () => {
  it('names a durable event by its seq and gives an ephemeral one no id', () => {
    const durable = { id: '7', event: 'turn.started', data: envelope(7) }
    expect(toSseEvent(envelope(7))).toStrictEqual(durable)
    expect(toSseEvent(envelope(0))).toStrictEqual({ event: 'turn.started', data: envelope(0) })
  })
})

describe(heartbeatEvent, () => {
  it('is an ephemeral envelope of the type heartbeat, stamped with the time of the beat', () => {
    const { id, event, data } = heartbeatEvent()
    expect(id).toBeUndefined()
    expect(event).toBe('heartbeat')
    expect(data).toMatchObject({ seq: 0, type: 'heartbeat', payload: { at: data.ts } })
  })
})

describe(sinceOf, () => {
  it.each([
    { given: 'nothing', query: {}, header: undefined, expected: 0 },
    { given: 'the query alone', query: { since: 5 }, header: undefined, expected: 5 },
    { given: 'the header over the query', query: { since: 5 }, header: '3', expected: 3 },
    { given: 'a header of 0 over the query', query: { since: 5 }, header: '0', expected: 0 },
    { given: 'the header alone', query: {}, header: '12', expected: 12 },
    { given: 'a header that is no number', query: { since: 5 }, header: 'soon', expected: 5 },
    { given: 'an empty header', query: { since: 5 }, header: '', expected: 5 },
    { given: 'a negative header', query: { since: 5 }, header: '-1', expected: 5 },
    { given: 'a header with a fraction', query: { since: 5 }, header: '2.5', expected: 5 },
    { given: 'a header too big', query: { since: 5 }, header: '9007199254740993', expected: 5 },
  ])('reads $given', ({ query, header, expected }) => {
    expect(sinceOf(query, header)).toBe(expected)
  })
})

describe(filterOf, () => {
  it('maps the query to the filter of the kernel, the header deciding where the stream resumes', () => {
    const query = { since: 4, session: 's1', project: 'p1', types: 'turn.started,,session.ready,' }
    expect(filterOf(query, '9')).toStrictEqual({
      since: 9,
      sessionId: 's1',
      projectId: 'p1',
      types: ['turn.started', 'session.ready'],
    })
  })

  it.each([
    {
      given: 'names with blanks around them',
      query: { types: ' session.created, session.ready ,tool.started' },
      header: undefined,
      expected: { since: 0, types: ['session.created', 'session.ready', 'tool.started'] },
    },
    { given: 'nothing', query: {}, header: undefined, expected: { since: 0 } },
    {
      given: 'a list of no type',
      query: { types: ',' },
      header: undefined,
      expected: { since: 0 },
    },
    {
      given: 'a list of blanks',
      query: { types: ' , ' },
      header: undefined,
      expected: { since: 0 },
    },
  ])('maps $given to the filter of the kernel', ({ query, header, expected }) => {
    expect(filterOf(query, header)).toStrictEqual(expected)
  })
})
```
`packages/api/src/testing-sse.test.ts` (added during execution):
```ts
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { framesUntil } from './testing-sse.js'

interface Served {
  readonly response: Response
  readonly cancelled: () => boolean
}

// A response whose body arrives in the chunks given; with open set it never ends by itself
const served = (chunks: readonly string[], open = false): Served => {
  const encoder = new TextEncoder()
  let wasCancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      if (!open) {
        controller.close()
      }
    },
    cancel(): void {
      wasCancelled = true
    },
  })
  return { response: new Response(body), cancelled: () => wasCancelled }
}

const never = (): boolean => false

it.effect('reads the frames whatever the chunks they arrive in', () =>
  Effect.gen(function* reads() {
    const { response } = served([
      'id: 7\neve',
      'nt: turn.started\nda',
      'ta: {"a":"é"}\n',
      '\nid: 8\n\n',
    ])
    const frames = yield* framesUntil(response, never)
    assert.deepStrictEqual(frames, [
      { id: '7', event: 'turn.started', data: '{"a":"é"}' },
      { id: '8', event: 'message', data: '' },
    ])
  }),
)

it.effect('joins the lines of data and reads a line without a colon as an empty field', () =>
  Effect.gen(function* joins() {
    const { response } = served(['data: one\ndata: two\n\nevent\ndata\n\n'])
    const frames = yield* framesUntil(response, never)
    assert.deepStrictEqual(frames, [
      { id: undefined, event: 'message', data: 'one\ntwo' },
      { id: undefined, event: '', data: '' },
    ])
  }),
)

it.effect('stops at the frame that is enough and cancels the response', () =>
  Effect.gen(function* stops() {
    const { response, cancelled } = served(['id: 1\ndata: a\n\nid: 2\ndata: b\n\n'], true)
    const frames = yield* framesUntil(response, (seen) => seen.length === 1)
    assert.deepStrictEqual(frames, [{ id: '1', event: 'message', data: 'a' }])
    assert.isTrue(cancelled())
  }),
)

it.effect('refuses a response without a body', () =>
  Effect.gen(function* refuses() {
    const attempt = framesUntil(new Response(null), never)
    const failure = yield* Effect.flip(Effect.sandbox(attempt))
    assert.include(String(failure), 'the response has no body')
  }),
)
```
`packages/api/src/events-ending.test.ts` (added during execution):
```ts
import { createServer } from 'node:http'
import { EventLog, StoreError } from '@bytebureau/kernel'
import type { EventEnvelope } from '@bytebureau/protocol'
import { NodeHttpServer } from '@effect/platform-node'
import { assert, it } from '@effect/vitest'
import { Effect, Layer, Logger, References, Stream } from 'effect'
import { serveApi } from './layer.js'
import { testOptions, type ApiTestLayer } from './testing.js'
import { BootedKernel } from './testing-kernel.js'
import { framesUntil, opened, seqNumbersOf } from './testing-sse.js'

const envelope = (seq: number): EventEnvelope => ({
  seq,
  id: `e${seq}`,
  ts: '2026-10-04T00:00:00.000Z',
  type: 'turn.started',
  payload: {},
})

interface LogLine {
  readonly level: string
  readonly category: unknown
}

// A logger of its own for each suite, and the lines it has been given: the level and the category (the listening lines among them)
const collecting = (): { logger: Logger.Logger<unknown, void>; lines: LogLine[] } => {
  const lines: LogLine[] = []
  const logger = Logger.make((options) => {
    const { category } = options.fiber.getRef(References.CurrentLogAnnotations)
    lines.push({ level: options.logLevel, category })
  })
  return { logger, lines }
}

const warningsOf = (lines: readonly LogLine[]): LogLine[] =>
  lines.filter((line) => line.level === 'Warn')

// The API over a log whose subscription is the one given; the logger sits next to the API, where its requests see it
const over = (
  subscription: Stream.Stream<EventEnvelope, StoreError>,
  logger: Logger.Logger<unknown, void>,
): ReturnType<typeof ApiTestLayer> => {
  const log = Layer.succeed(
    EventLog,
    EventLog.of({
      publish: () => Effect.die('the stream publishes nothing'),
      read: () => Effect.die('the stream reads only through its subscription'),
      subscribe: () => subscription,
    }),
  )
  return serveApi(testOptions({ heartbeat: '100 millis' })).pipe(
    Layer.provide(Logger.layer([logger])),
    Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port: 0, host: '127.0.0.1' })),
    Layer.provideMerge(log),
    Layer.provideMerge(BootedKernel),
  )
}

// The frames of the whole response, which has to end by itself
const wholeStream = Effect.gen(function* reads() {
  const response = yield* opened()
  return yield* framesUntil(response, () => false).pipe(Effect.timeout('5 seconds'))
})

const live = { excludeTestServices: true }

const ended = collecting()
const endingSubscription = Stream.make(envelope(1), envelope(2))

it.layer(over(endingSubscription, ended.logger), live)(
  'GET /api/v1/events when the subscription ends',
  (suite) => {
    suite.effect('ends the response with it, after the events it gave, without a word', () =>
      Effect.gen(function* ends() {
        assert.deepStrictEqual(seqNumbersOf(yield* wholeStream), [1, 2])
        assert.deepStrictEqual(warningsOf(ended.lines), [])
      }),
    )
  },
)

const failed = collecting()
const gone = new StoreError({ cause: new Error('the store is gone') })
const failingSubscription = Stream.make(envelope(1)).pipe(Stream.concat(Stream.fail(gone)))

it.layer(over(failingSubscription, failed.logger), live)(
  'GET /api/v1/events when the subscription fails',
  (suite) => {
    suite.effect('ends the response after the events it gave, and logs the failure', () =>
      Effect.gen(function* fails() {
        assert.deepStrictEqual(seqNumbersOf(yield* wholeStream), [1])
        assert.deepStrictEqual(warningsOf(failed.lines), [{ level: 'Warn', category: 'bb.api' }])
      }),
    )
  },
)
```

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

Semantics (as shipped, commits a44eb43, 82e2ae8, d230d18): the Effect RPC server behaves as the fact sheet says (frames of a call, a refusal, a subscription with ack and interrupt, and a ping are in the task report) — the `effect/rpc` ruling holds. **Mutations over the socket are rate limited** (`rpc/limit.ts`, an `RpcMiddleware` on every procedure but `events.subscribe`) from the same `TokenBuckets` as REST through the `MutationBuckets` service (`mutation-buckets.ts`), keyed by the client's remote address — captured *before* the upgrade by `rpc/upgrade.ts` (`request.modify({ remoteAddress })` provided to the upgrade effect), because Bun forgets a request's address once the socket is open (a Bun probe of the shipped code showed one budget for both doors; Node keeps the address anyway); authentication runs before the limit, so a tokenless flood drains nothing. **The origin guard** (`rpc/origin.ts`) admits an absent `Origin`, a configured origin, or a loopback-named origin (`localhost`, `127.0.0.1`, `[::1]`) whose port equals the `Host` header's port — never the request's own `Host` name (DNS rebinding); an unparsable `Origin` gets 403; a guarded request without `Upgrade` answers Effect's empty 400. `disableFatalDefects: true`, so a handler defect answers that request's `Exit` with a `Die` cause (`{ name, message }`, no stack) and the socket stays open; a `Request` without `headers` closes the socket with 1011 (ADR-0013 says both). `projects.remove` over RPC checks existence first (as REST does; `projectOf` lives in `handlers/found.ts`); `Routes`/`OPENAPI_PATH` moved to `routes.ts`, the requirement aliases to `requirements.ts`; the test client opens its socket in the test's scope; tests: `rpc.test.ts`, `rpc-limit.test.ts`, `rpc-origin.test.ts`, `rpc-defect.test.ts`, `rpc/auth.test.ts`, `rpc/origin.test.ts`, `rpc/upgrade.test.ts`. For the whole-branch review: no CI test runs the Bun upgrade path (the unit stub and the probe carry it); neither door logs a handler defect until Task 8's error reporter; a token sent only on the upgrade is accepted by Effect too (a token in the request overrides it); a schema failure or unknown tag answers a `Die` before authentication.

- [ ] **Step 1: The group with middleware, the middleware, the handlers**

`packages/api/src/rpc/group.ts`:
```ts
import { BureauRpcs } from '@bytebureau/protocol'
import { RpcAuthorization } from './auth.js'
import { RpcMutationLimit } from './limit.js'

export const WS_PATH = '/api/v1/ws'

// Every procedure, the subscription included, carries the bearer token in the headers of its request
// The middleware added last wraps the others: a request without a valid token is refused before it costs a token of the limit
export const BureauRpcsWithAuth =
  BureauRpcs.middleware(RpcMutationLimit).middleware(RpcAuthorization)
```

`packages/api/src/rpc/auth.ts`:
```ts
import { Problem } from '@bytebureau/protocol'
import { Effect, Layer, Option, Redacted } from 'effect'
import { Headers } from 'effect/http'
import { RpcMiddleware } from 'effect/rpc'
import { sameToken, UNAUTHORIZED } from '../auth.js'

export class RpcAuthorization extends RpcMiddleware.Service<RpcAuthorization>()(
  'bb/api/RpcAuthorization',
  { error: Problem, requiredForClient: true },
) {}

const BEARER = 'bearer '

// The token of a request: the authorization header of its envelope, whatever the case of the scheme
// The headers come from the wire as the client wrote them, so a value that is no text carries no token
export const bearerOf = (headers: Headers.Headers): string | undefined => {
  const value = Option.getOrUndefined(Headers.get(headers, 'authorization'))
  if (typeof value !== 'string' || !value.toLowerCase().startsWith(BEARER)) {
    return undefined
  }
  return value.slice(BEARER.length).trim()
}

// Built the way AuthorizationLive is: an empty token is a programming error and dies at construction
export const RpcAuthorizationLive = (token: Redacted.Redacted): Layer.Layer<RpcAuthorization> =>
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
import { projectOf } from '../handlers/found.js'
import { orProblem } from '../problems.js'
import { BureauRpcsWithAuth } from './group.js'

// The same kernel calls as the REST handlers, reached over the socket
export const RpcHandlers = BureauRpcsWithAuth.toLayer({
  'events.subscribe': (filter) =>
    Stream.unwrap(EventLog.use((log) => Effect.succeed(buffered(log.subscribe(filter))))),
  'projects.register': ({ path }) =>
    orProblem(ProjectRegistry.use((registry) => registry.register(path))),
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
```
The subscription's stream must fail with nothing (`events.subscribe` declares no error); `buffered` ends on a failure instead of failing, so the types line up. `EventFilter`'s optional keys are `string | undefined` while the RPC payload's are absent-or-string; if the compiler objects, spread the payload into a fresh `EventFilter` the way `filterOf` does in Task 5.

- [ ] **Step 2: The route with the origin guard**

`packages/api/src/rpc/route.ts`:
```ts
import type { KernelServices } from '@bytebureau/kernel'
import { Effect, Layer, type Redacted } from 'effect'
import { HttpRouter } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import type { MutationBuckets } from '../mutation-buckets.js'
import { RpcAuthorizationLive } from './auth.js'
import { BureauRpcsWithAuth, WS_PATH } from './group.js'
import { RpcHandlers } from './handlers.js'
import { RpcMutationLimitLive } from './limit.js'
import { guardedUpgrade } from './upgrade.js'

export interface RpcRouteOptions {
  readonly token: Redacted.Redacted
  readonly corsOrigins: readonly string[]
}

// GET /api/v1/ws: the RPC server of the group behind the origin check, with its handlers, its middlewares and JSON frames
// Before the upgrade, an origin that may not open the socket is turned away and the address of the client is captured
// A defect of a handler ends that request with a Die instead of a Defect for the whole connection
export const RpcRoute = (
  options: RpcRouteOptions,
): Layer.Layer<never, never, HttpRouter.HttpRouter | KernelServices | MutationBuckets> =>
  HttpRouter.use((router) =>
    Effect.gen(function* registersRpc() {
      const upgrade = yield* RpcServer.toHttpEffectWebsocket(BureauRpcsWithAuth, {
        disableFatalDefects: true,
      })
      yield* router.add('GET', WS_PATH, guardedUpgrade(upgrade, options.corsOrigins))
    }),
  ).pipe(
    Layer.provide(RpcHandlers),
    Layer.provide(RpcAuthorizationLive(options.token)),
    Layer.provide(RpcMutationLimitLive),
    Layer.provide(RpcSerialization.layerJson),
  )
```
`packages/api/src/layer.ts`: `ApiLive` merges `RpcRoute({ token: options.token, corsOrigins: options.corsOrigins })` next to the API builder layer and the CORS layer. Export the route's requirements through the same `ApiRequirements` alias (the handlers need the kernel services the alias already names).

- [ ] **Step 3: A test client of the wire protocol and the failing tests**

`packages/api/src/testing-ws.ts`:
```ts
import { EventEnvelope } from '@bytebureau/protocol'
import { Effect, Queue, Schema, type Cause, type Scope } from 'effect'
import type { HttpServer } from 'effect/http'
import { WS_PATH } from './rpc/group.js'
import { baseUrl } from './testing.js'

// One envelope of effect/rpc as it travels: Request, Ack, Interrupt, Ping from the client; Chunk, Exit, Defect, Pong from the server
export interface WsMessage {
  readonly _tag: string
  readonly [key: string]: unknown
}

const isMessage = (item: unknown): item is WsMessage =>
  typeof item === 'object' && item !== null && typeof Reflect.get(item, '_tag') === 'string'

// A frame holds one message or a batch of them
const messagesOf = (text: string): WsMessage[] => {
  const parsed: unknown = JSON.parse(text)
  const items: readonly unknown[] = Array.isArray(parsed) ? parsed : [parsed]
  return items.filter((item) => isMessage(item))
}

export const tagOf = ({ _tag: tag }: WsMessage): string => tag

export interface WsClient {
  // One message, one frame
  readonly send: (message: object) => void
  // The next message the server sent, in order; fails with Done once the socket has closed and nothing is left
  readonly next: Effect.Effect<WsMessage, Cause.Done>
}

type Inbox = Queue.Queue<WsMessage, Cause.Done>

const listen = (socket: WebSocket, inbox: Inbox): void => {
  socket.addEventListener('message', (event) => {
    for (const message of messagesOf(String(event.data))) {
      Queue.offerUnsafe(inbox, message)
    }
  })
  socket.addEventListener('close', () => {
    Queue.endUnsafe(inbox)
  })
}

// The global WebSocket of Node and Bun, which take headers (a browser sends none but its Origin)
// The inbox listens from the start, so nothing the server sends right after the upgrade is lost
const opened = (
  url: string,
  headers: Readonly<Record<string, string>>,
  inbox: Inbox,
): Effect.Effect<WebSocket, Error> =>
  Effect.callback<WebSocket, Error>((resume) => {
    const socket = new WebSocket(url, { headers: { ...headers } })
    listen(socket, inbox)
    const failed = (): void => {
      resume(Effect.fail(new Error(`cannot open ${url}`)))
    }
    socket.addEventListener(
      'open',
      () => {
        resume(Effect.succeed(socket))
      },
      { once: true },
    )
    socket.addEventListener('error', failed, { once: true })
    return Effect.sync(() => {
      socket.close()
    })
  })

// A client of the wire protocol; the socket closes with the scope of the test, whatever its outcome
const wsClient = (
  url: string,
  headers: Readonly<Record<string, string>> = {},
): Effect.Effect<WsClient, Error, Scope.Scope> =>
  Effect.gen(function* opensClient() {
    const inbox = yield* Queue.unbounded<WsMessage, Cause.Done>()
    const socket = yield* Effect.acquireRelease(opened(url, headers, inbox), (open) =>
      Effect.sync(() => {
        open.close()
      }),
    )
    return {
      send: (message) => {
        socket.send(JSON.stringify(message))
      },
      next: Queue.take(inbox),
    }
  })

// A client of the RPC socket of the server under test; a browser would send its Origin among the headers
export const connected = (
  headers: Readonly<Record<string, string>> = {},
): Effect.Effect<WsClient, Error, HttpServer.HttpServer | Scope.Scope> =>
  baseUrl.pipe(
    Effect.flatMap((base) => wsClient(`${base.replace(/^http/u, 'ws')}${WS_PATH}`, headers)),
  )

// Reads until a message satisfies the predicate and gives every message read, that one last
// An ack follows each chunk when the stream is named, so the stream keeps coming
export const readUntil = (
  client: WsClient,
  done: (message: WsMessage) => boolean,
  ackOf?: string,
): Effect.Effect<WsMessage[], Cause.Done> =>
  Effect.gen(function* reads() {
    const read: WsMessage[] = []
    let finished = false
    while (!finished) {
      const message = yield* client.next
      read.push(message)
      if (ackOf !== undefined && tagOf(message) === 'Chunk') {
        client.send({ _tag: 'Ack', requestId: ackOf })
      }
      finished = done(message)
    }
    return read
  })

// The events a chunk carries, read through the protocol's schema as a client reads them
export const envelopesOf = (message: WsMessage | undefined): readonly EventEnvelope[] =>
  message === undefined || tagOf(message) !== 'Chunk'
    ? []
    : Schema.decodeUnknownSync(Schema.Array(EventEnvelope))(message['values'])

export interface RequestEnvelope {
  readonly id: string
  readonly tag: string
  readonly payload: unknown
  // Sent as the authorization header of the request; without one the request carries no header
  readonly token?: string | undefined
}

export const request = ({ id, tag, payload, token }: RequestEnvelope): object => ({
  _tag: 'Request',
  id,
  tag,
  payload,
  headers: token === undefined ? [] : [['authorization', `Bearer ${token}`]],
})

// Sends the request and gives the next message, which for a procedure alone on its socket is its exit
export const called = (
  client: WsClient,
  envelope: RequestEnvelope,
): Effect.Effect<WsMessage, Cause.Done> =>
  Effect.suspend(() => {
    client.send(request(envelope))
    return client.next
  })
```
Both Bun's and Node's (undici) global `WebSocket` accept a non-standard `{ headers }` second argument (fact sheet §4.4, verified on Node 24, Node 26 and Bun 1.4.2); browsers do not, which is why the token travels in the RPC request headers and not in the upgrade. The `as` cast is avoided by the type guard; `Object(event.data)` is not needed since `event.data` is a string for text frames.

`packages/api/src/rpc.test.ts`:
```ts
import { EventLog, type StoreError } from '@bytebureau/kernel'
import { createTempRepo } from '@bytebureau/kernel/testing'
import { ProjectDto, PruneReportDto, SessionDto, type EventEnvelope } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect, Schema, type Cause, type Scope } from 'effect'
import type { HttpServer } from 'effect/http'
import { UNAUTHORIZED } from './auth.js'
import { ApiTestLayer, get, TEST_TOKEN } from './testing.js'
import { createdSession, registeredProject, UNKNOWN_ID } from './testing-sessions.js'
import {
  called,
  connected,
  envelopesOf,
  readUntil,
  request,
  tagOf,
  type WsClient,
  type WsMessage,
} from './testing-ws.js'

// Far longer than an event takes to reach a subscriber that is free to receive it
const QUIET = '300 millis'

interface Subscribed {
  readonly client: WsClient
  readonly first: WsMessage
}

// A client subscribed to the events of a session since the start, and the first message of the stream
const subscribed = (
  sessionId: string,
  id: string,
): Effect.Effect<Subscribed, Error | Cause.Done, HttpServer.HttpServer | Scope.Scope> =>
  Effect.gen(function* subscribes() {
    const client = yield* connected()
    const payload = { sessionId, since: 0 }
    client.send(request({ id, tag: 'events.subscribe', payload, token: TEST_TOKEN }))
    return { client, first: yield* client.next }
  })

// A durable event of the session, published while its subscription waits for an ack
const warned = (sessionId: string): Effect.Effect<EventEnvelope, StoreError, EventLog> =>
  EventLog.use((log) =>
    log.publish({
      type: 'session.warning',
      sessionId,
      payload: { kind: 'probe', message: 'published while a chunk waits for its ack' },
    }),
  )

const isExit = (message: WsMessage): boolean => tagOf(message) === 'Exit'

const isWarning = (message: WsMessage): boolean =>
  envelopesOf(message).some((event) => event.type === 'session.warning')

// The exits of a register, a create and a prune as a client reads them, through the protocol's schemas
const Registered = Schema.Struct({ exit: Schema.Struct({ value: ProjectDto }) })
const Created = Schema.Struct({ exit: Schema.Struct({ value: SessionDto }) })
const Pruned = Schema.Struct({ exit: Schema.Struct({ value: PruneReportDto }) })

interface CreatedOver {
  readonly session: SessionDto
  readonly worktree: string
}

// A session of the project created over the socket, and the path of its worktree
const createdOver = (
  client: WsClient,
  projectId: string,
): Effect.Effect<CreatedOver, Cause.Done | Cause.NoSuchElementError> =>
  Effect.gen(function* creates() {
    const payload = { projectId, title: 'Over the socket' }
    const answer = yield* called(client, {
      id: 'create',
      tag: 'sessions.create',
      payload,
      token: TEST_TOKEN,
    })
    const session = Schema.decodeUnknownSync(Created)(answer).exit.value
    const workspace = yield* Effect.fromNullishOr(session.workspace)
    return { session, worktree: workspace.path }
  })

// What the prune of a project over the socket reports
const prunedOver = (
  client: WsClient,
  projectId: string,
): Effect.Effect<PruneReportDto, Cause.Done> =>
  called(client, {
    id: 'prune',
    tag: 'workspaces.prune',
    payload: { projectId },
    token: TEST_TOKEN,
  }).pipe(Effect.map((answer) => Schema.decodeUnknownSync(Pruned)(answer).exit.value))

const SUCCEEDED = { exit: { _tag: 'Success' } }

// The failure of a procedure the kernel refused, told by the code of its problem
const refusedWith = (code: string): object => ({
  exit: { _tag: 'Failure', cause: [{ _tag: 'Fail', error: { code } }] },
})

// The other procedures on a ready session, in an order the kernel accepts, and what each answers
const lifecycle = (sessionId: string): [string, object, object][] => [
  ['sessions.interrupt', { sessionId }, refusedWith('session_not_found')],
  ['sessions.stop', { sessionId }, SUCCEEDED],
  ['sessions.resume', { sessionId }, { exit: { value: { id: sessionId, status: 'ready' } } }],
  ['sessions.complete', { sessionId }, SUCCEEDED],
  [
    'sessions.prompt',
    { sessionId, input: { text: 'more' } },
    refusedWith('session_invalid_transition'),
  ],
  ['asks.answer', { askId: UNKNOWN_ID, answer: { selected: ['x'] } }, refusedWith('ask_not_found')],
]

// What a refused request carries: no authorization header, or a token that is not the daemon's
const REFUSED: [string, string | undefined][] = [
  ['no token', undefined],
  ['a wrong token', 'not-the-token'],
]

it.layer(ApiTestLayer())('procedures over the WebSocket of /api/v1/ws', (suite) => {
  suite.effect('runs a procedure with the token in its headers and answers with its exit', () =>
    Effect.gen(function* calls() {
      const client = yield* connected()
      const repo = createTempRepo()
      const register = { id: '1', tag: 'projects.register', payload: { path: repo } }
      assert.containSubset(yield* called(client, { ...register, token: TEST_TOKEN }), {
        _tag: 'Exit',
        requestId: '1',
        exit: { _tag: 'Success', value: { path: repo } },
      })
    }),
  )

  suite.effect('fails a procedure with its problem: a project removed twice is not found', () =>
    Effect.gen(function* refusesRemoval() {
      const client = yield* connected()
      const payload = { path: createTempRepo() }
      const register = { id: '5', tag: 'projects.register', payload, token: TEST_TOKEN }
      const { exit } = Schema.decodeUnknownSync(Registered)(yield* called(client, register))
      const removal = { tag: 'projects.remove', payload: { id: exit.value.id }, token: TEST_TOKEN }
      const removed = yield* called(client, { ...removal, id: '6' })
      assert.containSubset(removed, { requestId: '6', exit: { _tag: 'Success' } })
      const notFound = { _tag: 'Fail', error: { status: 404, code: 'not_found' } }
      const again = yield* called(client, { ...removal, id: '7' })
      assert.containSubset(again, { requestId: '7', exit: { _tag: 'Failure', cause: [notFound] } })
    }),
  )

  suite.effect('answers a ping with a pong', () =>
    Effect.gen(function* pings() {
      const client = yield* connected()
      client.send({ _tag: 'Ping' })
      assert.deepStrictEqual(yield* client.next, { _tag: 'Pong' })
    }),
  )
})

it.layer(ApiTestLayer())(
  'the bearer token in the headers of each request on /api/v1/ws',
  (suite) => {
    suite.effect.each(REFUSED)(
      'refuses a request with %s: its failure is the unauthorized problem',
      ([, token]) =>
        Effect.gen(function* refuses() {
          const client = yield* connected()
          const repo = createTempRepo()
          const register = { id: '2', tag: 'projects.register', payload: { path: repo }, token }
          assert.containSubset(yield* called(client, register), {
            _tag: 'Exit',
            requestId: '2',
            exit: { _tag: 'Failure', cause: [{ _tag: 'Fail', error: UNAUTHORIZED }] },
          })
          const { body } = yield* get('/projects')
          assert.notInclude(JSON.stringify(body), repo)
        }),
    )
  },
)

it.layer(ApiTestLayer())('the session procedures over the WebSocket of /api/v1/ws', (suite) => {
  suite.effect('creates a session over the socket and reaches every procedure on it', () =>
    Effect.gen(function* drivesSession() {
      const { project } = yield* registeredProject
      const client = yield* connected()
      const { session, worktree } = yield* createdOver(client, project.id)
      assert.strictEqual(session.status, 'ready')
      for (const [tag, input, answer] of lifecycle(session.id)) {
        const done = yield* called(client, { id: tag, tag, payload: input, token: TEST_TOKEN })
        assert.containSubset(done, { requestId: tag, ...answer })
      }
      const retained = [{ path: worktree, reason: 'younger than 7 days' }]
      assert.deepStrictEqual(yield* prunedOver(client, project.id), { removed: [], retained })
      assert.containSubset((yield* get(`/sessions/${session.id}`)).body, { status: 'completed' })
    }),
  )
})

// On the live clock: the test waits a while to see that nothing comes before the ack
it.layer(ApiTestLayer(), { excludeTestServices: true })(
  'the event subscription over the WebSocket of /api/v1/ws',
  (suite) => {
    suite.effect('streams the events of a session in chunks and ends the stream on interrupt', () =>
      Effect.gen(function* streams() {
        const { session } = yield* createdSession
        const { client, first } = yield* subscribed(session.id, '3')
        assert.containSubset(first, { _tag: 'Chunk', requestId: '3' })
        assert.containSubset(envelopesOf(first).at(0), {
          type: 'session.created',
          sessionId: session.id,
        })
        client.send({ _tag: 'Ack', requestId: '3' })
        client.send({ _tag: 'Interrupt', requestId: '3' })
        const read = yield* readUntil(client, isExit)
        assert.containSubset(read.at(-1), { _tag: 'Exit', requestId: '3' })
      }),
    )

    suite.effect('sends the next chunk only once the client has acknowledged the last one', () =>
      Effect.gen(function* holdsChunks() {
        const { session } = yield* createdSession
        const { client, first } = yield* subscribed(session.id, '4')
        assert.containSubset(first, { _tag: 'Chunk', requestId: '4' })
        yield* warned(session.id)
        yield* Effect.sleep(QUIET)
        client.send({ _tag: 'Ping' })
        assert.deepStrictEqual(yield* client.next, { _tag: 'Pong' })
        client.send({ _tag: 'Ack', requestId: '4' })
        const read = yield* readUntil(
          client,
          (message) => isExit(message) || isWarning(message),
          '4',
        )
        assert.containSubset(read.at(-1), { _tag: 'Chunk', requestId: '4' })
      }),
    )
  },
)
```
If a `Chunk` arrives in several frames or the first chunk holds more events than `session.created`, assert that the first value is `session.created` and keep reading until `Exit`; the interrupt may also surface as an `Exit` with an `Interrupt` cause — assert on `_tag: 'Exit'` and the request id only.

`packages/api/src/rpc/limit.ts` (added during execution):
```ts
import { Problem } from '@bytebureau/protocol'
import { Effect, Layer, Option } from 'effect'
import { HttpServerRequest } from 'effect/http'
import { RpcMiddleware } from 'effect/rpc'
import { clientKey, drawToken, MutationBuckets } from '../mutation-buckets.js'

export class RpcMutationLimit extends RpcMiddleware.Service<RpcMutationLimit>()(
  'bb/api/RpcMutationLimit',
  { error: Problem },
) {}

// The one procedure that changes nothing: it reads the event log
const SUBSCRIPTION = 'events.subscribe'

// A request on the socket runs in the context of its upgrade, which carries the address captured before the upgrade (Bun forgets it after)
// So the client is known by the address the REST limit knows it by, and both doors draw from one budget; without it the socket clients share one key
const socketKey: Effect.Effect<string> = Effect.serviceOption(
  HttpServerRequest.HttpServerRequest,
).pipe(Effect.map((upgrade) => Option.match(upgrade, { onNone: () => 'rpc', onSome: clientKey })))

export const RpcMutationLimitLive: Layer.Layer<RpcMutationLimit, never, MutationBuckets> =
  Layer.effect(
    RpcMutationLimit,
    Effect.gen(function* makeRpcMutationLimit() {
      const buckets = yield* MutationBuckets
      return (effect, { rpc }) => {
        const { _tag: tag } = rpc
        if (tag === SUBSCRIPTION) {
          return effect
        }
        return socketKey.pipe(
          Effect.flatMap((key) => drawToken(buckets, key)),
          Effect.andThen(effect),
        )
      }
    }),
  )
```
`packages/api/src/mutation-buckets.ts` (added during execution):
```ts
import { Context, Effect, Layer, Option } from 'effect'
import type { HttpServerRequest } from 'effect/http'
import { ApiConfig } from './config.js'
import { problem, type ApiProblem } from './problems.js'
import { TokenBuckets } from './token-bucket.js'

// The mutation budgets of the clients: one per client, whichever door it comes through (the REST API or the RPC socket)
export class MutationBuckets extends Context.Service<MutationBuckets, TokenBuckets>()(
  'bb/api/MutationBuckets',
) {}

export const MutationBucketsLive: Layer.Layer<MutationBuckets, never, ApiConfig> = Layer.effect(
  MutationBuckets,
  Effect.gen(function* makeMutationBuckets() {
    const { mutationLimit } = yield* ApiConfig
    return new TokenBuckets({ ...mutationLimit, now: Date.now })
  }),
)

// A client is known by the address it calls from
export const clientKey = (request: HttpServerRequest.HttpServerRequest): string =>
  Option.getOrElse(request.remoteAddress, () => 'local')

// A token from the budget of the client, or the 429 problem that says when to retry
export const drawToken = (
  buckets: TokenBuckets,
  key: string,
): Effect.Effect<void, ApiProblem<429>> =>
  Effect.suspend(() => {
    const verdict = buckets.take(key)
    return verdict.allowed
      ? Effect.void
      : Effect.fail(problem(429, 'rate_limited', `retry after ${verdict.retryAfterSec} s`))
  })
```
`packages/api/src/rpc/origin.ts` (added during execution):
```ts
import { Option } from 'effect'
import { Headers } from 'effect/http'

// The names a page of the daemon itself is served under on this machine; the parser keeps the brackets of an IPv6 address
const LOOPBACK: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

const DEFAULT_PORT: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443' }

// The port a URL names, or the one its scheme implies
const portOf = (url: URL): string =>
  url.port === '' ? (DEFAULT_PORT[url.protocol] ?? '') : url.port

// A page on a loopback name and on the port the request came to is the daemon's own (the embedded UI of SP2)
// The name in the Host header is never trusted: a page that rebinds its own name to the loopback sends that name as well
const isOwnPage = (page: URL, host: string | undefined): boolean => {
  const served = host === undefined ? null : URL.parse(`http://${host}`)
  return served !== null && LOOPBACK.has(page.hostname) && portOf(page) === portOf(served)
}

// A browser says where it comes from: a listed origin or the daemon's own page may open the socket
// A client without an Origin (the CLI, Node, Bun) is no browser; an Origin that is no URL is turned away
export const originAllowed = (headers: Headers.Headers, origins: readonly string[]): boolean => {
  const origin = Option.getOrUndefined(Headers.get(headers, 'origin'))
  if (origin === undefined || origins.includes(origin)) {
    return true
  }
  const page = URL.parse(origin)
  return page !== null && isOwnPage(page, Option.getOrUndefined(Headers.get(headers, 'host')))
}
```
`packages/api/src/rpc/upgrade.ts` (added during execution):
```ts
import { Effect, type Scope } from 'effect'
import { HttpServerRequest, HttpServerResponse } from 'effect/http'
import { originAllowed } from './origin.js'

type Upgrade = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest | Scope.Scope
>

// Bun forgets the address of a request once it has upgraded it, so the address is captured before the upgrade
// The requests on the socket run in the context of this request, and the mutation limit counts them for that address
const frozenRequest = (
  request: HttpServerRequest.HttpServerRequest,
): HttpServerRequest.HttpServerRequest => request.modify({ remoteAddress: request.remoteAddress })

// The upgrade behind the origin check: a browser from an origin the daemon does not serve gets 403 before the socket opens
export const guardedUpgrade = (upgrade: Upgrade, origins: readonly string[]): Upgrade =>
  Effect.gen(function* guardsUpgrade() {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (!originAllowed(request.headers, origins)) {
      return HttpServerResponse.empty({ status: 403 })
    }
    return yield* upgrade.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, frozenRequest(request)),
    )
  })
```
`packages/api/src/routes.ts` (added during execution):
```ts
import { Layer } from 'effect'
import { HttpRouter } from 'effect/http'
import { HttpApiBuilder } from 'effect/http-api'
import { API_PREFIX, BureauApi } from './api.js'
import type { ApiConfig, ApiOptions } from './config.js'
import { Handlers } from './handlers/all.js'
import { Middlewares } from './middlewares.js'
import type { MutationBuckets } from './mutation-buckets.js'
import type { ApiRequirements } from './requirements.js'

export const OPENAPI_PATH = `${API_PREFIX}/openapi.json` as const

// The endpoints of the API with their handlers and middlewares; the handlers read the configuration with each request
export const Routes = (
  options: ApiOptions,
  config: Layer.Layer<ApiConfig>,
): Layer.Layer<never, never, ApiRequirements | MutationBuckets> =>
  HttpApiBuilder.layer(BureauApi, { openapiPath: OPENAPI_PATH }).pipe(
    Layer.provide(Handlers),
    Layer.provide(Middlewares(options.token)),
    HttpRouter.provideRequest(config),
  )
```
`packages/api/src/requirements.ts` (added during execution):
```ts
import type { KernelServices } from '@bytebureau/kernel'
import type { FileSystem, Path } from 'effect'
import type { Etag, HttpPlatform, HttpRouter, HttpServer } from 'effect/http'
import type { SqlClient } from 'effect/sql'

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

// What the served API needs from its environment: the server, its platform and the kernel
export type ServeRequirements =
  | HttpServer.HttpServer
  | ServerPlatform
  | KernelServices
  | SqlClient.SqlClient
```
`packages/api/src/rpc/auth.test.ts` (added during execution):
```ts
import { Cause, Effect, Exit, Layer, Redacted } from 'effect'
import { Headers } from 'effect/http'
import { describe, expect, it } from 'vitest'
import { bearerOf, RpcAuthorizationLive } from './auth.js'

// The authorization header of a request envelope and the token read from it
const READ: [string, string | undefined][] = [
  ['Bearer abc', 'abc'],
  ['bearer abc', 'abc'],
  ['BEARER  abc ', 'abc'],
  ['Bearer ', ''],
  ['Basic abc', undefined],
  ['Bearer-abc', undefined],
]

// What building the layer dies with, or nothing when it builds
const buildFailure = <Out>(layer: Layer.Layer<Out>): string => {
  const built = Effect.runSyncExit(Effect.scoped(Layer.build(layer)))
  return Exit.match(built, { onFailure: (cause) => Cause.pretty(cause), onSuccess: () => '' })
}

describe(bearerOf, () => {
  it.each(READ)('reads %j as %j', (header, token) => {
    const headers = Headers.fromInput([['authorization', header]])
    expect(bearerOf(headers)).toBe(token)
  })

  it('reads no token from a request without the header', () => {
    expect(bearerOf(Headers.empty)).toBeUndefined()
  })
})

describe(RpcAuthorizationLive, () => {
  it('refuses to build without a token, which would let every request in', () => {
    const withoutToken = RpcAuthorizationLive(Redacted.make(''))
    expect(buildFailure(withoutToken)).toContain('the API token must not be empty')
    const withToken = RpcAuthorizationLive(Redacted.make('token'))
    expect(buildFailure(withToken)).toBe('')
  })
})
```
`packages/api/src/rpc/origin.test.ts` (added during execution):
```ts
import { Headers } from 'effect/http'
import { describe, expect, it } from 'vitest'
import { originAllowed } from './origin.js'

const LISTED = ['http://ui.test']

// The daemon on its usual port, reached at the IPv4 loopback
const HOST = '127.0.0.1:4747'

// The headers of an upgrade from a page to that daemon
const from = (origin: string): Record<string, string> => ({ origin, host: HOST })

// The headers of an upgrade and whether a browser that sent them may open the socket
const DECIDED: [string, Record<string, string>, boolean][] = [
  ['no Origin', { host: HOST }, true],
  ['a listed origin', from('http://ui.test'), true],
  ['the own page on localhost', from('http://localhost:4747'), true],
  ['the own page on 127.0.0.1', { origin: 'http://127.0.0.1:4747', host: 'localhost:4747' }, true],
  ['the own page on [::1]', { origin: 'http://[::1]:4747', host: '[::1]:4747' }, true],
  ['a loopback page on another port', from('http://localhost:1'), false],
  [
    'a page that rebound its own name to the loopback',
    { origin: 'http://attacker.example:4747', host: 'attacker.example:4747' },
    false,
  ],
  [
    'an https page against a daemon on port 80',
    { origin: 'https://localhost', host: 'localhost' },
    false,
  ],
  ['a page of another site', from('http://evil.example'), false],
  ['an opaque origin', from('null'), false],
  ['an empty Origin', from(''), false],
  ['a loopback page without a Host', { origin: 'http://localhost:4747' }, false],
  [
    'a loopback page and a Host that is no host',
    { origin: 'http://localhost:4747', host: 'no host' },
    false,
  ],
  ['a loopback origin of another scheme', from('ftp://localhost'), false],
]

describe(originAllowed, () => {
  it.each(DECIDED)('decides on %s', (name, headers, allowed) => {
    expect(originAllowed(Headers.fromInput(headers), LISTED), name).toBe(allowed)
  })
})
```
`packages/api/src/rpc/upgrade.test.ts` (added during execution):
```ts
import { assert, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { HttpServerRequest, HttpServerResponse } from 'effect/http'
import { guardedUpgrade } from './upgrade.js'

const ADDRESS = '203.0.113.9'

interface Upgrading {
  readonly request: HttpServerRequest.HttpServerRequest
  readonly upgrade: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest
  >
  // The address a request on the socket saw, if the upgrade ran
  readonly seen: () => string | undefined
}

// A request as Bun serves it, whose address is gone once it has been upgraded, and an upgrade that makes it so
// The upgrade records the address that a request on the socket then reads from its context
const bunUpgrade = (headers: Record<string, string> = {}): Upgrading => {
  const state: { upgraded: boolean; seen: string | undefined } = {
    upgraded: false,
    seen: undefined,
  }
  const served = HttpServerRequest.fromWeb(
    new Request('http://127.0.0.1:4747/api/v1/ws', { headers }),
  )
  const addressNow = (): Option.Option<string> =>
    state.upgraded ? Option.none() : Option.some(ADDRESS)
  const request = new Proxy(served, {
    get: (target, key, receiver): unknown =>
      key === 'remoteAddress' ? addressNow() : Reflect.get(target, key, receiver),
  })
  const upgrade = Effect.gen(function* upgrades() {
    state.upgraded = true
    const current = yield* HttpServerRequest.HttpServerRequest
    state.seen = Option.getOrUndefined(current.remoteAddress)
    return HttpServerResponse.empty()
  })
  return { request, upgrade, seen: () => state.seen }
}

it.effect(
  'keeps for the socket the address the request came from, which Bun forgets at the upgrade',
  () =>
    Effect.gen(function* keepsAddress() {
      const { request, upgrade, seen } = bunUpgrade()
      const guarded = guardedUpgrade(upgrade, [])
      yield* guarded.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
      assert.strictEqual(seen(), ADDRESS)
    }),
)

it.effect('models Bun: without the guard a request on the socket sees no address', () =>
  Effect.gen(function* losesAddress() {
    const { request, upgrade, seen } = bunUpgrade()
    yield* upgrade.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
    assert.isUndefined(seen())
  }),
)

it.effect('turns away a browser from a foreign origin with 403 and does not upgrade', () =>
  Effect.gen(function* refuses() {
    const { request, upgrade, seen } = bunUpgrade({ origin: 'http://evil.example' })
    const guarded = guardedUpgrade(upgrade, [])
    const response = yield* guarded.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    )
    assert.strictEqual(response.status, 403)
    assert.isUndefined(seen())
  }),
)
```
`packages/api/src/rpc-limit.test.ts` (added during execution):
```ts
import { createTempRepo } from '@bytebureau/kernel/testing'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ApiTestLayer, post, TEST_TOKEN } from './testing.js'
import { called, connected, type RequestEnvelope } from './testing-ws.js'

// One token per client, and the next flows back after a minute: the second mutation of a test is always refused
const ONE_TOKEN = ApiTestLayer({ mutationLimit: { capacity: 1, perMinute: 1 } })

// The registration of a new repository over the socket
const registration = (id: string, token?: string): RequestEnvelope => ({
  id,
  tag: 'projects.register',
  payload: { path: createTempRepo() },
  token,
})

const SUCCEEDED = { exit: { _tag: 'Success' } }

const LIMITED = {
  exit: {
    _tag: 'Failure',
    cause: [
      { _tag: 'Fail', error: { status: 429, code: 'rate_limited', detail: 'retry after 60 s' } },
    ],
  },
}

it.layer(ONE_TOKEN)('the mutation limit over the WebSocket of /api/v1/ws', (suite) => {
  suite.effect(
    'refuses the second mutation in a row with rate_limited and still streams events',
    () =>
      Effect.gen(function* limits() {
        const client = yield* connected()
        assert.containSubset(yield* called(client, registration('1', TEST_TOKEN)), SUCCEEDED)
        assert.containSubset(yield* called(client, registration('2', TEST_TOKEN)), {
          requestId: '2',
          ...LIMITED,
        })
        const subscription = { id: '3', tag: 'events.subscribe', payload: { since: 0 } }
        const first = yield* called(client, { ...subscription, token: TEST_TOKEN })
        assert.containSubset(first, { _tag: 'Chunk', requestId: '3' })
      }),
  )
})

it.layer(ONE_TOKEN)('one mutation budget for the REST API and the socket', (suite) => {
  suite.effect('refuses a REST mutation once the socket has spent the budget of the client', () =>
    Effect.gen(function* sharesBudget() {
      const client = yield* connected()
      assert.containSubset(yield* called(client, registration('1', TEST_TOKEN)), SUCCEEDED)
      const refused = yield* post('/projects', { path: createTempRepo() })
      assert.strictEqual(refused.status, 429)
      assert.containSubset(refused.body, { code: 'rate_limited', detail: 'retry after 60 s' })
    }),
  )
})

it.layer(ONE_TOKEN)('the mutation limit and the bearer token over the socket', (suite) => {
  suite.effect('does not count a request without the token against the limit', () =>
    Effect.gen(function* keepsToken() {
      const client = yield* connected()
      const unauthorized = { _tag: 'Fail', error: { code: 'unauthorized' } }
      const refused = yield* called(client, registration('1'))
      assert.containSubset(refused, { exit: { cause: [unauthorized] } })
      assert.containSubset(yield* called(client, registration('2', TEST_TOKEN)), SUCCEEDED)
    }),
  )
})
```
`packages/api/src/rpc-origin.test.ts` (added during execution):
```ts
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ApiTestLayer, baseUrl, fetched } from './testing.js'
import { connected } from './testing-ws.js'

const UI = 'http://ui.test'
const ELSEWHERE = 'http://evil.example'

// The body of an answer as text
const textOf = (response: Response): Effect.Effect<string> =>
  Effect.promise(async () => {
    const whole = await response.text()
    return whole
  })

// The Origin of a page and what the socket answers a plain GET from it: past the check it wants an Upgrade (400), else 403
const pagesOf = (port: string): [string, number][] => [
  [`http://localhost:${port}`, 400],
  [`http://127.0.0.1:${port}`, 400],
  ['http://localhost:1', 403],
  [ELSEWHERE, 403],
]

it.layer(ApiTestLayer())('the own page of the daemon at the upgrade of /api/v1/ws', (suite) => {
  suite.effect(
    'lets a page on a loopback name and the port of the daemon through, and no other',
    () =>
      Effect.gen(function* checksPages() {
        const base = yield* baseUrl
        const pages = pagesOf(new URL(base).port)
        const answers = yield* Effect.all(
          pages.map(([origin]) => fetched(`${base}/api/v1/ws`, { headers: { origin } })),
        )
        assert.deepStrictEqual(
          answers.map(({ status }) => status),
          pages.map(([, status]) => status),
        )
      }),
  )
})

it.layer(ApiTestLayer({ corsOrigins: [UI] }))(
  'the Origin a browser sends to /api/v1/ws',
  (suite) => {
    suite.effect('turns away an origin the daemon does not serve before the socket opens', () =>
      Effect.gen(function* refusesOrigin() {
        const base = yield* baseUrl
        const response = yield* fetched(`${base}/api/v1/ws`, { headers: { origin: ELSEWHERE } })
        assert.strictEqual(response.status, 403)
        assert.strictEqual(yield* textOf(response), '')
        const refused = yield* Effect.flip(connected({ origin: ELSEWHERE }))
        assert.include(refused.message, 'cannot open')
      }),
    )

    suite.effect('lets a listed origin open the socket', () =>
      Effect.gen(function* acceptsOrigin() {
        const client = yield* connected({ origin: UI })
        client.send({ _tag: 'Ping' })
        assert.deepStrictEqual(yield* client.next, { _tag: 'Pong' })
      }),
    )
  },
)
```
`packages/api/src/rpc-defect.test.ts` (added during execution):
```ts
import { createServer } from 'node:http'
import { WorkspaceManager } from '@bytebureau/kernel'
import { NodeHttpServer } from '@effect/platform-node'
import { assert, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { serveApi } from './layer.js'
import { BootedKernel } from './testing-kernel.js'
import { TEST_TOKEN, testOptions } from './testing.js'
import { called, connected } from './testing-ws.js'

// The kernel of the tests with a prune that dies, as a bug behind a handler would
const DyingPrune = Layer.effect(
  WorkspaceManager,
  WorkspaceManager.use((workspaces) =>
    Effect.succeed({ ...workspaces, prune: () => Effect.die(new Error('the prune broke')) }),
  ),
)

const DyingLayer = serveApi(testOptions()).pipe(
  Layer.provide(DyingPrune),
  Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port: 0, host: '127.0.0.1' })),
  Layer.provideMerge(BootedKernel),
)

it.layer(DyingLayer)('a defect behind a procedure over the WebSocket of /api/v1/ws', (suite) => {
  suite.effect('ends that request with a Die and goes on serving the socket', () =>
    Effect.gen(function* dies() {
      const client = yield* connected()
      const prune = { id: 'prune', tag: 'workspaces.prune', payload: {}, token: TEST_TOKEN }
      assert.containSubset(yield* called(client, prune), {
        _tag: 'Exit',
        requestId: 'prune',
        exit: { _tag: 'Failure', cause: [{ _tag: 'Die' }] },
      })
      client.send({ _tag: 'Ping' })
      assert.deepStrictEqual(yield* client.next, { _tag: 'Pong' })
    }),
  )
})
```

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

The daemon serves `effect/rpc` on `/api/v1/ws` with `RpcSerialization.json`: each WebSocket frame is one JSON envelope of the documented `RpcMessage` shapes (`Request`, `Ack`, `Interrupt`, `Ping` from the client; `Chunk`, `Exit`, `Defect`, `Pong` from the server). The client package implements those envelopes in one module and keeps Effect out of its runtime; the REST and SSE parts are generated from the OpenAPI document and read with `fetch`. The bearer token travels in the `headers` of every RPC request, never in the URL. The upgrade checks a browser's `Origin`: an origin listed in `corsOrigins` may open the socket, and so may the daemon's own page, served on a loopback name (`localhost`, `127.0.0.1`, `[::1]`) and the port the request came to; the name in the `Host` header is never trusted, since a page that rebinds its own name to the loopback sends that name as well. Every procedure but `events.subscribe` draws a token from the mutation budget of the address the socket was opened from, the budget the REST mutations of that address draw from, so the socket is no second door around the rate limit. The address is captured at the upgrade, because Bun forgets the address of a request once it has upgraded it.

## Consequences

- One contract (`BureauRpcs` in the protocol) for the server and the client; the wire shapes are pinned by `rpc.test.ts` and by the client's codec tests, so a change in Effect's envelopes is caught at upgrade time.
- A browser client (SP2) needs no header on the upgrade, so no token in the URL and no subprotocol trick.
- Streams need the client to acknowledge chunks; a client that forgets to ack sees one chunk and then silence, which the client package hides.
- Effect puts the headers of the upgrade request in front of the headers of every request on the socket, so a Node or Bun client that sends the bearer header with the upgrade is let in as well; the header of the request wins when both carry one.
- A payload that does not fit its schema, or a tag the group does not know, ends as an `Exit` whose cause is a `Die` with the schema's message, not as a `request_invalid` problem; the client package reports it as an error.
- Every `Request` envelope carries a `headers` array, empty when there is nothing to send; Effect closes the socket with 1011 on a request without one.
- A defect in a handler ends that request with an `Exit` whose cause is a `Die` (the route sets `disableFatalDefects`), so the other requests on the socket go on.
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

Semantics (as shipped, commits 0382379, ebeb5a3): hey-api 0.99.0 runs from `tools/client-codegen` on `@typescript/typescript6` 6.0.2 and its output in `packages/client/src/gen` carries `// @ts-nocheck` (every consumer compiles the client from source under its own strict settings; the wrapper's use of the generated types stays type-checked); each `createBureauClient` creates its own generated client, so one process may talk to several daemons; `projects.register({ path })`, `events.subscribe(filter, { signal, retryFor })`, `rpc.connect()`, `close(): Promise<void>`; `ApiError(status, problem, url | { url, cause })`; `subscribeEvents` sends no `Last-Event-ID` on the first request, resets the backoff and the failure clock when a connection opens, updates the resume position only from durable frames, ends with the `ApiError` of any final 4xx (408 and 429 are retried), gives up after `retryFor` with `ApiError(0, …)`, and ends quietly on abort; `connectRpc` (`rpc/connection.ts` with the per-request `rpc/link.ts`) acknowledges a chunk after its values are consumed, sends `Interrupt` only while the request is open, turns a `Fail` problem into an `ApiError` and a `Die`/`Interrupt` into an `Error`, drops a chunk that arrives after close and fails every open request when the socket closes; `call`/`stream` yield `unknown` (the index narrows per method). Tests: `errors.test.ts`, `http.test.ts`, `sse.test.ts` (with `sse-fixture.ts`), `rpc/codec.test.ts` in the client; `client.test.ts`, `client-events.test.ts`, `client-rpc.test.ts` (with `testing-client.ts`) in the api. `client` joined the `semantic-pr.yml` scopes here. Known minors (final fix wave, robustness first): `close()` should clear the ping interval at once; an abort should release the exchange and skip the ack; a 2xx that is not `text/event-stream` should count as a failed attempt; test gaps — heartbeats do not move the resume position (reorder the fixture frames), the backoff/failure-clock reset on open, pings actually sent.

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
// Every consumer compiles the client from source under its own strict options, which the bundled client does not meet
export default defineConfig({
  input: '../../packages/api/openapi.json',
  output: {
    path: '../../packages/client/src/gen',
    header: ['// This file is auto-generated by @hey-api/openapi-ts', '// @ts-nocheck'],
  },
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
import { ApiError, isProblem } from './errors.js'

const notFound = {
  type: 'https://bytebureau.dev/problems/session_not_found',
  title: 'Not Found',
  status: 404,
  detail: 'no session 42',
  code: 'session_not_found',
}

describe(ApiError, () => {
  it('tells a problem by its detail and code', () => {
    const error = new ApiError(404, notFound)
    expect(error.message).toBe('no session 42 (session_not_found)')
    expect(error.status).toBe(404)
    expect(error.problem).toStrictEqual(notFound)
  })

  it('is an Error named ApiError that keeps the url of the request', () => {
    const error = new ApiError(404, notFound, 'http://127.0.0.1:4747/api/v1/sessions/42')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ApiError')
    expect(error.url).toBe('http://127.0.0.1:4747/api/v1/sessions/42')
  })

  it('tells an unreachable daemon by its url and an unknown answer by its status', () => {
    expect(new ApiError(0, undefined, 'http://127.0.0.1:1/api/v1/health').message).toBe(
      'cannot reach the daemon at http://127.0.0.1:1/api/v1/health',
    )
    expect(new ApiError(502, undefined).message).toBe('the daemon answered 502')
    expect(new ApiError(0, undefined).message).toBe('cannot reach the daemon at an unknown url')
  })

  it('keeps what a request that got no answer failed with', () => {
    const cause = new TypeError('fetch failed')
    const error = new ApiError(0, undefined, { url: 'http://127.0.0.1:1/api/v1/health', cause })
    expect(error.message).toBe('cannot reach the daemon at http://127.0.0.1:1/api/v1/health')
    expect(error.url).toBe('http://127.0.0.1:1/api/v1/health')
    expect(error.cause).toBe(cause)
    expect(Object.hasOwn(new ApiError(502, undefined), 'cause')).toBe(false)
  })
})

describe(isProblem, () => {
  it.each([
    ['a problem', notFound, true],
    ['a problem with an instance', { ...notFound, instance: '/api/v1/sessions/42' }, true],
    ['a status that is not a number', { ...notFound, status: '404' }, false],
    ['an object without a detail', { code: 'session_not_found', status: 404 }, false],
    ['a text', 'no session 42', false],
    ['null', JSON.parse('null'), false],
  ])('tells %s', (_name, value, expected) => {
    expect(isProblem(value)).toBe(expected)
  })
})
```

`packages/client/src/errors.ts`:
```ts
import type { Problem } from '@bytebureau/protocol'

// The url a request went to and, when it got no answer at all, what it failed with
export interface RequestTarget {
  readonly url: string
  readonly cause?: unknown
}

const messageOf = (
  status: number,
  problem: Problem | undefined,
  url: string | undefined,
): string => {
  if (problem !== undefined) {
    return `${problem.detail} (${problem.code})`
  }
  return status === 0
    ? `cannot reach the daemon at ${url ?? 'an unknown url'}`
    : `the daemon answered ${status}`
}

const targetOf = (target: string | RequestTarget | undefined): RequestTarget | undefined =>
  typeof target === 'string' ? { url: target } : target

/** What the daemon said no with: a problem, a bare status, or nothing at all because it could not be reached (status 0). */
export class ApiError extends Error {
  public override readonly name = 'ApiError'
  /** The HTTP status of the answer; 0 when no answer came. */
  public readonly status: number
  /** The RFC 9457 problem the daemon answered with, if it sent one. */
  public readonly problem: Problem | undefined
  /** The url of the request. */
  public readonly url: string | undefined

  /**
   * @param status The HTTP status of the answer, 0 when no answer came.
   * @param problem The problem the answer carried, if any.
   * @param target The url of the request, or the url and what the request failed with.
   */
  public constructor(
    status: number,
    problem: Problem | undefined,
    target?: string | RequestTarget,
  ) {
    const { url, cause } = targetOf(target) ?? {}
    super(messageOf(status, problem, url), cause === undefined ? undefined : { cause })
    this.status = status
    this.problem = problem
    this.url = url
  }
}

const hasStrings = (value: object, keys: readonly string[]): boolean =>
  keys.every((key) => typeof Reflect.get(value, key) === 'string')

// An RFC 9457 problem with the code of ByteBureau, as the daemon sends one
export const isProblem = (value: unknown): value is Problem =>
  typeof value === 'object' &&
  value !== null &&
  typeof Reflect.get(value, 'status') === 'number' &&
  hasStrings(value, ['type', 'title', 'detail', 'code'])
```

`packages/client/src/http.ts` — the wrapper over the generated SDK (names of the generated functions as `sdk.gen.ts` exports them; the shape below uses the hey-api result convention `{ data, error, response }`):
```ts
import type { AskAnswer, PromptInput } from '@bytebureau/protocol'
import { ApiError, isProblem } from './errors.js'
import { createClient, createConfig, type Client } from './gen/client/index.js'
import type { AsksAnswerData, SessionsPromptData } from './gen/types.gen.js'

export interface HttpOptions {
  readonly baseUrl: string
  readonly token: string
  readonly fetch?: typeof fetch | undefined
}

// What a function of the generated SDK resolves with: it never rejects, a failure comes back as its error
interface Answer<Data> {
  readonly data?: Data | undefined
  readonly error?: unknown
  readonly request?: Request | undefined
  readonly response?: Response | undefined
}

type Call<Options, Data> = (options: Options) => Promise<Answer<Data>>

// The methods of a client, each made of a function of the generated SDK and the options its arguments make
export interface Http {
  // The generated client of this daemon alone, so two clients in one process never share a url or a token
  readonly client: Client
  // A 2xx answer gives its data; any other answer, or none, is thrown as an ApiError
  readonly data: <Args extends readonly unknown[], Options, Data>(
    call: Call<Options, Data>,
    optionsOf: (...args: Args) => Options,
  ) => (...args: Args) => Promise<Data>
  // The same for a lookup: an answer of 404 is nothing, not a failure
  readonly lookup: <Args extends readonly unknown[], Options, Data>(
    call: Call<Options, Data>,
    optionsOf: (...args: Args) => Options,
  ) => (...args: Args) => Promise<Data | undefined>
  // The same for a command the daemon answers with no content
  readonly done: <Args extends readonly unknown[], Options>(
    call: Call<Options, unknown>,
    optionsOf: (...args: Args) => Options,
  ) => (...args: Args) => Promise<void>
}

const failureOf = (answer: Answer<unknown>, baseUrl: string): ApiError => {
  const url = answer.request === undefined ? baseUrl : answer.request.url
  if (answer.response === undefined) {
    return new ApiError(0, undefined, { url, cause: answer.error })
  }
  const problem = isProblem(answer.error) ? answer.error : undefined
  return new ApiError(answer.response.status, problem, url)
}

// The data of an answer: a 2xx with a body gives it; any other answer, or none, is thrown as an ApiError
const valueOf = <Data>(answer: Answer<Data>, baseUrl: string): Data => {
  const { response, data } = answer
  if (response === undefined || !response.ok) {
    throw failureOf(answer, baseUrl)
  }
  // A 2xx without a body gives null for data, and the API answers every query with one
  if (data === undefined || data === null) {
    throw new ApiError(response.status, undefined, response.url)
  }
  return data
}

const isNotFound = ({ response }: Answer<unknown>): boolean =>
  response !== undefined && response.status === 404

export const http = ({ baseUrl, token, fetch: fetchImpl }: HttpOptions): Http => {
  const fetchOption = fetchImpl === undefined ? {} : { fetch: fetchImpl }
  return {
    client: createClient(createConfig({ baseUrl, auth: token, ...fetchOption })),
    data:
      (call, optionsOf) =>
      async (...args) => {
        const answer = await call(optionsOf(...args))
        return valueOf(answer, baseUrl)
      },
    lookup:
      (call, optionsOf) =>
      async (...args) => {
        const answer = await call(optionsOf(...args))
        return isNotFound(answer) ? undefined : valueOf(answer, baseUrl)
      },
    done:
      (call, optionsOf) =>
      async (...args) => {
        const answer = await call(optionsOf(...args))
        if (answer.response === undefined || !answer.response.ok) {
          throw failureOf(answer, baseUrl)
        }
      },
  }
}

// The protocol's types are readonly, the generated bodies take mutable arrays: a copy fits both
export const promptBody = ({ text, attachments }: PromptInput): SessionsPromptData['body'] =>
  attachments === undefined ? { text } : { text, attachments: [...attachments] }

export const answerBody = (answer: AskAnswer): AsksAnswerData['body'] => ({
  ...answer,
  selected: typeof answer.selected === 'string' ? answer.selected : [...answer.selected],
})
```
The `as Data` is the one cast the lint will refuse; replace it with a guard (`if (answer.data === undefined) throw new ApiError(answer.response.status, undefined, url)` — a `204` carries no data and its callers return `void`, so route the no-content calls through a `done()` variant that ignores `data`). `ApiError` takes an options object as a fourth argument only if the class is given one (`super(message, { cause })`); add it. The resource objects (`projects`, `sessions`, …) are built in `index.ts` from `unwrap`/`optional` and the SDK functions, e.g. `list: () => unwrap(`${baseUrl}/api/v1/projects`, () => sdk.projectsList())`, `register: (body) => unwrap(url, () => sdk.projectsRegister({ body }))`, `get: (id) => optional(unwrap(url, () => sdk.projectsGet({ path: { id } })))`. `workspaces.prune(projectId?)` always sends a JSON body (`{}` when no project is given — the endpoint requires one); hey-api's SDK takes `{ path, query, body }` options and returns the `{ data, error, response }` answer; one generated client instance (`client`) is configured by `configureClient`, so `createBureauClient` is effectively a singleton per process — acceptable for the CLI; a later consumer that needs two daemons at once uses `createClient` from `gen/client` (note it in the index JSDoc).

- [ ] **Step 3: The SSE subscription — test first**

`packages/client/src/sse.test.ts` (a `node:http` server that plays the daemon):
```ts
import type { EventEnvelope } from '@bytebureau/protocol'
import { describe, expect, it } from 'vitest'
import { ApiError } from './errors.js'
import { broken, frame, serve, status, stream } from './sse-fixture.js'
import { subscribeEvents, type SubscribeOptions } from './sse.js'

// The seq of every event until the one that says enough, which is the last one taken
const seqNumbersUntil = async (
  events: AsyncIterable<EventEnvelope>,
  last: (event: EventEnvelope) => boolean,
): Promise<number[]> => {
  const seen: number[] = []
  for await (const event of events) {
    seen.push(event.seq)
    if (last(event)) {
      break
    }
  }
  return seen
}

// Reads the subscription to its end and gives what it failed with
const failureOf = async (options: SubscribeOptions): Promise<unknown> => {
  try {
    await seqNumbersUntil(subscribeEvents(options), () => false)
  } catch (error) {
    return error
  }
  return undefined
}

const UNAUTHORIZED = {
  type: 'https://bytebureau.dev/problems/unauthorized',
  title: 'Unauthorized',
  status: 401,
  detail: 'a valid API token is required',
  code: 'unauthorized',
}

describe(subscribeEvents, () => {
  it('yields the events, resumes with the last id after the server closes, and sends the bearer token', async () => {
    expect.hasAssertions()
    const served = await serve([
      stream(frame(1, 'session.created') + frame(0, 'message.assistant.delta') + frame(2, 'a')),
      stream(frame(3, 'turn.completed')),
    ])
    const options = { baseUrl: served.url, token: 'tok', filter: { since: 0 }, backoffMs: 10 }
    const numbers = seqNumbersUntil(subscribeEvents(options), (event) => event.seq === 3)
    await expect(numbers).resolves.toStrictEqual([1, 0, 2, 3])
    expect(served.requests.map((request) => request.lastEventId)).toStrictEqual([undefined, '2'])
    expect(served.requests.map((request) => request.url)).toStrictEqual([
      '/api/v1/events?since=0',
      '/api/v1/events?since=2',
    ])
    expect(served.requests.map((request) => request.authorization)).toStrictEqual([
      'Bearer tok',
      'Bearer tok',
    ])
  })

  it('asks for the session, the project and the types of its filter', async () => {
    expect.hasAssertions()
    const served = await serve([stream(frame(7, 'session.ready'))])
    const filter = { sessionId: 's1', projectId: 'p1', types: ['session.ready', 'turn.started'] }
    const events = subscribeEvents({ baseUrl: served.url, token: 'tok', filter })
    await expect(seqNumbersUntil(events, () => true)).resolves.toStrictEqual([7])
    expect(served.requests.map((request) => request.url)).toStrictEqual([
      '/api/v1/events?session=s1&project=p1&types=session.ready,turn.started',
    ])
  })
})

describe('the events of a subscription', () => {
  it('drops ephemeral events when the filter says ephemeral: false', async () => {
    expect.hasAssertions()
    const served = await serve([stream(frame(1, 'a') + frame(0, 'heartbeat') + frame(2, 'b'))])
    const filter = { since: 0, ephemeral: false }
    const events = subscribeEvents({ baseUrl: served.url, token: 'tok', filter, backoffMs: 10 })
    await expect(seqNumbersUntil(events, (event) => event.seq === 2)).resolves.toStrictEqual([1, 2])
  })

  it('skips a frame that does not carry an envelope', async () => {
    expect.hasAssertions()
    const noise = 'event: a\ndata: {"nope":1}\n\nevent: b\ndata: not json\n\n'
    const served = await serve([stream(frame(1, 'a') + noise + frame(2, 'b'))])
    const events = subscribeEvents({ baseUrl: served.url, token: 'tok', filter: {} })
    await expect(seqNumbersUntil(events, (event) => event.seq === 2)).resolves.toStrictEqual([1, 2])
  })

  it('reconnects after an answer that is not the stream', async () => {
    expect.hasAssertions()
    const served = await serve([status(503), stream(frame(4, 'a'))])
    const events = subscribeEvents({ baseUrl: served.url, token: 'tok', filter: {}, backoffMs: 10 })
    await expect(seqNumbersUntil(events, () => true)).resolves.toStrictEqual([4])
    expect(served.requests).toHaveLength(2)
  })
})

describe('the refusals of a subscription', () => {
  it('stops at once with an ApiError that carries the problem of a 401', async () => {
    expect.hasAssertions()
    const denied = await serve([status(401, UNAUTHORIZED)])
    const failure = await failureOf({ baseUrl: denied.url, token: 'bad', filter: {} })
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ status: 401, problem: { code: 'unauthorized' } })
    expect(denied.requests).toHaveLength(1)
  })

  it('stops at once with an ApiError on a 403 without a body', async () => {
    expect.hasAssertions()
    const denied = await serve([status(403)])
    const failure = await failureOf({ baseUrl: denied.url, token: 'tok', filter: {} })
    expect(failure).toMatchObject({ status: 403, problem: undefined })
    expect(denied.requests).toHaveLength(1)
  })

  it('gives up with an ApiError once reconnecting has failed for longer than retryFor', async () => {
    expect.hasAssertions()
    const gone = await serve([broken])
    const started = Date.now()
    const options = { baseUrl: gone.url, token: 'tok', filter: {}, backoffMs: 10, retryFor: 300 }
    const failure = await failureOf(options)
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ status: 0, url: `${gone.url}/api/v1/events` })
    expect(gone.requests.length).toBeGreaterThan(2)
  })
})

describe('the signal of a subscription', () => {
  it('ends quietly when the signal aborts', async () => {
    expect.hasAssertions()
    const served = await serve([stream(frame(1, 'a') + frame(2, 'b'), false)])
    const controller = new AbortController()
    const { signal } = controller
    const seen: number[] = []
    for await (const event of subscribeEvents({
      baseUrl: served.url,
      token: 'tok',
      filter: {},
      signal,
    })) {
      seen.push(event.seq)
      controller.abort()
    }
    expect(seen).toStrictEqual([1])
  })

  it('opens nothing when the signal has aborted already', async () => {
    expect.hasAssertions()
    const served = await serve([stream(frame(1, 'a'))])
    const signal = AbortSignal.abort()
    const events = subscribeEvents({ baseUrl: served.url, token: 'tok', filter: {}, signal })
    await expect(seqNumbersUntil(events, () => true)).resolves.toStrictEqual([])
    expect(served.requests).toHaveLength(0)
  })
})

describe('the signal of a subscription that waits', () => {
  it('ends quietly when the signal aborts while it waits for the next frame', async () => {
    expect.hasAssertions()
    const served = await serve([stream(frame(1, 'a'), false)])
    const controller = new AbortController()
    const { signal } = controller
    const seen: number[] = []
    for await (const event of subscribeEvents({
      baseUrl: served.url,
      token: 'tok',
      filter: {},
      signal,
    })) {
      seen.push(event.seq)
      setTimeout(() => {
        controller.abort()
      }, 20)
    }
    expect(seen).toStrictEqual([1])
    expect(served.requests).toHaveLength(1)
  })

  it('ends quietly when the signal aborts while it waits to reconnect', async () => {
    expect.hasAssertions()
    const gone = await serve([broken])
    const signal = AbortSignal.timeout(100)
    const started = Date.now()
    const options = { baseUrl: gone.url, token: 'tok', filter: {}, signal, backoffMs: 60_000 }
    await expect(seqNumbersUntil(subscribeEvents(options), () => true)).resolves.toStrictEqual([])
    expect(Date.now() - started).toBeLessThan(5000)
    expect(gone.requests).toHaveLength(1)
  })
})
```
The `?.` reads and the `as AddressInfo` cast need their lint-friendly forms (a helper that throws when the address is not an object). The test file will cross 300 lines once written that way; split the server fixture into `sse-fixture.ts`.

`packages/client/src/sse.ts`:
```ts
import type { EventEnvelope, EventsFilter, Problem } from '@bytebureau/protocol'
import { EventSourceParserStream, type EventSourceMessage } from 'eventsource-parser/stream'
import { ApiError, isProblem } from './errors.js'

export interface SubscribeOptions {
  readonly baseUrl: string
  readonly token: string
  readonly filter: EventsFilter
  readonly signal?: AbortSignal | undefined
  readonly fetch?: typeof fetch | undefined
  // The first pause before a reconnect; it doubles up to 30 s and starts over once a connection opens
  readonly backoffMs?: number | undefined
  // How long reconnecting may keep failing before the subscription gives up
  readonly retryFor?: number | undefined
}

const FIRST_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 30_000
const RETRY_FOR_MS = 30_000

// Where a subscription stands between its connections
interface State {
  readonly options: SubscribeOptions
  // The seq of the last durable event received; a reconnect resumes after it
  lastSeq: number | undefined
  // The pause the next attempt waits first; none before the first attempt
  backoff: number | undefined
  // When the attempts began to fail, for as long as none has opened since
  failingSince: number | undefined
}

const aborted = (signal: AbortSignal | undefined): boolean => signal !== undefined && signal.aborted

const queryOf = (filter: EventsFilter, since: number | undefined): string => {
  const types = (filter.types ?? []).join(',')
  const params = new URLSearchParams()
  for (const [key, value] of [
    ['since', since === undefined ? undefined : String(since)],
    ['session', filter.sessionId],
    ['project', filter.projectId],
    ['types', types === '' ? undefined : types],
  ] as const) {
    if (value !== undefined) {
      params.set(key, value)
    }
  }
  const text = params.toString()
  return text === '' ? '' : `?${text}`
}

const urlOf = ({ options, lastSeq }: State): string =>
  `${options.baseUrl}/api/v1/events${queryOf(options.filter, lastSeq ?? options.filter.since)}`

// The bearer token always; the last seq seen once there is one to resume after
const headersOf = (token: string, lastSeq: number | undefined): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: 'text/event-stream',
  ...(lastSeq === undefined ? {} : { 'last-event-id': String(lastSeq) }),
})

// Waits the pause, or less when the signal aborts meanwhile; says whether the whole pause has passed
const pause = async (ms: number | undefined, signal: AbortSignal | undefined): Promise<boolean> => {
  if (ms === undefined || aborted(signal)) {
    return false
  }
  const watched = signal ?? new AbortController().signal
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const timer = setTimeout(resolve, ms, true)
  const stop = (): void => {
    clearTimeout(timer)
    resolve(false)
  }
  watched.addEventListener('abort', stop, { once: true })
  const passed = await promise
  watched.removeEventListener('abort', stop)
  return passed
}

// An answer that asking again will not change ends the subscription: a 4xx other than a timeout or a rate limit
const isFinal = (status: number): boolean =>
  status >= 400 && status < 500 && status !== 408 && status !== 429

const problemIn = async (response: Response): Promise<Problem | undefined> => {
  try {
    const body: unknown = await response.json()
    return isProblem(body) ? body : undefined
  } catch {
    return undefined
  }
}

// The frames of a body, read one at a time; leaving early cancels the body, which closes the connection
const messagesOf = (
  frames: ReadableStream<EventSourceMessage>,
): AsyncIterable<EventSourceMessage> => {
  const reader = frames.getReader()
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const read = await reader.read()
        return read.done ? { done: true, value: undefined } : { done: false, value: read.value }
      },
      return: async () => {
        try {
          await reader.cancel()
        } catch {
          // The body failed already: there is nothing left to cancel
        }
        return { done: true, value: undefined }
      },
    }),
  }
}

// What an answer that is not the stream fails the attempt with: an ApiError when asking again will not help
const refusalOf = async (response: Response, url: string): Promise<Error> => {
  if (isFinal(response.status)) {
    return new ApiError(response.status, await problemIn(response), url)
  }
  if (response.body !== null) {
    await response.body.cancel()
  }
  return new Error(`the daemon answered ${response.status}`)
}

// One connection, open: the daemon answered with the stream, so the next failure starts a new count
const opened = async (url: string, state: State): Promise<AsyncIterable<EventSourceMessage>> => {
  const { fetch: fetchImpl = fetch, signal, token } = state.options
  const init = {
    headers: headersOf(token, state.lastSeq),
    ...(signal === undefined ? {} : { signal }),
  }
  const response = await fetchImpl(url, init)
  if (!response.ok || response.body === null) {
    throw await refusalOf(response, url)
  }
  state.backoff = undefined
  state.failingSince = undefined
  return messagesOf(
    response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()),
  )
}

const isEnvelope = (value: unknown): value is EventEnvelope =>
  typeof value === 'object' &&
  value !== null &&
  Number.isInteger(Reflect.get(value, 'seq')) &&
  ['id', 'ts', 'type'].every((key) => typeof Reflect.get(value, key) === 'string')

// The envelope a frame carries; a frame that carries none is skipped
const envelopeOf = (message: EventSourceMessage): EventEnvelope | undefined => {
  try {
    const parsed: unknown = JSON.parse(message.data)
    return isEnvelope(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

async function* eventsOf(
  messages: AsyncIterable<EventSourceMessage>,
  state: State,
): AsyncGenerator<EventEnvelope> {
  const { filter, signal } = state.options
  for await (const message of messages) {
    const event = envelopeOf(message)
    if (aborted(signal)) {
      return
    }
    if (event !== undefined && event.seq !== 0) {
      state.lastSeq = event.seq
    }
    if (event !== undefined && (event.seq !== 0 || filter.ephemeral !== false)) {
      yield event
    }
  }
}

// A failed attempt ends the subscription when the daemon said no or reconnecting has failed for too long
const failed = (state: State, url: string, error: unknown): void => {
  if (aborted(state.options.signal)) {
    return
  }
  if (error instanceof ApiError) {
    throw error
  }
  const now = Date.now()
  state.failingSince ??= now
  if (now - state.failingSince > (state.options.retryFor ?? RETRY_FOR_MS)) {
    throw new ApiError(0, undefined, { url, cause: error })
  }
}

const nextBackoff = ({ backoff, options }: State): number =>
  backoff === undefined
    ? (options.backoffMs ?? FIRST_BACKOFF_MS)
    : Math.min(MAX_BACKOFF_MS, backoff * 2)

// One attempt: the pause it owes, then one connection whose events it yields until the connection ends
async function* attempt(state: State): AsyncGenerator<EventEnvelope> {
  await pause(state.backoff, state.options.signal)
  if (aborted(state.options.signal)) {
    return
  }
  const url = urlOf(state)
  try {
    yield* eventsOf(await opened(url, state), state)
  } catch (error) {
    failed(state, url, error)
  }
  state.backoff = nextBackoff(state)
}

/**
 * The events of the daemon from the filter's `since` on, resumed with `Last-Event-ID` after every end of a connection.
 * Ends quietly when the signal aborts. Throws an ApiError when the daemon refuses the subscription (a 4xx such as
 * 401 or 403), or once reconnecting has failed for longer than `retryFor`.
 */
export async function* subscribeEvents(options: SubscribeOptions): AsyncGenerator<EventEnvelope> {
  const state: State = { options, lastSeq: undefined, backoff: undefined, failingSince: undefined }
  while (!aborted(options.signal)) {
    yield* attempt(state)
  }
}
```
Replace `yield parsed as EventEnvelope` with a decode through the protocol's `EventEnvelope` schema? The client has no Effect: write a small structural guard (`isEnvelope(value)`: `seq` number, `id`, `ts`, `type` strings) and skip a frame that fails it. The `?.` calls become `if` statements. A `heartbeat` frame is an envelope of type `heartbeat` and is yielded like any other (consumers that want liveness read it; `ephemeral: false` drops it).

- [ ] **Step 4: The RPC codec and connection — codec test first**

`packages/client/src/rpc/codec.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { ApiError } from '../errors.js'
import {
  decodeFrame,
  encodeAck,
  encodeInterrupt,
  encodePing,
  encodeRequest,
  errorOf,
} from './codec.js'

const URL = 'ws://127.0.0.1:4747/api/v1/ws'

const RATE_LIMITED = {
  type: 'https://bytebureau.dev/problems/rate_limited',
  title: 'Too Many Requests',
  status: 429,
  detail: 'retry after 60 s',
  code: 'rate_limited',
}

describe('the RPC envelopes a client sends', () => {
  it('encodes a request with the token in its headers', () => {
    const request = { id: '1', tag: 'projects.register', payload: { path: '/r' }, token: 'tok' }
    expect(JSON.parse(encodeRequest(request))).toStrictEqual({
      _tag: 'Request',
      id: '1',
      tag: 'projects.register',
      payload: { path: '/r' },
      headers: [['authorization', 'Bearer tok']],
    })
  })

  it('encodes the ack, the interrupt and the ping', () => {
    expect(JSON.parse(encodeAck('1'))).toStrictEqual({ _tag: 'Ack', requestId: '1' })
    expect(JSON.parse(encodeInterrupt('1'))).toStrictEqual({ _tag: 'Interrupt', requestId: '1' })
    expect(JSON.parse(encodePing())).toStrictEqual({ _tag: 'Ping' })
  })
})

describe(decodeFrame, () => {
  it('decodes one message or a batch per frame', () => {
    const exit = { _tag: 'Exit', requestId: '1', exit: { _tag: 'Success', value: 'echo:hi' } }
    const chunk = { _tag: 'Chunk', requestId: '2', values: [1, 2, 3] }
    const defect = { _tag: 'Defect', defect: 'boom' }
    expect(decodeFrame(JSON.stringify(exit))).toStrictEqual([exit])
    expect(decodeFrame(JSON.stringify([chunk, { _tag: 'Pong' }]))).toStrictEqual([
      chunk,
      { _tag: 'Pong' },
    ])
    expect(decodeFrame(JSON.stringify(defect))).toStrictEqual([defect])
    const numbered = { _tag: 'Chunk', requestId: 2, values: [] }
    expect(decodeFrame(JSON.stringify(numbered))).toStrictEqual([numbered])
  })

  it('ignores what is not an envelope it knows', () => {
    expect(decodeFrame('{"nope":1}')).toStrictEqual([])
    expect(decodeFrame('not json')).toStrictEqual([])
    expect(decodeFrame('{"_tag":"Chunk","requestId":"2"}')).toStrictEqual([])
    expect(decodeFrame('{"_tag":"Exit","requestId":"1","exit":{"_tag":"Maybe"}}')).toStrictEqual([])
    expect(decodeFrame('[{"_tag":"Unknown"},{"_tag":"Pong"}]')).toStrictEqual([{ _tag: 'Pong' }])
  })
})

describe(errorOf, () => {
  it('fails with the problem the daemon said no with, as an ApiError', () => {
    const error = errorOf([{ _tag: 'Fail', error: RATE_LIMITED }], URL)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 429, problem: RATE_LIMITED, url: URL })
    expect(error.message).toBe('retry after 60 s (rate_limited)')
  })

  it('tells an interrupted request and a defect apart', () => {
    const interrupted = { _tag: 'Interrupt', fiberId: 195 }
    expect(errorOf([interrupted], URL).message).toBe('the request was interrupted')
    expect(errorOf([{ _tag: 'Die', defect: 'Unknown request tag: no.such' }], URL).message).toBe(
      'the daemon failed the request: Unknown request tag: no.such',
    )
    const died = errorOf([{ _tag: 'Die', defect: { name: 'Error', message: 'boom' } }], URL)
    expect(died.message).toBe('the daemon failed the request: boom')
  })

  it('tells a failure that carries no problem by what it carries, or says that it gave no reason', () => {
    expect(errorOf([{ _tag: 'Fail', error: 'not a problem' }], URL).message).toBe(
      'the daemon failed the request: not a problem',
    )
    expect(errorOf([{ _tag: 'Die', defect: 42 }], URL).message).toBe(
      'the daemon failed the request: no reason given',
    )
    expect(errorOf([], URL).message).toBe('the daemon failed the request: no reason given')
  })
})
```
`packages/client/src/rpc/codec.ts`:
```ts
import { ApiError, isProblem } from '../errors.js'

// The envelopes of effect/rpc in its JSON serialization (ADR-0013)
// A client sends Request, Ack, Interrupt and Ping; the daemon answers with Chunk, Exit, Defect and Pong

// One part of the cause of a failed exit: Fail carries the error, Die the defect, Interrupt neither
export interface CausePart {
  readonly _tag: string
  readonly error?: unknown
  readonly defect?: unknown
}

type Exit =
  | { readonly _tag: 'Success'; readonly value?: unknown }
  | { readonly _tag: 'Failure'; readonly cause: readonly CausePart[] }

export interface ChunkMessage {
  readonly _tag: 'Chunk'
  readonly requestId: string | number
  readonly values: readonly unknown[]
}

export interface ExitMessage {
  readonly _tag: 'Exit'
  readonly requestId: string | number
  readonly exit: Exit
}

// A failure of the whole connection, not of one request
interface DefectMessage {
  readonly _tag: 'Defect'
  readonly defect: unknown
}

interface PongMessage {
  readonly _tag: 'Pong'
}

export type ServerMessage = ChunkMessage | ExitMessage | DefectMessage | PongMessage

export interface RequestEnvelope {
  readonly id: string
  readonly tag: string
  readonly payload: unknown
  // Sent as the bearer token in the headers of the request, never in the url
  readonly token: string
}

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined

const tagOf = (value: unknown): unknown => field(value, '_tag')

const hasRequestId = (value: unknown): boolean => {
  const requestId = field(value, 'requestId')
  return typeof requestId === 'string' || typeof requestId === 'number'
}

const isCause = (value: unknown): value is readonly CausePart[] =>
  Array.isArray(value) && value.every((part) => typeof tagOf(part) === 'string')

const isExit = (value: unknown): value is Exit => {
  const tag = tagOf(value)
  return tag === 'Success' || (tag === 'Failure' && isCause(field(value, 'cause')))
}

const isServerMessage = (value: unknown): value is ServerMessage => {
  switch (tagOf(value)) {
    case 'Chunk': {
      return hasRequestId(value) && Array.isArray(field(value, 'values'))
    }
    case 'Exit': {
      return hasRequestId(value) && isExit(field(value, 'exit'))
    }
    case 'Defect':
    case 'Pong': {
      return true
    }
    default: {
      return false
    }
  }
}

const parsed = (text: string): unknown => {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    return undefined
  }
}

// A frame holds one message or a batch of them; anything else is noise the connection ignores
export const decodeFrame = (text: string): ServerMessage[] => {
  const value = parsed(text)
  const items: readonly unknown[] = Array.isArray(value) ? value : [value]
  return items.filter((item) => isServerMessage(item))
}

export const encodeRequest = ({ id, tag, payload, token }: RequestEnvelope): string =>
  JSON.stringify({
    _tag: 'Request',
    id,
    tag,
    payload,
    headers: [['authorization', `Bearer ${token}`]],
  })

export const encodeAck = (requestId: string): string => JSON.stringify({ _tag: 'Ack', requestId })

export const encodeInterrupt = (requestId: string): string =>
  JSON.stringify({ _tag: 'Interrupt', requestId })

export const encodePing = (): string => JSON.stringify({ _tag: 'Ping' })

// What a failure says about itself: a text, or the message of an error the daemon reported as { name, message }
export const reasonOf = (failure: unknown): string => {
  if (typeof failure === 'string') {
    return failure
  }
  const message = field(failure, 'message')
  return typeof message === 'string' ? message : 'no reason given'
}

// What a failed request is thrown as: the problem the daemon said no with, as an ApiError, or an Error that tells the cause
export const errorOf = (cause: readonly CausePart[], url: string): Error => {
  const problem = cause.map((part) => part.error).find((error) => isProblem(error))
  if (problem !== undefined) {
    return new ApiError(problem.status, problem, url)
  }
  if (cause.some((part) => tagOf(part) === 'Interrupt')) {
    return new Error('the request was interrupted')
  }
  const [first] = cause
  const failure = first === undefined ? undefined : (first.defect ?? first.error)
  return new Error(`the daemon failed the request: ${reasonOf(failure)}`)
}
```
`packages/client/src/rpc/connection.ts`:
```ts
import { ApiError } from '../errors.js'
import { encodeAck, encodePing, errorOf, type ExitMessage } from './codec.js'
import { Link, type Exchange, type RequestMessage, type Stop } from './link.js'

export interface RpcOptions {
  // The url of the socket: ws://<host>:<port>/api/v1/ws
  readonly url: string
  readonly token: string
  // The constructor to open the socket with; the global WebSocket by default
  readonly WebSocket?: typeof WebSocket | undefined
  readonly pingMs?: number | undefined
}

export interface RpcConnection {
  // Runs a procedure: the value of its exit, or its problem as an ApiError
  readonly call: (tag: string, payload: unknown) => Promise<unknown>
  // Runs a streaming procedure: every value of every chunk, until the daemon ends it or the signal aborts
  readonly stream: (tag: string, payload: unknown, signal?: AbortSignal) => AsyncIterable<unknown>
  // Closes the socket; a request still open fails
  readonly close: () => void
}

interface StreamRequest {
  readonly tag: string
  readonly payload: unknown
  readonly signal: AbortSignal | undefined
}

const PING_MS = 30_000

const STOPPED: Stop = { _tag: 'Stop', error: undefined }

// The end of a request: a failed exit or a closed connection throws, a success or a stop by its caller returns
const settle = (message: ExitMessage | Stop, url: string): unknown => {
  if ('error' in message) {
    if (message.error !== undefined) {
      throw message.error
    }
    return undefined
  }
  if ('cause' in message.exit) {
    throw errorOf(message.exit.cause, url)
  }
  return message.exit.value
}

const answerOf = (message: RequestMessage, url: string): unknown => {
  if ('values' in message) {
    throw new Error('the daemon answered a call with a stream')
  }
  return settle(message, url)
}

const called = async (link: Link, tag: string, payload: unknown): Promise<unknown> => {
  const exchange = link.open(tag, payload)
  const message = await exchange.inbox.take()
  exchange.release()
  return answerOf(message, link.url)
}

function* untilAborted(values: readonly unknown[], signal: AbortSignal): Generator {
  for (const value of values) {
    if (signal.aborted) {
      return
    }
    yield value
  }
}

// Each chunk is acknowledged once its values are taken, so the daemon sends the next one only as fast as they are read
async function* valuesOf(link: Link, exchange: Exchange, signal: AbortSignal): AsyncGenerator {
  for await (const message of exchange.inbox) {
    if (!('values' in message)) {
      settle(message, link.url)
      return
    }
    yield* untilAborted(message.values, signal)
    link.send(encodeAck(exchange.id))
  }
}

// Leaving early, or an aborted signal, interrupts the request on the daemon
async function* streamed(link: Link, { tag, payload, signal }: StreamRequest): AsyncGenerator {
  const watched = signal ?? new AbortController().signal
  if (watched.aborted) {
    return
  }
  const exchange = link.open(tag, payload)
  const stop = (): void => {
    exchange.inbox.push(STOPPED)
  }
  watched.addEventListener('abort', stop, { once: true })
  try {
    yield* valuesOf(link, exchange, watched)
  } finally {
    watched.removeEventListener('abort', stop)
    exchange.release()
  }
}

// Resolves once the socket is open; a socket that fails or closes first is a daemon that cannot be reached
const opened = async (socket: WebSocket, url: string): Promise<boolean> => {
  const { promise, resolve, reject } = Promise.withResolvers<boolean>()
  const unreachable = (): void => {
    reject(new ApiError(0, undefined, url))
  }
  socket.addEventListener(
    'open',
    () => {
      resolve(true)
    },
    { once: true },
  )
  socket.addEventListener('error', unreachable, { once: true })
  socket.addEventListener('close', unreachable, { once: true })
  const open = await promise
  return open
}

/**
 * Opens the effect/rpc connection of the daemon at the url: every request carries the bearer token in its headers,
 * streams are acknowledged chunk by chunk, and the connection pings while it is open.
 * Rejects with an ApiError of status 0 when the socket does not open.
 */
export async function connectRpc(options: RpcOptions): Promise<RpcConnection> {
  const { url, token, WebSocket: Socket = WebSocket, pingMs = PING_MS } = options
  const socket = new Socket(url)
  const link = new Link(socket, url, token)
  await opened(socket, url)
  const ping = setInterval(() => {
    link.send(encodePing())
  }, pingMs)
  socket.addEventListener('close', () => {
    clearInterval(ping)
  })
  return {
    call: async (tag, payload) => {
      const answer = await called(link, tag, payload)
      return answer
    },
    stream: (tag, payload, signal) => streamed(link, { tag, payload, signal }),
    close: () => {
      link.close(new Error('the connection is closed'))
    },
  }
}
```
`streamOf` (same file or `stream.ts`) returns an async generator: it registers a `Pending` whose `onMessage` pushes a `Chunk`'s values into a queue (and `send(encodeAck(id))` right away), resolves the end on `Exit` (or rejects with `errorOf`), sends `encodeInterrupt(id)` when `signal` aborts, and yields from the queue until the end. The `as ExitMessage` / `as never` casts are refused by the lint: narrow with a type guard on `_tag` and give `call` a generic parameter the caller supplies (`call<ProjectDto>(...)`), returning `exit.value` through a guard function the caller passes or through `unknown`. `?.` becomes `if`.

- [ ] **Step 5: The index and the integration tests against the daemon**

`packages/client/src/index.ts` builds `createBureauClient(options)` from `configureClient`, the resource objects of Step 2, `events.subscribe(filter, { signal }) → subscribeEvents({ ...options, filter, signal, retryFor })`, `rpc.connect() → connectRpc({ url: options.baseUrl.replace(/^http/u, 'ws') + '/api/v1/ws', token })` and `close()` (a no-op for fetch; closes nothing the caller did not open). It exports `BureauClient`, `ClientOptions { baseUrl, token, fetch?, retryFor? }`, `ApiError`, `subscribeEvents`, `connectRpc`, `RpcConnection`.

`packages/api/src/client.test.ts` (criterion 9: the client round-trips every endpoint; `@bytebureau/client` is a devDependency of `packages/api`):
```ts
import { ApiError, createBureauClient, type BureauClient } from '@bytebureau/client'
import type { EventLog } from '@bytebureau/kernel'
import { createTempRepo, writeConfig } from '@bytebureau/kernel/testing'
import type { AskRecord, ProjectDto, SessionDto } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect, type Cause } from 'effect'
import { ApiTestLayer, baseUrl, TEST_TOKEN } from './testing.js'
import { awaited, client, refused } from './testing-client.js'
import { fakeProjectConfig, firstEvent, recommendedOption, UNKNOWN_ID } from './testing-sessions.js'

interface Created {
  readonly project: ProjectDto
  readonly session: SessionDto
}

// A session of a fresh project, both made through the client
const createdWith = (api: BureauClient): Effect.Effect<Created> =>
  Effect.gen(function* creates() {
    const repo = createTempRepo()
    writeConfig(repo, fakeProjectConfig)
    const project = yield* awaited(api.projects.register({ path: repo }))
    const session = yield* awaited(
      api.sessions.create({ projectId: project.id, title: 'Create hello' }),
    )
    return { project, session }
  })

const HELLO = {
  text: 'Create src/hello.ts exporting hello()',
  attachments: [{ path: 'README.md' }],
}

// The question of the first turn of a session, as the client reads it
const askedWith = (
  api: BureauClient,
  sessionId: string,
): Effect.Effect<AskRecord, Cause.NoSuchElementError, EventLog> =>
  Effect.gen(function* asks() {
    const turn = yield* awaited(api.sessions.prompt(sessionId, HELLO))
    assert.containSubset(turn, { sessionId, index: 0, prompt: HELLO })
    yield* firstEvent(sessionId, 'ask.requested').pipe(Effect.orDie)
    const [ask] = yield* awaited(api.asks.pending(sessionId))
    return yield* Effect.fromNullishOr(ask)
  })

it.layer(ApiTestLayer())('the projects and the daemon through @bytebureau/client', (suite) => {
  suite.effect(
    'registers, lists, reads and removes a project; an unknown one reads as undefined',
    () =>
      Effect.gen(function* projects() {
        const api = yield* client
        const repo = createTempRepo()
        writeConfig(repo, fakeProjectConfig)
        const project = yield* awaited(api.projects.register({ path: repo }))
        assert.containSubset(yield* awaited(api.projects.list()), [{ id: project.id, path: repo }])
        assert.deepStrictEqual(yield* awaited(api.projects.get(project.id)), project)
        assert.isUndefined(yield* awaited(api.projects.get(UNKNOWN_ID)))
        yield* awaited(api.projects.remove(project.id))
        assert.isUndefined(yield* awaited(api.projects.get(project.id)))
      }),
  )

  suite.effect('lists the plugins and the providers and checks the health', () =>
    Effect.gen(function* daemon() {
      const api = yield* client
      const plugins = yield* awaited(api.plugins.list())
      assert.deepStrictEqual(
        plugins.map((plugin) => plugin.state),
        ['loaded', 'loaded'],
      )
      assert.containSubset(yield* awaited(api.plugins.providers()), [{ id: 'fake' }])
      const health = yield* awaited(api.health.check())
      assert.containSubset(health, { status: 'ok', version: '0.0.0-test' })
    }),
  )
})

it.layer(ApiTestLayer())('the asks of the API through @bytebureau/client', (suite) => {
  suite.effect('lists the pending questions of one session, or of every session', () =>
    Effect.gen(function* pending() {
      const api = yield* client
      const first = yield* createdWith(api)
      const second = yield* createdWith(api)
      const ask = yield* askedWith(api, first.session.id)
      const other = yield* askedWith(api, second.session.id)
      const ofFirst = yield* awaited(api.asks.pending(first.session.id))
      assert.deepStrictEqual(
        ofFirst.map((waiting) => waiting.id),
        [ask.id],
      )
      const all = yield* awaited(api.asks.pending())
      assert.includeMembers(
        all.map((waiting) => waiting.id),
        [ask.id, other.id],
      )
    }),
  )

  suite.effect('reads the question of a session pending, answers it and reads it answered', () =>
    Effect.gen(function* answers() {
      const api = yield* client
      const { session } = yield* createdWith(api)
      const ask = yield* askedWith(api, session.id)
      assert.containSubset(yield* awaited(api.asks.get(ask.id)), { status: 'pending' })
      const option = yield* recommendedOption(ask)
      yield* awaited(api.asks.answer(ask.id, { selected: [option.id] }))
      const answered = { status: 'answered', answeredVia: 'api', answer: { selected: [option.id] } }
      assert.containSubset(yield* awaited(api.asks.get(ask.id)), answered)
      assert.isUndefined(yield* awaited(api.asks.get(UNKNOWN_ID)))
    }),
  )
})

it.layer(ApiTestLayer())('the sessions of the API through @bytebureau/client', (suite) => {
  suite.effect('completes a session whose turn is done, and reads it, its usage and the list', () =>
    Effect.gen(function* completes() {
      const api = yield* client
      const { session } = yield* createdWith(api)
      const ask = yield* askedWith(api, session.id)
      yield* awaited(api.asks.answer(ask.id, { selected: 'other', otherText: 'a default export' }))
      yield* firstEvent(session.id, 'turn.completed')
      yield* awaited(api.sessions.complete(session.id))
      assert.containSubset(yield* awaited(api.sessions.get(session.id)), { status: 'completed' })
      const usage = { turns: 1, inputTokens: 120, outputTokens: 40, costUsd: 0.002, contextPct: 3 }
      assert.deepStrictEqual(yield* awaited(api.usage.session(session.id)), usage)
      assert.containSubset(yield* awaited(api.sessions.list()), [{ id: session.id }])
    }),
  )

  suite.effect('stops and resumes a session; an interrupt without an agent is refused', () =>
    Effect.gen(function* stops() {
      const api = yield* client
      const { session } = yield* createdWith(api)
      const notFound = { status: 404, problem: { code: 'session_not_found' } }
      assert.containSubset(yield* refused(api.sessions.interrupt(session.id)), notFound)
      yield* awaited(api.sessions.stop(session.id))
      assert.containSubset(yield* awaited(api.sessions.get(session.id)), { status: 'stopped' })
      const resumed = yield* awaited(api.sessions.resume(session.id))
      assert.containSubset(resumed, { id: session.id, status: 'ready' })
      assert.isUndefined(yield* awaited(api.sessions.get(UNKNOWN_ID)))
    }),
  )
})

it.layer(ApiTestLayer())('the worktrees of the API through @bytebureau/client', (suite) => {
  suite.effect('lists the worktrees of one project, or of every project', () =>
    Effect.gen(function* lists() {
      const api = yield* client
      const { project, session } = yield* createdWith(api)
      const elsewhere = yield* createdWith(api)
      const ofProject = yield* awaited(api.workspaces.list(project.id))
      assert.containSubset(ofProject, [{ sessionId: session.id, projectId: project.id }])
      assert.deepStrictEqual(
        ofProject.map((info) => info.sessionId),
        [session.id],
      )
      const all = yield* awaited(api.workspaces.list())
      assert.includeMembers(
        all.map((info) => info.sessionId),
        [session.id, elsewhere.session.id],
      )
    }),
  )

  suite.effect('prunes the worktrees of one project, or of every project', () =>
    Effect.gen(function* prunes() {
      const api = yield* client
      const { project, session } = yield* createdWith(api)
      const elsewhere = yield* createdWith(api)
      const here = yield* Effect.fromNullishOr(session.workspace)
      const there = yield* Effect.fromNullishOr(elsewhere.session.workspace)
      const pruned = yield* awaited(api.workspaces.prune(project.id))
      assert.deepStrictEqual(pruned, {
        removed: [],
        retained: [{ path: here.path, reason: 'session is ready' }],
      })
      const all = yield* awaited(api.workspaces.prune())
      assert.includeMembers(
        all.retained.map((kept) => kept.path),
        [here.path, there.path],
      )
    }),
  )
})

it.layer(ApiTestLayer())('the refusals @bytebureau/client throws', (suite) => {
  suite.effect('throws a problem as an ApiError: an unknown session, a wrong token', () =>
    Effect.gen(function* refuses() {
      const api = yield* client
      const unknown = yield* refused(api.sessions.prompt(UNKNOWN_ID, { text: 'x' }))
      assert.instanceOf(unknown, ApiError)
      assert.containSubset(unknown, { status: 404, problem: { code: 'session_not_found' } })
      const intruder = createBureauClient({ baseUrl: yield* baseUrl, token: 'not-the-token' })
      const denied = yield* refused(intruder.projects.list())
      assert.containSubset(denied, { status: 401, problem: { code: 'unauthorized' } })
    }),
  )

  suite.effect('throws an ApiError of status 0 that names the url when no daemon answers', () =>
    Effect.gen(function* unreachable() {
      const offline = createBureauClient({ baseUrl: 'http://127.0.0.1:1', token: TEST_TOKEN })
      const failure = yield* refused(offline.health.check())
      assert.instanceOf(failure, ApiError)
      assert.containSubset(failure, { status: 0, url: 'http://127.0.0.1:1/api/v1/health' })
      assert.strictEqual(
        failure instanceof Error ? failure.message : '',
        'cannot reach the daemon at http://127.0.0.1:1/api/v1/health',
      )
    }),
  )
})
```
`interrupt` on a `ready` session and `remove` of a project with sessions are refusals the test ignores on purpose: the point is that every method is wired; `sessions.test.ts` of Task 4 asserts their semantics.

`packages/api/src/client-events.test.ts`: over `ApiTestLayer({ heartbeat: '100 millis' })` built with `{ excludeTestServices: true }`, `client.events.subscribe({ sessionId, since: 0 }, { signal })` yields the durable events of a created session in seq order (the first envelope is a `heartbeat` — assert on the frames with `seq !== 0`) and then a live `turn.started` after a prompt; a second subscription with `{ ephemeral: false }` yields no `heartbeat`; `client.rpc.connect()` then `call('projects.register', { path })` resolves with the project, `stream('events.subscribe', { sessionId, since: 0 }, signal)` yields `session.created` first and ends when the signal aborts, `call` without a valid token (a second `connectRpc` with `token: 'bad'`) rejects with `ApiError` 401.

`packages/client/src/rpc/link.ts` (added during execution):
```ts
import { ApiError } from '../errors.js'
import {
  decodeFrame,
  encodeInterrupt,
  encodeRequest,
  reasonOf,
  type ChunkMessage,
  type ExitMessage,
  type ServerMessage,
} from './codec.js'

// A request that ends without its exit: the connection closed under it (error), or its caller stopped it (none)
export interface Stop {
  readonly _tag: 'Stop'
  readonly error: Error | undefined
}

export type RequestMessage = ChunkMessage | ExitMessage | Stop

// The messages of one request in the order they came: the link pushes, the request takes them one at a time
export interface Inbox extends AsyncIterable<RequestMessage> {
  readonly push: (message: RequestMessage) => void
  readonly take: () => Promise<RequestMessage>
}

const inboxOf = (): Inbox => {
  const messages: RequestMessage[] = []
  const takers: ((message: RequestMessage) => void)[] = []
  const take = async (): Promise<RequestMessage> => {
    const first = messages.shift()
    if (first !== undefined) {
      return first
    }
    const { promise, resolve } = Promise.withResolvers<RequestMessage>()
    takers.push(resolve)
    const taken = await promise
    return taken
  }
  return {
    push: (message) => {
      const taker = takers.shift()
      if (taker === undefined) {
        messages.push(message)
      } else {
        taker(message)
      }
    },
    take,
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const value = await take()
        return { done: false, value }
      },
    }),
  }
}

export interface Exchange {
  readonly id: string
  readonly inbox: Inbox
  // Done with the request: it is forgotten, and interrupted unless the daemon has ended it already
  readonly release: () => void
}

/** The socket as the requests of one connection see it: each request has an inbox its messages are routed to. */
export class Link {
  public readonly url: string
  private readonly socket: WebSocket
  private readonly token: string
  // The requests the daemon has not ended yet, by id
  private readonly requests = new Map<string, Inbox>()
  private closedWith: Error | undefined
  private lastId = 0

  /**
   * @param socket The socket of the connection, listened to from now on.
   * @param url The url of the socket, which the errors name.
   * @param token The bearer token every request carries in its headers.
   */
  public constructor(socket: WebSocket, url: string, token: string) {
    this.socket = socket
    this.url = url
    this.token = token
    socket.addEventListener('message', (event) => {
      this.receive(event.data)
    })
    socket.addEventListener('close', () => {
      this.end(new ApiError(0, undefined, url))
    })
  }

  /** Sends one envelope while the connection is open. */
  public send(text: string): void {
    if (this.closedWith === undefined) {
      this.socket.send(text)
    }
  }

  /** Sends a request and gives the exchange whose inbox its messages arrive in. */
  public open(tag: string, payload: unknown): Exchange {
    this.lastId += 1
    const id = String(this.lastId)
    const inbox = inboxOf()
    if (this.closedWith === undefined) {
      this.requests.set(id, inbox)
      this.send(encodeRequest({ id, tag, payload, token: this.token }))
    } else {
      inbox.push({ _tag: 'Stop', error: this.closedWith })
    }
    return {
      id,
      inbox,
      release: () => {
        this.release(id)
      },
    }
  }

  /** Closes the socket; a request still open fails with the error given. */
  public close(error: Error): void {
    this.end(error)
    this.socket.close()
  }

  private release(id: string): void {
    if (this.requests.delete(id)) {
      this.send(encodeInterrupt(id))
    }
  }

  private receive(data: unknown): void {
    for (const message of decodeFrame(typeof data === 'string' ? data : '')) {
      this.route(message)
    }
  }

  // A defect is a failure of the whole connection; a pong needs nothing
  private route(message: ServerMessage): void {
    if ('defect' in message) {
      this.close(new Error(`the daemon failed: ${reasonOf(message.defect)}`))
    } else if ('requestId' in message) {
      this.deliver(String(message.requestId), message)
    }
  }

  // An exit is the last message of its request
  private deliver(id: string, message: ChunkMessage | ExitMessage): void {
    const inbox = this.requests.get(id)
    if ('exit' in message) {
      this.requests.delete(id)
    }
    if (inbox !== undefined) {
      inbox.push(message)
    }
  }

  private end(error: Error): void {
    this.closedWith ??= error
    for (const inbox of this.requests.values()) {
      inbox.push({ _tag: 'Stop', error: this.closedWith })
    }
    this.requests.clear()
  }
}
```
`packages/client/src/http.test.ts` (added during execution):
```ts
import { describe, expect, it } from 'vitest'
import { ApiError } from './errors.js'
import { createBureauClient } from './index.js'
import { frame, serve, status, stream } from './sse-fixture.js'

// What a call of the client was refused with
const failureOf = async (call: Promise<unknown>): Promise<unknown> => {
  try {
    await call
  } catch (error) {
    return error
  }
  return 'not refused'
}

const CONFLICT = {
  type: 'https://bytebureau.dev/problems/session_invalid_transition',
  title: 'Conflict',
  status: 409,
  detail: 'cannot stop a completed session',
  code: 'session_invalid_transition',
}

const INTERNAL = {
  type: 'https://bytebureau.dev/problems/internal',
  title: 'Internal Server Error',
  status: 500,
  detail: 'unexpected failure',
  code: 'internal',
}

describe(createBureauClient, () => {
  it('throws the problem of an answer as an ApiError that names the request, with the bearer token sent', async () => {
    expect.hasAssertions()
    const served = await serve([status(409, CONFLICT)])
    const client = createBureauClient({ baseUrl: served.url, token: 'tok' })
    const failure = await failureOf(client.sessions.stop('s1'))
    expect(failure).toBeInstanceOf(ApiError)
    const url = `${served.url}/api/v1/sessions/s1/stop`
    expect(failure).toMatchObject({ status: 409, problem: CONFLICT, url })
    expect(served.requests).toMatchObject([
      { url: '/api/v1/sessions/s1/stop', authorization: 'Bearer tok' },
    ])
  })

  it('throws an answer without a problem as an ApiError of its status', async () => {
    expect.hasAssertions()
    const served = await serve([status(502)])
    const failure = await failureOf(
      createBureauClient({ baseUrl: served.url, token: 'tok' }).projects.list(),
    )
    expect(failure).toMatchObject({ status: 502, problem: undefined })
    expect(failure).toHaveProperty('message', 'the daemon answered 502')
  })

  it('throws a 2xx answer without the data a query needs as an ApiError of its status', async () => {
    expect.hasAssertions()
    const served = await serve([status(204)])
    const failure = await failureOf(
      createBureauClient({ baseUrl: served.url, token: 'tok' }).projects.list(),
    )
    expect(failure).toMatchObject({ status: 204, problem: undefined })
  })
})

describe('the lookups and the close of a client', () => {
  it('reads a lookup the daemon answers 404 as undefined, and throws any other refusal', async () => {
    expect.hasAssertions()
    const served = await serve([status(404), status(500, INTERNAL)])
    const client = createBureauClient({ baseUrl: served.url, token: 'tok' })
    await expect(client.sessions.get('s1')).resolves.toBeUndefined()
    await expect(client.sessions.get('s1')).rejects.toMatchObject({
      status: 500,
      problem: INTERNAL,
    })
  })

  it('joins the paths to a base url that ends with a slash', async () => {
    expect.hasAssertions()
    const served = await serve([status(404), stream(frame(1, 'a'))])
    const client = createBureauClient({ baseUrl: `${served.url}/`, token: 'tok' })
    await expect(client.projects.get('p1')).resolves.toBeUndefined()
    for await (const event of client.events.subscribe({})) {
      expect(event.seq).toBe(1)
      break
    }
    expect(served.requests.map((request) => request.url)).toStrictEqual([
      '/api/v1/projects/p1',
      '/api/v1/events',
    ])
  })

  it('closes without anything to release', async () => {
    expect.hasAssertions()
    await expect(
      createBureauClient({ baseUrl: 'http://127.0.0.1:1', token: 'tok' }).close(),
    ).resolves.toBeUndefined()
  })
})
```
`packages/client/src/sse-fixture.ts` (added during execution):
```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { onTestFinished } from 'vitest'

// One SSE frame as the daemon writes it: durable events carry their seq as the id, ephemeral ones (seq 0) none
export const frame = (seq: number, type: string): string => {
  const envelope = { seq, id: `e${seq}`, ts: '2026-10-04T00:00:00.000Z', type, payload: {} }
  const id = seq === 0 ? '' : `id: ${seq}\n`
  return `${id}event: ${type}\ndata: ${JSON.stringify(envelope)}\n\n`
}

interface Seen {
  readonly url: string
  readonly lastEventId: string | undefined
  readonly authorization: string | undefined
}

export interface Served {
  readonly url: string
  readonly requests: readonly Seen[]
}

// What the fake daemon does with the connection of its turn
export type Step = (response: ServerResponse) => void

const headerOf = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

const seenOf = (request: IncomingMessage): Seen => ({
  url: decodeURIComponent(request.url ?? ''),
  lastEventId: headerOf(request, 'last-event-id'),
  authorization: headerOf(request, 'authorization'),
})

const portOf = (address: ReturnType<ReturnType<typeof createServer>['address']>): number => {
  if (address === null || typeof address === 'string') {
    throw new Error('the fake daemon has no port')
  }
  return address.port
}

// A fake daemon on a loopback port: each connection gets the step of its turn, the last step repeats; it closes with the test
export const serve = async (script: readonly Step[]): Promise<Served> => {
  const requests: Seen[] = []
  const server = createServer((request, response) => {
    requests.push(seenOf(request))
    const step = script[Math.min(requests.length, script.length) - 1]
    if (step !== undefined) {
      step(response)
    }
  })
  const listening = Promise.withResolvers<boolean>()
  server.listen(0, '127.0.0.1', () => {
    listening.resolve(true)
  })
  await listening.promise
  onTestFinished(async () => {
    const closed = Promise.withResolvers<boolean>()
    server.closeAllConnections()
    server.close(() => {
      closed.resolve(true)
    })
    await closed.promise
  })
  return { url: `http://127.0.0.1:${portOf(server.address())}`, requests }
}

// An event stream: the frames given, then the end of the response unless it is kept open
export const stream =
  (body: string, end = true): Step =>
  (response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(body)
    if (end) {
      response.end()
    }
  }

// An answer with a status and, when given, a problem as its body
export const status =
  (code: number, problem?: object): Step =>
  (response) => {
    if (problem === undefined) {
      response.writeHead(code).end()
      return
    }
    response.writeHead(code, { 'content-type': 'application/problem+json' })
    response.end(JSON.stringify(problem))
  }

// A connection that breaks before any answer
export const broken: Step = (response) => {
  response.destroy()
}
```
`packages/api/src/testing-client.ts` (added during execution):
```ts
import { createBureauClient, type BureauClient, type RpcConnection } from '@bytebureau/client'
import { Effect, type Scope } from 'effect'
import type { HttpServer } from 'effect/http'
import { WS_PATH } from './rpc/group.js'
import { baseUrl, TEST_TOKEN } from './testing.js'

// The client of the server under test, made as the CLI makes it
export const client: Effect.Effect<BureauClient, never, HttpServer.HttpServer> = baseUrl.pipe(
  Effect.map((url) => createBureauClient({ baseUrl: url, token: TEST_TOKEN })),
)

// The url of the RPC socket of the server under test
export const wsUrl: Effect.Effect<string, never, HttpServer.HttpServer> = baseUrl.pipe(
  Effect.map((url) => `${url.replace(/^http/u, 'ws')}${WS_PATH}`),
)

// What a call of the client resolves with; a rejection fails the test
export const awaited = <Value>(call: Promise<Value>): Effect.Effect<Value> =>
  Effect.promise(async () => {
    const value = await call
    return value
  })

// What a call that has to fail failed with
export const refused = (call: Promise<unknown>): Effect.Effect<unknown> =>
  Effect.promise(async () => {
    try {
      await call
    } catch (error) {
      return error
    }
    return 'not refused'
  })

// An RPC connection that closes with the test, whatever its outcome
export const opened = (
  connect: Promise<RpcConnection>,
): Effect.Effect<RpcConnection, never, Scope.Scope> =>
  Effect.acquireRelease(awaited(connect), (connection) =>
    Effect.sync(() => {
      connection.close()
    }),
  )
```
`packages/api/src/client-rpc.test.ts` (added during execution):
```ts
import { ApiError, connectRpc, type BureauClient, type RpcConnection } from '@bytebureau/client'
import { createTempRepo, writeConfig } from '@bytebureau/kernel/testing'
import { ProjectDto, type SessionDto } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect, Schedule, Schema } from 'effect'
import { ApiTestLayer, TEST_TOKEN } from './testing.js'
import { awaited, client, opened, refused, wsUrl } from './testing-client.js'
import { createdSession, fakeProjectConfig } from './testing-sessions.js'

const LIVE = { excludeTestServices: true }

// The streaming procedure of the daemon
const SUBSCRIBE = 'events.subscribe'

// The type of an event a stream gave, read without trusting its shape
const typeOf = (value: unknown): unknown =>
  typeof value === 'object' && value !== null ? Reflect.get(value, 'type') : undefined

// A session of a project registered over the socket
const createdOver = (api: BureauClient, connection: RpcConnection): Effect.Effect<SessionDto> =>
  Effect.gen(function* creates() {
    const repo = createTempRepo()
    writeConfig(repo, fakeProjectConfig)
    const registered = yield* awaited(connection.call('projects.register', { path: repo }))
    const project = Schema.decodeUnknownSync(ProjectDto)(registered)
    assert.strictEqual(project.path, repo)
    return yield* awaited(api.sessions.create({ projectId: project.id, title: 'Over the socket' }))
  })

interface TurnStream {
  readonly api: BureauClient
  readonly sessionId: string
  readonly controller: AbortController
  readonly values: AsyncIterable<unknown>
}

// The values of a stream through a live turn, which comes in a later chunk than the replay
// The prompt goes out once the replay has reached session.ready; the signal aborts at turn.started
const throughTurn = async ({
  api,
  sessionId,
  controller,
  values,
}: TurnStream): Promise<unknown[]> => {
  const seen: unknown[] = []
  const prompts: Promise<unknown>[] = []
  for await (const value of values) {
    seen.push(value)
    if (typeOf(value) === 'session.ready') {
      prompts.push(api.sessions.prompt(sessionId, { text: 'go' }))
    }
    if (typeOf(value) === 'turn.started') {
      controller.abort()
    }
  }
  await Promise.all(prompts)
  return seen
}

// The values of a stream whose signal aborts at the first one
const abortedAtFirst = async (
  values: AsyncIterable<unknown>,
  controller: AbortController,
): Promise<unknown[]> => {
  const seen: unknown[] = []
  for await (const value of values) {
    seen.push(value)
    controller.abort()
  }
  return seen
}

// Reads a stream to its end and gives what it failed with
const streamFailure = async (values: AsyncIterable<unknown>): Promise<unknown> => {
  try {
    for await (const value of values) {
      return value
    }
  } catch (error) {
    return error
  }
  return 'not refused'
}

interface ClosedUnder {
  readonly read: readonly unknown[]
  readonly failure: unknown
}

// Closes the connection as soon as the stream gives a value: what the stream gave, and what it then failed with
const closedUnder = async (
  values: AsyncIterable<unknown>,
  connection: RpcConnection,
): Promise<ClosedUnder> => {
  const read: unknown[] = []
  try {
    for await (const value of values) {
      read.push(value)
      connection.close()
    }
  } catch (error) {
    return { read, failure: error }
  }
  return { read, failure: 'not failed' }
}

// The messages of every frame a recording socket has received; the client keeps what it ignores to itself
const received: string[] = []

const messagesReceived = (): unknown[] =>
  received.flatMap((frame) => {
    const parsed: unknown = JSON.parse(frame)
    const messages: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
    return messages
  })

// A socket that records the frames it receives
class RecordingSocket extends WebSocket {
  public constructor(url: string | URL) {
    super(url)
    this.addEventListener('message', (event) => {
      received.push(typeof event.data === 'string' ? event.data : '')
    })
  }
}

const INTERRUPTED = { _tag: 'Exit', exit: { _tag: 'Failure', cause: [{ _tag: 'Interrupt' }] } }

const isInterruptedExit = (message: unknown, requestId: string): boolean =>
  typeof message === 'object' &&
  message !== null &&
  Reflect.get(message, 'requestId') === requestId &&
  JSON.stringify(message).includes('"_tag":"Interrupt"')

// The exit the daemon ended an interrupted request with, once it has come
const interruptedExit = (requestId: string): Effect.Effect<unknown> =>
  Effect.sync(() =>
    messagesReceived().find((message) => isInterruptedExit(message, requestId)),
  ).pipe(
    Effect.repeat({ until: (exit) => exit !== undefined, schedule: Schedule.spaced('10 millis') }),
    Effect.timeout('5 seconds'),
    Effect.orDie,
  )

it.layer(ApiTestLayer(), LIVE)('the RPC connection of @bytebureau/client', (suite) => {
  suite.effect('calls a procedure and streams past the first chunk until the signal aborts', () =>
    Effect.gen(function* streams() {
      const api = yield* client
      const connection = yield* opened(api.rpc.connect())
      const session = yield* createdOver(api, connection)
      const controller = new AbortController()
      const payload = { sessionId: session.id, since: 0 }
      const values = connection.stream(SUBSCRIBE, payload, controller.signal)
      const seen = yield* awaited(throughTurn({ api, sessionId: session.id, controller, values }))
      assert.containSubset(seen.at(0), { type: 'session.created', sessionId: session.id })
      assert.containSubset(seen.at(-1), { type: 'turn.started', sessionId: session.id })
    }),
  )

  suite.effect('interrupts the request on the daemon when the signal aborts', () =>
    Effect.gen(function* interrupts() {
      const url = yield* wsUrl
      const connection = yield* opened(
        connectRpc({ url, token: TEST_TOKEN, WebSocket: RecordingSocket }),
      )
      const { session } = yield* createdSession
      const controller = new AbortController()
      const payload = { sessionId: session.id, since: 0 }
      const values = connection.stream(SUBSCRIBE, payload, controller.signal)
      assert.lengthOf(yield* awaited(abortedAtFirst(values, controller)), 1)
      assert.containSubset(yield* interruptedExit('1'), { ...INTERRUPTED, requestId: '1' })
    }),
  )

  suite.effect('keeps answering between its pings and fails what is asked once it is closed', () =>
    Effect.gen(function* closes() {
      const connection = yield* opened(
        connectRpc({ url: yield* wsUrl, token: TEST_TOKEN, pingMs: 10 }),
      )
      yield* Effect.sleep('50 millis')
      const repo = createTempRepo()
      const registered = yield* awaited(connection.call('projects.register', { path: repo }))
      assert.containSubset(registered, { path: repo })
      const streamCall = yield* refused(connection.call(SUBSCRIBE, { since: 0 }))
      assert.containSubset(streamCall, { message: 'the daemon answered a call with a stream' })
      connection.close()
      const closed = yield* refused(connection.call('projects.register', { path: repo }))
      assert.containSubset(closed, { message: 'the connection is closed' })
    }),
  )
})

it.layer(ApiTestLayer(), LIVE)('the end of a stream of the RPC connection', (suite) => {
  suite.effect('opens no stream for a signal that has aborted already', () =>
    Effect.gen(function* opensNone() {
      const api = yield* client
      const connection = yield* opened(api.rpc.connect())
      const { session } = yield* createdSession
      const controller = new AbortController()
      controller.abort()
      const payload = { sessionId: session.id, since: 0 }
      const none = connection.stream(SUBSCRIBE, payload, controller.signal)
      assert.deepStrictEqual(yield* awaited(abortedAtFirst(none, controller)), [])
    }),
  )

  suite.effect('fails a stream that its connection closes under', () =>
    Effect.gen(function* closesUnder() {
      const api = yield* client
      const connection = yield* opened(api.rpc.connect())
      const { session } = yield* createdSession
      const values = connection.stream(SUBSCRIBE, { sessionId: session.id, since: 0 })
      const { read, failure } = yield* awaited(closedUnder(values, connection))
      assert.containSubset(read.at(0), { type: 'session.created' })
      assert.containSubset(failure, { message: 'the connection is closed' })
    }),
  )
})

it.layer(ApiTestLayer(), LIVE)('the refusals of the RPC connection', (suite) => {
  suite.effect('refuses a call and a stream without a valid token with the 401 problem', () =>
    Effect.gen(function* refuses() {
      const intruder = yield* opened(connectRpc({ url: yield* wsUrl, token: 'bad' }))
      const unauthorized = { status: 401, problem: { code: 'unauthorized' } }
      const called = yield* refused(intruder.call('projects.register', { path: createTempRepo() }))
      assert.instanceOf(called, ApiError)
      assert.containSubset(called, unauthorized)
      const streamed = intruder.stream(SUBSCRIBE, { since: 0 })
      assert.containSubset(yield* awaited(streamFailure(streamed)), unauthorized)
    }),
  )

  suite.effect('rejects with an ApiError of status 0 when the socket does not open', () =>
    Effect.gen(function* unreachable() {
      const url = 'ws://127.0.0.1:1/api/v1/ws'
      const failure = yield* refused(connectRpc({ url, token: TEST_TOKEN }))
      assert.instanceOf(failure, ApiError)
      assert.containSubset(failure, { status: 0, url })
    }),
  )
})
```

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

Semantics (as shipped, commits 9cc3c70, 526ca5a, b26ff56, 795ac6a, c222e71, 80faaa8, 7949614, 34bb23d, 5d525a1, c4099cf): the **token persists in `<home>/daemon.token`** (0600) and is copied into `server.json` while a daemon runs (`server.json` goes with the daemon); both files and the lock are written through `private-file.ts` (temp + fsync + chmod + rename at 0600, directories 0700); the **lock** is written aside as `daemon.lock.<pid>` and linked into place (always holds the pid), and a stale lock is **taken over by atomic rename** (`daemon.lock.<pid>.stale`): only the moved file is judged — a dead holder is removed, a live one is linked back and refused with its pid; a lock that keeps changing hands fails after five rounds; **boot before serve** — the plugin load and the recovery are a layer the server layer depends on, so no request is served before recovery (`bun.ts` `Boot`); a bind failure reads `cannot listen on <host>:<port>: the port is taken or the address is not this machine's` (`daemon-errors.ts` `PortInUseError`; Bun reports EADDRINUSE for a foreign address too) and the same module holds the **error reporter** that logs a handler defect of either door under `bb.api`; `startDaemon` picks host and port from the flags, else the user configuration's `server.host`/`server.port` read inside the same runtime, else 127.0.0.1/4747; a **wildcard bind** (`0.0.0.0`/`::`) records `127.0.0.1`/`::1` as the client host (`hosts.ts`) and the LAN warning names the bound host; `--stop` and the detached `serve` act only on a daemon whose health answers with the `startedAt` of `server.json` (`wait.ts` `daemonAnswers`/`runningDaemon`) and **`--stop` removes a record only when its pid is dead** — a live pid that does not answer keeps its record and `--stop` exits 1; `foreground.ts` is loaded with a dynamic import only in the `--no-daemonize` branch, so no other command loads the API stack; `windowsHide: true` on the detached spawn; the `--json` record is `{ command: 'serve', url, pid, version }` (and `serve.stop` for `--stop`); `--port` is validated; `testHome()` (`testing/temp-repo.ts`) writes `config.json` with `server.port: 0` so test daemons never bind 4747, and `startDaemonProcess(home, extra?)` ends its daemon through the lock's pid as a fallback. Known for the whole-branch review: a crash or a failed link inside the two-syscall takeover window can leave a live daemon without its lock, and a third start in the instant a displaced lock is put back could acquire beside it (a takeover mutex would close both); leftover `daemon.lock.<pid>.stale`/draft files after a crash are never removed; removing a stale record is check-then-act over two syscalls; a wildcard host from `config.json` gets its LAN warning only in `daemon.log`; a failed detached start waits the full 10 s.

- [ ] **Step 1: `startDaemon` in `packages/api`**

`packages/api/package.json` exports gain `"./bun": { "types": "./src/bun.ts", "default": "./src/bun.ts" }`.

`packages/api/src/bun-address.ts`:
```ts
export interface BoundAddress {
  readonly host: string
  readonly port: number
}

// The host and port of the address the platform prints, with or without a scheme; an IPv6 host loses its brackets
// The URL parser drops port 80, the default of the scheme
export const boundAddress = (formatted: string): BoundAddress => {
  const url = new URL(formatted.startsWith('http') ? formatted : `http://${formatted}`)
  return {
    host: url.hostname.replaceAll(/^\[|\]$/gu, ''),
    port: url.port === '' ? 80 : Number(url.port),
  }
}
```
`packages/api/src/bun-address.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { boundAddress } from './bun-address.js'

describe(boundAddress, () => {
  it('reads host and port from a URL and from a bare address', () => {
    expect(boundAddress('http://127.0.0.1:4747')).toStrictEqual({ host: '127.0.0.1', port: 4747 })
    expect(boundAddress('127.0.0.1:51234')).toStrictEqual({ host: '127.0.0.1', port: 51_234 })
    expect(boundAddress('http://[::1]:4747')).toStrictEqual({ host: '::1', port: 4747 })
  })

  it('keeps port 80, which a URL leaves out as the default of its scheme', () => {
    expect(boundAddress('http://127.0.0.1:80')).toStrictEqual({ host: '127.0.0.1', port: 80 })
  })
})
```

`packages/api/src/bun.ts`:
```ts
import { Config, kernelLogger, nowIso, PluginHost, SessionManager } from '@bytebureau/kernel'
import { kernelBunLayer, type KernelOptions } from '@bytebureau/kernel/bun'
import { BunHttpServer } from '@effect/platform-bun'
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect'
import { HttpServer } from 'effect/http'
import { boundAddress, type BoundAddress } from './bun-address.js'
import { DEFAULT_API_OPTIONS } from './config.js'
import { DefectReporter, portInUse } from './daemon-errors.js'
import { serveApi } from './layer.js'

export { PortInUseError } from './daemon-errors.js'
export type { BoundAddress } from './bun-address.js'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 4747
const MAX_BODY_BYTES = 10 * 1024 * 1024

type ServeOptions = Parameters<typeof BunHttpServer.layer>[0]
type ServerLayer = ReturnType<typeof BunHttpServer.layer>
type KernelLayer = Awaited<ReturnType<typeof kernelBunLayer>>
type DaemonRuntime = ManagedRuntime.ManagedRuntime<HttpServer.HttpServer, unknown>

// Bun's own knobs: the hostname must be passed, as Bun binds every interface otherwise; its 10 s idle timeout would cut an SSE stream
// Bun's body limit holds where Effect's does not; at 10 MiB it sits above the API's 10 MB check, which answers a declared length first
// Open streams must not delay a shutdown by the 20 s default
// A WebSocket client that stops reading is closed instead of buffered without bound, and its frames are capped like a body
const serveOptions = ({ host, port }: BoundAddress): ServeOptions => ({
  hostname: host,
  port,
  idleTimeout: 60,
  maxRequestBodySize: MAX_BODY_BYTES,
  gracefulShutdownTimeout: '2 seconds',
  websocket: {
    closeOnBackpressureLimit: true,
    backpressureLimit: 1024 * 1024,
    maxPayloadLength: MAX_BODY_BYTES,
  },
})

export interface DaemonOptions extends KernelOptions {
  readonly version: string
  // Plain text here, as the CLI that passes it imports no Effect; it is wrapped in Redacted at once
  readonly token: string
  // Flags win; what they leave out comes from the user configuration, then the defaults
  readonly host?: string | undefined
  readonly port?: number | undefined
  readonly corsOrigins?: readonly string[] | undefined
}

export interface RunningDaemon {
  readonly address: BoundAddress
  readonly startedAt: string
  // Stops the server, the agents and the store
  readonly close: () => Promise<void>
}

interface ServerSection {
  readonly host?: string | undefined
  readonly port?: number | undefined
}

// The address the start asked for, known once the configuration has been read inside the runtime: a refusal names it
interface Requested {
  host: string
  port: number
}

const logger = kernelLogger(['bb', 'api'])

const formattedAddress = HttpServer.addressFormattedWith((address) => Effect.succeed(address))

// The kernel is given what it reads, and never the token
const kernelOptionsOf = ({
  home,
  env,
  logging,
  extraPlugins,
  pluginConfig,
}: DaemonOptions): KernelOptions => ({ home, env, logging, extraPlugins, pluginConfig })

// The server section of the user configuration; one that cannot be read leaves the address to the flags and the defaults, and says so
const configuredServer = (env: KernelOptions['env']): Effect.Effect<ServerSection, never, Config> =>
  Config.use((config) => config.load({ env })).pipe(
    Effect.map((resolved): ServerSection => resolved.user.server ?? {}),
    Effect.catchTag('ConfigError', (failure) =>
      Effect.sync((): ServerSection => {
        logger.warn('the user configuration cannot be read: its server section is not applied', {
          file: failure.file,
          reason: failure.reason,
        })
        return {}
      }),
    ),
  )

// The Bun server on the address of the flags, else of the user configuration (read through the kernel's Config of this runtime), else the defaults
const resolveServer = (
  options: DaemonOptions,
  requested: Requested,
): Layer.Layer<Layer.Success<ServerLayer>, Layer.Error<ServerLayer>, Config> =>
  Layer.unwrap(
    Effect.map(configuredServer(options.env), (configured) => {
      requested.host = options.host ?? configured.host ?? DEFAULT_HOST
      requested.port = options.port ?? configured.port ?? DEFAULT_PORT
      return BunHttpServer.layer(serveOptions(requested))
    }),
  )

// The plugins load and the sessions a previous process left at work are recovered before the server is built, so no request comes first
const Boot = Layer.effectDiscard(
  Effect.gen(function* boots() {
    yield* PluginHost.use((host) => host.load())
    const recovered = yield* SessionManager.use((sessions) => sessions.recover())
    if (recovered.length > 0) {
      yield* Effect.sync(() => {
        logger.info('recovered sessions left by a previous process', { sessions: recovered })
      })
    }
  }),
)

// The API of this start; a defect behind either of its doors is logged under bb.api
const apiOf = (options: DaemonOptions, startedAt: string): ReturnType<typeof serveApi> => {
  const reporter = DefectReporter((message, properties) => {
    logger.error(message, properties)
  })
  return serveApi({
    ...DEFAULT_API_OPTIONS,
    version: options.version,
    startedAt,
    token: Redacted.make(options.token),
    corsOrigins: options.corsOrigins ?? DEFAULT_API_OPTIONS.corsOrigins,
  }).pipe(Layer.provide(reporter))
}

interface Built {
  readonly runtime: DaemonRuntime
  readonly requested: Requested
}

// The kernel, the boot, the Bun server and the API as one runtime, built in that order
const buildRuntime = (options: DaemonOptions, kernel: KernelLayer, startedAt: string): Built => {
  const requested: Requested = {
    host: options.host ?? DEFAULT_HOST,
    port: options.port ?? DEFAULT_PORT,
  }
  const server = resolveServer(options, requested).pipe(Layer.provide(Boot))
  const layer = apiOf(options, startedAt).pipe(
    Layer.provideMerge(server),
    Layer.provideMerge(kernel),
  )
  return { runtime: ManagedRuntime.make(layer), requested }
}

/**
 * Starts the kernel with the API on Bun and resolves once the daemon serves: its plugins loaded, the sessions of a previous process recovered, the address bound (port 0 becomes a free one).
 * A start that fails is disposed before the failure is passed on; a taken port fails with PortInUseError.
 */
export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const kernel = await kernelBunLayer(kernelOptionsOf(options))
  const startedAt = nowIso()
  const { runtime, requested } = buildRuntime(options, kernel, startedAt)
  try {
    const address = boundAddress(await runtime.runPromise(formattedAddress))
    return {
      address,
      startedAt,
      close: async () => {
        await runtime.dispose()
      },
    }
  } catch (error) {
    await Promise.allSettled([runtime.dispose()])
    throw portInUse(error, requested) ?? error
  }
}
```
Two more things the daemon composes (notes from Tasks 3–6): `serveApi` passes `disableListenLog: true` next to `disableLogger: true` in `HttpRouter.serve` (`packages/api/src/layer.ts`), so the daemon's stderr carries only LogTape records; and `startDaemon` provides an error reporter so that a defect behind either door (a REST handler → empty 500, an RPC handler → `Exit` with a `Die`) reaches `daemon.log` — `ErrorReporter.layer([ErrorReporter.make(({ cause, error }) => { if the cause holds a `Die`, `kernelLogger(['bb', 'api']).error('a handler failed with a defect', { error: error.message, cause: String(cause) })` })])` merged into the daemon's layer (`ErrorReporter` is exported from `effect`; read `dist/ErrorReporter.d.ts` and `dist/Cause.d.ts` for the `Die` predicate — expected problems are reported too, so the filter on defects keeps `daemon.log` quiet about ordinary refusals). A port that is taken surfaces from `Bun.serve` as a defect, not as `ServeError` (fact sheet §1.9): `portInUse(error, port)` reads the message of the cause for `EADDRINUSE` or "Is port" and returns `new Error(`port ${port} is already in use`)` for it, `undefined` otherwise, so `serve` can print one line. `configuredServer` runs over a second build of the kernel layer only if `Effect.provide(kernel)` builds it afresh — avoid that: run it inside the same runtime instead (`runtime.runPromise(configuredServer(options))`) and choose host and port before building the server layer by making the server layer depend on an effect: `Layer.unwrap(Effect.map(configuredServer(options), (configured) => BunHttpServer.layer({ hostname: options.host ?? configured.host ?? DEFAULT_HOST, port: options.port ?? configured.port ?? DEFAULT_PORT })))` provided with the kernel. Write it that way; the sketch above only names the pieces. `max-statements` (10) asks for the body of `startDaemon` to be split: `resolveServer`, `buildRuntime`, `announce`. `Effect.catch` is the kernel's import alias of Effect 4's `catch_` (see Task 2).

- [ ] **Step 2: `server.json`, the token, the exec arguments — tests first**

`apps/bytebureau/src/daemon/server-info.test.ts`:
```ts
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../testing/temp-repo.js'
import {
  isAlive,
  readServerInfo,
  removeServerInfo,
  serverInfoPath,
  writeServerInfo,
} from './server-info.js'

const info = {
  version: '0.1.0',
  host: '127.0.0.1',
  port: 4747,
  pid: process.pid,
  token: 'a'.repeat(64),
  startedAt: '2026-10-04T10:00:00.000Z',
}

// No process has this pid: the highest a system hands out is far below it
const DEAD_PID = 2_147_483_000

const modeOf = (file: string): number => statSync(file).mode % 0o1000

describe('server.json', () => {
  it('is written for the user alone and read back', () => {
    const home = tempDir('bb-home-')
    writeServerInfo(home, info)
    const written: unknown = JSON.parse(readFileSync(serverInfoPath(home), 'utf8'))
    expect(modeOf(serverInfoPath(home))).toBe(0o600)
    expect(readServerInfo(home)).toStrictEqual({ state: 'alive', info })
    expect(written).toStrictEqual(info)
  })

  it('is absent when no daemon ever ran, stale when its pid is gone, and removed on request', () => {
    const home = tempDir('bb-home-')
    expect(readServerInfo(home)).toStrictEqual({ state: 'absent' })
    writeServerInfo(home, { ...info, pid: DEAD_PID })
    expect(readServerInfo(home)).toStrictEqual({ state: 'stale', info: { ...info, pid: DEAD_PID } })
    removeServerInfo(home)
    expect(existsSync(path.join(home, 'server.json'))).toBe(false)
    removeServerInfo(home)
  })

  it('reports a file that is not a server record as stale with no info', () => {
    const home = tempDir('bb-home-')
    writeServerInfo(home, info)
    writeFileSync(serverInfoPath(home), '{"nope":1}')
    expect(readServerInfo(home)).toStrictEqual({ state: 'stale' })
    writeFileSync(serverInfoPath(home), 'not json')
    expect(readServerInfo(home)).toStrictEqual({ state: 'stale' })
  })

  it('knows a live pid from a dead one', () => {
    expect(isAlive(process.pid)).toBe(true)
    expect(isAlive(DEAD_PID)).toBe(false)
    // Signal 0 to pid 0 or -1 would reach a whole group of processes: neither is a daemon
    expect(isAlive(0)).toBe(false)
    expect(isAlive(-1)).toBe(false)
  })
})
```
Import `writeFileSync` at the top instead of the `require` line (it is only there to show intent); the lint refuses `require` and the `as`.

`apps/bytebureau/src/daemon/token.test.ts`:
```ts
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../testing/temp-repo.js'
import { freshToken, tokenFor, tokenPath } from './token.js'

const TOKEN = /^[0-9a-f]{64}$/u

const modeOf = (file: string): number => statSync(file).mode % 0o1000

describe('the daemon token', () => {
  it('is 64 hex characters and differs every time', () => {
    expect(freshToken()).toMatch(TOKEN)
    expect(freshToken()).not.toBe(freshToken())
  })

  it('is generated at the first start of a home, kept for the user alone, and the same at every later one', () => {
    const home = tempDir('bb-home-')
    const first = tokenFor(home)
    expect(first).toMatch(TOKEN)
    expect(modeOf(tokenPath(home))).toBe(0o600)
    expect(tokenFor(home)).toBe(first)
    expect(tokenFor(tempDir('bb-home-'))).not.toBe(first)
  })

  it('replaces a token file that holds no token', () => {
    const home = tempDir('bb-home-')
    writeFileSync(tokenPath(home), 'not a token\n')
    const token = tokenFor(home)
    expect(token).toMatch(TOKEN)
    expect(readFileSync(tokenPath(home), 'utf8').trim()).toBe(token)
  })
})
```

`apps/bytebureau/src/daemon/exec-args.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { daemonExecArgs } from './exec-args.js'

const BINARY = '/opt/bytebureau'
const BUN = '/usr/bin/bun'
const ENTRY = '/repo/apps/bytebureau/src/main.ts'

describe(daemonExecArgs, () => {
  it('runs the compiled binary itself with serve --no-daemonize and the flags', () => {
    expect(
      daemonExecArgs({ execPath: BINARY, argv: [BINARY, 'serve'] }, ['--port', '4747']),
    ).toStrictEqual({ command: BINARY, args: ['serve', '--no-daemonize', '--port', '4747'] })
    // As Bun 1.4.2 lays out the arguments of a compiled binary: a virtual path stands where a script would
    expect(
      daemonExecArgs({ execPath: BINARY, argv: ['bun', '/$bunfs/root/bytebureau', 'serve'] }, []),
    ).toStrictEqual({ command: BINARY, args: ['serve', '--no-daemonize'] })
  })

  it('runs the source through bun when the CLI runs from a .ts entry', () => {
    expect(daemonExecArgs({ execPath: BUN, argv: [BUN, ENTRY, 'serve'] }, [])).toStrictEqual({
      command: BUN,
      args: ['run', ENTRY, 'serve', '--no-daemonize'],
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
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { decodeServerInfo, type ServerInfo } from '@bytebureau/protocol'
import { writePrivateFile } from './private-file.js'

export const serverInfoPath = (home: string): string => path.join(home, 'server.json')

export const lockPath = (home: string): string => path.join(home, 'daemon.lock')

export type ServerRecord =
  | { readonly state: 'absent' }
  | { readonly state: 'alive'; readonly info: ServerInfo }
  // The daemon the file names is gone, or the file is no record at all
  | { readonly state: 'stale'; readonly info?: ServerInfo }

export type LockOutcome =
  | { readonly acquired: true }
  | { readonly acquired: false; readonly pid: number }

const codeOf = (error: unknown): unknown =>
  error instanceof Error && 'code' in error ? error.code : undefined

// Signal 0 tests the pid: a dead one throws ESRCH, a live one of another user EPERM; 0 and below would name a group of processes
export const isAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return codeOf(error) === 'EPERM'
  }
}

// The text of the file, or nothing when there is no file
const readIfThere = (file: string): string | undefined => {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

const removeIfThere = (file: string): void => {
  try {
    unlinkSync(file)
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') {
      throw error
    }
  }
}

const decoded = (text: string): ServerInfo | undefined => {
  try {
    const parsed: unknown = JSON.parse(text)
    return decodeServerInfo(parsed)
  } catch {
    return undefined
  }
}

export const readServerInfo = (home: string): ServerRecord => {
  const text = readIfThere(serverInfoPath(home))
  if (text === undefined) {
    return { state: 'absent' }
  }
  const info = decoded(text)
  if (info === undefined) {
    return { state: 'stale' }
  }
  return isAlive(info.pid) ? { state: 'alive', info } : { state: 'stale', info }
}

export const writeServerInfo = (home: string, info: ServerInfo): void => {
  writePrivateFile(serverInfoPath(home), `${JSON.stringify(info, undefined, 2)}\n`)
}

export const removeServerInfo = (home: string): void => {
  removeIfThere(serverInfoPath(home))
}

// The pid a lock file names, if it names one
const pidIn = (file: string): number | undefined => {
  const text = readIfThere(file)
  const pid = Number(text === undefined ? undefined : text.trim())
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

// The lock appears with the pid already in it: written aside, then linked into place, which fails when a lock is there
const tryLock = (home: string): boolean => {
  const draft = `${lockPath(home)}.${process.pid}`
  writeFileSync(draft, String(process.pid), { mode: 0o600 })
  chmodSync(draft, 0o600)
  try {
    linkSync(draft, lockPath(home))
    return true
  } catch (error) {
    if (codeOf(error) === 'EEXIST') {
      return false
    }
    throw error
  } finally {
    unlinkSync(draft)
  }
}

// False when another taker moved the lock first
const movedAside = (lock: string, aside: string): boolean => {
  try {
    renameSync(lock, aside)
    return true
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      return false
    }
    throw error
  }
}

// Back where its holder expects it, never over a lock made since
const putBack = (aside: string, lock: string): void => {
  try {
    linkSync(aside, lock)
  } catch (error) {
    if (codeOf(error) !== 'EEXIST') {
      throw error
    }
  } finally {
    unlinkSync(aside)
  }
}

/**
 * Takes a lock whose holder was seen gone out of the way, as one round of acquireLock.
 * A rename moves it, which only one taker can win, and only what was moved is judged: the lock of a holder that is gone is removed (undefined, the caller tries again); a lock a live process made since it was read is put back and names that process.
 */
export const takeOverLock = (home: string): LockOutcome | undefined => {
  const aside = `${lockPath(home)}.${process.pid}.stale`
  if (!movedAside(lockPath(home), aside)) {
    return undefined
  }
  const holder = pidIn(aside)
  if (holder === undefined || !isAlive(holder)) {
    unlinkSync(aside)
    return undefined
  }
  putBack(aside, lockPath(home))
  return { acquired: false, pid: holder }
}

// Rounds before a lock that keeps changing hands is given up on; racing takers settle within a round or two
const ROUNDS = 5

// Each round takes the lock, names its live holder, or moves the lock of a holder that is gone out of the way and goes again
const lockOf = (home: string, rounds: number): LockOutcome => {
  if (tryLock(home)) {
    return { acquired: true }
  }
  const holder = pidIn(lockPath(home))
  const refused: LockOutcome | undefined =
    holder !== undefined && isAlive(holder) ? { acquired: false, pid: holder } : takeOverLock(home)
  if (refused !== undefined) {
    return refused
  }
  if (rounds <= 1) {
    throw new Error(`the lock ${lockPath(home)} keeps changing hands; try again`)
  }
  return lockOf(home, rounds - 1)
}

// One daemon per home, decided atomically: a live holder is named, and a lock whose holder is gone, or that names none, is taken over
export const acquireLock = (home: string): LockOutcome => {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  return lockOf(home, ROUNDS)
}

// The pid the lock of the home names, if it names one
export const lockHolder = (home: string): number | undefined => pidIn(lockPath(home))

// Only the lock of this process is released: a lock another daemon has taken over is that daemon's
export const releaseLock = (home: string): void => {
  if (lockHolder(home) === process.pid) {
    removeIfThere(lockPath(home))
  }
}
```
Sort the `node:fs` import names as the lint wants (`sort-imports` is off, `import/order` may not be; follow oxfmt).

`apps/bytebureau/src/daemon/token.ts`:
```ts
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { writePrivateFile } from './private-file.js'

const TOKEN = /^[0-9a-f]{64}$/u

export const tokenPath = (home: string): string => path.join(home, 'daemon.token')

export const freshToken = (): string => randomBytes(32).toString('hex')

// The token an earlier start of the home kept, if its file holds one
const keptToken = (home: string): string | undefined => {
  try {
    const kept = readFileSync(tokenPath(home), 'utf8').trim()
    return TOKEN.test(kept) ? kept : undefined
  } catch {
    return undefined
  }
}

// Generated at the first start of the home and kept for every later one, so a client that read it keeps working across a restart
// The file outlives server.json, which carries a copy only while a daemon runs
export const tokenFor = (home: string): string => {
  const kept = keptToken(home)
  if (kept !== undefined) {
    return kept
  }
  const token = freshToken()
  writePrivateFile(tokenPath(home), `${token}\n`)
  return token
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
// A compiled binary names a virtual path where the entry would be, which is no source file
export const daemonExecArgs = (current: ProcessLike, extra: readonly string[]): ExecArgs => {
  const [, entry] = current.argv
  const fromSource = entry !== undefined && /\.[cm]?[jt]s$/u.test(entry)
  return fromSource
    ? { command: current.execPath, args: ['run', entry, 'serve', '--no-daemonize', ...extra] }
    : { command: current.execPath, args: ['serve', '--no-daemonize', ...extra] }
}
```

`apps/bytebureau/src/daemon/spawn.ts`:
```ts
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import path from 'node:path'
import { daemonExecArgs } from './exec-args.js'

export const daemonLogPath = (home: string): string => path.join(home, 'logs', 'daemon.log')

// The daemon starts in its own process group with nothing of this terminal: its output goes to the log of the home
// The child holds its own copy of the log, so this process lets go of its own at once
export const spawnDaemon = (
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  extra: readonly string[],
): number | undefined => {
  mkdirSync(path.dirname(daemonLogPath(home)), { recursive: true, mode: 0o700 })
  const log = openSync(daemonLogPath(home), 'a', 0o600)
  try {
    const { command, args } = daemonExecArgs(process, extra)
    const child = spawn(command, args, {
      detached: true,
      // Bun moves a detached child without a cwd to $HOME (Bun issue 44372): the home is as good a place as any
      cwd: home,
      stdio: ['ignore', log, log],
      env: { ...env, BYTEBUREAU_HOME: home },
      // No console window of its own on Windows; ignored elsewhere
      windowsHide: true,
    })
    child.unref()
    return child.pid
  } finally {
    closeSync(log)
  }
}
```

`apps/bytebureau/src/daemon/wait.ts`:
```ts
import { setTimeout as sleep } from 'node:timers/promises'
import { serverUrl, type ServerInfo } from '@bytebureau/protocol'
import { readServerInfo } from './server-info.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

// The daemon of the record answers its health with the start time the record names; a process that took over its pid or its port does not
export const daemonAnswers = async (info: ServerInfo): Promise<boolean> => {
  try {
    const response = await fetch(`${serverUrl(info)}/api/v1/health`, {
      signal: AbortSignal.timeout(1000),
    })
    const text = await response.text()
    const body: unknown = response.ok ? JSON.parse(text) : undefined
    return isRecord(body) && body['startedAt'] === info.startedAt
  } catch {
    return false
  }
}

// The daemon that serves the home now: server.json names a live pid and the daemon answers
export const runningDaemon = async (home: string): Promise<ServerInfo | undefined> => {
  const record = readServerInfo(home)
  return record.state === 'alive' && (await daemonAnswers(record.info)) ? record.info : undefined
}

const poll = async (home: string, deadline: number): Promise<ServerInfo | undefined> => {
  const running = await runningDaemon(home)
  if (running !== undefined || Date.now() >= deadline) {
    return running
  }
  await sleep(100)
  return poll(home, deadline)
}

// The daemon is up once server.json names it and it answers; a daemon that takes longer than the limit is given up on
export const waitForDaemon = async (
  home: string,
  timeoutMs = 10_000,
): Promise<ServerInfo | undefined> => {
  const running = await poll(home, Date.now() + timeoutMs)
  return running
}
```
Note `BYTEBUREAU_HOME` of the child is the resolved home, so a relative `BYTEBUREAU_HOME` of the parent still means the same directory. `await` inside the loop is intended (`no-await-in-loop` is an oxlint rule: disable it for that line with a comment that says why, or write the loop with a recursive helper).

`apps/bytebureau/src/daemon/stop.ts`:
```ts
import { setTimeout as sleep } from 'node:timers/promises'
import { isAlive, readServerInfo, removeServerInfo } from './server-info.js'
import { daemonAnswers } from './wait.js'

export type StopOutcome =
  | { readonly outcome: 'stopped'; readonly pid: number }
  | { readonly outcome: 'not_running' }
  | { readonly outcome: 'still_running'; readonly pid: number }

const ended = async (pid: number, deadline: number): Promise<boolean> => {
  const alive = isAlive(pid)
  if (!alive || Date.now() >= deadline) {
    return !alive
  }
  await sleep(100)
  return ended(pid, deadline)
}

// A daemon that ended since it answered has nothing left to stop
const terminate = (pid: number): void => {
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      throw error
    }
  }
}

// The record of the daemon that ended, unless a daemon started since has written its own
const forget = (home: string, pid: number): void => {
  const record = readServerInfo(home)
  if (record.state === 'stale' && (record.info === undefined || record.info.pid === pid)) {
    removeServerInfo(home)
  }
}

// SIGTERM, then the wait for the pid to end; the record goes once it has
const terminated = async (home: string, pid: number, timeoutMs: number): Promise<StopOutcome> => {
  terminate(pid)
  if (!(await ended(pid, Date.now() + timeoutMs))) {
    return { outcome: 'still_running', pid }
  }
  forget(home, pid)
  return { outcome: 'stopped', pid }
}

// SIGTERM lets the daemon end its sessions and remove its record; it goes only to a daemon that answers as its record says
// A record is removed only once its pid is gone: a live pid that does not answer is neither signalled nor forgotten
// Such a pid is a daemon shutting down or stalled, or a process that took over the pid of a stale record
export const stopDaemon = async (home: string, timeoutMs = 5000): Promise<StopOutcome> => {
  const record = readServerInfo(home)
  if (record.state !== 'alive') {
    removeServerInfo(home)
    return { outcome: 'not_running' }
  }
  const { pid } = record.info
  if (!(await daemonAnswers(record.info))) {
    return { outcome: 'still_running', pid }
  }
  const outcome = await terminated(home, pid, timeoutMs)
  return outcome
}
```

`apps/bytebureau/src/daemon/foreground.ts`:
```ts
import { PortInUseError, startDaemon, type RunningDaemon } from '@bytebureau/api/bun'
import type { Context } from '../context.js'
import { version } from '../version.js'
import { publish } from './publish.js'
import { acquireLock, releaseLock, removeServerInfo } from './server-info.js'
import { tokenFor } from './token.js'

export interface ForegroundOptions {
  readonly home: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly host?: string | undefined
  readonly port?: number | undefined
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

// Resolves at the first of the signals; the next one does what it did before (it ends the process), so a stuck shutdown can be cut short
async function signalled(): Promise<NodeJS.Signals> {
  const { promise, resolve } = Promise.withResolvers<NodeJS.Signals>()
  const settle = (signal: NodeJS.Signals): void => {
    for (const name of SIGNALS) {
      process.off(name, settle)
    }
    resolve(signal)
  }
  for (const name of SIGNALS) {
    process.on(name, settle)
  }
  const signal = await promise
  return signal
}

// The daemon of this process, or nothing when its port is taken, which is said in one line
async function started(
  options: ForegroundOptions,
  token: string,
  context: Context,
): Promise<RunningDaemon | undefined> {
  try {
    return await startDaemon({ ...options, version, token, logging: context.logging })
  } catch (error) {
    if (!(error instanceof PortInUseError)) {
      throw error
    }
    context.output.warn(error.message)
    return undefined
  }
}

async function closed(daemon: RunningDaemon, home: string): Promise<void> {
  try {
    await daemon.close()
  } finally {
    removeServerInfo(home)
  }
}

// The record exists from the moment the server is bound to the moment it is gone
// The signals are listened for before it exists, so the first one always ends the daemon cleanly, one during the start included
async function serveLocked(options: ForegroundOptions, context: Context): Promise<number> {
  const stopped = signalled()
  const token = tokenFor(options.home)
  const daemon = await started(options, token, context)
  if (daemon === undefined) {
    return 1
  }
  try {
    publish(options.home, { daemon, token }, context)
    await stopped
  } finally {
    await closed(daemon, options.home)
  }
  return 0
}

// Runs until SIGINT, SIGTERM or SIGHUP; one daemon per home, which the lock decides atomically, naming the pid of the one that holds it
export async function serveForeground(
  options: ForegroundOptions,
  context: Context,
): Promise<number> {
  const lock = acquireLock(options.home)
  if (!lock.acquired) {
    context.output.warn(`a daemon is already running (pid ${lock.pid})`)
    return 1
  }
  try {
    return await serveLocked(options, context)
  } finally {
    releaseLock(options.home)
  }
}
```
The lock is released on every way out (a failed `startDaemon` included — wrap the start in `try/finally` around `releaseLock`), and the detached start of `serve` waits for `server.json`, which the daemon writes only once it holds the lock and is bound.
`startDaemon` takes the token as a plain string and wraps it in `Redacted` itself, because the CLI imports no Effect (ADR-0003) — so the call reads `startDaemon({ ...options, version, token, logging: context.logging })`. `announce` prints `listening on <url>` through `context.output.print` (or emits `{ command: 'serve', url, pid, version }` with `--json`) and warns `the daemon listens on <host>: anyone on the network who has the token can use it` when `!isLoopback(host)`. `signalled()` resolves on the first of `SIGNALS` (`process.once` for each). Split the function as `max-statements` asks.

- [ ] **Step 5: The `serve` command and the test helper**

`apps/bytebureau/src/commands/serve.ts`:
```ts
import { m } from '@bytebureau/i18n'
import { defineCommand } from 'citty'
import { globalArgs, processContext, type Context } from '../context.js'
import { alreadyRunning, announce } from '../daemon/announce.js'
import { daemonLogPath, spawnDaemon } from '../daemon/spawn.js'
import { stopDaemon } from '../daemon/stop.js'
import { runningDaemon, waitForDaemon } from '../daemon/wait.js'
import { kernelHome } from '../kernel-home.js'

interface ServeFlags {
  readonly host?: string | undefined
  readonly port?: string | undefined
  readonly 'log-level'?: string | undefined
  readonly debug?: string | undefined
}

const usageError = (message: string): Error =>
  Object.assign(new Error(message), { name: 'CLIError' })

// A port is a whole number up to 65535; 0 asks for a free one
const portOf = (text: string | undefined): number | undefined => {
  if (text === undefined) {
    return undefined
  }
  const port = Number(text)
  if (!/^\d+$/u.test(text) || port > 65_535) {
    throw usageError(`--port takes a whole number from 0 to 65535, not ${text}`)
  }
  return port
}

// What the detached daemon is started with: the address and the logging of this command
const flagsOf = (flags: ServeFlags): string[] => [
  ...(flags.host === undefined ? [] : ['--host', flags.host]),
  ...(flags.port === undefined ? [] : ['--port', flags.port]),
  ...(flags['log-level'] === undefined ? [] : ['--log-level', flags['log-level']]),
  // A bare --debug arrives here as an empty value, which only the = form passes on as it is
  ...(flags.debug === undefined ? [] : [`--debug=${flags.debug}`]),
]

// A daemon that is not running is what was asked for; one that outlives the wait is a failure
async function stop(home: string, context: Context): Promise<number> {
  const result = await stopDaemon(home)
  context.output.emit({ command: 'serve.stop', ...result })
  if (result.outcome === 'still_running') {
    context.output.warn(m.serve_still_running({ pid: result.pid }))
    return 1
  }
  context.output.print(
    result.outcome === 'stopped' ? m.serve_stopped({ pid: result.pid }) : m.serve_not_running(),
  )
  return 0
}

async function startDetached(home: string, flags: ServeFlags, context: Context): Promise<number> {
  spawnDaemon(home, process.env, flagsOf(flags))
  const info = await waitForDaemon(home)
  if (info === undefined) {
    context.output.warn(m.serve_timeout({ log: daemonLogPath(home) }))
    return 1
  }
  // The record names the host clients use; a wildcard bind is known here by the flag alone
  announce(info, context, flags.host ?? info.host)
  return 0
}

// A daemon already serving the home is what was asked for; otherwise one is started detached and waited for
async function detach(home: string, flags: ServeFlags, context: Context): Promise<number> {
  const running = await runningDaemon(home)
  if (running !== undefined) {
    alreadyRunning(running, context)
    return 0
  }
  const code = await startDetached(home, flags, context)
  return code
}

interface ServeArgs extends ServeFlags {
  readonly daemonize: boolean
}

// Detached unless --no-daemonize; only the daemon itself loads the API and its server, so every other command stays clear of them
async function serve(home: string, args: ServeArgs, context: Context): Promise<number> {
  const port = portOf(args.port)
  if (args.daemonize) {
    const code = await detach(home, args, context)
    return code
  }
  const { serveForeground } = await import('../daemon/foreground.js')
  const code = await serveForeground({ home, env: process.env, host: args.host, port }, context)
  return code
}

export const serveCommand = defineCommand({
  meta: {
    name: 'serve',
    description: 'Start the ByteBureau daemon (detached unless --no-daemonize)',
  },
  args: {
    ...globalArgs,
    host: {
      type: 'string',
      description: 'Address to listen on (default: 127.0.0.1 or server.host)',
    },
    port: {
      type: 'string',
      description: 'Port to listen on (default: 4747 or server.port; 0 picks a free one)',
    },
    daemonize: {
      type: 'boolean',
      description: 'Detach; pass --no-daemonize to stay in the foreground',
      default: true,
    },
    stop: { type: 'boolean', description: 'Stop the running daemon of this home', default: false },
  },
  async run({ args }) {
    const context = processContext(args)
    const home = kernelHome(process.env)
    process.exitCode = args.stop ? await stop(home, context) : await serve(home, args, context)
  },
})
```
with the two helpers in the same file: `stop` prints `m.serve_stopped({ pid })` / `m.serve_not_running()` / warns `m.serve_still_running({ pid })` (exit 1); `detach` refuses when `readServerInfo(home).state === 'alive'` (prints `m.serve_already_running({ pid, url })`, exit 0 — a running daemon is what was asked for), else `spawnDaemon(home, process.env, flagsOf(args))` with `--host`/`--port`/`--log-level`/`--debug` carried over, then `waitForDaemon(home)`; success prints `m.serve_started({ url })` (or emits `{ command: 'serve', url, pid, version }`), a timeout warns `m.serve_timeout({ log: daemonLogPath(home) })` and exits 1. Register `serve: serveCommand` in `main.ts`.

New messages (`en.json` / `cs.json`): `serve_started` = "Daemon listening on {url}" / "Démon naslouchá na {url}", `serve_already_running` = "Daemon already running on {url} (pid {pid})" / "Démon už běží na {url} (pid {pid})", `serve_stopped` = "Stopped daemon (pid {pid})" / "Démon zastaven (pid {pid})", `serve_not_running` = "No daemon is running" / "Žádný démon neběží", `serve_still_running` = "Daemon (pid {pid}) did not stop in time" / "Démon (pid {pid}) se včas nezastavil", `serve_timeout` = "The daemon did not come up in time; see {log}" / "Démon se včas nespustil; viz {log}", `serve_lan_warning` = "Listening on {host}: anyone on the network with the token can use this daemon" / "Naslouchá na {host}: kdokoli v síti s tokenem může tohoto démona používat".

`apps/bytebureau/src/testing/daemon.ts`:
```ts
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { serverUrl, type ServerInfo } from '@bytebureau/protocol'
import { onTestFinished } from 'vitest'
import { isAlive, lockHolder, readServerInfo } from '../daemon/server-info.js'
import { stopDaemon } from '../daemon/stop.js'
import { childEnv } from './run-cli.js'

const CLI_DIRECTORY = fileURLToPath(new URL('../..', import.meta.url))

export interface DaemonProcess {
  readonly info: ServerInfo
  readonly url: string
  readonly child: ChildProcess
  readonly stdout: () => string
  readonly stderr: () => string
  // SIGTERM, then the exit code of the daemon
  readonly stop: () => Promise<number | null>
}

interface Output {
  stdout: string
  stderr: string
}

const captured = (child: ChildProcess): Output => {
  const output: Output = { stdout: '', stderr: '' }
  if (child.stdout !== null) {
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output.stdout += chunk
    })
  }
  if (child.stderr !== null) {
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output.stderr += chunk
    })
  }
  return output
}

// The record the daemon of the child writes once it serves; nothing when the child ended first or took too long
const recordOf = async (
  home: string,
  child: ChildProcess,
  deadline: number,
): Promise<ServerInfo | undefined> => {
  const record = readServerInfo(home)
  if (record.state === 'alive' && record.info.pid === child.pid) {
    return record.info
  }
  if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
    return undefined
  }
  await sleep(100)
  return recordOf(home, child, deadline)
}

// A foreground daemon of the home, run from source; killed when the test ends if it is still there
// The flags follow serve --no-daemonize: --port 0 unless the test names its own, as a daemon that reads its port from the home does
export async function startDaemonProcess(
  home: string,
  flags: readonly string[] = ['--port', '0'],
): Promise<DaemonProcess> {
  const child = spawn('bun', ['run', 'src/main.ts', 'serve', '--no-daemonize', ...flags], {
    cwd: CLI_DIRECTORY,
    env: childEnv({ BYTEBUREAU_HOME: home }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  onTestFinished(() => {
    child.kill('SIGKILL')
  })
  const output = captured(child)
  const { promise: exited, resolve } = Promise.withResolvers<number | null>()
  child.once('close', (code) => {
    resolve(code)
  })
  const info = await recordOf(home, child, Date.now() + 15_000)
  if (info === undefined) {
    throw new Error(`the daemon did not write server.json in time: ${output.stderr}`)
  }
  const stop = async (): Promise<number | null> => {
    child.kill('SIGTERM')
    const code = await exited
    return code
  }
  return {
    info,
    url: serverUrl(info),
    child,
    stdout: () => output.stdout,
    stderr: () => output.stderr,
    stop,
  }
}

const ended = async (pid: number, deadline: number): Promise<boolean> => {
  const alive = isAlive(pid)
  if (!alive || Date.now() >= deadline) {
    return !alive
  }
  await sleep(100)
  return ended(pid, deadline)
}

// A pid that ended meanwhile has nothing left to signal
const signal = (pid: number, name: NodeJS.Signals): void => {
  try {
    process.kill(pid, name)
  } catch {
    // Gone already
  }
}

// The daemon of the home ends with the test: as --stop ends it, else through the pid of its lock, which a daemon holds from its start on
// One that does not end within the wait is killed; both waits together stay within the 10 s a test hook is given
export async function stopDaemonOf(home: string): Promise<void> {
  await stopDaemon(home, 4000)
  const holder = lockHolder(home)
  if (holder === undefined || !isAlive(holder)) {
    return
  }
  signal(holder, 'SIGTERM')
  if (!(await ended(holder, Date.now() + 4000))) {
    signal(holder, 'SIGKILL')
  }
}
```

`apps/bytebureau/src/commands/serve.test.ts`:
```ts
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { serverUrl } from '@bytebureau/protocol'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { readServerInfo, serverInfoPath } from '../daemon/server-info.js'
import { daemonLogPath } from '../daemon/spawn.js'
import { startDaemonProcess, stopDaemonOf } from '../testing/daemon.js'
import { jsonLines } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import { tempDir, testHome } from '../testing/temp-repo.js'

const modeOf = (file: string): number => statSync(file).mode % 0o1000

const bearer = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } })

// What a start that cannot bind says: Bun cannot tell a taken port from an address this machine does not have
const cannotListen = (port: string): string =>
  `cannot listen on 127.0.0.1:${port}: the port is taken or the address is not this machine's`

// What --json prints for the daemon of the home: where it listens, its pid and its version, never its token
const describedDaemon = (home: string): Record<string, unknown> => {
  const record = readServerInfo(home)
  return record.state === 'alive'
    ? {
        command: 'serve',
        url: serverUrl(record.info),
        pid: record.info.pid,
        version: record.info.version,
      }
    : { state: record.state }
}

// A detached daemon of the home ends with the test, should an assertion fail before the test stops it
const stoppedWithTheTest = (home: string): Record<string, string> => {
  onTestFinished(async () => {
    await stopDaemonOf(home)
  })
  return { BYTEBUREAU_HOME: home }
}

describe('bytebureau serve --no-daemonize', () => {
  it('writes server.json for the user alone, on the loopback, and removes it on SIGTERM', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const daemon = await startDaemonProcess(home)
    expect(modeOf(serverInfoPath(home))).toBe(0o600)
    expect(daemon.info.token).toMatch(/^[0-9a-f]{64}$/u)
    expect(daemon.info.host).toBe('127.0.0.1')
    // The line follows the record, so it may still be on its way through the pipe
    await vi.waitFor(() => {
      expect(daemon.stdout()).toBe(`Daemon listening on ${daemon.url}\n`)
    })
    expect([await daemon.stop(), existsSync(serverInfoPath(home))]).toStrictEqual([0, false])
  })

  it('answers health to anyone and the rest of the API only with the token', async () => {
    expect.hasAssertions()
    const daemon = await startDaemonProcess(tempDir('bb-home-'))
    const health = await fetch(`${daemon.url}/api/v1/health`)
    // The plugins have loaded before the server answers anything
    await expect(health.json()).resolves.toMatchObject({
      status: 'ok',
      startedAt: daemon.info.startedAt,
      checks: { plugins: { loaded: 2, failed: 0 } },
    })
    const denied = await fetch(`${daemon.url}/api/v1/projects`)
    const allowed = await fetch(`${daemon.url}/api/v1/projects`, bearer(daemon.info.token))
    expect([health.status, denied.status, allowed.status]).toStrictEqual([200, 401, 200])
    await expect(allowed.json()).resolves.toStrictEqual([])
    await expect(daemon.stop()).resolves.toBe(0)
  })

  it('keeps the token across a restart', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const first = await startDaemonProcess(home)
    await expect(first.stop()).resolves.toBe(0)
    const second = await startDaemonProcess(home)
    expect(second.info.token).toBe(first.info.token)
    await expect(second.stop()).resolves.toBe(0)
  })
})

describe('bytebureau serve --no-daemonize refusals', () => {
  it('refuses a second daemon on the same home with exit 1 and the pid of the first', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const daemon = await startDaemonProcess(home)
    const second = await runCli(['serve', '--no-daemonize', '--port', '0'], {
      BYTEBUREAU_HOME: home,
    })
    const refusal = `a daemon is already running (pid ${daemon.info.pid})`
    expect([second.code, second.stderr.trim()]).toStrictEqual([1, refusal])
    await expect(daemon.stop()).resolves.toBe(0)
  })

  it('refuses a port that is taken with exit 1 and one line', async () => {
    expect.hasAssertions()
    const daemon = await startDaemonProcess(tempDir('bb-home-'))
    const port = String(daemon.info.port)
    const other = await runCli(['serve', '--no-daemonize', '--port', port], {
      BYTEBUREAU_HOME: tempDir('bb-home-'),
    })
    expect([other.code, other.stderr.trim()]).toStrictEqual([1, cannotListen(port)])
    await expect(daemon.stop()).resolves.toBe(0)
  })

  it('refuses a port that is no port as a usage error', async () => {
    expect.hasAssertions()
    const refused = await runCli(['serve', '--port', '80a'])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('--port takes a whole number from 0 to 65535, not 80a')
  })
})

describe('bytebureau serve (detached) and serve --stop', () => {
  it('starts the daemon detached on the loopback and reports its url, pid and version as JSON', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const started = await runCli(['serve', '--port', '0', '--json'], stoppedWithTheTest(home))
    expect(started.code).toBe(0)
    expect(jsonLines(started.stdout)).toStrictEqual([describedDaemon(home)])
    expect(readServerInfo(home)).toMatchObject({ state: 'alive', info: { host: '127.0.0.1' } })
  })

  it('names the daemon that serves the home already instead of starting another', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const env = stoppedWithTheTest(home)
    await expect(runCli(['serve', '--port', '0'], env)).resolves.toMatchObject({ code: 0 })
    const { url, pid } = describedDaemon(home)
    const again = await runCli(['serve', '--port', '0'], env)
    const named = `Daemon already running on ${String(url)} (pid ${String(pid)})\n`
    expect([again.code, again.stdout]).toStrictEqual([0, named])
  })

  it('ends the daemon with --stop, and then finds none to stop', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const env = stoppedWithTheTest(home)
    await expect(runCli(['serve', '--port', '0'], env)).resolves.toMatchObject({ code: 0 })
    const { pid } = describedDaemon(home)
    const stopped = await runCli(['serve', '--stop'], env)
    const said = `Stopped daemon (pid ${String(pid)})\n`
    expect([stopped.code, stopped.stdout, readServerInfo(home).state]).toStrictEqual([
      0,
      said,
      'absent',
    ])
    const none = await runCli(['serve', '--stop'], env)
    expect([none.code, none.stdout]).toStrictEqual([0, 'No daemon is running\n'])
  })
})

describe('bytebureau serve (detached) that cannot start', () => {
  it('gives up on a daemon that does not come up, naming the log that says why', async () => {
    expect.hasAssertions()
    const daemon = await startDaemonProcess(tempDir('bb-home-'))
    const home = tempDir('bb-home-')
    const port = String(daemon.info.port)
    const started = await runCli(['serve', '--port', port], stoppedWithTheTest(home))
    const gaveUp = `The daemon did not come up in time; see ${daemonLogPath(home)}`
    expect([started.code, started.stderr.trim()]).toStrictEqual([1, gaveUp])
    expect(readFileSync(daemonLogPath(home), 'utf8')).toContain(cannotListen(port))
    await expect(daemon.stop()).resolves.toBe(0)
  })
})

describe('bytebureau serve and the user configuration', () => {
  it('listens on the port the configuration of the home names when no flag names one', async () => {
    expect.hasAssertions()
    // The configuration of a test home says port 0: a free port, never the default 4747
    const daemon = await startDaemonProcess(testHome(), [])
    expect(daemon.info.port).not.toBe(4747)
    expect(daemon.info.port).toBeGreaterThan(0)
    const health = await fetch(`${daemon.url}/api/v1/health`)
    expect(health.status).toBe(200)
    await expect(daemon.stop()).resolves.toBe(0)
  })

  it('starts on the flags and says so when the configuration of the home cannot be read', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    writeFileSync(path.join(home, 'config.json'), '{ "server": { "port": "not a port" } }\n')
    const daemon = await startDaemonProcess(home)
    await vi.waitFor(() => {
      expect(daemon.stderr()).toContain(
        'the user configuration cannot be read: its server section is not applied',
      )
    })
    await expect(daemon.stop()).resolves.toBe(0)
  })
})
```
The detached daemon of the last test is stopped by `--stop`; should an assertion fail before that line, the test's `tempDir` home still names it in `server.json` — add `onTestFinished(() => { stopDaemon(home) })` at the top of that test so no daemon outlives the test run.

`packages/api/src/daemon-errors.ts` (added during execution):
```ts
import { Cause, ErrorReporter, type Layer } from 'effect'
import type { BoundAddress } from './bun-address.js'

export class PortInUseError extends Error {
  public override readonly name = 'PortInUseError'
}

const hostPort = ({ host, port }: BoundAddress): string =>
  host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`

// Bun.serve throws when it cannot bind, so the start fails with that defect rather than a ServeError: one line for the CLI to print
// Bun says EADDRINUSE for an address this machine does not have as well, so the line keeps both readings
export const portInUse = (error: unknown, address: BoundAddress): PortInUseError | undefined =>
  error instanceof Error &&
  (Reflect.get(error, 'code') === 'EADDRINUSE' || error.message.includes('Is port'))
    ? new PortInUseError(
        `cannot listen on ${hostPort(address)}: the port is taken or the address is not this machine's`,
        { cause: error },
      )
    : undefined

export type DefectLog = (message: string, properties: Readonly<Record<string, unknown>>) => void

// Every failure behind either door is reported, the problems the API answers on purpose too, so only a cause with a defect is logged
// Such a defect is otherwise silent: a REST handler answers an empty 500, an RPC procedure an Exit with a Die
export const DefectReporter = (log: DefectLog): Layer.Layer<never> =>
  ErrorReporter.layer([
    ErrorReporter.make(({ cause, error }) => {
      if (Cause.hasDies(cause)) {
        log('a handler failed with a defect', { error: error.message, cause: Cause.pretty(cause) })
      }
    }),
  ])
```
`packages/api/src/daemon-errors.test.ts` (added during execution):
```ts
import { createServer } from 'node:http'
import { WorkspaceManager } from '@bytebureau/kernel'
import { NodeHttpServer } from '@effect/platform-node'
import { assert, describe, expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { DefectReporter, PortInUseError, portInUse } from './daemon-errors.js'
import { serveApi } from './layer.js'
import { BootedKernel } from './testing-kernel.js'
import { get, post, TEST_TOKEN, testOptions } from './testing.js'
import { called, connected } from './testing-ws.js'

interface Logged {
  readonly message: string
  readonly error: string
  readonly cause: string
}

// What the reporter of the suite logged; each test takes what its own calls added
const logged: Logged[] = []

const DEFECT = { message: 'a handler failed with a defect', error: 'the prune broke' }

// Bun gives EADDRINUSE for a taken port and for an address this machine does not have alike
const EITHER = "the port is taken or the address is not this machine's"

const LOOPBACK = { host: '127.0.0.1', port: 4747 }

const messagesOf = (entries: readonly Logged[]): readonly object[] =>
  entries.map(({ message, error }) => ({ message, error }))

// The kernel of the tests with a prune that dies, as a bug behind a handler would
const DyingPrune = Layer.effect(
  WorkspaceManager,
  WorkspaceManager.use((workspaces) =>
    Effect.succeed({ ...workspaces, prune: () => Effect.die(new Error('the prune broke')) }),
  ),
)

const ReportingLayer = serveApi(testOptions()).pipe(
  Layer.provide(
    DefectReporter((message, properties) => {
      logged.push({
        message,
        error: String(properties['error']),
        cause: String(properties['cause']),
      })
    }),
  ),
  Layer.provide(DyingPrune),
  Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port: 0, host: '127.0.0.1' })),
  Layer.provideMerge(BootedKernel),
)

describe(portInUse, () => {
  it('names the address of a start that Bun refused, and lets any other failure through', () => {
    const taken = Object.assign(new Error('Failed to start server. Is port 4747 in use?'), {
      code: 'EADDRINUSE',
    })
    const refused = portInUse(taken, { host: '127.0.0.1', port: 4747 })
    expect(refused).toBeInstanceOf(PortInUseError)
    expect(refused).toMatchObject({
      message: `cannot listen on 127.0.0.1:4747: ${EITHER}`,
      cause: taken,
    })
    expect(portInUse(taken, { host: '::1', port: 4747 })).toMatchObject({
      message: `cannot listen on [::1]:4747: ${EITHER}`,
    })
    expect(portInUse(new Error('the store is locked'), LOOPBACK)).toBeUndefined()
    expect(portInUse('EADDRINUSE', LOOPBACK)).toBeUndefined()
  })

  it('reads the code alone too, which Bun also gives for an address this machine does not have', () => {
    const coded = Object.assign(new Error('bind'), { code: 'EADDRINUSE' })
    expect(portInUse(coded, { host: '192.0.2.1', port: 1 })).toMatchObject({
      message: `cannot listen on 192.0.2.1:1: ${EITHER}`,
    })
  })
})

it.layer(ReportingLayer)('the defect reporter of the daemon', (suite) => {
  suite.effect('logs nothing for a refusal the API answers on purpose', () =>
    Effect.gen(function* refuses() {
      const missing = yield* get('/sessions/0192f0a0-0000-7000-8000-000000000009')
      assert.strictEqual(missing.status, 404)
      assert.deepStrictEqual(logged.splice(0), [])
    }),
  )

  suite.effect('logs a defect behind a REST handler, which answers an empty 500', () =>
    Effect.gen(function* failsOverRest() {
      const pruned = yield* post('/workspaces/prune', {})
      assert.strictEqual(pruned.status, 500)
      const entries = logged.splice(0)
      assert.deepStrictEqual(messagesOf(entries), [DEFECT])
      assert.match(entries.map(({ cause }) => cause).join('\n'), /Error: the prune broke/u)
    }),
  )

  suite.effect('logs a defect behind an RPC procedure, which ends with a Die', () =>
    Effect.gen(function* failsOverRpc() {
      const client = yield* connected()
      const prune = { id: 'prune', tag: 'workspaces.prune', payload: {}, token: TEST_TOKEN }
      assert.containSubset(yield* called(client, prune), {
        _tag: 'Exit',
        exit: { _tag: 'Failure', cause: [{ _tag: 'Die' }] },
      })
      assert.deepStrictEqual(messagesOf(logged.splice(0)), [DEFECT])
    }),
  )
})
```
`apps/bytebureau/src/daemon/private-file.ts` (added during execution):
```ts
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'

// Written beside its final name, flushed and renamed into place, so a reader never sees half of it; for the user alone, whatever the umask
export const writePrivateFile = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.tmp`
  const fd = openSync(temp, 'w', 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  chmodSync(temp, 0o600)
  renameSync(temp, file)
}
```
`apps/bytebureau/src/daemon/hosts.ts` (added during execution):
```ts
// The loopback names, and every address of 127.0.0.0/8
export const isLoopback = (host: string): boolean =>
  host === 'localhost' || host === '::1' || host.startsWith('127.')

const WILDCARDS: Readonly<Record<string, string>> = { '0.0.0.0': '127.0.0.1', '::': '::1' }

// The host clients use for a daemon bound to it: one bound to every interface is reached through the loopback of its family
// A wildcard address is no destination everywhere: Windows refuses to connect to it
export const clientHost = (bound: string): string => WILDCARDS[bound] ?? bound
```
`apps/bytebureau/src/daemon/hosts.test.ts` (added during execution):
```ts
import { describe, expect, it } from 'vitest'
import { clientHost, isLoopback } from './hosts.js'

describe(isLoopback, () => {
  it('tells the loopback names and addresses from those the network reaches', () => {
    const loopback = ['127.0.0.1', '127.0.0.2', 'localhost', '::1']
    const network = ['0.0.0.0', '::', '192.168.1.5', '10.0.0.5', 'example.com']
    expect(loopback.filter((host) => !isLoopback(host))).toStrictEqual([])
    expect(network.filter((host) => isLoopback(host))).toStrictEqual([])
  })
})

describe(clientHost, () => {
  it('records the loopback of the same family for a daemon bound to every interface', () => {
    expect(clientHost('0.0.0.0')).toBe('127.0.0.1')
    expect(clientHost('::')).toBe('::1')
  })

  it('records any other address as it was bound', () => {
    const bound = ['127.0.0.1', '::1', '192.168.1.5', 'fe80::1']
    expect(bound.map((host) => clientHost(host))).toStrictEqual(bound)
  })
})
```
`apps/bytebureau/src/daemon/publish.ts` (added during execution):
```ts
import type { RunningDaemon } from '@bytebureau/api/bun'
import type { ServerInfo } from '@bytebureau/protocol'
import type { Context } from '../context.js'
import { version } from '../version.js'
import { announce } from './announce.js'
import { clientHost } from './hosts.js'
import { writeServerInfo } from './server-info.js'

export interface Published {
  readonly daemon: RunningDaemon
  readonly token: string
}

// What server.json says of the daemon of this process: the host clients use, which for a wildcard bind is the loopback
const recordOf = ({ daemon, token }: Published): ServerInfo => ({
  version,
  host: clientHost(daemon.address.host),
  port: daemon.address.port,
  pid: process.pid,
  token,
  startedAt: daemon.startedAt,
})

// From here on clients find the daemon; the warning for a daemon the network can reach names the address it is bound to
export const publish = (home: string, published: Published, context: Context): void => {
  const info = recordOf(published)
  writeServerInfo(home, info)
  announce(info, context, published.daemon.address.host)
}
```
`apps/bytebureau/src/daemon/publish.test.ts` (added during execution):
```ts
import type { RunningDaemon } from '@bytebureau/api/bun'
import { describe, expect, it, vi } from 'vitest'
import { createContext } from '../context.js'
import { tempDir } from '../testing/temp-repo.js'
import { publish } from './publish.js'
import { readServerInfo } from './server-info.js'

const TOKEN = 'b'.repeat(64)

const daemonOn = (host: string): RunningDaemon => ({
  address: { host, port: 4747 },
  startedAt: '2026-10-04T10:00:00.000Z',
  close: async () => {
    // Nothing runs behind this stand-in
  },
})

describe(publish, () => {
  it('records the loopback for a daemon bound to every interface, and warns with the address it is bound to', () => {
    vi.spyOn(console, 'log').mockReturnValue()
    const error = vi.spyOn(console, 'error').mockReturnValue()
    const home = tempDir('bb-home-')
    publish(
      home,
      { daemon: daemonOn('0.0.0.0'), token: TOKEN },
      createContext({ json: false, color: false, yes: false }, {}, false),
    )
    expect(readServerInfo(home)).toMatchObject({
      state: 'alive',
      info: { host: '127.0.0.1', port: 4747, pid: process.pid, token: TOKEN },
    })
    expect(error.mock.calls).toStrictEqual([
      ['Listening on 0.0.0.0: anyone on the network with the token can use this daemon'],
    ])
  })

  it('records a daemon bound to the loopback as it is bound, without a warning', () => {
    const log = vi.spyOn(console, 'log').mockReturnValue()
    const error = vi.spyOn(console, 'error').mockReturnValue()
    const home = tempDir('bb-home-')
    publish(
      home,
      { daemon: daemonOn('::1'), token: TOKEN },
      createContext({ json: false, color: false, yes: false }, {}, false),
    )
    expect(readServerInfo(home)).toMatchObject({ state: 'alive', info: { host: '::1' } })
    expect([log.mock.calls, error.mock.calls]).toStrictEqual([
      [['Daemon listening on http://[::1]:4747']],
      [],
    ])
  })
})
```
`apps/bytebureau/src/daemon/announce.ts` (added during execution):
```ts
import { m } from '@bytebureau/i18n'
import { serverUrl, type ServerInfo } from '@bytebureau/protocol'
import type { Context } from '../context.js'
import { isLoopback } from './hosts.js'

// The daemon as --json describes it, where it listens, its pid and its version but never its token; the url for the text
const emitted = (info: ServerInfo, context: Context): string => {
  const url = serverUrl(info)
  context.output.emit({ command: 'serve', url, pid: info.pid, version: info.version })
  return url
}

// Where the daemon listens; one the network can reach is announced with the warning of spec §11.1, naming the address it is bound to
// That address is the recorded host unless the daemon is bound to every interface, which clients reach through the loopback
export const announce = (info: ServerInfo, context: Context, bound: string = info.host): void => {
  context.output.print(m.serve_started({ url: emitted(info, context) }))
  if (!isLoopback(bound)) {
    context.output.warn(m.serve_lan_warning({ host: bound }))
  }
}

// A daemon already serving the home is what was asked for
export const alreadyRunning = (info: ServerInfo, context: Context): void => {
  context.output.print(m.serve_already_running({ url: emitted(info, context), pid: info.pid }))
}
```
`apps/bytebureau/src/daemon/announce.test.ts` (added during execution):
```ts
import { describe, expect, it, vi } from 'vitest'
import { createContext, type GlobalArgs } from '../context.js'
import { recordOn } from '../testing/health-stub.js'
import { alreadyRunning, announce } from './announce.js'

const TEXT: GlobalArgs = { json: false, color: false, yes: false }

describe(announce, () => {
  it('prints where the daemon listens, and warns when the network can reach it', () => {
    const log = vi.spyOn(console, 'log').mockReturnValue()
    const error = vi.spyOn(console, 'error').mockReturnValue()
    const context = createContext(TEXT, {}, false)
    announce(recordOn(4747), context)
    announce({ ...recordOn(4747), host: '192.168.1.5' }, context)
    // Bound to every interface, the daemon is recorded with the loopback clients use
    announce(recordOn(4747), context, '0.0.0.0')
    expect(log.mock.calls).toStrictEqual([
      ['Daemon listening on http://127.0.0.1:4747'],
      ['Daemon listening on http://192.168.1.5:4747'],
      ['Daemon listening on http://127.0.0.1:4747'],
    ])
    expect(error.mock.calls).toStrictEqual([
      ['Listening on 192.168.1.5: anyone on the network with the token can use this daemon'],
      ['Listening on 0.0.0.0: anyone on the network with the token can use this daemon'],
    ])
  })

  it('emits the url, the pid and the version as JSON, never the token', () => {
    const log = vi.spyOn(console, 'log').mockReturnValue()
    const context = createContext({ ...TEXT, json: true }, {}, false)
    announce(recordOn(4747, 42), context)
    alreadyRunning(recordOn(4747, 42), context)
    const record = {
      command: 'serve',
      url: 'http://127.0.0.1:4747',
      pid: 42,
      version: '0.0.0-test',
    }
    expect(log.mock.calls).toStrictEqual([[JSON.stringify(record)], [JSON.stringify(record)]])
  })
})

describe(alreadyRunning, () => {
  it('names the daemon that serves the home already', () => {
    const log = vi.spyOn(console, 'log').mockReturnValue()
    alreadyRunning(recordOn(4747, 42), createContext(TEXT, {}, false))
    expect(log.mock.calls).toStrictEqual([
      ['Daemon already running on http://127.0.0.1:4747 (pid 42)'],
    ])
  })
})
```
`apps/bytebureau/src/daemon/server-info-lock.test.ts` (added during execution):
```ts
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { tempDir } from '../testing/temp-repo.js'
import { acquireLock, lockPath, releaseLock, takeOverLock } from './server-info.js'

// No process has this pid: the highest a system hands out is far below it
const DEAD_PID = 2_147_483_000

const SERVER_INFO = fileURLToPath(new URL('server-info.ts', import.meta.url))

const modeOf = (file: string): number => statSync(file).mode % 0o1000

interface Taker {
  readonly pid: number
  readonly outcome: unknown
}

// A process that reaches for the lock of the home at the moment given, prints what it got and stays alive, so a lock it took stays live
async function taker(home: string, at: number): Promise<Taker> {
  const script = [
    `import { acquireLock } from ${JSON.stringify(SERVER_INFO)}`,
    `await Bun.sleep(Math.max(0, ${at} - 20 - Date.now()))`,
    `while (Date.now() < ${at}) {}`,
    `console.log(JSON.stringify(acquireLock(${JSON.stringify(home)})))`,
    'setInterval(() => {}, 1000)',
  ].join('\n')
  const child = spawn('bun', ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  onTestFinished(() => {
    child.kill('SIGKILL')
  })
  const { promise, resolve } = Promise.withResolvers<string>()
  child.stdout.setEncoding('utf8').once('data', (chunk: string) => {
    resolve(chunk)
  })
  const outcome: unknown = JSON.parse(await promise)
  return { pid: child.pid ?? 0, outcome }
}

const tookIt = ({ outcome }: Taker): boolean =>
  JSON.stringify(outcome) === JSON.stringify({ acquired: true })

// Two takers reach for the stale lock of a home at the same moment: one takes it, and the other names the one that did
async function race(): Promise<{
  readonly got: readonly unknown[]
  readonly expected: readonly unknown[]
}> {
  const home = tempDir('bb-home-')
  writeFileSync(lockPath(home), String(DEAD_PID))
  const at = Date.now() + 1000
  const [first, second] = await Promise.all([taker(home, at), taker(home, at)])
  const expected = tookIt(first)
    ? [{ acquired: true }, { acquired: false, pid: first.pid }]
    : [{ acquired: false, pid: second.pid }, { acquired: true }]
  return { got: [first.outcome, second.outcome], expected }
}

describe('the daemon lock', () => {
  it('hands the lock to one holder, names a live holder to the next, and takes over a dead one', () => {
    const home = tempDir('bb-home-')
    expect(acquireLock(home)).toStrictEqual({ acquired: true })
    expect(modeOf(lockPath(home))).toBe(0o600)
    expect(acquireLock(home)).toStrictEqual({ acquired: false, pid: process.pid })
    releaseLock(home)
    writeFileSync(lockPath(home), String(DEAD_PID))
    expect(acquireLock(home)).toStrictEqual({ acquired: true })
    releaseLock(home)
    expect(existsSync(lockPath(home))).toBe(false)
  })

  it('takes over a lock that names no process, and leaves the lock of another holder alone', () => {
    const home = tempDir('bb-home-')
    writeFileSync(lockPath(home), 'not a pid')
    expect(acquireLock(home)).toStrictEqual({ acquired: true })
    // Pid 1 is alive on every system and is never this process
    writeFileSync(lockPath(home), '1')
    releaseLock(home)
    expect(readFileSync(lockPath(home), 'utf8')).toBe('1')
  })

  it('goes to exactly one of two takers that reach for a stale lock at the same moment', async () => {
    expect.hasAssertions()
    const rounds = await Promise.all([race(), race(), race()])
    expect(rounds.map(({ got }) => got)).toStrictEqual(rounds.map(({ expected }) => expected))
  })
})

describe(takeOverLock, () => {
  it('removes the lock of a holder that is gone, and leaves nothing aside', () => {
    const home = tempDir('bb-home-')
    writeFileSync(lockPath(home), String(DEAD_PID))
    expect(takeOverLock(home)).toBeUndefined()
    expect(readdirSync(home)).toStrictEqual([])
  })

  it('puts back a lock that a live process made since the stale one was read, and names that process', () => {
    const home = tempDir('bb-home-')
    // Pid 1 is alive on every system: its lock stands for one a racing taker has just made
    writeFileSync(lockPath(home), '1')
    expect(takeOverLock(home)).toStrictEqual({ acquired: false, pid: 1 })
    expect(readdirSync(home)).toStrictEqual(['daemon.lock'])
    expect(readFileSync(lockPath(home), 'utf8')).toBe('1')
  })

  it('lets a taker that read the stale holder before another took the lock over leave that lock in place', () => {
    const home = tempDir('bb-home-')
    writeFileSync(lockPath(home), String(DEAD_PID))
    // Both takers have read the dead holder; the first takes the lock over, then the second moves what is there now
    expect(acquireLock(home)).toStrictEqual({ acquired: true })
    expect(takeOverLock(home)).toStrictEqual({ acquired: false, pid: process.pid })
    expect(readFileSync(lockPath(home), 'utf8')).toBe(String(process.pid))
    releaseLock(home)
  })

  it('finds nothing to do when another taker moved the lock first', () => {
    const home = tempDir('bb-home-')
    expect(takeOverLock(home)).toBeUndefined()
    expect(readdirSync(home)).toStrictEqual([])
  })
})
```
`apps/bytebureau/src/daemon/stop.test.ts` (added during execution):
```ts
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it, onTestFinished } from 'vitest'
import { healthStub, recordOn } from '../testing/health-stub.js'
import { tempDir } from '../testing/temp-repo.js'
import { readServerInfo, writeServerInfo } from './server-info.js'
import { stopDaemon } from './stop.js'

// A process that stands in for the daemon of a record, killed when the test ends; one that ignores SIGTERM outlives a stop
async function standIn(ignoresSigterm: boolean): Promise<number> {
  const handler = ignoresSigterm ? "process.on('SIGTERM', () => {});" : ''
  const script = `${handler} setInterval(() => {}, 1000); console.log('ready')`
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })
  onTestFinished(() => {
    child.kill('SIGKILL')
  })
  await once(child.stdout, 'data')
  return child.pid ?? 0
}

describe(stopDaemon, () => {
  it('finds no daemon in a home without one, and removes a record whose pid is gone', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    await expect(stopDaemon(home)).resolves.toStrictEqual({ outcome: 'not_running' })
    writeServerInfo(home, recordOn(1, 2_147_483_000))
    await expect(stopDaemon(home)).resolves.toStrictEqual({ outcome: 'not_running' })
    expect(readServerInfo(home)).toStrictEqual({ state: 'absent' })
  })

  it('neither signals nor forgets a live pid that does not answer as the daemon of the record', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    // The record names this very process, on a port where no daemon answers: a SIGTERM would end the test run
    writeServerInfo(home, recordOn(1, process.pid))
    await expect(stopDaemon(home)).resolves.toStrictEqual({
      outcome: 'still_running',
      pid: process.pid,
    })
    expect(readServerInfo(home)).toStrictEqual({ state: 'alive', info: recordOn(1, process.pid) })
  })

  it('ends the daemon that answers and removes its record', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const pid = await standIn(false)
    writeServerInfo(home, recordOn(await healthStub(), pid))
    await expect(stopDaemon(home)).resolves.toStrictEqual({ outcome: 'stopped', pid })
    expect(readServerInfo(home)).toStrictEqual({ state: 'absent' })
  })

  it('tells of a daemon that outlives the limit and keeps its record', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const pid = await standIn(true)
    writeServerInfo(home, recordOn(await healthStub(), pid))
    await expect(stopDaemon(home, 300)).resolves.toStrictEqual({ outcome: 'still_running', pid })
    expect(readServerInfo(home).state).toBe('alive')
  })
})
```
`apps/bytebureau/src/daemon/wait.test.ts` (added during execution):
```ts
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { healthStub, recordOn } from '../testing/health-stub.js'
import { tempDir } from '../testing/temp-repo.js'
import { writeServerInfo } from './server-info.js'
import { daemonAnswers, runningDaemon, waitForDaemon } from './wait.js'

// Nothing listens on port 1 of the loopback: a connection there is refused at once
const NOBODY = 1

describe(waitForDaemon, () => {
  it('gives the record once its daemon has written it and answers, and nothing when none comes up in time', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const port = await healthStub()
    await expect(waitForDaemon(home, 300)).resolves.toBeUndefined()
    const waited = waitForDaemon(home, 5000)
    await sleep(200)
    writeServerInfo(home, recordOn(port))
    await expect(waited).resolves.toStrictEqual(recordOn(port))
  })

  it('takes no answer from another start, or from a port without a daemon, for the daemon of the record', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const port = await healthStub('2026-10-04T09:00:00.000Z')
    writeServerInfo(home, recordOn(port))
    await expect(daemonAnswers(recordOn(port))).resolves.toBe(false)
    await expect(daemonAnswers(recordOn(NOBODY))).resolves.toBe(false)
    await expect(waitForDaemon(home, 300)).resolves.toBeUndefined()
  })
})

describe(runningDaemon, () => {
  it('names the daemon of the home only while its pid lives and its health answers', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const port = await healthStub()
    await expect(runningDaemon(home)).resolves.toBeUndefined()
    writeServerInfo(home, recordOn(port))
    await expect(runningDaemon(home)).resolves.toStrictEqual(recordOn(port))
    writeServerInfo(home, recordOn(NOBODY))
    await expect(runningDaemon(home)).resolves.toBeUndefined()
    writeServerInfo(home, recordOn(port, 2_147_483_000))
    await expect(runningDaemon(home)).resolves.toBeUndefined()
  })
})
```
`apps/bytebureau/src/testing/health-stub.ts` (added during execution):
```ts
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { ServerInfo } from '@bytebureau/protocol'
import { onTestFinished } from 'vitest'

const STARTED_AT = '2026-10-04T10:00:00.000Z'

// A stand-in for the health of a daemon on a free loopback port, closed when the test ends; it answers with the start time it is given
export async function healthStub(startedAt: string = STARTED_AT): Promise<number> {
  const server = createServer((request, response) => {
    const found = request.url === '/api/v1/health'
    response.writeHead(found ? 200 : 404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok', startedAt }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  onTestFinished(() => {
    server.close()
  })
  const address = server.address()
  return typeof address === 'object' && address !== null ? address.port : 0
}

// The record of a daemon of this test on the port, as server.json holds it
export const recordOn = (port: number, pid: number = process.pid): ServerInfo => ({
  version: '0.0.0-test',
  host: '127.0.0.1',
  port,
  pid,
  token: 'a'.repeat(64),
  startedAt: STARTED_AT,
})
```

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
- Create: `apps/bytebureau/src/bureau/bureau.ts`, `apps/bytebureau/src/bureau/local.ts`, `apps/bytebureau/src/bureau/local.test.ts`, `apps/bytebureau/src/bureau/remote.ts`, `apps/bytebureau/src/bureau/remote.test.ts`, `apps/bytebureau/src/bureau/resolve.ts`, `apps/bytebureau/src/bureau/resolve.test.ts`, `apps/bytebureau/src/bureau/ensure-daemon.ts`, `apps/bytebureau/src/bureau/open-local.ts`, `apps/bytebureau/src/bureau/session-env.ts`, `apps/bytebureau/src/bureau/session-env.test.ts`, `apps/bytebureau/src/bureau/with-bureau.ts`, `apps/bytebureau/src/bureau/with-bureau.test.ts`, `apps/bytebureau/src/commands/run-daemon.test.ts`, `apps/bytebureau/src/commands/run-daemon-restart.test.ts`, `apps/bytebureau/src/testing/records.ts`, `apps/bytebureau/src/testing/recording-client.ts`, `apps/bytebureau/src/testing/listening.ts`, `apps/bytebureau/src/drain.ts`, `apps/bytebureau/src/drain.test.ts`
- Modify: `apps/bytebureau/src/context.ts` (`globalArgs`: `daemon`, `host`, `port`, `token-file`; `bureauFlags`; `Context.env`; `portOf` moved here), `apps/bytebureau/src/kernel.ts` (`openKernel` only; `withKernel` goes), `apps/bytebureau/src/commands/run.ts`, `run-session.ts` (`Bureau` instead of `RunKernel`, remote refusals, SIGTERM/SIGHUP), `projects.ts`, `workspaces.ts` (through `withBureau`), `config.ts` (the in-process kernel through `withLocalKernel`; never a daemon), `serve.ts` (`portOf` taken from `context.ts`), `apps/bytebureau/src/run.ts` (`DaemonRunningError` → exit 1), `apps/bytebureau/src/main.ts` (drain stdout and stderr before exit), `apps/bytebureau/src/testing/{scripted-kernel,workbench,run-cli,daemon,health-stub}.ts`, the Phase A CLI tests (`--no-daemon`), `apps/bytebureau/package.json` (`@bytebureau/client`), `apps/bytebureau/vitest.config.ts` (`execArgv`), `packages/i18n/messages/{en,cs}.json` (`bureau_daemon_running`), `packages/kernel/src/facade/{sessions,types}.ts` (`asks.get`), `vitest.config.ts` (coverage include for the bureau modules), `.github/workflows/ci.yml` (`--no-daemon` on the in-process smoke runs). `apps/bytebureau/src/errors.ts` is unchanged: the client's `ApiError` message already reads as the CLI tells it.

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
  readonly where:
    | { readonly kind: 'daemon'; readonly url: string }
    | { readonly kind: 'in-process' }
  readonly close: () => Promise<void>
}
```
`import/max-dependencies` counts modules, not names, so the one protocol import is fine.

`apps/bytebureau/src/bureau/local.ts`:
```ts
import type { Kernel } from '@bytebureau/kernel'
import type { EventEnvelope } from '@bytebureau/protocol'
import type { Bureau } from './bureau.js'

const ENDED: IteratorReturnResult<undefined> = { done: true, value: undefined }

// Settles once the signal aborts, at once when it has
const abortOf = async (signal: AbortSignal): Promise<IteratorReturnResult<undefined>> => {
  const { promise, resolve } = Promise.withResolvers<IteratorReturnResult<undefined>>()
  const end = (): void => {
    resolve(ENDED)
  }
  if (signal.aborted) {
    end()
  } else {
    signal.addEventListener('abort', end, { once: true })
  }
  const ended = await promise
  return ended
}

// The events until the signal aborts, as a subscription of the daemon ends: a wait for the next event ends then too, and the kernel's subscription with it
const untilAborted = (
  events: AsyncIterable<EventEnvelope>,
  signal: AbortSignal,
): AsyncIterable<EventEnvelope> => ({
  [Symbol.asyncIterator]: () => {
    const iterator = events[Symbol.asyncIterator]()
    const aborted = abortOf(signal)
    const end = async (): Promise<IteratorReturnResult<undefined>> => {
      if (iterator.return !== undefined) {
        await iterator.return()
      }
      return ENDED
    }
    return {
      next: async () => {
        const next = await Promise.race([iterator.next(), aborted])
        if (signal.aborted) {
          const ended = await end()
          return ended
        }
        return next
      },
      return: end,
    }
  },
})

// The kernel of this process as a Bureau; the answers given through it are the CLI's
// It started when the Bureau was made, which is the start its health tells of
export const localBureau = (kernel: Kernel, version: string): Bureau => {
  const startedAt = new Date().toISOString()
  return {
    projects: kernel.projects,
    sessions: kernel.sessions,
    asks: {
      pending: kernel.asks.pending,
      get: kernel.asks.get,
      answer: async (askId, answer) => {
        await kernel.asks.answer(askId, answer, 'cli')
      },
    },
    events: {
      subscribe: (filter, signal) => {
        const events = kernel.events.subscribe(filter)
        return signal === undefined ? events : untilAborted(events, signal)
      },
    },
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
        return { ...report, version, startedAt }
      },
    },
    where: { kind: 'in-process' },
    close: kernel.close,
  }
}
```
`kernel.asks.get` does not exist on the facade (Task 2 added `AskService.get` to the Effect service only); either add `get` to the facade's `asksApi` in this task (one line: `get: promised(AskService, (asks, id) => asks.get(id))`) and use it here, or keep the `pending` lookup — add it to the facade. The kernel's `Session`/`Project` records are assignable to the DTO types (Task 4 pinned that); if the compiler disagrees on a field, the DTO is wrong, not the kernel.

- [ ] **Step 2: The remote adapter and the refusals — tests first**

`apps/bytebureau/src/bureau/remote.test.ts` (a fake `BureauClient` object with the methods the adapter calls; the real client is tested in Task 7 and against the daemon in `run-daemon.test.ts`):
```ts
import { ApiError } from '@bytebureau/client'
import { describe, expect, it } from 'vitest'
import { isRefusal } from '../commands/run-session.js'
import { describeError } from '../errors.js'
import { recordingClient, type Calls } from '../testing/recording-client.js'
import { problemError } from '../testing/records.js'
import type { Bureau } from './bureau.js'
import { remoteBureau } from './remote.js'

describe('problems of the daemon in the CLI', () => {
  it('counts a workspace, provider or missing-provider problem as a refusal and nothing else', () => {
    expect(isRefusal(problemError(422, 'workspace_not_a_repository', 'x'))).toBe(true)
    expect(isRefusal(problemError(502, 'provider_crash', 'x'))).toBe(true)
    expect(isRefusal(problemError(422, 'session_provider_missing', 'x'))).toBe(true)
    expect(isRefusal(problemError(409, 'session_invalid_transition', 'x'))).toBe(false)
    expect(isRefusal(problemError(503, 'store_unavailable', 'x'))).toBe(false)
  })

  it('counts no answer, or an answer without a problem, as no refusal', () => {
    expect(isRefusal(new ApiError(0, undefined, 'http://127.0.0.1:1/api/v1/projects'))).toBe(false)
    expect(isRefusal(new ApiError(502, undefined, 'http://127.0.0.1:1/api/v1/projects'))).toBe(
      false,
    )
  })

  it('describes a problem with its detail and code, and a connection failure with its url', () => {
    expect(describeError(problemError(404, 'session_not_found', 'no session 42'))).toBe(
      'no session 42 (session_not_found)',
    )
    expect(describeError(new ApiError(0, undefined, 'http://127.0.0.1:1/api/v1/health'))).toBe(
      'cannot reach the daemon at http://127.0.0.1:1/api/v1/health',
    )
  })
})

const DAEMON_URL = 'http://127.0.0.1:4747'

// What a command asks of the Bureau, and the call of the client it comes to: its name and its arguments
interface Passed {
  readonly name: string
  readonly args: readonly unknown[]
  readonly ask: (bureau: Bureau) => Promise<void>
}

const ANSWER = { selected: ['yes'] }
const BODY = { projectId: 'p1', title: 'Fix the build' }

// The path of a project goes in the body the API registers it by; everything else goes on as it is
const PASSED: readonly Passed[] = [
  {
    name: 'projects.register',
    args: [{ path: '/repo' }],
    ask: async (bureau) => {
      await bureau.projects.register('/repo')
    },
  },
  {
    name: 'projects.list',
    args: [],
    ask: async (bureau) => {
      await bureau.projects.list()
    },
  },
  {
    name: 'projects.get',
    args: ['p1'],
    ask: async (bureau) => {
      await bureau.projects.get('p1')
    },
  },
  {
    name: 'projects.remove',
    args: ['p1'],
    ask: async (bureau) => {
      await bureau.projects.remove('p1')
    },
  },
  {
    name: 'sessions.create',
    args: [BODY],
    ask: async (bureau) => {
      await bureau.sessions.create(BODY)
    },
  },
  {
    name: 'sessions.prompt',
    args: ['s1', { text: 'go' }],
    ask: async (bureau) => {
      await bureau.sessions.prompt('s1', { text: 'go' })
    },
  },
  {
    name: 'sessions.interrupt',
    args: ['s1'],
    ask: async (bureau) => {
      await bureau.sessions.interrupt('s1')
    },
  },
  {
    name: 'sessions.stop',
    args: ['s1'],
    ask: async (bureau) => {
      await bureau.sessions.stop('s1')
    },
  },
  {
    name: 'sessions.complete',
    args: ['s1'],
    ask: async (bureau) => {
      await bureau.sessions.complete('s1')
    },
  },
  {
    name: 'sessions.resume',
    args: ['s1'],
    ask: async (bureau) => {
      await bureau.sessions.resume('s1')
    },
  },
  {
    name: 'sessions.list',
    args: [],
    ask: async (bureau) => {
      await bureau.sessions.list()
    },
  },
  {
    name: 'sessions.get',
    args: ['s1'],
    ask: async (bureau) => {
      await bureau.sessions.get('s1')
    },
  },
  {
    name: 'asks.pending',
    args: ['s1'],
    ask: async (bureau) => {
      await bureau.asks.pending('s1')
    },
  },
  {
    name: 'asks.get',
    args: ['a1'],
    ask: async (bureau) => {
      await bureau.asks.get('a1')
    },
  },
  {
    name: 'asks.answer',
    args: ['a1', ANSWER],
    ask: async (bureau) => {
      await bureau.asks.answer('a1', ANSWER)
    },
  },
  {
    name: 'workspaces.list',
    args: ['p1'],
    ask: async (bureau) => {
      await bureau.workspaces.list('p1')
    },
  },
  {
    name: 'workspaces.prune',
    args: ['p1'],
    ask: async (bureau) => {
      await bureau.workspaces.prune('p1')
    },
  },
  {
    name: 'usage.session',
    args: ['s1'],
    ask: async (bureau) => {
      await bureau.usage.session('s1')
    },
  },
  {
    name: 'plugins.list',
    args: [],
    ask: async (bureau) => {
      await bureau.plugins.list()
    },
  },
  {
    name: 'plugins.providers',
    args: [],
    ask: async (bureau) => {
      await bureau.plugins.providers()
    },
  },
  {
    name: 'health.check',
    args: [],
    ask: async (bureau) => {
      await bureau.health.check()
    },
  },
  {
    name: 'close',
    args: [],
    ask: async (bureau) => {
      await bureau.close()
    },
  },
]

describe(remoteBureau, () => {
  it.each(PASSED)('passes $name on to the client of the daemon', async ({ name, args, ask }) => {
    expect.hasAssertions()
    const calls: Calls = []
    await ask(remoteBureau(recordingClient(calls), DAEMON_URL))
    expect(calls).toStrictEqual([[name, ...args]])
  })

  it('subscribes with the signal of the run, and gives up on a daemon gone for fifteen seconds', () => {
    const calls: Calls = []
    const { signal } = new AbortController()
    const filter = { sessionId: 's1', since: 0, ephemeral: false }
    remoteBureau(recordingClient(calls), DAEMON_URL).events.subscribe(filter, signal)
    expect(calls).toStrictEqual([['events.subscribe', filter, { signal, retryFor: 15_000 }]])
  })

  it('says which daemon it talks to', () => {
    expect(remoteBureau(recordingClient([]), DAEMON_URL).where).toStrictEqual({
      kind: 'daemon',
      url: DAEMON_URL,
    })
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
import { tokenPath } from '../daemon/token.js'
import { tempDir } from '../testing/temp-repo.js'
import { resolveServer } from './resolve.js'

const info = {
  version: '0',
  host: '127.0.0.1',
  port: 4747,
  pid: process.pid,
  token: 't'.repeat(64),
  startedAt: 's',
}

// No process has this pid: the highest a system hands out is far below it
const DEAD_PID = 2_147_483_000

describe(resolveServer, () => {
  it('names no daemon without --host and --port, not even one server.json calls alive: only its answer will tell', () => {
    const alive = tempDir('bb-home-')
    const stale = tempDir('bb-home-')
    writeServerInfo(alive, info)
    writeServerInfo(stale, { ...info, pid: DEAD_PID })
    expect(resolveServer({}, alive)).toStrictEqual({ kind: 'none' })
    expect(resolveServer({}, stale)).toStrictEqual({ kind: 'none' })
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
    expect(resolveServer({ host: '127.0.0.1', port: 5000 }, home)).toStrictEqual({
      kind: 'explicit',
      url: 'http://127.0.0.1:5000',
      token: info.token,
    })
  })
})

describe('resolveServer for a daemon named on the command line', () => {
  it('takes the token the home keeps when its daemon is not running, and none when it keeps none', () => {
    const home = tempDir('bb-home-')
    writeFileSync(tokenPath(home), `${'k'.repeat(64)}\n`)
    expect(resolveServer({ port: 5000 }, home)).toStrictEqual({
      kind: 'explicit',
      url: 'http://127.0.0.1:5000',
      token: 'k'.repeat(64),
    })
    expect(resolveServer({ port: 5000 }, tempDir('bb-home-'))).toMatchObject({ token: '' })
  })

  it('names a token file it cannot read, rather than what the system says of it', () => {
    const file = path.join(tempDir('bb-home-'), 'no-such-token')
    expect(() => resolveServer({ port: 5000, tokenFile: file }, tempDir('bb-home-'))).toThrow(
      new Error(`Cannot read the token file ${file}`),
    )
  })

  it('fills in the loopback for --port alone and the default port for --host alone', () => {
    const home = tempDir('bb-home-')
    expect(resolveServer({ port: 5000 }, home)).toMatchObject({ url: 'http://127.0.0.1:5000' })
    expect(resolveServer({ host: '::1' }, home)).toMatchObject({ url: 'http://[::1]:4747' })
  })
})
```

- [ ] **Step 3: Remote adapter, resolution, daemon on demand, `withBureau`**

`apps/bytebureau/src/bureau/resolve.ts`:
```ts
import { readFileSync } from 'node:fs'
import { m } from '@bytebureau/i18n'
import { serverUrl } from '@bytebureau/protocol'
import { readServerInfo } from '../daemon/server-info.js'
import { tokenPath } from '../daemon/token.js'

// A daemon named on the command line, and the file of its token
export interface ServerFlags {
  readonly host?: string | undefined
  readonly port?: number | undefined
  readonly tokenFile?: string | undefined
}

// The Bureau a command talks to: the daemon unless --no-daemon
export interface BureauFlags extends ServerFlags {
  readonly daemon: boolean
}

type ResolvedServer =
  // A daemon named on the command line: used as it is, never started
  | { readonly kind: 'explicit'; readonly url: string; readonly token: string }
  // None named: the daemon of the home is the one that answers, or one started on demand
  | { readonly kind: 'none' }

// The token the home keeps in daemon.token, read as it is: tokenFor would make one for a home that has none
const keptToken = (home: string): string => {
  try {
    return readFileSync(tokenPath(home), 'utf8').trim()
  } catch {
    return ''
  }
}

// The token a --token-file holds; a file that cannot be read is named, which the error of the system does in its own words
const tokenIn = (file: string): string => {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch (error) {
    throw new Error(m.bureau_token_file_unreadable({ file }), { cause: error })
  }
}

const tokenOf = (flags: ServerFlags, home: string): string => {
  if (flags.tokenFile !== undefined) {
    return tokenIn(flags.tokenFile)
  }
  const record = readServerInfo(home)
  return record.state === 'alive' ? record.info.token : keptToken(home)
}

// The daemon --host and --port name; server.json names none, as only an answer of its daemon tells that a record holds
export const resolveServer = (flags: ServerFlags, home: string): ResolvedServer => {
  if (flags.host === undefined && flags.port === undefined) {
    return { kind: 'none' }
  }
  const host = flags.host ?? '127.0.0.1'
  const port = flags.port ?? 4747
  return { kind: 'explicit', url: serverUrl({ host, port }), token: tokenOf(flags, home) }
}
```

`apps/bytebureau/src/bureau/ensure-daemon.ts`:
```ts
import { m } from '@bytebureau/i18n'
import type { ServerInfo } from '@bytebureau/protocol'
import { daemonLogPath, spawnDaemon } from '../daemon/spawn.js'
import { runningDaemon, waitForDaemon } from '../daemon/wait.js'
import { daemonEnv } from './session-env.js'

class DaemonUnavailableError extends Error {
  public override readonly name = 'DaemonUnavailableError'
}

// The daemon of the home, started detached as serve starts it when none answers; a start that does not come up in time names the log that says why
// Only a daemon whose health answers with the start time of server.json counts, never a process that took over its pid
// It gets the environment of the command without the choices of that run, which would be its defaults for every later one
export const ensureDaemon = async (
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ServerInfo> => {
  const running = await runningDaemon(home)
  if (running !== undefined) {
    return running
  }
  spawnDaemon(home, daemonEnv(env), [])
  const started = await waitForDaemon(home)
  if (started === undefined) {
    throw new DaemonUnavailableError(m.serve_timeout({ log: daemonLogPath(home) }))
  }
  return started
}
```

`apps/bytebureau/src/bureau/remote.ts`:
```ts
import type { BureauClient } from '@bytebureau/client'
import type { Bureau } from './bureau.js'

// The daemon as a Bureau: every call is one request; a lookup the API answers 404 to is undefined here
export const remoteBureau = (client: BureauClient, url: string): Bureau => ({
  projects: {
    ...client.projects,
    register: async (path) => {
      const project = await client.projects.register({ path })
      return project
    },
  },
  sessions: client.sessions,
  asks: client.asks,
  // A run gives up on a daemon that stays unreachable for fifteen seconds; the next start of the daemon stops the session
  events: {
    subscribe: (filter, signal) => client.events.subscribe(filter, { signal, retryFor: 15_000 }),
  },
  workspaces: client.workspaces,
  usage: client.usage,
  plugins: client.plugins,
  health: client.health,
  where: { kind: 'daemon', url },
  close: client.close,
})
```
Task 7's `client.projects.get(id)` resolves `undefined` on a 404 and throws `ApiError` on any other problem; `client.events.subscribe(filter, { signal })` applies `ephemeral: false` by dropping `seq === 0` events client-side (the SSE endpoint has no such query).

`apps/bytebureau/src/bureau/with-bureau.ts`:
```ts
import { createBureauClient } from '@bytebureau/client'
import { serverUrl } from '@bytebureau/protocol'
import type { Context } from '../context.js'
import { kernelHome } from '../kernel-home.js'
import { withResource } from '../resource.js'
import type { Bureau } from './bureau.js'
import { ensureDaemon } from './ensure-daemon.js'
import { openLocal } from './open-local.js'
import { remoteBureau } from './remote.js'
import { resolveServer, type BureauFlags, type ServerFlags } from './resolve.js'

type Env = Readonly<Record<string, string | undefined>>

// The daemon the flags name, else the daemon of the home that answers, else one started on demand
// A record whose daemon does not answer (its pid taken over after a crash, a daemon on its way out) leads to a start, never to a failure
const openRemote = async (flags: ServerFlags, env: Env): Promise<Bureau> => {
  const home = kernelHome(env)
  const named = resolveServer(flags, home)
  if (named.kind === 'explicit') {
    return remoteBureau(createBureauClient({ baseUrl: named.url, token: named.token }), named.url)
  }
  const info = await ensureDaemon(home, env)
  const url = serverUrl(info)
  return remoteBureau(createBureauClient({ baseUrl: url, token: info.token }), url)
}

// A Bureau for the length of the work, closed after it: the daemon's unless --no-daemon
export const withBureau = async <Result>(
  context: Context,
  flags: BureauFlags,
  work: (bureau: Bureau) => Promise<Result>,
): Promise<Result> => {
  const open = async (): Promise<Bureau> => {
    const bureau = flags.daemon ? await openRemote(flags, context.env) : await openLocal(context)
    return bureau
  }
  const result = await withResource(open, work)
  return result
}
```
`apps/bytebureau/src/kernel.ts` keeps only `openKernel(context, env): Promise<Kernel>` (the body of the former `open`). `DaemonRunning` and `DaemonUnavailable` end a command with exit 1 (a refusal with a reason) — `run.ts` (the citty runner) maps them: add to its `catch`: `if (error instanceof DaemonRunning) { console.error(error.message); return 1 }` and `DaemonUnavailable` → exit 2 with the message (the generic path already does that; only `DaemonRunning` needs the branch). `errors.ts`: `describeError` gains `ApiError`: a problem is told as `${detail} (${code})`, a connection failure as `cannot reach the daemon at ${url}`.

`apps/bytebureau/src/context.ts`, `globalArgs` gain:
```ts
import { isatty } from 'node:tty'
import { m, setLocale } from '@bytebureau/i18n'
import type { BureauFlags } from './bureau/resolve.js'
import { resolveLocale } from './locale.js'
import { colorEnabled, createOutput, type Output } from './output.js'

export const globalArgs = {
  lang: { type: 'string', description: 'UI language: en or cs' },
  json: { type: 'boolean', description: 'Machine-readable JSON output', default: false },
  color: {
    type: 'boolean',
    description: 'Colour output; pass --no-color to disable',
    default: true,
  },
  yes: {
    type: 'boolean',
    description: 'Answer every ask that has a recommended option with it',
    default: false,
  },
  debug: {
    type: 'string',
    description:
      'Debug logging for every category; --debug=<categories> picks some (bb.agent,!bb.store), always with =',
  },
  'log-level': { type: 'string', description: 'Log level: debug, info, warn or error' },
  daemon: {
    type: 'boolean',
    description:
      'Talk to the daemon (started on demand); pass --no-daemon to run the kernel in-process',
    default: true,
  },
  host: { type: 'string', description: 'Host of a daemon to talk to (never started on demand)' },
  port: { type: 'string', description: 'Port of that daemon' },
  'token-file': { type: 'string', description: 'File holding the bearer token of that daemon' },
} as const

export interface GlobalArgs {
  readonly lang?: string | undefined
  readonly json: boolean
  readonly color: boolean
  readonly yes: boolean
  readonly debug?: string | undefined
  readonly 'log-level'?: string | undefined
  // Citty gives false for --no-daemon alone; arguments made without the flag talk to the daemon too
  readonly daemon?: boolean | undefined
  readonly host?: string | undefined
  readonly port?: string | undefined
  readonly 'token-file'?: string | undefined
}

export interface Context {
  readonly output: Output
  readonly interactive: boolean
  readonly logging: {
    readonly debug: string | undefined
    readonly level: string | undefined
  }
  // The home of the command, the configuration it reads and the environment of a daemon it starts
  readonly env: Readonly<Record<string, string | undefined>>
}

export function createContext(
  args: GlobalArgs,
  env: Readonly<Record<string, string | undefined>>,
  stdoutIsTTY: boolean,
): Context {
  const { locale, unsupported } = resolveLocale({ flag: args.lang, env })
  setLocale(locale)
  const output = createOutput({
    json: args.json,
    color: colorEnabled(env, !args.color, stdoutIsTTY),
  })
  if (unsupported !== undefined) {
    output.warn(m.cli_unknown_locale({ locale: unsupported }))
  }
  return {
    output,
    interactive: stdoutIsTTY && !args.json,
    logging: { debug: args.debug, level: args['log-level'] },
    env,
  }
}

// The context of the running process: its environment, and whether its stdout is a terminal
export function processContext(args: GlobalArgs): Context {
  return createContext(args, process.env, isatty(process.stdout.fd))
}

const usageError = (message: string): Error =>
  Object.assign(new Error(message), { name: 'CLIError' })

// A port is a whole number up to 65535; 0 asks for a free one
export const portOf = (text: string | undefined): number | undefined => {
  if (text === undefined) {
    return undefined
  }
  const port = Number(text)
  if (!/^\d+$/u.test(text) || port > 65_535) {
    throw usageError(`--port takes a whole number from 0 to 65535, not ${text}`)
  }
  return port
}

// The Bureau the global flags ask for: the daemon of the home, the one --host and --port name, or the kernel in-process
export function bureauFlags(args: GlobalArgs): BureauFlags {
  if (args['token-file'] !== undefined && args.host === undefined && args.port === undefined) {
    throw usageError(
      '--token-file goes with --host or --port: it holds the token of the daemon they name',
    )
  }
  return {
    daemon: args.daemon !== false,
    host: args.host,
    port: portOf(args.port),
    tokenFile: args['token-file'],
  }
}
```
and `GlobalArgs` the matching fields; `bureauFlags(args): BureauFlags` (a helper in `context.ts`) turns them into `{ daemon, host, port: Number | undefined, tokenFile }`. The `run` command drops its own `no-daemon` argument (the global one replaces it; `--no-daemon` keeps working because citty's boolean `daemon` accepts `--no-daemon`).

- [ ] **Step 4: Commands and the run through a Bureau**

`apps/bytebureau/src/commands/run-session.ts` (as shipped below): `RunKernel` is replaced by `Bureau` (import the type); the project path is made absolute with `path.resolve` before `bureau.projects.register` (the daemon resolves a relative path in its own working directory — the `run` command and `projects add` resolve `args.project`/`args.path` against the CLI's cwd, and the Phase A tests pass absolute temp paths already); `unknownProvider` awaits `bureau.plugins.providers()`, `answerAsk` calls `bureau.asks.answer(ask.id, answer)`, `followSession` subscribes with `bureau.events.subscribe({ sessionId, since: 0, ephemeral: false }, controller.signal)` and aborts the controller in its `finally`, and the signal handling covers `SIGINT`, `SIGTERM` and `SIGHUP` (one `stop` for the three, `process.once` each, `process.off` each in `finally`). `isRefusal` is exported and gains:
```ts
import { ApiError } from '@bytebureau/client'
import { m } from '@bytebureau/i18n'
import { ProviderError, SessionError, WorkspaceError } from '@bytebureau/kernel'
import {
  decodeEventPayload,
  type Ask,
  type CreateSessionBody,
  type EventEnvelope,
} from '@bytebureau/protocol'
import type { Bureau } from '../bureau/bureau.js'
import type { Context } from '../context.js'
import { promptAsk } from '../render/ask-prompt.js'
import { completionLine, readOrSkip, summarizeRun, titleOf } from '../render/transcript.js'
import { describeError } from '../errors.js'
import { closeFrame, EXIT_REFUSED, open, refuse, report, show, type Outcome } from './run-output.js'

const EXIT_COMPLETED = 0
const EXIT_STOPPED = 3

const TERMINAL = new Set(['session.completed', 'session.stopped', 'session.errored'])

// The first of them stops the session, and one of another kind after it does nothing; the second of a kind ends the process as it would without the run
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

// Through the daemon a refusal of the kernel comes as a problem with the code the API gives its error
const REMOTE_REFUSALS = /^(?:workspace_|provider_|session_provider_missing$)/u

type Output = Context['output']

export interface RunOptions {
  readonly prompt: string
  // An absolute path: the daemon would resolve a relative one in its own working directory
  readonly project: string
  readonly branch?: string | undefined
  readonly employee?: string | undefined
  readonly provider?: string | undefined
  // The BYTEBUREAU_* variables of the command, for the agent: a daemon does not read the environment of the command
  readonly env: Readonly<Record<string, string>>
  readonly yes: boolean
}

interface Run {
  readonly bureau: Bureau
  readonly session: { readonly id: string }
  readonly options: RunOptions
  readonly context: Context
}

// Failures that end a run with exit code 4: a project, a runtime or a worktree that cannot be used, a provider that is missing or fails
export function isRefusal(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.problem !== undefined && REMOTE_REFUSALS.test(error.problem.code)
  }
  if (error instanceof WorkspaceError) {
    return true
  }
  if (error instanceof SessionError) {
    return error.code === 'provider_missing'
  }
  return error instanceof ProviderError
}

// A named provider is checked before anything is registered or created
async function unknownProvider(
  bureau: Bureau,
  provider: string | undefined,
): Promise<string | undefined> {
  if (provider === undefined) {
    return undefined
  }
  const providers = await bureau.plugins.providers()
  const available = providers.map((candidate) => candidate.id)
  return available.includes(provider)
    ? undefined
    : m.run_provider_missing({ provider, available: available.join(', ') })
}

// An ask nobody can answer is left to the kernel policy; the person is told the session waits
async function answerAsk({ bureau, options, context }: Run, ask: Ask): Promise<void> {
  const answer = await promptAsk(ask, { yes: options.yes, interactive: context.interactive })
  if (answer === undefined) {
    context.output.warn(m.run_ask_waiting({ title: ask.title }))
    return
  }
  await bureau.asks.answer(ask.id, answer)
}

// The ask of an ask.requested event, if its payload fits
function askOf(event: EventEnvelope, output: Output): Ask | undefined {
  return readOrSkip(event, output, () => decodeEventPayload('ask.requested', event.payload).ask)
}

// Besides showing an event the CLI answers an ask, and completes the session once its turn is over
async function react(run: Run, event: EventEnvelope): Promise<void> {
  const ask = event.type === 'ask.requested' ? askOf(event, run.context.output) : undefined
  if (ask !== undefined) {
    await answerAsk(run, ask)
  }
  if (event.type === 'turn.completed') {
    await run.bureau.sessions.complete(run.session.id)
  }
}

// The events up to the end of the session, which is the last one returned
async function follow(run: Run, events: AsyncIterable<EventEnvelope>): Promise<EventEnvelope[]> {
  const seen: EventEnvelope[] = []
  for await (const event of events) {
    seen.push(event)
    show(event, run.context)
    await react(run, event)
    if (TERMINAL.has(event.type)) {
      break
    }
  }
  return seen
}

// A stop that fails is only reported; the same signal again ends the process
async function stopSession({ bureau, session, context }: Run): Promise<void> {
  try {
    await bureau.sessions.stop(session.id)
  } catch (error) {
    context.output.warn(describeError(error))
  }
}

// Ctrl-C, SIGTERM and SIGHUP stop the session alike, once; the result is a release that removes the listeners and waits for the stop
function stopOnSignals(run: Run): () => Promise<void> {
  let stopping = Promise.resolve()
  let stopped = false
  const stop = (): void => {
    if (!stopped) {
      stopped = true
      stopping = stopSession(run)
    }
  }
  for (const signal of STOP_SIGNALS) {
    process.once(signal, stop)
  }
  return async () => {
    for (const signal of STOP_SIGNALS) {
      process.off(signal, stop)
    }
    await stopping
  }
}

// A signal stops the session; the events then say so and the run ends with the exit code of a stopped one
// The children of the kernel run detached, so the terminal does not reach them: only the stop does
async function followSession(run: Run): Promise<EventEnvelope[]> {
  const { bureau, session, options } = run
  const subscription = new AbortController()
  const release = stopOnSignals(run)
  try {
    // The ephemeral events (text deltas) carry no seq of their own and no transcript line
    const filter = { sessionId: session.id, since: 0, ephemeral: false }
    const events = bureau.events.subscribe(filter, subscription.signal)
    await bureau.sessions.prompt(session.id, { text: options.prompt })
    return await follow(run, events)
  } finally {
    subscription.abort()
    await release()
  }
}

// The reason of an errored session; the type of the event stands in for a payload that cannot be read
function reasonOf(last: EventEnvelope, output: Output): string {
  const reason = readOrSkip(last, output, () => decodeEventPayload('session.errored', last.payload))
  return reason === undefined ? last.type : reason.message
}

// The summary is built only for the words that are printed: JSON output has none
function outcomeOf(last: EventEnvelope, seen: readonly EventEnvelope[], output: Output): Outcome {
  switch (last.type) {
    case 'session.stopped': {
      return { code: EXIT_STOPPED, text: m.run_stopped() }
    }
    case 'session.errored': {
      return { code: EXIT_REFUSED, text: m.run_errored({ message: reasonOf(last, output) }) }
    }
    default: {
      return {
        code: EXIT_COMPLETED,
        text: output.json ? '' : completionLine(summarizeRun(seen, output)),
      }
    }
  }
}

function conclude(seen: readonly EventEnvelope[], context: Context): number {
  const last = seen.at(-1)
  if (last === undefined || !TERMINAL.has(last.type)) {
    throw new Error('the events ended before the session did')
  }
  const outcome = outcomeOf(last, seen, context.output)
  report(outcome, context)
  return outcome.code
}

// The session as the person asked for it: what is not named is left to the kernel
function sessionBody(projectId: string, options: RunOptions): CreateSessionBody {
  return {
    projectId,
    title: titleOf(options.prompt),
    ...(options.employee === undefined ? {} : { employeeId: options.employee }),
    ...(options.provider === undefined ? {} : { providerId: options.provider }),
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    env: options.env,
  }
}

async function startAndFollow(
  bureau: Bureau,
  options: RunOptions,
  context: Context,
): Promise<number> {
  const project = await bureau.projects.register(options.project)
  const session = await bureau.sessions.create(sessionBody(project.id, options))
  const seen = await followSession({ bureau, session, options, context })
  return conclude(seen, context)
}

// A named provider is refused before anything is registered or created
async function runOrRefuse(bureau: Bureau, options: RunOptions, context: Context): Promise<number> {
  const refusal = await unknownProvider(bureau, options.provider)
  if (refusal !== undefined) {
    return refuse(context, refusal)
  }
  const code = await startAndFollow(bureau, options, context)
  return code
}

// Streams one session to its end; the exit code is 0 completed, 3 stopped, 4 project, worktree or provider refused
// A failure that has no exit code of its own closes the frame and goes on to the runner
export async function runSession(
  bureau: Bureau,
  options: RunOptions,
  context: Context,
): Promise<number> {
  open(context, options.prompt)
  try {
    return await runOrRefuse(bureau, options, context)
  } catch (error) {
    if (!isRefusal(error)) {
      closeFrame(context)
      throw error
    }
    return refuse(context, describeError(error))
  }
}
```
`run.ts` (the command), `projects.ts`, `workspaces.ts` call `withBureau(context, bureauFlags(args), process.env, …)` instead of `withKernel`; `config.ts` keeps the in-process kernel for `validate`/`schema` (they read files, no daemon needed) through `openKernel` — `config` is the one command that never talks to a daemon. `projects rm`'s `has_sessions` refusal is now either the kernel's `WorkspaceError` or an `ApiError` with code `workspace_has_sessions`: match both. `main.ts`: before `process.exit(...)`, `await drained()` where `drained = () => new Promise<void>((resolve) => { process.stdout.write('', () => resolve()) })`.

`apps/bytebureau/src/testing/scripted-kernel.ts`: the fake implements `Bureau` (the fields the run uses: `plugins.providers`, `projects.register`, `sessions.create|prompt|stop|complete`, `asks.answer`, `events.subscribe`; fill the rest with functions that throw `new Error('not scripted')`), so `run-session*.test.ts` keep running without a daemon.

New messages: `bureau_daemon_running` = "A daemon is running on {url} (pid {pid}); drop --no-daemon or stop it with bytebureau serve --stop" / "Běží démon na {url} (pid {pid}); vynechte --no-daemon nebo ho zastavte přes bytebureau serve --stop".

- [ ] **Step 5: The failing daemon-backed CLI tests**

`apps/bytebureau/src/commands/run-daemon.test.ts`:
```ts
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { readServerInfo, writeServerInfo } from '../daemon/server-info.js'
import { stopDaemon } from '../daemon/stop.js'
import { freePort, startDaemonProcess, stopDaemonOf } from '../testing/daemon.js'
import { eventLines, jsonLines } from '../testing/json-lines.js'
import { runCli, type CliResult } from '../testing/run-cli.js'
import { createTempRepo, testHome } from '../testing/temp-repo.js'
import { PROMPT, projectIdIn, workbench, worktreesOf } from '../testing/workbench.js'

// The fake provider read like a script: events as JSON, every ask answered; no --no-daemon here
const SCRIPTED = ['--provider', 'fake', '--json', '--yes']

// Without --yes and off a terminal the run waits on the question of the fake provider
const WAITING = ['--provider', 'fake', '--json']

// A run of the prompt on the repository, through the daemon of the home unless the flags say otherwise
async function runOn(repo: string, home: string, flags = SCRIPTED): Promise<CliResult> {
  const result = await runCli(['run', PROMPT, '--project', repo, ...flags], {
    BYTEBUREAU_HOME: home,
  })
  return result
}

// A daemon the CLI starts on demand ends with the test, should an assertion fail before the test stops it
function stoppedWithTheTest(home: string): void {
  onTestFinished(async () => {
    await stopDaemonOf(home)
  })
}

describe('bytebureau run through the daemon', () => {
  it('runs the fake provider end to end over the API and streams NDJSON events', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const daemon = await startDaemonProcess(home)
    const result = await runOn(repo, home)
    const types = jsonLines(result.stdout).map((record) => record['type'])
    expect([result.code, result.stderr]).toStrictEqual([0, ''])
    expect(types).toStrictEqual(expect.arrayContaining(['session.created', 'ask.requested']))
    expect(types.at(-1)).toBe('session.completed')
    expect(existsSync(worktreesOf(repo))).toBe(true)
    await daemon.stop()
  })

  it('lists the project of the run, and refuses to remove it while it has a session', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const daemon = await startDaemonProcess(home)
    await runOn(repo, home)
    const listed = await runCli(['projects', 'ls', '--json'], { BYTEBUREAU_HOME: home })
    const id = await projectIdIn(home, [])
    const removed = await runCli(['projects', 'rm', id], { BYTEBUREAU_HOME: home })
    expect(jsonLines(listed.stdout)).toMatchObject([{ projects: [{ id, path: repo }] }])
    // The kernel's refusal comes as a problem; it is told as the in-process one is, with exit code 1
    expect([removed.code, removed.stderr.trim()]).toStrictEqual([
      1,
      `project ${path.basename(repo)} still has 1 session`,
    ])
    await daemon.stop()
  })
})

describe('bytebureau run and the daemon of its home', () => {
  it('starts the daemon on demand when none runs, and leaves it running', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    stoppedWithTheTest(home)
    expect(readServerInfo(home).state).toBe('absent')
    const result = await runOn(repo, home)
    expect(result.code).toBe(0)
    expect(readServerInfo(home).state).toBe('alive')
    await expect(stopDaemon(home)).resolves.toMatchObject({ outcome: 'stopped' })
  })

  it('refuses --no-daemon while the daemon is alive, with exit 1 and the way out', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const daemon = await startDaemonProcess(home)
    const result = await runOn(repo, home, ['--no-daemon', ...SCRIPTED])
    expect(result.code).toBe(1)
    expect(result.stderr.trim()).toBe(
      `A daemon is running on ${daemon.url} (pid ${daemon.info.pid}); drop --no-daemon or stop it with bytebureau serve --stop`,
    )
    await daemon.stop()
  })

  it('still runs in-process with --no-daemon when no daemon is alive', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const result = await runOn(repo, home, ['--no-daemon', ...SCRIPTED])
    expect(result.code).toBe(0)
    expect(readServerInfo(home).state).toBe('absent')
  })
})

// The record of a daemon that crashed, its pid taken over: this test's pid is alive, and nothing listens on the port
async function writeUnansweredRecord(home: string): Promise<void> {
  const port = await freePort()
  const token = 'a'.repeat(64)
  writeServerInfo(home, {
    version: '0',
    host: '127.0.0.1',
    port,
    pid: process.pid,
    token,
    startedAt: 's',
  })
}

describe('bytebureau commands and a record whose daemon does not answer', () => {
  it('trust no record but an answer: they start a daemon on demand', async () => {
    expect.hasAssertions()
    const home = testHome()
    stoppedWithTheTest(home)
    await writeUnansweredRecord(home)
    const listed = await runCli(['projects', 'ls', '--json'], { BYTEBUREAU_HOME: home })
    const record = readServerInfo(home)
    expect([listed.code, record.state]).toStrictEqual([0, 'alive'])
    expect(record).not.toMatchObject({ info: { pid: process.pid } })
    await expect(stopDaemon(home)).resolves.toMatchObject({ outcome: 'stopped' })
  })
})

describe('bytebureau commands and a daemon named on the command line', () => {
  it('fail with exit 2 and the url when --host and --port name a daemon that is not there', async () => {
    expect.hasAssertions()
    const home = testHome()
    const result = await runCli(['projects', 'ls', '--host', '127.0.0.1', '--port', '9'], {
      BYTEBUREAU_HOME: home,
    })
    expect(result.code).toBe(2)
    expect(result.stderr.trim()).toBe(
      'cannot reach the daemon at http://127.0.0.1:9/api/v1/projects',
    )
    expect(readServerInfo(home).state).toBe('absent')
  })
})

describe('bytebureau run beside another run', () => {
  it('runs two sessions through one daemon at the same time, and the daemon knows both', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const other = createTempRepo()
    const daemon = await startDaemonProcess(home)
    const results = await Promise.all([runOn(repo, home), runOn(other, home)])
    expect(results.map((result) => result.code)).toStrictEqual([0, 0])
    expect([repo, other].map((each) => readdirSync(worktreesOf(each)).length)).toStrictEqual([1, 1])
    const listed = await runCli(['workspaces', 'ls', '--json'], { BYTEBUREAU_HOME: home })
    expect(jsonLines(listed.stdout)).toMatchObject([
      { workspaces: [{ sessionStatus: 'completed' }, { sessionStatus: 'completed' }] },
    ])
    await daemon.stop()
  })
})

describe('bytebureau run through the daemon when it is stopped or the daemon is gone', () => {
  it('stops the session on SIGTERM while it waits on an ask, and exits 3', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const daemon = await startDaemonProcess(home)
    const result = await runCli(
      ['run', PROMPT, '--project', repo, ...WAITING],
      { BYTEBUREAU_HOME: home },
      { signal: 'SIGTERM', afterStdout: '"type":"session.waiting"' },
    )
    expect(result.code).toBe(3)
    expect(eventLines(result.stdout).at(-1)).toMatchObject({ type: 'session.stopped' })
    await daemon.stop()
  })

  it('ends a run with exit 2 and the url when the daemon dies while the run waits on an ask', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const daemon = await startDaemonProcess(home)
    const result = await runCli(
      ['run', PROMPT, '--project', repo, ...WAITING],
      { BYTEBUREAU_HOME: home },
      { signal: 'SIGKILL', afterStdout: '"type":"ask.requested"', target: daemon.child },
    )
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(
      /^cannot reach the daemon at http:\/\/127\.0\.0\.1:\d+\/api\/v1\/events/mu,
    )
  }, 30_000)
})
```
`runCli`'s `Interruption` (Phase A's `testing/run-cli.ts`) signals the CLI child once its stdout contains a text; this test needs the signal sent to another process — extend `Interruption` with an optional `target: ChildProcess` that receives the signal instead of the CLI child. The `sessions ls` listing comes from Task 10; until then the parallel-run test asserts on the two exit codes and on two worktrees under each repository. The remote adapter passes `retryFor: 15_000` to `subscribeEvents`, so a run gives up fifteen seconds after the daemon stops answering, and the next `serve` recovers the session as `stopped` (Task 2).

Test homes (ruling after Task 8): a daemon a test starts on demand must not bind the default port 4747 — `testHome()` in `apps/bytebureau/src/testing/temp-repo.ts` (landed in Task 8's fix round: a `tempDir('bb-home-')` into which it writes `config.json` with `{ "server": { "port": 0 } }`; the daemon reads `server.port` from the user configuration) is what `workbench()` and `childEnv`'s default home must use from this task on, and every test of this task and of Task 10 that may start a daemon takes its home from it; `startDaemonProcess` passes `--port 0` itself.

The Phase A `run.test.ts`, `projects.test.ts`, `workspaces.test.ts` and `config.test.ts` run the CLI without a daemon alive and without `--no-daemon`: under the new default they would start a daemon on demand in every test — pass `--no-daemon` in their `runCli` calls (one edit in `workbench.ts`'s `FAKE`/`fakeRun` and in the tests that spell their own arguments), so the Phase A tests keep testing the in-process path and the daemon path has the tests above. If a `workbench` run starts a daemon anyway, `run-daemon.test.ts`'s second test is the one that wants it.

**Added files (as shipped):**

`apps/bytebureau/src/bureau/open-local.ts` (as shipped):

```ts
import { m } from '@bytebureau/i18n'
import { serverUrl } from '@bytebureau/protocol'
import type { Context } from '../context.js'
import { runningDaemon } from '../daemon/wait.js'
import { kernelHome } from '../kernel-home.js'
import { version } from '../version.js'
import type { Bureau } from './bureau.js'
import { localBureau } from './local.js'

export class DaemonRunningError extends Error {
  public override readonly name = 'DaemonRunningError'
}

// The store has one writer: the kernel of this process is refused while the daemon of the same home answers
// The module of the kernel needs Bun; it is imported only to open the kernel, so this one loads under Node, where its tests run
export const openLocal = async (context: Context): Promise<Bureau> => {
  const running = await runningDaemon(kernelHome(context.env))
  if (running !== undefined) {
    throw new DaemonRunningError(
      m.bureau_daemon_running({ pid: running.pid, url: serverUrl(running) }),
    )
  }
  const { openKernel } = await import('../kernel.js')
  return localBureau(await openKernel(context), version)
}
```

`apps/bytebureau/src/bureau/session-env.ts` (as shipped):

```ts
type Env = Readonly<Record<string, string | undefined>>

const OURS = 'BYTEBUREAU_'

// The BYTEBUREAU_* names that are a daemon's own: where it keeps its data, how much it logs, the runtime of its worktrees
const DAEMON_OWN: ReadonlySet<string> = new Set([
  'BYTEBUREAU_HOME',
  'BYTEBUREAU_LOG_LEVEL',
  'BYTEBUREAU_WORKSPACE_RUNTIME',
])

// What the environment of the command chooses for a session where the flags choose nothing
export interface SessionChoices {
  readonly employee: string | undefined
  readonly branch: string | undefined
  // The BYTEBUREAU_* variables, which the agent gets; nothing else of the environment leaves the command
  readonly env: Readonly<Record<string, string>>
}

// A variable that is set and not empty, as the kernel reads one
const setIn = (env: Env, name: string): string | undefined => {
  const value = env[name]
  return value === '' ? undefined : value
}

const kept = (env: Env, keep: (name: string) => boolean): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && keep(name)) {
      result[name] = value
    }
  }
  return result
}

// A daemon reads its own environment, not the command's: what the command's names choose travels with the session, the flags first
// The home is left out: the agent gets the home of its daemon from the daemon, which for --host and --port is another one
export const sessionChoices = (
  flags: { readonly employee?: string | undefined; readonly branch?: string | undefined },
  env: Env,
): SessionChoices => ({
  employee: flags.employee ?? setIn(env, 'BYTEBUREAU_EMPLOYEE'),
  branch: flags.branch ?? setIn(env, 'BYTEBUREAU_BRANCH'),
  env: kept(env, (name) => name.startsWith(OURS) && name !== 'BYTEBUREAU_HOME'),
})

// The environment of a daemon a command starts on demand: the command's, without the BYTEBUREAU_* names that choose for one run
// Kept, they would be the daemon's defaults, and every later run of any command would get them
export const daemonEnv = (env: Env): Record<string, string> =>
  kept(env, (name) => !name.startsWith(OURS) || DAEMON_OWN.has(name))
```

`apps/bytebureau/src/bureau/session-env.test.ts` (as shipped):

```ts
import { describe, expect, it } from 'vitest'
import { daemonEnv, sessionChoices } from './session-env.js'

describe(sessionChoices, () => {
  it('takes the employee and the base branch from the environment when the flags name none', () => {
    const env = { BYTEBUREAU_EMPLOYEE: 'reviewer', BYTEBUREAU_BRANCH: 'develop' }
    expect(sessionChoices({}, env)).toStrictEqual({ employee: 'reviewer', branch: 'develop', env })
  })

  it('lets the flags win over the environment, and takes an empty variable for none, as the kernel does', () => {
    const env = { BYTEBUREAU_EMPLOYEE: 'reviewer', BYTEBUREAU_BRANCH: '' }
    expect(sessionChoices({ employee: 'developer', branch: 'main' }, env)).toMatchObject({
      employee: 'developer',
      branch: 'main',
    })
    expect(sessionChoices({}, env)).toMatchObject({ employee: 'reviewer', branch: undefined })
  })

  it('hands on the BYTEBUREAU_* variables alone but the home, and reads none but the employee and the branch', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/home/someone',
      ANTHROPIC_API_KEY: 'not for the daemon',
      // The agent gets the home of its daemon from the daemon, whatever home the command has
      BYTEBUREAU_HOME: '/home/someone/.bytebureau',
      BYTEBUREAU_FAKE_SCRIPT: 'slow',
      BYTEBUREAU_LOG_LEVEL: 'debug',
      BYTEBUREAU_WORKSPACE_RUNTIME: 'local',
      BYTEBUREAU_UNSET: undefined,
    }
    expect(sessionChoices({}, env)).toStrictEqual({
      employee: undefined,
      branch: undefined,
      env: {
        BYTEBUREAU_FAKE_SCRIPT: 'slow',
        BYTEBUREAU_LOG_LEVEL: 'debug',
        BYTEBUREAU_WORKSPACE_RUNTIME: 'local',
      },
    })
  })
})

describe(daemonEnv, () => {
  it('keeps the BYTEBUREAU_* names of the daemon itself, and drops those that choose for a run', () => {
    const env = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'the agent may need it',
      BYTEBUREAU_HOME: '/data/bytebureau',
      BYTEBUREAU_LOG_LEVEL: 'debug',
      BYTEBUREAU_WORKSPACE_RUNTIME: 'local',
      BYTEBUREAU_EMPLOYEE: 'reviewer',
      BYTEBUREAU_BRANCH: 'develop',
      BYTEBUREAU_FAKE_SCRIPT: 'slow',
    }
    expect(daemonEnv(env)).toStrictEqual({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'the agent may need it',
      BYTEBUREAU_HOME: '/data/bytebureau',
      BYTEBUREAU_LOG_LEVEL: 'debug',
      BYTEBUREAU_WORKSPACE_RUNTIME: 'local',
    })
  })
})
```

`apps/bytebureau/src/bureau/local.test.ts` (as shipped):

```ts
import { setTimeout as sleep } from 'node:timers/promises'
import { createKernelFrom, type Kernel } from '@bytebureau/kernel'
import { KernelTest } from '@bytebureau/kernel/testing'
import { decodeEventPayload, type AskRecord, type EventEnvelope } from '@bytebureau/protocol'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createTempRepo, tempDir } from '../testing/temp-repo.js'
import type { Bureau } from './bureau.js'
import { localBureau } from './local.js'

// A kernel over an in-memory store, closed when the test is over; closing it earlier does no harm
async function testKernel(): Promise<Kernel> {
  const home = tempDir('bb-home-')
  const kernel = await createKernelFrom(KernelTest({ home }), {
    home,
    env: {},
    logging: { level: 'error' },
  })
  onTestFinished(async () => {
    await kernel.close()
  })
  return kernel
}

interface Answered {
  // The asks as they were read back by their ids, before they were answered
  readonly read: readonly (AskRecord | undefined)[]
  // What the events tell of the answer
  readonly answered: unknown
}

// The ask the agent puts is read back by its id and answered with its recommended option
async function answerTheAsk(
  bureau: Bureau,
  events: AsyncIterable<EventEnvelope>,
): Promise<Answered> {
  const read: (AskRecord | undefined)[] = []
  for await (const event of events) {
    if (event.type === 'ask.requested') {
      const { ask } = decodeEventPayload('ask.requested', event.payload)
      read.push(await bureau.asks.get(ask.id))
      await bureau.asks.answer(ask.id, { selected: ['yes'] })
    }
    if (event.type === 'ask.answered') {
      return { read, answered: event.payload }
    }
  }
  return { read, answered: undefined }
}

describe(localBureau, () => {
  it('reads the ask of a session by its id and answers it as the CLI', async () => {
    expect.hasAssertions()
    const bureau = localBureau(await testKernel(), '1.2.3')
    const project = await bureau.projects.register(createTempRepo())
    const input = { projectId: project.id, title: 'local', providerId: 'fake' }
    const session = await bureau.sessions.create(input)
    const events = bureau.events.subscribe({ sessionId: session.id, since: 0 })
    await bureau.sessions.prompt(session.id, { text: 'go' })
    await expect(answerTheAsk(bureau, events)).resolves.toMatchObject({
      read: [{ sessionId: session.id, title: 'Export style', status: 'pending' }],
      answered: { answer: { selected: ['yes'] }, answeredVia: 'cli' },
    })
  })

  it('tells its health with the version of the CLI, and the plugins and providers of the kernel', async () => {
    expect.hasAssertions()
    const bureau = localBureau(await testKernel(), '1.2.3')
    const health = await bureau.health.check()
    const plugins = await bureau.plugins.list()
    const providers = await bureau.plugins.providers()
    expect(health).toMatchObject({ status: 'ok', version: '1.2.3', checks: { store: 'ok' } })
    expect(Number.isNaN(Date.parse(health.startedAt))).toBe(false)
    expect(plugins.map((plugin) => plugin.name)).toContain('agent-fake')
    expect(providers.map((provider) => provider.id)).toContain('fake')
  })

  it('says it is in-process, and closes the kernel', async () => {
    expect.hasAssertions()
    const bureau = localBureau(await testKernel(), '1.2.3')
    expect(bureau.where).toStrictEqual({ kind: 'in-process' })
    await bureau.close()
    await expect(bureau.projects.list()).rejects.toBeInstanceOf(Error)
  })
})

// What the promise settles with, unless it takes longer than the time given
async function within<Value>(
  promise: Promise<Value>,
  ms: number,
): Promise<Value | 'still waiting'> {
  const settled = await Promise.race([promise, sleep(ms, 'still waiting' as const)])
  return settled
}

// The events of a project the Bureau registers, until the signal aborts
async function projectEvents(
  bureau: Bureau,
  signal: AbortSignal,
): Promise<AsyncIterator<EventEnvelope>> {
  const project = await bureau.projects.register(createTempRepo())
  const events = bureau.events.subscribe({ projectId: project.id, since: 0 }, signal)
  return events[Symbol.asyncIterator]()
}

describe('the events of the local Bureau', () => {
  it('end when the signal aborts, a wait for the next event as well', async () => {
    expect.hasAssertions()
    const bureau = localBureau(await testKernel(), '1.2.3')
    const subscription = new AbortController()
    const iterator = await projectEvents(bureau, subscription.signal)
    const replayed = await iterator.next()
    const waiting = iterator.next()
    subscription.abort()
    expect(replayed).toMatchObject({ done: false, value: { type: 'project.registered' } })
    await expect(within(waiting, 2000)).resolves.toStrictEqual({ done: true, value: undefined })
    await expect(iterator.next()).resolves.toStrictEqual({ done: true, value: undefined })
  })

  it('have ended before the first one for a signal that has aborted already', async () => {
    expect.hasAssertions()
    const bureau = localBureau(await testKernel(), '1.2.3')
    const iterator = await projectEvents(bureau, AbortSignal.abort())
    await expect(within(iterator.next(), 2000)).resolves.toStrictEqual({
      done: true,
      value: undefined,
    })
  })
})
```

`apps/bytebureau/src/commands/run-daemon-restart.test.ts` (as shipped):

```ts
import { once } from 'node:events'
import { createBureauClient } from '@bytebureau/client'
import { describe, expect, it } from 'vitest'
import { freePort, startDaemonProcess, type DaemonProcess } from '../testing/daemon.js'
import { eventLines, jsonLines } from '../testing/json-lines.js'
import { runCli, type CliResult } from '../testing/run-cli.js'
import { PROMPT, workbench } from '../testing/workbench.js'

interface Restarted {
  readonly result: CliResult
  // The daemon that came up in place of the first
  readonly second: DaemonProcess
}

// The first daemon ends while the run waits on the ask; the next one comes up on the same port and stops the session it finds left at work
async function runAcrossRestart(repo: string, home: string): Promise<Restarted> {
  const port = ['--port', String(await freePort())]
  const first = await startDaemonProcess(home, port)
  const ended = once(first.child, 'close')
  const running = runCli(
    ['run', PROMPT, '--project', repo, '--provider', 'fake', '--json'],
    { BYTEBUREAU_HOME: home },
    { signal: 'SIGTERM', afterStdout: '"type":"ask.requested"', target: first.child },
  )
  await ended
  const second = await startDaemonProcess(home, port)
  const result = await running
  return { result, second }
}

// The session the events of a run belong to
function sessionOf(stdout: string): string {
  const [first] = jsonLines(stdout)
  const id: unknown = first === undefined ? undefined : first['sessionId']
  return typeof id === 'string' ? id : ''
}

// The seq of every durable event of the session as the daemon keeps them, up to its stop
async function loggedSequence(daemon: DaemonProcess, sessionId: string): Promise<number[]> {
  const client = createBureauClient({ baseUrl: daemon.url, token: daemon.info.token })
  const sequence: number[] = []
  for await (const event of client.events.subscribe({ sessionId, since: 0, ephemeral: false })) {
    sequence.push(event.seq)
    if (event.type === 'session.stopped') {
      break
    }
  }
  return sequence
}

describe('bytebureau run across a restart of the daemon', () => {
  it('resumes the events where they stopped and ends as the recovered session says', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const { result, second } = await runAcrossRestart(repo, home)
    const events = eventLines(result.stdout)
    const sequence = events.map((event) => event.seq)
    expect([result.code, events.at(-1)]).toMatchObject([3, { type: 'session.stopped' }])
    // Only the recovery of the next daemon cancels the ask: the events after the restart reached the run
    expect(events.map((event) => event.type)).toContain('ask.cancelled')
    // Every durable event of the session, before the restart and after it, once and in order
    expect(sequence).toStrictEqual([...new Set(sequence)].toSorted((left, right) => left - right))
    expect(sequence).toStrictEqual(await loggedSequence(second, sessionOf(result.stdout)))
    await second.stop()
  }, 30_000)
})
```

`apps/bytebureau/src/testing/records.ts` (as shipped):

```ts
import { ApiError } from '@bytebureau/client'
import {
  defaultProjectConfig,
  type AskRecord,
  type EmployeeSpec,
  type HealthDto,
  type ProjectDto,
  type SessionDto,
  type TurnDto,
} from '@bytebureau/protocol'

// Records as the daemon answers them; every field that may be null has a value, as the CLI sources spell no null
const AT = '2026-10-02T12:00:00.000Z'

export const PROJECT: ProjectDto = {
  id: 'p1',
  name: 'repo',
  path: '/repo',
  defaultBranch: 'main',
  config: defaultProjectConfig,
  createdAt: AT,
  updatedAt: AT,
}

const EMPLOYEE: EmployeeSpec = {
  id: 'developer',
  name: 'Developer',
  provider: 'fake',
  model: 'any',
  effort: 'medium',
  systemPrompt: '',
  tools: { allow: [], deny: [] },
  permissionMode: 'supervised',
  skills: [],
  appearance: {},
}

export const SESSION: SessionDto = {
  id: 's1',
  projectId: 'p1',
  title: 'Fix the build',
  employee: EMPLOYEE,
  providerId: 'fake',
  profileId: 'default',
  workspace: {
    id: 's1',
    runtimeId: 'local',
    path: '/repo/.bytebureau/worktrees/s1',
    branch: 'bb/s1',
    baseRef: 'main',
  },
  externalRef: { providerId: 'fake', ref: 'r1' },
  status: 'ready',
  createdAt: AT,
  startedAt: AT,
  endedAt: AT,
}

export const TURN: TurnDto = {
  id: 'u1',
  sessionId: 's1',
  index: 0,
  prompt: { text: 'Fix the build' },
  status: 'completed',
  stopReason: 'end_turn',
  usage: { inputTokens: 10, outputTokens: 5 },
  startedAt: AT,
  endedAt: AT,
}

export const HEALTH: HealthDto = {
  status: 'ok',
  version: '1.2.3',
  startedAt: AT,
  checks: { store: 'ok', plugins: { loaded: 2, failed: 0 } },
}

export const ASK: AskRecord = {
  id: 'a1',
  sessionId: 's1',
  turnId: 'u1',
  kind: 'question',
  title: 'Export style',
  questions: [
    {
      id: 'q',
      header: 'Export',
      prompt: 'Should hello() be a named export?',
      options: [{ id: 'yes', label: 'Named export', recommended: true, evidence: [] }],
      multiSelect: false,
      allowOther: false,
    },
  ],
  policy: { onTimeout: 'wait', timeout: '30m' },
  recommendationSource: 'agent',
  status: 'answered',
  createdAt: AT,
  deadlineAt: AT,
  answer: { selected: ['yes'] },
  answeredAt: AT,
  answeredVia: 'cli',
}

// The failure a call of the client rejects with when the daemon answers with a problem
export const problemError = (status: number, code: string, detail: string): ApiError =>
  new ApiError(status, {
    type: `https://bytebureau.dev/problems/${code}`,
    title: 'T',
    status,
    detail,
    code,
  })
```

`apps/bytebureau/src/testing/recording-client.ts` (as shipped):

```ts
import type { BureauClient } from '@bytebureau/client'
import type { EventEnvelope } from '@bytebureau/protocol'
import { ASK, HEALTH, PROJECT, SESSION, TURN } from './records.js'

// The calls a client was asked, each its name and its arguments
export type Calls = unknown[][]

const USAGE = { turns: 1, inputTokens: 10, outputTokens: 5, costUsd: 0.002, contextPct: 3 }

// A function of the client that remembers how it was called and answers with the value
const answering =
  <Value>(calls: Calls, name: string, value: Value) =>
  async (...args: readonly unknown[]): Promise<Value> => {
    calls.push([name, ...args])
    await Promise.resolve()
    return value
  }

// The same for a command the daemon answers with no content
const doing =
  (calls: Calls, name: string) =>
  async (...args: readonly unknown[]): Promise<void> => {
    calls.push([name, ...args])
    await Promise.resolve()
  }

async function* noEvents(): AsyncGenerator<EventEnvelope> {
  await Promise.resolve()
  yield* []
}

// The calls of the client that come back with a record of the daemon
const recordsOf = (calls: Calls): Pick<BureauClient, 'projects' | 'sessions'> => ({
  projects: {
    list: answering(calls, 'projects.list', [PROJECT]),
    register: answering(calls, 'projects.register', PROJECT),
    get: answering(calls, 'projects.get', PROJECT),
    remove: doing(calls, 'projects.remove'),
  },
  sessions: {
    list: answering(calls, 'sessions.list', [SESSION]),
    create: answering(calls, 'sessions.create', SESSION),
    get: answering(calls, 'sessions.get', SESSION),
    prompt: answering(calls, 'sessions.prompt', TURN),
    interrupt: doing(calls, 'sessions.interrupt'),
    stop: doing(calls, 'sessions.stop'),
    resume: answering(calls, 'sessions.resume', SESSION),
    complete: doing(calls, 'sessions.complete'),
  },
})

// A client of no daemon at all: it remembers what it was asked
export const recordingClient = (calls: Calls): BureauClient => ({
  ...recordsOf(calls),
  asks: {
    pending: answering(calls, 'asks.pending', [ASK]),
    get: answering(calls, 'asks.get', ASK),
    answer: doing(calls, 'asks.answer'),
  },
  usage: { session: answering(calls, 'usage.session', USAGE) },
  workspaces: {
    list: answering(calls, 'workspaces.list', []),
    prune: answering(calls, 'workspaces.prune', { removed: [], retained: [] }),
  },
  plugins: {
    list: answering(calls, 'plugins.list', []),
    providers: answering(calls, 'plugins.providers', []),
  },
  health: { check: answering(calls, 'health.check', HEALTH) },
  events: {
    subscribe: (filter, options) => {
      calls.push(['events.subscribe', filter, options])
      return noEvents()
    },
  },
  rpc: {
    connect: async () => {
      await Promise.resolve()
      throw new Error('no RPC in this test')
    },
  },
  close: doing(calls, 'close'),
})
```

`apps/bytebureau/src/testing/listening.ts` (as shipped):

```ts
import { once } from 'node:events'
import type { Server } from 'node:net'

export interface Listening {
  readonly port: number
  // Stops listening, and settles once the server has closed
  readonly close: () => Promise<void>
}

// The server listening on a free loopback port
export async function listening(server: Server): Promise<Listening> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const close = async (): Promise<void> => {
    const closed = once(server, 'close')
    server.close()
    await closed
  }
  return { port, close }
}
```

`apps/bytebureau/src/drain.ts` (as shipped):

```ts
// What a stream offers to tell that it has taken in what was written to it
interface Sink {
  readonly write: (chunk: string, taken: () => void) => boolean
}

// Bun writes to a pipe asynchronously: an exit that does not wait for the writes would lose the last lines of NDJSON
// Without a limit the wait lasts as long as the reader takes, a pager too; with one it ends then, so an exit that must happen does
export async function drained(stream: Sink, limitMs?: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const timer = limitMs === undefined ? undefined : setTimeout(resolve, limitMs, false)
  stream.write('', () => {
    resolve(true)
  })
  await promise
  clearTimeout(timer)
}
```

`apps/bytebureau/src/drain.test.ts` (as shipped):

```ts
import { describe, expect, it } from 'vitest'
import { drained } from './drain.js'

describe(drained, () => {
  it('waits until the stream has taken in what was written to it before', async () => {
    expect.hasAssertions()
    const order: string[] = []
    const stream = {
      write: (chunk: string, taken: () => void): boolean => {
        setTimeout(() => {
          order.push(`taken ${JSON.stringify(chunk)}`)
          taken()
        }, 20)
        return false
      },
    }
    await drained(stream)
    order.push('drained')
    expect(order).toStrictEqual(['taken ""', 'drained'])
  })

  it('waits no longer than the limit for a stream that never takes anything in', async () => {
    expect.hasAssertions()
    const stream = { write: (): boolean => false }
    const started = performance.now()
    await drained(stream, 50)
    expect(performance.now() - started).toBeGreaterThanOrEqual(45)
  })
})
```

**Semantics (as shipped, commits 156485c, e3bf8d7, 5b00710, f2fc8d3, cf56d35, 35f6443, b028de9, 542b6e1, c2361a1, 8ccd0a6, 12b814d, e56e5d7, c84ede5):** `bureau/bureau.ts` is the `Bureau` interface; `localBureau(kernel, version)` answers asks `via: 'cli'` and adds the CLI version and a `startedAt` taken when the Bureau is made to the health check; `remoteBureau(client, url)` passes the client's areas through, sends `projects.register(path)` as `{ path }` and subscribes to events with `{ signal, retryFor: 15_000 }`, so a run gives up fifteen seconds after the daemon stops answering (exit 2, `cannot reach the daemon at <url>` — the client's own `ApiError` message, which `describeError` tells as it is; `errors.ts` is unchanged). `resolveServer(flags, home)` returns `explicit` for `--host`/`--port` (the token from `--token-file`, else the alive record's, else `daemon.token` read as it is — `tokenFor` is never called, as it would generate one) and `none` otherwise: `server.json` is never trusted by itself, `openRemote` goes through `ensureDaemon(home, env)`, whose `runningDaemon` probe is the only test of a record (a record whose daemon does not answer — a pid taken over after a crash, a daemon on its way out — leads to `spawnDaemon(home, env, [])` + `waitForDaemon(home)`, never to exit 2; a start that does not come up fails with `m.serve_timeout` naming the log, exit 2 through the generic path). `openLocal(context)` (`bureau/open-local.ts`) refuses with `DaemonRunningError` (`m.bureau_daemon_running({ url, pid })`, exit 1 in `run.ts`) while `runningDaemon(home)` answers, and imports `../kernel.js` lazily (the module needs Bun; the unit tests run under Node). `withBureau(context, flags, work)` has three parameters (`max-params`): the environment travels in `Context.env`, and the Bureau is closed through `withResource`. The global flags are `daemon` (only `false` means in-process), `host`, `port` (validated by `portOf`: `--port abc` is a usage error) and `token-file` (a usage error without `--host`/`--port`, exit 1; an unreadable token file is told by `m.bureau_token_file_unreadable` naming the file, exit 2); `bureauFlags(args)` turns them into `BureauFlags` (declared in `resolve.ts`, as `context.ts` needs the type without a cycle). `run` resolves `--project` with `path.resolve` in the command and takes its session choices from `sessionChoices(flags, env)` (`bureau/session-env.ts`): the command's `BYTEBUREAU_*` variables travel as `CreateSessionBody.env` (the kernel stores them for the agent at start and resume; nothing else of the environment leaves the command, and `BYTEBUREAU_HOME` stays out — the kernel's own allowlist gives the agent the daemon's home), and `BYTEBUREAU_EMPLOYEE` → `employeeId`, `BYTEBUREAU_BRANCH` → `branch` when the flags choose nothing — the daemon's `envOverrides` sees only the daemon's environment; the log level and the workspace runtime stay the daemon's own. For the same reason a daemon started on demand gets `daemonEnv(env)` (`session-env.ts`): the command's environment stripped of every `BYTEBUREAU_*` name but `BYTEBUREAU_HOME`, `BYTEBUREAU_LOG_LEVEL` and `BYTEBUREAU_WORKSPACE_RUNTIME`, so the command that happened to start it leaves no defaults behind for later sessions (an explicit `serve` keeps its full environment); pinned by a run with `BYTEBUREAU_EMPLOYEE=reviewer` that starts the daemon followed by a run without it. In `run-session.ts`, `isRefusal` is exported and covers an `ApiError` whose code matches `/^(?:workspace_|provider_|session_provider_missing$)/u`; `unknownProvider` asks `plugins.providers()` only when a provider is named; `followSession` subscribes with an `AbortController` and aborts in `finally`; SIGINT, SIGTERM and SIGHUP share one stop (`process.once` each, removed after; a later signal of another kind is ignored, the second of the same kind ends the process; exit 3). `localBureau`'s `events.subscribe` honours the abort signal as the remote one does. `projects add` resolves the path; `projects rm` maps the kernel's `WorkspaceError has_sessions` and the problem `workspace_has_sessions` to the same message and exit 1; `workspaces` goes through `withBureau`; `config validate`/`config schema` keep the in-process kernel and never talk to a daemon. `main.ts` drains stdout and stderr (`drain.ts`: `drained(stream, limitMs?)`) before `process.exit`: a normal exit waits for the reader as long as it takes, so a pager never sees truncated output; the uncaught-exception and unhandled-rejection handlers only print and resolve a race, and the exit after such a failure drains within 1 s. The kernel facade gains `asks.get(id)` and types `asks.pending` as `AskRecord[]`. Tests: `testHome()` is every CLI test home (`workbench()`, `childEnv`'s default — the daemon of such a home listens on port 0); `FAKE` carries `--no-daemon` (`NO_DAEMON`), `projectIdIn(home, flags = [NO_DAEMON])`; `Interruption.target?: ChildProcess` receives the signal instead of the CLI child; the scripted fake implements `Bureau` and rejects anything not scripted; `testing/records.ts` holds DTO fixtures and `problemError`, `testing/recording-client.ts` a fake `BureauClient` that records its calls; `health-stub.ts` gains `projectsStub`, `testing/daemon.ts` gains `freePort`, both on the shared `testing/listening.ts`; the CLI Vitest project passes `execArgv` to silence node:sqlite's ExperimentalWarning as the kernel and api projects do. `run-daemon.test.ts` covers the brief's seven cases plus `projects ls`/`rm` through the daemon, SIGTERM (exit 3), a stale record leading to a start; `run-config.test.ts` pins the environment handed to a daemon that lacks it and that a daemon started on demand by a run with `BYTEBUREAU_EMPLOYEE=reviewer` gives the next run the default employee; `local.test.ts` pins the abort, `drain.test.ts` the limit; `run-daemon-restart.test.ts` ends the daemon while a run waits on its ask and shows the next daemon's recovery ending the run `stopped` with `ask.cancelled` (exit 3). The three in-process smoke runs of `ci.yml` carry `--no-daemon`. Accepted as shipped: answers through the daemon are recorded `answeredVia: 'api'` (the channel the kernel received them through); a `4xx` problem ends `projects`/`workspaces` with exit 2 until Task 10's `refusable`; the mid-run test spends the full `retryFor` wait.

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
- Create: `apps/bytebureau/src/commands/sessions.ts`, `apps/bytebureau/src/commands/sessions-prompt.ts`, `apps/bytebureau/src/commands/ask.ts`, `apps/bytebureau/src/commands/ask-answer.ts`, `apps/bytebureau/src/commands/plugins.ts`, `apps/bytebureau/src/commands/status.ts`, `apps/bytebureau/src/commands/sub-commands.ts`, `apps/bytebureau/src/commands/refusable.ts`, `apps/bytebureau/src/commands/run-follow.ts`, `apps/bytebureau/src/render/tables.ts`, `apps/bytebureau/src/render/rows.ts`, `apps/bytebureau/src/testing/frames.ts`, `apps/bytebureau/src/testing/session-bench.ts`; tests `apps/bytebureau/src/render/tables.test.ts`, `apps/bytebureau/src/render/rows.test.ts`, `apps/bytebureau/src/commands/sessions.test.ts`, `apps/bytebureau/src/commands/sessions-prompt.test.ts`, `apps/bytebureau/src/commands/sessions-prompt-daemon.test.ts`, `apps/bytebureau/src/commands/ask.test.ts`, `apps/bytebureau/src/commands/ask-answer.test.ts`, `apps/bytebureau/src/commands/plugins-status.test.ts`, `apps/bytebureau/src/commands/refusable.test.ts`, `apps/bytebureau/src/commands/refusals.test.ts`, `apps/bytebureau/src/commands/run-daemon-stops.test.ts`, `apps/bytebureau/src/commands/run-session-interrupted.test.ts`, `apps/bytebureau/src/run-arguments.test.ts`, `apps/bytebureau/src/run-flags.test.ts`, `apps/bytebureau/src/testing/command-tree.ts`
- Modify: `apps/bytebureau/src/main.ts` (the root `run` is the status when no sub-command is named; the sub-commands from `sub-commands.ts`), `apps/bytebureau/src/run.ts` (global flags before a command name at any level placed after the name of the leaf; a bare `--debug` rewritten to `--debug=`), `apps/bytebureau/src/commands/run-session.ts` (`follow`/`conclude` lifted into `run-follow.ts`), `apps/bytebureau/src/commands/run-output.ts`, `apps/bytebureau/src/commands/projects.ts` (through `refusable`), `apps/bytebureau/src/commands/workspaces.ts` (through `refusable`), `apps/bytebureau/src/cli.test.ts`, `apps/bytebureau/src/commands/{run-daemon,run-session-terminal,projects}.test.ts`, `apps/bytebureau/src/testing/{daemon,events,health-stub,json-lines,workbench,scripted-kernel}.ts`, `packages/i18n/messages/{en,cs}.json`, `cspell-words.txt`, `vitest.config.ts` (coverage include for `commands/{run-follow,refusable,sessions-prompt,ask-answer}.ts`; `render/**` was already covered)

**Interfaces:**
- Consumes: `Bureau`, `withBureau`, `bureauFlags` (Task 9); `promptAsk` (Phase A); `ensureDaemon` (Task 9) for the status; the DTOs.
- Produces: the commands below; `table(rows, columns)` (plain-text columns for terminals).

Commands (spec §11.3; every one takes the global flags, `--json` emits one record or NDJSON):
- `bytebureau` (no sub-command): ensures the daemon is running (starts it on demand), prints `Daemon: <url> (pid <pid>, up since <startedAt>)`, `Projects: <n>`, `Sessions: <running> running, <waiting> waiting for you, <total> in all`, `Pending asks: <n>`; `--json` emits `{ command: 'status', daemon: { url, pid, version, startedAt }, projects, sessions: { running, waiting, total }, pendingAsks }`.
- `sessions ls` — `id  status  title  project` per session (`No sessions` when empty); `sessions show <id>` — the session's fields one per line and its pending asks; `sessions prompt <id> "<text>"` — prompts and follows the turn like `run` does (exit 0 when the turn completes, 3 stopped, 4 errored); `sessions interrupt|stop|resume <id>`.
- `ask ls [--session <id>]` — the pending asks (`id  session  title  recommended option`); `ask answer <id> [--option <id>]... [--other <text>]` — answers; without `--option`/`--other` an interactive prompt at a terminal (`--yes` picks the recommended option), a refusal otherwise.
- `plugins ls` — `name  version  state  ports` (a failed plugin shows its reason).
Every test home comes from `testHome()`/`workbench()` (Task 9: a user configuration with `server.port: 0`, so a daemon started on demand never binds 4747). A command whose request the daemon refuses (`409`, `404`, `422` problems) prints the problem's detail and exits 1 — the same shape as `projects rm` of Phase A (`sessions interrupt` on a session with no agent attached is such a refusal: the kernel answers `session_not_found`).

- [ ] **Step 1: The table renderer — test first**

`apps/bytebureau/src/render/tables.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { table } from './tables.js'

describe(table, () => {
  it('pads every column to its widest cell with two spaces between columns', () => {
    expect(
      table([
        ['a', 'bb', 'c'],
        ['dddd', 'e', 'f'],
      ]),
    ).toStrictEqual(['a     bb  c', 'dddd  e   f'])
  })

  it('leaves the last column unpadded and renders no rows as no lines', () => {
    expect(table([['x', 'y']])).toStrictEqual(['x  y'])
    expect(table([])).toStrictEqual([])
  })

  it('ends a line at its last cell, even when that cell is empty', () => {
    expect(
      table([
        ['id', 'note'],
        ['longer', ''],
      ]),
    ).toStrictEqual(['id      note', 'longer'])
  })

  it('tells a cell that spans lines on one line, so a row stays a line', () => {
    expect(
      table([
        ['a1', 'Run:\n  ls -l\r\n  pwd'],
        ['a22', 'Write'],
      ]),
    ).toStrictEqual(['a1   Run: ls -l pwd', 'a22  Write'])
  })

  it('keeps the width of a column that a shorter row leaves out', () => {
    expect(table([['one', 'two', 'three'], ['x'], ['four', 'y']])).toStrictEqual([
      'one   two  three',
      'x',
      'four  y',
    ])
  })
})
```
`apps/bytebureau/src/render/tables.ts`:
```ts
// A cell is told on the one line it belongs to: the title of an ask may hold the lines of a command
export const flat = (cell: string): string =>
  /[\r\n]/u.test(cell)
    ? cell
        .split(/\r\n|[\r\n]/u)
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .join(' ')
    : cell

// The widest cell of every column, over all the rows, however many cells a row has
const widthsOf = (rows: readonly (readonly string[])[]): number[] => {
  const widths: number[] = []
  for (const row of rows) {
    for (const [column, cell] of row.entries()) {
      widths[column] = Math.max(widths[column] ?? 0, cell.length)
    }
  }
  return widths
}

// Plain columns for a terminal: no borders, so a line stays easy to grep
export const table = (rows: readonly (readonly string[])[]): string[] => {
  const cells = rows.map((row) => row.map((cell) => flat(cell)))
  const widths = widthsOf(cells)
  return cells.map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
      .join('  ')
      .trimEnd(),
  )
}
```

- [ ] **Step 2: The commands**

`apps/bytebureau/src/commands/sessions.ts`:
```ts
import { m } from '@bytebureau/i18n'
import type { AskRecord, SessionDto } from '@bytebureau/protocol'
import { defineCommand, type CommandDef } from 'citty'
import { bureauFlags, globalArgs, processContext, type Context } from '../context.js'
import { pendingAskLines, sessionFields, sessionRows } from '../render/rows.js'
import { table } from '../render/tables.js'
import { withBureauRefusable } from './refusable.js'
import { promptSession } from './sessions-prompt.js'

const sessionArgs = {
  ...globalArgs,
  id: { type: 'positional', description: 'Session id', required: true },
} as const

function tellSessions(context: Context, sessions: readonly SessionDto[]): void {
  context.output.emit({ command: 'sessions.ls', sessions })
  if (sessions.length === 0) {
    context.output.print(m.sessions_none())
    return
  }
  for (const line of table(sessionRows(sessions))) {
    context.output.print(line)
  }
}

const ls = defineCommand({
  meta: { name: 'ls', description: 'List sessions' },
  args: { ...globalArgs },
  async run({ args }) {
    const context = processContext(args)
    const sessions = await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      const listed = await bureau.sessions.list()
      return listed
    })
    if (sessions !== undefined) {
      tellSessions(context, sessions)
    }
  },
})

// The fields of a session, one to a line, and the asks that wait for an answer to it
function tellSession(context: Context, session: SessionDto, asks: readonly AskRecord[]): void {
  for (const line of table(sessionFields(session))) {
    context.output.print(line)
  }
  for (const line of pendingAskLines(asks)) {
    context.output.print(line)
  }
}

const show = defineCommand({
  meta: { name: 'show', description: 'Show one session and its pending asks' },
  args: sessionArgs,
  async run({ args }) {
    const context = processContext(args)
    const shown = await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      const session = await bureau.sessions.get(args.id)
      const asks = session === undefined ? [] : await bureau.asks.pending(session.id)
      return { session, asks }
    })
    if (shown === undefined) {
      return
    }
    if (shown.session === undefined) {
      context.output.warn(m.sessions_missing({ id: args.id }))
      process.exitCode = 1
      return
    }
    context.output.emit({ command: 'sessions.show', session: shown.session, asks: shown.asks })
    tellSession(context, shown.session, shown.asks)
  },
})

const prompt = defineCommand({
  meta: { name: 'prompt', description: 'Prompt a session and follow its turn to the end' },
  args: {
    ...globalArgs,
    id: { type: 'positional', description: 'Session id', required: true },
    text: { type: 'positional', description: 'The prompt', required: true },
  },
  async run({ args }) {
    const context = processContext(args)
    const options = { id: args.id, text: args.text, yes: args.yes }
    const code = await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      const ended = await promptSession(bureau, options, context)
      return ended
    })
    if (code !== undefined) {
      process.exitCode = code
    }
  },
})

// What each of them tells once it is done, in a line of its own
const DONE = {
  interrupt: m.sessions_interrupted,
  stop: m.sessions_stopped,
  resume: m.sessions_resumed,
} as const

// Interrupt, stop and resume: one request, one line
const steer = (
  name: 'interrupt' | 'stop' | 'resume',
  description: string,
): CommandDef<typeof sessionArgs> =>
  defineCommand({
    meta: { name, description },
    args: sessionArgs,
    async run({ args }) {
      const context = processContext(args)
      const done = await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
        await bureau.sessions[name](args.id)
        return true
      })
      if (done !== undefined) {
        context.output.emit({ command: `sessions.${name}`, id: args.id })
        context.output.print(DONE[name]({ id: args.id }))
      }
    },
  })

export const sessionsCommand = defineCommand({
  meta: { name: 'sessions', description: 'List, inspect and steer sessions' },
  subCommands: {
    ls,
    show,
    prompt,
    interrupt: steer('interrupt', 'Interrupt the running turn of a session'),
    stop: steer('stop', 'Stop a session (resumable later)'),
    resume: steer('resume', 'Resume a stopped or errored session'),
  },
})
```
A refusal of the daemon (`ApiError` with a `4xx` problem) or of the kernel (`SessionError`) must end these commands with exit 1 and the detail on stderr: wrap the `withBureau` calls in a shared `refusable(context, work)` helper in `commands/refusable.ts` that catches `ApiError` with `status < 500` and the kernel's `SessionError`/`AskError`/`WorkspaceError`, prints `describeError(error)` with `output.warn`, sets `process.exitCode = 1` and returns `undefined`; `projects rm` adopts it too.

`apps/bytebureau/src/commands/sessions-prompt.ts`: `prompt <id> <text>` — opens the Bureau, subscribes to the session's events with `since` = the latest seq (so the earlier turns are not replayed: read `bureau.events`? there is no "latest seq" call — subscribe with `since: 0`, filter the events to those with `turnId` of the new turn once `turn.started` names it, and show only those), prompts, follows with the `follow`/`react`/`conclude` of `run-session.ts` (export them, or lift them into `commands/run-follow.ts` that both import) and exits with the run's codes. Terminal events for a prompt: `turn.completed` (0), `turn.interrupted` (3), `session.errored`/`session.stopped` (4/3) — `conclude` takes the terminal set as a parameter.

`apps/bytebureau/src/commands/ask.ts`:
```ts
import { m } from '@bytebureau/i18n'
import type { AskRecord } from '@bytebureau/protocol'
import { defineCommand } from 'citty'
import { bureauFlags, globalArgs, processContext, type Context } from '../context.js'
import { askRows } from '../render/rows.js'
import { table } from '../render/tables.js'
import { answerAsk, optionsOf } from './ask-answer.js'
import { withBureauRefusable } from './refusable.js'

function tellAsks(context: Context, asks: readonly AskRecord[]): void {
  context.output.emit({ command: 'ask.ls', asks })
  if (asks.length === 0) {
    context.output.print(m.ask_none())
    return
  }
  for (const line of table(askRows(asks))) {
    context.output.print(line)
  }
}

const ls = defineCommand({
  meta: { name: 'ls', description: 'List the asks waiting for an answer' },
  args: {
    ...globalArgs,
    session: { type: 'string', description: 'Only the asks of this session' },
  },
  async run({ args }) {
    const context = processContext(args)
    const asks = await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      const pending = await bureau.asks.pending(args.session)
      return pending
    })
    if (asks !== undefined) {
      tellAsks(context, asks)
    }
  },
})

const answer = defineCommand({
  meta: { name: 'answer', description: 'Answer an ask by id' },
  args: {
    ...globalArgs,
    id: { type: 'positional', description: 'Ask id', required: true },
    option: {
      type: 'string',
      description: 'Option id to select; once for each question of the ask',
    },
    other: { type: 'string', description: 'Free-text answer when the ask allows it' },
  },
  async run({ args, rawArgs }) {
    const context = processContext(args)
    const request = { id: args.id, options: optionsOf(rawArgs), other: args.other, yes: args.yes }
    await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      await answerAsk(bureau, request, context)
    })
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
import { bureauFlags, globalArgs, processContext } from '../context.js'
import { pluginRows } from '../render/rows.js'
import { table } from '../render/tables.js'
import { withBureauRefusable } from './refusable.js'

const ls = defineCommand({
  meta: { name: 'ls', description: 'List the loaded plugins and the ports they offer' },
  args: { ...globalArgs },
  async run({ args }) {
    const context = processContext(args)
    const plugins = await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      const listed = await bureau.plugins.list()
      return listed
    })
    if (plugins === undefined) {
      return
    }
    context.output.emit({ command: 'plugins.ls', plugins })
    if (plugins.length === 0) {
      context.output.print(m.plugins_none())
      return
    }
    for (const line of table(pluginRows(plugins))) {
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
import { serverUrl, type HealthDto } from '@bytebureau/protocol'
import { defineCommand } from 'citty'
import type { Bureau } from '../bureau/bureau.js'
import { bureauFlags, globalArgs, processContext, type Context } from '../context.js'
import { readServerInfo, type ServerRecord } from '../daemon/server-info.js'
import { kernelHome } from '../kernel-home.js'
import { withBureauRefusable } from './refusable.js'

interface Counts {
  readonly projects: number
  readonly sessions: { readonly running: number; readonly waiting: number; readonly total: number }
  readonly pendingAsks: number
}

interface Gathered {
  readonly where: Bureau['where']
  readonly health: HealthDto
  readonly counts: Counts
}

// The daemon the Bureau talked to; its pid is known only from the record of this home, and only when that record names the same daemon
interface Daemon {
  readonly url: string
  readonly pid: number | undefined
  readonly version: string
  readonly startedAt: string
}

async function gather(bureau: Bureau): Promise<Gathered> {
  const [projects, sessions, asks, health] = await Promise.all([
    bureau.projects.list(),
    bureau.sessions.list(),
    bureau.asks.pending(),
    bureau.health.check(),
  ])
  const running = sessions.filter((session) => session.status === 'running').length
  const waiting = sessions.filter((session) => session.status === 'waiting_for_human').length
  return {
    where: bureau.where,
    health,
    counts: {
      projects: projects.length,
      sessions: { running, waiting, total: sessions.length },
      pendingAsks: asks.length,
    },
  }
}

// None for the kernel in the process of the command; a daemon of another home, named by --host and --port, has no pid here
function daemonOf({ where, health }: Gathered, record: ServerRecord): Daemon | undefined {
  if (where.kind === 'in-process') {
    return undefined
  }
  const pid =
    record.state === 'alive' && serverUrl(record.info) === where.url ? record.info.pid : undefined
  return { url: where.url, pid, version: health.version, startedAt: health.startedAt }
}

function daemonLine(daemon: Daemon | undefined): string {
  if (daemon === undefined) {
    return m.status_in_process()
  }
  const { url, pid, startedAt: since } = daemon
  return pid === undefined
    ? m.status_daemon_remote({ url, since })
    : m.status_daemon({ url, pid, since })
}

function tell(context: Context, daemon: Daemon | undefined, counts: Counts): void {
  context.output.emit({ command: 'status', ...(daemon === undefined ? {} : { daemon }), ...counts })
  context.output.print(daemonLine(daemon))
  context.output.print(m.status_projects({ count: counts.projects }))
  context.output.print(m.status_sessions(counts.sessions))
  context.output.print(m.status_asks({ count: counts.pendingAsks }))
}

// What bytebureau says when it is called with nothing else: the daemon (started on demand), its projects, sessions and asks
// It is no command to name: the root of the CLI runs it for a call with no sub-command
export const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Tell the daemon, the projects, the sessions and the asks' },
  args: { ...globalArgs },
  async run({ args }) {
    const context = processContext(args)
    const gathered = await withBureauRefusable(context, bureauFlags(args), gather)
    if (gathered !== undefined) {
      const record = readServerInfo(kernelHome(context.env))
      tell(context, daemonOf(gathered, record), gathered.counts)
    }
  },
})
```
`max-statements` wants the body split (`gather`, `daemonOf`, `print`). `main.ts`: the root command gets `args: { ...globalArgs }` and `run({ args }) { await status(args) }`, and the sub-commands `sessions`, `ask`, `plugins` next to `serve`. citty runs the root `run` only when no sub-command is named.

New messages (en / cs): `sessions_none` "No sessions" / "Žádné sezení"; `sessions_missing` "No session {id}" / "Sezení {id} neexistuje"; `sessions_pending_ask` "Waiting for your answer: {title} ({id})" / "Čeká na vaši odpověď: {title} ({id})"; `sessions_done` "{action}: {id}" / "{action}: {id}"; `ask_none` "No asks waiting" / "Žádné otázky nečekají"; `ask_not_pending` "Ask {id} is not pending" / "Otázka {id} nečeká na odpověď"; `ask_needs_answer` "Ask {id} needs --option or --other outside a terminal" / "Otázka {id} potřebuje mimo terminál --option nebo --other"; `ask_answered` "Answered {id}" / "Odpovězeno: {id}"; `plugins_none` "No plugins loaded" / "Žádné pluginy"; `status_daemon` "Daemon: {url} (pid {pid}, up since {since})" / "Démon: {url} (pid {pid}, běží od {since})"; `status_in_process` "Daemon: not running (in-process)" / "Démon: neběží (v procesu)"; `status_projects` "Projects: {count}" / "Projekty: {count}"; `status_sessions` "Sessions: {running} running, {waiting} waiting for you, {total} in all" / "Sezení: {running} běží, {waiting} čeká na vás, {total} celkem"; `status_asks` "Pending asks: {count}" / "Čekající otázky: {count}".

- [ ] **Step 3: The failing command tests**

`apps/bytebureau/src/commands/sessions.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { jsonLines } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import { benchWithDaemon, completedSession, MISSING, refusal } from '../testing/session-bench.js'
import { testHome } from '../testing/temp-repo.js'
import { NO_DAEMON, PROMPT, projectIdIn, SCRIPTED, worktreesOf } from '../testing/workbench.js'

describe('bytebureau sessions ls through the daemon', () => {
  it('lists nothing before a run, and the session of a run after it', async () => {
    expect.hasAssertions()
    const { env, repo, daemon } = await benchWithDaemon()
    const empty = await runCli(['sessions', 'ls'], env)
    await runCli(['run', PROMPT, '--project', repo, ...SCRIPTED], env)
    const listed = await runCli(['sessions', 'ls', '--json'], env)
    expect([empty.code, empty.stdout.trim()]).toStrictEqual([0, 'No sessions'])
    expect(jsonLines(listed.stdout)).toMatchObject([
      { command: 'sessions.ls', sessions: [{ status: 'completed', title: PROMPT }] },
    ])
    await daemon.stop()
  })

  it('lists the id, the status, the title and the project of a session in a row', async () => {
    expect.hasAssertions()
    const { env, home, id, daemon } = await completedSession()
    const listed = await runCli(['sessions', 'ls'], env)
    const project = await projectIdIn(home, [])
    expect(listed.stdout.trim().split('  ')).toStrictEqual([id, 'completed', PROMPT, project])
    await daemon.stop()
  })
})

describe('bytebureau sessions show through the daemon', () => {
  it('tells the fields of a session one to a line', async () => {
    expect.hasAssertions()
    const { env, repo, id, daemon } = await completedSession()
    const shown = await runCli(['sessions', 'show', id], env)
    expect([shown.code, shown.stderr]).toStrictEqual([0, ''])
    expect(shown.stdout).toMatch(new RegExp(`^id\\s+${id}$`, 'mu'))
    expect(shown.stdout).toMatch(/^status\s+completed$/mu)
    expect(shown.stdout).toMatch(/^provider\s+fake$/mu)
    expect(shown.stdout).toContain(worktreesOf(repo))
    await daemon.stop()
  })

  it('tells the session and its asks as one JSON record', async () => {
    expect.hasAssertions()
    const { env, id, daemon } = await completedSession()
    const shown = await runCli(['sessions', 'show', id, '--json'], env)
    expect(jsonLines(shown.stdout)).toMatchObject([
      { command: 'sessions.show', session: { id, status: 'completed' }, asks: [] },
    ])
    await daemon.stop()
  })

  it('refuses a session that is not there, with exit code 1', async () => {
    expect.hasAssertions()
    const { env, daemon } = await benchWithDaemon()
    await expect(refusal(['sessions', 'show', MISSING], env)).resolves.toStrictEqual([
      1,
      `No session ${MISSING}`,
    ])
    await daemon.stop()
  })
})

describe('bytebureau sessions steering through the daemon', () => {
  it('refuses what a completed session cannot do, with the reason of the kernel and exit code 1', async () => {
    expect.hasAssertions()
    const { env, id, daemon } = await completedSession()
    const stop = refusal(['sessions', 'stop', id], env)
    const resume = refusal(['sessions', 'resume', id], env)
    const prompt = refusal(['sessions', 'prompt', id, 'again'], env)
    await expect(stop).resolves.toStrictEqual([1, 'cannot stop a completed session'])
    await expect(resume).resolves.toStrictEqual([1, 'cannot resume a completed session'])
    await expect(prompt).resolves.toStrictEqual([1, 'cannot prompt a completed session'])
    await daemon.stop()
  })

  it('refuses to interrupt a session that no agent is attached to, and one that is not there', async () => {
    expect.hasAssertions()
    const { env, id, daemon } = await completedSession()
    const interrupt = refusal(['sessions', 'interrupt', id], env)
    const stop = refusal(['sessions', 'stop', MISSING], env)
    await expect(interrupt).resolves.toStrictEqual([1, `session ${id} is not running`])
    await expect(stop).resolves.toStrictEqual([1, `session ${MISSING} does not exist`])
    await daemon.stop()
  })
})

describe('bytebureau sessions in the process of the command', () => {
  it('lists nothing, as JSON', async () => {
    expect.hasAssertions()
    const env = { BYTEBUREAU_HOME: testHome() }
    const listed = await runCli(['sessions', 'ls', '--json', NO_DAEMON], env)
    expect(jsonLines(listed.stdout)).toStrictEqual([{ command: 'sessions.ls', sessions: [] }])
  })

  it('tells in Czech with --lang cs', async () => {
    expect.hasAssertions()
    const env = { BYTEBUREAU_HOME: testHome() }
    const none = await runCli(['sessions', 'ls', '--lang', 'cs', NO_DAEMON], env)
    const missing = refusal(['sessions', 'show', MISSING, '--lang', 'cs', NO_DAEMON], env)
    expect([none.code, none.stdout.trim()]).toStrictEqual([0, 'Žádné relace'])
    await expect(missing).resolves.toStrictEqual([1, `Relace ${MISSING} neexistuje`])
  })

  it('refuses to show, stop, prompt or interrupt a session that is not there, in the words of the kernel', async () => {
    expect.hasAssertions()
    const env = { BYTEBUREAU_HOME: testHome() }
    const does = `session ${MISSING} does not exist`
    const show = refusal(['sessions', 'show', MISSING, NO_DAEMON], env)
    await expect(show).resolves.toStrictEqual([1, `No session ${MISSING}`])
    const stop = refusal(['sessions', 'stop', MISSING, NO_DAEMON], env)
    await expect(stop).resolves.toStrictEqual([1, does])
    const prompt = refusal(['sessions', 'prompt', MISSING, 'go', NO_DAEMON], env)
    await expect(prompt).resolves.toStrictEqual([1, does])
  })
})
```
`FAKE` of the workbench carries `--provider fake --json --yes`; after Task 9 it also carries `--no-daemon` for the Phase A tests — this test wants the daemon, so spell the flags here without `--no-daemon` (`['--provider', 'fake', '--json', '--yes']`).

`apps/bytebureau/src/commands/ask.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { eventLines, firstField, jsonLines, payloadOf } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import { benchWithDaemon, finished, waitingRun, type Waiting } from '../testing/session-bench.js'
import { testHome } from '../testing/temp-repo.js'
import { NO_DAEMON } from '../testing/workbench.js'

// The two exit codes of an ask answered with the arguments, and what the events of the run tell of the answer
async function answeredWith(
  waiting: Waiting,
  answer: readonly string[],
): Promise<readonly unknown[]> {
  const answered = await runCli(['ask', 'answer', waiting.id, ...answer], waiting.env)
  const run = await waiting.run
  await waiting.daemon.stop()
  return [answered.code, run.code, payloadOf(eventLines(run.stdout), 'ask.answered')]
}

describe('bytebureau ask ls through the daemon', () => {
  it('lists nothing while no ask waits', async () => {
    expect.hasAssertions()
    const { env, daemon } = await benchWithDaemon()
    const none = await runCli(['ask', 'ls'], env)
    expect([none.code, none.stdout.trim()]).toStrictEqual([0, 'No asks waiting'])
    await daemon.stop()
  })

  it('lists the ask a run waits on: as JSON, and as a row with the option it recommends', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    const text = await runCli(['ask', 'ls'], waiting.env)
    const sessionId = firstField(waiting.listed, 'asks', 'sessionId')
    expect(jsonLines(waiting.listed)).toMatchObject([
      { command: 'ask.ls', asks: [{ status: 'pending', title: 'Export style' }] },
    ])
    expect(text.stdout.trim().split('  ')).toStrictEqual([
      waiting.id,
      sessionId,
      'Export style',
      'Named export (Recommended)',
    ])
    await finished(waiting)
    await waiting.daemon.stop()
  })

  it('lists only the asks of the session it is given', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    const sessionId = firstField(waiting.listed, 'asks', 'sessionId')
    const ofSession = await runCli(['ask', 'ls', '--session', sessionId], waiting.env)
    const ofOther = await runCli(['ask', 'ls', '--session', 'nobody'], waiting.env)
    expect(ofSession.stdout.trim().split('  ')[0]).toBe(waiting.id)
    expect(ofOther.stdout.trim()).toBe('No asks waiting')
    await finished(waiting)
    await waiting.daemon.stop()
  })
})

describe('bytebureau sessions show and the status, for a run that waits on its ask', () => {
  it('shows the ask that waits for an answer in its session', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    const sessionId = firstField(waiting.listed, 'asks', 'sessionId')
    const shown = await runCli(['sessions', 'show', sessionId], waiting.env)
    const json = await runCli(['sessions', 'show', sessionId, '--json'], waiting.env)
    expect(shown.stdout).toMatch(/^status\s+waiting_for_human$/mu)
    expect(shown.stdout).toContain(`Waiting for your answer: Export style (${waiting.id})`)
    expect(jsonLines(json.stdout)).toMatchObject([
      { command: 'sessions.show', asks: [{ id: waiting.id }] },
    ])
    await finished(waiting)
    await waiting.daemon.stop()
  })

  it('tells the ask that waits, and the counts, in Czech', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    const sessionId = firstField(waiting.listed, 'asks', 'sessionId')
    const shown = await runCli(['sessions', 'show', sessionId, '--lang', 'cs'], waiting.env)
    const status = await runCli(['--lang', 'cs'], waiting.env)
    expect(shown.stdout).toContain(`Čeká na Vaši odpověď: Export style (${waiting.id})`)
    expect(status.stdout.trim().split('\n').slice(2)).toStrictEqual([
      'Relace: celkem 1, běžící 0, čekající na Vás 1',
      'Čekající otázky: 1',
    ])
    await finished(waiting)
    await waiting.daemon.stop()
  })

  it('counts the session and the ask in the status', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    const status = await runCli([], waiting.env)
    expect(status.stdout.trim().split('\n').slice(1)).toStrictEqual([
      'Projects: 1',
      'Sessions: 0 running, 1 waiting for you, 1 in all',
      'Pending asks: 1',
    ])
    await finished(waiting)
    await waiting.daemon.stop()
  })
})

describe('bytebureau ask answer through the daemon', () => {
  it('refuses to answer with nothing to answer with, and with an option the ask does not have', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    const { id, env } = waiting
    const needs = await runCli(['ask', 'answer', id], env)
    const unknown = await runCli(['ask', 'answer', id, '--option', 'nope'], env)
    expect([needs.code, needs.stderr.trim()]).toStrictEqual([
      1,
      `Ask ${id} needs --option or --other outside a terminal`,
    ])
    expect([unknown.code, unknown.stderr.trim()]).toStrictEqual([1, `ask ${id} has no option nope`])
    await finished(waiting)
    await waiting.daemon.stop()
  })

  it('answers with the recommended option for --yes, and the run completes', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    const { id, env } = waiting
    const answered = await runCli(['ask', 'answer', id, '--yes'], env)
    const run = await waiting.run
    expect([answered.code, answered.stdout.trim()]).toStrictEqual([0, `Answered ${id}`])
    expect([run.code, jsonLines(run.stdout).at(-1)]).toMatchObject([
      0,
      { type: 'session.completed' },
    ])
    await waiting.daemon.stop()
  })

  it('refuses an ask that is answered already', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    await finished(waiting)
    const { id, env } = waiting
    const again = await runCli(['ask', 'answer', id, '--yes'], env)
    expect([again.code, again.stderr.trim()]).toStrictEqual([1, `Ask ${id} is not pending`])
    await waiting.daemon.stop()
  })
})

describe('bytebureau ask answer with a global flag before the group', () => {
  it('keeps --other with no text from taking the flag that moved behind the group for its text', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    const { id, env } = waiting
    const refused = await runCli(['--json', 'ask', 'answer', id, '--other'], env)
    expect([refused.code, refused.stdout]).toStrictEqual([1, ''])
    expect(jsonLines(refused.stderr)).toStrictEqual([
      { level: 'warn', message: `Ask ${id} needs --option or --other outside a terminal` },
    ])
    await finished(waiting)
    await waiting.daemon.stop()
  })
})

describe('bytebureau ask answer with options and words', () => {
  it('answers with an option for each question, spelled apart from its id or with an equals sign', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    const answered = await answeredWith(waiting, ['--option', 'yes', '--option=default'])
    expect(answered).toMatchObject([0, 0, { answer: { selected: ['yes', 'default'] } }])
  })

  it('answers with the words of the person when the ask allows them', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    const answered = await answeredWith(waiting, ['--other', 'A barrel file'])
    expect(answered).toMatchObject([
      0,
      0,
      { answer: { selected: 'other', otherText: 'A barrel file' } },
    ])
  })
})

describe('bytebureau ask in the process of the command', () => {
  it('lists nothing, as JSON', async () => {
    expect.hasAssertions()
    const listed = await runCli(['ask', 'ls', '--json', NO_DAEMON], { BYTEBUREAU_HOME: testHome() })
    expect(jsonLines(listed.stdout)).toStrictEqual([{ command: 'ask.ls', asks: [] }])
  })

  it('refuses an ask that is not there', async () => {
    expect.hasAssertions()
    const env = { BYTEBUREAU_HOME: testHome() }
    const missing = await runCli(['ask', 'answer', 'a0', '--yes', NO_DAEMON], env)
    expect([missing.code, missing.stderr.trim()]).toStrictEqual([1, 'Ask a0 is not pending'])
  })
})
```
`--yes` picks the recommended option even off a terminal (Phase A's `promptAsk` does that), which is what the second `ask answer` relies on. The polling loop with `await` needs the `no-await-in-loop` treatment of Task 8.

`apps/bytebureau/src/commands/plugins-status.test.ts`:
```ts
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readServerInfo } from '../daemon/server-info.js'
import { stopDaemon } from '../daemon/stop.js'
import { startDaemonProcess, stoppedWithTheTest, type DaemonProcess } from '../testing/daemon.js'
import { jsonLines } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import { tempDir, testHome } from '../testing/temp-repo.js'
import { NO_DAEMON } from '../testing/workbench.js'

const WORKSPACE_LOCAL = /^workspace-local\s+\S+\s+loaded\s+workspaceRuntimes:local$/mu
const AGENT_FAKE = /^agent-fake\s+\S+\s+loaded\s+agentProviders:fake$/mu

// What `bytebureau --json` tells of a daemon that has nothing yet, in the order of its keys
const IDLE_DAEMON =
  /^\{"command":"status","daemon":\{"url":"http:\/\/127\.0\.0\.1:\d+","pid":\d+,"version":"[^"]+","startedAt":"[\d:.TZ-]+"\},"projects":0,"sessions":\{"running":0,"waiting":0,"total":0\},"pendingAsks":0\}$/u

// What it tells of the kernel in the process of the command
const IN_PROCESS = [
  'Daemon: not running (in-process)',
  'Projects: 0',
  'Sessions: 0 running, 0 waiting for you, 0 in all',
  'Pending asks: 0',
]

describe('bytebureau plugins ls', () => {
  it('lists the bundled plugins as loaded, with the ports they offer', async () => {
    expect.hasAssertions()
    const home = testHome()
    const daemon = await startDaemonProcess(home)
    const env = { BYTEBUREAU_HOME: home }
    const listed = await runCli(['plugins', 'ls', '--json'], env)
    const text = await runCli(['plugins', 'ls'], env)
    expect(jsonLines(listed.stdout)).toMatchObject([
      {
        command: 'plugins.ls',
        plugins: [
          { name: 'workspace-local', state: 'loaded', ports: ['workspaceRuntimes:local'] },
          { name: 'agent-fake', state: 'loaded', ports: ['agentProviders:fake'] },
        ],
      },
    ])
    expect(text.stdout).toMatch(WORKSPACE_LOCAL)
    expect(text.stdout).toMatch(AGENT_FAKE)
    await daemon.stop()
  })

  it('lists them in the process of the command, where no daemon is started', async () => {
    expect.hasAssertions()
    const home = testHome()
    const text = await runCli(['plugins', 'ls', NO_DAEMON], { BYTEBUREAU_HOME: home })
    expect(text.stdout).toMatch(WORKSPACE_LOCAL)
    expect(text.stdout).toMatch(AGENT_FAKE)
    expect(readServerInfo(home).state).toBe('absent')
  })
})

describe('bytebureau with no sub-command', () => {
  it('starts the daemon on demand, and tells what it has as one JSON record', async () => {
    expect.hasAssertions()
    const home = testHome()
    stoppedWithTheTest(home)
    const result = await runCli(['--json'], { BYTEBUREAU_HOME: home })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toMatch(IDLE_DAEMON)
    expect(readServerInfo(home).state).toBe('alive')
    await expect(stopDaemon(home)).resolves.toMatchObject({ outcome: 'stopped' })
  })

  it('tells the daemon of the home with its pid and its start, and its counts', async () => {
    expect.hasAssertions()
    const home = testHome()
    const daemon = await startDaemonProcess(home)
    const text = await runCli([], { BYTEBUREAU_HOME: home })
    const [line, ...counts] = text.stdout.trim().split('\n')
    expect(line).toBe(
      `Daemon: ${daemon.url} (pid ${daemon.info.pid}, up since ${daemon.info.startedAt})`,
    )
    expect(counts).toStrictEqual(IN_PROCESS.slice(1))
    await daemon.stop()
  })
})

// The flags that name the daemon from another home: its address, and the file of its token
function naming(daemon: DaemonProcess): string[] {
  const tokenFile = path.join(tempDir('bb-token-'), 'token')
  writeFileSync(tokenFile, daemon.info.token)
  return ['--host', daemon.info.host, '--port', String(daemon.info.port), '--token-file', tokenFile]
}

describe('bytebureau with no sub-command, for a daemon that --host and --port name', () => {
  it('tells it without a pid, which only the home of the daemon knows', async () => {
    expect.hasAssertions()
    const daemon = await startDaemonProcess(testHome())
    const named = naming(daemon)
    const elsewhere = { BYTEBUREAU_HOME: testHome() }
    const text = await runCli(named, elsewhere)
    const json = await runCli([...named, '--json'], elsewhere)
    expect(text.stdout.split('\n')[0]).toBe(
      `Daemon: ${daemon.url} (up since ${daemon.info.startedAt})`,
    )
    expect(jsonLines(json.stdout)).toMatchObject([{ daemon: { url: daemon.url } }])
    expect(json.stdout).not.toContain('"pid"')
    await daemon.stop()
  })
})

describe('bytebureau with no sub-command, in the process of the command', () => {
  it('tells that the kernel runs in the process of the command with --no-daemon, and starts no daemon', async () => {
    expect.hasAssertions()
    const home = testHome()
    const text = await runCli([NO_DAEMON], { BYTEBUREAU_HOME: home })
    expect(text.stdout.trim().split('\n')).toStrictEqual(IN_PROCESS)
    expect(readServerInfo(home).state).toBe('absent')
  })

  it('leaves the daemon out of the JSON record then', async () => {
    expect.hasAssertions()
    const json = await runCli(['--json', NO_DAEMON], { BYTEBUREAU_HOME: testHome() })
    expect(jsonLines(json.stdout)).toStrictEqual([
      {
        command: 'status',
        projects: 0,
        sessions: { running: 0, waiting: 0, total: 0 },
        pendingAsks: 0,
      },
    ])
  })

  it('tells in Czech with --lang cs, which comes before nothing else', async () => {
    expect.hasAssertions()
    const text = await runCli(['--lang', 'cs', NO_DAEMON], { BYTEBUREAU_HOME: testHome() })
    expect(text.stdout.trim().split('\n')).toStrictEqual([
      'Démon: neběží (v procesu)',
      'Projekty: 0',
      'Relace: celkem 0, běžící 0, čekající na Vás 0',
      'Čekající otázky: 0',
    ])
  })

  it('is not told after another command, which would start a daemon of its own', async () => {
    expect.hasAssertions()
    const home = testHome()
    stoppedWithTheTest(home)
    const hello = await runCli(['hello', '--json'], { BYTEBUREAU_HOME: home })
    expect(jsonLines(hello.stdout)).toStrictEqual([
      { command: 'hello', message: 'Hello! ByteBureau is ready.' },
    ])
    expect(readServerInfo(home).state).toBe('absent')
  })
})
```
The plugin names and ports are the bundled ones (`workspace-local` offering `workspaceRuntime`, the fake agent offering `agentProvider`); read `PluginStatus.ports` of one `plugins ls --json` once and pin the exact strings.

**Added files (as shipped):**

`apps/bytebureau/src/commands/sessions-prompt.ts` (as shipped):

```ts
import type { Bureau } from '../bureau/bureau.js'
import type { Context } from '../context.js'
import { conclude, promptAndFollow, type Ends } from './run-follow.js'
import { closeFrame, open } from './run-output.js'

// A prompt ends with its turn, or with the session if that ends first; the session stays ready for the next prompt
// An interrupted turn ends where the session says what became of it: ready again, stopped or errored
const PROMPT_ENDS: Ends = {
  terminal: new Set(['turn.completed', 'session.stopped', 'session.errored']),
  completes: false,
  turnOnly: true,
}

export interface PromptOptions {
  readonly id: string
  readonly text: string
  readonly yes: boolean
}

async function followPrompt(
  bureau: Bureau,
  options: PromptOptions,
  context: Context,
): Promise<number> {
  const run = { bureau, session: { id: options.id }, context, yes: options.yes, ends: PROMPT_ENDS }
  const followed = await promptAndFollow(run, options.text)
  return conclude(followed, context)
}

// Prompts a session and follows the new turn to its end; the exit code is 0 completed, 3 interrupted or stopped, 4 errored
// A request that is refused, as any other failure, closes the frame and goes on: the command tells a refusal with exit code 1, as every command but run does
export async function promptSession(
  bureau: Bureau,
  options: PromptOptions,
  context: Context,
): Promise<number> {
  open(context, options.text)
  try {
    return await followPrompt(bureau, options, context)
  } catch (error) {
    closeFrame(context)
    throw error
  }
}
```

`apps/bytebureau/src/commands/ask-answer.ts` (as shipped):

```ts
import { m } from '@bytebureau/i18n'
import type { AskAnswer, AskRecord } from '@bytebureau/protocol'
import type { Bureau } from '../bureau/bureau.js'
import type { Context } from '../context.js'
import { promptAsk, type Prompts } from '../render/ask-prompt.js'

// What the flags of `ask answer` say, and whether --yes is among them
export interface AnswerFlags {
  readonly options: readonly string[]
  readonly other: string | undefined
  readonly yes: boolean
  // The prompts a person answers through; a test can put others in place of the terminal's
  readonly prompts?: Prompts | undefined
}

export interface Answering extends AnswerFlags {
  readonly id: string
}

// An ask with several questions is answered with one --option for each, but citty keeps only the last of a flag that is given twice
// So the ids are read from the arguments themselves
export function optionsOf(rawArgs: readonly string[]): string[] {
  const options: string[] = []
  for (const [index, arg] of rawArgs.entries()) {
    if (arg === '--') {
      break
    }
    if (arg === '--option') {
      const next = rawArgs[index + 1]
      if (next !== undefined) {
        options.push(next)
      }
    } else if (arg.startsWith('--option=')) {
      options.push(arg.slice('--option='.length))
    }
  }
  return options
}

// The answer the flags spell; else the person at a terminal is asked
// A person who was asked and gave no answer cancelled the prompt; none means nobody could be asked
export async function answerOf(
  { options, other, yes, prompts }: AnswerFlags,
  ask: AskRecord,
  context: Context,
): Promise<AskAnswer | 'cancelled' | undefined> {
  if (other !== undefined && other !== '') {
    return { selected: 'other', otherText: other }
  }
  if (options.length > 0) {
    return { selected: [...options] }
  }
  const answer = await promptAsk(ask, { yes, interactive: context.interactive }, prompts)
  return answer === undefined && !yes && context.interactive ? 'cancelled' : answer
}

// The command ends with exit code 1 and the words that say why
function failWith(context: Context, text: string): void {
  context.output.warn(text)
  process.exitCode = 1
}

// The ask of the id, if it still waits for an answer
async function pendingAsk(
  bureau: Bureau,
  id: string,
  context: Context,
): Promise<AskRecord | undefined> {
  const ask = await bureau.asks.get(id)
  if (ask === undefined || ask.status !== 'pending') {
    failWith(context, m.ask_not_pending({ id }))
    return undefined
  }
  return ask
}

// A cancelled prompt ends the command with exit code 1 and no line: the prompt has shown that it was cancelled
async function answerFor(
  request: Answering,
  ask: AskRecord,
  context: Context,
): Promise<AskAnswer | undefined> {
  const said = await answerOf(request, ask, context)
  if (said === 'cancelled') {
    process.exitCode = 1
    return undefined
  }
  if (said === undefined) {
    // --yes asked for the recommended option, and there is none: the person is not left to wonder about a terminal
    failWith(
      context,
      request.yes
        ? m.ask_no_recommended({ id: request.id })
        : m.ask_needs_answer({ id: request.id }),
    )
  }
  return said
}

// The ask must be pending, and the flags, or the person at a terminal, must answer it
export async function answerAsk(
  bureau: Bureau,
  request: Answering,
  context: Context,
): Promise<void> {
  const ask = await pendingAsk(bureau, request.id, context)
  if (ask === undefined) {
    return
  }
  const answer = await answerFor(request, ask, context)
  if (answer !== undefined) {
    await bureau.asks.answer(ask.id, answer)
    context.output.emit({ command: 'ask.answer', id: ask.id, answer })
    context.output.print(m.ask_answered({ id: ask.id }))
  }
}
```

`apps/bytebureau/src/commands/sub-commands.ts` (as shipped):

```ts
import { askCommand } from './ask.js'
import { configCommand } from './config.js'
import { helloCommand } from './hello.js'
import { pluginsCommand } from './plugins.js'
import { projectsCommand } from './projects.js'
import { runCommand } from './run.js'
import { serveCommand } from './serve.js'
import { sessionsCommand } from './sessions.js'
import { workspacesCommand } from './workspaces.js'

// Every command of the CLI by the name it is called with
export const subCommands = {
  hello: helloCommand,
  run: runCommand,
  config: configCommand,
  projects: projectsCommand,
  workspaces: workspacesCommand,
  serve: serveCommand,
  sessions: sessionsCommand,
  ask: askCommand,
  plugins: pluginsCommand,
}
```

`apps/bytebureau/src/commands/refusable.ts` (as shipped):

```ts
import { ApiError } from '@bytebureau/client'
import {
  AskError,
  ConfigError,
  ProviderError,
  SessionError,
  WorkspaceError,
} from '@bytebureau/kernel'
import type { Bureau } from '../bureau/bureau.js'
import type { BureauFlags } from '../bureau/resolve.js'
import { withBureau } from '../bureau/with-bureau.js'
import type { Context } from '../context.js'
import { oneLine } from './run-output.js'

// What a refusal says: the detail of the problem the daemon answered with, or the reason of the kernel's own error
// The errors of the kernel that the API answers with a 4xx problem are the refusals in-process, told as the API tells them
// A failure that is no refusal has none
function refusalOf(error: unknown): string | undefined {
  if (error instanceof ApiError) {
    const { problem } = error
    return problem !== undefined && error.status < 500 ? problem.detail : undefined
  }
  if (error instanceof ConfigError) {
    return `${error.file}${error.pointer}: ${error.reason}`
  }
  if (error instanceof ProviderError) {
    return error.kind === 'missing' ? error.reason : undefined
  }
  if (
    error instanceof SessionError ||
    error instanceof AskError ||
    error instanceof WorkspaceError
  ) {
    return error.reason
  }
  return undefined
}

// A request that is refused, by the daemon with a 4xx problem or by the kernel in-process, ends the command with exit code 1 and its reason in one line
// Any other failure goes on to the runner; nothing comes back for a refusal, so the command prints no success
export async function refusable<Result>(
  context: Context,
  work: () => Promise<Result>,
): Promise<Result | undefined> {
  try {
    const result = await work()
    return result
  } catch (error) {
    const refusal = refusalOf(error)
    if (refusal === undefined) {
      throw error
    }
    context.output.warn(oneLine(refusal))
    process.exitCode = 1
    return undefined
  }
}

// The work of a command with its Bureau, refusable: what it came to, or nothing once a refusal has ended the command
export async function withBureauRefusable<Result>(
  context: Context,
  flags: BureauFlags,
  work: (bureau: Bureau) => Promise<Result>,
): Promise<Result | undefined> {
  const result = await refusable(context, async () => {
    const done = await withBureau(context, flags, work)
    return done
  })
  return result
}
```

`apps/bytebureau/src/commands/run-follow.ts` (as shipped):

```ts
import { m } from '@bytebureau/i18n'
import { decodeEventPayload, type Ask, type EventEnvelope } from '@bytebureau/protocol'
import type { Bureau } from '../bureau/bureau.js'
import type { Context } from '../context.js'
import { describeError } from '../errors.js'
import { promptAsk } from '../render/ask-prompt.js'
import { completionLine, readOrSkip, summarizeRun } from '../render/transcript.js'
import { EXIT_REFUSED, report, show, type Outcome } from './run-output.js'

const EXIT_COMPLETED = 0
const EXIT_STOPPED = 3

// The event of a session that is ready again: it ends the follow of a turn that was interrupted, when no stop or error comes
const READY = 'session.ready'

// The first of them stops the session, and one of another kind after it does nothing; the second of a kind ends the process as it would without the run
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

type Output = Context['output']

// How a follow ends, and what it follows
export interface Ends {
  // The types of the events that end it; a turn that was interrupted ends where the session next says what became of it
  readonly terminal: ReadonlySet<string>
  // Whether the end of the turn completes the session: a run is one turn, a prompt leaves the session ready for the next
  readonly completes: boolean
  // Whether the events of the turn the prompt begins are all it follows: a session that has had turns before has their events too
  readonly turnOnly: boolean
}

// What follows a session: the Bureau it asks, the person it asks for an answer, and how it ends
export interface Following {
  readonly bureau: Bureau
  readonly session: { readonly id: string }
  readonly context: Context
  readonly yes: boolean
  readonly ends: Ends
}

// The events shown, and the one that ended the follow; none when the events ran out first
export interface Followed {
  readonly seen: readonly EventEnvelope[]
  readonly end: EventEnvelope | undefined
}

// An ask nobody can answer is left to the kernel policy; the person is told the session waits
async function answerAsk({ bureau, yes, context }: Following, ask: Ask): Promise<void> {
  const answer = await promptAsk(ask, { yes, interactive: context.interactive })
  if (answer === undefined) {
    context.output.warn(m.run_ask_waiting({ title: ask.title }))
    return
  }
  await bureau.asks.answer(ask.id, answer)
}

// The ask of an ask.requested event, if its payload fits
function askOf(event: EventEnvelope, output: Output): Ask | undefined {
  return readOrSkip(event, output, () => decodeEventPayload('ask.requested', event.payload).ask)
}

// Besides showing an event the CLI answers an ask, and completes the session once its turn is over, where that is its end
async function react(run: Following, event: EventEnvelope): Promise<void> {
  const ask = event.type === 'ask.requested' ? askOf(event, run.context.output) : undefined
  if (ask !== undefined) {
    await answerAsk(run, ask)
  }
  if (event.type === 'turn.completed' && run.ends.completes) {
    await run.bureau.sessions.complete(run.session.id)
  }
}

// An interrupted turn is no end by itself: the session says next what became of it, ready again, stopped or errored
// Whoever interrupted the turn or stopped the session, this process by a signal or another command, the events tell the same
function isEnd({ ends }: Following, event: EventEnvelope, interrupted: boolean): boolean {
  return ends.terminal.has(event.type) || (interrupted && event.type === READY)
}

// The events up to the end of the follow, which is the last one shown
async function follow(run: Following, events: AsyncIterable<EventEnvelope>): Promise<Followed> {
  const seen: EventEnvelope[] = []
  let interrupted = false
  for await (const event of events) {
    seen.push(event)
    show(event, run.context)
    await react(run, event)
    interrupted ||= event.type === 'turn.interrupted'
    if (isEnd(run, event, interrupted)) {
      return { seen, end: event }
    }
  }
  return { seen, end: undefined }
}

// A stop that fails is only reported; the same signal again ends the process
async function stopSession({ bureau, session, context }: Following): Promise<void> {
  try {
    await bureau.sessions.stop(session.id)
  } catch (error) {
    context.output.warn(describeError(error))
  }
}

// Ctrl-C, SIGTERM and SIGHUP stop the session alike, once; the result is a release that removes the listeners and waits for the stop
function stopOnSignals(run: Following): () => Promise<void> {
  let stopping = Promise.resolve()
  let stopped = false
  const stop = (): void => {
    if (!stopped) {
      stopped = true
      stopping = stopSession(run)
    }
  }
  for (const signal of STOP_SIGNALS) {
    process.once(signal, stop)
  }
  return async () => {
    for (const signal of STOP_SIGNALS) {
      process.off(signal, stop)
    }
    await stopping
  }
}

// The events of one turn: those it owns, and those of the session that end a follow, which no turn owns
// A stop or an error from before the turn began is no end of it, so the session's events count only once it has
async function* ofTurn(
  events: AsyncIterable<EventEnvelope>,
  turnId: string,
  terminal: ReadonlySet<string>,
): AsyncGenerator<EventEnvelope> {
  let begun = false
  for await (const event of events) {
    const owned = event.turnId === turnId
    begun ||= owned
    const sessionEnd = terminal.has(event.type) || event.type === READY
    if (owned || (begun && event.turnId === undefined && sessionEnd)) {
      yield event
    }
  }
}

// Prompts the session and follows its events to the end of the follow
// A signal stops the session; the events then say so and the follow ends with the exit code of a stopped one
// The children of the kernel run detached, so the terminal does not reach them: only the stop does
export async function promptAndFollow(run: Following, text: string): Promise<Followed> {
  const { bureau, session, ends } = run
  const subscription = new AbortController()
  const release = stopOnSignals(run)
  try {
    // The ephemeral events (text deltas) carry no seq of their own and no transcript line
    const filter = { sessionId: session.id, since: 0, ephemeral: false }
    const events = bureau.events.subscribe(filter, subscription.signal)
    const turn = await bureau.sessions.prompt(session.id, { text })
    return await follow(run, ends.turnOnly ? ofTurn(events, turn.id, ends.terminal) : events)
  } finally {
    subscription.abort()
    await release()
  }
}

// The reason of an errored session; the type of the event stands in for a payload that cannot be read
function reasonOf(last: EventEnvelope, output: Output): string {
  const reason = readOrSkip(last, output, () => decodeEventPayload('session.errored', last.payload))
  return reason === undefined ? last.type : reason.message
}

// The summary is built only for the words that are printed: JSON output has none
function outcomeOf(end: EventEnvelope, seen: readonly EventEnvelope[], output: Output): Outcome {
  switch (end.type) {
    case 'session.stopped': {
      return { code: EXIT_STOPPED, text: m.run_stopped() }
    }
    case READY: {
      return { code: EXIT_STOPPED, text: m.run_interrupted() }
    }
    case 'session.errored': {
      return { code: EXIT_REFUSED, text: m.run_errored({ message: reasonOf(end, output) }) }
    }
    default: {
      return {
        code: EXIT_COMPLETED,
        text: output.json ? '' : completionLine(summarizeRun(seen, output)),
      }
    }
  }
}

export function conclude({ seen, end }: Followed, context: Context): number {
  if (end === undefined) {
    throw new Error('the events ended before the session did')
  }
  const outcome = outcomeOf(end, seen, context.output)
  report(outcome, context)
  return outcome.code
}
```

`apps/bytebureau/src/render/rows.ts` (as shipped):

```ts
import { m } from '@bytebureau/i18n'
import type { AskRecord, PluginStatusDto, SessionDto } from '@bytebureau/protocol'
import { flat } from './tables.js'

// The rows a listing is told in, for table(): one row to a record, a cell to each of its columns

export const sessionRows = (sessions: readonly SessionDto[]): string[][] =>
  sessions.map((session) => [session.id, session.status, session.title, session.projectId])

// The fields of one session: a label and a value to each; a session that has no worktree yet has a dash
export const sessionFields = (session: SessionDto): string[][] => [
  ['id', session.id],
  ['status', session.status],
  ['title', session.title],
  ['project', session.projectId],
  ['employee', session.employee.id],
  ['provider', session.providerId],
  ['worktree', session.workspace === null ? '-' : session.workspace.path],
  ['created', session.createdAt],
]

// What the agent recommends, as the labels of the recommended options of all the questions
const recommendedOf = (ask: AskRecord): string =>
  ask.questions
    .flatMap((question) =>
      question.options.filter((option) => option.recommended).map((option) => option.label),
    )
    .join(', ')

export const askRows = (asks: readonly AskRecord[]): string[][] =>
  asks.map((ask) => [ask.id, ask.sessionId, ask.title, recommendedOf(ask)])

// The asks that wait for an answer to a session, a line to each: the title of an ask may hold the lines of a command
export const pendingAskLines = (asks: readonly AskRecord[]): string[] =>
  asks.map((ask) => m.sessions_pending_ask({ id: ask.id, title: flat(ask.title) }))

// A plugin that failed to load tells why in place of its ports
export const pluginRows = (plugins: readonly PluginStatusDto[]): string[][] =>
  plugins.map((plugin) => [
    plugin.name,
    plugin.version,
    plugin.state,
    plugin.state === 'failed' ? (plugin.reason ?? '') : plugin.ports.join(','),
  ])
```

`apps/bytebureau/src/testing/frames.ts` (as shipped):

```ts
import { stripVTControlCharacters } from 'node:util'
import { S_BAR_END, S_BAR_START } from '@clack/prompts'

// The lines that begin with the glyph and the two spaces clack puts after it; the ASCII glyphs of TERM=linux turn up inside the words as well (the end of the frame is an em dash)
function linesStartingWith(text: string, glyph: string): number {
  const lines = stripVTControlCharacters(text).split('\n')
  return lines.filter((line) => line.startsWith(`${glyph}  `)).length
}

// How often the frame of a run was opened and closed on the terminal
export function frames(text: string): { readonly starts: number; readonly ends: number } {
  return {
    starts: linesStartingWith(text, S_BAR_START),
    ends: linesStartingWith(text, S_BAR_END),
  }
}
```

`apps/bytebureau/src/testing/session-bench.ts` (as shipped):

```ts
import { setTimeout as sleep } from 'node:timers/promises'
import { startDaemonProcess, type DaemonProcess } from './daemon.js'
import { firstField, firstId, jsonLines, listedUnder } from './json-lines.js'
import { runCli, type CliResult } from './run-cli.js'
import { NO_DAEMON, ON_FAKE, PROMPT, SCRIPTED, sessionIdIn, workbench } from './workbench.js'

export const MISSING = '0192f0a0-0000-7000-8000-000000000009'

// The agent of the fake provider waits on its ask, which the stop of a run leaves unanswered
export const WAITING = '"type":"session.waiting"'

export type Env = Readonly<Record<string, string>>

// The exit code and the line of stderr of a command that is refused
export async function refusal(
  args: readonly string[],
  env: Env,
): Promise<readonly [number, string]> {
  const result = await runCli(args, env)
  return [result.code, result.stderr.trim()]
}

// The turns that the events a command printed belong to
export function turnsOf(stdout: string): readonly unknown[] {
  const turns = jsonLines(stdout)
    .map((record) => record['turnId'])
    .filter((turnId) => turnId !== undefined)
  return [...new Set(turns)]
}

// A daemon for the home of a test, which the test ends gracefully, and a repository to run on
export interface Bench {
  readonly repo: string
  readonly home: string
  readonly env: Env
  readonly daemon: DaemonProcess
}

export type Session = Bench & { readonly id: string }

export async function benchWithDaemon(variables: Env = {}): Promise<Bench> {
  const { repo, home } = workbench()
  const daemon = await startDaemonProcess(home)
  return { repo, home, env: { BYTEBUREAU_HOME: home, ...variables }, daemon }
}

// A run of the fake agent to its end: a completed session
export async function completedSession(): Promise<Session> {
  const bench = await benchWithDaemon()
  await runCli(['run', PROMPT, '--project', bench.repo, ...SCRIPTED], bench.env)
  const id = await sessionIdIn(bench.home, [])
  return { ...bench, id }
}

// A run that its signal stops once it has printed the text: a stopped session, and what the run printed
export async function stoppedSession(
  variables: Env,
  afterStdout: string,
): Promise<Session & { readonly first: CliResult }> {
  const bench = await benchWithDaemon(variables)
  const run = ['run', PROMPT, '--project', bench.repo, ...ON_FAKE, '--json']
  const first = await runCli(run, bench.env, { signal: 'SIGTERM', afterStdout })
  const id = await sessionIdIn(bench.home, [])
  return { ...bench, id, first }
}

export async function resumedSession(): Promise<Session & { readonly first: CliResult }> {
  const stopped = await stoppedSession({}, WAITING)
  await runCli(['sessions', 'resume', stopped.id], stopped.env)
  return stopped
}

// What `sessions show` tells once the session is in the status; the last look when the deadline passes first
export async function untilStatus(
  session: Pick<Session, 'env' | 'id'>,
  status: string,
  deadline = Date.now() + 5000,
): Promise<CliResult> {
  const shown = await runCli(['sessions', 'show', session.id], session.env)
  if (new RegExp(`^status\\s+${status}$`, 'mu').test(shown.stdout) || Date.now() >= deadline) {
    return shown
  }
  await sleep(100)
  return untilStatus(session, status, deadline)
}

// The kernel announces the end of a turn a moment before the session is ready for the next prompt
export async function ready(session: Session): Promise<CliResult> {
  const shown = await untilStatus(session, 'ready')
  return shown
}

// What a turn of the slow script prints once it works, which it does until it is stopped
export const WORKING = '"type":"turn.started"'

// A session of the slow script that was stopped while it worked, and is resumed; the script is kept across the stop
export async function resumedSlowSession(): Promise<Session> {
  const session = await stoppedSession({ BYTEBUREAU_FAKE_SCRIPT: 'slow' }, WORKING)
  await runCli(['sessions', 'resume', session.id], session.env)
  return session
}

// A turn of the slow script that a prompt follows, once the session is at work on it
export async function slowTurn(): Promise<Session & { readonly prompting: Promise<CliResult> }> {
  const session = await resumedSlowSession()
  const prompting = runCli(['sessions', 'prompt', session.id, 'go on', '--json'], session.env)
  await untilStatus(session, 'running')
  return { ...session, prompting }
}

// A prompt, once the session is ready for it, followed to the end of its turn
export async function promptedAgain(session: Session, text: string): Promise<CliResult> {
  await ready(session)
  const prompted = await runCli(
    ['sessions', 'prompt', session.id, text, '--json', '--yes'],
    session.env,
  )
  return prompted
}

// A run in the process of the command that its signal stops while the agent waits on its ask
export async function stoppedInProcess(): Promise<{ readonly env: Env; readonly id: string }> {
  const { repo, home } = workbench()
  const env = { BYTEBUREAU_HOME: home }
  const run = ['run', PROMPT, '--project', repo, ...ON_FAKE, '--json', NO_DAEMON]
  await runCli(run, env, { signal: 'SIGTERM', afterStdout: WAITING })
  const id = await sessionIdIn(home)
  return { env, id }
}

// The stdout of `ask ls --json` once an ask waits; the last one when the deadline passes first
async function asksWaiting(env: Env, deadline: number): Promise<string> {
  const listed = await runCli(['ask', 'ls', '--json'], env)
  if (listedUnder(listed.stdout, 'asks').length > 0 || Date.now() >= deadline) {
    return listed.stdout
  }
  await sleep(200)
  return asksWaiting(env, deadline)
}

// A run that waits on the ask of the fake agent: off a terminal and without --yes it leaves the ask to another command
export interface Waiting {
  readonly env: Env
  readonly daemon: DaemonProcess
  readonly run: Promise<CliResult>
  // What `ask ls --json` told once the ask was there
  readonly listed: string
  // The ask it waits on, and the session it belongs to
  readonly id: string
  readonly sessionId: string
}

// The output of the run is its events as JSON lines unless the flags say otherwise
export async function waitingRun(output: readonly string[] = ['--json']): Promise<Waiting> {
  const { repo, env, daemon } = await benchWithDaemon()
  const run = runCli(['run', PROMPT, '--project', repo, ...ON_FAKE, ...output], env)
  const listed = await asksWaiting(env, Date.now() + 15_000)
  const sessionId = firstField(listed, 'asks', 'sessionId')
  return { env, daemon, run, listed, id: firstId(listed, 'asks'), sessionId }
}

// The ask is answered with --yes, and the run goes on to its end
export async function finished({ env, run, id }: Waiting): Promise<CliResult> {
  await runCli(['ask', 'answer', id, '--yes'], env)
  const result = await run
  return result
}
```

`apps/bytebureau/src/render/rows.test.ts` (as shipped):

```ts
import type { SessionDto } from '@bytebureau/protocol'
import { describe, expect, it } from 'vitest'
import { askOf, option, question } from '../testing/events.js'
import { ASK, SESSION } from '../testing/records.js'
import { askRows, pendingAskLines, pluginRows, sessionFields, sessionRows } from './rows.js'

// A session whose worktree is not made yet: the wire tells it as null, which JSON text keeps out of the CLI sources
function withoutWorktree(session: SessionDto): SessionDto {
  const bare = { ...session }
  Reflect.set(bare, 'workspace', JSON.parse('null'))
  return bare
}

describe(sessionRows, () => {
  it('has the id, the status, the title and the project of every session', () => {
    expect(sessionRows([SESSION])).toStrictEqual([['s1', 'ready', 'Fix the build', 'p1']])
    expect(sessionRows([])).toStrictEqual([])
  })
})

describe(sessionFields, () => {
  it('labels the fields of a session, down to the path of its worktree', () => {
    expect(sessionFields(SESSION)).toStrictEqual([
      ['id', 's1'],
      ['status', 'ready'],
      ['title', 'Fix the build'],
      ['project', 'p1'],
      ['employee', 'developer'],
      ['provider', 'fake'],
      ['worktree', '/repo/.bytebureau/worktrees/s1'],
      ['created', '2026-10-02T12:00:00.000Z'],
    ])
  })

  it('has a dash for the worktree of a session that has none yet', () => {
    const fields = sessionFields(withoutWorktree({ ...SESSION, status: 'created' }))
    expect(fields).toContainEqual(['worktree', '-'])
  })
})

// An ask of the fixtures, with the questions it asks
function asking(...questions: ReturnType<typeof question>[]): typeof ASK {
  return { ...ASK, ...askOf(questions) }
}

describe(askRows, () => {
  it('has the id, the session, the title and the recommended option of every ask', () => {
    const options = [option('a', false), option('b', true)]
    const rows = askRows([asking(question(options))])
    expect(rows).toStrictEqual([['a1', 's1', 'Export style', 'Option b']])
  })

  it('lists the recommended options of every question, and none for an ask that recommends nothing', () => {
    const several = asking(question([option('a', true)]), question([option('b', true)]))
    const none = asking(question([option('a', false)]))
    expect(askRows([several, none])).toStrictEqual([
      ['a1', 's1', 'Export style', 'Option a, Option b'],
      ['a1', 's1', 'Export style', ''],
    ])
  })
})

describe(pluginRows, () => {
  it('has the name, the version, the state and the ports of a plugin, which are joined', () => {
    const loaded = {
      name: 'agent-fake',
      version: '0.1.0',
      state: 'loaded',
      ports: ['a', 'b'],
    } as const
    expect(pluginRows([loaded])).toStrictEqual([['agent-fake', '0.1.0', 'loaded', 'a,b']])
  })

  it('has the reason of a plugin that failed in place of its ports', () => {
    const failed = {
      name: 'broken',
      version: '1.0.0',
      state: 'failed',
      ports: [],
      reason: 'no hostApi',
    } as const
    const nothing = { name: 'odd', version: '1.0.0', state: 'failed', ports: [] } as const
    expect(pluginRows([failed, nothing])).toStrictEqual([
      ['broken', '1.0.0', 'failed', 'no hostApi'],
      ['odd', '1.0.0', 'failed', ''],
    ])
  })
})

describe(pendingAskLines, () => {
  it('tells every ask on a line of its own, and its title on that one line', () => {
    const permission = { ...ASK, id: 'a2', title: 'Run:\n  ls -l\r\n  pwd' }
    expect(pendingAskLines([ASK, permission])).toStrictEqual([
      'Waiting for your answer: Export style (a1)',
      'Waiting for your answer: Run: ls -l pwd (a2)',
    ])
  })
})
```

`apps/bytebureau/src/commands/sessions-prompt.test.ts` (as shipped):

```ts
import { SessionError, WorkspaceError } from '@bytebureau/kernel'
import { describe, expect, it } from 'vitest'
import { askOf, event, inTurn, option, question } from '../testing/events.js'
import { frames } from '../testing/frames.js'
import { problemError } from '../testing/records.js'
import {
  captureConsole,
  captureTerminal,
  contextOf,
  ERRORED,
  rejecting,
  scripted,
  STOPPED,
} from '../testing/scripted-kernel.js'
import { promptSession, type PromptOptions } from './sessions-prompt.js'

const PROMPT: PromptOptions = { id: 's1', text: 'And again', yes: false }

// The scripted Bureau answers a prompt with the turn u1; u0 is the turn before it
const USAGE = { inputTokens: 10, outputTokens: 5 }
const FIRST_TURN = [
  inTurn('u0', event('message.user', { text: 'First' }, 1)),
  inTurn(
    'u0',
    event(
      'turn.completed',
      { turnId: 'u0', index: 0, status: 'completed', stopReason: 'end_turn', usage: USAGE },
      2,
    ),
  ),
]
// A session that was stopped, and resumed, between the turns
const STOP_BETWEEN = [
  event('session.stopped', { status: 'stopped' }, 3),
  event('session.resumed', { status: 'ready' }, 4),
]
const RUNNING = event('session.running', { status: 'running' }, 5)
const ASKED = inTurn('u1', event('message.user', { text: 'And again' }, 6))
const WORKING = inTurn(
  'u1',
  event('turn.started', { turnId: 'u1', index: 1, status: 'running' }, 7),
)
const SAID = inTurn(
  'u1',
  event('message.assistant.completed', { text: 'Fixed it', content: [] }, 8),
)
const DONE = inTurn(
  'u1',
  event(
    'turn.completed',
    { turnId: 'u1', index: 1, status: 'completed', stopReason: 'end_turn', usage: USAGE },
    9,
  ),
)
const INTERRUPTED = inTurn(
  'u1',
  event('turn.interrupted', { turnId: 'u1', index: 1, status: 'interrupted' }, 9),
)
const CRASHED = inTurn(
  'u1',
  event('turn.interrupted', { turnId: 'u1', index: 1, status: 'errored' }, 9),
)

const READY = event('session.ready', { status: 'ready' }, 10)
const CANCELLED = inTurn('u1', event('ask.cancelled', { askId: 'a1' }, 9))

const BEGUN = [RUNNING, ASKED, WORKING]
const HISTORY = [...FIRST_TURN, ...STOP_BETWEEN]

describe(promptSession, () => {
  it('prompts the session and follows its new turn only, which leaves the session ready', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau, calls } = scripted([...HISTORY, ...BEGUN, SAID, DONE])
    await expect(promptSession(bureau, PROMPT, contextOf())).resolves.toBe(0)
    expect(calls).toStrictEqual([
      'subscribe {"sessionId":"s1","since":0,"ephemeral":false}',
      'prompt s1 And again',
    ])
    expect(printed.out()).toStrictEqual([
      'The employee is working…',
      'Fixed it',
      'Done — turns: 1, input tokens: 10, output tokens: 5',
    ])
  })

  it('prints the events of that turn as JSON lines, and nothing of the turns before it', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([...HISTORY, ...BEGUN, SAID, DONE])
    await expect(promptSession(bureau, PROMPT, contextOf(true))).resolves.toBe(0)
    const turn = [ASKED, WORKING, SAID, DONE]
    expect(printed.out()).toStrictEqual(turn.map((each) => JSON.stringify(each)))
    expect(printed.err()).toStrictEqual([])
  })

  it('takes no stop or error of an earlier day for the end of the turn', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const earlier = [...HISTORY, ERRORED, STOPPED]
    const { bureau } = scripted([...earlier, ...BEGUN, DONE])
    await expect(promptSession(bureau, PROMPT, contextOf())).resolves.toBe(0)
    expect(printed.err()).toStrictEqual([])
  })

  it('subscribes with a signal of its own and aborts it once the turn has ended', async () => {
    expect.hasAssertions()
    captureConsole()
    const script = scripted([...BEGUN, DONE])
    await promptSession(script.bureau, PROMPT, contextOf())
    expect(script.signals).toHaveLength(1)
    expect(script.signals[0]).toMatchObject({ aborted: true })
  })
})

describe('promptSession when the turn is interrupted', () => {
  it('exits 3 and says so, once the session is ready again', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([...BEGUN, INTERRUPTED, READY])
    await expect(promptSession(bureau, PROMPT, contextOf())).resolves.toBe(3)
    expect(printed.out()).toStrictEqual(['The employee is working…', 'Turn interrupted'])
  })

  it('does not end at the interrupted turn: what comes before its session says what became of it is shown', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([...BEGUN, INTERRUPTED, CANCELLED, READY])
    await promptSession(bureau, PROMPT, contextOf(true))
    const shown = [ASKED, WORKING, INTERRUPTED, CANCELLED, READY]
    expect(printed.out()).toStrictEqual(shown.map((each) => JSON.stringify(each)))
  })

  it('ends with the stop that follows, as a stop by its own signal or by another command makes it', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([...BEGUN, INTERRUPTED, CANCELLED, STOPPED])
    await expect(promptSession(bureau, PROMPT, contextOf(true))).resolves.toBe(3)
    expect(printed.out().at(-1)).toBe(JSON.stringify(STOPPED))
  })

  it('takes a session that is ready for no end unless a turn was interrupted', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([...BEGUN, READY, DONE])
    await expect(promptSession(bureau, PROMPT, contextOf())).resolves.toBe(0)
    expect(printed.out().at(-1)).toBe('Done — turns: 1, input tokens: 10, output tokens: 5')
  })

  it('fails when the events end with the interrupted turn and no word of its session', async () => {
    expect.hasAssertions()
    captureConsole()
    const { bureau } = scripted([...BEGUN, INTERRUPTED])
    await expect(promptSession(bureau, PROMPT, contextOf())).rejects.toThrow(
      'the events ended before the session did',
    )
  })
})

describe('promptSession when the turn does not complete otherwise', () => {
  it('exits 3 when the session is stopped, which no turn owns', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([...BEGUN, STOPPED])
    await expect(promptSession(bureau, PROMPT, contextOf())).resolves.toBe(3)
    expect(printed.out()).toStrictEqual(['The employee is working…', 'Session stopped'])
  })

  it('exits 4 and says why when the provider failed, once the errored session tells', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([...BEGUN, CRASHED, ERRORED])
    await expect(promptSession(bureau, PROMPT, contextOf())).resolves.toBe(4)
    expect(printed.out()).toStrictEqual(['The employee is working…'])
    expect(printed.err()).toStrictEqual(['The provider failed: the agent died'])
  })

  it('fails when the events end before the turn does', async () => {
    expect.hasAssertions()
    captureConsole()
    const { bureau } = scripted([...BEGUN, SAID])
    await expect(promptSession(bureau, PROMPT, contextOf())).rejects.toThrow(
      'the events ended before the session did',
    )
  })

  it('fails when the events end with a turn that errored and no session to say why', async () => {
    expect.hasAssertions()
    captureConsole()
    const { bureau } = scripted([...BEGUN, CRASHED])
    await expect(promptSession(bureau, PROMPT, contextOf())).rejects.toThrow(
      'the events ended before the session did',
    )
  })
})

describe('promptSession with an ask', () => {
  const ask = askOf([question([option('yes', true)])])
  const asked = inTurn('u1', event('ask.requested', { ask }, 8))

  it('answers it with the recommended option when --yes is given', async () => {
    expect.hasAssertions()
    captureConsole()
    const { bureau, answered } = scripted([...BEGUN, asked, DONE])
    await promptSession(bureau, { ...PROMPT, yes: true }, contextOf())
    expect(answered).toStrictEqual([{ askId: 'a1', answer: { selected: ['yes'] } }])
  })

  it('leaves it to the kernel policy, and says that the session waits, when nobody can answer it', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau, answered } = scripted([...BEGUN, asked, DONE])
    await expect(promptSession(bureau, PROMPT, contextOf())).resolves.toBe(0)
    expect(answered).toStrictEqual([])
    expect(printed.err()).toStrictEqual([
      'The employee is waiting for your answer to "Export style" (not answered automatically)',
    ])
  })
})

describe('promptSession when the request is refused', () => {
  const provider = new SessionError({
    code: 'provider_missing',
    reason: 'provider "claude" is not available; available: fake',
  })
  const worktree = new WorkspaceError({ code: 'git_failed', reason: 'git worktree add failed' })
  const unprompted = new SessionError({
    code: 'invalid_transition',
    reason: 'cannot prompt a completed session',
  })

  it.each([
    ['the kernel refuses the provider', provider],
    ['the kernel refuses the worktree', worktree],
    ['the kernel refuses a prompt that the session cannot take', unprompted],
    [
      'the daemon refuses the worktree',
      problemError(422, 'workspace_git_failed', 'git worktree add failed'),
    ],
    [
      'the daemon refuses the provider',
      problemError(422, 'session_provider_missing', 'provider "claude" is not available'),
    ],
    [
      'the daemon does not know the session',
      problemError(404, 'session_not_found', 'no session s1'),
    ],
  ])('passes the refusal on, to be told by the command, when %s', async (_what, refusal) => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([DONE], { prompt: rejecting(refusal) })
    await expect(promptSession(bureau, PROMPT, contextOf())).rejects.toBe(refusal)
    expect(printed.err()).toStrictEqual([])
  })
})

describe('promptSession at a terminal', () => {
  it.each([
    ['a failure that is no refusal', new Error('the store is gone')],
    ['a refusal', new SessionError({ code: 'not_found', reason: 'session s1 does not exist' })],
  ])('closes the frame it opened, and lets %s go on', async (_what, failure) => {
    expect.hasAssertions()
    captureConsole()
    const written = captureTerminal()
    const { bureau } = scripted([DONE], { prompt: rejecting(failure) })
    await expect(promptSession(bureau, PROMPT, contextOf(false, true))).rejects.toBe(failure)
    expect(frames(written())).toStrictEqual({ starts: 1, ends: 1 })
  })
})
```

`apps/bytebureau/src/commands/sessions-prompt-daemon.test.ts` (as shipped):

```ts
import { describe, expect, it } from 'vitest'
import { jsonLines } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import {
  promptedAgain,
  ready,
  resumedSession,
  resumedSlowSession,
  slowTurn,
  stoppedInProcess,
  stoppedSession,
  turnsOf,
  WAITING,
  WORKING,
} from '../testing/session-bench.js'
import { NO_DAEMON } from '../testing/workbench.js'

describe('bytebureau sessions resume and prompt through the daemon', () => {
  it('resumes a stopped session', async () => {
    expect.hasAssertions()
    const session = await stoppedSession({}, WAITING)
    const stopped = await runCli(['sessions', 'show', session.id], session.env)
    const resumed = await runCli(['sessions', 'resume', session.id], session.env)
    const shown = await ready(session)
    expect(stopped.stdout).toMatch(/^status\s+stopped$/mu)
    expect([resumed.code, resumed.stdout.trim()]).toStrictEqual([0, `Resumed ${session.id}`])
    expect(shown.stdout).toMatch(/^status\s+ready$/mu)
    await session.daemon.stop()
  })

  it('prompts it again, to the end of the new turn', async () => {
    expect.hasAssertions()
    const session = await resumedSession()
    const prompted = await promptedAgain(session, 'again')
    expect([prompted.code, jsonLines(prompted.stdout).at(-1)]).toMatchObject([
      0,
      { type: 'turn.completed' },
    ])
    await session.daemon.stop()
  })

  it('follows the new turn only: nothing of the turn before it, nor of the stop', async () => {
    expect.hasAssertions()
    const session = await resumedSession()
    const prompted = await promptedAgain(session, 'again')
    const types = jsonLines(prompted.stdout).map((record) => record['type'])
    expect(types).toStrictEqual(expect.arrayContaining(['ask.requested', 'ask.answered']))
    expect(types).not.toContain('session.stopped')
    expect(turnsOf(prompted.stdout)).toHaveLength(1)
    expect(turnsOf(prompted.stdout)).not.toStrictEqual(turnsOf(session.first.stdout))
    await session.daemon.stop()
  })

  it('leaves the session ready, for any number of prompts, until it is stopped', async () => {
    expect.hasAssertions()
    const session = await resumedSession()
    const second = await promptedAgain(session, 'again')
    const third = await promptedAgain(session, 'once more')
    const shown = await ready(session)
    const turns = [session.first, second, third].flatMap((result) => turnsOf(result.stdout))
    expect([second.code, third.code]).toStrictEqual([0, 0])
    expect(shown.stdout).toMatch(/^status\s+ready$/mu)
    expect(new Set(turns).size).toBe(3)
    await session.daemon.stop()
  })
})

describe('bytebureau sessions prompt and a signal', () => {
  it('stops the session on SIGTERM while it follows a prompt, and exits 3 at the stop', async () => {
    expect.hasAssertions()
    const session = await resumedSlowSession()
    const prompt = ['sessions', 'prompt', session.id, 'go on', '--json']
    const prompted = await runCli(prompt, session.env, { signal: 'SIGTERM', afterStdout: WORKING })
    const shown = await runCli(['sessions', 'show', session.id], session.env)
    const types = jsonLines(prompted.stdout).map((record) => record['type'])
    expect([prompted.code, types.at(-1)]).toStrictEqual([3, 'session.stopped'])
    expect(types).toContain('turn.interrupted')
    expect(shown.stdout).toMatch(/^status\s+stopped$/mu)
    await session.daemon.stop()
  })

  it('ends with exit code 3 when the turn it follows is interrupted, and the session is ready again', async () => {
    expect.hasAssertions()
    const slow = await slowTurn()
    const interrupted = await runCli(['sessions', 'interrupt', slow.id], slow.env)
    const prompted = await slow.prompting
    const shown = await ready(slow)
    expect([interrupted.code, interrupted.stdout.trim()]).toStrictEqual([
      0,
      `Interrupted ${slow.id}`,
    ])
    const types = jsonLines(prompted.stdout).map((record) => record['type'])
    expect([prompted.code, types.slice(-2)]).toStrictEqual([
      3,
      ['turn.interrupted', 'session.ready'],
    ])
    expect(shown.stdout).toMatch(/^status\s+ready$/mu)
    await slow.daemon.stop()
  })

  it('stops a session that is ready, and tells it in one line', async () => {
    expect.hasAssertions()
    const session = await resumedSession()
    await ready(session)
    const stopped = await runCli(['sessions', 'stop', session.id], session.env)
    const shown = await runCli(['sessions', 'show', session.id], session.env)
    expect([stopped.code, stopped.stdout.trim()]).toStrictEqual([0, `Stopped ${session.id}`])
    expect(shown.stdout).toMatch(/^status\s+stopped$/mu)
    await session.daemon.stop()
  })
})

describe('bytebureau sessions resume and prompt in the process of the command', () => {
  it('resumes a stopped session', async () => {
    expect.hasAssertions()
    const { env, id } = await stoppedInProcess()
    const resumed = await runCli(['sessions', 'resume', id, NO_DAEMON], env)
    const shown = await runCli(['sessions', 'show', id, NO_DAEMON], env)
    expect([resumed.code, resumed.stdout.trim()]).toStrictEqual([0, `Resumed ${id}`])
    expect(shown.stdout).toMatch(/^status\s+ready$/mu)
  })

  it('prompts a resumed session, and follows the turn to its end', async () => {
    expect.hasAssertions()
    const { env, id } = await stoppedInProcess()
    await runCli(['sessions', 'resume', id, NO_DAEMON], env)
    const prompt = ['sessions', 'prompt', id, 'again', '--json', '--yes', NO_DAEMON]
    const prompted = await runCli(prompt, env)
    expect([prompted.code, jsonLines(prompted.stdout).at(-1)]).toMatchObject([
      0,
      { type: 'turn.completed' },
    ])
  })
})
```

`apps/bytebureau/src/commands/ask-answer.test.ts` (as shipped):

```ts
import type { AskRecord } from '@bytebureau/protocol'
import { CANCEL_SYMBOL } from '@clack/prompts'
import { describe, expect, it } from 'vitest'
import type { Prompts } from '../render/ask-prompt.js'
import { askOf, option, question } from '../testing/events.js'
import { ASK } from '../testing/records.js'
import { captureConsole, contextOf, keepExitCode, scripted } from '../testing/scripted-kernel.js'
import { createContext } from '../context.js'
import { answerAsk, answerOf, optionsOf, type Answering } from './ask-answer.js'

describe(optionsOf, () => {
  it('reads every --option, spelled apart from its id or with an equals sign', () => {
    expect(
      optionsOf(['a1', '--option', 'yes', '--yes', '--option=default', '--option', 'x']),
    ).toStrictEqual(['yes', 'default', 'x'])
  })

  it('finds none when none is given, and none after --', () => {
    expect(optionsOf(['a1', '--other', 'words'])).toStrictEqual([])
    expect(optionsOf(['a1', '--', '--option', 'yes'])).toStrictEqual([])
  })

  it('keeps an id that begins with a dash, and leaves out an --option with no id after it', () => {
    expect(optionsOf(['--option', '-1', '--option'])).toStrictEqual(['-1'])
  })
})

const RECOMMENDED = { ...ASK, ...askOf([question([option('yes', true), option('no', false)])]) }
const UNRECOMMENDED = { ...ASK, ...askOf([question([option('a', false)])], 'none') }

describe(answerOf, () => {
  const nothing = { options: [], other: undefined, yes: false }

  it('answers with the options the flags name', async () => {
    expect.hasAssertions()
    const flags = { ...nothing, options: ['no', 'yes'] }
    await expect(answerOf(flags, RECOMMENDED, contextOf())).resolves.toStrictEqual({
      selected: ['no', 'yes'],
    })
  })

  it('answers with the words of the person, over any option', async () => {
    expect.hasAssertions()
    const flags = { options: ['yes'], other: 'A barrel file', yes: false }
    await expect(answerOf(flags, RECOMMENDED, contextOf())).resolves.toStrictEqual({
      selected: 'other',
      otherText: 'A barrel file',
    })
  })

  it('takes no empty words for an answer', async () => {
    expect.hasAssertions()
    const flags = { ...nothing, other: '' }
    await expect(answerOf(flags, RECOMMENDED, contextOf())).resolves.toBeUndefined()
  })

  it('picks the recommended option for --yes, off a terminal as well', async () => {
    expect.hasAssertions()
    const flags = { ...nothing, yes: true }
    await expect(answerOf(flags, RECOMMENDED, contextOf())).resolves.toStrictEqual({
      selected: ['yes'],
    })
  })

  it('has no answer for an ask nobody can answer: no flag, no terminal, nothing recommended', async () => {
    expect.hasAssertions()
    await expect(answerOf(nothing, RECOMMENDED, contextOf())).resolves.toBeUndefined()
    await expect(
      answerOf({ ...nothing, yes: true }, UNRECOMMENDED, contextOf()),
    ).resolves.toBeUndefined()
  })
})

// A person at a terminal who cancels whatever they are asked, as with Ctrl-C
const CANCELLING: Prompts = {
  select: async () => {
    await Promise.resolve()
    return CANCEL_SYMBOL
  },
  text: async () => {
    await Promise.resolve()
    return CANCEL_SYMBOL
  },
}

// A person at a terminal who picks the option of the id
const picking = (id: string): Prompts => ({
  select: async () => {
    await Promise.resolve()
    return id
  },
  text: CANCELLING.text,
})

const AT_A_TERMINAL = contextOf(false, true)

describe('answerOf with a person at a terminal', () => {
  const nothing = { options: [], other: undefined, yes: false }

  it('answers with what the person picks', async () => {
    expect.hasAssertions()
    const flags = { ...nothing, prompts: picking('no') }
    await expect(answerOf(flags, RECOMMENDED, AT_A_TERMINAL)).resolves.toStrictEqual({
      selected: ['no'],
    })
  })

  it('tells that the person cancelled the prompt, which asked them and got no answer', async () => {
    expect.hasAssertions()
    const flags = { ...nothing, prompts: CANCELLING }
    await expect(answerOf(flags, RECOMMENDED, AT_A_TERMINAL)).resolves.toBe('cancelled')
  })

  it('has no cancel to tell for --yes, which asks nobody: an ask with no recommendation has no answer', async () => {
    expect.hasAssertions()
    const flags = { ...nothing, yes: true, prompts: CANCELLING }
    await expect(answerOf(flags, UNRECOMMENDED, AT_A_TERMINAL)).resolves.toBeUndefined()
  })
})

const PENDING: AskRecord = { ...RECOMMENDED, id: 'a1' }
const REQUEST: Answering = { id: 'a1', options: [], other: undefined, yes: false }

// An ask that the kernel holds, or none
const holding = (ask: AskRecord | undefined) => async (): Promise<AskRecord | undefined> => {
  await Promise.resolve()
  return ask
}

describe(answerAsk, () => {
  it('answers the ask with the flags, and tells so', async () => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    const { bureau, answered } = scripted([], { getAsk: holding(PENDING) })
    await answerAsk(bureau, { ...REQUEST, options: ['yes'] }, contextOf())
    expect(answered).toStrictEqual([{ askId: 'a1', answer: { selected: ['yes'] } }])
    expect([printed.out(), printed.err(), process.exitCode]).toStrictEqual([
      ['Answered a1'],
      [],
      undefined,
    ])
  })

  it('ends a prompt that the person cancelled with exit code 1 and no line, and answers nothing', async () => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    const { bureau, answered } = scripted([], { getAsk: holding(PENDING) })
    await answerAsk(bureau, { ...REQUEST, prompts: CANCELLING }, AT_A_TERMINAL)
    expect([answered, printed.out(), printed.err()]).toStrictEqual([[], [], []])
    expect(process.exitCode).toBe(1)
  })
})

describe('answerAsk with --yes on an ask that recommends nothing', () => {
  const unrecommended: AskRecord = {
    ...PENDING,
    ...askOf([question([option('a', false)])], 'none'),
  }

  it.each([
    ['off a terminal', contextOf()],
    ['at a terminal, where nobody is asked for it', AT_A_TERMINAL],
  ])('refuses with its own line, %s', async (_where, context) => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    const { bureau, answered } = scripted([], { getAsk: holding(unrecommended) })
    await answerAsk(bureau, { ...REQUEST, yes: true, prompts: CANCELLING }, context)
    expect([answered, process.exitCode]).toStrictEqual([[], 1])
    expect(printed.err()).toStrictEqual([
      'Ask a1 has no recommended option; pass --option or --other',
    ])
  })
})

describe('answerAsk in Czech', () => {
  it('tells that an ask recommends nothing, and what to pass, in the words of the language', async () => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    const czech = createContext({ json: false, color: false, yes: true, lang: 'cs' }, {}, false)
    const unrecommended: AskRecord = {
      ...PENDING,
      ...askOf([question([option('a', false)])], 'none'),
    }
    const { bureau } = scripted([], { getAsk: holding(unrecommended) })
    await answerAsk(bureau, { ...REQUEST, yes: true }, czech)
    expect(printed.err()).toStrictEqual([
      'Otázka a1 nemá doporučenou volbu; zadejte --option nebo --other',
    ])
  })
})

describe('answerAsk when there is no answer', () => {
  it('refuses when there is nobody to ask and nothing in the flags', async () => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    const { bureau, answered } = scripted([], { getAsk: holding(PENDING) })
    await answerAsk(bureau, REQUEST, contextOf())
    expect([answered, process.exitCode]).toStrictEqual([[], 1])
    expect(printed.err()).toStrictEqual(['Ask a1 needs --option or --other outside a terminal'])
  })

  it.each([
    ['an ask that is not there', undefined],
    ['an ask that is answered already', { ...PENDING, status: 'answered' } as const],
  ])('refuses %s', async (_what, held) => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    const { bureau, answered } = scripted([], { getAsk: holding(held) })
    await answerAsk(bureau, { ...REQUEST, yes: true }, contextOf())
    expect([answered, process.exitCode]).toStrictEqual([[], 1])
    expect(printed.err()).toStrictEqual(['Ask a1 is not pending'])
  })

  it('tells the answer as a JSON record when the output is machine-readable', async () => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    const { bureau } = scripted([], { getAsk: holding(PENDING) })
    await answerAsk(bureau, { ...REQUEST, other: 'A barrel file' }, contextOf(true))
    const answer = { selected: 'other', otherText: 'A barrel file' }
    expect(printed.out()).toStrictEqual([
      JSON.stringify({ command: 'ask.answer', id: 'a1', answer }),
    ])
  })
})
```

`apps/bytebureau/src/commands/refusable.test.ts` (as shipped):

```ts
import { ApiError } from '@bytebureau/client'
import {
  AskError,
  ConfigError,
  ProviderError,
  SessionError,
  StoreError,
  WorkspaceError,
} from '@bytebureau/kernel'
import { describe, expect, it } from 'vitest'
import type { Bureau } from '../bureau/bureau.js'
import { createContext, type Context } from '../context.js'
import { projectsStub, refusingStub } from '../testing/health-stub.js'
import { problemError } from '../testing/records.js'
import { captureConsole, contextOf, keepExitCode, rejecting } from '../testing/scripted-kernel.js'
import { testHome } from '../testing/temp-repo.js'
import { refusable, withBureauRefusable } from './refusable.js'

const succeeding = async (): Promise<string> => {
  await Promise.resolve()
  return 'done'
}

describe(refusable, () => {
  it('gives the result of the work and says nothing when it succeeds', async () => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    await expect(refusable(contextOf(), succeeding)).resolves.toBe('done')
    expect([printed.out(), printed.err(), process.exitCode]).toStrictEqual([[], [], undefined])
  })

  it.each([
    [404, 'session_not_found', 'session s1 is not running'],
    [409, 'session_invalid_transition', 'cannot stop a completed session'],
    [422, 'ask_invalid_answer', 'ask a1 has no option nope'],
  ])('tells the detail of a %d problem and ends with exit code 1', async (status, code, detail) => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    const work = rejecting(problemError(status, code, detail))
    await expect(refusable(contextOf(), work)).resolves.toBeUndefined()
    expect([printed.err(), printed.out(), process.exitCode]).toStrictEqual([[detail], [], 1])
  })

  it('tells the refusal as a JSON record on stderr when the output is machine-readable', async () => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    await refusable(contextOf(true), rejecting(problemError(409, 'x', 'it is taken')))
    expect(printed.err()).toStrictEqual([JSON.stringify({ level: 'warn', message: 'it is taken' })])
  })
})

describe('refusable and the kernel in the process of the command', () => {
  it.each([
    [
      'a session',
      new SessionError({ code: 'invalid_transition', reason: 'cannot prompt a completed session' }),
    ],
    ['an ask', new AskError({ code: 'not_pending', reason: 'ask a1 is answered' })],
    [
      'a provider that is missing',
      new ProviderError({
        kind: 'missing',
        reason: 'provider "claude" is not available; available: fake',
        retryable: false,
      }),
    ],
    [
      'a workspace',
      new WorkspaceError({ code: 'has_sessions', reason: 'project repo still has 1 session' }),
    ],
  ])(
    'tells the reason of the kernel refusing %s, and ends with exit code 1',
    async (_what, refusal) => {
      expect.hasAssertions()
      keepExitCode()
      const printed = captureConsole()
      await expect(refusable(contextOf(), rejecting(refusal))).resolves.toBeUndefined()
      expect([printed.err(), process.exitCode]).toStrictEqual([[refusal.reason], 1])
    },
  )
})

describe('refusable and what the kernel says in its own way', () => {
  it('tells an invalid configuration as the daemon does: the file and the pointer, then the reason', async () => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    const invalid = new ConfigError({
      file: 'bytebureau.json',
      pointer: '/employees/developer',
      reason: 'provider is required',
    })
    await expect(refusable(contextOf(), rejecting(invalid))).resolves.toBeUndefined()
    expect(printed.err()).toStrictEqual([
      'bytebureau.json/employees/developer: provider is required',
    ])
    expect(process.exitCode).toBe(1)
  })

  it('tells a reason that spans lines as one line', async () => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    const git = new WorkspaceError({
      code: 'git_failed',
      reason: 'git failed\nhint: commit first\n',
    })
    await refusable(contextOf(), rejecting(git))
    expect(printed.err()).toStrictEqual(['git failed; hint: commit first'])
  })
})

describe('refusable and the failures that are no refusal', () => {
  it.each([
    [
      'a problem of the daemon that is its own failure',
      problemError(500, 'internal', 'unexpected'),
    ],
    ['a provider that failed behind the daemon', problemError(502, 'provider_crash', 'it exited')],
    ['a daemon that cannot be reached', new ApiError(0, undefined, 'http://127.0.0.1:9/api/v1/x')],
    [
      'an answer that is no problem',
      new ApiError(404, undefined, 'http://127.0.0.1:4747/api/v1/x'),
    ],
    [
      'a provider that crashed',
      new ProviderError({ kind: 'crash', reason: 'it', retryable: true }),
    ],
    [
      'a provider that is not logged in',
      new ProviderError({ kind: 'auth', reason: 'it', retryable: false }),
    ],
    ['the store of the kernel', new StoreError({ cause: new Error('disk full') })],
    ['any other error', new Error('boom')],
  ])('passes %s on and leaves the exit code alone', async (_what, failure) => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    await expect(refusable(contextOf(), rejecting(failure))).rejects.toBe(failure)
    expect([printed.err(), process.exitCode]).toStrictEqual([[], undefined])
  })
})

// The context of a command on the home: never the home of the person who runs the tests
const contextIn = (home: string): Context =>
  createContext({ json: false, color: false, yes: false }, { BYTEBUREAU_HOME: home }, false)

const projectsOf = async (bureau: Bureau): Promise<unknown> => {
  const projects = await bureau.projects.list()
  return projects
}

describe(withBureauRefusable, () => {
  it('opens the Bureau of the flags for the work, and gives what the work gives', async () => {
    expect.hasAssertions()
    const stub = await projectsStub()
    const flags = { daemon: true, host: '127.0.0.1', port: stub.port }
    const context = contextIn(testHome())
    await expect(withBureauRefusable(context, flags, projectsOf)).resolves.toStrictEqual([])
  })

  it('tells the problem the daemon refuses the request of the work with, and ends with exit code 1', async () => {
    expect.hasAssertions()
    keepExitCode()
    const port = await refusingStub(409, 'project_locked', 'the project is locked')
    const printed = captureConsole()
    const flags = { daemon: true, host: '127.0.0.1', port }
    const result = await withBureauRefusable(contextIn(testHome()), flags, projectsOf)
    expect([result, printed.err(), process.exitCode]).toStrictEqual([
      undefined,
      ['the project is locked'],
      1,
    ])
  })
})
```

`apps/bytebureau/src/commands/refusals.test.ts` (as shipped):

```ts
import { describe, expect, it } from 'vitest'
import { refusingStub } from '../testing/health-stub.js'
import { runCli } from '../testing/run-cli.js'
import { testHome } from '../testing/temp-repo.js'

// Every command that talks to a daemon, run aside: it has exit codes of its own
const COMMANDS: readonly (readonly [string, readonly string[]])[] = [
  ['projects ls', ['projects', 'ls']],
  ['projects add', ['projects', 'add', 'somewhere']],
  ['projects rm', ['projects', 'rm', 'p1']],
  ['workspaces ls', ['workspaces', 'ls']],
  ['workspaces prune', ['workspaces', 'prune']],
  ['sessions ls', ['sessions', 'ls']],
  ['sessions show', ['sessions', 'show', 's1']],
  ['sessions interrupt', ['sessions', 'interrupt', 's1']],
  ['sessions stop', ['sessions', 'stop', 's1']],
  ['sessions resume', ['sessions', 'resume', 's1']],
  ['sessions prompt', ['sessions', 'prompt', 's1', 'go']],
  ['ask ls', ['ask', 'ls']],
  ['ask answer', ['ask', 'answer', 'a1', '--yes']],
  ['plugins ls', ['plugins', 'ls']],
  ['the bare status', []],
]

describe('a request that the daemon refuses with a 4xx problem', () => {
  it.each(COMMANDS)(
    'ends %s with exit code 1 and the detail of the problem',
    async (_name, command) => {
      expect.hasAssertions()
      const port = await refusingStub(409, 'locked', 'the daemon says no')
      const daemon = ['--host', '127.0.0.1', '--port', String(port)]
      const refused = await runCli([...command, ...daemon], { BYTEBUREAU_HOME: testHome() })
      expect([refused.code, refused.stderr.trim()]).toStrictEqual([1, 'the daemon says no'])
    },
  )
})

// The problems that a run ends with exit code 4: the exit code of a prompt of an existing session is 1 for them, as for any other command
const RUN_REFUSALS = [
  ['workspace_git_failed', 'git worktree add failed'],
  ['session_provider_missing', 'provider "claude" is not available'],
  ['provider_missing', 'provider "claude" is not available'],
] as const

describe('a request that the daemon refuses with a problem that a run ends with exit code 4', () => {
  it.each(RUN_REFUSALS)(
    'ends sessions prompt with exit code 1 and the detail for %s',
    async (code, detail) => {
      expect.hasAssertions()
      const port = await refusingStub(422, code, detail)
      const command = [
        'sessions',
        'prompt',
        's1',
        'go',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
      ]
      const refused = await runCli(command, { BYTEBUREAU_HOME: testHome() })
      expect([refused.code, refused.stderr.trim()]).toStrictEqual([1, detail])
    },
  )

  it.each(RUN_REFUSALS)(
    'still ends run with exit code 4, which is its own contract, for %s',
    async (code, detail) => {
      expect.hasAssertions()
      const port = await refusingStub(422, code, detail)
      const command = [
        'run',
        'go',
        '--project',
        '/somewhere',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
      ]
      const refused = await runCli(command, { BYTEBUREAU_HOME: testHome() })
      expect([refused.code, refused.stderr.trim()]).toStrictEqual([4, `${detail} (${code})`])
    },
  )
})
```

`apps/bytebureau/src/commands/run-daemon-stops.test.ts` (as shipped):

```ts
import { describe, expect, it } from 'vitest'
import { jsonLines } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import { untilStatus, waitingRun } from '../testing/session-bench.js'

// The last line a command printed
function lastLine(stdout: string): string | undefined {
  return stdout.trim().split('\n').at(-1)
}

describe('bytebureau run when another command interrupts its turn', () => {
  it('ends with exit code 3 and the line that the turn was interrupted, and the session is ready', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun([])
    const { env, sessionId } = waiting
    const interrupted = await runCli(['sessions', 'interrupt', sessionId], env)
    const run = await waiting.run
    const shown = await untilStatus({ env, id: sessionId }, 'ready')
    expect([interrupted.code, interrupted.stdout.trim()]).toStrictEqual([
      0,
      `Interrupted ${sessionId}`,
    ])
    expect([run.code, lastLine(run.stdout)]).toStrictEqual([3, 'Turn interrupted'])
    expect(shown.stdout).toMatch(/^status\s+ready$/mu)
    await waiting.daemon.stop()
  })

  it('leaves the session ready in the listing as well, for another prompt', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun([])
    const { env, sessionId } = waiting
    await runCli(['sessions', 'interrupt', sessionId], env)
    await waiting.run
    await untilStatus({ env, id: sessionId }, 'ready')
    const listed = await runCli(['sessions', 'ls'], env)
    expect(listed.stdout.trim().split('  ').slice(0, 2)).toStrictEqual([sessionId, 'ready'])
    await waiting.daemon.stop()
  })
})

describe('bytebureau sessions interrupt, stop and resume in Czech', () => {
  it('tells that the turn is interrupted with the verb of the action', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun([])
    const { env, sessionId } = waiting
    const interrupted = await runCli(['sessions', 'interrupt', sessionId, '--lang', 'cs'], env)
    await waiting.run
    expect(interrupted.stdout.trim()).toBe(`Přerušeno: ${sessionId}`)
    await waiting.daemon.stop()
  })

  it('tells that the session is stopped, and that it is resumed', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun([])
    const { env, sessionId } = waiting
    const stopped = await runCli(['sessions', 'stop', sessionId, '--lang', 'cs'], env)
    await waiting.run
    const resumed = await runCli(['sessions', 'resume', sessionId, '--lang', 'cs'], env)
    expect(stopped.stdout.trim()).toBe(`Zastaveno: ${sessionId}`)
    expect(resumed.stdout.trim()).toBe(`Obnoveno: ${sessionId}`)
    await waiting.daemon.stop()
  })
})

describe('bytebureau run when another command stops its session', () => {
  it('ends with exit code 3 and the line that the session was stopped', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun([])
    const { env, sessionId } = waiting
    const stopped = await runCli(['sessions', 'stop', sessionId], env)
    const run = await waiting.run
    expect([stopped.code, stopped.stdout.trim()]).toStrictEqual([0, `Stopped ${sessionId}`])
    expect([run.code, lastLine(run.stdout)]).toStrictEqual([3, 'Session stopped'])
    await waiting.daemon.stop()
  })

  it('ends with the stop in its events as well, as JSON lines', async () => {
    expect.hasAssertions()
    const waiting = await waitingRun()
    await runCli(['sessions', 'stop', waiting.sessionId], waiting.env)
    const run = await waiting.run
    const types = jsonLines(run.stdout).map((record) => record['type'])
    expect(run.code).toBe(3)
    expect(types.slice(-3)).toStrictEqual(['turn.interrupted', 'ask.cancelled', 'session.stopped'])
    await waiting.daemon.stop()
  })
})
```

`apps/bytebureau/src/commands/run-session-interrupted.test.ts` (as shipped):

```ts
import { describe, expect, it } from 'vitest'
import {
  captureConsole,
  COMPLETED,
  contextOf,
  OPTIONS,
  READY,
  scripted,
  STOPPED,
  TURN_DONE,
  TURN_INTERRUPTED,
} from '../testing/scripted-kernel.js'
import { runSession } from './run-session.js'

describe('runSession when another command interrupts the turn', () => {
  it('exits 3 and says that the turn was interrupted, once the session is ready again', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau, calls } = scripted([TURN_INTERRUPTED, READY])
    await expect(runSession(bureau, OPTIONS, contextOf())).resolves.toBe(3)
    expect(printed.out()).toStrictEqual(['Turn interrupted'])
    expect(calls).not.toContain('complete s1')
  })

  it('does not end at the interrupted turn: the events that come before its session says what became of it are shown', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([TURN_INTERRUPTED, READY])
    await runSession(bureau, OPTIONS, contextOf(true))
    expect(printed.out()).toStrictEqual([JSON.stringify(TURN_INTERRUPTED), JSON.stringify(READY)])
  })

  it('fails when the events end with the interrupted turn and no word of its session', async () => {
    expect.hasAssertions()
    captureConsole()
    const { bureau } = scripted([TURN_INTERRUPTED])
    await expect(runSession(bureau, OPTIONS, contextOf())).rejects.toThrow(
      'the events ended before the session did',
    )
  })
})

describe('runSession when the session is stopped after an interrupted turn', () => {
  it('ends with the stop, as a stop by its own signal or by another command makes it', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([TURN_INTERRUPTED, STOPPED])
    await expect(runSession(bureau, OPTIONS, contextOf())).resolves.toBe(3)
    expect(printed.out()).toStrictEqual(['Session stopped'])
  })

  it('takes a session that is ready for no end of the run, unless a turn was interrupted', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const { bureau } = scripted([READY, TURN_DONE, READY, COMPLETED])
    await expect(runSession(bureau, OPTIONS, contextOf())).resolves.toBe(0)
    expect(printed.out()).toStrictEqual(['Done — turns: 1, input tokens: 10, output tokens: 5'])
  })
})
```

`apps/bytebureau/src/run-arguments.test.ts` (as shipped):

```ts
import type { CommandDef } from 'citty'
import { describe, expect, it } from 'vitest'
import { flagsAtLeaf, subCommandIndex } from './run.js'
import { tree } from './testing/command-tree.js'

const FLAGS = {
  json: { type: 'boolean' },
  lang: { type: 'string' },
  'log-level': { type: 'string' },
  mode: { type: 'string', alias: 'm' },
} as const

// The arguments of a line, which has no argument with a space in it
function words(line: string): string[] {
  return line === '' ? [] : line.split(' ')
}

describe(subCommandIndex, () => {
  it.each([
    [[], -1],
    [['--json'], -1],
    [['hello'], 0],
    [['--json', 'hello'], 1],
    [['--lang', 'cs', 'hello'], 2],
    [['--lang=cs', 'hello'], 1],
    [['--log-level', 'debug', 'hello'], 2],
    [['--logLevel', 'debug', 'hello'], 2],
    [['-m', 'fast', 'hello'], 2],
    [['--unknown', 'hello'], 1],
    [['--json', '--', 'hello'], -1],
    [['--lang'], -1],
  ])('finds the sub-command as citty does, in %j at %d', (argv, index) => {
    expect(subCommandIndex(argv, FLAGS)).toBe(index)
  })
})

describe(flagsAtLeaf, () => {
  it.each([
    ['', ''],
    ['--json', '--json'],
    ['hello', 'hello'],
    ['hello Ondřej --json', 'hello Ondřej --json'],
    ['--json hello', 'hello --json'],
    ['--lang cs hello --lang en', 'hello --lang cs --lang en'],
    ['projects --json ls', 'projects ls --json'],
    ['--json projects --lang cs ls x', 'projects ls --json --lang cs x'],
    ['projects --host H --port P ls', 'projects ls --host H --port P'],
    ['--json ask answer a1 --other', 'ask answer --json a1 --other'],
    ['projects', 'projects'],
    ['--json projects', 'projects --json'],
    ['--json nope', 'nope --json'],
    ['projects --lang cs nope', 'projects nope --lang cs'],
  ])('puts the flags of "%s" right behind the last name: "%s"', async (given, expected) => {
    expect.hasAssertions()
    await expect(flagsAtLeaf(tree().command, words(given))).resolves.toStrictEqual(words(expected))
  })
})

// A tree that gives its args, its sub-commands and its leaf lazily, as citty allows
function lazyTree(): CommandDef {
  const ls: CommandDef = { meta: { name: 'ls' }, args: { json: { type: 'boolean' } } }
  const group: CommandDef = { meta: { name: 'group' }, subCommands: () => ({ ls: () => ls }) }
  return {
    meta: { name: 'bb' },
    args: () => ({ lang: { type: 'string' } }),
    subCommands: () => ({ group }),
  }
}

describe('flagsAtLeaf and a tree given lazily', () => {
  it('walks the args and the sub-commands that are given as functions', async () => {
    expect.hasAssertions()
    const argv = words('--lang cs group --json ls x')
    await expect(flagsAtLeaf(lazyTree(), argv)).resolves.toStrictEqual(
      words('group ls --lang cs --json x'),
    )
  })
})

describe('flagsAtLeaf and a --', () => {
  it.each([
    ['--json -- hello', '--json -- hello'],
    ['hello -- --json', 'hello -- --json'],
    ['--json hello -- --lang cs', 'hello --json -- --lang cs'],
    ['projects -- ls', 'projects -- ls'],
    ['--json projects -- ls', 'projects --json -- ls'],
  ])(
    'moves nothing from behind a -- and reads no name there: "%s" into "%s"',
    async (given, expected) => {
      expect.hasAssertions()
      await expect(flagsAtLeaf(tree().command, words(given))).resolves.toStrictEqual(
        words(expected),
      )
    },
  )
})
```

`apps/bytebureau/src/run-flags.test.ts` (as shipped):

```ts
import { describe, expect, it, vi } from 'vitest'
import { run } from './run.js'
import { tree } from './testing/command-tree.js'

describe('run with a global flag before a command, at any level of the tree', () => {
  it('hands a flag before the sub-command to the sub-command, which parses its flags', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await expect(run(command, ['--json', 'projects', 'ls'])).resolves.toBe(0)
    expect(given).toMatchObject([{ command: 'ls', json: true, rawArgs: ['--json'] }])
  })

  it('hands a flag between a group and its leaf on to the leaf', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await expect(run(command, ['projects', '--json', 'ls'])).resolves.toBe(0)
    expect(given).toMatchObject([{ command: 'ls', json: true, rawArgs: ['--json'] }])
  })

  it('skips the values of the flags that take one to find the leaf, and hands both on', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await run(command, ['projects', '--host', 'H', '--port', 'P', 'ls'])
    expect(given).toMatchObject([{ host: 'H', port: 'P', rawArgs: ['--host', 'H', '--port', 'P'] }])
  })
})

describe('run with the flags of the levels above a leaf and the flags of the leaf', () => {
  it('keeps the flags of every level before what the leaf is given itself', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await run(command, ['--json', 'projects', '--lang', 'cs', 'ls', 'fix it'])
    expect(given).toMatchObject([
      {
        json: true,
        lang: 'cs',
        positional: 'fix it',
        rawArgs: ['--json', '--lang', 'cs', 'fix it'],
      },
    ])
  })

  it('lets the flag that comes later win, which is the one the leaf was given itself', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await run(command, ['--lang', 'cs', 'hello', '--lang', 'en'])
    expect(given).toMatchObject([{ command: 'hello', lang: 'en' }])
  })

  it('keeps a flag of the leaf that has no value from taking the flag that moved for its value', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await run(command, ['--json', 'ask', 'answer', 'a1', '--other'])
    expect(given).toMatchObject([{ command: 'answer', json: true, positional: 'a1', other: '' }])
  })
})

describe('run with a -- or a bare --debug among the arguments', () => {
  it('keeps what follows -- behind the flags that move, since it is no flag', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await run(command, ['--json', 'projects', 'ls', '--', '--debug'])
    expect(given).toMatchObject([
      { json: true, debug: undefined, rawArgs: ['--json', '--', '--debug'] },
    ])
  })

  it('reads no sub-command behind a --, so none runs', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await expect(run(command, ['--json', '--', 'projects', 'ls'])).resolves.toBe(0)
    expect(given).toStrictEqual([])
  })

  it('takes a bare --debug before the sub-command for a flag with no value', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await run(command, ['--debug', 'projects', 'ls'])
    expect(given).toMatchObject([{ debug: '', rawArgs: ['--debug='] }])
  })
})

describe('run with a call that has no leaf or no sub-command', () => {
  it('leaves a call with no sub-command to the root, and the arguments after a leaf where they are', async () => {
    expect.hasAssertions()
    const { command, given, rooted } = tree()
    await run(command, ['--json'])
    await run(command, ['projects', 'ls', '--json'])
    expect(rooted).toStrictEqual([['--json']])
    expect(given).toMatchObject([{ rawArgs: ['--json'] }])
  })

  it('leaves a group with no leaf to its own usage, as a usage error', async () => {
    expect.hasAssertions()
    const log = vi.spyOn(console, 'log').mockReturnValue()
    const error = vi.spyOn(console, 'error').mockReturnValue()
    const { command } = tree()
    await expect(run(command, ['--json', 'projects'])).resolves.toBe(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('List the projects of the bureau'))
    expect(error).toHaveBeenCalledWith(expect.stringContaining('No command specified'))
  })
})

describe('run and the usage of a command named after a flag with a value', () => {
  it.each([
    ['--lang', 'cs', 'projects', '--help'],
    ['--debug', 'projects', '--help'],
    ['projects', '--lang', 'cs', '--help'],
  ])('prints the usage of the group, not of what the value names: %j', async (...argv) => {
    expect.hasAssertions()
    const log = vi.spyOn(console, 'log').mockReturnValue()
    const { command } = tree()
    await expect(run(command, argv)).resolves.toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('List the projects of the bureau'))
  })

  it('prints the usage of the root for a name only the prototype of an object has', async () => {
    expect.hasAssertions()
    const log = vi.spyOn(console, 'log').mockReturnValue()
    const { command } = tree()
    await expect(run(command, ['constructor', '--help'])).resolves.toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Greet'))
  })

  it('prints the usage of the leaf after the flags of a group and of the root', async () => {
    expect.hasAssertions()
    const log = vi.spyOn(console, 'log').mockReturnValue()
    const { command } = tree()
    await expect(
      run(command, ['--json', 'projects', '--lang', 'cs', 'ls', '--help']),
    ).resolves.toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('PROMPT'))
  })
})
```

`apps/bytebureau/src/testing/command-tree.ts` (as shipped):

```ts
import { defineCommand, type CommandDef } from 'citty'
import { globalArgs, type GlobalArgs } from '../context.js'

// What a leaf was given: its raw arguments, the global flags it parsed, and the positional and the flag of its own
interface Given {
  readonly command: string
  readonly rawArgs: readonly string[]
  readonly json: boolean
  readonly lang: string | undefined
  readonly debug: string | undefined
  readonly host: string | undefined
  readonly port: string | undefined
  readonly other: string | undefined
  readonly positional: string | undefined
}

export interface Tree {
  readonly command: CommandDef
  // What the leaves were given
  readonly given: Given[]
  // What the root was given, when it ran itself
  readonly rooted: (readonly string[])[]
}

interface Seen {
  readonly rawArgs: readonly string[]
  readonly args: GlobalArgs
}

interface Own {
  readonly other?: string | undefined
  readonly positional?: string | undefined
}

function givenBy(command: string, seen: Seen, own: Own = {}): Given {
  const { rawArgs, args } = seen
  return {
    command,
    rawArgs,
    json: args.json,
    lang: args.lang,
    debug: args.debug,
    host: args.host,
    port: args.port,
    other: own.other,
    positional: own.positional,
  }
}

const HELLO_ARGS = { ...globalArgs, name: { type: 'positional', required: false } } as const
const LS_ARGS = { ...globalArgs, prompt: { type: 'positional', required: false } } as const
const ANSWER_ARGS = {
  ...globalArgs,
  id: { type: 'positional', required: false },
  other: { type: 'string' },
} as const

function helloOf(given: Given[]): CommandDef<typeof HELLO_ARGS> {
  return defineCommand({
    meta: { name: 'hello', description: 'Greet' },
    args: HELLO_ARGS,
    run(context) {
      given.push(givenBy('hello', context, { positional: context.args.name }))
    },
  })
}

function lsOf(given: Given[]): CommandDef<typeof LS_ARGS> {
  return defineCommand({
    meta: { name: 'ls', description: 'List the projects of the bureau' },
    args: LS_ARGS,
    run(context) {
      given.push(givenBy('ls', context, { positional: context.args.prompt }))
    },
  })
}

function answerOf(given: Given[]): CommandDef<typeof ANSWER_ARGS> {
  return defineCommand({
    meta: { name: 'answer', description: 'Answer an ask' },
    args: ANSWER_ARGS,
    run(context) {
      const { id, other } = context.args
      given.push(givenBy('answer', context, { positional: id, other }))
    },
  })
}

// The tree of bytebureau as it is built: a root with the global flags that tells the status when no sub-command is named, a leaf, and two groups of a leaf
export function tree(): Tree {
  const given: Given[] = []
  const rooted: (readonly string[])[] = []
  const projects = defineCommand({
    meta: { name: 'projects', description: 'Manage projects' },
    subCommands: { ls: lsOf(given) },
  })
  const ask = defineCommand({
    meta: { name: 'ask', description: 'List and answer asks' },
    subCommands: { answer: answerOf(given) },
  })
  const command: CommandDef = {
    meta: { name: 'bb', description: 'Root' },
    args: { ...globalArgs },
    subCommands: { hello: helloOf(given), projects, ask },
    run({ rawArgs, args }) {
      if (args._.length === 0) {
        rooted.push(rawArgs)
      }
    },
  }
  return { command, given, rooted }
}
```

**Semantics (as shipped, commits 6111cb6, 676137e, 523906a, 7a21cb6, 8edac8f, 1b37781, f230bc2, 0dade32, cf1389a, b1989e1, ef5b9ee, 0c45e1e, 32fb931, 5235e85, 2675413, 0c14004, ffa0d10, e1706b1):** `commands/sub-commands.ts` holds the sub-command map (`main.ts` is at its import cap); the root command is typed `CommandDef` and runs `statusCommand` through `runCommand(statusCommand, { rawArgs })` only when `args._` is empty, because citty runs the root `run` after a sub-command too (the brief assumed otherwise) — `status` is not a sub-command one can name. Global flags may go before or after a command name at any level: `run.ts` walks the command tree as `printUsage` does (root → group → leaf, skipping the values of each level's known flags, stopping at `--`), collects the flags found before the leaf and places them right after the leaf's name, before the leaf's own arguments — so `bytebureau --lang cs hello` prints Czech, `bytebureau sessions --json ls` emits JSON, `bytebureau projects --host H --port P ls` talks to H:P and starts nothing, a later duplicate flag wins and a trailing `--other` without a value stays no answer (the root's `args: { ...globalArgs }` had made citty drop flags before a sub-command silently, and a group declares no arguments at all); a bare `--debug` is rewritten to `--debug=` so the usage of a sub-command shows. The status opens the Bureau through `withBureau` (a daemon is started on demand), counts `projects.list`, `sessions.list`, `asks.pending` and takes version and start from `health.check`; the `Daemon:` line takes the pid from `server.json` only when the record's URL is the Bureau's, a daemon of another home (`--host`/`--port`) prints `status_daemon_remote` without a pid, `--no-daemon` prints `status_in_process`; the record is exactly `{ command: 'status', daemon?: { url, pid?, version, startedAt }, projects, sessions: { running, waiting, total }, pendingAsks }`. `sessions ls|show|prompt|interrupt|stop|resume`, `ask ls [--session]`, `ask answer <id> [--option]... [--other]` and `plugins ls` are as the brief says, with these shipped details: citty keeps only the last of a repeated flag, so `optionsOf` reads every `--option x`/`--option=x` from `rawArgs` (nothing after `--`); an empty `--other` is no answer; at a terminal without `--option`/`--other` the interactive prompt runs (`--yes` picks the recommended option, or `ask_no_recommended` refuses when the ask has none; a cancel ends with exit 1 and no line), elsewhere `ask_needs_answer` is the refusal; `render/tables.ts` pads every column but the last and flattens a multi-line cell onto one line (linear, no regex backtracking), `render/rows.ts` builds the rows (a dash for a session without a worktree, a multi-question ask, a failed plugin's reason); plugin ports are pinned exactly (`workspaceRuntimes:local`, `agentProviders:fake`). `commands/refusable.ts` (`refusable(context, work)`, `withBureauRefusable`) ends a refused request — an `ApiError` with a `4xx` problem, or the kernel's `SessionError`/`WorkspaceError`/ask errors — with the detail or reason as one line on stderr and exit 1 through `process.exitCode`; it also covers the kernel's `ConfigError` and `ProviderError` of the `missing` kind (what the API answers with 422), and it wraps every command but `run`: the sessions, ask and plugins commands (a refused `sessions prompt` exits 1 with the detail; its turn outcomes keep 0/3/4), the status, `projects ls|add|rm` and `workspaces ls|prune` (the Phase A `projects add` test moved from exit 2 to exit 1 with the reason line — a deliberate contract change; `run` keeps 4 for its refusals). `commands/run-follow.ts` holds `follow`/`react`/`conclude`/`promptAndFollow`, shared by `run` and `sessions prompt` through `Ends { terminal, completes, turnOnly }`: `run` completes the session after `turn.completed` and ends at `session.completed`; `sessions prompt` leaves the session `ready` for the next prompt, subscribes from `since: 0` and shows only the events the new turn owns (the `TurnDto`'s id, from the turn's first event on) plus the session-level terminal events, so an earlier stop and resume in the log cannot end it; `turn.interrupted` is no end by itself — the follow ends at the session's next event: `session.ready` → exit 3 and `run_interrupted`, `session.stopped` → exit 3 and `run_stopped`, `session.errored` → exit 4 — so a `run` interrupted from another terminal ends with exit 3 and the session stays `ready`, a stop this process requested by its signal ends at `session.stopped` as the Phase A tests pin, and the restarted daemon's recovery (`turn.interrupted`, `ask.cancelled`, `session.stopped`) ends the run at `session.stopped`. Messages: the brief's list with `sessions_done` replaced by `sessions_interrupted`/`sessions_stopped`/`sessions_resumed`, plus `run_interrupted`, `status_daemon_remote` and `ask_no_recommended`; the Czech `status_sessions` is label-first ("Relace: celkem {total}, běžící {running}, čekající na Vás {waiting}") so the numbers need no agreement; Czech says "relace" as the existing messages do, polite pronouns capitalised as `run_ask_waiting`. Tests: `render/{tables,rows}.test.ts`; `sessions.test.ts` (daemon-backed; the resume case stops a run by SIGTERM while the fake agent waits on its ask, then resumes and prompts — a completed session cannot be resumed), `sessions-prompt.test.ts` (unit, scripted Bureau), `sessions-prompt-daemon.test.ts` (SIGTERM ends at `session.stopped`), `ask.test.ts`, `ask-answer.test.ts` (fake prompts, the cancel), `plugins-status.test.ts` (ports, the status of a daemon of another home, the counts of a waiting run), `refusable.test.ts`, `refusals.test.ts` (every command against a stub daemon that answers 409 → exit 1 and the detail), `run-daemon-stops.test.ts` (a run interrupted by `sessions interrupt` from a second process → exit 3 and the session `ready`; a stop from another terminal → exit 3 and `run_stopped`), `run-session-interrupted.test.ts` (unit: the follow ends at the session's next event), `run-arguments.test.ts` and `run-flags.test.ts` (the flag placement, on the command tree of `testing/command-tree.ts`), `cli.test.ts` (`bytebureau hello` starts no daemon); helpers `testing/frames.ts`, `testing/session-bench.ts`; coverage include gains `commands/{run-follow,refusable,sessions-prompt,ask-answer}.ts` (`sessions-prompt.ts` holds `promptSession` only, the citty handler lives in `sessions.ts` with the other subprocess-only commands). `sessions show` flattens the pending-ask lines as the table does; every test that starts a daemon registers `stoppedWithTheTest(home)`. Accepted as shipped: global flags go after the sub-command (`bytebureau --lang cs hello` ignores the flag); `sessions prompt` replays the whole log of the session; the kernel publishes `turn.completed` a moment before the session is `ready` and a session interrupted while `paused_usage_limit` publishes no `session.ready` (both for the final wave).

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
- Modify: `.github/workflows/ci.yml` (contract drift step; daemon smoke in `build-smoke`, `smoke-arm64`, `smoke-macos`), `.github/workflows/semantic-pr.yml` (scopes `api`, `client`), `.github/labeler.yml` (`area: api`, `area: client`), `apps/docs/astro.config.mjs` (sidebar entry), `apps/docs/src/content/docs/architecture.md` (package table, run flow, Phase B decisions, the deferred list), `CONTRIBUTING.md` ("Working in the API and the client"), `README.md` + `README.cs.md` (status line), `docs/superpowers/specs/2026-10-02-kernel-and-agent-runtime-design.md` (amendments listed below), `docs/superpowers/plans/2026-10-04-kernel-phase-b-daemon-api-client.md` (this plan: the controller syncs the fences after the task) As shipped: `.github/workflows/semantic-pr.yml` already listed `api` and `client` (Tasks 3 and 7) and was left alone; `scripts/repo-settings/labels.txt` gained `area: client` for the labels parity test (the label itself is created on GitHub before the pull request); `cspell-words.txt` gained the new words of the docs page.

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
          bun run --cwd packages/protocol build
          bun run --cwd packages/api build
          bun run generate:client
          git diff --exit-code -- packages/protocol/schemas packages/api/openapi.json packages/client/src/gen
          untracked=$(git ls-files --others --exclude-standard -- packages/protocol/schemas packages/api/openapi.json packages/client/src/gen)
          [ -z "$untracked" ] || { printf 'untracked generated files:\n%s\n' "$untracked"; exit 1; }
```
Every smoke job (`build-smoke` x64, `smoke-arm64`, `smoke-macos`) gains, after the existing fake-provider run, a daemon step with the same `BIN`, `REPO` and `HOME_DIR` conventions:
```yaml
      - name: 'smoke (daemon: serve, run through the API, sessions ls, stop)'
        run: |
          set -euo pipefail
          BIN=(dist/bytebureau-*-linux-x64)
          [ "${#BIN[@]}" -eq 1 ]
          REPO=$(mktemp -d)
          HOME_DIR=$(mktemp -d)
          trap 'cat "$HOME_DIR"/logs/daemon.log 2>/dev/null || true' ERR
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

`apps/docs/src/content/docs/daemon-and-api.md` (English; the Czech site has only the introduction today, so the sidebar entry gets a Czech label only): title "Daemon and API"; sections — *The daemon* (`bytebureau serve`, detached by default, `--no-daemonize`, `--stop`, `--host`/`--port`, `server.json` with its fields and mode, the log at `~/.bytebureau/logs/daemon.log`, one daemon per home, what happens to running sessions at a restart); *Talking to it* (bearer token from `server.json`, `--host`/`--port`/`--token-file` for a daemon elsewhere, `--no-daemon` and when it is refused); *The API* (base path, the groups and endpoints table of Task 4, problem details with the code list, rate limit, body limit, `/api/v1/openapi.json`, `/api/v1/health` without a token); *Events over SSE* (`since`, `Last-Event-ID`, ids, the heartbeat — the first one leaves at once, then every 15 s — what a slow client misses); *RPC over WebSocket* (the envelopes, the token in request headers, acks, interrupts, origin check); *The client package* (`createBureauClient`, `subscribeEvents`, `connectRpc`, regenerating with `bun run generate:client`). `apps/docs/astro.config.mjs`: add `'daemon-and-api'` after `'architecture'` with `translations: { cs: 'Démon a API' }` in the item form the sidebar uses for labels (`{ label: 'Daemon and API', translations: { cs: 'Démon a API' }, link: '/daemon-and-api/' }`).

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

**Semantics (as shipped, commits 697917c, ae2590e, 2b7fb05, f1a9b9c, 7a8460b):** CI: the `static` job gains the step "generated contracts are up to date" after `bun run typecheck`, which builds the protocol schemas and the API's `openapi.json`, regenerates the client and fails when `git diff --exit-code` or `git status --porcelain` over `packages/protocol/schemas`, `packages/api/openapi.json` and `packages/client/src/gen` shows a change or a new file (the whole `bun run build` would also have compiled the binary); the three smoke jobs (`build-smoke` x64, `smoke-arm64` with `chmod +x` first, `smoke-macos` on `macos-26`) keep their in-process run with `--no-daemon` and gain the daemon step (a quoted step name — the brief's unquoted form does not parse): `serve --port 0 --json` on a temp home, a `run` through the daemon, `sessions ls --json` showing `completed`, the bare `--json` status, `serve --stop` and the absence of `server.json`; `bun run lint:actions` is clean. `.github/labeler.yml` gains `area: api` and `area: client` in its `changed-files` form; `semantic-pr.yml` already listed both scopes. Docs: `apps/docs/src/content/docs/daemon-and-api.md` (the daemon, talking to it, the API, events over SSE, RPC over WebSocket, the client package) with the sidebar entry `{ label: 'Daemon and API', translations: { cs: 'Démon a API' }, link: '/daemon-and-api/' }` after `architecture`; `architecture.md` gains the `packages/api`, `packages/client` and `tools/client-codegen` rows, the run flow through the daemon, the "Phase B decisions" list (with the shipped rulings the brief predates: the environment forwarded with a run and stripped from a daemon started on demand, the exit-1 refusals of every command but `run`, flags before or after a command name) and the rewritten "Deferred to later phases" list; `CONTRIBUTING.md` gains "Working in the API and the client"; the READMEs carry the Phase B status sentence in both languages, with the Czech saying "démon" as the CLI messages do (the sidebar label too); the spec carries the eight amendments of the brief, one sentence each marked "(amended in Phase B …)", the §14 "Daemon restart" table row rewritten to `stopped` with turn `interrupted` and reason `daemon_restart`, plus marked sentences for the shipped rulings; the docs, the architecture page and the spec say that the OpenAPI document holds one problem schema per status an endpoint declares (the 413 of the body limit is answered before routing and is not in the document), that a usage error, a refused `--no-daemon` and a cancelled interactive answer exit 1 like a refusal while any other failure exits 2, and that the `/ws` upgrade takes no token (every RPC request carries it); the smoke steps print `daemon.log` through an `ERR` trap when a command fails. Gate: a fresh clone of the final commit passed `bun install --frozen-lockfile`, `bun run check` (1859 tests, coverage thresholds met), `bun run lint:actions` and `bun run build:binaries --host`, and the macOS daemon smoke as committed exited 0 with `server.json` gone after `serve --stop`; the docs site builds; no daemon was left and `~/.bytebureau` was not touched. The GitHub label `area: client` was created from `scripts/repo-settings/labels.txt` before the pull request.

- [ ] **Step 4: Fresh-clone gate and the binary**

Run, from a fresh clone in a temp directory (`git clone <repo> "$TMP" && cd "$TMP" && git checkout <branch>`): `bun install --frozen-lockfile && bun run check && bun run lint:actions && bun run build:binaries --host`, then with `BYTEBUREAU_HOME=$(mktemp -d)` the daemon smoke sequence of Step 1 against `dist/bytebureau-*-darwin-arm64`.
Expected: every command exits 0; `check` reports the coverage thresholds met; the smoke prints `session.completed` and `server.json` is gone after `serve --stop`. If a gate fails, fix it in the task that owns the code and come back.

- [ ] **Step 5: Commit**

```bash
git add .github apps/docs CONTRIBUTING.md README.md README.cs.md docs
git commit -m "docs(repo): describe the daemon, the API and the client; run the daemon in the CI smoke"
```

