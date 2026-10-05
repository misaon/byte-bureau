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
| `packages/kernel` | Services (configuration, store, event log, project registry, supervisor, workspaces, sessions, asks, usage, profiles, secrets, health), the plugin host with the bundled plugins, error types, a Promise facade for the CLI, the Bun layer the daemon runs on and test utilities (the fake provider, `KernelTest`) | FSL-1.1-MIT | A |
| `packages/api` | The HTTP API, SSE and RPC adapters over the kernel; its build generates the OpenAPI document (`openapi.json`) | FSL-1.1-MIT | B |
| `plugins/agent-claude` | Claude Code through `@anthropic-ai/claude-agent-sdk`: one streaming-input query per session, permissions and questions through `canUseTool`, usage, rate limits and context | FSL-1.1-MIT | C |
| `plugins/agent-acp` | Any Agent Client Protocol v1 agent over stdio through `@agentclientprotocol/sdk`, with presets for Codex, Gemini CLI, OpenCode and pi and a custom command; file-system and terminal requests confined to the worktree | FSL-1.1-MIT | C |
| `plugins/workspace-local` | Git worktree workspace runtime on the host | FSL-1.1-MIT | A |
| `apps/bytebureau` | The CLI (`run`, `sessions`, `ask`, `projects`, `workspaces`, `plugins`, `profiles`, `config` and the status) as a client of the daemon or of an in-process kernel, and `serve`, the daemon itself; the slot for the embedded web UI follows | FSL-1.1-MIT | A |
| `tools/client-codegen` | The client generator (hey-api) in an install of its own on TypeScript 6; `bun run generate:client` writes `packages/client/src/gen` from `packages/api/openapi.json` | FSL-1.1-MIT | B |

Only `kernel`, `api` and `protocol` import `effect` ([ADR-0003](../decisions/0003-effect-in-the-kernel-only/)). `plugin-api`, `client` and the plugins are plain TypeScript with Promise and AsyncIterable signatures, plugins import only `@bytebureau/plugin-api`, `@bytebureau/protocol` and third-party packages, and nothing imports from `apps/`. dependency-cruiser enforces the import rules in CI.

## What a run does

1. `bytebureau run "<prompt>" --project <repository>` talks to the daemon of the home, `$BYTEBUREAU_HOME` (`~/.bytebureau` by default), and starts it when none answers; the daemon runs the kernel, with its SQLite store in `<home>/data` and the bundled plugins loaded. With `--no-daemon` the CLI boots the same kernel inside its own process instead, which is refused while a daemon serves the home. [Daemon and API](../daemon-and-api/) tells the whole of it.
2. The CLI registers the project and creates a session, and the kernel gives the session a git worktree under `<project>/.bytebureau/worktrees/` on a `bb/<slug>` branch, so the main checkout is never touched.
3. The prompt goes to the `AgentProvider` port as one turn, and the kernel turns what the agent does into events, which the event log stores with an ever increasing `seq` unless they are ephemeral, like text deltas.
4. The CLI follows the durable events of the session, over SSE from the daemon, and prints them, as NDJSON with `--json`, and it answers an ask with the recommended option under `--yes` or with the choice made at a prompt.
5. When the turn completes the CLI completes the session and leaves the worktree for inspection, and the exit code says how the run ended: 0 completed, 3 stopped or interrupted, 4 when the project, its worktree, the provider or the profile cannot be used or the session errors. An invalid configuration, a failure of the store or a daemon that cannot be reached exits 2, a usage error or a refused `--no-daemon` 1.

## Decisions of phase A

