# Plug Split (inward-extruded depth) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add depth to color-region split parts by extruding the region's rim inward into the body, so parts are chunky/printable and interlock with the remainder.

**Architecture:** Generalize the shared flat cap (`solidFromSubs` → `cap`) into a shared *socket* = inward-offset points + wall quads + a bottom cap. The part consumes the socket outward; the remainder consumes the identical socket reversed (unchanged `remainderSolid` contract), so both stay coincident and watertight. Depth `0` collapses to today's flat cap exactly. Depth is auto-clamped per part to the nearest far wall via an inward raycast.

**Tech Stack:** Vanilla JS IIFEs on `window` (no build step); three.js + poly2tri vendored; tests via `node --test` through `tests/harness.js` (vm sandbox).

## Global Constraints

- Vanilla JS only. Each module is an IIFE attaching a global to `window`; the `<script>` order in `index.html` is the dependency graph. No bundler/ESM/framework. (CLAUDE.md)
- Never `Read` a `.3mf`. (CLAUDE.md) — not needed for this plan; all tests use in-memory fixtures.
- `Paint.tessellate` is THE geometry convention; anything subdividing faces must match it. (CLAUDE.md) — this plan does not subdivide faces; it extrudes rims, so it is unaffected, but do not alter tessellation.
- Watertight in tests = every undirected edge used exactly twice (winding-blind). Winding is validated separately via `directedViolations` (0) and `signedVolume` (> 0). (CLAUDE.md + `tests/harness.js`)
- After editing `js/`, restart the static server on a NEW port or hard-reload (stale-module cache). (CLAUDE.md)
- New geometry lives in `js/split.js` (depends on `Paint` + `Cleanup` + `Caps`, already loaded before it).
- The correctly-oriented flat cap **opposes** the surface's rim-edge direction (closed-solid invariant enforced by `orientCapComponents`). The socket relies on this: walls take each rim edge opposite the surface; the bottom is the oriented flat cap reversed. Do not run `orientCapComponents` on the socket — it is built already-correct.

---

## Task 1: Inward-normal helper

Computes, for a region's sub-triangles, a unit **inward** normal per welded rim vertex plus a single averaged inward normal. "Inward" = negated outward surface normal (mesh faces are wound CCW-outward; a sub's `(v0,v1,v2)` cross product points outward).

**Files:**
- Modify: `js/split.js` (add `inwardNormals`; export it as `Split._inwardNormals` for testing)
- Test: `tests/plugsplit.test.js` (create)

**Interfaces:**
- Produces: `inwardNormals(g, subs) -> { perVid: Map<number,[number,number,number]>, avg: [number,number,number] }` where `g = Cleanup.buildSubGraph(mesh)` and `subs` is an array of sub-triangle indices. Vectors are unit-length and point into the body.

- [ ] **Step 1: Write the failing test**

