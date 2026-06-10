# Paint & Ring Quality (Batch F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Slicer-grade brush strokes (subdivide triangles at the stroke edge via stamp refinement), a ring tool whose axis follows the surface normal with a band-tint preview, and X/Y/Z-combinable stroke symmetry.

**Architecture:** A pure `Cleanup.paintStamps` walks each touched face's paint tree with exact `Paint.tessellate` geometry, painting fully-covered leaves and 4-way-splitting edge-crossing leaves to depth 4 (then `Paint.collapseDeep` re-merges uniform subtrees). Strokes record stamps; symmetry mirrors the stamp list (`Cleanup.mirrorStamps`/`axisCenters`). The ring reuses the split tool's surface tint for its preview and orthogonalizes its PCA axis against the clicked normal.

**Tech Stack:** Vanilla JS (IIFE + globals), three.js, Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-06-10-paint-ring-quality-design.md`

**Conventions:** `node --test` from repo root; suite is **34** before this batch → **35** (T1) → **38** (T2) → **39** (T3) → **39** (T4) → **40** (T5). `node --check` changed js files each task. Stage only named files; never the `.3mf`s. Match on code, not line numbers.

---

### Task 1: `Paint.collapseDeep`

**Files:**
- Modify: `js/paint.js`
- Test: `tests/region.test.js`

- [ ] **Step 1: Write the failing test** — append to `tests/region.test.js`:

```javascript
test("collapseDeep merges uniform subtrees and keeps mixed ones", () => {
  const { Paint } = loadModules();
  const leaf = (s) => ({ leaf: true, state: s });
  const uniform = { leaf: false, split: 3, special: 0, kids: [leaf(2), leaf(2), leaf(2), leaf(2)] };
  const nested = { leaf: false, split: 1, special: 0, kids: [uniform, leaf(2)] };
  const collapsed = Paint.collapseDeep(nested);
  assert.ok(collapsed.leaf, "fully uniform tree becomes one leaf");
  assert.equal(collapsed.state, 2);
  const mixed = { leaf: false, split: 1, special: 0, kids: [leaf(1), leaf(2)] };
  const kept = Paint.collapseDeep(mixed);
  assert.ok(!kept.leaf, "mixed tree stays split");
});
```
(`Paint` is already in the harness's return object; add it to this file's destructure if missing.)

- [ ] **Step 2: Run to verify failure** — `node --test tests/region.test.js` → FAIL (`Paint.collapseDeep is not a function`).

- [ ] **Step 3: Implement** — add to `js/paint.js` (next to `collapseIfUniform`):

```javascript
  // Recursively merge subtrees whose leaves all share one state into a single
  // leaf (post-order). Returns a (possibly new) tree; never mutates the input.
  function collapseDeep(node) {
    if (node.leaf) return node;
    const kids = node.kids.map(collapseDeep);
    if (kids.every((k) => k.leaf && k.state === kids[0].state)) {
      return { leaf: true, state: kids[0].state };
    }
    return { leaf: false, special: node.special, split: node.split, kids };
  }
```
and add `collapseDeep` to the `global.Paint = { ... }` export.

- [ ] **Step 4: Run** — `node --test` → **35 pass / 0 fail**.

- [ ] **Step 5: Commit**

```bash
git add js/paint.js tests/region.test.js
git commit -m "feat(paint): collapseDeep merges uniform subtrees"
```

---

### Task 2: `Cleanup.paintStamps` — stamp-refinement painting

**Files:**
- Modify: `js/cleanup.js` (point-triangle distance + `paintStamps`; export)
- Modify: `tests/harness.js` (`makeBigTriangle` fixture + export)
- Test: `tests/region.test.js`

- [ ] **Step 1: Add the fixture to `tests/harness.js`** (and export `makeBigTriangle`):

```javascript
// One large unpainted face (state 0) for stamp-refinement tests.
function makeBigTriangle() {
  return {
    nf: 1,
    positions: new Float32Array([0, 0, 0, 8, 0, 0, 0, 8, 0]),
    v1: Int32Array.from([0]),
    v2: Int32Array.from([1]),
    v3: Int32Array.from([2]),
    paints: [""],
  };
}
```

- [ ] **Step 2: Write the failing tests** — append to `tests/region.test.js` (add `makeBigTriangle` to the destructure):

```javascript
test("paintStamps subdivides a face at the stroke edge", () => {
  const { Cleanup, Paint } = loadModules();
  const mesh = makeBigTriangle();
  const res = Cleanup.paintStamps(mesh, [{ x: 2, y: 2, z: 0, r: 0.9 }], 1, { maxDepth: 4 });
  assert.ok(res.count > 0, "some leaves painted");
  const tree = Paint.decode(mesh.paints[0]);
  const n = Paint.leafCount(tree);
  assert.ok(n > 1, "face was subdivided (leafCount " + n + ")");
  assert.ok(n <= Math.pow(4, 4), "depth bound respected");
  const counts = {};
  Paint.addLeafCounts(tree, counts);
  assert.ok((counts[1] || 0) > 0, "painted leaves present");
  assert.ok((counts[0] || 0) > 0, "unpainted leaves remain outside the stamp");
});

