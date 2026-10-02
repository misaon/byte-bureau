# ByteBureau — requirements checklist (every point from the 2026-10-02 brief)

Status legend (to be filled during design/spec): ✅ covered in design · 🧩 covered by a plugin · ⏭ later phase · ❓ needs owner decision

## W — Reference workflow (must be generic; every step optional)
- W01 Ticket lands in To Do (Jira; also GitHub Issues/Linear/none)
- W02 Move ticket to In Progress
- W03 Clone repository / prepare workspace (branch chosen per session; project default branch)
- W04 Implement the task with AI agents
- W05 Push changes, open a PR
- W06 Ask a colleague for review on Slack
- W07 Receive approval or review comments; address comments
- W08 Merge the PR
- W09 Post PR link as a ticket comment
- W10 Post very short tester instructions in the ticket
- W11 Move ticket to Testing
- W12 Ping the tester on Slack
- W13 Edge cases: no ticket at all (plain prompt), no review needed, other variations — the flow must be generic

## G — Vision & global constraints
- G01 Owner's personal tool, published on GitHub for anyone to download/install
- G02 Dev machine: MacBook Pro M4 14"
- G03 Bleeding-edge, trendy-as-of-Sept-2026 stack: runtime, protocols, communication, languages, patterns; nothing archaic; learning goal; "showcase of modern tech"
- G04 Every tech choice verified online from multiple independent sources (docs, articles, studies, trending GitHub repos); never from memory
- G05 Inspiration munder-difflin: chat window + pixel-art office simulation side by side, reflecting what agents do; UI/UX modern, fancy, animated, smooth
- G06 Agents run in isolated Docker containers; portable to Kubernetes, Docker Swarm, GCP/AWS/Azure, raw VPS
- G07 Agnostic in every direction via plug-and-play modules: model/agent provider, ticket provider, git provider, chat, …; core keeps stable interfaces; decide preinstalled vs optional plugins
- G08 Zero extra cost: Claude subscription(s) (e.g. via `claude -p`), ChatGPT subscription if possible, local LLMs, Mistral & other popular models; no paid API required
- G09 Consider existing AI harness frameworks/SDKs instead of writing boilerplate
- G10 Use third-party packages wisely: don't reinvent, but don't import a huge library for one function
- G11 Work on several projects and several sessions in parallel; summary of what runs / waits for me / is done
- G12 Office simulation (main pillar): pixel art; employees walk, sit at desks while working, hand envelopes to colleagues when delegating (or envelope drops onto desk), visit toilet, kitchen/coffee, chat, terrace, meeting room for multi-agent coordination; emotions, interactions, habits, moods, needs ("The Sims"); one floor per project; switch between floors
- G13 Procedurally generated office layouts, rooms and furniture from a seed (Minecraft-like)
- G14 Adopt obra/superpowers or make ByteBureau's flow & skills equally or more effective
- G15 End-to-end encryption; security as top priority and selling point; encrypt wherever it makes sense
- G16 Setting to prevent computer sleep (overnight runs)
- G17 License: source visible (security auditability) but protects the idea; find the balance

## A — Application requirements
- A01 Easy to install on any device
- A02 Runs in browser, as desktop app, and as headless CLI/server (e.g. Raspberry Pi 5)
- A03 Very secure; all communication encrypted
- A04 Remote control from phone: relay server (Vercel or similar) hosts UI → connects to my machine running ByteBureau; secure & encrypted; chat & related on phone (office sim optional)
- A05 "Asking" dialog for agent decisions, like Claude Code Desktop
- A06 Beautifully formatted AI output in chat
- A07 Multiple sessions concurrently
- A08 Multiple projects concurrently
- A09 Show my subscription usage/limits in the app
- A10 Auto-generated changelogs and GitHub releases with downloadable binaries for Linux/macOS/Windows
- A11 Proven skills bundled; auto-sync with a community collection (ECC, superpowers or better, after research)
- A12 Efficient with hardware; optimized for performance and low resource usage
- A13 High-quality output with low token consumption; token optimization is a priority but must not reduce quality
- A14 Dynamic subagent creation; user-defined custom agents with own model, effort and base prompt
- A15 Telemetry collected so an AI can analyze it and say precisely what to improve in prompts/skills/flows
- A16 Source in TypeScript preferred (open to another language if clearly better)
- A17 Small resulting binary (not hundreds of MB)
- A18 Multilingual: Czech + English first
- A19 Per-project JSON config adjusting ByteBureau behavior
- A20 Search within a conversation; attach files to chat
- A21 Images in chat, incl. agent-sent screenshots; click to enlarge & zoom
- A22 Very clean, extensible code; directory structure ready for growth; readable without documentation
- A23 Repo configured for easy, modern, safe community contribution; disable unneeded GitHub features
- A24 Captivating README (not bland)
- A25 Animations and smooth transitions mandatory; no jank, pop-ins or anti-patterns; owner is a pedant
- A26 Conventional Commits only, validated in CI
- A27 Strict CI/CD
- A28 Pedantically strict linters
- A29 Dependabot/Renovate-like automated dependency updates (after research)
- A30 Live transcript of what agents do; click an employee in the office → detail + transcript
- A31 Debug flag collecting all important internal actions; carefully designed debug logging
- A32 CLI and browser UI startable with a single command
- A33 Beautiful, clear CLI that AI tools also understand; attractive
- A34 Simplicity of use for developers and users
- A35 Fast CI/CD with newest `uses`, efficient caching
- A36 Changelog auto-generated from Conventional Commits; friendly with unicode emoji (changelogen-like)
- A37 Automatic `/compact` and similar Claude Code conveniences in chat
- A38 Pick git branch when starting a session; project-level default branch setting
- A39 Custom employee names, character design and gender
- A40 Stop a running session; add supplementary prompts mid-run
- A41 Copy-message-to-clipboard button
- A42 Notification when a session finishes (bubble/sound)
- A43 One office layout now; later a graphical layout editor; Prison Architect style top-down pixel art
- A44 Show each employee's model and effort
- A45 Context size in chat (% remaining until compact)
- A46 Chat must be very clear; users must not get lost (UX)
- A47 Multiple auth tokens per provider; rotate when one hits limits
- A48 Font-size setting for the whole app

## F — Working agreements
- F01 Agents as autonomous as possible; ask via dialog only when necessary; dialog always marks one option as recommended (evidence-based, not random)
- F02 Code comments only where truly needed, short; no comment smell
- F03 Don't underestimate the core (avoid future technical debt)
- F04 Process every point of the brief; none skipped
