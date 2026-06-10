# Quick UX Wins (Batch A) — Design

**Date:** 2026-06-10
**Status:** Approved (ready for implementation plan)

## Summary

Six small, low-risk UX improvements bundled into one spec (from workstreams W3/W4/W6 of the 2026-06-10 backlog), so we don't run six separate pipelines for one-liners:

1. **Fix split re-animation** — adding a split part must not re-explode the existing ones.
2. **Split hover preview** — hovering with the Split tool highlights the region that would lift out.
3. **Smaller brushes** — retune the brush/ring size curve so the low end is fine.
4. **Orbit while brushing** — hold **Alt** + left-drag to orbit without leaving the Brush tool.
5. **Center the tool options** — the options strip sits centered under the (centered) toolbar.
6. **Keyboard shortcuts** — single mnemonic keys switch tools (O/R/B/N/F/S).

These touch `js/app.js`, `js/viewer.js`, `js/cleanup.js`, `css/style.css`, `index.html` — all small, focused edits. No file is large enough to warrant splitting yet (W1 refactoring stays woven, not a separate pass here).

## Non-goals

- No new geometry/cap behavior (that was W2).
- No mesh list / isolation view (W6 batch C) or symmetry/colors (batch B).
- No remapping of the existing undo/redo shortcuts (⌘Z / ⌘⇧Z / ⌘Y) — tool shortcuts are modifier-free and must not collide.

## Design

### 1. Fix split re-animation (`js/app.js`, `js/viewer.js`)

**Cause:** `Viewer.setSplitParts(parts)` calls `clearSplitObjs()` and rebuilds every part body with `cur = new THREE.Vector3()` (origin), so on each new split *all* parts re-lerp outward from center.

**Fix — stable per-part identity:**
- `app.js`: a module counter `splitSeq` (starts 0). `doSplit` pushes `{ id: splitSeq++, meshIndex, subs, state, method }`. The history snapshot (`snap`/`restore`) carries `id`.
- `viewer.js`: `setSplitParts` keeps the previous part objects keyed by `id`. For each incoming part, if a prior object with the same `id` exists, **reuse its `cur` position** (so it stays put); only parts with a new `id` start at `cur = origin` and animate outward. Disposed parts (id no longer present) are removed.
- Remainder cap meshes (`remainderCapObjs`, static at the hole) keep rebuilding as today — they don't animate, so no carry-over needed.

`splitSeq` is monotonic and only mints ids for genuinely new splits, so restored ids (undo/redo) never collide with future ones.

### 2. Split hover preview (`js/app.js`, `js/viewer.js`)

With the Split tool active, hovering tints the connected same-color region that a click would lift out.

- `app.js setTool`: enable hover for `split` too (currently only brush/ring). The split-tool hover handler floods the region (`Cleanup.selectColorRegion(mesh, hit.localSub)`), maps members to global rendered subs (`Viewer.toGlobalSub`), and calls `Viewer.setPreview(globalSubs)`.
- **Perf — re-flood only on region change:** `app.js` caches the last preview as `{ meshIndex, members:Set<localSub>, globalSubs }`. On each hover, if the new seed is already in the cached `members` (same region) → no-op. Only when the hovered region changes do we clear the old tint, flood the new region, and re-tint. On a 544k-sub mesh a region can be ~140k subs, so a single flood + recolor happens once per region-entry, not per frame.
- `viewer.js`: `setPreview(globalSubs)` recolors those sub-triangles to a fixed preview tint in the color buffer (remembering the affected global-sub indices so it can restore exactly) and flips `colorAttr.needsUpdate`; `clearPreview()` restores each to `linColor(triState[sub])`. Preview tint = the existing highlight cyan `#1fe3ff` (reuse the `HIGHLIGHT` constant — the cleanup preview and the split preview are never visible at the same time, since they belong to different tools). The brush/ring cursor ring is hidden while the Split tool previews.
- Clear the preview on pointer-leave and immediately before `doSplit` performs the split.

