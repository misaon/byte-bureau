# 15 — SP1 Phase A stack: verified fact sheet (Effect 4 kernel on Bun)

Date: **2026-10-02** (checks ran 21:15–21:50 UTC). Method: npm registry (`npm view <pkg> version dist-tags time --json`), installs into a scratch directory (hoisted layout **and** a Bun isolated-linker workspace, which is what the repo uses), `exports` maps and `.d.ts` read from the installed packages, official docs via WebFetch, GitHub raw/API for git and Drizzle history, and **executed probes** on Bun 1.4.2, Node 24.14.0, TypeScript 7.0.2 (repo strict flags), Vitest 5.0.3, git 2.54.0 (macOS arm64). Nothing is from memory; anything not checked says **unverified** (list at the end).

Evidence keys: `[run]` executed (runtime named); `[tsc]` type-checked with NodeNext, `verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `noUncheckedIndexedAccess`; `pkg:path` = file inside `<S>/node_modules/pkg/`; `probe:x` = `<S>/probe/x`; `[Un]` = URL in Sources; `[npm]` = registry. `<S>` = `/private/tmp/claude-501/-Users-ondrejmisak-WebstormProjects-byte-bureau/4333fb47-536a-4210-9d32-f735d7b219e0/scratchpad/sp1-research` (session scratch, may vanish; the snippets below are the durable form).

## 0. Read first: blockers, surprises, corrections

1. **`bunfig.toml` blocks Effect 4.0.0 until 2026-10-04.** The repo sets `minimumReleaseAge = 259200` (3 days). `effect@4.0.0` was published 2026-10-01T03:11:28Z, every `@effect/*` 4.0.0 at 01:47–01:48Z [npm]. With that exact bunfig [run]: `bun add effect@latest` silently installs **`effect@3.22.2`**, `@effect/vitest@latest` gives `0.30.0`, and `bun add effect@4.0.0` fails with `No version matching "effect" found for specifier "4.0.0" (blocked by minimum-release-age: 259200 seconds)`. `minimumReleaseAgeExcludes` [U1] works for **exact package names only**: `"@effect/*"` is not honoured and the transitive `@effect/platform-node-shared` must be listed too [run]. Natural unblock: 2026-10-04T03:12Z.
2. **`isolatedDeclarations` rejects class-based Effect APIs.** `class X extends Context.Service<X, S>()("id")`, `Data.TaggedError("T")<{…}>`, `Schema.TaggedError<X>()("T", {…})`, `Schema.Class<X>("X")({…})` all give `TS9021 Extends clause can't contain an expression with --isolatedDeclarations` [tsc 7.0.2; probe-lib/iso-bad.txt]. Compiles: function-style `Context.Service<Id, Shape>("key")` with an explicit annotation, explicit `Layer.Layer<…>` types, annotated `Schema.Struct<…>` consts [tsc; probe-lib/iso-ok.ts]. `packages/kernel|api|protocol` need the `app.json`-style tsconfig (no `isolatedDeclarations`) or that annotated style.
3. **Drizzle `1.0.0-rc.4` Effect drivers do not load against Effect 4.0.0** (`Schema.TaggedErrorClass is not a function`; they import `effect/unstable/sql/SqlError`, a path that no longer exists) [run]. Its sync drivers `bun-sqlite` and `node-sqlite` work. Only the unlisted build `1.0.0-rc.5-5935859` (npm tag `rc5`, no GitHub release) loads the Effect drivers [run]. See §4 and §9.
4. **`@effect/sql-sqlite-node@4.0.0` is built on `node:sqlite`, not better-sqlite3** (no native dependency) [`@effect/sql-sqlite-node:dist/SqliteClient.js`]. `@effect/platform-node@4.0.0` has a **non-optional peer `redis >=5.0.0 <7.0.0`**.
5. **c12 has no stable 4.x**: npm `latest` is `4.0.0-rc.2`; the stable line is tag `3x` = `3.3.4` [npm].
6. **Bun-only modules cannot be imported under Node/Vitest**: `bun:sqlite`, `@effect/sql-sqlite-bun`, `drizzle-orm/bun-sqlite` fail with `Only URLs with a scheme in: file, data, and node are supported … Received protocol 'bun:'`; `Bun.*` is undefined [run, Node 24.14]. `@effect/platform-bun` itself imports fine under Node.
7. **Vitest runs on Node.** `bun run <script>` and `bunx vitest` execute Node (vitest's bin has a node shebang). `bun --bun vitest run` did execute tests inside Bun in my probe but is undocumented (§10).
8. **LogTape bridge records must follow LogTape's message contract**, otherwise `redactByField` throws (`'char of path'`) and the sink error is swallowed unless `["logtape","meta"]` has a sink (§6). Effect's `MinimumLogLevel` defaults to `Info`, so `Effect.logDebug` never reaches a bridged logger unless raised (§1.7).
9. **Corrections to earlier reports.** (a) Report 11 lists `./schema` among the `effect` exports; that lowercase group only holds `Model`, `SchemaAOTCompiler`, `SchemaCompiler`, `SchemaJITCompiler`, `VariantSchema` [effect:dist/schema/index.d.ts]; `Schema` itself is `effect/Schema` (or `import { Schema } from 'effect'`). (b) `effect@4.0.0` reached npm on **2026-10-01**; the announcement is dated 2026-09-30 [npm; U2]. (c) `@effect/sql` (`0.52.1`, 2026-07-30) is the v3-era package; the v4 SQL core is `effect/sql` [npm; U4]. (d) Reports 10/11 numbers still hold: drizzle `latest` 0.45.3 / `rc` 1.0.0-rc.4 / kit 0.31.11, c12 `4.0.0-rc.2`, LogTape 2.3.10 [npm].

## Version table (exact; `npm view` 2026-10-02 ~21:40 UTC; age in days)

| Package | Version (dist-tag) | Published (UTC) | Age | Notes |
|---|---|---|---|---|
| effect | 4.0.0 (`latest`) | 2026-10-01T03:11:28.537Z | 1.7 | `rc` 4.0.0-rc.118 (2026-09-28), `beta` 4.0.0-beta.107 (2026-08-10), `snapshot` 0.0.0-snapshot-6ebc752b… |
| @effect/vitest | 4.0.0 | 2026-10-01T01:47:59.713Z | 1.8 | peers `effect ^4.0.0`, `vitest >=5.0.0 <6.0.0` |
| @effect/platform-bun | 4.0.0 | 2026-10-01T01:47:44.402Z | 1.8 | peer `effect ^4.0.0`; dep `@effect/platform-node-shared ^4.0.0` |
| @effect/platform-node | 4.0.0 | 2026-10-01T01:48:35.463Z | 1.8 | peers `effect ^4.0.0`, `redis >=5.0.0 <7.0.0`; deps `undici ^8.11.2` |
| @effect/platform-node-shared | 4.0.0 | 2026-10-01T01:47:33.378Z | 1.8 | deps `ws ^8.22.0`, `@types/ws ^8.18.1` |
| @effect/sql-sqlite-bun / -node | 4.0.0 | 2026-10-01T01:47:55Z / 01:47:35Z | 1.8 | peer `effect ^4.0.0` each |
| drizzle-orm | 0.45.3 (`latest`) | 2026-09-21T10:06:39.969Z | 11.4 | `rc` 1.0.0-rc.4 (2026-06-27T16:10:10.709Z), `beta` 1.0.0-beta.22, tag `rc5` 1.0.0-rc.5-5935859 (2026-09-09T10:25:53.776Z) |
| drizzle-kit | 0.31.11 (`latest`) | 2026-09-21T10:06:58.727Z | 11.4 | `rc` 1.0.0-rc.4 (2026-06-27), tag `rc5` 1.0.0-rc.5-5935859 |
| c12 | 4.0.0-rc.2 (`latest`) | 2026-09-22T23:44:24.160Z | 9.9 | `3x` 3.3.4 (2026-04-01T18:54:44.238Z) |
| @logtape/logtape, /file, /redaction | 2.3.10 (`latest`) | 2026-09-29T10:10–10:16Z | 3.4 | `dev` 2.4.0-dev.947 |
| @standard-schema/spec | 1.1.0 | 2025-12-15T20:49:46.431Z | 291 | types only |
| fast-check | 4.10.2 | 2026-09-19T19:34:54.991Z | 13 | |
| yaml / jsonc-parser | 2.9.1 / 3.3.1 | 2026-09-11 / 2024-06-24 | 21 / 830 | `next` tags 3.0.0-2 / 4.0.0-next.2 |
| confbox | 0.3.1 | 2026-09-03T10:25:54.777Z | 29 | c12's parser library |
| uuid | 14.0.2 | 2026-08-18T18:21:56.060Z | 45 | exports `v7` |
| bun-types / @types/bun | 1.4.2 / 1.4.2 | 2026-09-05 / 2026-09-08 | 28 / 25 | bun-types canary 1.4.3-canary.20261002T141526 |
| typescript / vitest | 7.0.2 / 5.0.3 | 2026-07-08 / 2026-09-30T11:30:42Z | 86 / 2.4 | vitest `engines.node` `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` |

## 1. Effect 4

### 1.1 Version, tags, layout
- `effect@4.0.0` is `latest` (not `next`); `rc`/`beta` are older (table) [npm]. Zero `dependencies`/`peerDependencies`, MIT, `type: module`, no `engines` [effect:package.json]. Release notes: TypeScript ≥ 5.9 (7 recommended), `@effect/sql-sqlite-node` needs Node ≥ 22.16, `@effect/vitest` needs Vitest 5 [U3] (the TypeScript and Node minimums have no second source; the Vitest 5 requirement matches the npm peer range). LTS: bug fixes until Sep 2029 or one year after 5.0 ships, security fixes until Sep 2029 or two years after 5.0 ships, whichever is later in each case [U2].
- `exports`: `"./*": "./dist/*.js"` (every top-level module is `effect/<Module>`, `.d.ts` beside the `.js`, no `types` condition) plus group barrels `./ai ./cli ./cluster ./devtools ./encoding ./eventlog ./http ./http-api ./net ./observability ./persistence ./process ./reactivity ./rpc ./schema ./socket ./sql ./testing ./workers ./workflow`; `./internal/*` is `null` [effect:package.json]. `import { Effect } from 'effect'` and `import * as Effect from 'effect/Effect'` are the same object [run].
- The tarball ships authoritative examples: `effect:AGENTS.md` and `effect:ai-docs/src/**` (services, layers, tests, SQL, HttpApi).
- `@stability unstable` tags exist in `effect/sql/*`, `effect/process/*` (module-level on `ChildProcessSpawner`), `effect/rpc/*`, `effect/http-api/*`, `effect/workflow/*`, `effect/observability/Otlp*`, `effect/http/HttpServer`; **none** in Effect, Layer, Context, Stream, Queue, PubSub, Logger, Config, Tracer, ManagedRuntime, TestClock, FileSystem [grep of d.ts].

### 1.2 Import map (all specifiers type-check under NodeNext and resolve on Bun and Node [tsc][run; probe:effect-imports.ts])
| Need | Import | Verified exports / notes |
|---|---|---|
| Effect | `effect/Effect` | `gen, fn, fnUntraced, runPromise, runPromiseExit, runFork, runSync, provide, withSpan, currentSpan, tryPromise, forkChild, forkScoped, catch, catchTag, retry, timeout, acquireRelease, scoped, result` |
| Layer | `effect/Layer` | `succeed, effect, effectDiscard, unwrap, mergeAll, provide, provideMerge, fresh, launch, mock`; no `Layer.scoped` (`Layer.effect` already removes `Scope` from R) |
| Services | `effect/Context` | `Context.Service`, `Context.Reference`; **no** `Context.Tag`, `Effect.Service`, `Effect.Tag`, `ServiceMap` |
| Schema | `effect/Schema` | `Struct, Class, TaggedError, TaggedStruct, Literals, optionalKey, decodeUnknownSync, decodeUnknownEffect, toJsonSchemaDocument, toStandardSchemaV1, toStandardJSONSchemaV1, toCodecJson` |
| JSON Schema | `effect/JsonSchema` | renamed from `JSONSchema`; `META_SCHEMA_URI_DRAFT_2020_12`, `Document`; no `JsonSchema.make` |
| Standard Schema | `effect/StandardSchema` | types only, vendored from `@standard-schema/spec` 1.1.0 |
| Stream | `effect/Stream` | `fromAsyncIterable(iterable, onError)`, `toAsyncIterable`, `toAsyncIterableEffect`, `fromPubSub`, `fromQueue`, `runCollect`, `runForEach` |
| Queue, PubSub | `effect/Queue`, `effect/PubSub` | `bounded, sliding, dropping, unbounded`; `PubSub.subscribe` returns a `Subscription` read with `PubSub.take/takeAll` |
| Ref, Scope, Fiber, Clock | `effect/Ref`, `Scope`, `Fiber`, `Clock` | `Fiber.join`, `Fiber.await(fiber)` (no `fiber.await` property); `Clock.currentTimeMillis` |
| TestClock | `effect/testing` (`TestClock`) or `effect/testing/TestClock` | `layer(), adjust, setTime, withLive`; moved from `effect/TestClock` [U4] |
| Logger | `effect/Logger`, `effect/References`, `effect/LogLevel` | `Logger.make, layer, consoleJson, formatStructured, toFile`; `References.CurrentLogAnnotations, MinimumLogLevel` |
| Tracer, spans | `effect/Tracer`; `Effect.withSpan`; `effect/http/HttpTraceContext` | OTLP: `effect/observability` → `Otlp.layer({ baseUrl, resource, headers })` |
| Errors | `Data.TaggedError("T")<{…}>`; `Schema.TaggedError<Self>()("T", fields)` | `Effect.runPromise` rejects with the original instance (`instanceof`, `_tag` kept) [run] |
| Config | `effect/Config`, `effect/ConfigProvider` | `Config.String/Port/LogLevel/Redacted/withDefault`; `ConfigProvider.layer(ConfigProvider.fromEnvRecord({…}))` |
| SQL | `effect/sql` | `SqlClient, Migrator, SqlModel, SqlSchema, SqlResolver, SqlError, Statement` |
| Child processes | `effect/process` | `ChildProcess.make(cmd, args, { cwd, env, extendEnv, detached })`, `ChildProcessSpawner.ChildProcessSpawner` (`string`, `lines`, `spawn`) |
| Promise bridge | `effect/ManagedRuntime` | `ManagedRuntime.make(layer)` → `runPromise`, `dispose` |
| Present, not exercised | `effect/http-api` (`OpenApi.fromApi`), `effect/rpc` (`RpcServer.layerHttp`, `layerProtocolWebsocket`), `effect/workflow`, `effect/cluster`, `effect/socket` | |

### 1.3 Renames confirmed (docs [U4] plus absence in `effect:dist/*.d.ts`)
`Context.Tag`/`GenericTag`/`Effect.Tag`/`Effect.Service` → `Context.Service`; `catchAll` → `catch`; `catchAllCause` → `catchCause`; `catchSome` → `catchFilter`; `fork` → `forkChild`; `forkDaemon` → `forkDetach`; `effect/Either` → `effect/Result` (`Effect.either` is gone, `Effect.result` exists — from d.ts); `effect/JSONSchema` → `effect/JsonSchema`; `Schema.standardSchemaV1` is gone (use `toStandardSchemaV1`); `effect/TestClock` → `effect/testing`; unstable modules drop the path segment (`effect/unstable/http` → `effect/http`). `@effect/platform`, `rpc`, `cluster`, `workflow`, `sql`, `cli`, `ai` merged into `effect`; `@effect/platform-*`, `@effect/sql-*`, `@effect/ai-*`, `@effect/opentelemetry`, `@effect/vitest` stay separate. Layers share one memo map across `Effect.provide` calls (`{ local: true }` or `Layer.fresh` opt out) [U4].

### 1.4 Services and layers (v4 syntax) [tsc][run] probe:effect-core.ts, effect-patterns.ts
```ts
import { Clock, Context, Data, Effect, Layer, Schema } from 'effect'

export class Clocked extends Context.Service<Clocked, { readonly now: Effect.Effect<number> }>()('bb/Clocked') {
  static readonly layer = Layer.succeed(Clocked, Clocked.of({ now: Clock.currentTimeMillis }))
}
export class Greeter extends Context.Service<Greeter, { greet(name: string): Effect.Effect<string> }>()('bb/Greeter') {
  static readonly layer = Layer.effect(
    Greeter,
    Effect.gen(function* () {
      const clocked = yield* Clocked // dependency shows up as R of the layer
      return Greeter.of({ greet: (name) => Effect.map(clocked.now, (t) => `hello ${name} @${String(t)}`) })
    }),
  )
}
export class NotFound extends Data.TaggedError('NotFound')<{ readonly id: string }> {}
export class Invalid extends Schema.TaggedError<Invalid>()('Invalid', { reason: Schema.String }) {}

const MainLive = Greeter.layer.pipe(Layer.provideMerge(Clocked.layer)) // Greeter | Clocked
const GreeterOnly = Greeter.layer.pipe(Layer.provide(Clocked.layer)) //   Greeter only
const All = Layer.mergeAll(Clocked.layer, GreeterOnly)
// terse form (migration/services.md): Context.Service<Counter>()('bb/Counter', { make: Effect.gen(…) })
//   with `static readonly layer = Layer.effect(this, this.make)`; traced methods: Effect.fn('Counter.next')(function* (…) {…})
```

### 1.5 Promise and AsyncIterable boundary [run Bun 1.4.2] probe:promise-boundary.ts, effect-runtime.ts
```ts
const value = await Effect.runPromise(program.pipe(Effect.provide(MainLive)))     // typed failures reject with the original TaggedError
const rt = ManagedRuntime.make(MainLive)                                          // for non-Effect callers (API handlers, plugin host)
await rt.runPromise(Greeter.use((g) => g.greet('x'))); await rt.dispose()
// plugin Promise -> Effect: `signal` aborts when the fiber is interrupted; Effect.timeout('30 millis') fails with TimeoutError
const call = Effect.tryPromise({ try: (signal) => plugin.run(signal), catch: (cause) => new PluginError({ cause }) })
// AsyncIterable <-> Stream; `break` in the consumer loop runs the source generator's `finally`
const events = Stream.fromAsyncIterable(plugin.events(), (e) => new PluginError({ cause: e })).pipe(Stream.map(toCanonical))
for await (const e of Stream.toAsyncIterable(events)) { /* … */ }
// fan-out with drop-oldest per subscriber: PubSub.sliding(2), publish 1..4 → subscriber reads 3 then [4] (PubSub.take/takeAll)
// retry: Effect.retry({ schedule: Schedule.exponential('100 millis').pipe(Schedule.jittered), times: 5 })   (Schedule.both does not exist)
```

### 1.6 Schema, JSON Schema, Standard Schema, strict config decode [tsc][run] probe:schema-config.ts
```ts
const ProjectConfigV1 = Schema.Struct({
  version: Schema.Literal(1),
  project: Schema.Struct({ name: Schema.NonEmptyString, defaultBranch: Schema.optionalKey(Schema.String) }),
  logging: Schema.optionalKey(Schema.Struct({ level: Schema.Literals(['trace', 'debug', 'info', 'warn', 'error']) })),
}).annotate({ title: 'ByteBureau project config' })                     // optionalKey = exactOptionalPropertyTypes-friendly
const doc = Schema.toJsonSchemaDocument(ProjectConfigV1, { onExcessProperty: 'error' }) // doc.dialect 'draft-2020-12', additionalProperties:false
const file = { $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12, ...doc.schema, $defs: doc.definitions }
Schema.decodeUnknownSync(ProjectConfigV1)(input, { onExcessProperty: 'error', errors: 'all' }) // message lists every issue with its path
const std = Schema.toStandardSchemaV1(ProjectConfigV1, { parseOptions: { onExcessProperty: 'error', errors: 'all' } })
const res = await std['~standard'].validate(input) // { issues: [{ message, path: ['logging','level'] }] } → JSON pointer '/logging/level'
```
`Schema.Literal(1)` renders as `{"type":"number","enum":[1]}`; default `onExcessProperty` is `ignore` (JSON Schema then says `additionalProperties: true`).

### 1.7 Logger, tracer, clock, processes [run]
- `References.MinimumLogLevel` defaults to `"Info"`: `Effect.logDebug` is dropped before any custom logger unless `Layer.succeed(References.MinimumLogLevel, 'Debug')` is provided. `Logger.layer([bridge])` replaces the default logger unless `{ mergeWithExisting: true }`. A logger receives `{ message, logLevel, cause, fiber, date }`; annotations come from `fiber.getRef(References.CurrentLogAnnotations)` [effect:dist/Logger.d.ts, Logger.js].
- TRACEPARENT for children: `HttpTraceContext.toHeaders(yield* Effect.currentSpan)` then `Headers.get(h, 'traceparent')` → `00-<32 hex>-<16 hex>-01` [probe:traceparent.ts].
- `ChildProcess` `env` **replaces** the environment unless `extendEnv: true` (fits the spec's allowlist); `KillOptions.killSignal` defaults to `SIGTERM`, `forceKillAfter` defaults to undefined (no SIGKILL escalation, the SIGINT→SIGTERM→SIGKILL ladder is ours to write); scope exit terminated the child; `handle.all` merges stdout/stderr without ordering (`one,three,two`) [effect:dist/process/ChildProcess.d.ts; probe:platform-bun.ts].
- Tests: TestClock starts at 0; plain pattern in §2. Type-check cost of all 25 probe files (575 files incl. lib d.ts) under `tsc` 7.0.2: about 0.15 s wall, 152 MB.

## 2. Testing with Vitest [run Node 24.14.0, Vitest 5.0.3; also under the isolated linker]
- `@effect/vitest@4.0.0` exists for Effect 4; peers `effect ^4.0.0`, `vitest >=5.0.0 <6.0.0`; README: Vitest 5 supports Node `^22.12.0 || ^24.0.0 || >=26.0.0` and Vite 6.4+ (6/7/8) [@effect/vitest:README.md]. It re-exports all of `vitest`.
- Provides `it.effect` (scoped; TestClock + TestConsole; logs suppressed), `it.live` (real services), `layer(L)('name', (it) => …)` / `it.layer` (one shared layer per block, torn down in `afterAll`), `it.prop` (Schema/Arbitrary property tests, docs only), `it.flakyTest`, `it.effect.each/skip/only/fails`, `assert`, `addEqualityTesters`, `makeMethods` [@effect/vitest:dist/index.d.ts].
```ts
import { assert, it, layer } from '@effect/vitest'
import { Clock, Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'

it.effect('sleep completes when the TestClock advances', () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.sleep('1 hour').pipe(Effect.as('woke')))
    yield* TestClock.adjust('1 hour')
    assert.strictEqual(yield* Fiber.join(fiber), 'woke')
  }))
