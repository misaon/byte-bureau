# Effect 4 in the kernel only

- Status: accepted
- Date: 2026-10-02

## Context and problem statement

The kernel needs structured concurrency, typed errors, retries, resource safety, tracing, durable workflows and an OpenAPI-described API. Plugin and UI contributors should not need to learn a new programming model.

## Decision

`packages/kernel`, `packages/api` and `packages/protocol` use Effect 4 (LTS). Every boundary that plugins or UI code touch is plain TypeScript: Promise and AsyncIterable signatures, DTO payloads validated with Standard Schema. dependency-cruiser forbids `effect` imports outside the three core packages.

## Consequences

Kernel contributors learn Effect (an onboarding guide is required); plugin authors never see it. Durable workflows are gated by a spike of `effect/workflow` on SQLite with a Restate sidecar as fallback.
