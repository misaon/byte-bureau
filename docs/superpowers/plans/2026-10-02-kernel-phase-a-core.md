# Kernel & agent runtime — Phase A (core, headless run) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the kernel core of sub-project 1 so that `bytebureau run "<prompt>" --project <repo> --no-daemon` with the built-in fake agent provider registers the project, provisions a git worktree, runs a session through the Effect kernel, streams canonical events, brokers an ask through the CLI with a recommended option, persists durable events with increasing `seq`, and exits with the documented codes — in CI, on a fresh clone, with every SP0 gate green.

**Architecture:** Hexagonal, exactly as the spec draws it: `packages/protocol` (Effect Schema DTOs, event catalogue, config schema, generated JSON Schema), `packages/plugin-api` (plain-TypeScript ports and plugin contract, no Effect), `packages/kernel` (Effect 4 services as Layers: Config, Store, EventLog, ProjectRegistry, Supervisor, WorkspaceManager, SessionManager, AskService, UsageService, PluginHost, Logging), `plugins/workspace-local` (git worktree runtime), and the CLI in `apps/bytebureau` that wires the kernel in-process (`--no-daemon`). Phase B adds the daemon, HTTP/SSE/WebSocket API and the generated client; Phase C adds the Claude and ACP adapters, profiles and the secret store; Phase D adds doctor, diagnostics bundle, service install, upgrade and the full logging/tracing surface. Every interface in this plan is written so those phases extend rather than rework it.

**Tech Stack:** Bun 1.4.2 (runtime), TypeScript 7.0.x, Effect 4 (`effect`), Effect SQL + SQLite (`@effect/sql-sqlite-bun` in the binary, `@effect/sql-sqlite-node` under Vitest), `jsonc-parser` (configuration files are data), LogTape (logging), `@standard-schema/spec`, Vitest 5 + fast-check, citty + @clack/prompts (CLI), git ≥ 2.40.

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
- Child processes get an explicit environment allowlist (`PATH`, `HOME`, `LANG`/`LC_*`, `TMPDIR`, `TERM`, `SSH_AUTH_SOCK`, profile variables, `TRACEPARENT`, `BYTEBUREAU_*`, `providers.<id>.passEnv`), never the full daemon environment; graceful termination SIGINT → SIGTERM after 5 s → SIGKILL after 10 s.
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
packages/kernel/{package.json,tsconfig.json,vitest.config.ts}
packages/kernel/src/index.ts                        public re-exports for apps (createKernel() lives in the Bun entry)
packages/kernel/src/bun.ts                          Bun-only entry: StoreLive (Task 3), createKernel() facade (Task 14)
packages/kernel/src/ids.ts                          uuidv7(), nowIso()
packages/kernel/src/errors.ts                       tagged errors: ConfigError, StoreError, WorkspaceError, ProviderError, AskError, PluginError, SessionError
packages/kernel/src/store/migrations.ts             SQL migrations embedded for the binary (0001_initial, §5.2)
packages/kernel/src/store/migrate.ts                runMigrations: bb_migrations ledger, one transaction per migration
packages/kernel/src/store/pragmas.ts                WAL, synchronous=NORMAL, busy_timeout, foreign_keys
packages/kernel/src/store/store-live.ts             StoreLive(filename): bun:sqlite client + pragmas + migrations
packages/kernel/src/store/store-test.ts             StoreTest: node:sqlite in memory for Vitest
packages/kernel/src/config/merge.ts                 mergeConfig, mergeLayers, ConfigLayer
packages/kernel/src/config/env-overrides.ts         BYTEBUREAU_* variables → env:<NAME> layers
packages/kernel/src/config/files.ts                 JSON/JSONC discovery, jsonc-parser, symlink and project path checks
packages/kernel/src/config/issues.ts                Standard Schema checks, RFC 6901 pointers, layer attribution
packages/kernel/src/config/config.ts                Config service (precedence, load/validate/schema)
packages/kernel/src/config/template.ts              defaultProjectConfigText() for config init
packages/kernel/src/config/config-fixtures.ts       temp-directory helpers shared by the config tests
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

