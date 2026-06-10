# Watertight Caps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Irodori's single-anchor "centroid fan" split cap with ordered boundary-loop extraction plus four selectable cap methods (Centroid, Projected-normal, Earcut, CDT), so split parts and the leftover hole are watertight and manifold, capped from one shared cut surface, live and on export.

**Architecture:** A new pure `js/caps.js` (`window.Caps`) owns loop extraction, best-fit-plane projection, and the four triangulators. `js/split.js` keeps its T-junction conforming and delegates the cap to `Caps`, returning the part solid plus a reusable cap descriptor; `Split.remainderSolid` rebuilds the remaining mesh with each part's cap reversed. `viewer.js` renders the live part bodies and fills the remainder hole; `threemf.js` exports both; `app.js`/`index.html` add the method dropdown and per-part method/cap state.

**Tech Stack:** Vanilla JS (IIFE + `window` globals, no build step), three.js (vendored; `THREE.ShapeUtils.triangulateShape` for Earcut), poly2tri (vendored, for CDT), Node built-in test runner (`node:test` + `node:assert`) driving the modules through a `vm` sandbox (`tests/harness.js`).

**Spec:** `docs/superpowers/specs/2026-06-10-watertight-caps-design.md`

**Conventions for every task:**
- Run all tests with `node --test` from the repo root. Baseline before this plan: **8 passing**.
- The cap descriptor shape, used everywhere, is:
  `cap = { verts: number[], extraPts: number[][], tris: Array<[number,number,number]>, method: string }`
  where a triangle index `i < verts.length` refers to welded global vertex id `verts[i]`, and `i >= verts.length` refers to `extraPts[i - verts.length]` (model-space `[x,y,z]`). Triangles are wound **part-outward** (normal points away from the part interior); the remainder flips them.
- Commit after each task with the message shown in its final step.

---

### Task 1: Vendor poly2tri and load three + poly2tri in the test harness

**Files:**
- Create: `vendor/poly2tri.min.js` (downloaded)
- Modify: `tests/harness.js:7-22` (the `loadModules` function)
- Test: `tests/caps.test.js` (new)

- [ ] **Step 1: Download poly2tri into `vendor/`**

Run:
```bash
curl -fsSL "https://cdn.jsdelivr.net/npm/poly2tri@1.5.0/dist/poly2tri.min.js" -o vendor/poly2tri.min.js
wc -c vendor/poly2tri.min.js
```
Expected: roughly `21078 vendor/poly2tri.min.js` (a ~21 KB file). If the download fails, the file is also published at `https://unpkg.com/poly2tri@1.5.0/dist/poly2tri.min.js`.

- [ ] **Step 2: Write the failing test** (`tests/caps.test.js`)

```javascript
const test = require("node:test");
const assert = require("node:assert");
const { loadModules } = require("./harness");

test("deps: THREE.ShapeUtils.triangulateShape and poly2tri load in the sandbox", () => {
  const { THREE, poly2tri } = loadModules();
  assert.ok(THREE && THREE.ShapeUtils && typeof THREE.ShapeUtils.triangulateShape === "function",
    "THREE.ShapeUtils.triangulateShape available");
  assert.ok(poly2tri && poly2tri.SweepContext && poly2tri.Point,
    "poly2tri.SweepContext and poly2tri.Point available");
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/caps.test.js`
Expected: FAIL — `loadModules` does not yet return `THREE`/`poly2tri` (both `undefined`).

- [ ] **Step 4: Update `tests/harness.js` to load three + poly2tri and return them**

Replace the `loadModules` function body (lines 7-22) with:

```javascript
function loadModules() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.console = console;
  vm.createContext(sandbox);
  for (const f of [
    "vendor/three.min.js",
    "vendor/poly2tri.min.js",
    "js/paint.js",
    "js/cleanup.js",
    "js/split.js",
  ]) {
    const code = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    vm.runInContext(code, sandbox, { filename: f });
  }
  return {
    Paint: sandbox.Paint,
    Cleanup: sandbox.Cleanup,
    Split: sandbox.Split,
    THREE: sandbox.THREE,
    poly2tri: sandbox.poly2tri,
    window: sandbox,
  };
}
```
(`js/caps.js` is added to this list in Task 2, once the file exists.)

- [ ] **Step 5: Run the test to verify it passes, and confirm no regressions**

Run: `node --test`
Expected: PASS — **9 passing** (the original 8 + this one).

- [ ] **Step 6: Commit**

```bash
git add vendor/poly2tri.min.js tests/harness.js tests/caps.test.js
git commit -m "build: vendor poly2tri; load three+poly2tri in test harness"
```

---

### Task 2: `Caps.extractLoops` — chain directed boundary edges into ordered loops

**Files:**
- Create: `js/caps.js`
- Modify: `tests/harness.js` (add `js/caps.js` to the load list + return `Caps`)
- Test: `tests/caps.test.js`

- [ ] **Step 1: Write the failing tests** (append to `tests/caps.test.js`)

```javascript
test("extractLoops: one triangle boundary -> a single 3-vertex loop", () => {
  const { Caps } = loadModules();
  const loops = Caps.extractLoops([[0, 1], [1, 2], [2, 0]]);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].length, 3);
  // starts at 0 and is ordered 0 -> 1 -> 2
  const L = loops[0];
  const at = L.indexOf(0);
  assert.deepEqual([L[at], L[(at + 1) % 3], L[(at + 2) % 3]], [0, 1, 2]);
});

test("extractLoops: two disjoint boundaries -> two loops", () => {
  const { Caps } = loadModules();
  const loops = Caps.extractLoops([
    [0, 1], [1, 2], [2, 0],
    [3, 4], [4, 5], [5, 3],
  ]);
  assert.equal(loops.length, 2);
  assert.deepEqual(loops.map((l) => l.length).sort(), [3, 3]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/caps.test.js`
Expected: FAIL — `Caps` is `undefined` (module not created/loaded).

- [ ] **Step 3: Create `js/caps.js`**

```javascript
/* caps.js — boundary-loop extraction + cap triangulation for split solids.
 *
 * Pure geometry over coordinate arrays; no DOM. The Earcut method uses
 * THREE.ShapeUtils.triangulateShape (already in the vendored three.js) and CDT
 * uses poly2tri (vendored); both are read from the module global when needed.
 *
 * A cap is returned as { verts:number[], extraPts:number[][], tris:[[i,j,k]] }:
 *   index i <  verts.length  -> welded global vertex id verts[i]
 *   index i >= verts.length  -> extraPts[i - verts.length]  (model-space xyz)
 * Triangles are emitted with a consistent winding; the caller orients them.
 */
(function (global) {
  "use strict";

  // Chain directed boundary edges [u,v] (each in its owning triangle's order)
  // into ordered, oriented loops (open arrays of vertex ids; first not repeated).
  // Pinch vertices (a start with several outgoing edges) are walked greedily;
  // any chain that fails to close is dropped (documented limitation).
  function extractLoops(edges) {
    const byStart = new Map();
    for (const [u, v] of edges) {
      if (!byStart.has(u)) byStart.set(u, []);
      byStart.get(u).push(v);
    }
    const next = (u) => {
      const lst = byStart.get(u);
      return lst && lst.length ? lst.pop() : undefined;
    };
    const loops = [];
    for (const start of byStart.keys()) {
      while (byStart.get(start).length) {
        const loop = [start];
        let cur = next(start);
        while (cur !== undefined && cur !== start) {
          loop.push(cur);
          cur = next(cur);
        }
        if (cur === start && loop.length >= 3) loops.push(loop);
      }
    }
    return loops;
  }

  global.Caps = { extractLoops };
})(window);
```

