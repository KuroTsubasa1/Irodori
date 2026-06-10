# Quick UX Wins (Batch A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Six small UX improvements to the Irodori 3MF tool — fix split re-animation, add a split hover preview, retune brush size, Alt-to-orbit while brushing, center the tool options, and tool keyboard shortcuts.

**Architecture:** Targeted edits to existing files (`js/app.js`, `js/viewer.js`, `js/cleanup.js`-adjacent, `css/style.css`, `index.html`). No new module; no file is large enough to split yet.

**Tech Stack:** Vanilla JS (IIFE + `window` globals, no build step), three.js, Node built-in test runner for the regression guard.

**Spec:** `docs/superpowers/specs/2026-06-10-quick-ux-wins-design.md`

**Conventions for every task:**
- Batch A is browser/DOM/WebGL wiring → no new Node tests. After each task: `node --check <changed .js>` (syntax) and `node --test` (must stay **25 pass / 0 fail** — regression guard that the tested modules are untouched). Then the browser verification listed in the task. Then commit.
- Browser verification = serve statically (`python3 -m http.server 8123`) and load `Meshy_AI_Pikachu and the Red Ball.3mf`. (The controller drives this via Playwright during subagent execution.)
- Stage only the files named in each commit (never the untracked `.3mf`).

---

### Task 1: Retune brush & ring size

**Files:**
- Modify: `js/app.js` (the `brushRadius`, `ringHalf`, `sizeDotPx` definitions)
- Modify: `index.html` (the `#brushSize` slider default)

- [ ] **Step 1: Edit `js/app.js`** — replace the brush/ring radius helpers (currently `const brushRadius = () => (+$("brushSize").value / 100) * modelSize * 0.15 + modelSize * 0.004;` and the matching `ringHalf`) with quadratic curves:

```javascript
  const brushRadius = () => { const t = (+$("brushSize").value) / 100; return modelSize * (0.0015 + 0.06 * t * t); };
  const ringHalf = () => { const t = (+$("ringThick").value) / 100; return modelSize * (0.001 + 0.04 * t * t); };
```

And replace `const sizeDotPx = (v) => Math.round(6 + (v / 100) * 34);` with a matching quadratic so the UI swatch tracks the curve:

```javascript
  const sizeDotPx = (v) => { const t = v / 100; return Math.round(5 + t * t * 33); };
```

- [ ] **Step 2: Edit `index.html`** — bump the brush slider default so the default brush is usable. Change `<input type="range" id="brushSize" min="1" max="100" value="16" />` to `value="40"`.

- [ ] **Step 3: Syntax + regression**

Run: `node --check js/app.js && node --test`
Expected: no syntax output; **25 pass / 0 fail**.

- [ ] **Step 4: Browser-verify**

Load the model, pick **Brush**, set the slider to its minimum, hover the model: the surface cursor ring is small (a fine dot, clearly smaller than before). Slide to max: the ring grows smoothly. Paint a stroke at min size → a small patch.

- [ ] **Step 5: Commit**

```bash
git add js/app.js index.html
git commit -m "feat(brush): quadratic size curve for finer small brushes; bump default"
```

---

### Task 2: Tool keyboard shortcuts (O/R/B/N/F/S)

**Files:**
- Modify: `js/app.js` (the `keydown` listener)
- Modify: `index.html` (tool button `title` attributes)

- [ ] **Step 1: Edit the `keydown` listener in `js/app.js`.** It currently handles only undo/redo. Replace it with:

```javascript
  document.addEventListener("keydown", (e) => {
    if (!doc) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); doRedo(); return; }
    // tool shortcuts: modifier-free, ignored while typing in a field
    if (mod || e.altKey) return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    const tool = { o: "orbit", r: "rotate", b: "brush", n: "ring", f: "fill", s: "split" }[e.key.toLowerCase()];
    if (tool) { e.preventDefault(); setTool(tool); }
  });
```

- [ ] **Step 2: Edit `index.html`** — add the key to each tool button's `title`:
  - Orbit: `title="Orbit (O) — look around"`
  - Rotate: `title="Rotate (R) / orient the model"`
  - Brush: `title="Brush (B) — paint by dragging"`
  - Ring: `title="Ring (N) — wrap a colored band"`
  - Fill: `title="Fill (F) a same-color region"`
  - Split: `title="Split (S) a color into its own solid"`

