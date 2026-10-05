---
title: Agents and profiles
description: The agent providers, the auth profiles they run under, where API keys are kept, how asks reach you and what each adapter reports.
---

An employee works through an agent provider, which a plugin brings. ByteBureau bundles three plugins that offer providers: the fake agent of the kernel, Claude Code through the Claude Agent SDK, and any agent that speaks the Agent Client Protocol (ACP) v1. A provider runs under an auth profile: a login of its own, in a directory ByteBureau keeps for it, or an API key, kept in the secret store. The home is `~/.bytebureau` unless `BYTEBUREAU_HOME` names another directory; the paths below assume the default.

## Providers

`bytebureau run "<prompt>" --provider <id>` picks the provider of one run; without the flag the employee's `provider` in `bytebureau.json` decides. `bytebureau plugins ls` lists the plugins the daemon loaded, and `GET /api/v1/providers` the providers they offer.

| Provider | Agent | What it needs | API-key variable |
| --- | --- | --- | --- |
| `fake` | the scripted agent of the kernel, for tests and smoke runs | nothing | `BYTEBUREAU_FAKE_API_KEY` |
| `claude` | Claude Code through `@anthropic-ai/claude-agent-sdk` | `claude` on the daemon's `PATH`, or where `providers.claude.executable` says; a login with `claude /login` | `ANTHROPIC_API_KEY` |
| `acp:codex` | Codex through `codex-acp` | `npm install -g @agentclientprotocol/codex-acp`; a login with `codex login` | `OPENAI_API_KEY` |
| `acp:gemini` | Gemini CLI, run as `gemini --acp` | `npm install -g @google/gemini-cli`; a login by running `gemini` once | `GEMINI_API_KEY` |
| `acp:opencode` | OpenCode, run as `opencode acp` | `npm install -g opencode-ai`; a login with `opencode auth login` | none |
| `acp:pi` | pi through `pi-acp` | `npm install -g pi-acp @earendil-works/pi-coding-agent`; pi asks for the login of its model provider on its first run | none |
| `acp:custom` | any ACP v1 agent | the command `providers["acp:custom"].command` names | none |

The Claude adapter runs your own `claude`, unmodified: the one `providers.claude.executable` names when it is found, else `claude` on the daemon's `PATH`. A configured one that is not found is logged as a warning and the default one runs. Run from source, ByteBureau falls back to the Claude Code bundled with the SDK when no `claude` is installed at all; the compiled `bytebureau` binary cannot reach that one, so with the binary `claude` must be installed. The employee's `model`, `effort`, system prompt, tools and `maxTurns` reach Claude Code, a resumed session continues the Claude session it had, and `settingSources` is always given: `["user", "project", "local"]` unless configured.

An ACP agent is started by the adapter itself, in the session's worktree, with the environment the kernel allows, and it speaks ACP over its stdin and stdout. The adapter serves the agent's file-system requests inside the worktree only (a path that leaves it, through `..` or a symbolic link, is refused) and its terminal requests in the worktree, without the API-key variables or any variable whose name ends in `_API_KEY` or `_TOKEN`. A resumed session loads the agent's session again where the agent offers `session/load`, else it starts a new one. An agent that is not installed refuses the run with exit 4 and a line that says how to install it and how to log in (for a login profile, the login command carries the profile's directory). Through the daemon the line reads `codex-acp is not installed; install it with: npm install -g @agentclientprotocol/codex-acp; then log in with: codex login (provider_crash)`; with `--no-daemon` such a line reads `ProviderError: … (crash)`. A provider section the adapter cannot use, such as an unknown key, a malformed entry or `acp:custom` without its command, is a configuration error of the project, told against its file and never retried: `acp:custom` without its command gives `<repository>/bytebureau.json: providers["acp:custom"].command is not configured (config_invalid)`, and with `--no-daemon` `ConfigError: <repository>/bytebureau.json: …`; `run` exits 4 for it too.

### Provider options

The project file configures a provider under `providers`, keyed by the provider id:

```json
{
  "providers": {
    "claude": { "executable": "claude", "settingSources": ["user", "project", "local"] },
    "acp:codex": { "command": "/opt/codex/bin/codex-acp" },
    "acp:custom": { "command": "my-agent", "args": ["--acp"], "env": { "MY_AGENT_MODE": "editor" } }
  }
}
```