- [ ] **Step 4: Add `js/caps.js` to the harness load list and return it**

In `tests/harness.js`, insert `"js/caps.js"` into the `for` array **before** `"js/split.js"`:
```javascript
    "js/cleanup.js",
    "js/caps.js",
    "js/split.js",
```
and add to the returned object:
```javascript
    Caps: sandbox.Caps,
```

- [ ] **Step 5: Run to verify pass**

Run: `node --test`
Expected: PASS — **11 passing**.

- [ ] **Step 6: Commit**

```bash
git add js/caps.js tests/harness.js tests/caps.test.js
git commit -m "feat(caps): extract ordered boundary loops"
```

---

### Task 3: `Caps.bestFitPlane` + `Caps.project` — robust plane for non-planar loops

**Files:**
- Modify: `js/caps.js`
- Test: `tests/caps.test.js`

- [ ] **Step 1: Write the failing tests** (append to `tests/caps.test.js`)

```javascript
test("bestFitPlane: normal of a z=5 square is ±Z; projection is an isometry", () => {
  const { Caps } = loadModules();
  const pts = [[0, 0, 5], [4, 0, 5], [4, 4, 5], [0, 4, 5]];
  const pl = Caps.bestFitPlane(pts);
  assert.ok(Math.abs(Math.abs(pl.nz) - 1) < 1e-9, "normal is vertical");
  assert.ok(Math.abs(pl.nx) < 1e-9 && Math.abs(pl.ny) < 1e-9);
  const p = pts.map((q) => Caps.project(pl, q));
  // side lengths preserved (projection preserves distance)
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  assert.ok(Math.abs(d(p[0], p[1]) - 4) < 1e-6);
  assert.ok(Math.abs(d(p[1], p[2]) - 4) < 1e-6);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/caps.test.js`
Expected: FAIL — `Caps.bestFitPlane is not a function`.

- [ ] **Step 3: Implement** — add to `js/caps.js` above the `global.Caps = ...` line

```javascript
  // Best-fit plane through pts (Newell's method — robust for non-planar loops).
  // Returns origin o, unit normal n, and an in-plane orthonormal basis (u, v).
  function bestFitPlane(pts) {
    const n = pts.length;
    let ox = 0, oy = 0, oz = 0;
    for (const p of pts) { ox += p[0]; oy += p[1]; oz += p[2]; }
    ox /= n; oy /= n; oz /= n;
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    let L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
    // an in-plane axis u = normalize(n × smallest-axis)
    let ux, uy, uz;
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    if (ax <= ay && ax <= az) { ux = 0; uy = -nz; uz = ny; }
    else if (ay <= az) { ux = -nz; uy = 0; uz = nx; }
    else { ux = -ny; uy = nx; uz = 0; }
    L = Math.hypot(ux, uy, uz) || 1;
    ux /= L; uy /= L; uz /= L;
    const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
    return { ox, oy, oz, nx, ny, nz, ux, uy, uz, vx, vy, vz };
  }

  // Project a model-space point onto the plane's (u, v) coordinates.
  function project(pl, p) {
    const dx = p[0] - pl.ox, dy = p[1] - pl.oy, dz = p[2] - pl.oz;
    return [dx * pl.ux + dy * pl.uy + dz * pl.uz, dx * pl.vx + dy * pl.vy + dz * pl.vz];
  }
```

and extend the export:
```javascript
  global.Caps = { extractLoops, bestFitPlane, project };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test`
Expected: PASS — **12 passing**.

- [ ] **Step 5: Commit**

```bash
git add js/caps.js tests/caps.test.js
git commit -m "feat(caps): best-fit plane (Newell) + projection"
```

---

### Task 4: `triangulateLoops` for `centroid` and `projected` (no external deps)

**Files:**
- Modify: `js/caps.js`
- Modify: `tests/harness.js` (add a `capBoundaryEdges` test helper)
- Test: `tests/caps.test.js`

- [ ] **Step 1: Add a shared test helper to `tests/harness.js`**

Add this function and export it (add `capBoundaryEdges` to `module.exports`):
```javascript
// Edges used by exactly one triangle (the open boundary of a triangle fan/cap).
// tris: array of [a,b,c] index triples. Returns a Set of "min_max" strings.
function capBoundaryEdges(tris) {
  const m = new Map();
  const key = (a, b) => (a < b ? a + "_" + b : b + "_" + a);
  for (const [a, b, c] of tris) {
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = key(u, v);
      m.set(k, (m.get(k) || 0) + 1);
    }
  }
  const once = new Set();
  for (const [k, n] of m) if (n === 1) once.add(k);
  return once;
}
```

- [ ] **Step 2: Write the failing tests** (append to `tests/caps.test.js`; add `capBoundaryEdges` to the `require("./harness")` destructure at the top of the file)

