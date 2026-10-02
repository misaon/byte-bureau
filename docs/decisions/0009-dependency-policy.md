# Dependency policy: Renovate with release-age cooldowns, Dependabot alerts only, no lifecycle scripts

- Status: accepted
- Date: 2026-10-02

## Context and problem statement

The 2025 npm supply-chain worms spread through freshly published versions and install scripts.

## Decision

Renovate (`config:best-practices`) opens grouped weekly updates with a 7-day minimum release age (14 days for automerged devDependency minors and patches), pins GitHub Action digests and maintains lockfiles; Dependabot provides alerts and security updates only. Every module a build loads is pinned exactly too: the inlang message-format plugin is an exact devDependency read from `node_modules`, never fetched from a CDN at build time. `bunfig.toml` sets `minimumReleaseAge` to three days, so `bun install` and `bun add` never resolve a version younger than that; versions already in `bun.lock` are unaffected. Bun keeps lifecycle scripts blocked by default and CI installs with a frozen lockfile.

## Consequences

Updates lag a week behind upstream on purpose; a vulnerable release is still surfaced immediately through alerts.