| Key | Provider | What it does |
| --- | --- | --- |
| `executable` | `claude` | the Claude Code to run, a name on `PATH` or a path; `claude` by default |
| `settingSources` | `claude` | which Claude Code settings apply, any of `user`, `project` and `local`; all three by default |
| `command`, `args` | `acp:*` | the agent to start and its arguments; `providers["acp:custom"]` is the custom agent itself and needs `command`, the section of a built-in preset overrides it |
| `env` | `acp:*` | variables added to the agent's environment |
| `configDirEnv` | `acp:*` | the variable that hands a login profile's directory to the agent; `CODEX_HOME` for `acp:codex`, none for the others |
| `apiKeyEnv` | `acp:codex`, `acp:gemini` | another variable to hand the key of an API-key profile in |
| `installHint`, `loginHint` | `acp:*` | what to tell when the agent is not installed or asks for a login |
| `passEnv` | every provider | names of further variables of the daemon's environment that the provider's agents get |

A session reads its provider's section when its agent starts, and again at every resume, so a change to the project file applies from the next start. An unknown key, or a value of the wrong type, refuses the start, naming the section.

### Trust

A project's own files, `bytebureau.json` and `bytebureau.local.json`, can name commands to run: `command`, `args` and `env` of a provider section and `executable` of `providers.claude`. A repository you clone could name any program there and make it the provider of its default employee, so ByteBureau runs such a command only when the user configuration, `~/.bytebureau/config.json`, trusts the project or that exact command:

```json
{
  "trust": {
    "projects": ["/Users/me/code/my-app"],
    "commands": ["bun", "/opt/codex/bin/codex-acp"]
  }
}
```

- `trust.projects` lists projects by their absolute path; a link to the project or a trailing slash still names it. What a trusted project configures is used as it stands.
- `trust.commands` lists commands by the exact name or path the project writes in `command` or `executable`; a trusted command runs with the project's `args` and `env` too.

Otherwise the kernel takes those keys out of the provider's section before the adapter sees it, and the daemon logs a warning that names the keys and the way to trust them, at every start of the session's agent. The custom agent is then left without a command and the run is refused with exit 4: `<repository>/bytebureau.json: providers["acp:custom"].command is not configured; the project names a command the user configuration does not trust: add it to trust.commands, or the project to trust.projects, in ~/.bytebureau/config.json (config_invalid)`. A built-in preset runs its own command instead of the project's, and Claude runs the `claude` on `PATH`. A value the defaults hold already, such as `"executable": "claude"`, needs no trust. Claude Code's project settings can run commands as well, through the hooks of a repository's `.claude/settings.json`, so in a project the user does not trust Claude Code loads the user's settings alone, `settingSources: ["user"]`, without the project's `.claude` settings, its hooks and its `CLAUDE.md`, and the daemon logs a warning saying so; add the project to `trust.projects` to load them. The user configuration is read again at every start of an agent, so a change to `trust` needs no restart of the daemon.

## Profiles

A profile is a login of one provider, or one API key for it. Its id is `<provider>/<name>`, such as `claude/work` or `acp:codex/home`; the name is lower-case letters, digits and dashes, at most 32 characters, starting with a letter or a digit. Profiles are kept in the store of the home, and `bytebureau profiles` and the `profiles` group of the [API](../daemon-and-api/) manage them; the `profiles` section of the user configuration is reserved and not read.

| Command | What it does |
| --- | --- |
| `profiles ls` | the profiles of every provider: id, provider, kind, the default marker and the login directory |
| `profiles add <provider> <name> [--default]` | adds a login profile with its directory, then checks its login |
| `profiles add <provider> <name> --api-key [--default]` | adds an API-key profile; the key is read from the terminal or stdin |
| `profiles use <id>` | makes the profile the default of its provider |
| `profiles status [<id>]` | checks the login of one profile, or of every profile |
| `profiles rm <id> [--purge]` | removes the profile and its key; `--purge` removes its login directory as well |

### Login profiles

A login profile owns the directory `~/.bytebureau/profiles/<provider>/<name>`, with the colon of an ACP provider id written as a dash (`profiles/acp-codex/home`), made for the user alone (0700). ByteBureau never logs in for you and never copies a login: the agent's own login runs in that directory. Once the profile is added, the CLI checks its status, and a profile that is logged out is told the command that logs it in:

