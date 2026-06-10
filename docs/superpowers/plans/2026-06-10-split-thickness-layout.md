# Split Thickness + Row Layout (Batch L) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Split parts become minimum-thickness plugs (Thickness slider, default 1.2 mm) and arrange in a row beside the model instead of exploding radially.

**Architecture:** `solidFromSubs` gains a `thickness` param: the cap is triangulated on an inward-offset rim (offset `getPt` into the untouched `Caps.triangulateLoops`), then a `thickenCap` rewrite keeps rim vids welded, turns offset copies + interior points into extras, and adds a wall of quads opposing the surface boundary — directed-watertight by construction, descriptor-compatible with every consumer. A pure `Split.layoutParts` computes row slots consumed by `viewer.js setSplitParts`.

**Tech Stack:** Vanilla JS, Node test runner, three.js (viewer only).

**Spec:** `docs/superpowers/specs/2026-06-10-split-thickness-layout-design.md`

**Conventions:** suite **61** → **62** (T1) → **64** (T2) → **64** (T3). `node --check` touched files; stage only named files; never touch `.3mf`s.

---

### Task 1: `Split.layoutParts` (pure row layout)

**Files:**
- Modify: `js/split.js` (new function + export)
- Test: `tests/split.test.js`

- [ ] **Step 1: Write the failing test** — append to `tests/split.test.js`:

```javascript
test("layoutParts lines parts up beside the body, bottoms aligned", () => {
  const { Split } = loadModules();
  const box = (x0, y0, z0, x1, y1, z1) => ({ min: [x0, y0, z0], max: [x1, y1, z1] });
  const body = box(0, 0, 0, 10, 8, 6);
  const parts = [box(2, 2, 1, 5, 6, 4), box(0, 0, 0, 2, 2, 2)];
  const offs = Split.layoutParts(body, parts, 1);
  assert.equal(offs.length, 2);
  let cursor = 11; // body max-x + margin
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i], o = offs[i];
    const minX = p.min[0] + o[0], maxX = p.max[0] + o[0];
    assert.ok(Math.abs(minX - cursor) < 1e-9, "part " + i + " starts at the cursor");
    // y centers aligned
    const pcy = (p.min[1] + p.max[1]) / 2 + o[1];
    assert.ok(Math.abs(pcy - 4) < 1e-9, "part " + i + " y-centered on the body");
    // bottoms aligned to the body base plane
    assert.ok(Math.abs(p.min[2] + o[2] - 0) < 1e-9, "part " + i + " rests on the body base");
    cursor = maxX + 1;
  }
});
```

- [ ] **Step 2: Run** — `node --test tests/split.test.js` → FAIL (`layoutParts is not a function`).

- [ ] **Step 3: Implement** — add to `js/split.js` (before `uuid`), and add `layoutParts` to the `global.Split = {...}` export:

```javascript
  // Row layout for split parts: slots along +X beside the body, y-centered on
  // it, bottoms aligned to its base plane. Boxes: { min:[x,y,z], max:[x,y,z] }.
  // Returns one [dx, dy, dz] offset per part box.
  function layoutParts(bodyBox, partBoxes, margin) {
    margin = margin || 0;
    const bcy = (bodyBox.min[1] + bodyBox.max[1]) / 2;
    let cursor = bodyBox.max[0] + margin;
    return partBoxes.map((p) => {
      const dx = cursor - p.min[0];
      const dy = bcy - (p.min[1] + p.max[1]) / 2;
      const dz = bodyBox.min[2] - p.min[2];
      cursor += (p.max[0] - p.min[0]) + margin;
      return [dx, dy, dz];
    });
  }
```

- [ ] **Step 4: Run** — `node --test` → **62 pass / 0 fail**.

- [ ] **Step 5: Commit**
```bash
git add js/split.js tests/split.test.js
git commit -m "feat(split): layoutParts — row slots beside the body"
```

---

### Task 2: Minimum-thickness plugs in `solidFromSubs`

**Files:**
- Modify: `js/split.js`
- Test: `tests/split.test.js`

