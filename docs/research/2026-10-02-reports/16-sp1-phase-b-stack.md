# 16 — SP1 Phase B stack: verified fact sheet (daemon, HTTP API, SSE, WebSocket, client)

Date: **2026-10-04** (Europe/Prague; checks ran 2026-10-03T22:55Z–23:45Z UTC). Method: npm registry (`npm view <pkg> version dist-tags time engines peerDependencies --json`), GitHub release API, official docs and source files fetched online (WebFetch; `curl` of raw.githubusercontent.com, cdn.jsdelivr.net, data.jsdelivr.com), plus **executed probes** on Bun 1.4.2, Node 24.14.0 and Node 26.10.0 (macOS arm64) against the `effect@4.0.0` / `@effect/platform-bun@4.0.0` already installed in the Phase A scratch directory (nothing new installed). Rule: every fact below has **at least two independent online sources** (docs or source repository plus registry, release page, published tarball or a second article); `[run]` probes are extra evidence, never a substitute. Anything short of that is listed under "Open questions / UNVERIFIED".

Evidence keys: `[Ex]` effect.website v4 API reference; `[Gx]` Effect-TS/effect sources on GitHub `main` (compared with the 4.0.0 tarball where it matters); `[Jx]` npm tarball contents via cdn.jsdelivr.net; `[Bx]` Bun; `[Nx]` Node.js; `[Px]` POSIX / man pages; `[Wx]` WHATWG / MDN; `[Rx]` RFC / IANA; `[Hx]` Hey API; `[Ox]` openapi-ts (openapi-typescript, openapi-fetch); `[Vx]` EventSource libraries; `[Tx]` TypeScript; `[GR]` GitHub release API; `[npm]` registry; `[run]` executed probe; `[local]` the repository's installed `effect@4.0.0` export map (`node_modules/.bun/effect@4.0.0/node_modules/effect/package.json`), used only for "which subpath exists". Probe files: `<S>/probe-b/*` with `<S>` = `/private/tmp/claude-501/-Users-ondrejmisak-WebstormProjects-byte-bureau/4333fb47-536a-4210-9d32-f735d7b219e0/scratchpad/sp1-research` and `<P>/*` with `<P>` = `…/scratchpad/sp1b` (session scratch, may vanish; the snippets below are the durable form). Every URL was accessed on 2026-10-04 (list at the end).

## 0. Read first: blockers, surprises, corrections

