# Brush Responsiveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Refine edges" toggle to the brush and eliminate the multi-second freeze at the start of a stroke by re-warming the sub-triangle graph under a spinner instead of lazily inside a mouse event.

**Architecture:** The brush's on-release refinement (`Cleanup.paintStamps`) subdivides geometry and invalidates `mesh._sub`; the graph is only eagerly rebuilt in `setTool`, so the next stroke rebuilds it synchronously inside `brushAt`. Task 1 adds a checkbox that, when off, commits the live-preview leaves via `Cleanup.applyStates` (state-only, never invalidates the graph). Task 2 extracts a `ensureSubGraphs()` helper and calls it right after every graph-invalidating op and as a safety net in `startStroke`, so rebuilds always happen under a visible spinner.

**Tech Stack:** Vanilla JS IIFEs on `window`, no build step. Tests via `node --test` (`npm test`) using `tests/harness.js`.

## Global Constraints

- No bundler / no ESM / no framework. Scripts are IIFEs attaching globals to `window`; `<script>` order in `index.html` is the dependency graph.
- Never `Read` a `.3mf`. Reference model is in `samples/`.
- Paint "states" = filament indices; state 0 = default extruder.
- After editing files under `js/`, restart the static server on a NEW port (Chrome caches stale modules).
- Spec: `docs/superpowers/specs/2026-07-07-brush-responsiveness-design.md`.

---

### Task 1: Refine-edges toggle

**Files:**
- Modify: `index.html` (brush panel, `data-panel="brush"`, around line 63-73)
- Modify: `js/app.js` (`endStroke`, lines 398-411)
- Test: `tests/refine.test.js` (create)

**Interfaces:**
- Consumes: `Cleanup.applyStates(mesh, subs, state) -> { changedFaces:Set, count }` (existing, `js/cleanup.js:37`); `Cleanup.paintStamps(mesh, stamps, state, {maxDepth}) -> { count, changedFaces:Set }` (existing).
- Produces: DOM element `#brushRefine` (checkbox, checked by default). New behavior branch in `endStroke`.

- [ ] **Step 1: Write the failing test**

Create `tests/refine.test.js`. It pins the invariant the refine-off path relies on: `applyStates` changes paint state without adding geometry, whereas `paintStamps` subdivides.

```js
const test = require("node:test");
const assert = require("node:assert");
const { loadModules, makeBigTriangle } = require("./harness");

function totalLeaves(Paint, mesh) {
  let n = 0;
  for (const p of mesh.paints) n += Paint.leafCount(Paint.decode(p));
  return n;
}

test("applyStates changes state without adding leaves (refine-off invariant)", () => {
  const { Paint, Cleanup } = loadModules();
  const mesh = makeBigTriangle();
  const g = Cleanup.buildSubGraph(mesh);
  const before = totalLeaves(Paint, mesh);
  // paint the first few leaves to a new state
  const subs = [0, 1, 2].filter((i) => i < g.NS);
  const res = Cleanup.applyStates(mesh, subs, 3);
  assert.ok(res.changedFaces.size > 0, "some face changed");
  assert.equal(totalLeaves(Paint, mesh), before, "no leaves added");
});

test("paintStamps subdivides (refine-on adds geometry)", () => {
  const { Paint, Cleanup } = loadModules();
  const mesh = makeBigTriangle();
  const g = Cleanup.buildSubGraph(mesh);
  const before = totalLeaves(Paint, mesh);
  // a small stamp near the centroid of sub 0 forces an edge-crossing split
  const cx = g.cen[0], cy = g.cen[1], cz = g.cen[2];
  const res = Cleanup.paintStamps(mesh, [{ x: cx, y: cy, z: cz, r: 0.01 }], 3, { maxDepth: 4 });
  assert.ok(res.changedFaces.size > 0, "some face changed");
  assert.ok(totalLeaves(Paint, mesh) > before, "leaves added by subdivision");
});
```

- [ ] **Step 2: Run test to verify it passes already (it documents existing behavior)**

Run: `npm test -- --test-name-pattern="refine-off invariant"`
Expected: PASS (this is a characterization test; `applyStates` and `paintStamps` already exist). If the second test does not add leaves, increase the stamp radius slightly (e.g. `r: 0.05`) until it straddles a leaf edge — the point is only to confirm the two paths differ.

- [ ] **Step 3: Add the checkbox to `index.html`**

In the `data-panel="brush"` block, after the Mirror `<div class="axes" id="symAxes">…</div>` and before the panel's closing `</div>` (around line 72), add:

```html
          <label class="check" id="brushRefineWrap"><input type="checkbox" id="brushRefine" checked /><span>Refine edges (crisper, slower)</span></label>
```

- [ ] **Step 4: Branch `endStroke` on the checkbox in `js/app.js`**

Replace the body of `endStroke` (currently lines 398-411) with:

