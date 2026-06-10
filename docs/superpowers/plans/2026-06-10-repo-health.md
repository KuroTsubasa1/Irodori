# Repo Health (W1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Split `js/cleanup.js` three ways behind the unchanged `Cleanup` namespace, move the tracked sample to `samples/`, add `.gitignore`/`package.json`/`CLAUDE.md`, and refresh the README — with zero behavior change (52 tests stay green).

**Architecture:** Each split file is an IIFE extending the shared global (`const Cleanup = (global.Cleanup = global.Cleanup || {})`); within-file calls stay direct, cross-file calls go through `Cleanup.<fn>` (resolved at call time, so only load order before first use matters). Load order: `paint → threemf → subgraph → select → cleanup → liepa → caps → split → viewer → app`.

**Tech Stack:** Vanilla JS (IIFE + globals), Node built-in test runner.

**Spec:** `docs/superpowers/specs/2026-06-10-repo-health-design.md`

**Conventions:** `node --test` must report **52 pass / 0 fail after every task**. Functions move **verbatim** (no logic edits beyond the cross-file call rewrites listed). Never stage the untracked root `.3mf`.

---

### Task 1: Split `js/cleanup.js` → `subgraph.js` + `select.js` + slim `cleanup.js`

**Files:**
- Create: `js/subgraph.js`, `js/select.js`
- Modify: `js/cleanup.js` (slim), `index.html` (script tags), `tests/harness.js` (load list)

- [ ] **Step 1: Read `js/cleanup.js` top to bottom** and confirm it contains exactly these functions (current order): `QSCALE`/`q` consts, `computeDominant`, `invalidateSub`, `buildSubGraph`, `floodAccept`, `selectRadius`, `selectBand`, `featureAxis`, `selectBandAxis`, `applyStates`, `floodComponent`, `removeIslandsSub`, `fillRegion`, `subSizes`, `selectColorRegion`, `mirrorMap`, `axisCenters`, `mirrorStamps`, `dist2PointTri`, `paintStamps`, `remapStates`, plus the `global.Cleanup = {...}` export. If anything differs materially, STOP and report.

- [ ] **Step 2: Create `js/subgraph.js`** — the cached graph core. File shape:

```javascript
/* subgraph.js — the cached sub-triangle adjacency graph and its statistics.
 *
 * Part of the `Cleanup` namespace (split across subgraph.js / select.js /
 * cleanup.js by responsibility; this file must load FIRST of the three).
 * The graph is cached on the mesh (mesh._sub); invalidateSub clears every
 * mesh-attached cache (_sub, _subSizes, _mirror, _axisCenters).
 */
(function (global) {
  "use strict";
  const Cleanup = (global.Cleanup = global.Cleanup || {});

  // ... moved verbatim: QSCALE + q, computeDominant, invalidateSub,
  //     buildSubGraph, floodComponent, subSizes ...

  Object.assign(Cleanup, {
    computeDominant,
    buildSubGraph,
    invalidateSub,
    subSizes,
    floodComponent, // shared with cleanup.js's removeIslandsSub
  });
})(window);
```
Move those six items (plus the two consts) **verbatim** from cleanup.js — they only call each other, so no call rewrites are needed (`subSizes` calls `buildSubGraph`/`floodComponent` same-file; keep direct calls).

- [ ] **Step 3: Create `js/select.js`** — read-only selection & symmetry queries:

```javascript
/* select.js — read-only selections over the sub-triangle graph: radius/band/
 * same-color floods, the ring feature axis, and mirror/symmetry queries.
 *
 * Part of the `Cleanup` namespace (loads after subgraph.js). Cross-file calls
 * (buildSubGraph) go through the shared namespace at call time.
 */
(function (global) {
  "use strict";
  const Cleanup = (global.Cleanup = global.Cleanup || {});

  // ... moved verbatim: floodAccept (stays private), selectRadius, selectBand,
  //     featureAxis, selectBandAxis, selectColorRegion, mirrorMap,
  //     axisCenters, mirrorStamps ...

  Object.assign(Cleanup, {
    selectRadius,
    selectBand,
    selectBandAxis,
    selectColorRegion,
    featureAxis,
    mirrorMap,
    axisCenters,
    mirrorStamps,
  });
})(window);
```
Call rewrites inside the moved functions: every `buildSubGraph(mesh)` becomes `Cleanup.buildSubGraph(mesh)` (8 occurrences: selectRadius, selectBand, featureAxis, selectBandAxis, selectColorRegion, mirrorMap, axisCenters — mirrorStamps calls `axisCenters` same-file, keep direct; `floodAccept` callers are same-file, keep direct).

- [ ] **Step 4: Slim `js/cleanup.js`** to the paint-mutating operations:

