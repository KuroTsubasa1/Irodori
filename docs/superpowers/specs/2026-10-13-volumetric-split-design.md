# Volumetric Split — design

**Date:** 2026-10-13
**Status:** Approved in conversation; awaiting written-spec review.

## Problem

The Split tool produces knife-edge lenses (surface patch + cap) and keeps
them as an *overlay*: `splitParts` is a list of sub-triangle index sets over
an unchanged mesh, every part's cap is built in isolation, and the
"remainder" is a viewer illusion (unclaimed sub-triangles plus the parts'
caps reversed, drawn as separate objects). Consequences the user hits:

1. **Parts are unprintable** — no wall thickness; the earlier
   minimum-thickness plug (`75033b5`, reverted in `e8e273a`) self-intersected
   on thin features, was still too thin to be a "piece", and the remainder
   never matched it.
2. **Re-splitting breaks** in every form: a second region touching the
   first (two independent Liepa caps bulge into each other along the shared
   seam); painting then re-splitting (any brush stroke renumbers
   sub-triangles, stored parts go stale — nothing guards this); splitting
   after a plane cut (Cut produces real meshes, Split drags them back into
   the overlay); splitting the remainder (it is not a mesh).

## Goal

A split part is a **solid piece that reassembles** with the remainder: the
painted patch plus an inward wall and a bottom, and the remainder gets the
exactly matching pocket. Parts and remainder are ordinary document meshes,
so every other tool (paint, Cut, Split again) works on them unchanged.

## Decisions (from brainstorming)

- Approach **A**: Split becomes a real document operation (like Cut) with
  depth-limited plugs. Rejected: a vendored WASM boolean (Manifold) —
  robust but a ~1.5 MB binary dependency, a second load path for the Node
  harness, and it refuses non-manifold input; and patching the overlay —
  cheap but still knife-edge lenses.
- Click applies immediately (no place-then-adjust): the plug is hidden
  inside the model, nothing to judge visually; undo is one step.
- Depth is a user value in mm; per-vertex clamp at **half** the local
  thickness; wall only grows where the lens would be knife-edged.
- Bottom cap: `liepa` default; existing `Cap method` dropdown kept.

## Geometry — `Split.plugSolids(mesh, subs, opts)` (js/split.js)

`opts = { depth, method }`. Returns `{ part, remainder, info }` — two document
meshes `{ positions, nf, v1, v2, v3, paints }` (the app sets
`part.part = { label, state }`)
— or `{ error }` with a user-facing reason.

### Shared conformed surface

Both meshes come from the conformed sub-triangle surface (existing
`openSurface`: refined leaves become real triangles, T-junctions resolved
through `midOf`), so patch and remainder share identical welded rim
vertices. The patch's boundary loops come from the existing `bEdge` walk
(`solidFromSubs` boundary code, extracted into `patchBoundary(mesh, subs, g)`
→ `{ loops: [[gid...]], surfDir: Map(edgeKey → "u>v"), pinch: bool }`).

### Per-rim-vertex inward direction

The full model normal at the rim vertex: area-weighted average over **all**
incident sub-triangles (both sides of the rim), then smoothed along each
rim loop with two 1-ring averaging passes (prevents zigzag walls on noisy
rims). Inward direction `d_i = −n̂_i`.

### Per-rim-vertex depth

`t_i = min(depth, 0.5 · t_hit_i) · w_i`, where

- `t_hit_i` — distance along `d_i` to the opposite surface: a ray cast
  against the mesh's parent faces, accepting **back-face hits only** (the ray
  starts inside the solid, so the far wall is hit from behind; this excludes
  the near surface without an epsilon dance) and `t > 1e-4 · bboxDiag`. No
  hit → `t_hit = ∞`. Acceleration: a uniform grid over face AABBs
  (`Split.faceGrid(mesh)`, cell count ≈ cube root of face count per axis,
  clamped 8…64), 3-D DDA ray march. Half the thickness is what stops facing
  rim points from crossing each other on thin features.