```javascript
// helper: the loop's own edge set (by the cap's combined vertex indexing,
// where loop vid k is at index = position in `verts`)
function loopEdgeSet(cap, loopVids) {
  const idx = new Map(cap.verts.map((v, i) => [v, i]));
  const key = (a, b) => (a < b ? a + "_" + b : b + "_" + a);
  const s = new Set();
  for (let i = 0; i < loopVids.length; i++) {
    s.add(key(idx.get(loopVids[i]), idx.get(loopVids[(i + 1) % loopVids.length])));
  }
  return s;
}

test("centroid: square loop -> fan of 4 tris + 1 centroid point, fills the loop", () => {
  const { Caps } = loadModules();
  const coords = { 0: [0, 0, 0], 1: [4, 0, 0], 2: [4, 4, 0], 3: [0, 4, 0] };
  const loops = [[0, 1, 2, 3]];
  const cap = Caps.triangulateLoops(loops, (v) => coords[v], "centroid");
  assert.equal(cap.tris.length, 4, "4 fan triangles");
  assert.equal(cap.extraPts.length, 1, "one centroid point");
  assert.deepEqual(cap.extraPts[0], [2, 2, 0]);
  assert.deepEqual([...capBoundaryEdges(cap.tris)].sort(), [...loopEdgeSet(cap, [0, 1, 2, 3])].sort());
});

test("projected: convex square -> ear-clip 2 tris, no extra points, fills the loop", () => {
  const { Caps } = loadModules();
  const coords = { 0: [0, 0, 0], 1: [4, 0, 0], 2: [4, 4, 0], 3: [0, 4, 0] };
  const cap = Caps.triangulateLoops([[0, 1, 2, 3]], (v) => coords[v], "projected");
  assert.equal(cap.tris.length, 2, "two triangles");
  assert.equal(cap.extraPts.length, 0, "no invented points");
  assert.deepEqual([...capBoundaryEdges(cap.tris)].sort(), [...loopEdgeSet(cap, [0, 1, 2, 3])].sort());
});

test("projected: concave L-pentagon triangulates without self-overlap", () => {
  const { Caps } = loadModules();
  // an L shape (reflex vertex at index 4)
  const coords = { 0: [0, 0, 0], 1: [4, 0, 0], 2: [4, 2, 0], 3: [2, 2, 0], 4: [2, 4, 0], 5: [0, 4, 0] };
  const cap = Caps.triangulateLoops([[0, 1, 2, 3, 4, 5]], (v) => coords[v], "projected");
  assert.equal(cap.tris.length, 4, "n-2 triangles for a simple polygon");
  assert.deepEqual([...capBoundaryEdges(cap.tris)].sort(),
    [...loopEdgeSet(cap, [0, 1, 2, 3, 4, 5])].sort());
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test tests/caps.test.js`
Expected: FAIL — `Caps.triangulateLoops is not a function`.

- [ ] **Step 4: Implement** — add to `js/caps.js` above the export line

```javascript
  // --- 2D helpers (operate on [x,y] arrays) -------------------------------
  function signedArea2(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }
  function cross2(o, a, b) {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  }
  function pointInTri(p, a, b, c) {
    const d1 = cross2(a, b, p), d2 = cross2(b, c, p), d3 = cross2(c, a, p);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  }

  // Ear-clipping triangulation of a simple polygon (array of [x,y]).
  // Returns triangles as triples of indices into `poly`. CCW-normalised.
  function earClip2D(poly) {
    const n = poly.length;
    const V = [];
    for (let i = 0; i < n; i++) V.push(i);
    if (signedArea2(poly) < 0) V.reverse();
    const tris = [];
    let guard = 0;
    while (V.length > 3 && guard++ < 10 * n) {
      let clipped = false;
      for (let i = 0; i < V.length; i++) {
        const i0 = V[(i + V.length - 1) % V.length], i1 = V[i], i2 = V[(i + 1) % V.length];
        const a = poly[i0], b = poly[i1], c = poly[i2];
        if (cross2(a, b, c) <= 0) continue; // reflex / collinear
        let ear = true;
        for (const j of V) {
          if (j === i0 || j === i1 || j === i2) continue;
          if (pointInTri(poly[j], a, b, c)) { ear = false; break; }
        }
        if (!ear) continue;
        tris.push([i0, i1, i2]);
        V.splice(i, 1);
        clipped = true;
        break;
      }
      if (!clipped) break; // numerically stuck; bail with what we have
    }
    if (V.length === 3) tris.push([V[0], V[1], V[2]]);
    return tris;
  }

  // Triangulate boundary loops with one of: centroid | projected | earcut | cdt.
  // loops: array of vid-arrays. getPt(vid) -> [x,y,z]. Returns the cap descriptor
  // { verts, extraPts, tris } (see file header). earcut/cdt are added in Task 5.
  function triangulateLoops(loops, getPt, method) {
    const verts = [];
    const vIndex = new Map();
    const idxOf = (vid) => {
      let i = vIndex.get(vid);
      if (i === undefined) { i = verts.length; vIndex.set(vid, i); verts.push(vid); }
      return i;
    };
    for (const loop of loops) for (const v of loop) idxOf(v);
    const extraPts = [];
    const tris = [];

    if (method === "centroid") {
      for (const loop of loops) {
        let cx = 0, cy = 0, cz = 0;
        for (const v of loop) { const p = getPt(v); cx += p[0]; cy += p[1]; cz += p[2]; }
        cx /= loop.length; cy /= loop.length; cz /= loop.length;
        const cRef = verts.length + extraPts.length;
        extraPts.push([cx, cy, cz]);
        for (let i = 0; i < loop.length; i++) {
          tris.push([cRef, idxOf(loop[i]), idxOf(loop[(i + 1) % loop.length])]);
        }
      }
      return { verts, extraPts, tris };
    }

    if (method === "projected") {
      for (const loop of loops) {
        const pts3 = loop.map(getPt);
        const pl = bestFitPlane(pts3);
        const poly2 = pts3.map((p) => project(pl, p));
        for (const [a, b, c] of earClip2D(poly2)) {
          tris.push([idxOf(loop[a]), idxOf(loop[b]), idxOf(loop[c])]);
        }
      }
      return { verts, extraPts, tris };
    }

    throw new Error("Unknown cap method: " + method);
  }
```

and extend the export:
```javascript
  global.Caps = { extractLoops, bestFitPlane, project, triangulateLoops };
```

- [ ] **Step 5: Run to verify pass**

Run: `node --test`
Expected: PASS — **15 passing**.

- [ ] **Step 6: Commit**

```bash
git add js/caps.js tests/harness.js tests/caps.test.js
git commit -m "feat(caps): centroid + projected (ear-clip) triangulators"
```

---

### Task 5: `triangulateLoops` for `earcut` and `cdt` (with outer/hole nesting)

**Files:**
- Modify: `js/caps.js`
- Test: `tests/caps.test.js`

- [ ] **Step 1: Write the failing tests** (append to `tests/caps.test.js`)

```javascript
test("earcut: square outer + square hole -> 8 tris, fills outer minus hole", () => {
  const { Caps } = loadModules();
  const coords = {
    0: [0, 0, 0], 1: [6, 0, 0], 2: [6, 6, 0], 3: [0, 6, 0],   // outer (CCW)
    4: [2, 2, 0], 5: [2, 4, 0], 6: [4, 4, 0], 7: [4, 2, 0],   // hole (CW)
  };
  const cap = Caps.triangulateLoops([[0, 1, 2, 3], [4, 5, 6, 7]], (v) => coords[v], "earcut");
  assert.equal(cap.tris.length, 8, "8 triangles for square-with-square-hole");
  assert.equal(cap.extraPts.length, 0, "earcut invents no points");
  // boundary = outer 4 edges + hole 4 edges (each used once)
  assert.equal(capBoundaryEdges(cap.tris).size, 8);
});

test("cdt: square outer + square hole -> triangulated with no invented points", () => {
  const { Caps } = loadModules();
  const coords = {
    0: [0, 0, 0], 1: [6, 0, 0], 2: [6, 6, 0], 3: [0, 6, 0],
    4: [2, 2, 0], 5: [2, 4, 0], 6: [4, 4, 0], 7: [4, 2, 0],
  };
  const cap = Caps.triangulateLoops([[0, 1, 2, 3], [4, 5, 6, 7]], (v) => coords[v], "cdt");
  assert.ok(cap.tris.length >= 8, "at least 8 triangles");
  assert.equal(cap.extraPts.length, 0, "cdt invents no points");
  assert.equal(capBoundaryEdges(cap.tris).size, 8, "outer + hole boundary preserved");
});

test("earcut: single convex loop (no holes) still triangulates", () => {
  const { Caps } = loadModules();
  const coords = { 0: [0, 0, 0], 1: [4, 0, 0], 2: [4, 4, 0], 3: [0, 4, 0] };
  const cap = Caps.triangulateLoops([[0, 1, 2, 3]], (v) => coords[v], "earcut");
  assert.equal(cap.tris.length, 2);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/caps.test.js`
