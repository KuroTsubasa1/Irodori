# Repo Health (W1) — Design

**Date:** 2026-06-10
**Status:** Approved (ready for implementation plan)

## Summary

The dedicated pass for the round-1 complaints "files are getting too big" and
"context fills quickly": a `CLAUDE.md` orientation file, a three-way
responsibility split of `js/cleanup.js` (789 lines) that **preserves the
`Cleanup` global namespace** (zero consumer changes), sample/hygiene moves, a
`package.json` test script, and a README refresh. **No behavior changes** —
pure moves and documentation; the 52-test suite is the regression guard.

## 1 · CLAUDE.md

Concise orientation for future sessions:

- What the project is (browser-only `.3mf` paint repair; vanilla JS, IIFE +
  `window` globals, **no build step** — keep it that way).
- How to run: static server for the app (with the **fresh-port/stale-cache
  gotcha** spelled out), `npm test` → `node --test` (vm-sandbox harness,
  52 tests).
- Hard rules: **never `Read` a `.3mf`** (2 MB+ zipped XML — the original
  context killer; inspect via `unzip -p` + targeted greps or the pure
  parsers); user working files may sit untracked at the repo root — leave
  them.
- Module map (one line each + load-order note) and the load-bearing
  conventions: the paint-codec tree (`Paint.tessellate` is THE geometry
  convention), the cap descriptor (`{verts: global welded ids, extraPts,
  tris}` indexing), paint "states" = filament indices (0 = default), the
  cached sub-graph contract (`mesh._sub`, `invalidateSub` clears all caches),
  watertight tests are edge-count based (winding-blind) with winding covered
  by the Liepa area-weighted regression.
- Known debt: `app.js`/`viewer.js` are single closures over shared UI state —
  splitting them is a state refactor, deliberately deferred.
- Where specs/plans live; read the relevant one before extending a feature.

## 2 · Split `js/cleanup.js` → three files, one namespace

Mechanical moves (functions verbatim), each file attaching to the shared
global: `global.Cleanup = Object.assign(global.Cleanup || {}, { ... })`.
Cross-file internal calls go through the `Cleanup` namespace at call time, so
load order only matters before first use. Script order (in `index.html` and
`tests/harness.js`): `subgraph.js → select.js → cleanup.js` (after `paint.js`,
before `caps.js`).

| File | Functions (moved verbatim) | Private helpers kept with them |
|---|---|---|
| `js/subgraph.js` (new) | `buildSubGraph`, `invalidateSub`, `computeDominant`, `subSizes`, `floodComponent` (newly exported on the namespace — needed across files) | `QSCALE`/`q` quantization |
| `js/select.js` (new) | `selectRadius`, `selectBand`, `selectBandAxis`, `selectColorRegion`, `featureAxis`, `mirrorMap`, `axisCenters`, `mirrorStamps` | `floodAccept` |
| `js/cleanup.js` (slimmed, ~330) | `applyStates`, `removeIslandsSub`, `fillRegion`, `paintStamps`, `remapStates` | `dist2PointTri` |

The exported API surface of `Cleanup` is unchanged except for the added
`floodComponent`; all five consumer files and every test keep working without
edits (verified by the suite).

## 3 · Hygiene

- `git mv "Meshy_AI_Pikachu and the Red Ball.3mf" samples/` (the tracked
  2.1 MB reference). Future browser verification fetches
  `/samples/Meshy_AI_Pikachu and the Red Ball.3mf`.
- New `.gitignore`: root `*.3mf` (the user's untracked working files stop
  appearing as clutter, stay on disk), `*.jpeg` (verification screenshots),
  `.playwright-mcp/`, `.DS_Store`.
- New `package.json`: `{ "name": "irodori", "private": true, "scripts":
  { "test": "node --test" } }` — **no `"type"` field** (tests stay CommonJS;
  browser scripts unaffected).

## 4 · README refresh

Bring the feature list current (paint/ring/fill with previews, slicer-grade
brush refinement, X/Y/Z mirror, color add/delete, auto-clean, split-by-color
with selectable cap methods — Liepa default, objects panel + isolation,
multi-mesh round-trip, Generic-PLA export, shortcuts) and add a Development
section (serve, test, samples path, no-build constraint). The existing
paint-codec documentation section is kept.

## Non-goals

- No `app.js`/`viewer.js` split (closure-state refactor — documented as debt).
- No bundler, ESM migration, or framework.
- No behavior or test changes (beyond load-list updates in the harness).

## Testing

- `node --test` stays **52 pass / 0 fail** after the split (the suite
  exercises every moved function through the unchanged `Cleanup` namespace).
- `git status` clean of screenshot/`.3mf` clutter after the hygiene step;
  `npm test` works.
- Browser smoke (script order changed): load the sample from `samples/`,
  paint a stroke, split a region — no console errors.
- Grep checks: no references to moved private helpers across file boundaries;
  consumer `Cleanup.*` call counts unchanged.
