# Lint and format stack: oxlint (type-aware) and oxfmt, ESLint long tail in CI and in the local check

- Status: accepted
- Date: 2026-10-02

## Context and problem statement

The project wants the strictest practical linting with fast feedback, on a TypeScript 7 code base whose compiler has no programmatic API for ESLint.

## Decision

oxlint with every category at `error` and type-aware rules enabled is the primary linter; oxfmt (Prettier-compatible) is the formatter; both run in the pre-commit hook and in CI. Rules oxlint lacks (sonarjs cognitive complexity, security, jsdoc for published packages) run through ESLint in CI and in `bun run check`, inside `tools/eslint-long-tail`, which installs TypeScript 6 under the `typescript` name so typescript-eslint keeps working until it supports TypeScript 7.

## Consequences

Sub-second local linting; a beta formatter that is pinned and updated through Renovate cooldowns (fallback: Biome's formatter with the same style); the ESLint tool directory has its own lockfile.
