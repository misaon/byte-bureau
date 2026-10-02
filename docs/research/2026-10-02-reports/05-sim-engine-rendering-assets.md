# ByteBureau research cluster 05 — 2D engine, rendering, tilemaps, sprites, assets, camera/zoom, UI integration

Research date: 2026-10-02. All versions/dates below were read from the npm registry, the GitHub API (`gh api`), bundlephobia, or the cited pages on this date. Where a WebFetch summary disagreed with registry data (several page summaries mis-stated the year), the registry/API value is used. Claims backed by only one source are marked **(unverified)**.

---

## 1. Executive summary

**Engine choice: PixiJS v8 (8.22.0, released 2026-10-01).** It is the only mature web 2D renderer that (a) ships WebGPU + WebGL2 + an experimental Canvas backend with automatic fallback and, since 8.21.0, lazy per-backend chunks; (b) is TypeScript-native with declared TS 5/6/7 support; (c) is a *renderer* rather than a game framework, so our simulation can stay engine-free and run headless (worker / Bun / Node) while Pixi is only a thin "render adapter"; (d) has the ecosystem we need (`@pixi/ui`, `@pixi/layout`, `pixi-filters`, `@pixi/tilemap`, `@pixi/react`, `@pixi/node`, built-in `ParticleContainer`, `RenderLayer`, `CullerPlugin`, `DOMContainer`, accessibility layer, BitmapText, `cacheAsTexture`); (e) is what the two most successful AI-office visualizers in this exact niche use (munder-difflin 8.3k★, paulrobello/claude-office 538★); (f) has official AI-agent skills (`npx skills add https://github.com/pixijs/pixijs-skills`, 25 skills) which matters for a project built by coding agents. Full build is 904 KB min / 259 KB gzip but tree-shakeable via subpath imports.

**Runner-up: Phaser 4** (4.0.0 on 2026-04-10, 4.2.1 on 2026-07-09). Excellent built-ins for pixel art (`smoothPixelArt`, `vertexRoundMode`, `TilemapGPULayer`, real-time lighting with normal maps) but it is a JS framework that owns the game loop/scene lifecycle, has no WebGPU, deprecated Canvas, is not tree-shakeable (`sideEffects: true`, 1338 KB min / 347 KB gzip), and fights a React/Vue shell plus a headless sim.

**Pixel-perfect pipeline:** nearest-neighbour textures (`TextureStyle.defaultOptions.scaleMode = 'nearest'` before loading), `antialias: false`, `resolution = devicePixelRatio` + `autoDensity`, **integer zoom in device pixels**, camera smoothed on an unsnapped target and snapped only at render time, optional render-to-RenderTexture at native tile resolution then integer upscale (Unity "Upscale Render Texture" / Godot "viewport + integer" model), fixed-timestep simulation with render interpolation (Gaffer), ticker paused on `visibilitychange`.

