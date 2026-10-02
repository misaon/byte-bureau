# 11 — Core architecture, plugin system, durable workflows, RPC, config, process/git orchestration, integrations

Research date: **2026-10-02**. Method: WebSearch budget was exhausted by sibling agents, so every fact below comes from **direct WebFetch of official docs, GitHub repos/releases and the npm registry** (~150 fetches). Versions are what the npm registry reported *today* (`/latest`), stars/licenses are what GitHub showed today. A caveat on **dates**: the fetch tool's page summarizer mis-stated the year on a few GitHub release pages ("2024" for releases that are clearly current); I only quote a date where it is corroborated (e.g. Effect 4.0 post, Restate releases, MCP spec id, jco releases). Anything I could not corroborate from two independent sources is marked **unverified**.

---

## 1. Executive summary

1. **Effect 4.0 shipped on 2026-09-30 as an LTS, zero-dependency, single-package runtime** that now *contains* `effect/rpc`, `effect/workflow`, `effect/cluster`, `effect/ai` (+ `McpServer`), `effect/cli`, `effect/http` + `effect/http-api` (OpenAPI), `effect/sql`, `effect/schema`, `effect/observability`, `effect/process`, `effect/workers`, `effect/socket`. LTS: bug fixes to Sep 2029 (or 1 yr after 5.0), security to Sep 2029 (or 2 yrs after 5.0). It claims a 5× smaller minimal bundle (7.1 kB vs 35.6 kB) and 6.4× fiber throughput vs 3.x. **OpenCode (211k ★, MIT) — the closest existing analogue to ByteBureau — runs on Effect 4 (catalog pins `effect 4.0.0-beta.83`, `@effect/platform-node`, `@effect/opentelemetry`) with Bun, SQLite (`effect-sqlite-node`, `effect-drizzle-sqlite`), Hono and an OpenAPI-generated SDK (`httpapi-codegen`).** That is the strongest possible "this stack works for exactly this kind of app" signal. Recommendation for a solo maintainer: **Effect in the kernel only** (config, event log, supervisor, workflow engine, RPC/HTTP server, LLM/MCP layer); **plain Promise-based TypeScript + Standard Schema at every plugin and UI boundary**, so contributors and plugin authors never need to learn Effect.
2. **Plugin system = three tiers behind one serializable contract.** Tier 1 (default, v1): in-process trusted TS plugins discovered as `@bytebureau/plugin-*` / `bytebureau-plugin-*` npm packages (keyword `bytebureau-plugin`, `exports["./plugin"]`), local `.bytebureau/plugins/*`, or marketplace entries; typed *extension points* (ports) + a `hookable`-style hook bus + Claude-Code-"mods"-style `($, e, next)` middleware for interception; config validated with **Standard Schema** (so plugin authors pick Zod 4.6 / Valibot 1.5 / ArkType 2.2 / Effect Schema). Tier 2 (v1, for integrations and agents): **out-of-process JSON-RPC 2.0** — MCP servers (spec **2026-07-28**, `@modelcontextprotocol/sdk` 1.31.0) and **ACP** agents (`@agentclientprotocol/sdk` 1.6.0; Claude Code, Codex, Gemini CLI, Cline, Copilot, Cursor, Kiro… all expose `acp`). Tier 3 (later): WASM sandbox for untrusted marketplace plugins — **Extism** (runtime 1.30.0, JS SDK 2.0.0-rc13, JS PDK is sync-only QuickJS) or the Component Model (**jco 1.35.0**, WASI 0.3 default, ComponentizeJS 0.23.0 — explicitly "experimental", ~8 MB per component). Because the tier-1 contract is message-shaped (DTOs, no functions across the boundary), a plugin can later be moved to a Worker, a subprocess or WASM without an API change.
3. **Durable workflow**: the ticket→PR→wait-days-for-review→merge→ticket-update flow needs replay-safe steps, durable timers, external wake-ups and human-in-the-loop. Ranked: **(1) `effect/workflow` + `ClusterWorkflowEngine` with `SingleRunner` and SQL storage on SQLite** (same process, one file, typed; but the module is marked `@unstable` and SQLite-backed cluster storage must be proven in a spike); **(2) Restate** sidecar (single binary, embedded log + RocksDB, no DB, `linux-arm64` binary on npm, awakeables/durable promises/signals for multi-day waits; SDK MIT, server **BSL 1.1 → Apache 2.0 after 4 years** — fine for ByteBureau's use); **(3) Workflow SDK** (vercel/workflow 5.0.1, Apache-2.0, superb `"use step"` DX) with a custom SQLite *World* — its Local World is "designed for development, not production" and its compile-time step model fights plugin-contributed steps. Rejected for a local app: DBOS and Hatchet (Postgres only), Trigger.dev (Postgres+Redis+ClickHouse+MinIO, 6–8 GB RAM), Temporal (server + Rust core; dev server "not intended for production"), Inngest (SSPL/DOSP, Redis+Postgres for prod), Cloudflare Workflows (lock-in).
4. **RPC/API**: expose **one OpenAPI-described HTTP API** (AI- and SDK-friendly) + **SSE** for live transcripts + **WebSocket** for interactive/bidirectional traffic (asking-dialogs, PTY, phone relay) + **JSON-RPC 2.0** for subprocess plugins/MCP/ACP. With Effect core that is `effect/http-api` (OpenAPI → generated client, exactly OpenCode's approach) + `effect/rpc` over WebSocket. Without Effect: **Hono 4.13 + oRPC 1.15** (contract-first, Standard Schema, OpenAPI built in, event-iterator SSE, TanStack Query bindings) beats tRPC 11.19 (no first-class OpenAPI, 73.7 kB vs 46.3 kB minified per oRPC's benchmark page) and Hono RPC (type-check cost at scale, acknowledged in Hono's own docs). Cap'n Web (0.12.0, 4k ★, <16 kB, capability-based) is the most interesting new idea but pre-1.0 and schema-less → watch, don't adopt.
5. **Config**: `bytebureau.json` (+ `.jsonc`) at the project root with a published `$schema` generated from the same schema the kernel validates with (Zod 4 `z.toJSONSchema`, Effect Schema `SchemaRepresentation`, or Standard JSON Schema); gitignored `bytebureau.local.json` for personal overrides; `.bytebureau/` for state (db, sessions, worktrees, logs, cache); `~/.bytebureau/` for user config/data, secrets in the OS keychain via `@napi-rs/keyring` 2.1.0 (prebuilt for darwin-arm64 and linux-arm64), `{env:VAR}` references in JSON (OpenCode convention). Loader: **c12** (4.0.0-rc.2; layering, `$development` overrides, remote `extends`, watch) or a 60-line JSON/JSONC loader if TS config is not wanted. This mirrors Claude Code (`settings.json` with `https://json.schemastore.org/claude-code-settings.json`), OpenCode (`https://opencode.ai/config.json`, deep-merge, `{env:}`/`{file:}`), Biome (`$schema` per version, `extends: ["//"]`), Turborepo (`$schema`, `extends: ["//"]`) and Renovate (presets).
6. **Process & git**: one long-running `bytebureau serve` daemon (installable as launchd/systemd-user unit; Raspberry Pi 5 is arm64 Linux and every native dependency recommended here ships an arm64 prebuild), children via **execa 10** (Node ≥22, ESM, `cancelSignal`, `gracefulCancel`, line iteration) or `Bun.spawn`, PTY only when a CLI truly needs it (**node-pty 1.1.0** / **bun-pty 0.4.11**), bounded output buffers persisted to SQLite/JSONL, `p-queue` 9.3.3 per-project concurrency; **git via the `git` binary** (execa wrapper or simple-git 4.0.2 `raw()`), **one worktree per session** under `.bytebureau/worktrees/<session>` on branch `bb/<ticket>-<slug>`, copying ignored files from a `.worktreeinclude`-style list — Claude Code's own worktree feature (`.claude/worktrees/<name>`, branch `worktree-<name>`, `.worktreeinclude`, lock while running, periodic sweep, `worktree.baseRef: fresh|head`) is the best-documented reference. GitHub auth for a desktop/CLI: **GitHub App + OAuth device flow** (no client secret, 8 h tokens + 6-month refresh); PR-review events without a public URL: **conditional polling** (ETag → `304` is free against the primary rate limit, honour `x-poll-interval`) with `gh webhook forward` only for development.
7. **Integrations as plugins that may wrap MCP**: direct SDK where offline polling and precise typing matter (GitHub via octokit 5.0.5 / `@octokit/rest` 22.0.1, Slack via Bolt 5.1.0 **Socket Mode** — no public URL, Discord.js 14.27 gateway, GitLab `@gitbeaker/rest` 43.8.0, Gitea `gitea-js` 1.23.0, Linear `@linear/sdk` 97.0.0, Jira `jira.js` 6.2.0); **MCP-wrapping where auth is hard or the vendor ships an official server** (Atlassian's official MCP server: `https://mcp.atlassian.com/v2/mcp`, OAuth 2.1 browser flow, GA, Apache-2.0 repo — Jira's own OAuth 3LO *requires a client secret* and Jira webhooks require a public HTTPS URL and expire after 30 days, so for a local app the MCP route or API-token + JQL polling wins).
8. **Monorepo**: Bun (or pnpm) workspaces + Turborepo 2.11, `packages/{kernel,plugin-api,protocol,schema,sdk,ui,sim}`, `plugins/*`, `apps/{server,cli,web,desktop,relay}`, hexagonal naming (ports in `plugin-api`, adapters in `plugins/*`, à la Backstage's `plugin-<id>-node` / `plugin-<id>-backend` split), **no barrel files inside packages** (only package entry points), **dependency-cruiser 18.5** rules enforcing layer boundaries, MADR 4.0 ADRs in `docs/decisions/NNNN-*.md`.

---

## 2. Findings per topic

### 2.1 Plugin systems — how the field structures them in 2026

| System | Manifest / discovery | Hook & lifecycle shape | Isolation | Notes observed (version/stars/licence) |
|---|---|---|---|---|
| **unjs `hookable`** | library | `createHooks<T>()`, `hook(name, fn)` → unregister fn, `callHook` (serial), `callHookParallel`, `hookOnce`, `addHooks`, `removeHook(s)`, `deprecateHooks`, `beforeEach/afterEach`, `createDebugger`; v5 moved to named exports, generic typing, hook errors reject `callHook` | in-process | npm **6.1.2**, 23.7 kB unpacked, zero deps, MIT, ~961 ★; extracted from Nuxt |
| **tapable** (webpack) | library | 9 hook classes (Sync/SyncBail/SyncWaterfall/SyncLoop, AsyncSeries*, AsyncParallel*), `tap/tapAsync/tapPromise`, `stage`/`before` ordering, `intercept()`, code-generated fast paths | in-process | 3.9k ★, MIT, bundled `.d.ts` |
| **Vite 8** plugins | package `vite-plugin-*` / `rolldown-plugin-*`, keywords `vite-plugin`, `rolldown-plugin` | `{ name, enforce: 'pre'|'post', apply: 'build'|'serve' }`, Rolldown hooks (`resolveId/load/transform/buildStart/buildEnd/closeBundle`) + Vite hooks (`config`, `configResolved`, `configureServer`, `transformIndexHtml`, `handleHotUpdate`); virtual modules via `\0` prefix; 7-stage ordering; `this.meta.viteVersion` | in-process | Vite **8.3.2** (depends on `rolldown ~1.2.11`), MIT |
| **unplugin** | `unplugin-*` | one plugin object → Vite/Rollup/Rolldown/webpack/Rspack/esbuild/Farm/Bun; `buildStart, resolveId, load, transform, buildEnd, writeBundle, watchChange` + per-bundler escape hatches | in-process | ~3.6k ★, MIT |
| **Nuxt modules** | `nuxt-module-*`, keyword `nuxt-module`, declared in `nuxt.config.modules` | `defineNuxtModule({ meta: { name, configKey, compatibility }, defaults, setup(options, nuxt) })`; `@nuxt/kit` (`addPlugin`, `addComponent`, `addImports`, `addServerHandler`, `extendPages`); hooks via hookable | in-process | docs nuxt.com/docs/4.x |
| **Astro integrations** | `astro-*` / `@org/astro-*`, keyword `astro-integration` | `{ name, hooks: { 'astro:config:setup', 'astro:config:done', 'astro:server:setup', 'astro:server:start', 'astro:build:start', 'astro:build:done', 'astro:route:setup', … } }`; args `updateConfig, addRenderer, injectRoute, injectScript, addMiddleware, logger`; custom hooks must be namespaced (not `astro:`) | in-process | — |
| **ESLint (flat config)** | `eslint-plugin-*`, keywords `eslint`, `eslintplugin`, `eslint-plugin`, `eslint` as peer dep | object `{ meta: { name, version, namespace }, rules, configs, processors }`; users opt in via `extends: ["ns/recommended"]` | in-process | — |
| **Fastify 5** | `fastify.register(plugin, opts)` | `async (fastify, opts)`; **encapsulation**: decorators/hooks apply to the child context only (a DAG); `fastify-plugin` breaks encapsulation and carries metadata (`name`, version range, `dependencies`, `decorators`); loading via avvio | in-process | docs show **v5.12.5** |
| **Backstage new backend** | packages `plugin-<id>-backend`, `plugin-<id>-node` (extension points), `plugin-<id>-backend-module-<m>`; `backend.add(import('…'))` | `createBackendPlugin/createBackendModule` → `register(env)` → `env.registerInit({ deps, init })`; plugins talk only over the wire; **modules** extend exactly one plugin via **extension points**; **services** via DI factories (`coreServices.logger/database/httpRouter/scheduler`) | process-per-backend | the cleanest "plugins vs modules vs extension points vs services" vocabulary; strongly recommended as naming reference |
| **Medusa 2** | `modules: [{ resolve }]` in `medusa-config.ts` | `Module(name, { service })`, service extends `MedusaService` with DML models | in-process | docs show v2.11.0 |
| **Payload 3** | `plugins: [...]` in config; `@payloadcms/plugin-*`; GitHub topic `payload-plugin` | plugin = `(options) => (config) => Config`, runs after validation, before sanitisation | in-process | — |
| **Strapi 5** | `@strapi/sdk-plugin` scaffolding; `server/` + `admin/` halves | `register/bootstrap/destroy`; new "MCP Server Extension" lets a plugin register MCP tools | in-process | — |
| **Obsidian** | `manifest.json` (fields not on the fetched page — unverified) | class extends `Plugin` with `onload()/onunload()`; must release resources in `onunload` | in-process | — |
| **VS Code** | `package.json` contribution points, `extensionKind: ui|workspace`, activation events | runs in a **separate extension-host process** (local Node, web worker, or remote) over RPC; rationale: stability, startup, no DOM access | out-of-process | reference for "UI never blocks on plugins" |
| **Zed** | `extension.toml` (`id, name, version, schema_version, authors, description, repository`) | Rust → **`wasm32-wasip2`** via `zed_extension_api` (WIT); kinds: languages, themes, icon themes, snippets, debuggers, MCP ("context") servers; dev extensions installed from disk | WASM | WASM-only, Rust-only → not a fit for a TS plugin ecosystem |
| **Figma** | `manifest.json` (`networkAccess` enforced by CSP) | main thread in a sandbox with **no browser APIs** (no `fetch`, `setTimeout`, DOM); UI in an iframe; `postMessage` bridge | JS sandbox | engine unverified; the "no fetch in the sandbox" constraint is exactly why a QuickJS sandbox is wrong for integration plugins |
| **Claude Code plugins** | `.claude-plugin/plugin.json` (only `name` required; `version` string pins; `displayName`, `author`, `homepage`, `repository`, `license`, `keywords`, `dependencies` (`name@marketplace`, version), `defaultEnabled`, `userConfig` (typed prompts; `sensitive: true` → OS secure store), `skills/commands/agents/hooks/mcpServers/lspServers/outputStyles/workflows`, `experimental.{themes,monitors,evals}`); `${CLAUDE_PLUGIN_ROOT}` (changes on update), `${CLAUDE_PLUGIN_DATA}` (persistent `~/.claude/plugins/data/<id>`), `${CLAUDE_PROJECT_DIR}`; `claude plugin validate` | **Marketplace** = git repo with `.claude-plugin/marketplace.json` (`name`, `owner`, `plugins[{ name, source, description, version, category, tags, strict, dependencies, defaultEnabled }]`, `metadata.pluginRoot`, `renames`, `forceRemoveDeletedPlugins`); sources: relative path, `github{repo,ref,sha}`, `url`, `git-subdir{url,path}`, `npm{package,version,registry}` (fetched **without running install scripts**), `archive{url,sha256}`, `command{command,timeout,mode}`; install scopes user/project/local; **Mods** = in-process hooks module `register(on, options)` with `on('tool.call', { tool: 'Bash' }, async ($, e, next) => next(e))`, ~60 events (`tool.*`, `prompt.*`, `turn.*`, `session.*`, `agent.*`, `ui.*`, `plugin.register`, `engine.create`, `telemetry.*`), a namespaced `$` API (`ui, command, tool, agent, model, prompt, session, fs, store, state, clock, http, process, mcp`), 10 s per-hook budget, `prependPlugins/appendPlugins` tiers, `plugin.register` lets a policy mod refuse others | in-process (mods, hooks) + subprocess (MCP servers, LSP servers, monitors) | docs current as of Claude Code **v2.1.287**; **Channels** (research preview) = an MCP server pushing `notifications/claude/channel` into a session and relaying permission prompts — a ready-made pattern for "chat/webhook → agent" |
| **OpenCode plugins** | `.opencode/plugins/`, `~/.config/opencode/plugins/`, npm packages listed in `opencode.json` `"plugin": [...]`, **installed with Bun at startup** into `~/.cache/opencode/node_modules`; load order global config → project config → global dir → project dir; dedupe by name+version | `export const MyPlugin: Plugin = async ({ project, client, $, directory, worktree }) => ({ hooks })`; hooks: `event`, `tool.execute.before/after`, `permission.asked/replied`, `shell.env`, `session.*`, `message.*`, `file.*`, `lsp.*`, `tui.*`, `command.executed`; types from `@opencode-ai/plugin` | in-process | `@opencode-ai/plugin` **1.18.34** (deps `zod 4.1.8`, `effect 4.0.0-beta.83`, `@opencode-ai/sdk`) |

**Sandboxing options (for tier 3 / untrusted plugins)**

| Option | Status observed today | Verdict |
|---|---|---|
| **Extism** | runtime 5.8k ★ BSD-3; releases v1.21.0 (2026-03-26, wasmtime 41), **v1.30.0 (2026-06-04, wasmtime 43)**, dev builds on wasmtime 48 LTS (2026-09-02); JS host SDK `@extism/extism` **2.0.0-rc13** (137 ★, "breaking changes between rc versions"), Node 18+/Bun/Deno/browser/CF Workers, host functions, `useWasi`, config, state; **JS PDK** (93 ★): QuickJS-ng + Wizer snapshot, needs Binaryen `wasm-merge/wasm-opt` + `extism-js` CLI, CJS/es2020 bundles, **no event loop → sync only**, no Node/browser APIs | Viable later for *pure-compute* plugins (formatters, policy checks). Wrong for integrations that need async I/O. |
| **Component Model / WASI 0.3** | jco **1.35.0** (2026-09-24), 1k+ ★, Apache-2.0-LLVM, "experimental project, no guarantees"; templates default to **WASI 0.3** (`@0.2.x` suffix for 0.2); `preview3-shim` 0.8.0 adds browser sockets/HTTP/fs; jco depends on `componentize-qjs 0.4.5` (QuickJS componentization) and `typescript 7.0.2`; **ComponentizeJS** 0.23.0 (395 ★, npm unpacked **42.8 MB**, ~8 MB SpiderMonkey embedded per component, async exports "syncified", Wizer/Weval) | Technically answers "compile a TS plugin to a component with capability-based imports": yes, but experimental, heavy and the TS→component story is immature. Re-evaluate in 2027. |
| **isolated-vm** | 7.x for Node 26, 2.9k ★, ISC, **"currently in maintenance mode"**, native build, per-isolate memory limit (default 128 MB; attackers may exceed 2–3×), CPU/wall timeouts | Reject (maintenance mode + native build + Node-only). |
| **quickjs-emscripten** | 1.7k ★, MIT; sync & asyncify builds (asyncify ~1 MB vs 500 kB, slower), quickjs-ng variant, memory/stack/interrupt limits, ESM + top-level await, Node 16+/Bun/Deno/browser/CF | Good for sandboxing *expressions/policies*; same sync/no-I/O problem as Figma for integrations. |
| **Node permission model** | stable since v22.13/v23.5; `--permission`, `--allow-fs-read/write`, `--allow-child-process`, `--allow-worker`, `--allow-net`, `--allow-addons`, `--allow-wasi`, `--allow-ffi`; `process.permission.has/drop`; `--permission-audit`; **process-wide, not per module; "does not prevent malicious code"**; docs v26.10.0 | Use as a seat belt for *subprocess* plugins, never as the trust boundary. |
| **Deno permissions** | `--allow-*`/`--deny-*` with scopes, prompts, `Deno.permissions`; process-wide; Workers can get reduced permissions; `--allow-run`/`--allow-ffi` escape the sandbox | Same conclusion; a Deno subprocess host is a reasonable "tier 2b". |
| **Bun** | `Bun.spawn` docs (Bun v1.4.2); no permission model observed (**unverified**) | — |

**Discovery conventions worth copying**: ESLint/Vite/Nuxt/Astro all use a name prefix + a `keywords` entry + peer dependency on the host; Claude Code and OpenCode add a *config-declared* list and a *marketplace index in git*; Claude Code additionally pins by `version`, supports `sha` pinning, forbids `..` paths, never runs npm install scripts, and separates `PLUGIN_ROOT` (replaced on update) from `PLUGIN_DATA` (persistent).

**Standard Schema** (standardschema.dev, © 2026; authors Colin McDonnell, Fabian Hiller, David Blass): `~standard: { version: 1, vendor, validate(input) → { value } | { issues }, types? }`; companion **Standard JSON Schema** (`~standard.jsonSchema.input()/output()` with targets `draft-2020-12`, `draft-07`, `openapi-3.0`); spec families `StandardTypedV1`, `StandardSchemaV1`, `StandardJSONSchemaV1`, published as `@standard-schema/spec` on npm/JSR. Consumers confirmed from their own docs/registry metadata: tRPC, oRPC, Hono (`@hono/standard-validator`), `hono-openapi` (uses `@standard-community/standard-json` + `standard-openapi`), Elysia, `@xstate/store`, `durable-execution`. Implementers confirmed via consumer docs: Zod 4, Valibot 1, ArkType 2 (Effect Schema v4: **unverified**).

### 2.2 Core runtime style

**Effect 4.0.0** (released **2026-09-30**; GitHub release page lists `effect`, `@effect/vitest`, `@effect/sql-sqlite-{node,bun,wasm,react-native,do}`, `@effect/sql-pg`, `@effect/sql-pglite`, `@effect/sql-mysql2` all at 4.0.0; `@effect/platform-node` 4.0.0 peers `effect ^4.0.0` + `redis >=5 <7`, deps `undici ^8.11`; `@effect/ai-anthropic` 4.0.0):
- Core modules now inside `effect` (observed in `packages/effect/src`): `ai, cli, cluster, devtools, encoding, eventlog, http, http-api, net, observability, persistence, process, reactivity, rpc, schema, socket, sql, testing, workers, workflow`; npm `exports` include `./ai ./cli ./rpc ./workflow ./cluster ./http ./sql ./schema ./testing ./observability ./persistence ./encoding`. Unpacked size 47 MB (all modules; tree-shakeable). Zero runtime deps ("we control every line we ship").
- Numbers from the release post: bundle 7.1 kB vs 35.6 kB (5×), 4.57 M vs 0.71 M tasks/s (6.4×), 21.8 MB vs 157.5 MB for 50k fibers (−86%).
- Requirements per the GitHub release notes (single source → treat as *likely*): TypeScript 5.9+ (TS 7 recommended), Vitest 5, Node 22.16+ for SQLite. Schema v4: class-based schemas, built-in `make`, effectful decoding, `SchemaRepresentation` for JSON Schema and TS codegen.
- RC/Beta recaps (Aug 31 / Jul 31 / Jun 30 2026): zero external deps; native Postgres client; pull-based sockets with backpressure, unified WebSocket across Node/Bun/Deno/browser; **RPC server notifications first-class + HTTP stream backpressure**; AI tool resolution interruption-safety, Claude token limits; CLI prompt themes; Schema native Arbitrary; **native Deno support**; Graph module; **"near-fully automated" v3→v4 migration via a coding-agent skill on skills.sh**.
- `effect/workflow` (source doc comments): `Workflow.make(tag, { payload, idempotencyKey, success?, error?, suspendedRetrySchedule? })`, `execute/poll/interrupt/resume`, `executionId` = hash(tag, idempotencyKey(payload)), results `Complete<A,E> | Suspended`, `withCompensation` (sagas; top-level effects only), `SuspendOnFailure`, `suspend(instance)`, `WorkflowEngine` service (`register, execute, poll, interrupt, resume, activityExecute, deferredResult/deferredDone, scheduleClock`), `layerMemory` ("not suitable for production workflows that require durability"). **Marked `@unstable`.** Durable engine lives in `effect/cluster`: `ClusterWorkflowEngine.ts`, `SqlMessageStorage.ts`, `SqlRunnerStorage.ts`, `SingleRunner.ts`, `HttpRunner.ts`, `SocketRunner.ts`, `K8sHttpClient.ts`, `Sharding.ts`, `Entity.ts`, `Snowflake.ts`. Whether `Sql*Storage` works on the SQLite dialect is **unverified** (no SQLite-specific file; OpenCode ships `effect-sqlite-node` which hints it does, but that is inference).
- `effect/ai`: `LanguageModel, Chat, Tool, Toolkit, Prompt, Response, Model, EmbeddingModel, DecisionModel, Tokenizer, Telemetry, AnthropicStructuredOutput, OpenAiStructuredOutput, McpProtocol, McpSchema, McpServer` (no `McpClient` file listed — **MCP client side unverified**).
- `effect/rpc`: `Rpc, RpcGroup, RpcServer, RpcClient, RpcWorker, RpcMiddleware, RpcSerialization, RpcSchema, RpcMessage, RpcTest`.
- Adoption signal: OpenCode root `package.json` catalog: `effect 4.0.0-beta.83`, `@effect/platform-node`, `@effect/opentelemetry`, `zod 4.1.8`, `ai 6.0.168`, `drizzle-orm 1.0.0-rc.2`, `hono 4.10.7`, `remeda 2.26.0`, `typescript 5.8.2` + `@typescript/native-preview`, `bun@1.3.14`; `packages/opencode` deps add `@modelcontextprotocol/sdk 1.29.0`, `@ai-sdk/anthropic 3.0.111`, `@opentui/*`; the repo also has `packages/effect-drizzle-sqlite`, `effect-sqlite-node`, `httpapi-codegen`, `protocol`, `schema`, `plugin`, `sdk`, `server`, `containers`, `slack`.
- Effect blog "Module of the Week" (Sep 2026) covers Cluster actors, `RcMap`, `PersistedQueue` (background jobs with multiple workers, locking, retries) — useful for the supervisor.

**Plain-TS stack alternatives (versions today)**: Zod **4.6.5** (6.1 MB unpacked incl. `./mini`, `./v4/core`; `z.toJSONSchema({ target: draft-2020-12|draft-07|draft-04|openapi-3.0, io, cycles, reused, unrepresentable })`, `.meta()`/`z.globalRegistry`, experimental `z.fromJSONSchema`), ArkType **2.2.7** (340 kB unpacked, 3 deps), Valibot **1.5.0** (1.87 MB unpacked, zero deps, modular), neverthrow **8.2.0** (112 kB, 7.7k ★, `Result/ResultAsync`, `safeTry`, `eslint-plugin-neverthrow`), emittery **2.1.0** (Node ≥22, ESM, typed event map, async `emit`, `events()` iterator, `AbortSignal`, `Symbol.dispose`), XState **5.33.2** (persistence: `getPersistedSnapshot()` → `createActor(m, { snapshot })`, deep restore of children, or event-sourcing replay via the inspection API; caveats: JSON-only, logic changes invalidate snapshots, actions are not re-run), `@xstate/store` **4.2.3** (Standard Schema input, React/Vue/Svelte/Solid/Angular/Preact bindings, TS ≥5.4), inversify **8.2.3** (monorepo move; decorator DI), tsyringe (6k ★; **requires `experimentalDecorators` + `emitDecoratorMetadata` + `reflect-metadata`** → legacy), TypeScript **7.0.2** (Apache-2.0; JS package with optional `@typescript/typescript-*` native binaries), Node docs at **v26.10.0**, Bun docs at **v1.4.2**.

**Opinion for a solo maintainer** (details in §3): Effect only in the kernel. Reasons: (a) the exact pieces ByteBureau needs — structured concurrency with interruption, retries/timeouts/schedules, resource scopes (for processes/worktrees), typed errors, DI via Layers (plugin services), OTel observability, RPC+OpenAPI, LLM/MCP, CLI, SQLite — are all in one LTS package with coherent semantics; (b) OpenCode proves it at scale for this domain; (c) a Java/Spring-trained owner maps Layers/Services/Schema to familiar concepts quickly; (d) the cost (viral `Effect<A,E,R>` types, generator style, 47 MB install, `@unstable` workflow) is contained by keeping plugins and UI Promise-based.

### 2.3 Durable / long-running workflows without external infra

Requirement recap: ticket → In Progress → worktree → agent implements → PR → Slack review request → wait **hours/days** (wake by webhook *or* poll) → handle comments (loop) → merge → ticket update → Testing → ping tester; human-in-the-loop "asking"; retries, timeouts, observability; survives restarts of a local app on a laptop or a Pi.

| Engine | What I verified | Infra | Licence | Fit |
|---|---|---|---|---|
| **`effect/workflow` + cluster engine** | API above; `layerMemory` non-durable; durable path = `ClusterWorkflowEngine` + `SqlMessageStorage/SqlRunnerStorage` + `SingleRunner` (single node); SQLite driver packages exist (`@effect/sql-sqlite-node/bun` 4.0.0) | none (one SQLite file) | MIT | **Best if Effect core**; `@unstable`; SQLite-backed storage **must be spiked** |
| **Workflow SDK** (vercel/workflow, workflow-sdk.dev) | `workflow` **5.0.1**, Apache-2.0, 2.4k ★; `"use workflow"`/`"use step"`; replay determinism (Math.random/Date fixed); steps retry 3× by default, `maxRetries`, `RetryableError({ retryAfter })`, `FatalError`, `getStepMetadata().attempt`; `createHook()`/`resumeHook(token)` (custom deterministic tokens), `createWebhook()` (addressable `url`), `defineHook({ schema })`; waiting costs no compute; build produces `flow.mjs` (orchestrator in a sandboxed VM), `__step_registrations.mjs`, `webhook.mjs`; only two routes: `POST /.well-known/workflow/v1/flow` and `/.well-known/workflow/v1/webhook/:token`; `@workflow/swc-plugin`; framework packages `next, nuxt, astro, nitro, sveltekit, nest, rollup, typescript-plugin`; Hono guide uses Nitro; Bun supported; CLI `npx workflow web`, `npx workflow inspect runs`; error code `MAX_EVENTS_EXCEEDED` exists | **Worlds**: Local (`.workflow-data/` JSON files, **in-memory queue**, `WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS` re-enqueues pending runs on start, **"designed for development, not production"**), Vercel, `@workflow/world-postgres` 5.0.1 (graphile-worker 0.16.6 + pg, "reference implementation", no auth/encryption), custom World via pluggable adapter (`WORKFLOW_TARGET_WORLD`) | Apache-2.0 | Great DX; a **custom SQLite World** is feasible but you own it; compile-time step registration conflicts with runtime plugin-contributed steps |
| **Restate** | server **v1.7.13 (2026-10-01)**, 4.5k ★; single binary implementing single- or multi-node; embedded durable log + RocksDB materialised state + Raft metadata; fsync before ack; single-node "suitable for production tolerating brief downtime"; cluster needs S3/MinIO; npm `@restatedev/restate` 1.7.13 ships **linux-arm64**, linux-x64, darwin-x64/arm64 binaries; SDK `@restatedev/restate-sdk` **1.17.2** MIT, Node ≥22/Bun/Deno; primitives `ctx.run`, `ctx.sleep` (days), **awakeables** (resolve via SDK or `curl localhost:8080/restate/awakeables/{id}/resolve`), **workflow promises** (`ctx.promise("name")`, retention default 24 h), **signals** (repeatable, for agent steering/approvals) | one sidecar process; `restate-data/` dir; memory tuning page exists but footprint **unverified** | server **BSL 1.1** (→ Apache 2.0 four years after each release; forbids offering a "Public Restate Platform Service"; internal/own-product use allowed), SDK MIT | **Most mature semantics with least code**; extra process + BSL |
| **DBOS Transact TS** | 1.4k ★ MIT; `DBOS.registerWorkflow`, `runStep`, `sleep`, queues, cron; **Postgres mandatory** (`systemDatabaseUrl`), no SQLite | Postgres | MIT | Reject for local app |
| **Hatchet** | 8k ★ MIT; Postgres as sole durability layer; durable sleep/event waits; Docker install | Postgres | MIT | Reject |
| **Inngest** | 5.9k ★; `inngest dev`/`start` single binary; dev = in-memory Redis + SQLite; prod recommends Postgres + Redis; no support guarantee self-hosted | Redis/Postgres for prod | **SSPL + DOSP (Apache 2.0 delayed)** | Reject |
| **Temporal TS** | 933 ★ MIT; needs server; `temporal server start-dev` (in-memory or `--db-filename` SQLite; ports 7233/8233) is "not intended for production"; worker loads Rust core via N-API; Node 20/22/24; `vm`-based workflow sandbox | server + native core | MIT | Reject for embedded use |
| **Trigger.dev v4** | 16.5k ★ Apache-2.0; self-host = webapp + Postgres + Redis + ClickHouse + supervisor + registry + MinIO + s2-lite + docker socket proxy; webapp 3+ vCPU/6+ GB, worker 4+ vCPU/8+ GB | heavy | Apache-2.0 | Reject |
| **Cloudflare Workflows** | `step.do/sleep/sleepUntil/waitForEvent`; Cloudflare-only | CF | — | Reject (lock-in) |
| **`durable-execution`** (npm) | 0.32.0 MIT, peer **`effect ^3.17`** (incompatible with Effect 4), pre-1.0 | — | MIT | Reject |
| **XState persisted actors** | snapshot/event-sourcing as above | — | MIT | Use for *session statecharts*, not as the scheduler |
| **Hand-rolled saga on SQLite** | — | none | — | Only if Effect and sidecars are both rejected; you re-implement replay, timers, idempotency, wake-ups |

Cross-cutting insight: human waits must be modelled as **durable promises/hooks keyed by a deterministic token** (e.g. `pr-review:<repo>#<pr>`), resolved by *either* a webhook, a poller, or a UI click — all three engines above support that shape (Workflow SDK custom tokens, Restate awakeables/promises, Effect `DurableDeferred`).

### 2.4 RPC / API layer

| Candidate | Observed | Strengths | Weaknesses for ByteBureau |
|---|---|---|---|
| **oRPC** | `@orpc/server` **1.15.4** MIT (docs show a `@beta` channel for the next major); contract-first procedures/routers/middleware; Standard Schema (Zod/Valibot/ArkType); OpenAPI handler + RPC handler; Node/Bun/Deno/Hono/Express/Fastify/Elysia/Next adapters (docs); typed SSE event iterators, File/Blob/ReadableStream; first-party pub/sub, rate-limit, locking; TanStack Query (React/Vue/Solid/Svelte), Pinia Colada; comparison page: 20,279 vs 4,821 req/s vs tRPC, 30% faster type-check at 3,000+ procedures, minified 46.3 kB (Hono 44.9 kB, tRPC 73.7 kB); sponsors incl. Guillermo Rauch; GitHub star count **unverified** (fetch returned a fork) | OpenAPI for free (AI/SDK friendly), streaming typed end-to-end, small | younger than tRPC; vendor-published benchmarks |
| **tRPC 11** | `@trpc/server` **11.19.0** MIT; release notes mention streaming/WebSocket/subscription fixes and "OpenAPI generation" improvements (first-party status **unverified**); upgrades to Node 24/TS 7/Vitest 5 | huge ecosystem | heavier; OpenAPI historically third-party |
| **Hono 4** | **4.13.12** MIT, 32.4k ★; 4.13.10 moved runtime adapters to `@hono/bun`, `@hono/deno`, `@hono/cloudflare-workers`…; `@hono/node-server` **2.1.3** (Node ≥20); `hc` RPC client infers input/output/status; docs warn "the more routes you have, the slower your IDE" → precompile types / project references / split apps; `upgradeWebSocket()` per runtime (`onOpen/onMessage/onClose/onError`, RPC-typed WS routes; header middleware may conflict); `stream()/streamText()/streamSSE()` with `writeSSE`, `onAbort`, errors don't hit `onError`; OpenAPI via `@hono/zod-openapi` **1.6.3** (zod 4) or `hono-openapi` **1.3.3** (Standard Schema) | the de-facto web-standards server; runs on Node/Bun/Deno/Pi | RPC type cost at scale |
| **Elysia** | 1.x with **2.0 beta**; Bun-first but web-standard (Node/Deno/CF); Eden; `@elysia/openapi` `fromTypes()`; Standard Schema; WS via µWebSockets | fastest; OpenAPI from types | Bun lean + 2.0 churn |
| **Effect RPC / HttpApi** | modules listed above; RC: server notifications, HTTP stream backpressure; HttpApi → OpenAPI (OpenCode generates its SDK from it via `httpapi-codegen`) | one runtime, typed errors end-to-end, streams with backpressure | only if Effect core |
| **Connect-ES v2** | stable, Apache-2.0, 1.8k ★; Connect/gRPC/gRPC-Web; protobuf-es; `connect-node/-web/-fastify/-express`; HTTP/2 for streaming | cross-language | protobuf codegen tax for a TS-only system |
| **Cap'n Web** | `capnweb` **0.12.0** MIT, 4k ★, first published Sep 2025; <16 kB gz, no deps; WebSocket/HTTP-batch/postMessage/MessagePort; promise pipelining; bidirectional; pass functions/objects by reference (`RpcTarget`), disposal; **no schema** (`capnweb-validate` generates validators from TS types); you own auth/rate-limit/payload limits | capability model matches "phone remote with scoped capabilities" | pre-1.0 |
| **birpc** | 575 ★ MIT ~0.5 kB; `createBirpc/createBirpcGroup`; used by Vite/Vitest/Nuxt devtools | ideal for Worker/MessagePort plugin hosts | not an HTTP API |
| **comlink** | 4.4.2 Apache-2.0 | Workers | — |
| **JSON-RPC 2.0** | `vscode-jsonrpc` **9.0.3** MIT (streams), `json-rpc-2.0` **1.8.1** MIT; MCP spec **2026-07-28** (JSON-RPC 2.0; tools/resources/prompts; elicitation; extensions **Tasks** = async long-running ops with durable handles, Skills over MCP, MCP Apps); ACP v2 (initialize → `auth/login` → `session/new`/`session/load` → `session/prompt` → `session/update` notifications → `session/cancel`; client methods `session/request_permission`, `elicitation/create`, `fs/*`, `terminal/*`; `_meta` extensibility; absolute paths, 1-based lines) | the lingua franca of agents/tools | verbose for app UIs |
| **Nitro v3 / h3 v2** | both **beta** ("intentional backward-incompatible changes"); crossws for WS | — | wait |

Streaming choice: **SSE** for transcripts/office events (uni-directional, resumable via `Last-Event-Id`, proxy/relay friendly, trivially bridged over an E2EE relay), **WebSocket** for interactive channels (asking dialogs, PTY, plugin UI panels, desktop shell), **WebTransport** not recommended (runtime/browser support **unverified**).

### 2.5 Config

| Reference tool | File / schema | Layering |
|---|---|---|
| Claude Code | `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, managed settings; `"$schema": "https://json.schemastore.org/claude-code-settings.json"` (may lag releases); `~/.claude.json` holds MCP servers/trust/global config (machine-written) | managed > CLI `--settings` > project local > shared project > user; plugins recorded under `enabledPlugins`, marketplaces under `extraKnownMarketplaces`; plugin `userConfig` non-sensitive → `pluginConfigs`, sensitive → OS secure store |
| Codex CLI | `~/.codex/config.toml`, project `.codex/config.toml` (trusted projects only; may not override auth/provider/notify/telemetry/profile); profiles `profile-name.config.toml` via `--profile`; keys `model, model_provider, approval_policy, sandbox_mode, mcp_servers.<id>, features, shell_environment_policy, notify, projects.<path>.trust_level, history.persistence`; **no schema documented** (docs now at learn.chatgpt.com) | CLI > profile > project > user |
| OpenCode | `opencode.json`/`.jsonc`; `"$schema": "https://opencode.ai/config.json"` (`tui.json` likewise); locations: remote `.well-known/opencode`, `~/.config/opencode/opencode.json`, `OPENCODE_CONFIG`, project `opencode.json`, `.opencode/` dir, `OPENCODE_CONFIG_CONTENT`, managed; `{env:VAR}` and `{file:path}` substitution | **deep merge**, later wins per key |
| Biome 2.x | `biome.json(c)`; `$schema: https://biomejs.dev/schemas/{VERSION}/schema.json` or `./node_modules/@biomejs/biome/configuration_schema.json`; `root`, `extends` (incl. `"//"`), `overrides[]`, `vcs.useIgnoreFile` | nested configs with `root: false` |
| Turborepo 2.11.6 | `turbo.json(c)`; `$schema: https://turborepo.dev/schema.json`; `extends: ["//"]` package configs; `globalDependencies/globalEnv/globalPassThroughEnv`; tasks `dependsOn/outputs/cache/persistent/interactive`; `envMode strict|loose` | root + package |
| Renovate | `renovate.json`; `$schema: https://docs.renovatebot.com/renovate-schema.json`; presets `extends: ["config:recommended", "github>org/repo"]` | default < global < inherited < presets < repo |

Loaders: **c12** `4.0.0-rc.2` (npm; README: v4 install ~380 kB, 7 deps vs 20; deps `rc9, defu, pathe, confbox, exsolve, pkg-types`; optional `jiti, giget, dotenv, magicast`; formats ts/js/mjs/cjs/mts/cts/json/jsonc/json5/yaml/toml/rc + `.config/` dir; order overrides → cwd config → cwd rc → workspace rc → user config dir rc → home rc → `package.json` key → defaults → `extends` layers (local or remote github/gitlab/bitbucket); `$development/$production/$test/$env`; `watchConfig` HMR; dotenv). cosmiconfig (4.2k ★, MIT, `.config/` search, TS loaders) and lilconfig (190 ★, zero deps, no YAML) are fine but c12 supersedes them. Paths: `env-paths` (455 ★, MIT, ESM; macOS `~/Library/{Application Support,Preferences,Caches,Logs}`, Linux XDG, Windows `%APPDATA%/%LOCALAPPDATA%`; default suffix `-nodejs` — pass `{ suffix: '' }`). Secrets: `@napi-rs/keyring` **2.1.0** MIT (keyring-rs; macOS Keychain / Windows Credential Manager / Linux Secret Service → kernel keyutils fallback; prebuilds for darwin-arm64, linux-arm64-gnu/musl, linux-arm-gnueabihf, win32-arm64). JSON Schema generation: Zod 4 `z.toJSONSchema` (targets above), Effect Schema v4 `SchemaRepresentation` (release notes), Standard JSON Schema for the others.

### 2.6 Process & git orchestration, integrations

**Processes**: execa **10.0.1** (MIT, Node ≥22, ESM; `$` template, `for await (const line of subprocess)`, `cancelSignal`, `gracefulCancel`, `timeout`, `.pipe()`, `execaNode` IPC, verbose/debug, result `durationMs`); `Bun.spawn` (stdio `pipe|inherit|ignore|Bun.file|fd|stream`, `ReadableStream` stdout, `exited`, `kill(signal)`, `timeout`/`killSignal`, `maxBuffer` (sync), `ipc` with `serialization: "json"` for Bun↔Node, `resourceUsage()`, posix_spawn; spawnSync ~60% faster than Node 18 in Bun's own benchmark); zx **8.8.5** Apache-2.0; node-pty **1.1.0** MIT (prebuild script then node-gyp fallback; Node 16+/Electron 19+; ConPTY; powers VS Code; Bun support not mentioned); bun-pty **0.4.11** MIT (Rust via `bun:ffi`); p-queue **9.3.3** (Node ≥20, ESM). Claude Code's own supervisor reference: LSP servers declare `restartOnCrash`, `maxRestarts`, `startupTimeout`, `shutdownTimeout`; monitors are "persistent background processes" per plugin.

**Git**: simple-git **4.0.2** MIT, 3.9k ★ (shells out; `maxConcurrentProcesses` 6; `raw()` for anything missing such as `worktree`); isomorphic-git 8.4k ★ MIT, pure JS, **community-maintained by two volunteers**, no worktree support mentioned → reject. **Claude Code worktrees** (reference implementation): `claude --worktree <name>` → `.claude/worktrees/<name>/` on branch `worktree-<name>` (base `origin/<default>` fetched at most every 24 h, 5 s cap; `worktree.baseRef: "head"` alternative; `--worktree "#1234"` fetches `pull/<n>/head` or `merge-requests/<n>/head`); `.worktreeinclude` (gitignore syntax, copies only gitignored matches); cleanup on exit (clean+unnamed → auto remove; else prompt); `git worktree lock` while an agent runs; periodic sweep after `cleanupPeriodDays`, keeps worktrees with changes/unpushed commits; marker in git metadata; isolation enforcement (blocks edits/commands/git redirects into the main checkout); `WorktreeCreate/WorktreeRemove` hooks for non-git VCS; subagents `isolation: worktree`; "add `.claude/worktrees/` to `.gitignore`". Competitors: Vibe Kanban (28.2k ★, Apache-2.0, Rust+React, worktree per workspace, auto-cleanup of orphaned worktrees — **"sunsetting" per its README**), Crystal (3.1k ★ MIT, Electron, **deprecated Feb 2026 → Nimbalyst**), Conductor (macOS app v0.89.1, closed source, "isolated workspaces").

**GitHub**: `octokit` **5.0.5** (Node ≥20; `@octokit/core 7`, `@octokit/app 16`, `@octokit/oauth-app 8`, `@octokit/webhooks 14`, throttling 11, retry 8; **ESM-only, needs `moduleResolution: node16`**), `@octokit/rest` **22.0.1**, `@octokit/auth-oauth-device` **8.0.5**; device flow: `POST /login/device/code` → user enters `XXXX-XXXX` at github.com/login/device → poll `/login/oauth/access_token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`, respect `interval`, `slow_down` adds 5 s, codes expire in 15 min, **no client secret**, must enable device flow in app settings; GitHub Apps: fine-grained permissions, user tokens expire after 8 h with 6-month refresh. Polling: ETag/`If-None-Match` → `304` **does not count against the primary rate limit**; honour `x-poll-interval`, `retry-after`, `x-ratelimit-reset`; don't repeat 404s; "prefer webhooks". Webhooks without a public URL: `@octokit/webhooks` + smee.io, or `gh extension install cli/gh-webhook` + `gh webhook forward --repo=R --events=pull_request_review,issue_comment --url=http://localhost:…` (**testing only, one user per repo/org at a time**).

**GitLab/Gitea**: `@gitbeaker/rest` **43.8.0** MIT (Node ≥18.20, browsers/Deno/Bun; README claims coverage "up to GitLab 16.5"); `gitea-js` **1.23.0** MIT (swagger-generated).

**Jira/Atlassian**: `jira.js` **6.2.0** MIT (**ESM-only, Node ≥22, single dep `zod ^4.4`**; Cloud v3, Agile, JSM, Assets, DC 10+; auth: email+API token, bearer, OAuth 2.0 3LO with auto-refresh; v5 gets security fixes to end of 2026). OAuth 2.0 (3LO): authorization-code, `offline_access` rotating refresh tokens (90-day inactivity), base `https://api.atlassian.com/ex/jira/{cloudid}`, `GET /oauth/token/accessible-resources`; **client secret required** → unsuitable for a public desktop/CLI client without a hosted broker. Jira webhooks: HTTPS public URL on an allow-listed port set (443, 8080, 8443, …; port 80 forbidden), JQL filters, **5 per OAuth 2.0 app per user**, REST-registered webhooks **expire after 30 days**, retries 5× with 5–15 min backoff. **Atlassian MCP Server** (github.com/atlassian/atlassian-mcp-server, 1.1k ★, Apache-2.0; launched beta 2025-05-01, now GA): `https://mcp.atlassian.com/v2/mcp` recommended, v1 SSE endpoint deprecating 2026-06-30; OAuth 2.1 browser flow, optional API-token/service-account auth (admin-enabled; required for JSM); Jira search/create/update/transition/comment, Confluence, Bitbucket, JSM, Compass; clients incl. Claude, Cursor, Codex, Gemini CLI, VS Code.

**Linear**: `@linear/sdk` **97.0.0** MIT; Agents API: OAuth with `actor=app` (workspace admin approval), scopes `app:assignable`, `app:mentionable`; `AgentSession`/`AgentActivity` (`thought|action|response|elicitation|error`), emit a `thought` within 10 s; `AgentSessionEvent` webhooks (HTTP → public URL implied) with `promptContext`.

**Slack**: `@slack/bolt` **5.1.0** (Node ≥20; `@slack/web-api ^8.1.1`, `@slack/socket-mode ^3.0.1`, Express 5); **Socket Mode**: `apps.connections.open` with an `xapp-` token, no public URL, up to 10 connections, granular-permission apps only, **not allowed for Slack Marketplace distribution** (irrelevant for a self-hosted tool). **Discord.js** **14.27.0** Apache-2.0 (Node ≥18; gateway WS, `@discordjs/core`). Teams/Graph: not fetched (**unverified**; Graph change notifications need a public endpoint).

**Agent runtimes as out-of-process plugins**: `@anthropic-ai/claude-agent-sdk` **0.3.287** (platform binaries; peers `zod`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`); ACP `@agentclientprotocol/sdk` **1.6.0** Apache-2.0 (fluent `agent()`/`client()`; peer zod 3.25||4); the ACP agent registry lists Claude (via Zed's adapter), Codex (adapter), Gemini CLI, Cline, GitHub Copilot `copilot acp`, Cursor `cursor acp`, Kiro, Goose, OpenHands, Factory Droid, Augment, Qoder, Hermes, OpenClaw, etc.

### 2.7 Directory structure & code quality

- **OpenCode** (`anomalyco/opencode`, 211.3k ★, MIT; Bun workspaces `packages/*`, `packages/console/*`, `packages/stats/*`, `packages/sdk/js`, `packages/slack`; Turbo; SST): `app, cli, client, codemode, console, containers, core, desktop, docs, effect-drizzle-sqlite, effect-sqlite-node, enterprise, function, http-recorder, httpapi-codegen, identity, llm, opencode, plugin, protocol, schema, script, sdk, sdk-next, server, session-ui, slack, stats, storybook, tui, ui, web`. Pattern: **server + protocol + schema + generated SDK + several thin clients (TUI/web/desktop/VS Code) + a plugin package that exposes types only**.
- **Mastra** (28.5k ★, Apache-2.0 + `ee/` Enterprise License): `packages/{core,cli}`, `deployers/*`, `stores/*`, `voice/*`, `integrations/*`, `client-sdks/*`, `examples/` — **adapters as sibling package families**, workflows suspend/resume with snapshots in the storage adapter.
- **Effect**: `packages/effect` (modules as subpaths), `packages/platform-node`, `sql-*`, `ai-*`, `vitest`.
- **Backstage** naming (`plugin-<id>-backend`, `plugin-<id>-node` for extension points, `plugin-<id>-backend-module-<m>`) is the best vocabulary for *plugins vs modules vs extension points vs services*.
- **dependency-cruiser** **18.5.0** MIT, 7.2k ★ (Node ^22||^24||≥26): `.dependency-cruiser.cjs/.mjs`, `forbidden/allowed/required` rules, `no-circular`, `no-orphans`, TS path aliases, monorepo, mermaid/dot/html output, CI exit codes.
- **Barrel files**: TkDodo's data point (11k → 3.5k loaded modules, −68%, by removing internal barrels), circular-import hazards, Next `optimizePackageImports` can't optimise barrels with any non-re-export line; keep barrels **only** as package entry points.
- **ADRs**: MADR **4.0.0** (bare/minimal templates; `docs/decisions/NNNN-title-with-dashes.md`; sections: context/problem, drivers, options, outcome, consequences, confirmation, pros/cons, more info; no tooling beyond markdownlint).
- **Hexagonal** (Cockburn): core + primary (driving) ports + secondary (driven) ports + technology adapters; purpose: tests and swappable tech.

---

## 3. Ranked recommendations + risks

### 3.1 Core runtime — ranking

1. **Effect 4 in the kernel, Promise-based TS at the edges** (recommended).
   - Kernel = `packages/kernel`: config (Effect `Config` + Schema), event log, plugin host, supervisor (`effect/process`, `Scope`, `Schedule`, `PersistedQueue`), workflow engine (`effect/workflow`), SQLite (`@effect/sql-sqlite-node` or `-bun`), HTTP/OpenAPI (`effect/http-api`), RPC (`effect/rpc`), LLM (`effect/ai` + `@effect/ai-anthropic`/`-openai`), CLI (`effect/cli`), OTel (`@effect/opentelemetry`).
   - `packages/plugin-api` exports **only** plain TS types, `definePlugin()`, Standard Schema-typed extension points, and Promise/AsyncIterable signatures. The host wraps plugin promises with `Effect.tryPromise` + timeouts/interruption. Plugin authors and UI devs never import `effect`.
   - Risks: learning curve (mitigate: ADR + "Effect in 20 minutes for Java devs" doc, generated code style via the v3→v4 migration skill), `@unstable` workflow (spike-gated, see 3.2), 47 MB install (tree-shaken in bundles), ecosystem split (hono/oRPC world vs Effect world — mitigated by OpenAPI as the contract).
2. **No Effect**: Hono 4.13 + oRPC 1.15 + Zod 4 (+ Standard Schema) + neverthrow + hookable/emittery + XState 5 for session statecharts + execa + Restate sidecar for durability + Vercel AI SDK for LLMs. Approachable, each piece small; cost = you write the glue (structured cancellation, retries, resource cleanup, tracing) and durability lives in a BSL sidecar.
3. **Effect everywhere** — rejected: plugin DX and UI code would require Effect literacy from every contributor.

Keep regardless of choice: **Standard Schema** as the validation contract (plugins choose their library), **XState** for the per-session/agent statechart that the pixel-office UI visualises (snapshots persisted to SQLite; not the durability engine), **emittery/hookable** only if not on Effect (Effect `PubSub`/`Stream` otherwise).

### 3.2 Durable workflow engine — ranking (and a gate)

1. **`effect/workflow` on SQLite** (only with 3.1-#1). Spike (1–2 days): run `ClusterWorkflowEngine` with `SingleRunner` + `SqlMessageStorage/SqlRunnerStorage` on `@effect/sql-sqlite-node`, kill the process mid-`DurableDeferred` wait, restart, resolve the deferred by an HTTP call, verify replay and compensation. If it passes → adopt; expose `Workflow`, `Activity`, `DurableDeferred` through plugin-api as plain functions (`defineStep`, `waitFor(token)`, `sleep()`), i.e. **plugins contribute steps at runtime as data**, which the directive-based Workflow SDK cannot do.
2. **Restate sidecar**: ByteBureau spawns `restate-server` (npm `@restatedev/restate` ships arm64 Linux/mac binaries) and registers its own TS services; awakeables for PR-review waits (resolved by the poller/webhook/UI), signals for "handle comments" loops, `ctx.sleep` for timeouts. Licence BSL 1.1 is compatible with ByteBureau (not a hosted Restate service). Risks: second process to supervise/upgrade, opaque journal for the office UI (mitigate via Restate admin API), memory footprint on Pi **unverified**.
3. **Workflow SDK + custom SQLite World**: adopt only if the owner loves the `"use step"` DX and accepts owning a World (queue + storage + streaming) and the Nitro/SWC build step; keep the Local World for dev only.
4. **Hand-rolled saga**: last resort.

Design rules independent of the engine: every external side effect is an idempotent step keyed by `(runId, stepName, attempt)`; human waits are durable promises keyed by deterministic tokens; wake-ups come from a *pluggable* `WakeSource` port (webhook plugin, poller plugin, UI); timeouts via durable sleep racing the promise; every step emits an event to the append-only session log that the office UI replays.

### 3.3 RPC/API — ranking and transport plan

1. **With Effect core**: `effect/http-api` for the public REST API with generated OpenAPI (`/openapi.json`) → generated TS client for web/desktop/phone/CLI (OpenCode's `httpapi-codegen` approach); `effect/rpc` over WebSocket (`effect/socket`, backpressured) for the desktop shell, plugin UI panels and the phone relay; SSE endpoints (`/sessions/:id/events`) for transcripts and office events with `Last-Event-Id` resume from the event log.
2. **Without Effect**: Hono 4.13 (`@hono/node-server` 2.1.3 or `@hono/bun`) + oRPC 1.15 (RPC handler for first-party clients, OpenAPI handler for everyone else; event iterators for SSE); Hono `upgradeWebSocket` for interactive channels.
- Both: **JSON-RPC 2.0** (`vscode-jsonrpc` or the MCP/ACP SDKs' transports) for subprocess plugins, MCP servers and ACP agents; `birpc` for Worker-hosted plugins; **no Cap'n Web, Connect-ES or Nitro/h3 v2 in v1**.
- Protocol package: `packages/protocol` holds the OpenAPI document, the event schemas (Standard JSON Schema), and versioned message types; clients depend on it, never on the kernel.

### 3.4 Config layout + schema plan

```
<project>/
  bytebureau.json            # team-shared, committed; "$schema": "https://bytebureau.dev/schema/v1/config.json", "version": 1
  bytebureau.local.json      # personal overrides, gitignored (like .claude/settings.local.json)
  .bytebureau/               # state, gitignored (like .claude/worktrees)
    db.sqlite                # sessions, event log, workflow state, plugin kv
    worktrees/<session-id>/
    sessions/<session-id>/transcript.jsonl
    logs/  cache/  plugins/  # project-local plugins (OpenCode .opencode/plugins)
~/.bytebureau/               # user config + data (override with BYTEBUREAU_HOME); or env-paths with suffix ''
  config.json  plugins/node_modules/  marketplaces/  logs/
OS keychain                  # tokens via @napi-rs/keyring; config refers to them as {env:VAR} or {secret:name}
```
- Schema generated at build from the kernel's own schema (Zod 4 `z.toJSONSchema({ target: "draft-2020-12" })` or Effect Schema `SchemaRepresentation`), published at a versioned URL like Biome; `version` key + migration list; plugin config under `plugins.<name>` validated by the plugin's Standard Schema and merged into the same JSON Schema (`$defs` per plugin, like Claude Code's `userConfig`).
- Loader: c12 (`name: "bytebureau"`, `configFile`, `rcFile: false` or `.bytebureaurc`, `$development` overrides, `extends` for team presets in a git repo — Renovate-style) with JSON/JSONC as the documented formats; `.ts` config supported but not advertised.
- Precedence: CLI flags > env (`BYTEBUREAU_*`) > `bytebureau.local.json` > `bytebureau.json` > `~/.bytebureau/config.json` > defaults (same shape as Claude Code/Codex).

### 3.5 Process & git orchestration plan

- **Topology**: one daemon `bytebureau serve` (HTTP+WS on localhost; `bytebureau service install` writes a launchd plist / systemd user unit / Windows Task); all clients (web, desktop shell, CLI, phone via relay) are thin; the pixel office is a client of the same event stream.
- **Supervisor service** (kernel): registry of `ManagedProcess { id, kind: 'agent'|'mcp'|'acp'|'runtime', spec, state, restartPolicy, backoff, startedAt }`; spawn via execa 10 (`cancelSignal`, `gracefulCancel`, `timeout`) or `Bun.spawn`; stdout/stderr consumed as line streams with bounded in-memory buffers, persisted to `transcript.jsonl` + SQLite index; crash → exponential backoff with `maxRestarts` (mirrors Claude Code LSP `restartOnCrash/maxRestarts/shutdownTimeout`); SIGTERM → grace → SIGKILL; per-project `p-queue` concurrency; resume after daemon restart from the event log (sessions marked `interrupted`, workflow engine re-schedules).
- **Agent sessions**: prefer headless protocols (Claude Agent SDK / `claude -p`, ACP `session/prompt` + `session/update`) over PTY; PTY (node-pty / bun-pty) only for TUIs the user wants to watch live.
- **Git**: tiny typed wrapper around the `git` binary (execa) — `worktreeAdd/Remove/List/Lock`, `fetch`, `push -u`, `branch`, `status --porcelain=v2`; one worktree per session under `.bytebureau/worktrees/<session-id>` on `bb/<ticket-key>-<slug>` from a fresh `origin/<default>` (fetch throttled), copy gitignored files listed in `bytebureau.json` `workspace.copyIgnored` (`.env`, `.env.local`), lock while a process runs, cleanup policy: auto-remove when clean and the PR is merged, otherwise keep N days; never operate on the main checkout from a session (Claude Code's four isolation checks as spec).
- **Workspace runtimes** are plugins behind a `WorkspaceRuntime` port: `local` (worktree on host), `docker` (bind-mount the worktree), `k8s`; the git worktree is the unit of isolation in every case.

### 3.6 Integration strategy (MCP vs SDK)

Rule: **ports in the kernel; adapters as plugins; an adapter may be (a) a direct SDK, (b) a bridge over an MCP server, (c) an ACP agent.** Ship (a) where offline polling, typing and rate-limit control matter; ship (b) where auth is painful or the vendor's official server is better than any SDK.

| Port | Default plugin (v1) | Transport | Alternative |
|---|---|---|---|
| `AgentProvider` | `plugin-agent-claude-code` (Agent SDK / `claude -p`), `plugin-agent-acp` (generic: Codex, Gemini CLI, OpenCode, Cline, Copilot…) | subprocess + JSON-RPC (ACP) / SDK | `plugin-agent-openai-compatible` for local LLM agents |
| `GitHost` | `plugin-github` (octokit 5, device-flow auth, conditional polling for reviews/checks) | REST + optional `gh webhook forward` (dev) | `plugin-gitlab` (gitbeaker 43), `plugin-gitea` (gitea-js) |
| `TicketSystem` | `plugin-github-issues`; `plugin-jira` via **Atlassian MCP** (OAuth 2.1, GA) with JQL polling for state changes; `plugin-linear` (SDK; Agents API only when a public URL/relay exists) | MCP / REST | `plugin-jira-rest` (jira.js 6 + API token) |
| `Chat` | `plugin-slack` (Bolt 5 Socket Mode — no public URL) | WebSocket | `plugin-discord` (gateway), Teams later |
| `Notifier` | desktop/`notify`, email, webhook | — | — |
| `WorkspaceRuntime` | `local`, `docker` | — | `k8s` |
| `SkillsSource` | git repo / Claude Code marketplace-compatible index | — | — |
| `UIPanel` | web components registered by name; rendered in web/desktop | — | — |
| `WakeSource` | poller (ETag), UI, local webhook receiver, relay | — | — |

Webhooks need a public URL (GitHub, Jira, Linear) — treat them as an *optional* `WakeSource` plugin (relay/tunnel), with polling as the always-available default.

### 3.7 Plugin API sketch (TS signatures)

```ts
// packages/plugin-api/src/manifest.ts  — in package.json: { "bytebureau": { ... } } or bytebureau-plugin.json
export interface PluginManifest {
  name: string                       // kebab-case; npm: @bytebureau/plugin-<name> | bytebureau-plugin-<name>
  version: string                    // semver
  displayName?: string
  description?: string
  hostApi: string                    // semver range of @bytebureau/plugin-api, e.g. "^1"
  kind: 'in-process' | 'subprocess' | 'mcp' | 'acp' | 'wasm'
  entry?: string                     // exports["./plugin"] by default
  capabilities?: Array<'fs:read' | 'fs:write' | 'net' | 'process' | 'secrets' | 'ui'>  // policy + display
  dependencies?: Array<string | { name: string; version?: string; marketplace?: string }>
  config?: StandardSchemaV1          // Standard Schema; its JSON Schema is merged into bytebureau.json's $schema
  secrets?: Record<string, { title: string; description?: string }>   // stored in keychain, injected by name
  contributes?: Partial<Record<ExtensionPointId, string[]>>           // discovery without loading code
}

// packages/plugin-api/src/plugin.ts
export interface PluginContext<C> {
  readonly config: C
  readonly project: ProjectInfo | null
  readonly logger: Logger
  readonly events: EventBus            // typed publish/subscribe over the session event log
  readonly secrets: SecretStore        // get(name) → Promise<string | undefined>
  readonly storage: PluginKv           // namespaced SQLite kv (like Claude Code mods' $.store)
  readonly process: ProcessSpawner     // supervised execa/Bun.spawn with budgets
  readonly http: typeof fetch
  readonly signal: AbortSignal         // cancelled on unload
}

export interface Plugin<C = unknown> {
  readonly manifest: PluginManifest
  setup(ctx: PluginContext<C>): Promise<PluginRegistration> | PluginRegistration
}

export interface PluginRegistration {
  readonly agentProviders?: AgentProvider[]
  readonly gitHosts?: GitHost[]
  readonly ticketSystems?: TicketSystem[]
  readonly chats?: ChatChannel[]
  readonly notifiers?: Notifier[]
  readonly workspaceRuntimes?: WorkspaceRuntime[]
  readonly skillSources?: SkillSource[]
  readonly uiPanels?: UiPanel[]
  readonly workflowSteps?: StepDefinition[]       // data-registered steps for the durable engine
  readonly wakeSources?: WakeSource[]
  readonly hooks?: Partial<Hooks>                  // middleware-style interception
  dispose?(): Promise<void>
}

export const definePlugin = <C>(p: Plugin<C>) => p

// Hooks: Claude-Code-mods style middleware (every handler gets (e, next); return next(e) or a short-circuit)
export interface Hooks {
  'session.start': Hook<SessionStartEvent, void>
  'agent.beforeSpawn': Hook<AgentSpawnEvent, AgentSpawnEvent>          // rewrite args/env or deny
  'tool.call': Hook<ToolCallEvent, ToolCallResult | { deny: string }>
  'workflow.beforeStep': Hook<StepEvent, StepEvent>
  'ask': Hook<AskEvent, AskAnswer>                                     // route human questions (UI, Slack, phone)
  'pr.beforeOpen': Hook<PrDraft, PrDraft>
  'ticket.beforeTransition': Hook<TicketTransition, TicketTransition>
}
export type Hook<E, R> = (e: Readonly<E>, next: (e: E) => Promise<R>) => Promise<R>

// Extension points (secondary ports) — all DTO-in/DTO-out, AsyncIterable for streams, no functions in payloads
export interface AgentProvider {
  readonly id: string                                  // 'claude-code' | 'codex' | 'opencode' | 'acp:<name>'
  readonly capabilities: { streaming: boolean; resume: boolean; askUser: boolean; mcp: boolean }
  start(req: AgentRunRequest): Promise<AgentHandle>    // { sessionId, events: AsyncIterable<AgentEvent>, send(...) }
  resume?(sessionId: string): Promise<AgentHandle>
}
export interface GitHost {
  readonly id: 'github' | 'gitlab' | 'gitea' | (string & {})
  openPullRequest(input: PrInput): Promise<PrRef>
  getReviewState(ref: PrRef): Promise<ReviewState>      // polled with ETag by the kernel
  listReviewComments(ref: PrRef, since?: string): Promise<ReviewComment[]>
  merge(ref: PrRef, strategy: MergeStrategy): Promise<MergeResult>
  watch?(ref: PrRef): AsyncIterable<PrEvent>            // optional push (webhook/relay)
}
export interface TicketSystem {
  readonly id: 'github-issues' | 'jira' | 'linear' | (string & {})
  get(key: string): Promise<Ticket>
  transition(key: string, to: TicketStatus): Promise<void>
  comment(key: string, body: MarkdownBody): Promise<void>
  poll?(query: TicketQuery, since?: string): Promise<Ticket[]>
}
export interface ChatChannel {
  readonly id: 'slack' | 'discord' | 'teams' | (string & {})
  post(target: ChatTarget, msg: ChatMessage): Promise<ChatMessageRef>
  ask?(target: ChatTarget, q: Question): Promise<Answer>   // human-in-the-loop over chat
  inbound?(): AsyncIterable<ChatInbound>                   // Socket Mode / gateway
}
export interface WorkspaceRuntime {
  readonly id: 'local' | 'docker' | 'k8s' | (string & {})
  provision(ws: WorkspaceSpec): Promise<WorkspaceHandle>   // worktree path bind-mounted or used directly
  exec(h: WorkspaceHandle, cmd: ExecSpec): Promise<ExecHandle>
  destroy(h: WorkspaceHandle): Promise<void>
}
export interface StepDefinition<I = unknown, O = unknown> {
  readonly name: string; readonly input: StandardSchemaV1<I>; readonly output: StandardSchemaV1<O>
  readonly retry?: { max: number; backoff: 'exp' | 'fixed'; base: string }
  run(input: I, ctx: StepContext): Promise<O>              // idempotent; ctx.waitFor(token), ctx.sleep(), ctx.ask()
}
```

Discovery & install: `bytebureau.json` → `"plugins": ["@bytebureau/plugin-github", "./.bytebureau/plugins/my-thing", { "npm": "bytebureau-plugin-foo", "version": "^1" }]`; registries = git repos with `.bytebureau/marketplace.json` (Claude Code's shape: `name, owner, plugins[{ name, source{github|npm|git-subdir|url|archive+sha256}, version, description, category, tags }]`); npm search by keyword `bytebureau-plugin`; installs with scripts disabled into `~/.bytebureau/plugins/node_modules` (OpenCode/Claude Code behaviour); `hostApi` range checked against `@bytebureau/plugin-api` version; `bytebureau plugin validate` like `claude plugin validate`.

Migration path to isolation: because `PluginRegistration` members are DTO-based, a `kind: 'subprocess'` plugin runs the same `Plugin` under a JSON-RPC host (`packages/plugin-host-subprocess`, Node `--permission` or Deno flags as seat belt), a `kind: 'wasm'` plugin exposes the same functions via Extism host functions; the kernel sees one `PluginInstance` interface in all cases.

### 3.8 Recommended core architecture (text diagram)

```
┌──────────────────────────────── clients ────────────────────────────────┐
│ apps/web (office sim + chat)  apps/desktop (shell)  apps/cli (headless) │
│ phone (E2EE via apps/relay)   plugin UI panels (web components)          │
└───────────────┬────────────── OpenAPI client ── SSE ── WebSocket ────────┘
                ▼
┌────────────────────────────── apps/server (daemon) ──────────────────────┐
│ packages/protocol: OpenAPI doc, event schemas, versioned messages         │
│ API layer: http-api (REST+OpenAPI) │ rpc over WS │ SSE event streams      │
├──────────────────────────── packages/kernel (Effect) ─────────────────────┤
│ Config (c12 + Schema)   Event log (SQLite, append-only, replayable)       │
│ Plugin host (manifest, Standard Schema config, hooks, lifecycle, policy)  │
│ Supervisor (processes, PTY, backoff, budgets)   Worktree manager (git)    │
│ Workflow engine (effect/workflow | Restate adapter)   Session statecharts │
│ LLM layer (effect/ai + MCP)   Secrets (keyring)   Telemetry (OTel)        │
├──────────────────── ports (packages/plugin-api, plain TS) ────────────────┤
│ AgentProvider GitHost TicketSystem Chat Notifier WorkspaceRuntime         │
│ SkillSource UiPanel StepDefinition WakeSource                             │
├──────────────────────── adapters = plugins/* ─────────────────────────────┤
│ in-process TS  │ subprocess JSON-RPC │ MCP servers │ ACP agents │ (WASM)  │
│ github gitlab gitea · github-issues jira(MCP) linear · slack discord      │
│ claude-code codex(ACP) opencode(ACP) local-llm · local docker k8s         │
└───────────────────────────────────────────────────────────────────────────┘
```

### 3.9 Monorepo tree

```
byte-bureau/
├── apps/
│   ├── server/        # bytebureau serve: wires kernel + API; single entry, no business logic
│   ├── cli/           # effect/cli (or citty); `bytebureau serve|run|plugin|service install`
│   ├── web/           # Vite 8 + React/Vue; office sim + chat; consumes packages/sdk
│   ├── desktop/       # shell around web (Tauri/Electron decided elsewhere)
│   └── relay/         # optional E2EE relay for phone/webhooks (deployable separately)
├── packages/
│   ├── kernel/        # Effect runtime: config, event-log, plugin-host, supervisor, worktrees, workflow, llm
│   ├── plugin-api/    # ports + manifest + definePlugin; ZERO runtime deps besides @standard-schema/spec
│   ├── protocol/      # OpenAPI document, event JSON Schemas, message versions (shared by server & clients)
│   ├── schema/        # bytebureau.json schema source + generated JSON Schema (published)
│   ├── sdk/           # generated typed client (from OpenAPI) + SSE/WS helpers
│   ├── sim/           # pixel-office simulation model (pure TS, no DOM)
│   ├── ui/            # shared web components / design tokens
│   └── plugin-host-subprocess/ # JSON-RPC host for kind: 'subprocess' plugins (later: -wasm)
├── plugins/           # first-party adapters, each a publishable @bytebureau/plugin-* package
│   ├── github/ gitlab/ gitea/ github-issues/ jira/ linear/ slack/ discord/
│   ├── agent-claude-code/ agent-acp/ agent-openai-compatible/
│   ├── runtime-local/ runtime-docker/ runtime-k8s/
│   └── skills-git/ notifier-desktop/ wake-poller/ wake-webhook/
├── docs/decisions/    # MADR 4.0 ADRs: 0001-effect-in-kernel.md, 0002-workflow-engine.md, ...
├── .dependency-cruiser.mjs   # rules: plugins→plugin-api only; apps→kernel/sdk only; no cycles; no barrels inside src
├── biome.json  turbo.json  tsconfig.base.json  package.json (workspaces + catalog)
└── bytebureau.json    # dogfood: the repo configures itself
```

Code-quality rules to encode: `dependency-cruiser` forbidden rules (`plugins/** → packages/kernel` forbidden; `packages/plugin-api → anything runtime` forbidden; `apps/web → packages/kernel` forbidden; `no-circular`, `no-orphans`); no `index.ts` barrels except package entry points; one exported symbol family per file; names say what, not how (`PullRequestPoller`, not `GithubHelper`); comments only for *why*; ADR before any new dependency in `kernel`; `bytebureau plugin validate` + `claude plugin validate`-style CLI in CI; `tsgo` (TypeScript 7 native) for type-checking in CI.

---

## 4. Rejected options (with reasons)

- **tsyringe / inversify** — decorator DI needs legacy `experimentalDecorators` + `reflect-metadata` (tsyringe) or a container nobody else in the stack uses; Effect Layers (or plain factories without Effect) cover DI.
- **isolated-vm** — maintenance mode, native build, Node-only, memory limits bypassable.
- **ComponentizeJS / jco as v1 plugin runtime** — "experimental", 42.8 MB toolchain, ~8 MB per component, TS→component ergonomics immature.
- **Extism JS PDK as v1 plugin runtime** — sync-only (no event loop), Binaryen toolchain; keep as tier-3 for pure-compute plugins.
- **QuickJS/Figma-style sandbox for integrations** — no `fetch`/timers; wrong fit for I/O-heavy adapters.
- **DBOS, Hatchet, Trigger.dev, Temporal, Inngest, Cloudflare Workflows** — external DB/server/Redis/ClickHouse or lock-in; see §2.3.
- **Workflow SDK as the primary engine** — Local World not production, Postgres World a reference implementation, compile-time steps vs runtime plugin steps.
- **`durable-execution`** — pre-1.0, peer `effect ^3`.
- **isomorphic-git** — no worktree support, two volunteer maintainers.
- **Connect-ES** — protobuf codegen for a TS-only system; revisit only for polyglot plugins.
- **Cap'n Web** — pre-1.0, schema-less, security burden; watch for the phone-remote capability model.
- **tRPC** — no first-class OpenAPI (per oRPC's comparison; tRPC's own notes mention OpenAPI improvements — unverified), largest bundle.
- **Elysia, Nitro v3, h3 v2** — beta churn / Bun lean.
- **cosmiconfig / lilconfig** — superseded by c12 for layering; fine if you want zero deps and only JSON.
- **Vibe Kanban / Crystal as code to reuse** — Vibe Kanban is sunsetting (Rust), Crystal deprecated (Feb 2026); use only as behavioural references.
- **Jira OAuth 2.0 3LO directly from the desktop app** — requires a client secret; use the Atlassian MCP server (OAuth 2.1) or API tokens.
- **Slack HTTP events / Jira / GitHub / Linear webhooks as the default wake-up** — need a public HTTPS URL; polling is the default, webhooks an optional plugin.

---

## 5. Open questions for the owner

1. **Effect commitment**: "Effect in the kernel only" (recommended) vs "no Effect". This single decision selects the workflow engine (§3.2) and the API layer (§3.3). Are you comfortable that kernel contributors must learn Effect, while plugin/UI contributors never do?
2. **Durability gate**: approve the 1–2 day spike of `effect/workflow` + cluster storage on SQLite. If it fails, is a **Restate sidecar under BSL 1.1** acceptable (it is for internal use; it forbids re-selling Restate as a service)?
3. **Runtime**: Bun (OpenCode's choice; `Bun.spawn`, `bun:sqlite`, bun-pty) or Node 22/24/26 (`node:sqlite`, node-pty, execa)? Effect 4 supports both; the Pi 5 (arm64) is fine with both. Mixed is possible but doubles the test matrix.
4. **Plugin trust model for v1**: all plugins trusted/in-process (like OpenCode, Nuxt, Claude Code mods), with `capabilities` in the manifest as *declared policy* only? Marketplace + WASM/subprocess isolation deferred to v2?
5. **Config file name**: `bytebureau.json` at the project root (visible, like `opencode.json`/`biome.json`) vs `.bytebureau/config.json` (hidden, like `.claude/settings.json`)? I recommend the former for team-shared config and `.bytebureau/` for state.
6. **GitHub auth**: register an official "ByteBureau" GitHub App (device flow, client id shipped in the binary) vs PAT-only for v1? A GitHub App also enables an installation-token server mode later.
7. **Jira**: default to the Atlassian MCP server (OAuth 2.1, no secret) or to API-token REST (jira.js)? Both can ship; which is "preinstalled"?
8. **Public URL strategy**: will `apps/relay` (for the E2EE phone remote) also terminate webhooks? If yes, the `WakeSource` design can prefer push when a relay is configured.
9. **Daemon packaging**: `bytebureau service install` generating launchd/systemd-user units is in scope for v1? Windows service too?
10. **TypeScript 7 (tsgo)**: adopt now for type-checking (Effect recommends TS 7; OpenCode uses `@typescript/native-preview`) while bundling with Vite 8/Rolldown?
11. **Schema library at the edges**: pick one house default for first-party plugins (Zod 4.6 is the safest; Effect Schema if you want zero extra deps in kernel-adjacent code) while accepting any Standard Schema from third parties?
12. **Linear agents / Slack marketplace**: do you want ByteBureau to be installable as a *Linear agent* (needs public webhook URL) or as a *Slack Marketplace app* (Socket Mode disallowed)? If not, Socket Mode + polling stay the defaults.

---

## 6. Sources (fetched 2026-10-02)

Plugin systems & sandboxing
- https://github.com/unjs/hookable · https://registry.npmjs.org/hookable/latest
- https://github.com/webpack/tapable · https://vite.dev/guide/api-plugin · https://registry.npmjs.org/vite/latest · https://github.com/unjs/unplugin
- https://nuxt.com/docs/4.x/guide/going-further/modules · https://docs.astro.build/en/reference/integrations-reference/ · https://eslint.org/docs/latest/extend/plugins · https://fastify.dev/docs/latest/Reference/Plugins/
- https://backstage.io/docs/backend-system/architecture/index/ · https://docs.medusajs.com/learn/fundamentals/modules · https://payloadcms.com/docs/plugins/overview · https://docs.strapi.io/cms/plugins-development/developing-plugins · https://docs.obsidian.md/Plugins/Getting+started/Anatomy+of+a+plugin
- https://code.visualstudio.com/api/advanced-topics/extension-host · https://zed.dev/docs/extensions/developing-extensions · https://developers.figma.com/docs/plugins/how-plugins-run/
- https://code.claude.com/docs/en/plugins · https://code.claude.com/docs/en/plugins/manifest-reference · https://code.claude.com/docs/en/plugins/marketplace-reference · https://code.claude.com/docs/en/plugin-marketplaces · https://code.claude.com/docs/en/plugins/mods/reference.md · https://code.claude.com/docs/en/channels-reference.md · https://code.claude.com/docs/en/settings · https://code.claude.com/docs/en/worktrees.md · https://code.claude.com/docs/llms.txt
- https://opencode.ai/docs/plugins/ · https://opencode.ai/docs/config/ · https://registry.npmjs.org/@opencode-ai/plugin/latest · https://github.com/anomalyco/opencode · https://github.com/anomalyco/opencode/tree/dev/packages · https://raw.githubusercontent.com/anomalyco/opencode/dev/package.json · https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/package.json
- https://standardschema.dev/ · https://github.com/standard-schema/standard-schema
- https://github.com/extism/extism · https://github.com/extism/extism/releases · https://github.com/extism/js-sdk · https://github.com/extism/js-pdk · https://registry.npmjs.org/@extism/extism/latest
- https://github.com/bytecodealliance/jco · https://github.com/bytecodealliance/jco/releases · https://bytecodealliance.github.io/jco/ · https://registry.npmjs.org/@bytecodealliance/jco/latest · https://github.com/bytecodealliance/ComponentizeJS · https://registry.npmjs.org/@bytecodealliance/componentize-js/latest
- https://github.com/laverdet/isolated-vm · https://github.com/justjake/quickjs-emscripten · https://nodejs.org/api/permissions.html · https://docs.deno.com/runtime/fundamentals/security/ · https://bun.sh/docs/api/spawn
- https://modelcontextprotocol.io/specification/latest · https://registry.npmjs.org/@modelcontextprotocol/sdk/latest
- https://agentclientprotocol.com/overview/introduction · https://agentclientprotocol.com/llms.txt · https://agentclientprotocol.com/protocol/v2/overview.md · https://agentclientprotocol.com/libraries/typescript.md · https://agentclientprotocol.com/get-started/agents.md · https://registry.npmjs.org/@agentclientprotocol/sdk/latest · https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest

Core runtime
- https://effect.website/blog/ · https://effect.website/blog/releases/effect/40 · https://effect.website/blog/effect-v4-rc-august-recap · https://effect.website/blog/module-of-the-week/cluster-actors · https://github.com/Effect-TS/effect/releases · https://registry.npmjs.org/effect/latest · https://registry.npmjs.org/@effect/platform-node/latest · https://registry.npmjs.org/@effect/ai-anthropic/latest
- https://github.com/Effect-TS/effect/tree/main/packages/effect/src · …/src/workflow/Workflow.ts (raw) · …/src/workflow/WorkflowEngine.ts (raw) · …/src/cluster · …/src/rpc · …/src/ai
- https://registry.npmjs.org/zod/latest · https://zod.dev/json-schema · https://registry.npmjs.org/arktype/latest · https://registry.npmjs.org/valibot/latest · https://github.com/supermacro/neverthrow · https://registry.npmjs.org/neverthrow/latest
- https://registry.npmjs.org/xstate/latest · https://stately.ai/docs/persistence · https://stately.ai/docs/xstate-store · https://registry.npmjs.org/@xstate/store/latest
- https://github.com/sindresorhus/emittery · https://registry.npmjs.org/emittery/latest · https://github.com/inversify/InversifyJS · https://registry.npmjs.org/inversify/latest · https://github.com/microsoft/tsyringe · https://registry.npmjs.org/typescript/latest

Durable workflows
- https://github.com/vercel/workflow · https://registry.npmjs.org/workflow/latest · https://workflow-sdk.dev/docs · https://workflow-sdk.dev/llms.txt · https://workflow-sdk.dev/docs/foundations/workflows-and-steps · https://workflow-sdk.dev/docs/foundations/hooks · https://workflow-sdk.dev/docs/foundations/errors-and-retries · https://workflow-sdk.dev/docs/deploying · https://workflow-sdk.dev/worlds/local · https://workflow-sdk.dev/worlds/postgres · https://workflow-sdk.dev/docs/how-it-works/framework-integrations · https://workflow-sdk.dev/docs/getting-started/hono · https://registry.npmjs.org/@workflow/world-postgres/latest
- https://docs.restate.dev/develop/ts/overview · https://docs.restate.dev/llms.txt · https://docs.restate.dev/develop/ts/external-events.md · https://docs.restate.dev/server/overview.md · https://github.com/restatedev/restate · https://github.com/restatedev/restate/releases · https://github.com/restatedev/restate/blob/main/LICENSE · https://registry.npmjs.org/@restatedev/restate-sdk · https://registry.npmjs.org/@restatedev/restate/latest
- https://docs.dbos.dev/typescript/programming-guide · https://docs.dbos.dev/typescript/reference/configuration · https://github.com/dbos-inc/dbos-transact-ts
- https://www.inngest.com/docs/self-hosting · https://github.com/inngest/inngest · https://github.com/temporalio/sdk-typescript · https://docs.temporal.io/cli/server · https://trigger.dev/docs/self-hosting/overview · https://trigger.dev/docs/self-hosting/docker · https://github.com/triggerdotdev/trigger.dev · https://github.com/hatchet-dev/hatchet · https://developers.cloudflare.com/workflows/ · https://registry.npmjs.org/durable-execution/latest

RPC/API
- https://orpc.dev/docs/getting-started · https://orpc.dev/docs/comparison · https://github.com/unnoq/orpc · https://registry.npmjs.org/@orpc/server
- https://github.com/trpc/trpc/releases · https://registry.npmjs.org/@trpc/server
- https://github.com/honojs/hono/releases · https://registry.npmjs.org/hono · https://hono.dev/docs/guides/rpc · https://hono.dev/docs/helpers/websocket · https://hono.dev/docs/helpers/streaming · https://registry.npmjs.org/@hono/node-server/latest · https://registry.npmjs.org/@hono/zod-openapi/latest · https://registry.npmjs.org/hono-openapi/latest
- https://elysiajs.com/ · https://github.com/cloudflare/capnweb · https://registry.npmjs.org/capnweb · https://github.com/connectrpc/connect-es · https://github.com/antfu/birpc · https://registry.npmjs.org/comlink/latest · https://registry.npmjs.org/vscode-jsonrpc/latest · https://registry.npmjs.org/json-rpc-2.0/latest · https://nitro.build/ · https://h3.dev/

Config
- https://github.com/unjs/c12 · https://registry.npmjs.org/c12/latest · https://github.com/cosmiconfig/cosmiconfig · https://github.com/antonk52/lilconfig · https://github.com/sindresorhus/env-paths · https://github.com/Brooooooklyn/keyring-node · https://registry.npmjs.org/@napi-rs/keyring/latest
- https://biomejs.dev/reference/configuration/ · https://turborepo.dev/docs/reference/configuration · https://registry.npmjs.org/turbo/latest · https://docs.renovatebot.com/config-overview/ · https://learn.chatgpt.com/docs/config-file/config-reference (Codex)

Process, git, integrations
- https://github.com/sindresorhus/execa · https://registry.npmjs.org/execa/latest · https://registry.npmjs.org/zx/latest · https://github.com/microsoft/node-pty · https://registry.npmjs.org/node-pty/latest · https://registry.npmjs.org/bun-pty/latest · https://registry.npmjs.org/p-queue/latest
- https://github.com/steveukx/git-js · https://registry.npmjs.org/simple-git/latest · https://github.com/isomorphic-git/isomorphic-git · https://github.com/BloopAI/vibe-kanban · https://github.com/stravu/crystal · https://conductor.build/
- https://github.com/octokit/octokit.js · https://registry.npmjs.org/octokit/latest · https://registry.npmjs.org/@octokit/rest/latest · https://registry.npmjs.org/@octokit/auth-oauth-device/latest · https://github.com/octokit/webhooks.js · https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api · https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps · https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/using-the-github-cli-to-forward-webhooks-for-testing
- https://github.com/jdalrymple/gitbeaker · https://registry.npmjs.org/@gitbeaker/rest/latest · https://registry.npmjs.org/gitea-js/latest
- https://github.com/MrRefactoring/jira.js · https://registry.npmjs.org/jira.js/latest · https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/ · https://developer.atlassian.com/cloud/jira/platform/webhooks/ · https://github.com/atlassian/atlassian-mcp-server · https://www.atlassian.com/blog/announcements/remote-mcp-server
- https://linear.app/developers/agents · https://registry.npmjs.org/@linear/sdk/latest
- https://docs.slack.dev/apis/events-api/using-socket-mode/ · https://github.com/slackapi/bolt-js · https://registry.npmjs.org/@slack/bolt/latest · https://github.com/discordjs/discord.js · https://registry.npmjs.org/discord.js/latest

Structure & quality
- https://github.com/mastra-ai/mastra · https://github.com/sverweij/dependency-cruiser · https://registry.npmjs.org/dependency-cruiser/latest · https://tkdodo.eu/blog/please-stop-using-barrel-files · https://adr.github.io/madr/ · https://alistair.cockburn.us/hexagonal-architecture/
