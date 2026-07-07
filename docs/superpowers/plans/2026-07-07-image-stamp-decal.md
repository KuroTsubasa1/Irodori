# Image Stamp-Map (Decal) Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `stamp` tool that projects an uploaded black & white image onto the model at a picked point as a stencil decal — dark pixels paint the current filament, light pixels are transparent — with a live preview, size/rotation controls, and a refine-edges toggle.

**Architecture:** A new pure module `js/decal.js` builds a tangent frame at the pick point, maps mesh points into decal UV space, and samples the image mask. The refinement walker inside `js/cleanup.js` is extracted into a shared `refinePaint` internal so both the existing circle stamp (`paintStamps`) and a new mask stamp (`stampMask`) drive the same tessellation logic. `js/app.js` wires the tool UI, image upload, hover preview, and Apply/Cancel commit.

**Tech Stack:** Vanilla JS IIFEs on `window`, three.js (vendored) for picking, Canvas 2D for image decode. Tests via `node --test` (`npm test`) using `tests/harness.js`.

**Depends on:** `2026-07-07-brush-responsiveness.md` must land first — this plan reuses `ensureSubGraphs()` (re-warm) and the refine-toggle pattern from it.

## Global Constraints

- No bundler / no ESM / no framework. Scripts are IIFEs attaching globals to `window`; `<script>` order in `index.html` is the dependency graph. `decal.js` loads after `select.js` and before `cleanup.js` is not required — it has no `Cleanup` dependency, so load it right after `select.js`.
- Never `Read` a `.3mf`. Reference model is in `samples/`.
- Paint "states" = filament indices; state 0 = default extruder. Current `paintState` is the color dark pixels receive.
- After editing files under `js/`, restart the static server on a NEW port.
- `Paint.tessellate` is THE geometry convention; anything subdividing faces must match it exactly. The shared `refinePaint` keeps that logic in one place.
- Spec: `docs/superpowers/specs/2026-07-07-image-stamp-decal-design.md`.

---

### Task 1: `decal.js` pure projection module

**Files:**
- Create: `js/decal.js`
- Modify: `index.html` (add `<script src="js/decal.js"></script>` right after the `js/select.js` script tag)
- Modify: `tests/harness.js` (add `"js/decal.js"` to the load list and `Decal: sandbox.Decal` to the returned globals)
- Test: `tests/decal.test.js` (create)

**Interfaces:**
- Produces (all on `window.Decal`):
  - `frame(px,py,pz, nx,ny,nz, refUpx,refUpy,refUpz, rotRad) -> { ox,oy,oz, rx,ry,rz, ux,uy,uz, nx,ny,nz }` — orthonormal tangent frame at the pick point. `n` is the unit surface normal; `u` is `refUp` projected onto the tangent plane, rotated by `rotRad` about `n`; `r = normalize(n × u)`. If `refUp` is near-parallel to `n`, substitute world +X then +Y.
  - `uv(frame, px,py,pz, w, h) -> { u, v }` where `u = ((p-o)·r)/w + 0.5`, `v = ((p-o)·u_axis)/h + 0.5`; `w`,`h` are full world extents of the decal.
  - `sampleMask(mask, u, v) -> boolean` — `mask = { data:Uint8Array(len=w*h luminance 0..255), w, h, threshold, invert }`. Out-of-`[0,1]` → `false`. Pixel `px=clamp(floor(u*w),0,w-1)`, `py=clamp(floor((1-v)*h),0,h-1)`; `lum=data[py*w+px]`; paint = `invert ? lum>=threshold : lum<threshold`.

- [ ] **Step 1: Write the failing test**

