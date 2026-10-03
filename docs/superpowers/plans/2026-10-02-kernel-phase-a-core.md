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
- Data location: `~/.bytebureau/data/bytebureau.db` (override with `BYTEBUREAU_HOME`; the data directory 0700 and the database 0600 since the final fix wave); per-project state only under `<project>/.bytebureau/` (`worktrees/`, `sessions/<id>/`, `logs/`, `cache/`, `employees/*.md`, `plugins/`); ByteBureau adds `.bytebureau/` to `.git/info/exclude` and never edits the project's `.gitignore`.
- Session statuses: `created | provisioning | ready | running | waiting_for_human | paused_usage_limit | completed | stopped | errored`; turn statuses `running | completed | interrupted | errored`; ask statuses `pending | answered | expired | cancelled`.
- Worktrees: `<project>/.bytebureau/worktrees/<sessionId>` on branch `bb/<slug>` (`slug` = kebab-case session title or `s-<short id>`, collisions get `-2`, `-3`, …) from `origin/<branch>` when the remote exists, otherwise the local branch; fetch throttled to once per 60 s per project; never operate on the main checkout; refuse to provision when the project path is itself a ByteBureau worktree.
- Ask contract: exactly one `recommended: true` option per question; `recommendationSource ∈ agent | policy | none`; `supervised` employees wait indefinitely; `autonomous` employees auto-proceed with the recommended option after `askTimeout` (default `30m`) for `question` asks only; permission asks never auto-allow — on timeout the kernel answers `deny` with "nobody available to approve; do not retry"; answers record `answered_via`.
- `yolo` permission mode is refused on a runtime with `isolation: 'none'` (the message names the runtime and says containers enable it later).
- Child processes get an explicit environment allowlist (`PATH`, `HOME`, `LANG`/`LC_*`, `TMPDIR`, `TERM`, `SSH_AUTH_SOCK`, profile variables (with the profiles of Phase C), `TRACEPARENT`, `BYTEBUREAU_*`, `providers.<id>.passEnv`), never the full daemon environment; graceful termination SIGINT → SIGTERM after 5 s → SIGKILL after 10 s.
- Config precedence: CLI flags > `BYTEBUREAU_*` environment > `<project>/bytebureau.local.json` > `<project>/bytebureau.json` (or `.jsonc`) > `~/.bytebureau/config.json` > defaults; unknown keys are errors; validation errors name the file and the JSON pointer.
- CLI: `run` exits 0 on completion, 3 when stopped (also on SIGINT), 4 when the session cannot start or finish (provider missing, provider error, `session.errored`, unusable project, and since the final fix wave a worktree that cannot be provisioned); `--json` output is NDJSON and a non-TTY run without `--json` is plain text without colours or prompts (amended during Task 15 — the spec's own acceptance scenario expects a readable usage summary in CI); the recommended option is preselected in interactive asks and chosen by `--yes` only when one is recommended.
- Logging categories `bb.core`, `bb.config`, `bb.store`, `bb.events`, `bb.plugin.<name>`, `bb.agent.<provider>`, `bb.workspace`, `bb.supervisor`, `bb.asks`, `bb.cli`; no secrets in events, logs or output (redaction of the listed field names and patterns, canary tests).
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

Semantics (as shipped, final fix wave): `EmployeeConfig.askTimeout` must match `^\d+\s*(?:ms|s|m|h)$`, the format the kernel's `parseDuration` reads; `providers.<id>` is an object with an optional `passEnv: string[]` beside any keys of the provider plugin (`Schema.StructWithRest`); `decodeEventPayload` decodes with `onExcessProperty: 'error'`, the contract of the published JSON Schema whose payloads are closed objects, and throws an `EventPayloadError` (`event-payload-error.ts`) that names the type for a type outside the catalogue or a payload that does not fit; `eventsJsonSchema` adds every definition through `addDefinitions` (`definitions.ts`), which refuses a different definition under a name already taken instead of replacing it, and `json-schema.test.ts` checks every type of `KERNEL_EVENT_TYPES`; the `@bytebureau/protocol#build` turbo task excludes the generated `schemas/**` from its inputs.

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

const withTimeout = (askTimeout: string): unknown => ({
  ...defaultProjectConfig,
  employees: { developer: { ...defaultProjectConfig.employees['developer'], askTimeout } },
})

describe(decodeProjectConfig, () => {
  it('accepts the documented sample and fills nothing silently', () => {
    const config = decodeProjectConfig(defaultProjectConfig)
    expect(config.version).toBe(1)
    expect(config.employees['developer']).toMatchObject({ permissionMode: 'supervised' })
  })

  it('takes an ask timeout of a whole number and a unit only', () => {
    expect.hasAssertions()
    for (const accepted of ['500ms', '30s', '30m', '1h', '2 h']) {
      expect(() => decodeProjectConfig(withTimeout(accepted))).not.toThrow()
    }
    for (const refused of ['soon', '30', '1.5h', '30min', '-1m']) {
      expect(() => decodeProjectConfig(withTimeout(refused))).toThrow(/askTimeout/u)
    }
  })

  it('reads the passEnv list of a provider and leaves its other keys to the provider', () => {
    const providers = {
      claude: { executable: 'claude', passEnv: ['GH_TOKEN'], extra: { depth: 1 } },
    }
    const config = decodeProjectConfig({ ...defaultProjectConfig, providers })
    expect(config.providers).toStrictEqual(providers)
    const broken = { ...defaultProjectConfig, providers: { claude: { passEnv: 'GH_TOKEN' } } }
    expect(() => decodeProjectConfig(broken)).toThrow(/passEnv/u)
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
import { addDefinitions } from './definitions.js'
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
    expect.hasAssertions()
    const generated = eventsJsonSchema()
    expect(readSchema('events.json')).toStrictEqual(generated)
    for (const type of KERNEL_EVENT_TYPES) {
      expect(generated['$defs']).toHaveProperty([type])
    }
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

  it('publishes the ask timeout as a duration and the passEnv list of a provider beside its own keys', () => {
    const text = JSON.stringify(configJsonSchema())
    expect(text).toContain(String.raw`"pattern":"^\\d+\\s*(?:ms|s|m|h)$"`)
    expect(text).toContain('"passEnv":{"type":"array","items":{"type":"string"}}')
  })

  it('publishes numbers as number or integer, without Infinity or NaN alternatives', () => {
    expect(JSON.stringify(configJsonSchema())).not.toMatch(/Infinity|NaN/u)
    expect(JSON.stringify(eventsJsonSchema())).not.toMatch(/Infinity|NaN/u)
  })
})

describe(addDefinitions, () => {
  it('adds a definition twice when it is the same, and refuses a different one under a taken name', () => {
    const defs: Record<string, unknown> = {}
    addDefinitions(defs, { Usage: { type: 'object' } })
    addDefinitions(defs, { Usage: { type: 'object' } })
    expect(defs).toStrictEqual({ Usage: { type: 'object' } })
    expect(() => {
      addDefinitions(defs, { Usage: { type: 'string' } })
    }).toThrow('two different JSON Schema definitions are named Usage')
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
import { EventPayloadError } from './event-payload-error.js'

export { EventPayloadError } from './event-payload-error.js'

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

const isKernelEventType = (type: string): type is KernelEventType =>
  Object.hasOwn(KernelEventSchemas, type)

export const KERNEL_EVENT_TYPES: readonly KernelEventType[] = Object.keys(
  KernelEventSchemas,
).filter((key) => isKernelEventType(key))

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

// The same contract as the published JSON Schema: every payload is a closed object
const STRICT = { errors: 'all', onExcessProperty: 'error' } as const

/**
 * Decodes the payload of an event against the schema of its type.
 * A type narrowed to a literal gives the typed payload; any other string is checked at run time.
 * Throws an EventPayloadError when the type is not in the catalogue or the payload does not fit its schema.
 * A field the schema does not know is refused, as the published JSON Schema refuses it; a payload grows with a new schema version.
 */
export function decodeEventPayload<EventType extends KernelEventType>(
  type: EventType,
  payload: unknown,
): KernelEventPayload<EventType>
/** Decodes the payload of an event whose type is only known as a string. */
export function decodeEventPayload(type: string, payload: unknown): unknown
export function decodeEventPayload(type: string, payload: unknown): unknown {
  if (!isKernelEventType(type)) {
    throw new EventPayloadError(type, `unknown kernel event type: ${type}`)
  }
  try {
    return Schema.decodeUnknownSync(KernelEventSchemas[type])(payload, STRICT)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new EventPayloadError(type, `the payload of ${type} does not fit its schema: ${reason}`, {
      cause: error,
    })
  }
}
```

- [ ] **Step 5: Config schemas and JSON Schema generation**

`packages/protocol/src/config.ts`:
```ts
import { Schema } from 'effect'
import { Effort, PermissionMode } from './common.js'
import { Appearance, ToolPolicy } from './employee.js'

export const LogLevel = Schema.Literals(['trace', 'debug', 'info', 'warn', 'error'])

// A whole number and a unit, as the kernel parses it: 500ms, 30s, 30m, 1h
const DurationText = Schema.String.check(Schema.isPattern(/^\d+\s*(?:ms|s|m|h)$/u))

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
  askTimeout: Schema.optionalKey(DurationText),
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
// The kernel reads passEnv: the names of further variables of its environment an agent of the provider is given
// Every other key belongs to the provider plugin
const PassEnv = Schema.optionalKey(Schema.Array(Schema.String))
const ProviderSection = Schema.StructWithRest(Schema.Struct({ passEnv: PassEnv }), [
  Schema.Record(Schema.String, Schema.Unknown),
])
const ProvidersSection = Schema.Record(Schema.String, ProviderSection)
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
import { addDefinitions } from './definitions.js'
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

/**
 * JSON Schema (draft 2020-12) of the event envelope and of each kernel event payload, keyed by wire type.
 * Every payload is a closed object, and decodeEventPayload decodes with the same strictness.
 */
export function eventsJsonSchema(): Record<string, unknown> {
  const envelope = Schema.toJsonSchemaDocument(EventEnvelope, { onExcessProperty: 'error' })
  const defs: Record<string, unknown> = {}
  addDefinitions(defs, { EventEnvelope: envelope.schema, ...envelope.definitions })
  for (const [type, schema] of Object.entries(KernelEventSchemas)) {
    const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: 'error' })
    addDefinitions(defs, { [type]: document.schema })
    addDefinitions(defs, document.definitions)
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

Semantics (as shipped, final fix wave): `WorkspaceStatus` carries `pushed` (a remote-tracking ref contains the head of the branch: it was pushed, or merged on the remote); `WorkspaceHandle.id` is documented as the session id the kernel passes in `WorkspaceSpec.sessionId` and expects back unchanged (the kernel itself keys its locks and events by the session id it knows); each `Hooks` member says when the kernel invokes it — `prompt.beforeSend` now, the other four not before Phase C; `PluginEvents.subscribe` delivers what is published from the moment the subscription opens, without history.

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
  /** The session id the kernel passed as WorkspaceSpec.sessionId; the kernel expects it back unchanged. */
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
  /** True when a remote-tracking ref contains the head of the branch: it was pushed, or merged on the remote. */
  readonly pushed: boolean
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
import type { Ask, AskAnswer, EventEnvelope, KernelEvent, PromptInput } from '@bytebureau/protocol'
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
  /** Events published from the moment the subscription opens, as the log stores them, with seq, id and timestamp; history is not replayed. */
  subscribe(filter: {
    readonly types?: readonly string[]
    readonly sessionId?: string
  }): AsyncIterable<EventEnvelope>
}

export interface PluginKv {
  // The stored JSON value; a plugin decodes it with its own schema
  get(key: string): Promise<unknown>
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
  /** Reserved: the kernel does not invoke it before Phase C. */
  readonly 'session.beforeCreate': Hook<SessionCreateInput, SessionCreateInput>
  /** Reserved: the kernel does not invoke it before Phase C. */
  readonly 'agent.beforeSpawn': Hook<AgentSpawnInput, AgentSpawnResult>
  /** Reserved: the kernel does not invoke it before Phase C. */
  readonly 'ask.beforeOpen': Hook<AskOpenInput, AskOpenResult>
  /** Invoked for every prompt before the agent receives it; what it returns is what the agent gets, while the turn records what the caller said. */
  readonly 'prompt.beforeSend': Hook<PromptSendInput, PromptSendInput>
  /** Reserved: the kernel does not invoke it before Phase C. */
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

Semantics (as shipped, final fix wave): `0001_initial` changed in place (no database was released): CHECK constraints hold `sessions.status`, `turns.status`, `tool_calls.kind`, `asks.status` and `asks.recommendation_source` to the protocol's literals, `turns` has `UNIQUE (session_id, idx)` and every child foreign key column is indexed (`sessions.project_id`, `profile_id` and `parent_session_id`, `session_id` and `turn_id` of `messages`, `tool_calls` and `asks`; `turns.session_id` leads the unique index); `applyMigration` checks the migration id again inside its transaction, which the SQLite client opens with `BEGIN IMMEDIATE`, so the second of two kernels that start together skips the migration instead of failing; a failed migration is an `SqlError` whose message names the migration id; the statement splitter cuts at every `;`, so no migration may hold one inside a literal or a trigger body.

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
import { applyMigration, MIGRATIONS, runMigrations } from './migrate.js'
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

const PROJECT = `INSERT INTO projects (id, name, path, default_branch, config_json, created_at, updated_at) VALUES ('p', 'p', '/p', 'main', '{}', 't', 't')`
const session = (id: string, project: string): string =>
  `INSERT INTO sessions (id, project_id, title, employee_json, provider_id, profile_id, workspace_json, status, created_at) VALUES ('${id}', '${project}', 't', '{}', 'fake', NULL, '{}', 'created', '2026-10-02T00:00:00.000Z')`

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

  suite.effect('creates the SP1 tables with foreign keys on and synchronous NORMAL', () =>
    Effect.gen(function* createsTables() {
      const sql = yield* SqlClient.SqlClient
      const tables = yield* sql<{
        readonly name: string
      }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
      const names = tables.map((row) => row.name)
      for (const expected of SP1_TABLES) {
        assert.include(names, expected)
      }
      const fk = yield* sql<{ readonly foreign_keys: number }>`PRAGMA foreign_keys`
      const synchronous = yield* sql<{ readonly synchronous: number }>`PRAGMA synchronous`
      assert.deepStrictEqual(
        [...fk.map((row) => row.foreign_keys), ...synchronous.map((row) => row.synchronous)],
        [1, 1],
      )
    }),
  )

  suite.effect('refuses a row whose foreign key points nowhere and takes one that does not', () =>
    Effect.gen(function* enforcesForeignKeys() {
      const sql = yield* SqlClient.SqlClient
      const orphan = yield* Effect.result(sql.unsafe(session('orphan', 'missing')))
      yield* sql.unsafe(PROJECT)
      const owned = yield* Effect.result(sql.unsafe(session('owned', 'p')))
      assert.deepStrictEqual([Result.isFailure(orphan), Result.isSuccess(owned)], [true, true])
    }),
  )
})

it.layer(StoreTest)('Store migration runner', (suite) => {
  suite.effect(
    'skips a migration that was recorded meanwhile, checking inside its transaction',
    () =>
      Effect.gen(function* skipsRecorded() {
        const sql = yield* SqlClient.SqlClient
        const initial = yield* Effect.fromNullishOr(MIGRATIONS[0])
        yield* applyMigration(sql, initial)
        const recorded = yield* sql<{
          readonly total: number
        }>`SELECT count(*) AS total FROM bb_migrations`
        assert.deepStrictEqual(
          recorded.map((row) => row.total),
          [MIGRATIONS.length],
        )
      }),
  )

  suite.effect('names the migration that failed, and records nothing of it', () =>
    Effect.gen(function* namesFailedMigration() {
      const sql = yield* SqlClient.SqlClient
      const broken = { id: '9999_broken', sql: 'CREATE TABLE broken (id TEXT);\nCREATE TABLE (' }
      const failure = yield* Effect.flip(applyMigration(sql, broken))
      assert.match(failure.message, /^migration 9999_broken failed: /u)
      const leftovers = yield* sql<{
        readonly name: string
      }>`SELECT name FROM sqlite_master WHERE name = 'broken' UNION ALL SELECT id FROM bb_migrations WHERE id = '9999_broken'`
      assert.deepStrictEqual(leftovers, [])
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
// The splitter cuts at every `;`, so no statement may hold one inside a literal or a trigger body
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
  status TEXT NOT NULL CHECK (status IN ('created', 'provisioning', 'ready', 'running', 'waiting_for_human', 'paused_usage_limit', 'completed', 'stopped', 'errored')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  parent_session_id TEXT REFERENCES sessions(id)
);
CREATE INDEX sessions_project ON sessions(project_id);
CREATE INDEX sessions_profile ON sessions(profile_id);
CREATE INDEX sessions_parent ON sessions(parent_session_id);
CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  idx INTEGER NOT NULL,
  prompt_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'interrupted', 'errored')),
  stop_reason TEXT,
  usage_json TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (session_id, idx)
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT REFERENCES turns(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX messages_session ON messages(session_id);
CREATE INDEX messages_turn ON messages(turn_id);
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT REFERENCES turns(id),
  tool_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('builtin', 'mcp', 'bash', 'subagent', 'skill')),
  input_json TEXT NOT NULL,
  output_summary TEXT,
  input_bytes INTEGER NOT NULL DEFAULT 0,
  output_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error_type TEXT
);
CREATE INDEX tool_calls_session ON tool_calls(session_id);
CREATE INDEX tool_calls_turn ON tool_calls(turn_id);
CREATE TABLE asks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_id TEXT REFERENCES turns(id),
  kind TEXT NOT NULL CHECK (kind IN ('question', 'permission')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'expired', 'cancelled')),
  answer_json TEXT,
  recommendation_source TEXT NOT NULL CHECK (recommendation_source IN ('agent', 'policy', 'none')),
  created_at TEXT NOT NULL,
  deadline_at TEXT,
  answered_at TEXT,
  answered_via TEXT
);
CREATE INDEX asks_session ON asks(session_id);
CREATE INDEX asks_turn ON asks(turn_id);
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
import { SqlClient, SqlError } from 'effect/sql'
import { MIGRATIONS, type Migration } from './migrations.js'

export { MIGRATIONS } from './migrations.js'

function statements(migration: Migration): readonly string[] {
  return migration.sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '')
}

const isApplied = (
  sql: SqlClient.SqlClient,
  migration: Migration,
): Effect.Effect<boolean, SqlError.SqlError> =>
  Effect.map(
    sql<{ readonly id: string }>`SELECT id FROM bb_migrations WHERE id = ${migration.id}`,
    (rows) => rows.length > 0,
  )

// A failed migration says which one it was; the store cannot open without it
const failedMigration =
  (migration: Migration) =>
  (error: SqlError.SqlError): SqlError.SqlError =>
    new SqlError.SqlError({
      reason: new SqlError.UnknownError({
        cause: error,
        message: `migration ${migration.id} failed: ${error.message}`,
        operation: `migration ${migration.id}`,
      }),
    })

// The transaction begins IMMEDIATE, so the second of two kernels that start together sees the first one's record and skips
export const applyMigration = (
  sql: SqlClient.SqlClient,
  migration: Migration,
): Effect.Effect<void, SqlError.SqlError> =>
  sql
    .withTransaction(
      Effect.gen(function* applyOnce() {
        if (yield* isApplied(sql, migration)) {
          return
        }
        for (const statement of statements(migration)) {
          yield* sql.unsafe(statement)
        }
        yield* sql`INSERT INTO bb_migrations (id, applied_at) VALUES (${migration.id}, ${new Date().toISOString()})`
      }),
    )
    .pipe(Effect.mapError(failedMigration(migration)))

// Idempotent: every migration runs once, inside its own transaction, in array order
export const runMigrations: Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> =
  Effect.gen(function* runPending() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE IF NOT EXISTS bb_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`
    const applied = yield* sql<{ readonly id: string }>`SELECT id FROM bb_migrations`
    const done = new Set(applied.map((row) => row.id))
    for (const migration of MIGRATIONS) {
      if (!done.has(migration.id)) {
        yield* applyMigration(sql, migration)
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

Semantics (as shipped, final fix wave): each tagged error has a `message` getter on its prototype (its `reason`; for `StoreError` the text of its cause), so every printer of an `Error` says why it failed, while `instanceof`, `_tag` and `Effect.catchTag` stay as they were (`errors.test.ts`) and the CLI tells kernel errors by class. The LogTape console sink writes every record, whatever its level, to stderr (`process.stderr.write`), so stdout stays the output of a command. Before the field redaction the properties of a record are walked: a bigint becomes text (the JSON formatter threw on it and lost the record), an `Error` becomes a record of its name, message, stack, own enumerable fields and cause, so a credential in an error field is deleted like any other, and a cycle on the current path becomes `[Circular]`; `redactFields` passes `maxDepth` 10 and `maxProperties` 200 and keeps the disposal of the sink it wraps. The field list also deletes `proxy-authorization`, `set-cookie`, `passwd` and `access_key` names, and the text patterns rewrite a free-text `Bearer <token>` and the userinfo of a URL of any scheme in any case (`ftp://`, `postgres://`, `HTTPS://`). `effectLevelOf(level, debug)` lowers Effect's minimum to debug when `--debug` is given. `logging.test.ts` is split into `logging-sinks.test.ts` and `logging-fixtures.ts` under the 300-line cap.

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
  'Proxy-Authorization',
  'Cookie',
  'set-cookie',
  'password',
  'passphrase',
  'passwd',
  'accessToken',
  'x-api-key',
  'AWS_ACCESS_KEY_ID',
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
  'Authorization: Bearer abc.DEF-123_canary=',
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

describe('redactText beyond tokens of a known shape', () => {
  it('redacts a bearer token in free text and the credentials of a URL whatever its scheme', () => {
    expect.hasAssertions()
    const format = redactText(jsonLinesFormatter)
    const line = format(
      record(
        {},
        'sent bearer abc.DEF-1 to HTTPS://joe:pw1@example.com, then ftp://ann:pw2@files.example.com and postgres://bob:pw3@db:5432/x',
      ),
    )
    for (const canary of ['abc.DEF-1', 'joe:pw1', 'ann:pw2', 'bob:pw3']) {
      expect(line).not.toContain(canary)
    }
    expect(JSON.parse(line)).toMatchObject({
      message:
        'sent Bearer [REDACTED] to HTTPS://[REDACTED]@example.com, then ftp://[REDACTED]@files.example.com and postgres://[REDACTED]@db:5432/x',
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
import { getLogger } from '@logtape/logtape'
import { Cause, Effect, type LogLevel } from 'effect'
import { describe, expect, it } from 'vitest'
import { captured } from './logging-fixtures.js'
import { configureLogging, effectToLogTape, kernelLogger, parseDebug } from './logging.js'

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
    expect(seen.slice(0, 2).map((entry) => [entry.message[0], entry.properties])).toStrictEqual([
      ['a b', { parts: [{ keep: 1 }, 7] }],
      ['count', { parts: [5] }],
    ])
    expect(seen.slice(2).map((entry) => entry.properties)).toMatchObject([
      { parts: [{ name: 'Error', message: 'boom' }] },
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

const fieldOf = (error: unknown, key: string): unknown =>
  typeof error === 'object' && error !== null ? Reflect.get(error, key) : undefined

// The message of a typed error is its reason
function reasonMessage(this: unknown): string {
  const reason = fieldOf(this, 'reason')
  return typeof reason === 'string' ? reason : ''
}

// A store failure has no reason of its own; the message is what its cause says
function causeMessage(this: unknown): string {
  const cause = fieldOf(this, 'cause')
  return cause instanceof Error ? cause.message : String(cause)
}

// Effect builds a tagged error with an empty message; the getter on its prototype gives it one, so every printer of an Error says why
function described<Constructor extends object>(
  constructor: Constructor,
  message: (this: unknown) => string,
): Constructor {
  const prototype: unknown = Reflect.get(constructor, 'prototype')
  if (typeof prototype === 'object' && prototype !== null) {
    Reflect.defineProperty(prototype, 'message', { get: message, configurable: true })
  }
  return constructor
}

export const ConfigError = described(
  Data.TaggedError('ConfigError')<{
    readonly file: string
    readonly pointer: string
    readonly reason: string
  }>,
  reasonMessage,
)
export type ConfigError = InstanceType<typeof ConfigError>

export const StoreError = described(
  Data.TaggedError('StoreError')<{ readonly cause: unknown }>,
  causeMessage,
)
export type StoreError = InstanceType<typeof StoreError>

// Wraps a failure of the store layer, for Effect.mapError
export const toStoreError = (cause: unknown): StoreError => new StoreError({ cause })

export const WorkspaceError = described(
  Data.TaggedError('WorkspaceError')<{
    readonly code: string
    readonly reason: string
  }>,
  reasonMessage,
)
export type WorkspaceError = InstanceType<typeof WorkspaceError>

export const ProviderError = described(
  Data.TaggedError('ProviderError')<{
    readonly kind: 'auth' | 'ratelimit' | 'crash' | 'protocol' | 'missing'
    readonly reason: string
    readonly retryable: boolean
  }>,
  reasonMessage,
)
export type ProviderError = InstanceType<typeof ProviderError>

export const AskError = described(
  Data.TaggedError('AskError')<{
    readonly code: 'not_found' | 'not_pending' | 'invalid_answer'
    readonly reason: string
  }>,
  reasonMessage,
)
export type AskError = InstanceType<typeof AskError>

export const PluginError = described(
  Data.TaggedError('PluginError')<{
    readonly plugin: string
    readonly reason: string
  }>,
  reasonMessage,
)
export type PluginError = InstanceType<typeof PluginError>

export const SessionError = described(
  Data.TaggedError('SessionError')<{
    readonly code:
      | 'not_found'
      | 'invalid_transition'
      | 'provider_missing'
      | 'yolo_refused'
      | 'employee_missing'
    readonly reason: string
  }>,
  reasonMessage,
)
export type SessionError = InstanceType<typeof SessionError>
```
`packages/kernel/src/logging/redaction.ts`:
```ts
import { redactByField, redactByPattern, type RedactionPattern } from '@logtape/redaction'
import type { LogRecord, Sink, TextFormatter } from '@logtape/logtape'

export const REDACTED_FIELDS: readonly RegExp[] = [
  /^(?:proxy-)?authorization$/iu,
  /^(?:set-)?cookie$/iu,
  /pass(?:word|phrase|wd)?$/iu,
  /token$/iu,
  /api[_-]?key/iu,
  /access[_-]?key/iu,
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
  { pattern: /\bBearer [A-Za-z0-9._~+/-]+=*/giu, replacement: `Bearer ${replacement}` },
  // Any scheme, any case: https, ftp, postgres; userinfo stops at quotes and backslashes, so a JSON line stays valid
  {
    pattern: /(?<scheme>\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:"'\\]+:[^\s/@"'\\]+@/giu,
    replacement: `$<scheme>${replacement}@`,
  },
]

// The redactor stops descending here; what lies deeper is replaced by a marker
const LIMITS = { maxDepth: 10, maxProperties: 200 } as const

const isPlainRecord = (value: object): boolean => {
  const prototype = Reflect.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

type Walk = (value: unknown) => unknown

// The fields of an Error the redactor can see: name, message, stack, its own fields and its cause
const errorFields = (error: Error, walk: Walk): Record<string, unknown> => {
  const own = Object.entries(error).filter(([key]) => key !== 'cause')
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    ...Object.fromEntries(own.map(([key, value]) => [key, walk(value)])),
    ...(error.cause === undefined ? {} : { cause: walk(error.cause) }),
  }
}

const isWalkable = (value: unknown): value is object =>
  typeof value === 'object' &&
  value !== null &&
  (value instanceof Error || Array.isArray(value) || isPlainRecord(value))

const containerOf = (value: object, walk: Walk): unknown => {
  if (value instanceof Error) {
    return errorFields(value, walk)
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => walk(item))
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]))
}

// A bigint becomes text, which the JSON formatter would otherwise throw on; an Error becomes a record the field redaction walks
// Only what is on the current path counts as a cycle; what lies deeper than the redactor looks is left to it
function plainValue(value: unknown, depth: number, path: WeakSet<object>): unknown {
  if (typeof value === 'bigint') {
    return value.toString()
  }
  if (!isWalkable(value) || depth > LIMITS.maxDepth) {
    return value
  }
  if (path.has(value)) {
    return '[Circular]'
  }
  path.add(value)
  const result = containerOf(value, (item) => plainValue(item, depth + 1, path))
  path.delete(value)
  return result
}

const plainProperties = (properties: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [key, plainValue(value, 1, new WeakSet())]),
  )

// The redactor carries over the disposal of the sink it wraps, which is what flushes a file on reset; so does this wrapper
export const redactFields = (sink: Sink): Sink => {
  const redacted = redactByField(sink, {
    fieldPatterns: [...REDACTED_FIELDS],
    action: 'delete',
    ...LIMITS,
  })
  const prepared = (record: LogRecord): void => {
    redacted({ ...record, properties: plainProperties(record.properties) })
  }
  return Object.assign(prepared, redacted)
}

export const redactText = (formatter: TextFormatter): TextFormatter =>
  redactByPattern(formatter, SECRET_PATTERNS)
```
If `redactByField`'s options object uses a different key than `fieldPatterns`/`action` in the installed 2.3.10 types, follow the types (the fact sheet lists `{ fieldPatterns, action?, maxDepth?, maxProperties? }`).

`packages/kernel/src/logging/logging.ts`:
```ts
import {
  ansiColorFormatter,
  configure,
  getLogger,
  jsonLinesFormatter,
  reset,
  type LoggerConfig,
  type LogLevel,
  type LogRecord,
  type Sink,
  type TextFormatter,
} from '@logtape/logtape'
import { getRotatingFileSink } from '@logtape/file'
import type { Logger as PluginLogger } from '@bytebureau/plugin-api'
import { Cause, Layer, Logger, References, type LogLevel as EffectLogLevel } from 'effect'
import { redactFields, redactText } from './redaction.js'

export type KernelLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export interface LoggingOptions {
  readonly level: KernelLogLevel
  readonly json: boolean
  readonly debug?: string | undefined
  readonly file?: string | undefined
  readonly capture?: ((record: LogRecord) => void) | undefined
}

// A level that is missing or unknown is info, so a mistyped flag never silences the kernel
export function parseLogLevel(level: string | undefined): KernelLogLevel {
  if (
    level === 'trace' ||
    level === 'debug' ||
    level === 'info' ||
    level === 'warn' ||
    level === 'error'
  ) {
    return level
  }
  return 'info'
}

const toLogTape = (level: KernelLogLevel): LogLevel => (level === 'warn' ? 'warning' : level)

// --debug lets the categories it selects log at debug, so Effect's own minimum has to let debug records through to them
export const effectLevelOf = (level: KernelLogLevel, debug: string | undefined): KernelLogLevel =>
  debug === undefined || level === 'trace' ? level : 'debug'

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

// Every record goes to stderr, whatever its level: stdout belongs to the output of a command, such as the NDJSON of --json
const stderrSink =
  (formatter: TextFormatter): Sink =>
  (record) => {
    process.stderr.write(formatter(record))
  }

function sinks(options: LoggingOptions): Record<string, Sink> {
  const result: Record<string, Sink> = {
    console: redactFields(
      stderrSink(options.json ? redactText(jsonLinesFormatter) : redactText(ansiColorFormatter)),
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

const effectLevels: Record<KernelLogLevel, EffectLogLevel.LogLevel> = {
  trace: 'Trace',
  debug: 'Debug',
  info: 'Info',
  warn: 'Warn',
  error: 'Error',
}

// Effect drops a record below its minimum level before any logger sees it, so the kernel's level has to reach it too
export const EffectLogLevelLive = (level: KernelLogLevel): Layer.Layer<never> =>
  Layer.succeed(References.MinimumLogLevel, effectLevels[level])

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

Semantics (as shipped): configuration files are data, never code — only regular `bytebureau.json`/`bytebureau.jsonc`, `bytebureau.local.json`/`.jsonc` and `~/.bytebureau/config.json`/`.jsonc` are read; both variants of one name → `ConfigError` naming both; The kernel reads the files as text and parses them with `jsonc-parser` (comments and trailing commas allowed in both extensions; syntax errors are a `ConfigError` naming the file with line and column). c12 was dropped: with rc files, dotenv, environment keys, `package.json`, `extends` and giget switched off it was still a code loader that imported symlink targets, normalised scalar roots to `{}` and dropped top-level `null` sections and `$meta` before validation. Symlinks are followed as text (a link to a script is a parse error and never runs; a dangling link is an error). The spec's "`extends` for team presets" is deferred to a later phase as a kernel-native feature (JSON/JSONC presets by relative path, lowest project layer, cycle detection). Every issue is attributed to the highest-priority layer that contains its pointer (`(defaults)` < user file (`logging` only) < project file < local file < `env:<NAME>` < `flag:<key>`); a missing key goes to the highest-priority file layer holding its parent, else the project file, else `(defaults)`. The user file is checked with its own strict Standard Schema (pointer-level). Any root that is not a plain object (array, `null`, scalar, empty file) is one issue at pointer `""`. A `projectPath` that does not exist or is not a directory fails `load` and is one issue from `validate`. Defaults are `structuredClone`d so resolved configs never share arrays with `defaultProjectConfig`; the built-in `developer` employee and the `claude` provider defaults merge into every project. Final fix wave: `jsonc-parser` assigns the keys it reads, so a `__proto__` key would replace the prototype of its object (and its members would be inherited); such an object is refused with a `ConfigError` at that pointer (`/project/__proto__`, `/__proto__` of the user file), and `mergeConfig` defines keys instead of assigning them, so a `__proto__` key stays a key that validation reports.

- [ ] **Step 1: Failing tests**

`packages/kernel/src/config/merge.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { isPlain, mergeConfig, type Plain } from './merge.js'

// A document parsed by JSON.parse, which defines every key, __proto__ too, as an own key
function parsed(text: string): Plain {
  const value: unknown = JSON.parse(text)
  if (!isPlain(value)) {
    throw new TypeError('not an object')
  }
  return value
}

function sectionOf(merged: Plain): Plain {
  const { section } = merged
  if (!isPlain(section)) {
    throw new TypeError('no section')
  }
  return section
}

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

  it('keeps a __proto__ key a key, never the prototype of the result', () => {
    const merged = mergeConfig({}, parsed('{ "section": { "__proto__": { "polluted": true } } }'))
    const section = sectionOf(merged)
    expect(Reflect.getPrototypeOf(section)).toBe(Object.prototype)
    expect(Object.keys(section)).toStrictEqual(['__proto__'])
    expect(Reflect.get(section, 'polluted')).toBeUndefined()
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

const ownValue = (record: Plain, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined

// Deep merge where the overlay wins; arrays and scalars replace, undefined is skipped at every depth
// Keys are defined, not assigned: a "__proto__" key stays a key that validation reports, it never becomes a prototype
export function mergeConfig(base: Plain, overlay: Plain): Plain {
  const result: Plain = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== undefined) {
      const merged = isPlain(value) ? mergeConfig(sectionOf(ownValue(result, key)), value) : value
      Reflect.defineProperty(result, key, {
        value: merged,
        enumerable: true,
        writable: true,
        configurable: true,
      })
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
import { pointerOf } from './issues.js'
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
  // The keys to the first object whose prototype a "__proto__" key replaced, if any
  readonly prototyped: readonly string[] | null
}

const childrenOf = (value: object): readonly (readonly [string, unknown])[] =>
  Array.isArray(value)
    ? value.map((item: unknown, index) => [String(index), item] as const)
    : Object.entries(value)

// The parser assigns the keys it reads, so a "__proto__" key sets the prototype of its object instead of becoming a key
function prototypedPath(value: unknown, keys: readonly string[]): readonly string[] | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const prototype = Reflect.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return [...keys, '__proto__']
  }
  for (const [key, child] of childrenOf(value)) {
    const found = prototypedPath(child, [...keys, key])
    if (found !== null) {
      return found
    }
  }
  return null
}

function parseText(text: string): Parsed {
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true, allowEmptyContent: true })
  return { value, errors, prototyped: prototypedPath(value, []) }
}

// The parser recurses, so a pathologically nested file throws instead of returning
function parseConfig(file: string, raw: string): Effect.Effect<Plain, ConfigError> {
  const text = raw.startsWith(BOM) ? raw.slice(BOM.length) : raw
  return Effect.gen(function* parseJson() {
    const { value, errors, prototyped } = yield* Effect.try({
      try: () => parseText(text),
      catch: (cause) => failure(file, String(cause)),
    })
    const [first] = errors
    if (first !== undefined) {
      const position = positionOf(text, first.offset)
      return yield* failure(file, `${printParseErrorCode(first.error)} at ${position}`)
    }
    if (prototyped !== null) {
      const reason = 'a "__proto__" key is not allowed'
      return yield* new ConfigError({ file, pointer: pointerOf(prototyped), reason })
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
export const pointerOf = (keys: readonly PropertyKey[]): string =>
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

Semantics: durable events get the next `seq` from SQLite (`RETURNING seq`) and `seq` is monotonic across the process; ephemeral events carry `seq: 0`, are never persisted and are delivered only to live subscribers. `subscribe` takes the hub subscription explicitly (`PubSub.subscribe` inside `Stream.unwrap`) before the replay read, replays rows with `seq > since`, then forwards live envelopes whose `seq` is greater than the replay watermark (ephemeral always pass), so a subscriber sees no gap and no duplicate. As shipped: the watermark is the static last replayed `seq` (a moving one would drop a late lower-`seq` event from a concurrent publisher, so live delivery is complete but not ordered under concurrency — consumers order by `seq`); `read` narrows with `sql.and` so the `(session_id, seq)`/`(project_id, seq)` indexes are used; a missing `RETURNING` row fails the publish; the hub is never shut down (Task 14 adds the finalizer). Final fix wave: a payload `JSON.stringify` cannot hold (a bigint, a cycle) fails `publish` with a `StoreError` before anything is stored, and a row whose `payload_json` is not JSON fails `read` and the replay of `subscribe` with a `StoreError` that names its seq instead of a defect; the insert and the hub publish are uninterruptible together, so a stored row is always offered to the live subscribers; an ephemeral event published while the replay is read waits in the subscription and arrives after the replayed rows; `event-log-concurrency.test.ts` drives a `SqlClient` proxy that holds a chosen statement at a gate (a straggler replayed once and never offered live again, a live straggler that arrives after a later event, the ephemeral ordering, a publisher interrupted after its insert) and `event-log-payload.test.ts` round-trips null, primitives and arrays nested in payloads. Deferred to Phase B: whether payloads are redacted once at `EventLog.publish` or by every reader (an ADR); today the log stores what it is given and the sinks redact what they print.

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
import { StoreError, toStoreError } from '../errors.js'
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

const unreadable =
  (seq: number): ((cause: unknown) => StoreError) =>
  (cause) =>
    new StoreError({ cause: new Error(`the payload of event ${seq} is not JSON`, { cause }) })

// The protocol declares the ids optional keys, so an absent one is left out and never set to undefined
// A row whose payload is not JSON is a failure of the store that names the row, not a defect
const fromRow = (row: Row): Effect.Effect<EventEnvelope, StoreError> =>
  Effect.try({
    try: (): unknown => JSON.parse(row.payload_json),
    catch: unreadable(row.seq),
  }).pipe(
    Effect.map((payload) => ({
      seq: row.seq,
      id: row.id,
      ts: row.ts,
      type: row.type,
      ...(row.project_id === null ? {} : { projectId: row.project_id }),
      ...(row.session_id === null ? {} : { sessionId: row.session_id }),
      ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
      payload,
    })),
  )

// A payload JSON cannot hold, such as a bigint or a cycle, is refused before anything is stored
const payloadJson = (event: KernelEvent): Effect.Effect<string, StoreError> =>
  Effect.try({
    try: () => JSON.stringify(event.payload),
    catch: (cause) =>
      new StoreError({
        cause: new Error(`the payload of a ${event.type} event cannot be stored as JSON`, {
          cause,
        }),
      }),
  })

// RETURNING yields the one new row; a missing row fails the publish instead of passing for an ephemeral seq 0
const insertEvent = (
  sql: SqlClient.SqlClient,
  event: KernelEvent,
  stamp: { readonly id: string; readonly ts: string },
): Effect.Effect<number, StoreError> =>
  Effect.flatMap(payloadJson(event), (json) =>
    sql<Pick<Row, 'seq'>>`
      INSERT INTO events (id, ts, type, project_id, session_id, turn_id, payload_json)
      VALUES (${stamp.id}, ${stamp.ts}, ${event.type}, ${event.projectId ?? null}, ${event.sessionId ?? null}, ${event.turnId ?? null}, ${json})
      RETURNING seq`.pipe(
      Effect.flatMap(([row]) => Effect.fromNullishOr(row)),
      Effect.map((row) => row.seq),
      Effect.mapError(toStoreError),
    ),
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
      Effect.mapError(toStoreError),
      Effect.flatMap((rows) => Effect.all(rows.map((row) => fromRow(row)))),
      Effect.map((events) => events.filter((event) => matches(filter, event))),
    )

// Nothing may interrupt the steps from the insert on: a stored row that no live subscriber is offered would be seen only by a replay
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
    }).pipe(Effect.uninterruptible)

// The subscription opens before the replay is read, so nothing published meanwhile is lost
// An event can then arrive twice; the live part drops those the replay already carried
// An ephemeral event published during the replay waits in the subscription, so it arrives after the replayed rows
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

// Releasing the layer shuts the hub down, which ends the subscriptions that wait on it as if the stream had run out
const make = Effect.gen(function* makeEventLog() {
  const sql = yield* SqlClient.SqlClient
  const hub = yield* PubSub.unbounded<EventEnvelope>()
  yield* Effect.addFinalizer(() => PubSub.shutdown(hub))
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

Semantics (as shipped): `defaultProjectConfig` no longer carries `project.defaultBranch` or `defaults.branch` (per-repository values; merging `'main'` into every project made `defaultBranchOf` dead code and would base sessions of a `develop` repository on `main`), the init template documents both keys in comments instead, and the registry resolves `defaultBranch = config.project.defaultBranch ?? defaultBranchOf(root)` (`refs/remotes/origin/HEAD` read in full and stripped of its prefix — a local branch named `origin/main` made `--short` ambiguous — else the checked-out branch, else `main`). `createTempRepo({ withRemote: true })` has no `origin/HEAD` (`push -u` creates only the branch ref), so the test named after it exercises the fallback; the `set-head` case has its own test. `config_json` is the merged, validated `ProjectConfig`; re-registering rebuilds the row from its id, path and `created_at`, so a snapshot that no longer decodes is repaired; until then `list` and `get` fail with a `StoreError` that names the project. The SQL lives in `project-records.ts`. `remove(id)` counts the sessions of the project and deletes it in one transaction: while sessions reference the project it is refused with `WorkspaceError` `has_sessions` (`project <name> still has <n> sessions`, which `projects rm` prints before it exits 1), and `project.removed` is announced only when `DELETE … RETURNING` removed a row. Projects are listed by `name COLLATE NOCASE`, then `path`. `git()` runs with the allowlisted environment plus `GIT_TERMINAL_PROMPT=0` and a 10 s timeout and cuts only the final newline; `isByteBureauWorktree` also matches the `…/.bytebureau/worktrees/<id>` path shape, tested with a real `git worktree add`. Temp repositories are `realpathSync`ed (macOS `/var` → `/private/var`, git reports the real path).

- [ ] **Step 1: Failing tests**

`packages/kernel/src/projects/git-root.test.ts`:
```ts
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createTempRepo, git, tempDir } from '../testing/temp-repo.js'
import { defaultBranchOf, findGitRoot, isByteBureauWorktree } from './git-root.js'

// A variable of this process for the rest of the test
function setEnv(name: string, value: string): void {
  const before = process.env[name]
  process.env[name] = value
  onTestFinished(() => {
    if (before === undefined) {
      Reflect.deleteProperty(process.env, name)
    } else {
      process.env[name] = before
    }
  })
}

// A session worktree where provisioning puts one, added by git itself, without the marker file
function placedWorktree(): string {
  const repo = createTempRepo()
  const worktree = path.join(repo, '.bytebureau', 'worktrees', 's1')
  git(repo, 'worktree', 'add', '-q', worktree, '-b', 'bb/s1')
  return realpathSync(worktree)
}

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

  it('keeps a space at the end of the path, cutting only the newline git ends with', () => {
    const repo = path.join(tempDir('bb-space-'), 'repo ')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    expect(findGitRoot(repo)).toBe(repo)
  })

  it('runs git without the variables the kernel does not pass on, such as GIT_DIR', () => {
    const repo = createTempRepo()
    setEnv('GIT_DIR', path.join(tempDir('bb-nowhere-'), 'missing.git'))
    expect(findGitRoot(repo)).toBe(repo)
  })

  it('finds the toplevel of a session worktree that git added', () => {
    const worktree = placedWorktree()
    expect(findGitRoot(worktree)).toBe(worktree)
  })
})

describe(isByteBureauWorktree, () => {
  it('recognises the session marker file', () => {
    const repo = createTempRepo()
    expect(isByteBureauWorktree(repo)).toBe(false)
    writeFileSync(path.join(repo, '.bytebureau-session.json'), '{}')
    expect(isByteBureauWorktree(repo)).toBe(true)
  })

  it('recognises a worktree where provisioning puts one, without its marker', () => {
    expect(isByteBureauWorktree(placedWorktree())).toBe(true)
    expect(isByteBureauWorktree('/repo/.bytebureau/worktrees')).toBe(false)
    expect(isByteBureauWorktree('/repo/.bytebureau/worktrees/s1/src')).toBe(false)
  })
})

describe(defaultBranchOf, () => {
  it('uses origin/HEAD when present and the checked-out branch otherwise', () => {
    expect(defaultBranchOf(createTempRepo())).toBe('main')
    expect(defaultBranchOf(createTempRepo({ withRemote: true }))).toBe('main')
  })

  it('takes the checked-out branch of a repository without a remote, such as master', () => {
    const repo = createTempRepo()
    git(repo, 'branch', '-m', 'main', 'master')
    expect(defaultBranchOf(repo)).toBe('master')
  })

  it('falls back to main when nothing is checked out', () => {
    const repo = createTempRepo()
    git(repo, 'checkout', '-q', '--detach')
    expect(defaultBranchOf(repo)).toBe('main')
    expect(defaultBranchOf(emptyRepo())).toBe('main')
  })

  it('reads origin/HEAD in full, so a local branch named origin/main does not confuse it', () => {
    const repo = createTempRepo({ withRemote: true })
    git(repo, 'remote', 'set-head', 'origin', 'main')
    git(repo, 'branch', 'origin/main')
    expect(defaultBranchOf(repo)).toBe('main')
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

  suite.effect(
    'removes a project and announces it, and announces nothing for an id nobody holds',
    () =>
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
        assert.deepStrictEqual(types, [['project.registered', 'project.removed'], []])
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
import { allowlistEnv } from '../process/env-allowlist.js'

const REMOTE_HEAD = 'refs/remotes/origin/'
// Where provisioning puts a worktree: a session worktree even after its marker is deleted
const PLACED = /[\\/]\.bytebureau[\\/]worktrees[\\/][^\\/]+$/u
const GIT_TIMEOUT_MS = 10_000

// Git sees the allowlisted environment, cannot prompt and cannot hang the kernel; only the final newline of its output goes
function git(cwd: string, args: readonly string[]): string | null {
  try {
    const output = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...allowlistEnv(process.env), GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
    })
    return output.replace(/\r?\n$/u, '')
  } catch {
    return null
  }
}

export const findGitRoot = (directory: string): string | null =>
  git(directory, ['rev-parse', '--show-toplevel'])

export const isByteBureauWorktree = (root: string): boolean =>
  PLACED.test(root) || existsSync(path.join(root, '.bytebureau-session.json'))

// The default branch is origin/HEAD read in full (a local branch named origin/main makes --short ambiguous), else the checked-out branch, else main
export function defaultBranchOf(root: string): string {
  const remoteHead = git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
  if (remoteHead !== null && remoteHead.startsWith(REMOTE_HEAD)) {
    return remoteHead.slice(REMOTE_HEAD.length)
  }
  return git(root, ['symbolic-ref', '--short', 'HEAD']) ?? 'main'
}
```
`packages/kernel/src/projects/project-registry.ts`:
```ts
import path from 'node:path'
import type { ProjectConfig } from '@bytebureau/protocol'
import { Context, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { Config, type ConfigShape } from '../config/config.js'
import { WorkspaceError, type ConfigError, type StoreError } from '../errors.js'
import { EventLog, type EventLogShape } from '../events/event-log.js'
import { nowIso, uuidv7 } from '../ids.js'
import { defaultBranchOf, findGitRoot, isByteBureauWorktree } from './git-root.js'
import {
  deleteProject,
  findByPath,
  getProject,
  insertProject,
  listProjects,
  updateProject,
  type Project,
  type Row,
} from './project-records.js'

export type { Project } from './project-records.js'

export interface ProjectRegistryShape {
  readonly register: (
    directory: string,
  ) => Effect.Effect<Project, WorkspaceError | ConfigError | StoreError>
  readonly list: () => Effect.Effect<readonly Project[], StoreError>
  readonly get: (id: string) => Effect.Effect<Project | undefined, StoreError>
  // A project that sessions still belong to is refused with WorkspaceError has_sessions
  readonly remove: (id: string) => Effect.Effect<void, StoreError | WorkspaceError>
}

export class ProjectRegistry extends Context.Service<ProjectRegistry, ProjectRegistryShape>()(
  'bb/ProjectRegistry',
) {}

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

// Removing an id nobody holds is not an error, and announces nothing
const makeRemove =
  ({ sql, log }: Deps): ProjectRegistryShape['remove'] =>
  (id) =>
    Effect.gen(function* removeProject() {
      const removed = yield* deleteProject(sql, id)
      if (removed) {
        yield* log.publish({ type: 'project.removed', projectId: id, payload: { id } })
      }
    })

const make = Effect.gen(function* makeProjectRegistry() {
  const sql = yield* SqlClient.SqlClient
  const log = yield* EventLog
  const config = yield* Config
  const deps: Deps = { sql, log, config }
  return ProjectRegistry.of({
    register: makeRegister(deps),
    list: () => listProjects(sql),
    get: (id) => getProject(sql, id),
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

Env allowlist (spec §13): `PATH`, `HOME`, `LANG`, `LC_*`, `TMPDIR`, `TERM`, `TRACEPARENT`, `BYTEBUREAU_*`, plus `passEnv` names (profile variables arrive through `passEnv`, built by Task 13); everything else is dropped, and `spec.env` goes through the same filter. Kill ladder: `SIGINT`, after 5 s `SIGTERM`, after another 10 s `SIGKILL`, each step skipped once the process has exited; an explicit signal sends only that signal; an aborted `SpawnSpec.signal` runs the ladder. As shipped: children are spawned `detached: true` in their own process group and every signal goes to the group (`process.kill(-pid)`, falling back to `child.kill`), so agent helpers such as MCP servers die with the agent; `exit`, the ladder's "exited", `list()` and the scope finalizer follow the process `exit` event with a 2 s pipe-drain bound (`close` first wins), and nothing is signalled after release (a freed pid may belong to someone else); scope close is `SIGTERM` then `SIGKILL` after 10 s; the pumps read readline `line` events because the readline async iterator loses a line and throws `ERR_USE_AFTER_CLOSE` under consumer lag on Bun and Node alike; queues are unbounded (unread output stays in memory; `maxLines` bounds only `recentStderr()`); start failures (missing command, bad cwd, invalid arguments) resolve `exit` with code -1 and one stderr line, `ERR_INVALID_ARG_*` reported by code so no value is echoed. A terminal Ctrl-C no longer reaches detached children directly: the `--no-daemon` CLI closes its scopes from its own SIGINT handler. Final fix wave: when the two-second drain times out both pipes are destroyed (`drain.ts`), so a grandchild that still writes gets EPIPE and ends and no descriptor stays open; `passEnv` is filled from `providers.<id>.passEnv` by Task 13, and profile variables arrive with the profiles of Phase C. Deferred to Phase C: the restart policy of spec §14 (restart with backoff, at most 3) arrives with the real providers; `restartSchedule` is exported and not used yet.

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
        SSH_AUTH_SOCK: '/tmp/agent.sock',
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
      'SSH_AUTH_SOCK',
      'TERM',
      'TMPDIR',
      'TRACEPARENT',
    ])
  })

  it('drops look-alike names, unset variables and extras the source does not have', () => {
    const env = allowlistEnv(
      {
        PATHS: '/x',
        path: '/lower',
        LC: 'x',
        BYTEBUREAU: 'y',
        SSH_AUTH_SOCKET: '/z',
        HOME: undefined,
        LANG: 'C',
      },
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
  isAlive,
  isPending,
  nodeSpec,
  ownScope,
  REAPING_HOLDER,
  spawnHolder,
  untilUnlisted,
  WRITING_HOLDER,
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

  suite.effect(
    'destroys the pipes after the drain, so a grandchild that still writes gets EPIPE and ends',
    () =>
      Effect.gen(function* endsLingeringWriter() {
        const supervisor = yield* Supervisor
        const { child, grandchildPid } = yield* spawnHolder(supervisor, WRITING_HOLDER)
        yield* child.kill('SIGKILL')
        yield* untilUnlisted(supervisor)
        yield* TestClock.adjust('2 seconds')
        yield* child.exit
        while (isAlive(grandchildPid)) {
          yield* Effect.yieldNow
        }
        assert.isFalse(isAlive(grandchildPid))
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

// Writes a line every 20 ms; a write that fails, as one to a pipe nobody reads any more does, ends the process
const WRITER = String.raw`setInterval(() => process.stdout.write('tick\n'), 20)`

// The grandchild has left the group and writes to the pipe it shares with the child
export const WRITING_HOLDER = `const grand = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(WRITER)}], { stdio: "inherit", detached: true }); console.log("up " + grand.pid); setInterval(() => {}, 1000)`

// Whether a process of that pid still exists
export const isAlive = (pid: number): boolean => {
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}

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
const FIXED = new Set(['PATH', 'HOME', 'LANG', 'TMPDIR', 'TERM', 'SSH_AUTH_SOCK', 'TRACEPARENT'])

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
import { drain } from './drain.js'
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
    yield* drain(launched)
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

Semantics (as shipped): the session marker `.bytebureau-session.json` is excluded from git together with `.bytebureau/` (otherwise every fresh worktree is dirty); the exclude file comes from `git rev-parse --path-format=absolute --git-path info/exclude` (a project that is itself a linked worktree keeps it in the common directory); "pick a free branch name + `worktree add --no-track`" is serialised per repository through `keyed-queue.ts` (the key is `git rev-parse --git-common-dir`, so a main checkout and its linked worktree registered as two projects share one queue), so same-name fan-outs get `-2`, `-3`, … (local refs only — a branch that exists only on `origin` is not a collision); `status()` runs `git status --porcelain=v2 --branch --untracked-files=normal` (the user's `status.showUntrackedFiles` cannot hide agent files) and fails `git_failed` when the base ref no longer resolves, and reports `pushed` when `git for-each-ref --contains HEAD refs/remotes` names a ref, while `destroy()` checks only dirty and lock state so a worktree whose base is gone can still be removed with `force`; `copyIgnored` entries are confined to regular files inside the project after `realpathSync` (links outside are skipped with a warning); a failure after `worktree add` rolls back (`worktree remove --force`, `branch -D`; best effort, so a spawner that rejects cannot replace the original error) and file-system errors are `fs_failed`; a missing project directory is `not_a_repository`; a toplevel at `…/.bytebureau/worktrees/<id>` counts as a ByteBureau worktree even without the marker; provisioning warnings go to `WorkspaceSpec.logger`. The test spawner maps abort and start failures into `exited` like the kernel's supervisor and runs git with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`; it drops the output of a process that exited before anyone started reading, so tests read streams at once. Deferred: one shared test-support package for the `node-spawner` and `temp-repo` copies of the kernel, this plugin and the CLI.

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

// A spawner that rejects the git commands that start with one of the phrases, as a spawner that cannot start a process does
export function rejectingSpawner(...phrases: readonly string[]): ProcessSpawner {
  return {
    async spawn(spec) {
      if (phrases.includes(spec.args.slice(0, 2).join(' '))) {
        throw new Error(`cannot start git ${spec.args.join(' ')}`)
      }
      const child = await nodeSpawner.spawn(spec)
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
})

describe('branch names of sessions that start at once', () => {
  it('gives sessions of a main checkout and of its linked worktree that start at once a name each', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const linked = path.join(tempDir('bb-linked-'), 'linked')
    git(repo, 'worktree', 'add', '-q', linked, '-b', 'side')
    const runtime = createRuntime()
    const handles = await Promise.all([
      runtime.provision(sameBranch('a', repo)),
      runtime.provision(sameBranch('b', linked)),
      runtime.provision(sameBranch('c', repo)),
      runtime.provision(sameBranch('d', linked)),
    ])
    expect(handles.map((handle) => handle.branch).toSorted()).toStrictEqual([
      'bb/x',
      'bb/x-2',
      'bb/x-3',
      'bb/x-4',
    ])
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

// An empty commit with the message, on whatever is checked out in the directory
function commitEmpty(directory: string, message: string): void {
  git(directory, 'commit', '--allow-empty', '-q', '-m', message)
}

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
      pushed: false,
      locked: false,
      branch: 'bb/add-hello',
    })
  })

  it('reports a branch whose head a remote-tracking ref contains as pushed, and a local commit as not', async () => {
    expect.hasAssertions()
    const repo = createTempRepo({ withRemote: true })
    const runtime = createRuntime()
    const handle = await runtime.provision(workspaceSpec(repo))
    commitEmpty(handle.path, 'work')
    await expect(runtime.status(handle)).resolves.toMatchObject({ ahead: 1, pushed: false })
    git(handle.path, 'push', '-q', 'origin', 'bb/add-hello')
    await expect(runtime.status(handle)).resolves.toMatchObject({ ahead: 1, pushed: true })
    commitEmpty(handle.path, 'more')
    await expect(runtime.status(handle)).resolves.toMatchObject({ ahead: 2, pushed: false })
  })

  it('counts the commits ahead of and behind the base ref', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const runtime = createRuntime()
    const handle = await runtime.provision(workspaceSpec(repo))
    commitEmpty(handle.path, 'work')
    commitEmpty(repo, 'upstream one')
    commitEmpty(repo, 'upstream two')
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
  rejectingSpawner,
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

  it('reports the original error when the spawner rejects while the worktree is taken back', async () => {
    expect.hasAssertions()
    const { logger, entries } = recordingLogger()
    const runtime = createRuntime(rejectingSpawner('worktree remove'))
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
  // The directory every worktree of the repository shares, absolute
  readonly commonDir: (cwd: string) => Promise<string>
  // Whether a remote-tracking ref contains the commit HEAD points at
  readonly onRemote: (cwd: string) => Promise<boolean>
}

type Must = Git['must']

// What the repository as a whole says, whichever of its worktrees is asked
function repositoryQueries(must: Must): Pick<Git, 'commonDir' | 'onRemote'> {
  return {
    async commonDir(cwd) {
      const directory = await must(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      return directory
    },
    async onRemote(cwd) {
      const args = ['for-each-ref', '--contains', 'HEAD', '--format=%(refname)', 'refs/remotes']
      const refs = await must(cwd, args)
      return refs !== ''
    },
  }
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
    ...repositoryQueries(must),
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
    // A main checkout and its linked worktrees share one queue: the branch names they pick from are the same
    const repository = await this.git.commonDir(projectPath)
    const branch = await this.enqueue(repository, async () => {
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
    const pushed = await this.git.onRemote(handle.path)
    return { ...state, ahead: Number(ahead), behind: Number(behind), pushed }
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

  // Taking back a failed provision is best effort: whatever goes wrong here, the caller gets the original error
  private async discard(place: Placement, branch: string, logger: Logger): Promise<void> {
    const leftover = { worktree: place.worktreePath, branch }
    try {
      const remove = ['worktree', 'remove', '--force', place.worktreePath]
      const removed = await this.git.run(place.projectPath, remove)
      const deleted = await this.git.run(place.projectPath, ['branch', '-D', branch])
      if (removed.code !== 0 || deleted.code !== 0) {
        logger.warn('could not take back a provision that failed', leftover)
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      logger.warn('could not take back a provision that failed', { ...leftover, reason })
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
- Create: `packages/kernel/src/workspace/slug.ts`, `packages/kernel/src/workspace/runtimes.ts`, `packages/kernel/src/workspace/workspace-records.ts`, `packages/kernel/src/workspace/workspace-provision.ts`, `packages/kernel/src/workspace/workspace-prune.ts`, `packages/kernel/src/workspace/workspace-manager.ts`, `packages/kernel/src/workspace/workspace-manager-fixtures.ts`, `packages/kernel/src/workspace/workspace-session-fixtures.ts`, the tests `slug.test.ts`, `runtimes.test.ts`, `workspace-manager.test.ts`, `workspace-list.test.ts`, `workspace-prune.test.ts`, and `packages/kernel/src/testing/node-spawner.ts` (verbatim copy of the Task 9 helper)
- Modify: `packages/kernel/src/index.ts`, `packages/kernel/package.json` (`@bytebureau/workspace-local` as a runtime dependency) + `bun.lock`, `packages/kernel/src/errors.ts` (`toStoreError`), `packages/kernel/src/testing/temp-repo.ts` (`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_NOSYSTEM`)

**Interfaces:**
- Consumes: `WorkspaceRuntime`, `WorkspaceHandle`, `WorkspaceStatus` (Task 2); `LocalWorkspaceRuntime` (Task 9, in tests); `SqlClient`, `EventLog`, `Project`; Effect `Clock.currentTimeMillis` (TestClock in tests).
- Produces: `WorkspaceRuntimes` service `{ get(id: string): WorkspaceRuntime | undefined; list(): readonly WorkspaceRuntime[] }` (Task 11 provides it from loaded plugins; tests provide it directly), `WorkspaceManager` service `{ provision(input: ProvisionInput): Effect<WorkspaceHandle, WorkspaceError | StoreError>; status(handle): Effect<WorkspaceStatus, WorkspaceError>; destroy(handle, options?): Effect<void, WorkspaceError | StoreError>; lock(sessionId): Effect<void>; unlock(sessionId): Effect<void>; list(projectId?): Effect<readonly WorkspaceInfo[], StoreError>; prune(projectId?): Effect<PruneReport, StoreError> }`, `WorkspaceManagerLive: Layer<WorkspaceManager, never, SqlClient | EventLog | WorkspaceRuntimes>`, `branchSlug(title: string, sessionId: string): string`, `ProvisionInput { sessionId; project: Project; title: string; baseBranch: string; runtimeId: string }`, `WorkspaceInfo { sessionId; projectId; path; branch; baseRef; sessionStatus; exists: boolean }`, `PruneReport { removed: readonly string[]; retained: readonly { path: string; reason: string }[] }`.

Semantics (as shipped): the handle is stored on the session row (`workspace_json`) and decoded with a schema (a corrupt row is a `StoreError` naming the session); `destroy(sessionId, handle, options)` keys the in-memory per-process lock set and the `sessionId` of `workspace.retained`/`workspace.destroyed` by the session id the manager knows, never by `handle.id`, and returns `{ removed: true }` or `{ removed: false, reason }`; it checks the lock set, then the runtime: with `force` it skips its own `status()` pre-check and delegates (the runtime still refuses a git-locked worktree), without `force` a dirty worktree is retained (`workspace.retained`, reason `uncommitted changes`) and a failing `status()` (base ref gone) retains with reason `status unavailable`; `prune` handles terminal sessions older than `workspace.retainDays` (default 7) in `created_at, id` order, skips worktrees whose path no longer exists, retains a dirty worktree (`uncommitted changes`) and one with commits that no remote-tracking ref contains (`commits not on origin`), so a pushed branch, or a squash-merged one whose remote branch is still known, is removed (the reasons are shared constants in `retain-reasons.ts`), keeps a missing or unreadable `ended_at`, and reports a path as removed only when `destroy` says it removed it (a worktree that turned dirty between the status and the removal is retained with the reason `destroy` gives); the plugin serialises same-name provisioning itself, so the manager has no provisioning lock; `rows()` narrows with `sql.and`. Known limits: a squash-merged branch whose remote branch was deleted and pruned locally counts as not on origin; `s-<short id>` takes the first 8 hex characters of the UUIDv7, which is the timestamp.

- [ ] **Step 1: Failing tests**

`packages/kernel/src/workspace/slug.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { branchSlug } from './slug.js'

const SESSION_ID = '0192f0c8-7b2e-7c3d-9a4b-000000000001'

describe(branchSlug, () => {
  it('kebab-cases the title, strips diacritics and caps the length', () => {
    expect(branchSlug('Create src/hello.ts exporting hello()', 's')).toBe(
      'bb/create-src-hello-ts-exporting-hello',
    )
    expect(branchSlug('Přidat českou podporu!', 's')).toBe('bb/pridat-ceskou-podporu')
    expect(branchSlug('a'.repeat(80), 's')).toBe(`bb/${'a'.repeat(40)}`)
  })

  it('falls back to the short session id when nothing is left', () => {
    expect(branchSlug('???', SESSION_ID)).toBe('bb/s-0192f0c8')
  })

  it('falls back for an empty title, for symbols and for marks without a letter', () => {
    expect(branchSlug('', SESSION_ID)).toBe('bb/s-0192f0c8')
    expect(branchSlug('🎉 ✨', SESSION_ID)).toBe('bb/s-0192f0c8')
    expect(branchSlug('́́', SESSION_ID)).toBe('bb/s-0192f0c8')
  })

  it('does not end on the dash that the cut leaves behind', () => {
    expect(branchSlug(`${'a'.repeat(39)} b`, 's')).toBe(`bb/${'a'.repeat(39)}`)
  })

  it('keeps digits and collapses every run of other characters into one dash', () => {
    expect(branchSlug('  Fix #42 --  the   build_  ', 's')).toBe('bb/fix-42-the-build')
  })
})
```
`packages/kernel/src/workspace/workspace-manager.test.ts`:
```ts
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import type { Project } from '../projects/project-registry.js'
import { git } from '../testing/temp-repo.js'
import { TestLayer } from './workspace-manager-fixtures.js'
import { WorkspaceManager } from './workspace-manager.js'
import {
  codeOf,
  eventsOf,
  provisionSession,
  registerRepo,
  storedWorkspaceOf,
} from './workspace-session-fixtures.js'

const PROVISIONING = 'provisioning'

it.layer(TestLayer)('WorkspaceManager provision', (suite) => {
  suite.effect(
    'provisions on bb/<slug>, records the handle on the session and emits workspace.provisioned',
    () =>
      Effect.gen(function* provisionsWorkspace() {
        const { repo, project } = yield* registerRepo()
        const seed = { id: 'session-1', status: PROVISIONING }
        const handle = yield* provisionSession(project, seed, { title: 'Add hello' })
        assert.strictEqual(handle.branch, 'bb/add-hello')
        assert.strictEqual(handle.path, path.join(repo, '.bytebureau', 'worktrees', 'session-1'))
        const payload = {
          path: handle.path,
          branch: handle.branch,
          baseRef: 'main',
          runtimeId: 'local',
        }
        const announced = [{ type: 'workspace.provisioned', projectId: project.id, payload }]
        assert.deepStrictEqual(yield* eventsOf('session-1'), announced)
        assert.deepStrictEqual(yield* storedWorkspaceOf('session-1'), handle)
      }),
  )

  suite.effect('fails for a runtime nobody provides and leaves the session and the log alone', () =>
    Effect.gen(function* refusesUnknownRuntime() {
      const { project } = yield* registerRepo()
      const seed = { id: 'session-2', status: PROVISIONING }
      const error = yield* Effect.flip(provisionSession(project, seed, { runtimeId: 'nobody' }))
      assert.strictEqual(codeOf(error), 'runtime_missing')
      assert.deepStrictEqual(yield* eventsOf('session-2'), [])
      assert.deepStrictEqual(yield* storedWorkspaceOf('session-2'), {})
    }),
  )

  suite.effect('passes a failure of the runtime on with its code and records nothing', () =>
    Effect.gen(function* relaysRuntimeFailure() {
      const { project } = yield* registerRepo()
      const missing = { ...project, path: path.join(project.path, 'missing') }
      const error = yield* Effect.flip(
        provisionSession(missing, { id: 'session-3', status: PROVISIONING }),
      )
      assert.strictEqual(codeOf(error), 'not_a_repository')
      assert.deepStrictEqual(yield* eventsOf('session-3'), [])
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager provision together', (suite) => {
  suite.effect('keeps the branches of sessions that share a title and start together apart', () =>
    Effect.gen(function* provisionsTogether() {
      const { project } = yield* registerRepo()
      const title = { title: 'Same task' }
      const [first, second] = yield* Effect.all(
        [
          provisionSession(project, { id: 'twin-1', status: PROVISIONING }, title),
          provisionSession(project, { id: 'twin-2', status: PROVISIONING }, title),
        ],
        { concurrency: 'unbounded' },
      )
      assert.deepStrictEqual([first.branch, second.branch].toSorted(), [
        'bb/same-task',
        'bb/same-task-2',
      ])
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager provision of ignored files', (suite) => {
  suite.effect('copies the files the project configuration lists into the worktree', () =>
    Effect.gen(function* copiesListedFiles() {
      const { repo, project } = yield* registerRepo({ copyIgnored: ['local.cfg'] })
      writeFileSync(path.join(repo, 'local.cfg'), 'a')
      writeFileSync(path.join(repo, '.env'), 'b')
      const handle = yield* provisionSession(project, { id: 'session-4', status: PROVISIONING })
      assert.isTrue(existsSync(path.join(handle.path, 'local.cfg')))
      assert.isFalse(existsSync(path.join(handle.path, '.env')))
    }),
  )

  suite.effect('copies nothing when the configuration has no workspace section or no list', () =>
    Effect.gen(function* copiesNothing() {
      const { repo, project } = yield* registerRepo()
      writeFileSync(path.join(repo, '.env'), 'b')
      const bare: Project = {
        ...project,
        config: { version: 1, project: { name: 'bare' }, employees: {} },
      }
      const unlisted: Project = {
        ...bare,
        config: { ...bare.config, workspace: { runtime: 'local' } },
      }
      const first = yield* provisionSession(bare, { id: 'session-5', status: PROVISIONING })
      const second = yield* provisionSession(unlisted, { id: 'session-6', status: PROVISIONING })
      assert.isFalse(existsSync(path.join(first.path, '.env')))
      assert.isFalse(existsSync(path.join(second.path, '.env')))
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager destroy', (suite) => {
  suite.effect('refuses to destroy a locked workspace until it is unlocked', () =>
    Effect.gen(function* refusesLockedWorkspace() {
      const { project } = yield* registerRepo()
      const manager = yield* WorkspaceManager
      const handle = yield* provisionSession(project, { id: 'session-7', status: 'running' })
      yield* manager.lock('session-7')
      const refused = yield* Effect.flip(manager.destroy('session-7', handle, { force: true }))
      assert.strictEqual(codeOf(refused), 'locked')
      yield* manager.unlock('session-7')
      yield* manager.destroy('session-7', handle)
      assert.isFalse(existsSync(handle.path))
    }),
  )

  suite.effect('retains a workspace with uncommitted changes and destroys it when forced', () =>
    Effect.gen(function* retainsDirtyWorkspace() {
      const { project } = yield* registerRepo()
      const manager = yield* WorkspaceManager
      const handle = yield* provisionSession(project, { id: 'session-8', status: 'completed' })
      writeFileSync(path.join(handle.path, 'dirty.txt'), 'x')
      const kept = yield* manager.destroy('session-8', handle)
      const stayed = existsSync(handle.path)
      const forced = yield* manager.destroy('session-8', handle, { force: true })
      assert.deepStrictEqual(
        [kept, stayed, forced, existsSync(handle.path)],
        [{ removed: false, reason: 'uncommitted changes' }, true, { removed: true }, false],
      )
      const later = (yield* eventsOf('session-8')).slice(1)
      assert.deepStrictEqual(later, [
        {
          type: 'workspace.retained',
          payload: { path: handle.path, reason: 'uncommitted changes' },
        },
        { type: 'workspace.destroyed', payload: { path: handle.path } },
      ])
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager destroy without status', (suite) => {
  suite.effect('retains a workspace whose status is unavailable and destroys it when forced', () =>
    Effect.gen(function* retainsWithoutStatus() {
      const { repo, project } = yield* registerRepo()
      const manager = yield* WorkspaceManager
      const handle = yield* provisionSession(project, { id: 'session-11', status: 'completed' })
      git(repo, 'branch', '-m', 'main', 'trunk')
      yield* manager.destroy('session-11', handle)
      assert.isTrue(existsSync(handle.path))
      yield* manager.destroy('session-11', handle, { force: true })
      assert.isFalse(existsSync(handle.path))
      const later = (yield* eventsOf('session-11')).slice(1)
      assert.deepStrictEqual(later, [
        {
          type: 'workspace.retained',
          payload: { path: handle.path, reason: 'status unavailable' },
        },
        { type: 'workspace.destroyed', payload: { path: handle.path } },
      ])
    }),
  )

  suite.effect('leaves a worktree that git has locked in place, even when forced', () =>
    Effect.gen(function* keepsPinnedWorktree() {
      const { repo, project } = yield* registerRepo()
      const manager = yield* WorkspaceManager
      const handle = yield* provisionSession(project, { id: 'session-12', status: 'completed' })
      git(repo, 'worktree', 'lock', handle.path)
      const refused = yield* Effect.flip(manager.destroy('session-12', handle, { force: true }))
      assert.strictEqual(codeOf(refused), 'locked')
      assert.isTrue(existsSync(handle.path))
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager status', (suite) => {
  suite.effect('reports what the runtime knows about the workspace', () =>
    Effect.gen(function* reportsStatus() {
      const { project } = yield* registerRepo()
      const manager = yield* WorkspaceManager
      const handle = yield* provisionSession(project, { id: 'session-9', status: 'running' })
      writeFileSync(path.join(handle.path, 'draft.txt'), 'x')
      const expected = {
        dirty: true,
        ahead: 0,
        behind: 0,
        pushed: false,
        locked: false,
        branch: 'bb/session-9',
      }
      assert.deepStrictEqual(yield* manager.status(handle), expected)
    }),
  )

  suite.effect('refuses a handle of a runtime nobody provides', () =>
    Effect.gen(function* refusesStrayHandle() {
      const { project } = yield* registerRepo()
      const manager = yield* WorkspaceManager
      const handle = yield* provisionSession(project, { id: 'session-10', status: 'running' })
      const stray = { ...handle, runtimeId: 'nobody' }
      const statusError = yield* Effect.flip(manager.status(stray))
      const destroyError = yield* Effect.flip(manager.destroy('session-10', stray))
      const forcedError = yield* Effect.flip(manager.destroy('session-10', stray, { force: true }))
      const codes = [statusError, destroyError, forcedError].map((error) => codeOf(error))
      assert.deepStrictEqual(codes, ['runtime_missing', 'runtime_missing', 'runtime_missing'])
      assert.isTrue(existsSync(handle.path))
    }),
  )
})
```
`packages/kernel/src/workspace/workspace-list.test.ts`:
```ts
import { existsSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'
import { StoreError } from '../errors.js'
import { TestLayer } from './workspace-manager-fixtures.js'
import { WorkspaceManager } from './workspace-manager.js'
import { provisionSession, registerRepo, seedSession } from './workspace-session-fixtures.js'

const ENDED = { status: 'completed', endedAt: '2026-09-01T00:00:00.000Z' } as const

it.layer(TestLayer)('WorkspaceManager list', (suite) => {
  suite.effect(
    'lists the workspaces of a project in session order, flagging a missing directory',
    () =>
      Effect.gen(function* listsWorkspaces() {
        const { project } = yield* registerRepo()
        const manager = yield* WorkspaceManager
        const live = yield* provisionSession(project, { id: 'live', status: 'running' })
        const gone = yield* provisionSession(project, { id: 'gone', ...ENDED })
        yield* seedSession(project.id, { id: 'bare', status: 'created' })
        yield* manager.destroy('gone', gone, { force: true })
        const shared = { projectId: project.id, baseRef: 'main' }
        assert.deepStrictEqual(yield* manager.list(project.id), [
          {
            ...shared,
            sessionId: 'gone',
            path: gone.path,
            branch: 'bb/gone',
            sessionStatus: 'completed',
            exists: false,
          },
          {
            ...shared,
            sessionId: 'live',
            path: live.path,
            branch: 'bb/live',
            sessionStatus: 'running',
            exists: true,
          },
        ])
      }),
  )

  suite.effect('lists nothing for a project without workspaces', () =>
    Effect.gen(function* listsNothing() {
      const { project } = yield* registerRepo()
      yield* seedSession(project.id, { id: 'unprovisioned', status: 'created' })
      assert.deepStrictEqual(yield* (yield* WorkspaceManager).list(project.id), [])
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager list across projects', (suite) => {
  suite.effect('lists every project when none is named', () =>
    Effect.gen(function* listsEveryProject() {
      const first = yield* registerRepo()
      const second = yield* registerRepo()
      const manager = yield* WorkspaceManager
      yield* provisionSession(first.project, { id: 'first-live', status: 'running' })
      yield* provisionSession(second.project, { id: 'second-live', status: 'running' })
      const everything = yield* manager.list()
      const ofSecond = yield* manager.list(second.project.id)
      assert.deepStrictEqual(
        everything.map((info) => info.sessionId),
        ['first-live', 'second-live'],
      )
      assert.deepStrictEqual(
        ofSecond.map((info) => info.sessionId),
        ['second-live'],
      )
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager records', (suite) => {
  suite.effect('fails with a store error naming the session when its record is not JSON', () =>
    Effect.gen(function* refusesTextThatIsNotJson() {
      const { project } = yield* registerRepo()
      yield* seedSession(project.id, { id: 'not-json', status: 'running', workspace: 'not json' })
      const error = yield* Effect.flip((yield* WorkspaceManager).list(project.id))
      assert.instanceOf(error, StoreError)
      assert.include(String(error.cause), 'not-json')
    }),
  )

  suite.effect('fails with a store error naming the session when its record is not a handle', () =>
    Effect.gen(function* refusesWrongShape() {
      const { project } = yield* registerRepo()
      yield* seedSession(project.id, {
        id: 'wrong-shape',
        status: 'running',
        workspace: '{"id":1}',
      })
      const error = yield* Effect.flip((yield* WorkspaceManager).list(project.id))
      assert.instanceOf(error, StoreError)
      assert.include(String(error.cause), 'wrong-shape')
    }),
  )

  suite.effect('prunes nothing while a record cannot be read', () =>
    Effect.gen(function* prunesNothingFromCorruptStore() {
      const { project } = yield* registerRepo()
      const manager = yield* WorkspaceManager
      const clean = yield* provisionSession(project, { id: 'clean', ...ENDED })
      yield* seedSession(project.id, { id: 'corrupt', ...ENDED, workspace: '[]' })
      yield* TestClock.setTime(Date.UTC(2026, 9, 3))
      const error = yield* Effect.flip(manager.prune(project.id))
      assert.instanceOf(error, StoreError)
      assert.isTrue(existsSync(clean.path))
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager store', (suite) => {
  suite.effect('fails with a store error when the store cannot answer', () =>
    Effect.gen(function* failsWithoutStore() {
      const { project } = yield* registerRepo()
      const manager = yield* WorkspaceManager
      yield* (yield* SqlClient.SqlClient)`DROP TABLE sessions`
      const listing = yield* Effect.flip(manager.list(project.id))
      const pruning = yield* Effect.flip(manager.prune(project.id))
      assert.deepStrictEqual(
        [listing, pruning].map((error) => error instanceof StoreError),
        [true, true],
      )
    }),
  )
})
```
`packages/kernel/src/workspace/workspace-prune.test.ts`:
```ts
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { git } from '../testing/temp-repo.js'
import { TestLayer } from './workspace-manager-fixtures.js'
import { WorkspaceManager, type PruneReport } from './workspace-manager.js'
import {
  commitUnmerged,
  provisionSession,
  registerRepo,
  seedSession,
} from './workspace-session-fixtures.js'

// The clock of a test starts at the epoch; the sessions below ended days or weeks before this day
const TODAY = Date.UTC(2026, 9, 3)
const ENDED = { status: 'completed', endedAt: '2026-09-01T00:00:00.000Z' } as const

interface Summary {
  readonly removed: readonly string[]
  readonly retained: Readonly<Record<string, string>>
}

// Names stand for the paths, so the expectations do not depend on the temporary directories
const summarize = (report: PruneReport): Summary => ({
  removed: report.removed.map((removed) => path.basename(removed)),
  retained: Object.fromEntries(
    report.retained.map((entry) => [path.basename(entry.path), entry.reason]),
  ),
})

it.layer(TestLayer)('WorkspaceManager prune', (suite) => {
  suite.effect('prunes only terminal, pushed-or-merged, old worktrees and explains the rest', () =>
    Effect.gen(function* prunesOldWorkspaces() {
      const { project } = yield* registerRepo()
      yield* provisionSession(project, { id: 'old-clean', ...ENDED })
      const ahead = yield* provisionSession(project, { id: 'old-ahead', ...ENDED })
      const yesterday = { status: 'completed', endedAt: '2026-10-02T00:00:00.000Z' }
      yield* provisionSession(project, { id: 'fresh', ...yesterday })
      yield* provisionSession(project, { id: 'live', status: 'running' })
      commitUnmerged(ahead)
      yield* TestClock.setTime(TODAY)
      const report = yield* (yield* WorkspaceManager).prune(project.id)
      assert.deepStrictEqual(summarize(report), {
        removed: ['old-clean'],
        retained: {
          fresh: 'younger than 7 days',
          live: 'session is running',
          'old-ahead': 'commits not on origin',
        },
      })
    }),
  )

  suite.effect('removes the worktree it reports and keeps the others on disk', () =>
    Effect.gen(function* removesReportedWorktree() {
      const { project } = yield* registerRepo()
      const clean = yield* provisionSession(project, { id: 'gone-clean', ...ENDED })
      const draft = yield* provisionSession(project, { id: 'kept-draft', ...ENDED })
      writeFileSync(path.join(draft.path, 'draft.txt'), 'x')
      yield* TestClock.setTime(TODAY)
      const report = yield* (yield* WorkspaceManager).prune(project.id)
      assert.deepStrictEqual(report.removed, [clean.path])
      assert.deepStrictEqual(report.retained, [{ path: draft.path, reason: 'uncommitted changes' }])
      assert.deepStrictEqual([existsSync(clean.path), existsSync(draft.path)], [false, true])
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager prune explanations', (suite) => {
  suite.effect('retains a worktree whose base ref no longer resolves as status unavailable', () =>
    Effect.gen(function* retainsWithoutStatus() {
      const { repo, project } = yield* registerRepo()
      git(repo, 'branch', 'topic')
      const handle = yield* provisionSession(
        project,
        { id: 'orphan', ...ENDED },
        { baseBranch: 'topic' },
      )
      git(repo, 'branch', '-D', 'topic')
      yield* TestClock.setTime(TODAY)
      const report = yield* (yield* WorkspaceManager).prune(project.id)
      assert.deepStrictEqual(report.removed, [])
      assert.deepStrictEqual(report.retained, [{ path: handle.path, reason: 'status unavailable' }])
    }),
  )

  suite.effect('retains the worktree of a session the manager has locked', () =>
    Effect.gen(function* retainsLockedSession() {
      const { project } = yield* registerRepo()
      const manager = yield* WorkspaceManager
      const held = yield* provisionSession(project, { id: 'held', ...ENDED })
      yield* manager.lock('held')
      yield* TestClock.setTime(TODAY)
      const report = yield* manager.prune(project.id)
      const reason = 'session held is running'
      assert.deepStrictEqual(report, { removed: [], retained: [{ path: held.path, reason }] })
    }),
  )

  suite.effect('retains a worktree that git has locked', () =>
    Effect.gen(function* retainsPinnedWorktree() {
      const { repo, project } = yield* registerRepo()
      const pinned = yield* provisionSession(project, { id: 'pinned', ...ENDED })
      git(repo, 'worktree', 'lock', pinned.path)
      yield* TestClock.setTime(TODAY)
      const report = yield* (yield* WorkspaceManager).prune(project.id)
      const { removed, retained } = summarize(report)
      assert.deepStrictEqual(removed, [])
      assert.match(retained['pinned'] ?? '', /locked/u)
      assert.isTrue(existsSync(pinned.path))
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager prune retention', (suite) => {
  suite.effect(
    'keeps a worktree until the retention of the project has passed, to the second',
    () =>
      Effect.gen(function* keepsUntilRetentionEnds() {
        const { project } = yield* registerRepo()
        const due = { status: 'completed', endedAt: '2026-09-26T00:00:00.000Z' }
        const almost = { status: 'completed', endedAt: '2026-09-26T00:00:01.000Z' }
        yield* provisionSession(project, { id: 'due', ...due })
        yield* provisionSession(project, { id: 'almost', ...almost })
        yield* TestClock.setTime(TODAY)
        const report = yield* (yield* WorkspaceManager).prune(project.id)
        const expected = { removed: ['due'], retained: { almost: 'younger than 7 days' } }
        assert.deepStrictEqual(summarize(report), expected)
      }),
  )

  suite.effect('takes the retention from the workspace section of the project configuration', () =>
    Effect.gen(function* honoursRetainDays() {
      const { project } = yield* registerRepo({ retainDays: 60 })
      yield* provisionSession(project, { id: 'month-old', ...ENDED })
      yield* TestClock.setTime(TODAY)
      const report = yield* (yield* WorkspaceManager).prune(project.id)
      const expected = { removed: [], retained: { 'month-old': 'younger than 60 days' } }
      assert.deepStrictEqual(summarize(report), expected)
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager prune statuses', (suite) => {
  suite.effect('treats completed, stopped and errored sessions as over, and no other', () =>
    Effect.gen(function* prunesTerminalSessions() {
      const { project } = yield* registerRepo()
      for (const status of ['completed', 'stopped', 'errored', 'paused_usage_limit']) {
        yield* provisionSession(project, { id: status, status, endedAt: ENDED.endedAt })
      }
      yield* TestClock.setTime(TODAY)
      const report = yield* (yield* WorkspaceManager).prune(project.id)
      assert.deepStrictEqual(summarize(report), {
        removed: ['completed', 'errored', 'stopped'],
        retained: { paused_usage_limit: 'session is paused_usage_limit' },
      })
    }),
  )

  suite.effect('keeps a terminal session whose end time is missing or unreadable', () =>
    Effect.gen(function* keepsWithoutEndTime() {
      const { project } = yield* registerRepo()
      yield* provisionSession(project, { id: 'no-end', status: 'completed' })
      yield* provisionSession(project, { id: 'bad-end', status: 'errored', endedAt: 'long ago' })
      yield* TestClock.setTime(TODAY)
      const report = yield* (yield* WorkspaceManager).prune(project.id)
      const reason = 'younger than 7 days'
      const expected = { removed: [], retained: { 'no-end': reason, 'bad-end': reason } }
      assert.deepStrictEqual(summarize(report), expected)
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager prune of worktrees that are gone', (suite) => {
  suite.effect('says nothing of a worktree that is gone, pruned earlier or deleted by hand', () =>
    Effect.gen(function* skipsGoneWorktrees() {
      const { project } = yield* registerRepo()
      const manager = yield* WorkspaceManager
      const pruned = yield* provisionSession(project, { id: 'pruned', ...ENDED })
      const deleted = yield* provisionSession(project, { id: 'deleted', ...ENDED })
      rmSync(deleted.path, { recursive: true, force: true })
      yield* TestClock.setTime(TODAY)
      const first = yield* manager.prune(project.id)
      const second = yield* manager.prune(project.id)
      assert.deepStrictEqual(first, { removed: [pruned.path], retained: [] })
      assert.deepStrictEqual(second, { removed: [], retained: [] })
    }),
  )

  suite.effect('keeps listing a pruned worktree, flagged as missing', () =>
    Effect.gen(function* listsPrunedWorktree() {
      const { project } = yield* registerRepo()
      const manager = yield* WorkspaceManager
      const pruned = yield* provisionSession(project, { id: 'listed', ...ENDED })
      yield* TestClock.setTime(TODAY)
      yield* manager.prune(project.id)
      const listed = yield* manager.list(project.id)
      assert.deepStrictEqual(
        listed.map((info) => [info.path, info.exists]),
        [[pruned.path, false]],
      )
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager prune scope', (suite) => {
  suite.effect('reports nothing for a project whose sessions have no workspace', () =>
    Effect.gen(function* prunesNothing() {
      const { project } = yield* registerRepo()
      yield* seedSession(project.id, { id: 'unprovisioned', ...ENDED })
      const report = yield* (yield* WorkspaceManager).prune(project.id)
      assert.deepStrictEqual(report, { removed: [], retained: [] })
    }),
  )

  suite.effect('prunes the project it is asked for, and every project when it is not asked', () =>
    Effect.gen(function* prunesWhichProjects() {
      const first = yield* registerRepo()
      const second = yield* registerRepo()
      const manager = yield* WorkspaceManager
      const one = yield* provisionSession(first.project, { id: 'first-old', ...ENDED })
      const two = yield* provisionSession(second.project, { id: 'second-old', ...ENDED })
      yield* TestClock.setTime(TODAY)
      yield* manager.prune(first.project.id)
      assert.deepStrictEqual([existsSync(one.path), existsSync(two.path)], [false, true])
      assert.include((yield* manager.prune()).removed, two.path)
    }),
  )
})
```
`packages/kernel/src/workspace/runtimes.test.ts`:
```ts
import type { WorkspaceRuntime } from '@bytebureau/plugin-api'
import { WorkspaceError as PluginWorkspaceError } from '@bytebureau/workspace-local'
import { assert, describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import type { WorkspaceError } from '../errors.js'
import { runtimeFor, toWorkspaceError, type WorkspaceRuntimesShape } from './runtimes.js'

const known = new Map<string, WorkspaceRuntime>()
const empty: WorkspaceRuntimesShape = {
  get: (id) => known.get(id),
  list: () => [...known.values()],
}

// Equality of errors in chai looks at the name, the message and the code, and a tagged error has no message
const fieldsOf = (error: WorkspaceError): readonly string[] => [error.code, error.reason]

describe(toWorkspaceError, () => {
  it('keeps the code and the message of an error a runtime throws', () => {
    const thrown = new PluginWorkspaceError('dirty', 'worktree has uncommitted changes')
    expect(fieldsOf(toWorkspaceError(thrown))).toStrictEqual([
      'dirty',
      'worktree has uncommitted changes',
    ])
  })

  it('takes any other failure for a failed git run', () => {
    const fromError = toWorkspaceError(new Error('boom'))
    const fromText = toWorkspaceError('plain text')
    expect(fieldsOf(fromError)).toStrictEqual(['git_failed', 'boom'])
    expect(fieldsOf(fromText)).toStrictEqual(['git_failed', 'plain text'])
  })
})

it.effect('fails with runtime_missing for an id no runtime has', () =>
  Effect.gen(function* refusesUnknownRuntime() {
    const error = yield* Effect.flip(runtimeFor(empty, 'nobody'))
    assert.deepStrictEqual(fieldsOf(error), [
      'runtime_missing',
      'workspace runtime "nobody" is not available',
    ])
  }),
)
```
`packages/kernel/src/workspace/workspace-manager-fixtures.ts` (shared fixtures):
```ts
import { LocalWorkspaceRuntime } from '@bytebureau/workspace-local'
import { Layer } from 'effect'
import { kernelLogger } from '../logging/logging.js'
import { TestLayer as RegistryLayer } from '../projects/project-registry-fixtures.js'
import { nodeSpawner } from '../testing/node-spawner.js'
import { WorkspaceRuntimes } from './runtimes.js'
import { WorkspaceManagerLive } from './workspace-manager.js'

const local = new LocalWorkspaceRuntime(nodeSpawner, kernelLogger(['bb', 'test']))

const runtimes = Layer.succeed(
  WorkspaceRuntimes,
  WorkspaceRuntimes.of({
    get: (id) => (id === local.id ? local : undefined),
    list: () => [local],
  }),
)

// The manager over the real local runtime, with the project registry, the event log and an in-memory store beside it
export const TestLayer = WorkspaceManagerLive.pipe(
  Layer.provideMerge(runtimes),
  Layer.provideMerge(RegistryLayer),
)
```
`packages/kernel/src/workspace/workspace-session-fixtures.ts` (session rows for the tests):
```ts
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { WorkspaceHandle } from '@bytebureau/plugin-api'
import { Effect, type Cause } from 'effect'
import { SqlClient } from 'effect/sql'
import { toStoreError, WorkspaceError, type ConfigError, type StoreError } from '../errors.js'
import { EventLog } from '../events/event-log.js'
import { ProjectRegistry, type Project } from '../projects/project-registry.js'
import { createTempRepo, git } from '../testing/temp-repo.js'
import { WorkspaceManager } from './workspace-manager.js'

export interface RegisteredRepo {
  readonly repo: string
  readonly project: Project
}

// A fixture repository registered as a project, its project file carrying the given workspace section
export const registerRepo = (
  workspace: Record<string, unknown> = {},
): Effect.Effect<RegisteredRepo, WorkspaceError | ConfigError | StoreError, ProjectRegistry> =>
  Effect.gen(function* registersRepo() {
    const repo = createTempRepo()
    const config = { version: 1, project: { name: 'fixture' }, workspace, employees: {} }
    writeFileSync(path.join(repo, 'bytebureau.json'), JSON.stringify(config))
    const registry = yield* ProjectRegistry
    return { repo, project: yield* registry.register(repo) }
  })

export interface SessionSeed {
  readonly id: string
  readonly status: string
  readonly endedAt?: string | undefined
  readonly workspace?: string | undefined
}

// A session row; without a workspace record it carries the empty one a new session starts with
export const seedSession = (
  projectId: string,
  seed: SessionSeed,
): Effect.Effect<void, StoreError, SqlClient.SqlClient> =>
  Effect.gen(function* seedsSession() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO sessions (id, project_id, title, employee_json, provider_id, workspace_json, status, created_at, ended_at)
      VALUES (${seed.id}, ${projectId}, 'fixture', '{}', 'fake', ${seed.workspace ?? '{}'}, ${seed.status}, '2026-10-02T00:00:00.000Z', ${seed.endedAt ?? null})`.pipe(
      Effect.mapError(toStoreError),
    )
  })

export interface ProvisionOptions {
  readonly title?: string
  readonly baseBranch?: string
  readonly runtimeId?: string
}

// A session row and its workspace; the title, and so the branch, default to the id
export const provisionSession = (
  project: Project,
  seed: SessionSeed,
  options: ProvisionOptions = {},
): Effect.Effect<
  WorkspaceHandle,
  WorkspaceError | StoreError,
  SqlClient.SqlClient | WorkspaceManager
> =>
  Effect.gen(function* provisionsSession() {
    yield* seedSession(project.id, seed)
    const manager = yield* WorkspaceManager
    return yield* manager.provision({
      sessionId: seed.id,
      project,
      title: options.title ?? seed.id,
      baseBranch: options.baseBranch ?? 'main',
      runtimeId: options.runtimeId ?? 'local',
    })
  })

// A commit on the session branch that nothing has merged
export function commitUnmerged(handle: WorkspaceHandle): void {
  writeFileSync(path.join(handle.path, 'work.txt'), 'x')
  git(handle.path, 'add', 'work.txt')
  git(handle.path, 'commit', '-q', '-m', 'unmerged work')
}

// The code of a workspace error, the word store for any other failure of the manager
export const codeOf = (error: WorkspaceError | StoreError): string =>
  error instanceof WorkspaceError ? error.code : 'store'

// The workspace record of a session as the row holds it
export const storedWorkspaceOf = (
  sessionId: string,
): Effect.Effect<unknown, StoreError | Cause.NoSuchElementError, SqlClient.SqlClient> =>
  Effect.gen(function* readsWorkspace() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      readonly workspace_json: string
    }>`SELECT workspace_json FROM sessions WHERE id = ${sessionId}`.pipe(
      Effect.mapError(toStoreError),
    )
    const row = yield* Effect.fromNullishOr(rows[0])
    const stored: unknown = JSON.parse(row.workspace_json)
    return stored
  })

export interface SeenEvent {
  readonly type: string
  readonly projectId?: string
  readonly payload: unknown
}

// The project id is left out of an event that has none, so an expectation need not spell out a missing one
const seen = (event: SeenEvent): SeenEvent => ({
  type: event.type,
  ...(event.projectId === undefined ? {} : { projectId: event.projectId }),
  payload: event.payload,
})

// What the event log holds for a session, oldest first
export const eventsOf = (
  sessionId: string,
): Effect.Effect<readonly SeenEvent[], StoreError, EventLog> =>
  Effect.gen(function* readsEvents() {
    const log = yield* EventLog
    const events = yield* log.read({ sessionId }, { from: 0 })
    return events.map((event) => seen(event))
  })
```
(`import { writeFileSync, mkdtempSync } from 'node:fs'` as one import; shown split only for readability.)

- [ ] **Step 2: Implementation**

`packages/kernel/src/workspace/slug.ts`:
```ts
const MAX = 40

// A git branch name for a session: bb/<kebab-case title>, or bb/s-<short session id> when the title has no letters or digits
// The first replacement drops the combining diacritical marks, U+0300 to U+036F, that NFD splits off the letters
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
import type {
  WorkspaceHandle,
  WorkspaceRuntime,
  WorkspaceSpec,
  WorkspaceStatus,
} from '@bytebureau/plugin-api'
import { Context, Effect } from 'effect'
import { WorkspaceError } from '../errors.js'

export interface WorkspaceRuntimesShape {
  readonly get: (id: string) => WorkspaceRuntime | undefined
  readonly list: () => readonly WorkspaceRuntime[]
}

export class WorkspaceRuntimes extends Context.Service<WorkspaceRuntimes, WorkspaceRuntimesShape>()(
  'bb/WorkspaceRuntimes',
) {}

// The plugin's WorkspaceError carries a code; any other failure counts as a failed git run
const hasCode = (cause: unknown): cause is Error & { readonly code: string } =>
  cause instanceof Error && 'code' in cause && typeof cause.code === 'string'

export const toWorkspaceError = (cause: unknown): WorkspaceError => {
  if (hasCode(cause)) {
    return new WorkspaceError({ code: cause.code, reason: cause.message })
  }
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new WorkspaceError({ code: 'git_failed', reason })
}

export const runtimeFor = (
  runtimes: WorkspaceRuntimesShape,
  id: string,
): Effect.Effect<WorkspaceRuntime, WorkspaceError> => {
  const runtime = runtimes.get(id)
  if (runtime === undefined) {
    const reason = `workspace runtime "${id}" is not available`
    return Effect.fail(new WorkspaceError({ code: 'runtime_missing', reason }))
  }
  return Effect.succeed(runtime)
}

// The runtime port speaks promises and throws; the kernel speaks typed failures
const attempt = <Value>(call: () => Promise<Value>): Effect.Effect<Value, WorkspaceError> =>
  Effect.tryPromise({ try: call, catch: toWorkspaceError })

export const provisionOn = (
  runtime: WorkspaceRuntime,
  spec: WorkspaceSpec,
): Effect.Effect<WorkspaceHandle, WorkspaceError> =>
  attempt(async () => {
    const handle = await runtime.provision(spec)
    return handle
  })

export const statusOn = (
  runtime: WorkspaceRuntime,
  handle: WorkspaceHandle,
): Effect.Effect<WorkspaceStatus, WorkspaceError> =>
  attempt(async () => {
    const status = await runtime.status(handle)
    return status
  })

export const destroyOn = (
  runtime: WorkspaceRuntime,
  handle: WorkspaceHandle,
  options: { readonly force?: boolean },
): Effect.Effect<void, WorkspaceError> =>
  attempt(async () => {
    await runtime.destroy(handle, options)
  })
```
`packages/kernel/src/workspace/workspace-records.ts`:
```ts
import { existsSync } from 'node:fs'
import type { WorkspaceHandle } from '@bytebureau/plugin-api'
import { Effect, Schema } from 'effect'
import type { SqlClient, Statement } from 'effect/sql'
import { StoreError, toStoreError } from '../errors.js'

export interface WorkspaceInfo {
  readonly sessionId: string
  readonly projectId: string
  readonly path: string
  readonly branch: string
  readonly baseRef: string
  readonly sessionStatus: string
  readonly exists: boolean
}

// A session with a provisioned workspace, and what the retention policy needs to know about it
export interface Workspace {
  readonly sessionId: string
  readonly projectId: string
  readonly sessionStatus: string
  readonly endedAt: string | null
  readonly retainDays: number
  readonly handle: WorkspaceHandle
  readonly exists: boolean
}

interface Row {
  readonly id: string
  readonly project_id: string
  readonly status: string
  readonly ended_at: string | null
  readonly workspace_json: string
  readonly retain_days: number
}

// The handle a runtime returned, as the session row keeps it
const StoredHandle = Schema.Struct({
  id: Schema.String,
  runtimeId: Schema.String,
  path: Schema.String,
  branch: Schema.String,
  baseRef: Schema.String,
})

const decodeHandle = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredHandle))

const unreadable =
  (sessionId: string): ((cause: unknown) => StoreError) =>
  (cause) =>
    new StoreError({
      cause: new Error(`the workspace record of session ${sessionId} is unreadable`, { cause }),
    })

// A record that does not fit the handle is a failure of the store, not a defect
const toWorkspace = (row: Row): Effect.Effect<Workspace, StoreError> =>
  decodeHandle(row.workspace_json).pipe(
    Effect.map((handle) => ({
      sessionId: row.id,
      projectId: row.project_id,
      sessionStatus: row.status,
      endedAt: row.ended_at,
      retainDays: row.retain_days,
      handle,
      exists: existsSync(handle.path),
    })),
    Effect.mapError(unreadable(row.id)),
  )

// A session without a workspace carries '{}'; a named project narrows the query itself
const conditions = (
  sql: SqlClient.SqlClient,
  projectId: string | undefined,
): readonly Statement.Fragment[] => [
  sql`sessions.workspace_json != '{}'`,
  ...(projectId === undefined ? [] : [sql`sessions.project_id = ${projectId}`]),
]

// The merged project snapshot normally holds retainDays; without it a worktree stays seven days
const selectRows = (
  sql: SqlClient.SqlClient,
  projectId: string | undefined,
): Effect.Effect<readonly Row[], StoreError> =>
  sql<Row>`
    SELECT sessions.id, sessions.project_id, sessions.status, sessions.ended_at, sessions.workspace_json,
      COALESCE(json_extract(projects.config_json, '$.workspace.retainDays'), 7) AS retain_days
    FROM sessions JOIN projects ON projects.id = sessions.project_id
    WHERE ${sql.and(conditions(sql, projectId))}
    ORDER BY sessions.created_at, sessions.id`.pipe(Effect.mapError(toStoreError))

export const loadWorkspaces = (
  sql: SqlClient.SqlClient,
  projectId: string | undefined,
): Effect.Effect<readonly Workspace[], StoreError> =>
  selectRows(sql, projectId).pipe(
    Effect.flatMap((rows) => Effect.all(rows.map((row) => toWorkspace(row)))),
  )

export const saveHandle = (
  sql: SqlClient.SqlClient,
  sessionId: string,
  handle: WorkspaceHandle,
): Effect.Effect<void, StoreError> =>
  sql`UPDATE sessions SET workspace_json = ${JSON.stringify(handle)} WHERE id = ${sessionId}`.pipe(
    Effect.asVoid,
    Effect.mapError(toStoreError),
  )

const infoOf = ({ handle, ...workspace }: Workspace): WorkspaceInfo => ({
  sessionId: workspace.sessionId,
  projectId: workspace.projectId,
  path: handle.path,
  branch: handle.branch,
  baseRef: handle.baseRef,
  sessionStatus: workspace.sessionStatus,
  exists: workspace.exists,
})

export const listWorkspaces = (
  sql: SqlClient.SqlClient,
  projectId: string | undefined,
): Effect.Effect<readonly WorkspaceInfo[], StoreError> =>
  loadWorkspaces(sql, projectId).pipe(
    Effect.map((workspaces) => workspaces.map((workspace) => infoOf(workspace))),
  )
```
`packages/kernel/src/workspace/workspace-provision.ts`:
```ts
import type { WorkspaceHandle, WorkspaceSpec } from '@bytebureau/plugin-api'
import { Effect } from 'effect'
import type { SqlClient } from 'effect/sql'
import type { StoreError, WorkspaceError } from '../errors.js'
import type { EventLogShape } from '../events/event-log.js'
import { kernelLogger } from '../logging/logging.js'
import type { Project } from '../projects/project-registry.js'
import { provisionOn, runtimeFor, type WorkspaceRuntimesShape } from './runtimes.js'
import { branchSlug } from './slug.js'
import { saveHandle } from './workspace-records.js'

export interface ProvisionInput {
  readonly sessionId: string
  readonly project: Project
  readonly title: string
  readonly baseBranch: string
  readonly runtimeId: string
}

const workspaceLogger = kernelLogger(['bb', 'workspace'])

// Both the workspace section and its list are optional in a project's configuration
const copyIgnoredOf = ({ config }: Project): readonly string[] => {
  const { workspace } = config
  return workspace === undefined ? [] : (workspace.copyIgnored ?? [])
}

const specOf = (input: ProvisionInput): WorkspaceSpec => ({
  sessionId: input.sessionId,
  projectPath: input.project.path,
  baseBranch: input.baseBranch,
  branch: branchSlug(input.title, input.sessionId),
  copyIgnored: copyIgnoredOf(input.project),
  logger: workspaceLogger,
})

const announce = (
  log: EventLogShape,
  input: ProvisionInput,
  handle: WorkspaceHandle,
): Effect.Effect<void, StoreError> =>
  Effect.asVoid(
    log.publish({
      type: 'workspace.provisioned',
      sessionId: input.sessionId,
      projectId: input.project.id,
      payload: {
        path: handle.path,
        branch: handle.branch,
        baseRef: handle.baseRef,
        runtimeId: handle.runtimeId,
      },
    }),
  )

// The runtime makes the worktree, the session row keeps the handle, the event log announces it
export const makeProvision =
  (
    sql: SqlClient.SqlClient,
    log: EventLogShape,
    runtimes: WorkspaceRuntimesShape,
  ): ((input: ProvisionInput) => Effect.Effect<WorkspaceHandle, WorkspaceError | StoreError>) =>
  (input) =>
    Effect.gen(function* provisionWorkspace() {
      const runtime = yield* runtimeFor(runtimes, input.runtimeId)
      const handle = yield* provisionOn(runtime, specOf(input))
      yield* saveHandle(sql, input.sessionId, handle)
      yield* announce(log, input, handle)
      return handle
    })
```
`packages/kernel/src/workspace/workspace-prune.ts`:
```ts
import type { WorkspaceHandle, WorkspaceStatus } from '@bytebureau/plugin-api'
import { Clock, Effect } from 'effect'
import type { SqlClient } from 'effect/sql'
import type { StoreError, WorkspaceError } from '../errors.js'
import { RETAINED } from './retain-reasons.js'
import { loadWorkspaces, type Workspace } from './workspace-records.js'

export interface PruneReport {
  readonly removed: readonly string[]
  readonly retained: readonly { readonly path: string; readonly reason: string }[]
}

// What destroy did: the worktree went, or it stayed for the reason given
export type DestroyOutcome =
  | { readonly removed: true }
  | { readonly removed: false; readonly reason: string }

// What pruning asks of the manager it belongs to
export interface Actions {
  readonly status: (handle: WorkspaceHandle) => Effect.Effect<WorkspaceStatus, WorkspaceError>
  readonly destroy: (
    sessionId: string,
    handle: WorkspaceHandle,
    options: { readonly force: boolean },
  ) => Effect.Effect<DestroyOutcome, WorkspaceError | StoreError>
}

type Verdict =
  | { readonly outcome: 'removed'; readonly path: string }
  | { readonly outcome: 'retained'; readonly path: string; readonly reason: string }

const TERMINAL = new Set(['completed', 'stopped', 'errored'])
const DAY_MS = 86_400_000

const removed = (path: string): Verdict => ({ outcome: 'removed', path })
const retained = (path: string, reason: string): Verdict => ({ outcome: 'retained', path, reason })

// Reasons are sentences: a user reads them in the report of `workspaces prune`

// A session without a readable end time has not been over for any length of time
const endedLongAgo = (workspace: Workspace, now: number): boolean =>
  workspace.endedAt !== null && now - Date.parse(workspace.endedAt) >= workspace.retainDays * DAY_MS

// What the session record says: the session may still continue, or it ended too recently
const staleReason = (workspace: Workspace, now: number): string | undefined => {
  if (!TERMINAL.has(workspace.sessionStatus)) {
    return `session is ${workspace.sessionStatus}`
  }
  return endedLongAgo(workspace, now) ? undefined : `younger than ${workspace.retainDays} days`
}

// What git says: work that is saved nowhere else; a pushed branch, or one merged on the remote, is saved there
const unsavedReason = (current: WorkspaceStatus): string | undefined => {
  if (current.dirty) {
    return RETAINED.uncommitted
  }
  return current.ahead > 0 && !current.pushed ? RETAINED.notOnRemote : undefined
}

// Destroy checks again, so a worktree that changed since the status stays; one the runtime refuses to remove stays with the runtime's reason
const removeOrKeep = (
  actions: Actions,
  { sessionId, handle }: Workspace,
): Effect.Effect<Verdict, StoreError> =>
  actions.destroy(sessionId, handle, { force: false }).pipe(
    Effect.map((outcome) =>
      outcome.removed ? removed(handle.path) : retained(handle.path, outcome.reason),
    ),
    Effect.catchTag('WorkspaceError', (failure) =>
      Effect.succeed(retained(handle.path, failure.reason)),
    ),
  )

const pruneOne = (
  actions: Actions,
  workspace: Workspace,
  now: number,
): Effect.Effect<Verdict, StoreError> =>
  Effect.gen(function* pruneWorkspace() {
    const { handle } = workspace
    const stale = staleReason(workspace, now)
    if (stale !== undefined) {
      return retained(handle.path, stale)
    }
    const unsaved = yield* actions.status(handle).pipe(
      Effect.match({
        onFailure: () => RETAINED.statusUnavailable,
        onSuccess: (current) => unsavedReason(current),
      }),
    )
    if (unsaved !== undefined) {
      return retained(handle.path, unsaved)
    }
    return yield* removeOrKeep(actions, workspace)
  })

const reportOf = (verdicts: readonly Verdict[]): PruneReport => ({
  removed: verdicts.flatMap((verdict) => (verdict.outcome === 'removed' ? [verdict.path] : [])),
  retained: verdicts.flatMap((verdict) =>
    verdict.outcome === 'retained' ? [{ path: verdict.path, reason: verdict.reason }] : [],
  ),
})

// A worktree that is already gone has nothing left to prune, and no line in the report
const present = (workspaces: readonly Workspace[]): readonly Workspace[] =>
  workspaces.filter((workspace) => workspace.exists)

// One worktree at a time, so a prune never runs several git commands at once
export const makePrune =
  (
    sql: SqlClient.SqlClient,
    actions: Actions,
  ): ((projectId?: string) => Effect.Effect<PruneReport, StoreError>) =>
  (projectId) =>
    Effect.gen(function* pruneWorkspaces() {
      const now = yield* Clock.currentTimeMillis
      const workspaces = yield* loadWorkspaces(sql, projectId)
      const verdicts = yield* Effect.forEach(
        present(workspaces),
        (workspace) => pruneOne(actions, workspace, now),
        { concurrency: 1 },
      )
      return reportOf(verdicts)
    })
```
`packages/kernel/src/workspace/workspace-manager.ts`:
```ts
import type { WorkspaceHandle, WorkspaceRuntime, WorkspaceStatus } from '@bytebureau/plugin-api'
import { Context, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { WorkspaceError, type StoreError } from '../errors.js'
import { EventLog, type EventLogShape } from '../events/event-log.js'
import {
  destroyOn,
  runtimeFor,
  statusOn,
  WorkspaceRuntimes,
  type WorkspaceRuntimesShape,
} from './runtimes.js'
import { RETAINED } from './retain-reasons.js'
import { makeProvision, type ProvisionInput } from './workspace-provision.js'
import { makePrune, type DestroyOutcome, type PruneReport } from './workspace-prune.js'
import { listWorkspaces, type WorkspaceInfo } from './workspace-records.js'

export type { ProvisionInput } from './workspace-provision.js'
export type { PruneReport } from './workspace-prune.js'
export type { WorkspaceInfo } from './workspace-records.js'

export interface WorkspaceManagerShape {
  readonly provision: (
    input: ProvisionInput,
  ) => Effect.Effect<WorkspaceHandle, WorkspaceError | StoreError>
  readonly status: (handle: WorkspaceHandle) => Effect.Effect<WorkspaceStatus, WorkspaceError>
  // The session id is the one the manager knows, never read back from the handle a runtime returned
  readonly destroy: (
    sessionId: string,
    handle: WorkspaceHandle,
    options?: { readonly force?: boolean },
  ) => Effect.Effect<DestroyOutcome, WorkspaceError | StoreError>
  readonly lock: (sessionId: string) => Effect.Effect<void>
  readonly unlock: (sessionId: string) => Effect.Effect<void>
  readonly list: (projectId?: string) => Effect.Effect<readonly WorkspaceInfo[], StoreError>
  readonly prune: (projectId?: string) => Effect.Effect<PruneReport, StoreError>
}

export class WorkspaceManager extends Context.Service<WorkspaceManager, WorkspaceManagerShape>()(
  'bb/WorkspaceManager',
) {}

const makeStatus =
  (runtimes: WorkspaceRuntimesShape): WorkspaceManagerShape['status'] =>
  (handle) =>
    runtimeFor(runtimes, handle.runtimeId).pipe(
      Effect.flatMap((runtime) => statusOn(runtime, handle)),
    )

// A running session keeps its worktree, whatever force says
const refuseLocked = (
  locks: ReadonlySet<string>,
  sessionId: string,
): Effect.Effect<void, WorkspaceError> =>
  locks.has(sessionId)
    ? Effect.fail(new WorkspaceError({ code: 'locked', reason: `session ${sessionId} is running` }))
    : Effect.void

// Without force a worktree goes only when its status says that nothing in it is lost
const keepReason = (
  runtime: WorkspaceRuntime,
  handle: WorkspaceHandle,
): Effect.Effect<string | undefined> =>
  statusOn(runtime, handle).pipe(
    Effect.match({
      onFailure: () => RETAINED.statusUnavailable,
      onSuccess: (current) => (current.dirty ? RETAINED.uncommitted : undefined),
    }),
  )

// A kept worktree is announced with its reason; force skips the status and the runtime still refuses a locked worktree
// The outcome says whether the worktree went, so a caller that checked the status before cannot report it gone when it stayed
const makeDestroy =
  (
    log: EventLogShape,
    runtimes: WorkspaceRuntimesShape,
    locks: ReadonlySet<string>,
  ): WorkspaceManagerShape['destroy'] =>
  (sessionId, handle, options = {}) =>
    Effect.gen(function* destroyWorkspace() {
      yield* refuseLocked(locks, sessionId)
      const runtime = yield* runtimeFor(runtimes, handle.runtimeId)
      const reason = options.force === true ? undefined : yield* keepReason(runtime, handle)
      if (reason !== undefined) {
        const payload = { path: handle.path, reason }
        yield* log.publish({ type: 'workspace.retained', sessionId, payload })
        return { removed: false, reason } as const
      }
      yield* destroyOn(runtime, handle, options)
      yield* log.publish({ type: 'workspace.destroyed', sessionId, payload: { path: handle.path } })
      return { removed: true } as const
    })

const make = Effect.gen(function* makeWorkspaceManager() {
  const sql = yield* SqlClient.SqlClient
  const log = yield* EventLog
  const runtimes = yield* WorkspaceRuntimes
  // The sessions that are running, by session id; the set belongs to this process and lives as long as the layer
  const locks = new Set<string>()
  const status = makeStatus(runtimes)
  const destroy = makeDestroy(log, runtimes, locks)
  return WorkspaceManager.of({
    provision: makeProvision(sql, log, runtimes),
    status,
    destroy,
    lock: (sessionId) =>
      Effect.sync(() => {
        locks.add(sessionId)
      }),
    unlock: (sessionId) =>
      Effect.sync(() => {
        locks.delete(sessionId)
      }),
    list: (projectId) => listWorkspaces(sql, projectId),
    prune: makePrune(sql, { status, destroy }),
  })
})

export const WorkspaceManagerLive: Layer.Layer<
  WorkspaceManager,
  never,
  SqlClient.SqlClient | EventLog | WorkspaceRuntimes
> = Layer.effect(WorkspaceManager, make)
```
`provision` passes `kernelLogger(['bb', 'workspace'])` to the runtime; `WorkspaceError.code` is typed `string` in the kernel so plugin codes pass through (a type guard, not a cast, reads them); `packages/kernel/src/testing/node-spawner.ts` is the Task 9 helper verbatim.

Add to `index.ts`: `export { WorkspaceManager, WorkspaceManagerLive, type ProvisionInput, type WorkspaceInfo, type PruneReport, type WorkspaceManagerShape } from './workspace/workspace-manager.js'`, `export { WorkspaceRuntimes, type WorkspaceRuntimesShape } from './workspace/runtimes.js'`, `export { branchSlug } from './workspace/slug.js'`.

- [ ] **Step 3: Run, commit**

Run: `bunx vitest run --project kernel` → PASS. `bun run check` → green.

```bash
git add packages/kernel
git commit -m "feat(kernel): manage session worktrees with slugs, locks, retention and pruning"
```

### Task 11: `PluginHost` service — bundled plugins, manifest and config validation, ports, hooks, plugin context

**Files:**
- Create: `packages/kernel/src/plugins/semver-major.ts`, `packages/kernel/src/plugins/reason.ts`, `packages/kernel/src/plugins/hooks-chain.ts`, `packages/kernel/src/plugins/hooks.ts`, `packages/kernel/src/plugins/port-registry.ts`, `packages/kernel/src/plugins/plugin-setup.ts`, `packages/kernel/src/plugins/plugin-loader.ts`, `packages/kernel/src/plugins/plugin-context.ts`, `packages/kernel/src/plugins/plugin-host.ts`, `packages/kernel/src/plugins/bundled.ts`, `packages/kernel/src/secrets/in-memory-secret-store.ts`, fixtures `packages/kernel/src/plugins/plugin-fixtures.ts`, `packages/kernel/src/plugins/plugin-call-fixtures.ts`, `packages/kernel/src/plugins/log-fixtures.ts`, and the tests `semver-major`, `reason`, `hooks`, `plugin-context`, `plugin-process`, `plugin-host`, `plugin-host-config`, `plugin-host-hooks`, `plugin-host-lifecycle`, `plugin-host-log`, `plugin-host-refusals`, `plugin-host-workspace`, `secrets/in-memory-secret-store` (`@bytebureau/workspace-local` was already a kernel dependency since Task 10)
- Modify: `packages/kernel/src/index.ts`; `packages/plugin-api/src/plugin.ts` (`PluginEvents.subscribe` yields `EventEnvelope`, `PluginKv.get` returns `unknown`); `packages/kernel/src/process/env-allowlist.ts` (`SSH_AUTH_SOCK`)

**Interfaces:**
- Consumes: `Plugin`, `PluginManifest`, `PluginContext`, `PluginRegistration`, `Hooks`, `ProcessSpawner`, `ExecHandle` (Task 2); `localWorkspacePlugin` (Task 9); `EventLog`, `Supervisor`, `SqlClient`, `kernelLogger`, `PluginError`, `WorkspaceRuntimes` (Task 10).
- Produces: `PluginHost` service `{ load(): Effect<void>; plugins(): readonly PluginStatus[]; agentProviders(): readonly AgentProvider[]; agentProvider(id): AgentProvider | undefined; workspaceRuntimes(): readonly WorkspaceRuntime[]; hooks: HookBus }`, `PluginHostLive(options: { extraPlugins?: readonly Plugin[]; pluginConfig?: Record<string, unknown> }): Layer<PluginHost | WorkspaceRuntimes, never, EventLog | Supervisor | SqlClient>`, `HookBus { register(name, hook): void; run<Name>(name, input, terminal): Effect<Result> }`, `PluginStatus { name; version; state: 'loaded' | 'failed'; reason?: string; ports: readonly string[] }`, `BUNDLED_PLUGINS: readonly Plugin[]` (Task 13 appends the fake agent plugin), `HOST_API_VERSION = '0.0.0'`, `satisfiesMajor(range, version)`, `InMemorySecretStore` (Phase C replaces it with the keychain store).

Semantics (as shipped): plugin failures are `PluginError`s carrying the original message (a `tryPromise` failure stringifies to an opaque `UnknownError`); the hook bus is a mapped structure of five explicitly typed chains (`hooks-chain.ts`), so no cast is needed — a hook that throws or rejects is warned about and skipped, a hook that never calls `next` ends the chain with its own result, a failure after `next` keeps the downstream result; `load()` runs once (concurrent and repeated calls share the outcome); a duplicate plugin name or a provider/runtime id already held by another plugin is refused (the plugin is disposed and its hooks stay off the bus); a `setup` returning nothing is a refusal; a log failure never changes a plugin's outcome; `satisfiesMajor` compares the major by string equality with a regex without nested quantifiers; the context's `process.spawn` forwards `ExecSpec.signal`, implements `timeoutMs` with the kill ladder and closes its scope after `exit`; `WorkspaceRuntimes` is empty until `load()` has run (Task 14 loads before anything reads it). Final fix wave: the context's `events.subscribe` starts at the newest seq of the log, live only (the plugin-api filter has no `since`); admission runs inside `Effect.suspend` and refuses, as a recorded failure, a plugin without a manifest object, a setup function, a name, a version or a `hostApi`, a name that is not `^[a-z0-9][a-z0-9-]*$` and a name every object inherits (`constructor` broke the logger tree of LogTape); the configuration of a plugin is its own entry of `pluginConfig` (`Object.hasOwn`); kv failures name the plugin and the key (`undefined`, a function or a bigint is a `TypeError`, a stored value that is not JSON is wrapped); `timeoutMs` sets a timer only when it is positive; a process a plugin spawns ends when the plugin or the host aborts its signal (`AbortSignal.any`); a registration that offers one provider or runtime id twice is refused; a defect of the terminal behind hooks that passed on is passed through without reporting those hooks as failed. Known limits: no timeout on `setup`/`dispose` (Phase D). Deferred: the `Effect.runPromise` bridges of the context run on root fibers (no span, so no `TRACEPARENT` for plugin-spawned helpers) until the host passes a `Runtime` in `ContextDeps` (Phase B); the `^0` host-API semver policy is settled before the first publish of `plugin-api`.

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

  it.each(['0', '~0.1', '^0.x', '^0.1.2.3', '', '^'])('refuses the range "%s"', (range) => {
    expect(satisfiesMajor(range, '0.0.0')).toBe(false)
  })

  it('refuses a version that is not dotted', () => {
    expect(satisfiesMajor('^0', '0')).toBe(false)
  })
})
```
`packages/kernel/src/plugins/hooks.test.ts`:
```ts
import type { AgentSpawnInput, PromptSendInput } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect, Exit } from 'effect'
import { HookBus } from './hooks.js'
import { warnings } from './log-fixtures.js'
import { noting, passOn } from './plugin-fixtures.js'

const SEND = 'prompt.beforeSend'

const prompt = (text: string): PromptSendInput => ({ sessionId: 's', input: { text } })

const echo = (input: PromptSendInput): Effect.Effect<PromptSendInput> => Effect.succeed(input)

const agent: AgentSpawnInput = {
  sessionId: 's',
  providerId: 'p',
  command: 'agent',
  args: [],
  env: {},
}

// A hook that notes its turn, appends its mark to the text and passes on
const marking =
  (order: string[], mark: string) =>
  async (
    input: Readonly<PromptSendInput>,
    proceed: (input: PromptSendInput) => Promise<PromptSendInput>,
  ): Promise<PromptSendInput> => {
    order.push(mark)
    const result = await proceed({ ...input, input: { text: `${input.input.text}+${mark}` } })
    return result
  }

// A terminal that notes every input it is given
const recording =
  (seen: string[]) =>
  (input: PromptSendInput): Effect.Effect<PromptSendInput> =>
    Effect.sync(() => {
      seen.push(input.input.text)
      return input
    })

it.effect('runs hooks in registration order and continues when a hook throws', () =>
  Effect.gen(function* runsInOrder() {
    const bus = new HookBus(['bb', 'test'])
    const order: string[] = []
    bus.register('a', SEND, marking(order, 'a'))
    bus.register('b', SEND, () => {
      order.push('b')
      throw new Error('boom')
    })
    bus.register('c', SEND, marking(order, 'c'))
    const result = yield* bus.run(SEND, prompt('x'), echo)
    assert.deepStrictEqual(order, ['a', 'b', 'c'])
    assert.strictEqual(result.input.text, 'x+a+c')
  }),
)

it.effect('runs the terminal alone when no hook is registered', () =>
  Effect.gen(function* runsTerminalAlone() {
    const bus = new HookBus(['bb', 'test'])
    const result = yield* bus.run(SEND, prompt('x'), echo)
    assert.deepStrictEqual(result, prompt('x'))
  }),
)

it.effect('skips a hook that rejects, the way it skips one that throws', () =>
  Effect.gen(function* skipsRejection() {
    const bus = new HookBus(['bb', 'test'])
    const order: string[] = []
    bus.register('late', SEND, async () => {
      await Promise.resolve()
      throw new Error('rejected')
    })
    bus.register('c', SEND, marking(order, 'c'))
    const result = yield* bus.run(SEND, prompt('x'), echo)
    assert.deepStrictEqual(order, ['c'])
    assert.strictEqual(result.input.text, 'x+c')
  }),
)

it.effect('logs a failing hook at warn with its plugin, the hook and the reason', () =>
  Effect.gen(function* logsFailure() {
    const records = yield* warnings
    const bus = new HookBus(['bb', 'test'])
    bus.register('flaky', SEND, () => {
      throw new Error('boom')
    })
    yield* bus.run(SEND, prompt('x'), echo)
    const logged = records.map((record) => [
      record.category.join('.'),
      record.level,
      record.message[0],
      record.properties,
    ])
    assert.deepStrictEqual(logged, [
      [
        'bb.test.hooks',
        'warning',
        'hook failed; continuing',
        { plugin: 'flaky', hook: SEND, cause: 'boom' },
      ],
    ])
  }),
)

it.effect('lets a hook answer for the chain, and nothing after it runs', () =>
  Effect.gen(function* answersForChain() {
    const bus = new HookBus(['bb', 'test'])
    const reached: string[] = []
    bus.register('guard', 'agent.beforeSpawn', async () => {
      await Promise.resolve()
      return { deny: 'not today' }
    })
    const result = yield* bus.run('agent.beforeSpawn', agent, (input) =>
      Effect.sync(() => {
        reached.push(input.command)
        return input
      }),
    )
    assert.deepStrictEqual(result, { deny: 'not today' })
    assert.deepStrictEqual(reached, [])
  }),
)

it.effect('hands the result back through the hooks that passed on', () =>
  Effect.gen(function* handsResultBack() {
    const bus = new HookBus(['bb', 'test'])
    bus.register('shout', SEND, async (input, proceed) => {
      const result = await proceed(input)
      return { ...result, input: { text: result.input.text.toUpperCase() } }
    })
    const result = yield* bus.run(SEND, prompt('x'), (input) =>
      Effect.succeed(prompt(`${input.input.text}-terminal`)),
    )
    assert.strictEqual(result.input.text, 'X-TERMINAL')
  }),
)

it.effect('keeps the hooks of one name out of the chain of another', () =>
  Effect.gen(function* keepsNamesApart() {
    const bus = new HookBus(['bb', 'test'])
    const order: string[] = []
    bus.register('creator', 'session.beforeCreate', noting(order, 'creator'))
    const seen: string[] = []
    yield* bus.run(SEND, prompt('x'), recording(seen))
    assert.deepStrictEqual([order, seen], [[], ['x']])
  }),
)

it.effect('does not run the rest of the chain again when a hook fails after passing on', () =>
  Effect.gen(function* runsRestOnce() {
    const bus = new HookBus(['bb', 'test'])
    bus.register('late', SEND, async (input, proceed) => {
      await proceed(input)
      throw new Error('too late')
    })
    const seen: string[] = []
    const result = yield* bus.run(SEND, prompt('x'), recording(seen))
    assert.deepStrictEqual(seen, ['x'])
    assert.strictEqual(result.input.text, 'x')
  }),
)

it.effect('does not run a terminal again that has failed while a hook waited for it', () =>
  Effect.gen(function* runsFailingTerminalOnce() {
    const bus = new HookBus(['bb', 'test'])
    bus.register('a', SEND, passOn)
    const calls: string[] = []
    const failing = (): Effect.Effect<PromptSendInput> =>
      Effect.sync(() => {
        calls.push('terminal')
        throw new Error('terminal failed')
      })
    const exit = yield* Effect.exit(bus.run(SEND, prompt('x'), failing))
    assert.isTrue(Exit.isFailure(exit))
    assert.deepStrictEqual(calls, ['terminal'])
  }),
)

it.effect('passes a terminal defect through the hooks that passed on without blaming them', () =>
  Effect.gen(function* passesDefectOn() {
    const records = yield* warnings
    const bus = new HookBus(['bb', 'test'])
    bus.register('a', SEND, passOn)
    bus.register('b', SEND, passOn)
    const exit = yield* Effect.exit(
      bus.run(SEND, prompt('x'), () => Effect.die(new Error('terminal died'))),
    )
    assert.isTrue(Exit.hasDies(exit))
    assert.deepStrictEqual(records, [])
  }),
)
```
`packages/kernel/src/plugins/plugin-host.test.ts`:
```ts
import { definePlugin, type Plugin } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { EventLog } from '../events/event-log.js'
import { InMemorySecretStore } from '../secrets/in-memory-secret-store.js'
import { WorkspaceRuntimes } from '../workspace/runtimes.js'
import { BUNDLED_PLUGINS } from './bundled.js'
import {
  hostOver,
  loadedHost,
  manifestOf,
  passOn,
  providerOf,
  statusOf,
} from './plugin-fixtures.js'
import { PluginHost } from './plugin-host.js'

const good = definePlugin({
  manifest: manifestOf('good', { contributes: { agentProviders: ['good'] } }),
  setup: (context) => ({
    agentProviders: [providerOf('good')],
    hooks: { 'prompt.beforeSend': passOn },
    dispose: async (): Promise<void> => {
      await context.kv.set('disposed', true)
    },
  }),
})
const vault = definePlugin({
  manifest: manifestOf('vault'),
  setup: () => ({ secretStores: [new InMemorySecretStore()] }),
})
const broken: Plugin = {
  manifest: manifestOf('broken'),
  setup: () => {
    throw new Error('setup failed')
  },
}
const incompatible: Plugin = {
  manifest: manifestOf('future', { hostApi: '^9' }),
  setup: () => ({}),
}

const REFUSAL = 'plugin future needs host API ^9, this ByteBureau provides 0.0.0'
const LOADED = 'plugin.loaded'
const FAILED = 'plugin.failed'
const OUTCOMES = { types: [LOADED, FAILED] }
const BUNDLED = BUNDLED_PLUGINS.length

it.layer(hostOver({ extraPlugins: [good, broken, incompatible] }))('PluginHost', (suite) => {
  suite.effect('loads bundled and extra plugins, records failures and keeps running', () =>
    Effect.gen(function* loadsPlugins() {
      const host = yield* loadedHost
      assert.strictEqual(statusOf(host, 'workspace-local').state, 'loaded')
      assert.strictEqual(statusOf(host, 'good').state, 'loaded')
      assert.strictEqual(statusOf(host, 'broken').state, 'failed')
      assert.match(statusOf(host, 'future').reason ?? '', /\^9.*0\.0\.0/u)
      assert.ok(host.agentProvider('good') !== undefined)
      assert.ok((yield* WorkspaceRuntimes).get('local') !== undefined)
      const events = yield* (yield* EventLog).read(OUTCOMES, { from: 0 })
      const loaded = [...BUNDLED_PLUGINS, good].map(() => LOADED)
      assert.deepStrictEqual(events.map((event) => event.type).toSorted(), [
        FAILED,
        FAILED,
        ...loaded,
      ])
    }),
  )
})

it.layer(hostOver({ extraPlugins: [good, broken, incompatible] }))('PluginHost record', (suite) => {
  suite.effect('lists the bundled plugins first, then the extra ones with ports or reasons', () =>
    Effect.gen(function* listsPlugins() {
      const host = yield* loadedHost
      const bundled = host.plugins().slice(0, BUNDLED)
      assert.deepStrictEqual(
        bundled.map((status) => [status.name, status.state]),
        BUNDLED_PLUGINS.map((plugin) => [plugin.manifest.name, 'loaded']),
      )
      assert.deepStrictEqual(host.plugins().slice(BUNDLED), [
        { name: 'good', version: '1.0.0', state: 'loaded', ports: ['agentProviders:good'] },
        { name: 'broken', version: '1.0.0', state: 'failed', reason: 'setup failed', ports: [] },
        { name: 'future', version: '1.0.0', state: 'failed', reason: REFUSAL, ports: [] },
      ])
    }),
  )

  suite.effect('announces each outcome in the log, in the same order', () =>
    Effect.gen(function* announcesOutcomes() {
      yield* loadedHost
      const events = yield* (yield* EventLog).read(OUTCOMES, { from: 0 })
      assert.deepStrictEqual(
        events.slice(0, BUNDLED).map((event) => event.type),
        BUNDLED_PLUGINS.map(() => LOADED),
      )
      assert.deepStrictEqual(
        events.slice(BUNDLED).map((event) => [event.type, event.payload]),
        [
          [LOADED, { name: 'good', version: '1.0.0', ports: ['agentProviders:good'] }],
          [FAILED, { name: 'broken', reason: 'setup failed' }],
          [FAILED, { name: 'future', reason: REFUSAL }],
        ],
      )
    }),
  )
})

it.layer(hostOver({ extraPlugins: [good, vault] }))('PluginHost ports', (suite) => {
  suite.effect('lists agent providers and workspace runtimes, on the host and as services', () =>
    Effect.gen(function* listsPorts() {
      const host = yield* loadedHost
      const runtimes = yield* WorkspaceRuntimes
      assert.include(
        host.agentProviders().map((provider) => provider.id),
        'good',
      )
      assert.strictEqual(host.agentProvider('nobody'), undefined)
      assert.deepStrictEqual(
        host.workspaceRuntimes().map((runtime) => runtime.id),
        ['local'],
      )
      assert.deepStrictEqual(runtimes.list(), host.workspaceRuntimes())
      assert.strictEqual(runtimes.get('local'), host.workspaceRuntimes()[0])
      assert.strictEqual(runtimes.get('nobody'), undefined)
    }),
  )

  suite.effect('reports a secret store as a port without an id', () =>
    Effect.gen(function* reportsSecretStore() {
      const host = yield* loadedHost
      assert.deepStrictEqual(statusOf(host, 'vault').ports, ['secretStores'])
    }),
  )
})

it.layer(hostOver({ extraPlugins: [good] }))('PluginHost before load', (suite) => {
  suite.effect('registers and announces nothing until load is called', () =>
    Effect.gen(function* waitsForLoad() {
      const host = yield* PluginHost
      const events = yield* (yield* EventLog).read({}, { from: 0 })
      assert.deepStrictEqual(host.plugins(), [])
      assert.deepStrictEqual(host.agentProviders(), [])
      assert.deepStrictEqual(host.workspaceRuntimes(), [])
      assert.deepStrictEqual(events, [])
    }),
  )
})
```
`packages/kernel/src/plugins/plugin-context.test.ts`:
```ts
import type { EventEnvelope, PluginEvents } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { SqlClient } from 'effect/sql'
import { EventLog } from '../events/event-log.js'
import { InMemorySecretStore } from '../secrets/in-memory-secret-store.js'
import { flush } from '../sessions/session-helper-fixtures.js'
import { rejected, resolved, takeFrom } from './plugin-call-fixtures.js'
import { hostOver, loadedHost, probe } from './plugin-fixtures.js'

const USER = 'message.user'

const alpha = probe('alpha')
const beta = probe('beta')
const extraPlugins = [alpha.plugin, beta.plugin]

it.layer(hostOver({ extraPlugins }))('plugin context kv', (suite) => {
  suite.effect('stores, replaces and deletes a value, and reads a missing key as undefined', () =>
    Effect.gen(function* storesValues() {
      yield* loadedHost
      const { kv } = alpha.context()
      assert.strictEqual(yield* resolved(kv.get('missing')), undefined)
      yield* resolved(kv.set('config', { retries: 3, tags: ['a'] }))
      assert.deepStrictEqual(yield* resolved(kv.get('config')), { retries: 3, tags: ['a'] })
      yield* resolved(kv.set('config', 'replaced'))
      assert.strictEqual(yield* resolved(kv.get('config')), 'replaced')
      yield* resolved(kv.delete('config'))
      assert.strictEqual(yield* resolved(kv.get('config')), undefined)
    }),
  )

  suite.effect('keeps the values of a plugin apart from the values of another', () =>
    Effect.gen(function* separatesPlugins() {
      yield* loadedHost
      yield* resolved(alpha.context().kv.set('shared', 'from alpha'))
      yield* resolved(beta.context().kv.set('shared', 'from beta'))
      const sql = yield* SqlClient.SqlClient
      const rows =
        yield* sql`SELECT plugin_id, key, value_json FROM plugin_kv WHERE key = 'shared' ORDER BY plugin_id`
      assert.deepStrictEqual(rows, [
        { plugin_id: 'alpha', key: 'shared', value_json: '"from alpha"' },
        { plugin_id: 'beta', key: 'shared', value_json: '"from beta"' },
      ])
      assert.strictEqual(yield* resolved(beta.context().kv.get('shared')), 'from beta')
    }),
  )

  suite.effect('rejects a value that cannot be stored instead of throwing', () =>
    Effect.gen(function* rejectsUnsupportedValue() {
      yield* loadedHost
      const failure = yield* rejected(alpha.context().kv.set('big', 10n))
      assert.instanceOf(failure, TypeError)
    }),
  )
})

it.layer(hostOver({ extraPlugins }))('plugin context fields', (suite) => {
  suite.effect('hands the plugin no project, a logger of its own, fetch and a live signal', () =>
    Effect.gen(function* handsFields() {
      yield* loadedHost
      const context = alpha.context()
      assert.strictEqual(context.project, null)
      assert.deepStrictEqual(context.logger.category, ['bb', 'plugin', 'alpha'])
      assert.strictEqual(context.http, fetch)
      assert.isFalse(context.signal.aborted)
    }),
  )
})

const store = new InMemorySecretStore()

it.layer(hostOver({ extraPlugins, secrets: store }))('plugin context secrets', (suite) => {
  suite.effect('keeps the secrets of a plugin apart from the secrets of another', () =>
    Effect.gen(function* separatesSecrets() {
      yield* loadedHost
      yield* resolved(alpha.context().secrets.set('token', 'a1'))
      assert.strictEqual(yield* resolved(beta.context().secrets.get('token')), undefined)
      yield* resolved(beta.context().secrets.set('token', 'b1'))
      assert.strictEqual(yield* resolved(alpha.context().secrets.get('token')), 'a1')
      yield* resolved(alpha.context().secrets.delete('token'))
      assert.strictEqual(yield* resolved(alpha.context().secrets.get('token')), undefined)
      assert.strictEqual(yield* resolved(beta.context().secrets.get('token')), 'b1')
    }),
  )

  suite.effect('keeps them in the store of the host under the name of the plugin', () =>
    Effect.gen(function* keepsUnderName() {
      yield* loadedHost
      yield* resolved(alpha.context().secrets.set('apiKey', 'not-a-real-key'))
      assert.strictEqual(yield* resolved(store.get('alpha/apiKey')), 'not-a-real-key')
    }),
  )
})

// A subscription to everything of the session sub-1 and one to its warnings, taking two and one
const listenTo = (
  events: PluginEvents,
): Effect.Effect<readonly [readonly EventEnvelope[], readonly EventEnvelope[]]> => {
  const whole = events.subscribe({ sessionId: 'sub-1' })
  const typed = events.subscribe({ types: ['session.warning'], sessionId: 'sub-1' })
  return Effect.all([takeFrom(whole, 2), takeFrom(typed, 1)], { concurrency: 2 })
}

// Two events in one session, one of them a warning, and one in another session
const seed = (events: PluginEvents): Effect.Effect<void> =>
  Effect.gen(function* seedsEvents() {
    const warning = { kind: 'k', message: 'm' }
    yield* resolved(events.publish({ type: USER, sessionId: 'sub-1', payload: { text: 'one' } }))
    yield* resolved(
      events.publish({ type: 'session.warning', sessionId: 'sub-1', payload: warning }),
    )
    yield* resolved(events.publish({ type: USER, sessionId: 'sub-2', payload: { text: 'two' } }))
  })

it.layer(hostOver({ extraPlugins }))('plugin context events', (suite) => {
  suite.effect('publishes an event to the log, as the plugin names it', () =>
    Effect.gen(function* publishesEvent() {
      yield* loadedHost
      const event = {
        type: USER,
        sessionId: 'pub-1',
        payload: { text: 'hello' },
      } as const
      yield* resolved(alpha.context().events.publish(event))
      const stored = yield* (yield* EventLog).read({ sessionId: 'pub-1' }, { from: 0 })
      assert.deepStrictEqual(
        stored.map((envelope) => [envelope.type, envelope.payload]),
        [[USER, { text: 'hello' }]],
      )
    }),
  )

  suite.effect('delivers stored envelopes, all of a session or filtered by type', () =>
    Effect.gen(function* deliversEnvelopes() {
      yield* loadedHost
      const { events } = alpha.context()
      const listening = yield* Effect.forkChild(listenTo(events))
      yield* Effect.andThen(flush, seed(events))
      const [wholeEvents, typedEvents] = yield* Fiber.join(listening)
      assert.deepStrictEqual(
        wholeEvents.map((envelope) => envelope.type),
        [USER, 'session.warning'],
      )
      assert.deepStrictEqual(
        typedEvents.map((envelope) => envelope.payload),
        [{ kind: 'k', message: 'm' }],
      )
      assert.isTrue(
        wholeEvents.every(
          (envelope) => envelope.seq > 0 && envelope.id !== '' && envelope.ts !== '',
        ),
      )
    }),
  )
})
```
`packages/kernel/src/plugins/plugin-process.test.ts`:
```ts
import { getEventListeners } from 'node:events'
import type { ExecHandle } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { IDLE, withEnv } from '../process/supervisor-fixtures.js'
import { linesOf, nodeExec, resolved } from './plugin-call-fixtures.js'
import { hostOver, loadedHost, probe, startHost } from './plugin-fixtures.js'
import type { PluginHost } from './plugin-host.js'

const spawner = probe('spawner')

// Real child processes, so the supervisor runs on the real clock
const live = { excludeTestServices: true }

const spawn = (
  ...args: Parameters<typeof nodeExec>
): Effect.Effect<ExecHandle, never, PluginHost> =>
  Effect.gen(function* spawnsScript() {
    yield* loadedHost
    return yield* resolved(spawner.context().process.spawn(nodeExec(...args)))
  })

it.layer(hostOver({ extraPlugins: [spawner.plugin] }), live)('plugin context process', (suite) => {
  suite.effect('runs a command and reports its lines, its pid and its exit code', () =>
    Effect.gen(function* runsCommand() {
      const handle = yield* spawn('console.log("one"); console.error("two"); process.exit(3)')
      assert.deepStrictEqual(yield* linesOf(handle.stdout), ['one'])
      assert.deepStrictEqual(yield* linesOf(handle.stderr), ['two'])
      assert.deepStrictEqual(yield* resolved(handle.exited), { code: 3, signal: null })
      assert.isAbove(handle.pid, 0)
    }),
  )

  suite.effect('hands the child the environment the plugin declares and none of the daemon', () =>
    Effect.gen(function* declaresEnvironment() {
      yield* withEnv('BB_PLUGIN_LEAK', 'daemon')
      const script =
        'console.log(process.env.BB_DECLARED); console.log(process.env.BB_PLUGIN_LEAK ?? "dropped")'
      const handle = yield* spawn(script, { env: { BB_DECLARED: 'yes' } })
      assert.deepStrictEqual(yield* linesOf(handle.stdout), ['yes', 'dropped'])
    }),
  )

  suite.effect('reports a command that cannot start as exit -1 with the reason on stderr', () =>
    Effect.gen(function* reportsMissingCommand() {
      const handle = yield* spawn('', { command: 'bb-no-such-command' })
      assert.strictEqual(handle.pid, -1)
      assert.deepStrictEqual(yield* resolved(handle.exited), { code: -1, signal: null })
      assert.isAbove((yield* linesOf(handle.stderr)).length, 0)
    }),
  )
})

it.layer(hostOver({ extraPlugins: [spawner.plugin] }), live)(
  'plugin context process end',
  (suite) => {
    suite.effect('ends a command that outlives its timeout', () =>
      Effect.gen(function* endsOnTimeout() {
        const handle = yield* spawn(IDLE, { timeoutMs: 100 })
        assert.deepStrictEqual(yield* resolved(handle.exited), { code: null, signal: 'SIGINT' })
      }),
    )

    suite.effect('sets no timer for a timeout that is not positive', () =>
      Effect.gen(function* ignoresNonPositiveTimeout() {
        const script = 'setTimeout(() => process.exit(0), 50)'
        const zero = yield* spawn(script, { timeoutMs: 0 })
        const negative = yield* spawn(script, { timeoutMs: -1 })
        const exits = [yield* resolved(zero.exited), yield* resolved(negative.exited)]
        assert.deepStrictEqual(exits, [
          { code: 0, signal: null },
          { code: 0, signal: null },
        ])
      }),
    )

    suite.effect('leaves a command alone that ends before its timeout', () =>
      Effect.gen(function* leavesQuickCommand() {
        const handle = yield* spawn('process.exit(0)', { timeoutMs: 60_000 })
        assert.deepStrictEqual(yield* resolved(handle.exited), { code: 0, signal: null })
      }),
    )

    suite.effect('ends a command when the plugin aborts its signal', () =>
      Effect.gen(function* endsOnAbort() {
        const controller = new AbortController()
        const handle = yield* spawn(IDLE, { signal: controller.signal })
        controller.abort()
        assert.deepStrictEqual(yield* resolved(handle.exited), { code: null, signal: 'SIGINT' })
      }),
    )

    suite.effect('sends the signal the plugin names when it kills the command', () =>
      Effect.gen(function* killsOnRequest() {
        const handle = yield* spawn(IDLE)
        handle.kill('SIGKILL')
        assert.deepStrictEqual(yield* resolved(handle.exited), { code: null, signal: 'SIGKILL' })
      }),
    )
  },
)

const listenersOf = (signal: AbortSignal): Effect.Effect<number> =>
  Effect.sync(() => getEventListeners(signal, 'abort').length)

it.layer(hostOver({ extraPlugins: [spawner.plugin] }), live)(
  'plugin context process cleanup',
  (suite) => {
    suite.effect('lets go of the abort signal of the plugin once the command has ended', () =>
      Effect.gen(function* releasesSignal() {
        const { signal } = new AbortController()
        const handle = yield* spawn('process.exit(0)', { signal })
        yield* resolved(handle.exited)
        const listening = Effect.repeat(listenersOf(signal), { until: (count) => count === 0 })
        assert.strictEqual(yield* Effect.timeout(listening, '2 seconds'), 0)
      }),
    )
  },
)

const orphan = probe('orphan')

it.live(
  'ends a command of a plugin when the host shuts down, though the plugin gave no signal',
  () =>
    Effect.gen(function* endsWithHost() {
      const { host, stop } = yield* startHost({ extraPlugins: [orphan.plugin] })
      yield* host.load()
      const handle = yield* resolved(orphan.context().process.spawn(nodeExec(IDLE)))
      yield* stop
      assert.deepStrictEqual(yield* resolved(handle.exited), { code: null, signal: 'SIGINT' })
    }),
)
```
`packages/kernel/src/plugins/plugin-host-config.test.ts`:
```ts
import type { PluginManifest } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { hostOver, loadedHost, probe, statusOf } from './plugin-fixtures.js'

type Schema = NonNullable<PluginManifest['config']>

const schemaOf = (validate: Schema['~standard']['validate']): Schema => ({
  '~standard': { version: 1, vendor: 'bytebureau-test', validate },
})

// Wants { flag: boolean } and adds a default of its own
const flagSchema = schemaOf((value) =>
  typeof value === 'object' && value !== null && 'flag' in value && typeof value.flag === 'boolean'
    ? { value: { flag: value.flag, extra: 'default' } }
    : { issues: [{ message: 'expected a boolean', path: ['flag'] }] },
)

const strict = probe('strict', {}, { config: flagSchema })
const valid = probe('valid', {}, { config: flagSchema })
const later = probe(
  'later',
  {},
  {
    config: schemaOf(async () => {
      await Promise.resolve()
      return { value: 'resolved later' }
    }),
  },
)
const defaulted = probe(
  'defaulted',
  {},
  { config: schemaOf((value) => ({ value: { seen: value } })) },
)
const bare = probe('bare')
const plain = probe('plain')
const nested = probe(
  'nested',
  {},
  {
    config: schemaOf(() => ({
      issues: [
        { message: 'too deep', path: [{ key: 'nested' }, 'leaf'] },
        { message: 'no path here' },
      ],
    })),
  },
)
const throwing = probe(
  'throwing',
  {},
  {
    config: schemaOf(() => {
      throw new Error('schema blew up')
    }),
  },
)

const extraPlugins = [strict, valid, later, defaulted, bare, plain, nested, throwing].map(
  (candidate) => candidate.plugin,
)
const pluginConfig = { strict: { flag: 'yes' }, valid: { flag: true }, bare: { anything: 1 } }

it.layer(hostOver({ extraPlugins, pluginConfig }))('PluginHost config', (suite) => {
  suite.effect(
    'refuses a plugin whose config the schema rejects, says where, and sets it up never',
    () =>
      Effect.gen(function* refusesInvalidConfig() {
        const host = yield* loadedHost
        assert.strictEqual(statusOf(host, 'strict').state, 'failed')
        assert.strictEqual(
          statusOf(host, 'strict').reason,
          'config invalid: flag expected a boolean',
        )
        assert.throws(() => {
          strict.context()
        }, 'has not been set up')
      }),
  )

  suite.effect(
    'hands the plugin what the schema made of its config: sync, async and defaulted',
    () =>
      Effect.gen(function* handsValidatedConfig() {
        yield* loadedHost
        assert.deepStrictEqual(valid.context().config, { flag: true, extra: 'default' })
        assert.strictEqual(later.context().config, 'resolved later')
        assert.deepStrictEqual(defaulted.context().config, { seen: {} })
      }),
  )

  suite.effect('hands over the config as it is when the plugin has no schema', () =>
    Effect.gen(function* handsRawConfig() {
      yield* loadedHost
      assert.deepStrictEqual(bare.context().config, { anything: 1 })
      assert.strictEqual(plain.context().config, undefined)
    }),
  )
})

it.layer(hostOver({ extraPlugins, pluginConfig }))('PluginHost config issues', (suite) => {
  suite.effect('lists every issue, a nested path in dots and an issue without a path bare', () =>
    Effect.gen(function* listsIssues() {
      const host = yield* loadedHost
      assert.strictEqual(
        statusOf(host, 'nested').reason,
        'config invalid: nested.leaf too deep; no path here',
      )
    }),
  )

  suite.effect('refuses a plugin whose schema throws, with what it threw', () =>
    Effect.gen(function* refusesThrowingSchema() {
      const host = yield* loadedHost
      assert.strictEqual(statusOf(host, 'throwing').reason, 'schema blew up')
    }),
  )
})
```
`packages/kernel/src/plugins/plugin-host-hooks.test.ts`:
```ts
import type {
  AgentSpawnInput,
  AskOpenInput,
  KernelEvent,
  PromptSendInput,
  SessionCreateInput,
} from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { hostOver, loadedHost, noting, probe } from './plugin-fixtures.js'

const calls: string[] = []

const wired = probe('wired', {
  hooks: {
    'session.beforeCreate': noting(calls, 'session.beforeCreate'),
    'agent.beforeSpawn': noting(calls, 'agent.beforeSpawn'),
    'ask.beforeOpen': noting(calls, 'ask.beforeOpen'),
    'prompt.beforeSend': noting(calls, 'prompt.beforeSend'),
    'event.beforePublish': noting(calls, 'event.beforePublish'),
  },
})

const creation: SessionCreateInput = {
  projectId: 'p',
  employeeId: 'e',
  providerId: 'x',
  title: 't',
}
const spawning: AgentSpawnInput = {
  sessionId: 's',
  providerId: 'x',
  command: 'agent',
  args: [],
  env: {},
}
const asking: AskOpenInput = {
  ask: {
    id: 'a',
    sessionId: 's',
    turnId: null,
    kind: 'question',
    title: 'Which one?',
    questions: [],
    policy: { onTimeout: 'wait', timeout: '30m' },
    recommendationSource: 'none',
    status: 'pending',
    createdAt: '2026-10-03T00:00:00.000Z',
    deadlineAt: null,
  },
}
const prompting: PromptSendInput = { sessionId: 's', input: { text: 'hi' } }
const publishing: KernelEvent = { type: 'message.user', sessionId: 's', payload: { text: 'hi' } }

it.layer(hostOver({ extraPlugins: [wired.plugin] }))('PluginHost hooks', (suite) => {
  suite.effect('puts every hook of the contract that a plugin registers on the bus', () =>
    Effect.gen(function* wiresHooks() {
      const { hooks } = yield* loadedHost
      yield* hooks.run('session.beforeCreate', creation, (input) => Effect.succeed(input))
      yield* hooks.run('agent.beforeSpawn', spawning, (input) => Effect.succeed(input))
      yield* hooks.run('ask.beforeOpen', asking, (input) => Effect.succeed(input))
      yield* hooks.run('prompt.beforeSend', prompting, (input) => Effect.succeed(input))
      yield* hooks.run('event.beforePublish', publishing, () => Effect.void)
      assert.deepStrictEqual(calls, [
        'session.beforeCreate',
        'agent.beforeSpawn',
        'ask.beforeOpen',
        'prompt.beforeSend',
        'event.beforePublish',
      ])
    }),
  )
})
```
`packages/kernel/src/plugins/plugin-host-lifecycle.test.ts`:
```ts
import { definePlugin, type Plugin } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { EventLog } from '../events/event-log.js'
import { hostOver, loadedHost, manifestOf, probe, startHost } from './plugin-fixtures.js'

const setups: string[] = []
const counted: Plugin = {
  manifest: manifestOf('counted'),
  setup: () => {
    setups.push('counted')
    return {}
  },
}

const journal: string[] = []

// Writes and reads its store while it is disposed, and fails when asked to
const tracked = (name: string, failing = false): Plugin =>
  definePlugin({
    manifest: manifestOf(name),
    setup: (context) => ({
      dispose: async () => {
        await context.kv.set('bye', name)
        const stored = await context.kv.get('bye')
        journal.push(`${name} aborted=${context.signal.aborted} stored=${String(stored)}`)
        if (failing) {
          throw new Error('dispose failed')
        }
      },
    }),
  })

const watcher = probe('watcher')

// A registration whose dispose counts on being called as its method
const tally = {
  disposed: 0,
  async dispose(): Promise<void> {
    await Promise.resolve()
    this.disposed += 1
  },
}
const stateful: Plugin = { manifest: manifestOf('stateful'), setup: () => tally }

it.layer(hostOver({ extraPlugins: [counted] }))('PluginHost load', (suite) => {
  suite.effect('loads once: more calls set nothing up again and announce nothing again', () =>
    Effect.gen(function* loadsOnce() {
      const host = yield* loadedHost
      yield* Effect.all([host.load(), host.load()], { concurrency: 'unbounded' })
      yield* host.load()
      const events = yield* (yield* EventLog).read({ types: ['plugin.loaded'] }, { from: 0 })
      assert.deepStrictEqual(setups, ['counted'])
      assert.strictEqual(events.length, host.plugins().length)
    }),
  )
})

it.effect('aborts the signal, then disposes in reverse order, whatever one dispose does', () =>
  Effect.gen(function* disposesInReverse() {
    const extraPlugins = [
      tracked('first'),
      tracked('second', true),
      tracked('third'),
      watcher.plugin,
      stateful,
    ]
    const { host, stop } = yield* startHost({ extraPlugins })
    yield* host.load()
    assert.isFalse(watcher.context().signal.aborted)
    yield* stop
    assert.isTrue(watcher.context().signal.aborted)
    assert.strictEqual(tally.disposed, 1)
    assert.deepStrictEqual(journal, [
      'third aborted=true stored=third',
      'second aborted=true stored=second',
      'first aborted=true stored=first',
    ])
  }),
)
```
`packages/kernel/src/plugins/plugin-host-log.test.ts`:
```ts
import { assert, it } from '@effect/vitest'
import { Effect, Layer, Stream } from 'effect'
import { StoreError } from '../errors.js'
import { EventLog } from '../events/event-log.js'
import { SupervisorLive } from '../process/supervisor.js'
import { StoreTest } from '../store/store-test.js'
import { BUNDLED_PLUGINS } from './bundled.js'
import { warnings } from './log-fixtures.js'
import { loadedHost, statusOf } from './plugin-fixtures.js'
import { PluginHostLive } from './plugin-host.js'

const DOWN = 'the store is down'

// A log that cannot record anything
const unreachable = Layer.succeed(
  EventLog,
  EventLog.of({
    publish: () => Effect.fail(new StoreError({ cause: DOWN })),
    subscribe: () => Stream.empty,
    read: () => Effect.succeed([]),
  }),
)

const Deps = Layer.mergeAll(unreachable, SupervisorLive).pipe(Layer.provideMerge(StoreTest))

it.layer(PluginHostLive().pipe(Layer.provideMerge(Deps)))('PluginHost without a log', (suite) => {
  suite.effect('keeps a plugin loaded when its announcement cannot be recorded, and says so', () =>
    Effect.gen(function* survivesLogFailure() {
      const records = yield* warnings
      const host = yield* loadedHost
      const unrecorded = ['plugin event not recorded', { type: 'plugin.loaded', reason: DOWN }]
      assert.strictEqual(statusOf(host, 'workspace-local').state, 'loaded')
      assert.deepStrictEqual(
        records.map((record) => [record.message[0], record.properties]),
        BUNDLED_PLUGINS.map(() => unrecorded),
      )
    }),
  )
})
```
`packages/kernel/src/plugins/plugin-host-refusals.test.ts`:
```ts
import { definePlugin, type Plugin } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { vi } from 'vitest'
import {
  hostOver,
  loadedHost,
  manifestOf,
  noting,
  providerOf,
  runtimeOf,
  statusOf,
} from './plugin-fixtures.js'

const setups: string[] = []
const journal: string[] = []

const ranged: Plugin = { manifest: manifestOf('ranged', { hostApi: '>=0' }), setup: () => ({}) }
const late: Plugin = {
  manifest: manifestOf('late'),
  setup: async () => {
    await Promise.resolve()
    throw new Error('late failure')
  },
}

// A mock without an answer returns nothing, as a plugin in plain JavaScript can
const forgetful: Plugin = { manifest: manifestOf('forgetful'), setup: vi.fn<Plugin['setup']>() }

const twin = (label: string): Plugin => ({
  manifest: manifestOf('twin'),
  setup: () => {
    setups.push(label)
    return {}
  },
})

const heldProvider = providerOf('shared')
const holder = definePlugin({
  manifest: manifestOf('holder'),
  setup: () => ({
    agentProviders: [heldProvider],
    hooks: { 'prompt.beforeSend': noting(journal, 'holder hook') },
  }),
})
const rival = definePlugin({
  manifest: manifestOf('rival'),
  setup: () => ({
    agentProviders: [providerOf('shared')],
    hooks: { 'prompt.beforeSend': noting(journal, 'rival hook') },
    dispose: async (): Promise<void> => {
      await Promise.resolve()
      journal.push('rival disposed')
    },
  }),
})
const impostor = runtimeOf('local')
const intruder = definePlugin({
  manifest: manifestOf('intruder'),
  setup: () => ({ workspaceRuntimes: [impostor] }),
})

it.layer(hostOver({ extraPlugins: [ranged, late, forgetful] }))('PluginHost refusals', (suite) => {
  suite.effect('refuses a host API that is not a caret range, naming both versions', () =>
    Effect.gen(function* refusesRange() {
      const host = yield* loadedHost
      assert.strictEqual(statusOf(host, 'ranged').state, 'failed')
      assert.strictEqual(
        statusOf(host, 'ranged').reason,
        'plugin ranged needs host API >=0, this ByteBureau provides 0.0.0',
      )
    }),
  )

  suite.effect('refuses a plugin whose setup rejects, with the reason it gave', () =>
    Effect.gen(function* refusesRejection() {
      const host = yield* loadedHost
      assert.strictEqual(statusOf(host, 'late').state, 'failed')
      assert.strictEqual(statusOf(host, 'late').reason, 'late failure')
    }),
  )

  suite.effect('refuses a plugin whose setup returns no registration', () =>
    Effect.gen(function* refusesNothing() {
      const host = yield* loadedHost
      assert.strictEqual(statusOf(host, 'forgetful').state, 'failed')
      assert.strictEqual(
        statusOf(host, 'forgetful').reason,
        'plugin forgetful returned no registration from setup',
      )
    }),
  )
})

it.layer(hostOver({ extraPlugins: [twin('first'), twin('second')] }))(
  'PluginHost duplicates',
  (suite) => {
    suite.effect('refuses a second plugin of the same name without setting it up', () =>
      Effect.gen(function* refusesTwin() {
        const host = yield* loadedHost
        const twins = host.plugins().filter((status) => status.name === 'twin')
        assert.deepStrictEqual(
          twins.map((status) => [status.state, status.reason]),
          [
            ['loaded', undefined],
            ['failed', 'a plugin named twin is already loaded'],
          ],
        )
        assert.deepStrictEqual(setups, ['first'])
      }),
    )
  },
)

it.layer(hostOver({ extraPlugins: [holder, rival, intruder] }))(
  'PluginHost port conflicts',
  (suite) => {
    suite.effect(
      'refuses a plugin whose provider is taken, disposes it and leaves its hooks out',
      () =>
        Effect.gen(function* refusesTakenProvider() {
          const host = yield* loadedHost
          assert.strictEqual(statusOf(host, 'holder').state, 'loaded')
          assert.strictEqual(statusOf(host, 'rival').state, 'failed')
          assert.strictEqual(
            statusOf(host, 'rival').reason,
            'agentProviders:shared is already provided by plugin holder',
          )
          assert.strictEqual(host.agentProvider('shared'), heldProvider)
          yield* host.hooks.run(
            'prompt.beforeSend',
            { sessionId: 's', input: { text: 'x' } },
            (input) => Effect.succeed(input),
          )
          assert.deepStrictEqual(journal, ['rival disposed', 'holder hook'])
        }),
    )

    suite.effect('refuses a plugin that offers the runtime of a bundled one', () =>
      Effect.gen(function* refusesTakenRuntime() {
        const host = yield* loadedHost
        assert.strictEqual(
          statusOf(host, 'intruder').reason,
          'workspaceRuntimes:local is already provided by plugin workspace-local',
        )
        assert.strictEqual(host.workspaceRuntimes().length, 1)
        assert.notStrictEqual(host.workspaceRuntimes()[0], impostor)
      }),
    )
  },
)
```
`packages/kernel/src/plugins/plugin-host-workspace.test.ts`:
```ts
import { existsSync } from 'node:fs'
import type { WorkspaceSpec } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { kernelLogger } from '../logging/logging.js'
import { withEnv } from '../process/supervisor-fixtures.js'
import { createTempRepo, tempDir } from '../testing/temp-repo.js'
import { WorkspaceRuntimes } from '../workspace/runtimes.js'
import { resolved } from './plugin-call-fixtures.js'
import { hostOver, loadedHost } from './plugin-fixtures.js'

// Real git processes, so the supervisor runs on the real clock
const live = { excludeTestServices: true }

const specFor = (projectPath: string): WorkspaceSpec => ({
  sessionId: 'host-1',
  projectPath,
  baseBranch: 'main',
  branch: 'bb/host-1',
  copyIgnored: [],
  logger: kernelLogger(['bb', 'test']),
})

it.layer(hostOver(), live)('PluginHost workspace runtime', (suite) => {
  suite.effect('lets the bundled runtime provision and destroy a worktree through the host', () =>
    Effect.gen(function* managesWorktree() {
      yield* withEnv('HOME', tempDir('bb-home-'))
      yield* loadedHost
      const runtime = yield* Effect.fromNullishOr((yield* WorkspaceRuntimes).get('local'))
      const repo = createTempRepo()
      const handle = yield* resolved(runtime.provision(specFor(repo)))
      assert.isTrue(existsSync(handle.path))
      assert.strictEqual(handle.branch, 'bb/host-1')
      assert.isFalse((yield* resolved(runtime.status(handle))).dirty)
      yield* resolved(runtime.destroy(handle))
      assert.isFalse(existsSync(handle.path))
    }),
  )
})
```
`packages/kernel/src/plugins/reason.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { reasonOf } from './reason.js'

describe(reasonOf, () => {
  it('reports the message of an error and the text of anything else', () => {
    expect(reasonOf(new Error('boom'))).toBe('boom')
    expect(reasonOf('plain text')).toBe('plain text')
    expect(reasonOf(42)).toBe('42')
  })
})
```
`packages/kernel/src/secrets/in-memory-secret-store.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { InMemorySecretStore } from './in-memory-secret-store.js'

describe(InMemorySecretStore, () => {
  it('keeps what is set, replaces it and forgets it once deleted', async () => {
    expect.hasAssertions()
    const store = new InMemorySecretStore()
    await expect(store.get('key')).resolves.toBeUndefined()
    await store.set('key', 'first')
    await expect(store.get('key')).resolves.toBe('first')
    await store.set('key', 'second')
    await expect(store.get('key')).resolves.toBe('second')
    await store.delete('key')
    await expect(store.get('key')).resolves.toBeUndefined()
  })
})
```
`packages/kernel/src/plugins/plugin-fixtures.ts` (test plugins):
```ts
import {
  definePlugin,
  type AgentCapabilities,
  type AgentProvider,
  type Plugin,
  type PluginContext,
  type PluginManifest,
  type PluginRegistration,
  type WorkspaceRuntime,
} from '@bytebureau/plugin-api'
import { Context, Effect, Exit, Layer, Scope } from 'effect'
import type { SqlClient } from 'effect/sql'
import { EventLogLive, type EventLog } from '../events/event-log.js'
import { SupervisorLive, type Supervisor } from '../process/supervisor.js'
import { StoreTest } from '../store/store-test.js'
import type { WorkspaceRuntimes } from '../workspace/runtimes.js'
import {
  PluginHost,
  PluginHostLive,
  type PluginHostOptions,
  type PluginHostShape,
  type PluginStatus,
} from './plugin-host.js'

const NO_CAPABILITIES: AgentCapabilities = {
  resume: false,
  interrupt: false,
  askUser: false,
  permissions: false,
  structuredOutput: false,
  usage: false,
  rateLimits: false,
  contextUsage: false,
  thinking: false,
  setModel: false,
  setEffort: false,
  attachments: false,
}

type Dependencies = EventLog | Supervisor | SqlClient.SqlClient

// The event log and the supervisor over an in-memory store
const Deps: Layer.Layer<Dependencies> = Layer.mergeAll(EventLogLive, SupervisorLive).pipe(
  Layer.provideMerge(StoreTest),
)

// The host over those dependencies, which stay in reach of a test beside it
export const hostOver = (
  options: PluginHostOptions = {},
): Layer.Layer<PluginHost | WorkspaceRuntimes | Dependencies> =>
  PluginHostLive(options).pipe(Layer.provideMerge(Deps))

// The host with its plugins loaded; loading twice is harmless
export const loadedHost: Effect.Effect<PluginHostShape, never, PluginHost> = Effect.gen(
  function* loadsHost() {
    const host = yield* PluginHost
    yield* host.load()
    return host
  },
)

export const manifestOf = (name: string, extra: Partial<PluginManifest> = {}): PluginManifest => ({
  name,
  version: '1.0.0',
  hostApi: '^0',
  kind: 'in-process',
  ...extra,
})

const unused = async (): Promise<never> => {
  await Promise.resolve()
  throw new Error('a stub does nothing')
}

// A provider that offers nothing and never opens a session
export const providerOf = (id: string): AgentProvider => ({
  id,
  displayName: id,
  capabilities: NO_CAPABILITIES,
  authStatus: async () => {
    const state = await Promise.resolve('loggedIn' as const)
    return { state }
  },
  createSession: unused,
})

// A runtime that offers nothing
export const runtimeOf = (id: string): WorkspaceRuntime => ({
  id,
  isolation: 'none',
  provision: unused,
  exec: unused,
  status: unused,
  destroy: unused,
})

// A hook that passes everything on as it is
export const passOn = async <Input, Result>(
  input: Readonly<Input>,
  proceed: (input: Input) => Promise<Result>,
): Promise<Result> => {
  const result = await proceed(input)
  return result
}

// A hook that notes its name in the journal and passes on
export const noting =
  (journal: string[], name: string) =>
  async <Input, Result>(
    input: Readonly<Input>,
    proceed: (input: Input) => Promise<Result>,
  ): Promise<Result> => {
    journal.push(name)
    const result = await proceed(input)
    return result
  }

export interface Probe {
  readonly plugin: Plugin
  // The context the host handed over in setup; asking before the plugin has loaded fails
  readonly context: () => PluginContext
}

// A plugin that registers what it is given and keeps its context, for tests that call the context
export function probe(
  name: string,
  registration: PluginRegistration = {},
  manifest: Partial<PluginManifest> = {},
): Probe {
  const kept: { context?: PluginContext } = {}
  const plugin = definePlugin({
    manifest: manifestOf(name, manifest),
    setup: (context) => {
      kept.context = context
      return registration
    },
  })
  return {
    plugin,
    context: () => {
      if (kept.context === undefined) {
        throw new Error(`plugin ${name} has not been set up`)
      }
      return kept.context
    },
  }
}

export function statusOf(
  host: { readonly plugins: () => readonly PluginStatus[] },
  name: string,
): PluginStatus {
  const status = host.plugins().find((candidate) => candidate.name === name)
  if (status === undefined) {
    throw new Error(`no status for plugin ${name}`)
  }
  return status
}

// A host of its own, which the test shuts down itself; the scope closes it with the test at the latest
export const startHost = (
  options: PluginHostOptions = {},
): Effect.Effect<
  { readonly host: PluginHostShape; readonly stop: Effect.Effect<void> },
  never,
  Scope.Scope
> =>
  Effect.gen(function* startsHost() {
    const scope = yield* Effect.acquireRelease(Scope.make(), (own) => Scope.close(own, Exit.void))
    const context = yield* Layer.buildWithScope(hostOver(options), scope)
    return { host: Context.get(context, PluginHost), stop: Scope.close(scope, Exit.void) }
  })
```
`packages/kernel/src/plugins/plugin-call-fixtures.ts`:
```ts
import type { ExecSpec } from '@bytebureau/plugin-api'
import { Effect } from 'effect'

// What a promise of a plugin resolves to
export const resolved = <Value>(promise: Promise<Value>): Effect.Effect<Value> =>
  Effect.promise(async () => {
    const value = await promise
    return value
  })

// What a promise of a plugin rejects with; one that resolves fails the test
export const rejected = (promise: Promise<unknown>): Effect.Effect<unknown, unknown> =>
  Effect.flip(
    Effect.tryPromise({
      try: async () => {
        const value = await promise
        return value
      },
      catch: (cause) => cause,
    }),
  )

export const linesOf = (lines: AsyncIterable<string>): Effect.Effect<readonly string[]> =>
  Effect.promise(async () => {
    const seen: string[] = []
    for await (const line of lines) {
      seen.push(line)
    }
    return seen
  })

// The first items of a subscription; leaving the loop ends it
export const takeFrom = <Item>(
  items: AsyncIterable<Item>,
  count: number,
): Effect.Effect<readonly Item[]> =>
  Effect.promise(async () => {
    const taken: Item[] = []
    for await (const item of items) {
      taken.push(item)
      if (taken.length === count) {
        break
      }
    }
    return taken
  })

// A Node script as a command a plugin can spawn
export const nodeExec = (
  script: string,
  extra: Partial<ExecSpec> = {},
): ExecSpec & { readonly cwd: string } => ({
  command: process.execPath,
  args: ['-e', script],
  cwd: process.cwd(),
  ...extra,
})
```
`packages/kernel/src/plugins/log-fixtures.ts`:
```ts
import type { LogRecord } from '@logtape/logtape'
import { Effect, type Scope } from 'effect'
import { vi } from 'vitest'
import { configureLogging, resetLogging } from '../logging/logging.js'

// LogTape is global: the warnings of the test are collected until its scope closes, and kept off stderr, where the console sink writes
export const warnings: Effect.Effect<readonly LogRecord[], never, Scope.Scope> = Effect.map(
  Effect.acquireRelease(
    Effect.promise(async () => {
      const records: LogRecord[] = []
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
      await configureLogging({
        level: 'warn',
        json: true,
        capture: (record) => {
          records.push(record)
        },
      })
      return { records, spy }
    }),
    ({ spy }) =>
      Effect.promise(async () => {
        await resetLogging()
        spy.mockRestore()
      }),
  ),
  ({ records }) => records,
)
```

- [ ] **Step 2: Implementation**

`packages/kernel/src/plugins/semver-major.ts`:
```ts
const DIGITS = /^\d+$/u

// The major of MAJOR[.MINOR[.PATCH]] after a caret; anything else has none
function wantedMajor(range: string): string | undefined {
  if (!range.startsWith('^')) {
    return undefined
  }
  const parts = range.slice(1).split('.')
  return parts.length <= 3 && parts.every((part) => DIGITS.test(part)) ? parts[0] : undefined
}

// The major of a version with a dot after it
function actualMajor(version: string): string | undefined {
  const [major, ...rest] = version.split('.')
  return rest.length > 0 && major !== undefined && DIGITS.test(major) ? major : undefined
}

// Only caret ranges are accepted for hostApi; anything else is incompatible by design
export function satisfiesMajor(range: string, version: string): boolean {
  const wanted = wantedMajor(range)
  return wanted !== undefined && wanted === actualMajor(version)
}
```
`packages/kernel/src/plugins/hooks.ts`:
```ts
import type { Hook, Hooks } from '@bytebureau/plugin-api'
import type { Effect } from 'effect'
import { kernelLogger } from '../logging/logging.js'
import { HookChain } from './hooks-chain.js'

type HookName = keyof Hooks
type Input<Name extends HookName> = Parameters<Hooks[Name]>[0]
type Result<Name extends HookName> = Awaited<ReturnType<Hooks[Name]>>

// The hook of a name, typed by the name so that a hook cannot be registered under another
type Registered = { [Name in HookName]: Hook<Input<Name>, Result<Name>> }
type Chains = { [Name in HookName]: HookChain<Input<Name>, Result<Name>> }

// Middleware chains in registration order; a throwing hook is logged and skipped
export class HookBus {
  private readonly chains: Chains

  public constructor(category: readonly string[]) {
    const logger = kernelLogger([...category, 'hooks'])
    this.chains = {
      'session.beforeCreate': new HookChain(logger, 'session.beforeCreate'),
      'agent.beforeSpawn': new HookChain(logger, 'agent.beforeSpawn'),
      'ask.beforeOpen': new HookChain(logger, 'ask.beforeOpen'),
      'prompt.beforeSend': new HookChain(logger, 'prompt.beforeSend'),
      'event.beforePublish': new HookChain(logger, 'event.beforePublish'),
    }
  }

  public register<Name extends HookName>(plugin: string, name: Name, hook: Registered[Name]): void {
    this.chains[name].add(plugin, hook)
  }

  // Whatever hooks a plugin has, each under its own name
  public registerAll(plugin: string, hooks: Partial<Hooks>): void {
    this.offer(plugin, 'session.beforeCreate', hooks['session.beforeCreate'])
    this.offer(plugin, 'agent.beforeSpawn', hooks['agent.beforeSpawn'])
    this.offer(plugin, 'ask.beforeOpen', hooks['ask.beforeOpen'])
    this.offer(plugin, 'prompt.beforeSend', hooks['prompt.beforeSend'])
    this.offer(plugin, 'event.beforePublish', hooks['event.beforePublish'])
  }

  public run<Name extends HookName>(
    name: Name,
    input: Input<Name>,
    terminal: (input: Input<Name>) => Effect.Effect<Result<Name>>,
  ): Effect.Effect<Result<Name>> {
    return this.chains[name].run(input, terminal)
  }

  private offer<Name extends HookName>(
    plugin: string,
    name: Name,
    hook: Registered[Name] | undefined,
  ): void {
    if (hook !== undefined) {
      this.register(plugin, name, hook)
    }
  }
}
```
`packages/kernel/src/plugins/hooks-chain.ts`:
```ts
import type { Hook, Logger } from '@bytebureau/plugin-api'
import { Effect } from 'effect'
import { reasonOf } from './reason.js'

interface Entry<Input, Output> {
  readonly plugin: string
  readonly hook: Hook<Input, Output>
}

type Rest<Input, Output> = (input: Input) => Effect.Effect<Output>

// A hook that failed after passing on leaves what the rest of the chain produced; otherwise the chain goes on without it
const resumed = <Output>(
  passedOn: Promise<Output> | undefined,
  without: () => Effect.Effect<Output>,
): Effect.Effect<Output> =>
  passedOn === undefined
    ? without()
    : Effect.promise(async () => {
        const result = await passedOn
        return result
      })

// The hooks of one name in registration order; each one decides whether to pass on to the next
export class HookChain<Input, Output> {
  private readonly entries: Entry<Input, Output>[] = []
  private readonly logger: Logger
  private readonly name: string

  public constructor(logger: Logger, name: string) {
    this.logger = logger
    this.name = name
  }

  public add(plugin: string, hook: Hook<Input, Output>): void {
    this.entries.push({ plugin, hook })
  }

  public run(input: Input, terminal: Rest<Input, Output>): Effect.Effect<Output> {
    return this.from(0, input, terminal)
  }

  private from(
    index: number,
    current: Input,
    terminal: Rest<Input, Output>,
  ): Effect.Effect<Output> {
    const entry = this.entries[index]
    if (entry === undefined) {
      return terminal(current)
    }
    return this.attempt(entry, current, (value) => this.from(index + 1, value, terminal))
  }

  // A failure that came from further down the chain is not the hook's own, so it is passed on and never reported as one
  private attempt(
    entry: Entry<Input, Output>,
    current: Input,
    rest: Rest<Input, Output>,
  ): Effect.Effect<Output> {
    const passedOn: Promise<Output>[] = []
    const downstreamFailed = { value: false }
    const next = async (value: Input): Promise<Output> => {
      const downstream = Effect.runPromise(rest(value))
      passedOn.push(downstream)
      try {
        return await downstream
      } catch (error) {
        downstreamFailed.value = true
        throw error
      }
    }
    const call = Effect.tryPromise({
      try: async () => {
        const result = await entry.hook(current, next)
        return result
      },
      catch: (failure) => failure,
    })
    return Effect.matchEffect(call, {
      onFailure: (failure) => {
        if (!downstreamFailed.value) {
          this.report(entry, failure)
        }
        return resumed(passedOn.at(-1), () => rest(current))
      },
      onSuccess: (result) => Effect.succeed(result),
    })
  }

  private report(entry: Entry<Input, Output>, failure: unknown): void {
    this.logger.warn('hook failed; continuing', {
      plugin: entry.plugin,
      hook: this.name,
      cause: reasonOf(failure),
    })
  }
}
```
`packages/kernel/src/plugins/reason.ts`:
```ts
// The text a failure is reported with, whatever was thrown
export const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)
```
`packages/kernel/src/plugins/port-registry.ts`:
```ts
import type { AgentProvider, PluginRegistration, WorkspaceRuntime } from '@bytebureau/plugin-api'

// The ports that have an id of their own, and so can be taken
const identified = (registration: PluginRegistration): readonly string[] => [
  ...(registration.agentProviders ?? []).map((provider) => `agentProviders:${provider.id}`),
  ...(registration.workspaceRuntimes ?? []).map((runtime) => `workspaceRuntimes:${runtime.id}`),
]

// Every port a registration offers, as plugin.loaded reports them
export const portsOf = (registration: PluginRegistration): readonly string[] => [
  ...identified(registration),
  ...(registration.secretStores ?? []).map(() => 'secretStores'),
]

// The ports of the plugins that loaded; the first plugin to offer a port keeps it
export class PortRegistry {
  private readonly providers = new Map<string, AgentProvider>()
  private readonly runtimes = new Map<string, WorkspaceRuntime>()
  private readonly owners = new Map<string, string>()

  // Takes all ports of a registration, or none and returns which port is held already, and by whom
  public claim(plugin: string, registration: PluginRegistration): string | undefined {
    const [held] = this.heldPorts(registration)
    if (held === undefined) {
      this.store(plugin, registration)
    }
    return held
  }

  public agentProviders(): readonly AgentProvider[] {
    return [...this.providers.values()]
  }

  public agentProvider(id: string): AgentProvider | undefined {
    return this.providers.get(id)
  }

  public workspaceRuntimes(): readonly WorkspaceRuntime[] {
    return [...this.runtimes.values()]
  }

  public workspaceRuntime(id: string): WorkspaceRuntime | undefined {
    return this.runtimes.get(id)
  }

  // A port another plugin holds, or one the registration offers twice, cannot be taken
  private heldPorts(registration: PluginRegistration): readonly string[] {
    const ports = identified(registration)
    return ports.flatMap((port, index) => {
      const owner = this.owners.get(port)
      if (owner !== undefined) {
        return [`${port} is already provided by plugin ${owner}`]
      }
      return ports.indexOf(port) === index ? [] : [`${port} is offered twice by one registration`]
    })
  }

  private store(plugin: string, registration: PluginRegistration): void {
    for (const port of identified(registration)) {
      this.owners.set(port, plugin)
    }
    for (const provider of registration.agentProviders ?? []) {
      this.providers.set(provider.id, provider)
    }
    for (const runtime of registration.workspaceRuntimes ?? []) {
      this.runtimes.set(runtime.id, runtime)
    }
  }
}
```
`packages/kernel/src/plugins/plugin-setup.ts`:
```ts
import type { Plugin, PluginRegistration } from '@bytebureau/plugin-api'
import { HOST_API_VERSION } from './bundled.js'
import { createPluginContext, type ContextDeps } from './plugin-context.js'
import { satisfiesMajor } from './semver-major.js'

export { identityOf, shapeProblem, type Identity } from './plugin-shape.js'

type Path = readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined

// Dotted keys of an issue, a nested one too; the empty text for an issue about the whole config
const dotted = (path: Path): string =>
  (path ?? [])
    .map((segment) => String(typeof segment === 'object' ? segment.key : segment))
    .join('.')

const describeIssue = (path: Path, message: string): string => {
  const where = dotted(path)
  return where === '' ? message : `${where} ${message}`
}

// A plugin without a schema gets its config as it is; one with a schema gets what the schema makes of it, {} when there is none
async function validateConfig(plugin: Plugin, config: unknown): Promise<unknown> {
  const schema = plugin.manifest.config
  if (schema === undefined) {
    return config
  }
  const result = await schema['~standard'].validate(config ?? {})
  if (result.issues !== undefined) {
    const issues = result.issues.map((issue) => describeIssue(issue.path, issue.message))
    throw new Error(`config invalid: ${issues.join('; ')}`)
  }
  return result.value
}

// A plugin written in plain JavaScript may forget to return its registration
const isRegistration = (value: unknown): value is PluginRegistration =>
  typeof value === 'object' && value !== null

// Everything that can refuse a plugin: the host API gate, its config and its own setup
export async function setUpPlugin(
  plugin: Plugin,
  config: unknown,
  deps: ContextDeps,
): Promise<PluginRegistration> {
  const { name, hostApi } = plugin.manifest
  if (!satisfiesMajor(hostApi, HOST_API_VERSION)) {
    throw new Error(
      `plugin ${name} needs host API ${hostApi}, this ByteBureau provides ${HOST_API_VERSION}`,
    )
  }
  const validated = await validateConfig(plugin, config)
  const registration: unknown = await plugin.setup(createPluginContext(name, validated, deps))
  if (!isRegistration(registration)) {
    throw new Error(`plugin ${name} returned no registration from setup`)
  }
  return registration
}
```
`packages/kernel/src/plugins/plugin-loader.ts`:
```ts
import type { KernelEvent, Plugin, PluginRegistration } from '@bytebureau/plugin-api'
import { Effect, Result } from 'effect'
import { constVoid } from 'effect/Function'
import { PluginError } from '../errors.js'
import { kernelLogger } from '../logging/logging.js'
import { HookBus } from './hooks.js'
import type { ContextDeps } from './plugin-context.js'
import { identityOf, setUpPlugin, shapeProblem, type Identity } from './plugin-setup.js'
import { PortRegistry, portsOf } from './port-registry.js'
import { reasonOf } from './reason.js'

export interface PluginStatus {
  readonly name: string
  readonly version: string
  readonly state: 'loaded' | 'failed'
  readonly reason?: string | undefined
  readonly ports: readonly string[]
}

interface Loaded {
  readonly name: string
  readonly registration: PluginRegistration
}

// Sets plugins up one after the other, records what each did and registers what the loaded ones offer
export class PluginLoader {
  public readonly hooks = new HookBus(['bb', 'plugin'])
  public readonly ports = new PortRegistry()
  private readonly statuses: PluginStatus[] = []
  private readonly loaded: Loaded[] = []
  private readonly logger = kernelLogger(['bb', 'plugin'])
  private readonly deps: ContextDeps
  private readonly configs: Readonly<Record<string, unknown>>

  public constructor(deps: ContextDeps, configs: Readonly<Record<string, unknown>>) {
    this.deps = deps
    this.configs = configs
  }

  public plugins(): readonly PluginStatus[] {
    return [...this.statuses]
  }

  // A plugin that is refused is recorded and announced, and never stops the others
  public load(plugins: readonly Plugin[]): Effect.Effect<void> {
    return Effect.forEach(plugins, (plugin) => this.loadOne(plugin), { discard: true })
  }

  // The plugins that loaded go in reverse order, and a plugin that fails to dispose does not keep the others
  public dispose(): Effect.Effect<void> {
    return Effect.forEach(
      this.loaded.toReversed(),
      ({ name, registration }) => this.release(name, registration),
      { discard: true },
    )
  }

  private loadOne(plugin: Plugin): Effect.Effect<void> {
    return Effect.result(this.admit(plugin)).pipe(
      Effect.flatMap((outcome) =>
        Result.isFailure(outcome)
          ? this.refuse(identityOf(plugin), outcome.failure)
          : this.accept(plugin, outcome.success),
      ),
    )
  }

  // Nothing is read of the plugin until the admission runs, so a plugin of any shape is refused and never kills the load
  private admit(plugin: Plugin): Effect.Effect<PluginRegistration, PluginError> {
    return Effect.suspend(() => {
      const { name } = identityOf(plugin)
      const problem = shapeProblem(plugin)
      if (problem !== undefined) {
        return Effect.fail(new PluginError({ plugin: name, reason: problem }))
      }
      if (this.loaded.some((entry) => entry.name === name)) {
        const reason = `a plugin named ${name} is already loaded`
        return Effect.fail(new PluginError({ plugin: name, reason }))
      }
      return this.setUp(plugin).pipe(
        Effect.flatMap((registration) => this.register(plugin, registration)),
      )
    })
  }

  // The configuration of the plugin is its own entry, never an inherited property such as constructor
  private setUp(plugin: Plugin): Effect.Effect<PluginRegistration, PluginError> {
    const { name } = plugin.manifest
    const config = Object.hasOwn(this.configs, name) ? this.configs[name] : undefined
    return Effect.tryPromise({
      try: async () => {
        const registration = await setUpPlugin(plugin, config, this.deps)
        return registration
      },
      catch: (failure) => new PluginError({ plugin: name, reason: reasonOf(failure) }),
    })
  }

  // A port another plugin holds refuses the plugin, which is disposed at once; its hooks never reach the bus
  private register(
    plugin: Plugin,
    registration: PluginRegistration,
  ): Effect.Effect<PluginRegistration, PluginError> {
    const { name } = plugin.manifest
    const held = this.ports.claim(name, registration)
    if (held !== undefined) {
      const refusal = Effect.fail(new PluginError({ plugin: name, reason: held }))
      return Effect.andThen(this.release(name, registration), refusal)
    }
    this.hooks.registerAll(name, registration.hooks ?? {})
    this.loaded.push({ name, registration })
    return Effect.succeed(registration)
  }

  private accept(plugin: Plugin, registration: PluginRegistration): Effect.Effect<void> {
    const { name, version } = plugin.manifest
    const ports = portsOf(registration)
    this.statuses.push({ name, version, state: 'loaded', ports })
    return this.announce({ type: 'plugin.loaded', payload: { name, version, ports } })
  }

  private refuse({ name, version }: Identity, failure: PluginError): Effect.Effect<void> {
    const { reason } = failure
    this.statuses.push({ name, version, state: 'failed', reason, ports: [] })
    this.logger.warn('plugin failed', { plugin: name, reason })
    return this.announce({ type: 'plugin.failed', payload: { name, reason } })
  }

  // The log failing to record an announcement does not undo the plugin's outcome
  private announce(event: KernelEvent): Effect.Effect<void> {
    return Effect.match(this.deps.log.publish(event), {
      onFailure: (failure) => {
        this.logger.warn('plugin event not recorded', {
          type: event.type,
          reason: reasonOf(failure.cause),
        })
      },
      onSuccess: constVoid,
    })
  }

  private release(name: string, registration: PluginRegistration): Effect.Effect<void> {
    const disposing = Effect.tryPromise({
      try: async () => {
        if (registration.dispose !== undefined) {
          await registration.dispose()
        }
      },
      catch: (failure) => failure,
    })
    return Effect.match(disposing, {
      onFailure: (failure) => {
        this.logger.warn('plugin dispose failed', { plugin: name, reason: reasonOf(failure) })
      },
      onSuccess: constVoid,
    })
  }
}
```
`packages/kernel/src/secrets/in-memory-secret-store.ts`:
```ts
import type { SecretStore } from '@bytebureau/plugin-api'

// Phase A placeholder; Phase C replaces it with the keychain and the age-encrypted fallback
export class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>()

  public async get(key: string): Promise<string | undefined> {
    await Promise.resolve()
    return this.values.get(key)
  }

  public async set(key: string, value: string): Promise<void> {
    await Promise.resolve()
    this.values.set(key, value)
  }

  public async delete(key: string): Promise<void> {
    await Promise.resolve()
    this.values.delete(key)
  }
}
```
`packages/kernel/src/plugins/plugin-context.ts`:
```ts
import type {
  ExecHandle,
  ExecSpec,
  PluginContext,
  PluginEvents,
  PluginKv,
  ProcessSpawner,
  SecretStore,
} from '@bytebureau/plugin-api'
import { Effect, Exit, Scope, Stream } from 'effect'
import type { SqlClient } from 'effect/sql'
import { toStoreError, type StoreError } from '../errors.js'
import type { EventLogShape } from '../events/event-log.js'
import { kernelLogger } from '../logging/logging.js'
import type { ManagedProcess, SpawnSpec, Supervisor } from '../process/supervisor.js'

export interface ContextDeps {
  readonly log: EventLogShape
  readonly supervisor: Supervisor['Service']
  readonly sql: SqlClient.SqlClient
  readonly secrets: SecretStore
  readonly signal: AbortSignal
}

type Exec = ExecSpec & { readonly cwd: string }

const namespaced = (secrets: SecretStore, plugin: string): SecretStore => ({
  get: async (key) => {
    const value = await secrets.get(`${plugin}/${key}`)
    return value
  },
  set: async (key, value) => {
    await secrets.set(`${plugin}/${key}`, value)
  },
  delete: async (key) => {
    await secrets.delete(`${plugin}/${key}`)
  },
})

// The seq of the newest durable event, 0 when there is none
const latestSeq = (sql: SqlClient.SqlClient): Effect.Effect<number, StoreError> =>
  sql<{ readonly seq: number | null }>`SELECT MAX(seq) AS seq FROM events`.pipe(
    Effect.map(([row]) => (row === undefined ? null : row.seq) ?? 0),
    Effect.mapError(toStoreError),
  )

// A plugin hears what happens from the moment it subscribes: the filter of the plugin API has no since, so nothing is replayed
const eventsOf = (log: EventLogShape, sql: SqlClient.SqlClient): PluginEvents => ({
  publish: async (event) => {
    await Effect.runPromise(log.publish(event))
  },
  subscribe: (filter) => {
    const live = Effect.map(latestSeq(sql), (since) =>
      log.subscribe({ types: filter.types, sessionId: filter.sessionId, since }),
    )
    return Stream.toAsyncIterable(Stream.unwrap(live))
  },
})

// A failure of the store of a plugin names the plugin and the key
const keyed = async <Value>(
  where: { readonly plugin: string; readonly key: string },
  what: string,
  work: () => Promise<Value>,
): Promise<Value> => {
  try {
    return await work()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`plugin ${where.plugin} could not ${what} ${where.key}: ${reason}`, {
      cause: error,
    })
  }
}

// Only what JSON can hold is stored: undefined, a function or a symbol would be lost, a bigint or a cycle cannot be written
const jsonOf = (plugin: string, key: string, value: unknown): string => {
  try {
    const json: unknown = JSON.stringify(value)
    if (typeof json === 'string') {
      return json
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new TypeError(`plugin ${plugin} cannot store ${key}: ${reason}`, { cause: error })
  }
  throw new TypeError(`plugin ${plugin} cannot store ${key}: a ${typeof value} is not JSON`)
}

const kvOf = (sql: SqlClient.SqlClient, plugin: string): PluginKv => ({
  get: async (key) => {
    const rows = await keyed({ plugin, key }, 'read', async () => {
      const read = await Effect.runPromise(
        sql<{
          readonly value_json: string
        }>`SELECT value_json FROM plugin_kv WHERE plugin_id = ${plugin} AND key = ${key}`,
      )
      return read
    })
    const [row] = rows
    const value: unknown =
      row === undefined
        ? undefined
        : await keyed({ plugin, key }, 'decode', async () => {
            const parsed: unknown = await Promise.resolve(JSON.parse(row.value_json))
            return parsed
          })
    return value
  },
  set: async (key, value) => {
    const json = jsonOf(plugin, key, value)
    await keyed({ plugin, key }, 'store', async () => {
      await Effect.runPromise(
        sql`INSERT INTO plugin_kv (plugin_id, key, value_json) VALUES (${plugin}, ${key}, ${json}) ON CONFLICT(plugin_id, key) DO UPDATE SET value_json = excluded.value_json`,
      )
    })
  },
  delete: async (key) => {
    await keyed({ plugin, key }, 'delete', async () => {
      await Effect.runPromise(
        sql`DELETE FROM plugin_kv WHERE plugin_id = ${plugin} AND key = ${key}`,
      )
    })
  },
})

// A plugin's own env is what it declared, so it passes the allowlist by name
// The process ends when the plugin aborts its signal or the host aborts its own, so no plugin process outlives the host
const specOf = (spec: Exec, hostSignal: AbortSignal): SpawnSpec => ({
  kind: 'helper',
  command: spec.command,
  args: spec.args,
  cwd: spec.cwd,
  env: spec.env ?? {},
  passEnv: Object.keys(spec.env ?? {}),
  signal: spec.signal === undefined ? hostSignal : AbortSignal.any([spec.signal, hostSignal]),
})

const handleOf = (managed: ManagedProcess): ExecHandle => ({
  pid: managed.pid,
  stdout: Stream.toAsyncIterable(managed.stdout),
  stderr: Stream.toAsyncIterable(managed.stderr),
  exited: Effect.runPromise(managed.exit),
  kill: (signal) => {
    Effect.runFork(managed.kill(signal))
  },
})

interface SpawnDeps {
  readonly supervisor: Supervisor['Service']
  readonly signal: AbortSignal
}

// The process lives in a scope of its own that closes once it has exited; the timeout is a fiber of that scope
// A timeout that is not positive sets no timer
const spawnHandle = ({ supervisor, signal }: SpawnDeps, spec: Exec): Effect.Effect<ExecHandle> =>
  Effect.gen(function* spawnsHandle() {
    const scope = yield* Scope.make()
    const spawning = supervisor.spawn(specOf(spec, signal))
    const managed = yield* Effect.provideService(spawning, Scope.Scope, scope)
    yield* Effect.forkDetach(Effect.andThen(managed.exit, Scope.close(scope, Exit.void)))
    if (spec.timeoutMs !== undefined && spec.timeoutMs > 0) {
      yield* Effect.forkIn(Effect.andThen(Effect.sleep(spec.timeoutMs), managed.kill()), scope)
    }
    return handleOf(managed)
  })

const spawnerOf = (deps: SpawnDeps): ProcessSpawner => ({
  spawn: async (spec) => {
    const handle = await Effect.runPromise(spawnHandle(deps, spec))
    return handle
  },
})

export function createPluginContext(
  name: string,
  config: unknown,
  deps: ContextDeps,
): PluginContext {
  return {
    config,
    project: null,
    logger: kernelLogger(['bb', 'plugin', name]),
    events: eventsOf(deps.log, deps.sql),
    secrets: namespaced(deps.secrets, name),
    kv: kvOf(deps.sql, name),
    process: spawnerOf(deps),
    http: fetch,
    signal: deps.signal,
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
import type { AgentProvider, Plugin, SecretStore, WorkspaceRuntime } from '@bytebureau/plugin-api'
import { Context, Effect, Layer, type Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { EventLog } from '../events/event-log.js'
import { Supervisor } from '../process/supervisor.js'
import { InMemorySecretStore } from '../secrets/in-memory-secret-store.js'
import { WorkspaceRuntimes, type WorkspaceRuntimesShape } from '../workspace/runtimes.js'
import { BUNDLED_PLUGINS } from './bundled.js'
import type { HookBus } from './hooks.js'
import { PluginLoader, type PluginStatus } from './plugin-loader.js'

export type { PluginStatus } from './plugin-loader.js'

export interface PluginHostShape {
  // Loads the bundled plugins and then the extra ones; the first call does the work, later ones wait for it
  readonly load: () => Effect.Effect<void>
  readonly plugins: () => readonly PluginStatus[]
  readonly agentProviders: () => readonly AgentProvider[]
  readonly agentProvider: (id: string) => AgentProvider | undefined
  readonly workspaceRuntimes: () => readonly WorkspaceRuntime[]
  readonly hooks: HookBus
}

export interface PluginHostOptions {
  readonly extraPlugins?: readonly Plugin[] | undefined
  readonly pluginConfig?: Readonly<Record<string, unknown>> | undefined
  readonly secrets?: SecretStore | undefined
}

export class PluginHost extends Context.Service<PluginHost, PluginHostShape>()('bb/PluginHost') {}

const hostOf = (loader: PluginLoader, load: Effect.Effect<void>): PluginHostShape => ({
  load: () => load,
  plugins: () => loader.plugins(),
  agentProviders: () => loader.ports.agentProviders(),
  agentProvider: (id) => loader.ports.agentProvider(id),
  workspaceRuntimes: () => loader.ports.workspaceRuntimes(),
  hooks: loader.hooks,
})

const runtimesOf = (loader: PluginLoader): WorkspaceRuntimesShape => ({
  get: (id) => loader.ports.workspaceRuntime(id),
  list: () => loader.ports.workspaceRuntimes(),
})

interface Assembled {
  readonly host: PluginHostShape
  readonly runtimes: WorkspaceRuntimesShape
}

// At release the plugins' signal aborts first, then they are disposed
const make = (
  options: PluginHostOptions,
): Effect.Effect<Assembled, never, EventLog | Supervisor | SqlClient.SqlClient | Scope.Scope> =>
  Effect.gen(function* makePluginHost() {
    const log = yield* EventLog
    const supervisor = yield* Supervisor
    const sql = yield* SqlClient.SqlClient
    const controller = new AbortController()
    const secrets = options.secrets ?? new InMemorySecretStore()
    const deps = { log, supervisor, sql, secrets, signal: controller.signal }
    const loader = new PluginLoader(deps, options.pluginConfig ?? {})
    const load = yield* Effect.cached(
      loader.load([...BUNDLED_PLUGINS, ...(options.extraPlugins ?? [])]),
    )
    yield* Effect.addFinalizer(() =>
      Effect.andThen(
        Effect.sync(() => {
          controller.abort()
        }),
        loader.dispose(),
      ),
    )
    return { host: hostOf(loader, load), runtimes: runtimesOf(loader) }
  })

export const PluginHostLive = (
  options: PluginHostOptions = {},
): Layer.Layer<
  PluginHost | WorkspaceRuntimes,
  never,
  EventLog | Supervisor | SqlClient.SqlClient
> =>
  Layer.unwrap(
    Effect.map(make(options), ({ host, runtimes }) =>
      Layer.mergeAll(
        Layer.succeed(PluginHost, PluginHost.of(host)),
        Layer.succeed(WorkspaceRuntimes, WorkspaceRuntimes.of(runtimes)),
      ),
    ),
  )
```
Verified in Effect 4.0.0: `Result.isFailure(result)` with `.failure`/`.success`; `Layer.unwrap` strips `Scope`, so `Effect.addFinalizer` inside `make` is scoped to the layer (no fallback needed); `Scope.close(scope, Exit.void)`; the service types are `Supervisor['Service']` and `EventLog['Service']`.

Add to `index.ts`: `export { PluginHost, PluginHostLive, type PluginHostShape, type PluginHostOptions, type PluginStatus } from './plugins/plugin-host.js'`, `export { HookBus } from './plugins/hooks.js'`, `export { BUNDLED_PLUGINS, HOST_API_VERSION } from './plugins/bundled.js'`, `export { InMemorySecretStore } from './secrets/in-memory-secret-store.js'`.

- [ ] **Step 3: Run, commit**

Run: `bunx vitest run --project kernel` → PASS. `bun run check` → green (dependency-cruiser: `packages/kernel → plugins/workspace-local` is allowed; the plugin itself still imports only the contracts).

```bash
git add packages/kernel
git commit -m "feat(kernel): host in-process plugins with manifest checks, ports, hooks and a plugin context"
```

### Task 12: `AskService` — questions and permissions with a recommended option, timeouts by policy

**Files:**
- Create: `packages/kernel/src/asks/policy.ts`, `packages/kernel/src/asks/ask-build.ts`, `packages/kernel/src/asks/ask-records.ts`, `packages/kernel/src/asks/ask-events.ts`, `packages/kernel/src/asks/ask-settle.ts`, `packages/kernel/src/asks/ask-waiters.ts`, `packages/kernel/src/asks/ask-open.ts`, `packages/kernel/src/asks/ask-service.ts`, fixtures `ask-fixtures.ts`, `ask-log-fixtures.ts`, `ask-open-fixtures.ts`, `ask-service-fixtures.ts`, and the tests `policy`, `policy-paths`, `ask-build`, `ask-build-recommendation`, `ask-records`, `ask-waiters`, `ask-open`, `ask-service`, `ask-service-lifecycle`, `ask-service-timeout`, `ask-service-recommendation`, `ask-service-failure`, `ask-service-open-failure`, `ask-service-log`, `ask-service-close` (the lint caps split the brief's two source files)
- Modify: `packages/kernel/src/index.ts`

**Interfaces:**
- Consumes: `Ask`, `AskRecord`, `AskAnswer`, `AskQuestion`, `AskOption`, `AnsweredVia`, `PermissionMode` (Task 1); `SqlClient`, `EventLog`, `uuidv7`, `nowIso`, `AskError`; Effect `Deferred`, `Effect.sleep` (TestClock-driven in tests), `Clock`.
- Produces: `AskService` service `{ open(input: OpenAskInput): Effect<AskRecord, StoreError>; answer(askId, answer, via): Effect<AskRecord, AskError | StoreError>; cancel(askId): Effect<void, StoreError>; pending(sessionId?): Effect<readonly AskRecord[], StoreError>; await(askId): Effect<AskAnswer, AskError> }`, `AskServiceLive: Layer<AskService, never, SqlClient | EventLog>`, `OpenAskInput { sessionId; turnId: string | null; kind; title; questions: readonly AskQuestion[]; toolCall?; permissionMode: PermissionMode; askTimeout: string; workspacePath: string; recommendationSource?: 'agent' | 'none' }`, `recommendForPermission(toolCall, workspacePath, permissionMode): PermissionRecommendation { recommended: 'allow' | 'deny' | null; ruleId: string | null }`, `parseDuration('30m') → ms`, `DENY_ON_TIMEOUT_MESSAGE = 'nobody available to approve; do not retry'`.

Policy (spec §8.4): `supervised` → `onTimeout: 'wait'`; `autonomous` + `question` → `'recommended'` after `askTimeout`; `autonomous` + `permission` → `'deny'` after `askTimeout` with the message above. Permission questions always have the two options `allow` and `deny`; the recommendation comes from the rules in `policy.ts` with `recommendationSource: 'policy'` and evidence `{ kind: 'rule', ref: <rule id> }`; when no rule matches, no option is recommended, `recommendationSource: 'none'`, and a `bb.asks` warning is logged.

As shipped: the `read-only-command` rule recommends `allow` only for a whole simple command (no `|`, `;`, `&&`, `||`, lone `&`, redirections, `$(…)`, backticks, `(`, newline or `\r`; `find` is not read-only) and the deny rules run first; the workspace rules resolve the path with `path.posix` against the workspace and require strict containment (symlinks cannot be caught lexically), with `SECRETS` run on the resolved path too; a recommendation counts only when every question has exactly one recommended option — otherwise `recommendationSource: 'none'` with a warning (kind and tool name, never the title), and an autonomous or yolo question ask with source `none` waits with no deadline and no timer (the kernel never fabricates an answer); a permission ask without a `toolCall` still gets `allow`/`deny` with no recommendation; answer, cancel and timeout settle with one atomic `UPDATE … WHERE status = 'pending' RETURNING *` (an answer racing the timer wins); the waiter stays available after settle; the expiry timer is forked into the layer's scope, waits behind a latch until `ask.requested` is announced and `open` is uninterruptible from the insert on; a layer finalizer fails parked waiters; a timeout settles as `answered` via `timeout` (`AskStatus.expired` is unused). Final fix wave: a shell command is read word by word, quotes dropped (`policy-command.ts`): every argument, and the value of a `--flag=value`, is resolved against the workspace; a command that names a secrets path is denied (`cat .env`, `cat ~/.ssh/id_rsa`, `head -c 200 ~/.aws/credentials`), and `read-only-command` is recommended only when every argument stays in the workspace or is the workspace itself (a word the shell expands, `~` or `$VAR`, counts as outside, so `cat /etc/passwd` or `grep -r password /home/me` get no recommendation); `git branch` only lists (no `-d`, `-D`, `-m`, `-M`, `-c`, `-f`, `-u`, `-t` or their long forms, no new branch name without `--list`), `rg` and `grep` run no `--pre`/`--pre-glob` preprocessor and `git diff`/`log`/`show` write no `--output` file; `SECRETS` matches in any case and takes `.aws/credentials`; a `Glob` is judged by its `pattern` below its `path`; `rm-outside-workspace` resolves what a recursive removal names, so `rm -rf node_modules` inside the worktree is left to a human while `.`, `..`, anything outside or expanded, shell syntax around it and any removal without an absolute workspace are denied; `open` withdraws the ask and stops its timer when the announcement fails or dies (`Effect.onError`; a withdrawal that fails is logged); `answer` refuses an option the ask does not offer, and words of the person's own where no question allows them, with `AskError` `invalid_answer` before anything changes; `askTimeout` is validated by the protocol.

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
    expect(
      recommendForPermission({ name: 'WebFetch', input: { url: 'https://x' } }, ws, 'autonomous')
        .recommended,
    ).toBeNull()
  })

  it('treats a yolo employee like an autonomous one', () => {
    const toolCall = { name: 'WebSearch', input: { query: 'effect' } }
    expect(recommendForPermission(toolCall, ws, 'yolo').recommended).toBeNull()
  })
})

const ruleOf = (name: string, input: unknown): string | null =>
  recommendForPermission({ name, input }, ws, 'supervised').ruleId

describe('recommendForPermission deny rules', () => {
  it.each([['git push -f origin main'], ['git push origin +main']])(
    'denies the force push %s',
    (command) => {
      expect(ruleOf('Bash', { command })).toBe('force-push')
    },
  )

  it('leaves an ordinary push to nobody', () => {
    expect(ruleOf('Bash', { command: 'git push origin main' })).toBeNull()
  })

  it.each([
    [`${ws}/.env.local`],
    [`${ws}/certs/server.pem`],
    [`${ws}/.npmrc`],
    ['/home/me/.netrc'],
    ['/home/me/id_rsa'],
    ['/home/me/id_ed25519'],
    ['/home/me/.ssh/config'],
  ])('denies the secrets path %s', (filePath) => {
    expect(ruleOf('Read', { file_path: filePath })).toBe('secrets-path')
  })

  it.each([[`${ws}/src/environment.ts`], [`${ws}/docs/pem.md`], [`${ws}/.envelope/a.txt`]])(
    'does not mistake %s for a secret',
    (filePath) => {
      expect(ruleOf('Write', { file_path: filePath })).toBe('in-workspace-edit')
    },
  )

  it('leaves a recursive removal inside the workspace to nobody', () => {
    expect(ruleOf('Bash', { command: `rm -rf ${ws}/build` })).toBeNull()
  })
})

describe('recommendForPermission allow rules', () => {
  it('reads the path field when a tool has no file_path', () => {
    expect(ruleOf('Read', { path: `${ws}/src/a.ts` })).toBe('in-workspace-read')
  })

  it('does not count a sibling of the workspace as part of it', () => {
    expect(ruleOf('Write', { file_path: `${ws}-copy/a.ts` })).toBeNull()
  })

  it('lets a deny rule win over an allow rule that matches too', () => {
    expect(ruleOf('Read', { file_path: `${ws}/.env` })).toBe('secrets-path')
  })
})

const shell = (command: string): ReturnType<typeof recommendForPermission> =>
  recommendForPermission({ name: 'Bash', input: { command } }, ws, 'supervised')

const ALLOWED = { recommended: 'allow', ruleId: 'read-only-command' }
const NOTHING = { recommended: null, ruleId: null }

describe('recommendForPermission read-only commands', () => {
  it.each([['git status'], ['git log --oneline -5'], ['rg foo src'], ['cat README.md']])(
    'allows the whole command %s',
    (command) => {
      expect(shell(command)).toStrictEqual(ALLOWED)
    },
  )

  it.each([
    ['ls'],
    ['ls -la src'],
    ['pwd'],
    ['echo hello world'],
    ['head -n 5 src/a.ts'],
    ['tail -n 20 build.log'],
    ['wc -l src/a.ts'],
    ['grep -rn foo src'],
    ['git diff HEAD~1'],
    ['git show HEAD'],
    ['git branch --list'],
    ['git rev-parse HEAD'],
  ])('allows %s as one of the read-only commands', (command) => {
    expect(shell(command)).toStrictEqual(ALLOWED)
  })

  it.each([['cat\tREADME.md'], ['git status '], ['ls  -la']])(
    'takes the space around its arguments: %j',
    (command) => {
      expect(shell(command)).toStrictEqual(ALLOWED)
    },
  )

  it('takes the commands of the list by their whole name only', () => {
    expect(shell('lsof -i')).toStrictEqual(NOTHING)
    expect(shell('ls.sh')).toStrictEqual(NOTHING)
    expect(shell('catalog x')).toStrictEqual(NOTHING)
    expect(shell('git statusbar')).toStrictEqual(NOTHING)
  })

  it('does not take a command that merely follows an assignment or a git option', () => {
    expect(shell('ls=1 touch f')).toStrictEqual(NOTHING)
    expect(shell('git -c core.pager=less log')).toStrictEqual(NOTHING)
  })
})

describe('recommendForPermission commands that do more than read', () => {
  it.each([
    ['find . -delete'],
    ['find . -name foo'],
    ['echo x > f'],
    ['echo x >> f'],
    ['cat < f'],
    ['cat f | sh'],
    ['ls ; touch f'],
    ['ls && touch f'],
    ['ls || touch f'],
    ['ls & touch f'],
    ['ls $(cat x)'],
    ['ls `cat x`'],
    ['cat <(ls)'],
    ['ls =(cat x)'],
  ])('recommends nothing for %s', (command) => {
    expect(shell(command)).toStrictEqual(NOTHING)
  })

  it.each([
    ['ls\ntouch f'],
    ['ls -la\ntouch f'],
    ['ls -la\r\ntouch f'],
    ['cat a.txt\rtouch f'],
    ['git status\n'],
    ['git status -s\n'],
  ])('recommends nothing for a line break anywhere: %j', (command) => {
    expect(shell(command)).toStrictEqual(NOTHING)
  })

  it('leaves a list that holds a removal to the deny rule before it', () => {
    expect(shell('git status; rm -rf /')).toStrictEqual({
      recommended: 'deny',
      ruleId: 'rm-outside-workspace',
    })
  })
})

describe('recommendForPermission input', () => {
  it.each([['text'], [null], [42], [{ command: 7 }], [{ file_path: null }]])(
    'finds no rule in the input %o',
    (input) => {
      const result = recommendForPermission({ name: 'Mystery', input }, ws, 'supervised')
      expect(result).toStrictEqual({ recommended: null, ruleId: null })
    },
  )
})

describe(parseDuration, () => {
  it('reads s, m, h suffixes', () => {
    expect(parseDuration('30m')).toBe(1_800_000)
    expect(parseDuration('45s')).toBe(45_000)
    expect(parseDuration('2h')).toBe(7_200_000)
  })

  it('reads milliseconds and zero', () => {
    expect(parseDuration('250ms')).toBe(250)
    expect(parseDuration('0s')).toBe(0)
  })

  it('ignores the space around and inside a duration', () => {
    expect(parseDuration(' 30m ')).toBe(1_800_000)
    expect(parseDuration('30 m')).toBe(1_800_000)
  })

  it.each([['1x'], [''], ['m'], ['30'], ['-5m'], ['1.5h'], ['30min'], ['1d']])(
    'refuses %j',
    (text) => {
      expect(() => parseDuration(text)).toThrow(`invalid duration: ${text}`)
    },
  )
})
```
`packages/kernel/src/asks/ask-service.test.ts`:
```ts
import { assert, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { askOf, request } from './ask-fixtures.js'
import { AskService } from './ask-service.js'
import { eventsOf, rowOf, seedSession, seedTurn, TestLayer } from './ask-service-fixtures.js'

it.layer(TestLayer)('AskService open', (suite) => {
  suite.effect('opens a question that waits for a human and keeps the recommendation', () =>
    Effect.gen(function* opensQuestion() {
      yield* seedSession('open-1')
      const asks = yield* AskService
      const ask = yield* asks.open(request('open-1'))
      assert.strictEqual(ask.recommendationSource, 'agent')
      assert.deepStrictEqual(ask.policy, { onTimeout: 'wait', timeout: '30m' })
      assert.strictEqual(ask.deadlineAt, null)
      assert.deepStrictEqual(
        [ask.status, ask.answer, ask.answeredAt, ask.answeredVia],
        ['pending', null, null, null],
      )
    }),
  )

  suite.effect('stores the ask and announces it on the turn it belongs to', () =>
    Effect.gen(function* storesAsk() {
      yield* seedSession('open-2')
      yield* seedTurn('open-2', 'turn-1')
      const asks = yield* AskService
      const ask = yield* asks.open(request('open-2', { turnId: 'turn-1' }))
      const row = yield* rowOf(ask.id)
      assert.deepStrictEqual(
        [row.session_id, row.turn_id, row.kind, row.status, row.recommendation_source],
        ['open-2', 'turn-1', 'question', 'pending', 'agent'],
      )
      assert.deepStrictEqual(yield* eventsOf('open-2'), [
        { type: 'ask.requested', turnId: 'turn-1', payload: { ask: askOf(ask) } },
      ])
    }),
  )
})

it.layer(TestLayer)('AskService open a permission', (suite) => {
  suite.effect('offers allow and deny, recommending neither, when there is no tool call', () =>
    Effect.gen(function* offersTwoOptions() {
      yield* seedSession('open-3')
      const asks = yield* AskService
      const ask = yield* asks.open(request('open-3', { kind: 'permission' }))
      const options = ask.questions.flatMap((entry) => entry.options)
      assert.deepStrictEqual(
        options.map((option) => [option.id, option.recommended]),
        [
          ['allow', false],
          ['deny', false],
        ],
      )
      assert.deepStrictEqual(
        [ask.recommendationSource, (yield* rowOf(ask.id)).recommendation_source],
        ['none', 'none'],
      )
    }),
  )

  suite.effect('recommends nothing for a shell command that does more than read', () =>
    Effect.gen(function* recommendsNothing() {
      yield* seedSession('open-4')
      const asks = yield* AskService
      const toolCall = { name: 'Bash', input: { command: 'cat f | sh' } }
      const ask = yield* asks.open(
        request('open-4', { kind: 'permission', questions: [], toolCall }),
      )
      const options = ask.questions.flatMap((entry) => entry.options)
      assert.deepStrictEqual(
        options.map((option) => [option.id, option.recommended]),
        [
          ['allow', false],
          ['deny', false],
        ],
      )
      assert.deepStrictEqual(
        [ask.recommendationSource, (yield* rowOf(ask.id)).recommendation_source],
        ['none', 'none'],
      )
    }),
  )
})

it.layer(TestLayer)('AskService answer', (suite) => {
  suite.effect('hands the answer to the caller that waits for it', () =>
    Effect.gen(function* handsAnswer() {
      yield* seedSession('answer-1')
      const asks = yield* AskService
      const ask = yield* asks.open(request('answer-1'))
      const waiting = yield* Effect.forkChild(asks.await(ask.id))
      yield* asks.answer(ask.id, { selected: ['b'] }, 'cli')
      assert.deepStrictEqual(yield* Fiber.join(waiting), { selected: ['b'] })
    }),
  )

  suite.effect('returns the answered record and keeps it off the pending list', () =>
    Effect.gen(function* returnsRecord() {
      yield* seedSession('answer-2')
      const asks = yield* AskService
      const ask = yield* asks.open(request('answer-2'))
      const answer = { selected: ['b'], otherText: 'because', remember: 'session' } as const
      const record = yield* asks.answer(ask.id, answer, 'api')
      assert.deepStrictEqual(
        [record.id, record.status, record.answer, record.answeredVia],
        [ask.id, 'answered', answer, 'api'],
      )
      assert.deepStrictEqual(yield* asks.pending('answer-2'), [])
      assert.strictEqual((yield* rowOf(ask.id)).answer_json, JSON.stringify(answer))
    }),
  )

  suite.effect('announces the request and then the answer', () =>
    Effect.gen(function* announcesAnswer() {
      yield* seedSession('answer-3')
      const asks = yield* AskService
      const ask = yield* asks.open(request('answer-3'))
      yield* asks.answer(ask.id, { selected: ['a'] }, 'cli')
      const answered = { askId: ask.id, answer: { selected: ['a'] }, answeredVia: 'cli' }
      assert.deepStrictEqual(yield* eventsOf('answer-3'), [
        { type: 'ask.requested', payload: { ask: askOf(ask) } },
        { type: 'ask.answered', payload: answered },
      ])
    }),
  )
})
```
`packages/kernel/src/asks/policy-paths.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { recommendForPermission, type PermissionRecommendation } from './policy.js'

const ws = '/repo/.bytebureau/worktrees/s1'

const NOTHING: PermissionRecommendation = { recommended: null, ruleId: null }

const touching = (name: string, filePath: string, workspace = ws): PermissionRecommendation =>
  recommendForPermission({ name, input: { file_path: filePath } }, workspace, 'supervised')

describe('recommendForPermission paths that leave the workspace', () => {
  it.each([
    ['Write', `${ws}/../../../etc/passwd`],
    ['Read', `${ws}/../../../etc/hosts`],
    ['Write', `${ws}/../../../../etc/passwd`],
    ['Read', `${ws}/../../../../etc/hosts`],
    ['Write', `${ws}/../s2/a.ts`],
    ['Write', '../x.txt'],
    ['Read', 'src/../../x.txt'],
  ])('recommends nothing for %s of %s', (name, filePath) => {
    expect(touching(name, filePath)).toStrictEqual(NOTHING)
  })

  it.each([[ws], [`${ws}/`], [`${ws}/.`], [`${ws}/src/..`]])(
    'recommends nothing for the workspace itself, written %s',
    (filePath) => {
      expect(touching('Write', filePath)).toStrictEqual(NOTHING)
    },
  )
})

describe('recommendForPermission paths inside the workspace', () => {
  it.each([
    ['Write', `${ws}/src/../src/a.ts`, 'in-workspace-edit'],
    ['Read', `${ws}/src/../src/a.ts`, 'in-workspace-read'],
    ['Write', 'src/a.ts', 'in-workspace-edit'],
    ['Read', 'src/a.ts', 'in-workspace-read'],
    ['Read', './src/a.ts', 'in-workspace-read'],
    ['Write', `${ws}//src/./a.ts`, 'in-workspace-edit'],
  ])('allows %s of %s once it is resolved', (name, filePath, ruleId) => {
    expect(touching(name, filePath)).toStrictEqual({ recommended: 'allow', ruleId })
  })

  it('resolves against a workspace that was written with a trailing slash', () => {
    expect(touching('Write', 'src/a.ts', `${ws}/`)).toStrictEqual({
      recommended: 'allow',
      ruleId: 'in-workspace-edit',
    })
  })
})

describe('recommendForPermission secrets behind a resolved path', () => {
  it('denies a secret outside the workspace that a traversal reaches', () => {
    expect(touching('Read', `${ws}/../other/.env`)).toStrictEqual({
      recommended: 'deny',
      ruleId: 'secrets-path',
    })
  })

  it.each([
    [`${ws}/key.pem/.`],
    [`${ws}/certs/server.pem/`],
    [`${ws}/.env/`],
    [`${ws}/.npmrc/.`],
    [`${ws}/src/../.env.local`],
    ['src/../.env'],
  ])('denies the secret %s once the path is resolved', (filePath) => {
    expect(touching('Read', filePath).ruleId).toBe('secrets-path')
  })
})

describe('recommendForPermission without a workspace', () => {
  it.each([
    ['Write', '/etc/passwd'],
    ['Read', '/etc/hosts'],
    ['Write', 'src/a.ts'],
  ])('counts nothing as inside it: %s of %s', (name, filePath) => {
    expect(touching(name, filePath, '')).toStrictEqual(NOTHING)
  })

  it('still denies a secret and a recursive removal', () => {
    const removal = { name: 'Bash', input: { command: 'rm -rf /' } }
    expect(touching('Read', '/home/me/.env', '').ruleId).toBe('secrets-path')
    expect(recommendForPermission(removal, '', 'supervised').ruleId).toBe('rm-outside-workspace')
  })
})
```
`packages/kernel/src/asks/ask-build.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import {
  buildAsk,
  DENY_ON_TIMEOUT_MESSAGE,
  recommendedAnswer,
  timeoutAnswer,
  timeoutMs,
  type OpenAskInput,
} from './ask-build.js'
import { asking, option, question, request } from './ask-fixtures.js'

const build = (overrides: Partial<OpenAskInput> = {}): ReturnType<typeof buildAsk> =>
  buildAsk(request('s1', overrides))

const statusCall = { name: 'Bash', input: { command: 'git status' } }

describe(buildAsk, () => {
  it.each([
    ['supervised', 'question', 'wait'],
    ['supervised', 'permission', 'wait'],
    ['autonomous', 'question', 'recommended'],
    ['autonomous', 'permission', 'deny'],
    ['yolo', 'question', 'recommended'],
    ['yolo', 'permission', 'deny'],
  ] as const)('%s employee, %s ask: the policy is %s', (permissionMode, kind, onTimeout) => {
    const { policy } = build({ permissionMode, kind })
    expect(policy).toStrictEqual({ onTimeout, timeout: '30m' })
  })

  it('puts the deadline one timeout after creation and none on an ask that waits', () => {
    const timed = build({ permissionMode: 'autonomous' })
    const expected = new Date(Date.parse(timed.createdAt) + 1_800_000).toISOString()
    expect(timed.deadlineAt).toBe(expected)
    expect(build().deadlineAt).toBeNull()
  })

  it('starts out pending with an id of its own and the turn it was given', () => {
    const first = build({ turnId: 't1' })
    expect(first).toMatchObject({
      sessionId: 's1',
      turnId: 't1',
      status: 'pending',
      title: 'Choose',
    })
    expect(build().id).not.toBe(first.id)
  })

  it('keeps the recommendation of the agent, or none when no option carries one', () => {
    const bare = asking('q1', [option('a', false), option('b', false)])
    expect(build().recommendationSource).toBe('agent')
    expect(build({ recommendationSource: 'none' }).recommendationSource).toBe('none')
    expect(build({ questions: [bare] }).recommendationSource).toBe('none')
  })

  it('assumes the agent made the recommendation when nobody says who did', () => {
    expect(build({ recommendationSource: undefined }).recommendationSource).toBe('agent')
  })
})

describe('buildAsk for a permission', () => {
  it('derives the options of a permission ask from the rules, whatever questions came along', () => {
    const ask = build({ kind: 'permission', toolCall: statusCall })
    expect(ask.recommendationSource).toBe('policy')
    expect(ask.questions).toStrictEqual([
      {
        id: 'permission',
        header: 'Permission',
        prompt: 'Bash: allow this tool call?',
        options: [
          {
            id: 'allow',
            label: 'Allow',
            recommended: true,
            evidence: [{ kind: 'rule', ref: 'read-only-command' }],
          },
          { id: 'deny', label: 'Deny', recommended: false, evidence: [] },
        ],
        multiSelect: false,
        allowOther: false,
      },
    ])
  })

  it.each([[{ name: 'Mystery', input: {} }], [{ name: 'Bash', input: { command: 'cat f | sh' } }]])(
    'recommends nothing for the tool call %o',
    (toolCall) => {
      const ask = build({ kind: 'permission', toolCall })
      const options = ask.questions.flatMap((entry) => entry.options)
      expect(ask.recommendationSource).toBe('none')
      expect(options.map((entry) => [entry.id, entry.recommended])).toStrictEqual([
        ['allow', false],
        ['deny', false],
      ])
    },
  )
})

describe('buildAsk for a permission without a tool call', () => {
  it('offers allow and deny for a permission ask without a tool call, recommending neither', () => {
    const ask = build({ kind: 'permission', questions: [question], recommendationSource: 'agent' })
    expect(ask.recommendationSource).toBe('none')
    expect(ask.questions).toStrictEqual([
      {
        id: 'permission',
        header: 'Permission',
        prompt: 'Allow this?',
        options: [
          { id: 'allow', label: 'Allow', recommended: false, evidence: [] },
          { id: 'deny', label: 'Deny', recommended: false, evidence: [] },
        ],
        multiSelect: false,
        allowOther: false,
      },
    ])
    expect(ask).not.toHaveProperty('toolCall')
  })

  it('carries the tool call of a question ask without reading it', () => {
    const ask = build({ toolCall: statusCall })
    expect(ask.toolCall).toStrictEqual(statusCall)
    expect(ask.questions).toStrictEqual([question])
  })
})

describe(timeoutMs, () => {
  it('is the timeout of a policy that acts and none for one that waits', () => {
    expect(timeoutMs({ onTimeout: 'recommended', timeout: '5m' })).toBe(300_000)
    expect(timeoutMs({ onTimeout: 'wait', timeout: 'whenever' })).toBeNull()
  })

  it('refuses a timeout it cannot read when the policy acts', () => {
    expect(() => build({ permissionMode: 'autonomous', askTimeout: '1x' })).toThrow(
      'invalid duration: 1x',
    )
  })

  it('never reads the timeout of an ask that waits', () => {
    const ask = build({ permissionMode: 'supervised', askTimeout: 'whenever' })
    expect(ask.policy).toStrictEqual({ onTimeout: 'wait', timeout: 'whenever' })
  })
})

describe(recommendedAnswer, () => {
  it('picks the recommended option of every question, in order', () => {
    const second = asking('q2', [option('x', false), option('y', true)])
    expect(recommendedAnswer(build({ questions: [question, second] }))).toStrictEqual({
      selected: ['a', 'y'],
    })
  })

  it('refuses a question without a recommended option instead of inventing an answer', () => {
    const bare = asking('q2', [option('x', false)])
    expect(() => recommendedAnswer(build({ questions: [question, bare] }))).toThrow(
      'question q2 has no recommended option',
    )
  })
})

describe(timeoutAnswer, () => {
  it('denies with the documented message when the policy denies', () => {
    const ask = build({ permissionMode: 'autonomous', kind: 'permission', toolCall: statusCall })
    expect(timeoutAnswer(ask)).toStrictEqual({
      selected: ['deny'],
      otherText: DENY_ON_TIMEOUT_MESSAGE,
    })
    expect(DENY_ON_TIMEOUT_MESSAGE).toBe('nobody available to approve; do not retry')
  })

  it('answers with the recommended options when the policy recommends', () => {
    expect(timeoutAnswer(build({ permissionMode: 'autonomous' }))).toStrictEqual({
      selected: ['a'],
    })
  })
})
```
`packages/kernel/src/asks/ask-build-recommendation.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { buildAsk, unrecommendedQuestions, type OpenAskInput } from './ask-build.js'
import { asking, option, question, request } from './ask-fixtures.js'

const build = (overrides: Partial<OpenAskInput> = {}): ReturnType<typeof buildAsk> =>
  buildAsk(request('s1', overrides))

const recommended = asking('q2', [option('x', false), option('y', true)])
const unmarked = asking('q2', [option('x', false), option('y', false)])
const twice = asking('q3', [option('a', true), option('b', true)])

describe('buildAsk and the recommendation of the agent', () => {
  it('takes a recommendation to be one recommended option in every question', () => {
    const ask = build({ questions: [question, recommended] })
    expect(ask.recommendationSource).toBe('agent')
  })

  it.each([
    { label: 'one of two questions without a recommended option', questions: [question, unmarked] },
    { label: 'no recommended option at all', questions: [unmarked] },
    { label: 'two recommended options in one question', questions: [twice] },
    { label: 'one recommended and one doubled question', questions: [question, twice] },
    { label: 'no question', questions: [] },
  ])('counts it for nothing with $label', ({ questions }) => {
    expect(build({ questions }).recommendationSource).toBe('none')
  })
})

describe('buildAsk and an employee that works on its own', () => {
  it.each(['autonomous', 'yolo'] as const)(
    'makes a %s employee wait for a question that is not fully recommended',
    (permissionMode) => {
      const ask = build({ permissionMode, questions: [question, unmarked] })
      expect(ask.policy).toStrictEqual({ onTimeout: 'wait', timeout: '30m' })
      expect(ask.deadlineAt).toBeNull()
    },
  )

  it.each(['autonomous', 'yolo'] as const)(
    'lets a %s employee proceed once every question is recommended',
    (permissionMode) => {
      const ask = build({ permissionMode, questions: [question, recommended] })
      expect(ask.policy).toStrictEqual({ onTimeout: 'recommended', timeout: '30m' })
      expect(ask.deadlineAt).not.toBeNull()
    },
  )

  it('makes it wait when the recommendation is declared to be none', () => {
    const ask = build({ permissionMode: 'autonomous', recommendationSource: 'none' })
    expect(ask.policy.onTimeout).toBe('wait')
  })

  it('never reads the timeout of a question it will wait for', () => {
    const ask = build({ permissionMode: 'autonomous', questions: [unmarked], askTimeout: '1x' })
    expect(ask.policy).toStrictEqual({ onTimeout: 'wait', timeout: '1x' })
  })

  it('keeps the denial of a permission that nothing recommends', () => {
    const toolCall = { name: 'Mystery', input: {} }
    const ask = build({ permissionMode: 'autonomous', kind: 'permission', toolCall })
    expect(ask.recommendationSource).toBe('none')
    expect(ask.policy).toStrictEqual({ onTimeout: 'deny', timeout: '30m' })
  })
})

describe(unrecommendedQuestions, () => {
  it('names the questions without exactly one recommended option', () => {
    const ask = build({ questions: [question, unmarked, twice] })
    expect(unrecommendedQuestions(ask)).toStrictEqual(['q2', 'q3'])
  })

  it('names nothing when every question is recommended', () => {
    expect(unrecommendedQuestions(build({ questions: [question, recommended] }))).toStrictEqual([])
  })

  it('names the question of a permission that no rule recommends anything for', () => {
    const toolCall = { name: 'Mystery', input: {} }
    expect(unrecommendedQuestions(build({ kind: 'permission', toolCall }))).toStrictEqual([
      'permission',
    ])
  })
})
```
`packages/kernel/src/asks/ask-records.test.ts`:
```ts
import type { Ask } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { StoreError } from '../errors.js'
import { StoreTest } from '../store/store-test.js'
import { buildAsk } from './ask-build.js'
import { request } from './ask-fixtures.js'
import { claimAnswer, claimCancel, insertAsk, listPending, loadAsk } from './ask-records.js'
import { seedSession } from './ask-service-fixtures.js'

const answered = {
  answer: { selected: ['b'] },
  via: 'cli',
  answeredAt: '2026-10-03T00:00:00.000Z',
} as const

interface Stored {
  readonly sql: SqlClient.SqlClient
  readonly ask: Ask
}

// A pending ask of a seeded session, stored
const stored = (sessionId: string): Effect.Effect<Stored, StoreError, SqlClient.SqlClient> =>
  Effect.gen(function* storesAsk() {
    yield* seedSession(sessionId)
    const sql = yield* SqlClient.SqlClient
    const ask = buildAsk(request(sessionId))
    yield* insertAsk(sql, ask)
    return { sql, ask }
  })

it.layer(StoreTest)('ask records', (suite) => {
  suite.effect('read back as the ask they were stored as, nothing answered yet', () =>
    Effect.gen(function* readsBack() {
      const { sql, ask } = yield* stored('rec-1')
      const record = yield* loadAsk(sql, ask.id)
      assert.deepStrictEqual(record, { ...ask, answer: null, answeredAt: null, answeredVia: null })
      assert.strictEqual(yield* loadAsk(sql, 'nobody'), undefined)
    }),
  )

  suite.effect('are answered by the first claim only', () =>
    Effect.gen(function* claimsOnce() {
      const { sql, ask } = yield* stored('rec-2')
      const first = yield* claimAnswer(sql, ask.id, answered)
      const second = yield* claimAnswer(sql, ask.id, { ...answered, via: 'api' })
      assert.deepStrictEqual(first, {
        ...ask,
        status: 'answered',
        answer: answered.answer,
        answeredAt: answered.answeredAt,
        answeredVia: 'cli',
      })
      assert.strictEqual(second, undefined)
      assert.deepStrictEqual(yield* loadAsk(sql, ask.id), first)
    }),
  )
})

it.layer(StoreTest)('ask records cancelled', (suite) => {
  suite.effect('are cancelled by the first claim only, and an answer cannot follow', () =>
    Effect.gen(function* cancelsOnce() {
      const { sql, ask } = yield* stored('rec-3')
      const cancelled = yield* claimCancel(sql, ask.id)
      assert.deepStrictEqual(cancelled, {
        ...ask,
        status: 'cancelled',
        answer: null,
        answeredAt: null,
        answeredVia: null,
      })
      assert.strictEqual(yield* claimCancel(sql, ask.id), undefined)
      assert.strictEqual(yield* claimAnswer(sql, ask.id, answered), undefined)
    }),
  )

  suite.effect('cannot be cancelled once answered, or claimed when unknown', () =>
    Effect.gen(function* refusesLateCancel() {
      const { sql, ask } = yield* stored('rec-4')
      yield* claimAnswer(sql, ask.id, answered)
      assert.strictEqual(yield* claimCancel(sql, ask.id), undefined)
      assert.strictEqual(yield* claimCancel(sql, 'nobody'), undefined)
      assert.strictEqual(yield* claimAnswer(sql, 'nobody', answered), undefined)
    }),
  )
})

const ids = (records: readonly { readonly id: string }[]): readonly string[] =>
  records.map((record) => record.id)

it.layer(StoreTest)('ask records listing', (suite) => {
  suite.effect('lists the pending ones by creation time, the id deciding between equals', () =>
    Effect.gen(function* listsOldestFirst() {
      const { sql, ask } = yield* stored('rec-5')
      yield* seedSession('rec-6')
      const at = (id: string, createdAt: string, sessionId = 'rec-5'): Ask => ({
        ...ask,
        id,
        sessionId,
        createdAt,
      })
      yield* Effect.all([
        insertAsk(sql, at('b', '2026-10-03T00:00:02.000Z')),
        insertAsk(sql, at('c', '2026-10-03T00:00:01.000Z')),
        insertAsk(sql, at('a', '2026-10-03T00:00:02.000Z')),
        insertAsk(sql, at('d', '2026-10-03T00:00:03.000Z', 'rec-6')),
      ])
      yield* claimAnswer(sql, ask.id, answered)
      assert.deepStrictEqual(ids(yield* listPending(sql)), ['c', 'a', 'b', 'd'])
      assert.deepStrictEqual(ids(yield* listPending(sql, 'rec-6')), ['d'])
    }),
  )

  suite.effect('fail as a store error when a row does not fit the protocol', () =>
    Effect.gen(function* failsOnUnreadableRow() {
      const { sql, ask } = yield* stored('rec-7')
      const second = buildAsk(request('rec-7'))
      yield* insertAsk(sql, second)
      yield* sql`UPDATE asks SET payload_json = 'not json' WHERE id = ${ask.id}`
      yield* sql`UPDATE asks SET answered_via = 'pigeon' WHERE id = ${second.id}`
      assert.instanceOf(yield* Effect.flip(loadAsk(sql, ask.id)), StoreError)
      assert.instanceOf(yield* Effect.flip(loadAsk(sql, second.id)), StoreError)
    }),
  )
})
```
`packages/kernel/src/asks/ask-waiters.test.ts`:
```ts
import { assert, it } from '@effect/vitest'
import { Effect, Exit } from 'effect'
import { awaitAnswer, closeWaiters, park, wake, type Waiters } from './ask-waiters.js'

it.effect('looks for the waiter when the wait is run, not when it is built', () =>
  Effect.gen(function* looksLate() {
    const waiters: Waiters = new Map()
    const waiting = awaitAnswer(waiters, 'ask-1')
    yield* park(waiters, 'ask-1')
    yield* wake(waiters, 'ask-1', Exit.succeed({ selected: ['x'] }))
    assert.deepStrictEqual(yield* waiting, { selected: ['x'] })
  }),
)

it.effect('fails a wait nobody parked a waiter for', () =>
  Effect.gen(function* failsStranger() {
    const error = yield* Effect.flip(awaitAnswer(new Map(), 'nobody'))
    assert.deepStrictEqual(
      [error.code, error.reason],
      ['not_found', 'ask nobody was not opened by this process'],
    )
  }),
)

it.effect('fails every waiter that is not done when the service closes and keeps the others', () =>
  Effect.gen(function* closesWaiters() {
    const waiters: Waiters = new Map()
    yield* Effect.all([park(waiters, 'done'), park(waiters, 'open')])
    yield* wake(waiters, 'done', Exit.succeed({ selected: ['x'] }))
    yield* closeWaiters(waiters)
    assert.deepStrictEqual(yield* awaitAnswer(waiters, 'done'), { selected: ['x'] })
    const error = yield* Effect.flip(awaitAnswer(waiters, 'open'))
    assert.deepStrictEqual([error.code, error.reason], ['not_pending', 'service closed'])
  }),
)
```
`packages/kernel/src/asks/ask-open.test.ts`:
```ts
import { assert, it } from '@effect/vitest'
import { Effect, Latch } from 'effect'
import { TestClock } from 'effect/testing'
import { StoreError } from '../errors.js'
import { request } from './ask-fixtures.js'
import { announce, armTimer } from './ask-open.js'
import { parkedAsk } from './ask-open-fixtures.js'
import { codeOf, flush, rowOf, TestLayer } from './ask-service-fixtures.js'
import { awaitAnswer } from './ask-waiters.js'

const TIMEOUT = '30 minutes'

const autonomous = { permissionMode: 'autonomous' } as const

it.layer(TestLayer)('armTimer', (suite) => {
  suite.effect('expires the ask at its deadline once the request is announced', () =>
    Effect.gen(function* expiresAtDeadline() {
      const { deps, ask } = yield* parkedAsk(request('arm-1', autonomous))
      yield* armTimer(deps, ask, yield* Latch.make(true))
      yield* TestClock.adjust(TIMEOUT)
      assert.deepStrictEqual(yield* awaitAnswer(deps.waiters, ask.id), { selected: ['a'] })
    }),
  )

  suite.effect('leaves the ask alone once the timer was disarmed', () =>
    Effect.gen(function* leavesDisarmed() {
      const { deps, ask } = yield* parkedAsk(request('arm-2', autonomous))
      const disarm = yield* armTimer(deps, ask, yield* Latch.make(true))
      yield* disarm
      yield* TestClock.adjust(TIMEOUT)
      yield* flush
      assert.strictEqual((yield* rowOf(ask.id)).status, 'pending')
    }),
  )

  suite.effect('holds the expiry back until the request is announced', () =>
    Effect.gen(function* holdsBack() {
      const { deps, ask } = yield* parkedAsk(request('arm-3', autonomous))
      const announced = yield* Latch.make()
      yield* armTimer(deps, ask, announced)
      yield* TestClock.adjust(TIMEOUT)
      yield* flush
      assert.strictEqual((yield* rowOf(ask.id)).status, 'pending')
      yield* announced.open
      yield* awaitAnswer(deps.waiters, ask.id)
      assert.strictEqual((yield* rowOf(ask.id)).status, 'answered')
    }),
  )

  suite.effect('has no timer for an ask that waits, and nothing to disarm', () =>
    Effect.gen(function* hasNoTimer() {
      const { deps, ask } = yield* parkedAsk(request('arm-4'))
      const disarm = yield* armTimer(deps, ask, yield* Latch.make(true))
      yield* disarm
      yield* TestClock.adjust('10 hours')
      yield* flush
      assert.strictEqual((yield* rowOf(ask.id)).status, 'pending')
    }),
  )
})

const failing = (): Effect.Effect<never, StoreError> =>
  Effect.fail(new StoreError({ cause: 'the log is full' }))

it.layer(TestLayer)('announce', (suite) => {
  suite.effect('stops the timer and cancels the ask when the request cannot be announced', () =>
    Effect.gen(function* withdrawsOnFailure() {
      const { deps, ask } = yield* parkedAsk(request('announce-1', autonomous))
      const calls: string[] = []
      const disarm = Effect.sync(() => {
        calls.push('disarmed')
      })
      const deaf = { ...deps, log: { ...deps.log, publish: failing } }
      const error = yield* Effect.flip(announce(deaf, ask, disarm))
      assert.deepStrictEqual([codeOf(error), calls], ['store', ['disarmed']])
      assert.strictEqual((yield* rowOf(ask.id)).status, 'cancelled')
    }),
  )

  suite.effect('leaves the timer and the ask alone once the request is announced', () =>
    Effect.gen(function* keepsTimer() {
      const { deps, ask } = yield* parkedAsk(request('announce-2', autonomous))
      const calls: string[] = []
      const disarm = Effect.sync(() => {
        calls.push('disarmed')
      })
      yield* announce(deps, ask, disarm)
      assert.deepStrictEqual(calls, [])
      assert.strictEqual((yield* rowOf(ask.id)).status, 'pending')
    }),
  )
})
```
`packages/kernel/src/asks/ask-service-lifecycle.test.ts`:
```ts
import { assert, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { SqlClient } from 'effect/sql'
import type { StoreError } from '../errors.js'
import { buildAsk } from './ask-build.js'
import { askOf, request } from './ask-fixtures.js'
import { insertAsk } from './ask-records.js'
import { AskService, type AskServiceShape } from './ask-service.js'
import {
  codeOf,
  eventsOf,
  reasonOf,
  rowOf,
  seedSession,
  seedTurn,
  TestLayer,
} from './ask-service-fixtures.js'

it.layer(TestLayer)('AskService refusals', (suite) => {
  suite.effect('refuses a second answer and keeps the first', () =>
    Effect.gen(function* refusesSecondAnswer() {
      yield* seedSession('refuse-1')
      const asks = yield* AskService
      const ask = yield* asks.open(request('refuse-1'))
      yield* asks.answer(ask.id, { selected: ['b'] }, 'cli')
      const error = yield* Effect.flip(asks.answer(ask.id, { selected: ['a'] }, 'api'))
      assert.strictEqual(codeOf(error), 'not_pending')
      assert.strictEqual((yield* rowOf(ask.id)).answered_via, 'cli')
      assert.strictEqual((yield* eventsOf('refuse-1')).length, 2)
    }),
  )

  suite.effect('refuses an answer for an ask nobody opened', () =>
    Effect.gen(function* refusesUnknownAsk() {
      const asks = yield* AskService
      const error = yield* Effect.flip(asks.answer('nobody', { selected: ['a'] }, 'cli'))
      assert.strictEqual(codeOf(error), 'not_found')
    }),
  )

  suite.effect('lets a caller that waits only after the answer still have it', () =>
    Effect.gen(function* answersBeforeWait() {
      yield* seedSession('refuse-2')
      const asks = yield* AskService
      const ask = yield* asks.open(request('refuse-2'))
      yield* asks.answer(ask.id, { selected: ['b'] }, 'api')
      assert.deepStrictEqual(yield* asks.await(ask.id), { selected: ['b'] })
      assert.deepStrictEqual(yield* asks.await(ask.id), { selected: ['b'] })
    }),
  )

  suite.effect('fails the wait for an ask this process never opened', () =>
    Effect.gen(function* waitsForStranger() {
      const asks = yield* AskService
      const error = yield* Effect.flip(asks.await('nobody'))
      assert.strictEqual(codeOf(error), 'not_found')
    }),
  )
})

it.layer(TestLayer)('AskService cancel', (suite) => {
  suite.effect('fails the caller that waits and announces the cancellation', () =>
    Effect.gen(function* cancelsWaitedAsk() {
      yield* seedSession('cancel-1')
      yield* seedTurn('cancel-1', 'turn-1')
      const asks = yield* AskService
      const ask = yield* asks.open(request('cancel-1', { turnId: 'turn-1' }))
      const waiting = yield* Effect.forkChild(Effect.flip(asks.await(ask.id)))
      yield* asks.cancel(ask.id)
      assert.strictEqual(codeOf(yield* Fiber.join(waiting)), 'not_pending')
      assert.strictEqual((yield* rowOf(ask.id)).status, 'cancelled')
      assert.deepStrictEqual(yield* eventsOf('cancel-1'), [
        { type: 'ask.requested', turnId: 'turn-1', payload: { ask: askOf(ask) } },
        { type: 'ask.cancelled', turnId: 'turn-1', payload: { askId: ask.id } },
      ])
    }),
  )

  suite.effect('takes a cancelled ask off the pending list and refuses its answer', () =>
    Effect.gen(function* refusesCancelledAsk() {
      yield* seedSession('cancel-2')
      const asks = yield* AskService
      const ask = yield* asks.open(request('cancel-2'))
      yield* asks.cancel(ask.id)
      assert.deepStrictEqual(yield* asks.pending('cancel-2'), [])
      const error = yield* Effect.flip(asks.answer(ask.id, { selected: ['a'] }, 'cli'))
      assert.strictEqual(codeOf(error), 'not_pending')
      assert.strictEqual(reasonOf(error), `ask ${ask.id} is cancelled`)
    }),
  )
})

it.layer(TestLayer)('AskService late cancel', (suite) => {
  suite.effect('fails a wait that starts after the cancellation', () =>
    Effect.gen(function* waitsAfterCancel() {
      yield* seedSession('cancel-3')
      const asks = yield* AskService
      const ask = yield* asks.open(request('cancel-3'))
      yield* asks.cancel(ask.id)
      const error = yield* Effect.flip(asks.await(ask.id))
      assert.strictEqual(codeOf(error), 'not_pending')
    }),
  )

  suite.effect('cancels nothing that is answered, cancelled already or unknown', () =>
    Effect.gen(function* cancelsNothing() {
      yield* seedSession('cancel-4')
      const asks = yield* AskService
      const ask = yield* asks.open(request('cancel-4'))
      yield* asks.answer(ask.id, { selected: ['a'] }, 'cli')
      yield* Effect.all([asks.cancel(ask.id), asks.cancel(ask.id), asks.cancel('nobody')])
      assert.strictEqual((yield* rowOf(ask.id)).status, 'answered')
      assert.strictEqual((yield* eventsOf('cancel-4')).length, 2)
    }),
  )
})

const idsPending = (
  asks: AskServiceShape,
  sessionId?: string,
): Effect.Effect<readonly string[], StoreError> =>
  Effect.map(asks.pending(sessionId), (records) => records.map((record) => record.id))

// Alone in its layer, so that the list of every pending ask is the one this test made
it.layer(TestLayer)('AskService pending order', (suite) => {
  suite.effect('lists the pending asks oldest first and narrows them by session', () =>
    Effect.gen(function* listsPending() {
      yield* Effect.all([seedSession('list-1'), seedSession('list-2')])
      const asks = yield* AskService
      const first = yield* asks.open(request('list-1', { title: 'first' }))
      const second = yield* asks.open(request('list-2', { title: 'second' }))
      const third = yield* asks.open(request('list-1', { title: 'third' }))
      assert.deepStrictEqual(yield* idsPending(asks), [first.id, second.id, third.id])
      assert.deepStrictEqual(yield* idsPending(asks, 'list-1'), [first.id, third.id])
      assert.deepStrictEqual(yield* idsPending(asks, 'list-2'), [second.id])
    }),
  )
})

it.layer(TestLayer)('AskService pending', (suite) => {
  suite.effect('leaves an answered ask out of the list', () =>
    Effect.gen(function* dropsAnswered() {
      yield* seedSession('list-3')
      const asks = yield* AskService
      const first = yield* asks.open(request('list-3'))
      const second = yield* asks.open(request('list-3'))
      yield* asks.answer(first.id, { selected: ['a'] }, 'cli')
      assert.deepStrictEqual(yield* idsPending(asks, 'list-3'), [second.id])
    }),
  )
})

it.layer(TestLayer)('AskService after a restart', (suite) => {
  suite.effect('answers an ask a former process left pending but cannot be waited for', () =>
    Effect.gen(function* answersLeftover() {
      yield* seedSession('left-1')
      const sql = yield* SqlClient.SqlClient
      const ask = buildAsk(request('left-1'))
      yield* insertAsk(sql, ask)
      const asks = yield* AskService
      assert.deepStrictEqual(yield* idsPending(asks, 'left-1'), [ask.id])
      const error = yield* Effect.flip(asks.await(ask.id))
      assert.strictEqual(codeOf(error), 'not_found')
      yield* asks.answer(ask.id, { selected: ['a'] }, 'api')
      assert.strictEqual((yield* rowOf(ask.id)).status, 'answered')
    }),
  )

  suite.effect('cancels such an ask as well', () =>
    Effect.gen(function* cancelsLeftover() {
      yield* seedSession('left-2')
      const sql = yield* SqlClient.SqlClient
      const ask = buildAsk(request('left-2'))
      yield* insertAsk(sql, ask)
      const asks = yield* AskService
      yield* asks.cancel(ask.id)
      assert.strictEqual((yield* rowOf(ask.id)).status, 'cancelled')
    }),
  )
})
```
`packages/kernel/src/asks/ask-service-timeout.test.ts`:
```ts
import { assert, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { askOf, request } from './ask-fixtures.js'
import { AskService, DENY_ON_TIMEOUT_MESSAGE } from './ask-service.js'
import {
  atSystemTime,
  codeOf,
  eventsOf,
  flush,
  reasonOf,
  rowOf,
  seedSession,
  seedTurn,
  TestLayer,
} from './ask-service-fixtures.js'

const autonomous = { permissionMode: 'autonomous' } as const

const TIMEOUT = '30 minutes'

const denial = { selected: ['deny'], otherText: DENY_ON_TIMEOUT_MESSAGE }

// A permission ask for a tool call the rules know, of an employee that works on its own
const permission = (sessionId: string): ReturnType<typeof request> =>
  request(sessionId, {
    ...autonomous,
    kind: 'permission',
    questions: [],
    toolCall: { name: 'Bash', input: { command: 'git status' } },
    askTimeout: '5m',
  })

it.layer(TestLayer)('AskService question timeout', (suite) => {
  suite.effect('proceeds with the recommended option once the timeout has passed', () =>
    Effect.gen(function* proceedsWithRecommended() {
      yield* seedSession('timeout-1')
      const asks = yield* AskService
      const ask = yield* asks.open(request('timeout-1', autonomous))
      assert.strictEqual(ask.policy.onTimeout, 'recommended')
      const waiting = yield* Effect.forkChild(asks.await(ask.id))
      yield* TestClock.adjust(TIMEOUT)
      assert.deepStrictEqual(yield* Fiber.join(waiting), { selected: ['a'] })
      assert.strictEqual((yield* rowOf(ask.id)).answered_via, 'timeout')
    }),
  )

  suite.effect('announces the expiry with its fallback before the answer it produced', () =>
    Effect.gen(function* announcesExpiry() {
      yield* seedSession('timeout-2')
      const asks = yield* AskService
      const ask = yield* asks.open(request('timeout-2', autonomous))
      yield* TestClock.adjust(TIMEOUT)
      yield* asks.await(ask.id)
      const answered = { askId: ask.id, answer: { selected: ['a'] }, answeredVia: 'timeout' }
      assert.deepStrictEqual(yield* eventsOf('timeout-2'), [
        { type: 'ask.requested', payload: { ask: askOf(ask) } },
        { type: 'ask.expired', payload: { askId: ask.id, fallback: 'recommended' } },
        { type: 'ask.answered', payload: answered },
      ])
    }),
  )
})

it.layer(TestLayer)('AskService deadline', (suite) => {
  suite.effect('sets the deadline one timeout after the ask was created', () =>
    Effect.gen(function* setsDeadline() {
      yield* seedSession('timeout-3')
      const asks = yield* AskService
      const ask = yield* asks.open(request('timeout-3', { ...autonomous, askTimeout: '90s' }))
      const expected = new Date(Date.parse(ask.createdAt) + 90_000).toISOString()
      assert.strictEqual(ask.deadlineAt, expected)
      assert.strictEqual((yield* rowOf(ask.id)).deadline_at, expected)
    }),
  )

  suite.effect('expires every ask at its own deadline', () =>
    Effect.gen(function* expiresInTurn() {
      yield* seedSession('timeout-4')
      const asks = yield* AskService
      const soon = yield* asks.open(request('timeout-4', { ...autonomous, askTimeout: '5m' }))
      const late = yield* asks.open(request('timeout-4', { ...autonomous, askTimeout: '30m' }))
      yield* TestClock.adjust('5 minutes')
      yield* asks.await(soon.id)
      assert.strictEqual((yield* rowOf(late.id)).status, 'pending')
      yield* TestClock.adjust('25 minutes')
      assert.deepStrictEqual(yield* asks.await(late.id), { selected: ['a'] })
    }),
  )

  suite.effect('stamps the answer with the time of the timeout, not of the opening', () =>
    Effect.gen(function* stampsTimeout() {
      yield* seedSession('timeout-5')
      const asks = yield* AskService
      const ask = yield* asks.open(request('timeout-5', autonomous))
      const later = Date.parse(ask.createdAt) + 1_800_000
      const expiry = Effect.andThen(TestClock.adjust(TIMEOUT), asks.await(ask.id))
      yield* atSystemTime(later, expiry)
      assert.strictEqual((yield* rowOf(ask.id)).answered_at, new Date(later).toISOString())
    }),
  )
})

it.layer(TestLayer)('AskService permission timeout', (suite) => {
  suite.effect('denies an autonomous permission ask with the documented message', () =>
    Effect.gen(function* deniesOnTimeout() {
      yield* seedSession('timeout-6')
      yield* seedTurn('timeout-6', 'turn-1')
      const asks = yield* AskService
      const ask = yield* asks.open({ ...permission('timeout-6'), turnId: 'turn-1' })
      assert.deepStrictEqual([ask.recommendationSource, ask.policy.onTimeout], ['policy', 'deny'])
      const waiting = yield* Effect.forkChild(asks.await(ask.id))
      yield* TestClock.adjust('5 minutes')
      assert.deepStrictEqual(yield* Fiber.join(waiting), denial)
    }),
  )

  suite.effect('offers allow and deny with the recommendation of the rules', () =>
    Effect.gen(function* offersTwoOptions() {
      yield* seedSession('timeout-7')
      const asks = yield* AskService
      const ask = yield* asks.open(permission('timeout-7'))
      const options = ask.questions.flatMap((entry) => entry.options)
      assert.deepStrictEqual(
        options.map((option) => [option.id, option.recommended]),
        [
          ['allow', true],
          ['deny', false],
        ],
      )
    }),
  )

  suite.effect('denies a permission ask that has no tool call just the same', () =>
    Effect.gen(function* deniesWithoutToolCall() {
      yield* seedSession('timeout-8')
      const asks = yield* AskService
      const ask = yield* asks.open(request('timeout-8', { ...autonomous, kind: 'permission' }))
      yield* TestClock.adjust(TIMEOUT)
      assert.deepStrictEqual(yield* asks.await(ask.id), denial)
    }),
  )
})

it.layer(TestLayer)('AskService denial', (suite) => {
  suite.effect(
    'announces the denial as an expiry with the deny fallback and then as the answer',
    () =>
      Effect.gen(function* announcesDenial() {
        yield* seedSession('denial-1')
        const asks = yield* AskService
        const ask = yield* asks.open(permission('denial-1'))
        yield* TestClock.adjust('5 minutes')
        yield* asks.await(ask.id)
        const answered = { askId: ask.id, answer: denial, answeredVia: 'timeout' }
        assert.deepStrictEqual(yield* eventsOf('denial-1'), [
          { type: 'ask.requested', payload: { ask: askOf(ask) } },
          { type: 'ask.expired', payload: { askId: ask.id, fallback: 'deny' } },
          { type: 'ask.answered', payload: answered },
        ])
      }),
  )

  suite.effect('denies a permission that no rule recommends anything for just the same', () =>
    Effect.gen(function* deniesUnrecommended() {
      yield* seedSession('denial-2')
      const asks = yield* AskService
      const toolCall = { name: 'Mystery', input: {} }
      const ask = yield* asks.open({ ...permission('denial-2'), toolCall })
      assert.deepStrictEqual([ask.recommendationSource, ask.policy.onTimeout], ['none', 'deny'])
      yield* TestClock.adjust('5 minutes')
      assert.deepStrictEqual(yield* asks.await(ask.id), denial)
    }),
  )
})

it.layer(TestLayer)('AskService supervised timeout', (suite) => {
  suite.effect('waits indefinitely, a permission ask without a recommendation included', () =>
    Effect.gen(function* waitsIndefinitely() {
      yield* seedSession('timeout-9')
      const asks = yield* AskService
      const toolCall = { name: 'Mystery', input: {} }
      const ask = yield* asks.open(
        request('timeout-9', { kind: 'permission', questions: [], toolCall, askTimeout: '1m' }),
      )
      assert.strictEqual(ask.recommendationSource, 'none')
      yield* TestClock.adjust('10 hours')
      yield* flush
      assert.strictEqual((yield* asks.pending('timeout-9')).length, 1)
    }),
  )
})

it.layer(TestLayer)('AskService timer', (suite) => {
  suite.effect('leaves an ask a human answered in time alone', () =>
    Effect.gen(function* keepsHumanAnswer() {
      yield* seedSession('timer-1')
      const asks = yield* AskService
      const ask = yield* asks.open(request('timer-1', autonomous))
      yield* asks.answer(ask.id, { selected: ['b'] }, 'cli')
      yield* TestClock.adjust(TIMEOUT)
      yield* flush
      const answered = { askId: ask.id, answer: { selected: ['b'] }, answeredVia: 'cli' }
      assert.deepStrictEqual(yield* eventsOf('timer-1'), [
        { type: 'ask.requested', payload: { ask: askOf(ask) } },
        { type: 'ask.answered', payload: answered },
      ])
    }),
  )

  suite.effect('refuses a human answer that comes after the timeout answered', () =>
    Effect.gen(function* refusesLateHuman() {
      yield* seedSession('timer-3')
      const asks = yield* AskService
      const ask = yield* asks.open(request('timer-3', autonomous))
      yield* TestClock.adjust(TIMEOUT)
      yield* asks.await(ask.id)
      const error = yield* Effect.flip(asks.answer(ask.id, { selected: ['b'] }, 'cli'))
      assert.deepStrictEqual(
        [codeOf(error), reasonOf(error)],
        ['not_pending', `ask ${ask.id} is answered`],
      )
      assert.strictEqual((yield* rowOf(ask.id)).answered_via, 'timeout')
    }),
  )

  suite.effect('outlives the fiber that opened the ask', () =>
    Effect.gen(function* outlivesOpener() {
      yield* seedSession('timer-2')
      const asks = yield* AskService
      const opening = yield* Effect.forkChild(asks.open(request('timer-2', autonomous)))
      const ask = yield* Fiber.join(opening)
      yield* TestClock.adjust(TIMEOUT)
      assert.deepStrictEqual(yield* asks.await(ask.id), { selected: ['a'] })
    }),
  )
})
```
`packages/kernel/src/asks/ask-service-recommendation.test.ts`:
```ts
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { askOf, asking, option, question, request } from './ask-fixtures.js'
import { AskService } from './ask-service.js'
import { eventsOf, flush, seedSession, TestLayer } from './ask-service-fixtures.js'

const autonomous = { permissionMode: 'autonomous' } as const

const recommended = asking('q2', [option('x', false), option('y', true)])
const unmarked = asking('q2', [option('x', false), option('y', false)])
const twice = asking('q3', [option('a', true), option('b', true)])

it.layer(TestLayer)('AskService without a full recommendation', (suite) => {
  suite.effect('waits for a human when only one of two questions is recommended', () =>
    Effect.gen(function* waitsForPartialRecommendation() {
      yield* seedSession('rec-1')
      const asks = yield* AskService
      const ask = yield* asks.open(
        request('rec-1', { ...autonomous, questions: [question, unmarked] }),
      )
      assert.deepStrictEqual(
        [ask.recommendationSource, ask.policy.onTimeout, ask.deadlineAt],
        ['none', 'wait', null],
      )
      yield* TestClock.adjust('10 hours')
      yield* flush
      assert.strictEqual((yield* asks.pending('rec-1')).length, 1)
    }),
  )

  suite.effect('waits for a human when no option is recommended', () =>
    Effect.gen(function* waitsWithoutRecommendation() {
      yield* seedSession('rec-2')
      const asks = yield* AskService
      const ask = yield* asks.open(request('rec-2', { ...autonomous, questions: [unmarked] }))
      assert.deepStrictEqual([ask.recommendationSource, ask.policy.onTimeout], ['none', 'wait'])
      yield* TestClock.adjust('10 hours')
      yield* flush
      assert.deepStrictEqual(yield* eventsOf('rec-2'), [
        { type: 'ask.requested', payload: { ask: askOf(ask) } },
      ])
    }),
  )

  suite.effect('waits for a human when a question has two recommended options', () =>
    Effect.gen(function* waitsForDoubledRecommendation() {
      yield* seedSession('rec-3')
      const asks = yield* AskService
      const ask = yield* asks.open(request('rec-3', { permissionMode: 'yolo', questions: [twice] }))
      assert.deepStrictEqual([ask.recommendationSource, ask.policy.onTimeout], ['none', 'wait'])
      yield* TestClock.adjust('10 hours')
      yield* flush
      assert.strictEqual((yield* asks.pending('rec-3')).length, 1)
    }),
  )
})

it.layer(TestLayer)('AskService with a full recommendation', (suite) => {
  suite.effect('answers every question with its recommended option once the timeout is over', () =>
    Effect.gen(function* answersEveryQuestion() {
      yield* seedSession('rec-4')
      const asks = yield* AskService
      const ask = yield* asks.open(
        request('rec-4', { ...autonomous, questions: [question, recommended] }),
      )
      yield* TestClock.adjust('30 minutes')
      assert.deepStrictEqual(yield* asks.await(ask.id), { selected: ['a', 'y'] })
      const answered = { askId: ask.id, answer: { selected: ['a', 'y'] }, answeredVia: 'timeout' }
      assert.deepStrictEqual(yield* eventsOf('rec-4'), [
        { type: 'ask.requested', payload: { ask: askOf(ask) } },
        { type: 'ask.expired', payload: { askId: ask.id, fallback: 'recommended' } },
        { type: 'ask.answered', payload: answered },
      ])
    }),
  )
})
```
`packages/kernel/src/asks/ask-service-failure.test.ts`:
```ts
import { assert, it } from '@effect/vitest'
import { Effect, Fiber, Layer } from 'effect'
import { StoreTest } from '../store/store-test.js'
import { request } from './ask-fixtures.js'
import { AskService, AskServiceLive } from './ask-service.js'
import { codeOf, refusingLog, rowOf, seedSession } from './ask-service-fixtures.js'

// An event log that records everything but how an ask ended
const ForgetfulLayer = AskServiceLive.pipe(
  Layer.provideMerge(refusingLog(['ask.answered', 'ask.cancelled'])),
  Layer.provideMerge(StoreTest),
)

it.layer(ForgetfulLayer)('AskService with a log that fails', (suite) => {
  suite.effect('still hands an answer the log could not record to the caller that waits', () =>
    Effect.gen(function* answersDespiteLog() {
      yield* seedSession('fail-1')
      const asks = yield* AskService
      const ask = yield* asks.open(request('fail-1'))
      const waiting = yield* Effect.forkChild(asks.await(ask.id))
      const error = yield* Effect.flip(asks.answer(ask.id, { selected: ['b'] }, 'cli'))
      assert.strictEqual(codeOf(error), 'store')
      assert.deepStrictEqual(yield* Fiber.join(waiting), { selected: ['b'] })
      assert.strictEqual((yield* rowOf(ask.id)).status, 'answered')
    }),
  )

  suite.effect('still fails the caller that waits when the cancellation was not recorded', () =>
    Effect.gen(function* cancelsDespiteLog() {
      yield* seedSession('fail-2')
      const asks = yield* AskService
      const ask = yield* asks.open(request('fail-2'))
      const waiting = yield* Effect.forkChild(Effect.flip(asks.await(ask.id)))
      const error = yield* Effect.flip(asks.cancel(ask.id))
      assert.strictEqual(codeOf(error), 'store')
      assert.strictEqual(codeOf(yield* Fiber.join(waiting)), 'not_pending')
      assert.strictEqual((yield* rowOf(ask.id)).status, 'cancelled')
    }),
  )
})
```
`packages/kernel/src/asks/ask-service-open-failure.test.ts`:
```ts
import { assert, it } from '@effect/vitest'
import { Effect, Exit, Fiber, Latch, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { StoreTest } from '../store/store-test.js'
import { request } from './ask-fixtures.js'
import { AskService, AskServiceLive, type AskServiceShape } from './ask-service.js'
import {
  askIdsOf,
  codeOf,
  dyingLog,
  eventsOf,
  flush,
  holdingLog,
  ownService,
  refusingLog,
  rowOf,
  seedSession,
} from './ask-service-fixtures.js'

// An event log that cannot announce a request
const DeafLayer = AskServiceLive.pipe(
  Layer.provideMerge(refusingLog(['ask.requested'])),
  Layer.provideMerge(StoreTest),
)

const autonomous = { permissionMode: 'autonomous' } as const

it.layer(DeafLayer)('AskService with a log that cannot announce a request', (suite) => {
  suite.effect('fails the open and leaves a cancelled ask behind, never a pending one', () =>
    Effect.gen(function* withdrawsAsk() {
      yield* seedSession('open-fail-1')
      const asks = yield* AskService
      const error = yield* Effect.flip(asks.open(request('open-fail-1', autonomous)))
      const [askId = ''] = yield* askIdsOf('open-fail-1')
      assert.strictEqual(codeOf(error), 'store')
      assert.strictEqual((yield* rowOf(askId)).status, 'cancelled')
      assert.deepStrictEqual(yield* asks.pending('open-fail-1'), [])
    }),
  )

  suite.effect('fails the waiter it had parked and announces no cancellation either', () =>
    Effect.gen(function* failsParkedWaiter() {
      yield* seedSession('open-fail-2')
      const asks = yield* AskService
      yield* Effect.flip(asks.open(request('open-fail-2')))
      const [askId = ''] = yield* askIdsOf('open-fail-2')
      const error = yield* Effect.flip(asks.await(askId))
      assert.strictEqual(codeOf(error), 'not_pending')
      assert.deepStrictEqual(yield* eventsOf('open-fail-2'), [])
    }),
  )
})

// An event log that dies while it announces a request
const BrokenLayer = AskServiceLive.pipe(
  Layer.provideMerge(dyingLog(['ask.requested'])),
  Layer.provideMerge(StoreTest),
)

it.layer(BrokenLayer)('AskService with a log that dies announcing a request', (suite) => {
  suite.effect('passes the defect on and leaves no pending ask, parked waiter or armed timer', () =>
    Effect.gen(function* cleansUpAfterDefect() {
      yield* seedSession('open-defect')
      const asks = yield* AskService
      const opened = yield* Effect.exit(asks.open(request('open-defect', autonomous)))
      const [askId = ''] = yield* askIdsOf('open-defect')
      const waited = yield* Effect.flip(asks.await(askId))
      yield* TestClock.adjust('30 minutes')
      yield* flush
      assert.isTrue(Exit.hasDies(opened))
      assert.deepStrictEqual(
        [codeOf(waited), (yield* rowOf(askId)).status],
        ['not_pending', 'cancelled'],
      )
      assert.deepStrictEqual(yield* eventsOf('open-defect'), [])
    }),
  )
})

// The fiber that opens an ask is interrupted while the announcement of the request is held, which is then let through
const interruptedOpening = (
  asks: AskServiceShape,
  entered: Latch.Latch,
  release: Latch.Latch,
): Effect.Effect<void> =>
  Effect.gen(function* interruptsOpening() {
    const opening = yield* Effect.forkChild(asks.open(request('open-fail-3', autonomous)))
    yield* entered.await
    const interrupting = yield* Effect.forkChild(Fiber.interrupt(opening))
    yield* release.open
    yield* Fiber.join(interrupting)
  })

it.effect('finishes opening an ask whose fiber is interrupted halfway, timer armed', () =>
  Effect.gen(function* finishesOpening() {
    const entered = yield* Latch.make()
    const release = yield* Latch.make()
    const layer = AskServiceLive.pipe(
      Layer.provideMerge(holdingLog(entered, release)),
      Layer.provideMerge(StoreTest),
    )
    const { asks, context } = yield* ownService(layer)
    yield* Effect.provide(seedSession('open-fail-3'), context)
    yield* interruptedOpening(asks, entered, release)
    yield* TestClock.adjust('30 minutes')
    yield* flush
    const [askId = ''] = yield* Effect.provide(askIdsOf('open-fail-3'), context)
    assert.strictEqual((yield* Effect.provide(rowOf(askId), context)).status, 'answered')
  }),
)
```
`packages/kernel/src/asks/ask-service-log.test.ts`:
```ts
import type { LogRecord } from '@logtape/logtape'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { warnings } from '../plugins/log-fixtures.js'
import { asking, option, question, request } from './ask-fixtures.js'
import { logged } from './ask-log-fixtures.js'
import { AskService } from './ask-service.js'
import { dropAsks, flush, seedSession, TestLayer } from './ask-service-fixtures.js'

const TIMEOUT = '30 minutes'

const autonomous = { permissionMode: 'autonomous' } as const

const unrecommended = asking('q2', [option('a', false)])
const doubled = asking('q3', [option('a', true), option('b', true)])

const shown = (records: readonly LogRecord[]): readonly unknown[] =>
  records.map((record) => [
    record.category.join('.'),
    record.level,
    record.message[0],
    record.properties,
  ])

it.layer(TestLayer)('AskService logging', (suite) => {
  suite.effect('warns once with the kind and the unrecommended questions of a question', () =>
    Effect.gen(function* warnsWithoutRecommendation() {
      const records = yield* warnings
      yield* seedSession('log-1')
      const asks = yield* AskService
      const questions = [question, unrecommended, doubled]
      const ask = yield* asks.open(request('log-1', { questions }))
      assert.strictEqual(ask.recommendationSource, 'none')
      const properties = { sessionId: 'log-1', kind: 'question', questions: ['q2', 'q3'] }
      assert.deepStrictEqual(shown(records), [
        ['bb.asks', 'warning', 'no recommendation available', properties],
      ])
    }),
  )

  suite.effect('warns with the name of the tool when no rule recommends anything for it', () =>
    Effect.gen(function* warnsWithoutRule() {
      const records = yield* warnings
      yield* seedSession('log-2')
      const asks = yield* AskService
      const toolCall = { name: 'Mystery', input: {} }
      yield* asks.open(request('log-2', { kind: 'permission', questions: [], toolCall }))
      const properties = {
        sessionId: 'log-2',
        kind: 'permission',
        toolName: 'Mystery',
        questions: ['permission'],
      }
      assert.deepStrictEqual(shown(records), [
        ['bb.asks', 'warning', 'no recommendation available', properties],
      ])
    }),
  )
})

it.layer(TestLayer)('AskService logging of secrets and of silence', (suite) => {
  suite.effect('leaves the title and the input of the tool out of the log', () =>
    Effect.gen(function* keepsSecretsOut() {
      const records = yield* warnings
      yield* seedSession('log-3')
      const asks = yield* AskService
      const input = { command: 'curl -H "Authorization: sk-live-123"' }
      const title = 'Run curl -H "Authorization: sk-live-123"'
      const toolCall = { name: 'Mystery', input }
      yield* asks.open(request('log-3', { kind: 'permission', title, toolCall }))
      assert.strictEqual(records.length, 1)
      assert.strictEqual(JSON.stringify(records).includes('sk-live-123'), false)
    }),
  )

  suite.effect('stays quiet when every question is recommended', () =>
    Effect.gen(function* staysQuiet() {
      const records = yield* warnings
      yield* seedSession('log-4')
      const asks = yield* AskService
      yield* asks.open(request('log-4'))
      assert.deepStrictEqual(records, [])
    }),
  )
})

const failures = (records: readonly LogRecord[]): readonly unknown[] =>
  records.map((record) => [
    record.category.join('.'),
    record.level,
    record.message[0],
    record.properties['askId'],
  ])

it.layer(TestLayer)('AskService failing timer', (suite) => {
  suite.effect('logs an expiry the store could not record', () =>
    Effect.gen(function* logsFailedExpiry() {
      const records = yield* logged
      yield* seedSession('log-5')
      const asks = yield* AskService
      const ask = yield* asks.open(request('log-5', autonomous))
      yield* dropAsks
      yield* TestClock.adjust(TIMEOUT)
      yield* flush
      const failure = ['bb.asks', 'error', 'an ask could not be expired', ask.id]
      assert.deepStrictEqual(failures(records), [failure])
    }),
  )
})
```
`packages/kernel/src/asks/ask-service-close.test.ts`:
```ts
import { assert, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { request } from './ask-fixtures.js'
import { logged } from './ask-log-fixtures.js'
import { codeOf, flush, ownService, reasonOf, seedSession } from './ask-service-fixtures.js'

it.effect('leaves no timer running once its layer is released', () =>
  Effect.gen(function* stopsTimers() {
    const records = yield* logged
    const { asks, context, close } = yield* ownService()
    const opening = Effect.andThen(
      seedSession('close-1'),
      asks.open(request('close-1', { permissionMode: 'autonomous' })),
    )
    yield* Effect.provide(opening, context)
    yield* close
    yield* TestClock.adjust('30 minutes')
    yield* flush
    assert.deepStrictEqual(records, [])
  }),
)

it.effect('fails a caller that still waits when its layer is released', () =>
  Effect.gen(function* failsWaiters() {
    const { asks, context, close } = yield* ownService()
    yield* Effect.provide(seedSession('close-2'), context)
    const ask = yield* asks.open(request('close-2'))
    const waiting = yield* Effect.forkChild(Effect.flip(asks.await(ask.id)))
    yield* flush
    yield* close
    const error = yield* Fiber.join(waiting)
    assert.deepStrictEqual([codeOf(error), reasonOf(error)], ['not_pending', 'service closed'])
    const late = yield* Effect.flip(asks.await(ask.id))
    assert.strictEqual(codeOf(late), 'not_pending')
  }),
)

it.effect('keeps the answer of an ask that was settled before its layer was released', () =>
  Effect.gen(function* keepsAnswer() {
    const { asks, context, close } = yield* ownService()
    yield* Effect.provide(seedSession('close-3'), context)
    const ask = yield* asks.open(request('close-3'))
    yield* asks.answer(ask.id, { selected: ['b'] }, 'cli')
    yield* close
    assert.deepStrictEqual(yield* asks.await(ask.id), { selected: ['b'] })
  }),
)
```
`packages/kernel/src/asks/ask-fixtures.ts` (shared fixtures):
```ts
import { Ask, type AskOption, type AskQuestion } from '@bytebureau/protocol'
import { Schema } from 'effect'
import type { OpenAskInput } from './ask-build.js'

// One option the agent recommends and one it does not
export const question: AskQuestion = {
  id: 'q1',
  header: 'Approach',
  prompt: 'Which?',
  multiSelect: false,
  allowOther: true,
  options: [
    { id: 'a', label: 'A', recommended: true, evidence: [{ kind: 'test', ref: 'cli.test.ts' }] },
    { id: 'b', label: 'B', recommended: false, evidence: [] },
  ],
}

// An option without evidence
export const option = (id: string, recommended: boolean): AskOption => ({
  id,
  label: id,
  recommended,
  evidence: [],
})

// A question like the fixture one with other options
export const asking = (id: string, options: readonly AskOption[]): AskQuestion => ({
  ...question,
  id,
  options,
})

// A supervised question the agent has a recommendation for; a test overrides what it is about
export const request = (
  sessionId: string,
  overrides: Partial<OpenAskInput> = {},
): OpenAskInput => ({
  sessionId,
  turnId: null,
  kind: 'question',
  title: 'Choose',
  questions: [question],
  permissionMode: 'supervised',
  askTimeout: '30m',
  workspacePath: '/ws',
  recommendationSource: 'agent',
  ...overrides,
})

// The ask a record is made of: the record without what answering adds
export const askOf = Schema.decodeUnknownSync(Ask)
```
`packages/kernel/src/asks/ask-log-fixtures.ts`:
```ts
import type { LogRecord } from '@logtape/logtape'
import type { Effect, Scope } from 'effect'
import { warnings } from '../plugins/log-fixtures.js'

// Everything the asks log, errors included, until the scope of the test closes; the fixture keeps it off stderr
export const logged: Effect.Effect<readonly LogRecord[], never, Scope.Scope> = warnings
```
`packages/kernel/src/asks/ask-open-fixtures.ts`:
```ts
import type { Ask } from '@bytebureau/protocol'
import { Effect, type Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import type { StoreError } from '../errors.js'
import { EventLog } from '../events/event-log.js'
import { buildAsk, type OpenAskInput } from './ask-build.js'
import type { OpenDeps } from './ask-open.js'
import { insertAsk } from './ask-records.js'
import { seedSession } from './ask-service-fixtures.js'
import { park } from './ask-waiters.js'

export interface ParkedAsk {
  readonly deps: OpenDeps
  readonly ask: Ask
}

// An ask, stored and with its waiter parked, and the deps a timer needs
export const parkedAsk = (
  input: OpenAskInput,
): Effect.Effect<ParkedAsk, StoreError, SqlClient.SqlClient | EventLog | Scope.Scope> =>
  Effect.gen(function* parksAsk() {
    yield* seedSession(input.sessionId)
    const sql = yield* SqlClient.SqlClient
    const log = yield* EventLog
    const scope = yield* Effect.scope
    const deps: OpenDeps = { sql, log, scope, waiters: new Map() }
    const ask = buildAsk(input)
    yield* insertAsk(sql, ask)
    yield* park(deps.waiters, ask.id)
    return { deps, ask }
  })
```
`packages/kernel/src/asks/ask-service-fixtures.ts`:
```ts
import type { EventEnvelope } from '@bytebureau/protocol'
import { Context, Effect, Exit, Layer, Scope, type Latch } from 'effect'
import { SqlClient } from 'effect/sql'
import { vi } from 'vitest'
import { AskError, StoreError, toStoreError } from '../errors.js'
import { EventLog, EventLogLive } from '../events/event-log.js'
import { StoreTest } from '../store/store-test.js'
import { AskService, AskServiceLive, type AskServiceShape } from './ask-service.js'

// The service over the real event log and an in-memory store
export const TestLayer = AskServiceLive.pipe(
  Layer.provideMerge(EventLogLive),
  Layer.provideMerge(StoreTest),
)

// The real event log, except that it cannot record the events of these types
export const refusingLog = (
  types: readonly string[],
): Layer.Layer<EventLog, never, SqlClient.SqlClient> =>
  Layer.effect(
    EventLog,
    Effect.gen(function* makesRefusingLog() {
      const log = yield* EventLog
      return EventLog.of({
        ...log,
        publish: (event) =>
          types.includes(event.type)
            ? Effect.fail(new StoreError({ cause: 'the log is full' }))
            : log.publish(event),
      })
    }),
  ).pipe(Layer.provide(EventLogLive))

// The real event log, except that recording the events of these types dies, as a defect of the log would
export const dyingLog = (
  types: readonly string[],
): Layer.Layer<EventLog, never, SqlClient.SqlClient> =>
  Layer.effect(
    EventLog,
    Effect.gen(function* makesDyingLog() {
      const log = yield* EventLog
      return EventLog.of({
        ...log,
        publish: (event) =>
          types.includes(event.type) ? Effect.die(new Error('the log broke')) : log.publish(event),
      })
    }),
  ).pipe(Layer.provide(EventLogLive))

export interface OwnService {
  readonly asks: AskServiceShape
  readonly context: Context.Context<SqlClient.SqlClient>
  readonly close: Effect.Effect<void>
}

// A service of its own, over a layer the test releases itself; the scope of the test releases it at the latest
export const ownService = (
  layer: Layer.Layer<AskService | EventLog | SqlClient.SqlClient> = TestLayer,
): Effect.Effect<OwnService, never, Scope.Scope> =>
  Effect.gen(function* buildsOwnService() {
    const scope = yield* Effect.acquireRelease(Scope.make(), (own) => Scope.close(own, Exit.void))
    const context = yield* Layer.buildWithScope(layer, scope)
    return { asks: Context.get(context, AskService), context, close: Scope.close(scope, Exit.void) }
  })

// The real event log, except that announcing a request waits until the test lets it through
export const holdingLog = (
  entered: Latch.Latch,
  release: Latch.Latch,
): Layer.Layer<EventLog, never, SqlClient.SqlClient> =>
  Layer.effect(
    EventLog,
    Effect.gen(function* makesHoldingLog() {
      const log = yield* EventLog
      return EventLog.of({
        ...log,
        publish: (event) =>
          event.type === 'ask.requested'
            ? Effect.andThen(Effect.andThen(entered.open, release.await), log.publish(event))
            : log.publish(event),
      })
    }),
  ).pipe(Layer.provide(EventLogLive))

// A session row, and the project it needs, so asks can point at it
export const seedSession = (id: string): Effect.Effect<void, StoreError, SqlClient.SqlClient> =>
  Effect.gen(function* seedsSession() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO projects (id, name, path, default_branch, config_json, created_at, updated_at)
      VALUES ('p', 'p', '/p', 'main', '{}', 't', 't') ON CONFLICT DO NOTHING`
    yield* sql`
      INSERT INTO sessions (id, project_id, title, employee_json, provider_id, workspace_json, status, created_at)
      VALUES (${id}, 'p', 't', '{}', 'fake', '{}', 'running', 't')`
  }).pipe(Effect.mapError(toStoreError))

// A turn of a seeded session, for the asks that name one
export const seedTurn = (
  sessionId: string,
  turnId: string,
): Effect.Effect<void, StoreError, SqlClient.SqlClient> =>
  Effect.gen(function* seedsTurn() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO turns (id, session_id, idx, prompt_json, status, started_at)
      VALUES (${turnId}, ${sessionId}, 0, '{}', 'running', 't')`
  }).pipe(Effect.mapError(toStoreError))

// The system clock stands at the instant while the effect runs; the test clock is not touched
export const atSystemTime = <Value, Failure, Requirements>(
  instant: number,
  effect: Effect.Effect<Value, Failure, Requirements>,
): Effect.Effect<Value, Failure, Requirements> =>
  Effect.suspend(() => {
    vi.setSystemTime(instant)
    return effect
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        vi.useRealTimers()
      }),
    ),
  )

// A store that lost its asks table, for the failures that causes
export const dropAsks: Effect.Effect<void, StoreError, SqlClient.SqlClient> = Effect.gen(
  function* dropsAsks() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DROP TABLE asks`
  },
).pipe(Effect.mapError(toStoreError))

interface StoredAsk {
  readonly session_id: string
  readonly turn_id: string | null
  readonly kind: string
  readonly status: string
  readonly recommendation_source: string
  readonly deadline_at: string | null
  readonly answer_json: string | null
  readonly answered_at: string | null
  readonly answered_via: string | null
}

// The row of an ask as the table holds it
export const rowOf = (askId: string): Effect.Effect<StoredAsk, StoreError, SqlClient.SqlClient> =>
  Effect.gen(function* readsRow() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<StoredAsk>`
      SELECT session_id, turn_id, kind, status, recommendation_source, deadline_at, answer_json, answered_at, answered_via
      FROM asks WHERE id = ${askId}`
    return yield* Effect.fromNullishOr(rows[0])
  }).pipe(Effect.mapError(toStoreError))

export interface SeenEvent {
  readonly type: string
  readonly turnId?: string
  readonly payload: unknown
}

// A turn id is left out of an event that has none, so an expectation need not spell out a missing one
const seen = (event: EventEnvelope): SeenEvent => ({
  type: event.type,
  ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
  payload: event.payload,
})

// What the event log holds for a session, oldest first
export const eventsOf = (
  sessionId: string,
): Effect.Effect<readonly SeenEvent[], StoreError, EventLog> =>
  Effect.gen(function* readsEvents() {
    const log = yield* EventLog
    const events = yield* log.read({ sessionId }, { from: 0 })
    return events.map((event) => seen(event))
  })

// The code of an ask error, the word store for any other failure
export const codeOf = (error: AskError | StoreError): string =>
  error instanceof AskError ? error.code : 'store'

// The reason of an ask error, nothing for any other failure
export const reasonOf = (error: AskError | StoreError): string =>
  error instanceof AskError ? error.reason : ''

// The ids of the asks a session has, in the order of the table
export const askIdsOf = (
  sessionId: string,
): Effect.Effect<readonly string[], StoreError, SqlClient.SqlClient> =>
  Effect.gen(function* readsIds() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      readonly id: string
    }>`SELECT id FROM asks WHERE session_id = ${sessionId} ORDER BY created_at, id`
    return rows.map((row) => row.id)
  }).pipe(Effect.mapError(toStoreError))

// Lets the fibers that are ready run; a timer that fired needs a few turns to finish its work
export const flush: Effect.Effect<void> = Effect.forEach(
  Array.from({ length: 20 }),
  () => Effect.yieldNow,
  { discard: true },
)
```

- [ ] **Step 2: Implementation**

`packages/kernel/src/asks/policy.ts`:
```ts
import path from 'node:path'
import type { PermissionMode } from '@bytebureau/protocol'
import { isReadOnly, isUnder, placesOf, removesOutside, type Place } from './policy-command.js'

const { posix } = path

export interface ToolCall {
  readonly name: string
  readonly input: unknown
}

export interface PermissionRecommendation {
  readonly recommended: 'allow' | 'deny' | null
  readonly ruleId: string | null
}

// The parts of a tool call the rules look at; the fields a tool lacks read as empty text
interface Facts {
  readonly name: string
  readonly command: string
  // What the command names, resolved against the workspace
  readonly places: readonly Place[]
  // The file as the tool names it, and the file it lands on once `.` and `..` are resolved
  readonly filePath: string
  readonly target: string
  // The workspace when it is an absolute path, else empty: nothing is inside a workspace that is not one
  readonly root: string
  readonly mode: PermissionMode
}

interface Rule {
  readonly id: string
  readonly verdict: 'allow' | 'deny'
  readonly applies: (facts: Facts) => boolean
}

const FORCE_PUSH = /\bgit push\b.*(?:--force|-f\b|\+)/u
// A .env file or one of its .env.* variants, a certificate, a private key, a credentials file, anything under .ssh, in any case
const SECRETS =
  /(?:^|\/)\.env(?:\.|$)|\.pem$|(?:^|\/)(?:id_(?:rsa|ed25519)|\.npmrc|\.netrc)$|(?:^|\/)\.ssh\/|(?:^|\/)\.aws\/credentials$/iu
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch', 'curl', 'wget'])

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null

const field = (input: unknown, key: string): string => {
  const value = isRecord(input) ? input[key] : undefined
  return typeof value === 'string' ? value : ''
}

// The check is lexical: a symlink inside the workspace that points out of it cannot be told from a plain path, only the file system knows
// With no absolute workspace nothing is inside it, whatever the path looks like
const inWorkspace = ({ root, target }: Facts): boolean =>
  root !== '' && target !== '' && isUnder(root, target)

const namesSecret = ({ filePath, target, places }: Facts): boolean =>
  SECRETS.test(filePath) ||
  SECRETS.test(target) ||
  places.some((place) => SECRETS.test(place.word) || SECRETS.test(place.resolved ?? ''))

// Rules are evaluated top-down and the first match decides, so the deny rules come first
const RULES: readonly Rule[] = [
  { id: 'force-push', verdict: 'deny', applies: ({ command }) => FORCE_PUSH.test(command) },
  {
    id: 'rm-outside-workspace',
    verdict: 'deny',
    applies: ({ command, root }) => removesOutside(command, root),
  },
  { id: 'secrets-path', verdict: 'deny', applies: namesSecret },
  {
    id: 'network-in-supervised',
    verdict: 'deny',
    applies: ({ mode, name }) => mode === 'supervised' && NETWORK_TOOLS.has(name),
  },
  {
    id: 'read-only-command',
    verdict: 'allow',
    applies: ({ command, root }) => command !== '' && isReadOnly(command, root),
  },
  {
    id: 'in-workspace-read',
    verdict: 'allow',
    applies: (facts) => facts.name === 'Read' && inWorkspace(facts),
  },
  { id: 'in-workspace-edit', verdict: 'allow', applies: inWorkspace },
]

export const NO_RECOMMENDATION: PermissionRecommendation = { recommended: null, ruleId: null }

// A relative path is read against the workspace, where the agent works; without an absolute workspace it can only be tidied
const resolveTarget = (filePath: string, root: string): string => {
  if (filePath === '') {
    return ''
  }
  return root === '' ? posix.normalize(filePath) : posix.resolve(root, filePath)
}

// A glob searches its pattern below its path, so the two together say where it reaches
const filePathOf = ({ name, input }: ToolCall): string => {
  const pattern = field(input, 'pattern')
  if (name === 'Glob' && pattern !== '') {
    return posix.isAbsolute(pattern) ? pattern : posix.join(field(input, 'path') || '.', pattern)
  }
  return field(input, 'file_path') || field(input, 'path')
}

const factsOf = (toolCall: ToolCall, workspacePath: string, mode: PermissionMode): Facts => {
  const root = posix.isAbsolute(workspacePath) ? workspacePath : ''
  const command = field(toolCall.input, 'command')
  const filePath = filePathOf(toolCall)
  return {
    name: toolCall.name,
    command,
    places: placesOf(command, root),
    filePath,
    target: resolveTarget(filePath, root),
    root,
    mode,
  }
}

export function recommendForPermission(
  toolCall: ToolCall,
  workspacePath: string,
  mode: PermissionMode,
): PermissionRecommendation {
  const facts = factsOf(toolCall, workspacePath, mode)
  const rule = RULES.find((candidate) => candidate.applies(facts))
  return rule === undefined ? NO_RECOMMENDATION : { recommended: rule.verdict, ruleId: rule.id }
}

const UNIT_MILLIS: ReadonlyMap<string, number> = new Map([
  ['ms', 1],
  ['s', 1000],
  ['m', 60_000],
  ['h', 3_600_000],
])

const DURATION = /^(?<amount>\d+)\s*(?<unit>ms|s|m|h)$/u

type Parts = Readonly<Record<string, string | undefined>>

export function parseDuration(text: string): number {
  const match = DURATION.exec(text.trim())
  const { amount, unit }: Parts = match === null ? {} : (match.groups ?? {})
  const factor = unit === undefined ? undefined : UNIT_MILLIS.get(unit)
  if (amount === undefined || factor === undefined) {
    throw new Error(`invalid duration: ${text}`)
  }
  return Number(amount) * factor
}
```
`packages/kernel/src/asks/ask-build.ts`:
```ts
import type { Ask, AskAnswer, AskOption, AskQuestion, PermissionMode } from '@bytebureau/protocol'
import { nowIso, uuidv7 } from '../ids.js'
import {
  NO_RECOMMENDATION,
  parseDuration,
  recommendForPermission,
  type ToolCall,
} from './policy.js'

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

interface Questions {
  readonly questions: readonly AskQuestion[]
  readonly recommendationSource: Ask['recommendationSource']
}

// A permission is always allow or deny; the rules recommend one of them for a tool call, or neither, and without a tool call there is nothing to judge
const permissionQuestions = (input: OpenAskInput): Questions => {
  const { toolCall } = input
  const { recommended, ruleId } =
    toolCall === undefined
      ? NO_RECOMMENDATION
      : recommendForPermission(toolCall, input.workspacePath, input.permissionMode)
  const option = (id: 'allow' | 'deny', label: string): AskOption => ({
    id,
    label,
    recommended: recommended === id,
    evidence: recommended === id && ruleId !== null ? [{ kind: 'rule', ref: ruleId }] : [],
  })
  const question: AskQuestion = {
    id: 'permission',
    header: 'Permission',
    prompt: toolCall === undefined ? 'Allow this?' : `${toolCall.name}: allow this tool call?`,
    options: [option('allow', 'Allow'), option('deny', 'Deny')],
    multiSelect: false,
    allowOther: false,
  }
  return { questions: [question], recommendationSource: recommended === null ? 'none' : 'policy' }
}

const recommendedCount = (question: AskQuestion): number =>
  question.options.filter((option) => option.recommended).length

// A recommendation is one recommended option in every question; a question with none or with two has no answer to take
export const unrecommendedQuestions = (ask: Ask): readonly string[] =>
  ask.questions
    .filter((question) => recommendedCount(question) !== 1)
    .map((question) => question.id)

const hasRecommendation = (questions: readonly AskQuestion[]): boolean =>
  questions.length > 0 && questions.every((question) => recommendedCount(question) === 1)

// A permission always gets the questions the rules derive; any other ask keeps the ones it came with
const questionsOf = (input: OpenAskInput): Questions => {
  if (input.kind === 'permission') {
    return permissionQuestions(input)
  }
  const source = hasRecommendation(input.questions)
    ? (input.recommendationSource ?? 'agent')
    : 'none'
  return { questions: input.questions, recommendationSource: source }
}

// Supervised employees are waited for; so is a question nobody recommended an answer to, the kernel makes none up
// The other asks get the fallback of their kind once the timeout is over: a question its recommendation, a permission a denial
const policyFor = (input: OpenAskInput, source: Ask['recommendationSource']): Ask['policy'] => {
  const timeout = input.askTimeout
  if (input.permissionMode === 'supervised') {
    return { onTimeout: 'wait', timeout }
  }
  if (input.kind === 'permission') {
    return { onTimeout: 'deny', timeout }
  }
  return { onTimeout: source === 'none' ? 'wait' : 'recommended', timeout }
}

// Milliseconds until the policy acts; a policy that waits never does
export const timeoutMs = (policy: Ask['policy']): number | null =>
  policy.onTimeout === 'wait' ? null : parseDuration(policy.timeout)

// Everything that can throw happens here, before the ask is stored or announced
export const buildAsk = (input: OpenAskInput): Ask => {
  const { questions, recommendationSource } = questionsOf(input)
  const policy = policyFor(input, recommendationSource)
  const createdAt = nowIso()
  const delay = timeoutMs(policy)
  return {
    id: uuidv7(),
    sessionId: input.sessionId,
    turnId: input.turnId,
    kind: input.kind,
    title: input.title,
    questions,
    recommendationSource,
    ...(input.toolCall === undefined ? {} : { toolCall: input.toolCall }),
    policy,
    status: 'pending',
    createdAt,
    deadlineAt: delay === null ? null : new Date(Date.parse(createdAt) + delay).toISOString(),
  }
}

// Only an ask in which every question has a recommended option is ever answered this way
const recommendedId = (question: AskQuestion): string => {
  const pick = question.options.find((option) => option.recommended)
  if (pick === undefined) {
    throw new Error(`question ${question.id} has no recommended option`)
  }
  return pick.id
}

// One id per question, in order
export const recommendedAnswer = (ask: Ask): AskAnswer => ({
  selected: ask.questions.map((question) => recommendedId(question)),
})

// What the kernel answers when nobody did: a permission is denied with a reason, a question takes the recommendation
export const timeoutAnswer = (ask: Ask): AskAnswer =>
  ask.policy.onTimeout === 'deny'
    ? { selected: ['deny'], otherText: DENY_ON_TIMEOUT_MESSAGE }
    : recommendedAnswer(ask)
```
`packages/kernel/src/asks/ask-records.ts`:
```ts
import {
  AnsweredVia,
  Ask,
  AskAnswer,
  AskStatus,
  Timestamp,
  type AskRecord,
} from '@bytebureau/protocol'
import { Effect, Schema } from 'effect'
import type { SqlClient, Statement } from 'effect/sql'
import { StoreError, toStoreError } from '../errors.js'

// The columns that make an ask whole: the payload it was opened with and the state that came after
const Stored = Schema.Struct({
  payload_json: Schema.fromJsonString(Ask),
  status: AskStatus,
  answer_json: Schema.NullOr(Schema.fromJsonString(AskAnswer)),
  answered_at: Schema.NullOr(Timestamp),
  answered_via: Schema.NullOr(AnsweredVia),
})

const decodeStored = Schema.decodeUnknownEffect(Stored)

// A row that does not fit the protocol is a failure of the store, not a defect
const toRecord = (row: unknown): Effect.Effect<AskRecord, StoreError> =>
  decodeStored(row).pipe(
    Effect.map((stored) => ({
      ...stored.payload_json,
      status: stored.status,
      answer: stored.answer_json,
      answeredAt: stored.answered_at,
      answeredVia: stored.answered_via,
    })),
    Effect.mapError(
      (cause) => new StoreError({ cause: new Error('an ask record is unreadable', { cause }) }),
    ),
  )

// The record of the first row; a query that finds no row, or an update that claims none, has no record
const firstRecord = (
  rows: readonly unknown[],
): Effect.Effect<AskRecord | undefined, StoreError> => {
  const [row] = rows
  return row === undefined ? Effect.undefined : toRecord(row)
}

export const insertAsk = (sql: SqlClient.SqlClient, ask: Ask): Effect.Effect<void, StoreError> =>
  sql`
    INSERT INTO asks (id, session_id, turn_id, kind, payload_json, status, recommendation_source, created_at, deadline_at)
    VALUES (${ask.id}, ${ask.sessionId}, ${ask.turnId}, ${ask.kind}, ${JSON.stringify(ask)}, ${ask.status}, ${ask.recommendationSource}, ${ask.createdAt}, ${ask.deadlineAt})`.pipe(
    Effect.asVoid,
    Effect.mapError(toStoreError),
  )

export const loadAsk = (
  sql: SqlClient.SqlClient,
  askId: string,
): Effect.Effect<AskRecord | undefined, StoreError> =>
  sql`SELECT * FROM asks WHERE id = ${askId}`.pipe(
    Effect.mapError(toStoreError),
    Effect.flatMap((rows) => firstRecord(rows)),
  )

// Pending asks, oldest first; the id breaks a tie because uuidv7 ids grow with time
const pendingConditions = (
  sql: SqlClient.SqlClient,
  sessionId?: string,
): readonly Statement.Fragment[] => [
  sql`status = 'pending'`,
  ...(sessionId === undefined ? [] : [sql`session_id = ${sessionId}`]),
]

export const listPending = (
  sql: SqlClient.SqlClient,
  sessionId?: string,
): Effect.Effect<readonly AskRecord[], StoreError> =>
  sql`SELECT * FROM asks WHERE ${sql.and(pendingConditions(sql, sessionId))} ORDER BY created_at, id`.pipe(
    Effect.mapError(toStoreError),
    Effect.flatMap((rows) => Effect.all(rows.map((row) => toRecord(row)))),
  )

export interface Answered {
  readonly answer: AskAnswer
  readonly via: AnsweredVia
  readonly answeredAt: string
}

// Only a pending ask can be answered, whoever asks first wins
export const claimAnswer = (
  sql: SqlClient.SqlClient,
  askId: string,
  { answer, via, answeredAt }: Answered,
): Effect.Effect<AskRecord | undefined, StoreError> =>
  sql`
    UPDATE asks SET status = 'answered', answer_json = ${JSON.stringify(answer)}, answered_at = ${answeredAt}, answered_via = ${via}
    WHERE id = ${askId} AND status = 'pending' RETURNING *`.pipe(
    Effect.mapError(toStoreError),
    Effect.flatMap((rows) => firstRecord(rows)),
  )

// Only a pending ask can be cancelled
export const claimCancel = (
  sql: SqlClient.SqlClient,
  askId: string,
): Effect.Effect<AskRecord | undefined, StoreError> =>
  sql`UPDATE asks SET status = 'cancelled' WHERE id = ${askId} AND status = 'pending' RETURNING *`.pipe(
    Effect.mapError(toStoreError),
    Effect.flatMap((rows) => firstRecord(rows)),
  )
```
`packages/kernel/src/asks/ask-events.ts`:
```ts
import type { AnsweredVia, Ask, AskAnswer, AskRecord } from '@bytebureau/protocol'
import { Effect } from 'effect'
import type { StoreError } from '../errors.js'
import type { EventLogShape } from '../events/event-log.js'

// How an ask got its answer; a fallback means the timeout of the policy produced it
export interface Settlement {
  readonly answer: AskAnswer
  readonly via: AnsweredVia
  readonly fallback?: string | undefined
}

// The ids that tie an event to its ask; the turn is left out when the ask has none
const idsOf = (ask: Ask): { readonly sessionId: string; readonly turnId?: string } => ({
  sessionId: ask.sessionId,
  ...(ask.turnId === null ? {} : { turnId: ask.turnId }),
})

export const announceRequest = (log: EventLogShape, ask: Ask): Effect.Effect<void, StoreError> =>
  Effect.asVoid(log.publish({ type: 'ask.requested', ...idsOf(ask), payload: { ask } }))

// A timeout is announced as the expiry with its fallback, then as the answer it produced
export const announceAnswer = (
  log: EventLogShape,
  ask: AskRecord,
  { answer, via, fallback }: Settlement,
): Effect.Effect<void, StoreError> =>
  Effect.gen(function* announcesAnswer() {
    if (fallback !== undefined) {
      yield* log.publish({
        type: 'ask.expired',
        ...idsOf(ask),
        payload: { askId: ask.id, fallback },
      })
    }
    yield* log.publish({
      type: 'ask.answered',
      ...idsOf(ask),
      payload: { askId: ask.id, answer, answeredVia: via },
    })
  })

export const announceCancel = (
  log: EventLogShape,
  ask: AskRecord,
): Effect.Effect<void, StoreError> =>
  Effect.asVoid(log.publish({ type: 'ask.cancelled', ...idsOf(ask), payload: { askId: ask.id } }))
```
`packages/kernel/src/asks/ask-settle.ts`:
```ts
import type { Ask, AskAnswer, AskRecord } from '@bytebureau/protocol'
import { Effect, Exit } from 'effect'
import type { SqlClient } from 'effect/sql'
import { AskError, type StoreError } from '../errors.js'
import type { EventLogShape } from '../events/event-log.js'
import { nowIso } from '../ids.js'
import { timeoutAnswer } from './ask-build.js'
import { announceAnswer, announceCancel, type Settlement } from './ask-events.js'
import { claimAnswer, claimCancel, loadAsk } from './ask-records.js'
import { wake, type Waiters } from './ask-waiters.js'

// What a waiter learns when its ask is cancelled
const cancelled = (askId: string): Exit.Exit<never, AskError> =>
  Exit.fail(new AskError({ code: 'not_pending', reason: `ask ${askId} is cancelled` }))

export interface AskDeps {
  readonly sql: SqlClient.SqlClient
  readonly log: EventLogShape
  readonly waiters: Waiters
}

// The waiter is woken after the announcement, so whoever waits finds the answer in the log, and even when the announcement fails
const deliver = (
  deps: AskDeps,
  record: AskRecord,
  settlement: Settlement,
): Effect.Effect<void, StoreError> => {
  const outcome = Exit.succeed(settlement.answer)
  return announceAnswer(deps.log, record, settlement).pipe(
    Effect.ensuring(wake(deps.waiters, record.id, outcome)),
  )
}

// The first claim of a pending ask wins and returns the answered record, any later one returns nothing
// Nothing may interrupt the steps after the claim: an answer that is stored must also arrive
// The time is read when the effect runs, not when it is built, because the timer builds it long before
const settle = (
  deps: AskDeps,
  askId: string,
  settlement: Settlement,
): Effect.Effect<AskRecord | undefined, StoreError> =>
  Effect.gen(function* settlesAsk() {
    const claim = { answer: settlement.answer, via: settlement.via, answeredAt: nowIso() }
    const record = yield* claimAnswer(deps.sql, askId, claim)
    if (record !== undefined) {
      yield* deliver(deps, record, settlement)
    }
    return record
  }).pipe(Effect.uninterruptible)

// The timer's turn: the policy answers unless somebody was quicker
export const expire = (deps: AskDeps, ask: Ask): Effect.Effect<void, StoreError> =>
  Effect.asVoid(
    settle(deps, ask.id, {
      answer: timeoutAnswer(ask),
      via: 'timeout',
      fallback: ask.policy.onTimeout,
    }),
  )

// An ask that cannot be answered is told apart: one that never existed, or one that is not pending any more
const refusalOf = (askId: string, record: AskRecord | undefined): AskError =>
  record === undefined
    ? new AskError({ code: 'not_found', reason: `ask ${askId} does not exist` })
    : new AskError({ code: 'not_pending', reason: `ask ${askId} is ${record.status}` })

// An answer picks options the ask offers, or words of its own where a question allows them
const invalidity = (ask: Ask, answer: AskAnswer): string | undefined => {
  if (answer.selected === 'other') {
    const open = ask.questions.some((question) => question.allowOther)
    return open ? undefined : `ask ${ask.id} takes no answer of its own`
  }
  const offered = new Set(
    ask.questions.flatMap((question) => question.options.map((option) => option.id)),
  )
  const unknown = answer.selected.filter((id) => !offered.has(id))
  return unknown.length === 0 ? undefined : `ask ${ask.id} has no option ${unknown.join(', ')}`
}

// The ask is read first, so a refusal or an answer that does not fit changes nothing; the claim still decides a race
export const answerAsk = (
  deps: AskDeps,
  askId: string,
  settlement: Settlement,
): Effect.Effect<AskRecord, AskError | StoreError> =>
  Effect.gen(function* answersAsk() {
    const current = yield* loadAsk(deps.sql, askId)
    if (current === undefined || current.status !== 'pending') {
      return yield* refusalOf(askId, current)
    }
    const invalid = invalidity(current, settlement.answer)
    if (invalid !== undefined) {
      return yield* new AskError({ code: 'invalid_answer', reason: invalid })
    }
    const record = yield* settle(deps, askId, settlement)
    return record ?? (yield* refusalOf(askId, yield* loadAsk(deps.sql, askId)))
  })

// Cancelling an ask that is not pending does nothing; a waiter fails with the cancellation, even when it cannot be announced
export const cancelAsk = (deps: AskDeps, askId: string): Effect.Effect<void, StoreError> =>
  Effect.gen(function* cancelsAsk() {
    const record = yield* claimCancel(deps.sql, askId)
    if (record === undefined) {
      return
    }
    const outcome = cancelled(askId)
    yield* announceCancel(deps.log, record).pipe(
      Effect.ensuring(wake(deps.waiters, askId, outcome)),
    )
  }).pipe(Effect.uninterruptible)

// An ask whose request could not be announced was offered to nobody: it is cancelled without an event and its waiter fails
export const withdrawAsk = (deps: AskDeps, askId: string): Effect.Effect<void, StoreError> => {
  const outcome = cancelled(askId)
  return claimCancel(deps.sql, askId).pipe(
    Effect.ensuring(wake(deps.waiters, askId, outcome)),
    Effect.asVoid,
  )
}
```
`packages/kernel/src/asks/ask-waiters.ts`:
```ts
import type { AskAnswer } from '@bytebureau/protocol'
import { Deferred, Effect, Exit } from 'effect'
import { AskError } from '../errors.js'

// What a caller of await waits on; an entry stays after its ask is settled, so a late caller still gets the outcome
export type Waiters = Map<string, Deferred.Deferred<AskAnswer, AskError>>

export const park = (waiters: Waiters, askId: string): Effect.Effect<void> =>
  Effect.map(Deferred.make<AskAnswer, AskError>(), (waiter) => {
    waiters.set(askId, waiter)
  })

export const wake = (
  waiters: Waiters,
  askId: string,
  outcome: Exit.Exit<AskAnswer, AskError>,
): Effect.Effect<void> => {
  const waiter = waiters.get(askId)
  return waiter === undefined ? Effect.void : Effect.asVoid(Deferred.done(waiter, outcome))
}

// The registry is read when the wait runs, not when it is built, so a wait can be built before its ask exists or run again
export const awaitAnswer = (waiters: Waiters, askId: string): Effect.Effect<AskAnswer, AskError> =>
  Effect.suspend(() => {
    const waiter = waiters.get(askId)
    return waiter === undefined
      ? Effect.fail(
          new AskError({
            code: 'not_found',
            reason: `ask ${askId} was not opened by this process`,
          }),
        )
      : Deferred.await(waiter)
  })

// Nobody can answer an ask once the service is closed, so whoever still waits is told; a waiter that is done keeps its outcome
export const closeWaiters = (waiters: Waiters): Effect.Effect<void> => {
  const closed = Exit.fail(new AskError({ code: 'not_pending', reason: 'service closed' }))
  return Effect.forEach([...waiters.values()], (waiter) => Deferred.done(waiter, closed), {
    discard: true,
  })
}
```
`packages/kernel/src/asks/ask-open.ts`:
```ts
import type { Ask, AskRecord } from '@bytebureau/protocol'
import { Cause, Effect, Fiber, Latch, type Scope } from 'effect'
import type { StoreError } from '../errors.js'
import { kernelLogger } from '../logging/logging.js'
import { buildAsk, timeoutMs, unrecommendedQuestions, type OpenAskInput } from './ask-build.js'
import { announceRequest } from './ask-events.js'
import { insertAsk } from './ask-records.js'
import { expire, withdrawAsk, type AskDeps } from './ask-settle.js'
import { park } from './ask-waiters.js'

// The timers belong to the scope of the layer, so they outlive the fiber of whoever opens an ask
export interface OpenDeps extends AskDeps {
  readonly scope: Scope.Scope
}

const logger = kernelLogger(['bb', 'asks'])

// The title and the input of the tool stay out of the log: either can carry a credential
const warnWithoutRecommendation = (ask: Ask): void => {
  if (ask.recommendationSource === 'none') {
    logger.warn('no recommendation available', {
      sessionId: ask.sessionId,
      kind: ask.kind,
      ...(ask.toolCall === undefined ? {} : { toolName: ask.toolCall.name }),
      questions: unrecommendedQuestions(ask),
    })
  }
}

// An expiry that fails leaves the ask pending, so the failure is told and never swallowed
const reportExpiry =
  (ask: Ask) =>
  (error: StoreError): Effect.Effect<void> =>
    Effect.sync(() => {
      logger.error('an ask could not be expired', {
        askId: ask.id,
        sessionId: ask.sessionId,
        cause: error.cause,
      })
    })

// An ask that waits has no timer; any other one is expired by its policy once the timeout is over, but not before its request is announced
// The result stops the timer; an ask that waits has none to stop
export const armTimer = (
  deps: OpenDeps,
  ask: Ask,
  announced: Latch.Latch,
): Effect.Effect<Effect.Effect<void>> => {
  const delay = timeoutMs(ask.policy)
  if (delay === null) {
    return Effect.succeed(Effect.void)
  }
  const expiry = Effect.sleep(delay).pipe(
    Effect.andThen(announced.await),
    Effect.andThen(expire(deps, ask)),
  )
  const guarded = expiry.pipe(Effect.catchTag('StoreError', reportExpiry(ask)))
  return Effect.map(Effect.forkIn(guarded, deps.scope), (timer) => Fiber.interrupt(timer))
}

// Taking back an ask that was never announced is best effort; a failure of it is told, the caller still gets the first one
const withdraw = (deps: OpenDeps, ask: Ask, disarm: Effect.Effect<void>): Effect.Effect<void> =>
  Effect.andThen(disarm, withdrawAsk(deps, ask.id)).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        logger.error('an ask that was not announced could not be withdrawn', {
          askId: ask.id,
          sessionId: ask.sessionId,
          cause: Cause.pretty(cause),
        })
      }),
    ),
  )

// The timer is armed before the request is announced; when the announcement fails or dies there is no pending ask left behind
// The ask is cancelled and its timer stopped, and the caller gets the failure, or the defect, of the announcement
export const announce = (
  deps: OpenDeps,
  ask: Ask,
  disarm: Effect.Effect<void>,
): Effect.Effect<void, StoreError> =>
  Effect.suspend(() => announceRequest(deps.log, ask)).pipe(
    Effect.onError(() => withdraw(deps, ask, disarm)),
  )

// The waiter is parked before anything is announced, so an answer that comes at once has someone to reach
// Nothing may interrupt the steps from the insert on: an ask is announced with its timer armed, or it is not left behind
export const openAsk = (
  deps: OpenDeps,
  input: OpenAskInput,
): Effect.Effect<AskRecord, StoreError> =>
  Effect.gen(function* opensAsk() {
    const ask = buildAsk(input)
    warnWithoutRecommendation(ask)
    yield* insertAsk(deps.sql, ask)
    yield* park(deps.waiters, ask.id)
    const announced = yield* Latch.make()
    const disarm = yield* armTimer(deps, ask, announced)
    yield* announce(deps, ask, disarm)
    yield* announced.open
    return { ...ask, answer: null, answeredAt: null, answeredVia: null }
  }).pipe(Effect.uninterruptible)
```
`packages/kernel/src/asks/ask-service.ts`:
```ts
import type { AnsweredVia, AskAnswer, AskRecord } from '@bytebureau/protocol'
import { Context, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import type { AskError, StoreError } from '../errors.js'
import { EventLog } from '../events/event-log.js'
import type { OpenAskInput } from './ask-build.js'
import { openAsk, type OpenDeps } from './ask-open.js'
import { listPending } from './ask-records.js'
import { answerAsk, cancelAsk } from './ask-settle.js'
import { awaitAnswer, closeWaiters } from './ask-waiters.js'

export type { OpenAskInput } from './ask-build.js'
export { DENY_ON_TIMEOUT_MESSAGE } from './ask-build.js'

export interface AskServiceShape {
  readonly open: (input: OpenAskInput) => Effect.Effect<AskRecord, StoreError>
  readonly answer: (
    askId: string,
    answer: AskAnswer,
    via: AnsweredVia,
  ) => Effect.Effect<AskRecord, AskError | StoreError>
  readonly cancel: (askId: string) => Effect.Effect<void, StoreError>
  readonly pending: (sessionId?: string) => Effect.Effect<readonly AskRecord[], StoreError>
  readonly await: (askId: string) => Effect.Effect<AskAnswer, AskError>
}

export class AskService extends Context.Service<AskService, AskServiceShape>()('bb/AskService') {}

const make = Effect.gen(function* makeAskService() {
  const sql = yield* SqlClient.SqlClient
  const log = yield* EventLog
  const scope = yield* Effect.scope
  const deps: OpenDeps = { sql, log, scope, waiters: new Map() }
  yield* Effect.addFinalizer(() => closeWaiters(deps.waiters))
  return AskService.of({
    open: (input) => openAsk(deps, input),
    answer: (askId, answer, via) => answerAsk(deps, askId, { answer, via }),
    cancel: (askId) => cancelAsk(deps, askId),
    pending: (sessionId) => listPending(sql, sessionId),
    await: (askId) => awaitAnswer(deps.waiters, askId),
  })
})

export const AskServiceLive: Layer.Layer<AskService, never, SqlClient.SqlClient | EventLog> =
  Layer.effect(AskService, make)
```
The timer uses `Effect.sleep`, so `TestClock.adjust` drives it in tests; it is forked into the layer scope (`Effect.forkIn`), never as a child of the `open` caller. Verified in Effect 4.0.0: `Deferred.make/succeed/fail/await` (`await` exported as `_await as await`); `asks.turn_id` is a foreign key, so the permission test seeds a `turns` row.

Add to `index.ts`: `export { AskService, AskServiceLive, DENY_ON_TIMEOUT_MESSAGE, type OpenAskInput, type AskServiceShape } from './asks/ask-service.js'`, `export { recommendForPermission, parseDuration } from './asks/policy.js'`.

- [ ] **Step 3: Run, commit**

Run: `bunx vitest run --project kernel` → PASS. `bun run check` → green.

```bash
git add packages/kernel
git commit -m "feat(kernel): broker questions and permissions with recommended options and timeout policy"
```

### Task 13: Sessions — state machine, `SessionManager`, `UsageService`, the fake agent provider

**Files:**
- Create (as shipped — the lint caps split the brief's session manager into cohesive modules under `packages/kernel/src/sessions/`, listed by group; the repository is the source of truth for the ones not embedded below): `state-machine.ts`, `types.ts`, `translate.ts`, `session-manager.ts` (the service and layer); records and decoders `session-records.ts`, `session-shape.ts`; status moves `session-status.ts`; turns and tools `session-turns.ts`, `session-tools.ts`; the ask path `session-ask.ts`; provider connection and pump `session-connect.ts`, `session-start.ts`, `session-provider.ts`, `session-pump.ts`, `session-agent.ts`, `live-sessions.ts`, `session-live.ts`; event handling `session-apply-event.ts`, `session-event-handlers.ts`, `session-events.ts`, `session-announce.ts`; lifecycle `session-create.ts`, `session-new.ts`, `session-project.ts`, `session-prompt.ts`, `session-send.ts`, `session-end.ts`, `session-interrupt.ts`, `employee-of.ts`; composition `session-deps.ts`, `session-collect.ts`, `session-logger.ts`; test support `session-layer-fixtures.ts` (the session test layer over Task 14's `KernelTest`, with the `SessionServices` type) and `session-helper-fixtures.ts`; `packages/kernel/src/usage/usage-service.ts`; the fake provider `packages/kernel/src/testing/{fake-agent-provider,fake-agent-session,fake-agent-plugin,fake-ask,event-queue,scripted-provider,repo-config}.ts`; fixtures `session-*-fixtures.ts`; tests `state-machine`, `translate`, `employee-of`, `session-records`, `session-turns`, `session-events`, `session-create`, `session-lifecycle`, `session-manager`, `session-provider`, `session-agent-asks`, `session-agent-gone`, `session-failures`, `session-concurrency`, `session-gate`, `session-timeouts`, `session-start-timeout`, `session-reporting`, `session-worktree`, `live-sessions`, `fake-agent-provider`, `usage-service`
- Modify: `packages/kernel/src/plugins/bundled.ts` (`BUNDLED_PLUGINS = [localWorkspacePlugin, fakeAgentPlugin]`), `packages/kernel/src/index.ts`, `packages/kernel/package.json` (devDependency `fast-check` 4.10.2)

**Interfaces:**
- Consumes: everything from Tasks 1–12; `fast-check` (root devDependency) for the model-based transition test.
- Produces: `transition(status: SessionStatus, event: SessionEvent): SessionStatus | null` with `SessionEvent = 'provision' | 'provisioned' | 'prompt' | 'ask' | 'answer' | 'turn_done' | 'rate_limit' | 'limit_reset' | 'stop' | 'crash' | 'complete' | 'resume'`; `Session { id; projectId; title; employee: EmployeeSpec; providerId; profileId: string | null; workspace: WorkspaceHandle | null; externalRef: ExternalSessionRef | null; status; createdAt; startedAt; endedAt }`, `Turn { id; sessionId; index; prompt: PromptInput; status; stopReason; usage: Usage | null; startedAt; endedAt }`; `SessionManager` service `{ create(input: CreateSessionInput): Effect<Session, SessionError | WorkspaceError | ConfigError | StoreError>; prompt(sessionId, input): Effect<Turn, SessionError | ProviderError | StoreError>; interrupt(sessionId): Effect<void, SessionError>; stop(sessionId): Effect<void, SessionError | StoreError>; complete(sessionId): Effect<void, SessionError | StoreError>; resume(sessionId): Effect<Session, SessionError | StoreError>; list(): Effect<readonly Session[], StoreError>; get(id): Effect<Session | undefined, StoreError> }`, `SessionManagerLive`, `CreateSessionInput { projectId; title; employeeId?; providerId?; profileId?; branch? }`; `UsageService` `{ sessionUsage(sessionId): Effect<SessionUsage, StoreError>; record(profileId: string | null, rateLimit: RateLimit): Effect<void, StoreError>; snapshot(profileId): Effect<UsageSnapshot | undefined, StoreError> }`, `SessionUsage { turns; inputTokens; outputTokens; costUsd: number | null; contextPct: number | null }`; `FakeAgentProvider` (`id: 'fake'`), `fakeAgentPlugin` (bundled, name `agent-fake`), scripts `hello` (default) and `slow` chosen by `BYTEBUREAU_FAKE_SCRIPT` in the session environment.

Semantics (as shipped): the state machine table is the brief's, and the final fix wave adds `stop` and `crash` from `created`, so a session that dies before provisioning can be ended; `create` resolves the employee, the base branch and the workspace runtime from `Config.load({ projectPath, env })` with the kernel's environment (`KernelLayerOptions.env`), so `BYTEBUREAU_EMPLOYEE`, `BYTEBUREAU_BRANCH` and `BYTEBUREAU_WORKSPACE_RUNTIME` reach `run` and an edited project file counts, while the caller's `employeeId` and `branch` still win and the registry's snapshot stays the record of the registration (the base branch is the caller's, else `defaults.branch`, else the file's `project.defaultBranch`, else the one detected at registration); `create` refuses an unknown provider, a missing runtime and `yolo` on an `isolation: 'none'` runtime before any row or worktree exists, then publishes `session.created`, `session.provisioning`, (`workspace.provisioned`), `session.ready`; status moves are compare-and-set under a per-session lock; the ask path opens the ask with the session's real workspace path, publishes `session.waiting`, releases the lock while the pump waits for the answer, forwards the answer to the agent and publishes `session.running`; `turn.completed` ends the turn once, publishes `turn.completed` then `session.ready` and unlocks the worktree; `stop` publishes `turn.interrupted`, cancels pending asks and publishes `session.stopped`, keeping the worktree; `complete` also cancels pending asks; an agent refusing a prompt or answer, a `session.error`, or an event stream that ends or fails while the session is running crashes the session (`errored`), while a stream that ends during `complete`/`stop` does not; provider calls other than the prompt are bounded (10 s; 60 s for `createSession`, whose timeout aborts the controller and closes a late result); an `ask.requested` that arrives after `interrupt` is recorded and cancelled at once when the provider declares `capabilities.interrupt` and its `interrupt()` succeeded (otherwise the turn goes on and its questions count); the extra session environment keeps only `BYTEBUREAU_*` names (`BYTEBUREAU_SESSION_ID` last) on top of the daemon's allowlisted environment, which the provider's `providers.<id>.passEnv` names widen; the environment entry of a session goes when it stops, completes or crashes (a resumed session starts its agent without it, as after a restart) and a lock entry exists only while somebody holds or waits for it; pumps run in the manager's own scope, closed after the agents, which close concurrently (3 s bound; giving up on a pump is warned about; `CALL_LIMIT`, `PUMP_LIMIT` and `START_LIMIT` are exported for the tests) with the pump interruption in `release` bounded too, because `Stream.fromAsyncIterable` waits for the iterator's `return()`; `externalRef` is persisted and handed back on resume; the employee prompt file is confined to the project (`realpath`), and a missing built-in default prompt file (`.bytebureau/employees/developer.md`) is no warning while a configured one is; every session event carries `projectId`; `ratelimit.updated` carries the session's profile; `UsageService.contextPct` is the latest reported value. Not wired in Phase A: the `rate_limit`/`limit_reset` transitions, hooks other than `prompt.beforeSend`, and profile variables in the agent environment (profiles arrive in Phase C; `providers.<id>.passEnv` is the only extra source until then).

- [ ] **Step 1: Failing tests**

`packages/kernel/src/sessions/state-machine.test.ts` (model-based, spec §15):
```ts
import { ok, strictEqual } from 'node:assert/strict'
import { SessionStatus } from '@bytebureau/protocol'
import { assert, commands, constant, modelRun, property, type Command } from 'fast-check'
import { describe, expect, it } from 'vitest'
import { SESSION_EVENTS, transition, type SessionEvent } from './state-machine.js'

const TERMINAL = new Set<SessionStatus>(['completed'])
const KNOWN = new Set<string>(SessionStatus.literals)

interface Tracked {
  status: SessionStatus
}

// One event offered to the machine; the model and the real status must agree on what it does
class Step implements Command<Tracked, Tracked> {
  public readonly event: SessionEvent

  public constructor(event: SessionEvent) {
    this.event = event
  }

  public check(): boolean {
    return SESSION_EVENTS.includes(this.event)
  }

  public run(model: Tracked, real: Tracked): void {
    const next = transition(real.status, this.event)
    if (next === null) {
      strictEqual(real.status, model.status)
      return
    }
    ok(!TERMINAL.has(model.status), `${model.status} must not be left`)
    ok(KNOWN.has(next), `${next} is not a status`)
    model.status = next
    real.status = next
  }

  public toString(): string {
    return this.event
  }
}

const start = (): { model: Tracked; real: Tracked } => ({
  model: { status: 'created' },
  real: { status: 'created' },
})

type Edge = readonly [SessionStatus, SessionEvent, SessionStatus]

const EDGES: readonly Edge[] = [
  ['created', 'provision', 'provisioning'],
  ['provisioning', 'provisioned', 'ready'],
  ['ready', 'prompt', 'running'],
  ['running', 'ask', 'waiting_for_human'],
  ['waiting_for_human', 'answer', 'running'],
  ['running', 'turn_done', 'ready'],
  ['waiting_for_human', 'turn_done', 'ready'],
  ['running', 'rate_limit', 'paused_usage_limit'],
  ['paused_usage_limit', 'limit_reset', 'running'],
  ['running', 'stop', 'stopped'],
  ['ready', 'stop', 'stopped'],
  ['waiting_for_human', 'stop', 'stopped'],
  ['paused_usage_limit', 'stop', 'stopped'],
  ['provisioning', 'stop', 'stopped'],
  ['created', 'stop', 'stopped'],
  ['created', 'crash', 'errored'],
  ['running', 'crash', 'errored'],
  ['waiting_for_human', 'crash', 'errored'],
  ['provisioning', 'crash', 'errored'],
  ['ready', 'complete', 'completed'],
  ['stopped', 'resume', 'ready'],
  ['errored', 'resume', 'ready'],
]

const REFUSED: readonly (readonly [SessionStatus, SessionEvent])[] = [
  ['completed', 'prompt'],
  ['created', 'prompt'],
  ['ready', 'answer'],
  ['running', 'complete'],
  ['errored', 'stop'],
  ['stopped', 'prompt'],
  ['ready', 'crash'],
]

describe(transition, () => {
  it.each(EDGES)('moves a %s session on %s to %s', (from, event, to) => {
    expect(transition(from, event)).toBe(to)
  })

  it.each(REFUSED)('refuses %s on %s', (status, event) => {
    expect(transition(status, event)).toBeNull()
  })

  it('refuses every event once a session is completed', () => {
    expect(SESSION_EVENTS.map((event) => transition('completed', event))).toStrictEqual(
      SESSION_EVENTS.map(() => null),
    )
  })

  it('never leaves a terminal state and only produces known statuses (model-based)', () => {
    const steps = SESSION_EVENTS.map((event) => constant(new Step(event)))
    const sequences = property(commands(steps, { maxCommands: 40 }), (all) => {
      modelRun(start, all)
    })
    expect(() => {
      assert(sequences, { numRuns: 300 })
    }).not.toThrow()
  })
})
```
`packages/kernel/src/usage/usage-service.test.ts`:
```ts
import { assert, it } from '@effect/vitest'
import { Effect, Layer, Result } from 'effect'
import { SqlClient } from 'effect/sql'
import { StoreError } from '../errors.js'
import { StoreTest } from '../store/store-test.js'
import { UsageService, UsageServiceLive } from './usage-service.js'

const TIME = 't'

// A session row, and the project it needs, so turns can point at it
const seedSession = (id: string): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* seedsSession() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO projects (id, name, path, default_branch, config_json, created_at, updated_at) VALUES ('p', 'p', '/p', 'main', '{}', ${TIME}, ${TIME}) ON CONFLICT DO NOTHING`
    yield* sql`INSERT INTO sessions (id, project_id, title, employee_json, provider_id, workspace_json, status, created_at) VALUES (${id}, 'p', 't', '{}', 'fake', '{}', 'ready', ${TIME})`
  })

// A turn of a seeded session; null stands for a turn that has reported no usage yet
const seedTurn = (
  sessionId: string,
  index: number,
  usage: string | null,
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* seedsTurn() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO turns (id, session_id, idx, prompt_json, status, usage_json, started_at) VALUES (${`${sessionId}-${index}`}, ${sessionId}, ${index}, '{}', 'completed', ${usage}, ${TIME})`
  })

const FIRST = '{"inputTokens":10,"outputTokens":4,"costUsd":0.01,"contextPct":12}'
const SECOND = '{"inputTokens":5,"outputTokens":1}'
const NOTHING = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: null, contextPct: null }

const Layers = UsageServiceLive.pipe(Layer.provideMerge(StoreTest))

it.layer(Layers)('UsageService', (suite) => {
  suite.effect(
    'sums turn usage per session and keeps the latest rate-limit snapshot per profile',
    () =>
      Effect.gen(function* summing() {
        yield* seedSession('s')
        yield* seedTurn('s', 0, FIRST)
        yield* seedTurn('s', 1, SECOND)
        const usage = yield* UsageService
        assert.deepStrictEqual(yield* usage.sessionUsage('s'), {
          turns: 2,
          inputTokens: 15,
          outputTokens: 5,
          costUsd: 0.01,
          contextPct: 12,
        })
        yield* usage.record('prof', { fiveHourPct: 40 })
        yield* usage.record('prof', { fiveHourPct: 55, sevenDayPct: 10 })
        const snapshot = yield* usage.snapshot('prof')
        assert.ok(snapshot !== undefined)
        assert.deepStrictEqual(snapshot.rateLimit, { fiveHourPct: 55, sevenDayPct: 10 })
      }),
  )

  suite.effect('reports no cost and no context for a session without turns', () =>
    Effect.gen(function* reportsNothing() {
      yield* seedSession('empty')
      const usage = yield* UsageService
      assert.deepStrictEqual(yield* usage.sessionUsage('empty'), NOTHING)
    }),
  )
})

it.layer(Layers)('UsageService turns', (suite) => {
  suite.effect('counts a turn that has no usage yet and leaves other sessions out', () =>
    Effect.gen(function* countsTurns() {
      yield* seedSession('mine')
      yield* seedSession('other')
      yield* seedTurn('mine', 0, SECOND)
      yield* seedTurn('mine', 1, null)
      yield* seedTurn('other', 0, FIRST)
      const usage = yield* UsageService
      assert.deepStrictEqual(yield* usage.sessionUsage('mine'), {
        ...NOTHING,
        turns: 2,
        inputTokens: 5,
        outputTokens: 1,
      })
    }),
  )

  suite.effect('takes the context percentage of the latest turn that reported one', () =>
    Effect.gen(function* takesLatestContext() {
      yield* seedSession('context')
      yield* seedTurn('context', 0, '{"inputTokens":1,"outputTokens":1,"contextPct":10}')
      yield* seedTurn('context', 1, '{"inputTokens":1,"outputTokens":1,"contextPct":35}')
      yield* seedTurn('context', 2, SECOND)
      const usage = yield* UsageService
      assert.strictEqual((yield* usage.sessionUsage('context')).contextPct, 35)
    }),
  )

  suite.effect('fails with a store error for a turn whose usage cannot be read', () =>
    Effect.gen(function* failsOnCorruption() {
      yield* seedSession('corrupt')
      yield* seedTurn('corrupt', 0, '{"inputTokens":"many"}')
      const usage = yield* UsageService
      const outcome = yield* Effect.result(usage.sessionUsage('corrupt'))
      assert.ok(Result.isFailure(outcome))
      assert.ok(outcome.failure instanceof StoreError)
    }),
  )
})

it.layer(Layers)('UsageService rate limits', (suite) => {
  suite.effect('keeps every field of a rate limit and files a missing profile as default', () =>
    Effect.gen(function* keepsRateLimit() {
      const usage = yield* UsageService
      const full = {
        fiveHourPct: 80,
        fiveHourResetsAt: '2026-10-03T12:00:00.000Z',
        sevenDayPct: 20,
        sevenDayResetsAt: '2026-10-09T00:00:00.000Z',
      }
      yield* usage.record(null, full)
      const snapshot = yield* usage.snapshot('default')
      assert.ok(snapshot !== undefined)
      assert.strictEqual(snapshot.profileId, 'default')
      assert.deepStrictEqual(snapshot.rateLimit, full)
      assert.match(snapshot.observedAt, /^\d{4}-\d{2}-\d{2}T/u)
    }),
  )

  suite.effect('has no snapshot for a profile that never reported', () =>
    Effect.gen(function* hasNone() {
      const usage = yield* UsageService
      assert.strictEqual(yield* usage.snapshot('nobody'), undefined)
    }),
  )
})
```
`packages/kernel/src/sessions/session-manager.test.ts`:
```ts
import { existsSync } from 'node:fs'
import path from 'node:path'
import { assert, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { SessionError } from '../errors.js'
import { SessionManager } from './session-manager.js'
import { answerPending, collectUntilCompleted } from './session-ask-fixtures.js'
import { registerRepo, sessionOf, startSession, typesOf, waitFor } from './session-fixtures.js'
import { helloFileOf, workspaceOf } from './session-helper-fixtures.js'
import { sessionLayer } from './session-layer-fixtures.js'

const PROMPT = 'Create src/hello.ts exporting hello()\r\nwith čeština and an emoji 🚀'
const SLOW = { BYTEBUREAU_FAKE_SCRIPT: 'slow' }

// Everything a session publishes from creation to completion, in order; the ephemeral deltas are not part of it
const EXPECTED_TYPES = [
  'session.created',
  'session.provisioning',
  'workspace.provisioned',
  'session.ready',
  'session.running',
  'message.user',
  'turn.started',
  'tool.started',
  'ask.requested',
  'session.waiting',
  'ask.answered',
  'session.running',
  'tool.completed',
  'message.assistant.completed',
  'usage.updated',
  'turn.completed',
  'session.ready',
  'session.completed',
]

const COWBOY = {
  version: 1,
  project: { name: 'yolo-test' },
  employees: {
    cowboy: { name: 'Cowboy', provider: 'fake', model: 'm', permissionMode: 'yolo' },
  },
}

// The ephemeral events carry seq 0; the persisted ones must follow one another
const persistedSequence = (events: readonly { readonly seq: number }[]): number[] =>
  events.map((event) => event.seq).filter((seq) => seq !== 0)

const isAscending = (values: readonly number[]): boolean =>
  values.every((value, index) => index === 0 || value > (values[index - 1] ?? 0))

// A prompt through the fake provider, the question answered as recommended, the session completed
const runWholeSession = Effect.gen(function* runsWholeSession() {
  const sessions = yield* SessionManager
  const session = yield* startSession()
  const collected = yield* collectUntilCompleted(session.id)
  const turn = yield* sessions.prompt(session.id, { text: PROMPT })
  const ask = yield* answerPending(session.id, ['yes'])
  yield* waitFor(session.id, 'session.ready', 1)
  yield* sessions.complete(session.id)
  return { session, turn, ask, events: yield* Fiber.join(collected) }
})

it.layer(sessionLayer())('SessionManager', (suite) => {
  suite.effect('creates a session in a worktree and announces each step', () =>
    Effect.gen(function* createsSession() {
      const session = yield* startSession()
      assert.strictEqual(session.status, 'ready')
      assert.ok(existsSync(workspaceOf(session)))
      assert.deepStrictEqual(yield* typesOf(session.id), [
        'session.created',
        'session.provisioning',
        'workspace.provisioned',
        'session.ready',
      ])
    }),
  )

  suite.effect(
    'runs a prompt through the fake provider: worktree, events, ask, file, usage, completion',
    () =>
      Effect.gen(function* runsPrompt() {
        const { session, turn, ask, events } = yield* runWholeSession
        assert.strictEqual(turn.index, 0)
        assert.strictEqual(
          ask.questions
            .flatMap((question) => question.options)
            .filter((option) => option.recommended).length,
          1,
        )
        const types = events.map((event) => event.type)
        assert.deepStrictEqual(
          types.filter((type) => type !== 'message.assistant.delta'),
          EXPECTED_TYPES,
        )
        assert.ok(isAscending(persistedSequence(events)))
        const user = events.find((event) => event.type === 'message.user')
        assert.deepStrictEqual(user === undefined ? null : user.payload, { text: PROMPT })
        assert.ok(existsSync(helloFileOf(session)))
      }),
  )
})

it.layer(sessionLayer())('SessionManager refusals', (suite) => {
  suite.effect('refuses yolo on the local runtime and unknown providers before provisioning', () =>
    Effect.gen(function* refusesYolo() {
      const project = yield* registerRepo(COWBOY)
      const sessions = yield* SessionManager
      const base = { projectId: project.id, title: 'x', employeeId: 'cowboy' }
      const yolo = yield* Effect.flip(sessions.create(base))
      assert.ok(yolo instanceof SessionError)
      assert.match(yolo.reason, /yolo.*local/u)
      const missing = yield* Effect.flip(sessions.create({ ...base, providerId: 'nope' }))
      assert.ok(missing instanceof SessionError && missing.code === 'provider_missing')
      assert.ok(!existsSync(path.join(project.path, '.bytebureau', 'worktrees')))
      assert.deepStrictEqual(yield* sessions.list(), [])
    }),
  )
})

it.layer(sessionLayer())('SessionManager stop and resume', (suite) => {
  suite.effect(
    'stop marks the running turn interrupted, keeps the worktree and resume returns to ready',
    () =>
      Effect.gen(function* stopsAndResumes() {
        const sessions = yield* SessionManager
        const session = yield* startSession({ env: SLOW })
        yield* sessions.prompt(session.id, { text: 'take your time' })
        yield* sessions.stop(session.id)
        assert.strictEqual((yield* sessionOf(session.id)).status, 'stopped')
        assert.ok(existsSync(workspaceOf(session)))
        const types = yield* typesOf(session.id)
        assert.deepStrictEqual(
          types.filter((type) => type === 'turn.interrupted' || type === 'session.stopped'),
          ['turn.interrupted', 'session.stopped'],
        )
        assert.strictEqual((yield* sessions.resume(session.id)).status, 'ready')
      }),
  )
})
```
The session tests run on a local layer (`sessions/session-layers.ts`) in this task; Task 14's `KernelTest` supersedes it and the tests switch imports. `CreateSessionInput` has an optional `env` (extra session environment, `BYTEBUREAU_*` names only) used by the tests and the CLI.

- [ ] **Step 2: State machine and types**

`packages/kernel/src/sessions/state-machine.ts`:
```ts
import type { SessionStatus } from '@bytebureau/protocol'

export const SESSION_EVENTS = [
  'provision',
  'provisioned',
  'prompt',
  'ask',
  'answer',
  'turn_done',
  'rate_limit',
  'limit_reset',
  'stop',
  'crash',
  'complete',
  'resume',
] as const
export type SessionEvent = (typeof SESSION_EVENTS)[number]

const EDGES: Readonly<
  Record<SessionEvent, Partial<Readonly<Record<SessionStatus, SessionStatus>>>>
> = {
  provision: { created: 'provisioning' },
  provisioned: { provisioning: 'ready' },
  prompt: { ready: 'running' },
  ask: { running: 'waiting_for_human' },
  answer: { waiting_for_human: 'running' },
  turn_done: { running: 'ready', waiting_for_human: 'ready' },
  rate_limit: { running: 'paused_usage_limit' },
  limit_reset: { paused_usage_limit: 'running' },
  stop: {
    created: 'stopped',
    ready: 'stopped',
    running: 'stopped',
    waiting_for_human: 'stopped',
    paused_usage_limit: 'stopped',
    provisioning: 'stopped',
  },
  // A session can die before it is provisioned, and be ended then
  crash: {
    created: 'errored',
    running: 'errored',
    waiting_for_human: 'errored',
    provisioning: 'errored',
  },
  complete: { ready: 'completed' },
  resume: { stopped: 'ready', errored: 'ready' },
}

// A null result means "not allowed from this status"; callers turn it into SessionError('invalid_transition')
export const transition = (status: SessionStatus, event: SessionEvent): SessionStatus | null =>
  EDGES[event][status] ?? null
```
`packages/kernel/src/sessions/types.ts`:
```ts
import type { ExternalSessionRef, WorkspaceHandle } from '@bytebureau/plugin-api'
import type {
  EmployeeSpec,
  PromptInput,
  SessionStatus,
  TurnStatus,
  Usage,
} from '@bytebureau/protocol'

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
  // Extra environment for the agent; only the BYTEBUREAU_* names are passed on, the rest is dropped
  readonly env?: Readonly<Record<string, string>> | undefined
}
```

- [ ] **Step 3: Usage service**

`packages/kernel/src/usage/usage-service.ts`:
```ts
import { Usage, type RateLimit } from '@bytebureau/protocol'
import { Context, Effect, Layer, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { StoreError, toStoreError } from '../errors.js'
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
  readonly sessionUsage: (sessionId: string) => Effect.Effect<SessionUsage, StoreError>
  readonly record: (
    profileId: string | null,
    rateLimit: RateLimit,
  ) => Effect.Effect<void, StoreError>
  readonly snapshot: (profileId: string) => Effect.Effect<UsageSnapshot | undefined, StoreError>
}

export class UsageService extends Context.Service<UsageService, UsageServiceShape>()(
  'bb/UsageService',
) {}

// Snapshots of a session that has no profile are filed under this one
const DEFAULT_PROFILE = 'default'

interface TurnRow {
  readonly usage_json: string | null
}

interface SnapshotRow {
  readonly five_hour_pct: number | null
  readonly five_hour_resets_at: string | null
  readonly seven_day_pct: number | null
  readonly seven_day_resets_at: string | null
  readonly observed_at: string
}

const decodeUsage = Schema.decodeUnknownEffect(Schema.fromJsonString(Usage))

// A usage record that does not fit the protocol is a failure of the store, not a defect
const unreadable = (cause: unknown): StoreError =>
  new StoreError({ cause: new Error('a usage record is unreadable', { cause }) })

const usageOf = (row: TurnRow): Effect.Effect<readonly Usage[], StoreError> =>
  row.usage_json === null
    ? Effect.succeed([])
    : decodeUsage(row.usage_json).pipe(
        Effect.map((usage) => [usage]),
        Effect.mapError(unreadable),
      )

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

// Costs and context percentages are optional on a turn: none reported is null, not zero
const totalsOf = (turns: number, usages: readonly Usage[]): SessionUsage => {
  const costs = usages.flatMap((usage) => (usage.costUsd === undefined ? [] : [usage.costUsd]))
  const contexts = usages.flatMap((usage) =>
    usage.contextPct === undefined ? [] : [usage.contextPct],
  )
  return {
    turns,
    inputTokens: sum(usages.map((usage) => usage.inputTokens)),
    outputTokens: sum(usages.map((usage) => usage.outputTokens)),
    costUsd: costs.length === 0 ? null : sum(costs),
    contextPct: contexts.at(-1) ?? null,
  }
}

const makeSessionUsage =
  (sql: SqlClient.SqlClient): UsageServiceShape['sessionUsage'] =>
  (sessionId) =>
    sql<TurnRow>`SELECT usage_json FROM turns WHERE session_id = ${sessionId} ORDER BY idx`.pipe(
      Effect.mapError(toStoreError),
      Effect.flatMap((rows) => Effect.all(rows.map((row) => usageOf(row)))),
      Effect.map((usages) => totalsOf(usages.length, usages.flat())),
    )

const makeRecord =
  (sql: SqlClient.SqlClient): UsageServiceShape['record'] =>
  (profileId, rateLimit) =>
    sql`
      INSERT INTO usage_snapshots (profile_id, five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at, source, observed_at)
      VALUES (${profileId ?? DEFAULT_PROFILE}, ${rateLimit.fiveHourPct ?? null}, ${rateLimit.fiveHourResetsAt ?? null}, ${rateLimit.sevenDayPct ?? null}, ${rateLimit.sevenDayResetsAt ?? null}, 'provider', ${nowIso()})`.pipe(
      Effect.asVoid,
      Effect.mapError(toStoreError),
    )

// A column that holds null is left out of the rate limit, as the protocol declares its keys optional
const rateLimitOf = (row: SnapshotRow): RateLimit => ({
  ...(row.five_hour_pct === null ? {} : { fiveHourPct: row.five_hour_pct }),
  ...(row.five_hour_resets_at === null ? {} : { fiveHourResetsAt: row.five_hour_resets_at }),
  ...(row.seven_day_pct === null ? {} : { sevenDayPct: row.seven_day_pct }),
  ...(row.seven_day_resets_at === null ? {} : { sevenDayResetsAt: row.seven_day_resets_at }),
})

// The newest row wins; the row id breaks a tie between two snapshots taken in the same millisecond
const makeSnapshot =
  (sql: SqlClient.SqlClient): UsageServiceShape['snapshot'] =>
  (profileId) =>
    sql<SnapshotRow>`
      SELECT five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at, observed_at
      FROM usage_snapshots WHERE profile_id = ${profileId} ORDER BY observed_at DESC, rowid DESC LIMIT 1`.pipe(
      Effect.mapError(toStoreError),
      Effect.map(([row]) =>
        row === undefined
          ? undefined
          : { profileId, rateLimit: rateLimitOf(row), observedAt: row.observed_at },
      ),
    )

const make = Effect.gen(function* makeUsageService() {
  const sql = yield* SqlClient.SqlClient
  return UsageService.of({
    sessionUsage: makeSessionUsage(sql),
    record: makeRecord(sql),
    snapshot: makeSnapshot(sql),
  })
})

export const UsageServiceLive: Layer.Layer<UsageService, never, SqlClient.SqlClient> = Layer.effect(
  UsageService,
  make,
)
```

- [ ] **Step 4: Fake agent provider and plugin**

`packages/kernel/src/testing/fake-agent-provider.ts`:
```ts
import type {
  AgentCapabilities,
  AgentProvider,
  AgentSession,
  AuthStatus,
  CreateSessionRequest,
} from '@bytebureau/plugin-api'
import { FakeSession, type Script } from './fake-agent-session.js'

const CAPABILITIES: AgentCapabilities = {
  resume: false,
  interrupt: true,
  askUser: true,
  permissions: false,
  structuredOutput: false,
  usage: true,
  rateLimits: false,
  contextUsage: true,
  thinking: false,
  setModel: false,
  setEffort: false,
  attachments: false,
}

// The session environment picks the script: BYTEBUREAU_FAKE_SCRIPT=slow, anything else is hello
const scriptOf = (request: CreateSessionRequest): Script =>
  request.env['BYTEBUREAU_FAKE_SCRIPT'] === 'slow' ? 'slow' : 'hello'

const loggedIn = async (): Promise<AuthStatus> => {
  const state = await Promise.resolve('loggedIn' as const)
  return { state }
}

const startSession = async (request: CreateSessionRequest): Promise<AgentSession> => {
  const session = await Promise.resolve(new FakeSession(request, scriptOf(request)))
  return session
}

// A provider that needs no agent subscription: the way to smoke-test an installation and the fixture of the tests
export class FakeAgentProvider implements AgentProvider {
  public readonly id = 'fake'
  public readonly displayName = 'Fake agent (tests and CI)'
  public readonly capabilities = CAPABILITIES
  public readonly authStatus = loggedIn
  public readonly createSession = startSession
}
```
`packages/kernel/src/testing/fake-agent-plugin.ts`:
```ts
import { definePlugin, type Plugin } from '@bytebureau/plugin-api'
import { FakeAgentProvider } from './fake-agent-provider.js'

export const fakeAgentPlugin: Plugin = definePlugin({
  manifest: {
    name: 'agent-fake',
    version: '0.0.0',
    displayName: 'Fake agent',
    hostApi: '^0',
    kind: 'in-process',
    contributes: { agentProviders: ['fake'] },
  },
  setup: () => ({ agentProviders: [new FakeAgentProvider()] }),
})
```
`packages/kernel/src/plugins/bundled.ts`: `BUNDLED_PLUGINS` becomes `[localWorkspacePlugin, fakeAgentPlugin]` (the fake provider ships in the binary on purpose: it is the documented way to smoke-test an installation without an agent subscription).

- [ ] **Step 5: Event translation and the session manager**

`packages/kernel/src/sessions/translate.ts`:
```ts
import type { AgentEvent, AgentEventType, KernelEvent } from '@bytebureau/protocol'

export interface TurnRef {
  readonly turnId: string
  readonly index: number
}

// What the kernel knows about the session around an event: how a tool call is named and which profile it runs under
export interface Lookups {
  readonly toolName: (toolId: string) => string
  readonly profileId: string | null
}

// What the events of a turn are told: the turn that is running, if any
interface Telling extends Lookups {
  readonly turn: TurnRef | null
}

type OfType<Type extends AgentEventType> = Extract<AgentEvent, { readonly type: Type }>
type Translator<Type extends AgentEventType> = (
  event: OfType<Type>,
  telling: Telling,
) => KernelEvent | null
type Translators = { readonly [Type in AgentEventType]: Translator<Type> }

const nothing = (): null => null

// The kernel events of the catalogue by the type of the provider event; null leaves an event out
const TRANSLATORS: Translators = {
  'turn.started': (_event, { turn }) =>
    turn === null ? null : { type: 'turn.started', payload: { ...turn, status: 'running' } },
  'message.delta': (event) => ({
    type: 'message.assistant.delta',
    payload: { kind: event.kind, text: event.text },
  }),
  'message.completed': (event) =>
    event.role === 'assistant'
      ? {
          type: 'message.assistant.completed',
          payload: { text: event.text, content: event.content },
        }
      : null,
  'tool.started': (event) => ({
    type: 'tool.started',
    payload: { id: event.id, name: event.name, kind: event.kind, input: event.input },
  }),
  'tool.completed': (event, { toolName }) => ({
    type: 'tool.completed',
    payload: {
      id: event.id,
      name: toolName(event.id),
      outputSummary: event.outputSummary,
      bytes: event.bytes,
    },
  }),
  'tool.failed': (event, { toolName }) => ({
    type: 'tool.failed',
    payload: { id: event.id, name: toolName(event.id), error: event.error },
  }),
  'subagent.started': (event) => ({
    type: 'subagent.started',
    payload: { id: event.id, name: event.name },
  }),
  'subagent.stopped': (event) => ({
    type: 'subagent.stopped',
    payload: { id: event.id, name: event.name },
  }),
  'ask.requested': nothing,
  'usage.updated': (event) => ({ type: 'usage.updated', payload: { usage: event.usage } }),
  'ratelimit.updated': (event, { profileId }) => ({
    type: 'ratelimit.updated',
    payload: { profileId, rateLimit: event.rateLimit },
  }),
  'compaction.started': () => ({ type: 'compaction.started', payload: {} }),
  'compaction.completed': () => ({ type: 'compaction.completed', payload: {} }),
  'turn.completed': nothing,
  'session.warning': (event) => ({
    type: 'session.warning',
    payload: { kind: event.kind, message: event.message },
  }),
  'session.error': nothing,
  'session.closed': nothing,
  raw: nothing,
}

// The lookup is generic in the type, which is what lets the compiler pair an event with its translator
const apply = <Type extends AgentEventType>(
  type: Type,
  event: OfType<Type>,
  telling: Telling,
): KernelEvent | null => TRANSLATORS[type](event, telling)

const UNKNOWN: Lookups = { toolName: () => '', profileId: null }

// Pure mapping provider → kernel catalogue
// Asks, the end of a turn and errors carry bookkeeping and are handled by the session manager
// A finished tool call carries the name that the caller noted when it started, empty when unknown
export function translate(
  event: AgentEvent,
  turn: TurnRef | null,
  lookups: Lookups = UNKNOWN,
): KernelEvent | null {
  return apply(event.type, event, { ...lookups, turn })
}
```
(`tool.completed`/`tool.failed` carry `name: ''` here; the SessionManager fills the name from its `tool_calls` bookkeeping before publishing.)

`packages/kernel/src/sessions/session-manager.ts`:
```ts
import { Context, Effect, Layer, type Scope } from 'effect'
import { LiveSessions } from './live-sessions.js'
import { collectDeps, type SessionRequirements } from './session-collect.js'
import type { KernelEnv, SessionDeps } from './session-deps.js'
import { makeCreate } from './session-create.js'
import { makeComplete, makeInterrupt, makeResume, makeStop } from './session-end.js'
import { dispose, releaseFibers } from './session-live.js'
import { makePrompt } from './session-prompt.js'
import { listSessions, loadSession } from './session-records.js'
import type { SessionManagerShape } from './session-shape.js'

export type { SessionManagerShape } from './session-shape.js'

export class SessionManager extends Context.Service<SessionManager, SessionManagerShape>()(
  'bb/SessionManager',
) {}

// Releasing the layer lets every provider session go, so no agent outlives the kernel
// The agents are closed together, each within its own bound, and before the pumps are interrupted: the events of an agent end when it closes, and a pump waits for them
const closeAll = (deps: SessionDeps): Effect.Effect<void> =>
  Effect.forEach(deps.live.all(), (live) => dispose(deps, live), {
    discard: true,
    concurrency: 'unbounded',
  }).pipe(Effect.andThen(releaseFibers(deps.scope)))

export interface SessionManagerOptions {
  // The environment of the kernel, which a session's configuration is read with; empty when absent
  readonly env?: KernelEnv | undefined
}

// The record of running sessions starts empty with every layer
const make = (
  options: SessionManagerOptions,
): Effect.Effect<SessionManagerShape, never, SessionRequirements | Scope.Scope> =>
  Effect.gen(function* makeSessionManager() {
    const collected = yield* collectDeps
    const deps: SessionDeps = { ...collected, env: options.env ?? {}, live: new LiveSessions() }
    yield* Effect.addFinalizer(() => closeAll(deps))
    return SessionManager.of({
      create: makeCreate(deps),
      prompt: makePrompt(deps),
      interrupt: makeInterrupt(deps),
      stop: makeStop(deps),
      complete: makeComplete(deps),
      resume: makeResume(deps),
      list: () => listSessions(deps.sql),
      get: (id) => loadSession(deps.sql, id),
    })
  })

export const SessionManagerLive = (
  options: SessionManagerOptions = {},
): Layer.Layer<SessionManager, never, SessionRequirements> =>
  Layer.effect(SessionManager, make(options))
```
Verified in Effect 4.0.0: `Effect.repeat(effect, { until })`, `Stream.takeUntil`, `Stream.fromAsyncIterable`, `Effect.forkIn`, `Effect.catch`; `Effect.yieldNow` is a value. The shipped tests wait on the event log and on latches instead of polling under the `TestClock`.

Add to `index.ts`: `export { SessionManager, SessionManagerLive, type SessionManagerShape } from './sessions/session-manager.js'`, `export { transition, SESSION_EVENTS, type SessionEvent } from './sessions/state-machine.js'`, `export type { Session, Turn, CreateSessionInput } from './sessions/types.js'`, `export { UsageService, UsageServiceLive, type SessionUsage, type UsageSnapshot } from './usage/usage-service.js'`, `export { FakeAgentProvider } from './testing/fake-agent-provider.js'`, `export { fakeAgentPlugin } from './testing/fake-agent-plugin.js'`.

- [ ] **Step 6: Run, commit**

Run: `bunx vitest run --project kernel` → PASS for the state machine and usage tests; the session-manager test passes once Task 14's `KernelTest` exists (run it again there). `bun run check` → green (`fast-check` is already a root devDependency; add it to `packages/kernel` devDependencies as well so knip sees the import).

```bash
git add packages/kernel
git commit -m "feat(kernel): run sessions through providers with turns, asks, usage and a fake agent"
```

### Task 14: Kernel layers and the Promise facade (`KernelLive`, `KernelTest`, `createKernel`)

**Files:**
- Create: `packages/kernel/src/kernel-foundation.ts` (the service layers below the session manager; import cap), `packages/kernel/src/kernel-live.ts` (`KernelLayer`, `composeKernel`), `packages/kernel/src/kernel-test.ts` (`KernelTest`, behind the `./testing` package export), `packages/kernel/src/facade.ts` + `packages/kernel/src/facade/{types,promised,projects,config,sessions,events,workspaces,plugins}.ts`, `packages/kernel/src/facade/facade-fixtures.ts`, and the tests `facade.test.ts`, `facade/facade-areas.test.ts`, `facade/facade-close.test.ts`, `facade/facade-logging.test.ts`, `facade/facade-boot.test.ts`, `facade/facade-log-level.test.ts`, `kernel-live.test.ts`, `kernel-test.test.ts`, `logging/log-level.test.ts`
- Modify: `packages/kernel/src/index.ts`, `packages/kernel/src/bun.ts`, `packages/kernel/package.json` (`./testing` export), `packages/kernel/src/events/event-log.ts` (hub shutdown finalizer), `packages/kernel/src/logging/logging.ts` (Effect log-level mapping), `packages/kernel/src/sessions/session-layer-fixtures.ts` (an adapter over `KernelTest`)

**Interfaces:**
- Consumes: every `*Live` layer from Tasks 3–13; `ManagedRuntime.make(layer)` → `runPromise`, `dispose` (verified).
- Produces: `KernelLayer(options: KernelLayerOptions): Layer<KernelServices, never, SqlClient>` (everything but the store), `KernelTest(options): Layer<KernelServices | SqlClient>` (over `StoreTest`), `createKernelFrom(layer, options): Promise<Kernel>` (facade over any store layer), `createKernel(options: KernelOptions): Promise<Kernel>` in `bun.ts` (over `StoreLive` at `<home>/data/bytebureau.db`), the `Kernel` interface exactly as Task 15 lists it, `KernelLayerOptions { home: string; extraPlugins?: readonly Plugin[]; pluginConfig?: Record<string, unknown> }`, `KernelOptions = KernelLayerOptions & { env: Record<string, string | undefined>; logging?: { debug?: string; level?: string } }`.

Semantics (as shipped): `KernelLayer(options)` composes every `KernelServices` member over a caller-provided `SqlClient` and includes `Layer.succeed(References.MinimumLogLevel, …)` from `options.logLevel` (default `info`); `KernelTest(options, usage?)` lives in `kernel-test.ts` and is reachable only through the `./testing` package export, so neither the root bundle nor the Bun entry carries `@effect/sql-sqlite-node`/`node:sqlite` (`bun build … | grep -c` is 0 for both); `createKernelFrom` configures logging, builds a `ManagedRuntime`, captures the services once, runs `host.load()` and disposes the runtime when the start fails; `events.subscribe` runs outside `runPromise` with the captured services, so a `for await` consumer works across awaits, `break` releases the subscription and `close()` ends a parked consumer because `EventLogLive` now shuts its hub down on release; `createKernel` (Bun entry) creates `<home>/data` and uses `StoreLive(<home>/data/bytebureau.db)`; after `close()` facade calls reject; typed errors keep their identity (Task 15 formats them from `name`, `code` and `reason`). Final fix wave: the log level is resolved once at boot (`facade/boot-logging.ts`): the `--log-level` flag, else `Config.load({ env })` without a project — the user file and `BYTEBUREAU_LOG_LEVEL` — else `info` (a configuration that cannot be read leaves `info`, the commands that read it report it); `createKernel` builds its layer with the same level, lowered to `debug` for Effect when `--debug` is given (`effectLevelOf`), while `createKernelFrom` configures LogTape only and documents that its layer brings its own `logLevel`; the format of the records follows stderr (pretty at a terminal, JSON lines otherwise); `KernelLayerOptions.env` carries the kernel's environment to the sessions; `createKernel` creates `<home>` and `<home>/data` with mode 0700 (an existing home keeps its mode, the data directory is narrowed at every start) and narrows `bytebureau.db`, `-wal` and `-shm` to 0600 once the store has opened them (`store/home.ts`); a boot that fails disposes the runtime with `Promise.allSettled`, so the failure of the start rejects even when disposing fails; after `close()` calls reject with an `Error`; `events.subscribe` documents `since`.

- [ ] **Step 1: Failing facade test**

`packages/kernel/src/facade.test.ts`:
```ts
import { existsSync } from 'node:fs'
import type { EventEnvelope } from '@bytebureau/protocol'
import { describe, expect, it } from 'vitest'
import { QUIET } from './facade/facade-fixtures.js'
import { createKernelFrom, type Kernel } from './facade.js'
import { KernelTest } from './kernel-test.js'
import { helloFileOf } from './sessions/session-helper-fixtures.js'
import type { Session } from './sessions/types.js'
import { createTempRepo, tempDir } from './testing/temp-repo.js'

// The fake agent asks whether it may write; the answer is the one it offers
async function answerTheAsk(kernel: Kernel, sessionId: string): Promise<void> {
  const [ask] = await kernel.asks.pending(sessionId)
  if (ask === undefined) {
    throw new Error('the agent asked, yet no ask is pending')
  }
  await kernel.asks.answer(ask.id, { selected: ['yes'] }, 'cli')
}

// What the CLI does with a run: follow the events, answer the question, complete the session once its turn is over
async function followRun(
  kernel: Kernel,
  sessionId: string,
  events: AsyncIterable<EventEnvelope>,
): Promise<readonly string[]> {
  const seen: string[] = []
  for await (const event of events) {
    seen.push(event.type)
    if (event.type === 'ask.requested') {
      await answerTheAsk(kernel, sessionId)
    }
    if (event.type === 'turn.completed') {
      await kernel.sessions.complete(sessionId)
    }
    if (event.type === 'session.completed') {
      break
    }
  }
  return seen
}

interface Run {
  readonly session: Session
  readonly seen: readonly string[]
  readonly turns: number
}

// A session of the fake agent, from its registration to its completion
async function runFakeSession(kernel: Kernel): Promise<Run> {
  const project = await kernel.projects.register(createTempRepo())
  const input = { projectId: project.id, title: 'facade run', providerId: 'fake' }
  const session = await kernel.sessions.create(input)
  const events = kernel.events.subscribe({ sessionId: session.id, since: 0 })
  await kernel.sessions.prompt(session.id, { text: 'go' })
  const seen = await followRun(kernel, session.id, events)
  const usage = await kernel.usage.session(session.id)
  return { session, seen, turns: usage.turns }
}

describe(createKernelFrom, () => {
  it('drives a whole fake-provider run through Promises and AsyncIterables only', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const kernel = await createKernelFrom(KernelTest({ home }), { home, env: {}, logging: QUIET })
    try {
      const { session, seen, turns } = await runFakeSession(kernel)
      expect(seen).toContain('ask.answered')
      expect(turns).toBe(1)
      expect(existsSync(helloFileOf(session))).toBe(true)
      expect(kernel.providers.list().map((provider) => provider.id)).toContain('fake')
    } finally {
      await kernel.close()
    }
  })
})
```
`packages/kernel/src/facade/facade-areas.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { AskError, ConfigError, SessionError, WorkspaceError } from '../errors.js'
import { openKernel, startFakeSession } from './facade-fixtures.js'
import { createTempRepo } from '../testing/temp-repo.js'

describe('the projects of the facade', () => {
  it('registers a repository, lists and reads it, and removes it again', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    const project = await kernel.projects.register(createTempRepo())
    const listed = await kernel.projects.list()
    const found = await kernel.projects.get(project.id)
    await kernel.projects.remove(project.id)
    const gone = await kernel.projects.get(project.id)
    expect([listed, found, gone]).toStrictEqual([[project], project, undefined])
  })
})

describe('the configuration of the facade', () => {
  it('resolves the configuration of a project with the environment it was opened with', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const kernel = await openKernel({ env: { BYTEBUREAU_LOG_LEVEL: 'debug' } })
    const config = await kernel.config.load(repo)
    const issues = await kernel.config.validate(repo)
    expect(config).toMatchObject({ projectPath: repo, project: { logging: { level: 'debug' } } })
    expect(issues).toStrictEqual([])
  })

  it('offers the JSON schema of the configuration without a promise', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    expect(kernel.config.schema()).toHaveProperty('$schema')
  })
})

describe('the sessions of the facade', () => {
  it('lists and reads its sessions, stops one and resumes it', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    const session = await startFakeSession(kernel)
    const listed = await kernel.sessions.list()
    await kernel.sessions.stop(session.id)
    const stopped = await kernel.sessions.get(session.id)
    const resumed = await kernel.sessions.resume(session.id)
    expect(listed.map((each) => each.id)).toStrictEqual([session.id])
    expect(stopped).toMatchObject({ id: session.id, status: 'stopped' })
    expect(resumed).toMatchObject({ id: session.id, status: 'ready' })
  })

  it('has no ask pending and no usage for a session that has not been prompted', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    const session = await startFakeSession(kernel)
    const pending = await kernel.asks.pending(session.id)
    const usage = await kernel.usage.session(session.id)
    expect(pending).toStrictEqual([])
    expect(usage).toMatchObject({ turns: 0, costUsd: null })
  })

  it('reads the events of a session from the log, in the order they happened', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    const session = await startFakeSession(kernel)
    const events = await kernel.events.read({ sessionId: session.id }, { from: 0 })
    expect(events.map((event) => event.type)).toStrictEqual([
      'session.created',
      'session.provisioning',
      'workspace.provisioned',
      'session.ready',
    ])
  })
})

describe('the workspaces of the facade', () => {
  it('lists the worktree of a session and keeps it while the session is ready', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    const session = await startFakeSession(kernel)
    const listed = await kernel.workspaces.list(session.projectId)
    const report = await kernel.workspaces.prune(session.projectId)
    expect(listed.map((info) => [info.sessionId, info.sessionStatus, info.exists])).toStrictEqual([
      [session.id, 'ready', true],
    ])
    expect(report.removed).toStrictEqual([])
    expect(report.retained.map((kept) => kept.reason)).toStrictEqual(['session is ready'])
  })
})

describe('the failures of the facade', () => {
  it('rejects with the errors of the sessions and of the asks as they are', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    await expect(kernel.sessions.prompt('x', { text: 'y' })).rejects.toBeInstanceOf(SessionError)
    await expect(kernel.sessions.interrupt('x')).rejects.toBeInstanceOf(SessionError)
    await expect(kernel.asks.answer('x', { selected: [] }, 'cli')).rejects.toBeInstanceOf(AskError)
  })

  it('rejects with the errors of the projects and of the configuration as they are', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    await expect(kernel.projects.register('/')).rejects.toBeInstanceOf(WorkspaceError)
    await expect(kernel.config.load('/no/such/dir')).rejects.toBeInstanceOf(ConfigError)
  })
})
```
`packages/kernel/src/facade/facade-close.test.ts`:
```ts
import type { Plugin } from '@bytebureau/plugin-api'
import type { EventEnvelope } from '@bytebureau/protocol'
import { describe, expect, it } from 'vitest'
import { eventsUntil, openKernel } from './facade-fixtures.js'
import { manifestOf, providerOf } from '../plugins/plugin-fixtures.js'
import { createTempRepo } from '../testing/temp-repo.js'

const failing: Plugin = {
  manifest: manifestOf('failing'),
  setup: async () => {
    await Promise.resolve()
    throw new Error('this plugin cannot start')
  },
}

const offering: Plugin = {
  manifest: manifestOf('offering'),
  setup: () => ({ agentProviders: [providerOf('offered')] }),
}

describe('closing the kernel', () => {
  it('ends the iteration that waits for the next event, as an iteration that has run out', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    const project = await kernel.projects.register(createTempRepo())
    const events = kernel.events.subscribe({ projectId: project.id, since: 0 })
    const iterator = events[Symbol.asyncIterator]()
    const replayed = await iterator.next()
    const waiting = iterator.next()
    await kernel.close()
    expect(replayed).toMatchObject({ done: false, value: { type: 'project.registered' } })
    await expect(waiting).resolves.toStrictEqual({ done: true, value: undefined })
  })

  it('rejects the calls made after it, and closing again does no harm', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    await kernel.close()
    await kernel.close()
    await expect(kernel.projects.list()).rejects.toBeInstanceOf(Error)
    await expect(kernel.sessions.list()).rejects.toBeInstanceOf(Error)
  })
})

describe('leaving an iteration of events', () => {
  it('leaves the kernel serving: the next iteration replays what the first one saw', async () => {
    expect.hasAssertions()
    const kernel = await openKernel()
    const one = await kernel.projects.register(createTempRepo())
    const two = await kernel.projects.register(createTempRepo())
    const atTwo = (event: EventEnvelope): boolean => event.projectId === two.id
    const filter = { types: ['project.registered'], since: 0 }
    const seen = await eventsUntil(kernel.events.subscribe(filter), atTwo)
    const again = await eventsUntil(kernel.events.subscribe(filter), atTwo)
    expect(seen.map((event) => event.projectId)).toStrictEqual([one.id, two.id])
    expect(again).toStrictEqual(seen)
  })
})

describe('starting the kernel', () => {
  it('starts without the plugin that cannot load and offers the agents of the others', async () => {
    expect.hasAssertions()
    const kernel = await openKernel({ extraPlugins: [failing, offering] })
    const ids = kernel.providers.list().map((provider) => provider.id)
    expect(ids).toStrictEqual(['fake', 'offered'])
  })
})
```
`packages/kernel/src/facade/facade-logging.test.ts`:
```ts
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createKernelFrom, type KernelOptions } from '../facade.js'
import { KernelTest } from '../kernel-test.js'
import { kernelLogger } from '../logging/logging.js'
import { tempDir } from '../testing/temp-repo.js'

const probe = kernelLogger(['bb', 'probe'])

// What the kernel writes to stderr from here on, where every log record goes, kept from printing for the rest of the test
function stderrLines(): () => readonly string[] {
  const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  onTestFinished(() => {
    spy.mockRestore()
  })
  return () => spy.mock.calls.map((call) => String(call[0]))
}

// A kernel opened with the logging, which the process is configured with; the console shows what is logged afterwards
async function openLogging(logging?: KernelOptions['logging']): Promise<void> {
  const home = tempDir('bb-home-')
  const kernel = await createKernelFrom(KernelTest({ home }), { home, env: {}, logging })
  onTestFinished(async () => {
    await kernel.close()
  })
}

describe('the logging of the facade', () => {
  it('logs from the level it is given on, as JSON lines when asked to', async () => {
    expect.hasAssertions()
    const written = stderrLines()
    await openLogging({ level: 'debug', json: true })
    probe.debug('probe debug')
    const lines = written().filter((line) => line.includes('probe'))
    expect(lines).toStrictEqual([expect.stringContaining('probe debug')])
    expect(JSON.parse(lines.join(''))).toMatchObject({ level: 'DEBUG', message: 'probe debug' })
  })

  it('prints text, not JSON lines, when told not to use them', async () => {
    expect.hasAssertions()
    const written = stderrLines()
    await openLogging({ level: 'debug', json: false })
    probe.debug('probe text')
    const lines = written().filter((line) => line.includes('probe'))
    expect(lines).toStrictEqual([expect.stringContaining('probe text')])
    expect(lines.join('')).not.toMatch(/^\{/u)
  })

  it('logs from info on when it is given no logging at all', async () => {
    expect.hasAssertions()
    const written = stderrLines()
    await openLogging()
    probe.debug('below info')
    probe.info('at info')
    expect(written().filter((line) => line.includes('info'))).toStrictEqual([
      expect.stringContaining('at info'),
    ])
  })

  it('debugs the categories it is told to, whatever the level', async () => {
    expect.hasAssertions()
    const written = stderrLines()
    await openLogging({ level: 'error', json: true, debug: 'bb.probe' })
    probe.debug('selected')
    kernelLogger(['bb', 'other']).debug('not selected')
    expect(written().filter((line) => line.includes('selected'))).toStrictEqual([
      expect.stringContaining('"selected"'),
    ])
  })
})
```
`packages/kernel/src/facade/facade-boot.test.ts`:
```ts
import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { QUIET } from './facade-fixtures.js'
import { createKernelFrom } from '../facade.js'
import { KernelTest } from '../kernel-test.js'
import { PluginHost } from '../plugins/plugin-host.js'
import { tempDir } from '../testing/temp-repo.js'

// Notes in the journal that its layer was released, which happens when the runtime is disposed
const releasing = (journal: string[]): Layer.Layer<never> =>
  Layer.effectDiscard(
    Effect.addFinalizer(() =>
      Effect.sync(() => {
        journal.push('released')
      }),
    ),
  )

// Everything the kernel stands on is up when the layer that dies is built
const dying = Layer.effectDiscard(Effect.die(new Error('this layer cannot be built')))

// A layer whose release fails, so disposing the runtime rejects as well
const failingRelease = Layer.effectDiscard(
  Effect.addFinalizer(() => Effect.die(new Error('this layer cannot be released'))),
)

// The plugins cannot be loaded, however the kernel was composed
const failingLoad = Layer.effect(
  PluginHost,
  PluginHost.useSync((host) =>
    PluginHost.of({ ...host, load: () => Effect.die(new Error('the plugins cannot be loaded')) }),
  ),
)

describe('a kernel that cannot start', () => {
  it('releases its layers when one of them cannot be built, and rejects with that failure', async () => {
    expect.hasAssertions()
    const journal: string[] = []
    const home = tempDir('bb-home-')
    const layer = dying.pipe(
      Layer.provideMerge(releasing(journal)),
      Layer.provideMerge(KernelTest({ home })),
    )
    const starting = createKernelFrom(layer, { home, env: {}, logging: QUIET })
    await expect(starting).rejects.toThrow('this layer cannot be built')
    expect(journal).toStrictEqual(['released'])
  })

  it('releases its layers when the plugins cannot be loaded, and rejects with that failure', async () => {
    expect.hasAssertions()
    const journal: string[] = []
    const home = tempDir('bb-home-')
    const layer = failingLoad.pipe(
      Layer.provideMerge(releasing(journal)),
      Layer.provideMerge(KernelTest({ home })),
    )
    const starting = createKernelFrom(layer, { home, env: {}, logging: QUIET })
    await expect(starting).rejects.toThrow('the plugins cannot be loaded')
    expect(journal).toStrictEqual(['released'])
  })

  it('rejects with the failure of the start even when disposing the runtime fails too', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const layer = failingLoad.pipe(
      Layer.provideMerge(failingRelease),
      Layer.provideMerge(KernelTest({ home })),
    )
    const starting = createKernelFrom(layer, { home, env: {}, logging: QUIET })
    await expect(starting).rejects.toThrow('the plugins cannot be loaded')
  })

  it('keeps the layers of a kernel that starts until it is closed', async () => {
    expect.hasAssertions()
    const journal: string[] = []
    const home = tempDir('bb-home-')
    const layer = releasing(journal).pipe(Layer.provideMerge(KernelTest({ home })))
    const kernel = await createKernelFrom(layer, { home, env: {}, logging: QUIET })
    expect(journal).toStrictEqual([])
    await kernel.close()
    expect(journal).toStrictEqual(['released'])
  })
})
```
`packages/kernel/src/kernel-live.test.ts`:
```ts
import type { LogRecord } from '@logtape/logtape'
import { assert, describe, expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { KernelLayer } from './kernel-live.js'
import { configureLogging, resetLogging, type KernelLogLevel } from './logging/logging.js'
import { SessionManager } from './sessions/session-manager.js'
import { StoreTest } from './store/store-test.js'
import { tempDir } from './testing/temp-repo.js'

// The kernel without a store, over the in-memory one the caller provides
const kernelOver = (logLevel?: KernelLogLevel): Layer.Layer<SessionManager> =>
  KernelLayer({ home: tempDir('bb-home-'), logLevel }).pipe(Layer.provideMerge(StoreTest))

// A debug and an info record logged by Effect inside the kernel layer; LogTape itself lets both through
async function loggedInKernel(logLevel?: KernelLogLevel): Promise<readonly unknown[]> {
  const seen: LogRecord[] = []
  await configureLogging({
    level: 'debug',
    json: true,
    capture: (record) => {
      seen.push(record)
    },
  })
  try {
    const logging = Effect.andThen(Effect.logDebug('debug'), Effect.logInfo('info'))
    await Effect.runPromise(Effect.provide(logging, kernelOver(logLevel)))
  } finally {
    await resetLogging()
  }
  return seen.map((record) => record.message[0])
}

describe(KernelLayer, () => {
  it('lets Effect log from info up unless the options give a level', async () => {
    expect.hasAssertions()
    await expect(loggedInKernel()).resolves.toStrictEqual(['info'])
  })

  it('lets the debug records of Effect reach the logger when the level is debug', async () => {
    expect.hasAssertions()
    await expect(loggedInKernel('debug')).resolves.toStrictEqual(['debug', 'info'])
  })

  it.effect('is the whole kernel but the store, which the caller provides', () =>
    Effect.gen(function* providesStore() {
      const sessions = yield* SessionManager
      assert.deepStrictEqual(yield* sessions.list(), [])
    }).pipe(Effect.provide(kernelOver())),
  )
})
```
`packages/kernel/src/kernel-test.test.ts`:
```ts
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import type { UsageLayer } from './kernel-foundation.js'
import { KernelTest } from './kernel-test.js'
import { failingUsage } from './sessions/session-gate-fixtures.js'
import { tempDir } from './testing/temp-repo.js'
import { UsageService } from './usage/usage-service.js'

// Whether the usage service of a kernel records a rate limit
const records = (usage?: UsageLayer): Effect.Effect<boolean> => {
  const kernel = KernelTest({ home: tempDir('bb-home-') }, usage)
  return Effect.gen(function* recordsRateLimit() {
    const service = yield* UsageService
    return yield* Effect.match(service.record('profile', {}), {
      onFailure: () => false,
      onSuccess: () => true,
    })
  }).pipe(Effect.provide(kernel))
}

it.effect('offers the live usage service unless a test swaps in its own', () =>
  Effect.gen(function* offersLiveUsage() {
    assert.isTrue(yield* records())
  }),
)

it.effect('offers the usage service a test swaps in', () =>
  Effect.gen(function* offersSwappedUsage() {
    assert.isFalse(yield* records(failingUsage()))
  }),
)
```
`packages/kernel/src/facade/facade-fixtures.ts` (shared fixtures):
```ts
import type { EventEnvelope } from '@bytebureau/protocol'
import { onTestFinished } from 'vitest'
import { createKernelFrom, type Kernel, type KernelOptions } from '../facade.js'
import type { KernelLayerOptions } from '../kernel-live.js'
import { KernelTest } from '../kernel-test.js'
import type { Session } from '../sessions/types.js'
import { createTempRepo, tempDir } from '../testing/temp-repo.js'

type Extras = Pick<KernelLayerOptions, 'extraPlugins'> & Partial<Pick<KernelOptions, 'env'>>

// A kernel logs its own warnings, such as an employee without a prompt file; a test is not about them
export const QUIET: KernelOptions['logging'] = { level: 'error' }

// A kernel over the in-memory store, closed when the test is over; closing it earlier does no harm
export async function openKernel(extras: Extras = {}): Promise<Kernel> {
  const home = tempDir('bb-home-')
  const layer = KernelTest({ home, extraPlugins: extras.extraPlugins })
  const kernel = await createKernelFrom(layer, {
    home,
    env: extras.env ?? {},
    logging: QUIET,
  })
  onTestFinished(async () => {
    await kernel.close()
  })
  return kernel
}

// A session of the fake agent in a fresh repository, ready for its first prompt
export async function startFakeSession(kernel: Kernel): Promise<Session> {
  const project = await kernel.projects.register(createTempRepo())
  return kernel.sessions.create({ projectId: project.id, title: 'facade', providerId: 'fake' })
}

// The events up to the first the predicate accepts, which is included; the loop is left there
export async function eventsUntil(
  events: AsyncIterable<EventEnvelope>,
  accepts: (event: EventEnvelope) => boolean,
): Promise<readonly EventEnvelope[]> {
  const seen: EventEnvelope[] = []
  for await (const event of events) {
    seen.push(event)
    if (accepts(event)) {
      break
    }
  }
  return seen
}
```
`packages/kernel/src/facade/facade-log-level.test.ts`:
```ts
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createKernelFrom, type KernelOptions } from '../facade.js'
import { KernelTest } from '../kernel-test.js'
import { kernelLogger } from '../logging/logging.js'
import { tempDir } from '../testing/temp-repo.js'

const probe = kernelLogger(['bb', 'probe'])

interface Opened {
  readonly env?: KernelOptions['env']
  readonly userFile?: unknown
  readonly level?: string
}

// Whether a debug record of the probe reaches stderr once a kernel has started with the environment, the user file and the flag
async function debugReaches({ env = {}, userFile, level }: Opened): Promise<boolean> {
  const home = tempDir('bb-home-')
  if (userFile !== undefined) {
    writeFileSync(path.join(home, 'config.json'), JSON.stringify(userFile))
  }
  const written = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  onTestFinished(() => {
    written.mockRestore()
  })
  const logging = { json: true, ...(level === undefined ? {} : { level }) }
  const kernel = await createKernelFrom(KernelTest({ home }), { home, env, logging })
  onTestFinished(async () => {
    await kernel.close()
  })
  probe.debug('probe debug')
  return written.mock.calls.some((call) => String(call[0]).includes('probe debug'))
}

describe('the log level of a kernel without a --log-level flag', () => {
  it('comes from BYTEBUREAU_LOG_LEVEL', async () => {
    expect.hasAssertions()
    await expect(debugReaches({ env: { BYTEBUREAU_LOG_LEVEL: 'debug' } })).resolves.toBe(true)
  })

  it('comes from the logging section of the user file', async () => {
    expect.hasAssertions()
    await expect(debugReaches({ userFile: { logging: { level: 'debug' } } })).resolves.toBe(true)
  })

  it('is info when neither says anything, or the user file cannot be read', async () => {
    expect.hasAssertions()
    await expect(debugReaches({})).resolves.toBe(false)
    await expect(debugReaches({ userFile: { logging: { level: 'loud' } } })).resolves.toBe(false)
  })
})

describe('the --log-level flag', () => {
  it('wins over the environment and the user file', async () => {
    expect.hasAssertions()
    const both = {
      env: { BYTEBUREAU_LOG_LEVEL: 'debug' },
      userFile: { logging: { level: 'debug' } },
    }
    await expect(debugReaches({ ...both, level: 'info' })).resolves.toBe(false)
  })
})
```
`packages/kernel/src/facade/boot-logging.ts`:
```ts
import type { ProjectConfig } from '@bytebureau/protocol'
import { Effect } from 'effect'
import { Config, ConfigLive } from '../config/config.js'
import { configureLogging, parseLogLevel, type KernelLogLevel } from '../logging/logging.js'
import type { KernelOptions } from './types.js'

const levelOf = ({ logging }: ProjectConfig): KernelLogLevel =>
  logging === undefined || logging.level === undefined ? 'info' : logging.level

// The level a kernel logs at: the flag when one is given, else the user file and BYTEBUREAU_LOG_LEVEL, else info
// A configuration that cannot be read does not stop the kernel: the commands that read it report the problem
export async function bootLevel(options: KernelOptions): Promise<KernelLogLevel> {
  const { level } = options.logging ?? {}
  if (level !== undefined) {
    return parseLogLevel(level)
  }
  const configured = Config.use((config) => config.load({ env: options.env })).pipe(
    Effect.match({
      onFailure: (): KernelLogLevel => 'info',
      onSuccess: (resolved) => levelOf(resolved.project),
    }),
    Effect.provide(ConfigLive(options.home)),
  )
  const resolved = await Effect.runPromise(configured)
  return resolved
}

// Records go to stderr, so their format follows stderr: pretty at a terminal, JSON lines otherwise
export async function configureKernelLogging(options: KernelOptions): Promise<void> {
  const { json, debug } = options.logging ?? {}
  await configureLogging({
    level: await bootLevel(options),
    json: json ?? !process.stderr.isTTY,
    debug,
  })
}
```

- [ ] **Step 2: Layers and facade**

`packages/kernel/src/kernel-live.ts`:
```ts
import { Layer } from 'effect'
import type { SqlClient } from 'effect/sql'
import { AskServiceLive, type AskService } from './asks/ask-service.js'
import {
  FoundationLive,
  type FoundationOptions,
  type FoundationServices,
  type UsageLayer,
} from './kernel-foundation.js'
import { PluginHostLive, type PluginHost, type PluginHostOptions } from './plugins/plugin-host.js'
import { ProjectRegistryLive, type ProjectRegistry } from './projects/project-registry.js'
import { SessionManagerLive, type SessionManager } from './sessions/session-manager.js'
import type { WorkspaceRuntimes } from './workspace/runtimes.js'
import { WorkspaceManagerLive, type WorkspaceManager } from './workspace/workspace-manager.js'

export interface KernelLayerOptions
  extends FoundationOptions, Pick<PluginHostOptions, 'extraPlugins' | 'pluginConfig'> {
  // The environment of the kernel: a session reads its configuration with it, so BYTEBUREAU_* overrides reach a run
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}

export type KernelServices =
  | FoundationServices
  | ProjectRegistry
  | PluginHost
  | WorkspaceRuntimes
  | WorkspaceManager
  | AskService
  | SessionManager

// The layers of the kernel; KernelTest is the only caller that passes the usage service
export const composeKernel = (
  options: KernelLayerOptions,
  usage?: UsageLayer,
): Layer.Layer<KernelServices, never, SqlClient.SqlClient> => {
  const foundation = FoundationLive(options, usage)
  const plugins = PluginHostLive({
    extraPlugins: options.extraPlugins,
    pluginConfig: options.pluginConfig,
  }).pipe(Layer.provideMerge(foundation))
  const registry = Layer.mergeAll(ProjectRegistryLive, WorkspaceManagerLive, AskServiceLive).pipe(
    Layer.provideMerge(plugins),
  )
  return SessionManagerLive({ env: options.env }).pipe(Layer.provideMerge(registry))
}

// Everything except the store; the caller provides SqlClient (StoreLive in the binary)
export const KernelLayer = (
  options: KernelLayerOptions,
): Layer.Layer<KernelServices, never, SqlClient.SqlClient> => composeKernel(options)
```
`packages/kernel/src/kernel-foundation.ts`:
```ts
import { Layer } from 'effect'
import type { SqlClient } from 'effect/sql'
import { ConfigLive, type Config } from './config/config.js'
import { EventLogLive, type EventLog } from './events/event-log.js'
import { EffectLoggerLive, EffectLogLevelLive, type KernelLogLevel } from './logging/logging.js'
import { SupervisorLive, type Supervisor } from './process/supervisor.js'
import { UsageServiceLive, type UsageService } from './usage/usage-service.js'

export interface FoundationOptions {
  readonly home: string
  // Effect drops its own logs below this level; info when absent
  readonly logLevel?: KernelLogLevel | undefined
}

export type FoundationServices = Config | EventLog | Supervisor | UsageService

export type UsageLayer = Layer.Layer<UsageService, never, SqlClient.SqlClient>

// What the other services stand on; these need nothing of each other
// The usage service is the live one unless a test swaps its own in
export const FoundationLive = (
  options: FoundationOptions,
  usage: UsageLayer = UsageServiceLive,
): Layer.Layer<FoundationServices, never, SqlClient.SqlClient> =>
  Layer.mergeAll(
    ConfigLive(options.home),
    EventLogLive,
    SupervisorLive,
    usage,
    EffectLoggerLive,
    EffectLogLevelLive(options.logLevel ?? 'info'),
  )
```
`packages/kernel/src/kernel-test.ts`:
```ts
import { Layer } from 'effect'
import type { SqlClient } from 'effect/sql'
import type { UsageLayer } from './kernel-foundation.js'
import { composeKernel, type KernelLayerOptions, type KernelServices } from './kernel-live.js'
import { StoreTest } from './store/store-test.js'

// The layers of the kernel over an in-memory store; a test may swap in its own usage service
export const KernelTest = (
  options: KernelLayerOptions,
  usage?: UsageLayer,
): Layer.Layer<KernelServices | SqlClient.SqlClient> =>
  composeKernel(options, usage).pipe(Layer.provideMerge(StoreTest))
```
`packages/kernel/src/facade.ts`:
```ts
import { Effect, ManagedRuntime, type Layer } from 'effect'
import { configApi } from './facade/config.js'
import { eventsApi } from './facade/events.js'
import { loadPlugins, providersApi } from './facade/plugins.js'
import { projectsApi } from './facade/projects.js'
import { promisedBy, type Runtime, type Services } from './facade/promised.js'
import { asksApi, sessionsApi, usageApi } from './facade/sessions.js'
import type { Kernel, KernelOptions } from './facade/types.js'
import { configureKernelLogging } from './facade/boot-logging.js'
import { workspacesApi } from './facade/workspaces.js'

export type { Kernel, KernelOptions } from './facade/types.js'

// The steps that can fail while a kernel starts
async function boot(runtime: Runtime, options: KernelOptions): Promise<Kernel> {
  await configureKernelLogging(options)
  const promised = promisedBy(runtime)
  // Captured once, so that an event stream can run outside the runtime
  const services = await runtime.runPromise(Effect.context<Services>())
  await loadPlugins(promised)
  return {
    projects: projectsApi(promised),
    config: configApi(promised, services, options.env),
    sessions: sessionsApi(promised),
    asks: asksApi(promised),
    events: eventsApi(promised, services),
    workspaces: workspacesApi(promised),
    usage: usageApi(promised),
    providers: providersApi(services),
    close: async () => {
      await runtime.dispose()
    },
  }
}

/**
 * A kernel over a layer that brings its own store, with its plugins loaded.
 * The log level (logging.level, else the user file and BYTEBUREAU_LOG_LEVEL) configures LogTape only: Effect drops its own records below the logLevel the layer was built with, which createKernel sets from the same level.
 * A kernel that fails to start is disposed before the failure is passed on, so no handle or fiber stays behind, and the failure of the start is what rejects even when disposing fails as well.
 */
export async function createKernelFrom(
  layer: Layer.Layer<Services>,
  options: KernelOptions,
): Promise<Kernel> {
  const runtime = ManagedRuntime.make(layer)
  try {
    return await boot(runtime, options)
  } catch (error) {
    await Promise.allSettled([runtime.dispose()])
    throw error
  }
}
```
`packages/kernel/src/facade/types.ts`:
```ts
import type { AnsweredVia, Ask, AskAnswer, EventEnvelope, PromptInput } from '@bytebureau/protocol'
import type { ConfigIssue, ResolvedConfig } from '../config/config.js'
import type { EventFilter } from '../events/event-log.js'
import type { KernelLayerOptions } from '../kernel-live.js'
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
  /** Stops the agents and ends the open event subscriptions; a call made after it may reject. */
  readonly close: () => Promise<void>
}
```
`packages/kernel/src/facade/promised.ts`:
```ts
import type { Context, Effect, ManagedRuntime } from 'effect'
import type { SqlClient } from 'effect/sql'
import type { KernelServices } from '../kernel-live.js'

// Everything a kernel layer offers, the store included
export type Services = KernelServices | SqlClient.SqlClient

export type Runtime = ManagedRuntime.ManagedRuntime<Services, never>

// A call of a service as a function that returns a promise
export type Promised = <Id extends Services, Shape, Args extends readonly unknown[], Value>(
  service: Context.Service<Id, Shape>,
  call: (shape: Shape, ...args: Args) => Effect.Effect<Value, unknown>,
) => (...args: Args) => Promise<Value>

// A runtime that is disposed rejects with a bare string; a caller always gets an Error
export const promisedBy =
  (runtime: Runtime): Promised =>
  (service, call) =>
  async (...args) => {
    try {
      return await runtime.runPromise(service.use((shape) => call(shape, ...args)))
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error))
    }
  }
```
`packages/kernel/src/facade/projects.ts`:
```ts
import { ProjectRegistry } from '../projects/project-registry.js'
import type { Promised } from './promised.js'
import type { Kernel } from './types.js'

export const projectsApi = (promised: Promised): Kernel['projects'] => ({
  register: promised(ProjectRegistry, (registry, path) => registry.register(path)),
  list: promised(ProjectRegistry, (registry) => registry.list()),
  get: promised(ProjectRegistry, (registry, id) => registry.get(id)),
  remove: promised(ProjectRegistry, (registry, id) => registry.remove(id)),
})
```
`packages/kernel/src/facade/config.ts`:
```ts
import { Context } from 'effect'
import { Config } from '../config/config.js'
import type { Promised, Services } from './promised.js'
import type { Kernel, KernelOptions } from './types.js'

// The overrides come from the environment the caller gave
export const configApi = (
  promised: Promised,
  services: Context.Context<Services>,
  env: KernelOptions['env'],
): Kernel['config'] => ({
  load: promised(Config, (config, projectPath) => config.load({ projectPath, env })),
  validate: promised(Config, (config, projectPath) => config.validate(projectPath)),
  schema: () => Context.get(services, Config).schema(),
})
```
`packages/kernel/src/facade/sessions.ts`:
```ts
import { Effect } from 'effect'
import { AskService } from '../asks/ask-service.js'
import { SessionManager } from '../sessions/session-manager.js'
import { UsageService } from '../usage/usage-service.js'
import type { Promised } from './promised.js'
import type { Kernel } from './types.js'

export const sessionsApi = (promised: Promised): Kernel['sessions'] => ({
  create: promised(SessionManager, (sessions, input) => sessions.create(input)),
  prompt: promised(SessionManager, (sessions, sessionId, input) =>
    sessions.prompt(sessionId, input),
  ),
  interrupt: promised(SessionManager, (sessions, sessionId) => sessions.interrupt(sessionId)),
  stop: promised(SessionManager, (sessions, sessionId) => sessions.stop(sessionId)),
  complete: promised(SessionManager, (sessions, sessionId) => sessions.complete(sessionId)),
  resume: promised(SessionManager, (sessions, sessionId) => sessions.resume(sessionId)),
  list: promised(SessionManager, (sessions) => sessions.list()),
  get: promised(SessionManager, (sessions, id) => sessions.get(id)),
})

// The record of the settled ask is not handed on
export const asksApi = (promised: Promised): Kernel['asks'] => ({
  pending: promised(AskService, (asks, sessionId) => asks.pending(sessionId)),
  answer: promised(AskService, (asks, ...args) => Effect.asVoid(asks.answer(...args))),
})

export const usageApi = (promised: Promised): Kernel['usage'] => ({
  session: promised(UsageService, (usage, sessionId) => usage.sessionUsage(sessionId)),
})
```
`packages/kernel/src/facade/events.ts`:
```ts
import { Stream, type Context } from 'effect'
import { EventLog } from '../events/event-log.js'
import type { Promised, Services } from './promised.js'
import type { Kernel } from './types.js'

// A stream outlives any one call, so it runs on the captured services instead of through the runtime
export const eventsApi = (
  promised: Promised,
  services: Context.Context<Services>,
): Kernel['events'] => ({
  subscribe: (filter) =>
    Stream.toAsyncIterable(
      Stream.unwrap(EventLog.useSync((log) => log.subscribe(filter))).pipe(
        Stream.provideContext(services),
      ),
    ),
  read: promised(EventLog, (log, filter, range) => log.read(filter, range)),
})
```
`packages/kernel/src/facade/workspaces.ts`:
```ts
import { WorkspaceManager } from '../workspace/workspace-manager.js'
import type { Promised } from './promised.js'
import type { Kernel } from './types.js'

export const workspacesApi = (promised: Promised): Kernel['workspaces'] => ({
  list: promised(WorkspaceManager, (workspaces, projectId) => workspaces.list(projectId)),
  prune: promised(WorkspaceManager, (workspaces, projectId) => workspaces.prune(projectId)),
})
```
`packages/kernel/src/facade/plugins.ts`:
```ts
import { Context } from 'effect'
import { PluginHost } from '../plugins/plugin-host.js'
import type { Promised, Services } from './promised.js'
import type { Kernel } from './types.js'

// A plugin that fails to load is reported by the host and does not stop the kernel
export async function loadPlugins(promised: Promised): Promise<void> {
  await promised(PluginHost, (host) => host.load())()
}

export const providersApi = (services: Context.Context<Services>): Kernel['providers'] => ({
  list: () =>
    Context.get(services, PluginHost)
      .agentProviders()
      .map((provider) => ({ id: provider.id, displayName: provider.displayName })),
})
```
Verified in Effect 4.0.0: `Effect.context<R>()`, `Stream.provideContext`, `ManagedRuntime.make` → `runPromise`/`runSync`/`dispose`, `References.MinimumLogLevel` provided with `Layer.succeed`, `PubSub.shutdown` completing parked `Stream.fromSubscription` streams, `Stream.toAsyncIterable`.

`packages/kernel/src/bun.ts`:
```ts
import path from 'node:path'
import { Layer } from 'effect'
import { bootLevel } from './facade/boot-logging.js'
import { createKernelFrom, type Kernel, type KernelOptions } from './facade.js'
import { KernelLayer } from './kernel-live.js'
import { effectLevelOf } from './logging/logging.js'
import { prepareHome, restrictDatabase } from './store/home.js'
import { StoreLive } from './store/store-live.js'

export { StoreLive } from './store/store-live.js'
export type { Kernel, KernelOptions } from './facade.js'

// The kernel of the binary: its store is the database under the home of the user, which only the user can read
// The log level is resolved once, so LogTape and Effect's own minimum agree; --debug lowers Effect's minimum to debug
export async function createKernel(options: KernelOptions): Promise<Kernel> {
  const database = path.join(prepareHome(options.home), 'bytebureau.db')
  const level = await bootLevel(options)
  const debug = options.logging === undefined ? undefined : options.logging.debug
  const layer = KernelLayer({ ...options, logLevel: effectLevelOf(level, debug) })
  const store = StoreLive(database)
  const logging = { ...options.logging, level }
  const kernel = await createKernelFrom(layer.pipe(Layer.provideMerge(store)), {
    ...options,
    logging,
  })
  restrictDatabase(database)
  return kernel
}
```
Add to `index.ts`: `export { KernelLayer, composeKernel, type KernelLayerOptions, type KernelServices } from './kernel-live.js'`, `export { createKernelFrom, type Kernel, type KernelOptions } from './facade.js'`; `KernelTest` is exported only from `@bytebureau/kernel/testing`. Task 15's CLI imports `createKernel` and `Kernel` from `@bytebureau/kernel/bun` (not from the package root, which stays Node-safe).

- [ ] **Step 3: Run everything, commit**

Run: `bunx vitest run --project kernel` → PASS including the Task 13 session-manager test. `bun run check` → green.

```bash
git add packages/kernel
git commit -m "feat(kernel): compose the kernel layers and expose a promise facade for the cli"
```

### Task 15: CLI — `run --no-daemon`, `config`, `projects`, `workspaces`

**Files:**
- Create: `apps/bytebureau/src/kernel.ts`, `apps/bytebureau/src/kernel-home.ts`, `apps/bytebureau/src/errors.ts` (typed kernel errors formatted for the runner), `apps/bytebureau/src/resource.ts`, `apps/bytebureau/src/commands/run.ts`, `apps/bytebureau/src/commands/run-session.ts` (the session loop, exit codes, SIGINT), `apps/bytebureau/src/commands/config.ts`, `apps/bytebureau/src/commands/projects.ts`, `apps/bytebureau/src/commands/workspaces.ts`, `apps/bytebureau/src/render/transcript.ts`, `apps/bytebureau/src/render/ask-prompt.ts`, `apps/bytebureau/src/testing/{run-cli,temp-repo,events,json-lines,scripted-kernel,workbench}.ts`, and the tests `context`, `errors`, `kernel-home`, `resource`, `render/transcript`, `render/ask-prompt`, `commands/run`, `commands/run-session`, `commands/run-session-failures`, `commands/run-session-malformed`, `commands/run-session-terminal`, `commands/config`, `commands/projects`, `commands/workspaces`; `packages/protocol/src/events.ts` gains `decodeEventPayload(type, payload)` (strict decode through `KernelEventSchemas`, so the CLI never imports Effect)
- Modify: `apps/bytebureau/src/main.ts` (register the commands, exit line), `apps/bytebureau/src/run.ts` (bare `--debug` → `--debug=`, typed error formatting through `errors.ts`), `apps/bytebureau/src/context.ts` (`yes`, `debug`, `log-level`, `Context.logging`), `apps/bytebureau/src/cli.test.ts` (imports the moved spawn helper), `apps/bytebureau/package.json` (`@bytebureau/kernel`, `@bytebureau/protocol`) + `bun.lock`, `packages/i18n/messages/{en,cs}.json` (the brief's keys plus `run_ask_waiting`, `run_event_skipped`, plural-free `run_completed`), `vitest.config.ts` (coverage include for the renderers), `cspell-words.txt`

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

Semantics (as shipped): `--json` prints NDJSON only (durable events — the stream subscribes with `ephemeral: false` so `seq` increases monotonically); a non-TTY run without `--json` is plain text without colours or prompts; `run` exits 0 on completion, 3 when stopped (SIGINT → `kernel.sessions.stop`), 4 when the session cannot start or finish (provider missing, `ProviderError`, `session.errored`, and since the final fix wave any `WorkspaceError`: a project that is not a repository or is a ByteBureau worktree, a missing runtime, a worktree that cannot be provisioned — the reason printed in one line), and the runner's 2 for anything unexpected (typed kernel errors print `<name>: <reason>` with `code` or `file`+`pointer`); `--yes` answers an ask only when one option is recommended (an unrecommended ask is left to the kernel policy with a stderr warning); the "(Recommended)" marker is appended only when the label does not already carry one anywhere (`(Recommended)`, `[Recommended]`, `(doporučeno)`, `(doporučený)`, also mid-label or before punctuation); a bare `--debug` is rewritten to `--debug=` before citty parses (categories only with `=`); an event whose payload does not fit (`EventPayloadError`) is skipped with a stderr warning, any other failure is not, and the summary is built only when printed; an empty `BYTEBUREAU_HOME` counts as unset and a relative one is resolved against the working directory; `projects rm` of a project that still has sessions prints the refusal and exits 1; under `--json --debug` stdout is pure NDJSON because every log record goes to stderr; `config init` writes with `wx`; `withKernel` always closes the kernel and keeps the original error. Known limits: only SIGINT is handled and a second Ctrl-C is unhandled; `multiSelect` questions are asked as single-select; Ctrl-C during provisioning is not handled.

- [ ] **Step 1: Global flags and i18n strings**

`apps/bytebureau/src/context.ts` — extend `globalArgs` with:
```ts
import { isatty } from 'node:tty'
import { m, setLocale } from '@bytebureau/i18n'
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
} as const

export interface GlobalArgs {
  readonly lang?: string | undefined
  readonly json: boolean
  readonly color: boolean
  readonly yes: boolean
  readonly debug?: string | undefined
  readonly 'log-level'?: string | undefined
}

export interface Context {
  readonly output: Output
  readonly interactive: boolean
  readonly logging: {
    readonly debug: string | undefined
    readonly level: string | undefined
  }
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
  }
}

// The context of the running process: its environment, and whether its stdout is a terminal
export function processContext(args: GlobalArgs): Context {
  return createContext(args, process.env, isatty(process.stdout.fd))
}
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
import { createKernel, type Kernel } from '@bytebureau/kernel/bun'
import type { Context } from './context.js'
import { kernelHome } from './kernel-home.js'
import { withResource } from './resource.js'

// One in-process kernel per command invocation (--no-daemon mode); Phase B adds the daemon client
export async function withKernel<Result>(
  context: Context,
  env: Readonly<Record<string, string | undefined>>,
  work: (kernel: Kernel) => Promise<Result>,
): Promise<Result> {
  const open = async (): Promise<Kernel> => {
    const kernel = await createKernel({ home: kernelHome(env), env, logging: context.logging })
    return kernel
  }
  const result = await withResource(open, work)
  return result
}
```

- [ ] **Step 3: Failing tests for the transcript renderer**

`apps/bytebureau/src/render/transcript.test.ts`:
```ts
import { setLocale } from '@bytebureau/i18n'
import {
  EventPayloadError,
  type EventEnvelope,
  type KernelEventPayload,
} from '@bytebureau/protocol'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createOutput } from '../output.js'
import { event } from '../testing/events.js'
import { completionLine, readOrSkip, summarizeRun, titleOf, transcriptLine } from './transcript.js'

const ESCAPE = '\u001B'
const TOOL_STARTED = 'tool.started'

const PLAIN = createOutput({ json: false, color: false })
const COLOURED = createOutput({ json: false, color: true })

function toolStarted(input: unknown): EventEnvelope {
  return event(TOOL_STARTED, { id: 't1', name: 'Write', kind: 'builtin', input })
}

describe(transcriptLine, () => {
  it('renders assistant text, tool starts and ask requests; ignores deltas', () => {
    expect(
      transcriptLine(event('message.assistant.completed', { text: 'Hello', content: [] }), PLAIN),
    ).toBe('Hello')
    expect(transcriptLine(toolStarted({ path: 'src/hello.ts' }), PLAIN)).toBe(
      '⚙ Write src/hello.ts',
    )
    expect(
      transcriptLine(event('message.assistant.delta', { kind: 'text', text: 'H' }), PLAIN),
    ).toBeUndefined()
  })

  it('prints nothing for an assistant message without text', () => {
    expect(
      transcriptLine(event('message.assistant.completed', { text: '', content: [] }), PLAIN),
    ).toBeUndefined()
  })

  it('prints nothing for events that are not part of the story', () => {
    const usage = { inputTokens: 1, outputTokens: 1 }
    expect(transcriptLine(event('session.ready', { status: 'ready' }), PLAIN)).toBeUndefined()
    expect(transcriptLine(event('usage.updated', { usage }), PLAIN)).toBeUndefined()
  })

  it('colours a failure red and leaves plain output free of escape codes', () => {
    const failed = event('tool.failed', { id: 't1', name: 'Bash', error: 'exit 1' })
    expect(transcriptLine(failed, COLOURED)).toContain(ESCAPE)
    expect(transcriptLine(failed, PLAIN)).not.toContain(ESCAPE)
  })
})

describe('transcriptLine for tools', () => {
  it('shows the path, the command or the pattern of a tool, whichever its input has', () => {
    expect(transcriptLine(toolStarted({ command: 'bun test' }), PLAIN)).toBe('⚙ Write bun test')
    expect(transcriptLine(toolStarted({ pattern: '*.ts' }), PLAIN)).toBe('⚙ Write *.ts')
    expect(transcriptLine(toolStarted({ path: 7, command: 'ls' }), PLAIN)).toBe('⚙ Write ls')
  })

  it('shows just the name of a tool whose input names no target', () => {
    // A JSON null reaches the renderer as it came off the wire
    const wireNull: unknown = JSON.parse('null')
    expect(transcriptLine(toolStarted({ depth: 2 }), PLAIN)).toBe('⚙ Write')
    expect(transcriptLine(toolStarted('text'), PLAIN)).toBe('⚙ Write')
    expect(transcriptLine(toolStarted(wireNull), PLAIN)).toBe('⚙ Write')
  })

  it('renders a failed tool', () => {
    const failed = event('tool.failed', { id: 't1', name: 'Bash', error: 'exit 1' })
    expect(transcriptLine(failed, PLAIN)).toBe('✖ Bash: exit 1')
  })
})

describe('transcriptLine for the life of a session', () => {
  it('renders a warning and the start of a turn', () => {
    const warning = event('session.warning', { kind: 'limit', message: 'near the limit' })
    const started = event('turn.started', { turnId: 'u1', index: 0, status: 'running' })
    expect(transcriptLine(warning, PLAIN)).toBe('! near the limit')
    expect(transcriptLine(started, PLAIN)).toBe('The employee is working…')
  })

  it('names the branch of a provisioned workspace', () => {
    const provisioned = event('workspace.provisioned', {
      path: '/repo/.bytebureau/worktrees/s1',
      branch: 'bb/hello',
      baseRef: 'main',
      runtimeId: 'local',
    })
    expect(transcriptLine(provisioned, PLAIN)).toBe('Preparing the workspace on branch bb/hello')
  })

  it('speaks the language that is set', () => {
    onTestFinished(() => {
      setLocale('en')
    })
    setLocale('cs')
    const started = event('turn.started', { turnId: 'u1', index: 0, status: 'running' })
    expect(transcriptLine(started, PLAIN)).toBe('Zaměstnanec pracuje…')
  })
})

function turnCompleted(
  usage: KernelEventPayload<'turn.completed'>['usage'],
  seq: number,
): EventEnvelope {
  return event(
    'turn.completed',
    { turnId: `u${seq}`, index: seq, status: 'completed', stopReason: 'end_turn', usage },
    seq,
  )
}

describe(summarizeRun, () => {
  it('counts turns and tokens from turn.completed events', () => {
    const events = [
      turnCompleted({ inputTokens: 10, outputTokens: 5, costUsd: 0.01 }, 1),
      turnCompleted({ inputTokens: 1, outputTokens: 1 }, 2),
    ]
    expect(summarizeRun(events, PLAIN)).toStrictEqual({
      turns: 2,
      inputTokens: 11,
      outputTokens: 6,
      costUsd: 0.01,
    })
  })

  it('adds up the cost of the turns that report one and ignores other events', () => {
    const events = [
      turnCompleted({ inputTokens: 1, outputTokens: 1, costUsd: 0.25 }, 1),
      event('session.ready', { status: 'ready' }, 2),
      turnCompleted({ inputTokens: 1, outputTokens: 1, costUsd: 0.5 }, 3),
    ]
    expect(summarizeRun(events, PLAIN).costUsd).toBe(0.75)
  })

  it('reports no cost for a run whose turns reported none, and nothing for no turns', () => {
    expect(
      summarizeRun([turnCompleted({ inputTokens: 1, outputTokens: 1 }, 1)], PLAIN).costUsd,
    ).toBeUndefined()
    expect(summarizeRun([], PLAIN)).toStrictEqual({
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: undefined,
    })
  })
})

// An event of the type whose payload belongs to another type
function malformed(type: string, seq: number): EventEnvelope {
  return { ...event('session.ready', { status: 'ready' }, seq), type }
}

// A read that fails for a reason of its own, such as a bug of the renderer
function broken(): string {
  throw new RangeError('a bug in the renderer')
}

// A read that finds the payload does not fit, as decodeEventPayload throws it
function unreadable(): string {
  throw new EventPayloadError(TOOL_STARTED, 'bad payload')
}

describe(readOrSkip, () => {
  it('hands the result of a read that works on, and warns of nothing', () => {
    const warned = vi.spyOn(console, 'error').mockReturnValue()
    expect(readOrSkip(malformed(TOOL_STARTED, 4), PLAIN, () => 'read')).toBe('read')
    expect(warned).not.toHaveBeenCalled()
  })

  it('lets a failure that is not about the payload go on, and warns of nothing', () => {
    const warned = vi.spyOn(console, 'error').mockReturnValue()
    expect(() => readOrSkip(malformed(TOOL_STARTED, 4), PLAIN, broken)).toThrow(RangeError)
    expect(warned).not.toHaveBeenCalled()
  })

  it('skips an event whose payload does not fit, with one warning that names its type and seq', () => {
    const warned = vi.spyOn(console, 'error').mockReturnValue()
    expect(readOrSkip(malformed(TOOL_STARTED, 4), PLAIN, unreadable)).toBeUndefined()
    expect(warned.mock.calls).toStrictEqual([
      ['Skipped the tool.started event (seq 4): its payload does not fit its type'],
    ])
  })

  it('speaks the language that is set', () => {
    onTestFinished(() => {
      setLocale('en')
    })
    setLocale('cs')
    const warned = vi.spyOn(console, 'error').mockReturnValue()
    readOrSkip(malformed('turn.completed', 9), PLAIN, unreadable)
    expect(warned.mock.calls).toStrictEqual([
      ['Událost turn.completed (pořadové číslo 9) byla přeskočena: její obsah neodpovídá typu'],
    ])
  })
})

describe('transcriptLine and summarizeRun with an event that does not fit its type', () => {
  it('prints no line for the event, and warns once', () => {
    const warned = vi.spyOn(console, 'error').mockReturnValue()
    expect(transcriptLine(malformed(TOOL_STARTED, 6), PLAIN)).toBeUndefined()
    expect(transcriptLine(malformed('workspace.provisioned', 7), PLAIN)).toBeUndefined()
    expect(warned).toHaveBeenCalledTimes(2)
  })

  it('does not count the turn that cannot be read, and counts the others', () => {
    const warned = vi.spyOn(console, 'error').mockReturnValue()
    const events = [
      malformed('turn.completed', 2),
      turnCompleted({ inputTokens: 4, outputTokens: 2 }, 3),
    ]
    expect(summarizeRun(events, PLAIN)).toStrictEqual({
      turns: 1,
      inputTokens: 4,
      outputTokens: 2,
      costUsd: undefined,
    })
    expect(warned.mock.calls).toStrictEqual([
      ['Skipped the turn.completed event (seq 2): its payload does not fit its type'],
    ])
  })
})

function costed(costUsd: number): string {
  return completionLine({ turns: 1, inputTokens: 1, outputTokens: 1, costUsd })
}

describe(completionLine, () => {
  it('states turns and tokens, with the cost when there is one', () => {
    expect(completionLine({ turns: 1, inputTokens: 120, outputTokens: 40, costUsd: 0.016 })).toBe(
      'Done — turns: 1, input tokens: 120, output tokens: 40 ($0.02)',
    )
    expect(completionLine({ turns: 2, inputTokens: 3, outputTokens: 4 })).toBe(
      'Done — turns: 2, input tokens: 3, output tokens: 4',
    )
  })

  it('shows a cost under a cent with four decimals, so that it does not read as nothing', () => {
    expect(costed(0.002)).toMatch(/ \(\$0\.0020\)$/u)
    expect(costed(0.0099)).toMatch(/ \(\$0\.0099\)$/u)
    expect(costed(0)).toMatch(/ \(\$0\.0000\)$/u)
    expect(costed(0.01)).toMatch(/ \(\$0\.01\)$/u)
    expect(costed(12.5)).toMatch(/ \(\$12\.50\)$/u)
  })

  it('speaks Czech when that is the language', () => {
    onTestFinished(() => {
      setLocale('en')
    })
    setLocale('cs')
    expect(completionLine({ turns: 1, inputTokens: 120, outputTokens: 40, costUsd: 0.002 })).toBe(
      'Hotovo — kol: 1, vstupní tokeny: 120, výstupní tokeny: 40 ($0.0020)',
    )
  })
})

describe(titleOf, () => {
  it('keeps a short prompt as it is', () => {
    expect(titleOf('Create src/hello.ts exporting hello()')).toBe(
      'Create src/hello.ts exporting hello()',
    )
  })

  it('takes the first line of a prompt that has several, whatever its line endings', () => {
    expect(titleOf('Fix the build\n\nIt fails on CI')).toBe('Fix the build')
    expect(titleOf('Fix the build\r\nIt fails on CI')).toBe('Fix the build')
    expect(titleOf('\n  Fix the build  \n')).toBe('Fix the build')
  })

  it('cuts at sixty characters without splitting an emoji or a diacritic', () => {
    const emoji = `${'a'.repeat(59)}😀 and more`
    expect(titleOf(emoji)).toBe(`${'a'.repeat(59)}😀`)
    expect(titleOf('Příliš žluťoučký kůň úpěl ďábelské ódy a pokračuje dál a dál do noci')).toBe(
      'Příliš žluťoučký kůň úpěl ďábelské ódy a pokračuje dál a dál',
    )
  })

  it('is empty for an empty prompt', () => {
    expect(titleOf('')).toBe('')
    expect(titleOf('  \n ')).toBe('')
  })
})
```
Run: `bunx vitest run --project bytebureau` → FAIL.

- [ ] **Step 4: Renderers**

`apps/bytebureau/src/render/transcript.ts`:
```ts
import { m } from '@bytebureau/i18n'
import {
  decodeEventPayload,
  EventPayloadError,
  type EventEnvelope,
  type KernelEventPayload,
} from '@bytebureau/protocol'
import type { Output } from '../output.js'

export interface RunSummary {
  readonly turns: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd?: number | undefined
}

const TITLE_LENGTH = 60
const CHARACTERS = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// The first line of the prompt, cut at 60 characters; an emoji or an accented letter is never split
export function titleOf(prompt: string): string {
  const [firstLine = ''] = prompt.trim().split(/\r?\n/u)
  const characters = Array.from(CHARACTERS.segment(firstLine), ({ segment }) => segment)
  return characters.slice(0, TITLE_LENGTH).join('')
}

const TARGET_KEYS = ['path', 'command', 'pattern'] as const

// The one field of a tool input worth a glance: the path, the command or the pattern
function toolTarget(input: unknown): string {
  if (typeof input !== 'object' || input === null) {
    return ''
  }
  for (const key of TARGET_KEYS) {
    const target: unknown = Reflect.get(input, key)
    if (typeof target === 'string') {
      return ` ${target}`
    }
  }
  return ''
}

function toolStartLine(payload: KernelEventPayload<'tool.started'>, output: Output): string {
  return output.colors.dim(`⚙ ${m.run_tool({ name: payload.name })}${toolTarget(payload.input)}`)
}

function toolFailLine(payload: KernelEventPayload<'tool.failed'>, output: Output): string {
  return output.colors.red(`✖ ${payload.name}: ${payload.error}`)
}

function assistantLine(text: string): string | undefined {
  return text === '' ? undefined : text
}

// An event whose payload does not fit its type is skipped, with one warning that names it; any other failure is not the event's
export function readOrSkip<Result>(
  event: EventEnvelope,
  output: Output,
  read: () => Result,
): Result | undefined {
  try {
    return read()
  } catch (error) {
    if (!(error instanceof EventPayloadError)) {
      throw error
    }
    output.warn(m.run_event_skipped({ type: event.type, seq: event.seq }))
    return undefined
  }
}

function lineOf(event: EventEnvelope, output: Output): string | undefined {
  switch (event.type) {
    case 'message.assistant.completed': {
      return assistantLine(decodeEventPayload(event.type, event.payload).text)
    }
    case 'tool.started': {
      return toolStartLine(decodeEventPayload(event.type, event.payload), output)
    }
    case 'tool.failed': {
      return toolFailLine(decodeEventPayload(event.type, event.payload), output)
    }
    case 'session.warning': {
      return output.colors.yellow(`! ${decodeEventPayload(event.type, event.payload).message}`)
    }
    case 'workspace.provisioned': {
      const { branch } = decodeEventPayload(event.type, event.payload)
      return output.colors.dim(m.run_provisioning({ branch }))
    }
    case 'turn.started': {
      return output.colors.dim(m.run_turn_started())
    }
    default: {
      return undefined
    }
  }
}

// One printable line per durable event the user cares about; undefined means "print nothing"
export function transcriptLine(event: EventEnvelope, output: Output): string | undefined {
  return readOrSkip(event, output, () => lineOf(event, output))
}

const NO_TURNS: RunSummary = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: undefined }

function withTurn(
  summary: RunSummary,
  usage: KernelEventPayload<'turn.completed'>['usage'],
): RunSummary {
  return {
    turns: summary.turns + 1,
    inputTokens: summary.inputTokens + usage.inputTokens,
    outputTokens: summary.outputTokens + usage.outputTokens,
    costUsd: usage.costUsd === undefined ? summary.costUsd : (summary.costUsd ?? 0) + usage.costUsd,
  }
}

// A turn that cannot be read is not counted
function withEventTurn(summary: RunSummary, event: EventEnvelope, output: Output): RunSummary {
  const turn = readOrSkip(event, output, () => decodeEventPayload('turn.completed', event.payload))
  return turn === undefined ? summary : withTurn(summary, turn.usage)
}

export function summarizeRun(events: readonly EventEnvelope[], output: Output): RunSummary {
  let summary = NO_TURNS
  for (const event of events) {
    if (event.type === 'turn.completed') {
      summary = withEventTurn(summary, event, output)
    }
  }
  return summary
}

// Under a cent the cost gets four decimals, since it would read as nothing at two
function costText(costUsd: number): string {
  return ` ($${costUsd.toFixed(costUsd < 0.01 ? 4 : 2)})`
}

// The closing line of a run that completed: turns, tokens and, when the provider reports it, the cost
export function completionLine(summary: RunSummary): string {
  return m.run_completed({
    turns: summary.turns,
    input: summary.inputTokens,
    output: summary.outputTokens,
    cost: summary.costUsd === undefined ? '' : costText(summary.costUsd),
  })
}
```

`apps/bytebureau/src/render/ask-prompt.ts`:
```ts
import { m } from '@bytebureau/i18n'
import type { Ask, AskAnswer, AskOption, AskQuestion } from '@bytebureau/protocol'
import { isCancel, select, text, type Option } from '@clack/prompts'

export interface AskPromptOptions {
  readonly yes: boolean
  readonly interactive: boolean
}

// The prompts a person answers through; a test can put others in place of the terminal's
export interface Prompts {
  readonly select: typeof select<string>
  readonly text: typeof text
}

const TERMINAL: Prompts = { select, text }

// The value of the extra choice that lets a person write an answer
const OTHER = '__other__'

// The id of the one recommended option; a question without one, or with several, has none to take
function onlyRecommended(question: AskQuestion): string | undefined {
  const recommended = question.options.filter((option) => option.recommended)
  const [only] = recommended
  return recommended.length === 1 && only !== undefined ? only.id : undefined
}

// --yes: every question gets its recommended option; an ask without that is left to the kernel policy
function recommendedAnswer(ask: Ask): AskAnswer | undefined {
  if (ask.recommendationSource === 'none') {
    return undefined
  }
  const picks = ask.questions.map((question) => onlyRecommended(question))
  return picks.every((pick) => pick !== undefined) ? { selected: picks } : undefined
}

// An agent often marks the label it recommends itself, in English or in Czech, in parentheses or brackets, anywhere in the label: one marker is enough
const MARKED = /[([](?:recommended|doporučeno|doporučený|doporučená)[)\]]/iu

function labelOf(option: AskOption): string {
  const needsMarker = option.recommended && !MARKED.test(option.label)
  return needsMarker ? `${option.label} ${m.run_ask_recommended()}` : option.label
}

function choicesOf(question: AskQuestion): Option<string>[] {
  const choices = question.options.map((option) => ({
    value: option.id,
    label: labelOf(option),
    ...(option.description === undefined ? {} : { hint: option.description }),
  }))
  return question.allowOther ? [...choices, { value: OTHER, label: m.run_ask_other() }] : choices
}

// The recommended option is where the cursor starts, else the first one
function startOf(question: AskQuestion): { readonly initialValue: string } | undefined {
  const [first] = question.options
  const start = question.options.find((option) => option.recommended) ?? first
  return start === undefined ? undefined : { initialValue: start.id }
}

async function writeOwnAnswer(prompts: Prompts): Promise<AskAnswer | undefined> {
  const written = await prompts.text({ message: m.run_ask_other_prompt() })
  return isCancel(written) ? undefined : { selected: 'other', otherText: written }
}

// The questions are put one after the other; "Other" ends them with the words of the person
async function askFrom(
  questions: readonly AskQuestion[],
  selected: readonly string[],
  prompts: Prompts,
): Promise<AskAnswer | undefined> {
  const [question, ...rest] = questions
  if (question === undefined) {
    return { selected }
  }
  const choice = await prompts.select({
    message: `${m.run_ask_header()}: ${question.prompt}`,
    options: choicesOf(question),
    ...startOf(question),
  })
  if (isCancel(choice)) {
    return undefined
  }
  return choice === OTHER ? writeOwnAnswer(prompts) : askFrom(rest, [...selected, choice], prompts)
}

// Undefined when nobody can answer (no --yes and no terminal, a cancel, no recommendation): the kernel policy decides
export async function promptAsk(
  ask: Ask,
  options: AskPromptOptions,
  prompts: Prompts = TERMINAL,
): Promise<AskAnswer | undefined> {
  if (options.yes) {
    return recommendedAnswer(ask)
  }
  const answer = options.interactive ? await askFrom(ask.questions, [], prompts) : undefined
  return answer
}
```

- [ ] **Step 5: The `run` command**

`apps/bytebureau/src/commands/run.ts`:
```ts
import { defineCommand } from 'citty'
import { globalArgs, processContext } from '../context.js'
import { withKernel } from '../kernel.js'
import { runSession } from './run-session.js'

export const runCommand = defineCommand({
  meta: { name: 'run', description: 'Run one prompt through an employee in an isolated worktree' },
  args: {
    ...globalArgs,
    prompt: { type: 'positional', description: 'The task for the employee', required: true },
    project: { type: 'string', description: 'Project path (default: current directory)' },
    branch: { type: 'string', description: 'Base branch (default: the project default branch)' },
    employee: { type: 'string', description: 'Employee id from bytebureau.json' },
    provider: { type: 'string', description: 'Agent provider id (fake, claude, acp:<preset>)' },
    'no-daemon': {
      type: 'boolean',
      description: 'Run the kernel in-process (the only mode in this phase)',
      default: true,
    },
  },
  async run({ args }) {
    const context = processContext(args)
    const options = {
      prompt: args.prompt,
      project: args.project ?? process.cwd(),
      branch: args.branch,
      employee: args.employee,
      provider: args.provider,
      yes: args.yes,
    }
    process.exitCode = await withKernel(context, process.env, async (kernel) => {
      const code = await runSession(kernel, options, context)
      return code
    })
  },
})
```
`apps/bytebureau/src/commands/run-session.ts`:
```ts
import { m } from '@bytebureau/i18n'
import {
  ProviderError,
  SessionError,
  WorkspaceError,
  type CreateSessionInput,
  type EventFilter,
} from '@bytebureau/kernel'
import {
  decodeEventPayload,
  type AnsweredVia,
  type Ask,
  type AskAnswer,
  type EventEnvelope,
  type PromptInput,
} from '@bytebureau/protocol'
import type { Context } from '../context.js'
import type { Output } from '../output.js'
import { promptAsk } from '../render/ask-prompt.js'
import { completionLine, readOrSkip, summarizeRun, titleOf } from '../render/transcript.js'
import { describeError } from '../errors.js'
import { closeFrame, EXIT_REFUSED, open, refuse, report, show, type Outcome } from './run-output.js'

const EXIT_COMPLETED = 0
const EXIT_STOPPED = 3

const TERMINAL = new Set(['session.completed', 'session.stopped', 'session.errored'])

export interface RunOptions {
  readonly prompt: string
  readonly project: string
  readonly branch?: string | undefined
  readonly employee?: string | undefined
  readonly provider?: string | undefined
  readonly yes: boolean
}

// What a run needs of the kernel facade, which has more
export interface RunKernel {
  readonly providers: { readonly list: () => readonly { readonly id: string }[] }
  readonly projects: { readonly register: (path: string) => Promise<{ readonly id: string }> }
  readonly sessions: {
    readonly create: (input: CreateSessionInput) => Promise<{ readonly id: string }>
    readonly prompt: (sessionId: string, input: PromptInput) => Promise<unknown>
    readonly stop: (sessionId: string) => Promise<void>
    readonly complete: (sessionId: string) => Promise<void>
  }
  readonly asks: {
    readonly answer: (askId: string, answer: AskAnswer, via: AnsweredVia) => Promise<void>
  }
  readonly events: { readonly subscribe: (filter: EventFilter) => AsyncIterable<EventEnvelope> }
}

interface Run {
  readonly kernel: RunKernel
  readonly session: { readonly id: string }
  readonly options: RunOptions
  readonly context: Context
}

// Failures that end a run with exit code 4: a project, a runtime or a worktree that cannot be used, a provider that is missing or fails
function isRefusal(error: unknown): boolean {
  if (error instanceof WorkspaceError) {
    return true
  }
  if (error instanceof SessionError) {
    return error.code === 'provider_missing'
  }
  return error instanceof ProviderError
}

// A named provider is checked before anything is registered or created
function unknownProvider(kernel: RunKernel, provider: string | undefined): string | undefined {
  const available = kernel.providers.list().map((candidate) => candidate.id)
  return provider === undefined || available.includes(provider)
    ? undefined
    : m.run_provider_missing({ provider, available: available.join(', ') })
}

// An ask nobody can answer is left to the kernel policy; the person is told the session waits
async function answerAsk({ kernel, options, context }: Run, ask: Ask): Promise<void> {
  const answer = await promptAsk(ask, { yes: options.yes, interactive: context.interactive })
  if (answer === undefined) {
    context.output.warn(m.run_ask_waiting({ title: ask.title }))
    return
  }
  await kernel.asks.answer(ask.id, answer, 'cli')
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
    await run.kernel.sessions.complete(run.session.id)
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

// A stop that fails is only reported; Ctrl-C again ends the process
async function stopSession({ kernel, session, context }: Run): Promise<void> {
  try {
    await kernel.sessions.stop(session.id)
  } catch (error) {
    context.output.warn(describeError(error))
  }
}

// Ctrl-C stops the session; the events then say so and the run ends with the exit code of a stopped one
// The children of the kernel run detached, so the terminal does not reach them: only the stop does
async function followSession(run: Run): Promise<EventEnvelope[]> {
  const { kernel, session, options } = run
  let stopping = Promise.resolve()
  const stop = (): void => {
    stopping = stopSession(run)
  }
  process.once('SIGINT', stop)
  try {
    // The ephemeral events (text deltas) carry no seq of their own and no transcript line
    const events = kernel.events.subscribe({ sessionId: session.id, since: 0, ephemeral: false })
    await kernel.sessions.prompt(session.id, { text: options.prompt })
    return await follow(run, events)
  } finally {
    process.off('SIGINT', stop)
    await stopping
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

async function startAndFollow(
  kernel: RunKernel,
  options: RunOptions,
  context: Context,
): Promise<number> {
  const project = await kernel.projects.register(options.project)
  const session = await kernel.sessions.create({
    projectId: project.id,
    title: titleOf(options.prompt),
    employeeId: options.employee,
    providerId: options.provider,
    branch: options.branch,
  })
  const seen = await followSession({ kernel, session, options, context })
  return conclude(seen, context)
}

// A named provider is refused before anything is registered or created
async function runOrRefuse(
  kernel: RunKernel,
  options: RunOptions,
  context: Context,
): Promise<number> {
  const refusal = unknownProvider(kernel, options.provider)
  if (refusal !== undefined) {
    return refuse(context, refusal)
  }
  const code = await startAndFollow(kernel, options, context)
  return code
}

// Streams one session to its end; the exit code is 0 completed, 3 stopped, 4 project, worktree or provider refused
// A failure that has no exit code of its own closes the frame and goes on to the runner
export async function runSession(
  kernel: RunKernel,
  options: RunOptions,
  context: Context,
): Promise<number> {
  open(context, options.prompt)
  try {
    return await runOrRefuse(kernel, options, context)
  } catch (error) {
    if (!isRefusal(error)) {
      closeFrame(context)
      throw error
    }
    return refuse(context, describeError(error))
  }
}
```
`apps/bytebureau/src/errors.ts`:
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

const KERNEL_ERRORS = [
  ConfigError,
  StoreError,
  WorkspaceError,
  ProviderError,
  AskError,
  PluginError,
  SessionError,
] as const

function field(error: Error, key: string): string | undefined {
  const value: unknown = Reflect.get(error, key)
  return typeof value === 'string' ? value : undefined
}

type Describe = (error: unknown) => string

// The reason a typed error names, else the story of its cause (a StoreError carries nothing but that)
function reasonOf(error: Error, describeCause: Describe): string | undefined {
  const reason = field(error, 'reason')
  return reason === undefined && error.cause !== undefined ? describeCause(error.cause) : reason
}

// A file with its JSON pointer, else the code or the kind of the failure
function whereOf(error: Error): string | undefined {
  const file = field(error, 'file')
  if (file !== undefined) {
    return `${file}${field(error, 'pointer') ?? ''}`
  }
  return field(error, 'code') ?? field(error, 'kind')
}

// A tagged error of the kernel says what went wrong through its name and fields; its message is only the reason
// An error with no message at all is told the same way
function isTyped(error: Error): boolean {
  return error.message === '' || KERNEL_ERRORS.some((type) => error instanceof type)
}

function describeTyped(error: Error, describeCause: Describe): string {
  const reason = reasonOf(error, describeCause)
  const head = reason === undefined ? error.name : `${error.name}: ${reason}`
  const where = whereOf(error)
  return where === undefined ? head : `${head} (${where})`
}

// An error and the errors behind it: "Failed to execute statement: FOREIGN KEY constraint failed"
// An error behind that already begins with what this one says is not told twice
function describeChain(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }
  if (isTyped(error)) {
    return describeTyped(error, describeChain)
  }
  if (error.cause === undefined) {
    return error.message
  }
  const behind = describeChain(error.cause)
  const repeated = behind === error.message || behind.startsWith(`${error.message}: `)
  return repeated ? behind : `${error.message}: ${behind}`
}

// The one line to print for an error: the message, or what a tagged error of the kernel says in place of one
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }
  return isTyped(error) ? describeTyped(error, describeChain) : error.message
}
```
`apps/bytebureau/src/kernel-home.ts`:
```ts
import { homedir } from 'node:os'
import path from 'node:path'

// An empty BYTEBUREAU_HOME names no directory: taken as it is it would put the data in ./data
// A relative one is resolved against the working directory once, so the kernel never depends on where it later runs
export function kernelHome(env: Readonly<Record<string, string | undefined>>): string {
  const home = env['BYTEBUREAU_HOME']
  return home === undefined || home === ''
    ? path.join(homedir(), '.bytebureau')
    : path.resolve(home)
}
```
`run.ts` (the citty runner from SP0) maps a thrown error to exit 2 and now formats typed kernel errors through `errors.ts`; the `run` command sets `process.exitCode` for 0/3/4 and `main.ts` ends with `process.exit((await run(main, process.argv.slice(2))) || (process.exitCode ?? 0))`.

- [ ] **Step 6: `config`, `projects`, `workspaces` commands**

`apps/bytebureau/src/commands/config.ts`:
```ts
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { m } from '@bytebureau/i18n'
import { defaultProjectConfigText } from '@bytebureau/kernel'
import { defineCommand } from 'citty'
import { globalArgs, processContext } from '../context.js'
import { withKernel } from '../kernel.js'

const PROJECT_ARG = {
  type: 'string',
  description: 'Project path (default: current directory)',
} as const

// The kernel refuses a directory that has both
const CONFIG_FILES = ['bytebureau.json', 'bytebureau.jsonc'] as const

// The config file a directory already has, if any
function existingConfig(directory: string): string | undefined {
  return CONFIG_FILES.map((name) => path.join(directory, name)).find((file) => existsSync(file))
}

// Creates the file unless anything is there (a link to nowhere too): the file is never written through a link
function createConfig(file: string): boolean {
  try {
    writeFileSync(file, defaultProjectConfigText(), { flag: 'wx' })
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      return false
    }
    throw error
  }
}

const init = defineCommand({
  meta: {
    name: 'init',
    description: 'Write a commented bytebureau.jsonc with the default employee',
  },
  args: { ...globalArgs, project: PROJECT_ARG },
  run({ args }) {
    const context = processContext(args)
    const directory = path.resolve(args.project ?? process.cwd())
    const file = path.join(directory, 'bytebureau.jsonc')
    const existing = existingConfig(directory)
    if (existing === undefined && createConfig(file)) {
      context.output.print(m.config_init_written({ file }))
      context.output.emit({ command: 'config.init', file })
      return
    }
    context.output.warn(m.config_init_exists({ file: existing ?? file }))
    process.exitCode = 1
  },
})

const validate = defineCommand({
  meta: { name: 'validate', description: 'Validate the layered configuration for a project' },
  args: { ...globalArgs, project: PROJECT_ARG },
  async run({ args }) {
    const context = processContext(args)
    const issues = await withKernel(context, process.env, async (kernel) => {
      const found = await kernel.config.validate(args.project ?? process.cwd())
      return found
    })
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
    const context = processContext(args)
    const document = await withKernel(context, process.env, async (kernel) => {
      await Promise.resolve()
      return kernel.config.schema()
    })
    console.log(JSON.stringify(document, undefined, 2))
  },
})

export const configCommand = defineCommand({
  meta: { name: 'config', description: 'Create, validate and describe the configuration' },
  subCommands: { init, validate, schema },
})
```

`apps/bytebureau/src/commands/projects.ts`:
```ts
import { m } from '@bytebureau/i18n'
import { WorkspaceError } from '@bytebureau/kernel'
import { defineCommand } from 'citty'
import { globalArgs, processContext } from '../context.js'
import { withKernel } from '../kernel.js'

const ls = defineCommand({
  meta: { name: 'ls', description: 'List registered projects' },
  args: { ...globalArgs },
  async run({ args }) {
    const context = processContext(args)
    const projects = await withKernel(context, process.env, async (kernel) => {
      const listed = await kernel.projects.list()
      return listed
    })
    context.output.emit({ command: 'projects.ls', projects })
    if (projects.length === 0) {
      context.output.print(m.projects_none())
      return
    }
    for (const project of projects) {
      context.output.print(
        `${project.id}  ${project.name}  ${project.path}  (${project.defaultBranch})`,
      )
    }
  },
})

const add = defineCommand({
  meta: { name: 'add', description: 'Register a project (default: current directory)' },
  args: {
    ...globalArgs,
    path: { type: 'positional', description: 'Project path', required: false },
  },
  async run({ args }) {
    const context = processContext(args)
    const project = await withKernel(context, process.env, async (kernel) => {
      const registered = await kernel.projects.register(args.path ?? process.cwd())
      return registered
    })
    context.output.emit({ command: 'projects.add', project })
    context.output.print(m.projects_added({ name: project.name, path: project.path }))
  },
})

const rm = defineCommand({
  meta: {
    name: 'rm',
    description:
      'Unregister a project; its worktrees are kept, and it fails while sessions of the project exist',
  },
  args: { ...globalArgs, id: { type: 'positional', description: 'Project id', required: true } },
  async run({ args }) {
    const context = processContext(args)
    try {
      await withKernel(context, process.env, async (kernel) => {
        await kernel.projects.remove(args.id)
      })
    } catch (error) {
      // A project that sessions still belong to is a refusal, not a failure: its reason and exit code 1
      if (!(error instanceof WorkspaceError && error.code === 'has_sessions')) {
        throw error
      }
      context.output.warn(error.reason)
      process.exitCode = 1
      return
    }
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
import { m } from '@bytebureau/i18n'
import { defineCommand } from 'citty'
import { globalArgs, processContext } from '../context.js'
import { withKernel } from '../kernel.js'

const ls = defineCommand({
  meta: { name: 'ls', description: 'List session worktrees' },
  args: { ...globalArgs, project: { type: 'string', description: 'Project id' } },
  async run({ args }) {
    const context = processContext(args)
    const workspaces = await withKernel(context, process.env, async (kernel) => {
      const listed = await kernel.workspaces.list(args.project)
      return listed
    })
    context.output.emit({ command: 'workspaces.ls', workspaces })
    if (workspaces.length === 0) {
      context.output.print(m.workspaces_none())
      return
    }
    for (const workspace of workspaces) {
      context.output.print(
        `${workspace.sessionId}  ${workspace.branch}  ${workspace.sessionStatus}  ${workspace.path}`,
      )
    }
  },
})

const prune = defineCommand({
  meta: {
    name: 'prune',
    description:
      'Remove worktrees of finished sessions that are merged or pushed and older than the retain period',
  },
  args: { ...globalArgs, project: { type: 'string', description: 'Project id' } },
  async run({ args }) {
    const context = processContext(args)
    const report = await withKernel(context, process.env, async (kernel) => {
      const pruned = await kernel.workspaces.prune(args.project)
      return pruned
    })
    context.output.emit({ command: 'workspaces.prune', ...report })
    for (const kept of report.retained) {
      context.output.print(`${kept.path}: ${kept.reason}`)
    }
    context.output.print(
      m.workspaces_pruned({ removed: report.removed.length, retained: report.retained.length }),
    )
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
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { eventLines, jsonLines, payloadOf } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import { tempDir } from '../testing/temp-repo.js'
import {
  configureEmployeeProvider,
  FAKE,
  ON_FAKE,
  PROMPT,
  workbench,
  worktreesOf,
} from '../testing/workbench.js'

describe('bytebureau run (fake provider, no daemon)', () => {
  it('provisions a worktree, streams NDJSON events with increasing seq, answers the ask with --yes and exits 0', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const result = await runCli(['run', PROMPT, '--project', repo, ...FAKE], {
      BYTEBUREAU_HOME: home,
    })
    expect(result.code).toBe(0)
    const events = eventLines(result.stdout)
    const sequence = events.map((line) => line.seq)
    expect(sequence).toStrictEqual([...new Set(sequence)].toSorted((left, right) => left - right))
    expect(events.map((line) => line.type)).toStrictEqual(
      expect.arrayContaining([
        'session.created',
        'workspace.provisioned',
        'turn.started',
        'ask.requested',
        'ask.answered',
        'turn.completed',
        'session.completed',
      ]),
    )
    expect(events.at(-1)).toMatchObject({ type: 'session.completed' })
  })

  it('leaves the file of the agent in the worktree, written as the recommended answer says, and the data in the home', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    await runCli(['run', PROMPT, '--project', repo, ...FAKE], { BYTEBUREAU_HOME: home })
    const [worktree = ''] = readdirSync(worktreesOf(repo))
    const hello = path.join(worktreesOf(repo), worktree, 'src', 'hello.ts')
    expect(readFileSync(hello, 'utf8')).toContain('export function hello()')
    expect(existsSync(path.join(home, 'data', 'bytebureau.db'))).toBe(true)
  })

  it('hands a prompt with CRLF, an emoji and diacritics to the agent unchanged and titles the session by its first line', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const prompt = 'Vytvoř soubor\r\nhello 😀 příliš žluťoučký kůň'
    const result = await runCli(['run', prompt, '--project', repo, ...FAKE], {
      BYTEBUREAU_HOME: home,
    })
    const events = eventLines(result.stdout)
    expect(payloadOf(events, 'message.user')).toStrictEqual({ text: prompt })
    expect(payloadOf(events, 'session.created')).toMatchObject({ title: 'Vytvoř soubor' })
  })
})

describe('bytebureau run when it cannot start', () => {
  it('exits 4 when the provider does not exist and creates nothing', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const env = { BYTEBUREAU_HOME: home }
    const result = await runCli(
      ['run', 'x', '--project', repo, '--provider', 'nope', '--json'],
      env,
    )
    expect(result.code).toBe(4)
    expect(existsSync(path.join(repo, '.bytebureau'))).toBe(false)
    expect(jsonLines(result.stderr)).toStrictEqual([
      { level: 'warn', message: 'Provider "nope" is not available. Available: fake' },
    ])
    const projects = await runCli(['projects', 'ls', '--json'], env)
    expect(jsonLines(projects.stdout)).toStrictEqual([{ command: 'projects.ls', projects: [] }])
  })

  it('exits 4 when the provider of the employee of the project is not available', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    configureEmployeeProvider(repo, 'nope')
    const result = await runCli(['run', 'x', '--project', repo], { BYTEBUREAU_HOME: home })
    expect(result.code).toBe(4)
    expect(result.stderr).toContain(
      'SessionError: provider "nope" is not available; available: fake (provider_missing)',
    )
    expect(existsSync(worktreesOf(repo))).toBe(false)
  })

  it('exits 4 with a one-line reason, and writes nothing, for a project that is not a repository', async () => {
    expect.hasAssertions()
    const directory = tempDir('bb-plain-')
    const result = await runCli(['run', 'x', '--project', directory, ...ON_FAKE], {
      BYTEBUREAU_HOME: tempDir('bb-home-'),
    })
    expect(result.code).toBe(4)
    expect(result.stderr.trim()).toBe(
      `WorkspaceError: ${directory} is not inside a git repository (not_a_repository)`,
    )
    expect(readdirSync(directory)).toStrictEqual([])
  })
})

describe('bytebureau run on a repository without a commit', () => {
  it('exits 4 with the one-line reason of the worktree that cannot be provisioned', async () => {
    expect.hasAssertions()
    const repo = tempDir('bb-empty-')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    const result = await runCli(['run', 'x', '--project', repo, ...ON_FAKE], {
      BYTEBUREAU_HOME: tempDir('bb-home-'),
    })
    expect(result.code).toBe(4)
    const lines = result.stderr.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^WorkspaceError: .*invalid reference: main.* \(git_failed\)$/u)
  })
})

const SLOW = { BYTEBUREAU_FAKE_SCRIPT: 'slow' }

describe('bytebureau run when it is interrupted or nobody answers', () => {
  it('exits 3 and retains the worktree when interrupted mid-turn', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const result = await runCli(
      ['run', 'slow task', '--project', repo, ...FAKE],
      { BYTEBUREAU_HOME: home, ...SLOW },
      { signal: 'SIGINT', afterStdout: '"type":"turn.started"' },
    )
    expect(result.code).toBe(3)
    const types = eventLines(result.stdout).map((line) => line.type)
    expect(types).toContain('turn.interrupted')
    expect(types.at(-1)).toBe('session.stopped')
    expect(readdirSync(worktreesOf(repo))).toHaveLength(1)
  })

  it('leaves the session stopped and its worktree on record, ready to be resumed', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const env = { BYTEBUREAU_HOME: home }
    await runCli(
      ['run', 'slow task', '--project', repo, ...FAKE],
      { ...env, ...SLOW },
      { signal: 'SIGINT', afterStdout: '"type":"turn.started"' },
    )
    const listed = await runCli(['workspaces', 'ls', '--json'], env)
    expect(jsonLines(listed.stdout)).toMatchObject([
      { command: 'workspaces.ls', workspaces: [{ sessionStatus: 'stopped', exists: true }] },
    ])
  })

  it('waits for an answer, and says so, when the ask cannot be answered without --yes', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const result = await runCli(
      ['run', PROMPT, '--project', repo, ...ON_FAKE, '--json'],
      { BYTEBUREAU_HOME: home },
      { signal: 'SIGINT', afterStdout: '"type":"session.waiting"' },
    )
    expect(result.code).toBe(3)
    const types = eventLines(result.stdout).map((line) => line.type)
    expect(types).not.toContain('ask.answered')
    const messages = jsonLines(result.stderr).map((line) => line['message'])
    expect(messages).toContain(
      'The employee is waiting for your answer to "Export style" (not answered automatically)',
    )
  })
})

describe('bytebureau run read by a person', () => {
  it('prints plain lines, without decoration, to a pipe', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const result = await runCli(['run', PROMPT, '--project', repo, ...ON_FAKE, '--yes'], {
      BYTEBUREAU_HOME: home,
    })
    expect(result.code).toBe(0)
    const lines = result.stdout.trim().split('\n')
    expect(lines[0]).toMatch(/^Preparing the workspace on branch bb\//u)
    expect(lines.slice(1, 4)).toStrictEqual([
      'The employee is working…',
      '⚙ Write src/hello.ts',
      'Created src/hello.ts exporting hello().',
    ])
    expect(lines.at(-1)).toBe('Done — turns: 1, input tokens: 120, output tokens: 40 ($0.0020)')
    expect(result.stdout).not.toContain('│')
  })

  it('speaks Czech when asked to', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const result = await runCli(
      ['run', PROMPT, '--project', repo, ...ON_FAKE, '--yes', '--lang', 'cs'],
      { BYTEBUREAU_HOME: home },
    )
    const lines = result.stdout.trim().split('\n')
    expect(lines[0]).toMatch(/^Připravuji pracovní prostor na větvi bb\//u)
    expect(lines.at(-1)).toBe('Hotovo — kol: 1, vstupní tokeny: 120, výstupní tokeny: 40 ($0.0020)')
  })
})
```
`apps/bytebureau/src/testing/run-cli.ts`:
```ts
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { onTestFinished } from 'vitest'
import { tempDir } from './temp-repo.js'

const CLI_DIRECTORY = fileURLToPath(new URL('../..', import.meta.url))
const BASE_ENV = {
  PATH: process.env['PATH'] ?? '',
  HOME: process.env['HOME'] ?? '',
  LANG: 'en_US.UTF-8',
  // The git of a test never reads the configuration of the person who runs the tests
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

// A test that names no home for the CLI gets a throwaway one, never that of the person who runs the tests
export function childEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  return { ...BASE_ENV, BYTEBUREAU_HOME: env['BYTEBUREAU_HOME'] ?? tempDir('bb-home-'), ...env }
}

export interface CliResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

// The signal goes out once the CLI has printed the text: no timing guess about how far the run has got
export interface Interruption {
  readonly signal: 'SIGINT' | 'SIGTERM'
  readonly afterStdout: string
}

type Child = ChildProcessByStdio<null, Readable, Readable>

interface Captured {
  stdout: string
  stderr: string
}

function capture(child: Child, interruption: Interruption | undefined): Captured {
  const captured: Captured = { stdout: '', stderr: '' }
  let signalled = false
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    captured.stdout += chunk
    if (
      interruption !== undefined &&
      !signalled &&
      captured.stdout.includes(interruption.afterStdout)
    ) {
      signalled = true
      child.kill(interruption.signal)
    }
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    captured.stderr += chunk
  })
  return captured
}

// Runs the CLI from source in a Bun process; a process still alive when the test ends is killed
export async function runCli(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
  interruption?: Interruption,
): Promise<CliResult> {
  const child = spawn('bun', ['run', 'src/main.ts', ...args], {
    cwd: CLI_DIRECTORY,
    env: childEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  onTestFinished(() => {
    child.kill('SIGKILL')
  })
  const captured = capture(child, interruption)
  const { promise, resolve, reject } = Promise.withResolvers<CliResult>()
  child.once('error', reject)
  child.once('close', (code) => {
    resolve({ code: code ?? -1, stdout: captured.stdout, stderr: captured.stderr })
  })
  const result = await promise
  return result
}
```
`apps/bytebureau/src/testing/temp-repo.ts`:
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()
}

// Symlinks are resolved, as git reports paths: on macOS /var is a link to /private/var
// The directory is removed when the running test has finished
export function tempDir(prefix: string): string {
  const created = mkdtempSync(path.join(tmpdir(), prefix))
  const dir = realpathSync(created)
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

// A repository with one commit on `main`
export function createTempRepo(): string {
  const dir = tempDir('bb-repo-')
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(path.join(dir, 'README.md'), '# fixture\n')
  git(dir, 'add', 'README.md')
  git(dir, 'commit', '-q', '-m', 'initial')
  return dir
}
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
- Create: `docs/decisions/0010-sqlite-through-effect-sql.md`, `docs/decisions/0011-configuration-files-are-data.md` (jsonc-parser instead of c12, JSON/JSONC only, `extends` deferred as a kernel-native feature, binaries built with Bun's dotenv and bunfig autoload off)
- Modify: `.github/workflows/ci.yml` (the kernel smoke step in `build-smoke`, `smoke-arm64` and `smoke-macos`, with `HOME_DIR=$(mktemp -d)` on its own line and the last three events printed on failure), `scripts/build-binaries.ts` + `scripts/build-binaries.test.ts` (`compileArgs` with `--no-compile-autoload-dotenv` and `--no-compile-autoload-bunfig` — a cwd `bunfig.toml` preload used to run on `bytebureau --version` and a cwd `.env` could move `BYTEBUREAU_HOME`), `CONTRIBUTING.md` ("Working in the kernel", links to ADR-0003/0010/0011), `apps/docs/src/content/docs/architecture.md` (package table, run flow, Phase A decisions), `README.md` + `README.cs.md` (status lines), `vitest.config.ts` (`context.ts` in the coverage include), `cspell-words.txt`; `bunfig.toml` and `.dependency-cruiser.cjs` verified unchanged

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
`docs/decisions/0011-configuration-files-are-data.md` (ruled during Task 5, written here):
```markdown
# Configuration files are data: JSON and JSONC read as text, c12 dropped

- Status: accepted
- Date: 2026-10-03

## Context and problem statement

The kernel merges `~/.bytebureau/config.json`, `<project>/bytebureau.json`, `<project>/bytebureau.local.json`, `BYTEBUREAU_*` variables and flags, and a project file comes from a repository the user has just cloned. The first loader was c12. With its RC files, dotenv, environment-specific keys, `package.json`, `extends` and giget switched off it was still a code loader and a normaliser: it imported the target of a symbolic link, turned a scalar root into `{}` and dropped top-level `null` sections and `$meta` before validation, so a file the schema would have rejected passed.

## Decision

The kernel reads `bytebureau.json` or `.jsonc`, `bytebureau.local.json` or `.jsonc` and `~/.bytebureau/config.json` or `.jsonc` as text and parses it with `jsonc-parser@3.3.1` (comments and trailing commas allowed); nothing is imported or run. Of the two extensions at most one may exist per layer, and only a regular file counts: a link to a file is read, a link to nowhere is an error, a directory of that name is ignored. A syntax error names its code, line and column, and a root that is not an object is an error of its file. The merged layers are validated with `effect/Schema` (unknown keys are errors), and every issue carries a JSON pointer and the layer that holds it: the file, `env:<NAME>` for a `BYTEBUREAU_*` variable or `flag:<key>` for a flag. The `extends` of team presets from the spec is deferred to a later phase as a kernel-native feature: JSON or JSONC presets by relative path, merged as the lowest project layer, with cycle detection. The binaries are built with `--no-compile-autoload-dotenv` and `--no-compile-autoload-bunfig` for the same reason: Bun would otherwise read a `.env` and run a `bunfig.toml` preload from the directory the binary starts in.

## Consequences

A configuration file can never run code, and a file that does not fit the schema is reported where it is wrong instead of being repaired silently. There are no `.ts` or `.js` config files, no dotenv loading and no remote presets, and until presets return `extends` is an unknown key. The loader is a small module the project owns and tests (`packages/kernel/src/config`) instead of a dependency to configure away.
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
As shipped, all three smoke jobs carry the step with their binary glob (`linux-x64`, `linux-arm64` with a `chmod +x` after the artifact download, `darwin-arm64`), `HOME_DIR=$(mktemp -d)` assigned on its own line and `tail -n 3 events.ndjson` printed when a check fails. The step is the only place the compiled binary runs the kernel in CI (the CLI subprocess tests also run `StoreLive` under Bun, from source). `bun run lint:actions` → clean (no new `uses:`).

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
