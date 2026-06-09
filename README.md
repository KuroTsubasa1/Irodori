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
   be and still get removed), click **Preview** (changed faces flash pink), then
   **Apply**.
4. Use the **Filaments** checkboxes to control which colors are allowed to be
   removed (e.g. untick a color to protect small intentional details of it).
5. *(optional)* **Boundary seam cleanup** removes thin sub-triangle slivers of a
   chosen color sitting inside two-color boundary faces.
6. Click **Export corrected .3mf** to download `<name>_fixed.3mf`. Open it back
   in Bambu Studio.

You can **Reset to original** at any time; cleanup only ever changes colors,
never geometry.

## How the cleanup works

Each triangle's color is read, then faces are grouped into connected same-color
regions (sharing an edge). A genuine feature — e.g. the red ball — is one large
region; quantization artifacts are hundreds of tiny regions. Any region with
*≤ Max island size* faces is recolored to the color it borders most. On the
reference Pikachu model this turns **488 stray red patches into 0** while keeping
the two large red ball regions untouched.

Only the faces that actually change are rewritten (as a solid color). Every
untouched face — including the careful sub-triangle painting along real
boundaries — is preserved exactly in the exported file.

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
| `js/cleanup.js` | adjacency, connected-component island removal, sliver cleanup |
| `js/viewer.js` | three.js rendering (per-face filament colors) |
| `js/app.js` | wiring: load, preview/apply, stats, export |
| `vendor/` | three.js r128, OrbitControls, JSZip (bundled for offline use) |

## Notes & limits

- The 3D view colors each face by its **dominant** filament; thin sub-triangle
  boundary detail is simplified on screen but preserved in the exported file.
- Cleanup is color-based, not geometry-based, so it's safe to re-slice the
  result. Always sanity-check the export in your slicer.