// The branch keys are left out on purpose: a default here would hide the one detected from each repository
export const defaultProjectConfig: ProjectConfig = {
  version: 1,
  project: { name: 'my-app' },
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
  defaults: { employee: 'developer' },
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
    "effect": "4.0.0",
    "jsonc-parser": "3.3.1",
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
- Produces: `uuidv7(): string`, `nowIso(): string`; error classes `ConfigError { file, pointer, reason }`, `StoreError { cause }`, `WorkspaceError { code, reason }`, `ProviderError { kind, reason, retryable }`, `AskError { code, reason }`, `PluginError { plugin, reason }`, `SessionError { code, reason }` (all `Data.TaggedError`, `_tag` equals the class name); `LoggingOptions { level, debug?, file?, json }`, `configureLogging(options): Promise<void>`, `kernelLogger(category: readonly string[]): Logger` (the plugin-api `Logger` over LogTape), `EffectLoggerLive: Layer<never>` (routes Effect logs into LogTape), `REDACTED_FIELDS`, `SECRET_PATTERNS`, `redactFields(sink)`, `redactText(formatter)`.

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

  it('keeps a jsonl line valid: URL credentials never span quotes or JSON punctuation', () => {
    const format = redactText(jsonLinesFormatter)
    const line = format(
      record(
        { plugin: '@bytebureau/demo' },
        'fetch http://user:pw@example.com/x then http://localhost:3000',
      ),
    )
    expect(line).not.toContain('user:pw')
    expect(JSON.parse(line)).toMatchObject({
      message: 'fetch http://[REDACTED]@example.com/x then http://localhost:3000',
      properties: { plugin: '@bytebureau/demo' },
    })
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

async function debugDelivery(debug: string): Promise<readonly unknown[]> {
  const seen = await captured(
    { level: 'info', json: true, debug },
    Effect.sync(() => {
      getLogger(['bb', 'core']).debug('core debug')
      getLogger(['bb', 'core']).info('core info')
      getLogger(['bb', 'store']).debug('store debug')
      getLogger(['bb', 'store']).info('store info')
      getLogger(['bb', 'agent']).debug('agent debug')
    }),
  )
  return seen.map((entry) => entry.message[0])
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

  it('keeps string parts literal and merges one object part into the properties, in bb.core by default', async () => {
    expect.hasAssertions()
    const seen = await captured(
      { level: 'info', json: true },
      Effect.logInfo('literal {name} }} {{x}}', { count: 1 }),
    )
    expect(
      seen.map((entry) => [entry.category.join('.'), entry.message[0], entry.properties]),
    ).toStrictEqual([['bb.core', 'literal {name} }} {{x}}', { count: 1 }]])
  })
})

describe('effect message parts', () => {
  it('puts object parts through the field redaction, leaving no canary in text or properties', async () => {
    expect.hasAssertions()
    const seen = await captured(
      { level: 'info', json: true },
      Effect.logInfo('x', {
        password: 'hunter2-canary',
        nested: { authorization: 'Bearer canary' },
      }),
    )
    expect(JSON.stringify(seen)).not.toContain('canary')
    expect(seen.map((entry) => [entry.message, entry.properties])).toStrictEqual([
      [['x'], { nested: {} }],
    ])
  })

  it('stores several, non-object and Error parts under parts, redacted like any property', async () => {
    expect.hasAssertions()
    const logging = Effect.all(
      [
        Effect.logInfo('a', 'b', { token: 'canary', keep: 1 }, 7),
        Effect.logInfo('count', 5),
        Effect.logError('failed', new Error('boom')),
      ],
      { discard: true },
    )
    const seen = await captured({ level: 'info', json: true }, logging)
    expect(seen.map((entry) => [entry.message[0], entry.properties])).toStrictEqual([
      ['a b', { parts: [{ keep: 1 }, 7] }],
      ['count', { parts: [5] }],
      ['failed', { parts: [new Error('boom')] }],
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

describe('debug selections', () => {
  const everything = ['core debug', 'core info', 'store debug', 'store info', 'agent debug']

  it.each<[string, readonly string[]]>([
    ['', everything],
    ['true', everything],
    ['bb,!bb.store', ['core debug', 'core info', 'agent debug']],
    ['bb.agent,!bb.agent', ['core info', 'store info']],
    ['bb.agent,bb.agent,!bb.store,!bb.store', ['core info', 'agent debug']],
    ['logtape.meta', ['core info', 'store info']],
  ])('--debug %j delivers %j', async (debug, delivered) => {
    expect.hasAssertions()
    await expect(debugDelivery(debug)).resolves.toStrictEqual(delivered)
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
  readonly plugin: string
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
    pattern: /(?<scheme>https?:\/\/)[^\s/@:"'\\]+:[^\s/@"'\\]+@/gu,
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

// Keyed by category so a repeated or bb-rooted selection replaces an entry; negations come last and win
function categoryConfigs(options: LoggingOptions, sinkIds: string[]): CategoryConfig[] {
  const { enabled, silenced } = parseDebug(options.debug) ?? NO_DEBUG
  const configs = new Map<string, CategoryConfig>([
    ['bb', { category: ['bb'], sinks: sinkIds, lowestLevel: toLogTape(options.level) }],
  ])
  for (const category of enabled) {
    configs.set(category.join('.'), {
      category,
      sinks: sinkIds,
      parentSinks: 'override',
      lowestLevel: 'debug',
    })
  }
  for (const category of silenced) {
    configs.set(category.join('.'), {
      category,
      sinks: [],
      parentSinks: 'override',
      lowestLevel: 'fatal',
    })
  }
  // The kernel configures the meta logger itself
  configs.delete('logtape.meta')
  return [...configs.values()]
}

export async function configureLogging(options: LoggingOptions): Promise<void> {
  const allSinks = sinks(options)
  await configure({
    reset: true,
    sinks: allSinks,
    loggers: [
      // Without an explicit entry LogTape gives the meta logger a default console sink that skips the redaction
      { category: ['logtape', 'meta'], sinks: ['console'], lowestLevel: 'warning' },
      ...categoryConfigs(options, Object.keys(allSinks)),
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

const toParts = (message: unknown): readonly unknown[] =>
  Array.isArray(message) ? message : [message]

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const prototype = Reflect.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

// Parts that are not strings become properties, so the field redaction sees them: one plain object is merged, the rest go under `parts`
function partProperties(parts: readonly unknown[]): Record<string, unknown> {
  const [only] = parts
  if (parts.length === 1 && isPlainRecord(only)) {
    return only
  }
  return parts.length > 0 ? { parts } : {}
}

// A bridged record carries one literal message part that is never a placeholder; the raw template's braces are escaped
const literalMessage = (text: string): Pick<LogRecord, 'message' | 'rawMessage'> => ({
  message: [text],
  rawMessage: text.replaceAll('{', '{{').replaceAll('}', '}}'),
})

// Effect logger → LogTape: the category annotation picks the logger, the other annotations and the non-string parts become properties
export const effectToLogTape: Logger.Logger<unknown, void> = Logger.make((options) => {
  const level = levelMap[options.logLevel]
  if (level === undefined) {
    return
  }
  const { category, ...annotations } = options.fiber.getRef(References.CurrentLogAnnotations)
  const parts = toParts(options.message)
  const text = parts.filter((part) => typeof part === 'string').join(' ')
  const properties: Record<string, unknown> = {
    ...annotations,
    ...partProperties(parts.filter((part) => typeof part !== 'string')),
  }
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

### Task 5: `Config` service — layered loading, strict validation, JSON pointers

**Files:**
- Create: `packages/kernel/src/config/merge.ts`, `packages/kernel/src/config/env-overrides.ts`, `packages/kernel/src/config/files.ts`, `packages/kernel/src/config/issues.ts`, `packages/kernel/src/config/config.ts`, `packages/kernel/src/config/template.ts`, `packages/kernel/src/config/config-fixtures.ts`, `packages/kernel/src/config/merge.test.ts`, `packages/kernel/src/config/config.test.ts`, `packages/kernel/src/config/config.validation.test.ts`, `packages/kernel/src/config/config.files.test.ts`
- Modify: `packages/kernel/src/index.ts`, `packages/kernel/package.json` (`jsonc-parser` in, `c12` out), `knip.ts` (the kernel's temporary `ignoreDependencies` entries for `@bytebureau/protocol` and `c12` go away)

**Interfaces:**
- Consumes: `ProjectConfig`, `UserConfig`, `decodeProjectConfig`, `defaultProjectConfig`, `configJsonSchema` (Task 1); `ConfigError` (Task 4); `jsonc-parser` 3.3.1 — `parse(text, errors, { allowTrailingComma: true, allowEmptyContent: true })` and `printParseErrorCode` (configuration files are read as text; nothing is ever imported; c12 was dropped in fix round 2, see the semantics below).
- Produces: `Config` service with `load(request: LoadRequest): Effect<ResolvedConfig, ConfigError>`, `validate(projectPath: string): Effect<readonly ConfigIssue[]>` (never fails; includes the user file), `schema(): Record<string, unknown>`; `ConfigLive(home: string): Layer<Config>`; `mergeConfig(base, overlay)` (deep merge, arrays replaced, `undefined` skipped at every depth), `mergeLayers(layers)` and `ConfigLayer { label, config, fromFile }` (internal); `envOverrides(env): readonly ConfigLayer[]` (one `env:<NAME>` layer per set variable); `defaultProjectConfigText()`; types `LoadRequest { projectPath?: string; env?: Record<string, string | undefined>; flags?: FlagOverrides }` (`env` defaults to an empty object — callers pass the environment), `FlagOverrides { employee?, branch?, logLevel? }`, `ResolvedConfig { project: ProjectConfig; user: UserConfig; projectPath: string | null; files: { user: string | null; project: string | null; local: string | null } }` (absolute paths of existing files), `ConfigIssue { file: string; pointer: string; message: string }` where `file` is the layer label: a file path, `env:<NAME>`, `flag:<key>` or `(defaults)`.

Semantics (as shipped): configuration files are data, never code — only regular `bytebureau.json`/`bytebureau.jsonc`, `bytebureau.local.json`/`.jsonc` and `~/.bytebureau/config.json`/`.jsonc` are read; both variants of one name → `ConfigError` naming both; The kernel reads the files as text and parses them with `jsonc-parser` (comments and trailing commas allowed in both extensions; syntax errors are a `ConfigError` naming the file with line and column). c12 was dropped: with rc files, dotenv, environment keys, `package.json`, `extends` and giget switched off it was still a code loader that imported symlink targets, normalised scalar roots to `{}` and dropped top-level `null` sections and `$meta` before validation. Symlinks are followed as text (a link to a script is a parse error and never runs; a dangling link is an error). The spec's "`extends` for team presets" is deferred to a later phase as a kernel-native feature (JSON/JSONC presets by relative path, lowest project layer, cycle detection). Every issue is attributed to the highest-priority layer that contains its pointer (`(defaults)` < user file (`logging` only) < project file < local file < `env:<NAME>` < `flag:<key>`); a missing key goes to the highest-priority file layer holding its parent, else the project file, else `(defaults)`. The user file is checked with its own strict Standard Schema (pointer-level). Any root that is not a plain object (array, `null`, scalar, empty file) is one issue at pointer `""`. A `projectPath` that does not exist or is not a directory fails `load` and is one issue from `validate`. Defaults are `structuredClone`d so resolved configs never share arrays with `defaultProjectConfig`; the built-in `developer` employee and the `claude` provider defaults merge into every project.

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
    expect(merged).toStrictEqual({
      workspace: { copyIgnored: ['.env.local'], retainDays: 7 },
      logging: { level: 'debug' },
    })
  })

  it('ignores undefined overlay values', () => {
    expect(mergeConfig({ kept: 1 }, { kept: undefined, added: 2 })).toStrictEqual({
      kept: 1,
      added: 2,
    })
  })

  it('ignores undefined values inside a section the base does not have', () => {
    expect(mergeConfig({}, { section: { kept: 1, dropped: undefined } })).toStrictEqual({
      section: { kept: 1 },
    })
  })

  it('leaves both inputs untouched and shares no section with the overlay', () => {
    const base = { section: { fromBase: 1 } }
    const overlay = { section: { fromOverlay: 2 }, added: { nested: true } }
    const merged = mergeConfig(base, overlay)
    expect(base).toStrictEqual({ section: { fromBase: 1 } })
    expect(overlay).toStrictEqual({ section: { fromOverlay: 2 }, added: { nested: true } })
    expect(merged['added']).toStrictEqual({ nested: true })
    expect(merged['added']).not.toBe(overlay.added)
  })
})
```
`packages/kernel/src/config/config.test.ts`:
```ts
import path from 'node:path'
import { defaultProjectConfig, type ProjectConfig } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect, type Scope } from 'effect'
import { Config, ConfigLive } from './config.js'
import {
  LOCAL_FILE,
  PROJECT_FILE,
  PROJECT_JSONC,
  USER_FILE,
  workspace,
  write,
  type Workspace,
} from './config-fixtures.js'

// A user file, a project file with comments and a local file: every layer except the environment and the flags
function layered(): Effect.Effect<Workspace, never, Scope.Scope> {
  return Effect.gen(function* writeLayers() {
    const space = yield* workspace()
    write(space.home, USER_FILE, { logging: { level: 'warn' }, defaults: { provider: 'fake' } })
    write(
      space.project,
      PROJECT_JSONC,
      `{
  // project file wins over the user file
  "version": 1,
  "project": { "name": "demo", "defaultBranch": "develop" },
  "employees": { "dev": { "name": "Dev", "provider": "fake", "model": "m", "permissionMode": "autonomous" } },
  "defaults": { "employee": "dev" },
  "logging": { "level": "info" }
}`,
    )
    const local = { logging: { level: 'debug' }, workspace: { copyIgnored: ['.env.local'] } }
    write(space.project, LOCAL_FILE, local)
    return space
  })
}

function settingSources(project: ProjectConfig): unknown {
  const claude = project.providers === undefined ? undefined : project.providers['claude']
  return claude === undefined ? undefined : claude['settingSources']
}

it.effect('layers local over project over user over the defaults', () =>
  Effect.gen(function* layersFiles() {
    const { config, project } = yield* layered()
    const plain = yield* config.load({ projectPath: project })
    assert.deepStrictEqual(plain.project.logging, { level: 'debug' })
    assert.strictEqual(plain.project.project.defaultBranch, 'develop')
    assert.deepStrictEqual(plain.project.workspace, {
      runtime: 'local',
      copyIgnored: ['.env.local'],
      retainDays: 7,
    })
    assert.deepStrictEqual(plain.user.defaults, { provider: 'fake' })
  }),
)

it.effect('layers the environment over the files and the flags over the environment', () =>
  Effect.gen(function* layersEnvironmentAndFlags() {
    const { config, home, project } = yield* layered()
    const env = { BYTEBUREAU_LOG_LEVEL: 'error' }
    const withEnv = yield* config.load({ projectPath: project, env })
    assert.deepStrictEqual(withEnv.project.logging, { level: 'error' })
    const withFlags = yield* config.load({
      projectPath: project,
      env,
      flags: { logLevel: 'trace' },
    })
    assert.deepStrictEqual(withFlags.project.logging, { level: 'trace' })
    assert.strictEqual(withFlags.files.project, path.join(project, PROJECT_JSONC))
    assert.strictEqual(withFlags.files.local, path.join(project, LOCAL_FILE))
    assert.strictEqual(withFlags.files.user, path.join(home, USER_FILE))
  }),
)

it.effect('lets the project file override the user file', () =>
  Effect.gen(function* projectOverUser() {
    const { config, home, project } = yield* workspace()
    write(home, USER_FILE, { logging: { level: 'warn' } })
    write(project, PROJECT_FILE, { logging: { level: 'info' } })
    const resolved = yield* config.load({ projectPath: project })
    assert.deepStrictEqual(resolved.project.logging, { level: 'info' })
  }),
)

it.effect('maps every environment variable and flag to its section and skips empty values', () =>
  Effect.gen(function* mapsOverrides() {
    const { config, project } = yield* layered()
    const env = {
      BYTEBUREAU_EMPLOYEE: 'ops',
      BYTEBUREAU_BRANCH: 'release',
      BYTEBUREAU_WORKSPACE_RUNTIME: 'docker',
      BYTEBUREAU_LOG_LEVEL: '',
    }
    const fromEnv = yield* config.load({ projectPath: project, env })
    assert.deepStrictEqual(fromEnv.project.defaults, { employee: 'ops', branch: 'release' })
    assert.deepStrictEqual(fromEnv.project.workspace, {
      runtime: 'docker',
      copyIgnored: ['.env.local'],
      retainDays: 7,
    })
    assert.deepStrictEqual(fromEnv.project.logging, { level: 'debug' })
    const flags = { employee: 'lead', branch: 'hotfix' }
    const fromFlags = yield* config.load({ projectPath: project, env, flags })
    assert.deepStrictEqual(fromFlags.project.defaults, flags)
  }),
)

it.effect('falls back to defaults named after the directory when no project file exists', () =>
  Effect.gen(function* fallsBackToDefaults() {
    const { config, project } = yield* workspace()
    const resolved = yield* config.load({ projectPath: project })
    assert.strictEqual(resolved.project.project.name, path.basename(project))
    assert.deepStrictEqual(resolved.project.defaults, { employee: 'developer' })
    assert.strictEqual(resolved.project.project.defaultBranch, undefined)
    assert.deepStrictEqual(resolved.files, { user: null, project: null, local: null })
  }),
)

it.effect('applies a local file when there is no project file', () =>
  Effect.gen(function* appliesLocalAlone() {
    const { config, project } = yield* workspace()
    const local = write(project, LOCAL_FILE, { logging: { level: 'debug' } })
    const resolved = yield* config.load({ projectPath: project })
    assert.deepStrictEqual(resolved.project.logging, { level: 'debug' })
    assert.strictEqual(resolved.project.project.name, path.basename(project))
    assert.deepStrictEqual(resolved.files, { user: null, project: null, local })
  }),
)

it.effect('loads the user layer and the defaults when no project path is given', () =>
  Effect.gen(function* loadsWithoutProject() {
    const { config, home } = yield* workspace()
    const userFile = write(home, USER_FILE, { logging: { level: 'error' } })
    const resolved = yield* config.load({})
    assert.strictEqual(resolved.projectPath, null)
    assert.strictEqual(resolved.project.project.name, 'default')
    assert.deepStrictEqual(resolved.project.logging, { level: 'error' })
    assert.deepStrictEqual(resolved.files, { user: userFile, project: null, local: null })
  }),
)

it.effect('reports absolute file paths for a relative home directory', () =>
  Effect.gen(function* resolvesRelativeHome() {
    const { home } = yield* workspace()
    const userFile = write(home, USER_FILE, {})
    const relative = path.relative(process.cwd(), home)
    const config = yield* Effect.provide(Config, ConfigLive(relative))
    const resolved = yield* config.load({})
    assert.strictEqual(resolved.files.user, userFile)
  }),
)

it.effect('shares no array with the protocol defaults', () =>
  Effect.gen(function* copiesDefaults() {
    const { config, project } = yield* workspace()
    const resolved = yield* config.load({ projectPath: project })
    assert.deepStrictEqual(settingSources(resolved.project), ['user', 'project', 'local'])
    assert.notStrictEqual(settingSources(resolved.project), settingSources(defaultProjectConfig))
  }),
)

it.effect('serves the JSON Schema of the project file', () =>
  Effect.gen(function* servesSchema() {
    const { config } = yield* workspace()
    assert.strictEqual(config.schema()['$id'], 'https://bytebureau.dev/schema/v1/config.json')
  }),
)
```
`packages/kernel/src/config/config-fixtures.ts` (shared temp-directory helpers):
```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Effect, type Scope } from 'effect'
import { Config, ConfigLive, type ConfigShape } from './config.js'

export const PROJECT_FILE = 'bytebureau.json'
export const PROJECT_JSONC = 'bytebureau.jsonc'
export const LOCAL_FILE = 'bytebureau.local.json'
export const USER_FILE = 'config.json'

export interface Workspace {
  readonly config: ConfigShape
  readonly home: string
  readonly project: string
}

// Fixture directories are removed when the scope of their test closes
function tempDir(prefix: string): Effect.Effect<string, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), prefix))),
    (directory) =>
      Effect.sync(() => {
        rmSync(directory, { recursive: true, force: true })
      }),
  )
}

// Strings are written as they are, every other value as JSON
export function write(directory: string, name: string, content: unknown): string {
  const file = path.join(directory, name)
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  return file
}

// A Config over an empty home directory, next to an empty project directory
export function workspace(): Effect.Effect<Workspace, never, Scope.Scope> {
  return Effect.gen(function* emptyWorkspace() {
    const home = yield* tempDir('bb-home-')
    const project = yield* tempDir('bb-project-')
    const config = yield* Effect.provide(Config, ConfigLive(home))
    return { config, home, project }
  })
}
```
`packages/kernel/src/config/config.validation.test.ts`:
```ts
// CSpell:ignore locael
import path from 'node:path'
import { decodeProjectConfig, defaultProjectConfig } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect, Result, type Scope } from 'effect'
import { parse, type ParseError } from 'jsonc-parser'
import { ConfigError } from '../errors.js'
import type { ConfigIssue } from './config.js'
import {
  LOCAL_FILE,
  PROJECT_FILE,
  PROJECT_JSONC,
  USER_FILE,
  workspace,
  write,
  type Workspace,
} from './config-fixtures.js'
import { defaultProjectConfigText } from './template.js'

const SCHEMA_URL = 'https://bytebureau.dev/schema/v1/config.json'
const LEVEL = '/logging/level'

// An unknown top-level key and a level outside the enum, next to otherwise valid sections
function broken(): Effect.Effect<Workspace, never, Scope.Scope> {
  return Effect.gen(function* writeBrokenProject() {
    const space = yield* workspace()
    const content = {
      version: 1,
      project: { name: 'x' },
      employees: {},
      logging: { level: 'loud' },
      extra: true,
    }
    write(space.project, PROJECT_FILE, content)
    return space
  })
}

const where = (issues: readonly ConfigIssue[]): readonly (readonly [string, string])[] =>
  issues.map((issue) => [issue.file, issue.pointer] as const)

it.effect('reports unknown keys and bad values with file and JSON pointer', () =>
  Effect.gen(function* reportsPointers() {
    const { config, project } = yield* broken()
    const issues = yield* config.validate(project)
    assert.deepStrictEqual(issues.map((issue) => issue.pointer).toSorted(), ['/extra', LEVEL])
    assert.ok(issues.every((issue) => issue.file.endsWith(PROJECT_FILE)))
    const failure = yield* Effect.result(config.load({ projectPath: project }))
    assert.isTrue(Result.isFailure(failure))
  }),
)

it.effect('fails the load with one ConfigError that names the file and lists every issue', () =>
  Effect.gen(function* failsWithConfigError() {
    const { config, project } = yield* broken()
    const file = path.join(project, PROJECT_FILE)
    const error = yield* Effect.flip(config.load({ projectPath: project }))
    assert.instanceOf(error, ConfigError)
    assert.strictEqual(error.file, file)
    assert.oneOf(error.pointer, ['/extra', LEVEL])
    assert.include(error.reason, `${file}/extra: `)
    assert.include(error.reason, `${file}/logging/level: `)
  }),
)

it.effect('escapes slashes and tildes in the segments of a pointer', () =>
  Effect.gen(function* escapesSegments() {
    const { config, project } = yield* workspace()
    write(project, PROJECT_FILE, { project: { name: 'x' }, employees: { 'a/b~c': {} } })
    const issues = yield* config.validate(project)
    assert.deepStrictEqual(
      issues.map((issue) => issue.pointer).toSorted(),
      ['model', 'name', 'permissionMode', 'provider'].map((key) => `/employees/a~1b~0c/${key}`),
    )
  }),
)

it.effect('names the project file for a bad project value next to a valid local file', () =>
  Effect.gen(function* namesProjectFile() {
    const { config, project } = yield* workspace()
    const file = write(project, PROJECT_FILE, { logging: { level: 'loud' } })
    write(project, LOCAL_FILE, { workspace: { retainDays: 3 } })
    assert.deepStrictEqual(where(yield* config.validate(project)), [[file, LEVEL]])
    const error = yield* Effect.flip(config.load({ projectPath: project }))
    assert.deepStrictEqual([error.file, error.pointer], [file, LEVEL])
  }),
)

it.effect('names the environment variable that carries a bad value', () =>
  Effect.gen(function* namesVariable() {
    const { config, project } = yield* workspace()
    write(project, PROJECT_FILE, { logging: { level: 'info' } })
    const env = { BYTEBUREAU_LOG_LEVEL: 'loud' }
    const error = yield* Effect.flip(config.load({ projectPath: project, env }))
    assert.deepStrictEqual([error.file, error.pointer], ['env:BYTEBUREAU_LOG_LEVEL', LEVEL])
  }),
)

it.effect('names the flag that carries a bad value', () =>
  Effect.gen(function* namesFlag() {
    const { config, project } = yield* workspace()
    const env = { BYTEBUREAU_LOG_LEVEL: 'error' }
    const flags = { logLevel: 'loud' }
    const error = yield* Effect.flip(config.load({ projectPath: project, env, flags }))
    assert.deepStrictEqual([error.file, error.pointer], ['flag:logLevel', LEVEL])
  }),
)

it.effect('lists every issue with the layer it comes from', () =>
  Effect.gen(function* listsLayers() {
    const { config, project } = yield* workspace()
    const file = write(project, PROJECT_FILE, { extra: true })
    const env = { BYTEBUREAU_LOG_LEVEL: 'loud' }
    const error = yield* Effect.flip(config.load({ projectPath: project, env }))
    assert.include(error.reason, `${file}/extra: `)
    assert.include(error.reason, 'env:BYTEBUREAU_LOG_LEVEL/logging/level: ')
  }),
)

it.effect('names the highest file that holds the parent of a missing key', () =>
  Effect.gen(function* namesParentFile() {
    const { config, project } = yield* workspace()
    const file = write(project, PROJECT_FILE, {
      employees: { dev: { name: 'Dev', provider: 'f' } },
    })
    write(project, LOCAL_FILE, { logging: { level: 'debug' } })
    const apart = yield* config.validate(project)
    assert.deepStrictEqual(apart.map((issue) => issue.pointer).toSorted(), [
      '/employees/dev/model',
      '/employees/dev/permissionMode',
    ])
    assert.isTrue(apart.every((issue) => issue.file === file))
    const local = write(project, LOCAL_FILE, { employees: { dev: { model: 'm' } } })
    const shared = where(yield* config.validate(project))
    assert.deepStrictEqual(shared, [[local, '/employees/dev/permissionMode']])
  }),
)

it.effect('names the user file for a bad user value when there are no project files', () =>
  Effect.gen(function* namesUserFile() {
    const { config, home, project } = yield* workspace()
    const userFile = write(home, USER_FILE, { logging: { level: 'loud' } })
    assert.deepStrictEqual(where(yield* config.validate(project)), [[userFile, LEVEL]])
    const error = yield* Effect.flip(config.load({ projectPath: project }))
    assert.deepStrictEqual([error.file, error.pointer], [userFile, LEVEL])
  }),
)

it.effect('reports an unknown user key with its pointer, in the load and in the validation', () =>
  Effect.gen(function* reportsUserPointer() {
    const { config, home, project } = yield* workspace()
    const userFile = write(home, USER_FILE, { locael: 'cs' })
    assert.deepStrictEqual(where(yield* config.validate(project)), [[userFile, '/locael']])
    const error = yield* Effect.flip(config.load({ projectPath: project }))
    assert.instanceOf(error, ConfigError)
    assert.deepStrictEqual([error.file, error.pointer], [userFile, '/locael'])
    assert.include(error.reason, `${userFile}/locael: `)
  }),
)

it.effect('validates a broken user file even when a project file overrides its section', () =>
  Effect.gen(function* validatesUserFile() {
    const { config, home, project } = yield* workspace()
    const userFile = write(home, USER_FILE, { logging: { level: 'loud' } })
    write(project, PROJECT_FILE, { logging: { level: 'info' } })
    assert.deepStrictEqual(where(yield* config.validate(project)), [[userFile, LEVEL]])
    const failure = yield* Effect.result(config.load({ projectPath: project }))
    assert.isTrue(Result.isFailure(failure))
  }),
)

it.effect('validates a null section and a $meta key like any other value', () =>
  Effect.gen(function* reportsNullAndMeta() {
    const { config, project } = yield* workspace()
    const file = write(project, PROJECT_FILE, { logging: null, $meta: {} })
    const issues = yield* config.validate(project)
    assert.deepStrictEqual(issues.map((issue) => issue.pointer).toSorted(), ['/$meta', '/logging'])
    assert.isTrue(issues.every((issue) => issue.file === file))
  }),
)

it.effect('reports extends with a preset path as an unknown key', () =>
  Effect.gen(function* rejectsExtends() {
    const { config, project } = yield* workspace()
    write(project, 'base.json', { workspace: { copyIgnored: ['.a'] } })
    const file = write(project, PROJECT_FILE, { extends: './base.json', project: { name: 'x' } })
    assert.deepStrictEqual(where(yield* config.validate(project)), [[file, '/extends']])
  }),
)

it.effect('reports extends with a remote source as an unknown key', () =>
  Effect.gen(function* rejectsRemoteExtends() {
    const { config, project } = yield* workspace()
    const file = write(project, PROJECT_FILE, { extends: 'http://127.0.0.1:9/preset' })
    assert.deepStrictEqual(where(yield* config.validate(project)), [[file, '/extends']])
  }),
)

it.effect('loads the init template back as the default project configuration', () =>
  Effect.gen(function* loadsTemplate() {
    const { config, project } = yield* workspace()
    write(project, PROJECT_JSONC, defaultProjectConfigText())
    const resolved = yield* config.load({ projectPath: project })
    assert.deepStrictEqual(resolved.project, { $schema: SCHEMA_URL, ...defaultProjectConfig })
    assert.deepStrictEqual(yield* config.validate(project), [])
  }),
)

it.effect('decodes the init template on its own, with no defaults merged in', () =>
  Effect.sync(() => {
    const errors: ParseError[] = []
    const parsed: unknown = parse(defaultProjectConfigText(), errors, { allowTrailingComma: true })
    assert.deepStrictEqual(errors, [])
    assert.deepStrictEqual(decodeProjectConfig(parsed), {
      $schema: SCHEMA_URL,
      ...defaultProjectConfig,
    })
  }),
)
```
`packages/kernel/src/config/config.files.test.ts`:
```ts
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ConfigError } from '../errors.js'
import { PROJECT_FILE, PROJECT_JSONC, workspace, write } from './config-fixtures.js'

const BOM = '\uFEFF'
const SCRIPTS = ['payload.mjs', 'payload.ts'] as const

const NON_OBJECT_ROOTS = [
  [PROJECT_FILE, '[1, 2]'],
  [PROJECT_FILE, 'null'],
  [PROJECT_FILE, '42'],
  [PROJECT_FILE, '"text"'],
  [PROJECT_FILE, 'true'],
  [PROJECT_FILE, ''],
  [PROJECT_JSONC, '// a comment in front\nnull'],
  [PROJECT_JSONC, '/* empty */ []'],
  [PROJECT_JSONC, '// only a comment\n'],
] as const

// A script that writes a marker file when it runs and names a project when it is loaded as configuration
const payload = (marker: string): string => `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(marker)}, '')
export default { project: { name: 'from-script' } }
`

// A link named like the project file that points at such a script
function linkedScript(project: string, name: string): { marker: string; link: string } {
  const marker = path.join(project, 'ran')
  const target = write(project, name, payload(marker))
  const link = path.join(project, PROJECT_FILE)
  symlinkSync(target, link)
  return { marker, link }
}

it.effect('reads comments and trailing commas in a .jsonc file', () =>
  Effect.gen(function* readsJsonc() {
    const { config, project } = yield* workspace()
    write(
      project,
      PROJECT_JSONC,
      `{
  // a line comment
  "project": { "name": "commented", /* an inline comment */ },
  "logging": { "level": "warn", },
}`,
    )
    const resolved = yield* config.load({ projectPath: project })
    assert.strictEqual(resolved.project.project.name, 'commented')
    assert.deepStrictEqual(resolved.project.logging, { level: 'warn' })
  }),
)

it.effect('reads comments and trailing commas in a .json file too', () =>
  Effect.gen(function* readsCommentedJson() {
    const { config, project } = yield* workspace()
    write(project, PROJECT_FILE, '{ "project": { "name": "plain", }, // note\n}')
    const resolved = yield* config.load({ projectPath: project })
    assert.strictEqual(resolved.project.project.name, 'plain')
  }),
)

it.effect('reads files that start with a byte order mark', () =>
  Effect.gen(function* readsBom() {
    for (const name of [PROJECT_FILE, PROJECT_JSONC]) {
      const { config, project } = yield* workspace()
      write(project, name, `${BOM}${JSON.stringify({ project: { name: 'bom' } })}`)
      const resolved = yield* config.load({ projectPath: project })
      assert.strictEqual(resolved.project.project.name, 'bom')
    }
  }),
)

it.effect('ignores a file named like the config but without an extension', () =>
  Effect.gen(function* ignoresBareName() {
    const { config, project } = yield* workspace()
    // A release binary downloaded into the project directory carries exactly this name
    write(project, 'bytebureau', '#!/bin/sh\nexit 0\n')
    const file = write(project, PROJECT_FILE, { project: { name: 'beside' } })
    const resolved = yield* config.load({ projectPath: project })
    assert.strictEqual(resolved.project.project.name, 'beside')
    assert.strictEqual(resolved.files.project, file)
  }),
)

it.effect('never runs a script named like the config', () =>
  Effect.gen(function* ignoresScripts() {
    const { config, project } = yield* workspace()
    const marker = path.join(project, 'ran')
    write(project, 'bytebureau.mjs', payload(marker))
    const file = write(project, PROJECT_FILE, { project: { name: 'from-json' } })
    const resolved = yield* config.load({ projectPath: project })
    assert.strictEqual(resolved.project.project.name, 'from-json')
    assert.strictEqual(resolved.files.project, file)
    assert.isFalse(existsSync(marker))
  }),
)

it.effect('never runs the target of a link named like the config', () =>
  Effect.gen(function* ignoresLinkedScripts() {
    for (const name of SCRIPTS) {
      const { config, project } = yield* workspace()
      const { marker, link } = linkedScript(project, name)
      const issues = yield* config.validate(project)
      assert.deepStrictEqual(
        issues.map((issue) => issue.file),
        [link],
      )
      const error = yield* Effect.flip(config.load({ projectPath: project }))
      assert.strictEqual(error.file, link)
      assert.isFalse(existsSync(marker))
    }
  }),
)

it.effect('follows a link named like the config to a regular JSON file', () =>
  Effect.gen(function* followsLink() {
    const { config, project } = yield* workspace()
    const target = write(project, 'shared.json', { project: { name: 'linked' } })
    const link = path.join(project, PROJECT_FILE)
    symlinkSync(target, link)
    const resolved = yield* config.load({ projectPath: project })
    assert.strictEqual(resolved.project.project.name, 'linked')
    assert.strictEqual(resolved.files.project, link)
  }),
)

it.effect('fails for a link named like the config whose target does not exist', () =>
  Effect.gen(function* rejectsDanglingLink() {
    const { config, project } = yield* workspace()
    const link = path.join(project, PROJECT_FILE)
    symlinkSync(path.join(project, 'missing.json'), link)
    const error = yield* Effect.flip(config.load({ projectPath: project }))
    assert.deepStrictEqual(
      { file: error.file, pointer: error.pointer },
      { file: link, pointer: '' },
    )
    assert.include(error.reason, 'target does not exist')
    const issues = yield* config.validate(project)
    assert.deepStrictEqual(issues, [{ file: link, pointer: '', message: error.reason }])
  }),
)

it.effect('ignores a directory named like the config file', () =>
  Effect.gen(function* ignoresDirectory() {
    const { config, project } = yield* workspace()
    mkdirSync(path.join(project, PROJECT_FILE))
    const without = yield* config.load({ projectPath: project })
    assert.strictEqual(without.files.project, null)
    const file = write(project, PROJECT_JSONC, { project: { name: 'beside' } })
    const withFile = yield* config.load({ projectPath: project })
    assert.strictEqual(withFile.files.project, file)
  }),
)

it.effect('refuses a name that exists as both .json and .jsonc', () =>
  Effect.gen(function* refusesBothVariants() {
    const { config, project } = yield* workspace()
    const json = write(project, PROJECT_FILE, {})
    const jsonc = write(project, PROJECT_JSONC, {})
    const error = yield* Effect.flip(config.load({ projectPath: project }))
    assert.deepStrictEqual(
      { file: error.file, pointer: error.pointer },
      { file: json, pointer: '' },
    )
    assert.include(error.reason, json)
    assert.include(error.reason, jsonc)
    const issues = yield* config.validate(project)
    assert.deepStrictEqual(issues, [{ file: json, pointer: '', message: error.reason }])
  }),
)

it.effect('fails for a project path that does not exist or is not a directory', () =>
  Effect.gen(function* rejectsProjectPath() {
    const { config, project } = yield* workspace()
    const missing = path.join(project, 'missing')
    const plain = write(project, 'plain-file', 'text')
    for (const [target, reason] of [
      [missing, 'does not exist'],
      [plain, 'not a directory'],
    ] as const) {
      const error = yield* Effect.flip(config.load({ projectPath: target }))
      assert.instanceOf(error, ConfigError)
      assert.deepStrictEqual(
        { file: error.file, pointer: error.pointer },
        { file: target, pointer: '' },
      )
      assert.include(error.reason, reason)
      const issues = yield* config.validate(target)
      assert.deepStrictEqual(issues, [{ file: target, pointer: '', message: error.reason }])
    }
  }),
)

it.effect('reports a file that cannot be parsed as one issue instead of an empty document', () =>
  Effect.gen(function* reportsBrokenSyntax() {
    const { config, project } = yield* workspace()
    const file = write(project, PROJECT_FILE, '{ "version": 1,')
    const issues = yield* config.validate(project)
    assert.deepStrictEqual(
      issues.map((issue) => issue.file),
      [file],
    )
    const error = yield* Effect.flip(config.load({ projectPath: project }))
    assert.strictEqual(error.file, file)
  }),
)

it.effect('names the error, the line and the column of a syntax error', () =>
  Effect.gen(function* namesSyntaxPosition() {
    const { config, project } = yield* workspace()
    const file = write(project, PROJECT_FILE, '{"a": }')
    const single = yield* Effect.flip(config.load({ projectPath: project }))
    assert.deepStrictEqual([single.file, single.pointer], [file, ''])
    assert.strictEqual(single.reason, 'ValueExpected at line 1, column 7')
    write(project, PROJECT_FILE, '{\n  "a": }')
    const spread = yield* Effect.flip(config.load({ projectPath: project }))
    assert.strictEqual(spread.reason, 'ValueExpected at line 2, column 8')
  }),
)

it.effect('reports an array, null, scalar or empty root as one issue at the root of its file', () =>
  Effect.gen(function* rejectsRoots() {
    for (const [name, text] of NON_OBJECT_ROOTS) {
      const { config, project } = yield* workspace()
      const file = write(project, name, text)
      const issues = yield* config.validate(project)
      assert.deepStrictEqual(issues, [{ file, pointer: '', message: 'expected a JSON object' }])
      const error = yield* Effect.flip(config.load({ projectPath: project }))
      assert.deepStrictEqual(
        [error.file, error.pointer, error.reason],
        [file, '', 'expected a JSON object'],
      )
    }
  }),
)

// Every "/* " opens a comment that never closes; rescanning the rest of the file per opener takes minutes on a megabyte
it.effect('reports a large unterminated comment as a syntax error without stalling', () =>
  Effect.gen(function* rejectsLargeComment() {
    const { config, project } = yield* workspace()
    const file = write(project, PROJECT_FILE, `{} ${'/* '.repeat(350_000)}`)
    const issues = yield* config.validate(project)
    const message = 'UnexpectedEndOfComment at line 1, column 4'
    assert.deepStrictEqual(issues, [{ file, pointer: '', message }])
  }),
)

// The parser recurses; far beyond any real document its stack runs out, and that must stay an issue, not a crash
it.effect('reports a document nested beyond the parser as one issue', () =>
  Effect.gen(function* rejectsDeepNesting() {
    const { config, project } = yield* workspace()
    const file = write(project, PROJECT_FILE, `${'{"a":'.repeat(100_000)}1${'}'.repeat(100_000)}`)
    const issues = yield* config.validate(project)
    assert.deepStrictEqual(
      issues.map((issue) => issue.file),
      [file],
    )
    assert.include(issues.map((issue) => issue.message).join('; '), 'RangeError')
  }),
)
```
Run: `bunx vitest run --project kernel` → FAIL.

- [ ] **Step 2: Implementation**

`packages/kernel/src/config/merge.ts`:
```ts
export type Plain = Record<string, unknown>

// One source of configuration: the defaults, a file, an environment variable or a flag
export interface ConfigLayer {
  readonly label: string
  readonly config: Plain
  readonly fromFile: boolean
}

export const isPlain = (value: unknown): value is Plain =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const sectionOf = (value: unknown): Plain => (isPlain(value) ? value : {})

// Deep merge where the overlay wins; arrays and scalars replace, undefined is skipped at every depth
export function mergeConfig(base: Plain, overlay: Plain): Plain {
  const result: Plain = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== undefined) {
      result[key] = isPlain(value) ? mergeConfig(sectionOf(result[key]), value) : value
    }
  }
  return result
}

// Lowest priority first
export function mergeLayers(layers: readonly ConfigLayer[]): Plain {
  let merged: Plain = {}
  for (const layer of layers) {
    merged = mergeConfig(merged, layer.config)
  }
  return merged
}
```
`packages/kernel/src/config/env-overrides.ts`:
```ts
import type { ConfigLayer, Plain } from './merge.js'

// Explicit map: environment variable → config path (dotted); extend deliberately, never generically
const ENV_MAP: readonly (readonly [string, string])[] = [
  ['BYTEBUREAU_LOG_LEVEL', 'logging.level'],
  ['BYTEBUREAU_EMPLOYEE', 'defaults.employee'],
  ['BYTEBUREAU_BRANCH', 'defaults.branch'],
  ['BYTEBUREAU_WORKSPACE_RUNTIME', 'workspace.runtime'],
]

// 'logging.level' and 'info' make { logging: { level: 'info' } }
function nest(dotted: string, value: string): Plain {
  const keys = dotted.split('.')
  const result: Plain = {}
  let cursor = result
  for (const key of keys.slice(0, -1)) {
    const section: Plain = {}
    cursor[key] = section
    cursor = section
  }
  cursor[keys.at(-1) ?? ''] = value
  return result
}

// One layer per variable that is set, so an issue can name the variable it comes from
export function envOverrides(
  env: Readonly<Record<string, string | undefined>>,
): readonly ConfigLayer[] {
  return ENV_MAP.flatMap(([name, dotted]) => {
    const value = env[name]
    if (value === undefined || value === '') {
      return []
    }
    return [{ label: `env:${name}`, config: nest(dotted, value), fromFile: false }]
  })
}
```
`packages/kernel/src/config/files.ts`:
```ts
import { lstatSync, readFileSync, statSync, type Stats } from 'node:fs'
import path from 'node:path'
import { Effect } from 'effect'
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'
import { ConfigError } from '../errors.js'
import { isPlain, type Plain } from './merge.js'

// Configuration files are data: the kernel reads JSON or JSONC as text and parses it with jsonc-parser, nothing is imported or run
const EXTENSIONS = ['.json', '.jsonc'] as const

const BOM = '\uFEFF'

export interface LoadedFile {
  readonly file: string
  readonly config: Plain
}

type Entry = 'absent' | 'dangling' | 'file' | 'other'

interface Candidate {
  readonly file: string
  readonly entry: Entry
}

const failure = (file: string, reason: string): ConfigError =>
  new ConfigError({ file, pointer: '', reason })

// A link to nowhere shows up in lstat but not in stat; a link to a file is followed and read as text
function entryOf(candidate: string): Entry {
  if (lstatSync(candidate, { throwIfNoEntry: false }) === undefined) {
    return 'absent'
  }
  const stats = statSync(candidate, { throwIfNoEntry: false })
  if (stats === undefined) {
    return 'dangling'
  }
  return stats.isFile() ? 'file' : 'other'
}

const candidatesOf = (directory: string, name: string): readonly Candidate[] =>
  EXTENSIONS.map((extension) => {
    const file = path.resolve(directory, `${name}${extension}`)
    return { file, entry: entryOf(file) }
  })

// At most one regular file; a link to nowhere or both variants is an error
function chooseFile(candidates: readonly Candidate[]): Effect.Effect<string | null, ConfigError> {
  const dangling = candidates.find((candidate) => candidate.entry === 'dangling')
  if (dangling !== undefined) {
    return Effect.fail(failure(dangling.file, 'a symbolic link whose target does not exist'))
  }
  const [first, second] = candidates.filter((candidate) => candidate.entry === 'file')
  if (first !== undefined && second !== undefined) {
    const reason = `${first.file} and ${second.file} both exist; keep one of them`
    return Effect.fail(failure(first.file, reason))
  }
  return Effect.succeed(first === undefined ? null : first.file)
}

// 1-based line and column of an offset
function positionOf(text: string, offset: number): string {
  const before = text.slice(0, offset)
  return `line ${before.split('\n').length}, column ${offset - before.lastIndexOf('\n')}`
}

interface Parsed {
  readonly value: unknown
  readonly errors: readonly ParseError[]
}

function parseText(text: string): Parsed {
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true, allowEmptyContent: true })
  return { value, errors }
}

// The parser recurses, so a pathologically nested file throws instead of returning
function parseConfig(file: string, raw: string): Effect.Effect<Plain, ConfigError> {
  const text = raw.startsWith(BOM) ? raw.slice(BOM.length) : raw
  return Effect.gen(function* parseJson() {
    const { value, errors } = yield* Effect.try({
      try: () => parseText(text),
      catch: (cause) => failure(file, String(cause)),
    })
    const [first] = errors
    if (first !== undefined) {
      const position = positionOf(text, first.offset)
      return yield* failure(file, `${printParseErrorCode(first.error)} at ${position}`)
    }
    return isPlain(value) ? value : yield* failure(file, 'expected a JSON object')
  })
}

const loadFile = (file: string): Effect.Effect<LoadedFile, ConfigError> =>
  Effect.gen(function* loadJson() {
    const text = yield* Effect.try({
      try: () => readFileSync(file, 'utf8'),
      catch: (cause) => failure(file, String(cause)),
    })
    const config = yield* parseConfig(file, text)
    return { file, config }
  })

// `<name>.json` or `<name>.jsonc` in the directory, read as text and parsed with jsonc-parser; null when neither exists
export const readLayer = (
  directory: string,
  name: string,
): Effect.Effect<LoadedFile | null, ConfigError> =>
  Effect.gen(function* readJsonLayer() {
    const candidates = yield* Effect.try({
      try: () => candidatesOf(directory, name),
      catch: (cause) => failure(directory, String(cause)),
    })
    const file = yield* chooseFile(candidates)
    return file === null ? null : yield* loadFile(file)
  })

const directoryProblem = (stats: Stats | undefined): string | null => {
  if (stats === undefined) {
    return 'the project path does not exist'
  }
  return stats.isDirectory() ? null : 'the project path is not a directory'
}

export const requireDirectory = (directory: string): Effect.Effect<void, ConfigError> =>
  Effect.try({
    try: () => statSync(directory, { throwIfNoEntry: false }),
    catch: (cause) => failure(directory, String(cause)),
  }).pipe(
    Effect.flatMap((stats) => {
      const problem = directoryProblem(stats)
      return problem === null ? Effect.void : Effect.fail(failure(directory, problem))
    }),
  )
```
`packages/kernel/src/config/issues.ts`:
```ts
import { ProjectConfig, UserConfig } from '@bytebureau/protocol'
import { Effect, Schema } from 'effect'
import type { StandardSchemaV1 } from 'effect/StandardSchema'
import { ConfigError } from '../errors.js'
import type { ConfigLayer, Plain } from './merge.js'

export interface ConfigIssue {
  readonly file: string
  readonly pointer: string
  readonly message: string
}

interface Checked<Value> {
  readonly value: Value | undefined
  readonly issues: readonly ConfigIssue[]
}

const STRICT = { onExcessProperty: 'error', errors: 'all' } as const

// The copies keep protocol's schemas clean: toStandardSchemaV1 attaches ~standard to the schema it receives
const projectStandard = Schema.toStandardSchemaV1(ProjectConfig.annotate({}), {
  parseOptions: STRICT,
})
const userStandard = Schema.toStandardSchemaV1(UserConfig.annotate({}), { parseOptions: STRICT })

const escapeSegment = (segment: string): string =>
  segment.replaceAll('~', '~0').replaceAll('/', '~1')

// RFC 6901: the document itself is the empty pointer
const pointerOf = (keys: readonly PropertyKey[]): string =>
  keys.map((key) => `/${escapeSegment(String(key))}`).join('')

function containsPath(root: unknown, keys: readonly PropertyKey[]): boolean {
  let cursor = root
  for (const key of keys) {
    if (typeof cursor !== 'object' || cursor === null || !Object.hasOwn(cursor, key)) {
      return false
    }
    cursor = Reflect.get(cursor, key)
  }
  return cursor !== undefined
}

// The highest layer that holds the value; a missing key has none, so the files that hold its parent decide
function labelOf(
  layers: readonly ConfigLayer[],
  keys: readonly PropertyKey[],
  fallback: string,
): string {
  const owner = layers.findLast((layer) => containsPath(layer.config, keys))
  if (owner !== undefined) {
    return owner.label
  }
  const parent = keys.slice(0, -1)
  const holder = layers.findLast((layer) => layer.fromFile && containsPath(layer.config, parent))
  return holder === undefined ? fallback : holder.label
}

const validated = <Value>(
  standard: StandardSchemaV1<unknown, Value>,
  input: Plain,
  attribute: (keys: readonly PropertyKey[]) => string,
): Effect.Effect<Checked<Value>> =>
  Effect.promise(async () => {
    const result = await standard['~standard'].validate(input)
    if (result.issues === undefined) {
      return { value: result.value, issues: [] }
    }
    const issues = result.issues.map((issue) => {
      const keys = (issue.path ?? []).map((segment) =>
        typeof segment === 'object' ? segment.key : segment,
      )
      return { file: attribute(keys), pointer: pointerOf(keys), message: issue.message }
    })
    return { value: undefined, issues }
  })

// Layers run lowest first; a missing key without a file holding its parent goes to the fallback
export const checkProject = (
  merged: Plain,
  layers: readonly ConfigLayer[],
  fallback: string,
): Effect.Effect<Checked<ProjectConfig>> =>
  validated(projectStandard, merged, (keys) => labelOf(layers, keys, fallback))

export const checkUser = (user: Plain, file: string): Effect.Effect<Checked<UserConfig>> =>
  validated(userStandard, user, () => file)

// The logging section of the user file is checked twice, as the user file and as part of the project
export function distinct(issues: readonly ConfigIssue[]): readonly ConfigIssue[] {
  const unique = new Map(
    issues.map(
      (issue) => [JSON.stringify([issue.file, issue.pointer, issue.message]), issue] as const,
    ),
  )
  return [...unique.values()]
}

// The first issue names the file and the pointer; the reason lists every issue
export function configErrorOf(issues: readonly ConfigIssue[]): ConfigError {
  const [first] = issues
  const { file, pointer } = first ?? { file: '', pointer: '' }
  const reason = issues.map((issue) => `${issue.file}${issue.pointer}: ${issue.message}`).join('; ')
  return new ConfigError({ file, pointer, reason })
}
```
`packages/kernel/src/config/config.ts`:
```ts
import path from 'node:path'
import {
  configJsonSchema,
  defaultProjectConfig,
  type ProjectConfig,
  type UserConfig,
} from '@bytebureau/protocol'
import { Context, Effect, Layer } from 'effect'
import type { ConfigError } from '../errors.js'
import { envOverrides } from './env-overrides.js'
import { readLayer, requireDirectory, type LoadedFile } from './files.js'
import { checkProject, checkUser, configErrorOf, distinct, type ConfigIssue } from './issues.js'
import { mergeLayers, type ConfigLayer, type Plain } from './merge.js'

export type { ConfigIssue } from './issues.js'

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

export interface ResolvedConfig {
  readonly project: ProjectConfig
  readonly user: UserConfig
  readonly projectPath: string | null
  readonly files: {
    readonly user: string | null
    readonly project: string | null
    readonly local: string | null
  }
}

export interface ConfigShape {
  readonly load: (request: LoadRequest) => Effect.Effect<ResolvedConfig, ConfigError>
  readonly validate: (projectPath: string) => Effect.Effect<readonly ConfigIssue[]>
  readonly schema: () => Record<string, unknown>
}

export class Config extends Context.Service<Config, ConfigShape>()('bb/Config') {}

const FLAG_PATHS = [
  ['logLevel', 'logging', 'level'],
  ['employee', 'defaults', 'employee'],
  ['branch', 'defaults', 'branch'],
] as const

// One layer per flag that is set, so an issue can name the flag it comes from
const flagLayers = (flags: FlagOverrides): readonly ConfigLayer[] =>
  FLAG_PATHS.flatMap(([flag, section, key]) => {
    const value = flags[flag]
    return value === undefined
      ? []
      : [{ label: `flag:${flag}`, config: { [section]: { [key]: value } }, fromFile: false }]
  })

const defaultsLayer = (projectPath: string | null): ConfigLayer => {
  const defaults = structuredClone(defaultProjectConfig)
  const name = projectPath === null ? 'default' : path.basename(projectPath)
  return {
    label: '(defaults)',
    config: { ...defaults, project: { ...defaults.project, name } },
    fromFile: false,
  }
}

const whole = (config: Plain): Plain => config

// Only the sections user and project configuration share take part in the project layering
const sharedWithProject = (user: Plain): Plain =>
  user['logging'] === undefined ? {} : { logging: user['logging'] }

const fileLayer = (
  loaded: LoadedFile | null,
  section: (config: Plain) => Plain,
): readonly ConfigLayer[] =>
  loaded === null ? [] : [{ label: loaded.file, config: section(loaded.config), fromFile: true }]

const fileOf = (loaded: LoadedFile | null): string | null => (loaded === null ? null : loaded.file)

interface Assembled {
  readonly layers: readonly ConfigLayer[]
  readonly user: Plain
  readonly projectPath: string | null
  readonly files: ResolvedConfig['files']
}

// Lowest priority first: defaults, user, project, local, environment, flags
const assemble = (home: string, request: LoadRequest): Effect.Effect<Assembled, ConfigError> =>
  Effect.gen(function* assembleLayers() {
    const projectPath = request.projectPath === undefined ? null : path.resolve(request.projectPath)
    if (projectPath !== null) {
      yield* requireDirectory(projectPath)
    }
    const user = yield* readLayer(home, 'config')
    const project = projectPath === null ? null : yield* readLayer(projectPath, 'bytebureau')
    const local = projectPath === null ? null : yield* readLayer(projectPath, 'bytebureau.local')
    const layers = [
      defaultsLayer(projectPath),
      ...fileLayer(user, sharedWithProject),
      ...fileLayer(project, whole),
      ...fileLayer(local, whole),
      ...envOverrides(request.env ?? {}),
      ...flagLayers(request.flags ?? {}),
    ]
    const files = { user: fileOf(user), project: fileOf(project), local: fileOf(local) }
    return { layers, user: user === null ? {} : user.config, projectPath, files }
  })

interface Inspected {
  readonly projectPath: string | null
  readonly files: ResolvedConfig['files']
  readonly user: UserConfig | undefined
  readonly project: ProjectConfig | undefined
  readonly issues: readonly ConfigIssue[]
}

// The user file is checked against its own schema, the layers merged against the project schema
const inspect = (home: string, request: LoadRequest): Effect.Effect<Inspected, ConfigError> =>
  Effect.gen(function* inspectLayers() {
    const { layers, user, projectPath, files } = yield* assemble(home, request)
    const checkedUser = yield* checkUser(user, files.user ?? path.join(home, 'config.json'))
    const fallback = files.project ?? '(defaults)'
    const checkedProject = yield* checkProject(mergeLayers(layers), layers, fallback)
    const issues = distinct([...checkedUser.issues, ...checkedProject.issues])
    return {
      projectPath,
      files,
      user: checkedUser.value,
      project: checkedProject.value,
      issues,
    }
  })

const resolveConfig = (
  home: string,
  request: LoadRequest,
): Effect.Effect<ResolvedConfig, ConfigError> =>
  Effect.gen(function* resolveLayers() {
    const { projectPath, files, user, project, issues } = yield* inspect(home, request)
    if (user === undefined || project === undefined) {
      return yield* configErrorOf(issues)
    }
    return { project, user, projectPath, files }
  })

// A file that cannot be read or parsed is one issue, not an empty document blamed for missing keys
const validateConfig = (home: string, projectPath: string): Effect.Effect<readonly ConfigIssue[]> =>
  inspect(home, { projectPath }).pipe(
    Effect.map((inspected) => inspected.issues),
    Effect.catchTag('ConfigError', (failure) =>
      Effect.succeed([{ file: failure.file, pointer: failure.pointer, message: failure.reason }]),
    ),
  )

const make = (home: string): ConfigShape => ({
  load: (request) => resolveConfig(home, request),
  validate: (projectPath) => validateConfig(home, projectPath),
  schema: configJsonSchema,
})

export const ConfigLive = (home: string): Layer.Layer<Config> =>
  Layer.succeed(Config, Config.of(make(home)))
```
The issue `path` segments from Standard Schema are `PropertyKey | { key: PropertyKey }`; pointers follow RFC 6901 (`~0`, `~1` escapes). `files.ts` and `issues.ts` were split out of `config.ts` (`max-lines` 300); `config-fixtures.ts` holds the temp-directory helpers shared by the two test files.

`packages/kernel/src/config/template.ts`:
```ts
import { defaultProjectConfig } from '@bytebureau/protocol'

// Commented JSONC for `bytebureau config init`; comments are the documentation
export function defaultProjectConfigText(): string {
  const employee = JSON.stringify(
    defaultProjectConfig.employees['developer'],
    undefined,
    2,
  ).replaceAll('\n', '\n    ')
  return `{
  "$schema": "https://bytebureau.dev/schema/v1/config.json",
  "version": 1,
  // Project identity; defaultBranch (optional) overrides the detected default branch: origin/HEAD, else main
  "project": { "name": ${JSON.stringify(defaultProjectConfig.project.name)} },
  // Worktrees live under .bytebureau/worktrees; copyIgnored files are copied from the main checkout
  "workspace": { "runtime": "local", "copyIgnored": [".env", ".env.local"], "retainDays": 7 },
  "providers": { "claude": { "executable": "claude", "settingSources": ["user", "project", "local"] } },
  // Employees: one entry per role; prompt points at a Markdown file with the system prompt
  "employees": {
    "developer": ${employee}
  },
  // branch (optional) is the base of session worktrees; it defaults to the project's default branch
  "defaults": { "employee": "developer" },
  "plugins": [],
  "logging": { "level": "info" }
}
`
}
```
Add to `index.ts`: `export { Config, ConfigLive, type ConfigShape, type LoadRequest, type FlagOverrides, type ResolvedConfig, type ConfigIssue } from './config/config.js'`, `export { mergeConfig } from './config/merge.js'`, `export { defaultProjectConfigText } from './config/template.js'`.

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

Semantics: durable events get the next `seq` from SQLite (`RETURNING seq`) and `seq` is monotonic across the process; ephemeral events carry `seq: 0`, are never persisted and are delivered only to live subscribers. `subscribe` takes the hub subscription explicitly (`PubSub.subscribe` inside `Stream.unwrap`) before the replay read, replays rows with `seq > since`, then forwards live envelopes whose `seq` is greater than the replay watermark (ephemeral always pass), so a subscriber sees no gap and no duplicate. As shipped: the watermark is the static last replayed `seq` (a moving one would drop a late lower-`seq` event from a concurrent publisher, so live delivery is complete but not ordered under concurrency — consumers order by `seq`); `read` narrows with `sql.and` so the `(session_id, seq)`/`(project_id, seq)` indexes are used; a missing `RETURNING` row fails the publish; the hub is never shut down (Task 14 adds the finalizer).

- [ ] **Step 1: Failing tests**

`packages/kernel/src/events/event-log.test.ts`:
```ts
import type { EventEnvelope, KernelEvent } from '@bytebureau/protocol'
import { assert, describe, expect, it } from '@effect/vitest'
import { Effect, Fiber, Latch, Layer, Stream } from 'effect'
import { SqlClient } from 'effect/sql'
import { StoreError } from '../errors.js'
import { StoreTest } from '../store/store-test.js'
import {
  EventLog,
  EventLogLive,
  matches,
  type EventFilter,
  type EventLogShape,
} from './event-log.js'

const TestLayer = EventLogLive.pipe(Layer.provideMerge(StoreTest))

const created = (sessionId: string): KernelEvent => ({
  type: 'session.created',
  sessionId,
  payload: { status: 'created', title: 'Fix the build', employeeId: 'dev', providerId: 'fake' },
})

const provisioning = (sessionId: string): KernelEvent => ({
  type: 'session.provisioning',
  sessionId,
  payload: { status: 'provisioning' },
})

const ready = (sessionId: string): KernelEvent => ({
  type: 'session.ready',
  sessionId,
  payload: { status: 'ready' },
})

const delta = (sessionId: string, text: string): KernelEvent => ({
  type: 'message.assistant.delta',
  sessionId,
  payload: { kind: 'text', text },
})

// The subscriber has subscribed and replayed up to its first wait when this returns
const collect = (
  log: EventLogShape,
  filter: EventFilter,
  count: number,
): Effect.Effect<Fiber.Fiber<EventEnvelope[], StoreError>> =>
  Effect.forkChild(log.subscribe(filter).pipe(Stream.take(count), Stream.runCollect), {
    startImmediately: true,
  })

describe(matches, () => {
  const envelope: EventEnvelope = {
    seq: 1,
    id: 'x',
    ts: 't',
    type: 'tool.started',
    sessionId: 's',
    projectId: 'p',
    payload: {},
  }

  it('filters by session, project and type', () => {
    expect(matches({ sessionId: 's' }, envelope)).toBe(true)
    expect(matches({ types: ['tool.started'] }, envelope)).toBe(true)
    expect(matches({ projectId: 'other' }, envelope)).toBe(false)
    expect(matches({ sessionId: 'other' }, envelope)).toBe(false)
    expect(matches({ types: ['tool.completed'] }, envelope)).toBe(false)
  })

  it('lets every envelope through an empty filter', () => {
    expect(matches({}, envelope)).toBe(true)
    expect(matches({ projectId: 'p', sessionId: 's', types: ['tool.started'] }, envelope)).toBe(
      true,
    )
  })

  it('rejects ephemeral envelopes only when ephemeral is false', () => {
    const live: EventEnvelope = { ...envelope, seq: 0, type: 'heartbeat' }
    expect(matches({ ephemeral: false }, live)).toBe(false)
    expect(matches({ ephemeral: true }, live)).toBe(true)
    expect(matches({}, live)).toBe(true)
    expect(matches({ ephemeral: false }, envelope)).toBe(true)
  })
})

it.layer(TestLayer)('EventLog publish', (suite) => {
  suite.effect('assigns increasing seq to durable events and none to ephemeral ones', () =>
    Effect.gen(function* assignsSeq() {
      const log = yield* EventLog
      const first = yield* log.publish(created('s1'))
      const chunk = yield* log.publish(delta('s1', 'x'))
      const second = yield* log.publish(ready('s1'))
      assert.ok(first.seq > 0)
      assert.ok(second.seq > first.seq)
      assert.strictEqual(chunk.seq, 0)
      const stored = yield* log.read({ sessionId: 's1' }, { from: 0 })
      assert.deepStrictEqual(
        stored.map((event) => event.type),
        ['session.created', 'session.ready'],
      )
    }),
  )

  suite.effect('stores the envelope as published and omits the ids an event lacks', () =>
    Effect.gen(function* roundTrips() {
      const log = yield* EventLog
      const scoped = yield* log.publish({
        type: 'tool.started',
        projectId: 'p1',
        sessionId: 's2',
        turnId: 't1',
        payload: { id: 'call-1', name: 'Read', kind: 'builtin', input: { path: 'a.ts' } },
      })
      const bare = yield* log.publish({ type: 'profile.removed', payload: { profileId: 'x' } })
      const stored = yield* log.read({}, { from: scoped.seq - 1, to: bare.seq })
      assert.deepStrictEqual(stored, [scoped, bare])
      assert.deepStrictEqual(Object.keys(bare).toSorted(), ['id', 'payload', 'seq', 'ts', 'type'])
    }),
  )
})

it.layer(TestLayer)('EventLog read', (suite) => {
  suite.effect('filters by project and session', () =>
    Effect.gen(function* readsScoped() {
      const log = yield* EventLog
      const first = yield* log.publish({ ...created('s3'), projectId: 'p3' })
      const second = yield* log.publish({ ...created('s3b'), projectId: 'p3' })
      const other = yield* log.publish({ ...created('s4'), projectId: 'p4' })
      assert.deepStrictEqual(yield* log.read({ projectId: 'p3' }, { from: 0 }), [first, second])
      assert.deepStrictEqual(yield* log.read({ projectId: 'p4' }, { from: 0 }), [other])
      assert.deepStrictEqual(yield* log.read({ sessionId: 's3' }, { from: 0 }), [first])
      const both = { projectId: 'p4', sessionId: 's3' }
      assert.deepStrictEqual(yield* log.read(both, { from: 0 }), [])
    }),
  )

  suite.effect('filters by type and keeps to the range, after from and up to to', () =>
    Effect.gen(function* readsRange() {
      const log = yield* EventLog
      const first = yield* log.publish(created('s12'))
      const second = yield* log.publish(provisioning('s12'))
      const third = yield* log.publish(ready('s12'))
      const types = ['session.provisioning', 'session.ready']
      const typed = yield* log.read({ sessionId: 's12', types }, { from: 0 })
      assert.deepStrictEqual(typed, [second, third])
      const window = yield* log.read({ sessionId: 's12' }, { from: first.seq, to: second.seq })
      assert.deepStrictEqual(window, [second])
    }),
  )

  suite.effect('returns nothing when no stored event matches', () =>
    Effect.gen(function* readsNothing() {
      const log = yield* EventLog
      const only = yield* log.publish(created('s5'))
      assert.deepStrictEqual(yield* log.read({ sessionId: 'nobody' }, { from: 0 }), [])
      assert.deepStrictEqual(yield* log.read({ projectId: 'nowhere' }, { from: 0 }), [])
      assert.deepStrictEqual(yield* log.read({ types: ['tool.failed'] }, { from: 0 }), [])
      assert.deepStrictEqual(yield* log.read({ sessionId: 's5' }, { from: only.seq }), [])
    }),
  )
})

it.layer(TestLayer)('EventLog replay and live', (suite) => {
  suite.effect('replays from since and continues live without gaps or duplicates', () =>
    Effect.gen(function* replaysThenLive() {
      const log = yield* EventLog
      const first = yield* log.publish(created('s6'))
      const second = yield* log.publish(provisioning('s6'))
      const collected = yield* collect(log, { sessionId: 's6', since: first.seq }, 3)
      // The subscriber already runs up to its first wait; the two turns are margin
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      const third = yield* log.publish(ready('s6'))
      const fourth = yield* log.publish(delta('s6', 'live'))
      assert.deepStrictEqual(yield* Fiber.join(collected), [second, third, fourth])
      assert.ok(second.seq > first.seq && third.seq > second.seq)
    }),
  )

  suite.effect('keeps what is published while the replay is still being consumed', () =>
    Effect.gen(function* publishesDuringReplay() {
      const log = yield* EventLog
      const first = yield* log.publish(created('s7'))
      const [replaying, resume] = yield* Effect.all([Latch.make(), Latch.make()])
      const hold = Effect.andThen(replaying.open, resume.await)
      const stream = log.subscribe({ sessionId: 's7' }).pipe(Stream.tap(() => hold))
      const collected = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 2)))
      yield* replaying.await
      const second = yield* log.publish(ready('s7'))
      yield* resume.open
      assert.deepStrictEqual(yield* Fiber.join(collected), [first, second])
    }),
  )
})

