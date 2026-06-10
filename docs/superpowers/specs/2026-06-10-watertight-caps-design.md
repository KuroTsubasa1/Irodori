# Watertight Caps — Design

**Date:** 2026-06-10
**Status:** Approved (ready for implementation plan)

## Summary

Replace Irodori's single-anchor "centroid fan" cap with proper **boundary-loop
extraction** and **four selectable cap methods** — Earcut, CDT, Projected-normal,
Centroid — so split parts export **watertight and manifold**. Cap both the lifted
part *and* the hole it leaves in the remaining mesh from **one shared cut surface**
(triangulated once per region, reused reversed), both **live in the viewer** and on
**export**.

CDT uses a vendored **poly2tri**; the other three need no new dependency (Earcut is
`THREE.ShapeUtils.triangulateShape`, already in the vendored three.js).

### Why

The split-by-color feature (see `2026-06-10-split-by-color-design.md`) lifts a
connected same-color region of leaf sub-triangles out as its own solid via
`Split.solidFromSubs`. That function conforms T-junctions so the *surface* is
manifold, then caps the open boundary by **fanning every boundary edge to one
global centroid anchor**. That anchor fan is the root of the remaining defects:

- For a **non-planar** boundary loop, fanning to one point self-intersects.
- For **multiple** boundary loops, a single shared anchor is simply wrong (and
  creates non-manifold apex edges — the prior spec's documented "~40 residual"
  pinch points).
- The **remainder** mesh's hole is capped the same crude way at export (anchored at
  the *whole remainder's* centroid, far away) and **not capped at all live** — so a
  visible hole is left where each region was lifted.

This workstream (W2) fixes capping. It does not touch the other queued workstreams.

## Goals

- Extract **ordered, oriented boundary loops** from a region's open boundary
  (replacing the flat boundary-edge list).
- **Four selectable cap methods**, all sharing one best-fit-plane projection:
  Centroid, Projected-normal, Earcut (with holes), CDT (with holes, poly2tri).
- Cap the lifted part and the remainder hole from **one shared cut surface**, so the
  two bodies are coincident, reassemble exactly, and are each watertight.
- Cap the remainder hole **live in the viewer**, not only on export.
- **Default Earcut.** Switching the method **re-caps all current parts** (to
  compare). Method is **stored per part** so undo/redo stays faithful.
- Exported parts: **0 non-manifold edges on simple loops**; **enclosed-island holes
  stay holes** (not filled over).

## Non-goals

- Physically meaningful interior solids — caps remain non-physical interior fills;
  only the painted outer surface is faithful.
- Re-triangulating the painted surface itself; only the open boundary is capped.
- Item 6 (split-part re-animation) and all other workstreams — W3+.
- Robust handling of non-Bambu `.3mf` package layouts (unchanged).
- Perfect handling of two **adjacent** regions lifted at the same time that share a
  color border (documented limitation below).

## Architecture

Five concerns, following existing module boundaries plus one new module and one
vendored library:

| Concern | File | Responsibility |
|---------|------|----------------|
| Boundary loops + triangulation | `js/caps.js` **(new)** | `extractLoops`, best-fit plane + projection, the 4 triangulators, outer/hole nesting |
| Solid assembly | `js/split.js` | conform T-junctions (unchanged) + call `Caps`; return surface **and** cut cap separately |
| Live render | `js/viewer.js` | cap the remainder hole live; part bodies already capped via `solidFromSubs` |
| Tool + state | `js/app.js`, `index.html` | method dropdown in Split options; per-part method; re-cap on change; extend the history snapshot |
| Export | `js/threemf.js` | remainder reuses each part's **reversed** cap |
| Dependency | `vendor/poly2tri.min.js` **(new)** | constrained Delaunay for the CDT method (MIT, single file) |

### `Caps` module — `js/caps.js`

A self-contained module (`window.Caps`) loaded before `split.js`. No three.js or DOM
dependencies except the optional `THREE.ShapeUtils` / `poly2tri` globals used by two
triangulators. Pure functions over coordinate arrays so it is unit-testable in the
existing `tests/` harness.

**1. `extractLoops(edges)` → `Loop[]`.**
Input: the region's open-boundary edges as **directed** vertex-id pairs. Each
boundary edge is used by exactly one conformed triangle, and `split.js` records it in
that triangle's CCW order (see refactor below), so the edges are consistently
oriented with the surface on the left. Chain them head-to-tail (`edge (u→v)` → the
unused edge whose start is `v`) until the loop closes; repeat over remaining unused
edges for **multiple loops**. A `Loop` is an ordered list of welded vertex ids
(`number[]`) plus their model-space coordinates.
*Pinch vertices* (a vertex with >2 incident boundary edges, from non-simple paint
borders) pick any unused outgoing edge; residual mis-pairing there is documented, not
solved (Bambu repairs on import).

