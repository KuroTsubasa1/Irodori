# Ring tool rework — design

## Problem

The ring tool is unreliable in practice:

1. **No angle control.** The band axis comes from `featureAxis` (PCA over a
   patch of radius `0.2·modelSize`, forced ⊥ the surface normal). On anything
   that is not a clean tube it lands at an arbitrary tilt and the user cannot
   override it.
2. **Half rings.** `selectBandAxis` floods sub-triangles whose *centroid* lies
   in the slab. Where triangles are larger than the band, a crossing triangle's
   centroid falls outside, the flood stops, and the ring is left open.
3. **Jagged edges.** Whole leaves are painted, so the band boundary is a
   sawtooth — unlike the brush/stamp, which subdivide via `refinePaint`.

## Goal

A ring that always closes around the clicked feature, at an angle the user
chooses explicitly, with crisp straight edges.

## Decisions (from brainstorming)

- **Placement UX:** place-then-adjust, like the stamp tool. Hover previews,
  click freezes the placement, axis presets + tilt sliders adjust it live,
  Apply commits.
- **Initial orientation:** last-used axis + tilts (default Z, tilt 0). The PCA
  guess is only available on demand via a **Fit** button.
- **Scope:** only the connected loop through the clicked point; other places
  the slab crosses the mesh stay untouched.
- **Edge fidelity:** "Refine edges" toggle, default on (refinePaint
  subdivision); off = whole-leaf, centroid-in-slab, no added geometry.

## Geometry

A ring is a slab: center `c` (the placed click point), unit normal `n` (the
ring axis), half-thickness `h` (existing `ringHalf()` mapping of the
thickness slider). A point `p` is inside iff `|(p − c)·n| ≤ h`.

### `Cleanup.ringFaces(mesh, seedFace, c, n, h)` → `Int32Array` (select.js)

Flood over parent faces using `Cleanup.faceGraph(mesh)` adjacency, starting
at `seedFace`. A face is accepted iff its triangle intersects the slab: let
`d_i = (v_i − c)·n` for its three vertices; reject iff all `d_i > h` or all
`d_i < −h`. This is exact for any triangle size, so the loop cannot stop short
at coarse triangles. Seeding from the clicked face gives "clicked loop only".
Guard: if the seed face itself does not intersect the slab (should not happen
for a click point on it), return `Int32Array(0)`.

### `Cleanup.paintRing(mesh, faces, c, n, h, state, opts)` (cleanup.js)

`opts.refine` (default true), `opts.maxDepth` (default 4).

- **Refine on:** `refinePaint(mesh, state, { faceInRange, overlaps, covered,
  maxDepth })` with
  - `faceInRange` — face index is in the `faces` set. refinePaint currently
    calls `faceInRange(x0..z2)` with coordinates only; append the face index
    `f` as a 10th argument (existing callers ignore it),
  - `covered(p)` — p inside the slab,
  - `overlaps(tri)` — the triangle-vs-slab test above.
- **Refine off:** collect leaves of `faces` whose sub-centroid is in the slab
  and `applyStates` them.

Returns the changed count (same contract as `paintStamps`/`stampMask`).

### Preview

Coarse and fast: leaves of `ringFaces` whose centroid is in the slab
(`facesToSubs` + centroid filter), tinted via `Viewer.setPreview`. Recomputed
on hover (unplaced) and on every slider/preset change (placed).

### Removed / demoted

- `selectBandAxis` and the auto-`featureAxis` hover/click path in `app.js`
  are removed (along with their tests if any target them only for the ring).
- `featureAxis` stays, called only by the **Fit** button.

## UI (`index.html`, `app.js`, `viewer.js`)

Ring panel:

- **Axis** — buttons X / Y / Z / Fit (`#ringAxes`). X/Y/Z select the base
  axis; Fit runs `featureAxis` at the placed point (or the hover point if not
  placed), sets the result as the current axis, and resets the tilts to 0
  (Fit acts as a custom base axis; selecting X/Y/Z afterwards replaces it).
- **Tilt A / Tilt B** — sliders −90…90°. Same rotation convention as the Cut
  tool: extract the `rot` composition from `cutPlane()` into a shared helper
  `tiltAxis(baseAxisVec, axisIndex, ta, tb)` used by both. For a Fit base
  axis, tilts rotate about two vectors ⊥ the fitted axis.
- **Thickness** — existing `#ringThick` slider.
- **Refine edges** — checkbox (`#ringRefine`, checked).
- **Apply / Cancel** — `#ringApply` (primary) / `#ringCancel`, disabled until
  placed. Enter / Esc mirror them while the ring tool is active.

Flow:

1. Unplaced: hovering previews the ring through the hover point with the
   current axis.
2. Click on the mesh: `pendingRing = { meshIndex, face, c }`; preview freezes
   there. Clicking elsewhere on a mesh re-places.
3. Axis/tilt/thickness changes recompute the frozen preview + gizmo live.
4. Apply: `paintRing`, one `pushHistory("Ring")`, render, stats, toast; clears
   `pendingRing` (axis/tilts persist). Cancel/tool switch/model reload clear
   `pendingRing` and the preview.

Axis and tilt values persist across placements within the session.

### Gizmo

Generalize the Cut plane gizmo into a reusable plane-disc helper in
`viewer.js` (`setRingPlanes({ c, n, h, r } | null)`): two translucent discs
with outlines at `c ± h·n`, radius `r` = 1.3 × the local cross-section radius
estimated from the preview leaves' spread around `c` (fallback
`0.15·modelSize`). Shown while the ring tool is previewing; hidden otherwise.
The Cut tool keeps its existing gizmo behavior.

## Testing

Node tests (`tests/`, harness sandbox), synthetic meshes with deliberately
coarse long triangles:

- **Closure:** tilted cylinder (8 segments, 2 rings of vertices → long
  triangles spanning the band); `ringFaces` returns every face crossing the
  slab, and those faces form one cycle around the circumference.
- **Scope:** two disjoint parallel cylinders crossed by the same slab; only
  the clicked one's faces are returned / painted.
- **Refined paint:** after `paintRing` with refine on, every leaf painted with
  the target state has its centroid inside the slab (± one depth-4 leaf
  tolerance), and painted area ≈ 2h × circumference within 10%.
- **Refine off:** no faces gain split nodes; painted leaves are exactly the
  centroid-in-slab leaves of the flooded faces.
- **Tilt helper:** `tiltAxis` with zero tilts returns the base axis; matches
  the previous `cutPlane()` output for sample tilts (Cut regression).

Browser check (Playwright) on the sample model: place a ring on a limb, change
axis/tilts, apply, confirm a closed crisp band and single undo step.