Add to a new file `tests/plugsplit.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const {
  loadModules, makeClosedCube, makeTetra,
  edgeUseCounts, directedViolations, signedVolume,
} = require("./harness");

// The top two faces of the 2x2x2 closed cube (z=2) painted state 2; rest state 1.
function makeToppedCube() {
  const m = makeClosedCube();
  m.paints = m.paints.slice();
  m.paints[2] = "8"; // face 2: verts 4,5,6 (z=2)
  m.paints[3] = "8"; // face 3: verts 4,6,7 (z=2)
  return m;
}

function regionOfState(Cleanup, mesh, state) {
  const g = Cleanup.buildSubGraph(mesh);
  const seed = [...Array(g.NS).keys()].find((i) => g.subLeaf[i].state === state);
  return Array.from(Cleanup.selectColorRegion(mesh, seed));
}

test("inwardNormals: cube top region points straight down (-z)", () => {
  const { Cleanup, Split } = loadModules();
  const mesh = makeToppedCube();
  const g = Cleanup.buildSubGraph(mesh);
  const subs = regionOfState(Cleanup, mesh, 2); // the two top faces
  const { avg, perVid } = Split._inwardNormals(g, subs);
  assert.ok(Math.abs(avg[0]) < 1e-6 && Math.abs(avg[1]) < 1e-6, "avg is axis-aligned in z");
  assert.ok(avg[2] < -0.99, "inward is -z, got " + avg[2]);
  for (const [, n] of perVid) {
    const len = Math.hypot(n[0], n[1], n[2]);
    assert.ok(Math.abs(len - 1) < 1e-6, "unit length");
    assert.ok(n[2] < -0.99, "each rim vertex inward is -z");
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="inwardNormals"`
Expected: FAIL — `Split._inwardNormals is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `js/split.js`, inside the IIFE (before `solidFromSubs`), add:

```js
  // Unit inward normals for a region: per welded rim vertex + one averaged.
  // A sub's (v0,v1,v2) cross points outward (mesh is CCW-outward); we negate.
  function inwardNormals(g, subs) {
    const { sv, vx, vy, vz } = g;
    const acc = new Map(); // vid -> [nx,ny,nz] (area-weighted outward)
    let ax = 0, ay = 0, az = 0;
    for (const s of subs) {
      const a = sv[s * 3], b = sv[s * 3 + 1], c = sv[s * 3 + 2];
      const ux = vx[b] - vx[a], uy = vy[b] - vy[a], uz = vz[b] - vz[a];
      const wx = vx[c] - vx[a], wy = vy[c] - vy[a], wz = vz[c] - vz[a];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      ax += nx; ay += ny; az += nz;
      for (const vid of [a, b, c]) {
        const e = acc.get(vid) || [0, 0, 0];
        e[0] += nx; e[1] += ny; e[2] += nz; acc.set(vid, e);
      }
    }
    const unitIn = (x, y, z) => { const L = Math.hypot(x, y, z) || 1; return [-x / L, -y / L, -z / L]; };
    const perVid = new Map();
    for (const [vid, e] of acc) perVid.set(vid, unitIn(e[0], e[1], e[2]));
    return { perVid, avg: unitIn(ax, ay, az) };
  }
```

Then add `_inwardNormals: inwardNormals` to the `Object.assign`/return export bag at the bottom of `js/split.js` (the object currently exposing `solidFromSubs, remainderSolid, ...`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="inwardNormals"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add js/split.js tests/plugsplit.test.js
git commit -m "feat: inward-normal helper for plug split"
```

---

## Task 2: Far-wall raycast depth helper

Casts inward rays and returns the nearest far-wall distance, used to clamp depth so the plug never pokes through. A hit counts only when the ray is **exiting** through that face (`dot(dir, faceNormal) > 0`) and `t > EPS` — this naturally skips the origin face and coplanar neighbors.

**Files:**
- Modify: `js/split.js` (add `farWallDepth`; export as `Split._farWallDepth`)
- Test: `tests/plugsplit.test.js`

**Interfaces:**
- Consumes: `Cleanup.faceGraph(mesh)` (provides `faceN`, unit face normals).
- Produces: `farWallDepth(mesh, origins, dirs) -> number` where `origins`/`dirs` are equal-length arrays of `[x,y,z]`; returns the minimum exit distance across all rays, or `Infinity` if no ray exits.

- [ ] **Step 1: Write the failing test**

Add to `tests/plugsplit.test.js`:

```js
test("farWallDepth: cube top -> bottom distance is 2; miss -> Infinity", () => {
  const { Cleanup, Split } = loadModules();
  const mesh = makeToppedCube(); // 2x2x2 cube
  // ray from top-center straight down hits the bottom at t=2
  const hit = Split._farWallDepth(mesh, [[1, 1, 2]], [[0, 0, -1]]);
  assert.ok(Math.abs(hit - 2) < 1e-6, "expected 2, got " + hit);
  // ray pointing away from the solid never exits through a front-facing wall
  const miss = Split._farWallDepth(mesh, [[1, 1, 2]], [[0, 0, 1]]);
  assert.equal(miss, Infinity);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="farWallDepth"`