```text
$ bytebureau profiles add claude work
Profile claude/work added. Log in with: CLAUDE_CONFIG_DIR=/Users/me/.bytebureau/profiles/claude/work claude /login
```

At a terminal, without `--yes` and `--json`, the command then waits until you say you have logged in and checks again; any other status is printed as its row. The directory reaches the agent in `CLAUDE_CONFIG_DIR` for Claude Code and in `CODEX_HOME` for Codex, and the login command of a profile carries it, so that the login lands where the agent will look. An ACP agent has no status to ask, so a Codex profile is `unknown` and the CLI prints its status row, whose hint is that command (or the install command, while `codex-acp` is not on the daemon's `PATH`):

```text
$ bytebureau profiles add acp:codex home
Profile acp:codex/home added
acp:codex/home  unknown  -  CODEX_HOME=/Users/me/.bytebureau/profiles/acp-codex/home codex login
```

Run that command, then run under the profile:

```bash
bytebureau run "Create src/hello.ts exporting hello()" --provider acp:codex --profile acp:codex/home
```

`--profile` names a profile of the run's provider, the employee's or the one `--provider` names, so the two must match: a profile of another provider refuses the run with exit 4. As the first profile of `acp:codex`, `acp:codex/home` is also the default that a run of `acp:codex` without `--profile` takes from then on. The other ACP presets name no directory variable, so a login profile of theirs runs on the agent's own login unless `configDirEnv` names one.

### API-key profiles

`--api-key` takes no value. At a terminal the key is asked for with a hidden prompt, drawn on stderr so that `--json` output stays as it is; otherwise the first line of stdin is the key:

```bash
bytebureau profiles add claude ci --api-key < anthropic.key
```

The key is never an argument, which the shell's history and the process list keep: a key typed after the name is refused, and so is an empty one, both with exit 1 before anything is sent. Only `claude`, `acp:codex` and `acp:gemini` (and `fake`) take an API-key profile, as `supportsApiKey` of `GET /api/v1/providers` says; for another provider it is refused. The key is stored in the secret store as `@bytebureau/profiles/<id>/api_key` and leaves it only into the environment of the agent, under the provider's variable (moved to the one `apiKeyEnv` names, if it does). It never appears in an event, a log, a problem, `--json` output or `profiles ls`.

### The profile of a session

The first profile of a provider becomes its default; `--default` or `profiles use <id>` moves the default, and removing the default profile passes it to the oldest one left. `bytebureau run --profile <id>` runs under the profile named; without the flag a run takes the provider's default, and without a default the nameless login: no profile at all, so Claude Code uses its own configuration directory (`~/.claude`; the daemon's `CLAUDE_CONFIG_DIR` is not passed on unless `passEnv` names it) and an ACP agent its own login. A session keeps the profile it was created with for its whole life, across stops and resumes: one created on the nameless login stays there even once its provider has a default. A run under a profile the kernel does not know, a profile of another provider, or an API-key profile whose key is gone, is refused with exit 4. `bytebureau sessions show <id>` tells the profile of a session, `-` for the nameless login.

### Status

`profiles status` answers `loggedIn` (with the account, where the agent names one), `loggedOut` (with the command that logs in), `expired` or `unknown` (with what is known). Without an id it checks every profile, two at a time, as a check may start the provider's own agent:

- A Claude login profile is checked by a query that asks Claude Code for its account and sends no prompt, given 20 seconds. An API-key profile of Claude is `unknown`, with the hint to run a session to check it.
- ACP v1 has no status query. An agent whose command is not on the daemon's `PATH` is `unknown` with its install command (nothing is started to find out), a login profile whose directory is gone is `loggedOut`, and any other is `unknown` with the agent's login command. The check looks for the preset's built-in command, never for a `providers["acp:<preset>"].command` of a project, and the command of `acp:custom` is not checked at all, as a status check knows no project.
- An API-key profile whose key is no longer in the secret store is `loggedOut` with `remove the profile and add it again`, and a login profile whose directory is gone is `loggedOut` with the login command.

### Removing a profile

