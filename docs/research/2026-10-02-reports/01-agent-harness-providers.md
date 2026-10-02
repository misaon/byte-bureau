# 01 — Agent harnesses, protocols, and model/provider access

Research cluster for **ByteBureau** · researched 2026-10-02 · all versions/dates below were observed on that day unless stated. "unverified" = only one or only a third-party source.

---

## 1) Executive summary

- **The zero-cost Claude path is legal today but policy-volatile.** Anthropic's own docs (code.claude.com/docs/en/legal-and-compliance, support article 15036540, updated 2026-06-16) say: OAuth/subscription auth is "designed to support ordinary use of Claude Code and other native Anthropic applications"; an end user may sign in to the **unmodified Claude Code binary** with their own subscription even when a platform hosts it; and, as of the June 15 2026 pause, "Claude Agent SDK usage, `claude -p`, and third-party apps still draw from subscription limits". What is **forbidden**: offering claude.ai login inside your own product, collecting/storing/intermediating Claude.ai credentials or session tokens, routing requests through Free/Pro/Max credentials on behalf of other users, modifying the binary. Anthropic flipped this policy four times in 2026 (Jan 9 block → reversal; Feb 20 "not permitted" wording; Apr 5 cut-off; May 13 reinstatement with planned "Agent SDK credits"; Jun 15 pause). ByteBureau must treat the subscription path as a **user-owned login that ByteBureau never touches**, with API-key and local-model fallbacks one config switch away.
- **Two first-class vendor harnesses exist with real SDKs:** `@anthropic-ai/claude-agent-sdk` **0.3.287** (bundles Claude Code **2.1.287**; subagents, hooks, MCP, `canUseTool`/AskUserQuestion, `outputFormat` JSON-schema, `effort` low→max, resume/fork, `sessionStore` for cross-host resume, `getContextUsage()`, `accountInfo()`, `maxBudgetUsd`) and OpenAI's **Codex 0.160.0** (`@openai/codex-sdk` 0.160.0 spawns the CLI over JSONL; `codex exec --json --output-schema`; `codex app-server` JSON-RPC over stdio/WebSocket, officially "experimental and unsupported for production"). OpenAI's **Sign in with ChatGPT** (launched 2026-09-29) explicitly lets **open-source tools** use a user's Plus/Pro plan (OpenCode, Pi, OpenClaw, T3 are listed) with per-app weekly caps — ByteBureau, as OSS, can apply for a client ID.
- **ACP (Agent Client Protocol) is the right shape for ByteBureau's "agent runtime" plugin interface.** v1 is the stable wire version (`@agentclientprotocol/sdk` 1.6.0, Apache-2.0; v2 is a draft with experimental HTTP/WS streams), 60+ agents are in the Zed/JetBrains registry, and maintained adapters exist for Claude (`@agentclientprotocol/claude-agent-acp` 0.85.0, on Agent SDK 0.3.286) and Codex (`@agentclientprotocol/codex-acp` 2.1.1). OpenCode (`opencode acp`), Kilo (`kilo acp`), Gemini CLI, Goose, Mistral Vibe, Pi, Copilot, Cursor, Droid all speak it. Gaps: no usage/rate-limit or cost reporting, editor-centric fs/terminal model — so ByteBureau should use **native adapters** for Claude and Codex (richer telemetry) and **ACP as the generic adapter** for everything else.
- **MCP 2026-07-28 is the current spec** (stateless core, `server/discover`, Multi-Round-Trip Requests replacing server-initiated elicitation/sampling, Tasks and MCP Apps as official extensions, Roots/Sampling/Logging deprecated); TS SDK 1.31.0. **A2A v1.0** (Linux Foundation; `@a2a-js/sdk` 1.3.0; IBM's ACP merged into A2A Aug 2025) and **AG-UI 1.0** (2026-09-30; `@ag-ui/core` 1.0.1) are complementary and belong in optional plugins, not the core.
- **OpenCode 1.18.34** (anomalyco/opencode, MIT, 211k stars, released 2026-09-30) is a credible *pluggable backend*: `opencode serve` exposes an OpenAPI 3.1 + SSE server, `@opencode-ai/sdk` 1.18.34 is a typed client, `@opencode-ai/plugin` hooks, 75+ providers via Models.dev, ChatGPT subscription login is an official OpenAI partner integration — but Anthropic forced removal of Claude Pro/Max login (its docs now say "Anthropic explicitly prohibits" it). Ship it as a plugin, not the core.
- **For ByteBureau's own lightweight agents use Vercel AI SDK 7** (`ai` 7.0.127, Apache-2.0, Node ≥22; `ToolLoopAgent`, tool approvals, `WorkflowAgent` durability, MCP incl. MCP Apps, OTel telemetry, and an *experimental* `HarnessAgent` with `@ai-sdk/harness-claude-code|codex|pi|opencode` adapters). Mastra 1.74.0 and LangGraph.js 1.4.18 are solid but heavier; OpenAI Agents SDK JS 0.18.0 is OpenAI-centric; Google ADK-JS, Inngest AgentKit (stale) and Effect AI (alpha) are rejected for the core.
- **Local/free inference:** Ollama (Anthropic Messages API compat since v0.14.0, 2026-01-16; `ollama launch claude|opencode|codex|droid` since v0.15; Cloud free starter credits), LM Studio (`@lmstudio/sdk` 2.0.0; OpenAI + Anthropic compatible endpoints; headless `llmster`), llama.cpp (build b11327, 2026-10-01), MLX community servers on Apple Silicon; free remote tiers: Gemini CLI OAuth 60 RPM/1,000 req/day, OpenRouter `:free` 20 RPM and 50 req/day (1,000/day after $10 credits), Mistral "Experiment" tier (limits no longer published). Use **Models.dev `api.json`** as the model registry.
- **Usage visibility:** Claude Code itself exposes plan windows in the status-line JSON (`rate_limits.five_hour|seven_day.used_percentage/resets_at`, Pro/Max only) and the SDK's `accountInfo()`; the undocumented `GET /api/oauth/usage` (header `anthropic-beta: oauth-2025-04-20`) is what ccusage-style tools use but it 429s aggressively (Anthropic closed the issue "not planned"). Codex exposes `account/rateLimits/read` over app-server. **Multi-account auto-rotation tools (claude-swap, claude-rotate, ccrotate) exist but conflict with Anthropic's consumer terms** (no credential sharing/automation outside API keys; AUP bans multi-account circumvention) — ByteBureau should offer *profiles* and explicit per-employee account assignment, not token pooling.

---

## 2) Findings per topic

### 2.1 Driving vendor coding agents as a backend without paid API keys

#### 2.1.1 Anthropic Claude Code headless (`claude -p`) — CLI 2.1.287

Source of truth: https://code.claude.com/docs/en/cli-reference and https://code.claude.com/docs/en/headless (fetched 2026-10-02); npm `@anthropic-ai/claude-code` 2.1.287 (Node ≥22; native binary).

Flags that matter for an orchestrator (all verified in the CLI reference):

| Need | Flag(s) |
|---|---|
| Non-interactive run | `-p/--print`; stdin is read (10 MB cap) |
| Structured output | `--output-format text\|json\|stream-json`; `--json-schema '<schema>'` → `structured_output` field; `--input-format stream-json` for multi-turn over stdin; `--replay-user-messages` |
| Streaming detail | `--verbose --include-partial-messages`, `--include-hook-events`, `--forward-subagent-text` (subagent transcripts with `parent_tool_use_id`, v2.1.211+), `--prompt-suggestions` |
| Sessions | `--session-id <uuid>`, `--resume <id\|name\|transcript.jsonl>` (cross-project since v2.1.223), `--continue`, `--fork-session`, `--no-session-persistence`, `-n/--name` |
| Permissions | `--permission-mode default\|acceptEdits\|plan\|auto\|dontAsk\|bypassPermissions`, `--allowedTools`/`--disallowedTools`, `--tools`, `--permission-prompt-tool <mcp tool>`, `--permission-prompts host\|none` (v2.1.259+), `--dangerously-skip-permissions`, `--restricted` (v2.1.248+, for eval harnesses on shared machines) |
| Model/effort/context | `--model` (aliases `default|best|fable|opus|sonnet|haiku|opusplan|sonnet[1m]|opus[1m]`), `--effort low\|medium\|high\|xhigh\|max\|ultracode`, `--fallback-model a,b`, `--autocompact 500k` (v2.1.221+), `--advisor <model>` |
| Budgets | `--max-turns`, `--max-budget-usd` (print mode; subagent spend counts) |
| Subagents/MCP/plugins | `--agents '<json>'` (file path allowed in `-p` since v2.1.281), `--mcp-config`, `--strict-mcp-config`, `--plugin-dir`, `--plugin-url`, `--channels` (research preview) |
| System prompt | `--system-prompt(-file)`, `--append-system-prompt(-file)`, `--append-subagent-system-prompt(-file)`, `--system-prompt-snapshot off`, `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` (v2.1.275+) for cache-friendly split, `--exclude-dynamic-system-prompt-sections` |
| Isolation | `--worktree/-w`, `--add-dir`, `--setting-sources`, `--settings <file\|json>`, `--bare` |
| Cloud/remote | `--cloud "task"` / `-p "msg" --cloud <session-id>`, `--teleport`, `--environment ccpool_…`, `claude remote-control` server mode (`--spawn worktree`, `--capacity 32`) |

Behaviours an orchestrator must know (headless docs):

- `stream-json` emits `system/init` (model, tools, `mcp_servers`, `plugins`, `plugin_errors`, `mcp_server_errors`, `capabilities[]` for feature detection — v2.1.205+), `system/api_retry` (`error` ∈ `authentication_failed | oauth_org_not_allowed | account_on_hold | billing_error | rate_limit | overloaded | …`), `assistant`/`user` messages (subagents carry `parent_tool_use_id`), `permission_denied`, and a final `result` with `total_cost_usd`, per-model usage, `session_id`, `permission_denials`.
- **`--bare` never reads OAuth credentials or the keychain** — "Set `ANTHROPIC_API_KEY` before running it, because bare mode doesn't use your subscription login." Anthropic says `--bare` "will become the default for `-p` in a future release." ⇒ For the subscription path ByteBureau must run **non-bare** `-p` (or the SDK) and pass `--setting-sources`/`--settings` explicitly to get determinism.
- `-p` sessions start in `default` permission mode in sessions that fetch feature flags; `auto` mode's classifier (runs on Sonnet 5 by default) can be enabled server-side; `--permission-prompts none` removes `AskUserQuestion` so unattended runs never stall; a `PreToolUse` hook can return `defer` so the process can exit and the session resumes later (ideal for phone approvals).
- `claude -p` runs stay out of `claude --continue`/the picker but resume with `--resume <id>`; `claude -p --continue` includes them.
- Transcripts: `~/.claude/projects/<cwd-encoded>/<session-id>.jsonl` (format "internal … can break on any release"); `CLAUDE_CONFIG_DIR` relocates everything; `CLAUDE_CODE_PROJECT_DIR_NAME` (v2.1.234+) pins the project dir name for embedded hosts.
- Auth precedence: cloud provider env → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → Anthropic profile/WIF → **subscription OAuth from `/login` (the default for Pro/Max/Team/Enterprise)**.
- `claude setup-token` mints a **one-year OAuth token for CI/scripts**, "requires a Pro, Max, Team, or Enterprise plan", "can only make model requests" (no Remote Control, no claude.ai connectors). Not read in bare mode.
- Multiple accounts are officially supported via per-account `CLAUDE_CONFIG_DIR` (docs example: `alias claude-work='CLAUDE_CONFIG_DIR=~/.claude-work claude'`); the macOS Keychain entry is keyed by that directory.
- Credential storage: macOS Keychain (fallback `~/.claude/.credentials.json` 0600 when the Keychain is locked, e.g. SSH); Linux `~/.claude/.credentials.json` 0600; Windows `%USERPROFILE%\.claude\.credentials.json`.

#### 2.1.2 Claude Agent SDK for TypeScript — `@anthropic-ai/claude-agent-sdk` 0.3.287

Sources: https://code.claude.com/docs/en/agent-sdk/typescript, /agent-sdk/overview, /agent-sdk/user-input, /agent-sdk/session-storage, /agent-sdk/hosting; npm registry (0.3.287, "SEE LICENSE IN README", Node ≥18, peer deps `zod ^4`, `@anthropic-ai/sdk ≥0.93`, `@modelcontextprotocol/sdk ^1.29`; optional platform binaries incl. `darwin-arm64`, `linux-arm64`, `linux-arm64-musl`; entry points `.`, `./core` (v0.3.282+, for bundlers), `./bridge`, `./browser`, `./extract`, `./sdk-tools`). GitHub anthropics/claude-agent-sdk-typescript: 1.8k stars; governed by Commercial ToS.

Verified capabilities (TypeScript reference):

- `query({ prompt: string | AsyncIterable<SDKUserMessage>, options })` returns an async generator of `SDKMessage` plus a control surface: `interrupt()`, `setPermissionMode()`, `setModel()`, `streamInput()`, `getContextUsage({detail})` (structured `/context` report — categories, `totalTokens`, `maxTokens`, `percentage`, per-MCP/agent/skill attribution; "summary" needs no API call), `accountInfo()` (`tier`, `plan_name`, `usage_limit`, `usage_this_month`, `next_reset`, org/user fields), `supportedModels()`, `supportedAgents()`, `mcpServerStatus()`, `setMcpServers()`, `reloadPlugins()`, `rewindFiles()`, `stopTask()`.
- Options: `model`, `fallbackModel`, `effort: 'low'|'medium'|'high'|'xhigh'|'max'`, `thinking` (adaptive default), `permissionMode` (incl. `auto`, `dontAsk`), `allowedTools/disallowedTools`, **`canUseTool`** (fires for approvals *and* `AskUserQuestion`; answers returned as `updatedInput.answers`; `suggestions` → `updatedPermissions` for "always allow"; `toolConfig.askUserQuestion.previewFormat: 'markdown'|'html'`), `hooks` (SessionStart, PreToolUse with `defer`, PermissionRequest, Elicitation, SessionEnd…), `agents` (programmatic subagents with model/effort/tools/memory), `agentProgressSummaries`, `forwardSubagentText`, `mcpServers` (stdio/SSE/HTTP/in-process via `createSdkMcpServer`+`tool()`), `strictMcpConfig`, `tools` preset, `toolAliases`, `outputFormat: {type:'json_schema', schema}`, `systemPrompt` (preset `claude_code` or custom, cacheable static/dynamic split), `resume/continue/forkSession/sessionId/persistSession/resumeSessionAt`, **`sessionStore`** (alpha-flagged flush modes; mirror JSONL to S3/Redis/Postgres so another host can resume; `InMemorySessionStore` shipped; `mirror_error` system message on failure), `maxTurns`, `maxBudgetUsd`, `taskBudget` (alpha), `settings`, `settingSources`, `plugins`, `skills`, `cwd`, `additionalDirectories`, `enableFileCheckpointing`, `env` (replaces process env), `executable: 'bun'|'deno'|'node'`, `pathToClaudeCodeExecutable`, `spawnClaudeCodeProcess`, `onElicitation`, `includePartialMessages`, `verbatimPrompts`, `title`. `startup()` pre-warms a subprocess; `prewarm()` (alpha, v0.3.282+) binds later.
- Message types include `SDKAssistantMessage`, `SDKUserMessage`, `SDKResultMessage`, `SDKSystemMessage` (capabilities), `SDKPartialAssistantMessage`, `SDKStatusMessage`, `SDKTaskNotificationMessage`, `SDKPermissionDeniedMessage`, `SDKPromptSuggestionMessage`, `SDKContextUsage` (v0.3.232+), `SDKRateLimitEvent` and `SDKAPIRetryMessage` (listed in the union; full definitions not retrievable in my fetch — **verify shape in `sdk.d.ts`**).
- Hosting guidance (official): one subprocess per session; ~1 GiB RAM/1 CPU/5 GiB disk starting point; multi-tenant isolation = `settingSources: []`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, per-tenant `CLAUDE_CONFIG_DIR` + `cwd`; OTel via `CLAUDE_CODE_ENABLE_TELEMETRY=1`; Docker/K8s/Modal cookbook exists; "No top-level session timeout — set `maxTurns`".
- Version coupling: "SDK v0.3.191 bundles Claude Code v2.1.191, so a feature … needs the SDK release with the same patch number or later." Updating the SDK is how you update the CLI.
- **Authentication statement (overview page, verbatim):** "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead." The hosting page only documents `ANTHROPIC_API_KEY`/proxy injection. Technically the SDK spawns non-bare Claude Code, so a user who has run `claude auth login` in the same `CLAUDE_CONFIG_DIR` is used (precedence rule 7); the session-storage page even says "If your app signs in through files in the config directory, such as OAuth credentials … copy those files into the temp directory first".
- Branding rule: call it "Claude Agent" / "Powered by Claude", never "Claude Code" in ByteBureau's UI.

#### 2.1.3 Anthropic's 2025–2026 policy on subscription auth from third-party tools (the crucial part)

Official text (code.claude.com/docs/en/legal-and-compliance, fetched 2026-10-02):

> "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
> "**OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
> "**Developers** building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication … Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."
> "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code …"
> Hosting Claude Code in a product requires Commercial ToS and: "The Claude Code binary must not be modified … customers may not remove, disable, or restrict any authentication method"; "Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential."
> "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."

Official support article "Use the Claude Agent SDK with your Claude plan" (support.claude.com/en/articles/15036540, last update 2026-06-16): the planned June 15 2026 change (monthly "Agent SDK credit": Pro $20, Max 5x $100, Max 20x $200, Team Standard $20 / Premium $100, Enterprise $20–$200 by seat, covering Agent SDK, `claude -p`, GitHub Actions and third-party apps using Agent SDK auth, with overflow to extra usage at API rates) was **paused**: "Currently, Claude Agent SDK usage, `claude -p`, and third-party apps still draw from subscription limits with no separate credit … Anthropic is working to update the plan to better support how users build with Claude subscriptions." Support article 11145838 (updated 2026-08-19) confirms Claude Code and claude.ai share one limit pool and that usage credits at API rates are the overflow path.

Timeline (two or more independent sources each):

| Date | Event | Sources |
|---|---|---|
| 2026-01-09 | Subscription OAuth tokens blocked outside official apps with no notice, then reversed after backlash; OpenCode's Claude Max routing broke | GIGAZINE, dev.to/mcrolly, betterclaw |
| 2026-02-19/20 | Docs updated: "Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service — including the Agent SDK — is not permitted"; OpenCode removed Claude login citing "anthropic legal requests" | The Register, winbuzzer, OpenCode docs |
| 2026-04-04/05 | Boris Cherny: subscriptions no longer cover third-party tools (OpenClaw et al.) from Apr 5 12:00 PT; one-time credit equal to plan price; refunds | the-decoder, Yahoo Finance, VentureBeat |
| 2026-04-10 | OpenClaw author temporarily banned, reinstated hours later | betterclaw (unverified elsewhere) |
| 2026-05-13 | Reinstatement via "Agent SDK" auth; Agent SDK credits announced for June 15 ("same subscription, same price per month" — Lydia Hallie) | VentureBeat, kucoin, support article |
| 2026-06-15/16 | Credit plan paused: "Nothing changes for now"; SDK/`claude -p`/third-party apps draw from normal limits; advance notice promised before any revision | support article 15036540, betterclaw, techtimes |
| 2026-05-06 | 5-hour limits doubled on Pro/Max/Team; peak-hour reductions removed | morphllm, developersdigest (third-party, consistent) |

Consumer ToS (effective 2025-10-08, §3): no access "through automated or non-human means, whether through a bot, script, or otherwise" except via API key "or where we otherwise explicitly permit it"; §2: no sharing account credentials. AUP (effective 2025-09-15) bans "Coordinate malicious activity across multiple accounts to avoid detection or circumvent product guardrails" and "Circumvent a ban through the use of a different account". Neither contains an explicit rate-limit-circumvention clause (verified by reading both pages).

**What this means for ByteBureau (legal reading, not legal advice):**
1. Safe: the owner runs `claude auth login` (or `claude setup-token`) himself inside the container's `CLAUDE_CONFIG_DIR` volume; ByteBureau launches the unmodified binary / official SDK for his own tickets; all usage is "ordinary, individual usage". Mounting that config dir into N containers is still one human's usage.
2. Unsafe/forbidden: ByteBureau implementing the OAuth dance, reading `.credentials.json`/Keychain to reuse tokens elsewhere (claude-rotate style), offering "Sign in with Claude" in its UI, letting other people's work flow through the owner's seat, pooling multiple accounts.
3. Volatile: Anthropic explicitly says a revised plan is coming with notice. The abstraction must make "switch this employee to API key / Bedrock / local model" trivial.

#### 2.1.4 OpenAI Codex CLI 0.160.0 (2026-10-01), `@openai/codex-sdk` 0.160.0, app-server, Sign in with ChatGPT

Sources: learn.chatgpt.com/docs/non-interactive-mode, /docs/auth, /docs/app-server, /docs/pricing, /docs/codex-sdk, /docs/sign-in-with-chatgpt (official; developers.openai.com/codex/* now 308-redirects there); github.com/openai/codex (Apache-2.0, Rust, 127.5k stars); sdk/typescript README; promptfoo app-server provider; npm registry.

- **`codex exec`**: `--json` JSONL events (`thread.started`, `turn.started/completed` with usage, `item.*`), `--output-schema <file>` (JSON Schema-conformant final answer), `-o/--output-last-message`, `codex exec resume [id] | --last`, `--sandbox read-only|workspace-write|danger-full-access` (`--full-auto` deprecated), `--ephemeral`, `--skip-git-repo-check`, `--cd`, `-c key=value`, `--model`, `--ignore-user-config`, `--ignore-rules`; stdin prompt with `codex exec -`.
- **Auth** (official): Sign in with ChatGPT (desktop app, CLI, IDE) or API key ("OpenAI bills API key usage … at standard API rates"). Credentials cache in `~/.codex/auth.json`; `cli_auth_credentials_store` = file | keychain | auto | ephemeral; `forced_login_method`, `forced_chatgpt_workspace_id`; **device-code auth (beta)** for headless boxes; "copy cached credentials between machines" is documented. For CI: "`CODEX_API_KEY` … preferred", while "ChatGPT-managed auth" is an "advanced option; seed `~/.codex/auth.json` through secure storage for account-based CI/CD" — i.e. OpenAI documents using plan auth in automation.
- **Pricing/limits** (official): Codex included in Free, Go, Plus, Pro, Business, Edu, Enterprise; **5-hour rolling window on Plus and Standard Business** ("Pro plans currently have no five-hour limit"), weekly limits "may also apply"; "Local messages and cloud chats share your plan's usage allowance"; credits purchasable past the limit; API-key users bypass plan limits. (9to5mac: the Plus 5-hour window was restored 2026-08-24/25 — third-party.)
- **App-server** (official): `codex app-server` (stdio default; `--listen ws://127.0.0.1:4500` experimental with `--ws-auth capability-token|signed-bearer-token`; `unix://`); JSON-RPC 2.0: `initialize` (+`clientInfo.name`, `capabilities.experimentalApi`) → `initialized` → `thread/start|resume|fork` → `turn/start|steer|interrupt` → `item/started`, `item/agentMessage/delta`, `item/completed` → `turn/completed`; approvals via server-initiated `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `mcpServer/elicitation/request`; `model/list`, `command/exec`; `codex app-server generate-ts|generate-json-schema --out`. **Caveat (verbatim): "experimental and unsupported for production workloads"**; "Clients must identify themselves via `clientInfo.name` for compliance logging"; enterprise integrations should "contact OpenAI to get it added to a known clients list". Rate limits: community tools document `account/rateLimits/read` → `rateLimits.primary/secondary{usedPercent, windowDurationMins, resetsAt}`, `planType` (unverified in the official page I fetched).
- **TS SDK** (`@openai/codex-sdk` 0.160.0, Apache-2.0, Node ≥18, depends on `@openai/codex` 0.160.0): "spawns the CLI and exchanges JSONL events over stdin/stdout"; `Codex` → `startThread()`/`resumeThread(id)` (threads persisted in `~/.codex/sessions`) → `run()`/`runStreamed()` (`item.completed`, `turn.completed`); `outputSchema` (JSON Schema or Zod), `sandboxMode`, `workingDirectory`, `skipGitRepoCheck`, `env`, `config`/`configOverrides` (TOML), `codexPathOverride`, `baseUrl`. README says the SDK injects `CODEX_API_KEY`; promptfoo documents that app-server auth is "optional when Codex is already signed in" via ChatGPT — **test whether the SDK falls back to the CLI's ChatGPT login when no key is set**.
- **Sign in with ChatGPT** (official help page + developers.openai.com/siwc, launched 2026-09-29 at DevDay): Plus/Pro users can let an app consume "Codex / ChatGPT work usage included in your plan"; per-app cap 10–100% of weekly usage in Settings → Usage → App limits; "Open-source applications fully qualify"; commercial apps are approved case-by-case; developers request a client ID via form; OAuth 2.0/OIDC; plan usage is spent via the Responses API with the user's token; no access to conversations/memories. Listed OSS integrations: OpenClaw, OpenCode, Pi, T3; commercial partners include Devin, Amp, Warp, Kilo Code, Conductor, Notion, Vercel, Hermes Agent.

#### 2.1.5 Other agents that can be driven programmatically

| Agent | Version / license / stars (observed) | Programmatic surface | Auth / cost | Notes |
|---|---|---|---|---|
| **Gemini CLI** | `@google/gemini-cli` 0.62.0, Apache-2.0, 107k★, Node ≥20 | `gemini -p … --output-format json\|stream-json` (events `init,message,tool_use,tool_result,error,result`; exit codes 0/1/42/53); ACP agent in registry | Google OAuth free tier **60 RPM / 1,000 req/day**; API key free 1,000/day; Vertex | Best free-tier remote backend; approval-mode flags not confirmed in the headless page |
| **GitHub Copilot SDK/CLI** | `@github/copilot-sdk` 1.0.16 (GA, MIT, 10.5k★; also Python/Go/.NET/Java/Rust) | JSON-RPC to `copilot` CLI in server mode; sessions, custom tools, MCP, skills, model selection | Copilot subscription (free tier limited) or **BYOK** | Polished; ACP "public preview" |
| **Cursor CLI** | `agent` (version n/a) | `agent -p --output-format json\|stream-json --stream-partial-output --force` | `CURSOR_API_KEY` or login; plan terms not documented | ACP native |
| **Factory Droid** | `droid exec` | `--output-format text\|json\|stream-jsonrpc`, `--auto low\|medium\|high`, `--session-id`, `--fork`, `--use-spec`, `-r` reasoning | `FACTORY_API_KEY` required; BYOK models | ACP listed; commercial |
| **Amp** | `amp -x --stream-json --stream-json-input` | events `system,assistant,user,result`; `threads continue` | `AMP_API_KEY`; **execute mode needs paid credits** | ChatGPT-plan partner |
| **Kilo CLI** | `@kilocode/cli` 7.8.3, MIT | fork of OpenCode: `kilo serve` (HTTP+SSE), `kilo acp`, `kilo attach` | Kilo gateway (free models) or BYOK | Inherits OpenCode config |
| **Goose** | aaif-goose/goose, Apache-2.0, 54.9k★, Rust; under Agentic AI Foundation (LF) | `goose run`, recipes, `--no-session`, output formats; `goose-acp-server`; MCP 70+ ext. | 15+ providers incl. Ollama/OpenRouter; "existing Claude, ChatGPT, Gemini subscriptions via ACP" (delegates to those agents) | General-purpose; headless keychain hang fixed 2026 |
| **Crush** (Charm) | 28.4k★, **FSL-1.1-MIT (not OSI)** | `crush run` (`--yolo`, `--quiet`, `--reasoning-effort`), `crush serve` | OpenAI-compat/Anthropic/Ollama/LM Studio/OpenRouter | Headless model-selection bugs reported |
| **Pi** | `@earendil-works/pi-coding-agent` 1.0.0, MIT, Node ≥22.19 (moved from badlogic/pi-mono to Earendil Works, May 2026) | print/JSON; **RPC mode** `pi --mode rpc` (JSONL: `prompt, steer, follow_up, abort, get_state, set_model, compact, fork…`; events `agent_start, message_update, tool_execution_*`, extension UI `select/confirm/input`); SDK | 15+ providers, API keys or OAuth; **Sign in with ChatGPT OSS partner** | Minimal, hackable; ACP via `pi-acp`; AI SDK 7 has `@ai-sdk/harness-pi` |
| **Aider** | last release v0.86.0 (2025-08-09); no commits since 2026-05-22 (third-party, unverified) | `--message`, Python | API keys | **Dormant** — reject |
| **Mistral Vibe CLI** | Apache-2.0 (2025-12-09) with Devstral 2 (123B, modified MIT) / Devstral Small 2 (24B, Apache-2.0), 256K ctx | interactive + "headless/scripted execution"; ACP integration | Mistral API (free period at launch), local models, OpenAI-compatible providers | Good fit for the Mistral/local pillar |
| **OpenCode** | see §2.3 | `opencode run --format json`, `opencode serve` + SDK, `opencode acp` | 75+ providers; ChatGPT login official | Plugin backend candidate |

### 2.2 Protocols: ACP vs MCP vs A2A vs AG-UI vs IBM ACP

#### ACP — Agent Client Protocol (Zed + JetBrains)

- Repo agentclientprotocol/agent-client-protocol: Apache-2.0, 4.4k★; "Version 1 is the current production release"; **v2 exists as a draft** (`schema/v2`, SDK `@agentclientprotocol/sdk/experimental/v2`); "wire compatibility is determined by the `protocolVersion` exchanged during initialization". (Third-party claim: v2 draft landed 2026-07-20 after 15+ RFDs — unverified.)
- SDKs: TypeScript `@agentclientprotocol/sdk` **1.6.0** (Apache-2.0; exports `agent()`/`client()` helpers, `ndJsonStream`, experimental `./server`, `./ws-stream`, `./http-stream`, `./node-adapter`; schema JSON bundled), Rust, Python, Kotlin, Java.
- Protocol (agentclientprotocol.com): JSON-RPC 2.0 over stdio; agent methods `initialize`, `authenticate`, `session/new`, `session/prompt`, optional `session/load`, `session/set_mode`, `logout`; notifications `session/cancel`; client methods `session/request_permission` (baseline), optional `fs/read_text_file`, `fs/write_text_file`, `terminal/create|output|release|wait_for_exit|kill`, `elicitation/create`; notifications `session/update` (streamed agent messages, thought chunks, tool calls with status/diffs, plan/todo, mode changes, available commands); `_meta` + `_`-prefixed methods for extensions; MCP server configs passed to the agent at `session/new`; remote HTTP/WebSocket transport "work-in-progress".
- Registry (2026-01-28, Zed + JetBrains): Claude Code, Codex CLI, Copilot CLI, OpenCode, Gemini CLI at launch; >40 agents by April, >50 by June, "60+" by Sept 2026 (third-party counts); official list includes Cursor, Cline, Goose, Junie, Kiro, Kimi, Qwen Code, Mistral Vibe, Factory Droid, Pi (pi-acp), OpenClaw, Hermes, Docker cagent, OpenHands.
- Adapters relevant to ByteBureau: `@agentclientprotocol/claude-agent-acp` **0.85.0** (Zed-maintained successor of the deprecated `@zed-industries/claude-code-acp` 0.16.2; deps `@anthropic-ai/claude-agent-sdk` 0.3.286, `@agentclientprotocol/sdk` 1.5.1; supports `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and a `/login` slash command for subscription login; permissions, MCP passthrough, terminals, diffs via "AIR" patch extension, nested subagent transcripts, session goals) and `@agentclientprotocol/codex-acp` **2.1.1** (community-maintained successor of the archived zed-industries/codex-acp; built on Codex app-server; ChatGPT login or `CODEX_API_KEY`/`OPENAI_API_KEY`; bundles a compatible Codex binary, `CODEX_PATH` override).
- Fit assessment: ACP covers exactly ByteBureau's runtime needs (sessions, prompts, streamed updates, tool-call reporting with diffs, permission requests, modes, cancel, load/resume, MCP passthrough, slash commands). Gaps: no usage/rate-limit/cost/context-size semantics, no structured-output contract, agent expects the *client* to serve fs/terminal (ByteBureau can simply not advertise those capabilities so the agent uses its own in-container fs), remote transport still experimental, and adapters lag the vendor SDK by days-to-weeks.

#### MCP — Model Context Protocol, revision **2026-07-28** (stable; RC 2026-05-21)

Changelog vs 2025-11-25 (modelcontextprotocol.io/specification/2026-07-28/changelog): protocol sessions and `Mcp-Session-Id` removed; stateless core — no `initialize` handshake, version/capabilities/client-info ride in `_meta` on every request; new `server/discover`; `subscriptions/listen` replaces GET stream and resource subscribe; `ping`, `logging/setLevel`, roots-changed removed; **Tasks moved to an official extension** (`io.modelcontextprotocol/tasks`, poll with `tasks/get`); **Multi Round-Trip Requests (MRTR)** replace server-initiated `roots/list`, `sampling/createMessage`, `elicitation/create` (`resultType: "input_required"` + `inputRequests`, client retries with `inputResponses`); all results carry `resultType`; SSE resumability removed; `extensions` capability (MCP Apps is an extension); OTel `traceparent` conventions; `ttlMs`/`cacheScope` on list results; authorization hardening (issuer binding, `iss` check, CIMD replaces Dynamic Client Registration); **Roots, Sampling, Logging deprecated**; 12-month deprecation policy. TS SDK `@modelcontextprotocol/sdk` 1.31.0 (MIT). Claude Code notes it "doesn't register a channel server that negotiates protocol revision 2026-07-28" on the v2 client runtime — expect transitional incompatibilities in late 2026.

#### A2A — Agent2Agent v1.0 (Linux Foundation)

Google donated A2A to the LF 2025-06-23; v1.0 "production-ready" in March/April 2026 (Google OSS blog 2026-04-16; LF press); 100–150+ orgs; SDKs Python/TS/Java/Go/C#; `@a2a-js/sdk` 1.3.0 (Apache-2.0). IBM's "Agent Communication Protocol" **merged into A2A on 2025-08-29** (IBM/LF) — treat IBM ACP as discontinued. The "A2Family" extensions (AP2 payments, A2UI, UCP commerce) are 2026 spin-offs. Relevance: inter-office/inter-tool agent delegation — plugin material.

#### AG-UI 1.0 (CopilotKit, 2026-09-30)

Stable JSON-Schema spec; `@ag-ui/core` 1.0.1 and `@ag-ui/client` (MIT), Python and .NET SDKs generated from the schema; adds subagent IDs, metadata, multimodal tool results, HITL interrupts, token usage; backwards compatible with 0.x; adopted by LangChain, Mastra, Pydantic AI, Claude Managed Agents (per CopilotKit). Relevance: a ready-made event vocabulary for ByteBureau's live-transcript stream to browser/desktop/phone; the pixel-office needs extra events anyway, so adopt the shape, not the dependency.

#### Which to speak natively

- **Native:** ACP v1 (runtime plugin contract + generic backend adapter) and MCP 2026-07-28 (ByteBureau exposes Jira/Slack/git-host tools as MCP servers so *every* backend gets them; consume MCP servers for the office's own agents).
- **Plugins:** A2A server/client; AG-UI emitter; ACP v2/HTTP once stable.

### 2.3 OpenCode as a pluggable backend; Models.dev; ToS caveats

- Project: **anomalyco/opencode** (rebranded from sst/opencode; MIT; 211.3k★); latest **v1.18.34 (2026-09-30)**; npm `opencode-ai` 1.18.34 with per-platform binaries (darwin-arm64, linux-arm64, musl, baseline). Weekly releases; recent notes: ACP session restoration (v1.18.31), Cloudflare AI Gateway, DeepSeek V4.1/Grok 4.7 models, namespaced session identity headers.
- Providers: "75+ LLM providers through … the AI SDK and Models.dev registry"; `opencode auth login` / `/connect`; credentials in `~/.local/share/opencode/auth.json`; subscription logins: **OpenAI ChatGPT Plus/Pro (browser OAuth; official Sign-in-with-ChatGPT partner)**, GitHub Copilot (device code), Google; **Anthropic Claude Pro/Max: docs state "Anthropic explicitly prohibits" this and "Previous versions of OpenCode came bundled with these plugins but that is no longer the case."** Community plugins re-add it (xtruder/opencode-claude-max-plugin, ianjwhite99/opencode-with-claude) — do not ship these.
- Server/SDK: `opencode serve --port 4096 --hostname 127.0.0.1 [--mdns] [--cors origin]`; basic auth via `OPENCODE_SERVER_PASSWORD` (+`OPENCODE_SERVER_USERNAME`); OpenAPI 3.1 at `/doc`; SSE at `/global/event`; `/tui` remote-control endpoint. `@opencode-ai/sdk` 1.18.34 (MIT; generated from OpenAPI): `createOpencode()` (spawns server+client) or `createOpencodeClient({baseUrl})`; `session.create/prompt/messages`, structured output with JSON schema + retry, `event.subscribe()` SSE, `config.get/providers`, `auth.set`, `app.agents`, `find.*`, `file.read`, `tui.*`. CLI: `opencode run "…" --format json --model provider/model --agent --session/--continue/--fork --auto --attach http://host:4096`; `opencode acp`; `opencode web`.
- Plugins: `@opencode-ai/plugin` (`tool()` helper); hooks `tool.execute.before/after`, `permission.ask`, `chat.message`, `session.*`, `file.edited`, shell env injection, compaction customization; local (`.opencode/plugins/`, `~/.config/opencode/plugins/`) or npm (installed with Bun at startup).
- **Models.dev** (github.com/sst/models.dev; open database; `api.json` endpoint): providers, models, cost, context/output limits, capabilities (reasoning, tool_call, structured outputs, temperature), release dates; used by OpenCode and Crush. ByteBureau should consume it (cached) rather than hand-maintain a model table.
- ToS summary for subscriptions in third-party harnesses: **Anthropic** — see §2.1.3 (currently tolerated for Agent SDK/`claude -p`, forbidden to offer claude.ai login or intermediate tokens; OpenCode was told to remove it). **OpenAI** — officially supported via Sign in with ChatGPT for OSS tools; ChatGPT-managed auth in CI documented as "advanced"; app-server "experimental and unsupported for production" with `clientInfo.name` logging. (OpenAI ToS page could not be fetched — 403.)

### 2.4 Generic LLM SDKs for ByteBureau's own lightweight agents; local inference; free tiers

| Framework | Version (npm) / license | Provider-agnostic? | Leanness | Verdict |
|---|---|---|---|---|
| **Vercel AI SDK 7** | `ai` 7.0.127 (Apache-2.0; Node ≥22; zod 3/4); AI SDK 7 GA 2026-06-25 (v6 2025-12-22) | Yes — dozens of first-party providers + `@ai-sdk/openai-compatible` (Ollama, LM Studio, llama.cpp, OpenRouter, Mistral) | Core is one package; agents/workflow/tui are opt-in | **Adopt.** `ToolLoopAgent`, `needsApproval` + HMAC-signed approvals, `WorkflowAgent` (durable via `@ai-sdk/workflow`), timeouts, `reasoning` option, typed tool/runtime context, MCP client incl. **MCP Apps**, `uploadFile`/`uploadSkill`, `SandboxSession`, OTel telemetry + `node:diagnostics_channel`, lifecycle events, DevTools, TUI. `HarnessAgent` + `@ai-sdk/harness{,-claude-code,-codex,-pi,-opencode}` 1.0.1xx are **experimental** (bridge processes, WebSocket) — evaluate, don't depend on. |
| Mastra | `@mastra/core` 1.74.0 (Apache-2.0 + "Mastra Enterprise License" `ee/` dirs; Node ≥22.13; 28.5k★) | Yes (built on AI SDK, multi-version shim) | Heavy (Studio, memory, RAG, evals, workflows) | Optional; good if ByteBureau wants workflow engine + evals out of the box; EE license creep risk |
| LangGraph.js | `@langchain/langgraph` 1.4.18 (MIT; 1.0 since 2025-10-22) | Yes via `@langchain/core` models | Medium; drags LangChain core | Optional for durable graphs/checkpointing; not needed if ByteBureau owns its orchestrator |
| OpenAI Agents SDK JS | `@openai/agents` 0.18.0 (MIT; 3.9k★; Node ≥22) | Claims "OpenAI APIs and more"; `OPENAI_API_KEY` required by default | Light | Optional plugin for Codex/Responses-native features (sandbox agents, realtime) |
| VoltAgent | `@voltagent/core` 2.11.0 (MIT; 10.7k★) | Yes (peer `ai ^6` — lags AI SDK 7) | Medium + VoltOps console | Reject for core |
| Google ADK-JS | `@google/adk` 2.2.0 (Apache-2.0; 1.4k★) | Gemini-centric (`@google/genai`, Vertex) ; 30+ deps incl. MikroORM | Heavy | Reject |
| Inngest AgentKit | `@inngest/agent-kit` 0.13.2 (Apache-2.0; 939★; last publish ~7 months ago) | Yes, but requires Inngest runtime | Medium | Reject (stale, infra lock-in) |
| Effect AI | `@effect/ai` 0.37.0 (MIT; "experimental / alpha"; peer `effect ^3.22` while Effect v4 is in beta/RC) | Yes (`LanguageModel` service) | Light if already on Effect | Only if ByteBureau adopts Effect wholesale; otherwise reject |

Local inference (M4 MacBook Pro / Raspberry Pi 5 / containers):

- **Ollama**: Anthropic Messages API compatibility since **v0.14.0 (blog 2026-01-16)** — `ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_BASE_URL=http://localhost:11434 claude --model qwen3-coder` runs Claude Code on local or `:cloud` models (streaming, tools, thinking, vision); `ollama launch claude|opencode|codex|droid` since **v0.15 (2026-01-23)** writes the tool config for you; OpenAI-compatible API on :11434; JS client `ollama` 0.6.4. Ollama Cloud: Free (starter credits, 1 concurrent), Pro $20/mo ($60 credits, 3 concurrent), Max $100/mo ($300), Team $500/mo; "prompt or response data is never logged or trained on". Third-party: v0.30.x by mid-2026, llama.cpp backend being replaced by MLX on Apple Silicon (unverified).
- **LM Studio**: `@lmstudio/sdk` 2.0.0 (MIT); REST + OpenAI-compatible + **Anthropic-compatible** endpoints; headless daemon `llmster` (`curl -fsSL https://lmstudio.ai/install.sh | bash`); tool calling, MCP client, structured output; workplace use advertised ("Use local LLMs at your workplace") but licence text not retrieved — **verify EULA**.
- **llama.cpp**: `llama-server` OpenAI-compatible on :8080; releases are build tags (**b11327, 2026-10-01**), not semver (the "v0.5.0" claim seen in a search snippet is wrong); web UI ships an MCP client (third-party). Lean choice for Pi 5.
- **MLX (Apple Silicon)**: `mlx-lm` server with tool calling (Apple); community servers with OpenAI+Anthropic APIs (mlx-serve in Zig, Rapid-MLX "release-gated with Claude Code, Codex CLI, Aider"); WWDC26 session "Run local agentic AI on the Mac using MLX". Third-party benchmarks: ~1.4–1.8× llama.cpp on M4 Pro for 4-bit 7–30B models (unverified). Fastest Mac path, least stable.
- **vLLM**: v0.30.0 (2026-09-22, third-party); no native macOS; only for Linux GPU hosts/K8s. Out of scope for Pi 5/Mac.
- **Mistral**: free "Experiment" tier on La Plateforme (all models incl. Codestral/Devstral 2; third-party: ~1 req/s, ~1B tokens/month; Mistral stopped publishing exact numbers in Sept 2026 — check Admin Console → Limits). Devstral 2 pricing after the free period $0.40/$2.00 per M tokens, Small 2 $0.10/$0.30 (Mistral blog 2025-12-09). Le Chat Pro subscription does not expose an API path (unverified).
- **OpenRouter** (official docs): `:free` models — **20 req/min; 50 req/day with < $10 lifetime credits, 1,000/day with ≥ $10**; daily counter in `GET /api/v1/key` → `free_model_daily_requests`; honor `Retry-After`.
- **Gemini CLI**: OAuth free tier 60 RPM / 1,000 req/day (official README).
- **Models.dev**: see §2.3.

### 2.5 Usage/limits visibility; multi-account rotation; credential stores

- Anthropic limits: rolling **5-hour** window + **weekly (7-day)** windows (all-models plus per-family Sonnet/Opus), shared across Claude Code, claude.ai, Cowork, cloud sessions, Remote Control; "usage credits" (formerly "extra usage") at API rates with a monthly spend limit, 1-hour prompt-cache TTL on subscription drops to 5 min on credits; `/usage` (aliases `/cost`, `/stats`) shows plan bars, attribution (skills/subagents/MCP), behaviour flags, loops; `/rate-limit-options` and `autoContinueAtUsageLimit` wait-and-continue (v2.1.234+); `/usage-credits`.
- **Official programmatic surfaces:** (a) status-line JSON (`rate_limits.five_hour.used_percentage/resets_at`, `rate_limits.seven_day.*`, `rate_limits.spend_limit.*` behind a gateway; "appears only for claude.ai Pro and Max subscribers … after the first API response"; plus `context_window.used_percentage`, `cost.total_cost_usd`, `prompt_cache.*`, `transcript_path`) — a status-line command is a TUI feature, so **whether it fires in `-p`/SDK sessions is unverified**; (b) Agent SDK `accountInfo()` (`tier`, `plan_name`, `usage_limit`, `usage_this_month`, `next_reset`) and `SDKRateLimitEvent` in the message union; (c) `system/api_retry` with `error: "rate_limit"`; (d) `result.total_cost_usd` + per-model tokens per run; (e) OTel metrics export.
- **Undocumented endpoint** used by community tools: `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <oauth access token>` and `anthropic-beta: oauth-2025-04-20`, returning `five_hour`, `seven_day`, `seven_day_sonnet`, `seven_day_opus`, `extra_usage` each with `utilization` (0–100) and `resets_at` (wakamex/ccusage, claude-swap, extropolis/claudia PR #250). Issues anthropics/claude-code #30930/#31021/#31637 (Mar 2026): persistent 429s with `retry-after: 0`; #31637 closed "not planned". Claude Code's own `/usage` falls back to "last-known usage" for 60 min when it is rate limited. Reading the token to call it is exactly the "intermediate credentials" behaviour Anthropic prohibits — **avoid**.
- Local-log tools: **ryoppippi/ccusage** (MIT, 18.8k★; v15; parses local JSONL for Claude Code, Codex, OpenCode, Amp, Droid, pi, Goose, Copilot CLI, Gemini CLI, Kilo, Kimi, Qwen, Hermes, OpenClaw…; `daily|weekly|monthly|session|blocks|statusline`; 5-hour "blocks"); **Maciek-roboblog/Claude-Code-Usage-Monitor** (MIT, 8.7k★, v4.0.0; JSONL + optional official `rate_limits` capture through `--statusline`, plan presets, P90 predictions). Caveat from Anthropic: the JSONL "entry format is internal … scripts that parse these files directly can break on any release" — prefer SDK `result` usage for accounting and these tools only as optional telemetry importers.
- Codex: `/status`, ChatGPT Settings → Usage; app-server `account/rateLimits/read` → `usedPercent`, `windowDurationMins`, `resetsAt`, `planType` (community-documented: CodexFuse, LouisMoretti/AI-usage, t3code issues); `codex exec --json` `turn.completed` usage.
- OpenCode: per-message token usage in SSE events; no plan-limit API.
- Credential stores: Claude Code (Keychain keyed by `CLAUDE_CONFIG_DIR`; `~/.claude/.credentials.json`; `CLAUDE_CODE_OAUTH_TOKEN` 1-year token; bare mode ignores OAuth); Codex (`~/.codex/auth.json` or OS keychain via `cli_auth_credentials_store`; `CODEX_HOME`); OpenCode (`~/.local/share/opencode/auth.json`); Gemini CLI (`~/.gemini/`).
- Rotation tools: **claude-swap** (realiti4; MIT; ~3k★; swaps Keychain/credential files per account, auto-switch at 90% via "the Anthropic usage API", cooldown/hysteresis, parallel sessions), **claude-rotate** (self-hosted proxy riding multiple Max/Pro subscriptions), **ccrotate** (profiles in `~/.ccrotate/profiles.json`). None carries a ToS disclaimer. Risk: Consumer ToS §3 (automation outside API keys) and §2 (no account sharing), AUP multi-account clauses, and the Feb-2026 "OAuth tokens … in any other product … not permitted" wording; Anthropic has banned at least one high-profile user (OpenClaw author, April 2026) and says it enforces "without prior notice".

### 2.6 Claude models and Claude Code features (Oct 2026, from anthropic/claude docs only)

Models (platform.claude.com/docs/en/models/overview):

| Model | API ID | Context / max out | Thinking / default effort | Price in/out per MTok | Retirement not before |
|---|---|---|---|---|---|
| Claude **Fable 5.1** | `claude-fable-5-1` | 1M / 128K | Adaptive (always on) / `high` | $10 / $50 | 2027-09-01 |
| Claude **Opus 5.5** (recommended default) | `claude-opus-5-5` | 1M / 128K | Adaptive (always on) / `medium` | $4 / $20 | 2027-09-22 |
| Claude **Sonnet 5.5** | `claude-sonnet-5-5` | 1M / 128K | Adaptive / `high` | $2 / $10 | 2027-09-28 |
| Claude **Haiku 4.5** | `claude-haiku-4-5-20251001` | 200K / 64K | Extended (manual) / n/a | $1 / $5 | 2026-10-15 |

Legacy still available: Fable 5, Opus 5, Opus 4.8/4.7/4.6/4.5, Sonnet 5, Sonnet 4.6. Dateless IDs are pinned snapshots from the 4.6 generation on; a new tokenizer since Opus 4.7 (1M ≈ 555k words); batch output up to 300k tokens with `output-300k-2026-03-24`; cache reads 10% (2.5% on Fable 5.1 "and Claude Mythos 5.1" — the only mention of a Mythos model I saw; unverified); effort parameter `low|medium|high|xhigh|max`; extended-thinking `budget_tokens` deprecated on 4.6 and rejected later. Models API exposes `max_input_tokens`, `max_tokens`, `capabilities`.

Claude Code (docs, CLI 2.1.287):
- Aliases/defaults: `default` = Opus 5.5 on Pro/Max/Enterprise/API; `best` = Fable where available; `[1m]` suffix; `opusplan`; 1M context is included for Fable/Sonnet 5/Opus 4.7+ on all plans; `/autocompact` window 100K–1M (default ≈967K on 1M models), `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; fallback chains (max 3); content-safety automatic model fallback; `/fast` fast mode.
- Effort: `low|medium|high|xhigh|max` on Fable/Opus 5.5/Sonnet 5.5/Opus 5/Sonnet 5/Opus 4.8/4.7; `ultracode` is a Claude Code setting that orchestrates dynamic workflows (`claude --effort ultracode`).
- Permission modes incl. `auto` (classifier on Sonnet 5; default start mode in interactive sessions since v2.1.283; `-p` starts in `default`); `--restricted`.
- Sessions/agent view: background sessions via `--bg`, supervisor daemon, `claude agents --json` (state `working|blocked|done|failed|stopped`, `waitingFor`), `claude attach|logs|stop|respawn|rm`, automatic worktree isolation under `.claude/worktrees/`; agent teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, ~7× tokens).
- **Remote Control** (Pro/Max/Team/Enterprise; **API keys not supported**): local session registers with the Anthropic API and polls (outbound HTTPS only, no inbound ports); "All traffic travels through the Anthropic API over TLS" with "multiple short-lived credentials"; optional Trusted Devices (passkey/biometric step-up after 18 h); server mode `claude remote-control --spawn worktree --capacity N`; mobile push notifications. **It is relay-based TLS, not end-to-end encrypted** — ByteBureau's E2E phone control must be its own.
- **Cloud sessions / Claude Code on the web** (Pro/Max/Team; Enterprise premium seats): Anthropic VMs or Team/Enterprise self-hosted environments/runners (`claude self-hosted-runner`, `--environment ccpool_…`); GitHub only (bundle upload for others, no push-back); `claude --cloud "task"`, `claude -p "msg" --cloud <id>` queues follow-ups, `--teleport`; auto-fix PRs; routines (`/schedule`); shares the subscription rate limits; no separate VM charge.
- **Plugins** (`/plugin`, marketplaces incl. `claude-plugins-official`; components: skills, agents, hooks, hooks modules = "mods" that can draw panes, MCP servers, LSP; `--plugin-dir/--plugin-url` for sessions); **Skills** (`SKILL.md`, bundled skills like `/loop`, `/ultrareview`); `claude import codex|gemini|cursor`.
- **Channels** (research preview; Pro/Max users opt in per session with `--channels plugin:<name>@<marketplace>`; Telegram/Discord/iMessage/fakechat plugins; allowlisted plugins only unless `--dangerously-load-development-channels`; permission relay capability; in `-p` mode interactive tools are disabled).
- Managed Agents (platform beta `managed-agents-2026-04-01`; API key only; cloud or self-hosted sandboxes) — the API-billed alternative to self-hosting the SDK.

---

## 3) Ranked recommendations for ByteBureau

### 3.1 The "agent runtime" abstraction

**Recommendation: define `AgentRuntime` as an ACP-v1-shaped contract, implemented by native adapters for Claude and Codex and by one generic ACP adapter for everyone else.**

Contract (TypeScript, in-process, transport-agnostic): `initialize() → {capabilities}`, `authenticate(method)` (delegates to the vendor's own flow — never ByteBureau's), `newSession({cwd, mcpServers, mode, model, effort}) → sessionId`, `loadSession(id)`, `prompt(sessionId, blocks) → AsyncIterable<SessionUpdate>` (agent/thought chunks, tool-call start/progress/done with diffs and terminal output, plan/todo, mode change, **plus ByteBureau extensions**: `usage` {input, output, cache, cost}, `contextMeter` {used, max, pct}, `rateLimit` {window, pct, resetsAt}, `question` (AskUserQuestion/elicitation), `structuredResult`), `requestPermission` callback (client side), `cancel(sessionId)`, `setMode`, `listCommands`, `fork(sessionId)`. Everything beyond ACP core rides in `_meta`/`_bytebureau/*` so the same objects can be serialized to a real ACP client (Zed/JetBrains) for free.

Why this shape: ACP already encodes the session/prompt/update/permission loop ByteBureau needs, has 60+ agents and a registry (the "bring your own agent" plugin becomes a one-liner: spawn the registry command, speak ACP), and has stable v1 SDKs; the native adapters add what ACP lacks (usage, context meter, rate limits, structured output, subagent transcripts, hooks).

Transport inside containers: run the harness **in** the container; a tiny ByteBureau "bridge" (Node) inside the container hosts the native adapter and exposes NDJSON over stdio (`docker exec`) or WebSocket to the orchestrator. For OpenCode use `opencode serve` directly; for Codex optionally `codex app-server --listen ws://` (experimental).

### 3.2 Backends to ship as preinstalled plugins (ranked)

1. **Claude (native, via `@anthropic-ai/claude-agent-sdk`)** — richest control surface (hooks, `canUseTool`, `outputFormat`, `effort`, `getContextUsage`, `accountInfo`, `sessionStore`, subagents, plugins/skills/MCP). Subscription path: user runs `claude auth login` once into a ByteBureau-managed `CLAUDE_CONFIG_DIR` volume mounted into that employee's containers; ByteBureau never reads the credential files. Pass `settingSources: []` (+ explicit `settings`) for determinism, **not** `--bare`. Risks: policy volatility (plan revision "with advance notice"), SDK/CLI coupling (take patch releases continuously), 1 GiB+ per session, branding rules ("Claude Agent").
2. **Codex (native, via `@openai/codex-sdk`; fall back to `codex exec --json`)** — structured output via `outputSchema`, threads resume, sandbox modes. Subscription path: user runs `codex login` (device-code beta works headless) into a `CODEX_HOME` volume; verify the SDK honours ChatGPT auth when `CODEX_API_KEY` is absent, else use `codex exec`. Apply for a **Sign in with ChatGPT** client ID as an OSS project for the fully sanctioned route. Risks: app-server "experimental and unsupported"; Plus 5-hour windows.
3. **Generic ACP adapter** — Gemini CLI (free 1,000 req/day), OpenCode (`opencode acp`), Kilo, Goose, Mistral Vibe, Pi (`pi-acp`), Copilot CLI, Cursor, Droid, Qwen/Kimi… one adapter, zero per-agent code. Risks: no usage/cost semantics (fill from local logs or leave blank), adapters lag vendors, remote transport experimental.
4. **OpenCode server plugin** (`opencode serve` + `@opencode-ai/sdk`) — when the user wants OpenCode's 75+ providers (incl. ChatGPT login) with a typed API and SSE; also gives Models.dev model metadata. Risk: no Claude subscription; fast-moving API.
5. **Local/OpenAI-compatible model plugin for the office's own agents** via Vercel AI SDK 7: Ollama (default; Pi 5 friendly; `:cloud` offload), LM Studio (Mac), llama.cpp, OpenRouter `:free`, Mistral Experiment, Gemini API free. Bonus: Ollama's Anthropic-compatible endpoint lets the *Claude* backend run against local models with `ANTHROPIC_BASE_URL` when the subscription is exhausted (quality drop, but zero cost and zero policy risk).
6. Later/optional: AI SDK 7 `HarnessAgent` (one abstraction over Claude Code/Codex/Pi/OpenCode — experimental 1.0.1xx), Managed Agents (API-billed), A2A/AG-UI bridges.

### 3.3 Zero-cost subscription path — how it works safely and legally

1. **Never implement or proxy vendor auth.** Login happens in the vendor's own CLI (`claude auth login`, `claude setup-token`, `codex login --device-auth`), inside a per-user config volume; ByteBureau only checks `claude auth status --text`/exit code and `authMethod` (`claude.ai | oauth_token | api_key | …`) and shows the result.
2. **One human, one subscription, that human's own tickets.** Multiple ByteBureau employees (containers) may share the owner's config dir; all count toward the same 5-hour/weekly windows. Never route a colleague's tickets through the owner's seat; team use = each member's own login or API key.
3. **Profiles, not pooling.** Support N named profiles (each a `CLAUDE_CONFIG_DIR`/`CODEX_HOME`), explicit assignment per employee, per-profile usage bars. Offer "failover to another of *my* profiles when a window is exhausted" only as an opt-in with a ToS warning; do not ship automatic round-robin or a token-rotating proxy.
4. **Show limits from sanctioned sources only:** SDK `accountInfo()`, `SDKRateLimitEvent`/`api_retry`, `result` usage, status-line `rate_limits` (if it fires headless), Codex `account/rateLimits/read`; optional import from ccusage-style local logs. Do not call `/api/oauth/usage` with scraped tokens.
5. **Keep the escape hatches wired:** per-employee switch to API key (Console), Bedrock/Vertex/Foundry, Ollama/LM Studio (Anthropic-compatible), or ACP agent; a `--bare`/API-key mode for CI.
6. **Branding/compliance:** "Claude Agent", "Codex", unmodified binaries, `clientInfo.name = "bytebureau"` on app-server, honour `--permission-prompts none` semantics so unattended runs never fake approvals.

### 3.4 Protocol posture

Speak **ACP v1** and **MCP 2026-07-28** natively (expose Jira/Slack/git tools as MCP servers; consume MCP in the office agents with `@modelcontextprotocol/sdk` 1.31.0 or AI SDK's MCP client). Model ByteBureau's UI event stream on **AG-UI 1.0** vocabulary. Provide **A2A** (server/client) and ACP-v2/HTTP as plugins once stable.

### 3.5 Generic LLM layer

**Vercel AI SDK 7** for triage/summaries/office chatter/structured extraction (`generateObject`, `ToolLoopAgent`, approvals, MCP). Keep Mastra/LangGraph out of the core; revisit only if the orchestrator needs durable graph semantics ByteBureau does not want to write.

---

## 4) Rejected options and why

- **Driving Claude via raw `claude -p --bare` for the subscription path** — bare mode never reads OAuth/Keychain; API key only.
- **Re-implementing Anthropic's OAuth flow / reading `.credentials.json` / token-rotating proxies (claude-rotate, ccrotate, auto-switching claude-swap)** — explicitly prohibited ("may not collect, store, or intermediate Claude.ai credentials or session tokens"; consumer ToS automation/sharing clauses; AUP multi-account clauses); enforcement without notice.
- **Shipping OpenCode's community Claude Pro/Max plugins** — Anthropic forced their removal; same prohibition.
- **Codex app-server as the primary Codex transport** — "experimental and unsupported for production"; use the SDK/`codex exec`, keep app-server optional.
- **IBM Agent Communication Protocol** — merged into A2A (2025-08-29); dead.
- **Aider** — dormant since May 2026 (no commits/releases), Python, no structured event stream.
- **Crush as a core backend** — FSL-1.1-MIT (not OSI; converts to MIT after 2 years), headless model-selection bugs; fine via ACP/`crush serve` as a user-added agent.
- **Amp / Factory Droid / Cursor as preinstalled backends** — require paid credits/API keys or undocumented plan terms; user-added via ACP only.
- **Google ADK-JS, Inngest AgentKit, VoltAgent, Effect AI for the core** — Gemini lock-in/heavy deps; stale + Inngest runtime; AI-SDK-6 peer lag; alpha on Effect v3 while v4 is in beta.
- **vLLM for Mac/Pi** — no native macOS/arm SBC path.
- **Anthropic Remote Control as ByteBureau's phone channel** — subscription-only, relay-TLS not E2E, API keys unsupported; ByteBureau needs its own E2E control plane.
- **Parsing `~/.claude/projects/*.jsonl` as the primary accounting source** — Anthropic warns the format is internal and may break per release; use SDK `result` usage/OTel instead (ccusage import optional).

---

## 5) Open questions needing the owner's decision

1. **Policy risk appetite for the Anthropic subscription path.** Today `claude -p`/Agent SDK/third-party apps draw from plan limits, but Anthropic has announced a revision is coming (monthly "Agent SDK credit" of $20–$200 was the last proposal). Design for it now (usage credits toggle, API-key fallback)? Should ByteBureau default to subscription or ask on first run?
2. **Apply for OpenAI "Sign in with ChatGPT" (OSS tier) early?** It needs a client ID request and an OAuth redirect in ByteBureau's UI; until approved, rely on the user's own `codex login` in the container.
3. **Multi-account semantics:** profiles with manual assignment only, or opt-in failover among the owner's own subscriptions (gray zone)?
4. **Interface shape:** adopt ACP v1 objects verbatim (serializable to real ACP clients, Zed/JetBrains can attach to a ByteBureau employee) vs a slimmer bespoke interface with an ACP adapter on the edge.
5. **Which experimental pieces to bet on:** AI SDK 7 `HarnessAgent` adapters, ACP v2/HTTP streams, Codex app-server WebSocket — track or ignore for v1?
6. **Default local backend per platform:** Ollama everywhere (simplest, Pi 5 OK, Anthropic-compatible) vs LM Studio/MLX on the Mac for speed.
7. **Mistral:** API Experiment tier (limits now unpublished) vs paid Devstral 2 — is "Mistral" a hard requirement or a nice-to-have provider entry via AI SDK?
8. **Usage telemetry source:** rely only on SDK/CLI-provided data (sanctioned) or also run ccusage-style local-log importers (fragile, but cross-agent)?
9. **Isolation vs cost:** one `CLAUDE_CONFIG_DIR` volume shared by all of the owner's employee containers (simple, one login) vs per-employee copies (clean isolation, N logins or a copied credential file — the latter edges toward "intermediating credentials").
10. **MCP transitional incompatibilities:** Claude Code currently refuses channel servers negotiating 2026-07-28 on its v2 client; which MCP revision should ByteBureau's own servers negotiate by default (2025-11-25 with upgrade) ?

---

## 6) Full source list (fetched 2026-10-02)

Anthropic / Claude (official)
- https://code.claude.com/docs/en/legal-and-compliance
- https://code.claude.com/docs/en/authentication
- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/agent-sdk/typescript (and `.md`)
- https://code.claude.com/docs/en/agent-sdk/user-input
- https://code.claude.com/docs/en/agent-sdk/session-storage
- https://code.claude.com/docs/en/agent-sdk/hosting
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/commands
- https://code.claude.com/docs/en/sessions
- https://code.claude.com/docs/en/costs
- https://code.claude.com/docs/en/statusline
- https://code.claude.com/docs/en/model-config
- https://code.claude.com/docs/en/permission-modes
- https://code.claude.com/docs/en/agent-view
- https://code.claude.com/docs/en/remote-control
- https://code.claude.com/docs/en/channels
- https://code.claude.com/docs/en/claude-code-on-the-web
- https://code.claude.com/docs/en/plugins/overview
- https://platform.claude.com/docs/en/models/overview
- https://platform.claude.com/docs/en/managed-agents/overview
- https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan
- https://www.anthropic.com/legal/consumer-terms
- https://www.anthropic.com/legal/aup
- https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
- https://github.com/anthropics/claude-agent-sdk-typescript
- https://github.com/anthropics/claude-code/issues/31637 (and search hits #30930, #31021)
- npm registry: @anthropic-ai/claude-agent-sdk, @anthropic-ai/claude-code

Anthropic policy coverage (press)
- https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/
- https://the-decoder.com/anthropic-cuts-off-third-party-tools-like-openclaw-for-claude-subscribers-citing-unsustainable-demand/
- https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch
- https://www.betterclaw.io/blog/openclaw-anthropic-subscription-ban
- https://claudefa.st/blog/guide/development/claude-code-subscription
- https://gigazine.net/gsc_news/en/20260220-anthropic-third-party-block/ ; https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/ ; https://dev.to/mcrolly/… ; https://www.kucoin.com/news/flash/anthropic-unbans-third-party-agents-with-monthly-usage-caps-starting-june-2026 ; https://www.techtimes.com/articles/317625/20260602/… (search results)

OpenAI / Codex (official)
- https://learn.chatgpt.com/docs/codex-sdk
- https://learn.chatgpt.com/docs/non-interactive-mode
- https://learn.chatgpt.com/docs/auth
- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/pricing
- https://learn.chatgpt.com/docs/sign-in-with-chatgpt
- https://developers.openai.com/siwc
- https://github.com/openai/codex ; /blob/main/sdk/typescript/README.md ; /blob/main/codex-rs/app-server/README.md ; /releases
- npm registry: @openai/codex, @openai/codex-sdk, @openai/agents
- Third-party: https://codex.danielvaughan.com/2026/04/15/codex-app-server-complete-guide/ ; https://www.promptfoo.dev/docs/providers/openai-codex-app-server/ ; https://runtimewire.com/article/openai-launches-login-with-chatgpt-and-routes-plan-usage-into-third-party-ai-app ; https://daily.dev/posts/openai-makes-sign-in-with-chatgpt-… ; https://9to5mac.com/2026/08/24/openai-restores-5-hour-codex-and-work-limits-for-chatgpt-plus-users/ ; https://iaplabs.itch.io/codexfuse/devlog/1655686/…

ACP / MCP / A2A / AG-UI
- https://agentclientprotocol.com/overview/introduction ; /protocol/overview ; /get-started/agents
- https://github.com/agentclientprotocol/agent-client-protocol ; /typescript-sdk ; /codex-acp
- https://github.com/zed-industries/claude-code-acp (+ raw README) ; https://github.com/zed-industries/codex-acp (archived)
- https://zed.dev/blog/acp-registry ; https://zed.dev/blog/acp-progress-report
- npm registry: @agentclientprotocol/sdk, @agentclientprotocol/claude-agent-acp, @agentclientprotocol/codex-acp, @zed-industries/claude-code-acp; npm search "@agentclientprotocol"
- https://www.danilchenko.dev/posts/agent-client-protocol/ (third-party)
- https://modelcontextprotocol.io/specification/2026-07-28/changelog ; npm @modelcontextprotocol/sdk
- https://opensource.googleblog.com/2026/04/a-year-of-open-collaboration-celebrating-the-anniversary-of-a2a.html ; npm @a2a-js/sdk ; IBM ACP merger (search: LF 2025-08-29; ibm.com/think/topics/agent-communication-protocol)
- https://www.copilotkit.ai/blog/ag-ui-1.0 ; npm @ag-ui/core
- https://aaif.io/ (AAIF working groups) ; Goose README (AAIF membership)

OpenCode / Models.dev
- https://github.com/anomalyco/opencode ; /releases
- https://opencode.ai/docs/providers/ ; /docs/sdk/ ; /docs/plugins/ ; /docs/server/ ; /docs/acp/ ; /docs/cli/
- npm registry: opencode-ai, @opencode-ai/sdk
- https://models.dev/
- Community Claude plugins (not recommended): https://github.com/xtruder/opencode-claude-max-plugin ; https://github.com/ianjwhite99/opencode-with-claude

Other agents
- https://github.com/google-gemini/gemini-cli ; /blob/main/docs/cli/headless.md ; https://geminicli.com/docs/cli/headless/ ; npm @google/gemini-cli
- https://github.blog/changelog/2026-01-14-copilot-sdk-in-technical-preview/ ; https://github.com/github/copilot-sdk ; npm @github/copilot-sdk
- https://cursor.com/docs/cli/headless
- https://docs.factory.com/droid-exec/overview
- https://www.daytona.io/docs/en/guides/amp/amp-sdk-coding-agent/ (Amp streaming JSON; ampcode.com/news/streaming-json failed to parse)
- https://kilo.ai/docs/code-with-ai/platforms/cli ; npm @kilocode/cli
- https://github.com/aaif-goose/goose
- https://github.com/charmbracelet/crush
- https://pi.dev/ ; https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md ; https://hochej.github.io/pi-mono/coding-agent/rpc/ ; npm @earendil-works/pi-coding-agent
- https://mistral.ai/news/devstral-2-vibe-cli/
- Aider status: morphllm / shortlisted.tools search results (third-party)

Generic SDKs
- https://vercel.com/blog/ai-sdk-6 ; https://vercel.com/blog/ai-sdk-7 ; https://github.com/vercel/ai/releases ; npm ai ; npm search "@ai-sdk harness"
- https://github.com/mastra-ai/mastra ; npm @mastra/core
- npm @langchain/langgraph ; LangChain 1.0 blog (search)
- https://github.com/openai/openai-agents-js
- https://github.com/google/adk-js ; npm @google/adk
- https://github.com/VoltAgent/voltagent ; npm @voltagent/core
- https://github.com/inngest/agent-kit ; npm @inngest/agent-kit
- https://effect.website/docs/ai/introduction/ ; npm @effect/ai ; InfoQ Effect v4 beta (search)

Local inference / free tiers
- https://ollama.com/blog/claude ; https://ollama.com/blog/launch ; https://ollama.com/cloud ; npm ollama
- https://lmstudio.ai/docs/developer ; https://lmstudio.ai/work ; npm @lmstudio/sdk
- https://github.com/ggml-org/llama.cpp/releases
- MLX: GitHub search hits (jasontitus/mlx-serve, raullenchai/Rapid-MLX, Ar9av/mlx-lm-server), WWDC26 session 232 (third-party/unverified details)
- https://openrouter.ai/docs/api-reference/limits
- https://pricepertoken.com/endpoints/mistral/free (third-party; docs.mistral.ai tier page 404)

Usage / rotation tooling
- https://github.com/ryoppippi/ccusage ; https://github.com/wakamex/ccusage ; https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor
- https://github.com/realiti4/claude-swap ; search hits: doxaras/claude-rotate, somersby10ml/ccrotate, extropolis/claudia PR #250
