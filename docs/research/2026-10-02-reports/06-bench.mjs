// Micro-benchmark + determinism probe for ByteBureau research.
// 1) A* (4-dir, binary heap) and BFS distance map on an office-sized grid (64x48).
// 2) FNV-1a hash of Math.* outputs to compare across JS engines (V8 vs JSC).
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const W = 64, H = 48;
const rnd = mulberry32(1234);
const walk = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) walk[i] = rnd() < 0.72 ? 1 : 0; // ~28% obstacles (walls/furniture)

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v; k.push(key); v.push(val);
    let i = k.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; }
  }
  pop() {
    const k = this.k, v = this.v; const top = v[0]; const lk = k.pop(), lv = v.pop();
    if (k.length) { k[0] = lk; v[0] = lv; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < k.length && k[l] < k[m]) m = l; if (r < k.length && k[r] < k[m]) m = r; if (m === i) break; [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m; } }
    return top;
  }
}
const g = new Int32Array(W * H), came = new Int32Array(W * H), closed = new Uint8Array(W * H);
function astar(s, t) {
  g.fill(0x7fffffff); closed.fill(0); came.fill(-1);
  const h = new Heap(); g[s] = 0; h.push(0, s);
  const tx = t % W, ty = (t / W) | 0;
  while (h.size) {
    const c = h.pop(); if (c === t) { let n = 0, x = c; while (x !== -1) { n++; x = came[x]; } return n; }
    if (closed[c]) continue; closed[c] = 1;
    const cx = c % W, cy = (c / W) | 0; const gc = g[c] + 1;
    const nb = [cx > 0 ? c - 1 : -1, cx < W - 1 ? c + 1 : -1, cy > 0 ? c - W : -1, cy < H - 1 ? c + W : -1];
    for (const n of nb) {
      if (n < 0 || !walk[n] || closed[n] || gc >= g[n]) continue;
      g[n] = gc; came[n] = c;
      h.push(gc + Math.abs((n % W) - tx) + Math.abs(((n / W) | 0) - ty), n);
    }
  }
  return 0;
}
function bfsMap(t) { // Dijkstra/flow map from one target to all cells
  const d = new Int32Array(W * H).fill(-1); const q = new Int32Array(W * H); let qh = 0, qt = 0; d[t] = 0; q[qt++] = t;
  while (qh < qt) { const c = q[qh++]; const cx = c % W, cy = (c / W) | 0; const nd = d[c] + 1;
    const nb = [cx > 0 ? c - 1 : -1, cx < W - 1 ? c + 1 : -1, cy > 0 ? c - W : -1, cy < H - 1 ? c + W : -1];
    for (const n of nb) if (n >= 0 && walk[n] && d[n] < 0) { d[n] = nd; q[qt++] = n; } }
  return d;
}
const walkable = []; for (let i = 0; i < W * H; i++) if (walk[i]) walkable.push(i);
const pairs = []; const r2 = mulberry32(99); for (let i = 0; i < 2000; i++) pairs.push([walkable[(r2() * walkable.length) | 0], walkable[(r2() * walkable.length) | 0]]);
for (const [s, t] of pairs.slice(0, 200)) astar(s, t); // warmup
let t0 = performance.now(); let found = 0, len = 0; for (const [s, t] of pairs) { const n = astar(s, t); if (n) { found++; len += n; } }
let t1 = performance.now();
const perPath = (t1 - t0) / pairs.length;
t0 = performance.now(); for (let i = 0; i < 200; i++) bfsMap(walkable[i]); t1 = performance.now();
const perMap = (t1 - t0) / 200;
console.log(JSON.stringify({ runtime: typeof Bun !== 'undefined' ? 'bun ' + Bun.version : 'node ' + process.version, grid: `${W}x${H}`, walkableCells: walkable.length, astarPaths: pairs.length, found, avgPathLen: +(len / Math.max(found, 1)).toFixed(1), msPerAstar: +perPath.toFixed(4), astarPerSimTick_at_20Hz_budget_50ms: Math.floor(50 / perPath), msPerBfsDistanceMap: +perMap.toFixed(4) }));

// 2) Cross-engine Math determinism probe
function fnv(buf) { let h = 0x811c9dc5; for (let i = 0; i < buf.length; i++) { h ^= buf[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); }
function hashOf(fn, n = 200000) { const f64 = new Float64Array(n); for (let i = 0; i < n; i++) f64[i] = fn(i * 0.001 + 0.5); return fnv(new Uint8Array(f64.buffer)); }
const probes = {
  add_mul_div: x => (x * 1.7 + 0.3) / 1.1 - x * x,
  sqrt: x => Math.sqrt(x),
  sin: x => Math.sin(x), cos: x => Math.cos(x), tan: x => Math.tan(x),
  exp: x => Math.exp(x), log: x => Math.log(x), pow: x => Math.pow(x, 1.5), pow_int: x => Math.pow(x, 3),
  atan2: x => Math.atan2(x, 1.3), hypot: x => Math.hypot(x, 2.5), cbrt: x => Math.cbrt(x), expm1: x => Math.expm1(x), log1p: x => Math.log1p(x), sinh: x => Math.sinh(x),
  fround_sum: x => Math.fround(x) + Math.fround(x * 3),
};
const out = {}; for (const [k, fn] of Object.entries(probes)) out[k] = hashOf(fn);
console.log('MATHHASH ' + JSON.stringify(out));
