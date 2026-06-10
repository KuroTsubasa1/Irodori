# Color & UI Polish (Batch G) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Generic-PLA export, color picker anchored under the "+", deletable added colors (repaint-to-default + remap + undo), shortcut badges on the tool buttons, and a "Colors to clean" list that stays in sync.

**Architecture:** A pure `ThreeMF.normalizeFilamentConfig` (extends arrays + forces Generic PLA) runs on every export path; `Cleanup.remapStates` (pure tree rewrite) powers color deletion; the palette/filament-list/snapshot wiring lives in `app.js`.

**Tech Stack:** Vanilla JS (IIFE + globals), Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-06-10-color-ui-polish-design.md`

**Conventions:** `node --test`; suite **40** before → **41** (T1) → **42** (T2) → stays **42**. `node --check` changed js. Stage only named files; never the `.3mf`s. Match on code, not line numbers.

---

### Task 1: `ThreeMF.normalizeFilamentConfig` + both export paths

**Files:**
- Modify: `js/threemf.js`
- Test: `tests/threemf.test.js`

- [ ] **Step 1: Write the failing test** — append to `tests/threemf.test.js`:

```javascript
test("normalizeFilamentConfig forces Generic PLA and keeps the extension behavior", () => {
  const { ThreeMF } = loadModules();
  const cfg = JSON.stringify({
    filament_colour: ["#AAAAAAFF", "#BBBBBBFF"],
    filament_settings_id: ["Bambu PLA Basic @BBL X1C", "Bambu PLA Basic @BBL X1C"],
    filament_type: ["PETG", "PETG"],
    other_two: [7, 8],
  });
  const out = JSON.parse(ThreeMF.normalizeFilamentConfig(cfg, 2, [{ hex: "#AAAAAA" }, { hex: "#BBBBBB" }, { hex: "#112233" }]));
  assert.deepEqual(out.filament_settings_id, ["Generic PLA", "Generic PLA", "Generic PLA"]);
  assert.deepEqual(out.filament_type, ["PLA", "PLA", "PLA"]);
  assert.deepEqual(out.filament_colour, ["#AAAAAAFF", "#BBBBBBFF", "#112233FF"]);
  assert.deepEqual(out.other_two, [7, 8, 7], "per-filament arrays still extended");
});
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/threemf.test.js` → FAIL (`normalizeFilamentConfig is not a function`).

- [ ] **Step 3: Implement** — in `js/threemf.js`, add after `extendFilamentConfig`:

```javascript
  // Export-time filament normalization: extend per-filament arrays for added
  // colours, then force every filament to a generic profile (user setting —
  // exported files always slice as Generic PLA).
  function normalizeFilamentConfig(configText, origCount, filaments) {
    const j = JSON.parse(extendFilamentConfig(configText, origCount, filaments));
    j.filament_settings_id = filaments.map(() => "Generic PLA");
    j.filament_type = filaments.map(() => "PLA");
    return JSON.stringify(j);
  }
```

In `exportZip`, the config rewrite is currently conditional:
```javascript
    if (doc.filaments.length > (doc.origFilamentCount ?? 0)) {
      const arr = doc.zip.file(/project_settings\.config$/i);
      if (arr && arr.length) {
        const text = await arr[0].async("string");
        doc.zip.file(arr[0].name, extendFilamentConfig(text, doc.origFilamentCount, doc.filaments));
      }
    }
```
Make it unconditional and normalizing:
```javascript
    const cfgArr = doc.zip.file(/project_settings\.config$/i);
    if (cfgArr && cfgArr.length) {
      const text = await cfgArr[0].async("string");
      doc.zip.file(cfgArr[0].name, normalizeFilamentConfig(text, doc.origFilamentCount ?? doc.filaments.length, doc.filaments));
    }
```

In `exportSplit`, the keep-loop currently copies the config verbatim:
```javascript
    for (const [rx, path] of keep) {
      const t = await readText(doc.zip, rx);
      if (t != null) zip.file(path, t);
    }
```
Normalize the config on the way through:
```javascript
    for (const [rx, path] of keep) {
      let t = await readText(doc.zip, rx);
      if (t == null) continue;
      if (path === "Metadata/project_settings.config") {
        t = normalizeFilamentConfig(t, doc.origFilamentCount ?? doc.filaments.length, doc.filaments);
      }
      zip.file(path, t);
    }
