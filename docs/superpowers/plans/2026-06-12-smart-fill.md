# Smart Fill (Batch M) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the fill tool a slicer-parity "Smart" mode — a crease-bounded, paint-ignoring flood with an angle slider — alongside the unchanged color fill.

**Architecture:** A lazy face-level adjacency graph + per-face normals (`Cleanup.faceGraph`, subgraph.js) feeds a read-only flood (`Cleanup.selectSmartFaces`, select.js) gated by dihedral angle; painting overwrites whole faces with solid codes (`Cleanup.paintFacesSolid`, cleanup.js), deliberately collapsing split trees (which is why it must `invalidateSub`, unlike `fillRegion`). UI = mode chips + angle slider on the fill options strip; hover preview expands faces→subs (`Cleanup.facesToSubs`) into the existing shared tint cache.

**Tech Stack:** Vanilla JS IIFEs on `window` (no build step), Node's built-in test runner (`npm test` = `node --test`), vm-sandbox harness in `tests/harness.js`. Spec: `docs/superpowers/specs/2026-06-12-smart-fill-design.md`.

**Conventions that bite:** after editing `js/*`, browser checks need the static server restarted on a NEW port (Chrome serves stale modules otherwise). Never `Read` a `.3mf`. Suite is currently **62 passing** — it must stay green throughout.

---

### Task 1: `faceGraph` + cache invalidation (subgraph.js)

**Files:**
- Modify: `js/subgraph.js` (add `faceGraph`, extend `invalidateSub` at line 27, extend the `Object.assign` exports at line 200)
- Modify: `tests/harness.js` (add `makeBentStrip` fixture + export)
- Create: `tests/smartfill.test.js`

- [ ] **Step 1: Add the `makeBentStrip` fixture to the harness**

In `tests/harness.js`, after `makeClosedCube()` (ends ~line 81), add:

```js
// Two planar 2-triangle bands hinged at the y=1 edge, bent by `angleDeg`
// about the hinge. Band 1 (faces 0,1) lies in z=0 with normal +z; band 2
// (faces 2,3) has its normal exactly angleDeg away. All solid state 1.
// Adjacent pairs: 0-1 (coplanar), 1-2 (the hinge), 2-3 (coplanar).
// `withDegenerate` appends a zero-area triangle (vertex ON the A-B segment)
// sharing band 1's free edge — for the zero-normal guard test.
function makeBentStrip(angleDeg, withDegenerate) {
  const a = (angleDeg * Math.PI) / 180;
  const pos = [
    0, 0, 0,  2, 0, 0,  2, 1, 0,  0, 1, 0,   // A B C D (band 1)
    0, 1 + Math.cos(a), Math.sin(a),          // E (hinged above D)
    2, 1 + Math.cos(a), Math.sin(a),          // F (hinged above C)
  ];
  const v1 = [0, 0, 3, 3], v2 = [1, 2, 2, 5], v3 = [2, 3, 5, 4];
  const paints = ["4", "4", "4", "4"];
  if (withDegenerate) {
    pos.push(1, 0, 0);                        // G — collinear on A-B
    v1.push(0); v2.push(1); v3.push(6);
    paints.push("4");
  }
  return {
    nf: paints.length,
    positions: new Float32Array(pos),
    v1: Int32Array.from(v1), v2: Int32Array.from(v2), v3: Int32Array.from(v3),
    paints,
  };
}
```

Add `makeBentStrip` to the harness's `module.exports`.

- [ ] **Step 2: Write the failing tests**