it.layer(TestLayer)('EventLog overlap', (suite) => {
  suite.effect('delivers an event once when the replay and the live feed both carry it', () =>
    Effect.gen(function* deliversOnce() {
      const [sql, log, commit, replayed] = yield* Effect.all([
        SqlClient.SqlClient,
        EventLog,
        Latch.make(),
        Latch.make(),
      ])
      // The open transaction holds the connection, so the replay query waits for its commit
      const publishing = Effect.andThen(commit.await, log.publish(ready('s8')))
      const writer = yield* Effect.forkChild(sql.withTransaction(publishing), {
        startImmediately: true,
      })
      const stream = log.subscribe({ sessionId: 's8' }).pipe(Stream.tap(() => replayed.open))
      const collected = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 2)), {
        startImmediately: true,
      })
      yield* commit.open
      const second = yield* Fiber.join(writer)
      yield* replayed.await
      const third = yield* log.publish(provisioning('s8'))
      assert.deepStrictEqual(yield* Fiber.join(collected), [second, third])
    }),
  )
})

it.layer(TestLayer)('EventLog live delivery', (suite) => {
  suite.effect('skips live events at or below since', () =>
    Effect.gen(function* skipsBelowSince() {
      const log = yield* EventLog
      const first = yield* log.publish(created('s9'))
      const upToDate = yield* collect(log, { sessionId: 's9', since: first.seq }, 1)
      const ahead = yield* collect(log, { sessionId: 's9', since: first.seq + 100 }, 1)
      const second = yield* log.publish(ready('s9'))
      const chunk = yield* log.publish(delta('s9', 'x'))
      assert.deepStrictEqual(yield* Fiber.join(upToDate), [second])
      assert.deepStrictEqual(yield* Fiber.join(ahead), [chunk])
    }),
  )

  suite.effect('fans ephemeral events out to live subscribers only', () =>
    Effect.gen(function* fansOutEphemeral() {
      const log = yield* EventLog
      yield* log.publish(delta('s10', 'early'))
      const everything = yield* collect(log, { sessionId: 's10' }, 2)
      const durableOnly = yield* collect(log, { sessionId: 's10', ephemeral: false }, 1)
      yield* log.publish(ready('elsewhere'))
      const chunk = yield* log.publish(delta('s10', 'live'))
      const second = yield* log.publish(ready('s10'))
      assert.deepStrictEqual(yield* Fiber.join(everything), [chunk, second])
      assert.deepStrictEqual(yield* Fiber.join(durableOnly), [second])
    }),
  )
})

it.effect('reports a failing statement as a StoreError from publish, read and subscribe', () =>
  Effect.gen(function* failsWithStoreError() {
    const sql = yield* SqlClient.SqlClient
    const log = yield* EventLog
    yield* sql`DROP TABLE events`
    const failures = [
      yield* Effect.flip(log.publish(created('s11'))),
      yield* Effect.flip(log.read({}, { from: 0 })),
      yield* Effect.flip(Stream.runCollect(log.subscribe({}))),
    ]
    for (const failure of failures) {
      assert.instanceOf(failure, StoreError)
    }
  }).pipe(Effect.provide(TestLayer)),
)
```
Under `it.effect` the clock is a `TestClock`; the subscription is started with `Effect.forkChild(…, { startImmediately: true })` and given two turns with `Effect.yieldNow` (a value in Effect 4.0.0, not a call) before the live events are published, so no real sleep is needed; the overlap test holds a transaction open to force a publish during the replay read.

- [ ] **Step 2: Implementation**

`packages/kernel/src/events/event-log.ts`:
```ts
import { type EventEnvelope, isEphemeral, type KernelEvent } from '@bytebureau/protocol'
import { Context, Effect, Layer, PubSub, Stream } from 'effect'
import { SqlClient, type Statement } from 'effect/sql'
import { StoreError } from '../errors.js'
import { nowIso, uuidv7 } from '../ids.js'

export interface EventFilter {
  readonly sessionId?: string | undefined
  readonly projectId?: string | undefined
  readonly types?: readonly string[] | undefined
  readonly since?: number | undefined
  readonly ephemeral?: boolean | undefined
}

interface EventRange {
  readonly from: number
  readonly to?: number
}

export interface EventLogShape {
  readonly publish: (event: KernelEvent) => Effect.Effect<EventEnvelope, StoreError>
  readonly subscribe: (filter: EventFilter) => Stream.Stream<EventEnvelope, StoreError>
  readonly read: (
    filter: EventFilter,
    range: EventRange,
  ) => Effect.Effect<readonly EventEnvelope[], StoreError>
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

// The protocol declares the ids optional keys, so an absent one is left out and never set to undefined
const fromRow = (row: Row): EventEnvelope => ({
  seq: row.seq,
  id: row.id,
  ts: row.ts,
  type: row.type,
  ...(row.project_id === null ? {} : { projectId: row.project_id }),
  ...(row.session_id === null ? {} : { sessionId: row.session_id }),
  ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
  payload: JSON.parse(row.payload_json),
})

const toStoreError = (cause: unknown): StoreError => new StoreError({ cause })

// RETURNING yields the one new row; a missing row fails the publish instead of passing for an ephemeral seq 0
const insertEvent = (
  sql: SqlClient.SqlClient,
  event: KernelEvent,
  stamp: { readonly id: string; readonly ts: string },
): Effect.Effect<number, StoreError> =>
  sql<Pick<Row, 'seq'>>`
    INSERT INTO events (id, ts, type, project_id, session_id, turn_id, payload_json)
    VALUES (${stamp.id}, ${stamp.ts}, ${event.type}, ${event.projectId ?? null}, ${event.sessionId ?? null}, ${event.turnId ?? null}, ${JSON.stringify(event.payload)})
    RETURNING seq`.pipe(
    Effect.flatMap(([row]) => Effect.fromNullishOr(row)),
    Effect.map((row) => row.seq),
    Effect.mapError(toStoreError),
  )

// Session and project narrow the query itself, so the (session_id, seq) and (project_id, seq) indexes serve it
const conditions = (
  sql: SqlClient.SqlClient,
  filter: EventFilter,
  range: EventRange,
): readonly Statement.Fragment[] => [
  sql`seq > ${range.from}`,
  ...(range.to === undefined ? [] : [sql`seq <= ${range.to}`]),
  ...(filter.sessionId === undefined ? [] : [sql`session_id = ${filter.sessionId}`]),
  ...(filter.projectId === undefined ? [] : [sql`project_id = ${filter.projectId}`]),
]

const makeRead =
  (sql: SqlClient.SqlClient): EventLogShape['read'] =>
  (filter, range) =>
    sql<Row>`
      SELECT seq, id, ts, type, project_id, session_id, turn_id, payload_json FROM events
      WHERE ${sql.and(conditions(sql, filter, range))} ORDER BY seq`.pipe(
      Effect.map((rows) =>
        rows.map((row) => fromRow(row)).filter((event) => matches(filter, event)),
      ),
      Effect.mapError(toStoreError),
    )

const makePublish =
  (sql: SqlClient.SqlClient, hub: PubSub.PubSub<EventEnvelope>): EventLogShape['publish'] =>
  (event) =>
    Effect.gen(function* publishEvent() {
      const stamp = { id: uuidv7(), ts: nowIso() }
      const seq = isEphemeral(event.type) ? 0 : yield* insertEvent(sql, event, stamp)
      const envelope: EventEnvelope = {
        seq,
        ...stamp,
        type: event.type,
        ...(event.projectId === undefined ? {} : { projectId: event.projectId }),
        ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        payload: event.payload,
      }
      yield* PubSub.publish(hub, envelope)
      return envelope
    })

// The subscription opens before the replay is read, so nothing published meanwhile is lost
// An event can then arrive twice; the live part drops those the replay already carried
const makeSubscribe =
  (read: EventLogShape['read'], hub: PubSub.PubSub<EventEnvelope>): EventLogShape['subscribe'] =>
  (filter) =>
    Stream.unwrap(
      Effect.gen(function* openSubscription() {
        const subscription = yield* PubSub.subscribe(hub)
        const since = filter.since ?? 0
        const replayed = yield* read(filter, { from: since })
        const last = replayed.at(-1)
        const replayedTo = last === undefined ? since : last.seq
        const live = Stream.fromSubscription(subscription).pipe(
          Stream.filter(
            (event) => matches(filter, event) && (event.seq === 0 || event.seq > replayedTo),
          ),
        )
        return Stream.concat(Stream.fromIterable(replayed), live)
      }),
    )

const make = Effect.gen(function* makeEventLog() {
  const sql = yield* SqlClient.SqlClient
  const hub = yield* PubSub.unbounded<EventEnvelope>()
  const read = makeRead(sql)
  return EventLog.of({ publish: makePublish(sql, hub), subscribe: makeSubscribe(read, hub), read })
})

export const EventLogLive: Layer.Layer<EventLog, never, SqlClient.SqlClient> = Layer.effect(
  EventLog,
  make,
)
```
Verified in Effect 4.0.0: `Stream.fromPubSub` subscribes lazily on the first pull (`Channel.unwrap`), so the shipped code subscribes explicitly first; there is no `Stream.unwrapScoped` — `Stream.unwrap` scopes the inner effect to the stream.

Add to `index.ts`: `export { EventLog, EventLogLive, matches, type EventFilter, type EventLogShape } from './events/event-log.js'`.

- [ ] **Step 3: Run, commit**

Run: `bunx vitest run --project kernel` → PASS. `bun run check` → green.

```bash
git add packages/kernel
git commit -m "feat(kernel): add the durable event log with ephemeral fan-out and gapless replay"
```

### Task 7: `ProjectRegistry` service and git root detection

**Files:**
- Create: `packages/kernel/src/projects/git-root.ts`, `packages/kernel/src/projects/project-registry.ts`, `packages/kernel/src/projects/project-registry-fixtures.ts` (shared test layer; `import/max-dependencies` 10), `packages/kernel/src/projects/git-root.test.ts`, `packages/kernel/src/projects/project-registry.test.ts`, `packages/kernel/src/testing/temp-repo.ts` (kernel-local copy of the Task 9 helper, with `realpathSync` and `onTestFinished` cleanup)
- Modify: `packages/kernel/src/index.ts`; `packages/protocol/src/config.ts` and `packages/kernel/src/config/template.ts` (the default-branch ruling below)

**Interfaces:**
- Consumes: `SqlClient`, `EventLog`, `Config` (`load({ projectPath })` for the config snapshot and the default branch), `uuidv7`, `nowIso`, `WorkspaceError`.
- Produces: `ProjectRegistry` service `{ register(path): Effect<Project, WorkspaceError | ConfigError | StoreError>; list(): Effect<readonly Project[], StoreError>; get(id): Effect<Project | undefined, StoreError>; remove(id): Effect<void, StoreError> }`, `ProjectRegistryLive: Layer<ProjectRegistry, never, SqlClient | EventLog | Config>`, `Project { id, name, path, defaultBranch, config: ProjectConfig, createdAt, updatedAt }`, `findGitRoot(path): string | null`, `isByteBureauWorktree(root): boolean`, `defaultBranchOf(root): string` (`git symbolic-ref --short refs/remotes/origin/HEAD` → strip `origin/`, else `main`).

Semantics (as shipped): `defaultProjectConfig` no longer carries `project.defaultBranch` or `defaults.branch` (per-repository values; merging `'main'` into every project made `defaultBranchOf` dead code and would base sessions of a `develop` repository on `main`), the init template documents both keys in comments instead, and the registry resolves `defaultBranch = config.project.defaultBranch ?? defaultBranchOf(root)` (`origin/HEAD`; the final fix wave adds the checked-out branch before the `main` fallback). `createTempRepo({ withRemote: true })` has no `origin/HEAD` (`push -u` creates only the branch ref), so the test named after it exercises the fallback; the `set-head` case has its own test. `config_json` is the merged, validated `ProjectConfig`; re-registering rebuilds the row from its id, path and `created_at`, so a snapshot that no longer decodes is repaired. `remove(id)` is idempotent on a missing row and fails with `StoreError` (foreign key) while sessions reference the project (Task 15 `projects rm` reports it). Temp repositories are `realpathSync`ed (macOS `/var` → `/private/var`, git reports the real path).

- [ ] **Step 1: Failing tests**

`packages/kernel/src/projects/git-root.test.ts`:
```ts
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTempRepo, git, tempDir } from '../testing/temp-repo.js'
import { defaultBranchOf, findGitRoot, isByteBureauWorktree } from './git-root.js'

// A repository that has been initialised and holds no commit yet
function emptyRepo(): string {
  const repo = tempDir('bb-empty-')
  git(repo, 'init', '-q', '-b', 'main')
  return repo
}

describe(findGitRoot, () => {
  it('finds the toplevel from a nested directory and null outside a repository', () => {
    const repo = createTempRepo()
    mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true })
    expect(findGitRoot(path.join(repo, 'src', 'deep'))).toBe(repo)
    expect(findGitRoot(tempDir('bb-plain-'))).toBeNull()
  })

  it('finds no toplevel for a directory that does not exist', () => {
    const missing = path.join(tempDir('bb-plain-'), 'nowhere')
    expect(findGitRoot(missing)).toBeNull()
  })

  it('reports the physical toplevel when asked through a symlink', () => {
    const repo = createTempRepo()
    const link = path.join(tempDir('bb-link-'), 'repo')
    symlinkSync(repo, link)
    expect(findGitRoot(link)).toBe(repo)
  })

  it('finds the toplevel of a repository without commits', () => {
    const repo = emptyRepo()
    expect(findGitRoot(repo)).toBe(repo)
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

  it('falls back to main in a repository without commits', () => {
    expect(defaultBranchOf(emptyRepo())).toBe('main')
  })

  it.each(['develop', 'release/1.x'])('follows origin/HEAD to %s', (branch) => {
    const repo = createTempRepo({ withRemote: true })
    git(repo, 'push', '-q', 'origin', `main:refs/heads/${branch}`)
    git(repo, 'remote', 'set-head', 'origin', branch)
    expect(defaultBranchOf(repo)).toBe(branch)
  })
})
```
`packages/kernel/src/projects/project-registry.test.ts`:
```ts
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { ConfigError, StoreError, WorkspaceError } from '../errors.js'
import { EventLog } from '../events/event-log.js'
import { createTempRepo, tempDir } from '../testing/temp-repo.js'
import { ProjectRegistry } from './project-registry.js'
import {
  namedRepo,
  registerAt,
  TestLayer,
  trackingDevelop,
  writeProjectFile,
} from './project-registry-fixtures.js'

