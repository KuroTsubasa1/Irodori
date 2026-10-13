# Volumetric Split — design

**Date:** 2026-10-13
**Status:** Approved in conversation; awaiting written-spec review.

## Problem

The Split tool produces knife-edge lenses (surface patch + cap) and keeps
them as an *overlay*: `splitParts` is a list of sub-triangle index sets over
an unchanged mesh, every part's cap is built in isolation, and the
"remainder" is a viewer illusion (unclaimed sub-triangles plus the parts'
caps reversed, drawn as separate objects). Consequences the user hits:

1. **Parts are unprintable** — no wall thickness; the earlier
   minimum-thickness plug (`75033b5`, reverted in `e8e273a`) self-intersected
   on thin features, was still too thin to be a "piece", and the remainder
   never matched it.
2. **Re-splitting breaks** in every form: a second region touching the
   first (two independent Liepa caps bulge into each other along the shared
   seam); painting then re-splitting (any brush stroke renumbers
   sub-triangles, stored parts go stale — nothing guards this); splitting
   after a plane cut (Cut produces real meshes, Split drags them back into
   the overlay); splitting the remainder (it is not a mesh).

## Goal

A split part is a **solid piece that reassembles** with the remainder: the
painted patch plus an inward wall and a bottom, and the remainder gets the
exactly matching pocket. Parts and remainder are ordinary document meshes,
so every other tool (paint, Cut, Split again) works on them unchanged.

## Decisions (from brainstorming)

- Approach **A**: Split becomes a real document operation (like Cut) with
  depth-limited plugs. Rejected: a vendored WASM boolean (Manifold) —
  robust but a ~1.5 MB binary dependency, a second load path for the Node
  harness, and it refuses non-manifold input; and patching the overlay —
  cheap but still knife-edge lenses.
- Click applies immediately (no place-then-adjust): the plug is hidden
  inside the model, nothing to judge visually; undo is one step.
- Depth is a user value in mm; per-vertex clamp at **half** the local
  thickness.
- **Revised in task 6 (real data):** the first implementation (per-rim-vertex
  offset + Liepa cap of the offset loop + a `t = 0` "shell" fallback + pinch
  refusal) refused *every* region of the sample model. The bottom is now the
  **displaced patch** ("skin") on a spatially smooth displacement field; see
  *Why not a cap* below. The `Cap method` dropdown no longer affects Split
  (`opts.method` is accepted and ignored).

## Geometry — `Split.plugSolids(mesh, subs, opts)` (js/split.js)

