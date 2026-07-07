# Brush responsiveness: refine toggle + sub-graph re-warm

## Problem

Two related symptoms when brushing:

1. **Stroke-start lag.** After certain operations, the first brush interaction
   freezes for a few seconds before paint appears.
2. **No way to skip refinement.** Every stroke runs the slicer-style
   `paintStamps` refinement on release, which subdivides geometry and costs a
   `Refining stroke…` pass, even when the user just wants speed.

### Root cause of the lag

- The sub-triangle graph (`mesh._sub`) is the backing structure every paint
  operation reads. It is built lazily by `buildSubGraph` and cached.
- `paintStamps` subdivides geometry, so it **invalidates** the graph
  (`cleanup.js:349` → `invalidateSub` → `_sub = null`) after every refined
  stroke. Fill-region, rotate, and remove-color invalidate it too.
- The graph is only **eagerly** rebuilt in `setTool` (`app.js:330-331`, under
  the `Preparing tool…` spinner), and only when *switching to* a paint tool.
- After a refined stroke the brush tool is already active, so `setTool` never
  re-runs. The next brush-down calls `selectRadius` → `buildSubGraph`, which
  **rebuilds the whole graph synchronously inside the mouse handler** — no
  spinner, blocking for seconds on a large or heavily-subdivided mesh.

It is intermittent ("sometimes") because a warm cache is instant; it worsens
across a session because each refinement grows the mesh, so every rebuild is
slower than the last.

Note the non-refined write path, `applyStates` (`cleanup.js:37-55`), changes
only paint *states*, not geometry, and therefore **never invalidates the
graph**. This is why disabling refinement also removes the lag between
consecutive brush strokes.

## Goals

- **A.** Let the user disable per-stroke edge refinement, keeping triangle count
  down and making consecutive brush strokes snappy.
- **B.** Fix the stroke-start lag at its root: never rebuild the graph silently
  inside a mouse event. When the graph is invalidated while a paint tool is
  active, re-warm it under a visible spinner right after the triggering action.

Default behavior is unchanged: refinement stays **on** unless the user opts out.

## A — Refine-edges toggle

**UI** (`index.html`, `data-panel="brush"`): a checkbox under the Mirror row,
using the existing `.check` label pattern (as in the fill panel):

```html
<label class="check" id="brushRefineWrap">
  <input type="checkbox" id="brushRefine" checked />
  <span>Refine edges (crisper, slower)</span>
</label>
```

Checked by default → current behavior. No persistence across sessions (matches
the app's other in-memory tool settings).

**Behavior** (`endStroke`, `app.js:398`): branch on the checkbox.

- **Refine on (default):** unchanged —
  `Cleanup.paintStamps(m, expanded, paintState, { maxDepth: 4 })` inside the
  `busy("Refining stroke…", …)` wrapper.
- **Refine off:** skip `paintStamps`. Commit the whole-leaf tint the live
  preview already computed:
  `const res = Cleanup.applyStates(m, [...stroke.pend], paintState);`
  No `busy` spinner, no subdivision, no added geometry. No-op detection uses
  `res.changedFaces.size` (0 → restore live tint and return). Otherwise the same
  epilogue: `pushHistory("Brush") / render(null) / updateStats()`.

`stroke.pend` already accumulates exactly the local sub-triangles painted during
the stroke, including mirror expansion, so `applyStates` reproduces the coarse
preview precisely — the on-release result matches what was shown while dragging.

## B — Sub-graph re-warm

**Extract a helper.** Pull `setTool`'s inline pre-build into a function:

```js
function ensureSubGraphs(msg) {
  if (doc && doc.meshes.some((m) => !m._sub)) {
    busy(msg || "Preparing tool…", () => { for (const m of doc.meshes) Cleanup.buildSubGraph(m); });
  }
}
```

`setTool` calls `ensureSubGraphs()` (same guard as today: only for paint/split
tools).

**Re-warm after invalidating ops.** Call `ensureSubGraphs()` at the tail of each
op that invalidates the graph while a paint tool is active, so the rebuild lands
inside the spinner the user already sees for that op rather than at the next
stroke start:

- `endStroke` refine-path — after `paintStamps`, inside the same `busy` block.
- rotate (`app.js:356` area).
- remove-color (`app.js:562` area).
- fill-region (whichever `busy` block wraps the fill that invalidates).

**Safety net.** In `startStroke`, if `_sub` is still cold (e.g. after undo/redo
`restore`, which we do not want to special-case), call `ensureSubGraphs()`
before the first `brushAt`. This guarantees no path ever rebuilds silently
inside a mouse-move; worst case the user sees a spinner at stroke start instead
of an unexplained freeze.

## Non-goals

- No persistence of the toggle across page loads.
- No change to `paintStamps`, the paint codec, or `applyStates` internals.
- The image-based stamp-map tool is a separate feature with its own spec.

## Testing

- Unit test: `applyStates` over a stamp's leaf set changes paint state **without
  growing the triangle/leaf count**, contrasted with `paintStamps` which
  subdivides. Asserts the refine-off path adds no geometry.
- Toggle wiring and `ensureSubGraphs` spinner behavior are DOM/UI glue, verified
  manually in the browser (load a mesh, brush with refine off → no
  `Refining stroke…`, snappy repeat strokes; brush with refine on then
  immediately brush again → spinner appears during rebuild, no silent freeze).