Create `tests/smartfill.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { loadModules, makeClosedCube, makeBentStrip, makeTetra } = require("./harness");

test("faceGraph: cube has 12 faces, 3 neighbors each, unit normals", () => {
  const { Cleanup } = loadModules();
  const mesh = makeClosedCube();
  const g = Cleanup.faceGraph(mesh);
  assert.equal(g.nf, 12);
  assert.equal(g.list.length, 36, "closed manifold: 3 neighbors per triangle");
  for (let f = 0; f < 12; f++) {
    assert.equal(g.start[f + 1] - g.start[f], 3, "face " + f + " has 3 neighbors");
    const L = Math.hypot(g.faceN[f * 3], g.faceN[f * 3 + 1], g.faceN[f * 3 + 2]);
    assert.ok(Math.abs(L - 1) < 1e-6, "unit normal on face " + f);
  }
});

test("faceGraph: bent strip adjacency and degenerate normal", () => {
  const { Cleanup } = loadModules();
  const g = Cleanup.faceGraph(makeBentStrip(20, true));
  // pairs: 0-1, 1-2 (hinge), 2-3, 0-4 (degenerate on A-B) -> 8 directed entries
  assert.equal(g.list.length, 8);
  const L = Math.hypot(g.faceN[12], g.faceN[13], g.faceN[14]);
  assert.equal(L, 0, "zero-area face keeps a zero normal");
});

test("faceGraph is cached and invalidateSub clears it", () => {
  const { Cleanup } = loadModules();
  const mesh = makeTetra();
  const g1 = Cleanup.faceGraph(mesh);
  assert.equal(Cleanup.faceGraph(mesh), g1, "second call returns the cache");
  Cleanup.invalidateSub(mesh);
  assert.equal(mesh._faceG, null, "invalidateSub clears _faceG");
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/smartfill.test.js`
Expected: 3 failing — `TypeError: Cleanup.faceGraph is not a function`.

- [ ] **Step 4: Implement `faceGraph` and extend `invalidateSub`**

In `js/subgraph.js`, change `invalidateSub` (line 27) to also clear the new cache:

```js
  function invalidateSub(mesh) {
    mesh._sub = null;
    mesh._subSizes = null;
    mesh._mirror = null;
    mesh._axisCenters = null;
    mesh._faceG = null;
  }
```

After `buildSubGraph` (ends ~line 150), add:

```js
  // Parent-face adjacency (CSR, same shape as the sub graph) + unit face
  // normals. Geometry-only, lazy, cached as mesh._faceG. invalidateSub clears
  // it anyway — one cache story for everything mesh-attached; the rebuild is
  // a single pass over the index buffer.
  function faceGraph(mesh) {
    if (mesh._faceG) return mesh._faceG;
    const nf = mesh.nf, P = mesh.positions;
    const faceN = new Float32Array(nf * 3);
    for (let f = 0; f < nf; f++) {
      const a = mesh.v1[f] * 3, b = mesh.v2[f] * 3, c = mesh.v3[f] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const L = Math.hypot(nx, ny, nz);
      // degenerate faces keep (0,0,0) — selectSmartFaces never crosses them
      if (L > 0) { faceN[f * 3] = nx / L; faceN[f * 3 + 1] = ny / L; faceN[f * 3 + 2] = nz / L; }
    }
    // undirected vertex-index edge -> every face sharing it (non-manifold:
    // all pairs get connected, so no region is orphaned)
    const NV = P.length / 3;
    const edge = new Map();
    const adjA = [], adjB = [];
    for (let f = 0; f < nf; f++) {
      const va = mesh.v1[f], vb = mesh.v2[f], vc = mesh.v3[f];
      for (const [u, v] of [[va, vb], [vb, vc], [vc, va]]) {
        const key = u < v ? u * NV + v : v * NV + u;
        let arr = edge.get(key);
        if (!arr) edge.set(key, (arr = []));
        for (const p of arr) { adjA.push(p); adjB.push(f); }
        arr.push(f);
      }
    }
    const deg = new Int32Array(nf);
    for (let i = 0; i < adjA.length; i++) { deg[adjA[i]]++; deg[adjB[i]]++; }
    const start = new Int32Array(nf + 1);
    for (let i = 0; i < nf; i++) start[i + 1] = start[i] + deg[i];
    const list = new Int32Array(start[nf]);
    const cur = start.slice(0, nf);
    for (let i = 0; i < adjA.length; i++) {
      const a2 = adjA[i], b2 = adjB[i];
      list[cur[a2]++] = b2;
      list[cur[b2]++] = a2;
    }
    mesh._faceG = { start, list, faceN, nf };
    return mesh._faceG;
  }
```

Add `faceGraph` to the `Object.assign(Cleanup, {...})` export block at the bottom.