```javascript
/* cleanup.js — paint-MUTATING operations over the sub-triangle graph:
 * brush/ring writes (applyStates), stamp-refinement painting (paintStamps),
 * flood fill, small-island auto-clean, and whole-mesh state remaps.
 *
 * Part of the `Cleanup` namespace (loads after subgraph.js + select.js).
 * Cross-file calls (buildSubGraph, invalidateSub, floodComponent) go through
 * the shared namespace at call time.
 */
(function (global) {
  "use strict";
  const Cleanup = (global.Cleanup = global.Cleanup || {});

  // ... kept verbatim: applyStates, removeIslandsSub, fillRegion,
  //     dist2PointTri (private), paintStamps, remapStates ...

  Object.assign(Cleanup, {
    applyStates,
    removeIslandsSub,
    fillRegion,
    paintStamps,
    remapStates,
  });
})(window);
```
Call rewrites: `buildSubGraph(` → `Cleanup.buildSubGraph(` (in applyStates, removeIslandsSub, fillRegion, paintStamps — wherever present); `floodComponent(` → `Cleanup.floodComponent(` (removeIslandsSub); `invalidateSub(` → `Cleanup.invalidateSub(` (removeIslandsSub, paintStamps, remapStates). Delete the old monolithic `global.Cleanup = { ... }` export object entirely (each file now contributes via `Object.assign`).

- [ ] **Step 5: Update load lists.**
- `index.html`: replace the single `<script src="js/cleanup.js"></script>` with, in order: `js/subgraph.js`, `js/select.js`, `js/cleanup.js` (keeping the position between `js/threemf.js` and `js/liepa.js`).
- `tests/harness.js`: in the load array, replace `"js/cleanup.js"` with the three entries in the same order.

- [ ] **Step 6: Verify**

Run: `node --check js/subgraph.js && node --check js/select.js && node --check js/cleanup.js && node --test`
Expected: silent checks; **52 pass / 0 fail** (every moved function is exercised through the unchanged namespace).
Also run: `grep -n "floodAccept\|dist2PointTri\|floodComponent" js/*.js` — `floodAccept` only in select.js, `dist2PointTri` only in cleanup.js, `floodComponent` defined in subgraph.js and referenced as `Cleanup.floodComponent` in cleanup.js.
And: `wc -l js/subgraph.js js/select.js js/cleanup.js` — roughly 200 / 330 / 330; none above 400.

- [ ] **Step 7: Commit**
```bash
git add js/subgraph.js js/select.js js/cleanup.js index.html tests/harness.js
git commit -m "refactor: split Cleanup into subgraph/select/cleanup files (namespace unchanged)"
```

---

### Task 2: Hygiene — samples/, .gitignore, package.json

**Files:**
- Move: `Meshy_AI_Pikachu and the Red Ball.3mf` → `samples/`
- Create: `.gitignore`, `package.json`

- [ ] **Step 1:**
```bash
mkdir -p samples
git mv "Meshy_AI_Pikachu and the Red Ball.3mf" "samples/Meshy_AI_Pikachu and the Red Ball.3mf"
```

- [ ] **Step 2: Create `.gitignore`:**
```gitignore
# user working files and exports (keep tracked references in samples/)
/*.3mf

# verification artifacts
*.jpeg
.playwright-mcp/

.DS_Store
```

- [ ] **Step 3: Create `package.json`** (no `"type"` field — tests stay CommonJS, browser scripts unaffected):
```json
{
  "name": "irodori",
  "private": true,
  "description": "Browser-only 3MF multi-color paint repair and split tool",
  "scripts": {
    "test": "node --test"
  }
}
```