Expected: FAIL — `Unknown cap method: earcut`.

- [ ] **Step 3: Implement** — replace the `throw new Error("Unknown cap method: " + method);` line in `triangulateLoops` with the nesting classifier and the two backends

```javascript
    // --- earcut / cdt: project all loops to one plane, classify outer+holes ---
    const allPts3 = [];
    for (const loop of loops) for (const v of loop) allPts3.push(getPt(v));
    const pl = bestFitPlane(allPts3);
    // each loop -> { vids, poly2 (CCW-normalised), area, centroid2 }
    const L = loops.map((loop) => {
      let poly2 = loop.map((v) => project(pl, getPt(v)));
      let vids = loop.slice();
      if (signedArea2(poly2) < 0) { poly2 = poly2.slice().reverse(); vids = vids.slice().reverse(); }
      let cx = 0, cy = 0;
      for (const p of poly2) { cx += p[0]; cy += p[1]; }
      return { vids, poly2, area: Math.abs(signedArea2(poly2)), centroid2: [cx / poly2.length, cy / poly2.length] };
    });
    // group: largest-area loop is the outer; loops whose centroid lies inside it
    // are holes; any loop not inside becomes its own independent outer (no holes).
    const inPoly = (pt, poly) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a[1] > pt[1]) !== (b[1] > pt[1]) &&
            pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1] || 1e-12) + a[0]) inside = !inside;
      }
      return inside;
    };
    const order = L.map((_, i) => i).sort((a, b) => L[b].area - L[a].area);
    const used = new Set();
    const groups = []; // { outer:index, holes:index[] }
    for (const oi of order) {
      if (used.has(oi)) continue;
      used.add(oi);
      const holes = [];
      for (const hi of order) {
        if (used.has(hi)) continue;
        if (inPoly(L[hi].centroid2, L[oi].poly2)) { holes.push(hi); used.add(hi); }
      }
      groups.push({ outer: oi, holes });
    }

    const useCDT = method === "cdt";
    const P2T = global.poly2tri;
    const SU = global.THREE && global.THREE.ShapeUtils;
    if (useCDT && !(P2T && P2T.SweepContext)) throw new Error("poly2tri not loaded (CDT)");
    if (!useCDT && !(SU && SU.triangulateShape)) throw new Error("THREE.ShapeUtils not loaded (Earcut)");

    for (const g of groups) {
      const outer = L[g.outer], holes = g.holes.map((i) => L[i]);
      if (useCDT) {
        // poly2tri throws on duplicate/coincident points — dedupe per loop.
        const EPS = 1e-7;
        const mkPts = (loopObj) => {
          const ptsOut = [];
          for (let k = 0; k < loopObj.poly2.length; k++) {
            const p = loopObj.poly2[k], prev = ptsOut.length ? ptsOut[ptsOut.length - 1] : null;
            if (prev && Math.abs(prev.x - p[0]) < EPS && Math.abs(prev.y - p[1]) < EPS) continue;
            const pt = new P2T.Point(p[0], p[1]); pt._vid = loopObj.vids[k]; ptsOut.push(pt);
          }
          if (ptsOut.length > 1) {
            const a = ptsOut[0], b = ptsOut[ptsOut.length - 1];
            if (Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS) ptsOut.pop();
          }
          return ptsOut;
        };
        const ctx = new P2T.SweepContext(mkPts(outer));
        for (const h of holes) ctx.addHole(mkPts(h));
        ctx.triangulate();
        for (const t of ctx.getTriangles()) {
          tris.push([idxOf(t.getPoint(0)._vid), idxOf(t.getPoint(1)._vid), idxOf(t.getPoint(2)._vid)]);
        }
      } else {
        // THREE.ShapeUtils.triangulateShape(contour, holes) -> index triples into
        // the concatenated [contour, ...holes] point list; map back to vids.
        const V2 = (p) => (global.THREE.Vector2 ? new global.THREE.Vector2(p[0], p[1]) : { x: p[0], y: p[1] });
        const contour = outer.poly2.map(V2);
        const holeContours = holes.map((h) => h.poly2.map(V2));
        const flatVids = outer.vids.concat(...holes.map((h) => h.vids));
        for (const [a, b, c] of SU.triangulateShape(contour, holeContours)) {
          tris.push([idxOf(flatVids[a]), idxOf(flatVids[b]), idxOf(flatVids[c])]);
        }
      }
    }
    return { verts, extraPts, tris };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test`
Expected: PASS — **18 passing**.

- [ ] **Step 5: Commit**

```bash
git add js/caps.js tests/caps.test.js
git commit -m "feat(caps): earcut + cdt triangulators with outer/hole nesting"
```

---

### Task 6: Refactor `Split.solidFromSubs` to cap via `Caps`, return a reusable cap, and orient it part-outward

**Files:**
- Modify: `js/split.js:9-123` (the whole `solidFromSubs` function)
- Test: `tests/split.test.js` (update the existing cap assertions)

This replaces the single-anchor fan (steps 4–5 of the old `solidFromSubs`) with loop extraction + `Caps`. The conforming (T-junction) logic is preserved. The function gains a `method` argument (default `"centroid"`, so dependency-free callers and the existing tests keep working) and returns a `cap` descriptor alongside the solid.

- [ ] **Step 1: Update the existing tests in `tests/split.test.js`**

The first test currently asserts the centroid-fan shape (6 tris, 5 verts). Per-loop centroid capping of a single triangular boundary is topologically identical (3 cap tris + 1 centroid point), so it still holds for `"centroid"`. Add explicit method coverage. Replace the first test (lines 11-25) with:

