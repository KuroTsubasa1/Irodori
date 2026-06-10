# Split Part Thickness + Row Layout (Batch L) — Design

**Date:** 2026-06-10
**Status:** Approved

## Problem

1. A color-split part is the painted patch plus a cap meeting it **at the rim**
   — a lens whose thickness tapers to zero at every split edge. On shallow
   regions (the belly) wide bands are unprintably thin.
2. The radial explode scatters parts; the user wants parts **laid out next to
   the model** instead.

User choices: Thickness **slider, default 1.2 mm** (0 = legacy knife-edge);
layout = **row beside the model** on the build plane, replacing the explode.

## 1 · Minimum-thickness plugs (`js/split.js` only)

`solidFromSubs(mesh, subs, method, thickness)` gains the 4th parameter.
With `thickness > 0` and a non-empty boundary:

- **Inward directions:** while emitting the conformed surface, accumulate
  area-weighted face normals per local vertex; a rim vertex's inward direction
  is its negated normalized accumulator (the patch's smooth normal).
- **Offset rim:** every rim vid maps to `p − n̂·t`.
- **Recessed cap:** `Caps.triangulateLoops(loops, getPt, method)` is called
  with `getPt` returning the **offset** coordinate — caps.js is untouched; all
  five methods and the outer+hole classifier run on the recessed rim
  unchanged. `orientCapComponents(cap, surfDir)` still votes on vid-keyed rim
  edges (the offset is a continuous deformation; winding semantics are
  identical).
- **Descriptor rewrite + wall:** the final cap descriptor keeps
  `verts = rim vids` (welded — the wall attaches to the real surface), then
  `extraPts = [offset copy of each rim vid] ++ [cap interior points]`, and
  every cap-triangle ref `r` shifts by `nR = verts.length` (`r → r + nR`,
  one formula for both ranges). The **wall** is emitted per surface-directed
  boundary edge `u→v` (from `bEdge` count==1 entries, the same source as
  `surfDir`): triangles `(iv, iu, iu′)` and `(iv, iu′, iv′)` — this opposes
  the surface's `u→v`, gives each vertical edge both directions across
  adjacent quads, and traverses the offset edge `iu′→iv′` exactly opposite
  to the oriented cap → **directed-watertight by construction**. Edges whose
  vids fell out of a dropped (pinch) chain are skipped, matching the legacy
  warning path.
- Wall and cap triangles carry the part state (same `capState` push as
  today). `thickness === 0` (or no boundary) is byte-for-byte the legacy path.
- **Everything downstream is unchanged**: the descriptor format is the same,
  so `remainderSolid` (reversed → pocket), the live hole-fill preview
  (`capMeshFor`), and `exportSplit` consume plugs without modification.
- Known v1 limit: a tight concave rim with large `t` can self-intersect the
  skirt; the slider keeps `t` in the user's control (0–5 mm).

## 2 · Row layout (`Split.layoutParts` + `js/viewer.js`)

- New pure `Split.layoutParts(bodyBox, partBoxes, margin)` →
  per-part `[dx, dy, dz]` offsets. Boxes are `{min:[x,y,z], max:[x,y,z]}`.
  Parts line up along **+X**: the cursor starts at `bodyBox.max.x + margin`;
  each part is translated so its min-x sits at the cursor, its **y center
  matches the body's y center**, and its **min-z aligns with the body's
  min-z** (resting on the same base plane); cursor advances by part width +
  margin.
- `viewer.js setSplitParts`: part targets come from
  `layoutParts(bodyBoundingBox, partBoundingBoxes, 0.06 × body diagonal)`
  instead of the radial offset; `EXPLODE_K` and the Batch-J clearance floor
  are removed. Per-id position carry-over, the animation lerp, `pinPart`,
  `setPartVisibility`, and `capMeshFor` are untouched.

## 3 · UI (`index.html`, `js/app.js`)

- Split panel gains `Thickness` + `<input type="range" id="splitThick"
  min="0" max="5" step="0.1" value="1.2">` + a `#splitThickVal` readout
  ("1.2 mm", updated on input).
- `doSplit` stores `thickness: +$("splitThick").value` on the part.
- A `change` listener mirrors the `capMethod` one: re-thicken all existing
  parts + `pushHistory("Thickness: X mm")` + render.
- History snapshots (`snap`/`restore`) carry `thickness` per split (like
  `method`).
- `viewer.js:434` and `threemf.js exportSplit` pass `p.thickness || 0` as the
  4th argument to `solidFromSubs`.

## Testing (61 → 64)

- `layoutParts`: slots strictly beyond the body's max-x, non-overlapping
  x-ranges with margins, y centers and z minimums aligned.
- **Exact plug volumes** on `makeClosedCube`: part = the two top faces with
  `t = 0.5` → a 2×2×0.5 box: part volume = 2, remainder volume = 6, sum 8;
  both directed-watertight; every offset point exactly `t` beneath its rim
  vertex; wall triangles = 2 × rim edges; `t = 0` reproduces the legacy
  triangle count.
- Tube-band skirt: a band of `makeOpenTube` with `t > 0` stays
  directed-watertight under liepa AND earcut (two-ring boundary → two skirts).
- All existing split/caps tests pass unchanged (default path is `t = 0`
  unless passed).
- Browser: belly split at 1.2 mm → visibly thick plug rim + matching pocket;
  slider re-thickens live with undo; parts line up in a row beside the model
  bottoms-aligned; pin/isolate/export unchanged.

## Non-goals (v1)

Self-intersection repair for large `t`, per-part thickness overrides, grid
layout, layout for the plane-cut halves (they're objects, not split parts).
