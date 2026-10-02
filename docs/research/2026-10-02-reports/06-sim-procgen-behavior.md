# ByteBureau research cluster 06 — Procedural office generation, employee behavior simulation, deterministic sim architecture

Date: 2026-10-02. Research agent report. All package/repo facts below were pulled live from the npm registry (`registry.npmjs.org`, `time` + `dist-tags`) and the GitHub REST API (`stargazers_count`, `pushed_at`, `license`, `archived`) on 2026-10-02 unless marked otherwise. Items marked **unverified** have a single source or no primary source.

---

## 1. Executive summary

**Architecture decision (recommended):** a pure, headless, deterministic **tick simulation package** (`@bytebureau/sim`) built as *ECS-lite* (plain-object world state + ordered system pipeline; optionally `miniplex` 2.0 or `koota` as the entity store), with a **three-layer behavior stack** per employee:

1. **WorkState statechart (authoritative, truthful):** driven *only* by real events from the coding agent (Claude Code hooks / Agent SDK message stream). Determines what the status icon says and what posture the body *must* adopt (sit & type, whiteboard, hand envelope, frustrated, celebrate).
2. **Intent/activity layer:** turns WorkState into concrete multi-step activities (walk to desk → sit → type), with interrupt/abort rules so WorkState changes always preempt flavor.
3. **Needs/utility layer (The Sims model):** only runs while the employee is *free* (waiting for human / idle). Needs decay; objects advertise satisfactions; weighted-random pick among top scores with hysteresis. This is what makes the office feel alive without ever lying about work status.

