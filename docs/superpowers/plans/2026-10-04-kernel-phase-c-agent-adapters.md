# SP1 Phase C — Agent adapters, profiles and secrets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ByteBureau runs real coding agents: Claude Code through the Agent SDK and any ACP v1 agent (Codex, Gemini CLI, OpenCode, pi, or a custom command), under named auth profiles whose API keys live in the OS keychain, with the `profiles` API and CLI — while CI still runs no real agent.

**Architecture:** Two bundled in-process plugins implement the `AgentProvider` port of Phase A: `plugins/agent-claude` drives `@anthropic-ai/claude-agent-sdk` in streaming-input mode and maps its messages, hooks and permission prompts to the canonical `AgentEvent`s and to `AskService`; `plugins/agent-acp` spawns an ACP agent over stdio, speaks ACP v1 through `@agentclientprotocol/sdk`, serves the agent's file-system and terminal requests inside the workspace and brokers its permission requests. The kernel gains a `ProfileService` over the existing `profiles` table, a `Secrets` service with a `Bun.secrets` keychain backend and a 0600 file fallback, and hands every provider session a resolved `ProfileRef`, the project's provider options and an API key in the one environment variable the provider declares. The API gets the `profiles` group and the per-profile usage snapshot; the CLI gets `profiles ls|add|rm|use|status` and `run --profile`; the real-agent smoke scripts run only on demand.

**Tech Stack:** Bun 1.4.2, TypeScript 7.0.2, Effect 4.0.0 (kernel and API only), `@anthropic-ai/claude-agent-sdk` 0.3.288 (exact pin; peers `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `zod` 4), `@agentclientprotocol/sdk` 1.7.0 (protocol v1), `zod` 4.6.5 for the plugins' own validation, `Bun.secrets`, Vitest 5 under Node, the hey-api client generation of Phase B.

**Spec:** `docs/superpowers/specs/2026-10-02-kernel-and-agent-runtime-design.md` — §4 (`ProfileService`, `SecretStore`, `Supervisor` restart policy), §6 (ports), §7 (plugin host), §8 (agent adapters, asking dialog), §10 (configuration), §11 (`profiles` group and commands), §13 (security), §14 (provider crash), §15 (testing), §16 (acceptance 2, 3, 5, 6). **Fact sheet:** `docs/research/2026-10-02-reports/17-sp1-phase-c-stack.md` — read its §0 first: the daily SDK releases under the install cooldown, the missing `authStatus()` method, the moved `codex-acp`, the `permissionMode` change, the `Bun.secrets` probe.

## Global Constraints

- Dependency rules (dependency-cruiser, enforced): `plugins/*` import only `@bytebureau/plugin-api`, `@bytebureau/protocol` (types and schemas) and third-party packages — never `@bytebureau/kernel`, never `effect`; only `packages/kernel`, `packages/api` and `packages/protocol` import `effect`; `apps/bytebureau` never imports `effect`; nothing imports from `apps/*`; no circular dependencies.
- Licences: `packages/protocol`, `packages/plugin-api`, `packages/client` are `"license": "MIT"`; `plugins/agent-claude`, `plugins/agent-acp` and every other workspace stay `"license": "FSL-1.1-MIT"` (`scripts/license.test.ts` enumerates every manifest).
- Versions: exact pins; `minimumReleaseAge` is 86400 — a version published less than a day before `bun install` runs is refused, so pin the newest version at least a day old at install time (`@anthropic-ai/claude-agent-sdk` 0.3.288 as of the fact sheet; raise only to a version a day old) and let Renovate move it.
- Security (§13): child processes get an explicit environment allowlist (`PATH`, `HOME`, `LANG`/`LC_*`, `TMPDIR`, `TERM`, `SSH_AUTH_SOCK`, `TRACEPARENT`, `BYTEBUREAU_*`, the provider's `passEnv`, the profile variables) and never the daemon's full environment; an API key is read into the kernel from the secret store and leaves it only into the agent child's environment under the one variable the provider declares; it never appears in events, logs, problems, `--json` output, `server.json` or a diagnostic bundle (redaction canary tests); the CLI reads a key from the terminal or from stdin, never from an argument (the process list shows arguments); ACP file-system and terminal requests are confined to the workspace path (symlink escapes resolved and refused); `yolo` is refused on `isolation: 'none'` runtimes; vendor binaries are run unmodified, logins are performed by the user, credentials are never copied between machines (ADR-0006).
- Agent policy (fact sheet §0): the Agent SDK is given `permissionMode: 'default'` explicitly for `supervised` employees (omitting it leaves the mode to Claude Code's defaults since 0.3.286), `'auto'` for `autonomous`; the user's installed `claude` is used when found (`pathToClaudeCodeExecutable`), the SDK's bundled binary only when none is; `settingSources` is explicit (`['user', 'project', 'local']` by default).
- Tests run under Node (Vitest 5): adapter tests replay recorded SDK message fixtures and run a fake ACP agent over stdio; kernel tests use `KernelTest`; API tests use `ApiTestLayer`; CLI tests run the CLI and the daemon from source in Bun subprocesses on temp homes from `testHome()` (which now also fixes the secret backend to `file`); no test ever touches `~/.bytebureau` or the user's keychain (service names of tests carry the test's own prefix); no real agent is spawned in CI — `scripts/smoke-claude.ts` and `scripts/smoke-acp.ts` run only with `SMOKE_REAL_AGENTS=1`.
- Gates stay green on a fresh clone: `bun run check` (oxlint every category at error and type-aware, oxfmt, cspell en+cs, markdownlint, ls-lint, knip, dependency-cruiser, typecheck, Vitest with 80 % line/branch coverage over `packages/*/src`, `plugins/*/src` and the listed CLI modules, the ESLint long tail), `bun run lint:actions` when workflows change; the contract-drift step (`bun run --cwd packages/protocol build`, `bun run --cwd packages/api build`, `bun run generate:client`) leaves the tree clean; Conventional Commits with the workspace scopes (`agent-claude`, `agent-acp` are new); comments only where needed and short; every new file passes the lint caps (`max-lines` 300, `max-statements` 10, `max-lines-per-function` 50, `max-params` 3, `import/max-dependencies` 10, one class per file, no `?.`, no `as` but `as const`, no `!`, named generator functions; `unicorn/no-null` is off under kernel-side sources only — plugins avoid `null` except where a port demands it).
- i18n: every message of the CLI in `packages/i18n/messages/{en,cs}.json` (Czech: "démon", "relace", "otázka", "profil", polite pronouns capitalised); `bun run build:i18n` regenerates.

## Review Focus

The five failure modes the spec implies but no task's own tests exercise, most likely to bite a person first; each line names the task whose tests pin it.

1. **A key typed into `profiles add --api-key` must never be seen anywhere but the agent's environment.** A person pastes a key at the prompt; nothing of it may reach the process list, an event payload, a log line, a problem detail, `--json` output or `profiles ls`. Pinned in Task 5 by a canary: the key `sk-ant-canary-…` is added through the CLI against a daemon with the file backend; then every event of the home, the daemon log, `profiles ls --json` and `profiles status --json` are searched and must not contain it, while a `run` with that profile hands it to the fake provider's environment (the fake records the variable it was given).
2. **A profile whose directory was removed by hand is told, not guessed.** `profiles status` on a `login` profile whose `configDir` no longer exists must answer `loggedOut` with the login hint, and a `run` with it must end with the provider's auth refusal (exit 4, problem `provider_auth`) instead of hanging. Pinned in Task 3 (the service: a missing directory is `loggedOut` before the provider is asked) and Task 6 (the Claude adapter's `authStatus` maps an auth failure of the SDK to `loggedOut`/`expired`).
3. **An interrupt in the middle of a tool call leaves no dangling ask.** When a person interrupts a Claude turn while `canUseTool` waits for an answer, the adapter must resolve that pending permission as denied, the kernel's ask is cancelled, the turn ends `interrupted`, and the session is `ready` again. Pinned in Task 6 (adapter: `interrupt()` settles every pending ask with `deny`) and Task 8 (end to end through the daemon with the fake ACP agent: an interrupt while the agent waits for a permission).
4. **An ACP agent that dies is reported, and the next prompt gets a fresh one.** An agent process that exits mid-turn ends the turn `errored` with `session.error { kind: 'crash', retryable: true }`; an agent that exits idle is respawned by the next prompt, at most three times per session, with `session.warning { kind: 'restart' }`; a fourth death is final. Pinned in Task 7 with the fake ACP agent told to exit.
5. **A vendor agent that is not installed is a refusal, not a hang.** `run --provider acp:codex` on a machine without `codex-acp` ends with exit 4 and a line naming the command to install and the login to perform; `profiles status` for that provider says `unknown` with the same hint. Pinned in Task 7 (a spawn that fails with `ENOENT` makes `createSession` reject with the install and login hints, which the kernel reports as `provider_crash` with that reason) and Task 8 (the CLI ends with exit 4 and the hint in its line, since a crash whose reason says "is not installed" or "is not configured" counts as a refusal) (`run --provider acp:custom` without the custom command configured is refused with the configuration hint).

---

## File structure

```
packages/plugin-api/src/ports.ts            + AgentProvider.apiKeyEnv?, CreateSessionRequest.providerConfig
packages/protocol/src/api/{dto,requests,problem}.ts   + ProfileDto, ProfileStatusDto, UsageSnapshotDto, AddProfileBody, profile_* codes, ProviderDto.supportsApiKey
packages/protocol/src/config.ts             + UserConfig.secrets { backend }
packages/kernel/src/secrets/                bun-secret-store.ts, file-secret-store.ts, secret-store-for.ts, secrets.ts (the Secrets service)
packages/kernel/src/profiles/               profile-service.ts, profile-records.ts, profile-dirs.ts, profile-ids.ts, profile-errors (in errors.ts)
packages/kernel/src/sessions/session-profile.ts       the profile a session runs under, its ProfileRef and its secret variable
packages/kernel/src/sessions/session-start.ts         providerConfig and the profile variables in the request
packages/kernel/src/facade/profiles.ts      Kernel.profiles
packages/api/src/groups/profiles.ts, handlers/profiles.ts, groups/usage.ts (+ profile snapshot)
packages/client/src/index.ts                profiles area, usage.profile
apps/bytebureau/src/commands/profiles.ts, profiles-add.ts, render/rows.ts (+ profile rows), bureau/*.ts (profiles area), run (--profile)
plugins/agent-claude/src/{plugin,provider,session,options,mapping,asks,permission,auth,executable,input-queue}.ts + testing/
plugins/agent-acp/src/{plugin,presets,provider,process,connection,session,mapping,client-fs,client-terminal,permissions}.ts + testing/fake-acp-agent.ts
scripts/smoke-claude.ts, scripts/smoke-acp.ts
apps/docs/src/content/docs/agents-and-profiles.md, architecture.md, CONTRIBUTING.md, README*.md, the spec
```

| # | Task | Model hint |
| --- | --- | --- |
| 1 | Contract: plugin-api additions, protocol DTOs, problem codes, config | sonnet |
| 2 | Kernel: `Secrets` service with the keychain and file backends | opus |
| 3 | Kernel: `ProfileService`, the profile of a session, `providerConfig`, the facade | opus |
| 4 | API: `profiles` group, profile usage, problems, client regeneration | sonnet |
| 5 | CLI: `profiles` commands, `run --profile`, the Bureau, i18n, the canary | opus |
| 6 | `plugins/agent-claude` over the Agent SDK | opus |
| 7 | `plugins/agent-acp` over ACP v1 with the fake ACP agent | opus |
| 8 | Bundling and the end-to-end runs through the daemon | opus |
| 9 | Smoke scripts, docs, spec amendments, gates | sonnet |

---

### Task 1: The contract — plugin-api additions, protocol DTOs, problem codes, configuration

**Files:**
- Modify: `packages/plugin-api/src/ports.ts` (`AgentProvider.apiKeyEnv?`, `CreateSessionRequest.providerConfig`), `packages/plugin-api/src/plugin.test.ts` (if it builds a `CreateSessionRequest`), `packages/protocol/src/api/dto.ts` (`ProfileDto`, `ProfileStatusDto`, `UsageSnapshotDto`, `ProviderDto.supportsApiKey`), `packages/protocol/src/api/requests.ts` (`AddProfileBody`, `ProfileRef` params), `packages/protocol/src/api/problem.ts` (`profile_not_found`, `profile_exists`, `profile_invalid`, `profile_in_use`), `packages/protocol/src/config.ts` (`UserConfig.secrets`), `packages/protocol/src/api/dto.test.ts`, `packages/protocol/src/config.test.ts`, `packages/kernel/src/testing/fake-agent-provider.ts` (declares `apiKeyEnv: 'BYTEBUREAU_FAKE_API_KEY'` so the canary of Task 5 can observe the variable), `packages/kernel/src/sessions/session-start.ts` (passes `providerConfig: {}` for now so the kernel compiles; Task 3 fills it)
- Test: the protocol tests above

**Interfaces:**
- Consumes: Phase A's `ProfileRef { id, providerId, kind: 'login' | 'api_key', configDir? }`, `AgentProvider`, `CreateSessionRequest`; Phase B's DTO conventions (`Schema.Struct(...).annotate({ title, identifier })`, `Id`, `Timestamp`, `RateLimit` of `agent-event.ts`).
- Produces (later tasks rely on these exact names):
  - `AgentProvider.apiKeyEnv?: string` — "the environment variable an API-key profile's key is handed in; a provider without it takes no API-key profiles".
  - `CreateSessionRequest.providerConfig: Readonly<Record<string, unknown>>` — "the `providers.<id>` section of the project's configuration without `passEnv`; `{}` when the project has none".
  - `ProfileDto = { id, providerId, name, kind, configDir: string | null, isDefault: boolean, createdAt }`, `ProfileStatusDto = { profileId, state: 'loggedIn' | 'loggedOut' | 'expired' | 'unknown', hint?: string, account?: string, checkedAt }`, `UsageSnapshotDto = { profileId, rateLimit: RateLimit, observedAt: string | null }`, `AddProfileBody = { providerId, name, kind, apiKey?: string, makeDefault?: boolean }`, `ProviderDto = { id, displayName, supportsApiKey: boolean }`.
  - Problem codes `profile_not_found`, `profile_exists`, `profile_invalid`, `profile_in_use` in `PROBLEM_CODES`.
  - `UserConfig.secrets?: { backend?: 'auto' | 'keychain' | 'file' }`; `SecretsBackend` type exported from the protocol.

- [ ] **Step 1: The failing protocol tests**

`packages/protocol/src/api/dto.test.ts` — add to the existing `describe` of the DTOs:

```ts
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  HealthDto,
  PluginStatusDto,
  ProfileDto,
  ProfileStatusDto,
  ProviderDto,
  SessionDto,
  TurnDto,
  UsageSnapshotDto,
  WorkspaceInfoDto,
} from './dto.js'
import {
  AddProfileBody,
  CreateSessionBody,
  EventsFilter,
  EventsQuery,
  ProfileIdParam,
  RemoveProfileQuery,
} from './requests.js'

const PROFILE_ID = 'claude/work'

const employee = {
  id: 'developer',
  name: 'Developer',
  provider: 'fake',
  model: 'any',
  effort: null,
  systemPrompt: '',
  tools: { allow: [], deny: [] },
  permissionMode: 'supervised',
  skills: [],
  appearance: {},
}

const session = {
  id: '0192f0a0-0000-7000-8000-000000000001',
  projectId: '0192f0a0-0000-7000-8000-000000000002',
  title: 'Create hello',
  employee,
  providerId: 'fake',
  profileId: null,
  workspace: {
    id: '0192f0a0-0000-7000-8000-000000000001',
    runtimeId: 'local',
    path: '/tmp/repo/.bytebureau/worktrees/x',
    branch: 'bb/create-hello',
    baseRef: 'main',
  },
  externalRef: null,
  status: 'ready',
  createdAt: '2026-10-04T10:00:00.000Z',
  startedAt: null,
  endedAt: null,
}

describe('the API DTO schemas', () => {
  it('decodes a session with a workspace and no external ref', () => {
    expect(Schema.decodeUnknownSync(SessionDto)(session)).toStrictEqual(session)
  })

  it('refuses a session with an unknown field', () => {
    expect(() =>
      Schema.decodeUnknownSync(SessionDto)({ ...session, extra: 1 }, { onExcessProperty: 'error' }),
    ).toThrow(/extra/u)
  })

  it('decodes a turn whose usage is null and a plugin status without a reason', () => {
    const turn = {
      id: '0192f0a0-0000-7000-8000-000000000003',
      sessionId: session.id,
      index: 0,
      prompt: { text: 'hi' },
      status: 'completed',
      stopReason: 'end_turn',
      usage: null,
      startedAt: '2026-10-04T10:00:00.000Z',
      endedAt: '2026-10-04T10:00:01.000Z',
    }
    expect(Schema.decodeUnknownSync(TurnDto)(turn)).toStrictEqual(turn)
    const plugin = {
      name: 'fake-agent',
      version: '0.0.0',
      state: 'loaded',
      ports: ['agentProvider'],
    }
    expect(Schema.decodeUnknownSync(PluginStatusDto)(plugin)).toStrictEqual(plugin)
  })

  it('decodes a degraded health report', () => {
    const health = {
      status: 'degraded',
      version: '0.1.0',
      startedAt: '2026-10-04T10:00:00.000Z',
      checks: { store: 'failed', plugins: { loaded: 2, failed: 1 } },
    }
    expect(Schema.decodeUnknownSync(HealthDto)(health)).toStrictEqual(health)
  })
})

describe('the profile DTOs', () => {
  it('decodes a profile, a profile status and a usage snapshot, and refuses a kind outside the two', () => {
    const profile = Schema.decodeUnknownSync(ProfileDto)({
      id: PROFILE_ID,
      providerId: 'claude',
      name: 'work',
      kind: 'login',
      configDir: '/home/me/.bytebureau/profiles/claude/work',
      isDefault: true,
      createdAt: '2026-10-04T12:00:00.000Z',
    })
    expect(profile.kind).toBe('login')
    expect(() => Schema.decodeUnknownSync(ProfileDto)({ ...profile, kind: 'oauth' })).toThrow(
      /kind/u,
    )
    const status = Schema.decodeUnknownSync(ProfileStatusDto)({
      profileId: PROFILE_ID,
      state: 'loggedOut',
      hint: 'CLAUDE_CONFIG_DIR=/home/me/.bytebureau/profiles/claude/work claude /login',
      checkedAt: '2026-10-04T12:00:01.000Z',
    })
    expect(status.state).toBe('loggedOut')
    const snapshot = Schema.decodeUnknownSync(UsageSnapshotDto)({
      profileId: PROFILE_ID,
      rateLimit: { fiveHourPct: 12.5 },
      observedAt: null,
    })
    expect(snapshot.observedAt).toBeNull()
  })

  it('tells whether a provider takes API-key profiles', () => {
    expect(
      Schema.decodeUnknownSync(ProviderDto)({
        id: 'claude',
        displayName: 'Claude Code',
        supportsApiKey: true,
      }).supportsApiKey,
    ).toBe(true)
  })
})

describe('the worktree DTO', () => {
  const worktree = {
    sessionId: session.id,
    projectId: session.projectId,
    path: '/tmp/repo/.bytebureau/worktrees/x',
    branch: 'bb/create-hello',
    baseRef: 'main',
    sessionStatus: 'completed',
    exists: true,
  }

  it('carries the status of its session as one of the session statuses', () => {
    expect(Schema.decodeUnknownSync(WorkspaceInfoDto)(worktree)).toStrictEqual(worktree)
    expect(() =>
      Schema.decodeUnknownSync(WorkspaceInfoDto)({ ...worktree, sessionStatus: 'dancing' }),
    ).toThrow(/sessionStatus/u)
  })
})

describe('the API request schemas', () => {
  it('accepts a session creation with only the required fields', () => {
    const body = { projectId: session.projectId, title: 'x' }
    expect(Schema.decodeUnknownSync(CreateSessionBody)(body)).toStrictEqual(body)
  })

  it('accepts an events query with every filter and with none, its since read from the text of the query', () => {
    const filters = {
      session: session.id,
      project: session.projectId,
      types: 'turn.started,turn.completed',
    }
    const query = Schema.decodeUnknownSync(EventsQuery)({ since: '12', ...filters })
    expect(query).toStrictEqual({ since: 12, ...filters })
    expect(Schema.decodeUnknownSync(EventsQuery)({})).toStrictEqual({})
  })

  it.each([-1, 1.5])(
    'refuses a since of %d, in the query and in the filter of the socket',
    (since) => {
      expect(() => Schema.decodeUnknownSync(EventsQuery)({ since: String(since) })).toThrow(
        /since/u,
      )
      expect(() => Schema.decodeUnknownSync(EventsFilter)({ since })).toThrow(/since/u)
    },
  )

  it.each(['+5', '1e3', ' 5', ''])('refuses %j as the text of a since in the query', (since) => {
    expect(() => Schema.decodeUnknownSync(EventsQuery)({ since })).toThrow(/since/u)
  })

  it('takes a since of 0, the start of the log', () => {
    expect(Schema.decodeUnknownSync(EventsQuery)({ since: '0' })).toStrictEqual({ since: 0 })
    expect(Schema.decodeUnknownSync(EventsFilter)({ since: 0 })).toStrictEqual({ since: 0 })
  })
})

describe('the profile request schemas', () => {
  it('decodes the body that adds a profile, with the key and the default optional', () => {
    const body = Schema.decodeUnknownSync(AddProfileBody)({
      providerId: 'claude',
      name: 'work',
      kind: 'login',
    })
    expect(body).toStrictEqual({ providerId: 'claude', name: 'work', kind: 'login' })
    expect(
      Schema.decodeUnknownSync(AddProfileBody)({
        providerId: 'acp:codex',
        name: 'key',
        kind: 'api_key',
        apiKey: 'sk-test',
        makeDefault: true,
      }).makeDefault,
    ).toBe(true)
    expect(() =>
      Schema.decodeUnknownSync(AddProfileBody)({
        providerId: 'claude',
        name: 'Work Profile',
        kind: 'login',
      }),
    ).toThrow(/name/u)
  })

  it('reads the profile of a path and the purge of a query as the text they are', () => {
    expect(Schema.decodeUnknownSync(ProfileIdParam)({ id: PROFILE_ID })).toStrictEqual({
      id: PROFILE_ID,
    })
    expect(Schema.decodeUnknownSync(RemoveProfileQuery)({})).toStrictEqual({})
    expect(Schema.decodeUnknownSync(RemoveProfileQuery)({ purge: 'true' })).toStrictEqual({
      purge: 'true',
    })
    expect(() => Schema.decodeUnknownSync(RemoveProfileQuery)({ purge: 'yes' })).toThrow(/purge/u)
  })
})

describe('the name of a profile', () => {
  it.each(['a', '0', 'work-2', 'a'.repeat(32)])('takes %j', (name) => {
    const body = { providerId: 'claude', name, kind: 'login' }
    expect(Schema.decodeUnknownSync(AddProfileBody)(body)).toStrictEqual(body)
  })

  it.each(['', '-work', 'a'.repeat(33), 'under_score'])(
    'refuses %j, since it is a path segment',
    (name) => {
      expect(() =>
        Schema.decodeUnknownSync(AddProfileBody)({ providerId: 'claude', name, kind: 'login' }),
      ).toThrow(/name/u)
    },
  )
})
```

`packages/protocol/src/api/problem.test.ts` (or the existing problem test): assert `PROBLEM_CODES` contains `'profile_not_found'`, `'profile_exists'`, `'profile_invalid'`, `'profile_in_use'`.

`packages/protocol/src/config.test.ts` — add:

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

  it('accepts the secrets backend of the user configuration and refuses an unknown one', () => {
    expect(decodeUserConfig({ secrets: { backend: 'file' } }).secrets).toStrictEqual({
      backend: 'file',
    })
    expect(() => decodeUserConfig({ secrets: { backend: 'vault' } })).toThrow(/backend/u)
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bunx vitest run --project protocol`
Expected: FAIL — `ProfileDto`, `ProfileStatusDto`, `UsageSnapshotDto`, `AddProfileBody` are not exported; `supportsApiKey` is missing; the config refuses `secrets`.

- [ ] **Step 3: The protocol**

`packages/protocol/src/api/dto.ts` — add (next to `ProviderDto`, which gains the field):

```ts
import { Schema } from 'effect'
import { RateLimit, Usage } from '../agent-event.js'
import { Id, SessionStatus, Timestamp, TurnStatus } from '../common.js'
import { ProjectConfig } from '../config.js'
import { EmployeeSpec, PromptInput } from '../employee.js'

export const ProjectDto = Schema.Struct({
  id: Id,
  name: Schema.String,
  path: Schema.String,
  defaultBranch: Schema.String,
  config: ProjectConfig,
  createdAt: Timestamp,
  updatedAt: Timestamp,
}).annotate({ title: 'Project', identifier: 'Project' })

// The handle of a worktree as the kernel keeps it: the id is the session id
export const WorkspaceHandleDto = Schema.Struct({
  id: Schema.String,
  runtimeId: Schema.String,
  path: Schema.String,
  branch: Schema.String,
  baseRef: Schema.String,
}).annotate({ title: 'WorkspaceHandle', identifier: 'WorkspaceHandle' })

export const ExternalRefDto = Schema.Struct({
  providerId: Schema.String,
  ref: Schema.String,
}).annotate({ title: 'ExternalSessionRef', identifier: 'ExternalSessionRef' })

export const SessionDto = Schema.Struct({
  id: Id,
  projectId: Id,
  title: Schema.String,
  employee: EmployeeSpec,
  providerId: Schema.String,
  profileId: Schema.NullOr(Schema.String),
  workspace: Schema.NullOr(WorkspaceHandleDto),
  externalRef: Schema.NullOr(ExternalRefDto),
  status: SessionStatus,
  createdAt: Timestamp,
  startedAt: Schema.NullOr(Timestamp),
  endedAt: Schema.NullOr(Timestamp),
}).annotate({ title: 'Session', identifier: 'Session' })

export const TurnDto = Schema.Struct({
  id: Id,
  sessionId: Id,
  index: Schema.Int,
  prompt: PromptInput,
  status: TurnStatus,
  stopReason: Schema.NullOr(Schema.String),
  usage: Schema.NullOr(Usage),
  startedAt: Timestamp,
  endedAt: Schema.NullOr(Timestamp),
}).annotate({ title: 'Turn', identifier: 'Turn' })

export const WorkspaceInfoDto = Schema.Struct({
  sessionId: Id,
  projectId: Id,
  path: Schema.String,
  branch: Schema.String,
  baseRef: Schema.String,
  sessionStatus: SessionStatus,
  exists: Schema.Boolean,
}).annotate({ title: 'WorkspaceInfo', identifier: 'WorkspaceInfo' })

export const PruneReportDto = Schema.Struct({
  removed: Schema.Array(Schema.String),
  retained: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
}).annotate({ title: 'PruneReport', identifier: 'PruneReport' })

export const SessionUsageDto = Schema.Struct({
  turns: Schema.Int,
  inputTokens: Schema.Int,
  outputTokens: Schema.Int,
  costUsd: Schema.NullOr(Schema.Finite),
  contextPct: Schema.NullOr(Schema.Finite),
}).annotate({ title: 'SessionUsage', identifier: 'SessionUsage' })

export const PluginStatusDto = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  state: Schema.Literals(['loaded', 'failed']),
  reason: Schema.optionalKey(Schema.String),
  ports: Schema.Array(Schema.String),
}).annotate({ title: 'PluginStatus', identifier: 'PluginStatus' })

export const ProfileKind = Schema.Literals(['login', 'api_key'])
export const AuthState = Schema.Literals(['loggedIn', 'loggedOut', 'expired', 'unknown'])

export const ProfileDto = Schema.Struct({
  id: Schema.String,
  providerId: Schema.String,
  name: Schema.String,
  kind: ProfileKind,
  configDir: Schema.NullOr(Schema.String),
  isDefault: Schema.Boolean,
  createdAt: Timestamp,
}).annotate({ title: 'Profile', identifier: 'Profile' })

export const ProfileStatusDto = Schema.Struct({
  profileId: Schema.String,
  state: AuthState,
  hint: Schema.optionalKey(Schema.String),
  account: Schema.optionalKey(Schema.String),
  checkedAt: Timestamp,
}).annotate({ title: 'ProfileStatus', identifier: 'ProfileStatus' })

export const UsageSnapshotDto = Schema.Struct({
  profileId: Schema.String,
  rateLimit: RateLimit,
  observedAt: Schema.NullOr(Timestamp),
}).annotate({ title: 'UsageSnapshot', identifier: 'UsageSnapshot' })

export const ProviderDto = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  // Whether the provider takes an API-key profile: it declares the variable the key travels in
  supportsApiKey: Schema.Boolean,
}).annotate({ title: 'Provider', identifier: 'Provider' })

export const HealthDto = Schema.Struct({
  status: Schema.Literals(['ok', 'degraded']),
  version: Schema.String,
  startedAt: Timestamp,
  checks: Schema.Struct({
    store: Schema.Literals(['ok', 'failed']),
    plugins: Schema.Struct({ loaded: Schema.Int, failed: Schema.Int }),
  }),
}).annotate({ title: 'Health', identifier: 'Health' })

export type ProjectDto = typeof ProjectDto.Type
export type WorkspaceHandleDto = typeof WorkspaceHandleDto.Type
export type ExternalRefDto = typeof ExternalRefDto.Type
export type SessionDto = typeof SessionDto.Type
export type TurnDto = typeof TurnDto.Type
export type WorkspaceInfoDto = typeof WorkspaceInfoDto.Type
export type PruneReportDto = typeof PruneReportDto.Type
export type SessionUsageDto = typeof SessionUsageDto.Type
export type PluginStatusDto = typeof PluginStatusDto.Type
export type ProfileKind = typeof ProfileKind.Type
export type AuthState = typeof AuthState.Type
export type ProfileDto = typeof ProfileDto.Type
export type ProfileStatusDto = typeof ProfileStatusDto.Type
export type UsageSnapshotDto = typeof UsageSnapshotDto.Type
export type ProviderDto = typeof ProviderDto.Type
export type HealthDto = typeof HealthDto.Type
```

(`RateLimit` is imported from `../agent-event.js`; keep the file under 300 lines — move the health and plugin DTOs to `dto-daemon.ts` re-exported from `dto.ts` if the cap is reached.)

`packages/protocol/src/api/requests.ts` — add:

```ts
import { Schema, SchemaTransformation } from 'effect'
import { AskAnswer } from '../ask.js'
import { Id } from '../common.js'
import { PromptInput } from '../employee.js'
import { ProfileKind } from './dto.js'

export const RegisterProjectBody = Schema.Struct({ path: Schema.String }).annotate({
  title: 'RegisterProject',
  identifier: 'RegisterProject',
})

// The same fields as the kernel's CreateSessionInput; env carries BYTEBUREAU_* names only, the kernel drops the rest and its own (home, log level, workspace runtime)
export const CreateSessionBody = Schema.Struct({
  projectId: Id,
  title: Schema.String,
  employeeId: Schema.optionalKey(Schema.String),
  providerId: Schema.optionalKey(Schema.String),
  profileId: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
}).annotate({ title: 'CreateSession', identifier: 'CreateSession' })

export const PromptBody = PromptInput
export const AnswerAskBody = AskAnswer

export const SessionRef = Schema.Struct({ sessionId: Id }).annotate({
  title: 'SessionRef',
  identifier: 'SessionRef',
})

// The text of a seq in a query string: digits only, which the OpenAPI document tells in the pattern
// No sign, fraction or exponent goes through, so a client knows the bound from the document itself
const SeqText = Schema.String.check(Schema.isPattern(/^\d+$/u)).annotate({
  description: 'The last seq the client has seen: a whole number of 0 or more',
})

const SeqFromText = SeqText.pipe(
  Schema.decodeTo(Schema.Natural, SchemaTransformation.numberFromString),
)

// The query string of GET /events: types is comma-separated, since is the last seq the client has seen (0 or more)
export const EventsQuery = Schema.Struct({
  since: Schema.optionalKey(SeqFromText),
  session: Schema.optionalKey(Id),
  project: Schema.optionalKey(Id),
  types: Schema.optionalKey(Schema.String),
}).annotate({ title: 'EventsQuery', identifier: 'EventsQuery' })

// The filter of the RPC subscription, the shape of the kernel's EventFilter
export const EventsFilter = Schema.Struct({
  since: Schema.optionalKey(Schema.Natural),
  sessionId: Schema.optionalKey(Id),
  projectId: Schema.optionalKey(Id),
  types: Schema.optionalKey(Schema.Array(Schema.String)),
  ephemeral: Schema.optionalKey(Schema.Boolean),
}).annotate({ title: 'EventsFilter', identifier: 'EventsFilter' })

// A profile name is a path segment of the profiles directory: lower-case letters, digits and dashes, 1 to 32 of them
const ProfileName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,31}$/u)).annotate({
  title: 'ProfileName',
  description: 'Lower-case letters, digits and dashes, 1 to 32 characters',
})

export const AddProfileBody = Schema.Struct({
  providerId: Schema.String,
  name: ProfileName,
  kind: ProfileKind,
  // Only for kind api_key; stored in the secret store, never echoed
  apiKey: Schema.optionalKey(Schema.String),
  makeDefault: Schema.optionalKey(Schema.Boolean),
}).annotate({ title: 'AddProfile', identifier: 'AddProfile' })

export const ProfileIdParam = Schema.Struct({ id: Schema.String })

// A query string carries purge as text, which the handler reads as a boolean
export const RemoveProfileQuery = Schema.Struct({
  purge: Schema.optionalKey(Schema.Literals(['true', 'false'])),
})

export type RegisterProjectBody = typeof RegisterProjectBody.Type
export type CreateSessionBody = typeof CreateSessionBody.Type
export type PromptBody = typeof PromptBody.Type
export type AnswerAskBody = typeof AnswerAskBody.Type
export type SessionRef = typeof SessionRef.Type
export type EventsQuery = typeof EventsQuery.Type
export type EventsFilter = typeof EventsFilter.Type
export type AddProfileBody = typeof AddProfileBody.Type
```

(`Schema.BooleanFromString` decodes `"true"`/`"false"` of a query string; if Effect 4.0.0 names it differently — `Schema.BooleanFromString` lives in `effect/Schema` as of 4.0 — use `Schema.Literals(['true', 'false'])` and map in the handler.)

`packages/protocol/src/api/problem.ts` — extend `PROBLEM_CODES` with `'profile_not_found', 'profile_exists', 'profile_invalid', 'profile_in_use'`.

`packages/protocol/src/config.ts` — add before `UserConfig`:

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

// Where the daemon keeps secrets: the OS keychain through Bun.secrets, a 0600 file under the home, or whichever of the two works (auto)
export const SecretsBackend = Schema.Literals(['auto', 'keychain', 'file'])
const SecretsSection = Schema.Struct({ backend: Schema.optionalKey(SecretsBackend) })

export const UserConfig = Schema.Struct({
  server: Schema.optionalKey(ServerSection),
  profiles: Schema.optionalKey(ProfilesSection),
  defaults: Schema.optionalKey(UserDefaults),
  locale: Schema.optionalKey(Schema.String),
  logging: Schema.optionalKey(LoggingSection),
  telemetry: Schema.optionalKey(TelemetrySection),
  secrets: Schema.optionalKey(SecretsSection),
  ui: Schema.optionalKey(UiSection),
}).annotate({ title: 'ByteBureau user configuration' })

export type LogLevel = typeof LogLevel.Type
export type EmployeeConfig = typeof EmployeeConfig.Type
export type PluginRef = typeof PluginRef.Type
export type ProjectConfig = typeof ProjectConfig.Type
export type SecretsBackend = typeof SecretsBackend.Type
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

and `secrets: Schema.optionalKey(SecretsSection),` in `UserConfig`; export `type SecretsBackend = typeof SecretsBackend.Type`. Regenerate the schemas: `bun run --cwd packages/protocol build` (commits `packages/protocol/schemas/config.json`).

- [ ] **Step 4: The plugin-api**

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
  // The providers.<id> section of the project's configuration, without passEnv (the kernel's); {} when there is none
  readonly providerConfig: Readonly<Record<string, unknown>>
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
  // The environment variable an API-key profile's key is handed in; a provider without it takes no API-key profiles
  readonly apiKeyEnv?: string | undefined
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

`packages/kernel/src/testing/fake-agent-provider.ts`: add `public readonly apiKeyEnv = 'BYTEBUREAU_FAKE_API_KEY'` to `FakeAgentProvider`. `packages/kernel/src/sessions/session-start.ts` `requestOf`: add `providerConfig: {},` (Task 3 replaces it). Every other `CreateSessionRequest` literal in tests gains `providerConfig: {}` (grep `sessionId:` in `packages/kernel/src/**/*fixtures*.ts`, `packages/plugin-api/src/plugin.test.ts`).

**Semantics (as shipped, commits 9a15b15, 81295d0):** `AgentProvider.apiKeyEnv?` and `CreateSessionRequest.providerConfig` are in the plugin-api; the fake provider declares `apiKeyEnv: 'BYTEBUREAU_FAKE_API_KEY'` and every `CreateSessionRequest` literal carries `providerConfig` (`{}` in `session-start.ts` until Task 3). The protocol has `ProfileKind`, `AuthState`, `ProfileDto`, `ProfileStatusDto`, `UsageSnapshotDto`, `ProviderDto.supportsApiKey`, `AddProfileBody` (the name checked with `.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,31}$/u))`, as `requests.ts` checks its other strings — Effect 4.0.0 has no `Schema.pattern`), `ProfileIdParam`, `RemoveProfileQuery` (`purge` is `Schema.optionalKey(Schema.Literals(['true', 'false']))` — there is no `Schema.BooleanFromString`; Task 4's handler reads `query.purge === 'true'`), the four `profile_*` problem codes and `UserConfig.secrets.backend` (`SecretsBackend`). `packages/protocol/schemas/config.json` is the project configuration's schema and did not change (the user configuration has no schema file); `packages/api/openapi.json` and the client were regenerated for `supportsApiKey`, which the API's provider handler and the kernel facade's `providers.list()` now carry (pulled forward from Task 3), and the CLI's scripted fake follows. The profile tests sit in `describe` blocks of their own (the 50-line cap). Heads-up for Tasks 4–5: a profile id holds `/` (and `:` for ACP providers), so a client must percent-encode it in a path (`/profiles/claude%2Fwork` reaches the handler decoded; an unencoded slash matches no route).

- [ ] **Step 5: Run the protocol, plugin-api and kernel tests**

Run: `bun run --cwd packages/protocol build && bunx vitest run --project protocol --project plugin-api --project kernel && bun run typecheck`
Expected: PASS; `git status` shows `packages/protocol/schemas/config.json` changed (the `secrets` section).

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-api packages/protocol packages/kernel/src/testing/fake-agent-provider.ts packages/kernel/src/sessions/session-start.ts packages/kernel/src
git commit -m "feat(protocol): add the profile, profile status and usage snapshot of the API, the secrets backend and the profile problems"
git commit -m "feat(plugin-api): let a provider declare the variable of an API key and give a session its provider options"
```

