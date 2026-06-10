# Colors + Symmetry (Batch B) — Design

**Date:** 2026-06-10
**Status:** Approved (ready for implementation plan)

## Summary

Two medium features from the backlog:

1. **Add new colors (W5)** — a "+" in the palette adds a new filament (chosen via a native color picker) that's immediately paintable and **slices as a real, distinct material** (written into `project_settings.config` on export).
2. **Brush symmetry (W4)** — a symmetry toggle + **X/Y/Z axis** in the Brush options mirrors each brush stroke across the model's center.

Touches `js/app.js` (palette + brush UI/stroke), `js/cleanup.js` (mirror map), `js/threemf.js` (export config extension + a pure, testable helper), `index.html`, `css/style.css`.

## Non-goals

- Symmetry for ring/fill/auto-clean (brush only, per the request).
- Editing/removing existing filament colors (only adding).
- Deleting added filaments (out of scope; undo covers mistakes).
- Auto-detecting the symmetry plane (user picks the axis; plane is the model center).

## Design

### W5 — Add new colors

**Palette as the filament list.** Today `buildPalette()` is built from `gatherStates()` (only states present in the mesh), so a brand-new filament with no painted faces wouldn't appear. Change `buildPalette()` to iterate **`doc.filaments`** (one swatch per filament index `1..N`) — the set of colors you can paint *with*, used or not. The left-sidebar "Colors to clean" list keeps using `gatherStates()` (what's actually in the model); only the paint palette changes source. After the swatches, render a **"+" add-swatch**.

**Adding.** The "+" swatch triggers a hidden `<input type="color">`. On its change, append `{ index: doc.filaments.length + 1, hex }` to `doc.filaments` (hex = the picker's `#RRGGBB`), rebuild the palette, and `selectPaint(newIndex)`. The new filament is now a normal paint color (its state index = its filament index). Painting it writes that state via the existing `paint_color` codec (supports states to 255).

**Export — make it a real filament.** Track the original count at load: `ThreeMF.load` returns `origFilamentCount = filaments.length`. In `exportZip`, after the mesh round-trip, if `doc.filaments.length > doc.origFilamentCount` **and** a `project_settings.config` exists, rewrite that config via a **pure helper**:

```
ThreeMF.extendFilamentConfig(configText, origCount, filaments) -> newConfigText
```
- `JSON.parse` the config.
- For every key whose value is an array of length `=== origCount` (the per-filament arrays — 10 of them in the reference file; arrays of other lengths, e.g. 8/16, are left untouched), append `(filaments.length - origCount)` copies of element `[0]` so the new filament inherits filament-0's slicer settings.
- Set `filament_colour = filaments.map(f => f.hex + "FF")` (8-digit Bambu format; reconstructs the original `FF`-alpha entries and adds the new ones).
- `JSON.stringify` and return.

`exportZip` reads the existing config text from `doc.zip`, runs the helper, and writes it back before `generateAsync`. If there's no `project_settings.config` (fallback palette was used), skip — the added states still export as `paint_color` values (documented limitation). The `exportSplit` path already derives extruder = state index and is unaffected.

### W4 — Brush symmetry

**Mirror map (`js/cleanup.js`).** `Cleanup.mirrorMap(mesh, axis)` → `Int32Array(NS)` where entry `s` is the sub-triangle whose centroid is the mirror of `s`'s centroid across the model-center plane perpendicular to `axis` (0=x,1=y,2=z), or `-1` if none.
- Build from the sub-graph centroids `g.cen`. Center on the axis = midpoint of the centroids' min/max on that axis.
- Hash centroids into a quantized grid (`Math.round(v * QSCALE)` keys, reusing cleanup's quantization). For each sub, reflect its centroid across the plane and look up the grid; if a *different* sub is found, that's the partner.
- Cache on `mesh._mirror[axis]`; cleared by `invalidateSub` (so it's rebuilt after rotation/auto-clean, which change geometry; ordinary brush/ring/fill use `applyStates` which keeps the graph — and thus the map — valid).
- Imperfect/asymmetric models simply yield `-1` for unmatched subs (best-effort).

**Brush stroke (`js/app.js`).** Symmetry state read from the Brush options: a `#brushSym` checkbox + `#brushSymAxis` selector (X/Y/Z). In `brushAt(hit)`, after `selectRadius` returns `subs`, if symmetry is on, map each sub through `Cleanup.mirrorMap(m, axis)` and add the valid (`>= 0`) partners to the painted set; live-recolor and `applyStates` both the originals and the mirrors. (Only the Brush tool; ring/fill unchanged.)

**UI.** In the brush options panel: `Symmetry` checkbox + a small X/Y/Z `<select>` (or button group), default off. Reuses the centered options layout from Batch A.

## Testing

- **Unit (`node --test`), new — these are pure/graph logic:**
  - Load `js/threemf.js` into the test harness (its IIFE defines functions without needing JSZip until call time) and export `ThreeMF`. Test `extendFilamentConfig`: given a config with `filament_colour` of length 2 and another length-2 per-filament array plus an unrelated length-3 array, extending to 3 filaments appends one duplicate of `[0]` to each length-2 array (length-3 array untouched) and sets `filament_colour` to the three `#RRGGBBFF` values.
  - `Cleanup.mirrorMap`: on a small fixture symmetric across X (a few sub-triangles with mirror-partner centroids), assert each sub's partner is its mirror and a lone center sub maps to itself or `-1` as designed; on the (asymmetric) tetra, partners are `-1` where no mirror exists.
- **Regression:** existing suite stays green (currently 25).
- **Browser-verified:**
  - Colors: click "+", pick a color → it appears in the palette and is selected; paint with it; export and confirm `project_settings.config` in the saved `.3mf` has the new `filament_colour` entry and consistent per-filament array lengths.
  - Symmetry: enable symmetry (axis X), brush one side of the model → the mirror side is painted too; toggle off → only the brushed side paints; switching axis mirrors on the new plane.
