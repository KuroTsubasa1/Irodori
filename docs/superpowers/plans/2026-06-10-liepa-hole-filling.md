# Liepa Hole Filling (Batch I) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Liepa's hole-filling pipeline (3-D min-weight DP → strip reattachment → refinement → fairing) as a new pure module `js/liepa.js`, wired into `Caps` as the new default cap method.

**Architecture:** `Liepa.fillLoop(loop, getPt, opts)` runs decimate → DP → strips → refine → fair and returns `{extraPts, tris}` in loop-local indexing (`i < loop.length` → i-th loop vertex, else `extraPts[i - loop.length]`). `Caps.triangulateLoops("liepa")` splices that per loop into the shared cap descriptor; rim vertices never move, so watertightness and part/remainder coincidence are preserved by construction.

**Tech Stack:** Vanilla JS (IIFE + globals), Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-06-10-liepa-hole-filling-design.md`

**Conventions:** `node --test`; suite **42** before → **45** (T1) → **47** (T2) → **48** (T3) → **49** (T4) → **50** (T5) → **50** (T6). `node --check` changed files; stage only named files; never the `.3mf`s.

---

### Task 1: `js/liepa.js` — helpers + `dpFill` (3-D min-weight triangulation)

**Files:**
- Create: `js/liepa.js`
- Modify: `tests/harness.js` (load `js/liepa.js` BEFORE `js/caps.js`; return `Liepa`)
- Create: `tests/liepa.test.js`

- [ ] **Step 1: Write the failing tests** — create `tests/liepa.test.js`:

```javascript
const test = require("node:test");
const assert = require("node:assert");
const { loadModules } = require("./harness");

test("dpFill: a triangle passes through unchanged", () => {
  const { Liepa } = loadModules();
  const tris = Liepa.dpFill([[0, 0, 0], [2, 0, 0], [0, 2, 0]]);
  assert.deepEqual(tris, [[0, 1, 2]]);
});

test("dpFill: a planar square yields two triangles covering it", () => {
  const { Liepa } = loadModules();
  const tris = Liepa.dpFill([[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]]);
  assert.equal(tris.length, 2);
  let area = 0;
  for (const [a, b, c] of tris) area += 0.5 * 2 * 2; // each half of the 2x2 square
  assert.equal(area, 4);
});

test("dpFill: a bent quad picks the flatter diagonal", () => {
  const { Liepa } = loadModules();
  // fold the quad along the 1-3 diagonal: corners 0 and 2 lifted, 1 and 3 on the floor.
  // Splitting along 1-3 gives two coplanar-with-floor-ish triangles (dihedral 0 across
  // the fold line is impossible; the flat split is 1-3, the creased one is 0-2).
  const pts = [[0, 0, 1], [2, 0, 0], [4, 0, 1], [2, 2, 0]];
  const tris = Liepa.dpFill(pts);
  assert.equal(tris.length, 2);
  const usesDiag13 = tris.every((t) => t.includes(1) && t.includes(3));
  assert.ok(usesDiag13, "min-dihedral DP chooses the 1-3 diagonal, got " + JSON.stringify(tris));
});
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/liepa.test.js` → FAIL (`Liepa` undefined / not loaded).

- [ ] **Step 3: Create `js/liepa.js`:**

```javascript
/* liepa.js — Liepa-style hole filling: minimum-weight triangulation of a
 * boundary loop directly in 3-D (no plane projection), strip reattachment to
 * the full-resolution rim, density refinement, and Laplacian fairing.
 *
 * Liepa, "Filling Holes in Meshes", SGP 2003. v1 simplifications (see spec):
 * arclength decimation, cap-internal dihedral only, membrane fairing.
 *
 * fillLoop(loop, getPt, opts) -> { extraPts:[[x,y,z]], tris:[[i,j,k]] } with
 * loop-local indexing: i < loop.length -> the i-th loop vertex, otherwise
 * extraPts[i - loop.length]. Rim vertices are never moved.
 */
