# Scene Tools (Batch C) — Design

**Date:** 2026-06-10
**Status:** Approved (ready for implementation plan)

## Summary

Three related capabilities (W6):

1. **Multi-mesh load + round-trip** — read **every** object/mesh in a `.3mf` (the loader currently keeps only the first `<mesh>` per `.model` file) and round-trip them all on export.
2. **Objects panel** — a sidebar list of every scene object (loaded meshes **and** split parts) with a visibility toggle and click-to-isolate.
3. **Isolation view** — show only the selected object and recenter the viewport on it; edit it in isolation; exit to show all.

Touches `js/threemf.js` (multi-mesh parse + rebuild — two pure, Node-tested helpers), `js/viewer.js` (per-mesh visibility + build-subset), `js/app.js` (Objects panel + isolation state), `index.html`, `css/style.css`.

## Non-goals

- A second/separate canvas — "centered viewport" = recenter the existing view on the isolated object.
- Reordering/renaming/deleting objects (list + visibility + isolate only).
- Per-object transforms (move/rotate individual objects) — that's not requested here.
- Repainting split parts (they remain finished uniform solids; isolating one is view-only).

## Design

### A. Multi-mesh load + round-trip (`js/threemf.js`)

The current `parseMeshFromModel` finds the first `<mesh>` and stores `_pre/_mid/_tail` text slices for export. That breaks for multiple meshes in one `.model` (their slices overlap, so per-mesh writes clobber each other). Replace with offset-range parsing + whole-file rebuild:

- **`parseMeshes(text, path)` → mesh[]** *(pure, Node-tested)*. Scan the file for every `<mesh>…</mesh>`; for each, parse vertices + triangles (the existing regexes) and record the **inner offset ranges** `vRange=[start,end]` (between `<vertices>` and `</vertices>`) and `tRange=[start,end]` (between `<triangles>` and `</triangles>`) relative to `text`. Returns one mesh per `<mesh>`: `{ path, positions, nv, nf, v1, v2, v3, paints, vRange, tRange }`.
- **`load`** stores each model file's raw text once (`doc.files[path] = text`) and collects meshes from all files via `parseMeshes`. (The root `3dmodel.model`, which has components but no `<mesh>`, yields none.) `origFilamentCount` (Batch B) unchanged.
- **`rebuildModelFile(text, fileMeshes)` → string** *(pure, Node-tested)*. Given a file's text and the meshes parsed from it, regenerate each mesh's `<vertex>`/`<triangle>` lines and splice them into their recorded ranges. Process ranges **back-to-front** so earlier offsets stay valid. (Vertices and triangles are both regenerated, so geometry edits like rotation and paint changes are captured — same guarantee as today.)
- **`exportZip`** rebuilds per **file**: group `doc.meshes` by `path`, and for each path `doc.zip.file(path, rebuildModelFile(doc.files[path], meshesOfThatPath))`. The Batch B filament-config extension still runs afterward. A single-mesh file rebuilds to the same bytes it would have before (regression-checked).

### B. Objects panel (`index.html`, `js/app.js`, `css/style.css`)

A new **"Objects"** card in the left sidebar (after "Load"). It lists every scene object:
- **Loaded meshes** — one row per `doc.meshes[i]`. Label = its name from `model_settings.config` (`<metadata key="name">`, parsed best-effort at load) or `"Object i+1"`; show its face count.
- **Split parts** — one row per `splitParts[k]` (label = `colorName(state) + " part"`) plus the implicit **remainder** of each mesh that has parts.

Each row has: a color/label, a count, an **eye toggle** (show/hide), and clicking the row **isolates** that object. An "Show all / Exit isolation" control resets. The panel rebuilds on load and whenever `splitParts` changes (it already re-renders via `render()`).

### C. Visibility + isolation (`js/viewer.js`, `js/app.js`)

- **Viewer per-mesh subset.** `Viewer.build(doc, claimed)` currently merges all `doc.meshes` into one `meshObj`. Add an optional **visible-mesh filter**: `Viewer.setVisibleMeshes(set | null)` (null = all). `build` includes only those mesh indices in the merged geometry; picking still resolves correctly (offsets computed over the included meshes). Split-part bodies (`splitObjs`) and their cap fills get individual `.visible` flags via `Viewer.setPartVisibility(idSet | null)`.
- **App isolation state.** `hiddenObjects` (manually hidden) + `isolated` (an object key, or null). Isolating object X = set the viewer to show only X (a single mesh, or a single split part), then `Viewer.frame()` — which recenters on the built geometry's bounding sphere, giving the "centered viewport." Exiting isolation restores all-visible + `frame()`.
- **Editing in isolation.** When a loaded mesh is isolated, only it is rendered and picked, so Brush/Ring/Fill/Split/auto-clean naturally operate on just that mesh. Split parts isolate view-only.

## Testing

- **Unit (`node --test`, new):**
  - `parseMeshes`: a synthetic 2-`<mesh>` model string → 2 meshes with correct `nv`/`nf` and `vRange`/`tRange` that bound the right substrings; a 1-mesh string → 1 mesh.
  - `rebuildModelFile`: rebuild a 2-mesh file after mutating one mesh's `positions` → both meshes' blocks present, the mutated coordinate appears, surrounding markup (the second mesh, the `</resources>`, etc.) preserved; rebuilding with no change reproduces an equivalent file.
- **Regression:** existing suite stays green (28).
- **Browser-verified:** with a constructed 2-object `.3mf` — the Objects panel lists both; toggling an eye hides/shows; isolating one hides the other and recenters; painting affects only the isolated mesh; export round-trips both meshes (unzip → both meshes' geometry intact). With the single-mesh sample — panel shows 1 mesh; splitting adds part rows; isolating a split part shows only it, recentered; normal export still round-trips.

## Risks

- The load/export round-trip is a core path with **no existing Node test**; the new `parseMeshes`/`rebuildModelFile` unit tests + a browser round-trip check (single-mesh **and** multi-mesh) are the guard. Single-mesh behavior must be byte-equivalent to today.
