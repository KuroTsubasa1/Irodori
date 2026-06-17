# Liepa Hole Filling (Batch I) — Design

**Date:** 2026-06-10
**Status:** Approved (ready for implementation plan)

## Summary

Add **Liepa's hole-filling pipeline** (the MeshLab/libigl/PMP classic) as a new
cap method and make it the **default**: minimum-weight triangulation of each
boundary loop **directly in 3-D** (no plane projection), then refinement
(interior vertices to match rim density), then Laplacian fairing — producing
smooth, curvature-following caps instead of earcut's faceted projected lids.

New pure module `js/liepa.js` (`window.Liepa`, Node-tested); `js/caps.js`
dispatches to it; UI/viewer/export defaults flip to `"liepa"`. Earcut/CDT/
projected/centroid stay selectable.

## Why

All current methods project the rim onto a best-fit plane and only connect
existing rim vertices: wavy 3-D paint rims become crumpled faceted membranes,
strongly curved rims can self-overlap in projection, and no interior points or
smoothing exist. Liepa's pipeline solves each structurally (user picked this —
option C — over the cheaper refine-and-fair-only and advancing-front options).

## Module API

```
Liepa.fillLoop(loop, getPt, opts?) -> { extraPts: number[][], tris: [[i,j,k]] }
```
- `loop`: ordered vertex ids (one boundary loop, first not repeated);
  `getPt(vid) -> [x,y,z]`.
- Triangle index convention (loop-local): `i < loop.length` → the i-th loop
  vertex; `i >= loop.length` → `extraPts[i - loop.length]`. `Caps` splices
  these into the shared cap descriptor exactly as the centroid branch does.
- `opts`: `{ maxCoarse = 200, refine = true, fair = true }` (test hooks).

## Pipeline (per loop)

1. **Decimate** — walk the rim accumulating chord length; keep a vertex each
   time the accumulated length reaches `totalLength / min(n, maxCoarse)`
   (always keeping vertex 0); result ≤ `maxCoarse` coarse vertices in rim
   order. (v1 is uniform-by-arclength; curvature-adaptive is a noted upgrade.)
2. **Minimum-weight DP triangulation** of the coarse polygon in 3-D
   (Barequet–Sharir/Liepa): `W(i,j) = min over k of W(i,k) + W(k,j) +
   weight(i,k,j)` with Liepa's **lexicographic weight (maxDihedral, area)** —
   the dihedral measured between cap triangles chosen by the DP (the
   surface-boundary dihedral term is omitted in v1; fairing compensates).
   O(n³) with n ≤ 200.
3. **Strip reattachment** — for each coarse edge spanning skipped fine rim
   vertices, run the **same DP** on the small strip polygon
   `[Vi, f1..fm, Vj]`, so every original rim edge is covered exactly once and
   the strip/coarse interface edges pair up — watertight by construction.
4. **Refine** (Liepa) — per triangle with centroid `m` and per-vertex scale
   `σ(v)` (mean adjacent rim/inserted edge length): if
   `√2·|m − vᵢ| > max(σ(m), σ(vᵢ))` for all three corners, insert `m`
   (1→3 split, `σ(m)` = corner mean); then relax **interior** edges by the
   empty-circumsphere test (flip edge (a,b) with opposites c,d when d lies
   inside the minimal circumsphere of (a,b,c) — center in the triangle's
   plane); iterate splits+flips until stable or 10 passes. Rim edges are never
   flipped or split.
5. **Fair** — iterative uniform-Laplacian (umbrella) relaxation of **interior
   points only** (λ = 0.5), rim pinned; stop at max displacement
   `< 1e-3 × mean rim edge length` or 300 iterations. (v1 membrane fairing;
   biharmonic is a noted upgrade.)

**Degenerate guards:** loops with < 3 vertices are skipped; any stage throwing
falls back to the centroid fan **for that loop** (preserving the
always-watertight guarantee, matching the earcut/cdt fallback pattern).

## Integration

- `Caps.triangulateLoops(loops, getPt, "liepa")` fills **each loop
  independently** via `Liepa.fillLoop` (like the centroid/projected family).
  Documented limit: a flat cap with an enclosed island hole still needs
  earcut/cdt (which keep the outer+hole nesting); rare in practice.