it.layer(TestLayer)('ProjectRegistry register', (suite) => {
  suite.effect('registers a repository once, whichever directory inside it is given', () =>
    Effect.gen(function* registersOnce() {
      const registry = yield* ProjectRegistry
      const repo = createTempRepo()
      mkdirSync(path.join(repo, 'src'), { recursive: true })
      const first = yield* registry.register(path.join(repo, 'src'))
      const second = yield* registry.register(repo)
      assert.strictEqual(second.id, first.id)
      const registered = [first.path, first.name, first.defaultBranch]
      assert.deepStrictEqual(registered, [repo, path.basename(repo), 'main'])
      const stored = (yield* registry.list()).filter((project) => project.path === repo)
      assert.deepStrictEqual(stored, [second])
    }),
  )

  suite.effect('announces the registration and every later update with the stored identity', () =>
    Effect.gen(function* announcesProject() {
      const registry = yield* ProjectRegistry
      const log = yield* EventLog
      const repo = createTempRepo()
      const first = yield* registry.register(repo)
      yield* registry.register(repo)
      const events = yield* log.read({ projectId: first.id }, { from: 0 })
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ['project.registered', 'project.updated'],
      )
      const identity = { id: first.id, name: first.name, path: repo, defaultBranch: 'main' }
      const payloads = events.map((event) => event.payload)
      assert.deepStrictEqual(payloads, [identity, identity])
    }),
  )

  suite.effect(
    'names the project after its project file and keeps the resolved configuration',
    () =>
      Effect.gen(function* snapshotsConfiguration() {
        const registry = yield* ProjectRegistry
        const project = yield* registry.register(namedRepo('Demo'))
        assert.strictEqual(project.name, 'Demo')
        assert.strictEqual(project.config.project.name, 'Demo')
        assert.deepStrictEqual(project.config.defaults, { employee: 'developer' })
        assert.deepStrictEqual(yield* registry.get(project.id), project)
      }),
  )
})

it.layer(TestLayer)('ProjectRegistry refresh', (suite) => {
  suite.effect('refreshes the name, default branch and configuration of a known repository', () =>
    Effect.gen(function* refreshesProject() {
      const registry = yield* ProjectRegistry
      const repo = createTempRepo()
      const first = yield* registerAt(registry, repo, '2026-10-03T08:00:00.000Z')
      writeProjectFile(repo, { name: 'renamed', defaultBranch: 'develop' })
      const second = yield* registerAt(registry, repo, '2026-10-03T09:30:00.000Z')
      assert.deepStrictEqual(
        [second.id, second.createdAt, second.updatedAt],
        [first.id, '2026-10-03T08:00:00.000Z', '2026-10-03T09:30:00.000Z'],
      )
      assert.deepStrictEqual([second.name, second.defaultBranch], ['renamed', 'develop'])
      assert.deepStrictEqual(second.config.project, { name: 'renamed', defaultBranch: 'develop' })
      assert.deepStrictEqual(yield* registry.get(first.id), second)
    }),
  )

  suite.effect('takes the default branch from the configuration, else from origin/HEAD', () =>
    Effect.gen(function* resolvesDefaultBranch() {
      const registry = yield* ProjectRegistry
      const detected = trackingDevelop()
      const configured = trackingDevelop()
      writeProjectFile(configured, { name: 'configured', defaultBranch: 'trunk' })
      assert.strictEqual((yield* registry.register(detected)).defaultBranch, 'develop')
      assert.strictEqual((yield* registry.register(configured)).defaultBranch, 'trunk')
    }),
  )
})

it.layer(TestLayer)('ProjectRegistry refusals', (suite) => {
  suite.effect('refuses directories that are not repositories or are ByteBureau worktrees', () =>
    Effect.gen(function* refusesDirectories() {
      const registry = yield* ProjectRegistry
      const before = yield* registry.list()
      const plain = yield* Effect.flip(registry.register(tempDir('bb-plain-')))
      const repo = createTempRepo()
      writeFileSync(path.join(repo, '.bytebureau-session.json'), '{}')
      const worktree = yield* Effect.flip(registry.register(repo))
      assert.instanceOf(plain, WorkspaceError)
      assert.instanceOf(worktree, WorkspaceError)
      assert.deepStrictEqual(
        [plain.code, worktree.code],
        ['not_a_repository', 'is_bytebureau_worktree'],
      )
      assert.deepStrictEqual(yield* registry.list(), before)
    }),
  )

  suite.effect('fails with the configuration error and stores nothing for an invalid file', () =>
    Effect.gen(function* refusesInvalidConfiguration() {
      const registry = yield* ProjectRegistry
      const before = yield* registry.list()
      const repo = createTempRepo()
      writeProjectFile(repo, { name: 'x', extra: true })
      const failure = yield* Effect.flip(registry.register(repo))
      assert.instanceOf(failure, ConfigError)
      assert.strictEqual(failure.pointer, '/project/extra')
      assert.deepStrictEqual(yield* registry.list(), before)
    }),
  )
})

it.layer(TestLayer)('ProjectRegistry list, get and remove', (suite) => {
  suite.effect('lists projects by name and finds none for an unknown id', () =>
    Effect.gen(function* listsByName() {
      const registry = yield* ProjectRegistry
      const beta = yield* registry.register(namedRepo('beta'))
      const alpha = yield* registry.register(namedRepo('alpha'))
      const ids = new Set([alpha.id, beta.id])
      const ours = (yield* registry.list()).filter((project) => ids.has(project.id))
      assert.deepStrictEqual(ours, [alpha, beta])
      assert.strictEqual(yield* registry.get('unknown'), undefined)
    }),
  )

  suite.effect('removes a project and announces it, also for an id nobody holds', () =>
    Effect.gen(function* removesProject() {
      const registry = yield* ProjectRegistry
      const log = yield* EventLog
      const project = yield* registry.register(createTempRepo())
      yield* registry.remove(project.id)
      yield* registry.remove('unknown')
      assert.strictEqual(yield* registry.get(project.id), undefined)
      const known = yield* log.read({ projectId: project.id }, { from: 0 })
      const unknown = yield* log.read({ projectId: 'unknown' }, { from: 0 })
      const types = [known, unknown].map((events) => events.map((event) => event.type))
      assert.deepStrictEqual(types, [
        ['project.registered', 'project.removed'],
        ['project.removed'],
      ])
    }),
  )
})

it.effect('reports a failing statement as a StoreError from every operation', () =>
  Effect.gen(function* failsWithStoreError() {
    const sql = yield* SqlClient.SqlClient
    const registry = yield* ProjectRegistry
    yield* sql`DROP TABLE projects`
    const failures = [
      yield* Effect.flip(registry.register(createTempRepo())),
      yield* Effect.flip(registry.list()),
      yield* Effect.flip(registry.get('x')),
      yield* Effect.flip(registry.remove('x')),
    ]
    for (const failure of failures) {
      assert.instanceOf(failure, StoreError)
    }
  }).pipe(Effect.provide(TestLayer)),
)
```
`packages/kernel/src/projects/project-registry-fixtures.ts` (shared test layer and fixtures):
```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Effect, Layer } from 'effect'
import { vi } from 'vitest'
import { ConfigLive } from '../config/config.js'
import { EventLogLive } from '../events/event-log.js'
import { StoreTest } from '../store/store-test.js'
import { createTempRepo, git } from '../testing/temp-repo.js'
import { ProjectRegistryLive, type ProjectRegistryShape } from './project-registry.js'

// An empty home directory for the user configuration, removed when the layer is released
const emptyHome = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(path.join(tmpdir(), 'bb-home-'))),
  (home) =>
    Effect.sync(() => {
      rmSync(home, { recursive: true, force: true })
    }),
)

const services = Layer.unwrap(
  emptyHome.pipe(
    Effect.map((home) => {
      const config = ConfigLive(home)
      return Layer.mergeAll(EventLogLive, config)
    }),
  ),
)

export const TestLayer = ProjectRegistryLive.pipe(
  Layer.provideMerge(services),
  Layer.provideMerge(StoreTest),
)

// The project file of a fixture repository, with only the project section the test cares about
export function writeProjectFile(repo: string, project: Record<string, unknown>): void {
  const config = { version: 1, project, employees: {} }
  writeFileSync(path.join(repo, 'bytebureau.json'), JSON.stringify(config))
}

export function namedRepo(name: string): string {
  const repo = createTempRepo()
  writeProjectFile(repo, { name })
  return repo
}

// A repository whose remote HEAD names develop
export function trackingDevelop(): string {
  const repo = createTempRepo({ withRemote: true })
  git(repo, 'push', '-q', 'origin', 'main:refs/heads/develop')
  git(repo, 'remote', 'set-head', 'origin', 'develop')
  return repo
}

// Registers with the system clock stopped at the given instant, and lets it run again afterwards
export function registerAt(
  registry: ProjectRegistryShape,
  directory: string,
  instant: string,
): ReturnType<ProjectRegistryShape['register']> {
  return Effect.suspend(() => {
    vi.setSystemTime(instant)
    return registry.register(directory)
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        vi.useRealTimers()
      }),
    ),
  )
}
```
- [ ] **Step 2: Implementation**

`packages/kernel/src/projects/git-root.ts`:
```ts
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

