# ByteBureau — Sub-project 1: Kernel & agent runtime (design spec)

Date: 2026-10-02 · Status: approved design, awaiting written-spec review · Scope: one implementation plan (large; the plan is phased)
Inputs: [research synthesis](../../research/2026-10-02-technology-landscape.md), [requirements checklist](../../research/2026-10-02-requirements-checklist.md), [Foundation spec](./2026-10-02-foundation-design.md)
Requirement IDs covered: W03 W04 (plain-prompt path) G07 G08 G09 G10 A02 (headless) A05 (service) A07 A08 A09 A14 (custom employees) A19 A31 A32 A33 A37 (context data) A38 A40 A44 A45 A47 F01

## 1. Goal

A headless daemon plus CLI that can take a plain prompt, prepare an isolated git worktree for a project, run it through a pluggable coding-agent backend (Claude Code via the Agent SDK, or any ACP agent such as Codex, Gemini CLI, OpenCode, Pi), stream a canonical event log, broker questions and permissions to a human with a recommended option, report usage and rate-limit state per auth profile, and expose all of it over an OpenAPI/SSE/WebSocket API consumed by the CLI now and by the web UI, simulation, telemetry and phone client later.

Non-goals: ticket→PR workflow (SP4), employee roster beyond one default (SP4), skills sync (SP4), web UI (SP2), simulation (SP3), containers (SP5), desktop/installers (SP6), relay (SP7), OTLP receiver and trajectory analysis (SP8). The data model and events are designed so those sub-projects extend rather than rework them.

## 2. Architecture

Hexagonal: `packages/kernel` holds domain and application services as Effect 4 Layers; `packages/api` is the primary adapter (HTTP/OpenAPI, SSE, WebSocket RPC); plugins are secondary adapters implementing ports declared in `packages/plugin-api`; `packages/protocol` holds the shared schemas and types; `packages/client` is the generated client; `apps/bytebureau` wires everything into one binary.

```
apps/bytebureau ── CLI (citty) ──► packages/client ──► packages/api (effect/http-api + effect/rpc + SSE)
                └─ daemon ────────────────────────────► packages/kernel (Effect services)
                                                          ├─ ports (plugin-api): AgentProvider, WorkspaceRuntime, SecretStore, Notifier(later)
                                                          └─ plugins/agent-claude · plugins/agent-acp · plugins/workspace-local
packages/protocol ── effect/schema DTOs + event/command schemas → JSON Schema, OpenAPI
```

Dependency rules (enforced by dependency-cruiser from SP0): only `kernel`, `api` and `protocol` import `effect`; `plugin-api`, `client` and plugins are plain TypeScript with Promise/AsyncIterable signatures; plugins import only `@bytebureau/plugin-api`, `@bytebureau/protocol` and third-party packages.

Process topology: one daemon per user machine (`bytebureau serve`) serving all registered projects; the CLI is a thin client that starts the daemon on demand. `--no-daemon` runs the kernel in-process for one-shot headless use (CI, Raspberry Pi scripts).

## 3. Packages

| Package | Contents | Licence |
|---|---|---|
| `packages/protocol` | effect/schema definitions for every DTO, event, command and API payload; generated JSON Schema (`schemas/*.json`) and the OpenAPI document; type-only exports for non-Effect consumers | MIT |
| `packages/plugin-api` | `definePlugin()`, `PluginManifest`, `PluginContext`, port interfaces (§6), hook types, Standard Schema V1 type; re-exports protocol types | MIT |
| `packages/client` | TypeScript client generated from the OpenAPI document plus a WebSocket/SSE subscription helper with resume; no Effect at runtime | MIT |
| `packages/kernel` | services (§4), persistence (§5), plugin host (§7), event log, error types, test utilities (fake provider, fake clock) | FSL-1.1-MIT |
| `packages/api` | HTTP API groups, SSE endpoint, RPC over WebSocket, auth middleware, OpenAPI generation at build time | FSL-1.1-MIT |
| `plugins/agent-claude` | Claude adapter via `@anthropic-ai/claude-agent-sdk` (§8.1) | FSL-1.1-MIT |
| `plugins/agent-acp` | generic ACP adapter via `@agentclientprotocol/sdk` with presets (§8.2) | FSL-1.1-MIT |
| `plugins/workspace-local` | git worktree workspace runtime on the host (§9) | FSL-1.1-MIT |
| `apps/bytebureau` | CLI commands (§11), daemon bootstrap, bundled-plugin registry, embedded assets slot for the web UI (SP2) | FSL-1.1-MIT |

Exact package names for Effect platform/SQL integrations (Bun platform layer, SQLite driver, Drizzle bridge) are resolved by the implementation plan from the registry against the pinned Effect 4 release; the behaviour specified here does not depend on which of the candidate packages is used.

## 4. Kernel services (Effect Layers)

