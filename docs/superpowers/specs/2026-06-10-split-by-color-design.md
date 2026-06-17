# Split by Color — Design

**Date:** 2026-06-10
**Status:** Approved (ready for implementation plan)

## Summary

Add an interactive **Split** tool to Irodori. Clicking a colored part of the
model lifts that region out as its own watertight solid and animates it outward
in an exploded view, so the user can build up a set of per-color solid bodies
and export them as **separate top-level objects** inside a single `.3mf`.

The flow is as follows:

1. User selects the **Split** tool (toolbar).
2. User clicks a colored part of the model.
3. Irodori lifts that **connected same-color region** out as a new watertight
   solid (the region's sub-triangles + a fan cap).
4. The new part is moved outward in an **"explosion" animation** (exploded view).
   This is **visual only**.
5. Repeat for other regions. **Export** writes each split part (and the
   remaining model) as separate objects, coincident at the original position.

The split is performed at **sub-triangle resolution** — the same "high-res
paint" path already used by the viewer and cleanup — not at the face-mesh
level. Every face is tessellated into its leaf sub-triangles and each *leaf* is
assigned to the body matching its filament `state`, so boundary faces are cut
along the true paint boundaries instead of being assigned whole to a dominant
color.

## Goals

- Interactive, one-region-per-click splitting at sub-triangle resolution (not
  face level). A click selects the connected same-color region under the cursor.
- Each split region becomes one watertight solid via boundary capping (fan to
  anchor) — **no wall thickness parameter**.
- An exploded-view animation moves each split part outward for inspection;
  **visual only**, never baked into the export.
- Export emits the split parts (and the remaining model) as **separate
  top-level objects** in one `.3mf`, each assigned its filament, all coincident
  at the original position so they reassemble the model.
- Leave painting/cleanup tools and the normal Export path working as before.

## Non-goals

- Volumetric per-color fill (ill-posed for surface paint).
- Inward-shell offset / wall-thickness solids (explicitly dropped).
- Baking explosion offsets into the exported geometry/transforms.
- Robust handling of arbitrary/non-Bambu `.3mf` package layouts.

## Architecture

Four concerns, following the existing module boundaries:

| Concern | File | Responsibility |
|---------|------|----------------|
| Region select | `js/cleanup.js` | Flood the connected same-color region under a click |
| Geometry | `js/split.js` (new) | Build a capped watertight solid from a set of sub-triangles |
| View / animate | `js/viewer.js` | Render movable per-part bodies + the holed main mesh; exploded-view animation |
| Tool + export | `js/app.js`, `js/threemf.js`, `index.html` | Split tool wiring, split-part state, undo, `exportSplit` |

### Region selection — `Cleanup`

A click yields a seed sub-triangle (`hit.localSub`). Reuse the existing
sub-triangle graph (`buildSubGraph`) and the same-state flood already used by
`fillRegion`, exposed as `Cleanup.selectColorRegion(mesh, seedSub)` →
`Int32Array` of the connected sub-triangle indices sharing the seed's state.
This is the set handed to the geometry layer.

### Geometry — `js/split.js`

Core: `Split.solidFromSubs(mesh, subs)` → `{ positions: Float32Array,
indices: Uint32Array, state }`. Given a set of leaf sub-triangle indices on a
mesh, produce a capped watertight solid:

1. **Collect.** For each sub in `subs`, take its three welded vertex ids (`sv`)
   and welded coordinates (`vx/vy/vz`) from `buildSubGraph`. `state` = the
   leaves' shared filament state.
2. **Conform T-junctions.** A painted face may subdivide an edge its neighbour
   does not, so the raw sub-triangle surface is non-conforming (a coarse edge
   `(u,w)` coincides with finer `(u,m)+(m,w)` but differs by vertex id) — which
   would make the solid non-manifold. For each region triangle, **decompose**
   each edge at any welded midpoint a neighbour introduced (recursively, via the
   graph's `midOf` — the same midpoint logic `cleanup.js` uses for adjacency),
   forming a conformed boundary polygon. Triangles with no subdivided edges
   (polygon length 3) are emitted unchanged; subdivided ones are **fan-triangulated
   from the polygon centroid** (an interior point, never collinear with an edge,
   so no degenerate triangles). This makes the surface manifold and conforming
   with neighbours.
3. **Boundary edges.** Undirected edge → use-count map over the *conformed*
   triangles. Edges used exactly once are true open-boundary edges.
4. **Cap (fan to anchor).** Anchor `p` = centroid of the local vertices. For each
   boundary edge, in the direction it appears in its single owning triangle, emit
   one cap triangle to `p`, wound so the cap normal points away from the patch's
   outward side. Each former-open edge is then referenced twice ⇒ watertight.
5. **Already-closed.** If there are no boundary edges, emit the conformed patch
   unchanged.

`Split.solidFromSubs` is used for the live exploded part, and again at export
time (for both split parts and the remaining model).

### Split-part state (`js/app.js`)

The app maintains `splitParts: [{ meshIndex, subs: Int32Array, state }]`. A
derived set `claimed[meshIndex]` (the union of all parts' `subs`) marks
sub-triangles removed from the main mesh. Splitting pushes a part and a history
entry; undo/redo restore both `paints` and `splitParts` (snapshot extended).

### View / animation — `js/viewer.js`

The viewer currently builds **one** merged geometry. It is extended to render
multiple bodies:

- **Main mesh** — rebuilt as today, but `build()` accepts the `claimed` sets and
  **skips claimed leaves**, so a hole appears where each split region was lifted
  out. Picking (for the Split tool) targets only the main mesh.
- **Part bodies** — `Viewer.setSplitParts(parts)` builds one `THREE.Mesh` per
  split part from `Split.solidFromSubs`, colored by its state, added to `root`.
- **Exploded-view animation** — each part has a target offset = unit vector from
  the model centroid through the part's centroid, times `modelSize · k`
  (k ≈ 0.4). The `animate()` loop lerps each part's position from 0 toward its
  target (and back to 0 on un-split/undo). Visual only; never exported.

### Tool + UI (`index.html`, `js/app.js`)

- New **Split** tool button in the toolbar (alongside brush/ring/fill), with a
  short options-strip hint. `setTool("split")` puts the viewer in click-pick
  mode (no palette).
- `Viewer.onPick` for the split tool: flood the region (`selectColorRegion`),
  push a `splitPart`, rebuild via `Viewer.setSplitParts`, animate the explosion,
  toast the count, push history.
- Existing tools (brush/ring/fill/auto-clean) keep operating on the main painted
  mesh; they ignore claimed sub-triangles.

### Export — `ThreeMF.exportSplit(doc, splitParts)`

Assembles a Bambu-compatible package of **separate top-level objects**, all at
the original build transform (explosion offsets ignored):

- Geometry per object via `Split.solidFromSubs`: one object per split part
  (single color, extruder = `state===0 ? defaultExtruder : state`), plus one
  object for the **remaining** (unclaimed) sub-triangles. The remaining object
  is exported as a single painted, hole-capped solid: it keeps its multi-color
  paint, and the holes left by removed regions are fan-capped with cap triangles
  inheriting the bordering color (decision: option **a**).
- **`3D/Objects/object_1.model`** — N `<object id=1..N type="model"><mesh>`
  resources.
- **`3D/3dmodel.model`** — N wrapper `<object>`s, each a `<component>` →
  its mesh object; N `<build><item>`s sharing the original build transform.
- **`Metadata/model_settings.config`** — N `<object>` entries (name, extruder,
  one `<part>` each); `<plate>` lists N `<model_instance>`s.
- **`project_settings.config`**, **`[Content_Types].xml`**, both `.rels` reused
  unchanged. Fresh `p:UUID`s generated where the production extension requires.
- Built into a **fresh `JSZip`** so `doc.zip`, the editable doc, and the normal
  `exportZip` path are untouched. Returns a `Blob`; downloaded as
  `<name>_split.3mf`.

## Data flow

```
click ─▶ Cleanup.selectColorRegion ─▶ region subs
   └─ Split.solidFromSubs (weld + fan cap) ─▶ watertight part body
        ├─ Viewer.setSplitParts ─▶ exploded-view animation (visual only)
        └─ on Export: ThreeMF.exportSplit ─▶ parts + remainder as
             separate coincident objects in one .3mf ─▶ download
```

## Edge cases & limitations (documented, accepted)

- **Surface is manifold (T-junction-conforming).** Verified on the reference
  model: a 10,257-sub region exports with **0** non-manifold *surface* edges
  (down from 2,919 before conforming).
- **Fan caps invent interior geometry** — only the outer painted surface is
  faithful; the capped interior is not physically meaningful.
- **Cap apex pinch points.** A single anchor fans the whole boundary, so where
  the open boundary is non-simple (loops touching at a vertex on a fractal paint
  border) a few anchor-incident edges remain non-manifold (~40 of ~38k, multiplicity
  ≤4, on the reference region). Bambu repairs these on import. Driving to zero
  would need per-loop ear-clipped caps — out of scope.
- **Re-clicking an already-split region** is a no-op (it is no longer on the
  main mesh). Clicking a region adjacent to a hole splits only the live leaves.
- **Repackaging assumes** the standard Bambu single-object layout of the
  reference file. Non-standard packages are out of scope.

## Resolved decisions

- **Remaining model on export** → option **a**: one painted, hole-capped solid
  (keeps multi-color paint; holes fan-capped, caps inherit bordering color).
- **Explosion magnitude** → a single global factor (`modelSize · k`, k ≈ 0.4),
  no slider.

## Testing

- Click a region: a watertight part body appears (every edge used exactly
  twice) and animates outward; a matching hole appears in the main mesh.
- Split several regions, undo/redo: parts and holes restore correctly.
- Export: objects = split parts (+ remainder); each split part mesh is closed;
  open the `.3mf` in Bambu Studio — separate objects, correctly colored,
  coincident at the original position.
