---
title: Architecture
description: Daemon, kernel, plugins and clients.
---

ByteBureau is a single binary that runs a local daemon. Clients (web UI, desktop shell, phone, CLI) talk to it over an OpenAPI-described HTTP API, server-sent events and a WebSocket. The kernel keeps an append-only event log of everything that happens; the office simulation, the chat and the telemetry are projections of that log. Integrations are plugins behind typed ports: agent providers, workspace runtimes, git hosts, ticket systems, chat and notifiers.

Read the [technology research](https://github.com/misaon/byte-bureau/blob/main/docs/research/2026-10-02-technology-landscape.md), the [design specs](https://github.com/misaon/byte-bureau/tree/main/docs/superpowers/specs) and the decision records in the sidebar.
