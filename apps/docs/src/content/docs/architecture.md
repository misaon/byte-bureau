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
| `packages/protocol` | Effect Schema definitions of every DTO, event and configuration file, the event catalogue with typed payload decoding, generated JSON Schema (`schemas/*.json`); the OpenAPI document follows with the API | MIT | A |
| `packages/plugin-api` | `definePlugin()`, `PluginManifest`, `PluginContext`, the port interfaces (`AgentProvider`, `WorkspaceRuntime`, `SecretStore`) and the hook types; plain TypeScript | MIT | A |
| `packages/client` | TypeScript client generated from the OpenAPI document plus a WebSocket and SSE subscription helper with resume; no Effect at runtime | MIT | B |
| `packages/kernel` | Services (configuration, store, event log, project registry, supervisor, workspaces, sessions, asks, usage), the plugin host, error types, a Promise facade for the CLI and test utilities (the fake provider, `KernelTest`) | FSL-1.1-MIT | A |
| `packages/api` | HTTP API groups, SSE endpoint, RPC over WebSocket, auth middleware, OpenAPI generation at build time | FSL-1.1-MIT | B |
| `plugins/agent-claude` | Claude adapter through `@anthropic-ai/claude-agent-sdk` | FSL-1.1-MIT | C |
| `plugins/agent-acp` | Generic adapter for Agent Client Protocol agents (Codex, Gemini CLI, OpenCode, Pi) with presets | FSL-1.1-MIT | C |
| `plugins/workspace-local` | Git worktree workspace runtime on the host | FSL-1.1-MIT | A |
| `apps/bytebureau` | CLI commands (`run`, `config`, `projects`, `workspaces`) on an in-process kernel; the daemon bootstrap and the slot for the embedded web UI follow | FSL-1.1-MIT | A |

Only `kernel`, `api` and `protocol` import `effect` ([ADR-0003](../decisions/0003-effect-in-the-kernel-only/)). `plugin-api`, `client` and the plugins are plain TypeScript with Promise and AsyncIterable signatures, plugins import only `@bytebureau/plugin-api`, `@bytebureau/protocol` and third-party packages, and nothing imports from `apps/`. dependency-cruiser enforces the import rules in CI.

## What a run does

1. `bytebureau run "<prompt>" --project <repository>` boots a kernel inside the CLI process, with its SQLite store in `$BYTEBUREAU_HOME/data` (`~/.bytebureau/data` by default) and the bundled plugins loaded.
2. The CLI registers the project and creates a session, and the kernel gives the session a git worktree under `<project>/.bytebureau/worktrees/` on a `bb/<slug>` branch, so the main checkout is never touched.
3. The prompt goes to the `AgentProvider` port as one turn, and the kernel turns what the agent does into events, which the event log stores with an ever increasing `seq` unless they are ephemeral, like text deltas.
4. The CLI follows the durable events only and prints them, as NDJSON with `--json`, and it answers an ask with the recommended option under `--yes` or with the choice made at a prompt.
5. When the turn completes the CLI completes the session and leaves the worktree for inspection, and the exit code says how the run ended: 0 completed, 3 stopped, 4 when the project, its worktree or the provider cannot be used or the session errors. An invalid configuration or a failure of the store exits 2, a usage error 1.

## Decisions of phase A

- SQLite is reached through `effect/sql` with embedded migrations, and Drizzle is deferred ([ADR-0010](../decisions/0010-sqlite-through-effect-sql/)).
- Configuration files are JSON or JSONC read as text and never run, and c12 is gone ([ADR-0011](../decisions/0011-configuration-files-are-data/)).
- Event payloads are redacted once, at publish ([ADR-0012](../decisions/0012-event-payloads-are-redacted-at-publish/)).
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

## Deferred to later phases

- The supervisor's restart policy (spec §14, restart with backoff at most three times) arrives with the real providers of phase C; `restartSchedule` is not used yet.
- Profile variables in the agent environment arrive with the profiles of phase C; `providers.<id>.passEnv` is the only extra source until then.
- The plugin context bridges its promises on root fibers, so a helper a plugin spawns carries no `TRACEPARENT`; in phase B the host passes a runtime to the context.
- The `^0` host API semver policy is settled before the first publish of `plugin-api`.
- One shared test-support package replaces the copies of the `node-spawner` and `temp-repo` helpers in the kernel, the workspace plugin and the CLI.
- Whether event payloads are redacted once at `EventLog.publish` or by every reader is an ADR of phase B; today the log stores what it is given and the log sinks redact what they print.
