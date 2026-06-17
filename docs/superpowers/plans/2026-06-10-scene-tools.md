# Scene Tools (Batch C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Load every object/mesh in a `.3mf` (multi-mesh) with a correct round-trip, add an Objects panel listing all meshes + split parts, and an isolation view that shows one object and recenters.

**Architecture:** Two pure, Node-tested helpers (`parseMeshes`, `rebuildModelFile`) replace the first-mesh-per-file slicing. The viewer gains a build-subset filter (rebuild with only visible meshes — picking offsets stay valid since skipped meshes get zero-width ranges) + a `frame(object?)`. `app.js` owns the Objects panel + isolation state.

**Tech Stack:** Vanilla JS (IIFE + globals), three.js, JSZip (call-time), Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-06-10-scene-tools-design.md`

**Conventions:** After each task: `node --check <changed .js>` + `node --test`. Suite is **28** before this batch; Task 1 adds tests (→ **30**). Browser-verify via `python3 -m http.server 8123` + the reference `.3mf`; a multi-object file can be produced via the Split tool's "Export split" (after Task 2 the loader reads its multiple objects). Stage only named files; never the `.3mf`.

---

### Task 1: `parseMeshes` + `rebuildModelFile` (pure, Node-tested)

**Files:**
- Modify: `js/threemf.js` (add both functions; export them)
- Create: `tests/multimesh.test.js`

- [ ] **Step 1: Write the failing tests** — create `tests/multimesh.test.js`:

```javascript
const test = require("node:test");
const assert = require("node:assert");
const { loadModules } = require("./harness");

const TWO_MESH = `<model><resources>
 <object id="1"><mesh>
  <vertices>
   <vertex x="0" y="0" z="0"/>
   <vertex x="1" y="0" z="0"/>
   <vertex x="0" y="1" z="0"/>
  </vertices>
  <triangles>
   <triangle v1="0" v2="1" v3="2"/>
  </triangles>
 </mesh></object>
 <object id="2"><mesh>
  <vertices>
   <vertex x="5" y="5" z="5"/>
   <vertex x="6" y="5" z="5"/>
   <vertex x="5" y="6" z="5"/>
  </vertices>
  <triangles>
   <triangle v1="0" v2="1" v3="2" paint_color="4"/>
  </triangles>
 </mesh></object>
</resources></model>`;

test("parseMeshes finds every mesh in a file", () => {
  const { ThreeMF } = loadModules();
  const ms = ThreeMF.parseMeshes(TWO_MESH, "x.model");
  assert.equal(ms.length, 2);
  assert.equal(ms[0].nv, 3); assert.equal(ms[0].nf, 1);
  assert.equal(ms[1].nv, 3); assert.equal(ms[1].nf, 1);
  assert.equal(ms[1].paints[0], "4");
  assert.equal(ms[0].paints[0], "");
});

