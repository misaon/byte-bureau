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
| `--stop` | stop the daemon of the home |

The detached daemon is the same binary run again as `serve --no-daemonize`, in a process group of its own, and its output goes to `~/.bytebureau/logs/daemon.log`. When it does not answer within ten seconds, `serve` gives up, names that log and exits 1.

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

One daemon serves a home. `daemon.lock` decides it atomically: a second `serve --no-daemonize` on the same home exits 1 naming the pid of the first, and the lock of a daemon that is gone is taken over. A daemon whose port is taken does not start; it says so in one line, `cannot listen on 127.0.0.1:4747: the port is taken or the address is not this machine's`, in the terminal with `--no-daemonize` and in `daemon.log` otherwise. Two homes on one machine therefore need two ports, through `--port` or `server.port`.

`--host 0.0.0.0` (or `::`) listens on every interface. `server.json` then records the loopback address of that family, `127.0.0.1` or `::1`, which clients on the machine use, and `serve` warns that anyone on the network with the token can use the daemon, as it does for every address that is not a loopback one.

`bytebureau serve --stop` sends SIGTERM to the daemon of the home, waits up to five seconds for it to end, removes `server.json` and prints `Stopped daemon (pid <pid>)`; with no daemon running it prints `No daemon is running`. Both exit 0. A daemon that does not end in time, or a live pid that does not answer as its record says, is left alone with its record, and `--stop` exits 1. On SIGTERM, SIGINT or SIGHUP the daemon stops serving (an open event stream gets two seconds), closes the agents of its sessions and the store, and removes `server.json` and `daemon.lock`.

### Sessions across a restart

A daemon that stops or crashes leaves its sessions as they were. The next kernel that opens the home, the next daemon or a `--no-daemon` command, recovers every session left in a status of work (`created`, `provisioning`, `running`, `waiting_for_human`, `paused_usage_limit`) by a process that is gone: the turn ends `interrupted` with the reason `daemon_restart`, the pending asks are cancelled, the worktree is unlocked and the session is `stopped`, resumable with `bytebureau sessions resume <id>`. A `ready` session stays `ready`.

A `run` that follows its session through a daemon that goes away keeps reconnecting for 15 seconds. When a daemon answers at the same address in time, the run sees the recovery and ends with exit 3; otherwise it ends with exit 2 and `cannot reach the daemon at <url>`.

## Talking to it

`run`, `sessions`, `ask`, `projects`, `workspaces`, `plugins` and `bytebureau` on its own talk to the daemon of the home. They read its address and token from `server.json` and send the token as `Authorization: Bearer <token>`. When no daemon answers, the command starts one as `serve` would and goes on; the daemon keeps running afterwards, until `bytebureau serve --stop`. A daemon that does not come up within ten seconds ends the command with exit 2, naming its log. `hello` and `config` never start one.

A daemon started on demand gets the environment of the command without the `BYTEBUREAU_*` variables that choose for one run: of those, only `BYTEBUREAU_HOME`, `BYTEBUREAU_LOG_LEVEL` and `BYTEBUREAU_WORKSPACE_RUNTIME` stay, so the choices of one run never become the defaults of every later one. The `BYTEBUREAU_*` variables of `run` travel with its session instead: `BYTEBUREAU_EMPLOYEE` and `BYTEBUREAU_BRANCH` choose the employee and the base branch where the flags choose nothing, and the agent gets them all but `BYTEBUREAU_HOME`, at the start and at every resume.

`bytebureau` with no command prints the status: the daemon with its URL, pid and start time, the projects, the sessions running, waiting for you and in all, and the pending asks. With `--json` it prints one record, `{"command":"status",…}`.

These global flags choose another way:

| Flag | What it does |
| --- | --- |
| `--host <address>`, `--port <port>` | talk to the daemon at that address (`127.0.0.1` or `4747` for the one not given); it is never started, and when it does not answer the command exits 2 with `cannot reach the daemon at <url>` |
| `--token-file <file>` | read the token of that daemon from the file instead of the `server.json` or `daemon.token` of this home; it goes with `--host` or `--port` |
| `--no-daemon` | run the kernel inside the command, for one-shot headless use such as CI; refused with exit 1 while a daemon answers on the same home, as the store has one writer |

Like every global flag, they may stand before or after any command name: `bytebureau --port 4848 sessions ls` and `bytebureau sessions ls --port 4848` are the same command. For `serve` itself, `--host` and `--port` are the address to listen on.