(function (global) {
  "use strict";

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  function triNormal(a, b, c) {
    const n = cross(sub(b, a), sub(c, a));
    const L = len(n) || 1;
    return [n[0] / L, n[1] / L, n[2] / L];
  }
  const triArea = (a, b, c) => 0.5 * len(cross(sub(b, a), sub(c, a)));
  // dihedral measure between two triangles sharing an edge: angle between
  // normals in [0, PI]; 0 = coplanar, larger = sharper fold.
  function dihedral(n1, n2) {
    return Math.acos(Math.max(-1, Math.min(1, dot(n1, n2))));
  }

  /* Minimum-weight triangulation of a 3-D polygon (Barequet–Sharir DP with
   * Liepa's lexicographic weight: minimize max internal dihedral, then area).
   * pts: [[x,y,z]] in polygon order. Returns triangles as index triples,
   * wound with the polygon's orientation. O(n^3); keep n <= ~200. */
  function dpFill(pts) {
    const n = pts.length;
    if (n < 3) return [];
    if (n === 3) return [[0, 1, 2]];
    // tables for sub-polygon (i..j): best (ang, area) and the chosen k
    const ang = [], area = [], pick = [], norm = [];
    for (let i = 0; i < n; i++) { ang.push(new Float64Array(n)); area.push(new Float64Array(n)); pick.push(new Int32Array(n).fill(-1)); norm.push(new Array(n).fill(null)); }
    // norm[i][j] = normal of the triangle adjacent to edge (i,j) in the best
    // sub-solution (null for rim-adjacent edges j === i+1 — no internal dihedral, v1)
    const EPS = 1e-12;
    for (let gap = 2; gap < n; gap++) {
      for (let i = 0; i + gap < n; i++) {
        const j = i + gap;
        let bestAng = Infinity, bestArea = Infinity, bestK = -1, bestN = null;
        for (let k = i + 1; k < j; k++) {
          const nk = triNormal(pts[i], pts[k], pts[j]);
          let a = 0;
          if (k > i + 1) a = Math.max(a, ang[i][k], dihedral(nk, norm[i][k]));
          if (j > k + 1) a = Math.max(a, ang[k][j], dihedral(nk, norm[k][j]));
          const ar = triArea(pts[i], pts[k], pts[j]) + (k > i + 1 ? area[i][k] : 0) + (j > k + 1 ? area[k][j] : 0);
          if (a < bestAng - EPS || (Math.abs(a - bestAng) <= EPS && ar < bestArea)) {
            bestAng = a; bestArea = ar; bestK = k; bestN = nk;
          }
        }
        ang[i][j] = bestAng; area[i][j] = bestArea; pick[i][j] = bestK; norm[i][j] = bestN;
      }
    }
    const tris = [];
    (function emit(i, j) {
      if (j <= i + 1) return;
      const k = pick[i][j];
      emit(i, k);
      tris.push([i, k, j]);
      emit(k, j);
    })(0, n - 1);
    return tris;
  }

  global.Liepa = { dpFill };
})(window);
```

- [ ] **Step 4: Load it in the harness.** In `tests/harness.js`, insert `"js/liepa.js"` into the load array immediately BEFORE `"js/caps.js"`, and add `Liepa: sandbox.Liepa,` to the returned object.

- [ ] **Step 5: Run** — `node --test` → **45 pass / 0 fail**.

- [ ] **Step 6: Commit**
```bash
git add js/liepa.js tests/harness.js tests/liepa.test.js
git commit -m "feat(liepa): 3-D min-weight DP triangulation (dihedral, area)"
```

---

### Task 2: `decimate` + strips + `fillLoop` (DP-only path)

**Files:**
- Modify: `js/liepa.js`
- Test: `tests/liepa.test.js`

- [ ] **Step 1: Write the failing tests** — append to `tests/liepa.test.js`:

```javascript
// every fine rim edge (consecutive loop indices) must appear in the cap's
// boundary exactly once; internal edges exactly twice.
function rimCoverage(n, tris) {
  const m = new Map();
  const key = (a, b) => (a < b ? a + "_" + b : b + "_" + a);
  for (const [a, b, c] of tris) for (const [u, v] of [[a, b], [b, c], [c, a]]) m.set(key(u, v), (m.get(key(u, v)) || 0) + 1);
  let rimOnce = 0, rimWrong = 0, internalWrong = 0;
  for (const [k, cnt] of m) {
    const [u, v] = k.split("_").map(Number);
    const isRim = u < n && v < n && ((v - u + n) % n === 1 || (u - v + n) % n === 1);
    if (isRim) { if (cnt === 1) rimOnce++; else rimWrong++; }
    else if (cnt !== 2) internalWrong++;
  }
  return { rimOnce, rimWrong, internalWrong };
}