Expected: FAIL — `Split._farWallDepth is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `js/split.js`, add (near `inwardNormals`):

```js
  // Nearest far-wall distance along inward rays (Moeller-Trumbore). Only counts
  // hits where the ray EXITS through the face (dot(dir,n)>0) and t>EPS, so the
  // origin face and coplanar neighbours are skipped. Infinity if nothing exits.
  function farWallDepth(mesh, origins, dirs) {
    const P = mesh.positions, v1 = mesh.v1, v2 = mesh.v2, v3 = mesh.v3, nf = mesh.nf;
    const faceN = Cleanup.faceGraph(mesh).faceN;
    const EPS = 1e-6;
    let best = Infinity;
    for (let i = 0; i < origins.length; i++) {
      const ox = origins[i][0], oy = origins[i][1], oz = origins[i][2];
      const dx = dirs[i][0], dy = dirs[i][1], dz = dirs[i][2];
      for (let f = 0; f < nf; f++) {
        if (faceN[f * 3] * dx + faceN[f * 3 + 1] * dy + faceN[f * 3 + 2] * dz <= 0) continue;
        const a = v1[f] * 3, b = v2[f] * 3, c = v3[f] * 3;
        const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
        const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
        const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
        const det = e1x * hx + e1y * hy + e1z * hz;
        if (Math.abs(det) < EPS) continue;
        const inv = 1 / det;
        const sx = ox - P[a], sy = oy - P[a + 1], sz = oz - P[a + 2];
        const u = (sx * hx + sy * hy + sz * hz) * inv;
        if (u < -EPS || u > 1 + EPS) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const vv = (dx * qx + dy * qy + dz * qz) * inv;
        if (vv < -EPS || u + vv > 1 + EPS) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > EPS && t < best) best = t;
      }
    }
    return best;
  }
```

Export `_farWallDepth: farWallDepth` in the export bag.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="farWallDepth"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add js/split.js tests/plugsplit.test.js
git commit -m "feat: far-wall raycast depth helper for plug split"
```

---

## Task 3: Socket builder wired into `solidFromSubs`

Build the socket (offset points + walls + reversed-bottom) and make `solidFromSubs` accept `opts = { depth, wallMode }`. `depth = 0` (or missing `opts`) keeps today's flat cap exactly. Depth is clamped per part to `0.9 × farWallDepth`.

**Files:**
- Modify: `js/split.js` (`solidFromSubs` signature + branch; add `buildSocket`)
- Test: `tests/plugsplit.test.js`

**Interfaces:**
- Consumes: `inwardNormals` (Task 1), `farWallDepth` (Task 2), `Caps.triangulateLoops`, and the already-oriented flat `cap` computed inside `solidFromSubs`.
- Produces:
  - `solidFromSubs(mesh, subs, method, opts?)` — `opts.depth` (number, model units, default 0), `opts.wallMode` (`"averaged"` default | `"pervertex"`). Return shape unchanged: `{ positions, indices, triState, state, cap }`. When depth is effective, `cap` is the socket `{ verts, extraPts, tris, method }` (same descriptor contract, deeper geometry).
  - `buildSocket(mesh, g, flat, subs, surfDirEdges, opts) -> { verts, extraPts, tris, method } | null` — returns `null` when the clamped depth is ~0 (caller falls back to the flat cap). `flat` is the oriented flat cap; `surfDirEdges` is an array of `{ u, v }` **rim-vertex indices into `flat.verts`** in surface direction.

- [ ] **Step 1: Write the failing tests**

Add to `tests/plugsplit.test.js`:

