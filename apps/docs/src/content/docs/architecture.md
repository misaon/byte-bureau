---
title: Architecture
description: Daemon, kernel, plugins and clients.
---

ByteBureau is a single binary that runs a local daemon. Clients (web UI, desktop shell, phone, CLI) talk to it over an OpenAPI-described HTTP API, server-sent events and a WebSocket. The kernel keeps an append-only event log of everything that happens; the office simulation, the chat and the telemetry are projections of that log. Integrations are plugins behind typed ports: agent providers, workspace runtimes, git hosts, ticket systems, chat and notifiers.

Read the [technology research](https://github.com/misaon/byte-bureau/blob/main/docs/research/2026-10-02-technology-landscape.md), the [design specs](https://github.com/misaon/byte-bureau/tree/main/docs/superpowers/specs) and the decision records in the sidebar.

## Packages

The kernel is hexagonal: `packages/kernel` holds the domain and the application services as Effect 4 layers, plugins are adapters behind the ports of `packages/plugin-api`, `packages/protocol` holds the shared schemas, and `apps/bytebureau` wires everything into one binary. Sub-project 1 (the kernel and the agent runtime) is built in phases: phase A is the core and a headless run with the fake provider, phase B adds the daemon, the API and the client, phase C the Claude and ACP adapters with profiles and the secret store, phase D diagnostics and installation.

| Package | Contents | Licence | Phase |
| --- | --- | --- | --- |
| `packages/protocol` | Effect Schema definitions of every DTO, event and configuration file, the event catalogue with typed payload decoding, the contract of the API (request bodies, problem details, the `server.json` record, the RPC group), generated JSON Schema (`schemas/*.json`) | MIT | A |
| `packages/plugin-api` | `definePlugin()`, `PluginManifest`, `PluginContext`, the port interfaces (`AgentProvider`, `WorkspaceRuntime`, `SecretStore`) and the hook types; plain TypeScript | MIT | A |
| `packages/client` | The generated client, the event subscription and the RPC connection; no Effect at runtime | MIT | B |
| `packages/kernel` | Services (configuration, store, event log, project registry, supervisor, workspaces, sessions, asks, usage, health), the plugin host, error types, a Promise facade for the CLI, the Bun layer the daemon runs on and test utilities (the fake provider, `KernelTest`) | FSL-1.1-MIT | A |
| `packages/api` | The HTTP API, SSE and RPC adapters over the kernel; its build generates the OpenAPI document (`openapi.json`) | FSL-1.1-MIT | B |
| `plugins/agent-claude` | Claude adapter through `@anthropic-ai/claude-agent-sdk` | FSL-1.1-MIT | C |
| `plugins/agent-acp` | Generic adapter for Agent Client Protocol agents (Codex, Gemini CLI, OpenCode, Pi) with presets | FSL-1.1-MIT | C |
| `plugins/workspace-local` | Git worktree workspace runtime on the host | FSL-1.1-MIT | A |
| `apps/bytebureau` | The CLI (`run`, `sessions`, `ask`, `projects`, `workspaces`, `plugins`, `config` and the status) as a client of the daemon or of an in-process kernel, and `serve`, the daemon itself; the slot for the embedded web UI follows | FSL-1.1-MIT | A |
| `tools/client-codegen` | The client generator (hey-api) in an install of its own on TypeScript 6; `bun run generate:client` writes `packages/client/src/gen` from `packages/api/openapi.json` | FSL-1.1-MIT | B |

Only `kernel`, `api` and `protocol` import `effect` ([ADR-0003](../decisions/0003-effect-in-the-kernel-only/)). `plugin-api`, `client` and the plugins are plain TypeScript with Promise and AsyncIterable signatures, plugins import only `@bytebureau/plugin-api`, `@bytebureau/protocol` and third-party packages, and nothing imports from `apps/`. dependency-cruiser enforces the import rules in CI.

## What a run does

1. `bytebureau run "<prompt>" --project <repository>` talks to the daemon of the home, `$BYTEBUREAU_HOME` (`~/.bytebureau` by default), and starts it when none answers; the daemon runs the kernel, with its SQLite store in `<home>/data` and the bundled plugins loaded. With `--no-daemon` the CLI boots the same kernel inside its own process instead, which is refused while a daemon serves the home. [Daemon and API](../daemon-and-api/) tells the whole of it.
2. The CLI registers the project and creates a session, and the kernel gives the session a git worktree under `<project>/.bytebureau/worktrees/` on a `bb/<slug>` branch, so the main checkout is never touched.
3. The prompt goes to the `AgentProvider` port as one turn, and the kernel turns what the agent does into events, which the event log stores with an ever increasing `seq` unless they are ephemeral, like text deltas.
4. The CLI follows the durable events of the session, over SSE from the daemon, and prints them, as NDJSON with `--json`, and it answers an ask with the recommended option under `--yes` or with the choice made at a prompt.
5. When the turn completes the CLI completes the session and leaves the worktree for inspection, and the exit code says how the run ended: 0 completed, 3 stopped or interrupted, 4 when the project, its worktree or the provider cannot be used or the session errors. An invalid configuration, a failure of the store or a daemon that cannot be reached exits 2, a usage error or a refused `--no-daemon` 1.

## Decisions of phase A

- SQLite is reached through `effect/sql` with embedded migrations, and Drizzle is deferred ([ADR-0010](../decisions/0010-sqlite-through-effect-sql/)).
- Configuration files are JSON or JSONC read as text and never run, and c12 is gone ([ADR-0011](../decisions/0011-configuration-files-are-data/)).
- An agent child process is spawned detached in a process group of its own, so Ctrl-C at the terminal reaches the kernel only, and it is signalled as a group, so what it started goes with it; its `exit` resolves at most two seconds after the process ends, even when a grandchild keeps a pipe open.
- A child process gets an explicit environment allowlist (`PATH`, `HOME`, `LANG` and `LC_*`, `TMPDIR`, `TERM`, `TRACEPARENT`, `BYTEBUREAU_*` and the variables a spawn names explicitly), never the whole environment. `SSH_AUTH_SOCK` is on the list too, because git, ssh and Claude Code need the agent socket to reach SSH remotes. The extra environment of a session keeps its `BYTEBUREAU_*` names only, and `providers.<id>.passEnv` in the project file names the further variables the agents of a provider get.
- A session reads the configuration of its project when it is created, with the environment of the kernel, so `BYTEBUREAU_EMPLOYEE` and `BYTEBUREAU_BRANCH` reach `bytebureau run` and `--employee` and `--branch` still win; the snapshot the registry stored stays the record of the registration.
- The ask policy recommends `allow` for a shell command only when the whole command is one simple read-only command (no pipe, list, redirection or substitution), uses no flag that writes or runs something, has no word the shell expands (a glob, braces, a variable or an escape outside quotes) and names nothing outside the workspace, the value of a short flag and the path of a git revision included; a command that names a secrets path is denied. A `Glob` is judged by every pattern its braces stand for, and a file-tool path that starts with `~` gets no recommendation, since the tool may expand it. The kernel never makes up an answer for a question without a recommended option: even for an autonomous employee such a question waits for a human, and an answer must pick options the ask offers.
- `KernelTest`, the kernel over an in-memory store, is exported from `@bytebureau/kernel/testing`, so tests run the real services.
- `--json` is NDJSON, one event per line; a run without `--json` and without a terminal prints plain text, with no colours and no prompts.
- Every log record goes to stderr, whatever its level, so stdout carries only what a command prints. The level comes from `--log-level`, else `BYTEBUREAU_LOG_LEVEL`, else `logging.level` of the user file, else info, and `--debug` lets Effect's own debug records through to the categories it selects.
- The home of the kernel is private: `<home>` and `<home>/data` are created for the user alone (0700), a directory that exists keeps its mode, and the database is 0600. A mode the system refuses to set is logged as a warning and the kernel starts all the same.
- Event payloads are decoded as strictly as the published JSON Schema describes them: a field the schema does not know is refused.
- `workspaces prune` keeps a worktree for uncommitted changes or for commits no remote-tracking ref contains; a pushed branch is removed.

## Decisions of phase B

- The health check, `GET /api/v1/health`, is the one operation of the API without a token, so a client can check a daemon before it has read the token; the OpenAPI document is served without one as well.
- Errors are RFC 9457 problems with one schema per status, each with its status as a literal, so the OpenAPI document and the generated client know which problem every status carries.
- The token is made at the first start of a home and kept in `daemon.token` across restarts, so a client that has read it goes on working; `server.json` carries a copy while the daemon runs.
- A session that a restart interrupted is `stopped`, with its turn `interrupted` (reason `daemon_restart`) and its asks cancelled, and resumable with `sessions resume`; spec §14 had the session marked `interrupted`, which is a status of turns.
- Event payloads are redacted once, at publish ([ADR-0012](../decisions/0012-event-payloads-are-redacted-at-publish/)).
- The WebSocket speaks `effect/rpc` with JSON envelopes, which the client implements in plain TypeScript, and the token travels in the headers of every request ([ADR-0013](../decisions/0013-api-transports/)).
- The client is generated by hey-api, which runs in `tools/client-codegen` on TypeScript 6 because TypeScript 7 ships no compiler API; the output is committed, and CI checks that it and `openapi.json` are up to date.
- A daemon reads its own environment, not the one of the command: `run` sends its `BYTEBUREAU_*` variables with the session, which keeps them for the agent at the start and at every resume, and a daemon started on demand gets none of those that choose for one run.
- `--no-daemon` is refused while a daemon answers on the same home, as the store has one writer.
- `bytebureau serve` detaches by default (`--no-daemonize` keeps it in the foreground), and `serve --stop` ends the daemon of the home.
- `bytebureau` with no command is the status; there is no `status` command to name.
- Global flags may stand before or after a command name, at any level, and every command but `run` ends a refused request with exit 1 and the detail of the problem.
- The SSE heartbeat is an event, `event: heartbeat`, rather than a comment, so every frame decodes as an envelope; the first one goes out at once.
- The plugin context runs what a plugin calls on the services of the kernel, captured when the plugin host is built, like any fiber of the kernel.

## Deferred to later phases

- The supervisor's restart policy (spec §14, restart with backoff at most three times) arrives with the real providers of phase C; `restartSchedule` is not used yet.
- Profile variables in the agent environment and the `profiles` group of the API arrive with the profiles of phase C; `providers.<id>.passEnv` is the only extra source until then.
- The `^0` host API semver policy is settled, and `publint` and `arethetypeswrong` run, before the first publish.
- One shared test-support package replaces the copies of the test helpers: the `testing` export of the kernel serves the API now, and the CLI and the workspace plugin keep their copies until a fifth copy would appear.
- A Scalar UI for the OpenAPI document comes later, for development only.
- CORS for origins beyond the empty list arrives with the web UI of SP2.
- An `extends` key, for configuration files built on presets, comes later.
- The timers of asks left pending are not restored at a start: the sessions a restart interrupted are stopped instead.
- WebSocket authentication for browsers, by a first message or a ticket, arrives with SP2.
- `plugins add` and `plugins rm` (installing third-party plugins, with the capabilities of the manifest shown and confirmed), `doctor`, `diag bundle`, `service`, `upgrade` and `completions` arrive in phase D.
- `--output-format` and `--log-file` arrive in phase D with the full logging.