test("paintStamps collapses a fully covered face to a solid leaf", () => {
  const { Cleanup, Paint } = loadModules();
  const mesh = makeBigTriangle();
  Cleanup.paintStamps(mesh, [{ x: 2.5, y: 2.5, z: 0, r: 50 }], 1, { maxDepth: 4 });
  assert.equal(Paint.solidState(mesh.paints[0]), 1, "single solid state-1 leaf (collapsed)");
});

test("paintStamps leaves untouched faces alone", () => {
  const { Cleanup } = loadModules();
  const mesh = makeBigTriangle();
  const res = Cleanup.paintStamps(mesh, [{ x: 50, y: 50, z: 50, r: 1 }], 1, { maxDepth: 4 });
  assert.equal(res.count, 0);
  assert.equal(mesh.paints[0], "", "paint string unchanged");
});
```

- [ ] **Step 3: Run to verify failure** — `node --test tests/region.test.js` → FAIL (`Cleanup.paintStamps is not a function`).

- [ ] **Step 4: Implement** — add to `js/cleanup.js` (e.g. after `applyStates`):

```javascript
  // Squared distance from point p to triangle (a,b,c) — Ericson's closest-point
  // construction, all inputs flat scalars.
  function dist2PointTri(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const v = d1 / (d1 - d3);
      const qx = ax + abx * v - px, qy = ay + aby * v - py, qz = az + abz * v - pz;
      return qx * qx + qy * qy + qz * qz;
    }
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const w = d2 / (d2 - d6);
      const qx = ax + acx * w - px, qy = ay + acy * w - py, qz = az + acz * w - pz;
      return qx * qx + qy * qy + qz * qz;
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
      const qx = bx + (cx - bx) * w - px, qy = by + (cy - by) * w - py, qz = bz + (cz - bz) * w - pz;
      return qx * qx + qy * qy + qz * qz;
    }
    const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
    const qx = ax + abx * v + acx * w - px, qy = ay + aby * v + acy * w - py, qz = az + abz * v + acz * w - pz;
    return qx * qx + qy * qy + qz * qz;
  }

  /* Slicer-style stamp painting: paint leaves fully inside the stamp union and
   * SUBDIVIDE leaves crossing the stamp edge (4-way splits, depth-capped), so
   * stroke edges follow the brush instead of whole leaves. Child geometry uses
   * Paint.tessellate's exact conventions (corner rotation by `special`,
   * midpoints, reversed kid order). Trees are re-collapsed and re-encoded.
   * stamps: [{x,y,z,r}]. Returns { count, changedFaces }. */
  function paintStamps(mesh, stamps, state, opts) {
    const maxDepth = (opts && opts.maxDepth) || 4;
    const P = mesh.positions;
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
    // broad phase: stamp union AABB vs face AABB
    let sx0 = Infinity, sy0 = Infinity, sz0 = Infinity, sx1 = -Infinity, sy1 = -Infinity, sz1 = -Infinity;
    for (const s of stamps) {
      sx0 = Math.min(sx0, s.x - s.r); sy0 = Math.min(sy0, s.y - s.r); sz0 = Math.min(sz0, s.z - s.r);
      sx1 = Math.max(sx1, s.x + s.r); sy1 = Math.max(sy1, s.y + s.r); sz1 = Math.max(sz1, s.z + s.r);
    }

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
        // partial overlap: split this leaf in place (children inherit its state)
        const st = node.state;
        node.leaf = false; node.split = 3; node.special = 0;
        node.kids = [
          { leaf: true, state: st }, { leaf: true, state: st },
          { leaf: true, state: st }, { leaf: true, state: st },
        ];
        faceChanged = true;
        // fall through into the split handling below
      }
      const sp = node.special, split = node.split, kids = node.kids;
      const cs = [ax, ay, az, bx, by, bz, cx, cy, cz];
      const A = sp * 3, B = ((sp + 1) % 3) * 3, D = ((sp + 2) % 3) * 3;
      const Ax = cs[A], Ay = cs[A + 1], Az = cs[A + 2];
      const Bx = cs[B], By = cs[B + 1], Bz = cs[B + 2];
      const Dx = cs[D], Dy = cs[D + 1], Dz = cs[D + 2];
      const k = (g) => kids[split - g]; // tessellate's reversed kid mapping
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
      if (Math.max(x0, x1, x2) < sx0 || Math.min(x0, x1, x2) > sx1 ||
          Math.max(y0, y1, y2) < sy0 || Math.min(y0, y1, y2) > sy1 ||
          Math.max(z0, z1, z2) < sz0 || Math.min(z0, z1, z2) > sz1) continue;
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
    if (changedFaces.size) invalidateSub(mesh);
    return { count, changedFaces };
  }