`opts = { depth }`. Returns `{ part, remainder, info }` — two document
meshes `{ positions, nf, v1, v2, v3, paints }` (the app sets
`part.part = { label, state }`)
— or `{ error }` with a user-facing reason. `info = { halvings, shell:
false, faces }` (`shell` is kept for the app's toast and is always false).

### Shared conformed surface

Both meshes come from one conformed surface of every sub-triangle
(`conformedSurface(g)`, cached on the sub graph: refined leaves become real
triangles; a sub whose edges carry T-junction midpoints is fanned from its
centroid, which gets its own id). Patch and remainder index the same ids, so
the rim is welded by construction. No boundary loops are extracted.

### Displacement field (`plugField`, exported for tests as `Split.plugField`)

Every patch vertex `q` (welded vertices and T-junction centroids) moves to
`q + s(q)·D(q)`.

- **Direction** `D = −normalize(Σ w·N)`: area-weighted patch vertex normals
  accumulated into voxels (cell `R/3`, ≤ 2·10⁶ cells), summed with the kernel
  `w = (1 − d²/R²)²` over voxel centroids within `R = max(2·depth, 10⁻³·diag)`.
  If the normals cancel, the vertex's own normal. `D` is smooth in *space*,
  which is what keeps `s·|∇D| < 1` on fractal rims (0.004 mm rim edges vs a
  3 mm depth: the old per-vertex normal had a Lipschitz constant of ~2600 on
  the sample and tangled the offset curve). For a region small against `R`,
  `D` is constant — a cookie-cutter extrusion.
- **Depth** `s_raw = min(depth, 0.5 · t_hit) · τ`. `t_hit`: ray cast along `D`
  against the parent faces, back-face hits only, `t > 10⁻⁴·diag` (unchanged
  from v1). `τ = clamp((tr − 0.2) / 0.3, 0, 1)` with `tr` the least
  `−n_f · D` over **every** sub incident to the vertex — both sides of the
  rim — so the plug never slides along a face (a wall in a vertical gable
  plane, a skin hugging a sharp crease).
- **Lipschitz envelope** `s(q) = min_p (s_raw(p) + 0.5 · geodesic(p, q))`
  (Dijkstra over the patch graph), so the skin cannot fold onto itself and
  tapers (slope ≤ 0.5) into zero-depth zones.

### Plug geometry (`buildPlug`, per depth scale)

- **Welding:** a vertex with `s·scale ≤ snap = 10⁻⁴·diag` keeps its surface
  id. A patch triangle with three welded vertices is **cancelled** — it has no
  thickness; it moves to the remainder unchanged (keeping its leaf color)
  instead of being doubled by its skin. An *interior* edge with both ends
  welded whose two triangles both keep a deep vertex would be shared by the
  patch and both skins (edge used 4×, a zero-thickness "pinch line"); its
  ends are un-welded to the snap depth, iterated until none is left.
- **Per-wedge skin vertices:** around each vertex, patch triangles are
  grouped into wedges (fans connected through edges at that vertex). Each
  wedge gets its own skin copy, so a **pinch vertex** (the region touching
  itself — 1–13 per fractal rim on the sample) yields two coincident copies
  and both outputs stay edge-manifold.
- **Wall:** for each rim edge (an edge of exactly one patch triangle) `u→v`
  in that triangle's winding, `(v, u, u')` and `(v, u', v')`, skipping
  triangles with a welded (repeated) id.
- **Skin:** every non-cancelled patch triangle `(a, b, c)` → `(a', c', b')`.
- Part = kept patch + wall + skin; remainder = rest of the surface +
  cancelled patch + wall reversed + skin reversed.

### Why not a cap (v1's bottom)

Measured on the sample: Liepa's endpoint fans fold on weaving chains and its
120-vertex coarse polygon spans the loop's fjords (1,000–64,000 crossing
pairs per region even after smoothing the offset); earcut on a best-fit
projection drops edges because the belly rim self-crosses 347 times in
projection (4 at the best of 400 sampled directions); the centroid fan
crosses the walls too. Any triangulation that uses only rim vertices of such
a loop must fold. The skin reuses the patch's own triangulation, which is
fold-free by construction when the field is Lipschitz.

Consequences: a cross-section region (top + upper half of a box's sides)
becomes a uniform-depth **cup** instead of a lens; a closed **pocket**
becomes a **liner** (no longer refused); a large depth on a small feature
degrades towards the cookie-cutter (`D` constant, faces parallel to `D` get
no depth).

### Colors

Patch and remainder surface triangles keep their leaf states (one solid
paint string per triangle; cancelled patch triangles keep theirs in the
remainder). Wall and skin: the part's state in the part;
`majorityBorderColor` in the remainder.

## Robustness — refuse rather than ship garbage

- **Self-intersection gate** of wall + skin triangles against each other and
  against the original faces (grid-bucketed). Pairs sharing a vertex (copies
  of one source vertex count as shared) are tested exactly: edge-adjacent →
  only a flat fold overlaps (`MeshGeo.foldedPair`); vertex-adjacent → the far
  edge of one piercing the other (`MeshGeo.segTriCross`); otherwise Möller
  (`triTriIntersect`, with a scale-relative on-plane epsilon — the absolute
  one reported near-parallel separated 0.005 mm triangles as crossing).
  **Contact tolerance** `tol = 10⁻³·diag` (≈ 0.06 mm on the 63 mm sample,
  below print resolution): a triangle whose vertices all lie within `tol` of
  the surface is surface (not tested against the mesh or other such
  triangles), and a crossing whose *penetration* (smallest push along either
  plane normal that separates the pair) is ≤ `tol` is contact. On any
  intersection: halve the scale and rebuild, up to 4 times; then refuse.
  There is no shell fallback any more.
- **Watertight gate** on both outputs (unchanged): `MeshGeo.checkClosed === 0`
  and `MeshGeo.signedVolume > 0`; otherwise nothing is applied and the error
  carries `info`. Toast *"Couldn't make a clean solid here (region too thin
  or sharp for a plug)"*.
- **Refusals** (`{ error }`): `subs` covers the whole mesh → *"That's the
  whole object"*; empty region → *"Nothing to split there"*; depth ≤ 0 →
  *"Set a split depth greater than 0"*. **Pinch is no longer refused**
  (per-wedge copies, above).

## Tool flow (js/app.js, index.html)