Every one of these commands but `run` ends a refused request with exit 1 and one line on stderr: a `4xx` problem of the daemon with its detail, the refusal of the kernel in-process, or what the command finds itself (a session or an ask that is not there, an ask without an answer to give). A usage error, a refused `--no-daemon` and a cancelled interactive answer exit 1 as well, and any other failure exits 2. `run` exits 0 when the session completes, 3 when it is stopped or interrupted, 4 when the project, its worktree or the provider cannot be used or the session errors, 2 for any other failure (an invalid configuration, a failure of the store, a daemon that cannot be reached) and 1 for a usage error or a refused `--no-daemon`.

## The API

Every path starts with `/api/v1` and every body is JSON. Every operation needs the bearer token except two: `GET /api/v1/health`, which a client asks before it has read the token, and `GET /api/v1/openapi.json`, the OpenAPI 3.1 document of the API. A request without a valid token gets `401 unauthorized`. The paths below leave out `/api/v1`, and every `POST` and `DELETE` is a mutation, which counts against the rate limit.

| Endpoint | Answer | Notes |
| --- | --- | --- |
| `GET /health` | `200 Health` | no token: `status` (`ok` or `degraded`), `version`, `startedAt` and `checks`, the store and the plugins loaded and failed |
| `GET /openapi.json` | `200` | no token: the OpenAPI document |
| `GET /schemas/config.json` | `200` | the JSON Schema of the configuration files |
| `GET /schemas/events.json` | `200` | the JSON Schema of the events |
| `GET /projects` | `200 Project[]` | |
| `POST /projects` | `201 Project` | body `{ path }`, an absolute path (a relative one resolves in the working directory of the daemon); `422 workspace_not_a_repository`, `422 workspace_is_bytebureau_worktree` |
| `GET /projects/{id}` | `200 Project` | `404 not_found` |
| `DELETE /projects/{id}` | `204` | `404 not_found`, `409 workspace_has_sessions` |
| `GET /sessions` | `200 Session[]` | |
| `POST /sessions` | `201 Session` | body `{ projectId, title, employeeId?, providerId?, profileId?, branch?, env? }`; the session is provisioned (`ready`) when the answer comes; `env` keeps `BYTEBUREAU_*` names only |
| `GET /sessions/{id}` | `200 Session` | `404 session_not_found` |
| `POST /sessions/{id}/prompt` | `200 Turn` | body `{ text, attachments? }`; `409 session_invalid_transition` unless the session is `ready` |
| `POST /sessions/{id}/interrupt` | `204` | interrupts the running turn; `404 session_not_found` when no agent is attached |
| `POST /sessions/{id}/stop` | `204` | |
| `POST /sessions/{id}/resume` | `200 Session` | a stopped or errored session |
| `POST /sessions/{id}/complete` | `204` | |
| `GET /asks?session={id}` | `200 Ask[]` | the pending asks, of one session when `session` is given |
| `GET /asks/{id}` | `200 Ask` | pending or settled; `404 ask_not_found` |
| `POST /asks/{id}/answer` | `204` | body `{ selected, otherText?, remember? }`, recorded as answered through `api`; `409 ask_not_pending`, `422 ask_invalid_answer` |
| `GET /usage/sessions/{id}` | `200 SessionUsage` | |
| `GET /workspaces?project={id}` | `200 WorkspaceInfo[]` | the worktrees, of one project when `project` is given |
| `POST /workspaces/prune` | `200 PruneReport` | body `{ projectId? }`, `{}` for every project |
| `GET /plugins` | `200 PluginStatus[]` | |
| `GET /providers` | `200 Provider[]` | the agent providers the loaded plugins offer |
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

The OpenAPI document has one problem schema for each status an endpoint declares (`Problem400`, `Problem401`, `Problem403`, `Problem404`, `Problem409`, `Problem422`, `Problem429`, `Problem500`, `Problem502` and `Problem503`), each with its status as a literal, so a client knows which problem every status carries. The 413 of the body limit is answered before routing and is not in the document. Text in a detail that looks like a secret is replaced with `[REDACTED]`. The codes, by status:

| Status | Codes |
| --- | --- |
| 400 | `request_invalid`: a body, query, path parameter or header that its schema refuses, named in the detail |
| 401 | `unauthorized` |
| 403 | `session_yolo_refused` |
| 404 | `not_found` (a project), `session_not_found`, `ask_not_found` |
| 409 | `session_invalid_transition`, `ask_not_pending`, `workspace_locked`, `workspace_dirty`, `workspace_has_sessions` |
| 413 | `payload_too_large`, answered before routing and not in the OpenAPI document |
| 422 | `config_invalid`, `session_provider_missing`, `session_employee_missing`, `ask_invalid_answer`, `provider_missing`, `workspace_not_a_repository`, `workspace_is_bytebureau_worktree`, `workspace_git_too_old`, `workspace_git_failed`, `workspace_fs_failed`, `workspace_runtime_missing` |
| 429 | `rate_limited` |
| 500 | `internal`, `plugin_failed` |
| 502 | `provider_auth`, `provider_ratelimit`, `provider_crash`, `provider_protocol` |
| 503 | `store_unavailable` |