test("rebuildModelFile updates one mesh in place and preserves the rest", () => {
  const { ThreeMF } = loadModules();
  const ms = ThreeMF.parseMeshes(TWO_MESH, "x.model");
  ms[0].positions[0] = 9; // change mesh-0 first vertex x
  const out = ThreeMF.rebuildModelFile(TWO_MESH, ms);
  assert.ok(out.includes('x="9"'), "mutated coord written");
  assert.ok(out.includes('x="6"'), "mesh-1 vertex preserved");
  assert.ok(out.includes('paint_color="4"'), "mesh-1 paint preserved");
  assert.equal((out.match(/<mesh>/g) || []).length, 2, "both meshes present");
  assert.equal(ThreeMF.parseMeshes(out, "x").length, 2, "re-parses to 2 meshes");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/multimesh.test.js`
Expected: FAIL — `ThreeMF.parseMeshes is not a function`.

- [ ] **Step 3: Implement** — add to `js/threemf.js` (after `parseMeshFromModel`; `fnum` is already defined below — move/keep it accessible, it is module-scoped so it's fine):

```javascript
  // Parse EVERY <mesh> in a .model file. Each result records the inner offset
  // ranges of its <vertices> and <triangles> so the file can be rebuilt.
  function parseMeshes(text, path) {
    const meshes = [];
    const vre = /<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g;
    const tre = /<triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"(?:\s+paint_color="([^"]*)")?\s*\/>/g;
    let from = 0;
    for (;;) {
      const meshIdx = text.indexOf("<mesh>", from);
      if (meshIdx === -1) break;
      const meshEnd = text.indexOf("</mesh>", meshIdx);
      const scope = meshEnd === -1 ? text.length : meshEnd;
      const vOpen = text.indexOf("<vertices>", meshIdx);
      if (vOpen === -1 || vOpen > scope) { from = meshIdx + 6; continue; }
      const vInner = vOpen + "<vertices>".length;
      const vEnd = text.indexOf("</vertices>", vInner);
      const tOpen = text.indexOf("<triangles>", vEnd);
      const tInner = tOpen + "<triangles>".length;
      const tClose = text.indexOf("</triangles>", tInner);
      const vBlock = text.slice(vInner, vEnd);
      const xs = []; let m; vre.lastIndex = 0;
      while ((m = vre.exec(vBlock))) xs.push(+m[1], +m[2], +m[3]);
      const tBlock = text.slice(tInner, tClose);
      const i1 = [], i2 = [], i3 = [], paints = []; tre.lastIndex = 0;
      while ((m = tre.exec(tBlock))) { i1.push(+m[1]); i2.push(+m[2]); i3.push(+m[3]); paints.push(m[4] || ""); }
      meshes.push({
        path, positions: new Float32Array(xs), nv: xs.length / 3, nf: i1.length,
        v1: Int32Array.from(i1), v2: Int32Array.from(i2), v3: Int32Array.from(i3), paints,
        vRange: [vInner, vEnd], tRange: [tInner, tClose],
      });
      from = tClose === -1 ? scope : tClose;
    }
    return meshes;
  }

  // Rebuild a .model file's text: splice each mesh's regenerated <vertex>/
  // <triangle> lines into its recorded ranges, back-to-front so offsets stay valid.
  function rebuildModelFile(text, fileMeshes) {
    const edits = [];
    for (const mesh of fileMeshes) {
      const P = mesh.positions;
      const vlines = new Array(mesh.nv);
      for (let i = 0; i < mesh.nv; i++) { const o = i * 3; vlines[i] = '     <vertex x="' + fnum(P[o]) + '" y="' + fnum(P[o + 1]) + '" z="' + fnum(P[o + 2]) + '"/>'; }
      const tlines = new Array(mesh.nf);
      for (let i = 0; i < mesh.nf; i++) { const p = mesh.paints[i]; const base = '     <triangle v1="' + mesh.v1[i] + '" v2="' + mesh.v2[i] + '" v3="' + mesh.v3[i] + '"'; tlines[i] = p ? base + ' paint_color="' + p + '"/>' : base + "/>"; }
      edits.push({ s: mesh.vRange[0], e: mesh.vRange[1], content: "\n" + vlines.join("\n") + "\n    " });
      edits.push({ s: mesh.tRange[0], e: mesh.tRange[1], content: "\n" + tlines.join("\n") + "\n    " });
    }
    edits.sort((a, b) => b.s - a.s); // back-to-front
    let out = text;
    for (const ed of edits) out = out.slice(0, ed.s) + ed.content + out.slice(ed.e);
    return out;
  }
```

and add both to the export: `global.ThreeMF = { load, exportZip, exportSplit, extendFilamentConfig, parseMeshes, rebuildModelFile };`

- [ ] **Step 4: Run to verify pass**

Run: `node --test`
Expected: PASS — **30 pass / 0 fail**.

- [ ] **Step 5: Commit**

```bash
git add js/threemf.js tests/multimesh.test.js
git commit -m "feat(load): multi-mesh parse + file-rebuild helpers (pure, tested)"
```

---

### Task 2: Wire multi-mesh into `load` + `exportZip`

**Files:**
- Modify: `js/threemf.js` (`load`, `exportZip`)

- [ ] **Step 1: `load` uses `parseMeshes` + stores raw file texts.** Replace the mesh-collection block (the `const modelFiles = ...; for (const mf ...) { parseMeshFromModel } ` loop) with:
```javascript
    // every .model file: collect ALL its meshes; keep raw text for round-trip
    const modelFiles = zip.file(/\.model$/i);
    const meshes = [];
    const files = {};
    for (const mf of modelFiles) {
      const txt = await mf.async("string");
      files[mf.name] = txt;
      for (const mesh of parseMeshes(txt, mf.name)) if (mesh.nf > 0) meshes.push(mesh);
    }
```
and add `files` to the returned object:
```javascript
    return { zip, filaments, defaultExtruder, meshes, files, origFilamentCount: filaments.length };
```
(`parseMeshFromModel` is now unused — leave it or delete it; deleting is cleaner. If you delete it, confirm nothing else references it.)

- [ ] **Step 2: `exportZip` rebuilds per file.** Replace the `for (const mesh of doc.meshes) { ... doc.zip.file(mesh.path, newText); }` loop with a per-file rebuild:
```javascript
    const byPath = new Map();
    for (const mesh of doc.meshes) { let a = byPath.get(mesh.path); if (!a) byPath.set(mesh.path, a = []); a.push(mesh); }
    for (const [path, fileMeshes] of byPath) {
      const base = (doc.files && doc.files[path]) || null;
      if (base != null) doc.zip.file(path, rebuildModelFile(base, fileMeshes));
    }
```
Leave the filament-config-extension block and `generateAsync` below it unchanged.

- [ ] **Step 3: Syntax + regression**

Run: `node --check js/threemf.js && node --test`
Expected: no syntax output; **30 pass / 0 fail**.

- [ ] **Step 4: Browser-verify (single-mesh round-trip must still work)**

Load the reference `.3mf`, paint a stroke, Export. Reload the app and load the exported `_fixed.3mf` → it loads, the painted stroke is present, face count matches. (Confirms the new round-trip is correct for the single-mesh case.)

- [ ] **Step 5: Commit**

```bash
git add js/threemf.js
git commit -m "feat(load): load all meshes per file; per-file round-trip export"
```

---

### Task 3: Viewer — visible-mesh subset, part visibility, frame(object)

**Files:**
- Modify: `js/viewer.js`

- [ ] **Step 1: Add visibility state.** Near `let claimedSets = [];` add:
```javascript
  let visibleMeshes = null; // Set<meshIndex> to render, or null = all
```

- [ ] **Step 2: Honor it in `build`.** In `build`, the per-mesh emit loop is `for (let mi = 0; mi < doc.meshes.length; mi++) { ... }`. Right after `meshSubOffset[mi] = t;` add a skip for hidden meshes so they contribute zero rendered subs (picking offsets stay valid because the range is empty):
```javascript
      if (visibleMeshes && !visibleMeshes.has(mi)) { continue; }
```
(Place it after `meshSubOffset[mi] = t;` and before `let origLocal = 0;`. The pre-count loop above can keep counting all meshes — `positions` is trimmed by `subarray(0, usedTris*9)`, so an oversized temp alloc is harmless.)

- [ ] **Step 3: `frame(object)` can target a specific object.** Replace `function frame() { ... }` with:
```javascript
  function frame(obj) {
    const src = (obj && obj.geometry && obj.geometry.boundingSphere) ? obj.geometry.boundingSphere
      : (geom ? geom.boundingSphere : null);
    if (!src) return;
    const c = src.center, r = src.radius || 50;
    controls.target.copy(c);
    const dir = new THREE.Vector3(0.5, -1.0, 0.45).normalize();
    camera.position.copy(c).add(dir.multiplyScalar(r * 2.6));
    camera.near = r / 100; camera.far = r * 100;
    camera.updateProjectionMatrix();
    controls.update();
  }
```

- [ ] **Step 4: Add visibility setters + part bounds accessor + export them.** Add these functions (e.g. near `setSplitParts`):
```javascript
  function setVisibleMeshes(set) { visibleMeshes = set; }
  // Show only the split parts whose id is in idSet (null = show all parts).
  function setPartVisibility(idSet) {
    for (const o of splitObjs) o.mesh.visible = !idSet || idSet.has(o.id);
    for (const m of remainderCapObjs) m.visible = !idSet; // caps only make sense with the main mesh
  }
  // The THREE.Mesh of the split part with the given id (for framing on it).
  function partObject(id) { const o = splitObjs.find((x) => x.id === id); return o ? o.mesh : null; }
```
Add `setVisibleMeshes, setPartVisibility, partObject` to the `global.Viewer = { ... }` export.

- [ ] **Step 5: Syntax + regression**

Run: `node --check js/viewer.js && node --test`
Expected: no syntax output; **30 pass / 0 fail**.

- [ ] **Step 6: Browser-verify (deferred to Task 4 — needs the panel to drive it).** No standalone check.

- [ ] **Step 7: Commit**

```bash
git add js/viewer.js
git commit -m "feat(viewer): visible-mesh subset, part visibility, frame(object)"
```

---

### Task 4: Objects panel + isolation (app + html + css)

**Files:**
- Modify: `index.html` (Objects card)
- Modify: `js/app.js` (panel build + isolation state + wiring)
- Modify: `css/style.css` (panel rows)

- [ ] **Step 1: Add the Objects card to `index.html`.** After the Load `<section>` in `#left`, add:
```html
          <section class="card" id="objectsCard" hidden>
            <h2>Objects</h2>
            <ul id="objectsList"></ul>
            <button id="showAllBtn" class="ghost slim" hidden style="margin-top:8px">Exit isolation</button>
          </section>
```

- [ ] **Step 2: App isolation state + panel builder (`js/app.js`).** Near the other tool state (e.g. by `let splitParts = [];`) add:
```javascript
  let isolated = null; // { kind:"mesh", index } | { kind:"part", id } | null
```
Add a panel builder + an applier. Place near `buildPalette`:
```javascript
  function buildObjects() {
    const ul = $("objectsList");
    ul.innerHTML = "";
    doc.meshes.forEach((m, i) => {
      const li = document.createElement("li");
      li.className = "objrow";
      const nm = document.createElement("span"); nm.className = "fname"; nm.textContent = "Object " + (i + 1);
      const ct = document.createElement("span"); ct.className = "fcount"; ct.textContent = m.nf.toLocaleString();
      nm.addEventListener("click", () => isolate({ kind: "mesh", index: i }));
      ct.addEventListener("click", () => isolate({ kind: "mesh", index: i }));
      li.append(nm, ct);
      ul.appendChild(li);
    });
    splitParts.forEach((p) => {
      const li = document.createElement("li");
      li.className = "objrow";
      const sw = document.createElement("span"); sw.className = "swatch"; sw.style.background = stateColor(p.state);
      const nm = document.createElement("span"); nm.className = "fname"; nm.textContent = colorName(p.state) + " part";
      nm.addEventListener("click", () => isolate({ kind: "part", id: p.id }));
      li.append(sw, nm);
      ul.appendChild(li);
    });
    $("showAllBtn").hidden = !isolated;
  }
  function isolate(target) {
    isolated = target;
    if (target.kind === "mesh") {
      Viewer.setVisibleMeshes(new Set([target.index]));
      Viewer.setPartVisibility(new Set()); // hide all parts
      render(null);
      Viewer.frame();
    } else { // part
      Viewer.setVisibleMeshes(new Set()); // hide all main meshes
      Viewer.setPartVisibility(new Set([target.id]));
      render(null);
      Viewer.frame(Viewer.partObject(target.id));
    }
    buildObjects();
  }
  function showAll() {
    isolated = null;
    Viewer.setVisibleMeshes(null);
    Viewer.setPartVisibility(null);
    render(null);
    Viewer.frame();
    buildObjects();
  }
```
Note: `render(null)` calls `rebuildView` → `Viewer.build` + `Viewer.setSplitParts`. After build, `setPartVisibility` must be re-applied because `setSplitParts` recreates the part meshes (all visible by default). So in `isolate`/`showAll`, call `Viewer.setPartVisibility(...)` **after** `render(null)` (reorder the two lines above so `render(null)` precedes `setPartVisibility`). Apply that ordering.

- [ ] **Step 3: Wire it up (`js/app.js`).** In `loadFile`, after the doc loads and other panels are revealed (where `["filamentCard","cleanCard",...].forEach(... hidden=false)` runs), add `"objectsCard"` to that list and call `buildObjects();` after `buildPalette();`. Reset isolation on load: set `isolated = null;` and `Viewer.setVisibleMeshes(null); Viewer.setPartVisibility(null);` in `loadFile` before the first `render`. Rebuild the panel when splits change: at the end of `doSplit` (after `render(null)`) and in `showAll`, call `buildObjects()`. Wire the button: `$("showAllBtn").addEventListener("click", showAll);`

- [ ] **Step 4: Style the rows (`css/style.css`).** Add:
```css
#objectsList { list-style: none; margin: 6px 0 0; padding: 0; }
#objectsList .objrow { display: flex; align-items: center; gap: 11px; padding: 7px 6px; border-radius: 9px; cursor: pointer; transition: background .15s; }
#objectsList .objrow:hover { background: var(--card-2); }
```

- [ ] **Step 5: Syntax + regression**

Run: `node --check js/app.js && node --test`
Expected: no syntax output; **30 pass / 0 fail**.

- [ ] **Step 6: Browser-verify**

Single-mesh: load the reference `.3mf` → Objects card shows "Object 1". Click it → view recenters on it (no other mesh to hide). Split a region → a "… part" row appears; click it → only that part shows, recentered; "Exit isolation" → all shown, refit.
Multi-object: use the Split tool's **Export split** to make a multi-object `.3mf`, load it → Objects lists multiple meshes; isolate one (others hide + recenter); paint only affects it; toggle back with "Exit isolation". No console errors.

- [ ] **Step 7: Commit**

```bash
git add index.html js/app.js css/style.css
git commit -m "feat(scene): Objects panel + isolation view"
```

---

## Self-Review

**Spec coverage:** Multi-mesh load + round-trip → Tasks 1 (helpers) + 2 (wiring). Objects panel → Task 4. Isolation (visible subset + recenter + part visibility) → Tasks 3 (viewer) + 4 (app). All spec items mapped.

**Placeholder scan:** No TBD/TODO; every code step has complete code; test/check commands have expected counts; browser steps concrete (incl. how to obtain a multi-object file).

**Type/name consistency:** `parseMeshes`/`rebuildModelFile` defined+exported+tested (T1), consumed in `load`/`exportZip` (T2); meshes carry `path`/`vRange`/`tRange`/`positions`/`v1..v3`/`paints`/`nv`/`nf`; `doc.files[path]` produced in `load` and read in `exportZip`. `Viewer.setVisibleMeshes`/`setPartVisibility`/`partObject`/`frame(obj)` defined+exported (T3) and called in `app.js` `isolate`/`showAll` (T4). `splitObjs` entries carry `id` (from Batch A) used by `setPartVisibility`/`partObject`. `isolated` shape `{kind, index|id}` consistent across `isolate`/`buildObjects`/`showAll`.
