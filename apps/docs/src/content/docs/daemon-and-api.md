---
title: Daemon and API
description: The local daemon, its HTTP API, the event stream over SSE, RPC over WebSocket and the client package.
---

The kernel of ByteBureau runs in a daemon, one per home, and every client talks to it: the CLI today, the web UI, the desktop shell and the phone later. The daemon serves an HTTP API under `/api/v1` that an OpenAPI 3.1 document describes, the event log as server-sent events, and `effect/rpc` over a WebSocket ([ADR-0013](../decisions/0013-api-transports/)). `packages/api` implements the three over the services of the kernel, and `packages/client` is how a TypeScript program speaks them.

The home is `~/.bytebureau` unless `BYTEBUREAU_HOME` names another directory; the paths below assume the default.

## The daemon

`bytebureau serve` starts the daemon detached and returns once it answers, printing the URL it listens on; with `--json` it prints one record, `{"command":"serve","url":…,"pid":…,"version":…}`, and never the token. When a daemon already serves the home, `serve` names it instead of starting another.

| Flag | What it does |
| --- | --- |
| `--host <address>` | listen on that address; without the flag, `server.host` of `~/.bytebureau/config.json`, else `127.0.0.1` |
| `--port <port>` | listen on that port; without the flag, `server.port`, else `4747`; `0` picks a free one |
| `--no-daemonize` | stay in the foreground, logging to the terminal, until SIGINT, SIGTERM or SIGHUP |
| `--stop` | stop the daemon of the home, or clear a lock that no daemon of the home holds |

The detached daemon is the same binary run again as `serve --no-daemonize`, in a process group of its own, and its output goes to `~/.bytebureau/logs/daemon.log`; when the next daemon starts, that log becomes `daemon.log.1`, so the logs keep two runs at most. `serve` waits up to 30 seconds for the daemon to answer. A daemon that ends before it answers fails the start at once with `The daemon failed to start; see <log>`, and one that does not answer in time with `The daemon did not come up in time; see <log>`; both exit 1.

While the daemon runs, `~/.bytebureau/server.json` tells clients where it is:

```json
{
  "version": "0.1.0",
  "host": "127.0.0.1",
  "port": 4747,
  "pid": 68038,
  "token": "<64 hexadecimal characters>",
  "startedAt": "2026-10-04T13:41:07.968Z"
}
```

`version` is the version of the binary, `host` and `port` the address clients use, `pid` the process of the daemon, `token` the bearer token of the API and `startedAt` the moment the daemon started. The file is for the user alone (mode 0600), and so are the two beside it: `daemon.lock`, which holds the pid of the daemon that serves the home, and `daemon.token`. The token is 32 random bytes, made at the first start of the home and kept in `daemon.token`, so a restart keeps it and a client that has read it goes on working; `server.json` carries a copy and goes away with the daemon. A client trusts the record only when the daemon at that address answers its health check with the same `startedAt`, so a record that a crash left behind is never taken for a daemon.

One daemon serves a home. `daemon.lock` decides it atomically: a second `serve --no-daemonize` on the same home exits 1 naming the pid of the first. The holder of the lock is the daemon of the home while its health answers as `server.json` says, or while it may still be coming up: its record appears within two seconds, or the lock of this live process of the user is less than 30 seconds old. Otherwise its start decides, which `ps` tells on macOS and Linux and PowerShell on Windows, at best. The lock of a process that has ended is taken over, and so is that of a process that started more than five seconds after the lock was written: it only got the pid of the writer, after a crash or a reboot. One that started before, or within those five seconds, which a stepped clock or the file times of a network share may account for, is the daemon that wrote the lock, stopped (Ctrl-Z, a debugger) or busy; it keeps the lock, and a start fails with `A daemon of this home (pid <pid>) holds the lock but does not answer; it may be stopped or busy, and if it is not a daemon of this home, delete <lock>`. Where the start of a process cannot be told, the lock of a process of the user that does not answer is taken over, and that of a live process of another user, which the user cannot look into, makes a start fail with a line that names the pid and the lock and says to clear the lock with `bytebureau serve --stop` if no daemon runs. One start at a time judges and takes the lock, under `daemon.lock.takeover`, and a start clears what a takeover that died halfway left behind. A daemon whose port is taken does not start; it says so in one line, `cannot listen on 127.0.0.1:4747: the port is taken or the address is not this machine's`, in the terminal with `--no-daemonize` and in `daemon.log` otherwise. Two homes on one machine therefore need two ports, through `--port` or `server.port`.