layer(MainLive)('shared layer', (it) => { it.effect('reads the service', () => Effect.gen(function* () { /* yield* Greeter */ })) })
// plain pattern without @effect/vitest (also verified):
//   await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())))   // Clock.currentTimeMillis === 0 until adjust()
```

## 3. Bun platform and SQL for Effect 4
| Package | Facts |
|---|---|
| `@effect/platform-bun` 4.0.0 | `BunRuntime.runMain(effect, { disableErrorReporting?, teardown? })`; `BunServices.layer: Layer<ChildProcessSpawner \| Crypto \| FileSystem \| Path \| Terminal \| Stdio>`; also `BunHttpServer`, `BunFileSystem`, `BunChildProcessSpawner` (re-export of the node-shared spawner), `BunStdio`, `BunSocket`, `BunWorker` [@effect/platform-bun:dist/index.d.ts]. [run] `git --version` via `spawner.string`, `spawner.lines`, scoped `spawner.spawn`, child killed on scope close. |
| `@effect/sql-sqlite-bun` 4.0.0 | `SqliteClient.layer(config)` / `layerConfig` / `make`; `SqliteMigrator.layer/run` + everything from `effect/sql/Migrator`. Config `{ filename, readonly?, create?, readwrite?, disableWAL?, busyTimeout?, spanAttributes?, transformResultNames?, transformQueryNames? }`. Static `import 'bun:sqlite'`. Sets `PRAGMA busy_timeout` (default 5 s) and `PRAGMA journal_mode = WAL` (unless `disableWAL`); **no** `foreign_keys`/`synchronous` pragma (run them yourself); one connection behind `Semaphore(1)`; transactions `BEGIN IMMEDIATE`; `executeStream` is `Stream.die("executeStream not implemented")`; has `export` (serialize) and `loadExtension` [`@effect/sql-sqlite-bun:dist/SqliteClient.{d.ts,js}`]. |
| `@effect/sql-sqlite-node` 4.0.0 | same API on `node:sqlite` `DatabaseSync` (`prepareCacheSize`, `prepareCacheTTL`, `backup`); requires Node ≥ 22.16 [U3]; prints Node's `ExperimentalWarning` on 22/24 [run]. |
| `@effect/sql` 0.52.1 | v3-era; **do not use** with Effect 4 (core is `effect/sql`). |

One program, two drivers [run Bun 1.4.2 and Node 24.14.0, identical output; probe:sql-common.ts, sql-bun.ts, sql-node.ts]:
```ts
const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient                    // import { SqlClient } from 'effect/sql'
  yield* sql`PRAGMA foreign_keys = ON`
  yield* sql`CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL)`
  yield* sql.withTransaction(sql`INSERT INTO events (type) VALUES (${'a.created'})`)
  return yield* sql<{ readonly seq: number; readonly type: string }>`SELECT seq, type FROM events`
})
// Bun:  Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(SqliteClient.layer({ filename: ':memory:' })))) with SqliteClient from '@effect/sql-sqlite-bun'
// Node: identical with '@effect/sql-sqlite-node'
```

**Fallback `bun:sqlite` wrapped in a service** (needed only if `effect/sql` is not wanted). `bun-types@1.4.2` `sqlite.d.ts` declares `Database(filename?, options?: number | { readonly?, create?, readwrite?, safeIntegers?, strict? })`, `query<R, P>(sql)` (cached), `prepare<R, P>(sql)`, `run(sql, ...bindings): Changes`, `exec` (alias), `transaction(fn)` with `.deferred/.immediate/.exclusive`, `close(throwOnError?)`, `serialize`, `static deserialize`, `loadExtension`, `fileControl`, `inTransaction`, `[Symbol.dispose]`; `Statement.all/get/run/values/iterate/as/finalize/toString` (no `safeIntegers()` typing; the Effect driver uses `@ts-ignore`) [U7; bun-types:sqlite.d.ts]. WAL: `db.run('PRAGMA journal_mode = WAL;')` [U7]. [run, strict tsc] probe:bun-sqlite.ts: file DB reports `journal_mode: wal`; `transaction(…)` and `.immediate(…)` work; a nested `db.transaction` that throws rolls back to its savepoint while the outer commits; `prepare(…RETURNING seq).get(…)` works; `db.run` returns `{ changes, lastInsertRowid }`. `bun:sqlite` on macOS links Apple's SQLite without extension loading (`Database.setCustomSQLite(path)` is the documented fix) [U7].

## 4. Drizzle ORM
| | `drizzle-orm@0.45.3` / `drizzle-kit@0.31.11` (`latest`) | `drizzle-orm@1.0.0-rc.4` / `drizzle-kit@1.0.0-rc.4` (`rc`) |
|---|---|---|
| bun:sqlite driver | `drizzle-orm/bun-sqlite` (+ `/migrator`) | same; `drizzle({ client })` [U9 shows `@rc` as the default install] |
| node:sqlite driver | **none** (`drizzle-orm/node-sqlite` → `ERR_PACKAGE_PATH_NOT_EXPORTED`) | `drizzle-orm/node-sqlite` (+ `/migrator`), `drizzle({ client: new DatabaseSync(…) })` |
| Effect drivers | none | `effect-sqlite-bun`, `effect-sqlite-node`, `effect-core`… exist but **fail with effect 4.0.0**; peers claim `effect >=4.0.0-beta.83 \|\| >=4.0.0`; GitHub notes say built for `4.0.0-beta.83` [U10] |
| migrations on disk | `drizzle/0000_name.sql`, `meta/_journal.json`, `meta/0000_snapshot.json` | `drizzle/<UTC yyyymmddhhmmss>_<name>/migration.sql` + `snapshot.json`; the old layout makes `readMigrationFiles` throw ("run drizzle-kit up") |
| tracking table | `__drizzle_migrations(id, hash, created_at)` | `(id, hash, created_at, name, applied_at)`, applied-or-not decided by `name` |
| embedded (no fs) | none official; `readMigrationFiles` + `db.dialect.migrate(metas, db.session, cfg)` works [run] | `migrate(db, { migrationsJournal: [{ sql, timestamp, name }], migrationsTable? })` — **bun-sqlite migrator only**; `node-sqlite` takes `migrationsFolder` only |
| status | GA stable; newest release 21 Sep | **pre-release**: newest GitHub release v1.0.0-rc.4 (27 Jun) [U10]; `1.0.0-rc.5-5935859` exists only as npm tag `rc5` (2026-09-09) |

Schema and kit config (identical in both lines; generated and applied [run]):
```ts
// src/schema.ts
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(), name: text('name').notNull(), path: text('path').notNull().unique(),
  defaultBranch: text('default_branch').notNull().default('main'),
  configJson: text('config_json', { mode: 'json' }).$type<Record<string, unknown>>(), createdAt: text('created_at').notNull(),
})
export const events = sqliteTable('events', {
  seq: integer('seq').primaryKey({ autoIncrement: true }), id: text('id').notNull(), type: text('type').notNull(),
  projectId: text('project_id').references(() => projects.id), sessionId: text('session_id'),
  payloadJson: text('payload_json', { mode: 'json' }).notNull().$type<unknown>(),
}, (t) => [index('events_session_seq').on(t.sessionId, t.seq), index('events_project_seq').on(t.projectId, t.seq)])
// drizzle.config.ts  (works in 0.31.11 and 1.0.0-rc.4; `bunx drizzle-kit generate --name init`)
import { defineConfig } from 'drizzle-kit'
export default defineConfig({ dialect: 'sqlite', schema: './src/schema.ts', out: './drizzle' })
```
Runtime migrations, `1.0.0-rc.4`, same schema and same `./drizzle` folder on both runtimes, identical `__drizzle_migrations` row and hash [run; `drizzle-kit generate` and both migrators also ran inside the isolated-linker workspace]:
```ts
// Bun (prod)                                                   // Node 24 / Vitest (tests)
import { Database } from 'bun:sqlite'                           import { DatabaseSync } from 'node:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'                import { drizzle } from 'drizzle-orm/node-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'       import { migrate } from 'drizzle-orm/node-sqlite/migrator'
const db = drizzle({ client: new Database(':memory:') })        const db = drizzle({ client: new DatabaseSync(':memory:') })
migrate(db, { migrationsFolder: './drizzle' })                  migrate(db, { migrationsFolder: './drizzle' })
```
A shared parameter type accepts both drivers: `import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'` → `type Db = SQLiteAsyncDatabase<'sync', any, any>` [tsc strict]. Queries are sync (`.all() .get() .run()`) and thenable [U9].