**2. `bestFitPlane(pts)` → `{ origin, normal, u, v }`.**
Normal via **Newell's method** (robust for non-planar loops); `origin` = centroid;
`u,v` = an in-plane orthonormal basis. `project(pt)`/`unproject(x,y)` convert between
model space and plane coordinates.

**3. Four triangulators** — each takes a loop (or loops) and returns triangles as
index triples plus any invented interior points:

| Method | How | Notes |
|--------|-----|-------|
| **Centroid** | 3D centroid of the loop + fan to it | cheapest; convex/small loops; one invented point per loop |
| **Projected-normal** | fan from the centroid **in the best-fit plane**, lifted back | stabler than Centroid on tilted/curved loops; one invented point per loop |
| **Earcut** | `THREE.ShapeUtils.triangulateShape(contour, holes)` on the projected polygon | concave + holes; **no** invented points |
| **CDT** | poly2tri sweep on the projected polygon (contour + holes) | best triangle quality; no invented points; needs coincident-point dedupe first |

**4. `triangulateLoops(loops, method)` → `{ extraPts: number[][], tris: Ref[][] }`.**
Where a `Ref` is either a loop vertex id or an index into `extraPts`. For **Earcut/CDT**,
loops are first classified into **one outer contour + hole contours** by signed area
sign and point-in-polygon containment in the shared best-fit plane, so an
enclosed-island loop becomes a real hole instead of being filled. **Centroid/
Projected-normal** cap each loop independently (no nesting).

### `split.js` refactor

`Split.solidFromSubs(mesh, subs, method)` keeps steps 1–4 unchanged (collect region
sub-triangles, remap vertices, **conform T-junctions**, build the undirected
edge-use-count map). Two changes:

1. When recording edges, keep the **directed** `(u,v)` order from the owning triangle
   for boundary edges (the current `eA/eB` already store first-seen order, which is
   that triangle's CCW order — expose it for boundary edges).
2. **Step 5 (cap) is replaced**: from the boundary edges build
   `loops = Caps.extractLoops(...)`, then `cap = Caps.triangulateLoops(loops, method)`.

It now returns the cut **cap separately** from the surface:

```
{ surface: { positions, indices, triState },   // the conformed painted region
  cap:     { loopVids:number[], extraPts:number[][], tris:Ref[][] } }
```

`cap.tris` reference **welded global vertex ids** (shared across all bodies built from
the same `buildSubGraph`) plus `extraPts` (the invented centroid points).
`Split.assemble(surface, cap, { reverse, capState })` welds `surface` + `cap` into a
single `{positions, indices, triState}` body: it maps the cap's global vid/`extraPts`
refs through the body's local vertex remap, winds the cap so its normal **closes the
solid** (points to the patch's outward side, as the current code computes per-edge),
flips that winding when `reverse` is set (the remainder side), and tags cap triangles
with `capState`.

### Shared cut surface (the key change)

When region **R** is lifted, **R's boundary loop is identical to the hole the
remainder is left with** — same welded vertices, opposite orientation. So the cap is
triangulated **once** (when the part is created) and reused:

- **Part body** = R's conformed surface + cap, cap wound to close the part, colored
  R's `state`.
- **Remainder** = remainder surface + **each part's cap reversed** (winding flipped),
  the whole reversed cap colored uniformly with that loop's **majority bordering
  color** — the most common remainder `state` among the sub-triangles adjacent to the
  loop's boundary edges, falling back to `defaultExtruder`. This is well-defined for
  every cap triangle (including interior ones) and is interior/hidden once reassembled,
  consistent with the prior split spec's option **a**.

Because both bodies map the **same** global loop vertex ids + the same `extraPts`
through their own local vertex remap, the two caps are geometrically coincident → the
model reassembles with no gap or overlap, and each body is independently watertight.
This **reverses** the prior spec's "independent caps each side" decision.

The cap (`{loopVids, extraPts, tris, method}`) is **stored on the split part** so
both the live remainder and the export remainder reuse it without recomputation.

### Live render — `js/viewer.js`

`setSplitParts(parts)` already builds one capped `THREE.Mesh` per part. Extend the
**main mesh** path so the remainder is **capped live**: after building the holed main
geometry (claimed leaves skipped, as today), append each part's **reversed** cap
triangles (mapped through the main mesh's vertex set, using the part's stored
`loopVids`/`extraPts`). Result: the hole is visibly filled the instant you split.
Cost is marginal next to the full re-tessellation `build()` already runs per split.

> Scope note: `setSplitParts` is also where item 6 (parts re-animating) lives. W2
> only adds capping here; the animation fix is deliberately left for W3.

### Tool + UI — `index.html`, `js/app.js`

- A **method `<select>`** in the Split options strip (`data-panel="split"`): Earcut
  (default), CDT, Projected-normal, Centroid.
- Changing it **re-caps every current part** (recompute each part's `cap` with the new
  method, rebuild view) so the whole model can be flipped between methods to compare,
  and pushes a history entry.
- New splits use the currently selected method; each part stores its `method`.
- The history **snapshot is extended** to carry each part's `method` and `cap`
  alongside `subs`/`state`, so undo/redo restores the exact capping.

### Export — `js/threemf.js`

`exportSplit` is unchanged in structure (separate top-level objects, coincident at the
original build transform). It now:
- builds each split part from its **stored** surface + cap (the method the user chose),
- builds the **remainder** as its surface + every part's **reversed** cap (each
  uniformly the loop's majority bordering color), instead of re-running the old
  whole-remainder centroid fan.

## Data flow

```
click ─▶ Cleanup.selectColorRegion ─▶ region subs
   └─ Split.solidFromSubs(mesh, subs, method)
        ├─ conform T-junctions (unchanged)
        ├─ boundary edges (directed) ─▶ Caps.extractLoops ─▶ oriented loops
        └─ Caps.triangulateLoops(loops, method) ─▶ { extraPts, tris }  ── the CUT CAP
   ├─ part body  = surface + cap (closes part, region color)         ─▶ Viewer part mesh
   ├─ remainder  = remainder surface + Σ(part cap, reversed)          ─▶ Viewer main mesh (hole filled live)
   └─ on Export: ThreeMF.exportSplit ─▶ parts (own caps) + remainder (reversed caps)
        ─▶ separate coincident objects in one .3mf ─▶ download
method change ─▶ re-cap all parts ─▶ rebuild view ─▶ history entry
```

## Edge cases & limitations (documented, accepted)

- **Non-planar loops.** Any flat-ish fill of a loop on a curved surface is an
  approximate interior surface; projection to the best-fit plane is the standard
  approach. Caps are non-physical regardless of method.
- **Degenerate / near-collinear projected polygons.** Guard before Earcut/CDT: drop
  zero-area loops; dedupe coincident projected points (required by poly2tri); fall
  back to Centroid for loops with < 3 distinct points.
- **Enclosed-island holes.** Handled by Earcut/CDT via outer/hole nesting.
  Centroid/Projected-normal cap each loop independently and so will **fill** an
  enclosed hole — documented; use Earcut/CDT when holes matter.
- **Adjacent same-time multi-color lifts.** The edge shared by two simultaneously
  lifted regions is a boundary of *each*, so the remainder receives both reversed
  caps along it → possible local overlap/non-manifold at that shared border. Isolated
  single-color lifts (the common case) are unaffected; Bambu repairs minor overlaps on
  import.
- **Pinch vertices** on fractal paint borders may leave a few residual non-manifold
  edges (far fewer than the prior single-anchor fan); not driven to zero.

## Resolved decisions

- **Four methods, selectable**; vendor **poly2tri** for CDT.
- **Shared cut surface** — the part's cap is reused **reversed** for the remainder
  hole (reverses the prior "independent caps" decision).
- **Cap the remainder live** in the viewer, not just on export.
- **Default Earcut**; switching the method **re-caps all** parts; **per-part** method
  stored in the history snapshot.
- **Remainder cap color** = the loop's majority bordering color (most common adjacent
  remainder state, `defaultExtruder` fallback); interior/hidden on reassembly,
  consistent with the prior split spec's option **a**.
- **Module structure** = a focused new `js/caps.js`, written so W7 (manual cut) can
  promote the projection/triangulation helpers to a shared geom module later.

## Testing

- **Unit (`tests/`):** `Caps.extractLoops` returns N oriented loops for a synthetic
  multi-loop boundary; each method triangulates a known convex loop, a concave loop,
  and an outer+hole pair to the expected triangle/vertex counts and a consistent
  winding; projection round-trips.
- **Watertightness:** for a split part built by each method, every edge of the welded
  result is used **exactly twice**; non-manifold edge count is **0** on a
  single-simple-loop region (e.g. the reference model's red ball).
- **Reassembly:** part cap and remainder hole-cap reference the same coordinates; the
  remainder shows **no live hole** after splitting; exported objects reopened in Bambu
  Studio reassemble at the original position.
- **Method switch / history:** flip Earcut↔CDT↔Projected↔Centroid re-caps all parts;
  undo/redo restores each part's exact method and cap.
- **Regression:** painting/ring/fill/auto-clean and the normal `exportZip` path
  unchanged.