```
Add `normalizeFilamentConfig` to the `global.ThreeMF` export.

- [ ] **Step 4: Run** — `node --check js/threemf.js && node --test` → **41 pass / 0 fail**.

- [ ] **Step 5: Commit**

```bash
git add js/threemf.js tests/threemf.test.js
git commit -m "feat(export): normalize all filaments to Generic PLA on both export paths"
```

---

### Task 2: `Cleanup.remapStates`

**Files:**
- Modify: `js/cleanup.js`
- Test: `tests/region.test.js`

- [ ] **Step 1: Write the failing test** — append to `tests/region.test.js`:

```javascript
test("remapStates rewrites solid and split faces", () => {
  const { Cleanup, Paint } = loadModules();
  const mesh = makeTetra(); // paints "4","4","4","8" (states 1,1,1,2)
  const n = Cleanup.remapStates(mesh, (s) => (s === 2 ? 0 : s));
  assert.equal(n, 1, "one face changed");
  assert.equal(mesh.paints[3], "", "state-2 face became default (empty code)");
  // a split face: "841" = 1-way split with leaves states 1 and 2
  const m2 = { nf: 1, positions: new Float32Array(9), v1: Int32Array.from([0]), v2: Int32Array.from([1]), v3: Int32Array.from([2]), paints: ["841"] };
  Cleanup.remapStates(m2, (s) => (s === 2 ? 5 : s));
  const counts = {};
  Paint.addLeafCounts(Paint.decode(m2.paints[0]), counts);
  assert.deepEqual(Object.keys(counts).map(Number).sort((a, b) => a - b), [1, 5]);
});
```
(Add `Paint` to the file's harness destructure if missing.)

- [ ] **Step 2: Run to verify failure** — `node --test tests/region.test.js` → FAIL (`Cleanup.remapStates is not a function`).

- [ ] **Step 3: Implement** — add to `js/cleanup.js` (near `applyStates`):

```javascript
  // Rewrite every face's paint states through mapFn (decode -> remapLeaves ->
  // collapse -> encode). Used when deleting a filament (k -> 0, >k shifts down).
  // Note: remapLeaves returns the same node only for untouched LEAF faces;
  // split faces are always rebuilt, so the encode comparison filters no-ops.
  function remapStates(mesh, mapFn) {
    let changed = 0;
    for (let f = 0; f < mesh.nf; f++) {
      const tree = Paint.decode(mesh.paints[f]);
      const mapped = Paint.remapLeaves(tree, mapFn);
      if (mapped === tree) continue;
      const col = Paint.collapseDeep(mapped);
      const enc = Paint.encode(col);
      if (enc !== mesh.paints[f]) {
        mesh.paints[f] = enc;
        changed++;
        if (mesh.dom) mesh.dom[f] = Paint.dominantState(col);
      }
    }
    if (changed) invalidateSub(mesh);
    return changed;
  }
```
Add `remapStates` to the `global.Cleanup` export.

- [ ] **Step 4: Run** — `node --test` → **42 pass / 0 fail**.

- [ ] **Step 5: Commit**

```bash
git add js/cleanup.js tests/region.test.js
git commit -m "feat(cleanup): remapStates rewrites paint states across a mesh"
```

---

### Task 3: Add/delete colors — anchored picker, × on added swatches, undo

**Files:**
- Modify: `index.html` (`#addColorInput` style)
- Modify: `js/app.js` (`buildPalette`, `deleteColor`, add-handler, `snap`/`restore`, `jumpTo`/`doReset`)
- Modify: `css/style.css` (`.pal .del`)