- [ ] **Step 5: Run the tests to verify they pass — and the suite stays green**

Run: `node --test tests/smartfill.test.js` → 3 passing.
Run: `npm test` → 65 passing (62 existing + 3), 0 failing.

- [ ] **Step 6: Commit**

```bash
git add js/subgraph.js tests/harness.js tests/smartfill.test.js
git commit -m "feat(fill): faceGraph — lazy parent-face adjacency + normals"
```

---

### Task 2: `selectSmartFaces` + `facesToSubs` (select.js)

**Files:**
- Modify: `js/select.js` (two new functions + exports at line 253)
- Modify: `tests/smartfill.test.js` (append tests)

- [ ] **Step 1: Write the failing tests**

Append to `tests/smartfill.test.js`:

```js
test("selectSmartFaces: cube at 30° selects only the coplanar pair", () => {
  const { Cleanup } = loadModules();
  const mesh = makeClosedCube();
  const r = Cleanup.selectSmartFaces(mesh, 0, 30);
  assert.equal(r.length, 2, "seed face + its coplanar diagonal partner");
  const g = Cleanup.faceGraph(mesh);
  const [a, b] = r;
  const dot = g.faceN[a * 3] * g.faceN[b * 3] + g.faceN[a * 3 + 1] * g.faceN[b * 3 + 1] + g.faceN[a * 3 + 2] * g.faceN[b * 3 + 2];
  assert.ok(dot > 0.999, "the two member faces are coplanar");
});

test("selectSmartFaces: cube at 90° floods all 12 (epsilon regression)", () => {
  // cos(90°) is ~6e-17, not 0 — without the epsilon tolerance the exactly
  // perpendicular cube edges (dot exactly 0) would NOT pass at θ=90.
  const { Cleanup } = loadModules();
  const r = Cleanup.selectSmartFaces(makeClosedCube(), 0, 90);
  assert.equal(r.length, 12);
});

test("selectSmartFaces: 20° bend crossed at θ=30, blocked at θ=10", () => {
  const { Cleanup } = loadModules();
  const mesh = makeBentStrip(20);
  assert.equal(Cleanup.selectSmartFaces(mesh, 0, 30).length, 4, "crosses the bend");
  const r10 = Cleanup.selectSmartFaces(mesh, 0, 10);
  assert.deepEqual([...r10].sort(), [0, 1], "stops at the bend");
});

test("selectSmartFaces: threshold is inclusive at exactly θ", () => {
  const { Cleanup } = loadModules();
  assert.equal(Cleanup.selectSmartFaces(makeBentStrip(30), 0, 30).length, 4);
});

test("selectSmartFaces: degenerate faces are never crossed, even at 90°", () => {
  const { Cleanup } = loadModules();
  const mesh = makeBentStrip(20, true); // face 4 = zero-area on band 1's edge
  const r = Cleanup.selectSmartFaces(mesh, 0, 90);
  assert.equal(r.length, 4, "all real faces, not the degenerate one");
  assert.ok(![...r].includes(4));
});

test("facesToSubs expands faces to exactly their sub-triangles", () => {
  const { Cleanup } = loadModules();
  const mesh = makeTJunction(); // face 0 solid (1 sub), face 1 split "441" (2 subs)
  const g = Cleanup.buildSubGraph(mesh);
  const subs1 = Cleanup.facesToSubs(mesh, Int32Array.from([1]));
  assert.equal(subs1.length, 2);
  for (const s of subs1) assert.equal(g.subFace[s], 1);
  assert.equal(Cleanup.facesToSubs(mesh, Int32Array.from([0, 1])).length, 3);
});
```

`makeTJunction` comes from the harness — extend the import at the top of the file to:

```js
const { loadModules, makeClosedCube, makeBentStrip, makeTetra, makeTJunction } = require("./harness");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/smartfill.test.js`
Expected: the 6 new tests fail — `Cleanup.selectSmartFaces is not a function`; Task 1's 3 still pass.

- [ ] **Step 3: Implement both functions**

In `js/select.js`, after `selectColorRegion` (ends line 175), add:

