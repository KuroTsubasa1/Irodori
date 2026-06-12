# Smart Fill (Batch M) — Design

**Date:** 2026-06-12
**Status:** Shipped (Batch M).

## Problem

The fill tool floods the connected **same-color** region — good for repair,
useless for painting raw geometry, where everything is one state and a click
floods the whole shell. Slicers solve this with "smart fill": grow from the
clicked face and stop at sharp creases, ignoring paint.

User choices: fill gets **two modes — Color | Smart** (Color = today's
behavior, unchanged, default); Smart is **crease-bounded, ignores paint,
paints the active palette color**, with an **angle slider 1–90°, default
30°** (slicer parity). Height-band fill **deferred**. Approach: **face-level
flood** (regions are sets of parent faces; boundaries are face edges), chosen
over a sub-level gated flood for exact semantics, smaller graph, and free
paint-tree collapse.

## 1 · Face graph (`js/subgraph.js`)

`Cleanup.faceGraph(mesh)` — lazy CSR adjacency over **parent faces** plus
per-face unit normals, cached as `mesh._faceG`:

- Edge keys from undirected vertex-index pairs of `(v1,v2) (v2,v3) (v3,v1)`
  (mesh indices are already welded by the 3MF parser / planecut). Each key
  maps to the list of faces sharing it; **all pairs** are connected, so
  non-manifold edges don't orphan regions. Open (boundary) edges simply have
  no pair.
- `faceN: Float32Array(nf*3)` — normalized `cross(b−a, c−a)`; degenerate
  faces keep `(0,0,0)`.
- `invalidateSub` additionally clears `mesh._faceG` — one invalidation story,
  same as `_mirror`/`_axisCenters`. The rebuild is geometry-only and runs at
  most once per smart-fill hover/click after a paint change (bounded,
  click-time hitch on 200k-face meshes; acceptable).

## 2 · Selection (`js/select.js`)

`Cleanup.selectSmartFaces(mesh, seedFace, angleDeg)` — read-only flood over
`faceGraph`. Edge `(f,g)` is crossable iff `dot(n̂f, n̂g) ≥ cos(angleDeg)`
**and both normals are nonzero** (the explicit guard matters at θ=90°, where
`cos θ = 0` and a degenerate `(0,0,0)` normal would otherwise pass). The
threshold is inclusive: a face pair at exactly θ is crossed. Returns
`Int32Array` of member faces (always contains `seedFace`).

The seed comes from the pick: `buildSubGraph(mesh).subFace[hit.localSub]`.

## 3 · Mutation (`js/cleanup.js`)

`Cleanup.paintFacesSolid(mesh, faces, state)` — for each face
`mesh.paints[f] = Paint.encode({leaf: true, state})` (`""` for state 0) and
`mesh.dom[f] = state` when the dominant cache exists, then
`invalidateSub(mesh)`. Note the contrast with `fillRegion`, which writes
leaf states **without** collapsing precisely so the cached sub graph stays
valid: collapsing to solid leaves changes the sub-triangle structure, so
invalidation here is mandatory, and the next hover pays one bounded graph
rebuild (§1). That cost buys the collapse: smart fill leaves cleaner paint
than it found. Returns the face count.

## 4 · UI (`index.html`, `js/app.js`)

The `data-panel="fill"` options strip gains mode chips **[Color | Smart]**
(same chip pattern as `symAxes`/`cutAxes`; Color active by default):

- **Color** — exactly today's UI and behavior: Auto checkbox shown,
  `doFill` → `Cleanup.fillRegion` untouched.
- **Smart** — Auto hidden; an angle slider `1–90°` step 1, default 30°,
  with a live `≤ N°` readout. Click → `doSmartFill(hit)`:
  `selectSmartFaces` from the hit's parent face, then
  `paintFacesSolid(m, faces, paintState)` — always the active palette color
  (Auto does not apply). The region always contains the seed (§2), so a
  valid pick always paints; one undo step via the existing snapshot path,
  same as `doFill`. If the region is already uniformly `paintState`, skip
  the history entry (no-op fill, parity with `fillRegion`'s no-op filter).

Mode and angle are session state only (not persisted, not exported).
Keyboard shortcut **F** and fill-parity navigation are unchanged.

## 5 · Hover preview

Smart mode reuses the shared split/ring/fill hover-preview cache, keyed by
`(mesh, seed sub, mode, angle)` so slider drags retint live. Faces expand to
sub-triangles for tinting via one pass over `subFace` with a `Uint8Array(nf)`
membership mask (subs are emitted per-face in order; O(NS), allocation-light).
The tinted set is exactly the set a click paints.

## 6 · Edge cases

- **Open edges** end the flood (no neighbor) — no special casing.
- **Degenerate faces** are never crossed into or out of (zero normal guard).
- **Non-manifold edges** connect all sharing faces (no dropped regions).
- **Split-claimed subs are NOT excluded**, matching color fill (app.js
  `doFill` comment "no claimed-exclusion") — fills are paint ops, not splits.
- **Multi-mesh docs:** operates on the hit mesh only, like every paint tool.
- Smart fill **does not mirror** (no fill tool does; symmetry stays
  brush-only).

## 7 · Testing (`tests/`, vm harness)

- **Cube (12 tris):** θ=30° from any face selects exactly its coplanar
  partner pair; θ=90° selects all 12 (inclusive threshold pinned).
- **Bent strip** (two planar bands meeting at a known dihedral): flood
  crosses at θ above the bend angle, stops below it.
- **Collapse:** a face carrying a split paint code, smart-filled to state 1,
  ends with `paints[f] === "4"` and `Paint.solidState` agreeing.
- **Degenerate guard:** a zero-area face adjacent to the seed is not
  selected at θ=90°.
- **Parity:** preview expansion of the member faces equals the subs whose
  `subFace` is in the region, before and after a prior brush stroke
  fragmented the area.
- Existing **62 tests stay green** (notably: `invalidateSub` clearing the
  new cache must not break paint flows).

## Out of scope

Height-band fill (deferred by choice), fill symmetry, combined color+angle
gating, persisting mode/angle.