(Two commits: the plugin-api change with the kernel fixture updates, the protocol change with its schema.)

---

### Task 2: The kernel's `Secrets` service — keychain through `Bun.secrets`, a 0600 file fallback, `auto`

**Files:**
- Create: `packages/kernel/src/secrets/secrets.ts` (the `Secrets` service and `SecretBackend`), `packages/kernel/src/secrets/bun-secret-store.ts`, `packages/kernel/src/secrets/file-secret-store.ts`, `packages/kernel/src/secrets/secret-store-for.ts`, `packages/kernel/src/facade/boot-secrets.ts` (the lenient read of `secrets.backend` from the user file before the layer exists), `packages/kernel/src/secrets/file-secret-store.test.ts`, `packages/kernel/src/secrets/secret-store-for.test.ts`, `packages/kernel/src/facade/boot-secrets.test.ts`, `packages/kernel/src/secrets/keychain-probe.ts` (the 3 s bounded probe with its cleanup), `packages/kernel/src/secrets/backend-record.ts` (the sticky record of `auto`), `packages/kernel/src/secrets/private-file.ts` (the exclusive 0600 draft written and renamed into place), `packages/kernel/src/testing/fake-bun-secrets.ts`, `packages/kernel/src/testing/captured-logs.ts`, `packages/kernel/src/secrets/keychain-probe.test.ts`, `packages/kernel/src/secrets/private-file.test.ts`, `packages/kernel/src/secrets/secret-store-auto.test.ts`
- Modify: `packages/kernel/src/kernel-live.ts` and `packages/kernel/src/kernel-foundation.ts` (`Secrets` provided from the options, in-memory by default), `packages/kernel/src/plugins/plugin-host.ts` (the host takes `Secrets` from the service; `PluginHostOptions.secrets` is gone) and its fixtures and tests, `packages/kernel/src/bun.ts` and `packages/kernel/src/facade.ts` (`KernelOptions.secrets`; `kernelBunLayer` builds the store from `boot-secrets.ts` unless given one), `packages/kernel/src/index.ts` (exports), `packages/kernel/src/health/health.ts` (`secrets: SecretBackend` in the report — `HealthDto` and `/api/v1/health` unchanged), `packages/kernel/src/secrets/in-memory-secret-store.ts` (`backend: 'memory'`), `packages/api/src/bun.ts` (passes `secrets` through), `apps/bytebureau/src/bureau/local.ts` (maps the four `HealthDto` fields explicitly), `apps/bytebureau/src/testing/temp-repo.ts` (`testHome()` writes `secrets: { backend: 'file' }`; `configureHome(home, config)` for a test that writes its own `config.json`), the CLI tests that started kernels on bare homes (`serve`, `run`, `projects`, `workspaces`, `daemon-lock`, `run-logging`, `run-cli`, `local`) now on `testHome()`/`configureHome()`, `cspell-words.txt`
- Test: the two new test files; the existing plugin-host tests keep passing (`InMemorySecretStore` default)

**Interfaces:**
- Consumes: `SecretStore` of the plugin-api; `InMemorySecretStore`; `PluginHostOptions.secrets`; `prepareHome(home)` of `store/home.ts` (the home directory, 0700); `writePrivateFile`-like helpers of Phase A (`packages/kernel/src/store/home.ts` has `restrictDatabase`; the CLI has `private-file.ts` — the kernel gets its own `writePrivate(path, text)` in `file-secret-store.ts`: write to `<file>.tmp` with mode 0o600, `renameSync` over the file).
- Produces: `export type SecretBackend = 'keychain' | 'file' | 'memory'`; `export interface SecretsShape extends SecretStore { readonly backend: SecretBackend }`; `export class Secrets extends Context.Service<Secrets, SecretsShape>()('bb/Secrets') {}`; `export class BunSecretStore implements SecretsShape` (constructor `(service = 'bytebureau')`; `backend = 'keychain'`); `export class FileSecretStore implements SecretsShape` (constructor `(file: string)`; `backend = 'file'`); `export const secretStoreFor = (home: string, backend: SecretsBackend): Promise<SecretsShape>` — `'file'` → the file store at `<home>/secrets.json`; `'keychain'` → the Bun store, refused with an `Error('the keychain is not available: …')` when the probe fails; `'auto'` → the Bun store when `globalThis.Bun` exists and the probe (set, get, delete of `probe/<pid>` under service `bytebureau`) succeeds, else the file store; `KernelLayerOptions.secrets?: SecretsShape` (default `new InMemorySecretStore()` wrapped with `backend: 'memory'`); `KernelOptions.secrets?` likewise; `InMemorySecretStore` gains `readonly backend = 'memory' as const`.

- [ ] **Step 1: The failing tests**

`packages/kernel/src/secrets/file-secret-store.test.ts`:

```ts
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../testing/temp-repo.js'
import { FileSecretStore } from './file-secret-store.js'

const modeOf = (file: string): number => statSync(file).mode % 0o1000

const REFUSED = /secrets\.json does not hold a secret store/u

// The secrets file in a fresh directory removed after the test, or in a subdirectory of it that is not there yet
const fileIn = (directory = ''): string =>
  path.join(tempDir('bb-secrets-'), directory, 'secrets.json')

describe(FileSecretStore, () => {
  it('keeps a value across stores of the same file, in a file only the user can read', async () => {
    expect.hasAssertions()
    const file = fileIn()
    const first = new FileSecretStore(file)
    await first.set('profiles/claude/work/api_key', 'sk-test-1')
    const second = new FileSecretStore(file)
    await expect(second.get('profiles/claude/work/api_key')).resolves.toBe('sk-test-1')
    expect(modeOf(file)).toBe(0o600)
    expect(readFileSync(file, 'utf8')).toContain('sk-test-1')
  })

  it('answers nothing for a key it does not hold, and forgets a deleted one', async () => {
    expect.hasAssertions()
    const store = new FileSecretStore(fileIn())
    await expect(store.get('missing')).resolves.toBeUndefined()
    await store.set('k', 'v')
    await expect(store.get('toString')).resolves.toBeUndefined()
    await store.delete('k')
    await expect(store.get('k')).resolves.toBeUndefined()
    expect(store.backend).toBe('file')
  })

  it('writes no file to delete a key it does not hold', async () => {
    expect.hasAssertions()
    const file = fileIn()
    await new FileSecretStore(file).delete('missing')
    expect(existsSync(file)).toBe(false)
  })

  it('creates its directory for the user alone', async () => {
    expect.hasAssertions()
    const file = fileIn('home')
    await new FileSecretStore(file).set('k', 'v')
    expect(modeOf(path.dirname(file))).toBe(0o700)
  })
})

describe('a FileSecretStore over a file that holds something else', () => {
  it('refuses a file that holds no JSON, and leaves it as it is', async () => {
    expect.hasAssertions()
    const file = fileIn()
    writeFileSync(file, 'not json')
    const store = new FileSecretStore(file)
    await expect(store.set('k', 'v')).rejects.toThrow(REFUSED)
    expect(readFileSync(file, 'utf8')).toBe('not json')
    await expect(store.delete('k')).rejects.toThrow(REFUSED)
    expect(readFileSync(file, 'utf8')).toBe('not json')
  })

  it('refuses JSON that is no map of strings, and leaves it as it is', async () => {
    expect.hasAssertions()
    const file = fileIn()
    writeFileSync(file, '{ "k": 1 }')
    const store = new FileSecretStore(file)
    await expect(store.get('k')).rejects.toThrow(REFUSED)
    await expect(store.set('j', 'v')).rejects.toThrow(REFUSED)
    expect(readFileSync(file, 'utf8')).toBe('{ "k": 1 }')
  })
})
```

`packages/kernel/src/secrets/secret-store-for.test.ts` (runs under Node, where `Bun` is undefined):

```ts
import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fakeBun, withoutBun } from '../testing/fake-bun-secrets.js'
import { tempDir } from '../testing/temp-repo.js'
import { secretStoreFor } from './secret-store-for.js'

describe(secretStoreFor, () => {
  it('gives the file store for file, and for auto where there is no Bun', async () => {
    expect.hasAssertions()
    withoutBun()
    const home = tempDir('bb-home-')
    const file = await secretStoreFor(home, 'file')
    const auto = await secretStoreFor(home, 'auto')
    expect([file.backend, auto.backend]).toStrictEqual(['file', 'file'])
    await file.set('k', 'v')
    await expect(auto.get('k')).resolves.toBe('v')
    expect(existsSync(path.join(home, 'secrets.json'))).toBe(true)
  })

  it('refuses the keychain where it is not available instead of falling back silently', async () => {
    expect.hasAssertions()
    withoutBun()
    await expect(secretStoreFor(tempDir('bb-home-'), 'keychain')).rejects.toThrow(
      /keychain.*secrets\.backend/u,
    )
  })
})

describe('secretStoreFor where Bun offers its secrets', () => {
  it('takes the keychain for auto and keychain once the probe went in and out, leaving nothing of it', async () => {
    expect.hasAssertions()
    const { entries } = fakeBun('answers')
    const home = tempDir('bb-home-')
    const auto = await secretStoreFor(home, 'auto')
    const keychain = await secretStoreFor(home, 'keychain')
    expect([auto.backend, keychain.backend, entries.size]).toStrictEqual([
      'keychain',
      'keychain',
      0,
    ])
    await auto.set('k', 'v')
    expect([...entries]).toStrictEqual([['bytebureau/k', 'v']])
    expect(existsSync(path.join(home, 'secrets.json'))).toBe(false)
  })

  it('falls back to the file for auto, and refuses keychain, when the keychain refuses the probe', async () => {
    expect.hasAssertions()
    fakeBun('refuses')
    const home = tempDir('bb-home-')
    await expect(secretStoreFor(home, 'auto')).resolves.toHaveProperty('backend', 'file')
    await expect(secretStoreFor(home, 'keychain')).rejects.toThrow(/keychain/u)
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bunx vitest run --project kernel packages/kernel/src/secrets`
Expected: FAIL — the modules do not exist.

- [ ] **Step 3: The service and the stores**

`packages/kernel/src/secrets/secrets.ts`:

```ts
import type { SecretStore } from '@bytebureau/plugin-api'
import { Context } from 'effect'

export type SecretBackend = 'keychain' | 'file' | 'memory'

// A secret store that tells where it keeps its secrets
export interface SecretsShape extends SecretStore {
  readonly backend: SecretBackend
}

export class Secrets extends Context.Service<Secrets, SecretsShape>()('bb/Secrets') {}
```

`packages/kernel/src/secrets/in-memory-secret-store.ts`: add `public readonly backend = 'memory' as const` (and `implements SecretsShape`).

`packages/kernel/src/secrets/file-secret-store.ts`:

```ts
import path from 'node:path'
import { readIfPresent, writePrivate } from './private-file.js'
import type { SecretsShape } from './secrets.js'

type Values = Readonly<Record<string, string>>

const isValues = (value: unknown): value is Values =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === 'string')

// What the text holds; nothing for text that is no JSON
const parsed = (text: string): unknown => {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    return undefined
  }
}

// The file as a map of keys to values, empty while there is no file; anything else in it is refused, never overwritten
const read = (file: string): Values => {
  const text = readIfPresent(file)
  if (text === undefined) {
    return {}
  }
  const values = parsed(text)
  if (!isValues(values)) {
    throw new Error(`${path.basename(file)} does not hold a secret store`)
  }
  return values
}

const write = (file: string, values: Values): void => {
  writePrivate(file, `${JSON.stringify(values, null, 2)}\n`)
}

// Secrets in one JSON file under the home, for the user alone: the fallback where no keychain serves the daemon
export class FileSecretStore implements SecretsShape {
  public readonly backend = 'file' as const
  private readonly file: string

  public constructor(file: string) {
    this.file = file
  }

  public async get(key: string): Promise<string | undefined> {
    await Promise.resolve()
    const values = read(this.file)
    return Object.hasOwn(values, key) ? values[key] : undefined
  }

  public async set(key: string, value: string): Promise<void> {
    await Promise.resolve()
    write(this.file, { ...read(this.file), [key]: value })
  }

  // A key the file does not hold leaves it as it is, or absent
  public async delete(key: string): Promise<void> {
    await Promise.resolve()
    const values = read(this.file)
    if (Object.hasOwn(values, key)) {
      write(this.file, Object.fromEntries(Object.entries(values).filter(([name]) => name !== key)))
    }
  }
}
```

