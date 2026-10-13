# Volumetric Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split lifts a painted region out as a solid plug (patch + inward wall + bottom) and leaves a matching pocket in the remainder; both become ordinary document meshes, replacing the overlay model.

**Architecture:** New pure module `js/meshgeo.js` (closed-mesh check, triangle–triangle intersection, face grid + inward ray cast, cached bounds). `js/split.js` gains `plugSolids` (rim frame → wall/bottom → two meshes, with intersection-driven depth halving and a watertight gate) and loses the overlay solids. The viewer renders meshes flagged `part` with a display-only row offset; the app replaces `doc.meshes[i]` with `[remainder, part]` the way Cut does.

**Tech Stack:** Vanilla JS IIFEs, three.js (vendored), Node `node:test` + `tests/harness.js` vm sandbox.

**Spec:** `docs/superpowers/specs/2026-10-13-volumetric-split-design.md`

## Global Constraints

- Vanilla JS, no build step; new script `js/meshgeo.js` loads after `js/caps.js` and before `js/split.js` in `index.html` and `tests/harness.js`.
- Never `Read` a `.3mf`; untracked `.3mf` at repo root are the user's.
- After editing `js/`, restart the static server on a NEW port before browser checks.
- Depth: mm, default 3, min 0.3, max `modelSize / 2`; per-vertex `t = min(depth, 0.5·t_hit) · |cos θ|`.
- Bottom cap default `liepa`; `Cap method` only affects future splits.
- Refuse (no history entry) rather than emit a non-closed mesh.
- Export stays coincident (offsets are display-only).

## Review Focus

- **Depth input empty/NaN/negative** → treated as 0 (shell), never NaN geometry. Task 5 reads `Math.max(0, +value || 0)`; browser-checked in Task 5 Step 9.
- **Splitting a part again** → the new remainder keeps the `part` flag/label, the new part gets the next label; both stay in the row. Task 5 code + browser check.
- **Rotate (R popover) after a split** → bounds/grid caches invalidate and offsets recompute (`invalidateSub` clears `_bbox`/`_grid`). Task 1 test `meshBounds recomputes after invalidateSub`.
- **Cut tool with parts present** → parts are shown coincident while Cut is active so the plane preview is truthful (`Viewer.setLayout(false)`). Task 5 browser check.
- **Undo across a split** → mesh list, `part` flags and layout restore (history snapshots `meshList`). Task 5 browser check.

---

### Task 1: `MeshGeo` — closed check, tri–tri intersection, face grid, inward ray

**Files:**
- Create: `js/meshgeo.js`
- Modify: `index.html:273-274` (script tag), `tests/harness.js` (module list + export), `js/subgraph.js:27-33` (`invalidateSub`)
- Create: `tests/meshgeo.test.js`

**Interfaces:**
- Produces `window.MeshGeo = { meshBounds, checkClosed, triTriIntersect, faceGrid, rayHit }`:
  - `meshBounds(mesh) → { min:[x,y,z], max:[x,y,z], diag }` cached as `mesh._bbox`.
  - `checkClosed(mesh) → number` of undirected edges NOT traversed exactly once in each direction (0 = closed, consistently oriented). `mesh` is `{ nf, v1, v2, v3, positions }`.
  - `triTriIntersect(a0,a1,a2, b0,b1,b2) → bool` (each a `[x,y,z]`); coplanar pairs return `false`; touching counts as intersecting.
  - `faceGrid(mesh) → grid` cached as `mesh._grid`.
  - `rayHit(mesh, grid, ox,oy,oz, dx,dy,dz, tMin, backOnly) → t` (`Infinity` if none). `backOnly` accepts only faces whose outward normal has positive dot with the ray.

- [ ] **Step 1: Write the failing tests** — create `tests/meshgeo.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { loadModules, makeClosedCube, makeOpenTube, directedViolations } = require("./harness");

test("checkClosed: 0 for the cube, matches directedViolations on the open tube", () => {
  const { MeshGeo } = loadModules();
  const cube = makeClosedCube(), tube = makeOpenTube();
  assert.strictEqual(MeshGeo.checkClosed(cube), 0);
  const flat = (m) => { const I = []; for (let f = 0; f < m.nf; f++) I.push(m.v1[f], m.v2[f], m.v3[f]); return I; };
  assert.strictEqual(MeshGeo.checkClosed(tube), directedViolations(flat(tube)));
  assert.ok(MeshGeo.checkClosed(tube) > 0);
  // flip one cube face -> 3 edges now traversed twice in the same direction
  const bad = makeClosedCube(); const t = bad.v2[0]; bad.v2[0] = bad.v3[0]; bad.v3[0] = t;
  assert.strictEqual(MeshGeo.checkClosed(bad), 3);
});

test("triTriIntersect: crossing yes, separated no, coplanar no", () => {
  const { MeshGeo } = loadModules();
  const A = [[0, 0, 0], [2, 0, 0], [0, 2, 0]];           // z=0
  const B = [[0.5, 0.5, -1], [0.5, 0.5, 1], [1, 1, 1]];   // pierces A
  assert.strictEqual(MeshGeo.triTriIntersect(...A, ...B), true);
  const C = [[0.5, 0.5, 1], [0.5, 0.5, 2], [1, 1, 2]];    // entirely above
  assert.strictEqual(MeshGeo.triTriIntersect(...A, ...C), false);
  const D = [[0, 0, 0], [2, 0, 0], [0, 2, 0]];           // coplanar copy -> ignored
  assert.strictEqual(MeshGeo.triTriIntersect(...A, ...D), false);
  const E = [[5, 5, -1], [6, 5, 1], [5, 6, 1]];          // crosses z=0 outside A
  assert.strictEqual(MeshGeo.triTriIntersect(...A, ...E), false);
});

test("rayHit: inward ray from the cube top hits the bottom from behind at t=2; backOnly ignores front faces", () => {
  const { MeshGeo } = loadModules();
  const cube = makeClosedCube(); // [0,2]^3
  const grid = MeshGeo.faceGrid(cube);
  const t = MeshGeo.rayHit(cube, grid, 1, 1, 2, 0, 0, -1, 1e-4, true);
  assert.ok(Math.abs(t - 2) < 1e-6, "hit bottom at " + t);
  // from outside above the cube, pointing down: the top is a FRONT face -> backOnly skips it, bottom is hit at t=3
  const t2 = MeshGeo.rayHit(cube, grid, 1, 1, 3, 0, 0, -1, 1e-4, true);
  assert.ok(Math.abs(t2 - 3) < 1e-6, "backOnly skipped the top: " + t2);
  const t3 = MeshGeo.rayHit(cube, grid, 1, 1, 3, 0, 0, -1, 1e-4, false);
  assert.ok(Math.abs(t3 - 1) < 1e-6, "front hit allowed: " + t3);
  assert.strictEqual(MeshGeo.rayHit(cube, grid, 1, 1, 2, 0, 0, 1, 1e-4, true), Infinity, "upward ray leaves");
});

test("meshBounds recomputes after invalidateSub", () => {
  const { MeshGeo, Cleanup } = loadModules();
  const cube = makeClosedCube();
  const b = MeshGeo.meshBounds(cube);
  assert.deepStrictEqual([b.min, b.max], [[0, 0, 0], [2, 2, 2]]);
  cube.positions[0] = -1; // mutate; cached bounds are stale until invalidated
  assert.strictEqual(MeshGeo.meshBounds(cube).min[0], 0);
  Cleanup.invalidateSub(cube);
  assert.strictEqual(MeshGeo.meshBounds(cube).min[0], -1);
  assert.strictEqual(cube._grid, null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/meshgeo.test.js`
Expected: 4 FAIL — `Cannot destructure property 'MeshGeo'` / `MeshGeo is undefined`.

- [ ] **Step 3: Create `js/meshgeo.js`**

