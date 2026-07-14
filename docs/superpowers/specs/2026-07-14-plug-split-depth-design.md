# Plug Split — inward-extruded depth for color splits

**Date:** 2026-07-14
**Status:** Approved design, pre-implementation

## Problem

The subgraph Split tool (`split.js`) turns a painted color region into its own
watertight solid. Today that solid is a **shell**: the painted surface patch
plus a flat cap across its rim (the cap lies exactly on the color boundary).
For solid objects the resulting part is thin and fragile — it carries no
material from beneath the paint. Users want a **chunkier** part that extends
into the body, so it is printable/gluable, interlocks with the remainder for
assembly, and pushes the part/remainder seam below the outer surface.

Neither split mechanism has any depth/offset/inset notion today. Adding depth
is net-new geometry.

## Key insight — the shared cap already guarantees coincidence

`solidFromSubs(mesh, subs, method)` returns
`cap = { verts, extraPts, tris, method }`:

- `verts` — global welded vertex ids on the open rim (the color boundary).
- `extraPts` — extra cap points not welded to the surface.
- `tris` — cap triangles, wound part-outward.

`remainderSolid` re-emits that **same** `cap` object with reversed winding, so
the part's cap and the remainder's plug are the identical vertices/triangles in
opposite orientation. That is why part and remainder meet exactly at the cut
with no gap and no overlap, and why both are watertight.

**We generalize the flat cap into a "socket"** and keep this contract byte-for-
byte. The part consumes the socket outward (becoming a plug with depth); the
remainder consumes it reversed (becoming the matching socket).

## Design

### 1. Socket = walls + bottom cap (generalized cap)

Given the region rim (a set of closed loops of global welded vertex ids) and a
depth `d`:

- **`verts`** — unchanged: the top loop = the color boundary rim.
- **`extraPts`** — gains the **offset rim** points: each rim vertex pushed
  inward by `d` along its inward direction (see §2).
- **`tris`** — gains, for each rim edge, two **wall triangles** connecting the
  rim edge to its offset-rim edge; plus the **bottom cap**, produced by
  triangulating the offset loop with the existing `Caps` machinery under the
  selected `capMethod` (liepa/earcut/cdt/projected/centroid).

Wall quads are wound so the part face points outward (away from the plug
interior); the remainder receives the reverse via the existing reversal in
`remainderSolid`.

**Backward compatibility:** at `d = 0` the offset rim equals the rim, the walls
are degenerate (zero-area) and must be omitted, and the socket collapses to
exactly today's flat cap. `d = 0` MUST produce output identical to the current
implementation (regression-tested).

### 2. Wall direction — per-split toggle (`#splitWallMode`)

- **Averaged** (default) — every rim point is offset along a single averaged
  inward region normal. Walls are parallel (prism / plane-offset feel). Most
  robust: cannot pinch on concave rims.
- **Per-vertex** — each rim point is offset along its own inward normal
  (average of its adjacent surface triangle normals, negated). Follows
  curvature (thickened-shell feel). May pinch/self-cross on concave or highly
  curved rims — accepted trade-off; averaged mode is the escape hatch.

"Inward" = opposite the outward surface normal. The averaged normal is the
normalized sum of the region's per-vertex inward normals.

### 3. Depth control — slider + auto-clamp to thickness (`#splitDepth`)

- A depth slider in model units; `0` = today's flat cap.
- Before building **each** part, estimate a safe maximum depth by casting
  inward rays from a sample of rim vertices along the inward direction and
  finding the nearest far-wall hit on the mesh (brute-force ray/triangle test
  over the mesh triangles; sampling the rim is sufficient — no BVH needed for
  the model sizes in scope). Take the **minimum** hit distance across the
  sampled region.
- Clamp the requested depth to ≈`0.9 ×` that minimum so the plug never exits
  the body. Clamp is **per-part**: the same slider value yields an independent
  safe effective depth for each region.
- Rays that miss (open regions, no far wall found) do not constrain the clamp;
  if no ray hits, fall back to the requested depth unclamped.

### 4. UI & rebuild flow

- Depth slider (`#splitDepth`) and wall-mode toggle (`#splitWallMode`) live in
  the split panel next to `#capMethod` in `index.html`.
- Each split part record (`splitParts[]` in `app.js`) stores its build
  parameters (depth, wall mode) alongside the existing `method`.
- Changing depth or wall mode **rebuilds all existing split parts**, reusing
  the exact re-cap pattern `capMethod` uses today (`app.js:949-956`).
- No new destructive path. Export is unchanged: `Split.buildSplitXML` /
  `ThreeMF.exportSplit`.

### 5. Where the new geometry lives

- The socket builder (rim → offset rim, walls, bottom cap) is added in
  `split.js`, invoked from `solidFromSubs`; `remainderSolid` needs no change
  because it already consumes and reverses whatever `cap`/socket object it is
  handed.
- Inward-normal computation and the raycast clamp are small pure helpers
  (usable from the `vm` test harness, which has three.js vendored — but a plain
  ray/triangle routine keeps them dependency-free and testable).

## Testing (`node --test` via `tests/harness.js`)

1. **Regression:** `d = 0` output byte-equivalent to the current flat-cap path
   (positions/indices/cap) for a representative region.
2. **Watertight (part):** at `d > 0`, the part solid passes the winding-blind
   check — every undirected edge used exactly twice.
3. **Watertight (remainder):** the remainder solid passes the same check at
   `d > 0`.
4. **Coincidence:** part and remainder share the socket — identical offset
   points and triangles, opposite winding.
5. **Clamp:** on a thin slab mesh, a large requested depth clamps below the
   wall thickness (the offset/bottom never crosses the far wall).
6. **Averaged vs per-vertex:** both wall modes produce watertight solids on a
   curved region; per-vertex is not asserted crack-free on concave rims.

## Non-goals / limitations

- **Not true CSG.** This is a naive inward extrusion; the auto-clamp prevents
  pokethrough for the common case, but extreme concave rims under per-vertex
  mode can still self-intersect the walls. Averaged mode avoids this.
- No far-wall boolean subtraction, no interlocking lip/chamfer joint geometry
  (the seam is recessed by depth but the outer boundary line is unchanged).
- Plane Cut (`planecut.js`) is untouched and remains mutually exclusive with
  the Split tool.