(`JSON.parse` of a corrupt file throws a `SyntaxError` — wrap it in the same `Error(... does not hold a secret store)` so the test's `/secrets\.json/u` matches: catch around `JSON.parse` and rethrow with the basename.)

`packages/kernel/src/secrets/bun-secret-store.ts`:

```ts
import type { SecretsShape } from './secrets.js'

interface Entry {
  readonly service: string
  readonly name: string
}

interface BunSecrets {
  readonly get: (entry: Entry) => Promise<string | null>
  readonly set: (entry: Entry & { readonly value: string }) => Promise<void>
  readonly delete: (entry: Entry) => Promise<boolean>
}

const METHODS = ['get', 'set', 'delete'] as const

const isBunSecrets = (value: unknown): value is BunSecrets =>
  typeof value === 'object' &&
  value !== null &&
  METHODS.every((method) => typeof Reflect.get(value, method) === 'function')

// Bun.secrets as the runtime offers it; nothing under Node, which the tests run on
export const bunSecrets = (): BunSecrets | undefined => {
  const runtime: unknown = Reflect.get(globalThis, 'Bun')
  if (typeof runtime !== 'object' || runtime === null) {
    return undefined
  }
  const secrets: unknown = Reflect.get(runtime, 'secrets')
  return isBunSecrets(secrets) ? secrets : undefined
}

// The keychain of the system through Bun.secrets: Keychain Services on macOS, the Secret Service on Linux, the Credential Manager on Windows
export class BunSecretStore implements SecretsShape {
  public readonly backend = 'keychain' as const
  private readonly secrets: BunSecrets
  private readonly service: string

  public constructor(secrets: BunSecrets, service = 'bytebureau') {
    this.secrets = secrets
    this.service = service
  }

  public async get(key: string): Promise<string | undefined> {
    const value = await this.secrets.get({ service: this.service, name: key })
    return value ?? undefined
  }

  public async set(key: string, value: string): Promise<void> {
    await this.secrets.set({ service: this.service, name: key, value })
  }

  public async delete(key: string): Promise<void> {
    await this.secrets.delete({ service: this.service, name: key })
  }
}
```

(The one `as BunSecrets` is a structural narrowing of an unknown runtime object; if the lint forbids it even here, replace it by a type guard checking that `get`, `set` and `delete` are functions.)

`packages/kernel/src/secrets/secret-store-for.ts`:

```ts
import path from 'node:path'
import type { SecretsBackend } from '@bytebureau/protocol'
import { kernelLogger } from '../logging/logging.js'
import { recordBackend, recordedBackend, type ChosenBackend } from './backend-record.js'
import { FileSecretStore } from './file-secret-store.js'
import { probeKeychain } from './keychain-probe.js'
import type { SecretsShape } from './secrets.js'

const logger = kernelLogger(['bb', 'secrets'])

interface Choice {
  readonly store: SecretsShape
  // Why it is this store, for the line the start logs
  readonly reason: string
}

const fileOf = (home: string): string => path.join(home, 'secrets.json')

const fileChoice = (home: string, reason: string): Choice => ({
  store: new FileSecretStore(fileOf(home)),
  reason,
})

// The keychain backend demands the keychain: one that is not available refuses the start, with the reason
async function demanded(): Promise<Choice> {
  const probed = await probeKeychain()
  if (typeof probed !== 'string') {
    return { store: probed, reason: 'secrets.backend is keychain' }
  }
  throw new Error(
    `the keychain is not available to this daemon (${probed}); set secrets.backend to file or auto`,
  )
}

// Auto at the first start of a home takes the keychain where it answers the probe, else the file, and keeps to it from then on
async function chosen(home: string): Promise<Choice> {
  const probed = await probeKeychain()
  if (typeof probed !== 'string') {
    recordBackend(home, 'keychain')
    return { store: probed, reason: 'auto: the keychain answered' }
  }
  recordBackend(home, 'file')
  logger.warn(`${probed}: the secrets are kept in ${fileOf(home)} from now on`)
  return fileChoice(home, `auto: ${probed}`)
}

// Auto after that keeps what it chose: the file even where the keychain answers now, the keychain while it answers
async function kept(home: string, recorded: ChosenBackend): Promise<Choice> {
  if (recorded === 'file') {
    return fileChoice(home, 'auto, as recorded in secrets.backend')
  }
  const probed = await probeKeychain()
  if (typeof probed !== 'string') {
    return { store: probed, reason: 'auto, as recorded in secrets.backend' }
  }
  logger.warn(
    `the secrets kept in the keychain are not available (${probed}); new ones go to ${fileOf(home)} until it answers`,
  )
  return fileChoice(home, 'auto: the keychain it chose before is not available')
}

// File and keychain go by the configuration alone; auto goes by the record of what it chose, once there is one
const choiceFor = async (home: string, backend: SecretsBackend): Promise<Choice> => {
  if (backend === 'file') {
    return fileChoice(home, 'secrets.backend is file')
  }
  if (backend === 'keychain') {
    const demand = await demanded()
    return demand
  }
  const recorded = recordedBackend(home)
  const choice = recorded === undefined ? await chosen(home) : await kept(home, recorded)
  return choice
}

// The store the backend names: the file under the home, or the keychain, which auto takes where it answers and keychain demands
// The choice is logged once, at debug: a start that goes as configured says nothing on stderr, a fallback warns
export const secretStoreFor = async (
  home: string,
  backend: SecretsBackend,
): Promise<SecretsShape> => {
  const { store, reason } = await choiceFor(home, backend)
  logger.debug(`secrets backend: ${store.backend} (${reason})`)
  return store
}
```

- [ ] **Step 4: Wire the service**

`packages/kernel/src/kernel-live.ts`: `KernelLayerOptions` gains `readonly secrets?: SecretsShape | undefined`; `composeKernel` provides `Layer.succeed(Secrets, options.secrets ?? new InMemorySecretStore())` into the foundation (merge it into `FoundationLive`'s output or `Layer.provideMerge` before `PluginHostLive`), and `PluginHostLive` reads `Secrets` from the context instead of `options.secrets` (`plugin-host.ts`: `const secrets = yield* Secrets` in its layer; drop `PluginHostOptions.secrets`). `KernelServices` gains `Secrets`. `packages/kernel/src/facade.ts` `KernelOptions` gains `secrets?: SecretsShape`, passed through to the layer. `packages/kernel/src/bun.ts` `kernelBunLayer`: read the user configuration's `secrets.backend` the way `bootLevel` reads the level (`configReader`/the user file under `home`), default `'auto'`, and `options.secrets ?? await secretStoreFor(home.root, backend)`; `createKernel` passes the same. `packages/api/src/bun.ts` `kernelOptionsOf` passes `secrets` from `DaemonOptions` (the daemon lets the kernel choose; `DaemonOptions.secrets?` for tests). `packages/kernel/src/health/health.ts`: the report gains `secrets: SecretBackend` (read from `Secrets`); `HealthDto` unchanged (the API's handler picks the fields it serves). `apps/bytebureau/src/testing/temp-repo.ts` `testHome()` writes `{ server: { port: 0 }, secrets: { backend: 'file' } }`. `packages/kernel/src/index.ts` exports `Secrets`, `type SecretsShape`, `type SecretBackend`, `FileSecretStore`, `BunSecretStore`, `secretStoreFor`.

**Added files (as shipped):**

`packages/kernel/src/facade/boot-secrets.ts` (as shipped):

```ts
import { SecretsBackend } from '@bytebureau/protocol'
import { Effect, Schema } from 'effect'
import { readLayer, type LoadedFile } from '../config/files.js'
import { isPlain } from '../config/merge.js'
import { ConfigError } from '../errors.js'
import { kernelLogger } from '../logging/logging.js'
import { secretStoreFor } from '../secrets/secret-store-for.js'
import type { SecretsShape } from '../secrets/secrets.js'
import type { KernelOptions } from './types.js'

const logger = kernelLogger(['bb', 'secrets'])

const isBackend = Schema.is(SecretsBackend)

// The backend the secrets section names, auto where it names none; anything else refuses the start, which auto would hide
const backendIn = ({ file, config }: LoadedFile): SecretsBackend => {
  const section = config['secrets']
  if (section === undefined) {
    return 'auto'
  }
  if (!isPlain(section)) {
    throw new ConfigError({ file, pointer: '/secrets', reason: 'expected an object' })
  }
  const { backend } = section
  if (backend === undefined || isBackend(backend)) {
    return backend ?? 'auto'
  }
  const reason = `expected "auto", "keychain" or "file", not ${JSON.stringify(backend)}`
  throw new ConfigError({ file, pointer: '/secrets/backend', reason })
}

type UserFile = { readonly loaded: LoadedFile | null } | { readonly failure: ConfigError }

const userFile = async (home: string): Promise<UserFile> => {
  const read = readLayer(home, 'config').pipe(
    Effect.match({
      onFailure: (failure): UserFile => ({ failure }),
      onSuccess: (loaded): UserFile => ({ loaded }),
    }),
  )
  const file = await Effect.runPromise(read)
  return file
}

// The secrets section of the user file on its own, so that a mistake in another section does not move the secrets elsewhere
// A file that cannot be parsed leaves the choice to auto, and says so, as the daemon does for its server section
async function configuredBackend(home: string): Promise<SecretsBackend> {
  const read = await userFile(home)
  if ('failure' in read) {
    const { file, reason } = read.failure
    logger.warn('the user configuration cannot be read: its secrets section is not applied', {
      file,
      reason,
    })
    return 'auto'
  }
  return read.loaded === null ? 'auto' : backendIn(read.loaded)
}

// The store the options give, else the one the user configuration names
export async function bootSecrets(options: KernelOptions): Promise<SecretsShape> {
  if (options.secrets !== undefined) {
    return options.secrets
  }
  return secretStoreFor(options.home, await configuredBackend(options.home))
}
```

`packages/kernel/src/facade/boot-secrets.test.ts` (as shipped):

```ts
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError } from '../errors.js'
import { InMemorySecretStore } from '../secrets/in-memory-secret-store.js'
import { capturedLogs, linesOf } from '../testing/captured-logs.js'
import { withoutBun } from '../testing/fake-bun-secrets.js'
import { tempDir } from '../testing/temp-repo.js'
import { bootSecrets } from './boot-secrets.js'

// A home whose user file holds the text given; Bun is taken away, so no test can reach a real keychain
const homeWith = (config: string): string => {
  withoutBun()
  const home = tempDir('bb-home-')
  writeFileSync(path.join(home, 'config.json'), config)
  return home
}

const KEYCHAIN = '{ "secrets": { "backend": "keychain" } }'

describe(bootSecrets, () => {
  it('takes the store the options give over the one the user file names', async () => {
    expect.hasAssertions()
    const given = new InMemorySecretStore()
    await expect(bootSecrets({ home: homeWith(KEYCHAIN), env: {}, secrets: given })).resolves.toBe(
      given,
    )
  })

  it('takes the backend the user file names, and auto where it names none', async () => {
    expect.hasAssertions()
    await expect(bootSecrets({ home: homeWith(KEYCHAIN), env: {} })).rejects.toThrow(/keychain/u)
    const none = await bootSecrets({ home: tempDir('bb-home-'), env: {} })
    const unnamed = await bootSecrets({ home: homeWith('{ "server": { "port": 0 } }'), env: {} })
    expect([none.backend, unnamed.backend]).toStrictEqual(['file', 'file'])
  })

  it('reads the secrets section even where another section of the user file cannot be read', async () => {
    expect.hasAssertions()
    const home = homeWith(
      '{ "server": { "port": "not a port" }, "secrets": { "backend": "keychain" } }',
    )
    await expect(bootSecrets({ home, env: {} })).rejects.toThrow(/keychain/u)
  })
})

describe('bootSecrets and a secrets section it cannot go by', () => {
  it('refuses a backend that is none of the three, naming its place and the three', async () => {
    expect.hasAssertions()
    const refused = bootSecrets({
      home: homeWith('{ "secrets": { "backend": "vault" } }'),
      env: {},
    })
    await expect(refused).rejects.toBeInstanceOf(ConfigError)
    await expect(refused).rejects.toHaveProperty('pointer', '/secrets/backend')
    await expect(refused).rejects.toThrow(/^expected "auto", "keychain" or "file", not "vault"$/u)
  })

  it('refuses a secrets section that is no object', async () => {
    expect.hasAssertions()
    const refused = bootSecrets({ home: homeWith('{ "secrets": "file" }'), env: {} })
    await expect(refused).rejects.toBeInstanceOf(ConfigError)
    await expect(refused).rejects.toHaveProperty('pointer', '/secrets')
  })

  it('leaves the choice to auto where the user file cannot be parsed, and says so', async () => {
    expect.hasAssertions()
    const home = homeWith('{ "secrets": ')
    const logs = await capturedLogs()
    await expect(bootSecrets({ home, env: {} })).resolves.toHaveProperty('backend', 'file')
    expect(linesOf(logs, 'bb.secrets')[0]).toStrictEqual([
      'warning',
      'the user configuration cannot be read: its secrets section is not applied',
    ])
  })
})
```

`packages/kernel/src/secrets/keychain-probe.ts` (as shipped):

```ts
import { BunSecretStore, bunSecrets } from './bun-secret-store.js'

// A keychain that is locked or waits on a prompt would hold the start of the daemon; this is all it is given
const PROBE_TIMEOUT_MS = 3000

const PROBE = `probe/${process.pid}`

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

async function forget(store: BunSecretStore): Promise<void> {
  try {
    await store.delete(PROBE)
  } catch {
    // Best effort: the probe stays behind only where the keychain refuses its delete as well
  }
}

// The probe goes in and comes out again: nothing when it did, else why not
// It is deleted whatever came of it, a write the keychain lets in after the time included
async function roundTrip(store: BunSecretStore): Promise<string | undefined> {
  try {
    await store.set(PROBE, 'probe')
    const value = await store.get(PROBE)
    return value === 'probe' ? undefined : 'the keychain did not give the probe back'
  } catch (error) {
    return `the keychain refused the probe: ${messageOf(error)}`
  } finally {
    await forget(store)
  }
}

// What the probe came to, or why it came to nothing in time
async function withinTime(probing: Promise<string | undefined>): Promise<string | undefined> {
  const { promise: late, resolve } = Promise.withResolvers<string>()
  const timer = setTimeout(() => {
    resolve(`the keychain did not answer within ${PROBE_TIMEOUT_MS / 1000} s`)
  }, PROBE_TIMEOUT_MS)
  try {
    return await Promise.race([probing, late])
  } finally {
    clearTimeout(timer)
  }
}

// The keychain where it answers the probe in time, else why it is not available
export async function probeKeychain(): Promise<BunSecretStore | string> {
  const secrets = bunSecrets()
  if (secrets === undefined) {
    return 'Bun.secrets is not available to this process'
  }
  const store = new BunSecretStore(secrets)
  const reason = await withinTime(roundTrip(store))
  return reason ?? store
}
```

`packages/kernel/src/secrets/backend-record.ts` (as shipped):

```ts
import path from 'node:path'
import { readIfPresent, writePrivate } from './private-file.js'
import type { SecretBackend } from './secrets.js'

// What auto chooses between
export type ChosenBackend = Exclude<SecretBackend, 'memory'>

const recordOf = (home: string): string => path.join(home, 'secrets.backend')

// The backend auto chose at an earlier start of the home; nothing before the first
// A record that names neither is refused: choosing again could put the secrets out of reach unnoticed
export function recordedBackend(home: string): ChosenBackend | undefined {
  const text = readIfPresent(recordOf(home))
  if (text === undefined) {
    return undefined
  }
  const recorded = text.trim()
  if (recorded === 'keychain' || recorded === 'file') {
    return recorded
  }
  throw new Error(
    `${recordOf(home)} names neither keychain nor file; remove it to let auto choose again`,
  )
}

// One word, for the user alone, as the token of the daemon is
export const recordBackend = (home: string, backend: ChosenBackend): void => {
  writePrivate(recordOf(home), `${backend}\n`)
}
```

`packages/kernel/src/secrets/private-file.ts` (as shipped):

```ts
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

// The text of the file; nothing while there is no file
export const readIfPresent = (file: string): string | undefined => {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (isMissing(error)) {
      return undefined
    }
    throw error
  }
}

// The failure that came first is the one passed on
const discard = (draft: string): void => {
  try {
    rmSync(draft, { force: true })
  } catch {
    // Left behind: the next write of this process removes it before it begins
  }
}

// Created afresh, so neither a stale draft nor a link planted in its place receives the text, and narrowed to the user before it holds any
const writeDraft = (draft: string, text: string): void => {
  rmSync(draft, { force: true })
  const fd = openSync(draft, 'wx', 0o600)
  try {
    fchmodSync(fd, 0o600)
    writeFileSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

// Written beside the file in a draft of this process, flushed and moved into place, so a reader never sees half of it
// Two processes writing the same file never share a draft; a write that fails removes its draft and passes the failure on
export const writePrivate = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const draft = `${file}.${process.pid}.tmp`
  try {
    writeDraft(draft, text)
    renameSync(draft, file)
  } catch (error) {
    discard(draft)
    throw error
  }
}
```

`packages/kernel/src/testing/fake-bun-secrets.ts` (as shipped):

```ts
import { onTestFinished, vi } from 'vitest'

interface Entry {
  readonly service: string
  readonly name: string
  readonly value?: string
}

// How the keychain of a test behaves: it answers, refuses every write as a locked one does, or holds every write until released
export type FakeKeychain = 'answers' | 'refuses' | 'holds'

export interface FakeBun {
  // What the keychain holds now, by service/name
  readonly entries: Map<string, string>
  // Every service/name written so far, a held write included once it went through
  readonly written: readonly string[]
  // Lets the writes a holding keychain held go through
  readonly release: () => void
}

const keyOf = ({ service, name }: Entry): string => `${service}/${name}`

const restoredWithTheTest = (): void => {
  onTestFinished(() => {
    vi.unstubAllGlobals()
  })
}

// No Bun at all, as under Node, even when Vitest itself runs on Bun: nothing can reach a real keychain
export function withoutBun(): void {
  vi.stubGlobal('Bun', null)
  restoredWithTheTest()
}

// Bun.secrets as a map in place of the global Bun until the test ends; nothing of it reaches a real keychain
export function fakeBun(keychain: FakeKeychain): FakeBun {
  const entries = new Map<string, string>()
  const written: string[] = []
  const held = Promise.withResolvers<boolean>()
  const secrets = {
    get: async (entry: Entry): Promise<string | null> => {
      await Promise.resolve()
      return entries.get(keyOf(entry)) ?? null
    },
    set: async (entry: Entry): Promise<void> => {
      await (keychain === 'holds' ? held.promise : Promise.resolve())
      if (keychain === 'refuses') {
        throw new Error('the keychain is locked')
      }
      entries.set(keyOf(entry), entry.value ?? '')
      written.push(keyOf(entry))
    },
    delete: async (entry: Entry): Promise<boolean> => {
      await Promise.resolve()
      return entries.delete(keyOf(entry))
    },
  }
  vi.stubGlobal('Bun', { secrets })
  restoredWithTheTest()
  return {
    entries,
    written,
    release: () => {
      held.resolve(true)
    },
  }
}
```

`packages/kernel/src/testing/captured-logs.ts` (as shipped):

```ts
import type { LogRecord } from '@logtape/logtape'
import { onTestFinished, vi } from 'vitest'
import { configureLogging, resetLogging } from '../logging/logging.js'

// The level and the text of each record a category of the kernel logged
export const linesOf = (
  records: readonly LogRecord[],
  category: string,
): readonly (readonly [string, string])[] =>
  records
    .filter((record) => record.category.join('.') === category)
    .map((record) => [record.level, String(record.message[0])] as const)

// What the kernel logs from debug up while the test runs, kept off stderr; LogTape is reset when the test ends
export async function capturedLogs(): Promise<readonly LogRecord[]> {
  const records: LogRecord[] = []
  const quiet = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  await configureLogging({
    level: 'debug',
    json: true,
    capture: (record) => {
      records.push(record)
    },
  })
  onTestFinished(async () => {
    await resetLogging()
    quiet.mockRestore()
  })
  return records
}
```

`packages/kernel/src/secrets/keychain-probe.test.ts` (as shipped):

```ts
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { capturedLogs, linesOf } from '../testing/captured-logs.js'
import { fakeBun } from '../testing/fake-bun-secrets.js'
import { tempDir } from '../testing/temp-repo.js'
import { secretStoreFor } from './secret-store-for.js'

// What became of a call: the error it was refused with, else that it went through
const told = (outcome: PromiseSettledResult<unknown>): string =>
  outcome.status === 'rejected' ? String(outcome.reason) : 'fulfilled'

// Timers the test moves on itself, real again when it ends
const movedByTheTest = (): void => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
}

describe('secretStoreFor and a keychain that does not answer the probe', () => {
  it('takes the file for auto after 3 s, warning once with the keychain and the time it was given', async () => {
    expect.hasAssertions()
    fakeBun('holds')
    const logs = await capturedLogs()
    movedByTheTest()
    const chosen = secretStoreFor(tempDir('bb-home-'), 'auto')
    await vi.advanceTimersByTimeAsync(3000)
    await expect(chosen).resolves.toHaveProperty('backend', 'file')
    expect(linesOf(logs, 'bb.secrets')).toStrictEqual([
      ['warning', expect.stringMatching(/^the keychain did not answer within 3 s: /u)],
      ['debug', 'secrets backend: file (auto: the keychain did not answer within 3 s)'],
    ])
  })

  it('refuses keychain after 3 s, naming the time it gave the keychain', async () => {
    expect.hasAssertions()
    fakeBun('holds')
    movedByTheTest()
    const home = tempDir('bb-home-')
    const refusing = Promise.allSettled([secretStoreFor(home, 'keychain')])
    const [settled] = await Promise.all([refusing, vi.advanceTimersByTimeAsync(3000)])
    expect(settled.map((outcome) => told(outcome))).toStrictEqual([
      expect.stringMatching(/did not answer within 3 s.*secrets\.backend/u),
    ])
  })

  it('deletes the probe of a keychain that lets it in after the time', async () => {
    expect.hasAssertions()
    const keychain = fakeBun('holds')
    movedByTheTest()
    const chosen = secretStoreFor(tempDir('bb-home-'), 'auto')
    await vi.advanceTimersByTimeAsync(3000)
    await chosen
    keychain.release()
    await vi.waitFor(() => {
      expect([keychain.written, keychain.entries.size]).toStrictEqual([
        [`bytebureau/probe/${process.pid}`],
        0,
      ])
    })
  })
})

describe('secretStoreFor and a keychain that refuses the probe', () => {
  it('carries the error of the keychain into the refusal of keychain', async () => {
    expect.hasAssertions()
    fakeBun('refuses')
    await expect(secretStoreFor(tempDir('bb-home-'), 'keychain')).rejects.toThrow(
      /the keychain is locked.*secrets\.backend/u,
    )
  })
})
```

`packages/kernel/src/secrets/private-file.test.ts` (as shipped):

```ts
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../testing/temp-repo.js'
import { readIfPresent, writePrivate } from './private-file.js'

const modeOf = (file: string): number => statSync(file).mode % 0o1000

// A file of a fresh directory that the test removes when it is over
const fileIn = (name: string): string => path.join(tempDir('bb-private-'), name)

describe(writePrivate, () => {
  it('writes the text for the user alone and leaves no draft behind', () => {
    const file = fileIn('secrets.json')
    writePrivate(file, 'text')
    expect([readFileSync(file, 'utf8'), modeOf(file)]).toStrictEqual(['text', 0o600])
    expect(readdirSync(path.dirname(file))).toStrictEqual(['secrets.json'])
  })

  it('leaves the draft of another writer alone, and writes through no link planted at its own', () => {
    const file = fileIn('secrets.json')
    const target = path.join(path.dirname(file), 'target')
    writeFileSync(target, 'untouched')
    writeFileSync(`${file}.tmp`, 'theirs')
    symlinkSync(target, `${file}.${process.pid}.tmp`)
    writePrivate(file, 'secret')
    expect([readFileSync(target, 'utf8'), readFileSync(`${file}.tmp`, 'utf8')]).toStrictEqual([
      'untouched',
      'theirs',
    ])
    expect([lstatSync(file).isFile(), readFileSync(file, 'utf8'), modeOf(file)]).toStrictEqual([
      true,
      'secret',
      0o600,
    ])
  })

  it('removes its draft when the file cannot be replaced, and passes the failure on', () => {
    const file = fileIn('taken')
    mkdirSync(path.join(file, 'inside'), { recursive: true })
    expect(() => {
      writePrivate(file, 'text')
    }).toThrow(/EISDIR|ENOTEMPTY|EEXIST/u)
    expect(readdirSync(path.dirname(file))).toStrictEqual(['taken'])
  })
})

describe(readIfPresent, () => {
  it('reads the text of a file, and nothing where there is none', () => {
    const file = fileIn('record')
    expect(readIfPresent(file)).toBeUndefined()
    writeFileSync(file, 'file\n')
    expect(readIfPresent(file)).toBe('file\n')
  })

  it('passes on a failure other than a missing file', () => {
    const directory = path.dirname(fileIn('record'))
    expect(() => readIfPresent(directory)).toThrow(/EISDIR/u)
  })
})
```

`packages/kernel/src/secrets/secret-store-auto.test.ts` (as shipped):

```ts
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { capturedLogs, linesOf } from '../testing/captured-logs.js'
import { fakeBun } from '../testing/fake-bun-secrets.js'
import { tempDir } from '../testing/temp-repo.js'
import { secretStoreFor } from './secret-store-for.js'

const recordIn = (home: string): string => path.join(home, 'secrets.backend')

const modeOf = (file: string): number => statSync(file).mode % 0o1000

describe('secretStoreFor and the backend auto chose', () => {
  it('records the choice of the first start for the user alone, and keeps the file where the keychain answers later', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    fakeBun('refuses')
    const first = await secretStoreFor(home, 'auto')
    const record = recordIn(home)
    expect([first.backend, readFileSync(record, 'utf8'), modeOf(record)]).toStrictEqual([
      'file',
      'file\n',
      0o600,
    ])
    fakeBun('answers')
    await expect(secretStoreFor(home, 'auto')).resolves.toHaveProperty('backend', 'file')
  })

  it('takes the keychain it recorded again while the keychain answers', async () => {
    expect.hasAssertions()
    fakeBun('answers')
    const home = tempDir('bb-home-')
    writeFileSync(recordIn(home), 'keychain\n')
    await expect(secretStoreFor(home, 'auto')).resolves.toHaveProperty('backend', 'keychain')
  })

  it('keeps a recorded keychain, taking the file with a warning while it does not answer', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    fakeBun('answers')
    const first = await secretStoreFor(home, 'auto')
    const logs = await capturedLogs()
    fakeBun('refuses')
    const meanwhile = await secretStoreFor(home, 'auto')
    expect([first.backend, meanwhile.backend, readFileSync(recordIn(home), 'utf8')]).toStrictEqual([
      'keychain',
      'file',
      'keychain\n',
    ])
    expect(linesOf(logs, 'bb.secrets')).toStrictEqual([
      [
        'warning',
        expect.stringMatching(
          /^the secrets kept in the keychain are not available \(the keychain refused the probe: the keychain is locked\)/u,
        ),
      ],
      ['debug', 'secrets backend: file (auto: the keychain it chose before is not available)'],
    ])
  })
})

describe('secretStoreFor and a record of the backend it does not go by', () => {
  it('lets file and keychain ignore the record, and write none', async () => {
    expect.hasAssertions()
    fakeBun('answers')
    const home = tempDir('bb-home-')
    writeFileSync(recordIn(home), 'keychain\n')
    const file = await secretStoreFor(home, 'file')
    writeFileSync(recordIn(home), 'file\n')
    const keychain = await secretStoreFor(home, 'keychain')
    const fresh = tempDir('bb-home-')
    await Promise.all([secretStoreFor(fresh, 'file'), secretStoreFor(fresh, 'keychain')])
    expect([file.backend, keychain.backend, existsSync(recordIn(fresh))]).toStrictEqual([
      'file',
      'keychain',
      false,
    ])
  })

  it('refuses a record that names neither backend instead of choosing again', async () => {
    expect.hasAssertions()
    fakeBun('answers')
    const home = tempDir('bb-home-')
    writeFileSync(recordIn(home), 'vault\n')
    await expect(secretStoreFor(home, 'auto')).rejects.toThrow(
      /secrets\.backend names neither keychain nor file/u,
    )
  })
})
```

**Semantics (as shipped, commits d1d3113, e447132, 2c03ac3, 6a4938f, d52f594, b64632c, 9d13d63, 7f7753f):** `Secrets` (`bb/Secrets`) is a `SecretStore` that tells its `backend` (`keychain | file | memory`); `composeKernel` provides it from `KernelLayerOptions.secrets`, in-memory by default, and `PluginHostLive` takes it from the service (plugins still see it namespaced by their name). `BunSecretStore` wraps `Bun.secrets` under the service name `bytebureau` (the runtime object is narrowed by a type guard); `FileSecretStore` keeps a JSON map in `<home>/secrets.json`, written to a draft of its own per process (`<file>.<pid>.tmp`, opened exclusively after any stale draft is removed, narrowed to 0600 before the secrets land, fsynced) and renamed into place, the draft removed on a failed write, the directory created 0700, a file that does not hold a store refused and never overwritten; `secretStoreFor(home, backend)`: `file` → the file store, `keychain` → the Bun store when `Bun` exists and a probe (`set`, `get`, `delete` of `probe/<pid>`, the entry deleted in a finally, the whole probe bounded by 3 s) succeeds, else an error naming the keychain, `secrets.backend` and the probe's own failure or timeout, `auto` → the Bun store where the probe succeeds, the file store otherwise with one warning line saying why (under Node there is no `Bun`, so every test gets the file); `auto` is sticky per home: the backend it chose is recorded in `<home>/secrets.backend` (one word, 0600) and kept on later starts — a recorded `keychain` whose probe now fails warns that the stored secrets are unavailable and continues with the file store, a recorded `file` stays `file` — and an explicit setting ignores the record; the chosen backend is logged once at start. `facade/boot-secrets.ts` reads `secrets.backend` from the user file alone, leniently — a user configuration broken elsewhere still yields its backend, a missing section yields `auto`, and an unknown value refuses the start with an error naming `/secrets/backend` and the three allowed values (the daemon logs it and exits, `--no-daemon` prints it) — so a daemon started on a broken configuration never falls back to probing the real keychain and a typo never puts secrets where the user did not say; `kernelBunLayer` builds the store from it unless `KernelOptions.secrets` was given, `createKernel` and the daemon (`api/src/bun.ts`) pass it through. `HealthReport.secrets` names the backend; `HealthDto` is unchanged and both the API handler and the CLI's in-process Bureau map the DTO's four fields explicitly. Tests: the file store (persistence across instances, 0600, a missing key, a deleted key, a corrupt file refused), `secretStoreFor` under Node (`file` and `auto` give the file store, `keychain` is refused), `boot-secrets` (the lenient read), the in-memory store's `backend`, a fake `Bun.secrets` object pinning the Bun store's mapping, the probe's cleanup, the 3 s bound and the sticky record (no real keychain; the two Node-only suites stub the `Bun` global away; the one hand probe ran under `bytebureau-test-<pid>` and deleted its entry); `testHome()` puts every CLI test home on the file backend and about twenty kernel starts in the CLI tests moved onto `testHome()` or `configureHome()`, so an instrumented `keychain()` showed no test reaching it. Noted: `Bun.secrets.set(key, '')` deletes the entry while the file and memory stores keep `''` — moot since an empty key is refused by `ProfileService` (ruled after Task 1).

- [ ] **Step 5: Run everything that touches the wiring**

Run: `bunx vitest run --project kernel --project api --project bytebureau && bun run typecheck && bun run lint`
Expected: PASS; the daemon-backed CLI tests still start their daemons (the test home now names the file backend, so no test touches the keychain).

- [ ] **Step 6: Commit**

```bash
git add packages/kernel packages/api/src/bun.ts packages/api/src/testing-kernel.ts apps/bytebureau/src/testing/temp-repo.ts
git commit -m "feat(kernel): keep secrets in the keychain through bun.secrets, or in a file under the home where none serves"
```

---

### Task 3: The kernel's `ProfileService` — profiles in the store, the profile a session runs under, provider options in the request

**Files:**
- Create: `packages/kernel/src/profiles/profile-types.ts` (the `Profile`, `AddProfileInput`, `ProfileStatus`, `ResolvedProfile` shapes), `packages/kernel/src/profiles/profile-ids.ts`, `packages/kernel/src/profiles/profile-dirs.ts`, `packages/kernel/src/profiles/profile-keys.ts` (the secret key `@bytebureau/profiles/<id>/api_key`, outside the plugin-name grammar), `packages/kernel/src/profiles/profile-records.ts`, `packages/kernel/src/profiles/profile-add.ts`, `packages/kernel/src/profiles/profile-remove.ts`, `packages/kernel/src/profiles/profile-resolve.ts`, `packages/kernel/src/profiles/profile-status.ts`, `packages/kernel/src/profiles/profile-operations.ts`, `packages/kernel/src/profiles/profile-service.ts` (the service, its tag and its layer), `packages/kernel/src/sessions/session-profile.ts`, `packages/kernel/src/facade/profiles.ts`, `packages/kernel/src/facade/provider-areas.ts`; tests `profile-service.test.ts`, `profile-resolve.test.ts`, `profile-sessions.test.ts`, `session-profile.test.ts`, with the fixtures `profile-fixtures.ts` and `failing-fixtures.ts`
- Modify: `packages/kernel/src/errors.ts` (`ProfileError`), `packages/kernel/src/kernel-live.ts` (`ProfileServiceLive({ home })` after the plugin host), `packages/kernel/src/sessions/{session-deps,session-create,session-new,session-start,session-connect,session-agent,session-collect,session-project,session-shape}.ts` (the profile resolved at creation and stored, the request built effectfully with the profile part and `providerConfig`, the start and its abandon handler in one uninterruptible step), `packages/kernel/src/facade/{types,apis,promised}.ts` (`Kernel.profiles`), `packages/kernel/src/index.ts`, `packages/kernel/src/testing/{fake-agent-provider,fake-agent-session,scripted-provider}.ts` (the fake announces whether its key variable is set and echoes `providerConfig` in a `raw` event, without values), the kernel and CLI tests that count the fake's events
- Test: the new test files; `session-create.test.ts` gains the profile cases

**Interfaces:**
- Consumes: Task 1's `AgentProvider.apiKeyEnv`, `CreateSessionRequest.providerConfig`; Task 2's `Secrets`; Phase A's `profiles` table (`id, provider_id, name, kind, config_dir, is_default, created_at`), `EventLog.publish`, `PluginHost.agentProvider(id)`, `SessionDeps`, `requireProject`/`currentProject` of `session-project.ts`, `uuidv7`/`nowIso` of `ids.ts`.
- Produces:
  - `export interface Profile { readonly id: string; readonly providerId: string; readonly name: string; readonly kind: 'login' | 'api_key'; readonly configDir: string | null; readonly isDefault: boolean; readonly createdAt: string }`
  - `export interface AddProfileInput { readonly providerId: string; readonly name: string; readonly kind: 'login' | 'api_key'; readonly apiKey?: string | undefined; readonly makeDefault?: boolean | undefined }`
  - `export interface ProfileStatus { readonly profileId: string; readonly state: AuthState; readonly hint?: string | undefined; readonly account?: string | undefined; readonly checkedAt: string }`
  - `export interface ResolvedProfile { readonly ref: ProfileRef; readonly apiKey?: { readonly env: string; readonly value: string } | undefined }`
  - `export class ProfileError extends Data.TaggedError('ProfileError')<{ readonly code: 'not_found' | 'exists' | 'invalid' | 'in_use'; readonly reason: string }>` (the `reasonMessage` pattern of `errors.ts`)
  - `ProfileServiceShape { list(): Effect<readonly Profile[], StoreError>; add(input): Effect<Profile, ProfileError | SessionError | StoreError>; remove(id, options?: { readonly purge?: boolean }): Effect<void, ProfileError | StoreError>; setDefault(id): Effect<void, ProfileError | StoreError>; status(id): Effect<ProfileStatus, ProfileError | StoreError>; resolve(providerId, profileId: string | null | undefined): Effect<ResolvedProfile, ProfileError | StoreError> }`; `class ProfileService extends Context.Service<ProfileService, ProfileServiceShape>()('bb/ProfileService')`; `ProfileServiceLive(options: { readonly home: string })`.
  - `profileIdOf(providerId, name)` = `` `${providerId}/${name}` ``; the profile directory `profileDirOf(home, providerId, name)` = `<home>/profiles/<providerId with ':' replaced by '-'>/<name>`.
  - `Kernel.profiles = { list, add, remove, setDefault, status }` (promised); `Kernel.providers.list()` items gain `supportsApiKey`.
  - Secret key of a profile: `profiles/<profileId>/api_key`.

Semantics: a profile id is `<providerId>/<name>` (readable in the CLI, unique per provider; the name is `[a-z0-9][a-z0-9-]{0,31}`). The store's `profiles` table is the one source of truth; the `profiles` section of the user configuration stays accepted by the schema and is documented as reserved. `add` refuses an unknown provider (`SessionError provider_missing`, so the API answers 422 `session_provider_missing` as it does for a run), a duplicate id (`exists`), an `api_key` profile without a key or for a provider without `apiKeyEnv` (`invalid`), a `login` profile given a key (`invalid`); the first profile of a provider becomes its default, `makeDefault` moves the default; a `login` profile gets its directory created (0700) and recorded as `configDir`; an `api_key` profile stores the key under `profiles/<id>/api_key` and records `configDir: null`; `profile.added { profileId, providerId }` is published. `remove` refuses `in_use` while a session with that `profile_id` is not ended (status not in `completed | stopped | errored`), deletes the record and the secret, removes the directory only with `purge`, and makes the oldest remaining profile of the provider the default when the removed one was; `profile.removed` is published. `status` is `not_found` for an unknown id; a `login` profile whose directory is gone is `loggedOut` with the provider's hint without asking the provider; otherwise the provider's `authStatus(ref)` decides, a provider that throws gives `unknown` with the reason as the hint; `profile.status { profileId, state }` is published. `resolve(providerId, profileId)`: an explicit id must exist (`not_found`) and belong to the provider (`invalid`); without one the provider's default is used; without a default the ref is `{ id: 'default', providerId, kind: 'login' }` as Phase A built it; an `api_key` profile whose secret is gone is `invalid` ("the key of profile <id> is not in the secret store; add the profile again"). Session creation resolves the profile (so a bad profile fails the request, 404/422 through the API) and stores the resolved id (or null); the start of the provider session passes `profile: ref`, adds `[apiKey.env]: apiKey.value` to `env` for an `api_key` profile, and `providerConfig` = the project's `providers[providerId]` without `passEnv` (`{}` when absent).

- [ ] **Step 1: The failing service tests**

`packages/kernel/src/profiles/profile-service.test.ts` (over `KernelTest` with the fake provider, which declares `apiKeyEnv: 'BYTEBUREAU_FAKE_API_KEY'`; follow `session-create.test.ts` for the layer and the `it.layer` style):

```ts
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { EventLog } from '../events/event-log.js'
import { resolved } from '../plugins/plugin-call-fixtures.js'
import { probe } from '../plugins/plugin-fixtures.js'
import { Secrets } from '../secrets/secrets.js'
import { doubtingPlugin, refusingSecrets } from './failing-fixtures.js'
import { codeOf, loadedProfiles, profileWorld } from './profile-fixtures.js'

const world = profileWorld([doubtingPlugin])
const CANARY = 'sk-canary-1'
const KERNEL_KEY = '@bytebureau/profiles/fake/key/api_key'

const modeOf = (file: string): number => statSync(file).mode % 0o1000

const workDir = (): string => path.join(world.home, 'profiles', 'fake', 'work')

// Everything the log holds, as one text a secret must not appear in
const logText = Effect.map(
  EventLog.use((log) => log.read({}, { from: 0 })),
  (events) => JSON.stringify(events),
)

const addsLoginProfile = Effect.gen(function* addsLoginProfile() {
  const profiles = yield* loadedProfiles
  const added = yield* profiles.add({ providerId: 'fake', name: 'work', kind: 'login' })
  assert.deepStrictEqual(
    [added.id, added.isDefault, added.configDir],
    ['fake/work', true, workDir()],
  )
  assert.strictEqual(modeOf(workDir()), 0o700)
  const listed = yield* profiles.list()
  assert.deepStrictEqual(
    listed.map((profile) => profile.id),
    ['fake/work'],
  )
  assert.include(yield* logText, '"type":"profile.added"')
})

const keepsKey = Effect.gen(function* keepsKey() {
  const profiles = yield* loadedProfiles
  const keyed = yield* profiles.add({
    providerId: 'fake',
    name: 'key',
    kind: 'api_key',
    apiKey: CANARY,
  })
  const secrets = yield* Secrets
  assert.deepStrictEqual([keyed.configDir, keyed.isDefault], [null, false])
  assert.strictEqual(yield* resolved(secrets.get(KERNEL_KEY)), CANARY)
  assert.notInclude(JSON.stringify(yield* profiles.list()), CANARY)
  assert.notInclude(yield* logText, CANARY)
})

const refusesProfiles = Effect.gen(function* refusesProfiles() {
  const profiles = yield* loadedProfiles
  const refused = yield* Effect.all([
    codeOf(profiles.add({ providerId: 'fake', name: 'key', kind: 'api_key', apiKey: 'x' })),
    codeOf(profiles.add({ providerId: 'fake', name: 'l', kind: 'login', apiKey: 'x' })),
    codeOf(profiles.add({ providerId: 'fake', name: 'n', kind: 'api_key' })),
    codeOf(profiles.add({ providerId: 'fake', name: 'e', kind: 'api_key', apiKey: '' })),
    codeOf(profiles.add({ providerId: 'doubting', name: 'd', kind: 'api_key', apiKey: 'x' })),
    codeOf(profiles.add({ providerId: 'fake', name: 'Not/Ok', kind: 'login' })),
    codeOf(profiles.add({ providerId: 'ghost', name: 'g', kind: 'login' })),
  ])
  assert.deepStrictEqual(refused, [
    'exists',
    'invalid',
    'invalid',
    'invalid',
    'invalid',
    'invalid',
    'SessionError',
  ])
  assert.strictEqual((yield* profiles.list()).length, 2)
  assert.isFalse(existsSync(path.join(world.home, 'profiles', 'fake', 'l')))
})

const movesDefault = Effect.gen(function* movesDefault() {
  const profiles = yield* loadedProfiles
  yield* profiles.setDefault('fake/key')
  const listed = yield* profiles.list()
  assert.deepStrictEqual(
    listed.map((profile) => [profile.id, profile.isDefault]),
    [
      ['fake/work', false],
      ['fake/key', true],
    ],
  )
  assert.strictEqual(yield* codeOf(profiles.setDefault('fake/nope')), 'not_found')
})

const removesProfile = Effect.gen(function* removesProfile() {
  const profiles = yield* loadedProfiles
  yield* profiles.remove('fake/key')
  const secrets = yield* Secrets
  assert.isUndefined(yield* resolved(secrets.get(KERNEL_KEY)))
  const listed = yield* profiles.list()
  assert.deepStrictEqual(
    listed.map((profile) => [profile.id, profile.isDefault]),
    [['fake/work', true]],
  )
  assert.include(yield* logText, '"type":"profile.removed"')
})

const purgesDirectory = Effect.gen(function* purgesDirectory() {
  const profiles = yield* loadedProfiles
  yield* profiles.remove('fake/work')
  assert.isTrue(existsSync(workDir()))
  const again = yield* profiles.add({ providerId: 'fake', name: 'work', kind: 'login' })
  yield* profiles.remove(again.id, { purge: true })
  assert.isFalse(existsSync(workDir()))
  assert.strictEqual(yield* codeOf(profiles.remove('fake/work')), 'not_found')
  assert.deepStrictEqual(yield* profiles.list(), [])
})

it.layer(world.layer)('ProfileService', (suite) => {
  suite.effect(
    'adds a login profile with its own directory, makes the first one the default and lists it',
    () => addsLoginProfile,
  )
  suite.effect(
    'keeps an API key in the secret store only, under a key no plugin can name',
    () => keepsKey,
  )
  suite.effect(
    'refuses a name twice, a key for a login profile, an api_key profile without a key or for a provider that takes none, a bad name and an unknown provider',
    () => refusesProfiles,
  )
  suite.effect('moves the default to the profile that is made the default', () => movesDefault)
  suite.effect(
    'removes a profile with its key and passes the default to the oldest one left',
    () => removesProfile,
  )
  suite.effect(
    'keeps the directory of a removed login profile unless it is purged, and refuses an id nobody holds',
    () => purgesDirectory,
  )
})

const named = probe('profiles')
const shared = profileWorld([named.plugin])

it.layer(shared.layer)('ProfileService beside a plugin named profiles', (suite) => {
  suite.effect('keeps the key of a profile out of the reach of the secrets of that plugin', () =>
    Effect.gen(function* keepsKeyApart() {
      const profiles = yield* loadedProfiles
      yield* profiles.add({ providerId: 'fake', name: 'key', kind: 'api_key', apiKey: CANARY })
      const { secrets } = named.context()
      assert.isUndefined(yield* resolved(secrets.get('fake/key/api_key')))
      yield* resolved(secrets.set('fake/key/api_key', 'planted'))
      const found = yield* profiles.resolve('fake', 'fake/key')
      assert.deepStrictEqual(found.apiKey, { env: 'BYTEBUREAU_FAKE_API_KEY', value: CANARY })
    }),
  )
})

const locked = profileWorld([], refusingSecrets)

it.layer(locked.layer)('ProfileService over a secret store that refuses the key', (suite) => {
  suite.effect('fails as the store and keeps nothing of the profile', () =>
    Effect.gen(function* keepsNothing() {
      const profiles = yield* loadedProfiles
      const input = { providerId: 'fake', name: 'key', kind: 'api_key', apiKey: CANARY } as const
      const failure = yield* Effect.flip(profiles.add(input))
      assert.deepStrictEqual(
        [failure.name, failure.message],
        ['StoreError', 'the keychain is locked'],
      )
      assert.deepStrictEqual(yield* profiles.list(), [])
      assert.notInclude(yield* logText, 'profile.added')
      assert.deepStrictEqual(yield* profiles.resolve('fake', null), {
        ref: { id: 'default', providerId: 'fake', kind: 'login' },
      })
    }),
  )
})
```

`packages/kernel/src/profiles/profile-resolve.test.ts` — `resolve` and `status`:

```ts
import { rmSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { EventLog } from '../events/event-log.js'
import { resolved } from '../plugins/plugin-call-fixtures.js'
import { Secrets } from '../secrets/secrets.js'
import { doubtingPlugin } from './failing-fixtures.js'
import { codeOf, loadedProfiles, profileWorld } from './profile-fixtures.js'

const CANARY = 'sk-canary-2'
const KEY_ENV = 'BYTEBUREAU_FAKE_API_KEY'

const resolvesProfiles = Effect.gen(function* resolvesProfiles() {
  const profiles = yield* loadedProfiles
  const none = yield* profiles.resolve('fake', null)
  const keyed = yield* profiles.add({
    providerId: 'fake',
    name: 'key',
    kind: 'api_key',
    apiKey: CANARY,
  })
  const byDefault = yield* profiles.resolve('fake', null)
  assert.deepStrictEqual(none, { ref: { id: 'default', providerId: 'fake', kind: 'login' } })
  assert.deepStrictEqual(byDefault, {
    ref: { id: keyed.id, providerId: 'fake', kind: 'api_key' },
    apiKey: { env: KEY_ENV, value: CANARY },
  })
  const refused = yield* Effect.all([
    codeOf(profiles.resolve('claude', keyed.id)),
    codeOf(profiles.resolve('fake', 'fake/nope')),
  ])
  assert.deepStrictEqual(refused, ['invalid', 'not_found'])
})

const resolvesLogin = Effect.gen(function* resolvesLogin() {
  const profiles = yield* loadedProfiles
  const work = yield* profiles.add({ providerId: 'fake', name: 'work', kind: 'login' })
  const found = yield* profiles.resolve('fake', work.id)
  assert.deepStrictEqual<unknown>(found, {
    ref: { id: 'fake/work', providerId: 'fake', kind: 'login', configDir: work.configDir },
  })
})

const refusesLostKey = Effect.gen(function* refusesLostKey() {
  const profiles = yield* loadedProfiles
  const secrets = yield* Secrets
  yield* resolved(secrets.delete('@bytebureau/profiles/fake/key/api_key'))
  const named = yield* Effect.flip(profiles.resolve('fake', 'fake/key'))
  assert.deepStrictEqual(
    [named.name, named.message],
    [
      'ProfileError',
      'the key of profile "fake/key" is not in the secret store; remove the profile and add it again',
    ],
  )
  assert.strictEqual(yield* codeOf(profiles.resolve('fake', null)), 'invalid')
})

const resolving = profileWorld()

it.layer(resolving.layer)('ProfileService resolve', (suite) => {
  suite.effect(
    'resolves the explicit profile, else the default, else the nameless login ref, and refuses a mismatch',
    () => resolvesProfiles,
  )
  suite.effect(
    'resolves a login profile to its ref with its directory and no key',
    () => resolvesLogin,
  )
  suite.effect(
    'refuses an api_key profile whose key is no longer in the secret store, by name and as the default',
    () => refusesLostKey,
  )
})

const tellsStatus = Effect.gen(function* tellsStatus() {
  const profiles = yield* loadedProfiles
  const work = yield* profiles.add({ providerId: 'fake', name: 'work', kind: 'login' })
  const fine = yield* profiles.status(work.id)
  const dir = work.configDir ?? ''
  rmSync(dir, { recursive: true, force: true })
  const gone = yield* profiles.status(work.id)
  assert.deepStrictEqual(
    [fine.state, gone.state, gone.hint],
    ['loggedIn', 'loggedOut', `the directory ${dir} is gone; remove the profile and add it again`],
  )
  const told = yield* EventLog.use((log) => log.read({ types: ['profile.status'] }, { from: 0 }))
  assert.deepStrictEqual(
    told.map((event) => event.payload),
    [
      { profileId: 'fake/work', state: 'loggedIn' },
      { profileId: 'fake/work', state: 'loggedOut' },
    ],
  )
})

const tellsUnknown = Effect.gen(function* tellsUnknown() {
  const profiles = yield* loadedProfiles
  const doubted = yield* profiles.add({ providerId: 'doubting', name: 'd', kind: 'login' })
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO profiles (id, provider_id, name, kind, created_at) VALUES ('ghost/g', 'ghost', 'g', 'login', 't')`
  const failing = yield* profiles.status(doubted.id)
  const unloaded = yield* profiles.status('ghost/g')
  assert.deepStrictEqual(
    [failing.state, failing.hint, unloaded.state, unloaded.hint],
    ['unknown', 'the account check failed', 'unknown', 'provider "ghost" is not loaded'],
  )
  assert.strictEqual(yield* codeOf(profiles.status('fake/nope')), 'not_found')
})

// An api_key profile whose key has left the secret store is logged out, whatever its provider would say
const tellsLostKey = Effect.gen(function* tellsLostKey() {
  const profiles = yield* loadedProfiles
  const keyed = yield* profiles.add({
    providerId: 'fake',
    name: 'key',
    kind: 'api_key',
    apiKey: CANARY,
  })
  const kept = yield* profiles.status(keyed.id)
  yield* resolved((yield* Secrets).delete('@bytebureau/profiles/fake/key/api_key'))
  const lost = yield* profiles.status(keyed.id)
  assert.deepStrictEqual(
    [kept.state, lost.state, lost.hint],
    [
      'loggedIn',
      'loggedOut',
      'the key of profile "fake/key" is not in the secret store; remove the profile and add it again',
    ],
  )
})

const checking = profileWorld([doubtingPlugin])

it.layer(checking.layer)('ProfileService status', (suite) => {
  suite.effect(
    'tells a login profile whose directory is gone as logged out with the hint, and asks the provider otherwise',
    () => tellsStatus,
  )
  suite.effect(
    'tells unknown with the reason when the provider cannot say, or is not loaded, and refuses an id nobody holds',
    () => tellsUnknown,
  )
  suite.effect(
    'tells an api_key profile whose key is gone from the secret store as logged out, without asking its provider',
    () => tellsLostKey,
  )
})
```

`packages/kernel/src/sessions/session-create.test.ts` — add: a session created with `profileId: 'fake/key'` runs its fake agent with `BYTEBUREAU_FAKE_API_KEY` set (the fake announces `session.warning { kind: 'env', message: 'api key: present' }` — never the value) and the stored session has `profileId: 'fake/key'`; a session with `profileId: 'fake/nope'` fails with `ProfileError not_found`; a session for a provider with a default profile gets it without naming one; the request's `providerConfig` carries the project's `providers.fake` section without `passEnv` (write `providers: { fake: { passEnv: ['X'], flavour: 'slow' } }` into the test repo's `bytebureau.json` through `writeConfig`, and have the fake record `providerConfig` in a `raw` event or pick its script from `providerConfig.flavour` when `BYTEBUREAU_FAKE_SCRIPT` is unset).

- [ ] **Step 2: Run the tests to see them fail**

Run: `bunx vitest run --project kernel packages/kernel/src/profiles packages/kernel/src/sessions/session-create.test.ts`
Expected: FAIL — `ProfileService` does not exist; `profileId` of a created session is still stored unresolved.

- [ ] **Step 3: Ids, directories, records**

`packages/kernel/src/profiles/profile-ids.ts`:

```ts
import type { ProfileRef } from '@bytebureau/plugin-api'

// A name is a path segment of the profiles directory, so the pattern of AddProfileBody holds here too
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/u

export const isProfileName = (name: string): boolean => PROFILE_NAME.test(name)

// Readable on the command line and unique per provider: a name holds no slash, so the last one parts the two
export const profileIdOf = (providerId: string, name: string): string => `${providerId}/${name}`

// The ref of a session whose provider has no profile is the nameless login of Phase A; no profile id is it, as each holds a slash
export const NAMELESS_PROFILE_ID = 'default'

export const namelessRefOf = (providerId: string): ProfileRef => ({
  id: NAMELESS_PROFILE_ID,
  providerId,
  kind: 'login',
})
```

`packages/kernel/src/profiles/profile-dirs.ts`:

```ts
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Effect } from 'effect'
import { toStoreError, type StoreError } from '../errors.js'

// A provider id may hold a colon (acp:codex), which not every file system takes in a name
export const profileDirOf = (home: string, providerId: string, name: string): string =>
  path.join(home, 'profiles', providerId.replaceAll(':', '-'), name)

// The directory holds a login, so the one this call creates is the user's alone whatever the umask
// One that exists, such as the login of a profile added again, keeps its mode
export const ensureProfileDir = (dir: string): Effect.Effect<void, StoreError> =>
  Effect.try({
    try: () => {
      if (mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined) {
        chmodSync(dir, 0o700)
      }
    },
    catch: toStoreError,
  })

export const removeProfileDir = (dir: string): Effect.Effect<void, StoreError> =>
  Effect.try({
    try: () => {
      rmSync(dir, { recursive: true, force: true })
    },
    catch: toStoreError,
  })
```

`packages/kernel/src/profiles/profile-records.ts` — the SQL, in the style of `session-records.ts`:

```ts
import { Effect } from 'effect'
import type { SqlClient } from 'effect/sql'
import { ProfileError, toStoreError, type StoreError } from '../errors.js'
import type { Profile } from './profile-types.js'

interface Row {
  readonly id: string
  readonly provider_id: string
  readonly name: string
  readonly kind: string
  readonly config_dir: string | null
  readonly is_default: number
  readonly created_at: string
}

const profileOf = (row: Row): Profile => ({
  id: row.id,
  providerId: row.provider_id,
  name: row.name,
  kind: row.kind === 'api_key' ? 'api_key' : 'login',
  configDir: row.config_dir,
  isDefault: row.is_default === 1,
  createdAt: row.created_at,
})

// The profile of the first row; a query that finds none has none
const firstProfile = (rows: readonly Row[]): Profile | undefined => {
  const [row] = rows
  return row === undefined ? undefined : profileOf(row)
}

const missing = (id: string): ProfileError =>
  new ProfileError({ code: 'not_found', reason: `no profile "${id}"` })

// By provider, then in the order they were added; the rowid parts two added within one millisecond
export const listProfiles = (
  sql: SqlClient.SqlClient,
): Effect.Effect<readonly Profile[], StoreError> =>
  sql<Row>`SELECT * FROM profiles ORDER BY provider_id, created_at, rowid`.pipe(
    Effect.mapError(toStoreError),
    Effect.map((rows) => rows.map((row) => profileOf(row))),
  )