`PROBLEM_CODES` of `@bytebureau/protocol` lists the well-known codes; a failure of a workspace or a provider that the kernel names otherwise comes as `workspace_<code>` or `provider_<kind>`.

### Limits

- Mutations are rate limited per client address: 60 at once, flowing back at 60 a minute. A client past its budget gets `429 rate_limited`, whose detail says after how many seconds to retry. The REST mutations and the RPC procedures draw from the same budget, and the clients on this machine all call from the loopback, so they share one.
- A request body holds at most 10 MB: one that declares a larger length gets `413 payload_too_large` before any of it is read.
- Browsers get CORS only for configured origins, and the daemon configures none: the embedded UI of SP2 will come from the daemon itself, on its own origin.

## Events over SSE

`GET /api/v1/events` streams the event log: the durable events after `since` first, then every event as it happens. The query narrows it: `since` is the last `seq` the client has seen (without it the stream replays the whole log), `session` and `project` take an id, and `types` takes event types separated by commas. Each event is one frame:

```text
id: 3
event: project.registered
data: {"seq":3,"id":"01a10725-9d8f-7202-9580-26e16db4aedd","ts":"2026-10-04T13:41:08.111Z","type":"project.registered","projectId":"01a10725-9d8f-7202-9580-211c5f09f0c1","payload":{…}}
```

A durable event carries its `seq` as the `id`. An ephemeral one, a text delta or the progress of a tool, has `seq` 0 and no `id`, and is never replayed. A client that reconnects sends the last id it has seen as `Last-Event-ID`, which wins over `since`, and the stream goes on after it; a value that is not a whole number is ignored.

The heartbeat is an event of its own rather than a comment, so every frame decodes as an envelope:

```text
event: heartbeat
data: {"seq":0,"id":"01a10725-a3e0-735b-9870-b46ad2645cce","ts":"2026-10-04T13:41:09.728Z","type":"heartbeat","payload":{"at":"2026-10-04T13:41:09.728Z"}}
```

The first one leaves at once, so an idle client has the headers of the response straight away, and then one every 15 seconds.

A client that reads slowly does not hold the daemon up. Each connection has a buffer that keeps every durable event but only the latest 64 ephemeral ones, dropping the oldest first: a slow client may miss deltas and progress, never a durable event, and a client that loses its connection resumes from its last id.

## RPC over WebSocket

`GET /api/v1/ws` upgrades to a WebSocket that speaks `effect/rpc` in JSON ([ADR-0013](../decisions/0013-api-transports/)). The procedures are those of `BureauRpcs` in `@bytebureau/protocol`: the stream `events.subscribe`, whose filter takes `since`, `sessionId`, `projectId`, `types` and `ephemeral`, and one procedure for each mutation of the REST API: `projects.register`, `projects.remove`, `sessions.create`, `sessions.prompt`, `sessions.interrupt`, `sessions.stop`, `sessions.resume`, `sessions.complete`, `asks.answer` and `workspaces.prune`.

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

- `createBureauClient({ baseUrl, token, fetch?, retryFor? })` gives `projects`, `sessions`, `asks`, `usage`, `workspaces`, `plugins` and `health` in the names of ByteBureau and the types of the protocol, plus `events.subscribe` and `rpc.connect`. Each client has a generated client of its own, so one process may talk to several daemons. A refusal is thrown as an `ApiError` with the `status` and the `problem`, a daemon that cannot be reached as an `ApiError` of status 0, and a `get` of an id that does not exist resolves to `undefined`.
- `subscribeEvents({ baseUrl, token, filter, signal?, retryFor? })`, behind `events.subscribe`, is an `AsyncIterable` of envelopes. After a lost connection it resumes with `Last-Event-ID`, half a second later at first and twice as long after each failed attempt, up to 30 seconds; it gives up with an `ApiError` of status 0 once reconnecting has failed for `retryFor` (30 seconds by default). A final `4xx` ends it with that problem, an aborted signal ends it quietly, and `ephemeral: false` leaves out the events of `seq` 0.
- `connectRpc({ url, token })`, behind `rpc.connect`, opens the socket and gives `call(tag, payload)`, `stream(tag, payload, signal?)` and `close()`. It sends the token with every request, acknowledges each chunk once its values are read, pings every 30 seconds and throws a problem as an `ApiError`.

The generated code lives in `packages/client/src/gen` and is committed. After a change to the API, `bun run --cwd packages/api build` writes `packages/api/openapi.json`, and `bun run generate:client` regenerates the client from it with hey-api, which runs in `tools/client-codegen` on TypeScript 6 because TypeScript 7 ships no compiler API. CI fails when either is out of date.
