# API transports: HTTP API with OpenAPI, SSE for the event stream, effect/rpc over WebSocket with JSON envelopes

- Status: accepted
- Date: 2026-10-04

## Context and problem statement

Spec §11 asks for an OpenAPI 3.1 REST API, an SSE endpoint that resumes with `Last-Event-ID`, and `effect/rpc` over WebSocket, consumed by a client package that must not depend on Effect at runtime (§3). Effect 4 ships all three on the server. The question was how a plain-TypeScript client speaks the RPC side.

## Decision

The daemon serves `effect/rpc` on `/api/v1/ws` with `RpcSerialization.json`: each WebSocket frame is one JSON envelope of the documented `RpcMessage` shapes (`Request`, `Ack`, `Interrupt`, `Ping` from the client; `Chunk`, `Exit`, `Defect`, `Pong` from the server). The client package implements those envelopes in one module and keeps Effect out of its runtime; the REST and SSE parts are generated from the OpenAPI document and read with `fetch`. The bearer token travels in the `headers` of every RPC request, never in the URL. The upgrade checks a browser's `Origin`: an origin listed in `corsOrigins` may open the socket, and so may the daemon's own page, served on a loopback name (`localhost`, `127.0.0.1`, `[::1]`) and the port the request came to; the name in the `Host` header is never trusted, since a page that rebinds its own name to the loopback sends that name as well. Every procedure but `events.subscribe` draws a token from the mutation budget of the address the socket was opened from, the budget the REST mutations of that address draw from, so the socket is no second door around the rate limit. The address is captured at the upgrade, because Bun forgets the address of a request once it has upgraded it.

## Consequences

- One contract (`BureauRpcs` in the protocol) for the server and the client; the wire shapes are pinned by `rpc.test.ts` and by the client's codec tests, so a change in Effect's envelopes is caught at upgrade time.
- A browser client (SP2) needs no header on the upgrade, so no token in the URL and no subprotocol trick.
- Streams need the client to acknowledge chunks; a client that forgets to ack sees one chunk and then silence, which the client package hides.
- Effect puts the headers of the upgrade request in front of the headers of every request on the socket, so a Node or Bun client that sends the bearer header with the upgrade is let in as well; the header of the request wins when both carry one.
- A payload that does not fit its schema, or a tag the group does not know, ends as an `Exit` whose cause is a `Die` with the schema's message, not as a `request_invalid` problem; the client package reports it as an error.
- Every `Request` envelope carries a `headers` array, empty when there is nothing to send; Effect closes the socket with 1011 on a request without one.
- A defect in a handler ends that request with an `Exit` whose cause is a `Die` (the route sets `disableFatalDefects`), so the other requests on the socket go on.