```js
  // Smart fill: flood parent faces from seedFace, crossing an edge only when
  // the dihedral between the two faces' normals is <= angleDeg. The -1e-6 on
  // the cosine keeps the threshold inclusive under float noise: positions and
  // faceN are float32 (~1e-7 dot error), and cos 90° is ~6e-17, not 0 — an
  // exactly-perpendicular pair must still pass at θ=90. (Plan originally said
  // 1e-9; the inclusive-θ test caught that float32 quantization needs 1e-6.)
  function selectSmartFaces(mesh, seedFace, angleDeg) {
    const g = Cleanup.faceGraph(mesh);
    const { start, list, faceN, nf } = g;
    if (seedFace < 0 || seedFace >= nf) return new Int32Array(0);
    const cosT = Math.cos((angleDeg * Math.PI) / 180) - 1e-6;
    const nzero = (f) => faceN[f * 3] !== 0 || faceN[f * 3 + 1] !== 0 || faceN[f * 3 + 2] !== 0;
    const seen = new Uint8Array(nf);
    const out = [];
    const stk = [seedFace];
    seen[seedFace] = 1;
    while (stk.length) {
      const u = stk.pop();
      out.push(u);
      if (!nzero(u)) continue; // degenerate seed: region = itself
      for (let e = start[u]; e < start[u + 1]; e++) {
        const v = list[e];
        if (seen[v] || !nzero(v)) continue;
        const dot =
          faceN[u * 3] * faceN[v * 3] +
          faceN[u * 3 + 1] * faceN[v * 3 + 1] +
          faceN[u * 3 + 2] * faceN[v * 3 + 2];
        if (dot >= cosT) { seen[v] = 1; stk.push(v); }
      }
    }
    return Int32Array.from(out);
  }

  // Expand parent faces to their sub-triangles (for hover tinting): one pass
  // over subFace with a face mask — O(NS), allocation-light.
  function facesToSubs(mesh, faces) {
    const g = Cleanup.buildSubGraph(mesh);
    const mask = new Uint8Array(mesh.nf);
    for (let i = 0; i < faces.length; i++) mask[faces[i]] = 1;
    const out = [];
    for (let s = 0; s < g.NS; s++) if (mask[g.subFace[s]]) out.push(s);
    return Int32Array.from(out);
  }
```

Add `selectSmartFaces` and `facesToSubs` to the `Object.assign(Cleanup, {...})` block.

- [ ] **Step 4: Run the tests to verify they pass — suite green**

Run: `node --test tests/smartfill.test.js` → 9 passing.
Run: `npm test` → 71 passing, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add js/select.js tests/smartfill.test.js
git commit -m "feat(fill): selectSmartFaces — crease-bounded face flood + facesToSubs"
```

---

### Task 3: `paintFacesSolid` (cleanup.js)

**Files:**
- Modify: `js/cleanup.js` (new function after `fillRegion`, which ends at line 186; exports at line 339)
- Modify: `tests/smartfill.test.js` (append tests)

- [ ] **Step 1: Write the failing tests**

Append to `tests/smartfill.test.js`:

```js
test("paintFacesSolid writes solid codes, collapses splits, updates dom", () => {
  const { Cleanup, Paint } = loadModules();
  const mesh = makeTJunction(); // paints ["4", "441"]
  Cleanup.computeDominant(mesh);
  const n = Cleanup.paintFacesSolid(mesh, Int32Array.from([0, 1]), 2);
  assert.equal(n, 2);
  assert.equal(mesh.paints[0], "8");
  assert.equal(mesh.paints[1], "8", "split tree collapsed to a solid code");
  assert.equal(Paint.solidState(mesh.paints[1]), 2);
  assert.equal(mesh.dom[0], 2);
  assert.equal(mesh.dom[1], 2);
});

test("paintFacesSolid state 0 emits the empty code", () => {
  const { Cleanup } = loadModules();
  const mesh = makeTetra();
  Cleanup.paintFacesSolid(mesh, Int32Array.from([3]), 0);
  assert.equal(mesh.paints[3], "");
});

