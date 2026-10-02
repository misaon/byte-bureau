# 09 — Realtime transport, E2EE, device pairing, relay, multi-client sync, secrets

Research date: 2026-10-02. Method: WebSearch budget for this session was exhausted by sibling agents, so every fact below comes from direct WebFetch of primary sources (official docs, RFCs/I-Ds, GitHub repos, raw source files), `gh api` (stars, license, last push, latest release), the npm registry (latest version + publish date), and two empirical local runs (Bun 1.4.2, Node 24.14.0). Anything not backed by at least two independent sources, or that I could not open, is marked **unverified**.

---

## 1. Executive summary

1. **No mainstream "remote control for coding agents" product except Happy and Paseo is end-to-end encrypted.** Anthropic's Claude Code Remote Control stores the transcript on Anthropic servers ("the session transcript ... is stored on Anthropic servers"); OpenAI Codex Remote relays "through OpenAI servers" with no E2EE statement; Omnara Cloud keeps data "queryable through the API"; VibeTunnel/CodeRemote/OpenCode have no E2EE and rely on Tailscale/ngrok/basic-auth. Happy (24k★, MIT) and Paseo (19.2k★, Apache-2.0) both use **TweetNaCl `box`/`secretbox` (X25519 + XSalsa20-Poly1305) over a blind WebSocket relay with QR pairing**. Reading Paseo's relay source shows two concrete gaps ByteBureau can beat: the Cloudflare relay has **no authentication of who may occupy a `serverId`** (squatting/DoS) and the channel uses **random nonces with no sequence numbers** (in-session replay is not prevented). "Security sells" is credible: the bar is low and the primitives are cheap.

2. **Relay hosting: Cloudflare Workers + Durable Objects (WebSocket Hibernation) is the clear winner** for a solo maintainer: free plan = 100k requests/day, 13k GB-s/day, 5 GB SQLite; hibernation means idle connections cost nothing; paid is $5/month. Paseo already runs its relay this way (`packages/relay/src/cloudflare-adapter.ts`, `wrangler.toml`). **Vercel now serves WebSockets (public beta since 2026-06-22, Fluid compute)**, but a connection is pinned to one instance and **closes at `maxDuration` (300 s Hobby, 800 s Pro)**, state must live in external Redis, and the Hobby plan is "non-commercial, personal use only" — usable as a second-tier option, not as the primary relay. Fly.io (~$1.81/month smallest VM, no free tier) and Railway ($5/month) are fine for a classic long-lived Bun/Node `ws` server if you prefer a plain process.