- `w_i = |cos θ_i|`, θ_i the angle between `n̂_i` and the loop's best-fit
  plane normal (existing `Caps.bestFitPlane` on the loop's points). A
  cross-section rim (ear tip, band around a leg) has `w ≈ 0` — the lens is
  already a solid there, no wall is added. A shallow patch (belly spot) has
  `w ≈ 1` — full plug. In between, the wall tapers continuously.

Offset point `p'_i = p_i + t_i · d_i`. When `t_i < 1e-6 · bboxDiag`,
`p'_i` **is** `p_i` (same vertex id) so zero-depth stretches stay manifold.

### Wall and bottom

- For each surface-directed rim edge `u→v` (from `surfDir`): triangles
  `(v, u, u')` and `(v, u', v')`, skipping any triangle with two equal ids.
  This traverses the rim edge `v→u` (opposite the surface, so the edge is
  used once each direction) and the offset edge `u'→v'`.
- Bottom: `Caps.triangulateLoops(offsetLoops, getPt, method)` on the offset
  loop(s), then `orientCapComponents` with the offset edges' directions
  `u'→v'` as the "surface" direction, so the bottom traverses `v'→u'`. Loops
  that collapsed entirely to the rim (all `t_i = 0`) are capped directly on
  the rim, as today.
- The part gets patch + wall + bottom; the remainder gets the rest of the
  surface + wall reversed + bottom reversed. Wall/bottom coordinates and
  bottom extra points are emitted identically into both.

### Colors

Patch and remainder surface triangles keep their leaf states (one solid
paint string per triangle). Wall and bottom: the part's state in the part;
`majorityBorderColor` in the remainder.

## Robustness — refuse rather than ship garbage

- **Self-intersection check** of wall + bottom triangles against each other
  and against the patch triangles (grid-bucketed triangle–triangle test,
  Möller; non-adjacent pairs only). On any intersection: halve every `t_i`
  and rebuild wall + bottom, up to 4 times; final fallback `t_i = 0`
  (today's lens) with toast *"Region too sharp for a plug — made a shell"*.
  (In practice the clamp and the `|cos θ|` weight keep walls apart on convex
  features — a band over a ridge yields a clean plug with no halving, and a
  through-groove yields a trough-shaped plug because Liepa follows the
  offset end paths. The case that does trigger halving is a **closed pocket**
  (a dent): its rim is planar, so the bottom cap is flat and must cross the
  pocket walls; halving runs to the shell, and the shell closes the AIR, which
  the volume gate below refuses.)
- **Watertight gate** on both outputs: every undirected edge used exactly
  twice **and** traversed once in each direction (`MeshGeo.checkClosed`),
  **and** positive signed volume (`MeshGeo.signedVolume > 0`, which rejects
  inside-out shells of pocket-shaped regions). If either output fails,
  nothing is applied; toast *"Couldn't make a clean solid here (pocket-shaped
  or too sharp region)"*; the error result carries `info` so the halving
  outcome stays observable. The existing `console.warn("cap may be
  incomplete")` paths become refusals.
- **Refusals** (`{ error }`): pinch topology (`pinch`) → *"Region touches
  itself at a point — paint a wider bridge or gap"*; `subs` covers the whole
  mesh → *"That's the whole object"*; empty region → *"Nothing to split
  there"*.

## Tool flow (js/app.js, index.html)

- Hover: existing same-color region tint (no `claimed` exclusion any more).
- Click: `Split.plugSolids(mesh, subs, { depth, method })` under `busy`;
  on success replace `doc.meshes[i]` with `[remainder, part]`, set
  `doc.synthetic = true`, `pushHistory("Split")`, rebuild, `buildObjects`,
  `ensureSubGraphs`. On `{ error }`: toast, no history entry.
- Panel: `Depth` — `<input type=number id="splitDepth">` (mm, step 0.1)
  linked to a range; default 3, min 0.3, max `modelSize / 2` (set on load).
  Existing `Cap method` select stays; its `change` handler no longer re-caps
  anything (only future splits). Hint text: *"Click a colored region to lift
  it out as a solid part."*
- Removed guards: *"Export or undo your split parts before cutting"* and the
  export dialog's dependence on `splitParts`.

## Viewer and layout (js/viewer.js)

- `mesh.part = { label, state }`; `label = "Part N · <color name>"` assigned at
  split time (N = count of part meshes + 1). Cut halves copy `part` from
  their source so a cut part stays a part.
- **Display-only row layout:** `Viewer.build` computes, for meshes with
  `part`, a per-mesh offset from the existing `Split.layoutParts(bodyBox,
  partBoxes, margin)` where `bodyBox` is the union AABB of non-part meshes,
  applied to those meshes' vertices in the render buffer (positions only —
  picking maps back through the same offset so paint/split on a part keeps
  working). Export stays coincident. If every mesh is a part (cannot happen
  via Split — the remainder is never flagged — but can after cutting away
  the remainder) the first mesh is treated as the body.
