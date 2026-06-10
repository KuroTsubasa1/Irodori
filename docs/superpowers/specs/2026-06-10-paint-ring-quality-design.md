# Paint & Ring Quality (Batch F) — Design

**Date:** 2026-06-10
**Status:** Approved (ready for implementation plan)

## Summary

Three paint-tool upgrades:

1. **Slicer-grade brush (item 1)** — the brush currently flips whole leaf
   sub-triangles, so strokes on unpainted meshes are blocky (a leaf = a whole
   face there). It now **subdivides triangles at the stroke edge** exactly like
   Bambu/Prusa do, via the paint codec's recursive 4-way splits.
2. **Ring follows the normal + contour preview (items 3+4)** — the band axis is
   orthogonalized against the clicked surface normal, and the floating circle
   cursor is replaced by a **surface tint of the actual band** a click would
   paint.
3. **Symmetry X/Y/Z combinable (item 9)** — three toggle chips replace the
   checkbox+dropdown; any combination mirrors the stroke across all enabled
   center-planes.

Touches `js/paint.js` (collapse helper), `js/cleanup.js` (paintStamps,
featureAxis), `js/app.js` (stroke/ring/symmetry wiring + UI state),
`js/viewer.js` (none or minimal — reuses `setPreview`), `index.html`,
`css/style.css`. The geometry core (`paintStamps`) is pure and Node-tested.

## Non-goals

- Ring and fill stay leaf-resolution (only the brush subdivides).
- No adjustable subdivision depth in the UI (fixed `maxDepth = 4`).
- Live preview of the *mirrored* stroke stays leaf-coarse during the drag and
  refines on release (only the primary stroke needs live precision).
- `mirrorMap` stays (it powers the live mirror preview); final symmetric paint
  switches to mirrored stamps.

## Design

### 1. Stamp-based subdivision painting

**Stroke = stamp list.** `brushAt` keeps its live leaf-tint behavior (instant
feedback, including the mirrorMap-based live mirror), and additionally records
a **stamp** `{x, y, z, r}` (hit point + current brush radius) per processed
move. `endStroke` no longer calls `applyStates`; instead:

1. Expand stamps across enabled symmetry axes (see §3): for each enabled-axis
   subset, add a copy of every stamp reflected across those center planes
   (k axes ⇒ 2^k total copies of each stamp).
2. `Cleanup.paintStamps(mesh, stamps, state, { maxDepth: 4 })` (below).
3. `Cleanup.invalidateSub(mesh)` (tree structure changed), `pushHistory`,
   `render(null)`, `updateStats()`.

**`Cleanup.paintStamps(mesh, stamps, state, opts)` → { changedFaces, count }.**
Pure tree surgery, slicer-compatible:

- **Broad phase:** a face is a candidate if its AABB (from its 3 corners,
  inflated by the stamp radius) overlaps any stamp's AABB; exact tests happen
  in the narrow phase. (Faces: ~200k; stamps: tens — cheap.)
- **Narrow phase / tree walk:** decode the face's paint tree and walk it
  recursively **with exact corner coordinates per `Paint.tessellate`'s
  conventions** (corner rotation by `special`, midpoint splits, the reversed
  child-index mapping). For each leaf:
  - *overlap* = ∃ stamp with `distance(stamp center, leaf triangle) ≤ r`
    (true point-to-triangle distance, so brushes smaller than a face register);
  - *fully covered* = all 3 corners and the centroid lie inside the stamp
    union;
  - fully covered → set the leaf's state; no overlap → leave untouched;
  - partial overlap → if depth < maxDepth, replace the leaf with a
    `split = 3, special = 0` node whose 4 children inherit the leaf's state,
    and recurse into the children (their geometry from the same midpoint
    scheme); at maxDepth, paint iff the centroid is inside the union.
- **Collapse:** after painting, collapse uniform subtrees bottom-up (a split
  whose children are all leaves of one state becomes that leaf) via a new
  `Paint.collapseDeep(node)`, so trees and exports don't bloat. Re-encode
  changed faces; update `dom`.

The cached sub-graph is invalidated afterwards (subdivision changes the leaf
set), which also rebuilds `mirrorMap` lazily.

### 2. Ring: normal-aligned axis + band tint preview

**Axis.** `Cleanup.featureAxis(mesh, seedSub, Rn, normal?)` gains an optional
surface normal. After the PCA axis is found (any path, including the <8-subs
early return), if `normal` is given the axis is **orthogonalized**:
`a' = normalize(a − (a·n)n)`; if degenerate (axis ∥ normal), fall back to any
vector ⊥ n. The old `|vz| > 0.82 →` vertical snap is **removed** (the normal
constraint replaces it). Callers pass `hit.normal`.

**Preview.** For the ring tool the floating circle is replaced by the same
surface tint the split preview uses: on hover, compute the band
(`featureAxis` + `selectBandAxis` from the hovered sub) and tint it via
`Viewer.setPreview`; `Viewer.hideCursor()` while ring-previewing. The app's
split `previewCache` generalizes to a shared hover-preview cache
(`{ tool, meshIndex, seedSub, members, globalSubs, band data }`), recomputed
only when the hovered sub leaves the cached band's seed (cache hit = hovered
sub ∈ cached members). `doRing` **paints the cached previewed band** when the
click's sub is in it (preview == result, no recompute); otherwise computes
fresh. Brush keeps its circle cursor; split keeps its region tint.

### 3. Symmetry chips (X · Y · Z, combinable)

`index.html`: the brush panel's checkbox + `<select>` are replaced by three
toggle buttons (`#symX/#symY/#symZ`, class-toggled `on`). `app.js` exposes
`enabledAxes() → number[]` (subset of 0/1/2).

- **Live mirror (drag):** the painted-leaf set is expanded by composing
  `Cleanup.mirrorMap` over each enabled axis in turn (set ∪= map(set) per
  axis), which covers all axis combinations.
- **Final paint (release):** the **stamp list** is expanded the same way —
  per enabled axis, every stamp (including previously reflected copies) adds a
  copy reflected across that axis's center plane. Centers come from a new
  shared helper `Cleanup.axisCenters(mesh)` (per-axis midpoint of the
  sub-centroid bounds) — the **same** centers `mirrorMap` uses, so live mirror
  and final paint agree.

## Testing

- **Unit (`node --test`):**
  - `paintStamps` on a one-big-triangle fixture: a small interior stamp →
    the face's tree subdivides (`Paint.leafCount > 1`, some leaves painted,
    the corner regions untouched); a stamp engulfing the face → the face is a
    single solid leaf of the new state (collapse verified, encoded as the
    solid code); leaf count respects `4^maxDepth`; a stamp far away → face
    unchanged.
  - `Paint.collapseDeep`: a hand-built nested tree with uniform children
    collapses fully; a mixed tree is preserved.
  - Stamp symmetry expansion (pure helper): 1 stamp with axes {x} → 2 stamps
    mirrored about the x-center; {x,y} → 4.
  - `featureAxis` with a normal: returned axis ⊥ normal (|dot| < 1e-6), on
    both the PCA path and the small-region early-return path.
- **Browser-verified:** brushing an unpainted area produces a smooth slicer-
  like edge after release (visibly subdivided, not whole-face blocks); the
  ring hover tints the actual wrap-around band hugging the contour and the
  click paints exactly the tinted band; with X+Y enabled a stroke paints 4
  symmetric copies; existing brush/ring/fill behavior and undo/redo intact.
