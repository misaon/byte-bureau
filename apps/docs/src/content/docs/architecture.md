---
title: Architecture
description: Daemon, kernel, plugins and clients.
---

ByteBureau is a single binary that runs a local daemon. Clients (web UI, desktop shell, phone, CLI) talk to it over an OpenAPI-described HTTP API, server-sent events and a WebSocket. The kernel keeps an append-only event log of everything that happens; the office simulation, the chat and the telemetry are projections of that log. Integrations are plugins behind typed ports: agent providers, workspace runtimes, git hosts, ticket systems, chat and notifiers.

Read the [technology research](https://github.com/misaon/byte-bureau/blob/main/docs/research/2026-10-02-technology-landscape.md), the [design specs](https://github.com/misaon/byte-bureau/tree/main/docs/superpowers/specs) and the decision records in the sidebar.

## Packages

The kernel is hexagonal: `packages/kernel` holds the domain and the application services as Effect 4 layers, plugins are adapters behind the ports of `packages/plugin-api`, `packages/protocol` holds the shared schemas, and `apps/bytebureau` wires everything into one binary. Sub-project 1 (the kernel and the agent runtime) is built in phases: phase A is the core and a headless run with the fake provider, phase B adds the daemon, the API and the client, phase C the Claude and ACP adapters with profiles and the secret store, phase D diagnostics and installation.

| Package | Contents | Licence | Status |
| --- | --- | --- | --- |
| `packages/protocol` | Effect Schema definitions of every DTO, event and configuration file, the event catalogue with typed payload decoding, generated JSON Schema (`schemas/*.json`); the OpenAPI document follows with the API | MIT | phase A |
| `packages/plugin-api` | `definePlugin()`, `PluginManifest`, `PluginContext`, the port interfaces (`AgentProvider`, `WorkspaceRuntime`, `SecretStore`) and the hook types; plain TypeScript | MIT | phase A |
| `packages/client` | TypeScript client generated from the OpenAPI document plus a WebSocket and SSE subscription helper with resume; no Effect at runtime | MIT | phase B |
| `packages/kernel` | Services (configuration, store, event log, project registry, supervisor, workspaces, sessions, asks, usage), the plugin host, error types, a Promise facade for the CLI and test utilities (the fake provider, `KernelTest`) | FSL-1.1-MIT | phase A |
| `packages/api` | HTTP API groups, SSE endpoint, RPC over WebSocket, auth middleware, OpenAPI generation at build time | FSL-1.1-MIT | phase B |
| `plugins/agent-claude` | Claude adapter through `@anthropic-ai/claude-agent-sdk` | FSL-1.1-MIT | phase C |
| `plugins/agent-acp` | Generic adapter for Agent Client Protocol agents (Codex, Gemini CLI, OpenCode, Pi) with presets | FSL-1.1-MIT | phase C |
| `plugins/workspace-local` | Git worktree workspace runtime on the host | FSL-1.1-MIT | phase A |
| `apps/bytebureau` | CLI commands (`run`, `config`, `projects`, `workspaces`) on an in-process kernel; the daemon bootstrap and the slot for the embedded web UI follow | FSL-1.1-MIT | phase A |

Only `kernel`, `api` and `protocol` import `effect` ([ADR-0003](../decisions/0003-effect-in-the-kernel-only/)). `plugin-api`, `client` and the plugins are plain TypeScript with Promise and AsyncIterable signatures, plugins import only `@bytebureau/plugin-api`, `@bytebureau/protocol` and third-party packages, and nothing imports from `apps/`. dependency-cruiser enforces the import rules in CI.

## What a run does

1. `bytebureau run "<prompt>" --project <repository>` starts a kernel inside the CLI process (`--no-daemon`, the only mode of phase A): it opens the SQLite store in `$BYTEBUREAU_HOME/data` (`~/.bytebureau/data` by default), applies the embedded migrations and loads the bundled plugins, the local worktree runtime and the fake agent provider.
2. The CLI registers the project, which finds its git root and resolves its configuration (flags, `BYTEBUREAU_*` variables, the project and user files, defaults), and creates a session; the kernel refuses what it can before it writes anything (a path that is no git repository, a provider that is missing) and then asks the `WorkspaceRuntime` port for a git worktree in `<project>/.bytebureau/worktrees/<session id>` on a `bb/<slug>` branch, so the main checkout is never touched.
3. The prompt goes to the `AgentProvider` port as one turn, the session manager translates the canonical agent events into kernel events, and the event log stores the durable ones with an ever increasing `seq` and fans all of them out, which is what the CLI prints (`--json` as NDJSON, one event per line).
4. A question or a permission request becomes an ask, with a recommended option when the agent or the policy has one: `--yes` takes that option, a prompt at a terminal starts on it, and an ask nobody answers is settled by the policy of the employee or waits for a human.
5. When the turn completes the CLI completes the session, the worktree stays for inspection (`bytebureau workspaces prune` removes it only after `workspace.retainDays` days and only when nothing in it is unsaved), and the exit code says how the run ended: 0 completed, 3 stopped, 4 when the project or the provider cannot be used or the session errors.

## Decisions of phase A

- SQLite is reached through `effect/sql` with embedded migrations, and Drizzle is deferred ([ADR-0010](../decisions/0010-sqlite-through-effect-sql/)).
- Configuration files are JSON or JSONC read as text and never run, and c12 is gone ([ADR-0011](../decisions/0011-configuration-files-are-data/)).
- An agent child process is spawned detached in a process group of its own, so Ctrl-C at the terminal reaches the kernel only, and it is signalled as a group, so what it started goes with it; its `exit` resolves at most two seconds after the process ends, even when a grandchild keeps a pipe open.
- A child process gets an explicit environment allowlist (`PATH`, `HOME`, `LANG` and `LC_*`, `TMPDIR`, `TERM`, `SSH_AUTH_SOCK`, `TRACEPARENT`, `BYTEBUREAU_*`, plus the variables a spawn names explicitly), never the whole environment; the extra environment of a session keeps its `BYTEBUREAU_*` names only.
- The ask policy recommends `allow` for a shell command only when the whole command is one simple read-only command (no pipe, list, redirection or substitution), and the kernel never makes up an answer for a question without a recommended option: even for an autonomous employee such a question waits for a human.
- `KernelTest`, the kernel over an in-memory store, is exported from `@bytebureau/kernel/testing`, so tests run the real services.
- `--json` is NDJSON, one event per line; a run without `--json` and without a terminal prints plain text, with no colours and no prompts.