Create `tests/decal.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { loadModules } = require("./harness");

test("frame is orthonormal with n preserved", () => {
  const { Decal } = loadModules();
  const f = Decal.frame(0, 0, 0, 0, 0, 1, 0, 1, 0, 0);
  // n unchanged
  assert.ok(Math.abs(f.nx) < 1e-9 && Math.abs(f.ny) < 1e-9 && Math.abs(f.nz - 1) < 1e-9);
  // r,u,n mutually orthonormal
  const dot = (ax, ay, az, bx, by, bz) => ax * bx + ay * by + az * bz;
  assert.ok(Math.abs(dot(f.rx, f.ry, f.rz, f.ux, f.uy, f.uz)) < 1e-9, "r⊥u");
  assert.ok(Math.abs(dot(f.rx, f.ry, f.rz, f.nx, f.ny, f.nz)) < 1e-9, "r⊥n");
  assert.ok(Math.abs(dot(f.ux, f.uy, f.uz, f.nx, f.ny, f.nz)) < 1e-9, "u⊥n");
  assert.ok(Math.abs(Math.hypot(f.rx, f.ry, f.rz) - 1) < 1e-9, "r unit");
});

test("frame falls back when refUp parallel to n", () => {
  const { Decal } = loadModules();
  // n = +Y, refUp = +Y (parallel) -> must not produce NaN
  const f = Decal.frame(0, 0, 0, 0, 1, 0, 0, 1, 0, 0);
  assert.ok(Number.isFinite(f.rx) && Number.isFinite(f.ux));
  assert.ok(Math.abs(Math.hypot(f.rx, f.ry, f.rz) - 1) < 1e-9);
});

test("uv maps origin to center and axes to ±0.5", () => {
  const { Decal } = loadModules();
  const f = Decal.frame(0, 0, 0, 0, 0, 1, 0, 1, 0, 0); // r along +X-ish, u along +Y-ish
  const c = Decal.uv(f, 0, 0, 0, 2, 2);
  assert.ok(Math.abs(c.u - 0.5) < 1e-9 && Math.abs(c.v - 0.5) < 1e-9);
  // move one full half-width along r -> u = 1.0
  const p = Decal.uv(f, f.rx, f.ry, f.rz, 2, 2); // point at distance 1 along r; w=2 -> +0.5
  assert.ok(Math.abs(p.u - 1.0) < 1e-9, "u at +half-width");
});

test("sampleMask thresholds and inverts; out-of-range is transparent", () => {
  const { Decal } = loadModules();
  // 2x2: top-left black(0), rest white(255)
  const mask = { data: Uint8Array.from([0, 255, 255, 255]), w: 2, h: 2, threshold: 128, invert: false };
  // v near 1 = top of image (py=0); u near 0 = left (px=0) -> black -> paint
  assert.equal(Decal.sampleMask(mask, 0.25, 0.75), true);
  assert.equal(Decal.sampleMask(mask, 0.75, 0.75), false); // top-right white
  assert.equal(Decal.sampleMask(mask, 1.5, 0.5), false);   // out of range
  const inv = Object.assign({}, mask, { invert: true });
  assert.equal(Decal.sampleMask(inv, 0.25, 0.75), false);  // inverted: black now transparent
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="frame is orthonormal"`
Expected: FAIL (`Decal` undefined / not a function).

- [ ] **Step 3: Create `js/decal.js`**

```js
// Image-decal projection: tangent frame at a picked point, model→decal UV
// mapping, and B&W mask sampling. Pure geometry, no Cleanup/Viewer deps.
(function () {
  "use strict";
  const EPS = 1e-9;
  const dot = (ax, ay, az, bx, by, bz) => ax * bx + ay * by + az * bz;
  const norm = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
  const cross = (ax, ay, az, bx, by, bz) => [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];

  function frame(px, py, pz, nx, ny, nz, upx, upy, upz, rotRad) {
    const [Nx, Ny, Nz] = norm(nx, ny, nz);
    // project refUp onto the tangent plane
    let d = dot(upx, upy, upz, Nx, Ny, Nz);
    let ux = upx - d * Nx, uy = upy - d * Ny, uz = upz - d * Nz;
    if (ux * ux + uy * uy + uz * uz < EPS) {
      // refUp parallel to N: fall back to world +X, then +Y
      d = dot(1, 0, 0, Nx, Ny, Nz);
      ux = 1 - d * Nx; uy = -d * Ny; uz = -d * Nz;
      if (ux * ux + uy * uy + uz * uz < EPS) {
        d = dot(0, 1, 0, Nx, Ny, Nz);
        ux = -d * Nx; uy = 1 - d * Ny; uz = -d * Nz;
      }
    }
    [ux, uy, uz] = norm(ux, uy, uz);
    // rotate u about N by rotRad (Rodrigues, u ⟂ N so simplifies)
    const c = Math.cos(rotRad || 0), s = Math.sin(rotRad || 0);
    const [kx, ky, kz] = cross(Nx, Ny, Nz, ux, uy, uz); // N × u, unit
    let ru = [ux * c + kx * s, uy * c + ky * s, uz * c + kz * s];
    [ux, uy, uz] = norm(ru[0], ru[1], ru[2]);
    const [rx, ry, rz] = norm(...cross(Nx, Ny, Nz, ux, uy, uz)); // r = N × u
    return { ox: px, oy: py, oz: pz, rx, ry, rz, ux, uy, uz, nx: Nx, ny: Ny, nz: Nz };
  }

  function uv(f, px, py, pz, w, h) {
    const dx = px - f.ox, dy = py - f.oy, dz = pz - f.oz;
    return {
      u: dot(dx, dy, dz, f.rx, f.ry, f.rz) / w + 0.5,
      v: dot(dx, dy, dz, f.ux, f.uy, f.uz) / h + 0.5,
    };
  }

  function sampleMask(mask, u, v) {
    if (u < 0 || u > 1 || v < 0 || v > 1) return false;
    let px = Math.floor(u * mask.w); if (px >= mask.w) px = mask.w - 1; if (px < 0) px = 0;
    let py = Math.floor((1 - v) * mask.h); if (py >= mask.h) py = mask.h - 1; if (py < 0) py = 0;
    const lum = mask.data[py * mask.w + px];
    return mask.invert ? lum >= mask.threshold : lum < mask.threshold;
  }

  window.Decal = { frame, uv, sampleMask };
})();
```