```js
/* meshgeo.js — pure mesh geometry utilities for solid construction: cached
 * bounds, directed closed-surface check, Möller triangle–triangle test, a
 * uniform face grid and a grid-marched ray cast. Depends on nothing. */
(function (global) {
  "use strict";

  // Axis-aligned bounds of mesh.positions, cached as mesh._bbox (cleared by
  // Cleanup.invalidateSub alongside the other mesh caches).
  function meshBounds(mesh) {
    if (mesh._bbox) return mesh._bbox;
    const P = mesh.positions;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) {
      for (let k = 0; k < 3; k++) { const v = P[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
    }
    if (!isFinite(min[0])) { min[0] = min[1] = min[2] = 0; max[0] = max[1] = max[2] = 0; }
    const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    return (mesh._bbox = { min, max, diag });
  }

  // Number of undirected edges NOT traversed exactly once in each direction.
  // 0 <=> closed and consistently oriented (the "directed watertight" test).
  function checkClosed(mesh) {
    const NV = mesh.positions.length / 3;
    const dir = new Map(); // directed key -> count
    const add = (u, v) => { const k = u * NV + v; dir.set(k, (dir.get(k) || 0) + 1); };
    for (let f = 0; f < mesh.nf; f++) {
      const a = mesh.v1[f], b = mesh.v2[f], c = mesh.v3[f];
      add(a, b); add(b, c); add(c, a);
    }
    let bad = 0;
    const seen = new Set();
    for (const k of dir.keys()) {
      const u = Math.floor(k / NV), v = k - u * NV;
      const uk = u < v ? k : v * NV + u;
      if (seen.has(uk)) continue;
      seen.add(uk);
      if ((dir.get(u * NV + v) || 0) !== 1 || (dir.get(v * NV + u) || 0) !== 1) bad++;
    }
    return bad;
  }

  // Möller 1997 "NoDivTriTriIsect" with the epsilon test. Coplanar -> false
  // (we never need coplanar overlap for self-intersection screening).
  const EPS = 1e-9;
  function triTriIntersect(V0, V1, V2, U0, U1, U2) {
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const N1 = cross(sub(V1, V0), sub(V2, V0));
    const d1 = -dot(N1, V0);
    let du0 = dot(N1, U0) + d1, du1 = dot(N1, U1) + d1, du2 = dot(N1, U2) + d1;
    if (Math.abs(du0) < EPS) du0 = 0; if (Math.abs(du1) < EPS) du1 = 0; if (Math.abs(du2) < EPS) du2 = 0;
    const du0du1 = du0 * du1, du0du2 = du0 * du2;
    if (du0du1 > 0 && du0du2 > 0) return false;
    const N2 = cross(sub(U1, U0), sub(U2, U0));
    const d2 = -dot(N2, U0);
    let dv0 = dot(N2, V0) + d2, dv1 = dot(N2, V1) + d2, dv2 = dot(N2, V2) + d2;
    if (Math.abs(dv0) < EPS) dv0 = 0; if (Math.abs(dv1) < EPS) dv1 = 0; if (Math.abs(dv2) < EPS) dv2 = 0;
    const dv0dv1 = dv0 * dv1, dv0dv2 = dv0 * dv2;
    if (dv0dv1 > 0 && dv0dv2 > 0) return false;
    const D = cross(N1, N2);
    let idx = 0, mx = Math.abs(D[0]);
    if (Math.abs(D[1]) > mx) { mx = Math.abs(D[1]); idx = 1; }
    if (Math.abs(D[2]) > mx) idx = 2;
    const vp0 = V0[idx], vp1 = V1[idx], vp2 = V2[idx];
    const up0 = U0[idx], up1 = U1[idx], up2 = U2[idx];
    // returns [A, B, C, X0, X1] or null when coplanar
    const intervals = (VV0, VV1, VV2, D0, D1, D2, D0D1, D0D2) => {
      if (D0D1 > 0) return [VV2, (VV0 - VV2) * D2, (VV1 - VV2) * D2, D2 - D0, D2 - D1];
      if (D0D2 > 0) return [VV1, (VV0 - VV1) * D1, (VV2 - VV1) * D1, D1 - D0, D1 - D2];
      if (D1 * D2 > 0 || D0 !== 0) return [VV0, (VV1 - VV0) * D0, (VV2 - VV0) * D0, D0 - D1, D0 - D2];
      if (D1 !== 0) return [VV1, (VV0 - VV1) * D1, (VV2 - VV1) * D1, D1 - D0, D1 - D2];
      if (D2 !== 0) return [VV2, (VV0 - VV2) * D2, (VV1 - VV2) * D2, D2 - D0, D2 - D1];
      return null;
    };
    const I1 = intervals(vp0, vp1, vp2, dv0, dv1, dv2, dv0dv1, dv0dv2);
    const I2 = intervals(up0, up1, up2, du0, du1, du2, du0du1, du0du2);
    if (!I1 || !I2) return false;
    const [a, b, c, x0, x1] = I1, [d, e, f, y0, y1] = I2;
    const xx = x0 * x1, yy = y0 * y1, xxyy = xx * yy;
    let tmp = a * xxyy;
    let i10 = tmp + b * x1 * yy, i11 = tmp + c * x0 * yy;
    tmp = d * xxyy;
    let i20 = tmp + e * xx * y1, i21 = tmp + f * xx * y0;
    if (i10 > i11) { const s = i10; i10 = i11; i11 = s; }
    if (i20 > i21) { const s = i20; i20 = i21; i21 = s; }
    return !(i11 < i20 || i21 < i10);
  }

  // Uniform grid over face AABBs (CSR), cached as mesh._grid.
  function faceGrid(mesh) {
    if (mesh._grid) return mesh._grid;
    const b = meshBounds(mesh);
    const P = mesh.positions, nf = mesh.nf;
    const n = Math.max(8, Math.min(64, Math.round(Math.cbrt(nf))));
    const cell = [0, 1, 2].map((k) => ((b.max[k] - b.min[k]) || 1e-9) / n);
    const ci = (x, k) => Math.max(0, Math.min(n - 1, Math.floor((x - b.min[k]) / cell[k])));
    const lo = new Int32Array(nf * 3), hi = new Int32Array(nf * 3);
    const count = new Int32Array(n * n * n);
    for (let f = 0; f < nf; f++) {
      const a = mesh.v1[f] * 3, b2 = mesh.v2[f] * 3, c = mesh.v3[f] * 3;
      for (let k = 0; k < 3; k++) {
        const x0 = P[a + k], x1 = P[b2 + k], x2 = P[c + k];
        lo[f * 3 + k] = ci(Math.min(x0, x1, x2), k); hi[f * 3 + k] = ci(Math.max(x0, x1, x2), k);
      }
      for (let x = lo[f * 3]; x <= hi[f * 3]; x++) for (let y = lo[f * 3 + 1]; y <= hi[f * 3 + 1]; y++)
        for (let z = lo[f * 3 + 2]; z <= hi[f * 3 + 2]; z++) count[(x * n + y) * n + z]++;
    }
    const start = new Int32Array(n * n * n + 1);
    for (let i = 0; i < count.length; i++) start[i + 1] = start[i] + count[i];
    const list = new Int32Array(start[count.length]);
    const cur = start.slice(0, count.length);
    for (let f = 0; f < nf; f++) {
      for (let x = lo[f * 3]; x <= hi[f * 3]; x++) for (let y = lo[f * 3 + 1]; y <= hi[f * 3 + 1]; y++)
        for (let z = lo[f * 3 + 2]; z <= hi[f * 3 + 2]; z++) list[cur[(x * n + y) * n + z]++] = f;
    }
    return (mesh._grid = { n, min: b.min, max: b.max, cell, start, list, stamp: new Int32Array(nf), stampId: 0 });
  }

  // Möller–Trumbore; returns t or Infinity. backOnly: require dot(dir, e1×e2) > 0.
  function rayTri(P, mesh, f, ox, oy, oz, dx, dy, dz, tMin, backOnly) {
    const a = mesh.v1[f] * 3, b = mesh.v2[f] * 3, c = mesh.v3[f] * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) return Infinity;
    if (backOnly && det >= 0) return Infinity; // det = dir·(e1×e2) < 0 means front-facing... see note
    const inv = 1 / det;
    const tx = ox - P[a], ty = oy - P[a + 1], tz = oz - P[a + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) return Infinity;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) return Infinity;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return t > tMin ? t : Infinity;
  }
  // NOTE on the sign: det = (dir × e2)·e1 = dir·(e2 × e1) = −dir·(e1 × e2). A back-face
  // hit (dir along the outward normal e1×e2) therefore has det < 0.

  // March the grid along the ray; first accepted hit.
  function rayHit(mesh, grid, ox, oy, oz, dx, dy, dz, tMin, backOnly) {
    const P = mesh.positions;
    const { n, min, max, cell, start, list, stamp } = grid;
    const sid = ++grid.stampId;
    // clip the ray to the grid box
    let t0 = 0, t1 = Infinity;
    const o = [ox, oy, oz], d = [dx, dy, dz];
    for (let k = 0; k < 3; k++) {
      if (Math.abs(d[k]) < 1e-15) { if (o[k] < min[k] - 1e-9 || o[k] > max[k] + 1e-9) return Infinity; continue; }
      let ta = (min[k] - o[k]) / d[k], tb = (max[k] - o[k]) / d[k];
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
      if (t0 > t1) return Infinity;
    }
    const sx = ox + dx * t0, sy = oy + dy * t0, sz = oz + dz * t0;
    const cur = [0, 1, 2].map((k) => Math.max(0, Math.min(n - 1, Math.floor((([sx, sy, sz][k]) - min[k]) / cell[k]))));
    const step = d.map((v) => (v > 0 ? 1 : v < 0 ? -1 : 0));
    const tMax = [0, 1, 2].map((k) => step[k] === 0 ? Infinity : ((min[k] + (cur[k] + (step[k] > 0 ? 1 : 0)) * cell[k]) - o[k]) / d[k]);
    const tDelta = [0, 1, 2].map((k) => step[k] === 0 ? Infinity : cell[k] / Math.abs(d[k]));
    let best = Infinity;
    for (let guard = 0; guard < 3 * n + 3; guard++) {
      const c = (cur[0] * n + cur[1]) * n + cur[2];
      for (let i = start[c]; i < start[c + 1]; i++) {
        const f = list[i];
        if (stamp[f] === sid) continue;
        stamp[f] = sid;
        const t = rayTri(P, mesh, f, ox, oy, oz, dx, dy, dz, tMin, backOnly);
        if (t < best) best = t;
      }
      const k = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      if (best <= tMax[k]) break;
      cur[k] += step[k];
      if (cur[k] < 0 || cur[k] >= n) break;
      tMax[k] += tDelta[k];
    }
    return best;
  }

  global.MeshGeo = { meshBounds, checkClosed, triTriIntersect, faceGrid, rayHit };
})(window);
```