3. **Crypto: build the channel from audited `@noble/*` primitives (or WebCrypto where available), not from an unaudited TS Noise/HPKE/MLS library.** `@noble/curves` 2.4.0 was audited by Trail of Bits in Aug 2026 (v2.3.0) on top of Cure53 (2024) and Kudelski (2023); `@noble/ciphers` 2.4.0 by Cure53 (Sep 2024); `@noble/hashes` by Cure53 (2022). WebCrypto X25519/Ed25519 is in Chrome 133/137, Firefox 130/129, Safari 17, Node (stable since 22.13/20.19.3) and Bun 1.4.2 (verified locally). Every TS Noise implementation I found (`@chainsafe/libp2p-noise`, `noise-handshake`) and `hpke-js`, `ts-mls`, `@noble/post-quantum` state **no independent audit**. `@signalapp/libsignal-client` is AGPL and "use outside of Signal is unsupported". Expo/React Native has no `crypto.subtle`, so a phone app needs pure-JS noble (or react-native-libsodium as Happy does) plus `expo-crypto` for `getRandomValues` (Paseo's approach).

4. **PQ-hybrid is now a cheap, honest claim with caveats.** RFC 10024 (Aug 2026, Proposed Standard) standardizes `X25519MLKEM768` for TLS; Node 26.10 added `MLKEM768-X25519` to WebCrypto (stability 1.1); `@noble/post-quantum` 0.7.1 ships X-Wing (X25519 + ML-KEM-768) but is unaudited; X-Wing itself is still an individual I-D (draft-11, 2026-09-23). Recommendation: ship hybrid behind a flag; because it is a hybrid, security is never worse than X25519 alone.

5. **Sync: an event-sourced, sequence-numbered log over the encrypted channel** (core = single writer and source of truth; clients = mirrors sending idempotent commands) is the leanest sound model. CRDT/sync engines (Yjs, Automerge 3, Loro, Jazz 2.0-alpha, LiveStore, Electric, Zero, PowerSync, TinyBase, TanStack DB) solve multi-writer merge or Postgres sync, neither of which ByteBureau has; most also require their own server and none (except Jazz, which is alpha) are E2EE-aware. Borrow the **Durable Streams** idea (offset-addressed, resumable append-only stream) for the relay's ciphertext queue.

6. **Secrets at rest:** `@napi-rs/keyring` 2.1.0 (Rust `keyring` crate; macOS Keychain, Windows Credential Manager, Linux Secret Service/keyutils; works in Node and Bun) is the safe default; `Bun.secrets` (since 1.2.21, Aug 2025) is convenient but has an open issue (#28071) that any `bun` script can read secrets without a prompt because the keychain client is the shared `bun` binary; `keytar` is archived (2022-12-15). Encrypted config files: `age` via `age-encryption` (typage 0.3.1, noble-based, passkey recipients) or `sops` (CNCF, age backend). Recovery UX: 256-bit root secret as BIP-39 words via `@scure/bip39` (Cure53-audited) or Happy's base32 "XXXXX-XXXXX-…" format.

---

## 2. Findings per topic

### 2.1 How existing tools do phone remote control (comparison)

| Tool | Where the agent runs | Transport | Relay / who sees content | Pairing | Crypto primitives | OSS / license / stars (gh api, 2026-10-01) |
|---|---|---|---|---|---|---|
| **Claude Code Remote Control** (Anthropic docs, `code.claude.com/docs/en/remote-control`) | Your machine (local CLI, `claude remote-control` or `/remote-control`) | "outbound HTTPS requests only and never opens inbound ports"; registers with the Anthropic API and polls; "streaming connection" | **Not E2EE**: "the session transcript, including your messages, Claude's responses, and tool activity, is stored on Anthropic servers"; ZDR orgs cannot use it | Session URL + QR (spacebar in server mode); "multiple short-lived credentials, each scoped to a single purpose"; optional **Trusted Devices** = WebAuthn platform authenticator step-up when sign-in is >18 h old | TLS only (relay sees plaintext) | Proprietary; Pro/Max/Team/Enterprise only; v2.1.2xx features |
| **Claude Code on the web / cloud sessions** | Anthropic-managed VMs (or self-hosted runners) | Browser/mobile ↔ Anthropic | Anthropic sees everything by design | Account login | TLS | Proprietary |
| **Claude Code Channels** (Telegram/Discord/iMessage, research preview) | Your machine; plugin is a local Bun MCP server that **polls** the platform | Bot API polling → local session | Platform (Telegram/Discord) sees content; not E2EE | Bot replies with pairing code → `/telegram:access pair <code>` → allowlist | Platform TLS | Plugins in `anthropics/claude-plugins-official` |
| **Codex Remote** (OpenAI, `learn.chatgpt.com/codex/remote`) | Your Mac/Windows PC | "all relayed communication flowing through OpenAI servers" | OpenAI relay; no E2EE statement | Desktop Settings → enable remote → scan QR with ChatGPT iOS app → approve on desktop; same ChatGPT account/workspace | TLS | Proprietary |
| **Happy** (`slopus/happy`) | Your machine (`happy-coder` CLI wraps Claude Code/Codex) | socket.io (CLI: `socket.io-client`; server: `socket.io` + Fastify + Prisma, Redis streams adapter, PGlite option) | **E2EE**: "the server never sees your messages, only encrypted blobs"; free cloud instance `happy-api.slopus.com` or self-host | New device shows QR `happy:///account?<base64url ephemeral X25519 pk>`; existing device scans; account secret is sent `box`-encrypted to the ephemeral key via the server | `tweetnacl` + `@stablelib/*` on CLI; `@more-tech/react-native-libsodium` in app. Legacy: NaCl secretbox (XSalsa20-Poly1305, 24-B nonce); newer: per-session **AES-256-GCM data keys** wrapped with `nacl.box` + ephemeral key (`docs/encryption.md`). Third-party tokens on server are **not** E2EE (server master key). Recovery: 32-byte secret as base32 `XXXXX-XXXXX-...` | MIT; 23,973★; pushed 2026-09-28 |
| **Paseo** (`getpaseo/paseo`, paseo.sh) | Your machine (daemon, `127.0.0.1:6767` default) | WebSocket to relay (**Cloudflare Worker + Durable Object**, `packages/relay`), or direct LAN/VPN/Tailscale/own tunnel | **E2EE relay**: "The relay sees only: IP addresses, timing, message sizes, and session IDs" plus plaintext `e2ee_hello`/`e2ee_ready` frames | QR/link = `https://app.paseo.sh/#<offer>`; offer carries daemon static X25519 pk, `serverId`, relay endpoint — in the **URL fragment** so it never reaches a server | `tweetnacl` `box.keyPair`, `box.before/after` (X25519 + XSalsa20-Poly1305), **random 24-B nonce per message, no sequence numbers**; client ephemeral keypair per connection; DNS-rebinding Host allowlist; optional bcrypt password for direct connections. Relay: `GET /ws?role={server|client}&serverId=X&v={1|2}` — **no auth/token check**, 200-frame pending buffer, no size limit | Apache-2.0 (README/site; API shows NOASSERTION); 19,212★; pushed 2026-10-01; `@getpaseo/relay` 0.11.0-beta.2 |
| **Omnara** (`omnara-ai/omnara`) | Your machine (`omnarad` daemon, Go) or sandboxes | HTTP API to Omnara backend (Postgres) | **Not E2EE**: "On Omnara Cloud, all data is queryable through the API. To keep it in your own infrastructure, self-host" | Account login / API keys | TLS; `internal/storage/secretstore/crypto.go` for server-side secrets | Apache-2.0; 2,879★ |
| **VibeTunnel** (`amantus-ai/vibetunnel`) | Your Mac (menu-bar app + Node server :4020) | Browser → local HTTP/WS; reach via Tailscale (recommended), ngrok, Cloudflare Quick Tunnel, Pinggy, Pangolin, LAN | No relay of its own; **"VibeTunnel does not provide built-in TLS"**; `docs/security.md` says default bind is all interfaces | OS password/PAM, SSH-key auth (Ed25519 from `authorized_keys`), local-bypass token, or `--no-auth` | None beyond tunnel | MIT; 4,676★; pushed 2026-08-05; iOS app "work-in-progress" |
| **CodeRemote** (coderemote.dev) | Your machine (CLI) | Web UI over **Tailscale** only | No cloud relay; "no data collection" | Tailscale identity | WireGuard (Tailscale) | Closed, $49/month private npm package |
| **Conductor** (conductor.build) | Mac app running parallel Claude Code/Codex/Cursor agents | n/a | No mobile/remote feature found on site | – | – | Proprietary |
| **OpenCode `opencode serve`** (opencode.ai/docs/server) | Your machine | HTTP + OpenAPI 3.1, binds `127.0.0.1:4096` | No relay; **basic auth** via `OPENCODE_SERVER_PASSWORD`; `--cors`, `--mdns` | password | None (TLS via your tunnel) | MIT; 211,334★ (anomalyco/opencode) |
| **claude-code-telegram** (`overwirehq/claude-code-telegram`) | Your machine; bot **polls** Telegram | Telegram Bot API | Telegram sees content | `ALLOWED_USERS` whitelist, per-user cost caps | TLS | MIT; 2,798★ |
| **Blink Shell** (blink.sh) | Any SSH/Mosh host | SSH/Mosh | n/a | SSH keys (Ed25519/ECDSA/RSA; Secure Enclave use **unverified**) | SSH | Open source; $19.99/year |
| **Tailscale pattern** (CodeRemote, VibeTunnel, Paseo "VPN" mode) | Your machine | WireGuard mesh; Funnel for public HTTPS | Tailscale coordination server sees metadata only; Funnel relays "do not decrypt the traffic" | Tailscale login | WireGuard | Free Personal plan: 6 users, unlimited devices; **Funnel on all plans** per KB 1223 (pricing page ambiguous) |

Takeaways for ByteBureau: (a) a blind relay + E2EE + QR pairing is the state of the art among OSS tools and is what Happy/Paseo users already expect; (b) nobody authenticates the *client* device with an enrolled key and nobody has replay counters — easy, defensible differentiators; (c) Anthropic's Trusted Devices (WebAuthn step-up every 18 h) and Codex's "approve pairing on the desktop" are UX patterns worth copying; (d) Channels show that chat-app bridges are useful but inherently not E2EE — if offered, label them as such.

### 2.2 Transport options (home machine behind NAT → phone)

**Relay via WebSocket (recommended primary path)**

| Host | What I verified | Fit |
|---|---|---|
| **Cloudflare Workers + Durable Objects** | Hibernation API: "Billable Duration (GB-s) charges do not accrue during hibernation"; per-connection `serializeAttachment` ≤16,384 B. Pricing: Free plan 100,000 req/day, 13,000 GB-s/day, 5 GB SQLite storage, 100 DO classes; Paid (Workers Paid, $5/month) 1M DO requests + 400,000 GB-s included, $0.15/M req, $12.50/M GB-s; incoming WS messages billed at 20:1; SQLite row billing began 2026-01-07. Limits: 32 MiB max received WS message, soft 1,000 req/s per object, 10 GB per object. Durable Objects are available on Free (SQLite-backed only). Libraries: `partyserver` 0.5.10 (ISC, cloudflare/partykit, pushed 2026-08-03), `crossws` 0.4.12 (adapters: Node, Bun, Deno, Cloudflare Workers/DO, Vercel (draft), SSE fallback, pub/sub), Hono `upgradeWebSocket` (Cloudflare: no `onOpen`). | **Best**: one DO per "room" = one user's device set; zero idle cost; Paseo proves it in production. |
| **Vercel Functions (Fluid compute)** | WebSockets **public beta on all plans** (changelog 2026-06-22; docs updated 2026-08-10; KB updated 2026-10-01). "A single WebSocket connection is pinned to one Vercel Function instance"; "WebSocket connections close when a Vercel Function reaches its maximum duration" (Hobby 300 s; Pro 300 s default, up to 800 s; 1800 s beta); "Store durable state ... in an external data store" (Redis). Bun runtime supports `Bun.serve()` websockets but "The `drain` handler is not invoked" and `socket.send()` does not return `-1` backpressure. Hobby plan: "non-commercial, personal use only". | Workable only with ≤5-minute reconnect cycles and Redis for queued frames; adds cost/complexity; not recommended as primary. |
| **Fly.io** | No free tier found (2026 docs); shared-cpu-1x 256 MB ≈ $1.81/month (base region); egress $0.02/GB NA/EU; stopped machine rootfs $0.15/GB/30 days. | Good for a plain Bun/Node `ws` relay with persistent connections; small fixed cost. |
| **Railway** | $5 one-time trial credit (30 days); Hobby $5/month incl. $5 usage; memory ≈$10/GB/month, vCPU ≈$20/month, egress $0.05/GB. | OK; pricier than Fly for always-on. |
| **Deno Deploy** | Free: 1M req/month, 20 GiB egress, 10 CPU-hours, 150 GiB-hr memory; Pro $20/month. WebSocket max connection duration **unverified**. | Possible; lock-in to Deno runtime. |
| **Supabase Realtime** | Free: 200 concurrent connections, 100 msg/s, 256 KB broadcast payload, 100 channels/connection; disconnects when over throughput. | Can carry opaque ciphertext but couples you to Supabase auth; throughput cap is tight for transcript streams. |
| **Ably** | Free: 6M msg/month, 200 concurrent connections/channels; Standard $29/month. | Fine technically; recurring cost and vendor lock-in. |
| **PartyKit** | `partykit/partykit` README: "Current development of this project is in cloudflare/partykit"; last push 2026-01-29. Successor `cloudflare/partykit` (partyserver, partysocket 1.3.0, y-partyserver) is "a Work in Progress", ISC, 1,278★. | Use `partyserver`/`partysocket` on Cloudflare if you want helpers; treat the old platform as deprecated. |
| **Cloudflare Realtime (SFU + TURN)** | SFU "routes WebRTC audio, video, and DataChannels"; first 1,000 GB/month free shared between SFU and TURN, then $0.05/GB egress (page updated 2026-09-22). TURN: `turn.cloudflare.com` 3478/udp, 443/udp, 80/tcp, 5349/tcp, 443/tcp (TLS 1.1–1.3); per-allocation limits 50–100 Mbps, 5–10 kpps; short-lived credentials via `POST https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers` with `ttl`. | Excellent free TURN if you add a WebRTC DataChannel path later. |

**WebRTC DataChannels (P2P, later-phase option)**: browsers and phones have native WebRTC; the problem is the core. `werift` 0.24.4 (pure TS, Node ≥22, MIT, 630★, "production-ready core ... hardening toward 1.0", DataChannel/DTLS/ICE/TURN over UDP/TCP/TLS); `node-datachannel` 0.33.4 (libdatachannel N-API, MPL-2.0, prebuilt for macOS arm64/Linux/Windows/Android, Electron; Bun not mentioned); `@roamhq/wrtc` 0.10.0 (WebRTC M106, Node 20/22, BSD-2, macOS arm64 marked "?", last push 2026-03-18). **Bun has no `RTCPeerConnection`** (no open/closed WebRTC issue found) and **no WebTransport** (#13656 open; PR #29796 closed 2026-06-26 as stale "predates the Rust rewrite"). Verdict: P2P only as an optional plugin on Node, with Cloudflare TURN; the relay path must exist anyway.

**WebTransport/HTTP3**: Chrome 97+, Edge 98+, Firefox 114+, **Safari 26.4+ (desktop and iOS)**, 91.3% global (caniuse). Server side in TS only via `@fails-components/webtransport` (libquiche, fingerprint-pinned certs, "experimental" HTTP/2 mode, 242★); Bun lacks it. Not viable for a relay in 2026; revisit 2027.

**iroh (n0-computer)**: v1.3.0 (2026-09-28), 12,625★, Apache-2.0/MIT, QUIC + hole punching + relays; `@number0/iroh` 1.1.0 (2026-07-16) N-API bindings "preferred over WebAssembly" for Node/Deno/Bun; **browser = WASM, relay-only** ("All connections from browsers to somewhere else need to flow via a relay server"), and "There is currently no official npm package" for the WASM build; public relays are "for development and hobby use", "No SLA", "exact rate limits aren't published"; self-host `iroh-relay` with token-bucket limits. No audit information found (**unverified**). Verdict: compelling for core↔core or desktop↔desktop direct connections later; not for the phone/browser path now (Expo would need the Swift/Kotlin FFI, browsers still need a relay).

**js-libp2p** 3.3.11 (Apache/MIT, 2,580★): transports for WebSockets, WebRTC, WebTransport, circuit relay, Noise encrypter — a full P2P stack that is far heavier than needed for 1 user × N devices.

**Tailscale / Headscale**: Personal plan free (6 users, unlimited devices); Funnel: ports 443/8443/10000 only, TLS terminates on your node ("Funnel relay servers do not decrypt the traffic"), "non-configurable bandwidth limits", KB (validated 2026-01-20) says "available for all plans" while the pricing page is ambiguous. `tsnet` is Go-only — no TS embedding; `tailscale-js` not found (**unverified**). Headscale v0.29.4 (BSD-3, 44,284★) for self-hosted control plane. Verdict: offer "bring your own Tailscale/Cloudflare Tunnel/ngrok URL" as a direct-connection option (the CodeRemote/VibeTunnel/Paseo model), never as the only path.

**Cloudflare Tunnel / ngrok**: Quick Tunnels need no account but "no uptime guarantee", 200 in-flight requests, **no SSE**, hostname changes per run; Cloudflare's proxy supports WebSockets on all plans with an idle timeout. ngrok free: 1 GB transfer, 3 endpoints, interstitial page on HTTP endpoints, TCP needs card verification; Hobbyist $10/month.

**SSE** for mirror-only clients: cheap one-way option (works through Cloudflare named tunnels and Vercel; not Quick Tunnels). Since every client also sends commands, a single WebSocket is simpler; keep SSE only for a read-only "status wall".

**Yjs providers**: `y-websocket` 3.1.0 (2026-08-06) healthy; `y-webrtc` 10.3.0 last published 2023-12-28 and repo last pushed 2024-04-28 → **stale**.

**Zero-knowledge relay design** (synthesis of Paseo/Happy/iroh/Tailscale-Funnel): relay forwards opaque frames; room identifier is non-secret but occupancy is authorized by a signature from the core's identity key; relay stores bounded ciphertext queues with offsets for resume; metadata it can still see: IPs, timing, sizes, room ids (state this honestly, as iroh and Paseo do).

### 2.3 E2EE primitives and protocols

| Candidate | Version / date (npm or gh) | Audit status (as stated by the project) | Notes |
|---|---|---|---|
| `@noble/curves` | 2.4.0 (2026-08-27); ESM-only, Node ≥20.19 | **Trail of Bits Aug 2026 (v2.3.0)**, Cure53 Sep 2024 (v1.6.0), Kudelski Sep 2023, ToB Feb 2023 | x25519, ed25519, p256, OPRF (RFC 9497), webcrypto wrapper; "algorithmic constant time" with JIT caveats |
| `@noble/ciphers` | 2.4.0 (2026-08-27) | **Cure53 Sep 2024 (v1.0.0)**, OpenSats-funded | XChaCha20-Poly1305, AES-GCM, AES-GCM-SIV; ~3 KB gz ChaCha; zero deps |
| `@noble/hashes` | 2.4.0 | Cure53 Jan 2022 | SHA-2/3, BLAKE, HKDF, HMAC, scrypt/argon2; 63M weekly downloads |
| `@noble/post-quantum` | 0.7.1 (2026-08-27) | **"not been independently audited yet"**; self-audit Apr 2026; reproducibility study vs 0.7.0 | ML-KEM-512/768/1024 (FIPS 203), ML-DSA, SLH-DSA, **X-Wing (ML-KEM-768 + X25519)**, ~7 KB gz ML-KEM; ~4,661 keygen/s on M4 |
| WebCrypto (browser) | X25519: Chrome 133, Edge 133, Firefox 130, Safari 17 (88.4%); Ed25519: Chrome 137, Edge 137, Firefox 129, Safari 17 (88%) | Platform-native | AES-GCM, HKDF, PBKDF2 universal; **no XChaCha** |
| WebCrypto (Node) | Ed25519/X25519 stable since v23.5/v22.13/v20.19.3; ChaCha20-Poly1305 + SHA-3 v24.7; Argon2 v24.8; ML-KEM/ML-DSA v24.7 and hybrid `MLKEM768-X25519` v26.10 at "Stability 1.1" | OpenSSL-backed | Local run on Node 24.14.0: X25519/Ed25519/AES-GCM/HKDF OK |
| WebCrypto (Bun) | Bun 1.4.2 (2026-09-05): local run OK for X25519 deriveBits, Ed25519 sign/verify, AES-GCM, HKDF, `CompressionStream` | — | Older PRs closed as stale after Bun's "Rust rewrite"; test in CI per Bun release |
| `libsodium-wrappers(-sumo)` | 0.8.4 (2026-04-19), ISC | Wrapper not audited (libsodium core audits **unverified here**) | ~290 KB gz standard / 375 KB sumo; WASM + JS fallback; Node/Bun/browser |
| `sodium-native` | 5.1.0 (2026-03-06), MIT (holepunch) | — | Native; no browser |
| `sodium-plus` | 0.9.0 (2020-07-23) | — | **Stale** |
| `tweetnacl` | 1.0.3 (2020-02-10), Unlicense | Cure53 2017 audit (**unverified here**) | What Happy and Paseo use; small, frozen, no AES-GCM/HKDF |
| `@stablelib/x25519`, `chacha20poly1305`, `hkdf` | 2.0.1 (2025-01-03) | — | Used by Happy CLI for base64/hex only |
| **Noise** spec | rev 34 (2018-07-11); NN/NK/XX/IK/KK; 25519/448, ChaChaPoly/AESGCM, SHA256/512, BLAKE2; 64-bit counter nonce; PSK modifiers | — | Reference design for the handshake |
| `@chainsafe/libp2p-noise` | 17.0.0 (2025-09-25), Apache/MIT, 43★ | none stated | XX for libp2p; "based on @noble"; libp2p-bound API |
| `noise-handshake` (holepunch) | 4.2.0 (2025-12-01), Apache-2.0, 20★ | none stated | Generic patterns (IK example); sodium backend |
| `snow` (Rust) | v0.10.0 (2025-07-19) | **"has not received any formal audit"** | Would need WASM build |
| `hpke-js` / `@hpke/core` | 1.9.0 / 1.8.0 (2026-03-08), MIT | **"not been formally audited"**; passes RFC 9180 + Wycheproof vectors | WebCrypto-only core; X25519/P-256; ML-KEM + X-Wing extension packages; Node/Deno/Bun/CF |
| `ts-mls` | 1.6.4 (2026-08-28), MIT, 109★ | **"not undergone a formal security audit"** | RFC 9420; PQ ciphersuites; built on `@hpke/core`; overkill for 1 user × N devices |
| `openmls` (Rust) | 0.9.0 (2026-08-25) | — | Needs WASM; same overkill verdict |
| `@signalapp/libsignal-client` | 0.103.0 (2026-09-18), **AGPL-3.0** | Signal-internal | "Use outside of Signal is unsupported"; APIs may change without notice |
| `@privacyresearch/libsignal-protocol-typescript` | 0.0.16 (2023-05-06), GPL-3.0; repo last push 2023-07-18 | — | **Effectively abandoned** |
| `vodozemac` (Rust) / `@matrix-org/matrix-sdk-crypto-wasm` | 0.11.1 (2026-09-30) / 18.9.0 (2026-09-21), Apache-2.0 | **Least Authority audit, "no significant findings"** (date not shown; **unverified**) | Olm/Megolm/SAS/MSC4108 ECIES; WASM is Matrix-shaped, heavy |
| Signal **SPQR** | blog 2025-10-02 | Formal verification (Cryspen, ProVerif, hax→F*) | Triple Ratchet = Double Ratchet + ML-KEM-768 ratchet; FS + PCS |
| Apple **PQ3** | 2024-02-21 | Stebila proofs + ETH Zürich Tamarin | Kyber-1024 initial, Kyber-768 rekey ~every 50 msgs / weekly |
| **RFC 10024** | Aug 2026, Proposed Standard | IETF | `X25519MLKEM768`, `SecP256r1MLKEM768`, `SecP384r1MLKEM1024` for TLS 1.3 |
| **X-Wing** | draft-connolly-cfrg-xwing-kem-11 (2026-09-23) | "not endorsed by the IETF", individual submission | X25519 + ML-KEM-768 with SHA3-256 combiner; IND-CCA bound stated |
| **OPAQUE** | **RFC 9807 (July 2025, Informational, IRTF)** | — | `@serenity-kit/opaque` (opaque-ke WASM, RFC 9807, MIT, 124★, **7ASecurity pentest via OTF Red Team Lab**); `@cloudflare/opaque-ts` 0.7.5 (2022-02-15, draft-07) **stale** |
| **CPace** | draft-irtf-cfrg-cpace-21 (2026-04-23), not yet RFC | — | No audited TS implementation found (**unverified**) |
| **MSC4108** (Matrix QR login) | PR still **open** (not merged) | — | ECIES + check code pattern; implemented in vodozemac |
| **Matrix SAS** | spec | — | ECDH + commitment + HKDF → 3×4-digit decimal or 7 emoji + MAC exchange |
| **WebAuthn PRF** | MDN: deterministic PRF output per credential, `eval`/`evalByCredential`, "could ... create a symmetric key for end-to-end encryption" | — | Support fragmented: Bitwarden says Chrome + YubiKey 5 are PRF-capable, macOS needs Chromium, Windows 10 "known to have issues"; Safari/iOS **unverified** |
| `@simplewebauthn/server` | 14.0.3 (2026-09-25), MIT, 2,362★ | — | Passkey registration/auth for the relay or hosted UI |
| `@scure/bip39` | Cure53 Jan 2022 (v1.0.0), self-audit Apr 2026 (v2.2.0); only dep `@noble/hashes`; 14 KB gz | — | Recovery phrases |
| Framing: `cbor-x` 1.6.6, `msgpackr` 2.1.0, `@bufbuild/protobuf` 2.16.0 | MIT / MIT / Apache+BSD | — | cbor-x: record structures, `setSizeLimits()` for untrusted input; protobuf-es: 100% conformance, schema evolution via field numbers |

**Threat-model-driven protocol choice.** With audited building blocks you can implement a Noise-style handshake in ~200 lines: X25519 (static + ephemeral on both sides, "KK/XX-like" with enrolled statics), HKDF-SHA-256 transcript-bound key derivation, XChaCha20-Poly1305 (24-byte nonce lets you carry a random prefix + 64-bit counter) or AES-256-GCM via WebCrypto with a strictly increasing 96-bit counter nonce, explicit `seq` in the AAD for replay rejection, and periodic rekey (Noise's "rekey after N messages / time" rule). Optional PQ-hybrid: encapsulate ML-KEM-768 to the peer's KEM key and mix the shared secret into the HKDF alongside the X25519 secret (X-Wing/RFC 10024 ordering). This mirrors what Paseo and Happy do but adds mutual device authentication, counters and rekeying.

### 2.4 Multi-client sync model

| Option | Version (npm, 2026-10-01) | What it is | Fit for "core is source of truth, N mirrors" |
|---|---|---|---|
| **Event-sourced log + snapshots** (custom) | — | Core appends `{seq, ts, sessionId, type, payload}`; clients `subscribe(since=seq)`; snapshot + tail on (re)connect; commands carry `cmdId` and are acknowledged by events | **Best**: single writer, deterministic, trivially encrypted per frame, resumable by `seq`, matches Claude Code Remote Control's "server routes messages ... stored transcript keeps the conversation in sync" behavior without the server reading anything |
| Durable Streams | `@durable-streams/client` 0.2.7 (Beta), MIT, 1,706★, Electric-maintained | HTTP protocol for "persistent, addressable, real-time streams" with offset catch-up + live tail | Borrow the offset/resume semantics for the relay queue; server impls (Node ref, Caddy plugin) are not E2EE-aware |
| LiveStore | 0.4.0 (2026-06-02), Apache-2.0, 3,716★ | Event sourcing + reactive SQLite + materializers; Cloudflare sync provider | Closest "engine" to the recommended model but client-centric (events originate on clients), no E2EE |
| Yjs | 13.6.33, MIT, 22,873★; y-websocket 3.1.0; y-webrtc stale (2023) | CRDT shared types, binary updates, state-vector diff | Multi-writer merge you do not need; no built-in encryption ("Velt, secsync" add it) |
| Automerge 3 | 3.5.0 (2026-09-16), MIT, 6,633★; Automerge 3.0 July 2025 "over 10x" memory reduction | CRDT with full history; `automerge-repo` server | Same as Yjs; heavier WASM |
| Loro | 1.16.4 (2026-09-30), MIT, 6,178★ | CRDT (Fugue text, movable tree/list), shallow snapshots | Same verdict |
| Jazz | `jazz-tools` 0.20.19 (2026-07-03); repo at **v2.0.0-alpha.58** "entirely new API", 199★ | Local-first DB with built-in E2EE/permissions, Jazz Cloud | The only E2EE-native engine, but alpha + vendor cloud; revisit when 2.0 stabilizes |
| Electric | `@electric-sql/client` 1.5.28, Apache-2.0, 10,379★ | Postgres → HTTP "shapes" read-path sync | Needs Postgres; no E2EE |
| Zero (Rocicorp) | `@rocicorp/zero` 1.9.0, Apache-2.0 | zero-cache in front of Postgres | Needs Postgres + server |
| PowerSync | `@powersync/web` 2.4.2, Apache-2.0 | Postgres/Mongo/MySQL → SQLite | Needs backend DB |
| TinyBase | 10.0.1, MIT, 5,182★ | Reactive in-memory store with sync | Possible client-side cache; still custom transport |
| Triplit | `@triplit/client` 1.0.50 (2025-07-31), AGPL-3.0; repo last push 2026-01-19 | Sync DB | **AGPL + stale**; rejected |
| Instant | `@instantdb/core` 1.0.67, Apache-2.0, 10,536★ | Hosted graph DB | Hosted; no E2EE |
| TanStack DB | `@tanstack/db` 0.11.0 (Beta), MIT, 3,925★ | Reactive client collections + live queries + optimistic mutations | **Useful on the client** as the mirror store fed by the event log (query/local adapters), without adopting Electric |

**Schemas and versioning**: envelope `{v: 1, t: "evt"|"cmd"|"ack"|"snap", seq, cid?, body}` encoded with `cbor-x` (set `setSizeLimits`, disable structured-clone for untrusted input) or protobuf-es if you want cross-language clients (Swift/Kotlin) later; unknown fields ignored; breaking changes bump `v` and the handshake negotiates the max common version (never silently downgrade security parameters).

**Backpressure**: Bun `ws.send()` returns `-1` on backpressure (not on Vercel), `ws` exposes `bufferedAmount`; coalesce transcript token deltas into ≤50 ms batches, cap per-client outbound queue (e.g., 2 MB), and when a client lags beyond the retained window, drop its tail and resend a snapshot. Relay side: DO `pendingFrames` must be bounded (Paseo uses 200 frames) and ideally persisted to SQLite with TTL so phones can resume after sleep.

**Snapshot compression**: `CompressionStream('gzip'|'deflate')` is "Baseline: widely available" since May 2023 and works in Node 24 and Bun 1.4.2 (verified); zstd available in Node `zlib` since v22.15/v23.8 (experimental) and `Bun.zstdCompressSync` (levels 1–22). Compress **before** encrypting (ciphertext is incompressible) and disable WebSocket `perMessageDeflate` for the encrypted channel.

### 2.5 Secrets and keys at rest

| Mechanism | Verified facts | Recommendation |
|---|---|---|
| `Bun.secrets` | Added in Bun 1.2.21 (2025-08-25): Keychain (macOS), libsecret (Linux), Credential Manager (Windows); `get/set/delete`, async in thread pool; docs call it experimental and "mostly useful for local development tools"; issue #28071 (open since 2026-03-13): any `bun` script can read another's secret with no prompt because Keychain attributes access to the shared `bun` binary (compiled binaries prompt); #40645/#40642 (timeouts/thread pool) open | Fine for dev tokens; for identity keys prefer `@napi-rs/keyring` and additionally wrap keys with a per-install key file (defense in depth) |
| `@napi-rs/keyring` | 2.1.0 (2026-09-13), MIT, 103★; Rust `keyring` crate; Linux auto-selects Secret Service or kernel keyutils (not persistent across reboot) with explicit `{ linux: { store } }` option | **Default** for Node and Bun (N-API) |
| `keytar` | **Archived 2022-12-15** | Do not use |
| Tauri | `tauri-plugin-stronghold` (encrypted vault, argon2, not OS keychain; scrypt upstream bug workaround); `tauri-plugin-keyring` (community wrapper of `keyring` crate, 20★, 12 commits) | If desktop is Tauri, use Rust `keyring` directly in a command |
| `age` / typage | age v1.3.2; `age-encryption` 0.3.1 (noble-only deps; X25519 + scrypt passphrase; **WebAuthn/passkey recipients**; Node 20+/Bun/Deno/browsers; PQ hybrid support mentioned) | Encrypt exported backups/config with age; passkey recipient is a neat "security sells" demo |
| `sops` | v3.13.3 (2026-07-23), MPL-2.0, CNCF Sandbox (2023); age backend | For maintainers' own secrets in git, not end-user storage |
| Secure Enclave / TPM | Apple: P-256 only, sign + ECDH, non-exportable; Node/Bun have **no** Secure Enclave API; Secretive (8.9k★) shows SE-backed SSH keys with Touch ID | Hardware-bound device identity is practical only via WebAuthn/passkeys (phone/browser) or a native helper (Tauri/Swift) — not via the Bun core today |
| Git credentials | Git Credential Manager (MIT, macOS 14+/Win/Linux, keychain-backed) and `gh auth` (uses keyring per `gh auth status`) | Never store git tokens yourself; shell out to the helper |
| Recovery code UX | Happy: 32-byte secret → base32 `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX` with auto-correction (0→O, 1→I); BIP-39 via `@scure/bip39` (24 words = 256 bits, Cure53-audited) | Show once at setup, offer re-display behind biometric/OS auth, allow re-pairing all devices from it |

### 2.6 Transport security basics (verified guidance)

- **Local server**: bind `127.0.0.1` only by default (OpenCode `127.0.0.1:4096`, Paseo `127.0.0.1:6767`; VibeTunnel's default of all interfaces is flagged in its own security doc). Validate `Host` against an allowlist to defeat DNS rebinding (Paseo `daemon.hostnames`). Chrome **Local Network Access** ships in Chrome 142: public sites fetching `localhost`/private IPs need a user permission; "WebSocket and WebRTC connections to local networks aren't yet permission-gated, though integration is planned" — so a *hosted* web UI must talk to the relay, and only a UI served from the local core may talk to `localhost` directly.
- **WebSocket hardening** (OWASP WebSocket cheat sheet + `ws` docs): `wss://` only off-box; validate `Origin` on every handshake in the HTTP `upgrade` handler (ws: `verifyClient` is discouraged); do not put tokens in the URL query (logs) — send a first-frame auth message or use the `Sec-WebSocket-Protocol` trick as Paseo does; set `maxPayload` far below the `ws` default of 100 MiB; message-level authorization; rate limits (~100 msg/min baseline), per-user connection quotas, idle timeouts, ping/pong heartbeats; log security events without tokens.
- **LAN access auth**: short-lived capability token minted by the core (shown as QR/deep link) rather than cookies; cookies invite CSRF on `localhost`; passkeys (WebAuthn) are the right step-up for the hosted UI (Claude Code's Trusted Devices re-prompts after 18 h).
- **CORS**: explicit allowlist (`--cors` style), never `*` with credentials; Paseo notes "CORS is not a complete security boundary".
- **Headers** (OWASP): `Content-Security-Policy`, `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`/`frame-ancestors`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: same-site`, `Cache-Control: no-store` on sensitive responses.
- **Supply chain / SAST**: Socket "is and will always be free to use for open-source" (GitHub app, blocks malicious packages); Semgrep Free: ≤10 contributors, SAST + supply chain, unlimited public repos (secrets detection is paid); CodeQL: private repos need a GitHub Code Security license (public-repo free status not stated on the fetched page — **unverified**, generally understood to be free); OpenSSF Scorecard action + badge; Dependabot; GitHub private vulnerability reporting (Settings → Advanced Security → Enable).
- **Audit / bounty later**: OSTIF (100+ audits published), GitHub Secure Open Source Fund ($10k + 3-week program, rolling applications), noble's audits were funded by OpenSats/EF — ByteBureau can apply once it has traction; until then publish a `SECURITY.md`, threat model, and reproducible builds.

---

## 3. Ranked recommendations + risks

### 3.1 Recommended end-to-end architecture ("ByteBureau Link")

**Identities and keys**
- Every device (core, phone, browser profile, desktop app) generates a long-term **Ed25519 signing key** (`@noble/curves/ed25519` or WebCrypto) and a long-term **X25519 agreement key**; optional **ML-KEM-768 KEM key** when PQ mode is on. Core keys live in the OS keychain via `@napi-rs/keyring`; phone keys in Expo SecureStore (Keychain/Keystore); browser keys as non-extractable WebCrypto keys in IndexedDB.
- A 256-bit **root secret** (shown once as 24 BIP-39 words) deterministically derives the core identity via HKDF so a user can re-pair after disaster; all other devices are *enrolled* (public keys stored by the core) and *revocable*.

**Pairing flow (QR, same room)**
1. Core creates a pairing offer: `bytebureau://pair#v=1&relay=<url>&room=<base64url 16 B>&core_pk=<X25519>&core_spk=<Ed25519>&otk=<base64url 16 B>&exp=<unix>` — in the **URL fragment** (Paseo pattern), TTL ≤2 min, single use.
2. Phone scans, connects to the relay room, runs the handshake below with `otk` mixed in as a PSK (prevents anyone who later sees the QR from pairing) and sends its static public keys inside the encrypted handshake payload.
3. Both screens show a **6-digit SAS** derived from the handshake transcript hash (Matrix SAS pattern); the user confirms on the core (Codex "approve pairing on desktop" pattern). Core enrolls the phone's keys with a device name.
4. Headless/no-camera: the core prints the same offer as a short pasteable link or 9 BIP-39 words; because `otk` is high-entropy, no PAKE is needed. Only if you later want 6-digit human codes do you need OPAQUE (RFC 9807, `@serenity-kit/opaque`) or CPace (not yet RFC).

**Per-connection handshake and record layer**
- Noise-style **mutual-authentication** handshake: both sides send fresh ephemeral X25519 keys; derive `ck`/`h` with HKDF-SHA-256 mixing `ee`, `es`, `se`, `ss` over the enrolled statics (KK pattern semantics), bind the transcript (`h`) into the final key split. PQ mode adds an ML-KEM-768 encapsulation to the responder's KEM key and mixes the KEM secret before the final split (RFC 10024 / X-Wing style). Reject unknown device statics (mutual auth is the point where Paseo/Happy are weaker).
- Record layer: XChaCha20-Poly1305 (`@noble/ciphers`) or AES-256-GCM (WebCrypto) with **64-bit monotonically increasing counters** as nonces and `seq` in AAD; receiver rejects non-increasing `seq` (replay/reorder protection — Paseo has none); rekey every 2^20 records or 24 h; close on any auth failure.
- Forward secrecy: ephemeral per connection; post-compromise security via periodic rekey + the ability to revoke a device and rotate the core identity from the root secret.

**Relay protocol (Cloudflare Worker + Durable Object per room)**
- `GET /v1/rooms/{room}/ws?role=core|client` with the first frame being a **relay capability token**: `{room, device_pk, exp}` signed by the core's Ed25519 key (the room's registered owner key; registration = proof-of-possession of `core_spk` from the offer). The relay verifies signatures only — it never sees content and cannot mint tokens. Clients get tokens from the core during pairing and on renewal over the encrypted channel.
- Relay stores ciphertext frames in a **bounded, offset-indexed queue** (DO SQLite, e.g., 10 MB / 24 h per room) so a sleeping phone resumes with `since=offset` (Durable Streams semantics); uses the Hibernation API; caps frame size (256 KB) and rate per connection; `/health`.
- Push notifications (APNs/FCM via Expo) carry **no content** ("A session needs your attention") or an encrypted blob the app decrypts; the token for push is registered via the encrypted channel.
- Self-hosting: one `wrangler deploy` on the free plan; publish the relay as its own package and document the exact metadata it can see.

**Transport fallback order (client-side)**
1. **LAN direct** (mDNS/`.local` advertisement → WebSocket to the core; same handshake, so TLS is optional but pinned keys are mandatory).
2. **Relay** (Cloudflare DO) — always-on default.
3. **User-provided direct URL** (Tailscale/Funnel, Cloudflare named tunnel, ngrok) — same handshake, just a different endpoint.
4. **(Later) WebRTC DataChannel** via relay signaling + Cloudflare TURN (free 1,000 GB/month) using `werift` or `node-datachannel` on a Node sidecar — only if latency/throughput of the relay path proves limiting.

**Sync model**
- Core maintains per-session **append-only event logs** (`seq`-numbered CBOR events: transcript deltas, tool calls, ask-dialogs, status) and periodic **snapshots** (compressed with `CompressionStream`/zstd before encryption).
- Clients subscribe `{session, since}`; receive `snap` + tail; render optimistically on their own commands (`cmd` with `cmdId`), reconcile on `ack`/`evt`. All clients (browser tab, desktop app, phone) use the same protocol; the core is the only writer, so no CRDT.
- Use TanStack DB (or a tiny custom store) as the in-memory mirror on clients; `cbor-x` records for the wire.

**Library choices (versions as of 2026-10-01)**
`@noble/curves` 2.4.0, `@noble/ciphers` 2.4.0, `@noble/hashes` 2.4.0 (audited); `@noble/post-quantum` 0.7.1 (flagged, unaudited) or Node ≥26.10 WebCrypto `MLKEM768-X25519`; `@scure/bip39` (audited); `cbor-x` 1.6.6; `ws` 8.22.0 or `Bun.serve`; `crossws` 0.4.12 / `partyserver` 0.5.10 for the DO; `@napi-rs/keyring` 2.1.0; `age-encryption` 0.3.1 for exports; `@simplewebauthn/server` 14.0.3 if the hosted UI adds passkeys; `expo-crypto` (`getRandomValues`) + noble on the phone.

### 3.2 Ranked options per decision

1. **Relay host**: Cloudflare DO (1) > Fly.io small VM (2) > Railway (3) > Vercel WebSockets beta (4, reconnect every ≤5 min, Redis, Hobby non-commercial) > Deno Deploy (5, duration unverified) > Supabase/Ably (6, lock-in, caps).
2. **Channel crypto**: noble/WebCrypto Noise-style construction (1) > HPKE via `hpke-js` for one-shot messages such as push payloads (2, unaudited but WebCrypto-backed) > libsodium.js (3, big bundle, wrapper unaudited) > TweetNaCl (4, frozen 2020) > Noise libs (5, unaudited, libp2p-shaped) > MLS/Signal (6, overkill/AGPL).
3. **PQ**: hybrid ML-KEM-768 + X25519 opt-in flag (1) > none (2) > PQ-only (never).
4. **Sync**: event log + snapshots (1) > LiveStore-style engine (2) > Yjs/Loro/Automerge (3, only if humans co-edit documents) > Postgres sync engines (4, wrong shape).
5. **Secrets**: `@napi-rs/keyring` (1) > `Bun.secrets` (2, isolation caveat) > age-encrypted file with OS-auth-gated passphrase (3) > plaintext config (never).
6. **Pairing**: QR with fragment offer + PSK + SAS + desktop approval (1) > bearer QR only (Paseo/Happy, 2) > typed low-entropy code + PAKE (3, more crypto surface).

### 3.3 Threat model table

| Threat | Mitigation in the recommended design | Residual risk |
|---|---|---|
| Malicious/compromised relay reads content | All frames encrypted end-to-end; relay only verifies signatures and forwards | Metadata: IPs, timing, sizes, room ids (state it; optional padding/jitter) |
| Relay replays, reorders, drops or injects frames | AEAD with `seq` in AAD, monotonic counters, transcript-bound keys; acks + resume offsets | Availability (DoS) only |
| Room squatting / impersonating the core on the relay | Room owner key registered with proof-of-possession; capability tokens signed by the core; client pins `core_spk` from the QR | Relay operator can still refuse service |
| QR shoulder-surfed / leaked later | Offer TTL ≤2 min, single-use `otk` as PSK, SAS confirmation and explicit approval on the core | Attacker present in the same 2-minute window and able to win the race before the user confirms |
| Stolen locked phone | Keys in Keychain/Keystore behind device lock; biometric gate for sensitive actions; revoke device from any other device | Platform compromise |
| Stolen unlocked phone | Device revocation + core rotates session keys; optional per-action step-up (passkey/biometric) for "stop session"/"approve dangerous tool" | Window until revocation |
| MITM on LAN or captive portal | Pinned identity keys; no plaintext fallback; version negotiation cannot downgrade | — |
| Hosted web UI tampering (relay operator serves JS) | Prefer native/desktop clients for high assurance; for the web UI: pinned CSP, SRI, reproducible builds, self-host option, keys non-extractable | Classic web-E2EE caveat — say so in docs |
| Compromised core machine | Out of scope (agents run there); keychain-stored keys limit disk exfil; rotate from root secret | Full compromise = full access |
| Supply chain | Lockfiles, Socket, Scorecard, Dependabot, provenance; minimal deps (noble has zero) | — |
| Push notification leakage | Content-free pushes or encrypted payloads | APNs/FCM see that *something* happened |
| Chat-bridge channels (Telegram/Discord) | Clearly labeled "not E2EE" opt-in plugin | Platform sees content |

### 3.4 What we can honestly claim in marketing

- "End-to-end encrypted remote control: the relay only ever sees ciphertext, never your prompts, code or transcripts."
- "Built on independently audited cryptography (noble: Trail of Bits 2026, Cure53 2024/2022) and platform WebCrypto — no homegrown ciphers."
- "Every device is paired with a QR code, a verification code and explicit approval; every connection uses fresh keys (forward secrecy) and replay-protected authenticated encryption."
- "No accounts, no passwords, no cloud copy of your sessions. Self-host the relay in minutes on a free tier, or run fully offline on your LAN."
- "Post-quantum hybrid key exchange (ML-KEM-768 + X25519, the same combination standardized for TLS in RFC 10024) available as an option."
- "Secrets stay in your OS keychain; a one-time recovery phrase lets you rebuild without ever uploading keys."
- Do **not** claim: "zero-knowledge of metadata", "audited product" (until an external audit of ByteBureau itself), "post-quantum secure" without "hybrid/experimental", "unbreakable/military-grade", or that the hosted web UI is as trustworthy as the native apps.

### 3.5 Key risks

- **Unaudited PQ code** (`@noble/post-quantum`) — mitigated by hybrid construction and a feature flag; prefer Node WebCrypto ML-KEM when available.
- **Bun platform churn** — WebCrypto X25519/Ed25519 work today (verified), but PRs were closed as stale after a "Rust rewrite"; keep a CI crypto smoke test per Bun release and a Node fallback for the core.
- **Expo crypto gap** — no `crypto.subtle` in React Native (SDK 57); noble pure-JS is fine for a chat-rate channel, but benchmark ML-KEM on low-end Android.
- **Relay abuse/cost** if you host a public relay: enforce per-room quotas; the free DO tier (100k req/day, WS messages 20:1) covers hobby scale only.
- **Cloudflare lock-in** of the relay: keep the relay protocol transport-agnostic (plain WebSocket + JSON/CBOR frames) so a Bun `ws` implementation on Fly/Railway is a drop-in.
- **Web UI trust** — the classic E2EE-in-browser caveat; document it and ship native clients first.

---

## 4. Rejected options (and why)

- **Vercel as primary relay**: connections die at `maxDuration` (300/800 s), instance pinning, external Redis required, Hobby plan non-commercial. Keep only as a documented alternative.
- **Supabase Realtime / Ably / Pusher-style**: vendor auth coupling, hard caps (100 msg/s free on Supabase), recurring fees; nothing they add that a 300-line DO does not.
- **WebTransport**: Safari only from 26.4, no Bun support, Node support experimental with fingerprint certificates.
- **iroh / js-libp2p as the phone transport**: browsers must relay anyway; no official WASM npm; Expo would need FFI; libp2p is far too large. Revisit iroh for core↔core.
- **Tailscale-only (CodeRemote model)**: great security, poor onboarding for non-technical "watch my agent" moments; `tsnet` is Go-only so it cannot be embedded in a TS core. Keep as an optional direct path.
- **MLS (`ts-mls`, OpenMLS)**: group-key machinery for many parties; unaudited TS; ByteBureau is 1 user × N devices with a single writer.
- **Signal Double Ratchet (`libsignal`)**: AGPL and explicitly unsupported outside Signal; the TS port is abandoned (2023).
- **Matrix vodozemac WASM**: audited but Matrix-shaped and heavy; MSC4108 is still an open proposal.
- **TweetNaCl-only (Happy/Paseo)**: frozen since 2020, no AES-GCM/HKDF, no counters; noble gives the same primitives with 2024–2026 audits.
- **CRDT engines (Yjs/Automerge/Loro) for session state**: multi-writer merge is unnecessary; no E2EE; extra WASM. Jazz is the exception but is 2.0-alpha.
- **Postgres sync engines (Electric, Zero, PowerSync, Instant)**: require a server-side database that would have to hold plaintext or be blind — wrong shape.
- **`keytar`** (archived 2022), **`sodium-plus`** (2020), **`y-webrtc`** (2023), **`@privacyresearch/libsignal-protocol-typescript`** (2023), **`@cloudflare/opaque-ts`** (2022 draft-07), **Triplit** (AGPL, stale): deprecated or stale.
- **Low-entropy pairing codes + PAKE** at launch: adds OPAQUE/CPace surface; high-entropy offer links solve the headless case.
- **Cookie-based auth for the local server**: CSRF/DNS-rebinding footguns; capability tokens + Host allowlist instead.
- **Chat-app bridges as the E2EE path**: Telegram/Discord see everything; only as a clearly labeled plugin.

---

## 5. Open questions for the owner

1. **Phone client stack**: Expo app (push notifications, SecureStore, QR scanning; crypto via noble pure-JS) vs. PWA (WebCrypto X25519/Ed25519 available on iOS 17+, but iOS push/QR UX is weaker). This decides whether `crypto.subtle` can be assumed on the phone.
2. **Will you host a public relay** (free DO tier, abuse handling, legal/privacy page) or ship "self-host in one command" as the default with a community relay as convenience? Happy and Paseo both host one for free.
3. **Core runtime**: Bun-only, or Bun with a Node fallback? (Relevant to WebCrypto ML-KEM availability in Node ≥24.7/26.10 and to `node-datachannel`/`werift` for a future WebRTC path.)
4. **PQ-hybrid at launch** behind a flag (unaudited `@noble/post-quantum`) or wait for an audit/WebCrypto parity? Marketing value vs. honesty budget.
5. **Multi-human teams**: if several humans will share one core (team "office"), per-device enrollment still works, but you will want per-user authorization and audit logs; MLS-style group keys are still unnecessary as long as the core is the single writer.
6. **Desktop app shell** (Tauri vs. Electron vs. none): affects keychain path (Rust `keyring` vs. `@napi-rs/keyring`) and whether the web UI is ever served by the relay (web-E2EE caveat).
7. **Retention on the relay**: how long should ciphertext queues persist for sleeping phones (minutes vs. 24 h)? Longer = better UX, more stored ciphertext.
8. **Hosted web UI integrity**: are you willing to publish reproducible builds + SRI hashes so users can verify the UI the relay serves?
9. **Should browser tabs on the same machine talk to the core via `localhost` (fast, needs Host allowlist + tokens) or always via the relay (uniform, slower)?** Chrome 142's Local Network Access permission affects hosted UIs only.
10. **Audit timeline**: plan to apply to OSTIF / GitHub Secure Open Source Fund after v1; who pays for an external audit if neither comes through?

---

## 6. Sources (fetched 2026-10-02)

Existing tools
- Claude Code Remote Control: https://code.claude.com/docs/en/remote-control
- Claude Code cloud sessions: https://code.claude.com/docs/en/claude-code-on-the-web
- Claude Code Channels: https://code.claude.com/docs/en/channels
- Codex Remote: https://learn.chatgpt.com/codex/remote ; Codex app: https://learn.chatgpt.com/docs/app
- Happy: https://github.com/slopus/happy ; https://github.com/slopus/happy-server ; raw `docs/encryption.md`, `packages/happy-agent/src/auth.ts`, `packages/happy-app/sources/auth/authQRStart.ts`, `secretKeyBackup.ts`, `packages/happy-cli/package.json` (via raw.githubusercontent.com) ; happy-server package.json via `gh api`
- Paseo: https://github.com/getpaseo/paseo ; https://paseo.sh ; https://paseo.sh/docs/security ; raw `SECURITY.md`, `packages/relay/src/{e2ee,crypto,encrypted-channel,cloudflare-adapter,index}.ts`, `packages/relay/package.json`, `packages/server/src/server/{pairing-offer,pairing-qr}.ts`, `packages/client/src/daemon-client-relay-e2ee-transport.ts`, `packages/app/src/polyfills/crypto.ts`
- Omnara: https://github.com/omnara-ai/omnara ; https://omnara.com ; raw `SECURITY.md`
- VibeTunnel: https://github.com/amantus-ai/vibetunnel ; raw `docs/security.md`
- CodeRemote: https://coderemote.dev ; Conductor: https://conductor.build ; Blink: https://blink.sh
- OpenCode server: https://opencode.ai/docs/server/
- claude-code-telegram: https://github.com/RichardAtCT/claude-code-telegram (now overwirehq)

Transport / hosting
- Vercel: https://vercel.com/docs/functions/websockets ; https://vercel.com/docs/fluid-compute ; https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections ; https://vercel.com/changelog/websocket-support-is-now-in-public-beta ; https://vercel.com/docs/plans/hobby
- Cloudflare: https://developers.cloudflare.com/durable-objects/best-practices/websockets/ ; https://developers.cloudflare.com/durable-objects/platform/pricing/ ; https://developers.cloudflare.com/durable-objects/platform/limits/ ; https://developers.cloudflare.com/workers/platform/limits/ ; https://developers.cloudflare.com/workers/platform/pricing/ ; https://developers.cloudflare.com/realtime/turn/ ; https://developers.cloudflare.com/realtime/turn/generate-credentials/ ; https://developers.cloudflare.com/realtime/pricing/ ; https://developers.cloudflare.com/realtime/sfu/ ; https://developers.cloudflare.com/network/websockets/ ; https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/
- PartyKit: https://github.com/cloudflare/partykit ; https://github.com/partykit/partykit
- Fly.io: https://docs.fly.io/about/pricing ; Railway: https://railway.com/pricing ; Deno Deploy: https://deno.com/deploy/pricing ; https://docs.deno.com/deploy/manual/pricing-and-limits/ ; Supabase: https://supabase.com/docs/guides/realtime/limits ; Ably: https://ably.com/pricing ; ngrok: https://ngrok.com/pricing
- Tailscale: https://tailscale.com/kb/1223/funnel ; https://tailscale.com/kb/1244/tsnet ; https://tailscale.com/pricing
- WebRTC: https://github.com/shinyoshiaki/werift-webrtc ; https://github.com/murat-dogan/node-datachannel ; https://github.com/WonderInventions/node-webrtc ; Bun issues #13656, #29796 (via `gh api`)
- WebTransport: https://caniuse.com/webtransport ; https://github.com/fails-components/webtransport
- iroh: https://github.com/n0-computer/iroh ; https://github.com/n0-computer/iroh-ffi ; https://docs.iroh.computer/what-is-iroh ; https://docs.iroh.computer/languages/wasm-browser ; https://docs.iroh.computer/iroh-services/relays/public ; https://docs.iroh.computer/relays/rate-limiting
- Bun WebSockets: https://bun.com/docs/api/websockets ; crossws: https://crossws.h3.dev/ ; Hono: https://hono.dev/docs/helpers/websocket ; js-libp2p README via `gh api`; Yjs: https://github.com/yjs/yjs

Crypto
- noble: https://github.com/paulmillr/noble-ciphers ; https://github.com/paulmillr/noble-curves ; https://github.com/paulmillr/noble-post-quantum ; https://paulmillr.com/noble/ ; https://github.com/paulmillr/scure-bip39
- libsodium.js: https://github.com/jedisct1/libsodium.js ; Noise spec: https://noiseprotocol.org/noise.html ; https://github.com/ChainSafe/js-libp2p-noise ; https://github.com/holepunchto/noise-handshake ; https://github.com/mcginty/snow
- WebCrypto support: https://caniuse.com/mdn-api_subtlecrypto_derivekey_x25519 ; https://caniuse.com/mdn-api_subtlecrypto_sign_ed25519 ; https://nodejs.org/api/webcrypto.html ; local test script `wc-test.mjs` on Bun 1.4.2 / Node 24.14.0
- HPKE/MLS/Signal/Matrix: https://github.com/dajiaji/hpke-js ; https://github.com/LukaJCB/ts-mls ; https://github.com/signalapp/libsignal ; https://github.com/matrix-org/vodozemac ; https://github.com/matrix-org/matrix-sdk-crypto-wasm ; https://signal.org/blog/spqr/ ; https://security.apple.com/blog/imessage-pq3/
- PQ standards: https://datatracker.ietf.org/doc/draft-ietf-tls-ecdhe-mlkem/ (RFC 10024) ; https://datatracker.ietf.org/doc/draft-connolly-cfrg-xwing-kem/
- Pairing/PAKE: https://spec.matrix.org/latest/client-server-api/#short-authentication-string-sas-verification ; MSC4108 PR state via `gh api` ; https://datatracker.ietf.org/doc/draft-irtf-cfrg-opaque/ (RFC 9807) ; https://datatracker.ietf.org/doc/draft-irtf-cfrg-cpace/ ; https://github.com/serenity-kit/opaque ; https://github.com/cloudflare/opaque-ts
- WebAuthn: https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API/WebAuthn_extensions ; https://bitwarden.com/help/login-with-passkeys/ ; https://passkeys.dev/device-support/ ; https://github.com/MasterKale/SimpleWebAuthn (via gh api)
- Framing: https://github.com/kriszyp/cbor-x ; https://github.com/bufbuild/protobuf-es
- Expo: https://docs.expo.dev/versions/latest/sdk/crypto/

Sync
- https://github.com/durable-streams/durable-streams ; https://github.com/livestorejs/livestore ; https://github.com/garden-co/jazz ; https://jazz.tools/docs ; https://automerge.org/blog/automerge-3/ ; https://github.com/loro-dev/loro ; https://github.com/TanStack/db ; https://zero.rocicorp.dev/docs/introduction ; https://electric.ax/docs/intro ; npm registry metadata for all packages (see `npm-meta.tsv`)

Secrets
- https://bun.com/docs/runtime/secrets ; https://bun.com/blog/bun-v1.2.21 ; Bun issue #28071 (via `gh api`) ; keyring-node README via `gh api` ; https://github.com/atom/node-keytar ; https://v2.tauri.app/plugin/stronghold/ ; https://github.com/HuakunShen/tauri-plugin-keyring ; https://github.com/FiloSottile/typage ; https://github.com/getsops/sops ; https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave ; https://github.com/maxgoedjen/secretive ; https://github.com/git-ecosystem/git-credential-manager

Security basics
- https://github.com/websockets/ws/blob/master/doc/ws.md ; https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html ; https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html ; https://developer.chrome.com/blog/local-network-access ; https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository ; https://docs.github.com/en/code-security/code-scanning/introduction-to-code-scanning/about-code-scanning ; https://semgrep.dev/pricing ; https://socket.dev/pricing ; https://github.com/ossf/scorecard ; https://ostif.org/ ; https://github.com/open-source/github-secure-open-source-fund ; https://nodejs.org/api/zlib.html ; https://developer.mozilla.org/en-US/docs/Web/API/CompressionStream ; https://bun.com/docs/api/utils

Raw metadata files saved next to this report: `gh-meta.tsv` (stars/license/last push/archived), `gh-releases.tsv` (latest release tag/date), `npm-meta.tsv` (latest version/date/license/deprecation).