function git(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

export const findGitRoot = (directory: string): string | null =>
  git(directory, ['rev-parse', '--show-toplevel'])

export const isByteBureauWorktree = (root: string): boolean =>
  existsSync(path.join(root, '.bytebureau-session.json'))

export function defaultBranchOf(root: string): string {
  const head = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  return head === null ? 'main' : head.replace(/^origin\//u, '')
}
```
`packages/kernel/src/projects/project-registry.ts`:
```ts
import path from 'node:path'
import { decodeProjectConfig, type ProjectConfig } from '@bytebureau/protocol'
import { Context, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { Config, type ConfigShape } from '../config/config.js'
import { StoreError, WorkspaceError, type ConfigError } from '../errors.js'
import { EventLog, type EventLogShape } from '../events/event-log.js'
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
  readonly register: (
    directory: string,
  ) => Effect.Effect<Project, WorkspaceError | ConfigError | StoreError>
  readonly list: () => Effect.Effect<readonly Project[], StoreError>
  readonly get: (id: string) => Effect.Effect<Project | undefined, StoreError>
  readonly remove: (id: string) => Effect.Effect<void, StoreError>
}

export class ProjectRegistry extends Context.Service<ProjectRegistry, ProjectRegistryShape>()(
  'bb/ProjectRegistry',
) {}

interface Row {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly default_branch: string
  readonly config_json: string
  readonly created_at: string
  readonly updated_at: string
}

// The snapshot is decoded again, so a row that no longer fits the schema fails loudly
const fromRow = (row: Row): Project => ({
  id: row.id,
  name: row.name,
  path: row.path,
  defaultBranch: row.default_branch,
  config: decodeProjectConfig(JSON.parse(row.config_json)),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toStoreError = (cause: unknown): StoreError => new StoreError({ cause })

interface Deps {
  readonly sql: SqlClient.SqlClient
  readonly log: EventLogShape
  readonly config: ConfigShape
}

// The repository's resolved configuration with the two values a project takes from it
interface Snapshot {
  readonly name: string
  readonly defaultBranch: string
  readonly config: ProjectConfig
}

// A session worktree is a checkout of a project, never a project of its own
const repositoryRoot = (directory: string): Effect.Effect<string, WorkspaceError> =>
  Effect.gen(function* findRepositoryRoot() {
    const root = findGitRoot(path.resolve(directory))
    if (root === null) {
      const reason = `${directory} is not inside a git repository`
      return yield* new WorkspaceError({ code: 'not_a_repository', reason })
    }
    if (isByteBureauWorktree(root)) {
      const reason = `${root} is a ByteBureau session worktree`
      return yield* new WorkspaceError({ code: 'is_bytebureau_worktree', reason })
    }
    return root
  })

// A configured default branch wins; otherwise the repository decides: origin/HEAD, else main
const snapshotOf = (config: ConfigShape, root: string): Effect.Effect<Snapshot, ConfigError> =>
  Effect.map(config.load({ projectPath: root }), ({ project }) => ({
    name: project.project.name,
    defaultBranch: project.project.defaultBranch ?? defaultBranchOf(root),
    config: project,
  }))

const findByPath = (
  sql: SqlClient.SqlClient,
  root: string,
): Effect.Effect<Row | undefined, StoreError> =>
  sql<Row>`SELECT * FROM projects WHERE path = ${root}`.pipe(
    Effect.map(([row]) => row),
    Effect.mapError(toStoreError),
  )

const insertProject = (
  sql: SqlClient.SqlClient,
  project: Project,
): Effect.Effect<void, StoreError> =>
  sql`
    INSERT INTO projects (id, name, path, default_branch, config_json, created_at, updated_at)
    VALUES (${project.id}, ${project.name}, ${project.path}, ${project.defaultBranch}, ${JSON.stringify(project.config)}, ${project.createdAt}, ${project.updatedAt})`.pipe(
    Effect.asVoid,
    Effect.mapError(toStoreError),
  )

const updateProject = (
  sql: SqlClient.SqlClient,
  project: Project,
): Effect.Effect<void, StoreError> =>
  sql`
    UPDATE projects
    SET name = ${project.name}, default_branch = ${project.defaultBranch}, config_json = ${JSON.stringify(project.config)}, updated_at = ${project.updatedAt}
    WHERE id = ${project.id}`.pipe(Effect.asVoid, Effect.mapError(toStoreError))

const announce = (
  log: EventLogShape,
  type: 'project.registered' | 'project.updated',
  project: Project,
): Effect.Effect<void, StoreError> =>
  Effect.asVoid(
    log.publish({
      type,
      projectId: project.id,
      payload: {
        id: project.id,
        name: project.name,
        path: project.path,
        defaultBranch: project.defaultBranch,
      },
    }),
  )

const createProject = (
  { sql, log }: Deps,
  root: string,
  snapshot: Snapshot,
): Effect.Effect<Project, StoreError> =>
  Effect.gen(function* createNewProject() {
    const now = nowIso()
    const project: Project = {
      id: uuidv7(),
      path: root,
      createdAt: now,
      updatedAt: now,
      ...snapshot,
    }
    yield* insertProject(sql, project)
    yield* announce(log, 'project.registered', project)
    return project
  })

// The id and the creation time stay; the snapshot of the repository and the update time are renewed
const refreshProject = (
  { sql, log }: Deps,
  existing: Row,
  snapshot: Snapshot,
): Effect.Effect<Project, StoreError> =>
  Effect.gen(function* refreshKnownProject() {
    const project: Project = {
      id: existing.id,
      path: existing.path,
      createdAt: existing.created_at,
      updatedAt: nowIso(),
      ...snapshot,
    }
    yield* updateProject(sql, project)
    yield* announce(log, 'project.updated', project)
    return project
  })

const makeRegister =
  (deps: Deps): ProjectRegistryShape['register'] =>
  (directory) =>
    Effect.gen(function* registerProject() {
      const root = yield* repositoryRoot(directory)
      const snapshot = yield* snapshotOf(deps.config, root)
      const existing = yield* findByPath(deps.sql, root)
      if (existing === undefined) {
        return yield* createProject(deps, root, snapshot)
      }
      return yield* refreshProject(deps, existing, snapshot)
    })

const makeList =
  (sql: SqlClient.SqlClient): ProjectRegistryShape['list'] =>
  () =>
    sql<Row>`SELECT * FROM projects ORDER BY name`.pipe(
      Effect.map((rows) => rows.map((row) => fromRow(row))),
      Effect.mapError(toStoreError),
    )

const makeGet =
  (sql: SqlClient.SqlClient): ProjectRegistryShape['get'] =>
  (id) =>
    sql<Row>`SELECT * FROM projects WHERE id = ${id}`.pipe(
      Effect.map(([row]) => (row === undefined ? undefined : fromRow(row))),
      Effect.mapError(toStoreError),
    )

// Removing an id nobody holds is not an error: the announcement still goes out
const makeRemove =
  ({ sql, log }: Deps): ProjectRegistryShape['remove'] =>
  (id) =>
    Effect.gen(function* removeProject() {
      yield* sql`DELETE FROM projects WHERE id = ${id}`.pipe(Effect.mapError(toStoreError))
      yield* log.publish({ type: 'project.removed', projectId: id, payload: { id } })
    })

const make = Effect.gen(function* makeProjectRegistry() {
  const sql = yield* SqlClient.SqlClient
  const log = yield* EventLog
  const config = yield* Config
  const deps: Deps = { sql, log, config }
  return ProjectRegistry.of({
    register: makeRegister(deps),
    list: makeList(sql),
    get: makeGet(sql),
    remove: makeRemove(deps),
  })
})

export const ProjectRegistryLive: Layer.Layer<
  ProjectRegistry,
  never,
  SqlClient.SqlClient | EventLog | Config
> = Layer.effect(ProjectRegistry, make)
```
`packages/kernel/src/testing/temp-repo.ts` (kernel-local copy of the Task 9 helper):
```ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { onTestFinished } from 'vitest'

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

// Symlinks are resolved, as git reports paths: on macOS the temporary directory sits behind /var -> /private/var
// The directory is removed when the running test has finished
export function tempDir(prefix: string): string {
  const created = mkdtempSync(path.join(tmpdir(), prefix))
  const dir = realpathSync(created)
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function addOrigin(dir: string): void {
  const remote = tempDir('bb-remote-')
  git(remote, 'init', '-q', '--bare', '-b', 'main')
  git(dir, 'remote', 'add', 'origin', remote)
  git(dir, 'push', '-q', '-u', 'origin', 'main')
}

// A repository with one commit on `main` and an optional bare "origin" remote
export function createTempRepo(options: { readonly withRemote?: boolean } = {}): string {
  const dir = tempDir('bb-repo-')
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(path.join(dir, 'README.md'), '# fixture\n')
  git(dir, 'add', 'README.md')
  git(dir, 'commit', '-q', '-m', 'initial')
  if (options.withRemote === true) {
    addOrigin(dir)
  }
  return dir
}
```

Add to `index.ts`: `export { ProjectRegistry, ProjectRegistryLive, type Project, type ProjectRegistryShape } from './projects/project-registry.js'` and `export { findGitRoot, isByteBureauWorktree, defaultBranchOf } from './projects/git-root.js'`.

- [ ] **Step 3: Run, commit**

Run: `bunx vitest run --project kernel` → PASS. `bun run check` → green (knip: `testing/*.ts` helpers are used by tests; if knip reports them, add `'src/testing/**'` to the kernel workspace `project` ignore via `ignore: ['src/testing/**']`).

```bash
git add packages/kernel
git commit -m "feat(kernel): register projects by git root with config snapshots and events"
```

### Task 8: `Supervisor` service — spawn, line streams, env allowlist, kill ladder, `TRACEPARENT`

**Files:**
- Create: `packages/kernel/src/process/env-allowlist.ts`, `packages/kernel/src/process/line-buffer.ts`, `packages/kernel/src/process/pump.ts`, `packages/kernel/src/process/kill-ladder.ts`, `packages/kernel/src/process/child-env.ts`, `packages/kernel/src/process/launch.ts`, `packages/kernel/src/process/supervisor.ts`, `packages/kernel/src/process/supervisor-fixtures.ts`, `packages/kernel/src/process/env-allowlist.test.ts`, `packages/kernel/src/process/line-buffer.test.ts`, `packages/kernel/src/process/pump.test.ts`, `packages/kernel/src/process/kill-ladder.test.ts`, `packages/kernel/src/process/launch.test.ts`, `packages/kernel/src/process/supervisor.test.ts`, `packages/kernel/src/process/supervisor-kill.test.ts`, `packages/kernel/src/process/supervisor-group.test.ts` (the lint caps split the brief's three source files and one suite)
- Modify: `packages/kernel/src/index.ts`

**Interfaces:**
- Consumes: Node's `child_process.spawn` (Bun implements it), `node:readline` line iteration; Effect `Effect.currentSpan` + `HttpTraceContext.toHeaders` (verified: produces `traceparent`), `Effect.sleep` for the ladder (test-controlled by `TestClock`).
- Produces: `Supervisor` service `{ spawn(spec: SpawnSpec): Effect<ManagedProcess, never, Scope>; kill(id, signal?): Effect<void>; list(): Effect<readonly ProcessInfo[]> }`, `SupervisorLive: Layer<Supervisor>`, `SpawnSpec { kind: 'agent' | 'git' | 'helper'; command; args; cwd; env?: Record<string, string>; passEnv?: readonly string[]; signal?: AbortSignal; maxLines?: number }`, `ManagedProcess { id, pid, stdout: Stream<string>, stderr: Stream<string>, exit: Effect<ExitInfo>, kill(signal?): Effect<void> }`, `ExitInfo { code: number | null; signal: string | null }`, `allowlistEnv(source, extra?: readonly string[]): Record<string, string>`, `LineBuffer`, `restartSchedule(maxRestarts: number)`.

Env allowlist (spec §13): `PATH`, `HOME`, `LANG`, `LC_*`, `TMPDIR`, `TERM`, `TRACEPARENT`, `BYTEBUREAU_*`, plus `passEnv` names (profile variables arrive through `passEnv`, built by Task 13); everything else is dropped, and `spec.env` goes through the same filter. Kill ladder: `SIGINT`, after 5 s `SIGTERM`, after another 10 s `SIGKILL`, each step skipped once the process has exited; an explicit signal sends only that signal; an aborted `SpawnSpec.signal` runs the ladder. As shipped: children are spawned `detached: true` in their own process group and every signal goes to the group (`process.kill(-pid)`, falling back to `child.kill`), so agent helpers such as MCP servers die with the agent; `exit`, the ladder's "exited", `list()` and the scope finalizer follow the process `exit` event with a 2 s pipe-drain bound (`close` first wins), and nothing is signalled after release (a freed pid may belong to someone else); scope close is `SIGTERM` then `SIGKILL` after 10 s; the pumps read readline `line` events because the readline async iterator loses a line and throws `ERR_USE_AFTER_CLOSE` under consumer lag on Bun and Node alike; queues are unbounded (unread output stays in memory; `maxLines` bounds only `recentStderr()`); start failures (missing command, bad cwd, invalid arguments) resolve `exit` with code -1 and one stderr line, `ERR_INVALID_ARG_*` reported by code so no value is echoed. A terminal Ctrl-C no longer reaches detached children directly: the `--no-daemon` CLI closes its scopes from its own SIGINT handler.

- [ ] **Step 1: Failing tests**

`packages/kernel/src/process/env-allowlist.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { allowlistEnv } from './env-allowlist.js'

describe(allowlistEnv, () => {
  it('keeps only the documented variables and explicit extras', () => {
    const env = allowlistEnv(
      {
        PATH: '/bin',
        HOME: '/h',
        LANG: 'cs_CZ.UTF-8',
        LC_ALL: 'C',
        TMPDIR: '/t',
        TERM: 'xterm',
        ANTHROPIC_API_KEY: 'not-a-real-key',
        AWS_SECRET: 'y',
        BYTEBUREAU_HOME: '/bb',
        TRACEPARENT: '00-a-b-01',
        CUSTOM: 'c',
      },
      ['CUSTOM'],
    )
    expect(Object.keys(env).toSorted()).toStrictEqual([
      'BYTEBUREAU_HOME',
      'CUSTOM',
      'HOME',
      'LANG',
      'LC_ALL',
      'PATH',
      'TERM',
      'TMPDIR',
      'TRACEPARENT',
    ])
  })

  it('drops look-alike names, unset variables and extras the source does not have', () => {
    const env = allowlistEnv(
      { PATHS: '/x', path: '/lower', LC: 'x', BYTEBUREAU: 'y', HOME: undefined, LANG: 'C' },
      ['MISSING'],
    )
    expect(env).toStrictEqual({ LANG: 'C' })
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
    expect(buffer.lines()).toStrictEqual(['c', 'd', 'e'])
    expect(buffer.dropped).toBe(2)
  })

  it('drops nothing below the limit and hands out copies', () => {
    const buffer = new LineBuffer(3)
    buffer.push('a')
    const first = buffer.lines()
    buffer.push('b')
    expect(first).toStrictEqual(['a'])
    expect(buffer.lines()).toStrictEqual(['a', 'b'])
    expect(buffer.dropped).toBe(0)
  })
})
```
`packages/kernel/src/process/supervisor.test.ts`:
```ts
import { assert, describe, it } from '@effect/vitest'
import { Cause, Duration, Effect, Exit, Fiber, Schedule, Scope, Stream } from 'effect'
import {
  restartSchedule,
  Supervisor,
  SupervisorLive,
  type ProcessInfo,
  type SpawnSpec,
} from './supervisor.js'
import { awaitReady, IDLE, node, nodeSpec, ownScope, withEnv } from './supervisor-fixtures.js'

const TRACE = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`

const numbered = (prefix: string): string[] =>
  Array.from({ length: 20 }, (_value, index) => `${prefix}${index}`)

const withoutStamp = ({
  startedAt: _startedAt,
  ...rest
}: ProcessInfo): Omit<ProcessInfo, 'startedAt'> => rest

const hasIsoStamp = ({ startedAt }: ProcessInfo): boolean =>
  new Date(startedAt).toISOString() === startedAt

// A process that cannot start reports exit code -1, a pid of -1 and only the reason on stderr
const failsToStart = (
  spec: SpawnSpec,
): Effect.Effect<readonly string[], never, Supervisor | Scope.Scope> =>
  Effect.gen(function* failsToStartGen() {
    const supervisor = yield* Supervisor
    const child = yield* supervisor.spawn(spec)
    assert.deepStrictEqual(yield* child.exit, { code: -1, signal: null })
    assert.strictEqual(child.pid, -1)
    assert.deepStrictEqual(yield* Stream.runCollect(child.stdout), [])
    const reasons = yield* Stream.runCollect(child.stderr)
    assert.deepStrictEqual(child.recentStderr(), reasons)
    assert.deepStrictEqual(yield* supervisor.list(), [])
    return reasons
  })

// Without a test clock, so the child processes run in real time
const live = { excludeTestServices: true }

it.layer(SupervisorLive, live)('Supervisor environment', (suite) => {
  suite.effect('streams stdout lines, passes only allowlisted env and reports the exit code', () =>
    Effect.gen(function* streamsOutput() {
      const supervisor = yield* Supervisor
      const child = yield* supervisor.spawn(
        nodeSpec(
          'console.log("one"); console.log(process.env.SECRET ?? "no-secret"); console.log(process.env.KEEP); process.exit(3)',
          { env: { SECRET: 'x', KEEP: 'y' }, passEnv: ['KEEP'] },
        ),
      )
      const lines = yield* Stream.runCollect(child.stdout)
      assert.deepStrictEqual(lines, ['one', 'no-secret', 'y'])
      assert.deepStrictEqual(yield* child.exit, { code: 3, signal: null })
    }),
  )

  suite.effect('keeps the daemon environment out of the child except the allowlist', () =>
    Effect.gen(function* dropsDaemonEnvironment() {
      yield* withEnv('ANTHROPIC_API_KEY', 'not-a-real-key')
      yield* withEnv('BYTEBUREAU_TEST_MARK', 'kept')
      const supervisor = yield* Supervisor
      const child = yield* supervisor.spawn(
        nodeSpec(
          'console.log(process.env.ANTHROPIC_API_KEY ?? "dropped"); console.log(process.env.BYTEBUREAU_TEST_MARK); console.log(typeof process.env.PATH)',
        ),
      )
      const lines = yield* Stream.runCollect(child.stdout)
      assert.deepStrictEqual(lines, ['dropped', 'kept', 'string'])
    }),
  )
})

it.layer(SupervisorLive, live)('Supervisor tracing', (suite) => {
  suite.effect('hands the current span to the child as TRACEPARENT', () =>
    Effect.gen(function* passesSpan() {
      yield* withEnv('TRACEPARENT', TRACE)
      const supervisor = yield* Supervisor
      const span = yield* Effect.currentSpan
      const child = yield* supervisor.spawn(nodeSpec('console.log(process.env.TRACEPARENT)'))
      const flags = span.sampled ? '01' : '00'
      const lines = yield* Stream.runCollect(child.stdout)
      assert.deepStrictEqual(lines, [`00-${span.traceId}-${span.spanId}-${flags}`])
    }).pipe(Effect.withSpan('parent')),
  )

  suite.effect('passes the daemon own TRACEPARENT on when no span is active', () =>
    Effect.gen(function* passesAmbientTrace() {
      yield* withEnv('TRACEPARENT', TRACE)
      const supervisor = yield* Supervisor
      const child = yield* supervisor.spawn(nodeSpec('console.log(process.env.TRACEPARENT)'))
      assert.deepStrictEqual(yield* Stream.runCollect(child.stdout), [TRACE])
    }),
  )
})

it.layer(SupervisorLive, live)('Supervisor line streams', (suite) => {
  suite.effect('splits CRLF and unterminated lines and keeps each stream in its own order', () =>
    Effect.gen(function* splitsLines() {
      const supervisor = yield* Supervisor
      const child = yield* supervisor.spawn(
        nodeSpec(
          String.raw`for (let i = 0; i < 20; i++) { process.stdout.write("o" + i + "\r\n"); process.stderr.write("e" + i + "\n") } process.stdout.write("tail")`,
        ),
      )
      assert.deepStrictEqual(yield* Stream.runCollect(child.stdout), [...numbered('o'), 'tail'])
      assert.deepStrictEqual(yield* Stream.runCollect(child.stderr), numbered('e'))
    }),
  )

  suite.effect('delivers every line of an output that outgrows the pipe buffer', () =>
    Effect.gen(function* deliversLongOutput() {
      const supervisor = yield* Supervisor
      const child = yield* supervisor.spawn(
        nodeSpec(
          'for (let i = 0; i < 20000; i++) console.log("line-" + i); process.stdout.write("tail")',
        ),
      )
      const lines = yield* Stream.runCollect(child.stdout)
      assert.strictEqual(lines.length, 20_001)
      assert.deepStrictEqual(lines.slice(0, 2), ['line-0', 'line-1'])
      assert.deepStrictEqual(lines.slice(-2), ['line-19999', 'tail'])
    }),
  )

  suite.effect(
    'keeps the newest stderr lines for diagnostics although nobody reads the stream',
    () =>
      Effect.gen(function* keepsStderr() {
        const supervisor = yield* Supervisor
        const child = yield* supervisor.spawn(
          nodeSpec('for (const n of [1, 2, 3, 4, 5]) console.error("e" + n)', { maxLines: 3 }),
        )
        yield* child.exit
        assert.deepStrictEqual(child.recentStderr(), ['e3', 'e4', 'e5'])
        assert.deepStrictEqual(yield* Stream.runCollect(child.stderr), [
          'e1',
          'e2',
          'e3',
          'e4',
          'e5',
        ])
      }),
  )
})

// A consumer that is slower than the child must neither lose a line nor see the pipe fail
it.layer(SupervisorLive, live)('Supervisor lagging consumer', (suite) => {
  suite.effect('delivers every line to a consumer that yields to the event loop on each line', () =>
    Effect.gen(function* lagsBehind() {
      const supervisor = yield* Supervisor
      const child = yield* supervisor.spawn(
        nodeSpec('for (let i = 0; i < 8000; i++) console.log("line-" + i)'),
      )
      const lines = yield* child.stdout.pipe(
        Stream.tap(() => Effect.yieldNow),
        Stream.runCollect,
      )
      assert.strictEqual(lines.length, 8000)
      assert.strictEqual(lines.at(-1), 'line-7999')
    }),
  )
})

it.layer(SupervisorLive, live)('Supervisor registry', (suite) => {
  suite.effect('lists a running process until it exits', () =>
    Effect.gen(function* listsRunning() {
      const supervisor = yield* Supervisor
      const child = yield* supervisor.spawn(nodeSpec(IDLE))
      yield* awaitReady(child)
      const listed = yield* supervisor.list()
      assert.deepStrictEqual(
        listed.map((info) => withoutStamp(info)),
        [{ id: child.id, kind: 'helper', command: node, pid: child.pid }],
      )
      assert.ok(listed.every((info) => hasIsoStamp(info)))
      yield* child.kill('SIGKILL')
      yield* child.exit
      assert.deepStrictEqual(yield* supervisor.list(), [])
    }),
  )

  suite.effect('keeps streaming after the fiber that spawned the process has ended', () =>
    Effect.gen(function* outlivesSpawner() {
      const supervisor = yield* Supervisor
      const scope = yield* ownScope
      const spawning = supervisor
        .spawn(nodeSpec('console.log("a"); console.log("b")'))
        .pipe(Effect.provideService(Scope.Scope, scope))
      const child = yield* Fiber.join(yield* Effect.forkChild(spawning))
      assert.deepStrictEqual(yield* Stream.runCollect(child.stdout), ['a', 'b'])
      assert.deepStrictEqual(yield* child.exit, { code: 0, signal: null })
      yield* Scope.close(scope, Exit.void)
    }),
  )
})

it.layer(SupervisorLive, live)('Supervisor start failures', (suite) => {
  suite.effect('reports a command that does not exist', () =>
    Effect.gen(function* reportsMissingCommand() {
      const command = 'bytebureau-no-such-command'
      const reasons = yield* failsToStart({ kind: 'helper', command, args: [], cwd: process.cwd() })
      assert.strictEqual(reasons.length, 1)
      assert.ok(reasons.every((line) => line.includes(command)))
    }),
  )

  suite.effect('reports a working directory that does not exist', () =>
    Effect.gen(function* reportsMissingDirectory() {
      const reasons = yield* failsToStart(nodeSpec('1', { cwd: '/bytebureau/no/such/directory' }))
      assert.strictEqual(reasons.length, 1)
    }),
  )

  suite.effect('reports a working directory that is a file', () =>
    Effect.gen(function* reportsFileAsDirectory() {
      const reasons = yield* failsToStart(nodeSpec('1', { cwd: node }))
      assert.strictEqual(reasons.length, 1)
    }),
  )
})

// The runtime echoes the offending value in its message, which may well be a secret
it.layer(SupervisorLive, live)('Supervisor invalid arguments', (suite) => {
  suite.effect('reports an invalid argument by its code alone', () =>
    Effect.gen(function* reportsInvalidArgument() {
      const reasons = yield* failsToStart(nodeSpec('1\0'))
      assert.strictEqual(reasons.length, 1)
      assert.ok(reasons.every((line) => line.includes('ERR_INVALID_ARG_VALUE')))
      assert.ok(reasons.every((line) => !line.includes('Received')))
    }),
  )

  suite.effect('reports an invalid environment value without echoing it', () =>
    Effect.gen(function* hidesInvalidValue() {
      const spec = nodeSpec('1', { env: { MY_SECRET: 'swordfish\0' }, passEnv: ['MY_SECRET'] })
      const reasons = yield* failsToStart(spec)
      assert.strictEqual(reasons.length, 1)
      assert.ok(reasons.every((line) => line.includes('ERR_INVALID_ARG_VALUE')))
      assert.ok(reasons.every((line) => !line.includes('swordfish')))
    }),
  )
})

describe(restartSchedule, () => {
  it.effect('backs off exponentially with jitter and gives up after the limit', () =>
    Effect.gen(function* backsOff() {
      const step = yield* Schedule.toStep(restartSchedule(2))
      const [, first] = yield* step(0, null)
      const [, second] = yield* step(0, null)
      const [firstMillis, secondMillis] = [Duration.toMillis(first), Duration.toMillis(second)]
      assert.ok(firstMillis >= 400 && firstMillis <= 600)
      assert.ok(secondMillis >= 800 && secondMillis <= 1200)
      const exhausted = yield* Effect.flip(step(0, null))
      assert.ok(Cause.isDone(exhausted))
    }),
  )
})
```
`packages/kernel/src/process/supervisor-kill.test.ts`:
```ts
import { getEventListeners } from 'node:events'
import { assert, it } from '@effect/vitest'
import { Effect, Exit, Fiber, Queue, Scope } from 'effect'
import { TestClock } from 'effect/testing'
import { Supervisor, SupervisorLive } from './supervisor.js'
import { awaitReady, IDLE, nodeSpec, ownScope, spawnStubborn } from './supervisor-fixtures.js'

it.layer(SupervisorLive)('Supervisor kill ladder', (suite) => {
  suite.effect('escalates SIGINT, SIGTERM after 5 s and SIGKILL after another 10 s', () =>
    Effect.gen(function* escalates() {
      const supervisor = yield* Supervisor
      const child = yield* spawnStubborn(supervisor)
      const lines = yield* awaitReady(child)
      const killing = yield* Effect.forkChild(child.kill(), { startImmediately: true })
      assert.strictEqual(yield* Queue.take(lines), 'SIGINT')
      yield* TestClock.adjust('5 seconds')
      assert.strictEqual(yield* Queue.take(lines), 'SIGTERM')
      yield* TestClock.adjust('10 seconds')
      yield* Fiber.join(killing)
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGKILL' })
    }),
  )

  suite.effect('stops at SIGINT when the process exits, without waiting out the grace period', () =>
    Effect.gen(function* stopsEarly() {
      const supervisor = yield* Supervisor
      const child = yield* supervisor.spawn(nodeSpec(IDLE))
      yield* awaitReady(child)
      yield* child.kill()
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGINT' })
    }),
  )

  suite.effect('sends only the signal it is given and does not wait', () =>
    Effect.gen(function* sendsOneSignal() {
      const supervisor = yield* Supervisor
      const child = yield* spawnStubborn(supervisor)
      const lines = yield* awaitReady(child)
      yield* child.kill('SIGTERM')
      assert.strictEqual(yield* Queue.take(lines), 'SIGTERM')
      yield* child.kill('SIGKILL')
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGKILL' })
    }),
  )
})

it.layer(SupervisorLive)('Supervisor kill by id', (suite) => {
  suite.effect('kills by id with the ladder and ignores an id nobody holds', () =>
    Effect.gen(function* killsById() {
      const supervisor = yield* Supervisor
      const child = yield* supervisor.spawn(nodeSpec(IDLE))
      yield* awaitReady(child)
      yield* supervisor.kill('no-such-process')
      yield* supervisor.kill(child.id)
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGINT' })
      assert.deepStrictEqual(yield* supervisor.list(), [])
    }),
  )

  suite.effect('kills by id with the signal it is given', () =>
    Effect.gen(function* killsByIdWithSignal() {
      const supervisor = yield* Supervisor
      const child = yield* spawnStubborn(supervisor)
      yield* awaitReady(child)
      yield* supervisor.kill(child.id, 'SIGKILL')
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGKILL' })
    }),
  )
})

it.layer(SupervisorLive)('Supervisor scope', (suite) => {
  suite.effect('terminates a running process when its scope closes', () =>
    Effect.gen(function* closesScope() {
      const supervisor = yield* Supervisor
      const scope = yield* ownScope
      const spawning = supervisor
        .spawn(nodeSpec(IDLE))
        .pipe(Effect.provideService(Scope.Scope, scope))
      const child = yield* spawning
      yield* awaitReady(child)
      yield* Scope.close(scope, Exit.void)
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGTERM' })
      assert.deepStrictEqual(yield* supervisor.list(), [])
    }),
  )

  suite.effect('kills a process that ignores SIGTERM ten seconds after its scope closes', () =>
    Effect.gen(function* escalatesOnClose() {
      const supervisor = yield* Supervisor
      const scope = yield* ownScope
      const child = yield* spawnStubborn(supervisor, scope)
      const lines = yield* awaitReady(child)
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void), {
        startImmediately: true,
      })
      assert.strictEqual(yield* Queue.take(lines), 'SIGTERM')
      yield* TestClock.adjust('10 seconds')
      yield* Fiber.join(closing)
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGKILL' })
    }),
  )
})

it.layer(SupervisorLive)('Supervisor abort signal', (suite) => {
  suite.effect('runs the kill ladder when the abort signal fires', () =>
    Effect.gen(function* abortsProcess() {
      const supervisor = yield* Supervisor
      const controller = new AbortController()
      const child = yield* supervisor.spawn(nodeSpec(IDLE, { signal: controller.signal }))
      yield* awaitReady(child)
      controller.abort()
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGINT' })
    }),
  )

  suite.effect('runs the kill ladder at once for a signal that has already aborted', () =>
    Effect.gen(function* abortsAtStart() {
      const supervisor = yield* Supervisor
      const child = yield* supervisor.spawn(nodeSpec(IDLE, { signal: AbortSignal.abort() }))
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGINT' })
    }),
  )

  suite.effect('leaves a process that has already exited alone when the signal fires later', () =>
    Effect.gen(function* abortsAfterExit() {
      const supervisor = yield* Supervisor
      const controller = new AbortController()
      const child = yield* supervisor.spawn(nodeSpec('0', { signal: controller.signal }))
      assert.deepStrictEqual(yield* child.exit, { code: 0, signal: null })
      controller.abort()
      assert.deepStrictEqual(yield* supervisor.list(), [])
    }),
  )
})

it.layer(SupervisorLive)('Supervisor abort listener', (suite) => {
  suite.effect('stops listening to the abort signal once its scope closes', () =>
    Effect.gen(function* releasesSignal() {
      const supervisor = yield* Supervisor
      const controller = new AbortController()
      const scope = yield* ownScope
      const spawning = supervisor
        .spawn(nodeSpec('0', { signal: controller.signal }))
        .pipe(Effect.provideService(Scope.Scope, scope))
      const child = yield* spawning
      yield* child.exit
      assert.strictEqual(getEventListeners(controller.signal, 'abort').length, 1)
      yield* Scope.close(scope, Exit.void)
      assert.strictEqual(getEventListeners(controller.signal, 'abort').length, 0)
    }),
  )
})
```
`packages/kernel/src/process/supervisor-group.test.ts`:
```ts
import { assert, it, vi } from '@effect/vitest'
import { Effect, Exit, Fiber, Queue, Scope } from 'effect'
import { TestClock } from 'effect/testing'
import { Supervisor, SupervisorLive } from './supervisor.js'
import {
  awaitReady,
  ESCAPED_HOLDER,
  hasEnded,
  HOLDER,
  IDLE,
  isPending,
  nodeSpec,
  ownScope,
  REAPING_HOLDER,
  spawnHolder,
  untilUnlisted,
} from './supervisor-fixtures.js'

// A grandchild that holds the pipes keeps the child's close event away, which exit must not wait for
it.layer(SupervisorLive)('Supervisor drain bound', (suite) => {
  suite.effect('resolves exit two seconds after a child whose grandchild left the group', () =>
    Effect.gen(function* boundsDrain() {
      const supervisor = yield* Supervisor
      const { child, lines } = yield* spawnHolder(supervisor, ESCAPED_HOLDER)
      yield* child.kill('SIGKILL')
      yield* untilUnlisted(supervisor)
      yield* TestClock.adjust('1999 millis')
      assert.ok(yield* isPending(child.exit))
      yield* TestClock.adjust('1 millis')
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGKILL' })
      assert.ok(yield* hasEnded(lines))
    }),
  )

  suite.effect('closes the scope within the same bound', () =>
    Effect.gen(function* closesBounded() {
      const supervisor = yield* Supervisor
      const scope = yield* ownScope
      const { child } = yield* spawnHolder(supervisor, ESCAPED_HOLDER, scope)
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void), {
        startImmediately: true,
      })
      yield* untilUnlisted(supervisor)
      yield* TestClock.adjust('2 seconds')
      yield* Fiber.join(closing)
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGTERM' })
    }),
  )
})

// A pid that has been free for a while may belong to somebody else, so a released process gets no signal
it.layer(SupervisorLive)('Supervisor released process', (suite) => {
  suite.effect('sends no signal to the group once the process has exited and been released', () =>
    Effect.gen(function* retiresProcess() {
      const supervisor = yield* Supervisor
      const child = yield* supervisor.spawn(nodeSpec(IDLE))
      yield* awaitReady(child)
      yield* child.kill()
      yield* child.exit
      const killGroup = vi.spyOn(process, 'kill').mockReturnValue(true)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          killGroup.mockRestore()
        }),
      )
      yield* child.kill('SIGTERM')
      assert.strictEqual(killGroup.mock.calls.length, 0)
    }),
  )
})

it.layer(SupervisorLive)('Supervisor process group', (suite) => {
  suite.effect('ends a grandchild of the same group with the child, so exit needs no drain', () =>
    Effect.gen(function* endsGroup() {
      const supervisor = yield* Supervisor
      const { child } = yield* spawnHolder(supervisor, HOLDER)
      yield* child.kill()
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGINT' })
    }),
  )

  suite.effect('signals the whole group and not only the child', () =>
    Effect.gen(function* signalsGroup() {
      const supervisor = yield* Supervisor
      const { child, lines, grandchildPid } = yield* spawnHolder(supervisor, REAPING_HOLDER)
      yield* child.kill('SIGINT')
      assert.strictEqual(yield* Queue.take(lines), 'grandchild SIGINT')
      assert.throws(() => {
        process.kill(grandchildPid, 0)
      }, /ESRCH/u)
      yield* child.kill('SIGKILL')
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGKILL' })
    }),
  )
})
```
`packages/kernel/src/process/kill-ladder.test.ts`:
```ts
import { assert, describe, expect, it } from '@effect/vitest'
import { Effect, Fiber, Latch, Queue } from 'effect'
import { TestClock } from 'effect/testing'
import {
  climb,
  GRACEFUL_LADDER,
  ladderFor,
  TERMINATE_LADDER,
  type KillSignal,
} from './kill-ladder.js'

interface Sent {
  readonly signal: KillSignal
  readonly at: number
}

// Every signal is stamped with the test clock when it is sent
const recorder = Effect.gen(function* makeRecorder() {
  const clock = yield* TestClock.testClockWith(Effect.succeed)
  const sent = yield* Queue.unbounded<Sent>()
  const send = (signal: KillSignal): void => {
    Queue.offerUnsafe(sent, { signal, at: clock.currentTimeMillisUnsafe() })
  }
  return { sent, send }
})

const settle = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, { discard: true })

// One millisecond short of the grace period nothing may be sent; the last millisecond sends the next signal
const nextAfter = (sent: Queue.Dequeue<Sent>, grace: number): Effect.Effect<Sent> =>
  Effect.gen(function* waitsOutGrace() {
    yield* TestClock.adjust(grace - 1)
    yield* settle
    assert.strictEqual(yield* Queue.size(sent), 0)
    yield* TestClock.adjust(1)
    return yield* Queue.take(sent)
  })

// A process that never exits gets every rung of the ladder, one grace period apart
const climbedAgainstStubborn = (
  rungs: Parameters<typeof climb>[0],
  graces: readonly number[],
): Effect.Effect<readonly Sent[]> =>
  Effect.gen(function* climbsAll() {
    const { sent, send } = yield* recorder
    const fiber = yield* Effect.forkChild(climb(rungs, send, Effect.never), {
      startImmediately: true,
    })
    const seen = [yield* Queue.take(sent)]
    for (const grace of graces) {
      seen.push(yield* nextAfter(sent, grace))
    }
    yield* Fiber.join(fiber)
    return seen
  })

describe(climb, () => {
  it.effect('sends SIGINT, SIGTERM after 5 s and SIGKILL after another 10 s', () =>
    Effect.gen(function* climbsFully() {
      const seen = yield* climbedAgainstStubborn(GRACEFUL_LADDER, [5000, 10_000])
      assert.deepStrictEqual(seen, [
        { signal: 'SIGINT', at: 0 },
        { signal: 'SIGTERM', at: 5000 },
        { signal: 'SIGKILL', at: 15_000 },
      ])
    }),
  )

  it.effect('starts at SIGTERM on the terminating ladder', () =>
    Effect.gen(function* climbsTerminating() {
      const seen = yield* climbedAgainstStubborn(TERMINATE_LADDER, [10_000])
      assert.deepStrictEqual(seen, [
        { signal: 'SIGTERM', at: 0 },
        { signal: 'SIGKILL', at: 10_000 },
      ])
    }),
  )
})

describe('climb that has nothing left to do', () => {
  it.effect('stops climbing as soon as the process has exited', () =>
    Effect.gen(function* stopsOnExit() {
      const { sent, send } = yield* recorder
      const exited = yield* Latch.make()
      const fiber = yield* Effect.forkChild(climb(GRACEFUL_LADDER, send, exited.await), {
        startImmediately: true,
      })
      yield* Queue.take(sent)
      yield* exited.open
      yield* Fiber.join(fiber)
      yield* TestClock.adjust('1 minute')
      yield* settle
      assert.strictEqual(yield* Queue.size(sent), 0)
    }),
  )

  it.effect('sends a single requested signal and does not wait', () =>
    Effect.gen(function* sendsOnce() {
      const { sent, send } = yield* recorder
      yield* climb(ladderFor('SIGTERM'), send, Effect.never)
      yield* TestClock.adjust('1 minute')
      yield* settle
      assert.deepStrictEqual(yield* Queue.takeAll(sent), [{ signal: 'SIGTERM', at: 0 }])
    }),
  )
})

describe(ladderFor, () => {
  it('is the graceful ladder without a signal and one rung for a signal', () => {
    expect(ladderFor()).toBe(GRACEFUL_LADDER)
    expect(ladderFor('SIGKILL')).toStrictEqual([{ signal: 'SIGKILL', grace: null }])
  })
})
```
`packages/kernel/src/process/pump.test.ts`:
```ts
import { PassThrough } from 'node:stream'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { assert, it } from '@effect/vitest'
import { Effect, Stream } from 'effect'
import { startPump } from './pump.js'

// Lets the event loop run, so what was written reaches the reader
const turn = Effect.promise(async () => {
  await nextTurn()
})

// The input has ended for good: every chunk has been through the reader by now
const closed = (input: PassThrough): Effect.Effect<void> =>
  Effect.callback((resume) => {
    input.once('close', () => {
      resume(Effect.void)
    })
  })

it.effect('queues the lines that arrive before anybody reads the stream', () =>
  Effect.gen(function* queuesEarlyLines() {
    const input = new PassThrough()
    const pump = yield* startPump(input, 10)
    input.end('early\nlines\n')
    yield* closed(input)
    yield* pump.finish
    assert.deepStrictEqual(yield* Stream.runCollect(pump.lines), ['early', 'lines'])
  }),
)

it.effect('splits CRLF and keeps an unterminated last line', () =>
  Effect.gen(function* splitsLines() {
    const input = new PassThrough()
    const pump = yield* startPump(input, 10)
    input.end('one\r\ntwo\nthree')
    yield* closed(input)
    yield* pump.finish
    assert.deepStrictEqual(yield* Stream.runCollect(pump.lines), ['one', 'two', 'three'])
    assert.deepStrictEqual(pump.recent(), ['one', 'two', 'three'])
  }),
)

it.effect('keeps blank lines', () =>
  Effect.gen(function* keepsBlankLines() {
    const input = new PassThrough()
    const pump = yield* startPump(input, 10)
    input.end('one\n\ntwo\n\n')
    yield* closed(input)
    yield* pump.finish
    assert.deepStrictEqual(yield* Stream.runCollect(pump.lines), ['one', '', 'two', ''])
  }),
)

it.effect('breaks at a lone CR and counts CRLF as one break', () =>
  Effect.gen(function* breaksAtCarriageReturn() {
    const input = new PassThrough()
    const pump = yield* startPump(input, 10)
    input.end('a\rb\r\nc\r\r\nd\r')
    yield* closed(input)
    yield* pump.finish
    assert.deepStrictEqual(yield* Stream.runCollect(pump.lines), ['a', 'b', 'c', '', 'd'])
  }),
)

it.effect('joins a CRLF that arrives in two chunks', () =>
  Effect.gen(function* joinsSplitCrlf() {
    const input = new PassThrough()
    const pump = yield* startPump(input, 10)
    input.write('a\r')
    yield* turn
    input.end('\nb\n')
    yield* closed(input)
    yield* pump.finish
    assert.deepStrictEqual(yield* Stream.runCollect(pump.lines), ['a', 'b'])
  }),
)

it.effect('streams without keeping any recent line when the capacity is zero', () =>
  Effect.gen(function* keepsNothing() {
    const input = new PassThrough()
    const pump = yield* startPump(input, 0)
    input.end('a\nb\n')
    yield* closed(input)
    yield* pump.finish
    assert.deepStrictEqual(yield* Stream.runCollect(pump.lines), ['a', 'b'])
    assert.deepStrictEqual(pump.recent(), [])
  }),
)

it.effect('keeps the newest lines for diagnostics while the stream carries every line', () =>
  Effect.gen(function* boundsRecent() {
    const input = new PassThrough()
    const pump = yield* startPump(input, 2)
    input.end('a\nb\nc\nd\n')
    yield* closed(input)
    yield* pump.finish
    assert.deepStrictEqual(pump.recent(), ['c', 'd'])
    assert.deepStrictEqual(yield* Stream.runCollect(pump.lines), ['a', 'b', 'c', 'd'])
  }),
)

it.effect('appends a line that did not come from the input', () =>
  Effect.gen(function* appendsLine() {
    const input = new PassThrough()
    const pump = yield* startPump(input, 5)
    pump.append('spawn failed')
    input.end()
    yield* closed(input)
    yield* pump.finish
    assert.deepStrictEqual(yield* Stream.runCollect(pump.lines), ['spawn failed'])
    assert.deepStrictEqual(pump.recent(), ['spawn failed'])
  }),
)

it.effect('ends without a line when there is no input at all', () =>
  Effect.gen(function* endsWithoutInput() {
    const pump = yield* startPump(null, 5)
    yield* pump.finish
    assert.deepStrictEqual(yield* Stream.runCollect(pump.lines), [])
    assert.deepStrictEqual(pump.recent(), [])
  }),
)

it.effect('closes an input that never signals its end', () =>
  Effect.gen(function* closesOpenInput() {
    const input = new PassThrough()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        input.destroy()
      }),
    )
    const pump = yield* startPump(input, 5)
    yield* pump.finish
    input.write('late\n')
    yield* turn
    assert.deepStrictEqual(pump.recent(), [])
    assert.deepStrictEqual(yield* Stream.runCollect(pump.lines), [])
  }),
)

it.effect('keeps what was read and ends the stream when the input fails', () =>
  Effect.gen(function* survivesBrokenInput() {
    const input = new PassThrough()
    const pump = yield* startPump(input, 5)
    input.write('kept\n')
    yield* turn
    input.destroy(new Error('broken pipe'))
    yield* closed(input)
    yield* pump.finish
    assert.deepStrictEqual(yield* Stream.runCollect(pump.lines), ['kept'])
  }),
)
```
`packages/kernel/src/process/launch.test.ts`:
```ts
import { describe, expect, it, onTestFinished, vi, type MockInstance } from 'vitest'
import { describeFailure, signalGroup } from './launch.js'

// With process.kill replaced, a wrong pid can never reach a real process or group
const stubProcessKill = (implementation: () => true): MockInstance<typeof process.kill> => {
  const stub = vi.spyOn(process, 'kill').mockImplementation(implementation)
  onTestFinished(() => {
    stub.mockRestore()
  })
  return stub
}

describe(signalGroup, () => {
  it('signals the whole process group of the child', () => {
    const killGroup = stubProcessKill(() => true)
    const kill = vi.fn<() => boolean>(() => true)
    signalGroup({ pid: 4242, kill }, 'SIGTERM')
    expect(killGroup).toHaveBeenCalledExactlyOnceWith(-4242, 'SIGTERM')
    expect(kill).not.toHaveBeenCalled()
  })

  it('falls back to the child when there is no such group', () => {
    stubProcessKill(() => {
      throw new Error('kill ESRCH')
    })
    const kill = vi.fn<() => boolean>(() => true)
    signalGroup({ pid: 4242, kill }, 'SIGKILL')
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
  })

  it.each([undefined, 0, 1])('never signals a group for the pid %s', (pid) => {
    const killGroup = stubProcessKill(() => true)
    const kill = vi.fn<() => boolean>(() => true)
    signalGroup({ pid, kill }, 'SIGTERM')
    expect(killGroup).not.toHaveBeenCalled()
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  })
})

describe(describeFailure, () => {
  it('gives a system error as its message', () => {
    const error = Object.assign(new Error('spawn tool ENOENT'), { code: 'ENOENT' })
    expect(describeFailure(error)).toBe('spawn tool ENOENT')
  })

  it.each(['ERR_INVALID_ARG_VALUE', 'ERR_INVALID_ARG_TYPE'])(
    'names an invalid argument by its code %s and leaves the offending value out',
    (code) => {
      const error = Object.assign(new Error("Received 'swordfish'"), { code })
      const text = describeFailure(error)
      expect(text).toContain(code)
      expect(text).not.toContain('swordfish')
    },
  )

  it('gives an error without a code as its message', () => {
    expect(describeFailure(new Error('boom'))).toBe('boom')
  })

  it('turns a thrown value that is no error into text', () => {
    expect(describeFailure('plain')).toBe('plain')
  })
})
```
`packages/kernel/src/process/supervisor-fixtures.ts` (shared fixtures):
```ts
import { Effect, Exit, Option, Queue, Scope, Stream, type Cause } from 'effect'
import type { ManagedProcess, SpawnSpec, Supervisor } from './supervisor.js'

export const node = process.execPath

// A helper process that runs one Node script
export const nodeSpec = (script: string, rest: Partial<SpawnSpec> = {}): SpawnSpec => ({
  kind: 'helper',
  command: node,
  args: ['-e', script],
  cwd: process.cwd(),
  ...rest,
})

// Announces itself once it runs, then idles until a signal ends it
export const IDLE = 'console.log("ready"); setInterval(() => {}, 1000)'

// Reports SIGINT and SIGTERM instead of dying from them, so only SIGKILL ends it
const STUBBORN = `for (const name of ["SIGINT", "SIGTERM"]) process.on(name, () => console.log(name)); ${IDLE}`

type Lines = Queue.Dequeue<string, Cause.Done>

// The lines of a stream, taken one at a time; taking past the end of the stream fails
const lineQueue = (stream: Stream.Stream<string>): Effect.Effect<Lines, never, Scope.Scope> =>
  Effect.gen(function* collectsLines() {
    const queue = yield* Queue.unbounded<string, Cause.Done>()
    const feeding = Stream.runForEach(stream, (line) => Queue.offer(queue, line)).pipe(
      Effect.ensuring(Queue.end(queue)),
    )
    yield* Effect.forkScoped(feeding)
    return queue
  })

// The child has printed "ready", so its signal handlers are installed
export const awaitReady = (child: ManagedProcess): Effect.Effect<Lines, Cause.Done, Scope.Scope> =>
  Effect.gen(function* awaitsReady() {
    const lines = yield* lineQueue(child.stdout)
    yield* Queue.take(lines)
    return lines
  })

// The child starts a grandchild that inherits the pipes and idles, then prints the grandchild's pid
const startsGrandchild = (detached: boolean): string =>
  `const grand = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit", detached: ${detached} }); console.log("up " + grand.pid)`

// The grandchild is in the child's process group: a signal to the group reaches both
export const HOLDER = `${startsGrandchild(false)}; setInterval(() => {}, 1000)`

// The grandchild has left the group, so only a pipe ties it to the child
export const ESCAPED_HOLDER = `${startsGrandchild(true)}; setInterval(() => {}, 1000)`

// Ignores SIGINT and reports how its grandchild ends, which only the grandchild's parent, which reaps it, can see
export const REAPING_HOLDER = `process.on("SIGINT", () => {}); ${startsGrandchild(false)}; grand.on("exit", (code, signal) => console.log("grandchild " + signal)); setInterval(() => {}, 1000)`

// Only SIGKILL ends it, so the test's own scope sends that when the test ends, or fails halfway
export const spawnStubborn = (
  supervisor: Supervisor['Service'],
  scope?: Scope.Scope,
): Effect.Effect<ManagedProcess, never, Scope.Scope> =>
  Effect.gen(function* spawnsStubborn() {
    const spawning = supervisor.spawn(nodeSpec(STUBBORN))
    const child = yield* scope === undefined
      ? spawning
      : Effect.provideService(spawning, Scope.Scope, scope)
    yield* Effect.addFinalizer(() => child.kill('SIGKILL'))
    return child
  })

// A scope of the test's own, closed with the test's scope unless the test closed it before
export const ownScope: Effect.Effect<Scope.Closeable, never, Scope.Scope> = Effect.acquireRelease(
  Scope.make(),
  (scope) => Scope.close(scope, Exit.void),
)

// Sets a variable of this process until the test's scope closes
export const withEnv = (name: string, value: string): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const before = process.env[name]
      process.env[name] = value
      return before
    }),
    (before) =>
      Effect.sync(() => {
        if (before === undefined) {
          Reflect.deleteProperty(process.env, name)
        } else {
          process.env[name] = before
        }
      }),
  ).pipe(Effect.asVoid)

const killQuietly = (pid: number): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // The process is gone already
    }
  })

interface Held {
  readonly child: ManagedProcess
  readonly lines: Lines
  readonly grandchildPid: number
}

// A child with a grandchild on its pipes; both are killed when the test's scope closes, whatever the test did
export const spawnHolder = (
  supervisor: Supervisor['Service'],
  script: string,
  scope?: Scope.Scope,
): Effect.Effect<Held, Cause.Done, Scope.Scope> =>
  Effect.gen(function* spawnsHolder() {
    const spawning = supervisor.spawn(nodeSpec(script))
    const child = yield* scope === undefined
      ? spawning
      : Effect.provideService(spawning, Scope.Scope, scope)
    yield* Effect.addFinalizer(() => child.kill('SIGKILL'))
    const lines = yield* lineQueue(child.stdout)
    const grandchildPid = Number((yield* Queue.take(lines)).replace('up ', ''))
    yield* Effect.addFinalizer(() => killQuietly(grandchildPid))
    return { child, lines, grandchildPid }
  })

// The registry lets go of a process as soon as it has exited, which real events decide, hence the turns of the event loop
export const untilUnlisted = (supervisor: Supervisor['Service']): Effect.Effect<void> =>
  Effect.gen(function* waitsForExit() {
    while ((yield* supervisor.list()).length > 0) {
      yield* Effect.yieldNow
    }
  })

// Under the test clock a timeout of zero ends at once, so this tells whether the effect has completed yet
export const isPending = (effect: Effect.Effect<unknown>): Effect.Effect<boolean> =>
  Effect.map(Effect.timeoutOption(effect, 0), (done) => Option.isNone(done))

// The stream behind the queue has ended: taking another line fails
export const hasEnded = (lines: Lines): Effect.Effect<boolean> =>
  Effect.map(Effect.exit(Queue.take(lines)), (taken) => Exit.isFailure(taken))
```
Under `it.effect` the ladder's sleeps are `TestClock` sleeps; the shipped tests replace the 200 ms live sleep with a `ready` line and the child echoing each signal, so there are no real sleeps.

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
// Bounded ring of the newest lines; the Supervisor keeps one for stderr, stdout is streamed and nothing else
export class LineBuffer {
  public dropped = 0
  private readonly items: string[] = []
  private readonly limit: number

  public constructor(limit: number) {
    this.limit = limit
  }

  public push(line: string): void {
    this.items.push(line)
    if (this.items.length > this.limit) {
      this.items.shift()
      this.dropped += 1
    }
  }

  public lines(): readonly string[] {
    return [...this.items]
  }
}
```
`packages/kernel/src/process/pump.ts`:
```ts
import { createInterface, type Interface } from 'node:readline'
import type { Readable } from 'node:stream'
import { Effect, Queue, Stream, type Cause } from 'effect'
import { LineBuffer } from './line-buffer.js'

export interface OutputPump {
  // One consumer at a time: the queue hands each line to whoever takes it
  readonly lines: Stream.Stream<string>
  // The newest lines, whether or not anybody reads the stream
  readonly recent: () => readonly string[]
  // For a line that did not come from the input; it has to come before finish
  readonly append: (line: string) => void
  // The input is done: an input that never signalled its end is closed and the stream ends
  readonly finish: Effect.Effect<void>
}

// Lines are taken from readline's line event, as it emits them, and not from its async iterator
// Once its consumer yields to the event loop the iterator throws ERR_USE_AFTER_CLOSE and loses the last line
// It does so on Bun and on Node 24.14 alike, over 8000 lines from a real pipe
const openReader = (input: Readable | null, onLine: (line: string) => void): Interface | null => {
  if (input === null) {
    return null
  }
  const reader = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
  reader.on('line', onLine)
  // A read error ends the reading; an error event nobody listens to would throw
  reader.on('error', () => {
    reader.close()
  })
  return reader
}

// Reads eagerly into an unbounded queue, so recent() is current even when nobody consumes the stream
// A maxLines of 0 keeps no recent lines at all
export const startPump = (input: Readable | null, maxLines: number): Effect.Effect<OutputPump> =>
  Effect.gen(function* startOutputPump() {
    const queue = yield* Queue.unbounded<string, Cause.Done>()
    const buffer = maxLines > 0 ? new LineBuffer(maxLines) : null
    const record = (line: string): void => {
      if (buffer !== null) {
        buffer.push(line)
      }
      Queue.offerUnsafe(queue, line)
    }
    const reader = openReader(input, record)
    const closeReader = Effect.sync(() => {
      if (reader !== null) {
        reader.close()
      }
    })
    const finish = closeReader.pipe(Effect.andThen(Queue.end(queue)), Effect.asVoid)
    const recent = (): readonly string[] => (buffer === null ? [] : buffer.lines())
    return { lines: Stream.fromQueue(queue), recent, append: record, finish }
  })
```
`packages/kernel/src/process/kill-ladder.ts`:
```ts
import { Effect, Option, type Duration } from 'effect'

export type KillSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL'

// A signal and how long the process gets to exit before the next, harsher one
interface Rung {
  readonly signal: KillSignal
  readonly grace: Duration.Input | null
}

export const GRACEFUL_LADDER: readonly Rung[] = [
  { signal: 'SIGINT', grace: '5 seconds' },
  { signal: 'SIGTERM', grace: '10 seconds' },
  { signal: 'SIGKILL', grace: null },
]

// A closing scope skips the polite SIGINT
export const TERMINATE_LADDER: readonly Rung[] = GRACEFUL_LADDER.slice(1)

export const ladderFor = (signal?: KillSignal): readonly Rung[] =>
  signal === undefined ? GRACEFUL_LADDER : [{ signal, grace: null }]

// Sends each signal in turn; a rung with a grace period gives the process that long to exit first
export const climb = (
  rungs: readonly Rung[],
  send: (signal: KillSignal) => void,
  exited: Effect.Effect<unknown>,
): Effect.Effect<void> =>
  Effect.gen(function* climbLadder() {
    for (const { signal, grace } of rungs) {
      send(signal)
      if (grace === null) {
        return
      }
      const gone = yield* Effect.timeoutOption(exited, grace)
      if (Option.isSome(gone)) {
        return
      }
    }
  })
```
`packages/kernel/src/process/child-env.ts`:
```ts
import { Effect, Option } from 'effect'
import { Headers, HttpTraceContext } from 'effect/http'
import { allowlistEnv } from './env-allowlist.js'

interface EnvRequest {
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly passEnv?: readonly string[] | undefined
}

const traceparent: Effect.Effect<Record<string, string>> = Effect.currentSpan.pipe(
  Effect.option,
  Effect.map(
    Option.flatMap((span) => Headers.get(HttpTraceContext.toHeaders(span), 'traceparent')),
  ),
  Effect.map(
    Option.match({
      onNone: (): Record<string, string> => ({}),
      onSome: (value): Record<string, string> => ({ TRACEPARENT: value }),
    }),
  ),
)

// The daemon's allowlisted variables, then the spec's, then the current span, which wins
const merged = (spec: EnvRequest, trace: Record<string, string>): Record<string, string> => ({
  ...allowlistEnv(process.env, spec.passEnv),
  ...allowlistEnv(spec.env ?? {}, spec.passEnv),
  ...trace,
})

export const childEnv = (spec: EnvRequest): Effect.Effect<Record<string, string>> =>
  traceparent.pipe(Effect.map((trace) => merged(spec, trace)))
```
`packages/kernel/src/process/launch.ts`:
```ts
import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import { Deferred, Effect, Latch } from 'effect'
import { constVoid } from 'effect/Function'
import type { KillSignal } from './kill-ladder.js'

export interface ExitInfo {
  readonly code: number | null
  readonly signal: string | null
}

// How a process ended, or why it never started
interface Exited {
  readonly exit: ExitInfo
  readonly failure: string | null
}

interface LaunchSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
}

// A started child, or what is left of one that failed to start
export interface Launched {
  readonly pid: number
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  // To the child's whole process group, until the process is retired
  readonly kill: (signal: KillSignal) => void
  // The process has exited, or it never started
  readonly exited: Deferred.Deferred<Exited>
  // Every pipe of the child is released, which a grandchild that holds one can delay for good
  readonly closed: Latch.Latch
  // Nothing is left to signal; a pid that has been free for a while may belong to somebody else
  readonly retire: () => void
}

interface Gates {
  readonly exited: Deferred.Deferred<Exited>
  readonly closed: Latch.Latch
  readonly retired: Latch.Latch
}

// What a process that never started, such as a command that does not exist, reports
const NOT_STARTED: ExitInfo = { code: -1, signal: null }

const INVALID_ARGUMENT = 'ERR_INVALID_ARG'

// A system error says what it is; an invalid argument would echo the value, which may be a secret
export const describeFailure = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return String(error)
  }
  const code = 'code' in error ? error.code : undefined
  return typeof code === 'string' && code.startsWith(INVALID_ARGUMENT)
    ? `${code}: the command, an argument, the working directory or an environment value is invalid`
    : error.message
}

// The pids 0 and 1 would address the caller's own group and every process
const killGroup = (pid: number | undefined, signal: KillSignal): boolean => {
  if (pid === undefined || pid <= 1) {
    return false
  }
  try {
    return process.kill(-pid, signal)
  } catch {
    return false
  }
}

// A child leads a process group of its own, so what it started receives the signal as well
// Without a group, or with none left, the child is the one to signal
export const signalGroup = (
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  signal: KillSignal,
): void => {
  if (!killGroup(child.pid, signal)) {
    child.kill(signal)
  }
}

const complete = <Value>(deferred: Deferred.Deferred<Value>, value: Value): void => {
  Deferred.doneUnsafe(deferred, Effect.succeed(value))
}

const makeGates = (): Gates => ({
  exited: Deferred.makeUnsafe<Exited>(),
  closed: Latch.makeUnsafe(),
  retired: Latch.makeUnsafe(),
})

// The listeners go on before anything else can run, since an error event nobody listens to throws
const watch = (child: ChildProcess, { exited, closed }: Gates): void => {
  child.on('exit', (code, signal) => {
    complete(exited, { exit: { code, signal }, failure: null })
  })
  child.on('close', (code, signal) => {
    complete(exited, { exit: { code, signal }, failure: null })
    Latch.openUnsafe(closed)
  })
  // A process that started only reports here that a signal could not be delivered
  child.on('error', (error) => {
    if (child.pid === undefined) {
      complete(exited, { exit: NOT_STARTED, failure: describeFailure(error) })
    }
  })
}

const started = (child: ChildProcess, gates: Gates): Launched => {
  watch(child, gates)
  const { exited, closed, retired } = gates
  return {
    pid: child.pid ?? -1,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: (signal) => {
      if (!Latch.isOpen(retired)) {
        signalGroup(child, signal)
      }
    },
    exited,
    closed,
    retire: () => {
      Latch.openUnsafe(retired)
    },
  }
}

const failed = (error: unknown, { exited, closed }: Gates): Launched => {
  complete(exited, { exit: NOT_STARTED, failure: describeFailure(error) })
  Latch.openUnsafe(closed)
  return { pid: -1, stdout: null, stderr: null, kill: constVoid, exited, closed, retire: constVoid }
}

// Whichever way the runtime reports that a process cannot start, an event or a throw, it ends the same
export function launch(spec: LaunchSpec, env: Record<string, string>): Launched {
  const gates = makeGates()
  try {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return started(child, gates)
  } catch (error) {
    return failed(error, gates)
  }
}
```
`packages/kernel/src/process/supervisor.ts`:
```ts
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Schedule,
  type Duration,
  type Scope,
  type Stream,
} from 'effect'
import { nowIso, uuidv7 } from '../ids.js'
import { childEnv } from './child-env.js'
import { launch, type ExitInfo, type Launched } from './launch.js'
import { climb, ladderFor, TERMINATE_LADDER, type KillSignal } from './kill-ladder.js'
import { startPump, type OutputPump } from './pump.js'

export type { ExitInfo } from './launch.js'
export type { KillSignal } from './kill-ladder.js'

type ProcessKind = 'agent' | 'git' | 'helper'

export interface SpawnSpec {
  readonly kind: ProcessKind
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly passEnv?: readonly string[] | undefined
  readonly signal?: AbortSignal | undefined
  // Bounds only recentStderr(); a stream nobody reads keeps every line queued in memory
  readonly maxLines?: number | undefined
}

export interface ManagedProcess {
  readonly id: string
  // -1 for a process that never started
  readonly pid: number
  // One consumer at a time; lines nobody has read stay queued in memory until they are
  readonly stdout: Stream.Stream<string>
  readonly stderr: Stream.Stream<string>
  // Resolves once the process has exited and its output is queued, two seconds after the exit at most
  readonly exit: Effect.Effect<ExitInfo>
  // Without a signal the whole ladder runs, with one that signal alone is sent; the signal goes to the process group
  readonly kill: (signal?: KillSignal) => Effect.Effect<void>
  readonly recentStderr: () => readonly string[]
}

export interface ProcessInfo {
  readonly id: string
  readonly kind: ProcessKind
  readonly command: string
  readonly pid: number
  readonly startedAt: string
}

interface SupervisorShape {
  readonly spawn: (spec: SpawnSpec) => Effect.Effect<ManagedProcess, never, Scope.Scope>
  readonly kill: (id: string, signal?: KillSignal) => Effect.Effect<void>
  readonly list: () => Effect.Effect<readonly ProcessInfo[]>
}

export class Supervisor extends Context.Service<Supervisor, SupervisorShape>()('bb/Supervisor') {}

const DEFAULT_MAX_LINES = 10_000

// How long the pipes of an exited process get to run dry; a grandchild that holds one can keep it open for good
const DRAIN = '2 seconds'

// Backoff between restarts of a crashed process: 500 ms doubling, jittered, at most maxRestarts times
export const restartSchedule = (maxRestarts: number): Schedule.Schedule<Duration.Duration> =>
  Schedule.max([
    Schedule.exponential('500 millis').pipe(Schedule.jittered),
    Schedule.recurs(maxRestarts),
  ])

const killer =
  (launched: Launched): ManagedProcess['kill'] =>
  (signal) =>
    climb(ladderFor(signal), launched.kill, Deferred.await(launched.exited))

// Scope close: SIGTERM, then SIGKILL when the process ignores it for ten seconds
const terminate = (launched: Launched, exit: Effect.Effect<ExitInfo>): Effect.Effect<void> =>
  climb(TERMINATE_LADDER, launched.kill, Deferred.await(launched.exited)).pipe(
    Effect.andThen(exit),
    Effect.asVoid,
  )

const awaitAbort = (signal: AbortSignal): Effect.Effect<void> =>
  Effect.callback((resume) => {
    const onAbort = (): void => {
      resume(Effect.void)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
    }
    return Effect.sync(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })

const killOnAbort = (signal: AbortSignal, managed: ManagedProcess): Effect.Effect<void> =>
  Effect.andThen(awaitAbort(signal), managed.kill())

interface Running {
  readonly id: string
  readonly launched: Launched
  readonly stdout: OutputPump
  readonly stderr: OutputPump
}

const startRunning = (spec: SpawnSpec): Effect.Effect<Running> =>
  Effect.gen(function* startsProcess() {
    const env = yield* childEnv(spec)
    const launched = launch(spec, env)
    // Only stderr is kept for diagnostics, stdout is streamed and nothing else
    const stdout = yield* startPump(launched.stdout, 0)
    const stderr = yield* startPump(launched.stderr, spec.maxLines ?? DEFAULT_MAX_LINES)
    return { id: uuidv7(), launched, stdout, stderr }
  })

// The process has exited: the registry lets go at once, its pipes get two seconds to run dry and both pumps finish
// The pipes are what a grandchild can hold open, the process itself is what exit reports
const settleExit = (running: Running, release: () => void): Effect.Effect<ExitInfo> =>
  Effect.gen(function* settlesExit() {
    const { launched } = running
    const { exit, failure } = yield* Deferred.await(launched.exited)
    release()
    yield* Effect.timeoutOption(launched.closed.await, DRAIN)
    if (failure !== null) {
      running.stderr.append(failure)
    }
    yield* running.stdout.finish
    yield* running.stderr.finish
    launched.retire()
    return exit
  })

const present = (running: Running, exit: Effect.Effect<ExitInfo>): ManagedProcess => ({
  id: running.id,
  pid: running.launched.pid,
  stdout: running.stdout.lines,
  stderr: running.stderr.lines,
  exit,
  kill: killer(running.launched),
  recentStderr: running.stderr.recent,
})

interface Entry {
  readonly info: ProcessInfo
  readonly kill: ManagedProcess['kill']
}

type Registry = Map<string, Entry>

const entryOf = (spec: SpawnSpec, running: Running): Entry => ({
  info: {
    id: running.id,
    kind: spec.kind,
    command: spec.command,
    pid: running.launched.pid,
    startedAt: nowIso(),
  },
  kill: killer(running.launched),
})

// The fibers and the finalizer hang on the caller's scope, not on the fiber that happens to spawn
// The settle fiber is forked before the finalizer, so the finalizer runs first and the process is gone before it is interrupted
// The abort watcher is forked after the finalizer and is interrupted first, which does no harm
// Nothing may interrupt the spawn halfway: a process without its finalizer would be orphaned
const spawnProcess = (
  registry: Registry,
  spec: SpawnSpec,
): Effect.Effect<ManagedProcess, never, Scope.Scope> =>
  Effect.gen(function* spawnManaged() {
    const running = yield* startRunning(spec)
    registry.set(running.id, entryOf(spec, running))
    const release = (): void => {
      registry.delete(running.id)
    }
    const settled = yield* Effect.forkScoped(settleExit(running, release))
    const managed = present(running, Fiber.join(settled))
    yield* Effect.addFinalizer(() => terminate(running.launched, managed.exit))
    if (spec.signal !== undefined) {
      yield* Effect.forkScoped(killOnAbort(spec.signal, managed))
    }
    return managed
  }).pipe(Effect.uninterruptible)

const killById = (
  registry: Registry,
  id: string,
  signal: KillSignal | undefined,
): Effect.Effect<void> => {
  const entry = registry.get(id)
  return entry === undefined ? Effect.void : entry.kill(signal)
}

const make = Effect.sync(() => {
  const registry: Registry = new Map()
  return Supervisor.of({
    spawn: (spec) => spawnProcess(registry, spec),
    kill: (id, signal) => killById(registry, id, signal),
    list: () => Effect.sync(() => [...registry.values()].map((entry) => entry.info)),
  })
})

export const SupervisorLive: Layer.Layer<Supervisor> = Layer.effect(Supervisor, make)
```
Verified in Effect 4.0.0: there is no `Effect.async` (`Effect.callback((resume, signal) => …)` is the constructor) and no `Schedule.both` (`restartSchedule` is `Schedule.max([Schedule.exponential('500 millis').pipe(Schedule.jittered), Schedule.recurs(max)])`, the intersection); `Queue.end` needs `Queue.unbounded<string, Cause.Done>()`; `Effect.yieldNow` is a value; the service type is `Supervisor['Service']`. Node callbacks use only `Deferred.doneUnsafe` and `Queue.offerUnsafe`; the spawn region runs uninterruptible.

Add to `index.ts`: `export { Supervisor, SupervisorLive, restartSchedule, type SpawnSpec, type ManagedProcess, type ExitInfo, type ProcessInfo, type KillSignal } from './process/supervisor.js'`, `export { allowlistEnv } from './process/env-allowlist.js'`.

- [ ] **Step 3: Run, commit**

Run: `bunx vitest run --project kernel` → PASS. `bun run check` → green.

```bash
git add packages/kernel
git commit -m "feat(kernel): supervise child processes with an env allowlist, line streams and a kill ladder"
```

### Task 9: `plugins/workspace-local` — git worktree runtime (first-party plugin)

**Files:**
- Create: `plugins/workspace-local/package.json`, `plugins/workspace-local/tsconfig.json`, `plugins/workspace-local/vitest.config.ts`, `plugins/workspace-local/src/plugin.ts`, `plugins/workspace-local/src/errors.ts`, `plugins/workspace-local/src/local-runtime.ts`, `plugins/workspace-local/src/worktree-files.ts`, `plugins/workspace-local/src/keyed-queue.ts`, `plugins/workspace-local/src/git.ts`, `plugins/workspace-local/src/status-parser.ts`, `plugins/workspace-local/src/testing/node-spawner.ts`, `plugins/workspace-local/src/testing/temp-repo.ts`, `plugins/workspace-local/src/testing/fixtures.ts`, and the tests `local-runtime.test.ts`, `local-runtime-lifecycle.test.ts`, `provision-base.test.ts`, `provision-files.test.ts`, `worktree-files.test.ts`, `keyed-queue.test.ts`, `status-parser.test.ts`, `plugin.test.ts`, `testing/node-spawner.test.ts` (the lint caps split the brief's runtime and suite)
- Modify: `vitest.config.ts` (project + coverage include `plugins/*/src/**/*.ts`, exclude `**/testing/**`), `knip.ts` (workspace, no `entry` — knip flags it as redundant), `.github/workflows/semantic-pr.yml` (`workspace-local` scope), `cspell-words.txt`, `bun.lock`; `commitlint.config.ts` needs nothing (`plugins/*` directories are already scope names); the root `lint:long-tail` script now lints `plugins/` too

**Interfaces:**
- Consumes: `WorkspaceRuntime`, `WorkspaceSpec`, `WorkspaceHandle`, `WorkspaceStatus`, `ExecSpec`, `ExecHandle`, `ProcessSpawner`, `Logger`, `PluginContext`, `definePlugin` from `@bytebureau/plugin-api` (Task 2).
- Produces: `localWorkspacePlugin` (the `Plugin` the kernel bundles), `LocalWorkspaceRuntime` (class, `id: 'local'`, `isolation: 'none'`), `createGit(spawn, logger)` returning the typed git wrapper (`must` throws `WorkspaceError('git_failed')`; there is no `GitError`), `parseStatusV2(text)` (dirty flag and branch; ahead/behind come from `git rev-list --left-right --count <base>...HEAD` because `# branch.ab` appears only with an upstream), `WorkspaceError` (in `src/errors.ts`) with `code ∈ 'not_a_repository' | 'is_bytebureau_worktree' | 'git_too_old' | 'locked' | 'dirty' | 'git_failed' | 'fs_failed'`.

Semantics (as shipped): the session marker `.bytebureau-session.json` is excluded from git together with `.bytebureau/` (otherwise every fresh worktree is dirty); the exclude file comes from `git rev-parse --path-format=absolute --git-path info/exclude` (a project that is itself a linked worktree keeps it in the common directory); "pick a free branch name + `worktree add --no-track`" is serialised per toplevel through `keyed-queue.ts`, so same-name fan-outs get `-2`, `-3`, … (local refs only — a branch that exists only on `origin` is not a collision); `status()` runs `git status --porcelain=v2 --branch --untracked-files=normal` (the user's `status.showUntrackedFiles` cannot hide agent files) and fails `git_failed` when the base ref no longer resolves, while `destroy()` checks only dirty and lock state so a worktree whose base is gone can still be removed with `force`; `copyIgnored` entries are confined to regular files inside the project after `realpathSync` (links outside are skipped with a warning); a failure after `worktree add` rolls back (`worktree remove --force`, `branch -D`) and file-system errors are `fs_failed`; a missing project directory is `not_a_repository`; a toplevel at `…/.bytebureau/worktrees/<id>` counts as a ByteBureau worktree even without the marker; provisioning warnings go to `WorkspaceSpec.logger`. The test spawner maps abort and start failures into `exited` like the kernel's supervisor and runs git with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`; it drops the output of a process that exited before anyone started reading, so tests read streams at once.

- [ ] **Step 1: Package manifests**

`plugins/workspace-local/package.json`:
```json
{
  "name": "@bytebureau/workspace-local",
  "version": "0.0.0",
  "private": true,
  "description": "ByteBureau workspace runtime: one git worktree per session on the host",
  "license": "FSL-1.1-MIT",
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/plugin.ts",
      "default": "./src/plugin.ts"
    },
    "./plugin": {
      "types": "./src/plugin.ts",
      "default": "./src/plugin.ts"
    }
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@bytebureau/plugin-api": "workspace:*"
  },
  "devDependencies": {
    "@bytebureau/tsconfig": "workspace:*"
  },
  "bytebureau": {
    "name": "workspace-local",
    "hostApi": "^0",
    "kind": "in-process",
    "capabilities": [
      "fs:read",
      "fs:write",
      "process"
    ],
    "contributes": {
      "workspaceRuntimes": [
        "local"
      ]
    }
  }
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

const renamed = `${clean}2 R. N... 100644 100644 100644 abc def R100 new.ts\told.ts
`
const unmerged = `${clean}u UU N... 100644 100644 100644 100644 abc def ghi conflict.ts
`
const ignored = `${clean}! build/output.log
`

describe(parseStatusV2, () => {
  it('reads branch name and ahead/behind from the headers', () => {
    expect(parseStatusV2(clean)).toStrictEqual({
      dirty: false,
      ahead: 2,
      behind: 1,
      branch: 'bb/add-hello',
    })
  })

  it('reports dirty when any change or untracked entry is present', () => {
    expect(parseStatusV2(dirty).dirty).toBe(true)
  })

  it.each([
    ['a renamed file', renamed],
    ['an unmerged file', unmerged],
  ])('reports %s as dirty', (_name, text) => {
    expect(parseStatusV2(text).dirty).toBe(true)
  })

  it('counts an ignored entry as clean', () => {
    expect(parseStatusV2(ignored).dirty).toBe(false)
  })

  it('tolerates a detached head and a missing upstream', () => {
    expect(parseStatusV2('# branch.oid abc\n# branch.head (detached)\n')).toStrictEqual({
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

const BRANCH_HEAD = '# branch.head '
const AHEAD_BEHIND = /^# branch\.ab \+(?<ahead>\d+) -(?<behind>\d+)$/u

function readHeader(line: string, status: { ahead: number; behind: number; branch: string }): void {
  if (line.startsWith(BRANCH_HEAD)) {
    status.branch = line.slice(BRANCH_HEAD.length)
    return
  }
  const match = AHEAD_BEHIND.exec(line)
  if (match !== null && match.groups !== undefined) {
    status.ahead = Number(match.groups['ahead'])
    status.behind = Number(match.groups['behind'])
  }
}

// Output of `git status --porcelain=v2 --branch`: `#` headers, then one entry per change; `!` entries are ignored files
export function parseStatusV2(text: string): ParsedStatus {
  const status = { dirty: false, ahead: 0, behind: 0, branch: '' }
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) {
      readHeader(line, status)
    } else if (line.trim() !== '' && !line.startsWith('! ')) {
      status.dirty = true
    }
  }
  return status
}
```
`plugins/workspace-local/src/errors.ts`:
```ts
export type WorkspaceErrorCode =
  | 'not_a_repository'
  | 'is_bytebureau_worktree'
  | 'git_too_old'
  | 'locked'
  | 'dirty'
  | 'git_failed'
  | 'fs_failed'

export class WorkspaceError extends Error {
  public readonly code: WorkspaceErrorCode

  public constructor(code: WorkspaceErrorCode, message: string) {
    super(message)
    this.name = 'WorkspaceError'
    this.code = code
  }
}
```
`plugins/workspace-local/src/keyed-queue.ts`:
```ts
type Enqueue = <Result>(key: string, work: () => Promise<Result>) => Promise<Result>

async function afterwards<Result>(
  before: Promise<unknown>,
  work: () => Promise<Result>,
): Promise<Result> {
  try {
    await before
  } catch {
    // The caller of the earlier work gets to see how it went wrong
  }
  return work()
}

// A queue per key: the work of one key runs one piece after the other, in the order it came; other keys go their own way
export function createKeyedQueue(): Enqueue {
  const turns = new Map<string, Promise<unknown>>()
  return async (key, work) => {
    const mine = afterwards(turns.get(key) ?? Promise.resolve(), work)
    turns.set(key, mine)
    const result = await mine
    return result
  }
}
```
`plugins/workspace-local/src/keyed-queue.test.ts`:
```ts
import { setImmediate as nextTurn } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { createKeyedQueue } from './keyed-queue.js'

// Work that logs when it starts and when it ends, with a turn of the event loop in between
function logging(log: string[], name: string): () => Promise<string> {
  return async () => {
    log.push(`${name} starts`)
    await nextTurn()
    log.push(`${name} ends`)
    return name
  }
}

async function failing(): Promise<string> {
  await nextTurn()
  throw new Error('boom')
}

describe(createKeyedQueue, () => {
  it('runs the work of one key one after the other, in the order it came', async () => {
    expect.hasAssertions()
    const enqueue = createKeyedQueue()
    const log: string[] = []
    const results = await Promise.all([
      enqueue('k', logging(log, 'a')),
      enqueue('k', logging(log, 'b')),
      enqueue('k', logging(log, 'c')),
    ])
    expect(results).toStrictEqual(['a', 'b', 'c'])
    expect(log).toStrictEqual(['a starts', 'a ends', 'b starts', 'b ends', 'c starts', 'c ends'])
  })

  it('lets the work of different keys overlap', async () => {
    expect.hasAssertions()
    const enqueue = createKeyedQueue()
    const log: string[] = []
    await Promise.all([enqueue('one', logging(log, 'a')), enqueue('two', logging(log, 'b'))])
    expect(log).toStrictEqual(['a starts', 'b starts', 'a ends', 'b ends'])
  })

  it('goes on with the next work after work that failed', async () => {
    expect.hasAssertions()
    const enqueue = createKeyedQueue()
    const first = enqueue('k', failing)
    const second = enqueue('k', logging([], 'b'))
    await expect(first).rejects.toThrow('boom')
    await expect(second).resolves.toBe('b')
  })
})
```
Run: `bunx vitest run --project workspace-local` → PASS (3 tests).

- [ ] **Step 4: Test helpers (Node spawner and a temporary repository)**

`plugins/workspace-local/src/testing/node-spawner.ts` (used by tests under Node; the kernel supplies the real spawner in production):
```ts
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import type { ExecHandle, ExecSpec, ProcessSpawner } from '@bytebureau/plugin-api'

type Exit = Awaited<ExecHandle['exited']>

// A contributor's global git configuration must not reach the git that a test runs
const ISOLATED_GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } as const

async function* lines(stream: NodeJS.ReadableStream | null): AsyncIterable<string> {
  if (stream === null) {
    return
  }
  for await (const line of createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  })) {
    yield line
  }
}

interface Watched {
  readonly started: Promise<unknown>
  readonly closed: Promise<unknown>
  readonly failures: readonly Error[]
}

// The events of a child as plain ones: events.once rejects on an 'error' event, but here a command that cannot start is a result
function watch(child: ChildProcess): Watched {
  const events = new EventTarget()
  const failures: Error[] = []
  const started = once(events, 'started')
  const closed = once(events, 'closed')
  child.once('spawn', () => {
    events.dispatchEvent(new Event('started'))
  })
  child.on('error', (error) => {
    failures.push(error)
    events.dispatchEvent(new Event('started'))
  })
  child.on('close', () => {
    events.dispatchEvent(new Event('closed'))
  })
  return { started, closed, failures }
}

async function exitOf(child: ChildProcess, closed: Promise<unknown>): Promise<Exit> {
  await closed
  // A command that could not start never had a process; the kernel reports that as exit -1
  if (child.pid === undefined) {
    return { code: -1, signal: null }
  }
  return { code: child.exitCode, signal: child.signalCode }
}

// The reasons a command could not start, one per line, as a stream of its own
function reasonsOf(failures: readonly Error[]): Readable {
  return Readable.from(failures.map((failure) => `${failure.message}\n`))
}

function handleOf(child: ChildProcess, watched: Watched): ExecHandle {
  const running = child.pid !== undefined
  return {
    pid: child.pid ?? -1,
    stdout: running ? lines(child.stdout) : lines(null),
    stderr: running ? lines(child.stderr) : lines(reasonsOf(watched.failures)),
    exited: exitOf(child, watched.closed),
    kill(signal = 'SIGTERM') {
      child.kill(signal)
    },
  }
}

// Read the lines right after spawning: node drops the output of a process that has exited before anybody reads it
export const nodeSpawner: ProcessSpawner = {
  async spawn(spec: ExecSpec & { readonly cwd: string }): Promise<ExecHandle> {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...process.env, ...ISOLATED_GIT, ...spec.env },
      signal: spec.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const watched = watch(child)
    await watched.started
    return handleOf(child, watched)
  },
}
```

`plugins/workspace-local/src/testing/temp-repo.ts`:
```ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { onTestFinished } from 'vitest'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()
}

// Symlinks are resolved, as git reports paths: on macOS the temporary directory sits behind /var -> /private/var
// The directory is removed when the running test has finished
export function tempDir(prefix: string): string {
  const created = mkdtempSync(path.join(tmpdir(), prefix))
  const dir = realpathSync(created)
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function addOrigin(dir: string): void {
  const remote = tempDir('bb-remote-')
  git(remote, 'init', '-q', '--bare', '-b', 'main')
  git(dir, 'remote', 'add', 'origin', remote)
  git(dir, 'push', '-q', '-u', 'origin', 'main')
}

// A repository with one commit on `main` and an optional bare "origin" remote
export function createTempRepo(options: { readonly withRemote?: boolean } = {}): string {
  const dir = tempDir('bb-repo-')
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(path.join(dir, 'README.md'), '# fixture\n')
  git(dir, 'add', 'README.md')
  git(dir, 'commit', '-q', '-m', 'initial')
  if (options.withRemote === true) {
    addOrigin(dir)
  }
  return dir
}
```
`plugins/workspace-local/src/testing/fixtures.ts` (shared fixtures):
```ts
import { readFileSync } from 'node:fs'
import type {
  Logger,
  LogLevel,
  PluginContext,
  PluginRegistration,
  ProcessSpawner,
  WorkspaceRuntime,
  WorkspaceSpec,
} from '@bytebureau/plugin-api'
import { LocalWorkspaceRuntime } from '../local-runtime.js'
import { nodeSpawner } from './node-spawner.js'

export const SESSION_ID = '0192f0c8-7b2e-7c3d-9a4b-000000000001'

export interface LogEntry {
  readonly level: LogLevel
  readonly message: string
}

// A logger that keeps what it is told, for the tests that look at warnings
export function recordingLogger(): { readonly logger: Logger; readonly entries: LogEntry[] } {
  const entries: LogEntry[] = []
  const at =
    (level: LogLevel): Logger['debug'] =>
    (message) => {
      entries.push({ level, message })
    }
  const logger: Logger = {
    category: ['test'],
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  }
  return { logger, entries }
}

export function workspaceSpec(
  projectPath: string,
  overrides: Partial<WorkspaceSpec> = {},
): WorkspaceSpec {
  return {
    sessionId: SESSION_ID,
    projectPath,
    baseBranch: 'main',
    branch: 'bb/add-hello',
    copyIgnored: ['.env'],
    logger: recordingLogger().logger,
    ...overrides,
  }
}

export function createRuntime(
  spawner: ProcessSpawner = nodeSpawner,
  logger: Logger = recordingLogger().logger,
): LocalWorkspaceRuntime {
  return new LocalWorkspaceRuntime(spawner, logger)
}

export interface SpawnCall {
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

// Records the arguments and the environment of every spawn, then runs the process for real
export function spySpawner(): { readonly spawner: ProcessSpawner; readonly calls: SpawnCall[] } {
  const calls: SpawnCall[] = []
  const spawner: ProcessSpawner = {
    async spawn(spec) {
      calls.push({ args: [...spec.args], env: { ...spec.env } })
      const child = await nodeSpawner.spawn(spec)
      return child
    },
  }
  return { spawner, calls }
}

// A spawner that runs a Node script, chosen by the arguments, in place of every command
export function scriptedSpawner(scriptFor: (args: readonly string[]) => string): ProcessSpawner {
  return {
    async spawn(spec) {
      const args = ['-e', scriptFor(spec.args)]
      const child = await nodeSpawner.spawn({ ...spec, command: process.execPath, args })
      return child
    },
  }
}

// A spawner that fails the git commands that start with one of the phrases, such as 'branch -D', and runs the rest for real
export function failingSpawner(...phrases: readonly string[]): ProcessSpawner {
  return {
    async spawn(spec) {
      const fails = phrases.includes(spec.args.slice(0, 2).join(' '))
      const failure = { ...spec, command: process.execPath, args: ['-e', 'process.exit(1)'] }
      const child = await nodeSpawner.spawn(fails ? failure : spec)
      return child
    },
  }
}

// A spawner whose git reports one version and fails every other command
export function versionSpawner(version: string): ProcessSpawner {
  return scriptedSpawner((args) =>
    args[0] === '--version' ? `console.log('git version ${version}')` : 'process.exit(128)',
  )
}

const unused = (): never => {
  throw new Error('a workspace runtime does not use this part of the plugin context')
}

// Only the process spawner and the logger are real; the rest fails loudly when somebody reaches for it
export function pluginContext(spawner: ProcessSpawner): PluginContext {
  return {
    config: undefined,
    project: null,
    logger: recordingLogger().logger,
    events: { publish: unused, subscribe: unused },
    secrets: { get: unused, set: unused, delete: unused },
    kv: { get: unused, set: unused, delete: unused },
    process: spawner,
    http: fetch,
    signal: new AbortController().signal,
  }
}

export function soleRuntime(registration: PluginRegistration): WorkspaceRuntime {
  const [runtime, ...others] = registration.workspaceRuntimes ?? []
  if (runtime === undefined || others.length > 0) {
    throw new Error('expected the plugin to register exactly one workspace runtime')
  }
  return runtime
}

// Every line a stream yields
export async function readLines(stream: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = []
  for await (const line of stream) {
    lines.push(line)
  }
  return lines
}

export function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'))
}
```
`plugins/workspace-local/src/testing/node-spawner.test.ts`:
```ts
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readLines } from './fixtures.js'
import { nodeSpawner } from './node-spawner.js'
import { tempDir } from './temp-repo.js'

const node = process.execPath
const cwd = process.cwd()

describe('node spawner', () => {
  it('runs a command and reports its lines and its exit code', async () => {
    expect.hasAssertions()
    const script = "console.log('out'); console.error('err'); process.exit(3)"
    const child = await nodeSpawner.spawn({ command: node, args: ['-e', script], cwd })
    const [stdout, stderr, exit] = await Promise.all([
      readLines(child.stdout),
      readLines(child.stderr),
      child.exited,
    ])
    expect({ stdout, stderr, exit }).toStrictEqual({
      stdout: ['out'],
      stderr: ['err'],
      exit: { code: 3, signal: null },
    })
  })

  it('reports a command that cannot start as exit -1 with the reason on stderr', async () => {
    expect.hasAssertions()
    const child = await nodeSpawner.spawn({ command: 'bb-no-such-command', args: [], cwd })
    const [stdout, stderr, exit] = await Promise.all([
      readLines(child.stdout),
      readLines(child.stderr),
      child.exited,
    ])
    expect(exit).toStrictEqual({ code: -1, signal: null })
    expect(stdout).toStrictEqual([])
    expect(stderr).toStrictEqual(['spawn bb-no-such-command ENOENT'])
  })

  it('reports a working directory that does not exist the same way', async () => {
    expect.hasAssertions()
    const missing = path.join(tempDir('bb-cwd-'), 'missing')
    const child = await nodeSpawner.spawn({ command: node, args: ['-e', '1'], cwd: missing })
    await expect(child.exited).resolves.toStrictEqual({ code: -1, signal: null })
    await expect(readLines(child.stderr)).resolves.toHaveLength(1)
  })
})

describe('node spawner process control', () => {
  it('reports a process that was aborted as killed by SIGTERM', async () => {
    expect.hasAssertions()
    const controller = new AbortController()
    const args = ['-e', 'setInterval(() => {}, 1000)']
    const child = await nodeSpawner.spawn({ command: node, args, cwd, signal: controller.signal })
    controller.abort()
    await expect(child.exited).resolves.toStrictEqual({ code: null, signal: 'SIGTERM' })
  })

  it('hides the global git configuration, unless the spec says otherwise', async () => {
    expect.hasAssertions()
    const args = [
      '-e',
      'console.log(process.env.GIT_CONFIG_GLOBAL, process.env.GIT_CONFIG_NOSYSTEM)',
    ]
    const plain = await nodeSpawner.spawn({ command: node, args, cwd })
    await expect(readLines(plain.stdout)).resolves.toStrictEqual(['/dev/null 1'])
    const env = { GIT_CONFIG_GLOBAL: 'x' }
    const custom = await nodeSpawner.spawn({ command: node, args, cwd, env })
    await expect(readLines(custom.stdout)).resolves.toStrictEqual(['x 1'])
  })
})
```

- [ ] **Step 5: Failing runtime tests**

`plugins/workspace-local/src/local-runtime.test.ts`:
```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { WorkspaceSpec } from '@bytebureau/plugin-api'
import { describe, expect, it } from 'vitest'
import { LocalWorkspaceRuntime } from './local-runtime.js'
import { SESSION_ID, createRuntime, readJson, workspaceSpec } from './testing/fixtures.js'
import { createTempRepo, git, tempDir } from './testing/temp-repo.js'

const worktreeOf = (repo: string): string => path.join(repo, '.bytebureau', 'worktrees', SESSION_ID)

// Every session asks for the same branch name
const sameBranch = (sessionId: string, projectPath: string): WorkspaceSpec =>
  workspaceSpec(projectPath, { sessionId, branch: 'bb/x' })

describe(LocalWorkspaceRuntime, () => {
  it('provisions a worktree on the requested branch from the local base branch', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const exclude = path.join(repo, '.git', 'info', 'exclude')
    const handle = await createRuntime().provision(workspaceSpec(repo))
    expect(handle.path).toBe(worktreeOf(repo))
    expect(git(handle.path, 'branch', '--show-current')).toBe('bb/add-hello')
    expect(handle.baseRef).toBe('main')
    expect(readFileSync(exclude, 'utf8')).toContain('.bytebureau/')
    expect(readJson(path.join(handle.path, '.bytebureau-session.json'))).toMatchObject({
      sessionId: SESSION_ID,
    })
  })

  it('describes the worktree in the handle it returns', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const handle = await createRuntime().provision(workspaceSpec(repo))
    expect(handle).toStrictEqual({
      id: SESSION_ID,
      runtimeId: 'local',
      path: worktreeOf(repo),
      branch: 'bb/add-hello',
      baseRef: 'main',
    })
  })

  it('never touches a dirty main checkout', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    writeFileSync(path.join(repo, 'README.md'), '# changed\n')
    writeFileSync(path.join(repo, 'scratch.txt'), 'x\n')
    await createRuntime().provision(workspaceSpec(repo))
    expect(git(repo, 'status', '--porcelain')).toBe('M README.md\n?? scratch.txt')
    expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# changed\n')
    expect(git(repo, 'branch', '--show-current')).toBe('main')
  })
})

describe('project checks', () => {
  it('refuses a directory that is not a repository and one that is a ByteBureau worktree', async () => {
    expect.hasAssertions()
    const runtime = createRuntime()
    const handle = await runtime.provision(workspaceSpec(createTempRepo()))
    const plain = tempDir('bb-plain-')
    await expect(runtime.provision(workspaceSpec(plain))).rejects.toMatchObject({
      code: 'not_a_repository',
    })
    await expect(runtime.provision(workspaceSpec(handle.path))).rejects.toMatchObject({
      code: 'is_bytebureau_worktree',
    })
  })

  it('provisions at the repository toplevel when the project path lies inside it', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const inside = path.join(repo, 'src', 'deep')
    mkdirSync(inside, { recursive: true })
    const handle = await createRuntime().provision(workspaceSpec(inside))
    expect(handle.path).toBe(worktreeOf(repo))
    expect(git(handle.path, 'rev-parse', '--show-toplevel')).toBe(handle.path)
  })
})

describe('project paths', () => {
  it('refuses a project path that is not a directory', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const missing = workspaceSpec(path.join(tempDir('bb-plain-'), 'missing'))
    const file = workspaceSpec(path.join(repo, 'README.md'))
    await expect(createRuntime().provision(missing)).rejects.toMatchObject({
      code: 'not_a_repository',
    })
    await expect(createRuntime().provision(file)).rejects.toMatchObject({
      code: 'not_a_repository',
    })
  })

  it('refuses a repository that holds a session marker', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    writeFileSync(path.join(repo, '.bytebureau-session.json'), '{}')
    await expect(createRuntime().provision(workspaceSpec(repo))).rejects.toMatchObject({
      code: 'is_bytebureau_worktree',
    })
  })

  it('still knows a ByteBureau worktree whose marker was deleted', async () => {
    expect.hasAssertions()
    const runtime = createRuntime()
    const handle = await runtime.provision(workspaceSpec(createTempRepo()))
    rmSync(path.join(handle.path, '.bytebureau-session.json'))
    await expect(runtime.provision(workspaceSpec(handle.path))).rejects.toMatchObject({
      code: 'is_bytebureau_worktree',
    })
  })
})

describe('branch names', () => {
  it('suffixes the branch when it already exists', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    git(repo, 'branch', 'bb/add-hello')
    const handle = await createRuntime().provision(workspaceSpec(repo))
    expect(handle.branch).toBe('bb/add-hello-2')
  })

  it('counts up past every suffix that is taken', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    git(repo, 'branch', 'bb/add-hello')
    git(repo, 'branch', 'bb/add-hello-2')
    const handle = await createRuntime().provision(workspaceSpec(repo))
    expect(handle.branch).toBe('bb/add-hello-3')
    expect(git(handle.path, 'branch', '--show-current')).toBe('bb/add-hello-3')
  })

  it('gives sessions that start at once a name each, however they name the project', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const inside = path.join(repo, 'src')
    mkdirSync(inside)
    const runtime = createRuntime()
    const handles = await Promise.all([
      runtime.provision(sameBranch('a', repo)),
      runtime.provision(sameBranch('b', inside)),
      runtime.provision(sameBranch('c', repo)),
    ])
    expect(handles.map((handle) => handle.branch).toSorted()).toStrictEqual([
      'bb/x',
      'bb/x-2',
      'bb/x-3',
    ])
    expect(handles.map((handle) => existsSync(handle.path))).toStrictEqual([true, true, true])
  })
})
```
`plugins/workspace-local/src/local-runtime-lifecycle.test.ts`:
```ts
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { WorkspaceHandle } from '@bytebureau/plugin-api'
import { describe, expect, it } from 'vitest'
import { WorkspaceError } from './errors.js'
import type { LocalWorkspaceRuntime } from './local-runtime.js'
import { createRuntime, readLines, scriptedSpawner, workspaceSpec } from './testing/fixtures.js'
import { createTempRepo, git, tempDir } from './testing/temp-repo.js'

// A provisioned worktree that holds an uncommitted file
async function dirtyWorktree(runtime: LocalWorkspaceRuntime): Promise<WorkspaceHandle> {
  const handle = await runtime.provision(workspaceSpec(createTempRepo()))
  writeFileSync(path.join(handle.path, 'new.txt'), 'hi\n')
  return handle
}

describe('status', () => {
  it('reports a fresh worktree as clean', async () => {
    expect.hasAssertions()
    const runtime = createRuntime()
    const handle = await runtime.provision(workspaceSpec(createTempRepo()))
    await expect(runtime.status(handle)).resolves.toStrictEqual({
      dirty: false,
      ahead: 0,
      behind: 0,
      locked: false,
      branch: 'bb/add-hello',
    })
  })

  it('counts the commits ahead of and behind the base ref', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const runtime = createRuntime()
    const handle = await runtime.provision(workspaceSpec(repo))
    git(handle.path, 'commit', '--allow-empty', '-q', '-m', 'work')
    git(repo, 'commit', '--allow-empty', '-q', '-m', 'upstream one')
    git(repo, 'commit', '--allow-empty', '-q', '-m', 'upstream two')
    await expect(runtime.status(handle)).resolves.toMatchObject({
      dirty: false,
      ahead: 1,
      behind: 2,
    })
  })

  it('reports uncommitted changes', async () => {
    expect.hasAssertions()
    const runtime = createRuntime()
    const handle = await dirtyWorktree(runtime)
    await expect(runtime.status(handle)).resolves.toMatchObject({ dirty: true, locked: false })
  })
})

describe('locks', () => {
  it('reports a lock for the locked worktree only', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const runtime = createRuntime()
    const locked = await runtime.provision(workspaceSpec(repo))
    const other = await runtime.provision(
      workspaceSpec(repo, { sessionId: 'other', branch: 'bb/o' }),
    )
    git(repo, 'worktree', 'lock', locked.path)
    await expect(runtime.status(other)).resolves.toMatchObject({ locked: false })
    await expect(runtime.status(locked)).resolves.toMatchObject({ locked: true })
  })

  it('refuses to destroy a locked worktree even with force', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const runtime = createRuntime()
    const handle = await runtime.provision(workspaceSpec(repo))
    git(repo, 'worktree', 'lock', handle.path)
    await expect(runtime.destroy(handle, { force: true })).rejects.toMatchObject({ code: 'locked' })
    expect(existsSync(handle.path)).toBe(true)
  })
})

describe('git failures', () => {
  it('reports a git failure as a workspace error', async () => {
    expect.hasAssertions()
    const gone = {
      id: 's',
      runtimeId: 'local',
      path: tempDir('bb-plain-'),
      branch: 'x',
      baseRef: 'main',
    }
    const failure = createRuntime().status(gone)
    await expect(failure).rejects.toBeInstanceOf(WorkspaceError)
    await expect(failure).rejects.toMatchObject({ code: 'git_failed' })
  })

  it('reports a git that died from a signal as a failure', async () => {
    expect.hasAssertions()
    const handle = await createRuntime().provision(workspaceSpec(createTempRepo()))
    const killed = scriptedSpawner(() => "process.kill(process.pid, 'SIGKILL')")
    await expect(createRuntime(killed).status(handle)).rejects.toMatchObject({ code: 'git_failed' })
  })
})

describe('destroy', () => {
  it('removes a clean worktree without force and keeps its branch', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const runtime = createRuntime()
    const handle = await runtime.provision(workspaceSpec(repo))
    await runtime.destroy(handle)
    expect(existsSync(handle.path)).toBe(false)
    expect(git(repo, 'branch', '--list', 'bb/add-hello')).toBe('bb/add-hello')
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(handle.path)
  })

  it('refuses to destroy a dirty worktree without force, then removes it with force', async () => {
    expect.hasAssertions()
    const runtime = createRuntime()
    const handle = await dirtyWorktree(runtime)
    const refusal = runtime.destroy(handle)
    await expect(refusal).rejects.toBeInstanceOf(WorkspaceError)
    await expect(refusal).rejects.toMatchObject({ code: 'dirty' })
    expect(existsSync(path.join(handle.path, 'new.txt'))).toBe(true)
    await runtime.destroy(handle, { force: true })
    expect(existsSync(handle.path)).toBe(false)
  })
})

// A provisioned worktree whose base branch has been renamed away
async function withoutBaseRef(runtime: LocalWorkspaceRuntime): Promise<WorkspaceHandle> {
  const repo = createTempRepo()
  const handle = await runtime.provision(workspaceSpec(repo))
  git(repo, 'branch', '-m', 'main', 'trunk')
  return handle
}

describe('without its base ref', () => {
  it.each([[{}], [{ force: true }]])('destroys the worktree with %j', async (options) => {
    expect.hasAssertions()
    const runtime = createRuntime()
    const handle = await withoutBaseRef(runtime)
    await runtime.destroy(handle, options)
    expect(existsSync(handle.path)).toBe(false)
  })

  it('cannot say how far it is from the base, as git_failed', async () => {
    expect.hasAssertions()
    const runtime = createRuntime()
    const handle = await withoutBaseRef(runtime)
    await expect(runtime.status(handle)).rejects.toMatchObject({ code: 'git_failed' })
  })
})

describe('git configuration', () => {
  it('sees untracked files whatever status.showUntrackedFiles says', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const runtime = createRuntime()
    const handle = await runtime.provision(workspaceSpec(repo))
    git(repo, 'config', 'status.showUntrackedFiles', 'no')
    writeFileSync(path.join(handle.path, 'agent.txt'), 'work\n')
    expect(git(handle.path, 'status', '--porcelain')).toBe('')
    await expect(runtime.status(handle)).resolves.toMatchObject({ dirty: true })
    await expect(runtime.destroy(handle)).rejects.toMatchObject({ code: 'dirty' })
    expect(existsSync(path.join(handle.path, 'agent.txt'))).toBe(true)
  })
})

describe('exec', () => {
  it('runs a command in the worktree', async () => {
    expect.hasAssertions()
    const runtime = createRuntime()
    const handle = await runtime.provision(workspaceSpec(createTempRepo()))
    const args = ['rev-parse', '--show-toplevel']
    const child = await runtime.exec(handle, { command: 'git', args })
    await expect(readLines(child.stdout)).resolves.toStrictEqual([handle.path])
    await expect(child.exited).resolves.toStrictEqual({ code: 0, signal: null })
  })
})
```
`plugins/workspace-local/src/provision-base.test.ts`:
```ts
import path from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  createRuntime,
  recordingLogger,
  scriptedSpawner,
  spySpawner,
  versionSpawner,
  workspaceSpec,
  type SpawnCall,
} from './testing/fixtures.js'
import { nodeSpawner } from './testing/node-spawner.js'
import { createTempRepo, git, tempDir } from './testing/temp-repo.js'

const fetches = (calls: readonly SpawnCall[]): readonly SpawnCall[] =>
  calls.filter((call) => call.args[0] === 'fetch')

// Pushes one commit to origin from a second clone and returns its id
function pushFromElsewhere(repo: string): string {
  const clone = path.join(tempDir('bb-clone-'), 'work')
  git(repo, 'clone', '-q', git(repo, 'remote', 'get-url', 'origin'), clone)
  git(clone, 'commit', '--allow-empty', '-q', '-m', 'from elsewhere')
  git(clone, 'push', '-q', 'origin', 'main')
  return git(clone, 'rev-parse', 'HEAD')
}

describe('base ref', () => {
  it('starts from the freshly fetched origin/<branch> when a remote exists', async () => {
    expect.hasAssertions()
    const repo = createTempRepo({ withRemote: true })
    const pushed = pushFromElsewhere(repo)
    const handle = await createRuntime().provision(workspaceSpec(repo))
    expect(handle.baseRef).toBe('origin/main')
    expect(git(handle.path, 'rev-parse', 'HEAD')).toBe(pushed)
    expect(git(repo, 'rev-parse', 'main')).not.toBe(pushed)
  })

  it('falls back to the local branch when the remote does not have it', async () => {
    expect.hasAssertions()
    const repo = createTempRepo({ withRemote: true })
    git(repo, 'branch', 'develop')
    const spec = workspaceSpec(repo, { baseBranch: 'develop' })
    const handle = await createRuntime().provision(spec)
    expect(handle.baseRef).toBe('develop')
  })
})

describe('new branch', () => {
  it('has no upstream, so a push does not aim at the base branch', async () => {
    expect.hasAssertions()
    const repo = createTempRepo({ withRemote: true })
    const handle = await createRuntime().provision(workspaceSpec(repo))
    expect(handle.baseRef).toBe('origin/main')
    expect(git(repo, 'for-each-ref', '--format=%(upstream)', 'refs/heads/bb/add-hello')).toBe('')
  })
})

describe('git environment', () => {
  it('runs every git command without a terminal prompt', async () => {
    expect.hasAssertions()
    const { spawner, calls } = spySpawner()
    const spec = workspaceSpec(createTempRepo({ withRemote: true }))
    await createRuntime(spawner).provision(spec)
    expect(fetches(calls)).toHaveLength(1)
    expect(calls.filter((call) => call.env['GIT_TERMINAL_PROMPT'] !== '0')).toStrictEqual([])
  })
})

describe('fetching', () => {
  it('fetches once per minute and project', async () => {
    expect.hasAssertions()
    const first = createTempRepo({ withRemote: true })
    const second = createTempRepo({ withRemote: true })
    const { spawner, calls } = spySpawner()
    const runtime = createRuntime(spawner)
    await runtime.provision(workspaceSpec(first, { sessionId: 'one', branch: 'bb/one' }))
    await runtime.provision(workspaceSpec(first, { sessionId: 'two', branch: 'bb/two' }))
    await runtime.provision(workspaceSpec(second))
    expect(fetches(calls)).toHaveLength(2)
  })

  it('fetches again once a minute has passed', async () => {
    expect.hasAssertions()
    vi.useFakeTimers({ toFake: ['Date'] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const repo = createTempRepo({ withRemote: true })
    const { spawner, calls } = spySpawner()
    const runtime = createRuntime(spawner)
    await runtime.provision(workspaceSpec(repo, { sessionId: 'one', branch: 'bb/one' }))
    vi.setSystemTime(Date.now() + 61_000)
    await runtime.provision(workspaceSpec(repo, { sessionId: 'two', branch: 'bb/two' }))
    expect(fetches(calls)).toHaveLength(2)
  })

  it('goes on with the last known refs and tells the session when the fetch fails', async () => {
    expect.hasAssertions()
    const repo = createTempRepo({ withRemote: true })
    git(repo, 'remote', 'set-url', 'origin', path.join(tempDir('bb-gone-'), 'missing'))
    const session = recordingLogger()
    const daemon = recordingLogger()
    const spec = workspaceSpec(repo, { logger: session.logger })
    const handle = await createRuntime(nodeSpawner, daemon.logger).provision(spec)
    expect(handle.baseRef).toBe('origin/main')
    expect(session.entries.filter((entry) => entry.level === 'warn')).toHaveLength(1)
    expect(daemon.entries.filter((entry) => entry.level === 'warn')).toStrictEqual([])
  })
})

describe('git version', () => {
  it('treats a git that fails to run as too old', async () => {
    expect.hasAssertions()
    const runtime = createRuntime(scriptedSpawner(() => 'process.exit(127)'))
    const failure = runtime.provision(workspaceSpec(tempDir('bb-plain-')))
    await expect(failure).rejects.toMatchObject({ code: 'git_too_old' })
  })

  it.each([
    ['1.9.9', 'git_too_old'],
    ['2.39.5', 'git_too_old'],
    ['unknown', 'git_too_old'],
    ['2.40.0', 'not_a_repository'],
    ['3.1.0', 'not_a_repository'],
  ])('with git %s, provisioning fails with %s', async (version, code) => {
    expect.hasAssertions()
    const runtime = createRuntime(versionSpawner(version))
    const failure = runtime.provision(workspaceSpec(tempDir('bb-plain-')))
    await expect(failure).rejects.toMatchObject({ code })
  })
})
```
`plugins/workspace-local/src/provision-files.test.ts`:
```ts
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SESSION_ID,
  createRuntime,
  failingSpawner,
  readJson,
  recordingLogger,
  workspaceSpec,
} from './testing/fixtures.js'
import { createTempRepo, git, tempDir } from './testing/temp-repo.js'

// A repository that ignores what a worktree is meant to receive, committed like a real project's
function repoIgnoring(...patterns: string[]): string {
  const repo = createTempRepo()
  writeFileSync(path.join(repo, '.gitignore'), `${patterns.join('\n')}\n`)
  git(repo, 'add', '.gitignore')
  git(repo, 'commit', '-q', '-m', 'ignore')
  return repo
}

// An ignored .env and an ignored file in a subdirectory
function repoWithIgnoredFiles(): string {
  const repo = repoIgnoring('.env', 'config/')
  mkdirSync(path.join(repo, 'config'))
  writeFileSync(path.join(repo, '.env'), 'SECRET=1\n')
  writeFileSync(path.join(repo, 'config', 'local.env'), 'MODE=dev\n')
  return repo
}

// A temporary directory outside any project, with a secret file in it
function outsideWithSecret(): { readonly dir: string; readonly secret: string } {
  const dir = tempDir('bb-outside-')
  const secret = path.join(dir, 'secret.txt')
  writeFileSync(secret, 'secret\n')
  return { dir, secret }
}

// Entries that point out of the project by relative and by absolute path, and one that is a directory
function escapingEntries(repo: string): { outside: string; copyIgnored: string[] } {
  const { dir, secret } = outsideWithSecret()
  mkdirSync(path.join(repo, 'config'))
  const relative = path.join('..', path.basename(dir), path.basename(secret))
  return { outside: dir, copyIgnored: [relative, secret, 'config'] }
}

// A project with links to something outside it, a link to something inside it and a plain file
function repoWithLinks(): string {
  const repo = createTempRepo()
  const { dir, secret } = outsideWithSecret()
  symlinkSync(secret, path.join(repo, 'leak.env'))
  symlinkSync(dir, path.join(repo, 'linked'))
  mkdirSync(path.join(repo, 'config'))
  writeFileSync(path.join(repo, 'config', 'shared.env'), 'SHARED=1\n')
  symlinkSync(path.join('config', 'shared.env'), path.join(repo, '.env'))
  return repo
}

// The base branch holds a directory where the main checkout keeps a file
function repoWithClashingBase(): string {
  const repo = createTempRepo()
  git(repo, 'checkout', '-q', '-b', 'clash')
  mkdirSync(path.join(repo, 'scratch'))
  writeFileSync(path.join(repo, 'scratch', 'tracked.txt'), 'x\n')
  git(repo, 'add', 'scratch')
  git(repo, 'commit', '-q', '-m', 'directory')
  git(repo, 'checkout', '-q', 'main')
  writeFileSync(path.join(repo, 'scratch'), 'a file\n')
  return repo
}

describe('copying ignored files', () => {
  it('copies listed files, also from subdirectories, and skips the missing ones', async () => {
    expect.hasAssertions()
    const copyIgnored = ['.env', 'config/local.env', 'missing.txt']
    const spec = workspaceSpec(repoWithIgnoredFiles(), { copyIgnored })
    const handle = await createRuntime().provision(spec)
    expect(readFileSync(path.join(handle.path, '.env'), 'utf8')).toBe('SECRET=1\n')
    expect(readFileSync(path.join(handle.path, 'config', 'local.env'), 'utf8')).toBe('MODE=dev\n')
    expect(existsSync(path.join(handle.path, 'missing.txt'))).toBe(false)
    expect(git(handle.path, 'status', '--porcelain')).toBe('')
  })

  it('leaves out what is not a file inside the project and says so', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const { outside, copyIgnored } = escapingEntries(repo)
    const { logger, entries } = recordingLogger()
    const handle = await createRuntime().provision(workspaceSpec(repo, { copyIgnored, logger }))
    const beside = path.join(handle.path, '..', path.basename(outside))
    expect(existsSync(beside)).toBe(false)
    expect(existsSync(path.join(handle.path, 'config'))).toBe(false)
    expect(existsSync(path.join(handle.path, outside))).toBe(false)
    expect(entries.filter((entry) => entry.level === 'warn')).toHaveLength(3)
  })
})

describe('symlinked entries', () => {
  it('skips a link that leads out of the project, also through a linked directory', async () => {
    expect.hasAssertions()
    const { logger, entries } = recordingLogger()
    const copyIgnored = ['leak.env', 'linked/secret.txt']
    const spec = workspaceSpec(repoWithLinks(), { copyIgnored, logger })
    const handle = await createRuntime().provision(spec)
    expect(existsSync(path.join(handle.path, 'leak.env'))).toBe(false)
    expect(existsSync(path.join(handle.path, 'linked'))).toBe(false)
    expect(entries.filter((entry) => entry.level === 'warn')).toHaveLength(2)
  })

  it('copies the content of a link that stays inside the project to the path of the entry', async () => {
    expect.hasAssertions()
    const spec = workspaceSpec(repoWithLinks(), { copyIgnored: ['.env'] })
    const handle = await createRuntime().provision(spec)
    expect(readFileSync(path.join(handle.path, '.env'), 'utf8')).toBe('SHARED=1\n')
    expect(existsSync(path.join(handle.path, 'config'))).toBe(false)
  })

  it('skips an entry that runs through a file without a warning', async () => {
    expect.hasAssertions()
    const { logger, entries } = recordingLogger()
    const spec = workspaceSpec(createTempRepo(), { copyIgnored: ['README.md/x'], logger })
    await expect(createRuntime().provision(spec)).resolves.toMatchObject({ branch: 'bb/add-hello' })
    expect(entries.filter((entry) => entry.level === 'warn')).toStrictEqual([])
  })
})

describe('a provision that fails halfway', () => {
  it('takes back the worktree and the branch and reports the file system error', async () => {
    expect.hasAssertions()
    const repo = repoWithClashingBase()
    const spec = workspaceSpec(repo, { baseBranch: 'clash', copyIgnored: ['scratch'] })
    await expect(createRuntime().provision(spec)).rejects.toMatchObject({ code: 'fs_failed' })
    expect(existsSync(path.join(repo, '.bytebureau', 'worktrees', SESSION_ID))).toBe(false)
    expect(git(repo, 'branch', '--list', 'bb/add-hello')).toBe('')
    expect(git(repo, 'worktree', 'list')).not.toContain('.bytebureau')
  })

  it('reports the original error and says so when it cannot take the worktree back', async () => {
    expect.hasAssertions()
    const { logger, entries } = recordingLogger()
    const runtime = createRuntime(failingSpawner('worktree remove', 'branch -D'))
    const spec = workspaceSpec(repoWithClashingBase(), {
      baseBranch: 'clash',
      copyIgnored: ['scratch'],
      logger,
    })
    await expect(runtime.provision(spec)).rejects.toMatchObject({ code: 'fs_failed' })
    expect(entries.filter((entry) => entry.level === 'warn')).toHaveLength(1)
  })

  it('creates nothing when the exclude list cannot be updated', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const exclude = path.join(repo, '.git', 'info', 'exclude')
    rmSync(exclude)
    mkdirSync(exclude)
    await expect(createRuntime().provision(workspaceSpec(repo))).rejects.toMatchObject({
      code: 'fs_failed',
    })
    expect(existsSync(path.join(repo, '.bytebureau'))).toBe(false)
    expect(git(repo, 'branch', '--list', 'bb/add-hello')).toBe('')
  })
})

describe('session marker', () => {
  it('records the session in a file at the worktree root', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const handle = await createRuntime().provision(workspaceSpec(repo))
    expect(readJson(path.join(handle.path, '.bytebureau-session.json'))).toStrictEqual({
      sessionId: SESSION_ID,
      projectPath: repo,
      branch: 'bb/add-hello',
      baseRef: 'main',
    })
  })
})

describe('exclude list', () => {
  it('lists the worktrees and the marker once and keeps the entries already there', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const exclude = path.join(repo, '.git', 'info', 'exclude')
    writeFileSync(exclude, '*.log')
    const runtime = createRuntime()
    await runtime.provision(workspaceSpec(repo, { sessionId: 'one', branch: 'bb/one' }))
    await runtime.provision(workspaceSpec(repo, { sessionId: 'two', branch: 'bb/two' }))
    expect(readFileSync(exclude, 'utf8')).toBe('*.log\n.bytebureau/\n.bytebureau-session.json\n')
    expect(git(repo, 'status', '--porcelain')).toBe('')
  })

  it('creates the exclude list when the repository has none', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    rmSync(path.join(repo, '.git', 'info'), { recursive: true })
    await createRuntime().provision(workspaceSpec(repo))
    const exclude = readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude).toBe('.bytebureau/\n.bytebureau-session.json\n')
  })

  it('goes into the main repository when the project is itself a linked worktree', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const linked = path.join(tempDir('bb-linked-'), 'checkout')
    git(repo, 'worktree', 'add', '-q', linked, '-b', 'feature')
    const handle = await createRuntime().provision(workspaceSpec(linked))
    expect(handle.path).toBe(path.join(linked, '.bytebureau', 'worktrees', SESSION_ID))
    expect(readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain(
      '.bytebureau/',
    )
    expect(git(linked, 'status', '--porcelain')).toBe('')
  })
})
```
`plugins/workspace-local/src/worktree-files.test.ts`:
```ts
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { recordingLogger } from './testing/fixtures.js'
import { createTempRepo, tempDir } from './testing/temp-repo.js'
import { copyIgnoredFiles, onDisk } from './worktree-files.js'

describe(copyIgnoredFiles, () => {
  it('judges an entry by the real path of a project that is reached through a link', () => {
    const repo = createTempRepo()
    writeFileSync(path.join(repo, '.env'), 'SECRET=1\n')
    const link = path.join(tempDir('bb-link-'), 'project')
    symlinkSync(repo, link)
    const worktreePath = tempDir('bb-worktree-')
    copyIgnoredFiles({ projectPath: link, worktreePath }, ['.env'], recordingLogger().logger)
    expect(readFileSync(path.join(worktreePath, '.env'), 'utf8')).toBe('SECRET=1\n')
  })
})

// Throws whatever it is given, which is not always an Error
function fail(value: unknown): never {
  throw value
}

describe(onDisk, () => {
  it.each([
    ['an error by its message', new Error('EISDIR: nope'), 'copying failed: EISDIR: nope'],
    ['anything else by its text', 'plain text', 'copying failed: plain text'],
  ])('reports %s', (_name, thrown, message) => {
    expect(() => {
      onDisk('copying', () => fail(thrown))
    }).toThrow(message)
  })
})
```
`plugins/workspace-local/src/plugin.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import pkg from '../package.json' with { type: 'json' }
import { localWorkspacePlugin } from './plugin.js'
import { pluginContext, soleRuntime, spySpawner, workspaceSpec } from './testing/fixtures.js'
import { createTempRepo } from './testing/temp-repo.js'

describe('workspace-local plugin', () => {
  it('declares in its manifest what its package declares', () => {
    expect(localWorkspacePlugin.manifest).toMatchObject(pkg.bytebureau)
  })

  it('registers the local runtime on the process spawner of its context', async () => {
    expect.hasAssertions()
    const { spawner, calls } = spySpawner()
    const runtime = soleRuntime(await localWorkspacePlugin.setup(pluginContext(spawner)))
    expect(runtime).toMatchObject({ id: 'local', isolation: 'none' })
    await runtime.provision(workspaceSpec(createTempRepo()))
    expect(calls.length).toBeGreaterThan(0)
  })
})
```
Run: `bunx vitest run --project workspace-local` → FAIL (`./local-runtime.js` not found).

- [ ] **Step 6: Git wrapper**

`plugins/workspace-local/src/git.ts`:
```ts
import type { ExecHandle, Logger, ProcessSpawner } from '@bytebureau/plugin-api'
import { WorkspaceError } from './errors.js'

const BRANCHES = 'refs/heads/'
const VERSION = /(?<major>\d+)\.(?<minor>\d+)/u

interface GitResult {
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
  const [stdout, stderr, exit] = await Promise.all([
    collect(handle.stdout),
    collect(handle.stderr),
    handle.exited,
  ])
  return { code: exit.code ?? -1, stdout, stderr }
}

// The major and minor number of `git --version`; [0, 0] when the output holds no version
function parseVersion(text: string): readonly [number, number] {
  const match = VERSION.exec(text)
  if (match === null || match.groups === undefined) {
    return [0, 0]
  }
  return [Number(match.groups['major']), Number(match.groups['minor'])]
}

// `git worktree list --porcelain`: one block per worktree, the first line names its path
function isLocked(listing: string, worktreePath: string): boolean {
  const block = listing
    .split('\n\n')
    .find((entry) => entry.split('\n').includes(`worktree ${worktreePath}`))
  return block !== undefined && block.split('\n').some((line) => line.startsWith('locked'))
}

export interface Git {
  readonly run: (cwd: string, args: readonly string[]) => Promise<GitResult>
  readonly must: (cwd: string, args: readonly string[]) => Promise<string>
  readonly version: (cwd: string) => Promise<readonly [number, number]>
  readonly toplevel: (cwd: string) => Promise<string | null>
  readonly hasRemote: (cwd: string, name: string) => Promise<boolean>
  readonly refExists: (cwd: string, ref: string) => Promise<boolean>
  readonly localBranches: (cwd: string, prefix: string) => Promise<readonly string[]>
  readonly worktreeLocked: (cwd: string, worktreePath: string) => Promise<boolean>
}

export function createGit(spawn: ProcessSpawner, logger: Logger): Git {
  const run: Git['run'] = async (cwd, args) => {
    logger.debug('git', { cwd, args })
    const handle = await spawn.spawn({
      command: 'git',
      args,
      cwd,
      env: { GIT_TERMINAL_PROMPT: '0' },
    })
    return settle(handle)
  }
  const must: Git['must'] = async (cwd, args) => {
    const result = await run(cwd, args)
    if (result.code !== 0) {
      const reason = `git ${args.join(' ')} failed (${result.code}): ${result.stderr.trim()}`
      throw new WorkspaceError('git_failed', reason)
    }
    return result.stdout.trim()
  }
  return {
    run,
    must,
    async version(cwd) {
      return parseVersion(await must(cwd, ['--version']))
    },
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
    async localBranches(cwd, prefix) {
      const refs = await must(cwd, ['for-each-ref', '--format=%(refname)', `${BRANCHES}${prefix}*`])
      return refs
        .split('\n')
        .filter((ref) => ref !== '')
        .map((ref) => ref.slice(BRANCHES.length))
    },
    async worktreeLocked(cwd, worktreePath) {
      return isLocked(await must(cwd, ['worktree', 'list', '--porcelain']), worktreePath)
    },
  }
}
```
`plugins/workspace-local/src/worktree-files.ts`:
```ts
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { Logger } from '@bytebureau/plugin-api'
import { WorkspaceError } from './errors.js'

const SESSION_MARKER = '.bytebureau-session.json'
// Worktrees live below .bytebureau/ and carry a marker file; git must report neither as untracked
const EXCLUDED = ['.bytebureau/', SESSION_MARKER]
const PLACED = /[\\/]\.bytebureau[\\/]worktrees[\\/][^\\/]+$/u

interface SessionRecord {
  readonly sessionId: string
  readonly projectPath: string
  readonly branch: string
  readonly baseRef: string
}

interface Roots {
  readonly projectPath: string
  readonly worktreePath: string
}

export function isDirectory(directory: string): boolean {
  return existsSync(directory) && statSync(directory).isDirectory()
}

// A session worktree has the marker, or sits where provision puts it: deleting the marker does not make it a project
export function isSessionWorktree(directory: string): boolean {
  return PLACED.test(directory) || existsSync(path.join(directory, SESSION_MARKER))
}

export function writeSessionMarker(worktreePath: string, record: SessionRecord): void {
  writeFileSync(path.join(worktreePath, SESSION_MARKER), `${JSON.stringify(record, null, 2)}\n`)
}

// File system failures come out as workspace errors, like git's
export function onDisk(what: string, work: () => void): void {
  try {
    work()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new WorkspaceError('fs_failed', `${what} failed: ${reason}`)
  }
}

// Adds what is missing to the exclude file and keeps what is there
export function ensureExcluded(excludeFile: string): void {
  const current = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : ''
  const listed = new Set(current.split('\n'))
  const missing = EXCLUDED.filter((line) => !listed.has(line))
  if (missing.length > 0) {
    mkdirSync(path.dirname(excludeFile), { recursive: true })
    const separator = current === '' || current.endsWith('\n') ? '' : '\n'
    appendFileSync(excludeFile, `${separator}${missing.join('\n')}\n`)
  }
}

type Entry = 'copy' | 'missing' | 'not a file' | 'outside the project'

// A path that climbs out of the project, or names the project itself, is not an entry of it
function isInside(relative: string): boolean {
  const climbs = relative === '..' || relative.startsWith(`..${path.sep}`)
  return relative !== '' && !climbs && !path.isAbsolute(relative)
}

// Links are followed: what an entry resolves to has to lie inside the project as well
function classify(root: string, source: string, relative: string): Entry {
  if (!isInside(relative)) {
    return 'outside the project'
  }
  if (!existsSync(source)) {
    return 'missing'
  }
  if (!isInside(path.relative(realpathSync(root), realpathSync(source)))) {
    return 'outside the project'
  }
  return statSync(source).isFile() ? 'copy' : 'not a file'
}

function copyOne(roots: Roots, file: string, logger: Logger): void {
  const source = path.resolve(roots.projectPath, file)
  const relative = path.relative(roots.projectPath, source)
  const entry = classify(roots.projectPath, source, relative)
  if (entry === 'copy') {
    const target = path.join(roots.worktreePath, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    copyFileSync(source, target)
  } else if (entry !== 'missing') {
    logger.warn('skipping a copyIgnored entry', { file, reason: entry })
  }
}

// Files the project keeps out of git, such as .env, go from the main checkout into the worktree
export function copyIgnoredFiles(roots: Roots, files: readonly string[], logger: Logger): void {
  for (const file of files) {
    copyOne(roots, file, logger)
  }
}
```

- [ ] **Step 7: Runtime**

`plugins/workspace-local/src/local-runtime.ts`:
```ts
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
import { WorkspaceError } from './errors.js'
import { createGit, type Git } from './git.js'
import { createKeyedQueue } from './keyed-queue.js'
import { parseStatusV2 } from './status-parser.js'
import {
  copyIgnoredFiles,
  ensureExcluded,
  isDirectory,
  isSessionWorktree,
  onDisk,
  writeSessionMarker,
} from './worktree-files.js'

const MIN_GIT = [2, 40] as const
const FETCH_INTERVAL_MS = 60_000
// Untracked files count whatever status.showUntrackedFiles says
const STATUS = ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']

interface Placement {
  readonly projectPath: string
  readonly worktreePath: string
  readonly baseRef: string
}

interface WorktreeState {
  readonly dirty: boolean
  readonly branch: string
  readonly locked: boolean
}

function versionTooOld([major, minor]: readonly [number, number]): boolean {
  return major < MIN_GIT[0] || (major === MIN_GIT[0] && minor < MIN_GIT[1])
}

// Worktrees sit in <project>/.bytebureau/worktrees/<session>, three levels below the main checkout
function worktreePathOf(projectPath: string, sessionId: string): string {
  return path.join(projectPath, '.bytebureau', 'worktrees', sessionId)
}

function mainCheckoutOf(worktreePath: string): string {
  return path.resolve(worktreePath, '..', '..', '..')
}

// The first of wanted, wanted-2, wanted-3, ... that no existing branch carries
function firstFree(wanted: string, taken: ReadonlySet<string>): string {
  let candidate = wanted
  for (let suffix = 2; taken.has(candidate); suffix += 1) {
    candidate = `${wanted}-${suffix}`
  }
  return candidate
}

export class LocalWorkspaceRuntime implements WorkspaceRuntime {
  public readonly id = 'local'
  public readonly isolation = 'none'
  private readonly spawner: ProcessSpawner
  private readonly git: Git
  private readonly lastFetch = new Map<string, number>()
  private readonly enqueue = createKeyedQueue()

  public constructor(spawner: ProcessSpawner, logger: Logger) {
    this.spawner = spawner
    this.git = createGit(spawner, logger.child('git'))
  }

  public async provision(spec: WorkspaceSpec): Promise<WorkspaceHandle> {
    const projectPath = await this.checkProject(spec.projectPath)
    await this.excludeFromGit(projectPath)
    const baseRef = await this.resolveBaseRef(projectPath, spec)
    const place = {
      projectPath,
      worktreePath: worktreePathOf(projectPath, spec.sessionId),
      baseRef,
    }
    const branch = await this.enqueue(projectPath, async () => {
      const added = await this.addWorktree(place, spec.branch)
      return added
    })
    await this.populate(place, branch, spec)
    return { id: spec.sessionId, runtimeId: this.id, path: place.worktreePath, branch, baseRef }
  }

  public async exec(handle: WorkspaceHandle, spec: ExecSpec): Promise<ExecHandle> {
    const child = await this.spawner.spawn({ ...spec, cwd: handle.path })
    return child
  }

  public async status(handle: WorkspaceHandle): Promise<WorkspaceStatus> {
    const state = await this.worktreeState(handle)
    // `# branch.ab` exists only with an upstream; count against the base ref instead
    const range = `${handle.baseRef}...HEAD`
    const counts = await this.git.must(handle.path, ['rev-list', '--left-right', '--count', range])
    const [behind = '0', ahead = '0'] = counts.split('\t')
    return { ...state, ahead: Number(ahead), behind: Number(behind) }
  }

  public async destroy(
    handle: WorkspaceHandle,
    options: { readonly force?: boolean } = {},
  ): Promise<void> {
    const state = await this.worktreeState(handle)
    if (state.locked) {
      throw new WorkspaceError('locked', `worktree ${handle.path} is locked`)
    }
    if (state.dirty && options.force !== true) {
      throw new WorkspaceError('dirty', `worktree ${handle.path} has uncommitted changes`)
    }
    const args = ['worktree', 'remove', ...(options.force === true ? ['--force'] : []), handle.path]
    await this.git.must(mainCheckoutOf(handle.path), args)
  }

  // What destroy needs to know, which unlike ahead and behind does not depend on the base ref
  private async worktreeState(handle: WorkspaceHandle): Promise<WorktreeState> {
    const parsed = parseStatusV2(await this.git.must(handle.path, STATUS))
    const locked = await this.git.worktreeLocked(handle.path, handle.path)
    return { dirty: parsed.dirty, branch: parsed.branch, locked }
  }

  private async checkProject(projectPath: string): Promise<string> {
    if (!isDirectory(projectPath)) {
      throw new WorkspaceError('not_a_repository', `${projectPath} is not a directory`)
    }
    await this.requireRecentGit(projectPath)
    const toplevel = await this.git.toplevel(projectPath)
    if (toplevel === null) {
      throw new WorkspaceError('not_a_repository', `${projectPath} is not inside a git repository`)
    }
    if (isSessionWorktree(toplevel)) {
      throw new WorkspaceError(
        'is_bytebureau_worktree',
        `${toplevel} is a ByteBureau session worktree`,
      )
    }
    return toplevel
  }

  // A git that cannot say which version it is counts as too old
  private async requireRecentGit(cwd: string): Promise<void> {
    const version = await this.gitVersion(cwd)
    if (versionTooOld(version)) {
      throw new WorkspaceError(
        'git_too_old',
        `git ${version.join('.')} found, ${MIN_GIT.join('.')} or newer is required`,
      )
    }
  }

  private async gitVersion(cwd: string): Promise<readonly [number, number]> {
    try {
      return await this.git.version(cwd)
    } catch {
      return [0, 0]
    }
  }

  private async resolveBaseRef(projectPath: string, spec: WorkspaceSpec): Promise<string> {
    if (!(await this.git.hasRemote(projectPath, 'origin'))) {
      return spec.baseBranch
    }
    await this.fetchThrottled(projectPath, spec.logger)
    const remoteRef = `origin/${spec.baseBranch}`
    return (await this.git.refExists(projectPath, remoteRef)) ? remoteRef : spec.baseBranch
  }

  private async fetchThrottled(projectPath: string, logger: Logger): Promise<void> {
    const last = this.lastFetch.get(projectPath) ?? 0
    if (Date.now() - last < FETCH_INTERVAL_MS) {
      return
    }
    this.lastFetch.set(projectPath, Date.now())
    const result = await this.git.run(projectPath, ['fetch', '--quiet', 'origin'])
    if (result.code !== 0) {
      logger.warn('git fetch failed; continuing with the last known refs', {
        stderr: result.stderr,
      })
    }
  }

  // Nobody else may take the branch name between picking it and adding the worktree
  private async addWorktree(place: Placement, wanted: string): Promise<string> {
    const branch = await this.freeBranch(place.projectPath, wanted)
    const args = ['worktree', 'add', '--no-track', place.worktreePath, '-b', branch, place.baseRef]
    await this.git.must(place.projectPath, args)
    return branch
  }

  // The exclude file belongs to the repository, so a project that is itself a linked worktree shares its main one
  private async excludeFromGit(projectPath: string): Promise<void> {
    const args = ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']
    const excludeFile = await this.git.must(projectPath, args)
    onDisk('updating the exclude list', () => {
      ensureExcluded(excludeFile)
    })
  }

  private async freeBranch(projectPath: string, wanted: string): Promise<string> {
    return firstFree(wanted, new Set(await this.git.localBranches(projectPath, wanted)))
  }

  // A failure here leaves no half-made worktree behind
  private async populate(place: Placement, branch: string, spec: WorkspaceSpec): Promise<void> {
    const { projectPath, baseRef } = place
    try {
      onDisk('preparing the worktree files', () => {
        copyIgnoredFiles(place, spec.copyIgnored, spec.logger)
        writeSessionMarker(place.worktreePath, {
          sessionId: spec.sessionId,
          projectPath,
          branch,
          baseRef,
        })
      })
    } catch (error) {
      await this.discard(place, branch, spec.logger)
      throw error
    }
  }

  private async discard(place: Placement, branch: string, logger: Logger): Promise<void> {
    const remove = ['worktree', 'remove', '--force', place.worktreePath]
    const removed = await this.git.run(place.projectPath, remove)
    const deleted = await this.git.run(place.projectPath, ['branch', '-D', branch])
    if (removed.code !== 0 || deleted.code !== 0) {
      const leftover = { worktree: place.worktreePath, branch }
      logger.warn('could not take back a provision that failed', leftover)
    }
  }
}
```
`no-await-in-loop` fires on an await in a `for` condition too; the shipped `freeBranch` lists local branches once (`for-each-ref`) and loops synchronously over that set, with no cap.

`plugins/workspace-local/src/plugin.ts`:
```ts
import { definePlugin, type Plugin } from '@bytebureau/plugin-api'
import { LocalWorkspaceRuntime } from './local-runtime.js'

export { WorkspaceError, type WorkspaceErrorCode } from './errors.js'
export { LocalWorkspaceRuntime } from './local-runtime.js'

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

Run: `bunx vitest run --project workspace-local` → PASS (69 tests as shipped). `vitest.config.ts`: add `'plugins/workspace-local'` to `projects`, `'plugins/*/src/**/*.ts'` to the coverage `include` and `'**/testing/**'` to `exclude`; `knip.ts`: add `'plugins/workspace-local': { project: ['src/**/*.ts'] }`; `.github/workflows/semantic-pr.yml`: add `workspace-local` to `scopes`. Run `bun install && bun run check` → green (dependency-cruiser confirms the plugin imports only `@bytebureau/plugin-api` and Node built-ins).

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