```js
test("solidFromSubs: depth 0 is identical to the flat cap", () => {
  const { Cleanup, Split } = loadModules();
  const base = () => { const m = makeToppedCube(); return { m, subs: regionOfState(Cleanup, m, 2) }; };
  const A = base(), B = base();
  const flat = Split.solidFromSubs(A.m, A.subs, "centroid");
  const zero = Split.solidFromSubs(B.m, B.subs, "centroid", { depth: 0, wallMode: "averaged" });
  assert.deepEqual(Array.from(zero.indices), Array.from(flat.indices));
  assert.deepEqual(Array.from(zero.positions), Array.from(flat.positions));
  assert.equal(zero.cap.tris.length, flat.cap.tris.length);
});

test("solidFromSubs: depth>0 plug is watertight, outward-wound, deeper", () => {
  const { Cleanup, Split } = loadModules();
  for (const wallMode of ["averaged", "pervertex"]) {
    const mesh = makeToppedCube();
    const subs = regionOfState(Cleanup, mesh, 2);
    const solid = Split.solidFromSubs(mesh, subs, "centroid", { depth: 1, wallMode });
    for (const [, n] of edgeUseCounts(solid.indices)) assert.equal(n, 2, "closed " + wallMode);
    assert.equal(directedViolations(solid.indices), 0, "consistent winding " + wallMode);
    assert.ok(signedVolume(solid.indices, solid.positions) > 0, "outward " + wallMode);
    // the socket pushed points below z=2 (into the body)
    let minZ = Infinity;
    for (let i = 0; i < solid.positions.length; i += 3) minZ = Math.min(minZ, solid.positions[i + 2]);
    assert.ok(minZ < 2 - 1e-6 && minZ >= 0, "plug goes into body, got minZ=" + minZ);
  }
});

test("solidFromSubs: depth is clamped below the far wall", () => {
  const { Cleanup, Split } = loadModules();
  const mesh = makeToppedCube(); // thickness 2 in z
  const subs = regionOfState(Cleanup, mesh, 2);
  const solid = Split.solidFromSubs(mesh, subs, "centroid", { depth: 100, wallMode: "averaged" });
  let minZ = Infinity;
  for (let i = 0; i < solid.positions.length; i += 3) minZ = Math.min(minZ, solid.positions[i + 2]);
  // clamped to 0.9 * 2 = 1.8 -> bottom at z = 2 - 1.8 = 0.2, never crosses z=0
  assert.ok(minZ > 0.1 && minZ < 0.3, "clamped near 0.2, got " + minZ);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="solidFromSubs: depth"`
Expected: FAIL — depth path not implemented (`opts` ignored; no `minZ < 2`).

- [ ] **Step 3: Write the implementation**

In `js/split.js`, add `buildSocket` (after `orientCapComponents`):