export const loadProfile = (
  sql: SqlClient.SqlClient,
  id: string,
): Effect.Effect<Profile | undefined, StoreError> =>
  sql<Row>`SELECT * FROM profiles WHERE id = ${id}`.pipe(
    Effect.mapError(toStoreError),
    Effect.map(firstProfile),
  )

export const requireProfile = (
  sql: SqlClient.SqlClient,
  id: string,
): Effect.Effect<Profile, ProfileError | StoreError> =>
  Effect.flatMap(loadProfile(sql, id), (profile) =>
    profile === undefined ? Effect.fail(missing(id)) : Effect.succeed(profile),
  )

export const defaultProfileOf = (
  sql: SqlClient.SqlClient,
  providerId: string,
): Effect.Effect<Profile | undefined, StoreError> =>
  sql<Row>`SELECT * FROM profiles WHERE provider_id = ${providerId} AND is_default = 1 ORDER BY created_at, rowid`.pipe(
    Effect.mapError(toStoreError),
    Effect.map(firstProfile),
  )

// The oldest profile of a provider, which inherits the default when the default goes
const oldestProfileOf = (
  sql: SqlClient.SqlClient,
  providerId: string,
): Effect.Effect<Profile | undefined, StoreError> =>
  sql<Row>`SELECT * FROM profiles WHERE provider_id = ${providerId} ORDER BY created_at, rowid LIMIT 1`.pipe(
    Effect.mapError(toStoreError),
    Effect.map(firstProfile),
  )

// The row claims the id, not yet as the default; a second profile of the id inserts nothing, which the result tells
export const claimProfile = (
  sql: SqlClient.SqlClient,
  profile: Profile,
): Effect.Effect<boolean, StoreError> =>
  sql`
    INSERT INTO profiles (id, provider_id, name, kind, config_dir, is_default, created_at)
    VALUES (${profile.id}, ${profile.providerId}, ${profile.name}, ${profile.kind}, ${profile.configDir}, 0, ${profile.createdAt})
    ON CONFLICT (id) DO NOTHING RETURNING id`.pipe(
    Effect.mapError(toStoreError),
    Effect.map((rows) => rows.length > 0),
  )

// The row of a profile whose key or directory could not be kept
export const forgetProfile = (
  sql: SqlClient.SqlClient,
  id: string,
): Effect.Effect<void, StoreError> =>
  sql`DELETE FROM profiles WHERE id = ${id}`.pipe(Effect.asVoid, Effect.mapError(toStoreError))

// One default per provider: the one statement sets the flag on this profile and clears it on every other
export const markDefault = (
  sql: SqlClient.SqlClient,
  providerId: string,
  id: string,
): Effect.Effect<void, StoreError> =>
  sql`UPDATE profiles SET is_default = (id = ${id}) WHERE provider_id = ${providerId}`.pipe(
    Effect.asVoid,
    Effect.mapError(toStoreError),
  )

export const makeDefault = (
  sql: SqlClient.SqlClient,
  id: string,
): Effect.Effect<void, ProfileError | StoreError> =>
  Effect.flatMap(requireProfile(sql, id), (profile) => markDefault(sql, profile.providerId, id))

// The sessions under a profile that run or can still resume: every one but a completed session, as a stopped or errored one resumes
const holdingSessionsOf = (
  sql: SqlClient.SqlClient,
  id: string,
): Effect.Effect<number, StoreError> =>
  sql<{
    readonly holding: number
  }>`SELECT COUNT(*) AS holding FROM sessions WHERE profile_id = ${id} AND status <> 'completed'`.pipe(
    Effect.mapError(toStoreError),
    Effect.map(([row]) => (row === undefined ? 0 : row.holding)),
  )

const inUse = (id: string, holding: number): ProfileError =>
  new ProfileError({
    code: 'in_use',
    reason: `profile "${id}" is in use: ${holding} session(s) still run under it or can resume; complete or remove them first`,
  })

// The default passes to the oldest profile left of the provider, when the removed one held it
const passDefault = (
  sql: SqlClient.SqlClient,
  removed: Profile,
): Effect.Effect<void, StoreError> =>
  removed.isDefault
    ? Effect.flatMap(oldestProfileOf(sql, removed.providerId), (next) =>
        next === undefined ? Effect.void : markDefault(sql, removed.providerId, next.id),
      )
    : Effect.void

// A session that runs or can resume keeps its profile; the completed ones let go of it, as the store refers to no profile that is gone
// The count, the release, the delete and the passing of the default share one transaction: a session created in between cannot slip past, and two removals cannot leave a provider without its default
export const deleteProfile = (
  sql: SqlClient.SqlClient,
  id: string,
): Effect.Effect<Profile, ProfileError | StoreError> =>
  sql
    .withTransaction(
      Effect.gen(function* deletesProfile() {
        const holding = yield* holdingSessionsOf(sql, id)
        if (holding > 0) {
          return yield* inUse(id, holding)
        }
        yield* sql`UPDATE sessions SET profile_id = NULL WHERE profile_id = ${id} AND status = 'completed'`.pipe(
          Effect.mapError(toStoreError),
        )
        const deleted = yield* sql<Row>`DELETE FROM profiles WHERE id = ${id} RETURNING *`.pipe(
          Effect.mapError(toStoreError),
          Effect.map(firstProfile),
        )
        if (deleted === undefined) {
          return yield* missing(id)
        }
        yield* passDefault(sql, deleted)
        return deleted
      }),
    )
    .pipe(Effect.catchTag('SqlError', (failure) => Effect.fail(toStoreError(failure))))
```

(Use `sql.withTransaction` around `markDefault`'s two statements if the shipped `StoreError` constructor differs, follow `session-records.ts` for its exact fields; `rows[0]?.count` is forbidden by the lint — write `const [row] = rows; return row === undefined ? 0 : row.count`.)

- [ ] **Step 4: The service**

`packages/kernel/src/errors.ts` — add after `AskError`:

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

// A configuration that cannot be used, in one line: where, then why; a reason that names the place already is not prefixed again
export const configErrorLine = ({ file, pointer, reason }: ConfigError): string => {
  const where = `${file}${pointer}`
  return reason.startsWith(`${where}: `) ? reason : `${where}: ${reason}`
}

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

export const ProfileError = described(
  Data.TaggedError('ProfileError')<{
    readonly code: 'not_found' | 'exists' | 'invalid' | 'in_use'
    readonly reason: string
  }>,
  reasonMessage,
)
export type ProfileError = InstanceType<typeof ProfileError>

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

(mirror exactly how the other errors in the file attach `reasonMessage` — the file shows `reasonMessage,` in an options object; copy that form.)

`packages/kernel/src/profiles/profile-status.ts` — the status of one profile:

```ts
import { existsSync } from 'node:fs'
import type { AgentProvider, AuthStatus, ProfileRef } from '@bytebureau/plugin-api'
import { Effect } from 'effect'
import type { ProfileError, StoreError } from '../errors.js'
import { nowIso } from '../ids.js'
import { reasonOf } from '../plugins/reason.js'
import { lostKeyReason, usableKeyOf } from './profile-keys.js'
import { requireProfile } from './profile-records.js'
import type { Profile, ProfileDeps, ProfileStatus } from './profile-types.js'

export const refOf = (profile: Profile): ProfileRef => ({
  id: profile.id,
  providerId: profile.providerId,
  kind: profile.kind,
  ...(profile.configDir === null ? {} : { configDir: profile.configDir }),
})

// The directory of a login profile when it is gone, which holds no login: the answer is known whatever the provider says
const goneDirectoryOf = (profile: Profile): string | undefined =>
  profile.kind === 'login' && profile.configDir !== null && !existsSync(profile.configDir)
    ? profile.configDir
    : undefined

// What the provider says; one that cannot say is unknown, with its reason as the hint
const asked = (provider: AgentProvider, ref: ProfileRef): Effect.Effect<AuthStatus> =>
  Effect.tryPromise({
    try: async () => {
      const status = await provider.authStatus(ref)
      return status
    },
    catch: reasonOf,
  }).pipe(
    Effect.match({
      onFailure: (reason): AuthStatus => ({ state: 'unknown', hint: reason }),
      onSuccess: (status) => status,
    }),
  )

// Where to log in again: the provider's words when it says logged out too, else the directory the kernel knows
const goneHint = (status: AuthStatus, directory: string): string =>
  status.state === 'loggedOut' && status.hint !== undefined
    ? status.hint
    : `the directory ${directory} is gone; remove the profile and add it again`

const loggedOut = (profile: Profile, hint: string): ProfileStatus => ({
  profileId: profile.id,
  state: 'loggedOut',
  hint,
  checkedAt: nowIso(),
})

const statusOf = (provider: AgentProvider, profile: Profile): Effect.Effect<ProfileStatus> =>
  Effect.map(asked(provider, refOf(profile)), (status): ProfileStatus => {
    const gone = goneDirectoryOf(profile)
    if (gone !== undefined) {
      return loggedOut(profile, goneHint(status, gone))
    }
    return {
      profileId: profile.id,
      state: status.state,
      ...(status.hint === undefined ? {} : { hint: status.hint }),
      ...(status.account === undefined ? {} : { account: status.account }),
      checkedAt: nowIso(),
    }
  })

// An api_key profile whose key has left the secret store cannot sign in, whatever its provider would say
const keyLost = (deps: ProfileDeps, profile: Profile): Effect.Effect<boolean, StoreError> =>
  profile.kind === 'api_key'
    ? Effect.map(usableKeyOf(deps.secrets, profile.id), (value) => value === undefined)
    : Effect.succeed(false)

// A provider that is not loaded cannot be asked
const unloaded = (profile: Profile): ProfileStatus => ({
  profileId: profile.id,
  state: 'unknown',
  hint: `provider "${profile.providerId}" is not loaded`,
  checkedAt: nowIso(),
})

// What the kernel knows is told without asking the provider: a lost key, a provider that is not loaded
const checkedStatus = (
  deps: ProfileDeps,
  profile: Profile,
): Effect.Effect<ProfileStatus, StoreError> =>
  Effect.gen(function* checksStatus() {
    if (yield* keyLost(deps, profile)) {
      return loggedOut(profile, lostKeyReason(profile.id))
    }
    const provider = deps.host.agentProvider(profile.providerId)
    return provider === undefined ? unloaded(profile) : yield* statusOf(provider, profile)
  })

export const profileStatus = (
  deps: ProfileDeps,
  id: string,
): Effect.Effect<ProfileStatus, ProfileError | StoreError> =>
  Effect.gen(function* tellsStatus() {
    const profile = yield* requireProfile(deps.sql, id)
    const checked = yield* checkedStatus(deps, profile)
    yield* deps.log.publish({
      type: 'profile.status',
      payload: { profileId: id, state: checked.state },
    })
    return checked
  })
