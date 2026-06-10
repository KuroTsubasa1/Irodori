# Colors + Symmetry (Batch B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add new sliceable filament colors (palette "+" → color picker → written into `project_settings.config` on export) and an X/Y/Z brush-symmetry option (mirror each stroke across the model center).

**Architecture:** A pure `ThreeMF.extendFilamentConfig` helper (Node-tested) drives the export-config change; a `Cleanup.mirrorMap` (Node-tested) drives symmetry; the rest is palette/brush UI wiring in `app.js`/`index.html`/`css`.

**Tech Stack:** Vanilla JS (IIFE + `window` globals), three.js, JSZip (call-time only), Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-06-10-colors-symmetry-design.md`

**Conventions:** After each task, `node --check <changed .js>` + `node --test`. The suite is **25** before this batch and **grows** as Tasks 1–2 add tests (Task 1 → 26, Task 2 → 28). Browser verification via `python3 -m http.server 8123` + the reference `.3mf` (controller drives it). Stage only named files; never the `.3mf`.

---

### Task 1: `ThreeMF.extendFilamentConfig` (pure, Node-tested) + load threemf in harness

**Files:**
- Modify: `tests/harness.js` (load `js/threemf.js`, return `ThreeMF`)
- Modify: `js/threemf.js` (add `extendFilamentConfig`, export it)
- Create: `tests/threemf.test.js`

- [ ] **Step 1: Load threemf.js in the harness.** In `tests/harness.js`, add `"js/threemf.js"` to the `for` array (after `"js/split.js"` is fine — its IIFE only *defines* functions; JSZip is referenced at call time, not load time). Add `ThreeMF: sandbox.ThreeMF,` to the returned object.

- [ ] **Step 2: Write the failing test** — create `tests/threemf.test.js`:

```javascript
const test = require("node:test");
const assert = require("node:assert");
const { loadModules } = require("./harness");