In `rayTri`, keep the `backOnly` test as written (`det >= 0 → reject`); the NOTE explains why a back-face hit has `det < 0`. If the rayHit test's `t2`/`t3` expectations fail with the sign the other way, the fixture winding is what to re-check (cube faces are outward-wound), not the math.

- [ ] **Step 4: Wire the module** — `index.html`: insert `    <script src="js/meshgeo.js"></script>` between the `caps.js` and `split.js` script tags. `tests/harness.js`: add `"js/meshgeo.js",` after `"js/caps.js",` in the module list and `MeshGeo: sandbox.MeshGeo,` in the returned object. `js/subgraph.js` `invalidateSub`: add two lines

```js
    mesh._bbox = null;
    mesh._grid = null;
```

after `mesh._faceG = null;`.

- [ ] **Step 5: Run to verify pass**

Run: `node --test tests/meshgeo.test.js`
Expected: 4 PASS.

- [ ] **Step 6: Full suite + commit**

Run: `npm test` → Expected: all pass (99 + 4).

```bash
git add js/meshgeo.js index.html tests/harness.js js/subgraph.js tests/meshgeo.test.js
git commit -m "feat: MeshGeo — closed check, tri-tri test, face grid and inward ray cast"
```

---

### Task 2: Fixtures + rim analysis (`patchBoundary`, `rimFrame`)

**Files:**
- Modify: `tests/harness.js` (add `makeGridBox`, `makeRoofPrism`, exports)
- Modify: `js/split.js` (add `patchBoundary`, `rimFrame`; export both)
- Create: `tests/plug.test.js`

**Interfaces:**
- Consumes: `Cleanup.buildSubGraph(mesh) → { sv, vx, vy, vz, NV, subLeaf, midOf, NS, start, list }`, `Caps.extractLoops(directedEdges)`, `Caps.bestFitPlane(pts) → { nx, ny, nz, ... }`, `MeshGeo.faceGrid/rayHit/meshBounds`.
- Produces:
  - `Split.patchBoundary(mesh, subs, g) → { loops: gid[][] (surface-directed), surfDir: Map<edgeKey,"u>v">, pinch: bool }` where `edgeKey = a<b ? a+"_"+b : b+"_"+a`.
  - `Split.rimFrame(mesh, g, loops, depth, grid) → { dir: Map<gid,[x,y,z]> (inward unit), t: Map<gid,number> }`.
  - Harness: `makeGridBox(n, sx, sy, sz) → mesh` with `mesh.side[f]` (`"top"|"bottom"|"front"|"back"|"left"|"right"`) and all paints `""`; `makeRoofPrism(w, h, len, n) → mesh` (gridded; `mesh.side[f]` names the face: `left`/`right` are the slopes).

- [ ] **Step 1: Add fixtures to `tests/harness.js`** (before `module.exports`), and export them:

```js
// Closed box [0,sx]x[0,sy]x[0,sz] with every side an n x n grid of quads
// (2 tris each), vertices welded by coordinate so edges match across sides.
// Outward-wound. mesh.side[f] names the side of face f. Volume = sx*sy*sz.
function makeGridBox(n, sx, sy, sz) {
  const pos = [], key = new Map(), v1 = [], v2 = [], v3 = [], side = [];
  const vid = (x, y, z) => {
    const k = x.toFixed(9) + "," + y.toFixed(9) + "," + z.toFixed(9);
    let i = key.get(k);
    if (i === undefined) { i = pos.length / 3; key.set(k, i); pos.push(x, y, z); }
    return i;
  };
  // [name, origin, U, V] with U x V pointing OUTWARD
  const sides = [
    ["top",    [0, 0, sz], [sx, 0, 0], [0, sy, 0]],
    ["bottom", [0, 0, 0],  [0, sy, 0], [sx, 0, 0]],
    ["front",  [0, 0, 0],  [sx, 0, 0], [0, 0, sz]],
    ["back",   [0, sy, 0], [0, 0, sz], [sx, 0, 0]],
    ["left",   [0, 0, 0],  [0, 0, sz], [0, sy, 0]],
    ["right",  [sx, 0, 0], [0, sy, 0], [0, 0, sz]],
  ];
  for (const [name, O, U, V] of sides) {
    const P = (i, j) => vid(O[0] + U[0] * i / n + V[0] * j / n, O[1] + U[1] * i / n + V[1] * j / n, O[2] + U[2] * i / n + V[2] * j / n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
      v1.push(a, a); v2.push(b, c); v3.push(c, d); side.push(name, name);
    }
  }
  return {
    nf: v1.length, positions: new Float32Array(pos),
    v1: Int32Array.from(v1), v2: Int32Array.from(v2), v3: Int32Array.from(v3),
    paints: v1.map(() => ""), side,
  };
}

// Gridded triangular prism ("roof"): cross-section (0,0),(w,0),(w/2,h) in XY,
// extruded along z in [0,len]. Every face is subdivided n ways (slopes and
// base n x n quads, ends n^2 triangles), vertices welded by coordinate so the
// grids match across edges. Outward-wound. mesh.side[f] in
// "left"|"right"|"base"|"end0"|"end1". Volume = w*h*len/2. nf = 8*n*n.
function makeRoofPrism(w, h, len, n) {
  const pos = [], key = new Map(), v1 = [], v2 = [], v3 = [], side = [];
  const vid = (x, y, z) => {
    const k = x.toFixed(9) + "," + y.toFixed(9) + "," + z.toFixed(9);
    let i = key.get(k);
    if (i === undefined) { i = pos.length / 3; key.set(k, i); pos.push(x, y, z); }
    return i;
  };
  const at = (O, U, V, i, j) => vid(O[0] + U[0] * i / n + V[0] * j / n, O[1] + U[1] * i / n + V[1] * j / n, O[2] + U[2] * i / n + V[2] * j / n);
  const tri = (a, b, c, name) => { v1.push(a); v2.push(b); v3.push(c); side.push(name); };
  // quad grids: [name, origin, U, V] with U x V outward
  for (const [name, O, U, V] of [
    ["left",  [0, 0, 0], [0, 0, len], [w / 2, h, 0]],
    ["right", [w, 0, 0], [-w / 2, h, 0], [0, 0, len]],
    ["base",  [0, 0, 0], [w, 0, 0], [0, 0, len]],
  ]) {
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const a = at(O, U, V, i, j), b = at(O, U, V, i + 1, j), c = at(O, U, V, i + 1, j + 1), d = at(O, U, V, i, j + 1);
      tri(a, b, c, name); tri(a, c, d, name);
    }
  }
  // end caps: barycentric subdivision of (A,B,C), same orientation as (A,B,C)
  for (const [name, A, B, C] of [
    ["end0", [0, 0, 0], [w / 2, h, 0], [w, 0, 0]],
    ["end1", [0, 0, len], [w, 0, len], [w / 2, h, len]],
  ]) {
    const U = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], V = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) {
      tri(at(A, U, V, i, j), at(A, U, V, i + 1, j), at(A, U, V, i, j + 1), name);
      if (i + j < n - 1) tri(at(A, U, V, i + 1, j), at(A, U, V, i + 1, j + 1), at(A, U, V, i, j + 1), name);
    }
  }
  return {
    nf: v1.length, positions: new Float32Array(pos),
    v1: Int32Array.from(v1), v2: Int32Array.from(v2), v3: Int32Array.from(v3),
    paints: v1.map(() => ""), side,
  };
}
```

Export: add `makeGridBox, makeRoofPrism` to `module.exports`.

