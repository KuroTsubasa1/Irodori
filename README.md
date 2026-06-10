# 彩 Irodori — 3MF Color Fixer

*Irodori (彩)* — "the tasteful arrangement of color."

A browser tool to load painted **.3mf** models (Bambu Studio / PrusaSlicer
multi-color "paint" format), view them in 3D, and remove **stray-color islands**
— the small blobs and thin lines of a wrong color that appear at boundaries when
an AI tool quantizes a textured model down to a few filaments.

Everything runs locally in your browser. Nothing is uploaded.

## Features

- **Paint tools** — brush (slicer-grade edge refinement on release), ring
  (band wraps the local feature, axis follows the surface normal), and fill —
  each with an on-surface hover preview. X/Y/Z mirror painting, combinable.
- **Colors** — paint with the model's filaments, add new ones (exported as
  real sliceable filaments), delete added colors (undoable).
- **Auto-clean** — recolors small stray same-color patches to match their
  surroundings, with preview.
- **Split by color** — lift any connected colored region out as a watertight
  solid (selectable cap methods; Liepa smooth fill by default) and export all
  parts + the remainder as separate objects in one `.3mf`.
- **Scene** — objects panel with isolation view, multi-mesh `.3mf` round-trip,
  90° rotations, undo/redo, keyboard shortcuts (O/R/B/N/F/S).
- Exports normalize every filament to **Generic PLA**.

## Development

No build step — vanilla JS served statically:

    python3 -m http.server 8000     # then open http://localhost:8000

(After editing `js/`, restart on a new port or hard-reload — the browser
caches modules aggressively.)

    npm test                        # Node's built-in runner, 52 tests

The reference model lives in `samples/`. See `CLAUDE.md` for the module map
and contributor conventions.

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