- [ ] **Step 4: Register `decal.js` in the harness**

In `tests/harness.js`, add `"js/decal.js"` to the module load array (after `"js/select.js"`) and add `Decal: sandbox.Decal,` to the returned object.

- [ ] **Step 5: Add the script tag to `index.html`**

Find the `<script src="js/select.js"></script>` line and add immediately after it:

```html
    <script src="js/decal.js"></script>
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="frame|uv maps|sampleMask"`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add js/decal.js index.html tests/harness.js tests/decal.test.js
git commit -m "feat: add decal.js — tangent frame, UV mapping, mask sampling

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Shared refinement walker + `stampMask` in `cleanup.js`

**Files:**
- Modify: `js/cleanup.js` (`paintStamps` lines 253-351; add `refinePaint` and `stampMask`; export `stampMask`)
- Test: `tests/decal.test.js` (append)

**Interfaces:**
- Consumes: `Paint.decode/encode/collapseDeep/dominantState` (existing); `Cleanup.invalidateSub` (existing); `Decal.frame/uv/sampleMask` (Task 1).
- Produces:
  - internal `refinePaint(mesh, state, { faceInRange, overlaps, covered, maxDepth }) -> { count, changedFaces:Set }` — the extracted per-face walker (was the body of `paintStamps`). `faceInRange(x0,y0,z0,x1,y1,z1,x2,y2,z2)->bool` broad-phase per root face; `overlaps(ax..cz)->bool` leaf-vs-region; `covered(x,y,z)->bool` point-in-region. Invalidates `_sub` when any face changed.
  - `Cleanup.stampMask(mesh, frame, mask, w, h, state, { depthBand, maxDepth }) -> { count, changedFaces:Set }` — projects `mask` through `frame` (Decal UV) onto front-facing leaves within `depthBand` of the decal plane.

- [ ] **Step 1: Write the failing tests (append to `tests/decal.test.js`)**

```js
const { makeBigTriangle } = require("./harness");

function totalLeaves(Paint, mesh) {
  let n = 0; for (const p of mesh.paints) n += Paint.leafCount(Paint.decode(p)); return n;
}

test("stampMask with an all-black mask paints the covered footprint", () => {
  const { Paint, Cleanup, Decal } = loadModules();
  const mesh = makeBigTriangle();
  const g = Cleanup.buildSubGraph(mesh);
  // pick the centroid of sub 0 and its face normal ~ +Z for makeBigTriangle (in XY plane)
  const cx = g.cen[0], cy = g.cen[1], cz = g.cen[2];
  const f = Decal.frame(cx, cy, cz, 0, 0, 1, 0, 1, 0, 0);
  const mask = { data: Uint8Array.from([0]), w: 1, h: 1, threshold: 128, invert: false }; // all black
  const res = Cleanup.stampMask(mesh, f, mask, 100, 100, 3, { depthBand: 1, maxDepth: 4 });
  assert.ok(res.count > 0, "painted some leaves");
});

test("stampMask with an all-white mask paints nothing", () => {
  const { Cleanup, Decal } = loadModules();
  const mesh = makeBigTriangle();
  const g = Cleanup.buildSubGraph(mesh);
  const f = Decal.frame(g.cen[0], g.cen[1], g.cen[2], 0, 0, 1, 0, 1, 0, 0);
  const mask = { data: Uint8Array.from([255]), w: 1, h: 1, threshold: 128, invert: false };
  const res = Cleanup.stampMask(mesh, f, mask, 100, 100, 3, { depthBand: 1, maxDepth: 4 });
  assert.equal(res.count, 0, "nothing painted");
});

test("stampMask half/half mask subdivides only near the boundary", () => {
  const { Paint, Cleanup, Decal } = loadModules();
  const mesh = makeBigTriangle();
  const g = Cleanup.buildSubGraph(mesh);
  const before = totalLeaves(Paint, mesh);
  // big footprint centered on the triangle, left half black / right half white
  const bx = (g.vx.reduce((a, b) => a + b, 0)) / g.NV;
  const by = (g.vy.reduce((a, b) => a + b, 0)) / g.NV;
  const bz = (g.vz.reduce((a, b) => a + b, 0)) / g.NV;
  const f = Decal.frame(bx, by, bz, 0, 0, 1, 0, 1, 0, 0);
  const mask = { data: Uint8Array.from([0, 255]), w: 2, h: 1, threshold: 128, invert: false };
  const res = Cleanup.stampMask(mesh, f, mask, 1000, 1000, 3, { depthBand: 5, maxDepth: 4 });
  assert.ok(res.count > 0, "painted the black half");
  assert.ok(totalLeaves(Paint, mesh) > before, "subdivided near the black/white edge");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --test-name-pattern="stampMask"`
