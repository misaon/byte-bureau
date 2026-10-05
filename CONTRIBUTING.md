# Contributing to ByteBureau

Thank you for helping build the AI office. This guide covers the setup, the rules the CI enforces, and how to get a change merged.

## Prerequisites

- [mise](https://mise.jdx.dev) (installs the pinned Bun and Node from `mise.toml`), or Bun 1.4.x and Node 26 installed manually
- Git ≥ 2.40

## Setup

```bash
git clone https://github.com/misaon/byte-bureau.git
cd byte-bureau
mise install
bun install --frozen-lockfile
bun run check
```

`bun install` runs `lefthook install`, so the commit hooks are active immediately.

## Day-to-day commands

| Command | What it does |
| --- | --- |
| `bun run check` | every CI gate except the Docker-based workflow linters (`bun run lint:actions`) |
| `bun run lint:actions` | actionlint and zizmor (pedantic persona) in Docker |
| `bun run lint` / `bun run format` | oxlint (type-aware) / oxfmt |
| `bun run test` | Vitest across all packages |
| `bun run build:binaries --host` | compile the CLI for your machine into `dist/` |
| `bun run docs:build` | build the documentation site |
| `bun run smoke:claude`, `bun run smoke:acp` | run a real agent once, on your own login (never in CI; see below) |

Export `GH_TOKEN="$(gh auth token)"` before `bun run lint:actions` to let zizmor run its online audits too (`impostor-commit`, `known-vulnerable-actions`, `stale-action-refs`).

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org): `type(scope): subject`.

