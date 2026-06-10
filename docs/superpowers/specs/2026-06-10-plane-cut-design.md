# Plane Cut (Batch K / W7) — Design

**Date:** 2026-06-10
**Status:** Approved (ready for implementation plan)

## Summary

The final roadmap feature: a Bambu-style **true geometric plane cut**. A Cut
tool (shortcut **C**) shows a live translucent plane controlled by **X/Y/Z
axis chips, a Position slider, and two Tilt sliders**; applying it clips every
target mesh's triangles **exactly** at the plane, caps the section with
**perfectly flat earcut caps**, and replaces the source mesh with the kept
halves (**Keep both / Keep upper / Keep lower**) as real document meshes —
paintable, splittable, and re-cuttable. One cut = one undo step.

User-approved choice: option **A** (true geometric cut) over the cheaper
sub-triangle-side selection (staircase edge).

## Components

### 1 · `Paint.stateAtPoint` (`js/paint.js`, pure, tested)

`stateAtPoint(tree, ax..cz, px,py,pz)` → the state of the leaf containing
point P (assumed inside the face). Descends split nodes using **tessellate's
exact child geometry** (corner rotation by `special`, midpoints, reversed kid
mapping); the containing child is found by edge-sign tests against the face
normal. Used to color clipped pieces from their parent's paint.

### 2 · Geometry core `js/planecut.js` (new, pure, tested)

`cutMesh(mesh, plane)` → `{ above, below }` (each a mesh-shaped
`{positions, v1, v2, v3, nf, paints}` or `null` when empty), where
`plane = { px,py,pz, nx,ny,nz }` (unit normal; "above" = signed distance ≥ 0).

- **Classification:** per-vertex signed distance, snapped to 0 within
  `eps = 1e-6 × bbox diagonal` (vertex-global, so neighboring triangles agree).
  Triangles entirely ≥0 / ≤0 pass through whole (keeping their original paint
  string); mixed triangles are **clipped**.
- **Clipping:** walk the triangle's directed cycle building one polygon per
  side (vertices with d≥0 → above-poly, d≤0 → below-poly, ON-vertices → both;
  strictly-crossing edges contribute an **interpolated intersection point to
  both**). Each polygon (3–4 verts, parent winding preserved) is fan-
  triangulated. Intersection points are **cached per undirected edge**
  (computed from the lower-id endpoint) so both sides and both neighbors weld
  to identical coordinates.
- **Piece paint:** each clipped piece gets the solid code of
  `Paint.stateAtPoint(parentTree, parentCorners, pieceCentroid)`.
- **Section loops:** every clipped triangle contributes one chord between its
  two plane-points (edge-intersections keyed by edge, ON-vertices keyed by
  vid). Chords chain into closed loops (degree-2 walk; pinch → greedy +
  `console.warn`, as in `extractLoops`).
- **Flat caps:** loops are projected into the plane's basis, classified
  **outer + holes** (signed area + containment, single nesting level — the
  torus/annulus case), and earcut via `THREE.ShapeUtils.triangulateShape`.
  Cap winding is **deterministic**: normals face `−n` on the above half and
  `+n` on the below half (checked per group and flipped as needed) — no
  orientation voting required for a flat cut. Cap state = the majority state
  of the section-adjacent pieces on that half.
- **Guarantees:** each non-null half is watertight AND directed-consistent
  (`directedViolations === 0`) with positive signed volume; the halves'
  volumes sum to the source's.

### 3 · UI (`index.html`, `js/app.js`, `js/viewer.js`, `css/style.css`)

- Toolbar **Cut** button (kbd badge **C**; shortcut map gains `c`).
- Options panel (`data-panel="cut"`): axis chips **X/Y/Z** (single-select,
  default Z), **Position** slider (0–100 mapped across the model's extent
  along the base axis), **Tilt A / Tilt B** sliders (−60°…60° about the two
  in-plane axes), and **Keep both · Keep upper · Keep lower** buttons.
- `Viewer.setCutPlane(plane | null)`: a translucent accent-colored quad
  (DoubleSide, no depth-write) + outline, sized ~1.5× the model radius,
  positioned/oriented live as the controls change; hidden on `null` or tool
  switch. The Cut tool itself uses **orbit navigation** (it's not a pick tool).

### 4 · Integration (`js/app.js`)

- Targets: the **isolated mesh** when mesh-isolation is active, else **all**
  meshes.
- Apply: blocked with a toast while color-split parts exist ("export or undo
  your split parts first" — keeps the sub-triangle world and the geometry
  world from corrupting each other; v1 rule). Otherwise: cut each target,
  assemble the new `doc.meshes` (source replaced by its kept halves; empty
  halves skipped; a cut that misses leaves the mesh unchanged), set
  `doc.synthetic = true`, invalidate caches, reset isolation, recompute model
  size, `pushHistory("Plane cut")`, rebuild panels, re-frame.
- **Undo:** `snap()`/`restore()` extended with `meshList` (the `doc.meshes`
  array, by reference — mesh objects are not mutated by the cut), restored
  before the per-mesh paint restore so index alignment holds. Geometry-
  mutating rotation remains outside history (pre-existing limitation, noted).

### 5 · Export (`js/threemf.js`, `js/split.js`)

Cut geometry cannot splice into the original XML, so:
- `Split.buildSplitXML` objects gain optional **`paints: string[]`** (verbatim
  `paint_color` per triangle, taking precedence over `triState`).
- New `exportGenerated(doc)`: a fresh package (same preserved-file set as
  `exportSplit`, project settings normalized) whose objects are the document
  meshes with their full paint strings.
- `exportZip` routes to it when `doc.synthetic` is set. `exportSplit` is
  unchanged (already geometry-based and works on synthetic meshes).

## Non-goals (v1)

- Keep-side placement on the bed ("place on cut"), cut-plane dragging gizmo
  (sliders only), multi-level nested section loops, cutting while split parts
  exist, history for rotations.

## Testing

- `stateAtPoint` on a known split tree (each child queried → expected state).
- New `makeClosedCube` fixture (12 outward-wound triangles; sanity:
  `directedViolations === 0` on the fixture itself).
- Axis cut through the cube: two halves, each `directedViolations === 0`,
  volumes ≈ 4 + 4 = 8; caps planar (`|(v−p)·n| < eps`) and oriented (above-cap
  normals · n < 0); paints carried.
- Tilted cut (normal (1,0,1)/√2): watertight halves, volumes sum ≈ 8.
- Plane missing the cube: `{ above: null, below ≅ source }` (or mirrored).
- Painted-face cut: clipped pieces' solid codes equal
  `stateAtPoint(parent, centroid)`.
- `buildSplitXML` with `paints`: emits `paint_color` strings verbatim.
- Browser: cut the reference model straight and tilted; halves appear in the
  Objects panel, are paintable/splittable; undo restores; export reopens with
  both halves and paint intact.