- [ ] **Step 2: Write the failing tests** — create `tests/plug.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { loadModules, makeGridBox, makeRoofPrism, signedVolume } = require("./harness");

const flat = (m) => { const I = []; for (let f = 0; f < m.nf; f++) I.push(m.v1[f], m.v2[f], m.v3[f]); return I; };
const vol = (m) => signedVolume(flat(m), m.positions);
// faces whose centroid satisfies pred(x,y,z) -> paint them `state`; returns face list
function paintWhere(mesh, pred, state) {
  const P = mesh.positions, out = [];
  for (let f = 0; f < mesh.nf; f++) {
    const a = mesh.v1[f] * 3, b = mesh.v2[f] * 3, c = mesh.v3[f] * 3;
    const x = (P[a] + P[b] + P[c]) / 3, y = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, z = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    if (pred(x, y, z)) { mesh.paints[f] = String(state << 2); out.push(f); } // solid leaf: nibble (state<<2)
  }
  return out;
}
// seed sub of a state (solid faces: sub index == face index)
function regionOf(Cleanup, mesh, state) {
  const g = Cleanup.buildSubGraph(mesh);
  const seed = [...Array(g.NS).keys()].find((i) => g.subLeaf[i].state === state);
  return Cleanup.selectColorRegion(mesh, seed);
}

test("fixtures: grid box and roof prism are closed with the expected volume", () => {
  const { MeshGeo } = loadModules();
  const box = makeGridBox(4, 4, 4, 4), roof = makeRoofPrism(4, 3, 2, 4);
  assert.strictEqual(MeshGeo.checkClosed(box), 0);
  assert.ok(Math.abs(vol(box) - 64) < 1e-6, "box volume " + vol(box));
  assert.strictEqual(MeshGeo.checkClosed(roof), 0);
  assert.ok(Math.abs(vol(roof) - 12) < 1e-6, "roof volume " + vol(roof));
  assert.strictEqual(box.nf, 6 * 16 * 2);
  assert.strictEqual(roof.nf, 8 * 16);
});

test("patchBoundary: one surface-directed loop around a central top block", () => {
  const { Cleanup, Split } = loadModules();
  const box = makeGridBox(4, 4, 4, 4);
  paintWhere(box, (x, y, z) => z === 4 && x > 1 && x < 3 && y > 1 && y < 3, 1);
  const subs = regionOf(Cleanup, box, 1);
  assert.strictEqual(subs.length, 8);
  const g = Cleanup.buildSubGraph(box);
  const b = Split.patchBoundary(box, subs, g);
  assert.strictEqual(b.pinch, false);
  assert.strictEqual(b.loops.length, 1);
  assert.strictEqual(b.loops[0].length, 8);
  // consecutive pairs follow the surface direction recorded in surfDir
  const L = b.loops[0];
  for (let i = 0; i < L.length; i++) {
    const u = L[i], v = L[(i + 1) % L.length];
    assert.strictEqual(b.surfDir.get(u < v ? u + "_" + v : v + "_" + u), u + ">" + v);
  }
});

test("patchBoundary flags a pinch (two holes meeting at a vertex)", () => {
  const { Cleanup, Split } = loadModules();
  const box = makeGridBox(4, 4, 4, 4);
  const hole = (x, y) => (x > 1 && x < 2 && y > 1 && y < 2) || (x > 2 && x < 3 && y > 2 && y < 3);
  paintWhere(box, (x, y, z) => z === 4 && !hole(x, y), 1);
  const subs = regionOf(Cleanup, box, 1);
  assert.strictEqual(Split.patchBoundary(box, subs, Cleanup.buildSubGraph(box)).pinch, true);
});

test("rimFrame: flat interior rim -> straight down, t = depth; slab clamps to half thickness", () => {
  const { Cleanup, Split, MeshGeo } = loadModules();
  for (const [sz, depth, want] of [[4, 0.5, 0.5], [0.5, 10, 0.25]]) {
    const box = makeGridBox(4, 4, 4, sz);
    paintWhere(box, (x, y, z) => z === sz && x > 1 && x < 3 && y > 1 && y < 3, 1);
    const subs = regionOf(Cleanup, box, 1);
    const g = Cleanup.buildSubGraph(box);
    const b = Split.patchBoundary(box, subs, g);
    const fr = Split.rimFrame(box, g, b.loops, depth, MeshGeo.faceGrid(box));
    for (const gid of b.loops[0]) {
      const d = fr.dir.get(gid);
      assert.ok(Math.abs(d[0]) < 1e-6 && Math.abs(d[1]) < 1e-6 && Math.abs(d[2] + 1) < 1e-6, "inward -z: " + d);
      assert.ok(Math.abs(fr.t.get(gid) - want) < 1e-6, "t=" + fr.t.get(gid) + " want " + want);
    }
  }
});

test("rimFrame: cross-section rim (upper half of the box) gets no wall", () => {
  const { Cleanup, Split, MeshGeo } = loadModules();
  const box = makeGridBox(4, 4, 4, 4);
  paintWhere(box, (x, y, z) => z > 2, 1); // top + upper two rows of every side
  const subs = regionOf(Cleanup, box, 1);
  const g = Cleanup.buildSubGraph(box);
  const b = Split.patchBoundary(box, subs, g);
  assert.strictEqual(b.loops.length, 1);
  const fr = Split.rimFrame(box, g, b.loops, 1, MeshGeo.faceGrid(box));
  for (const gid of b.loops[0]) assert.ok(fr.t.get(gid) < 1e-6, "t " + fr.t.get(gid));
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test tests/plug.test.js`
Expected: fixture test PASS (Task 1 code), the other 4 FAIL with `Split.patchBoundary is not a function`.

- [ ] **Step 4: Implement in `js/split.js`** — add after `orientCapComponents` (before `remainderSolid`):

```js
  const ekey = (a, b) => (a < b ? a + "_" + b : b + "_" + a);

  // Conformed boundary of a sub-triangle set: surface-directed rim loops (gids
  // from the welded sub graph), the surface direction of every rim edge, and a
  // pinch flag (a rim vertex with != 2 rim edges — the region touches itself).
  function patchBoundary(mesh, subs, g) {
    const { sv, midOf } = g;
    const decompose = (u, v) => {
      const m = midOf ? midOf(u, v) : -1;
      return (m >= 0 && m !== u && m !== v) ? decompose(u, m).concat(decompose(m, v).slice(1)) : [u, v];
    };
    const edges = new Map(); // key -> { u, v, count }
    for (let k = 0; k < subs.length; k++) {
      const s = subs[k];
      const a = sv[s * 3], b = sv[s * 3 + 1], c = sv[s * 3 + 2];
      const poly = decompose(a, b).concat(decompose(b, c).slice(1), decompose(c, a).slice(1, -1));
      for (let i = 0; i < poly.length; i++) {
        const u = poly[i], v = poly[(i + 1) % poly.length], key = ekey(u, v);
        const e = edges.get(key);
        if (e) e.count++; else edges.set(key, { u, v, count: 1 });
      }
    }
    const directed = [], surfDir = new Map(), deg = new Map();
    for (const [key, e] of edges) {
      if (e.count !== 1) continue;
      directed.push([e.u, e.v]);
      surfDir.set(key, e.u + ">" + e.v);
      deg.set(e.u, (deg.get(e.u) || 0) + 1); deg.set(e.v, (deg.get(e.v) || 0) + 1);
    }
    let pinch = false;
    for (const d of deg.values()) if (d !== 2) { pinch = true; break; }
    const loops = pinch ? [] : Caps.extractLoops(directed);
    return { loops, surfDir, pinch };
  }

  // Inward direction and depth for every rim vertex. dir = −(smoothed model
  // normal); t = min(depth, 0.5·t_hit) · |cos θ| (θ: normal vs the loop's
  // best-fit plane normal) — see the spec's "Per-rim-vertex depth".
  function rimFrame(mesh, g, loops, depth, grid) {
    const { sv, vx, vy, vz, NS } = g;
    const rim = new Set(); for (const L of loops) for (const gid of L) rim.add(gid);
    const acc = new Map(); for (const gid of rim) acc.set(gid, [0, 0, 0]);
    for (let s = 0; s < NS; s++) {
      const a = sv[s * 3], b = sv[s * 3 + 1], c = sv[s * 3 + 2];
      if (!rim.has(a) && !rim.has(b) && !rim.has(c)) continue;
      const ux = vx[b] - vx[a], uy = vy[b] - vy[a], uz = vz[b] - vz[a];
      const wx = vx[c] - vx[a], wy = vy[c] - vy[a], wz = vz[c] - vz[a];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx; // area-weighted
      for (const gid of [a, b, c]) { const t = acc.get(gid); if (t) { t[0] += nx; t[1] += ny; t[2] += nz; } }
    }
    const unit = (v) => { const L = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / L, v[1] / L, v[2] / L]; };
    const dir = new Map(), t = new Map();
    const diag = MeshGeo.meshBounds(mesh).diag;
    for (const L of loops) {
      let N = L.map((gid) => unit(acc.get(gid)));
      for (let pass = 0; pass < 2; pass++) // two 1-ring smoothing passes along the loop
        N = N.map((n, i) => { const p = N[(i + L.length - 1) % L.length], q = N[(i + 1) % L.length]; return unit([p[0] + n[0] + q[0], p[1] + n[1] + q[1], p[2] + n[2] + q[2]]); });
      const pl = Caps.bestFitPlane(L.map((gid) => [vx[gid], vy[gid], vz[gid]]));
      L.forEach((gid, i) => {
        const n = N[i], d = [-n[0], -n[1], -n[2]];
        const w = Math.abs(n[0] * pl.nx + n[1] * pl.ny + n[2] * pl.nz);
        const hit = MeshGeo.rayHit(mesh, grid, vx[gid], vy[gid], vz[gid], d[0], d[1], d[2], 1e-4 * diag, true);
        dir.set(gid, d);
        t.set(gid, Math.min(depth, 0.5 * hit) * w);
      });
    }
    return { dir, t };
  }
```

Add `patchBoundary, rimFrame,` to the `global.Split = { ... }` export.

- [ ] **Step 5: Run to verify pass**

Run: `node --test tests/plug.test.js`
Expected: 5 PASS. If the cross-section test shows `t` ≈ 1e-3 instead of < 1e-6, the smoothing is leaking vertical components from the cube's vertical edges — check that `acc` only sums incident sub normals (all horizontal on the sides) and that `w` uses the loop normal (`pl.n*`), not the vertex normal.

- [ ] **Step 6: Commit**

```bash
git add tests/harness.js js/split.js tests/plug.test.js
git commit -m "feat: split rim analysis — patchBoundary and rimFrame + grid box / roof fixtures"
```