test("extendFilamentConfig adds a filament to every per-filament array + sets colours", () => {
  const { ThreeMF } = loadModules();
  const cfg = JSON.stringify({
    filament_colour: ["#AAAAAAFF", "#BBBBBBFF"],
    filament_type: ["PLA", "PLA"],
    other_two: [1, 2],
    unrelated_three: [9, 9, 9],
    scalar: "x",
  });
  const out = JSON.parse(ThreeMF.extendFilamentConfig(cfg, 2, [{ hex: "#AAAAAA" }, { hex: "#BBBBBB" }, { hex: "#112233" }]));
  assert.deepEqual(out.filament_colour, ["#AAAAAAFF", "#BBBBBBFF", "#112233FF"]);
  assert.deepEqual(out.filament_type, ["PLA", "PLA", "PLA"], "per-filament array gets [0] duplicated");
  assert.deepEqual(out.other_two, [1, 2, 1], "length-2 array extended");
  assert.deepEqual(out.unrelated_three, [9, 9, 9], "length-3 array untouched");
  assert.equal(out.scalar, "x");
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test tests/threemf.test.js`
Expected: FAIL — `ThreeMF.extendFilamentConfig is not a function`.

- [ ] **Step 4: Implement** — add to `js/threemf.js` (above the `global.ThreeMF = ...` line):

```javascript
  // Extend a Bambu project_settings.config (JSON text) to include newly-added
  // filaments. Every per-filament array (length === origCount) gets copies of its
  // element [0] appended (so the new filament inherits filament-0's slicer
  // settings); filament_colour is set to all filaments' #RRGGBBFF colours.
  function extendFilamentConfig(configText, origCount, filaments) {
    const j = JSON.parse(configText);
    const add = filaments.length - origCount;
    if (add > 0) {
      for (const k in j) {
        if (Array.isArray(j[k]) && j[k].length === origCount) {
          const fill = j[k][0];
          for (let i = 0; i < add; i++) {
            j[k].push(typeof fill === "object" && fill !== null ? JSON.parse(JSON.stringify(fill)) : fill);
          }
        }
      }
    }
    j.filament_colour = filaments.map((f) => (f.hex.length >= 7 ? f.hex.slice(0, 7) : f.hex) + "FF");
    return JSON.stringify(j);
  }
```

and change the export to include it:
```javascript
  global.ThreeMF = { load, exportZip, exportSplit, extendFilamentConfig };
```

- [ ] **Step 5: Run to verify pass**

Run: `node --test`
Expected: PASS — **26 pass / 0 fail**.

- [ ] **Step 6: Commit**

```bash
git add tests/harness.js js/threemf.js tests/threemf.test.js
git commit -m "feat(export): pure extendFilamentConfig helper for added filaments"
```

---

### Task 2: `Cleanup.mirrorMap` (Node-tested) + invalidation

**Files:**
- Modify: `tests/harness.js` (add `makeMirrorPair` fixture + export)
- Modify: `js/cleanup.js` (add `mirrorMap`, clear `_mirror` in `invalidateSub`, export)
- Modify: `tests/region.test.js` (add mirror tests)

- [ ] **Step 1: Add a symmetric fixture to `tests/harness.js`** and export it (add `makeMirrorPair` to `module.exports`):

```javascript
// Two solid triangles that are exact mirror images across x = 0 (one sub each).
function makeMirrorPair() {
  return {
    nf: 2,
    positions: new Float32Array([1, 0, 0, 2, 0, 0, 1.5, 1, 0,  -1, 0, 0, -2, 0, 0, -1.5, 1, 0]),
    v1: Int32Array.from([0, 3]),
    v2: Int32Array.from([1, 4]),
    v3: Int32Array.from([2, 5]),
    paints: ["4", "4"],
  };
}
```

- [ ] **Step 2: Write the failing tests** — append to `tests/region.test.js` (add `makeMirrorPair` to its `require("./harness")` destructure):

```javascript
test("mirrorMap pairs X-mirrored sub-triangles; no partner on the Y axis", () => {
  const { Cleanup } = loadModules();
  const mesh = makeMirrorPair();
  const mx = Cleanup.mirrorMap(mesh, 0); // X
  assert.equal(mx.length, 2);
  assert.equal(mx[0], 1, "sub 0 mirrors to sub 1 across X");
  assert.equal(mx[1], 0, "sub 1 mirrors to sub 0 across X");
  const my = Cleanup.mirrorMap(mesh, 1); // Y — the two subs are not Y-mirrors
  assert.equal(my[0], -1);
  assert.equal(my[1], -1);
});

test("mirrorMap returns -1 where no mirror exists (asymmetric tetra)", () => {
  const { Cleanup } = loadModules();
  const m = Cleanup.mirrorMap(makeTetra(), 0);
  // tetra is not X-symmetric, so at least one sub has no partner
  assert.ok([...m].some((p) => p === -1));
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test tests/region.test.js`
Expected: FAIL — `Cleanup.mirrorMap is not a function`.

- [ ] **Step 4: Implement** — add to `js/cleanup.js` (e.g. after `selectColorRegion`):

```javascript
  // Per-sub mirror partner across the model-center plane perpendicular to `axis`
  // (0=x,1=y,2=z): entry s = the sub whose centroid is the mirror of s's centroid
  // (within a ~1% tolerance via a spatial grid), or -1. Cached per axis on the
  // mesh; tolerant matching so it works on imperfectly-symmetric organic meshes.
  function mirrorMap(mesh, axis) {
    const g = buildSubGraph(mesh);
    if (!mesh._mirror) mesh._mirror = {};
    if (mesh._mirror[axis]) return mesh._mirror[axis];
    const { cen, NS } = g;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < NS; i++) for (let a = 0; a < 3; a++) { const v = cen[i * 3 + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
    const center = (lo[axis] + hi[axis]) / 2;
    const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
    const cell = diag * 0.01;          // grid resolution
    const tol2 = cell * cell;          // match tolerance (squared) ~ one cell
    const ci = (v, a) => Math.floor((v - lo[a]) / cell);
    const bkey = (a, b, c) => a + "," + b + "," + c;
    const buckets = new Map();
    for (let i = 0; i < NS; i++) {
      const k = bkey(ci(cen[i * 3], 0), ci(cen[i * 3 + 1], 1), ci(cen[i * 3 + 2], 2));
      let arr = buckets.get(k); if (!arr) buckets.set(k, arr = []); arr.push(i);
    }
    const map = new Int32Array(NS).fill(-1);
    for (let i = 0; i < NS; i++) {
      let mx = cen[i * 3], my = cen[i * 3 + 1], mz = cen[i * 3 + 2];
      if (axis === 0) mx = 2 * center - mx; else if (axis === 1) my = 2 * center - my; else mz = 2 * center - mz;
      const bx = ci(mx, 0), by = ci(my, 1), bz = ci(mz, 2);
      let best = -1, bestD = tol2;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const arr = buckets.get(bkey(bx + dx, by + dy, bz + dz)); if (!arr) continue;
        for (const j of arr) {
          if (j === i) continue;
          const ddx = cen[j * 3] - mx, ddy = cen[j * 3 + 1] - my, ddz = cen[j * 3 + 2] - mz;
          const d = ddx * ddx + ddy * ddy + ddz * ddz;
          if (d < bestD) { bestD = d; best = j; }
        }
      }
      map[i] = best;
    }
    mesh._mirror[axis] = map;
    return map;
  }
```

In `invalidateSub(mesh)`, add a line to clear the cache: after `mesh._subSizes = null;` add `mesh._mirror = null;`. Add `mirrorMap` to the `global.Cleanup = { ... }` export.

- [ ] **Step 5: Run to verify pass**

Run: `node --test`
Expected: PASS — **28 pass / 0 fail**.

- [ ] **Step 6: Commit**

```bash
git add tests/harness.js js/cleanup.js tests/region.test.js
git commit -m "feat(symmetry): per-sub mirror map via tolerant centroid grid"
```

---

### Task 3: Export — inject added filaments into `project_settings.config`

**Files:**
- Modify: `js/threemf.js` (`load` returns `origFilamentCount`; `exportZip` rewrites the config)

- [ ] **Step 1: Track the original filament count in `load`.** In `ThreeMF.load`, the return object currently is `{ zip, filaments, defaultExtruder, meshes }`. Add `origFilamentCount: filaments.length`:
```javascript
    return { zip, filaments, defaultExtruder, meshes, origFilamentCount: filaments.length };
```

- [ ] **Step 2: Rewrite the config in `exportZip`** when filaments were added. In `exportZip(doc)`, after the `for (const mesh of doc.meshes) { ... }` loop and **before** `return await doc.zip.generateAsync(...)`, insert:
```javascript
    if (doc.filaments.length > (doc.origFilamentCount || doc.filaments.length)) {
      const arr = doc.zip.file(/project_settings\.config$/i);
      if (arr && arr.length) {
        const text = await arr[0].async("string");
        doc.zip.file(arr[0].name, extendFilamentConfig(text, doc.origFilamentCount, doc.filaments));
      }
    }
```

- [ ] **Step 3: Syntax + regression**

Run: `node --check js/threemf.js && node --test`
Expected: no syntax output; **28 pass / 0 fail** (no new test — covered by Task 1's unit test of the helper + the browser check below).

- [ ] **Step 4: Browser-verify** (after Task 4 lands the add-color UI, so you can actually add one)

Load the model, add a color (Task 4 UI), paint a patch with it, Export. Unzip the saved `_fixed.3mf` and confirm `Metadata/project_settings.config` has the new colour appended to `filament_colour` and that `filament_colour.length` equals the other per-filament arrays' lengths.

- [ ] **Step 5: Commit**

```bash
git add js/threemf.js
git commit -m "feat(export): write added filaments into project_settings.config"
```

---

### Task 4: Palette shows all filaments + "+" add-color

**Files:**
- Modify: `js/app.js` (`buildPalette`, add-color handler)
- Modify: `index.html` (hidden color input)
- Modify: `css/style.css` (`.pal.add`)

- [ ] **Step 1: Rebuild `buildPalette` from `doc.filaments`** + an add swatch. Replace the current `buildPalette` body with:
```javascript
  function buildPalette() {
    const pal = $("palette");
    pal.innerHTML = "";
    doc.filaments.forEach((f, i) => {
      const s = i + 1; // filament index = paint state
      const d = document.createElement("div");
      d.className = "pal"; d.dataset.state = s; d.style.background = f.hex; d.title = "Filament " + s;
      d.addEventListener("click", () => selectPaint(s));
      pal.appendChild(d);
    });
    const add = document.createElement("div");
    add.className = "pal add"; add.title = "Add a new color"; add.textContent = "+";
    add.addEventListener("click", () => $("addColorInput").click());
    pal.appendChild(add);
    if (doc.filaments.length) selectPaint(doc.filaments.length);
  }
```

- [ ] **Step 2: Add the color-input + its handler in `js/app.js`.** Near the other `addEventListener` wiring, add:
```javascript
  $("addColorInput").addEventListener("change", (e) => {
    if (!doc) return;
    const hex = e.target.value; // "#rrggbb"
    doc.filaments.push({ index: doc.filaments.length + 1, hex });
    buildPalette();
    selectPaint(doc.filaments.length);
    toast("Added color " + hex.toUpperCase());
  });
```

- [ ] **Step 3: Add the hidden input to `index.html`.** Inside the `<div class="palette" id="palette" ...>` is generated; add a sibling hidden input right after the palette div in the options bar:
```html
        <input type="color" id="addColorInput" value="#3aa6ff" style="display:none" />
```

- [ ] **Step 4: Style the add swatch in `css/style.css`** (after the `.pal` rules):
```css
.pal.add { display: grid; place-items: center; background: transparent; box-shadow: inset 0 0 0 1.5px #c7cedb; color: var(--muted); font-size: 17px; font-weight: 700; line-height: 1; }
.pal.add:hover { box-shadow: inset 0 0 0 1.5px var(--accent); color: var(--accent); transform: translateY(-2px); }
```

- [ ] **Step 5: Syntax + regression**

Run: `node --check js/app.js && node --test`
Expected: no syntax output; **28 pass / 0 fail**.

- [ ] **Step 6: Browser-verify**

Load the model. The palette shows the 4 filaments + a "+" swatch. Click "+" → a color picker opens; pick a color → a new swatch appears, selected. Paint with it (Brush) → strokes use the new color. Existing filaments still paint correctly.

- [ ] **Step 7: Commit**

```bash
git add js/app.js index.html css/style.css
git commit -m "feat(palette): show all filaments + add-color picker"
```

---

### Task 5: Brush symmetry (stroke + UI)

**Files:**
- Modify: `index.html` (brush options: symmetry checkbox + axis select)
- Modify: `js/app.js` (`brushAt` mirrors the painted subs)

- [ ] **Step 1: Add the symmetry controls to the brush options panel in `index.html`.** Inside `<div class="opt" data-panel="brush" hidden>`, after the existing size slider + `#brushPrev`, add:
```html
          <label class="check"><input type="checkbox" id="brushSym" /><span>Symmetry</span></label>
          <select id="brushSymAxis"><option value="x" selected>X</option><option value="y">Y</option><option value="z">Z</option></select>
```

- [ ] **Step 2: Mirror the painted subs in `brushAt` (`js/app.js`).** Replace the current `brushAt` body with:
```javascript
  function brushAt(hit) {
    if (!stroke || hit.meshIndex !== stroke.mi) return;
    const m = doc.meshes[hit.meshIndex];
    const subs = Cleanup.selectRadius(m, hit.localSub, hit.point.x, hit.point.y, hit.point.z, brushRadius());
    let all = subs;
    if ($("brushSym").checked) {
      const axis = { x: 0, y: 1, z: 2 }[$("brushSymAxis").value] || 0;
      const mir = Cleanup.mirrorMap(m, axis);
      all = subs.slice();
      for (const s of subs) { const p = mir[s]; if (p >= 0) all.push(p); }
    }
    const g = [];
    for (const s of all) { stroke.pend.add(s); g.push(Viewer.toGlobalSub(hit.meshIndex, s)); }
    Viewer.paintSubs(g, paintState);
  }
```

- [ ] **Step 3: Syntax + regression**

Run: `node --check js/app.js && node --test`
Expected: no syntax output; **28 pass / 0 fail**.

- [ ] **Step 4: Browser-verify**

Load the model, Brush, check **Symmetry** with axis **X**. Paint a stroke on one side of the body → the mirror-image region on the other side is painted too. Uncheck Symmetry → only the brushed side paints. Switch axis to Y/Z → mirrors across the new plane. (On the organic Pikachu, mirroring is approximate/best-effort.)

- [ ] **Step 5: Commit**

```bash
git add index.html js/app.js
git commit -m "feat(brush): X/Y/Z symmetry mirrors strokes across the model center"
```

---

## Self-Review

**Spec coverage:** W5 add-colors → palette + "+" (Task 4), `extendFilamentConfig` (Task 1), export wiring + `origFilamentCount` (Task 3). W4 symmetry → `mirrorMap` (Task 2), brush stroke + UI (Task 5). All spec items mapped.

**Placeholder scan:** No TBD/TODO; every step has exact code and exact `node --check`/`node --test` commands with expected counts; browser steps concrete.

**Type/name consistency:** `extendFilamentConfig(configText, origCount, filaments)` is defined + exported in Task 1, unit-tested there, and called in Task 3 with `(text, doc.origFilamentCount, doc.filaments)`. `doc.origFilamentCount` is produced by `load` (Task 3 step 1) and read in `exportZip` (Task 3 step 2). `Cleanup.mirrorMap(mesh, axis)` is defined/exported/tested in Task 2 and called in `brushAt` (Task 5) with the axis from `#brushSymAxis`. `#brushSym`/`#brushSymAxis`/`#addColorInput` ids match between `index.html` and `app.js`. `doc.filaments` entries are `{ index, hex }` throughout; palette state = filament index.