```

(`goneHint` asks the provider only for its hint text — a provider's `authStatus` on a missing directory is cheap (`claude` is not spawned when the dir is missing: Task 6's adapter answers `loggedOut` itself); simplify to a constant hint `` `${provider.id}: the profile directory ${configDir} is gone; add the profile again` `` if the probe shows the provider's call is costly.)

`packages/kernel/src/profiles/profile-service.ts`:

```ts
import { Context, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { EventLog } from '../events/event-log.js'
import { PluginHost } from '../plugins/plugin-host.js'
import { Secrets } from '../secrets/secrets.js'
import { profileOperations } from './profile-operations.js'
import type { ProfileServiceShape } from './profile-types.js'

export type {
  AddProfileInput,
  Profile,
  ProfileServiceShape,
  ProfileStatus,
  ResolvedProfile,
} from './profile-types.js'

// The named auth profiles per provider: the store's profiles table is their one source of truth, their keys live in the secret store
export class ProfileService extends Context.Service<ProfileService, ProfileServiceShape>()(
  'bb/ProfileService',
) {}

export interface ProfileServiceOptions {
  // The login directories of the profiles are made under <home>/profiles
  readonly home: string
}

export const ProfileServiceLive = (
  options: ProfileServiceOptions,
): Layer.Layer<ProfileService, never, SqlClient.SqlClient | EventLog | PluginHost | Secrets> =>
  Layer.effect(
    ProfileService,
    Effect.gen(function* makesProfiles() {
      return ProfileService.of(
        profileOperations({
          sql: yield* SqlClient.SqlClient,
          log: yield* EventLog,
          host: yield* PluginHost,
          secrets: yield* Secrets,
          home: options.home,
        }),
      )
    }),
  )
```

(Split the file at the lint caps: `profile-add.ts` for `checkedInput`/`add`, `profile-remove.ts` for `remove`/`passDefault`, `profile-resolve.ts` for `resolved`/`resolve`; the service file keeps the types, the class and the layer. `deps.log.publish` takes whatever shape `EventLog.publish` has in Phase A — look at `project-registry.ts` for the envelope builder and use the same.)

- [ ] **Step 5: The profile of a session and the provider options**

`packages/kernel/src/sessions/session-deps.ts`: `SessionDeps` gains `readonly profiles: ProfileService['Service']`; `SessionManagerLive` yields `ProfileService` and passes it. `packages/kernel/src/kernel-live.ts`: `ProfileServiceLive({ home: options.home })` joins the `registry` merge (after `PluginHostLive`, before `SessionManagerLive`); `KernelServices` gains `ProfileService`.

`packages/kernel/src/sessions/session-profile.ts`:

```ts
import type { ProfileRef } from '@bytebureau/plugin-api'
import { Effect } from 'effect'
import type { ConfigError, ProfileError, SessionError, StoreError } from '../errors.js'
import { namelessRefOf } from '../profiles/profile-ids.js'
import type { SessionDeps } from './session-deps.js'
import { currentProject, providerOptionsOf, requireProject } from './session-project.js'
import type { Session } from './types.js'

// What the profile adds to the start: the ref the provider sees, and the key in the variable the provider named
interface ProfilePart {
  readonly profile: ProfileRef
  readonly env: Readonly<Record<string, string>>
}

// The profile of a session is the one of its creation: a session created without one runs under the nameless login for its whole life, whatever default its provider has since
// A named one is resolved again at each start, so a key that has left the secret store since is noticed
export const profilePartOf = (
  deps: SessionDeps,
  session: Session,
): Effect.Effect<ProfilePart, ProfileError | StoreError> =>
  session.profileId === null
    ? Effect.succeed({ profile: namelessRefOf(session.providerId), env: {} })
    : Effect.map(
        deps.profiles.resolve(session.providerId, session.profileId),
        ({ ref, apiKey }) => ({
          profile: ref,
          env: apiKey === undefined ? {} : { [apiKey.env]: apiKey.value },
        }),
      )

// The providers.<id> section of the project as it stands now, as the passEnv names of a resumed session are read
export const providerConfigOf = (
  deps: SessionDeps,
  session: Session,
): Effect.Effect<Readonly<Record<string, unknown>>, SessionError | ConfigError | StoreError> =>
  Effect.gen(function* readsProviderConfig() {
    const registered = yield* requireProject(deps, session.projectId)
    const project = yield* currentProject(deps, registered)
    return providerOptionsOf(project, session.providerId)
  })
```

`packages/kernel/src/sessions/session-start.ts`: `requestOf` becomes an Effect that yields `profilePartOf` and `providerConfigOf` and builds `{ …, profile: part.profile, providerConfig, env: { ...allowlistEnv(process.env, passEnv), ...bytebureauEnv(extra), ...part.env, BYTEBUREAU_SESSION_ID: session.id } }`; its failure (`ProfileError`) is mapped to `ProviderError({ kind: 'auth', reason, retryable: false })` so the start fails as an auth refusal (the API answers 502 `provider_auth`; the CLI exits 4). `session-create.ts`: after `employeeOf`, `yield* deps.profiles.resolve(input.providerId ?? employee.provider, input.profileId)` and store `profile_id` = `resolved.ref.id === 'default' ? null : resolved.ref.id`; `ProfileError` passes through `create`'s error type (the API maps it in Task 4).

`packages/kernel/src/testing/fake-agent-session.ts`: at the start of `runHello`/`runSlow`, push `{ type: 'session.warning', kind: 'env', message: \`api key: ${request.env['BYTEBUREAU_FAKE_API_KEY'] === undefined ? 'absent' : 'present'}\` }` and `{ type: 'raw', providerEvent: { providerConfig: request.providerConfig } }` once (the canary of Task 5 reads the first, the create test the second). `scriptOf` prefers `BYTEBUREAU_FAKE_SCRIPT`, else `providerConfig.flavour === 'slow'`.

`packages/kernel/src/facade/profiles.ts`:

```ts
import { ProfileService } from '../profiles/profile-service.js'
import type { Promised } from './promised.js'
import type { Kernel } from './types.js'

export const profilesApi = (promised: Promised): Kernel['profiles'] => ({
  list: promised(ProfileService, (profiles) => profiles.list()),
  get: promised(ProfileService, (profiles, id) => profiles.get(id)),
  add: promised(ProfileService, (profiles, input) => profiles.add(input)),
  remove: promised(ProfileService, (profiles, id, options) => profiles.remove(id, options)),
  setDefault: promised(ProfileService, (profiles, id) => profiles.setDefault(id)),
  status: promised(ProfileService, (profiles, id) => profiles.status(id)),
})
```

`facade/types.ts`: `readonly profiles: { list(): Promise<readonly Profile[]>; add(input: AddProfileInput): Promise<Profile>; remove(id: string, options?: { readonly purge?: boolean }): Promise<void>; setDefault(id: string): Promise<void>; status(id: string): Promise<ProfileStatus> }`; `providers.list()` returns `{ id, displayName, supportsApiKey: provider.apiKeyEnv !== undefined }`. `facade.ts` wires `profilesApi`. `index.ts` exports `ProfileService`, `ProfileServiceLive`, the types, `ProfileError` (through `errors.ts`).

**Added files (as shipped):**

`packages/kernel/src/profiles/profile-types.ts` (as shipped):

```ts
import type { ProfileRef } from '@bytebureau/plugin-api'
import type { AuthState } from '@bytebureau/protocol'
import type { Effect } from 'effect'
import type { SqlClient } from 'effect/sql'
import type { ProfileError, SessionError, StoreError } from '../errors.js'
import type { EventLogShape } from '../events/event-log.js'
import type { PluginHostShape } from '../plugins/plugin-host.js'
import type { SecretsShape } from '../secrets/secrets.js'

export interface Profile {
  readonly id: string
  readonly providerId: string
  readonly name: string
  readonly kind: 'login' | 'api_key'
  readonly configDir: string | null
  readonly isDefault: boolean
  readonly createdAt: string
}

export interface AddProfileInput {
  readonly providerId: string
  readonly name: string
  readonly kind: 'login' | 'api_key'
  readonly apiKey?: string | undefined
  readonly makeDefault?: boolean | undefined
}

// The optional fields are left out rather than undefined, as the API's ProfileStatusDto has them
export interface ProfileStatus {
  readonly profileId: string
  readonly state: AuthState
  readonly hint?: string
  readonly account?: string
  readonly checkedAt: string
}

// The key of an api_key profile travels in the variable the provider declared; a login profile is its ref alone
export interface ResolvedProfile {
  readonly ref: ProfileRef
  readonly apiKey?: { readonly env: string; readonly value: string } | undefined
}

export interface Removal {
  // The login directory goes as well; without it a profile added again under the name finds its login
  readonly purge?: boolean
}

// What the operations of the service work with
export interface ProfileDeps {
  readonly sql: SqlClient.SqlClient
  readonly log: EventLogShape
  readonly host: PluginHostShape
  readonly secrets: SecretsShape
  readonly home: string
}

export interface ProfileServiceShape {
  readonly list: () => Effect.Effect<readonly Profile[], StoreError>
  readonly get: (id: string) => Effect.Effect<Profile | undefined, StoreError>
  // An unknown provider is refused as a session would be, with SessionError provider_missing
  readonly add: (
    input: AddProfileInput,
  ) => Effect.Effect<Profile, ProfileError | SessionError | StoreError>
  readonly remove: (id: string, removal?: Removal) => Effect.Effect<void, ProfileError | StoreError>
  readonly setDefault: (id: string) => Effect.Effect<void, ProfileError | StoreError>
  readonly status: (id: string) => Effect.Effect<ProfileStatus, ProfileError | StoreError>
  // The profile a session of the provider runs under: the one named, else the default, else the nameless login
  readonly resolve: (
    providerId: string,
    profileId: string | null | undefined,
  ) => Effect.Effect<ResolvedProfile, ProfileError | StoreError>
}
```

`packages/kernel/src/profiles/profile-keys.ts` (as shipped):

```ts
import { Effect } from 'effect'
import { toStoreError, type StoreError } from '../errors.js'
import type { SecretsShape } from '../secrets/secrets.js'

// The kernel's keys start with @bytebureau/, which no plugin name can: a plugin's are <plugin>/<key>, its name a kebab-case word
export const secretKeyOf = (profileId: string): string =>
  `@bytebureau/profiles/${profileId}/api_key`

// What to say of an api_key profile whose key has left the secret store
export const lostKeyReason = (profileId: string): string =>
  `the key of profile "${profileId}" is not in the secret store; remove the profile and add it again`

// A secret store that fails has failed like the store, not like the kernel
const readKey = (
  secrets: SecretsShape,
  profileId: string,
): Effect.Effect<string | undefined, StoreError> =>
  Effect.tryPromise({
    try: async () => {
      const value = await secrets.get(secretKeyOf(profileId))
      return value
    },
    catch: toStoreError,
  })

// The key of a profile as the secret store holds it; one that is gone, or empty, is none
export const usableKeyOf = (
  secrets: SecretsShape,
  profileId: string,
): Effect.Effect<string | undefined, StoreError> =>
  Effect.map(readKey(secrets, profileId), (value) => (value === '' ? undefined : value))

export const writeKey = (
  secrets: SecretsShape,
  profileId: string,
  value: string,
): Effect.Effect<void, StoreError> =>
  Effect.tryPromise({
    try: async () => {
      await secrets.set(secretKeyOf(profileId), value)
    },
    catch: toStoreError,
  })

export const dropKey = (
  secrets: SecretsShape,
  profileId: string,
): Effect.Effect<void, StoreError> =>
  Effect.tryPromise({
    try: async () => {
      await secrets.delete(secretKeyOf(profileId))
    },
    catch: toStoreError,
  })
```

`packages/kernel/src/profiles/profile-add.ts` (as shipped):

```ts
import { Effect } from 'effect'
import { ProfileError, type SessionError, type StoreError } from '../errors.js'
import { nowIso } from '../ids.js'
import { requireProvider } from '../sessions/session-provider.js'
import { ensureProfileDir, profileDirOf } from './profile-dirs.js'
import { isProfileName, profileIdOf } from './profile-ids.js'
import { writeKey } from './profile-keys.js'
import { claimProfile, defaultProfileOf, forgetProfile, markDefault } from './profile-records.js'
import type { AddProfileInput, Profile, ProfileDeps } from './profile-types.js'

const invalid = (reason: string): ProfileError => new ProfileError({ code: 'invalid', reason })

// What the name and the kind of a profile allow: a login has no key, an api_key profile has one and a provider that takes it
const refusalOf = (
  input: AddProfileInput,
  apiKeyEnv: string | undefined,
): ProfileError | undefined => {
  if (!isProfileName(input.name)) {
    return invalid(
      `"${input.name}" is not a profile name: lower-case letters, digits and dashes, 1 to 32 of them`,
    )
  }
  if (input.kind === 'login') {
    return input.apiKey === undefined ? undefined : invalid('a login profile takes no key')
  }
  if (apiKeyEnv === undefined) {
    return invalid(`provider "${input.providerId}" takes no API-key profile`)
  }
  return input.apiKey === undefined || input.apiKey === ''
    ? invalid('an api_key profile needs its key')
    : undefined
}

// What add refuses before anything is written; the id of the profile otherwise
const checkedId = (
  deps: ProfileDeps,
  input: AddProfileInput,
): Effect.Effect<string, ProfileError | SessionError> =>
  Effect.flatMap(requireProvider(deps.host, input.providerId), (provider) => {
    const refusal = refusalOf(input, provider.apiKeyEnv)
    return refusal === undefined
      ? Effect.succeed(profileIdOf(input.providerId, input.name))
      : Effect.fail(refusal)
  })

// What a profile keeps outside its row: the directory of a login, or the key of an api_key profile
const keep = (
  deps: ProfileDeps,
  profile: Profile,
  apiKey: string | undefined,
): Effect.Effect<void, StoreError> =>
  profile.configDir === null
    ? writeKey(deps.secrets, profile.id, apiKey ?? '')
    : ensureProfileDir(profile.configDir)

// The row claims the id first, so a second add of the profile neither overwrites its key nor shares its directory
// A profile whose key or directory cannot be kept is not added: its row goes again
const claim = (
  deps: ProfileDeps,
  profile: Profile,
  apiKey: string | undefined,
): Effect.Effect<void, ProfileError | StoreError> =>
  Effect.flatMap(
    claimProfile(deps.sql, profile),
    (claimed): Effect.Effect<void, ProfileError | StoreError> =>
      claimed
        ? keep(deps, profile, apiKey).pipe(
            Effect.tapError(() => Effect.ignore(forgetProfile(deps.sql, profile.id))),
          )
        : Effect.fail(
            new ProfileError({ code: 'exists', reason: `profile "${profile.id}" exists` }),
          ),
  )

// The first profile of a provider becomes its default, and makeDefault moves the default to the new one
export const addProfile = (
  deps: ProfileDeps,
  input: AddProfileInput,
): Effect.Effect<Profile, ProfileError | SessionError | StoreError> =>
  Effect.gen(function* addsProfile() {
    const id = yield* checkedId(deps, input)
    const first = (yield* defaultProfileOf(deps.sql, input.providerId)) === undefined
    const profile: Profile = {
      id,
      providerId: input.providerId,
      name: input.name,
      kind: input.kind,
      configDir:
        input.kind === 'login' ? profileDirOf(deps.home, input.providerId, input.name) : null,
      isDefault: first || input.makeDefault === true,
      createdAt: nowIso(),
    }
    yield* claim(deps, profile, input.apiKey)
    if (profile.isDefault) {
      yield* markDefault(deps.sql, profile.providerId, id)
    }
    const payload = { profileId: id, providerId: profile.providerId }
    yield* deps.log.publish({ type: 'profile.added', payload })
    return profile
  })
```

`packages/kernel/src/profiles/profile-remove.ts` (as shipped):

```ts
import { Effect } from 'effect'
import type { ProfileError, StoreError } from '../errors.js'
import { kernelLogger } from '../logging/logging.js'
import { removeProfileDir } from './profile-dirs.js'
import { dropKey, secretKeyOf } from './profile-keys.js'
import { deleteProfile } from './profile-records.js'
import type { Profile, ProfileDeps, Removal } from './profile-types.js'

const logger = kernelLogger(['bb', 'profiles'])

// What a removed profile leaves when it cannot be discarded is told, and the removal stands
const leftBehind =
  (message: string, left: Readonly<Record<string, string>>) =>
  (failure: StoreError): Effect.Effect<void> =>
    Effect.sync(() => {
      logger.warn(message, { ...left, reason: failure.message })
    })

// What the profile kept outside its row goes after it: its key, and its directory when it is purged
const discard = (deps: ProfileDeps, profile: Profile, removal: Removal): Effect.Effect<void> =>
  Effect.gen(function* discardsProfile() {
    if (profile.kind === 'api_key') {
      const key = secretKeyOf(profile.id)
      const told = leftBehind('a removed profile left its key in the secret store', {
        profileId: profile.id,
        key,
      })
      yield* dropKey(deps.secrets, profile.id).pipe(Effect.catchTag('StoreError', told))
    }
    if (removal.purge === true && profile.configDir !== null) {
      const directory = profile.configDir
      const told = leftBehind('a removed profile left its directory', {
        profileId: profile.id,
        directory,
      })
      yield* removeProfileDir(directory).pipe(Effect.catchTag('StoreError', told))
    }
  })

// The row goes, and the default with it to the next profile, in one transaction; the removal is told once that holds
export const removeProfile = (
  deps: ProfileDeps,
  id: string,
  removal: Removal = {},
): Effect.Effect<void, ProfileError | StoreError> =>
  Effect.gen(function* removesProfile() {
    const removed = yield* deleteProfile(deps.sql, id)
    yield* deps.log.publish({ type: 'profile.removed', payload: { profileId: id } })
    yield* discard(deps, removed, removal)
  })
```

`packages/kernel/src/profiles/profile-resolve.ts` (as shipped):

```ts
import { Effect } from 'effect'
import { ProfileError, type StoreError } from '../errors.js'
import { namelessRefOf } from './profile-ids.js'
import { lostKeyReason, usableKeyOf } from './profile-keys.js'
import { defaultProfileOf, requireProfile } from './profile-records.js'
import { refOf } from './profile-status.js'
import type { Profile, ProfileDeps, ResolvedProfile } from './profile-types.js'

const invalid = (reason: string): ProfileError => new ProfileError({ code: 'invalid', reason })

// The variable the provider of the profile takes a key in; a provider that is gone, or took it back, takes none
const keyEnvOf = (deps: ProfileDeps, profile: Profile): Effect.Effect<string, ProfileError> => {
  const provider = deps.host.agentProvider(profile.providerId)
  const env = provider === undefined ? undefined : provider.apiKeyEnv
  return env === undefined
    ? Effect.fail(invalid(`provider "${profile.providerId}" takes no API-key profile`))
    : Effect.succeed(env)
}

// The key of an api_key profile; one the secret store no longer holds refuses the profile
const keyOfProfile = (
  deps: ProfileDeps,
  profile: Profile,
): Effect.Effect<string, ProfileError | StoreError> =>
  Effect.flatMap(usableKeyOf(deps.secrets, profile.id), (value) =>
    value === undefined ? Effect.fail(invalid(lostKeyReason(profile.id))) : Effect.succeed(value),
  )

// A login profile travels as its ref alone; an api_key profile with its key, in the variable its provider declared
const resolved = (
  deps: ProfileDeps,
  profile: Profile,
): Effect.Effect<ResolvedProfile, ProfileError | StoreError> =>
  profile.kind === 'login'
    ? Effect.succeed({ ref: refOf(profile) })
    : Effect.map(
        Effect.all({ env: keyEnvOf(deps, profile), value: keyOfProfile(deps, profile) }),
        (apiKey) => ({ ref: refOf(profile), apiKey }),
      )

export const resolveProfile = (
  deps: ProfileDeps,
  providerId: string,
  profileId: string | null | undefined,
): Effect.Effect<ResolvedProfile, ProfileError | StoreError> =>
  Effect.gen(function* findsProfile() {
    if (profileId === null || profileId === undefined) {
      const fallback = yield* defaultProfileOf(deps.sql, providerId)
      return fallback === undefined
        ? { ref: namelessRefOf(providerId) }
        : yield* resolved(deps, fallback)
    }
    const profile = yield* requireProfile(deps.sql, profileId)
    if (profile.providerId !== providerId) {
      const reason = `profile "${profileId}" belongs to provider "${profile.providerId}", not "${providerId}"`
      return yield* invalid(reason)
    }
    return yield* resolved(deps, profile)
  })
```

`packages/kernel/src/profiles/profile-operations.ts` (as shipped):

```ts
import { addProfile } from './profile-add.js'
import { listProfiles, loadProfile, makeDefault } from './profile-records.js'
import { removeProfile } from './profile-remove.js'
import { resolveProfile } from './profile-resolve.js'
import { profileStatus } from './profile-status.js'
import type { ProfileDeps, ProfileServiceShape } from './profile-types.js'

// The operations of the service over what it works with
export const profileOperations = (deps: ProfileDeps): ProfileServiceShape => ({
  list: () => listProfiles(deps.sql),
  get: (id) => loadProfile(deps.sql, id),
  add: (input) => addProfile(deps, input),
  remove: (id, removal) => removeProfile(deps, id, removal),
  setDefault: (id) => makeDefault(deps.sql, id),
  status: (id) => profileStatus(deps, id),
  resolve: (providerId, profileId) => resolveProfile(deps, providerId, profileId),
})
```

`packages/kernel/src/facade/provider-areas.ts` (as shipped):

```ts
import type { PluginStatus } from '../plugins/plugin-host.js'
import type { AddProfileInput, Profile, ProfileStatus } from '../profiles/profile-service.js'

// What the plugins bring to the facade: their status, the agent providers they offer and the profiles those run under
export interface ProviderAreas {
  readonly profiles: {
    readonly list: () => Promise<readonly Profile[]>
    readonly get: (id: string) => Promise<Profile | undefined>
    // An unknown provider rejects with a SessionError provider_missing, as a session of it would
    readonly add: (input: AddProfileInput) => Promise<Profile>
    readonly remove: (id: string, options?: { readonly purge?: boolean }) => Promise<void>
    readonly setDefault: (id: string) => Promise<void>
    readonly status: (id: string) => Promise<ProfileStatus>
  }
  readonly providers: {
    readonly list: () => readonly {
      readonly id: string
      readonly displayName: string
      readonly supportsApiKey: boolean
    }[]
  }
  readonly plugins: { readonly list: () => readonly PluginStatus[] }
}
```

`packages/kernel/src/profiles/profile-fixtures.ts` (as shipped):

```ts
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Plugin } from '@bytebureau/plugin-api'
import { Effect, Layer } from 'effect'
import { ProfileError } from '../errors.js'
import { KernelTest } from '../kernel-test.js'
import { PluginHost } from '../plugins/plugin-host.js'
import type { SecretsShape } from '../secrets/secrets.js'
import { ProfileService, type ProfileServiceShape } from './profile-service.js'

// A kernel over an in-memory store and a home of its own, which is removed with the layer
export interface ProfileWorld {
  readonly home: string
  readonly layer: ReturnType<typeof KernelTest>
}

export const profileWorld = (
  plugins: readonly Plugin[] = [],
  secrets?: SecretsShape,
): ProfileWorld => {
  const created = mkdtempSync(path.join(tmpdir(), 'bb-home-'))
  const home = realpathSync(created)
  const removal = Layer.effectDiscard(
    Effect.addFinalizer(() =>
      Effect.sync(() => {
        rmSync(home, { recursive: true, force: true })
      }),
    ),
  )
  return {
    home,
    layer: KernelTest({ home, extraPlugins: plugins, secrets }).pipe(Layer.provideMerge(removal)),
  }
}

// The profile service once the plugins have loaded, so that their providers are known
export const loadedProfiles: Effect.Effect<
  ProfileServiceShape,
  never,
  PluginHost | ProfileService
> = Effect.gen(function* loadsProfiles() {
  yield* (yield* PluginHost).load()
  return yield* ProfileService
})

// What a refused attempt says: the code of a profile error, else the name of the error; one that succeeds fails the test
export const codeOf = <Value>(attempt: Effect.Effect<Value, Error>): Effect.Effect<string, Value> =>
  Effect.map(Effect.flip(attempt), (failure) =>
    failure instanceof ProfileError ? failure.code : failure.name,
  )
```

`packages/kernel/src/profiles/failing-fixtures.ts` (as shipped):

```ts
import {
  definePlugin,
  type AgentProvider,
  type AuthStatus,
  type Plugin,
} from '@bytebureau/plugin-api'
import { manifestOf, providerOf } from '../plugins/plugin-fixtures.js'
import { InMemorySecretStore } from '../secrets/in-memory-secret-store.js'
import type { SecretsShape } from '../secrets/secrets.js'

const failingStatus = async (): Promise<AuthStatus> => {
  await Promise.resolve()
  throw new Error('the account check failed')
}

// A provider whose account check throws, and which takes no API-key profile
export const doubtingPlugin: Plugin = definePlugin({
  manifest: manifestOf('doubting', { contributes: { agentProviders: ['doubting'] } }),
  setup: () => {
    const provider: AgentProvider = { ...providerOf('doubting'), authStatus: failingStatus }
    return { agentProviders: [provider] }
  },
})

const lockedStore = new InMemorySecretStore()

// A secret store that refuses to keep a secret, as a locked keychain would
export const refusingSecrets: SecretsShape = {
  backend: 'keychain',
  get: async (key) => {
    const value = await lockedStore.get(key)
    return value
  },
  set: async () => {
    await Promise.resolve()
    throw new Error('the keychain is locked')
  },
  delete: async (key) => {
    await lockedStore.delete(key)
  },
}

const stickyStore = new InMemorySecretStore()

// A secret store that keeps what it is given and refuses to let it go, as a file it cannot rewrite would
export const stickySecrets: SecretsShape = {
  backend: 'file',
  get: async (key) => {
    const value = await stickyStore.get(key)
    return value
  },
  set: async (key, value) => {
    await stickyStore.set(key, value)
  },
  delete: async () => {
    await Promise.resolve()
    throw new Error('the secrets file cannot be written')
  },
}
```

`packages/kernel/src/profiles/profile-sessions.test.ts` (as shipped):

```ts
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { sessionOf, startSession } from '../sessions/session-fixtures.js'
import { sessionLayer } from '../sessions/session-layer-fixtures.js'
import { SessionManager } from '../sessions/session-manager.js'
import { codeOf, loadedProfiles } from './profile-fixtures.js'

const IN_USE =
  'profile "fake/work" is in use: 1 session(s) still run under it or can resume; complete or remove them first'

// The repository of the session goes with the test, so the whole life of the session is one test
const heldUntilCompleted = Effect.gen(function* heldUntilCompleted() {
  const profiles = yield* loadedProfiles
  const sessions = yield* SessionManager
  yield* profiles.add({ providerId: 'fake', name: 'work', kind: 'login' })
  const session = yield* startSession({ profileId: 'fake/work' })
  const ready = yield* Effect.flip(profiles.remove('fake/work'))
  const stopped = yield* Effect.andThen(
    sessions.stop(session.id),
    codeOf(profiles.remove('fake/work')),
  )
  yield* Effect.andThen(sessions.resume(session.id), sessions.complete(session.id))
  yield* profiles.remove('fake/work')
  assert.deepStrictEqual(
    [ready.message, stopped, yield* profiles.list(), (yield* sessionOf(session.id)).profileId],
    [IN_USE, 'in_use', [], null],
  )
})

it.layer(sessionLayer())('ProfileService and the sessions that run under a profile', (suite) => {
  suite.effect(
    'holds a profile while its session runs or is stopped and can resume, and lets it go once the session is completed',
    () => heldUntilCompleted,
  )
})
```

`packages/kernel/src/sessions/session-profile.test.ts` (as shipped):

```ts
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ProviderError } from '../errors.js'
import { resolved } from '../plugins/plugin-call-fixtures.js'
import { loadedProfiles } from '../profiles/profile-fixtures.js'
import { Secrets } from '../secrets/secrets.js'
import { sessionOf, startSession } from './session-fixtures.js'
import { SessionManager } from './session-manager.js'
import { prompted } from './session-prompted-fixtures.js'
import { driven } from './session-script-fixtures.js'

const CANARY = 'sk-canary-start'
const KEY_ENV = 'SCRIPTED_API_KEY'
const SCRIPTED = { providerId: 'scripted' } as const
const CONFIG = {
  version: 1,
  project: { name: 'options' },
  employees: {
    developer: {
      name: 'Developer',
      provider: 'scripted',
      model: 'm',
      permissionMode: 'supervised',
    },
  },
  providers: { scripted: { passEnv: ['BB_PASSED'], flavour: 'slow', depth: 2 } },
}

const world = driven({ apiKeyEnv: KEY_ENV })

const handsKey = Effect.gen(function* handsKey() {
  const profiles = yield* loadedProfiles
  yield* profiles.add({ ...SCRIPTED, name: 'key', kind: 'api_key', apiKey: CANARY })
  const session = yield* startSession({ ...SCRIPTED, profileId: 'scripted/key' })
  const { request } = (yield* prompted(world, session)).agent
  assert.deepStrictEqual(
    [request.profile, request.env[KEY_ENV]],
    [{ id: 'scripted/key', providerId: 'scripted', kind: 'api_key' }, CANARY],
  )
})

const handsLogin = Effect.gen(function* handsLogin() {
  const profiles = yield* loadedProfiles
  const work = yield* profiles.add({ ...SCRIPTED, name: 'work', kind: 'login' })
  const session = yield* startSession({ ...SCRIPTED, profileId: work.id })
  const { request } = (yield* prompted(world, session)).agent
  assert.deepStrictEqual(
    [request.profile, request.env[KEY_ENV]],
    [
      { id: 'scripted/work', providerId: 'scripted', kind: 'login', configDir: work.configDir },
      undefined,
    ],
  )
})

const handsOptions = Effect.gen(function* handsOptions() {
  const configured = yield* startSession(SCRIPTED, CONFIG)
  const plain = yield* startSession(SCRIPTED)
  const first = (yield* prompted(world, configured)).agent.request
  const second = (yield* prompted(world, plain)).agent.request
  assert.deepStrictEqual(
    [first.providerConfig, second.providerConfig],
    [{ flavour: 'slow', depth: 2 }, {}],
  )
})

const refusesLostKey = Effect.gen(function* refusesLostKey() {
  const profiles = yield* loadedProfiles
  yield* profiles.add({ ...SCRIPTED, name: 'lost', kind: 'api_key', apiKey: CANARY })
  const session = yield* startSession({ ...SCRIPTED, profileId: 'scripted/lost' })
  yield* resolved((yield* Secrets).delete('@bytebureau/profiles/scripted/lost/api_key'))
  const error = yield* Effect.flip((yield* SessionManager).prompt(session.id, { text: 'go' }))
  assert.ok(error instanceof ProviderError)
  assert.deepStrictEqual(
    [error.kind, error.retryable, error.reason],
    [
      'auth',
      false,
      'the key of profile "scripted/lost" is not in the secret store; remove the profile and add it again',
    ],
  )
  assert.strictEqual((yield* sessionOf(session.id)).status, 'ready')
})

it.layer(world.layer)('SessionManager start under a profile', (suite) => {
  suite.effect(
    'hands the agent the ref of its api_key profile and the key in the variable of its provider',
    () => handsKey,
  )
  suite.effect(
    'hands the agent of a login profile its ref with the directory, and no key',
    () => handsLogin,
  )
  suite.effect(
    'hands the agent the providers section of its project without passEnv, and nothing without one',
    () => handsOptions,
  )
  suite.effect(
    'fails the prompt as an auth refusal when the key of its profile is gone, and leaves the session ready',
    () => refusesLostKey,
  )
})

const NAMELESS = { id: 'default', providerId: 'scripted', kind: 'login' }
const fixed = driven()

const staysNameless = Effect.gen(function* staysNameless() {
  const sessions = yield* SessionManager
  const session = yield* startSession(SCRIPTED)
  yield* (yield* loadedProfiles).add({ ...SCRIPTED, name: 'later', kind: 'login' })
  const first = (yield* prompted(fixed, session)).agent.request.profile
  yield* Effect.andThen(sessions.stop(session.id), sessions.resume(session.id))
  const second = (yield* prompted(fixed, session, { text: 'again' })).agent.request.profile
  assert.deepStrictEqual([session.profileId, first, second], [null, NAMELESS, NAMELESS])
})

it.layer(fixed.layer)('SessionManager start of a session created without a profile', (suite) => {
  suite.effect(
    'keeps it on the nameless login once its provider has a default, resumed or not',
    () => staysNameless,
  )
})
```

**Semantics (as shipped, commits 180f7fc, bc7e8c4, b14bce6, 052d675, 888d53e, 39970e0, d208f1a):** `ProfileService` (`bb/ProfileService`, `ProfileServiceLive({ home })`, joining `composeKernel` after the plugin host) keeps named auth profiles per provider in the `profiles` table: an id is `<providerId>/<name>` (the name `^[a-z0-9][a-z0-9-]{0,31}$`), a login profile owns the directory `<home>/profiles/<provider with ':' → '-'>/<name>` (0700 whatever the umask), an api_key profile owns the key `@bytebureau/profiles/<id>/api_key` in `Secrets` (the `@` keeps it outside the plugin-key grammar, so a plugin named `profiles` can neither read nor shadow it). `add` refuses an unknown provider as `SessionError provider_missing` (naming the available providers), a duplicate as `exists`, a bad name, a login with a key, an api_key without a key or with `''`, or an api_key for a provider without `apiKeyEnv` as `invalid`; it claims the row first (`INSERT … ON CONFLICT DO NOTHING RETURNING id`), then writes the key or makes the directory and deletes the row again when that fails, then marks the default in one statement (`is_default = (id = ?)` within the provider) — the first profile of a provider becomes its default and `makeDefault` moves it; `profile.added` is published. `remove` refuses with `in_use` while any session that can still resume refers to the profile (every status but `completed`; the message counts them and says to complete or remove them first); otherwise, in one transaction, it clears `profile_id` of the completed sessions (the foreign key would refuse the delete), deletes the row and passes the default to the oldest remaining profile of the provider; `profile.removed` is published once that commits, and the key and (with `purge`) the directory are discarded afterwards, best effort — a failed discard is logged as a warning naming what is left and does not undo the removal. `setDefault` moves the default within the profile's provider alone; `list()` orders by provider, then creation. `status` answers `not_found`; `loggedOut` with the hint "remove the profile and add it again" for an api_key profile whose key is not in the store and for a login profile whose directory is gone (the provider is asked for its hint only); otherwise the provider's `authStatus` decides (a throwing or unloaded provider is `unknown` with the reason as the hint); `profile.status` publishes the state only. `resolve(providerId, profileId)`: an explicit id must exist (`not_found`) and belong to the provider (`invalid`), `null` takes the provider's default, and no default is the nameless ref `{ id: 'default', providerId, kind: 'login' }`; an api_key profile whose key is gone, or whose provider no longer takes a key, is `invalid`. A session's profile is fixed at creation: `create` resolves it among its checks (after `requireProvider`, before anything is written) and stores the resolved id, `null` for the nameless ref — so a stored `null` means the nameless login for the session's whole life (the start builds that ref itself and never asks `resolve` for it) and a session created while a default existed keeps that default's id. The start builds the request effectfully: `profile: ref`, `env` gaining `[apiKey.env]: value` after the allowlist and the BYTEBUREAU_* extras, `providerConfig` = the project's `providers[providerId]` without `passEnv` (`{}` without a section); a `ProfileError` at the start becomes `ProviderError({ kind: 'auth', retryable: false })` and leaves the session `ready`; `prompt` can now fail with `ConfigError` (a project file broken since creation, 422 `config_invalid` through the API). The start of a provider session begins and installs its abandon handler inside one `Effect.uninterruptibleMask`, only the wait being interruptible (an abandoned start could leave the agent unclosed before). `Kernel.profiles = { list, get, add, remove, setDefault, status }` (promised). The fake agent announces `session.warning { kind: 'env', message: 'api key: present' | 'api key: absent' }` and one `raw { providerEvent: { providerConfig } }` before every `turn.started` (the kernel drops `raw`, so `providerConfig` is pinned through the scripted provider's recorded request and through the fake choosing its slow script from `flavour`). Key canaries in four tests: the key exists only in the secret store, the resolved `apiKey` and the agent's `env`. Heads-up for Task 4: `ProfileError` is not in `toProblem` yet (a refused creation answers 500 until Task 4 maps `not_found` 404, `exists` 409, `in_use` 409, `invalid` 422); the planned list test's order is creation order; the `profile.*` payloads' `profileId` becomes `Schema.String`. For Task 9: the user configuration's `profiles` section is reserved, documented there.

- [ ] **Step 6: Run the kernel suite and the gates**

Run: `bunx vitest run --project kernel && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (the fake's extra warning and raw event may require updating snapshot-like assertions in `session-events.test.ts`; adjust them to count the new events).

- [ ] **Step 7: Commit**

```bash
git add packages/kernel
git commit -m "feat(kernel): keep named auth profiles per provider, and run a session under its profile with the provider's options"
```

---

### Task 4: The API's `profiles` group, the per-profile usage snapshot, the problems, the client

**Files:**
- Create: `packages/api/src/groups/profiles.ts`, `packages/api/src/handlers/profiles.ts`, `packages/api/src/profiles.test.ts`, `packages/api/src/groups/resources.ts` and `packages/api/src/handlers/resources.ts` (the six resource groups and their layers gathered, as `api.ts` and `handlers/all.ts` were at the 10-dependency cap)
- Modify: `packages/protocol/src/events.ts` (`profile.added|removed|status` carry `profileId` as `Schema.String`, `ratelimit.updated` as `Schema.NullOr(Schema.String)`) with `packages/protocol/schemas/events.json` regenerated, `packages/protocol/src/api/rpc.ts` (`profiles.list|add|remove|setDefault|status`, `usage.profile`), `packages/api/src/api.ts` and `packages/api/src/handlers/all.ts` (through the resources files), `packages/api/src/groups/usage.ts` and `packages/api/src/handlers/usage.ts` (`GET /usage/profiles/:id`, `profileUsageOf`), `packages/api/src/problems.ts` (`PROFILE_STATUS`, the `ProfileError` branch in `toProblemOfRest`), `packages/api/src/rpc/handlers.ts`, `packages/api/openapi.json` and `packages/client/src/gen/**` (regenerated), `packages/client/src/index.ts` (`profiles` area, `usage.profile`, `RemoveProfileOptions`), `packages/client/src/sse-fixture.ts` (records method, raw target and body), `apps/bytebureau/src/testing/{recording-client,records}.ts` (stubs for the new client calls), `cspell.json` (percent escapes are no words); tests `packages/api/src/{sessions,rpc,problems,openapi,client}.test.ts`, `packages/client/src/http.test.ts`, `packages/protocol/src/{events,json-schema}.test.ts`, `packages/protocol/src/api/rpc.test.ts`
- Test: the new `profiles.test.ts` over `ApiTestLayer`

**Interfaces:**
- Consumes: Task 1's DTOs and body; Task 3's `ProfileService`, `ProfileError`; Phase B's `Authorization`, `RequestValidation`, `orProblem`, `found`, `KERNEL_STATUSES`, `ApiTestLayer`, `authorized`, `get/post/remove`.
- Produces: endpoints `GET /api/v1/profiles` → `ProfileDto[]`; `POST /api/v1/profiles` (`AddProfileBody`) → 201 `ProfileDto`, 409 `profile_exists`, 422 `profile_invalid` | `session_provider_missing`; `DELETE /api/v1/profiles/:id?purge=true` → 204, 404 `profile_not_found`, 409 `profile_in_use`; `POST /api/v1/profiles/:id/default` → 204, 404; `GET /api/v1/profiles/:id/status` → `ProfileStatusDto`, 404; `GET /api/v1/usage/profiles/:id` → `UsageSnapshotDto` (404 for an unknown profile; `observedAt: null` and an empty `rateLimit` when no snapshot was recorded); `ProviderDto.supportsApiKey`; the client areas `profiles.{list, add(body), remove(id, { purge? }), setDefault(id), status(id)}` and `usage.profile(id)`; RPC procedures of the same names.

Heads-up from Task 3 (as shipped): `ProfileService` has `get(id)` too; `list()` is in creation order per provider; `ProfileError` reaches the API as a 500 until this task's `toProblem` branch lands; a session created with a profile that does not exist fails `create` with `ProfileError not_found`, one of another provider with `invalid`, so `sessions.test.ts` gains those two refusals (404 `profile_not_found`, 422 `profile_invalid`); `prompt` can fail with `ConfigError` (422 `config_invalid`, mapped already). The removal of a profile is refused with `in_use` while any session of a status other than `completed` refers to it (`profile "<id>" is in use: <n> session(s) still run under it or can resume; complete or remove them first`), so the `in_use` test completes its session (`sessions.complete`) before the removal succeeds.

- [ ] **Step 1: The failing API tests**

`packages/api/src/profiles.test.ts` (style of `sessions.test.ts`; the fake provider takes API-key profiles):

```ts
import { existsSync } from 'node:fs'
import { UsageService } from '@bytebureau/kernel'
import { ProfileDto, SessionDto, UsageSnapshotDto } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect, Schema, type Cause } from 'effect'
import type { HttpServer } from 'effect/http'
import { ApiTestLayer, get, post, remove, type Reply } from './testing.js'
import { registeredProject } from './testing-sessions.js'

// A key no answer, problem or listing may repeat
const CANARY = 'sk-canary-api'

const LOGIN = { providerId: 'fake', name: 'work', kind: 'login' } as const
const KEYED = { providerId: 'fake', name: 'key', kind: 'api_key', apiKey: CANARY } as const

const profilesOf = (reply: Reply): readonly ProfileDto[] =>
  Schema.decodeUnknownSync(Schema.Array(ProfileDto))(reply.body)

// Which profile is the default of its provider, in the order the API lists them
const defaultsOf = (reply: Reply): [string, boolean][] =>
  profilesOf(reply).map((profile) => [profile.id, profile.isDefault])

// The profiles added through the API in turn, each of which has to be created
const added = (...bodies: readonly object[]): Effect.Effect<void, never, HttpServer.HttpServer> =>
  Effect.gen(function* addsAll() {
    for (const body of bodies) {
      const created = yield* post('/profiles', body)
      assert.strictEqual(created.status, 201, JSON.stringify(created.body))
    }
  })

// The login directory of a profile of a listing
const directoryOf = (listed: Reply, id: string): Effect.Effect<string, Cause.NoSuchElementError> =>
  Effect.fromNullishOr(profilesOf(listed).find((profile) => profile.id === id)).pipe(
    Effect.flatMap((profile) => Effect.fromNullishOr(profile.configDir)),
  )

// A session of the fake provider created under the profile
const sessionUnder = (profileId: string): Effect.Effect<SessionDto, never, HttpServer.HttpServer> =>
  Effect.gen(function* creates() {
    const { project } = yield* registeredProject
    const body = { projectId: project.id, title: 'Under a profile', profileId }
    const created = yield* post('/sessions', body)
    assert.strictEqual(created.status, 201, JSON.stringify(created.body))
    return Schema.decodeUnknownSync(SessionDto)(created.body)
  })

interface Refusal {
  readonly title: string
  readonly body: Record<string, unknown>
  readonly status: number
  readonly code: string
}

// What the profiles of the API refuse to add, with the status and the code each is told with
const REFUSALS: Refusal[] = [
  { title: 'a duplicate', body: LOGIN, status: 409, code: 'profile_exists' },
  {
    title: 'a key for a login profile',
    body: { ...LOGIN, name: 'l', apiKey: CANARY },
    status: 422,
    code: 'profile_invalid',
  },
  {
    title: 'an API-key profile with an empty key',
    body: { ...KEYED, name: 'e', apiKey: '' },
    status: 422,
    code: 'profile_invalid',
  },
  {
    title: 'a provider nobody offers',
    body: { providerId: 'ghost', name: 'g', kind: 'login' },
    status: 422,
    code: 'session_provider_missing',
  },
  {
    title: 'a name that is no profile name, with a key',
    body: { ...KEYED, name: 'Not A Name' },
    status: 400,
    code: 'request_invalid',
  },
  {
    title: 'a kind that is no kind, with a key',
    body: { ...KEYED, name: 'k', kind: 'oauth' },
    status: 400,
    code: 'request_invalid',
  },
]

it.layer(ApiTestLayer())('POST and GET /api/v1/profiles', (suite) => {
  suite.effect(
    'adds a login and an API-key profile, lists them in the order they were added, and never echoes a key',
    () =>
      Effect.gen(function* adds() {
        const login = yield* post('/profiles', LOGIN)
        assert.include(login.type, 'application/json')
        const created = { id: 'fake/work', kind: 'login', isDefault: true }
        assert.containSubset(login, { status: 201, body: created })
        const keyed = yield* post('/profiles', KEYED)
        const expected = { id: 'fake/key', kind: 'api_key', configDir: null, isDefault: false }
        assert.containSubset(keyed, { status: 201, body: expected })
        const listed = yield* get('/profiles')
        assert.deepStrictEqual(defaultsOf(listed), [
          ['fake/work', true],
          ['fake/key', false],
        ])
        assert.notInclude(JSON.stringify([keyed.body, listed.body]), CANARY)
      }),
  )
})

it.layer(ApiTestLayer())('the refusals of POST /api/v1/profiles', (suite) => {
  suite.effect.each(REFUSALS)('refuses $title with $status $code and keeps nothing', (refusal) =>
    Effect.gen(function* refuses() {
      yield* post('/profiles', LOGIN)
      const refused = yield* post('/profiles', refusal.body)
      assert.strictEqual(refused.status, refusal.status)
      assert.include(refused.type, 'application/problem+json')
      assert.containSubset(refused.body, { code: refusal.code })
      assert.notInclude(JSON.stringify(refused.body), CANARY)
      const listed = yield* get('/profiles')
      assert.deepStrictEqual(defaultsOf(listed), [['fake/work', true]])
    }),
  )
})

it.layer(ApiTestLayer())('POST /api/v1/profiles/:id/default', (suite) => {
  suite.effect('moves the default of the provider to a profile named by its encoded id', () =>
    Effect.gen(function* movesDefault() {
      yield* added(LOGIN, KEYED)
      const moved = yield* post('/profiles/fake%2Fkey/default')
      assert.strictEqual(moved.status, 204)
      assert.deepStrictEqual(defaultsOf(yield* get('/profiles')), [
        ['fake/work', false],
        ['fake/key', true],
      ])
    }),
  )
})

it.layer(ApiTestLayer())('GET /api/v1/profiles/:id/status', (suite) => {
  suite.effect('tells the status of a login profile and of an API-key profile', () =>
    Effect.gen(function* tellsStatus() {
      yield* added(LOGIN, KEYED)
      const login = yield* get('/profiles/fake%2Fwork/status')
      assert.strictEqual(login.status, 200)
      assert.containSubset(login.body, { profileId: 'fake/work', state: 'loggedIn' })
      const keyed = yield* get('/profiles/fake%2Fkey/status')
      assert.containSubset(keyed.body, { profileId: 'fake/key', state: 'loggedIn' })
      assert.notInclude(JSON.stringify([login.body, keyed.body]), CANARY)
    }),
  )
})

it.layer(ApiTestLayer())('the endpoints of a profile nobody holds', (suite) => {
  suite.effect('answer 404 profile_not_found, whatever is asked of the profile', () =>
    Effect.gen(function* refusesUnknown() {
      const replies = yield* Effect.all([
        post('/profiles/fake%2Fnope/default'),
        get('/profiles/fake%2Fnope/status'),
        remove('/profiles/fake%2Fnope'),
      ])
      assert.deepStrictEqual(
        replies.map((reply) => reply.status),
        [404, 404, 404],
      )
      const decoded = { code: 'profile_not_found', detail: 'no profile "fake/nope"' }
      for (const reply of replies) {
        assert.include(reply.type, 'application/problem+json')
        assert.containSubset(reply.body, decoded)
      }
      const acp = yield* get('/profiles/acp%3Agemini%2Fwork/status')
      assert.containSubset(acp.body, { detail: 'no profile "acp:gemini/work"' })
    }),
  )
})

it.layer(ApiTestLayer())('DELETE /api/v1/profiles/:id', (suite) => {
  suite.effect('removes a profile no session runs under, and the default passes to the next', () =>
    Effect.gen(function* removes() {
      yield* added(LOGIN, KEYED)
      assert.strictEqual((yield* remove('/profiles/fake%2Fwork')).status, 204)
      assert.deepStrictEqual(defaultsOf(yield* get('/profiles')), [['fake/key', true]])
      const gone = yield* get('/profiles/fake%2Fwork/status')
      assert.strictEqual(gone.status, 404)
      assert.containSubset(gone.body, { code: 'profile_not_found' })
    }),
  )
})

it.layer(ApiTestLayer())('DELETE /api/v1/profiles/:id with a purge', (suite) => {
  suite.effect('takes the login directory of a profile only when asked to purge it', () =>
    Effect.gen(function* purges() {
      yield* added({ ...LOGIN, name: 'kept' }, { ...LOGIN, name: 'purged' })
      const listed = yield* get('/profiles')
      const kept = yield* directoryOf(listed, 'fake/kept')
      const purged = yield* directoryOf(listed, 'fake/purged')
      assert.deepStrictEqual([existsSync(kept), existsSync(purged)], [true, true])
      assert.strictEqual((yield* remove('/profiles/fake%2Fkept?purge=false')).status, 204)
      assert.strictEqual((yield* remove('/profiles/fake%2Fpurged?purge=true')).status, 204)
      assert.deepStrictEqual([existsSync(kept), existsSync(purged)], [true, false])
    }),
  )

  suite.effect('refuses a purge that is neither true nor false with 400, and removes nothing', () =>
    Effect.gen(function* refusesPurge() {
      yield* added({ ...LOGIN, name: 'stays' })
      const refused = yield* remove('/profiles/fake%2Fstays?purge=maybe')
      assert.strictEqual(refused.status, 400)
      assert.containSubset(refused.body, { code: 'request_invalid' })
      const listed = yield* get('/profiles')
      assert.include(
        profilesOf(listed).map((profile) => profile.id),
        'fake/stays',
      )
    }),
  )
})

it.layer(ApiTestLayer())('DELETE /api/v1/profiles/:id under a session', (suite) => {
  suite.effect('refuses to remove the profile of a session that has not ended, with 409', () =>
    Effect.gen(function* refusesBusy() {
      yield* added(LOGIN)
      const session = yield* sessionUnder('fake/work')
      assert.strictEqual(session.profileId, 'fake/work')
      const busy = yield* remove('/profiles/fake%2Fwork')
      assert.strictEqual(busy.status, 409)
      assert.containSubset(busy.body, { code: 'profile_in_use' })
      assert.strictEqual((yield* post(`/sessions/${session.id}/complete`)).status, 204)
      assert.strictEqual((yield* remove('/profiles/fake%2Fwork')).status, 204)
      const ended = yield* get(`/sessions/${session.id}`)
      assert.containSubset(ended.body, { status: 'completed', profileId: null })
    }),
  )
})

const SEEN = { fiveHourPct: 80, sevenDayPct: 12 }

it.layer(ApiTestLayer())('GET /api/v1/usage/profiles/:id', (suite) => {
  suite.effect(
    'answers an empty snapshot before any rate limit was seen, and 404 for an unknown profile',
    () =>
      Effect.gen(function* readsEmpty() {
        yield* added(LOGIN)
        const empty = yield* get('/usage/profiles/fake%2Fwork')
        assert.strictEqual(empty.status, 200)
        assert.deepStrictEqual(empty.body, {
          profileId: 'fake/work',
          rateLimit: {},
          observedAt: null,
        })
        const missing = yield* get('/usage/profiles/fake%2Fnope')
        assert.strictEqual(missing.status, 404)
        assert.containSubset(missing.body, { code: 'profile_not_found' })
      }),
  )

  suite.effect('answers the newest rate limit the kernel recorded under the profile', () =>
    Effect.gen(function* readsRecorded() {
      yield* added({ ...LOGIN, name: 'seen' })
      yield* UsageService.use((usage) => usage.record('fake/seen', { fiveHourPct: 40 }))
      yield* UsageService.use((usage) => usage.record('fake/seen', SEEN))
      const snapshot = yield* get('/usage/profiles/fake%2Fseen')
      const decoded = Schema.decodeUnknownSync(UsageSnapshotDto)(snapshot.body)
      assert.deepStrictEqual([decoded.profileId, decoded.rateLimit], ['fake/seen', SEEN])
      assert.isString(decoded.observedAt)
    }),
  )
})
```

(Ruled after Task 1: a profile id stays one path segment and travels percent-encoded: `fake%2Fwork`; verify that the generated client encodes path params (hey-api's `buildUrl`) and, if it does not, encode the id in the client's `profiles` area. In this task `AddProfileBody.apiKey` also gains a minimum length of 1 (`Schema.String.check(Schema.isMinLength(1))` or the form `requests.ts` uses), regenerated with the group. The `found`/path decoding of `effect/http-api` gives the handler the decoded `id`; assert so in the first test by reading the status of `fake%2Fwork`. If the platform rejects an encoded slash in a path segment, switch the routes to `/profiles/by/:providerId/:name` and say so in the report — the client hides the shape either way.)

Also: `workspaces-plugins.test.ts` already asserts `supportsApiKey: true` for `fake` (Task 1); `rpc.test.ts`'s "every procedure" test reaches `profiles.list`, `profiles.add`, `profiles.setDefault`, `profiles.status`, `profiles.remove`, `usage.profile`; `openapi.test.ts`'s drift test will fail until the document is regenerated.

- [ ] **Step 2: Run the tests to see them fail**

Run: `bunx vitest run --project api`
Expected: FAIL — 404 on `/profiles`; the drift test fails after the contract change.

- [ ] **Step 3: Group, handlers, problems**

`packages/api/src/groups/profiles.ts`:

```ts
import {
  AddProfileBody,
  ProfileDto,
  ProfileIdParam,
  ProfileStatusDto,
  RemoveProfileQuery,
} from '@bytebureau/protocol'
import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api'
import { Authorization } from '../auth.js'
import { PROBLEM_SCHEMAS } from '../problems.js'
import { MutationLimit } from '../rate-limit.js'
import { RequestValidation } from '../validation.js'

// The status is an annotation, and an annotated schema is a copy of its own; a suspended one keeps naming the one component of the OpenAPI document
const Created = Schema.suspend(() => ProfileDto).pipe(HttpApiSchema.status(201))

// A profile id is <provider>/<name>: it travels as one path segment, percent-encoded
export const ProfilesGroup = HttpApiGroup.make('profiles')
  .add(
    HttpApiEndpoint.get('list', '/profiles', {
      success: Schema.Array(ProfileDto),
      error: PROBLEM_SCHEMAS,
    }),
    HttpApiEndpoint.post('add', '/profiles', {
      payload: AddProfileBody,
      success: Created,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
    HttpApiEndpoint.delete('remove', '/profiles/:id', {
      params: ProfileIdParam,
      query: RemoveProfileQuery,
      success: HttpApiSchema.NoContent,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
    HttpApiEndpoint.post('setDefault', '/profiles/:id/default', {
      params: ProfileIdParam,
      success: HttpApiSchema.NoContent,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
    HttpApiEndpoint.get('status', '/profiles/:id/status', {
      params: ProfileIdParam,
      success: ProfileStatusDto,
      error: PROBLEM_SCHEMAS,
    }),
  )
  .middleware(Authorization)
  .middleware(RequestValidation)
```

(Follow the exact `HttpApiEndpoint` option names Phase B's groups use — `sessions.ts` has `params`, `payload`, `success`, `error`; the 201 wrapping is the `Schema.suspend(() => Dto)` trick of Task 4 of Phase B when the document would duplicate `Profile`.)

`packages/api/src/handlers/profiles.ts`:

```ts
import { ProfileService } from '@bytebureau/kernel'
import { HttpApiBuilder } from 'effect/http-api'
import { BureauApi } from '../api.js'
import { orProblem } from '../problems.js'

export const ProfilesHandlers = HttpApiBuilder.group(BureauApi, 'profiles', (handlers) =>
  handlers
    .handle('list', () => orProblem(ProfileService.use((profiles) => profiles.list())))
    .handle('add', ({ payload }) =>
      orProblem(ProfileService.use((profiles) => profiles.add(payload))),
    )
    .handle('remove', ({ params, query }) =>
      orProblem(
        ProfileService.use((profiles) =>
          profiles.remove(params.id, { purge: query.purge === 'true' }),
        ),
      ),
    )
    .handle('setDefault', ({ params }) =>
      orProblem(ProfileService.use((profiles) => profiles.setDefault(params.id))),
    )
    .handle('status', ({ params }) =>
      orProblem(ProfileService.use((profiles) => profiles.status(params.id))),
    ),
)
```

`packages/api/src/problems.ts`: `const PROFILE_STATUS: Readonly<Record<ProfileError['code'], KernelStatus>> = { not_found: 404, exists: 409, in_use: 409, invalid: 422 }` and the `toProblem` branch for `ProfileError` with `code: \`profile_${error.code}\`` and the error's reason as `detail` (through the existing redaction). `groups/usage.ts`: `HttpApiEndpoint.get('profile', '/usage/profiles/:id', { params: ProfileIdParam, success: UsageSnapshotDto, error: [Problem404] })`; `handlers/usage.ts`: `ProfileService.use(profiles => profiles.status …)` is NOT what it needs — it asks `records`: load the profile through `ProfileService.use((profiles) => profiles.list())`? Cheaper: `ProfileService` gains nothing; the handler calls `UsageService.use((usage) => usage.snapshot(id))` after `found(ProfileService.use((profiles) => profiles.get(id)))` — so add `get(id): Effect<Profile | undefined, StoreError>` to `ProfileServiceShape` (and the facade) in this task; an undefined snapshot becomes `{ profileId: id, rateLimit: {}, observedAt: null }`. `handlers/plugins.ts`: `supportsApiKey: provider.apiKeyEnv !== undefined`. `api.ts`: add `ProfilesGroup` after `ProjectsGroup`. `protocol/src/api/rpc.ts`: `profiles.list` (success `Schema.Array(ProfileDto)`), `profiles.add` (payload `AddProfileBody`, success `ProfileDto`, error Problem), `profiles.remove` (payload `{ id, purge? }`), `profiles.setDefault` (`{ id }`), `profiles.status` (`{ id }` → `ProfileStatusDto`), `usage.profile` (`{ id }` → `UsageSnapshotDto`); `RPC_TAGS` extended; `rpc/handlers.ts` implements them through the same services (mutations under the shared budget).

- [ ] **Step 4: Regenerate the contract and the client**

Run: `bun run --cwd packages/api build && bun run generate:client && git status --short`
Expected: `packages/api/openapi.json` and `packages/client/src/gen/*` changed; no untracked file left behind (the drift step of CI checks both).

`packages/client/src/index.ts`: `profiles: { list, add, remove(id, options?: { purge?: boolean }), setDefault, status }` through the generated `profilesList`, `profilesAdd`, `profilesRemove`, `profilesSetDefault`, `profilesStatus`, and `usage.profile(id)` through `usageProfile` (the generated names follow the operation ids — read `sdk.gen.ts` for the exact ones). `http.test.ts` gains one test that `profiles.add` posts the body and `profiles.remove(id, { purge: true })` sends `?purge=true` with the id percent-encoded.

**Added files (as shipped):**

`packages/api/src/groups/resources.ts` (as shipped):

```ts
import { AsksGroup } from './asks.js'
import { ProfilesGroup } from './profiles.js'
import { ProjectsGroup } from './projects.js'
import { SessionsGroup } from './sessions.js'
import { UsageGroup } from './usage.js'
import { WorkspacesGroup } from './workspaces.js'

// The groups of what the daemon keeps: projects, profiles, sessions, asks, their usage and their worktrees
export const RESOURCE_GROUPS = [
  ProjectsGroup,
  ProfilesGroup,
  SessionsGroup,
  AsksGroup,
  UsageGroup,
  WorkspacesGroup,
] as const
```

`packages/api/src/handlers/resources.ts` (as shipped):

```ts
import { Layer } from 'effect'
import { AsksHandlers } from './asks.js'
import { ProfilesHandlers } from './profiles.js'
import { ProjectsHandlers } from './projects.js'
import { SessionsHandlers } from './sessions.js'
import { UsageHandlers } from './usage.js'
import { WorkspacesHandlers } from './workspaces.js'

// The handler layers of the groups in RESOURCE_GROUPS
export const ResourceHandlers = Layer.mergeAll(
  ProjectsHandlers,
  ProfilesHandlers,
  SessionsHandlers,
  AsksHandlers,
  UsageHandlers,
  WorkspacesHandlers,
)
```

**Semantics (as shipped, commits be3ca90, 596dcf1, 1c7adfc):** The protocol's `profile.added|removed|status` payloads carry `profileId` as `Schema.String` and `ratelimit.updated` as `Schema.NullOr(Schema.String)` — a profile id is `<provider>/<name>` — and the regenerated `events.json` no longer calls them `UUIDv7` (nothing decodes differently; the pin is on the published schema). REST: `groups/profiles.ts` serves `GET /profiles` (creation order per provider), `POST /profiles` (201 `ProfileDto`; `AddProfileBody.apiKey` stays a plain string, an empty key being the kernel's 422 `profile_invalid`), `DELETE /profiles/:id?purge=true|false` (`query.purge === 'true'`; `?purge=maybe` is 400), `POST /profiles/:id/default` and `GET /profiles/:id/status`; `GET /usage/profiles/:id` answers `UsageSnapshotDto` through `profileUsageOf(id)` in `handlers/usage.ts` (`ProfileService.get` → 404 `profile_not_found`; an unseen profile is `{ profileId, rateLimit: {}, observedAt: null }`), which RPC shares. Every endpoint declares `PROBLEM_SCHEMAS` as Phase B's groups do, the three mutations carry `MutationLimit`, the 201 uses the `Schema.suspend` form; the six resource groups are gathered in `groups/resources.ts` (`RESOURCE_GROUPS`, a `const` tuple in path order) and their layers in `handlers/resources.ts`. Problems: `PROFILE_STATUS` (`not_found` 404, `exists` 409, `in_use` 409, `invalid` 422 — an exhaustive record, so a new kernel code fails the type-check instead of answering 500) in a `toProblemOfRest` branch, the kernel's reason as the detail through the redacting `problem()`; so `POST /sessions` with an unknown profile answers 404 and with another provider's 422. RPC: `profiles.list` (no payload — `null` on the wire; `undefined` fails with "Expected null"), `profiles.add`, `profiles.remove { id, purge? }`, `profiles.setDefault`, `profiles.status`, `usage.profile`; reads over RPC keep drawing from the shared budget, as `daemon-and-api.md` says. Client: `profiles.{list, add(body), remove(id, { purge? }), setDefault(id), status(id)}`, `usage.profile(id)`, `RemoveProfileOptions`; `status` and `usage.profile` throw the problem as an `ApiError`, `remove` and `setDefault` are `done`; hey-api's generated runtime percent-encodes path parameters, so the area does not (`fake/work` travels as `fake%2Fwork` — proven on the raw request target in `http.test.ts` — and reaches the handler decoded, `acp%3Agemini%2Fwork` as `acp:gemini/work`). `cspell.json` ignores percent escapes (`/%[0-9A-Fa-f]{2}/g`); the CLI's `recording-client.ts` and `records.ts` hold stubs for the new client calls, which Task 5 extends. Tests over `ApiTestLayer` (in-memory secrets, never the keychain): `profiles.test.ts` (16 tests, one layer each — creation with the canary out of every answer, six refusals leaving the list untouched, `fake%2Fkey/default`, purge checked on disk, `in_use` 409 then `POST /sessions/:id/complete` then 204 with the session's `profileId` null, the usage snapshot empty, 404 and newest), `sessions.test.ts` (404 and 422), `rpc.test.ts` (every procedure over the socket, a kernel and a schema refusal without the key), `problems.test.ts`, `openapi.test.ts`, `client.test.ts`, the protocol tests; by hand once, a Bun daemon on a scratch home with the file backend served every route with `fake%2Fwork` (the automated runs are on Node; Task 5's CLI tests over a Bun daemon are the first automated Bun coverage). Deferred to the final wave: `payload ?? null` in the client's RPC connection; `profile.status` as an ephemeral event type (a status probe must not grow the durable log); `GET /usage/profiles/default` for the nameless login's snapshot; `profileUsageOf` into `handlers/found.ts`; the `usage.profile` unknown-id refusal over RPC in a new `rpc-profiles.test.ts`; `client.test.ts` asserting the directory gone and the canary absent. For Task 5: `Bureau.profiles.*` maps one to one onto the client; 404, 409 and 422 arrive as `ApiError` with `problem.code` (`profile_not_found`, `profile_in_use` with the kernel's text naming completion as the way out, `profile_exists`, `profile_invalid`); the key travels only in the body of `profiles.add`.

- [ ] **Step 5: Run the api and client suites and the gates**

Run: `bunx vitest run --project api --project client --project protocol && bun run typecheck && bun run lint && bun run format:check && bun run knip`
Expected: PASS, including the OpenAPI drift test and the RPC "every procedure" test.

- [ ] **Step 6: Commit**

```bash
git add packages/api packages/protocol/src/api/rpc.ts packages/client
git commit -m "feat(api): serve the profiles of the daemon and the usage snapshot of a profile, over REST and RPC"
git commit -m "feat(client): add the profiles area and the usage snapshot of a profile"
```

---

### Task 5: The CLI — `profiles ls|add|rm|use|status`, `run --profile`, the Bureau, the messages, the key canary

**Files:**
- Create: `apps/bytebureau/src/commands/profiles.ts`, `apps/bytebureau/src/commands/profiles-add.ts`, `apps/bytebureau/src/commands/api-key-input.ts`, `apps/bytebureau/src/commands/api-key-input.test.ts`, `apps/bytebureau/src/commands/profiles.test.ts`, `apps/bytebureau/src/commands/profiles-canary.test.ts`
- Modify: `apps/bytebureau/src/bureau/bureau.ts` (`profiles` area, `usage.profile`), `apps/bytebureau/src/bureau/local.ts`, `apps/bytebureau/src/bureau/remote.ts`, `apps/bytebureau/src/bureau/remote.test.ts`, `apps/bytebureau/src/testing/scripted-kernel.ts`, `apps/bytebureau/src/testing/recording-client.ts`, `apps/bytebureau/src/commands/run.ts` (`--profile`), `apps/bytebureau/src/commands/run-session.ts` (`profileId` in the body, `RunOptions.profile`), `apps/bytebureau/src/commands/sub-commands.ts`, `apps/bytebureau/src/render/rows.ts` (`profileRows`, `profileStatusRows`), `apps/bytebureau/src/commands/sessions.ts` (`sessions show` prints the profile; `sessions complete <id>` joins `interrupt|stop|resume` in `steer`, with the message `sessions_completed` — "Completed {id}" / "Dokončeno {id}" — as the way out of `profile_in_use`, ruled after Task 3), `packages/i18n/messages/{en,cs}.json`, `vitest.config.ts` (coverage include for `commands/api-key-input.ts`, `commands/profiles-add.ts`)
- Test: the new test files (the daemon-backed ones on `testHome()`, whose daemons use the file backend)

**Interfaces:**
- Consumes: Task 4's client areas (`profiles.list/add/remove/setDefault/status`, `usage.profile`), `ProfileDto`, `ProfileStatusDto`; Phase B's `withBureauRefusable`, `bureauFlags`, `processContext`, `table`, `flat`, `Context.output.{emit,print,warn}`, `promptAsk`'s clack usage in `render/ask-prompt.ts` (for the password prompt and the confirm), `Context.stdoutIsTTY`, the `refusable` exit-1 shape, the i18n `m.*` functions.
- Produces: commands `profiles ls` (table `id  provider  kind  default  dir`; `profiles_none` when empty; `--json` → `{ command: 'profiles.ls', profiles }`), `profiles add <provider> <name> [--api-key] [--default]` (`--api-key` reads the key — at a TTY through a hidden clack prompt (`profiles_key_prompt`), without one from the first line of stdin; an empty key is the refusal `profiles_key_missing`, exit 1; the key is never an argument), `profiles rm <id> [--purge]`, `profiles use <id>`, `profiles status [<id>]` (one profile or all; table `id  state  account  hint`; `--json` → `{ command: 'profiles.status', statuses }`); `run --profile <id>` → `CreateSessionBody.profileId`; `Bureau.profiles` with the same five calls and `Bureau.usage.profile(id)`; messages `profiles_none`, `profiles_added`, `profiles_added_login` ("Profile {id} added. Log in with: {hint}" / "Profil {id} přidán. Přihlaste se příkazem: {hint}"), `profiles_wait_login` ("Press Enter once you have logged in" / "Až budete přihlášeni, stiskněte Enter"), `profiles_removed`, `profiles_default_set`, `profiles_key_prompt` ("API key for {id}" / "API klíč pro {id}"), `profiles_key_missing` ("--api-key needs a key: type it at the prompt or pipe it on stdin" / "--api-key potřebuje klíč: zadejte ho na výzvu nebo pošlete na stdin"), `profiles_status_none` ("No profiles to check" / "Žádné profily ke kontrole"), `profiles_default_marker` ("default" / "výchozí").; `sessions complete <id>` (one request, one line: `Completed <id>`; `--json` → `{ command: 'sessions.complete', id }`)

Semantics: `profiles add claude work` creates a `login` profile and prints the login hint the daemon's status returns for it (the Claude adapter's `CLAUDE_CONFIG_DIR=<dir> claude /login`); at a TTY without `--yes` it then waits for Enter (`profiles_wait_login`) and prints the status it finds; without a TTY or with `--yes` it prints the hint and ends. `profiles add acp:codex key --api-key` reads the key and sends it in the body over the loopback connection; the body is the only place the key travels, and the kernel stores it in the secret store. Refusals (`profile_exists`, `profile_invalid`, `profile_in_use`, `profile_not_found`, `session_provider_missing`) end with exit 1 and the detail, as every command but `run` does.

- [ ] **Step 1: The failing tests**

`apps/bytebureau/src/commands/api-key-input.test.ts`:

```ts
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { apiKeyFrom } from './api-key-input.js'

describe(apiKeyFrom, () => {
  it('reads the first line of stdin where there is no terminal, trimmed, and refuses an empty one', async () => {
    expect.hasAssertions()
    await expect(apiKeyFrom({ tty: false, stdin: Readable.from(['sk-test-key\nignored\n']), prompt: async () => 'never' })).resolves.toBe('sk-test-key')
    await expect(apiKeyFrom({ tty: false, stdin: Readable.from(['\n']), prompt: async () => 'never' })).resolves.toBeUndefined()
  })

  it('asks at a terminal, and takes a cancelled prompt as no key', async () => {
    expect.hasAssertions()
    await expect(apiKeyFrom({ tty: true, stdin: Readable.from([]), prompt: async () => 'sk-typed' })).resolves.toBe('sk-typed')
    await expect(apiKeyFrom({ tty: true, stdin: Readable.from([]), prompt: async () => undefined })).resolves.toBeUndefined()
  })
})
```

`apps/bytebureau/src/commands/profiles.test.ts` — daemon-backed, on one `testHome()` with a daemon started by `startDaemonProcess(home)` (the fake provider takes keys):

```ts
describe('the profiles commands', () => {
  it('adds a login profile, prints its login hint, lists it as the default and shows its status', async () => {
    expect.hasAssertions()
    const home = testHome()
    const daemon = await startDaemonProcess(home)
    const added = await runCli(['profiles', 'add', 'fake', 'work', '--json'], { home })
    expect(added.code).toBe(0)
    const record = jsonLines(added.stdout).find((line) => line['command'] === 'profiles.add')
    expect(record).toMatchObject({ profile: { id: 'fake/work', kind: 'login', isDefault: true } })
    const listed = await runCli(['profiles', 'ls'], { home })
    expect(listed.stdout).toContain('fake/work')
    expect(listed.stdout).toContain('default')
    const status = await runCli(['profiles', 'status', 'fake/work', '--json'], { home })
    expect(jsonLines(status.stdout).find((line) => line['command'] === 'profiles.status')).toMatchObject({ statuses: [{ profileId: 'fake/work', state: 'loggedIn' }] })
    await daemon.stop()
  })

  it('reads an API key from stdin, never from the arguments, and refuses an empty one', async () => {
    expect.hasAssertions()
    const home = testHome()
    const daemon = await startDaemonProcess(home)
    const keyed = await runCli(['profiles', 'add', 'fake', 'key', '--api-key', '--json'], { home, stdin: 'sk-from-stdin\n' })
    expect(keyed.code).toBe(0)
    expect(keyed.stdout).not.toContain('sk-from-stdin')
    const empty = await runCli(['profiles', 'add', 'fake', 'other', '--api-key'], { home, stdin: '\n' })
    expect([empty.code, empty.stderr]).toStrictEqual([1, expect.stringContaining('--api-key needs a key')])
    await daemon.stop()
  })

  it('moves the default, refuses to remove the profile of a running session, and removes it afterwards', async () => {
    expect.hasAssertions()
    const home = testHome()
    const daemon = await startDaemonProcess(home)
    await runCli(['profiles', 'add', 'fake', 'work'], { home })
    await runCli(['profiles', 'add', 'fake', 'key', '--api-key'], { home, stdin: 'sk-1\n' })
    expect((await runCli(['profiles', 'use', 'fake/key'], { home })).code).toBe(0)
    const repo = createTempRepo()
    const run = await runCli(['run', 'wait', '--project', repo, '--provider', 'fake', '--profile', 'fake/work', '--json'], { home, env: { BYTEBUREAU_FAKE_SCRIPT: 'slow' }, interruption: { afterStdout: '"turn.started"', signal: 'SIGINT' } })
    expect(run.code).toBe(3)
    const held = await runCli(['profiles', 'rm', 'fake/work'], { home })
    expect(held.code).toBe(1)
    expect(held.stderr).toContain('1 session(s) still run under it or can resume; complete or remove them first')
    const listed = await runCli(['sessions', 'ls', '--json'], { home })
    const sessionId = sessionsOf(listed.stdout)[0].id // decode `{ command: 'sessions.ls', sessions }` as the other CLI tests decode `--json` output
    expect((await runCli(['sessions', 'complete', sessionId], { home })).code).toBe(0)
    expect((await runCli(['profiles', 'rm', 'fake/key'], { home })).code).toBe(0)
    const removedWork = await runCli(['profiles', 'rm', 'fake/work', '--purge'], { home })
    expect(removedWork.code).toBe(0)
    expect((await runCli(['profiles', 'rm', 'fake/work'], { home })).code).toBe(1)
    await daemon.stop()
  })
})
```

(The `in_use` case needs no background run: an interrupted run leaves its session `ready`, and every session but a `completed` one holds its profile (ruled after Task 3), so `rm` is refused with `1 session(s) still run under it or can resume; complete or remove them first` until `sessions complete <id>` has run; the `Interruption` helper of Phase B (`afterStdout`, `signal`) signals the CLI once its `--json` stdout shows `"turn.started"`, as `run-daemon-stops.test.ts` does.)

`apps/bytebureau/src/commands/profiles-canary.test.ts` — Review Focus 1:

```ts
it('hands an API key to the agent and nowhere else: not to the events, the log, the listings or the status', async () => {
  expect.hasAssertions()
  const home = testHome()
  const daemon = await startDaemonProcess(home)
  const canary = 'sk-ant-canary-7f3a9c2e'
  await runCli(['profiles', 'add', 'fake', 'key', '--api-key'], { home, stdin: `${canary}\n` })
  const repo = createTempRepo()
  const run = await runCli(['run', 'Create src/hello.ts exporting hello()', '--project', repo, '--provider', 'fake', '--profile', 'fake/key', '--json', '--yes'], { home })
  expect(run.code).toBe(0)
  const events = jsonLines(run.stdout)
  expect(events.some((event) => event['type'] === 'session.warning' && JSON.stringify(event).includes('api key: present'))).toBe(true)
  const everything = [run.stdout, run.stderr, (await runCli(['profiles', 'ls', '--json'], { home })).stdout, (await runCli(['profiles', 'status', '--json'], { home })).stdout, readFileSync(path.join(home, 'logs', 'daemon.log'), 'utf8'), readFileSync(path.join(home, 'data', 'bytebureau.db')).toString('latin1')].join('\n')
  expect(everything).not.toContain(canary)
  expect(readFileSync(path.join(home, 'secrets.json'), 'utf8')).toContain(canary)
  await daemon.stop()
})
```

(The database check reads the raw file as text: a key must not be in any row; the only file holding it is `secrets.json` of the file backend. The `startDaemonProcess` daemon logs to its stdout/stderr captured by the helper — search `daemon.stdout()` and `daemon.stderr()` too.)

- [ ] **Step 2: Run the tests to see them fail**

Run: `bunx vitest run --project bytebureau apps/bytebureau/src/commands/profiles.test.ts apps/bytebureau/src/commands/api-key-input.test.ts apps/bytebureau/src/commands/profiles-canary.test.ts`
Expected: FAIL — `Unknown command profiles`; the module `api-key-input.js` does not exist.

- [ ] **Step 3: The key input**

`apps/bytebureau/src/commands/api-key-input.ts`:

```ts
import type { Readable } from 'node:stream'

export interface KeyInput {
  readonly tty: boolean
  readonly stdin: Readable
  // The hidden prompt of a terminal; undefined when the person cancels it
  readonly prompt: () => Promise<string | undefined>
}

// The first line of stdin, trimmed; nothing when the line is empty or stdin ends first
const firstLine = async (stdin: Readable): Promise<string | undefined> => {
  let text = ''
  for await (const chunk of stdin) {
    text += String(chunk)
    const end = text.indexOf('\n')
    if (end !== -1) {
      const line = text.slice(0, end).trim()
      return line === '' ? undefined : line
    }
  }
  const line = text.trim()
  return line === '' ? undefined : line
}

// A key comes from the terminal's hidden prompt, or from the first line of a pipe; never from an argument, which the process list shows
export const apiKeyFrom = async (input: KeyInput): Promise<string | undefined> => {
  if (input.tty) {
    const typed = await input.prompt()
    return typed === undefined || typed.trim() === '' ? undefined : typed.trim()
  }
  return firstLine(input.stdin)
}
```

- [ ] **Step 4: The commands**

`apps/bytebureau/src/commands/profiles-add.ts`:

```ts
import { m } from '@bytebureau/i18n'
import type { ProfileDto } from '@bytebureau/protocol'
import { confirm, isCancel, password } from '@clack/prompts'
import { defineCommand } from 'citty'
import type { Bureau } from '../bureau/bureau.js'
import { bureauFlags, globalArgs, processContext, type Context } from '../context.js'
import { apiKeyFrom } from './api-key-input.js'
import { withBureauRefusable } from './refusable.js'

const hiddenPrompt = (id: string) => async (): Promise<string | undefined> => {
  const typed = await password({ message: m.profiles_key_prompt({ id }) })
  return isCancel(typed) ? undefined : typed
}

// A login profile is told where to log in; at a terminal the command waits for the login and tells what it finds
const afterLogin = async (bureau: Bureau, profile: ProfileDto, context: Context): Promise<void> => {
  const status = await bureau.profiles.status(profile.id)
  context.output.print(m.profiles_added_login({ id: profile.id, hint: status.hint ?? '' }))
  if (context.stdoutIsTTY && !context.yes) {
    const done = await confirm({ message: m.profiles_wait_login(), initialValue: true })
    if (done === true) {
      const checked = await bureau.profiles.status(profile.id)
      context.output.emit({ command: 'profiles.status', statuses: [checked] })
      context.output.print(`${checked.profileId}: ${checked.state}${checked.hint === undefined ? '' : ` — ${checked.hint}`}`)
    }
  }
}

export const addCommand = defineCommand({
  meta: { name: 'add', description: 'Add a profile: a login directory, or an API key read from the prompt or stdin' },
  args: {
    ...globalArgs,
    provider: { type: 'positional', description: 'Provider id (claude, acp:codex, …)', required: true },
    name: { type: 'positional', description: 'Profile name (lower-case letters, digits, dashes)', required: true },
    'api-key': { type: 'boolean', description: 'An API-key profile; the key is read from the terminal or the first line of stdin', default: false },
    default: { type: 'boolean', description: 'Make it the default profile of its provider', default: false },
  },
  async run({ args }) {
    const context = processContext(args)
    const id = `${args.provider}/${args.name}`
    const apiKey = args['api-key'] ? await apiKeyFrom({ tty: context.stdinIsTTY, stdin: process.stdin, prompt: hiddenPrompt(id) }) : undefined
    if (args['api-key'] && apiKey === undefined) {
      context.output.warn(m.profiles_key_missing())
      process.exitCode = 1
      return
    }
    const added = await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      const profile = await bureau.profiles.add({ providerId: args.provider, name: args.name, kind: args['api-key'] ? 'api_key' : 'login', ...(apiKey === undefined ? {} : { apiKey }), ...(args.default ? { makeDefault: true } : {}) })
      context.output.emit({ command: 'profiles.add', profile })
      if (profile.kind === 'login') {
        await afterLogin(bureau, profile, context)
      } else {
        context.output.print(m.profiles_added({ id: profile.id }))
      }
      return profile
    })
    if (added === undefined) {
      return
    }
  },
})
```

(`Context` gets `stdinIsTTY: isatty(process.stdin.fd)` and `yes: boolean` if it does not carry them yet — `processContext` already knows the TTY of stdout; add the two fields in `context.ts`. The `emit` must not include the key: `profile` is the DTO, which has none. Keep `run` under `max-statements` by moving the key reading into `keyOf(args, context)`.)

`apps/bytebureau/src/commands/profiles.ts`:

```ts
import { m } from '@bytebureau/i18n'
import { defineCommand } from 'citty'
import { bureauFlags, globalArgs, processContext } from '../context.js'
import { profileRows, profileStatusRows } from '../render/rows.js'
import { table } from '../render/tables.js'
import { addCommand } from './profiles-add.js'
import { withBureauRefusable } from './refusable.js'

const ls = defineCommand({
  meta: { name: 'ls', description: 'List the profiles of every provider' },
  args: { ...globalArgs },
  async run({ args }) {
    const context = processContext(args)
    const profiles = await withBureauRefusable(context, bureauFlags(args), async (bureau) => bureau.profiles.list())
    if (profiles === undefined) {
      return
    }
    context.output.emit({ command: 'profiles.ls', profiles })
    if (profiles.length === 0) {
      context.output.print(m.profiles_none())
      return
    }
    for (const line of table(profileRows(profiles, m.profiles_default_marker()))) {
      context.output.print(line)
    }
  },
})

const rm = defineCommand({
  meta: { name: 'rm', description: 'Remove a profile; --purge removes its login directory too' },
  args: { ...globalArgs, id: { type: 'positional', description: 'Profile id (provider/name)', required: true }, purge: { type: 'boolean', description: 'Remove the login directory of the profile', default: false } },
  async run({ args }) {
    const context = processContext(args)
    const done = await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      await bureau.profiles.remove(args.id, { purge: args.purge })
      return true
    })
    if (done === true) {
      context.output.emit({ command: 'profiles.rm', id: args.id, purged: args.purge })
      context.output.print(m.profiles_removed({ id: args.id }))
    }
  },
})

const use = defineCommand({
  meta: { name: 'use', description: 'Make a profile the default of its provider' },
  args: { ...globalArgs, id: { type: 'positional', description: 'Profile id (provider/name)', required: true } },
  async run({ args }) {
    const context = processContext(args)
    const done = await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      await bureau.profiles.setDefault(args.id)
      return true
    })
    if (done === true) {
      context.output.emit({ command: 'profiles.use', id: args.id })
      context.output.print(m.profiles_default_set({ id: args.id }))
    }
  },
})

const status = defineCommand({
  meta: { name: 'status', description: 'Check the login of one profile, or of all' },
  args: { ...globalArgs, id: { type: 'positional', description: 'Profile id; every profile when left out', required: false } },
  async run({ args }) {
    const context = processContext(args)
    const statuses = await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      const ids = args.id === undefined ? (await bureau.profiles.list()).map((profile) => profile.id) : [args.id]
      return Promise.all(ids.map(async (id) => bureau.profiles.status(id)))
    })
    if (statuses === undefined) {
      return
    }
    context.output.emit({ command: 'profiles.status', statuses })
    if (statuses.length === 0) {
      context.output.print(m.profiles_status_none())
      return
    }
    for (const line of table(profileStatusRows(statuses))) {
      context.output.print(line)
    }
  },
})

export const profilesCommand = defineCommand({
  meta: { name: 'profiles', description: 'Manage the auth profiles of the agent providers' },
  subCommands: { ls, add: addCommand, rm, use, status },
})
```

(`import/max-dependencies` is 10 and `max-lines` 300 — split `rm`/`use` into `profiles-manage.ts` if needed. `Promise.all` over the statuses runs the provider checks concurrently; fine for a handful.)

`render/rows.ts`: `profileRows(profiles, marker)` → `[id, providerId, kind, isDefault ? marker : '', configDir ?? '-']`; `profileStatusRows(statuses)` → `[profileId, state, account ?? '-', flat(hint ?? '')]`. `bureau/bureau.ts`: `profiles: { list, add(body: AddProfileBody), remove(id, options?: { purge?: boolean }), setDefault(id), status(id) }`, `usage.profile(id)`; `local.ts` through `kernel.profiles.*` (map the kernel's `Profile`/`ProfileStatus` to the DTO shapes — identical fields) and `kernel.usage`'s snapshot (add `Kernel.usage.profile` in the facade: `promised(UsageService, (usage, id) => usage.snapshot(id))` mapped to the DTO with `observedAt: null` when undefined); `remote.ts` passes the client's areas through. `run.ts`: `profile: { type: 'string', description: 'Profile id of the provider (default: its default profile)' }` → `RunOptions.profile` → `sessionBody` adds `profileId`. `sessions show` adds a `profile` line (`session.profileId ?? '-'`). `sub-commands.ts`: `profiles: profilesCommand`. Messages in `en.json`/`cs.json` as listed.

- [ ] **Step 5: Run the CLI suite twice and the gates**

Run: `bun run build:i18n && bunx vitest run --project bytebureau && bunx vitest run --project bytebureau && bun run typecheck && bun run lint && bun run format:check && bun run spell && bun run knip`
Expected: PASS twice; `ps` shows no `serve`/`run` process afterwards.

- [ ] **Step 6: Commit**

```bash
git add packages/i18n/messages && git commit -m "feat(i18n): add the messages of the profiles commands"
git add apps/bytebureau vitest.config.ts && git commit -m "feat(cli): manage the auth profiles of the providers and run a session under one"
```

---

### Task 6: `plugins/agent-claude` — Claude Code through the Agent SDK

**Files:**
- Create: `plugins/agent-claude/package.json`, `plugins/agent-claude/tsconfig.json`, `plugins/agent-claude/vitest.config.ts`, `plugins/agent-claude/src/plugin.ts`, `plugins/agent-claude/src/provider.ts`, `plugins/agent-claude/src/config.ts`, `plugins/agent-claude/src/executable.ts`, `plugins/agent-claude/src/options.ts`, `plugins/agent-claude/src/permission.ts`, `plugins/agent-claude/src/queue.ts` (one `Queue<T>` for the SDK input and the events), `plugins/agent-claude/src/session.ts`, `plugins/agent-claude/src/mapping.ts`, `plugins/agent-claude/src/mapping-result.ts`, `plugins/agent-claude/src/asks.ts`, `plugins/agent-claude/src/ask-questions.ts`, `plugins/agent-claude/src/auth.ts`, `plugins/agent-claude/src/testing/fake-query.ts`, `plugins/agent-claude/src/testing/sdk-fixtures.ts`, tests `provider.test.ts`, `options.test.ts`, `mapping.test.ts`, `asks.test.ts`, `session.test.ts`, `auth.test.ts`, `executable.test.ts`
- Modify: `packages/kernel/src/sessions/session-ask.ts` and `live-sessions.ts` (the kernel remembers the agent's own ask id and answers the agent with it — `live.askIds: Map<kernelAskId, providerAskId>`), `packages/kernel/src/sessions/session-agent-asks.test.ts` (pins it), `vitest.config.ts` (project `plugins/agent-claude`), `.dependency-cruiser.cjs` only if the plugin rule needs the new path (it matches `plugins/*`), `cspell-words.txt` (genuine words only), `scripts/license.test.ts` (the manifest list, if it enumerates paths)
- Test: the plugin's tests under Node with the fake `query`

**Interfaces:**
- Consumes: Task 1's `CreateSessionRequest.providerConfig`, `AgentProvider.apiKeyEnv`; the plugin-api ports; `@bytebureau/protocol`'s `AgentEvent`, `Ask`, `AskAnswer`, `Usage`, `RateLimit`, `PromptInput`, `EmployeeSpec` types; the Agent SDK 0.3.288 surface of the fact sheet §1 (`query`, `Options`, `Query`, `SDKMessage` union, `PermissionResult`, `HookEvent`, `AccountInfo`).
- Produces: `export const claudeAgentPlugin: Plugin` (manifest `agent-claude`, `displayName: 'Claude Code (Agent SDK)'`, `hostApi: '^0'`, `kind: 'in-process'`, `capabilities: ['process', 'net', 'secrets']`, `contributes: { agentProviders: ['claude'] }`); `export class ClaudeAgentProvider implements AgentProvider` (`id = 'claude'`, `apiKeyEnv = 'ANTHROPIC_API_KEY'`, constructor `(deps: ClaudeDeps)` with `ClaudeDeps = { readonly query: QueryFn; readonly logger: Logger; readonly resolveExecutable?: (name: string) => string | undefined }`); `export type QueryFn = typeof query` (the SDK's); `export class ClaudeSession implements AgentSession`; `export const CLAUDE_CONVENTIONS: string` (the appended system prompt of §8.4: the recommended-option convention); `export const mapMessage(message: SDKMessage, state: MapState): readonly AgentEvent[]`; the provider's config `ClaudeConfig = { executable?: string; settingSources?: ('user' | 'project' | 'local')[] }` validated with zod from `providerConfig`.

Semantics (as planned): one `query()` in streaming-input mode spans the session: `prompt()` pushes an `SDKUserMessage` into the input queue (a follow-up while a turn runs steers it, as the SDK queues user messages); `interrupt()` calls `query.interrupt()` and settles every pending ask with `deny` (`'interrupted'`); `answer()` resolves the pending ask of that id; `events()` is the output queue of canonical events; `close()` aborts the controller, calls `query.close()` and ends the queues. `externalRef` is `{ providerId: 'claude', ref: <session_id of system/init> }` once the init message has arrived (null before). Options (fact sheet §1): `cwd` = workspace; `model`, `effort` (when not null) from the employee; `systemPrompt: { type: 'preset', preset: 'claude_code', append: employee.systemPrompt + '\n\n' + CLAUDE_CONVENTIONS }`; `allowedTools`/`disallowedTools` from `employee.tools`; `maxTurns` when set; `includePartialMessages: true`; `permissionMode: 'default'` for `supervised`, `'auto'` for `autonomous` (`yolo` is refused by the kernel before the adapter sees it; the adapter throws if it ever does); `env` = `request.env` plus `CLAUDE_CONFIG_DIR: profile.configDir` for a `login` profile with a directory (the API key of an `api_key` profile is already in `request.env` under `ANTHROPIC_API_KEY`, put there by the kernel); `settingSources: config.settingSources ?? ['user', 'project', 'local']`; `pathToClaudeCodeExecutable`: the configured `executable` (default `'claude'`) resolved on `PATH`, left undefined (the SDK's bundled binary) when not found; `resume: request.resume.ref` when the ref's provider is `claude`; `abortController` per session; `hooks` and `canUseTool` as below; `mcpServers: {}`. Events: the first `assistant` or `stream_event` of a turn → `turn.started`; `stream_event` text delta → `message.delta { kind: 'text' }`, thinking delta → `message.delta { kind: 'thinking' }`; `assistant` → `message.completed { role: 'assistant', content, text }` and one `tool.started { id, name, kind, input }` per `tool_use` block (`kind`: `Bash` → `'bash'`, `Task` → `'subagent'`, `Skill` → `'skill'`, `mcp__*` → `'mcp'`, else `'builtin'`); `user` with `tool_result` blocks → `tool.completed { id, outputSummary (first 32 KB of the text), bytes }` or `tool.failed { id, error }` when `is_error`; `result` → `usage.updated { usage }` then `turn.completed { stopReason, usage }` with `stopReason` = `stop_reason ?? 'end_turn'` on success and the error `subtype` otherwise, `usage` from `modelUsage` summed (input, output, cache read/write, `costUsd` = `total_cost_usd`) and `contextPct` from the latest `context_usage` of the turn; `rate_limit_event` → `ratelimit.updated` (`fiveHourPct`/`sevenDayPct` from `utilization` by `rateLimitType`, `*ResetsAt` from `resetsAt` in ISO) and, when `status === 'rejected'`, `session.error { kind: 'ratelimit', message, retryable: true }`; `system/compact_boundary` → `compaction.completed`; `system/api_retry` → `session.warning { kind: 'api_retry', message }`; `auth_status` with `error` → `session.error { kind: 'auth', message, retryable: false }`; hooks `SubagentStart`/`SubagentStop` → `subagent.started|stopped`; everything else is ignored (no `raw` noise). `canUseTool`: `AskUserQuestion` → a `question` ask built from `input.questions` (each `{ question, header, options: [{ label, description }], multiSelect }` → `{ id: String(index), header: header.slice(0, 12), prompt: question, options: [{ id: label, label: labelWithoutSuffix, description, recommended, evidence: [] }], multiSelect, allowOther: true }`; an option whose label ends with `(Recommended)` is the recommended one and loses the suffix; `recommendationSource: 'agent'` when every question has exactly one, else `'none'`); the answer → `{ behavior: 'allow', updatedInput: { ...input, answers: { [question]: selectedLabelOrOtherText } } }`; any other tool → a `permission` ask (`title: toolName`, one question `{ id: 'decision', header: 'Permission', prompt: 'Allow <tool>?', options: allow (id 'allow') / deny (id 'deny'), multiSelect: false, allowOther: false }`, `toolCall: { name, input }`, `recommendationSource: 'none'` — the kernel's policy recommends) → `allow` → `{ behavior: 'allow', updatedInput: input }`, `deny` → `{ behavior: 'deny', message: 'denied through ByteBureau' }`; the ask's `id` is the SDK's `requestId` (so the kernel's answer finds it); `authStatus(profile)`: a `login` profile whose directory is gone → `loggedOut` with the hint `CLAUDE_CONFIG_DIR=<dir> claude /login`; otherwise a probe query (`prompt`: an input queue ended at once; `options`: the profile's env, `settingSources: []`, `permissionMode: 'default'`, `maxTurns: 1`, `cwd: os.tmpdir()`, the executable) whose `initializationResult()` is awaited and whose `accountInfo()` gives `loggedIn` with `account: email ?? organization`; an error whose message matches `/login|auth|credential|unauthori[sz]ed|401|expired/iu` is `loggedOut` (or `expired` when it says so) with the hint; any other error is `unknown` with the reason; the probe is closed in `finally` and bounded by 20 s.

- [ ] **Step 1: The package**

`plugins/agent-claude/package.json`:

```json
{
  "name": "@bytebureau/agent-claude",
  "version": "0.0.0",
  "private": true,
  "description": "ByteBureau agent provider: Claude Code through the Agent SDK",
  "license": "FSL-1.1-MIT",
  "type": "module",
  "exports": {
    ".": { "types": "./src/plugin.ts", "default": "./src/plugin.ts" },
    "./plugin": { "types": "./src/plugin.ts", "default": "./src/plugin.ts" }
  },
  "scripts": { "typecheck": "tsc --noEmit -p tsconfig.json" },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "0.3.288",
    "@anthropic-ai/sdk": "<newest version at least a day old at install>",
    "@bytebureau/plugin-api": "workspace:*",
    "@bytebureau/protocol": "workspace:*",
    "@modelcontextprotocol/sdk": "<newest 1.x at least a day old>",
    "zod": "4.6.5"
  },
  "devDependencies": { "@bytebureau/tsconfig": "workspace:*" },
  "bytebureau": {
    "name": "agent-claude",
    "hostApi": "^0",
    "kind": "in-process",
    "capabilities": ["process", "net", "secrets"],
    "contributes": { "agentProviders": ["claude"] }
  }
}
```

(Resolve the two peer versions with `npm view @anthropic-ai/sdk time --json` and `npm view @modelcontextprotocol/sdk time --json`, choosing the newest entry published more than 86400 s before the install, and pin exactly. `tsconfig.json` and `vitest.config.ts` copy `plugins/workspace-local`'s (`name: 'agent-claude'`, `testTimeout: 20_000`). Root `vitest.config.ts` adds `'plugins/agent-claude'` to the projects. Run `bun install` and commit `bun.lock`.)

- [ ] **Step 2: The failing mapping and ask tests**

`plugins/agent-claude/src/testing/sdk-fixtures.ts` — recorded shapes (typed as the SDK's `SDKMessage` so the compiler checks the fields):

```ts
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

export const SESSION = 'sess-0001'
const uuid = (n: number): string => `00000000-0000-7000-8000-00000000000${n}`

export const init: SDKMessage = { type: 'system', subtype: 'init', apiKeySource: 'none', claude_code_version: '2.1.288', cwd: '/w', tools: ['Read', 'Edit', 'Bash', 'AskUserQuestion'], mcp_servers: [], model: 'claude-opus-5-5', permissionMode: 'default', slash_commands: [], session_id: SESSION, uuid: uuid(1) } as SDKMessage
export const textDelta: SDKMessage = { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }, parent_tool_use_id: null, session_id: SESSION, uuid: uuid(2) } as SDKMessage
export const thinkingDelta: SDKMessage = { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } }, parent_tool_use_id: null, session_id: SESSION, uuid: uuid(3) } as SDKMessage
export const assistantWithTool: SDKMessage = { type: 'assistant', message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-5-5', type: 'message', stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'Editing.' }, { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: '/w/src/hello.ts' } }] }, parent_tool_use_id: null, session_id: SESSION, uuid: uuid(4) } as SDKMessage
export const toolResult: SDKMessage = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', is_error: false }] }, parent_tool_use_id: null, session_id: SESSION, uuid: uuid(5) } as SDKMessage
export const resultSuccess: SDKMessage = { type: 'result', subtype: 'success', duration_ms: 1200, duration_api_ms: 900, is_error: false, num_turns: 2, result: 'done', stop_reason: 'end_turn', total_cost_usd: 0.0123, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, modelUsage: { 'claude-opus-5-5': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 1, webSearchRequests: 0, costUSD: 0.0123, contextWindow: 200000, maxOutputTokens: 32000 } }, permission_denials: [], session_id: SESSION, uuid: uuid(6) } as SDKMessage
export const resultMaxTurns: SDKMessage = { ...resultSuccess, subtype: 'error_max_turns', is_error: true } as SDKMessage
export const rateLimited: SDKMessage = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1791100000, rateLimitType: 'five_hour', utilization: 1 }, session_id: SESSION, uuid: uuid(7) } as SDKMessage
export const compacted: SDKMessage = { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000, post_tokens: 20000 }, session_id: SESSION, uuid: uuid(8) } as SDKMessage
export const retried: SDKMessage = { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, retry_delay_ms: 2000, error_status: 529, error: 'overloaded', session_id: SESSION, uuid: uuid(9) } as SDKMessage
export const authFailed: SDKMessage = { type: 'auth_status', isAuthenticating: false, output: [], error: 'Not logged in', session_id: SESSION, uuid: uuid(10) } as SDKMessage
```

(The `as SDKMessage` casts in a fixture file are the one place the plan allows the cast: the fixtures are literals of a foreign union; keep the file in `testing/` and, if the lint refuses `as`, type each constant through a `const fixture = <T extends SDKMessage>(message: T): T => message` helper and satisfy the union by adding the fields the compiler names. Where a fixture's field names disagree with the installed SDK's declarations, the compiler says so — fix the fixture, not the mapping's reading of the real field; the declarations are the truth.)

`plugins/agent-claude/src/mapping.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mapMessage, newMapState } from './mapping.js'
import * as sdk from './testing/sdk-fixtures.js'

describe(mapMessage, () => {
  it('turns the messages of one turn into the canonical events, starting the turn at the first delta', () => {
    const state = newMapState()
    const events = [sdk.init, sdk.textDelta, sdk.thinkingDelta, sdk.assistantWithTool, sdk.toolResult, sdk.resultSuccess].flatMap((message) => mapMessage(message, state))
    expect(events.map((event) => event.type)).toStrictEqual(['turn.started', 'message.delta', 'message.delta', 'message.completed', 'tool.started', 'tool.completed', 'usage.updated', 'turn.completed'])
    expect(events[1]).toStrictEqual({ type: 'message.delta', kind: 'text', text: 'Hello' })
    expect(events[4]).toMatchObject({ type: 'tool.started', id: 'toolu_1', name: 'Edit', kind: 'builtin' })
    expect(events[7]).toStrictEqual({ type: 'turn.completed', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, costUsd: 0.0123 } })
    expect(state.sessionId).toBe(sdk.SESSION)
  })

  it('tells an error result by its subtype, a rate limit as both an update and a pause-worthy error, a compaction, a retry and a lost login', () => {
    const state = newMapState()
    expect(mapMessage(sdk.resultMaxTurns, state).at(-1)).toMatchObject({ type: 'turn.completed', stopReason: 'error_max_turns' })
    expect(mapMessage(sdk.rateLimited, state).map((event) => event.type)).toStrictEqual(['ratelimit.updated', 'session.error'])
    expect(mapMessage(sdk.rateLimited, state)[0]).toMatchObject({ rateLimit: { fiveHourPct: 100, fiveHourResetsAt: new Date(1791100000 * 1000).toISOString() } })
    expect(mapMessage(sdk.compacted, state)).toStrictEqual([{ type: 'compaction.completed' }])
    expect(mapMessage(sdk.retried, state)).toStrictEqual([{ type: 'session.warning', kind: 'api_retry', message: 'attempt 1 of 3 in 2000 ms: overloaded (529)' }])
    expect(mapMessage(sdk.authFailed, state)).toStrictEqual([{ type: 'session.error', kind: 'auth', message: 'Not logged in', retryable: false }])
  })

  it('names the kind of a tool by its name', () => {
    expect(['Bash', 'Task', 'Skill', 'mcp__jira__search', 'Read'].map(toolKindOf)).toStrictEqual(['bash', 'subagent', 'skill', 'mcp', 'builtin'])
  })
})
```

`plugins/agent-claude/src/asks.test.ts`:

```ts
describe('the asks of a permission prompt', () => {
  it('turns AskUserQuestion into a question ask with the recommended option found by its suffix, and answers the SDK with the labels', async () => {
    expect.hasAssertions()
    const broker = new AskBroker()
    const pending = broker.ask('AskUserQuestion', { questions: [{ question: 'Which export?', header: 'Export', options: [{ label: 'Named (Recommended)', description: 'Matches the modules' }, { label: 'Default', description: '' }], multiSelect: false }] }, { requestId: 'req-1', toolUseID: 'toolu_9' })
    const [requested] = broker.drain()
    expect(requested).toMatchObject({ type: 'ask.requested', ask: { id: 'req-1', kind: 'question', recommendationSource: 'agent', questions: [{ id: '0', header: 'Export', options: [{ id: 'Named (Recommended)', label: 'Named', recommended: true }, { id: 'Default', label: 'Default', recommended: false }] }] } })
    broker.answer('req-1', { selected: ['Named (Recommended)'] })
    await expect(pending).resolves.toStrictEqual({ behavior: 'allow', updatedInput: { questions: expect.any(Array), answers: { 'Which export?': 'Named' } } })
  })

  it('turns any other tool into a permission ask the kernel recommends on, allows or denies by the answer, and denies everything on interrupt', async () => {
    expect.hasAssertions()
    const broker = new AskBroker()
    const allow = broker.ask('Bash', { command: 'rm -rf dist' }, { requestId: 'req-2', toolUseID: 'toolu_2' })
    const [requested] = broker.drain()
    expect(requested).toMatchObject({ ask: { kind: 'permission', title: 'Bash', toolCall: { name: 'Bash', input: { command: 'rm -rf dist' } }, recommendationSource: 'none' } })
    broker.answer('req-2', { selected: ['allow'] })
    await expect(allow).resolves.toStrictEqual({ behavior: 'allow', updatedInput: { command: 'rm -rf dist' } })
    const deny = broker.ask('Edit', {}, { requestId: 'req-3', toolUseID: 'toolu_3' })
    broker.answer('req-3', { selected: ['deny'] })
    await expect(deny).resolves.toMatchObject({ behavior: 'deny' })
    const hanging = broker.ask('Edit', {}, { requestId: 'req-4', toolUseID: 'toolu_4' })
    broker.denyAll('interrupted')
    await expect(hanging).resolves.toStrictEqual({ behavior: 'deny', message: 'interrupted' })
  })
})
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `bunx vitest run --project agent-claude`
Expected: FAIL — the modules do not exist.

- [ ] **Step 4: Mapping, asks, queues**

`plugins/agent-claude/src/event-queue.ts` — the same shape as the kernel's testing `EventQueue`, written here (the plugin cannot import the kernel):

```ts
import type { AgentEvent } from '@bytebureau/protocol'

// Events pushed by the reader of the SDK, taken by the kernel's pump; end() lets the pump finish
export class EventQueue implements AsyncIterable<AgentEvent> {
  private readonly items: AgentEvent[] = []
  private waiting: ((value: IteratorResult<AgentEvent>) => void) | null = null
  private ended = false

  public push(event: AgentEvent): void {
    if (this.ended) {
      return
    }
    const waiting = this.waiting
    if (waiting === null) {
      this.items.push(event)
    } else {
      this.waiting = null
      waiting({ value: event, done: false })
    }
  }

  public end(): void {
    this.ended = true
    const waiting = this.waiting
    if (waiting !== null) {
      this.waiting = null
      waiting({ value: undefined, done: true })
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: async () => {
        const item = this.items.shift()
        if (item !== undefined) {
          return { value: item, done: false }
        }
        if (this.ended) {
          return { value: undefined, done: true }
        }
        return new Promise((resolve) => {
          this.waiting = resolve
        })
      },
    }
  }
}
```

`plugins/agent-claude/src/input-queue.ts` — the same class over `SDKUserMessage` (generic `Queue<T>`: write it once as `class Queue<T>` in `queue.ts` and alias `EventQueue = Queue<AgentEvent>`, `InputQueue = Queue<SDKUserMessage>`).

`plugins/agent-claude/src/mapping.ts` (with `mapping-result.ts` for the result and rate-limit parts, to stay under the caps):

```ts
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, ToolKind } from '@bytebureau/protocol'
import { mapResult, mapRateLimit } from './mapping-result.js'

export interface MapState {
  sessionId: string | null
  turnStarted: boolean
  contextPct: number | undefined
}

export const newMapState = (): MapState => ({ sessionId: null, turnStarted: false, contextPct: undefined })

export const toolKindOf = (name: string): ToolKind => {
  if (name === 'Bash') return 'bash'
  if (name === 'Task') return 'subagent'
  if (name === 'Skill') return 'skill'
  return name.startsWith('mcp__') ? 'mcp' : 'builtin'
}

const SUMMARY_LIMIT = 32 * 1024

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block: unknown) => (typeof block === 'object' && block !== null && Reflect.get(block, 'type') === 'text' ? String(Reflect.get(block, 'text')) : '')).join('')
}

// The first event of a turn announces it; the flag falls with the result
const started = (state: MapState): readonly AgentEvent[] => {
  if (state.turnStarted) return []
  state.turnStarted = true
  return [{ type: 'turn.started' }]
}

const mapDelta = (event: unknown, state: MapState): readonly AgentEvent[] => {
  const delta = typeof event === 'object' && event !== null ? Reflect.get(event, 'delta') : undefined
  const kind = typeof delta === 'object' && delta !== null ? Reflect.get(delta, 'type') : undefined
  if (kind === 'text_delta') return [...started(state), { type: 'message.delta', kind: 'text', text: String(Reflect.get(delta, 'text')) }]
  if (kind === 'thinking_delta') return [...started(state), { type: 'message.delta', kind: 'thinking', text: String(Reflect.get(delta, 'thinking')) }]
  return []
}

const mapAssistant = (message: { readonly content: readonly unknown[] }, state: MapState): readonly AgentEvent[] => {
  const tools: AgentEvent[] = message.content.flatMap((block: unknown) => {
    if (typeof block !== 'object' || block === null || Reflect.get(block, 'type') !== 'tool_use') return []
    const name = String(Reflect.get(block, 'name'))
    return [{ type: 'tool.started', id: String(Reflect.get(block, 'id')), name, kind: toolKindOf(name), input: Reflect.get(block, 'input') }]
  })
  return [...started(state), { type: 'message.completed', role: 'assistant', content: [...message.content], text: textOf(message.content) }, ...tools]
}

const mapToolResults = (content: unknown): readonly AgentEvent[] => {
  if (!Array.isArray(content)) return []
  return content.flatMap((block: unknown) => {
    if (typeof block !== 'object' || block === null || Reflect.get(block, 'type') !== 'tool_result') return []
    const id = String(Reflect.get(block, 'tool_use_id'))
    const text = textOf(Reflect.get(block, 'content'))
    return Reflect.get(block, 'is_error') === true
      ? [{ type: 'tool.failed', id, error: text.slice(0, SUMMARY_LIMIT) }]
      : [{ type: 'tool.completed', id, outputSummary: text.slice(0, SUMMARY_LIMIT), bytes: Buffer.byteLength(text) }]
  })
}

const mapSystem = (message: SDKMessage & { readonly type: 'system' }, state: MapState): readonly AgentEvent[] => {
  switch (message.subtype) {
    case 'init': state.sessionId = message.session_id; return []
    case 'compact_boundary': return [{ type: 'compaction.completed' }]
    case 'api_retry': return [{ type: 'session.warning', kind: 'api_retry', message: `attempt ${message.attempt} of ${message.max_retries} in ${message.retry_delay_ms} ms: ${String(message.error)} (${String(message.error_status)})` }]
    default: return []
  }
}

// The canonical events of one SDK message; messages ByteBureau does not show map to nothing
export const mapMessage = (message: SDKMessage, state: MapState): readonly AgentEvent[] => {
  switch (message.type) {
    case 'system': return mapSystem(message, state)
    case 'stream_event': return mapDelta(message.event, state)
    case 'assistant': if (message.context_usage !== undefined) state.contextPct = contextPctOf(message.context_usage); return mapAssistant(message.message, state)
    case 'user': return mapToolResults(message.message.content)
    case 'result': return mapResult(message, state)
    case 'rate_limit_event': return mapRateLimit(message.rate_limit_info)
    case 'auth_status': return message.error === undefined ? [] : [{ type: 'session.error', kind: 'auth', message: message.error, retryable: false }]
    default: return []
  }
}
```

(`mapping-result.ts`: `mapResult` sums `modelUsage` into `Usage` (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `costUsd: total_cost_usd`, `contextPct: state.contextPct`), emits `usage.updated` then `turn.completed { stopReason: subtype === 'success' ? (stop_reason ?? 'end_turn') : subtype, usage }`, and resets `turnStarted`; `mapRateLimit` builds `RateLimit` from `rateLimitType` (`five_hour` → `fiveHourPct = utilization * 100`, `fiveHourResetsAt = new Date(resetsAt * 1000).toISOString()`; `seven_day*` → the seven-day fields) and adds `session.error { kind: 'ratelimit', message: 'the usage limit is reached', retryable: true }` when `status === 'rejected'`; `contextPctOf(usage)` = `total_tokens / <window> * 100` using the window field the installed declarations name. Where the SDK's union makes a `switch` on `message.type` lose narrowing, read fields through `Reflect.get` with runtime checks as above — the mapping must never throw on an unexpected message: wrap `mapMessage` in `try/catch` in the session and emit `session.warning { kind: 'mapping', message }`.)

`plugins/agent-claude/src/asks.ts` — `AskBroker` (pending asks by id; `ask(toolName, input, { requestId, toolUseID })` returns the SDK's `PermissionResult` promise and queues the `ask.requested` event; `answer(id, answer)`; `denyAll(message)`; `drain()` returns and clears the queued events — the session pushes them into the event queue) with `ask-questions.ts` holding the `AskUserQuestion` parsing (`questionsOf(input)`, the `(Recommended)` suffix rule, `answersOf(questions, answer)`); the permission ask builder sets `policy: { onTimeout: 'wait', timeout: '30m' }` (the kernel overrides by the employee's `askTimeout`), `status: 'pending'`, `createdAt`, `deadlineAt: null`, `turnId: null`, `sessionId` from the request.

- [ ] **Step 5: Options, executable, permission mode, config**

`plugins/agent-claude/src/config.ts`:

```ts
import { z } from 'zod'

export const ClaudeConfig = z.object({
  executable: z.string().min(1).optional(),
  settingSources: z.array(z.enum(['user', 'project', 'local'])).optional(),
}).strict()

export type ClaudeConfig = z.infer<typeof ClaudeConfig>

// The providers.claude section as the adapter reads it; a key it does not know is a configuration error, told as such
export const claudeConfigOf = (providerConfig: Readonly<Record<string, unknown>>): ClaudeConfig => {
  const parsed = ClaudeConfig.safeParse(providerConfig)
  if (!parsed.success) {
    throw new Error(`providers.claude: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  }
  return parsed.data
}
```

`plugins/agent-claude/src/executable.ts`: `resolveExecutable(name, env = process.env)`: an absolute or relative path with a separator → the path when `existsSync`; otherwise each `PATH` entry joined with `name` (and `name + '.exe'`, `name + '.cmd'` on win32) → the first that exists; else `undefined`. Test with a temp directory on a fake `PATH`.

`plugins/agent-claude/src/permission.ts`: `permissionModeOf(mode: EmployeeSpec['permissionMode']): 'default' | 'auto'` — `supervised` → `'default'`, `autonomous` → `'auto'`, `yolo` → throw `Error('yolo is refused: the workspace runtime has no isolation')`.

`plugins/agent-claude/src/options.ts`:

```ts
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { CreateSessionRequest } from '@bytebureau/plugin-api'
import { claudeConfigOf } from './config.js'
import { permissionModeOf } from './permission.js'

export const CLAUDE_CONVENTIONS = [
  'ByteBureau conventions:',
  '- When you ask the person a question with AskUserQuestion, put the option you recommend first, end its label with " (Recommended)" and give one line of evidence in its description.',
  '- Work only inside the current working directory, which is an isolated git worktree of the project.',
].join('\n')

export interface OptionParts {
  readonly request: CreateSessionRequest
  readonly executable: string | undefined
  readonly abort: AbortController
  readonly hooks: Options['hooks']
  readonly canUseTool: Options['canUseTool']
}

// The environment of the child: what the kernel allowed, and the login directory of a login profile
const envOf = (request: CreateSessionRequest): Record<string, string> => {
  const { profile } = request
  const configDir = profile.kind === 'login' && profile.configDir !== undefined ? { CLAUDE_CONFIG_DIR: profile.configDir } : {}
  return { ...request.env, ...configDir }
}

export const optionsOf = ({ request, executable, abort, hooks, canUseTool }: OptionParts): Options => {
  const config = claudeConfigOf(request.providerConfig)
  const { employee } = request
  const resume = request.resume !== undefined && request.resume.providerId === 'claude' ? { resume: request.resume.ref } : {}
  return {
    cwd: request.workspace.path,
    model: employee.model,
    ...(employee.effort === null ? {} : { effort: employee.effort }),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: `${employee.systemPrompt}\n\n${CLAUDE_CONVENTIONS}` },
    allowedTools: [...employee.tools.allow],
    disallowedTools: [...employee.tools.deny],
    ...(employee.maxTurns === undefined ? {} : { maxTurns: employee.maxTurns }),
    includePartialMessages: true,
    permissionMode: permissionModeOf(employee.permissionMode),
    env: envOf(request),
    settingSources: config.settingSources ?? ['user', 'project', 'local'],
    ...(executable === undefined ? {} : { pathToClaudeCodeExecutable: executable }),
    ...resume,
    abortController: abort,
    hooks,
    canUseTool,
    mcpServers: {},
  }
}
```

(Test `options.test.ts`: the defaults, `CLAUDE_CONFIG_DIR` only for a login profile with a directory, the key present in `env` only because the request carried it, `permissionMode` mapping, `resume` only for a `claude` ref, the executable, a refused unknown config key.)

- [ ] **Step 6: The session, the provider, the auth check, the plugin**

`plugins/agent-claude/src/session.ts`:

```ts
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentSession, AskAnswer, CreateSessionRequest, ExternalSessionRef } from '@bytebureau/plugin-api'
import type { AgentEvent, PromptInput } from '@bytebureau/protocol'
import { AskBroker } from './asks.js'
import { mapMessage, newMapState, type MapState } from './mapping.js'
import { optionsOf } from './options.js'
import { Queue } from './queue.js'
import type { ClaudeDeps } from './provider.js'

// One query spans the session: prompts are user messages pushed into its input, its messages become the events
export class ClaudeSession implements AgentSession {
  private readonly input = new Queue<SDKUserMessage>()
  private readonly output = new Queue<AgentEvent>()
  private readonly asks = new AskBroker()
  private readonly abort = new AbortController()
  private readonly state: MapState = newMapState()
  private readonly request: CreateSessionRequest
  private readonly query: Query
  private closed = false

  public constructor(deps: ClaudeDeps, request: CreateSessionRequest, executable: string | undefined) {
    this.request = request
    this.query = deps.query({
      prompt: this.input,
      options: optionsOf({ request, executable, abort: this.abort, hooks: this.hooksOf(), canUseTool: this.canUseTool() }),
    })
    void this.read(deps)
  }

  public get externalRef(): ExternalSessionRef | null {
    return this.state.sessionId === null ? null : { providerId: 'claude', ref: this.state.sessionId }
  }

  public async prompt(input: PromptInput): Promise<void> {
    await Promise.resolve()
    this.input.push({ type: 'user', session_id: this.state.sessionId ?? '', parent_tool_use_id: null, message: { role: 'user', content: input.text } })
  }

  public async interrupt(): Promise<void> {
    this.asks.denyAll('interrupted')
    this.flushAsks()
    await this.query.interrupt()
  }

  public async answer(askId: string, answer: AskAnswer): Promise<void> {
    await Promise.resolve()
    this.asks.answer(askId, answer)
  }

  public events(): AsyncIterable<AgentEvent> {
    return this.output
  }

  public async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.asks.denyAll('closed')
      this.input.end()
      this.abort.abort()
      this.query.close()
      this.output.end()
    }
    await Promise.resolve()
  }

  private flushAsks(): void {
    for (const event of this.asks.drain()) {
      this.output.push(event)
    }
  }

  private canUseTool(): NonNullable<Parameters<typeof optionsOf>[0]['canUseTool']> {
    return async (toolName, input, options) => {
      const pending = this.asks.ask(toolName, input, { requestId: options.requestId, toolUseID: options.toolUseID })
      this.flushAsks()
      return pending
    }
  }

  private hooksOf(): Parameters<typeof optionsOf>[0]['hooks'] {
    const subagent = (type: 'subagent.started' | 'subagent.stopped') => [{ hooks: [async (hookInput: unknown) => { this.output.push({ type, id: String(Reflect.get(hookInput as object, 'agent_id') ?? ''), name: String(Reflect.get(hookInput as object, 'agent_type') ?? 'subagent') }); return {} }] }]
    return { SubagentStart: subagent('subagent.started'), SubagentStop: subagent('subagent.stopped') }
  }

  // The messages of the SDK, read for as long as the query gives them; a query that fails is a crash of the session
  private async read(deps: ClaudeDeps): Promise<void> {
    try {
      for await (const message of this.query) {
        for (const event of this.safeMap(message)) {
          this.output.push(event)
        }
      }
    } catch (error) {
      if (!this.closed) {
        this.output.push({ type: 'session.error', kind: 'crash', message: error instanceof Error ? error.message : String(error), retryable: true })
        deps.logger.warn('the Claude query ended with an error', { reason: String(error) })
      }
    } finally {
      this.output.push({ type: 'session.closed' })
      this.output.end()
    }
  }

  private safeMap(message: Parameters<typeof mapMessage>[0]): readonly AgentEvent[] {
    try {
      return mapMessage(message, this.state)
    } catch (error) {
      return [{ type: 'session.warning', kind: 'mapping', message: error instanceof Error ? error.message : String(error) }]
    }
  }
}
```

(The hook input fields `agent_id`/`agent_type` are read defensively from the SDK's `SubagentStartHookInput`; use the declared names when the compiler shows them. The `as object` narrowing is a type assertion the lint refuses — replace with a guard `isRecord(hookInput)`. The `SDKUserMessage` literal must match the installed declaration — fix the fields the compiler names.)

`plugins/agent-claude/src/auth.ts`:

```ts
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { AuthStatus, ProfileRef } from '@bytebureau/plugin-api'
import { Queue } from './queue.js'
import type { ClaudeDeps } from './provider.js'

const PROBE_LIMIT_MS = 20_000
const LOGGED_OUT = /login|auth|credential|unauthori[sz]ed|401|expired/iu

export const loginHint = (profile: ProfileRef): string =>
  profile.kind === 'api_key' ? 'remove the profile and add it again with a valid key' : `${profile.configDir === undefined ? '' : `CLAUDE_CONFIG_DIR=${profile.configDir} `}claude /login`

const stateOf = (reason: string): AuthStatus['state'] => (/expired/iu.test(reason) ? 'expired' : LOGGED_OUT.test(reason) ? 'loggedOut' : 'unknown')

// A query that is given nothing to say, only to learn who is logged in; closed whatever happens
export const authStatusOf = async (deps: ClaudeDeps, profile: ProfileRef, executable: string | undefined): Promise<AuthStatus> => {
  if (profile.kind === 'login' && profile.configDir !== undefined && !existsSync(profile.configDir)) {
    return { state: 'loggedOut', hint: loginHint(profile) }
  }
  const input = new Queue<never>()
  input.end()
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), PROBE_LIMIT_MS)
  const env = profile.kind === 'login' && profile.configDir !== undefined ? { ...process.env, CLAUDE_CONFIG_DIR: profile.configDir } : { ...process.env }
  const probe = deps.query({ prompt: input, options: { cwd: tmpdir(), env, settingSources: [], permissionMode: 'default', maxTurns: 1, abortController: abort, ...(executable === undefined ? {} : { pathToClaudeCodeExecutable: executable }) } })
  try {
    await probe.initializationResult()
    const account = await probe.accountInfo()
    return { state: 'loggedIn', ...(account.email === undefined && account.organization === undefined ? {} : { account: account.email ?? account.organization }) }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const state = stateOf(reason)
    return { state, hint: state === 'unknown' ? reason : loginHint(profile) }
  } finally {
    clearTimeout(timer)
    probe.close()
  }
}
```

(The probe's `env` is the allowlisted environment of the daemon: build it with `allowlistEnv`-like filtering in the plugin — `PATH`, `HOME`, `LANG`, `LC_*`, `TMPDIR`, `TERM`, `SSH_AUTH_SOCK` from `process.env`, plus `ANTHROPIC_API_KEY` only when the caller passes an `api_key` profile's key — the kernel does not pass secrets to `authStatus`; for an `api_key` profile the probe cannot carry the key, so `authStatus` answers `unknown` with the hint "run a session to check an API-key profile" — amend accordingly and test it. The first thing Task 6's implementer does is Step 0 below.)

- [ ] **Step 0 (do before Step 4 — the two probes against the real SDK on this machine; the owner's own login; no prompt is sent, so no quota is spent beyond the init):** (a) run `bun -e` with `query({ prompt: endedAsyncIterable, options: { maxTurns: 1, settingSources: [] } })`, await `initializationResult()` and `accountInfo()`, print the fields — confirms the probe shape of `auth.ts`; (b) run one real `query` with the prompt "Use AskUserQuestion to ask me whether to continue, with two options" and a `canUseTool` that logs `toolName`, `input` and `options` and denies — confirms the `AskUserQuestion` input shape (`questions[].question/header/options[].label/description/multiSelect`) and whether the question arrives through `canUseTool` or a `PreToolUse` hook. Record both outputs in the report; adjust `ask-questions.ts` and the fixtures to the observed shape. If (b) spends a turn, do it once.

`plugins/agent-claude/src/provider.ts`:

```ts
import type { query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentCapabilities, AgentProvider, AgentSession, AuthStatus, CreateSessionRequest, Logger, ProfileRef } from '@bytebureau/plugin-api'
import { authStatusOf } from './auth.js'
import { claudeConfigOf } from './config.js'
import { resolveExecutable } from './executable.js'
import { ClaudeSession } from './session.js'

export type QueryFn = typeof query

export interface ClaudeDeps {
  readonly query: QueryFn
  readonly logger: Logger
  readonly resolveExecutable?: ((name: string) => string | undefined) | undefined
}

const CAPABILITIES: AgentCapabilities = { resume: true, interrupt: true, askUser: true, permissions: true, structuredOutput: false, usage: true, rateLimits: true, contextUsage: true, thinking: true, setModel: true, setEffort: false, attachments: false }

export class ClaudeAgentProvider implements AgentProvider {
  public readonly id = 'claude'
  public readonly displayName = 'Claude Code (Agent SDK)'
  public readonly capabilities = CAPABILITIES
  public readonly apiKeyEnv = 'ANTHROPIC_API_KEY'
  private readonly deps: ClaudeDeps

  public constructor(deps: ClaudeDeps) {
    this.deps = deps
  }

  public async authStatus(profile: ProfileRef): Promise<AuthStatus> {
    return authStatusOf(this.deps, profile, this.executableOf({}))
  }

  public async createSession(request: CreateSessionRequest): Promise<AgentSession> {
    await Promise.resolve()
    return new ClaudeSession(this.deps, request, this.executableOf(request.providerConfig))
  }

  // The user's claude where it is installed or configured; the SDK's bundled binary when none is found
  private executableOf(providerConfig: Readonly<Record<string, unknown>>): string | undefined {
    const resolve = this.deps.resolveExecutable ?? resolveExecutable
    return resolve(claudeConfigOf(providerConfig).executable ?? 'claude')
  }
}
```

`plugins/agent-claude/src/plugin.ts`:

```ts
import { query } from '@anthropic-ai/claude-agent-sdk'
import { definePlugin, type Plugin } from '@bytebureau/plugin-api'
import { ClaudeAgentProvider } from './provider.js'

export { ClaudeAgentProvider, type ClaudeDeps, type QueryFn } from './provider.js'

export const claudeAgentPlugin: Plugin = definePlugin({
  manifest: {
    name: 'agent-claude',
    version: '0.0.0',
    displayName: 'Claude Code (Agent SDK)',
    hostApi: '^0',
    kind: 'in-process',
    capabilities: ['process', 'net', 'secrets'],
    contributes: { agentProviders: ['claude'] },
  },
  setup(context) {
    return { agentProviders: [new ClaudeAgentProvider({ query, logger: context.logger })] }
  },
})
```

`plugins/agent-claude/src/testing/fake-query.ts`: `fakeQuery(script: { messages: readonly SDKMessage[]; onCanUseTool?: (invoke) => void })` returns a `QueryFn` whose `Query` yields the messages one per `prompt` pushed (reads the input iterable; after each user message yields the next scripted turn's messages), records `options`, exposes `interrupt`/`close`/`initializationResult`/`accountInfo` spies; `session.test.ts` covers: a prompt yields the mapped events in order; `externalRef` after init; a `canUseTool` call during a turn produces `ask.requested` and the answer resolves it; `interrupt()` denies pending asks and calls the SDK's interrupt; `close()` aborts and ends the events with `session.closed`; a query that throws ends with `session.error crash` then `session.closed`; the environment handed to the SDK carries `CLAUDE_CONFIG_DIR` for a login profile and nothing beyond `request.env`; no event ever contains the API key value present in `request.env` (canary). `auth.test.ts`: the three outcomes (loggedIn with account; loggedOut by a login error; unknown by another error; loggedOut by a missing directory without a query call). `provider.test.ts`: capabilities, `apiKeyEnv`, the executable resolution through `resolveExecutable` (configured path, PATH, none).

- [ ] **Step 7: The kernel answers the agent with the agent's own ask id**

`packages/kernel/src/sessions/live-sessions.ts`: `Live` gains `readonly askIds: Map<string, string>` (kernel ask id → the agent's id); `session-ask.ts` `open` stores `live.askIds.set(record.id, event.ask.id)` after `deps.asks.open(...)` and the answer path (`answerAgent` or where `live.agent.answer(record.id, answer)` is called) uses `live.askIds.get(record.id) ?? record.id` and deletes the entry; `session-agent-asks.test.ts` pins that the fake agent receives the id it asked with (give the fake ask a distinctive id and assert `FakeSession.answer` received it — extend the fake to record it). Run `bunx vitest run --project kernel`.

- [ ] **Step 8: Run the plugin suite and the gates**

Run: `bun install && bunx vitest run --project agent-claude --project kernel && bun run typecheck && bun run lint && bun run format:check && bun run spell && bun run knip && bun run depcruise && bun run lint:long-tail`
Expected: PASS; depcruise shows the plugin importing only plugin-api, protocol and third-party packages.

- [ ] **Step 9: Commit**

```bash
git add plugins/agent-claude bun.lock vitest.config.ts cspell-words.txt packages/kernel/src/sessions packages/kernel/src/testing
git commit -m "feat(agent-claude): run claude code through the agent sdk as a bytebureau provider"
git commit -m "fix(kernel): answer an agent's ask with the id the agent asked with"
```

---

### Task 7: `plugins/agent-acp` — any ACP v1 agent over stdio, with the fake ACP agent for the tests

**Files:**
- Create: `plugins/agent-acp/package.json`, `plugins/agent-acp/tsconfig.json`, `plugins/agent-acp/vitest.config.ts`, `plugins/agent-acp/src/plugin.ts`, `plugins/agent-acp/src/presets.ts`, `plugins/agent-acp/src/custom-preset.ts`, `plugins/agent-acp/src/provider.ts`, `plugins/agent-acp/src/process.ts`, `plugins/agent-acp/src/kill-ladder.ts`, `plugins/agent-acp/src/connection.ts`, `plugins/agent-acp/src/session.ts`, `plugins/agent-acp/src/session-turns.ts`, `plugins/agent-acp/src/mapping.ts`, `plugins/agent-acp/src/client-fs.ts`, `plugins/agent-acp/src/client-terminal.ts`, `plugins/agent-acp/src/permissions.ts`, `plugins/agent-acp/src/queue.ts` (the same `Queue<T>` as the Claude plugin's — a copy; the shared test-support package stays deferred), `plugins/agent-acp/src/testing/fake-acp-agent.ts`, `plugins/agent-acp/src/testing/run-fake.ts`, tests `presets.test.ts`, `client-fs.test.ts`, `client-terminal.test.ts`, `mapping.test.ts`, `permissions.test.ts`, `session.test.ts`, `session-crash.test.ts`, `provider.test.ts`
- Modify: `vitest.config.ts` (project `plugins/agent-acp`), `cspell-words.txt`
- Test: the plugin's tests under Node; the session tests spawn the fake agent with `process.execPath`

**Interfaces:**
- Consumes: Task 1's `providerConfig` and `apiKeyEnv`; the plugin-api ports and `PluginContext.process` (`ProcessSpawner.spawn(spec) → ExecHandle`); `@agentclientprotocol/sdk` 1.7.0: `ClientSideConnection`, `ndJsonStream`, `PROTOCOL_VERSION`, the schema types (`InitializeResponse`, `NewSessionResponse`, `PromptResponse`, `SessionNotification`, `RequestPermissionRequest/Response`, `ReadTextFileRequest`, `WriteTextFileRequest`, `CreateTerminalRequest`, `TerminalOutputResponse`, `WaitForTerminalExitResponse`) and `RequestError`.
- Produces: `export const acpAgentPlugin: Plugin` (manifest `agent-acp`, `displayName: 'ACP agents'`, `hostApi: '^0'`, `kind: 'in-process'`, `capabilities: ['process', 'fs:read', 'fs:write', 'net']`, `contributes: { agentProviders: ['acp:codex', 'acp:gemini', 'acp:opencode', 'acp:pi', 'acp:custom'] }`); `export interface Preset { readonly id: PresetId; readonly displayName: string; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly configDirEnv?: string; readonly apiKeyEnv?: string; readonly installHint: string; readonly loginHint: string }`; `export const PRESETS: Readonly<Record<Exclude<PresetId, 'custom'>, Preset>>`; `export class AcpAgentProvider implements AgentProvider` (constructor `(preset: PresetId, deps: AcpDeps)`, `AcpDeps = { readonly spawn: SpawnFn; readonly process: ProcessSpawner; readonly logger: Logger }`); `export class AcpSession implements AgentSession`; the fake agent `fake-acp-agent.ts` runnable as `node|bun fake-acp-agent.ts` with scripts chosen by `BYTEBUREAU_FAKE_ACP_SCRIPT` ∈ `hello` (default) | `slow` | `crash-mid-turn` | `crash-idle` | `escape` | `terminal`.

Semantics (as planned): a provider per preset (`acp:codex` → `codex-acp`, `acp:gemini` → `gemini --acp`, `acp:opencode` → `opencode acp`, `acp:pi` → `pi-acp`, `acp:custom` → the command of `providerConfig.presets.custom`); `createSession` spawns the agent with `node:child_process.spawn` (stdio pipes — the plugin-api's process port has no stdin, so the adapter owns this process: `cwd` = workspace, `env` = `request.env` + the preset's `env` + `[configDirEnv]: profile.configDir` for a `login` profile with a directory (the API key of an `api_key` profile is already in `request.env` under the preset's `apiKeyEnv`, put there by the kernel), kill ladder `SIGINT` → 5 s → `SIGTERM` → 5 s → `SIGKILL`, the last 50 stderr lines kept for error messages); `ENOENT` on spawn → `createSession` rejects with `` `${command} is not installed; ${installHint}; then ${loginHint}` `` (the kernel turns it into `provider_crash` with that reason: the CLI exits 4 with the line); a `custom` preset without `providerConfig.presets.custom.command` rejects with "providers.acp.presets.custom.command is not configured". The connection is `new ClientSideConnection((agent) => handlers, ndJsonStream(stdinWeb, stdoutWeb))`; `initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } })`; then `session/load { sessionId: resume.ref, cwd, mcpServers: [] }` when `request.resume` names this provider and the agent advertises `loadSession`, else `session/new { cwd, mcpServers: [] }`; `externalRef = { providerId, ref: sessionId }`. `prompt(text)` → `turn.started`, `session/prompt { sessionId, prompt: [{ type: 'text', text }] }` → on response `message.completed { role: 'assistant', content: [], text: <accumulated chunks> }` (once per turn when any chunk arrived) and `turn.completed { stopReason: response.stopReason === 'cancelled' ? 'interrupted' : response.stopReason, usage: lastUsage ?? { inputTokens: 0, outputTokens: 0 } }`; `interrupt()` → `session/cancel { sessionId }` (the running prompt returns `cancelled`); `answer(askId, answer)` resolves the pending `session/request_permission` of that id (`selected: ['<optionId>']` → `{ outcome: 'selected', optionId }`; `remember: 'always'` on an `allow_once` option is upgraded to the `allow_always` option of the same request when the agent offered one); `close()` → cancel if a turn runs, the kill ladder, the queues ended. Session updates → events: `agent_message_chunk` (`content.type === 'text'`) → `message.delta { kind: 'text' }`; `agent_thought_chunk` → `message.delta { kind: 'thinking' }`; `tool_call { toolCallId, title, kind, rawInput }` → `tool.started { id: toolCallId, name: title, kind: kindOf(kind) }` (`execute` → `'bash'`, `read`/`edit`/`delete`/`move`/`search`/`fetch`/`think`/`other` → `'builtin'`); `tool_call_update { toolCallId, status: 'completed' }` → `tool.completed { id, outputSummary: text of content/rawOutput (32 KB), bytes }`, `status: 'failed'` → `tool.failed`; `plan` → `session.warning { kind: 'plan', message: JSON.stringify(entries) }`; a `_meta['bytebureau.usage']` on any update → `usage.updated`, `_meta['bytebureau.rateLimit']` → `ratelimit.updated`; other kinds are ignored. Client methods: `readTextFile`/`writeTextFile` only inside the workspace (the real path of the parent directory must be inside the real workspace path; a path outside answers `RequestError.invalidParams('<path> is outside the workspace')`); `createTerminal` → `ctx.process.spawn({ command, args, cwd: cwd ?? workspace (confined), env: { ...request.env, ...env } })`, output buffered up to `outputByteLimit ?? 1 MiB` (the oldest bytes dropped and `truncated: true`), `terminalOutput`, `waitForExit` → `{ exitCode, signal }`, `killTerminal`, `releaseTerminal`; `requestPermission` → a `permission` ask (`title: toolCall.title`, one question `{ id: 'decision', header: 'Permission', prompt: 'Allow <title>?', options: the agent's options as `{ id: optionId, label: name, recommended: false, evidence: [] }`, multiSelect: false, allowOther: false }`, `toolCall: { name: title, input: rawInput }`, `recommendationSource: 'none'`), resolved by `answer` or cancelled (`{ outcome: { outcome: 'cancelled' } }`) on interrupt/close. Crashes: the child exits mid-turn → `session.error { kind: 'crash', message: 'the agent exited with code <n>: <last stderr line>', retryable: true }` then `session.closed`; exits idle → the session marks itself respawnable and the next `prompt()` spawns a new agent (a new ACP session) after `session.warning { kind: 'restart', message: 'the agent exited idle; starting it again (<n> of 3)' }`, three times at most — the fourth death is `session.error { kind: 'crash', retryable: false }`. `authStatus(profile)`: the command not on `PATH` → `unknown` with `installHint`; a `login` profile whose directory is gone → `loggedOut` with `loginHint`; otherwise `unknown` with `loginHint` (ACP v1 has `authenticate` but no status query; documented).

- [ ] **Step 1: The package and the fake agent**

`plugins/agent-acp/package.json` (as the Claude plugin's, with `"@agentclientprotocol/sdk": "1.7.0"`, `"zod": "4.6.5"`, the manifest `agent-acp`, capabilities `["process", "fs:read", "fs:write", "net"]`, `contributes.agentProviders` the five ids). `tsconfig.json`, `vitest.config.ts` (`name: 'agent-acp'`, `testTimeout: 30_000`) as before; the root `vitest.config.ts` gains the project.

`plugins/agent-acp/src/testing/fake-acp-agent.ts` — an ACP agent over stdio built with the SDK's agent side (`AgentSideConnection` with `ndJsonStream(process.stdout web, process.stdin web)`), scripted by `BYTEBUREAU_FAKE_ACP_SCRIPT`:

```ts
import { Readable, Writable } from 'node:stream'
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, type Agent, type Client } from '@agentclientprotocol/sdk'

const script = process.env['BYTEBUREAU_FAKE_ACP_SCRIPT'] ?? 'hello'
const apiKeyPresent = process.env['FAKE_ACP_API_KEY'] !== undefined

const text = (value: string) => ({ type: 'text' as const, text: value })

// What the hello script does: thinks, says hello, asks for permission to write src/hello.ts, writes it through the client, reports the tool
class FakeAgent implements Agent {
  private readonly client: Client
  private cancelled = false
  public constructor(client: Client) { this.client = client }

  public async initialize() {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false } }, authMethods: [] }
  }
  public async newSession(params: { cwd: string }) { this.cwd = params.cwd; return { sessionId: 'fake-acp-1' } }
  public async loadSession(params: { sessionId: string; cwd: string }) { this.cwd = params.cwd; return {} }
  public async cancel() { this.cancelled = true }
  public async prompt(params: { sessionId: string }) {
    const update = async (payload: object) => this.client.sessionUpdate({ sessionId: params.sessionId, update: payload })
    await update({ sessionUpdate: 'agent_thought_chunk', content: text('thinking') })
    await update({ sessionUpdate: 'agent_message_chunk', content: text(`hello; api key ${apiKeyPresent ? 'present' : 'absent'}`) })
    if (script === 'crash-mid-turn') { process.exit(1) }
    if (script === 'slow') { while (!this.cancelled) { await new Promise((resolve) => setTimeout(resolve, 50)) } return { stopReason: 'cancelled' } }
    if (script === 'escape') { await this.client.readTextFile({ sessionId: params.sessionId, path: `${this.cwd}/../outside.txt` }); return { stopReason: 'end_turn' } }
    if (script === 'terminal') { const term = await this.client.createTerminal({ sessionId: params.sessionId, command: process.execPath, args: ['-e', 'console.log("ok")'] }); await this.client.waitForTerminalExit({ sessionId: params.sessionId, terminalId: term.terminalId }); const out = await this.client.terminalOutput({ sessionId: params.sessionId, terminalId: term.terminalId }); await this.client.releaseTerminal({ sessionId: params.sessionId, terminalId: term.terminalId }); await update({ sessionUpdate: 'agent_message_chunk', content: text(`terminal said ${out.output.trim()}`) }); return { stopReason: 'end_turn' } }
    await update({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Write src/hello.ts', kind: 'edit', status: 'pending', rawInput: { path: 'src/hello.ts' } })
    const permission = await this.client.requestPermission({ sessionId: params.sessionId, toolCall: { toolCallId: 'call-1', title: 'Write src/hello.ts', kind: 'edit', status: 'pending', rawInput: { path: 'src/hello.ts' } }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] })
    if (permission.outcome.outcome !== 'selected' || permission.outcome.optionId !== 'allow') { await update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'failed', rawOutput: 'denied' }); return { stopReason: 'end_turn' } }
    await this.client.writeTextFile({ sessionId: params.sessionId, path: `${this.cwd}/src/hello.ts`, content: "export function hello(): string {\n  return 'hello'\n}\n" })
    await update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', rawOutput: 'written', _meta: { 'bytebureau.usage': { inputTokens: 7, outputTokens: 3 } } })
    if (script === 'crash-idle') { setTimeout(() => process.exit(0), 100) }
    return { stopReason: 'end_turn' }
  }
  private cwd = ''
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
new AgentSideConnection((client) => new FakeAgent(client), stream)
```

(Match the SDK's `Agent` interface method names and the request/response types the compiler shows — `newSession`, `loadSession`, `prompt`, `cancel`, `authenticate`; the `sessionUpdate` payloads are typed `SessionNotification['update']`; `writeTextFile` of a path whose parent is missing must be created by the client — the adapter's `writeTextFile` does `mkdirSync(dirname, { recursive: true })` inside the workspace. `run-fake.ts` exports `fakeAgentCommand(script) = { command: process.execPath, args: [path to fake-acp-agent.ts], env: { BYTEBUREAU_FAKE_ACP_SCRIPT: script } }` — under Node the file must run as TypeScript: the tests run on Node 24+ with `--experimental-strip-types`? Phase A's `node-spawner.ts` already runs TypeScript test helpers; follow its approach (`process.execPath` with `--experimental-strip-types`, or the compiled JS path Vitest provides). Under the daemon (Bun) in Task 8, `bun <path>.ts` runs directly.)

- [ ] **Step 2: The failing tests**

`plugins/agent-acp/src/session.test.ts` (the hello flow end to end against the fake agent; the test supplies `AcpDeps` with `spawn` = `node:child_process.spawn` and a tiny `ProcessSpawner` over `child_process` for terminals, plus a recording logger):

```ts
it('runs a prompt through a real ACP agent: thinking, text, a permission brokered as an ask, the file written inside the workspace, usage from _meta', async () => {
  expect.hasAssertions()
  const workspace = tempDir('bb-acp-ws-')
  const provider = new AcpAgentProvider('custom', deps)
  const session = await provider.createSession(requestWith({ workspace, providerConfig: { presets: { custom: fakeAgentCommand('hello') } } }))
  const seen: AgentEvent[] = []
  const reading = (async () => { for await (const event of session.events()) { seen.push(event); if (event.type === 'ask.requested') { await session.answer(event.ask.id, { selected: ['allow'] }) } if (event.type === 'turn.completed') { break } } })()
  await session.prompt({ text: 'Create src/hello.ts' })
  await reading
  expect(seen.map((event) => event.type)).toStrictEqual(['turn.started', 'message.delta', 'message.delta', 'tool.started', 'ask.requested', 'tool.completed', 'usage.updated', 'message.completed', 'turn.completed'])
  expect(seen[1]).toStrictEqual({ type: 'message.delta', kind: 'thinking', text: 'thinking' })
  expect(readFileSync(path.join(workspace, 'src', 'hello.ts'), 'utf8')).toContain('export function hello')
  expect(session.externalRef).toStrictEqual({ providerId: 'acp:custom', ref: 'fake-acp-1' })
  await session.close()
})

it('refuses a read outside the workspace, so the agent gets an error instead of the file', async () => { /* script escape: the turn completes and the agent's error is a tool.failed or a session.warning kind 'fs'; outside.txt is never read: the test writes it one level above the workspace and asserts the agent's message does not carry its content */ })

