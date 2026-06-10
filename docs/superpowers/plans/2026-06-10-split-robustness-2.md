# Split Robustness Round 2 (Batch J) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the three root-caused split regressions — inverted caps (exact per-component orientation), island-overlay membranes (nesting-aware Liepa dispatch), and parts exploding into the remainder (clear-the-model magnitude floor).

**Architecture:** `solidFromSubs` orients each cap component by majority-voting its rim-edge directions against the surface's stored boundary winding (`bEdge`) — the orientability condition itself, replacing the plane heuristic. `caps.js` runs the existing coplanarity classifier for `liepa` too, routing hole-bearing groups through the earcut emission. `viewer.js` floors explode distance at bounding-sphere clearance.

**Tech Stack:** Vanilla JS, Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-06-10-split-robustness-2-design.md`

**Conventions:** `node --test`; suite **52** before → **53** (T1) → **54** (T2) → **54** (T3). `node --check` changed files. Stage only named files; never `.3mf`s. NOTE: `makeTetra` is NOT consistently wound (edge (0,1) traversed 0→1 by two faces) — directed/volume assertions go on the tube fixture ONLY.

---

### Task 1: Exact per-component cap orientation (F1)

**Files:**
- Modify: `tests/harness.js` (two helpers + exports)
- Modify: `tests/split.test.js` (one new test)
- Modify: `js/split.js` (`orientCapComponents` helper; replace the heuristic block in `solidFromSubs`)

- [ ] **Step 1: Add helpers to `tests/harness.js`** (and export both):

```javascript
// Directed watertight check: a consistently-oriented closed mesh traverses
// every undirected edge exactly once in each direction. Returns the number of
// violating undirected edges.
function directedViolations(indices) {
  const dir = new Map(), und = new Set();
  for (let t = 0; t < indices.length; t += 3) {
    for (const [u, v] of [[indices[t], indices[t + 1]], [indices[t + 1], indices[t + 2]], [indices[t + 2], indices[t]]]) {
      dir.set(u + ">" + v, (dir.get(u + ">" + v) || 0) + 1);
      und.add(u < v ? u + "_" + v : v + "_" + u);
    }
  }
  let bad = 0;
  for (const k of und) {
    const [a, b] = k.split("_").map(Number);
    if ((dir.get(a + ">" + b) || 0) !== 1 || (dir.get(b + ">" + a) || 0) !== 1) bad++;
  }
  return bad;
}