- Removed: `remainderCapObjs`, `setSplitParts`, `claimedSets` / the
  `claimed` parameter of `build`, `partObject`, `pinPart`, `setPartVisibility`
  (per-mesh visibility covers it). Objects panel lists parts by label.
- Isolating a part is the existing per-mesh isolate; `Viewer.frame` frames
  the mesh at its laid-out (offset) position, so `pinPart` is unnecessary.

## Export (js/threemf.js)

`doc.synthetic` already routes to `exportGenerated`, which writes every mesh
as its own object; part labels become object names. Removed: `exportSplit`,
`Split.remainderSolid`, `Split.solidFromSubs`, `Split.majorityBorderColor`
becomes internal, the `split` export format and its chip in the dialog.

## History

Snapshots already store `meshList` + `synthetic` (plane cut needs it).
`mesh.part` rides along with the mesh object. No history changes.

## Tests (tests/, Node harness)

- **Flat-face plug:** closed cube, region = one triangle of the top face
  (face 2), depth 0.5 → part and remainder: edge-twice, 0 directed
  violations, positive volume, `vol(part) + vol(remainder) = 8 ± 1e-6`;
  bottom vertices at `z = 2 − 0.5`.
- **Far-wall clamp:** 4×4×0.5 slab, region = top face, depth 10 → bottom
  at `z ≥ 0.25` (half thickness), volumes sum, no intersections.
- **Knife-edge factor:** cube region = top face + upper half of the four
  sides (cross-section rim at z=1) → zero wall triangles; part = lens.
- **Convex ridge stays clean:** gridded roof prism, region = upper half of
  both slopes → no halving, outputs closed, volumes sum to 12.
- **Through-groove:** U-channel, region = groove walls + floor → trough plug,
  no halving, closed, volumes sum to 48.
- **Closed pocket refused:** pocket box, region = pocket walls + floor →
  halving runs to the shell (`info.halvings === 4`, `info.shell === true`)
  and the inside-out result is refused by the volume gate.
- **Refusals:** pinch (two regions sharing one vertex) → `error`; whole
  mesh → `error`; empty → `error`.
- **Chained:** cube: split region A (top), then on the remainder split the
  adjacent region B (one side face), then `PlaneCut.cutMesh` on the A part
  → every mesh closed; total volume still 8.
- **Refined paint:** `makeTJunction` region → both outputs closed.
- **checkClosed** agrees with harness `directedViolations` on open-tube and
  cube fixtures.
- Browser (Playwright, sample model): belly spot plug; ear-tip split (no
  wall); neck band split; paint over a part then split it again; undo
  chain; export opens with N objects.

## Non-goals

- No boolean library; no true "through-cut" when the depth exceeds the
  local thickness (the half-thickness clamp stands in for it).
- No collision-aware layout; no change to Cut's UI.
- Residual non-manifold edges on fractal paint rims that already fail the
  watertight gate are refused, not repaired.
