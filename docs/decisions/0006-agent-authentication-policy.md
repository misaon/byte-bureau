# Agent authentication policy: user-owned unmodified agent CLIs, no credential intermediation

- Status: accepted
- Date: 2026-10-02

## Context and problem statement

Anthropic's legal terms (verified 2026-10-02) allow an end user to sign in to the unmodified Claude Code binary with their own subscription, including where a platform hosts it, but forbid third parties from offering claude.ai login, routing requests through subscription credentials for their users, or collecting, storing or intermediating credentials and session tokens. Consumer terms forbid account sharing and automated multi-account use. OpenAI admits open-source tools to ChatGPT plans through "Sign in with ChatGPT".

## Decision

ByteBureau orchestrates the user's own, user-installed, unmodified agent CLIs under logins the user performs themselves; it never reads, copies, stores or proxies OAuth credentials; API-key mode is first class for every provider that supports it; multiple accounts are modelled as named profiles the user logs into individually, with manual switching and usage pacing, never automatic rotation; `--bare` mode is not used with subscription logins. The project applies for an OpenAI "Sign in with ChatGPT" client ID as an open-source tool.

## Consequences

The zero-cost path works today and complies with the published terms; the policy is volatile and is re-verified before every release; automatic account rotation requested in the original brief is replaced by profiles and pacing.
