# Plugin contract: typed ports, Standard Schema config, three isolation tiers

- Status: accepted
- Date: 2026-10-02

## Context and problem statement

Model providers, workspace runtimes, git hosts, ticket systems and chat integrations must be swappable without touching the core, and third-party authors must be able to write plugins with ordinary TypeScript.

## Decision

The kernel exposes typed ports (`AgentProvider`, `WorkspaceRuntime`, `SecretStore`, later `GitHost`, `TicketSystem`, `ChatChannel`, `Notifier`, `SkillSource`, `UiPanel`, `WakeSource`). A plugin is an npm package or local directory with a manifest, a `definePlugin()` entry and a config validated by any Standard Schema library. Tier 1 plugins run in-process and trusted; tier 2 plugins run out of process over JSON-RPC (MCP, ACP); tier 3 (WebAssembly) is reserved. All payloads are message-shaped so a plugin can move between tiers without API changes.

## Consequences

A stable `@bytebureau/plugin-api` published under MIT; capability declarations are informational until sandboxing arrives.