`--host 0.0.0.0` (or `::`) listens on every interface. `server.json` then records the loopback address of that family, `127.0.0.1` or `::1`, as `host`, which clients on the machine use, and the address the daemon is bound to as `bind`. The command that starts the daemon, `serve` or one that starts it on demand, warns that anyone on the network with the token can use it, whether the address comes from `--host` or from `server.host`, as it does for every address that is not a loopback one; `localhost`, `127.0.0.0/8` and `::1` are loopback in any spelling, the IPv4-mapped `::ffff:127.0.0.1` included.

`bytebureau serve --stop` sends SIGTERM to the daemon of the home, waits up to five seconds for it to end, removes `server.json` and prints `Stopped daemon (pid <pid>)`; a daemon still coming up gets five seconds to answer first. With no daemon running it prints `No daemon is running`, and when `daemon.lock` names a live process that is no daemon of the home, it clears the lock and prints `Cleared the stale lock of pid <pid>, which is not a daemon of this home`. All three exit 0. A daemon that does not end in time is left alone with its record, `Daemon (pid <pid>) did not stop in time`, and one that holds the lock without answering, stopped, busy or not up after those five seconds, is neither signalled nor cleared: `--stop` prints the line of a daemon that does not answer, the one a start prints once the lock is past the 30 seconds a daemon is given to come up. Within them, a start takes the holder for a daemon on its way up: `serve --no-daemonize` says a daemon is already running, and a detached start waits for it. Both stops exit 1. On SIGTERM, SIGINT or SIGHUP the daemon stops serving (an open event stream gets two seconds), closes the agents of its sessions and the store, and removes `server.json` and `daemon.lock`.

### Sessions across a restart

A daemon that stops or crashes leaves its sessions as they were. The next kernel that opens the home, the next daemon or a `--no-daemon` command, recovers every session left in a status of work (`created`, `provisioning`, `running`, `waiting_for_human`, `paused_usage_limit`) by a process that is gone: the turn ends `interrupted` with the reason `daemon_restart`, the pending asks are cancelled, the worktree is unlocked and the session is `stopped`, resumable with `bytebureau sessions resume <id>`. A `ready` session stays `ready`. A session the recovery cannot settle is tried again at every start and told once: a warning in the log, and a `session.warning` of kind `recovery_failed` on the session; later starts log it at debug level only.

A `run` that follows its session through a daemon that goes away keeps reconnecting for 15 seconds. When a daemon answers at the same address in time, the run sees the recovery and ends with exit 3; otherwise it ends with exit 2 and `cannot reach the daemon at <url>`.

## Talking to it

`run`, `sessions`, `ask`, `projects`, `workspaces`, `plugins`, `profiles` and `bytebureau` on its own talk to the daemon of the home. They read its address and token from `server.json` and send the token as `Authorization: Bearer <token>`. When no daemon answers, the command starts one as `serve` would and goes on; the daemon keeps running afterwards, until `bytebureau serve --stop`. A daemon that does not come up ends the command with exit 2 and the line `serve` would print, at once when the daemon ends before it answers and after 30 seconds otherwise. `hello` and `config` never start one, and `config` reads the configuration of the home without opening its store, so it runs beside a daemon.