**Floor generation decision:** a seeded, multi-stage pipeline — *room program → zoning by squarified treemap/BSP → constrained growth fix-ups → corridor spine → doors → tiles → rule-based furniture → optional WFC for decor → validator (flood fill, desk count, room requirements à la Prison Architect) → retry on failure*. Output is a renderer-independent **Floor Model JSON** that a visual editor can later edit. WFC is *not* the floor-plan algorithm (local adjacency can't express "toilets near kitchen, server room in a corner"); it's a decor tool at most.

**Determinism decision:** fixed sim tick (recommend 10 Hz sim / 60–120 Hz render with interpolation), all randomness from seeded PRNG streams (`pure-rand` xoroshiro128+ with `jump()`-derived sub-streams, or `@thi.ng/random`), integer cell coordinates, **no `Math.sin/cos/exp/log/pow/atan2` inside the sim** (my local probe shows these differ bit-for-bit between Node 24/V8 and Bun 1.4/JSC; `+ − × ÷ sqrt fround` agree), stable iteration order (arrays in id order, `Map` insertion order, explicit comparators), command/event sourcing with periodic snapshots for replay/resume, and a per-tick state hash for "same seed + same command log ⇒ same hash" tests run on both Node and Bun in CI.

**Movement:** own ~100-line A* (4-dir, binary heap) on a `Uint8Array` grid. Measured locally on an office-sized 64×48 grid with 28% obstacles: **0.017 ms/path (Node), 0.022 ms (Bun)** ⇒ thousands of paths per 50 ms tick; BFS distance maps 0.04 ms. Collision handling via simple next-cell reservations + wait/re-path (Silver's cooperative-pathfinding idea, simplified), slot reservations for chairs/doors.

**Libraries (short list):** `pure-rand` 8.4.2 or `@thi.ng/random` 4.1.54 (PRNG), `simplex-noise` 4.0.3 (optional noise), `miniplex` 2.0.0 / `koota` 0.6.6 / `bitecs` 0.4.0 (entity store, pick one or none), `xstate` 5.33.2 (optional; has `SimulatedClock`), `mistreevous` 4.3.1 (only if scripted activities outgrow simple sequences), `@colyseus/schema` 5.0.35 (standalone binary delta encoding, optional) or plain JSON snapshots+patches. Everything else (pathfinding, WFC, floor generation) should be written in-house: the npm ecosystem for those is small, old, or unmaintained.

**Biggest risks:** (1) agent-event API churn (hooks/SDK event lists are large and evolving); (2) cross-runtime float non-determinism if the sim ever runs in two engines at once; (3) procedural layouts that are valid but ugly — needs a validator plus golden-seed visual review; (4) scope creep on "literally The Sims". Mitigations in §3.

---

## 2. Findings per topic

### 2.1 Procedural floor-plan generation from a seed

#### 2.1.1 Algorithms surveyed

| Algorithm | What it gives | Evidence | Fit for an office floor |
|---|---|---|---|
| **BSP partitioning** | Recursive splits → rectangular leaves → rooms → Z-corridors between siblings; split ratio 0.45–0.55 gives uniform rooms, 0.1–0.9 varied. | RogueBasin "Basic BSP Dungeon generation" [S1] | Good for *zoning* and open-office bays; produces too many corridors if used naively for rooms. |
| **Squarified treemap** | Divides a rectangle into sub-rectangles with areas proportional to weights and near-square aspect ratios; deterministic given input order (ordering not preserved). | Wikipedia Treemapping (Bruls/Huizing/van Wijk 2000) [S2]; Marson & Musse 2010, *Int. J. Computer Games Technology*, DOI 10.1155/2010/624817 — treemap-based real-time house floor plans with semantic room info [S3][S4]; Mirahmadi & Shami 2012 (arXiv 1211.5842) — treemap zoning (social/service/private), connectivity graph, corridor via shortest path, random doors on shared walls, windows on exterior walls [S5] | **Best primary tool**: weights = room areas; zones first (front/core/service/edge), then rooms inside zones. |
| **Constrained growth (grid)** | Rooms grow cell-by-cell on a square grid, hierarchically (zones → rooms), constrained by adjacency/connectivity relations. | Lopes, Tutenel, Smelik, de Kraker, Bidarra, *GAMEON 2010* (PDF at TU Delft) [S6]; method description from search abstract [S6b]. PDF text not parseable here → details beyond abstract **unverified**. | Good as a *second pass*: grow rooms into leftover cells, honor adjacency (toilets↔kitchen). |
| **rot.js Digger/Uniform/Rogue** | Feature-based digging (rooms + corridors from "wall" candidates, weighted room/corridor choice, dug-percentage stop, door placement). | rot.js source `src/map/digger.ts` [S7]; rot-js 2.2.1 (2024-11-13, BSD-3-Clause, 2.7k stars) [S8][S9] | Dungeon-ish; useful reference for door placement + RNG API; not a direct fit. |
| **Graph grammar / mission graph (Dormans, Unexplored)** | Generate an abstract graph first (rules rewrite it), then embed into space; "cycles" rather than trees. | Game Developer article on cyclic generation [S10]; Boris the Brave "Graph Rewriting for PCG" [S11] | The *idea* (logical room graph before geometry) is exactly right; full grammar machinery is overkill. Use a hand-written room graph with constraints. |
| **Wave Function Collapse** | Constraint propagation + min-entropy collapse over tile adjacency rules; contradictions → restart; seedable via injected RNG. | mxgmn reference (25.4k stars, pushed 2026-03-22) [S12]; gridbugs explainer (entropy heap, restarts) [S13]; Boris "WFC explained" (AC-3-style, rarely needs backtracking) [S14] and "Tips & tricks" (fix tiles, path constraint for connectivity, weighted/alternate tiles) [S15]; Excalibur TS write-up 2024 (restart on contradiction, >90% success in demo) [S16] | **Decor/pattern tool only** (carpets, plant clusters, wall art). Cannot express global room program. |
| **Cellular automata** | Organic caves; "probably not appropriate for generating towns". | RogueBasin CA article [S17] | Rejected. |
| **Constraint solvers (SAT/CSP)** | `logic-solver` (MiniSat, 2.0.1 from 2016, 149 stars, dormant) [S18] | Over-engineering for ≤15 rooms; a bounded retry loop with a validator is simpler and deterministic. |
| **Prison Architect room semantics** | Rooms are painted zones; a room type has min size, indoor/enclosed rules and **required objects** (Office 4×4, indoors, needs Office Desk + Chair + Filing Cabinet; Kitchen needs Cooker/Fridge/Sink; Staff Room sofas + drink machine); missing items show a warning symbol with the missing components listed. | Official Paradox wiki Rooms [S19], Office [S20] (single site, official) | Adopt directly as the **room validity** model (and as the editor's UX for invalid rooms). |
| **ML floor-plan generators** | Graph2Plan (2020, RPLAN 80K floorplans, GNN) [S21]; House-GAN++ (2021, bubble diagram → plan; repo ennauata/houseganpp 256 stars, pushed 2024-03) [S22]; HouseDiffusion adaptation (2023) [S23]; DStruct2Design (2024, LLM → data structure → plan) [S23]; Ospici et al. 2026 use a **procedural generator enforcing non-overlap, valid doors, graph consistency** as synthetic pre-training data [S24] | Rejected for runtime: Python, residential datasets, non-deterministic, heavy. Validates that "procedural + constraints" is still the standard baseline in 2026. |
| **LLM layout generation** | LayoutGPT (NeurIPS 2023; CSS-like layout output; repo MIT, pushed 2024-04) [S25]; Holodeck (CVPR 2024; GPT-4 emits *spatial relational constraints*, a DFS constraint solver places objects; repo Apache-2.0, 575 stars, pushed 2025-04) [S26]; Architect-Ant (2026; coordinate DSL + procedural traces for wall alignment, door/window clearance, circulation, room-specific inventories; editable symbolic layouts) [S27] | Rejected for the base floor (non-deterministic, cost). The **Holodeck/Architect-Ant pattern — LLM proposes constraints, deterministic solver places** — is a good optional *style hint* input later. |

No dedicated 2022–2026 *survey* of floor-plan generation could be verified (Semantic Scholar/OpenAlex calls were rate-limited); the papers above were verified individually.

#### 2.1.2 Seeded PRNG / noise libraries (TS, verified 2026-10-02)

| Package | Latest (publish) | Repo activity | License | Notes |
|---|---|---|---|---|
| `pure-rand` | 8.4.2 (2026-07-10) | pushed 2026-09-30, 117★ | MIT | xoroshiro128+ (recommended), xorshift128+, mersenne, congruential32; pure `[value, nextRng]` and unsafe APIs; unbiased `uniformIntDistribution`; `jump()` (2^64 for xoroshiro128+) for independent streams; `skipN/generateN` [S28][S29] |
| `@thi.ng/random` | 4.1.54 (2026-08-25) | umbrella pushed 2026-09-05, 3.8k★ | Apache-2.0 | SFC32, Xoshiro128, XsAdd, XorShift128, Smush32; unified `IRandom` (`int/float/norm/minmax`); weighted random, shuffle, pickRandom [S30][S29]. Repo moved to Codeberg per registry. |
| `ts-seedrandom` | 1.6.0 (2026-06-29) | pushed 2026-06-27, 3★ | MIT | 24 algorithms (xoshiro256**, sfc32, pcg32, splitmix…); `state()` export/import [S31] |
| `rand-seed` | 3.0.0 (2025-07-01) | — | MIT | sfc32 default, mulberry32, xoshiro128** [S32] |
| `seedrandom` | 3.0.5 (2019-09-17) | pushed 2024-04, 2.1k★ | MIT | Classic, effectively frozen [S33] |
| `prando` 6.0.1 (2021), `alea` 1.0.1 (2021) | frozen | | MIT | Not recommended for new code [S33] |
| `rot-js` RNG | 2.2.1 (2024-11-13) | 2.7k★ | BSD-3 | Alea; `getState/setState/clone`, `getWeightedValue`, `shuffle` [S7][S8] |
| `simplex-noise` | 4.0.3 (2024-07-26) | 1.8k★ | MIT | `createNoise2D(prng)` accepts injected PRNG ⇒ deterministic; ~73M ops/s 2D (author's benchmark) [S34] |
| TC39 `Random.Seeded` | Stage 2 | — | — | ChaCha12, `getState/setState` (112 bytes). Future standard; don't depend on it yet [S35] |

**Recommendation:** `pure-rand` (xoroshiro128+, `jump()` to derive `floorGen`, `behavior`, `ambient`, `chatter` streams from one 64-bit seed) **or** `@thi.ng/random` if you prefer the `IRandom` interface and helpers; both are active in 2026. Deterministic shuffle = Fisher–Yates over a seeded stream; weighted picks via cumulative weights (both libs provide helpers). Seed from a string with a 64-bit hash (own cyrb53/xxhash-style; trivial).

#### 2.1.3 Proposed generation pipeline (implementable, deterministic)

Inputs: `seed: string`, `params: { desks: number, style?: 'startup'|'corporate'|'loft', maxAttempts?: number }`.

1. **Seed → streams.** `root = xoroshiro128plus(hash64(seed))`; `rngBounds = root.jump()`, `rngZones`, `rngRooms`, `rngDoors`, `rngFurniture`, `rngDecor` (independent streams so changing furniture rules doesn't reshuffle rooms).
2. **Floor bounds.** Pick `w×h` cells from ranges scaled by desk count (e.g., `desks ≤ 8 → 40×28`, `≤ 24 → 56×40`, `≤ 48 → 72×48`); optionally subtract 1–2 corner rectangles for L/U shapes. Reserve a 3–4-cell strip on one chosen edge as **terrace** (exterior). Pick entrance edge ≠ terrace edge.
3. **Room program** (data, not code): `reception{area, mustTouch: entrance}`, `openOffice×k{area ∝ desks}`, `meeting×m{central, m = ceil(desks/8)}`, `kitchen{near: toilets}`, `toilets{near: kitchen, offCorridor}`, `server{corner, small}`, `terrace{edge}`, optional `lounge`, `print`, `storage`. Each has min size, area weight, placement hint, adjacency wants, **required objects** (PA-style).
4. **Room graph with constraints.** Nodes = rooms, edges = required/soft adjacency; corridor is an implicit hub. This is solved heuristically (next steps), not by a general CSP.
5. **Zoning.** Squarified treemap (or BSP with ratio 0.4–0.6) splits the interior into 3–4 zones: *front* (reception + meeting), *core* (open office), *service* (kitchen, toilets, server), *edge* (terrace side). Zone weights = Σ room areas. Front zone forced to the entrance edge; service zone to a corner.
6. **Room placement inside zones.** Treemap again per zone with room weights; then **constrained growth fix-ups**: grow rooms into unallocated cells, enforce min sizes, snap small slivers into neighbors. Hints: `corner` rooms pinned to the zone's exterior corner; `central` rooms pulled toward the zone centroid.
7. **Corridor spine + connectivity.** Carve a 2-cell-wide corridor from the entrance through the front zone along the main axis; every room must touch the corridor or an open-office area (open office acts as circulation). If a room doesn't, carve a short stub corridor (Mirahmadi/Shami: shortest-path corridor insertion) [S5].
8. **Doors.** For each room, choose a door cell on the wall shared with corridor/open office (deterministic choice via `rngDoors` among candidates ≥1 cell from corners); kitchen↔toilets may get a second door; meeting rooms get glass walls (render-only flag).
9. **Tiles.** Rasterize: floor tile type per cell (room type), walls as per-cell edge bitmask (N/E/S/W) so walls don't consume cells (or use 1-cell walls if the art style requires), doors, windows on exterior walls at intervals.
10. **Furniture (rule-based, not WFC).** Per room type a *furniture program*: open office → desk rows/clusters (desk 2×1 + chair + PC; chair's "use cell" must be walkable; desks against walls face the wall, island desks face each other; keep ≥1-cell walkways; prefer windows); meeting → table + 4–8 chairs + whiteboard; kitchen → coffee machine, fridge, sink along walls + a small table; toilets → stalls + sinks; server → racks + AC; terrace → benches, plants, railing; reception → counter, sofa, plant; printer nook. Each placement checks footprint, clearance, and that the use cell is reachable (incremental flood fill). Objects carry **advertisements** (`coffeeMachine: +energy, +social small`; `sofa: +comfort`; `whiteboard: work.think`).
11. **Decor.** Weighted rules (plants, posters, rugs) and optionally **simple-tiled WFC** for carpet/floor patterns inside a room rectangle with fixed border tiles (Boris's "fix tiles" trick) [S15]; seed it from `rngDecor`; on contradiction restart ≤ N times, else skip decor (never fail the floor for decor).
12. **Validation.** Flood fill from the entrance over walkable cells: every door, chair use-cell, coffee machine use-cell, toilet, terrace, meeting seats reachable; `#desks ≥ params.desks`; corridor min width; no furniture inside door cells; each room satisfies its PA-style requirements; no room < min size. On failure: targeted repair (remove the offending furniture / widen the corridor) then re-validate; after `maxAttempts` sub-seeds, fail loudly (keeps generation deterministic: attempt `i` uses `root.jump()^i`).
13. **Output** Floor Model JSON (below). Rendering derives sprites from `kind/rot/variant`; the sim derives walkability + interactables.

Golden tests: a fixed list of seeds → snapshot the JSON (and a hash) in the repo; any generator change that alters outputs must bump `generator.version` (so saved floors keep their seed semantics).

#### 2.1.4 Floor Model JSON (schema sketch, renderer-independent, editor-friendly)

```jsonc
{
  "schemaVersion": 1,
  "seed": "bytebureau:my-project",            // original seed (regeneration)
  "generator": { "name": "bb-floorgen", "version": "0.3.0", "params": { "desks": 12, "style": "startup" } },
  "edited": false,                            // true once the editor mutates anything
  "grid": { "w": 56, "h": 40, "cellPx": 16 }, // cellPx is a rendering hint only
  "legend": { "floor": ["void","corridor","office","meeting","kitchen","toilet","server","terrace","reception"] },
  "floor": "RLE:…",                           // w*h Uint8 indices into legend.floor
  "walls": "RLE:…",                           // w*h Uint8 edge bitmask N=1 E=2 S=4 W=8 (+ window flags 16..128)
  "rooms": [
    { "id": 3, "type": "meeting", "name": "Fishbowl", "bbox": [20,10,8,6], "cells": "RLE:…",
      "doors": [7], "requirements": { "table": 1, "chair": 4, "whiteboard": 1 }, "valid": true }
  ],
  "doors": [ { "id": 7, "cell": [24,16], "edge": "S", "rooms": [3, 1], "capacity": 1 } ],
  "furniture": [
    { "id": 41, "kind": "desk", "variant": 2, "cell": [5,5], "rot": 0, "roomId": 1,
      "footprint": [[0,0],[1,0]], "blocks": true,
      "slots": [ { "name": "seat", "cell": [0,1], "facing": "N", "kind": "chair", "reservable": true } ],
      "advertises": [ { "need": "work", "value": 100 } ] },
    { "id": 42, "kind": "coffeeMachine", "cell": [30,3], "rot": 1, "roomId": 4,
      "slots": [ { "name": "use", "cell": [0,1], "facing": "N", "reservable": true } ],
      "advertises": [ { "need": "energy", "value": 40 }, { "need": "social", "value": 10 } ],
      "sound": "coffee" }
  ],
  "points": { "entrance": [0,20], "exit": [0,20], "terraceSpots": [[54,10],[54,12]] },
  "assignments": { "deskByAgent": { "agent-reviewer": 41 } }   // sim-level, persisted with the floor
}
```
Derived at load (not stored): walkability `Uint8Array`, interactable index by need, room lookup per cell. The editor edits `rooms/furniture/walls` directly and re-runs the same validator; `generator.version` + `seed` stay for provenance. Later "multi-floor" = array of these.

### 2.2 Employee behavior

#### 2.2.1 Decision architectures compared

| Approach | Evidence | Verdict for ByteBureau |
|---|---|---|
| **Utility AI / The Sims model** | GMTK "The Genius AI Behind The Sims": motives −100..+100, objects *advertise* satisfactions, per-motive curves (hunger fridge ≈0 when full, huge when starving), personality/distance multipliers, **random pick among top scores** to avoid robotic repetition, hard production rules for social context [S36]. Wikipedia "Utility system": Sims (2000) pioneered it; Sims 3 used a modified Boltzmann distribution + personality; Dave Mark formalized (Behavioral Mathematics; IAUS with Mike Lewis) [S37]. GDC 2015 "Building a Better Centaur" (Mark & Lewis): modular utility + influence maps scaled to hundreds of agent types, behavior packages "in minutes" [S38]. Rasmussen 2016: scorers → curves → highest score; horizontal scaling; tuning via playtesting [S39]. Game AI Pro chapters on utility (Graham Ch.9; Merrill Ch.10 "utility inside BTs"; Dill "Dual-Utility Reasoning"; Lewis "Choosing Effective Considerations") [S40]. | **Chosen** for the needs/flavor layer. It is literally the Sims model the owner wants, scales horizontally (add an object = add advertisements), and is data-driven (JSON curves). |
| **Behavior trees** | `mistreevous` 4.3.1 (2025-07-24; pushed 2026-09-13; 141★; MIT): sequence/selector/parallel/race/all/lotto, repeat/retry/flip/succeed/fail, action/condition/wait/branch, MDSL text DSL, while/until guards, **injectable `random()` for deterministic lotto/wait** [S41][S42]. Others: `behavior3-ts` (60★, 2026-05), `esengine/BehaviourTree-ai` (149★, 2026-02, Chinese docs), `BehaviorTree.js` 3.0.0-beta.1 (2023-01, repo pushed 2026-03, 340★), `blueshell` (45★, 2025-06); `fluent-behavior-tree` 1.2.6 (2017) and `behavior3js` 0.2.2 (2017) are dead [S43][S44]. | **Optional** for scripted activities ("make coffee": walk, wait, animate, return). Only `mistreevous` is worth adopting; start with plain activity scripts (step lists) and reach for BT if they get branchy. |
| **GOAP** | `goap-solver` 0.4.0 (2025-12-29, 3★), `goap-js` (87★, 2022) [S45] | Rejected: planning isn't the problem (real events dictate work), ecosystem thin. |
| **HTN** | `mahler` (archived 2025), tiny others [S46] | Rejected. |
| **Statecharts** | `xstate` 5.33.2 (2026-09-15; 30.2k★; MIT); exports `SimulatedClock` (`setTimeout/clearTimeout/increment/set`) implementing its `Clock` interface; `createActor(logic, { snapshot })` restores persisted state [S47][S48][S49]. Passing a custom clock to `createActor` — **unverified in docs** (the class is exported for that purpose; confirm in source before relying). `robot3` 1.2.0 (2025-09-20; 2.2k★; BSD-2) tiny FSM [S50]. | **Use a hand-rolled enum FSM** for the per-employee WorkState (must be serializable, replayable, zero deps). XState optional for app-level orchestration (session lifecycle), not inside the hot sim loop. |
| **ECS** | `bitecs` 0.4.0 (2025-12-06; pushed 2026-08-24; 1.5k★; **MPL-2.0**): SoA typed arrays, relations, observers, entity versioning, **serializers** (SoA/AoS/Observer/Snapshot, `diff: true`) ideal for deltas; query ordering not documented as deterministic [S51][S52][S53]. `miniplex` 2.0.0 (2023-07-16; pushed 2026-04-05; 1.1k★; MIT): plain objects, archetype queries, events, no scheduler, Node/headless [S54]. `koota` 0.6.6 (2026-04-09; pushed 2026-10-01; 746★; ISC): traits SoA/AoS, relations, change detection, React optional [S55]. `becsy` 0.15.5 (2023-07; pushed 2026-10-01; 298★; MIT; multithreaded) [S56]. `arancini` 8.1.0 (2025-07; 80★). `ecsy` **archived** 2025-04 [S57]. | **ECS-lite in-house** (plain state + system pipeline). If you want a library: `miniplex` (simplest, JSON-able) or `koota` (richest, pre-1.0 churn). `bitecs` only if entity counts explode (particles) — its binary snapshot/diff serializers are a real asset but SoA makes JSON snapshots and debugging less convenient. |

#### 2.2.2 Needs, moods, emotions, social

- **Needs model (adopt):** 6 needs for v1 — `energy` (coffee), `bladder` (toilet), `social` (chat/meeting), `fun` (terrace/lounge), `comfort` (chair quality), `focus` (drops with interruptions, restored by uninterrupted work). Decay per sim-minute; advertisements from furniture; score = Σ curve(need)·advert·personality·distancePenalty; choose weighted-random among top-3 (GMTK/Sims) [S36]; commit to an activity (no re-evaluation until done or preempted) to avoid oscillation (Rasmussen notes tuning is manual) [S39].
- **Mood (adopt RimWorld "thoughts"):** mood = Σ timed thoughts (e.g., "tests passed +8 for 2h", "blocked waiting +(−6)", "chatted with colleague +4"), bar moves toward target at a bounded rate (RimWorld: +12/−8 per in-game hour), thresholds trigger visible states (grumpy/cheerful). RimWorld wiki [S58]; Prison Architect needs escalate green→blue→yellow→orange→red with behavior consequences [S59]. Both are proven, cheap, legible models.
- **Emotion models:** PAD (Mehrabian & Russell 1974; 3 axes; used as a high-level emotional space for avatars) [S60]; ALMA (Gebhard, AAMAS 2005, DOI 10.1145/1082473.1082478; emotions/moods/personality layering — details beyond metadata **unverified**) [S61]; OCC appraisal via FAtiMA Toolkit (C#, Apache-2.0, 73★, pushed 2024-05, **no JS port**) [S62]. Verdict: map mood (valence) + arousal (urgency from WorkState) to 4–6 animation "moodlets"; skip full OCC appraisal.
- **Social:** relationships as a small symmetric score per pair (+ per interaction, slow decay); small-talk is a *paired activity* (both free, same room or within N cells); gossip = propagate "thoughts" about events (e.g., "Agent B's tests failed") along relationship edges with the behavior RNG. Deterministic, data-only.
- **Generative-agent style LLM chatter?** Stanford Generative Agents (Park et al. 2023): memory stream retrieval = recency (0.995^hours) + importance (1–10) + relevance; reflection when importance sum > 150; plans decomposed to 5–15-min chunks; **"thousands of dollars in token credits… multiple days"** for 25 agents × 2 days [S63][S64]. `ai-town` (10.6k★, MIT, pushed 2026-08-26) is Convex-coupled, PixiJS, Ollama default [S65]. Project Sid (Altera 2024, PIANO, 10–1000+ agents in Minecraft) [S66]. 2026 follow-ups: Emergence World (5 worlds × 15 days on Claude Sonnet 4.6/Grok/Gemini/GPT-5-mini; "radically different outcomes" from identical starts) [S67]; Hyodo 2026 "minimal local simulation foundations" with locally hosted LLM/VLM agents [S68]. Small local models exist (Gemma 3 270M = 292 MB, 1B = 815 MB; Qwen3 0.6B = 523 MB on Ollama) [S69][S70]. **Verdict:** scripted chatter by default (templated lines parameterized by real events: file names, test counts, tool types). Optional LLM "flavor lines" later — generated **off-tick, asynchronously, cached per (event type, context hash)**, injected into the sim as a command with a tick stamp so replays stay deterministic; local Gemma/Qwen or the same Claude session's cheap model. Never let an LLM decide movement or status.

#### 2.2.3 Real events → sim intents (truthful work status)

Sources of truth: Claude Code **hooks** (2026 docs list, among others: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `Notification` with matchers `permission_prompt`/`idle_prompt`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `TeammateIdle`, `TaskCreated/TaskCompleted`, `PreCompact/PostCompact`, `SessionEnd`, `MessageDisplay`, `Elicitation`; hook types `command`, **`http`**, `mcp_tool`, `prompt`, `agent`; all events carry `session_id`, `hook_event_name`, `transcript_path`, `cwd`; subagents add `agent_id`, `agent_type`) [S71]; and the **Agent SDK (TS)** message stream (`SDKMessage` union incl. `assistant`, `user`, `result` (subtype success/error/aborted, `duration_ms`), `system` init, partial messages when `includePartialMessages`, `task_notification` (queued/started/updated/completed), hook events when `includeHookEvents`, `parent_tool_use_id`/`parent_agent_id` for subagents, and `canUseTool` callback = pending human decision) [S72]. Because hooks support HTTP, ByteBureau can ingest from any Claude Code session without the SDK.

**Mapping table (WorkState is authoritative; posture is what the body must do; P0 preempts anything):**

| Real event (hook / SDK) | WorkState | Required posture / animation | Icon / bubble | Priority |
|---|---|---|---|---|
| `SessionStart` / SDK `system` init | `arriving` | spawn at entrance, walk to assigned desk | 👋 | P1 |
| `UserPromptSubmit` / assistant stream starts | `working.thinking` | at desk, "thinking" (hand on chin) → typing when text streams | 💭 | **P0** |
| `PreToolUse` Read/Grep/Glob/WebFetch | `working.read` | sit, eyes on screen, page-flip | 📖 / 🌐 | P0 |
| `PreToolUse` Edit/Write/MultiEdit | `working.edit` | sit, fast typing | ✏️ | P0 |
| `PreToolUse` Bash (generic) | `working.bash` | sit, terminal glow | ⌨️ | P0 |
| `PreToolUse` Bash with test-runner regex (vitest/jest/pytest…) | `working.test` | sit, progress bubble | 🧪 | P0 |
| `PostToolUse` | (stay in `working.*`; refresh heartbeat) | — | — | — |
| `PostToolUseFailure`, `StopFailure` (rate_limit/overloaded/…) | `error` | frustrated at desk (head shake), red tint | ❌ (+ error_type) | P0 |
| `PermissionRequest` / `Notification:permission_prompt` / SDK `canUseTool` pending / `Elicitation` | `waiting.human` | stand, raise hand toward "camera"; after grace (e.g., 20 s) body becomes **free** for needs, icon stays | ✋ | P0 icon, body P2 after grace |
| `Notification:idle_prompt`, SDK `result` with no follow-up | `idle` | free (needs layer) | 💤/☕ | — |
| `SubagentStart` (Agent tool; `agent_type`) | `delegating` | walk to subagent's desk with ✉️ (if path ≤ N cells) **else** envelope drops from the sky onto the target desk; new subagent spawns at entrance | ✉️ | P0 (short) |
| `SubagentStop` | `receiving` | subagent returns envelope (walk or drop), parent resumes `working.*` | 📬 | P0 (short) |
| ≥2 agents with the same parent task free at once (`TaskCreated` with shared parent, or multiple `SubagentStart` in a window) | `meeting` | book meeting room; walk; sit; talk bubbles | 🗣️ | P1 |
| `Stop` (success) | `finished` | celebrate 2 s, then `idle` | ✅ | P1 |
| `PreCompact`/`PostCompact` | `working.housekeeping` | tidy desk / filing cabinet | 🗂️ | P0 |
| `TeammateIdle` | `idle` | free | | — |
| `SessionEnd` | `leaving` | walk to exit; free the desk slot | 🚪 | P1 |
| **Heartbeat missing** (> X s with WorkState `working.*` and no event/partial) | `stalled?` | stay seated; "?" icon; never shows typing | ❓ | P0 |

Rules: (1) Icon/name-tag reflects WorkState **immediately**; the body may lag while walking back (shown as "returning"). (2) `working.*` requires a *recent* event — with hooks only, long thinking phases have no events, so either enable SDK partial messages as heartbeat or display "thinking (quiet for 40 s)" honestly. (3) Needs layer only runs in `idle`/`waiting.human` (after grace). (4) Activity abort protocol: any P0 transition cancels the current activity with a short "wrap-up" (put cup down, stand up) then paths to the desk. (5) Flavor can **never** change WorkState.

### 2.3 Movement

- **Pathfinding libs:** `pathfinding` (qiao) 0.4.18 published 2016-05-10 (repo pushed 2024-06; 8.7k★; README MIT but npm `license` field empty) — A*, JPS variants, Dijkstra, BFS, IDA*, bi-directional; `easystarjs` 0.4.4 (2020-10; repo pushed 2024-01; 1.9k★; MIT; async/budgeted); `l1-path-finder` 1.0.0 (2015); `navmesh` 2.3.1 (2021-08; 376★; Phaser-oriented); `rot-js` includes A*/Dijkstra (2024-11) [S73][S74][S75][S8]. `@blackglory/pathfinding` — **not on npm** (404). Verdict: none are maintained; A* over a `Uint8Array` is ~100 lines and easier to make deterministic (explicit tie-breaking) than any dependency.
- **Measured feasibility (primary evidence, `scratchpad/research/bench.mjs`):** 64×48 grid, 28% blocked, 2,000 random A* queries, avg path 42 cells: **Node 24.14: 0.0174 ms/path; Bun 1.4.2: 0.0223 ms/path** ⇒ > 2,000 paths within a 50 ms tick; BFS distance map over the grid: 0.041–0.046 ms. Red Blob's guidance (A* with Manhattan heuristic for 4-way grids; shrink the graph first) [S76]; JPS only helps on uniform-cost 8-dir grids and forbids per-cell costs [S77] — not needed here.
- **Shared-target movement:** one BFS/Dijkstra map per popular target (coffee machine, exit) serves all agents and only recomputes when the target set changes (Red Blob tower-defense [S78]; RogueBasin "Dijkstra maps", including multi-goal *desire maps* and fleeing by −1.2 rescans [S79]). Useful for "crowd to the meeting room" and evacuation-style events.
- **Multi-agent avoidance in corridors:** Silver 2005 *Cooperative Pathfinding* — space-time reservation search (CA*, HCA*, WHCA* windowed) beats A* with local repair in success rate/path quality [S80]. For dozens of agents on a small grid, the simplified version suffices: reserve the *next* cell per tick; if blocked, wait up to K ticks then re-path treating occupied cells as temporary obstacles; doors are capacity-1 cells; chairs/coffee slots are reservable `slots` in the floor model. Liveness fallback: after K2 ticks of mutual blocking, allow "ghost-through" (sprite overlap) — invisible at pixel scale, guarantees progress. Reynolds' steering (incl. "queuing at a doorway") [S81] and Fray's context steering [S82] are for continuous spaces; rejected for a grid sim (see §4), but queueing behavior is emulated by slot waiting lines.
- **Sit/stand alignment:** furniture `slots` give the use cell + facing; "sit" = snap to slot cell, set facing, play sit → type. Desk assignment is persisted in the floor model (`assignments`).
- **Animation state machine (render layer):** `idle(4-dir)`, `walk(4-dir)`, `sit`, `type`, `think`, `talk`, `carry(envelope)`, `drink`, `celebrate`, `frustrated`. Driven by the sim's *posture* + facing, not by the renderer guessing. Interpolate position between the previous and current sim tick with `alpha = accumulator/dt` (Gaffer "Fix Your Timestep") [S83]; sprites switch animation on tick boundaries.
- **Speeds:** at 10 Hz sim, 1 cell per 2–3 ticks (≈3–5 cells/s) reads well at 16 px cells; interpolation hides the 100 ms quantization.

### 2.4 Deterministic simulation architecture

- **Fixed timestep:** accumulator pattern; clamp catch-up (max steps/frame, or accept slowdown beyond 0.25 s) to avoid the spiral of death; render with interpolation alpha; keep sim time as integers (ticks; the 2025 write-up recommends int64 ns, we can use `tick: number` safely to 2^53) [S83][S84]. Overwatch: 16 ms command frames, fixed sim clock regardless of render, only 3 of ~150 systems touch networking, death-spiral warning [S85][S86]. Recommendation: **sim 10 Hz (dt = 100 ms)** — plenty for an office (people move ~1 cell/200–300 ms), cheap on servers; configurable to 20 Hz.
- **Input-only replication / event sourcing:** deterministic lockstep sends inputs, not state; cross-machine determinism is the hard part (compilers, OS, ISA) [S87]. Factorio: identical per-tick simulation on all peers; desync reports with both game states; "heavy mode" saves/loads every tick to flush out un-persisted or `on_load`-mutated state [S88][S89]. **Adopt:** append-only command log (`{tick, type, payload}`) + periodic snapshots (every N ticks); replay = snapshot + commands; resume after restart = same; tests = "same seed + same log ⇒ same per-tick hash"; a `heavy mode` test that snapshots/restores every tick and checks the hash trajectory is unchanged.
- **Floating point in JS (critical):** IEEE-754 `+ − × ÷ sqrt` are correctly rounded and therefore reproducible; transcendental functions are not standardized and vary by library/platform (Dawson) [S90]; Rapier's docs say `Math.sin/Math.cos` are not cross-platform deterministic [S91]; MDN: Math function precision is implementation-dependent and can differ even for the same engine on another OS/architecture [S92]. **My probe** (`bench.mjs`, FNV hash of 200k outputs): `sin, cos, tan, exp, log, atan2, hypot, cbrt, expm1, log1p, sinh, pow(x,3)` **differ between Node 24.14 (V8) and Bun 1.4.2 (JSC)**; `add/mul/div, sqrt, fround, pow(x,1.5)` agree. Consequences: (a) the sim must use integer cell math and avoid `Math.*` transcendental calls (lint rule / wrapper module with table-based or integer approximations if ever needed); (b) decide one authoritative runtime for a given floor and treat the others as mirrors (or run the CI hash test on both Node and Bun as a gate before claiming cross-runtime determinism).
- **Iteration order:** `Map`/`Set` iterate in insertion order (MDN) [S93]; `Array.prototype.sort` is stable since ES2019 but the default comparator is string-based — always pass a comparator [S94]. Use arrays of entity ids in creation order; never iterate plain objects for sim logic; never depend on `Promise` timing inside a tick.
- **IDs:** monotonic integer counters stored in the state (no `nanoid`/`crypto.randomUUID` inside the sim); bitECS's entity versioning (12-bit generation) is a good pattern if ids are recycled [S52].
- **Where it runs:** the same ESM package runs (a) on the server (Node `worker_threads` — no global `Worker`, structured clone + transfer lists + SharedArrayBuffer [S95]; Bun's Web-Worker-style `Worker` with structured clone fast paths, termination still experimental [S96]) and (b) in the browser in a Web Worker (structured clone, transferable `ArrayBuffer`; SAB needs COOP/COEP) [S97]. Message protocol between host and sim: `commands in`, `snapshot/delta + events out`.
- **State sync to clients:** Colyseus 0.18.9 (2026-09-30; 7.3k★; MIT; Node + Bun; transports WebSocket/uWS/WebTransport/Bun; **binary delta patches**, default `patchRate` 50 ms = 20 fps, default `setTimestep` 16.6 ms) [S98][S99]; `@colyseus/schema` 5.0.35 "made for Colyseus, yet can be used standalone" (`Encoder/Decoder`, `encodeAll`, `encode` changes; decoders for C#, Lua, Haxe, C++) [S100]; geckos.io server 3.1.0 (2026-03; WebRTC data channels) [S101]; `@geckos.io/snapshot-interpolation` 1.1.1 (2025-02; vault, `calcInterpolation`, buffer ms) [S102]; Gaffer snapshot interpolation: ~10 snapshots/s with a buffer ≈ 3× send interval; hermite needs velocities [S103]; `nengi` 2.0.0-alpha.173 (2024-05; still alpha, master pinned to Node 14) [S104]; `lance-gg` 5.0.2 (2024-05; no pushes since) [S105]. **Recommendation:** v1 = JSON snapshot on join + per-tick JSON patch (changed entities only) over WebSocket; phone/thin client subscribes to a *derived* "status feed" (agent → WorkState/icon/room/mood) and chat only; graduate to `@colyseus/schema` standalone or bitECS Observer+SoA serializers if bandwidth matters. Visual clients interpolate between the last two snapshots (buffer 1–2 ticks).
- **Time scaling:** `speed ∈ {0, 1, 2, 4, 8}` multiplies how much wall time becomes sim ticks; pause = 0; fast-forward just runs more ticks per frame (bounded). Sim clock (tick) is the only time the sim sees; day/night and weekends are *inputs* (a command `setWallClock` once per sim-minute) so replays stay deterministic.
- **Persistence:** floor model JSON + latest snapshot + command log since snapshot (compact every N ticks). Snapshots are plain JSON (`structuredClone` for in-memory copies); hash them with a fast 64-bit hash for tests.

### 2.5 Realism details (cheap wins) and accessibility

- **Status icons + name tags:** above-head icon = WorkState (table in §2.2.3); tool-type emoji bubble on `PreToolUse`; mood tint on the tag. Models: Prison Architect need colors (green→red) [S59], RimWorld mood thresholds [S58].
- **Ambient events (seeded from `ambient` stream, never affecting WorkState):** phone rings at reception, printer jam (an employee in `idle` goes to fix it), plant watering, cleaner at night, coffee machine "out of beans" (temporarily removes its advertisement), fire-drill Easter egg (uses the evacuation Dijkstra map).
- **Day/night & weekend:** lighting tint and fewer ambient events; "lights on" where agents work; from wall clock as an input (see §2.4).
- **Speech bubbles:** short templated lines from real context ("running vitest…", "editing floor-gen.ts", "waiting for Ondřej 👀"); social small-talk from a scripted pool; optional LLM lines (§2.2.2).
- **Sound hooks:** the sim emits events (`typing.start/stop`, `coffee.pour`, `door.open`, `envelope.drop`, `tests.pass/fail`); the renderer maps them to sounds; no audio logic in the sim.
- **Accessibility:** respect `prefers-reduced-motion` (CSS media query + `matchMedia` in JS; swap scaling/panning for opacity changes) [S106]; WCAG 2.2 SC 2.3.3 asks that non-essential motion animation can be disabled, and names `prefers-reduced-motion` as a sufficient technique [S107]. Provide an in-app "reduced motion" toggle that disables camera pans, envelope flights and particle bursts while keeping state icons.

---

## 3. Ranked recommendations + risks

1. **Build the sim as a pure headless TS package with a fixed 10 Hz tick, command log + snapshots, seeded PRNG streams, integer grid math, and per-tick hashing.** Risk: subtle non-determinism (object iteration, `Math.*`, `Date`). Mitigation: ESLint `no-restricted-properties` for `Math.sin|cos|tan|exp|log|pow|atan2|hypot|cbrt|random`, `Date.now`, `performance.now` inside `packages/sim`; CI replay-hash test on Node **and** Bun (my probe proves transcendental divergence between them).
2. **Three-layer behavior stack (WorkState FSM → activities → utility needs).** Risk: lying about work status when heartbeats are sparse. Mitigation: `stalled?` state + heartbeat from SDK partial messages or hook `MessageDisplay`; needs layer gated to idle/waiting.
3. **Floor generation pipeline (treemap zoning → room growth → corridor → doors → rule-based furniture → validator → retry).** Risk: valid-but-ugly layouts; furniture failing in small rooms. Mitigation: golden-seed gallery reviewed visually, repair step before retry, parameters in JSON; keep WFC for decor only.
4. **Own A* + reservations + Dijkstra maps**; no pathfinding dependency. Risk: corridor deadlocks. Mitigation: wait → re-path → ghost-through fallback; doors capacity-1; tests with 50 agents swapping sides of a 2-wide corridor.
5. **ECS-lite with plain JSON state** (optionally `miniplex` 2.0 / `koota` 0.6). Risk: pre-1.0 churn (`koota`), slow cadence (`miniplex`), MPL-2.0 file-copyleft (`bitecs`, fine as a dependency but note it). Mitigation: a thin `World` wrapper so the store can be swapped.
6. **PRNG: `pure-rand` 8.4.2 (xoroshiro128+, `jump()`) or `@thi.ng/random` 4.1.54.** Risk: none significant; both active in 2026.
7. **Networking v1: JSON snapshot + patches over WebSocket; `@colyseus/schema` standalone later if needed.** Risk: bandwidth with many floors/clients. Mitigation: derived status feed for phones; delta encoding later.
8. **Chatter scripted first; LLM lines optional, async, cached, injected as commands.** Risk: cost/latency/non-determinism. Mitigation: never on the tick path; cap per-hour calls; local small model (Gemma 3 1B/Qwen3 0.6B) as an opt-in.
9. **Accessibility from day one** (`prefers-reduced-motion`, toggle).
10. **Golden tests everywhere:** seeds → floor JSON hash; seeds + command log → state hash trajectory; property tests for validator (every desk reachable).

Cross-cutting risks: event API churn (hooks/SDK lists are long and evolving — isolate in an adapter with a versioned mapping table); solo-maintainer scope (MVP = 6 needs, ~10 activities, 8 room types, 15 furniture kinds); performance is *not* a risk at this scale (measured).

---

## 4. Rejected options (and why)

- **WFC as the floor-plan generator** — local adjacency rules cannot express the global room program (reception at entrance, server room in a corner); contradictions/restarts make small, constrained spaces fiddly; keep for decor patterns [S14][S15].
- **Graph-grammar/mission-graph machinery (Ludoscope-style)** — expressive but "not a common technique in games" and heavy for ≤15 rooms; a hand-written room graph + heuristics is enough [S10][S11].
- **Cellular automata / Voronoi relaxation** — organic caves/territories, not offices [S17].
- **ML floor-plan models (Graph2Plan, House-GAN++, HouseDiffusion)** — Python, residential datasets, non-deterministic, no TS path [S21][S22][S23].
- **LLM-generated layouts (LayoutGPT, Holodeck, Architect-Ant) for base floors** — non-deterministic and paid; the "LLM proposes constraints → deterministic solver" pattern stays as a future *style hint* [S25][S26][S27].
- **SAT/CSP solvers (`logic-solver`)** — dormant (2016) and unnecessary [S18].
- **GOAP / HTN** — planning is not the problem; TS ecosystems are tiny or archived [S45][S46].
- **Full behavior-tree-driven agents** — BTs duplicate what the WorkState FSM + utility layer do; `mistreevous` stays as an optional tool for branchy activities [S41].
- **XState actors per employee inside the tick** — fine library (30k★, `SimulatedClock`) but adds timers/actors semantics to a loop that should be a pure function; use only at app level [S47][S48].
- **`bitecs` as default store** — great serializers and speed, but SoA typed arrays make JSON snapshots/debugging and editor round-trips clumsier at this entity count; MPL-2.0 [S51][S53].
- **`becsy`** (multithreading/SAB complexity), **`ecsy`** (archived 2025-04) [S56][S57].
- **`pathfinding`, `easystarjs`, `l1-path-finder`, `navmesh`** — unmaintained (2015–2021 releases); trivial to own [S73][S74][S75].
- **JPS / HPA\*** — grids are tiny; JPS forbids per-cell costs we may want (carpet vs. corridor) [S77].
- **RVO/ORCA, context steering** — continuous-space crowd tech; a reservation grid is simpler and deterministic [S80][S81][S82].
- **`nengi` (alpha, Node-14 master), `lance-gg` (no commits since 2024-05)** [S104][S105].
- **`seedrandom`/`prando`/`alea`** — frozen since 2019–2021; prefer `pure-rand`/`@thi.ng/random` [S33].
- **Generative-agent memory/reflection stacks and `ai-town`** — thousands of dollars per small-town-day in 2023; `ai-town` is Convex-coupled; chatter does not need it [S63][S65].
- **Running the authoritative sim in two engines simultaneously** — proven float divergence (my probe) unless all math is integer/basic-op only.

---

## 5. Open questions for the owner

1. **Event source:** hooks via HTTP (works with any Claude Code session) vs. Agent SDK in-process (richer: partial messages = heartbeat, `canUseTool` = waiting state) vs. both? This decides how truthful "thinking" can be.
2. **Authoritative runtime:** Bun or Node for the server? Do browser-only (offline) floors need bit-identical replays against server floors, or is "deterministic within one runtime + CI check on both" enough?
3. **Sim rate and grid:** 10 Hz vs 20 Hz; 16 px vs 32 px cells; 4-dir vs 8-dir walking (8-dir needs corner-cutting rules and diagonal sprites).
4. **Day/night:** from the real wall clock of the user (an "office mirror") or a sim clock? Weekend behavior when agents still work?
5. **How Sims-y:** number of needs/moodlets in v1; do relationships/moods persist across sessions and projects? Personality from agent definitions (role/model) or random per seed?
6. **Envelope delivery rule:** walk when the path is ≤ N cells and the receiver is seated; otherwise "drop from the sky"? Also: do subagents get permanent desks or a hot-desk pool?
7. **Floor editor model:** persist the full generated JSON and edit it (recommended) vs. store seed + override patch (smaller but brittle when the generator version changes)?
8. **Licensing stance:** MPL-2.0 (bitECS) and Apache-2.0 (@thi.ng) acceptable alongside your license choice?
9. **Target scale:** max agents per floor (12? 50?) and floors per server — informs desk counts, meeting rooms, and whether delta encoding is needed early.
10. **Chatter:** scripted-only v1 confirmed? If LLM lines later: local model via Ollama or the same Claude account?

---

## 6. Sources

Primary evidence produced here: `scratchpad/research/bench.mjs` (A*/BFS timing on a 64×48 grid; FNV hashes of `Math.*` outputs; Node v24.14.0 vs Bun 1.4.2, run 2026-10-02).

- [S1] RogueBasin — Basic BSP Dungeon generation: https://www.roguebasin.com/index.php/Basic_BSP_Dungeon_generation
- [S2] Wikipedia — Treemapping (squarified, Bruls/Huizing/van Wijk 2000): https://en.wikipedia.org/wiki/Treemapping
- [S3] Crossref record — Marson & Musse 2010, IJCGT, DOI 10.1155/2010/624817 (https://api.crossref.org/works?query.bibliographic=Automatic+Real-Time+Generation+of+Floor+Plans+Based+on+Squarified+Treemaps+Algorithm)
- [S4] ResearchGate listing (search result) — Automatic Real-Time Generation of Floor Plans Based on Squarified Treemaps Algorithm: https://www.researchgate.net/publication/47696530
- [S5] Mirahmadi & Shami 2012 — A Novel Algorithm for Real-time Procedural Generation of Building Floor Plans: https://ar5iv.labs.arxiv.org/html/1211.5842
- [S6] Lopes, Tutenel, Smelik, de Kraker, Bidarra — A Constrained Growth Method for Procedural Floor Plan Generation (GAMEON 2010), PDF: https://graphics.tudelft.nl/~rafa/myPapers/bidarra.GAMEON10.pdf ; [S6b] abstract via ResearchGate listing: https://www.researchgate.net/publication/265988238
- [S7] rot.js Digger source: https://raw.githubusercontent.com/ondras/rot.js/master/src/map/digger.ts ; RNG source: https://raw.githubusercontent.com/ondras/rot.js/master/src/rng.ts
- [S8] rot.js repo: https://github.com/ondras/rot.js ; [S9] npm rot-js: https://registry.npmjs.org/rot-js
- [S10] Game Developer — Unexplored's Secret: Cyclic Dungeon Generation: https://www.gamedeveloper.com/design/unexplored-s-secret-cyclic-dungeon-generation-
- [S11] Boris the Brave — Graph Rewriting for Procedural Level Generation: https://www.boristhebrave.com/2021/04/02/graph-rewriting/
- [S12] mxgmn/WaveFunctionCollapse: https://github.com/mxgmn/WaveFunctionCollapse
- [S13] gridbugs — Procedural Generation with Wave Function Collapse: https://www.gridbugs.org/wave-function-collapse/
- [S14] Boris the Brave — Wave Function Collapse Explained: https://www.boristhebrave.com/2020/04/13/wave-function-collapse-explained/
- [S15] Boris the Brave — WFC Tips and Tricks: https://www.boristhebrave.com/2020/02/08/wave-function-collapse-tips-and-tricks/ ; DeBroglie repo: https://github.com/BorisTheBrave/DeBroglie
- [S16] Excalibur blog — Wave Function Collapse (2024-06-01): https://excaliburjs.com/blog/Wave%20Function%20Collapse/ ; kchapelier/wavefunctioncollapse: https://github.com/kchapelier/wavefunctioncollapse ; npm: https://registry.npmjs.org/wavefunctioncollapse ; LingDong-/ndwfc: https://github.com/LingDong-/ndwfc
- [S17] RogueBasin — Cellular Automata Method for Generating Random Cave-Like Levels: http://www.roguebasin.com/index.php/Cellular_Automata_Method_for_Generating_Random_Cave-Like_Levels
- [S18] meteor/logic-solver: https://github.com/meteor/logic-solver ; npm: https://registry.npmjs.org/logic-solver
- [S19] Prison Architect wiki — Rooms: https://prisonarchitect.paradoxwikis.com/Rooms ; [S20] Office: https://prisonarchitect.paradoxwikis.com/Office
- [S21] Graph2Plan (Hu et al. 2020): https://arxiv.org/abs/2004.13204
- [S22] House-GAN++ (Nauata et al. 2021): https://arxiv.org/abs/2103.02574 ; repo: https://github.com/ennauata/houseganpp
- [S23] arXiv API query (procedural + floor plan + generation): http://export.arxiv.org/api/query?search_query=all:%22procedural%22%20AND%20all:%22floor%20plan%22%20AND%20all:generation — incl. 2312.03938 (HouseDiffusion adaptation), 2407.15723 (DStruct2Design), 2411.09823 (Architect)
- [S24] Ospici et al. 2026 — Mitigating Domain Shift in Conditioned Floor Plan Generation: https://arxiv.org/abs/2607.06483
- [S25] LayoutGPT (NeurIPS 2023): https://arxiv.org/abs/2305.15393 ; repo: https://github.com/UCSB-AI/LayoutGPT
- [S26] Holodeck (CVPR 2024): https://arxiv.org/abs/2312.09067 ; repo: https://github.com/allenai/Holodeck
- [S27] Architect-Ant (2026): https://arxiv.org/abs/2606.10953
- [S28] pure-rand repo/README: https://github.com/dubzzz/pure-rand ; https://raw.githubusercontent.com/dubzzz/pure-rand/main/README.md ; [S29] npm registry records: https://registry.npmjs.org/pure-rand , https://registry.npmjs.org/@thi.ng%2Frandom
- [S30] @thi.ng/random: https://github.com/thi-ng/umbrella/tree/develop/packages/random
- [S31] ts-seedrandom: https://github.com/jurerotar/ts-seedrandom ; npm: https://registry.npmjs.org/ts-seedrandom
- [S32] rand-seed: https://github.com/michaeldzjap/rand-seed ; npm: https://registry.npmjs.org/rand-seed
- [S33] npm: https://registry.npmjs.org/seedrandom , https://registry.npmjs.org/prando , https://registry.npmjs.org/alea ; repo: https://github.com/davidbau/seedrandom
- [S34] simplex-noise: https://github.com/jwagner/simplex-noise.js ; npm: https://registry.npmjs.org/simplex-noise
- [S35] TC39 proposal-seeded-random: https://github.com/tc39/proposal-seeded-random
- [S36] GMTK — The Genius AI Behind The Sims: https://gmtk.substack.com/p/the-genius-ai-behind-the-sims
- [S37] Wikipedia — Utility system: https://en.wikipedia.org/wiki/Utility_system
- [S38] GDC Vault — Building a Better Centaur: AI at Massive Scale (Mark & Lewis, GDC 2015): https://www.gdcvault.com/play/1021848/Building-a-Better-Centaur-AI
- [S39] Game Developer — Are Behavior Trees a Thing of the Past? (Rasmussen, 2016): https://www.gamedeveloper.com/programming/are-behavior-trees-a-thing-of-the-past-
- [S40] Game AI Pro chapter index: http://www.gameaipro.com/
- [S41] mistreevous: https://github.com/nikkorn/mistreevous ; [S42] npm: https://registry.npmjs.org/mistreevous
- [S43] GitHub search (behavior tree, TypeScript): https://api.github.com/search/repositories?q=%22behavior+tree%22+language:TypeScript&sort=stars ; repos: https://github.com/codetypess/behavior3-ts , https://github.com/esengine/BehaviourTree-ai , https://github.com/Calamari/BehaviorTree.js , https://github.com/6RiverSystems/blueshell
- [S44] npm: https://registry.npmjs.org/behaviortree , https://registry.npmjs.org/fluent-behavior-tree , https://registry.npmjs.org/behavior3js
- [S45] GitHub search (GOAP): https://api.github.com/search/repositories?q=goap+language:TypeScript+language:JavaScript&sort=stars ; npm goap-solver: https://registry.npmjs.org/goap-solver
- [S46] GitHub search (HTN): https://api.github.com/search/repositories?q=htn+planner+language:TypeScript+language:JavaScript&sort=stars ; mahler (archived): https://github.com/balena-io-modules/mahler
- [S47] XState repo: https://github.com/statelyai/xstate ; npm: https://registry.npmjs.org/xstate
- [S48] XState SimulatedClock source: https://raw.githubusercontent.com/statelyai/xstate/main/packages/core/src/SimulatedClock.ts ; exports: https://raw.githubusercontent.com/statelyai/xstate/main/packages/core/src/index.ts
- [S49] Stately docs — Actors (snapshot restore): https://stately.ai/docs/actors ; Delayed transitions: https://stately.ai/docs/delayed-transitions
- [S50] robot3: https://github.com/matthewp/robot ; npm: https://registry.npmjs.org/robot3
- [S51] bitECS repo: https://github.com/NateTheGreatt/bitECS ; [S52] Intro docs: https://raw.githubusercontent.com/NateTheGreatt/bitECS/main/docs/Intro.md ; [S53] Serialization docs: https://raw.githubusercontent.com/NateTheGreatt/bitECS/main/docs/Serialization.md ; npm: https://registry.npmjs.org/bitecs
- [S54] miniplex: https://github.com/hmans/miniplex ; npm: https://registry.npmjs.org/miniplex
- [S55] koota: https://github.com/pmndrs/koota ; npm: https://registry.npmjs.org/koota
- [S56] becsy: https://github.com/LastOliveGames/becsy ; npm: https://registry.npmjs.org/@lastolivegames%2Fbecsy
- [S57] ecsy (archived): https://github.com/ecsyjs/ecsy ; arancini: https://github.com/isaac-mason/arancini
- [S58] RimWorld wiki — Mood: https://rimworldwiki.com/wiki/Mood
- [S59] Prison Architect wiki — Needs: https://prisonarchitect.paradoxwikis.com/Needs
- [S60] Wikipedia — PAD emotional state model: https://en.wikipedia.org/wiki/PAD_emotional_state_model
- [S61] Crossref — Gebhard, ALMA (AAMAS 2005), DOI 10.1145/1082473.1082478
- [S62] FAtiMA Toolkit: https://github.com/GAIPS/FAtiMA-Toolkit
- [S63] Park et al. 2023 — Generative Agents (full text): https://ar5iv.labs.arxiv.org/html/2304.03442 ; abstract: https://arxiv.org/abs/2304.03442 ; [S64] repo: https://github.com/joonspk-research/generative_agents
- [S65] a16z-infra/ai-town: https://github.com/a16z-infra/ai-town
- [S66] Project Sid (Altera 2024): https://arxiv.org/abs/2411.00114
- [S67] Emergence World (2026): https://arxiv.org/abs/2606.08367
- [S68] Hyodo 2026 — Minimal Local Simulation Foundations for LLM/VLM agents: https://arxiv.org/abs/2608.22833
- [S69] Ollama — gemma3: https://ollama.com/library/gemma3 ; [S70] Ollama — qwen3: https://ollama.com/library/qwen3
- [S71] Claude Code hooks reference: https://code.claude.com/docs/en/hooks
- [S72] Claude Agent SDK (TypeScript) reference: https://code.claude.com/docs/en/agent-sdk/typescript
- [S73] PathFinding.js: https://github.com/qiao/PathFinding.js ; npm: https://registry.npmjs.org/pathfinding
- [S74] easystarjs: https://github.com/prettymuchbryce/easystarjs ; npm: https://registry.npmjs.org/easystarjs
- [S75] l1-path-finder: https://github.com/mikolalysenko/l1-path-finder ; navmesh: https://github.com/mikewesthad/navmesh
- [S76] Red Blob Games — Introduction to A*: https://www.redblobgames.com/pathfinding/a-star/introduction.html
- [S77] zerowidth — A Visual Explanation of Jump Point Search: https://zerowidth.com/2013/a-visual-explanation-of-jump-point-search/
- [S78] Red Blob Games — Tower defense pathfinding (flow fields): https://www.redblobgames.com/pathfinding/tower-defense/
- [S79] RogueBasin — The Incredible Power of Dijkstra Maps: http://www.roguebasin.com/index.php/The_Incredible_Power_of_Dijkstra_Maps
- [S80] Silver 2005 — Cooperative Pathfinding (AIIDE): https://ojs.aaai.org/index.php/AIIDE/article/view/18726
- [S81] Reynolds 1999 — Steering Behaviors For Autonomous Characters: https://www.red3d.com/cwr/steer/
- [S82] Fray — Context Behaviours Know How To Share: https://andrewfray.wordpress.com/2013/03/26/context-behaviours-know-how-to-share/
- [S83] Gaffer On Games — Fix Your Timestep!: https://gafferongames.com/post/fix_your_timestep/
- [S84] André Leite 2025 — Fixed timestep game loop: https://andreleite.com/posts/2025/game-loop/fixed-timestep-game-loop/
- [S85] GDC 2017 — Overwatch Gameplay Architecture and Netcode (vault): https://www.gdcvault.com/play/1024001/-Overwatch-Gameplay-Architecture-and ; [S86] Edgegap deep dive: https://edgegap.com/blog/game-backend-deep-dive-overwatch-2016-netcode-architecture-rollback
- [S87] Gaffer On Games — Deterministic Lockstep: https://gafferongames.com/post/deterministic_lockstep/
- [S88] Factorio wiki — Desynchronization: https://wiki.factorio.com/Desynchronization ; [S89] Friday Facts #188: https://factorio.com/blog/post/fff-188
- [S90] Dawson — Floating-Point Determinism: https://randomascii.wordpress.com/2013/07/16/floating-point-determinism/
- [S91] Rapier — Determinism (JS): https://rapier.rs/docs/user_guides/javascript/determinism
- [S92] MDN — Math (precision note): https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math
- [S93] MDN — Map: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map
- [S94] MDN — Array.prototype.sort: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/sort
- [S95] Node.js — worker_threads: https://nodejs.org/api/worker_threads.html
- [S96] Bun — Workers: https://bun.sh/docs/api/workers
- [S97] MDN — Using Web Workers: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers
- [S98] Colyseus docs (0.18): https://docs.colyseus.io/ ; [S99] Room (patchRate 50 ms, setTimestep 16.6 ms): https://docs.colyseus.io/room/ ; npm: https://registry.npmjs.org/colyseus
- [S100] @colyseus/schema README: https://github.com/colyseus/schema ; docs: https://docs.colyseus.io/state/schema ; npm: https://registry.npmjs.org/@colyseus%2Fschema
- [S101] geckos.io: https://github.com/geckosio/geckos.io ; npm: https://registry.npmjs.org/@geckos.io%2Fserver
- [S102] @geckos.io/snapshot-interpolation: https://github.com/geckosio/snapshot-interpolation ; npm: https://registry.npmjs.org/@geckos.io%2Fsnapshot-interpolation
- [S103] Gaffer On Games — Snapshot Interpolation: https://gafferongames.com/post/snapshot_interpolation/
- [S104] nengi: https://github.com/timetocode/nengi ; npm: https://registry.npmjs.org/nengi
- [S105] lance: https://github.com/lance-gg/lance ; npm: https://registry.npmjs.org/lance-gg
- [S106] MDN — prefers-reduced-motion: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
- [S107] WCAG 2.2 — Understanding SC 2.3.3 Animation from Interactions: https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html
- Search-result snippets (WebSearch, 2026-10-02) used for discovery only: WFC libs/thesis listings; floor-plan papers; PRNG libs; ECS maintenance; Sims AI; BT libs; pathfinding libs; lockstep/snapshot articles; Overwatch; Factorio FFF; Dormans; generative-agent follow-ups (AgentSociety 2025, OASIS 2411.11581, AI Metropolis 2411.03519, SimWorld 2512.01078, Emergence World 2609.17320).

Unverified / single-source items: mxgmn WFC license (GitHub API reports NOASSERTION); XState `createActor({ clock })` option (class exported, docs page didn't show the option); Lopes 2010 algorithm details beyond the abstract; ALMA internals; miniplex/koota query iteration-order guarantees; Prison Architect rules (official wiki only); Colyseus schema standalone ergonomics (README claim only); local-LLM latency numbers (none measured).
