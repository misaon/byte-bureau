# ByteBureau Research Report: Claude Agent SDK & Claude Code Integration

**Date**: October 2, 2026  
**Research Scope**: TypeScript multi-agent orchestrator integration with Claude Code / Claude Agent SDK  
**Status**: Evidence-based research from official Anthropic documentation and verified sources

---

## Executive Summary

**Critical Finding: OAuth Subscription Authentication is Prohibited for Third-Party Applications**

Anthropic enforced a policy (effective January 2026, clarified February 19, 2026) prohibiting the use of Claude Pro/Max subscription OAuth tokens with third-party applications, including the Claude Agent SDK. **ByteBureau cannot use the user's Claude Pro/Max subscription login for headless agent orchestration**. Must use API key authentication via Claude Console instead.

---

## 1. Claude Agent SDK for TypeScript

### Package Information
- **Package Name**: `@anthropic-ai/claude-agent-sdk`  
- **Latest Version**: 0.3.286 (released September 30, 2026)  
- **Registry**: npm (@anthropic-ai/claude-agent-sdk)  
- **Node Requirement**: Node 18+  
- **Repository**: github.com/anthropics/claude-agent-sdk-typescript  
- **Source**: [npm package page](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)

### Core API: `query()` Function

```typescript
function query({
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;
```

**Returns**: AsyncGenerator streaming message objects.

### Query Options

| Option | Type | Description |
|--------|------|-------------|
| `cwd` | `string` | Current working directory |
| `model` | `string` | Model ID (e.g., `"claude-opus-5-5"`, `"claude-sonnet-5-5"`) |
| `effort` | `string` | Level: `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` |
| `maxTurns` | `number` | Maximum agentic turns |
| `tools` | `string[]` | Tool names to enable |
| `mcpServers` | `Record<string, McpServerConfig>` | MCP server configurations (stdio, SSE, HTTP) |
| `systemPrompt` | `string \| object` | Custom system prompt or preset |
| `permissionMode` | `PermissionMode` | One of: `"default"`, `"acceptEdits"`, `"bypassPermissions"`, `"plan"`, `"dontAsk"`, `"auto"` |
| `canUseTool` | `CanUseTool` callback | Programmatic permission handler; signature: `(toolName, input, options) => Promise<{behavior: "allow"\|"deny", message?, updatedPermissions?}>` |
| `continue` | `boolean` | Resume most recent session |
| `resume` | `string` | Session ID to resume |
| `settings` | `string \| Settings` | Inline or file-path settings |
| `settingSources` | `string[]` | Which settings to load: `['user', 'project', 'local']` |
| `includePartialMessages` | `boolean` | Include streaming deltas in output |
| `thinking` | `{type: "adaptive" \| "enabled" \| "disabled"}` | Extended thinking mode |

### Message Types & Streaming

**Three Core Message Types**:

1. **Assistant Message** (`SDKAssistantMessage`)
   ```typescript
   {
     type: "assistant";
     uuid: UUID;
     message: BetaMessage;
     context_usage?: {inputTokens, cacheCreationInputTokens, cacheReadInputTokens};
     error?: {code, message};
   }
   ```

2. **User Message** (`SDKUserMessage`)
   ```typescript
   {
     type: "user";
     uuid?: UUID;
     message: MessageParam;
     client_composed?: true;
     shouldQuery?: boolean;
   }
   ```

3. **Result Message** (`SDKResultMessage`)
   ```typescript
   {
     type: "result";
     subtype: "success" | "error" | "user_interrupt" | "max_turns_reached";
     uuid: UUID;
     duration_ms: number;
     result: string;
     stop_reason: string | null;
   }
   ```

**Stream Format**: With `--output-format stream-json` on CLI, output is newline-delimited JSON with message types: `assistant`, `user`, `result`, `system` (API retry, init, plugin install events).

### Query Object Methods

- `interrupt(): Promise<SDKControlInterruptResponse | undefined>` — Stop mid-session
- `setPermissionMode(mode): Promise<void>` — Change permission mode
- `setModel(model?): Promise<void>` — Switch model
- `applyFlagSettings(settings): Promise<void>` — Update settings
- `supportedModels(): Promise<ModelInfo[]>` — List available models
- `supportedCommands(): Promise<SlashCommand[]>` — List commands
- `getContextUsage(): Promise<SDKControlGetContextUsageResponse>` — Token/context info
- `readFile(path, options?): Promise<SDKControlReadFileResponse | null>` — File read (no permission prompt)
- `close(): void` — End session