---

### Task 3: `Split.plugSolids` — wall, bottom, two meshes, halving, gate

**Files:**
- Modify: `js/split.js` (add `buildPlug`, `anyIntersection`, `plugSolids`; export `plugSolids`)
- Test: `tests/plug.test.js`

**Interfaces:**
- Consumes: Task 2 functions, `openSurface(mesh, subs, g) → { px, py, pz, F, triSt, lid }`, `orientCapComponents(cap, surfDir)`, `majorityBorderColor(mesh, g, { subs, state })`, `Caps.triangulateLoops(loops, getPt, method) → { verts, extraPts, tris }`, `Paint.encode`, `MeshGeo.*`.
- Produces: `Split.plugSolids(mesh, subs, { depth, method }) → { part, remainder, info: { halvings, shell, faces } } | { error, info? }` (gate errors carry `info`). `part`/`remainder` are `{ positions: Float32Array, nf, v1, v2, v3: Int32Array, paints: string[] }`.
- Also `MeshGeo.signedVolume(mesh)`; the gate requires `checkClosed === 0` AND `signedVolume > 0` for both outputs.
- **Amended during execution (see ledger rulings):** the roof "halving" premise was wrong — the roof and a through-groove (`makeUChannel`) are POSITIVE cases (no halving); the refusal/halving case is a closed pocket (`makePocketBox`), whose flat bottom cap crosses the pocket walls → 4 halvings → inside-out shell → refused by the volume gate.

- [ ] **Step 1: Write the failing tests** — append to `tests/plug.test.js`:

```js
const closed = (MeshGeo, m, label) => assert.strictEqual(MeshGeo.checkClosed(m), 0, label + " closed");

test("plugSolids: flat plug — volumes sum, bottom at depth, both closed", () => {
  const { Cleanup, Split, MeshGeo } = loadModules();
  const box = makeGridBox(4, 4, 4, 4);
  paintWhere(box, (x, y, z) => z === 4 && x > 1 && x < 3 && y > 1 && y < 3, 1);
  const r = Split.plugSolids(box, regionOf(Cleanup, box, 1), { depth: 0.5 });
  assert.ok(!r.error, r.error);
  closed(MeshGeo, r.part, "part"); closed(MeshGeo, r.remainder, "remainder");
  assert.ok(Math.abs(vol(r.part) - 2) < 1e-6, "part volume " + vol(r.part));
  assert.ok(Math.abs(vol(r.remainder) - 62) < 1e-6, "remainder volume " + vol(r.remainder));
  let minZ = Infinity; for (let i = 2; i < r.part.positions.length; i += 3) minZ = Math.min(minZ, r.part.positions[i]);
  assert.ok(Math.abs(minZ - 3.5) < 1e-6, "bottom at 3.5, got " + minZ);
  assert.strictEqual(r.info.halvings, 0);
  // colors: every part triangle is state 1 ("4"); remainder pocket carries the border color (0 -> "")
  assert.ok(r.part.paints.every((p) => p === "4"));
  assert.strictEqual(r.remainder.paints.filter((p) => p === "4").length, 0);
});

test("plugSolids: slab clamps depth to half thickness", () => {
  const { Cleanup, Split, MeshGeo } = loadModules();
  const slab = makeGridBox(4, 4, 4, 0.5);
  paintWhere(slab, (x, y, z) => z === 0.5 && x > 1 && x < 3 && y > 1 && y < 3, 1);
  const r = Split.plugSolids(slab, regionOf(Cleanup, slab, 1), { depth: 10 });
  assert.ok(!r.error, r.error);
  closed(MeshGeo, r.part, "part"); closed(MeshGeo, r.remainder, "remainder");
  assert.ok(Math.abs(vol(r.part) - 1) < 1e-6, "part volume " + vol(r.part));
  assert.ok(Math.abs(vol(r.part) + vol(r.remainder) - 8) < 1e-6);
});

test("plugSolids: cross-section rim adds no wall (part == lens)", () => {
  const { Cleanup, Split, MeshGeo } = loadModules();
  const box = makeGridBox(4, 4, 4, 4);
  const faces = paintWhere(box, (x, y, z) => z > 2, 1);
  const r = Split.plugSolids(box, regionOf(Cleanup, box, 1), { depth: 1, method: "earcut" });
  assert.ok(!r.error, r.error);
  closed(MeshGeo, r.part, "part"); closed(MeshGeo, r.remainder, "remainder");
  assert.ok(Math.abs(vol(r.part) - 32) < 1e-6, "lens volume " + vol(r.part));
  assert.ok(Math.abs(vol(r.remainder) - 32) < 1e-6);
  // no wall: every part vertex is on the original surface (z >= 2)
  for (let i = 2; i < r.part.positions.length; i += 3) assert.ok(r.part.positions[i] >= 2 - 1e-9);
  assert.ok(r.part.nf >= faces.length, "patch kept");
});

test("plugSolids: convex ridge forces depth halving, output still closed", () => {
  const { Cleanup, Split, MeshGeo } = loadModules();
  const roof = makeRoofPrism(4, 3, 2, 4);
  // band over the ridge: the upper half of both slopes. Inward rays from the
  // two mid-lines converge under the ridge and (at half the far-wall distance)
  // still cross each other -> the first plug self-intersects -> halving.
  const P = roof.positions;
  for (let f = 0; f < roof.nf; f++) {
    const y = (P[roof.v1[f] * 3 + 1] + P[roof.v2[f] * 3 + 1] + P[roof.v3[f] * 3 + 1]) / 3;
    if ((roof.side[f] === "left" || roof.side[f] === "right") && y > 1.5) roof.paints[f] = "4";
  }
  const r = Split.plugSolids(roof, regionOf(Cleanup, roof, 1), { depth: 10 });
  assert.ok(!r.error, r.error);
  assert.ok(r.info.halvings >= 1, "halvings " + r.info.halvings);
  closed(MeshGeo, r.part, "part"); closed(MeshGeo, r.remainder, "remainder");
  assert.ok(Math.abs(vol(r.part) + vol(r.remainder) - 12) < 1e-6);
  assert.ok(vol(r.part) > 0 && vol(r.remainder) > 0);
});

test("plugSolids refuses pinch, whole-mesh and empty regions", () => {
  const { Cleanup, Split } = loadModules();
  const box = makeGridBox(4, 4, 4, 4);
  const hole = (x, y) => (x > 1 && x < 2 && y > 1 && y < 2) || (x > 2 && x < 3 && y > 2 && y < 3);
  paintWhere(box, (x, y, z) => z === 4 && !hole(x, y), 1);
  assert.match(Split.plugSolids(box, regionOf(Cleanup, box, 1), { depth: 1 }).error, /touches itself/);
  const all = makeGridBox(2, 2, 2, 2);
  paintWhere(all, () => true, 1);
  assert.match(Split.plugSolids(all, regionOf(Cleanup, all, 1), { depth: 1 }).error, /whole object/);
  assert.match(Split.plugSolids(all, [], { depth: 1 }).error, /Nothing/);
});

test("plugSolids: refined (subdivided) paint splits to closed outputs", () => {
  const { Cleanup, Split, MeshGeo, Paint } = loadModules();
  const box = makeGridBox(2, 4, 4, 4);
  const top = paintWhere(box, (x, y, z) => z === 4, 1);
  const leaf = { leaf: true, state: 1 };
  box.paints[top[0]] = Paint.encode({ leaf: false, split: 3, special: 0, kids: [leaf, leaf, leaf, leaf] });
  const r = Split.plugSolids(box, regionOf(Cleanup, box, 1), { depth: 1 });
  assert.ok(!r.error, r.error);
  closed(MeshGeo, r.part, "part"); closed(MeshGeo, r.remainder, "remainder");
  assert.ok(Math.abs(vol(r.part) + vol(r.remainder) - 64) < 1e-6);
});

test("plugSolids: chained split -> split on remainder -> plane cut conserves volume", () => {
  const { Cleanup, Split, MeshGeo, PlaneCut } = loadModules();
  const box = makeGridBox(4, 4, 4, 4);
  paintWhere(box, (x, y, z) => z === 4 && x > 1 && x < 3 && y > 1 && y < 3, 1);
  paintWhere(box, (x, y, z) => x === 4 && z > 1 && z < 3 && y > 1 && y < 3, 2);
  const a = Split.plugSolids(box, regionOf(Cleanup, box, 1), { depth: 0.5 });
  assert.ok(!a.error, a.error);
  const b = Split.plugSolids(a.remainder, regionOf(Cleanup, a.remainder, 2), { depth: 0.7 });
  assert.ok(!b.error, b.error);
  const cut = PlaneCut.cutMesh(a.part, { px: 0, py: 0, pz: 3.75, nx: 0, ny: 0, nz: 1 });
  assert.ok(cut.above && cut.below, "plane crosses the part");
  const pieces = [b.remainder, b.part, cut.above, cut.below];
  for (const m of pieces) closed(MeshGeo, m, "piece");
  const total = pieces.reduce((s, m) => s + vol(m), 0);
  assert.ok(Math.abs(total - 64) < 1e-5, "total " + total);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/plug.test.js`
Expected: the 7 new tests FAIL with `Split.plugSolids is not a function`.