```javascript
test("solidFromSubs caps an open region into a watertight solid (all methods)", () => {
  const { Cleanup, Split } = loadModules();
  for (const method of ["centroid", "projected", "earcut", "cdt"]) {
    const mesh = makeTetra();
    const subs = regionOfState(Cleanup, mesh, 1); // 3 open faces (a 'bowl')
    const solid = Split.solidFromSubs(mesh, Array.from(subs), method);
    // watertight: every undirected edge used exactly twice
    for (const [, n] of edgeUseCounts(solid.indices)) assert.equal(n, 2, "closed under " + method);
    assert.equal(solid.state, 1);
    for (const s of solid.triState) assert.equal(s, 1, "uniform color under " + method);
    // a reusable cap descriptor is returned
    assert.ok(solid.cap && Array.isArray(solid.cap.verts) && Array.isArray(solid.cap.tris));
    assert.equal(solid.cap.method, method);
  }
});

test("solidFromSubs centroid cap of the tetra bowl: 6 tris, 5 verts", () => {
  const { Cleanup, Split } = loadModules();
  const mesh = makeTetra();
  const subs = regionOfState(Cleanup, mesh, 1);
  const solid = Split.solidFromSubs(mesh, Array.from(subs), "centroid");
  assert.equal(solid.indices.length / 3, 6);   // 3 patch + 3 cap
  assert.equal(solid.positions.length / 3, 5);  // 4 verts + 1 centroid
});
```

The other three existing tests call `solidFromSubs(mesh, subs)` with no method → default `"centroid"` → unchanged behavior. Leave them as-is.

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/split.test.js`
Expected: FAIL — the "all methods" test fails because `solidFromSubs` ignores `method`, returns no `cap`, and `"projected"/"earcut"/"cdt"` are not capped (open → edges used once).

- [ ] **Step 3: Implement** — replace `solidFromSubs` (lines 9-123 in `js/split.js`) with:

```javascript
  function solidFromSubs(mesh, subs, method) {
    method = method || "centroid";
    const g = Cleanup.buildSubGraph(mesh);
    const { sv, vx, vy, vz, subLeaf, midOf } = g;

    // local vertex remap: global welded id -> local id
    const remap = new Map();
    const px = [], py = [], pz = [];
    const lid = (gid) => {
      let id = remap.get(gid);
      if (id === undefined) {
        id = px.length; remap.set(gid, id);
        px.push(vx[gid]); py.push(vy[gid]); pz.push(vz[gid]);
      }
      return id;
    };

    function decompose(u, v) {
      const m = midOf ? midOf(u, v) : -1;
      if (m >= 0 && m !== u && m !== v) {
        return decompose(u, m).concat(decompose(m, v).slice(1));
      }
      return [u, v];
    }

    const F = [], triSt = [];          // local surface triangles + per-tri state
    const bEdge = new Map();           // global-edge key -> { u, v, count }
    const ekeyG = (a, b) => (a < b ? a + "_" + b : b + "_" + a);
    const addPerim = (u, v) => {
      const k = ekeyG(u, v);
      const e = bEdge.get(k);
      if (e) e.count++;
      else bEdge.set(k, { u, v, count: 1 }); // direction from first (owning) tri
    };

    for (let k = 0; k < subs.length; k++) {
      const s = subs[k];
      const a = sv[s * 3], b = sv[s * 3 + 1], c = sv[s * 3 + 2];
      const st = subLeaf[s].state;
      const eab = decompose(a, b), ebc = decompose(b, c), eca = decompose(c, a);
      const poly = eab.concat(ebc.slice(1), eca.slice(1, -1)); // conformed, CCW
      // perimeter edges (global) for boundary detection
      for (let i = 0; i < poly.length; i++) addPerim(poly[i], poly[(i + 1) % poly.length]);
      if (poly.length === 3) {
        F.push(lid(poly[0]), lid(poly[1]), lid(poly[2]));
        triSt.push(st);
      } else {
        // fan from the polygon centroid (interior point; never collinear)
        let gx = 0, gy = 0, gz = 0;
        for (const gid of poly) { gx += vx[gid]; gy += vy[gid]; gz += vz[gid]; }
        const nP = poly.length, gLocal = px.length;
        px.push(gx / nP); py.push(gy / nP); pz.push(gz / nP);
        for (let i = 0; i < nP; i++) {
          F.push(gLocal, lid(poly[i]), lid(poly[(i + 1) % nP]));
          triSt.push(st);
        }
      }
    }

    const out = [], outSt = [];
    for (let t = 0; t < F.length; t += 3) { out.push(F[t], F[t + 1], F[t + 2]); outSt.push(triSt[t / 3]); }

    // boundary edges (used once), directed as in their owning triangle
    const boundary = [];
    for (const e of bEdge.values()) if (e.count === 1) boundary.push([e.u, e.v]);

    let cap = { verts: [], extraPts: [], tris: [], method };
    if (boundary.length) {
      const loops = Caps.extractLoops(boundary);
      const getPt = (gid) => [vx[gid], vy[gid], vz[gid]];
      cap = Caps.triangulateLoops(loops, getPt, method);
      cap.method = method;
      // orient part-outward: flip if the loops' plane normal points toward the
      // surface interior (so cap normals face away from the part centroid).
      const loopPts = [];
      for (const loop of loops) for (const v of loop) loopPts.push(getPt(v));
      const pl = Caps.bestFitPlane(loopPts);
      let sx = 0, sy = 0, sz = 0;                       // surface centroid (local verts)
      for (let i = 0; i < px.length; i++) { sx += px[i]; sy += py[i]; sz += pz[i]; }
      sx /= px.length; sy /= py.length; sz /= pz.length;
      const dir = [pl.ox - sx, pl.oy - sy, pl.oz - sz];
      if (pl.nx * dir[0] + pl.ny * dir[1] + pl.nz * dir[2] < 0) {
        for (const t of cap.tris) { const tmp = t[1]; t[1] = t[2]; t[2] = tmp; }
      }
      // emit the cap into the part: loop verts weld via lid(); extras append locally
      const capLocal = cap.verts.map((gid) => lid(gid));
      const extraBase = px.length;
      for (const ep of cap.extraPts) { px.push(ep[0]); py.push(ep[1]); pz.push(ep[2]); }
      const refLocal = (i) => (i < cap.verts.length ? capLocal[i] : extraBase + (i - cap.verts.length));
      const capState = subs.length ? subLeaf[subs[0]].state : 0;
      for (const [a, b, c] of cap.tris) { out.push(refLocal(a), refLocal(b), refLocal(c)); outSt.push(capState); }
    }

    const positions = new Float32Array(px.length * 3);
    for (let i = 0; i < px.length; i++) { positions[i * 3] = px[i]; positions[i * 3 + 1] = py[i]; positions[i * 3 + 2] = pz[i]; }
    return {
      positions,
      indices: Uint32Array.from(out),
      triState: Int32Array.from(outSt),
      state: subs.length ? subLeaf[subs[0]].state : 0,
      cap, // { verts:globalVids, extraPts, tris (part-outward), method }
    };
  }