test("fillLoop (DP-only) covers a wavy 100-vertex rim exactly once per edge", () => {
  const { Liepa } = loadModules();
  const n = 100;
  const loop = [...Array(n).keys()].map((i) => 1000 + i); // arbitrary vids
  const getPt = (vid) => {
    const i = vid - 1000, a = (i / n) * Math.PI * 2;
    return [Math.cos(a) * 10, Math.sin(a) * 10, Math.sin(3 * a) * 1.5]; // wavy circle
  };
  const cap = Liepa.fillLoop(loop, getPt, { maxCoarse: 24, refine: false, fair: false });
  assert.equal(cap.extraPts.length, 0, "DP-only path invents no points");
  const cov = rimCoverage(n, cap.tris);
  assert.equal(cov.rimOnce, n, "all " + n + " rim edges covered once (got " + cov.rimOnce + ")");
  assert.equal(cov.rimWrong, 0);
  assert.equal(cov.internalWrong, 0, "all internal edges paired");
});

test("decimate keeps order, starts at 0, and respects maxCoarse", () => {
  const { Liepa } = loadModules();
  const pts = [...Array(50).keys()].map((i) => { const a = (i / 50) * Math.PI * 2; return [Math.cos(a), Math.sin(a), 0]; });
  const idx = Liepa.decimate(pts, 12);
  assert.equal(idx[0], 0);
  assert.ok(idx.length <= 13 && idx.length >= 10, "got " + idx.length);
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1], "ascending");
});
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/liepa.test.js` → FAIL (`fillLoop`/`decimate` not functions).

- [ ] **Step 3: Implement** — add to `js/liepa.js` above the export, and extend the export to `{ dpFill, decimate, fillLoop }`:

```javascript
  /* Pick <= maxCoarse rim vertices by accumulated chord length (always keeps
   * index 0). pts: full-resolution rim points in order. Returns ascending
   * indices into pts. */
  function decimate(pts, maxCoarse) {
    const n = pts.length;
    if (n <= maxCoarse) return [...Array(n).keys()];
    let total = 0;
    for (let i = 0; i < n; i++) total += dist(pts[i], pts[(i + 1) % n]);
    const step = total / maxCoarse;
    const idx = [0];
    let acc = 0;
    for (let i = 0; i < n - 1; i++) {
      acc += dist(pts[i], pts[i + 1]);
      if (acc >= step && idx[idx.length - 1] !== i + 1) { idx.push(i + 1); acc -= step; }
    }
    return idx;
  }

  /* Fill one boundary loop: decimate -> DP cap on the coarse polygon -> DP on
   * each fine strip -> (Task 3) refine -> (Task 4) fair. Returns
   * { extraPts, tris } in loop-local indexing. opts: { maxCoarse=200,
   * refine=true, fair=true }. */
  function fillLoop(loop, getPt, opts) {
    opts = opts || {};
    const maxCoarse = opts.maxCoarse || 200;
    const n = loop.length;
    if (n < 3) return { extraPts: [], tris: [] };
    const P = loop.map(getPt);
    const coarse = decimate(P, maxCoarse);
    // coarse cap (indices into `coarse` -> map back to loop indices)
    const coarsePts = coarse.map((i) => P[i]);
    const tris = dpFill(coarsePts).map((t) => t.map((c) => coarse[c]));
    // strips: reattach the skipped fine chain under each coarse edge with the
    // same DP (strip polygon = [a, fine..., b]; its (b,a) edge pairs with the
    // coarse cap's (a,b) edge in the opposite direction — one oriented patch)
    const m = coarse.length;
    for (let t = 0; t < m; t++) {
      const a = coarse[t], b = coarse[(t + 1) % m];
      const chain = [];
      for (let i = (a + 1) % n; i !== b; i = (i + 1) % n) chain.push(i);
      if (!chain.length) continue;
      const stripIdx = [a, ...chain, b];
      const stripTris = dpFill(stripIdx.map((i) => P[i]));
      for (const tri of stripTris) tris.push(tri.map((s) => stripIdx[s]));
    }
    const extraPts = [];
    if (opts.refine !== false) refine(P, n, extraPts, tris);
    if (opts.fair !== false) fair(P, n, extraPts, tris);
    return { extraPts, tris };
  }
