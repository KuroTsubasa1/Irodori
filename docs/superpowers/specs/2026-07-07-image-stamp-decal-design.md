# Image stamp-map (decal) tool

## Problem

There is no way to apply an image-based motif (logo, text, symbol) to a model's
paint. Users want to upload a black & white image and project it onto the
surface at a chosen spot, so dark pixels become painted regions in the current
filament color.

## Overview

A new `stamp` tool. Upload a B&W image → it becomes a luminance mask. Pick a
point on the mesh → the image projects onto the surface there as a decal (a
sticker oriented to the surface normal). Dark pixels paint the current filament
state; light pixels are transparent (leave existing paint untouched). Placement
is live-previewed with size and rotation controls; the user confirms to commit.

This reuses the existing sub-triangle graph, picking, live-tint preview, and the
`paintStamps` refinement convention. Edge fidelity is a toggle mirroring the
brush refine toggle (see `2026-07-07-brush-responsiveness-design.md`).

## Decisions (from brainstorming)

- **Projection:** decal at a picked point, oriented to the surface normal.
- **Pixel mapping:** black paints (current filament), white is transparent
  (stencil mask), threshold adjustable, invertible.
- **Edge fidelity:** toggle, default crisp/subdivide (reuses paintStamps-style
  refinement); off = whole-leaf, no added geometry.
- **Placement UX:** live preview on hover, size/rotation sliders, click to drop,
  Apply to commit.
- **Projection depth:** front-facing only, shallow depth band (guards thin-wall
  bleed-through).
- **Mirror symmetry:** deferred (YAGNI) — not wired for the stamp tool initially.
- **Aspect ratio:** preserve the image's aspect; `size` sets the longest edge.

## Components

### 1. UI — `index.html` + `app.js`

New toolbar button `data-tool="stamp"` and options panel `data-panel="stamp"`:

- **Upload image:** `<input type="file" accept="image/*">`. On change, decode to
  an offscreen canvas and precompute a luminance mask (`0..255` per pixel, plus
  width/height). Color images are reduced to luminance. Computed once per upload.
- **Threshold** slider `0..255`, default `128`. Luminance below threshold →
  "paint".
- **Invert** checkbox — flips the paint/transparent sense.
- **Size** slider — world-space extent of the decal's longest edge.
- **Rotation** slider `0..360°` — spin of the image around the surface normal.
- **Refine edges** checkbox, checked by default — same semantics as the brush
  toggle.
- Current `paintState` (shared palette) is the color dark pixels receive.

The panel follows existing `data-panel` show/hide wiring in `setTool`. The
palette is shown for this tool (`paintTool`-style handling).

### 2. Projection geometry — new module `js/decal.js`

Pure, testable functions (loaded as an IIFE attaching to `window`, per project
convention; add to `index.html` script order after `select.js`).

- **Tangent frame** at the pick point: `n` = picked face normal; `up` =
  world-up projected onto the tangent plane, then rotated by the Rotation slider
  about `n` (fallback to camera-up if world-up is near-parallel to `n`);
  `right = normalize(up × n)`. Frame origin = pick point.
- **Footprint selection:** candidate leaves are those whose centroid, expressed
  in the decal frame, falls within the decal rectangle (size scaled by image
  aspect), AND is front-facing (`leafNormal · n > 0`), AND within a shallow
  depth band `|(centroid − origin) · n| ≤ depthBand`. `depthBand` is a small
  fixed fraction of `size` (constant, not a user control in v1).
- **UV mapping:** for a point `p`, `u = ((p − origin)·right)/w + 0.5`,
  `v = ((p − origin)·up)/h + 0.5`, where `w`,`h` are the decal's world
  half-extents. `sampleMask(u, v)` returns paint/skip via threshold+invert;
  out-of-`[0,1]` = skip.

### 3. Edge fidelity — reuse the refinement machinery

- **Refine on:** generalize the `paintStamps` recursion. The subdivide predicate
  becomes "the mask decision disagrees across this leaf's three corners" (rather
  than "straddles the stamp circle"). Straddling leaves subdivide via the exact
  `Paint.tessellate` convention, depth-capped (`maxDepth` ~4); at max depth the
  leaf is decided by its centroid sample. Factor the shared recursion so both the
  circle-stamp and mask-stamp predicates drive the same walker, or add a
  parallel `stampMask` entry alongside `paintStamps` in `cleanup.js` that takes a
  sampler callback. Implementation picks whichever keeps the tessellation
  convention in one place.
- **Refine off:** whole-leaf — paint each candidate leaf whose centroid samples
  as "paint" via `applyStates` (no geometry added, graph stays valid).

### 4. Preview & commit flow — `app.js`

- **Hover:** project a live whole-leaf tint preview (cheap, like the brush's
  live preview) so placement stays responsive; size/rotation/threshold sliders
  re-project the preview live. Uses `Viewer.paintSubs` tinting, not real paint.
- **Click:** freezes the decal position (stops tracking hover).
- **Apply** button: commits the real projection (with refinement if enabled)
  under `busy("Stamping…")`, then `pushHistory("Stamp")`, re-warm the sub-graph
  (per brush-responsiveness spec B), `render(null)`, `updateStats()`.
- **Cancel** button: discards the frozen decal and clears the preview tint.
- Switching tools or picking a new point before Apply discards the pending decal.

## Non-goals (v1)

- No mirror/symmetry for the stamp tool.
- No grayscale→palette ramp; strictly threshold (two-way: paint / transparent).
- No user-facing depth-band control (fixed constant).
- No UV-texture / whole-object wrap.
- No persistence of the uploaded image across page reloads.

## Testing

- **`decal.js` (pure):** given a synthetic tangent frame + mask, assert
  `sampleMask` threshold/invert behavior and that footprint selection includes
  only in-rectangle, front-facing, in-depth-band leaves.
- **Refinement regression:** a fully-"paint" mask over a footprint paints all
  candidate leaves; a half/half mask splits along the boundary (leaf count grows
  only near the edge); refine-off adds no leaves. Watertightness unaffected
  (states-only for whole-leaf; tessellation reuses the tested convention).
- **UI / preview:** manual browser verification (upload, place, adjust sliders,
  Apply, undo).