it('cancels a slow turn on interrupt and ends it as interrupted', async () => { /* script slow: prompt, wait for turn.started, interrupt(), expect turn.completed stopReason 'interrupted' */ })

it('serves a terminal to the agent inside the workspace and gives it the output', async () => { /* script terminal: expect a message.delta containing 'terminal said ok' */ })
```

`plugins/agent-acp/src/session-crash.test.ts`: `crash-mid-turn` → `session.error { kind: 'crash', retryable: true }` then `session.closed`; `crash-idle` → after the first turn completes, the agent exits; the second `prompt()` emits `session.warning { kind: 'restart' }` and completes; a provider told to crash idle every time ends with `session.error { retryable: false }` on the fourth start. `provider.test.ts`: `ENOENT` → rejection naming the install and login hints; `custom` without a command → rejection naming `providers.acp.presets.custom.command`; `authStatus` outcomes; `apiKeyEnv` per preset; capabilities. `client-fs.test.ts`: inside/outside judgements including a symlink out of the workspace. `client-terminal.test.ts`: output cap and `truncated`, exit status, kill. `mapping.test.ts`: every update kind to its event. `permissions.test.ts`: the ask shape and the outcome mapping incl. `remember: 'always'` → `allow_always` when offered. `presets.test.ts`: the four commands and hints as the fact sheet lists them.

- [ ] **Step 3: Run the tests to see them fail**

Run: `bunx vitest run --project agent-acp`
Expected: FAIL — the modules do not exist.

- [ ] **Step 4: Presets, process, connection**

`plugins/agent-acp/src/presets.ts`:

```ts
export type PresetId = 'codex' | 'gemini' | 'opencode' | 'pi' | 'custom'