**Tilemaps:** do not use Tiled/LDtk *maps* (layouts are procedurally generated). Use **Tiled 1.12.2** only as the tileset-metadata editor: its JSON `wangsets` (corner / edge / mixed) are exactly the autotile data we need at runtime. Floors: **dual-grid (16 display cases, 5–6 art tiles)** per material; walls: **4-bit edge bitmask (16 tiles)**, Prison-Architect style, doors/windows as wall-tile substitutions; furniture as multi-tile objects with footprint/anchor/rotation variants/interaction tile (pixel-agents' manifest format is a good reference). LDtk's rule engine is editor-only and its last release is v1.5.3 (2024-01-15) — rejected for runtime.

**Assets:** The popular "AI office" look is LimeZu *Modern Interiors* (paid, credit required, **"CAN'T … distribute the asset to others"**). Several MIT repos commit it anyway (munder-difflin, SkyOffice, agentroom) — that is a license risk, not a precedent to copy. Recommended plan: (1) prototype on **CC0** (Kenney Roguelike Indoors / Modern City / Tiny Town, 2dPig Pixel Office); (2) build **our own owned tileset + layered character base** with **PixelLab** (ToS 2025-11-23: you own outputs, commercial OK) and/or **Retro Diffusion** (one-time Aseprite extension, consent-trained, you own outputs), hand-cleaned in **Aseprite 1.3.18.6**, released under CC0/CC-BY-4.0 in the repo; (3) optionally buy LimeZu for a private "premium theme" that is *not* committed to the public repo unless LimeZu confirms in writing. **Mana Seed is unusable** (license forbids use "alongside AI-generated … code"). **LPC** is share-alike (CC-BY-SA/GPL) and 64×64 — reject.

**Integration:** one imperative `<OfficeCanvas>` component owning the Pixi `Application`; framework-agnostic store (zustand 5 / nanostores / @tanstack/store) with `subscribe()`-driven scene sync; React/Vue never re-renders per frame; sim in a Worker or on the Bun/Node server, snapshots + interpolation to the renderer and to the phone client.

---

## 2. Findings per topic

### 2.1 Web 2D engines in 2026 (verified facts)

| Engine | Latest stable (npm) | Date | GitHub ★ / license | Backends | Language | Size (bundlephobia, min/gzip) | Notes |
|---|---|---|---|---|---|---|---|
| **pixi.js** | 8.22.0 | 2026-10-01 | 48,255 / MIT | WebGPU, WebGL2/1, Canvas (experimental, 8.16.0 2026-02-03) | TS | 904 KB / 259 KB; tree-shakeable (`sideEffects` whitelist) | 500k weekly npm downloads (June 2026 blog). Release cadence ~monthly (8.18 Apr 14, 8.19 Jun 4, 8.20 Aug 20, 8.21 Sep 17, 8.22 Oct 1 2026). |
| **phaser** | 4.2.1 | 2026-07-09 | 40,398 / MIT | WebGL2 (+WebGL1), Canvas deprecated; **no WebGPU** | JS (+ d.ts) | 1338 KB / 347 KB; `sideEffects: true` | 4.0.0 "Caladan" 2026-04-10, 4.1.0 "Salusa" 2026-04-30, 4.2.0 2026-06-19. |
| **excalibur** | 0.32.0 (`next` = 0.33.0-alpha.247) | 2025-12-23 | 2,347 / BSD-2 | WebGL2 | TS | 557 KB / 142 KB | v1.0 still not shipped; repo active (pushed 2026-10-01). WebGPU explicitly deferred. |
| **melonjs** | 20.7.0 | 2026-09-22 | 6,401 / MIT | WebGPU (full, since 20.0.0 2026-08-21), WebGL2, Canvas | JS (+ d.ts), zero deps | 867 KB / 256 KB | Weekly 20.x releases Aug–Sep 2026; small community. |
| **kaplay** | 3001.0.19 (`next` = 4000.0.0-alpha.27.1, 2026-05-12) | 2025-06-15 | 1,805 / MIT | WebGL | TS | 179 KB / 65 KB | v4000 has been alpha since 2025; frequent breaking changes in alphas. |
| **three** | 0.186.1 (r186) | 2026-09-24 | 116,141 / MIT | WebGPURenderer (falls back to WebGL2) | JS (+ d.ts) | 719 KB / 181 KB (core) | 3D-first; has a `webgl_postprocessing_pixel` pixel-snapping example. Releases every 8–11 weeks. |
| **@babylonjs/core** | 9.29.0 | 2026-10-01 | 26,126 / Apache-2.0 | WebGPU (native WGSL), WebGL | TS | 7871 KB / 1744 KB | 9.0.0 on 2026-03-26; weekly releases. 3D engine. |
| **Godot** | 4.7.2-stable | 2026-08-18 | 118,061 / MIT | Web = **WebGL2 Compatibility only; "Godot currently does not support WebGPU"** (4.7 docs) | GDScript/C# | wasm + pck (≈25% after gzip) | Single-threaded export default since 4.3 (no COOP/COEP needed); threads need SharedArrayBuffer headers. |
| **Bevy** | 0.19.1 | 2026-08-13 | 48,533 / Apache-2.0 | wgpu → WebGL2/WebGPU | Rust | large wasm | No multithreading on wasm; 2D camera "Pan" controller added in 0.18 (2026-01-13). |
| **@rive-app/canvas** | 2.44.0 | 2026-09-30 | 971 / MIT (runtime) | Canvas/WebGL | TS + wasm | 204 KB / 58 KB (+wasm) | Vector animation runtime; no pixel-art pipeline. |

Evidence highlights:

- **PixiJS**: v8.22.0 (2026-10-01) added `contextmenu` events, sRGB view formats, transient MSAA, 3D/storage textures, accessibility activates on Tab by default. v8.21.0 (2026-09-17): TS 5/6/7 support (for TS 6/7 remove `@webgpu/types` and use `@types/web`), **renderer loader extensions so "each backend stays in its own chunk and only the active one loads"**, WebGPU device-loss recovery. v8.20.0: WGSL shader overrides, WebGPU render bundles. v8.19.0: HTML-in-canvas textures (`pixi.js/html-source`). v8.18.0: experimental Canvas renderer (`preference: 'canvas'`), tagged text, `domContainerRoot`. June 2026 blog: 500k weekly downloads; 25 official skills for AI coding agents.
- **Phaser 4**: render-node architecture; `roundPixels` now defaults to false; new `smoothPixelArt` ("antialiasing while maintaining sharp texels"); per-object `vertexRoundMode` (off/safe/safeAuto/full); `TilemapGPULayer` (whole layer as one quad, "fixed per pixel on screen", up to 4096×4096 tiles); `SpriteGPULayer`; `sprite.setLighting(true)` with self-shadows; Canvas renderer "officially deprecated"; "Phaser 4 is a WebGL2 rewrite, not a WebGPU engine; WebGPU is future groundwork". "Beam" is now the name of Phaser's no-code editor, not the renderer. Migration from v3 "a few hours of work" for standard games.
- **Excalibur**: `pixelArt: true` option = canvas AA off + "blended" texture filtering + MSAA + a **sub-pixel pixel-art shader** to avoid "shimmering artifacts (inconsistent line widths)"; recommends `pixelRatio: 2/3` and integer scale factors. v0.30 blog: "wait on a [WebGPU] renderer implementation until the standardization of the API to stabilize". Official blog post on the dual-grid autotiling technique (Justin Young, 2025-08-24).
- **Godot web**: 4.7 docs: "Godot 4 can only target WebGL 2.0 (using the Compatibility rendering method). Forward+/Mobile are not supported on the web platform." Single-thread default (4.3+); threads need `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`; Safari WebGL2 caveats; no headless web story. 4.5 added WASM SIMD.
- **Bevy wasm** (cheatbook): "WebAssembly runs slower than native code and currently lacks multithreading support"; binary-size optimisation "crucial"; not all plugins work on wasm.
- **Canvas2D**: pixel-agents (9,479★, MIT, v1.4.1 2026-08-15) renders its whole office with Canvas 2D ("pixel-perfect at integer zoom levels" per the agentroom fork), React 19 + Vite + Fastify; grid capped at 64×64 tiles. Works for ~dozens of sprites; no batching, no GPU filters/lighting.
- **OffscreenCanvas + Worker**: caniuse 95.99 % global (Chrome 69+, Firefox 105+, Safari 17+). PixiJS supports it via `DOMAdapter.set(WebWorkerAdapter)` ("`app.canvas` returns an `OffscreenCanvas`"); `DedicatedWorkerGlobalScope.requestAnimationFrame` exists (MDN). Caveats: pointer events must be forwarded manually; HTMLText/DOMContainer unavailable in a worker. Verdict: keep rendering on the main thread (cheap when the scene is batched) and put the *simulation* in a worker/server instead.
- **WebGPU availability** (caniuse, 2026): Chrome/Edge 113+, Safari iOS 26+, Safari macOS 26 "partial", **Firefox disabled by default (157–160)**; 87.35 % global. ⇒ WebGL2 must remain the primary tested path; WebGPU is an opportunistic upgrade.

### 2.2 How munder-difflin renders (read from the repo)

- Repo: `chaitanyagiri/munder-difflin`, **8,259★**, MIT, created 2026-05-31, latest release v0.5.5 (2026-10-01), 1,314+ commits. Stack: Electron + electron-vite + React 18 + **pixi.js ^8.5.1** + zustand 4 + xterm + node-pty + better-sqlite3 (`package.json`).
- Office code lives in `src/renderer/src/scene/office/` (18 files): `OfficeFloor.tsx` (Pixi app + React bridge), `Camera.ts`, `Character.ts`, `CharacterSprite.ts`, `SpriteAdapter.ts`, `SeatPool.ts`, `pathfinding.ts` (A*), `TiledMapRenderer.ts`, `MessageEnvelope.ts`, `ThoughtBubble.ts`, `ToolBubble.ts`, `DeskScreen.ts`, `cafeteriaLines.ts`, `cast.ts`, `portraitArt.ts`, `glRecovery.ts`, `themeLoader.ts`, `themeRegistry.ts`.
- `OfficeFloor.tsx`: `app.init({ antialias: false, roundPixels: true, resolution: Math.max(devicePixelRatio || 1, 2), autoDensity: true })`; tileset textures `tex.source.scaleMode = 'nearest'`; **state via `useStore.subscribe(...)`, not React re-renders**; characters read `useStore.getState()` directly; `app.ticker.add(onTick)` drives animation, cafeteria logic, coffee runs, envelope flight arcs, bubble overlap resolution; ticker stopped on `visibilitychange`/hidden panel; `ResizeObserver → renderer.resize`; `zIndex = (tileY + 1) * tileSize` for depth; thought bubbles counter-scaled by camera zoom; WebGL context-loss recovery rebuilds the scene.
- `Camera.ts`: non-integer zoom clamped to [fit, 4×], `LERP_SPEED = 0.08` per frame on position and zoom, clamped to map bounds, `nudgeToward()` decaying pan; **no pixel snapping, no DPR handling** (a source of the subtle shimmer you'd want to avoid).
- `TiledMapRenderer.ts`: **one Sprite per tile**, layers `floor | walls | furniture-below | furniture-above`, characters above all tile layers; walkability from a Tiled collision object layer with seats forced walkable; spawn points/zones from object layers; flip flags handled; no animated tiles; maps are hand-made `.tmj` (`office.tmj`, `brooklyn99.tmj`).
- Assets: LimeZu Modern Interiors (paid "Complete Version" licence) committed as `interiors.png`, `office-tileset.png`, `a5-office-floors-walls.png` with `ATTRIBUTION.md` ("Credits are required, linking to https://limezu.itch.io/. This obligation is live."); characters are **procedurally generated** in `portraitArt.ts` ("previous walk sheets derived from LimeZu's work were deleted once replaced") — i.e. they moved off LimeZu characters, presumably for licensing/customisation reasons.
- Lessons: subscribe-don't-render, ticker pause on hidden, context-loss recovery and themeable tilesets are right; hand-made Tiled maps, no sim/render separation (sim logic runs inside the Pixi ticker in the renderer process), non-integer zoom without snapping, and vendoring paid assets are the things to do differently.

### 2.3 Pixel-perfect rendering details

Settings (PixiJS v8, maintainer answer in discussion #11018 and v8 migration guide):
- `TextureStyle.defaultOptions.scaleMode = 'nearest'` **before any texture is created** (or per texture `texture.source.scaleMode = 'nearest'`); `SCALE_MODES.NEAREST` → `'nearest'` string in v8.
- `Application.init({ antialias: false, roundPixels: true, resolution: window.devicePixelRatio, autoDensity: true, preference: 'webgpu' /* falls back */ })`.
- CSS `image-rendering: pixelated` only matters if the canvas is CSS-scaled; prefer rendering at device resolution.
- Avoid mipmaps on pixel atlases; extrude/pad atlas frames (AssetPack / free-tex-packer support padding/extrude) to prevent bleeding.

Integer zoom and DPR (derived from Unity Pixel-Perfect-Camera and Godot "multiple resolutions" docs, both authoritative on the technique):
- Choose zoom levels as **integers in device pixels** `k ∈ {1,2,3,4,6,8}`. With `resolution = DPR`, world container scale `s = k / DPR` (e.g. DPR 2 on a MacBook Pro: s ∈ {0.5, 1, 1.5, 2, 3, 4} ⇒ 1,2,3,4,6,8 device px per texel). Default for a 16-px tileset on a 14" M4 (DPR 2, 3024×1964): k = 4 (tile = 64 device px ≈ 32 CSS px) or k = 6.
- Snap the camera translation so the world origin lands on an integer *device* pixel: `x_css = Math.round(x_target_css * DPR) / DPR`. Godot: "when set to integer, the value is rounded down to the nearest integer" to avoid "distorted checkerboards and inconsistent line widths".
- Smooth camera: run lerp/critically-damped spring on the **unsnapped** target every frame (`t = 1 − exp(−λ·dt)` so it is frame-rate independent at 60/120 Hz), snap only the value you write to the container. Zoom gestures: animate the *target* k between integers; during the transition either (a) accept a brief fractional scale (shimmer for ≤200 ms) or (b) render the world into a RenderTexture at native resolution and upscale that one sprite — Unity's "Upscale Render Texture" produces "unaliased and unrotated pixels" at the cost of an extra pass. Option (b) also removes all per-sprite sub-pixel jitter (sprites move in whole texels; the final image can still be panned fractionally, which only shows as a ≤1/k-pixel softening of the whole frame).
- Shimmer during motion: Unity "Pixel Snapping" snaps renderers to the texel grid at render time "while preserving transform values" — do the same: keep float sim positions, round `sprite.x/y` to texels on write.
- Non-integer zoom with sharp texels (if the owner insists on continuous pinch-zoom): Phaser 4 `smoothPixelArt` and Excalibur's `pixelArt` sub-pixel shader implement the "antialiased pixel-art sampling" trick; in Pixi it is a ~20-line custom fragment shader/filter (not built in) **(unverified that an off-the-shelf Pixi filter exists)**.
- 120 Hz: MDN — rAF matches display refresh (60/75/120/144 Hz) and **"callbacks are paused in background tabs and hidden iframes"**; always use the timestamp/`ticker.deltaMS`. Chrome has no cap. Safari ≥ 26.3 (Dec 2025) exposes "Prefer Page Rendering Updates near 60fps" as a feature flag that is **on by default** (users must turn it off). WKWebView (Tauri) is capped at 60 fps on macOS 13–15; **"Apple removed the 60fps cap entirely in macOS 26"** (tauri-plugin-macos-fps README; the plugin uses a private API and is "not App Store safe"). Electron/Chromium is uncapped.

Atlases, animation, text, depth, lighting, particles, accessibility:
- **Atlases**: Pixi spritesheet JSON = TexturePacker "hash" format (`frames`, `animations`, `meta.image/scale`, `linkedSheets` for multi-pack; anchors/9-slice only from TexturePacker). Tools: `@assetpack/core` 1.7.0 (2025-11-07, MIT; texture packing, compression, manifest, MSDF fonts; Vite integration) and `free-tex-packer-core` 0.3.9 (2026-07-24, MIT). Aseprite exports the same JSON (Hash/Array) with frame tags — Aseprite's own doc page is thin; this compatibility is **(lightly verified)** — pixel-agents/munder-difflin pipelines use it in practice. `ase-parser` 0.0.19 (2026-09-04) can read `.aseprite` directly in Node for a build step. Aseprite 1.3.18.6 (2026-09-22), EULA/source-available (compile-yourself allowed for personal use per README; binaries not redistributable) **(partially verified)**.
- **Animation**: `AnimatedSprite` from `sheet.animations[name]`; drive frame index from sim state (walk/sit/idle/talk/carry) so animation is deterministic and resumable from a snapshot.
- **Depth / y-sorting**: `container.sortableChildren = true` + `zIndex = feetY`; docs warn "sorting can be expensive for large numbers of children" — fine for a few hundred entities; use **`RenderLayer`** (v8.6+) to y-sort characters and furniture together while keeping logical hierarchy, and bucket static furniture into `below`/`above` layers as munder-difflin does.
- **Static layers**: `container.cacheAsTexture()` (replaces v7 `cacheAsBitmap`) for floor/wall chunks; `isRenderGroup = true` for the world vs HUD split ("the majority of the time you won't need to use them"); `CullerPlugin` (`extensions.add(CullerPlugin)`, `cullable`, `cullArea`) for large floors.
- **Lighting / day-night**: `@pixi/lights` is **v7-only** (peer `@pixi/core ^7`, last release 4.1.0 on 2023-07-12) — dead for v8. Use: global ambient tint (ColorMatrix/`pixi-filters` `AdjustmentFilter`, 6.1.5, v8-compatible) + a "lightmap" RenderTexture (dark overlay, additive light sprites for lamps/monitors, multiply onto the scene). Phaser 4 has built-in normal-map lighting if ever needed. Keep to ≤1 full-screen pass for weak GPUs.
- **Particles**: Pixi v8 **`ParticleContainer`** (built in; position/scale/rotation/tint/alpha/texture; declare dynamic vs static props; "hundreds of thousands" claimed; API marked experimental). `@pixi/particle-emitter` 5.0.10 is **not v8-compatible** (peer deps `<8.0.0`) — write a ~100-line emitter for coffee steam/envelope sparkle.
- **Text**: `BitmapText` from `.fnt/.xml` (AngelCode) or MSDF generated by AssetPack ("tens of thousands of text objects"); limits: resolution fixed at creation, CJK/emoji impractical ⇒ use `Text`/`HTMLText` for employee names in arbitrary scripts. `DOMContainer` (experimental; WebGL/WebGPU only) positions real DOM elements in the scene — ideal for rich speech bubbles, inputs and screen-reader text. Counter-scale bubbles by `1/zoom` for legibility. Pixel fonts to evaluate: Press Start 2P (OFL), m5x7 / m6x11 (Daniel Linssen) — **licenses unverified here**.
- **Accessibility**: `import 'pixi.js/accessibility'`; set `accessible = true`, `accessibleTitle`, `accessibleHint`, `tabIndex` on employees/desks → Pixi creates DOM `<div>` overlays aligned to bounds, activates on Tab (default since 8.22), screen readers announce titles; options `enabledByDefault`, `activateOnTab`, `deactivateOnMouseMove`, `debug`. Add a mirrored DOM employee list in the React shell as the primary a11y path.
- **Phaser 4's equivalents** (for comparison): `TilemapGPULayer`, `smoothPixelArt`, `vertexRoundMode`, built-in lights, Spine renderer/Mesh2D in 4.2.

### 2.4 Tilemaps and autotiling

- **Tiled 1.12.2** (2026-05-27; 12,935★; app GPL-2.0+, libtiled BSD; exported JSON is unencumbered). 1.12 (2026-03-13) rewrote the Properties view, list-valued properties, Oblique orientation, layer blend modes. JSON tileset schema includes `wangsets[] { name, type: 'corner'|'edge'|'mixed', colors[], wangtiles[] { tileid, wangid: [8 colour indexes] } }`, per-tile `objectgroup` collision shapes, `animation[] { tileid, duration }`, `properties`. Docs: a 2-terrain **corner set needs 16 tiles**, an **edge set 16 tiles**, a full mixed set 256 (or the 47-tile "blob" subset). Tiled also runs the terrain brush at edit time, which lets an artist validate a tileset's wang IDs before we consume them.
- **LDtk**: last release v1.5.3 **2024-01-15** (repo pushed 2026-07-12, 4,291★, MIT). Auto-layers are rule-based and **editor-only**; export bakes `autoLayerTiles`; no official JS/TS runtime rule engine. Trendy and pleasant, but useless when maps are generated at runtime.
- **Autotiling techniques** (BorisTheBrave 2023 quarter-tile article, Excalibur dual-grid post 2025-08-24, Red Blob-inspired 2026 interactive guide, Tiled docs):
  - 4-bit cardinal bitmask → 16 tiles: simplest; "awkward corners"; ideal for **1-tile-thick walls, fences, pipes** (edge set).
  - 8-bit blob → 47 tiles with the "diagonal only counts if both cardinals present" rule: best inner/outer corners; most art.
  - **Dual-grid / quarter-tile** → display grid offset by half a tile, each display tile determined by 4 data cells ⇒ 16 cases from **5 (rotatable) or 14–20 (unrotated) art tiles**; "composable overlays (T-junctions, crosses, islands all just work)"; limitation: no curves larger than half a tile, "artificial look" with low variation, multi-material needs priority/stacking.
  - Wang tiles: edge-colour matching for aperiodic variety (carpet patterns).
  - Practical: cache bitmasks, recompute only dirty cells; assign terrain priorities.
- **Walls, Prison-Architect style**: PA uses material sprites with "SpriteType AlignedArea / NumSprites" variants chosen by neighbours (fandom/Steam materials guides) — i.e. edge-bitmask autotiling with 1-tile-thick walls. Model walls as an **edge wang set (16 tiles)** per wall material + door/window variants keyed by orientation (H/V from neighbour mask); doors are objects occupying a wall cell with open/closed frames; wall tops drawn in a layer above characters' feet but below their heads (split wall sprite into base/cap or y-sort by cell).
- **Furniture as multi-tile objects**: pixel-agents' `docs/external-assets.md` manifest is a good concrete schema: `footprintW/footprintH` in 16-px tiles, sprite px size, `backgroundTiles` (floor rows shown below tall sprites), `canPlaceOnWalls`, `canPlaceOnSurfaces`, `type: 'asset' | 'group'` with rotation schemes `2-way | 3-way-mirror | 4-way`. Add for our sim: `occupancy` mask (which footprint cells block), `interactionTiles` (chair cell for desk, standing cell for coffee machine/printer/whiteboard, seats around meeting tables, cubicle for toilets), `facing`, `renderSplit: 'below' | 'above' | 'ysort'`, `capacity`, `needs` served (coffee, bladder, social, fresh air) — matching the Sims-style needs model.
- **Rendering tiles in Pixi**: `@pixi/tilemap` 5.0.2 (2025-07-14, peer `pixi.js >= 8.5.0`, 19 KB/6 KB; `CompositeTilemap`, `tile()`; 16-bit index limit ⇒ 16k tiles unless `use32bitIndex`; WebGL + WebGPU demos). For an office floor of ~64×48 = 3k cells, sprite-per-tile + `cacheAsTexture()` per chunk is adequate; `@pixi/tilemap` becomes worthwhile for bigger floors or live re-tiling. Procedural generation: generate rooms/corridors from a seed → rasterise materials into the data grid → run autotilers → emit tile instructions; keep the data grid as the single truth shared with the headless sim (walkability, occupancy).

### 2.5 Assets and licensing

| Pack | Price | License (as read 2026-10-02) | Contents relevant to us | Fit / risk |
|---|---|---|---|---|
| **LimeZu — Modern Interiors** (`limezu.itch.io/moderninteriors`) | free tier (non-commercial) / **≥ $1.50** full | Full: "Edit and use the asset in any commercial or non commercial project"; **"CAN'T resell or distribute the asset to others"**; credit required (link to limezu.itch.io); "no generative AI used". In comments LimeZu says the listing's licence is "CC-BY, not CC-BY-SA … the only thing is to credit me somewhere" — this **contradicts the no-distribution clause** on the page. | Thousands of furniture sprites, 2D/3D walls, 100+ animated objects; characters: 100+ outfits, 200 hairstyles, 80 accessories, 9 skins; animations idle/run/gift/shoot/punch/pick-up/read/lift/throw; Character Generator Tool 2.0 (Windows/Linux); 16/32/48 px; updated ~Sep 2026 | The de-facto look of every "AI office" (SkyOffice, munder-difflin, agentroom, the-office). **Committing to a public repo = distribution** ⇒ ask LimeZu in writing; otherwise ship only in binaries / fetch-at-build. |
| **LimeZu — Modern Office Revamped** | $5 (50 % sale $2.50) | same terms; "buying it for 1.95$ gives you the license", "recolor and edit … for any commercial purpose except the resell" | 300+ office sprites, floors/walls, shadows, 16/32/48 px; v1.2 (2020-12-21) | Compatible with Modern Interiors; same distribution problem. |
| **Kenney — Roguelike Indoors / Roguelike Modern City (1,036 tiles) / Tiny Town (130 tiles, 16×16, 2023)** | free | **CC0** | 16-px furniture/interiors/city; 2015 era style | Zero-risk prototype tiles; style is simpler/flatter than LimeZu. |
| **2dPig — Pixel Office Asset Pack** | NYOP | **CC0** ("no attribution required but appreciated"); no AI | 5 human characters, 2 animals, office furniture/computers/plants; PNG + Aseprite; **not a tileset** | Prototype characters/props. |
| **TileSmith — Retro Office Interiors "AI-Ready"** | ≥ $1 | commercial OK, modify OK, no resale as-is, attribution appreciated; **AI-assisted** | 12,847 16-px tiles, 4 sheets | User comments report artifacts/overlapping tiles; low quality — skip. |
| **OGA — Pixel Art Lab/Office Tiles** (The Leafy Lemur, 2022) | free | CC-BY 3.0 | 32×32 top-down lab/office | Scale mismatch with 16 px; attribution OK. |
| **OGA — Office Space Tileset / CC0 Furniture** | free | CC0 (per listing) | side-scroller office / generic furniture | marginal. |
| **Donarg — Office Interior Tileset (16x16)** | $2 | **(unverified — page not fetched)** | top-down office interior; credited by pixel-agents docs | Cheap option to evaluate. |
| **JIK-A-4 — MetroCity Free Top-Down Character / Interior packs** | free | **(unverified — pack page 404 on guessed URL)**; used by pixel-agents and agentroom | top-down characters | Evaluate license text before use. |
| **Sunnyside World** (Daniel Diggle) | NYOP | commercial OK; no repackaging/resale "no matter how much modified"; no AI training; no NFTs; attribution optional | 16-px farming tileset, 20 character actions, 7 hairstyles, emotes; **left/right-only facing** | Not 4-directional; wrong theme. |
| **Mana Seed Character Base** (Seliel) | $19.98 (free demo) | one product per purchase; no redistribution; **"may NOT use … in a project alongside 'AI' generated imagery, writing, code, or anything else"**; no web3 | 64×64 cells, 4-dir, walk/run/jump, sit/sleep/drink idle, paper-doll layers | **Incompatible** with an AI-agent product whose code is written by agents. |
| **LPC Universal Spritesheet Generator** | free | per-asset CC0 / CC-BY 4.0 / OGA-BY / **CC-BY-SA 4.0 / GPL 3.0** (share-alike on derivative art; CC-BY-SA DRM caveat for App Stores); credits CSV must ship; code repo GPL-3.0 | 64×64, 4-dir walk/slash/thrust/shoot/hurt/spellcast + bow/climb/run/jump expansions (sit/idle **unverified**) | Scale/style mismatch with 16-px office; share-alike contaminates our art; reject. |
| **PixelLab** | ~$12 / $24 / $50 per month tiers (secondary sources; pricing page did not render) | ToS (last updated **2025-11-23**): "You retain ownership of any content you create using PixelLab"; commercial OK; may not train models on outputs; Open RAIL-M use restrictions apply | text→character, **4/8-direction rotation**, skeleton animation, tilesets (top-down), inpainting, Aseprite plugin, API | Best route to an **owned, consistent** character base + tileset. |
| **Retro Diffusion** | Aseprite extension **$65 one-time** (Lite $20); web credits from $5 (~$0.015/img) | "you own the images generated"; commercial OK; model "trained on licensed assets from Astropulse and other pixel artists with their consent"; extension updates "slowed substantially" (focus on a native editor) | true grid-aligned pixel art 16–384 px, tilesets, palette control | Good complement for tiles/props. |
| **Scenario** | $15 / $45 / $75 per month; free 50 credits/day | "What you create is yours"; no cross-customer training | custom LoRA on 5–100 refs for style consistency; not pixel-specialised | Optional for style-locking. |

Character requirements vs. sources: we need 4-direction walk, sit (facing desk), idle, talk, carry-envelope, emote bubbles, plus layered body/hair/outfit/accessory with palette swaps. Only LimeZu's generator and a self-generated base satisfy this at 16-px scale; LimeZu is license-constrained, hence **own base**.

Precedent repos and their asset handling: munder-difflin (LimeZu tiles committed + `ATTRIBUTION.md`, characters procedural), SkyOffice (1.3k★, MIT, Phaser 3 + Colyseus; credits "pixel artist – LimeZu", assets in repo), the-office (ISC; LimeZu sheets; no attribution statement), agentroom (SkyOffice tiles + MetroCity characters), paulrobello/claude-office (custom pixel art, origin undocumented), alminisl/agent-office and esteladiaz/agent-keep (**procedural sprites drawn in code, no image assets**), clawboard (programmatically generated sprites).

### 2.6 Integration and performance

- **Framework bindings** (npm): `@pixi/react` 8.0.5 (2025-12-01; React ≥19, pixi ≥8.2.6; `extend()`, `<pixiContainer>` JSX, `useTick`, `useApplication`; 2,885★; 128 KB/40 KB; caveat: non-memoised `useTick` callbacks re-register each render). `vue3-pixi` 1.0.2 (2026-07-23; **peer pins `pixi.js` 8.14.3 exactly** — fragile). `svelte-pixi` 8.0.1 (2025-12-22; Svelte 5; pixi ^8.6.5). `solid-pixi` 1.0.0 (2024-11-26; stale). Verdict: bindings are fine for small UI scenes; for a 60–120 fps world with hundreds of mutable sprites, use **imperative Pixi behind one component** and drive it from store subscriptions (paulrobello: "per-frame agent writes batched into one store update per tick (header/sidebar/modals stop re-rendering at 60fps during movement)"; munder-difflin: `useStore.subscribe`).
- **Stores** (framework-agnostic, npm 2026): zustand 5.0.15 (1 KB), nanostores 1.5.4 (5 KB, React/Vue/Svelte adapters), @tanstack/store 0.11.2, xstate 5.33.2 / @xstate/store 4.2.3 (statecharts for employee behaviour), ECS: koota 0.6.6 (pmndrs, 37 KB), bitecs 0.4.0 (MPL-2.0, 16 KB).
- **Loop**: Pixi `Ticker` (rAF-based; `app.stop()/start()` "useful for … performance throttling on inactive tabs"). Sim: Gaffer "Fix Your Timestep" — accumulator, fixed `dt`, cap frame time (0.25 s) to avoid the spiral of death, render with `alpha = acc/dt` interpolation between previous/current states. Suggested: logic tick 10 Hz (needs, decisions, delegation), movement tick 30–60 Hz, render at display rate with interpolation; all seeded (`seed → floor layout, personalities, RNG streams`) so phone and desktop agree.
- **Headless**: keep the sim free of Pixi/DOM (`core/` package with no DOM types). It runs in a `Worker` (desktop), in Bun 1.4 / Node on the server (phone client, CI), and in Vitest. `@pixi/node` 8.0.0 (2026-04-19; peer pixi ^8.18.1; uses `gl` + `canvas`) exists for optional server-side thumbnails/snapshot tests but is a 49★ userland package — do not depend on it for correctness. Note: Chrome throttles background-tab timers (≈1 Hz, "intensive" after 5 min) — **(unverified here)** — so a Worker sim in a hidden tab also slows; the server/Tauri-side sim is the robust path.
- **Resize/DPR**: `ResizeObserver` → `renderer.resize(w, h)`; listen to `matchMedia('(resolution: …dppx)')` changes when windows move between displays; recompute integer zoom table.
- **GPU budget** (Pixi performance tips): sprites batch up to 16 textures per draw; keep atlases ≤ 2048²; avoid per-frame `Text` changes (use BitmapText); rectangle masks are cheapest; filters break batches and need `filterArea`; `cullable` only when GPU-bound; `eventMode`/`hitArea` to limit hit-testing. Target: < 20 draw calls per frame; texture memory < 32 MB.
- **Tauri 2** (`@tauri-apps/api` 2.12.1, 2026-09-30; 3.0.0-alpha.4 tagged 2026-10-01): WKWebView on macOS; 120 Hz by default on macOS 26 (plugin needed on 13–15, private API). **WebGPU inside WKWebView on macOS 26 is unverified** — Safari 26 ships WebGPU on macOS/iOS/iPadOS/visionOS (WebKit blog, 2025-06-09) but the post does not state WKWebView; test early, keep WebGL2 as the baseline. Electron 44.5.1 (Chromium) is the easy path for WebGPU + 120 Hz but heavier.
- **Testing**: Playwright 1.63.0 `toHaveScreenshot()` on the canvas with a frozen ticker, fixed seed/time, `deviceScaleFactor` pinned, masks for dynamic text; Vitest 5.0.3 browser mode (`@vitest/browser-playwright`) for scene-graph assertions; asgaardlab's "canvas-visual-bugs-testbed" (PixiJS snapshot = screenshot + scene graph) is a 2022–2024 research tool (10★) — reference only. `@pixi/devtools` 2.0.1 (Chrome extension, pixi ^7||^8) for live scene inspection.
- **AI-assisted development**: `pixijs-skills` (344★, created 2026-04-01, pushed 2026-10-01): 25 skills incl. `pixijs-performance`, `pixijs-scene-particle-container`, `pixijs-environments`, `pixijs-accessibility`, `pixijs-migration-v8`; install `npx skills add https://github.com/pixijs/pixijs-skills` (Claude Code, Cursor, Copilot, Codex, Windsurf…).

### 2.7 Floor switching UX and the 2026 "AI office" landscape

Game references (verified where noted):
- **Dwarf Fortress z-levels**: switch with mouse wheel or keys (`e`/`c`), two elevation indicators (absolute and relative-to-surface); gravity/physics respect levels (DF wiki). UX lesson: always show "which floor am I on" and "where is the surface/ground floor".
- **Prison Architect (1)** was single-floor; **Prison Architect 2** moved to 3D multi-floor cell blocks with a crawlspace/ceiling utility layer and catwalks (Paradox feature highlight). Lesson: multi-floor only pays off when each floor is meaningfully different — for us, floor = project, which it is.
- **Office Simulator: BE A BOSS! v2.0** (itch, HTML5): 5 floors, employees ride **visible elevators** between floors, day/night ambient lighting with "office lights automatically flick on" — exactly our vibe at indie scale.
- **SimTower** (side view) is the canonical elevator-management reference; **Project Hospital / Two Point Hospital / Theme Hospital / Game Dev Tycoon / Startup Company**: not verified in this session (search budget exhausted) — from memory: Project Hospital has multi-floor with a floor selector; Two Point Hospital uses single-level plots with separate buildings; Game Dev Tycoon relocates to bigger offices rather than floors **(unverified)**.
- **paulrobello/claude-office** implements a "multi-story building with independent offices per floor, breadcrumb navigation, and automatic session switching", a scrollable **building cross-section view** reachable from the header, floors per session, Zustand split into 9 slices, Pixi + Next.js. This is the closest existing implementation of "one floor per project".

AI-office visualizers on GitHub (stars from the GitHub API, 2026-10-02):

| Repo | ★ | Engine | What they got right | What to avoid |
|---|---|---|---|---|
| pixel-agents-hq/pixel-agents (v1.4.1, 2026-08-15) | 9,479 | Canvas 2D, React 19, Fastify | hooks-first detection with transcript fallback; agent-agnostic `HookProvider`; external asset manifests with footprints/rotations; privacy (localhost) | 64×64 grid cap; Canvas 2D ceiling (no batching/lighting); no headless/phone story |
| chaitanyagiri/munder-difflin (v0.5.5, 2026-10-01) | 8,259 | PixiJS 8 + React 18 + Electron | subscribe-not-render; ticker pause when hidden; GL context-loss recovery; theme registry; envelopes/thought bubbles/cafeteria lines; procedural characters | sim inside the renderer ticker; hand-made Tiled maps; non-integer lerp zoom without snapping; paid LimeZu tiles committed |
| paulrobello/claude-office (v0.24.1, 2026-07) | 538 | PixiJS + Next.js + Zustand + FastAPI | multi-floor building + cross-section + breadcrumbs; batched per-tick store writes; pluggable summary backends | Python backend split; assets undocumented |
| W17ant/Claude-Office | 180 | custom isometric | random office events (pizza, fire drill, printer jam) add life | isometric = more art per object; DALL-E sprite workflow |
| liuyixin-louis/agentroom | 46 | Canvas 2D + Tauri v2 + React 18 | per-project offices with persistent layouts; integer-zoom pixel-perfect | LimeZu-derived SkyOffice tiles |
| kirillkuzin/clawboard, monkeystar0/pixel-claw, neomatrix25/pixel-office-openclaw, lacedupairs-code/pixel-office, SweetSophia/… | ≤ 6 | Pixi 8 / Canvas 2D forks | programmatic sprites (no license risk) | all tiny forks of pixel-agents |
| alminisl/agent-office, esteladiaz/agent-keep | 4 / 0 | procedural canvas, zero deps | needs/energy model drives breaks ("energy drains while working and refills on breaks") | no image assets = limited charm |

Common gaps none of them fill (our opportunity): seeded procedural floors, true sim/render separation with a headless state stream, floor-per-project with transitions, Sims-style needs/moods as first-class state, pixel-perfect integer zoom camera, licensed-for-redistribution art.

---

## 3. Ranked recommendations and risks

### 3.1 Engine ranking

1. **PixiJS 8.22 — recommended.** Reasons: renderer-only (keeps sim engine-free/headless), WebGPU→WebGL2→Canvas with lazy backend chunks, TS 5/6/7, tree-shakeable, monthly releases, 48k★/500k weekly downloads, complete pixel-art knobs, `RenderLayer`/`ParticleContainer`/`DOMContainer`/accessibility built in, official AI skills, proven by the two biggest projects in this exact niche. Risks: `pixi-viewport` 6.0.3 is stale (2024-11-27) → write our own camera (~200 LOC, which we want anyway for integer snapping); `@pixi/lights` and `@pixi/particle-emitter` are v7-only → small custom code; Canvas backend is experimental (fallback only); Pixi has no "smooth pixel art" shader built in (write a filter if continuous zoom is required).
2. **Phaser 4.2** — strong second if the owner prefers batteries-included (`TilemapGPULayer`, lighting, `smoothPixelArt`, Spine). Risks: owns the loop/scenes (awkward with React/Vue shells and a worker/server sim), JS codebase with d.ts, not tree-shakeable (347 KB gzip), Canvas deprecated, no WebGPU, 4.x is 6 months old (API churn: `getPadding→getPaddingCeil`, ESM default export only fixed in 4.1).
3. **Excalibur 0.32/0.33-alpha** — nicest TS API and first-class `pixelArt` mode + dual-grid blog, but pre-1.0 for 12 years, 2.3k★, small ecosystem, engine-owned loop.
4. **Plain Canvas 2D** — viable for a minimal first prototype (pixel-agents proves it), but no batching/filters/lighting and a hard ceiling; Pixi's canvas backend gives the same fallback for free.
5. **melonJS 20.7** — has a full WebGPU renderer and zero deps, but is a framework, JS-based, small community.

### 3.2 Rendering architecture (text diagram)

```
┌───────────────────────────── core (engine-free TS, no DOM types) ─────────────────────────────┐
│ seed ──► FloorGenerator (rooms/corridors/zones) ──► DataGrid (material, wall, occupancy, nav)  │
│ Employees{needs, mood, habits, task, target} ◄── Scheduler/Behaviour (xstate or custom FSM)    │
│ fixed-step loop: logic 10 Hz │ movement 30–60 Hz │ A* on nav grid │ events (envelope, chat…)  │
│ output: Snapshot {tick, employees[], objects[], events[]}  (JSON-serialisable, deterministic)   │
└──────────────┬─────────────────────────────┬──────────────────────────────┬───────────────────┘
               │ in-process / Worker         │ Bun/Node server (headless)   │ Vitest (headless)
               ▼                             ▼                              
┌──────── store (zustand/nanostores) ────────┐   WebSocket ──► phone client (DOM list or lite canvas)
│ last two snapshots + ui state (floor, sel) │
└──────────────┬─────────────────────────────┘
               │ subscribe() (no React re-render per frame)
               ▼
┌──────────────────────── render adapter (PixiJS 8, one <OfficeCanvas/>) ───────────────────────┐
│ Application{preference:'webgpu'→webgl→canvas, antialias:false, roundPixels, resolution:DPR}   │
│ world (RenderGroup, scale = k/DPR, pos snapped to device px)                                   │
│   ├─ floor/wall chunks: autotiled sprites or @pixi/tilemap, cacheAsTexture()                   │
│   ├─ furniture-below                                                                           │
│   ├─ RenderLayer ysort: characters + furniture-ysort (zIndex = feetY), interpolate(alpha)      │
│   ├─ furniture-above / wall caps                                                               │
│   ├─ lightmap RenderTexture (ambient tint × additive lamps/monitors) — day/night               │
│   └─ ParticleContainer (steam, sparkles)                                                       │
│ hud (RenderGroup, unscaled): BitmapText labels, bubbles (DOMContainer or sprites), selection   │
│ accessibility overlay (pixi.js/accessibility) + React DOM mirror list                          │
│ camera: spring/lerp on unsnapped target → integer zoom table → snap at write                   │
│ ticker: app.stop() on visibilitychange; ResizeObserver → renderer.resize                       │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
               ▲
┌──────────── React 19 / Vue 3 shell ───────────┐
│ floor selector, employee detail/transcript, model/effort, minimap (reads store) │
└────────────────────────────────────────────────┘
```

### 3.3 Pixel-perfect camera spec (concrete)

- Zoom table in device pixels `K = [1,2,3,4,6,8]`; default `k = clamp(round(DPR*2))` → 4 on Retina.
- World scale `s = k / DPR`; camera target `(cx, cy)` in world px (float); written position `x = Math.round((−cx*s + viewW/2) * DPR) / DPR`.
- Smoothing: `λ = 12 s⁻¹` (`t = 1 − e^(−λ·dt)`), same for zoom (animate `s` toward `k_target/DPR`; while |s − k/DPR| > ε optionally render the world via RenderTexture at native res and scale that sprite).
- Sprite positions: write `Math.round(worldX)`, `Math.round(worldY)`; interpolate between snapshots *before* rounding.
- Follow-employee: spring toward feet position; floor switch: slide/crossfade 250 ms ease-out-cubic; elevator/stairs tiles are transit cells (employee enters → leaves floor A → arrives floor B after travel ticks).
- Minimap: 1 px per tile RenderTexture per floor (update on layout change), employee dots from store.

### 3.4 Asset plan (license-safe for a public repo)

1. **Week 0–2 (prototype, CC0 only)**: Kenney Roguelike Indoors + Roguelike Modern City + Tiny Town (CC0) for tiles/props; 2dPig Pixel Office (CC0) characters; placeholder 16-px walls drawn in Aseprite. Commit freely.
2. **Own tileset (target look: LimeZu-like 16 px, "crisp and cozy")**: generate base tiles/props with PixelLab (top-down tileset + inpainting) and Retro Diffusion; clean by hand in Aseprite; define Tiled wang sets (floor corner sets, wall edge sets) and furniture manifests; export via AssetPack. License the resulting art **CC0** (or CC-BY-4.0 if the owner wants credit) in `assets/LICENSE` so forks and the future source-available repo are clean.
3. **Own layered character base**: PixelLab character + 4-direction rotation + skeleton animation for walk/idle/sit/talk/carry/wave; split into body/hair/top/bottom/shoes/accessory layers; 6–9 skin tones, hue-shiftable hair/outfit palettes (runtime palette swap via small LUT shader or pre-baked variants); emote bubble sheet (!, ?, ☕, 💤, ✉, ❤, ⚡) drawn by hand.
4. **Optional premium theme**: buy LimeZu Modern Interiors + Modern Office; keep the files out of the public repo (private submodule / fetched at build from the buyer's own download) **unless LimeZu confirms** that redistribution inside an open-source repo is allowed; show credits in-app and README regardless.
5. Record everything in `ASSETS.md` (pack, author, license, URL, modifications) — munder-difflin's `ATTRIBUTION.md` is a good template.
6. Never mix in Mana Seed (AI clause) or LPC/CC-BY-SA art (share-alike) into the owned set.

### 3.5 Concrete libraries (versions verified on npm 2026-10-01/02)

Core: `pixi.js@8.22.0`, `@pixi/tilemap@5.0.2` (optional), `pixi-filters@6.1.5`, `@pixi/ui@2.4.1` (optional, canvas-side UI), `@pixi/layout@3.2.1` + `yoga-layout@3.2.1` (optional), `@assetpack/core@1.7.0` (build), `free-tex-packer-core@0.3.9` (alt), `ase-parser@0.0.19` (build), `@pixi/devtools@2.0.1` (dev), `@pixi/node@8.0.0` (optional tests), `@pixi/react@8.0.5` (optional overlays only), `pixijs-skills` (agent skills).
Shell/state: `react@19.3.0` (or `vue@3.5.43`, `svelte@5.57.1`, `solid-js@1.9.15`), `zustand@5.0.15` or `nanostores@1.5.4` or `@tanstack/store@0.11.2`; behaviour FSMs `xstate@5.33.2`/`@xstate/store@4.2.3`; ECS option `koota@0.6.6` or `bitecs@0.4.0` (MPL-2.0).
Tooling: `typescript@7.0.2`, `vite@8.3.2`, `vitest@5.0.3`, `playwright@1.63.0`, `@tauri-apps/api@2.12.1` / `electron@44.5.1`, `bun@1.4.x` (server), `ws@8.22.0`.
Desktop tools: Aseprite 1.3.18.6, Tiled 1.12.2, PixelLab (web/Aseprite plugin), Retro Diffusion Aseprite extension 15.0.0.

### 3.6 Key risks

- WebGPU is partial on Safari 26 / disabled in Firefox → ship WebGL2 as the tested baseline; treat WebGPU as a bonus (Pixi falls back automatically).
- WKWebView (Tauri) WebGPU and 120 Hz on macOS < 26 are unverified/limited → run the perf gate on both Tauri and Electron early.
- `pixi-viewport` stale; `@pixi/lights`, `@pixi/particle-emitter`, `pixi-cull` v7-only → ~400 LOC custom camera/lighting/emitter (acceptable, and better for pixel snapping).
- LimeZu license ambiguity (page text vs "CC-BY" comment) → written confirmation or exclusion.
- Pixi `ParticleContainer`, `DOMContainer`, Canvas renderer are "experimental" → pin minor versions, keep usages isolated behind adapters.
- React reconciler per-frame updates are a footgun → enforce "no React state per frame" architecturally (ESLint rule / adapter boundary).

---

## 4. Rejected options (with reasons)

- **Godot 4.7 web export**: WebGL2-only ("does not support WebGPU"), separate wasm runtime not embeddable as a React component, headers/threads complexity, GDScript/C# instead of TS, no shared sim code with the TS server/phone client.
- **Bevy 0.19 wasm**: Rust, single-threaded wasm, large binaries, editor still "experimental"; wrong language for a TS-only maintainer.
- **Three.js r186 / Babylon 9.29**: 3D-first; Babylon 1.7 MB gzip; 2D sprite batching/tilemaps/pixel pipelines are afterthoughts.
- **Rive 2.44**: vector runtime, no nearest-neighbour pixel pipeline; editor proprietary.
- **Kaplay**: v4000 alpha since 2025, breaking alphas; small.
- **melonJS**: capable (WebGPU) but framework-shaped, JS, small community.
- **LDtk** for runtime maps: no release since 2024-01, editor-only rules, we don't hand-author maps.
- **@pixi/react for the world scene**: reconciler overhead/footguns at 120 fps with hundreds of sprites; fine for overlays.
- **pixi-viewport**: stale (6.0.3, 2024-11), no integer-zoom/pixel snapping.
- **Mana Seed** (AI clause), **LPC** (share-alike, 64 px), **TileSmith** (AI artefacts), **Sunnyside** (side-facing only), **@pixi/lights**, **@pixi/particle-emitter**, **pixi-cull**, **@pixi/webworker** (all v7-era).
- **OffscreenCanvas worker rendering as the default**: adds event-forwarding and DOM-text limitations for little gain once the scene is batched; keep as an experiment flag.

---

## 5. Open questions for the owner

1. Continuous (pinch) zoom with "smooth pixel art" AA, or integer-only zoom with eased transitions? (Determines whether we write the AA filter or just the RenderTexture upscale.)
2. Tauri (WKWebView) or Electron (Chromium) for desktop? Electron guarantees WebGPU + 120 Hz today; Tauri is lighter but WebGPU-in-WKWebView and 120 Hz on macOS 13–15 need verification/private APIs.
3. Will the owner contact LimeZu to clarify redistribution in a public repo (and the "CC-BY" comment)? If yes, LimeZu becomes a viable premium theme; if no, we go fully owned art.
4. Budget/time for owned art: PixelLab subscription (~$24/mo) + Retro Diffusion extension ($65) + Aseprite ($20) and ~2–4 weeks of cleanup — acceptable?
5. Target tile size: 16 px (LimeZu/Kenney scale, best for small floors on laptops) or 32 px (more detail, more art, bigger atlases)?
6. Should the headless sim be authoritative on the server (phone and desktop both subscribe) or local-first per desktop with the server as a relay?
7. Which shell: React 19 or Vue 3? (Imperative Pixi works with both; `vue3-pixi` pins an exact Pixi version, so bindings are not a reason to choose.)
8. Floors: strictly one floor per project, or allow a project to span floors (e.g. sub-teams)? This changes elevator semantics and the floor-selector UI.
9. Accessibility bar: screen-reader parity via DOM mirror list only, or also keyboard navigation of employees inside the canvas (Pixi accessibility overlay)?
10. Is a License-compatible "no AI-generated code" art pack ever acceptable (it isn't for Mana Seed) — i.e. confirm the repo will contain agent-written code so we can exclude such packs outright.

---

## 6. Sources

Engines / releases
- https://github.com/pixijs/pixijs/releases — v8.22.0 (2026-10-01), v8.21.0 (2026-09-17), v8.20.x, v8.19.0, v8.18.0 notes
- https://github.com/pixijs/pixijs/releases/tag/v8.21.0 ; https://github.com/pixijs/pixijs/releases/tag/v8.16.0
- https://pixijs.com/blog/june-2026 ; https://pixijs.com/blog/pixi-v8-launches ; https://gamedev.net/news/5795-pixijs-v8210-released/
- https://github.com/pixijs/pixijs/discussions/11018 (pixel-art setup, `TextureStyle.defaultOptions.scaleMode`)
- https://pixijs.com/8.x/guides/migrations/v8 ; https://pixijs.com/8.x/guides/concepts/environments ; https://pixijs.com/8.x/guides/concepts/render-groups ; https://pixijs.com/8.x/guides/concepts/render-layers ; https://pixijs.com/8.x/guides/concepts/performance-tips ; https://pixijs.com/8.x/guides/components/scene-objects/container ; https://pixijs.com/8.x/guides/components/scene-objects/particle-container ; https://pixijs.com/8.x/guides/components/scene-objects/text/bitmap ; https://pixijs.com/8.x/guides/components/accessibility ; https://pixijs.com/8.x/guides/components/application/culler-plugin ; https://pixijs.com/8.x/guides/components/application/ticker-plugin ; https://pixijs.com/8.x/guides/components/assets
- https://pixijs.download/release/docs/assets.Spritesheet.html ; https://pixijs.download/release/docs/scene.DOMContainer.html
- https://github.com/pixijs/pixi-react ; https://pixijs.com/blog/pixi-react-v8-live ; https://react.pixijs.io/getting-started/
- https://github.com/pixijs-userland/pixi-viewport ; https://github.com/pixijs/tilemap ; https://github.com/pixijs/ui ; https://github.com/pixijs/layout ; https://github.com/pixijs/filters ; https://github.com/pixijs/lights ; https://github.com/pixijs/particle-emitter ; https://github.com/pixijs/assetpack ; https://github.com/pixijs/pixijs-skills ; https://github.com/pixijs-userland/node
- https://phaser.io/news/2026/04/phaser-4-1-0-salusa-release ; https://phaser.io/news/2026/04/phaser-4-renderer-faster-cleaner-and-built-for-modern-games ; https://phaser.io/news/2026/05/phaser-3-vs-phaser-4 ; https://github.com/phaserjs/phaser/blob/master/changelog/v4/4.0/CHANGELOG-v4.0.0.md ; https://gamefromscratch.com/phaser-4-released/ ; https://phaser.io/news/2025/11/phaser-40-forked-with-full-webgl-20-support ; https://phaser.io/news
- https://excaliburjs.com/blog/tags/release/ ; https://excaliburjs.com/blog/excalibur-0-30-0-released/ ; https://github.com/excaliburjs/Excalibur/releases ; https://excaliburjs.com/docs/pixel-art ; https://excaliburjs.com/blog/Dual%20Tilemap%20Autotiling%20Technique/
- https://github.com/kaplayjs/kaplay/releases ; https://github.com/kaplayjs/kaplay/wiki/KAPLAY-Roadmap-2026
- https://github.com/melonjs/melonJS/releases ; https://www.npmjs.com/package/melonjs
- https://github.com/mrdoob/three.js/releases/tag/r186 ; https://www.utsubo.com/blog/threejs-2026-what-changed
- https://github.com/BabylonJS/Babylon.js/releases ; https://gamefromscratch.com/babylon-js-8-game-engine-released/
- https://docs.godotengine.org/en/latest/tutorials/export/exporting_for_web.html ; https://docs.godotengine.org/en/4.5/tutorials/export/exporting_for_web.html ; https://godotengine.org/releases/4.5/ ; https://docs.godotengine.org/en/stable/tutorials/rendering/multiple_resolutions.html
- https://bevy.org/news/bevy-0-18/ ; https://bevy-cheatbook.github.io/platforms/wasm.html ; https://gamefromscratch.com/bevy-0-17-released/
- npm registry (`registry.npmjs.org`) and GitHub API (`gh api repos/...`) queried 2026-10-02 for all versions, dates, stars, licenses; bundlephobia.com API for sizes.

Pixel-perfect / platform
- https://docs.unity3d.com/Packages/com.unity.2d.pixel-perfect@5.0/manual/index.html
- https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame
- https://gafferongames.com/post/fix_your_timestep/
- https://caniuse.com/webgpu ; https://caniuse.com/offscreencanvas
- https://webkit.org/blog/16993/news-from-wwdc25-webgpu-now-available-for-testing-in-safari-26-beta/
- https://birchtree.me/blog/how-to-enable-120hz-mode-in-safari-mac-iphone-and-ipad/ ; https://github.com/userFRM/tauri-plugin-macos-fps ; https://v2.tauri.app/reference/webview-versions/
- https://github.com/pixijs/pixijs/issues/7123 ; https://github.com/pixijs/pixijs/issues/9421 (worker/headless history)
- Playwright canvas testing: https://bug0.com/knowledge-base/playwright-visual-regression-testing ; https://github.com/testdino-hq/playwright-skill/blob/main/core/canvas-and-webgl.md ; https://github.com/asgaardlab/canvas-visual-bugs-testbed

Tilemaps / autotiling
- https://www.mapeditor.org/2026/03/13/tiled-1-12-released.html ; https://doc.mapeditor.org/en/stable/manual/terrain/ ; https://doc.mapeditor.org/en/stable/reference/json-map-format/ ; https://github.com/mapeditor/tiled
- https://github.com/deepnight/ldtk/releases ; https://ldtk.io/docs/general/auto-layers/
- https://www.boristhebrave.com/2023/05/31/quarter-tile-autotiling/ ; https://www.redblobgames.com/articles/autotile/claude/ ; https://github.com/jyoung4242/dual-grid-auto-tiling ; https://github.com/dexgamedev/TileMapDual_godot_node
- Prison Architect materials: https://prison-architect.fandom.com/wiki/Materials ; https://steamcommunity.com/sharedfiles/filedetails/?id=497216437 ; https://www.paradoxinteractive.com/games/prison-architect-2/news/feature-highlight-building-tools
- https://raw.githubusercontent.com/pablodelucca/pixel-agents/main/docs/external-assets.md (furniture manifest)

Assets / licenses
- https://limezu.itch.io/moderninteriors ; https://limezu.itch.io/modernoffice ; https://limezu.itch.io/moderninteriors/comments?after=40 ; https://limezu.itch.io/modernoffice/comments?before=35 ; https://itch.io/post/7003906
- https://kenney.nl/assets/roguelike-indoors ; https://kenney.nl/assets/roguelike-modern-city ; https://kenney.nl/assets/tiny-town ; https://kenney.nl/assets/pixel-pack
- https://2dpig.itch.io/pixel-office ; https://tilesmith.itch.io/retro-office-interiors-ai-ready-tileset ; https://opengameart.org/content/pixel-art-laboffice-tiles ; https://opengameart.org/content/office-space-tileset ; https://opengameart.org/content/cc0-furniture ; https://www.gamedevmarket.net/asset/topdown-office-computer-lab-1616-pixel-art-tileset-desks-pcs-chairs-props (403) ; https://donarg.itch.io/ ; https://jik-a-4.itch.io/
- https://danieldiggle.itch.io/sunnyside
- https://seliel-the-shaper.itch.io/character-base ; https://selieltheshaper.weebly.com/user-license.html
- https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator ; https://raw.githubusercontent.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator/master/README.md
- https://www.pixellab.ai/ ; https://www.pixellab.ai/termsofservice ; https://www.pixellab.ai/pixellab-api ; https://www.sprite-ai.art/blog/best-pixel-art-generators-2026 ; https://app.cinevva.com/guides/ai-pixel-art-generators
- https://retrodiffusion.ai/ ; https://astropulse.itch.io/retrodiffusion ; https://gamedevaihub.com/retro-diffusion-vs-pixellab/
- https://www.scenario.com/
- https://github.com/aseprite/aseprite/releases ; https://raw.githubusercontent.com/aseprite/aseprite/main/README.md ; https://www.aseprite.org/docs/sprite-sheet/

Inspiration / landscape
- https://github.com/chaitanyagiri/munder-difflin (+ `package.json`, `src/renderer/src/scene/office/{OfficeFloor.tsx,Camera.ts,TiledMapRenderer.ts}`, `src/renderer/src/assets/ATTRIBUTION.md`)
- https://github.com/shahar061/the-office ; https://github.com/kevinshen56714/SkyOffice
- https://github.com/pablodelucca/pixel-agents (now pixel-agents-hq/pixel-agents) ; https://github.com/paulrobello/claude-office (+ README) ; https://github.com/W17ant/Claude-Office ; https://github.com/alminisl/agent-office ; https://github.com/esteladiaz/agent-office ; https://github.com/liuyixin-louis/agentroom ; https://github.com/monkeystar0/pixel-claw ; https://github.com/kirillkuzin/clawboard ; https://github.com/neomatrix25/pixel-office-openclaw ; https://github.com/lacedupairs-code/pixel-office ; https://github.com/SweetSophia/openclaw-pixel-agents ; https://github.com/thx0701/openclaw-virtual-office
- https://dwarffortresswiki.org/index.php/Z-level ; https://gladysleaf.itch.io/office-simulator-be-a-boss/devlog/1552589/… ; https://en.wikipedia.org/wiki/SimTower
- Framework bindings: https://github.com/hairyf/vue3-pixi ; https://svelte-pixi.mattjennin.gs/releases/v8-0-0/ ; https://github.com/notYou263/svelte-pixijs ; npm `solid-pixi`
