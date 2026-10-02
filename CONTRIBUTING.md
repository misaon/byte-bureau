# Contributing to ByteBureau

Thank you for helping build the AI office. This guide covers the setup, the rules the CI enforces, and how to get a change merged.

## Prerequisites

- [mise](https://mise.jdx.dev) (installs the pinned Bun and Node from `mise.toml`), or Bun 1.4.x and Node 26 installed manually
- Git ≥ 2.40

## Setup

```bash
git clone https://github.com/misaon/byte-bureau.git
cd byte-bureau
mise install
bun install --frozen-lockfile
bun run check
```

`bun install` runs `lefthook install`, so the commit hooks are active immediately.

## Day-to-day commands

| Command | What it does |
| --- | --- |
| `bun run check` | every gate the CI runs (lint, format, spelling, markdown, file names, dead code, boundaries, typecheck, tests with coverage, ESLint long tail) |
| `bun run lint` / `bun run format` | oxlint (type-aware) / oxfmt |
| `bun run test` | Vitest across all packages |
| `bun run build:binaries --host` | compile the CLI for your machine into `dist/` |
| `bun run docs:build` | build the documentation site |

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org): `type(scope): subject`.
Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`.
Scopes: a workspace directory name (`bytebureau`, `i18n`, `tsconfig`, `docs`) or `cli`, `deps`, `release`, `repo`, `ci`.
The subject is lower-case and imperative. commitlint rejects anything else, and the PR title is validated the same way because we squash-merge using the PR title.

Every commit must carry a Developer Certificate of Origin sign-off (`git commit -s`). By signing off you certify the [DCO](https://developercertificate.org). Contributions are licensed under the licence of the package they touch (FSL-1.1-MIT for the application, MIT for the SDK packages).

## Pull requests

1. Open an issue or discussion first for anything larger than a bug fix.
2. Branch from `main`, keep the PR focused, add tests.
3. Fill in the PR template; keep `bun run check` green.
4. A maintainer reviews within a week. Address comments with new commits; we squash on merge.

## Code style

- TypeScript only, strictest settings; no `any`, no enums, no namespaces (erasable syntax only).
- Files are kebab-case; one responsibility per file; no barrel files except a package entry point.
- Comments only where the code cannot say it; keep them short.
- Translations live in `packages/i18n/messages/*.json`; add the key to both `en` and `cs` (tests enforce parity).

## Architecture

Start with `docs/research/2026-10-02-technology-landscape.md`, the specs in `docs/superpowers/specs/` and the ADRs in `docs/decisions/`. New decisions get a new ADR (MADR format).

## Editors

VS Code: accept the recommended extensions (`.vscode/extensions.json`). WebStorm: the lefthook hooks keep formatting and linting consistent; run `bun run format` before committing if your IDE formatter differs.