test("paintFacesSolid invalidates the sub caches (structure changed)", () => {
  const { Cleanup } = loadModules();
  const mesh = makeTJunction();
  const before = Cleanup.buildSubGraph(mesh);
  assert.equal(before.NS, 3);
  Cleanup.paintFacesSolid(mesh, Int32Array.from([1]), 1);
  assert.equal(mesh._sub, null, "collapse requires invalidateSub");
  const after = Cleanup.buildSubGraph(mesh);
  assert.equal(after.NS, 2, "face 1 is one sub now");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/smartfill.test.js`
Expected: 3 new failures — `Cleanup.paintFacesSolid is not a function`.

- [ ] **Step 3: Implement**

In `js/cleanup.js`, after `fillRegion` (line 186), add:

```js
  /* Smart fill: overwrite whole parent faces with one solid state. Collapsing
   * split trees to single leaves CHANGES the sub-triangle structure — so,
   * unlike fillRegion's keep-the-graph-valid trick, this must invalidateSub;
   * the next tool use pays one graph rebuild. Returns the face count. */
  function paintFacesSolid(mesh, faces, state) {
    const code = Paint.encode({ leaf: true, state });
    const dom = mesh.dom;
    for (let i = 0; i < faces.length; i++) {
      const f = faces[i];
      mesh.paints[f] = code;
      if (dom) dom[f] = state;
    }
    Cleanup.invalidateSub(mesh);
    return faces.length;
  }
```

Add `paintFacesSolid` to the export `Object.assign` block (line ~339, next to `fillRegion`).

- [ ] **Step 4: Run the tests to verify they pass — suite green**

Run: `node --test tests/smartfill.test.js` → 12 passing.
Run: `npm test` → 74 passing, 0 failing.

- [ ] **Step 5: Commit**

```bash
git add js/cleanup.js tests/smartfill.test.js
git commit -m "feat(fill): paintFacesSolid — solid-face overwrite with tree collapse"
```

---

### Task 4: UI — mode chips, angle slider, smart dispatch, hover preview

No unit tests (UI glue; the harness doesn't load app.js/viewer.js) — `npm test` must stay green, browser verification is Task 5.

**Files:**
- Modify: `index.html:104-106` (fill options panel)
- Modify: `js/app.js` (hover branch ~line 442, `doFill` dispatch ~line 490, new `doSmartFill` after `doFill` at line 474, handlers near line 687)

- [ ] **Step 1: Replace the fill options panel in `index.html`**

Replace lines 104–106 (the `data-panel="fill"` div) with:

```html
        <div class="opt" data-panel="fill" hidden>
          <span class="optlabel">Mode</span>
          <div class="axes" id="fillModes">
            <button type="button" data-mode="color" class="on" title="Fill the connected same-color region">Color</button>
            <button type="button" data-mode="smart" title="Fill up to sharp creases, ignoring paint">Smart</button>
          </div>
          <label class="check" id="fillAutoWrap"><input type="checkbox" id="fillAuto" checked /><span>Auto — use the surrounding color</span></label>
          <span class="optlabel" id="fillAngleLabel" hidden>Angle ≤ <span id="fillAngleVal">30</span>°</span>
          <input type="range" id="fillAngle" min="1" max="90" value="30" hidden />
        </div>
```

(`.axes` chips reuse the `cutAxes` radio styling; no CSS changes needed.)

- [ ] **Step 2: Wire mode state + handlers in `js/app.js`**

After the `enabledAxes` helper (line 368), add:

```js
  const fillSmart = () => document.querySelector("#fillModes button.on").dataset.mode === "smart";
  function updateFillPanel() {
    const smart = fillSmart();
    $("fillAutoWrap").hidden = smart;
    $("fillAngleLabel").hidden = !smart;
    $("fillAngle").hidden = !smart;
  }
```

In the events section, after the `ringThick` listener (line 690), add:

```js
  document.querySelectorAll("#fillModes button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#fillModes button").forEach((x) => x.classList.toggle("on", x === b));
      updateFillPanel();
      clearHoverPreview(); // mode changes the region a hover/click means
      if (activeTool === "fill" && lastHit) onHover(lastHit);
    })
  );
  $("fillAngle").addEventListener("input", () => {
    $("fillAngleVal").textContent = $("fillAngle").value;
    if (activeTool === "fill") { clearHoverPreview(); if (lastHit) onHover(lastHit); }
  });