- SQLite is reached through `effect/sql` with embedded migrations, and Drizzle is deferred ([ADR-0010](../decisions/0010-sqlite-through-effect-sql/)).
- Configuration files are JSON or JSONC read as text and never run, and c12 is gone ([ADR-0011](../decisions/0011-configuration-files-are-data/)).
- An agent child process is spawned detached in a process group of its own, so Ctrl-C at the terminal reaches the kernel only, and it is signalled as a group, so what it started goes with it; its `exit` resolves at most two seconds after the process ends, even when a grandchild keeps a pipe open.
- A child process gets an explicit environment allowlist (`PATH`, `HOME`, `LANG` and `LC_*`, `TMPDIR`, `TERM`, `TRACEPARENT`, `BYTEBUREAU_*` and the variables a spawn names explicitly), never the whole environment. `SSH_AUTH_SOCK` is on the list too, because git, ssh and Claude Code need the agent socket to reach SSH remotes, and `USER` joined it in phase C, because Claude Code finds its login in the macOS keychain by it. Since phase C an agent also gets the variables of its session's profile: the key of an API-key profile under the provider's variable, and the directory of a login profile under the agent's own (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). The extra environment of a session keeps its `BYTEBUREAU_*` names only, and `providers.<id>.passEnv` in the project file names the further variables the agents of a provider get.
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
- Errors are RFC 9457 problems with one schema for each status an endpoint declares, each with its status as a literal, so the OpenAPI document and the generated client know which problem every status carries; the 413 of the body limit is answered before routing, and every mutation declares it.
- The token is made at the first start of a home and kept in `daemon.token` across restarts, so a client that has read it goes on working; `server.json` carries a copy while the daemon runs.
- The token of the home goes only to the daemon its `server.json` names: a command that names another address with `--host` or `--port` needs `--token-file`.
- `daemon.lock` stays with a holder that answers as its record says or may still be coming up, whatever else is known of it. Otherwise its start decides: a process that started more than five seconds after the lock was written only got the pid after a crash or a reboot, and its lock is taken over (`serve --stop` clears it); one that started before, or within those five seconds, is the daemon that wrote it, which keeps the lock even while it is stopped or busy, and the line that says so names the lock to delete if it is no daemon of the home. Where the platform cannot tell the start, a holder that neither answers nor is within the 30 seconds a daemon is given to come up loses the lock if it is a process of the user; one of another user makes a start refuse, naming the lock and `serve --stop` as the way out.
- A session that a restart interrupted is `stopped`, with its turn `interrupted` (reason `daemon_restart`) and its asks cancelled, and resumable with `sessions resume`; spec §14 had the session marked `interrupted`, which is a status of turns.
- Event payloads are redacted once, at publish ([ADR-0012](../decisions/0012-event-payloads-are-redacted-at-publish/)).
- The WebSocket speaks `effect/rpc` with JSON envelopes, which the client implements in plain TypeScript, and the token travels in the headers of every request ([ADR-0013](../decisions/0013-api-transports/)).
- The client is generated by hey-api, which runs in `tools/client-codegen` on TypeScript 6 because TypeScript 7 ships no compiler API; the output is committed, and CI checks that it and `openapi.json` are up to date.
- A daemon reads its own environment, not the one of the command: `run` sends its `BYTEBUREAU_*` variables with the session, which keeps them for the agent at the start and at every resume, and a daemon started on demand gets none of those that choose for one run.
- `--no-daemon` is refused while a daemon answers on the same home, as the store has one writer.
- The `env` of a session never carries the kernel's own `BYTEBUREAU_HOME`, `BYTEBUREAU_LOG_LEVEL` and `BYTEBUREAU_WORKSPACE_RUNTIME`, so no client of the API can point an agent at another home.
- `bytebureau serve` detaches by default (`--no-daemonize` keeps it in the foreground), and `serve --stop` ends the daemon of the home.
- `bytebureau` with no command is the status; there is no `status` command to name.
- Global flags may stand before or after a command name, at any level, and every command but `run` ends a refused request with exit 1 and the detail of the problem.
- The SSE heartbeat is an event, `event: heartbeat`, rather than a comment, so every frame decodes as an envelope; the first one goes out at once.
- The plugin context runs what a plugin calls on the services of the kernel, captured when the plugin host is built, like any fiber of the kernel.

## Decisions of phase C