A daemon started on demand gets the environment of the command without the `BYTEBUREAU_*` variables that choose for one run: of those, only `BYTEBUREAU_HOME`, `BYTEBUREAU_LOG_LEVEL` and `BYTEBUREAU_WORKSPACE_RUNTIME` stay, so the choices of one run never become the defaults of every later one. The `BYTEBUREAU_*` variables of `run` travel with its session instead: `BYTEBUREAU_EMPLOYEE` and `BYTEBUREAU_BRANCH` choose the employee and the base branch where the flags choose nothing, and the agent gets them at the start and at every resume, all but the three that are the daemon's own: those it gets from the daemon, and the kernel drops them from the `env` of any session, so no client of the API can point an agent at another home.

`bytebureau` with no command prints the status: the daemon with its URL, pid and start time, the projects, the sessions running, waiting for you and in all, and the pending asks. With `--json` it prints one record, `{"command":"status",…}`.

These global flags choose another way:

| Flag | What it does |
| --- | --- |
| `--host <address>`, `--port <port>` | talk to the daemon at that address (`127.0.0.1` or `4747` for the one not given); it is never started, and when it does not answer the command exits 2 with `cannot reach the daemon at <url>` |
| `--token-file <file>` | read the token of that daemon from the file; it goes with `--host` or `--port`. Without it, the token of this home goes only to the daemon its `server.json` names, and a command that names another address is refused with exit 1 before it sends anything |
| `--no-daemon` | run the kernel inside the command, for one-shot headless use such as CI; refused with exit 1 while a daemon answers on the same home, as the store has one writer |

Like every global flag, they may stand before or after any command name: `bytebureau --port 4848 sessions ls` and `bytebureau sessions ls --port 4848` are the same command. When a switch is given both ways, its `--no-` form wins whatever the order: `--no-daemon --daemon` runs without the daemon, as `--daemon --no-daemon` does. For `serve` itself, `--host` and `--port` are the address to listen on, and it refuses `--no-daemon` and `--token-file` with exit 1, as `hello` and `config`, which talk to no daemon, refuse all four. A group named without its command (`bytebureau projects`), a name that is no command and a command name after `--` are refused with exit 1 as well.

Every one of these commands but `run` ends a refused request with exit 1 and one line on stderr: a `4xx` problem of the daemon with its detail, the refusal of the kernel in-process, or what the command finds itself (a session or an ask that is not there, an ask without an answer to give). A `401` of a daemon that `--host` or `--port` named adds a hint to pass its token with `--token-file`, and so does the line of `run`, which ends such a refusal with exit 2. A usage error, a refused `--no-daemon` and a cancelled interactive answer exit 1 as well, and any other failure exits 2, a failure of git or of the file system in a workspace among them. `run` exits 0 when the session completes, 3 when it is stopped or interrupted, 4 when the project, its worktree, the provider or the profile cannot be used or the session errors, 2 for any other failure (an invalid configuration, a failure of the store, a daemon that cannot be reached) and 1 for a usage error or a refused `--no-daemon`. A request refused for an unknown employee or an invalid configuration is such a failure for `run` and exits 2, through the daemon and with `--no-daemon` alike. `run --profile <id>` runs under a profile of the provider ([Agents and profiles](../agents-and-profiles/)): one the kernel does not know or cannot use is a refusal of the run, exit 4, and so is an agent that is not installed or not configured, whose line ends with `(provider_crash)`. `sessions prompt` follows the turn it starts as `run` follows its session and ends the same way: 0 when the turn completes, 3 when it is interrupted or the session is stopped, 4 when the session errors; a refused request still exits 1.

## The API

Every path starts with `/api/v1` and every body is JSON. Every operation needs the bearer token except two: `GET /api/v1/health`, which a client asks before it has read the token, and `GET /api/v1/openapi.json`, the OpenAPI 3.1 document of the API. A request without a valid token gets `401 unauthorized`, with `WWW-Authenticate: Bearer realm="bytebureau"`. The paths below leave out `/api/v1`, and every `POST` and `DELETE` is a mutation, which counts against the rate limit.