```js
  // Turn the oriented flat cap into a "socket": inward-offset points + wall
  // quads + the flat cap reversed & offset (the bottom). verts = the rim vids
  // (indices 0..V-1); extraPts[0..V-1] = the offset of each rim vertex; then the
  // bottom's interior extras. Built already-correct (walls take each rim edge
  // OPPOSITE the surface; bottom = oriented flat cap reversed), so the caller
  // must NOT run orientCapComponents on it. Returns null if depth clamps to ~0.
  function buildSocket(mesh, g, flat, subs, surfDirEdges, opts) {
    const { vx, vy, vz } = g;
    const wallMode = opts.wallMode === "pervertex" ? "pervertex" : "averaged";
    const { perVid, avg } = inwardNormals(g, subs);
    const dirOf = (vid) => (wallMode === "pervertex" ? (perVid.get(vid) || avg) : avg);

    const rimVids = flat.verts;      // rim vids; index i is also the socket ref for the top
    const V = rimVids.length;
    const origins = rimVids.map((vid) => [vx[vid], vy[vid], vz[vid]]);
    const dirs = rimVids.map((vid) => dirOf(vid));
    const farWall = farWallDepth(mesh, origins, dirs);
    const req = opts.depth || 0;
    const eff = Number.isFinite(farWall) ? Math.min(req, 0.9 * farWall) : req;
    if (!(eff > 1e-9)) return null;

    const verts = rimVids.slice();
    const extraPts = [];
    rimVids.forEach((vid, i) => {
      const d = dirOf(vid);
      extraPts.push([vx[vid] + d[0] * eff, vy[vid] + d[1] * eff, vz[vid] + d[2] * eff]);
    });
    const offRef = (i) => V + i;     // rim index i -> its offset point ref

    const tris = [];
    // walls: each rim edge, surface direction u->v, top edge taken v->u (opposite)
    for (const { u, v } of surfDirEdges) {
      tris.push([v, u, offRef(u)]);
      tris.push([v, offRef(u), offRef(v)]);
    }
    // bottom: the oriented flat cap, reversed, rim refs -> offset refs, interior
    // extras offset along the averaged inward normal.
    const botExtraBase = V + extraPts.length;
    for (const ep of flat.extraPts) extraPts.push([ep[0] + avg[0] * eff, ep[1] + avg[1] * eff, ep[2] + avg[2] * eff]);
    const botRef = (i) => (i < V ? offRef(i) : botExtraBase + (i - V));
    for (const [a, b, c] of flat.tris) tris.push([botRef(a), botRef(c), botRef(b)]); // reversed

    return { verts, extraPts, tris, method: opts.method };
  }
```

Now update `solidFromSubs`. Change the signature and the cap block. Replace the signature line:

```js
  function solidFromSubs(mesh, subs, method) {
    method = method || "centroid";
```

with:

```js
  function solidFromSubs(mesh, subs, method, opts) {
    method = method || "centroid";
    opts = opts || {};
```

Then, inside the `if (boundary.length) { ... }` block, AFTER the existing `orientCapComponents(cap, surfDir);` line and BEFORE the comment `// emit the cap into the part`, insert:

```js
      // Deepen the flat cap into a socket when a depth is requested. The socket
      // is built already-correctly-wound, so it does NOT go through
      // orientCapComponents. surfDirEdges are rim edges as indices into
      // cap.verts, in the surface's first-seen direction.
      if (opts.depth > 0) {
        const vidToIdx = new Map();
        cap.verts.forEach((gid, i) => vidToIdx.set(gid, i));
        const surfDirEdges = [];
        for (const e of bEdge.values()) {
          if (e.count !== 1) continue;
          const u = vidToIdx.get(e.u), v = vidToIdx.get(e.v);
          if (u !== undefined && v !== undefined) surfDirEdges.push({ u, v });
        }
        const socket = buildSocket(mesh, g, cap, subs, surfDirEdges, { ...opts, method });
        if (socket) cap = socket;
      }
```