```js
  function endStroke() {
    if (!stroke) return;
    const m = doc.meshes[stroke.mi], stamps = stroke.stamps, pend = stroke.pend;
    stroke = null;
    if (!stamps.length) return;
    if (!$("brushRefine").checked) {
      // refine off: commit the whole-leaf live preview (state-only, no subdivision)
      const res = Cleanup.applyStates(m, [...pend], paintState);
      if (!res.changedFaces.size) { render(null); return; } // painted same-over-same
      pushHistory("Brush");
      render(null);
      updateStats();
      return;
    }
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

Note: `stroke.pend` already holds the local sub-triangles painted during the drag (including mirror expansion — see `brushAt`, lines 385-395), so `applyStates` reproduces the coarse preview exactly.

- [ ] **Step 5: Manual browser verification**

Run a static server on a fresh port: `python3 -m http.server 8123`. Load a `.3mf`, pick the Brush, uncheck "Refine edges", paint a stroke. Expected: NO "Refining stroke…" toast; paint commits instantly as whole leaves; painting several strokes in a row stays snappy. Re-check the box; a stroke shows "Refining stroke…" and crisp edges as before.

- [ ] **Step 6: Commit**

```bash
git add index.html js/app.js tests/refine.test.js
git commit -m "feat: add brush refine-edges toggle (off = whole-leaf, no subdivision)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Sub-graph re-warm (stroke-start lag fix)

**Files:**
- Modify: `js/app.js` (`setTool` lines 320-334; `doRotate` ~353-359; plane-cut block ~562; `startStroke` ~363-368; remove-color `busy` block ~243-251)

**Interfaces:**
- Consumes: `Cleanup.buildSubGraph(mesh)` (existing, caches `mesh._sub`); `busy(msg, fn)` (existing, `js/app.js:104`).
- Produces: `ensureSubGraphs(msg?)` — builds `_sub` for every cold mesh under a `busy` spinner; no-op when all warm.

- [ ] **Step 1: Add the `ensureSubGraphs` helper in `js/app.js`**

Add just above `setTool` (before line 320):

```js
  // Warm the sub-triangle graph for every mesh that lost it (paint ops that
  // subdivide invalidate it). Runs under a spinner so the rebuild never blocks
  // a mouse event at the start of the next stroke.
  function ensureSubGraphs(msg) {
    if (doc && doc.meshes.some((m) => !m._sub)) {
      busy(msg || "Preparing tool…", () => { for (const m of doc.meshes) Cleanup.buildSubGraph(m); });
    }
  }
```

- [ ] **Step 2: Route `setTool`'s inline build through the helper**

In `setTool`, replace the existing block (lines 330-332):

```js
    if (doc && (paintTool || name === "split") && doc.meshes.some((m) => !m._sub)) {
      busy("Preparing tool…", () => { for (const m of doc.meshes) Cleanup.buildSubGraph(m); });
    }
```

with:

```js
    if (doc && (paintTool || name === "split")) ensureSubGraphs("Preparing tool…");
```

- [ ] **Step 3: Re-warm inside `doRotate`**

In `doRotate` (lines 353-359), after the render/frame calls, add a warm so the next paint interaction finds the graph ready. Change the tail of `doRotate` to:

```js
    computeModelSize();
    render(null);
    Viewer.frame();
    ensureSubGraphs("Preparing tool…");
```

(Insert the `ensureSubGraphs` line as the last statement of `doRotate`, after `Viewer.frame();` at line 359.)

- [ ] **Step 4: Re-warm after a plane cut**

In the plane-cut `busy` block, after `updateCutPlane();` (around line 572) and before the closing `toast(...)`, add:

```js
      ensureSubGraphs("Preparing tool…");
```

- [ ] **Step 5: Re-warm after remove-color**

In the "Removing color…" `busy` block (starts line 243), after its `pushHistory("Delete color")` (line 251) and its following `render`/`updateStats`, add `ensureSubGraphs("Preparing tool…");` as the last statement of the callback. (Read lines 243-255 first to place it after the existing epilogue calls.)

- [ ] **Step 6: Safety-net warm in `startStroke`**

`startStroke` (lines 363-368) is the last line of defense for any invalidating op not covered above (e.g. undo/redo `restore`). Change it to warm before the first `brushAt`:

```js
  function startStroke(hit) {
    if (paintState == null) return;
    if (previewActive) { restore(current()); previewActive = false; }
    ensureSubGraphs("Preparing tool…");
    stroke = { mi: hit.meshIndex, pend: new Set(), stamps: [] };
    brushAt(hit);
  }
```

- [ ] **Step 7: Manual browser verification**

Static server on a fresh port. Load a large `.3mf`. With "Refine edges" ON, paint a stroke, release, then immediately start another stroke. Expected: any rebuild shows a "Preparing tool…" toast rather than an unexplained multi-second freeze before paint appears; subsequent strokes with a warm graph are instant. Repeat after a rotate and after an undo — the first stroke afterwards must not freeze silently.

- [ ] **Step 8: Run the full test suite**

Run: `npm test`
Expected: all tests pass (this task is app.js glue; no module tests change).

- [ ] **Step 9: Commit**

```bash
git add js/app.js
git commit -m "fix: re-warm sub-graph under spinner so strokes don't freeze at start

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** A (toggle) → Task 1; B (extract `ensureSubGraphs`, re-warm at invalidating ops + `startStroke` safety net) → Task 2. Both covered.
- **Type consistency:** `ensureSubGraphs(msg)` defined once (Task 2 Step 1) and called with the same signature everywhere. `applyStates` no-op check uses `res.changedFaces.size` (the field the function returns), not `res.count` (which is `subs.length` and would misfire).
- **No placeholders:** every code step shows the full replacement.