Expected: FAIL (`Cleanup.stampMask is not a function`).

- [ ] **Step 3: Extract `refinePaint` from `paintStamps` in `js/cleanup.js`**

Replace the whole `paintStamps` function (lines 253-351) with the extracted walker plus a thin `paintStamps` built on it. The `walk`/per-face loop below is the *identical* body currently in `paintStamps`, with the three stamp-specific predicates (`covered`, `overlaps`, broad-phase AABB) turned into injected callbacks:

```js
  /* Shared refinement walker: paint leaves fully inside a region and SUBDIVIDE
   * leaves crossing its edge (depth-capped), matching Paint.tessellate's exact
   * conventions. Callbacks:
   *   faceInRange(x0..x2) -> bool  broad-phase reject per root face
   *   overlaps(ax..cz)    -> bool  does this leaf touch the region?
   *   covered(x,y,z)      -> bool  is this point inside the region?
   * Returns { count, changedFaces }. */
  function refinePaint(mesh, state, opts) {
    const maxDepth = (opts && opts.maxDepth) || 4;
    const { faceInRange, overlaps, covered } = opts;
    const P = mesh.positions;
    let count = 0;
    const changedFaces = new Set();
    let faceChanged = false;

    function walk(node, depth, ax, ay, az, bx, by, bz, cx, cy, cz) {
      if (node.leaf) {
        if (!overlaps(ax, ay, az, bx, by, bz, cx, cy, cz)) return;
        const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;
        const full = covered(ax, ay, az) && covered(bx, by, bz) && covered(cx, cy, cz) && covered(mx, my, mz);
        if (full) {
          if (node.state !== state) { node.state = state; count++; faceChanged = true; }
          return;
        }
        if (depth >= maxDepth) {
          if (covered(mx, my, mz) && node.state !== state) { node.state = state; count++; faceChanged = true; }
          return;
        }
        const st = node.state;
        node.leaf = false; node.split = 3; node.special = 0;
        node.kids = [
          { leaf: true, state: st }, { leaf: true, state: st },
          { leaf: true, state: st }, { leaf: true, state: st },
        ];
        faceChanged = true;
      }
      const sp = node.special, split = node.split, kids = node.kids;
      const cs = [ax, ay, az, bx, by, bz, cx, cy, cz];
      const A = sp * 3, B = ((sp + 1) % 3) * 3, D = ((sp + 2) % 3) * 3;
      const Ax = cs[A], Ay = cs[A + 1], Az = cs[A + 2];
      const Bx = cs[B], By = cs[B + 1], Bz = cs[B + 2];
      const Dx = cs[D], Dy = cs[D + 1], Dz = cs[D + 2];
      const k = (gk) => kids[split - gk];
      if (split === 1) {
        const mx = (Bx + Dx) / 2, my = (By + Dy) / 2, mz = (Bz + Dz) / 2;
        walk(k(0), depth + 1, Ax, Ay, Az, Bx, By, Bz, mx, my, mz);
        walk(k(1), depth + 1, mx, my, mz, Dx, Dy, Dz, Ax, Ay, Az);
      } else if (split === 2) {
        const m1x = (Ax + Bx) / 2, m1y = (Ay + By) / 2, m1z = (Az + Bz) / 2;
        const m2x = (Ax + Dx) / 2, m2y = (Ay + Dy) / 2, m2z = (Az + Dz) / 2;
        walk(k(0), depth + 1, Ax, Ay, Az, m1x, m1y, m1z, m2x, m2y, m2z);
        walk(k(1), depth + 1, m1x, m1y, m1z, Bx, By, Bz, m2x, m2y, m2z);
        walk(k(2), depth + 1, Bx, By, Bz, Dx, Dy, Dz, m2x, m2y, m2z);
      } else {
        const m1x = (Ax + Bx) / 2, m1y = (Ay + By) / 2, m1z = (Az + Bz) / 2;
        const m2x = (Bx + Dx) / 2, m2y = (By + Dy) / 2, m2z = (Bz + Dz) / 2;
        const m3x = (Ax + Dx) / 2, m3y = (Ay + Dy) / 2, m3z = (Az + Dz) / 2;
        walk(k(0), depth + 1, Ax, Ay, Az, m1x, m1y, m1z, m3x, m3y, m3z);
        walk(k(1), depth + 1, m1x, m1y, m1z, Bx, By, Bz, m2x, m2y, m2z);
        walk(k(2), depth + 1, m2x, m2y, m2z, Dx, Dy, Dz, m3x, m3y, m3z);
        walk(k(3), depth + 1, m1x, m1y, m1z, m2x, m2y, m2z, m3x, m3y, m3z);
      }
    }

    for (let f = 0; f < mesh.nf; f++) {
      const a = mesh.v1[f] * 3, b = mesh.v2[f] * 3, c = mesh.v3[f] * 3;
      const x0 = P[a], y0 = P[a + 1], z0 = P[a + 2];
      const x1 = P[b], y1 = P[b + 1], z1 = P[b + 2];
      const x2 = P[c], y2 = P[c + 1], z2 = P[c + 2];
      if (!faceInRange(x0, y0, z0, x1, y1, z1, x2, y2, z2)) continue;
      const tree = Paint.decode(mesh.paints[f]);
      faceChanged = false;
      walk(tree, 0, x0, y0, z0, x1, y1, z1, x2, y2, z2);
      if (faceChanged) {
        const col = Paint.collapseDeep(tree);
        mesh.paints[f] = Paint.encode(col);
        if (mesh.dom) mesh.dom[f] = Paint.dominantState(col);
        changedFaces.add(f);
      }
    }
    if (changedFaces.size) Cleanup.invalidateSub(mesh);
    return { count, changedFaces };
  }

  /* Slicer-style circle-stamp painting (brush release). stamps: [{x,y,z,r}]. */
  function paintStamps(mesh, stamps, state, opts) {
    const covered = (x, y, z) => {
      for (const s of stamps) {
        const dx = x - s.x, dy = y - s.y, dz = z - s.z;
        if (dx * dx + dy * dy + dz * dz <= s.r * s.r) return true;
      }
      return false;
    };
    const overlaps = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
      for (const s of stamps) {
        if (dist2PointTri(s.x, s.y, s.z, ax, ay, az, bx, by, bz, cx, cy, cz) <= s.r * s.r) return true;
      }
      return false;
    };
    let sx0 = Infinity, sy0 = Infinity, sz0 = Infinity, sx1 = -Infinity, sy1 = -Infinity, sz1 = -Infinity;
    for (const s of stamps) {
      sx0 = Math.min(sx0, s.x - s.r); sy0 = Math.min(sy0, s.y - s.r); sz0 = Math.min(sz0, s.z - s.r);
      sx1 = Math.max(sx1, s.x + s.r); sy1 = Math.max(sy1, s.y + s.r); sz1 = Math.max(sz1, s.z + s.r);
    }
    const faceInRange = (x0, y0, z0, x1, y1, z1, x2, y2, z2) =>
      !(Math.max(x0, x1, x2) < sx0 || Math.min(x0, x1, x2) > sx1 ||
        Math.max(y0, y1, y2) < sy0 || Math.min(y0, y1, y2) > sy1 ||
        Math.max(z0, z1, z2) < sz0 || Math.min(z0, z1, z2) > sz1);
    return refinePaint(mesh, state, { faceInRange, overlaps, covered, maxDepth: (opts && opts.maxDepth) || 4 });
  }
```