1. **TypeScript 7.0.2 ships no compiler API, and both OpenAPI client generators need one.** `require('typescript')` on 7.0.2 returns only `{ version, versionMajorMinor }` [run]; the announcement says "TypeScript 7.0 … does not ship with an API" and recommends `"typescript": "npm:@typescript/typescript6@^6.0.2"` for tools that need it [T1]. `@hey-api/openapi-ts@0.99.0` does `import ts from "typescript"` and calls `ts.factory.*` (102×), `ts.createPrinter`, `ts.SyntaxKind` [J-H7]; `openapi-typescript@7.13.0` calls `ts.factory.*` and `ts.createPrinter` [O10]. Run the generator from an isolated tool workspace whose `typescript` is `npm:@typescript/typescript6@6.0.2`, exactly the pattern `tools/eslint-long-tail` already uses. `openapi-typescript` also declares peer `typescript ^5.x`; its TypeScript 6 issue (#2723, 2026-03-27) and PR (#2774, 2026-04-15) are still open [O3, O7, O8, npm].
2. **Bun closes idle connections after 10 s by default, which kills an SSE stream before a 15 s heartbeat.** `idleTimeout`: seconds, default 10, max 255, `0` disables [B1, B12]. [run] An idle SSE stream through `BunHttpServer` was cut at 10 s with `warn: Bun.serve() timed out a request after 10 seconds. Pass idleTimeout to configure.`; with `idleTimeout: 0` or `30` it stayed open. `BunHttpServer.layer` forwards `Bun.serve` options, so set it there [G1, J1].
3. **`BunHttpServer` binds every interface when `hostname` is omitted** (`internetOptions.hostname ?? "::"`) [G1, J1]. [run] `lsof` showed `TCP *:<port>`; `hostname: 'localhost'` resolved to `::1` only (IPv6) on this Mac; `'127.0.0.1'` gave `TCP 127.0.0.1:<port>`. Use the literal `127.0.0.1` and write that literal into `server.json`.
4. **Effect's `MaxBodySize` is not enforced for JSON bodies on Bun.** `HttpIncomingMessage.MaxBodySize` is a `Context.Reference<ByteSize | undefined>` [E15, G12] read by multipart only; `BunServerRequest.text/json/arrayBuffer` call `source.text()` / `source.arrayBuffer()` with no limit and the file never mentions `MaxBodySize` [G1, J1]. [run] `MaxBodySize` = 1 KiB still accepted a 200 KB JSON body (201); `Bun.serve` `maxRequestBodySize: 65536` answered **413** before Effect ran (Bun default 128 MiB) [B12, B9].
5. **A port conflict surfaces as a defect, not as `ServeError`**: `Bun.serve(...)` is called unguarded inside `BunHttpServer.make` [G1, J1]. [run] The cause held a `Die` "Failed to start server. Is port N in use?" (`EADDRINUSE`) and no typed failure. Catch defects at daemon start to report "already running?".
6. **An open SSE stream holds shutdown for `gracefulShutdownTimeout` (default 20 s)** (`options.gracefulShutdownTimeout ?? Duration.seconds(20)`) [G1, J1]. [run] Releasing the server layer with one open SSE stream took 20.0 s by default and 2.0 s with `gracefulShutdownTimeout: '2 seconds'`. End streams on shutdown and/or lower the timeout.
7. **Effect has no problem-details helper; built-in `HttpApiError.*` render empty bodies**, and schema decode failures render an empty `400` [E8, G13]. A hand-written error schema with `HttpApiSchema.asJson({ contentType: 'application/problem+json' })` plus `HttpApiMiddleware.layerSchemaErrorTransform` works end to end [run; §10].
8. **Effect RPC over WebSocket is plain JSON on the wire but Ack-gated and unstable.** After each stream `Chunk` the server waits for the client's `{"_tag":"Ack","requestId":…}` [G5; E20 "acknowledgement for a streamed RPC response chunk"]; [run] a plain `WebSocket` client received the stream's `Exit` only after sending `Ack`. Every `effect/rpc` export is `@stability unstable` = "may receive breaking changes in minor releases" [E18, E24]. Prefer a hand-written WebSocket protocol for non-Effect clients (§4).
9. **No usable built-in `EventSource` for the CLI**: Node 26 still requires `--experimental-eventsource` (Stability 1) [N1, N2; run on v26.10.0]; Bun 1.4.2 has none [B7, B8; run]; the WHATWG constructor takes no headers (`withCredentials` only) and undici's needs a custom dispatcher [W1, W2, N6]. Hand-roll over `fetch` + `eventsource-parser`.
10. **Hey API's bundled SSE client is not a resume helper**: it stops (`break`) when the server ends the stream normally, never resets its attempt counter, retries every non-OK status (401 included) and yields only `data` [H6, J-H7; the two files are identical].
11. **`Schema.NumberFromString` decodes `"abc"` to `NaN`** (documented; `Schema.FiniteFromString` rejects non-finite values) [G9; run: `Last-Event-ID: abc` produced `id: NaN`].
12. **Cooldown and versions.** `bunfig.toml` now has `minimumReleaseAge = 86400` (one day; report 15 recorded 259 200). At 2026-10-03T23:22Z every `latest` below is older than 24 h; only canary/next tags (`bun`, `bun-types`, `typescript@next`) are newer [npm]. Node v26.10.0 is now installed locally (fnm), unlike during report 15.

## Version table (`npm view` at 2026-10-03T23:22Z; second source = GitHub release)

| Package | latest | npm published (UTC) | Age (d) | Second source / notes |
|---|---|---|---|---|
| effect | 4.0.0 | 2026-10-01T03:11:28Z | 2.84 | GR `effect@4.0.0` 2026-10-01T01:47:13Z; tags `rc` 4.0.0-rc.118, `beta` 4.0.0-beta.107 |
| @effect/platform-bun | 4.0.0 | 2026-10-01T01:47:44Z | 2.90 | GR 01:48:28Z; peer `effect ^4.0.0`; dep `@effect/platform-node-shared ^4.0.0` |
| @effect/platform-node / -node-shared | 4.0.0 / 4.0.0 | 01:48:35Z / 01:47:33Z | 2.90 | node: peers `effect ^4.0.0`, `redis >=5.0.0 <7.0.0`, dep `undici ^8.11.2`; shared: deps `ws ^8.22.0` |
| @effect/sql-sqlite-bun / -node | 4.0.0 / 4.0.0 | 01:47:55Z / 01:47:35Z | 2.90 | GR 01:48:07Z / 01:48:13Z |
| @effect/vitest | 4.0.0 | 2026-10-01T01:47:59Z | 2.90 | GR 01:48:25Z; peers `effect ^4.0.0`, `vitest >=5.0.0 <6.0.0` |
| @effect/sql | 0.52.1 | 2026-07-30T04:29:15Z | 65.8 | GR 2026-07-30T04:29:48Z; v3-era (peers `effect ^3.22.1`, `@effect/platform ^0.97.1`); v4 SQL core is `effect/sql` |
| bun | 1.4.2 | 2026-09-05T06:01:35Z | 28.7 | GR `bun-v1.4.2` 2026-09-05T05:55:48Z; `canary` 1.4.2-canary.20261003.1 (< 24 h, canary only) |
| bun-types / @types/bun | 1.4.2 / 1.4.2 | 2026-09-05 / 2026-09-08 | 28.7 / 25.9 | bun-types `canary` 1.4.3-canary.20261003T145752 (< 24 h) |
| typescript | 7.0.2 | 2026-07-08T15:55:18Z | 87.3 | GR `v7.0.2` (tag 2026-07-08, page published 2026-08-20); T1 dated 2026-07-08; `next` 7.1.0-dev.20261003.1 (< 24 h) |
| @typescript/typescript6 | 6.0.2 | 2026-07-06T18:06:47Z | 89.2 | named in T1 as the side-by-side API package; already used by `tools/eslint-long-tail` |
| vitest | 5.0.3 | 2026-09-30T11:30:42Z | 3.49 | GR `v5.0.3` 2026-09-30T11:25:52Z; engines `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` |
| @hey-api/openapi-ts | 0.99.0 | 2026-06-22T06:38:34Z | 103.7 | GR tag `2026-06-22` ("@hey-api/openapi-ts 0.99.0 … 4 breaking changes") [H5]; engines `node >=22.18.0`; peer `typescript >=5.5.3 \|\| >=6.0.0 \|\| 6.0.1-rc`; `next` 0.0.0-next-20260930190945 |
| @hey-api/client-fetch | 0.13.1 | 2025-06-12 | 478 | **deprecated**: "Starting with v0.73.0, this package is bundled directly inside @hey-api/openapi-ts." [npm, H4] |
| openapi-typescript | 7.13.0 | 2026-02-11T16:02:25Z | 234 | GR 2026-02-11T16:02:27Z; peer `typescript ^5.x`; no engines |
| openapi-fetch | 0.17.0 | 2026-02-11T16:02:21Z | 234 | GR 16:02:33Z; dep `openapi-typescript-helpers ^0.1.0` |
| eventsource | 5.1.2 | 2026-09-21T17:33:35Z | 12.2 | GR `v5.1.2` 2026-09-21 [V3]; engines `node >=22.12.0`; ESM only; dep `eventsource-parser ^4.1.1` |
| eventsource-parser | 4.1.1 | 2026-09-15T18:30:29Z | 18.2 | GR `v4.1.1` 2026-09-15T18:29:36Z; engines `node >=22.12`; no deps |
| @microsoft/fetch-event-source | 2.0.1 | 2021-04-25T18:54:56Z | 1987 | last commit 2023-02-03 (dependabot) [V8]; 51 open issues, 23 open PRs [V7] |
| citty | 0.2.2 | 2026-04-01T18:24:39Z | 185 | GR `v0.2.2` 2026-04-01T18:26:03Z; repo pin 0.2.2 (no drift) |
| @clack/prompts | 1.8.1 | 2026-09-13T17:01:26Z | 20.3 | GR 2026-09-13T17:00:13Z; repo pin 1.8.1 (no drift) |

No drift against the repo pins (`effect` and `@effect/*` 4.0.0, `vitest` 5.0.3, `typescript` 7.0.2, `@types/bun` 1.4.2, `citty`, `@clack/prompts`). New for Phase B: `@effect/platform-bun@4.0.0`, `eventsource-parser@4.1.1`, and in a tools workspace only `@hey-api/openapi-ts@0.99.0` + `@typescript/typescript6@6.0.2`; all pass the one-day cooldown.

## 1. Effect 4 HTTP server on Bun

| # | Fact | Sources | Verified on |
|---|---|---|---|
| 1.1 | The HttpApi DSL is inside `effect`, module group **`effect/http-api`**: `HttpApi`, `HttpApiGroup`, `HttpApiEndpoint`, `HttpApiBuilder`, `HttpApiError`, `HttpApiSchema`, `HttpApiMiddleware`, `HttpApiSecurity`, `HttpApiScalar`, `HttpApiSwagger`, `HttpApiClient`, `HttpApiTest`, `OpenApi` (barrel, or `effect/http-api/<Module>`). The root `effect` barrel does **not** export them. HTTP primitives are `effect/http` (`HttpRouter`, `HttpServer`, `HttpServerRequest`, `HttpServerResponse`, `HttpMiddleware`, `HttpIncomingMessage`, …) | E1 (navigation + import path), G10 (`from "effect/http-api"`, `from "effect/http"`), [local] exports `./http-api`, `./http`; [run] key list of `effect/http-api`, `'HttpApiBuilder' in effect` = false | 2026-10-04 |
| 1.2 | No `effect/unstable/*` paths in 4.0.0: "Imports using `effect/unstable/<module>` must drop the `unstable` segment"; `@stability unstable` "means an API may receive breaking changes in minor releases"; every `http`, `http-api`, `rpc`, `socket`, `encoding/Sse`, `persistence/RateLimiter` export is unstable, added in v4.0.0 | E24, E1–E22, [local] | 2026-10-04 |
| 1.3 | The Bun server layer is the separate package **`@effect/platform-bun@4.0.0`** (`BunHttpServer`), peer `effect ^4.0.0`; "`@effect/platform-*` — platform packages" stay separate | npm, GR, E24, E22 | 2026-10-04 |
| 1.4 | `BunHttpServer.layer(options)` → `Layer<HttpServer \| HttpPlatform \| Etag.Generator \| BunServices, ServeError>`; `options` = Bun `HostnamePortServeOptions` or `UnixServeOptions` (+ `routes`) & `{ disablePreemptiveShutdown?, gracefulShutdownTimeout?: Duration.Input, websocket?: WebSocketOptions }`. Also `layerServer`, `layerConfig` (Config-wrapped options), `layerTest` (ephemeral port + `HttpClient`), `make` | E22, G1, J1 | 2026-10-04 |
| 1.5 | Wiring: `HttpRouter.serve(appLayer, { routerConfig?, disableLogger?, disableListenLog?, middleware? })` provided with `BunHttpServer.layer(...)`; `HttpApiBuilder.layer(Api, { openapiPath? })` registers the API on the router; `HttpApiBuilder.group(Api, 'group', (handlers) => handlers.handle(...))` implements a group | E2, E11, G10 (Node example, comment "you could also use the BunHttpServer"), [run] | 2026-10-04 |
| 1.6 | `BunHttpServer.make` defaults `hostname` to `"::"` and resolves non-IP names with `Bun.dns.lookup` before `Bun.serve`; plain `Bun.serve` documents `0.0.0.0` as its own default | G1, J1, B1, B12; [run] lsof `*:port`, `127.0.0.1:port`, `[::1]:port` | 2026-10-04 |
| 1.7 | Bound address: the `HttpServer.HttpServer` service exposes `address: SocketAddress` (`InetAddressV4 { address, port }`, `InetAddressV6`, `UnixPathAddress`), built from `server.hostname`/`server.port` after `Bun.serve`, so `port: 0` yields the real port; `HttpServer.formatAddress(address)` → `http://127.0.0.1:63802`; also `addressFormattedWith`, `logAddress`, `withLogAddress` (there is no `addressWith`) | E10, G1, J1 (`inetAddressFromIpString(server.hostname, server.port)`), B1, B12 (`port: 0`, `server.port`); [run] | 2026-10-04 |
| 1.8 | `Bun.serve` options reach Bun unchanged: `idleTimeout` (s, default 10, max 255, 0 off), `maxRequestBodySize` (default `1024 * 1024 * 128`), `reusePort` (default false), `ipv6Only` (default false), `development` (default `NODE_ENV !== 'production'`) | B1, B12, B9, G1 (`...listenOptions`); [run] 413 / idle cut-off | 2026-10-04 |
| 1.9 | `BunRuntime.runMain` (node-shared `NodeRuntime`) interrupts the main fiber on `SIGINT` and `SIGTERM`; `BunHttpServer.make` adds `server.stop()` as a finalizer and a preemptive stop bounded by `gracefulShutdownTimeout` (default 20 s) | G11, G1, J1; [run] 20.0 s / 2.0 s | 2026-10-04 |
| 1.10 | Tests on Node (the Vitest runtime): `HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)))` → `{ handler(Request): Promise<Response>, dispose }`; `HttpApiTest.groups(Api, [...])` gives an in-memory typed client | E11, E1, G17 (`HttpApiTest.groups(Api, ["users"])` with `HttpServer.layerServices`); [run] Node 24.14 and 26.10: 404 problem+json and an SSE stream through `toWebHandler` | 2026-10-04 |

Server wiring, as run on Bun 1.4.2 [run; `<S>/probe-b/server.ts`, `run.ts`]:

```ts
import { BunHttpServer } from '@effect/platform-bun'
import { Effect, Layer } from 'effect'
import { HttpRouter, HttpServer } from 'effect/http'
import { HttpApiBuilder, HttpApiScalar } from 'effect/http-api'

const ApiRoutes = HttpApiBuilder.layer(Api, { openapiPath: '/api/v1/openapi.json' }).pipe(
  Layer.provide([SystemLive, SessionsLive, EventsLive]), // HttpApiBuilder.group(Api, 'sessions', (h) => h.handle('get', …))
  Layer.provide([AuthLive, SchemaErrorsLive]),          // middleware implementations (§5, §10)
)
export const Main = HttpRouter.serve(Layer.mergeAll(ApiRoutes, HttpApiScalar.layer(Api, { path: '/api/v1/docs' }), WsRoute), {
  disableListenLog: true,
}).pipe(Layer.provideMerge(BunHttpServer.layer({
  hostname: '127.0.0.1', port: 0,            // literal loopback; 0 = ephemeral
  idleTimeout: 60,                           // seconds; Bun default 10 cuts SSE
  maxRequestBodySize: 1024 * 1024,           // the only effective JSON body limit on Bun (413)
  gracefulShutdownTimeout: '2 seconds',      // default 20 s while SSE streams are open
})))
const program = Effect.gen(function* () {
  const { address } = yield* HttpServer.HttpServer  // { _tag: 'InetAddressV4', port: 63802, … }
  const url = HttpServer.formatAddress(address)     // 'http://127.0.0.1:63802' → server.json
})
// startup: Effect.runPromiseExit(program.pipe(Effect.provide(Main))); EADDRINUSE arrives as a Die, not ServeError
```

## 2. OpenAPI 3.1 and the docs UI

| # | Fact | Sources | Verified on |
|---|---|---|---|
| 2.1 | `OpenApi.fromApi(api, options?: SchemaRepresentation.ToRepresentationOptions)` returns a plain `OpenAPISpec` (not an Effect); doc: "Generates an OpenAPI 3.1 specification"; `OpenAPISpec.openapi` is the literal `"3.1.0"` | E3, G3 (`openapi: "3.1.0"`), [run] | 2026-10-04 |
| 2.2 | Build time needs no server: a `bun run` script importing the `Api` value and writing `JSON.stringify(OpenApi.fromApi(Api))` produced the document | E3 (signature), G3, [run] `<S>/probe-b/openapi.ts` | 2026-10-04 |
| 2.3 | Served copy: `HttpApiBuilder.layer(Api, { openapiPath })` registers `GET openapiPath` returning the memoised `OpenApi.fromApi(api)` | G2, E2, [run] `/api/v1/openapi.json` → `3.1.0` | 2026-10-04 |
| 2.4 | `operationId` defaults to `<group>.<endpoint>` (endpoint id alone for `topLevel` groups), overridable via the `Identifier` annotation; duplicates throw `Duplicate OpenAPI operationId` | G3, [run] `sessions.get` | 2026-10-04 |
| 2.5 | `HttpApiSecurity.bearer` = `http({ scheme: "Bearer" })` → `components.securitySchemes.bearer = { "type": "http", "scheme": "Bearer" }`, per-operation `security: [{ "bearer": [] }]` | G4, G3, E7, [run] | 2026-10-04 |
| 2.6 | Declared errors appear per status with their content type (`404 → application/problem+json → $ref #/components/schemas/NotFoundProblemEncoded`); an SSE success renders `text/event-stream` with the events schema plus `x-effect-stream: { encoding: "sse", causeSchema, errorSchema, failureEvent }` ("Effect-specific metadata for generated streaming response media types") | G3, E3, [run] | 2026-10-04 |
| 2.7 | UI layers, each `Layer<never, never, HttpRouter>`: `HttpApiScalar.layer(api, { path? = '/docs', scalar? })` (bundled script), `HttpApiScalar.layerCdn(api, { path?, scalar?, version? })` (jsDelivr), `HttpApiSwagger.layer(api, { path? = '/docs' })`. Bundled assets in the 4.0.0 tarball: `dist/http-api/internal/httpApiScalar.js` 3 249 520 B, `httpApiSwagger.js` 1 984 879 B | E5, E6, J3 (file sizes), [run] `/api/v1/docs` 200 `text/html` | 2026-10-04 |

## 3. SSE on the server

| # | Fact | Sources | Verified on |
|---|---|---|---|
| 3.1 | `effect/encoding/Sse`: `encoder.write(Event \| Retry)`, `encode()`, `encodeSchema(schema)`, `decode(options?)`, `decodeSchema`, `decodeDataSchema`, `makeParser(onParse)`; models `Event { _tag, event, id, data }`, `EventEncoded`, `Retry { duration, lastEventId }`. The encoder writes `id:`, `event:` (omitted for `message`), multi-line `data:` and `retry:` — **no comment lines** | E16, G8 (encoder source), J3 (`dist/encoding/Sse.js` in 4.0.0) | 2026-10-04 |
| 3.2 | HttpApi has first-class SSE: success schema `HttpApiSchema.StreamSse({ events, error?, contentType? })` or `({ data, error?, contentType? })`; the handler returns a `Stream`; reserved failure event `effect/http-api/stream/failure` (data = encoded `Cause`); `StreamUint8Array` for bytes; `HttpApiSchema.WithHeaders` adds response headers. Release notes: "HttpApi supports typed response headers, streaming and SSE responses" | E4, E25, [run] | 2026-10-04 |
| 3.3 | The built-in SSE encoder emits only events (no heartbeat, no `cache-control`); [run] body `id: 42\nevent: bb.event\ndata: {"seq":42}\n\n…`; events without `id` omit the line | G2 (`makeSseEncoder`), E4, [run] | 2026-10-04 |
| 3.4 | `Handler` and `HandlerRaw` may return `SuccessType \| HttpServerResponse`, and the builder passes a returned `HttpServerResponse` through untouched; so a `StreamSse`-declared endpoint can return `HttpServerResponse.stream(Stream.encodeText(text), { contentType: 'text/event-stream', headers })` with comment heartbeats while keeping OpenAPI, middleware and query/header decoding | G2 (`if (Response.isHttpServerResponse(response)) return response`), E2 (`handleRaw`), E14 (`stream(body, options)`), [run] `<S>/probe-b/raw-in-api.ts` | 2026-10-04 |
| 3.5 | Heartbeat comments are ignored by parsers ("If the line starts with a U+003A COLON character (:) Ignore the line"); WHATWG suggests a comment line "every 15 seconds or so" against proxy timeouts; Effect has `Stream.tick(interval)` and `Stream.merge` | W1, V5 (`onComment`), [run] | 2026-10-04 |
| 3.6 | Resume inputs: EventSource resends `Last-Event-ID` on reconnect; HttpApi decodes it with `headers: { 'last-event-id': … }` (lower-case key) next to `query: { since: … }` | W1, E4 / G2 (headers and query decoding), [run] `since=10` → ids 11…, `Last-Event-ID: 20` → 21… | 2026-10-04 |
| 3.7 | `Schema.NumberFromString` decodes to `NaN`/±Infinity when the text is not a finite number; `Schema.FiniteFromString` rejects them | G9, [run] | 2026-10-04 |
| 3.8 | The idle timeout applies to streaming responses (see §0.2); `server.timeout(req, 0)` would disable it per request, but Effect's `HttpServer` service exposes only `serve` and `address`, so set `idleTimeout` on `BunHttpServer.layer` | B1, B12, E10, G1, [run] | 2026-10-04 |

SSE endpoint, as run [run; `<S>/probe-b/api.ts`, `raw-in-api.ts`]:

```ts
// contract (packages/protocol): appears in OpenAPI as text/event-stream
HttpApiEndpoint.get('stream', '/', {
  query: { since: Schema.optional(Schema.FiniteFromString) },
  headers: { 'last-event-id': Schema.optional(Schema.FiniteFromString) },
  success: HttpApiSchema.StreamSse({ events: Schema.Struct({ id: Schema.optional(Schema.String), event: Schema.String, data: Schema.String }) }),
})
// handler (kernel): hand-encoded frames so comments and cache-control are possible
h.handle('stream', ({ query, headers }) => {
  const from = headers['last-event-id'] ?? query.since ?? 0
  const events = eventsAfter(from).pipe(Stream.map((e) => `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`))
  const heartbeat = Stream.tick('15 seconds').pipe(Stream.map(() => ': keepalive\n\n'))
  return Effect.succeed(HttpServerResponse.stream(Stream.encodeText(Stream.merge(events, heartbeat)), {
    contentType: 'text/event-stream', headers: { 'cache-control': 'no-cache' } }))
})
```

## 4. WebSocket and Effect RPC

| # | Fact | Sources | Verified on |
|---|---|---|---|
| 4.1 | Upgrade in any route: `HttpServerRequest.upgrade: Effect<Socket, HttpServerError>` (also `upgradeChannel()`); pattern `const socket = yield* request.upgrade; const writer = yield* socket.writer; const { pull } = yield* socket.reader; … return HttpServerResponse.empty()` — what `RpcServer` itself does | E13, G5 (`makeProtocolWithHttpEffectWebsocket`), [run] `/api/v1/ws-raw` echo + `CloseEvent(1000, 'bye')` | 2026-10-04 |
| 4.2 | `effect/socket` `Socket` = pull-based `reader` (`pull` yields non-empty frame batches; every end, clean close included, fails with `SocketError`) + scoped `writer` (`write`, `writeAll`, `new Socket.CloseEvent(code, reason)`); request headers are readable before the upgrade | E17, E13, [run] | 2026-10-04 |
| 4.3 | On Bun the server-side writer is `Effect.sync(() => ws.sendText/sendBinary(chunk, …))`: the `send` result (`-1` backpressure, `0` dropped, `>0` bytes) is ignored, so there is **no write backpressure** from the socket. `BunHttpServer.layer({ websocket })` forwards Bun handler options except lifecycle hooks: `maxPayloadLength` 16 MB, `idleTimeout` 120 s, `backpressureLimit` 16 MB, `closeOnBackpressureLimit` false, `sendPings` true, `perMessageDeflate` false (+ Effect's `compressionThreshold` 1024) | G1, J1 (`ws.sendText(chunk, …)` in both), B2, B3, E22 | 2026-10-04 |
| 4.4 | Clients: Bun's and Node's (undici) `WebSocket` accept a non-standard `{ headers }` (Node: `WebSocketInit { protocols, dispatcher, headers }`); browsers only take `new WebSocket(url, protocols)` — no custom headers | B3, N7, W3; [run] server saw `authorization` from a Bun client and from Node 24.14 / 26.10 clients | 2026-10-04 |
| 4.5 | RPC API (`effect/rpc`): `Rpc.make(tag, { payload, success, error, stream })`, `RpcGroup.make(...rpcs)`, `group.toLayer(handlers)`, `RpcServer`, `RpcClient`, `RpcSerialization`, `RpcMiddleware`, `RpcMessage`. Same HTTP server: `RpcServer.layerHttp({ group, path, protocol?: 'websocket' \| 'http', concurrency?, … })` (websocket is the default and registers `GET path`; http registers `POST path`) + a serialization layer | E18, G5, [local] `./rpc`, [run] `/api/v1/rpc` | 2026-10-04 |
| 4.6 | Serializations: `layerJson` (`application/json`, one JSON value or array per frame, no framing), `layerNdjson` (`application/ndjson`), `layerJsonRpc()` / `layerNdJsonRpc()` (JSON-RPC 2.0 plus Effect extensions: stream chunks as `{ chunk: true, id, result }`, control methods `@effect/rpc/Ack\|Ping\|Pong\|Interrupt\|Eof`, errors `{ _tag: 'Cause', code, message, data }`), `layerSchemaBinary()` | E19, G6 | 2026-10-04 |
| 4.7 | Wire envelopes. Client → server: `{ _tag: 'Request', id, tag, payload, headers: [[k, v]], isNotification?, traceId?, spanId?, sampled? }`, `{ _tag: 'Ack', requestId }`, `{ _tag: 'Interrupt', requestId }`, `{ _tag: 'Ping' }`, `{ _tag: 'Eof' }`. Server → client: `{ _tag: 'Chunk', requestId, values }`, `{ _tag: 'Exit', requestId, exit: { _tag: 'Success', value } \| { _tag: 'Failure', cause: [{ _tag: 'Fail', error } \| { _tag: 'Die', defect } \| { _tag: 'Interrupt', fiberId }] } }`, `{ _tag: 'Defect', defect }`, `{ _tag: 'Pong' }`; payloads and values use the RPC schemas' JSON codecs | G7, E20, [run] | 2026-10-04 |
| 4.8 | Socket protocols set `supportsAck: true`: after each `Chunk` the server awaits a latch that only `Ack` opens (`disableClientAcks` exists only on `makeNoSerialization`); `Ping` → `Pong` | G5, E20, E18, [run] `Exit` for the stream arrived only after `Ack`, `Ping` answered with `Pong` | 2026-10-04 |

Plain-client RPC exchange observed [run; `<S>/probe-b/run.ts`, `layerJson`]:

```text
→ {"_tag":"Request","id":"1","tag":"Echo","payload":{"text":"hi"},"headers":[]}
← {"_tag":"Exit","requestId":"1","exit":{"_tag":"Success","value":"echo:hi"}}
→ {"_tag":"Request","id":"2","tag":"Ticks","payload":{"n":3},"headers":[]}   → {"_tag":"Ping"}
← {"_tag":"Chunk","requestId":"2","values":[1,2,3]}   ← {"_tag":"Pong"}
→ {"_tag":"Ack","requestId":"2"}          (sent 400 ms later; nothing arrived meanwhile)
← {"_tag":"Exit","requestId":"2","exit":{"_tag":"Success","value":null}}
```

## 5. Middleware: bearer auth, CORS, body limits, logging, rate limiting

| # | Fact | Sources | Verified on |
|---|---|---|---|
| 5.1 | Bearer: `HttpApiMiddleware.Service<Self, { provides; requires }>()(id, { security: { bearer: HttpApiSecurity.bearer }, error, requiredForClient? })`, implemented as `{ bearer: (httpEffect, { credential, endpoint, group }) => … }` with `credential: Redacted` (`Redacted.value(credential)`); attach with `.middleware(Auth)` on a group or endpoint. A request without `Authorization` still reaches the handler (empty credential), so the handler must reject it | E7, E9, J2 / G10 (fixture), [run] missing / wrong token → our 401 | 2026-10-04 |
| 5.2 | CORS: `HttpMiddleware.cors({ allowedOrigins (array or predicate), allowedMethods, allowedHeaders, exposedHeaders, maxAge, credentials })` and the router layer `HttpRouter.cors(options)` | E12, E11, G14 | 2026-10-04 |
| 5.3 | Body size on Bun: only `maxRequestBodySize` (413, empty body) limits JSON/text; `MaxBodySize` is read by multipart only | §0.4 sources, [run] | 2026-10-04 |
| 5.4 | Logging: `HttpRouter.serve` installs `HttpMiddleware.logger` unless `disableLogger: true`; it logs "Sent HTTP response" at Info with `http.method`, `http.url` (path with search and hash stripped), `http.status`; per-route opt-out `HttpRouter.disableLogger`; also `HttpMiddleware.tracer`, `xForwardedHeaders`, `compression` | E11, E12, G14 (`stripSearchAndHash`), [run] | 2026-10-04 |
| 5.5 | Rate limiting: no HTTP rate-limit middleware; `effect/persistence` `RateLimiter.consume({ key, limit, window, algorithm?: 'fixed-window' \| 'token-bucket', onExceeded?: 'fail' \| 'delay', tokens? })` with `layerStoreMemory` / `layerStoreRedis`, error `RateLimitExceeded`; the 4.0.0 release note mentions only "rate-limited clients" | E21, E12 (export list), G15, E25 | 2026-10-04 |

Bearer and validation middleware, as run [run; `<S>/probe-b/api.ts`, `server.ts`]:

```ts
export class Auth extends HttpApiMiddleware.Service<Auth, { provides: Principal; requires: never }>()('bb/Auth', {
  security: { bearer: HttpApiSecurity.bearer },
  error: UnauthorizedProblem.pipe(HttpApiSchema.asJson({ contentType: 'application/problem+json' })),
}) {}
const AuthLive = Layer.succeed(Auth, Auth.of({
  bearer: Effect.fn(function* (httpEffect, { credential }) {
    if (!sameToken(Redacted.value(credential))) return yield* new UnauthorizedProblem({ /* RFC 9457 fields */ })
    return yield* Effect.provideService(httpEffect, Principal, { /* … */ })
  }),
}))
```

## 6. Client generation for `packages/client`

| # | Fact | Sources | Verified on |
|---|---|---|---|
| 6.1 | Hey API: `@hey-api/openapi-ts@0.99.0`, CLI `openapi-ts` (`npx @hey-api/openapi-ts -i <spec> -o <dir>`) or `openapi-ts.config.ts\|.mjs\|.cjs` with `defineConfig({ input, output: { path, postProcess? }, plugins: ['@hey-api/client-fetch', '@hey-api/sdk', '@hey-api/typescript', …] })` | H1, H2, H8 | 2026-10-04 |
| 6.2 | "Beginning with v0.73.0, all Hey API clients are bundled by default and don't require installing any additional dependencies": the fetch client is written into the output (`client/`, `core/*.gen.ts`) and configured with `client.setConfig({ baseUrl })`, an `auth` option (string or function returning the token) or request interceptors; the `@hey-api/client-fetch` npm package is deprecated. Bundled client sources in 0.99.0: `dist/clients/fetch/*` + `dist/clients/core/*` = 52 159 B of TypeScript | H4, H3, npm, H9, J-H7 (file listing) | 2026-10-04 |
| 6.3 | OpenAPI versions: "Hey API supports all valid OpenAPI versions"; the repo carries snapshot suites `2.0.x`, `3.0.x`, `3.1.x` | H2, H9 | 2026-10-04 |
| 6.4 | Runtime of the generator: engines `node >=22.18.0` (docs: "any Node.js 22+"); the bin is `#!/usr/bin/env node`; "This package is in initial development. Please pin an exact version"; v0.99.0 alone has 4 breaking changes; the repo's own examples use `typescript@6.0.3` and type-check generated code with `tsgo` | npm, H1, H5, J-H7 (`bin/run.js`), H8 | 2026-10-04 |
| 6.5 | Uses the TypeScript compiler API at generation time (`import ts from "typescript"`, `ts.factory`, `ts.createPrinter`, `ts.SyntaxKind`) → needs `@typescript/typescript6` beside TS 7 | J-H7 (`dist/init-D6Y8JFUS.mjs`), T1, [run] TS 7 `require('typescript')` has no `factory` | 2026-10-04 |
| 6.6 | SSE (since v0.81.0): `text/event-stream` operations return `{ stream }` (`for await`); `core/serverSentEvents.ts`: default retry 3000 ms, doubling to 30 s, resends `Last-Event-ID`, options `onSseEvent`, `onSseError`, `sseDefaultRetryDelay`, `sseMaxRetryAttempts`, `sseMaxRetryDelay`; limits in §0.10 | H4, H6, J-H7 | 2026-10-04 |
| 6.7 | `openapi-typescript@7.13.0`: "Supports OpenAPI 3.0 and 3.1"; output is types only ("runtime-free types"); "Node.js … 20.x or higher recommended"; peer `typescript ^5.x`; calls `ts.factory` / `ts.createPrinter`; TS 6 issue #2723 and PR #2774 open; the PR reports that TS 6 changed `Date extends object`, breaking `Readable<T>` / `Writable<T>` | O1, O2, O3, O7, O8, O10, npm | 2026-10-04 |
| 6.8 | `openapi-fetch@0.17.0`: "Weighs 6 kb"; bundlephobia 7 500 B min / 2 909 B gzip; `createClient<paths>({ baseUrl })`, `client.use({ onRequest, onResponse, onError })`, `parseAs: 'json' \| 'text' \| 'blob' \| 'arrayBuffer' \| 'stream'`; no SSE helper | O4, O5, O6, O9, npm | 2026-10-04 |

Hey API configuration for this repo (shape from H2/H8; **not executed** here):

```ts
// tools/client-codegen/openapi-ts.config.ts — its package.json pins "@hey-api/openapi-ts": "0.99.0",
// "typescript": "npm:@typescript/typescript6@6.0.2" (own install, like tools/eslint-long-tail)
import { defineConfig } from '@hey-api/openapi-ts'
export default defineConfig({
  input: '../../packages/protocol/openapi.json',
  output: { path: '../../packages/client/src/gen' },
  plugins: ['@hey-api/client-fetch', '@hey-api/sdk', '@hey-api/typescript'],
})
```

## 7. SSE client for Node 26, Bun 1.4 and browsers

| # | Fact | Sources | Verified on |
|---|---|---|---|
| 7.1 | Node 26 global `EventSource`: "Stability: 1 - Experimental. Enable this API with the `--experimental-eventsource` CLI flag" (added v22.3.0, v20.18.0); undici options `withCredentials`, `node.dispatcher`, `node.reconnectionTime` (default 3000); custom headers only through a custom `Agent.dispatch` | N1, N2, N6; [run] v26.10.0 `undefined` without the flag, `function` with it | 2026-10-04 |
| 7.2 | Bun 1.4.2 has no global `EventSource` (absent from the Web API list; issue #8474 "Implement EventSource" open since 2024-01-25) | B7, B8, [run] | 2026-10-04 |
| 7.3 | WHATWG `EventSourceInit` has only `withCredentials`; a non-200 status or a non-`text/event-stream` type fails the connection without reconnecting; `retry:` sets the reconnection time | W1, W2 | 2026-10-04 |
| 7.4 | `eventsource@5.1.2`: "WhatWG/W3C-compatible"; Node ≥ 22.12, ESM only (CommonJS dropped in v5.0.0); init `fetch`, `withCredentials`, `maxBufferSize`; headers via `fetch: (input, init) => fetch(input, { ...init, headers: { ...init.headers, Authorization: 'Bearer …' } })`; reconnect default 3000 ms (updated by `retry:`), sends `Last-Event-ID`; non-200 or wrong content type → `#failConnection` (no reconnect); `close()` prevents reconnection | V1, V2, V3, V4, npm | 2026-10-04 |
| 7.5 | `eventsource-parser@4.1.1`: `createParser({ onEvent, onId, onRetry, onComment, onError })` → `{ feed(chunk), reset({ consume? }) }`; `EventSourceParserStream` from `eventsource-parser/stream` (`TransformStream<string, EventSourceMessage>`, options `onError: 'terminate' \| fn`, `onRetry`, `onComment`, `onId`, `maxBufferSize`); messages `{ id?, event?, data }`; no reconnection logic; ESM, no dependencies, Node ≥ 22.12 | V5, V6, npm | 2026-10-04 |
| 7.6 | `@microsoft/fetch-event-source@2.0.1`: last publish 2021-04-25, last commit 2023-02-03 (dependabot), 51 open issues / 23 open PRs; README features: any method/headers/body, retry control, Last-Event-ID retry, closes on hidden page | npm, V7, V8 | 2026-10-04 |

Resume loop sketch for `packages/client` (API names verified in V5/V6, W1; **not executed**, the package was not installed):

```ts
import { EventSourceParserStream } from 'eventsource-parser/stream'
export async function* events(base: string, token: string, opts: { since?: number; signal?: AbortSignal } = {}) {
  let last = opts.since
  for (let attempt = 0; !opts.signal?.aborted; ) {
    try {
      const res = await fetch(`${base}/api/v1/events${last === undefined ? '' : `?since=${last}`}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream', ...(last === undefined ? {} : { 'last-event-id': String(last) }) },
        signal: opts.signal })
      if (res.status === 401 || res.status === 403) throw new Error('unauthorized')   // fatal: do not retry
      if (!res.ok || !res.body) throw new Error(`http ${res.status}`)                   // retry
      attempt = 0
      const reader = res.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).getReader()
      for (let r = await reader.read(); !r.done; r = await reader.read()) {   // getReader(): no reliance on async-iterable streams
        if (r.value.id !== undefined) last = Number(r.value.id)
        yield r.value                                 // { id, event, data }; ': keepalive' comments never surface
      }
    } catch (e) { if (opts.signal?.aborted || (e as Error).message === 'unauthorized') throw e }
    await new Promise((r) => setTimeout(r, Math.min(30_000, 500 * 2 ** attempt++)))   // also after a clean close
  }
}
```

## 8. Daemonising with Bun 1.4

| # | Fact | Sources | Verified on |
|---|---|---|---|
| 8.1 | `Bun.spawn(cmd, { detached: true })`: "POSIX: calls `setsid()` so the child starts a new session and becomes the process group leader … can outlive the parent"; Windows `UV_PROCESS_DETACHED`; default false; "stdio may keep the parent process alive. Pass `stdio: ["ignore", "ignore", "ignore"]`"; `proc.unref()` "to detach the child process from the parent"; stdout/stderr accept `"ignore"`, `Bun.file()` or a file descriptor. The main child-process page does not mention `detached` | B5, B13 (bun-types 1.4.2 `bun.d.ts` L7398–7411), B4; [run] | 2026-10-04 |
| 8.2 | Node-compatible fallback: `child_process.spawn(cmd, args, { detached: true, stdio: ['ignore', fd, fd] })` + `subprocess.unref()`; Node: on non-Windows the child becomes "the leader of a new process group and session"; `unref()` lets the parent exit "unless there is an established IPC channel"; redirect with `fs.openSync(log, 'a')` | N3; [run] under Bun 1.4.2 both `Bun.spawn` and `node:child_process` children: parent exited in 0 s, child PPID 1, PGID = own PID, `STAT Ss` | 2026-10-04 |
| 8.3 | Exclusive lock: `openSync(path, 'wx', 0o600)` = `O_CREAT \| O_EXCL`; POSIX: existence check and creation are atomic, fails with `EEXIST`; Node: "The exclusive flag might not work with network file systems" | P3, N5; [run] `EEXIST` on Bun 1.4.2, Node 24.14, Node 26.10 | 2026-10-04 |
| 8.4 | Atomic `server.json`: write a temp file in the same directory (`'wx'`, mode `0o600`), `fsync`, `renameSync(tmp, 'server.json')`; POSIX rename keeps the new name "visible … and refer[ring] either to the file referred to by new or old"; cross-filesystem fails with `EXDEV`; Node `mode` "sets the file mode … but only if the file was created" | P1, P4, N5; [run] final mode `600` (umask 022) on all three runtimes | 2026-10-04 |
| 8.5 | Stale PID: signal `0` tests existence without sending (POSIX "null signal"); Node throws if the process does not exist; errors `ESRCH` (none) vs `EPERM` (exists, not ours) | N4, P2; [run] `kill(999999, 0)` → `ESRCH`, `kill(1, 0)` → `EPERM`, own PID → no error | 2026-10-04 |
| 8.6 | `reusePort`: sets `SO_REUSEPORT`, default false, "Linux only — Windows and macOS ignore" it; without it a second bind fails with `EADDRINUSE` "Failed to start server. Is port N in use?" | B12, B10; [run] | 2026-10-04 |

## 9. Version drift

See the version table: no `latest` younger than 24 h at 2026-10-03T23:22Z; the only sub-24-h publications are `bun` / `bun-types` canaries and `typescript@7.1.0-dev.20261003.1` on `next` [npm]. `effect@4.0.0` (2.84 d) and `@effect/platform-bun@4.0.0` (2.90 d) pass the current 86 400 s cooldown; `@hey-api/openapi-ts` has had no stable release since 2026-06-22 (only `next` snapshots, latest 2026-09-30) and `openapi-typescript`/`openapi-fetch` none since 2026-02-11 [npm, GR].

## 10. Problem details (RFC 9457) and ByteBureau error codes

| # | Fact | Sources | Verified on |
|---|---|---|---|
| 10.1 | RFC 9457 "Problem Details for HTTP APIs" (July 2023) obsoletes RFC 7807; media type `application/problem+json` (IANA registration cites RFC 9457); members `type` (URI reference, default `about:blank`), `status`, `title`, `detail`, `instance`; extension members allowed and clients "MUST ignore any such extensions that they don't recognize" | R1, R2 | 2026-10-04 |
| 10.2 | Effect 4.0.0 has no problem-details helper (no `problem+json` anywhere in the `.d.ts`; none in the HttpApiError reference); built-in `HttpApiError.*` render empty responses with their status; `HttpApiSchemaError` (kind `Params \| Headers \| Query \| Body \| Payload \| ResponseHeaders`) renders an empty `400` | E8, G13 (`HttpServerResponse.empty({ status: 400 })`), [local] grep | 2026-10-04 |
| 10.3 | Pattern: an error class with `{ httpApiStatus: N }` (or `HttpApiSchema.status(N)`) piped through `HttpApiSchema.asJson({ contentType: 'application/problem+json' })`; HttpApiBuilder encodes declared errors with the schema's encoding content type | E4 (`status`, `asJson`), G2 (`Response.text(s, { status, contentType: encoding.contentType })`), J2 (`{ httpApiStatus: 401 }`), [run] 401/404 bodies and OpenAPI content types | 2026-10-04 |
| 10.4 | Decode failures as problems: a middleware service declaring `error: ValidationProblem.pipe(problemJson)` plus `HttpApiMiddleware.layerSchemaErrorTransform(Service, (e) => Effect.fail(new ValidationProblem({ … })))`; the generated OpenAPI `400` then references the problem schema | E9, G16, [run] 400 `application/problem+json` "Payload: Expected a value with a length of at least 1 at ["name"]" | 2026-10-04 |
| 10.5 | `Schema.TaggedError` adds `_tag` to the encoded body (an RFC 9457 extension member); `Schema.Error<Self>('Id')(fields, annotations?)` is the untagged variant | G9, [run] body `{"_tag":"NotFoundProblem","type":…}` | 2026-10-04 |

Problem schema as run [run; `<S>/probe-b/api.ts`]:

```ts
const problemJson = HttpApiSchema.asJson({ contentType: 'application/problem+json' })
const ProblemFields = { type: Schema.String, title: Schema.String, status: Schema.Number, detail: Schema.String, code: Schema.String }
export class NotFoundProblem extends Schema.TaggedError<NotFoundProblem>()('NotFoundProblem', ProblemFields, { httpApiStatus: 404 }) {}
HttpApiEndpoint.get('get', '/:id', { params: { id: Schema.String }, success: Session, error: NotFoundProblem.pipe(problemJson) })
// wire: 404 application/problem+json {"_tag":"NotFoundProblem","type":"https://bytebureau.dev/problems/not-found","title":"Not found","status":404,"detail":"session missing","code":"BB_SESSION_NOT_FOUND"}
```

## Recommendations for the plan

1. **HTTP server**: `effect/http-api` + `effect/http` with `@effect/platform-bun@4.0.0` `BunHttpServer.layer({ hostname: '127.0.0.1', port, idleTimeout: 60, maxRequestBodySize: 1 MiB, gracefulShutdownTimeout: '2 seconds' })` under `HttpRouter.serve`, run by `BunRuntime.runMain`; read the bound port from `HttpServer.HttpServer.address` and map the startup `EADDRINUSE` defect to a typed error. Reason: first-party, typed handlers, OpenAPI for free; the explicit options close the four Bun defaults found in §0.2–0.6.
2. **OpenAPI**: generate `packages/protocol/openapi.json` with a `bun run` script calling `OpenApi.fromApi(Api)` (3.1.0) and fail CI on diff; serve the same document at `/api/v1/openapi.json` via `openapiPath`. Keep Scalar/Swagger out of the release binary (3.2 MB / 2.0 MB bundles) or use `HttpApiScalar.layerCdn` in development only. Reason: deterministic artefact for the generator, no server needed.
3. **SSE**: declare `/api/v1/events` with `HttpApiSchema.StreamSse({ events })` (contract and OpenAPI) but return a hand-encoded `HttpServerResponse.stream` with `id: <seq>` events, `: keepalive` every 15 s and `cache-control: no-cache`; resume from `last-event-id` header or `since` query, both `Schema.FiniteFromString`; end open streams on shutdown. Reason: the built-in encoder cannot write comments, and this keeps middleware and docs.
4. **WebSocket**: a hand-written, versioned JSON protocol on `HttpServerRequest.upgrade` (reader/writer from `effect/socket`), message schemas in `packages/protocol`, per-client `Queue.bounded`/`Queue.sliding` with an explicit overflow policy, `websocket: { closeOnBackpressureLimit: true, backpressureLimit: <small> }`, token in the first message (browsers cannot send headers). Do not expose Effect RPC to non-Effect clients. Reason: Effect RPC's envelope is unstable and needs Ack/Interrupt/Cause handling, and the Bun writer has no backpressure.
5. **Middleware**: one `HttpApiMiddleware.Service` with `HttpApiSecurity.bearer` and a constant-time token comparison on every group except health/openapi; a `SchemaErrors` middleware with `layerSchemaErrorTransform` for problem-JSON 400s; keep the built-in logger (path only); `HttpRouter.cors({ allowedOrigins: [...] })` only once a cross-origin UI exists; body limit via `maxRequestBodySize`; rate-limit failed auth with `RateLimiter` + `layerStoreMemory` if needed. Reason: everything needed exists except a rate-limit middleware, which is small to write.
6. **Client generation**: `@hey-api/openapi-ts@0.99.0` pinned exactly, plugins `@hey-api/typescript` + `@hey-api/sdk` + `@hey-api/client-fetch`, run from `tools/client-codegen` (own install, `typescript: npm:@typescript/typescript6@6.0.2`), output committed to `packages/client/src/gen`. Reason: zero runtime dependency (client code is generated into the package), fetch-based so it works in the CLI, a browser and a Tauri webview, accepts TS 6, actively maintained; `openapi-typescript` + `openapi-fetch` has the smaller runtime (7.5 kB) but is pinned to TS 5 with TS 6 support unmerged since April 2026.
7. **SSE client**: hand-rolled `AsyncIterable` over `fetch` + `eventsource-parser@4.1.1` (`EventSourceParserStream`), sending the bearer header plus `Last-Event-ID`/`since`, reconnecting with capped backoff after errors and clean closes, resetting the backoff after a successful open, stopping on 401/403. Reason: neither runtime has a header-capable built-in `EventSource`; `eventsource` treats any non-200 as fatal; Hey API's SSE helper stops on a clean close; `@microsoft/fetch-event-source` is unmaintained since 2021.
8. **Daemon**: the CLI spawns `process.execPath serve --foreground` with `detached: true`, `stdio: ['ignore', logFd, logFd]`, explicit `cwd`, then `unref()` (`Bun.spawn` or `node:child_process`, both verified); lock with `openSync(lock, 'wx', 0o600)`; `server.json` (host literal, port, 32-byte token, pid) via temp file + `fsync` + `rename` at mode 0600; stale check `process.kill(pid, 0)` (`ESRCH` = stale) followed by an authenticated health call to rule out PID reuse; leave `reusePort` off. Reason: all primitives behaved identically on Bun 1.4.2, Node 24 and Node 26.
9. **Versions**: keep the current pins; add `@effect/platform-bun@4.0.0` and `eventsource-parser@4.1.1`; the generator and `@typescript/typescript6@6.0.2` stay in the tools workspace. Reason: no drift, nothing inside the cooldown window.
10. **Problem details**: hand-written RFC 9457 error classes (`type`, `title`, `status`, `detail`, optional `instance`, plus a ByteBureau `code`) with `httpApiStatus` and `asJson({ contentType: 'application/problem+json' })`, the `SchemaErrors` transform for 400s, and documented exceptions (Bun's empty 413, empty 500 on defects). Prefer `Schema.Error` if `_tag` should not appear on the wire. Reason: Effect has no helper, and the pattern is verified end to end including OpenAPI.

## Open questions / UNVERIFIED

1. Linux (and Windows) behaviour of every `[run]` above: all probes ran on macOS arm64; Linux semantics are taken from POSIX and the docs only.
2. Hey API output for the Effect-generated document (SDK names from `sessions.get` operationIds, handling of `x-effect-stream`, optional fields rendered as `anyOf [string, null]`, type-checking the output under TS 7.0.2 with `exactOptionalPropertyTypes`) — not executed (no installs allowed).
3. Whether a per-package alias (`packages/client` devDependency `typescript: npm:@typescript/typescript6@6.0.2`) would make the generator resolve TS 6 under Bun's isolated linker; only the separate `tools/*` install pattern is verified in this repo.
4. Bun's behaviour once `backpressureLimit` is exceeded with `closeOnBackpressureLimit: false` (buffer vs drop) — single-source docs, not run.
5. Bun issue #44372 (`node:child_process` `spawn({ detached: true })` without `cwd` does an internal `chdir($HOME)`, closed as not planned) — one source; passing `cwd` explicitly is harmless either way.
6. Stability of the Effect RPC wire format beyond 4.0.0 (`@stability unstable`); the Effect client's own Ping interval was not checked.
7. `eventsource@5.1.2` and `@microsoft/fetch-event-source` under Bun 1.4.2 — not run (neither is recommended).
8. Payload shape of the reserved `effect/http-api/stream/failure` SSE event for non-Effect clients — only the event name and "encoded `Cause`" are documented.
9. Browser-side WebSocket authentication (first message vs `Sec-WebSocket-Protocol` vs a short-lived ticket) and Tauri webview origins for CORS — design choices, not researched here.
10. The TypeScript 7.1 API ("We expect TypeScript 7.1 to ship with a new (and different) API") and openapi-typescript PR #2868 (dropping the TypeScript dependency) — the PR page returned 404 at access time; neither is released.
11. Plain `Bun.serve` without `hostname` reports `server.hostname === 'localhost'` although the docs say it listens on `0.0.0.0` [run] — cosmetic, unexplained, irrelevant once `127.0.0.1` is passed.

## Sources (all accessed 2026-10-04, Europe/Prague)

Effect documentation (effect.website v4 API reference): [E1] https://effect.website/docs/v4/api/effect/http-api/HttpApi · [E2] https://effect.website/docs/v4/api/effect/http-api/HttpApiBuilder · [E3] https://effect.website/docs/v4/api/effect/http-api/OpenApi · [E4] https://effect.website/docs/v4/api/effect/http-api/HttpApiSchema · [E5] https://effect.website/docs/v4/api/effect/http-api/HttpApiScalar · [E6] https://effect.website/docs/v4/api/effect/http-api/HttpApiSwagger · [E7] https://effect.website/docs/v4/api/effect/http-api/HttpApiSecurity · [E8] https://effect.website/docs/v4/api/effect/http-api/HttpApiError · [E9] https://effect.website/docs/v4/api/effect/http-api/HttpApiMiddleware · [E10] https://effect.website/docs/v4/api/effect/http/HttpServer · [E11] https://effect.website/docs/v4/api/effect/http/HttpRouter · [E12] https://effect.website/docs/v4/api/effect/http/HttpMiddleware · [E13] https://effect.website/docs/v4/api/effect/http/HttpServerRequest · [E14] https://effect.website/docs/v4/api/effect/http/HttpServerResponse · [E15] https://effect.website/docs/v4/api/effect/http/HttpIncomingMessage · [E16] https://effect.website/docs/v4/api/effect/encoding/Sse · [E17] https://effect.website/docs/v4/api/effect/socket/Socket · [E18] https://effect.website/docs/v4/api/effect/rpc/RpcServer · [E19] https://effect.website/docs/v4/api/effect/rpc/RpcSerialization · [E20] https://effect.website/docs/v4/api/effect/rpc/RpcMessage · [E21] https://effect.website/docs/v4/api/effect/persistence/RateLimiter · [E22] https://effect.website/docs/v4/api/platform-bun/BunHttpServer (index: https://effect.website/docs/v4/api) · [E24] https://raw.githubusercontent.com/Effect-TS/effect/main/MIGRATION.md · [E25] https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0

Effect sources (GitHub `main`, raw.githubusercontent.com/Effect-TS/effect/main/…): [G1] packages/platform/bun/src/BunHttpServer.ts · [G2] packages/effect/src/http-api/HttpApiBuilder.ts · [G3] packages/effect/src/http-api/OpenApi.ts · [G4] packages/effect/src/http-api/HttpApiSecurity.ts · [G5] packages/effect/src/rpc/RpcServer.ts · [G6] packages/effect/src/rpc/RpcSerialization.ts · [G7] packages/effect/src/rpc/RpcMessage.ts · [G8] packages/effect/src/encoding/Sse.ts · [G9] packages/effect/src/Schema.ts · [G10] ai-docs/src/51_http-server/10_basics.ts · [G11] packages/platform/node-shared/src/NodeRuntime.ts · [G12] packages/effect/src/http/HttpIncomingMessage.ts · [G13] packages/effect/src/http-api/HttpApiError.ts · [G14] packages/effect/src/http/HttpMiddleware.ts · [G15] packages/effect/src/persistence/RateLimiter.ts · [G16] packages/effect/src/http-api/HttpApiMiddleware.ts · [G17] ai-docs/src/51_http-server/20_testing.ts

npm tarballs via jsDelivr: [J1] https://cdn.jsdelivr.net/npm/@effect/platform-bun@4.0.0/dist/BunHttpServer.js · [J2] https://cdn.jsdelivr.net/npm/effect@4.0.0/ai-docs/src/51_http-server/fixtures/api/Authorization.ts · [J3] https://data.jsdelivr.com/v1/packages/npm/effect@4.0.0?structure=flat · [J-H7] https://cdn.jsdelivr.net/npm/@hey-api/openapi-ts@0.99.0/dist/clients/core/serverSentEvents.ts, …/dist/init-D6Y8JFUS.mjs, …/bin/run.js and https://data.jsdelivr.com/v1/packages/npm/@hey-api/openapi-ts@0.99.0?structure=flat

Bun: [B1] https://bun.com/docs/runtime/http/server · [B2] https://raw.githubusercontent.com/oven-sh/bun/bun-v1.4.2/packages/bun-types/serve.d.ts · [B3] https://bun.com/docs/runtime/http/websockets · [B4] https://bun.com/docs/runtime/child-process · [B5] https://bun.com/reference/bun/Spawn/BaseOptions/detached · [B6] https://github.com/oven-sh/bun/issues/44372 · [B7] https://bun.com/docs/runtime/web-apis · [B8] https://github.com/oven-sh/bun/issues/8474 · [B9] https://github.com/oven-sh/bun/issues/9758 · [B10] https://bun.com/docs/guides/http/cluster · [B12] https://cdn.jsdelivr.net/npm/bun-types@1.4.2/serve.d.ts · [B13] https://cdn.jsdelivr.net/npm/bun-types@1.4.2/bun.d.ts

Node.js: [N1] https://nodejs.org/docs/latest-v26.x/api/globals.html · [N2] https://nodejs.org/docs/latest-v26.x/api/cli.html · [N3] https://nodejs.org/docs/latest-v26.x/api/child_process.html · [N4] https://nodejs.org/docs/latest-v26.x/api/process.html · [N5] https://raw.githubusercontent.com/nodejs/node/v26.x/doc/api/fs.md (also https://nodejs.org/api/fs.html) · [N6] https://raw.githubusercontent.com/nodejs/undici/main/docs/docs/api/EventSource.md · [N7] https://raw.githubusercontent.com/nodejs/undici/main/docs/docs/api/WebSocket.md

POSIX and man pages: [P1] https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html · [P2] https://pubs.opengroup.org/onlinepubs/9799919799/functions/kill.html · [P3] https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html · [P4] https://man7.org/linux/man-pages/man2/rename.2.html

Web platform: [W1] https://html.spec.whatwg.org/multipage/server-sent-events.html · [W2] https://developer.mozilla.org/en-US/docs/Web/API/EventSource/EventSource · [W3] https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket

RFC / IANA: [R1] https://www.rfc-editor.org/rfc/rfc9457.html · [R2] https://www.iana.org/assignments/media-types/application/problem+json

Hey API: [H1] https://heyapi.dev/docs/openapi/typescript/get-started · [H2] https://heyapi.dev/docs/openapi/typescript/configuration · [H3] https://heyapi.dev/docs/openapi/typescript/clients/fetch · [H4] https://heyapi.dev/docs/openapi/typescript/migrating · [H5] https://api.github.com/repos/hey-api/hey-api/releases · [H6] https://raw.githubusercontent.com/hey-api/hey-api/main/packages/openapi-ts/src/plugins/@hey-api/client-core/bundle/serverSentEvents.ts · [H8] https://raw.githubusercontent.com/hey-api/hey-api/main/examples/openapi-ts-fetch/openapi-ts.config.ts and …/examples/openapi-ts-fetch/package.json · [H9] https://api.github.com/repos/hey-api/hey-api/git/trees/main?recursive=1

openapi-ts: [O1] https://openapi-ts.dev/introduction · [O2] https://raw.githubusercontent.com/openapi-ts/openapi-typescript/main/packages/openapi-typescript/README.md · [O3] https://raw.githubusercontent.com/openapi-ts/openapi-typescript/main/packages/openapi-typescript/package.json · [O4] https://openapi-ts.dev/openapi-fetch/ · [O5] https://openapi-ts.dev/openapi-fetch/api · [O6] https://raw.githubusercontent.com/openapi-ts/openapi-typescript/main/packages/openapi-fetch/README.md · [O7] https://github.com/openapi-ts/openapi-typescript/issues/2723 · [O8] https://github.com/openapi-ts/openapi-typescript/pull/2774 · [O9] https://bundlephobia.com/api/size?package=openapi-fetch@0.17.0 · [O10] https://cdn.jsdelivr.net/npm/openapi-typescript@7.13.0/dist/lib/ts.mjs and …/package.json

EventSource libraries: [V1] https://raw.githubusercontent.com/EventSource/eventsource/main/README.md · [V2] https://raw.githubusercontent.com/EventSource/eventsource/main/src/EventSource.ts · [V3] https://api.github.com/repos/EventSource/eventsource/releases · [V4] https://cdn.jsdelivr.net/npm/eventsource@5.1.2/package.json and …/src/types.ts · [V5] https://raw.githubusercontent.com/rexxars/eventsource-parser/main/README.md · [V6] https://cdn.jsdelivr.net/npm/eventsource-parser@4.1.1/dist/types.d.ts, …/dist/stream.d.ts, …/package.json · [V7] https://github.com/Azure/fetch-event-source · [V8] https://api.github.com/repos/Azure/fetch-event-source/commits

TypeScript: [T1] https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ · [T2] https://github.com/microsoft/TypeScript/releases/tag/v7.0.2

Registry and releases: [npm] `npm view <pkg> version dist-tags time engines peerDependencies dependencies deprecated --json` at 2026-10-03T22:55Z and 23:22Z · [GR] `https://api.github.com/repos/<repo>/releases/tags/<tag>` for `Effect-TS/effect` (`effect@4.0.0`, `@effect/platform-bun@4.0.0`, `@effect/sql-sqlite-bun@4.0.0`, `@effect/sql-sqlite-node@4.0.0`, `@effect/vitest@4.0.0`, `@effect/sql@0.52.1`), `oven-sh/bun` (`bun-v1.4.2`), `microsoft/TypeScript` (`v7.0.2`), `vitest-dev/vitest` (`v5.0.3`), `openapi-ts/openapi-typescript` (`openapi-typescript@7.13.0`, `openapi-fetch@0.17.0`), `rexxars/eventsource-parser` (`v4.1.1`), `unjs/citty` (`v0.2.2`), `bombshell-dev/clack` (`@clack/prompts@1.8.1`).