| Service | Responsibility | Key operations |
|---|---|---|
| `Config` | load and validate layered configuration (§10) with c12; expose typed config; emit JSON Schema for `$schema`; watch project config for changes | `load(projectPath?)`, `get()`, `schema()` |
| `Store` | SQLite connection (WAL, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`), migrations applied at startup, single writer (daemon) | `migrate()`, `sql` client |
| `EventLog` | append-only durable events with monotonic `seq`; ephemeral events fan-out; replay from `seq` then live | `publish(event)`, `subscribe(filter, since?)`, `read(filter, range)` |
| `ProjectRegistry` | register/unregister projects (path, name, default branch), detect git root, load per-project config | `register(path)`, `list()`, `get(id)`, `remove(id)` |
| `ProfileService` | named auth profiles per provider (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, API-key profiles); default profile per provider; auth status checks via the provider | `list()`, `add()`, `remove()`, `setDefault()`, `status(profileId)` |
| `SecretStore` | OS keychain through `@napi-rs/keyring` (service `bytebureau`, account `<profileId>/<key>`); fallback to `~/.bytebureau/secrets.age` (age-encrypted, passphrase cached in memory for the daemon lifetime) when the keychain is unavailable (headless Linux, compiled binary without native addon support) | `get`, `set`, `delete`, `backend()` |
| `Supervisor` | spawn and supervise child processes (agent CLIs, git, helpers) with bounded line buffers, graceful termination (SIGINT → SIGTERM after 5 s → SIGKILL after 10 s), restart policy with exponential backoff, explicit env allowlist, `TRACEPARENT` injection | `spawn(spec)`, `kill(id)`, `list()` |
| `WorkspaceManager` | provision/destroy workspaces through the selected `WorkspaceRuntime` port; locking while a session runs; cleanup policy; `git` wrapper | `provision(spec)`, `status(id)`, `destroy(id)`, `prune()` |
| `SessionManager` | session lifecycle (§5.2), turn execution, translation of provider events into kernel events, steering and interruption, resume | `create()`, `prompt()`, `interrupt()`, `stop()`, `resume()`, `list()`, `get()` |
| `AskService` | broker for questions and permission requests (§8.4); persistence; answer routing; timeout policy | `open()`, `answer()`, `cancel()`, `pending()` |
| `UsageService` | per-profile rate-limit snapshots and per-session token/context accounting from sanctioned signals only | `snapshot(profileId)`, `sessionUsage(sessionId)` |
| `PluginHost` | discovery, manifest validation, config validation (Standard Schema), lifecycle, port registry, hook bus (§7) | `load()`, `ports<T>()`, `hooks.run()` |
| `Logging` / `Tracing` | Effect tracer for spans around every service operation; Effect logger routed into LogTape (§12) | — |
| `Health` | checks used by `/health` and `bytebureau doctor` (§11) | `check()` |

All services are provided by a `KernelLive` layer; tests compose `KernelTest` with in-memory SQLite, `TestClock`, a fake `AgentProvider` and a temp-dir `WorkspaceRuntime`.

## 5. Domain model and persistence

### 5.1 Identifiers and time
IDs are UUIDv7 strings (time-ordered). Timestamps are ISO-8601 UTC. Every event carries `seq` (global, assigned by the store) and optional `projectId`, `sessionId`, `turnId`, `workItemId` (reserved for SP4), `traceId`, `spanId`.

### 5.2 Entities (SQLite tables; Drizzle schema in `packages/kernel/src/store/schema.ts`)
- `projects(id, name, path UNIQUE, default_branch, config_json, created_at, updated_at)`
- `profiles(id, provider_id, name, kind 'login'|'api_key', config_dir, is_default, created_at)` — secrets never stored here.
- `sessions(id, project_id, title, employee_json, provider_id, profile_id, workspace_json, external_ref, status, created_at, started_at, ended_at, parent_session_id)` with `status ∈ created | provisioning | ready | running | waiting_for_human | paused_usage_limit | completed | stopped | errored`.
- `turns(id, session_id, index, prompt_json, status 'running'|'completed'|'interrupted'|'errored', stop_reason, usage_json, started_at, ended_at)`.
- `messages(id, session_id, turn_id, role 'user'|'assistant'|'system', content_json, created_at)` — projection of completed messages (deltas are not stored).
- `tool_calls(id, session_id, turn_id, tool_name, kind 'builtin'|'mcp'|'bash'|'subagent'|'skill', input_json, output_summary, input_bytes, output_bytes, status, started_at, ended_at, error_type)` — full tool output is not persisted in SP1 beyond a capped summary (32 KB).
- `asks(id, session_id, turn_id, kind 'question'|'permission', payload_json, status 'pending'|'answered'|'expired'|'cancelled', answer_json, recommendation_source 'agent'|'policy'|'none', created_at, deadline_at, answered_at, answered_via)`.
- `events(seq INTEGER PRIMARY KEY AUTOINCREMENT, id, ts, type, project_id, session_id, turn_id, work_item_id, trace_id, span_id, payload_json)` with indexes on `(session_id, seq)` and `(project_id, seq)`.
- `usage_snapshots(profile_id, five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at, source, observed_at)`.
- `plugin_kv(plugin_id, key, value_json, PRIMARY KEY(plugin_id, key))`.
- Drizzle's migrations table.

Location: `~/.bytebureau/data/bytebureau.db` (override `BYTEBUREAU_HOME`). Per-project `.bytebureau/` holds only `worktrees/`, `sessions/<id>/` (raw agent stdout/stderr when `--debug`), `logs/`, `cache/`, `employees/*.md`, `plugins/`. ByteBureau adds `.bytebureau/` to the project's `.git/info/exclude` and never edits the project's `.gitignore`.

### 5.3 Session state machine
```
created ─provision─▶ provisioning ─▶ ready ─prompt─▶ running ─ask─▶ waiting_for_human ─answer─▶ running
running ─turn done─▶ ready            running ─rate limit─▶ paused_usage_limit ─resets_at/auto-continue─▶ running
ready|running ─stop─▶ stopped         running ─provider crash (after retries)─▶ errored        ready ─complete─▶ completed
```
Interrupt keeps the session `running` until the provider acknowledges, then `ready`. Resume (`bytebureau sessions resume <id>`) re-attaches to the provider session via `external_ref` when the provider supports it, otherwise starts a new provider session with the stored transcript as context (provider-specific, see §8).

### 5.4 Event catalogue (SP1)
Durable (persisted): `project.registered|updated|removed`, `profile.added|removed|status`, `session.created|provisioning|ready|running|waiting|paused|resumed|stopped|completed|errored`, `turn.started|completed|interrupted`, `message.user`, `message.assistant.completed`, `tool.started|completed|failed`, `subagent.started|stopped`, `ask.requested|answered|expired|cancelled`, `usage.updated` (per turn end and on rate-limit change), `ratelimit.updated`, `compaction.started|completed`, `workspace.provisioned|destroyed|retained`, `plugin.loaded|failed`, `session.warning` (api retry, degraded capability).
Ephemeral (fan-out only): `message.assistant.delta` (text and thinking chunks), `tool.progress`, `heartbeat`.
Every event type has an effect/schema definition in `packages/protocol/src/events/*.ts`; the JSON Schema is generated into the package and served at `/api/v1/schemas/events.json`.

## 6. Ports (`packages/plugin-api`)

```ts
export interface AgentProvider {
  readonly id: string                       // 'claude' | 'acp:<preset>' | custom
  readonly displayName: string
  readonly capabilities: {
    resume: boolean; interrupt: boolean; askUser: boolean; permissions: boolean
    structuredOutput: boolean; usage: boolean; rateLimits: boolean; contextUsage: boolean
    thinking: boolean; setModel: boolean; setEffort: boolean; attachments: boolean
  }
  authStatus(profile: ProfileRef): Promise<AuthStatus>          // loggedIn | loggedOut | expired | unknown (+ hint command)
  listModels?(profile: ProfileRef): Promise<ModelInfo[]>
  createSession(req: CreateSessionRequest): Promise<AgentSession>
}
export interface CreateSessionRequest {
  sessionId: string; workspace: { path: string }; employee: EmployeeSpec; profile: ProfileRef
  resume?: ExternalSessionRef; env: Record<string, string>; signal: AbortSignal; logger: Logger
}
export interface AgentSession {
  readonly externalRef: ExternalSessionRef | null
  prompt(input: PromptInput): Promise<void>                      // queues a turn or steers a running one
  interrupt(): Promise<void>
  answer(askId: string, answer: AskAnswer): Promise<void>
  setModel?(model: string): Promise<void>; setEffort?(effort: Effort): Promise<void>
  events(): AsyncIterable<AgentEvent>                           // canonical events (§8.3)
  close(): Promise<void>
}
export interface WorkspaceRuntime {
  readonly id: string                                            // 'local' | 'docker' (SP5) | 'k8s' (later)
  readonly isolation: 'none' | 'process' | 'container' | 'vm'
  provision(spec: WorkspaceSpec): Promise<WorkspaceHandle>
  exec(handle: WorkspaceHandle, spec: ExecSpec): Promise<ExecHandle>
  status(handle: WorkspaceHandle): Promise<WorkspaceStatus>      // dirty, ahead, behind, locked, branch
  destroy(handle: WorkspaceHandle, opts?: { force?: boolean }): Promise<void>
}
export interface SecretStore { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void>; delete(key: string): Promise<void> }
```
`EmployeeSpec = { id, name, provider, model, effort: 'low'|'medium'|'high'|'xhigh'|'max'|null, systemPrompt: string, tools: { allow: string[]; deny: string[] }, permissionMode: 'supervised'|'autonomous'|'yolo', skills: string[], maxTurns?: number, askTimeout?: string, appearance: { gender?: string; body?: string; hair?: string; outfit?: string; palette?: string } }`.
`PromptInput = { text: string; attachments?: Array<{ path: string; mime?: string }> }`.
All payloads are DTOs (no functions); streams are `AsyncIterable`; cancellation is an `AbortSignal`.

## 7. Plugin host

- Manifest in `package.json` under `"bytebureau"` (or `bytebureau-plugin.json` for directory plugins): `name`, `version`, `hostApi` (semver range of `@bytebureau/plugin-api`), `kind: 'in-process'` (only kind implemented in SP1; `subprocess`, `mcp`, `acp`, `wasm` reserved), `entry` (default `exports["./plugin"]`), `capabilities` (declared, displayed, not enforced in SP1), `config` (Standard Schema V1 object; its JSON Schema is merged into the project config `$schema` under `plugins.<name>`), `secrets` (declared keys with titles), `contributes` (port ids, for discovery without loading).
- Discovery order: bundled plugins compiled into the binary (`agent-claude`, `agent-acp`, `workspace-local`), then `bytebureau.json#plugins` entries (npm package name, local path, or `{ npm, version }`), then `<project>/.bytebureau/plugins/*`, then `~/.bytebureau/plugins/node_modules/*` matching keyword `bytebureau-plugin`. Installs run with lifecycle scripts disabled.
- Lifecycle: `setup(ctx)` returns a `PluginRegistration` (`agentProviders`, `workspaceRuntimes`, `secretStores`, `hooks`, `dispose`). A plugin whose manifest, config or setup fails is recorded as `plugin.failed` and skipped; the daemon keeps running.
- `PluginContext`: `config` (validated), `project` (nullable), `logger` (LogTape child category `bb.plugin.<name>`), `events` (publish/subscribe typed), `secrets` (namespaced), `kv` (namespaced `plugin_kv`), `process` (supervised spawn with budgets), `http: fetch`, `signal`.
- Hooks (middleware `(event, next) => Promise<Result>` executed in registration order): `session.beforeCreate`, `agent.beforeSpawn` (rewrite env/args or deny), `ask.beforeOpen` (route or auto-answer by policy), `prompt.beforeSend`, `event.beforePublish` (observe only). Hook errors are logged and treated as "continue" unless the hook explicitly denies.
- Version gate: a plugin declaring an incompatible `hostApi` range is refused with a clear message naming both versions.

## 8. Agent adapters

### 8.1 `plugins/agent-claude` (Claude Code through the Agent SDK)
- Uses `@anthropic-ai/claude-agent-sdk` `query()` in streaming-input mode so one provider session spans many turns; `prompt()` pushes a user message (queued follow-ups steer a running turn); `interrupt()` calls the SDK interrupt.
- Binary selection: the user's installed `claude` (resolved from PATH or `providers.claude.executable` in config) is passed to the SDK; the SDK's bundled binary is used only when none is installed. The binary is never modified; `--bare` is never used; `settingSources` is explicit (`['user','project','local']` by default, configurable).
- Profiles: `kind: 'login'` sets `CLAUDE_CONFIG_DIR` to the profile directory; the user performs `claude /login` there themselves (`bytebureau profiles add claude <name>` prints the exact command and waits for completion). `kind: 'api_key'` reads the key from `SecretStore` and injects `ANTHROPIC_API_KEY` into the child environment only. ByteBureau never reads, copies or stores OAuth credentials.
- Options mapping: `cwd` = workspace path; `model`, `effort` from the employee; `systemPrompt = { preset: 'claude_code', append: employee.systemPrompt + ByteBureau conventions (§8.4) }`; `allowedTools`/`disallowedTools` from `employee.tools`; `maxTurns`; `includePartialMessages: true`; `env` = allowlisted env + profile vars + `TRACEPARENT` + `BYTEBUREAU_SESSION_ID`; `resume` from `external_ref`; hooks `SessionStart`, `PreToolUse`, `PostToolUse`, `SubagentStart/Stop`, `PreCompact/PostCompact`, `Stop` registered programmatically to emit canonical events; `canUseTool` routes permission prompts and `AskUserQuestion` to `AskService`.
- Permission modes: `supervised` → SDK `default` with every prompt brokered; `autonomous` → SDK `auto` (classifier) with ByteBureau deny rules; `yolo` → refused in SP1 because the local workspace runtime has `isolation: 'none'` (enabled by SP5 for container runtimes).
- Event mapping: `system/init` → `session.ready` (model, tools, plugins, capabilities); `assistant` content blocks → `message.assistant.delta|completed`, `tool.started`; `user` tool results → `tool.completed|failed` with sizes; `stream_event` deltas → ephemeral deltas; `result` → `turn.completed` with `usage_json` (`total_cost_usd`, per-model usage, `num_turns`, `permission_denials`); `system/api_retry` → `session.warning`; compaction boundary → `compaction.completed`; SDK rate-limit events → `ratelimit.updated` and, when the limit is reached, `session.paused` with `resets_at`; `getContextUsage()` after each turn → `usage.updated` with context percentage; `accountInfo()` at session start → profile status.
- Auth status: `authStatus()` runs the SDK account check under the profile environment; failures map to `loggedOut`/`expired` with the hint `CLAUDE_CONFIG_DIR=<dir> claude /login`.

### 8.2 `plugins/agent-acp` (any ACP v1 agent)
- Speaks ACP over stdio using `@agentclientprotocol/sdk`: `initialize` (client capabilities: fs read/write, terminal), `session/new` (cwd = workspace, MCP servers from config), `session/prompt`, `session/update` notifications → canonical events (`agent_message_chunk` → deltas, `agent_thought_chunk` → thinking deltas, `tool_call`/`tool_call_update` → tool events, `plan` → `session.warning` kind `plan` payload), `session/request_permission` → `AskService` (`allow_once|allow_always|reject_once|reject_always` mapped to ByteBureau answers), `session/cancel` for interrupt, `session/load` for resume when advertised.
- Client-side methods implemented by the kernel: `fs/read_text_file`, `fs/write_text_file` confined to the workspace path (paths outside are rejected), `terminal/create|output|wait_for_exit|kill|release` backed by `Supervisor`.
- Presets (command, args, env, capability flags, model/effort passing): `codex` (`codex-acp`), `gemini` (Gemini CLI ACP mode), `opencode` (`opencode acp`), `pi` (`pi-acp`), plus `custom` (user-provided command). Profiles map to the agent's own config directory (`CODEX_HOME` for Codex; the user logs in with the vendor CLI).
- Capability flags: `usage`/`rateLimits`/`contextUsage` are `false` unless the agent provides `_meta` extensions (`bytebureau.usage`, `bytebureau.rateLimit`) that the adapter forwards.

### 8.3 Canonical `AgentEvent`
`turn.started`, `message.delta { kind: 'text'|'thinking', text }`, `message.completed { role, content[] }`, `tool.started { id, name, kind, input }`, `tool.completed { id, outputSummary, bytes }`, `tool.failed { id, error }`, `subagent.started|stopped { id, name }`, `ask.requested { ask }`, `usage.updated { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd?, contextPct? }`, `ratelimit.updated { fiveHourPct?, fiveHourResetsAt?, sevenDayPct?, sevenDayResetsAt? }`, `compaction.started|completed`, `turn.completed { stopReason, usage }`, `session.warning { kind, message }`, `session.error { kind: 'auth'|'ratelimit'|'crash'|'protocol', message, retryable }`, `session.closed`, `raw { providerEvent }` (emitted only when `--debug` includes `agent.raw`).

### 8.4 Asking dialog contract
- `Ask = { id, sessionId, turnId, kind: 'question'|'permission', title, questions: Array<{ id, header (≤12 chars), prompt, options: Array<{ id, label, description, recommended: boolean, evidence: Array<{ kind: 'file'|'test'|'doc'|'ticket'|'rule', ref, excerpt? }> }>, multiSelect: boolean, allowOther: boolean }>, toolCall?: { name, input }, policy: { onTimeout: 'wait'|'recommended'|'deny', timeout: string }, recommendationSource: 'agent'|'policy'|'none' }`.
- Exactly one option per question is `recommended: true`. For questions, the employee system prompt appended by ByteBureau instructs the agent to mark the recommended option by placing it first with the suffix "(Recommended)" and a one-line evidence note; the adapter parses this into `recommended` + `evidence` and sets `recommendationSource: 'agent'`. For permission requests, the kernel derives the recommendation from policy rules (read-only commands and in-workspace edits → allow recommended; rules matching `git push --force`, `rm -rf` outside the workspace, secrets paths, network tools in `supervised` mode → deny recommended; evidence = rule id) with `recommendationSource: 'policy'`. If neither applies, `recommendationSource: 'none'` and no option is marked (the UI shows "no recommendation available"); this is logged as a prompt-quality warning.
- Timeout policy: `supervised` employees wait indefinitely (notifying clients); `autonomous` employees proceed with the recommended option after `askTimeout` (default `30m`) for `question` asks only; permission asks never auto-allow on timeout — they follow the provider's own permission mode, and on timeout the kernel answers `deny` with the message "nobody available to approve; do not retry".
- Answers: `{ selected: string[] | 'other', otherText?, remember?: 'session'|'always' }` via API, CLI (interactive select with the recommended option preselected; `--yes` picks it), and later UI/phone/chat plugins. `ask.answered` records `answered_via`.

## 9. `plugins/workspace-local` (host git worktree)

- `provision`: verify `git` ≥ 2.40 and that the project is a repository; fetch the base ref (throttled to once per 60 s per project, skipped when offline with a warning); `git worktree add <project>/.bytebureau/worktrees/<sessionId> -b <branch> <baseRef>` where `branch = bb/<slug>` (`slug` = kebab-case of the session title or `s-<short id>`; collisions get `-2`, `-3`) and `baseRef` = the session's chosen branch (`origin/<branch>` when the remote exists, otherwise the local branch); copy files listed in `workspace.copyIgnored` from the main checkout; write `.bytebureau/worktrees/<sessionId>/.bytebureau-session.json` with ids; add `.bytebureau/` to `.git/info/exclude`.
- `exec`: spawn through `Supervisor` with `cwd` = worktree path and the allowlisted environment.
- `status`: `git status --porcelain=v2`, ahead/behind against `baseRef`, lock state.
- `destroy`: refuse while locked; `git worktree remove` when clean and `force` not required; otherwise keep and emit `workspace.retained { reason }`. `WorkspaceManager.prune()` removes worktrees of sessions in a terminal state whose branches are merged or pushed and whose age exceeds `workspace.retainDays` (default 7).
- Never operates on the main checkout; refuses to provision when the project path itself is a worktree of another ByteBureau session.

## 10. Configuration

Precedence: CLI flags > environment (`BYTEBUREAU_*`) > `<project>/bytebureau.local.json` (gitignored) > `<project>/bytebureau.json` (or `.jsonc`) > `~/.bytebureau/config.json` > defaults. Loader: c12 with JSON/JSONC documented; `extends` supported for team presets. Validation: effect/schema; errors report the file and JSON pointer; unknown keys are errors; plugin sections are validated by the plugin's Standard Schema.

Project config v1 (`"$schema": "https://bytebureau.dev/schema/v1/config.json"` served also at `/api/v1/schemas/config.json`):
```jsonc
{
  "version": 1,
  "project": { "name": "my-app", "defaultBranch": "main" },
  "workspace": { "runtime": "local", "copyIgnored": [".env", ".env.local"], "retainDays": 7 },
  "providers": { "claude": { "executable": "claude", "settingSources": ["user", "project", "local"] }, "acp": { "presets": { "codex": {} } } },
  "employees": {
    "developer": { "name": "Developer", "provider": "claude", "model": "claude-opus-5-5", "effort": "medium",
                   "prompt": "./.bytebureau/employees/developer.md", "permissionMode": "supervised",
                   "tools": { "allow": [], "deny": [] }, "skills": [], "askTimeout": "30m", "appearance": {} }
  },
  "defaults": { "employee": "developer", "branch": "main" },
  "plugins": [],
  "logging": { "level": "info" }
}
```
User config (`~/.bytebureau/config.json`): `server { host: "127.0.0.1", port: 4747 }`, `profiles` (non-secret parts), `defaults { provider, profile }`, `locale`, `logging`, `telemetry { content: "local" }` (consumed by SP8), `ui` (reserved for SP2).
`bytebureau config init` writes a commented project file with the default employee; `bytebureau config validate` reports errors; `bytebureau config schema` prints the JSON Schema.

## 11. API, client and CLI

### 11.1 API (`packages/api`)
- Base path `/api/v1`; OpenAPI 3.1 document generated at build and served at `/api/v1/openapi.json`; groups: `projects` (list/register/get/remove), `profiles` (list/add/remove/default/status), `sessions` (list/create/get/prompt/interrupt/stop/resume), `asks` (list pending/get/answer), `usage` (per profile snapshots, per session usage), `plugins` (list with status), `health`, `schemas`.
- `GET /api/v1/events?since=<seq>&session=<id>&project=<id>` — SSE with `id: <seq>` so `Last-Event-ID` resumes; durable events replay from `since`, ephemeral deltas stream live only; heartbeat every 15 s.
- `GET /api/v1/ws` — effect/rpc over WebSocket: `subscribe(filter, since)`, `command(...)` for every mutation; backpressure by bounded per-client queues (drop oldest ephemeral deltas first).
- Auth: server binds `127.0.0.1` by default; a 32-byte bearer token generated on first start is stored in `~/.bytebureau/server.json` (mode 0600) and required on every request except `/health`; `--host 0.0.0.0` (LAN) requires the token and prints a warning; CORS allows only the embedded UI origin; WebSocket origin checked; request bodies limited to 10 MB; rate limiting per client for mutations.
- Errors: RFC 9457 problem details with ByteBureau error codes (`config_invalid`, `plugin_failed`, `provider_auth`, `provider_ratelimit`, `workspace_dirty`, …).

### 11.2 Client (`packages/client`)
Generated from the OpenAPI document; `subscribeEvents({ since, filter })` returning an `AsyncIterable` with automatic reconnect and resume; used by the CLI and later the web UI, Tauri shell and phone client.

### 11.3 CLI (`apps/bytebureau`, citty + @clack/prompts)
- `bytebureau` (no sub-command): ensure the daemon is running (start detached when not), print status (daemon URL, projects, running sessions, pending asks); from SP2 it also opens the UI.
- `serve [--host --port --no-daemonize]`, `run "<prompt>" [--project <path>] [--branch <ref>] [--employee <id>] [--provider <id>] [--profile <id>] [--no-daemon] [--json|--output-format stream-json] [--yes]` (streams the transcript with clack task logs; asks are answered interactively; exit 0 on completion, 3 when stopped, 4 on provider error), `sessions ls|show <id>|prompt <id> "<text>"|interrupt <id>|stop <id>|resume <id>`, `ask ls|answer <id> [--option <id>|--other <text>]`, `profiles ls|add <provider> <name> [--api-key]|rm|use|status`, `projects ls|add [path]|rm`, `plugins ls|add <ref>|rm <name>`, `config init|validate|schema`, `workspaces ls|prune`, `doctor`, `diag bundle [--include-content] [--since 24h] [--session <id>]`, `service install|uninstall|status` (launchd user agent on macOS, systemd user unit on Linux, Scheduled Task on Windows), `upgrade` (downloads the matching release binary, verifies `SHA256SUMS` and the attestation with `gh attestation verify` when available, replaces itself; disabled when installed through a package manager).
- Global flags: `--lang`, `--json`, `--output-format text|json|stream-json`, `--debug[=<categories>]`, `--log-level`, `--log-file`, `--no-color`, `--yes`, `--host`, `--port`, `--token-file`. Non-TTY or `--json` output is machine-readable NDJSON; `--help` includes examples; shell completions for bash/zsh/fish/PowerShell generated by `bytebureau completions <shell>`.
- `doctor` checks: Bun/binary version, `~/.bytebureau` writable, DB `integrity_check`, git version, agent CLIs on PATH with versions (`claude`, `codex`, `opencode`, `gemini`, `pi`), profile auth status per provider, keychain backend, port free/daemon reachable, project config validity.

## 12. Logging, tracing, diagnostics

- Logger: LogTape with categories `bb.core`, `bb.config`, `bb.store`, `bb.events`, `bb.plugin.<name>`, `bb.agent.<provider>`, `bb.agent.raw`, `bb.workspace`, `bb.supervisor`, `bb.api`, `bb.cli`; Effect's logger is routed into LogTape so kernel and plugins share sinks. Sinks: console (pretty on TTY, JSON otherwise; `warn+` by default in daemon mode), rotating JSONL file `~/.bytebureau/logs/bytebureau.jsonl` (20 MB × 5), fingers-crossed buffer (last 5,000 `debug` records, flushed on `error`).
- Redaction: field names (`authorization`, `cookie`, `password`, `token`, `api_key`, `apikey`, `secret`, `private_key`, provider key env names) and patterns (`sk-ant-…`, `sk-…`, `ghp_`/`github_pat_`, `xox[abp]-`, `AKIA…`, JWTs, PEM blocks, URL userinfo) applied at the sink and again at bundle export; unit tests with canary secrets.
- `--debug[=cat,!cat]`: sets categories to `debug` (`BYTEBUREAU_DEBUG` env equivalent), enables the file sink at `debug`, stores raw agent stdout/stderr under `<project>/.bytebureau/sessions/<id>/`, passes `--debug` to spawned Claude Code and `RUST_LOG=codex_core=debug` to Codex, and includes `agent.raw` events when `agent.raw` is listed.
- Tracing: Effect spans around service operations (`session.prompt`, `workspace.provision`, `agent.turn`, `ask.open`, `plugin.setup`); W3C `TRACEPARENT` injected into child processes; an OTLP exporter is enabled only when `telemetry.otlpEndpoint` is configured (SP8 adds the receiver).
- `bytebureau diag bundle`: consent-first — lists the files it will include and asks for confirmation (or `--yes`); produces `bytebureau-diag-<timestamp>-<id>.zip` in the current directory containing `manifest.json` (versions, OS/arch, Bun version, plugin list, locale, consent level), `config.redacted.json`, `env.redacted.txt` (allowlisted keys only), `logs/` (last 10 MB + flight-recorder dump), `events.jsonl` (durable events in range, redacted), `sessions/<id>/` (session metadata, turns, tool-call summaries; raw transcripts only with `--include-content`), `doctor.json`; never uploads anywhere.
- Crash path: uncaught error → flush the flight recorder → write `~/.bytebureau/crashes/crash-<ts>.json` (error, last 200 events, versions) → print the path and suggest `bytebureau diag bundle`. Compiled binaries ship source maps so stacks are readable.

## 13. Security

- Loopback-only server with a bearer token; LAN exposure opt-in; token file mode 0600; no secrets in events, logs, API responses or diagnostic bundles.
- Child processes receive an explicit environment allowlist (`PATH`, `HOME`, `LANG`/`LC_*`, `TMPDIR`, `TERM`, profile variables, `TRACEPARENT`, `BYTEBUREAU_*`, plus `providers.<id>.passEnv` entries) — never the full daemon environment.
- ACP file-system and terminal methods are confined to the workspace path; symlink escapes are resolved and rejected.
- Plugins are trusted in-process code in SP1; the manifest's `capabilities` are displayed in `bytebureau plugins ls` and recorded; third-party plugin installation prints the declared capabilities and asks for confirmation.
- `yolo` permission mode is refused on `isolation: 'none'` runtimes.
- Policy compliance (ADR-0006): unmodified vendor binaries, user-performed logins, no credential copying between machines, no automatic account rotation, API-key mode available for every provider that supports it.

## 14. Error handling

| Situation | Behaviour |
|---|---|
| Invalid config | fail fast at daemon start or project registration with file + JSON pointer + expected type; `config validate` prints all errors |
| Plugin manifest/config/setup failure | `plugin.failed` event with reason; plugin skipped; daemon continues; `plugins ls` shows the error |
| Provider not installed / not logged in | `authStatus` reported before provisioning; `run` exits 4 with the exact login command; no worktree is created |
| Provider crash mid-turn | Supervisor restart with backoff (max 3); turn marked `errored`; `session.error { retryable }`; session stays resumable |
| Rate limit reached | `session.paused` with `resets_at`; UsageService records the snapshot; automatic continuation at `resets_at` when `providers.<id>.autoContinueAtUsageLimit` is true (default true); CLI shows the countdown |
| Login expired | `session.error { kind: 'auth' }` with hint command; session `errored`, resumable after re-login |
| Workspace dirty on destroy | retained with reason; `workspaces prune` explains why each worktree is kept |
| Ask timeout | per policy (§8.4); `ask.expired` event with the chosen fallback |
| Daemon restart | sessions in `running` are marked `interrupted`; resumable sessions resume on demand; event `seq` continuity guarantees clients can catch up |
| Disk full / DB locked | typed `StoreError`; writes retried with backoff; daemon degrades to read-only API with a loud health status |

## 15. Testing

- Unit (Vitest, Node): kernel services with in-memory SQLite and Effect `TestClock`; config precedence matrix; event log replay/ephemeral semantics; ask policy table; session state machine transitions (fast-check model-based test); redaction canaries; worktree slug/collision rules against a temp git repository.
- Contract/golden: recorded Claude SDK message fixtures and ACP notification fixtures replayed through the adapters produce canonical event snapshots; a fake ACP agent (TypeScript, stdio) exercises `agent-acp` end to end including `request_permission`, `fs/*`, `terminal/*` and cancel.
- Integration: `bytebureau run` with the kernel's fake provider over the real daemon (API + SSE resume + CLI rendering), `--json` NDJSON snapshots, `doctor` and `diag bundle` outputs; `service install` tested on macOS and Linux runners with uninstall.
- Real-agent smoke: `scripts/smoke-claude.ts` and `scripts/smoke-acp.ts` run only on demand (`SMOKE_REAL_AGENTS=1`) or in a nightly workflow gated by the owner's machine; never in PR CI (subscription limits).
- CI matrix: ubuntu x64 + arm64 for unit/integration; macOS for `service` and keychain tests.

## 16. Acceptance criteria

1. `bytebureau run "Create src/hello.ts exporting hello()" --project <repo>` with the fake provider in CI: registers the project, provisions `.bytebureau/worktrees/<id>` on `bb/…`, streams events, persists durable events with increasing `seq`, answers an ask through the CLI, ends with usage summary and exit code 0; the same command with `--json` yields parseable NDJSON.
2. The same command against a real Claude profile on the owner's machine produces a working edit in the worktree, shows context percentage and 5-hour/7-day utilisation when the SDK reports them, honours `interrupt` and a follow-up prompt mid-turn, and resumes after `bytebureau sessions stop`/`resume`.
3. The same command with `--provider acp:opencode` (or `acp:codex`) runs through the ACP adapter with permissions brokered by `AskService`.
4. Two projects and two sessions run concurrently; `bytebureau sessions ls` and `/api/v1/sessions` list both with correct statuses; SSE `Last-Event-ID` resume returns no gaps after a forced disconnect.
5. `bytebureau profiles add claude work` creates an isolated `CLAUDE_CONFIG_DIR`, instructs the user to log in, and `profiles status` reports `loggedIn` afterwards; API-key profiles store the key only in the keychain (or the age fallback) and never appear in logs, events or bundles (canary test).
6. `yolo` on the local runtime is refused with the documented message; `supervised` asks wait; `autonomous` question asks auto-proceed after the configured timeout with the recommended option and record `answered_via: 'timeout'`.
7. `bytebureau doctor` reports every check; `diag bundle` produces a zip with the documented structure and no secrets.
8. `bytebureau config schema` output validates the sample config; invalid configs fail with pointer-level messages.
9. OpenAPI document is generated and the client package round-trips every endpoint in an integration test; `publint`/`arethetypeswrong` pass for `plugin-api`, `protocol`, `client`.
10. All SP0 quality gates stay green; coverage thresholds hold for `kernel`, `api`, `plugin-api`, `protocol`, adapters.

## 17. Out of scope (handled later)

Web UI and embedded assets (SP2); office simulation and employee appearance rendering (SP3); ticket/PR workflow, employee roster, skills sync, Slack/Jira/GitHub plugins, work items (SP4); Docker/`sbx`/Kubernetes runtimes and `yolo` enablement (SP5); Tauri shell, installers beyond `upgrade`, notifications, keep-awake (SP6); relay, pairing, phone client (SP7); OTLP receiver, trajectory store, analysis bundle, A/B variants (SP8).