- [ ] **Step 4: Add `stampMask` (after `paintStamps` in `js/cleanup.js`)**

```js
  /* Project a B&W image mask through a Decal frame onto front-facing leaves
   * within depthBand of the decal plane. frame from Decal.frame; w,h are the
   * decal's world extents; mask is { data, w, h, threshold, invert }. */
  function stampMask(mesh, frame, mask, w, h, state, opts) {
    const depthBand = (opts && opts.depthBand != null) ? opts.depthBand : Math.max(w, h);
    const nx = frame.nx, ny = frame.ny, nz = frame.nz;
    const covered = (x, y, z) => {
      const d = (x - frame.ox) * nx + (y - frame.oy) * ny + (z - frame.oz) * nz;
      if (Math.abs(d) > depthBand) return false;
      const c = Decal.uv(frame, x, y, z, w, h);
      return Decal.sampleMask(mask, c.u, c.v);
    };
    const overlaps = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
      const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;
      return covered(ax, ay, az) || covered(bx, by, bz) || covered(cx, cy, cz) || covered(mx, my, mz);
    };
    // broad phase: face AABB vs decal sphere (radius = half-diagonal + depthBand)
    // AND front-facing (root-face normal · decal normal > 0).
    const reach = Math.hypot(w, h) / 2 + depthBand;
    const faceInRange = (x0, y0, z0, x1, y1, z1, x2, y2, z2) => {
      // facing
      const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0;
      const vx = x2 - x0, vy = y2 - y0, vz = z2 - z0;
      const fnx = uy * vz - uz * vy, fny = uz * vx - ux * vz, fnz = ux * vy - uy * vx;
      if (fnx * nx + fny * ny + fnz * nz <= 0) return false;
      // AABB vs sphere around the decal origin
      const clamp = (val, lo, hi) => (val < lo ? lo : val > hi ? hi : val);
      const bx0 = Math.min(x0, x1, x2), bx1 = Math.max(x0, x1, x2);
      const by0 = Math.min(y0, y1, y2), by1 = Math.max(y0, y1, y2);
      const bz0 = Math.min(z0, z1, z2), bz1 = Math.max(z0, z1, z2);
      const qx = clamp(frame.ox, bx0, bx1) - frame.ox;
      const qy = clamp(frame.oy, by0, by1) - frame.oy;
      const qz = clamp(frame.oz, bz0, bz1) - frame.oz;
      return qx * qx + qy * qy + qz * qz <= reach * reach;
    };
    return refinePaint(mesh, state, { faceInRange, overlaps, covered, maxDepth: (opts && opts.maxDepth) || 4 });
  }
```

