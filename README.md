# 3MF Color Fixer

A browser tool to load painted **.3mf** models (Bambu Studio / PrusaSlicer
multi-color "paint" format), view them in 3D, and remove **stray-color islands**
— the small blobs and thin lines of a wrong color that appear at boundaries when
an AI tool quantizes a textured model down to a few filaments.

Everything runs locally in your browser. Nothing is uploaded.

## Use it

1. Open **`index.html`** in a browser (double-click it, or `open index.html` on
   macOS). No install or server needed.
2. **Load a .3mf** (button or drag-and-drop). The model appears in 3D — drag to
   rotate, scroll to zoom.
3. In **Island cleanup**, set *Max island size* (how big a wrong-color patch can
   be and still get removed), click **Preview** (changed sub-triangles flash
   pink), then **Apply**.
4. Use the **Filaments** checkboxes to control which colors are allowed to be
   removed (e.g. untick a color to protect small intentional details of it).
5. Click **Export corrected .3mf** to download `<name>_fixed.3mf`. Open it back
   in Bambu Studio.

**Undo / Redo** (buttons or ⌘/Ctrl-Z and ⌘/Ctrl-Shift-Z) step through your full
edit history. **Reset to original** jumps back to the loaded file. Cleanup only
ever changes colors, never geometry.

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
