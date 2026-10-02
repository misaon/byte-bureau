# ByteBureau research cluster 04 — Sandboxing, isolation, and workspace runtimes for coding agents

Research date: 2026-10-02. All versions/dates below were observed in the cited sources on that day (GitHub API, npm registry, vendor docs). Items marked **unverified** have only one source or were inferred.

---

## 1. Executive summary

1. **Default driver: a hardened "container-per-session" driver on the Docker Engine API** (via `dockerode` 5.0.1 or the `docker` CLI), with one universal multi-arch `bureau-dev` image (amd64 + arm64) and an optional `devcontainer.json` path via `@devcontainers/cli` 0.89.0. It is the only option that runs identically on a MacBook (Docker Desktop / OrbStack / Colima / Podman socket), Linux VPS, Raspberry Pi 5 (Debian arm64 packages are "fully supported"), and ports to Kubernetes with the same image. Egress is controlled by a core-owned allowlist proxy (the Anthropic devcontainer firewall + Claude Code's own sandbox proxy are the reference designs). Hardening profile in §6.
2. **Preferred driver when available: Docker Sandboxes (`sbx`)**. Since 2026-01-30 it runs each agent in a **microVM with its own kernel and its own Docker daemon**, host-side credential proxy (the VM only ever sees sentinel values), deny-by-default network policies, and a free, **standalone** CLI ("You don't need Docker Desktop or Docker Engine to use `sbx`") on macOS 14+ (Apple Silicon), Windows 11 and Ubuntu 24.04+/KVM. It officially supports Claude Code, Codex, OpenCode, Copilot, Cursor, Devin, Gemini, Kiro, Droid, Docker Agent and a plain shell. Downsides: proprietary, CLI-only for local sandboxes (the REST/TS SDK is cloud-only and experimental), fast-moving (the old `docker sandbox` plugin was removed in Docker Desktop 4.93.0, 2026-09-28), no Raspberry Pi OS support.
3. **Fallback / dev-mode driver: host git worktree**, optionally wrapping the agent in Anthropic's `@anthropic-ai/sandbox-runtime` (`srt`, 0.0.78, Apache-2.0, beta) for OS-level filesystem+network restriction without containers. This is the pattern every current agent manager (Vibe Kanban, Superset, Emdash, Paseo, Claude Squad, CCManager, Conductor, Crystal) uses, and the least secure.
4. **Credential strategy for subscription agents (the hard problem).** Anthropic's legal page now says OAuth tokens are for "ordinary use of Claude Code and other native Anthropic applications", developers "may not collect, store, or intermediate Claude.ai credentials or session tokens", **but** "nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code … in hosted sandboxes or other agent infrastructure", provided the binary is unmodified, no auth method is disabled, and every user authenticates and is billed themselves. Enforcement against third-party harnesses started 2026-04-04 (OpenCode removed Claude-subscription auth in v1.3.0). ByteBureau must therefore (a) run the **unmodified `claude` binary** inside the workspace, (b) let the **user complete `/login` through Anthropic's own flow** into a per-workspace `CLAUDE_CONFIG_DIR` volume (Docker Sandboxes does exactly this), and (c) treat `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (documented by Anthropic for CI/containers, 1-year, model-requests-only) as a user-supplied secret, never harvested from `~/.claude`. API keys injected by the core's egress proxy (`ANTHROPIC_BASE_URL` → proxy adds the key) is the most secure path but costs API rates. Codex: `codex login --device-auth` into a `CODEX_HOME` volume, or `OPENAI_API_KEY`/`CODEX_API_KEY` (OpenAI recommends API keys for automation). OpenCode: API keys only for Anthropic.
5. **Communication channel:** drive the vendor CLI over the driver's exec stream (stdio): `claude -p --output-format stream-json` (the Agent SDK itself is "a `claude` CLI subprocess … over stdio"), `codex exec --json` / `codex app-server` (JSON-RPC over stdio/unix socket), `opencode serve` (HTTP+SSE on 127.0.0.1:4096 with basic auth). A tiny in-image `bureau-agent` sidecar speaking JSON-RPC over the same exec stream keeps the design portable across `docker exec`, `kubectl exec`, `sbx exec` and `ssh`.
6. **Docker-in-Docker:** never mount `/var/run/docker.sock` (root-equivalent per Docker and OWASP). Options ranked: Docker Sandboxes microVM (private daemon), Sysbox v0.7.1 (community-maintained, Linux only), rootless nested Podman, or — simplest for v1 — a core-brokered "run compose service" tool executed outside the agent boundary.
7. **Raspberry Pi 5:** feasible for a headless ByteBureau node with the Docker driver (Pi OS Trixie 64-bit + Debian arm64 Docker packages + native `linux-arm64` Claude Code + Bun aarch64). Anthropic's own sizing is 4 GiB RAM and 2–4 CPUs per Claude Code session, so plan **1 concurrent session on 8 GB, 2–3 on 16 GB**. `sbx` microVMs are not supported there (Ubuntu 24.04 + KVM only).
8. **Ecosystem churn to design around:** Daytona's OSS repo is unmaintained since June 2026 (hosted cloud only), Dagger `container-use` is dormant (last release 2025-08-19, archive request open), Vibe Kanban is sunsetting (2026-04-10), Crystal is deprecated (Feb 2026). Keep every provider behind the driver interface.

---

## 2. Findings per topic

### 2.1 Docker in 2026

#### Docker Sandboxes (`sbx`)
- **Timeline.** Experimental preview announced 2025-11-25 as *container-based* isolation inside Docker Desktop's VM (Desktop ≥4.50, Claude Code + Gemini CLI) with a stated plan to move to microVMs [D1]. "Next evolution" with **microVM isolation on macOS and Windows** announced 2026-01-30, "GA" wording, Linux listed as "what's next" [D2]. Docker Desktop 4.93.0 (2026-09-28) release notes: "The experimental `docker sandbox` plugin was removed … migrate to `docker sbx`" [D10].
- **Install / platforms (docs, 2026-10).** "You don't need Docker Desktop or Docker Engine to use `sbx`." macOS: Sonoma 14+, Apple Silicon only, `brew trust docker/tap && brew install docker/tap/sbx`. Windows 11 x64 with Windows Hypervisor Platform, `winget install -h Docker.sbx`. Linux: Ubuntu 24.04+, x64 or Arm, **KVM required** (user in `kvm` group), `apt install docker-sbx` (or `curl get.docker.com | SBX=1 sh`) [D3]. FAQ: headless Linux is supported; secrets go to `~/.config/com.docker.sandboxes` (0700) when no Secret Service exists [D5].
- **Pricing/licensing.** "The `sbx` CLI and local sandbox compute are free to use, including for commercial work. Cloud compute uses a pay-as-you-go subscription." Org governance (central policies) is a separate paid subscription [D4][D5]. The CLI is **not open source** (no public repo found via GitHub search; only quickstarts/kits exist).
- **Architecture.** Per sandbox: separate microVM, own kernel, own Docker daemon/image cache ("multiple sandboxes don't share images or layers"), agent has sudo inside. Workspace modes: *direct* (virtiofs passthrough, caching on by default, same absolute path as host), *mountless*, *clone* (source mounted read-only at `/run/sandbox/source`, agent works in a private clone). Outbound TCP goes through a host proxy (HTTP forward proxy or transparent TCP); UDP blocked unless experimental, ICMP always blocked; MCP gateway runs host-side; local stdio MCP servers run **outside** the VM with host permissions (documented limitation). Hypervisor/VMM and guest distro are **not documented (unverified)** [D6][D7]. Disk defaults: root 20 GB (`DOCKER_SANDBOXES_ROOT_SIZE`), Docker data 10 GB [D8].
- **Credentials.** "An HTTP/HTTPS proxy on your host intercepts outbound requests from the sandbox, looks up the matching credential on the host, and overwrites the auth header before forwarding." Sandbox sees sentinels (`proxy-managed`, `sbx-cs-<rand>`). Built-ins: Anthropic, OpenAI, Gemini, GitHub (`sbx secret set github --command 'gh auth token'`), Cursor, Droid, Groq, Mistral, OpenRouter, xAI; OAuth flows for Claude Code/Codex/Cursor/Droid; custom hosts via `sbx secret set-custom --host … --env …` (1Password/AWS SM refs). Kits declare inject domains [D9].
- **Agents.** Supported list: Claude Code, Codex, Copilot, Cursor, Devin, Docker Agent, Droid, Gemini, Kiro, OpenCode, Shell [D11]. Claude Code page: base image `docker/sandbox-templates:claude-code`, default command includes `--dangerously-skip-permissions`; auth either `sbx secret set anthropic` (API key via proxy) **or `/login` inside Claude Code (subscription)**; "Sandboxes don't pick up user-level configuration from your host, such as ~/.claude" [D12]. Codex page: `sbx secret set openai --oauth` (browser on host, token in keychain, "credentials are never exposed inside it"), default `codex --dangerously-bypass-approvals-and-sandbox` [D13]. OpenCode page: providers via `sbx secret set <provider>`, Copilot via GitHub creds, host config not available [D14].
- **API/SDK.** "Sandboxes API and SDK" = REST + TypeScript SDK, **cloud sandboxes only**, experimental ("Features, interfaces, and behavior may change") [D15]. Cloud supports linux/amd64 and linux/arm64; local sandboxes persist until removed, cloud ones expire by TTL [D16]. Workflows page: `sbxenv.yaml` project config, `sbx exec` for scripting, headless auth for CI [D17].

#### Docker Model Runner / MCP Gateway / Docker Agent (cagent) / Offload
- **Model Runner:** GA since Sept 2025 (Docker blog, [D18]); runs on Docker Engine (Linux CPU/CUDA/ROCm/Vulkan), macOS Apple Silicon, Windows; backends llama.cpp (default), vLLM, Diffusers; OpenAI- and Ollama-compatible APIs; models as OCI artifacts [D19]. Version 1.2.8 as of Sept 2026 — **single source (Releasebot), unverified**. Disabled by default in Desktop 4.93 [D10].
- **MCP Gateway:** `docker/mcp-gateway`, MIT, 1,587 stars, latest tag v0.44.1 (2026-09-23, flagged prerelease); runs each catalog MCP server in an isolated container; works with Docker CE (`DOCKER_MCP_IN_CONTAINER=1`); OCI-based catalogs [G1][D20].
- **Docker Agent (formerly cagent):** repo `docker/docker-agent`, Apache-2.0, 3,371 stars, v1.145.0 (2026-09-28); YAML multi-agent runtime, MCP tools, providers incl. Docker Model Runner; CLI plugin `docker agent`, preinstalled in Desktop 4.63+; the `cagent` binary was removed in Desktop 4.93 [G1][D21][D10].
- **Docker Offload:** managed cloud build/run from Docker Desktop; NVIDIA L4 GPUs; 300 free minutes then $0.015/min (GPU) or $0.01/min — **pricing from secondary sources, unverified on docs page** [D22][D23].

#### Docker Engine / API / client libraries
- Engine 29.0.0 (2025-11-10): API 1.52, **minimum API 1.44**, containerd image store default for fresh installs, cgroup v1 deprecated, Docker Content Trust removed from CLI; latest **29.8.2 (2026-09-30)**; 29.5.0 made `gvisor-tap-vsock` the default rootless network driver; 29.8 added `--umask` and a custom AppArmor template [D24]. API overview: "latest … 1.56, corresponding to Docker Engine 29.8.2" while its table shows 29.8 → max 1.55 (docs internally inconsistent; treat 1.55/1.56 as current, 1.44 as safe floor) [D25]. Docker Desktop 4.93.0 bundles Engine 29.8.1, containerd 2.3.5, kernel 7.0.14 [D10].
- **dockerode** 5.0.1 (released 2026-06-24), Apache-2.0, 4,947 stars, repo pushed 2026-09-13 — maintained, slow cadence; ~5.5M weekly downloads (secondary source) [N1][G1][G2]. **testcontainers-node** 12.2.0 (2026-09-28), MIT, 2,619 stars — test-oriented abstractions, uses dockerode underneath [N1][G2]. **Docker CLI via subprocess** is always available (`--format json`), needed anyway for `sbx`.
- **Docker Desktop license:** free for personal use and companies with <250 employees **and** <$10M revenue; otherwise paid [D26].

#### macOS alternatives
- **Apple `container` / Containerization:** 1.0.0 released **2026-06-09**, 1.5.0 on 2026-09-29; Apache-2.0; 50,444 stars; macOS 26 + Apple Silicon required; one lightweight VM per container (Virtualization.framework, `vminitd`), `container machine` persistent Linux env, Kubernetes plugin; not a Docker-API drop-in (Wikipedia notes no Compose and devcontainer gaps — **unverified detail**) [G1][G2][A1][A2].
- **OrbStack:** v2.2.3 (2026-08-07); v2.2.2 ships Linux 7.0.14, Kubernetes 1.35, runc 1.5.1; v2.1.0 added **"Isolated machines" for AI agent sandboxing** (no filesystem integration) and v2.1.2 an option to block network to host; Docker checkpoint/restore (CRIU) in 2.2.0. Proprietary: free for personal non-commercial, Pro $8/user/month [O1][O2].
- **Podman:** v6.0.0 on **2026-06-24** (Docker-compat API v1.44; macOS default provider `libkrun`; dropped cgroups v1, CNI, iptables, Intel Mac, Windows 10); v6.1.3 on 2026-09-29 (groundwork for v1.45); 32,984 stars, Apache-2.0 (repo now `podman-container-tools/podman`). Podman Desktop auto-creates a `podman-*` Docker context and `podman-mac-helper` links the Docker socket [G1][G2][P1][P2].
- **Lima / Colima:** Lima v2.1.0 (2026-03-17) added `limactl shell --sync` "to prevent AI agents from breaking the host files" and experimental macOS guests; v2.2.0 (2026-07-21); v2.3.0-beta.0 (2026-09-01); 22,010 stars, Apache-2.0 [G1][G2][L1]. Colima = Docker socket on a Lima VM; no 2026 release verified (**unverified**).

### 2.2 Agent-specific sandbox technology

- **Anthropic `sandbox-runtime` (`srt`).** npm `@anthropic-ai/sandbox-runtime` **0.0.78** (2026-09-30/10-01), Apache-2.0, 5,414 stars, "beta research preview". macOS: `sandbox-exec` with generated Seatbelt profiles. Linux: bubblewrap + socat, network namespace removed, all traffic via HTTP/SOCKS5 proxy through bind-mounted Unix sockets; seccomp-BPF blocks `AF_UNIX` (x64/arm64 prebuilt). **Library API:** `SandboxManager.initialize(config)`, `wrapWithSandbox(cmd)`, `reset()`, `SandboxViolationStore`. Config: `filesystem.{allowRead,denyRead,allowWrite,denyWrite}`, `network.{allowedDomains,deniedDomains,allowUnixSockets,allowLocalBinding,tlsTerminate,deniedResolvedAddresses}`, `enableWeakerNestedSandbox` (needed inside unprivileged Docker — "considerably weakens security"), `mandatoryDenySearchDepth`. Always-denied writes: shell rc files, `.gitconfig`, `.git/hooks`, `.git/config`, `.vscode`, `.idea`, `.claude/commands|agents`, `.mcp.json`. Limitations: shares host kernel, proxy decides on client-supplied hostname (domain fronting), `docker.sock` in `allowUnixSockets` = host access, Windows alpha [S1][S2][N1][G1]. Engineering blog (2025-10-20): sandboxing cut permission prompts 84% [S3].
- **Claude Code built-in sandbox + container guidance.** `/sandbox` panel; Linux needs `bubblewrap`+`socat` (Ubuntu 24.04 AppArmor blocks unprivileged userns by default); `strictAllowlist` (v2.1.219+), `sandbox.filesystem.disabled` (v2.1.216+), credential `mask` with `tlsTerminate` (v2.1.199+) incl. AWS SigV4 re-signing; `docker` is incompatible with the sandbox (add `docker *` to `excludedCommands`); inside unprivileged containers set `enableWeakerNestedSandbox`; `--dangerously-skip-permissions` refuses to run as root "except inside a recognized sandbox" [C1]. Sandbox-environments page ranks: sandboxed Bash tool < sandbox runtime < dev container / custom container < VM (Docker Sandboxes named explicitly as "a free, standalone product from Docker that does not require Docker Desktop") < Anthropic cloud sessions [C2]. **Reference devcontainer** (`anthropics/claude-code/.devcontainer`): `node:20` base, user `node`, `--cap-add NET_ADMIN,NET_RAW`, `init-firewall.sh` (default `DROP` on INPUT/FORWARD/OUTPUT, ipset allowlist from `api.github.com/meta` web+api+git ranges plus resolved `registry.npmjs.org`, `api.anthropic.com`, `sentry.io`, `statsig.com`, VS Code hosts; host /24 allowed; `REJECT --reject-with icmp-admin-prohibited`; self-test that example.com is blocked and api.github.com reachable), named volumes `claude-code-config-${devcontainerId}` → `/home/node/.claude` with `CLAUDE_CONFIG_DIR`, `NODE_OPTIONS=--max-old-space-size=4096`, `postStartCommand: sudo init-firewall.sh` [C3][C4][C5][C6]. Dev Container Feature `ghcr.io/anthropics/devcontainer-features/claude-code:1.0` [C3]. Warning in docs: with `--dangerously-skip-permissions` "a malicious project [can exfiltrate] anything accessible inside the container, including the Claude Code credentials stored in ~/.claude … Avoid mounting host secrets such as ~/.ssh" [C3].
- **Claude Code runtime facts for images.** 2.1.287 (2026-10-01); native binary (npm pulls `@anthropic-ai/claude-code-linux-arm64` etc.; supported: darwin-arm64/x64, linux-x64/arm64 (+musl), win32); signed apt/dnf/apk repos; system requirement 4 GB RAM, x64 or ARM64; Alpine needs `libgcc libstdc++ ripgrep` [C7][N1].
- **OpenAI Codex CLI.** 0.160.0 (2026-10-01), Apache-2.0, 127,543 stars. Modes `read-only` / `workspace-write` (default; network **off** unless `[sandbox_workspace_write] network_access = true`) / `danger-full-access`; approvals `on-request` / `never` (`untrusted` removed); macOS Seatbelt; **Linux: "bwrap plus seccomp"** per current docs (Simon Willison's Nov-2025 analysis described Landlock+seccomp — implementation has evolved; treat Landlock as historical) ; "For containerized environments like Docker where namespace or setuid operations are blocked, Codex cannot enforce its sandbox" → run `--sandbox danger-full-access` / `--dangerously-bypass-approvals-and-sandbox` and rely on the container; protected `.git`, `.codex`, `.agents` [X1][X2][X3]. Non-interactive: `codex exec --json` (JSONL events `thread.started`, `turn.completed`, `item.completed`…), `-o`, `--output-schema`, `resume --last`, `--ephemeral`, `--skip-git-repo-check`, `CODEX_API_KEY` [X4]. Programmatic: `@openai/codex-sdk` (TS, Node 18+) and `openai-codex` (Python) over the **App Server** JSON-RPC 2.0 (`codex app-server`, stdio default, `--listen ws://` or `unix://`, bearer-token auth, `thread/start`, `turn/start`, streaming `item/*` notifications, `generate-ts` schemas) [X5][X6]. Auth: ChatGPT sign-in or API key; `~/.codex/auth.json` ("treat like a password", `cli_auth_credentials_store = file|keyring|auto|ephemeral`), **device-code auth (beta)** for headless, copy `auth.json`, or SSH-forward port 1455; tokens auto-refresh; "API keys are the recommended default for programmatic workflows" [X7].
- **Gemini CLI.** 0.62.0; sandbox methods `docker`, `podman`, `sandbox-exec` (macOS default, profiles `permissive-open`/`restrictive-proxied`), `runsc` (gVisor), `lxc`, Windows native; `GEMINI_SANDBOX`, `.gemini/sandbox.Dockerfile`, `GEMINI_SANDBOX_IMAGE`, `SANDBOX_FLAGS`, `SANDBOX_MOUNTS`; default image `ghcr.io/google/gemini-cli:latest`; auth Google OAuth / `GEMINI_API_KEY` / Vertex; headless reuses cached creds. The auth page states "Gemini CLI was replaced by Antigravity CLI on June 18th, 2026" for unpaid users — **single source, unverified** [GM1][GM2][N1].
- **Dagger `container-use`.** Apache-2.0, 4,053 stars, MCP server backed by Dagger engine, git branch per environment. Last release **v0.4.2 (2025-08-19)**; issue #346 (2026-05-03) "Archive the project repo… appears to be no longer maintained" with no maintainer response; README still says "early development" [CU1][CU2][G2]. **Treat as dormant.**
- **OpenHands.** v1.24.0 (2026-09-25), MIT, 89,745 stars. V1 architecture: controller + `agent-server` in a Docker container (`ghcr.io/openhands/agent-server:*`), REST + WebSocket event stream, `DockerWorkspace`/`APIRemoteWorkspace`; providers `RUNTIME=docker|process|remote`; **Python SDK only** [OH1][OH2][G2].
- **SWE-ReX.** MIT, 612 stars, v1.4.0 (2025-08-14); Python; uniform shell-session API over local/Docker/Modal/Fargate/Daytona(WIP) — a good *conceptual* reference for a driver abstraction, not a dependency [SR1][G2].
- **Daytona.** README: "This repository is no longer maintained. As of June 2026, Daytona's core development has moved to a private codebase." (71,674 stars, not archived, no license detected by GitHub). Product is **hosted only** (`app.daytona.io`, TS SDK `@daytonaio/sdk` 0.220.0 2026-09-29, Apache-2.0); default limits 4 vCPU / 8 GB / 10 GB per sandbox; US/EU regions; $0.0504/vCPU-h + $0.0162/GiB-h (wall-clock) [DY1][DY2][N1][F1].
- **E2B.** Runtime repo `e2b-dev/runtime` (formerly `infra`), Apache-2.0, 1,659 stars, release `2026.30` (2026-09-10): Firecracker microVMs resumed from snapshots; self-host = "E2B Embed" single Linux host via Docker Compose, Terraform (GCP), Kubernetes manifests, **Linux + KVM required** (not Mac, not Pi). SDK `e2b` 2.52.0 (MIT). E2B Pro $150/month, 24-h sessions; same per-unit rates as Daytona [E1][N1][F1].
- **Modal Sandboxes.** gVisor (default) or VM runtime; SDKs Python/JS (`modal` 0.11.0)/Go; lifecycle Created→Scheduled→Started→Ready→Finished, default 5-min timeout up to 24 h, idle timeout, filesystem snapshots; $0.1419/core-h, $0.024/GiB-h [M1][F1].
- **Vercel Sandbox.** GA; Firecracker; `@vercel/sandbox` 3.5.1 (npm) / repo tag `sandbox@4.6.0` (2026-09-28); custom OCI images from Vercel Container Registry, Docker-in-sandbox allowed ("system-privileged processes"), persistent sandboxes, snapshots, Drives (beta), 19 regions, OIDC auth. Pricing: Active CPU $0.128/h (idle CPU free), memory $0.0212/GB-h, Hobby 5 CPU-h/month and 45-min sessions, Pro 24-h sessions, 8 vCPU/16 GB (Pro), 64 GB NVMe [V1][V2][N1].
- **Cloudflare Sandbox SDK.** `@cloudflare/sandbox` **1.0.0 GA (2026-09-30)**, Apache-2.0 (npm), 1,143 stars; Durable Object + Cloudflare Container (full Linux microVM); exec/files/processes/preview URLs/S3 mounts/R2 checkpoints; Workers Paid $5/month; $0.072/vCPU-h active, $0.009/GiB-h [CF1][CF2][F1][N1].
- **Fly.io Sprites.** Launched Jan 2026; persistent Firecracker microVMs, ext4 + NVMe, warm/cold idle with no compute charge, checkpoint/restore ~300 ms, Connectors keep provider credentials out of the VM. Pricing differs between sources: $0.07/CPU-h + $0.04375/GB-h (blog, [FL2]) vs Fly's own Sept-2026 comparison $0.03825/CPU-h + $0.021875/GB-h "actual usage" [F1] — **verify before budgeting** [FL1][FL2][F1].
- **Northflank** (Kata on K8s, BYOC/on-prem), **Blaxel** (~25 ms microVM cold start claim), **Runloop** (devboxes) — from the May-2026 inventory gist and Northflank's blog; **single-source, unverified** [W1][NF1]. Anthropic's Managed Agents self-hosted-sandbox guide lists integration recipes for AWS Lambda microVMs, Blaxel, Cloudflare, Daytona, E2B, Fly, GKE Agent Sandbox, Modal, Namespace, Superserve and Vercel — a useful "who is real" list [MA1].
- **microsandbox.** `superradcompany/microsandbox` v0.7.6 (2026-10-01), Apache-2.0, 8,505 stars; libkrun microVMs on macOS (HVF), Linux (KVM), Windows (WHP); SDKs TS/Python/Rust/Go/Ruby; MCP server; OCI images; "<100 ms boot"; **beta, breaking changes expected** [MS1][G1][G2].
- **Kubernetes `agent-sandbox`.** `kubernetes-sigs/agent-sandbox` v1.0.5 (2026-10-01), Apache-2.0, 4,118 stars, API `v1beta1`; CRDs `Sandbox`, `SandboxTemplate`, `SandboxWarmPool`, `SandboxClaim`, router; isolation delegated to RuntimeClass (gVisor/Kata); Go + Python SDKs (no TS). GKE Agent Sandbox GA 2026-05-20 (secondary source) [K1][K2][G1][G2].
- **gVisor.** `release-20260928.0` (2026-09-30), Apache-2.0, 19,474 stars, x86_64 + aarch64 assets, Docker runtime `runsc` via `daemon.json`. Anthropic's overhead table: ~0% CPU-bound, ~2× simple syscalls, 10–200× heavy file open/close [GV1][C8].
- **Kata Containers.** 4.2.0 (2026-09-15); 4.0.0 (2026-07-20) made the Rust runtime default, added Dragonball built-in VMM; QEMU/Cloud Hypervisor/Dragonball; x86_64/aarch64/s390x [KT1][G2].
- **Firecracker.** v1.17.0 (2026-09-10), Apache-2.0, 37,100 stars, x86_64 + aarch64, **Linux/KVM only — no macOS** [FC1][G2].
- **bubblewrap** v0.13.0 (2026-09-22), LGPL-2.1+, setuid mode removed (0.12) [BW1][G2]. **nsjail** 3.6 (2026-03-18), Apache-2.0, "not an official Google product" [NJ1][G2]. **Landlock**: unprivileged LSM for filesystem, TCP, signal/abstract-socket scoping; used by Codex (historically) and tools like Island [LL1].
- **WebAssembly/WASI.** WASI 0.3 ratified **2026-06-11** (native async `stream<T>`/`future<T>`, reorganized `wasi:http`); Wasmtime 46 ships 0.3.0 with Component Model async on by default; previews since Wasmtime 37 (Feb 2026) [WA1][WA2]. Fit for ByteBureau: sandboxing **core plugins/tools** (deterministic, capability-based), not for running agents or dev toolchains.

### 2.3 How existing agent managers isolate work (patterns)

| Tool | Isolation | Notes (observed 2026-10-02) |
|---|---|---|
| Vibe Kanban (28,234★, Apache-2.0, Rust+TS) | git worktrees on host | **Sunsetting announced 2026-04-10** ("couldn't find a business model"), remote features off after 30 days, "will live on, open source and community maintained"; last release 2026-04-24 [VK1][VK2] |
| Superset (14,808★, Elastic License 2.0, Electron/Bun) | worktrees ("does not sandbox processes") | TS SDK `@superset_sh/sdk` (alpha), MCP server, remote access, iPhone app [SS1] |
| Emdash (5,894★, Apache-2.0, Electron/TS, YC W26) | worktrees + remote SSH/SFTP hosts | v1.2.7 (2026-09-27) [EM1] |
| Paseo (19,212★, site says Apache-2.0; v0.11.0-beta.2) | optional worktrees; daemon can run on remote/home-lab machines | 40+ providers, mobile apps, free [PA1] |
| Claude Squad (8,558★, AGPL-3.0, Go) | tmux + worktrees | v1.0.20 (2026-08-20) [CS1] |
| CCManager (1,256★, MIT, TS) | worktrees **+ devcontainer mode** (manager on host, sessions inside devcontainer) | v4.4.4 (2026-09-27) [CM1] |
| Crystal (3,123★, MIT) | worktrees | **deprecated Feb 2026 → Nimbalyst** [CR1] |
| Conductor (Melty Labs, Mac app) | "isolated workspaces" (worktrees per inventory) | Claude Code/Codex/Cursor, local only [CO1][W1] |
| Trail of Bits `claude-code-devcontainer` (948★, Apache-2.0) | devcontainer: RO mounts for `.gitconfig`/`.git/config`/`.git/hooks`, no docker socket, optional iptables egress, `CLAUDE_CODE_OAUTH_TOKEN` env, volumes for `~/.claude`/`~/.config/gh` | notes that VS Code "Reopen in Container" lets container code drive host RPC [TB1] |
| Claude Code on the web / cloud sessions | **Anthropic-managed VM per session**, Ubuntu 24.04 x86_64; security proxy; GitHub proxy keeps the real token outside the VM (placeholder `proxy-injected`); API credentials attached by an agent proxy; "Trusted" default allowlist of registries; setup-script snapshot cached if <5 min; Docker available inside | [C9][C10] |
| Claude Code **self-hosted environments** (public beta, Team/Enterprise) | your runner polls `api.anthropic.com`, clones, spawns a child `claude` per session; recommended `--capacity 1` = one container per session; default-deny egress; block metadata endpoint; per-session minted git creds or Anthropic git proxy; sizing 4 GiB RAM, 2–4 CPU per session | [C11][C12] |
| Anthropic Managed Agents self-hosted sandboxes (beta `managed-agents-2026-04-01`) | `ant beta:worker poll` in your sandbox; outbound-only; `/workspace`, `/mnt/memory` | [MA1] |
| Cursor cloud agents | isolated VM per agent; `.cursor/environment.json`/Dockerfile; snapshots; admin outbound-domain restrictions; API-priced | [CU-1] |
| Codex cloud | container per task from a published environment; **internet off by default**, allowlist + network secrets | [X8] |
| Google Jules | isolated VM per task, setup scripts; "experimental" | [J1] |
| Devin | hosted workspace (shell/IDE/browser) with API; also "Devin Outposts" on Vercel Sandbox | [DV1][V2] |
| Ona (Gitpod) | devcontainer-based ephemeral environments; Ona Cloud or self-hosted AWS/GCP runners | [ON1] |

**Pattern summary:** local managers = worktrees (zero isolation, fastest); hardened local = devcontainer/container per session (CCManager, ToB, Anthropic devcontainer); strongest local = microVM (Docker Sandboxes, OrbStack isolated machines, microsandbox); hosted products = VM/microVM per task with credential proxies (Anthropic, Cursor, Codex, Jules, Devin). Credential-proxy-with-sentinels is now the common denominator of every serious design (Anthropic cloud, Docker Sandboxes, Claude Code `mask`, Sprites Connectors, Cleanroom).

### 2.4 Credential/authentication facts for subscription-based agents

- **Anthropic policy (official, code.claude.com Legal & compliance)**: OAuth is "intended exclusively for purchasers of … subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications"; developers "including those using the Agent SDK, should use API key authentication"; "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users … developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow." Allowed: "an end user … signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code" (hosted sandboxes/agent infra) if the binary is unmodified, no auth method removed, each end user authenticates with their own credentials and is billed directly; name/logo rules apply [C13].
- **Enforcement timeline (secondary sources, consistent):** 2026-01-09 server-side block of subscription OAuth outside official apps (reverted after backlash); Feb 2026 ToS "Authentication and credential use" section; **2026-04-04** enforcement; OpenCode removed Claude subscription auth in v1.3.0 (PR #18186 "anthropic legal requests", 2026-03-19); affected users got a one-month credit [T1][T2][T3]. OpenCode docs today: Anthropic = API key only; "Anthropic explicitly prohibits" subscription plugins [OC1].
- **Mechanics:** precedence `CLAUDE_CODE_USE_*` cloud creds > `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` > `apiKeyHelper` > `CLAUDE_CODE_OAUTH_TOKEN` > profiles > `/login` OAuth. `claude setup-token` mints a one-year token (`sk-ant-oat01-…`), "can only make model requests" (no Remote Control, no claude.ai connectors); `--bare` ignores it. Storage: Linux `~/.claude/.credentials.json` (0600), macOS Keychain (falls back to file), relocatable with `CLAUDE_CONFIG_DIR`; multi-account via separate config dirs [C14]. In containers the browser callback often fails → paste-code flow is built in [C14][C3]. Anthropic's devcontainer page recommends a named volume at `~/.claude` + `CLAUDE_CONFIG_DIR`, and storing `ANTHROPIC_API_KEY` **or** `CLAUDE_CODE_OAUTH_TOKEN` as a Codespaces secret to carry auth across rebuilds [C3]. Long-lived token and Remote Control are mutually exclusive (issue #96076) [T4].
- **Codex:** ChatGPT-plan sign-in or API key; `codex login --device-auth` for headless; `~/.codex/auth.json` copyable; API keys recommended for automation; enterprise access tokens for private CI only [X7]. Docker Sandboxes does OAuth on the host and injects via proxy [D13].
- **Gemini:** OAuth creds cached under `~/.gemini`; headless uses cached creds or `GEMINI_API_KEY` [GM2].

### 2.5 Raspberry Pi 5 feasibility
- Hardware: BCM2712, 4× Cortex-A76 @2.4 GHz; 2/4/8/16 GB LPDDR4X; 16 GB listed at $305 (vendor page); NVMe via PCIe 2.0 x1 HAT; Pi OS Trixie or Bookworm 64-bit [R1].
- Docker: Pi OS 64-bit → "Install the Debian `arm64` packages (fully supported)"; Engine v28 is the last major for 32-bit armhf [R2][R3]. Engine 29.8.x ships arm64.
- Claude Code: native `linux-arm64` and `linux-arm64-musl` binaries; apt repo; 4 GB RAM minimum [C7]. Bun 1.4.2: Linux aarch64 supported (kernel ≥5.6 recommended) [R4]. Codex/OpenCode/Gemini ship arm64 npm builds (Codex multi-arch images exist, secondary source [X9]).
- Sizing (Anthropic guidance): self-hosted runner recipe = 4 GiB memory request/limit and 2–4 CPUs per session [C12]; Agent SDK hosting floor = 1 GiB RAM, 5 GiB disk, 1 CPU per agent, "memory grows with session length" [C15]; devcontainer caps Node heap at 4 GB [C4]. **Realistic concurrency: 8 GB → 1 session (OS + Docker + ByteBureau core ≈1.5 GB); 16 GB → 2–3 sessions**, builds/tests CPU-bound and slow; use NVMe, not microSD, for Docker layers and pnpm store. Docker Sandboxes (`sbx`) is **not** an option on Pi OS (requires Ubuntu 24.04 + KVM); gVisor publishes aarch64 binaries (KVM-less `systrap` platform — **unverified on Pi**).

### 2.6 Security hardening checklist (container profile)
Sources: Anthropic secure-deployment guide [C8], Docker Engine security docs [SE1][SE2][SE3][SE4], OWASP Docker Security Cheat Sheet [OW1], Claude Code self-hosted deploy guide [C12].

1. `--cap-drop ALL` (add `NET_ADMIN`/`NET_RAW` only if you run an in-container firewall as the Anthropic devcontainer does; prefer host-side egress control).
2. `--security-opt no-new-privileges` (OWASP rule 4).
3. seccomp: keep Docker's default profile (allowlist; blocks ≈44 syscalls incl. `mount`, `unshare`, `ptrace`, `init_module`) or supply a tighter custom JSON; never `unconfined` [SE2]. Note: bubblewrap-based inner sandboxes (Claude/Codex) need user namespaces → either accept `enableWeakerNestedSandbox` / `danger-full-access` inside the container, or run the container with a userns-permitting profile and treat the container as the boundary.
4. AppArmor `docker-default` (Engine 29.8 can generate it from a custom template) / SELinux where applicable [SE4].
5. `--read-only` rootfs + `--tmpfs /tmp:rw,noexec,nosuid` + writable volumes only for `/workspace`, caches, and the agent config dir.
6. Non-root `--user` (Claude Code refuses `--dangerously-skip-permissions` as root unless inside a recognized sandbox); `userns-remap` or rootless Docker on Linux hosts (userns-remap is incompatible with `--pid=host`/`--network=host`, external storage drivers, and the containerd image store on existing daemons) [SE3][D24].
7. `--pids-limit`, `--memory`, `--memory-swap`, `--cpus`, ulimits (fork bombs, runaway builds).
8. Network: `--network none` + Unix-socket proxy (Anthropic's reference) or an internal bridge whose only route is the core's egress proxy; deny-by-default allowlist (Anthropic domains, git host, registries); block `169.254.169.254` and private ranges; optional TLS-terminating proxy for credential injection (install its CA in the image).
9. **Never** mount `/var/run/docker.sock` (OWASP rule 1; Docker: socket access is root-equivalent) [OW1][SE1].
10. Never mount `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.docker/config.json`, `~/.kube`, `.npmrc` etc.; filter `.env*` before mounting [C8].
11. `--ipc private`; no `--privileged`; no host PID/NET namespaces.
12. In-image policy: `DISABLE_AUTOUPDATER=1`, pinned agent versions, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `/etc/claude-code/managed-settings.json` to pin permission mode, deny `.git/hooks`, `.claude/settings.json` writes; review writable paths after unattended runs [C1][C3].
13. Supply chain: pinned base image digests, image scanning, signed multi-arch builds (OWASP rules 9, 13).
14. Host hygiene: keep host kernel/Docker current (OWASP rule 0); Engine 29.x fixed several `docker cp` and AuthZ CVEs in 2026 [D24].

---

## 3. Ranked recommendations + risks

### 3.1 Driver ranking
1. **`docker` driver (default)** — hardened container per session on the Docker Engine API (dockerode 5.0.1 for streaming exec/attach; `docker` CLI subprocess for build/compose/`sbx`). Portable to Podman (socket compat API v1.44 ≥ Docker's min 1.44 — confirm the exact endpoints you use), OrbStack, Colima, Pi 5, VPS over `ssh://` DOCKER_HOST. *Risks:* shared kernel; inner agent sandboxes degrade (`enableWeakerNestedSandbox`, Codex `danger-full-access`); DinD needs a broker (see §3.4).
2. **`sbx` driver (preferred when installed)** — shell out to `sbx run/exec/rm --name …`, use clone mode for parallel tasks on the same repo, `sbxenv.yaml` per project, `sbx secret set-custom` for git tokens, `sbx policy` for allowlists. *Risks:* proprietary CLI with no local API (parse CLI output, pin a version), Ubuntu-24.04/KVM-only on Linux, user-level `~/.claude` not visible (which is actually what we want), rapid renames (`docker sandbox` → `docker sbx`).
3. **`local` driver (fallback/dev)** — worktree on host; optionally wrap the agent with `srt` (`SandboxManager.wrapWithSandbox`) for filesystem/network restriction. *Risks:* no isolation of MCP servers/hooks unless whole process is wrapped; Linux needs bubblewrap + socat and userns enabled.
4. **`kubernetes` driver (later)** — Pod/Job with the same image, `RuntimeClass: gvisor|kata`, NetworkPolicy egress to the proxy; consider `kubernetes-sigs/agent-sandbox` CRDs (v1beta1, warm pools) when scaling. *Risks:* no TS SDK for agent-sandbox; cluster ops burden for a solo maintainer.
5. **Cloud-sandbox plugins** (optional, TS SDKs exist): Vercel Sandbox (`@vercel/sandbox`, custom OCI images, Docker inside, Active-CPU billing), Cloudflare `@cloudflare/sandbox` 1.0, Fly Sprites, E2B, Modal, Daytona (hosted). *Risks:* lock-in, egress of source code, Daytona OSS dead, pricing drift.

### 3.2 Driver abstraction (proposal)
```ts
interface WorkspaceDriver {
  id: 'docker' | 'sbx' | 'local' | 'kubernetes' | 'ssh-docker' | `cloud:${string}`;
  capabilities(): Promise<{ microVM: boolean; nestedDocker: 'private-daemon'|'sysbox'|'broker'|'none';
    egressControl: 'proxy'|'firewall'|'none'; credentialProxy: boolean; snapshots: boolean; arch: ('amd64'|'arm64')[] }>;
  prepare(spec: ImageSpec): Promise<ImageRef>;            // build/pull universal image or devcontainer
  create(spec: WorkspaceSpec): Promise<WorkspaceHandle>;   // mounts/volumes/limits/network policy/secrets refs
  exec(ws, cmd: ExecSpec): ExecStream;                     // stdio streams + exit code + pty option
  putFiles(ws, tar), getFiles(ws, paths): Promise<...>;    // artifacts, diffs (`git diff --binary`), logs
  snapshot?(ws): Promise<SnapshotRef>; restore?(ref)       // sbx/cloud providers only
  portForward?(ws, port): Promise<URL>;                    // dev-server preview
  destroy(ws, opts: { keepVolumes?: boolean }): Promise<void>;
}
// Events (JSON lines on the core bus): workspace.created|ready|destroyed, exec.started|output|exited,
// agent.event (normalised stream-json / Codex JSONL / OpenCode SSE), network.denied, resource.limit,
// credential.injected (audit, no values), artifact.collected
```
Lifecycle: `prepare` (image with toolchains, pinned agent versions) → `create` (clone or worktree-bind + per-project cache volumes `pnpm-store`, `node_modules` optional, agent config volume) → `exec` the vendor CLI (`claude -p … --output-format stream-json --permission-mode …`, `codex exec --json`, `opencode run`/`serve`) → stream events → `getFiles` diff/artifacts + `git push` via brokered credential → `destroy`.

### 3.3 Credential strategy (recommended order)
1. **Per-workspace agent config volume + user-driven `/login`** (`CLAUDE_CONFIG_DIR=/home/agent/.claude` on a named volume; first run opens the Anthropic flow, paste-code works headless). Satisfies "unmodified binary, user signs in through Anthropic's flow". Never copy the host's `~/.claude`/Keychain.
2. **User-provided `CLAUDE_CODE_OAUTH_TOKEN`** (from `claude setup-token`, 1-year) stored in ByteBureau's secret store and injected as env — Anthropic documents this for CI/containers. Caveats: static for a year, readable by anything in the container, no Remote Control/connectors; rotate and scope by workspace.
3. **API key via egress proxy injection** (`ANTHROPIC_BASE_URL` → core proxy adds `x-api-key`; agent never sees it) for unattended/multi-user deployments — the only path Anthropic's policy explicitly endorses for "developers building products".
- Codex: `codex login --device-auth` into `CODEX_HOME` volume, or `OPENAI_API_KEY`/`CODEX_API_KEY` (recommended for automation). OpenCode: API keys (Anthropic), ChatGPT Plus OAuth or Copilot device flow.
- Git push: short-lived, repo-scoped token minted by the core per session (GitHub App installation token or fine-grained PAT) delivered via credential helper or proxy; Jira/Slack tokens stay in the core; the agent gets MCP/tool calls brokered by the core (Anthropic's "custom tools" pattern).

### 3.4 Docker-in-Docker policy
- v1: agents do **not** get a Docker socket. Provide a core tool `bureau.services.up/down/logs` that runs the project's `docker compose` **outside** the agent boundary with a policy (allowed compose files, resource caps) and exposes service endpoints into the workspace network.
- When `sbx` is available, the agent gets its own daemon for free (microVM).
- Linux hosts needing DinD inside the Docker driver: Sysbox v0.7.1 (community "best effort", Linux, amd64/arm64) or rootless nested Podman; still deny the host socket.

### 3.5 Risk register
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Anthropic tightens OAuth/hosting rules again (as on 2026-01-09 and 2026-04-04) | medium | high | API-key proxy path first-class; unmodified binary; user-owned login; watch `code.claude.com/docs/en/legal-and-compliance` |
| Prompt-injected agent exfiltrates `~/.claude`/tokens from the container | medium | high | egress allowlist, sentinel/proxy injection, short-lived tokens, no host secrets mounted, per-workspace config dir |
| Container escape via kernel bug (shared kernel) | low | high | microVM driver (`sbx`) on dev machines; gVisor/Kata on K8s; seccomp/AppArmor/no-new-privs; keep hosts patched |
| `sbx` CLI changes/removal (proprietary, experimental API) | medium | medium | isolate behind driver, pin version, integration tests; Docker driver remains default |
| Inner-sandbox incompatibility (bubblewrap needs userns; `docker` incompatible with Claude sandbox) | high | low | document: container is the boundary; set `enableWeakerNestedSandbox` / Codex `danger-full-access` inside containers |
| Pi 5 OOM with 2 sessions on 8 GB | high | medium | hard memory limits, queue depth 1 on 8 GB, NVMe, 16 GB model |
| Provider churn (Daytona OSS dead, container-use dormant, Vibe Kanban sunset) | high | low | provider plugins optional; no core dependency |
| DinD via socket mount by a plugin author | medium | high | driver refuses `docker.sock` mounts; lint policy; broker tool |
| TLS-terminating proxy breaks tools (Go CLIs, Bun fetch ignores HTTP_PROXY) | medium | medium | per-tool allowlist without MITM by default; `NODE_USE_ENV_PROXY=1`; transparent proxy via iptables where needed |

---

## 4. Rejected options (and why)
- **Dagger `container-use`**: dormant (last release 2025-08-19, archive request unanswered), requires Dagger engine; our driver covers its MCP use-case.
- **Daytona self-host**: core moved private June 2026; hosted-only plugin at most.
- **E2B self-host / raw Firecracker / Kata as primary**: Linux + KVM infra (Nomad/Terraform/K8s) — too heavy for a solo maintainer and impossible on macOS.
- **Apple `container` as the primary macOS runtime**: macOS 26 + Apple Silicon only, no Docker API socket/Compose parity; revisit as an optional macOS microVM driver once a stable API exists.
- **WASM/WASI for agent execution**: cannot host Node/Bun/git/Docker toolchains; keep for sandboxing ByteBureau plugins.
- **Mounting the Docker socket (Testcontainers style) into agent containers**: root-equivalent.
- **OpenHands/SWE-ReX runtimes as dependencies**: Python-only SDKs; patterns borrowed instead.
- **Lima/Colima/OrbStack-specific drivers**: they just provide a Docker socket; the Docker driver already covers them (OrbStack "isolated machines" could be a later optional driver).
- **gVisor on macOS**: not applicable (Linux only).

---

## 5. Open questions for the owner
1. **Policy posture:** ByteBureau is OSS and self-hosted, but if you ever offer a hosted edition, Anthropic's "Can customers offer Claude Code in their products?" clause requires the Commercial ToS and user-owned auth. Do you want to contact Anthropic sales early, or stay strictly self-hosted/single-tenant?
2. Which Mac container runtime do you run day-to-day (Docker Desktop, OrbStack Pro, Colima, Podman)? It decides whether `sbx` (standalone, free) is the default on your machine and how much Docker-API-compat testing Podman needs.
3. Is the Raspberry Pi 5 target the 16 GB model? On 8 GB the honest answer is one session at a time.
4. Do agents need to run the project's own containers (compose) in v1, or is a core-brokered "services" tool acceptable?
5. Is a TLS-terminating egress proxy (custom CA inside the image) acceptable for credential injection, or should v1 do hostname-allowlisting only (Anthropic's default) plus env-injected tokens?
6. Which Codex billing path do you hold (ChatGPT plan vs API key)? ChatGPT-plan auth inside containers works via device auth but OpenAI recommends API keys for automation.
7. Should Kubernetes support target plain Pods/Jobs first, or the `agent-sandbox` CRDs (gVisor/Kata RuntimeClass, warm pools) from the start?
8. Ubuntu 24.04 KVM hosts (sbx microVMs) vs generic Debian/VPS (Docker driver) for the first "remote VPS" driver?

---

## 6. Sources
**Docker**
- [D1] https://www.docker.com/blog/docker-sandboxes-a-new-approach-for-coding-agent-safety/ (2025-11-25)
- [D2] https://www.docker.com/blog/docker-sandboxes-run-claude-code-and-other-coding-agents-unsupervised-but-safely/ (2026-01-30)
- [D3] https://docs.docker.com/ai/sandboxes/install/
- [D4] https://docs.docker.com/ai/sandboxes/
- [D5] https://docs.docker.com/ai/sandboxes/faq/
- [D6] https://docs.docker.com/ai/sandboxes/architecture/
- [D7] https://docs.docker.com/ai/sandboxes/security
- [D8] https://docs.docker.com/ai/sandboxes/troubleshooting/
- [D9] https://docs.docker.com/ai/sandboxes/configuration/credentials/
- [D10] https://docs.docker.com/desktop/release-notes/ (4.93.0, 2026-09-28)
- [D11] https://docs.docker.com/ai/sandboxes/agents
- [D12] https://docs.docker.com/ai/sandboxes/agents/claude-code
- [D13] https://docs.docker.com/ai/sandboxes/agents/codex
- [D14] https://docs.docker.com/ai/sandboxes/agents/opencode
- [D15] https://docs.docker.com/ai/sandboxes-api/
- [D16] https://docs.docker.com/ai/sandboxes/cloud/local-vs-cloud/
- [D17] https://docs.docker.com/ai/sandboxes/workflows
- [D18] https://www.docker.com/blog/announcing-docker-model-runner-ga/
- [D19] https://docs.docker.com/ai/model-runner/
- [D20] https://github.com/docker/mcp-gateway
- [D21] https://github.com/docker/cagent (→ docker/docker-agent)
- [D22] https://docs.docker.com/offload/
- [D23] https://upcloud.com/global/resources/tutorials/docker-offload-cloud-develop-local/ (pricing, secondary)
- [D24] https://docs.docker.com/engine/release-notes/29/
- [D25] https://docs.docker.com/reference/api/engine/ and https://docs.docker.com/reference/api/engine/version-history/
- [D26] https://docs.docker.com/subscription/desktop-license/
- [SE1] https://docs.docker.com/engine/security/ · [SE2] https://docs.docker.com/engine/security/seccomp/ · [SE3] https://docs.docker.com/engine/security/userns-remap/ · [SE4] https://docs.docker.com/engine/security/apparmor/ · rootless: https://docs.docker.com/engine/security/rootless/
- [OW1] https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html

**macOS runtimes**
- [A1] https://github.com/apple/container · [A2] https://en.wikipedia.org/wiki/Apple_container
- [O1] https://docs.orbstack.dev/release-notes · [O2] https://orbstack.dev/pricing
- [P1] https://github.com/containers/podman/releases/tag/v6.0.0 · [P2] https://podman-desktop.io/docs/migrating-from-docker/managing-docker-compatibility
- [L1] https://github.com/lima-vm/lima/releases (v2.1.0 2026-03-17)

**Anthropic / Claude Code**
- [C1] https://code.claude.com/docs/en/sandboxing · [C2] https://code.claude.com/docs/en/sandbox-environments · [C3] https://code.claude.com/docs/en/devcontainer
- [C4] https://github.com/anthropics/claude-code/blob/main/.devcontainer/devcontainer.json · [C5] …/.devcontainer/Dockerfile · [C6] …/.devcontainer/init-firewall.sh
- [C7] https://code.claude.com/docs/en/setup · [C8] https://code.claude.com/docs/en/agent-sdk/secure-deployment · [C9] https://code.claude.com/docs/en/claude-code-on-the-web · [C10] https://code.claude.com/docs/en/cloud-environments
- [C11] https://code.claude.com/docs/en/self-hosted-environments · [C12] https://code.claude.com/docs/en/self-hosted-environments-deploy · [C13] https://code.claude.com/docs/en/legal-and-compliance · [C14] https://code.claude.com/docs/en/authentication · [C15] https://code.claude.com/docs/en/agent-sdk/hosting · headless: https://code.claude.com/docs/en/headless · network: https://code.claude.com/docs/en/network-config
- [S1] https://github.com/anthropics/sandbox-runtime · [S2] https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime · [S3] https://www.anthropic.com/engineering/claude-code-sandboxing
- [MA1] https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes
- [T1] https://alternativeto.net/news/2026/2/anthropic-officially-bans-using-subscription-authentication-for-third-party-claude-use · [T2] https://news.ycombinator.com/item?id=47633568 · [T3] https://ridakaddir.com/blog/post/did-anthropic-kill-opencode-claude-subscription-ban · [T4] https://github.com/anthropics/claude-code/issues/96076

**OpenAI Codex / Gemini / OpenCode**
- [X1] https://learn.chatgpt.com/docs/sandboxing · [X2] https://learn.chatgpt.com/docs/agent-approvals-security · [X3] https://simonwillison.net/2025/Nov/9/codex-sandbox-investigation/ · [X4] https://learn.chatgpt.com/docs/non-interactive-mode · [X5] https://learn.chatgpt.com/docs/codex-sdk · [X6] https://learn.chatgpt.com/docs/app-server · [X7] https://learn.chatgpt.com/docs/auth · [X8] https://learn.chatgpt.com/docs/cloud · [X9] https://github.com/icoretech/codex-docker
- [GM1] https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/sandbox.md · [GM2] https://geminicli.com/docs/get-started/authentication/
- [OC1] https://opencode.ai/docs/providers/ · server: https://opencode.ai/docs/server/

**Sandbox runtimes & providers**
- [CU1] https://github.com/dagger/container-use · [CU2] https://github.com/dagger/container-use/issues/346
- [OH1] https://docs.openhands.dev/sdk/guides/agent-server/docker-sandbox · [OH2] https://docs.openhands.dev/openhands/usage/sandboxes/overview
- [SR1] https://github.com/SWE-agent/SWE-ReX
- [DY1] https://github.com/daytonaio/daytona · [DY2] https://www.daytona.io/docs/en/getting-started/
- [E1] https://github.com/e2b-dev/infra (→ e2b-dev/runtime)
- [M1] https://modal.com/docs/guide/sandbox
- [V1] https://vercel.com/docs/vercel-sandbox · [V2] https://vercel.com/docs/sandbox/pricing
- [CF1] https://developers.cloudflare.com/sandbox/ · [CF2] https://github.com/cloudflare/sandbox-sdk
- [FL1] https://docs.fly.io/sprites · [FL2] https://pr0xy.dev/posts/2026-07-06-fly-sprites-make-agent-sandboxes-stateful · [F1] https://fly.io/learn/ai-sandbox-pricing/ (2026-09-09)
- [NF1] https://northflank.com/blog/best-sandboxes-for-coding-agents (2026-03-02) · [W1] https://gist.github.com/wincent/2752d8d97727577050c043e4ff9e386e (2026-05 inventory)
- [MS1] https://github.com/microsandbox/microsandbox (→ superradcompany/microsandbox)
- [K1] https://github.com/kubernetes-sigs/agent-sandbox · [K2] https://kubernetes.io/blog/2026/03/20/running-agents-on-kubernetes-with-agent-sandbox
- [GV1] https://github.com/google/gvisor/releases · [KT1] https://github.com/kata-containers/kata-containers/releases · [FC1] https://github.com/firecracker-microvm/firecracker/releases · [BW1] https://github.com/containers/bubblewrap/releases · [NJ1] https://github.com/google/nsjail · [LL1] https://landlock.io/
- [WA1] https://bytecodealliance.org/articles/WASI-0.3 (2026-06-11) · [WA2] https://progosling.com/en/dev-digest/2026-02/wasi-0-3-wasmtime-37-native-async
- Sysbox: https://github.com/nestybox/sysbox · ToB devcontainer [TB1]: https://github.com/trailofbits/claude-code-devcontainer · Cleanroom: https://github.com/buildkite/cleanroom

**Agent managers / hosted agents**
- [VK1] https://github.com/BloopAI/vibe-kanban · [VK2] https://www.vibekanban.com/blog/shutdown (2026-04-10) · [SS1] https://github.com/superset-sh/superset · [EM1] https://github.com/generalaction/emdash · [PA1] https://paseo.sh/ · [CS1] https://github.com/smtg-ai/claude-squad · [CM1] https://github.com/kbwo/ccmanager · [CR1] https://github.com/stravu/crystal · [CO1] https://conductor.build/
- [CU-1] https://cursor.com/docs/cloud-agent · [J1] https://jules.google/docs · [DV1] https://docs.devin.ai/ · [ON1] https://ona.com/docs

**Raspberry Pi / runtimes**
- [R1] https://www.raspberrypi.com/products/raspberry-pi-5/ · [R2] https://docs.docker.com/engine/install/raspberry-pi-os/ · [R3] https://docs.docker.com/engine/install/debian/ · [R4] https://bun.sh/docs/installation
- devcontainers CLI: https://github.com/devcontainers/cli (npm `@devcontainers/cli` 0.89.0, 2026-08-31)

**Registry/API snapshots taken 2026-10-02**
- [N1] `npm view` (dockerode 5.0.1; testcontainers 12.2.0; @devcontainers/cli 0.89.0; @anthropic-ai/sandbox-runtime 0.0.78; @anthropic-ai/claude-code 2.1.287; @anthropic-ai/claude-agent-sdk 0.3.287; @openai/codex 0.160.0; opencode-ai / @opencode-ai/sdk 1.18.34; @vercel/sandbox 3.5.1; @cloudflare/sandbox 1.0.0; @daytonaio/sdk 0.220.0; e2b 2.52.0; modal 0.11.0; @google/gemini-cli 0.62.0)
- [G1] GitHub API `repos/*` (stars, license, archived, pushed_at) · [G2] GitHub API `releases` (latest tag + published_at), including apple/container 1.0.0 = 2026-06-09T01:27:50Z, podman v6.0.0 = 2026-06-24, lima v2.1.0 = 2026-03-17, bubblewrap v0.13.0 = 2026-09-22, firecracker v1.17.0 = 2026-09-10, kata 4.0.0 = 2026-07-20.