```
For this task, add temporary no-op stubs ABOVE `fillLoop` (replaced in Tasks 3–4):
```javascript
  function refine(P, n, extraPts, tris) {} // Task 3
  function fair(P, n, extraPts, tris) {}   // Task 4
```

- [ ] **Step 4: Run** — `node --test` → **47 pass / 0 fail**.

- [ ] **Step 5: Commit**
```bash
git add js/liepa.js tests/liepa.test.js
git commit -m "feat(liepa): rim decimation + DP strip reattachment (fillLoop)"
```

---

### Task 3: Refinement (density splits + circumsphere flips)

**Files:**
- Modify: `js/liepa.js` (replace the `refine` stub)
- Test: `tests/liepa.test.js`

- [ ] **Step 1: Write the failing test** — append:

```javascript
test("refine inserts interior points and preserves rim coverage", () => {
  const { Liepa } = loadModules();
  const n = 60;
  const loop = [...Array(n).keys()];
  const getPt = (i) => { const a = (i / n) * Math.PI * 2; return [Math.cos(a) * 10, Math.sin(a) * 10, 0]; };
  const cap = Liepa.fillLoop(loop, getPt, { maxCoarse: 16, refine: true, fair: false });
  assert.ok(cap.extraPts.length > 0, "interior points inserted (rim edges ~1, coarse cap tris huge)");
  const cov = rimCoverage(n, cap.tris);
  assert.equal(cov.rimOnce, n, "rim still covered exactly once");
  assert.equal(cov.rimWrong, 0);
  assert.equal(cov.internalWrong, 0, "interior edges still paired after splits+flips");
});
```

- [ ] **Step 2: Run to verify failure** — the stub adds no points → `extraPts.length > 0` FAILS.

- [ ] **Step 3: Implement** — replace the `refine` stub with:

```javascript
  // circumcenter of a 3-D triangle (in its own plane) and circumradius
  function circumsphere(a, b, c) {
    const ab = sub(b, a), ac = sub(c, a);
    const abXac = cross(ab, ac);
    const d = 2 * dot(abXac, abXac);
    if (d < 1e-20) return null; // degenerate
    const t1 = cross(abXac, ab), t2 = cross(ac, abXac);
    const l1 = dot(ac, ac), l2 = dot(ab, ab);
    const off = [(t2[0] * l1 + t1[0] * l2) / d, (t2[1] * l1 + t1[1] * l2) / d, (t2[2] * l1 + t1[2] * l2) / d];
    const cc = [a[0] + off[0], a[1] + off[1], a[2] + off[2]];
    return { cc, r: dist(cc, a) };
  }

  /* Liepa refinement: split triangles whose centroid is far (vs the local
   * scale sigma) from all corners, then relax INTERIOR edges by the
   * empty-circumsphere test. Mutates extraPts/tris in place. P = rim points
   * (frozen); vertex i >= n reads extraPts[i - n]. */
  function refine(P, n, extraPts, tris) {
    const pos = (i) => (i < n ? P[i] : extraPts[i - n]);
    // sigma: rim verts = mean of their two rim edge lengths; inserted = corner mean
    const sigma = new Map();
    for (let i = 0; i < n; i++) {
      sigma.set(i, (dist(P[i], P[(i + 1) % n]) + dist(P[i], P[(i - 1 + n) % n])) / 2);
    }
    const isRimEdge = (u, v) => u < n && v < n && ((v - u + n) % n === 1 || (u - v + n) % n === 1);
    const SQRT2 = Math.SQRT2;

    for (let pass = 0; pass < 10; pass++) {
      // --- split pass ---
      let split = 0;
      for (let t = 0; t < tris.length; t++) {
        const [a, b, c] = tris[t];
        const pa = pos(a), pb = pos(b), pc = pos(c);
        const m = [(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3, (pa[2] + pb[2] + pc[2]) / 3];
        const sm = (sigma.get(a) + sigma.get(b) + sigma.get(c)) / 3;
        const ok = [a, b, c].every((v) => {
          const d = SQRT2 * dist(m, pos(v));
          return d > sm && d > sigma.get(v);
        });
        if (!ok) continue;
        const mi = n + extraPts.length;
        extraPts.push(m);
        sigma.set(mi, sm);
        tris[t] = [a, b, mi];
        tris.push([b, c, mi], [c, a, mi]);
        split++;
      }
      // --- flip relaxation (interior edges only) ---
      let flipped = 0, guard = 0;
      let changed = true;
      while (changed && guard++ < 5) {
        changed = false;
        const edgeTris = new Map(); // "u_v" (sorted) -> [triIndex...]
        const ek = (u, v) => (u < v ? u + "_" + v : v + "_" + u);
        tris.forEach((t, ti) => { for (const [u, v] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) { const k = ek(u, v); let a = edgeTris.get(k); if (!a) edgeTris.set(k, (a = [])); a.push(ti); } });
        for (const [k, owners] of edgeTris) {
          if (owners.length !== 2) continue;
          const [u, v] = k.split("_").map(Number);
          if (isRimEdge(u, v)) continue;
          const [t1, t2] = owners;
          const o1 = tris[t1].find((x) => x !== u && x !== v);
          const o2 = tris[t2].find((x) => x !== u && x !== v);
          if (o1 === undefined || o2 === undefined || o1 === o2) continue;
          if (edgeTris.has(ek(o1, o2))) continue; // flip target edge already exists
          const cs = circumsphere(pos(u), pos(v), pos(o1));
          if (!cs || dist(pos(o2), cs.cc) >= cs.r - 1e-9) continue;
          // flip (u,v) -> (o1,o2), keeping each new triangle's winding from its parent
          tris[t1] = [u, o2, o1];
          tris[t2] = [v, o1, o2];
          flipped++; changed = true;
        }
      }
      if (!split && !flipped) break;
    }
  }
```

- [ ] **Step 4: Run** — `node --test` → **48 pass / 0 fail** (the Task-2 rim-coverage test must STILL pass — flips/splits never break pairing).

- [ ] **Step 5: Commit**
```bash
git add js/liepa.js tests/liepa.test.js
git commit -m "feat(liepa): density refinement with circumsphere edge relaxation"
```

---

### Task 4: Fairing (membrane relaxation, rim pinned)

**Files:**
- Modify: `js/liepa.js` (replace the `fair` stub)
- Test: `tests/liepa.test.js`

- [ ] **Step 1: Write the failing test** — append:

```javascript
test("fair smooths interior points, pins the rim, and obeys the maximum principle", () => {
  const { Liepa } = loadModules();
  const n = 60;
  const loop = [...Array(n).keys()];
  const getPt = (i) => { const a = (i / n) * Math.PI * 2; return [Math.cos(a) * 10, Math.sin(a) * 10, Math.sin(2 * a) * 2]; }; // saddle rim
  const rough = Liepa.fillLoop(loop, getPt, { maxCoarse: 16, refine: true, fair: false });
  const smooth = Liepa.fillLoop(loop, getPt, { maxCoarse: 16, refine: true, fair: true });
  assert.equal(rough.extraPts.length, smooth.extraPts.length, "same topology");
  assert.ok(rough.extraPts.length > 0);
  let moved = 0;
  for (let i = 0; i < rough.extraPts.length; i++) if (rough.extraPts[i].some((v, k) => Math.abs(v - smooth.extraPts[i][k]) > 1e-9)) moved++;
  assert.ok(moved > 0, "fairing moved interior points");
  // maximum principle per coordinate: faired interior stays inside the rim's bounds
  for (let k = 0; k < 3; k++) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { const v = getPt(i)[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
    for (const p of smooth.extraPts) assert.ok(p[k] >= lo - 1e-6 && p[k] <= hi + 1e-6, "coord " + k + " inside rim range");
  }
});
```

- [ ] **Step 2: Run to verify failure** — the stub moves nothing → `moved > 0` FAILS.

- [ ] **Step 3: Implement** — replace the `fair` stub with:

```javascript
  /* Membrane fairing: Jacobi umbrella iterations on the interior points (the
   * rim is pinned), lambda 0.5, until max displacement < 1e-3 x mean rim edge
   * or 300 iterations. Converges to the harmonic ("soap film") patch. */
  function fair(P, n, extraPts, tris) {
    const nx = extraPts.length;
    if (!nx) return;
    const pos = (i) => (i < n ? P[i] : extraPts[i - n]);
    const nbrs = new Array(nx).fill(null).map(() => new Set());
    for (const [a, b, c] of tris) {
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        if (u >= n) nbrs[u - n].add(v);
        if (v >= n) nbrs[v - n].add(u);
      }
    }
    let meanRim = 0;
    for (let i = 0; i < n; i++) meanRim += dist(P[i], P[(i + 1) % n]);
    meanRim /= n;
    const stop = 1e-3 * meanRim;
    const LAMBDA = 0.5;
    for (let it = 0; it < 300; it++) {
      let maxMove = 0;
      const next = new Array(nx);
      for (let i = 0; i < nx; i++) {
        const cur = extraPts[i];
        let mx = 0, my = 0, mz = 0, c = 0;
        for (const v of nbrs[i]) { const p = pos(v); mx += p[0]; my += p[1]; mz += p[2]; c++; }
        if (!c) { next[i] = cur; continue; }
        mx /= c; my /= c; mz /= c;
        const np = [cur[0] + LAMBDA * (mx - cur[0]), cur[1] + LAMBDA * (my - cur[1]), cur[2] + LAMBDA * (mz - cur[2])];
        maxMove = Math.max(maxMove, dist(np, cur));
        next[i] = np;
      }
      for (let i = 0; i < nx; i++) extraPts[i] = next[i];
      if (maxMove < stop) break;
    }
  }
```

- [ ] **Step 4: Run** — `node --test` → **49 pass / 0 fail**.

- [ ] **Step 5: Commit**
```bash
git add js/liepa.js tests/liepa.test.js
git commit -m "feat(liepa): membrane fairing with pinned rim"
```

---

### Task 5: Wire `"liepa"` into `Caps` (+ watertight integration tests)

**Files:**
- Modify: `js/caps.js` (`triangulateLoops` dispatch)
- Modify: `index.html` (script tag for `js/liepa.js` BEFORE `js/caps.js`)
- Test: `tests/caps.test.js`, `tests/split.test.js`

- [ ] **Step 1: Write the failing test** — append to `tests/caps.test.js`:

```javascript
test("liepa method fills each loop independently with refined interior points", () => {
  const { Caps } = loadModules();
  const n = 40;
  const coords = {};
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; coords[i] = [Math.cos(a) * 8, Math.sin(a) * 8, Math.sin(2 * a)]; }
  const cap = Caps.triangulateLoops([[...Array(n).keys()]], (v) => coords[v], "liepa");
  assert.ok(cap.tris.length >= n - 2, "filled");
  assert.ok(cap.extraPts.length > 0, "refined interior points present");
  assert.equal(capBoundaryEdges(cap.tris).size, n, "rim covered exactly once");
});
```
Also: in `tests/split.test.js`, add `"liepa"` to the methods array of BOTH all-methods watertight tests (the tetra-bowl `for (const method of ["centroid", "projected", "earcut", "cdt"])` loop, and change the open-tube test to also loop `["earcut", "liepa"]` asserting watertightness for each — for liepa assert only `edge use === 2`, not the 4-tri count, since refinement may add points).

```javascript
// open-tube test becomes:
test("solidFromSubs caps an open tube with independent end caps (earcut + liepa)", () => {
  const { Cleanup, Split } = loadModules();
  for (const method of ["earcut", "liepa"]) {
    const tube = makeOpenTube();
    const g = Cleanup.buildSubGraph(tube);
    const solid = Split.solidFromSubs(tube, [...Array(g.NS).keys()], method);
    for (const [, n] of edgeUseCounts(solid.indices)) assert.equal(n, 2, method + ": watertight");
    if (method === "earcut") {
      assert.equal(solid.cap.tris.length, 4, "two 2-tri end caps");
      assert.equal(solid.cap.extraPts.length, 0);
    }
  }
});
```

- [ ] **Step 2: Run to verify failure** — `node --test` → FAIL (`Unknown cap method: liepa`).

- [ ] **Step 3: Implement the dispatch.** In `js/caps.js` `triangulateLoops`, after the `"projected"` branch's `return` and BEFORE the earcut/cdt section, add:

```javascript
    if (method === "liepa") {
      // Liepa pipeline fills each loop independently (no outer+hole nesting;
      // coplanar island holes should use earcut/cdt). Falls back to a centroid
      // fan per loop on any failure, preserving the watertight guarantee.
      const LP = global.Liepa;
      if (!LP || !LP.fillLoop) throw new Error("Liepa module not loaded");
      for (const loop of loops) {
        if (loop.length < 3) continue;
        const before = tris.length;
        try {
          const fill = LP.fillLoop(loop, (v) => getPt(v));
          const base = verts.length + extraPts.length; // current extra offset
          for (const ep of fill.extraPts) extraPts.push(ep);
          for (const t of fill.tris) {
            tris.push(t.map((r) => (r < loop.length ? idxOf(loop[r]) : base + (r - loop.length))));
          }
        } catch (e) {
          while (tris.length > before) tris.pop();
          emitCentroidFan(loop);
        }
      }
      return { verts, extraPts, tris };
    }
