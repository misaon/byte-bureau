# Raw research reports (2026-10-02)

Fourteen parallel research agents, each restricted to online verification (official docs, GitHub/npm/crates metadata, specs, articles; ≥2 sources per key claim; versions and dates as observed on 2026-10-02). Items the agents could not verify are marked `unverified` inline.

| # | Cluster | Notes |
|---|---------|-------|
| 01 | Agent harnesses, protocols, provider access | ~210 fetches; includes Anthropic/OpenAI policy text |
| 02 | Claude Agent SDK / Claude Code details | **Superseded on three points by 02b** (subscription policy, OpenTelemetry export, model lineup) |
| 02b | Corrections verified by the lead agent from primary sources | authoritative where it conflicts with 02 |
| 03 | Runtime, TypeScript, monorepo, lint, test, release, CI | includes an empirical Bun cross-compile size test |
| 04 | Sandboxing & isolation | Docker/sbx/Podman/Apple container, credential strategy, Pi 5 sizing |
| 05 | 2D engine, rendering, tilemaps, assets & licenses | PixiJS vs Phaser, asset licensing audit |
| 06 | Procedural floors, behaviour AI, deterministic sim | includes `06-bench.mjs` (A* / BFS timings, V8 vs JSC float divergence) |
| 07 | Frontend framework, animation, chat UI | React 19.3 / Vite 8 / Motion 13 / Streamdown |
| 08 | Desktop shell, CLI, install/update, mobile, notifications, keep-awake, i18n | Tauri 2.12 + Bun sidecar sizes |
| 09 | Realtime transport, E2EE, pairing, relay, sync, secrets | Cloudflare DO relay, noble crypto, PQ-hybrid |
| 10 | Telemetry, observability, self-improvement, debug logging, storage | OTel GenAI status, ATIF, LogTape, SQLite FTS5 (Czech verified) |
| 11 | Core architecture, plugin system, durable workflows, RPC, config, git | Effect 4 kernel, plugin API sketch |
| 12 | Skills ecosystem, multi-agent workflow, HITL, token efficiency | employee roster, work-item state machine, risk register |
| 13 | Licensing, repo/community setup, README, docs site | FSL-1.1-MIT recommendation, name-collision findings |
| 14 | Competitive landscape | ~60 pixel-office projects, orchestration UIs, vendor moves |
| 15 | SP1 Phase A stack (Effect 4, SQLite drivers, Drizzle, c12, LogTape, git worktree) | verified 2026-10-02 with executed probes; §0 lists blockers (install cooldown, isolatedDeclarations, Drizzle on Effect 4) |

Caveat: the session's web-search budget ran out part-way; later clusters relied on direct fetches of documentation, release pages and registry APIs rather than search discovery.
