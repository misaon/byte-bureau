# ByteBureau — Sub-project 0: Foundation (design spec)

Date: 2026-10-02 · Status: approved design, awaiting written-spec review · Scope: one implementation plan
Inputs: [research synthesis](../../research/2026-10-02-technology-landscape.md), [requirements checklist](../../research/2026-10-02-requirements-checklist.md)
Requirement IDs covered: G01 G03 G04 G17 A10 A16 A18 (scaffold) A22 A23 A24 (v1) A26 A27 A28 A29 A35 A36 F02 F03

## 1. Goal

Produce a production-grade monorepo skeleton whose toolchain, quality gates, CI/CD, release pipeline, licence and community setup are all **proven end to end** by one minimal deliverable: a localised `bytebureau` binary that prints its version and help, built for all eight targets, attested, published as an immutable GitHub release with an emoji changelog. Everything later (kernel, UI, simulation) lands on this foundation without revisiting tooling.

Non-goals: any product behaviour beyond `--version`, `--help` and a localised greeting; the kernel, API, UI, simulation, plugins (sub-projects 1+); npm publishing (first MIT packages appear in sub-project 1); desktop shell; docs content beyond a skeleton.

## 2. Repository layout

```
byte-bureau/
├── apps/
│   ├── bytebureau/            single binary: CLI entry (citty); daemon/API/kernel/UI are wired here in later sub-projects
│   └── docs/                  Astro Starlight site (en + cs locale config), GitHub Pages
├── packages/
│   ├── i18n/                  Paraglide JS 2 project: messages/{en,cs}.json → compiled runtime (generated, gitignored)
│   └── tsconfig/              shared tsconfig bases: base.json, library.json, app.json
├── plugins/                   empty in SP0 (workspace glob reserved; first plugins arrive in SP1)
├── docs/
│   ├── decisions/             MADR 4.0 ADRs (0001–0009, listed in §9)
│   ├── research/              existing research synthesis and raw reports
│   └── superpowers/{specs,plans}/
├── scripts/                   repo-settings.sh (owner-run GitHub configuration), release helpers
├── .github/                   workflows, issue forms, PR template, CODEOWNERS, labeler, FUNDING, dependabot (alerts only)
├── package.json               Bun workspaces ["apps/*","packages/*","plugins/*"] + catalog of shared dependency versions
├── bun.lock · bunfig.toml · .bun-version · mise.toml (bun + node versions for contributors)
├── turbo.json · tsconfig.json (solution) · .oxlintrc.jsonc · .oxfmtrc.json · eslint.config.ts (CI-only long tail)
├── knip.ts · .dependency-cruiser.cjs · cspell.json · .markdownlint-cli2.yaml · lefthook.yml · commitlint.config.ts
├── renovate.json · .editorconfig · .gitattributes · .gitignore · .vscode/{extensions,settings}.json
├── LICENSE.md (FSL-1.1-MIT) · TRADEMARK.md · README.md · README.cs.md · CHANGELOG.md
├── CONTRIBUTING.md · CODE_OF_CONDUCT.md · SECURITY.md · SUPPORT.md · GOVERNANCE.md · .all-contributorsrc
```

Package naming: workspace packages are `@bytebureau/<name>` (private unless listed in §7.4). Future layers (declared now in dependency-cruiser rules so they apply as packages appear): `apps/*` may depend on anything; `packages/kernel` and `packages/api` may import `effect`; `packages/protocol` may import `effect/schema` only; `packages/plugin-api`, `packages/client`, `packages/ui`, `packages/sim`, `plugins/*` must not import `effect`; `plugins/*` may import only `@bytebureau/plugin-api`, `@bytebureau/protocol` and third-party packages; nothing imports from `apps/*`; no circular dependencies; no barrel files except a package's entry point.

## 3. Toolchain (versions as observed on 2026-10-02; the plan pins exact versions from the registry and Renovate maintains them)