- [ ] **Step 1: Restyle the hidden input** in `index.html`. Change
```html
        <input type="color" id="addColorInput" value="#3aa6ff" style="display:none" />
```
to (must NOT be `display:none` — `showPicker()` anchors to the input's box):
```html
        <input type="color" id="addColorInput" value="#3aa6ff" style="position:fixed; width:1px; height:1px; opacity:0; border:0; padding:0; pointer-events:none" />
```

- [ ] **Step 2: Rebuild `buildPalette` in `js/app.js`** — × chips on added swatches + picker anchored under the "+":

```javascript
  function buildPalette() {
    const pal = $("palette");
    pal.innerHTML = "";
    const orig = doc.origFilamentCount ?? doc.filaments.length;
    doc.filaments.forEach((f, i) => {
      const s = i + 1; // filament index = paint state
      const d = document.createElement("div");
      d.className = "pal"; d.dataset.state = s; d.style.background = f.hex; d.title = "Filament " + s;
      d.addEventListener("click", () => selectPaint(s));
      if (s > orig) {
        const x = document.createElement("span");
        x.className = "del"; x.textContent = "×"; x.title = "Delete this color";
        x.addEventListener("click", (e) => { e.stopPropagation(); deleteColor(s); });
        d.appendChild(x);
      }
      pal.appendChild(d);
    });
    const add = document.createElement("div");
    add.className = "pal add"; add.title = "Add a new color"; add.textContent = "+";
    add.addEventListener("click", () => {
      const inp = $("addColorInput");
      const r = add.getBoundingClientRect();
      inp.style.left = r.left + "px";          // anchor the native picker under the +
      inp.style.top = r.bottom + 4 + "px";
      if (inp.showPicker) inp.showPicker(); else inp.click();
    });
    pal.appendChild(add);
    if (doc.filaments.length) selectPaint(Math.min(paintState || doc.filaments.length, doc.filaments.length));
  }
```

- [ ] **Step 3: Add `deleteColor` (place after `buildPalette`):**

```javascript
  // Delete an ADDED filament: areas painted with it return to the model default,
  // higher paint states shift down, and the whole operation is one undo step.
  function deleteColor(k) {
    if (!doc || k <= (doc.origFilamentCount ?? 0)) return;
    if (previewActive) { restore(current()); previewActive = false; }
    clearHoverPreview();
    busy("Removing color…", () => {
      const mapFn = (s) => (s === k ? 0 : s > k ? s - 1 : s);
      for (const m of doc.meshes) Cleanup.remapStates(m, mapFn);
      doc.filaments.splice(k - 1, 1);
      doc.filaments.forEach((f, i) => (f.index = i + 1));
      pushHistory("Delete color");
      buildPalette(); // re-selects a valid paint colour
      render(null);
      updateStats();
      toast("Color removed · repainted to default where used");
    });
  }
```

- [ ] **Step 4: Make add-color undoable.** Replace the `#addColorInput` change handler with:

```javascript
  $("addColorInput").addEventListener("change", (e) => {
    if (!doc) return;
    const hex = e.target.value; // "#rrggbb"
    doc.filaments.push({ index: doc.filaments.length + 1, hex });
    pushHistory("Add color");
    paintState = doc.filaments.length;
    buildPalette();
    updateStats();
    toast("Added color " + hex.toUpperCase());
  });
```

- [ ] **Step 5: Carry filaments through history.** In `snap()`, add a `filaments` field:
```javascript
      filaments: doc.filaments.map((f) => ({ index: f.index, hex: f.hex })),
```
In `restore(state)`, restore them (before the splits line):
```javascript
    if (state.filaments) doc.filaments = state.filaments.map((f) => ({ index: f.index, hex: f.hex }));
```
In `jumpTo(idx)` and `doReset()`, rebuild the palette after `restore(...)`/before `updateStats()`: add `buildPalette();` to each (history navigation refreshes the UI; cheap preview rollbacks via bare `restore()` don't).

- [ ] **Step 6: × chip styling** — append to `css/style.css` (after the `.pal.add` rules):
```css
.pal { position: relative; }
.pal .del { position: absolute; top: -6px; right: -6px; width: 15px; height: 15px; border-radius: 50%; background: #1d2330; color: #fff; font-size: 11px; line-height: 15px; text-align: center; cursor: pointer; opacity: 0; transition: opacity .12s; }
.pal:hover .del { opacity: 1; }
.pal .del:hover { background: var(--accent-d); }
```

- [ ] **Step 7: Run** — `node --check js/app.js && node --test` → silent; **42 pass / 0 fail**.

- [ ] **Step 8: Commit**

```bash
git add index.html js/app.js css/style.css
git commit -m "feat(palette): anchored picker, deletable added colors (repaint+remap), undoable add/delete"
```

---

### Task 4: Shortcut badges on the tool buttons

**Files:**
- Modify: `index.html` (toolbar buttons)
- Modify: `css/style.css`

- [ ] **Step 1:** In each toolbar button in `index.html`, append a `<kbd>` chip after the `<span>` label: Orbit → `<kbd class="kbd">O</kbd>`, Rotate → `R`, Brush → `B`, Ring → `N`, Fill → `F`, Split → `S`. Example:
```html
            <span>Orbit</span>
            <kbd class="kbd">O</kbd>
```

- [ ] **Step 2:** Append to `css/style.css` (after the `.tool.active` rule):
```css
.tool .kbd { font-family: inherit; font-size: 10.5px; line-height: 1; font-weight: 700; padding: 3px 5px; border-radius: 5px; background: var(--card-2); color: var(--muted); border: 1px solid var(--line); }
.tool.active .kbd { background: rgba(255, 255, 255, 0.18); color: #fff; border-color: transparent; }
```

- [ ] **Step 3: Run** — `node --test` → **42 pass / 0 fail** (markup/CSS only).

- [ ] **Step 4: Commit**

```bash
git add index.html css/style.css
git commit -m "feat(ui): keyboard-shortcut badges on the tool buttons"
```

---

### Task 5: "Colors to clean" stays in sync

**Files:**
- Modify: `js/app.js` (`buildFilamentUI` → `refreshFilamentUI`, `updateStats`, `loadFile`)

- [ ] **Step 1: Replace `buildFilamentUI` with a preserving, palette-aware version:**

```javascript
  // The clean-list shows every paintable colour (union of states present in the
  // meshes and all palette filaments; count 0 when unpainted) and preserves the
  // user's protect-toggles across rebuilds.
  function refreshFilamentUI() {
    const fc = gatherStates();
    const list = $("filamentList");
    const prev = {};
    list.querySelectorAll("input[data-state]").forEach((cb) => (prev[cb.dataset.state] = cb.checked));
    list.innerHTML = "";
    const states = new Set(Object.keys(fc).map(Number));
    for (let i = 1; i <= doc.filaments.length; i++) states.add(i);
    [...states].sort((a, b) => a - b).forEach((s) => {
      const li = document.createElement("li");
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = prev[s] !== undefined ? prev[s] : true; cb.dataset.state = s;
      cb.addEventListener("change", clearPreview);
      const sw = document.createElement("span");
      sw.className = "swatch"; sw.style.background = stateColor(s);
      const nm = document.createElement("span");
      nm.className = "fname"; nm.textContent = colorName(s);
      const ct = document.createElement("span");
      ct.className = "fcount"; ct.textContent = (fc[s] || 0).toLocaleString();
      li.append(cb, sw, nm, ct);
      list.appendChild(li);
    });
  }
```

- [ ] **Step 2: Hook it into `updateStats`.** Add `refreshFilamentUI();` as the FIRST line of `updateStats()` (which already runs after load, paint, ring, fill, clean, undo/redo, add/delete color). Remove the now-redundant `buildFilamentUI();` call in `loadFile` (grep `buildFilamentUI` → zero references remain).

- [ ] **Step 3: Run** — `node --check js/app.js && node --test` → silent; **42 pass / 0 fail**.

- [ ] **Step 4: Commit**

```bash
git add js/app.js
git commit -m "feat(ui): clean-list shows all palette colours and survives rebuilds"
```

---

## Self-Review

**Spec coverage:** §1 Generic PLA both paths → T1. §2 anchored picker → T3 (input restyle + anchored `showPicker`). §3 delete (repaint+remap+undo, × on added) → T2+T3. §4 badges → T4. §5 clean-list → T5. All covered.

**Placeholder scan:** none; complete code everywhere; counts 40→41→42→42.

**Type consistency:** `normalizeFilamentConfig(configText, origCount, filaments)` defined+exported (T1), called in both export paths with `doc.origFilamentCount ?? doc.filaments.length`. `remapStates(mesh, mapFn)` (T2) called by `deleteColor` (T3). `deleteColor(s)` wired from the × chip with the swatch's state. `snap().filaments`/`restore` shape `{index, hex}` matches `doc.filaments`. `refreshFilamentUI` replaces `buildFilamentUI` with all call sites updated (T5). `clearHoverPreview`/`busy`/`pushHistory`/`stateColor`/`colorName`/`gatherStates` all exist in app.js.
