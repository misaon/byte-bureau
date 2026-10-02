# Bun as runtime and single-binary distribution

- Status: accepted
- Date: 2026-10-02

## Context and problem statement

ByteBureau must run as a headless daemon, a CLI and the core of a desktop app on macOS, Linux (x64, arm64 including Raspberry Pi 5) and Windows, with small binaries and a one-command start.

## Decision

The application runs on Bun 1.4.x, pinned exactly in `.bun-version`, and ships as single-file executables produced by `bun build --compile` for eight targets from one Linux runner. Node 26 remains the compatibility baseline for published packages (`@bytebureau/plugin-api`, `@bytebureau/protocol`, `@bytebureau/client`), which use only erasable TypeScript syntax and no Bun-only APIs. Bun-only APIs inside the application are wrapped in small adapters so a Node fallback stays feasible.

## Consequences

Cross-compiled binaries of roughly 60–80 MB per target; built-in SQLite, WebSocket server and process APIs without extra dependencies; exposure to regressions in Bun's recent Rust rewrite, mitigated by exact pinning, Renovate cooldowns and a planned nightly canary job (sub-project 1).