- [ ] **Step 3: Implement** — in `js/split.js` after `rimFrame`:

```js
  // Wall + bottom for the current depth scale. Ids: rim gids (< NV), offset
  // points NV + k, bottom extras NV + nOff + j. Returns tris (id triples, PART
  // winding), coords for ids >= NV, and the offset-id of every rim gid.
  function buildPlug(mesh, g, bnd, frame, scale, method) {
    const { vx, vy, vz, NV } = g;
    const diag = MeshGeo.meshBounds(mesh).diag, weldEps = 1e-6 * diag;
    const offId = new Map(), extra = []; // extra[k] = [x,y,z] for id NV + k
    for (const L of bnd.loops) for (const gid of L) {
      const t = frame.t.get(gid) * scale;
      if (t <= weldEps) { offId.set(gid, gid); continue; }
      const d = frame.dir.get(gid);
      offId.set(gid, NV + extra.length);
      extra.push([vx[gid] + d[0] * t, vy[gid] + d[1] * t, vz[gid] + d[2] * t]);
    }
    const pt = (id) => (id < NV ? [vx[id], vy[id], vz[id]] : extra[id - NV]);
    const tris = [];
    const wallDir = new Map(); // offset-edge key -> "u'>v'" (direction the wall traverses)
    for (const L of bnd.loops) for (let i = 0; i < L.length; i++) {
      const u = L[i], v = L[(i + 1) % L.length], u2 = offId.get(u), v2 = offId.get(v);
      if (u2 !== u || v2 !== v) {
        if (u2 !== u) tris.push([v, u, u2]);
        if (v2 !== v) tris.push([v, u2, v2]);
      }
      wallDir.set(ekey(u2, v2), u2 + ">" + v2);
    }
    const offLoops = bnd.loops.map((L) => L.map((gid) => offId.get(gid)));
    const cap = Caps.triangulateLoops(offLoops, pt, method);
    orientCapComponents(cap, wallDir);
    const base = NV + extra.length;
    for (const ep of cap.extraPts) extra.push(ep);
    const ref = (i) => (i < cap.verts.length ? cap.verts[i] : base + (i - cap.verts.length));
    for (const [a, b, c] of cap.tris) tris.push([ref(a), ref(b), ref(c)]);
    return { tris, pt, nWall: tris.length - cap.tris.length };
  }

  // Do any of the new triangles cross each other or the mesh? Each new tri is
  // shrunk 2% toward its centroid so legitimate touching along the rim (and
  // between adjacent new tris) is not counted; true crossings survive.
  function anyIntersection(newTris, pt, mesh, grid) {
    const shrink = (t) => {
      const p = t.map(pt);
      const cx = (p[0][0] + p[1][0] + p[2][0]) / 3, cy = (p[0][1] + p[1][1] + p[2][1]) / 3, cz = (p[0][2] + p[1][2] + p[2][2]) / 3;
      return p.map((q) => [cx + (q[0] - cx) * 0.98, cy + (q[1] - cy) * 0.98, cz + (q[2] - cz) * 0.98]);
    };
    const S = newTris.map(shrink);
    const { n, min, cell, start, list } = grid;
    const ci = (x, k) => Math.max(0, Math.min(n - 1, Math.floor((x - min[k]) / cell[k])));
    const box = (tri) => [0, 1, 2].map((k) => [ci(Math.min(tri[0][k], tri[1][k], tri[2][k]), k), ci(Math.max(tri[0][k], tri[1][k], tri[2][k]), k)]);
    const P = mesh.positions;
    const faceTri = (f) => [mesh.v1[f], mesh.v2[f], mesh.v3[f]].map((v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
    // bucket the new tris by cell for the new-vs-new pass
    const cellNew = new Map();
    const boxes = S.map(box);
    boxes.forEach((bx, i) => {
      for (let x = bx[0][0]; x <= bx[0][1]; x++) for (let y = bx[1][0]; y <= bx[1][1]; y++) for (let z = bx[2][0]; z <= bx[2][1]; z++) {
        const c = (x * n + y) * n + z;
        let arr = cellNew.get(c); if (!arr) cellNew.set(c, (arr = [])); arr.push(i);
      }
    });
    const tested = new Set();
    for (let i = 0; i < S.length; i++) {
      const bx = boxes[i];
      for (let x = bx[0][0]; x <= bx[0][1]; x++) for (let y = bx[1][0]; y <= bx[1][1]; y++) for (let z = bx[2][0]; z <= bx[2][1]; z++) {
        const c = (x * n + y) * n + z;
        for (const j of cellNew.get(c) || []) {
          if (j <= i) continue;
          const key = i * S.length + j; if (tested.has(key)) continue; tested.add(key);
          if (MeshGeo.triTriIntersect(...S[i], ...S[j])) return true;
        }
        for (let e = start[c]; e < start[c + 1]; e++) {
          const f = list[e], key = -1 - (i * mesh.nf + f); if (tested.has(key)) continue; tested.add(key);
          if (MeshGeo.triTriIntersect(...S[i], ...faceTri(f))) return true;
        }
      }
    }
    return false;
  }

  // Volumetric split: the region as a solid plug (patch + inward wall + bottom)
  // and the remainder with the matching pocket. Both are plain document meshes.
  // See docs/superpowers/specs/2026-10-13-volumetric-split-design.md.
  function plugSolids(mesh, subs, opts) {
    const depth = Math.max(0, +(opts && opts.depth) || 0), method = (opts && opts.method) || "liepa";
    const g = Cleanup.buildSubGraph(mesh);
    if (!subs.length) return { error: "Nothing to split there" };
    if (subs.length >= g.NS) return { error: "That's the whole object" };
    const bnd = patchBoundary(mesh, subs, g);
    if (bnd.pinch) return { error: "Region touches itself at a point — paint a wider bridge or gap" };
    if (!bnd.loops.length) return { error: "Couldn't find the region's outline" };
    const grid = MeshGeo.faceGrid(mesh);
    const frame = rimFrame(mesh, g, bnd.loops, depth, grid);
    let scale = 1, halvings = 0, plug;
    for (;;) {
      plug = buildPlug(mesh, g, bnd, frame, scale, method);
      if (scale === 0 || !anyIntersection(plug.tris, plug.pt, mesh, grid)) break;
      halvings++;
      scale = halvings >= 4 ? 0 : scale / 2;
    }
    const inSet = new Set(subs);
    const rest = []; for (let s = 0; s < g.NS; s++) if (!inSet.has(s)) rest.push(s);
    const partState = g.subLeaf[subs[0]].state;
    const pocketState = majorityBorderColor(mesh, g, { subs, state: partState });
    const solid = (st) => Paint.encode({ leaf: true, state: st });
    // assemble one mesh: conformed surface + plug tris (optionally reversed)
    const assemble = (surfSubs, reverse, plugState) => {
      const surf = openSurface(mesh, surfSubs, g);
      const px = surf.px, py = surf.py, pz = surf.pz, F = surf.F, paints = surf.triSt.map(solid);
      const local = new Map();
      const lid = (id) => {
        if (id < g.NV) return surf.lid(id);
        let i = local.get(id);
        if (i === undefined) { const p = plug.pt(id); i = px.length; local.set(id, i); px.push(p[0]); py.push(p[1]); pz.push(p[2]); }
        return i;
      };
      for (const [a, b, c] of plug.tris) {
        if (reverse) F.push(lid(a), lid(c), lid(b)); else F.push(lid(a), lid(b), lid(c));
        paints.push(solid(plugState));
      }
      const nf = F.length / 3, v1 = new Int32Array(nf), v2 = new Int32Array(nf), v3 = new Int32Array(nf);
      for (let f = 0; f < nf; f++) { v1[f] = F[f * 3]; v2[f] = F[f * 3 + 1]; v3[f] = F[f * 3 + 2]; }
      const positions = new Float32Array(px.length * 3);
      for (let i = 0; i < px.length; i++) { positions[i * 3] = px[i]; positions[i * 3 + 1] = py[i]; positions[i * 3 + 2] = pz[i]; }
      return { positions, nf, v1, v2, v3, paints };
    };
    const part = assemble(subs, false, partState);
    const remainder = assemble(rest, true, pocketState);
    if (MeshGeo.checkClosed(part) || MeshGeo.checkClosed(remainder)) return { error: "Couldn't make a clean solid here" };
    return { part, remainder, info: { halvings, shell: scale === 0, faces: subs.length } };
  }
```

Add `plugSolids,` to the `global.Split = { ... }` export.

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/plug.test.js`
Expected: 12 PASS. Debug guide if not:
- `part closed` fails on the flat plug → print `MeshGeo.checkClosed` per piece and check the wall winding (`[v, u, u2]`, `[v, u2, v2]`) against `surfDir` (surface traverses `u→v`).
- remainder fails but part passes → `reverse` branch or the pocket uses `lid` for rim ids that were never emitted by `openSurface(rest)` (a rim gid must appear in the rest surface; if `rest` is empty the whole-mesh guard should have fired).
- roof test `halvings === 0` → verify `anyIntersection` is being passed the un-shrunk `pt` and the grid cells cover the roof (`faceGrid` is built on the *mesh* bounds; offset points lie inside).
- `volumes sum` off by the plug volume → the remainder pocket is not reversed.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` → Expected: all pass.

