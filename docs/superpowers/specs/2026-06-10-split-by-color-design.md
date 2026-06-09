# Split by Color — Design

**Date:** 2026-06-10
**Status:** Approved (ready for implementation plan)

## Summary

Add a "split by color" feature to Irodori that partitions a painted `.3mf`
model into one watertight solid **per filament color** and exports them as
**separate top-level objects** inside a single `.3mf`.

The split is performed at **sub-triangle resolution** — the same "high-res
paint" path already used by the viewer and cleanup — not at the face-mesh
level. Every face is tessellated into its leaf sub-triangles and each *leaf* is
assigned to the body matching its filament `state`, so boundary faces are cut
along the true paint boundaries instead of being assigned whole to a dominant
color.

## Goals

- Bucket geometry by color at sub-triangle resolution (not face level).
- Produce one watertight solid per color via boundary capping (fan to anchor) —
  **no wall thickness parameter**.
- Emit N **separate top-level objects** in one `.3mf`, each assigned its
  filament, all overlapping at the original position so they reassemble the
  model.
- Leave the in-memory editable doc and the normal Export path untouched.

## Non-goals

- Volumetric per-color fill (ill-posed for surface paint).
- Inward-shell offset / wall-thickness solids (explicitly dropped).
- Robust handling of arbitrary/non-Bambu `.3mf` package layouts.

## Architecture

Three layers, following the existing module boundaries:

| Layer | File | Responsibility |
|-------|------|----------------|
| Geometry | `js/split.js` (new) | Tessellate + weld + cap → per-color watertight meshes |
| Packaging | `js/threemf.js` (new `exportSplit`) | Assemble the multi-object `.3mf` |
| UI | `index.html` + `js/app.js` | "Split & Export" card + wiring |

### Geometry — `Split.byColor(doc)`

Returns an array, one entry per distinct color present among the leaf
sub-triangles:

```
{ state, extruder, name, positions: Float32Array, indices: Uint32Array }
```

Algorithm, per color `c`:

1. **Collect.** Across all `doc.meshes`, tessellate every face with
   `Paint.tessellate`. Keep each leaf sub-triangle whose `state === c`, in model
   space (the face's `v1/v2/v3` positions feed the tessellation).
2. **Weld.** Quantize vertices with the same scale as `cleanup.js`
   (`QSCALE = 100000`) into a local vertex list `V` and triangle index list `F`.
   This is the open surface patch, with the original outward winding.
3. **Boundary edges.** Build an undirected edge → use-count map over `F`. Edges
   used exactly once are boundary edges; they form one or more closed loops.
4. **Cap (fan to anchor).**
   - Anchor `p` = centroid of the patch's welded vertices `V`.
   - For each boundary edge, taken in the direction it appears in its single
     owning triangle, emit one triangle `(edge.b, edge.a, p)` (winding chosen so
     the cap normal points away from the patch's outward side; verified by
     dot-product against the outward face normal and flipped if needed).
   - Each former-open edge is now referenced twice (patch triangle + cap
     triangle) ⇒ the mesh is watertight. Multiple loops share the single anchor
     `p` and remain watertight (each `p→vertex` edge is shared by two adjacent
     cap triangles within its loop).
5. **Already-closed case.** If a color has no boundary edges (it covers an
   entire closed component), emit the patch unchanged — it is already
   watertight.
6. **Output.** Combine patch vertices + anchor into `positions`; patch triangles
   + cap triangles into `indices`. `extruder = state === 0 ? defaultExtruder :
   state`. `name` from the filament index (e.g. `"Filament 3"`).

### Packaging — `ThreeMF.exportSplit(doc)`

Calls `Split.byColor`, then assembles a Bambu-compatible package mirroring the
reference file's structure, producing **N separate top-level objects**:

- **`3D/Objects/object_1.model`** — `<resources>` with N `<object id=1..N
  type="model"><mesh>` resources, one per color, no `paint_color` attributes.
- **`3D/3dmodel.model`** — N wrapper `<object>` resources (unique ids), each
  with a `<components><component p:path="/3D/Objects/object_1.model"
  objectid="k"/></components>`; and N `<build><item>` entries, **all sharing the
  original build transform** (e.g. `1 0 0 0 1 0 0 0 1 125 125 0`) so the objects
  coincide and reassemble the model.
- **`Metadata/model_settings.config`** — N `<object>` entries, each with
  `key="name"` (color), `key="extruder"` (the color's filament), and a `<part
  id="k" subtype="normal_part">` carrying name / identity matrix / extruder. The
  `<plate>` lists N `<model_instance>` entries (one per wrapper object).
- **`Metadata/project_settings.config`**, **`[Content_Types].xml`**,
  **`_rels/.rels`**, **`3D/_rels/3dmodel.model.rels`** — reused unchanged
  (paths do not change).
- Fresh `p:UUID`s are generated for every object, component, and build item
  (the production extension `requiredextensions="p"` requires them).

The package is built into a **fresh `JSZip`** (preserved files copied over, the
three generated files replacing their originals; stale object `.model` files
dropped), so `doc.zip`, the editable doc, and the normal `exportZip` path are
untouched. Returns a `Blob`.

### UI — `index.html` + `js/app.js`

- New left-panel card "**Split by color**" (after the stats card), shown once a
  file is loaded. Single "**Split & Export**" button; no thickness input.
- Handler restores the current (post-edit) paint state (like `doExport`), runs
  `ThreeMF.exportSplit`, and downloads `<name>_split.3mf`. Wrapped in `busy(...)`
  with a toast.
- Every color present among the leaves becomes an object. (The "Colors to clean"
  toggles are unrelated and are ignored here.)

## Data flow

```
doc.meshes (paints) ──Paint.tessellate──▶ leaf sub-triangles
   └─ bucket by state ─▶ per-color { V, F } (welded patch)
        └─ cap boundary loops to centroid anchor ─▶ watertight solid
             └─ ThreeMF.exportSplit ─▶ N objects in one .3mf ─▶ download
```

## Edge cases & limitations (documented, accepted)

- **Fan caps invent interior geometry** — the capped interior is not physically
  meaningful; only the outer painted surface is faithful.
- **Concave / thin patches** can self-intersect when many boundary edges fan to
  one anchor; accepted.
- **Repackaging assumes** the standard Bambu single-object layout of the
  reference file. Non-standard packages are out of scope.
- **Color from leaf state**, including `state 0` → `defaultExtruder`.

## Testing

- Round-trip the reference model: split, confirm N objects = number of distinct
  colors, each mesh is closed (every edge used exactly twice).
- Confirm vertex counts/triangle counts are non-zero per color and the union of
  patch triangles equals the original sub-triangle set.
- Open the exported `.3mf` in Bambu Studio: N separate objects, correctly
  colored, coincident at the original position.
```