### Structured Outputs

With `--json-schema`, pass JSON Schema v2020-12 to define output structure. Claude Code validates and returns structured output in a `structured_output` field alongside metadata.

### Session Management

```typescript
listSessions({dir?, limit?});
getSessionMessages(sessionId, {limit?});
renameSession(sessionId, newName);
```

### Pre-warming Sessions

```typescript
const warm = await startup({options: {maxTurns: 3}});
for await (const message of warm.query("What files are here?")) {
  console.log(message);
}
```

**Cost & Usage Reporting** (via message events and result):
- `context_usage`: input tokens, cache creation/read tokens
- `total_cost_usd`, `total_input_tokens`, `total_output_tokens` in final result
- Includes subagent spend

### Subagents & Agents

Subagents run in isolated context (fresh or forked). Defined in `.claude/agents/` or via `--agents` CLI:

```yaml
---
name: code-reviewer
description: Reviews code changes
model: sonnet  # or: inherit, fable, opus, haiku, or full model ID
effort: high   # overrides --effort
tools: Read, Grep, Glob
permissionMode: auto
maxTurns: 5
background: true
---
You are a code reviewer. For each issue, explain and suggest fixes.
```

**Invocation**: Natural language mention, `@"agent-name (agent)"` mention, or `--agent` CLI flag.

### MCP Server Configuration

```typescript
mcpServers: {
  "web": {
    type: "stdio" | "sse" | "http";
    command?: string;        // stdio only
    args?: string[];         // stdio only
    url?: string;            // sse/http
    headers?: Record<string, string>;
  }
}
```

**Elicitation Flow**: MCP tools can call `client.request({role: "user", ...})` for user input; SDK host must implement callback or use `--permission-prompt-tool` MCP server.