export interface Preset {
  readonly id: PresetId
  readonly displayName: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  // The variable a login profile's directory travels in, where the agent has one
  readonly configDirEnv?: string | undefined
  // The variable an API-key profile's key travels in, where the agent takes one
  readonly apiKeyEnv?: string | undefined
  readonly installHint: string
  readonly loginHint: string
}

export const PRESETS: Readonly<Record<Exclude<PresetId, 'custom'>, Preset>> = {
  codex: { id: 'codex', displayName: 'Codex (ACP)', command: 'codex-acp', args: [], env: {}, configDirEnv: 'CODEX_HOME', apiKeyEnv: 'OPENAI_API_KEY', installHint: 'install it with: npm install -g @agentclientprotocol/codex-acp', loginHint: 'log in with: codex login' },
  gemini: { id: 'gemini', displayName: 'Gemini CLI (ACP)', command: 'gemini', args: ['--acp'], env: {}, apiKeyEnv: 'GEMINI_API_KEY', installHint: 'install it with: npm install -g @google/gemini-cli', loginHint: 'log in once by running: gemini' },
  opencode: { id: 'opencode', displayName: 'OpenCode (ACP)', command: 'opencode', args: ['acp'], env: {}, installHint: 'install it with: npm install -g opencode-ai', loginHint: 'log in with: opencode auth login' },
  pi: { id: 'pi', displayName: 'pi (ACP)', command: 'pi-acp', args: [], env: {}, installHint: 'install it with: npm install -g pi-acp @earendil-works/pi-coding-agent', loginHint: 'configure pi as its documentation says' },
}