**Compiled Bun binary** (`bun build --compile`, 62 MB, Bun 1.4.2 darwin-arm64) [run]: `migrate(db, { migrationsFolder: './drizzle' })` fails (`ENOENT: no such file or directory, scandir './drizzle'`) because the migrator reads the disk with `node:fs`; the embedded form works with no files present: `import initSql from './drizzle/<ts>_init/migration.sql' with { type: 'text' }` then `migrate(db, { migrationsJournal: [{ sql: initSql, timestamp: Date.UTC(2026, 9, 2, 21, 25, 39), name: '20261002212539_init' }] })`. `bun-types` does not declare `*.sql`: add `declare module '*.sql' { const sql: string; export default sql }` (TS2307 otherwise) [tsc]. Implication: ship migrations as embedded text (generate a module from `drizzle/*/migration.sql` at build time) or beside the binary; the folder form is only for Node tests.

## 5. c12 `4.0.0-rc.2` (`latest`; no stable 4.x; stable `3.3.4`)
- Deps `confbox ^0.3.1, defu ^6.1.7, exsolve ^1.1.1, pathe ^2.0.3, pkg-types ^2.3.3, rc9 ^3.1.0`; optional peers `dotenv`, `giget >=3.1.0`, `jiti`, `magicast`; `exports` `.` and `./update`; no `engines` [c12:package.json]. README: install ~380 kB (from 3.44 MB) [U11].
- `loadConfig<T, MT>(options: LoadConfigOptions<T, MT>): Promise<ResolvedConfig<T, MT>>` [c12:dist/index.d.mts]. Options: `name, cwd, configFile, rcFile (false | string), globalRc, dotenv, envName (default process.env.NODE_ENV; false disables), packageJson, defaults, defaultConfig, overrides, omit$Keys, context, resolve, import, resolveModule, jitiOptions, giget, merger (default defu), envMerger, extend (false | { extendKey }), configFileRequired, schema (Standard Schema)`. Result `{ config, configFile, cwd, source, sourceOptions, meta, layers? }`; `layers` = each merged `ConfigLayer { config, source?, configFile?, cwd? }`. Also `watchConfig`, `createDefineConfig`, `loadDotenv`, `setupDotenv`.
- **JSON and JSONC work out of the box**: extensions `.js .ts .mjs .cjs .mts .cts .json .jsonc .json5 .yaml .yml .toml` via confbox (`parseJSONC` with `allowTrailingComma`); TypeScript configs need `jiti` (optional) [c12:dist/index.mjs]. Default `configFile` is `<name>.config`, so pass `configFile: 'bytebureau'` to find `bytebureau.jsonc`/`.json`.
- Precedence (official): overrides > config file in cwd > rc in cwd > workspace rc > user-dir rc > legacy home rc > `package.json` > `defaults` > extended layers [U11]. **`extends` is the lowest layer, so it cannot express "local overrides project"**; verified.
- **Arrays are concatenated** by the default `defu` merger (project `[".env"]` + override `[".env.local"]` → `[".env.local", ".env"]`); pass `merger` for replace semantics [run].
- `schema` takes any Standard Schema; the validated output replaces `config`; failure text: `Config validation failed (effect):\n  - logging.level: Expected "debug" | …` [run; probe:c12.ts].
```ts
// [tsc][run Bun + Node] spec §10 precedence user < project < local, Effect Schema as validator (c12 + Effect Schema also ran inside a compiled binary)
const base = { name: 'bytebureau', rcFile: false, globalRc: false, dotenv: false, packageJson: false, envName: false } as const
const user = (await loadConfig({ ...base, cwd: userDir, configFile: 'config' })).config            // ~/.bytebureau/config.json
const local = (await loadConfig({ ...base, cwd: projectDir, configFile: 'bytebureau.local' })).config // gitignored overlay
const project = await loadConfig({ ...base, cwd: projectDir, configFile: 'bytebureau', defaults: user, overrides: local,
  schema: Schema.toStandardSchemaV1(ProjectConfigV1, { parseOptions: { onExcessProperty: 'error', errors: 'all' } }) })
// project.config = user < bytebureau.jsonc < local (env/CLI overrides would be merged into `overrides` the same way); project.layers = [inline, file]
```
Comment-preserving edits (e.g. `plugins add`): `confbox/jsonc` `stringifyJSONC` drops comments, `jsonc-parser` `modify(text, ['plugins', 0], value, { formattingOptions })` + `applyEdits` keeps them [run; probe:jsonc.ts]. `yaml` is not needed (c12 reads YAML through `confbox/yaml`).