- [ ] **Step 4: Verify** — `npm test` → **52 pass / 0 fail**; `git status --short` shows NO untracked root `.3mf` (the user's `..._fixed.3mf` is now ignored, still on disk: confirm with `ls *.3mf`).

- [ ] **Step 5: Commit**
```bash
git add .gitignore package.json samples
git commit -m "chore: samples/ for the tracked reference; gitignore working files; npm test"
```

---

### Task 3: CLAUDE.md

**Files:**
- Create: `CLAUDE.md`

- [ ] **Step 1: Create `CLAUDE.md` with exactly this content:**

```markdown
# Irodori — 3MF Color Fixer

Browser-only tool for repairing and editing multi-color paint on Bambu/Prusa
`.3mf` files, and for splitting painted regions into watertight solids.
**Vanilla JS, no build step, no framework** — scripts are IIFEs attaching
globals to `window`; the `<script>` order in `index.html` is the dependency
graph. Keep it that way (no bundler/ESM migration).

## Run

- **App:** any static server, e.g. `python3 -m http.server 8000`. After
  editing files under `js/`, **restart the server on a NEW port** (or
  hard-reload): `http.server` + Chrome's heuristic caching serves stale
  modules and produces phantom "X is not a function" errors.
- **Tests:** `npm test` (= `node --test`). Node's built-in runner;
  `tests/harness.js` loads the browser IIFEs into a `vm` sandbox (with
  vendored three.js + poly2tri) and returns the globals. 52 tests.

## Hard rules

- **Never `Read` a `.3mf`** — they are 2 MB+ zipped XML and will flood your
  context. Inspect via `unzip -l/-p ... | grep`, or load through the pure
  parsers (`ThreeMF.parseMeshes` on an extracted `.model` text).
- The tracked reference model lives in `samples/`. **Untracked `.3mf` files at
  the repo root are the user's working files — leave them alone** (they are
  gitignored).
- Specs live in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/`
  — read the relevant one before extending a feature.

## Modules (`js/`, load order matters)

- `paint.js` — Bambu `paint_color` codec: recursive split trees per triangle.
  `Paint.tessellate` is THE geometry convention (corner rotation by `special`,
  midpoint splits, reversed kid order) — anything subdividing faces must match
  it exactly.
- `threemf.js` — `.3mf` zip load/export; `parseMeshes`/`rebuildModelFile`
  (multi-mesh round-trip via recorded offset ranges); filament config
  normalization (all filaments exported as "Generic PLA").
- `subgraph.js` / `select.js` / `cleanup.js` — one `Cleanup` namespace split
  by responsibility: the cached sub-triangle adjacency graph (`mesh._sub`;
  `invalidateSub` clears all mesh caches), read-only selections + symmetry
  queries, and paint-mutating operations (incl. `paintStamps`, the
  slicer-style stamp refinement run on brush release).
- `liepa.js` — Liepa hole filling (rim decimation → 3-D min-weight DP →
  fan strips → density refinement → fairing); the default cap method.
- `caps.js` — boundary-loop extraction and cap triangulation. The cap
  descriptor is `{ verts, extraPts, tris }`: triangle index `i < verts.length`
  → welded global vertex id `verts[i]`, else `extraPts[i - verts.length]`.
- `split.js` — watertight solids from sub-triangle sets. `solidFromSubs` and
  `remainderSolid` share ONE cut cap (the remainder reuses the part's cap
  reversed), so split parts and the remainder stay coincident.
- `viewer.js` — three.js scene, picking, explode animation, preview tints.
- `app.js` — UI glue: tools, palette, history (snapshot/undo), panels.

**Known debt:** `viewer.js` and `app.js` are each one closure over shared UI
state. Splitting them is a state refactor, not a file move — don't attempt it
casually.

## Conventions

- Paint "states" = filament indices; state 0 = the object's default extruder.
- Watertightness in tests = every undirected edge used exactly twice — this is
  **winding-blind**; winding is covered by the Liepa area-weighted regression.
- Mirror/symmetry centers derive from sub-centroid bounds (`axisCenters`) —
  live previews (`mirrorMap`) and final stamp reflection must agree.
- Verification screenshots (`*.jpeg`) and `.playwright-mcp/` are disposable
  and gitignored.
```

- [ ] **Step 2: Commit**
```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md orientation (run, rules, module map, conventions)"
```

---

### Task 4: README refresh

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read the current `README.md`.** Keep its title/branding, the "runs entirely in your browser" framing, and the **paint-codec documentation section** (the nibble-format explanation) verbatim. Replace any stale feature list/usage text with:

```markdown
## Features

- **Paint tools** — brush (slicer-grade edge refinement on release), ring
  (band wraps the local feature, axis follows the surface normal), and fill —
  each with an on-surface hover preview. X/Y/Z mirror painting, combinable.
- **Colors** — paint with the model's filaments, add new ones (exported as
  real sliceable filaments), delete added colors (undoable).
- **Auto-clean** — recolors small stray same-color patches to match their
  surroundings, with preview.
- **Split by color** — lift any connected colored region out as a watertight
  solid (selectable cap methods; Liepa smooth fill by default) and export all
  parts + the remainder as separate objects in one `.3mf`.
- **Scene** — objects panel with isolation view, multi-mesh `.3mf` round-trip,
  90° rotations, undo/redo, keyboard shortcuts (O/R/B/N/F/S).
- Exports normalize every filament to **Generic PLA**.

## Development

No build step — vanilla JS served statically:

    python3 -m http.server 8000     # then open http://localhost:8000

(After editing `js/`, restart on a new port or hard-reload — the browser
caches modules aggressively.)

    npm test                        # Node's built-in runner, 52 tests

The reference model lives in `samples/`. See `CLAUDE.md` for the module map
and contributor conventions.
```

- [ ] **Step 2: Commit**
```bash
git add README.md
git commit -m "docs: refresh README features + development section"
```

---

## Self-Review

**Spec coverage:** §1 CLAUDE.md → T3 (full content). §2 split + namespace + load order → T1. §3 samples/.gitignore/package.json → T2. §4 README → T4. Non-goals respected (no app/viewer split; no behavior change). All covered.

**Placeholder scan:** the `// ... moved verbatim ...` markers in T1 are move instructions naming exact functions (the code exists in-repo) — intentional for a refactor-move; everything else (gitignore, package.json, CLAUDE.md, README sections) is complete content.

**Type consistency:** the three-file export sets in T1 sum exactly to the current `Cleanup` export list plus `floodComponent`; cross-file rewrites name the precise call sites; load order in T1 step 5 matches the plan header's order and CLAUDE.md's module list (T3).