```bash
git add js/split.js tests/plug.test.js
git commit -m "feat: Split.plugSolids — volumetric part + pocketed remainder with halving and watertight gate"
```

---

### Task 4: Remove the overlay solids and exports

**Files:**
- Modify: `js/split.js` (delete `solidFromSubs`, `remainderSolid`; keep `openSurface`, `orientCapComponents`, `majorityBorderColor`, `layoutParts`, `buildSplitXML`, `uuid`)
- Modify: `js/threemf.js` (delete `exportSplit`; `exportGenerated` names objects by `m.part.label`)
- Modify: `tests/split.test.js` (delete overlay tests; rewrite the first `buildSplitXML` test with a hand-made triangle)

**Interfaces:**
- Produces: `global.Split = { plugSolids, patchBoundary, rimFrame, buildSplitXML, uuid, layoutParts }`; `global.ThreeMF` without `exportSplit`. `exportGenerated` object name = `m.part ? m.part.label : "Object " + (i + 1)`.

- [ ] **Step 1: Rewrite `tests/split.test.js`** so it contains only:

```js
const test = require("node:test");
const assert = require("node:assert");
const { loadModules } = require("./harness");

const tri = (name, paints) => ({
  name, extruder: 1,
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: Uint32Array.from([0, 1, 2]),
  triState: null, paints,
});

test("buildSplitXML emits N objects, components, items, and parts", () => {
  const { Split } = loadModules();
  const objects = [tri("Part 1 · black", ["4"]), tri("Object 1", [""])];
  const xml = Split.buildSplitXML(objects, { buildTransform: "1 0 0 0 1 0 0 0 1 1 2 0", defaultExtruder: 1 });
  assert.equal((xml.objectsModel.match(/<object /g) || []).length, 2);
  assert.equal((xml.objectsModel.match(/<mesh>/g) || []).length, 2);
  assert.equal((xml.rootModel.match(/<component /g) || []).length, 2);
  assert.equal((xml.rootModel.match(/<item /g) || []).length, 2);
  assert.ok(xml.rootModel.includes('transform="1 0 0 0 1 0 0 0 1 1 2 0"'));
  assert.equal((xml.modelSettings.match(/<object /g) || []).length, 2);
  assert.equal((xml.modelSettings.match(/<part /g) || []).length, 2);
  assert.ok(xml.modelSettings.includes('value="Part 1 · black"'), "object name carried");
  assert.equal((xml.objectsModel.match(/paint_color=/g) || []).length, 1, "only the painted object carries paint");
  assert.equal((xml.rootModel.match(/p:UUID=/g) || []).length >= 5, true);
});

test("buildSplitXML emits verbatim paint_color strings when objects carry paints", () => {
  const { Split } = loadModules();
  const xml = Split.buildSplitXML([tri("X", ["841"])], { buildTransform: "1 0 0 0 1 0 0 0 1 0 0 0", defaultExtruder: 1 });
  assert.ok(xml.objectsModel.includes('paint_color="841"'), "verbatim paint string");
});

test("layoutParts lines parts up beside the body, bottoms aligned", () => {
  const { Split } = loadModules();
  const box = (x0, y0, z0, x1, y1, z1) => ({ min: [x0, y0, z0], max: [x1, y1, z1] });
  const body = box(0, 0, 0, 10, 8, 6);
  const parts = [box(2, 2, 1, 5, 6, 4), box(0, 0, 0, 2, 2, 2)];
  const offs = Split.layoutParts(body, parts, 1);
  assert.equal(offs.length, 2);
  let cursor = 11;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i], o = offs[i];
    const minX = p.min[0] + o[0], maxX = p.max[0] + o[0];
    assert.ok(Math.abs(minX - cursor) < 1e-9, "part " + i + " starts at the cursor");
    const pcy = (p.min[1] + p.max[1]) / 2 + o[1];
    assert.ok(Math.abs(pcy - 4) < 1e-9, "part " + i + " y-centered on the body");
    assert.ok(Math.abs(p.min[2] + o[2] - 0) < 1e-9, "part " + i + " rests on the body base");
    cursor = maxX + 1;
  }
});

test("overlay API is gone", () => {
  const { Split, ThreeMF } = loadModules();
  assert.strictEqual(Split.solidFromSubs, undefined);
  assert.strictEqual(Split.remainderSolid, undefined);
  assert.strictEqual(ThreeMF.exportSplit, undefined);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/split.test.js`
Expected: `overlay API is gone` FAILS (functions still exported); the other 3 pass.

- [ ] **Step 3: Delete the overlay code**
  - `js/split.js`: delete the whole `function solidFromSubs(...) {...}` (from its comment `// Build a capped watertight solid...` through its closing brace) and the whole `function remainderSolid(...) {...}` with its comment. Keep `openSurface`, `orientCapComponents`, `majorityBorderColor`. Replace the export line with:
    ```js
    global.Split = { plugSolids, patchBoundary, rimFrame, buildSplitXML, uuid, layoutParts };
    ```
  - `js/threemf.js`: delete `async function exportSplit(doc, splitParts) {...}` and its comment; in `exportGenerated` change `name: "Object " + (i + 1)` to `name: m.part ? m.part.label : "Object " + (i + 1)`; remove `exportSplit,` from `global.ThreeMF`.
  - Update the header comment of `js/split.js` to: `/* split.js — volumetric split (plugSolids: region → solid plug + pocketed remainder), row layout, and the multi-object .3mf XML. Depends on Paint + Cleanup + Caps + MeshGeo (on window). */`

Run: `grep -rn "solidFromSubs\|remainderSolid\|exportSplit" js tests` → Expected: no output.

- [ ] **Step 4: Run the suite**

Run: `npm test` → Expected: all pass (`tests/split.test.js` 4, `plug` 12, `meshgeo` 4, rest unchanged).

- [ ] **Step 5: Commit**

```bash
git add js/split.js js/threemf.js tests/split.test.js
git commit -m "refactor: remove overlay split solids and exportSplit; parts export by label"
```

---

### Task 5: Viewer offsets + app flow + panel

**Files:**
- Modify: `js/viewer.js` (`build` offsets, `pick`, `meshOffset`, `setLayout`; delete overlay objects)
- Modify: `js/app.js` (state, history, `doSplit`, `buildObjects`, `isolate`, `doCut`, export dialog, listeners, hover/cursor)
- Modify: `index.html` (split panel; remove the Split export chip)
- Modify: `CLAUDE.md` (modules + test count)

**Interfaces:**
- Consumes: `Split.plugSolids`, `Split.layoutParts`, `MeshGeo.meshBounds`.
- Produces: `Viewer.build(doc)` (no `claimed`), `Viewer.pick → { meshIndex, localSub, state, point (model coords), world (display coords), normal }`, `Viewer.meshOffset(mi) → [dx,dy,dz]`, `Viewer.setLayout(on) → bool changed`. Removed: `setSplitParts`, `pinPart`, `setPartVisibility`, `partObject`.

- [ ] **Step 1: Viewer — delete the overlay objects.** In `js/viewer.js` remove: the `splitObjs`, `remainderCapObjs`, `claimedSets` declarations; `clearSplitObjs`, `clearRemainderCaps`, `capMeshFor`, `pinPart`, `setPartVisibility`, `partObject`, `setSplitParts`; the `for (const o of splitObjs) {...}` loop in `animate`; in `setMainVisible` the `if (!v) for (const m of remainderCapObjs) ...` line; the `// claimed-by-split sub` comment in `paintSubs` (keep the `if (gi < 0) continue;`). Remove `setSplitParts, pinPart, setPartVisibility, partObject,` from the `global.Viewer` export.

- [ ] **Step 2: Viewer — display offsets.** Add near the top (after `visibleMeshes`):

```js
  let meshOffsets = [];      // per mesh: [dx,dy,dz] display offset (parts laid out in a row)
  let layoutOn = true;       // false while the Cut tool is active: parts shown coincident
  // Row layout for meshes flagged `part`, beside the union box of the others.
  function computeOffsets(d) {
    const boxes = d.meshes.map((m) => MeshGeo.meshBounds(m));
    let bodyIdx = d.meshes.map((m, i) => (m.part ? -1 : i)).filter((i) => i >= 0);
    if (!bodyIdx.length) bodyIdx = [0];
    const body = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const i of bodyIdx) for (let k = 0; k < 3; k++) { body.min[k] = Math.min(body.min[k], boxes[i].min[k]); body.max[k] = Math.max(body.max[k], boxes[i].max[k]); }
    const partIdx = d.meshes.map((m, i) => (m.part && !bodyIdx.includes(i) ? i : -1)).filter((i) => i >= 0);
    const margin = 0.06 * Math.hypot(body.max[0] - body.min[0], body.max[1] - body.min[1], body.max[2] - body.min[2]);
    const offs = layoutOn ? Split.layoutParts(body, partIdx.map((i) => boxes[i]), margin) : partIdx.map(() => [0, 0, 0]);
    meshOffsets = d.meshes.map(() => [0, 0, 0]);
    partIdx.forEach((i, k) => { meshOffsets[i] = offs[k]; });
  }
  function meshOffset(mi) { return meshOffsets[mi] || [0, 0, 0]; }
  function setLayout(on) { const changed = layoutOn !== !!on; layoutOn = !!on; return changed; }
```