- **Type**: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore` or `revert`.
- **Scope** (optional): a workspace directory name (`bytebureau`, `i18n`, `tsconfig`, `docs`) or `cli`, `deps`, `release`, `repo`, `ci`.
- **Subject**: imperative, starting with a lower-case letter.
- **Sign-off**: a Developer Certificate of Origin sign-off on every commit (`git commit -s`); by signing off you certify the [DCO](https://developercertificate.org).

commitlint checks the type, the scope, the subject case and the header length (at most 100 characters) of every commit. The PR title is checked for the same types, scopes and lower-case subject, because we squash-merge using the PR title.

Contributions are licensed under the licence of the package they touch (FSL-1.1-MIT for the application, MIT for the SDK packages).

## Pull requests

1. Open an issue or discussion first for anything larger than a bug fix.
2. Branch from `main`, keep the PR focused, add tests.
3. Fill in the PR template; keep `bun run check` green.
4. A maintainer reviews within a week. Address comments with new commits; we squash on merge.

## Code style

- TypeScript only, strictest settings; no `any`, no enums, no namespaces (erasable syntax only).
- Files are kebab-case; one responsibility per file; no barrel files except a package entry point.
- Comments only where the code cannot say it; keep them short.
- Translations live in `packages/i18n/messages/*.json`; add the key to both `en` and `cs` (tests enforce parity).

## Architecture

Start with `docs/research/2026-10-02-technology-landscape.md`, the specs in `docs/superpowers/specs/` and the ADRs in `docs/decisions/`. New decisions get a new ADR (MADR format).

## Working in the kernel

- Effect 4 is used only in `packages/kernel`, `packages/api` and `packages/protocol`; plugins never import it, and dependency-cruiser fails the build when one does ([ADR-0003](docs/decisions/0003-effect-in-the-kernel-only.md)).
- A service is a `Context.Service` class with a `Live` layer beside it (`EventLog` and `EventLogLive`); `KernelLayer` composes them.
- Persistence goes through `effect/sql`: `StoreLive` (`bun:sqlite`) in the binary, the in-memory `StoreTest` under Vitest ([ADR-0010](docs/decisions/0010-sqlite-through-effect-sql.md)). Configuration files are JSON or JSONC read as text, never run ([ADR-0011](docs/decisions/0011-configuration-files-are-data.md)).
- Tests use `@effect/vitest` (`it.effect`, `it.layer`), `KernelTest` from `@bytebureau/kernel/testing` (the whole kernel over `StoreTest`), `TestClock` for time and the fake provider for the agent; no test spawns a real agent.
- `StoreLive` cannot load under Node, so Vitest never imports it: the CLI tests run it in a Bun subprocess, and the compiled-binary smoke in CI (`bytebureau run … --provider fake --no-daemon`) runs it in the shipped binary. To try that by hand, build with `bun run build:binaries --host`, point `BYTEBUREAU_HOME` at a throwaway directory so that `~/.bytebureau` stays untouched, and pass `--no-daemon` so that no daemon starts.

## Working in the API and the client

- `packages/api` may import `effect` and the kernel. A handler calls a kernel service and maps its failure with `orProblem`, which turns the errors of the kernel into the problem of a status the endpoint declares (`error: PROBLEM_SCHEMAS`). The [daemon and API page](apps/docs/src/content/docs/daemon-and-api.md) of the docs describes what the API answers.
- The OpenAPI document and the client are generated and committed: `bun run --cwd packages/api build` regenerates `packages/api/openapi.json`, and `bun run generate:client` regenerates `packages/client/src/gen` from it with hey-api, which runs in `tools/client-codegen` on TypeScript 6. Commit both with the change that caused them; CI regenerates them and fails on any difference. Commits to `tools/client-codegen` use the `repo` scope.
- `packages/client` has no Effect at runtime: it runs on `fetch`, `eventsource-parser` and the global `WebSocket`, and imports only types from the protocol. Its generated code under `src/gen` is not linted, formatted or spell-checked.
- API tests run the real server on `@effect/platform-node` over `KernelTest` (`ApiTestLayer` of `packages/api/src/testing.ts`), on a free loopback port, and talk to it over HTTP, SSE and the WebSocket.
- CLI tests that need the daemon start one with `startDaemonProcess` (`apps/bytebureau/src/testing/daemon.ts`) on a `testHome()`, whose `config.json` puts the daemon on a free port, and every test that may start a daemon registers `stoppedWithTheTest(home)`, so no daemon outlives its test.
- Never run the daemon tests, or a daemon you start by hand, against `~/.bytebureau`: every helper uses a temporary home and refuses to run a command on one that is empty or does not exist, and `BYTEBUREAU_HOME` gives a hand-started daemon a throwaway one; end it with `bytebureau serve --stop`.

## Working on an agent adapter

- `plugins/agent-claude` and `plugins/agent-acp` import only `@bytebureau/plugin-api`, `@bytebureau/protocol` and third-party packages, their SDKs among them (`@anthropic-ai/claude-agent-sdk`, `@agentclientprotocol/sdk`), pinned exactly. Commits use the scopes `agent-claude` and `agent-acp`. The [agents and profiles page](apps/docs/src/content/docs/agents-and-profiles.md) of the docs describes what the adapters do.
- The tests of the Claude adapter never start Claude Code: they replay messages of the SDK from `plugins/agent-claude/src/testing/sdk-fixtures.ts` through the fake `query()` of `testing/fake-query.ts`. The fixtures are the truth of the SDK's shapes for the tests. They are typed against the declarations of the installed SDK without a cast, so an upgrade that changes a shape fails the type-check, and the init, the failed login and the error result follow what the real SDK sent once. To check them against a real agent, run a smoke script and keep its output: `bun run smoke:claude > events.ndjson` writes what its commands print with `--json`, one JSON line each, which is the events the adapter made of the real messages and the records of the other commands (`serve`, `sessions stop`, …), while the smoke tells its own steps on stderr. A message the mapping misses shows as an event that is not there; correct the fixture from the SDK's declarations (`sdk.d.ts`, `sdk-tools.d.ts`) and the mapping with it.
- The tests of the ACP adapter run the fake ACP agent, `plugins/agent-acp/src/testing/fake-acp-agent.ts`, over stdio as `node` or `bun` runs the file. `BYTEBUREAU_FAKE_ACP_SCRIPT` picks what it does, `hello` when it is unset; the scripts are those of its `FakeScript` type, among them `slow`, `crash-mid-turn`, `crash-idle`, `escape`, `terminal`, `refuse-prompt`, `auth-required` and `protocol-v2`. Node runs it from 22.18 on, which strips its types without a flag (`.node-version` pins 26). The CLI tests run it through a daemon as the command of `acp:custom` (`apps/bytebureau/src/commands/run-acp.test.ts`), with its script in the preset's `env`, because a daemon does not pass on the `BYTEBUREAU_*` variables of a test. The agent is two files: `fake-acp-agent.ts` holds the protocol, the table of scripts and the scripts that end the process (only a file with a hashbang may call `process.exit`), and `fake-acp-scripts.ts` the others, imported with a `.ts` specifier, as Node runs both files unbuilt (the package's `tsconfig.json` allows `.ts` specifiers for that). A new script joins the `FakeScript` type and the table, and the file it belongs in.
- No test and no CI job runs a real agent. `bun run smoke:claude` and `bun run smoke:acp` (`SMOKE_ACP_PRESET=codex|gemini|opencode|pi`, `opencode` by default) run one on demand, with your own login: `SMOKE_PROFILE=<provider>/<name>` adds that login profile to the smoke's home first. A smoke works on a throwaway `BYTEBUREAU_HOME` and repository, made under the system's temporary directory, and a daemon from source, and it refuses to run any command on another home: an unset `BYTEBUREAU_HOME` is `~/.bytebureau` to the CLI (an empty one is refused by the CLI and the daemon, exit 2). It runs the prompt to its end, then stops, resumes and prompts a second session, and stops the daemon and removes the home and the repository at the end, after Ctrl-C, SIGTERM or a hangup too. Without `SMOKE_REAL_AGENTS=1`, which the package scripts set, it only says how to run it. `scripts/smoke-run.test.ts` runs the same steps on the fake provider in CI, so the scripts cannot rot between the runs on real agents.
- An API key travels from the secret store into the agent's environment only, under the one variable the provider declares (`apiKeyEnv`). An adapter never logs it and never puts it into an event, a warning or an error: the ACP adapter redacts what the agent prints on stderr and answers before it tells either, and gives the agent's terminals no key. Canary tests prove it, with a key that must turn up nowhere but in the agent's environment. No test reaches the keychain or `~/.bytebureau`: the kernel and API tests use the in-memory secret store, and the CLI tests a `testHome()`, whose `config.json` sets `secrets.backend` to `file`.

## Editors

VS Code: accept the recommended extensions (`.vscode/extensions.json`). WebStorm: the lefthook hooks keep formatting and linting consistent; run `bun run format` before committing if your IDE formatter differs.