- Hover: existing same-color region tint (no `claimed` exclusion any more).
- Click: `Split.plugSolids(mesh, subs, { depth, method })` under `busy`;
  on success replace `doc.meshes[i]` with `[remainder, part]`, set
  `doc.synthetic = true`, `pushHistory("Split")`, rebuild, `buildObjects`,
  `ensureSubGraphs`. On `{ error }`: toast, no history entry.
- Panel: `Depth` — `<input type=number id="splitDepth">` (mm, step 0.1)
  linked to a range; default 3, min 0.3, max `modelSize / 2` (set on load).
  Existing `Cap method` select stays (app.js still passes it) but, since
  task 6, Split ignores it — the bottom is the skin, not a cap; the select
  is now dead UI for Split (follow-up: hide or relabel it). Hint text: *"Click a colored region to lift
  it out as a solid part."*
- Removed guards: *"Export or undo your split parts before cutting"* and the
  export dialog's dependence on `splitParts`.

## Viewer and layout (js/viewer.js)

- `mesh.part = { label, state }`; `label = "Part N · <color name>"` assigned at
  split time (N = count of part meshes + 1). Cut halves copy `part` from
  their source so a cut part stays a part.
- **Display-only row layout:** `Viewer.build` computes, for meshes with
  `part`, a per-mesh offset from the existing `Split.layoutParts(bodyBox,
  partBoxes, margin)` where `bodyBox` is the union AABB of non-part meshes,
  applied to those meshes' vertices in the render buffer (positions only —
  picking maps back through the same offset so paint/split on a part keeps
  working). Export stays coincident. If every mesh is a part (cannot happen
  via Split — the remainder is never flagged — but can after cutting away
  the remainder) the first mesh is treated as the body.
- Removed: `remainderCapObjs`, `setSplitParts`, `claimedSets` / the
  `claimed` parameter of `build`, `partObject`, `pinPart`, `setPartVisibility`
  (per-mesh visibility covers it). Objects panel lists parts by label.
- Isolating a part is the existing per-mesh isolate; `Viewer.frame` frames
  the mesh at its laid-out (offset) position, so `pinPart` is unnecessary.

## Export (js/threemf.js)

`doc.synthetic` already routes to `exportGenerated`, which writes every mesh
as its own object; part labels become object names. Removed: `exportSplit`,
`Split.remainderSolid`, `Split.solidFromSubs`, `Split.majorityBorderColor`
becomes internal, the `split` export format and its chip in the dialog.

## History

Snapshots already store `meshList` + `synthetic` (plane cut needs it).
`mesh.part` rides along with the mesh object. No history changes.

## Tests (tests/, Node harness)

- **Flat-face plug:** gridded box, region = central top block, depth 0.5 →
  both outputs closed, volumes 2 + 62, skin at `z = 3.5`, no halving.
- **Far-wall clamp:** 4×4×0.5 slab, depth 10 → `s = 0.25`, part volume 1.
- **plugField:** flat interior → `D = −z`, `s = depth`; slab → `s = 0.25`;
  ridge gable edges (vertical faces parallel to `D`) → `s = 0`.
- **Cross-section region:** box top + upper half of the sides, depth 1 →
  a cup, nothing below the rim plane, volumes sum to 64.
- **Convex ridge stays clean:** roof prism, upper half of both slopes → no
  halving, closed, volumes sum to 12.
- **Through-groove / pocket** (64-sub refined paint — the coarse fixtures put
  every vertex on a crease): liners, closed, volumes sum to 48 / 56.
- **Pinch:** a region touching itself at a vertex splits, closed.
- **Staircase rim on a curved surface** (`makeHeightBox`, the belly's failure
  class: v1 refused it with `halvings 4, shell true`) → clean at full depth.
- **Welded crease line:** sharp V-notch inside the region → no 4× edges.
- **Refusals:** whole mesh, empty, depth 0.
- **Chained** split → split on remainder → plane cut; **refined paint**.
- **Sample model** (`tests/sample.test.js`, ~20 s): belly (seed 490285,
  depth 3), an ear tip and the neck band → closed, positive, volume-exact.
- Browser (Playwright, sample model): belly plug; ear-tip split; neck band
  split; paint over a part then split it again; undo chain; export opens
  with N objects.

## Non-goals

- No boolean library; no true "through-cut" when the depth exceeds the
  local thickness (the half-thickness clamp stands in for it).
- No collision-aware layout; no change to Cut's UI.
- Residual non-manifold edges on fractal paint rims that already fail the
  watertight gate are refused, not repaired.