- [ ] **Step 3: Syntax + regression**

Run: `node --check js/app.js && node --test`
Expected: no syntax output; **25 pass / 0 fail**.

- [ ] **Step 4: Browser-verify**

Load the model. Press `b` → Brush activates; `s` → Split; `o` → Orbit; `r`,`n`,`f` likewise. Click into the patch-size number field and type digits → tools do NOT switch. Press ⌘Z → still undoes (not hijacked).

- [ ] **Step 5: Commit**

```bash
git add js/app.js index.html
git commit -m "feat(tools): mnemonic keyboard shortcuts (O/R/B/N/F/S)"
```

---

### Task 3: Center the tool-options strip

**Files:**
- Modify: `css/style.css` (`#optionsbar`, `.palette`)

- [ ] **Step 1: Edit `css/style.css`.** In the `#optionsbar` rule (currently `display: flex; align-items: center; gap: 16px; min-height: 54px; ...`), add `justify-content: center;`. In the `.palette` rule (currently `display: flex; gap: 7px; align-items: center; margin-left: auto;`), **remove** `margin-left: auto;` so the palette flows inline with the centered option group.

- [ ] **Step 2: Regression**

Run: `node --test`
Expected: **25 pass / 0 fail** (CSS-only change; tests unaffected).

- [ ] **Step 3: Browser-verify**

Load the model. For each tool, its options group (and the palette, for paint tools) is horizontally **centered** under the toolbar, not pushed to the left/right edges.

- [ ] **Step 4: Commit**

```bash
git add css/style.css
git commit -m "feat(ui): center the tool-options strip under the toolbar"
```

---

### Task 4: Hold Alt to orbit while brushing

**Files:**
- Modify: `js/viewer.js` (`setTool`, `init` pointer/key handling)

- [ ] **Step 1: Add an `altOrbit` flag.** Near the other interaction state at the top of the viewer IIFE (e.g. by `let toolMode = "orbit"`), add:

```javascript
  let altOrbit = false; // Alt held in paint mode -> temporary left-drag orbit
```

- [ ] **Step 2: Reset it in `setTool`.** At the top of `setTool(mode)` (right after `toolMode = mode;`), add `altOrbit = false;` so switching tools always starts from a clean state.

- [ ] **Step 3: Gate the paint pointerdown on `!altOrbit`.** In `init`, the `pointerdown` listener starts a stroke with `if (toolMode === "paint" && e.button === 0 && paintCb)`. Change that condition to `if (toolMode === "paint" && e.button === 0 && paintCb && !altOrbit)`.

- [ ] **Step 4: Add Alt key listeners** (in `init`, near the other `window.addEventListener` calls):

```javascript
    window.addEventListener("keydown", (e) => {
      if (e.key === "Alt" && toolMode === "paint" && !altOrbit) {
        altOrbit = true;
        controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
        renderer.domElement.style.cursor = "grab";
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.key === "Alt" && altOrbit) {
        altOrbit = false;
        if (toolMode === "paint") {
          controls.mouseButtons.LEFT = null;
          renderer.domElement.style.cursor = "crosshair";
        }
      }
    });
```

- [ ] **Step 5: Syntax + regression**

Run: `node --check js/viewer.js && node --test`
Expected: no syntax output; **25 pass / 0 fail**.

- [ ] **Step 6: Browser-verify**

Load the model, pick **Brush**. Hold **Alt** and left-drag → the view orbits and NO paint happens. Release Alt and left-drag → paints. Right-drag still orbits.

- [ ] **Step 7: Commit**

```bash
git add js/viewer.js
git commit -m "feat(brush): hold Alt to orbit without leaving the Brush tool"
```

---

### Task 5: Fix split re-animation (stable per-part id)

**Files:**
- Modify: `js/app.js` (`splitSeq` counter, `doSplit`, `snap`, `restore`)
- Modify: `js/viewer.js` (`setSplitParts` position carry-over)

- [ ] **Step 1: Add an id counter in `js/app.js`.** Near `let splitParts = [];`, add:

```javascript
  let splitSeq = 0; // stable id per split part (for animation carry-over)
```

- [ ] **Step 2: Stamp the id in `doSplit`.** Change the push from `splitParts.push({ meshIndex: hit.meshIndex, subs, state: hit.state, method: $("capMethod").value });` to:

```javascript
    splitParts.push({ id: splitSeq++, meshIndex: hit.meshIndex, subs, state: hit.state, method: $("capMethod").value });
```

- [ ] **Step 3: Carry the id through history.** In `snap()`, the `splits:` map currently maps to `{ meshIndex, subs, state, method }` — add `id: p.id`:

```javascript
      splits: splitParts.map((p) => ({ id: p.id, meshIndex: p.meshIndex, subs: Int32Array.from(p.subs), state: p.state, method: p.method })),
```

In `restore(state)`, the `splitParts =` rebuild — add `id: p.id`:

```javascript
    splitParts = state.splits.map((p) => ({ id: p.id, meshIndex: p.meshIndex, subs: Int32Array.from(p.subs), state: p.state, method: p.method }));
```

- [ ] **Step 4: Carry over positions in `js/viewer.js setSplitParts`.** Read the current `setSplitParts`. Apply three changes:

(a) At the very top of the function, **before** `clearSplitObjs()`, snapshot existing positions by id:
```javascript
    const prevById = new Map();
    for (const o of splitObjs) if (o.id != null) prevById.set(o.id, o.cur);
```
(b) Where each part body is pushed (currently `splitObjs.push({ mesh, target, cur: new THREE.Vector3() });`), reuse the prior position for existing ids so only new parts animate from center:
```javascript
      const cur = prevById.get(p.id) || new THREE.Vector3();
      mesh.position.copy(cur);
      splitObjs.push({ id: p.id, mesh, target, cur });
```
(Keep the existing `root.add(mesh);` and the remainder-cap-mesh lines as they are.)

- [ ] **Step 5: Syntax + regression**

Run: `node --check js/app.js && node --check js/viewer.js && node --test`
Expected: no syntax output; **25 pass / 0 fail**.

- [ ] **Step 6: Browser-verify**

Load the model, **Split**. Click the red tail orb → it animates outward. Then click the red forehead orb → the forehead orb animates out **while the tail orb stays put** (does not re-explode). Undo → the last part returns; the other stays put.

- [ ] **Step 7: Commit**

```bash
git add js/app.js js/viewer.js
git commit -m "fix(split): stable per-part id so adding a split doesn't re-animate the others"
```

---

### Task 6: Split hover preview

**Files:**
- Modify: `js/viewer.js` (`setPreview`/`clearPreview`, reset on build, export)
- Modify: `js/app.js` (`setTool` hover enable, `onHover` split branch, clear on split/tool-change)

- [ ] **Step 1: Add preview recolor to `js/viewer.js`.** Near the top of the IIFE add state:
```javascript
  let previewSubs = null; // global sub indices tinted for the split hover preview
  const PREVIEW = new THREE.Color("#1fe3ff").convertSRGBToLinear();
```
Add these two functions (e.g. next to `paintSubs`):
```javascript
  // Tint the given global sub-triangles for the split hover preview.
  function setPreview(globalSubs) {
    if (!colorAttr) return;
    clearPreview();
    const colors = colorAttr.array;
    for (const gi of globalSubs) {
      if (gi < 0) continue;
      const o = gi * 9;
      for (let k = 0; k < 9; k += 3) { colors[o + k] = PREVIEW.r; colors[o + k + 1] = PREVIEW.g; colors[o + k + 2] = PREVIEW.b; }
    }
    previewSubs = globalSubs;
    colorAttr.needsUpdate = true;
  }
  // Restore the previewed subs to their real state colors.
  function clearPreview() {
    if (!colorAttr || !previewSubs) return;
    const colors = colorAttr.array;
    for (const gi of previewSubs) {
      if (gi < 0) continue;
      const col = linColor(triState[gi]);
      const o = gi * 9;
      for (let k = 0; k < 9; k += 3) { colors[o + k] = col.r; colors[o + k + 1] = col.g; colors[o + k + 2] = col.b; }
    }
    previewSubs = null;
    colorAttr.needsUpdate = true;
  }
```
In `build(...)`, reset the stale pointer when the geometry is rebuilt — add `previewSubs = null;` right after the new `colorAttr` is assigned (near `colorAttr = new THREE.BufferAttribute(...)`).
Add both to the `global.Viewer = { ... }` export object: `setPreview, clearPreview,`.

