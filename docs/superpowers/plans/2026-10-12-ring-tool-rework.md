# Ring Tool Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ring tool produce closed, crisp-edged bands at a user-chosen angle via a place-then-adjust flow.

**Architecture:** The ring is a slab `|(p − c)·n| ≤ h`. A parent-face flood over `Cleanup.faceGraph` (exact triangle-vs-slab test) picks the clicked loop; painting reuses the stamp tool's `refinePaint` walker with slab predicates. The axis comes from X/Y/Z/Fit presets plus two tilt sliders through a `Cleanup.tiltAxis` helper shared with the Cut tool; a two-disc gizmo in `viewer.js` shows the slab.

**Tech Stack:** Vanilla JS IIFEs (no build), three.js (vendored), Node `node:test` with `tests/harness.js` vm sandbox.

**Spec:** `docs/superpowers/specs/2026-10-12-ring-tool-rework-design.md`

## Global Constraints

- Vanilla JS, no build step, no framework; scripts are IIFEs attaching to `window`; no ESM/bundler.
- Subdivision must go through `refinePaint` (it follows `Paint.tessellate`'s exact conventions) — never hand-roll face splits.
- Never `Read` a `.3mf`; untracked `.3mf` files at the repo root are the user's — leave them alone.
- After editing `js/`, restart the static server on a NEW port before browser checks (stale-module caching).
- Tilt sliders: −90…90°. Default axis Z, tilts 0. Axis/tilts persist across placements.
- Refine edges default on, `maxDepth` 4 in the app.
- Scope: only the connected loop through the clicked face.

## Review Focus

- **Placed ring, then undo/redo or a model reload** → the placement is cancelled (no stale face index painting the wrong place). Owned by Task 4 (`jumpTo` / `loadFile` call `cancelRing`); browser-checked in Task 4 Step 8.
- **Apply with no palette color selected** → toast "Pick a paint color first", nothing painted, no history entry. Task 4, browser-checked.
- **Faces lying exactly in / parallel to the slab** (flat caps, cube sides) → included iff they meet the slab, no infinite flood. Task 2 cube test.
- **Seed face that does not meet the slab** (guard) → empty result, no paint. Task 2 test.
- **Enter/Esc while a ring slider has keyboard focus** → Enter applies / Esc cancels the placed ring instead of being swallowed by the "typing in a field" guard, and Esc with a placed ring cancels the placement rather than leaving the tool. Task 4, browser-checked.

---

### Task 1: Shared `Cleanup.tiltAxis` + Cut tool refactor

**Files:**
- Modify: `js/select.js` (add `tiltAxis` near `featureAxis`, export it)
- Modify: `js/app.js:673-687` (`cutPlane()` uses the helper)
- Create: `tests/ring.test.js`

**Interfaces:**
- Produces: `Cleanup.tiltAxis(n: [x,y,z], u: [x,y,z], ta: number, tb: number) → [x,y,z]` — rotate unit `n` by `ta` radians about `u`, then by `tb` about `w = n × u` (both axes fixed, right-handed). Unit-length result. With `n = e_k`, `u = e_(k+1)` this equals the Cut tool's historical convention.

- [ ] **Step 1: Write the failing test** — create `tests/ring.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { loadModules } = require("./harness");

// The Cut tool's tilt math as it was before the refactor (regression oracle).
function oldCutNormal(axis, ta, tb) {
  const n = [0, 0, 0];
  n[axis] = 1;
  const rot = (v, ax2, ang) => { const i = (ax2 + 1) % 3, j = (ax2 + 2) % 3; const vi = v[i], vj = v[j]; v[i] = vi * Math.cos(ang) - vj * Math.sin(ang); v[j] = vi * Math.sin(ang) + vj * Math.cos(ang); };
  rot(n, (axis + 1) % 3, ta);
  rot(n, (axis + 2) % 3, tb);
  return n;
}
const unitAxes = (k) => { const n = [0, 0, 0], u = [0, 0, 0]; n[k] = 1; u[(k + 1) % 3] = 1; return { n, u }; };
const close = (a, b, eps = 1e-9) => a.every((x, i) => Math.abs(x - b[i]) < eps);

test("tiltAxis with zero tilts returns the base axis", () => {
  const { Cleanup } = loadModules();
  for (let k = 0; k < 3; k++) {
    const { n, u } = unitAxes(k);
    assert.ok(close(Cleanup.tiltAxis(n, u, 0, 0), n), "axis " + k);
  }
});

test("tiltAxis matches the Cut tool's previous tilt convention", () => {
  const { Cleanup } = loadModules();
  for (let k = 0; k < 3; k++) {
    for (const [ta, tb] of [[0.3, -0.5], [-1.2, 0.7], [Math.PI / 2, 0], [0, -Math.PI / 2]]) {
      const { n, u } = unitAxes(k);
      const got = Cleanup.tiltAxis(n, u, ta, tb);
      assert.ok(close(got, oldCutNormal(k, ta, tb)), `axis ${k} ta ${ta} tb ${tb}: ${got}`);
    }
  }
});

test("tiltAxis works for an arbitrary (fitted) base axis", () => {
  const { Cleanup } = loadModules();
  const s = Math.SQRT1_2;
  const n = [s, s, 0], u = [0, 0, 1]; // u ⊥ n
  const v = Cleanup.tiltAxis(n, u, Math.PI / 2, 0); // 90° about z: (s,s,0) -> (-s,s,0)
  assert.ok(close(v, [-s, s, 0]), String(v));
  assert.ok(Math.abs(Math.hypot(...Cleanup.tiltAxis(n, u, 0.4, 1.1)) - 1) < 1e-12, "unit length");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ring.test.js`
Expected: FAIL — `Cleanup.tiltAxis is not a function`.

- [ ] **Step 3: Implement `tiltAxis`** — in `js/select.js`, directly after the `featureAxis` function (before `selectBandAxis`), add:

```js
  // Tilt a unit axis n: rotate by ta (radians) about u, then by tb about the
  // fixed w = n × u (right-handed, Rodrigues). With n = e_k, u = e_(k+1) this
  // is exactly the Cut tool's axis + two-tilt convention. Returns [x,y,z].
  function tiltAxis(n, u, ta, tb) {
    const w = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    const rotate = (v, k, ang) => {
      const c = Math.cos(ang), s = Math.sin(ang);
      const d = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
      const cx = k[1] * v[2] - k[2] * v[1], cy = k[2] * v[0] - k[0] * v[2], cz = k[0] * v[1] - k[1] * v[0];
      return [
        v[0] * c + cx * s + k[0] * d * (1 - c),
        v[1] * c + cy * s + k[1] * d * (1 - c),
        v[2] * c + cz * s + k[2] * d * (1 - c),
      ];
    };
    const v = rotate(rotate(n, u, ta), w, tb);
    const L = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / L, v[1] / L, v[2] / L];
  }
```

and add `tiltAxis,` to the `Object.assign(Cleanup, { ... })` export list (after `featureAxis,`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/ring.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Refactor `cutPlane()`** — in `js/app.js`, replace these lines inside `cutPlane()`:

```js
    const n = [0, 0, 0];
    n[axis] = 1;
    const rot = (v, ax2, ang) => { const i = (ax2 + 1) % 3, j = (ax2 + 2) % 3; const vi = v[i], vj = v[j]; v[i] = vi * Math.cos(ang) - vj * Math.sin(ang); v[j] = vi * Math.sin(ang) + vj * Math.cos(ang); };
    rot(n, (axis + 1) % 3, ta);
    rot(n, (axis + 2) % 3, tb);
```

with:

```js
    const base = [0, 0, 0], u = [0, 0, 0];
    base[axis] = 1;
    u[(axis + 1) % 3] = 1;
    const n = Cleanup.tiltAxis(base, u, ta, tb);
```

(the following `return { px: p[0], ..., nx: n[0], ny: n[1], nz: n[2] };` is unchanged).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all tests pass (52 existing + 3 new).

- [ ] **Step 7: Commit**

```bash
git add js/select.js js/app.js tests/ring.test.js
git commit -m "feat: shared Cleanup.tiltAxis; cut tool uses it"
```

---

### Task 2: Slab selection — `ringFaces` + `ringLeaves`

**Files:**
- Modify: `js/select.js` (add both functions after `tiltAxis`, export them)
- Test: `tests/ring.test.js`

**Interfaces:**
- Consumes: `Cleanup.faceGraph(mesh) → { start, list, faceN, nf }` (CSR parent-face adjacency), `Cleanup.buildSubGraph(mesh) → { subFace, cen, NS, ... }`.
- Produces:
  - `Cleanup.ringFaces(mesh, seedFace: int, c: [x,y,z], n: [x,y,z] unit, h: number) → Int32Array` of parent faces meeting the slab, connected to `seedFace`; `Int32Array(0)` if the seed does not meet the slab or is out of range.
  - `Cleanup.ringLeaves(mesh, faces: Int32Array|number[], c, n, h) → Int32Array` of local sub indices on `faces` whose centroid satisfies `|(cen − c)·n| ≤ h`.

- [ ] **Step 1: Write the failing tests** — append to `tests/ring.test.js`:

```js
const { makeClosedCube } = require("./harness");

// Open cylinder along +z through (ox,0): `segs` segments, ONE row of long
// triangles spanning z=0..len (the coarse case that left half-rings before).
// Unpainted (state 0). Faces 2i, 2i+1 belong to segment i.
function makeCylinder(segs, r, len, ox) {
  const pos = [];
  for (const z of [0, len]) for (let i = 0; i < segs; i++) {
    const a = (2 * Math.PI * i) / segs;
    pos.push(ox + r * Math.cos(a), r * Math.sin(a), z);
  }
  const v1 = [], v2 = [], v3 = [];
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % segs;
    v1.push(i); v2.push(j); v3.push(segs + j);
    v1.push(i); v2.push(segs + j); v3.push(segs + i);
  }
  return {
    nf: v1.length, positions: new Float32Array(pos),
    v1: Int32Array.from(v1), v2: Int32Array.from(v2), v3: Int32Array.from(v3),
    paints: v1.map(() => ""),
  };
}
// Concatenate two meshes into one (disjoint vertex sets).
function joinMeshes(a, b) {
  const off = a.positions.length / 3;
  const shift = (arr) => Array.from(arr, (v) => v + off);
  return {
    nf: a.nf + b.nf,
    positions: Float32Array.from([...a.positions, ...b.positions]),
    v1: Int32Array.from([...a.v1, ...shift(b.v1)]),
    v2: Int32Array.from([...a.v2, ...shift(b.v2)]),
    v3: Int32Array.from([...a.v3, ...shift(b.v3)]),
    paints: [...a.paints, ...b.paints],
  };
}
const unit = (v) => { const L = Math.hypot(...v); return v.map((x) => x / L); };

test("ringFaces closes the loop on coarse long triangles", () => {
  const { Cleanup } = loadModules();
  const m = makeCylinder(8, 1, 10, 0);
  const faces = Cleanup.ringFaces(m, 0, [1, 0, 5], [0, 0, 1], 0.5);
  assert.deepStrictEqual(Array.from(faces).sort((a, b) => a - b), [...Array(16).keys()]);
});

test("ringFaces closes the loop for a tilted axis", () => {
  const { Cleanup } = loadModules();
  const m = makeCylinder(8, 1, 10, 0);
  const faces = Cleanup.ringFaces(m, 0, [1, 0, 5], unit([0.3, 0.2, 1]), 0.5);
  assert.strictEqual(faces.length, 16);
});

test("ringFaces stays on the clicked loop when the slab crosses two parts", () => {
  const { Cleanup } = loadModules();
  const m = joinMeshes(makeCylinder(8, 1, 10, 0), makeCylinder(8, 1, 10, 5));
  const faces = Array.from(Cleanup.ringFaces(m, 0, [1, 0, 5], [0, 0, 1], 0.5));
  assert.strictEqual(faces.length, 16);
  assert.ok(faces.every((f) => f < 16), "no faces from the second cylinder");
});

test("ringFaces includes only faces meeting the slab (cube sides, not caps)", () => {
  const { Cleanup } = loadModules();
  const m = makeClosedCube(); // 2x2x2; faces 0,1 bottom (z=0), 2,3 top (z=2), 4..11 sides
  const faces = Array.from(Cleanup.ringFaces(m, 4, [0, 1, 1], [0, 0, 1], 0.25)).sort((a, b) => a - b);
  assert.deepStrictEqual(faces, [4, 5, 6, 7, 8, 9, 10, 11]);
  // a slab containing the top cap (z=2) pulls the cap in too
  const withTop = Array.from(Cleanup.ringFaces(m, 4, [0, 1, 1.9], [0, 0, 1], 0.25));
  assert.ok(withTop.includes(2) && withTop.includes(3), "top cap included");
  assert.ok(!withTop.includes(0) && !withTop.includes(1), "bottom cap excluded");
});

test("ringFaces returns empty when the seed face misses the slab", () => {
  const { Cleanup } = loadModules();
  const m = makeClosedCube();
  assert.strictEqual(Cleanup.ringFaces(m, 0, [0, 1, 1], [0, 0, 1], 0.25).length, 0); // bottom cap
  assert.strictEqual(Cleanup.ringFaces(m, 99, [0, 1, 1], [0, 0, 1], 0.25).length, 0); // out of range
});

test("ringLeaves keeps only in-slab leaves of the given faces", () => {
  const { Cleanup } = loadModules();
  const m = makeCylinder(8, 1, 10, 0);
  const g = Cleanup.buildSubGraph(m);
  // a slab around z=10/3 contains the centroids of the (v_i, v_j, v_j') faces
  const leaves = Array.from(Cleanup.ringLeaves(m, [0, 1, 2], [1, 0, 10 / 3], [0, 0, 1], 0.5));
  for (const s of leaves) {
    assert.ok([0, 1, 2].includes(g.subFace[s]), "leaf on a given face");
    assert.ok(Math.abs(g.cen[s * 3 + 2] - 10 / 3) <= 0.5, "centroid in slab");
  }
  assert.ok(leaves.length > 0, "found the low-centroid faces' leaves");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/ring.test.js`
Expected: the 6 new tests FAIL with `Cleanup.ringFaces is not a function` / `Cleanup.ringLeaves is not a function`.

- [ ] **Step 3: Implement** — in `js/select.js`, after `tiltAxis`, add:

```js
  // Ring slab |(p − c)·n| ≤ h (c,n are [x,y,z], n unit). Flood parent faces
  // from seedFace, accepting a face iff its triangle meets the slab — i.e. its
  // corners are not all strictly on one side. Exact for any triangle size, so
  // the loop never stops short on coarse faces. Returns Int32Array (empty when
  // the seed misses the slab).
  function ringFaces(mesh, seedFace, c, n, h) {
    const { start, list, nf } = Cleanup.faceGraph(mesh);
    const P = mesh.positions;
    const d = (vi) => (P[vi * 3] - c[0]) * n[0] + (P[vi * 3 + 1] - c[1]) * n[1] + (P[vi * 3 + 2] - c[2]) * n[2];
    const meets = (f) => {
      const a = d(mesh.v1[f]), b = d(mesh.v2[f]), e = d(mesh.v3[f]);
      return !((a > h && b > h && e > h) || (a < -h && b < -h && e < -h));
    };
    if (seedFace < 0 || seedFace >= nf || !meets(seedFace)) return new Int32Array(0);
    const seen = new Uint8Array(nf);
    const out = [];
    const stk = [seedFace];
    seen[seedFace] = 1;
    while (stk.length) {
      const u = stk.pop();
      out.push(u);
      for (let e = start[u]; e < start[u + 1]; e++) {
        const v = list[e];
        if (!seen[v] && meets(v)) { seen[v] = 1; stk.push(v); }
      }
    }
    return Int32Array.from(out);
  }

  // Leaves (local subs) of `faces` whose centroid lies in the ring slab — the
  // coarse hover preview and the refine-off paint set.
  function ringLeaves(mesh, faces, c, n, h) {
    const g = Cleanup.buildSubGraph(mesh);
    const mask = new Uint8Array(mesh.nf);
    for (let i = 0; i < faces.length; i++) mask[faces[i]] = 1;
    const out = [];
    for (let s = 0; s < g.NS; s++) {
      if (!mask[g.subFace[s]]) continue;
      const dd = (g.cen[s * 3] - c[0]) * n[0] + (g.cen[s * 3 + 1] - c[1]) * n[1] + (g.cen[s * 3 + 2] - c[2]) * n[2];
      if (Math.abs(dd) <= h) out.push(s);
    }
    return Int32Array.from(out);
  }
```

Add `ringFaces,` and `ringLeaves,` to the `Object.assign(Cleanup, { ... })` export list.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/ring.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add js/select.js tests/ring.test.js
git commit -m "feat: ring slab selection (ringFaces face flood, ringLeaves)"
```

---

### Task 3: `Cleanup.paintRing` (refined + whole-leaf)

**Files:**
- Modify: `js/cleanup.js:247` (doc comment) and `js/cleanup.js:315` (`faceInRange` call passes `f`)
- Modify: `js/cleanup.js` (add `paintRing` after `stampMask`, export it)
- Test: `tests/ring.test.js`

**Interfaces:**
- Consumes: `Cleanup.ringFaces`, `Cleanup.ringLeaves` (Task 2); internal `refinePaint(mesh, state, { faceInRange, overlaps, covered, maxDepth })` and `applyStates(mesh, subs, state)`.
- Produces: `Cleanup.paintRing(mesh, faces, c, n, h, state, opts?) → { count, changedFaces: Set<int> }`. `opts.refine` (default `true`), `opts.maxDepth` (default 4).

- [ ] **Step 1: Write the failing tests** — append to `tests/ring.test.js`:

```js
function totalLeaves(Paint, mesh) {
  let n = 0;
  for (const p of mesh.paints) n += Paint.leafCount(Paint.decode(p));
  return n;
}
function subArea(g, s) {
  const a = g.sv[s * 3], b = g.sv[s * 3 + 1], c = g.sv[s * 3 + 2];
  const ux = g.vx[b] - g.vx[a], uy = g.vy[b] - g.vy[a], uz = g.vz[b] - g.vz[a];
  const vx = g.vx[c] - g.vx[a], vy = g.vy[c] - g.vy[a], vz = g.vz[c] - g.vz[a];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

test("paintRing (refined) paints a closed crisp band", () => {
  const { Cleanup } = loadModules();
  const segs = 8, r = 1, h = 2, zc = 5;
  const m = makeCylinder(segs, r, 10, 0);
  const c = [1, 0, zc], n = [0, 0, 1];
  const faces = Cleanup.ringFaces(m, 0, c, n, h);
  const res = Cleanup.paintRing(m, faces, c, n, h, 3, { maxDepth: 6 });
  assert.strictEqual(res.changedFaces.size, 16, "every face of the loop changed");
  const g = Cleanup.buildSubGraph(m);
  let area = 0;
  for (let s = 0; s < g.NS; s++) {
    const dz = Math.abs(g.cen[s * 3 + 2] - zc);
    const painted = g.subLeaf[s].state === 3;
    if (painted) { assert.ok(dz <= h + 1e-6, "painted leaf inside slab"); area += subArea(g, s); }
    if (dz <= h - 0.2) assert.ok(painted, "interior leaf painted (no gaps)");
  }
  const perimeter = segs * 2 * r * Math.sin(Math.PI / segs);
  const expected = 2 * h * perimeter;
  assert.ok(Math.abs(area - expected) / expected < 0.1, `area ${area} vs ${expected}`);
});

test("paintRing refine:false paints exactly ringLeaves and adds no geometry", () => {
  const { Paint, Cleanup } = loadModules();
  const m = makeCylinder(8, 1, 10, 0);
  const c = [1, 0, 10 / 3], n = [0, 0, 1], h = 0.5;
  const faces = Cleanup.ringFaces(m, 0, c, n, h);
  const expected = Array.from(Cleanup.ringLeaves(m, faces, c, n, h));
  const before = totalLeaves(Paint, m);
  const res = Cleanup.paintRing(m, faces, c, n, h, 3, { refine: false });
  assert.ok(res.changedFaces.size > 0, "something painted");
  assert.strictEqual(totalLeaves(Paint, m), before, "no leaves added");
  const g = Cleanup.buildSubGraph(m);
  const painted = [];
  for (let s = 0; s < g.NS; s++) if (g.subLeaf[s].state === 3) painted.push(s);
  assert.deepStrictEqual(painted, expected);
});

test("paintRing leaves faces outside the given set untouched", () => {
  const { Cleanup } = loadModules();
  const m = joinMeshes(makeCylinder(8, 1, 10, 0), makeCylinder(8, 1, 10, 5));
  const c = [1, 0, 5], n = [0, 0, 1], h = 1;
  const faces = Cleanup.ringFaces(m, 0, c, n, h);
  const res = Cleanup.paintRing(m, faces, c, n, h, 3);
  for (const f of res.changedFaces) assert.ok(f < 16, "only the clicked cylinder changed");
  for (let f = 16; f < 32; f++) assert.strictEqual(m.paints[f], "", "second cylinder unpainted");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/ring.test.js`
Expected: the 3 new tests FAIL with `Cleanup.paintRing is not a function`.

- [ ] **Step 3: Pass the face index to `faceInRange`** — in `js/cleanup.js` change the call inside `refinePaint`'s face loop:

```js
      if (!faceInRange(x0, y0, z0, x1, y1, z1, x2, y2, z2)) continue;
```
to
```js
      if (!faceInRange(x0, y0, z0, x1, y1, z1, x2, y2, z2, f)) continue;
```

and update the doc comment line above `refinePaint`:

```js
   *   faceInRange(x0..x2, f) -> bool  broad-phase reject per root face (f = face index)
```

(`paintStamps`/`stampMask` ignore the extra argument.)

- [ ] **Step 4: Implement `paintRing`** — in `js/cleanup.js`, after `stampMask`, add:

```js
  /* Paint the ring slab |(p − c)·n| ≤ h on `faces` (from Cleanup.ringFaces).
   * refine (default true): refinePaint subdivides leaves crossing the slab
   * planes, so band edges are straight. refine:false: whole leaves whose
   * centroid is in the slab (Cleanup.ringLeaves), no added geometry. */
  function paintRing(mesh, faces, c, n, h, state, opts) {
    if (opts && opts.refine === false) return applyStates(mesh, Cleanup.ringLeaves(mesh, faces, c, n, h), state);
    const inSet = new Uint8Array(mesh.nf);
    for (let i = 0; i < faces.length; i++) inSet[faces[i]] = 1;
    const d = (x, y, z) => (x - c[0]) * n[0] + (y - c[1]) * n[1] + (z - c[2]) * n[2];
    const covered = (x, y, z) => Math.abs(d(x, y, z)) <= h;
    const overlaps = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
      const a = d(ax, ay, az), b = d(bx, by, bz), e = d(cx, cy, cz);
      return !((a > h && b > h && e > h) || (a < -h && b < -h && e < -h));
    };
    const faceInRange = (x0, y0, z0, x1, y1, z1, x2, y2, z2, f) => inSet[f] === 1;
    return refinePaint(mesh, state, { faceInRange, overlaps, covered, maxDepth: (opts && opts.maxDepth) || 4 });
  }
```

Add `paintRing,` to the `Object.assign(Cleanup, { ... })` export list at the bottom of `cleanup.js`.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: all pass (52 existing + 12 in `ring.test.js`). If the area assertion fails, print `area`/`expected` and check `subArea` before touching tolerances — at `maxDepth` 6 the leaf height is 10/64 ≈ 0.16 against a band height of 4, so the error should be well under 10%.

- [ ] **Step 6: Commit**

```bash
git add js/cleanup.js tests/ring.test.js
git commit -m "feat: Cleanup.paintRing — refined slab painting via refinePaint"
```

---

### Task 4: Ring UI — place, adjust, apply + slab gizmo

**Files:**
- Modify: `index.html:94-98` (ring panel)
- Modify: `js/viewer.js` (add `setRingPlanes` after `setCutPlane`, export it)
- Modify: `js/app.js` (ring state/functions replace `doRing`; `onHover`; `onPick`; `setTool`; `loadFile`; `jumpTo`; listeners; keydown)
- Modify: `js/select.js` (remove `selectBandAxis` + its export)
- Modify: `CLAUDE.md` (test count)

**Interfaces:**
- Consumes: `Cleanup.tiltAxis`, `Cleanup.ringFaces`, `Cleanup.ringLeaves`, `Cleanup.paintRing`, `Cleanup.featureAxis(mesh, seedSub, Rn, nx, ny, nz) → { ax, ay, az, ... }`, `Cleanup.buildSubGraph`.
- Produces: `Viewer.setRingPlanes({ cx, cy, cz, nx, ny, nz, h, r } | null)`.

- [ ] **Step 1: Replace the ring panel** in `index.html` (the `<div class="opt" data-panel="ring" hidden>` block) with:

```html
        <div class="opt" data-panel="ring" hidden>
          <span class="optlabel">Axis</span>
          <div class="axes" id="ringAxes">
            <button type="button" data-axis="0">X</button>
            <button type="button" data-axis="1">Y</button>
            <button type="button" data-axis="2" class="on">Z</button>
            <button type="button" data-axis="fit" title="Fit the axis to the feature under the ring">Fit</button>
          </div>
          <span class="optlabel">Tilt</span>
          <input type="range" id="ringTiltA" min="-90" max="90" value="0" title="Tilt A" />
          <input type="range" id="ringTiltB" min="-90" max="90" value="0" title="Tilt B" />
          <span class="optlabel">Thickness</span>
          <input type="range" id="ringThick" min="1" max="100" value="14" />
          <span class="sizedot" id="ringPrev"></span>
          <label class="check"><input type="checkbox" id="ringRefine" checked /><span>Refine edges</span></label>
          <button type="button" id="ringApply" class="primary" disabled>Apply</button>
          <button type="button" id="ringCancel" class="icon" disabled>Cancel</button>
        </div>
```

- [ ] **Step 2: Add the gizmo** — in `js/viewer.js`, after the `setCutPlane` function, add:

```js
  let ringPlanesObj = null;
  // Show the ring slab's two bounding planes as translucent discs
  // ({cx,cy,cz,nx,ny,nz,h,r}: center, unit axis, half-thickness, disc radius)
  // or hide (null).
  function setRingPlanes(rp) {
    if (!rp) { if (ringPlanesObj) ringPlanesObj.visible = false; return; }
    if (!ringPlanesObj) {
      ringPlanesObj = new THREE.Group();
      const cg = new THREE.CircleGeometry(1, 64);
      const eg = new THREE.EdgesGeometry(cg); // coplanar inner edges drop out: rim only
      const cm = new THREE.MeshBasicMaterial({ color: 0x4ea1ff, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false });
      const lm = new THREE.LineBasicMaterial({ color: 0x2f7fe0 });
      for (let i = 0; i < 2; i++) {
        const disc = new THREE.Mesh(cg, cm);
        disc.add(new THREE.LineSegments(eg, lm));
        disc.renderOrder = 998;
        ringPlanesObj.add(disc);
      }
      scene.add(ringPlanesObj);
    }
    const [a, b] = ringPlanesObj.children;
    a.scale.setScalar(rp.r); b.scale.setScalar(rp.r);
    a.position.set(0, 0, rp.h); b.position.set(0, 0, -rp.h);
    ringPlanesObj.position.set(rp.cx, rp.cy, rp.cz);
    tmpV.set(rp.nx, rp.ny, rp.nz).normalize();
    tmpQ.setFromUnitVectors(ZUP, tmpV); // CircleGeometry faces +Z
    ringPlanesObj.quaternion.copy(tmpQ);
    ringPlanesObj.visible = true;
  }
```

and add `setRingPlanes,` after `setCutPlane,` in the `global.Viewer = { ... }` export.

- [ ] **Step 3: Replace `doRing` with the ring tool block** — in `js/app.js`, delete the whole `function doRing(hit) { ... }` (keep `const ringNeighborhood = () => modelSize * 0.2;`) and put this in its place:

```js
  // ---------- ring tool ----------
  // Placement source: { meshIndex, face, sub, c:[x,y,z], nrm:[x,y,z] }.
  let pendingRing = null; // frozen placement once the user clicks
  let ringFit = null;     // fitted base axis [x,y,z] while "Fit" is the active base
  const ringSrcFromHit = (hit) => ({
    meshIndex: hit.meshIndex,
    face: Cleanup.buildSubGraph(doc.meshes[hit.meshIndex]).subFace[hit.localSub],
    sub: hit.localSub,
    c: [hit.point.x, hit.point.y, hit.point.z],
    nrm: [hit.normal.x, hit.normal.y, hit.normal.z],
  });
  // Current ring axis: X/Y/Z (or the fitted axis) tilted by the two sliders.
  function ringAxis() {
    const on = document.querySelector("#ringAxes button.on");
    const ta = (+$("ringTiltA").value) * Math.PI / 180, tb = (+$("ringTiltB").value) * Math.PI / 180;
    if (on && on.dataset.axis === "fit" && ringFit) {
      const n = ringFit, a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const u = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
      const L = Math.hypot(u[0], u[1], u[2]);
      return Cleanup.tiltAxis(n, [u[0] / L, u[1] / L, u[2] / L], ta, tb);
    }
    const k = on && on.dataset.axis !== "fit" ? +on.dataset.axis : 2;
    const n = [0, 0, 0], u = [0, 0, 0];
    n[k] = 1; u[(k + 1) % 3] = 1;
    return Cleanup.tiltAxis(n, u, ta, tb);
  }
  function hideRing() { clearHoverPreview(); Viewer.setRingPlanes(null); }
  // Tint the ring's in-slab leaves and draw the slab gizmo for `src`.
  function showRing(src) {
    clearHoverPreview();
    const m = doc.meshes[src.meshIndex];
    const g = Cleanup.buildSubGraph(m);
    const n = ringAxis(), h = ringHalf(), c = src.c;
    const subs = Cleanup.ringLeaves(m, Cleanup.ringFaces(m, src.face, c, n, h), c, n, h);
    const gl = [];
    for (const s of subs) { const gi = Viewer.toGlobalSub(src.meshIndex, s); if (gi >= 0) gl.push(gi); }
    Viewer.setPreview(gl);
    previewCache = { tool: "ring", meshIndex: src.meshIndex, members: new Set(subs), globalSubs: gl, subs };
    // gizmo: loop centroid projected onto the mid-plane; radius covers the loop
    let mx = 0, my = 0, mz = 0;
    for (const s of subs) { mx += g.cen[s * 3]; my += g.cen[s * 3 + 1]; mz += g.cen[s * 3 + 2]; }
    let r = modelSize * 0.15;
    if (subs.length) {
      mx /= subs.length; my /= subs.length; mz /= subs.length;
      const dd = (mx - c[0]) * n[0] + (my - c[1]) * n[1] + (mz - c[2]) * n[2];
      mx -= dd * n[0]; my -= dd * n[1]; mz -= dd * n[2];
      let r2 = 0;
      for (const s of subs) {
        const x = g.cen[s * 3] - mx, y = g.cen[s * 3 + 1] - my, z = g.cen[s * 3 + 2] - mz;
        const p = x * n[0] + y * n[1] + z * n[2];
        r2 = Math.max(r2, (x - p * n[0]) ** 2 + (y - p * n[1]) ** 2 + (z - p * n[2]) ** 2);
      }
      r = Math.sqrt(r2) * 1.3 || r;
    } else { mx = c[0]; my = c[1]; mz = c[2]; }
    Viewer.setRingPlanes({ cx: mx, cy: my, cz: mz, nx: n[0], ny: n[1], nz: n[2], h, r });
  }
  // Recompute after an axis/tilt/thickness change.
  function refreshRing() {
    if (!doc || activeTool !== "ring") return;
    if (pendingRing) showRing(pendingRing);
    else { hideRing(); if (lastHit) onHover(lastHit); }
  }
  function placeRing(hit) {
    if (!hit || hit.localSub == null) return;
    if (previewActive) { restore(current()); previewActive = false; render(null); }
    pendingRing = ringSrcFromHit(hit);
    $("ringApply").disabled = false;
    $("ringCancel").disabled = false;
    showRing(pendingRing);
  }
  function cancelRing() {
    pendingRing = null;
    if (doc) hideRing();
    $("ringApply").disabled = true;
    $("ringCancel").disabled = true;
  }
  function applyRing() {
    if (!pendingRing) { toast("Click the model to place the ring first", true); return; }
    if (paintState == null) { toast("Pick a paint color first", true); return; }
    const src = pendingRing;
    const m = doc.meshes[src.meshIndex];
    const n = ringAxis(), h = ringHalf();
    busy("Painting ring…", () => {
      const faces = Cleanup.ringFaces(m, src.face, src.c, n, h);
      const res = Cleanup.paintRing(m, faces, src.c, n, h, paintState, { refine: $("ringRefine").checked, maxDepth: 4 });
      if (!res.changedFaces.size) { toast("Nothing painted — already that color", true); return; }
      pushHistory("Ring");
      cancelRing();
      render(null);
      ensureSubGraphs("Preparing tool…");
      updateStats();
      toast("Ring · " + faces.length.toLocaleString() + " faces");
    });
  }
  // Fit: one-shot PCA feature axis at the placed (or hovered) point.
  function fitRing() {
    const src = pendingRing || (lastHit && lastHit.localSub != null ? ringSrcFromHit(lastHit) : null);
    if (!src) { toast("Hover or place the ring on the model first", true); return; }
    const fa = Cleanup.featureAxis(doc.meshes[src.meshIndex], src.sub, ringNeighborhood(), src.nrm[0], src.nrm[1], src.nrm[2]);
    ringFit = [fa.ax, fa.ay, fa.az];
    document.querySelectorAll("#ringAxes button").forEach((x) => x.classList.toggle("on", x.dataset.axis === "fit"));
    $("ringTiltA").value = 0; $("ringTiltB").value = 0;
    refreshRing();
  }
```

- [ ] **Step 4: Rewire hover and pick** — in `onHover`, add this branch right after the stamp branch (before the `split/ring/fill` branch):

```js
    if (activeTool === "ring") {
      Viewer.hideCursor();
      if (pendingRing) return; // frozen until re-placed, applied or cancelled
      if (!hit || hit.localSub == null) { hideRing(); return; }
      if (previewCache && previewCache.tool === "ring" && previewCache.meshIndex === hit.meshIndex && previewCache.members.has(hit.localSub)) return;
      showRing(ringSrcFromHit(hit));
      return;
    }
```

Then in the existing branch change the condition `if (activeTool === "split" || activeTool === "ring" || activeTool === "fill") {` to `if (activeTool === "split" || activeTool === "fill") {`, and replace its inner selection

```js
      } else if (activeTool === "fill") {
        ...
      } else {
        const fa = Cleanup.featureAxis(m, hit.localSub, ringNeighborhood(), hit.normal.x, hit.normal.y, hit.normal.z);
        subs = Cleanup.selectBandAxis(m, hit.localSub, ringHalf(), fa.ax, fa.ay, fa.az);
      }
```

with

```js
      } else {
        ...the existing fill body, unchanged...
      }
```

(i.e. `else if (activeTool === "fill") {` becomes `else {` and the trailing ring `else` block is deleted).

In `Viewer.onPick`, change `if (activeTool === "ring") doRing(hit);` to `if (activeTool === "ring") placeRing(hit);`.

- [ ] **Step 5: Lifecycle hooks**
  - `setTool`: after the line `if (name !== "stamp" && typeof cancelStamp === "function") cancelStamp();` add
    ```js
    if (name !== "ring" && typeof cancelRing === "function") cancelRing();
    ```
  - `loadFile`: after `pendingDecal = null;` add `cancelRing();`
  - `jumpTo`: after `clearHoverPreview();` add `cancelRing(); // undo/redo can change faces under a placed ring`

- [ ] **Step 6: Listeners and keys**
  - Replace the `$("ringThick").addEventListener(...)` block with:
    ```js
    $("ringThick").addEventListener("input", () => { updateSizeDots(); refreshRing(); });
    ["ringTiltA", "ringTiltB"].forEach((id) => $(id).addEventListener("input", refreshRing));
    document.querySelectorAll("#ringAxes button").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.dataset.axis === "fit") { fitRing(); return; }
        document.querySelectorAll("#ringAxes button").forEach((x) => x.classList.toggle("on", x === b));
        refreshRing();
      })
    );
    $("ringApply").addEventListener("click", applyRing);
    $("ringCancel").addEventListener("click", cancelRing);
    ```
  - In the `keydown` handler, between `const tag = (e.target && e.target.tagName) || "";` and `if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;`, insert:
    ```js
    // placed ring: Enter applies / Esc cancels, even with a ring slider focused
    if (activeTool === "ring" && pendingRing && (e.key === "Enter" || e.key === "Escape")) {
      const t = e.target && e.target.type;
      if (tag !== "INPUT" || t === "range" || t === "checkbox") {
        e.preventDefault();
        if (e.key === "Enter") applyRing(); else cancelRing();
        return;
      }
    }
    ```

- [ ] **Step 7: Remove dead code** — in `js/select.js` delete `selectBandAxis` (the function and its `// Band of connected sub-triangles...` comment) and its `selectBandAxis,` export entry. Confirm no remaining references:

Run: `grep -rn "selectBandAxis\|doRing" js tests`
Expected: no output.

Run: `npm test`
Expected: all pass. Update the test count in `CLAUDE.md` (`52 tests.` → the new total that `npm test` reports as `# pass`).

- [ ] **Step 8: Browser verification** (Playwright MCP)
  1. Start a static server on a new port: `python3 -m http.server 8731` (run in background) from the repo root.
  2. Navigate to `http://localhost:8731/`, load the tracked sample from `samples/` via the file input.
  3. Select the Ring tool (key `n`), pick a palette color. Hover a limb: expect a tinted band plus two blue discs at Z orientation.
  4. Click to place; drag Tilt A — the band and discs rotate live and the hover no longer moves them. Click X / Y — orientation switches. Click Fit — it orients along the limb and the tilts reset to 0.
  5. Click Apply: one closed band with straight edges; the history shows one "Ring" entry; Ctrl+Z removes it.
  6. Review Focus checks: place → Ctrl+Z → the placement and discs are cleared; with no color selected → Apply shows "Pick a paint color first"; place, focus Tilt A, press Esc → placement cancelled and the tool stays Ring; place, focus Tilt A, press Enter → applied.
  7. Check `browser_console_messages` for errors. Take a screenshot of an applied ring (screenshots are gitignored and disposable).

- [ ] **Step 9: Commit**

```bash
git add index.html js/app.js js/viewer.js js/select.js CLAUDE.md
git commit -m "feat: ring tool place-then-adjust UI with axis presets, tilts and slab gizmo"
```