### Sources
- [Agent SDK TypeScript Reference](https://code.claude.com/docs/en/agent-sdk/typescript) (Claude Code Docs)
- [@anthropic-ai/claude-agent-sdk npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)

---

## 2. Authentication: Subscription vs. API Key (CRITICAL CONSTRAINT)

### **POLICY RESTRICTION: OAuth Subscription Tokens Not Permitted for Third-Party Apps**

**Enforcement Date**: January 9, 2026 (blocking began); February 19, 2026 (policy clarified)  
**Status**: Active, enforced

**Official Policy Summary** (from Anthropic support and legal docs):

> "OAuth authentication used with Free, Pro, and Max plans is intended exclusively for Claude Code and Claude.ai. Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service—including the Agent SDK—is **not permitted**."

> "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users."

**Sources**: 
- [Support: Use Claude Agent SDK with Claude Plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [OAuth Lockdown Announcement (Feb 19, 2026)](https://www.winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/) (WinBuzzer)
- [Anthropic Officially Bans Third-Party Subscription Auth (Feb 2026)](https://gigazine.net/gsc_news/en/20260220-anthropic-third-party-block/) (GIGAZINE)

### Authentication Methods for Third-Party Applications

#### Permitted: API Key Authentication
- **Method**: Claude Console API key (`sk-ant-api03-*`)
- **Billing**: Pay-per-use via Claude Console
- **Setup**: [platform.claude.com](https://platform.claude.com) → create API key
- **How**: Set `ANTHROPIC_API_KEY` environment variable or use `apiKeyHelper`
- **Duration**: No expiration (static credential)
- **Rotation**: Manual

#### Permitted: Long-Lived OAuth Token (For Your Own Apps Only)
- **Token Type**: `CLAUDE_CODE_OAUTH_TOKEN` (sk-ant-oat01-*)
- **Generation**: `claude setup-token` (browser-based auth)
- **Duration**: 1 year
- **Use Case**: CI/CD pipelines, scripts where browser login unavailable
- **Restriction**: Requires Claude subscription (Pro/Max) but token is for **your own infrastructure only**, not reusable by end-users
- **Revocation**: Via `claude auth logout` or token expiry

#### Not Permitted: End-User Subscription OAuth
- ❌ Cannot accept user's Claude Pro/Max login
- ❌ Cannot use `CLAUDE_CODE_OAUTH_TOKEN` from end-user subscriptions
- ❌ ByteBureau cannot offer "login with Claude" to users

### Docker / Headless Setup

**For headless servers/Docker with API key**:

```bash
# Set at container startup
export ANTHROPIC_API_KEY="sk-ant-api03-..."
claude -p "query" --output-format json
```

**Credential storage**:
- macOS: `~/Library/Keychains/` (Keychain) or `~/.claude/.credentials.json` (fallback, mode 0600)
- Linux: `~/.claude/.credentials.json` (mode 0600)
- Windows: `%USERPROFILE%\.claude\.credentials.json` (user ACLs)
- Custom `CLAUDE_CONFIG_DIR` overrides location

**DevContainer / Docker best practices**:
- Pass `ANTHROPIC_API_KEY` as secret (not in image)
- Use volume mount for credentials: `-v $HOME/.claude:/.claude`
- No need for browser during runtime
- `claude -p --bare` skips auto-discovery (faster startup)

**Multiple profiles** (user/project/local):
- `--settings sources` flag controls which load
- Set `CLAUDE_CONFIG_DIR` for profile isolation
- Profiles do not share subscriptions

### Sources
- [Claude Code: Authentication](https://code.claude.com/docs/en/authentication.md)
- [Generate long-lived token: claude setup-token](https://code.claude.com/docs/en/authentication.md#generate-a-long-lived-token)
- [Support article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

---

## 3. Headless CLI: `claude -p` Flags & Modes

### Essential Flags for ByteBureau

| Flag | Purpose | Example |
|------|---------|---------|
| `-p` / `--print` | Non-interactive mode; returns JSON/text, exits | `claude -p "query"` |
| `--output-format` | `text`, `json`, `stream-json` | `--output-format stream-json` |
| `--input-format` | `text`, `stream-json` for stdin | `--input-format stream-json` |
| `--session-id` | Explicit UUID (must be valid UUID) | `--session-id 550e8400-...` |
| `--fork-session` | Create new ID on resume | `--resume abc --fork-session` |
| `--model` | Model alias or full ID | `--model claude-opus-5-5` |
| `--effort` | Effort level: low/medium/high/xhigh/max | `--effort high` |
| `--max-turns` | Agentic turn limit | `--max-turns 5` |
| `--max-budget-usd` | Spend cap; stops when hit | `--max-budget-usd 5.00` |
| `--permission-mode` | `default`, `acceptEdits`, `auto`, `dontAsk`, `plan` | `--permission-mode dontAsk` |
| `--permission-prompts` | `none` = deny unprompted; `host` = SDK callback | `--permission-prompts none` |
| `--permission-prompt-tool` | MCP tool for permission handling | `--permission-prompt-tool mcp_tool` |
| `--allowedTools` | Pre-approve tools; supports patterns | `--allowedTools "Bash(git *),Read"` |
| `--disallowedTools` | Deny-list tools | `--disallowedTools "Write,Bash(rm *)"` |
| `--bare` | Skip hooks, skills, CLAUDE.md, plugins, MCP auto-discovery | `claude --bare -p "q"` |
| `--mcp-config` | Load MCP servers from JSON/file | `--mcp-config ./mcp.json` |
| `--json-schema` | Structured output schema (JSON Schema) | `--json-schema '{"type":"object",...}'` |
| `--continue` / `-c` | Resume recent session | `claude -p "next step" --continue` |
| `--resume` / `-r` | Resume by ID/name | `--resume sessionid123` |
| `--replay-user-messages` | Re-emit user messages on stdout | `--replay-user-messages` |
| `--include-partial-messages` | Include streaming deltas | `--include-partial-messages` |
| `--settings` | Override settings for session | `--settings '{"model":"sonnet"}'` |
| `--append-system-prompt` | Add to default system prompt | `--append-system-prompt "rules"` |
| `--system-prompt` | Replace entire system prompt | `--system-prompt "custom"` |
| `--init-only` | Run Setup/SessionStart hooks; exit | `--init-only` |
| `--init` | Run Setup hooks before session (print mode) | `-p --init "q"` |
| `--debug` | Enable debug logging (categories: `mcp,startup`) | `--debug='mcp,startup'` |
| `--debug-file` | Write debug logs to file | `--debug-file /tmp/debug.log` |
| `--environment` | Self-hosted environment ID | `--environment ccpool_abc123` |

### Stream-JSON Output Schema

Each newline is a JSON object; final line is result:

```json
{
  "type": "assistant|user|result|system",
  "uuid": "...",
  "message": {...},
  "context_usage": {"inputTokens": 1234, "cacheCreationInputTokens": 0},
  "event": {...}
}
```

**System event examples**:
- `system/init`: Model, tools, plugins, MCP servers, capabilities
- `system/api_retry`: Attempt #N, retry_delay_ms, error status
- `system/plugin_install`: Install progress

### Bare Mode (`--bare`)

Skips:
- Hooks (Setup, SessionStart, PreCompact, PostCompact)
- Skills auto-discovery (can load from `--add-dir`)
- Plugins & MCP auto-discovery
- CLAUDE.md auto-loading
- Custom commands, subagents
- Subscript OAuth (requires `ANTHROPIC_API_KEY`)

Keeps: Bash, Read, Edit tools; MCP from `--mcp-config`

**Trade-off**: Fast startup (~500ms vs ~2s) but no project context.

### Sandbox & Network

**Sandbox scope**:
- `/tmp` and project directory writable
- Home directory read-only
- No access to other projects
- Network: not blocked (MCP servers, web tools available)

**For strict sandboxing**:
- Use `--restricted` flag (prevents code execution, WebFetch)
- Confines file access to working directories
- Removes command-running tools unless whitelisted

### Sources
- [CLI Reference](https://code.claude.com/docs/en/cli-reference.md) (Claude Code Docs)
- [Headless / SDK Mode](https://code.claude.com/docs/en/headless.md)
- [Permission Modes](https://code.claude.com/docs/en/permission-modes.md)

---

## 4. Observability & Cost Tracking

### Usage Reporting (CLI & SDK)

**With `--output-format json`**:
```json
{
  "session_id": "...",
  "result": "...",
  "total_cost_usd": 0.0234,
  "total_input_tokens": 1200,
  "total_output_tokens": 340,
  "model": "claude-sonnet-5-5"
}
```

**Per-message context usage** (streamed):
```json
{
  "context_usage": {
    "inputTokens": 1200,
    "cacheCreationInputTokens": 0,
    "cacheReadInputTokens": 100
  }
}
```

**Cost tracking**:
- Client-side estimation (may differ from bill)
- Includes subagent spend
- Accumulates across `--continue` / `--resume`
- Estimates input, output, and cache read/write costs

### Debug Logging

- **Flag**: `--debug` or `--debug='category1,category2'`
- **Categories**: `mcp`, `startup`, `api`, `hooks`, `plugins`, etc.
- **Location**: Printed to stderr; or `--debug-file path`
- **Session logs**: Stored at `~/.claude/sessions/{session-id}/transcript.jsonl`
- **Transcript format**: JSONL, each line is a message (assistant, user, tool_use, tool_result)

### OpenTelemetry / Metrics Export

**Unverified**: Official Anthropic OpenTelemetry instrumentation not documented in public docs. No mention of environment variables like `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_TRACES_EXPORTER` in Claude Code docs as of Oct 2, 2026.

Possible but undocumented; not recommended for production integration.

### Usage / Rate Limits Visibility

- **In-session**: `/usage` command shows 7-day token usage, cost estimate
- **API**: Claude API headers include `anthropic-ratelimit-limit-tokens` (deprecated) / `anthropic-ratelimit-remaining-tokens`
- **Console**: [platform.claude.com/usage](https://platform.claude.com/usage) shows account-level usage
- **Rate Limit Windows**: Not exposed programmatically; subscription plans (Pro/Max) have monthly spend limits visible in account settings

### Sources
- [Claude Code: Headless](https://code.claude.com/docs/en/headless.md)
- [Agent SDK: Cost Tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking.md) (mentioned but not fully fetched)
- [Commands: /usage](https://code.claude.com/docs/en/commands.md)

---

## 5. Features to Mirror: Skills, Plugins, Subagents, Eval

### Skills (SKILL.md)

**Location**: `.claude/skills/name/SKILL.md` (project) or `~/.claude/skills/name/SKILL.md` (user)

**Spec**:
```yaml
---
name: skill-name                    # Optional; defaults to directory
description: "When to use this skill" # Triggers model invocation
when_to_use: "Extra context"
disable-model-invocation: false     # Only manual /skill-name invocation
user-invocable: true                # Hide from / menu if false
allowed-tools: |
  Bash(git add *)
  Bash(git commit *)
model: sonnet                       # Override model
effort: high                        # Override effort
argument-hint: "<args>"
arguments:                          # Named arguments
  - name: issue_number
    type: string
paths: ["src/**"]                   # Limit activation to globs
shell: bash                         # or: powershell
context: fork | main                # fork = isolated subagent
agent: AgentName                    # Subagent to run in
background: false                   # Run in background
---

Your skill instructions here.

## Usage
/skill-name <arguments>

!`command-to-inject`                # Dynamic context injection
$ARGUMENTS, $0, $1, $name           # Argument substitution
```

**Best Practices**:
- Keep SKILL.md focused; move reference material to separate files
- Use dynamic injection (!`command`) for live data
- Pre-approve tools to avoid prompts
- Descriptions max ~1,536 chars

### Plugins (plugin.json)

**Directory structure**:
```
my-plugin/
├── .claude-plugin/
│   └── plugin.json           # Manifest
├── skills/
│   └── skill-name/
│       └── SKILL.md
├── agents/
│   └── agent-name.md         # Subagent definitions
├── hooks/
│   └── hooks.json            # Lifecycle hooks
├── .mcp.json                 # MCP servers
└── README.md
```

**plugin.json** (minimal):
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What this plugin does"
}
```

**Install**: `claude plugin install name@marketplace` or `--plugin-dir ./path`

**Marketplaces**:
- Official: `claude-plugins-official`
- Community: `claude-community`
- Custom: any `marketplace.json` with plugin list

### Subagents (Agent Definitions)

**Location**: `.claude/agents/name.md` (project) or `~/.claude/agents/name.md` (user)

**Frontmatter fields**:
```yaml
name: agent-name
description: When Claude should delegate
tools: Read, Grep, Bash              # Inherit all if omitted
disallowedTools: Write, Edit
model: sonnet | opus | haiku | fable | inherit | <full-id>
effort: low | medium | high | xhigh | max
permissionMode: default | acceptEdits | auto | dontAsk | plan
maxTurns: 10
skills: skill1, skill2
memory: user | project | local
background: true
mcpServers: {server1: {...}}
hooks: {...}
isolation: worktree
```

**Invocation**:
- Natural language: "Use the reviewer agent to check auth.py"
- @-mention: `@"agent-name (agent)"`
- CLI: `--agent agent-name`
- `/subtask`: Fork current conversation into subagent

### Plugin Eval (`claude plugin eval`)

**Release**: v2.1.269 (September 11, 2026)  
**Purpose**: Test plugins with realistic cases, grade outputs, compare vs. baseline (no plugin)

**Case structure** (in `evals/` directory):
```
evals/case-name/
├── prompt.md                # Frontmatter: name, tags, plugins, runs, max_turns, timeout_seconds, allowed_tools, model, append_system_prompt, env
└── graders/
    ├── regex.md            # pattern, flags, match: contains|not_contains|count:N, target: last_message|trace|files
    ├── tool_used.md        # tool, input_match, min, max, target
    ├── tool_order.md       # before, after
    ├── file_exists.md      # path (glob)
    ├── llm.md              # criteria, focus (judge model votes 2-of-3)
    └── baseline.md         # baseline_file, criteria
```

**Running**:
```bash
claude plugin eval path-or-name [--case glob] [--tag tag] [--runs 3] [--model m] [--json file.json] [--threshold 0..1] [--max-cost-usd 10] [--allow-tools tool] [--mocks record|off] [--keep-temp] [--report path] [--publish-report|--no-publish] [--ablation none|with-without] [--trust-plugin]
```

**Output**:
- `results/<timestamp>/aggregate-result.json` (schemaVersion: "1", cases[], aggregates.casesPassed, meanDelta)
- `report.html` (optional publish to claude.ai artifact)
- Exit codes: 0 (pass), 1 (fail/error), 2 (partial, cost ceiling hit)

**Mocks**: Replace MCP servers with deterministic stand-ins; `evals/mocks/server/tool.md`

**Baseline arm**: Run without plugin to measure delta

### `/skill-doctor` Command

- **Availability**: Generally available (no gate since early access)
- **Purpose**: Per-skill usage report: tokens/cost per skill, 7-day uses, never-invoked warnings, unused plugin detection
- **Output**: Interactive in terminal (Stats tab), text in `-p` / Remote Control / background sessions
- **Use**: Identify dead weight skills draining context window

### Sources
- [Skills Guide](https://code.claude.com/docs/en/skills.md)
- [Plugins Overview](https://code.claude.com/docs/en/plugins/overview.md)
- [Subagents](https://code.claude.com/docs/en/sub-agents.md)
- [Plugin Evals](https://code.claude.com/docs/en/plugin-evals.md)

---

## 6. Current Claude Models (October 2026)

### Active Model Lineup

| Model | API ID | Context | Max Output | Effort Levels | Type |
|-------|--------|---------|-----------|------------------|------|
| **Claude Opus 5.5** | `claude-opus-5-5` | 1M tokens | 128K tokens | low/medium/high/xhigh/max | Latest flagship |
| **Claude Sonnet 5.5** | `claude-sonnet-5-5` | 1M tokens | 128K tokens | low/medium/high/xhigh/max | Balanced |
| **Claude Sonnet 5** | `claude-sonnet-5` | 1M tokens | 128K tokens | low/medium/high/xhigh/max | (prev version) |
| **Claude Haiku 4.5** | `claude-haiku-4-5` | 200K tokens | 64K tokens | low/medium/high/xhigh | Fast, compact |
| Claude Fable | `claude-fable-5` / `fable` | Not specified | 128K (assumed) | low/medium/high/xhigh | Lightweight (advisor mode) |

**Release Dates**:
- Claude Opus 5.5: September 22, 2026
- Claude Sonnet 5.5: September 2026
- Claude Haiku 4.5: Earlier (2025)

### Effort Levels

Available on all current models:
- `low`: Fast, uses fewer tokens
- `medium`: Balanced (default)
- `high`: More thinking, better quality
- `xhigh`: Extended thinking
- `max`: Maximum effort

**Setting**: Via `--effort` flag, subagent `effort`, skill `effort`, or in settings.json

### Pricing (Usage-Based, API Key)

Not specified in documentation (varies by region/plan). Check [platform.claude.com/pricing](https://platform.claude.com/pricing) or Claude Console for current rates.

### Model Selection for ByteBureau

- **Orchestrator**: Opus 5.5 or Sonnet 5.5 (1M context for large project loads)
- **Agents**: Sonnet 5.5 (balanced), Haiku 4.5 (cost-optimized)
- **Effort**: `medium` (default) for most; `high` for critical tasks

### Sources
- [Claude Models (Web search)](https://agentskit.co/blog/claude-models)
- [Claude models comparison](https://www.ai-toolbox.co/claude-models/claude-context-window-token-limits-2026)

---

## 7. Claude Code Version & Release Cadence

- **Latest Release**: v2.1.286 (September 30, 2026)
- **Cadence**: Nearly daily minor updates
- **Prior**: v2.1.285 (Sept 29, 2026), v2.1.278 (Sept 19, 2026)
- **Channel**: `mise` package manager, npm (`@anthropic-ai/claude-agent-sdk`), GitHub releases

**Update**: `claude update` or `claude install stable|latest|<version>`

### Sources
- [Claude Code Version History](https://www.havoptic.com/tools/claude-code)
- [Web search results](https://releasebot.io/updates/anthropic/claude-code)

---

## 8. Remote Control / Claude Code on the Web

### What It Is

Remote Control connects a local Claude Code session (running on your machine) to:
- **claude.ai/code** (web)
- **Claude mobile app** (iOS/Android)

**Key property**: Code execution and filesystem access stay on your machine; only the conversation and messages traverse the network.

### How It Works

1. Start local session with `claude --remote-control` or `--rc`
2. Session gets shareable URL / QR code
3. Browser/mobile app connects; messages sync bidirectionally
4. Subagents, tools, MCP servers available on local machine
5. Network drop: Auto-reconnect when machine comes online

### Encryption

**Unverified**: Documentation doesn't explicitly state E2EE status. Network uses HTTPS; credential handling via session tokens (not raw credentials shared).

### Invocation

```bash
# Terminal
claude --remote-control "My Project"

# Send follow-up from cli to existing RC session
claude --cloud "session_..." -p "next step"

# Resume RC session locally
claude --teleport
```

### Limitations

- No RC from Bedrock/Vertex/Foundry (cloud provider auth)
- Requires valid session token (expires after inactivity)

### Sources
- [Remote Control Documentation](https://code.claude.com/docs/en/remote-control.md)

---

## 9. Unverified / Not Found in Official Docs

1. **OpenTelemetry Export**: No environment variables, metrics endpoints, or instrumentation documented in Claude Code docs (as of Oct 2, 2026). May exist but not officially supported.

2. **Auto-Compaction Thresholds**: `/compact` command exists; window tuning via `/autocompact` or `--autocompact` flag. Exact thresholds not specified in docs fetched.

3. **Compact Boundary Events** in streaming: May exist but not explicitly documented in message types.

4. **System Prompt Presets**: Option mentioned (`systemPrompt: string | object`) but preset names not listed.

5. **E2EE in Remote Control**: No explicit statement; assumed HTTPS-only.

6. **Channels Feature**: Listed in CLI (`--channels`, research preview) but minimal documentation fetched.

---

## Conclusion & ByteBureau Implications

### Critical Constraints

1. **No Subscription OAuth for Third-Party Apps** (ENFORCED)
   - Must use Claude Console API key (`sk-ant-api03-*`)
   - Usage-based billing (not subscription passthrough)
   - Cannot offer "login with Claude Pro" to end-users

2. **Agent SDK Requires Docker Credential Management**
   - Pass `ANTHROPIC_API_KEY` as secret, not in image
   - Store credentials in mounted volume or envvar
   - Use `--bare` for fast headless startup (~500ms)

3. **Permissions & Audit Trail**
   - Set `--permission-mode dontAsk` or `--permission-prompts none` for fully unattended runs
   - Use `--allowedTools` to pre-approve critical operations
   - Stream logs via `--output-format stream-json` for observability

### Architecture Recommendations

1. **Main Orchestrator**: Claude Opus 5.5 or Sonnet 5.5 with 1M context
2. **Subagents**: Sonnet 5.5 (balanced) or Haiku 4.5 (cost)
3. **Authentication**: API key in secure env/vault, not in code
4. **Remote Control**: Use for interactive debugging; disable for production
5. **Plugins**: Custom skills for domain-specific workflows; evaluate with `claude plugin eval` before merging
6. **Cost Tracking**: Parse `--output-format json` output for billing records; set `--max-budget-usd` to prevent runaway costs
7. **Observability**: Stream logs to monitoring via JSON lines; `/skill-doctor` for periodic usage audits

### Known Gaps for Full Integration

- No official OpenTelemetry instrumentation
- No documented rate-limit windows (only headers on API requests)
- Remote Control encryption details unclear (assume HTTPS + session token)
- Channels feature underdocumented (research preview)

---

## Document Metadata

**Sources Referenced**:
- [Claude Code Docs Index](https://code.claude.com/docs/en/claude_code_docs_map.md)
- [Claude API Docs Index](https://platform.claude.com/llms.txt)
- [Claude Code Authentication](https://code.claude.com/docs/en/authentication.md)
- [CLI Reference](https://code.claude.com/docs/en/cli-reference.md)
- [Agent SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Skills Guide](https://code.claude.com/docs/en/skills.md)
- [Subagents](https://code.claude.com/docs/en/sub-agents.md)
- [Plugin Evals](https://code.claude.com/docs/en/plugin-evals.md)
- [Remote Control](https://code.claude.com/docs/en/remote-control.md)
- [Support: Use Claude Agent SDK](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [OAuth Policy: GIGAZINE (Feb 2026)](https://gigazine.net/gsc_news/en/20260220-anthropic-third-party-block/)
- [OAuth Restrictions: WinBuzzer (Feb 2026)](https://www.winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/)
- [Claude Model Lineup](https://agentskit.co/blog/claude-models)
- [Plugin Eval Release](https://www.marktechpost.com/2026/09/11/anthropic-adds-plugin-evals-to-claude-code-6-grader-types-a-no-plugin-baseline-and-a-ci-gate-for-skills/)
- [@anthropic-ai/claude-agent-sdk npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)

**Compiled**: October 2, 2026  
**Claude Code Version at Research Time**: v2.1.286 (Sept 30, 2026)  
**Model Used for This Report**: Claude Haiku 4.5