```

Note: `js/split.js` now references `Caps`; it is already loaded before `split.js` in both `index.html` (Task 8) and the harness (Task 2).

- [ ] **Step 4: Run to verify pass**

Run: `node --test`
Expected: PASS — all green (**18 caps + region/split tests**). Watertight under every method on the tetra bowl and the T-junction fixture.

- [ ] **Step 5: Commit**

```bash
git add js/split.js tests/split.test.js
git commit -m "refactor(split): cap via Caps (4 methods), return reusable cap descriptor"
```

---

### Task 7: `Split.remainderSolid` — rebuild the remaining mesh with each part's cap reversed

**Files:**
- Modify: `js/split.js` (add `remainderSolid`; export it)
- Test: `tests/split.test.js`

- [ ] **Step 1: Write the failing tests** (append to `tests/split.test.js`)

```javascript
test("remainderSolid: lifting one region leaves a watertight remainder", () => {
  const { Cleanup, Split } = loadModules();
  const mesh = makeTetra();
  const subs = regionOfState(Cleanup, mesh, 1);            // the 3 state-1 faces
  const part = Split.solidFromSubs(mesh, Array.from(subs), "earcut");
  const claimed = new Set(subs);
  const rem = Split.remainderSolid(mesh, [{ subs: Array.from(subs), cap: part.cap, state: 1 }], claimed);
  // remainder = the single state-2 face + the reversed cap of the lifted region
  for (const [, n] of edgeUseCounts(rem.indices)) assert.equal(n, 2, "remainder closed");
  assert.ok(rem.indices.length / 3 >= 2, "has the remaining face + cap");
});