`profiles rm <id>` is refused while a session that runs or can still resume refers to the profile, which is every session but a completed one: `profile "claude/work" is in use: 1 session(s) still run under it or can resume; complete or remove them first`. `bytebureau sessions complete <id>` completes a ready, stopped or errored session, an end on the books that starts no agent, and then the profile can go. Its key goes with it, while the login directory stays unless `--purge` is given.

### Output and exit codes

With `--json` each command prints one record: `{"command":"profiles.ls","profiles":[…]}`, `{"command":"profiles.add","profile":{…}}`, followed for a login profile by `{"command":"profiles.status","statuses":[…]}`, `{"command":"profiles.rm","id":"…","purged":false}`, `{"command":"profiles.use","id":"…"}` and `{"command":"profiles.status","statuses":[…]}`. A profile is `{ id, providerId, name, kind, configDir, isDefault, createdAt }`, a status `{ profileId, state, hint?, account?, checkedAt }`. A refused profile command (an unknown profile or provider, a name taken or malformed, a profile in use, a key missing or given as an argument) ends with exit 1 and the reason on stderr; `run` under a profile it cannot use ends with exit 4. The event log records `profile.added`, `profile.removed` and `profile.status`, each with the `profileId`.

## Secrets

`secrets.backend` in `~/.bytebureau/config.json` says where the daemon keeps API keys:

| Value | Where the keys are |
| --- | --- |
| `auto` (the default) | in the keychain where it answers at the first start of the home, else in the file; the choice is kept |
| `keychain` | in the keychain of the system through `Bun.secrets` (the macOS Keychain, libsecret on Linux, the Windows Credential Manager), under the service `bytebureau`; a daemon that cannot reach it does not start, and says why |
| `file` | in `~/.bytebureau/secrets.json`, for the user alone (0600), replaced as a whole on every change |

With `auto`, the first start of a home probes the keychain by writing, reading and deleting one entry (`probe`, under the service `bytebureau`), within three seconds; where the probe fails, the keys go to the file and a warning says why. The choice is recorded in `~/.bytebureau/secrets.backend` and kept: a home on the file stays on the file even once the keychain answers, and a home on the keychain whose keychain does not answer warns that the stored keys are out of reach and keeps new ones in the file until it answers again. Removing the file `~/.bytebureau/secrets.backend` lets `auto` choose again; keys already stored are not moved, so add their profiles again. `keychain` and `file` ignore the record, and any other value refuses the start, naming `/secrets/backend`, as a user configuration that cannot be read or parsed does, naming the file, so that a broken comma never moves the keys to a backend the file does not name. `bytebureau doctor`, in phase D, will show the backend; until then a daemon started with `--debug` logs it, as in `secrets backend: keychain (auto: the keychain answered)`.

On macOS a keychain item can be read without asking only by the binary that stored it: a key stored by one build of `bytebureau`, or by `bun` running ByteBureau from source, makes macOS show a Keychain dialog when another binary reads it, a new release of `bytebureau` included. Every call the daemon makes to the keychain therefore waits at most ten seconds; one that is not answered in time fails with `the keychain did not answer within 10 s — a Keychain dialog may be waiting for approval, or set secrets.backend to file`, so a session start or a `profiles` command ends with that line instead of waiting for ever on a dialog nobody sees. Choose Always Allow in the dialog to let the new binary read the key from then on, or keep the keys in the file with `secrets.backend: file`, after which the keys in the keychain are out of reach and their profiles must be added again.

## Permissions and questions

The `permissionMode` of an employee decides what its agent may do without asking:

- `supervised`, the mode of the default employee: the agent asks for what its own permission rules do not allow already, and every ask waits for a person, however long. Claude Code runs with the SDK's `permissionMode: 'default'`, given explicitly, and its permission prompts reach ByteBureau through `canUseTool`; an ACP agent sends `session/request_permission`.
- `autonomous`: Claude Code runs in the SDK's `auto` mode, whose classifier decides and asks only when unsure; ACP v1 has no mode to pass, so an ACP agent asks as it is configured to. A permission ask is denied once the employee's `askTimeout` (30 minutes by default) passes, and a question takes its recommended option then, or waits for a person when it has none.
- `yolo` is refused: the local worktree runtime has no isolation.

