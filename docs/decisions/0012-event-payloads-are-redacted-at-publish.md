# Event payloads are redacted once, at publish

- Status: accepted
- Date: 2026-10-04

## Context and problem statement

Phase A stored event payloads as the kernel's services and plugins handed them in and redacted secrets only in the log sinks that print records. The event log is read by the CLI, by the API of Phase B (REST, SSE and RPC), later by the web UI, the phone client and the diagnostic bundle. Each reader redacting on its own would repeat the same code and the first one to forget it would leak. Secrets never belong in events (spec §13); redaction is the second line of defence, not the contract.

## Decision

`EventLog.publish` passes every payload through `redactValue` before it is stored or fanned out: a field whose name matches the kernel's `REDACTED_FIELDS` becomes `[REDACTED]`, a run of text matching `SECRET_PATTERNS` is replaced inside the string, ten levels deep. The same field list and patterns drive the log sinks, which keep redacting what they print. Readers of the log do not redact.

## Consequences

- One place to audit; a reader cannot forget.
- Redaction is lossy for legitimate text that looks like a secret (a document quoting `sk-ant-…`); the UI shows `[REDACTED]` there. Acceptable: no feature of ByteBureau needs the raw secret, and the agent's own context is unaffected (events are a projection).
- A payload field named like a secret but holding none (`token` counting tokens, say) is replaced too; event schemas use `inputTokens`/`outputTokens`, which do not match `token$`. New schemas must avoid the reserved names, which `redact-value.test.ts` documents.
