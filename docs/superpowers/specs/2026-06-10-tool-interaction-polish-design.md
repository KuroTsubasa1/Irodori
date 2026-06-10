# Tool Interaction Polish (Batch H) — Design

**Date:** 2026-06-10
**Status:** Approved (ready for implementation plan)

## Summary

Two small interaction items, approved together:

1. **Brush navigation = fill's.** The brush adopts the fill tool's viewport
   navigation: **left-drag orbits** — unless the drag *starts on the model*, in
   which case it paints (that's the brush) — **right-drag pans** (today it
   rotates), **middle zooms**. **Alt+left still orbits from anywhere** (the
   escape hatch when the model fills the screen). Accepted trade-off: brush's
   right-drag changes rotate → pan, for parity with fill.
2. **Fill hover preview.** With the Fill tool active, hovering tints the
   connected same-color region a click would fill — the same cyan tint and
   cache the split/ring previews use.

Touches `js/viewer.js` (navigation) and `js/app.js` (fill preview). No new
modules; ring/split behavior untouched.

## Design

### 1. Brush navigation (`js/viewer.js`)

- `setTool("paint")` sets `mouseButtons = { LEFT: null, MIDDLE: DOLLY,
  RIGHT: PAN }` (RIGHT was ROTATE).
- **Per-press left-button dispatch:** a **capture-phase `pointerdown` listener
  on the viewer container** (ancestor capture runs before OrbitControls'
  canvas listeners) raycasts the press in paint mode (button 0, not
  `altOrbit`): hit → `LEFT = null` (the press paints), miss →
  `LEFT = THREE.MOUSE.ROTATE` (the drag orbits, fill-style). Recomputed every
  press; no reset needed between presses.
- The canvas paint-start handler sets `painting = true` only when the press
  actually hit the model (today it sets it unconditionally on any left press).
- Alt handlers unchanged: Alt forces `LEFT = ROTATE` while held; the capture
  dispatch skips when `altOrbit` is active.

### 2. Fill hover preview (`js/app.js`)

- `setTool`: enable hover for `fill`; the leave-tool clear covers
  split/ring/fill.
- `onHover`: the tint branch handles `fill` alongside split/ring — region =
  `Cleanup.selectColorRegion(m, hit.localSub)` (the same flood `fillRegion`
  performs; no claimed-exclusion, mirroring what fill actually changes —
  claimed subs are skipped from the tint automatically by `toGlobalSub`).
- `doFill`: clears the hover preview before applying.

## Testing

- `node --test` stays **42** (only untested UI wiring changes).
- Browser-verified: with Brush active — a left-drag starting on the **background**
  orbits the view and adds **no** history entry; a left-drag starting on the
  **model** paints (history "Brush"); right-drag pans; Alt+left orbits from on
  top of the model. With Fill active — hovering tints the region a click would
  fill; the click fills exactly that region (history "Fill"); preview clears on
  tool switch/leave.