### 3. Smaller brushes (`js/app.js`, `index.html`)

Current `brushRadius = (val/100)·diag·0.15 + diag·0.004` → min ≈ 0.55% of the diagonal (too coarse). Retune to a quadratic so most slider travel is in the small range:

```js
const t = (+$("brushSize").value) / 100;          // 0..1
brushRadius = () => modelSize * (0.0015 + 0.06 * t * t);   // ~0.15% .. ~6% of diag
```
Same shape for the ring: `ringHalf = () => modelSize * (0.001 + 0.04 * t * t)` (t from `#ringThick`). Bump the default `#brushSize` value from `16` to `40` so the default brush is usable (~1–2 mm on a typical model). Update the little UI size-dot (`sizeDotPx`) to track the same quadratic so the swatch reflects the curve. The 3-D surface cursor already uses `brushRadius()` directly, so it auto-matches.

### 4. Orbit while brushing — hold Alt (`js/viewer.js`)

Today paint mode sets `controls.mouseButtons = { LEFT: null, MIDDLE: DOLLY, RIGHT: ROTATE }` (right-drag orbits, but it's not discoverable). Add: while the viewer is in `paint` mode, **holding Alt** sets `LEFT: ROTATE` and suspends painting; releasing Alt restores `LEFT: null` (paint). Implemented with `keydown`/`keyup` listeners tracking an `altOrbit` flag:
- on Alt down (paint mode): `controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE`, set `altOrbit = true`.
- on Alt up: `controls.mouseButtons.LEFT = null`, `altOrbit = false`.
- the `pointerdown` paint branch is gated on `!altOrbit` so an Alt-drag never starts a stroke.
Right-drag-to-orbit is retained. (Listeners are cleaned up correctly / guarded so they only act in paint mode.)

### 5. Center the tool options (`css/style.css`)

`#topbar` centers `.tools` (grid `1fr auto 1fr`), but `#optionsbar` is a left-aligned flex with `.palette { margin-left:auto }` pushing the palette far right — so the active option group reads as "off to the sides," not under the tools. Fix: `#optionsbar { justify-content: center; }` and remove `.palette { margin-left:auto }` so the active `.opt` group + palette sit **centered together** under the toolbar. Only one `.opt` panel is visible at a time, so centering the visible one is unambiguous.

### 6. Keyboard shortcuts (`js/app.js`, `index.html`)

Modifier-free single keys switch tools, via the existing `keydown` listener:
`o`→orbit, `r`→rotate, `b`→brush, `n`→ring, `f`→fill, `s`→split (case-insensitive).
Guards: ignore when any of `metaKey/ctrlKey/altKey` is held (so ⌘Z, ⌘R reload, Alt-orbit are untouched), and ignore when the event target is an `input`, `select`, or `textarea` (the patch-size number field, the cap-method select). Each tool button's `title` gains its key, e.g. `title="Brush (B) — paint by dragging"`.

## Testing

- **Unit (`node --test`, must stay green at 25):** Batch A is UI/viewer wiring with no new pure-logic module, so it adds no Node tests; the existing suite is the regression guard (confirm `js/cleanup.js`/`js/split.js`/`js/caps.js` behavior is unchanged).
- **Browser-verified** (static server + the reference `.3mf`):
  - Shortcuts: pressing O/R/B/N/F/S switches the active tool; typing in the patch-size field or cap-method select does NOT switch tools.
  - Orbit-while-brush: with Brush active, Alt+left-drag orbits and does not paint; releasing Alt resumes painting.
  - Brush size: the smallest slider setting paints a small patch (visibly finer than before); the 3-D cursor ring matches.
  - Options centering: the active options group is centered under the toolbar.
  - Split hover preview: hovering a colored region with the Split tool tints that region; moving within it doesn't re-flicker; leaving clears it.
  - Split re-animation: split one region (it animates out), then split another — the first stays put; only the new one animates. Undo/redo keeps positions stable.