```
Add `paintStamps` to the `global.Cleanup = { ... }` export. (`dist2PointTri` stays private.)

- [ ] **Step 5: Run** — `node --test` → **38 pass / 0 fail**.

- [ ] **Step 6: Commit**

```bash
git add js/cleanup.js tests/harness.js tests/region.test.js
git commit -m "feat(brush): paintStamps — slicer-style stamp refinement with depth-capped splits"
```

---

### Task 3: `Cleanup.axisCenters` + `Cleanup.mirrorStamps`

**Files:**
- Modify: `js/cleanup.js`
- Test: `tests/region.test.js`

- [ ] **Step 1: Write the failing test** — append to `tests/region.test.js` (uses `makeMirrorPair` already exported):

```javascript
test("mirrorStamps reflects stamps across enabled axis centers", () => {
  const { Cleanup } = loadModules();
  const mesh = makeMirrorPair(); // x-symmetric around x=0
  const one = Cleanup.mirrorStamps(mesh, [{ x: 1.5, y: 0.3, z: 0, r: 0.5 }], [0]);
  assert.equal(one.length, 2);
  assert.ok(one.some((s) => Math.abs(s.x - 1.5) < 1e-6));
  assert.ok(one.some((s) => Math.abs(s.x + 1.5) < 1e-6), "reflected about the x center (0)");
  const two = Cleanup.mirrorStamps(mesh, [{ x: 1.5, y: 0.3, z: 0, r: 0.5 }], [0, 1]);
  assert.equal(two.length, 4, "two axes -> 4 copies");
});
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/region.test.js` → FAIL (`mirrorStamps is not a function`).

- [ ] **Step 3: Implement** — add to `js/cleanup.js`:

```javascript
  // Per-axis center of the sub-triangle centroid bounds — the SAME centers
  // mirrorMap uses, so live mirror previews and stamp reflection agree.
  function axisCenters(mesh) {
    if (mesh._axisCenters) return mesh._axisCenters;
    const g = buildSubGraph(mesh);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < g.NS; i++) for (let a = 0; a < 3; a++) {
      const v = g.cen[i * 3 + a];
      if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v;
    }
    mesh._axisCenters = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    return mesh._axisCenters;
  }

  // Expand a stamp list across the enabled mirror axes (0=x,1=y,2=z): each
  // enabled axis doubles the list with copies reflected about that axis center,
  // yielding all 2^k combinations.
  function mirrorStamps(mesh, stamps, axes) {
    if (!axes || !axes.length) return stamps;
    const c = axisCenters(mesh);
    const keys = ["x", "y", "z"];
    let out = stamps.slice();
    for (const a of axes) {
      const add = out.map((s) => {
        const m = { x: s.x, y: s.y, z: s.z, r: s.r };
        m[keys[a]] = 2 * c[a] - m[keys[a]];
        return m;
      });
      out = out.concat(add);
    }
    return out;
  }