- [ ] **Step 1: Write the failing tests** — append to `tests/split.test.js` (the harness already exports `makeClosedCube`, `makeOpenTube`, `directedViolations`, `signedVolume`; reuse the file's existing helpers for index extraction if present, else inline `asIdx` as below):

```javascript
function asIdx(s) { return s.indices instanceof Uint32Array ? s.indices : Uint32Array.from(s.indices); }

test("solidFromSubs thickness: exact plug + pocket volumes on the cube top", () => {
  const { Split, Cleanup } = loadModules();
  const cube = makeClosedCube();
  Cleanup.buildSubGraph(cube);
  const subs = [2, 3]; // the two top faces (z = 2)
  const t = 0.5;
  const part = Split.solidFromSubs(cube, subs, "earcut", t);
  assert.equal(directedViolations(asIdx(part)), 0, "plug directed-watertight");
  const vol = signedVolume(asIdx(part), part.positions);
  assert.ok(Math.abs(vol - 2) < 1e-9, "plug volume 2x2x0.5 = 2, got " + vol);
  // every offset point sits exactly t beneath its rim vertex (straight down)
  const cap = part.cap;
  const nR = cap.verts.length;
  assert.equal(nR, 4, "four rim vids");
  const g = Cleanup.buildSubGraph(cube);
  for (let i = 0; i < nR; i++) {
    const gid = cap.verts[i], off = cap.extraPts[i];
    const d = Math.hypot(off[0] - g.vx[gid], off[1] - g.vy[gid], off[2] - g.vz[gid]);
    assert.ok(Math.abs(d - t) < 1e-9, "offset distance = t");
    assert.ok(Math.abs(off[2] - (2 - t)) < 1e-9, "offset moved straight down");
  }
  // wall = 2 triangles per rim edge; cap interior = whatever earcut made (2 here)
  const wallTris = cap.tris.filter((tri) => tri.some((r) => r < nR));
  assert.equal(wallTris.length, 8, "4 rim edges x 2 wall triangles");
  // remainder reuses the plug surface reversed -> pocket; volumes sum to the cube
  const rem = Split.remainderSolid(cube, [{ subs, cap, state: part.state }], new Set(subs));
  assert.equal(directedViolations(asIdx(rem)), 0, "pocketed remainder directed-watertight");
  const rvol = signedVolume(asIdx(rem), rem.positions);
  assert.ok(Math.abs(rvol - 6) < 1e-9, "remainder volume 8-2 = 6, got " + rvol);
  // t = 0 (and omitted) is byte-for-byte the legacy path
  const legacy = Split.solidFromSubs(cube, subs, "earcut");
  const zero = Split.solidFromSubs(cube, subs, "earcut", 0);
  assert.equal(zero.indices.length, legacy.indices.length, "t=0 keeps the legacy triangle count");
  assert.equal(zero.cap.extraPts.length, legacy.cap.extraPts.length, "t=0 keeps the legacy cap shape");
});

test("solidFromSubs thickness: tube skirts stay directed-watertight (liepa + earcut)", () => {
  const { Split, Cleanup } = loadModules();
  for (const method of ["liepa", "earcut"]) {
    const tube = makeOpenTube();
    const g = Cleanup.buildSubGraph(tube);
    const all = Array.from({ length: g.NS }, (_, i) => i);
    const t = 0.4;
    const part = Split.solidFromSubs(tube, all, method, t);
    assert.equal(directedViolations(asIdx(part)), 0, method + " skirted tube directed-watertight");
    const vol = signedVolume(asIdx(part), part.positions);
    assert.ok(Math.abs(vol - 8) < 1.0, method + " volume near the tube's 8, got " + vol.toFixed(3));
    const nR = part.cap.verts.length;
    for (let i = 0; i < nR; i++) {
      const gid = part.cap.verts[i], off = part.cap.extraPts[i];
      const d = Math.hypot(off[0] - g.vx[gid], off[1] - g.vy[gid], off[2] - g.vz[gid]);
      assert.ok(Math.abs(d - t) < 1e-6, method + " offset distance = t");
    }
  }
});
```

NOTE: if `makeClosedCube` sub indices don't land as `subs = [2, 3]` for the top faces (sub enumeration is per-face for solid paints, so face index == sub index — it should), STOP and report rather than fishing for indices.

- [ ] **Step 2: Run** — both FAIL (no 4th parameter; offsets/walls missing).

- [ ] **Step 3: Implement in `js/split.js`.**

3a. Signature (line 9): `function solidFromSubs(mesh, subs, method, thickness) {` and after `method = method || "centroid";` add `thickness = +thickness || 0;`

3b. After the surface-emission loop ends (right after `const out = F.slice(), outSt = triSt.slice();`), add the normal accumulator:

```javascript
    // per-local-vertex area-weighted patch normals (inward offset directions)
    let acc = null;
    if (thickness > 0) {
      acc = new Float64Array(px.length * 3);
      for (let i = 0; i < F.length; i += 3) {
        const a = F[i], b = F[i + 1], c = F[i + 2];
        const ux = px[b] - px[a], uy = py[b] - py[a], uz = pz[b] - pz[a];
        const wx = px[c] - px[a], wy = py[c] - py[a], wz = pz[c] - pz[a];
        const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        acc[a * 3] += nx; acc[a * 3 + 1] += ny; acc[a * 3 + 2] += nz;
        acc[b * 3] += nx; acc[b * 3 + 1] += ny; acc[b * 3 + 2] += nz;
        acc[c * 3] += nx; acc[c * 3 + 1] += ny; acc[c * 3 + 2] += nz;
      }
    }
```

3c. Replace the cap block's lead-in. Current code:

```javascript
      const loops = Caps.extractLoops(boundary);
      const getPt = (gid) => [vx[gid], vy[gid], vz[gid]];
      cap = Caps.triangulateLoops(loops, getPt, method);
      cap.method = method;
      // orient each cap COMPONENT exactly against the surface's boundary
      // winding (replaces the global best-fit-plane heuristic, which inverted
      // caps on multi-loop parts whose rims face opposite directions)
      const surfDir = new Map();
      for (const e of bEdge.values()) if (e.count === 1) surfDir.set(ekeyG(e.u, e.v), e.u + ">" + e.v);
      orientCapComponents(cap, surfDir);
```

New code (surfDir moves up; offset map; thicken):

```javascript
      const loops = Caps.extractLoops(boundary);
      const surfDir = new Map();
      for (const e of bEdge.values()) if (e.count === 1) surfDir.set(ekeyG(e.u, e.v), e.u + ">" + e.v);
      // thickness > 0: triangulate the cap on an INWARD-OFFSET copy of the rim
      // (each rim vertex pushed t along its negated smooth patch normal), so
      // the part becomes a printable plug instead of a knife-edged lens
      let offsetOf = null;
      if (thickness > 0) {
        offsetOf = new Map();
        for (const loop of loops) for (const gid of loop) {
          if (offsetOf.has(gid)) continue;
          const li = remap.get(gid);
          let nx = 0, ny = 0, nz = 0;
          if (li !== undefined) { nx = acc[li * 3]; ny = acc[li * 3 + 1]; nz = acc[li * 3 + 2]; }
          const L = Math.hypot(nx, ny, nz) || 1;
          offsetOf.set(gid, [vx[gid] - (nx / L) * thickness, vy[gid] - (ny / L) * thickness, vz[gid] - (nz / L) * thickness]);
        }
      }
      const getPt = offsetOf ? (gid) => offsetOf.get(gid) : (gid) => [vx[gid], vy[gid], vz[gid]];
      cap = Caps.triangulateLoops(loops, getPt, method);
      cap.method = method;
      // orient each cap COMPONENT exactly against the surface's boundary
      // winding; valid on the offset rim too (the offset is a continuous
      // deformation — winding semantics are unchanged)
      orientCapComponents(cap, surfDir);
      if (offsetOf) cap = thickenCap(cap, offsetOf, surfDir);
```

3d. Add `thickenCap` as a module function (after `orientCapComponents`):

```javascript
  // Wrap an oriented cap (triangulated on OFFSET rim coordinates but indexed
  // by rim vids) into a minimum-thickness plug surface: rim vids stay welded
  // (refs < nR — the wall attaches to the real surface there), the offset rim
  // copies + the cap's interior points become extras, every cap ref shifts by
  // nR, and a wall of quads joins rim -> offset rim. Wall winding opposes the
  // surface's directed boundary (surfDir), the shared diagonal and vertical
  // edges pair up across quads, and the offset-loop edges oppose the oriented
  // cap — directed-watertight by construction.
  function thickenCap(cap0, offsetOf, surfDir) {
    const nR = cap0.verts.length;
    const cap = { verts: cap0.verts.slice(), extraPts: [], tris: [], method: cap0.method };
    for (const vid of cap0.verts) cap.extraPts.push(offsetOf.get(vid));
    for (const ep of cap0.extraPts) cap.extraPts.push(ep);
    for (const t of cap0.tris) cap.tris.push([t[0] + nR, t[1] + nR, t[2] + nR]);
    const idxIn = new Map();
    cap0.verts.forEach((vid, i) => idxIn.set(vid, i));
    for (const dir of surfDir.values()) {
      const gt = dir.indexOf(">");
      const u = +dir.slice(0, gt), v = +dir.slice(gt + 1);
      const iu = idxIn.get(u), iv = idxIn.get(v);
      if (iu === undefined || iv === undefined) continue; // dropped (pinch) chain
      cap.tris.push([iv, iu, nR + iu], [iv, nR + iu, nR + iv]);
    }
    return cap;
  }
```

- [ ] **Step 4: Run** — `node --check js/split.js && node --test` → **64 pass / 0 fail** (all existing split/caps tests untouched — they pass no `thickness`). If the cube test's `subs = [2, 3]` assumption fails or watertightness doesn't hold, STOP and report.

- [ ] **Step 5: Commit**
```bash
git add js/split.js tests/split.test.js
git commit -m "feat(split): minimum-thickness plugs — offset rim, skirt wall, recessed cap"
```

---

### Task 3: UI slider, row layout in the viewer, pass-through

**Files:**
- Modify: `index.html` (split panel), `js/app.js`, `js/viewer.js`, `js/threemf.js`

- [ ] **Step 1: `index.html`** — in the `data-panel="split"` block, after the `</select>` of `#capMethod`, insert:

```html
          <span class="optlabel">Thickness</span>
          <input type="range" id="splitThick" min="0" max="5" step="0.1" value="1.2" />
          <span class="muted" id="splitThickVal">1.2 mm</span>
```

- [ ] **Step 2: `js/app.js`.**
- `doSplit` (line ~482): add thickness to the part record:
```javascript
    splitParts.push({ id: splitSeq++, meshIndex: hit.meshIndex, subs, state: hit.state, method: $("capMethod").value, thickness: +$("splitThick").value });
```
- Snapshots: in `snap()` the splits map gains `thickness: p.thickness`, and the matching `restore()` line gains `thickness: p.thickness` (both map calls currently copy `{ id, meshIndex, subs, state, method }`).
- Next to the `capMethod` change listener, add:
```javascript
  $("splitThick").addEventListener("input", () => { $("splitThickVal").textContent = (+$("splitThick").value).toFixed(1) + " mm"; });
  $("splitThick").addEventListener("change", () => {
    if (!doc || !splitParts.length) return;
    const t = +$("splitThick").value;
    for (const p of splitParts) p.thickness = t;
    pushHistory("Thickness: " + t.toFixed(1) + " mm");
    render(null);
    toast("Re-built " + splitParts.length + " part(s) at " + t.toFixed(1) + " mm");
  });
```

- [ ] **Step 3: `js/viewer.js` — row layout.** In `setSplitParts`, the radial-explode block currently reads (after `const mesh = new THREE.Mesh(gg, mat);`):

```javascript
      const pc = gg.boundingSphere.center;
      // proportional exploded view (pairs separate by ×(1+K)), floored so the
      // part's bounding sphere CLEARS the model's bounding sphere along its
      // ray — near-axis parts (neck rings) pop past the head, not into it
      const off = new THREE.Vector3().subVectors(pc, c);
      const d = off.length();
      if (d < 1e-6) off.set(0, 0, 1); else off.divideScalar(d);
      const partR = gg.boundingSphere.radius || 1;
      const dist = Math.max(EXPLODE_K * d, r + 1.05 * partR + 0.05 * r - d);
      const target = off.multiplyScalar(dist);
      root.add(mesh);
      const cur = prevById.get(p.id) || new THREE.Vector3();
      mesh.position.copy(cur);
      splitObjs.push({ id: p.id, mesh, target, cur });
```

Restructure the loop into two passes — build all part meshes first, then lay them out together (`layoutParts` needs every box):

```javascript
    const built = [];
    for (const p of parts) {
      const s = Split.solidFromSubs(doc.meshes[p.meshIndex], Array.from(p.subs), p.method || "liepa", p.thickness || 0);
      const gg = new THREE.BufferGeometry();
      gg.setAttribute("position", new THREE.BufferAttribute(s.positions, 3));
      gg.setIndex(new THREE.BufferAttribute(s.indices, 1));
      gg.computeVertexNormals();
      gg.computeBoundingSphere();
      gg.computeBoundingBox();
      const mat = new THREE.MeshStandardMaterial({
        color: linColor(p.state).clone(), roughness: 0.75, metalness: 0.0,
      });
      built.push({ p, s, mesh: new THREE.Mesh(gg, mat) });
    }
    // row layout beside the body: parts slot along +X on the base plane
    if (!geom.boundingBox) geom.computeBoundingBox();
    const bb = geom.boundingBox;
    const bodyBox = { min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.max.y, bb.max.z] };
    const margin = 0.06 * (geom.boundingSphere ? 2 * (geom.boundingSphere.radius || 50) : 50);
    const partBoxes = built.map(({ mesh }) => {
      const b = mesh.geometry.boundingBox;
      return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
    });
    const offs = Split.layoutParts(bodyBox, partBoxes, margin);
    built.forEach(({ p, s, mesh }, i) => {
      const target = new THREE.Vector3(offs[i][0], offs[i][1], offs[i][2]);
      root.add(mesh);
      const cur = prevById.get(p.id) || new THREE.Vector3();
      mesh.position.copy(cur);
      splitObjs.push({ id: p.id, mesh, target, cur });
      const capMesh = capMeshFor(p, s);
      if (capMesh) { root.add(capMesh); remainderCapObjs.push(capMesh); }
    });
```
(The old per-part `const capMesh = capMeshFor(p, s); ...` lines at the loop tail move into the `built.forEach` as shown; the `const c = ...` center/`r` radius lines at the top of `setSplitParts` stay — `r` is no longer used by layout, keep or inline as the margin source. Delete the `const EXPLODE_K = 0.8;` line.)

- [ ] **Step 4: `js/threemf.js`** — `exportSplit`'s `solidFromSubs` call gains the thickness:
```javascript
      const g = Split.solidFromSubs(doc.meshes[p.meshIndex], Array.from(p.subs), p.method || "liepa", p.thickness || 0);
```

- [ ] **Step 5: Run** — `node --check js/app.js && node --check js/viewer.js && node --check js/threemf.js && node --test` → **64 pass / 0 fail**.

- [ ] **Step 6: Commit**
```bash
git add index.html js/app.js js/viewer.js js/threemf.js
git commit -m "feat(split): thickness slider + row layout beside the model"
```

(The controller runs the browser verification afterward — implementers skip it.)

---

## Self-Review

**Spec coverage:** §1 plugs → T2 (accumulator, offsets, offset-getPt, thickenCap, t=0 legacy, remainder/preview/export compat via descriptor). §2 layout → T1 (pure) + T3 (viewer consume, EXPLODE_K removal). §3 UI → T3 (slider, doSplit, snapshots, change listener, viewer/threemf pass-through). Testing section → T1/T2 tests + controller browser pass. Covered.

**Placeholder scan:** clean — full code every step; counts 61→62→64→64.

**Type consistency:** `layoutParts(bodyBox, partBoxes, margin)` box shape `{min:[],max:[]}` matches T1 test and T3 viewer construction; `solidFromSubs(..., thickness)` 4th arg matches T2 tests, viewer, threemf; `thickenCap(cap0, offsetOf, surfDir)` consumes the `surfDir` value format `"u>v"` built in the same function scope; part records carry `thickness` through doSplit/snap/restore/viewer/exportSplit consistently.