// Signed volume of a closed triangle mesh (positive when outward-oriented).
function signedVolume(indices, positions) {
  let v6 = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    v6 += positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
        - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c])
        + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return v6 / 6;
}
```

- [ ] **Step 2: Write the failing test** — append to `tests/split.test.js` (add `directedViolations, signedVolume` to its harness destructure):

```javascript
test("tube solids are directed-watertight with positive volume (all methods)", () => {
  const { Cleanup, Split } = loadModules();
  for (const method of ["centroid", "projected", "earcut", "cdt", "liepa"]) {
    const tube = makeOpenTube();
    const g = Cleanup.buildSubGraph(tube);
    const solid = Split.solidFromSubs(tube, [...Array(g.NS).keys()], method);
    assert.equal(directedViolations(solid.indices), 0, method + ": every edge traversed once each way");
    const vol = signedVolume(solid.indices, solid.positions);
    assert.ok(vol > 7.9 && vol < 8.1, method + ": volume ~8 (2x2x2 tube), got " + vol.toFixed(2));
  }
});
```

- [ ] **Step 3: Run to verify failure** — `node --test tests/split.test.js`
Expected: FAIL — the tube's two rims face ±Z; the global-plane heuristic flips all caps together, so at least one method shows directed violations / wrong-sign volume.

- [ ] **Step 4: Implement.** In `js/split.js`, add a module-level helper (e.g. after `solidFromSubs`):

```javascript
  // Exact cap orientation: an orientable closed solid traverses every rim edge
  // once in each direction, and the SURFACE's direction is known (bEdge
  // first-seen = surface winding). Majority-vote each connected cap component's
  // rim-edge directions against surfDir and flip components that agree instead
  // of oppose. cap.tris reference cap.verts (global vids) for i < verts.length.
  function orientCapComponents(cap, surfDir) {
    const nT = cap.tris.length;
    if (!nT) return;
    // union-find over triangles sharing any ref
    const parent = new Int32Array(nT);
    for (let i = 0; i < nT; i++) parent[i] = i;
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const refOwner = new Map();
    cap.tris.forEach((t, ti) => {
      for (const r of t) {
        const o = refOwner.get(r);
        if (o === undefined) refOwner.set(r, ti);
        else { const a = find(o), b = find(ti); if (a !== b) parent[a] = b; }
      }
    });
    const ek = (a, b) => (a < b ? a + "_" + b : b + "_" + a);
    const agree = new Map(), oppose = new Map();
    cap.tris.forEach((t, ti) => {
      const root = find(ti);
      for (let i = 0; i < 3; i++) {
        const x = t[i], y = t[(i + 1) % 3];
        if (x >= cap.verts.length || y >= cap.verts.length) continue; // extras: never rim
        const u = cap.verts[x], v = cap.verts[y];
        const sd = surfDir.get(ek(u, v));
        if (!sd) continue; // a diagonal between rim vids, not a rim edge
        if (sd === u + ">" + v) agree.set(root, (agree.get(root) || 0) + 1);
        else oppose.set(root, (oppose.get(root) || 0) + 1);
      }
    });
    const flip = new Set();
    for (const root of new Set([...agree.keys(), ...oppose.keys()])) {
      const a = agree.get(root) || 0, o = oppose.get(root) || 0;
      if (a > o) flip.add(root);
      else if (a === o && a > 0) console.warn("solidFromSubs: ambiguous cap orientation; leaving component as-is");
    }
    if (flip.size) cap.tris.forEach((t, ti) => { if (flip.has(find(ti))) { const tmp = t[1]; t[1] = t[2]; t[2] = tmp; } });
  }
```

Then in `solidFromSubs`, REPLACE the old orientation block — everything from the comment `// orient part-outward: flip if the loops' plane normal points toward the` down to (and including) the `if (pl.nx * dir[0] + ...) { ...swap... }` closing brace, including the `loopPts`/`bestFitPlane`/surface-centroid lines and the `// single best-fit plane ...` comment — with:

```javascript
      // orient each cap COMPONENT exactly against the surface's boundary
      // winding (replaces the global best-fit-plane heuristic, which inverted
      // caps on multi-loop parts whose rims face opposite directions)
      const surfDir = new Map();
      for (const e of bEdge.values()) if (e.count === 1) surfDir.set(ekeyG(e.u, e.v), e.u + ">" + e.v);
      orientCapComponents(cap, surfDir);
```
(`bEdge` and `ekeyG` are already in scope in `solidFromSubs`. The surface-centroid accumulation lines `let sx = 0 ...` exist only for the old heuristic — delete them with it.)

- [ ] **Step 5: Run** — `node --test`
Expected: **53 pass / 0 fail** — the new test green for all five methods, and every existing test (watertight counts, caps, liepa winding) still green.

- [ ] **Step 6: Commit**
```bash
git add js/split.js tests/harness.js tests/split.test.js
git commit -m "fix(split): exact per-component cap orientation from surface boundary winding"
```

---

### Task 2: Nesting-aware Liepa dispatch (F2)

**Files:**
- Modify: `js/caps.js` (`triangulateLoops` restructure)
- Test: `tests/caps.test.js`

- [ ] **Step 1: Write the failing test** — append to `tests/caps.test.js`:

```javascript
test("liepa respects coplanar island holes via the nesting classifier", () => {
  const { Caps } = loadModules();
  const coords = {
    0: [0, 0, 0], 1: [6, 0, 0], 2: [6, 6, 0], 3: [0, 6, 0],   // outer 6x6
    4: [2, 2, 0], 5: [2, 4, 0], 6: [4, 4, 0], 7: [4, 2, 0],   // 2x2 island
  };
  const cap = Caps.triangulateLoops([[0, 1, 2, 3], [4, 5, 6, 7]], (v) => coords[v], "liepa");
  const pt = (r) => (r < cap.verts.length ? coords[cap.verts[r]] : cap.extraPts[r - cap.verts.length]);
  let area = 0;
  for (const t of cap.tris) {
    const a = pt(t[0]), b = pt(t[1]), c = pt(t[2]);
    const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - a[0], vy = c[1] - a[1];
    area += Math.abs(ux * vy - uy * vx) / 2;
  }
  assert.ok(Math.abs(area - 32) < 1e-6, "outer minus island (32), got " + area.toFixed(2));
  assert.equal(capBoundaryEdges(cap.tris).size, 8, "both rims covered exactly once");
});
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/caps.test.js`
Expected: FAIL — per-loop Liepa lays a disc over the island: area 40, not 32.

- [ ] **Step 3: Restructure `triangulateLoops` in `js/caps.js`.** Currently, after the `"projected"` branch's return, the code has: the `"liepa"` per-loop branch (with try/catch + extras rollback), then the earcut/cdt section (per-loop `L` records with own planes, `inPoly`, `COPLANAR_FRAC`, `order`, `groups`, lib guards, `emitEarcut`, the `for (const grp of groups)` emission with the CDT path and centroid fallback). REPLACE everything from `if (method === "liepa") {` through the end of the `for (const grp of groups) { ... }` loop (keep the final `return { verts, extraPts, tris };` that follows) with the restructured version below — the classifier now runs for all three methods, and liepa consumes groups:

```javascript
    // --- liepa / earcut / cdt: per-loop planes; classify outer+holes in the
    // outer's own frame, then emit per group ---
    const useCDT = method === "cdt";
    const isLiepa = method === "liepa";
    if (!useCDT && !isLiepa && method !== "earcut") throw new Error("Unknown cap method: " + method);
    const P2T = global.poly2tri;
    const SU = global.THREE && global.THREE.ShapeUtils;
    if (useCDT && !(P2T && P2T.SweepContext)) throw new Error("poly2tri not loaded (CDT)");
    if (!(SU && SU.triangulateShape)) throw new Error("THREE.ShapeUtils not loaded (Earcut)");
    if (isLiepa && !(global.Liepa && global.Liepa.fillLoop)) throw new Error("Liepa module not loaded");

    // each loop -> its own best-fit plane (a concatenated-loops plane is unsound:
    // opposite-winding rims cancel Newell's normal), own-plane CCW projection, area,
    // and 3-D centroid (for classification in another loop's frame)
    const L = loops.map((loop) => {
      let pts3 = loop.map(getPt);
      const lpl = bestFitPlane(pts3);
      let poly2 = pts3.map((p) => project(lpl, p));
      let vids = loop.slice();
      // Own-frame projections are CCW by construction (Newell orients the loop
      // CCW around its own normal); this branch is a numerical safety net for
      // near-degenerate loops. pts3/poly2/vids must stay index-aligned.
      if (signedArea2(poly2) < 0) { pts3 = pts3.slice().reverse(); poly2 = poly2.slice().reverse(); vids = vids.slice().reverse(); }
      const c3 = [0, 0, 0];
      for (const p of pts3) { c3[0] += p[0]; c3[1] += p[1]; c3[2] += p[2]; }
      c3[0] /= pts3.length; c3[1] /= pts3.length; c3[2] /= pts3.length;
      return { vids, pts3, pl: lpl, poly2, area: Math.abs(signedArea2(poly2)), c3 };
    });
    const inPoly = (pt, poly) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a[1] > pt[1]) !== (b[1] > pt[1]) &&
            pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1] || 1e-12) + a[0]) inside = !inside;
      }
      return inside;
    };
    // A loop only counts as a hole of an outer if it is near-coplanar with it;
    // loops far apart along the plane normal (a band's two end-rings, which
    // project on top of each other) are capped independently instead.
    const COPLANAR_FRAC = 0.25;
    const order = L.map((_, i) => i).sort((a, b) => L[b].area - L[a].area);
    const used = new Set();
    const groups = []; // { outer: index, holes: index[] }
    for (const oi of order) {
      if (used.has(oi)) continue;
      used.add(oi);
      const holes = [];
      for (const hi of order) {
        if (used.has(hi)) continue;
        const O = L[oi], H = L[hi];
        const offN = Math.abs((H.c3[0] - O.pl.ox) * O.pl.nx + (H.c3[1] - O.pl.oy) * O.pl.ny + (H.c3[2] - O.pl.oz) * O.pl.nz);
        if (inPoly(project(O.pl, H.c3), O.poly2) && offN <= COPLANAR_FRAC * Math.sqrt(O.area)) {
          holes.push(hi); used.add(hi);
        }
      }
      groups.push({ outer: oi, holes });
    }

    // Emit ear-clipped triangles for one outer+holes group (earcut, the CDT
    // fallback, AND liepa's hole-bearing groups). THREE.ShapeUtils returns
    // index triples into the concatenated [contour, ...holes] point list.
    const emitEarcut = (outer, holes) => {
      const V2 = (p) => (global.THREE.Vector2 ? new global.THREE.Vector2(p[0], p[1]) : { x: p[0], y: p[1] });
      const contour = outer.poly2.map(V2);
      const holeContours = holes.map((h) => h.poly2.map(V2));
      const flatVids = outer.vids.concat(...holes.map((h) => h.vids));
      for (const [a, b, c] of SU.triangulateShape(contour, holeContours)) {
        tris.push([idxOf(flatVids[a]), idxOf(flatVids[b]), idxOf(flatVids[c])]);
      }
    };

    for (const grp of groups) {
      const outer = L[grp.outer];
      // holes re-projected into the OUTER's plane (their own poly2 is in their own frame);
      // earcut/poly2tri normalize hole winding internally, so vid order stays as-is
      const holes = grp.holes.map((i) => ({ vids: L[i].vids, poly2: L[i].pts3.map((p) => project(outer.pl, p)) }));
      const before = tris.length;
      const extraBefore = extraPts.length;

      if (isLiepa && holes.length === 0) {
        // hole-less loop -> full Liepa pipeline; centroid fan on any failure
        const loop = outer.vids;
        if (loop.length < 3) continue;
        try {
          const fill = global.Liepa.fillLoop(loop, (v) => getPt(v));
          const base = verts.length + extraPts.length;
          for (const ep of fill.extraPts) extraPts.push(ep);
          for (const t of fill.tris) {
            tris.push(t.map((r) => (r < loop.length ? idxOf(loop[r]) : base + (r - loop.length))));
          }
        } catch (e) {
          console.warn("liepa fill failed for a loop; centroid fallback:", e && e.message);
          while (tris.length > before) tris.pop();
          while (extraPts.length > extraBefore) extraPts.pop();
          emitCentroidFan(loop);
        }
        continue;
      }

      if (!useCDT) {
        // earcut — also liepa's hole-bearing groups (nesting-aware fill)
        emitEarcut(outer, holes);
      } else {
        // CDT path: poly2tri throws on duplicate/coincident points -> dedupe per loop.
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
        const outerPts = mkPts(outer);
        if (outerPts.length >= 3) {
          try {
            const ctx = new P2T.SweepContext(outerPts);
            for (const h of holes) { const hp = mkPts({ poly2: h.poly2.map((p) => ({ 0: p[0], 1: p[1] }))[0] ? h.poly2 : h.poly2, vids: h.vids, ...h }); if (hp.length >= 3) ctx.addHole(hp); }
            ctx.triangulate();
            for (const t of ctx.getTriangles()) {
              tris.push([idxOf(t.getPoint(0)._vid), idxOf(t.getPoint(1)._vid), idxOf(t.getPoint(2)._vid)]);
            }
          } catch (e) {
            emitEarcut(outer, holes); // collinear / boundary-touching -> robust earcut
          }
        } else {
          emitEarcut(outer, holes); // degenerate after dedupe -> try earcut
        }
      }
      // Guarantee a watertight cap: if nothing was emitted for this group
      // (fully degenerate/collinear loop), fall back to a centroid fan.
      if (tris.length === before) emitCentroidFan(outer.vids);
    }
```
**Splice with care:** the existing CDT `mkPts` body must be carried over EXACTLY as it currently exists (the line above marked with the odd ternary is a transcription artifact — use the CURRENT file's `mkPts` call sites verbatim: `const hp = mkPts(h); if (hp.length >= 3) ctx.addHole(hp);`). The `emitCentroidFan` helper must remain defined ABOVE this section (it already is, beside the centroid branch). The old standalone liepa branch and the old classifier/emission section are both fully consumed by this replacement; nothing between `projected`'s return and the final `return { verts, extraPts, tris };` should remain except this block.

- [ ] **Step 4: Run** — `node --test`
Expected: **54 pass / 0 fail** — the new island test green; ALL existing caps/liepa/split tests still green (stacked-loops independence, square+hole earcut/cdt, degenerate fallbacks, tube directed-watertight, fractal budget + winding).

- [ ] **Step 5: Commit**
```bash
git add js/caps.js tests/caps.test.js
git commit -m "fix(caps): liepa goes through the nesting classifier (no island overlays)"
```

---

### Task 3: Clear-the-model explode floor (F3)

**Files:**
- Modify: `js/viewer.js` (`setSplitParts` target computation)

- [ ] **Step 1:** In `setSplitParts`, replace:

```javascript
      // proportional exploded view: every pair of parts separates by ×(1+K),
      // so adjacent parts get a real gap instead of staying glued together
      const target = new THREE.Vector3().subVectors(pc, c).multiplyScalar(EXPLODE_K);
      if (target.lengthSq() < 1e-9) target.set(0, 0, r * 0.15); // part centered at the model center (rare): nudge along +Z
```
with:

```javascript
      // proportional exploded view (pairs separate by ×(1+K)), floored so the
      // part's bounding sphere CLEARS the model's bounding sphere along its
      // ray — near-axis parts (neck rings) pop past the head, not into it
      const off = new THREE.Vector3().subVectors(pc, c);
      const d = off.length();
      if (d < 1e-6) off.set(0, 0, 1); else off.divideScalar(d);
      const partR = gg.boundingSphere.radius || 1;
      const dist = Math.max(EXPLODE_K * d, r + 1.05 * partR + 0.05 * r - d);
      const target = off.multiplyScalar(dist);
```
(`gg`, `pc`, `c`, `r`, `EXPLODE_K` are all in scope.)

- [ ] **Step 2: Run** — `node --check js/viewer.js && node --test` → silent; **54 pass / 0 fail**.

- [ ] **Step 3: Browser-verify (controller):** split a neck ring on the reference model — it travels clear past the head (no interpenetration with the remainder); the ear tip keeps roughly its previous distance.

- [ ] **Step 4: Commit**
```bash
git add js/viewer.js
git commit -m "fix(viewer): explode floors at model-clearance so near-axis parts never clip the remainder"
```

---

## Self-Review

**Spec coverage:** F1 → T1 (helper + replacement + directed/volume test, all five methods). F2 → T2 (classifier shared; liepa hole-less → fillLoop, hole-bearing → emitEarcut; island test). F3 → T3. Controller re-runs the evidence script + browser pass per the spec. Covered.

**Placeholder scan:** complete code everywhere; the one transcription-risk line in T2 is explicitly flagged with the verbatim instruction (use the current `mkPts(h)` call).

**Type consistency:** `orientCapComponents(cap, surfDir)` consumes `cap.verts`/`cap.tris` (existing descriptor) and `surfDir` keyed by `ekeyG` (same `u_v` sorted-key format in builder and consumer). `directedViolations`/`signedVolume` signatures match their test uses. T2's group records reuse the existing `L`/`groups`/`emitEarcut`/`emitCentroidFan` names and shapes; `isLiepa` guard added to the unknown-method throw. T3 uses only in-scope viewer vars.