## 6. LogTape `2.3.10`
- Separate packages: core `@logtape/logtape` (zero deps), `@logtape/file`, `@logtape/redaction` (peer `@logtape/logtape ^2.3.10`), plus `@logtape/otel`, `@logtape/sentry`, `@logtape/syslog`, `@logtape/cloudwatch-logs`, `@logtape/windows-eventlog` [U12; npm]. Dual ESM/CJS; `@logtape/file` maps `#filesink` to `filesink.node.js` for the `bun` condition [@logtape/file:package.json].
- Core exports [@logtape/logtape:dist/mod.d.ts]: `configure, configureSync, dispose, disposeSync, reset, getConfig, withConfig, getLogger, getConsoleSink, getStreamSink, fromAsyncSink, fingersCrossed, withFilter, getLevelFilter, getThrottlingFilter, withContext, withCategoryPrefix, lazy, jsonLinesFormatter, getJsonLinesFormatter, getTextFormatter, getAnsiColorFormatter, getLogfmtFormatter`. `Sink = (record: LogRecord) => void`; `LogRecord { category: readonly string[]; level; message: readonly unknown[]; rawMessage: string | TemplateStringsArray; timestamp: number; properties }`. Levels `trace < debug < info < warning < error < fatal` (`warning`, not `warn`).
- `configure({ sinks, filters?, loggers: [{ category: string | string[], sinks?, parentSinks?: 'inherit' | 'override', filters?, lowestLevel? }], contextLocalStorage?, reset? })`. Category arrays (`['bb','agent','raw']`) inherit parent sinks unless `parentSinks: 'override'`. TypeScript infers sink ids from `loggers[].sinks`, so a sink no logger references is a compile error. Internal diagnostics log to `['logtape','meta']`: a one-time info notice ("LogTape loggers are configured…", silenced by setting that logger's `lowestLevel` above `info`) and sink exceptions (`Failed to emit a log record to sink`, level fatal); with no sink on that category the exceptions vanish silently [run].
- Console: `getConsoleSink({ formatter?: ConsoleFormatter | TextFormatter, levelMap?, console?, nonBlocking? })`; `formatter: jsonLinesFormatter` prints one JSON line per record, `ansiColorFormatter` the colourised TTY form (`INF bb·cli: hello 'world'`) [run Bun + Node; probe:logtape-console.ts].
- Files: `getFileSink(path, opts)`, `getRotatingFileSink(path, { maxSize, maxFiles, formatter, nonBlocking, bufferSize, flushInterval })`, `getTimeRotatingFileSink(opts)`, `getStreamFileSink` → `Sink & Disposable` (`& AsyncDisposable` with `nonBlocking: true`). Default formatter is text; `jsonLinesFormatter` gives `{"@timestamp","level":"INFO","message","logger":"bb.core","properties"}`. Registering one disposable sink under two ids closes its fd twice (`EBADF` in `dispose()`) [run].
- `fingersCrossed(sink, { triggerLevel = 'error', bufferLevel, maxBufferSize = 1000, isolateByCategory: 'descendant' | 'ancestor' | 'both' | fn, isolateByContext: { keys, maxContexts, bufferTtlMs, cleanupIntervalMs } })`: records at or below `bufferLevel` are buffered, records above it but below the trigger pass straight through, a trigger flushes the buffer. `{ triggerLevel: 'error', bufferLevel: 'debug', maxBufferSize: 5000 }` wrote `info` immediately and `debug` only after the `error` [run]. (The docs page names the context options `maxBuffers/ttlMs` [U12]; the installed 2.3.10 types say `maxContexts/bufferTtlMs`; types used.)
- Redaction: `redactByField(sink, patterns | { fieldPatterns, action?, maxDepth?, maxProperties? })` wraps a **sink** and deletes matching property keys (string or RegExp); `DEFAULT_REDACT_FIELDS` = pass(code|phrase|word), secret, token, key, credential, auth, signature, sensitive, private, ssn, email, phone, address. `redactByPattern(formatter, patterns, options?)` wraps a **formatter** and rewrites matches in the output text; built-ins `EMAIL_ADDRESS_PATTERN, CREDIT_CARD_NUMBER_PATTERN, US_SSN_PATTERN, KR_RRN_PATTERN, JWT_PATTERN`; custom `{ pattern: /…/g, replacement }` (`g` flag mandatory) [U12]. The spec's `sk-ant-…`, `ghp_`, `github_pat_`, `xox[abp]-`, `AKIA…`, PEM and URL-userinfo patterns therefore need custom objects. [run Bun + Node] `apiKey` property deleted; `sk-ant-…` and a JWT replaced in the JSONL file.
- **Effect → LogTape bridge** (`Logger.emit` is LogTape's documented integration API) [tsc][run] probe:logtape-bridge-final.ts:
```ts
const levelMap: Record<EffectLogLevel, LogLevel | null> = { All: 'trace', Trace: 'trace', Debug: 'debug', Info: 'info', Warn: 'warning', Error: 'error', Fatal: 'fatal', None: null }
export const effectToLogTape: Logger.Logger<unknown, void> = Logger.make((o) => {
  const level = levelMap[o.logLevel]
  if (level === null) return
  const { category, ...annotations } = o.fiber.getRef(References.CurrentLogAnnotations)
  const parts = Array.isArray(o.message) ? (o.message as unknown[]) : [o.message]
  const text = parts.map((p) => (typeof p === 'string' ? p : Bun.inspect(p, { depth: 3 }))).join(' ')   // use node:util inspect to stay Node-safe
  const properties: Record<string, unknown> = { ...annotations }
  if (o.cause.reasons.length > 0) properties['cause'] = Cause.pretty(o.cause)
  getLogger(typeof category === 'string' ? category.split('.') : ['bb', 'core']).emit({
    timestamp: o.date.getTime(), level, message: [text],
    rawMessage: text.replaceAll('{', '{{').replaceAll('}', '}}'),    // single literal part, braces escaped: never a placeholder
    properties,
  })
})
export const EffectLoggerLive: Layer.Layer<never> = Logger.layer([effectToLogTape])
```
  Why the shape: `redactByField` assumes `message` alternates text and values matching the `{placeholders}` in `rawMessage`; an Effect-style `message: ['from effect', {n: 1}]` with `rawMessage: 'from effect [object Object]'` threw `TypeError: undefined is not an object (evaluating 'char of path')` on Bun [run; probe:logtape-repro.ts]. Raise `References.MinimumLogLevel` (default `Info`) to let Effect debug logs through, and let LogTape category levels filter.

## 7. IDs and miscellaneous
- `Bun.randomUUIDv7(encoding?: "hex" | "base64" | "base64url", timestamp?: number | Date): string` and `randomUUIDv7("buffer", timestamp?): Buffer` [bun-types:bun.d.ts]. [run Bun 1.4.2] valid v7 format, **20 000 consecutive IDs sort in generation order**, `timestamp` argument honoured. Under Node `typeof Bun === 'undefined'` and `crypto.randomUUID()` is v4 only, so Vitest needs an injected `Ids` service; `uuid@14.0.2` `v7(options?)` is also monotonic over 20 000 [run Node 24.14].
- `@standard-schema/spec@1.1.0` (types only): `StandardSchemaV1<Input, Output> { readonly '~standard': { readonly version: 1; readonly vendor: string; readonly validate: (value: unknown, options?) => Result<Output> | Promise<Result<Output>>; readonly types?: { input; output } } }`, `Result = { value } | { issues: ReadonlyArray<{ message; path? }> }`, plus `StandardJSONSchemaV1` with `jsonSchema.input/output({ target: 'draft-2020-12' | 'draft-07' | 'openapi-3.0' })` [@standard-schema/spec:dist/index.d.ts; U14]. Effect vendors the same declarations.
- `fast-check@4.10.2`: model-based API `fc.commands(commandArbs, { maxCommands, size })`, `fc.modelRun(setup, cmds)`, `fc.asyncModelRun(setup, cmds)`, `fc.scheduledModelRun(scheduler, setup, cmds)`; `Command<Model, Real>` / `AsyncCommand<Model, Real, CheckAsync>` = `{ check(m): boolean; run(m, r): void | Promise<void>; toString(): string }`; `setup = () => ({ model, real })` [fast-check:lib/fast-check.d.ts; U13]. [tsc][run Vitest/Node] `fc.assert(fc.property(fc.commands([fc.constant(new Step('provision', ['created'], 'ready')), …], { maxCommands: 30 }), (cmds) => { fc.modelRun(() => ({ model: { status: 'created' } satisfies Model, real: new Machine() }), cmds) }), { numRuns: 200 })` passes; with `erasableSyntaxOnly` command classes must declare fields explicitly (no constructor parameter properties) [probe:fastcheck.test.ts].
- `yaml@2.9.1`, `jsonc-parser@3.3.1`, `confbox@0.3.1`: see §5 (c12 already reads JSONC; `jsonc-parser` only for comment-preserving writes).

## 8. git worktree facts (git 2.54.0 locally; docs [U15]; temp repo with a bare origin [run])
| Need | Command | Verified behaviour |
|---|---|---|
| create | `git worktree add <path> -b <branch> <commit-ish>` | with `origin/main`: `branch 'bb/demo' set up to track 'origin/main'`; with a local branch no upstream; existing branch → `fatal: a branch named 'x' already exists` (exit 255, nothing created) so pre-check before `-2`/`-3` suffixing |
| list | `git worktree list --porcelain [-z]` | blank-line separated records: `worktree <abs path>`, `HEAD <sha>`, `branch refs/heads/<b>` or `detached`, optional `locked [<reason>]`, `prunable <reason>`; `-z` NUL-terminates lines |
| status | `git status --porcelain=v2 --branch` | headers `# branch.oid <sha>\|(initial)`, `# branch.head <name>\|(detached)`; `# branch.upstream <up>` and `# branch.ab +<ahead> -<behind>` **only with an upstream**; entries `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`, `2 … <X><score> <path><TAB><orig>`, `u …`, `? <path>`, `! <path>`. Observed `+1 -1` after one local commit and one fetched upstream commit |
| ahead/behind without upstream | `git rev-list --left-right --count <base>...HEAD` | prints `<behind>\t<ahead>` (observed `0\t1`) |
| remove | `git worktree remove [-f] <worktree>` | clean → removed, **branch kept**; dirty → `fatal: '<p>' contains modified or untracked files, use --force to delete it` (128); locked → `fatal: cannot remove a locked working tree, lock reason: …` + `use 'remove -f -f'` (128), `-f -f` succeeds |
| lock | `git worktree lock --reason <s> <wt>` / `unlock` | list shows `locked <reason>` |
| prune | `git worktree prune -v` | a deleted directory shows `prunable gitdir file points to non-existent location`; prune removes the admin entry |
Minimum versions (GitHub compare API on `git/git` plus RelNotes [U16]): `worktree list` and `--porcelain` **2.7.0** (commit `bb9c03b82a` is in v2.7.0, not v2.6.0); `status --porcelain=v2` **2.11.0** (merge `00d2793`, 2016-09-09, in v2.11.0, not v2.10.0); `worktree remove`/`move` **2.17.0** (commit `cc73385`, 2018-02-12, in v2.17.0, not v2.16.0; the 2.17.0 manual lists both); `lock` 2.10.0; `list` shows `locked` 2.30.0; `list -z` 2.36.0; `add --orphan` 2.42.0. The spec's `git ≥ 2.40` gate covers all but `--orphan`.

## 9. SQLite under Node (Vitest) and Bun (binary): facts and recommendation
- `node:sqlite`: no flag since v23.4.0/v22.13.0; **"Stability: 1.2 - Release candidate"** in the v26 and v24 docs, promoted in v25.7.0 [U8]. Local [run]: Node 22.22.1 and 24.14.0 print `ExperimentalWarning: SQLite is an experimental feature…` (silence with `node --disable-warning=ExperimentalWarning` or Vitest `test.execArgv: ['--disable-warning=ExperimentalWarning']`); Node 25.8.0 prints none; SQLite 3.51.2 inside. **Node 26 is not installed here: unverified at runtime, docs only.**
- `DatabaseSync(path | ':memory:', { open, readOnly, enableForeignKeyConstraints, allowExtension, timeout, readBigInts, returnArrays, defensive, … })`; methods `prepare, exec, close, function, aggregate, createSession, applyChangeset, loadExtension, …`; properties `isOpen`, `isTransaction`; `StatementSync.all/get/run/iterate/columns/setReadBigInts/setReturnArrays`. No `transaction()` helper: use `exec('BEGIN')`/`COMMIT`/`ROLLBACK` [run Node 24.14; U8].
- Drivers: see §4 table. Effect SQL: `@effect/sql-sqlite-node` (node:sqlite) and `@effect/sql-sqlite-bun` both exist at 4.0.0 and both implement `SqlClient` (§3).
- One schema and one migrations folder across both drivers works within one Drizzle line: `1.0.0-rc.4` bun-sqlite and node-sqlite [run, identical `__drizzle_migrations`]; `0.45.3` bun-sqlite plus `sqlite-proxy` over `node:sqlite` [run; no node:sqlite driver in 0.45.3].

**Recommendation (simplest arrangement that keeps one schema):**
1. Pin `drizzle-orm@1.0.0-rc.4` and `drizzle-kit@1.0.0-rc.4` exactly (`install.exact = true` is already set). One `schema.ts`, one `drizzle/` folder, generated with `drizzle-kit generate`.
2. Kernel `Store` is an Effect service holding a sync Drizzle handle typed `SQLiteAsyncDatabase<'sync', any, any>`; two Layers: `StoreLive` (Bun only: `bun:sqlite` file DB with `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`, migrations from the embedded `migrationsJournal`) and `StoreTest` (`node:sqlite` `:memory:`, `migrate(db, { migrationsFolder })`). Wrap calls in `Effect.try`. Keep every `bun:*` import in the `StoreLive` module so Vitest never loads it.
3. Do **not** use Drizzle's `effect-sqlite-*` drivers with Effect 4.0.0 until a release that loads (only `rc5` hash build does).
4. Stable-only fallback (no RC): `drizzle-orm@0.45.3` + `drizzle-kit@0.31.11`; Bun uses `bun-sqlite`, tests use `drizzle-orm/sqlite-proxy` over `node:sqlite` (about 12 lines of adapter, verified with the same folder); embed with `readMigrationFiles` + `db.dialect.migrate`. `better-sqlite3` was not exercised (native addon, lifecycle scripts are blocked by `bunfig.toml`).
5. Effect-native alternative with no Drizzle at runtime: `effect/sql` `SqlClient` with `@effect/sql-sqlite-bun` (prod) and `@effect/sql-sqlite-node` (tests) — verified identical behaviour — plus Drizzle only for schema/SQL generation; costs a custom migration loader and loses the typed query builder.
6. Also add a Bun-run smoke test of `StoreLive` (a `bun run` script or the compiled-binary smoke) because Vitest cannot cover it.

## 10. Does Vitest 5 run under the Bun runtime?
- Officially Node only: `vitest@5.0.3` `engines.node` = `^22.12.0 || ^24.0.0 || >=26.0.0`; docs: "Vitest requires Vite >=v6.4.0 and Node >=v22.12.0" and the only Bun note is to use `bun run test`, not `bun test` [U6]. `vitest.mjs` starts with `#!/usr/bin/env node`; Bun "respects this shebang and executes the script with `node`" unless `--bun` is given [U5].
- Verified [run]: `bun run <script>` and `bunx vitest run` executed the tests on **Node 24.14.0** (`process.versions.bun` undefined, `bun:sqlite` import fails). `bun --bun ./node_modules/.bin/vitest run` executed them on **Bun 1.4.2** (`process.versions.bun = 1.4.2`, `process.execPath` = bun, `bun:sqlite` importable; the 6-test `@effect/vitest` suite passed there). That second mode is not documented by Vitest; the plan should treat **Node as the test runtime** (CI Node 26 per `.node-version`, local 24).

## Unverified or not exercised
1. Node 26 runtime behaviour of `node:sqlite` and Vitest (only Node 22.22.1, 24.14.0, 25.8.0 exist locally; Node 26 from docs).
2. Linux/arm64 and Windows behaviour of anything here (all runs on macOS arm64).
3. `@effect/vitest` `it.prop`, `it.flakyTest`; `effect/http-api`, `effect/rpc`, `effect/workflow`, `effect/cluster`, `Otlp.layer` (presence checked, not run); whether cluster SQL storage works on SQLite.
4. Provenance and stability of `drizzle-orm@1.0.0-rc.5-5935859` (no GitHub release); whether a 1.0.0 GA or a proper rc.5 will land on the `rc` tag.
5. `drizzle-kit migrate` (CLI applying to a file DB) and `up` from the old to the new layout; `drizzle-orm/sqlite-proxy` beyond the one insert/select shown.
6. `better-sqlite3` route; `sqlite-vec`/FTS5 with either driver.
7. LogTape docs vs types naming for `isolateByContext`; `getTimeRotatingFileSink`, `@logtape/otel` not run.
8. `it.effect` log suppression and `TestConsole` behaviour beyond the README.
9. Effect's TypeScript ≥ 5.9 and `@effect/sql-sqlite-node` Node ≥ 22.16 minimums (GitHub release notes only; only TS 7.0.2 and Node 22.22/24.14/25.8 were run).

## Sources
[U1] https://bun.com/docs/runtime/bunfig · [U2] https://effect.website/blog/releases/effect/40 · [U3] https://github.com/Effect-TS/effect/releases (effect@4.0.0 notes) · [U4] https://github.com/Effect-TS/effect/blob/main/MIGRATION.md and raw `migration/{v3-to-v4,services,error-handling,forking,layer-memoization}.md` on raw.githubusercontent.com/Effect-TS/effect/main · [U5] https://bun.com/docs/cli/run · [U6] https://vitest.dev/guide/ · [U7] https://bun.com/docs/runtime/sqlite · [U8] https://nodejs.org/docs/latest-v26.x/api/sqlite.html and https://nodejs.org/docs/latest-v24.x/api/sqlite.html · [U9] https://orm.drizzle.team/docs/connect-bun-sqlite, /docs/drizzle-config-file, /docs/migrations · [U10] https://github.com/drizzle-team/drizzle-orm/releases · [U11] https://github.com/unjs/c12 · [U12] https://logtape.org/manual/sinks and /manual/redaction · [U13] https://fast-check.dev/docs/advanced/model-based-testing/ · [U14] https://standardschema.dev/ · [U15] https://git-scm.com/docs/git-worktree, /docs/git-status, /docs/git-worktree/2.17.0 · [U16] raw git RelNotes `Documentation/RelNotes/{2.7.0,2.10.0,2.11.0,2.30.0,2.36.0,2.42.0}.adoc` (raw.githubusercontent.com/git/git/master) and `https://api.github.com/repos/git/git/compare/<tag>...<sha>` · npm: `npm view <pkg> version dist-tags time --json`, 2026-10-02.
