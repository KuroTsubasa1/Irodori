# Split Correctness (Batch E) — Design

**Date:** 2026-06-10
**Status:** Approved (ready for implementation plan)

## Summary

Four fixes to the split tool, all root-caused by reproduction on the user's
`Meshy_AI_Pikachu and the Red Ball_fixed.3mf` (black ear tip → adjacent yellow
band):

1. **Cap loop classifier** — a band/stripe region's two stacked end-rings are
   misclassified as outer+hole (they project onto each other on the shared
   best-fit plane), so earcut emits one annulus membrane spanning the band
   (4,820 tris across the full z-extent, 312 non-manifold edges on the repro)
   or, when degenerate, drops the second loop entirely. This is the "ends not
   filled" + "grey artifact" bug. Fix: a loop counts as a hole only if it is
   **near-coplanar** with the outer.
2. **Live hole-fill color** — the viewer's remainder cap is hardcoded grey;
   it must use the surrounding (majority bordering) color like the export does.
3. **Explode clipping** — all parts displace the same distance (`unit dir ×
   r·K`), so adjacent parts barely separate (repro: 1.68 → 1.96). Fix:
   **proportional** displacement `(centroid − center) × K`; every pair's
   separation grows ×(1+K). K raised 0.45 → 0.8.
4. **Claimed-flood guard** (hardening) — `selectColorRegion` can flood into an
   already-claimed same-color neighbor region, double-claiming subs. The flood
   gains an exclude set.

Touches `js/caps.js`, `js/split.js`, `js/viewer.js`, `js/cleanup.js`,
`js/app.js`. Items 1 and 4 are Node-tested; 2 and 3 are browser-verified.

## Non-goals

- No collision-aware explode solver (proportional displacement only).
- No change to the pinch-vertex limitation or the residual non-manifold edges
  on fractal paint rims (pre-existing, documented; Bambu repairs on import).
- Ring/fill/paint tools unchanged (Batch F).

## Design

### 1. Coplanarity-gated hole classification (`js/caps.js`)

In `triangulateLoops`'s earcut/cdt block, each per-loop record gains
`d` = the loop's mean offset along the shared plane normal:
`d = mean over the loop's points of n·(p − origin)` (computed from the 3-D
points, not the projection). The grouping rule becomes:

```
hole(hi of outer oi) ⇔ inPoly(L[hi].centroid2, L[oi].poly2)
                        AND |L[hi].d − L[oi].d| ≤ COPLANAR_FRAC · sqrt(L[oi].area)
```

with `COPLANAR_FRAC = 0.25`. Genuine flat caps with island holes have
`|Δd| ≈ 0` and keep working; stacked end-rings (|Δd| ≈ band height ≫
0.25·ring size) become **independent outers**, each capped separately.
Both earcut and cdt share this classifier. Loops that fail the coplanarity
test simply continue through the existing "independent outer" path.

### 2. Live fill color = majority bordering color (`js/split.js`, `js/viewer.js`)

`majorityBorderColor(mesh, g, part)` (already used by `remainderSolid`) is
added to the `global.Split` export. `capMeshFor(part, solid)` in the viewer
replaces the constant grey `CAP_FILL` material color with
`linColor(Split.majorityBorderColor(doc.meshes[part.meshIndex],
Cleanup.buildSubGraph(doc.meshes[part.meshIndex]), part))`. (`part` carries
`subs` and `state`, which is all `majorityBorderColor` reads.) The grey
constant is removed.

### 3. Proportional explode (`js/viewer.js`)

In `setSplitParts`, the target offset becomes
`target = (partCenter − modelCenter) × EXPLODE_K` (vector scale, no
normalization), with `EXPLODE_K = 0.8`. Degenerate case (part centered at the
model center): fall back to `(0, 0, 1) × (r · 0.15)`. Position carry-over by
part `id` (Batch A) is unchanged — only `target` computation changes, so
existing parts glide to their new proportional positions on the next render.

### 4. Claimed-exclusion flood (`js/cleanup.js`, `js/app.js`)

`Cleanup.selectColorRegion(mesh, seedSub, exclude)` gains an optional
`exclude: Set<localSub>`; excluded subs are treated as not-same-state (the
flood neither enters nor returns them). `app.js` passes the mesh's claimed-sub
set in **both** places that flood for the split tool: `doSplit` and the
split-tool hover preview in `onHover` (so the preview always matches what the
click would take). The claimed set for a mesh is derived exactly as
`claimedByMesh()` does today.

## Testing

- **Unit (`node --test`; suite currently 30):**
  - Stacked square loops (z=0, z=5) through `Caps.triangulateLoops` for
    earcut **and** cdt: 2 independent caps — 4 tris total, **0 extraPts**, no
    triangle mixes the two loops' vertices, and each loop's 4 edges appear in
    the cap exactly once. (Currently fails: one loop is silently dropped /
    annulus.)
  - Regression: the coplanar square+hole tests keep passing (8 tris).
  - New harness fixture `makeOpenTube()` — a cuboid's 4 side faces split into
    8 triangles (8 verts, two square rims, no top/bottom). 
    `Split.solidFromSubs(tube, all, "earcut")` → **watertight** (every edge
    used exactly twice), `cap.tris.length === 4`, `cap.extraPts.length === 0`
    (two 2-tri end caps; an annulus would be watertight but 8 tris, the old
    drop-one-loop failure would be 4 tris + 1 extraPt and not watertight).
  - `selectColorRegion` with an exclude set skips excluded members (tetra
    fixture: exclude one state-1 sub → region is the remaining 2).
- **Browser-verified (the user's repro):** load the `_fixed.3mf`, split the
  black ear tip, then the yellow band, then the black stripe below it — each
  part lifts out with **both ends capped in the part's own color**, the
  remainder holes fill with the **surrounding color** (not grey), no floating
  grey membrane, and the exploded parts separate without clipping into each
  other. Undo/redo across the three splits stays consistent.