- [ ] **Step 5: Export `stampMask`**

In the `Object.assign(Cleanup, { … })` block (line 353), add `stampMask,` next to `paintStamps,`.

- [ ] **Step 6: Run the stampMask tests + full suite**

Run: `npm test`
Expected: all pass, including the three new `stampMask` tests and the existing brush/paintStamps tests (the refactor must not change `paintStamps` behavior).

- [ ] **Step 7: Commit**

```bash
git add js/cleanup.js tests/decal.test.js
git commit -m "feat: extract refinePaint walker; add Cleanup.stampMask for image decals

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Stamp tool UI + image upload

**Files:**
- Modify: `index.html` (toolbar button; options panel `data-panel="stamp"`)
- Modify: `js/app.js` (`setTool` tool routing; image upload + mask precompute; keyboard shortcut optional)

**Interfaces:**
- Consumes: `Decal` (Task 1); `Cleanup.stampMask` (Task 2); existing `setTool`, `busy`, palette (`paintState`).
- Produces: module-scoped `stampMask` state in `app.js` — `{ mask, aspect }` after upload; DOM ids `#stampFile`, `#stampThresh`, `#stampInvert`, `#stampSize`, `#stampRot`, `#stampRefine`, `#stampApply`, `#stampCancel`.

- [ ] **Step 1: Add the toolbar button (`index.html`)**

After the Fill tool button (line 31, before the `<span class="tooldiv">`), add:

```html
          <button class="tool" data-tool="stamp" title="Stamp (T) — project a B&W image as a decal">
            <svg class="ic" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 14l3-3 2 2 3-4"/></svg>
            <span>Stamp</span>
          </button>
```

- [ ] **Step 2: Add the options panel (`index.html`)**

After the `data-panel="brush"` block's closing `</div>` (line 73), add:

```html
        <div class="opt" data-panel="stamp" hidden>
          <label class="filebtn"><input type="file" id="stampFile" accept="image/*" hidden />Upload image</label>
          <span class="optlabel">Threshold</span>
          <input type="range" id="stampThresh" min="0" max="255" value="128" />
          <label class="check"><input type="checkbox" id="stampInvert" /><span>Invert</span></label>
          <span class="optlabel">Size</span>
          <input type="range" id="stampSize" min="1" max="100" value="30" />
          <span class="optlabel">Rotate</span>
          <input type="range" id="stampRot" min="0" max="360" value="0" />
          <label class="check"><input type="checkbox" id="stampRefine" checked /><span>Refine edges</span></label>
          <button type="button" id="stampApply" class="primary" disabled>Apply</button>
          <button type="button" id="stampCancel" class="icon" disabled>Cancel</button>
        </div>
```

- [ ] **Step 3: Route the tool in `setTool` (`js/app.js`)**

In `setTool` (line 320), extend the paint-tool handling so `stamp` shows the palette, uses `pick` interaction, and enables hover. Change line 324-327 to include `stamp`:

```js
    const paintTool = name === "brush" || name === "ring" || name === "fill" || name === "stamp";
    $("palette").classList.toggle("hide", !paintTool);
    Viewer.setTool(name === "brush" ? "paint" : (name === "ring" || name === "fill" || name === "split" || name === "stamp") ? "pick" : "orbit");
    Viewer.enableHover(name === "brush" || name === "ring" || name === "split" || name === "fill" || name === "stamp");
```

Also, when leaving the stamp tool, clear any pending decal (added in Task 4 as `cancelStamp()`); add to `setTool` after the interaction lines: `if (name !== "stamp" && typeof cancelStamp === "function") cancelStamp();`

- [ ] **Step 4: Image upload → luminance mask (`js/app.js`)**

Add near the other tool state (module scope) and wire the file input. Place this in the IIFE body alongside the other tool handlers (e.g. after the `Viewer.onHover(onHover)` wiring):