- [ ] **Step 2: Enable hover for Split + add the preview handler in `js/app.js`.**

In `setTool`, change `Viewer.enableHover(name === "brush" || name === "ring");` to:
```javascript
    Viewer.enableHover(name === "brush" || name === "ring" || name === "split");
```
Immediately after the `Viewer.enableHover(...)` line in `setTool`, clear any stale preview when leaving Split:
```javascript
    if (name !== "split") clearSplitPreview();
```

Add the preview cache + clear helper near the other tool state (e.g. by `let lastHit = null;`):
```javascript
  let previewCache = null; // { meshIndex, members:Set<localSub>, globalSubs }
  function clearSplitPreview() { if (previewCache) { Viewer.clearPreview(); previewCache = null; } }
```

Update `onHover(hit)` to handle Split first. Replace the current `function onHover(hit) { ... }` body's opening so it reads:
```javascript
  function onHover(hit) {
    lastHit = hit;
    if (activeTool === "split") {
      Viewer.hideCursor();
      if (!hit || hit.localSub == null) { clearSplitPreview(); return; }
      if (previewCache && previewCache.meshIndex === hit.meshIndex && previewCache.members.has(hit.localSub)) return;
      clearSplitPreview();
      const m = doc.meshes[hit.meshIndex];
      const subs = Cleanup.selectColorRegion(m, hit.localSub);
      const members = new Set(subs);
      const g = [];
      for (const s of subs) { const gi = Viewer.toGlobalSub(hit.meshIndex, s); if (gi >= 0) g.push(gi); }
      Viewer.setPreview(g);
      previewCache = { meshIndex: hit.meshIndex, members, globalSubs: g };
      return;
    }
    if (!hit) { Viewer.hideCursor(); return; }
    if (activeTool === "brush") {
```
(Leave the existing brush/ring branches that follow unchanged.)

In `doSplit(hit)`, clear the preview at the very start (after the `previewActive` restore line):
```javascript
    clearSplitPreview();
```

- [ ] **Step 3: Syntax + regression**

Run: `node --check js/app.js && node --check js/viewer.js && node --test`
Expected: no syntax output; **25 pass / 0 fail**.

- [ ] **Step 4: Browser-verify**

Load the model, **Split**. Hover the red tail orb → it tints cyan (the region that would lift out). Move within the orb → stays tinted, no flicker. Move onto the yellow body → the body tints (orb un-tints). Move off the model → tint clears. Click the orb → it splits (and the tint is gone). No console errors; hovering large regions is responsive (re-floods only when the region changes).

- [ ] **Step 5: Commit**

```bash
git add js/app.js js/viewer.js
git commit -m "feat(split): hover preview highlights the region that would lift out"
```

---

## Self-Review

**Spec coverage:** (1) split re-animation → Task 5. (2) hover preview → Task 6. (3) brush size → Task 1. (4) Alt-orbit → Task 4. (5) center options → Task 3. (6) shortcuts → Task 2. All six spec items map to a task.

**Placeholder scan:** No TBD/TODO; every step has exact code/edits and the exact `node --check`/`node --test` commands with expected output. Browser-verify steps are concrete.

**Type/name consistency:** `splitSeq`/`p.id` (Task 5) are produced in `doSplit`/`snap`/`restore` and consumed in `setSplitParts` via `prevById`/`o.id`. `Viewer.setPreview`/`Viewer.clearPreview` (Task 6) are defined + exported in viewer.js and called from app.js; `clearSplitPreview`/`previewCache` are app-local and used consistently in `setTool`/`onHover`/`doSplit`. `altOrbit` (Task 4) is declared once and read in `setTool`/pointerdown/key listeners. Tool names passed to `setTool` (orbit/rotate/brush/ring/fill/split) match the shortcut map (Task 2) and the existing toolbar `data-tool` values.