| Area | Choice | Configuration decisions |
|---|---|---|
| Runtime | Bun 1.4.x pinned in `.bun-version` and `mise.toml`; `engines.bun` in package.json | `bunfig.toml`: `[install] exact = true`, lifecycle scripts blocked (default), `minimumReleaseAge` 3 days if supported by the pinned Bun (otherwise rely on Renovate cooldown), `[test]` unused (tests run under Vitest) |
| Node (dev only) | Node 26 via `mise.toml` for Vitest, ESLint long tail and docs build | never required at runtime |
| Package manager | Bun workspaces + catalog (`workspaces.catalog` in root package.json) | every shared dependency version lives in the catalog; packages reference `catalog:` |
| Task runner | Turborepo 2.x | tasks: `build`, `typecheck`, `lint`, `lint:long-tail`, `format:check`, `test`, `knip`, `depcruise`, `spell`, `docs:build`; inputs/outputs declared; remote cache enabled in CI via Vercel OIDC (no token secrets); `turbo run --affected` on PRs |
| TypeScript | 7.0.x (`typescript` native) for `tsc --build` type-checking and editors; `@typescript/typescript6` alias pinned for tools that need the programmatic API (typescript-eslint) until TS 7.1 | `@tsconfig/strictest` base plus `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `noImplicitOverride`, `noUncheckedSideEffectImports`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `isolatedDeclarations` (library.json), `module`/`moduleResolution` = `nodenext`, `types: []` explicit, project references from the root solution file |
| Linter | oxlint 1.x type-aware (`oxlint-tsgolint` installed) | all categories (`correctness`, `suspicious`, `pedantic`, `perf`, `restriction`, `style`) at `error`; plugins `unicorn`, `import`, `promise`, `node`, `vitest`, `jsx-a11y`+`react` (enabled when SP2 adds React); typed rules incl. `no-floating-promises`, `no-misused-promises`, `await-thenable`, `no-unnecessary-condition`, `strict-boolean-expressions`, `switch-exhaustiveness-check`, `no-unsafe-*`, `prefer-readonly`, `restrict-template-expressions`, `no-deprecated`; `import/no-cycle`, `import/no-default-export` (allowed only for config files and Astro pages); nested configs per workspace |
| Formatter | oxfmt (beta, pinned) with built-in import sorting | if a pinned oxfmt release misformats code, the plan switches the formatter to Biome 2.x's stable formatter with identical style settings (same `--check` gate); the decision is recorded in ADR-0007 |
| Long-tail lint (CI only) | ESLint 10 flat config: `eslint-plugin-sonarjs` (cognitive complexity ≤ 15), `eslint-plugin-security`, `eslint-plugin-jsdoc` (`require-jsdoc` on exported symbols of published packages only) | runs in the `static` CI job, not in pre-commit |
| Dead code / boundaries | knip (`--production` for apps), dependency-cruiser rules from §2, `ls-lint` for file naming (kebab-case files, PascalCase React components later) | all gates fail CI on findings |
| Spelling / docs lint | cspell with `en` + `cs` dictionaries (Czech dictionary package when available in the registry, otherwise a project word list `cspell-words.txt`), markdownlint-cli2, actionlint, zizmor `--persona pedantic` | |
| Tests | Vitest 5 (Node) for all packages; `bun test` reserved for packages that use Bun-only APIs (none in SP0); fast-check available in the catalog | coverage via `@vitest/coverage-v8`, thresholds 80 % lines/branches on packages (apps excluded until SP1) |
| Git hooks | lefthook: `pre-commit` = oxfmt + oxlint `--fix` on staged files (`stage_fixed`), cspell on staged; `commit-msg` = commitlint; `pre-push` = `turbo typecheck test --affected` | hooks installable with `bun run prepare`; CI never relies on hooks |
| Commits | Conventional Commits enforced by commitlint (`@commitlint/config-conventional`) with `scope-enum` generated from workspace names plus `deps`, `release`, `repo`; `czg` prompt optional | PR titles validated by `amannn/action-semantic-pull-request`; squash-merge uses the PR title |
| Changelog / versioning | changelogen (emoji section headers) + bumpp; single version for the whole product (`0.x` until v1) | `bun run release` = `bumpp` → `changelogen --release --push` (creates tag `vX.Y.Z` and pushes); CHANGELOG.md is the source of truth, mirrored into the GitHub release body |
| Dependency automation | Renovate (Mend app) with `config:best-practices`, `:semanticCommits`, `group:allNonMajor`, `schedule:weekly`, `minimumReleaseAge: "7 days"` (14 days for automerged devDependency minors/patches), `lockFileMaintenance` weekly, `helpers:pinGitHubActionDigests`, `osvVulnerabilityAlerts: true`, dependency dashboard; Dependabot: security alerts and security updates only (no `dependabot.yml` version updates) | |
| i18n | Paraglide JS 2 project in `packages/i18n` (`project.inlang/settings.json`, base locale `en`, locales `en`, `cs`, message format plugin, path pattern `./messages/{locale}.json`); compiled runtime generated at build into `src/paraglide/` | CLI resolves locale from `--lang`, then `BYTEBUREAU_LANG`, then `LANG`/`LC_ALL`, then `en` |
| Docs | Astro Starlight in `apps/docs` with `locales: { root: en, cs }`, Pagefind search, sidebar autogenerated from `docs/decisions` and `src/content/docs`; deployed to GitHub Pages by `docs.yml` on pushes to `main` | custom domain and Cloudflare Pages are owner options later |
| Editor | `.vscode/extensions.json` recommends oxc, inlang, EditorConfig; settings enable format-on-save with oxfmt | WebStorm users rely on lefthook; a WebStorm note in CONTRIBUTING |

## 4. The proof deliverable: `apps/bytebureau`

- Entry `src/main.ts` built with citty: root command `bytebureau` with `--version` (value injected at build time from `apps/bytebureau/package.json` via `define`), `--help`, global `--lang <en|cs>`, `--no-color`, `--json`; sub-command `hello [name]` prints a localised greeting using `@bytebureau/i18n` messages and `@clack/prompts` styling (plain text when `--json` or non-TTY). This sub-command exists only to prove the build/i18n chain and is removed in sub-project 1 when real commands arrive.
- Exit codes: 0 success, 1 usage error, 2 unexpected error. `NO_COLOR` and non-TTY disable colour. Output never includes ANSI codes when `--json`.
- Build: `bun build --compile --minify --sourcemap --bytecode` for targets `bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`, `bun-linux-arm64`, `bun-linux-x64-musl`, `bun-linux-arm64-musl`, `bun-windows-x64`, `bun-windows-arm64`; artifacts named `bytebureau-<version>-<os>-<arch>[-musl][.exe]`; `scripts/build-binaries.ts` performs the matrix on one Linux runner.
- Smoke test: CI runs the produced linux-x64 and linux-arm64 binaries (`--version`, `hello --lang cs`) on native runners; the darwin-arm64 binary is run on `macos-26`.

## 5. CI/CD workflows

All workflows: `permissions: contents: read` at top level (jobs widen only what they need), `concurrency` group per ref with `cancel-in-progress` on PRs, every `uses:` pinned to a commit SHA (Renovate updates them), `step-security/harden-runner` as the first step (`egress-policy: audit` initially; switch to `block` with an allowlist once the egress set is known, tracked as a follow-up issue), `actions/checkout` with `persist-credentials: false`.

### 5.1 `ci.yml` (pull_request, push to main, merge_group) — target ≤ 6 min
1. `setup` (ubuntu-24.04): `oven-sh/setup-bun` from `.bun-version`, `actions/setup-node` for Node 26, restore `~/.bun/install/cache` keyed by `bun.lock`, `bun ci`, Turborepo remote cache via OIDC.
2. `static`: `turbo run lint lint:long-tail format:check typecheck knip depcruise spell --affected` plus `markdownlint-cli2`, `actionlint`, `zizmor`. Required check.
3. `unit` matrix `ubuntu-24.04` and `ubuntu-24.04-arm`: `turbo run test --affected` with coverage upload as artifact. Both required checks.
4. `build-smoke`: `scripts/build-binaries.ts` for linux-x64 + linux-arm64 (+ darwin-arm64 on `macos-26` when files under `apps/bytebureau/**` changed), run the binaries. Required check.
5. `docs`: `turbo run docs:build` (build only; deploy happens in `docs.yml`).

### 5.2 `semantic-pr.yml` (pull_request_target: opened, edited, synchronize, reopened)
`amannn/action-semantic-pull-request` with `permissions: pull-requests: read`; allowed types `feat fix perf refactor docs test build ci chore revert`; `requireScope: false`; subject must start lowercase. No checkout (safe for forks).

### 5.3 `security.yml` (push to main, weekly schedule)
OpenSSF Scorecard (`publish_results: true`, SARIF upload), zizmor SARIF upload, `bun audit` summary. CodeQL uses GitHub's default setup (owner toggles it; see §8).

### 5.4 `release.yml` (push of tag `v*`; also `workflow_dispatch` with `dry_run: true`) — target ≤ 20 min
`permissions: contents: write, id-token: write, attestations: write`; no cache restore (cache-poisoning hygiene).
1. `binaries` (ubuntu-24.04): build all eight targets; write `SHA256SUMS`; `actions/attest-build-provenance` over `dist/*`; `sigstore/cosign-installer` + `cosign sign-blob --yes --bundle <file>.sigstore.json` per artifact; CycloneDX SBOM (`syft` over the lockfile → `sbom.cdx.json`) and `actions/attest-sbom`.
2. `release` (needs binaries): generate release notes with `changelogen gh release` body (fallback: changelog section for the tag), create a **draft** release with `softprops/action-gh-release`, upload binaries + `.sigstore.json` + `SHA256SUMS` + `sbom.cdx.json`, then publish the draft (immutable once the owner enables immutable releases). `dry_run` stops before creating the release and uploads artifacts to the workflow run instead.
3. `homebrew` (needs release; skipped unless secret `HOMEBREW_TAP_TOKEN` exists): `homebrew-releaser` updates `getbytebureau/homebrew-tap` formula with darwin/linux arm64/x64 URLs and checksums.

### 5.5 `docs.yml` (push to main touching `apps/docs/**` or `docs/**`)
Build Starlight, `actions/upload-pages-artifact`, `actions/deploy-pages` (`permissions: pages: write, id-token: write`).

### 5.6 `labeler.yml`, `stale.yml`
`actions/labeler` on `pull_request_target` (no checkout) mapping `area:*` labels from paths; `actions/stale` weekly, 90 days to stale, 14 to close, exempt labels `pinned security roadmap good first issue help wanted wip`, never closes PRs with `wip`.

### 5.7 Tag protection and branch rules
Rulesets are created by `scripts/repo-settings.sh` (owner-run, uses `gh api`): default branch ruleset = deletion blocked, non-fast-forward blocked, linear history, pull request required (1 approval, dismiss stale, code-owner review, conversation resolution, squash only), required checks `static` (which includes zizmor and actionlint), `unit (ubuntu-24.04)`, `unit (ubuntu-24.04-arm)`, `build-smoke`, `semantic-pr`; **no** required signatures. Tag ruleset for `v*` = creation/update/deletion restricted to repository admins and the Actions app. Merge queue is added to the ruleset once the repository lives in an organisation.

## 6. Licence, trademark, contribution terms

- `LICENSE.md`: verbatim FSL-1.1-MIT template text; Licensor = "Ondřej Misák"; Software = "ByteBureau". Root `package.json` `license: "FSL-1.1-MIT"`. ADR-0005 records the rationale, the two-year MIT conversion, and the note that a future legal entity (s.r.o.) may become licensor for subsequent versions.
- MIT licence files are added inside `packages/plugin-api`, `packages/protocol` and `packages/client` when those packages are created (sub-project 1); the root README and CONTRIBUTING already state the split.
- `TRADEMARK.md`: ByteBureau name and logo are trademarks of the licensor; nominative use allowed; plugin naming `bytebureau-plugin-*` / `@bytebureau/plugin-*` allowed; forks must be renamed and must not imply endorsement; no merchandise, events or domains using the mark without written permission. Based on the Linux Foundation trademark usage guidelines (CC BY 4.0), adapted.
- Contributions under DCO: `CONTRIBUTING.md` requires `git commit -s`; the DCO GitHub App is installed by the owner and `web_commit_signoff_required` is enabled by `scripts/repo-settings.sh`. Inbound = outbound: contributions are licensed under the licence of the package they touch.
- `README.md` licence section wording: "ByteBureau is Fair Source under the Functional Source License (FSL-1.1-MIT): free to use, read, modify and contribute; the only restriction is offering it as a competing commercial product. Each release becomes MIT two years after publication. SDK packages are MIT." The project is described as "fair source" / "source-available", never as "open source".

## 7. Community and repository files

### 7.1 Health files
- `CONTRIBUTING.md`: prerequisites (`mise install`), `bun ci`, `bun run dev`, commit rules with scope list, PR checklist, DCO, review expectations, architecture pointers (research synthesis, ADRs), WebStorm/VS Code notes, how to add a locale string.
- `CODE_OF_CONDUCT.md`: Contributor Covenant 3.0 with the owner's contact e-mail.
- `SECURITY.md`: supported versions (latest minor), private vulnerability reporting link, 90-day coordinated disclosure, scope statement (local app, future relay), PGP optional, no bounty yet.
- `SUPPORT.md`: GitHub Discussions (Q&A) as the support channel; issues only for confirmed bugs/features.
- `GOVERNANCE.md`: BDFL (the owner) with decisions recorded as ADRs; maintainer ladder (contributor → reviewer → maintainer) with criteria.
- `.github/CODEOWNERS`: `* @misaon`, `/.github/ @misaon`, `/packages/plugin-api/ @misaon`.
- `.github/FUNDING.yml`: `github: [misaon]`.
- Issue forms (`blank_issues_enabled: false`): `bug.yml` (version, OS, agent CLI + version, steps, expected/actual, `bytebureau diag bundle` attachment hint once it exists), `feature.yml`, `plugin.yml` (plugin proposal), `config.yml` with contact links to Discussions Q&A and the security advisory form.
- `.github/PULL_REQUEST_TEMPLATE.md`: conventional title, summary, test plan, screenshots for UI, docs/ADR updated, DCO sign-off.
- Labels (created by `scripts/repo-settings.sh`): `kind: bug|feature|docs|chore|security`, `area: foundation|kernel|agents|workspace|api|cli|ui|sim|workflow|integrations|remote|telemetry|docs|ci`, `priority: p0..p3`, `status: needs-triage|needs-repro|blocked|ready`, `good first issue`, `help wanted`, `pinned`, `wip`, `breaking`, `dependencies`, `release`.
- `.all-contributorsrc` with the all-contributors bot configuration.

### 7.2 README.md (English; `README.cs.md` mirrors it in Czech)
Sections in order: centred header with a `<picture>` dark/light wordmark (static SVG created in this sub-project; the animated office banner replaces it in sub-project 3), one-line pitch ("Your AI office: a bureau of coding agents in isolated workspaces, orchestrated from one pixel-art floor and from your phone."), badges (release, CI, Scorecard, licence FSL-1.1-MIT, Discussions), language links; "What is ByteBureau" (three short paragraphs: the problem, the office metaphor, the promise); "Status" (pre-alpha, sub-project progress list linking to specs); "Quick start" (only commands that work at this stage: download from Releases and run `bytebureau --version`); "Features" grid (emoji bullets marked planned/available); "How it works" Mermaid diagram (clients → daemon → kernel → plugins → agent CLIs); "Roadmap" checklist mirroring the ten sub-projects; "Security & privacy" (summary + link to SECURITY.md); "Contributing"; "Community"; "Star history" image; "Licence". Length ≤ 300 lines; markdownlint clean.

### 7.3 Docs skeleton
`apps/docs` with pages: Introduction, Install (release download), Architecture (links to ADRs and research), Contributing; Czech locale with the same page skeleton (untranslated pages show Starlight's fallback notice).

### 7.4 Publishable packages (declared now, published from sub-project 1)
`@bytebureau/plugin-api`, `@bytebureau/protocol`, `@bytebureau/client` — MIT, built with tsdown, validated by publint and arethetypeswrong, published through npm trusted publishing (OIDC) by the release workflow once they exist. The root `package.json` is private.

## 8. Owner actions (manual, outside the implementation plan)

Delivered as `docs/decisions/0001-record-architecture-decisions.md` appendix and a checklist issue: (1) run a name-clearance search (TMview, BOIP, ÚPV) for "ByteBureau"; (2) create GitHub organisation `getbytebureau` (fallbacks `bytebureauhq`, `bytebureau-dev`) and transfer the repository; (3) enable 2FA, SSH commit signing with vigilant mode; (4) run `scripts/repo-settings.sh` (repo features: wiki off, projects off, discussions on with categories Announcements/Q&A/Ideas/Show and tell; squash-only; delete branch on merge; auto-merge; secret scanning + push protection; Dependabot alerts + security updates; private vulnerability reporting; `web_commit_signoff_required`; labels; rulesets); (5) in the UI: CodeQL default setup (JavaScript/TypeScript + Actions, extended queries), immutable releases, social preview image (1280×640), Actions policy (allow owner + verified creators + explicit list; require approval for first-time contributors; read-only default token), artifact retention 30 days; (6) install GitHub apps: Renovate, DCO, all-contributors; (7) reserve npm organisation `@bytebureau`, Docker Hub `bytebureau`, domains `bytebureau.dev` (+ `.app`, `.cz`); create `homebrew-tap` repository and `HOMEBREW_TAP_TOKEN` secret when ready; (8) GitHub Sponsors profile (optional).

## 9. Architecture decision records (MADR 4.0, `docs/decisions/`)

0001 Record architecture decisions · 0002 Bun as runtime and single-binary distribution (Node 26 compatibility baseline) · 0003 Effect 4 in the kernel only, plain TypeScript at plugin and UI boundaries · 0004 Plugin contract: typed ports, Standard Schema config, three isolation tiers · 0005 Licence: FSL-1.1-MIT core, MIT SDK packages, DCO, trademark policy · 0006 Agent authentication policy: user-owned unmodified agent CLIs, no credential intermediation, no automatic account rotation, API-key mode first class · 0007 Lint/format stack: oxlint type-aware + oxfmt, ESLint long tail in CI only · 0008 Release pipeline: changelogen + bumpp, immutable releases with provenance attestations, cosign bundles and SBOM · 0009 Dependency policy: Renovate with release-age cooldowns, Dependabot alerts only, lifecycle scripts blocked.

## 10. Error handling and robustness of the foundation itself

- Toolchain failures are loud: every gate exits non-zero and CI marks the check failed; no `continue-on-error` except the optional Homebrew job (reported as skipped, not failed, when the secret is absent).
- Release workflow is idempotent: re-running on the same tag updates the draft before publishing; publishing an already-published immutable release fails with a clear message instead of attempting to overwrite assets.
- `scripts/build-binaries.ts` validates each produced binary exists and is executable, prints sizes, and fails if any target is missing.
- Lockfile drift fails `bun ci`; Renovate keeps `bun.lock` and action digests current.

## 11. Testing and acceptance criteria

1. Fresh clone + `mise install` + `bun ci` + `turbo run build typecheck lint format:check test knip depcruise spell` passes with zero warnings on macOS (arm64) and in CI (x64 + arm64).
2. `bun run build:binaries` produces eight executables; the native-runner smoke tests pass; sizes are reported in the CI summary.
3. A commit with a non-conventional message is rejected locally by lefthook and a PR with a bad title is rejected by `semantic-pr`.
4. `turbo run test` includes at least: a Vitest test for the CLI (`--version`, `hello --lang cs` output snapshots, non-TTY/`--json` behaviour, exit codes) and a test that every `cs` message key exists in `en` (and vice versa).
5. `workflow_dispatch` of `release.yml` with `dry_run: true` succeeds end to end (attestations and signatures generated); the first real release `v0.1.0` publishes an immutable GitHub release with eight binaries, `SHA256SUMS`, `.sigstore.json` bundles and `sbom.cdx.json`, and a CHANGELOG with emoji sections.
6. `gh attestation verify bytebureau-* --owner <owner>` succeeds for a downloaded binary.
7. Docs site builds and deploys to GitHub Pages; Czech locale renders with the fallback notice.
8. OpenSSF Scorecard runs and publishes; zizmor pedantic reports zero findings; actionlint clean.
9. README renders without markdownlint findings; `README.cs.md` has the same section structure.

## 12. Out of scope (next sub-projects)

Kernel, API, plugin host, agent adapters, CLI commands beyond the proof command (sub-project 1); web UI (2); simulation (3); workflow engine and integrations (4); containers (5); desktop shell, installers, auto-update, keep-awake, notifications (6); relay and mobile (7); telemetry and trajectories (8).