A permission is one question with Allow and Deny, and the kernel recommends one by its policy rules or neither: Allow for a simple read-only command or a file tool that works inside the worktree, Deny for a force push, a removal outside the worktree, a path that holds secrets or a network tool of a supervised employee. The answer goes back to Claude as allow or deny, and to an ACP agent as its own option of that kind (`allow_once` or `allow_always`, `reject_once` or `reject_always`), never chosen by the option's name, and an answer with `remember: "always"` picks `allow_always` where the agent offers it.

A question comes from Claude's `AskUserQuestion` tool, with up to four questions of two to four options each. ByteBureau tells Claude to put the option it recommends first, end its label with `(Recommended)` and give one line of evidence in its description; the marker becomes the option's `recommended` flag and is left out of its label and its id, which is the plain label (`bytebureau ask answer <id> --option Named`), and the ask counts as recommended by the agent only when every question has exactly one such option. Each question also offers an answer of your own; given with `--other`, it answers the first question of the ask. ACP v1 agents ask permissions only, never questions.

At a terminal the CLI asks with a select whose cursor starts on the recommended option. `--yes` asks nothing: it answers every ask that has a recommendation with that option and leaves any other waiting, as a run off a terminal leaves every ask. The run says on stderr that it waits, and `bytebureau ask ls` and `bytebureau ask answer <id>` answer the ask from another terminal.

## What the adapters report

| | Claude | ACP agents |
| --- | --- | --- |
| Text and thinking | streamed deltas and the completed message | the agent's message and thought chunks |
| Tools | each tool call, with its output or its failure, cut at 32,768 characters | the same |
| Usage of a turn | input, output and cache tokens and the cost in USD | zero, unless the agent sends `_meta["bytebureau.usage"]` |
| Context | the share of the context in use (`contextPct`) after every turn, when Claude Code tells it within five seconds | none |
| Rate limits | `ratelimit.updated` with the five-hour and seven-day utilisation and when they reset | none, unless the agent sends `_meta["bytebureau.rateLimit"]` |
| Compaction | `compaction.completed` | none |
| API retries | `session.warning` of kind `api_retry` | none |
| Plans | none | `session.warning` of kind `plan` |
| Subagents | `subagent.started` and `subagent.stopped` | none |

ACP v1 carries no usage, model, effort or system prompt: an ACP agent runs on the model it is configured with, and a turn of one reports zero tokens unless the agent sends the extension above. A Claude login that lapses ends the session with `session.errored` of kind `auth`; log in again and resume it with `bytebureau sessions resume <id>`.

## Limits in this phase

- `acp:custom`, `acp:opencode` and `acp:pi` take no API-key profiles: the custom agent's variable is known only from a project's configuration, and the presets of the other two name no API-key variable.
- ACP v1 has no status query, so `profiles status` cannot tell whether an installed ACP agent is logged in; a prompt the agent refuses for its login ends the turn with a warning that names the login command.
- There is no encrypted fallback: where the keychain is not available, the keys are in a 0600 file under the home, which anything running as the user can read. An age-encrypted file with a passphrase comes later.
- Restarts: Claude Code that fails, or an ACP agent that dies in the middle of a turn, ends the turn and errors the session (`session.errored` of kind `crash`, retryable), which `bytebureau sessions resume <id>` resumes. An ACP agent that dies between turns is started again for the next prompt, in a new ACP session and with a `session.warning` of kind `restart`, at most three times a session; the fourth such death errors the session. There is no backoff and no restart within a turn.
- A usage limit of Claude that extra usage does not cover errors the session (`session.errored` of kind `ratelimit`) instead of pausing it until the limit resets; resume it once the limit has reset.
- The first turn of a resumed Claude session reports its tokens but no cost.
- The messages of Claude's subagents are not shown, only their start and stop; an ask that Claude takes back stays pending in ByteBureau, and answering it has no effect. Both come in phase D.
- `AskUserQuestion` is read in the shape the SDK declares, which has not yet been checked against a live Claude Code.
- `profiles status` checks a Claude profile with the `claude` on the daemon's `PATH`, not the `providers.claude.executable` of a project.
- On Windows an ACP agent is signalled alone rather than with its process group, so a process it started may outlive it.
- The ACP SDK writes a message of the agent that it cannot parse to the daemon's stderr as it came, without redaction: a detached daemon keeps it in `~/.bytebureau/logs/daemon.log`.