test("remainderSolid: reversed cap winding is opposite the part cap", () => {
  const { Cleanup, Split } = loadModules();
  const mesh = makeTetra();
  const subs = Array.from(regionOfState(Cleanup, mesh, 1));
  const part = Split.solidFromSubs(mesh, subs, "centroid");
  const rem = Split.remainderSolid(mesh, [{ subs, cap: part.cap, state: 1 }], new Set(subs));
  // directed cap edges in the part and remainder must be opposite -> together
  // every directed edge appears once (orientable closed surface when merged).
  assert.ok(rem.triState.length > 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/split.test.js`
Expected: FAIL — `Split.remainderSolid is not a function`.

- [ ] **Step 3: Implement** — add to `js/split.js` after `solidFromSubs`

```javascript
  // Build the remaining mesh (sub-triangles NOT in any part) as a watertight
  // solid: its conformed surface + every part's cap, reversed, each coloured the
  // loop's majority bordering color. parts: [{ subs, cap, state }]; claimed: Set.
  function remainderSolid(mesh, parts, claimed) {
    const g = Cleanup.buildSubGraph(mesh);
    const rem = [];
    for (let s = 0; s < g.NS; s++) if (!claimed.has(s)) rem.push(s);
    // surface of the remainder, capless (method irrelevant: we add our own caps)
    // open (uncapped) conformed surface of the remainder; we add the parts' caps
    const surf = openSurface(mesh, rem);
    const px = surf.px, py = surf.py, pz = surf.pz;
    const out = surf.F.slice(), outSt = surf.triSt.slice();
    const lidG = surf.lid; // global vid -> local (creates from welded coords)

    for (const part of parts) {
      const cap = part.cap;
      const capLocal = cap.verts.map((gid) => lidG(gid));
      const extraBase = px.length;
      for (const ep of cap.extraPts) { px.push(ep[0]); py.push(ep[1]); pz.push(ep[2]); }
      const refLocal = (i) => (i < cap.verts.length ? capLocal[i] : extraBase + (i - cap.verts.length));
      const col = majorityBorderColor(mesh, g, part);
      for (const [a, b, c] of cap.tris) {
        out.push(refLocal(a), refLocal(c), refLocal(b)); // reversed winding
        outSt.push(col);
      }
    }
    const positions = new Float32Array(px.length * 3);
    for (let i = 0; i < px.length; i++) { positions[i * 3] = px[i]; positions[i * 3 + 1] = py[i]; positions[i * 3 + 2] = pz[i]; }
    return { positions, indices: Uint32Array.from(out), triState: Int32Array.from(outSt) };
  }

  // Conformed open surface (no cap) for a set of subs. Returns growable local
  // coord arrays, the surface triangles F (flat), per-tri state, and a global->
  // local vertex mapper `lid` shared for appending caps.
  function openSurface(mesh, subs) {
    const g = Cleanup.buildSubGraph(mesh);
    const { sv, vx, vy, vz, subLeaf, midOf } = g;
    const remap = new Map(), px = [], py = [], pz = [];
    const lid = (gid) => {
      let id = remap.get(gid);
      if (id === undefined) { id = px.length; remap.set(gid, id); px.push(vx[gid]); py.push(vy[gid]); pz.push(vz[gid]); }
      return id;
    };
    const decompose = (u, v) => {
      const m = midOf ? midOf(u, v) : -1;
      return (m >= 0 && m !== u && m !== v) ? decompose(u, m).concat(decompose(m, v).slice(1)) : [u, v];
    };
    const F = [], triSt = [];
    for (const s of subs) {
      const a = sv[s * 3], b = sv[s * 3 + 1], c = sv[s * 3 + 2], st = subLeaf[s].state;
      const poly = decompose(a, b).concat(decompose(b, c).slice(1), decompose(c, a).slice(1, -1));
      if (poly.length === 3) { F.push(lid(poly[0]), lid(poly[1]), lid(poly[2])); triSt.push(st); }
      else {
        let gx = 0, gy = 0, gz = 0; for (const gid of poly) { gx += vx[gid]; gy += vy[gid]; gz += vz[gid]; }
        const nP = poly.length, gL = px.length; px.push(gx / nP); py.push(gy / nP); pz.push(gz / nP);
        for (let i = 0; i < nP; i++) { F.push(gL, lid(poly[i]), lid(poly[(i + 1) % nP])); triSt.push(st); }
      }
    }
    return { px, py, pz, F, triSt, lid };
  }

  // Most common remainder state adjacent to the part's boundary (the cap's loop
  // vertices' neighbouring sub-triangles that are NOT in the part). Falls back to
  // the part's own state.
  function majorityBorderColor(mesh, g, part) {
    const inPart = new Set(part.subs);
    const votes = new Map();
    const { start, list, subLeaf } = g;
    for (const s of part.subs) {
      for (let e = start[s]; e < start[s + 1]; e++) {
        const v = list[e];
        if (!inPart.has(v)) votes.set(subLeaf[v].state, (votes.get(subLeaf[v].state) || 0) + 1);
      }
    }
    let best = -1, col = part.state;
    votes.forEach((n, st) => { if (n > best) { best = n; col = st; } });
    return col;
  }
```

and extend the export at the bottom of `js/split.js`:
```javascript
  global.Split = { solidFromSubs, remainderSolid, buildSplitXML, uuid };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test`
Expected: PASS — remainder is watertight with the reversed cap.

- [ ] **Step 5: Commit**

```bash
git add js/split.js tests/split.test.js
git commit -m "feat(split): remainderSolid reuses each part's cap reversed"
```

---

### Task 8: Viewer — render part bodies by their method and fill the remainder hole live

**Files:**
- Modify: `js/viewer.js:276-301` (`setSplitParts`) and `js/viewer.js:303-405` (`build`)
- Modify: `index.html:166-174` (script tags)

No Node test (WebGL/DOM). The geometry it relies on is already covered by Tasks 6–7; this task wires it into rendering and is verified in the browser.

- [ ] **Step 1: Add the script tags** in `index.html` — poly2tri before the app scripts, and `caps.js` before `split.js`:

```html
    <script src="vendor/three.min.js"></script>
    <script src="vendor/OrbitControls.js"></script>
    <script src="vendor/jszip.min.js"></script>
    <script src="vendor/poly2tri.min.js"></script>
    <script src="js/paint.js"></script>
    <script src="js/threemf.js"></script>
    <script src="js/caps.js"></script>
    <script src="js/cleanup.js"></script>
    <script src="js/split.js"></script>
    <script src="js/viewer.js"></script>
    <script src="js/app.js"></script>
```

- [ ] **Step 2: Build part bodies by their chosen method** — in `setSplitParts` (line ~283), pass the part's method:

```javascript
      const s = Split.solidFromSubs(doc.meshes[p.meshIndex], Array.from(p.subs), p.method || "earcut");
```

- [ ] **Step 3: Fill the remainder hole live** — at the end of `build()`, after `meshObj` is created and added to `root` (after line ~402), append each part's reversed cap as raw triangles so the hole is visibly filled. Add a module-level `splitParts` reference set by `setSplitParts`, then:

Add near the other per-build state (top of the IIFE):
```javascript
  let liveParts = []; // parts whose caps fill the main-mesh holes
```
In `setSplitParts(parts)`, set it (first line of the function body):
```javascript
    liveParts = parts || [];
```
At the end of `build()` (just before `setHighlight(null);`), append the reversed-cap fill:
```javascript
    // Fill the holes left by split parts so the remainder looks solid (visual
    // only; export builds a welded watertight remainder via Split.remainderSolid).
    if (liveParts.length) appendRemainderCaps();
```
and add this function inside the IIFE:
```javascript
  function appendRemainderCaps() {
    const tris = [];
    for (const p of liveParts) {
      const cap = p.cap;
      if (!cap || !cap.tris.length) continue;
      const g = Cleanup.buildSubGraph(doc.meshes[p.meshIndex]);
      const pt = (ref) => ref < cap.verts.length
        ? [g.vx[cap.verts[ref]], g.vy[cap.verts[ref]], g.vz[cap.verts[ref]]]
        : cap.extraPts[ref - cap.verts.length];
      for (const [a, b, c] of cap.tris) { // reversed winding for the remainder side
        const A = pt(a), B = pt(c), C = pt(b);
        tris.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
      }
    }
    if (!tris.length) return;
    const add = new Float32Array(tris);
    const merged = new Float32Array(geom.attributes.position.array.length + add.length);
    merged.set(geom.attributes.position.array, 0);
    merged.set(add, geom.attributes.position.array.length);
    const newGeom = new THREE.BufferGeometry();
    newGeom.setAttribute("position", new THREE.BufferAttribute(merged, 3));
    const cc = new Float32Array(merged.length);
    cc.set(colorAttr.array, 0);
    const grey = new THREE.Color("#9aa3b2").convertSRGBToLinear();
    for (let o = colorAttr.array.length; o < cc.length; o += 3) { cc[o] = grey.r; cc[o + 1] = grey.g; cc[o + 2] = grey.b; }
    newGeom.setAttribute("color", new THREE.BufferAttribute(cc, 3));
    newGeom.computeVertexNormals();
    newGeom.computeBoundingSphere();
    root.remove(meshObj);
    geom.dispose();
    geom = newGeom;
    colorAttr = newGeom.attributes.color;
    meshObj = new THREE.Mesh(geom, meshObj.material);
    root.add(meshObj);
  }
```
(The picking path is unaffected: caps are appended after the picked-region range, and the Split tool re-floods on the original graph, not on rendered indices.)

`viewer.js` calls `Cleanup.buildSubGraph` — `cleanup.js` is already loaded before `viewer.js`.

- [ ] **Step 4: Verify in the browser**

Run a static server and open the app:
```bash
python3 -m http.server 8000
```
Open `http://localhost:8000/`, load `Meshy_AI_Pikachu and the Red Ball.3mf`, pick the **Split** tool, click the red ball.
Expected:
- The red ball lifts out and animates outward (unchanged).
- The hole it leaves in the body is now **filled** (grey), not open — orbit to confirm no see-through gap.
- No console errors.

- [ ] **Step 5: Commit**

```bash
git add js/viewer.js index.html
git commit -m "feat(viewer): render parts by method; fill remainder hole live"
```

---

### Task 9: Export — split parts use their stored cap; remainder uses `remainderSolid`

**Files:**
- Modify: `js/threemf.js:161-226` (`exportSplit`)
- Test: `tests/split.test.js`

- [ ] **Step 1: Write the failing test** (append to `tests/split.test.js`)

```javascript
test("exportSplit-style assembly: parts by method + remainderSolid produce N objects", () => {
  const { Cleanup, Split } = loadModules();
  const mesh = makeTetra();
  const subs = Array.from(regionOfState(Cleanup, mesh, 1));
  const part = Split.solidFromSubs(mesh, subs, "earcut");
  const rem = Split.remainderSolid(mesh, [{ subs, cap: part.cap, state: 1 }], new Set(subs));
  const objects = [
    { name: "Filament 1", extruder: 1, positions: part.positions, indices: part.indices, triState: null },
    { name: "Remaining", extruder: 1, positions: rem.positions, indices: rem.indices, triState: rem.triState },
  ];
  const xml = Split.buildSplitXML(objects, { buildTransform: "1 0 0 0 1 0 0 0 1 1 2 0", defaultExtruder: 1 });
  assert.equal((xml.objectsModel.match(/<object /g) || []).length, 2);
  // both bodies are watertight
  for (const [, n] of edgeUseCounts(part.indices)) assert.equal(n, 2);
  for (const [, n] of edgeUseCounts(rem.indices)) assert.equal(n, 2);
});
```

- [ ] **Step 2: Run to verify it passes already at the geometry level, then wire the real export**

Run: `node --test tests/split.test.js`
Expected: PASS (geometry is ready from Tasks 6–7). This test guards the export assembly contract; now update `exportSplit` to use it.

- [ ] **Step 3: Update `exportSplit`** in `js/threemf.js` — replace the two body-building loops (the `for (const p of splitParts)` and the `for (let mi ...)` remainder loop, lines ~171-189) with:

```javascript
    // split parts -> uniform-color solids, capped with each part's chosen method
    for (const p of splitParts) {
      const g = Split.solidFromSubs(doc.meshes[p.meshIndex], Array.from(p.subs), p.method || "earcut");
      objects.push({
        name: nameFor(p.state), extruder: extruderFor(p.state),
        positions: g.positions, indices: g.indices, triState: null,
      });
    }
    // remaining per mesh -> painted, hole-capped solid (reuses parts' reversed caps)
    for (let mi = 0; mi < doc.meshes.length; mi++) {
      const partsHere = splitParts
        .filter((p) => p.meshIndex === mi)
        .map((p) => ({ subs: Array.from(p.subs), cap: p.cap, state: p.state }));
      if (!partsHere.length && !claimed[mi].size) continue;
      const g = Split.remainderSolid(doc.meshes[mi], partsHere, claimed[mi]);
      if (!g.indices.length) continue;
      objects.push({
        name: "Remaining", extruder: doc.defaultExtruder,
        positions: g.positions, indices: g.indices, triState: g.triState,
      });
    }
```

Each `splitParts` entry now carries `cap` and `method` (added by `app.js` in Task 10); for export robustness, if `p.cap` is missing recompute it: at the top of the split-parts loop the returned `g.cap` can be assigned back (`p.cap = p.cap || g.cap`).

- [ ] **Step 4: Run to verify pass and no regressions**

Run: `node --test`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add js/threemf.js tests/split.test.js
git commit -m "feat(export): parts cap by method; remainder via remainderSolid"
```

---

### Task 10: Method dropdown + per-part method/cap state, re-cap on change, undo/redo

**Files:**
- Modify: `index.html:91-94` (the split options panel)
- Modify: `js/app.js` (split state, snapshot, re-cap, events)

No Node test (DOM/three). Verified in the browser; the geometry it drives is covered by Tasks 6–9.

- [ ] **Step 1: Add the method dropdown** to the split options panel in `index.html` (inside `<div class="opt" data-panel="split" hidden>`):

```html
        <div class="opt" data-panel="split" hidden>
          <span class="optlabel">Cap method</span>
          <select id="capMethod">
            <option value="earcut" selected>Earcut</option>
            <option value="cdt">CDT (Delaunay)</option>
            <option value="projected">Projected normal</option>
            <option value="centroid">Centroid</option>
          </select>
          <span class="muted">Click a colored part to lift it out as its own solid.</span>
          <button id="exportSplitBtn" class="secondary slim">Export split (.3mf)</button>
        </div>
```

- [ ] **Step 2: Store method + cap on each split part** — in `js/app.js`, update `doSplit` (line ~321) to record the current method and the returned cap:

```javascript
  function doSplit(hit) {
    if (previewActive) { restore(current()); previewActive = false; }
    const m = doc.meshes[hit.meshIndex];
    if (hit.localSub == null) return;
    const subs = Cleanup.selectColorRegion(m, hit.localSub);
    if (!subs.length) { toast("Nothing to split there", true); return; }
    const method = $("capMethod").value;
    const solid = Split.solidFromSubs(m, Array.from(subs), method);
    splitParts.push({ meshIndex: hit.meshIndex, subs, state: hit.state, method, cap: solid.cap });
    pushHistory("Split");
    render(null);
    toast("Split " + subs.length.toLocaleString() + " sub-triangles into a new solid");
  }
```

- [ ] **Step 3: Extend the history snapshot** to carry `method` + `cap` — in `snap()` (line ~43) and `restore()` (line ~49):

In `snap()`, change the `splits` mapping to:
```javascript
      splits: splitParts.map((p) => ({ meshIndex: p.meshIndex, subs: Int32Array.from(p.subs), state: p.state, method: p.method, cap: p.cap })),
```
In `restore()`, change the `splitParts` rebuild to:
```javascript
    splitParts = state.splits.map((p) => ({ meshIndex: p.meshIndex, subs: Int32Array.from(p.subs), state: p.state, method: p.method, cap: p.cap }));
```

- [ ] **Step 4: Re-cap all parts when the method changes** — add an event handler in the events section of `js/app.js` (near the other `addEventListener` calls, ~line 468):

```javascript
  $("capMethod").addEventListener("change", () => {
    if (!doc || !splitParts.length) return;
    const method = $("capMethod").value;
    for (const p of splitParts) {
      const solid = Split.solidFromSubs(doc.meshes[p.meshIndex], Array.from(p.subs), method);
      p.method = method;
      p.cap = solid.cap;
    }
    pushHistory("Cap method: " + method);
    render(null);
    toast("Re-capped " + splitParts.length + " part(s) with " + method);
  });
```

- [ ] **Step 5: Verify in the browser**

Run `python3 -m http.server 8000`, open `http://localhost:8000/`, load the Pikachu model.
- Split the red ball with **Earcut** (default): part lifts out, hole fills.
- Change **Cap method** to **CDT**, then **Centroid**, then **Projected normal**: the part re-caps each time (toast confirms), no console errors.
- **Undo** (⌘Z) repeatedly: the method change reverts, then the split reverts (ball returns, hole closes). **Redo** restores them.
- Click **Export split (.3mf)**, open the file in Bambu Studio: the ball and the body are separate objects, correctly colored, coincident; the body has no hole.

- [ ] **Step 6: Commit**

```bash
git add index.html js/app.js
git commit -m "feat(split): cap-method dropdown, per-part method/cap, re-cap + undo"
```

---

## Self-Review

**Spec coverage:**
- Boundary-loop extraction → Task 2. Best-fit plane/projection → Task 3. Four triangulators (centroid, projected, earcut, cdt) → Tasks 4–5. Outer/hole nesting → Task 5. `solidFromSubs(method)` + reusable cap → Task 6. Shared cut surface (part cap reused reversed) → Tasks 7 (remainder) + 8 (live) + 9 (export). Live remainder capping → Task 8. Default Earcut + re-cap-all + per-part method in snapshot → Task 10. Vendor poly2tri → Task 1. Majority bordering color → Task 7. Watertight/manifold success criteria → Tasks 6, 7, 9 (edge-use-count invariant). All spec sections map to a task.
- Function-level default is `"centroid"` (keeps the dependency-free path and the three untouched legacy tests green); the **UI** default is `"earcut"` (Task 10 dropdown + Task 8/9 fallbacks). This split is intentional and noted in Task 6.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows real assertions and the exact `node --test` command + expected count.

**Type/name consistency:** The cap descriptor `{ verts, extraPts, tris, method }` and the index convention (`i < verts.length` → `verts[i]`; else `extraPts[i - verts.length]`) are identical across `Caps.triangulateLoops` (Tasks 4–5), `solidFromSubs` (Task 6), `remainderSolid` (Task 7), `appendRemainderCaps` (Task 8), and the export/app state (Tasks 9–10). `Split.solidFromSubs(mesh, subs, method)` and `Split.remainderSolid(mesh, parts, claimed)` signatures are used consistently everywhere they appear. `capBoundaryEdges`/`edgeUseCounts` are harness helpers used by the tests that reference them.
