# ByteBureau research cluster 03 — Runtime, language, monorepo, lint/format/test, git hooks, commits/changelog/release, dependency automation, GitHub Actions

Research date: **2026-10-02**. Method: WebSearch for discovery, WebFetch of official docs/blogs/changelogs, `gh api` for GitHub stars/licenses/release dates, `npm view` for registry versions/engines/peer ranges, plus one empirical experiment (`bun build --compile` cross-compilation on this MacBook, Bun 1.4.2). Every version number and date below was observed in a source during this pass unless explicitly marked **unverified**. Raw data files sit next to this report: `gh-repo-data.tsv`, `npm-data.tsv`, `tag-dates.tsv`, `gh-batch-output.txt`, `gh-batch2-output.txt`.

A note on noise: 2026 search results are polluted by content farms (e.g. claims of "Bun 2.0 released May 2026", "Bun v7.17.0", "tsdown 1.0 released"). All three are false per the primary sources (Bun's newest tag is `bun-v1.4.2`, tsdown is `v0.23.0`). Where a widely repeated claim contradicted a primary source, the primary source won and the claim is flagged.

---

## 1. Executive summary

- **Primary runtime: Bun 1.4.x** (1.4.2, 2026-09-05). It is the only runtime that gives ByteBureau single-file, cross-compiled binaries for all required targets from one machine (measured today: darwin-arm64 **59.3 MB**, linux-arm64 **77.5 MB**, linux-x64 77.5 MB, windows-x64 82.1 MB, linux-arm64-musl 71.0 MB), plus built-in SQLite, WebSockets, `$` shell, OS-keychain secrets, workspaces + catalogs, and a package manager with supply-chain defaults. Anthropic acquired Bun (announced 2025-12-02/03); it stays MIT. Caveat: 1.4.0 (2026-08-20) is the first release of the AI-driven Zig→Rust rewrite (535k lines, 13k `unsafe` blocks, 1.4.1 fixed 202 issues) — pin exact versions and keep core code Node-compatible as an escape hatch. Node 26 (LTS on 2026-10-28) is the compatibility target for shared packages; Deno 2.9 is rejected for core.
- **TypeScript 7.0.2** (Go-native `tsc`, 7.7–11.9× faster) for type-checking and the editor, **but** 7.0 ships no programmatic API, so typescript-eslint (peer `typescript <6.1`), vue-tsc, Svelte/Astro/Angular tooling cannot use it until **7.1 (stable planned 2026-11-24)**. Run TS 6.0.3 side-by-side via `@typescript/typescript6` for those tools. typescript-eslint's TS 7.1 support PR is in internal review (2026-09-29).
- **Lint/format: oxlint 1.86 with type-aware linting (stable since 2026-07-22, 59/61 typescript-eslint type rules, 12–18× faster) + oxfmt 0.71 (beta, 100 % Prettier JS/TS conformance)** is both the strictest fast option and the 2026 hype pick. Biome 2.5 is the most polished single tool but its type-aware rules are heuristic nursery rules. ESLint 10 + typescript-eslint remains the widest rule catalogue but is slow and TS7-blocked; keep it only as a CI-only "long tail" (eslint-plugin-vue templates, sonarjs, security, jsdoc).
- **Monorepo: Bun workspaces as package manager + Turborepo 2.11** (Bun 1.2+ is a stable, supported PM; Vercel remote cache is free, OIDC-authenticated). pnpm 12 is the fallback if you want the best supply-chain defaults (1-day `minimumReleaseAge`, `strictDepBuilds`). Publish npm packages with **tsdown 0.23** (Rolldown-based; not yet 1.0) + publint + arethetypeswrong; prune with **knip 6**.
- **Testing: Vitest 5.0** (2026-09-03; Node ≥22.12, Vite ≥6.4; browser mode + trace view) as the default runner, `bun test` only for packages that depend on Bun-only APIs; Playwright 1.63 for E2E; Storybook 10.6 + addon-vitest for UI; fast-check 4, msw 3 (ESM-only), Testcontainers 12 for Docker-backed agent sandbox tests. Stryker 10 only as a weekly job on core domain packages.
- **Hooks/commits/release: lefthook 2.1 + commitlint 21 (commit-msg) + amannn/action-semantic-pull-request (squash-merge PR titles) → changelogen (unjs, emoji sections) + bumpp for versioning → tag-triggered release workflow building Bun binaries (one Linux runner cross-compiles all targets) and Tauri bundles (per-OS matrix) → `actions/attest-build-provenance` v4 (SLSA L2; L3 with a reusable workflow) → draft-then-publish into an **immutable GitHub Release** (`softprops/action-gh-release` v3) → npm trusted publishing (OIDC, no tokens) → Homebrew tap via `homebrew-releaser`.
- **Dependencies: Renovate (`config:best-practices`, 7–14-day `minimumReleaseAge` for automerge, weekly lock-file maintenance, bun.lock supported) + Dependabot alerts only.** Shai-Hulud (Sept and Nov 2025, 500–800 packages) is why `minimumReleaseAge`, blocked lifecycle scripts (Bun default; pnpm 11 default), npm trusted publishing (classic tokens revoked 2025-12-09) and `bun ci`/frozen lockfiles are non-negotiable.
- **GitHub Actions 2026: all first-party actions moved to Node 24 + ESM majors** (checkout v7, setup-node v7, cache v6, upload-artifact v7, github-script v9, labeler v7). Public repos get free, unlimited runners including **ubuntu-24.04-arm / ubuntu-26.04-arm, windows-11-arm, macos-26 (M1)**, so Raspberry Pi 5 (arm64) can be tested natively. Harden with pinned SHAs (Renovate keeps them fresh), `zizmor` (pedantic), `actionlint`, `harden-runner`, CodeQL default setup, OpenSSF Scorecard. Target: PR pipeline ≤ 6 min, release ≤ 20 min.

---

## 2. Findings per topic

### 2.1 Runtimes

#### Bun

| Fact | Evidence |
|---|---|
| Latest: **1.4.2** (2026-09-05); 1.4.1 (2026-09-04, "fixes 202 issues"); **1.4.0 (2026-08-20)**; 1.3.14 (2026-05-13) was the last Zig build; 1.3.0 (2025-10-10). 96.1k stars. | `gh api` release list; https://bun.com/blog/bun-v1.4 |
| **Anthropic acquired Bun**, announced 2025-12-02/03 — Anthropic's first acquisition, timed with Claude Code reaching $1B run-rate; "Bun will remain open source and MIT-licensed". Claude Code ships as a Bun executable. | https://devclass.com/2025/12/03/bun-javascript-runtime-acquired-by-anthropic-tying-its-future-to-ai-coding/ ; https://gigazine.net/gsc_news/en/20251203-anthropic-acquired-bun/ ; https://betterstack.com/community/guides/scaling-nodejs/anthropic-acquires-bun/ |
| **Rust rewrite**: PR #30412 "Rewrite Bun in Rust" opened 2026-05-08; 535,496 lines of Zig ported (AI-driven, 64 Claude agents reported), 99.8 % of tests passing on Linux x64 after six days, four months of stabilisation; shipped in 1.4.0. Result: 128 long-standing bugs fixed, native memory leaks closed (bundling test RSS plateau 609 MB vs 6.7 GB before), but **13,044 `unsafe` blocks** (vs ~73 typical) and a near 50/50 👍/👎 split (1,607 vs 1,559) on the PR; Zig's Andrew Kelley published a critical response. The 1.4 blog post itself says "Bun is now written in Rust". | https://www.infoq.com/news/2026/09/bun-AI-rewrite-zig-rust-4-months/ ; https://www.devclass.com/software/2026/05/11/anthrophics-bun-team-trials-port-from-zig-to-rust/5237835 ; https://github.com/oven-sh/bun/pull/30412 ; https://bun.com/blog/bun-v1.4 |
| 1.4 features: Node.js **26.3.0** compatibility target (+1,517 passing Node tests), `Bun.WebView` headless browser, `Bun.Image`, `Bun.markdown`, JSON5/JSONL, Terminal + cron APIs, parallel `bun test`/`bun run`, **Windows ARM64**, opt-in global virtual store (up to 7× faster installs), binary size cut up to 17 % (Linux x64 77.0 MB, from 88.5 MB), `--bytecode --format=esm` (requires `--compile`; enables top-level await + dynamic import), `--compile --asset <dir>`, `--compile --target=browser` (single HTML), `bun add --catalog`, `--filter` on add/remove/update. | https://bun.com/blog/bun-v1.4 |
| **Single-file executables**: 8 targets — `bun-linux-x64`, `bun-linux-arm64`, `bun-linux-x64-musl`, `bun-linux-arm64-musl`, `bun-windows-x64`, `bun-windows-arm64`, `bun-darwin-x64`, `bun-darwin-arm64` (`-baseline/-modern` suffixes are now aliases). Cross-compiling from macOS to Windows/Linux works; Windows-only metadata (icon, hide console) must be compiled on Windows. `--bytecode` ≈ 2× faster startup (tsc benchmark), slightly slower builds; `--minify` "saves megabytes"; `--sourcemap` embedded zstd-compressed; assets via `with { type: "file" }`, `--asset`, embedded SQLite (`with { type: "sqlite", embed: "true" }`); macOS signing needs JIT entitlements. Docs admit: "Bun's binary is still way too big and we need to make it smaller." | https://bun.com/docs/bundler/executables |
| **Measured today (Bun 1.4.2, hello-world importing `bun:sqlite`, `--minify`)**: darwin-arm64 **59.3 MB**, linux-arm64 **77.5 MB**, linux-x64 77.5 MB, windows-x64 82.1 MB, linux-arm64-musl 71.0 MB; `--bytecode` added 0.1 MB; each cross-build took < 1 s after target download; `file` confirms ELF aarch64 and PE32+ outputs. | local experiment (this session) |
| Third-party size comparison (2026-03-09): app with deps compiled with Bun 62.8 MB (darwin-arm64) / 97.6 MB (linux-arm64) / 104 MB (linux-x64) / 116 MB (windows-x64) vs **Deno 414–648 MB without `--bundle`** (Deno embeds node_modules as-is). | https://zenn.dev/dyoshikawa/articles/deno-to-bun-single-binary?locale=en |
| **Workspaces & catalogs**: `workspace:*`, `workspace:^`, `workspace:~`; `catalog`/`catalogs` under `workspaces` in root package.json, `catalog:`/`catalog:<name>` protocol, `bun add --catalog`; `bun publish` strips `workspace:`/`catalog:`; isolated (pnpm-like) linker is default for workspaces since 1.3; `bun --filter` supports name/path globs, `foo...`/`...foo` dependency selectors, `!` exclusion, parallel by default **with dependency ordering**, `--sequential`, `--if-present`. | https://bun.com/docs/pm/workspaces ; https://bun.com/docs/install/catalogs ; https://bun.com/docs/pm/filter ; https://bun.com/docs/pm/cli/publish |
| **Install security**: dependency lifecycle scripts are **blocked by default** (allow via `trustedDependencies`); `--minimum-release-age <seconds>` / bunfig `[install] minimumReleaseAge` (default null); `[install.security] scanner` API; `bun audit`; `bun ci` for frozen installs (`--frozen-lockfile` is *not* automatic in CI); `--production` implies frozen; cache at `~/.bun/install/cache`. | https://bun.com/docs/pm/cli/install ; https://bun.com/docs/runtime/bunfig ; https://bun.com/blog/bun-v1.3 |
| `Bun.serve` WebSockets: handler-per-server design, pub/sub topics, backpressure return codes, `perMessageDeflate`, 16 MB max payload, 120 s idle timeout, claimed ~7× `ws` throughput; standards `WebSocket` client with Bun extensions (custom headers). | https://bun.com/docs/api/websockets |
| `bun:sqlite`: synchronous, claimed 3–6× faster than better-sqlite3 for reads, WAL, extensions, serialize/deserialize, `strict`, `safeIntegers` (bigint). API differs from `node:sqlite` (`DatabaseSync`/`StatementSync`). | https://bun.com/docs/api/sqlite ; https://nodejs.org/api/sqlite.html |
| `Bun.secrets` (since 1.3): macOS Keychain / Linux libsecret (needs a running secret-service daemon — headless Pi caveat) / Windows Credential Manager; `get/set/delete`; docs: "mostly useful for local development tools". | https://bun.com/docs/runtime/secrets |
| `Bun.$` shell: cross-platform incl. Windows, built-ins (`cd ls rm cat mkdir mv which seq …`), pipes/redirects into `Buffer`/`Response`/`Bun.file`, escaping by default, `.nothrow()`, `.text()/.json()/.lines()`; backtick substitution unsupported. | https://bun.com/docs/runtime/shell |
| System requirements: macOS 13+, Linux glibc 2.17+ (kernel 3.10+, 5.6+ recommended) x64 (SSE4.2) & arm64 glibc/musl, Windows 10 1809+ x64 and ARM64. Raspberry Pi 5 on 64-bit Raspberry Pi OS (glibc) is covered by `bun-linux-arm64`; Alpine by `-musl`. | https://bun.com/docs/installation |
| **Known gaps vs Node (official compat table)**: `node:sea` not implemented (use `--compile`); `node:cluster` HTTP load-balancing Linux-only; `async_hooks` hooks/ids stubbed; `node:inspector` partial; `node:test` lacks coverage/snapshots; `worker_threads` lacks `resourceLimits`; `node:vm` partial; `https` SNI callback missing; `perf_hooks.eventLoopUtilization()` returns zeros; crypto missing ML-KEM. Native addons remain the main breakage point (community reports: `bcrypt`, `canvas` on Windows). | https://bun.com/docs/runtime/nodejs-apis ; community: https://www.alexcloudstar.com/blog/bun-compatibility-2026-npm-nodejs-nextjs/ (low-quality source; its "Bun 2.0, May 2026" claim is false) |
| Momentum: State of JS 2025 (fielded Nov 2025, published Feb 2026) — backend runtime usage **Node 90 %, Bun 21 % (+4 pts), Deno 11 %**; respondent counts Node 10,062 / Bun 2,321 / Deno 1,244. | https://www.infoq.com/news/2026/03/state-of-js-survey-2025 ; https://2025.stateofjs.com/en-US/other-tools/ |

#### Node.js

| Fact | Evidence |
|---|---|
| Latest **26.10.0** (2026-09-22). 26.0.0 released **2026-05-05**; enters **LTS 2026-10-28**; EOL 2029-04-30. 24 "Krypton" is current LTS (active until 2026-10-20, maintenance to 2028-04-30). 22 "Jod" EOL 2027-04-30. 25 EOL 2026-06-01. | https://nodejs.org/en/about/previous-releases ; https://endoflife.date/nodejs ; https://www.chornous.dev/blog/nodejs-26-temporal-lts/ ; https://www.inmotionhosting.com/support/news/nodejs-v26-released/ |
| **New release model** (announced 2026-03-10): from Node 27, one major per year, every release is LTS, odd/even distinction dropped, new 6-month Alpha channel (27 alpha Oct 2026, 27.0.0 April 2027, LTS Oct 2027), 36-month total window. | https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule |
| 26.0.0 contents: Temporal enabled by default, V8 14.6 (Map `getOrInsert`, `Iterator.concat`), undici 8; removed `--experimental-transform-types`, legacy `_stream_*` modules, `http.Server#writeHeader`; `module.register()` runtime-deprecated; `localStorage` throws without `--localstorage-file`; GCC 13.2 / Windows SDK 11 toolchain. | https://nodejs.org/en/blog/release/v26.0.0 ; https://nodejsdesignpatterns.com/blog/whats-new-in-nodejs-26/ |
| **Type stripping: Stability 2 (Stable) since v24.12.0**, on by default since 23.6; Node 26 removed the transform flag entirely, so **only erasable syntax runs** (no enums/namespaces/parameter properties/decorators), `.tsx` unsupported, `tsconfig.json` ignored, `node_modules` never stripped, explicit `.ts` extensions required → use TS `erasableSyntaxOnly` + `rewriteRelativeImportExtensions`. | https://nodejs.org/docs/latest-v24.x/api/typescript.html ; https://nodejs.org/docs/latest-v26.x/api/typescript.html |
| **SEA**: Stability **1.1 Active development** (v25.5.0 added `node --build-sea sea-config.json`; v26.9.0 added `useVfs` virtual filesystem for assets); CI-tested on Windows, macOS **arm64 only**, Linux (not Alpine); cross-platform generation requires `useCodeCache`/`useSnapshot` = false; ESM main via `mainFormat: "module"`; still prints `ExperimentalWarning`. Size ≈ full Node binary — the local Node 24.14 darwin-arm64 binary is **113.6 MB** (Bun's whole runtime is 59 MB). | https://nodejs.org/api/single-executable-applications.html ; https://joyeecheung.github.io/blog/2026/01/26/improving-single-executable-application-building-for-node-js/ ; local measurement |
| `node:sqlite`: Stability **1.2 Release Candidate** since v25.7.0, unflagged since 22.13/23.4; synchronous only (`DatabaseSync`, `StatementSync`, sessions/changesets, `SQLTagStore`). | https://nodejs.org/api/sqlite.html |
| Permission model (`--permission`, `--allow-fs-read/-write`, `--allow-child-process`, `--allow-worker`, `--allow-addons`, `--allow-wasi`, `--allow-net`, `--allow-ffi`, `--allow-openssl-store`): **Stable** since 22.13/23.5; does not propagate to workers; symlink and fd caveats. | https://nodejs.org/api/permissions.html |
| Global `WebSocket` client: stable, unflagged since 22; `localStorage`/`sessionStorage` RC. | https://nodejs.org/docs/latest-v26.x/api/globals.html |

#### Deno

| Fact | Evidence |
|---|---|
| Latest **2.9.7** (2026-09-17); 2.9.0 (2026-06-25): experimental `deno desktop` (webview backend ≈ 40 MB binaries), `deno install` reads `bun.lock`/`pnpm-lock.yaml`/`yarn.lock`/`package-lock.json`, Node 26.3 compat, cold start 34→17 ms, 2.2× less memory. 108.6k stars, MIT. No Deno 3 evidence. | https://deno.com/blog/v2.9 ; `gh api` |
| `deno compile`: targets x86_64/aarch64 for Linux-gnu, macOS, Windows (aarch64 Windows since 2.9.3); binaries ≈ 70 MB baseline (denort); experimental `--bundle` + `--minify` tree-shakes (lodash hello-world payload 11.6 MB → 1.5 MB); macOS ad-hoc signed by default. | https://docs.deno.com/runtime/reference/cli/compile/ ; https://deno.com/blog/deno-compile-executable-programs |
| Deno Deploy: serverless + self-host option, 2 regions, first-class Next/Astro/SvelteKit; pricing not captured (**unverified**). | https://docs.deno.com/deploy/ |

**Runtime verdict** (details in §3): Bun for core+CLI binaries, Node 26 as the compatibility baseline for shared packages/plugins, Deno rejected for core.

---

### 2.2 TypeScript

| Fact | Evidence |
|---|---|
| **TypeScript 7.0 announced 2026-07-08** (first stable Go-native `tsc`); npm `latest` = **7.0.2** (2026-08-20). TS 6.0 (bridge release) 2026-03-23, 6.0.3 2026-04-16. `microsoft/typescript-go` is archived (2026-08-31; "staging repo") — development merged into `microsoft/TypeScript`; the VS Code TypeScript extension is now released from that repo (`vscode-typescript/v1.0.1`, 2026-09-30). | https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ ; `gh api`/`npm view` |
| 7.0 performance: 7.7–11.9× faster full builds (VS Code 16.7× with `--checkers 8`), memory −6–26 %, `--build --builders` parallel project references, LSP crashes −60 %. **No programmatic API in 7.0**; `@typescript/typescript6` package provides TS 6.0 side-by-side for tools (typescript-eslint, vue-tsc…). Vue/Svelte/Astro/MDX/Angular template checking cannot run on 7.0. | same + https://www.infoq.com/news/2026/08/typescript-7-released/ ; https://www.theregister.com/devops/2026/07/09/speedier-type-checks-in-typescript-70-as-first-stable-go-release-ships/5268828 |
| **TS 7.1 iteration plan**: Beta 2026-10-06, RC 2026-11-10, **Stable 2026-11-24**; "Stabilize API" (Content Mapper API, Emit API, Language Service API), `es2026` target/lib, wasm build, repo migration. | https://github.com/microsoft/TypeScript/issues/63703 |
| New defaults (6.0→7.0): `strict: true`, `module: esnext`, `target: es2025` (6.0; "current stable ES" in 7), `types: []`, `rootDir: .`, `noUncheckedSideEffectImports: true`, `stableTypeOrdering` (forced in 7). **Hard errors in 7**: `target es5`, `downlevelIteration`, `moduleResolution node/classic`, `module amd/umd/system/none`, `baseUrl`, `esModuleInterop: false`, `allowSyntheticDefaultImports: false`, `alwaysStrict: false`, `outFile`, legacy `module` namespaces, `assert` import attributes, `no-default-lib`. | https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/ ; 7.0 post |
| **typescript-eslint 8.71.0** (2026-09-28) peer `typescript >=4.8.4 <6.1.0` — TS 7 unsupported. Tracking issue #10940 locked; 2026-09-29 status: "WIP TypeScript 7.1 support is looking more and more stable … PR #12803 ready for internal team review", TS team supplying APIs. ESLint core issue #21070 accepted but blocked on typescript-eslint. | https://github.com/typescript-eslint/typescript-eslint/issues/10940 ; https://github.com/eslint/eslint/issues/21070 ; `npm view` |
| **vue-tsc**: fails on TS 7.0.2 (#6124, #6156 closed); open discussion #6167 (2026-08-20) on content-mapper direction → Vue type-checking stays on TS 6 until 7.1. | https://github.com/vuejs/language-tools/issues/6167 |
| Bundlers don't need `tsc`: Vite 8 (2026-03-12) uses Rolldown + Oxc; Rolldown 1.0 2026-05-07 (now 1.2.12); tsdown 0.23 declares peer `typescript ^5 \|\| ^6 \|\| ^7` and emits `.d.ts` via oxc isolated declarations (fast path) or the TS compiler. `erasableSyntaxOnly` exists since TS 5.8. | https://vite.dev/blog/announcing-vite8 ; https://tsdown.dev/options/dts ; `npm view tsdown` |
| `tsconfig/bases`: `@tsconfig/strictest` 2.0.8, `@tsconfig/node24` 24.0.5, **`@tsconfig/node26` 26.0.1**, `@tsconfig/bun` 1.0.11 (all 2026-09-24; auto-published daily); multiple `extends` supported since TS 5.0. `@total-typescript/ts-reset` last release 0.6.1 (2024-09) — stable but dormant. | https://github.com/tsconfig/bases ; `npm view` |

**Recommended 2026 `tsconfig` (packages running on Bun/Node):**

```jsonc
{
  "extends": ["@tsconfig/strictest/tsconfig.json", "@tsconfig/node26/tsconfig.json"], // or @tsconfig/bun for Bun-only packages
  "compilerOptions": {
    "module": "nodenext", "moduleResolution": "nodenext",   // "bundler" (+ "module": "preserve") only inside Vite apps
    "target": "es2025", "lib": ["es2025"],
    "types": ["bun"],                                       // TS 6+ defaults to [] — be explicit (["node"] for Node packages)
    "rootDir": "./src", "outDir": "./dist",
    "verbatimModuleSyntax": true, "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true, "rewriteRelativeImportExtensions": true,  // Node/Bun type-stripping with .ts specifiers
    "isolatedDeclarations": true,                           // published packages only: enables oxc fast .d.ts in tsdown
    "exactOptionalPropertyTypes": true, "noUncheckedIndexedAccess": true,
    "noPropertyAccessFromIndexSignature": true, "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true, "noUncheckedSideEffectImports": true,
    "skipLibCheck": true, "composite": true, "noEmit": true  // emit is tsdown's job; `tsc --build --builders` for type-check
  }
}
```

(`strictest` already sets `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `noImplicitOverride`, `checkJs`, `isolatedModules`; listed for clarity.)

---

### 2.3 Monorepo & publishing

| Tool | Version / date | Notes | Source |
|---|---|---|---|
| **pnpm** | **12.8.1** (2026-09-28); 12.0.0 2026-08-26; 11.0.0 2026-04-28 (RC 2026-03-09) | 11: `minimumReleaseAge` default **1440 min (1 day)**, `blockExoticSubdeps`, `strictDepBuilds`, unified `allowBuilds`, `.npmrc` auth-only (settings → `pnpm-workspace.yaml`), pure ESM, SQLite store v11, Node ≥22, GHSA-based audit. 12: `--frozen-lockfile false` removed, HTTPS git deps, unknown workspace settings error, deterministic peer cycles (2–3× faster), project-aware global bins for node/deno/bun, registry revisions. Catalogs: `catalog`/`catalogs`, `catalogMode` (manual default / strict / prefer), stripped on publish. | https://pnpm.io/blog/releases/11.0 ; https://pnpm.io/blog/releases/12.0 ; https://pnpm.io/catalogs ; https://socket.dev/blog/pnpm-11-adds-new-supply-chain-protection-defaults |
| `pnpm/setup` action | **v3.0.0** (2026-09-20); repo created 2026-05-11 | Installs pnpm 11+ **plus** Node/Bun/Deno in one step, caches store + verification log, auto `pnpm install`, `require-lockfile`. Old `pnpm/action-setup` (v6.1.0, 2026-09-05) remains for pnpm ≤10. | https://github.com/pnpm/setup ; https://pnpm.io/continuous-integration |
| **Bun workspaces** | 1.4.2 | See §2.1: catalogs, `workspace:` ranges, isolated linker, `--filter` topological parallel runs, `bun publish` strips protocols, `bun ci`. | bun docs |
| **Turborepo** | **2.11.6** (2026-10-01); 2.11 2026-09-18; 2.9 2026-03-30; 2.8 2026-01-26; 31.2k stars MIT | 2.11: experimental native Rust/Python/Go workspaces, `devEngines.packageManager`, `turbo prune --production`, TTFT up to 4× faster vs 2.9. 2.9: 80–96 % faster startup, `turbo query` stable (`affected`, `ls`), deprecations for 3.0 (`turbo-ignore`, `--parallel`, `--no-cache`, daemon flags, `TURBO_REMOTE_ONLY`). Support policy: **bun 1.2+ stable**, pnpm 8+, npm 8+, yarn 1+ (also lists "nub 0.8+" and "aube 2.2+" — **unverified what these are**). Vercel Remote Cache free on all plans (fair use), OIDC via `vercel/setup-turborepo-remote-cache-action` v1.1.0 (2026-08-21). | https://turborepo.dev/blog/2-11 ; https://turborepo.dev/blog/2-9 ; https://turborepo.dev/docs/getting-started/support-policy ; https://turborepo.dev/docs/guides/ci-vendors/github-actions ; https://vercel.com/changelog/free-vercel-remote-cache |
| **Nx** | npm **23.2.1** (2026-10-01); 23.0.0 2026-06-16; 22.0.0 2025-10-22; 29.4k stars | Heavy, plugin-centric; Powerpack/self-hosted-cache licensing **unverified** this pass (docs page unreadable); Vercel notes Nx ≥19.7 may require a licence for Vercel remote cache. State of JS 2025: Nx 1,682 vs Turborepo 1,718 respondents. | `gh api`; https://vercel.com/changelog/free-vercel-remote-cache |
| **moon** | **2.5.6** (2026-09-28); 2.0 2026-02-18 (large breaking rename); 2.5 (2026-08-14) OpenTelemetry, async engine default; proto 0.62 (2026-09-03) | 4.1k stars; State of JS 2025: 23 respondents — tiny mindshare. | https://moonrepo.dev/blog ; `gh api` |
| **tsdown** | **0.23.0** (2026-09-03) — *not* 1.0; 4.3k stars; Node ^22.18 \|\| ^24.11 \|\| ≥26 (dropped Node 25) | Rolldown + Oxc; tsup-compatible config; `unbundle`, `copy`, `css.inject`, ATTW profile `esm-only` default, `neverBundle`; dts via oxc isolated declarations (fast) or tsc. | https://github.com/rolldown/tsdown/releases ; https://tsdown.dev/options/dts ; `npm view` |
| tsup | 8.5.1 (2025-11-12), 11.3k stars | esbuild-based; slow cadence — superseded by tsdown. | `gh api`/`npm view` |
| unbuild | 3.6.1 (2025-08-15) | unjs rollup+mkdist; dormant 13 months. | `npm view` |
| bunchee | 7.0.1 (2026-08-08) | zero-config exports-driven (rollup+swc), peer TS 5–7. | `npm view` |
| pkgroll | 2.28.1 (2026-08-27) | rollup+esbuild, exports-driven. | `npm view` |
| **publint** | 0.3.25 (2026-10-01) | package.json/exports lint. | `npm view` |
| **arethetypeswrong** | `@arethetypeswrong/cli` 0.18.5 (2026-07-09) | tsdown integrates ATTW profiles. | `npm view` |
| **knip** | **6.39.0** (2026-09-30); v6 2026-03-20 (Node ≥20.19, `--include-libs` default, workspaces isolated by default); 12.4k stars ISC | Unused files/exports/types/deps/**catalog entries**, 150+ plugins, Bun & pnpm aware, `--production`, `--fix`; 40M monthly downloads; used by Anthropic, Microsoft, Vercel. | https://knip.dev/ ; `gh api` |

---

### 2.4 Lint / format

#### Biome 2.x

- Latest **2.5.15** (2026-09-30); 2.5.0 2026-06-12 (blog 2026-06-05): **500+ rules**, 73 nursery→stable, GritQL plugin **code fixes**, `--watch`, cross-file CSS rules (`noUnusedClasses`, `noUndeclaredClasses`) via module graph, Vue/Svelte/Astro "fully supported", LSP go-to-definition, concise reporter, `biome upgrade`, lint/check ~13 % faster. 25.9k stars, Apache-2.0. Sources: https://biomejs.dev/blog/biome-v2-5/
- 2.4 (2026-02-10): **`types` domain** (isolates inference-dependent rules; enabling it triggers project-wide scan + inference), embedded CSS/GraphQL formatting in JS, 15 HTML a11y rules across Vue/Svelte/Astro, `--profile-rules`, `noImportCycles` promoted. https://biomejs.dev/blog/biome-v2-4/
- 2.3 (2025-10-07): experimental Vue/Svelte/Astro, Tailwind v4 directives, `--only/--skip` domains. https://biomejs.dev/blog/biome-v2-3/
- Type-awareness: 2.0 (2025-06-17) shipped `noFloatingPromises` catching ~75 % of typescript-eslint's cases, 2.1 ~85 %; the rule page today still says **"experimental nursery rule"** and effectiveness "depends on proper type annotations". https://biomejs.dev/linter/rules/no-floating-promises/ ; https://biomejs.dev/linter/domains/ ; https://alternativeto.net/news/2025/7/biome-2-1-update-brings-faster-scanning-and-improved-type-inference
- Roadmap 2026 (2026-01-21): stabilise HTML, SCSS, Markdown (needs champion), embedded languages, cross-language rules, opt-in workspace config for monorepo memory; 15M monthly downloads. https://biomejs.dev/blog/roadmap-2026/
- Preset: **ultracite 7.12.2** (2026-09-29, 3.3k stars) now ships presets for **oxlint, Biome and ESLint** (`ultracite/biome/core`, `/react`, `/vitest` …; opt-in explicit rule lists). https://www.ultracite.ai/

#### oxlint / oxfmt (VoidZero / oxc)

- **oxlint 1.86.0** (2026-09-28; 1.0 was 2025-06-10; oxc repo 22.9k stars MIT): **870+ rules**, plugins (eslint, typescript, unicorn, react, jsx-a11y, import, jest, vitest, promise, node, nextjs), project-wide module graph (`import/no-cycle`), `.oxlintrc.json` with `extends`/`overrides` and **nested configs for monorepos**, **JS plugin API in alpha** (ESLint-plugin compatibility, custom rules), 50–100× faster than ESLint. https://oxc.rs/docs/guide/usage/linter.html
- **Type-aware linting stable (2026-07-22)** via **tsgolint** (v7.0.2000 tracking TS 7.0.2; latest **7.0.2003**, 2026-09-24; 1.4k stars): builds real TS programs on typescript-go, **59 of 61** typescript-eslint type-aware rules (added `no-unnecessary-condition`, `prefer-optional-chain`, `prefer-readonly`, `consistent-return` …), `--type-aware` and `--type-check` (reports compiler errors from the shared program), `options.typeAware: true` in config, per-rule timings; **12–18× faster** than ESLint+typescript-eslint on VS Code/TypeScript/TypeORM/Vue repos. https://oxc.rs/blog/2026-07-22-type-aware-linting-stable ; https://www.infoq.com/news/2026/09/tsgolint-oxlint-typescript/ ; https://github.com/oxc-project/tsgolint
- **React Compiler rules** (2026-08-18): 22 compiler-derived rules (`purity`, `immutability`, `refs`, `set-state-in-effect`, `error-boundaries`, …); `gating`/`config` not implemented. https://oxc.rs/blog/2026-08-18-react-compiler-support
- **oxfmt 0.71.0** (2026-09-28) — **Beta since 2026-02-24** (alpha 2025-12): **100 % of Prettier's JS/TS conformance tests**, 30× Prettier / 3× Biome on cold runs, built-in import sorting, Tailwind class sorting, package.json sorting; formats JS/TS/JSON/YAML/TOML/HTML/Angular/Vue/Svelte/CSS/SCSS/Less/Markdown/MDX/GraphQL/Handlebars; `oxfmt --migrate prettier`; roadmap to stable: Prettier plugin support, x-in-js, stability. https://oxc.rs/blog/2026-02-24-oxfmt-beta ; https://oxc.rs/docs/guide/usage/formatter.html ; https://www.infoq.com/news/2026/01/oxfmt-rust-prettier/
- Independent head-to-head (2025-07-19, before tsgolint stable): typescript-eslint cold run 7 min vs Biome 2 / oxlint < 1.5 s; author's verdict: oxlint "the right long-term bet" because tsgolint inherits the real checker, whereas Biome's synthesiser "cannot guarantee … alignment with official TS". https://www.solberg.is/fast-type-aware-linting
- Mindshare: State of JS 2025 respondents ESLint 9,697 / Prettier 9,295 / Biome 1,762 / oxlint 123 (survey fielded Nov 2025, before type-aware stable). https://2025.stateofjs.com/en-US/other-tools/

#### ESLint 10 ecosystem

- **ESLint 10.11.0** (2026-09-18); 10.0.0 **2026-02-06**: eslintrc fully removed (`ESLINT_USE_FLAT_CONFIG` gone), Node `^20.19 || ^22.13 || >=24`, config lookup starts from each file's directory (multiple configs per run — monorepo-friendly), JSX reference tracking, Program range change. https://eslint.org/blog/2026/02/eslint-v10.0.0-released/
- **typescript-eslint 8.71.0** (2026-09-28): `projectService` stable (2025-05), `strict-type-checked` / `stylistic-type-checked`; **TS 7 blocked until 7.1** (see §2.2). https://typescript-eslint.io/blog/
- Plugins (npm `latest`, 2026-10-01): `eslint-plugin-unicorn` **76.0.0** (2026-09-19; peer ESLint ≥10.4, Node ≥22), `eslint-plugin-perfectionist` 5.12.1, `eslint-plugin-sonarjs` 4.2.2 (SonarJS 14), `eslint-plugin-security` 4.2.0 (2026-10-01), `eslint-plugin-import-x` 4.17.1, `eslint-plugin-jsdoc` 65.0.1 (Node ^22.22 \|\| ≥24.15), `eslint-plugin-vue` 10.11.1 (ESLint 10 ok), `@stylistic/eslint-plugin` 5.10.0, **`eslint-plugin-react-hooks` 7.1.1** (2026-09-29; `recommended` now includes React Compiler rules `purity`, `immutability`, `refs`, `set-state-in-effect`, `static-components`, `use-memo`, `error-boundaries`…), `@antfu/eslint-config` 9.5.1. https://react.dev/reference/eslint-plugin-react-hooks ; `npm view`
- Architecture boundaries: **dependency-cruiser 18.5.0** (2026-09-30, 7.2k stars, Node ^22||^24||≥26) active; **sheriff** 0.19.6 (2025-09-22, 322 stars) dormant. `npm view`/`gh api`
- Peripheral linters: **cspell 10.3.6** (2026-09-30), **markdownlint-cli2 0.23.3** (2026-09-20), **ls-lint 2.3.1** (2025-06-04, Go binary, dormant-but-stable), **actionlint 1.7.12** (2026-03-30), **zizmor 1.30.1** (2026-09-09; 6.6k stars; 42 audits incl. `template-injection`, `unpinned-uses`, `cache-poisoning`, `dependabot-cooldown`, `use-trusted-publishing`, `artipacked`, `secrets-inherit`, `bot-conditions`; personas regular/pedantic/auditor; `zizmor-action` v0.6.4). https://docs.zizmor.sh/audits/ ; `npm view`/`gh api`. yamllint (Python) — not evaluated.

**Is Biome/oxlint type-aware linting production-ready enough to replace ESLint entirely?** oxlint+tsgolint: **yes for the TypeScript-centric rules** (59/61 typed rules with identical semantics, stable since July 2026, benchmarked at scale on VS Code/TypeScript repos) and for the React Compiler rules. Biome: **no, not for type-aware** (nursery, heuristic inference, same-project only) — but yes as a formatter/linter for untyped rules. Neither replaces `eslint-plugin-vue` template rules, SonarJS cognitive-complexity, `eslint-plugin-security` or `eslint-plugin-jsdoc` today (oxlint's JS plugin API is alpha, so running those plugins inside oxlint is not yet reliable — **unverified** for these specific plugins).

---

### 2.5 Testing

| Tool | Version / date | Key facts | Source |
|---|---|---|---|
| **Vitest** | **5.0.3** (2026-09-30); **5.0.0 2026-09-03**; 4.0 2025-10-22 | 5.0: Node ≥22.12, Vite ≥6.4; −8…−53 % runtime (vm pools, browser mode); Browser Mode **Trace View**; nested projects inherit root config; `vi.when`; `bench` as fixture; breaking: `clearMocks: true` default, strict locators, un-awaited async assertions fail, coverage uses `@vitest/istanbuljs` fork; providers are separate packages (`@vitest/browser-playwright` 5.0.3). 4.0: Browser Mode stable, visual regression, Playwright traces. Docs: with Bun as PM run **`bun run test`, not `bun test`** (Vitest executes under Node). | https://vitest.dev/blog/vitest-5.html ; https://vitest.dev/blog/vitest-4 ; https://vitest.dev/guide/ |
| **bun test** | 1.4.2 | Jest-like API, 40+ matchers, `test.concurrent`, `expectTypeOf`, snapshots (no `addSnapshotSerializer`), `test.failing`, seeded randomisation, parallel files (1.4), VS Code Test Explorer. Coverage: text + **lcov**, thresholds for **lines/functions only** (no branch coverage); DOM via happy-dom (community). `vi` alias compatibility — **unverified**. Only runner that exercises Bun-only APIs (`bun:sqlite`, `Bun.serve`, `Bun.$`). | https://bun.com/docs/test/writing ; https://bun.com/docs/test/coverage ; https://bun.com/blog/bun-v1.3 |
| **Playwright** | **1.63.0** (2026-09-04); 97k stars | 1.63: test locks, cross-frame locators, visible-only locators, ARIA snapshots in traces; 1.62: new component-testing model (stories/galleries), `AbortSignal`, WebP; 1.61: WebAuthn virtual authenticator, Web Storage API, HAR API; 1.59/1.60 (Apr/May 2026): agent-oriented (Screencast API, `browser.bind()`, CLI debugger, planner/generator/healer agents, MCP). Node ≥20. | https://playwright.dev/docs/release-notes ; https://bug0.com/blog/whats-new-playwright-1-59 |
| **Storybook** | **10.6.1** (2026-09-29); 10.0 2025-10-28 | ESM-only, Node 20.19+/22.12+, CSF Next preview; `test-runner` deprecated in favour of **`@storybook/addon-vitest`** (10.6.1 adds Vitest 5 browser tests per release notes). | https://storybook.js.org/docs/releases/migration-guide ; https://www.npmjs.com/package/@storybook/addon-vitest |
| fast-check | 4.10.2 (2026-09-19) | property-based testing. | `npm view` |
| **msw** | **3.0.1** (2026-09-30); 3.0 2026-09-28 | ESM-only, Node ≥22, TS ≥5.9, `defineNetwork()` API, `msw/graphql` split, `worker.stop()` async. | https://github.com/mswjs/msw/releases/tag/v3.0.0 |
| Testcontainers (node) | 12.2.0 (2026-09-28), Node ≥22.22 | Docker-backed integration tests (ideal for the agent sandbox). | `npm view` |
| **Stryker** | 10.0.0 (2026-08-14), Node ≥22 | Vitest runner: threads only, **no browser mode**, per-test coverage; mutation testing is slow — reserve for scheduled runs on core packages. | https://stryker-mutator.io/docs/stryker-js/vitest-runner/ |
| Coverage | `@vitest/coverage-v8` 5.0.3 | v8 provider default (AST-aware remapping), istanbul fork alternative. | `npm view` |
| Trend | State of JS 2025 | "Vitest is climbing the ranks so fast that it wouldn't be surprising to see it overtake [Jest] in the upcoming year". | https://2025.stateofjs.com/en-US/libraries/testing/ |

---

### 2.6 Git hooks & commit conventions

| Tool | Version / date | Facts | Source |
|---|---|---|---|
| **lefthook** | **2.1.16** (2026-10-01); 2.0 2025-10-20; 8.9k stars MIT | Single Go binary (npm/brew/go/pipx/apt); `lefthook.yml` jobs with `parallel`/`piped`, `glob`, `{staged_files}`, `stage_fixed`, `root`, `tags`, scripts; `lefthook-local.yml`; remotes; skip on merge/rebase; `LEFTHOOK=0` in CI; 2.0 uses `sh` executor on Windows, dropped `skip_output`/regexp excludes. | https://github.com/evilmartians/lefthook |
| husky | 9.1.7 (**2024-11-18**, no release in ~23 months; 35.3k stars) | Still works; de-facto maintenance mode. 2026 comparisons recommend lefthook for speed/parallelism and no node_modules bloat. | `gh api`; https://www.pkgpulse.com/guides/husky-vs-lefthook-vs-lint-staged-git-hooks-nodejs-2026 ; https://www.andymadge.com/2026/03/10/git-hooks-comparison/ |
| simple-git-hooks | 2.14.0 (2026-08-28) | Minimal alternative. | `gh api` |
| **commitlint** | **21.2.3** (2026-09-19); v21 2026-05-08; Node ≥22.12; 18.8k stars | `commitlint.config.ts/.mts/.cts` supported (cosmiconfig); `@commitlint/config-conventional`: `type-enum` [build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test], lower-case type, subject not sentence/start/pascal/upper-case, no trailing period, header ≤100, body/footer lines ≤100, leading blank lines (warn). | https://commitlint.js.org/reference/configuration.html ; https://github.com/conventional-changelog/commitlint/tree/master/@commitlint/config-conventional |
| **cocogitto** | 7.0.0 (2026-03-04); 1.2k stars; Rust | `cog check/commit/bump/changelog`, Tera templates, monorepo package resolver (breaking in 7.0), `cocogitto-action` v4.1.0 (2025-11-05), cocogitto-bot. Nice but a second ecosystem (Rust) with small community. | https://github.com/cocogitto/cocogitto ; `gh api` |
| cz-git / czg | 1.14.0 (2026-08-22) | Interactive conventional-commit prompt (commitizen adapter + standalone `czg`). | `npm view` |
| conventional-pre-commit | — | Python `pre-commit` hook; **not evaluated** (unverified). | — |
| CI validators | `wagoid/commitlint-github-action` v6.2.1 (tags only, 402 stars); **`amannn/action-semantic-pull-request` v6.1.1** (2025-08-22, 1.4k stars; used by Electron/Vite); `cocogitto-action` v4.1.0 | action-semantic-pull-request validates the **PR title** (types, scopes, `requireScope`, `subjectPattern`, `wip`, `ignoreLabels`) — the right gate when the repo uses squash merges. | https://github.com/amannn/action-semantic-pull-request |

**Squash-merge pattern**: enforce Conventional Commits on the PR title (action-semantic-pull-request) and set the repository's squash-merge default commit message to "Pull request title" so every commit on `main` is conventional regardless of what contributors committed on branches (GitHub setting; long-standing, **not re-verified** in this pass). Keep commitlint locally (commit-msg hook) for your own commits.

**gitmoji vs conventional emoji**: keep commit subjects plain Conventional Commits (tool-parseable by commitlint/changelogen/release-please/git-cliff) and let the changelog generator add emoji per section. changelogen's default type map: `feat` → 🚀 Enhancements, `perf` → 🔥 Performance, `fix` → 🩹 Fixes, `refactor` → 💅 Refactors, `docs` → 📖 Documentation, `build` → 📦 Build, `chore` → 🏡 Chore, `test` → ✅ Tests, `style` → 🎨 Styles, `ci` → 🤖 CI (https://github.com/unjs/changelogen). git-cliff's shipped config uses 🚀 Features / 🐛 Bug Fixes / 📚 Documentation / ⚡ Performance (https://git-cliff.org/docs/configuration/git). Putting gitmoji *in* subjects breaks `type-enum` unless you write a custom parser preset.

---

### 2.7 Changelog & release

| Tool | Version / date | Facts | Source |
|---|---|---|---|
| **changelogen** (unjs) | npm **0.6.2** (released 2025-07-06); commits on `main` as recent as 2026-09-04 (fixes merged, not yet released); 1.3k stars MIT | Conventional commits → emoji-sectioned changelog; `--bump`, `--release` (bump + commit + tag + GitHub release), `--push`, `--publish`, `--prerelease`, `--canary`; `changelogen gh release` syncs releases from CHANGELOG; token from `GITHUB_TOKEN`/`gh` CLI; config in `changelog.config.ts`, `.changelogrc` or package.json `changelog`. Monorepo support is thin (single root version). | https://github.com/unjs/changelogen ; `gh api` commits |
| **bumpp** (antfu) | 12.3.0 (2026-09-03) | Interactive version bump across workspace packages (`-r`), tag + push; pairs with changelogen. | `npm view` |
| **release-please** | **17.11.2** (2026-08-24); `googleapis/release-please-action` v5.0.0 (2026-04-22); 7.6k stars Apache-2.0 | Release-PR model, manifest mode for monorepos (`release-please-config.json` + `.release-please-manifest.json`), GitHub Releases + notes; section titles configurable (emoji titles possible via `changelog-sections` — **unverified**). | https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md ; `gh api` |
| **git-cliff** | **2.14.2** (2026-09-18); 12.3k stars Apache-2.0; npm `git-cliff` 2.14.2 | `cliff.toml` with `commit_parsers` → emoji groups, `protect_breaking_commits`, `tag_pattern`, `link_parsers`; GitHub integration (`remote.github`, PR numbers/authors, first-time contributors, `-c github` template); `--bump`; `--include-path` for monorepos; GitHub Action `orhun/git-cliff-action`/`tj-actions/git-cliff`. | https://git-cliff.org/docs/configuration/git ; https://git-cliff.org/docs/integration/github |
| **changesets** | **3.0.3** (2026-09-14); 3.0.0 2026-08-11 (`changeset tag` → `git-tag`, engines npm ≥10.9/pnpm ≥10/yarn ≥4.5.2, `version` exits 1 when nothing) ; 12.5k stars | Intent-file model (not commit-driven) — best for independently versioned npm packages, awkward with a CC-first single-version app. | https://github.com/changesets/changesets/releases |
| semantic-release | 25.0.9 (2026-08/09); 25.0 2025-10-15; 24.1k stars | Fully automatic on push to `main`, plugin-heavy, no CHANGELOG file by default, monorepo via 3rd-party. | `gh api` |
| release-it | 21.1.0 (2026-09-17); Node ^22.22 \|\| ^24.15 \|\| ≥26; + `release-it-changelogen` plugin | Generic orchestrator; a sound alternative wrapper around changelogen. | `npm view` ; https://github.com/jcamp-code/release-it-changelogen |
| knope | 0.23.0 (2026-05-24); 193 stars | Rust; too small a community. | `gh api` |
| "unrelease" | — | `unjs/unrelease` does not exist on GitHub (**unverified/likely misremembered**). | `gh api` 404 |
| **softprops/action-gh-release** | **v3.0.3** (2026-08-30); v3.0.0 2026-04-12 (Node 24); v2.6.2 is the final, unmaintained Node-20 line | Creates/updates releases and uploads assets; with **immutable releases** you must create as `draft: true`, attach all assets, then publish (issue #653). | https://github.com/softprops/action-gh-release/releases ; https://github.com/softprops/action-gh-release/issues/653 |
| **Immutable releases** | GA (changelog reports 2025-10-28) | Once published: assets can't be added/modified/deleted, tag can't move; title/notes/pre-release flag still editable; a signed **release attestation** (Sigstore bundle; verifiable with `gh attestation verify`) is generated; enable per repo/org; existing releases stay mutable unless republished. | https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases ; https://github.blog/changelog/2025-09-18-immutable-releases-are-now-generally-available/ |
| **actions/attest-build-provenance** | **v4.2.2** (2026-08-06; v4.0 2026-02-25; action releases themselves immutable) ; `actions/attest` v4.2.2 | **SLSA v1.0 Build L2** by default; **L3** when the build runs in a shared reusable workflow; public repos use Sigstore Public Good (transparency log); verify with `gh attestation verify`. | https://docs.github.com/en/actions/concepts/security/artifact-attestations |
| cosign | `sigstore/cosign-installer` v4.1.2 (2026-05-07) | `cosign sign-blob` for binaries if you want signatures outside GitHub's attestation format; `anchore/sbom-action` v0.24.2 for SBOMs. | `gh api` |
| **npm trusted publishing** | npm CLI ≥ 11.5.1, Node ≥ 22.14 | OIDC from GitHub-hosted runners / GitLab / CircleCI (no self-hosted runners yet); configure repo + workflow filename (+ optional environment) on npmjs.com; `permissions: id-token: write`; **provenance generated automatically** for public repos; ≤10 publishers per package. Community reports: classic tokens revoked registry-wide 2025-12-09, granular tokens expire ≤90 days, and trusted-publisher configs created after 2026-05-20 must explicitly select permitted actions. | https://docs.npmjs.com/trusted-publishers ; https://philna.sh/blog/2026/01/28/trusted-publishing-npm/ ; https://bex.co/blog/2026/09/10/npm-trusted-publishing-oidc-tokenless-pipeline |
| Homebrew tap | `Justintime50/homebrew-releaser` v4 | Generates a formula in your tap from release assets (`target_darwin_arm64`, `target_linux_arm64`, …), checksums, commits. | https://github.com/Justintime50/homebrew-releaser |
| cargo-dist-like for JS | **`dist` (axodotdev/cargo-dist)** supports **generic non-Rust projects** via `dist.toml` + `build-command` + `binaries`; produces tarballs/zips, shell + PowerShell installers, Homebrew/npm/MSI installers and GitHub Releases. 2.1k stars, actively maintained. Wrapping `bun build --compile` per target is plausible but **untested** here. | https://github.com/axodotdev/cargo-dist ; https://raw.githubusercontent.com/axodotdev/cargo-dist/main/book/src/quickstart/everyone-else.md |
| Tauri | `tauri-apps/tauri-action` **v1** (action-v1.0.0, 2026-06-29); `@tauri-apps/cli` 2.12.1 (2026-10-01) | Matrix: macOS `aarch64-apple-darwin` + `x86_64-apple-darwin`, ubuntu-22.04, windows; outputs .app/.dmg, AppImage/.deb/.rpm, .msi/NSIS; `tagName` with `__VERSION__`, `releaseDraft`, updater `latest.json` + `.sig`. | https://github.com/tauri-apps/tauri-action |

**Friendliest output** ranking (emoji headings, contributor credit, readable on GitHub Releases): changelogen ≈ git-cliff (with GitHub remote integration: PR links, authors, first-time contributors) > release-please (plain "Features / Bug Fixes", excellent automation) > changesets (human-written summaries) > semantic-release (terse).

---

### 2.8 Dependency automation & supply chain

| Fact | Evidence |
|---|---|
| **Renovate 44.131.2** (2026-10-01; AGPL-3.0; 22.6k stars; hosted Mend app free for GitHub). `config:best-practices` = `config:recommended` + `docker:pinDigests` + `helpers:pinGitHubActionDigests` + `:configMigration` + `:pinDevDependencies` + `abandonments:recommended` + **`security:minimumReleaseAgeNpm` (= `minimumReleaseAge: "3 days"` for `npm` datasource)** + `:maintainLockFilesWeekly`. Docs recommend **14 days** when automerging third-party deps. Because the preset's packageRule beats a top-level `minimumReleaseAge`, override with your own `packageRules` or `ignorePresets: ["security:minimumReleaseAgeNpm"]`. Options: `osvVulnerabilityAlerts`, `vulnerabilityAlerts`, `lockFileMaintenance`, `automerge` (`automergeType` pr/branch, `platformAutomerge`), `matchCurrentAge`, `abandonmentThreshold`, `dependencyDashboard`. | https://docs.renovatebot.com/upgrade-best-practices/ ; https://docs.renovatebot.com/presets-security/ ; https://docs.renovatebot.com/configuration-options/ ; https://github.com/renovatebot/renovate/discussions/39963 |
| Renovate **bun manager**: supports `bun.lock` and `bun.lockb`, lockfile maintenance delegated to `bun`; package.json is excluded from the npm manager when bun-managed. **pnpm catalogs** supported (`depType pnpm.catalog.<name>`). | https://docs.renovatebot.com/modules/manager/bun/ ; https://docs.renovatebot.com/modules/manager/npm/ |
| **Dependabot**: version updates now wait a **3-day cooldown by default** (no config); `cooldown: { default-days, semver-major-days, semver-minor-days, semver-patch-days, include, exclude }`; **`bun` is a supported `package-ecosystem`** with cooldown; grouping (`groups`, `group-by: dependency-name` across directories, Feb 2026) and `multi-ecosystem-groups` (cooldown must then live on each entry); security updates bypass cooldown/schedule. GitHub blog guide 2026-07-29. | https://github.com/dependabot/dependabot-core/discussions/15582 ; https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference ; https://github.blog/security/supply-chain-security/tame-dependabot-group-your-updates-slow-the-cadence-keep-security-fast/ |
| **Shai-Hulud**: Sept 2025 self-replicating npm worm (phished maintainer accounts → post-install credential theft → auto-publishing to any package the token could reach; 500+ packages incl. `@ctrl/tinycolor`; CISA alert 2025-09-23). **Second wave 2025-11-24**: ~796 packages / 20M+ weekly downloads (Datadog/Wiz), exfiltration via public GitHub repos, no C2. trigger.dev published a post-mortem of being hit. | https://unit42.paloaltonetworks.com/npm-supply-chain-attack/ ; https://www.wiz.io/blog/shai-hulud-2-0-ongoing-supply-chain-attack ; https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem ; https://trigger.dev/blog/shai-hulud-postmortem |
| Mitigations now standard: **`ignore-scripts`/blocked lifecycle scripts** (Bun default; pnpm 11 `strictDepBuilds` + `allowBuilds`; npm needs `ignore-scripts=true` and `allow-git=none` to close the `.npmrc`-in-git-dep hole), **minimum release age** (pnpm 11: 1 day default; Yarn 4.10 `npmMinimalAgeGate` 3d; npm 11.10 `min-release-age` explicit; Bun `--minimum-release-age`), frozen lockfiles in CI (`bun ci`), provenance/trusted-publisher regression checks, `pnpm approve-builds`, Socket.dev scanning (socket-cli 1.1.146 — not evaluated in depth), LavaMoat (webpack-v3.0.0 2026-09-25; heavy, app-level), `npm audit signatures` (**not re-verified** this pass). | https://lilting.ch/en/articles/pnpm-11-minimum-release-age-default-shai-hulud-defense ; https://www.nodejs-security.com/blog/hardening-your-npm-pnpm-config-for-shai-hulud ; https://github.com/lirantal/npm-security-best-practices ; https://snyk.io/articles/npm-security-best-practices-shai-hulud-attack/ |

---

### 2.9 GitHub Actions (2026)

| Item | Current major / date | Notes | Source |
|---|---|---|---|
| `actions/checkout` | **v7.0.1** (2026-07-20); v7.0.0 2026-06-18 | ESM; **blocks checking out fork PR heads under `pull_request_target`/`workflow_run`** (security). | `gh api` release body |
| `actions/setup-node` | **v7.0.0** (2026-07-14) | ESM, `cache-primary-key`/`cache-matched-key` outputs, docs for npm Trusted Publishing; v6 still maintained (6.5.0). | `gh api` |
| `actions/cache` | **v6.1.0** (2026-06-26); v6.0 ESM; v5.0 (2025-12-11) Node 24, **requires runner ≥ 2.327.1** | | `gh api` |
| `actions/upload-artifact` | **v7.0.1** (2026-04-10); v7.0 2026-02-26 | `archive: false` direct single-file uploads; ESM. | `gh api` |
| `actions/github-script` | **v9.0.0** (2026-04-09) | `getOctokit` factory; `require('@actions/github')` no longer works (ESM-only). | `gh api` |
| `actions/labeler` | v7.0.0 (2026-07-21) | | `gh api` |
| `oven-sh/setup-bun` | **v2.2.0** (2026-03-14) | `bun-version`/`bun-version-file` (`.bun-version`, `.tool-versions`, `packageManager`, `engines.bun`); caches the **executable only** — cache `~/.bun/install/cache` yourself with `actions/cache` keyed on `bun.lock` (community pattern). | https://github.com/oven-sh/setup-bun ; https://bun.com/guides/runtime/cicd |
| `pnpm/action-setup` / `pnpm/setup` | v6.1.0 (2026-09-05) / **v3.0.0** (2026-09-20) | see §2.3 | |
| `softprops/action-gh-release` | v3.0.3 | see §2.7 | |
| `actions/attest-build-provenance` | v4.2.2 | see §2.7 | |
| `step-security/harden-runner` | **v2.21.1** (2026-08-30) | egress `audit`→`block`, file-integrity + process monitoring; Community tier free for public repos; block mode Linux only (macOS/Windows audit). | https://github.com/step-security/harden-runner |
| `ossf/scorecard-action` | v2.4.4 (2026-07-23) | | `gh api` |
| `zizmorcore/zizmor-action` | v0.6.4 (2026-09-09) | run `zizmor --persona pedantic .github/workflows` | https://docs.zizmor.sh/audits/ |
| `rhysd/actionlint` | 1.7.12 (2026-03-30) | | `gh api` |
| `amannn/action-semantic-pull-request` | v6.1.1 | PR title lint | §2.6 |
| `vercel/setup-turborepo-remote-cache-action` | v1.1.0 (2026-08-21) | OIDC → `TURBO_TOKEN` | §2.3 |
| `tauri-apps/tauri-action` | v1 | §2.7 | |
| **Hosted runners (free & unlimited on public repos)** | — | `ubuntu-latest/24.04/22.04/26.04` and **`ubuntu-24.04-arm` / `ubuntu-22.04-arm` / `ubuntu-26.04-arm`** (4 vCPU/16 GB; arm64 GA for public repos 2025-08-07 after Jan 2025 preview), `ubuntu-slim` (1 vCPU/5 GB), `windows-2025/2022/latest`, **`windows-11-arm`**, `macos-14/15/26/latest` (M1, 3 vCPU/7 GB), `macos-15-intel/26-intel`, `xcode-27`. arm labels fail in private repos. | https://docs.github.com/en/actions/reference/github-hosted-runners ; https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/ |
| CodeQL default setup | — | Free for public repos; JS/TS needs no config; runs on PRs + weekly schedule. | https://docs.github.com/en/code-security/code-scanning/enabling-code-scanning/configuring-default-setup-for-code-scanning |
| Merge queue | — | Requires `on: merge_group`; FIFO groups with min/max PRs, timeouts. **Availability for personal-account repos not stated in the docs fetched; recollection is that merge queue is only for organization-owned repos — unverified.** | https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue |
| Rulesets / required workflows | — | Repository branch/tag rulesets (required status checks, signed commits, linear history, PR required, restrict deletions); **organization-wide rulesets and required-workflow rules need Team/Enterprise**; push rulesets private/internal only. Free-plan availability of repo-level rulesets for public repos is not explicitly stated (**unverified**, classic branch protection definitely works). | https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets ; https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository |
| Caching strategy | — | Bun: `actions/cache` on `~/.bun/install/cache` (key `bun-${{ hashFiles('bun.lock') }}`); Turborepo: Vercel remote cache (free) or `actions/cache` on `.turbo`; pnpm: `pnpm/setup cache: true`. zizmor's `cache-poisoning` audit flags caches in **release** workflows — don't restore caches in tag-triggered release jobs. | https://turborepo.dev/docs/guides/ci-vendors/github-actions ; https://docs.zizmor.sh/audits/ |

---

## 3. Ranked recommendations (with rationale and risks)

### 3.1 Runtime (core + CLI)

1. **Bun 1.4.x (pin exact, e.g. `1.4.2`) — recommended.** Rationale: one `bun build --compile --target=…` per platform from a single Linux runner covers mac/linux/windows × x64/arm64 + musl (verified today), 59–82 MB binaries vs ~115 MB+ for Node SEA (still "active development", macOS-x64 untested, cross-compiles only without code cache) and much larger un-bundled Deno outputs; built-in SQLite, WebSocket server with pub/sub (perfect for the office-sim event stream and phone remote), `Bun.$` for git/docker orchestration, `Bun.secrets` for provider tokens on desktop, workspaces + catalogs + supply-chain-safe installs; Anthropic ownership guarantees investment (Claude Code runs on it) and gives a strong showcase narrative; 21 % State of JS usage and growing. Risks: (a) the Rust rewrite is 6 weeks old in stable — expect 1.4.x point releases with regressions (1.4.1 closed 202 issues); mitigate by pinning, running the test suite on Bun canary weekly, and keeping the core free of Bun-only APIs behind an adapter layer (`bun:sqlite`/`node:sqlite`, `Bun.serve`/`node:http`) so a Node fallback remains feasible; (b) `node:sea`, `node:vm`, `cluster`, inspector gaps — irrelevant for ByteBureau except `node:vm` if you plan JS-sandboxing (use Docker instead); (c) `Bun.secrets` needs a secret-service daemon on Linux — on headless Raspberry Pi fall back to an encrypted file; (d) Windows metadata/icons require a Windows runner (cheap, `windows-2025`).
2. **Node.js 26 LTS (from 2026-10-28) — compatibility baseline**, not the binary runtime: shared packages (`@bytebureau/*` SDK, plugin API) should run on Node 26 via native type stripping (`erasableSyntaxOnly`), so third-party plugins can be written for either runtime. Use Node 24/26 in CI matrix for the SDK packages only.
3. **Deno 2.9 — rejected for core.** Cross-compile is comparable and `deno desktop` is intriguing, but binaries are larger unless the experimental `--bundle` works for your dependency graph, mindshare is half of Bun's, and the npm/`node_modules` story adds friction with Tauri/Vite tooling.

### 3.2 TypeScript

- **TS 7.0.2 for `tsc --build --builders` type-checking and the editor** (VS Code native extension; WebStorm support **unverified** — see open questions). Keep **TS 6.0.3 aliased as `typescript6`** (`@typescript/typescript6`) for typescript-eslint/vue-tsc until **7.1 (2026-11-24)** and typescript-eslint's TS7 release land. Adopt `@tsconfig/strictest` + `@tsconfig/node26`/`@tsconfig/bun`, `nodenext`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `isolatedDeclarations` (published packages), `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`. Skip `ts-reset` (dormant; `strictest` + `noUncheckedIndexedAccess` cover most of it) unless you want its `Array.includes`/`JSON.parse` fixes.

### 3.3 Monorepo

1. **Bun workspaces (package manager) + Turborepo 2.11 (task graph, caching).** Lean, trendy, free remote cache via OIDC, bun stable in Turborepo's support policy, Renovate/Dependabot/knip understand `bun.lock`. Start with `bun --filter` scripts; add `turbo.json` when caching pays off (probably day one for `typecheck`/`test`).
2. **pnpm 12 + Turborepo** — fallback if Bun's lockfile/install behaviour causes trouble; best-in-class supply-chain defaults, `pnpm/setup` v3 installs Bun too.
3. Nx 23 / moon 2.5 — rejected (Nx: licence/plugin weight; moon: negligible mindshare).

Publishing: **tsdown 0.23** (+ `publint`, `arethetypeswrong`), `isolatedDeclarations` for fast dts; **knip 6** in CI (`--production` for the app, default for libs).

### 3.4 Lint/format (strictest *and* trendy)

1. **oxlint 1.86 type-aware + oxfmt 0.71** (via `ultracite` or your own `.oxlintrc.json`): enable all categories (`correctness`, `suspicious`, `pedantic`, `perf`, `restriction`, `style`) as `error`, `options.typeAware: true`, `typeCheck: true` in CI (shared program also reports compiler errors), `react` plugin with Compiler rules, nested configs per workspace. Risks: oxfmt is beta (formatting diffs are "bugs", but a stable 1.0 isn't dated); JS plugin API alpha; oxlint has no Vue-template rule set. Mitigation: pin versions; Renovate on a 7-day cooldown.
2. **CI-only ESLint 10 "long tail"** (not in pre-commit): `eslint-plugin-vue` (if the UI is Vue), `eslint-plugin-sonarjs` (cognitive complexity), `eslint-plugin-security`, `eslint-plugin-jsdoc` (public SDK), `eslint-plugin-perfectionist` (or rely on oxfmt import sorting), `@typescript-eslint` `strict-type-checked`+`stylistic-type-checked` with `projectService` pinned to TS 6 alias — drop the typed ESLint rules once oxlint covers them (it already covers 59/61) to keep CI fast.
3. **Biome 2.5 single-tool setup** — the simplest option if you'd rather not run a beta formatter; stable formatter, 500+ rules, Vue SFC support, GritQL plugins; weaker on type-aware rules.
4. **ESLint-only stack** — rejected as primary (slow, TS7-blocked).

Supporting: `knip`, `dependency-cruiser` (architecture boundaries; sheriff is dormant), `cspell`, `markdownlint-cli2`, `actionlint`, `zizmor --persona pedantic`, optional `ls-lint`.

### 3.5 Testing

- **Vitest 5** default (`bun run test` → Node), **`@vitest/browser-playwright`** for UI components + **Storybook 10.6 addon-vitest**; **`bun test`** only inside `packages/*-bun` that touch Bun-only APIs (lcov output, lines/functions coverage); **Playwright 1.63** for browser E2E (test locks + cross-frame locators are handy for multi-agent UI); **fast-check 4** for scheduler/state-machine invariants; **msw 3** for provider API mocks; **Testcontainers 12** for Docker-sandbox integration tests (run on `ubuntu-24.04-arm` too to cover Pi 5). **Stryker 10** weekly on `packages/core` only. Coverage: `@vitest/coverage-v8` with thresholds; merge Bun lcov into the same report.

### 3.6 Hooks & commits

- **lefthook 2.1** (pre-commit: `oxfmt --check`/`oxlint --fix` on `{staged_files}` with `stage_fixed`, `cspell`; commit-msg: `commitlint`; pre-push: `tsc --build` + `bun run test --changed`), **commitlint 21 + config-conventional** in `commitlint.config.ts` (extend `type-enum` with `deps`?—keep standard), optional **czg** prompt. CI: **amannn/action-semantic-pull-request** on PR title (squash merge, PR-title default), **wagoid/commitlint-github-action** for commit history on PRs (optional). cocogitto rejected (second toolchain, small community) — but if you later want Rust-binary-only tooling it is viable.

### 3.7 Changelog & release

1. **changelogen + bumpp** (`bumpp -r` → `changelogen --release --push` → tag) with GitHub Release notes generated by changelogen's emoji sections; release workflow on `v*` tags builds Bun binaries (linux-x64 runner cross-compiles all 8 targets; Windows runner only if you need icon/console metadata), Tauri bundles (macOS `macos-26` both archs, `ubuntu-22.04` + `ubuntu-24.04-arm`, `windows-2025`), attests with `actions/attest-build-provenance` v4, uploads to a **draft** release via `action-gh-release` v3, then publishes (immutable), publishes npm packages via **trusted publishing** (OIDC, auto-provenance), and updates the Homebrew tap (`homebrew-releaser` v4). Risks: changelogen's release cadence is slow (0.6.2 from 2025-07; fixes pending) and single-version only — fine for an app with one version; if the plugin SDK needs independent versions later, migrate to **release-please manifest** (#2) or **changesets**.
2. **release-please (manifest mode)** — strongest hands-off automation and monorepo versioning; less pretty notes; Google-maintained.
3. **git-cliff** — best customisation + GitHub contributor metadata; Rust binary; choose if changelogen's gaps bite.
4. `dist` (cargo-dist generic mode) — worth a spike as a "cargo-dist for Bun binaries" (installers for shell/PowerShell/Homebrew/npm in one tool); unproven here.
5. semantic-release, changesets (for this repo shape), knope, release-it — rejected/secondary (see §4).

### 3.8 Dependency automation

- **Renovate** with `config:best-practices`, `osvVulnerabilityAlerts: true`, `minimumReleaseAge: "7 days"` (14 for automerged), `lockFileMaintenance` weekly, grouped non-major updates, `automerge` for devDependencies minor/patch via `platformAutomerge` gated by required checks, `helpers:pinGitHubActionDigests` (SHA pinning), `bun` manager auto-detected. **Dependabot: alerts + security updates only** (no `dependabot.yml` version updates) to avoid duplicate PRs. Add `[install] minimumReleaseAge = 259200` (3 days) in `bunfig.toml`, keep `trustedDependencies` minimal, `bun ci` in CI, npm trusted publishing, Scorecard + harden-runner.

### 3.9 GitHub Actions

See the pipeline outline in §3.11.

### 3.10 Recommended toolchain table

| Area | Tool → version (observed) | Why | Risk |
|---|---|---|---|
| Runtime/binaries | Bun 1.4.2 (`bun build --compile`) | Cross-compiles 8 targets, 59–82 MB, batteries included, Anthropic-backed | Fresh Rust rewrite; pin + canary tests |
| Compat baseline | Node 26 (LTS 2026-10-28) | Plugins/SDK on native type stripping | Only erasable TS syntax |
| Language | TypeScript 7.0.2 (+ 6.0.3 alias for lint/vue-tsc until 7.1 on 2026-11-24) | 8–12× faster `tsc`, parallel builders | No API in 7.0; tool lag |
| Package manager | Bun workspaces + catalogs | Fast, isolated installs, scripts blocked by default, `bun ci` | Lockfile tooling younger than pnpm's |
| Task runner | Turborepo 2.11.6 | Free remote cache (OIDC), bun stable, `turbo query affected` | 3.0 deprecations pending |
| Lib bundler | tsdown 0.23.0 + publint 0.3.25 + attw 0.18.5 | Rolldown/Oxc, isolated declarations | Pre-1.0 config churn |
| Linter | oxlint 1.86.0 + oxlint-tsgolint 7.0.2003 (type-aware) | 59/61 typed rules, 12–18× faster, React Compiler rules | JS plugins alpha; no Vue template rules |
| Formatter | oxfmt 0.71.0 (beta) — fallback Biome 2.5.15 | 100 % Prettier conformance, 30× faster | Beta |
| Long-tail lint (CI) | ESLint 10.11 + typescript-eslint 8.71 + vue 10.11 + sonarjs 4.2 + security 4.2 + jsdoc 65 | Rules oxlint lacks | TS 7 blocked; slow |
| Dead code | knip 6.39.0 | Unused exports/deps/catalog entries | — |
| Architecture | dependency-cruiser 18.5.0 | Boundaries between core/plugins/ui | — |
| Unit/component | Vitest 5.0.3 (+ browser-playwright, Storybook 10.6 addon-vitest) | Fastest + browser mode + trace view | Bun-only APIs need `bun test` |
| E2E | Playwright 1.63.0 | Test locks, agents, traces | — |
| Property/mocks/containers | fast-check 4.10, msw 3.0, testcontainers 12.2 | — | msw 3 ESM-only |
| Mutation | Stryker 10.0 (weekly) | Catch weak tests in core | Slow; no browser mode |
| Hooks | lefthook 2.1.16 | Go binary, parallel, `stage_fixed` | — |
| Commit lint | commitlint 21.2.3 + config-conventional; czg 1.14 | TS config, standard rules | — |
| PR title | amannn/action-semantic-pull-request v6.1.1 | Squash-merge gate | Last release 2025-08 |
| Changelog/version | changelogen 0.6.2 + bumpp 12.3.0 | Emoji sections, `gh release` sync | Slow releases; single version |
| GitHub release | softprops/action-gh-release v3.0.3 + immutable releases + actions/attest-build-provenance v4.2.2 | Locked assets, SLSA L2/L3 | Draft-then-publish dance |
| npm publish | npm trusted publishing (npm ≥11.5.1) | Tokenless, auto provenance | GitHub-hosted runners only |
| Desktop | tauri-action v1 | Per-OS bundles + updater | macOS signing/notarisation cost |
| Homebrew | homebrew-releaser v4 | Auto formula | PAT to tap repo |
| Deps | Renovate 44 (`config:best-practices`) + Dependabot alerts | Cooldowns, SHA pinning, bun.lock | AGPL (hosted app fine) |
| CI security | harden-runner v2.21, zizmor 1.30, actionlint 1.7.12, CodeQL default, scorecard v2.4.4 | Shai-Hulud-era hygiene | — |
| Actions | checkout v7, setup-node v7, setup-bun v2.2, cache v6, upload-artifact v7, github-script v9, labeler v7 | Node 24/ESM majors | `require()` breaks in github-script v9 |

### 3.11 Sample lint-strictness checklist

- [ ] `tsconfig`: `strictest` + `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `noImplicitOverride`, `noUncheckedSideEffectImports`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `isolatedDeclarations` (libs), `types: []` explicit.
- [ ] oxlint: all categories `error`; `typeAware: true`; typed rules `no-floating-promises`, `no-misused-promises`, `await-thenable`, `no-unnecessary-condition`, `strict-boolean-expressions`, `switch-exhaustiveness-check`, `no-unsafe-*`, `prefer-readonly`, `restrict-template-expressions`, `no-deprecated`; `import/no-cycle`, `import/no-default-export` (except config files), `unicorn/*` recommended, `react` + React Compiler rules (if React), `jsx-a11y`, `promise`, `node`, `vitest`.
- [ ] oxfmt: default Prettier-compatible style, built-in import sorting, `--check` in CI.
- [ ] ESLint (CI only): `vue/*` (if Vue), `sonarjs/cognitive-complexity` ≤ 15, `security/*`, `jsdoc/require-jsdoc` for exported SDK symbols, `perfectionist` if not using oxfmt sorting.
- [ ] knip: zero unused files/exports/deps; `--production` for apps.
- [ ] dependency-cruiser: `core` must not import `ui`/`plugins`; plugins only via `@bytebureau/sdk`; no circulars.
- [ ] cspell (cs+en dictionaries for i18n strings), markdownlint-cli2, actionlint, `zizmor --persona pedantic`, `ls-lint` (file naming), `publint` + `attw --profile esm-only` for published packages.
- [ ] Commits: config-conventional + `scope-enum` of workspace names; PR title validated; squash merge.
- [ ] Coverage thresholds (lines/branches) enforced in Vitest; Bun lcov merged.

### 3.12 CI pipeline outline (GitHub Actions)

```
.github/workflows/
  ci.yml                (pull_request, push main, merge_group)      ~5–6 min wall-clock target
  pr-title.yml          (pull_request_target: opened/edited)        action-semantic-pull-request (read-only perms)
  security.yml          (push main, schedule weekly)                scorecard, zizmor, CodeQL default (UI), osv
  release.yml           (push tags v*)                              ~15–20 min target
  canary.yml            (schedule nightly)                          bun canary + Node 27 alpha matrix
  renovate via Mend app; dependabot alerts only
```

**ci.yml** — `permissions: read-all`; `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`; every step `harden-runner` (`egress-policy: audit` → `block` once the allowlist is known); all `uses:` pinned to SHAs.

1. `setup` job (ubuntu-24.04): `oven-sh/setup-bun` (version from `.bun-version`), restore `~/.bun/install/cache` (`bun-${{ hashFiles('bun.lock') }}`), `bun ci`, `vercel/setup-turborepo-remote-cache-action` (OIDC). Upload nothing; rely on Turbo remote cache.
2. `static` job: `bun turbo run lint format:check typecheck knip depcruise spell --affected` (oxlint `--type-aware --type-check`, oxfmt `--check`, `tsc --build --builders`, knip, dependency-cruiser, cspell, markdownlint, actionlint, zizmor). Target ≤ 2.5 min.
3. `unit` job matrix: `ubuntu-24.04` (x64) and `ubuntu-24.04-arm` (Pi-class arm64) → `vitest run --coverage` + `bun test --coverage --coverage-reporter=lcov` in Bun-only packages; upload lcov. Target ≤ 3 min.
4. `e2e` job (ubuntu-24.04, sharded 2×): Playwright on the built web UI + Testcontainers (Docker) for the agent sandbox. Target ≤ 5 min, only on PRs touching `apps/**` or `packages/core/**` (`turbo query affected`).
5. `build-smoke` job: `bun build --compile` for `bun-linux-x64` + `bun-linux-arm64`, run `--version` under QEMU-free native arm runner; Tauri build only on `main` (cache Rust with `Swatinem/rust-cache`).
6. Required status checks: `static`, `unit (x64)`, `unit (arm64)`, `e2e`, `pr-title`. Branch rules: PR required, linear history (squash), signed commits optional. (Merge queue if the repo is org-owned — see open questions.)

**release.yml** (triggered by the tag changelogen pushes) — no caches restored (zizmor `cache-poisoning`); `permissions: contents: write, id-token: write, attestations: write`.

1. `binaries` (ubuntu-24.04): `bun build --compile --minify --sourcemap --bytecode` for all 8 targets (Windows metadata build optionally on `windows-2025`), `sha256sums`, `actions/attest-build-provenance` (subject-path `dist/*`), `cosign sign-blob` optional.
2. `tauri` matrix: `macos-26` (`--target aarch64-apple-darwin` + `x86_64-apple-darwin`, notarisation secrets), `ubuntu-22.04` (AppImage/deb/rpm x64), `ubuntu-24.04-arm` (arm64 deb/AppImage), `windows-2025` (msi/nsis); `tauri-action@v1` with `releaseDraft: true`.
3. `publish-release`: download artifacts → `softprops/action-gh-release@v3` (`draft: true`, body from `changelogen` output or `generate_release_notes: true`) → `gh release edit --draft=false` (immutable from this point; release attestation auto-generated).
4. `npm` (environment `npm-publish`): `bun run build` (tsdown) → `publint`/`attw` → `npm publish --access public` via trusted publishing (no token, auto provenance).
5. `homebrew`: `homebrew-releaser@v4` with darwin/linux arm64/amd64 targets.
6. `post`: `changelogen gh release` sync (if notes were edited), Slack/Discord webhook announcement.

---

## 4. Rejected options & why

| Option | Verdict | Reason |
|---|---|---|
| Node.js SEA as the binary format | Rejected | Stability 1.1, ~115 MB+ per binary, macOS-x64 untested, cross-compile without code cache/snapshot only, ExperimentalWarning at runtime. |
| Deno compile / Deno as core runtime | Rejected | Larger un-bundled binaries, `--bundle` experimental, 11 % usage; `deno desktop` is interesting but Tauri already covers desktop. |
| Biome type-aware rules as the typed gate | Rejected (keep Biome as optional formatter) | Nursery, heuristic, same-project only; oxlint+tsgolint uses the real TS 7 checker with 59/61 rules. |
| ESLint + typescript-eslint as primary linter | Rejected as primary | Slow (minutes vs seconds), TS 7 unsupported until 7.1 + typescript-eslint release; keep as CI-only long tail. |
| Prettier | Rejected | oxfmt passes 100 % of Prettier's JS/TS tests at 30× speed; Biome formatter is the conservative alternative. |
| husky + lint-staged | Rejected | No release since 2024-11; lefthook is faster, parallel, dependency-free. |
| cocogitto | Rejected | Fine tool but a Rust side-ecosystem with ~1.2k stars; commitlint + changelogen stay in the TS toolchain. |
| semantic-release | Rejected | Opinionated push-to-release, plugin sprawl, no CHANGELOG file by default, weak monorepo story. |
| changesets | Deferred | Excellent for independently versioned npm packages; mismatch with a conventional-commit-driven single-version app. Revisit if the SDK needs independent releases. |
| knope, unrelease | Rejected | knope 193 stars; `unjs/unrelease` not found. |
| Nx | Rejected | Heavyweight, licence questions around caching, no advantage for a solo maintainer. |
| moon | Rejected | 23 State-of-JS respondents; 2.0 breaking rewrite in Feb 2026. |
| tsup / unbuild / bunchee / pkgroll | Rejected | tsup dormant (2025-11) and esbuild-based; unbuild dormant (2025-08); bunchee/pkgroll fine but tsdown is the Rolldown-native successor with ATTW integration. |
| Dependabot version updates (alongside Renovate) | Rejected | Duplicate PRs; keep Dependabot for alerts/security updates only. |
| LavaMoat | Deferred | App-level runtime policy; heavy for v1. |
| Stryker on every PR | Rejected | Too slow; weekly schedule on core only. |
| `cargo-dist`/`dist` as the release driver | Deferred (spike) | Generic mode exists but untested with Bun targets; the GitHub-native flow above already covers attestations + immutable releases. |

---

## 5. Open questions for the owner

1. **Runtime abstraction boundary**: may core packages use Bun-only APIs (`bun:sqlite`, `Bun.serve`, `Bun.$`, `Bun.secrets`) directly, or should a thin adapter keep a Node 26 fallback? (Affects testing split and plugin authoring.)
2. **Formatter risk appetite**: oxfmt beta (0.71) now, or Biome's stable formatter until oxfmt 1.0?
3. **UI framework** (React vs Vue — owned by another cluster) decides whether the ESLint long tail is needed at all (eslint-plugin-vue has no oxlint equivalent) and whether vue-tsc's TS-6 pin matters.
4. **WebStorm**: you develop in WebStorm — native TS 7 (`tsgo`) language-server support, oxlint/oxfmt plugins, and `.oxlintrc.json` IntelliSense in WebStorm 2026.x were **not verified**; VS Code support is confirmed.
5. **Versioning model**: one version for the whole product (changelogen/bumpp) vs independent npm versions for the SDK (release-please manifest / changesets)?
6. **Repository ownership**: personal account vs a free GitHub organisation — merge queue and org-level rulesets/required workflows appear to need an organisation (unverified); an org also enables SLSA-L3 shared reusable workflows.
7. **Code signing budgets**: Apple Developer ID + notarisation for Tauri/macOS binaries; Windows signing (Azure Trusted Signing or EV cert) — unsigned Windows binaries trigger SmartScreen. Without Windows signing, cross-compiling Windows from Linux is fine (no icon/metadata).
8. **Raspberry Pi 5 OS**: 64-bit Raspberry Pi OS (glibc) → `bun-linux-arm64`; if you plan Alpine/containers → `-musl` target. Headless Pi: `Bun.secrets` needs a secret-service daemon — accept encrypted-file fallback?
9. **TS 7.1 timing**: accept the `typescript6` alias for lint/vue-tsc until ~2026-11-24, or start on TS 6.0.3 everywhere and flip to 7.1 in December?
10. **Mutation testing and E2E budget**: weekly Stryker on `packages/core` and 2-shard Playwright — enough, or do you want E2E on every PR?
11. **Turborepo "nub"/"aube" package managers** appear in Turborepo 2.11's support policy — unknown to this research; worth a look by the monorepo/package-manager cluster.

---

## 6. Full source list

### Runtimes
- https://devclass.com/2025/12/03/bun-javascript-runtime-acquired-by-anthropic-tying-its-future-to-ai-coding/
- https://gigazine.net/gsc_news/en/20251203-anthropic-acquired-bun/
- https://betterstack.com/community/guides/scaling-nodejs/anthropic-acquires-bun/
- https://bun.com/blog/bun-v1.4
- https://bun.com/blog/bun-v1.3
- https://www.infoq.com/news/2026/09/bun-AI-rewrite-zig-rust-4-months/
- https://www.devclass.com/software/2026/05/11/anthrophics-bun-team-trials-port-from-zig-to-rust/5237835
- https://github.com/oven-sh/bun/pull/30412
- https://bun.com/docs/bundler/executables
- https://bun.com/docs/installation
- https://bun.com/docs/runtime/nodejs-apis
- https://bun.com/docs/runtime/bunfig
- https://bun.com/docs/runtime/secrets
- https://bun.com/docs/runtime/shell
- https://bun.com/docs/api/websockets
- https://bun.com/docs/api/sqlite
- https://bun.com/docs/install/catalogs
- https://bun.com/docs/pm/workspaces
- https://bun.com/docs/pm/filter
- https://bun.com/docs/pm/cli/install
- https://bun.com/docs/pm/cli/publish
- https://bun.com/docs/test/writing
- https://bun.com/docs/test/coverage
- https://bun.com/guides/runtime/cicd
- https://github.com/oven-sh/setup-bun
- https://zenn.dev/dyoshikawa/articles/deno-to-bun-single-binary?locale=en
- https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule
- https://nodejs.org/en/blog/release/v26.0.0
- https://nodejsdesignpatterns.com/blog/whats-new-in-nodejs-26/
- https://nodejs.org/en/about/previous-releases
- https://endoflife.date/nodejs
- https://www.chornous.dev/blog/nodejs-26-temporal-lts/
- https://www.inmotionhosting.com/support/news/nodejs-v26-released/
- https://nodejs.org/docs/latest-v24.x/api/typescript.html
- https://nodejs.org/docs/latest-v26.x/api/typescript.html
- https://nodejs.org/api/single-executable-applications.html
- https://joyeecheung.github.io/blog/2026/01/26/improving-single-executable-application-building-for-node-js/
- https://nodejs.org/api/sqlite.html
- https://nodejs.org/api/permissions.html
- https://nodejs.org/docs/latest-v26.x/api/globals.html
- https://deno.com/blog/v2.9
- https://docs.deno.com/runtime/reference/cli/compile/
- https://deno.com/blog/deno-compile-executable-programs
- https://docs.deno.com/deploy/
- https://www.infoq.com/news/2026/03/state-of-js-survey-2025
- https://2025.stateofjs.com/en-US/other-tools/
- https://2025.stateofjs.com/en-US/libraries/testing/
- (flagged low-quality) https://www.alexcloudstar.com/blog/bun-compatibility-2026-npm-nodejs-nextjs/ ; https://strapi.io/blog/bun-vs-nodejs-performance-comparison-guide

### TypeScript
- https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/
- https://www.infoq.com/news/2026/08/typescript-7-released/
- https://www.theregister.com/devops/2026/07/09/speedier-type-checks-in-typescript-70-as-first-stable-go-release-ships/5268828
- https://github.com/microsoft/TypeScript/issues/63703
- https://github.com/typescript-eslint/typescript-eslint/issues/10940
- https://github.com/typescript-eslint/typescript-eslint/issues/12720
- https://github.com/eslint/eslint/issues/21070
- https://github.com/vuejs/language-tools/issues/6167
- https://github.com/tsconfig/bases
- https://tsdown.dev/options/dts
- https://vite.dev/blog/announcing-vite8
- https://dev.to/dev_encyclopedia/why-your-typescript-7-upgrade-broke-eslint-ts-jest-and-ts-morph-385k

### Monorepo / publishing
- https://pnpm.io/blog/releases/11.0
- https://pnpm.io/blog/releases/12.0
- https://pnpm.io/catalogs
- https://pnpm.io/continuous-integration
- https://github.com/pnpm/setup
- https://socket.dev/blog/pnpm-11-adds-new-supply-chain-protection-defaults
- https://www.infoq.com/news/2026/04/pnpm-11-rc-release/
- https://turborepo.dev/blog/2-11
- https://turborepo.dev/blog/2-9
- https://turborepo.dev/docs/getting-started/support-policy
- https://turborepo.dev/docs/guides/ci-vendors/github-actions
- https://vercel.com/changelog/free-vercel-remote-cache
- https://turborepo.dev/blog/free-vercel-remote-cache
- https://github.com/rolldown/tsdown/releases
- https://moonrepo.dev/blog
- https://knip.dev/
- https://github.com/webpro-nl/knip/releases/tag/knip%406.0.0

### Lint / format
- https://biomejs.dev/blog/biome-v2-5/
- https://biomejs.dev/blog/biome-v2-4/
- https://biomejs.dev/blog/biome-v2-3/
- https://biomejs.dev/blog/roadmap-2026/
- https://biomejs.dev/blog/biome-v2-0-beta/
- https://biomejs.dev/linter/rules/no-floating-promises/
- https://biomejs.dev/linter/domains/
- https://alternativeto.net/news/2025/7/biome-2-1-update-brings-faster-scanning-and-improved-type-inference
- https://oxc.rs/blog/2026-07-22-type-aware-linting-stable
- https://oxc.rs/blog/2026-02-24-oxfmt-beta
- https://oxc.rs/blog/2026-08-18-react-compiler-support
- https://oxc.rs/docs/guide/usage/linter.html
- https://oxc.rs/docs/guide/usage/formatter.html
- https://www.infoq.com/news/2026/09/tsgolint-oxlint-typescript/
- https://www.infoq.com/news/2026/01/oxfmt-rust-prettier/
- https://github.com/oxc-project/tsgolint
- https://www.solberg.is/fast-type-aware-linting
- https://eslint.org/blog/2026/02/eslint-v10.0.0-released/
- https://typescript-eslint.io/blog/
- https://react.dev/reference/eslint-plugin-react-hooks
- https://www.ultracite.ai/
- https://docs.zizmor.sh/audits/

### Testing
- https://vitest.dev/blog/vitest-5.html
- https://vitest.dev/blog/vitest-4
- https://vitest.dev/guide/
- https://voidzero.dev/posts/announcing-vitest-4
- https://playwright.dev/docs/release-notes
- https://bug0.com/blog/whats-new-playwright-1-59
- https://storybook.js.org/docs/releases/migration-guide
- https://www.npmjs.com/package/@storybook/addon-vitest
- https://stryker-mutator.io/docs/stryker-js/vitest-runner/
- https://github.com/mswjs/msw/releases/tag/v3.0.0
- https://dev.to/gabrielanhaia/bun-test-vs-vitest-for-typescript-library-authors-in-2026-19g5

### Hooks / commits
- https://github.com/evilmartians/lefthook
- https://www.pkgpulse.com/guides/husky-vs-lefthook-vs-lint-staged-git-hooks-nodejs-2026
- https://www.andymadge.com/2026/03/10/git-hooks-comparison/
- https://commitlint.js.org/reference/configuration.html
- https://github.com/conventional-changelog/commitlint/tree/master/@commitlint/config-conventional
- https://github.com/cocogitto/cocogitto
- https://github.com/amannn/action-semantic-pull-request

### Changelog / release
- https://github.com/unjs/changelogen
- https://github.com/jcamp-code/release-it-changelogen
- https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md
- https://git-cliff.org/docs/configuration/git
- https://git-cliff.org/docs/integration/github
- https://github.com/changesets/changesets/releases
- https://github.com/softprops/action-gh-release/releases
- https://github.com/softprops/action-gh-release/issues/653
- https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases
- https://github.blog/changelog/2025-09-18-immutable-releases-are-now-generally-available/
- https://docs.github.com/en/actions/concepts/security/artifact-attestations
- https://docs.npmjs.com/trusted-publishers
- https://philna.sh/blog/2026/01/28/trusted-publishing-npm/
- https://bex.co/blog/2026/09/10/npm-trusted-publishing-oidc-tokenless-pipeline
- https://github.com/Justintime50/homebrew-releaser
- https://github.com/axodotdev/cargo-dist
- https://raw.githubusercontent.com/axodotdev/cargo-dist/main/book/src/quickstart/everyone-else.md
- https://github.com/tauri-apps/tauri-action

### Dependency automation / supply chain
- https://docs.renovatebot.com/upgrade-best-practices/
- https://docs.renovatebot.com/presets-security/
- https://docs.renovatebot.com/configuration-options/
- https://docs.renovatebot.com/modules/manager/bun/
- https://docs.renovatebot.com/modules/manager/npm/
- https://github.com/renovatebot/renovate/discussions/39963
- https://github.blog/security/supply-chain-security/tame-dependabot-group-your-updates-slow-the-cadence-keep-security-fast/
- https://github.com/dependabot/dependabot-core/discussions/15582
- https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference
- https://unit42.paloaltonetworks.com/npm-supply-chain-attack/
- https://www.wiz.io/blog/shai-hulud-2-0-ongoing-supply-chain-attack
- https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem
- https://trigger.dev/blog/shai-hulud-postmortem
- https://lilting.ch/en/articles/pnpm-11-minimum-release-age-default-shai-hulud-defense
- https://www.nodejs-security.com/blog/hardening-your-npm-pnpm-config-for-shai-hulud
- https://github.com/lirantal/npm-security-best-practices
- https://snyk.io/articles/npm-security-best-practices-shai-hulud-attack/

### GitHub Actions
- https://docs.github.com/en/actions/reference/github-hosted-runners
- https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/
- https://github.blog/changelog/2025-01-16-linux-arm64-hosted-runners-now-available-for-free-in-public-repositories-public-preview/
- https://github.com/step-security/harden-runner
- https://docs.github.com/en/code-security/code-scanning/enabling-code-scanning/configuring-default-setup-for-code-scanning
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository
- Release notes via `gh api` for: actions/checkout v7.0.0, actions/setup-node v7.0.0, actions/cache v5.0.0 & v6.0.0, actions/upload-artifact v7.0.0, actions/github-script v9.0.0, softprops/action-gh-release v3.0.0, pnpm/action-setup v6.0.0, changesets 3.0.0, msw v3.0.0, stryker v10.0.0, knip 6.0.0, lefthook v2.0.0, rolldown v1.0.0, moon v2.0.0, cocogitto 7.0.0, nx 23.0.0 (see `gh-batch-output.txt`).

### Registry / repo metadata
- `gh api repos/*` (stars, licence, latest release, pushed_at) for 85 repositories — `gh-repo-data.tsv`
- `npm view <pkg> version time.modified engines.node peerDependencies.*` for 75 packages — `npm-data.tsv`
- `gh api repos/*/releases/tags/*` dates for 42 major tags — `tag-dates.tsv`