```js
  // ---------- stamp tool ----------
  let stampImg = null; // { mask:{data,w,h}, aspect }
  $("stampFile").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const MAXD = 512; // cap decode resolution
      let w = img.width, h = img.height;
      const sc = Math.min(1, MAXD / Math.max(w, h));
      w = Math.max(1, Math.round(w * sc)); h = Math.max(1, Math.round(h * sc));
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      const px = ctx.getImageData(0, 0, w, h).data;
      const lum = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const r = px[i * 4], gg = px[i * 4 + 1], b = px[i * 4 + 2];
        lum[i] = (0.299 * r + 0.587 * gg + 0.114 * b) | 0;
      }
      stampImg = { mask: { data: lum, w, h }, aspect: w / h };
      $("stampApply").disabled = false;
      toast("Image loaded — click the model to place");
      if (lastHit) onHover(lastHit);
    };
    img.onerror = () => toast("Could not read that image", true);
    img.src = URL.createObjectURL(file);
  });
```

- [ ] **Step 5: Manual verification (upload only)**

Static server, fresh port. Pick the Stamp tool → palette shows, panel shows. Upload a PNG → "Image loaded" toast, Apply enabled. (Placement/commit comes in Task 4; nothing paints yet.)

- [ ] **Step 6: Commit**

```bash
git add index.html js/app.js
git commit -m "feat: stamp tool UI + B&W image upload to luminance mask

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Stamp preview + placement + commit

**Files:**
- Modify: `js/app.js` (`onHover` for `stamp`; click-to-place via `Viewer.onPick`; Apply/Cancel; slider re-preview)

**Interfaces:**
- Consumes: `Decal.frame/uv/sampleMask`, `Cleanup.stampMask`, `Cleanup.applyStates`, `Viewer.paintSubs/toGlobalSub/setCursorTransform`, `ensureSubGraphs` (from brush-responsiveness plan), `pushHistory`, `render`, `updateStats`, `modelSize`, `stampImg` (Task 3).
- Produces: `cancelStamp()`; a `pendingDecal` state `{ meshIndex, frame, w, h }`; live whole-leaf tint preview; committed paint on Apply.

- [ ] **Step 1: Add helpers — decal params + footprint selection (`js/app.js`)**

```js
  let pendingDecal = null; // { meshIndex, frame } once the user clicks to place
  const stampSizeWorld = () => { const t = (+$("stampSize").value) / 100; return modelSize * (0.02 + 0.5 * t); };
  function stampWH() {
    const s = stampSizeWorld();
    const a = stampImg ? stampImg.aspect : 1;
    return a >= 1 ? { w: s, h: s / a } : { w: s * a, h: s }; // longest edge = s
  }
  function stampMaskObj() {
    return { data: stampImg.mask.data, w: stampImg.mask.w, h: stampImg.mask.h,
             threshold: +$("stampThresh").value, invert: $("stampInvert").checked };
  }
  // Whole-leaf preview: which local subs sample as "paint" under this frame.
  function decalPreviewSubs(m, frame, w, h, mask) {
    const g = Cleanup.buildSubGraph(m);
    const depthBand = Math.max(w, h);
    const out = [];
    for (let s = 0; s < g.NS; s++) {
      const x = g.cen[s * 3], y = g.cen[s * 3 + 1], z = g.cen[s * 3 + 2];
      const d = (x - frame.ox) * frame.nx + (y - frame.oy) * frame.ny + (z - frame.oz) * frame.nz;
      if (Math.abs(d) > depthBand) continue;
      const c = Decal.uv(frame, x, y, z, w, h);
      if (Decal.sampleMask(mask, c.u, c.v)) out.push(s);
    }
    return out;
  }
```

- [ ] **Step 2: Hover / placement preview in `onHover` (`js/app.js`)**

In `onHover`, add a `stamp` branch. Insert before the final brush cursor handling (before line 469 `if (!hit)`), a dedicated block:

```js
    if (activeTool === "stamp") {
      Viewer.hideCursor();
      if (!stampImg) return;
      // while un-placed, follow the hover point; once placed, keep pendingDecal
      const src = pendingDecal || (hit && hit.localSub != null
        ? { meshIndex: hit.meshIndex, frame: Decal.frame(hit.point.x, hit.point.y, hit.point.z,
              hit.normal.x, hit.normal.y, hit.normal.z, 0, 1, 0, (+$("stampRot").value) * Math.PI / 180) }
        : null);
      if (!src) { clearHoverPreview(); return; }
      clearHoverPreview();
      const m = doc.meshes[src.meshIndex];
      const { w, h } = stampWH();
      const subs = decalPreviewSubs(m, src.frame, w, h, stampMaskObj());
      const g = [];
      for (const s of subs) { const gi = Viewer.toGlobalSub(src.meshIndex, s); if (gi >= 0) g.push(gi); }
      Viewer.setPreview(g);
      previewCache = { tool: "stamp", meshIndex: src.meshIndex, members: new Set(subs), globalSubs: g, subs };
      return;
    }