In `build(d, claimed)`: change the signature to `build(d)`, delete the two `claimedSets` lines, call `computeOffsets(d);` right after `stateColorCache = {};`. In the per-mesh loop replace `const claimedSet = claimedSets[mi] || new Set();` with `const [ox, oy, oz] = meshOffsets[mi];` and in `emitLeaf` delete the `if (claimedSet.has(mine)) return;` line and write the offset positions:

```js
          positions[off] = x0 + ox; positions[off+1] = y0 + oy; positions[off+2] = z0 + oz;
          positions[off+3] = x1 + ox; positions[off+4] = y1 + oy; positions[off+5] = z1 + oz;
          positions[off+6] = x2 + ox; positions[off+7] = y2 + oy; positions[off+8] = z2 + oz;
```

In `pick`, replace `point: hits[0].point,` with:

```js
      point: hits[0].point.clone().sub(tmpV.set(meshOffsets[mi][0], meshOffsets[mi][1], meshOffsets[mi][2])), // model coords
      world: hits[0].point, // display coords (for cursors/gizmos)
```

Export `meshOffset, setLayout,` in `global.Viewer`.

- [ ] **Step 3: App — state, history, loading.** In `js/app.js`:
  - Delete `let splitParts = [];`, `let splitSeq = 0;`, the `claimedByMesh` const; `rebuildView` becomes `function rebuildView(highlightSet) { Viewer.build(doc); if (highlightSet) Viewer.setHighlight(highlightSet); }`.
  - `isolated` comment → `// { kind:"mesh", index } | null`.
  - `snap()`: delete the `splits:` line. `restore()`: delete the `splitParts = state.splits...` line.
  - `loadFile`: delete `splitParts = [];` and `Viewer.setPartVisibility(null);`.
  - Delete-color handler (~line 250): delete the comment + `splitParts = splitParts.map(...)` line.
  - `jumpTo`: delete `Viewer.setPartVisibility(null);`. `doCut`: delete the `splitParts.length` guard line and `Viewer.setPartVisibility(null);`; after `cutAny = true;` carry the flag: `if (m.part) { r.above.part = m.part; r.below.part = m.part; }`.
  - `buildObjects`: delete the `splitParts.forEach(...)` block; in the mesh loop set the name to `(m.part ? m.part.label : "Object " + (i + 1))` and, when `m.part`, prepend a swatch: `const sw = document.createElement("span"); sw.className = "swatch"; sw.style.background = stateColor(m.part.state); li.append(sw);` before `li.append(nm, ct)`.
  - `isolate`: keep only the `kind === "mesh"` branch body (drop `else {...}` and the `Viewer.setPartVisibility(new Set())` line). `showAll`: delete `Viewer.setPartVisibility(null);`.
  - `setTool`: add `if (Viewer.setLayout(name !== "cut") && doc) render(null);` before the `if (name === "cut") updateCutPlane()` line.
  - Brush cursor (`onHover`): `Viewer.setCursorTransform(hit.world.x, hit.world.y, hit.world.z, n.x, n.y, n.z, brushRadius());`. Ring gizmo (`showRing`): before `Viewer.setRingPlanes(...)` add `const o = Viewer.meshOffset(src.meshIndex);` and pass `cx: mx + o[0], cy: my + o[1], cz: mz + o[2]`.
  - Split hover (`onHover` split branch): `subs = Cleanup.selectColorRegion(m, hit.localSub);`.

- [ ] **Step 4: App — `doSplit`** replace the function with:

```js
  let partSeq = 0;
  function doSplit(hit) {
    if (previewActive) clearPreview();
    clearHoverPreview();
    if (hit.localSub == null) return;
    const mi = hit.meshIndex, m = doc.meshes[mi];
    const subs = Cleanup.selectColorRegion(m, hit.localSub);
    const depth = Math.max(0, +$("splitDepth").value || 0);
    busy("Splitting…", () => {
      const r = Split.plugSolids(m, subs, { depth, method: $("capMethod").value });
      if (r.error) { toast(r.error, true); return; }
      partSeq++;
      r.part.part = { label: "Part " + partSeq + " · " + colorName(hit.state), state: hit.state };
      if (m.part) r.remainder.part = m.part; // splitting a part: what's left is still that part
      doc.meshes.splice(mi, 1, r.remainder, r.part);
      doc.synthetic = true;
      for (const mm of [r.remainder, r.part]) { Cleanup.invalidateSub(mm); mm.dom = null; Cleanup.computeDominant(mm); }
      isolated = null;
      Viewer.setVisibleMeshes(null);
      computeModelSize();
      pushHistory("Split");
      render(null);
      Viewer.frame();
      buildObjects();
      updateStats();
      ensureSubGraphs("Preparing tool…");
      toast(r.info.shell ? "Region too sharp for a plug — made a shell" : "Split out " + r.part.part.label);
    });
  }
```

`partSeq` resets to 0 in `loadFile` (add `partSeq = 0;` next to `pendingDecal = null;`). Delete the `$("capMethod").addEventListener("change", ...)` block entirely.

- [ ] **Step 5: App — export dialog.** Delete `doExportSplit`; in `exportDefaultName` drop the `fmt === "split"` branch (`return fmt === "obj" ? base + "_paint.zip" : base + "_fixed.3mf";`); in `exportDescribe` replace the `split` line with nothing and make the default: `return doc.meshes.length > 1 ? "Repaired model as " + doc.meshes.length + " objects (parts coincident), ready to re-slice." : "Repaired model, ready to re-slice.";`; in `openExportDialog` delete the `splitChip`/`noParts` lines; in `runExport` delete `else if (fmt === "split") doExportSplit(name);`.

- [ ] **Step 6: HTML.** Replace the split panel with:

```html
        <div class="opt" data-panel="split" hidden>
          <span class="optlabel">Depth (mm)</span>
          <input type="number" id="splitDepth" min="0" step="0.1" value="3" style="width:64px" />
          <span class="optlabel">Cap method</span>
          <select id="capMethod">
            <option value="liepa" selected>Liepa (smooth)</option>
            <option value="earcut">Earcut</option>
            <option value="cdt">CDT (Delaunay)</option>
            <option value="projected">Projected normal</option>
            <option value="centroid">Centroid</option>
          </select>
          <span class="muted">Click a colored region to lift it out as a solid part.</span>
        </div>
```

Delete `<button type="button" data-fmt="split">Split</button>` from `#exportFmt`. In `computeModelSize` (app.js) add at the end: `$("splitDepth").max = (modelSize / 2).toFixed(1);`.

- [ ] **Step 7: Syntax + suite + dead references**

Run: `node --check js/app.js && node --check js/viewer.js && npm test` → Expected: syntax ok, all tests pass.
Run: `grep -n "splitParts\|setPartVisibility\|pinPart\|partObject\|setSplitParts\|claimedByMesh\|exportSplit\|remainderCapObjs" js/*.js index.html` → Expected: no output.

- [ ] **Step 8: CLAUDE.md** — replace the `split.js` bullet with:

```
- `meshgeo.js` — pure geometry: cached bounds, directed closed-surface check,
  Möller tri–tri test, face grid + inward ray cast (`rayHit`, back-face only).
- `split.js` — volumetric split: `plugSolids(mesh, subs, {depth, method})` →
  `{ part, remainder }` as real document meshes (patch + inward wall + bottom;
  the remainder gets the reversed wall/bottom = matching pocket). Depth per rim
  vertex = `min(depth, ½·t_hit) · |cos θ|`; self-intersection → depth halving
  (4×, then shell); outputs must pass `MeshGeo.checkClosed` or the split is
  refused. Parts carry `mesh.part = { label, state }`; the viewer lays them out
  in a row (display-only offsets), export stays coincident.
```

and update the test count line to what `npm test` reports.

- [ ] **Step 9: Browser verification** (Playwright; fresh server port; sample model `samples/`):
  1. Split tool (`s`), hover the belly spot → cyan region tint; click → spinner, then the part appears in a row beside the body, Objects panel lists "Part 1 · …" with a swatch, toast names it. Orbit to check the body has a pocket (visible edge ring).
  2. Click an ear tip → part shows with no visible wall (lens); a neck band (ring region) → closed slab.
  3. Paint over a part with the brush, then split the painted region on the part → works; remainder of the part keeps its label.
  4. Depth 0 → a lens is produced with the normal "Split out …" toast (no halving happens, so no "shell" toast). Depth field emptied → treated as 0, no console error. Depth 30 on the belly → the "Region too sharp…" toast may appear only if halving ran out; otherwise a deep plug.
  5. Undo ×3 → parts disappear, original mesh back, Objects list resets; redo brings them back in the row.
  6. Cut tool with parts present → parts snap coincident; apply a cut; switch to Split → parts return to the row.
  7. Export 3MF → `unzip -l` the download shows `3D/Objects/object_1.model`; `unzip -p ... Metadata/model_settings.config | grep 'key="name"'` lists the part labels.
  8. Console: no errors. Screenshots are disposable.

- [ ] **Step 10: Commit**

```bash
git add js/viewer.js js/app.js index.html CLAUDE.md
git commit -m "feat: split produces real part + remainder meshes; row layout as display offsets; depth panel"
```