| Endpoint | Answer | Notes |
| --- | --- | --- |
| `GET /health` | `200 Health` | no token: `status` (`ok` or `degraded`), `version`, `startedAt` and `checks`, the store and the plugins loaded and failed; the integrity check of the store runs at most once in 30 seconds, however often the health is asked |
| `GET /openapi.json` | `200` | no token: the OpenAPI document |
| `GET /schemas/config.json` | `200` | the JSON Schema of the configuration files |
| `GET /schemas/events.json` | `200` | the JSON Schema of the events |
| `GET /projects` | `200 Project[]` | |
| `POST /projects` | `201 Project` | body `{ path }`, an absolute path; `422 project_path_not_absolute` for a relative one, which the daemon could only resolve in its own working directory, `422 workspace_not_a_repository`, `422 workspace_is_bytebureau_worktree` |
| `GET /projects/{id}` | `200 Project` | `404 not_found` |
| `DELETE /projects/{id}` | `204` | `404 not_found`, `409 workspace_has_sessions` |
| `GET /sessions` | `200 Session[]` | |
| `POST /sessions` | `201 Session` | body `{ projectId, title, employeeId?, providerId?, profileId?, branch?, env? }`; the session is provisioned (`ready`) when the answer comes; `profileId` names a profile of the provider, else its default profile or the nameless login is taken: `404 profile_not_found`, `422 profile_invalid` for a profile of another provider or one whose key is gone; `env` keeps `BYTEBUREAU_*` names only, but for `BYTEBUREAU_HOME`, `BYTEBUREAU_LOG_LEVEL` and `BYTEBUREAU_WORKSPACE_RUNTIME`, which are the daemon's own |
| `GET /sessions/{id}` | `200 Session` | `404 session_not_found` |
| `POST /sessions/{id}/prompt` | `200 Turn` | body `{ text, attachments? }`; `409 session_invalid_transition` unless the session is `ready` |
| `POST /sessions/{id}/interrupt` | `204` | interrupts the running turn, and the session is `ready` again once the agent has ended it; `409 session_invalid_transition` when no turn of the session is at work, `404 session_not_found` |
| `POST /sessions/{id}/stop` | `204` | |
| `POST /sessions/{id}/resume` | `200 Session` | a stopped or errored session |
| `POST /sessions/{id}/complete` | `204` | a ready, stopped or errored session, which ends for good and lets go of its profile; `409 session_invalid_transition` otherwise |
| `GET /asks?session={id}` | `200 Ask[]` | the pending asks, of one session when `session` is given |
| `GET /asks/{id}` | `200 Ask` | pending or settled; `404 ask_not_found` |
| `POST /asks/{id}/answer` | `204` | body `{ selected, otherText?, remember? }`, recorded as answered through `api`; `409 ask_not_pending`, `422 ask_invalid_answer` |
| `GET /profiles` | `200 Profile[]` | by provider, each provider's in the order they were added |
| `POST /profiles` | `201 Profile` | body `{ providerId, name, kind, apiKey?, makeDefault? }`, `kind` `login` or `api_key`; `apiKey` goes with `api_key` alone, into the secret store, and is never answered; `409 profile_exists`, `422 profile_invalid`, `422 session_provider_missing` for an unknown provider |
| `DELETE /profiles/{id}?purge=true` | `204` | removes the profile and its key, and with `purge=true` its login directory; `404 profile_not_found`, `409 profile_in_use` while a session that is not completed refers to it |
| `POST /profiles/{id}/default` | `204` | makes the profile the default of its provider; `404 profile_not_found` |
| `GET /profiles/{id}/status` | `200 ProfileStatus` | `state` (`loggedIn`, `loggedOut`, `expired` or `unknown`), `hint?`, `account?` and `checkedAt`; `404 profile_not_found` |
| `GET /usage/sessions/{id}` | `200 SessionUsage` | `404 session_not_found` |
| `GET /usage/profiles/{id}` | `200 UsageSnapshot` | the newest rate-limit snapshot of the profile, `{ profileId, rateLimit: {}, observedAt: null }` before there is one; `404 profile_not_found` |
| `GET /workspaces?project={id}` | `200 WorkspaceInfo[]` | the worktrees, of one project when `project` is given |
| `POST /workspaces/prune` | `200 PruneReport` | body `{ projectId? }`, `{}` for every project |
| `GET /plugins` | `200 PluginStatus[]` | |
| `GET /providers` | `200 Provider[]` | the agent providers the loaded plugins offer, each with `supportsApiKey`, whether it takes an API-key profile |
| `GET /events` | `200` | the event stream, see [Events over SSE](#events-over-sse) |
| `GET /ws` | `101` | the RPC socket, see [RPC over WebSocket](#rpc-over-websocket); the upgrade takes no token (`101`, or `403` for a foreign `Origin`), and every RPC request on the socket carries it |

### Problems

A refusal is an RFC 9457 problem, `application/problem+json`:

```json
{
  "type": "https://bytebureau.dev/problems/unauthorized",
  "title": "Unauthorized",
  "status": 401,
  "detail": "a valid API token is required",
  "code": "unauthorized"
}
```

The OpenAPI document has one problem schema for each status an endpoint declares (`Problem400`, `Problem401`, `Problem403`, `Problem404`, `Problem409`, `Problem413`, `Problem422`, `Problem429`, `Problem500`, `Problem502` and `Problem503`), each with its status as a literal, so a client knows which problem every status carries. The 413 of the body limit is answered before routing, and every mutation declares it. Text in a detail that looks like a secret is replaced with `[REDACTED]`. The codes, by status:

| Status | Codes |
| --- | --- |
| 400 | `request_invalid`: a body, query, path parameter or header that its schema refuses, named in the detail |
| 401 | `unauthorized` |
| 403 | `session_yolo_refused` |
| 404 | `not_found` (a project), `session_not_found`, `ask_not_found`, `profile_not_found`, `workspace_not_found` (a project removed while the request was on its way) |
| 409 | `session_invalid_transition`, `ask_not_pending`, `profile_exists`, `profile_in_use`, `workspace_locked`, `workspace_dirty`, `workspace_has_sessions` |
| 413 | `payload_too_large`, answered before routing |
| 422 | `config_invalid`, `project_path_not_absolute`, `session_provider_missing`, `session_employee_missing`, `ask_invalid_answer`, `profile_invalid`, `provider_missing`, `workspace_not_a_repository`, `workspace_is_bytebureau_worktree`, `workspace_git_too_old`, `workspace_runtime_missing` |
| 429 | `rate_limited` |
| 500 | `internal`, `plugin_failed`, `workspace_fs_failed` |
| 502 | `provider_auth`, `provider_ratelimit`, `provider_crash`, `provider_protocol`, `workspace_git_failed` |
| 503 | `store_unavailable` |

`PROBLEM_CODES` of `@bytebureau/protocol` lists the well-known codes; a failure of a workspace or a provider that the kernel names otherwise comes as `workspace_<code>` or `provider_<kind>`.

### Limits

- Mutations are rate limited per client address: 60 at once, flowing back at 60 a minute. A client past its budget gets `429 rate_limited`, whose detail says after how many seconds to retry, as the `Retry-After` header of a REST answer does. The REST mutations and the RPC procedures draw from the same budget, and the clients on this machine all call from the loopback, so they share one.
- A request body holds at most 10 MB: one that declares a larger length gets `413 payload_too_large` before any of it is read, and the server answers one sent without a length that runs past the limit with an empty `413`.
- Browsers get CORS only for configured origins, and the daemon configures none: the embedded UI of SP2 will come from the daemon itself, on its own origin.

## Events over SSE

`GET /api/v1/events` streams the event log: the durable events after `since` first, then every event as it happens. The query narrows it: `since` is the last `seq` the client has seen, a whole number of 0 or more in digits (without it the stream replays the whole log; above the head of the log it replays nothing, and the stream goes on with what comes next), `session` and `project` take an id, and `types` takes event types separated by commas. Each event is one frame:

```text
id: 3
event: project.registered
data: {"seq":3,"id":"01a10725-9d8f-7202-9580-26e16db4aedd","ts":"2026-10-04T13:41:08.111Z","type":"project.registered","projectId":"01a10725-9d8f-7202-9580-211c5f09f0c1","payload":{…}}
```

A durable event carries its `seq` as the `id`. An ephemeral one, a text delta or the progress of a tool, has `seq` 0 and no `id`, and is never replayed. A client that reconnects sends the last id it has seen as `Last-Event-ID`, which wins over `since`, and the stream goes on after it; a value that is not a whole number is ignored.

A turn that the agent ends is told once its session is `ready` again: `turn.completed` or `turn.interrupted`, then `session.ready`, so a client may send the next prompt as soon as it sees the end of the turn.

The heartbeat is an event of its own rather than a comment, so every frame decodes as an envelope:

```text
event: heartbeat
data: {"seq":0,"id":"01a10725-a3e0-735b-9870-b46ad2645cce","ts":"2026-10-04T13:41:09.728Z","type":"heartbeat","payload":{"at":"2026-10-04T13:41:09.728Z"}}
```

The first one leaves at once, so an idle client has the headers of the response straight away, and then one every 15 seconds.

A client that reads slowly does not hold the daemon up. Each connection has a buffer that keeps every durable event but only the latest 64 ephemeral ones, dropping the oldest first: a slow client may miss deltas and progress, never a durable event, and a client that loses its connection resumes from its last id. A client that falls more than 10,000 durable events behind is let go: its stream ends after the events that wait for it, and an SSE client resumes from its last id, which the log replays. The subscription of the RPC socket has the same buffer, and its stream ends as a stream the daemon ends: the client subscribes again with `since`, the last `seq` it has seen.

## RPC over WebSocket

`GET /api/v1/ws` upgrades to a WebSocket that speaks `effect/rpc` in JSON ([ADR-0013](../decisions/0013-api-transports/)). The procedures are those of `BureauRpcs` in `@bytebureau/protocol`. The stream `events.subscribe` takes a filter of `since`, `sessionId`, `projectId`, `types` and `ephemeral`; one procedure stands for each mutation of the REST API (`projects.register`, `projects.remove`, `sessions.create`, `sessions.prompt`, `sessions.interrupt`, `sessions.stop`, `sessions.resume`, `sessions.complete`, `asks.answer`, `workspaces.prune`, `profiles.add`, `profiles.remove` and `profiles.setDefault`); and three read the profiles: `profiles.list`, whose payload is `null`, `profiles.status` and `usage.profile`.

Each frame is one envelope. A client sends `Request`, `Ack`, `Interrupt` and `Ping`; the daemon sends `Chunk`, `Exit`, `Defect` and `Pong`. Every request carries the bearer token in its `headers`, never in the URL:

```json
{"_tag":"Request","id":"2","tag":"sessions.stop","payload":{"sessionId":"0199a1b2-0000-7000-8000-000000000000"},"headers":[["authorization","Bearer <token>"]]}
{"_tag":"Exit","requestId":"2","exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"type":"https://bytebureau.dev/problems/session_not_found","title":"Not Found","status":404,"detail":"session 0199a1b2-0000-7000-8000-000000000000 does not exist","code":"session_not_found"}}]}}
```

- A procedure ends with an `Exit`: `Success` with its `value`, or `Failure` whose cause holds the problem the REST API would answer with. A request without a valid token fails with `unauthorized`.
- A stream sends its values in `Chunk` frames, and the next chunk comes only once the client has acknowledged the last one with an `Ack`. An `Interrupt` ends a stream or a call, which then ends with its `Exit`.
- A payload that does not fit its schema, a tag that the daemon does not know, or a fault in a handler ends that request with an `Exit` whose cause is a `Die`; the socket and its other requests go on. A `Defect` reports a failure of the connection as a whole.
- Every `Request` carries a `headers` array, empty when there is nothing to send; the daemon closes the socket (1011) on a request without one.
- A `Ping` gets a `Pong`.

The upgrade checks the `Origin` a browser sends. A client without one (the CLI, Node, Bun) may open the socket, and so may a page of a configured origin, or the page of the daemon itself: a loopback name (`localhost`, `127.0.0.1`, `[::1]`) on the port the request came to. The name in the `Host` header is never trusted, since a page that rebinds its own name to the loopback sends that name too. Any other origin gets `403` before the socket opens. Every procedure but `events.subscribe` draws from the mutation budget of the address the socket was opened from.

## The client package

`@bytebureau/client` (MIT) is how a TypeScript program talks to the daemon. It has no Effect at runtime: the REST calls are generated from the OpenAPI document and run on `fetch`, the event stream is read with `eventsource-parser`, and the RPC envelopes are implemented in one module.

```ts
import { createBureauClient } from '@bytebureau/client'

// token: the "token" of ~/.bytebureau/server.json
const bureau = createBureauClient({ baseUrl: 'http://127.0.0.1:4747', token })
const [session] = await bureau.sessions.list()
if (session !== undefined) {
  for await (const event of bureau.events.subscribe({ sessionId: session.id, ephemeral: false })) {
    console.log(event.seq, event.type)
  }
}
```

- `createBureauClient({ baseUrl, token, fetch?, retryFor? })` gives `projects`, `sessions`, `asks`, `usage`, `workspaces`, `plugins`, `profiles` and `health` in the names of ByteBureau and the types of the protocol, plus `events.subscribe` and `rpc.connect`. Each client has a generated client of its own, so one process may talk to several daemons. A refusal is thrown as an `ApiError` with the `status` and the `problem`, a daemon that cannot be reached as an `ApiError` of status 0, and a `get` of an id that does not exist resolves to `undefined`.
- `subscribeEvents({ baseUrl, token, filter, signal?, retryFor? })`, behind `events.subscribe`, is an `AsyncIterable` of envelopes. After a lost connection it resumes with `Last-Event-ID`, half a second later at first and twice as long after each failed attempt, up to 30 seconds; it gives up with an `ApiError` of status 0 once reconnecting has failed for `retryFor` (30 seconds by default). A `2xx` answer that is not `text/event-stream`, such as the page of a proxy, counts as a failed attempt. A final `4xx` ends it with that problem, an aborted signal ends it quietly, and `ephemeral: false` leaves out the events of `seq` 0. Without `since`, or a `Last-Event-ID` to resume from, a subscription replays the whole log of the home before the live events, and the log grows with every session: pass the last `seq` the program has seen, or filter by `sessionId`.
- `connectRpc({ url, token, WebSocket?, pingMs? })`, behind `rpc.connect`, opens the socket with the global `WebSocket`, or the constructor given, and gives `call(tag, payload)`, `stream(tag, payload, signal?)` and `close()`. It sends the token with every request, acknowledges each chunk once its values are read, pings every 30 seconds, or every `pingMs`, until `close()` and throws a problem as an `ApiError`; an aborted signal interrupts its stream at once. A stream does not resume: one that ends, a subscription the daemon let go included, is started again with `since`.

The generated code lives in `packages/client/src/gen` and is committed. After a change to the API, `bun run --cwd packages/api build` writes `packages/api/openapi.json`, and `bun run generate:client` regenerates the client from it with hey-api, which runs in `tools/client-codegen` on TypeScript 6 because TypeScript 7 ships no compiler API. CI fails when either is out of date.
