# Agent authentication policy: user-owned unmodified agent CLIs, no credential intermediation

- Status: accepted
- Date: 2026-10-02

## Context and problem statement

Anthropic's legal terms (verified 2026-10-02) allow an end user to sign in to the unmodified Claude Code binary with their own subscription, including where a platform hosts it, but forbid third parties from offering claude.ai login, routing requests through subscription credentials for their users, or collecting, storing or intermediating credentials and session tokens. Consumer terms forbid account sharing and automated multi-account use. OpenAI's "Sign in with ChatGPT" programme lets an application use a user's ChatGPT plan: applications under an OSI-approved licence qualify outright, commercial applications are approved case by case.

## Decision

ByteBureau orchestrates the user's own, user-installed, unmodified agent CLIs under logins the user performs themselves; it never reads, copies, stores or proxies OAuth credentials; API-key mode is first class for every provider that supports it; multiple accounts are modelled as named profiles the user logs into individually, with manual switching and usage pacing, never automatic rotation; `--bare` mode is not used with subscription logins. The project applies for an OpenAI "Sign in with ChatGPT" client ID once it is eligible: outright admission requires an OSI-approved licence, which FSL-1.1-MIT is not, so eligibility under FSL-1.1-MIT (or through the MIT-licensed SDK packages) must be confirmed with OpenAI before applying.

## Consequences

The zero-cost path works today and complies with the published terms; the policy is volatile and is re-verified before every release; automatic account rotation requested in the original brief is replaced by profiles and pacing.