```
**Placement caveats (read the current file):** `emitCentroidFan` is defined inside the `"centroid"`-handling area — make sure the helper is defined BEFORE this new branch (move its definition up if needed) and that the unknown-method guard later in the file doesn't reject `"liepa"` (it checks `!useCDT && method !== "earcut"` — the liepa branch returns before reaching it). Note the extras-offset arithmetic: `base` must be computed against the FINAL combined index space — since `tris` references `i < verts.length → verts[i]` and `i >= verts.length → extraPts[i - verts.length]`, and `idxOf` may still APPEND to `verts` for unseen loop vids, all loop vids are pre-registered by the existing `for (const loop of loops) for (const v of loop) idxOf(v);` at the top of `triangulateLoops` — verify that pre-registration exists (it does; it builds `verts` from all loops first), so `verts.length` is stable here.

- [ ] **Step 4: Script tag.** In `index.html`, add `<script src="js/liepa.js"></script>` immediately BEFORE the `js/caps.js` tag.

- [ ] **Step 5: Run** — `node --test` → **50 pass / 0 fail** (incl. the extended all-methods loops).

- [ ] **Step 6: Commit**
```bash
git add js/caps.js js/liepa.js index.html tests/caps.test.js tests/split.test.js
git commit -m "feat(caps): liepa dispatch with per-loop centroid fallback"
```
(`js/liepa.js` only if it needed touch-ups; otherwise omit.)

---

### Task 6: Make Liepa the default

**Files:**
- Modify: `index.html` (cap-method dropdown)
- Modify: `js/viewer.js`, `js/threemf.js` (method fallbacks)

- [ ] **Step 1:** In `index.html`'s `#capMethod` select, add Liepa first and move `selected`:
```html
          <select id="capMethod">
            <option value="liepa" selected>Liepa (smooth)</option>
            <option value="earcut">Earcut</option>
            <option value="cdt">CDT (Delaunay)</option>
            <option value="projected">Projected normal</option>
            <option value="centroid">Centroid</option>
          </select>
```
(Remove `selected` from the earcut option.)