- **Defaults flip to `"liepa"`:** the dropdown gains
  `Liepa (smooth)` as the selected option, and the `p.method || "earcut"`
  fallbacks in `viewer.js setSplitParts` and `threemf.js exportSplit` become
  `p.method || "liepa"`. `solidFromSubs`'s function-level default stays
  `"centroid"` (dependency-free path, legacy tests).
- **Watertightness + shared cut surface are preserved automatically:** the rim
  never moves; refined/faired interior points ride the existing `extraPts`
  channel, so the part cap and the remainder's reversed cap remain coincident;
  assembler, undo snapshots, live hole-fill, and export are untouched.
- Load order: `js/liepa.js` before `js/caps.js` in `index.html` and
  `tests/harness.js` (harness returns `Liepa`).
- Performance: DP at n = 200 ≈ 1.3M cheap evaluations; the full pipeline per
  loop stays well under ~200 ms on the reference ear-band rims (~2,200 fine
  vertices, decimated to 200).

## Implementation outcome (real-data amendment)

First contact with the reference ear band exposed a design flaw the synthetic
tests missed: **fractal paint rims** have edge scales ~100× smaller than the
opening, so "match the rim's density" demanded millions of cap triangles —
Node OOM'd at 4 GB and the browser spent 222 s before the per-loop fallback
silently emitted centroid fans. The shipped fix (commit `7fc050d`):

- **σ floor + triangle budget**: `σ_floor` = the edge length that tiles the
  cap's own area in ≤ `maxTris` (3,000) equilateral triangles; per-vertex σ is
  floored by it, and splitting halts at the budget. Scale-free and bounded.
- Split passes snapshot the triangle list (children reconsidered next pass,
  ≤ 10 generations); flip relaxation runs as **sweeps** over a per-sweep edge
  map with a staleness guard (the rebuild-per-flip approach is gone).
- `maxCoarse` default 200 → **120** (visual difference vanishes after
  refine+fair; DP cost drops ~4×).
- The per-loop centroid fallback now **warns to the console** (no silent
  degradation).

Measured on the reference band (2,108- and 2,712-vertex rims): **~1.2 s
total**, 3,000 tris + real refined interior points per loop, watertight. A
fractal-rim regression test (1,200 fine vertices, default options, < 5 s,
budget held, rim covered exactly once) pins this.

A second review-driven round (commit `8f3f2df`) fixed two winding issues:

- **Direction-aware edge flips.** The flip rewrite assumed the sorted edge key
  matched the triangle's stored edge direction, inverting ~35 % of cap
  triangles (watertight-by-edge-count tests are winding-blind; the viewer's
  double-sided material masked it). Flips now check the actual direction.
- **Fan strips instead of polygon-DP strips.** Fractal fine chains weave
  across their coarse chord, making the strip polygon self-intersecting — any
  polygon triangulation of it folds. Strips are now an endpoint fan; the
  residual sign-alternating **micro-sliver folds in the rim band are inherent
  to rim-vertex-only strip triangulations of weaving chains** and are accepted
  (sub-print scale, orientation-consistent, watertight; visible only as a
  faint brushed texture at the rim).
- The winding regression asserts the principled invariants: zero
  double-directed edges, every rim edge traversed loop-forward exactly once,
  and strongly-inverted triangles carrying **< 2 % of cap area** (the flip bug
  scored ~30 %; micro-slivers stay well under the bound).

## Testing

- **Unit (`node --test`):**
  - `dpFill`: a planar square → 2 triangles; a bent (non-planar) quad → the
    diagonal giving the flatter pair (smaller max dihedral) is chosen;
    a triangle passes through unchanged.
  - Decimation + strips: a 100-vertex wavy circle → every fine rim edge
    appears in the cap's boundary exactly once (edge-use counting), coarse
    count ≤ `maxCoarse`.
  - Refine: with a small σ rim, `extraPts.length > 0` grows and rim-edge
    coverage stays exactly once; flips never touch rim edges.
  - Fair: interior points move, rim points are byte-identical, and each
    interior coordinate stays within the rim's bounding range (harmonic
    maximum principle).
  - Integration: `"liepa"` joins the all-methods **watertight** tests (tetra
    bowl in `split.test.js`, open tube) — every edge used exactly twice.
- **Browser:** split the reference ear band with the new default — the part's
  end caps are smooth and follow the opening (no faceted lid, no membrane);
  remainder fill matches; method switching re-caps as before.