export const providerIdOf = (preset: PresetId): string => `acp:${preset}`
```

`plugins/agent-acp/src/custom-preset.ts`: a zod schema `{ presets: { custom: { command: string, args?: string[], env?: Record<string,string>, configDirEnv?: string, apiKeyEnv?: string } } }` (passthrough for other presets' overrides: `presets.<id>.{command,args,env}` may override a built-in preset's command — read as `presetOf(id, providerConfig)` merging overrides onto `PRESETS[id]`); a `custom` without `command` → `throw new Error('providers.acp.presets.custom.command is not configured')`.

`plugins/agent-acp/src/process.ts`:

```ts
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import type { Preset } from './presets.js'

export type SpawnFn = typeof nodeSpawn

export interface AgentProcess {
  readonly child: ChildProcess
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>
  readonly recentStderr: () => readonly string[]
}

const STDERR_LINES = 50

// The agent of a preset, started in the workspace with the environment the kernel allowed and what the preset and the profile add
export const spawnAgent = (spawn: SpawnFn, preset: Preset, options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }): Promise<AgentProcess> =>
  new Promise((resolve, reject) => {
    const child = spawn(preset.command, [...preset.args], { cwd: options.cwd, env: { ...options.env, ...preset.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    const stderr: string[] = []
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { for (const line of chunk.split('\n')) { if (line !== '') { stderr.push(line); if (stderr.length > STDERR_LINES) { stderr.shift() } } } })
    const exited = new Promise<{ code: number | null; signal: string | null }>((done) => { child.once('exit', (code, signal) => done({ code, signal })) })
    child.once('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'ENOENT' ? new Error(`${preset.command} is not installed; ${preset.installHint}; then ${preset.loginHint}`) : error)
    })
    child.once('spawn', () => resolve({ child, exited, recentStderr: () => [...stderr] }))
  })
```

(No `?.` — write `const err = child.stderr; if (err !== null) { … }`.)

`plugins/agent-acp/src/kill-ladder.ts`: `endProcess(child, exited)`: `SIGINT`, wait 5 s or exit, `SIGTERM`, wait 5 s or exit, `SIGKILL`; returns the exit.

`plugins/agent-acp/src/connection.ts`:

```ts
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client, type InitializeResponse } from '@agentclientprotocol/sdk'
import type { AgentProcess } from './process.js'

export interface Connected { readonly connection: ClientSideConnection; readonly initialized: InitializeResponse }

// The agent's stdio as ACP: the client handlers serve the agent's requests, the connection carries ours
export const connectAgent = async (agent: AgentProcess, handlers: (connection: ClientSideConnection) => Client): Promise<Connected> => {
  const { stdin, stdout } = agent.child
  if (stdin === null || stdout === null) { throw new Error('the agent has no stdio') }
  const stream = ndJsonStream(Writable.toWeb(stdin), Readable.toWeb(stdout))
  const connection = new ClientSideConnection(handlers, stream)
  const initialized = await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } })
  return { connection, initialized }
}
```

- [ ] **Step 5: Client handlers, mapping, permissions, the session, the provider, the plugin**

`client-fs.ts`: `insideWorkspace(workspace, target)` (realpath of the existing part of `target`'s path, `path.relative` not climbing), `readTextFile` (`line`/`limit` honoured when given), `writeTextFile` (`mkdirSync` of the parent inside the workspace, write utf8); outside → `throw RequestError.invalidParams(\`${path} is outside the workspace\`)`. `client-terminal.ts`: `Terminals` class over `ProcessSpawner` (create/output/waitForExit/kill/release; the buffer with `outputByteLimit`, default 1 MiB). `permissions.ts`: `PermissionBroker` (pending by `toolCallId`; `request(params)` returns the response promise and queues `ask.requested`; `answer(askId, answer)`; `cancelAll()`). `mapping.ts`: `mapUpdate(update): readonly AgentEvent[]` as the semantics say, plus `metaEvents(update._meta)`. `session.ts` + `session-turns.ts`: `AcpSession` holding `request`, `preset`, `deps`, the queues, `attempt` (restarts), `agent` (process + connection + sessionId), `turn` (running prompt promise, accumulated text, last usage); `start()` (spawn, connect, new/load, watch `exited`: mid-turn → `session.error` crash + `session.closed`; idle → `respawnable = true`); `prompt()` (respawn if needed, `turn.started`, the prompt call, the completion events); `interrupt()`; `answer()`; `events()`; `close()`. `provider.ts`: `AcpAgentProvider(preset, deps)` with `id = providerIdOf(preset)`, `displayName`, `apiKeyEnv` from the preset (custom: from the config at session time — `apiKeyEnv` is static per provider; for `acp:custom` it is `undefined` unless `BYTEBUREAU_ACP_CUSTOM_API_KEY_ENV`… keep `acp:custom` without API-key profiles in SP1, documented), capabilities `{ resume: true, interrupt: true, askUser: false, permissions: true, structuredOutput: false, usage: false, rateLimits: false, contextUsage: false, thinking: true, setModel: false, setEffort: false, attachments: false }`, `authStatus` as the semantics say, `createSession` → `AcpSession.start(...)`. `plugin.ts`: `acpAgentPlugin` registering the five providers with `deps = { spawn, process: context.process, logger: context.logger }`.

- [ ] **Step 6: Run the plugin suite and the gates**

Run: `bun install && bunx vitest run --project agent-acp && bun run typecheck && bun run lint && bun run format:check && bun run spell && bun run knip && bun run depcruise && bun run lint:long-tail`
Expected: PASS; no fake agent process left (`ps -axo pid,command | grep fake-acp-agent`).

- [ ] **Step 7: Commit**

```bash
git add plugins/agent-acp bun.lock vitest.config.ts cspell-words.txt
git commit -m "feat(agent-acp): run any acp v1 agent over stdio as a bytebureau provider, with a fake agent for the tests"
```

---

### Task 8: Bundling and the end-to-end runs through the daemon

**Files:**
- Modify: `packages/kernel/src/plugins/bundled.ts` (`claudeAgentPlugin`, `acpAgentPlugin`), `packages/kernel/package.json` (dependencies on the two plugin workspaces), `packages/kernel/src/plugins/plugin-host.test.ts` (four bundled plugins), `apps/bytebureau/src/commands/run-session.ts` (`isRefusal`: a `provider_crash` whose reason says "is not installed" or "is not configured" is a refusal → exit 4, so Review Focus 5 holds), `apps/bytebureau/src/testing/repo-config.ts` or the test that writes the project config (the custom preset pointing at the fake agent)
- Create: `apps/bytebureau/src/commands/run-acp.test.ts`, `apps/bytebureau/src/commands/plugins-bundled.test.ts`
- Test: the two new daemon-backed test files

**Interfaces:**
- Consumes: Tasks 6–7's plugins; Phase B's daemon-backed test helpers (`startDaemonProcess`, `runCli`, `testHome`, `createTempRepo`, `writeConfig`, `jsonLines`, `Interruption`).
- Produces: a daemon whose `plugins ls` lists `workspace-local`, `agent-fake`, `agent-claude`, `agent-acp` as loaded, whose `plugins providers` lists `fake`, `claude`, `acp:codex`, `acp:gemini`, `acp:opencode`, `acp:pi`, `acp:custom`; `run --provider acp:custom` end to end with the fake ACP agent as the custom command.

- [ ] **Step 1: The failing end-to-end tests**

`apps/bytebureau/src/commands/run-acp.test.ts`:

```ts
const customPreset = { command: 'bun', args: [fakeAcpAgentPath()] }

it('runs a prompt through an ACP agent over the daemon: the permission is answered by --yes, the file lands in the worktree, exit 0', async () => {
  expect.hasAssertions()
  const home = testHome()
  const daemon = await startDaemonProcess(home)
  const repo = createTempRepo()
  writeConfig(repo, { providers: { acp: { presets: { custom: customPreset } } } })
  const run = await runCli(['run', 'Create src/hello.ts exporting hello()', '--project', repo, '--provider', 'acp:custom', '--json', '--yes'], { home })
  expect(run.code).toBe(0)
  const types = jsonLines(run.stdout).map((event) => event['type'])
  expect(types).toContain('ask.requested')
  expect(types).toContain('ask.answered')
  expect(types.at(-1)).toBe('session.completed')
  expect(existsSync(path.join(repo, '.bytebureau', 'worktrees', worktreeOf(run.stdout), 'src', 'hello.ts'))).toBe(true)
  await daemon.stop()
})

it('ends with exit 3 and a ready session when the run is interrupted while the agent waits for a permission', async () => { /* script hello without --yes, non-TTY: the ask waits; Interruption after ask.requested with SIGINT → exit 3; sessions show says ready */ })

it('refuses a custom preset without a command, and a vendor agent that is not installed, with exit 4 and the hint', async () => {
  expect.hasAssertions()
  const home = testHome()
  const daemon = await startDaemonProcess(home)
  const repo = createTempRepo()
  const unconfigured = await runCli(['run', 'x', '--project', repo, '--provider', 'acp:custom'], { home })
  expect([unconfigured.code, unconfigured.stderr]).toStrictEqual([4, expect.stringContaining('providers.acp.presets.custom.command')])
  writeConfig(repo, { providers: { acp: { presets: { codex: { command: 'codex-acp-definitely-missing' } } } } })
  const missing = await runCli(['run', 'x', '--project', repo, '--provider', 'acp:codex'], { home })
  expect([missing.code, missing.stderr]).toStrictEqual([4, expect.stringContaining('npm install -g @agentclientprotocol/codex-acp')])
  await daemon.stop()
})

it('hands an API-key profile of an ACP provider to the agent as the preset names it', async () => { /* profiles add acp:codex key --api-key with the codex preset's command overridden to the fake agent and apiKeyEnv honoured: the fake agent says 'api key present' (FAKE_ACP_API_KEY is what the test's override sets as apiKeyEnv through presets.codex.apiKeyEnv) */ })
```

`plugins-bundled.test.ts`: `plugins ls --json` lists the four plugins loaded; `plugins providers` (if the CLI exposes it; else through the client) lists the seven providers; `profiles add claude work` on a daemon prints the `CLAUDE_CONFIG_DIR=… claude /login` hint (the Claude provider's `authStatus` for a fresh directory runs the probe — on CI `claude` is absent, so the SDK's bundled binary would run: refuse the probe when `BYTEBUREAU_TEST_NO_CLAUDE=1`? No — make the probe honest: without an installed `claude` and without a login, the probe ends `loggedOut` or `unknown` quickly; the test only asserts the hint text, not the state).

- [ ] **Step 2: Run them to see them fail**

Run: `bunx vitest run --project bytebureau apps/bytebureau/src/commands/run-acp.test.ts apps/bytebureau/src/commands/plugins-bundled.test.ts`
Expected: FAIL — `provider "acp:custom" is not available`.

- [ ] **Step 3: Bundle and refine the refusal**

`packages/kernel/src/plugins/bundled.ts`:

```ts
import { acpAgentPlugin } from '@bytebureau/agent-acp'
import { claudeAgentPlugin } from '@bytebureau/agent-claude'
import type { Plugin } from '@bytebureau/plugin-api'
import { localWorkspacePlugin } from '@bytebureau/workspace-local'
import { fakeAgentPlugin } from '../testing/fake-agent-plugin.js'

export const HOST_API_VERSION = '0.0.0'
// The fake agent ships on purpose: it is the documented way to smoke-test an installation without an agent subscription
export const BUNDLED_PLUGINS: readonly Plugin[] = [localWorkspacePlugin, fakeAgentPlugin, claudeAgentPlugin, acpAgentPlugin]
```

`packages/kernel/package.json`: `"@bytebureau/agent-acp": "workspace:*"`, `"@bytebureau/agent-claude": "workspace:*"` (check `.dependency-cruiser.cjs`: the kernel may import `plugins/*` entry points as it does `@bytebureau/workspace-local`). `run-session.ts` `isRefusal`: a `ProviderError`/`ApiError` of kind `crash` whose reason matches `/is not installed|is not configured/u` counts as a refusal (exit 4). Run the tests; then `bun run check`.

- [ ] **Step 4: Run the whole suite and the gates**

Run: `bun run check && bun run lint:actions` (if any workflow changed — none should)
Expected: PASS; the daemon-backed suite stable over two runs; `ps` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel apps/bytebureau bun.lock
git commit -m "feat(kernel): bundle the claude and acp agent providers, and tell a missing agent as a refusal"
```

---

### Task 9: Smoke scripts, docs, spec amendments, deferrals, gates

**Files:**
- Create: `scripts/smoke-claude.ts`, `scripts/smoke-acp.ts`, `apps/docs/src/content/docs/agents-and-profiles.md`
- Modify: `package.json` (`smoke:claude`, `smoke:acp` scripts), `apps/docs/astro.config.mjs` (sidebar entry `{ label: 'Agents and profiles', translations: { cs: 'Agenti a profily' }, link: '/agents-and-profiles/' }` after `daemon-and-api`), `apps/docs/src/content/docs/architecture.md` (package table rows `plugins/agent-claude`, `plugins/agent-acp`; "Phase C decisions"; the "Deferred to later phases" list rewritten), `apps/docs/src/content/docs/daemon-and-api.md` (the `profiles` group rows, `GET /usage/profiles/:id`, the new problem codes, `run --profile`), `CONTRIBUTING.md` ("Working on an agent adapter"), `README.md` + `README.cs.md` (status line: Phase C), `docs/superpowers/specs/2026-10-02-kernel-and-agent-runtime-design.md` (amendments below), `.github/labeler.yml` (`'area: agents': plugins/agent-*/**`), `.github/workflows/semantic-pr.yml` (scopes `agent-claude`, `agent-acp`), `scripts/repo-settings/labels.txt` (`area: agents` exists already)
- Test: `bun run check`, `bun run lint:actions`, the docs build, the fresh-clone gate

Semantics: Phase C is done when a fresh clone passes every gate, `bytebureau plugins ls` on the compiled binary lists the two adapters, `bytebureau run --provider acp:custom` with the fake ACP agent as the command runs end to end through the daemon in CI (Task 8's test), and the docs, the spec and the research index say what the code does. The real-agent smoke scripts run only on demand.

- [ ] **Step 1: The smoke scripts**

`scripts/smoke-claude.ts` — refuses to run without `SMOKE_REAL_AGENTS=1`; on a temp home, registers a temp repository, runs `bytebureau run "Create src/hello.ts exporting hello()" --provider claude [--profile $SMOKE_PROFILE] --json --yes` through a daemon started from source (`bun run --cwd apps/bytebureau src/main.ts …`), prints the exit code, the `turn.completed` usage, whether `ratelimit.updated` and `contextPct` were seen (acceptance 2), then `sessions stop`/`resume`/`sessions prompt` once to show the resume path, stops the daemon and removes the home. `scripts/smoke-acp.ts` the same with `--provider acp:${SMOKE_ACP_PRESET ?? 'opencode'}` (acceptance 3). `package.json`: `"smoke:claude": "SMOKE_REAL_AGENTS=1 bun scripts/smoke-claude.ts"`, `"smoke:acp": "SMOKE_REAL_AGENTS=1 bun scripts/smoke-acp.ts"`. Neither runs in CI.

- [ ] **Step 2: Docs**

`apps/docs/src/content/docs/agents-and-profiles.md`: *Providers* (`fake`, `claude`, `acp:<preset>`; what each needs installed; `providers.<id>` options — `claude.executable`, `claude.settingSources`, `acp.presets.<id>.{command,args,env,configDirEnv,apiKeyEnv}`, `passEnv`); *Profiles* (`profiles add <provider> <name>` login flow with the printed command, `--api-key` from the prompt or stdin, the default per provider, `run --profile`, `profiles status`, where a login profile lives — `~/.bytebureau/profiles/<provider>/<name>`, `profiles rm --purge`); *Secrets* (the keychain through `Bun.secrets`, the file fallback `~/.bytebureau/secrets.json` 0600, `secrets.backend` in `config.json`, what `doctor` will show); *Permissions and questions* (supervised vs autonomous, how an ask looks for Claude and for ACP agents, the recommended option convention); *What the adapters report* (usage, rate limits, context, compaction, retries; what ACP agents cannot report); *Limits in this phase* (API-key profiles for `acp:custom`, ACP `authStatus` unknown, no age-encrypted fallback, the restart policy as shipped). `architecture.md`: the two plugin rows (FSL), "Phase C decisions" (profile ids `provider/name`; the store as the one source of profiles; `Bun.secrets` + file fallback instead of age; the adapter spawns its ACP agent because the process port has no stdin; `providerConfig` per session; `apiKeyEnv` declared by the provider; the Agent SDK's `permissionMode: 'default'` given explicitly; `authStatus` through `accountInfo()`; lazy respawn ≤ 3), the deferred list rewritten (age-encrypted fallback and a passphrase; ACP `authenticate`-based status; `profiles` in the user configuration; model lists (`listModels`); `setEffort` for Claude; attachments; the nightly real-agent workflow; `doctor` (Phase D) showing the secrets backend and the agent CLIs). `daemon-and-api.md`: the `profiles` rows and codes. `CONTRIBUTING.md` "Working on an agent adapter": fixtures are the truth of the SDK's shapes, how to re-record them (the smoke scripts with `--json`), the fake ACP agent and its scripts, never a real agent in CI, where keys may travel. READMEs: "Phase C in place: real agents through the Claude Agent SDK and any ACP agent, under named auth profiles with keys in the keychain" / the Czech twin ("Fáze C hotová: skuteční agenti přes Claude Agent SDK a libovolný ACP agent, pod pojmenovanými přihlašovacími profily s klíči v klíčence").

- [ ] **Step 3: Spec amendments (one sentence each, marked "(amended in Phase C …)")**

- §4 `SecretStore` row: `Bun.secrets` (Keychain, libsecret, Credential Manager) with a 0600 file under the home as the fallback; `backend()` reported by health and `doctor`; the age-encrypted fallback deferred.
- §4 `ProfileService` row: profile ids `<provider>/<name>`, the store as the one source, `resolve()` for sessions.
- §6: `AgentProvider.apiKeyEnv?`, `CreateSessionRequest.providerConfig`.
- §7: an in-process agent plugin may spawn its own agent process when the port's process spawner cannot serve it (ACP needs stdin); the kernel's allowlisted environment still applies through the request.
- §8.1: `authStatus()` is implemented through `initializationResult()` + `accountInfo()` and the `auth_status` message; `permissionMode` is passed explicitly; `settingSources` default; the user's `claude` through `pathToClaudeCodeExecutable`.
- §8.2: the preset commands as shipped (`codex-acp` from `@agentclientprotocol/codex-acp`, `gemini --acp`, `opencode acp`, `pi-acp`), `acp:custom`, the lazy respawn, `authStatus` unknown.
- §10: `UserConfig.secrets.backend`; `providers.<id>` reaches the adapter per session.
- §11.1/§11.3: the `profiles` endpoints and commands as shipped; `--api-key` never an argument.
- §13: profile variables as shipped (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, the API-key variable).
- §14: provider crash as shipped (mid-turn → errored + `session.error retryable`; idle → lazy respawn ≤ 3).
- §15: the fixtures and the fake ACP agent; the smoke scripts.

- [ ] **Step 4: CI and labels**

`.github/labeler.yml`: `'area: agents': plugins/agent-*/**` in the file's form; `.github/workflows/semantic-pr.yml`: scopes `agent-claude`, `agent-acp`; run `bun run lint:actions`. The root `vitest.config.ts` projects already carry the two plugins (Tasks 6–7); the CI `unit` jobs run them. No new smoke job: the ACP end-to-end runs inside the unit job through Task 8's test (the daemon spawns `bun fake-acp-agent.ts`).

- [ ] **Step 5: Fresh-clone gate**

From a fresh clone of the final commit (under the scratchpad): `bun install --frozen-lockfile && bun run check && bun run lint:actions && bun run build:binaries --host`; then on a temp home: `bytebureau plugins ls` lists four plugins; `bytebureau run … --provider acp:custom` with `providers.acp.presets.custom = { command: 'bun', args: [<fake agent path>] }` in a temp repo's `bytebureau.json` ends with exit 0; `bytebureau profiles add fake key --api-key` with a piped key, `profiles ls`, `profiles status`, `profiles rm`; `serve --stop`. Every command exits 0; nothing is left running; the clone is removed.

- [ ] **Step 6: Commit**

```bash
git add scripts package.json apps/docs CONTRIBUTING.md README.md README.cs.md docs .github scripts/repo-settings
git commit -m "docs(repo): describe the agent providers, the profiles and the secrets; amend the spec for phase c"
git commit -m "ci(ci): label the agent plugins and accept their commit scopes"
```