- A profile id is `<provider>/<name>`, such as `claude/work` or `acp:codex/home`: readable on the command line and unique per provider. A session without a profile runs on the nameless login of its provider, which no profile id can name.
- The store is the one source of profiles: `ProfileService` keeps them in the `profiles` table, a login profile owns the directory `<home>/profiles/<provider>/<name>`, and an API-key profile owns the secret `@bytebureau/profiles/<id>/api_key`, a key that no plugin's own namespace can reach. The `profiles` section of the user configuration stays reserved.
- A session's profile is fixed when the session is created, and every session but a completed one holds it, so `profiles rm` is refused while one does; `sessions complete` completes a stopped or errored session too, an end on the books that starts no agent.
- API keys are kept in the OS keychain through `Bun.secrets`, with a 0600 file under the home as the fallback, instead of `@napi-rs/keyring` and an age-encrypted file: `secrets.backend` is `auto`, `keychain` or `file`, and the backend that `auto` chose is kept per home.
- A provider declares the one variable its API key travels in (`AgentProvider.apiKeyEnv`): the kernel reads the key from the secret store and hands it to the agent under that name and nowhere else, and a provider without one takes no API-key profile.
- The project's `providers.<id>` section, without `passEnv`, reaches the adapter with every session as `CreateSessionRequest.providerConfig`, read when the session's agent starts. The section is keyed by the provider id, so `providers["acp:custom"]` is the custom agent itself and `providers["acp:<preset>"]` overrides a built-in preset.
- The ACP adapter starts its agent itself, in a process group of its own, because the process port of the plugin context has no stdin; the environment the kernel allows still reaches the agent through the request, and the agent's terminals run through the process port.
- The Agent SDK is given `permissionMode: 'default'` for a supervised employee and `'auto'` for an autonomous one, always explicitly, since the SDK otherwise leaves the mode to the defaults of Claude Code; the user's own `claude` runs through `pathToClaudeCodeExecutable` whenever one is found, and `settingSources` is always given.
- The SDK has no `authStatus()`: the Claude adapter checks a login with a query that sends no prompt and reads `initializationResult()` and `accountInfo()`. In a session, a lapsed login (an `auth_status` message with an error, or an assistant message whose error is `authentication_failed`) ends the session with an error of kind `auth`.
- An ACP agent that dies between turns is started again by the next prompt, at most three times a session, and one that dies within a turn errors the session, which stays resumable.
- An ACP permission is answered with the agent's own option of the kind chosen, allow or reject, never by the option's name, so an agent cannot turn a deny into an allow by how it names its options.

## Deferred to later phases

- A restart with backoff (spec §14): `restartSchedule` of the supervisor stays unused, as the ACP adapter starts an agent again only for the next prompt, and Claude Code runs as a process of the SDK, whose failure errors the session.
- A Claude session that reaches its usage limit is errored rather than paused until the limit resets (spec §14), and resumed by hand.
- Steering (spec §8.1): a prompt sent while a turn runs is refused with `409 session_invalid_transition`, as only a `ready` session takes one; follow-ups queued to steer a running turn come later.
- An age-encrypted file with a passphrase, as the fallback where no keychain answers, in place of the 0600 file.
- A login status of ACP agents through ACP's `authenticate`: ACP v1 has no status query, so until then the login of an installed ACP agent is `unknown`.
- The `profiles` section of the user configuration (the non-secret parts of profiles, spec §10) is reserved; profiles are kept in the store.
- Model lists (`AgentProvider.listModels`), `setEffort` for Claude, and attachments to a prompt.
- Subagents: the messages of a Claude subagent are not shown, and an ask that the agent takes back stays pending, until the protocol has an `ask.withdrawn` event; both come in phase D.
- On Windows an ACP agent is signalled alone, not with its process group.
- The nightly workflow that runs the real-agent smoke scripts (`bun run smoke:claude`, `bun run smoke:acp`) on the owner's machine; until then they run by hand only.
- The `^0` host API semver policy is settled, and `publint` and `arethetypeswrong` run, before the first publish.
- One shared test-support package replaces the copies of the test helpers: the `testing` export of the kernel serves the API now, and the CLI and the workspace plugin keep their copies until a fifth copy would appear; the two agent plugins each keep a copy of `Queue` and `within-limit.ts`, as a plugin cannot import another.
- A Scalar UI for the OpenAPI document comes later, for development only.
- CORS for origins beyond the empty list arrives with the web UI of SP2.
- An `extends` key, for configuration files built on presets, comes later.
- The timers of asks left pending are not restored at a start: the sessions a restart interrupted are stopped instead.
- WebSocket authentication for browsers, by a first message or a ticket, arrives with SP2.
- `plugins add` and `plugins rm` (installing third-party plugins, with the capabilities of the manifest shown and confirmed), `doctor` (with the secrets backend and the agent CLIs on `PATH`), `diag bundle`, `service`, `upgrade` and `completions` arrive in phase D.
- `--output-format` and `--log-file` arrive in phase D with the full logging.
- A `Host` allowlist for the two operations without a token, `/health` and `/openapi.json`, which a page that rebinds its name to the loopback can read, comes with SP2 if it is needed.
- Problem bodies for an unknown route and for a defect of a REST handler, which Effect answers with an empty `404` or `500`, come with SP2.
- `sessions prompt` replays the events of its session from the start to find the turn it begins; a hint of the latest `seq`, which changes the contract, comes with the UI of SP2.
