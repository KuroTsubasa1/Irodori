# Split Correctness (Batch E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the four confirmed split bugs — stacked end-loops misclassified as holes (annulus/dropped caps), grey live hole-fills, constant-distance explode clipping, and the claimed-region flood hazard.

**Architecture:** A coplanarity gate in `caps.js`'s loop classifier (root-cause fix, TDD), an exported `majorityBorderColor` reused by the viewer's fill meshes, proportional explode targets in `viewer.js`, and an exclude-set parameter on `selectColorRegion` wired through `app.js`.

**Tech Stack:** Vanilla JS (IIFE + globals), three.js, Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-06-10-split-correctness-design.md`

**Conventions:** Run all tests with `node --test` from the repo root. Suite is **30 passing** before this batch and grows to **33** (Tasks 1–3 add one test each). After each task: `node --check` on changed js files. Stage only the files named per commit; never the untracked `.3mf` files. Line numbers are approximate — match on code.

---

### Task 1: Coplanarity-gated hole classification

**Files:**
- Modify: `js/caps.js` (the `L = loops.map(...)` block and the hole-collection loop inside `triangulateLoops`'s earcut/cdt section)
- Test: `tests/caps.test.js`

- [ ] **Step 1: Write the failing test** — append to `tests/caps.test.js`:

```javascript
test("stacked end-loops are capped independently (not as outer+hole)", () => {
  const { Caps } = loadModules();
  const coords = {
    0: [0, 0, 0], 1: [4, 0, 0], 2: [4, 4, 0], 3: [0, 4, 0],   // bottom rim (z=0)
    4: [0, 0, 5], 5: [4, 0, 5], 6: [4, 4, 5], 7: [0, 4, 5],   // top rim (z=5)
  };
  for (const method of ["earcut", "cdt"]) {
    const cap = Caps.triangulateLoops([[0, 1, 2, 3], [4, 5, 6, 7]], (v) => coords[v], method);
    assert.equal(cap.extraPts.length, 0, method + ": no fallback fan");
    assert.equal(cap.tris.length, 4, method + ": two 2-tri caps");
    for (const t of cap.tris) {
      const sides = new Set(t.map((r) => (cap.verts[r] <= 3 ? "A" : "B")));
      assert.equal(sides.size, 1, method + ": no cross-loop triangles");
    }
    assert.equal(capBoundaryEdges(cap.tris).size, 8, method + ": both rims capped exactly once");
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/caps.test.js`
Expected: FAIL — current behavior classifies the second loop as a hole; earcut degenerates and the centroid fallback fans only the outer (4 tris but **1 extraPt**, boundary 4 not 8).

- [ ] **Step 3: Implement.** In `js/caps.js` `triangulateLoops`, the earcut/cdt section currently builds per-loop records roughly as:

```javascript
    const L = loops.map((loop) => {
      let poly2 = loop.map((v) => project(pl, getPt(v)));
      let vids = loop.slice();
      if (signedArea2(poly2) < 0) { poly2 = poly2.slice().reverse(); vids = vids.slice().reverse(); }
      let cx = 0, cy = 0;
      for (const p of poly2) { cx += p[0]; cy += p[1]; }
      return { vids, poly2, area: Math.abs(signedArea2(poly2)), centroid2: [cx / poly2.length, cy / poly2.length] };
    });
```

Replace it with a version that also records `d`, the loop's mean offset along the shared plane normal:

```javascript
    const L = loops.map((loop) => {
      const pts3 = loop.map(getPt);
      let poly2 = pts3.map((p) => project(pl, p));
      let vids = loop.slice();
      if (signedArea2(poly2) < 0) { poly2 = poly2.slice().reverse(); vids = vids.slice().reverse(); }
      let cx = 0, cy = 0;
      for (const p of poly2) { cx += p[0]; cy += p[1]; }
      // mean offset along the plane normal — used to reject far-apart loops
      // (stacked tube end-rings) from being grouped as outer + hole.
      let d = 0;
      for (const p of pts3) d += (p[0] - pl.ox) * pl.nx + (p[1] - pl.oy) * pl.ny + (p[2] - pl.oz) * pl.nz;
      d /= pts3.length;
      return { vids, poly2, area: Math.abs(signedArea2(poly2)), centroid2: [cx / poly2.length, cy / poly2.length], d };
    });
```

Then in the grouping loop, the hole condition (currently `if (inPoly(L[hi].centroid2, L[oi].poly2)) { holes.push(hi); used.add(hi); }`) becomes coplanarity-gated. Add the constant just above the `order` sort:

```javascript
    // A loop only counts as a hole of an outer if it is near-coplanar with it;
    // loops far apart along the plane normal (a band's two end-rings, which
    // project on top of each other) are capped independently instead.
    const COPLANAR_FRAC = 0.25;
```

and change the condition to:

```javascript
        if (inPoly(L[hi].centroid2, L[oi].poly2) &&
            Math.abs(L[hi].d - L[oi].d) <= COPLANAR_FRAC * Math.sqrt(L[oi].area)) {
          holes.push(hi); used.add(hi);
        }
```

- [ ] **Step 4: Run to verify pass + regressions**

Run: `node --test`
Expected: **31 pass / 0 fail** — the new test passes and the coplanar square+hole tests (offset 0) still pass.

- [ ] **Step 5: Commit**

```bash
git add js/caps.js tests/caps.test.js
git commit -m "fix(caps): gate hole classification on coplanarity (stacked rings cap independently)"
```

---

### Task 2: Open-tube integration regression (`solidFromSubs`)

**Files:**
- Modify: `tests/harness.js` (add `makeOpenTube`, export it)
- Test: `tests/split.test.js`

- [ ] **Step 1: Add the fixture to `tests/harness.js`** (and add `makeOpenTube` to `module.exports`):

```javascript
// An open square tube (cuboid sides, no top/bottom): 8 verts, 8 triangles,
// two square rims (z=0 and z=2). All faces solid state 1. Its open boundary
// is exactly the two rims — the minimal "band region" shape.
function makeOpenTube() {
  return {
    nf: 8,
    positions: new Float32Array([
      0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0,   // bottom rim 0..3
      0, 0, 2, 2, 0, 2, 2, 2, 2, 0, 2, 2,   // top rim 4..7
    ]),
    v1: Int32Array.from([0, 0, 1, 1, 2, 2, 3, 3]),
    v2: Int32Array.from([1, 5, 2, 6, 3, 7, 0, 4]),
    v3: Int32Array.from([5, 4, 6, 5, 7, 6, 4, 7]),
    paints: ["4", "4", "4", "4", "4", "4", "4", "4"],
  };
}
```

- [ ] **Step 2: Write the test** — append to `tests/split.test.js` (add `makeOpenTube` to its harness destructure):

```javascript
test("solidFromSubs caps an open tube with two independent end caps", () => {
  const { Cleanup, Split } = loadModules();
  const tube = makeOpenTube();
  const g = Cleanup.buildSubGraph(tube);
  const solid = Split.solidFromSubs(tube, [...Array(g.NS).keys()], "earcut");
  // watertight: an annulus would also be watertight but with 8 cap tris;
  // the old drop-one-loop failure is 4 tris + 1 extraPt and NOT watertight.
  for (const [, n] of edgeUseCounts(solid.indices)) assert.equal(n, 2, "watertight");
  assert.equal(solid.cap.tris.length, 4, "two 2-tri end caps");
  assert.equal(solid.cap.extraPts.length, 0, "no fallback fan");
});
```

- [ ] **Step 3: Run** — `node --test`
Expected: **32 pass / 0 fail**.

> **Outcome note (what actually shipped):** this test exposed a second root
> cause — the shared plane was Newell over the *concatenation* of all loops,
> which cancels for a tube's opposite-winding rims (degenerate plane → both
> rims fell to centroid fans). Task 2's commit therefore reworked the
> classifier to **per-loop planes**: classification happens in the candidate
> outer's own frame (centroid projected into it + normal-offset gate), and
> each group is emitted projected onto its outer's plane. See the updated
> spec §1; commit `6b9f6bb`.

- [ ] **Step 4: Commit**

```bash
git add tests/harness.js tests/split.test.js
git commit -m "test(split): open-tube fixture — band regions get two independent end caps"
```

---

### Task 3: Claimed-exclusion flood

**Files:**
- Modify: `js/cleanup.js` (`selectColorRegion`)
- Modify: `js/app.js` (`doSplit` + the split branch of `onHover`)
- Test: `tests/region.test.js`

- [ ] **Step 1: Write the failing test** — append to `tests/region.test.js`:

```javascript
test("selectColorRegion honors an exclude set", () => {
  const { Cleanup } = loadModules();
  const mesh = makeTetra();
  const g = Cleanup.buildSubGraph(mesh);
  const s1 = [...Array(g.NS).keys()].filter((i) => g.subLeaf[i].state === 1);
  const r = Cleanup.selectColorRegion(mesh, s1[0], new Set([s1[1]]));
  assert.equal(r.length, 2, "excluded sub is not flooded");
  assert.ok(![...r].includes(s1[1]));
});
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/region.test.js`
Expected: FAIL — `r.length` is 3 (the exclude argument is ignored).

- [ ] **Step 3: Implement.** In `js/cleanup.js`, change `selectColorRegion(mesh, seedSub)` to `selectColorRegion(mesh, seedSub, exclude)`:
- after the existing `if (seedSub < 0 || seedSub >= NS) return new Int32Array(0);` add
  `if (exclude && exclude.has(seedSub)) return new Int32Array(0);`
- in the flood condition `if (!seen[v] && subLeaf[v].state === st)` add `&& !(exclude && exclude.has(v))`.

- [ ] **Step 4: Wire it in `js/app.js`.** Both split-tool floods pass the mesh's claimed set:
- in `doSplit(hit)`: `const subs = Cleanup.selectColorRegion(m, hit.localSub, claimedByMesh()[hit.meshIndex]);`
- in `onHover(hit)`'s split branch: `const subs = Cleanup.selectColorRegion(m, hit.localSub, claimedByMesh()[hit.meshIndex]);`
(`claimedByMesh()` already exists near the top of app.js and returns one `Set` per mesh.)

- [ ] **Step 5: Run** — `node --check js/cleanup.js && node --check js/app.js && node --test`
Expected: no syntax output; **33 pass / 0 fail**.

- [ ] **Step 6: Commit**

```bash
git add js/cleanup.js js/app.js tests/region.test.js
git commit -m "fix(split): flood never re-claims already-split subs (exclude set)"
```

---

### Task 4: Surrounding-color live fills + proportional explode

**Files:**
- Modify: `js/split.js` (export `majorityBorderColor`)
- Modify: `js/viewer.js` (`capMeshFor` color; `setSplitParts` explode target; `EXPLODE_K`)

- [ ] **Step 1: Export the border color.** In `js/split.js`, change the export line to include it:

```javascript
  global.Split = { solidFromSubs, remainderSolid, majorityBorderColor, buildSplitXML, uuid };
```

- [ ] **Step 2: Color the live fill.** In `js/viewer.js` `capMeshFor(part, solid)`, `g` (the sub-graph) is already computed. Replace the material line

```javascript
    const mat = new THREE.MeshStandardMaterial({ color: CAP_FILL.clone(), roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide });
```

with

```javascript
    // fill the hole with the surrounding (majority bordering) color, matching the export
    const fillCol = linColor(Split.majorityBorderColor(doc.meshes[part.meshIndex], g, part));
    const mat = new THREE.MeshStandardMaterial({ color: fillCol.clone(), roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide });
```

and delete the now-unused `const CAP_FILL = ...` line.

- [ ] **Step 3: Proportional explode.** In `js/viewer.js`, change `const EXPLODE_K = 0.45;` to `const EXPLODE_K = 0.8;`. In `setSplitParts`, replace

```javascript
      const dir = new THREE.Vector3().subVectors(pc, c);
      if (dir.lengthSq() < 1e-9) dir.set(0, 0, 1);
      dir.normalize();
      const target = dir.multiplyScalar(r * EXPLODE_K);
```

with

```javascript
      // proportional exploded view: every pair of parts separates by ×(1+K),
      // so adjacent parts get a real gap instead of staying glued together
      const target = new THREE.Vector3().subVectors(pc, c).multiplyScalar(EXPLODE_K);
      if (target.lengthSq() < 1e-9) target.set(0, 0, r * 0.15);
```

(`r` stays in scope for the degenerate fallback; the position carry-over by part `id` is untouched.)

- [ ] **Step 4: Run** — `node --check js/split.js && node --check js/viewer.js && node --test`
Expected: no syntax output; **33 pass / 0 fail**.

- [ ] **Step 5: Browser-verify (controller does this)** — on the user's `_fixed.3mf`: split the black ear tip, the yellow band under it, and the black stripe below that. Each part lifts out with both ends capped; remainder fills take the surrounding color (not grey); no floating grey membrane; the three parts separate cleanly. Undo ×3 restores.

- [ ] **Step 6: Commit**

```bash
git add js/split.js js/viewer.js
git commit -m "fix(split): live fills use surrounding color; proportional explode (K=0.8)"
```

---

## Self-Review

**Spec coverage:** §1 classifier → Task 1 (+ Task 2 integration pin). §2 fill color → Task 4. §3 explode → Task 4. §4 exclude flood (doSplit + hover) → Task 3. All covered.

**Placeholder scan:** none; every step carries exact code and expected test counts (30→31→32→33).

**Type consistency:** `L[*].d` produced and consumed only inside `triangulateLoops`; `COPLANAR_FRAC` defined before use; `selectColorRegion(mesh, seed, exclude)` matches both app.js call sites; `Split.majorityBorderColor(mesh, g, part)` matches its existing definition (reads `part.subs`/`part.state`, both present on viewer parts); `EXPLODE_K`/`r`/`pc`/`c` all in scope in `setSplitParts`.
