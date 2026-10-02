# ByteBureau research 07 — Frontend framework, styling, animation, chat/transcript UI, dashboard UX

Research date: **2026-10-02**. Method: WebSearch for discovery (budget exhausted mid-way; shared session cap), then direct WebFetch of official sources: npm registry JSON (`registry.npmjs.org/<pkg>/latest`) for exact versions, GitHub release pages, official blogs/docs, MDN/caniuse for CSS support. ~140 fetches/searches total. Every version below was read from the npm registry on 2026-10-02 unless marked otherwise. Dates come from official release pages; where a fetched page omitted the year I inferred it from adjacent evidence and flagged it.

Evidence-quality legend: **[2+]** = two independent sources agree; **[1]** = single source; **[unverified]** = could not confirm; **[conflict]** = sources disagree (official source wins).

---

## 1) Executive summary

**Recommended stack (React path — "showcase of modern tech" with lowest regret):**

- **React 19.3.0** (Sept 9, 2026) — `<ViewTransition>` and Fragment refs are now **stable**; `<Activity>` (19.2) for pre-rendering hidden sessions; **React Compiler 1.0** (Oct 7, 2025) for automatic memoization. React is governed by the React Foundation under the Linux Foundation since Feb 24, 2026. [2+]
- **Vite 8.3.2** (Rolldown 1.2.x + Oxc; Vite 8.0 stable March 12, 2026; Rolldown 1.0 May 7, 2026). `@vitejs/plugin-react 6.1.1` dropped Babel for Oxc, so React Compiler is wired via `@rolldown/plugin-babel` + `reactCompilerPreset()`. Optional **Vite+ (`vp`)** unified toolchain (MIT, beta since July 10, 2026). VoidZero is joining Cloudflare (March 2026). [2+]
- **TypeScript 7.0.2** — the native Go compiler ("Corsa") shipped stable July 8, 2026 (~10x faster); 6.0 (March 23, 2026) was the last JS-based release. [2+]
- **TanStack Router 1.170.41** in library/SPA mode (hash or memory history for the desktop shell) + **TanStack Query**; **TanStack Start 1.168.60** only if you want server functions — the official site still labels Start **"RC"** on 2026-10-02 (third-party "v1.0 GA in March 2026" claims are contradicted by the official site → [conflict]).
- **State:** TanStack Query for request/response; **TanStack DB 0.11.0** (beta; custom collection fed by your local server's WebSocket stream via `begin/write/commit/markReady`) for live dashboard queries; **Zustand 5.0.15** for UI/session stores; **Jotai 3.0.1** (ESM-only, Sept 8, 2026) for atomic settings (font scale, theme). TC39 Signals is still **Stage 1** → do not build on the polyfill.
- **Styling:** **Tailwind CSS 4.3.3** (CSS-first `@theme`; Tailwind Labs joined Shopify Sept 9, 2026) + **shadcn/ui on Base UI** (`@base-ui/react 1.8.0`; shadcn defaulted to Base UI on July 3, 2026, style `base-vega`). shadcn shipped a **Questionnaire** component (Aug 2026) and **human-in-the-loop** helpers — a ready base for the "asking dialog".
- **Animation:** **Motion 13.5.0** (Oct 1, 2026; MIT; `AnimateView` wraps React 19.3 ViewTransition; `layout`/`AnimatePresence`/`Reorder`; springs incl. negative bounce). Pure-CSS where possible (`@starting-style`, `transition-behavior: allow-discrete`, `linear()` springs, scroll-driven animations — all Baseline). **number-flow 0.6.2** for the context meter. **GSAP 3.15** is 100% free (Webflow) but only needed for choreographed sequences. Skip Motion+ ($399) unless you want its `AnimateNumber`/`Ticker`.
- **Chat/transcript:** **Streamdown 2.7.0** (Sept 30, 2026; Vercel; Apache-2.0; incremental code highlighting, `remend` healing, plugins `@streamdown/code` on **Shiki 4.5**, `@streamdown/math` (KaTeX 0.19), `@streamdown/mermaid` (Mermaid 12)); **@pierre/diffs 1.5.1** for diffs (Shiki-based, split/unified, comments); **use-stick-to-bottom 1.1.6** for spring auto-scroll; **Virtua 0.52** when transcripts get long; **Orama 3.1.18** for in-conversation search (+ SQLite FTS5 server-side); **cmdk 1.1.1** palette; **Sonner 2.0.8** toasts; **react-resizable-panels 4.14.1** (Group/Separator API, px constraints, Grid in 4.14); **yet-another-react-lightbox 3.32** + **react-zoom-pan-pinch 4.2**; **react-dropzone 20.1**; **canvas-confetti 1.9.4**.
- **Asking dialog:** mirror Claude Code's `AskUserQuestion` schema (1–4 questions, header ≤12 chars, 2–4 options with label/description/optional preview, `multiSelect`, free-text "Other", optional freeform `response`, optional auto-continue countdown) and add a `recommended` flag. Render inline in the transcript, keyboard-first, with Enter = recommended.
- **Tooling:** Storybook 10.6.1 (ESM-only; Storybook MCP + agent setup in 10.3/10.4; "Storybook for TanStack React" June 2026); visual regression via **Chromatic** (free 5k snapshots/mo) or **Argos** (free 5k/mo) — **Lost Pixel is archived** (Apr 22, 2026; team joined Figma); `axe-core 4.13`, `@lhci/cli 0.15.1`, `size-limit 14.1`, `vite-bundle-visualizer 1.2.1`, Style Dictionary 5.5.5, Figma MCP (remote server on all plans, free during beta).
- **Fonts:** Geist Sans + Geist Mono + **Geist Pixel** (OFL; new, with an `ELSH` shape axis) or **Departure Mono** (OFL) as the pixel accent; Monaspace (texture healing) as an optional code font.

**Why React and not the "hypier" Vue Vapor / Solid 2:** both are still **release candidates** on 2026-10-02 (`vue@next 3.6.0-rc.10` Sept 30, 2026; `solid-js@next 2.0.0-rc.13` Sept 30, 2026), Solid's headless kit **Kobalte 0.13.14 still peers on solid-js ^1.9.8**, and every AI-chat building block that matters (Streamdown, assistant-ui, AI Elements, @pierre/diffs React bindings, use-stick-to-bottom, Base UI) is React-first. React 19.3 + Motion 13 + Compiler is the most polished animation story this quarter. The owner knows React and Vue; Vue 3.6 Vapor is the strongest alternative once it ships stable (targeted Q4 2026).

---

## 2) Findings per topic

### 2.1 Frameworks (state on 2026-10-02)

| Framework | Latest (npm, 2026-10-02) | Status / key facts | Evidence |
|---|---|---|---|
| **React** | 19.3.0 | 19.3 (Sept 9, 2026): `<ViewTransition>` **stable** (enter/exit/update/share; `addTransitionType`; Suspense integration), Fragment refs stable, `browser()` opt-out of SSR, Trusted Types, independent transition rendering, `onFullscreenChange`. 19.2 (Oct 1, 2025): `<Activity>`, `useEffectEvent`, `cacheSignal`, Performance Tracks. React Compiler 1.0 (Oct 7, 2025); `babel-plugin-react-compiler` latest tag 1.0.0; ESLint rules in `eslint-plugin-react-hooks` recommended. React Foundation under Linux Foundation (Feb 24, 2026). RSC security CVEs Dec 2025 (patched 19.2.1) — irrelevant for a local SPA that does not use RSC. | react.dev/blog; react.dev/blog/2026/09/09/react-19-3; registry [2+] |
| **Vue** | 3.5.43 (latest), **3.6.0-rc.10** (next, Sept 30, 2026) | 3.6 = Vapor mode (no VDOM) + alien-signals reactivity rewrite; feature-complete, RC since ~July 2026; stable "targeted Q4 2026" (third-party). Not shipped stable. | github.com/vuejs/core/releases; search [2+] |
| **Svelte / SvelteKit** | svelte 5.57.1; **@sveltejs/kit 3.0.0** (Oct 1, 2026; peers svelte ^5.57.1, vite ^8.0.12) | SvelteKit 3: config moved into `vite.config.ts`, `$lib`→`#lib`, cleanup ("a little less junk"), `sv migrate`. **Remote functions are NOT stable** — the SvelteKit 3 post says they remain the top priority and need experimental Async Svelte behind a flag. (Third-party blogs claiming "remote functions stabilized in 5.49" are wrong → [conflict], official wins.) | svelte.dev/blog/sveltekit-3-is-here; registry [2+] |
| **SolidJS** | 1.9.15 (latest), **2.0.0-rc.13** (next, Sept 30, 2026) | 2.0: first-class async (promises in memos, graph suspends/resumes), reworked `Loading`/`isPending`, deterministic microtask batching + `flush()`, `action()`/`createOptimistic`, `createEffect` split into compute/apply, `onMount`→`onSettled`, `use:`→ref factories, new Rust/OXC compiler, SolidStart retired in favour of Start "start mode". Beta.0 March 3, 2026; RC Aug 19, 2026. Ecosystem lag: Kobalte 0.13.14 peers `solid-js ^1.9.8`; `@tanstack/solid-start 1.168.57`. Highest satisfaction in State of JS 2025 for the 5th year, ~10% usage. | github discussions #2596; InfoQ May 2026; registry [2+] |
| **Preact** | 11.0.0 (late Sept 2026) | Hydration 2.0, `Object.is` deps. Fine, but no reason over React here. | PR #5266; registry [2+] |
| **Angular** | 22.2.1 | v21 (Nov 20, 2025) zoneless by default, Signal Forms; v22 current. Not a fit (owner is React/Vue). | registry; blog.angular.dev [2+] |
| **Qwik** | @qwik.dev/core 2.0.0-rc.0 | v2 still RC. | registry [1] |
| **TC39 Signals** | Stage 1 | Polyfill exists; API not final. | gitnation / linkedin / reptile.haus [2+] |

**Meta-frameworks / routers**

| Tool | Latest | Facts |
|---|---|---|
| **TanStack Router** | @tanstack/react-router 1.170.41 (Sept 30, 2026) | Fully typed params/search/loaders; `viewTransition` option on navigate/Link (docs page returned 500 during fetch → [1] from prior knowledge of the option's existence; verify); history types: browser / hash / memory / server — memory or hash for Electron/Tauri/webviews. |
| **TanStack Start** | @tanstack/react-start 1.168.60 (peers vite ≥7, react ≥18) | Official site badge: **RC** (fetched 2026-10-02). React + Solid supported. `ssr: true | 'data-only' | false`; **SPA mode** (`spa: { enabled: true }`) prerenders `/_shell.html`, static hosting, server functions still reachable via `/_serverFn/*`. RC post Sept 23, 2025; State of JS 2025 lists it "in beta at survey launch" with 235 write-in mentions; CVE-2026-102989 reflected XSS fixed Sept 30, 2026. Won "Breakthrough of the Year" at 2026 Open Source Awards (third-party). |
| **React Router** | 8.4.0 (v8.0 June 17, 2026) | v8: all future flags adopted, ESM-only, Node 22.22+, React 19.2.7+, Vite 7+, `react-router-dom` removed, middleware always on, pre-rendering default. 8.4 (Sept 15, 2026): fewer re-renders, `unstable_routePatternMatching`. Solid, but search-param typing weaker than TanStack. |
| **Next.js** | 16.3.x (Sept 2026) | SSR/RSC-centric; wrong shape for a local-first desktop app. |
| **Nuxt** | 4.5.2 (4.5 July 18, 2026: Vite 8, SSR streaming) | Nuxt 5 groundwork only. Vue path option. |
| **Vite / Rolldown / Vite+** | vite 8.3.2 (deps rolldown ~1.2.11; Node ^20.19 or ≥22.12); rolldown 1.0 May 7, 2026 | Vite 8 (March 12, 2026): esbuild+Rollup replaced by Rolldown (10–30x faster builds; Linear 46s→6s), Oxc React plugin v6 (Babel removed), built-in devtools, tsconfig paths. Vite 8.1: experimental bundled dev mode. **Vite+** `vp` binary (Vite, Vitest, Oxlint, Oxfmt, Rolldown, tsdown) MIT, beta July 10, 2026, "remains open-source, vendor-neutral post-Cloudflare acquisition". Vitest 4.1 stable with Vite 8; Vitest 5 planned. Oxc has **experimental React Compiler support** (June 2026 recap) → may remove the Babel step later. |
| **TypeScript** | 7.0.2 (latest), 7.1.0-dev (next) | 7.0 stable July 8, 2026 (Go native, ~10x faster); 6.0 March 23, 2026 was the last JS-based release. Use TS 7 with `@typescript/native-preview` no longer needed. |

**State management**

| Lib | Latest | Facts / fit |
|---|---|---|
| TanStack DB | @tanstack/db 0.11.0; @tanstack/react-db 0.5.0 (Sept 30, 2026) | Beta. Collections (Query, Electric, TrailBase, RxDB, PowerSync, localStorage, localOnly) + **custom collection options creators** (`sync({begin, write, commit, markReady})`, `onInsert/onUpdate/onDelete`), differential-dataflow live queries (`useLiveQuery`, `useLiveSuspenseQuery`), optimistic mutations, SQLite persistence, 0.11 "network-first initial rendering for persisted SQLite collections". Adapters: React, Vue, Solid, Svelte, Angular. Best fit for "sync engine feeding events from a local server" — but API churn risk (0.x). |
| TanStack Store | 0.11.2 | Framework-agnostic signals-ish store used inside Router/Form; not a general app store. |
| Zustand | 5.0.15 | 2.9 kB; stable; 4 open issues (third-party). Default for UI/session stores. |
| Jotai | 3.0.1 (3.0.0 Sept 8, 2026) | ESM-only, ES2020, removed `atomFamily`/`loadable` utils, `jotai/babel`, `setSelf`. Good for atomic settings. |
| XState Store | @xstate/store 4.2.3 | `createStore`, typed `trigger.*`, `select`, atoms, Zod schemas, bindings for React/Vue/Solid/Svelte/Angular/Preact. Nice for deterministic agent-lifecycle state (idle→running→waiting-for-me→done). |
| Legend-State | latest 2.1.15; **3.0.0-beta.48** | v3 still beta on npm; 200 open issues / 4.2k stars. Skip. |
| nanostores 1.5.4, valtio 2.3.2 | — | Fine but no advantage. |

**State of JS 2025 (fetched):** usage ranking unchanged (React, Vue, Angular); Solid highest satisfaction 5 years running; only Solid and Preact gaining interest; top pain point "React issues" (601 mentions), complexity (435), performance (239). Meta-frameworks: Next.js leads usage but satisfaction falling (39-point gap to Astro); TanStack Start 235 write-ins. **State of CSS 2025:** `:has()` 80.4% usage; `text-wrap: pretty` biggest YoY growth; `light-dark()` +23% awareness; scroll-driven animations flagged for lacking support (now resolved, see 2.2).

### 2.2 Styling, components, modern CSS

| Item | Latest | Facts |
|---|---|---|
| **Tailwind CSS** | 4.3.3 (v4.3 May 8, 2026; v4.2 Feb 18, 2026) | CSS-first `@theme`, new palettes (mauve/olive/mist/taupe), first-party scrollbar utilities, logical properties, zoom/tab-size, better `@variant`. **Tailwind Labs joined Shopify (Sept 9, 2026)** — license/roadmap implications not stated on the listing page → watch. No v5 announced. |
| **shadcn/ui** | CLI `shadcn@latest` | Jan 2026 Base UI docs + `--base radix|base`; Feb 2026 unified `radix-ui` package (`shadcn migrate radix`); **July 3, 2026 Base UI became default** (`style: "base-vega"`; Radix still supported via `-b radix`); July 2026 dynamic registry search; Aug 2026 **Questionnaire** component (multi-step question flows "for agent clarification prompts") across Base UI/React Aria/Radix styles, **Human-in-the-loop** helpers for AI SDK `useChat`; private GitHub registries; Sept 2026 standalone `cn` package. MCP server for agents. |
| **Base UI** | `@base-ui/react` 1.8.0 (Sept 4, 2026); 1.0.0 Dec 11, 2025 (35 components) | From the Radix/Material UI/Floating UI people; render-prop API; 1.4 OTPField, 1.6 Drawer swipe perf, 1.7 bundle/perf, 1.8 Combobox `createItems`. (Old package `@base-ui-components/react` is stale at 1.0.0-rc.0 — do not install it.) |
| React Aria Components | 1.21.1 (Apache-2.0) | Deepest a11y/i18n; heavier; good alternative. |
| Ark UI | @ark-ui/react 5.39.2 | Zag state machines; React/Vue/Solid/Svelte parity — the best **cross-framework** headless kit if you ever port. |
| Headless UI | 2.2.10 | Small catalog; fine, not needed with Base UI. |
| Reka UI (Vue) | 2.10.5 | Radix port for Vue (shadcn-vue base). |
| Bits UI (Svelte) | 2.19.4 (svelte ^5.33) | — |
| Kobalte (Solid) | 0.13.14 (solid ^1.9.8) | Not Solid-2 ready. |
| Panda CSS 2.1.0 / StyleX 0.19.1 / vanilla-extract 1.21.2 | — | All alive; StyleX still 0.x. Tailwind v4 + CSS variables covers the need; no reason to add a second styling system. |
| **Icons** | lucide (24.8k★, ISC, 1,600+ icons; `lucide-react`, `@lucide/vue`, `@lucide/svelte`, `lucide-solid`); unplugin-icons (4.9k★, MIT, Iconify 200k icons, on-demand, Vue Vapor supported); Phosphor (MIT, 1,200+ icons, 6 weights; version [unverified]) | Lucide for UI (matches shadcn); unplugin-icons for one-offs/brand icons. |

**Modern CSS support (caniuse/MDN, read 2026-10-02):**

| Feature | Support | Use in ByteBureau |
|---|---|---|
| Same-document View Transitions | Chrome 111+, Safari 18+, Firefox 144+; 91.75% global [2+] | Route/page transitions, shared-element morphs (thumbnail→lightbox, employee card→detail). |
| Scroll-driven animations (`animation-timeline`) | Chrome 115+, Safari 26+, **Firefox 160+**; 87.2% [1 caniuse] | Transcript header shrink, "new messages" indicator, parallax in office. |
| Anchor positioning | Chrome 125+ (partial), Firefox 147+ (partial), Safari 26 partial → **Safari 27.0 full** (Sept 17, 2026, transform-aware); 85.9% [2+] | Tooltips/popovers/context menus; keep Floating-UI fallback via Base UI (it handles positioning). |
| `@starting-style` + `transition-behavior: allow-discrete` | Baseline Aug 2024 [1 MDN] | Pure-CSS enter/exit for popovers, dialogs, toasts, message arrival. |
| Popover API | Baseline Jan 2025 [1 MDN] | Lightweight menus/hints without JS stacking contexts. |
| `::details-content` | Baseline Sept 2025 [1 MDN] | Collapsible thinking/tool-call blocks with native `<details>`. |
| `field-sizing: content` | Baseline June 2026 [1 MDN] | Auto-growing composer/"Other" textarea with zero JS. |
| `light-dark()` | Baseline May 2024 [1 MDN] | Theme tokens. |
| `text-wrap: balance/pretty` | widely available since March 2024 ("varying" for `pretty`) [1 MDN] | Headings/paragraphs in markdown. |
| `linear()` easing | widely available since Dec 2023 [1 MDN] | CSS-only springs (generated curves). |
| `interpolate-size` / `calc-size()` | **Chromium 129+ only**; not Safari (through 27.2) or Firefox (through 160) [2+] | Progressive enhancement only (height auto animations); need JS fallback (Motion) for WebKit shells. |
| CSS `if()` | "Limited availability" (Chromium) [1 MDN]; exact versions [unverified] | Avoid for now. |
| Container queries, `color-mix()`, OKLCH | Baseline since 2023 (not re-verified) | Tokens in OKLCH; `color-mix()` for state tints. |

Safari 27.0 (Sept 17, 2026) also added customizable `<select>` (`appearance: base-select`), scroll anchoring, `<model>`. Chrome 141 was Sept 30, 2025, so Chrome is ~v153–157 in Oct 2026 (caniuse lists Chrome 157).

**Theming/scaling guidance (practice, not library facts):** define tokens in `@theme` as OKLCH; `color-scheme: light dark` + `light-dark()`; expose a `data-theme` override; user font-size setting = set `html { font-size: calc(16px * var(--ui-scale)) }` and author everything in `rem`; `prefers-reduced-motion` → `MotionConfig reducedMotion="user"` + a CSS `@media` layer; pixel-art canvas must use `image-rendering: pixelated` and integer scale factors to avoid shimmer.

**Typography:** Geist Sans/Mono + **Geist Pixel** (OFL; `ELSH` axis with square/circle/grid/triangle/line variants) from Vercel; **Departure Mono** (OFL, 3.5k★, use in 11px multiples); Monaspace v1.4 (Neon/Argon/Xenon/Radon/Krypton; texture healing; license [unverified on page], widely known OFL); Inter [not fetched, unverified]. Pairing: Geist Sans (UI) + Geist Mono or JetBrains Mono (code) + Geist Pixel or Departure Mono (office HUD/pixel accents).

### 2.3 Animation

| Lib | Latest | Facts | Fit |
|---|---|---|---|
| **Motion** (motion.dev) | motion 13.5.0 (Oct 1, 2026; MIT; 33.8k★); motion-v 2.5.1 (Vue) | 13.0 (Aug 2026) dropped `@emotion/is-prop-valid` (set `MotionConfig isValidProp`); 13.4 **`AnimateView`** on React 19.3 ViewTransition (enter/exit/update/share, `addTransitionType`; non-interruptible → page-level); 13.5 negative `bounce` springs, `<m>` 20% smaller; 12.x `Reorder` multidimensional, `animateView`, hardware-accelerated `backgroundColor`/SVG. Hybrid engine: WAAPI off-main-thread for transform/opacity/filter/clip-path; `frame` scheduler (`read/update/render` steps, keep-alive loops, `cancelFrame`). Sponsors incl. Cursor, Linear, Figma. **Motion+** 3.0.0 (Sept 29, 2026; requires motion ^13; peer dep): $399 one-time personal lifetime; Carousel, AnimateNumber, Ticker, Cursor, Typewriter, ScrambleText, splitText, Curtains, 460+ examples; teams need Business seats. | Primary library. |
| **GSAP** | 3.15.0 (Apr 13, 2026); @gsap/react 2.1.2 | 100% free since 3.13 (Apr 29, 2025) incl. SplitText/MorphSVG/ScrollTrigger/Flip/ScrollSmoother; "Standard no-charge license" allows commercial use; **prohibited use:** building no-code visual animation tools competing with Webflow; 3.15 `easeReverse`. | Optional for timeline choreography (onboarding, celebrations). Not needed day 1. |
| **anime.js** | 4.5.0 (June 22, 2026; MIT; 73.2k★) | v4 modular; ScrollObserver, Draggable, WAAPI, springs, `createLayout` (4.3), adapters/Three.js (4.5). ~17 kB. | Good vanilla option; redundant next to Motion. |
| **@formkit/auto-animate** | 0.10.0 (MIT; 13.9k★) | One-liner list add/remove/move. | Nice for trivial lists; Motion `layout` covers it. |
| **react-spring** | @react-spring/web 10.1.2 (June 24, 2026); v11 beta | Maintained; lower momentum than Motion. | Skip. |
| **number-flow** | @number-flow/react 0.6.2 (MIT; 7.7k★; React/Vue/Svelte/vanilla) | WAAPI, `Intl.NumberFormat`, `continuous`, `trend`, respects reduced motion, `tabular-nums` → **no layout shift**, `NumberFlowGroup`. | Context meter / token counters. |
| **Theatre.js** | 12.7k★ | Development moved to a private repo ("temporarily"), public repo stale. | Reject. |
| **Rive** | @rive-app/canvas 2.44.0 (MIT runtime) | Editor exports moved to paid tiers (Oct 2025, $9/mo plan); scripting (Jan 2026); data binding; Rive Agent free (Apr 2026). State-machine driven → better than Lottie for interactive characters. | Optional for employee avatars/HUD if you want vector; pixel-art sprites make this moot. |
| **dotLottie** | @lottiefiles/dotlottie-web 0.80.0 (MIT) | WebGL/WebGPU renderers; 0.x. | Only if you have Lottie assets. |
| canvas-confetti | 1.9.4 (ISC) | `useWorker` option; cheap. | "Done" celebration. |
| Sound | howler 2.2.4 (MIT; release age [unverified], stale-ish) | For a few UI blips use Web Audio directly (`AudioContext` + decoded buffers); Howler only if you need sprites/HTML5 fallback. | — |

### 2.4 AI chat / transcript UI

| Lib | Latest | Facts |
|---|---|---|
| **Streamdown** | 2.7.0 (Sept 30, 2026; Apache-2.0; 5.7k★; peers react ^18/^19; deps `marked`, `remend 1.4.0`, `rehype-sanitize`, `remark-gfm`, `tailwind-merge`) | Drop-in react-markdown replacement for streaming; 2.7: code blocks highlight only new lines while streaming, block reuse, auto-scroll once per frame, bounded LRU highlight cache, `fallbackComponent`, `portal`, `defaultComponents` export, image loading placeholder; 2.5 (Mar 2026): `lineNumbers`, staggered streaming animation, inline KaTeX; `animated`/`isAnimating`, caret, `allowedPrefixes` link safety, `parseIncompleteMarkdown`; tables copy/download (MD/CSV/TSV). Plugins: `@streamdown/code` 2.0.0 (**Shiki v4**, Node 20+), `@streamdown/math` 1.0.3, `@streamdown/mermaid` 1.0.3, `@streamdown/cjk` 1.0.4. Needs Tailwind `@source` pointing at its `dist/` and shadcn-style CSS variables. |
| react-markdown + remark/rehype | react-markdown 10.1.0; @shikijs/rehype 4.5.0 | Fallback path only. |
| **Shiki** | 4.5.0 (Node ≥20; MIT) | v4: deprecated APIs removed; engines split (`@shikijs/engine-javascript` — all built-in languages supported, no WASM; `@shikijs/engine-oniguruma`); 4.5 perf (regex last-search reuse). |
| Mermaid 12.0.0 / KaTeX 0.19.0 | — | Lazy-load both (large). |
| **assistant-ui** | @assistant-ui/react 0.15.22 (MIT; 12.4k★; YC) | Primitives (Thread, Message, Composer, ThreadList, ActionBar), runtimes (AI SDK, LangGraph, ADK, OpenCode, custom data streams, ExternalStore), attachments, branching, tool UI, dictation, React Native/Ink. Still 0.x API. |
| **Vercel AI Elements** | shadcn registry (React) | Conversation, Message, PromptInput, Reasoning, Tool, Sources, Attachments, Task, **Queue**, **Confirmation**, Suggestion, CodeBlock, Artifact, Terminal, FileTree, JSX Preview, voice (AudioPlayer, SpeechInput, Persona), workflow Canvas/Node/Edge. Built on shadcn/Tailwind, pairs with AI SDK; license [unverified on page]. |
| **AI SDK** | ai 7.0.127 (Apache-2.0; AI SDK 7 June 25, 2026) | `useChat` transports: `ChatTransport` interface, `DefaultChatTransport` (HTTP), `DirectChatTransport` (in-process), `WorkflowChatTransport` (reconnect); 7.0: tool approval workflows (HMAC), `WorkflowAgent`, **`HarnessAgent` runs Claude Code/Codex through a unified interface**, `SandboxSession`, MCP Apps, telemetry. Relevant if ByteBureau's server speaks UI Message Streams. |
| CopilotKit | @copilotkit/react-ui 1.76.0 (MIT) | Heavier agentic framework; skip. |
| TanStack AI | @tanstack/ai 0.63.0 (RC Aug 21, 2026; 24 providers; AG-UI; MCP; sandboxes) | Watch; fits the TanStack-heavy stack if you want a client AI layer. |
| **use-stick-to-bottom** | 1.1.6 (MIT; StackBlitz; 777★) | Zero-dep; ResizeObserver; velocity-spring smooth scroll; user scroll-up cancels stickiness; `<StickToBottom>`/`useStickToBottom`, `isAtBottom`, `scrollToBottom()` promise; works without `overflow-anchor` (Safari). |
| **Virtua** | 0.52.10 (MIT; 3.8k★; React/Vue/Solid/Svelte/Angular) | ~3 kB, zero-config dynamic sizes, reverse/chat mode (`shift`), scroll-to-index, iOS reverse scroll, SSR. Still 0.x. |
| TanStack Virtual | 3.14.13 | Headless; more wiring for dynamic chat rows. |
| react-virtuoso | 4.18.16 (MIT) — **VirtuosoMessageList requires a commercial license key** | Avoid the message list. |
| **Orama** | @orama/orama 3.1.18 (Apache-2.0; 10.6k★; <2 kB claim) | Full-text + vector + hybrid, typo tolerance, facets, persistence plugin, 30+ languages (Czech stemming availability [unverified]). |
| MiniSearch 7.2.0 (MIT) / FlexSearch 0.8.212 (Apache-2.0) | — | MiniSearch = simplest; FlexSearch = fastest but idiosyncratic API. |
| **@pierre/diffs** | 1.5.1 (Apache-2.0; Pierre Computer Company; deps `shiki ^3||^4`, `diff 9`) | Split/unified, CSS Grid + Shadow DOM, comments/annotations, merge-conflict UI, worker/SSR entries, any Shiki theme. |
| Lightbox | yet-another-react-lightbox 3.32.2 (MIT; zoom/thumbnails plugins); react-zoom-pan-pinch 4.2.0 (MIT); PhotoSwipe 5.4.4 (MIT); medium-zoom 1.1.0 | YARL for gallery UX; react-zoom-pan-pinch for a custom zoom canvas (e.g., screenshots/diagrams). |
| Attachments | react-dropzone 20.1.2 (react ≥18) | Drag/drop + paste via `onPaste` `clipboardData.files`. |
| Palette / hotkeys | cmdk 1.1.1 (MIT; 13k★; depends on `@radix-ui/react-dialog`; last release ~March 2025 → year [unverified], no releases since); react-hotkeys-hook 5.3.3; tinykeys 4.0.1 (~1 kB) | cmdk is stable but slow-moving and pulls Radix Dialog into a Base UI app (fine, ~small). Alternative: build the palette on Base UI Combobox + Dialog. |
| Toasts | sonner 2.0.8 (MIT; dates on release page [unverified]) | Default. |
| Panels | react-resizable-panels 4.14.1 (4.14.0 Sept 26, 2026: Grid/Cell/Gridline; 4.13 resize preview; v4 renamed `PanelGroup→Group`, `PanelResizeHandle→Separator`, `direction→orientation`, px/rem constraints, `useDefaultLayout`, `useGroupRef/usePanelRef`) | Chat+office split, dashboard grid. |
| Confetti / sound | canvas-confetti 1.9.4; Web Audio | — |

**Asking-dialog reference (Claude Code `AskUserQuestion`, official docs):** input `questions[]` (1–4) each `{ question, header (≤12 chars), options[2–4] { label, description, preview? }, multiSelect }`; answers returned as `{ questions, answers: { [question]: label | label[] }, response? }` where `response` is a freeform reply typed instead of answering; free-text "Other" row and a notes field; `previewFormat: "markdown" | "html"` adds visual option previews (HTML sanitized of script/style); questions stay open until answered unless `askUserQuestionTimeout` (60s/5m/10m) auto-continues with a 20-second countdown, submitting any pre-selected options; permission prompts never auto-resolve. Remote Control forwards permission prompts and questions to phone/web with push "when actions required"; other dialogs expire after 5 min. Claude Code Desktop: sessions sidebar with parallel sessions and worktrees, Cmd-click to split two sessions, drag-and-drop panes (chat, diff, browser, terminal, file, plan, tasks, subagent), pop-out panes, side chats (`/btw`, Cmd+;), permission mode selector (Manual/Accept edits/Plan/Auto/Bypass), site approval card "Allow once / Always allow / Deny", task chips suggesting new sessions, Dispatch sessions from phone with push on finish/approval.

### 2.5 Dashboard / multi-session UX references

| Product | Facts (fetched) | Patterns to borrow |
|---|---|---|
| **Cursor 2.0** (Oct 29, 2025) | Agents-first layout centered on agents not files; parallel agents in worktrees or remote machines; multiple models on the same task then pick the best; built-in browser; classic IDE view still available. | "Outcomes, not files" sidebar; multi-model race for a task. |
| **Codex app** (macOS/Windows/Linux) | Projects + threads sidebar; worktrees; approvals/security review states; "needs attention" indicators; scheduled automations; file inspector. | Needs-attention badges; automations as first-class list. |
| **Claude Code Desktop** | See above: sessions sidebar, worktree toggle, split view, pane layouts, side chat, task chips, Dispatch badge, mode selector, approval cards. | Pane system; side question; task chips; mode selector near send button. |
| **Conductor** (Mac; v0.89.1) | Workspaces sidebar, status, diff/review, needs-attention indicator; pricing not detailed. | Workspace = session+branch. |
| **Paseo** (Apache-2.0; 19.2k★; Expo RN + Electron + Node daemon) | Agents list, workspaces, Build/Review/Ship/Extend tabs, history, schedules, diffs, voice, E2E-encrypted relay, iOS/Android/web. | The closest architectural sibling for "mobile remote UI"; study its daemon↔client protocol. |
| **Vibe Kanban** (Apache-2.0; 28.2k★; Rust + React) | Kanban columns, agent workspaces with terminal/dev server, inline diff comments, app preview, PR integration — **project is sunsetting**. | Kanban status columns map to running/waiting/done. |

### 2.6 Tooling for UI quality

| Tool | Latest | Facts |
|---|---|---|
| Storybook | 10.6.1 (10.0 Oct 28, 2025 ESM-only, −29% install, `sb.mock`, CSF Factories preview; 10.3 Apr 6, 2026 "for humans and agents"; 10.4 May 18, 2026 automatic setup with agents; Storybook MCP; "Storybook for TanStack React" June 16, 2026). Storybook 11 was "planned Spring 2026" but is not released. |
| Chromatic | Free 5,000 snapshots/mo; Starter $179; Pro $399; TurboSnap; Playwright/Cypress/Vitest. |
| Argos | Hobby free 5,000 screenshots/mo; Pro $100/mo; Storybook shots discounted. |
| Lost Pixel | **Archived Apr 22, 2026** (team joined Figma). Reject. |
| axe-core 4.13.0 (MPL-2.0) · @lhci/cli 0.15.1 · size-limit 14.1.0 · vite-bundle-visualizer 1.2.1 | Standard. |
| Style Dictionary 5.5.5 (Apache-2.0) | Tokens → CSS vars for `@theme`. |
| Figma MCP | Remote server on all plans (free during beta, later usage-based); desktop server needs Dev/Full seat; clients incl. Claude Code, Cursor, Codex; can write to canvas and generate code. |
| v0 | Not fetched [unverified]. |

---

## 3) Ranked recommendations + risks

### 3.1 Framework + libs table

| Layer | Pick | Version (2026-10-02) | Why | Risk |
|---|---|---|---|---|
| Language | TypeScript | 7.0.2 | Native compiler, 10x faster; `tsc --noEmit` in CI is instant. | Some tooling (ts-eslint, type plugins) may lag 7.x; keep 6.0 as escape hatch. |
| Build | Vite + Rolldown (+ optional Vite+) | 8.3.2 / rolldown 1.2.x | Fastest builds; Oxc React plugin; devtools; Vitest 4.1. | React Compiler needs `@rolldown/plugin-babel` ordering (react.dev shows `react()` then `babel()`; a community guide says `babel()` must precede `react()` → test both). VoidZero→Cloudflare transition. |
| UI | React | 19.3.0 + Compiler 1.0 | Stable ViewTransition/Activity; richest chat ecosystem; owner expertise. | Compiler bailouts on unusual patterns; use ESLint `react-hooks` recommended-latest. |
| Router | TanStack Router (library, SPA) | 1.170.41 | Typed search params for deep-linkable UI state (session, employee, floor); view transitions; memory/hash history for shells. | Frequent releases (1.x weekly). |
| Optional full-stack | TanStack Start (SPA mode) | 1.168.60 (RC) | Only if you want server functions co-located; SPA shell prerender. | Still RC; CVE Sept 2026 shows surface area. |
| Server state | TanStack Query + **TanStack DB** | DB 0.11.0 / react-db 0.5.0 | Live queries over a custom WS-fed collection = dashboard counts update in <1 ms; optimistic mutations. | Beta API churn; keep the collection adapter thin so Zustand can replace it. |
| Client state | Zustand 5 + Jotai 3 (+ XState Store 4 for lifecycle FSM) | 5.0.15 / 3.0.1 / 4.2.3 | Tiny, stable, selector-based re-render control. | Jotai 3 ESM-only (fine with Vite). |
| Styling | Tailwind v4 + CSS tokens (OKLCH, `light-dark()`) | 4.3.3 | CSS-first theme, container queries, scrollbar utils. | Shopify acquisition — monitor license/pace. |
| Components | shadcn/ui on Base UI | @base-ui/react 1.8.0 | Default since July 2026; render-prop API; Drawer/Toast/Combobox; Questionnaire + HITL helpers. | Base UI 1.x minor releases carry occasional breaking fixes (1.4). |
| Icons | Lucide + unplugin-icons | — | Consistent with shadcn; Iconify long tail. | — |
| Animation | Motion | 13.5.0 | AnimateView (ViewTransition), layout/presence, springs, `frame` scheduler, WAAPI acceleration. | 13.0 breaking `isValidProp`; layout animations are main-thread. |
| Numbers | number-flow | 0.6.2 | Zero layout shift, reduced-motion aware. | 0.x. |
| Markdown | Streamdown (+ code/math/mermaid plugins) | 2.7.0 | Purpose-built for streaming; incremental highlighting; Shiki 4. | Tailwind-coupled styling; Vercel-driven roadmap. |
| Highlighting | Shiki (JS engine) | 4.5.0 | Shared highlighter for markdown + diffs; no WASM. | Grammar bundles are big → lazy per language. |
| Diffs | @pierre/diffs | 1.5.1 | Shiki-native, Shadow DOM, comments. | Young (1.x, 2026). |
| Scroll | use-stick-to-bottom → Virtua when needed | 1.1.6 / 0.52.10 | Spring stick-to-bottom; virtualize beyond ~500 messages. | Combining virtualization + stick-to-bottom requires using Virtua's own scroll control (do not stack both). |
| Search | Orama (client) + SQLite FTS5 (server) | 3.1.18 | Typo-tolerant per-session index; hybrid later. | Czech stemmer availability [unverified]. |
| Palette/keys | cmdk + react-hotkeys-hook (or tinykeys) | 1.1.1 / 5.3.3 | Standard ⌘K. | cmdk slow-moving; Radix Dialog dep. |
| Toasts | Sonner | 2.0.8 | — | — |
| Panels | react-resizable-panels | 4.14.1 | px constraints, Grid, a11y separators. | v4 API differs from most tutorials. |
| Lightbox | yet-another-react-lightbox (+ react-zoom-pan-pinch) | 3.32.2 / 4.2.0 | Zoom plugin, keyboard, thumbnails. | — |
| Attachments | react-dropzone | 20.1.2 | — | — |
| Celebration | canvas-confetti | 1.9.4 | — | — |
| Testing/QA | Storybook 10 + Vitest 4 + Chromatic or Argos (free tiers) + axe-core + LHCI + size-limit | — | Visual regression is essential for "no pop-ins" discipline. | Lost Pixel is dead. |

### 3.2 Animation playbook

Perf rules (Motion perf docs, web.dev animations guide, web.dev CLS):
1. Animate only `transform` and `opacity` (plus `filter`/`clip-path`/`background-color` where accelerated); never `height/width/top/left/margin` on the hot path.
2. Reserve space: every image/avatar/canvas gets `aspect-ratio` or explicit size; skeletons match final dimensions; `font-display: swap` + `size-adjust` fallback metrics so markdown doesn't reflow.
3. Per-frame work goes through one scheduler: Motion `frame.read → frame.update → frame.render`, or the Pixi ticker — never both racing.
4. 120 Hz: budget ≈ 8.3 ms. Batch streaming deltas per `requestAnimationFrame`; wrap non-urgent store updates in `startTransition`; `useDeferredValue` for search/filter; `content-visibility: auto` + `contain: layout paint` on message rows; avoid `backdrop-filter` on moving surfaces; `will-change: transform` only on elements that are about to move.
5. Honor `prefers-reduced-motion` globally (`<MotionConfig reducedMotion="user">` + CSS media query); keep opacity fades, drop movement.
6. View Transitions are non-interruptible → page-level only; micro-interactions use Motion/CSS.

| Interaction | Technique | Library |
|---|---|---|
| Route/page transitions (dashboard ↔ project ↔ session) | React `<ViewTransition>` via Motion `AnimateView` (`addTransitionType('forward'|'back')`), or TanStack Router `viewTransition` + CSS `::view-transition-*`; shared-element `share` names for employee avatar → detail header. | Motion 13.4+, React 19.3 |
| Panel open/close (employee detail, side chat) | Base UI Drawer/Dialog with `@starting-style` + `transition-behavior: allow-discrete` on transform/opacity; width changes via `react-resizable-panels` with `transition: flex-basis` disabled during drag. | CSS, Base UI, panels v4 |
| List reorder (sessions re-sorted by status; employees) | Motion `layout` + `LayoutGroup` + `AnimatePresence mode="popLayout"`; drag reorder with `Reorder`. Trivial lists: auto-animate. | Motion |
| Chat message arrival | Insert with `opacity 0→1` + `translateY(6px→0)` 160–200 ms via `@starting-style`; **never animate height of a streaming block**; Streamdown `animated` for token fade; caret via `isAnimating`. | CSS + Streamdown |
| Streaming text from several agents | One WS subscription → ring buffer → flush once per rAF into a per-message store slice; only the tail message re-renders (React Compiler memoizes the rest); keep hidden sessions mounted inside `<Activity mode="hidden">` so switching is instant and state-preserving. | React 19.2/19.3 |
| Auto-scroll | `use-stick-to-bottom` (`resize="smooth"`, `initial="instant"`), "Jump to latest" pill when `!isAtBottom` (scroll-driven `animation-timeline` for the pill fade). | use-stick-to-bottom |
| Number tickers (context meter, tokens, cost) | `<NumberFlow continuous trend>` inside `font-variant-numeric: tabular-nums`; ring = SVG `stroke-dashoffset` transitioned with `linear()` spring; color via `color-mix()` thresholds (70/85/95%). | number-flow, CSS |
| Toasts / notification bubbles | Sonner (`richColors`, `expand`), office bubble = DOM overlay anchored to the sprite (see below) with `@starting-style` pop. | Sonner, CSS |
| Collapsible thinking / tool-call cards | `<details>` + `::details-content` with `interpolate-size: allow-keywords` (Chromium) and Motion `animate height` fallback for WebKit/Firefox; chevron rotate via transform. | CSS + Motion |
| Done celebration | `canvas-confetti({ useWorker: true })` + Sonner success + short Web Audio blip (gated by settings). | canvas-confetti |
| Office canvas ↔ DOM overlay sync | Keep sprite positions in a typed array owned by the canvas loop; each tick `frame.read` camera → `frame.render` sets `style.transform = translate3d(x,y,0)` on overlay nodes via refs (no React state); overlays in a `position: fixed; inset: 0; pointer-events: none` layer with `contain: strict`; snap to integer device pixels (`Math.round(x * dpr) / dpr`) to avoid pixel-art shimmer; pause the loop when the tab is hidden (`visibilitychange`) and when `<Activity>` hides the pane. | Motion `frame` / Pixi ticker |
| Skeleton / no-pop-in | Skeleton rows sized by the real row template; replace with `AnimatePresence` cross-fade (opacity only); images decode via `decoding="async"` + `loading="lazy"` with reserved `aspect-ratio`; fonts preloaded. | CSS |

### 3.3 Chat/transcript component architecture

```
<SessionProvider sessionId>            // TanStack Query (history) + WS subscription → TanStack DB collection "events"
  <TranscriptHeader/>                   // employee avatar (ViewTransition share), model/effort chips, <ContextMeter/>, search toggle
  <TranscriptSearch/>                   // Orama index per session; highlights; ↑↓ to jump; Esc closes
  <StickToBottom>                       // or <VList shift> once > ~500 rows
    <MessageList>                       // rows keyed by message id; content-visibility:auto
      <Message role>                    // memoized; ActionBar (copy, quote, retry, open-in-office)
        <Parts>
          <TextPart/>                   // <Streamdown animated isAnimating> + @streamdown/code (Shiki 4 JS engine)
          <ThinkingPart/>               // <details> collapsible, token count, duration
          <ToolCallPart/>               // card: name, args (JSON viewer), status spinner→check, result tabs (text / diff / image / file)
          <DiffPart/>                   // @pierre/diffs (split/unified, comments)
          <ImagePart/>                  // reserved aspect-ratio thumb → YARL lightbox (ViewTransition share)
          <FilePart/>                   // attachment chip, download
          <QuestionPart/>               // AskingDialog inline card (see 3.4)
          <PermissionPart/>             // Allow once / Always / Deny card (never auto-resolves)
        </Parts>
      </Message>
    </MessageList>
    <JumpToLatest/>                     // visible when !isAtBottom; shows unread count
  </StickToBottom>
  <Composer>                            // textarea with field-sizing:content, react-dropzone + paste, slash commands via cmdk, hotkeys, send/stop, mode selector
</SessionProvider>
```

Data flow: server emits typed events (`message.start`, `text.delta`, `tool.call`, `tool.result`, `question.ask`, `permission.ask`, `usage.update`, `message.end`). Client: WS → rAF-batched reducer → TanStack DB collection (or Zustand slice) → components subscribe by message id. Deltas append to a `string` builder per text part; Streamdown re-parses incrementally (2.7 only lexes new tokens). Persist transcripts in SQLite on the server; the client keeps only the loaded window + Orama index. Copy-to-clipboard copies the raw markdown; feedback = icon morph (`AnimatePresence`) + Sonner.

### 3.4 UX wireframes (text)

**Dashboard (home):**
- Left rail (240 px, collapsible, `react-resizable-panels` Group): search/⌘K at top; **"Needs you" inbox** (amber count) listing every session waiting on a question/permission across projects; then Projects → Sessions tree with status pills: running (pulsing green dot + elapsed), waiting-for-me (amber, bell), done (grey check), failed (red). `j/k` move, `Enter` opens, `1–9` jump, `⌘N` new session.
- Main: header with global stats (NumberFlow: active agents, tokens today, cost); grid of project cards (name, branch, mini floor-preview canvas thumbnail, 3 latest sessions with status, "needs you" badge); filter chips (running / waiting / done); empty state = pixel-art empty office illustration + "Hire your first employee" CTA + onboarding wizard (3 steps: provider & token → project folder → first employee role/model/effort).
- Right (optional, `⌘.`): live activity feed (toasts history), keep-awake toggle, font-size slider (rem scaling), language cs/en.

**Chat + office split (session view):**
- Top bar: breadcrumb Project / Session, floor selector (segmented control: Floor 1 … n), layout toggle (office | split | chat), permission-mode selector, context meter ring.
- Horizontal Group: **Office pane** (min 320 px) = canvas with employees walking/typing; hovering a sprite shows a DOM tooltip (anchor-positioned); clicking focuses that employee's transcript and scrolls the chat; speech bubbles are DOM overlays synced per frame. **Transcript pane** (min 420 px) = architecture in 3.3. A thin **Separator** (Base UI/panels v4) with resize preview; layout persisted via `useDefaultLayout`.
- Mobile remote (<768 px): tabs "Office / Chat / Inbox"; composer sticky bottom; questions/permissions open as bottom sheets; push notifications when a session needs you (pattern from Claude Code Remote Control).

**Employee detail panel:**
- Right-side Drawer (Base UI) 400 px, opened from the office sprite or transcript header with ViewTransition shared avatar; sections: identity (pixel avatar, name, role, floor/desk), **Model & effort** chips (provider logo, model id, effort level with a 3-segment meter, temperature if any), current task + state FSM (idle/running/waiting/done) with elapsed timer, **context usage** ring (% until compact, tokens in/out, cache hits) with sparkline, tools & permissions list (toggle allow/deny), recent sessions, actions (assign task, pause, duplicate, fire). `Esc` closes; `⌘E` toggles.

**Asking dialog (inline card in transcript + bottom sheet on mobile):**
- Header chip (≤12 chars, e.g. "Format") + question text; 2–4 option rows, each with label, one-line description, optional preview (rendered markdown/HTML in a bordered mini-frame); the **recommended** option is pre-selected, marked with a star and a "Recommended" tag, and `Enter` submits it; number keys `1–4` select; `multiSelect` renders checkboxes with a "Continue" button; last row "Other…" expands a textarea (`field-sizing: content`); link "Reply instead" collapses the card into the composer (sends `response`); optional **auto-continue countdown** ring (if enabled in settings, e.g. 5 min) with the last 20 s shown as a number ticker; after answering, the card collapses into a one-line summary ("Format → Summary") with an "Edit" affordance until the agent consumes it. Permission cards share the same chrome but have exactly three buttons (Allow once / Always allow / Deny) and no timer.

### 3.5 Alternative paths (ranked)

1. **React path above** — best ecosystem and animation story; hype via React 19.3 ViewTransition, Compiler, TS 7, Vite 8/Rolldown, TanStack DB, Base UI, Streamdown.
2. **Vue 3.6 Vapor path** — Vue 3.6 (RC) + Nuxt 4.5 or plain Vite + Reka UI/shadcn-vue + motion-v 2.5 + Virtua (Vue) + unplugin-icons + TanStack Query/DB (Vue adapters) + custom markdown pipeline (markdown-it or unified + Shiki) because Streamdown/assistant-ui/AI Elements/@pierre/diffs are React-only. Choose only if you want Vapor as the showcase and accept writing more chat primitives.
3. **Solid 2.0 path** — maximum "hype" (first-class async) but RC, Kobalte not ready, TanStack Solid Start fine; chat primitives must be hand-built. Not recommended for a solo maintainer shipping this year.
4. **SvelteKit 3** — nice DX, but remote functions still experimental and the AI-chat ecosystem is thin; owner is React/Vue.

---

## 4) Rejected options (with reasons)

- **Next.js 16 / RSC** — server-centric; local-first desktop/mobile shell gains nothing; RSC CVEs (Dec 2025) add surface.
- **React Router 8 framework mode** — fine router, weaker typed search params than TanStack; v8 drops react-router-dom and demands Node 22.22+/React 19.2.7+; no compelling win.
- **Legend-State v3** — still beta on npm (3.0.0-beta.48), 200 open issues.
- **TC39 Signals polyfill as app state** — Stage 1.
- **Radix as the shadcn base for a new project** — shadcn moved default to Base UI (July 2026); keep Radix only for cmdk's internal dialog.
- **Panda / StyleX / vanilla-extract** — alive but redundant with Tailwind v4 tokens; StyleX still 0.x.
- **react-spring** — maintained (10.1.2) but Motion covers more with better acceleration.
- **Theatre.js** — public development paused.
- **GSAP as primary** — free and excellent, but Motion's React integration + ViewTransition wrapper fits better; GSAP's "no-code animation builder" prohibited-use clause is irrelevant to ByteBureau.
- **VirtuosoMessageList** — commercial license key required.
- **Lottie/dotLottie for characters** — pixel-art sprites + Rive (if vector) are better; dotLottie 0.x.
- **Lost Pixel** — archived Apr 2026.
- **Vibe Kanban as a base** — sunsetting; still worth reading for the kanban→session mapping.
- **CSS `if()` / `interpolate-size` as load-bearing** — Chromium-only.
- **CopilotKit** — too heavy; vendor-shaped.
- **Howler** — stale; Web Audio suffices.

---

## 5) Open questions for the owner

1. **Framework commitment:** React 19.3 (recommended) or wait for Vue 3.6 stable (Q4 2026) to showcase Vapor? A Vue choice means hand-rolling streaming markdown, diffs and stick-to-bottom.
2. **Shell:** Electron (Chromium → `interpolate-size`, CSS `if()` usable) vs Tauri/WKWebView (Safari 27 engine → no `interpolate-size`, anchor positioning OK). This decides how much progressive enhancement is acceptable. Also determines TanStack Router history type (memory/hash).
3. **Server functions or plain API?** TanStack Start SPA mode (RC) vs Vite SPA + your own WS/HTTP server (simplest; recommended).
4. **TanStack DB (beta) for live dashboard queries, or Zustand only** until DB hits 1.0? Beta churn vs. live-query elegance.
5. **Mobile remote UI:** responsive PWA of the same React app (recommended, one codebase) vs Expo/React Native like Paseo?
6. **Budget for Motion+ ($399 one-time)** — only worth it for `AnimateNumber`/`Ticker`/`Cursor`; `number-flow` covers the meter for free.
7. **Visual regression vendor:** Chromatic (Storybook-native) vs Argos (cheaper per shot) — both have free 5k/mo tiers.
8. **Pixel accent font:** Geist Pixel (shape axis, Vercel) vs Departure Mono (11 px grid).
9. **"Recommended option" semantics:** should the agent mark it (tool schema extension) or should ByteBureau infer it (first option / heuristic)? Claude Code's schema has no `recommended` field; it's a ByteBureau extension.
10. **Czech search:** verify Orama's Czech tokenizer/stemmer; otherwise use MiniSearch with a custom tokenizer or rely on SQLite FTS5 (unicode61) server-side.
11. **Auto-continue timeout for questions** (Claude Code offers 60s/5m/10m with countdown) — do you want this behaviour in ByteBureau's inbox?
12. **i18n library** (cs/en) was outside this cluster — not researched here.

---

## 6) Sources (fetched 2026-10-02)

Frameworks/tooling
- https://react.dev/blog — post list (19.3 Sept 9, 2026; React Foundation Feb 24, 2026; Compiler 1.0 Oct 7, 2025; 19.2 Oct 1, 2025)
- https://react.dev/blog/2026/09/09/react-19-3 — ViewTransition/Fragment refs stable, browser(), Trusted Types
- https://react.dev/learn/react-compiler/installation — Vite setup via @rolldown/plugin-babel + reactCompilerPreset
- https://recca0120.github.io/en/2026/04/14/react-compiler-vite-v6/ — plugin-react v6 (Oxc) + compiler ordering caveat
- https://github.com/vuejs/core/releases — 3.5.43 latest; 3.6.0-rc.10 (Sept 30, 2026)
- https://registry.npmjs.org/vue — dist-tags
- https://github.com/solidjs/solid/discussions/2596 — 2.0.0-beta.0 (March 3, 2026)
- https://www.infoq.com/news/2026/05/solidjs-2-async/ — Solid 2.0 features
- https://github.com/solidjs/solid/releases ; https://registry.npmjs.org/solid-js — 2.0.0-rc.13 (Sept 30, 2026)
- https://svelte.dev/blog ; https://svelte.dev/blog/sveltekit-3-is-here — SvelteKit 3 (Oct 1, 2026), remote functions still experimental
- https://tanstack.com/blog — 2026 posts (TanStack AI RC Aug 21, Table v9 Aug 4, Start CVE Sept 30)
- https://tanstack.com/blog/announcing-tanstack-start-v1 — RC post (Sept 23, 2025)
- https://tanstack.com/start/latest — "RC" badge; React + Solid; ssr modes
- https://tanstack.com/start/latest/docs/framework/react/guide/spa-mode — SPA mode
- https://tanstack.com/router/latest/docs/framework/react/guide/history-types — history types
- https://github.com/TanStack/router/releases — react-router 1.170.41 / react-start 1.168.60 (Sept 30, 2026)
- https://tanstack.com/db/latest/docs/overview ; https://tanstack.com/db/latest/docs/guides/collection-options-creator ; https://github.com/TanStack/db/releases — DB 0.11.0 (Sept 30, 2026), custom sync API
- https://reactrouter.com/changelog — v8.0 (June 17, 2026) … v8.4 (Sept 15, 2026)
- https://nuxt.com/blog — Nuxt 4.5 (July 18, 2026), 4.5.1 (July 27, 2026)
- https://qwik.dev/blog/ — Qwik v2
- https://vite.dev/blog/announcing-vite8 — Vite 8 (March 12, 2026)
- https://voidzero.dev/posts/announcing-rolldown-1-0 — Rolldown 1.0 (May 7, 2026)
- https://voidzero.dev/posts/whats-new-mar-2026 ; https://voidzero.dev/posts/whats-new-may-2026 ; https://voidzero.dev/posts/whats-new-jun-2026 — Vite+ MIT beta (July 10, 2026), Cloudflare, Vitest 4.1/5, Oxc React Compiler experimental
- https://devblogs.microsoft.com/typescript/ — TS 7.0 (July 8, 2026), 6.0 (March 23, 2026)
- https://2025.stateofjs.com/en-US/libraries/front-end-frameworks/ ; https://2025.stateofjs.com/en-US/libraries/meta-frameworks/ ; https://2025.stateofcss.com/en-US/features/
- https://stately.ai/docs/xstate-store ; https://github.com/pmndrs/jotai/releases ; https://github.com/LegendApp/legend-state
- TC39 Signals: https://gitnation.com/contents/standardizing-signals-in-tc39 ; https://reptile.haus/journal/tc39-javascript-signals-reactivity-proposal-development-teams-2026/

Styling/components/CSS
- https://tailwindcss.com/blog ; https://tailwindcss.com/blog/tailwindcss-v4-3 (via search) ; Shopify post `/blog/tailwind-is-joining-shopify` (Sept 9, 2026)
- https://ui.shadcn.com/docs/changelog ; https://ui.shadcn.com/docs/changelog/2026-02-radix-ui ; https://github.com/shadcn-ui/ui/discussions/9562 ; https://blog.openreplay.com/shadcn-ui-radix-base-ui-switch/
- https://base-ui.com/react/overview/releases ; https://registry.npmjs.org/@base-ui/react/latest
- https://github.com/lucide-icons/lucide ; https://github.com/unplugin/unplugin-icons ; https://github.com/phosphor-icons/core
- https://caniuse.com/css-anchor-positioning ; https://caniuse.com/view-transitions ; https://caniuse.com/mdn-css_properties_animation-timeline ; https://caniuse.com/mdn-css_properties_interpolate-size
- MDN: /docs/Web/CSS/field-sizing ; /::details-content ; /@starting-style ; /text-wrap ; /color_value/light-dark ; /API/Popover_API ; /easing-function/linear ; /if ; /interpolate-size
- https://webkit.org/blog/18325/webkit-features-for-safari-27-0/ — Safari 27.0 (Sept 17, 2026)
- https://developer.chrome.com/release-notes/141 — Chrome 141 (Sept 30, 2025)
- Fonts: https://vercel.com/font ; https://github.com/rektdeckard/departure-mono ; https://monaspace.githubnext.com

Animation
- https://motion.dev/changelog ; https://github.com/motiondivision/motion ; https://motion.dev/docs/react-animate-view ; https://motion.dev/docs/performance ; https://motion.dev/docs/frame ; https://motion.dev/plus
- https://gsap.com/blog/ ; https://gsap.com/pricing/ ; https://gsap.com/standard-license
- https://github.com/juliangarnier/anime/releases ; https://github.com/formkit/auto-animate ; https://github.com/theatre-js/theatre ; https://github.com/barvian/number-flow ; https://number-flow.barvian.me ; https://rive.app/blog
- https://web.dev/articles/animations-guide ; https://web.dev/articles/cls
- react-spring: https://github.com/pmndrs/react-spring/releases (via search)

Chat/transcript
- https://github.com/vercel/streamdown ; https://github.com/vercel/streamdown/releases ; https://vercel.com/changelog/streamdown-2-5
- https://shiki.style/blog/v4 ; https://shiki.style/blog/v3
- https://github.com/assistant-ui/assistant-ui ; https://elements.ai-sdk.dev/overview ; https://ai-sdk.dev/docs/ai-sdk-ui/transport ; https://vercel.com/blog/ai-sdk-7
- https://github.com/stackblitz-labs/use-stick-to-bottom ; https://github.com/inokawa/virtua ; https://virtuoso.dev/message-list/
- https://github.com/oramasearch/orama ; https://diffs.com ; https://github.com/pacocoursey/cmdk ; https://github.com/pacocoursey/cmdk/releases ; https://github.com/emilkowalski/sonner/releases ; https://github.com/bvaughn/react-resizable-panels/releases
- npm registry `/latest` for: streamdown, shiki, @shikijs/rehype, react-markdown, mermaid, katex, @assistant-ui/react, ai, @copilotkit/react-ui, @tanstack/ai, use-stick-to-bottom, virtua, @tanstack/react-virtual, react-virtuoso, @orama/orama, minisearch, flexsearch, cmdk, sonner, react-resizable-panels, yet-another-react-lightbox, react-zoom-pan-pinch, photoswipe, medium-zoom, react-dropzone, react-hotkeys-hook, tinykeys, howler, canvas-confetti, @pierre/diffs

Agent apps / UX
- https://code.claude.com/docs/en/desktop ; https://code.claude.com/docs/en/agent-sdk/user-input.md ; https://code.claude.com/docs/en/tools-reference.md ; https://code.claude.com/docs/en/remote-control.md
- https://cursor.com/blog/2-0 ; https://learn.chatgpt.com/docs/app (Codex app) ; https://conductor.build ; https://paseo.sh ; https://github.com/getpaseo/paseo ; https://github.com/BloopAI/vibe-kanban

Tooling
- https://storybook.js.org/blog/storybook-10/ ; https://storybook.js.org/blog/ ; https://www.chromatic.com/pricing ; https://argos-ci.com/pricing ; https://github.com/lost-pixel/lost-pixel ; https://help.figma.com/hc/en-us/articles/32132100833559
- npm registry `/latest` for: storybook, style-dictionary, axe-core, @lhci/cli, size-limit, vite-bundle-visualizer, @vitejs/plugin-react, babel-plugin-react-compiler, typescript, @typescript/native-preview, vite, react, svelte, @sveltejs/kit, preact, @angular/core, nuxt, next (via search), react-router, @qwik.dev/core, zustand, jotai, @legendapp/state, @xstate/store, nanostores, valtio, @tanstack/store, @tanstack/db, @tanstack/react-db, @tanstack/react-start, @tanstack/react-router, @tanstack/solid-start, tailwindcss, @pandacss/dev, @stylexjs/stylex, @vanilla-extract/css, @headlessui/react, react-aria-components, @ark-ui/react, reka-ui, bits-ui, @kobalte/core, motion, motion-v, gsap, @gsap/react, animejs, @formkit/auto-animate, @number-flow/react, @rive-app/canvas, @lottiefiles/dotlottie-web
