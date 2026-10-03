# Kernel & agent runtime — Phase A (core, headless run) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the kernel core of sub-project 1 so that `bytebureau run "<prompt>" --project <repo> --no-daemon` with the built-in fake agent provider registers the project, provisions a git worktree, runs a session through the Effect kernel, streams canonical events, brokers an ask through the CLI with a recommended option, persists durable events with increasing `seq`, and exits with the documented codes — in CI, on a fresh clone, with every SP0 gate green.

**Architecture:** Hexagonal, exactly as the spec draws it: `packages/protocol` (Effect Schema DTOs, event catalogue, config schema, generated JSON Schema), `packages/plugin-api` (plain-TypeScript ports and plugin contract, no Effect), `packages/kernel` (Effect 4 services as Layers: Config, Store, EventLog, ProjectRegistry, Supervisor, WorkspaceManager, SessionManager, AskService, UsageService, PluginHost, Logging), `plugins/workspace-local` (git worktree runtime), and the CLI in `apps/bytebureau` that wires the kernel in-process (`--no-daemon`). Phase B adds the daemon, HTTP/SSE/WebSocket API and the generated client; Phase C adds the Claude and ACP adapters, profiles and the secret store; Phase D adds doctor, diagnostics bundle, service install, upgrade and the full logging/tracing surface. Every interface in this plan is written so those phases extend rather than rework it.

**Tech Stack:** Bun 1.4.2 (runtime), TypeScript 7.0.x, Effect 4 (`effect`), Drizzle ORM + SQLite (`bun:sqlite` in the binary, `node:sqlite` under Vitest), c12 (config loader), LogTape (logging), `@standard-schema/spec`, Vitest 5 + fast-check, citty + @clack/prompts (CLI), git ≥ 2.40.

**Spec:** `docs/superpowers/specs/2026-10-02-kernel-and-agent-runtime-design.md` (sections 1–7, 8.3–8.4, 9, 10, 11.3 (`run`, `config`, `projects`, `workspaces`), 12 (logger and redaction basics), 13, 14, 15, 16 (criteria 1, 6, 8, 10)). Verified stack facts: `docs/research/2026-10-02-reports/15-sp1-phase-a-stack.md`.

## Global Constraints

- Dependency rules (dependency-cruiser, already enforced): only `packages/kernel`, `packages/api`, `packages/protocol` import `effect`; `plugins/*` import only `@bytebureau/plugin-api`, `@bytebureau/protocol` and third-party packages; nothing imports from `apps/*`; no circular dependencies.
- `packages/plugin-api` and `packages/protocol` are published later under MIT (`"license": "MIT"`); `packages/kernel`, `plugins/*` and `apps/bytebureau` stay `"license": "FSL-1.1-MIT"`; `scripts/license.test.ts` enumerates every manifest, so the MIT manifests need the licence test adjusted in the same task that creates them.
- Plugin-facing payloads are DTOs (no functions); streams are `AsyncIterable`; cancellation is an `AbortSignal`; plugin signatures are Promise-based.
- IDs are UUIDv7 strings; timestamps are ISO-8601 UTC strings; every durable event carries a store-assigned monotonic `seq`.
- SQLite: WAL, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`; migrations applied at startup; one writer (the process that opened the store).
- Data location: `~/.bytebureau/data/bytebureau.db` (override with `BYTEBUREAU_HOME`); per-project state only under `<project>/.bytebureau/` (`worktrees/`, `sessions/<id>/`, `logs/`, `cache/`, `employees/*.md`, `plugins/`); ByteBureau adds `.bytebureau/` to `.git/info/exclude` and never edits the project's `.gitignore`.
- Session statuses: `created | provisioning | ready | running | waiting_for_human | paused_usage_limit | completed | stopped | errored`; turn statuses `running | completed | interrupted | errored`; ask statuses `pending | answered | expired | cancelled`.
- Worktrees: `<project>/.bytebureau/worktrees/<sessionId>` on branch `bb/<slug>` (`slug` = kebab-case session title or `s-<short id>`, collisions get `-2`, `-3`, …) from `origin/<branch>` when the remote exists, otherwise the local branch; fetch throttled to once per 60 s per project; never operate on the main checkout; refuse to provision when the project path is itself a ByteBureau worktree.
- Ask contract: exactly one `recommended: true` option per question; `recommendationSource ∈ agent | policy | none`; `supervised` employees wait indefinitely; `autonomous` employees auto-proceed with the recommended option after `askTimeout` (default `30m`) for `question` asks only; permission asks never auto-allow — on timeout the kernel answers `deny` with "nobody available to approve; do not retry"; answers record `answered_via`.
- `yolo` permission mode is refused on a runtime with `isolation: 'none'` (the message names the runtime and says containers enable it later).
- Child processes get an explicit environment allowlist (`PATH`, `HOME`, `LANG`/`LC_*`, `TMPDIR`, `TERM`, profile variables, `TRACEPARENT`, `BYTEBUREAU_*`, `providers.<id>.passEnv`), never the full daemon environment; graceful termination SIGINT → SIGTERM after 5 s → SIGKILL after 10 s.
- Config precedence: CLI flags > `BYTEBUREAU_*` environment > `<project>/bytebureau.local.json` > `<project>/bytebureau.json` (or `.jsonc`) > `~/.bytebureau/config.json` > defaults; unknown keys are errors; validation errors name the file and the JSON pointer.
- CLI: `run` exits 0 on completion, 3 when stopped, 4 on provider error; non-TTY or `--json` output is NDJSON; the recommended option is preselected in interactive asks and chosen by `--yes`.
- Logging categories `bb.core`, `bb.config`, `bb.store`, `bb.events`, `bb.plugin.<name>`, `bb.agent.<provider>`, `bb.workspace`, `bb.supervisor`, `bb.cli`; no secrets in events, logs or output (redaction of the listed field names and patterns, canary tests).
- Tests run under Node (Vitest 5) with an in-memory SQLite database, Effect `TestClock`, the fake `AgentProvider` and a temp-dir git repository; no real agent is ever spawned in CI.
- SP0 gates stay green on a fresh clone: `bun run check` (oxlint every category at error and type-aware, oxfmt, cspell en+cs, markdownlint, ls-lint, knip, dependency-cruiser, typecheck, Vitest with 80 % line/branch coverage over `packages/*/src`, ESLint long tail), `bun run lint:actions` when workflows change; exact dependency pins; Conventional Commits; comments only where needed and short; everything in English; the project is "fair source", never "open source".

## Review Focus

1. A prompt containing CRLF line endings, emoji and Czech diacritics must reach the provider byte-for-byte and appear unchanged in `message.user` and in `--json` output — test added to the SessionManager task.
2. `bytebureau run --project <path>` where the path is not a git repository, or is itself a ByteBureau worktree, must fail before anything is written (no project row, no worktree, exit 4 with a one-line reason) — tests added to the ProjectRegistry and workspace-local tasks.
3. Killing the CLI (SIGINT) while a turn is running must leave the worktree intact and retained, mark the turn `interrupted` and the session resumable, and exit 3 — test added to the CLI task.
4. A project whose main checkout is dirty must never be touched: provisioning works from `origin/<branch>` or the local branch ref and the main checkout's working tree is byte-identical afterwards — test added to the workspace-local task.
5. An `autonomous` employee's `permission` ask on timeout must be denied with the documented message, while its `question` ask must be answered with the recommended option and `answered_via: 'timeout'` — tests added to the AskService task.

---

## File structure (what gets created and why)

```
packages/protocol/{package.json,tsconfig.json,vitest.config.ts}
packages/protocol/src/index.ts                      public re-exports (schemas and types)
packages/protocol/src/common.ts                     Id (UUIDv7), Timestamp, SessionStatus, TurnStatus, AskStatus, PermissionMode, Effort
packages/protocol/src/employee.ts                   EmployeeSpec, PromptInput, Appearance schemas
packages/protocol/src/ask.ts                        Ask, AskQuestion, AskOption, Evidence, AskAnswer, AskPolicy schemas
packages/protocol/src/events.ts                     EventEnvelope + the SP1 durable/ephemeral event payload schemas (one union)
packages/protocol/src/agent-event.ts                canonical AgentEvent union (provider → kernel)
packages/protocol/src/config.ts                     project config v1 and user config schemas
packages/protocol/scripts/generate-json-schema.ts   writes schemas/events.json and schemas/config.json
packages/protocol/schemas/                          generated, committed (consumed by $schema and the docs)
packages/plugin-api/{package.json,tsconfig.json,vitest.config.ts}
packages/plugin-api/src/index.ts                    public API surface
packages/plugin-api/src/ports.ts                    AgentProvider, AgentSession, WorkspaceRuntime, SecretStore + request/handle types
packages/plugin-api/src/plugin.ts                   PluginManifest, PluginContext, PluginRegistration, Plugin, definePlugin, hooks
packages/plugin-api/src/logger.ts                   Logger interface handed to plugins
packages/kernel/{package.json,tsconfig.json,vitest.config.ts,drizzle.config.ts}
packages/kernel/src/index.ts                        createKernel() facade + re-exports for apps
packages/kernel/src/ids.ts                          uuidv7(), now()
packages/kernel/src/errors.ts                       tagged errors: ConfigError, StoreError, WorkspaceError, ProviderError, AskError, PluginError
packages/kernel/src/store/schema.ts                 Drizzle tables (§5.2)
packages/kernel/src/store/driver.ts                 SqliteDriver: bun:sqlite in Bun, node:sqlite under Node
packages/kernel/src/store/store.ts                  Store service (open, pragmas, migrate, db)
packages/kernel/src/store/migrations/              generated by drizzle-kit, embedded for the binary
packages/kernel/src/config/schema.ts                re-export of protocol config schema + defaults
packages/kernel/src/config/config.ts                Config service (c12 layers, env overlay, validation, pointer errors)
packages/kernel/src/events/event-log.ts             EventLog service (durable append, ephemeral fan-out, replay)
packages/kernel/src/projects/project-registry.ts    ProjectRegistry service
packages/kernel/src/projects/git-root.ts            git root + worktree detection helpers
packages/kernel/src/process/supervisor.ts           Supervisor service
packages/kernel/src/process/env-allowlist.ts        environment allowlist
packages/kernel/src/process/line-buffer.ts          bounded line buffer
packages/kernel/src/workspace/workspace-manager.ts  WorkspaceManager service (locks, retain, prune)
packages/kernel/src/workspace/slug.ts               branch slug rules
packages/kernel/src/plugins/plugin-host.ts          PluginHost service (manifest check, setup, ports, hooks)
packages/kernel/src/plugins/hooks.ts                hook bus
packages/kernel/src/asks/ask-service.ts             AskService (open/answer/cancel/pending, timeout policy)
packages/kernel/src/asks/policy.ts                  permission recommendation rules
packages/kernel/src/sessions/session-manager.ts     SessionManager (lifecycle, turns, event translation)
packages/kernel/src/sessions/state-machine.ts       pure transition table
packages/kernel/src/usage/usage-service.ts          UsageService
packages/kernel/src/logging/logging.ts              LogTape configuration + Effect logger bridge
packages/kernel/src/logging/redaction.ts            field/pattern redaction
packages/kernel/src/testing/fake-agent-provider.ts  scripted provider for tests and CI
packages/kernel/src/testing/kernel-test.ts          KernelTest layer (in-memory DB, TestClock, temp dirs)
packages/kernel/src/kernel-live.ts                  KernelLive layer composition
plugins/workspace-local/{package.json,tsconfig.json,vitest.config.ts}
plugins/workspace-local/src/plugin.ts               definePlugin() entry
plugins/workspace-local/src/local-runtime.ts        WorkspaceRuntime implementation
plugins/workspace-local/src/git.ts                  typed git wrapper (worktree add/remove/list, fetch, status v2)
apps/bytebureau/src/commands/run.ts                 bytebureau run
apps/bytebureau/src/commands/config.ts              bytebureau config init|validate|schema
apps/bytebureau/src/commands/projects.ts            bytebureau projects ls|add|rm
apps/bytebureau/src/commands/workspaces.ts          bytebureau workspaces ls|prune
apps/bytebureau/src/render/transcript.ts            clack rendering of the event stream
apps/bytebureau/src/render/ask-prompt.ts            interactive ask with the recommended option preselected
apps/bytebureau/src/kernel.ts                       in-process kernel bootstrap for --no-daemon
```

(Task sections follow; each task is self-contained.)

## Task order and interfaces at a glance

| # | Task | Produces (names later tasks rely on) |
|---|---|---|
| 1 | `packages/protocol` | Effect Schema classes and the derived types `Id`, `Timestamp`, `SessionStatus`, `TurnStatus`, `AskStatus`, `PermissionMode`, `Effort`, `EmployeeSpec`, `PromptInput`, `Ask`, `AskQuestion`, `AskOption`, `AskAnswer`, `AskPolicy`, `AgentEvent`, `EventEnvelope`, `KernelEvent`, `ProjectConfig`, `UserConfig`; `schemas/events.json`, `schemas/config.json` |
| 2 | `packages/plugin-api` | `AgentProvider`, `AgentSession`, `CreateSessionRequest`, `WorkspaceRuntime`, `WorkspaceSpec`, `WorkspaceHandle`, `WorkspaceStatus`, `ExecSpec`, `ExecHandle`, `SecretStore`, `ProfileRef`, `AuthStatus`, `Logger`, `PluginManifest`, `PluginContext`, `PluginRegistration`, `Plugin`, `definePlugin`, `Hooks` |
| 3 | kernel scaffold + `Store` | `SqliteDriver`, `openDriver`, `Store` service (`db`, `migrate`, `close`), Drizzle tables in `schema.ts`, `StoreError` |
| 4 | ids, errors, logging | `uuidv7()`, `nowIso()`, tagged error classes, `Logging` layer, `redact()` |
| 5 | `Config` | `Config` service (`load`, `get`, `schema`), `ConfigError`, `defaultProjectConfig` |
| 6 | `EventLog` | `EventLog` service (`publish`, `subscribe`, `read`), `EventFilter` |
| 7 | `ProjectRegistry` | `ProjectRegistry` service (`register`, `list`, `get`, `remove`), `findGitRoot`, `isByteBureauWorktree` |
| 8 | `Supervisor` | `Supervisor` service (`spawn`, `kill`, `list`), `SpawnSpec`, `ManagedProcess`, `allowlistEnv`, `LineBuffer` |
| 9 | `plugins/workspace-local` | `localWorkspacePlugin`, `LocalWorkspaceRuntime`, `git()` wrapper |
| 10 | `WorkspaceManager` | `WorkspaceManager` service (`provision`, `status`, `destroy`, `prune`), `branchSlug` |
| 11 | `PluginHost` | `PluginHost` service (`load`, `ports`, `hooks`), bundled registry, `HookBus` |
| 12 | `AskService` | `AskService` service (`open`, `answer`, `cancel`, `pending`), `recommendForPermission` |
| 13 | sessions + usage + fake provider | `SessionManager` service (`create`, `prompt`, `interrupt`, `stop`, `resume`, `list`, `get`), `transition`, `UsageService`, `FakeAgentProvider`, `fakeScript` |
| 14 | kernel layers + facade | `KernelLive`, `KernelTest`, `createKernel`, `Kernel` (Promise facade used by the CLI) |
| 15 | CLI commands | `run`, `config`, `projects`, `workspaces` commands; `renderTranscript`, `promptAsk` |
| 16 | gates, docs, ADR | green `bun run check` on a fresh clone; ADR-0010; docs page update |

---

### Task 1: `packages/protocol` — schemas, event catalogue, config schema, generated JSON Schema (MIT)

**Files:**
- Create: `packages/tsconfig/effect.json`, `packages/protocol/package.json`, `packages/protocol/tsconfig.json`, `packages/protocol/vitest.config.ts`, `packages/protocol/src/index.ts`, `packages/protocol/src/common.ts`, `packages/protocol/src/employee.ts`, `packages/protocol/src/ask.ts`, `packages/protocol/src/agent-event.ts`, `packages/protocol/src/events.ts`, `packages/protocol/src/config.ts`, `packages/protocol/src/json-schema.ts`, `packages/protocol/scripts/generate-json-schema.ts`, `packages/protocol/schemas/config.json`, `packages/protocol/schemas/events.json`, `packages/protocol/src/config.test.ts`, `packages/protocol/src/json-schema.test.ts`
- Modify: `vitest.config.ts`, `knip.ts`, `scripts/license.test.ts`, `turbo.json` (`@bytebureau/protocol#build` generates the schemas), `.oxlintrc.jsonc` + `.oxfmtrc.json` (Effect idioms; generated schemas ignored by the formatter — own `chore(repo)` commit), `.github/workflows/semantic-pr.yml` (`protocol` scope), `cspell-words.txt` (`xhigh`)

**Interfaces:**
- Produces: the schema constants and derived types named in the table (`typeof X.Type` for every schema), `KERNEL_EVENT_TYPES`, `EPHEMERAL_EVENT_TYPES`, `configJsonSchema()`, `eventsJsonSchema()`, `decodeProjectConfig(input): ProjectConfig` (throws a `ParseError` whose message lists every issue with its path).

Verified facts this task relies on (fact sheet §1, §9): `effect@4.0.0` exports `Schema` from `effect/Schema`; `Schema.Struct`, `Schema.Literals([...])`, `Schema.Literal`, `Schema.optionalKey`, `Schema.Array`, `Schema.Record`, `Schema.NullOr`, `Schema.Union([...])` (v4 takes one array of members — if the installed `effect/Schema` d.ts shows a variadic `Union`, spread the array), `Schema.toJsonSchemaDocument(S, { onExcessProperty: 'error' })`, `Schema.decodeUnknownSync(S)(input, { onExcessProperty: 'error', errors: 'all' })`, `JsonSchema.META_SCHEMA_URI_DRAFT_2020_12`. Effect's class-based APIs do not compile under `isolatedDeclarations`, hence `effect.json`. `effect@4.0.0` was published 2026-10-01T03:11Z; the repository's install cooldown is one day during development (`bunfig.toml`, ADR-0009), so `bun add effect@4.0.0` resolves normally.

- [ ] **Step 1: Effect tsconfig base and package manifests**

`packages/tsconfig/effect.json` (library settings without `isolatedDeclarations`; Effect's `Context.Service`, `Data.TaggedError` and `Schema.TaggedError` extend expressions):
```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "./base.json",
  "compilerOptions": {
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noEmit": true
  }
}
```
Add `"./effect.json": "./effect.json"` to `packages/tsconfig/package.json` `exports` (next to the existing three entries).

`packages/protocol/package.json`:
```json
{
  "name": "@bytebureau/protocol",
  "version": "0.0.0",
  "private": true,
  "description": "ByteBureau protocol: event, ask, employee and config schemas with generated JSON Schema",
  "license": "MIT",
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    },
    "./schemas/config.json": "./schemas/config.json",
    "./schemas/events.json": "./schemas/events.json"
  },
  "scripts": {
    "build": "bun run scripts/generate-json-schema.ts",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "effect": "4.0.0"
  },
  "devDependencies": {
    "@bytebureau/tsconfig": "workspace:*"
  }
}
```
`packages/protocol/tsconfig.json`:
```json
{
  "extends": "@bytebureau/tsconfig/effect.json",
  "compilerOptions": { "types": ["bun"] },
  "include": ["src/**/*.ts", "scripts/**/*.ts"]
}
```
`packages/protocol/vitest.config.ts`:
```ts
import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'protocol', include: ['src/**/*.test.ts'] } })
```

- [ ] **Step 2: Failing tests**

`packages/protocol/src/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { decodeProjectConfig, decodeUserConfig, defaultProjectConfig } from './config.js'

describe(decodeProjectConfig, () => {
  it('accepts the documented sample and fills nothing silently', () => {
    const config = decodeProjectConfig(defaultProjectConfig)
    expect(config.version).toBe(1)
    expect(config.employees['developer']).toMatchObject({ permissionMode: 'supervised' })
  })

  it('reports every problem with its path and rejects unknown keys', () => {
    const broken = { ...defaultProjectConfig, logging: { level: 'loud' }, extra: true }
    expect(() => decodeProjectConfig(broken)).toThrow(/logging.*level/u)
    expect(() => decodeProjectConfig(broken)).toThrow(/extra/u)
  })
})

describe(decodeUserConfig, () => {
  const userConfig = {
    server: { host: '127.0.0.1', port: 4747 },
    defaults: { provider: 'claude', profile: 'work' },
    profiles: {
      work: {
        providerId: 'claude',
        name: 'Work',
        kind: 'login',
        configDir: '/home/me/.claude-work',
      },
      ci: { providerId: 'claude', name: 'CI', kind: 'api_key' },
    },
    locale: 'cs',
    logging: { level: 'debug' },
    telemetry: { content: 'local', otlpEndpoint: 'http://localhost:4318' },
    ui: { theme: 'dark', panes: { left: 3 } },
  }

  it('decodes profiles, ui and the telemetry endpoint unchanged', () => {
    expect(decodeUserConfig(userConfig)).toStrictEqual(userConfig)
  })

  it('still rejects an unknown user key and a profile with an unknown kind', () => {
    const oauth = { profiles: { work: { ...userConfig.profiles.work, kind: 'oauth' } } }
    expect(() => decodeUserConfig({ ...userConfig, extra: true })).toThrow(/extra/u)
    expect(() => decodeUserConfig(oauth)).toThrow(/kind/u)
  })
})
```
`packages/protocol/src/json-schema.test.ts`:
```ts
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KERNEL_EVENT_TYPES } from './events.js'
import { configJsonSchema, eventsJsonSchema } from './json-schema.js'

const schemasDir = fileURLToPath(new URL('../schemas/', import.meta.url))
const readSchema = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(schemasDir, name), 'utf8'))
const definitionsOf = (document: Record<string, unknown>): Record<string, unknown> => {
  const definitions = document['$defs']
  return typeof definitions === 'object' && definitions !== null ? { ...definitions } : {}
}

describe('generated JSON Schema files', () => {
  it('config.json is up to date and strict', () => {
    const generated = configJsonSchema()
    expect(readSchema('config.json')).toStrictEqual(generated)
    expect(generated['$id']).toBe('https://bytebureau.dev/schema/v1/config.json')
    expect(generated['additionalProperties']).toBe(false)
  })

  it('events.json is up to date and lists every event type', () => {
    const generated = eventsJsonSchema()
    expect(readSchema('events.json')).toStrictEqual(generated)
    expect(generated['$defs']).toHaveProperty(['session.created'])
    expect(generated['$defs']).toHaveProperty(['message.assistant.delta'])
  })

  it('events.json defines every payload as a closed object', () => {
    expect.hasAssertions()
    const payloads = Object.entries(definitionsOf(eventsJsonSchema())).filter(
      ([name]) => name !== 'EventEnvelope',
    )
    expect(payloads).toHaveLength(KERNEL_EVENT_TYPES.length)
    for (const [name, definition] of payloads) {
      expect(definition, name).toMatchObject({ type: 'object', additionalProperties: false })
    }
  })

  it('publishes numbers as number or integer, without Infinity or NaN alternatives', () => {
    expect(JSON.stringify(configJsonSchema())).not.toMatch(/Infinity|NaN/u)
    expect(JSON.stringify(eventsJsonSchema())).not.toMatch(/Infinity|NaN/u)
  })
})
```
Run: `bunx vitest run --project protocol` → FAIL (modules missing).

- [ ] **Step 3: Common, employee and ask schemas**

`packages/protocol/src/common.ts`:
```ts
import { Schema } from 'effect'

export const Id = Schema.String.annotate({ title: 'UUIDv7', description: 'Time-ordered UUID (v7)' })
export const Timestamp = Schema.String.annotate({ title: 'Timestamp', description: 'ISO-8601 UTC' })

export const SessionStatus = Schema.Literals([
  'created',
  'provisioning',
  'ready',
  'running',
  'waiting_for_human',
  'paused_usage_limit',
  'completed',
  'stopped',
  'errored',
])
export const TurnStatus = Schema.Literals(['running', 'completed', 'interrupted', 'errored'])
export const AskStatus = Schema.Literals(['pending', 'answered', 'expired', 'cancelled'])
export const PermissionMode = Schema.Literals(['supervised', 'autonomous', 'yolo'])
export const Effort = Schema.Literals(['low', 'medium', 'high', 'xhigh', 'max'])
export const AnsweredVia = Schema.Literals(['cli', 'api', 'timeout', 'policy'])

export type Id = typeof Id.Type
export type Timestamp = typeof Timestamp.Type
export type SessionStatus = typeof SessionStatus.Type
export type TurnStatus = typeof TurnStatus.Type
export type AskStatus = typeof AskStatus.Type
export type PermissionMode = typeof PermissionMode.Type
export type Effort = typeof Effort.Type
export type AnsweredVia = typeof AnsweredVia.Type
```

`packages/protocol/src/employee.ts`:
```ts
import { Schema } from 'effect'
import { Effort, PermissionMode } from './common.js'

export const Appearance = Schema.Struct({
  gender: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.String),
  hair: Schema.optionalKey(Schema.String),
  outfit: Schema.optionalKey(Schema.String),
  palette: Schema.optionalKey(Schema.String),
})

export const ToolPolicy = Schema.Struct({
  allow: Schema.Array(Schema.String),
  deny: Schema.Array(Schema.String),
})

export const EmployeeSpec = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  effort: Schema.NullOr(Effort),
  systemPrompt: Schema.String,
  tools: ToolPolicy,
  permissionMode: PermissionMode,
  skills: Schema.Array(Schema.String),
  maxTurns: Schema.optionalKey(Schema.Int),
  askTimeout: Schema.optionalKey(Schema.String),
  appearance: Appearance,
})

export const Attachment = Schema.Struct({
  path: Schema.String,
  mime: Schema.optionalKey(Schema.String),
})
export const PromptInput = Schema.Struct({
  text: Schema.String,
  attachments: Schema.optionalKey(Schema.Array(Attachment)),
})

export type Appearance = typeof Appearance.Type
export type ToolPolicy = typeof ToolPolicy.Type
export type EmployeeSpec = typeof EmployeeSpec.Type
export type Attachment = typeof Attachment.Type
export type PromptInput = typeof PromptInput.Type
```

`packages/protocol/src/ask.ts`:
```ts
import { Schema } from 'effect'
import { AnsweredVia, AskStatus, Id, Timestamp } from './common.js'

export const Evidence = Schema.Struct({
  kind: Schema.Literals(['file', 'test', 'doc', 'ticket', 'rule']),
  ref: Schema.String,
  excerpt: Schema.optionalKey(Schema.String),
})

export const AskOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  recommended: Schema.Boolean,
  evidence: Schema.Array(Evidence),
})

export const AskQuestion = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  prompt: Schema.String,
  options: Schema.Array(AskOption),
  multiSelect: Schema.Boolean,
  allowOther: Schema.Boolean,
})

export const AskPolicy = Schema.Struct({
  onTimeout: Schema.Literals(['wait', 'recommended', 'deny']),
  timeout: Schema.String,
})

export const Ask = Schema.Struct({
  id: Id,
  sessionId: Id,
  turnId: Schema.NullOr(Id),
  kind: Schema.Literals(['question', 'permission']),
  title: Schema.String,
  questions: Schema.Array(AskQuestion),
  toolCall: Schema.optionalKey(Schema.Struct({ name: Schema.String, input: Schema.Unknown })),
  policy: AskPolicy,
  recommendationSource: Schema.Literals(['agent', 'policy', 'none']),
  status: AskStatus,
  createdAt: Timestamp,
  deadlineAt: Schema.NullOr(Timestamp),
})

export const AskAnswer = Schema.Struct({
  selected: Schema.Union([Schema.Array(Schema.String), Schema.Literal('other')]),
  otherText: Schema.optionalKey(Schema.String),
  remember: Schema.optionalKey(Schema.Literals(['session', 'always'])),
})

export const AskRecord = Schema.Struct({
  ...Ask.fields,
  answer: Schema.NullOr(AskAnswer),
  answeredAt: Schema.NullOr(Timestamp),
  answeredVia: Schema.NullOr(AnsweredVia),
})

export type Evidence = typeof Evidence.Type
export type AskOption = typeof AskOption.Type
export type AskQuestion = typeof AskQuestion.Type
export type AskPolicy = typeof AskPolicy.Type
export type Ask = typeof Ask.Type
export type AskAnswer = typeof AskAnswer.Type
export type AskRecord = typeof AskRecord.Type
```

- [ ] **Step 4: Canonical agent events and the kernel event catalogue**

`packages/protocol/src/agent-event.ts`:
```ts
import { Schema } from 'effect'
import { Ask } from './ask.js'

const tagged = <const Tag extends string, Fields extends Schema.Struct.Fields>(
  type: Tag,
  fields: Fields,
): Schema.Struct<{ readonly type: Schema.Literal<Tag> } & Fields> =>
  Schema.Struct({ type: Schema.Literal(type), ...fields })

export const Usage = Schema.Struct({
  inputTokens: Schema.Int,
  outputTokens: Schema.Int,
  cacheReadTokens: Schema.optionalKey(Schema.Int),
  cacheWriteTokens: Schema.optionalKey(Schema.Int),
  costUsd: Schema.optionalKey(Schema.Finite),
  contextPct: Schema.optionalKey(Schema.Finite),
})

export const RateLimit = Schema.Struct({
  fiveHourPct: Schema.optionalKey(Schema.Finite),
  fiveHourResetsAt: Schema.optionalKey(Schema.String),
  sevenDayPct: Schema.optionalKey(Schema.Finite),
  sevenDayResetsAt: Schema.optionalKey(Schema.String),
})

export const ToolKind = Schema.Literals(['builtin', 'mcp', 'bash', 'subagent', 'skill'])

export const AgentEvent = Schema.Union([
  tagged('turn.started', {}),
  tagged('message.delta', { kind: Schema.Literals(['text', 'thinking']), text: Schema.String }),
  tagged('message.completed', {
    role: Schema.Literals(['assistant', 'user']),
    content: Schema.Array(Schema.Unknown),
    text: Schema.String,
  }),
  tagged('tool.started', {
    id: Schema.String,
    name: Schema.String,
    kind: ToolKind,
    input: Schema.Unknown,
  }),
  tagged('tool.completed', {
    id: Schema.String,
    outputSummary: Schema.String,
    bytes: Schema.Int,
  }),
  tagged('tool.failed', { id: Schema.String, error: Schema.String }),
  tagged('subagent.started', { id: Schema.String, name: Schema.String }),
  tagged('subagent.stopped', { id: Schema.String, name: Schema.String }),
  tagged('ask.requested', { ask: Ask }),
  tagged('usage.updated', { usage: Usage }),
  tagged('ratelimit.updated', { rateLimit: RateLimit }),
  tagged('compaction.started', {}),
  tagged('compaction.completed', {}),
  tagged('turn.completed', { stopReason: Schema.String, usage: Usage }),
  tagged('session.warning', { kind: Schema.String, message: Schema.String }),
  tagged('session.error', {
    kind: Schema.Literals(['auth', 'ratelimit', 'crash', 'protocol']),
    message: Schema.String,
    retryable: Schema.Boolean,
  }),
  tagged('session.closed', {}),
  tagged('raw', { providerEvent: Schema.Unknown }),
])

export type Usage = typeof Usage.Type
export type RateLimit = typeof RateLimit.Type
export type ToolKind = typeof ToolKind.Type
export type AgentEvent = typeof AgentEvent.Type
export type AgentEventType = AgentEvent['type']
```
If `Schema.Struct.Fields` is not the exported name of the fields constraint in the installed `effect/Schema` d.ts, use the constraint `Record<string, Schema.Top>` (search the d.ts for `export declare namespace Struct`) — the helper must keep the literal `type` inferred.

`packages/protocol/src/events.ts`:
```ts
import { Schema } from 'effect'
import { RateLimit, ToolKind, Usage } from './agent-event.js'
import { Ask, AskAnswer } from './ask.js'
import { AnsweredVia, Id, SessionStatus, Timestamp, TurnStatus } from './common.js'

export const EventEnvelope = Schema.Struct({
  seq: Schema.Int,
  id: Id,
  ts: Timestamp,
  type: Schema.String,
  projectId: Schema.optionalKey(Id),
  sessionId: Schema.optionalKey(Id),
  turnId: Schema.optionalKey(Id),
  workItemId: Schema.optionalKey(Id),
  traceId: Schema.optionalKey(Schema.String),
  spanId: Schema.optionalKey(Schema.String),
  payload: Schema.Unknown,
})

const project = Schema.Struct({
  id: Id,
  name: Schema.String,
  path: Schema.String,
  defaultBranch: Schema.String,
})
const sessionRef = Schema.Struct({ status: SessionStatus })
const turnRef = Schema.Struct({ turnId: Id, index: Schema.Int, status: TurnStatus })
// Closed empty object: only {} decodes (Schema.Struct({}) would accept any non-null value)
const emptyPayload = Schema.Record(Schema.String, Schema.Never)

// Payload schema per kernel event type; the key is the wire `type`
export const KernelEventSchemas = {
  'project.registered': project,
  'project.updated': project,
  'project.removed': Schema.Struct({ id: Id }),
  'profile.added': Schema.Struct({ profileId: Id, providerId: Schema.String }),
  'profile.removed': Schema.Struct({ profileId: Id }),
  'profile.status': Schema.Struct({ profileId: Id, state: Schema.String }),
  'session.created': Schema.Struct({
    ...sessionRef.fields,
    title: Schema.String,
    employeeId: Schema.String,
    providerId: Schema.String,
  }),
  'session.provisioning': sessionRef,
  'session.ready': Schema.Struct({
    ...sessionRef.fields,
    model: Schema.optionalKey(Schema.String),
  }),
  'session.running': sessionRef,
  'session.waiting': Schema.Struct({ ...sessionRef.fields, askId: Id }),
  'session.paused': Schema.Struct({ ...sessionRef.fields, resetsAt: Schema.NullOr(Timestamp) }),
  'session.resumed': sessionRef,
  'session.stopped': sessionRef,
  'session.completed': sessionRef,
  'session.errored': Schema.Struct({
    ...sessionRef.fields,
    kind: Schema.Literals(['auth', 'ratelimit', 'crash', 'protocol']),
    message: Schema.String,
    retryable: Schema.Boolean,
  }),
  'session.warning': Schema.Struct({ kind: Schema.String, message: Schema.String }),
  'turn.started': turnRef,
  'turn.completed': Schema.Struct({ ...turnRef.fields, stopReason: Schema.String, usage: Usage }),
  'turn.interrupted': turnRef,
  'message.user': Schema.Struct({ text: Schema.String }),
  'message.assistant.completed': Schema.Struct({
    text: Schema.String,
    content: Schema.Array(Schema.Unknown),
  }),
  'tool.started': Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    kind: ToolKind,
    input: Schema.Unknown,
  }),
  'tool.completed': Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    outputSummary: Schema.String,
    bytes: Schema.Int,
  }),
  'tool.failed': Schema.Struct({ id: Schema.String, name: Schema.String, error: Schema.String }),
  'subagent.started': Schema.Struct({ id: Schema.String, name: Schema.String }),
  'subagent.stopped': Schema.Struct({ id: Schema.String, name: Schema.String }),
  'ask.requested': Schema.Struct({ ask: Ask }),
  'ask.answered': Schema.Struct({ askId: Id, answer: AskAnswer, answeredVia: AnsweredVia }),
  'ask.expired': Schema.Struct({ askId: Id, fallback: Schema.String }),
  'ask.cancelled': Schema.Struct({ askId: Id }),
  'usage.updated': Schema.Struct({ usage: Usage }),
  'ratelimit.updated': Schema.Struct({ profileId: Schema.NullOr(Id), rateLimit: RateLimit }),
  'compaction.started': emptyPayload,
  'compaction.completed': emptyPayload,
  'workspace.provisioned': Schema.Struct({
    path: Schema.String,
    branch: Schema.String,
    baseRef: Schema.String,
    runtimeId: Schema.String,
  }),
  'workspace.destroyed': Schema.Struct({ path: Schema.String }),
  'workspace.retained': Schema.Struct({ path: Schema.String, reason: Schema.String }),
  'plugin.loaded': Schema.Struct({
    name: Schema.String,
    version: Schema.String,
    ports: Schema.Array(Schema.String),
  }),
  'plugin.failed': Schema.Struct({ name: Schema.String, reason: Schema.String }),
  'message.assistant.delta': Schema.Struct({
    kind: Schema.Literals(['text', 'thinking']),
    text: Schema.String,
  }),
  'tool.progress': Schema.Struct({ id: Schema.String, text: Schema.String }),
  heartbeat: Schema.Struct({ at: Timestamp }),
} as const

export const EPHEMERAL_EVENT_TYPES = [
  'message.assistant.delta',
  'tool.progress',
  'heartbeat',
] as const

export const KERNEL_EVENT_TYPES: readonly KernelEventType[] = Object.keys(
  KernelEventSchemas,
).filter((key): key is KernelEventType => Object.hasOwn(KernelEventSchemas, key))

export type KernelEventType = keyof typeof KernelEventSchemas
export type KernelEventPayload<EventType extends KernelEventType> =
  (typeof KernelEventSchemas)[EventType]['Type']
export type EventEnvelope = typeof EventEnvelope.Type

export interface KernelEvent<EventType extends KernelEventType = KernelEventType> {
  readonly type: EventType
  readonly payload: KernelEventPayload<EventType>
  readonly projectId?: string | undefined
  readonly sessionId?: string | undefined
  readonly turnId?: string | undefined
}

/** True for live-only event types: fanned out to subscribers, never persisted */
export function isEphemeral(type: string): boolean {
  return (EPHEMERAL_EVENT_TYPES as readonly string[]).includes(type)
}
```

- [ ] **Step 5: Config schemas and JSON Schema generation**

`packages/protocol/src/config.ts`:
```ts
import { Schema } from 'effect'
import { Effort, PermissionMode } from './common.js'
import { Appearance, ToolPolicy } from './employee.js'

export const LogLevel = Schema.Literals(['trace', 'debug', 'info', 'warn', 'error'])

export const EmployeeConfig = Schema.Struct({
  name: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  effort: Schema.optionalKey(Schema.NullOr(Effort)),
  prompt: Schema.optionalKey(Schema.String),
  systemPrompt: Schema.optionalKey(Schema.String),
  permissionMode: PermissionMode,
  tools: Schema.optionalKey(ToolPolicy),
  skills: Schema.optionalKey(Schema.Array(Schema.String)),
  maxTurns: Schema.optionalKey(Schema.Int),
  askTimeout: Schema.optionalKey(Schema.String),
  appearance: Schema.optionalKey(Appearance),
})

export const PluginRef = Schema.Union([
  Schema.String,
  Schema.Struct({ npm: Schema.String, version: Schema.optionalKey(Schema.String) }),
])

const LoggingSection = Schema.Struct({ level: Schema.optionalKey(LogLevel) })

const WorkspaceSection = Schema.Struct({
  runtime: Schema.optionalKey(Schema.String),
  copyIgnored: Schema.optionalKey(Schema.Array(Schema.String)),
  retainDays: Schema.optionalKey(Schema.Int),
})
const ProvidersSection = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))
const ProjectDefaults = Schema.Struct({
  employee: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
})

export const ProjectConfig = Schema.Struct({
  $schema: Schema.optionalKey(Schema.String),
  version: Schema.Literal(1),
  project: Schema.Struct({
    name: Schema.NonEmptyString,
    defaultBranch: Schema.optionalKey(Schema.String),
  }),
  workspace: Schema.optionalKey(WorkspaceSection),
  providers: Schema.optionalKey(ProvidersSection),
  employees: Schema.Record(Schema.String, EmployeeConfig),
  defaults: Schema.optionalKey(ProjectDefaults),
  plugins: Schema.optionalKey(Schema.Array(PluginRef)),
  logging: Schema.optionalKey(LoggingSection),
}).annotate({ title: 'ByteBureau project configuration (v1)' })

const ServerSection = Schema.Struct({
  host: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Int),
})
const UserDefaults = Schema.Struct({
  provider: Schema.optionalKey(Schema.String),
  profile: Schema.optionalKey(Schema.String),
})
const UserProfile = Schema.Struct({
  providerId: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(['login', 'api_key']),
  configDir: Schema.optionalKey(Schema.String),
})
const ProfilesSection = Schema.Record(Schema.String, UserProfile)
const TelemetrySection = Schema.Struct({
  content: Schema.optionalKey(Schema.Literals(['local', 'off'])),
  otlpEndpoint: Schema.optionalKey(Schema.String),
})
const UiSection = Schema.Record(Schema.String, Schema.Unknown)

export const UserConfig = Schema.Struct({
  server: Schema.optionalKey(ServerSection),
  profiles: Schema.optionalKey(ProfilesSection),
  defaults: Schema.optionalKey(UserDefaults),
  locale: Schema.optionalKey(Schema.String),
  logging: Schema.optionalKey(LoggingSection),
  telemetry: Schema.optionalKey(TelemetrySection),
  ui: Schema.optionalKey(UiSection),
}).annotate({ title: 'ByteBureau user configuration' })

export type LogLevel = typeof LogLevel.Type
export type EmployeeConfig = typeof EmployeeConfig.Type
export type PluginRef = typeof PluginRef.Type
export type ProjectConfig = typeof ProjectConfig.Type
export type UserConfig = typeof UserConfig.Type

const STRICT = { onExcessProperty: 'error', errors: 'all' } as const

export const decodeProjectConfig = (input: unknown): ProjectConfig =>
  Schema.decodeUnknownSync(ProjectConfig)(input, STRICT)
export const decodeUserConfig = (input: unknown): UserConfig =>
  Schema.decodeUnknownSync(UserConfig)(input, STRICT)

export const defaultProjectConfig: ProjectConfig = {
  version: 1,
  project: { name: 'my-app', defaultBranch: 'main' },
  workspace: { runtime: 'local', copyIgnored: ['.env', '.env.local'], retainDays: 7 },
  providers: { claude: { executable: 'claude', settingSources: ['user', 'project', 'local'] } },
  employees: {
    developer: {
      name: 'Developer',
      provider: 'claude',
      model: 'claude-opus-5-5',
      effort: 'medium',
      prompt: './.bytebureau/employees/developer.md',
      permissionMode: 'supervised',
      tools: { allow: [], deny: [] },
      skills: [],
      askTimeout: '30m',
      appearance: {},
    },
  },
  defaults: { employee: 'developer', branch: 'main' },
  plugins: [],
  logging: { level: 'info' },
}
```

`packages/protocol/src/json-schema.ts`:
```ts
import { JsonSchema, Schema } from 'effect'
import { ProjectConfig } from './config.js'
import { EventEnvelope, KernelEventSchemas } from './events.js'

const CONFIG_ID = 'https://bytebureau.dev/schema/v1/config.json'
const EVENTS_ID = 'https://bytebureau.dev/schema/v1/events.json'

/** JSON Schema (draft 2020-12) of the project configuration file */
export function configJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(ProjectConfig, { onExcessProperty: 'error' })
  return {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
    $id: CONFIG_ID,
    ...document.schema,
    $defs: document.definitions,
  }
}

/** JSON Schema (draft 2020-12) of the event envelope and of each kernel event payload, keyed by wire type */
export function eventsJsonSchema(): Record<string, unknown> {
  const envelope = Schema.toJsonSchemaDocument(EventEnvelope, { onExcessProperty: 'error' })
  const defs: Record<string, unknown> = { EventEnvelope: envelope.schema, ...envelope.definitions }
  for (const [type, schema] of Object.entries(KernelEventSchemas)) {
    const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: 'error' })
    defs[type] = document.schema
    Object.assign(defs, document.definitions)
  }
  return {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
    $id: EVENTS_ID,
    $ref: '#/$defs/EventEnvelope',
    $defs: defs,
  }
}
```
`packages/protocol/scripts/generate-json-schema.ts`:
```ts
#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { configJsonSchema, eventsJsonSchema } from '../src/json-schema.js'

const out = path.join(import.meta.dirname, '..', 'schemas')
mkdirSync(out, { recursive: true })
writeFileSync(
  path.join(out, 'config.json'),
  `${JSON.stringify(configJsonSchema(), undefined, 2)}\n`,
)
writeFileSync(
  path.join(out, 'events.json'),
  `${JSON.stringify(eventsJsonSchema(), undefined, 2)}\n`,
)
```
`packages/protocol/src/index.ts` re-exports everything from `common.js`, `employee.js`, `ask.js`, `agent-event.js`, `events.js`, `config.js`, `json-schema.js` (`export * from './common.js'` …; oxlint's `import/no-namespace`-style rules do not apply to re-exports, but `import/group-exports` is off by ruling).

- [ ] **Step 6: Generate, test, wire the gates, commit**

Run `bun install` (after adding `effect` 4.0.0), then `bun run --cwd packages/protocol build` (writes the two schema files; commit them), then `bunx vitest run --project protocol` → PASS (4 tests).
Wiring: `vitest.config.ts` projects gain `'packages/protocol'`; `knip.ts` gains `'packages/protocol': { entry: ['scripts/*.ts'], project: ['src/**/*.ts', 'scripts/**/*.ts'] }`; `turbo.json` gains `"@bytebureau/protocol#build": { "outputs": ["schemas/**"] }` so `bun run build` regenerates the schemas; `scripts/license.test.ts` learns the MIT manifest set (Task 2 extends it); `.oxlintrc.jsonc` tunes `new-cap` (`properties: false`) and turns `no-redeclare` off under the three Effect packages and `no-barrel-file` off for package entry points (Effect idioms), `.oxfmtrc.json` ignores `packages/protocol/schemas/**`, `semantic-pr.yml` gains the `protocol` scope. Numbers are `Schema.Int` (counts, `seq`, tokens, bytes, ports, `retainDays`, `maxTurns`) or `Schema.Finite` (percentages, costs): `Schema.Number` would publish `"NaN"`/`"Infinity"` as valid. Run `bun run check` → green.

```bash
git add .oxlintrc.jsonc .oxfmtrc.json
git commit -m "chore(repo): allow effect idioms in oxlint and ignore generated schemas in oxfmt"
git add packages/tsconfig packages/protocol vitest.config.ts knip.ts turbo.json scripts/license.test.ts bun.lock cspell-words.txt .github/workflows/semantic-pr.yml
git commit -m "feat(protocol): add event, ask, employee and config schemas with generated json schema"
```

### Task 2: `packages/plugin-api` — ports and the plugin contract (plain TypeScript, MIT)

**Files:**
- Create: `packages/plugin-api/package.json`, `packages/plugin-api/tsconfig.json`, `packages/plugin-api/vitest.config.ts`, `packages/plugin-api/src/index.ts`, `packages/plugin-api/src/ports.ts`, `packages/plugin-api/src/plugin.ts`, `packages/plugin-api/src/logger.ts`, `packages/plugin-api/src/plugin.test.ts`
- Modify: `vitest.config.ts` (add the project), `knip.ts` (add the workspace), `scripts/license.test.ts` (MIT manifests), `.github/workflows/semantic-pr.yml` (`plugin-api` scope), `.oxlintrc.jsonc` (`typescript/method-signature-style` off under `packages/plugin-api/src/**`: ports and the plugin contract are implemented by classes and need bivariant parameters so `Plugin<Config>` assigns to `Plugin`), `cspell-words.txt` (`bivariant`)

**Interfaces:**
- Consumes: the protocol types from Task 1 (`EmployeeSpec`, `PromptInput`, `Ask`, `AskAnswer`, `AgentEvent`, `KernelEvent`, `Effort`, `PermissionMode`) — type-only imports, so no Effect code is loaded at runtime.
- Produces: every port and plugin type listed in the table above; `definePlugin` is the identity function plugins call.

- [ ] **Step 1: Package manifests**

`packages/plugin-api/package.json`:
```json
{
  "name": "@bytebureau/plugin-api",
  "version": "0.0.0",
  "private": true,
  "description": "Ports and plugin contract for ByteBureau plugins (plain TypeScript, no Effect)",
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
    "@standard-schema/spec": "1.1.0"
  },
  "devDependencies": {
    "@bytebureau/tsconfig": "workspace:*"
  }
}
```
`packages/plugin-api/tsconfig.json` (extends `effect.json`: TypeScript checks the symlinked protocol sources as program files, and Effect-derived types fail under `isolatedDeclarations`):
```json
{
  "extends": "@bytebureau/tsconfig/effect.json",
  "compilerOptions": { "types": ["bun"] },
  "include": ["src/**/*.ts"]
}
```
`packages/plugin-api/vitest.config.ts`:
```ts
import { defineProject } from 'vitest/config'

export default defineProject({
  test: { name: 'plugin-api', include: ['src/**/*.test.ts'] },
})
```

- [ ] **Step 2: Write the failing test**

`packages/plugin-api/src/plugin.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { definePlugin, type Plugin, type PluginManifest } from './plugin.js'

describe(definePlugin, () => {
  it('returns the plugin object unchanged so the host can read its manifest', () => {
    const testManifest: PluginManifest & {
      readonly contributes: Partial<
        Readonly<Record<'agentProviders' | 'workspaceRuntimes' | 'secretStores', readonly string[]>>
      >
    } = {
      name: 'example',
      version: '1.0.0',
      hostApi: '^0',
      kind: 'in-process',
      contributes: { agentProviders: ['example'] },
    }
    const plugin: Plugin = { manifest: testManifest, setup: () => ({}) }
    const result = definePlugin(plugin)
    expect(result).toBe(plugin)
    expect(testManifest.contributes.agentProviders).toStrictEqual(['example'])
  })

  it('typed plugins are assignable to the plugin registry', () => {
    interface MyConfig {
      readonly flag: boolean
    }
    const manifest: PluginManifest = {
      name: 'typed',
      version: '1.0.0',
      hostApi: '^0',
      kind: 'in-process',
    }
    const typedPlugin = definePlugin<MyConfig>({
      manifest,
      setup: (context): { readonly dispose: () => Promise<void> } => ({
        dispose: async (): Promise<void> => {
          await Promise.resolve(context.config.flag)
        },
      }),
    })
    const registry: readonly Plugin[] = [typedPlugin]
    expect(registry).toHaveLength(1)
  })
})
```
Run: `bunx vitest run --project plugin-api`
Expected: FAIL (module `./plugin.js` not found).

- [ ] **Step 3: Ports**

`packages/plugin-api/src/logger.ts`:
```ts
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  readonly category: readonly string[]
  debug(message: string, properties?: Readonly<Record<string, unknown>>): void
  info(message: string, properties?: Readonly<Record<string, unknown>>): void
  warn(message: string, properties?: Readonly<Record<string, unknown>>): void
  error(message: string, properties?: Readonly<Record<string, unknown>>): void
  child(name: string): Logger
}
```

`packages/plugin-api/src/ports.ts`:
```ts
import type { AgentEvent, AskAnswer, Effort, EmployeeSpec, PromptInput } from '@bytebureau/protocol'
import type { Logger } from './logger.js'

export interface ProfileRef {
  readonly id: string
  readonly providerId: string
  readonly kind: 'login' | 'api_key'
  readonly configDir?: string | undefined
}

export type AuthState = 'loggedIn' | 'loggedOut' | 'expired' | 'unknown'

export interface AuthStatus {
  readonly state: AuthState
  readonly hint?: string | undefined
  readonly account?: string | undefined
}

export interface ModelInfo {
  readonly id: string
  readonly displayName: string
  readonly contextWindow?: number | undefined
}

export interface AgentCapabilities {
  readonly resume: boolean
  readonly interrupt: boolean
  readonly askUser: boolean
  readonly permissions: boolean
  readonly structuredOutput: boolean
  readonly usage: boolean
  readonly rateLimits: boolean
  readonly contextUsage: boolean
  readonly thinking: boolean
  readonly setModel: boolean
  readonly setEffort: boolean
  readonly attachments: boolean
}

export interface ExternalSessionRef {
  readonly providerId: string
  readonly ref: string
}

export interface CreateSessionRequest {
  readonly sessionId: string
  readonly workspace: { readonly path: string }
  readonly employee: EmployeeSpec
  readonly profile: ProfileRef
  readonly resume?: ExternalSessionRef | undefined
  readonly env: Readonly<Record<string, string>>
  readonly signal: AbortSignal
  readonly logger: Logger
}

export interface AgentSession {
  readonly externalRef: ExternalSessionRef | null
  prompt(input: PromptInput): Promise<void>
  interrupt(): Promise<void>
  answer(askId: string, answer: AskAnswer): Promise<void>
  setModel?(model: string): Promise<void>
  setEffort?(effort: Effort): Promise<void>
  events(): AsyncIterable<AgentEvent>
  close(): Promise<void>
}

export interface AgentProvider {
  readonly id: string
  readonly displayName: string
  readonly capabilities: AgentCapabilities
  authStatus(profile: ProfileRef): Promise<AuthStatus>
  listModels?(profile: ProfileRef): Promise<ModelInfo[]>
  createSession(request: CreateSessionRequest): Promise<AgentSession>
}

export type WorkspaceIsolation = 'none' | 'process' | 'container' | 'vm'

export interface WorkspaceSpec {
  readonly sessionId: string
  readonly projectPath: string
  readonly baseBranch: string
  readonly branch: string
  readonly copyIgnored: readonly string[]
  readonly logger: Logger
}

export interface WorkspaceHandle {
  readonly id: string
  readonly runtimeId: string
  readonly path: string
  readonly branch: string
  readonly baseRef: string
}

export interface WorkspaceStatus {
  readonly dirty: boolean
  readonly ahead: number
  readonly behind: number
  readonly locked: boolean
  readonly branch: string
}

export interface ExecSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
}

export interface ExecHandle {
  readonly pid: number
  readonly stdout: AsyncIterable<string>
  readonly stderr: AsyncIterable<string>
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>
  kill(signal?: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): void
}

export interface WorkspaceRuntime {
  readonly id: string
  readonly isolation: WorkspaceIsolation
  provision(spec: WorkspaceSpec): Promise<WorkspaceHandle>
  exec(handle: WorkspaceHandle, spec: ExecSpec): Promise<ExecHandle>
  status(handle: WorkspaceHandle): Promise<WorkspaceStatus>
  destroy(handle: WorkspaceHandle, options?: { readonly force?: boolean }): Promise<void>
}

export interface SecretStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}
```

- [ ] **Step 4: Plugin contract**

`packages/plugin-api/src/plugin.ts`:
```ts
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Ask, AskAnswer, KernelEvent, PromptInput } from '@bytebureau/protocol'
import type { Logger } from './logger.js'
import type { AgentProvider, ExecHandle, ExecSpec, SecretStore, WorkspaceRuntime } from './ports.js'

export type PluginKind = 'in-process' | 'subprocess' | 'mcp' | 'acp' | 'wasm'
export type PluginCapability = 'fs:read' | 'fs:write' | 'net' | 'process' | 'secrets' | 'ui'
export type PortId = 'agentProviders' | 'workspaceRuntimes' | 'secretStores'

export interface PluginManifest {
  readonly name: string
  readonly version: string
  readonly displayName?: string | undefined
  readonly description?: string | undefined
  readonly hostApi: string
  readonly kind: PluginKind
  readonly entry?: string | undefined
  readonly capabilities?: readonly PluginCapability[] | undefined
  readonly config?: StandardSchemaV1 | undefined
  readonly secrets?:
    | Readonly<Record<string, { readonly title: string; readonly description?: string }>>
    | undefined
  readonly contributes?: Partial<Readonly<Record<PortId, readonly string[]>>> | undefined
}

export interface ProjectInfo {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly defaultBranch: string
}

export interface PluginEvents {
  publish(event: KernelEvent): Promise<void>
  subscribe(filter: {
    readonly types?: readonly string[]
    readonly sessionId?: string
  }): AsyncIterable<KernelEvent>
}

export interface PluginKv {
  get<Type = unknown>(key: string): Promise<Type | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

export interface ProcessSpawner {
  spawn(spec: ExecSpec & { readonly cwd: string }): Promise<ExecHandle>
}

export interface PluginContext<Config = unknown> {
  readonly config: Config
  readonly project: ProjectInfo | null
  readonly logger: Logger
  readonly events: PluginEvents
  readonly secrets: SecretStore
  readonly kv: PluginKv
  readonly process: ProcessSpawner
  readonly http: typeof fetch
  readonly signal: AbortSignal
}

export type Hook<Input, Result> = (
  input: Readonly<Input>,
  next: (input: Input) => Promise<Result>,
) => Promise<Result>

export interface SessionCreateInput {
  readonly projectId: string
  readonly employeeId: string
  readonly providerId: string
  readonly title: string
}
export interface AgentSpawnInput {
  readonly sessionId: string
  readonly providerId: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}
export type AgentSpawnResult = AgentSpawnInput | { readonly deny: string }
export interface AskOpenInput {
  readonly ask: Ask
}
export type AskOpenResult = { readonly ask: Ask } | { readonly answer: AskAnswer }
export interface PromptSendInput {
  readonly sessionId: string
  readonly input: PromptInput
}

export interface Hooks {
  readonly 'session.beforeCreate': Hook<SessionCreateInput, SessionCreateInput>
  readonly 'agent.beforeSpawn': Hook<AgentSpawnInput, AgentSpawnResult>
  readonly 'ask.beforeOpen': Hook<AskOpenInput, AskOpenResult>
  readonly 'prompt.beforeSend': Hook<PromptSendInput, PromptSendInput>
  readonly 'event.beforePublish': Hook<KernelEvent, void>
}

export interface PluginRegistration {
  readonly agentProviders?: readonly AgentProvider[] | undefined
  readonly workspaceRuntimes?: readonly WorkspaceRuntime[] | undefined
  readonly secretStores?: readonly SecretStore[] | undefined
  readonly hooks?: Partial<Hooks> | undefined
  dispose?(): Promise<void>
}

export interface Plugin<Config = unknown> {
  readonly manifest: PluginManifest
  setup(context: PluginContext<Config>): Promise<PluginRegistration> | PluginRegistration
}

/** Returns the plugin object unchanged so the host can read its manifest. */
export function definePlugin<Config>(plugin: Plugin<Config>): Plugin<Config> {
  return plugin
}
```

`packages/plugin-api/src/index.ts`:
```ts
export type { LogLevel, Logger } from './logger.js'
export type {
  AgentCapabilities,
  AgentProvider,
  AgentSession,
  AuthState,
  AuthStatus,
  CreateSessionRequest,
  ExecHandle,
  ExecSpec,
  ExternalSessionRef,
  ModelInfo,
  ProfileRef,
  SecretStore,
  WorkspaceHandle,
  WorkspaceIsolation,
  WorkspaceRuntime,
  WorkspaceSpec,
  WorkspaceStatus,
} from './ports.js'
export {
  definePlugin,
  type AgentSpawnInput,
  type AgentSpawnResult,
  type AskOpenInput,
  type AskOpenResult,
  type Hook,
  type Hooks,
  type Plugin,
  type PluginCapability,
  type PluginContext,
  type PluginEvents,
  type PluginKind,
  type PluginKv,
  type PluginManifest,
  type PluginRegistration,
  type PortId,
  type ProcessSpawner,
  type ProjectInfo,
  type PromptSendInput,
  type SessionCreateInput,
} from './plugin.js'
export type {
  AgentEvent,
  Ask,
  AskAnswer,
  AskOption,
  AskQuestion,
  Effort,
  EmployeeSpec,
  KernelEvent,
  PermissionMode,
  PromptInput,
} from '@bytebureau/protocol'
```

- [ ] **Step 5: Run the test, wire the gates**

Run: `bunx vitest run --project plugin-api` → PASS (2 tests: identity, and a typed `Plugin<MyConfig>` assigned to `readonly Plugin[]`, which only compiles with method signatures).

`vitest.config.ts` (root): add `'packages/plugin-api'` to `projects` after `'packages/protocol'`.
`knip.ts`: add `'packages/plugin-api': { project: ['src/**/*.ts'] }` to `workspaces`.
`.github/workflows/semantic-pr.yml`: add `plugin-api` to the `scopes` list (the settings parity test compares it with commitlint's computed scope set).
`scripts/license.test.ts`: the "every manifest" test currently expects `FSL-1.1-MIT` for every manifest; change it to expect `MIT` for `packages/plugin-api/package.json` and `packages/protocol/package.json` (a `MIT_MANIFESTS` set) and `FSL-1.1-MIT` for all others, and extend the enumeration with `plugins/*/package.json`.

Run: `bun install && bun run check`
Expected: green (the new workspace typechecks under Turborepo, knip reports nothing, the licence test passes with the two MIT manifests).

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-api vitest.config.ts knip.ts scripts/license.test.ts bun.lock .github/workflows/semantic-pr.yml .oxlintrc.jsonc cspell-words.txt
git commit -m "feat(plugin-api): define the agent, workspace and secret ports and the plugin contract"
```

### Task 3: `packages/kernel` scaffold and the `Store` (Effect SQL on SQLite, embedded migrations)

**Files:**
- Create: `packages/kernel/package.json`, `packages/kernel/tsconfig.json`, `packages/kernel/vitest.config.ts`, `packages/kernel/src/index.ts`, `packages/kernel/src/bun.ts`, `packages/kernel/src/store/migrations.ts`, `packages/kernel/src/store/migrate.ts`, `packages/kernel/src/store/pragmas.ts`, `packages/kernel/src/store/store-live.ts`, `packages/kernel/src/store/store-test.ts`, `packages/kernel/src/store/migrate.test.ts`
- Modify: `vitest.config.ts`, `knip.ts`, `.dependency-cruiser.cjs` (no rule change needed; verify the run), `scripts/license.test.ts` (nothing: FSL)

**Interfaces:**
- Consumes: `effect/sql` `SqlClient` (verified: `yield* SqlClient.SqlClient`, tagged template queries, `sql.withTransaction`), `@effect/sql-sqlite-bun` and `@effect/sql-sqlite-node` `SqliteClient.layer({ filename, busyTimeout })` (both 4.0.0, identical behaviour; the Bun one statically imports `bun:sqlite` and must never be imported under Vitest).
- Produces: `StoreLive(filename: string): Layer<SqlClient.SqlClient>` (exported only from `src/bun.ts`), `StoreTest: Layer<SqlClient.SqlClient>` (in-memory, exported from `src/store/store-test.ts` for tests), `runMigrations: Effect<void, SqlError, SqlClient.SqlClient>`, `MIGRATIONS`, `applyPragmas`.

Why Effect SQL and not Drizzle at runtime (ADR-0010, written in Task 16): Drizzle's Effect drivers do not load against `effect@4.0.0` and its `node:sqlite` driver exists only in the `1.0.0-rc` line; `@effect/sql-sqlite-{bun,node}` 4.0.0 give one `SqlClient` API on both runtimes, and migrations as embedded SQL strings need no file system inside the compiled binary.

- [ ] **Step 1: Manifests**

`packages/kernel/package.json`:
```json
{
  "name": "@bytebureau/kernel",
  "version": "0.0.0",
  "private": true,
  "description": "ByteBureau kernel: Effect services for sessions, workspaces, asks, events and plugins",
  "license": "FSL-1.1-MIT",
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    },
    "./bun": {
      "types": "./src/bun.ts",
      "default": "./src/bun.ts"
    }
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@bytebureau/plugin-api": "workspace:*",
    "@bytebureau/protocol": "workspace:*",
    "@effect/sql-sqlite-bun": "4.0.0",
    "@logtape/file": "2.3.10",
    "@logtape/logtape": "2.3.10",
    "@logtape/redaction": "2.3.10",
    "c12": "4.0.0-rc.2",
    "effect": "4.0.0",
    "uuid": "14.0.2"
  },
  "devDependencies": {
    "@bytebureau/tsconfig": "workspace:*",
    "@effect/sql-sqlite-node": "4.0.0",
    "@effect/vitest": "4.0.0"
  }
}
```
(`@bytebureau/workspace-local` joins the dependencies in Task 11, when the plugin package exists and the kernel starts bundling it; the dependency-cruiser rules forbid `plugins → packages` except the contracts and `anything → apps`, so `packages/kernel → plugins/*` is allowed.)

`packages/kernel/tsconfig.json`:
```json
{
  "extends": "@bytebureau/tsconfig/effect.json",
  "compilerOptions": { "types": ["bun"] },
  "include": ["src/**/*.ts"]
}
```
(`bun` types cover the `node:` modules the kernel imports; add `@types/node` only if `tsc` reports a missing Node-only type.)
`packages/kernel/vitest.config.ts`:
```ts
import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'kernel',
    include: ['src/**/*.test.ts'],
    // The node:sqlite module is release-candidate stability on Node 24; its warning is noise in test output
    execArgv: ['--disable-warning=ExperimentalWarning'],
    testTimeout: 20_000,
  },
})
```
If `execArgv` is rejected by the installed Vitest 5 config types, use `poolOptions: { forks: { execArgv: [...] } }`.

- [ ] **Step 2: Failing migration test**

`packages/kernel/src/store/migrate.test.ts`:
```ts
import { assert, it } from '@effect/vitest'
import { Effect, Result } from 'effect'
import { SqlClient } from 'effect/sql'
import { MIGRATIONS, runMigrations } from './migrate.js'
import { StoreTest } from './store-test.js'

const SP1_TABLES = [
  'projects',
  'profiles',
  'sessions',
  'turns',
  'messages',
  'tool_calls',
  'asks',
  'events',
  'usage_snapshots',
  'plugin_kv',
]

it.layer(StoreTest)('Store', (suite) => {
  suite.effect('applies every migration once and records them', () =>
    Effect.gen(function* recordsMigrations() {
      const sql = yield* SqlClient.SqlClient
      const applied = yield* sql<{ readonly id: string }>`SELECT id FROM bb_migrations ORDER BY id`
      assert.deepStrictEqual(
        applied.map((row) => row.id),
        MIGRATIONS.map((migration) => migration.id),
      )
      yield* runMigrations
      const again = yield* sql<{
        readonly total: number
      }>`SELECT count(*) AS total FROM bb_migrations`
      assert.deepStrictEqual(
        again.map((row) => row.total),
        [MIGRATIONS.length],
      )
    }),
  )

  suite.effect('creates the SP1 tables with foreign keys enforced', () =>
    Effect.gen(function* enforcesForeignKeys() {
      const sql = yield* SqlClient.SqlClient
      const tables = yield* sql<{
        readonly name: string
      }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
      const names = tables.map((row) => row.name)
      for (const expected of SP1_TABLES) {
        assert.include(names, expected)
      }
      const fk = yield* sql<{ readonly foreign_keys: number }>`PRAGMA foreign_keys`
      assert.deepStrictEqual(
        fk.map((row) => row.foreign_keys),
        [1],
      )
      const orphan = yield* Effect.result(
        sql`INSERT INTO sessions (id, project_id, title, employee_json, provider_id, profile_id, workspace_json, status, created_at) VALUES ('s', 'missing', 't', '{}', 'fake', NULL, '{}', 'created', '2026-10-02T00:00:00.000Z')`,
      )
      assert.isTrue(Result.isFailure(orphan))
    }),
  )
})
```
Run: `bunx vitest run --project kernel` → FAIL (modules missing).

- [ ] **Step 3: Migrations, pragmas, layers**

`packages/kernel/src/store/migrations.ts`:
```ts
export interface Migration {
  readonly id: string
  readonly sql: string
}

// Spec §5.2; one statement per line group so SQLite executes them in order
export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_initial',
    sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('login', 'api_key')),
  config_dir TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  employee_json TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  profile_id TEXT REFERENCES profiles(id),
  workspace_json TEXT NOT NULL,
  external_ref TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  parent_session_id TEXT REFERENCES sessions(id)
);
CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  idx INTEGER NOT NULL,
  prompt_json TEXT NOT NULL,
  status TEXT NOT NULL,
  stop_reason TEXT,
  usage_json TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT REFERENCES turns(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT REFERENCES turns(id),
  tool_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_summary TEXT,
  input_bytes INTEGER NOT NULL DEFAULT 0,
  output_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error_type TEXT
);
CREATE TABLE asks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT REFERENCES turns(id),
  kind TEXT NOT NULL CHECK (kind IN ('question', 'permission')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  answer_json TEXT,
  recommendation_source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deadline_at TEXT,
  answered_at TEXT,
  answered_via TEXT
);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  project_id TEXT,
  session_id TEXT,
  turn_id TEXT,
  work_item_id TEXT,
  trace_id TEXT,
  span_id TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX events_session_seq ON events(session_id, seq);
CREATE INDEX events_project_seq ON events(project_id, seq);
CREATE TABLE usage_snapshots (
  profile_id TEXT NOT NULL,
  five_hour_pct REAL,
  five_hour_resets_at TEXT,
  seven_day_pct REAL,
  seven_day_resets_at TEXT,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE TABLE plugin_kv (
  plugin_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)
);
`,
  },
]
```
Note the `turns.index` column from the spec is named `idx` (`INDEX` is reserved in SQLite); the DTO field stays `index`.

`packages/kernel/src/store/migrate.ts`:
```ts
import { Effect } from 'effect'
import { SqlClient, type SqlError } from 'effect/sql'
import { MIGRATIONS, type Migration } from './migrations.js'

export { MIGRATIONS } from './migrations.js'

function statements(migration: Migration): readonly string[] {
  return migration.sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '')
}

const applyOne = (
  sql: SqlClient.SqlClient,
  migration: Migration,
): Effect.Effect<void, SqlError.SqlError> =>
  sql.withTransaction(
    Effect.gen(function* applyMigration() {
      for (const statement of statements(migration)) {
        yield* sql.unsafe(statement)
      }
      yield* sql`INSERT INTO bb_migrations (id, applied_at) VALUES (${migration.id}, ${new Date().toISOString()})`
    }),
  )

// Idempotent: every migration runs once, inside its own transaction, in array order
export const runMigrations: Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> =
  Effect.gen(function* runPending() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE IF NOT EXISTS bb_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`
    const applied = yield* sql<{ readonly id: string }>`SELECT id FROM bb_migrations`
    const done = new Set(applied.map((row) => row.id))
    for (const migration of MIGRATIONS) {
      if (!done.has(migration.id)) {
        yield* applyOne(sql, migration)
      }
    }
  })
```
(`sql.unsafe(statement)` executes a raw string — verify the method name in `effect/sql/SqlClient` d.ts; the fact sheet confirms the tagged form; `unsafe` is the documented raw-string entry point of `SqlClient`. If absent, use `sql.unsafe` → `Statement.unsafe`.)

`packages/kernel/src/store/pragmas.ts`:
```ts
import { Effect } from 'effect'
import { SqlClient, type SqlError } from 'effect/sql'

// The sqlite layers set journal_mode=WAL and busy_timeout themselves; these are the remaining spec pragmas
export const applyPragmas: Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> = Effect.gen(
  function* setPragmas() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`PRAGMA foreign_keys = ON`
    yield* sql`PRAGMA synchronous = NORMAL`
  },
)
```
`packages/kernel/src/store/store-live.ts` (Bun only; imported solely through `src/bun.ts`):
```ts
import { SqliteClient } from '@effect/sql-sqlite-bun'
import { Effect, Layer } from 'effect'
import type { SqlClient } from 'effect/sql'
import { runMigrations } from './migrate.js'
import { applyPragmas } from './pragmas.js'

export const StoreLive = (filename: string): Layer.Layer<SqlClient.SqlClient> =>
  Layer.effectDiscard(Effect.andThen(applyPragmas, runMigrations)).pipe(
    Layer.provideMerge(SqliteClient.layer({ filename, busyTimeout: 5000 })),
    Layer.orDie,
  )
```
`packages/kernel/src/store/store-test.ts`:
```ts
import { SqliteClient } from '@effect/sql-sqlite-node'
import { Effect, Layer } from 'effect'
import type { SqlClient } from 'effect/sql'
import { runMigrations } from './migrate.js'
import { applyPragmas } from './pragmas.js'

export const StoreTest: Layer.Layer<SqlClient.SqlClient> = Layer.effectDiscard(
  Effect.andThen(applyPragmas, runMigrations),
).pipe(Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })), Layer.orDie)
```
`Layer.provideMerge` keeps `SqlClient` in the output while `Layer.effectDiscard` runs the pragmas and migrations once per layer build (verified semantics in the fact sheet §1.4). `SqliteClient.layer` may require `Scope` handling (`Layer.effect` already scopes); if the layer's error channel is `ConfigError`, map it with `Layer.orDie`.

`packages/kernel/src/index.ts` (grows in later tasks): `export { runMigrations, MIGRATIONS } from './store/migrate.js'` plus the re-exports added by Tasks 4–14.
`packages/kernel/src/bun.ts`: `export { StoreLive } from './store/store-live.js'` plus `createKernel` from Task 14.

- [ ] **Step 4: Run, wire, commit**

Run: `bunx vitest run --project kernel` → PASS (2 tests). `vitest.config.ts`: add `'packages/kernel'`; `knip.ts`: `'packages/kernel': { entry: ['src/index.ts', 'src/bun.ts'], project: ['src/**/*.ts'] }` (the `bun` entry keeps `store-live.ts` from being reported unused); `.github/workflows/semantic-pr.yml`: add `kernel` to `scopes`. Run `bun run check` → green; dependency-cruiser must report no `effect` import outside the three core packages (it also confirms `packages/kernel → plugins/workspace-local` is allowed).

```bash
git add packages/kernel vitest.config.ts knip.ts bun.lock
git commit -m "feat(kernel): scaffold the kernel package with an effect sql store and embedded migrations"
```

### Task 4: ids, tagged errors, logging (LogTape with the Effect bridge) and redaction

**Files:**
- Create: `packages/kernel/src/ids.ts`, `packages/kernel/src/errors.ts`, `packages/kernel/src/logging/redaction.ts`, `packages/kernel/src/logging/logging.ts`, `packages/kernel/src/ids.test.ts`, `packages/kernel/src/logging/redaction.test.ts`, `packages/kernel/src/logging/logging.test.ts`
- Modify: `packages/kernel/src/index.ts`

**Interfaces:**
- Produces: `uuidv7(): string`, `nowIso(): string`; error classes `ConfigError { file, pointer, reason }`, `StoreError { cause }`, `WorkspaceError { code, reason }`, `ProviderError { kind, reason, retryable }`, `AskError { code, reason }`, `PluginError { name, reason }`, `SessionError { code, reason }` (all `Data.TaggedError`, `_tag` equals the class name); `LoggingOptions { level, debug?, file?, json }`, `configureLogging(options): Promise<void>`, `kernelLogger(category: readonly string[]): Logger` (the plugin-api `Logger` over LogTape), `EffectLoggerLive: Layer<never>` (routes Effect logs into LogTape), `REDACTED_FIELDS`, `SECRET_PATTERNS`, `redactFields(sink)`, `redactText(formatter)`.

Verified facts (fact sheet §6, §7): LogTape levels are `trace < debug < info < warning < error < fatal`; `redactByField` wraps a sink and `redactByPattern` wraps a formatter; a bridged record must carry `message: [text]` and a `rawMessage` with braces escaped; Effect's `References.MinimumLogLevel` defaults to `Info`; `uuid@14.0.2` `v7()` is monotonic.

- [ ] **Step 1: Failing tests**

`packages/kernel/src/ids.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { nowIso, uuidv7 } from './ids.js'

describe(uuidv7, () => {
  it('produces time-ordered v7 ids', () => {
    const ids = Array.from({ length: 2000 }, () => uuidv7())
    expect(
      ids.every((id) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id),
      ),
    ).toBe(true)
    expect(ids.toSorted()).toStrictEqual(ids)
  })
})

describe(nowIso, () => {
  it('is ISO-8601 UTC with milliseconds', () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  })
})
```
`packages/kernel/src/logging/redaction.test.ts` (canary secrets never appear in output):
```ts
import { jsonLinesFormatter, type LogRecord } from '@logtape/logtape'
import { describe, expect, it } from 'vitest'
import { REDACTED_FIELDS, redactFields, redactText, SECRET_PATTERNS } from './redaction.js'

const record = (properties: Record<string, unknown>, message = 'hello'): LogRecord => ({
  category: ['bb', 'test'],
  level: 'info',
  message: [message],
  rawMessage: message,
  timestamp: 0,
  properties,
})

const SECRET_NAMES = [
  'authorization',
  'Cookie',
  'password',
  'passphrase',
  'accessToken',
  'x-api-key',
  'clientSecret',
  'private_key',
  'ANTHROPIC_API_KEY',
]
const ORDINARY_NAMES = ['sessionId', 'category', 'status', 'durationMs']

const SECRET_SAMPLES = [
  'sk-ant-api03-canary',
  'sk-proj-canary1234',
  'ghp_canary1234',
  'github_pat_canary',
  'xoxb-1-canary',
  'AKIAIOSFODNN7CANARY',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc',
  '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----',
  'https://user:pw@example.com/x',
]
const ORDINARY_TEXT =
  '2026-10-02T12:00:00.000Z bb.store session 0199c2f1-7a3b-7c11-8f3e-2b1d4c5e6f70 task-12345678 risk-assessment /src/index.ts'

describe(redactFields, () => {
  it('drops secret-looking property names at any depth', () => {
    const seen: LogRecord[] = []
    const sink = redactFields((entry) => {
      seen.push(entry)
    })
    sink(
      record({
        apiKey: 'sk-ant-canary',
        nested: { authorization: 'Bearer x', keep: 1 },
        ANTHROPIC_API_KEY: 'y',
      }),
    )
    const properties = JSON.stringify(seen.map((entry) => entry.properties))
    expect(properties).not.toMatch(/canary|Bearer|ANTHROPIC/u)
    expect(properties).toContain('"keep":1')
  })
})

describe(redactText, () => {
  it('rewrites tokens, keys, JWTs, PEM blocks and URL credentials in formatted output', () => {
    expect.hasAssertions()
    const format = redactText(jsonLinesFormatter)
    const text = format(
      record(
        {},
        'sk-ant-api03-canary ghp_canary1234 github_pat_canary xoxb-1-canary AKIAIOSFODNN7CANARY eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc https://user:pw@example.com/x -----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----',
      ),
    )
    for (const canary of [
      'sk-ant-api03-canary',
      'ghp_canary1234',
      'github_pat_canary',
      'xoxb-1-canary',
      'AKIAIOSFODNN7CANARY',
      'eyJhbGciOiJIUzI1NiJ9',
      'user:pw@',
      'MIIE',
    ]) {
      expect(text).not.toContain(canary)
    }
    expect(text).toContain('[REDACTED]')
  })
})

describe('the redacted field list', () => {
  it('has a sample name for every pattern', () => {
    expect(
      REDACTED_FIELDS.every((pattern) => SECRET_NAMES.some((name) => pattern.test(name))),
    ).toBe(true)
  })

  it('deletes the secret names and keeps the ordinary ones', () => {
    const seen: LogRecord[] = []
    const sink = redactFields((entry) => {
      seen.push(entry)
    })
    const properties = Object.fromEntries(
      [...SECRET_NAMES, ...ORDINARY_NAMES].map((name) => [name, 'v']),
    )
    sink(record(properties))
    expect(seen.flatMap((entry) => Object.keys(entry.properties))).toStrictEqual(ORDINARY_NAMES)
  })

  it('keeps token counters and deletes token credentials', () => {
    const seen: LogRecord[] = []
    const sink = redactFields((entry) => {
      seen.push(entry)
    })
    sink(
      record({
        inputTokens: 10,
        outputTokens: 4,
        maxTokens: 100,
        accessToken: 'x',
        api_token: 'y',
        TOKEN: 'z',
      }),
    )
    expect(seen.map((entry) => entry.properties)).toStrictEqual([
      { inputTokens: 10, outputTokens: 4, maxTokens: 100 },
    ])
  })
})

describe('the secret pattern list', () => {
  it('has a sample for every pattern and leaves ordinary log text alone', () => {
    expect.hasAssertions()
    for (const { pattern } of SECRET_PATTERNS) {
      expect(SECRET_SAMPLES.some((sample) => sample.search(pattern) !== -1)).toBe(true)
      expect(ORDINARY_TEXT.search(pattern)).toBe(-1)
    }
  })
})
```
`packages/kernel/src/logging/logging.test.ts`:
```ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getLogger, type LogRecord } from '@logtape/logtape'
import { Cause, Effect, Layer, type LogLevel, References } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import {
  configureLogging,
  EffectLoggerLive,
  effectToLogTape,
  kernelLogger,
  parseDebug,
  resetLogging,
  type LoggingOptions,
} from './logging.js'

// LogTape's configuration is global: each test configures it, runs its logging, collects the records and resets
async function captured(
  options: Omit<LoggingOptions, 'capture'>,
  logging: Effect.Effect<void>,
): Promise<readonly LogRecord[]> {
  const seen: LogRecord[] = []
  await configureLogging({
    ...options,
    capture: (entry) => {
      seen.push(entry)
    },
  })
  try {
    const layer = Layer.mergeAll(
      EffectLoggerLive,
      Layer.succeed(References.MinimumLogLevel, 'Debug'),
    )
    await Effect.runPromise(Effect.provide(logging, layer))
  } finally {
    await resetLogging()
  }
  return seen
}

const LEVELS: readonly LogLevel.LogLevel[] = [
  'All',
  'Trace',
  'Debug',
  'Info',
  'Warn',
  'Error',
  'Fatal',
  'None',
]

async function sinkOutputs(): Promise<readonly string[]> {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-logging-'))
  const file = path.join(dir, 'kernel.log')
  const info = vi.spyOn(console, 'info').mockReturnValue()
  try {
    await captured(
      { level: 'info', json: true, file },
      Effect.sync(() => {
        kernelLogger(['bb', 'sinks']).info('key sk-ant-api03-canary', {
          apiKey: 'field-only-value',
          keep: 1,
        })
      }),
    )
    return [readFileSync(file, 'utf8'), ...info.mock.calls.map((call) => String(call[0]))]
  } finally {
    info.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function failingSinkRun(): Promise<{
  readonly delivered: readonly unknown[]
  readonly reported: readonly string[]
}> {
  const capture = vi.fn<(record: LogRecord) => void>().mockImplementationOnce(() => {
    throw new Error('sink boom')
  })
  const error = vi.spyOn(console, 'error').mockReturnValue()
  try {
    await configureLogging({ level: 'info', json: true, capture })
    const logger = kernelLogger(['bb', 'sinks'])
    logger.info('first')
    logger.info('second')
    return {
      delivered: capture.mock.calls.map(([entry]) => entry.message[0]),
      reported: error.mock.calls.map((call) => String(call[0])),
    }
  } finally {
    await resetLogging()
    error.mockRestore()
  }
}

describe('effect bridge', () => {
  it('routes Effect logs into LogTape categories with annotations as properties', async () => {
    expect.hasAssertions()
    const seen = await captured(
      { level: 'debug', json: true },
      Effect.logDebug('from effect').pipe(
        Effect.annotateLogs({ category: 'bb.store', sessionId: 's1' }),
      ),
    )
    expect(
      seen.map((entry) => [entry.category.join('.'), entry.level, entry.message[0]]),
    ).toStrictEqual([['bb.store', 'debug', 'from effect']])
    expect(seen.map((entry) => entry.properties)).toMatchObject([{ sessionId: 's1' }])
  })

  it('keeps an Effect log message literal, in bb.core without a category annotation', async () => {
    expect.hasAssertions()
    const seen = await captured(
      { level: 'info', json: true },
      Effect.logInfo('literal {name} }} {{x}}', { count: 1 }),
    )
    expect(seen.map((entry) => [entry.category.join('.'), entry.message[0]])).toStrictEqual([
      ['bb.core', 'literal {name} }} {{x}} { count: 1 }'],
    ])
  })
})

describe('effect logger mapping', () => {
  it('maps every Effect level onto its LogTape level, drops None and stamps the Effect date', async () => {
    expect.hasAssertions()
    const date = new Date('2026-10-02T12:00:00.000Z')
    const seen = await captured(
      { level: 'trace', json: true },
      Effect.withFiber((fiber) =>
        Effect.sync(() => {
          for (const logLevel of LEVELS) {
            effectToLogTape.log({ message: [logLevel], logLevel, cause: Cause.empty, fiber, date })
          }
        }),
      ),
    )
    expect(seen.map((entry) => [entry.message[0], entry.level])).toStrictEqual([
      ['All', 'trace'],
      ['Trace', 'trace'],
      ['Debug', 'debug'],
      ['Info', 'info'],
      ['Warn', 'warning'],
      ['Error', 'error'],
      ['Fatal', 'fatal'],
    ])
    expect(new Set(seen.map((entry) => entry.timestamp))).toStrictEqual(new Set([date.getTime()]))
  })

  it('attaches a failure cause as a pretty-printed property', async () => {
    expect.hasAssertions()
    const seen = await captured(
      { level: 'info', json: true },
      Effect.logError('request failed', Cause.fail('upstream down')),
    )
    expect(seen.map((entry) => entry.message)).toStrictEqual([['request failed']])
    expect(seen.map((entry) => entry.properties['cause'])).toStrictEqual([
      expect.stringContaining('upstream down'),
    ])
  })
})

describe(configureLogging, () => {
  it('applies --debug category selection: listed categories at debug, negated ones silenced', async () => {
    expect.hasAssertions()
    const seen = await captured(
      { level: 'info', json: true, debug: 'bb.agent,!bb.store' },
      Effect.sync(() => {
        getLogger(['bb', 'agent', 'fake']).debug('agent detail')
        getLogger(['bb', 'store']).error('store error')
        getLogger(['bb', 'store']).fatal('store fatal')
        getLogger(['bb', 'store', 'sqlite']).error('sqlite error')
        getLogger(['bb', 'core']).debug('core detail')
      }),
    )
    expect(seen.map((entry) => entry.message[0])).toStrictEqual(['agent detail'])
  })

  it('reports a throwing sink on the console and keeps delivering to it', async () => {
    expect.hasAssertions()
    const { delivered, reported } = await failingSinkRun()
    expect(delivered).toStrictEqual(['first', 'second'])
    expect(reported).toHaveLength(1)
    expect(JSON.parse(reported.join(''))).toMatchObject({
      level: 'FATAL',
      logger: 'logtape.meta',
      properties: { error: { message: 'sink boom' } },
    })
  })

  it('redacts secrets in the console and file output', async () => {
    expect.hasAssertions()
    const outputs = await sinkOutputs()
    expect(outputs).toHaveLength(2)
    for (const output of outputs) {
      expect(output).toContain('"keep":1')
      expect(output).toContain('[REDACTED]')
      expect(output).not.toContain('canary')
      expect(output).not.toContain('field-only-value')
    }
  })
})

describe(kernelLogger, () => {
  it('logs the text literally at the mapped level under the child category, minus secret fields', async () => {
    expect.hasAssertions()
    const seen = await captured(
      { level: 'warn', json: true },
      Effect.sync(() => {
        const logger = kernelLogger(['bb', 'plugin']).child('demo')
        logger.info('dropped below the configured level')
        logger.warn('closing } missing', { count: 1, apiKey: 'field-only-value' })
        logger.error('hello {name}', { name: 'N' })
      }),
    )
    expect(
      seen.map((entry) => [entry.category.join('.'), entry.level, entry.message[0]]),
    ).toStrictEqual([
      ['bb.plugin.demo', 'warning', 'closing } missing'],
      ['bb.plugin.demo', 'error', 'hello {name}'],
    ])
    expect(seen.map((entry) => entry.properties)).toStrictEqual([{ count: 1 }, { name: 'N' }])
  })
})

describe(parseDebug, () => {
  it('maps an empty list and "true" to every bb category and splits lists into enabled and silenced', () => {
    const everything = { enabled: [['bb']], silenced: [] }
    expect(['', 'true'].map((flag) => parseDebug(flag))).toStrictEqual([everything, everything])
    expect(parseDebug(' bb.agent , !bb.store,,')).toStrictEqual({
      enabled: [['bb', 'agent']],
      silenced: [['bb', 'store']],
    })
  })
})
```
Run: `bunx vitest run --project kernel` → FAIL.

- [ ] **Step 2: Implementation**

`packages/kernel/src/ids.ts`:
```ts
import { v7 } from 'uuid'

export const uuidv7 = (): string => v7()
export const nowIso = (): string => new Date().toISOString()
```
`packages/kernel/src/errors.ts`:
```ts
import { Data } from 'effect'

export const ConfigError = Data.TaggedError('ConfigError')<{
  readonly file: string
  readonly pointer: string
  readonly reason: string
}>
export type ConfigError = InstanceType<typeof ConfigError>

export const StoreError = Data.TaggedError('StoreError')<{ readonly cause: unknown }>
export type StoreError = InstanceType<typeof StoreError>

export const WorkspaceError = Data.TaggedError('WorkspaceError')<{
  readonly code: string
  readonly reason: string
}>
export type WorkspaceError = InstanceType<typeof WorkspaceError>

export const ProviderError = Data.TaggedError('ProviderError')<{
  readonly kind: 'auth' | 'ratelimit' | 'crash' | 'protocol' | 'missing'
  readonly reason: string
  readonly retryable: boolean
}>
export type ProviderError = InstanceType<typeof ProviderError>

export const AskError = Data.TaggedError('AskError')<{
  readonly code: 'not_found' | 'not_pending' | 'invalid_answer'
  readonly reason: string
}>
export type AskError = InstanceType<typeof AskError>

export const PluginError = Data.TaggedError('PluginError')<{
  readonly name: string
  readonly reason: string
}>
export type PluginError = InstanceType<typeof PluginError>

export const SessionError = Data.TaggedError('SessionError')<{
  readonly code:
    | 'not_found'
    | 'invalid_transition'
    | 'provider_missing'
    | 'yolo_refused'
    | 'employee_missing'
  readonly reason: string
}>
export type SessionError = InstanceType<typeof SessionError>
```
`packages/kernel/src/logging/redaction.ts`:
```ts
import { redactByField, redactByPattern, type RedactionPattern } from '@logtape/redaction'
import type { Sink, TextFormatter } from '@logtape/logtape'

export const REDACTED_FIELDS: readonly RegExp[] = [
  /^authorization$/iu,
  /^cookie$/iu,
  /pass(?:word|phrase)?$/iu,
  /token$/iu,
  /api[_-]?key/iu,
  /secret/iu,
  /private[_-]?key/iu,
  /^(?:anthropic|openai|github|slack)_.*(?:key|token)$/iu,
]

const replacement = '[REDACTED]'
export const SECRET_PATTERNS: readonly RedactionPattern[] = [
  { pattern: /sk-ant-[A-Za-z0-9_-]{8,}/gu, replacement },
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/gu, replacement },
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/gu, replacement },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{4,}/gu, replacement },
  { pattern: /\bxox[abp]-[A-Za-z0-9-]{4,}/gu, replacement },
  { pattern: /\bAKIA[0-9A-Z]{12,}/gu, replacement },
  { pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{3,}/gu, replacement },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
    replacement,
  },
  {
    pattern: /(?<scheme>https?:\/\/)[^\s/@:]+:[^\s/@]+@/gu,
    replacement: `$<scheme>${replacement}@`,
  },
]

export const redactFields = (sink: Sink): Sink =>
  redactByField(sink, { fieldPatterns: [...REDACTED_FIELDS], action: 'delete' })
export const redactText = (formatter: TextFormatter): TextFormatter =>
  redactByPattern(formatter, SECRET_PATTERNS)
```
If `redactByField`'s options object uses a different key than `fieldPatterns`/`action` in the installed 2.3.10 types, follow the types (the fact sheet lists `{ fieldPatterns, action?, maxDepth?, maxProperties? }`).

`packages/kernel/src/logging/logging.ts`:
```ts
import { inspect } from 'node:util'
import {
  ansiColorFormatter,
  configure,
  getConsoleSink,
  getLogger,
  jsonLinesFormatter,
  reset,
  type LoggerConfig,
  type LogLevel,
  type LogRecord,
  type Sink,
} from '@logtape/logtape'
import { getRotatingFileSink } from '@logtape/file'
import type { Logger as PluginLogger } from '@bytebureau/plugin-api'
import { Cause, Logger, References, type Layer, type LogLevel as EffectLogLevel } from 'effect'
import { redactFields, redactText } from './redaction.js'

export type KernelLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export interface LoggingOptions {
  readonly level: KernelLogLevel
  readonly json: boolean
  readonly debug?: string | undefined
  readonly file?: string | undefined
  readonly capture?: ((record: LogRecord) => void) | undefined
}

const toLogTape = (level: KernelLogLevel): LogLevel => (level === 'warn' ? 'warning' : level)

interface DebugSelection {
  readonly enabled: readonly string[][]
  readonly silenced: readonly string[][]
}

const NO_DEBUG: DebugSelection = { enabled: [], silenced: [] }

type CategoryConfig = LoggerConfig<string, string>

// `--debug` with no list enables every bb.* category; `a,!b` enables a and silences b
export function parseDebug(debug: string | undefined): DebugSelection | undefined {
  if (debug === undefined) {
    return undefined
  }
  if (debug === '' || debug === 'true') {
    return { enabled: [['bb']], silenced: [] }
  }
  const items = debug
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  return {
    enabled: items.filter((item) => !item.startsWith('!')).map((item) => item.split('.')),
    silenced: items.filter((item) => item.startsWith('!')).map((item) => item.slice(1).split('.')),
  }
}

function sinks(options: LoggingOptions): Record<string, Sink> {
  const result: Record<string, Sink> = {
    console: redactFields(
      getConsoleSink({
        formatter: options.json ? redactText(jsonLinesFormatter) : redactText(ansiColorFormatter),
      }),
    ),
  }
  if (options.file !== undefined) {
    result['file'] = redactFields(
      getRotatingFileSink(options.file, {
        maxSize: 20 * 1024 * 1024,
        maxFiles: 5,
        formatter: redactText(jsonLinesFormatter),
      }),
    )
  }
  if (options.capture !== undefined) {
    result['capture'] = redactFields(options.capture)
  }
  return result
}

export async function configureLogging(options: LoggingOptions): Promise<void> {
  const allSinks = sinks(options)
  const sinkIds = Object.keys(allSinks)
  const { enabled, silenced } = parseDebug(options.debug) ?? NO_DEBUG
  await configure({
    reset: true,
    sinks: allSinks,
    loggers: [
      { category: ['logtape', 'meta'], sinks: ['console'], lowestLevel: 'warning' },
      { category: ['bb'], sinks: sinkIds, lowestLevel: toLogTape(options.level) },
      ...enabled.map((category): CategoryConfig => ({
        category,
        sinks: sinkIds,
        parentSinks: 'override',
        lowestLevel: 'debug',
      })),
      ...silenced.map((category): CategoryConfig => ({
        category,
        sinks: [],
        parentSinks: 'override',
        lowestLevel: 'fatal',
      })),
    ],
  })
}

export async function resetLogging(): Promise<void> {
  await reset()
}

const levelMap: Record<EffectLogLevel.LogLevel, LogLevel | undefined> = {
  All: 'trace',
  Trace: 'trace',
  Debug: 'debug',
  Info: 'info',
  Warn: 'warning',
  Error: 'error',
  Fatal: 'fatal',
  None: undefined,
}

const asText = (part: unknown): string =>
  typeof part === 'string' ? part : inspect(part, { depth: 3 })

const toParts = (message: unknown): readonly unknown[] =>
  Array.isArray(message) ? message : [message]

// A bridged record carries one literal message part that is never a placeholder; the raw template's braces are escaped
const literalMessage = (text: string): Pick<LogRecord, 'message' | 'rawMessage'> => ({
  message: [text],
  rawMessage: text.replaceAll('{', '{{').replaceAll('}', '}}'),
})

// Effect logger → LogTape: the category annotation picks the logger, the other annotations become properties
export const effectToLogTape: Logger.Logger<unknown, void> = Logger.make((options) => {
  const level = levelMap[options.logLevel]
  if (level === undefined) {
    return
  }
  const { category, ...annotations } = options.fiber.getRef(References.CurrentLogAnnotations)
  const text = toParts(options.message)
    .map((part) => asText(part))
    .join(' ')
  const properties: Record<string, unknown> = { ...annotations }
  if (options.cause.reasons.length > 0) {
    properties['cause'] = Cause.pretty(options.cause)
  }
  getLogger(typeof category === 'string' ? category.split('.') : ['bb', 'core']).emit({
    timestamp: options.date.getTime(),
    level,
    properties,
    ...literalMessage(text),
  })
})

export const EffectLoggerLive: Layer.Layer<never> = Logger.layer([effectToLogTape])

export function kernelLogger(category: readonly string[]): PluginLogger {
  const logger = getLogger(category)
  const log =
    (level: LogLevel) =>
    (message: string, properties?: Readonly<Record<string, unknown>>): void => {
      if (logger.isEnabledFor(level)) {
        logger.emit({
          timestamp: Date.now(),
          level,
          properties: properties ?? {},
          ...literalMessage(message),
        })
      }
    }
  return {
    category,
    debug: log('debug'),
    info: log('info'),
    warn: log('warning'),
    error: log('error'),
    child: (name) => kernelLogger([...category, name]),
  }
}
```
Check two names against the installed types before relying on them: `options.cause.reasons` (the fact sheet's probe used it) and `Logger.make`'s options object (`{ message, logLevel, cause, fiber, date }`). LogTape's `logger.debug(message, properties)` interprets `{name}` placeholders in `message`; the plugin logger passes user text through, so escape braces the same way the bridge does (`message.replaceAll('{', '{{').replaceAll('}', '}}')`) inside `kernelLogger`.

Add to `packages/kernel/src/index.ts`: `export { uuidv7, nowIso } from './ids.js'`, `export * from './errors.js'`, `export { configureLogging, resetLogging, kernelLogger, EffectLoggerLive, parseDebug, type LoggingOptions, type KernelLogLevel } from './logging/logging.js'`.

- [ ] **Step 3: Run, commit**

Run: `bunx vitest run --project kernel` → PASS (7 tests: 2 store, 2 ids, 2 redaction, 2 logging — adjust the count to what Vitest prints). `bun run check` → green.

```bash
git add packages/kernel bun.lock
git commit -m "feat(kernel): add ids, tagged errors and logtape logging with secret redaction"
```

### Task 5: `Config` service — layered loading with c12, strict validation, JSON pointers

**Files:**
- Create: `packages/kernel/src/config/merge.ts`, `packages/kernel/src/config/env-overrides.ts`, `packages/kernel/src/config/config.ts`, `packages/kernel/src/config/template.ts`, `packages/kernel/src/config/merge.test.ts`, `packages/kernel/src/config/config.test.ts`
- Modify: `packages/kernel/src/index.ts`

**Interfaces:**
- Consumes: `ProjectConfig`, `UserConfig`, `decodeProjectConfig`, `defaultProjectConfig`, `configJsonSchema` (Task 1); `ConfigError` (Task 4); c12 `loadConfig` (fact sheet §5: `{ name: 'bytebureau', rcFile: false, globalRc: false, dotenv: false, packageJson: false, envName: false, cwd, configFile }`; `.json` and `.jsonc` resolve out of the box; `configFileRequired` defaults to false).
- Produces: `Config` service with `load(request: LoadRequest): Effect<ResolvedConfig, ConfigError>`, `validate(projectPath: string): Effect<readonly ConfigIssue[]>`, `schema(): Record<string, unknown>`; `ConfigLive(home: string): Layer<Config>`; `mergeConfig(base, overlay)` (deep merge, arrays replaced); `envOverrides(env)`; `defaultProjectConfigText()`; types `LoadRequest { projectPath?: string; flags?: FlagOverrides }`, `FlagOverrides { employee?, branch?, provider?, logLevel? }`, `ResolvedConfig { project: ProjectConfig; user: UserConfig; projectPath: string | null; files: { user: string | null; project: string | null; local: string | null } }`, `ConfigIssue { file: string; pointer: string; message: string }`.

- [ ] **Step 1: Failing tests**

`packages/kernel/src/config/merge.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { mergeConfig } from './merge.js'

describe(mergeConfig, () => {
  it('merges objects deeply and replaces arrays instead of concatenating them', () => {
    const merged = mergeConfig(
      { workspace: { copyIgnored: ['.env'], retainDays: 7 }, logging: { level: 'info' } },
      { workspace: { copyIgnored: ['.env.local'] }, logging: { level: 'debug' } },
    )
    expect(merged).toEqual({ workspace: { copyIgnored: ['.env.local'], retainDays: 7 }, logging: { level: 'debug' } })
  })

  it('ignores undefined overlay values', () => {
    expect(mergeConfig({ a: 1 }, { a: undefined, b: 2 })).toEqual({ a: 1, b: 2 })
  })
})
```
`packages/kernel/src/config/config.test.ts`:
```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { Config, ConfigLive } from './config.js'

function setup(): { home: string; project: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'bb-home-'))
  const project = mkdtempSync(path.join(tmpdir(), 'bb-project-'))
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ logging: { level: 'warn' }, defaults: { provider: 'fake' } }))
  writeFileSync(
    path.join(project, 'bytebureau.jsonc'),
    `{
  // project file wins over the user file
  "version": 1,
  "project": { "name": "demo", "defaultBranch": "develop" },
  "employees": { "dev": { "name": "Dev", "provider": "fake", "model": "m", "permissionMode": "autonomous" } },
  "defaults": { "employee": "dev" },
  "logging": { "level": "info" }
}`,
  )
  writeFileSync(path.join(project, 'bytebureau.local.json'), JSON.stringify({ logging: { level: 'debug' }, workspace: { copyIgnored: ['.env.local'] } }))
  return { home, project }
}

it.effect('applies precedence flags > env > local > project > user > defaults', () =>
  Effect.gen(function* () {
    const { home, project } = setup()
    const config = yield* Config
    const plain = yield* config.load({ projectPath: project })
    assert.strictEqual(plain.project.logging?.level, 'debug')
    assert.strictEqual(plain.project.project.defaultBranch, 'develop')
    assert.deepStrictEqual(plain.project.workspace?.copyIgnored, ['.env.local'])
    assert.strictEqual(plain.user.defaults?.provider, 'fake')
    const withEnv = yield* config.load({ projectPath: project, env: { BYTEBUREAU_LOG_LEVEL: 'error' } })
    assert.strictEqual(withEnv.project.logging?.level, 'error')
    const withFlags = yield* config.load({ projectPath: project, env: { BYTEBUREAU_LOG_LEVEL: 'error' }, flags: { logLevel: 'trace' } })
    assert.strictEqual(withFlags.project.logging?.level, 'trace')
    assert.strictEqual(withFlags.files.project, path.join(project, 'bytebureau.jsonc'))
  }).pipe(Effect.provide(ConfigLive(setup().home))),
)

it.effect('falls back to defaults named after the directory when no project file exists', () =>
  Effect.gen(function* () {
    const project = mkdtempSync(path.join(tmpdir(), 'bb-empty-'))
    const config = yield* Config
    const resolved = yield* config.load({ projectPath: project })
    assert.strictEqual(resolved.project.project.name, path.basename(project))
    assert.strictEqual(resolved.project.defaults?.employee, 'developer')
    assert.strictEqual(resolved.files.project, null)
  }).pipe(Effect.provide(ConfigLive(mkdtempSync(path.join(tmpdir(), 'bb-home-'))))),
)

it.effect('reports unknown keys and bad values with file and JSON pointer', () =>
  Effect.gen(function* () {
    const home = mkdtempSync(path.join(tmpdir(), 'bb-home-'))
    const project = mkdtempSync(path.join(tmpdir(), 'bb-bad-'))
    mkdirSync(project, { recursive: true })
    writeFileSync(path.join(project, 'bytebureau.json'), JSON.stringify({ version: 1, project: { name: 'x' }, employees: {}, logging: { level: 'loud' }, extra: true }))
    const config = yield* Config
    const issues = yield* config.validate(project)
    assert.deepStrictEqual(
      issues.map((issue) => issue.pointer).sort(),
      ['/extra', '/logging/level'],
    )
    assert.ok(issues.every((issue) => issue.file.endsWith('bytebureau.json')))
    const failure = yield* Effect.result(config.load({ projectPath: project }))
    assert.strictEqual(failure._tag, 'Failure')
  }).pipe(Effect.provide(ConfigLive(mkdtempSync(path.join(tmpdir(), 'bb-home-'))))),
)
```
Run: `bunx vitest run --project kernel` → FAIL.

- [ ] **Step 2: Implementation**

`packages/kernel/src/config/merge.ts`:
```ts
type Plain = Record<string, unknown>

const isPlain = (value: unknown): value is Plain =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Deep merge where the overlay wins; arrays and scalars replace, undefined is skipped
export function mergeConfig(base: Plain, overlay: Plain): Plain {
  const result: Plain = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) {
      continue
    }
    const current = result[key]
    result[key] = isPlain(current) && isPlain(value) ? mergeConfig(current, value) : value
  }
  return result
}
```
`packages/kernel/src/config/env-overrides.ts`:
```ts
type Plain = Record<string, unknown>

// Explicit map: environment variable → config path (dotted); extend deliberately, never generically
const ENV_MAP: ReadonlyArray<readonly [string, string]> = [
  ['BYTEBUREAU_LOG_LEVEL', 'logging.level'],
  ['BYTEBUREAU_EMPLOYEE', 'defaults.employee'],
  ['BYTEBUREAU_BRANCH', 'defaults.branch'],
  ['BYTEBUREAU_WORKSPACE_RUNTIME', 'workspace.runtime'],
]

function assign(target: Plain, dotted: string, value: string): void {
  const keys = dotted.split('.')
  let cursor = target
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key]
    cursor[key] = typeof next === 'object' && next !== null ? next : {}
    cursor = cursor[key] as Plain
  }
  cursor[keys.at(-1) ?? ''] = value
}

export function envOverrides(env: Readonly<Record<string, string | undefined>>): Plain {
  const result: Plain = {}
  for (const [name, dotted] of ENV_MAP) {
    const value = env[name]
    if (value !== undefined && value !== '') {
      assign(result, dotted, value)
    }
  }
  return result
}
```
`packages/kernel/src/config/config.ts`:
```ts
import path from 'node:path'
import {
  ProjectConfig,
  UserConfig,
  configJsonSchema,
  decodeUserConfig,
  defaultProjectConfig,
  type ProjectConfig as ProjectConfigType,
  type UserConfig as UserConfigType,
} from '@bytebureau/protocol'
import { loadConfig } from 'c12'
import { Context, Effect, Layer, Schema } from 'effect'
import { ConfigError } from '../errors.js'
import { envOverrides } from './env-overrides.js'
import { mergeConfig } from './merge.js'

type Plain = Record<string, unknown>

export interface FlagOverrides {
  readonly employee?: string | undefined
  readonly branch?: string | undefined
  readonly logLevel?: string | undefined
}
export interface LoadRequest {
  readonly projectPath?: string | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly flags?: FlagOverrides | undefined
}
export interface ConfigIssue {
  readonly file: string
  readonly pointer: string
  readonly message: string
}
export interface ResolvedConfig {
  readonly project: ProjectConfigType
  readonly user: UserConfigType
  readonly projectPath: string | null
  readonly files: { readonly user: string | null; readonly project: string | null; readonly local: string | null }
}

export interface ConfigShape {
  load(request: LoadRequest): Effect.Effect<ResolvedConfig, ConfigError>
  validate(projectPath: string): Effect.Effect<readonly ConfigIssue[]>
  schema(): Record<string, unknown>
}

export class Config extends Context.Service<Config, ConfigShape>()('bb/Config') {}

const BASE = { name: 'bytebureau', rcFile: false, globalRc: false, dotenv: false, packageJson: false, envName: false } as const

interface Layer_ {
  readonly config: Plain
  readonly file: string | null
}

const readLayer = (cwd: string, configFile: string): Effect.Effect<Layer_, ConfigError> =>
  Effect.tryPromise({
    try: async () => {
      const loaded = await loadConfig<Plain>({ ...BASE, cwd, configFile })
      return { config: loaded.config ?? {}, file: loaded.configFile ?? null }
    },
    catch: (cause) => new ConfigError({ file: path.join(cwd, configFile), pointer: '', reason: String(cause) }),
  })

const projectStandard = Schema.toStandardSchemaV1(ProjectConfig, { parseOptions: { onExcessProperty: 'error', errors: 'all' } })

async function issuesOf(input: unknown, file: string): Promise<readonly ConfigIssue[]> {
  const result = await projectStandard['~standard'].validate(input)
  if (!('issues' in result) || result.issues === undefined) {
    return []
  }
  return result.issues.map((issue) => ({
    file,
    pointer: `/${(issue.path ?? []).map((segment) => (typeof segment === 'object' ? String(segment.key) : String(segment))).join('/')}`,
    message: issue.message,
  }))
}

function flagOverrides(flags: FlagOverrides | undefined): Plain {
  if (flags === undefined) {
    return {}
  }
  return {
    ...(flags.logLevel === undefined ? {} : { logging: { level: flags.logLevel } }),
    ...(flags.employee === undefined && flags.branch === undefined
      ? {}
      : { defaults: { ...(flags.employee === undefined ? {} : { employee: flags.employee }), ...(flags.branch === undefined ? {} : { branch: flags.branch }) } }),
  }
}

const make = (home: string): ConfigShape => {
  const loadUser = Effect.map(readLayer(home, 'config'), (layer) => ({ layer, user: layer.config }))

  const assemble = (request: LoadRequest) =>
    Effect.gen(function* () {
      const { layer: userLayer, user } = yield* loadUser
      const projectPath = request.projectPath === undefined ? null : path.resolve(request.projectPath)
      const projectLayer = projectPath === null ? { config: {}, file: null } : yield* readLayer(projectPath, 'bytebureau')
      const localLayer = projectPath === null ? { config: {}, file: null } : yield* readLayer(projectPath, 'bytebureau.local')
      const defaults: Plain = { ...defaultProjectConfig, project: { ...defaultProjectConfig.project, name: projectPath === null ? 'default' : path.basename(projectPath) } }
      const userProjectLike: Plain = { ...(user['logging'] === undefined ? {} : { logging: user['logging'] }) }
      const merged = [userProjectLike, projectLayer.config, localLayer.config, envOverrides(request.env ?? {}), flagOverrides(request.flags)].reduce(
        (accumulator, layer) => mergeConfig(accumulator, layer),
        defaults,
      )
      return { merged, user, projectPath, files: { user: userLayer.file, project: projectLayer.file, local: localLayer.file } }
    })

  return {
    load: (request) =>
      Effect.gen(function* () {
        const { merged, user, projectPath, files } = yield* assemble(request)
        const file = files.local ?? files.project ?? '(defaults)'
        const issues = yield* Effect.promise(() => issuesOf(merged, file))
        if (issues.length > 0) {
          const [first] = issues
          return yield* new ConfigError({ file, pointer: first?.pointer ?? '', reason: issues.map((issue) => `${issue.pointer}: ${issue.message}`).join('; ') })
        }
        const project = Schema.decodeUnknownSync(ProjectConfig)(merged, { onExcessProperty: 'error', errors: 'all' })
        const userConfig = yield* Effect.try({ try: () => decodeUserConfig(user), catch: (cause) => new ConfigError({ file: files.user ?? path.join(home, 'config.json'), pointer: '', reason: String(cause) }) })
        return { project, user: userConfig, projectPath, files }
      }),
    validate: (projectPath) =>
      Effect.gen(function* () {
        const { merged, files } = yield* assemble({ projectPath }).pipe(Effect.orElseSucceed(() => ({ merged: {}, user: {}, projectPath, files: { user: null, project: null, local: null } })))
        return yield* Effect.promise(() => issuesOf(merged, files.local ?? files.project ?? path.join(projectPath, 'bytebureau.json')))
      }),
    schema: () => configJsonSchema(),
  }
}

export const ConfigLive = (home: string): Layer.Layer<Config> => Layer.succeed(Config, Config.of(make(home)))
```
Keep `UserConfig` imported only if used by a type; `decodeUserConfig` validates the user file. The issue `path` segments from Standard Schema are `PropertyKey | { key: PropertyKey }`; the mapper above handles both.

`packages/kernel/src/config/template.ts`:
```ts
import { defaultProjectConfig } from '@bytebureau/protocol'

// Commented JSONC for `bytebureau config init`; comments are the documentation
export function defaultProjectConfigText(): string {
  const employee = JSON.stringify(defaultProjectConfig.employees['developer'], null, 2).replaceAll('\n', '\n    ')
  return `{
  "$schema": "https://bytebureau.dev/schema/v1/config.json",
  "version": 1,
  // Project identity; defaultBranch is the base of every session worktree
  "project": { "name": ${JSON.stringify(defaultProjectConfig.project.name)}, "defaultBranch": "main" },
  // Worktrees live under .bytebureau/worktrees; copyIgnored files are copied from the main checkout
  "workspace": { "runtime": "local", "copyIgnored": [".env", ".env.local"], "retainDays": 7 },
  "providers": { "claude": { "executable": "claude", "settingSources": ["user", "project", "local"] } },
  // Employees: one entry per role; prompt points at a Markdown file with the system prompt
  "employees": {
    "developer": ${employee}
  },
  "defaults": { "employee": "developer", "branch": "main" },
  "plugins": [],
  "logging": { "level": "info" }
}
`
}
```
Add to `index.ts`: `export { Config, ConfigLive, type ConfigShape, type LoadRequest, type FlagOverrides, type ResolvedConfig, type ConfigIssue } from './config/config.js'`, `export { mergeConfig } from './config/merge.js'`, `export { defaultProjectConfigText } from './config/template.ts'` (use the `.js` suffix).

- [ ] **Step 3: Run, commit**

Run: `bunx vitest run --project kernel` → PASS. `bun run check` → green.

```bash
git add packages/kernel
git commit -m "feat(kernel): load layered configuration with c12 and report pointer-level issues"
```

### Task 6: `EventLog` service — durable append with `seq`, ephemeral fan-out, replay then live

**Files:**
- Create: `packages/kernel/src/events/event-log.ts`, `packages/kernel/src/events/event-log.test.ts`
- Modify: `packages/kernel/src/index.ts`

**Interfaces:**
- Consumes: `SqlClient` (Task 3), `uuidv7`/`nowIso` (Task 4), `EventEnvelope`, `KernelEvent`, `isEphemeral` (Task 1); Effect `PubSub.unbounded`, `Stream.fromPubSub`, `Stream.toAsyncIterable` (verified).
- Produces: `EventLog` service `{ publish(event: KernelEvent): Effect<EventEnvelope, StoreError>; subscribe(filter: EventFilter): Stream<EventEnvelope, StoreError>; read(filter: EventFilter, range: { from: number; to?: number }): Effect<readonly EventEnvelope[], StoreError> }`, `EventLogLive: Layer<EventLog, never, SqlClient>`, `EventFilter { sessionId?, projectId?, types?, since?, ephemeral? }`, `matches(filter, envelope)`.

Semantics: durable events get the next `seq` from SQLite (`RETURNING seq`) and `seq` is monotonic across the process; ephemeral events carry `seq: 0`, are never persisted and are delivered only to live subscribers. `subscribe` opens the live subscription first, then replays rows with `seq > since`, then forwards live envelopes whose `seq` is greater than the last replayed one (or any ephemeral), so a subscriber sees no gap and no duplicate.

- [ ] **Step 1: Failing tests**

`packages/kernel/src/events/event-log.test.ts`:
```ts
import { assert, it, layer } from '@effect/vitest'
import type { EventEnvelope } from '@bytebureau/protocol'
import { Effect, Fiber, Layer, Stream } from 'effect'
import { StoreTest } from '../store/store-test.js'
import { EventLog, EventLogLive, matches } from './event-log.js'

const TestLayer = EventLogLive.pipe(Layer.provideMerge(StoreTest))

layer(TestLayer)('EventLog', (it) => {
  it.effect('assigns increasing seq to durable events and none to ephemeral ones', () =>
    Effect.gen(function* () {
      const log = yield* EventLog
      const a = yield* log.publish({ type: 'session.created', sessionId: 's1', payload: { status: 'created', title: 't', employeeId: 'e', providerId: 'fake' } })
      const delta = yield* log.publish({ type: 'message.assistant.delta', sessionId: 's1', payload: { kind: 'text', text: 'x' } })
      const b = yield* log.publish({ type: 'session.ready', sessionId: 's1', payload: { status: 'ready' } })
      assert.ok(b.seq > a.seq)
      assert.strictEqual(delta.seq, 0)
      const stored = yield* log.read({ sessionId: 's1' }, { from: 0 })
      assert.deepStrictEqual(stored.map((event) => event.type), ['session.created', 'session.ready'])
    }),
  )

  it.effect('replays from since and continues live without gaps or duplicates', () =>
    Effect.gen(function* () {
      const log = yield* EventLog
      const first = yield* log.publish({ type: 'session.created', sessionId: 's2', payload: { status: 'created', title: 't', employeeId: 'e', providerId: 'fake' } })
      yield* log.publish({ type: 'session.provisioning', sessionId: 's2', payload: { status: 'provisioning' } })
      const collected = yield* Effect.forkChild(log.subscribe({ sessionId: 's2', since: first.seq }).pipe(Stream.take(3), Stream.runCollect))
      yield* Effect.yieldNow()
      yield* Effect.yieldNow()
      yield* log.publish({ type: 'session.ready', sessionId: 's2', payload: { status: 'ready' } })
      yield* log.publish({ type: 'message.assistant.delta', sessionId: 's2', payload: { kind: 'text', text: 'live' } })
      const events = [...(yield* Fiber.join(collected))] as EventEnvelope[]
      assert.deepStrictEqual(events.map((event) => event.type), ['session.provisioning', 'session.ready', 'message.assistant.delta'])
      assert.ok(events[0]!.seq > first.seq && events[1]!.seq > events[0]!.seq)
    }),
  )
})

it('matches filters by session, project and type', () => {
  const envelope = { seq: 1, id: 'x', ts: 't', type: 'tool.started', sessionId: 's', projectId: 'p', payload: {} } as EventEnvelope
  assert.ok(matches({ sessionId: 's' }, envelope))
  assert.ok(matches({ types: ['tool.started'] }, envelope))
  assert.ok(!matches({ projectId: 'other' }, envelope))
})
```
Under `it.effect` the clock is a `TestClock`; the subscription is started with `Effect.forkChild` and given two turns with `Effect.yieldNow()` before the live events are published, so no real sleep is needed.

- [ ] **Step 2: Implementation**

`packages/kernel/src/events/event-log.ts`:
```ts
import { type EventEnvelope, isEphemeral, type KernelEvent } from '@bytebureau/protocol'
import { Context, Effect, Layer, PubSub, Stream } from 'effect'
import { SqlClient } from 'effect/sql'
import { StoreError } from '../errors.js'
import { nowIso, uuidv7 } from '../ids.js'

export interface EventFilter {
  readonly sessionId?: string | undefined
  readonly projectId?: string | undefined
  readonly types?: readonly string[] | undefined
  readonly since?: number | undefined
  readonly ephemeral?: boolean | undefined
}

export interface EventLogShape {
  publish(event: KernelEvent): Effect.Effect<EventEnvelope, StoreError>
  subscribe(filter: EventFilter): Stream.Stream<EventEnvelope, StoreError>
  read(filter: EventFilter, range: { readonly from: number; readonly to?: number }): Effect.Effect<readonly EventEnvelope[], StoreError>
}

export class EventLog extends Context.Service<EventLog, EventLogShape>()('bb/EventLog') {}

export function matches(filter: EventFilter, event: EventEnvelope): boolean {
  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) {
    return false
  }
  if (filter.projectId !== undefined && event.projectId !== filter.projectId) {
    return false
  }
  if (filter.types !== undefined && !filter.types.includes(event.type)) {
    return false
  }
  return filter.ephemeral !== false || event.seq !== 0
}

interface Row {
  readonly seq: number
  readonly id: string
  readonly ts: string
  readonly type: string
  readonly project_id: string | null
  readonly session_id: string | null
  readonly turn_id: string | null
  readonly payload_json: string
}

const fromRow = (row: Row): EventEnvelope => ({
  seq: row.seq,
  id: row.id,
  ts: row.ts,
  type: row.type,
  ...(row.project_id === null ? {} : { projectId: row.project_id }),
  ...(row.session_id === null ? {} : { sessionId: row.session_id }),
  ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
  payload: JSON.parse(row.payload_json) as unknown,
})

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const hub = yield* PubSub.unbounded<EventEnvelope>()
  const wrap = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, StoreError> =>
    Effect.mapError(effect, (cause) => new StoreError({ cause }))

  const insert = (event: KernelEvent, id: string, ts: string): Effect.Effect<number, StoreError> =>
    wrap(
      Effect.map(
        sql<{ readonly seq: number }>`INSERT INTO events (id, ts, type, project_id, session_id, turn_id, payload_json)
          VALUES (${id}, ${ts}, ${event.type}, ${event.projectId ?? null}, ${event.sessionId ?? null}, ${event.turnId ?? null}, ${JSON.stringify(event.payload)})
          RETURNING seq`,
        (rows) => rows[0]?.seq ?? 0,
      ),
    )

  const publish: EventLogShape['publish'] = (event) =>
    Effect.gen(function* () {
      const id = uuidv7()
      const ts = nowIso()
      const seq = isEphemeral(event.type) ? 0 : yield* insert(event, id, ts)
      const envelope: EventEnvelope = {
        seq,
        id,
        ts,
        type: event.type,
        ...(event.projectId === undefined ? {} : { projectId: event.projectId }),
        ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        payload: event.payload,
      }
      yield* PubSub.publish(hub, envelope)
      return envelope
    })

  const read: EventLogShape['read'] = (filter, range) =>
    wrap(
      Effect.map(
        sql<Row>`SELECT seq, id, ts, type, project_id, session_id, turn_id, payload_json FROM events
          WHERE seq > ${range.from} AND seq <= ${range.to ?? Number.MAX_SAFE_INTEGER}
          AND (${filter.sessionId ?? null} IS NULL OR session_id = ${filter.sessionId ?? null})
          AND (${filter.projectId ?? null} IS NULL OR project_id = ${filter.projectId ?? null})
          ORDER BY seq`,
        (rows) => rows.map(fromRow).filter((event) => matches(filter, event)),
      ),
    )

  const subscribe: EventLogShape['subscribe'] = (filter) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const live = Stream.fromPubSub(hub)
        const replayed = yield* read(filter, { from: filter.since ?? 0 })
        let last = replayed.at(-1)?.seq ?? filter.since ?? 0
        const liveFiltered = live.pipe(
          Stream.filter((event) => matches(filter, event) && (event.seq === 0 || event.seq > last)),
          Stream.tap((event) => Effect.sync(() => { last = Math.max(last, event.seq) })),
        )
        return Stream.concat(Stream.fromIterable(replayed), liveFiltered)
      }),
    )

  return EventLog.of({ publish, subscribe, read })
})

export const EventLogLive: Layer.Layer<EventLog, never, SqlClient.SqlClient> = Layer.effect(EventLog, make)
```
`Stream.fromPubSub(hub)` must be created before the replay query so live events published during the replay are buffered (the unbounded hub subscription starts at creation). Verify `Stream.fromPubSub` subscribes eagerly in the installed version (its d.ts documents the scoped subscription); if it subscribes lazily, call `PubSub.subscribe(hub)` inside `Stream.unwrapScoped` and read it with `Stream.fromQueue`.

Add to `index.ts`: `export { EventLog, EventLogLive, matches, type EventFilter, type EventLogShape } from './events/event-log.js'`.

- [ ] **Step 3: Run, commit**

Run: `bunx vitest run --project kernel` → PASS. `bun run check` → green.

```bash
git add packages/kernel
git commit -m "feat(kernel): add the durable event log with ephemeral fan-out and gapless replay"
```

### Task 7: `ProjectRegistry` service and git root detection

**Files:**
- Create: `packages/kernel/src/projects/git-root.ts`, `packages/kernel/src/projects/project-registry.ts`, `packages/kernel/src/projects/git-root.test.ts`, `packages/kernel/src/projects/project-registry.test.ts`, `packages/kernel/src/testing/temp-repo.ts` (same helper as Task 9's, kernel-local copy)
- Modify: `packages/kernel/src/index.ts`

**Interfaces:**
- Consumes: `SqlClient`, `EventLog`, `Config` (`load({ projectPath })` for the config snapshot and the default branch), `uuidv7`, `nowIso`, `WorkspaceError`.
- Produces: `ProjectRegistry` service `{ register(path): Effect<Project, WorkspaceError | ConfigError | StoreError>; list(): Effect<readonly Project[], StoreError>; get(id): Effect<Project | undefined, StoreError>; remove(id): Effect<void, StoreError> }`, `ProjectRegistryLive: Layer<ProjectRegistry, never, SqlClient | EventLog | Config>`, `Project { id, name, path, defaultBranch, config: ProjectConfig, createdAt, updatedAt }`, `findGitRoot(path): string | null`, `isByteBureauWorktree(root): boolean`, `defaultBranchOf(root): string` (`git symbolic-ref --short refs/remotes/origin/HEAD` → strip `origin/`, else `main`).

- [ ] **Step 1: Failing tests**

`packages/kernel/src/projects/git-root.test.ts`:
```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTempRepo } from '../testing/temp-repo.js'
import { defaultBranchOf, findGitRoot, isByteBureauWorktree } from './git-root.js'

describe(findGitRoot, () => {
  it('finds the toplevel from a nested directory and null outside a repository', () => {
    const repo = createTempRepo()
    mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true })
    expect(findGitRoot(path.join(repo, 'src', 'deep'))).toBe(repo)
    expect(findGitRoot(mkdtempSync(path.join(tmpdir(), 'bb-plain-')))).toBeNull()
  })
})

describe(isByteBureauWorktree, () => {
  it('recognises the session marker file', () => {
    const repo = createTempRepo()
    expect(isByteBureauWorktree(repo)).toBe(false)
    writeFileSync(path.join(repo, '.bytebureau-session.json'), '{}')
    expect(isByteBureauWorktree(repo)).toBe(true)
  })
})

describe(defaultBranchOf, () => {
  it('uses origin/HEAD when present and main otherwise', () => {
    expect(defaultBranchOf(createTempRepo())).toBe('main')
    expect(defaultBranchOf(createTempRepo({ withRemote: true }))).toBe('main')
  })
})
```
`packages/kernel/src/projects/project-registry.test.ts`:
```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assert, it, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { ConfigLive } from '../config/config.js'
import { EventLog, EventLogLive } from '../events/event-log.js'
import { StoreTest } from '../store/store-test.js'
import { createTempRepo } from '../testing/temp-repo.js'
import { ProjectRegistry, ProjectRegistryLive } from './project-registry.js'

const TestLayer = ProjectRegistryLive.pipe(
  Layer.provideMerge(Layer.mergeAll(EventLogLive, ConfigLive(mkdtempSync(path.join(tmpdir(), 'bb-home-'))))),
  Layer.provideMerge(StoreTest),
)

layer(TestLayer)('ProjectRegistry', (it) => {
  it.effect('registers a repository once (upsert by path) and emits project events', () =>
    Effect.gen(function* () {
      const registry = yield* ProjectRegistry
      const log = yield* EventLog
      const repo = createTempRepo()
      mkdirSync(path.join(repo, 'src'), { recursive: true })
      const first = yield* registry.register(path.join(repo, 'src'))
      const second = yield* registry.register(repo)
      assert.strictEqual(first.id, second.id)
      assert.strictEqual(first.path, repo)
      assert.strictEqual(first.name, path.basename(repo))
      assert.strictEqual(first.defaultBranch, 'main')
      const events = yield* log.read({ projectId: first.id }, { from: 0 })
      assert.deepStrictEqual(events.map((event) => event.type), ['project.registered', 'project.updated'])
      assert.strictEqual((yield* registry.list()).length, 1)
      yield* registry.remove(first.id)
      assert.strictEqual(yield* registry.get(first.id), undefined)
    }),
  )

  it.effect('refuses directories that are not repositories or are ByteBureau worktrees', () =>
    Effect.gen(function* () {
      const registry = yield* ProjectRegistry
      const plain = yield* Effect.result(registry.register(mkdtempSync(path.join(tmpdir(), 'bb-plain-'))))
      assert.strictEqual(plain._tag, 'Failure')
      const repo = createTempRepo()
      writeFileSync(path.join(repo, '.bytebureau-session.json'), '{}')
      const worktree = yield* Effect.result(registry.register(repo))
      assert.strictEqual(worktree._tag, 'Failure')
    }),
  )
})
```
- [ ] **Step 2: Implementation**

`packages/kernel/src/projects/git-root.ts`:
```ts
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

function git(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

export const findGitRoot = (directory: string): string | null => git(directory, ['rev-parse', '--show-toplevel'])

export const isByteBureauWorktree = (root: string): boolean => existsSync(path.join(root, '.bytebureau-session.json'))

export function defaultBranchOf(root: string): string {
  const head = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  return head === null ? 'main' : head.replace(/^origin\//u, '')
}
```
`packages/kernel/src/projects/project-registry.ts`:
```ts
import path from 'node:path'
import type { ProjectConfig } from '@bytebureau/protocol'
import { Context, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { Config } from '../config/config.js'
import { ConfigError, StoreError, WorkspaceError } from '../errors.js'
import { EventLog } from '../events/event-log.js'
import { nowIso, uuidv7 } from '../ids.js'
import { defaultBranchOf, findGitRoot, isByteBureauWorktree } from './git-root.js'

export interface Project {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly defaultBranch: string
  readonly config: ProjectConfig
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ProjectRegistryShape {
  register(directory: string): Effect.Effect<Project, WorkspaceError | ConfigError | StoreError>
  list(): Effect.Effect<readonly Project[], StoreError>
  get(id: string): Effect.Effect<Project | undefined, StoreError>
  remove(id: string): Effect.Effect<void, StoreError>
}

export class ProjectRegistry extends Context.Service<ProjectRegistry, ProjectRegistryShape>()('bb/ProjectRegistry') {}

interface Row {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly default_branch: string
  readonly config_json: string
  readonly created_at: string
  readonly updated_at: string
}

const fromRow = (row: Row): Project => ({
  id: row.id,
  name: row.name,
  path: row.path,
  defaultBranch: row.default_branch,
  config: JSON.parse(row.config_json) as ProjectConfig,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const log = yield* EventLog
  const config = yield* Config
  const wrap = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, StoreError> =>
    Effect.mapError(effect, (cause) => new StoreError({ cause }))

  const byPath = (root: string) => wrap(Effect.map(sql<Row>`SELECT * FROM projects WHERE path = ${root}`, (rows) => rows[0]))
  const payload = (project: Project) => ({ id: project.id, name: project.name, path: project.path, defaultBranch: project.defaultBranch })

  const register: ProjectRegistryShape['register'] = (directory) =>
    Effect.gen(function* () {
      const root = findGitRoot(path.resolve(directory))
      if (root === null) {
        return yield* new WorkspaceError({ code: 'not_a_repository', reason: `${directory} is not inside a git repository` })
      }
      if (isByteBureauWorktree(root)) {
        return yield* new WorkspaceError({ code: 'is_bytebureau_worktree', reason: `${root} is a ByteBureau session worktree` })
      }
      const resolved = yield* config.load({ projectPath: root })
      const name = resolved.project.project.name
      const defaultBranch = resolved.project.project.defaultBranch ?? defaultBranchOf(root)
      const existing = yield* byPath(root)
      const now = nowIso()
      const configJson = JSON.stringify(resolved.project)
      if (existing === undefined) {
        const id = uuidv7()
        yield* wrap(sql`INSERT INTO projects (id, name, path, default_branch, config_json, created_at, updated_at) VALUES (${id}, ${name}, ${root}, ${defaultBranch}, ${configJson}, ${now}, ${now})`)
        const project: Project = { id, name, path: root, defaultBranch, config: resolved.project, createdAt: now, updatedAt: now }
        yield* log.publish({ type: 'project.registered', projectId: id, payload: payload(project) })
        return project
      }
      yield* wrap(sql`UPDATE projects SET name = ${name}, default_branch = ${defaultBranch}, config_json = ${configJson}, updated_at = ${now} WHERE id = ${existing.id}`)
      const project: Project = { ...fromRow(existing), name, defaultBranch, config: resolved.project, updatedAt: now }
      yield* log.publish({ type: 'project.updated', projectId: project.id, payload: payload(project) })
      return project
    })

  return ProjectRegistry.of({
    register,
    list: () => wrap(Effect.map(sql<Row>`SELECT * FROM projects ORDER BY name`, (rows) => rows.map(fromRow))),
    get: (id) => wrap(Effect.map(sql<Row>`SELECT * FROM projects WHERE id = ${id}`, (rows) => (rows[0] === undefined ? undefined : fromRow(rows[0])))),
    remove: (id) =>
      Effect.gen(function* () {
        yield* wrap(sql`DELETE FROM projects WHERE id = ${id}`)
        yield* log.publish({ type: 'project.removed', projectId: id, payload: { id } })
      }),
  })
})

export const ProjectRegistryLive: Layer.Layer<ProjectRegistry, never, SqlClient.SqlClient | EventLog | Config> = Layer.effect(ProjectRegistry, make)
```
`packages/kernel/src/testing/temp-repo.ts`: the same helper as `plugins/workspace-local/src/testing/temp-repo.ts` (copy it; a plugin's test helper is not importable by the kernel).

Add to `index.ts`: `export { ProjectRegistry, ProjectRegistryLive, type Project, type ProjectRegistryShape } from './projects/project-registry.js'` and `export { findGitRoot, isByteBureauWorktree, defaultBranchOf } from './projects/git-root.js'`.

- [ ] **Step 3: Run, commit**

Run: `bunx vitest run --project kernel` → PASS. `bun run check` → green (knip: `testing/*.ts` helpers are used by tests; if knip reports them, add `'src/testing/**'` to the kernel workspace `project` ignore via `ignore: ['src/testing/**']`).

```bash
git add packages/kernel
git commit -m "feat(kernel): register projects by git root with config snapshots and events"
```

### Task 8: `Supervisor` service — spawn, line streams, env allowlist, kill ladder, `TRACEPARENT`

**Files:**
- Create: `packages/kernel/src/process/env-allowlist.ts`, `packages/kernel/src/process/line-buffer.ts`, `packages/kernel/src/process/supervisor.ts`, `packages/kernel/src/process/env-allowlist.test.ts`, `packages/kernel/src/process/line-buffer.test.ts`, `packages/kernel/src/process/supervisor.test.ts`
- Modify: `packages/kernel/src/index.ts`

**Interfaces:**
- Consumes: Node's `child_process.spawn` (Bun implements it), `node:readline` line iteration; Effect `Effect.currentSpan` + `HttpTraceContext.toHeaders` (verified: produces `traceparent`), `Effect.sleep` for the ladder (test-controlled by `TestClock`).
- Produces: `Supervisor` service `{ spawn(spec: SpawnSpec): Effect<ManagedProcess, never, Scope>; kill(id, signal?): Effect<void>; list(): Effect<readonly ProcessInfo[]> }`, `SupervisorLive: Layer<Supervisor>`, `SpawnSpec { kind: 'agent' | 'git' | 'helper'; command; args; cwd; env?: Record<string, string>; passEnv?: readonly string[]; signal?: AbortSignal; maxLines?: number }`, `ManagedProcess { id, pid, stdout: Stream<string>, stderr: Stream<string>, exit: Effect<ExitInfo>, kill(signal?): Effect<void> }`, `ExitInfo { code: number | null; signal: string | null }`, `allowlistEnv(source, extra?: readonly string[]): Record<string, string>`, `LineBuffer`, `restartSchedule(maxRestarts: number)`.

Env allowlist (spec §13): `PATH`, `HOME`, `LANG`, `LC_*`, `TMPDIR`, `TERM`, `TRACEPARENT`, `BYTEBUREAU_*`, plus `passEnv` names; everything else is dropped. Kill ladder: `SIGINT`, after 5 s `SIGTERM`, after another 10 s `SIGKILL` (each step skipped once the process has exited).

- [ ] **Step 1: Failing tests**

`packages/kernel/src/process/env-allowlist.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { allowlistEnv } from './env-allowlist.js'

describe(allowlistEnv, () => {
  it('keeps only the documented variables and explicit extras', () => {
    const env = allowlistEnv(
      { PATH: '/bin', HOME: '/h', LANG: 'cs_CZ.UTF-8', LC_ALL: 'C', TMPDIR: '/t', TERM: 'xterm', ANTHROPIC_API_KEY: 'sk-ant-x', AWS_SECRET: 'y', BYTEBUREAU_HOME: '/bb', TRACEPARENT: '00-a-b-01', CUSTOM: 'c' },
      ['CUSTOM'],
    )
    expect(Object.keys(env).sort()).toEqual(['BYTEBUREAU_HOME', 'CUSTOM', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'TERM', 'TMPDIR', 'TRACEPARENT'])
  })
})
```
`packages/kernel/src/process/line-buffer.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { LineBuffer } from './line-buffer.js'

describe(LineBuffer, () => {
  it('keeps the newest lines up to the limit and counts drops', () => {
    const buffer = new LineBuffer(3)
    for (const line of ['a', 'b', 'c', 'd', 'e']) {
      buffer.push(line)
    }
    expect(buffer.lines()).toEqual(['c', 'd', 'e'])
    expect(buffer.dropped).toBe(2)
  })
})
```
`packages/kernel/src/process/supervisor.test.ts`:
```ts
import { assert, it, layer } from '@effect/vitest'
import { Effect, Fiber, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { Supervisor, SupervisorLive } from './supervisor.js'

const node = process.execPath

layer(SupervisorLive)('Supervisor', (it) => {
  it.live('streams stdout lines, passes only allowlisted env and reports the exit code', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor
        const child = yield* supervisor.spawn({
          kind: 'helper',
          command: node,
          args: ['-e', 'console.log("one"); console.log(process.env.SECRET ?? "no-secret"); console.log(process.env.KEEP); process.exit(3)'],
          cwd: process.cwd(),
          env: { SECRET: 'x', KEEP: 'y' },
          passEnv: ['KEEP'],
        })
        const lines = yield* child.stdout.pipe(Stream.runCollect)
        assert.deepStrictEqual([...lines], ['one', 'no-secret', 'y'])
        assert.deepStrictEqual(yield* child.exit, { code: 3, signal: null })
      }),
    ),
  )

  it.effect('escalates SIGINT → SIGTERM after 5 s → SIGKILL after 10 s', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor
        const child = yield* supervisor.spawn({
          kind: 'helper',
          command: node,
          args: ['-e', 'process.on("SIGINT", () => {}); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
          cwd: process.cwd(),
        })
        yield* TestClock.withLive(Effect.sleep('200 millis'))
        const killing = yield* Effect.forkChild(child.kill())
        yield* TestClock.adjust('5 seconds')
        yield* TestClock.adjust('10 seconds')
        yield* Fiber.join(killing)
        const exit = yield* child.exit
        assert.strictEqual(exit.signal, 'SIGKILL')
      }),
    ),
  )
})
```
`TestClock.withLive` (listed among the verified `effect/testing` exports) runs the short sleep on the real clock so the child can install its signal handlers before the ladder starts.

- [ ] **Step 2: Implementation**

`packages/kernel/src/process/env-allowlist.ts`:
```ts
const FIXED = new Set(['PATH', 'HOME', 'LANG', 'TMPDIR', 'TERM', 'TRACEPARENT'])

const allowed = (name: string, extra: ReadonlySet<string>): boolean =>
  FIXED.has(name) || name.startsWith('LC_') || name.startsWith('BYTEBUREAU_') || extra.has(name)

export function allowlistEnv(
  source: Readonly<Record<string, string | undefined>>,
  extra: readonly string[] = [],
): Record<string, string> {
  const extraSet = new Set(extra)
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && allowed(name, extraSet)) {
      result[name] = value
    }
  }
  return result
}
```
`packages/kernel/src/process/line-buffer.ts`:
```ts
// Bounded ring of the newest lines; the Supervisor keeps one per stream for diagnostics
export class LineBuffer {
  dropped = 0
  private readonly items: string[] = []

  constructor(private readonly limit: number) {}

  push(line: string): void {
    this.items.push(line)
    if (this.items.length > this.limit) {
      this.items.shift()
      this.dropped += 1
    }
  }

  lines(): readonly string[] {
    return [...this.items]
  }
}
```
`packages/kernel/src/process/supervisor.ts`:
```ts
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { Context, Effect, Layer, Queue, Schedule, Scope, Stream } from 'effect'
import { Headers, HttpTraceContext } from 'effect/http'
import { nowIso, uuidv7 } from '../ids.js'
import { allowlistEnv } from './env-allowlist.js'
import { LineBuffer } from './line-buffer.js'

export type ProcessKind = 'agent' | 'git' | 'helper'
export type KillSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL'

export interface SpawnSpec {
  readonly kind: ProcessKind
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly passEnv?: readonly string[] | undefined
  readonly maxLines?: number | undefined
}
export interface ExitInfo {
  readonly code: number | null
  readonly signal: string | null
}
export interface ManagedProcess {
  readonly id: string
  readonly pid: number
  readonly stdout: Stream.Stream<string>
  readonly stderr: Stream.Stream<string>
  readonly exit: Effect.Effect<ExitInfo>
  kill(signal?: KillSignal): Effect.Effect<void>
  recentStderr(): readonly string[]
}
export interface ProcessInfo {
  readonly id: string
  readonly kind: ProcessKind
  readonly command: string
  readonly pid: number
  readonly startedAt: string
}
export interface SupervisorShape {
  spawn(spec: SpawnSpec): Effect.Effect<ManagedProcess, never, Scope.Scope>
  kill(id: string, signal?: KillSignal): Effect.Effect<void>
  list(): Effect.Effect<readonly ProcessInfo[]>
}

export class Supervisor extends Context.Service<Supervisor, SupervisorShape>()('bb/Supervisor') {}

const GRACE_TERM = '5 seconds'
const GRACE_KILL = '10 seconds'
const DEFAULT_MAX_LINES = 10_000

export const restartSchedule = (maxRestarts: number) =>
  Schedule.exponential('500 millis').pipe(Schedule.jittered, Schedule.both(Schedule.recurs(maxRestarts)))

const traceparent: Effect.Effect<Record<string, string>> = Effect.gen(function* () {
  const span = yield* Effect.currentSpan.pipe(Effect.option)
  if (span._tag === 'None') {
    return {}
  }
  const value = Headers.get(HttpTraceContext.toHeaders(span.value), 'traceparent')
  return value === undefined ? {} : { TRACEPARENT: value }
})

// Lines of one stream into a Queue; the buffer keeps the newest lines for diagnostics
const pump = (stream: NodeJS.ReadableStream | null, queue: Queue.Queue<string>, buffer: LineBuffer): Effect.Effect<void> =>
  Effect.promise(async () => {
    if (stream === null) {
      await Queue.end(queue).pipe(Effect.runPromise)
      return
    }
    for await (const line of createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })) {
      buffer.push(line)
      await Queue.offer(queue, line).pipe(Effect.runPromise)
    }
    await Queue.end(queue).pipe(Effect.runPromise)
  })

const waitExit = (child: ChildProcess): Effect.Effect<ExitInfo> =>
  Effect.async<ExitInfo>((resume) => {
    child.once('close', (code, signal) => {
      resume(Effect.succeed({ code, signal }))
    })
  })

const make = Effect.gen(function* () {
  const running = new Map<string, { info: ProcessInfo; child: ChildProcess }>()

  const ladder = (child: ChildProcess, exited: () => boolean, signal: KillSignal | undefined): Effect.Effect<void> =>
    Effect.gen(function* () {
      const steps: readonly (readonly [KillSignal, string | null])[] =
        signal === undefined ? [['SIGINT', GRACE_TERM], ['SIGTERM', GRACE_KILL], ['SIGKILL', null]] : [[signal, null]]
      for (const [current, wait] of steps) {
        if (exited()) {
          return
        }
        child.kill(current)
        if (wait !== null) {
          yield* Effect.sleep(wait)
        }
      }
    })

  const spawnProcess: SupervisorShape['spawn'] = (spec) =>
    Effect.gen(function* () {
      const id = uuidv7()
      const env = { ...allowlistEnv(process.env, spec.passEnv), ...allowlistEnv(spec.env ?? {}, spec.passEnv), ...(yield* traceparent) }
      const child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout = yield* Queue.unbounded<string>()
      const stderr = yield* Queue.unbounded<string>()
      const stderrBuffer = new LineBuffer(spec.maxLines ?? DEFAULT_MAX_LINES)
      yield* Effect.forkChild(pump(child.stdout, stdout, new LineBuffer(spec.maxLines ?? DEFAULT_MAX_LINES)))
      yield* Effect.forkChild(pump(child.stderr, stderr, stderrBuffer))
      let done = false
      const exit = yield* Effect.cached(Effect.tap(waitExit(child), () => Effect.sync(() => { done = true; running.delete(id) })))
      yield* Effect.forkChild(exit)
      const info: ProcessInfo = { id, kind: spec.kind, command: spec.command, pid: child.pid ?? -1, startedAt: nowIso() }
      running.set(id, { info, child })
      const managed: ManagedProcess = {
        id,
        pid: child.pid ?? -1,
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.fromQueue(stderr),
        exit,
        kill: (signal) => ladder(child, () => done, signal),
        recentStderr: () => stderrBuffer.lines(),
      }
      yield* Scope.addFinalizer(yield* Scope.Scope, Effect.andThen(managed.kill('SIGTERM'), Effect.ignore(exit)))
      return managed
    })

  return Supervisor.of({
    spawn: spawnProcess,
    kill: (id, signal) => {
      const entry = running.get(id)
      return entry === undefined ? Effect.void : ladder(entry.child, () => !running.has(id), signal)
    },
    list: () => Effect.sync(() => [...running.values()].map((entry) => entry.info)),
  })
})

export const SupervisorLive: Layer.Layer<Supervisor> = Layer.effect(Supervisor, make)
```
Names to confirm against the installed d.ts before running: `Queue.end`/`Queue.offer` (v4 queue termination), `Stream.fromQueue`, `Effect.cached`, `Effect.option`, `Scope.addFinalizer(scope, finalizer)`, `Schedule.both` (the fact sheet notes `Schedule.both` does **not** exist in v4 — use `Schedule.exponential('500 millis').pipe(Schedule.jittered, Schedule.recurs(maxRestarts))` or the `Schedule.intersect` equivalent the d.ts offers); `Effect.async` resume signature. The `pump` helper calls `Effect.runPromise` inside a plain async loop deliberately (readline is callback-land); keep it or replace with `Stream.fromAsyncIterable(createInterface(...), onError)` which the fact sheet verified — the latter is simpler: `stdout: Stream.fromAsyncIterable(createInterface({ input: child.stdout }), (cause) => new ProcessError(...))` with `Stream.tap` into the buffer; prefer it and drop the queues if it type-checks.

Add to `index.ts`: `export { Supervisor, SupervisorLive, restartSchedule, type SpawnSpec, type ManagedProcess, type ExitInfo, type ProcessInfo, type KillSignal } from './process/supervisor.js'`, `export { allowlistEnv } from './process/env-allowlist.js'`.

- [ ] **Step 3: Run, commit**

Run: `bunx vitest run --project kernel` → PASS. `bun run check` → green.

```bash
git add packages/kernel
git commit -m "feat(kernel): supervise child processes with an env allowlist, line streams and a kill ladder"
```

### Task 9: `plugins/workspace-local` — git worktree runtime (first-party plugin)

**Files:**
- Create: `plugins/workspace-local/package.json`, `plugins/workspace-local/tsconfig.json`, `plugins/workspace-local/vitest.config.ts`, `plugins/workspace-local/src/plugin.ts`, `plugins/workspace-local/src/local-runtime.ts`, `plugins/workspace-local/src/git.ts`, `plugins/workspace-local/src/status-parser.ts`, `plugins/workspace-local/src/testing/node-spawner.ts`, `plugins/workspace-local/src/testing/temp-repo.ts`, `plugins/workspace-local/src/local-runtime.test.ts`, `plugins/workspace-local/src/status-parser.test.ts`
- Modify: `vitest.config.ts` (project), `knip.ts` (workspace), `commitlint.config.ts` (nothing — `plugins/*` directories are already scope names)

**Interfaces:**
- Consumes: `WorkspaceRuntime`, `WorkspaceSpec`, `WorkspaceHandle`, `WorkspaceStatus`, `ExecSpec`, `ExecHandle`, `ProcessSpawner`, `Logger`, `PluginContext`, `definePlugin` from `@bytebureau/plugin-api` (Task 2).
- Produces: `localWorkspacePlugin` (the `Plugin` the kernel bundles), `LocalWorkspaceRuntime` (class, `id: 'local'`, `isolation: 'none'`), `createGit(spawn, logger)` returning the typed git wrapper, `parseStatusV2(text)` (dirty flag and branch; ahead/behind come from `git rev-list --left-right --count <base>...HEAD` because `# branch.ab` appears only with an upstream); error classes `WorkspaceError` with `code ∈ 'not_a_repository' | 'is_bytebureau_worktree' | 'git_too_old' | 'locked' | 'dirty' | 'git_failed'`.

- [ ] **Step 1: Package manifests**

`plugins/workspace-local/package.json`:
```json
{
  "name": "@bytebureau/workspace-local",
  "version": "0.0.0",
  "private": true,
  "license": "FSL-1.1-MIT",
  "description": "ByteBureau workspace runtime: one git worktree per session on the host",
  "type": "module",
  "exports": {
    ".": { "types": "./src/plugin.ts", "default": "./src/plugin.ts" },
    "./plugin": { "types": "./src/plugin.ts", "default": "./src/plugin.ts" }
  },
  "bytebureau": {
    "name": "workspace-local",
    "hostApi": "^0",
    "kind": "in-process",
    "capabilities": ["fs:read", "fs:write", "process"],
    "contributes": { "workspaceRuntimes": ["local"] }
  },
  "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" },
  "dependencies": { "@bytebureau/plugin-api": "workspace:*" },
  "devDependencies": { "@bytebureau/tsconfig": "workspace:*" }
}
```
`plugins/workspace-local/tsconfig.json` (extends `effect.json` for the same reason as plugin-api: it imports plugin-api sources):
```json
{
  "extends": "@bytebureau/tsconfig/effect.json",
  "compilerOptions": { "types": ["bun"] },
  "include": ["src/**/*.ts"]
}
```
`plugins/workspace-local/vitest.config.ts`:
```ts
import { defineProject } from 'vitest/config'

export default defineProject({
  test: { name: 'workspace-local', include: ['src/**/*.test.ts'], testTimeout: 20_000 },
})
```

- [ ] **Step 2: Failing tests for the status parser**

`plugins/workspace-local/src/status-parser.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { parseStatusV2 } from './status-parser.js'

const clean = `# branch.oid 1234567
# branch.head bb/add-hello
# branch.upstream origin/main
# branch.ab +2 -1
`
const dirty = `${clean}1 .M N... 100644 100644 100644 abc def src/hello.ts
? notes.txt
`

describe(parseStatusV2, () => {
  it('reads branch name and ahead/behind from the headers', () => {
    expect(parseStatusV2(clean)).toEqual({ dirty: false, ahead: 2, behind: 1, branch: 'bb/add-hello' })
  })

  it('reports dirty when any change or untracked entry is present', () => {
    expect(parseStatusV2(dirty).dirty).toBe(true)
  })

  it('tolerates a detached head and a missing upstream', () => {
    expect(parseStatusV2('# branch.oid abc\n# branch.head (detached)\n')).toEqual({
      dirty: false,
      ahead: 0,
      behind: 0,
      branch: '(detached)',
    })
  })
})
```
Run: `bunx vitest run --project workspace-local` → FAIL (module not found).

- [ ] **Step 3: Status parser**

`plugins/workspace-local/src/status-parser.ts`:
```ts
export interface ParsedStatus {
  readonly dirty: boolean
  readonly ahead: number
  readonly behind: number
  readonly branch: string
}

const AHEAD_BEHIND = /^# branch\.ab \+(\d+) -(\d+)$/u

function readHeader(line: string, status: { ahead: number; behind: number; branch: string }): void {
  if (line.startsWith('# branch.head ')) {
    status.branch = line.slice('# branch.head '.length)
    return
  }
  const match = AHEAD_BEHIND.exec(line)
  if (match !== null) {
    status.ahead = Number(match[1])
    status.behind = Number(match[2])
  }
}

// Output of `git status --porcelain=v2 --branch`: `#` headers, then one entry per change
export function parseStatusV2(text: string): ParsedStatus {
  const status = { dirty: false, ahead: 0, behind: 0, branch: '' }
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) {
      readHeader(line, status)
    } else if (line.trim() !== '') {
      status.dirty = true
    }
  }
  return status
}
```
Run: `bunx vitest run --project workspace-local` → PASS (3 tests).

- [ ] **Step 4: Test helpers (Node spawner and a temporary repository)**

`plugins/workspace-local/src/testing/node-spawner.ts` (used by tests under Node; the kernel supplies the real spawner in production):
```ts
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { ExecHandle, ExecSpec, ProcessSpawner } from '@bytebureau/plugin-api'

async function* lines(stream: NodeJS.ReadableStream | null): AsyncIterable<string> {
  if (stream === null) {
    return
  }
  for await (const line of createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })) {
    yield line
  }
}

export const nodeSpawner: ProcessSpawner = {
  spawn(spec: ExecSpec & { readonly cwd: string }): Promise<ExecHandle> {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      signal: spec.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on('close', (code, signal) => {
        resolve({ code, signal })
      })
    })
    return Promise.resolve({
      pid: child.pid ?? -1,
      stdout: lines(child.stdout),
      stderr: lines(child.stderr),
      exited,
      kill(signal = 'SIGTERM') {
        child.kill(signal)
      },
    })
  },
}
```

`plugins/workspace-local/src/testing/temp-repo.ts`:
```ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()
}

// A repository with one commit on `main` and an optional bare "origin" remote
export function createTempRepo(options: { readonly withRemote?: boolean } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-repo-'))
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(path.join(dir, 'README.md'), '# fixture\n')
  git(dir, 'add', 'README.md')
  git(dir, 'commit', '-q', '-m', 'initial')
  if (options.withRemote === true) {
    const remote = mkdtempSync(path.join(tmpdir(), 'bb-remote-'))
    git(remote, 'init', '-q', '--bare', '-b', 'main')
    git(dir, 'remote', 'add', 'origin', remote)
    git(dir, 'push', '-q', '-u', 'origin', 'main')
  }
  return dir
}
```

- [ ] **Step 5: Failing runtime tests**

`plugins/workspace-local/src/local-runtime.test.ts`:
```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Logger, WorkspaceSpec } from '@bytebureau/plugin-api'
import { beforeEach, describe, expect, it } from 'vitest'
import { LocalWorkspaceRuntime, WorkspaceError } from './local-runtime.js'
import { nodeSpawner } from './testing/node-spawner.js'
import { createTempRepo, git } from './testing/temp-repo.js'

const silent: Logger = {
  category: ['test'],
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent
  },
}

function spec(projectPath: string, overrides: Partial<WorkspaceSpec> = {}): WorkspaceSpec {
  return {
    sessionId: '0192f0c8-7b2e-7c3d-9a4b-000000000001',
    projectPath,
    baseBranch: 'main',
    branch: 'bb/add-hello',
    copyIgnored: ['.env'],
    logger: silent,
    ...overrides,
  }
}

describe(LocalWorkspaceRuntime, () => {
  let runtime: LocalWorkspaceRuntime

  beforeEach(() => {
    runtime = new LocalWorkspaceRuntime(nodeSpawner, silent)
  })

  it('provisions a worktree on the requested branch from the local base branch', async () => {
    const repo = createTempRepo()
    const handle = await runtime.provision(spec(repo))
    expect(handle.path).toBe(path.join(repo, '.bytebureau', 'worktrees', spec(repo).sessionId))
    expect(git(handle.path, 'branch', '--show-current')).toBe('bb/add-hello')
    expect(handle.baseRef).toBe('main')
    expect(readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.bytebureau/')
    expect(JSON.parse(readFileSync(path.join(handle.path, '.bytebureau-session.json'), 'utf8'))).toMatchObject({
      sessionId: spec(repo).sessionId,
    })
  })

  it('uses origin/<branch> when a remote exists and copies ignored files', async () => {
    const repo = createTempRepo({ withRemote: true })
    writeFileSync(path.join(repo, '.env'), 'SECRET=1\n')
    const handle = await runtime.provision(spec(repo))
    expect(handle.baseRef).toBe('origin/main')
    expect(readFileSync(path.join(handle.path, '.env'), 'utf8')).toBe('SECRET=1\n')
  })

  it('suffixes the branch when it already exists', async () => {
    const repo = createTempRepo()
    git(repo, 'branch', 'bb/add-hello')
    const handle = await runtime.provision(spec(repo))
    expect(handle.branch).toBe('bb/add-hello-2')
  })

  it('never touches a dirty main checkout', async () => {
    const repo = createTempRepo()
    writeFileSync(path.join(repo, 'README.md'), '# changed\n')
    writeFileSync(path.join(repo, 'scratch.txt'), 'x\n')
    await runtime.provision(spec(repo))
    expect(git(repo, 'status', '--porcelain')).toBe(' M README.md\n?? scratch.txt')
    expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# changed\n')
  })

  it('refuses a directory that is not a repository and one that is a ByteBureau worktree', async () => {
    const repo = createTempRepo()
    const handle = await runtime.provision(spec(repo))
    await expect(runtime.provision(spec(path.dirname(repo)))).rejects.toMatchObject({ code: 'not_a_repository' })
    await expect(runtime.provision(spec(handle.path))).rejects.toMatchObject({ code: 'is_bytebureau_worktree' })
  })

  it('reports status, refuses to destroy a dirty worktree without force, then removes it', async () => {
    const repo = createTempRepo()
    const handle = await runtime.provision(spec(repo))
    writeFileSync(path.join(handle.path, 'new.txt'), 'hi\n')
    expect(await runtime.status(handle)).toMatchObject({ dirty: true, locked: false, branch: 'bb/add-hello' })
    await expect(runtime.destroy(handle)).rejects.toBeInstanceOf(WorkspaceError)
    await runtime.destroy(handle, { force: true })
    expect(existsSync(handle.path)).toBe(false)
  })

  it('refuses to destroy a locked worktree even with force', async () => {
    const repo = createTempRepo()
    const handle = await runtime.provision(spec(repo))
    git(repo, 'worktree', 'lock', handle.path)
    await expect(runtime.destroy(handle, { force: true })).rejects.toMatchObject({ code: 'locked' })
  })
})
```
Run: `bunx vitest run --project workspace-local` → FAIL (`./local-runtime.js` not found).

- [ ] **Step 6: Git wrapper**

`plugins/workspace-local/src/git.ts`:
```ts
import type { ExecHandle, Logger, ProcessSpawner } from '@bytebureau/plugin-api'

export interface GitResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  const parts: string[] = []
  for await (const line of stream) {
    parts.push(line)
  }
  return parts.join('\n')
}

async function settle(handle: ExecHandle): Promise<GitResult> {
  const [stdout, stderr, exit] = await Promise.all([collect(handle.stdout), collect(handle.stderr), handle.exited])
  return { code: exit.code ?? -1, stdout, stderr }
}

export interface Git {
  run(cwd: string, args: readonly string[]): Promise<GitResult>
  must(cwd: string, args: readonly string[]): Promise<string>
  version(cwd: string): Promise<string>
  toplevel(cwd: string): Promise<string | null>
  hasRemote(cwd: string, name: string): Promise<boolean>
  refExists(cwd: string, ref: string): Promise<boolean>
  worktreeLocked(cwd: string, worktreePath: string): Promise<boolean>
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: GitResult,
  ) {
    super(`git ${args.join(' ')} failed (${result.code}): ${result.stderr.trim()}`)
    this.name = 'GitError'
  }
}

export function createGit(spawn: ProcessSpawner, logger: Logger): Git {
  const run: Git['run'] = async (cwd, args) => {
    logger.debug('git', { cwd, args })
    const handle = await spawn.spawn({ command: 'git', args, cwd, env: { GIT_TERMINAL_PROMPT: '0' } })
    return settle(handle)
  }
  const must: Git['must'] = async (cwd, args) => {
    const result = await run(cwd, args)
    if (result.code !== 0) {
      throw new GitError(args, result)
    }
    return result.stdout.trim()
  }
  return {
    run,
    must,
    version: (cwd) => must(cwd, ['--version']),
    async toplevel(cwd) {
      const result = await run(cwd, ['rev-parse', '--show-toplevel'])
      return result.code === 0 ? result.stdout.trim() : null
    },
    async hasRemote(cwd, name) {
      const result = await run(cwd, ['remote', 'get-url', name])
      return result.code === 0
    },
    async refExists(cwd, ref) {
      const result = await run(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      return result.code === 0
    },
    async worktreeLocked(cwd, worktreePath) {
      const listing = await must(cwd, ['worktree', 'list', '--porcelain'])
      const block = listing.split('\n\n').find((entry) => entry.includes(`worktree ${worktreePath}`))
      return block !== undefined && block.split('\n').some((line) => line.startsWith('locked'))
    },
  }
}
```

- [ ] **Step 7: Runtime**

`plugins/workspace-local/src/local-runtime.ts`:
```ts
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  ExecHandle,
  ExecSpec,
  Logger,
  ProcessSpawner,
  WorkspaceHandle,
  WorkspaceRuntime,
  WorkspaceSpec,
  WorkspaceStatus,
} from '@bytebureau/plugin-api'
import { createGit, type Git } from './git.js'
import { parseStatusV2 } from './status-parser.js'

export type WorkspaceErrorCode =
  | 'not_a_repository'
  | 'is_bytebureau_worktree'
  | 'git_too_old'
  | 'locked'
  | 'dirty'
  | 'git_failed'

export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

const MIN_GIT = [2, 40] as const
const FETCH_INTERVAL_MS = 60_000
const SESSION_MARKER = '.bytebureau-session.json'
const EXCLUDE_LINE = '.bytebureau/'

function parseVersion(text: string): readonly [number, number] {
  const match = /(\d+)\.(\d+)/u.exec(text)
  return match === null ? [0, 0] : [Number(match[1]), Number(match[2])]
}

function versionTooOld([major, minor]: readonly [number, number]): boolean {
  return major < MIN_GIT[0] || (major === MIN_GIT[0] && minor < MIN_GIT[1])
}

function ensureExcluded(projectPath: string): void {
  const exclude = path.join(projectPath, '.git', 'info', 'exclude')
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  if (!current.split('\n').includes(EXCLUDE_LINE)) {
    mkdirSync(path.dirname(exclude), { recursive: true })
    writeFileSync(exclude, `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}${EXCLUDE_LINE}\n`)
  }
}

function copyIgnoredFiles(projectPath: string, worktreePath: string, files: readonly string[]): void {
  for (const file of files) {
    const source = path.join(projectPath, file)
    if (existsSync(source)) {
      mkdirSync(path.dirname(path.join(worktreePath, file)), { recursive: true })
      copyFileSync(source, path.join(worktreePath, file))
    }
  }
}

export class LocalWorkspaceRuntime implements WorkspaceRuntime {
  readonly id = 'local'
  readonly isolation = 'none'
  private readonly git: Git
  private readonly lastFetch = new Map<string, number>()

  constructor(
    private readonly spawner: ProcessSpawner,
    private readonly logger: Logger,
  ) {
    this.git = createGit(spawner, logger.child('git'))
  }

  async provision(spec: WorkspaceSpec): Promise<WorkspaceHandle> {
    const projectPath = await this.checkProject(spec.projectPath)
    const baseRef = await this.resolveBaseRef(projectPath, spec.baseBranch)
    const branch = await this.freeBranch(projectPath, spec.branch)
    const worktreePath = path.join(projectPath, '.bytebureau', 'worktrees', spec.sessionId)
    mkdirSync(path.dirname(worktreePath), { recursive: true })
    await this.git.must(projectPath, ['worktree', 'add', worktreePath, '-b', branch, baseRef])
    copyIgnoredFiles(projectPath, worktreePath, spec.copyIgnored)
    writeFileSync(
      path.join(worktreePath, SESSION_MARKER),
      `${JSON.stringify({ sessionId: spec.sessionId, projectPath, branch, baseRef }, null, 2)}\n`,
    )
    ensureExcluded(projectPath)
    return { id: spec.sessionId, runtimeId: this.id, path: worktreePath, branch, baseRef }
  }

  exec(handle: WorkspaceHandle, spec: ExecSpec): Promise<ExecHandle> {
    return this.spawner.spawn({ ...spec, cwd: handle.path })
  }

  async status(handle: WorkspaceHandle): Promise<WorkspaceStatus> {
    const text = await this.git.must(handle.path, ['status', '--porcelain=v2', '--branch'])
    const parsed = parseStatusV2(text)
    // `# branch.ab` exists only with an upstream; count against the base ref instead
    const counts = await this.git.must(handle.path, ['rev-list', '--left-right', '--count', `${handle.baseRef}...HEAD`])
    const [behind = '0', ahead = '0'] = counts.split('\t')
    const locked = await this.git.worktreeLocked(handle.path, handle.path)
    return { dirty: parsed.dirty, branch: parsed.branch, ahead: Number(ahead), behind: Number(behind), locked }
  }

  async destroy(handle: WorkspaceHandle, options: { readonly force?: boolean } = {}): Promise<void> {
    const status = await this.status(handle)
    if (status.locked) {
      throw new WorkspaceError('locked', `worktree ${handle.path} is locked`)
    }
    if (status.dirty && options.force !== true) {
      throw new WorkspaceError('dirty', `worktree ${handle.path} has uncommitted changes`)
    }
    const args = ['worktree', 'remove', ...(options.force === true ? ['--force'] : []), handle.path]
    await this.git.must(path.dirname(path.dirname(path.dirname(handle.path))), args)
  }

  private async checkProject(projectPath: string): Promise<string> {
    const version = parseVersion(await this.git.version(projectPath).catch(() => '0.0'))
    if (versionTooOld(version)) {
      throw new WorkspaceError('git_too_old', `git ${version.join('.')} found, 2.40 or newer is required`)
    }
    const toplevel = await this.git.toplevel(projectPath)
    if (toplevel === null) {
      throw new WorkspaceError('not_a_repository', `${projectPath} is not inside a git repository`)
    }
    if (existsSync(path.join(toplevel, SESSION_MARKER))) {
      throw new WorkspaceError('is_bytebureau_worktree', `${toplevel} is a ByteBureau session worktree`)
    }
    return toplevel
  }

  private async resolveBaseRef(projectPath: string, baseBranch: string): Promise<string> {
    if (!(await this.git.hasRemote(projectPath, 'origin'))) {
      return baseBranch
    }
    await this.fetchThrottled(projectPath)
    return (await this.git.refExists(projectPath, `origin/${baseBranch}`)) ? `origin/${baseBranch}` : baseBranch
  }

  private async fetchThrottled(projectPath: string): Promise<void> {
    const last = this.lastFetch.get(projectPath) ?? 0
    if (Date.now() - last < FETCH_INTERVAL_MS) {
      return
    }
    this.lastFetch.set(projectPath, Date.now())
    const result = await this.git.run(projectPath, ['fetch', '--quiet', 'origin'])
    if (result.code !== 0) {
      this.logger.warn('git fetch failed; continuing with the last known refs', { stderr: result.stderr })
    }
  }

  private async freeBranch(projectPath: string, wanted: string): Promise<string> {
    let candidate = wanted
    for (let suffix = 2; await this.git.refExists(projectPath, `refs/heads/${candidate}`); suffix += 1) {
      candidate = `${wanted}-${suffix}`
    }
    return candidate
  }
}
```
The `for` loop with `await` in its condition is the one place `no-await-in-loop` must stay enabled-but-satisfied: oxlint's rule inspects loop bodies, not conditions; if the installed oxlint flags it, rewrite as a `while (true)` with an explicit `break` guarded by a `MAX_SUFFIX = 99` constant and note it in the report.

`plugins/workspace-local/src/plugin.ts`:
```ts
import { definePlugin, type Plugin } from '@bytebureau/plugin-api'
import { LocalWorkspaceRuntime } from './local-runtime.js'

export { LocalWorkspaceRuntime, WorkspaceError, type WorkspaceErrorCode } from './local-runtime.js'

export const localWorkspacePlugin: Plugin = definePlugin({
  manifest: {
    name: 'workspace-local',
    version: '0.0.0',
    displayName: 'Local git worktrees',
    hostApi: '^0',
    kind: 'in-process',
    capabilities: ['fs:read', 'fs:write', 'process'],
    contributes: { workspaceRuntimes: ['local'] },
  },
  setup(context) {
    return { workspaceRuntimes: [new LocalWorkspaceRuntime(context.process, context.logger)] }
  },
})
```

- [ ] **Step 8: Run the tests and the gates, then commit**

Run: `bunx vitest run --project workspace-local` → PASS (10 tests). `vitest.config.ts`: add `'plugins/workspace-local'` to `projects`; `knip.ts`: add `'plugins/workspace-local': { entry: ['src/plugin.ts'], project: ['src/**/*.ts'] }`; `.github/workflows/semantic-pr.yml`: add `workspace-local` to `scopes`; the coverage `include` gains `'plugins/*/src/**/*.ts'` (exclude `**/testing/**`). Run `bun install && bun run check` → green (dependency-cruiser confirms the plugin imports only `@bytebureau/plugin-api` and Node built-ins).

```bash
git add plugins/workspace-local vitest.config.ts knip.ts bun.lock
git commit -m "feat(workspace-local): add the git worktree workspace runtime plugin"
```

### Task 10: `WorkspaceManager` service — slugs, locks, retain and prune over the runtime port

**Files:**
- Create: `packages/kernel/src/workspace/slug.ts`, `packages/kernel/src/workspace/runtimes.ts`, `packages/kernel/src/workspace/workspace-manager.ts`, `packages/kernel/src/workspace/slug.test.ts`, `packages/kernel/src/workspace/workspace-manager.test.ts`, `packages/kernel/src/testing/node-spawner.ts` (kernel copy of Task 9's helper)
- Modify: `packages/kernel/src/index.ts`

**Interfaces:**
- Consumes: `WorkspaceRuntime`, `WorkspaceHandle`, `WorkspaceStatus` (Task 2); `LocalWorkspaceRuntime` (Task 9, in tests); `SqlClient`, `EventLog`, `Project`; Effect `Clock.currentTimeMillis` (TestClock in tests).
- Produces: `WorkspaceRuntimes` service `{ get(id: string): WorkspaceRuntime | undefined; list(): readonly WorkspaceRuntime[] }` (Task 11 provides it from loaded plugins; tests provide it directly), `WorkspaceManager` service `{ provision(input: ProvisionInput): Effect<WorkspaceHandle, WorkspaceError | StoreError>; status(handle): Effect<WorkspaceStatus, WorkspaceError>; destroy(handle, options?): Effect<void, WorkspaceError | StoreError>; lock(sessionId): Effect<void>; unlock(sessionId): Effect<void>; list(projectId?): Effect<readonly WorkspaceInfo[], StoreError>; prune(projectId?): Effect<PruneReport, StoreError> }`, `WorkspaceManagerLive: Layer<WorkspaceManager, never, SqlClient | EventLog | WorkspaceRuntimes>`, `branchSlug(title: string, sessionId: string): string`, `ProvisionInput { sessionId; project: Project; title: string; baseBranch: string; runtimeId: string }`, `WorkspaceInfo { sessionId; projectId; path; branch; baseRef; sessionStatus; exists: boolean }`, `PruneReport { removed: readonly string[]; retained: readonly { path: string; reason: string }[] }`.

- [ ] **Step 1: Failing tests**

`packages/kernel/src/workspace/slug.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { branchSlug } from './slug.js'

describe(branchSlug, () => {
  it('kebab-cases the title, strips diacritics and caps the length', () => {
    expect(branchSlug('Create src/hello.ts exporting hello()', 's')).toBe('bb/create-src-hello-ts-exporting-hello')
    expect(branchSlug('Přidat českou podporu!', 's')).toBe('bb/pridat-ceskou-podporu')
    expect(branchSlug('a'.repeat(80), 's')).toBe(`bb/${'a'.repeat(40)}`)
  })

  it('falls back to the short session id when nothing is left', () => {
    expect(branchSlug('???', '0192f0c8-7b2e-7c3d-9a4b-000000000001')).toBe('bb/s-0192f0c8')
  })
})
```
`packages/kernel/src/workspace/workspace-manager.test.ts`:
```ts
import { writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LocalWorkspaceRuntime } from '@bytebureau/workspace-local'
import { assert, it, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'
import { ConfigLive } from '../config/config.js'
import { EventLog, EventLogLive } from '../events/event-log.js'
import { kernelLogger } from '../logging/logging.js'
import { ProjectRegistry, ProjectRegistryLive } from '../projects/project-registry.js'
import { StoreTest } from '../store/store-test.js'
import { nodeSpawner } from '../testing/node-spawner.js'
import { createTempRepo, git } from '../testing/temp-repo.js'
import { WorkspaceRuntimes } from './runtimes.js'
import { WorkspaceManager, WorkspaceManagerLive } from './workspace-manager.js'

const runtime = new LocalWorkspaceRuntime(nodeSpawner, kernelLogger(['bb', 'test']))
const TestLayer = Layer.mergeAll(WorkspaceManagerLive, ProjectRegistryLive).pipe(
  Layer.provideMerge(Layer.mergeAll(EventLogLive, ConfigLive(mkdtempSync(path.join(tmpdir(), 'bb-home-'))), Layer.succeed(WorkspaceRuntimes, WorkspaceRuntimes.of({ get: (id) => (id === 'local' ? runtime : undefined), list: () => [runtime] })))),
  Layer.provideMerge(StoreTest),
)

const insertSession = (sql: SqlClient.SqlClient, id: string, projectId: string, status: string, endedAt: string | null) =>
  sql`INSERT INTO sessions (id, project_id, title, employee_json, provider_id, workspace_json, status, created_at, ended_at) VALUES (${id}, ${projectId}, 't', '{}', 'fake', '{}', ${status}, '2026-10-02T00:00:00.000Z', ${endedAt})`

layer(TestLayer)('WorkspaceManager', (it) => {
  it.effect('provisions on bb/<slug>, records the handle on the session and emits workspace.provisioned', () =>
    Effect.gen(function* () {
      const repo = createTempRepo()
      const project = yield* (yield* ProjectRegistry).register(repo)
      const sql = yield* SqlClient.SqlClient
      yield* insertSession(sql, 'sess-1', project.id, 'provisioning', null)
      const manager = yield* WorkspaceManager
      const handle = yield* manager.provision({ sessionId: 'sess-1', project, title: 'Add hello', baseBranch: 'main', runtimeId: 'local' })
      assert.strictEqual(handle.branch, 'bb/add-hello')
      assert.strictEqual(handle.path, path.join(repo, '.bytebureau', 'worktrees', 'sess-1'))
      const events = yield* (yield* EventLog).read({ sessionId: 'sess-1' }, { from: 0 })
      assert.deepStrictEqual(events.map((event) => event.type), ['workspace.provisioned'])
      const rows = yield* sql<{ readonly workspace_json: string }>`SELECT workspace_json FROM sessions WHERE id = 'sess-1'`
      assert.strictEqual((JSON.parse(rows[0]?.workspace_json ?? '{}') as { branch: string }).branch, 'bb/add-hello')
    }),
  )

  it.effect('refuses to destroy a locked workspace, retains a dirty one and removes a clean one', () =>
    Effect.gen(function* () {
      const repo = createTempRepo()
      const project = yield* (yield* ProjectRegistry).register(repo)
      const sql = yield* SqlClient.SqlClient
      yield* insertSession(sql, 'sess-2', project.id, 'running', null)
      const manager = yield* WorkspaceManager
      const handle = yield* manager.provision({ sessionId: 'sess-2', project, title: 'x', baseBranch: 'main', runtimeId: 'local' })
      yield* manager.lock('sess-2')
      const locked = yield* Effect.result(manager.destroy(handle))
      assert.strictEqual(locked._tag, 'Failure')
      yield* manager.unlock('sess-2')
      writeFileSync(path.join(handle.path, 'dirty.txt'), 'x')
      yield* manager.destroy(handle)
      const events = yield* (yield* EventLog).read({ sessionId: 'sess-2', types: ['workspace.retained', 'workspace.destroyed'] }, { from: 0 })
      assert.deepStrictEqual(events.map((event) => event.type), ['workspace.retained'])
      yield* manager.destroy(handle, { force: true })
      const after = yield* (yield* EventLog).read({ sessionId: 'sess-2', types: ['workspace.destroyed'] }, { from: 0 })
      assert.strictEqual(after.length, 1)
    }),
  )

  it.effect('prunes only terminal, pushed-or-merged, old worktrees and explains the rest', () =>
    Effect.gen(function* () {
      const repo = createTempRepo()
      const project = yield* (yield* ProjectRegistry).register(repo)
      const sql = yield* SqlClient.SqlClient
      yield* insertSession(sql, 'old-clean', project.id, 'completed', '2026-09-01T00:00:00.000Z')
      yield* insertSession(sql, 'old-ahead', project.id, 'completed', '2026-09-01T00:00:00.000Z')
      yield* insertSession(sql, 'fresh', project.id, 'completed', '2026-10-02T00:00:00.000Z')
      yield* insertSession(sql, 'live', project.id, 'running', null)
      const manager = yield* WorkspaceManager
      for (const id of ['old-clean', 'old-ahead', 'fresh', 'live']) {
        yield* manager.provision({ sessionId: id, project, title: id, baseBranch: 'main', runtimeId: 'local' })
      }
      const ahead = path.join(repo, '.bytebureau', 'worktrees', 'old-ahead')
      writeFileSync(path.join(ahead, 'work.txt'), 'x')
      git(ahead, 'add', 'work.txt')
      git(ahead, 'commit', '-q', '-m', 'unmerged work')
      yield* TestClock.setTime(Date.UTC(2026, 9, 3))
      const report = yield* manager.prune(project.id)
      assert.deepStrictEqual(report.removed, [path.join(repo, '.bytebureau', 'worktrees', 'old-clean')])
      assert.deepStrictEqual(report.retained.map((entry) => path.basename(entry.path)).sort(), ['fresh', 'live', 'old-ahead'])
    }),
  )
})
```
(`import { writeFileSync, mkdtempSync } from 'node:fs'` as one import; shown split only for readability.)

- [ ] **Step 2: Implementation**

`packages/kernel/src/workspace/slug.ts`:
```ts
const MAX = 40

export function branchSlug(title: string, sessionId: string): string {
  const slug = title
    .normalize('NFD')
    .replaceAll(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, MAX)
    .replaceAll(/-+$/gu, '')
  return `bb/${slug === '' ? `s-${sessionId.slice(0, 8)}` : slug}`
}
```
`packages/kernel/src/workspace/runtimes.ts`:
```ts
import type { WorkspaceRuntime } from '@bytebureau/plugin-api'
import { Context } from 'effect'

export interface WorkspaceRuntimesShape {
  get(id: string): WorkspaceRuntime | undefined
  list(): readonly WorkspaceRuntime[]
}

export class WorkspaceRuntimes extends Context.Service<WorkspaceRuntimes, WorkspaceRuntimesShape>()('bb/WorkspaceRuntimes') {}
```
`packages/kernel/src/workspace/workspace-manager.ts`:
```ts
import { existsSync } from 'node:fs'
import type { WorkspaceHandle, WorkspaceStatus } from '@bytebureau/plugin-api'
import { Clock, Context, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { StoreError, WorkspaceError } from '../errors.js'
import { EventLog } from '../events/event-log.js'
import type { Project } from '../projects/project-registry.js'
import { WorkspaceRuntimes } from './runtimes.js'
import { branchSlug } from './slug.js'

export interface ProvisionInput {
  readonly sessionId: string
  readonly project: Project
  readonly title: string
  readonly baseBranch: string
  readonly runtimeId: string
}
export interface WorkspaceInfo {
  readonly sessionId: string
  readonly projectId: string
  readonly path: string
  readonly branch: string
  readonly baseRef: string
  readonly sessionStatus: string
  readonly exists: boolean
}
export interface PruneReport {
  readonly removed: readonly string[]
  readonly retained: readonly { readonly path: string; readonly reason: string }[]
}
export interface WorkspaceManagerShape {
  provision(input: ProvisionInput): Effect.Effect<WorkspaceHandle, WorkspaceError | StoreError>
  status(handle: WorkspaceHandle): Effect.Effect<WorkspaceStatus, WorkspaceError>
  destroy(handle: WorkspaceHandle, options?: { readonly force?: boolean }): Effect.Effect<void, WorkspaceError | StoreError>
  lock(sessionId: string): Effect.Effect<void>
  unlock(sessionId: string): Effect.Effect<void>
  list(projectId?: string): Effect.Effect<readonly WorkspaceInfo[], StoreError>
  prune(projectId?: string): Effect.Effect<PruneReport, StoreError>
}

export class WorkspaceManager extends Context.Service<WorkspaceManager, WorkspaceManagerShape>()('bb/WorkspaceManager') {}

const TERMINAL = new Set(['completed', 'stopped', 'errored'])
const DAY_MS = 86_400_000

interface SessionRow {
  readonly id: string
  readonly project_id: string
  readonly status: string
  readonly ended_at: string | null
  readonly workspace_json: string
  readonly retain_days: number
}

const asWorkspaceError = (cause: unknown): WorkspaceError =>
  cause instanceof Error && 'code' in cause
    ? new WorkspaceError({ code: String((cause as { code: unknown }).code), reason: cause.message })
    : new WorkspaceError({ code: 'git_failed', reason: cause instanceof Error ? cause.message : String(cause) })

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const log = yield* EventLog
  const runtimes = yield* WorkspaceRuntimes
  const locks = new Set<string>()
  const wrap = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, StoreError> =>
    Effect.mapError(effect, (cause) => new StoreError({ cause }))

  const runtimeFor = (id: string) => {
    const runtime = runtimes.get(id)
    return runtime === undefined
      ? Effect.fail(new WorkspaceError({ code: 'runtime_missing', reason: `workspace runtime "${id}" is not available` }))
      : Effect.succeed(runtime)
  }

  const provision: WorkspaceManagerShape['provision'] = (input) =>
    Effect.gen(function* () {
      const runtime = yield* runtimeFor(input.runtimeId)
      const handle = yield* Effect.tryPromise({
        try: () =>
          runtime.provision({
            sessionId: input.sessionId,
            projectPath: input.project.path,
            baseBranch: input.baseBranch,
            branch: branchSlug(input.title, input.sessionId),
            copyIgnored: input.project.config.workspace?.copyIgnored ?? [],
            logger: { category: ['bb', 'workspace'], debug() {}, info() {}, warn() {}, error() {}, child() { return this } },
          }),
        catch: asWorkspaceError,
      })
      yield* wrap(sql`UPDATE sessions SET workspace_json = ${JSON.stringify(handle)} WHERE id = ${input.sessionId}`)
      yield* log.publish({ type: 'workspace.provisioned', sessionId: input.sessionId, projectId: input.project.id, payload: { path: handle.path, branch: handle.branch, baseRef: handle.baseRef, runtimeId: handle.runtimeId } })
      return handle
    })

  const status: WorkspaceManagerShape['status'] = (handle) =>
    Effect.flatMap(runtimeFor(handle.runtimeId), (runtime) => Effect.tryPromise({ try: () => runtime.status(handle), catch: asWorkspaceError }))

  const destroy: WorkspaceManagerShape['destroy'] = (handle, options = {}) =>
    Effect.gen(function* () {
      if (locks.has(handle.id)) {
        return yield* new WorkspaceError({ code: 'locked', reason: `session ${handle.id} is running` })
      }
      const runtime = yield* runtimeFor(handle.runtimeId)
      const current = yield* status(handle)
      if (current.dirty && options.force !== true) {
        yield* log.publish({ type: 'workspace.retained', sessionId: handle.id, payload: { path: handle.path, reason: 'uncommitted changes' } })
        return
      }
      yield* Effect.tryPromise({ try: () => runtime.destroy(handle, options), catch: asWorkspaceError })
      yield* log.publish({ type: 'workspace.destroyed', sessionId: handle.id, payload: { path: handle.path } })
    })

  const rows = (projectId: string | undefined) =>
    wrap(sql<SessionRow>`SELECT s.id, s.project_id, s.status, s.ended_at, s.workspace_json,
        COALESCE(json_extract(p.config_json, '$.workspace.retainDays'), 7) AS retain_days
      FROM sessions s JOIN projects p ON p.id = s.project_id
      WHERE (${projectId ?? null} IS NULL OR s.project_id = ${projectId ?? null}) AND s.workspace_json != '{}'`)

  const toHandle = (row: SessionRow): WorkspaceHandle => JSON.parse(row.workspace_json) as WorkspaceHandle

  const list: WorkspaceManagerShape['list'] = (projectId) =>
    Effect.map(rows(projectId), (sessions) =>
      sessions.map((row) => {
        const handle = toHandle(row)
        return { sessionId: row.id, projectId: row.project_id, path: handle.path, branch: handle.branch, baseRef: handle.baseRef, sessionStatus: row.status, exists: existsSync(handle.path) }
      }),
    )

  // Keep reasons explicit: a user reads them in `workspaces prune`
  const pruneOne = (row: SessionRow, now: number): Effect.Effect<{ removed: string | null; reason: string | null }> =>
    Effect.gen(function* () {
      const handle = toHandle(row)
      if (!TERMINAL.has(row.status)) {
        return { removed: null, reason: `session is ${row.status}` }
      }
      const age = row.ended_at === null ? 0 : now - Date.parse(row.ended_at)
      if (age < row.retain_days * DAY_MS) {
        return { removed: null, reason: `younger than ${row.retain_days} days` }
      }
      const current = yield* status(handle).pipe(Effect.orElseSucceed(() => undefined))
      if (current === undefined) {
        return { removed: null, reason: 'status unavailable' }
      }
      if (current.ahead > 0 || current.dirty) {
        return { removed: null, reason: current.dirty ? 'uncommitted changes' : 'commits not merged or pushed' }
      }
      yield* destroy(handle, { force: false }).pipe(Effect.ignore)
      return { removed: handle.path, reason: null }
    })

  const prune: WorkspaceManagerShape['prune'] = (projectId) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const removed: string[] = []
      const retained: { path: string; reason: string }[] = []
      for (const row of yield* rows(projectId)) {
        const outcome = yield* pruneOne(row, now)
        if (outcome.removed !== null) {
          removed.push(outcome.removed)
        } else {
          retained.push({ path: toHandle(row).path, reason: outcome.reason ?? 'kept' })
        }
      }
      return { removed, retained }
    })

  return WorkspaceManager.of({
    provision,
    status,
    destroy,
    lock: (sessionId) => Effect.sync(() => { locks.add(sessionId) }),
    unlock: (sessionId) => Effect.sync(() => { locks.delete(sessionId) }),
    list,
    prune,
  })
})

export const WorkspaceManagerLive: Layer.Layer<WorkspaceManager, never, SqlClient.SqlClient | EventLog | WorkspaceRuntimes> = Layer.effect(WorkspaceManager, make)
```
Replace the inline no-op logger in `provision` with `kernelLogger(['bb', 'workspace'])` from Task 4 (shown inline only to keep the snippet self-contained; `kernelLogger` returns the plugin-api `Logger`). `WorkspaceError.code` is typed `string` in the kernel so plugin codes pass through. `packages/kernel/src/testing/node-spawner.ts` is the same helper as Task 9's.

Add to `index.ts`: `export { WorkspaceManager, WorkspaceManagerLive, type ProvisionInput, type WorkspaceInfo, type PruneReport, type WorkspaceManagerShape } from './workspace/workspace-manager.js'`, `export { WorkspaceRuntimes, type WorkspaceRuntimesShape } from './workspace/runtimes.js'`, `export { branchSlug } from './workspace/slug.js'`.

- [ ] **Step 3: Run, commit**

Run: `bunx vitest run --project kernel` → PASS. `bun run check` → green.

```bash
git add packages/kernel
git commit -m "feat(kernel): manage session worktrees with slugs, locks, retention and pruning"
```

### Task 11: `PluginHost` service — bundled plugins, manifest and config validation, ports, hooks, plugin context

**Files:**
- Create (and add `"@bytebureau/workspace-local": "workspace:*"` to `packages/kernel/package.json` dependencies, then `bun install`): `packages/kernel/src/plugins/semver-major.ts`, `packages/kernel/src/plugins/hooks.ts`, `packages/kernel/src/plugins/plugin-context.ts`, `packages/kernel/src/plugins/plugin-host.ts`, `packages/kernel/src/plugins/bundled.ts`, `packages/kernel/src/secrets/in-memory-secret-store.ts`, `packages/kernel/src/plugins/semver-major.test.ts`, `packages/kernel/src/plugins/hooks.test.ts`, `packages/kernel/src/plugins/plugin-host.test.ts`
- Modify: `packages/kernel/src/index.ts`

**Interfaces:**
- Consumes: `Plugin`, `PluginManifest`, `PluginContext`, `PluginRegistration`, `Hooks`, `ProcessSpawner`, `ExecHandle` (Task 2); `localWorkspacePlugin` (Task 9); `EventLog`, `Supervisor`, `SqlClient`, `kernelLogger`, `PluginError`, `WorkspaceRuntimes` (Task 10).
- Produces: `PluginHost` service `{ load(): Effect<void>; plugins(): readonly PluginStatus[]; agentProviders(): readonly AgentProvider[]; agentProvider(id): AgentProvider | undefined; workspaceRuntimes(): readonly WorkspaceRuntime[]; hooks: HookBus }`, `PluginHostLive(options: { extraPlugins?: readonly Plugin[]; pluginConfig?: Record<string, unknown> }): Layer<PluginHost | WorkspaceRuntimes, never, EventLog | Supervisor | SqlClient>`, `HookBus { register(name, hook): void; run<Name>(name, input, terminal): Effect<Result> }`, `PluginStatus { name; version; state: 'loaded' | 'failed'; reason?: string; ports: readonly string[] }`, `BUNDLED_PLUGINS: readonly Plugin[]` (Task 13 appends the fake agent plugin), `HOST_API_VERSION = '0.0.0'`, `satisfiesMajor(range, version)`, `InMemorySecretStore` (Phase C replaces it with the keychain store).

- [ ] **Step 1: Failing tests**

`packages/kernel/src/plugins/semver-major.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { satisfiesMajor } from './semver-major.js'

describe(satisfiesMajor, () => {
  it('accepts caret ranges of the same major and rejects others', () => {
    expect(satisfiesMajor('^0', '0.0.0')).toBe(true)
    expect(satisfiesMajor('^0.1.0', '0.4.2')).toBe(true)
    expect(satisfiesMajor('^1', '0.9.0')).toBe(false)
    expect(satisfiesMajor('>=1', '1.0.0')).toBe(false)
  })
})
```
`packages/kernel/src/plugins/hooks.test.ts`:
```ts
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { HookBus } from './hooks.js'

it.effect('runs hooks in registration order and continues when a hook throws', () =>
  Effect.gen(function* () {
    const bus = new HookBus(['bb', 'test'])
    const order: string[] = []
    bus.register('a', 'prompt.beforeSend', async (input, next) => {
      order.push('a')
      return next({ ...input, input: { text: `${input.input.text}+a` } })
    })
    bus.register('b', 'prompt.beforeSend', () => {
      order.push('b')
      throw new Error('boom')
    })
    bus.register('c', 'prompt.beforeSend', async (input, next) => {
      order.push('c')
      return next({ ...input, input: { text: `${input.input.text}+c` } })
    })
    const result = yield* bus.run('prompt.beforeSend', { sessionId: 's', input: { text: 'x' } }, (input) => Effect.succeed(input))
    assert.deepStrictEqual(order, ['a', 'b', 'c'])
    assert.strictEqual(result.input.text, 'x+a+c')
  }),
)
```
`packages/kernel/src/plugins/plugin-host.test.ts`:
```ts
import { definePlugin, type Plugin } from '@bytebureau/plugin-api'
import { assert, it, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { EventLog, EventLogLive } from '../events/event-log.js'
import { SupervisorLive } from '../process/supervisor.js'
import { StoreTest } from '../store/store-test.js'
import { WorkspaceRuntimes } from '../workspace/runtimes.js'
import { PluginHost, PluginHostLive } from './plugin-host.js'

const good = definePlugin({
  manifest: { name: 'good', version: '1.0.0', hostApi: '^0', kind: 'in-process', contributes: { agentProviders: ['good'] } },
  setup: (context) => ({
    agentProviders: [{ id: 'good', displayName: 'Good', capabilities: { resume: false, interrupt: false, askUser: false, permissions: false, structuredOutput: false, usage: false, rateLimits: false, contextUsage: false, thinking: false, setModel: false, setEffort: false, attachments: false }, authStatus: () => Promise.resolve({ state: 'loggedIn' }), createSession: () => Promise.reject(new Error('unused')) }],
    hooks: { 'prompt.beforeSend': (input, next) => next(input) },
    dispose: async () => { await context.kv.set('disposed', true) },
  }),
})
const broken: Plugin = { manifest: { name: 'broken', version: '1.0.0', hostApi: '^0', kind: 'in-process' }, setup: () => { throw new Error('setup failed') } }
const incompatible: Plugin = { manifest: { name: 'future', version: '1.0.0', hostApi: '^9', kind: 'in-process' }, setup: () => ({}) }
const Deps = Layer.mergeAll(EventLogLive, SupervisorLive).pipe(Layer.provideMerge(StoreTest))

layer(PluginHostLive({ extraPlugins: [good, broken, incompatible] }).pipe(Layer.provideMerge(Deps)))('PluginHost', (it) => {
  it.effect('loads bundled and extra plugins, records failures and keeps running', () =>
    Effect.gen(function* () {
      const host = yield* PluginHost
      yield* host.load()
      const statuses = Object.fromEntries(host.plugins().map((status) => [status.name, status]))
      assert.strictEqual(statuses['workspace-local']?.state, 'loaded')
      assert.strictEqual(statuses['good']?.state, 'loaded')
      assert.strictEqual(statuses['broken']?.state, 'failed')
      assert.match(statuses['future']?.reason ?? '', /\^9.*0\.0\.0/u)
      assert.ok(host.agentProvider('good') !== undefined)
      assert.ok((yield* WorkspaceRuntimes).get('local') !== undefined)
      const events = yield* (yield* EventLog).read({ types: ['plugin.loaded', 'plugin.failed'] }, { from: 0 })
      assert.deepStrictEqual(events.map((event) => event.type).sort(), ['plugin.failed', 'plugin.failed', 'plugin.loaded', 'plugin.loaded'])
    }),
  )
})
```

- [ ] **Step 2: Implementation**

`packages/kernel/src/plugins/semver-major.ts`:
```ts
// Only caret ranges are accepted for hostApi (^MAJOR[.MINOR[.PATCH]]); anything else is incompatible by design
export function satisfiesMajor(range: string, version: string): boolean {
  const wanted = /^\^(\d+)(?:\.\d+)?(?:\.\d+)?$/u.exec(range)
  const actual = /^(\d+)\./u.exec(version)
  return wanted !== null && actual !== null && wanted[1] === actual[1]
}
```
`packages/kernel/src/plugins/hooks.ts`:
```ts
import type { Hook, Hooks } from '@bytebureau/plugin-api'
import { Effect } from 'effect'
import { kernelLogger } from '../logging/logging.js'

type HookName = keyof Hooks
type Input<Name extends HookName> = Parameters<Hooks[Name]>[0]
type Result<Name extends HookName> = Awaited<ReturnType<Hooks[Name]>>

interface Registered {
  readonly plugin: string
  readonly hook: Hook<unknown, unknown>
}

// Middleware chain in registration order; a throwing hook is logged and skipped
export class HookBus {
  private readonly hooks = new Map<HookName, Registered[]>()
  private readonly logger

  constructor(category: readonly string[]) {
    this.logger = kernelLogger([...category, 'hooks'])
  }

  register<Name extends HookName>(plugin: string, name: Name, hook: Hooks[Name]): void {
    const list = this.hooks.get(name) ?? []
    list.push({ plugin, hook: hook as Hook<unknown, unknown> })
    this.hooks.set(name, list)
  }

  run<Name extends HookName>(name: Name, input: Input<Name>, terminal: (input: Input<Name>) => Effect.Effect<Result<Name>>): Effect.Effect<Result<Name>> {
    const chain = this.hooks.get(name) ?? []
    const step = (index: number, current: Input<Name>): Effect.Effect<Result<Name>> => {
      const entry = chain[index]
      if (entry === undefined) {
        return terminal(current)
      }
      return Effect.tryPromise(() => entry.hook(current, (next) => Effect.runPromise(step(index + 1, next as Input<Name>)))).pipe(
        Effect.map((result) => result as Result<Name>),
        Effect.catch((cause) => {
          this.logger.warn('hook failed; continuing', { plugin: entry.plugin, hook: name, cause: String(cause) })
          return step(index + 1, current)
        }),
      )
    }
    return step(0, input)
  }
}
```
`packages/kernel/src/secrets/in-memory-secret-store.ts`:
```ts
import type { SecretStore } from '@bytebureau/plugin-api'

// Phase A placeholder; Phase C replaces it with the keychain and the age-encrypted fallback
export class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>()
  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(key))
  }
  set(key: string, value: string): Promise<void> {
    this.values.set(key, value)
    return Promise.resolve()
  }
  delete(key: string): Promise<void> {
    this.values.delete(key)
    return Promise.resolve()
  }
}
```
`packages/kernel/src/plugins/plugin-context.ts`:
```ts
import type { ExecHandle, ExecSpec, KernelEvent, PluginContext, SecretStore } from '@bytebureau/plugin-api'
import { Effect, Scope, Stream } from 'effect'
import { SqlClient } from 'effect/sql'
import { EventLog } from '../events/event-log.js'
import { kernelLogger } from '../logging/logging.js'
import { Supervisor } from '../process/supervisor.js'

export interface ContextDeps {
  readonly log: EventLog['Type']
  readonly supervisor: Supervisor['Type']
  readonly sql: SqlClient.SqlClient
  readonly secrets: SecretStore
}

const namespaced = (secrets: SecretStore, name: string): SecretStore => ({
  get: (key) => secrets.get(`${name}/${key}`),
  set: (key, value) => secrets.set(`${name}/${key}`, value),
  delete: (key) => secrets.delete(`${name}/${key}`),
})

export function createPluginContext(name: string, config: unknown, deps: ContextDeps, signal: AbortSignal): PluginContext {
  const { log, supervisor, sql } = deps
  return {
    config,
    project: null,
    logger: kernelLogger(['bb', 'plugin', name]),
    events: {
      publish: (event: KernelEvent) => Effect.runPromise(Effect.asVoid(log.publish(event))),
      subscribe: (filter) => Stream.toAsyncIterable(log.subscribe({ ...(filter.types === undefined ? {} : { types: filter.types }), ...(filter.sessionId === undefined ? {} : { sessionId: filter.sessionId }) })),
    },
    secrets: namespaced(deps.secrets, name),
    kv: {
      get: <T>(key: string) =>
        Effect.runPromise(Effect.map(sql<{ readonly value_json: string }>`SELECT value_json FROM plugin_kv WHERE plugin_id = ${name} AND key = ${key}`, (rows) => (rows[0] === undefined ? undefined : (JSON.parse(rows[0].value_json) as T)))),
      set: (key, value) => Effect.runPromise(Effect.asVoid(sql`INSERT INTO plugin_kv (plugin_id, key, value_json) VALUES (${name}, ${key}, ${JSON.stringify(value)}) ON CONFLICT(plugin_id, key) DO UPDATE SET value_json = excluded.value_json`)),
      delete: (key) => Effect.runPromise(Effect.asVoid(sql`DELETE FROM plugin_kv WHERE plugin_id = ${name} AND key = ${key}`)),
    },
    process: {
      spawn: (spec: ExecSpec & { readonly cwd: string }): Promise<ExecHandle> =>
        Effect.runPromise(
          Effect.gen(function* () {
            const scope = yield* Scope.make()
            const managed = yield* supervisor.spawn({ kind: 'helper', command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env ?? {}, passEnv: Object.keys(spec.env ?? {}) }).pipe(Effect.provideService(Scope.Scope, scope))
            yield* Effect.forkDetach(Effect.andThen(managed.exit, Scope.close(scope, Effect.void)))
            return {
              pid: managed.pid,
              stdout: Stream.toAsyncIterable(managed.stdout),
              stderr: Stream.toAsyncIterable(managed.stderr),
              exited: Effect.runPromise(managed.exit),
              kill: (signal) => { void Effect.runPromise(managed.kill(signal)) },
            }
          }),
        ),
    },
    http: fetch,
    signal,
  }
}
```
Verify `Scope.make`, `Scope.close(scope, exit)`, `Effect.provideService`, `Effect.forkDetach` and `Stream.toAsyncIterable` names in the installed d.ts (the fact sheet confirms `toAsyncIterable` and `forkDetach`). Passing `passEnv: Object.keys(spec.env)` lets a plugin's explicit `env` through the allowlist (it is the plugin's own declared environment, e.g. `GIT_TERMINAL_PROMPT`).

`packages/kernel/src/plugins/bundled.ts`:
```ts
import type { Plugin } from '@bytebureau/plugin-api'
import { localWorkspacePlugin } from '@bytebureau/workspace-local'

export const HOST_API_VERSION = '0.0.0'
export const BUNDLED_PLUGINS: readonly Plugin[] = [localWorkspacePlugin]
```
`packages/kernel/src/plugins/plugin-host.ts`:
```ts
import type { AgentProvider, Plugin, PluginRegistration, SecretStore, WorkspaceRuntime } from '@bytebureau/plugin-api'
import { Context, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { EventLog } from '../events/event-log.js'
import { kernelLogger } from '../logging/logging.js'
import { Supervisor } from '../process/supervisor.js'
import { InMemorySecretStore } from '../secrets/in-memory-secret-store.js'
import { WorkspaceRuntimes } from '../workspace/runtimes.js'
import { BUNDLED_PLUGINS, HOST_API_VERSION } from './bundled.js'
import { HookBus } from './hooks.js'
import { createPluginContext } from './plugin-context.js'
import { satisfiesMajor } from './semver-major.js'

export interface PluginStatus {
  readonly name: string
  readonly version: string
  readonly state: 'loaded' | 'failed'
  readonly reason?: string | undefined
  readonly ports: readonly string[]
}
export interface PluginHostShape {
  load(): Effect.Effect<void>
  plugins(): readonly PluginStatus[]
  agentProviders(): readonly AgentProvider[]
  agentProvider(id: string): AgentProvider | undefined
  workspaceRuntimes(): readonly WorkspaceRuntime[]
  readonly hooks: HookBus
}
export interface PluginHostOptions {
  readonly extraPlugins?: readonly Plugin[] | undefined
  readonly pluginConfig?: Readonly<Record<string, unknown>> | undefined
  readonly secrets?: SecretStore | undefined
}

export class PluginHost extends Context.Service<PluginHost, PluginHostShape>()('bb/PluginHost') {}

const HOOK_NAMES = ['session.beforeCreate', 'agent.beforeSpawn', 'ask.beforeOpen', 'prompt.beforeSend', 'event.beforePublish'] as const

async function validateConfig(plugin: Plugin, config: unknown): Promise<unknown> {
  const schema = plugin.manifest.config
  if (schema === undefined) {
    return config
  }
  const result = await schema['~standard'].validate(config ?? {})
  if ('issues' in result && result.issues !== undefined) {
    throw new Error(`config invalid: ${result.issues.map((issue) => `${(issue.path ?? []).join('.')} ${issue.message}`).join('; ')}`)
  }
  return result.value
}

const portsOf = (registration: PluginRegistration): readonly string[] => [
  ...(registration.agentProviders ?? []).map((provider) => `agentProviders:${provider.id}`),
  ...(registration.workspaceRuntimes ?? []).map((runtime) => `workspaceRuntimes:${runtime.id}`),
  ...(registration.secretStores ?? []).map(() => 'secretStores'),
]

const make = (options: PluginHostOptions) =>
  Effect.gen(function* () {
    const log = yield* EventLog
    const supervisor = yield* Supervisor
    const sql = yield* SqlClient.SqlClient
    const logger = kernelLogger(['bb', 'plugin'])
    const secrets = options.secrets ?? new InMemorySecretStore()
    const hooks = new HookBus(['bb', 'plugin'])
    const statuses: PluginStatus[] = []
    const providers = new Map<string, AgentProvider>()
    const runtimes = new Map<string, WorkspaceRuntime>()
    const controller = new AbortController()
    const disposers: (() => Promise<void>)[] = []

    const register = (plugin: Plugin, registration: PluginRegistration): void => {
      for (const provider of registration.agentProviders ?? []) {
        providers.set(provider.id, provider)
      }
      for (const runtime of registration.workspaceRuntimes ?? []) {
        runtimes.set(runtime.id, runtime)
      }
      for (const name of HOOK_NAMES) {
        const hook = registration.hooks?.[name]
        if (hook !== undefined) {
          hooks.register(plugin.manifest.name, name, hook as never)
        }
      }
      if (registration.dispose !== undefined) {
        disposers.push(registration.dispose.bind(registration))
      }
    }

    const loadOne = (plugin: Plugin): Effect.Effect<void> =>
      Effect.gen(function* () {
        const { name, version, hostApi } = plugin.manifest
        const outcome = yield* Effect.result(
          Effect.tryPromise(async () => {
            if (!satisfiesMajor(hostApi, HOST_API_VERSION)) {
              throw new Error(`plugin ${name} needs host API ${hostApi}, this ByteBureau provides ${HOST_API_VERSION}`)
            }
            const config = await validateConfig(plugin, options.pluginConfig?.[name])
            const context = createPluginContext(name, config, { log, supervisor, sql, secrets }, controller.signal)
            return plugin.setup(context)
          }),
        )
        if (outcome._tag === 'Failure') {
          const reason = String(outcome.failure)
          statuses.push({ name, version, state: 'failed', reason, ports: [] })
          logger.warn('plugin failed', { plugin: name, reason })
          yield* log.publish({ type: 'plugin.failed', payload: { name, reason } })
          return
        }
        register(plugin, outcome.success)
        const ports = portsOf(outcome.success)
        statuses.push({ name, version, state: 'loaded', ports })
        yield* log.publish({ type: 'plugin.loaded', payload: { name, version, ports } })
      })

    yield* Effect.addFinalizer(() => Effect.promise(async () => { controller.abort(); for (const dispose of disposers.reverse()) { await dispose().catch(() => undefined) } }))

    const host: PluginHostShape = {
      load: () => Effect.forEach([...BUNDLED_PLUGINS, ...(options.extraPlugins ?? [])], loadOne, { discard: true }),
      plugins: () => [...statuses],
      agentProviders: () => [...providers.values()],
      agentProvider: (id) => providers.get(id),
      workspaceRuntimes: () => [...runtimes.values()],
      hooks,
    }
    return { host, runtimes }
  })

export const PluginHostLive = (options: PluginHostOptions = {}): Layer.Layer<PluginHost | WorkspaceRuntimes, never, EventLog | Supervisor | SqlClient.SqlClient> =>
  Layer.unwrap(
    Effect.map(make(options), ({ host, runtimes }) =>
      Layer.mergeAll(
        Layer.succeed(PluginHost, PluginHost.of(host)),
        Layer.succeed(WorkspaceRuntimes, WorkspaceRuntimes.of({ get: (id) => runtimes.get(id), list: () => [...runtimes.values()] })),
      ),
    ),
  )
```
`Effect.result` yields `{ _tag: 'Success', success }` / `{ _tag: 'Failure', failure }` (verify the field names on `Result` in the installed `effect/Result` d.ts; the fact sheet confirms `Effect.result` exists and `effect/Either` became `effect/Result`). `Layer.unwrap` + `Effect.addFinalizer` need a scope: if `Layer.unwrap` does not provide one, use `Layer.scopedDiscard`-style composition (`Layer.effect` of a service holding both) — the simplest fallback is to make `PluginHost` the only service and let `WorkspaceRuntimes` be a `Layer.effect` that reads `PluginHost` (`runtimes` exposed via `host.workspaceRuntimes()`); Task 14 composes whichever form type-checks.

Add to `index.ts`: `export { PluginHost, PluginHostLive, type PluginHostShape, type PluginHostOptions, type PluginStatus } from './plugins/plugin-host.js'`, `export { HookBus } from './plugins/hooks.js'`, `export { BUNDLED_PLUGINS, HOST_API_VERSION } from './plugins/bundled.js'`, `export { InMemorySecretStore } from './secrets/in-memory-secret-store.js'`.

- [ ] **Step 3: Run, commit**

Run: `bunx vitest run --project kernel` → PASS. `bun run check` → green (dependency-cruiser: `packages/kernel → plugins/workspace-local` is allowed; the plugin itself still imports only the contracts).

```bash
git add packages/kernel
git commit -m "feat(kernel): host in-process plugins with manifest checks, ports, hooks and a plugin context"
```

### Task 12: `AskService` — questions and permissions with a recommended option, timeouts by policy

**Files:**
- Create: `packages/kernel/src/asks/policy.ts`, `packages/kernel/src/asks/ask-service.ts`, `packages/kernel/src/asks/policy.test.ts`, `packages/kernel/src/asks/ask-service.test.ts`
- Modify: `packages/kernel/src/index.ts`

**Interfaces:**
- Consumes: `Ask`, `AskRecord`, `AskAnswer`, `AskQuestion`, `AskOption`, `AnsweredVia`, `PermissionMode` (Task 1); `SqlClient`, `EventLog`, `uuidv7`, `nowIso`, `AskError`; Effect `Deferred`, `Effect.sleep` (TestClock-driven in tests), `Clock`.
- Produces: `AskService` service `{ open(input: OpenAskInput): Effect<AskRecord, StoreError>; answer(askId, answer, via): Effect<AskRecord, AskError | StoreError>; cancel(askId): Effect<void, StoreError>; pending(sessionId?): Effect<readonly AskRecord[], StoreError>; await(askId): Effect<AskAnswer, AskError> }`, `AskServiceLive: Layer<AskService, never, SqlClient | EventLog>`, `OpenAskInput { sessionId; turnId: string | null; kind; title; questions: readonly AskQuestion[]; toolCall?; permissionMode: PermissionMode; askTimeout: string; workspacePath: string; recommendationSource?: 'agent' | 'none' }`, `recommendForPermission(toolCall, workspacePath, permissionMode): { optionIds: readonly string[]; recommended: 'allow' | 'deny' | null; ruleId: string | null }`, `parseDuration('30m') → ms`, `DENY_ON_TIMEOUT_MESSAGE = 'nobody available to approve; do not retry'`.

Policy (spec §8.4): `supervised` → `onTimeout: 'wait'`; `autonomous` + `question` → `'recommended'` after `askTimeout`; `autonomous` + `permission` → `'deny'` after `askTimeout` with the message above. Permission questions always have the two options `allow` and `deny`; the recommendation comes from the rules in `policy.ts` with `recommendationSource: 'policy'` and evidence `{ kind: 'rule', ref: <rule id> }`; when no rule matches, no option is recommended, `recommendationSource: 'none'`, and a `bb.asks` warning is logged.

- [ ] **Step 1: Failing tests**

`packages/kernel/src/asks/policy.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { parseDuration, recommendForPermission } from './policy.js'

const ws = '/repo/.bytebureau/worktrees/s1'

describe(recommendForPermission, () => {
  it.each([
    [{ name: 'Bash', input: { command: 'git status' } }, 'allow', 'read-only-command'],
    [{ name: 'Read', input: { file_path: `${ws}/src/a.ts` } }, 'allow', 'in-workspace-read'],
    [{ name: 'Write', input: { file_path: `${ws}/src/a.ts` } }, 'allow', 'in-workspace-edit'],
    [{ name: 'Bash', input: { command: 'git push --force origin main' } }, 'deny', 'force-push'],
    [{ name: 'Bash', input: { command: 'rm -rf /' } }, 'deny', 'rm-outside-workspace'],
    [{ name: 'Write', input: { file_path: `${ws}/.env` } }, 'deny', 'secrets-path'],
    [{ name: 'WebFetch', input: { url: 'https://x' } }, 'deny', 'network-in-supervised'],
    [{ name: 'Mystery', input: {} }, null, null],
  ] as const)('%o → %s (%s)', (toolCall, expected, rule) => {
    const result = recommendForPermission(toolCall, ws, 'supervised')
    expect(result.recommended).toBe(expected)
    expect(result.ruleId).toBe(rule)
  })

  it('does not treat network tools as deny-worthy for autonomous employees', () => {
    expect(recommendForPermission({ name: 'WebFetch', input: { url: 'https://x' } }, ws, 'autonomous').recommended).toBeNull()
  })
})

describe(parseDuration, () => {
  it('reads s, m, h suffixes', () => {
    expect(parseDuration('30m')).toBe(1_800_000)
    expect(parseDuration('45s')).toBe(45_000)
    expect(parseDuration('2h')).toBe(7_200_000)
  })
})
```
`packages/kernel/src/asks/ask-service.test.ts`:
```ts
import { assert, it, layer } from '@effect/vitest'
import { Effect, Fiber, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'
import { EventLog, EventLogLive } from '../events/event-log.js'
import { StoreTest } from '../store/store-test.js'
import { AskService, AskServiceLive, DENY_ON_TIMEOUT_MESSAGE } from './ask-service.js'

const TestLayer = AskServiceLive.pipe(Layer.provideMerge(EventLogLive), Layer.provideMerge(StoreTest))
const question = { id: 'q1', header: 'Approach', prompt: 'Which?', multiSelect: false, allowOther: true, options: [
  { id: 'a', label: 'A', recommended: true, evidence: [{ kind: 'test' as const, ref: 'cli.test.ts' }] },
  { id: 'b', label: 'B', recommended: false, evidence: [] },
] }
const seedSession = (id: string) => Effect.flatMap(SqlClient.SqlClient, (sql) => sql`INSERT INTO projects (id, name, path, default_branch, config_json, created_at, updated_at) VALUES ('p', 'p', '/p', 'main', '{}', 't', 't') ON CONFLICT DO NOTHING`.pipe(Effect.andThen(sql`INSERT INTO sessions (id, project_id, title, employee_json, provider_id, workspace_json, status, created_at) VALUES (${id}, 'p', 't', '{}', 'fake', '{}', 'running', 't')`)))

layer(TestLayer)('AskService', (it) => {
  it.effect('opens a question, waits for the answer and records how it was answered', () =>
    Effect.gen(function* () {
      yield* seedSession('s1')
      const asks = yield* AskService
      const ask = yield* asks.open({ sessionId: 's1', turnId: null, kind: 'question', title: 'Choose', questions: [question], permissionMode: 'supervised', askTimeout: '30m', workspacePath: '/ws', recommendationSource: 'agent' })
      assert.strictEqual(ask.recommendationSource, 'agent')
      assert.strictEqual(ask.policy.onTimeout, 'wait')
      const waiting = yield* Effect.forkChild(asks.await(ask.id))
      yield* asks.answer(ask.id, { selected: ['b'] }, 'cli')
      assert.deepStrictEqual(yield* Fiber.join(waiting), { selected: ['b'] })
      const [record] = yield* asks.pending('s1')
      assert.strictEqual(record, undefined)
      const events = yield* (yield* EventLog).read({ sessionId: 's1' }, { from: 0 })
      assert.deepStrictEqual(events.map((event) => event.type), ['ask.requested', 'ask.answered'])
      const failed = yield* Effect.result(asks.answer(ask.id, { selected: ['a'] }, 'cli'))
      assert.strictEqual(failed._tag, 'Failure')
    }),
  )

  it.effect('autonomous question asks auto-proceed with the recommended option after the timeout', () =>
    Effect.gen(function* () {
      yield* seedSession('s2')
      const asks = yield* AskService
      const ask = yield* asks.open({ sessionId: 's2', turnId: null, kind: 'question', title: 'Choose', questions: [question], permissionMode: 'autonomous', askTimeout: '30m', workspacePath: '/ws', recommendationSource: 'agent' })
      const waiting = yield* Effect.forkChild(asks.await(ask.id))
      yield* TestClock.adjust('30 minutes')
      assert.deepStrictEqual(yield* Fiber.join(waiting), { selected: ['a'] })
      const events = yield* (yield* EventLog).read({ sessionId: 's2', types: ['ask.expired', 'ask.answered'] }, { from: 0 })
      assert.deepStrictEqual(events.map((event) => [event.type, (event.payload as { answeredVia?: string; fallback?: string }).answeredVia ?? (event.payload as { fallback?: string }).fallback]), [['ask.expired', 'recommended'], ['ask.answered', 'timeout']])
    }),
  )

  it.effect('permission asks never auto-allow: autonomous ones are denied on timeout with the documented message', () =>
    Effect.gen(function* () {
      yield* seedSession('s3')
      const asks = yield* AskService
      const ask = yield* asks.open({ sessionId: 's3', turnId: 't1', kind: 'permission', title: 'Run git status', questions: [], toolCall: { name: 'Bash', input: { command: 'git status' } }, permissionMode: 'autonomous', askTimeout: '5m', workspacePath: '/ws' })
      assert.strictEqual(ask.recommendationSource, 'policy')
      assert.deepStrictEqual(ask.questions[0]?.options.map((option) => [option.id, option.recommended]), [['allow', true], ['deny', false]])
      const waiting = yield* Effect.forkChild(asks.await(ask.id))
      yield* TestClock.adjust('5 minutes')
      assert.deepStrictEqual(yield* Fiber.join(waiting), { selected: ['deny'], otherText: DENY_ON_TIMEOUT_MESSAGE })
    }),
  )

  it.effect('supervised asks wait indefinitely', () =>
    Effect.gen(function* () {
      yield* seedSession('s4')
      const asks = yield* AskService
      const ask = yield* asks.open({ sessionId: 's4', turnId: null, kind: 'permission', title: 'x', questions: [], toolCall: { name: 'Mystery', input: {} }, permissionMode: 'supervised', askTimeout: '1m', workspacePath: '/ws' })
      assert.strictEqual(ask.recommendationSource, 'none')
      yield* TestClock.adjust('10 hours')
      assert.strictEqual((yield* asks.pending('s4')).length, 1)
    }),
  )
})
```

- [ ] **Step 2: Implementation**

`packages/kernel/src/asks/policy.ts`:
```ts
import type { PermissionMode } from '@bytebureau/protocol'

export interface ToolCall {
  readonly name: string
  readonly input: unknown
}
export interface PermissionRecommendation {
  readonly recommended: 'allow' | 'deny' | null
  readonly ruleId: string | null
}

const READ_ONLY = /^(git (status|log|diff|show|branch|rev-parse)|ls|cat|head|tail|rg|grep|find|wc|pwd|echo)\b/u
const SECRETS = /(^|\/)(\.env(\..*)?|.*\.pem|id_(rsa|ed25519)|\.npmrc|\.netrc)$|(^|\/)\.ssh\//u
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch', 'curl', 'wget'])

const field = (input: unknown, key: string): string => {
  const value = typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[key] : undefined
  return typeof value === 'string' ? value : ''
}

const inside = (filePath: string, workspacePath: string): boolean => filePath.startsWith(`${workspacePath}/`)

// Rules evaluated top-down; the first match decides. Deny rules come first.
export function recommendForPermission(toolCall: ToolCall, workspacePath: string, mode: PermissionMode): PermissionRecommendation {
  const command = field(toolCall.input, 'command')
  const filePath = field(toolCall.input, 'file_path') || field(toolCall.input, 'path')
  if (/\bgit push\b.*(--force|-f\b|\+)/u.test(command)) {
    return { recommended: 'deny', ruleId: 'force-push' }
  }
  if (/\brm\s+-[a-z]*r[a-z]*f?\b/u.test(command) && !command.includes(workspacePath)) {
    return { recommended: 'deny', ruleId: 'rm-outside-workspace' }
  }
  if (filePath !== '' && SECRETS.test(filePath)) {
    return { recommended: 'deny', ruleId: 'secrets-path' }
  }
  if (mode === 'supervised' && NETWORK_TOOLS.has(toolCall.name)) {
    return { recommended: 'deny', ruleId: 'network-in-supervised' }
  }
  if (READ_ONLY.test(command)) {
    return { recommended: 'allow', ruleId: 'read-only-command' }
  }
  if (filePath !== '' && inside(filePath, workspacePath)) {
    return { recommended: 'allow', ruleId: toolCall.name === 'Read' ? 'in-workspace-read' : 'in-workspace-edit' }
  }
  return { recommended: null, ruleId: null }
}

export function parseDuration(text: string): number {
  const match = /^(\d+)\s*(ms|s|m|h)$/u.exec(text.trim())
  if (match === null) {
    throw new Error(`invalid duration: ${text}`)
  }
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] as 'ms' | 's' | 'm' | 'h']
  return Number(match[1]) * unit
}
```
`packages/kernel/src/asks/ask-service.ts`:
```ts
import type { AnsweredVia, Ask, AskAnswer, AskOption, AskQuestion, AskRecord, PermissionMode } from '@bytebureau/protocol'
import { Context, Deferred, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { AskError, StoreError } from '../errors.js'
import { EventLog } from '../events/event-log.js'
import { nowIso, uuidv7 } from '../ids.js'
import { kernelLogger } from '../logging/logging.js'
import { parseDuration, recommendForPermission, type ToolCall } from './policy.js'

export const DENY_ON_TIMEOUT_MESSAGE = 'nobody available to approve; do not retry'

export interface OpenAskInput {
  readonly sessionId: string
  readonly turnId: string | null
  readonly kind: 'question' | 'permission'
  readonly title: string
  readonly questions: readonly AskQuestion[]
  readonly toolCall?: ToolCall | undefined
  readonly permissionMode: PermissionMode
  readonly askTimeout: string
  readonly workspacePath: string
  readonly recommendationSource?: 'agent' | 'none' | undefined
}
export interface AskServiceShape {
  open(input: OpenAskInput): Effect.Effect<AskRecord, StoreError>
  answer(askId: string, answer: AskAnswer, via: AnsweredVia): Effect.Effect<AskRecord, AskError | StoreError>
  cancel(askId: string): Effect.Effect<void, StoreError>
  pending(sessionId?: string): Effect.Effect<readonly AskRecord[], StoreError>
  await(askId: string): Effect.Effect<AskAnswer, AskError>
}

export class AskService extends Context.Service<AskService, AskServiceShape>()('bb/AskService') {}

interface Row {
  readonly id: string
  readonly payload_json: string
  readonly status: string
  readonly answer_json: string | null
  readonly answered_at: string | null
  readonly answered_via: string | null
}

const fromRow = (row: Row): AskRecord => ({
  ...(JSON.parse(row.payload_json) as Ask),
  status: row.status as AskRecord['status'],
  answer: row.answer_json === null ? null : (JSON.parse(row.answer_json) as AskAnswer),
  answeredAt: row.answered_at,
  answeredVia: row.answered_via as AskRecord['answeredVia'],
})

const permissionQuestion = (toolCall: ToolCall, workspacePath: string, mode: PermissionMode): { question: AskQuestion; source: Ask['recommendationSource'] } => {
  const { recommended, ruleId } = recommendForPermission(toolCall, workspacePath, mode)
  const option = (id: 'allow' | 'deny', label: string): AskOption => ({
    id,
    label,
    recommended: recommended === id,
    evidence: recommended === id && ruleId !== null ? [{ kind: 'rule', ref: ruleId }] : [],
  })
  return {
    question: { id: 'permission', header: 'Permission', prompt: `${toolCall.name}: allow this tool call?`, options: [option('allow', 'Allow'), option('deny', 'Deny')], multiSelect: false, allowOther: false },
    source: recommended === null ? 'none' : 'policy',
  }
}

const policyFor = (input: OpenAskInput): Ask['policy'] => {
  if (input.permissionMode === 'supervised') {
    return { onTimeout: 'wait', timeout: input.askTimeout }
  }
  return { onTimeout: input.kind === 'question' ? 'recommended' : 'deny', timeout: input.askTimeout }
}

const recommendedAnswer = (ask: Ask): AskAnswer => ({
  selected: ask.questions.map((question) => question.options.find((option) => option.recommended)?.id ?? ''),
})

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const log = yield* EventLog
  const logger = kernelLogger(['bb', 'asks'])
  const waiters = new Map<string, Deferred.Deferred<AskAnswer, AskError>>()
  const wrap = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, StoreError> => Effect.mapError(effect, (cause) => new StoreError({ cause }))

  const load = (askId: string) => wrap(Effect.map(sql<Row>`SELECT id, payload_json, status, answer_json, answered_at, answered_via FROM asks WHERE id = ${askId}`, (rows) => (rows[0] === undefined ? undefined : fromRow(rows[0]))))

  const settle = (record: AskRecord, answer: AskAnswer, via: AnsweredVia): Effect.Effect<AskRecord, StoreError> =>
    Effect.gen(function* () {
      const answeredAt = nowIso()
      yield* wrap(sql`UPDATE asks SET status = 'answered', answer_json = ${JSON.stringify(answer)}, answered_at = ${answeredAt}, answered_via = ${via} WHERE id = ${record.id}`)
      yield* log.publish({ type: 'ask.answered', sessionId: record.sessionId, ...(record.turnId === null ? {} : { turnId: record.turnId }), payload: { askId: record.id, answer, answeredVia: via } })
      const waiter = waiters.get(record.id)
      if (waiter !== undefined) {
        yield* Deferred.succeed(waiter, answer)
        waiters.delete(record.id)
      }
      return { ...record, status: 'answered', answer, answeredAt, answeredVia: via }
    })

  const expire = (ask: Ask): Effect.Effect<void, StoreError> =>
    Effect.gen(function* () {
      const current = yield* load(ask.id)
      if (current === undefined || current.status !== 'pending') {
        return
      }
      const fallback = ask.policy.onTimeout
      yield* log.publish({ type: 'ask.expired', sessionId: ask.sessionId, payload: { askId: ask.id, fallback } })
      const answer: AskAnswer = fallback === 'deny' ? { selected: ['deny'], otherText: DENY_ON_TIMEOUT_MESSAGE } : recommendedAnswer(ask)
      yield* settle(current, answer, 'timeout')
    })

  const open: AskServiceShape['open'] = (input) =>
    Effect.gen(function* () {
      const built = input.kind === 'permission' && input.toolCall !== undefined ? permissionQuestion(input.toolCall, input.workspacePath, input.permissionMode) : undefined
      const questions = built === undefined ? input.questions : [built.question]
      const source: Ask['recommendationSource'] = built?.source ?? (questions.some((question) => question.options.some((option) => option.recommended)) ? (input.recommendationSource ?? 'agent') : 'none')
      if (source === 'none') {
        logger.warn('no recommendation available', { sessionId: input.sessionId, title: input.title })
      }
      const policy = policyFor(input)
      const createdAt = nowIso()
      const deadlineAt = policy.onTimeout === 'wait' ? null : new Date(Date.parse(createdAt) + parseDuration(policy.timeout)).toISOString()
      const ask: Ask = { id: uuidv7(), sessionId: input.sessionId, turnId: input.turnId, kind: input.kind, title: input.title, questions, ...(input.toolCall === undefined ? {} : { toolCall: input.toolCall }), policy, recommendationSource: source, status: 'pending', createdAt, deadlineAt }
      yield* wrap(sql`INSERT INTO asks (id, session_id, turn_id, kind, payload_json, status, recommendation_source, created_at, deadline_at) VALUES (${ask.id}, ${ask.sessionId}, ${ask.turnId}, ${ask.kind}, ${JSON.stringify(ask)}, 'pending', ${source}, ${createdAt}, ${deadlineAt})`)
      waiters.set(ask.id, yield* Deferred.make<AskAnswer, AskError>())
      yield* log.publish({ type: 'ask.requested', sessionId: ask.sessionId, ...(ask.turnId === null ? {} : { turnId: ask.turnId }), payload: { ask } })
      if (policy.onTimeout !== 'wait') {
        yield* Effect.forkChild(Effect.andThen(Effect.sleep(parseDuration(policy.timeout)), expire(ask)).pipe(Effect.ignore))
      }
      return { ...ask, answer: null, answeredAt: null, answeredVia: null }
    })

  return AskService.of({
    open,
    answer: (askId, answer, via) =>
      Effect.gen(function* () {
        const record = yield* load(askId)
        if (record === undefined) {
          return yield* new AskError({ code: 'not_found', reason: `ask ${askId} does not exist` })
        }
        if (record.status !== 'pending') {
          return yield* new AskError({ code: 'not_pending', reason: `ask ${askId} is ${record.status}` })
        }
        return yield* settle(record, answer, via)
      }),
    cancel: (askId) =>
      Effect.gen(function* () {
        const record = yield* load(askId)
        if (record === undefined || record.status !== 'pending') {
          return
        }
        yield* wrap(sql`UPDATE asks SET status = 'cancelled' WHERE id = ${askId}`)
        yield* log.publish({ type: 'ask.cancelled', sessionId: record.sessionId, payload: { askId } })
        const waiter = waiters.get(askId)
        if (waiter !== undefined) {
          yield* Deferred.fail(waiter, new AskError({ code: 'not_pending', reason: 'cancelled' }))
          waiters.delete(askId)
        }
      }),
    pending: (sessionId) => wrap(Effect.map(sql<Row>`SELECT id, payload_json, status, answer_json, answered_at, answered_via FROM asks WHERE status = 'pending' AND (${sessionId ?? null} IS NULL OR session_id = ${sessionId ?? null}) ORDER BY created_at`, (rows) => rows.map(fromRow))),
    await: (askId) => {
      const waiter = waiters.get(askId)
      return waiter === undefined ? Effect.fail(new AskError({ code: 'not_found', reason: `ask ${askId} is not pending in this process` })) : Deferred.await(waiter)
    },
  })
})

export const AskServiceLive: Layer.Layer<AskService, never, SqlClient.SqlClient | EventLog> = Layer.effect(AskService, make)
```
The forked timer uses `Effect.sleep`, so `TestClock.adjust` drives it in tests; in production the clock is real. Confirm `Deferred.make/succeed/fail/await` and `Effect.forkChild` names in the installed d.ts (the fact sheet lists `forkChild`).

Add to `index.ts`: `export { AskService, AskServiceLive, DENY_ON_TIMEOUT_MESSAGE, type OpenAskInput, type AskServiceShape } from './asks/ask-service.js'`, `export { recommendForPermission, parseDuration } from './asks/policy.js'`.

- [ ] **Step 3: Run, commit**

Run: `bunx vitest run --project kernel` → PASS. `bun run check` → green.

```bash
git add packages/kernel
git commit -m "feat(kernel): broker questions and permissions with recommended options and timeout policy"
```

### Task 13: Sessions — state machine, `SessionManager`, `UsageService`, the fake agent provider

**Files:**
- Create: `packages/kernel/src/sessions/state-machine.ts`, `packages/kernel/src/sessions/types.ts`, `packages/kernel/src/sessions/translate.ts`, `packages/kernel/src/sessions/session-manager.ts`, `packages/kernel/src/usage/usage-service.ts`, `packages/kernel/src/testing/fake-agent-provider.ts`, `packages/kernel/src/testing/fake-agent-plugin.ts`, `packages/kernel/src/sessions/state-machine.test.ts`, `packages/kernel/src/sessions/session-manager.test.ts`, `packages/kernel/src/usage/usage-service.test.ts`
- Modify: `packages/kernel/src/plugins/bundled.ts` (append `fakeAgentPlugin`), `packages/kernel/src/index.ts`, `packages/kernel/package.json` (devDependency `fast-check` 4.10.2)

**Interfaces:**
- Consumes: everything from Tasks 1–12; `fast-check` (root devDependency) for the model-based transition test.
- Produces: `transition(status: SessionStatus, event: SessionEvent): SessionStatus | null` with `SessionEvent = 'provision' | 'provisioned' | 'prompt' | 'ask' | 'answer' | 'turn_done' | 'rate_limit' | 'limit_reset' | 'stop' | 'crash' | 'complete' | 'resume'`; `Session { id; projectId; title; employee: EmployeeSpec; providerId; profileId: string | null; workspace: WorkspaceHandle | null; externalRef: ExternalSessionRef | null; status; createdAt; startedAt; endedAt }`, `Turn { id; sessionId; index; prompt: PromptInput; status; stopReason; usage: Usage | null; startedAt; endedAt }`; `SessionManager` service `{ create(input: CreateSessionInput): Effect<Session, SessionError | WorkspaceError | ConfigError | StoreError>; prompt(sessionId, input): Effect<Turn, SessionError | ProviderError | StoreError>; interrupt(sessionId): Effect<void, SessionError>; stop(sessionId): Effect<void, SessionError | StoreError>; complete(sessionId): Effect<void, SessionError | StoreError>; resume(sessionId): Effect<Session, SessionError | StoreError>; list(): Effect<readonly Session[], StoreError>; get(id): Effect<Session | undefined, StoreError> }`, `SessionManagerLive`, `CreateSessionInput { projectId; title; employeeId?; providerId?; profileId?; branch? }`; `UsageService` `{ sessionUsage(sessionId): Effect<SessionUsage, StoreError>; record(profileId: string | null, rateLimit: RateLimit): Effect<void, StoreError>; snapshot(profileId): Effect<UsageSnapshot | undefined, StoreError> }`, `SessionUsage { turns; inputTokens; outputTokens; costUsd: number | null; contextPct: number | null }`; `FakeAgentProvider` (`id: 'fake'`), `fakeAgentPlugin` (bundled, name `agent-fake`), scripts `hello` (default) and `slow` chosen by `BYTEBUREAU_FAKE_SCRIPT` in the session environment.

- [ ] **Step 1: Failing tests**

`packages/kernel/src/sessions/state-machine.test.ts` (model-based, spec §15):
```ts
import type { SessionStatus } from '@bytebureau/protocol'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { SESSION_EVENTS, transition, type SessionEvent } from './state-machine.js'

const TERMINAL: readonly SessionStatus[] = ['completed']

class Step implements fc.Command<{ status: SessionStatus }, { status: SessionStatus }> {
  readonly event: SessionEvent
  constructor(event: SessionEvent) {
    this.event = event
  }
  check(): boolean {
    return true
  }
  run(model: { status: SessionStatus }, real: { status: SessionStatus }): void {
    const next = transition(real.status, this.event)
    if (next === null) {
      expect(real.status).toBe(model.status)
      return
    }
    expect(TERMINAL.includes(model.status)).toBe(false)
    model.status = next
    real.status = next
  }
  toString(): string {
    return this.event
  }
}

describe(transition, () => {
  it('follows the documented edges', () => {
    expect(transition('created', 'provision')).toBe('provisioning')
    expect(transition('provisioning', 'provisioned')).toBe('ready')
    expect(transition('ready', 'prompt')).toBe('running')
    expect(transition('running', 'ask')).toBe('waiting_for_human')
    expect(transition('waiting_for_human', 'answer')).toBe('running')
    expect(transition('running', 'turn_done')).toBe('ready')
    expect(transition('running', 'rate_limit')).toBe('paused_usage_limit')
    expect(transition('paused_usage_limit', 'limit_reset')).toBe('running')
    expect(transition('running', 'stop')).toBe('stopped')
    expect(transition('running', 'crash')).toBe('errored')
    expect(transition('ready', 'complete')).toBe('completed')
    expect(transition('stopped', 'resume')).toBe('ready')
    expect(transition('completed', 'prompt')).toBeNull()
    expect(transition('created', 'prompt')).toBeNull()
  })

  it('never leaves a terminal state and only produces known statuses (model-based)', () => {
    fc.assert(
      fc.property(fc.commands(SESSION_EVENTS.map((event) => fc.constant(new Step(event))), { maxCommands: 40 }), (commands) => {
        fc.modelRun(() => ({ model: { status: 'created' as SessionStatus }, real: { status: 'created' as SessionStatus } }), commands)
      }),
      { numRuns: 300 },
    )
  })
})
```
`packages/kernel/src/usage/usage-service.test.ts`:
```ts
import { assert, it, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { StoreTest } from '../store/store-test.js'
import { UsageService, UsageServiceLive } from './usage-service.js'

layer(UsageServiceLive.pipe(Layer.provideMerge(StoreTest)))('UsageService', (it) => {
  it.effect('sums turn usage per session and keeps the latest rate-limit snapshot per profile', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO projects (id, name, path, default_branch, config_json, created_at, updated_at) VALUES ('p', 'p', '/p', 'main', '{}', 't', 't')`
      yield* sql`INSERT INTO sessions (id, project_id, title, employee_json, provider_id, workspace_json, status, created_at) VALUES ('s', 'p', 't', '{}', 'fake', '{}', 'ready', 't')`
      yield* sql`INSERT INTO turns (id, session_id, idx, prompt_json, status, usage_json, started_at) VALUES ('t1', 's', 0, '{}', 'completed', '{"inputTokens":10,"outputTokens":4,"costUsd":0.01,"contextPct":12}', 't'), ('t2', 's', 1, '{}', 'completed', '{"inputTokens":5,"outputTokens":1}', 't')`
      const usage = yield* UsageService
      assert.deepStrictEqual(yield* usage.sessionUsage('s'), { turns: 2, inputTokens: 15, outputTokens: 5, costUsd: 0.01, contextPct: 12 })
      yield* usage.record('prof', { fiveHourPct: 40 })
      yield* usage.record('prof', { fiveHourPct: 55, sevenDayPct: 10 })
      assert.deepStrictEqual((yield* usage.snapshot('prof'))?.rateLimit, { fiveHourPct: 55, sevenDayPct: 10 })
    }),
  )
})
```
`packages/kernel/src/sessions/session-manager.test.ts`:
```ts
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assert, it, layer } from '@effect/vitest'
import { Effect, Fiber, Stream } from 'effect'
import { AskService } from '../asks/ask-service.js'
import { EventLog } from '../events/event-log.js'
import { KernelTest } from '../kernel-live.js'
import { PluginHost } from '../plugins/plugin-host.js'
import { ProjectRegistry } from '../projects/project-registry.js'
import { createTempRepo } from '../testing/temp-repo.js'
import { SessionManager } from './session-manager.js'

const prompt = 'Create src/hello.ts exporting hello()\r\nwith čeština and an emoji 🚀'

layer(KernelTest({ home: mkdtempSync(path.join(tmpdir(), 'bb-home-')) }))('SessionManager', (it) => {
  it.effect('runs a prompt through the fake provider: worktree, events, ask, file, usage, completion', () =>
    Effect.gen(function* () {
      yield* (yield* PluginHost).load()
      const project = yield* (yield* ProjectRegistry).register(createTempRepo())
      const sessions = yield* SessionManager
      const log = yield* EventLog
      const session = yield* sessions.create({ projectId: project.id, title: 'Add hello', providerId: 'fake' })
      assert.strictEqual(session.status, 'ready')
      assert.ok(session.workspace !== null && existsSync(session.workspace.path))
      const collected = yield* Effect.forkChild(log.subscribe({ sessionId: session.id, since: 0 }).pipe(Stream.takeUntil((event) => event.type === 'session.completed'), Stream.runCollect))
      yield* Effect.yieldNow()
      const turn = yield* sessions.prompt(session.id, { text: prompt })
      assert.strictEqual(turn.index, 0)
      const asks = yield* AskService
      const [ask] = yield* Effect.repeat(asks.pending(session.id), { until: (pending) => pending.length > 0 })
      assert.strictEqual(ask?.questions[0]?.options.filter((option) => option.recommended).length, 1)
      yield* asks.answer(ask!.id, { selected: ['yes'] }, 'cli')
      yield* Effect.repeat(sessions.get(session.id), { until: (current) => current?.status === 'ready' })
      yield* sessions.complete(session.id)
      const events = [...(yield* Fiber.join(collected))]
      const types = events.map((event) => event.type)
      for (const expected of ['session.created', 'session.provisioning', 'workspace.provisioned', 'session.ready', 'message.user', 'turn.started', 'tool.started', 'tool.completed', 'ask.requested', 'session.waiting', 'ask.answered', 'session.running', 'message.assistant.completed', 'usage.updated', 'turn.completed', 'session.completed']) {
        assert.include(types, expected)
      }
      const user = events.find((event) => event.type === 'message.user')
      assert.strictEqual((user?.payload as { text: string }).text, prompt)
      assert.ok(existsSync(path.join(session.workspace!.path, 'src', 'hello.ts')))
      assert.ok(events.every((event, index) => index === 0 || event.seq === 0 || event.seq > (events[index - 1]?.seq ?? 0) || events[index - 1]?.seq === 0))
    }),
  )

  it.effect('refuses yolo on the local runtime and unknown providers before provisioning', () =>
    Effect.gen(function* () {
      yield* (yield* PluginHost).load()
      const repo = createTempRepo()
      writeFileSync(path.join(repo, 'bytebureau.json'), JSON.stringify({ version: 1, project: { name: 'yolo-test' }, employees: { cowboy: { name: 'Cowboy', provider: 'fake', model: 'm', permissionMode: 'yolo' } } }))
      const project = yield* (yield* ProjectRegistry).register(repo)
      const sessions = yield* SessionManager
      const yolo = yield* Effect.result(sessions.create({ projectId: project.id, title: 'x', employeeId: 'cowboy' }))
      assert.strictEqual(yolo._tag, 'Failure')
      assert.match(String(yolo._tag === 'Failure' ? yolo.failure : ''), /yolo.*local/u)
      const missing = yield* Effect.result(sessions.create({ projectId: project.id, title: 'x', employeeId: 'cowboy', providerId: 'nope' }))
      assert.strictEqual(missing._tag, 'Failure')
      assert.ok(!existsSync(path.join(repo, '.bytebureau', 'worktrees')))
    }),
  )

  it.effect('stop marks the running turn interrupted, keeps the worktree and resume returns to ready', () =>
    Effect.gen(function* () {
      yield* (yield* PluginHost).load()
      const project = yield* (yield* ProjectRegistry).register(createTempRepo())
      const sessions = yield* SessionManager
      const session = yield* sessions.create({ projectId: project.id, title: 'slow', providerId: 'fake', env: { BYTEBUREAU_FAKE_SCRIPT: 'slow' } })
      yield* sessions.prompt(session.id, { text: 'take your time' })
      yield* sessions.stop(session.id)
      const stopped = yield* sessions.get(session.id)
      assert.strictEqual(stopped?.status, 'stopped')
      assert.ok(existsSync(session.workspace!.path))
      const events = yield* (yield* EventLog).read({ sessionId: session.id, types: ['turn.interrupted', 'session.stopped'] }, { from: 0 })
      assert.deepStrictEqual(events.map((event) => event.type), ['turn.interrupted', 'session.stopped'])
      assert.strictEqual((yield* sessions.resume(session.id)).status, 'ready')
    }),
  )
})
```
`KernelTest(options)` is defined in Task 14; this task's tests run after Task 14 lands — write the session-manager test now, commit it with `it.skip` guards removed only in Task 14 (or keep the whole test file for Task 14's commit). `CreateSessionInput` gains an optional `env` (extra session environment, allowlisted `BYTEBUREAU_*` only) used by the test and the CLI.

- [ ] **Step 2: State machine and types**

`packages/kernel/src/sessions/state-machine.ts`:
```ts
import type { SessionStatus } from '@bytebureau/protocol'

export const SESSION_EVENTS = ['provision', 'provisioned', 'prompt', 'ask', 'answer', 'turn_done', 'rate_limit', 'limit_reset', 'stop', 'crash', 'complete', 'resume'] as const
export type SessionEvent = (typeof SESSION_EVENTS)[number]

const EDGES: Readonly<Record<SessionEvent, Partial<Readonly<Record<SessionStatus, SessionStatus>>>>> = {
  provision: { created: 'provisioning' },
  provisioned: { provisioning: 'ready' },
  prompt: { ready: 'running' },
  ask: { running: 'waiting_for_human' },
  answer: { waiting_for_human: 'running' },
  turn_done: { running: 'ready', waiting_for_human: 'ready' },
  rate_limit: { running: 'paused_usage_limit' },
  limit_reset: { paused_usage_limit: 'running' },
  stop: { ready: 'stopped', running: 'stopped', waiting_for_human: 'stopped', paused_usage_limit: 'stopped', provisioning: 'stopped' },
  crash: { running: 'errored', waiting_for_human: 'errored', provisioning: 'errored' },
  complete: { ready: 'completed' },
  resume: { stopped: 'ready', errored: 'ready' },
}

// null means "not allowed from this status"; callers turn it into SessionError('invalid_transition')
export const transition = (status: SessionStatus, event: SessionEvent): SessionStatus | null => EDGES[event][status] ?? null
```
`packages/kernel/src/sessions/types.ts`:
```ts
import type { ExternalSessionRef, WorkspaceHandle } from '@bytebureau/plugin-api'
import type { EmployeeSpec, PromptInput, SessionStatus, TurnStatus, Usage } from '@bytebureau/protocol'

export interface Session {
  readonly id: string
  readonly projectId: string
  readonly title: string
  readonly employee: EmployeeSpec
  readonly providerId: string
  readonly profileId: string | null
  readonly workspace: WorkspaceHandle | null
  readonly externalRef: ExternalSessionRef | null
  readonly status: SessionStatus
  readonly createdAt: string
  readonly startedAt: string | null
  readonly endedAt: string | null
}
export interface Turn {
  readonly id: string
  readonly sessionId: string
  readonly index: number
  readonly prompt: PromptInput
  readonly status: TurnStatus
  readonly stopReason: string | null
  readonly usage: Usage | null
  readonly startedAt: string
  readonly endedAt: string | null
}
export interface CreateSessionInput {
  readonly projectId: string
  readonly title: string
  readonly employeeId?: string | undefined
  readonly providerId?: string | undefined
  readonly profileId?: string | undefined
  readonly branch?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
}
```

- [ ] **Step 3: Usage service**

`packages/kernel/src/usage/usage-service.ts`:
```ts
import type { RateLimit, Usage } from '@bytebureau/protocol'
import { Context, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { StoreError } from '../errors.js'
import { nowIso } from '../ids.js'

export interface SessionUsage {
  readonly turns: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd: number | null
  readonly contextPct: number | null
}
export interface UsageSnapshot {
  readonly profileId: string
  readonly rateLimit: RateLimit
  readonly observedAt: string
}
export interface UsageServiceShape {
  sessionUsage(sessionId: string): Effect.Effect<SessionUsage, StoreError>
  record(profileId: string | null, rateLimit: RateLimit): Effect.Effect<void, StoreError>
  snapshot(profileId: string): Effect.Effect<UsageSnapshot | undefined, StoreError>
}

export class UsageService extends Context.Service<UsageService, UsageServiceShape>()('bb/UsageService') {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const wrap = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, StoreError> => Effect.mapError(effect, (cause) => new StoreError({ cause }))
  return UsageService.of({
    sessionUsage: (sessionId) =>
      wrap(
        Effect.map(sql<{ readonly usage_json: string | null }>`SELECT usage_json FROM turns WHERE session_id = ${sessionId} ORDER BY idx`, (rows) => {
          const usages = rows.flatMap((row) => (row.usage_json === null ? [] : [JSON.parse(row.usage_json) as Usage]))
          const costs = usages.flatMap((usage) => (usage.costUsd === undefined ? [] : [usage.costUsd]))
          return {
            turns: rows.length,
            inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
            outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
            costUsd: costs.length === 0 ? null : costs.reduce((sum, cost) => sum + cost, 0),
            contextPct: usages.at(-1)?.contextPct ?? null,
          }
        }),
      ),
    record: (profileId, rateLimit) =>
      wrap(Effect.asVoid(sql`INSERT INTO usage_snapshots (profile_id, five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at, source, observed_at) VALUES (${profileId ?? 'default'}, ${rateLimit.fiveHourPct ?? null}, ${rateLimit.fiveHourResetsAt ?? null}, ${rateLimit.sevenDayPct ?? null}, ${rateLimit.sevenDayResetsAt ?? null}, 'provider', ${nowIso()})`)),
    snapshot: (profileId) =>
      wrap(
        Effect.map(
          sql<{ readonly five_hour_pct: number | null; readonly five_hour_resets_at: string | null; readonly seven_day_pct: number | null; readonly seven_day_resets_at: string | null; readonly observed_at: string }>`SELECT five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at, observed_at FROM usage_snapshots WHERE profile_id = ${profileId} ORDER BY observed_at DESC, rowid DESC LIMIT 1`,
          (rows) => {
            const row = rows[0]
            if (row === undefined) {
              return undefined
            }
            const rateLimit: RateLimit = {
              ...(row.five_hour_pct === null ? {} : { fiveHourPct: row.five_hour_pct }),
              ...(row.five_hour_resets_at === null ? {} : { fiveHourResetsAt: row.five_hour_resets_at }),
              ...(row.seven_day_pct === null ? {} : { sevenDayPct: row.seven_day_pct }),
              ...(row.seven_day_resets_at === null ? {} : { sevenDayResetsAt: row.seven_day_resets_at }),
            }
            return { profileId, rateLimit, observedAt: row.observed_at }
          },
        ),
      ),
  })
})

export const UsageServiceLive: Layer.Layer<UsageService, never, SqlClient.SqlClient> = Layer.effect(UsageService, make)
```

- [ ] **Step 4: Fake agent provider and plugin**

`packages/kernel/src/testing/fake-agent-provider.ts`:
```ts
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AgentProvider, AgentSession, AskAnswer, CreateSessionRequest } from '@bytebureau/plugin-api'
import type { AgentEvent, Ask, PromptInput } from '@bytebureau/protocol'

type Script = 'hello' | 'slow'

// Minimal async queue: producers push, the consumer iterates; end() finishes the iteration
class EventQueue {
  private readonly items: AgentEvent[] = []
  private waiter: (() => void) | null = null
  private closed = false
  push(event: AgentEvent): void {
    this.items.push(event)
    this.waiter?.()
  }
  end(): void {
    this.closed = true
    this.waiter?.()
  }
  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    for (;;) {
      const next = this.items.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.closed) {
        return
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
      this.waiter = null
    }
  }
}

const CAPABILITIES = { resume: false, interrupt: true, askUser: true, permissions: false, structuredOutput: false, usage: true, rateLimits: false, contextUsage: true, thinking: false, setModel: false, setEffort: false, attachments: false } as const

const question = (sessionId: string): Ask => ({
  id: `fake-ask-${sessionId}`,
  sessionId,
  turnId: null,
  kind: 'question',
  title: 'Export style',
  questions: [
    {
      id: 'style',
      header: 'Export',
      prompt: 'Should hello() be a named export?',
      multiSelect: false,
      allowOther: true,
      options: [
        { id: 'yes', label: 'Named export (Recommended)', description: 'Matches the existing modules', recommended: true, evidence: [{ kind: 'rule', ref: 'oxlint import/no-default-export' }] },
        { id: 'default', label: 'Default export', recommended: false, evidence: [] },
      ],
    },
  ],
  policy: { onTimeout: 'wait', timeout: '30m' },
  recommendationSource: 'agent',
  status: 'pending',
  createdAt: new Date().toISOString(),
  deadlineAt: null,
})

class FakeSession implements AgentSession {
  readonly externalRef = null
  private readonly queue = new EventQueue()
  private answerResolver: ((answer: AskAnswer) => void) | null = null
  private interrupted = false
  private slowTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly request: CreateSessionRequest,
    private readonly script: Script,
  ) {}

  async prompt(input: PromptInput): Promise<void> {
    await (this.script === 'slow' ? this.runSlow() : this.runHello(input))
  }

  interrupt(): Promise<void> {
    this.interrupted = true
    if (this.slowTimer !== null) {
      clearTimeout(this.slowTimer)
    }
    this.queue.push({ type: 'turn.completed', stopReason: 'interrupted', usage: { inputTokens: 0, outputTokens: 0 } })
    return Promise.resolve()
  }

  answer(_askId: string, answer: AskAnswer): Promise<void> {
    this.answerResolver?.(answer)
    return Promise.resolve()
  }

  events(): AsyncIterable<AgentEvent> {
    return this.queue
  }

  close(): Promise<void> {
    this.queue.end()
    return Promise.resolve()
  }

  private runSlow(): Promise<void> {
    this.queue.push({ type: 'turn.started' })
    return new Promise((resolve) => {
      this.slowTimer = setTimeout(() => {
        if (!this.interrupted) {
          this.queue.push({ type: 'turn.completed', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } })
        }
        resolve()
      }, 10_000)
    })
  }

  private async runHello(input: PromptInput): Promise<void> {
    const push = (event: AgentEvent): void => this.queue.push(event)
    push({ type: 'turn.started' })
    push({ type: 'message.delta', kind: 'text', text: 'Creating src/hello.ts' })
    push({ type: 'tool.started', id: 'tool-1', name: 'Write', kind: 'builtin', input: { path: 'src/hello.ts' } })
    const target = path.join(this.request.workspace.path, 'src', 'hello.ts')
    mkdirSync(path.dirname(target), { recursive: true })
    const answer = await new Promise<AskAnswer>((resolve) => {
      this.answerResolver = resolve
      push({ type: 'ask.requested', ask: question(this.request.sessionId) })
    })
    const named = answer.selected !== 'other' && answer.selected[0] !== 'default'
    writeFileSync(target, named ? "export function hello(): string {\n  return 'hello'\n}\n" : "export default function hello(): string {\n  return 'hello'\n}\n")
    push({ type: 'tool.completed', id: 'tool-1', outputSummary: 'wrote src/hello.ts', bytes: 48 })
    push({ type: 'message.completed', role: 'assistant', content: [{ type: 'text', text: `Done: ${input.text.length} characters of instructions handled.` }], text: 'Created src/hello.ts exporting hello().' })
    push({ type: 'usage.updated', usage: { inputTokens: 120, outputTokens: 40, costUsd: 0.002, contextPct: 3 } })
    push({ type: 'turn.completed', stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 40, costUsd: 0.002, contextPct: 3 } })
  }
}

export class FakeAgentProvider implements AgentProvider {
  readonly id = 'fake'
  readonly displayName = 'Fake agent (tests and CI)'
  readonly capabilities = CAPABILITIES
  authStatus(): Promise<{ state: 'loggedIn' }> {
    return Promise.resolve({ state: 'loggedIn' })
  }
  createSession(request: CreateSessionRequest): Promise<AgentSession> {
    const script = request.env['BYTEBUREAU_FAKE_SCRIPT'] === 'slow' ? 'slow' : 'hello'
    return Promise.resolve(new FakeSession(request, script))
  }
}
```
`packages/kernel/src/testing/fake-agent-plugin.ts`:
```ts
import { definePlugin, type Plugin } from '@bytebureau/plugin-api'
import { FakeAgentProvider } from './fake-agent-provider.js'

export const fakeAgentPlugin: Plugin = definePlugin({
  manifest: { name: 'agent-fake', version: '0.0.0', displayName: 'Fake agent', hostApi: '^0', kind: 'in-process', contributes: { agentProviders: ['fake'] } },
  setup: () => ({ agentProviders: [new FakeAgentProvider()] }),
})
```
`packages/kernel/src/plugins/bundled.ts`: `BUNDLED_PLUGINS` becomes `[localWorkspacePlugin, fakeAgentPlugin]` (the fake provider ships in the binary on purpose: it is the documented way to smoke-test an installation without an agent subscription).

- [ ] **Step 5: Event translation and the session manager**

`packages/kernel/src/sessions/translate.ts`:
```ts
import type { AgentEvent, KernelEvent } from '@bytebureau/protocol'

export interface TurnRef {
  readonly turnId: string
  readonly index: number
}

// Pure mapping provider → kernel catalogue; asks and turn bookkeeping are handled by the SessionManager
export function translate(event: AgentEvent, turn: TurnRef): KernelEvent | null {
  switch (event.type) {
    case 'turn.started': {
      return { type: 'turn.started', payload: { ...turn, status: 'running' } }
    }
    case 'message.delta': {
      return { type: 'message.assistant.delta', payload: { kind: event.kind, text: event.text } }
    }
    case 'message.completed': {
      return event.role === 'assistant' ? { type: 'message.assistant.completed', payload: { text: event.text, content: event.content } } : null
    }
    case 'tool.started': {
      return { type: 'tool.started', payload: { id: event.id, name: event.name, kind: event.kind, input: event.input } }
    }
    case 'tool.completed': {
      return { type: 'tool.completed', payload: { id: event.id, name: '', outputSummary: event.outputSummary, bytes: event.bytes } }
    }
    case 'tool.failed': {
      return { type: 'tool.failed', payload: { id: event.id, name: '', error: event.error } }
    }
    case 'subagent.started':
    case 'subagent.stopped': {
      return { type: event.type, payload: { id: event.id, name: event.name } }
    }
    case 'usage.updated': {
      return { type: 'usage.updated', payload: { usage: event.usage } }
    }
    case 'ratelimit.updated': {
      return { type: 'ratelimit.updated', payload: { profileId: null, rateLimit: event.rateLimit } }
    }
    case 'compaction.started':
    case 'compaction.completed': {
      return { type: event.type, payload: {} }
    }
    case 'session.warning': {
      return { type: 'session.warning', payload: { kind: event.kind, message: event.message } }
    }
    default: {
      return null
    }
  }
}
```
(`tool.completed`/`tool.failed` carry `name: ''` here; the SessionManager fills the name from its `tool_calls` bookkeeping before publishing.)

`packages/kernel/src/sessions/session-manager.ts`:
```ts
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { AgentSession, ExternalSessionRef, WorkspaceHandle } from '@bytebureau/plugin-api'
import type { AgentEvent, EmployeeSpec, PromptInput, SessionStatus, Usage } from '@bytebureau/protocol'
import { Context, Effect, Fiber, Layer, Stream } from 'effect'
import { SqlClient } from 'effect/sql'
import { AskService } from '../asks/ask-service.js'
import { ConfigError, ProviderError, SessionError, StoreError, WorkspaceError } from '../errors.js'
import { EventLog } from '../events/event-log.js'
import { nowIso, uuidv7 } from '../ids.js'
import { kernelLogger } from '../logging/logging.js'
import { PluginHost } from '../plugins/plugin-host.js'
import { allowlistEnv } from '../process/env-allowlist.js'
import { ProjectRegistry, type Project } from '../projects/project-registry.js'
import { UsageService } from '../usage/usage-service.js'
import { WorkspaceManager } from '../workspace/workspace-manager.js'
import { transition, type SessionEvent } from './state-machine.js'
import { translate } from './translate.js'
import type { CreateSessionInput, Session, Turn } from './types.js'

export interface SessionManagerShape {
  create(input: CreateSessionInput): Effect.Effect<Session, SessionError | WorkspaceError | ConfigError | StoreError>
  prompt(sessionId: string, input: PromptInput): Effect.Effect<Turn, SessionError | ProviderError | StoreError>
  interrupt(sessionId: string): Effect.Effect<void, SessionError>
  stop(sessionId: string): Effect.Effect<void, SessionError | StoreError>
  complete(sessionId: string): Effect.Effect<void, SessionError | StoreError>
  resume(sessionId: string): Effect.Effect<Session, SessionError | StoreError>
  list(): Effect.Effect<readonly Session[], StoreError>
  get(id: string): Effect.Effect<Session | undefined, StoreError>
}

export class SessionManager extends Context.Service<SessionManager, SessionManagerShape>()('bb/SessionManager') {}

interface Row {
  readonly id: string
  readonly project_id: string
  readonly title: string
  readonly employee_json: string
  readonly provider_id: string
  readonly profile_id: string | null
  readonly workspace_json: string
  readonly external_ref: string | null
  readonly status: SessionStatus
  readonly created_at: string
  readonly started_at: string | null
  readonly ended_at: string | null
}

interface Live {
  readonly agent: AgentSession
  readonly pump: Fiber.Fiber<void, never>
  readonly controller: AbortController
  turn: { id: string; index: number } | null
  readonly tools: Map<string, string>
}

const fromRow = (row: Row): Session => ({
  id: row.id,
  projectId: row.project_id,
  title: row.title,
  employee: JSON.parse(row.employee_json) as EmployeeSpec,
  providerId: row.provider_id,
  profileId: row.profile_id,
  workspace: row.workspace_json === '{}' ? null : (JSON.parse(row.workspace_json) as WorkspaceHandle),
  externalRef: row.external_ref === null ? null : (JSON.parse(row.external_ref) as ExternalSessionRef),
  status: row.status,
  createdAt: row.created_at,
  startedAt: row.started_at,
  endedAt: row.ended_at,
})

function employeeOf(project: Project, employeeId: string | undefined, providerOverride: string | undefined): Effect.Effect<EmployeeSpec, SessionError> {
  const id = employeeId ?? project.config.defaults?.employee ?? 'developer'
  const config = project.config.employees[id]
  if (config === undefined) {
    return Effect.fail(new SessionError({ code: 'employee_missing', reason: `employee "${id}" is not defined in bytebureau.json` }))
  }
  const promptFile = config.prompt === undefined ? null : path.resolve(project.path, config.prompt)
  const systemPrompt = config.systemPrompt ?? (promptFile === null ? '' : Effect.runSync(Effect.try(() => readFileSync(promptFile, 'utf8')).pipe(Effect.orElseSucceed(() => ''))))
  return Effect.succeed({
    id,
    name: config.name,
    provider: providerOverride ?? config.provider,
    model: config.model,
    effort: config.effort ?? null,
    systemPrompt,
    tools: config.tools ?? { allow: [], deny: [] },
    permissionMode: config.permissionMode,
    skills: config.skills ?? [],
    ...(config.maxTurns === undefined ? {} : { maxTurns: config.maxTurns }),
    askTimeout: config.askTimeout ?? '30m',
    appearance: config.appearance ?? {},
  })
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const log = yield* EventLog
  const projects = yield* ProjectRegistry
  const workspaces = yield* WorkspaceManager
  const host = yield* PluginHost
  const asks = yield* AskService
  const usage = yield* UsageService
  const logger = kernelLogger(['bb', 'core', 'sessions'])
  const live = new Map<string, Live>()
  const extraEnv = new Map<string, Readonly<Record<string, string>>>()
  const wrap = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A, StoreError> => Effect.mapError(effect, (cause) => new StoreError({ cause }))

  const load = (id: string) => wrap(Effect.map(sql<Row>`SELECT * FROM sessions WHERE id = ${id}`, (rows) => (rows[0] === undefined ? undefined : fromRow(rows[0]))))
  const require = (id: string) => Effect.flatMap(load(id), (session) => (session === undefined ? Effect.fail(new SessionError({ code: 'not_found', reason: `session ${id} does not exist` })) : Effect.succeed(session)))

  const setStatus = (session: Session, event: SessionEvent, payload: Record<string, unknown> = {}, type?: string): Effect.Effect<Session, SessionError | StoreError> =>
    Effect.gen(function* () {
      const next = transition(session.status, event)
      if (next === null) {
        return yield* new SessionError({ code: 'invalid_transition', reason: `cannot ${event} a ${session.status} session` })
      }
      const ended = next === 'completed' || next === 'stopped' || next === 'errored' ? nowIso() : null
      yield* wrap(sql`UPDATE sessions SET status = ${next}, started_at = COALESCE(started_at, ${next === 'running' ? nowIso() : null}), ended_at = ${ended} WHERE id = ${session.id}`)
      const eventType = type ?? ({ provisioning: 'session.provisioning', ready: 'session.ready', running: 'session.running', waiting_for_human: 'session.waiting', paused_usage_limit: 'session.paused', completed: 'session.completed', stopped: 'session.stopped', errored: 'session.errored', created: 'session.created' } as const)[next]
      yield* log.publish({ type: eventType as never, sessionId: session.id, projectId: session.projectId, payload: { status: next, ...payload } as never })
      return { ...session, status: next, endedAt: ended }
    })

  const finishTurn = (session: Session, state: Live, status: 'completed' | 'interrupted' | 'errored', stopReason: string | null, turnUsage: Usage | null): Effect.Effect<void, StoreError> =>
    Effect.gen(function* () {
      const turn = state.turn
      if (turn === null) {
        return
      }
      state.turn = null
      yield* wrap(sql`UPDATE turns SET status = ${status}, stop_reason = ${stopReason}, usage_json = ${turnUsage === null ? null : JSON.stringify(turnUsage)}, ended_at = ${nowIso()} WHERE id = ${turn.id}`)
      const payload = { turnId: turn.id, index: turn.index, status }
      yield* log.publish(status === 'completed' ? { type: 'turn.completed', sessionId: session.id, turnId: turn.id, payload: { ...payload, stopReason: stopReason ?? 'end_turn', usage: turnUsage ?? { inputTokens: 0, outputTokens: 0 } } } : { type: 'turn.interrupted', sessionId: session.id, turnId: turn.id, payload })
    })

  // One provider event → bookkeeping + kernel events; asks block until answered (the provider waits too)
  const handle = (sessionId: string, state: Live, event: AgentEvent): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      const session = yield* require(sessionId)
      const turn = state.turn ?? { id: '', index: -1 }
      switch (event.type) {
        case 'tool.started': {
          state.tools.set(event.id, event.name)
          yield* wrap(sql`INSERT INTO tool_calls (id, session_id, turn_id, tool_name, kind, input_json, input_bytes, status, started_at) VALUES (${`${sessionId}:${event.id}`}, ${sessionId}, ${turn.id || null}, ${event.name}, ${event.kind}, ${JSON.stringify(event.input)}, ${JSON.stringify(event.input).length}, 'running', ${nowIso()})`)
          break
        }
        case 'tool.completed':
        case 'tool.failed': {
          const failed = event.type === 'tool.failed'
          yield* wrap(sql`UPDATE tool_calls SET status = ${failed ? 'failed' : 'completed'}, output_summary = ${failed ? event.error : event.outputSummary.slice(0, 32_768)}, output_bytes = ${failed ? 0 : event.bytes}, ended_at = ${nowIso()} WHERE id = ${`${sessionId}:${event.id}`}`)
          const translated = translate(event, { turnId: turn.id, index: turn.index })
          if (translated !== null) {
            yield* log.publish({ ...translated, sessionId, turnId: turn.id, payload: { ...(translated.payload as object), name: state.tools.get(event.id) ?? '' } as never })
          }
          return
        }
        case 'message.completed': {
          if (event.role === 'assistant') {
            yield* wrap(sql`INSERT INTO messages (id, session_id, turn_id, role, content_json, created_at) VALUES (${uuidv7()}, ${sessionId}, ${turn.id || null}, 'assistant', ${JSON.stringify(event.content)}, ${nowIso()})`)
          }
          break
        }
        case 'ask.requested': {
          const opened = yield* asks.open({ sessionId, turnId: turn.id || null, kind: event.ask.kind, title: event.ask.title, questions: event.ask.questions, ...(event.ask.toolCall === undefined ? {} : { toolCall: event.ask.toolCall }), permissionMode: session.employee.permissionMode, askTimeout: session.employee.askTimeout ?? '30m', workspacePath: session.workspace?.path ?? '', recommendationSource: event.ask.recommendationSource === 'agent' ? 'agent' : 'none' })
          const waiting = yield* setStatus(session, 'ask', { askId: opened.id })
          const answer = yield* asks.await(opened.id)
          yield* Effect.tryPromise({ try: () => state.agent.answer(event.ask.id, answer), catch: (cause) => new ProviderError({ kind: 'protocol', reason: String(cause), retryable: false }) })
          yield* setStatus(waiting, 'answer')
          return
        }
        case 'ratelimit.updated': {
          yield* usage.record(session.profileId, event.rateLimit)
          break
        }
        case 'turn.completed': {
          yield* finishTurn(session, state, event.stopReason === 'interrupted' ? 'interrupted' : 'completed', event.stopReason, event.usage)
          const current = yield* require(sessionId)
          if (current.status === 'running' || current.status === 'waiting_for_human') {
            yield* setStatus(current, 'turn_done')
          }
          yield* workspaces.unlock(sessionId)
          return
        }
        case 'session.error': {
          yield* finishTurn(session, state, 'errored', event.kind, null)
          yield* setStatus(session, 'crash', { kind: event.kind, message: event.message, retryable: event.retryable })
          yield* workspaces.unlock(sessionId)
          return
        }
        default: {
          break
        }
      }
      const translated = translate(event, { turnId: turn.id, index: turn.index })
      if (translated !== null) {
        yield* log.publish({ ...translated, sessionId, ...(turn.id === '' ? {} : { turnId: turn.id }) })
      }
    }).pipe(Effect.catch((cause) => Effect.sync(() => logger.error('event handling failed', { sessionId, type: event.type, cause: String(cause) }))))

  const attach = (session: Session): Effect.Effect<Live, SessionError | ProviderError> =>
    Effect.gen(function* () {
      const existing = live.get(session.id)
      if (existing !== undefined) {
        return existing
      }
      const provider = host.agentProvider(session.providerId)
      if (provider === undefined) {
        return yield* new SessionError({ code: 'provider_missing', reason: `provider "${session.providerId}" is not available; available: ${host.agentProviders().map((candidate) => candidate.id).join(', ')}` })
      }
      if (session.workspace === null) {
        return yield* new SessionError({ code: 'invalid_transition', reason: 'session has no workspace' })
      }
      const controller = new AbortController()
      const env = { ...allowlistEnv(process.env), ...allowlistEnv(extraEnv.get(session.id) ?? {}), BYTEBUREAU_SESSION_ID: session.id }
      const agent = yield* Effect.tryPromise({
        try: () => provider.createSession({ sessionId: session.id, workspace: { path: session.workspace!.path }, employee: session.employee, profile: { id: session.profileId ?? 'default', providerId: session.providerId, kind: 'login' }, ...(session.externalRef === null ? {} : { resume: session.externalRef }), env, signal: controller.signal, logger: kernelLogger(['bb', 'agent', session.providerId]) }),
        catch: (cause) => new ProviderError({ kind: 'crash', reason: String(cause), retryable: true }),
      })
      const state: Live = { agent, pump: undefined as never, controller, turn: null, tools: new Map() }
      const pump = yield* Effect.forkDetach(Stream.fromAsyncIterable(agent.events(), (cause) => new ProviderError({ kind: 'protocol', reason: String(cause), retryable: false })).pipe(Stream.runForEach((event) => handle(session.id, state, event)), Effect.ignore))
      const attached: Live = { ...state, pump }
      live.set(session.id, attached)
      return attached
    })

  const create: SessionManagerShape['create'] = (input) =>
    Effect.gen(function* () {
      const project = yield* projects.get(input.projectId)
      if (project === undefined) {
        return yield* new SessionError({ code: 'not_found', reason: `project ${input.projectId} is not registered` })
      }
      const employee = yield* employeeOf(project, input.employeeId, input.providerId)
      const provider = host.agentProvider(employee.provider)
      if (provider === undefined) {
        return yield* new SessionError({ code: 'provider_missing', reason: `provider "${employee.provider}" is not available; available: ${host.agentProviders().map((candidate) => candidate.id).join(', ')}` })
      }
      const runtimeId = project.config.workspace?.runtime ?? 'local'
      const runtime = host.workspaceRuntimes().find((candidate) => candidate.id === runtimeId)
      if (employee.permissionMode === 'yolo' && runtime?.isolation === 'none') {
        return yield* new SessionError({ code: 'yolo_refused', reason: `permission mode "yolo" is refused on the "${runtimeId}" runtime (isolation: none); container runtimes enable it later` })
      }
      const id = uuidv7()
      const createdAt = nowIso()
      const employeeJson = JSON.stringify(employee)
      if (input.env !== undefined) {
        extraEnv.set(id, input.env)
      }
      yield* wrap(sql`INSERT INTO sessions (id, project_id, title, employee_json, provider_id, profile_id, workspace_json, status, created_at) VALUES (${id}, ${project.id}, ${input.title}, ${employeeJson}, ${employee.provider}, ${input.profileId ?? null}, '{}', 'created', ${createdAt})`)
      const created: Session = { id, projectId: project.id, title: input.title, employee, providerId: employee.provider, profileId: input.profileId ?? null, workspace: null, externalRef: null, status: 'created', createdAt, startedAt: null, endedAt: null }
      yield* log.publish({ type: 'session.created', sessionId: id, projectId: project.id, payload: { status: 'created', title: input.title, employeeId: employee.id, providerId: employee.provider } })
      const provisioning = yield* setStatus(created, 'provision')
      const workspace = yield* workspaces.provision({ sessionId: id, project, title: input.title, baseBranch: input.branch ?? project.config.defaults?.branch ?? project.defaultBranch, runtimeId })
      const ready = yield* setStatus({ ...provisioning, workspace }, 'provisioned')
      return ready
    })

  const prompt: SessionManagerShape['prompt'] = (sessionId, input) =>
    Effect.gen(function* () {
      const session = yield* require(sessionId)
      const state = yield* attach(session)
      const running = yield* setStatus(session, 'prompt')
      const count = yield* wrap(Effect.map(sql<{ readonly n: number }>`SELECT count(*) AS n FROM turns WHERE session_id = ${sessionId}`, (rows) => rows[0]?.n ?? 0))
      const turn: Turn = { id: uuidv7(), sessionId, index: count, prompt: input, status: 'running', stopReason: null, usage: null, startedAt: nowIso(), endedAt: null }
      yield* wrap(sql`INSERT INTO turns (id, session_id, idx, prompt_json, status, started_at) VALUES (${turn.id}, ${sessionId}, ${turn.index}, ${JSON.stringify(input)}, 'running', ${turn.startedAt})`)
      yield* wrap(sql`INSERT INTO messages (id, session_id, turn_id, role, content_json, created_at) VALUES (${uuidv7()}, ${sessionId}, ${turn.id}, 'user', ${JSON.stringify([{ type: 'text', text: input.text }])}, ${turn.startedAt})`)
      state.turn = { id: turn.id, index: turn.index }
      yield* workspaces.lock(sessionId)
      yield* log.publish({ type: 'message.user', sessionId, turnId: turn.id, payload: { text: input.text } })
      const sent = yield* host.hooks.run('prompt.beforeSend', { sessionId, input }, (value) => Effect.succeed(value))
      yield* Effect.forkDetach(Effect.tryPromise(() => state.agent.prompt(sent.input)).pipe(Effect.ignore))
      return { ...turn, status: running.status === 'running' ? 'running' : turn.status }
    })

  const stop: SessionManagerShape['stop'] = (sessionId) =>
    Effect.gen(function* () {
      const session = yield* require(sessionId)
      const state = live.get(sessionId)
      if (state !== undefined) {
        yield* Effect.tryPromise(() => state.agent.interrupt()).pipe(Effect.ignore)
        yield* finishTurn(session, state, 'interrupted', 'stopped', null)
        yield* Effect.tryPromise(() => state.agent.close()).pipe(Effect.ignore)
        state.controller.abort()
        live.delete(sessionId)
      }
      for (const pending of yield* asks.pending(sessionId)) {
        yield* asks.cancel(pending.id)
      }
      yield* workspaces.unlock(sessionId)
      yield* setStatus(yield* require(sessionId), 'stop')
    })

  return SessionManager.of({
    create,
    prompt,
    interrupt: (sessionId) => {
      const state = live.get(sessionId)
      return state === undefined ? Effect.fail(new SessionError({ code: 'not_found', reason: `session ${sessionId} is not running` })) : Effect.tryPromise(() => state.agent.interrupt()).pipe(Effect.ignore)
    },
    stop,
    complete: (sessionId) =>
      Effect.gen(function* () {
        const session = yield* require(sessionId)
        const state = live.get(sessionId)
        if (state !== undefined) {
          yield* Effect.tryPromise(() => state.agent.close()).pipe(Effect.ignore)
          live.delete(sessionId)
        }
        yield* workspaces.unlock(sessionId)
        yield* setStatus(session, 'complete')
      }),
    resume: (sessionId) => Effect.flatMap(require(sessionId), (session) => setStatus(session, 'resume', {}, 'session.resumed')),
    list: () => wrap(Effect.map(sql<Row>`SELECT * FROM sessions ORDER BY created_at DESC`, (rows) => rows.map(fromRow))),
    get: load,
  })
})

export const SessionManagerLive: Layer.Layer<SessionManager, never, SqlClient.SqlClient | EventLog | ProjectRegistry | WorkspaceManager | PluginHost | AskService | UsageService> = Layer.effect(SessionManager, make)
```
Implementation notes for the executor: (1) the `ask.requested` branch blocks the pump fiber until the answer arrives — the provider is waiting as well, so nothing is lost; (2) `setStatus` publishes the catalogue event matching the new status; the `as never` casts isolate the generic `KernelEvent` typing — replace them with a typed helper if `KernelEvent<T>` narrows cleanly; (3) `extraEnv` holds per-session `BYTEBUREAU_*` variables given at `create` (the allowlist filters them) for the lifetime of the process; (4) the running turn must be marked `interrupted` and `session.stopped` published in that order (the test asserts it); (5) `Effect.forkDetach` keeps the pump alive beyond the caller's scope; it ends when the provider's event iterator ends (`close()`), and `stop`/`complete` call `close()`.

Add to `index.ts`: `export { SessionManager, SessionManagerLive, type SessionManagerShape } from './sessions/session-manager.js'`, `export { transition, SESSION_EVENTS, type SessionEvent } from './sessions/state-machine.js'`, `export type { Session, Turn, CreateSessionInput } from './sessions/types.js'`, `export { UsageService, UsageServiceLive, type SessionUsage, type UsageSnapshot } from './usage/usage-service.js'`, `export { FakeAgentProvider } from './testing/fake-agent-provider.js'`, `export { fakeAgentPlugin } from './testing/fake-agent-plugin.js'`.

- [ ] **Step 6: Run, commit**

Run: `bunx vitest run --project kernel` → PASS for the state machine and usage tests; the session-manager test passes once Task 14's `KernelTest` exists (run it again there). `bun run check` → green (`fast-check` is already a root devDependency; add it to `packages/kernel` devDependencies as well so knip sees the import).

```bash
git add packages/kernel
git commit -m "feat(kernel): run sessions through providers with turns, asks, usage and a fake agent"
```

### Task 14: Kernel layers and the Promise facade (`KernelLive`, `KernelTest`, `createKernel`)

**Files:**
- Create: `packages/kernel/src/kernel-live.ts`, `packages/kernel/src/facade.ts`, `packages/kernel/src/facade.test.ts`
- Modify: `packages/kernel/src/index.ts`, `packages/kernel/src/bun.ts`

**Interfaces:**
- Consumes: every `*Live` layer from Tasks 3–13; `ManagedRuntime.make(layer)` → `runPromise`, `dispose` (verified).
- Produces: `KernelLayer(options: KernelLayerOptions): Layer<KernelServices, never, SqlClient>` (everything but the store), `KernelTest(options): Layer<KernelServices | SqlClient>` (over `StoreTest`), `createKernelFrom(layer, options): Promise<Kernel>` (facade over any store layer), `createKernel(options: KernelOptions): Promise<Kernel>` in `bun.ts` (over `StoreLive` at `<home>/data/bytebureau.db`), the `Kernel` interface exactly as Task 15 lists it, `KernelLayerOptions { home: string; extraPlugins?: readonly Plugin[]; pluginConfig?: Record<string, unknown> }`, `KernelOptions = KernelLayerOptions & { env: Record<string, string | undefined>; logging?: { debug?: string; level?: string } }`.

- [ ] **Step 1: Failing facade test**

`packages/kernel/src/facade.test.ts`:
```ts
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createKernelFrom } from './facade.js'
import { KernelTest } from './kernel-live.js'
import { createTempRepo } from './testing/temp-repo.js'

describe(createKernelFrom, () => {
  it('drives a whole fake-provider run through Promises and AsyncIterables only', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'bb-home-'))
    const kernel = await createKernelFrom(KernelTest({ home }), { home, env: {} })
    try {
      const project = await kernel.projects.register(createTempRepo())
      const session = await kernel.sessions.create({ projectId: project.id, title: 'facade run', providerId: 'fake' })
      const events = kernel.events.subscribe({ sessionId: session.id, since: 0 })
      await kernel.sessions.prompt(session.id, { text: 'go' })
      const seen: string[] = []
      for await (const event of events) {
        seen.push(event.type)
        if (event.type === 'ask.requested') {
          const [ask] = await kernel.asks.pending(session.id)
          await kernel.asks.answer(ask!.id, { selected: ['yes'] }, 'cli')
        }
        if (event.type === 'turn.completed') {
          await kernel.sessions.complete(session.id)
        }
        if (event.type === 'session.completed') {
          break
        }
      }
      expect(seen).toContain('ask.answered')
      expect((await kernel.usage.session(session.id)).turns).toBe(1)
      expect(existsSync(path.join(session.workspace!.path, 'src', 'hello.ts'))).toBe(true)
      expect(kernel.providers.list().map((provider) => provider.id)).toContain('fake')
    } finally {
      await kernel.close()
    }
  })
})
```

- [ ] **Step 2: Layers and facade**

`packages/kernel/src/kernel-live.ts`:
```ts
import type { Plugin } from '@bytebureau/plugin-api'
import { Layer } from 'effect'
import type { SqlClient } from 'effect/sql'
import { AskService, AskServiceLive } from './asks/ask-service.js'
import { Config, ConfigLive } from './config/config.js'
import { EventLog, EventLogLive } from './events/event-log.js'
import { EffectLoggerLive } from './logging/logging.js'
import { PluginHost, PluginHostLive } from './plugins/plugin-host.js'
import { Supervisor, SupervisorLive } from './process/supervisor.js'
import { ProjectRegistry, ProjectRegistryLive } from './projects/project-registry.js'
import { SessionManager, SessionManagerLive } from './sessions/session-manager.js'
import { StoreTest } from './store/store-test.js'
import { UsageService, UsageServiceLive } from './usage/usage-service.js'
import { WorkspaceRuntimes } from './workspace/runtimes.js'
import { WorkspaceManager, WorkspaceManagerLive } from './workspace/workspace-manager.js'

export interface KernelLayerOptions {
  readonly home: string
  readonly extraPlugins?: readonly Plugin[] | undefined
  readonly pluginConfig?: Readonly<Record<string, unknown>> | undefined
}

export type KernelServices = Config | EventLog | ProjectRegistry | Supervisor | PluginHost | WorkspaceRuntimes | WorkspaceManager | AskService | UsageService | SessionManager

// Everything except the store; the caller provides SqlClient (StoreLive in the binary, StoreTest in tests)
export const KernelLayer = (options: KernelLayerOptions): Layer.Layer<KernelServices, never, SqlClient.SqlClient> => {
  const base = Layer.mergeAll(ConfigLive(options.home), EventLogLive, SupervisorLive, UsageServiceLive, EffectLoggerLive)
  const plugins = PluginHostLive({ extraPlugins: options.extraPlugins, pluginConfig: options.pluginConfig }).pipe(Layer.provideMerge(base))
  const registry = Layer.mergeAll(ProjectRegistryLive, WorkspaceManagerLive, AskServiceLive).pipe(Layer.provideMerge(plugins))
  return SessionManagerLive.pipe(Layer.provideMerge(registry))
}

export const KernelTest = (options: KernelLayerOptions): Layer.Layer<KernelServices | SqlClient.SqlClient> => KernelLayer(options).pipe(Layer.provideMerge(StoreTest))
```
`packages/kernel/src/facade.ts`:
```ts
import type { AgentProvider, Plugin } from '@bytebureau/plugin-api'
import type { Ask, AskAnswer, AnsweredVia, EventEnvelope, PromptInput } from '@bytebureau/protocol'
import { Effect, Layer, ManagedRuntime, Stream } from 'effect'
import type { SqlClient } from 'effect/sql'
import { AskService } from './asks/ask-service.js'
import { Config, type ConfigIssue, type ResolvedConfig } from './config/config.js'
import { EventLog, type EventFilter } from './events/event-log.js'
import type { KernelLayerOptions, KernelServices } from './kernel-live.js'
import { configureLogging, type KernelLogLevel } from './logging/logging.js'
import { PluginHost } from './plugins/plugin-host.js'
import { ProjectRegistry, type Project } from './projects/project-registry.js'
import { SessionManager } from './sessions/session-manager.js'
import type { CreateSessionInput, Session, Turn } from './sessions/types.js'
import { UsageService, type SessionUsage } from './usage/usage-service.js'
import { WorkspaceManager, type PruneReport, type WorkspaceInfo } from './workspace/workspace-manager.js'

export interface KernelOptions extends KernelLayerOptions {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly logging?: { readonly debug?: string | undefined; readonly level?: string | undefined; readonly json?: boolean | undefined } | undefined
}

export interface Kernel {
  readonly projects: { register(path: string): Promise<Project>; list(): Promise<readonly Project[]>; get(id: string): Promise<Project | undefined>; remove(id: string): Promise<void> }
  readonly config: { load(projectPath?: string): Promise<ResolvedConfig>; validate(projectPath: string): Promise<readonly ConfigIssue[]>; schema(): Record<string, unknown> }
  readonly sessions: { create(input: CreateSessionInput): Promise<Session>; prompt(sessionId: string, input: PromptInput): Promise<Turn>; interrupt(sessionId: string): Promise<void>; stop(sessionId: string): Promise<void>; complete(sessionId: string): Promise<void>; resume(sessionId: string): Promise<Session>; list(): Promise<readonly Session[]>; get(id: string): Promise<Session | undefined> }
  readonly asks: { pending(sessionId?: string): Promise<readonly Ask[]>; answer(askId: string, answer: AskAnswer, via: AnsweredVia): Promise<void> }
  readonly events: { subscribe(filter: EventFilter): AsyncIterable<EventEnvelope>; read(filter: EventFilter, range: { readonly from: number; readonly to?: number }): Promise<readonly EventEnvelope[]> }
  readonly workspaces: { list(projectId?: string): Promise<readonly WorkspaceInfo[]>; prune(projectId?: string): Promise<PruneReport> }
  readonly usage: { session(sessionId: string): Promise<SessionUsage> }
  readonly providers: { list(): readonly { readonly id: string; readonly displayName: string }[] }
  close(): Promise<void>
}

const levelOf = (value: string | undefined): KernelLogLevel => (value === 'trace' || value === 'debug' || value === 'info' || value === 'warn' || value === 'error' ? value : 'info')

export async function createKernelFrom(layer: Layer.Layer<KernelServices | SqlClient.SqlClient>, options: KernelOptions): Promise<Kernel> {
  await configureLogging({ level: levelOf(options.logging?.level), json: options.logging?.json ?? !process.stdout.isTTY, debug: options.logging?.debug })
  const runtime = ManagedRuntime.make(layer)
  const run = <A, E>(effect: Effect.Effect<A, E, KernelServices | SqlClient.SqlClient>): Promise<A> => runtime.runPromise(effect)
  // The services, captured once, let event streams run outside runPromise (AsyncIterable consumers)
  const services = await run(Effect.context<KernelServices | SqlClient.SqlClient>())
  await run(Effect.flatMap(PluginHost, (host) => host.load()))
  const summary = (provider: AgentProvider) => ({ id: provider.id, displayName: provider.displayName })
  return {
    projects: {
      register: (path) => run(Effect.flatMap(ProjectRegistry, (registry) => registry.register(path))),
      list: () => run(Effect.flatMap(ProjectRegistry, (registry) => registry.list())),
      get: (id) => run(Effect.flatMap(ProjectRegistry, (registry) => registry.get(id))),
      remove: (id) => run(Effect.flatMap(ProjectRegistry, (registry) => registry.remove(id))),
    },
    config: {
      load: (projectPath) => run(Effect.flatMap(Config, (config) => config.load({ projectPath, env: options.env }))),
      validate: (projectPath) => run(Effect.flatMap(Config, (config) => config.validate(projectPath))),
      schema: () => runtime.runSync(Effect.map(Config, (config) => config.schema())),
    },
    sessions: {
      create: (input) => run(Effect.flatMap(SessionManager, (sessions) => sessions.create(input))),
      prompt: (sessionId, input) => run(Effect.flatMap(SessionManager, (sessions) => sessions.prompt(sessionId, input))),
      interrupt: (sessionId) => run(Effect.flatMap(SessionManager, (sessions) => sessions.interrupt(sessionId))),
      stop: (sessionId) => run(Effect.flatMap(SessionManager, (sessions) => sessions.stop(sessionId))),
      complete: (sessionId) => run(Effect.flatMap(SessionManager, (sessions) => sessions.complete(sessionId))),
      resume: (sessionId) => run(Effect.flatMap(SessionManager, (sessions) => sessions.resume(sessionId))),
      list: () => run(Effect.flatMap(SessionManager, (sessions) => sessions.list())),
      get: (id) => run(Effect.flatMap(SessionManager, (sessions) => sessions.get(id))),
    },
    asks: {
      pending: (sessionId) => run(Effect.flatMap(AskService, (asks) => asks.pending(sessionId))),
      answer: (askId, answer, via) => run(Effect.flatMap(AskService, (asks) => Effect.asVoid(asks.answer(askId, answer, via)))),
    },
    events: {
      subscribe: (filter) => Stream.toAsyncIterable(Stream.unwrap(Effect.map(EventLog, (log) => log.subscribe(filter))).pipe(Stream.provideContext(services))),
      read: (filter, range) => run(Effect.flatMap(EventLog, (log) => log.read(filter, range))),
    },
    workspaces: {
      list: (projectId) => run(Effect.flatMap(WorkspaceManager, (workspaces) => workspaces.list(projectId))),
      prune: (projectId) => run(Effect.flatMap(WorkspaceManager, (workspaces) => workspaces.prune(projectId))),
    },
    usage: { session: (sessionId) => run(Effect.flatMap(UsageService, (usage) => usage.sessionUsage(sessionId))) },
    providers: { list: () => runtime.runSync(Effect.map(PluginHost, (host) => host.agentProviders().map(summary))) },
    close: () => runtime.dispose(),
  }
}
```
`Effect.context<R>()` and `Stream.provideContext` are the Effect 3 names; if the installed `effect@4.0.0` d.ts names them `Effect.services` / `Stream.provideServices` (the v4 rename of `Context` values to services), use those — the shape (capture once, provide to the stream) stays the same. `Stream.toAsyncIterable` is verified.

`packages/kernel/src/bun.ts`:
```ts
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { Layer } from 'effect'
import { createKernelFrom, type Kernel, type KernelOptions } from './facade.js'
import { KernelLayer } from './kernel-live.js'
import { StoreLive } from './store/store-live.js'

export { StoreLive }
export type { Kernel, KernelOptions }

export function createKernel(options: KernelOptions): Promise<Kernel> {
  const dataDir = path.join(options.home, 'data')
  mkdirSync(dataDir, { recursive: true })
  return createKernelFrom(KernelLayer(options).pipe(Layer.provideMerge(StoreLive(path.join(dataDir, 'bytebureau.db')))), options)
}
```
Add to `index.ts`: `export { KernelLayer, KernelTest, type KernelLayerOptions, type KernelServices } from './kernel-live.js'`, `export { createKernelFrom, type Kernel, type KernelOptions } from './facade.js'`. Task 15's CLI imports `createKernel` and `Kernel` from `@bytebureau/kernel/bun` (not from the package root, which stays Node-safe).

- [ ] **Step 3: Run everything, commit**

Run: `bunx vitest run --project kernel` → PASS including the Task 13 session-manager test. `bun run check` → green.

```bash
git add packages/kernel
git commit -m "feat(kernel): compose the kernel layers and expose a promise facade for the cli"
```

### Task 15: CLI — `run --no-daemon`, `config`, `projects`, `workspaces`

**Files:**
- Create: `apps/bytebureau/src/kernel.ts`, `apps/bytebureau/src/commands/run.ts`, `apps/bytebureau/src/commands/config.ts`, `apps/bytebureau/src/commands/projects.ts`, `apps/bytebureau/src/commands/workspaces.ts`, `apps/bytebureau/src/render/transcript.ts`, `apps/bytebureau/src/render/ask-prompt.ts`, `apps/bytebureau/src/render/transcript.test.ts`, `apps/bytebureau/src/commands/run.test.ts`
- Modify: `apps/bytebureau/src/main.ts` (register the commands), `apps/bytebureau/package.json` (dependencies `@bytebureau/kernel`, `@bytebureau/protocol`), `apps/bytebureau/src/context.ts` (new global flags), `packages/i18n/messages/{en,cs}.json` (new strings), `vitest.config.ts` (coverage include for `apps/bytebureau/src/render/**`)

**Interfaces:**
- Consumes (Task 14): `createKernel(options: KernelOptions): Promise<Kernel>` and the `Kernel` facade:
  ```ts
  interface KernelOptions { readonly home: string; readonly env: Readonly<Record<string, string | undefined>>; readonly logger?: Logger; readonly extraPlugins?: readonly Plugin[] }
  interface Kernel {
    readonly projects: { register(path: string): Promise<Project>; list(): Promise<readonly Project[]>; get(id: string): Promise<Project | undefined>; remove(id: string): Promise<void> }
    readonly config: { load(projectPath?: string): Promise<ResolvedConfig>; validate(projectPath: string): Promise<readonly ConfigIssue[]>; schema(): Record<string, unknown> }
    readonly sessions: { create(input: CreateSessionInput): Promise<Session>; prompt(sessionId: string, input: PromptInput): Promise<Turn>; interrupt(sessionId: string): Promise<void>; stop(sessionId: string): Promise<void>; complete(sessionId: string): Promise<void>; resume(sessionId: string): Promise<Session>; list(): Promise<readonly Session[]>; get(id: string): Promise<Session | undefined> }
    readonly asks: { pending(sessionId?: string): Promise<readonly Ask[]>; answer(askId: string, answer: AskAnswer, via: AnsweredVia): Promise<void> }
    readonly events: { subscribe(filter: EventFilter): AsyncIterable<EventEnvelope>; read(filter: EventFilter, range: { readonly from: number; readonly to?: number }): Promise<readonly EventEnvelope[]> }
    readonly workspaces: { list(projectId?: string): Promise<readonly WorkspaceInfo[]>; prune(projectId?: string): Promise<PruneReport> }
    readonly usage: { session(sessionId: string): Promise<SessionUsage> }
    readonly providers: { list(): readonly { id: string; displayName: string }[] }
    close(): Promise<void>
  }
  type CreateSessionInput = { readonly projectId: string; readonly title: string; readonly employeeId?: string; readonly providerId?: string; readonly profileId?: string; readonly branch?: string }
  type EventFilter = { readonly sessionId?: string; readonly projectId?: string; readonly types?: readonly string[]; readonly since?: number; readonly ephemeral?: boolean }
  type AnsweredVia = 'cli' | 'api' | 'timeout' | 'policy'
  type PruneReport = { readonly removed: readonly string[]; readonly retained: readonly { path: string; reason: string }[] }
  ```
  plus the protocol types `EventEnvelope`, `Ask`, `AskAnswer`, `Session`, `Turn`, `Project`, `WorkspaceInfo`, `SessionUsage`, `ResolvedConfig`, `ConfigIssue`.
- Produces: the commands wired into `main.ts`; `renderTranscript(events, output)`; `promptAsk(ask, { yes, interactive })`.

- [ ] **Step 1: Global flags and i18n strings**

`apps/bytebureau/src/context.ts` — extend `globalArgs` with:
```ts
  yes: { type: 'boolean', description: 'Answer every ask with the recommended option', default: false },
  debug: { type: 'string', description: 'Debug logging; optionally a category list (bb.agent,!bb.store)' },
  logLevel: { type: 'string', description: 'Log level: debug, info, warn or error' },
```
and `GlobalArgs` with `readonly yes: boolean; readonly debug?: string | undefined; readonly logLevel?: string | undefined`. `createContext` passes `debug`/`logLevel` through unchanged in a new `logging: { debug, level }` field of `Context`.

`packages/i18n/messages/en.json` gains (and `cs.json` the Czech equivalents, vykání, office metaphor):
```json
  "run_intro": "ByteBureau session {title}",
  "run_provisioning": "Preparing the workspace on branch {branch}",
  "run_turn_started": "The employee is working…",
  "run_tool": "{name}",
  "run_ask_header": "The employee asks",
  "run_ask_recommended": "(Recommended)",
  "run_ask_other": "Other…",
  "run_ask_other_prompt": "Your answer",
  "run_completed": "Done in {turns} turn(s), {input} input and {output} output tokens{cost}",
  "run_stopped": "Session stopped",
  "run_errored": "The provider failed: {message}",
  "run_provider_missing": "Provider \"{provider}\" is not available. Available: {available}",
  "config_init_written": "Wrote {file}",
  "config_init_exists": "{file} already exists",
  "config_valid": "Configuration is valid",
  "config_invalid": "{count} problem(s) found",
  "projects_none": "No projects registered",
  "projects_added": "Registered {name} ({path})",
  "projects_removed": "Removed {id}",
  "workspaces_none": "No workspaces",
  "workspaces_pruned": "Removed {removed} worktree(s), kept {retained}"
```
Czech (`cs.json`): `"run_intro": "Relace ByteBureau {title}"`, `"run_provisioning": "Připravuji pracovní prostor na větvi {branch}"`, `"run_turn_started": "Zaměstnanec pracuje…"`, `"run_tool": "{name}"`, `"run_ask_header": "Zaměstnanec se ptá"`, `"run_ask_recommended": "(doporučeno)"`, `"run_ask_other": "Jiná odpověď…"`, `"run_ask_other_prompt": "Vaše odpověď"`, `"run_completed": "Hotovo za {turns} kol, {input} vstupních a {output} výstupních tokenů{cost}"`, `"run_stopped": "Relace zastavena"`, `"run_errored": "Poskytovatel selhal: {message}"`, `"run_provider_missing": "Poskytovatel „{provider}“ není k dispozici. Dostupní: {available}"`, `"config_init_written": "Zapsán soubor {file}"`, `"config_init_exists": "Soubor {file} už existuje"`, `"config_valid": "Konfigurace je platná"`, `"config_invalid": "Nalezeno problémů: {count}"`, `"projects_none": "Žádné registrované projekty"`, `"projects_added": "Zaregistrován projekt {name} ({path})"`, `"projects_removed": "Odebrán projekt {id}"`, `"workspaces_none": "Žádné pracovní prostory"`, `"workspaces_pruned": "Odstraněno pracovních prostorů: {removed}, ponecháno: {retained}"`.
The parity test from SP0 keeps both catalogues aligned.

- [ ] **Step 2: Kernel bootstrap for the CLI**

`apps/bytebureau/src/kernel.ts`:
```ts
import { homedir } from 'node:os'
import path from 'node:path'
import { createKernel, type Kernel } from '@bytebureau/kernel/bun'
import type { Context } from './context.js'

export function kernelHome(env: Readonly<Record<string, string | undefined>>): string {
  return env['BYTEBUREAU_HOME'] ?? path.join(homedir(), '.bytebureau')
}

// One in-process kernel per command invocation (--no-daemon mode); Phase B adds the daemon client
export async function withKernel<T>(
  context: Context,
  env: Readonly<Record<string, string | undefined>>,
  work: (kernel: Kernel) => Promise<T>,
): Promise<T> {
  const kernel = await createKernel({ home: kernelHome(env), env, logging: context.logging })
  try {
    return await work(kernel)
  } finally {
    await kernel.close()
  }
}
```

- [ ] **Step 3: Failing tests for the transcript renderer**

`apps/bytebureau/src/render/transcript.test.ts`:
```ts
import type { EventEnvelope } from '@bytebureau/protocol'
import { describe, expect, it } from 'vitest'
import { createOutput } from '../output.js'
import { summarizeRun, transcriptLine } from './transcript.js'

function event(type: string, payload: Record<string, unknown>, seq = 1): EventEnvelope {
  return {
    seq,
    id: '0192f0c8-7b2e-7c3d-9a4b-000000000010',
    ts: '2026-10-02T12:00:00.000Z',
    type,
    sessionId: 's1',
    payload,
  } as EventEnvelope
}

describe(transcriptLine, () => {
  it('renders assistant text, tool starts and ask requests; ignores deltas', () => {
    const output = createOutput({ json: false, color: false })
    expect(transcriptLine(event('message.assistant.completed', { text: 'Hello' }), output)).toBe('Hello')
    expect(transcriptLine(event('tool.started', { name: 'Write', input: { path: 'src/hello.ts' } }), output)).toBe(
      '⚙ Write src/hello.ts',
    )
    expect(transcriptLine(event('message.assistant.delta', { text: 'H' }), output)).toBeUndefined()
  })
})

describe(summarizeRun, () => {
  it('counts turns and tokens from turn.completed events', () => {
    const events = [
      event('turn.completed', { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 } }, 1),
      event('turn.completed', { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }, 2),
    ]
    expect(summarizeRun(events)).toEqual({ turns: 2, inputTokens: 11, outputTokens: 6, costUsd: 0.01 })
  })
})
```
Run: `bunx vitest run --project bytebureau` → FAIL.

- [ ] **Step 4: Renderers**

`apps/bytebureau/src/render/transcript.ts`:
```ts
import { m } from '@bytebureau/i18n'
import type { EventEnvelope } from '@bytebureau/protocol'
import type { Output } from '../output.js'

export interface RunSummary {
  readonly turns: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd?: number | undefined
}

function toolTarget(input: unknown): string {
  if (typeof input === 'object' && input !== null) {
    const record = input as Record<string, unknown>
    const target = record['path'] ?? record['command'] ?? record['pattern']
    return typeof target === 'string' ? ` ${target}` : ''
  }
  return ''
}

// One printable line per durable event the user cares about; undefined means "print nothing"
export function transcriptLine(event: EventEnvelope, output: Output): string | undefined {
  const payload = event.payload as Record<string, unknown>
  switch (event.type) {
    case 'message.assistant.completed': {
      return String(payload['text'] ?? '')
    }
    case 'tool.started': {
      return output.colors.dim(`⚙ ${String(payload['name'])}${toolTarget(payload['input'])}`)
    }
    case 'tool.failed': {
      return output.colors.red(`✖ ${String(payload['name'] ?? payload['id'])}: ${String(payload['error'])}`)
    }
    case 'session.warning': {
      return output.colors.yellow(`! ${String(payload['message'])}`)
    }
    case 'workspace.provisioned': {
      return output.colors.dim(m.run_provisioning({ branch: String(payload['branch']) }))
    }
    default: {
      return undefined
    }
  }
}

export function summarizeRun(events: readonly EventEnvelope[]): RunSummary {
  let turns = 0
  let inputTokens = 0
  let outputTokens = 0
  let costUsd: number | undefined
  for (const event of events) {
    if (event.type !== 'turn.completed') {
      continue
    }
    const usage = (event.payload as { usage?: Record<string, number> }).usage ?? {}
    turns += 1
    inputTokens += usage['inputTokens'] ?? 0
    outputTokens += usage['outputTokens'] ?? 0
    if (usage['costUsd'] !== undefined) {
      costUsd = (costUsd ?? 0) + usage['costUsd']
    }
  }
  return { turns, inputTokens, outputTokens, costUsd }
}
```

`apps/bytebureau/src/render/ask-prompt.ts`:
```ts
import { isCancel, select, text } from '@clack/prompts'
import { m } from '@bytebureau/i18n'
import type { Ask, AskAnswer } from '@bytebureau/protocol'

export interface AskPromptOptions {
  readonly yes: boolean
  readonly interactive: boolean
}

function recommendedOf(ask: Ask): string[] {
  return ask.questions.map((question) => question.options.find((option) => option.recommended)?.id ?? '')
}

// Returns undefined when nobody can answer (non-interactive without --yes): the kernel policy decides
export async function promptAsk(ask: Ask, options: AskPromptOptions): Promise<AskAnswer | undefined> {
  if (options.yes) {
    return { selected: recommendedOf(ask) }
  }
  if (!options.interactive) {
    return undefined
  }
  const selected: string[] = []
  for (const question of ask.questions) {
    const recommended = question.options.find((option) => option.recommended)
    const choice = await select({
      message: `${m.run_ask_header()}: ${question.prompt}`,
      initialValue: recommended?.id ?? question.options[0]?.id ?? '',
      options: [
        ...question.options.map((option) => ({
          value: option.id,
          label: option.recommended ? `${option.label} ${m.run_ask_recommended()}` : option.label,
          hint: option.description,
        })),
        ...(question.allowOther ? [{ value: '__other__', label: m.run_ask_other() }] : []),
      ],
    })
    if (isCancel(choice)) {
      return undefined
    }
    if (choice === '__other__') {
      const other = await text({ message: m.run_ask_other_prompt() })
      return isCancel(other) ? undefined : { selected: 'other', otherText: other }
    }
    selected.push(choice)
  }
  return { selected }
}
```

- [ ] **Step 5: The `run` command**

`apps/bytebureau/src/commands/run.ts`:
```ts
import { isatty } from 'node:tty'
import { m } from '@bytebureau/i18n'
import type { Kernel } from '@bytebureau/kernel'
import type { EventEnvelope } from '@bytebureau/protocol'
import { intro, log, outro } from '@clack/prompts'
import { defineCommand } from 'citty'
import { createContext, globalArgs, type Context } from '../context.js'
import { withKernel } from '../kernel.js'
import { promptAsk } from '../render/ask-prompt.js'
import { summarizeRun, transcriptLine } from '../render/transcript.js'

export const EXIT_COMPLETED = 0
export const EXIT_STOPPED = 3
export const EXIT_PROVIDER_ERROR = 4

const TERMINAL = new Set(['session.completed', 'session.stopped', 'session.errored'])

interface RunOptions {
  readonly prompt: string
  readonly project: string
  readonly branch?: string | undefined
  readonly employee?: string | undefined
  readonly provider?: string | undefined
  readonly yes: boolean
}

function exitCodeFor(type: string): number {
  if (type === 'session.stopped') {
    return EXIT_STOPPED
  }
  return type === 'session.errored' ? EXIT_PROVIDER_ERROR : EXIT_COMPLETED
}

async function handleEvent(kernel: Kernel, event: EventEnvelope, context: Context, yes: boolean): Promise<void> {
  if (context.output.json) {
    context.output.emit(event as unknown as Record<string, unknown>)
  } else {
    const line = transcriptLine(event, context.output)
    if (line !== undefined) {
      log.message(line)
    }
  }
  if (event.type === 'ask.requested') {
    const answer = await promptAsk((event.payload as { ask: Parameters<typeof promptAsk>[0] }).ask, {
      yes,
      interactive: context.interactive,
    })
    if (answer !== undefined) {
      await kernel.asks.answer((event.payload as { ask: { id: string } }).ask.id, answer, 'cli')
    }
  }
}

// Streams one session to completion; resolves with the exit code
export async function runSession(kernel: Kernel, options: RunOptions, context: Context): Promise<number> {
  const project = await kernel.projects.register(options.project)
  const available = kernel.providers.list().map((provider) => provider.id)
  if (options.provider !== undefined && !available.includes(options.provider)) {
    context.output.warn(m.run_provider_missing({ provider: options.provider, available: available.join(', ') }))
    return EXIT_PROVIDER_ERROR
  }
  const session = await kernel.sessions.create({
    projectId: project.id,
    title: options.prompt.slice(0, 60),
    employeeId: options.employee,
    providerId: options.provider,
    branch: options.branch,
  })
  const stop = (): void => {
    void kernel.sessions.stop(session.id)
  }
  process.once('SIGINT', stop)
  const seen: EventEnvelope[] = []
  const events = kernel.events.subscribe({ sessionId: session.id, since: 0 })
  await kernel.sessions.prompt(session.id, { text: options.prompt })
  let code = EXIT_COMPLETED
  for await (const event of events) {
    seen.push(event)
    await handleEvent(kernel, event, context, options.yes)
    if (event.type === 'turn.completed') {
      await kernel.sessions.complete(session.id)
    }
    if (TERMINAL.has(event.type)) {
      code = exitCodeFor(event.type)
      break
    }
  }
  process.off('SIGINT', stop)
  const summary = summarizeRun(seen)
  if (!context.output.json) {
    outro(
      code === EXIT_COMPLETED
        ? m.run_completed({
            turns: summary.turns,
            input: summary.inputTokens,
            output: summary.outputTokens,
            cost: summary.costUsd === undefined ? '' : ` ($${summary.costUsd.toFixed(2)})`,
          })
        : code === EXIT_STOPPED
          ? m.run_stopped()
          : m.run_errored({ message: String((seen.at(-1)?.payload as { message?: string }).message ?? '') }),
    )
  }
  return code
}

export const runCommand = defineCommand({
  meta: { name: 'run', description: 'Run one prompt through an employee in an isolated worktree' },
  args: {
    ...globalArgs,
    prompt: { type: 'positional', description: 'The task for the employee', required: true },
    project: { type: 'string', description: 'Project path (default: current directory)' },
    branch: { type: 'string', description: 'Base branch (default: the project default branch)' },
    employee: { type: 'string', description: 'Employee id from bytebureau.json' },
    provider: { type: 'string', description: 'Agent provider id (fake, claude, acp:<preset>)' },
    'no-daemon': { type: 'boolean', description: 'Run the kernel in-process (the only mode in this phase)', default: true },
  },
  async run({ args }) {
    const context = createContext(args, process.env, isatty(process.stdout.fd))
    if (context.interactive) {
      intro(context.output.colors.bold(m.run_intro({ title: args.prompt.slice(0, 60) })))
    }
    const code = await withKernel(context, process.env, (kernel) =>
      runSession(
        kernel,
        {
          prompt: args.prompt,
          project: args.project ?? process.cwd(),
          branch: args.branch,
          employee: args.employee,
          provider: args.provider,
          yes: args.yes,
        },
        context,
      ),
    )
    process.exitCode = code
  },
})
```
`run.ts` (the citty runner from SP0) already maps a thrown error to exit 2; the `run` command sets `process.exitCode` for 0/3/4 so the SP0 runner's return value stays 0 — in `main.ts` the final line becomes `process.exit((await run(main, process.argv.slice(2))) || (process.exitCode ?? 0))`.

- [ ] **Step 6: `config`, `projects`, `workspaces` commands**

`apps/bytebureau/src/commands/config.ts`:
```ts
import { existsSync, writeFileSync } from 'node:fs'
import { isatty } from 'node:tty'
import path from 'node:path'
import { m } from '@bytebureau/i18n'
import { defaultProjectConfigText } from '@bytebureau/kernel'
import { defineCommand } from 'citty'
import { createContext, globalArgs } from '../context.js'
import { withKernel } from '../kernel.js'

const init = defineCommand({
  meta: { name: 'init', description: 'Write a commented bytebureau.json with the default employee' },
  args: { ...globalArgs, project: { type: 'string', description: 'Project path (default: current directory)' } },
  run({ args }) {
    const context = createContext(args, process.env, isatty(process.stdout.fd))
    const file = path.join(args.project ?? process.cwd(), 'bytebureau.jsonc')
    if (existsSync(file)) {
      context.output.warn(m.config_init_exists({ file }))
      process.exitCode = 1
      return
    }
    writeFileSync(file, defaultProjectConfigText())
    context.output.print(m.config_init_written({ file }))
    context.output.emit({ command: 'config.init', file })
  },
})

const validate = defineCommand({
  meta: { name: 'validate', description: 'Validate the layered configuration for a project' },
  args: { ...globalArgs, project: { type: 'string', description: 'Project path (default: current directory)' } },
  async run({ args }) {
    const context = createContext(args, process.env, isatty(process.stdout.fd))
    const issues = await withKernel(context, process.env, (kernel) =>
      kernel.config.validate(args.project ?? process.cwd()),
    )
    context.output.emit({ command: 'config.validate', issues })
    if (issues.length === 0) {
      context.output.print(m.config_valid())
      return
    }
    for (const issue of issues) {
      context.output.print(`${issue.file}${issue.pointer}: ${issue.message}`)
    }
    context.output.warn(m.config_invalid({ count: issues.length }))
    process.exitCode = 1
  },
})

const schema = defineCommand({
  meta: { name: 'schema', description: 'Print the JSON Schema of bytebureau.json' },
  args: { ...globalArgs },
  async run({ args }) {
    const context = createContext(args, process.env, isatty(process.stdout.fd))
    const document = await withKernel(context, process.env, (kernel) => Promise.resolve(kernel.config.schema()))
    console.log(JSON.stringify(document, null, 2))
  },
})

export const configCommand = defineCommand({
  meta: { name: 'config', description: 'Create, validate and describe the configuration' },
  subCommands: { init, validate, schema },
})
```

`apps/bytebureau/src/commands/projects.ts`:
```ts
import { isatty } from 'node:tty'
import { m } from '@bytebureau/i18n'
import { defineCommand } from 'citty'
import { createContext, globalArgs } from '../context.js'
import { withKernel } from '../kernel.js'

const ls = defineCommand({
  meta: { name: 'ls', description: 'List registered projects' },
  args: { ...globalArgs },
  async run({ args }) {
    const context = createContext(args, process.env, isatty(process.stdout.fd))
    const projects = await withKernel(context, process.env, (kernel) => kernel.projects.list())
    context.output.emit({ command: 'projects.ls', projects })
    if (projects.length === 0) {
      context.output.print(m.projects_none())
      return
    }
    for (const project of projects) {
      context.output.print(`${project.id}  ${project.name}  ${project.path}  (${project.defaultBranch})`)
    }
  },
})

const add = defineCommand({
  meta: { name: 'add', description: 'Register a project (default: current directory)' },
  args: { ...globalArgs, path: { type: 'positional', description: 'Project path', required: false } },
  async run({ args }) {
    const context = createContext(args, process.env, isatty(process.stdout.fd))
    const project = await withKernel(context, process.env, (kernel) => kernel.projects.register(args.path ?? process.cwd()))
    context.output.emit({ command: 'projects.add', project })
    context.output.print(m.projects_added({ name: project.name, path: project.path }))
  },
})

const rm = defineCommand({
  meta: { name: 'rm', description: 'Unregister a project (its worktrees are kept)' },
  args: { ...globalArgs, id: { type: 'positional', description: 'Project id', required: true } },
  async run({ args }) {
    const context = createContext(args, process.env, isatty(process.stdout.fd))
    await withKernel(context, process.env, (kernel) => kernel.projects.remove(args.id))
    context.output.emit({ command: 'projects.rm', id: args.id })
    context.output.print(m.projects_removed({ id: args.id }))
  },
})

export const projectsCommand = defineCommand({
  meta: { name: 'projects', description: 'Manage registered projects' },
  subCommands: { ls, add, rm },
})
```

`apps/bytebureau/src/commands/workspaces.ts`:
```ts
import { isatty } from 'node:tty'
import { m } from '@bytebureau/i18n'
import { defineCommand } from 'citty'
import { createContext, globalArgs } from '../context.js'
import { withKernel } from '../kernel.js'

const ls = defineCommand({
  meta: { name: 'ls', description: 'List session worktrees' },
  args: { ...globalArgs, project: { type: 'string', description: 'Project id' } },
  async run({ args }) {
    const context = createContext(args, process.env, isatty(process.stdout.fd))
    const workspaces = await withKernel(context, process.env, (kernel) => kernel.workspaces.list(args.project))
    context.output.emit({ command: 'workspaces.ls', workspaces })
    if (workspaces.length === 0) {
      context.output.print(m.workspaces_none())
      return
    }
    for (const workspace of workspaces) {
      context.output.print(`${workspace.sessionId}  ${workspace.branch}  ${workspace.status}  ${workspace.path}`)
    }
  },
})

const prune = defineCommand({
  meta: { name: 'prune', description: 'Remove worktrees of finished sessions that are merged or pushed and older than the retain period' },
  args: { ...globalArgs, project: { type: 'string', description: 'Project id' } },
  async run({ args }) {
    const context = createContext(args, process.env, isatty(process.stdout.fd))
    const report = await withKernel(context, process.env, (kernel) => kernel.workspaces.prune(args.project))
    context.output.emit({ command: 'workspaces.prune', ...report })
    for (const kept of report.retained) {
      context.output.print(`${kept.path}: ${kept.reason}`)
    }
    context.output.print(m.workspaces_pruned({ removed: report.removed.length, retained: report.retained.length }))
  },
})

export const workspacesCommand = defineCommand({
  meta: { name: 'workspaces', description: 'Inspect and prune session worktrees' },
  subCommands: { ls, prune },
})
```

`apps/bytebureau/src/main.ts`: import the four commands and register `subCommands: { hello: helloCommand, run: runCommand, config: configCommand, projects: projectsCommand, workspaces: workspacesCommand }`; change the last line to `process.exit((await run(main, process.argv.slice(2))) || (process.exitCode ?? 0))`.

- [ ] **Step 7: End-to-end test of `run` with the fake provider**

`apps/bytebureau/src/commands/run.test.ts` (spawns the CLI as a subprocess like `cli.test.ts` does, with `BYTEBUREAU_HOME` pointing at a temp dir and a temp git repository from the workspace-local test helper — import `createTempRepo` from `@bytebureau/workspace-local/testing` is not allowed (nothing imports a plugin's internals); copy the 20-line helper into `apps/bytebureau/src/testing/temp-repo.ts` instead):
```ts
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../testing/run-cli.js'
import { createTempRepo } from '../testing/temp-repo.js'

describe('bytebureau run (fake provider, no daemon)', () => {
  it('provisions a worktree, streams NDJSON events with increasing seq, answers the ask with --yes and exits 0', async () => {
    const repo = createTempRepo()
    const home = mkdtempSync(path.join(tmpdir(), 'bb-home-'))
    const result = await runCli(
      ['run', 'Create src/hello.ts exporting hello()', '--project', repo, '--provider', 'fake', '--json', '--yes'],
      { BYTEBUREAU_HOME: home },
    )
    expect(result.code).toBe(0)
    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as { seq: number; type: string })
    const seqs = events.map((event) => event.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['session.created', 'workspace.provisioned', 'turn.started', 'ask.requested', 'ask.answered', 'turn.completed', 'session.completed']),
    )
    const worktrees = path.join(repo, '.bytebureau', 'worktrees')
    const [worktree] = readdirSync(worktrees)
    expect(existsSync(path.join(worktrees, worktree ?? '', 'src', 'hello.ts'))).toBe(true)
    expect(readFileSync(path.join(home, 'data', 'bytebureau.db')).length).toBeGreaterThan(0)
  })

  it('exits 4 when the provider does not exist and creates nothing', async () => {
    const repo = createTempRepo()
    const home = mkdtempSync(path.join(tmpdir(), 'bb-home-'))
    const result = await runCli(['run', 'x', '--project', repo, '--provider', 'nope', '--json'], { BYTEBUREAU_HOME: home })
    expect(result.code).toBe(4)
    expect(existsSync(path.join(repo, '.bytebureau', 'worktrees'))).toBe(false)
  })

  it('exits 3 and retains the worktree when interrupted mid-turn', async () => {
    const repo = createTempRepo()
    const home = mkdtempSync(path.join(tmpdir(), 'bb-home-'))
    const result = await runCli(
      ['run', 'slow task', '--project', repo, '--provider', 'fake', '--json', '--yes'],
      { BYTEBUREAU_HOME: home, BYTEBUREAU_FAKE_SCRIPT: 'slow' },
      { killAfterMs: 1500, signal: 'SIGINT' },
    )
    expect(result.code).toBe(3)
    expect(existsSync(path.join(repo, '.bytebureau', 'worktrees'))).toBe(true)
    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as { type: string })
    expect(events.map((event) => event.type)).toContain('turn.interrupted')
  })
})
```
`apps/bytebureau/src/testing/run-cli.ts` spawns `bun run src/main.ts <args>` with the merged environment, optionally sending `signal` after `killAfterMs`, and resolves `{ code, stdout, stderr }` (reuse the helper already inside `cli.test.ts` by moving it into this file and importing it from both tests). Add `import { readdirSync } from 'node:fs'` to the test's imports.

Run: `bunx vitest run --project bytebureau` → PASS. Run `bun run check` → green (coverage `include` gains `apps/bytebureau/src/render/**/*.ts`).

- [ ] **Step 8: Commit**

```bash
git add apps/bytebureau packages/i18n/messages vitest.config.ts bun.lock
git commit -m "feat(cli): add run, config, projects and workspaces commands on the in-process kernel"
```

### Task 16: Gates, ADR-0010, docs, binary smoke in CI, full fresh-clone run

**Files:**
- Create: `docs/decisions/0010-sqlite-through-effect-sql.md`
- Modify: `.github/workflows/ci.yml` (smoke the compiled binary with the fake provider), `CONTRIBUTING.md` (kernel onboarding paragraph), `apps/docs/src/content/docs/architecture.md`, `README.md` + `README.cs.md` (status line), `vitest.config.ts` (final coverage include), `.dependency-cruiser.cjs` (verify, no change expected)

- [ ] **Step 1: ADR-0010**

`docs/decisions/0010-sqlite-through-effect-sql.md` (MADR 4.0 style like 0001–0009):
```markdown
# SQLite through Effect SQL; Drizzle deferred

- Status: accepted
- Date: 2026-10-03

## Context and problem statement

The kernel persists sessions, events and asks in SQLite and must run inside a compiled Bun binary while its tests run under Node (Vitest). Drizzle ORM was the planned query layer, but on 2026-10-02 its Effect drivers (`drizzle-orm@1.0.0-rc.4`) do not load against `effect@4.0.0`, its `node:sqlite` driver exists only in the 1.0 release candidates, and its migrator reads migration files from disk, which a compiled binary does not ship.

## Decision

`packages/kernel` talks to SQLite through `effect/sql` with `@effect/sql-sqlite-bun` in the binary and `@effect/sql-sqlite-node` (built on `node:sqlite`) under Vitest — the same `SqlClient` API, verified to behave identically. Migrations are embedded SQL strings applied once each in a transaction and recorded in `bb_migrations`. Row mapping is explicit per service; `effect/Schema` validates payloads at the boundaries.

## Consequences

No typed query builder; queries are reviewed as SQL. Revisit Drizzle (schema as source of truth, `drizzle-kit generate` for migrations) once a stable release loads on Effect 4 and offers a `node:sqlite` driver. Node 24 prints an `ExperimentalWarning` for `node:sqlite` that the Vitest project silences.
```

- [ ] **Step 2: CI smoke of the compiled binary (Bun-only store path)**

`.github/workflows/ci.yml`, job `build-smoke`, after the existing `smoke (x64)` step:
```yaml
      - name: smoke (kernel run, fake provider)
        run: |
          set -euo pipefail
          BIN=(dist/bytebureau-*-linux-x64)
          [ "${#BIN[@]}" -eq 1 ]
          REPO=$(mktemp -d)
          git -C "$REPO" init -q -b main
          git -C "$REPO" -c user.name=ci -c user.email=ci@example.com commit -q --allow-empty -m init
          BYTEBUREAU_HOME=$(mktemp -d) "${BIN[0]}" run "Create src/hello.ts exporting hello()" --project "$REPO" --provider fake --json --yes > events.ndjson
          grep -q '"type":"session.completed"' events.ndjson
          test -f "$REPO"/.bytebureau/worktrees/*/src/hello.ts
```
(`smoke-macos` gets the same step with `dist/bytebureau-*-darwin-arm64`.) The step is the only place the `StoreLive`/`bun:sqlite` path runs in CI; keep it. Run `bun run lint:actions` → clean (no new `uses:`; nothing to pin).

- [ ] **Step 3: Docs and contributor notes**

- `CONTRIBUTING.md`: add a short "Working in the kernel" section: Effect 4 is used only in `packages/kernel`, `packages/api`, `packages/protocol`; services are `Context.Service` classes with a `Live` layer; tests use `@effect/vitest` (`it.effect`, `layer()`), the in-memory `StoreTest`, `TestClock` and the fake provider; plugins never import Effect. Link `docs/decisions/0003-effect-in-the-kernel-only.md` and `0010`.
- `apps/docs/src/content/docs/architecture.md`: replace the "coming with sub-project 1" placeholder (if present) with the package table from spec §3 and the `bytebureau run` flow in five sentences; add `0010` to the ADR list if the page lists ADRs by hand (the sidebar autogenerates).
- `README.md` / `README.cs.md` status lines: mention that `bytebureau run --provider fake` works headless (Czech: vykání, office metaphor, no "open source").

- [ ] **Step 4: Final gate on a fresh clone**

Confirm `bunfig.toml` still has `minimumReleaseAge = 86400` and no `minimumReleaseAgeExcludes` entry. Then:
```bash
rm -rf /tmp/bb-clean && git clone --quiet . /tmp/bb-clean && cd /tmp/bb-clean
bun install --frozen-lockfile
bun run check
bun run lint:actions
bun run build:binaries --host
BYTEBUREAU_HOME=$(mktemp -d) ./dist/bytebureau-*-darwin-arm64 run "Create src/hello.ts exporting hello()" --project "$(git rev-parse --show-toplevel)" --provider fake --json --yes | tail -3
bun run docs:build
```
Expected: every gate green; the compiled binary completes the fake run on the clone's own repository (its `.bytebureau/worktrees/<id>/src/hello.ts` exists). Use the session scratchpad instead of `/tmp` when the executor's rules say so.

- [ ] **Step 5: Commit**

```bash
git add docs/decisions/0010-sqlite-through-effect-sql.md .github/workflows/ci.yml CONTRIBUTING.md apps/docs/src/content/docs/architecture.md README.md README.cs.md bunfig.toml vitest.config.ts
git commit -m "docs(repo): record the effect sql decision, smoke the kernel binary in ci and describe the kernel phase"
```


---

## Plan self-review (done while writing)

- **Spec coverage (Phase A scope):** §2 architecture → Tasks 1–3, 14; §3 packages `protocol`, `plugin-api`, `kernel`, `workspace-local` → Tasks 1, 2, 3, 9 (`api`, `client`, `agent-claude`, `agent-acp` are Phases B/C); §4 services → Tasks 5 (Config), 3 (Store), 6 (EventLog), 7 (ProjectRegistry), 8 (Supervisor), 10 (WorkspaceManager), 13 (SessionManager, UsageService), 12 (AskService), 11 (PluginHost), 4 (Logging); `ProfileService`, `SecretStore` (keychain), `Health`, `Tracing` export → Phases C/D (an in-memory `SecretStore` placeholder ships in Task 11); §5 data model → Task 3 (`idx` for `index`), §5.3 → Task 13, §5.4 catalogue → Task 1; §6 ports → Task 2; §7 plugin host → Task 11 (bundled + extra plugins; npm/directory discovery and installs → Phase D); §8.3 → Task 1, §8.4 → Task 12; §9 → Task 9 (+ Task 10 for prune/retain); §10 → Tasks 1, 5 (`config init|validate|schema` → Task 15); §11.3 `run`, `projects`, `config`, `workspaces` → Task 15 (the rest → Phases B/D); §12 logger, categories, redaction → Task 4 (file sink wired, fingers-crossed and the diag bundle → Phase D); §13 env allowlist, `yolo` refusal, no secrets in logs → Tasks 8, 13, 4; §14 invalid config, provider missing, workspace dirty, ask timeout → Tasks 5, 13, 10, 12; §15 model-based state machine, redaction canaries, slug rules, fake provider → Tasks 13, 4, 10, 13; §16 criteria 1, 6, 8 → Tasks 15, 12/13, 5; criterion 10 → Task 16.
- **Placeholder scan:** no TBD/TODO/"similar to" remains; every code step shows the code; the few "verify the name in the installed d.ts" notes name the exact alternative to use.
- **Type consistency:** `WorkspaceHandle` fields (`id, runtimeId, path, branch, baseRef`) are identical in Tasks 2, 9, 10, 13; `KernelEvent`/`EventEnvelope` shapes match between Tasks 1, 6, 11, 13, 15; `AskRecord`/`Ask` fields (`policy`, `recommendationSource`, `deadlineAt`) match Tasks 1, 12, 13; the `Kernel` facade in Task 14 is the one Task 15 consumes (plus `sessions.complete`, `providers.list`, `CreateSessionInput.env`).
- **Review Focus:** (1) CRLF/emoji/diacritics prompt → Task 13 session-manager test; (2) non-repository / ByteBureau-worktree project → Tasks 7 and 9 tests; (3) SIGINT mid-turn → Task 15 `run.test.ts` third case; (4) dirty main checkout untouched → Task 9 test; (5) timeout policy per kind → Task 12 tests.