```
In `invalidateSub(mesh)`, also clear the cache: add `mesh._axisCenters = null;`. Add `axisCenters, mirrorStamps` to the export.

- [ ] **Step 4: Run** — `node --test` → **39 pass / 0 fail**.

- [ ] **Step 5: Commit**

```bash
git add js/cleanup.js tests/region.test.js
git commit -m "feat(symmetry): axisCenters + mirrorStamps (combinable axes)"
```

---

### Task 4: Stroke wiring + symmetry chips (UI)

**Files:**
- Modify: `index.html` (brush panel)
- Modify: `js/app.js` (`startStroke`, `brushAt`, `endStroke`, chip wiring)
- Modify: `css/style.css` (`.axes` chips)

- [ ] **Step 1: Replace the symmetry controls in `index.html`.** The brush panel currently ends with:
```html
          <label class="check"><input type="checkbox" id="brushSym" /><span>Symmetry</span></label>
          <select id="brushSymAxis"><option value="x" selected>X</option><option value="y">Y</option><option value="z">Z</option></select>
```
Replace those two lines with:
```html
          <span class="optlabel">Mirror</span>
          <div class="axes" id="symAxes">
            <button type="button" data-axis="0" title="Mirror across X">X</button>
            <button type="button" data-axis="1" title="Mirror across Y">Y</button>
            <button type="button" data-axis="2" title="Mirror across Z">Z</button>
          </div>