```

- [ ] **Step 3: Smart branch in the hover preview**

In `onHover` (line 442-443), replace:

```js
      } else if (activeTool === "fill") {
        subs = Cleanup.selectColorRegion(m, hit.localSub); // fillRegion's flood (no claimed-exclusion)
```

with:

```js
      } else if (activeTool === "fill") {
        if (fillSmart()) {
          const faces = Cleanup.selectSmartFaces(m, Cleanup.buildSubGraph(m).subFace[hit.localSub], +$("fillAngle").value);
          subs = Cleanup.facesToSubs(m, faces);
        } else {
          subs = Cleanup.selectColorRegion(m, hit.localSub); // fillRegion's flood (no claimed-exclusion)
        }
```

(The mode/angle handlers above clear the cache, so the existing `previewCache.members.has(hit.localSub)` fast path stays correct without keying changes.)

- [ ] **Step 4: `doSmartFill` + click dispatch**

After `doFill` (line 474), add:

```js
  function doSmartFill(hit) {
    if (paintState == null) return;
    if (previewActive) { restore(current()); previewActive = false; }
    clearHoverPreview();
    const m = doc.meshes[hit.meshIndex];
    const faces = Cleanup.selectSmartFaces(m, Cleanup.buildSubGraph(m).subFace[hit.localSub], +$("fillAngle").value);
    // no-op when the whole region already carries the active color solid
    const code = Paint.encode({ leaf: true, state: paintState });
    let same = true;
    for (let i = 0; i < faces.length; i++) if ((m.paints[faces[i]] || "") !== code) { same = false; break; }
    if (same) { toast("Already that color", true); return; }
    Cleanup.paintFacesSolid(m, faces, paintState);
    pushHistory("Smart fill");
    render(null);
    updateStats();
    toast("Filled " + faces.length.toLocaleString() + " faces");
  }
```

In `Viewer.onPick` (line 490), replace:

```js
    else if (activeTool === "fill") doFill(hit);
```

with:

```js
    else if (activeTool === "fill") (fillSmart() ? doSmartFill : doFill)(hit);
```

- [ ] **Step 5: Suite green, commit**

Run: `npm test` → 74 passing, 0 failing (UI changes can't break the vm suite — if anything fails, a module edit leaked).

```bash
git add index.html js/app.js
git commit -m "feat(fill): Color|Smart mode chips, angle slider, smart dispatch + hover preview"
```

---

### Task 5: Browser verification

**Files:** none (verification only; fix-up commits if issues surface).

- [ ] **Step 1: Serve on a FRESH port** (stale-cache gotcha from CLAUDE.md)

```bash
python3 -m http.server 8123
```

(If 8123 was used this session, pick another. Kill it when done.)

- [ ] **Step 2: Playwright walkthrough** (load `http://localhost:8123`, upload `samples/` reference model via the file input)

Verify, in order:
1. Press **F** → fill panel shows **Mode [Color|Smart]** chips, Color active, Auto checkbox visible, no angle slider.
2. Click **Smart** → Auto hides, `Angle ≤ 30°` slider appears.
3. Hover the model → cyan-tinted region bounded by creases; move within the region → no flicker (cache hit); drag the angle slider → readout updates and the tinted region re-floods live.
4. Pick a palette color, click → region paints that color; toast reports face count; History shows "Smart fill"; **⌘Z** restores, **⌘⇧Z** re-applies.
5. Click the same region again with the same color → "Already that color" toast, **no** history entry (check `#histInfo` unchanged).
6. Switch back to **Color** → Auto reappears, hover preview shows the same-color region, a click behaves exactly as before the change.
7. Console: zero errors/warnings throughout.

- [ ] **Step 3: Full suite one last time**

Run: `npm test` → 74 passing.

- [ ] **Step 4: Mark the spec shipped**

In `docs/superpowers/specs/2026-06-12-smart-fill-design.md`, change the Status line to `**Status:** Shipped (Batch M).` Then:

```bash
git add docs/superpowers/specs/2026-06-12-smart-fill-design.md
git commit -m "docs: mark Batch M smart fill spec shipped"
```