- [ ] **Step 2:** Flip the fallbacks: in `js/viewer.js` `setSplitParts`, `p.method || "earcut"` → `p.method || "liepa"`; in `js/threemf.js` `exportSplit`, `p.method || "earcut"` → `p.method || "liepa"`. (`solidFromSubs`'s own default stays `"centroid"`.)

- [ ] **Step 3: Run** — `node --check js/viewer.js && node --check js/threemf.js && node --test` → **50 pass / 0 fail**.

- [ ] **Step 4: Browser-verify (controller):** split the reference ear band with the default method — smooth, curvature-following end caps (no faceted lid); remainder fill matches; switching methods re-caps; export still watertight.

- [ ] **Step 5: Commit**
```bash
git add index.html js/viewer.js js/threemf.js
git commit -m "feat(split): Liepa (smooth) becomes the default cap method"
```

---

## Self-Review

**Spec coverage:** decimate → T2; DP (dihedral, area) → T1; strips → T2; refine (√2, circumsphere flips, interior-only) → T3; fairing (λ 0.5, stop criteria, pinned rim) → T4; Caps dispatch + per-loop fallback + load order → T5; defaults flip → T6; watertight integration → T5's split.test additions. All covered.

**Placeholder scan:** the only "stub" mentions are Task 2's explicitly-replaced `refine`/`fair` stubs with their replacing tasks named — intentional TDD staging, not placeholders. Full code everywhere else.

**Type consistency:** `fillLoop(loop, getPt, opts)` (T2) matches the T5 dispatch call; loop-local index convention (`< loop.length` / extras) matches the splice in T5; `decimate(pts, maxCoarse)` (T2) matches its test; `refine(P, n, extraPts, tris)`/`fair(P, n, extraPts, tris)` signatures consistent between stubs (T2) and implementations (T3/T4); `rimCoverage` helper defined in T2's test file before T3's test uses it; `capBoundaryEdges`/`edgeUseCounts`/`makeOpenTube` already exist in the harness.
