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
  vendored three.js + poly2tri) and returns the globals. 98 tests.

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
- `meshgeo.js` — pure geometry: cached bounds, directed closed-surface check,
  Möller tri–tri test, face grid + inward ray cast (`rayHit`, back-face only).
- `split.js` — volumetric split: `plugSolids(mesh, subs, {depth})` →
  `{ part, remainder, info }` as real document meshes. The part is a skin
  plug: top = the painted patch, bottom = the patch displaced along a
  spatially smooth inward field D (kernel-smoothed patch normal) by
  s = min(depth, ½·thickness along D) · τ — τ the transversality ramp of D
  against every incident sub — then a geodesic Lipschitz envelope (slope ≤
  0.5) so the skin cannot fold; one wall quad per rim edge. The remainder
  gets the reversed wall/skin (matching pocket). Only the AFFECTED faces
  (region + T-junction closure) are re-triangulated; every other face keeps
  its original triangle, vertex ids and `paint_color`. Gate: toleranced
  intersection test (contact tol = min(1e-3·diag, 0.05 mm)), then closed +
  positive volume; otherwise refused. `info.wraps` (patch Euler
  characteristic ≠ 1 after filling paint specks) drives the "wraps around"
  warning. Parts carry `mesh.part = { seq, state }`; the name is derived by
  `partLabel` in app.js. The viewer lays parts out in a row (display-only
  offsets), export stays coincident.
- `planecut.js` — geometric plane cut (`cutMesh`): exact triangle clipping
  with per-edge welded section points, section chords from clipped triangles
  AND from on-plane mesh edges, flat earcut caps wound ±n. Cutting sets
  `doc.synthetic`, which routes export through the generated package (the
  original XML can no longer be spliced).
- `viewer.js` — three.js scene, picking (`pick` returns the model `point` + display `world`), row layout of parts via display-only offsets, preview tints.
- `app.js` — UI glue: tools, palette, history (snapshot/undo), panels.

**Known debt:** `viewer.js` and `app.js` are each one closure over shared UI
state. Splitting them is a state refactor, not a file move — don't attempt it
casually.

## Conventions

- Paint "states" = filament indices; state 0 = the object's default extruder.
- Watertightness in tests = every undirected edge used exactly twice — this is
  **winding-blind**. `MeshGeo.checkClosed` is the directed (winding-aware)
  closed test; `MeshGeo.signedVolume` > 0 checks the orientation.
- Mirror/symmetry centers derive from sub-centroid bounds (`axisCenters`) —
  live previews (`mirrorMap`) and final stamp reflection must agree.
- Verification screenshots (`*.jpeg`) and `.playwright-mcp/` are disposable
  and gitignored.
