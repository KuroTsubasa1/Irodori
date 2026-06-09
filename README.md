# 彩 Irodori — 3MF Color Fixer

*Irodori (彩)* — "the tasteful arrangement of color."

A browser tool to load painted **.3mf** models (Bambu Studio / PrusaSlicer
multi-color "paint" format), view them in 3D, and remove **stray-color islands**
— the small blobs and thin lines of a wrong color that appear at boundaries when
an AI tool quantizes a textured model down to a few filaments.

Everything runs locally in your browser. Nothing is uploaded.

## Use it

Open **`index.html`** in a browser (double-click, or `open index.html`). No
install or server needed. The window is a small editor: a centered **toolbar**
on top with an **options strip** beneath it (the active tool's settings + color
palette), the **workflow** on the left, and the **3D view** filling the rest.

1. **Load a .3mf** (button or drag-and-drop). The model appears upright (the
   viewer is Z-up, matching the slicer).
2. **Auto-clean** (left): set *Patch size*, **Preview** (changes flash cyan),
   then **Clean**. Toggle off any **color** you want protected. The size slider
   is logarithmic; type an exact value (up to 50000) for bigger patches.
3. Tools (top bar), each with options on the right and a shared color palette:
   - 🖐 **Orbit** — look around (drag / scroll / right-drag pan).
   - ⟲ **Rotate** — turn the model in 90° steps; baked into the saved file.
   - 🖌 **Brush** — left-drag to paint with the selected color (right-drag still
     rotates); adjustable size.
   - ◍ **Ring** — click a feature to wrap a colored band around it at that
     height; place two and let the slicer fill between them.
   - 🪣 **Fill** — click a patch to flood its connected region (to a color, or
     *Auto* = the surrounding color).
4. **Export** (top right) downloads `<name>_fixed.3mf`. Open it in Bambu Studio.

**Undo / Redo** (buttons or ⌘/Ctrl-Z, ⌘/Ctrl-Shift-Z) step through edits.
**Reset to original** reverts color edits. The **◐** button toggles the
backdrop light/dark; **⤢** refits the view.

## How the cleanup works

The slicer paints individual **sub-triangles**, so a stray color usually lives on
just *part* of a boundary face — a yellow/black face with a thin red sliver
through it. Working at the face level can't fix that, so the tool operates on
sub-triangles:

1. Every face is tessellated into its leaf sub-triangles (the exact pieces the
   slicer paints).
2. A graph connects sub-triangles that share an edge. Where a subdivided face
   borders a less-subdivided one the edges don't line up (a *T-junction*); these
   are resolved by splitting the coarse edge at the neighbor's midpoints, so
   connectivity is correct.
3. Same-color regions are found as connected components. A real feature (the red
   ball) is one big region; artifacts are thousands of tiny ones. Any region of
   *≤ Max island size* sub-triangles is recolored to the color it borders most.

On the reference model, red fragments into **12,288 connected regions**; cleanup
at size 60 reassigns ~31,000 stray sub-triangles and leaves about **100** real
red regions (the ball and large patches). Only the leaves that change are
rewritten and their face re-encoded; everything else is preserved exactly.

## Fill tool

The fill tool reuses the same sub-triangle graph for manual fixes. A ray cast
from your click finds the sub-triangle under the cursor; the tool floods its
connected same-color region and recolors it — to a color you pick, or to the
surrounding majority (*Auto*). Each click is one undo step. Because a recolor
doesn't change geometry, the graph stays cached, so repeated fills are instant.

## The `paint_color` format (reverse-engineered)

Bambu/Prusa store per-triangle paint as a hex string whose **nibbles are read
right-to-left**. Each node is one nibble: the low 2 bits are `split_sides`
(`0` = leaf), the high 2 bits are the payload.

```
node:
  split = nibble & 0b11
  field = nibble >> 2
  if split == 0:                         # leaf
      if field != 0b11: state = field                 # states 0..2
      else:                                            # escape
          s2 = nextNibble
          if s2 != 0b1110: state = s2 + 3             # states 3..16
          else: state = (lo | hi<<4) + 17             # states 17..255
  else:                                  # split into (split+1) children
      special_side = field
      children = (split + 1) nodes, read recursively
```

`state` is the 1-based filament index (state 0 = the object's default extruder);
colors come from `filament_colour` in `Metadata/project_settings.config`. The
codec in `js/paint.js` decodes and re-encodes all 199,672 triangles of the
sample with zero loss.

## Files

| File | Role |
|------|------|
| `index.html`, `css/style.css` | UI |
| `js/paint.js` | `paint_color` decode/encode codec |
| `js/threemf.js` | unzip/parse `.3mf`, rewrite & repackage on export |
| `js/cleanup.js` | sub-triangle graph (T-junction-aware), connected-component island removal |
| `js/viewer.js` | three.js rendering (per-face filament colors) |
| `js/app.js` | wiring: load, preview/apply, stats, export |
| `vendor/` | three.js r128, OrbitControls, JSZip (bundled for offline use) |

## High-resolution rendering

A face can be painted in pieces — the slicer subdivides boundary triangles and
paints each sub-triangle. The viewer reproduces this exactly: every face's paint
tree is tessellated into its leaf sub-triangles using the same geometry as
`TriangleSelector::perform_split` (corners rotated by `special_side`, edges split
at midpoints, children consumed in reverse order). On the sample this expands
199,672 faces into **544,468 painted sub-triangles**, matching what you see in
Bambu Studio rather than a one-color-per-face approximation. Geometry was
verified to partition each face to floating-point precision, and the
sub-triangle color placement was cross-checked by edge-coherence (86% of shared
sub-edges agree, vs 75% for the wrong child order).

## Notes & limits

- Island size is measured in **sub-triangles**, which vary in size with
  subdivision depth. If some stray patches survive, raise the threshold; if real
  details disappear, lower it or untick that color. Preview before applying.
- Building the sub-triangle graph takes ~1–2 s on a 200k-face model; it's cached
  until the next edit.
- Cleanup is color-based, not geometry-based, so it's safe to re-slice the
  result. Always sanity-check the export in your slicer.