(The subsequent emission code — `cap.verts.map(lid)`, appending `cap.extraPts`, pushing `cap.tris` — already handles the deeper socket unchanged, because it only relies on the `{ verts, extraPts, tris }` contract.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="solidFromSubs: depth"`
Expected: PASS (all three).

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npm test`
Expected: all tests pass (the existing 52 + the new plug tests). If any existing `solidFromSubs` test changed behavior, it means the `opts.depth > 0` branch leaked into the default path — verify default `opts = {}` keeps `opts.depth` undefined.

- [ ] **Step 6: Commit**

```bash
git add js/split.js tests/plugsplit.test.js
git commit -m "feat: extrude split parts inward into a capped socket (depth + wallMode)"
```

---

## Task 4: Coincident remainder + thread opts through callers

The remainder must plug against the SAME socket. `remainderSolid` already consumes and reverses whatever `cap` it is handed, so it needs no change — but its callers must pass the socket-bearing cap, and the live/export builders must pass `opts` so part and remainder use the same depth.

**Files:**
- Modify: `js/threemf.js:201` and `js/threemf.js:216` context (`exportSplit`)
- Modify: `js/viewer.js:433` (live part build)
- Test: `tests/plugsplit.test.js`

**Interfaces:**
- Consumes: `solidFromSubs(mesh, subs, method, opts)` (Task 3), `remainderSolid(mesh, parts, claimed)` (unchanged).
- Produces: split-part records now carry `depth` and `wallMode` (added in Task 5); callers read `p.depth` / `p.wallMode`.

- [ ] **Step 1: Write the failing test**

Add to `tests/plugsplit.test.js`:

```js
test("remainder shares the socket -> part+remainder both watertight at depth", () => {
  const { Cleanup, Split } = loadModules();
  const mesh = makeToppedCube();
  const subs = regionOfState(Cleanup, mesh, 2);
  const opts = { depth: 1, wallMode: "averaged" };
  const part = Split.solidFromSubs(mesh, subs, "centroid", opts);
  const claimed = new Set(subs);
  const rem = Split.remainderSolid(mesh, [{ subs, cap: part.cap, state: 2 }], claimed);
  for (const [, n] of edgeUseCounts(part.indices)) assert.equal(n, 2, "part closed");
  for (const [, n] of edgeUseCounts(rem.indices)) assert.equal(n, 2, "remainder closed");
  assert.equal(directedViolations(rem.indices), 0, "remainder winding");
  assert.ok(signedVolume(rem.indices, rem.positions) > 0, "remainder outward");
  // the remainder's socket copy reaches the same depth as the part's
  let pMin = Infinity, rMin = Infinity;
  for (let i = 0; i < part.positions.length; i += 3) pMin = Math.min(pMin, part.positions[i + 2]);
  for (let i = 0; i < rem.positions.length; i += 3) rMin = Math.min(rMin, rem.positions[i + 2]);
  assert.ok(Math.abs(pMin - rMin) < 1e-6, "part and remainder reach the same depth");
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npm test -- --test-name-pattern="remainder shares the socket"`
Expected: PASS already — `remainderSolid` is generic over the cap descriptor. (This test is a regression guard for the shared-socket contract; if it fails, the socket's `verts`/`extraPts`/`tris` indexing is wrong.) If it passes, keep it and continue to wire the callers so the live/export paths actually pass depth.

- [ ] **Step 3: Thread `opts` through `js/threemf.js`**

In `exportSplit`, change the part build at `js/threemf.js:201` from:

```js
      const g = Split.solidFromSubs(doc.meshes[p.meshIndex], Array.from(p.subs), p.method || "liepa");
```

to:

```js
      const g = Split.solidFromSubs(doc.meshes[p.meshIndex], Array.from(p.subs), p.method || "liepa",
        { depth: p.depth || 0, wallMode: p.wallMode || "averaged" });
```

Also update the header comment at `js/threemf.js:185` to document the new fields:

```js
  // splitParts: [{ meshIndex, subs:Int32Array|number[], state, method, depth, wallMode }]
```

(No change needed at `js/threemf.js:216` — `remainderSolid` reuses `partCaps[pi]`, which now already carries the socket.)

- [ ] **Step 4: Thread `opts` through `js/viewer.js`**

At `js/viewer.js:433`, change:

```js
      const s = Split.solidFromSubs(doc.meshes[p.meshIndex], Array.from(p.subs), p.method || "liepa");
```

to:

```js
      const s = Split.solidFromSubs(doc.meshes[p.meshIndex], Array.from(p.subs), p.method || "liepa",
        { depth: p.depth || 0, wallMode: p.wallMode || "averaged" });
```

(`capMeshFor` at `js/viewer.js:352` needs no change — it renders `solid.cap.verts/extraPts/tris` generically, so the remainder-hole preview follows the socket automatically.)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass, including the new remainder test.

- [ ] **Step 6: Commit**

```bash
git add js/threemf.js js/viewer.js tests/plugsplit.test.js
git commit -m "feat: pass plug depth/wallMode through split live build and export"
```

---

## Task 5: UI controls + wiring in `app.js`

Add a depth slider and wall-mode select to the split panel; store `depth`/`wallMode` on each split part; rebuild all parts when either changes (mirroring the `capMethod` handler). This task is validated by driving the running app (no unit test — it is UI glue over Task 3/4 code that is already tested).

**Files:**
- Modify: `index.html:111-121` (split panel)
- Modify: `js/app.js` (lines noted below)

**Interfaces:**
- Consumes: `solidFromSubs` opts (Task 3), the live/export callers (Task 4).
- Produces: DOM ids `#splitDepth`, `#splitDepthVal`, `#splitWallMode`; split-part records gain `depth`, `wallMode`.

- [ ] **Step 1: Add the controls to the split panel**

In `index.html`, replace the split panel block (`index.html:111-121`) with:

```html
        <div class="opt" data-panel="split" hidden>
          <span class="optlabel">Cap method</span>
          <select id="capMethod">
            <option value="liepa" selected>Liepa (smooth)</option>
            <option value="earcut">Earcut</option>
            <option value="cdt">CDT (Delaunay)</option>
            <option value="projected">Projected normal</option>
            <option value="centroid">Centroid</option>
          </select>
          <span class="optlabel">Depth <span id="splitDepthVal" class="muted">0</span></span>
          <input type="range" id="splitDepth" min="0" max="20" step="0.5" value="0" />
          <span class="optlabel">Walls</span>
          <select id="splitWallMode">
            <option value="averaged" selected>Averaged (prism)</option>
            <option value="pervertex">Per-vertex (follow shape)</option>
          </select>
          <span class="muted">Click a colored part to lift it out as its own solid. Depth extends the cut into the body (auto-clamped so it can't poke through).</span>
        </div>
```

- [ ] **Step 2: Record depth/wallMode when a part is created**

In `js/app.js`, at `doSplit` (`js/app.js:653`), change:

```js
    splitParts.push({ id: splitSeq++, meshIndex: hit.meshIndex, subs, state: hit.state, method: $("capMethod").value });
```

to:

```js
    splitParts.push({ id: splitSeq++, meshIndex: hit.meshIndex, subs, state: hit.state,
      method: $("capMethod").value,
      depth: +$("splitDepth").value || 0,
      wallMode: $("splitWallMode").value });
```

- [ ] **Step 3: Preserve depth/wallMode through history snapshot/restore**

In `js/app.js`, at the snapshot map (`js/app.js:51`), change:

```js
      splits: splitParts.map((p) => ({ id: p.id, meshIndex: p.meshIndex, subs: Int32Array.from(p.subs), state: p.state, method: p.method })),
```

to:

```js
      splits: splitParts.map((p) => ({ id: p.id, meshIndex: p.meshIndex, subs: Int32Array.from(p.subs), state: p.state, method: p.method, depth: p.depth || 0, wallMode: p.wallMode || "averaged" })),
```

And at the restore map (`js/app.js:66`), change:

```js
    splitParts = state.splits.map((p) => ({ id: p.id, meshIndex: p.meshIndex, subs: Int32Array.from(p.subs), state: p.state, method: p.method }));
```

to:

```js
    splitParts = state.splits.map((p) => ({ id: p.id, meshIndex: p.meshIndex, subs: Int32Array.from(p.subs), state: p.state, method: p.method, depth: p.depth || 0, wallMode: p.wallMode || "averaged" }));
```

(The recolor map at `js/app.js:249` uses `{ ...p }`, so it already preserves the new fields.)

- [ ] **Step 4: Rebuild parts + live depth-label on control changes**

In `js/app.js`, immediately after the `capMethod` change handler (`js/app.js:949-956`), add:

```js
  $("splitDepth").addEventListener("input", () => {
    $("splitDepthVal").textContent = $("splitDepth").value;
    if (!doc || !splitParts.length) return;
    const depth = +$("splitDepth").value || 0;
    for (const p of splitParts) p.depth = depth;
    render(null);
    buildObjects();
  });
  $("splitDepth").addEventListener("change", () => {
    if (!doc || !splitParts.length) return;
    pushHistory("Split depth: " + $("splitDepth").value);
  });
  $("splitWallMode").addEventListener("change", () => {
    if (!doc || !splitParts.length) return;
    const wallMode = $("splitWallMode").value;
    for (const p of splitParts) p.wallMode = wallMode;
    pushHistory("Split walls: " + wallMode);
    render(null);
    buildObjects();
    toast("Rebuilt " + splitParts.length + " part(s): " + wallMode + " walls");
  });
```

(Rationale: `input` fires continuously while dragging — cheap rebuild + label, no history spam; `change` fires once on release — one undo entry. This matches the existing continuous-slider pattern used by `cutPos`/`cutTilt*`.)

- [ ] **Step 5: Drive the running app to verify**

Start a fresh server on a new port and load the reference model:

Run: `python3 -m http.server 8123`
Then, using the browser tools, load `samples/`'s reference `.3mf`, choose the Split tool (`s`), set Depth to a few mm, and click a colored region. Confirm:
- the lifted part is a solid slab with visible depth (not a thin shell);
- the remainder shows a matching recessed socket where the part was;
- setting Depth to 0 reproduces the old flat-cap part;
- a very large Depth on a thin region clamps instead of poking through.

Take a screenshot as evidence (the `*.jpeg` is disposable/gitignored).

- [ ] **Step 6: Run the full suite once more**

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add index.html js/app.js
git commit -m "feat: split depth slider + wall-mode control (plug split UI)"
```

---

## Self-Review

**Spec coverage** (`docs/superpowers/specs/2026-07-14-plug-split-depth-design.md`):

- §1 Socket = walls + bottom cap (generalized cap) → Task 3 (`buildSocket`, wired into `solidFromSubs`).
- §1 `d = 0` identical to flat cap → Task 3 Step 1 regression test.
- §2 Wall direction toggle (averaged / per-vertex) → Task 1 (`inwardNormals` per-vid + avg), Task 3 (`wallMode` branch), Task 5 (`#splitWallMode`).
- §3 Depth slider + auto-clamp (0.9× far wall, per-part, missed rays → unclamped) → Task 2 (`farWallDepth`, `Infinity` on miss), Task 3 (`eff = min(req, 0.9*farWall)`, `Infinity → req`), Task 5 (`#splitDepth`).
- §4 UI next to `capMethod`; parts store params; rebuild-all on change (capMethod pattern); export unchanged → Task 5.
- §5 Geometry in `split.js`; `remainderSolid` unchanged (consumes/reverses the socket) → Task 3, Task 4.
- Testing §1–6 → Tasks 1–4 tests + Task 5 manual drive; watertight (`edgeUseCounts`), winding (`directedViolations`, `signedVolume`), coincidence (Task 4 shared-socket test), clamp (Task 3 clamp test), both wall modes (Task 3 loop).

**Placeholder scan:** none — every code step shows full code; every command has expected output.

**Type consistency:** `inwardNormals -> {perVid,avg}` (Task 1) consumed in `buildSocket` (Task 3). `farWallDepth(mesh,origins,dirs)->number|Infinity` (Task 2) consumed in `buildSocket` (Task 3). `solidFromSubs(mesh,subs,method,opts)` (Task 3) consumed by `js/viewer.js` + `js/threemf.js` (Task 4). Split-part fields `depth`/`wallMode` written in Task 5, read in Task 4. `cap`/socket descriptor `{verts,extraPts,tris,method}` is the single contract across `solidFromSubs`, `remainderSolid`, and `capMeshFor` — unchanged shape, deeper contents.