```

- [ ] **Step 3: Click-to-place via `Viewer.onPick` (`js/app.js`)**

Find the existing `Viewer.onPick(...)` registration (search `onPick`). Add a `stamp` case that freezes the frame at the picked point:

```js
    if (activeTool === "stamp") {
      if (!stampImg || !hit || hit.localSub == null) return;
      pendingDecal = { meshIndex: hit.meshIndex,
        frame: Decal.frame(hit.point.x, hit.point.y, hit.point.z, hit.normal.x, hit.normal.y, hit.normal.z,
          0, 1, 0, (+$("stampRot").value) * Math.PI / 180) };
      $("stampCancel").disabled = false;
      onHover(hit); // refresh preview at the frozen frame
      return;
    }
```

If there is no `onPick` handler that switches on `activeTool`, register one in the same place tools are wired: `Viewer.onPick((hit) => { if (activeTool === "stamp") { /* body above */ } });` — check how `split`/`ring` clicks are handled and follow that pattern (they may use `onPaint`/`onPick`; match the existing mechanism).

- [ ] **Step 4: Re-preview when sliders/checkboxes change (`js/app.js`)**

```js
  ["stampThresh", "stampInvert", "stampSize", "stampRot"].forEach((id) =>
    $(id).addEventListener("input", () => {
      if (activeTool !== "stamp" || !stampImg) return;
      if (pendingDecal) { // rotation changed: rebuild the frozen frame's rotation
        const f = pendingDecal.frame;
        pendingDecal.frame = Decal.frame(f.ox, f.oy, f.oz, f.nx, f.ny, f.nz, 0, 1, 0, (+$("stampRot").value) * Math.PI / 180);
        onHover(lastHit);
      } else if (lastHit) onHover(lastHit);
    }));
```

- [ ] **Step 5: Apply / Cancel (`js/app.js`)**

```js
  function cancelStamp() {
    pendingDecal = null;
    clearHoverPreview();
    $("stampCancel").disabled = true;
  }
  $("stampCancel").addEventListener("click", cancelStamp);
  $("stampApply").addEventListener("click", () => {
    if (!stampImg) return;
    const src = pendingDecal;
    if (!src) { toast("Click the model to place the stamp first", true); return; }
    const m = doc.meshes[src.meshIndex];
    const { w, h } = stampWH();
    const mask = stampMaskObj();
    busy("Stamping…", () => {
      let res;
      if ($("stampRefine").checked) {
        res = Cleanup.stampMask(m, src.frame, mask, w, h, paintState, { depthBand: Math.max(w, h), maxDepth: 4 });
      } else {
        const subs = decalPreviewSubs(m, src.frame, w, h, mask);
        res = Cleanup.applyStates(m, subs, paintState);
      }
      if (!res.changedFaces.size) { toast("Nothing painted (adjust threshold or size)"); return; }
      pushHistory("Stamp");
      cancelStamp();
      render(null);
      ensureSubGraphs("Preparing tool…");
      updateStats();
    });
  });
```

- [ ] **Step 6: Manual verification (full flow)**

Static server, fresh port. Load a `.3mf`, pick Stamp, upload a high-contrast B&W logo. Hover → live tint follows the surface. Adjust Size/Rotate/Threshold → preview updates. Click to place → frame freezes. Apply with "Refine edges" on → crisp decal painted in the current color under a "Stamping…" toast; Undo reverts it. Toggle "Refine edges" off → coarse whole-leaf decal, no added geometry. Verify a decal on a thin wall does not bleed through to the back face.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all pass (Task 4 is app.js glue; module tests unchanged).

- [ ] **Step 8: Commit**

```bash
git add js/app.js
git commit -m "feat: stamp tool preview, placement, and refine-toggle commit

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** UI panel + upload → Task 3; projection geometry (`decal.js`) → Task 1; edge fidelity via shared walker + toggle → Task 2 (`stampMask`) + Task 4 (refine checkbox branch); preview/click/Apply/Cancel flow → Task 4; front-facing + depth-band (bleed-through guard) → Task 2 `faceInRange` (facing) + `covered` (depth). Mirror deferred, aspect preserved (`stampWH`) — matches non-goals.
- **Type consistency:** mask object shape `{ data, w, h, threshold, invert }` identical across `Decal.sampleMask` (Task 1), `Cleanup.stampMask` (Task 2), and `stampMaskObj()` (Task 4). `Decal.frame(...)` argument order (point, normal, refUp, rotRad) identical at every call site. `res.changedFaces.size` used for no-op checks (the field `applyStates`/`stampMask`/`refinePaint` all return).
- **Placeholder scan:** Task 4 Step 3 flags one codebase-dependent detail (whether stamp clicks route through `onPick` vs `onPaint`) — the implementer must match the existing ring/split click mechanism; the handler body is fully specified either way. No other placeholders.
- **Cross-plan dependency:** `ensureSubGraphs` (Task 4 Step 5) comes from `2026-07-07-brush-responsiveness.md` — land that plan first.