```

- [ ] **Step 2: Chip styling** — append to `css/style.css` (near `.palette` rules):
```css
.axes { display: flex; gap: 5px; }
.axes button { flex: 0 0 auto; width: 34px; padding: 7px 0; font-size: 12.5px; font-weight: 700; border-radius: 9px; }
.axes button.on { background: linear-gradient(140deg, var(--accent-2), var(--accent-d)); border-color: transparent; color: #fff; box-shadow: 0 6px 12px -6px var(--accent); }
```

- [ ] **Step 3: Rewire the stroke in `js/app.js`.** Replace `startStroke`, `brushAt`, and `endStroke` with:

```javascript
  function startStroke(hit) {
    if (paintState == null) return;
    if (previewActive) { restore(current()); previewActive = false; }
    stroke = { mi: hit.meshIndex, pend: new Set(), stamps: [] };
    brushAt(hit);
  }
  const enabledAxes = () => [...document.querySelectorAll("#symAxes button.on")].map((b) => +b.dataset.axis);
  function brushAt(hit) {
    if (!stroke || hit.meshIndex !== stroke.mi) return;
    const m = doc.meshes[hit.meshIndex];
    const r = brushRadius();
    stroke.stamps.push({ x: hit.point.x, y: hit.point.y, z: hit.point.z, r });
    // live preview: whole-leaf tint (the precise stamp refinement runs on release)
    const subs = Cleanup.selectRadius(m, hit.localSub, hit.point.x, hit.point.y, hit.point.z, r);
    let all = subs;
    const axes = enabledAxes();
    if (axes.length) {
      const set = new Set(subs);
      for (const a of axes) {
        const mir = Cleanup.mirrorMap(m, a);
        for (const s of [...set]) { const p = mir[s]; if (p >= 0) set.add(p); }
      }
      all = [...set];
    }
    const g = [];
    for (const s of all) { stroke.pend.add(s); g.push(Viewer.toGlobalSub(hit.meshIndex, s)); }
    Viewer.paintSubs(g, paintState);
  }
  function endStroke() {
    if (!stroke) return;
    const m = doc.meshes[stroke.mi], stamps = stroke.stamps;
    stroke = null;
    if (!stamps.length) return;
    const expanded = Cleanup.mirrorStamps(m, stamps, enabledAxes());
    busy("Refining stroke…", () => {
      const res = Cleanup.paintStamps(m, expanded, paintState, { maxDepth: 4 });
      if (!res.count) { render(null); return; } // painted same-over-same: just restore the live tint
      pushHistory("Brush");
      render(null);
      updateStats();
    });
  }
```

- [ ] **Step 4: Wire the chips.** Near the other event wiring in `js/app.js`, add:
```javascript
  document.querySelectorAll("#symAxes button").forEach((b) =>
    b.addEventListener("click", () => b.classList.toggle("on"))
  );
```
Remove nothing else — the old `#brushSym`/`#brushSymAxis` reads disappeared with `brushAt`'s rewrite (grep to confirm no references remain).

- [ ] **Step 5: Run** — `node --check js/app.js && node --test` → silent; **39 pass / 0 fail**.

- [ ] **Step 6: Browser-verify (controller).** Brush an unpainted area, release → the stroke edge refines (visibly subdivided, smooth); enable X (and X+Y), stroke → mirrored copies appear on release; undo restores.

- [ ] **Step 7: Commit**

```bash
git add index.html js/app.js css/style.css
git commit -m "feat(brush): stamp-refined strokes on release; combinable X/Y/Z mirror chips"
```

---

### Task 5: Ring — normal-aligned axis + band tint preview

**Files:**
- Modify: `js/cleanup.js` (`featureAxis` signature + orthogonalization, snap removed)
- Modify: `js/app.js` (`onHover`, `doRing`, `setTool` clear, ringThick listener, rename `clearSplitPreview` → `clearHoverPreview`)
- Test: `tests/region.test.js`

- [ ] **Step 1: Write the failing test** — append to `tests/region.test.js`:

```javascript
test("featureAxis orthogonalizes against a given surface normal", () => {
  const { Cleanup } = loadModules();
  const fa = Cleanup.featureAxis(makeTetra(), 0, 10, 0, 0, 1); // small region -> early-return path
  const dot = fa.ax * 0 + fa.ay * 0 + fa.az * 1;
  assert.ok(Math.abs(dot) < 1e-6, "axis is perpendicular to the normal (got dot " + dot + ")");
});
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/region.test.js` → FAIL (early return yields `az: 1`, dot = 1).

- [ ] **Step 3: Update `featureAxis` in `js/cleanup.js`.** Change the signature to `featureAxis(mesh, seedSub, Rn, nx, ny, nz)` (normal optional). Add an orthogonalizer just inside the function:

```javascript
    // Constrain an axis to the plane perpendicular to the surface normal (the
    // ring's wrap plane contains the normal). No-op when no normal is given.
    const ortho = (x, y, z) => {
      if (nx === undefined) return [x, y, z];
      const d = x * nx + y * ny + z * nz;
      let ox = x - d * nx, oy = y - d * ny, oz = z - d * nz;
      let L = Math.hypot(ox, oy, oz);
      if (L < 1e-6) { // axis ∥ normal: pick any perpendicular
        ox = ny; oy = -nx; oz = 0;            // n × (0,0,1)
        L = Math.hypot(ox, oy, oz);
        if (L < 1e-6) { ox = 0; oy = nz; oz = -ny; L = Math.hypot(ox, oy, oz); } // n × (1,0,0)
      }
      return [ox / L, oy / L, oz / L];
    };
```
- The `< 8` early return becomes: `const [eax, eay, eaz] = ortho(0, 0, 1); return { ax: eax, ay: eay, az: eaz, cx: sx, cy: sy, cz: sz, radius: Rn * 0.5 };`
- After the power iteration produces `vx, vy, vz`, **delete the vertical-snap lines** (`if (Math.abs(vz) > 0.82) { vx = 0; vy = 0; vz = 1; }`) and instead apply: `const [oax, oay, oaz] = ortho(vx, vy, vz); vx = oax; vy = oay; vz = oaz;` — the radius/center math below then uses the constrained axis unchanged.

- [ ] **Step 4: Generalize the hover preview + rewire ring in `js/app.js`.**
- Rename `clearSplitPreview` to `clearHoverPreview` (update its definition and ALL call sites: `setTool`, `doSplit`, `jumpTo`, `doReset`).
- In `setTool`, change `if (name !== "split") clearSplitPreview();` to `if (name !== "split" && name !== "ring") clearHoverPreview();`
- Replace `onHover` with a version that tints for split AND ring (split logic unchanged; ring computes the band; brush keeps its circle cursor):

```javascript
  function onHover(hit) {
    lastHit = hit;
    if (activeTool === "split" || activeTool === "ring") {
      Viewer.hideCursor();
      if (!hit || hit.localSub == null) { clearHoverPreview(); return; }
      if (previewCache && previewCache.tool === activeTool && previewCache.meshIndex === hit.meshIndex && previewCache.members.has(hit.localSub)) return;
      clearHoverPreview();
      const m = doc.meshes[hit.meshIndex];
      let subs;
      if (activeTool === "split") {
        subs = Cleanup.selectColorRegion(m, hit.localSub, claimedByMesh()[hit.meshIndex]);
      } else {
        const fa = Cleanup.featureAxis(m, hit.localSub, ringNeighborhood(), hit.normal.x, hit.normal.y, hit.normal.z);
        subs = Cleanup.selectBandAxis(m, hit.localSub, ringHalf(), fa.ax, fa.ay, fa.az);
      }
      if (!subs.length) return;
      const members = new Set(subs);
      const g = [];
      for (const s of subs) { const gi = Viewer.toGlobalSub(hit.meshIndex, s); if (gi >= 0) g.push(gi); }
      Viewer.setPreview(g);
      previewCache = { tool: activeTool, meshIndex: hit.meshIndex, members, globalSubs: g, subs };
      return;
    }
    if (!hit) { Viewer.hideCursor(); return; }
    if (activeTool === "brush") {
      const n = hit.normal;
      Viewer.setCursorTransform(hit.point.x, hit.point.y, hit.point.z, n.x, n.y, n.z, brushRadius());
    }
  }
```
(The old ring cursor-transform branch is gone; `previewCache` entries now carry `tool` and `subs` — the cache declaration's comment should be updated accordingly.)
- Replace `doRing` so the click paints exactly the previewed band (recomputing only on a cache miss):

```javascript
  function doRing(hit) {
    if (paintState == null) return;
    if (previewActive) { restore(current()); previewActive = false; }
    const m = doc.meshes[hit.meshIndex];
    let subs;
    if (previewCache && previewCache.tool === "ring" && previewCache.meshIndex === hit.meshIndex && previewCache.members.has(hit.localSub)) {
      subs = previewCache.subs;
    } else {
      const fa = Cleanup.featureAxis(m, hit.localSub, ringNeighborhood(), hit.normal.x, hit.normal.y, hit.normal.z);
      subs = Cleanup.selectBandAxis(m, hit.localSub, ringHalf(), fa.ax, fa.ay, fa.az);
    }
    if (!subs.length) return;
    clearHoverPreview();
    Cleanup.applyStates(m, subs, paintState);
    pushHistory("Ring");
    render(null);
    updateStats();
    toast("Ring · " + subs.length.toLocaleString() + " sub-triangles");
  }
```
- The `#ringThick` input listener currently refreshes the cursor via `onHover(lastHit)`; the cached band must not survive a thickness change — make it:
```javascript
  $("ringThick").addEventListener("input", () => {
    updateSizeDots();
    if (activeTool === "ring") { clearHoverPreview(); if (lastHit) onHover(lastHit); }
  });
```

- [ ] **Step 5: Run** — `node --check js/cleanup.js && node --check js/app.js && node --test` → silent; **40 pass / 0 fail**.

- [ ] **Step 6: Browser-verify (controller).** Ring tool: hovering tints the actual wrap-around band hugging the contour (no floating circle); the band follows where the surface points (axis ⊥ normal); click paints exactly the tinted band; thickness slider live-updates the tint.

- [ ] **Step 7: Commit**

```bash
git add js/cleanup.js js/app.js
git commit -m "feat(ring): normal-aligned band axis + on-surface band tint preview"
```

---

## Self-Review

**Spec coverage:** §1 stamps/subdivision → T2 (core) + T4 (wiring); collapse → T1; symmetry stamps + chips + live composition → T3 + T4; §2 ring axis + tint preview + preview==result → T5; §3 combinable axes → T3/T4. All covered.

**Placeholder scan:** none — every step has complete code, exact commands, expected counts (34→35→38→39→39→40).

**Type consistency:** `paintStamps(mesh, stamps, state, {maxDepth})` defined (T2) = called (T4). `mirrorStamps(mesh, stamps, axes)` defined (T3) = called (T4); axes from `enabledAxes()` are numbers 0/1/2 matching `mirrorMap(m, a)` and `axisCenters` indexing. `featureAxis(mesh, seed, Rn, nx, ny, nz)` (T5) matches both call sites (`hit.normal.x/y/z`). `previewCache` fields (`tool/meshIndex/members/globalSubs/subs`) consistent across `onHover`/`doRing`/`clearHoverPreview`. `collapseDeep` (T1) used by T2. Fixture names (`makeBigTriangle`, `makeMirrorPair`) match harness exports.
