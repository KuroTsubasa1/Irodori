# Toolbar Declutter (Batch N) — Design

**Date:** 2026-06-15
**Status:** Approved (ready for implementation plan)

## Problem

The top toolbar grew to **7 tools in one row** — mixing three jobs:
*navigate* (Orbit, Rotate), *paint* (Brush, Ring, Fill), and *cut* (Split,
Cut). It reads as cluttered: too many buttons, each loud (icon + word +
keyboard-key badge), with no grouping. User-chosen direction: **edit tools
only** — the toolbar should answer "what do I want to do to the model," so
navigation becomes ambient and model-orientation moves off the toolbar.

The key enabling fact (from `js/viewer.js`): **camera orbit is already woven
into every tool.** In `pick` mode (Ring/Fill/Split) a left-drag orbits and
only a stationary click picks; in `paint` mode a drag from the background — or
Alt+left from anywhere — orbits. So there is no mode in which you cannot look
around, and **removing the Orbit button costs nothing functionally**: the
resting "no tool selected" state simply *is* today's orbit mode without a
button. Rotate is the one genuine relocation — it reorients the *model* in 90°
steps, a different job from camera navigation.

Scope: the **top toolbar only** (the zone the user flagged). The left sidebar
and the per-tool options strip are not restructured beyond the one removal in
§2.

## 1 · Toolbar markup (`index.html`)

`#toolbar` drops the `data-tool="orbit"` and `data-tool="rotate"` buttons,
leaving five, in two groups separated by a divider:

- **Paint:** Brush, Ring, Fill
- **Cut:** Split, Cut

Each `.tool` button **loses its `<kbd class="kbd">` badge** (the loudest part
of each button). Shortcuts still work and stay discoverable via the existing
`title` text (e.g. `title="Brush (B) — paint by dragging"`). A separator
element (`<span class="tooldiv" aria-hidden="true">`) sits between Fill and
Split to render the paint·cut divider.

## 2 · Options strip (`index.html`)

- **Remove** the `data-panel="rotate"` panel. Its `data-rot` 90° grid moves to
  the stage Orient popover (§3); its "Refit view" button folds into the
  existing stage reframe button `#reframeBtn` (⤢), which already resets the
  view — no duplicate.
- **Keep** the `data-panel="orbit"` panel (the hint *"Drag to rotate · scroll
  to zoom · right-drag to pan"*). It shows whenever no tool is active, giving
  the resting/navigate state a visible label.
- Brush/Ring/Fill/Split/Cut panels are unchanged.

## 3 · Stage Orient control (`index.html`, `css/style.css`, `js/app.js`)

A new stage-corner button `#orientBtn` (⟳) joins the existing corner cluster
(`#reframeBtn` ⤢, `#bgToggle` ◐); `hidden` until a model loads, like its
siblings. Clicking it toggles a popover `#orientPop` anchored to that corner,
containing the **same `.rotgrid` of `data-rot="x:-1"…"z:1"` buttons** relocated
from the old rotate panel.

- The `[data-rot]` → `doRotate(axis, dir)` logic is unchanged; only the
  **binding selector moves** — `app.js` currently wires
  `#optionsbar [data-rot]`, which becomes `#orientPop [data-rot]` once the grid
  lives in the popover. The old rotate panel's "Refit view" button
  (`#recenterBtn`) is dropped: it called `Viewer.frame()`, exactly what the
  stage ⤢ `#reframeBtn` already does.
- Orientation is **independent of `activeTool`**: the popover works while
  navigating *or* while a tool is armed (no tool switch required — strictly
  better than today, where you first had to select the Rotate tool).
- The popover closes on outside-click and on **Esc**.

## 4 · Resting state & tool model (`js/app.js`)

`activeTool` stays initialized to `"orbit"` and the load path keeps calling
`setTool("orbit")` — but with no `data-tool="orbit"` button in the DOM, the
`.active` toggle matches nothing, so **nothing is highlighted on load** and the
orbit hint panel (§2) shows. That is the "looking around" state.

- `setTool(name)` logic is otherwise unchanged; the viewer-mode mapping
  (`brush`→paint, `ring`/`fill`/`split`→pick, else→orbit, including `cut`'s
  plane preview) is untouched.
- **`"rotate"` is no longer a tool** — nothing calls `setTool("rotate")`; the
  `else→orbit` branch already covers any stray value defensively.
- **Deselect to navigate:** clicking the already-active tool, or pressing
  **Esc**, calls `setTool("orbit")` → back to looking (nothing highlighted).

## 5 · Keyboard (`js/app.js`)

The keydown tool-lookup (currently `…setTool(tool)` at the bottom of `app.js`)
is updated:

- **B / N / F / S / C** → Brush / Ring / Fill / Split / Cut (unchanged).
- **O** → `setTool("orbit")` (navigate / deselect) — the old Orbit shortcut
  keeps a sensible meaning.
- **R** → toggle `#orientPop` (model loaded only) — replaces the old
  Rotate-tool shortcut.
- **Esc** → `setTool("orbit")` and close `#orientPop`.

## 6 · CSS (`css/style.css`)

- Add `.tooldiv` (a thin vertical rule) and group spacing so the row reads as
  paint · cut.
- **Remove** the now-dead `.tool .kbd` and `.tool.active .kbd` rules; tighten
  `.tool` padding slightly now that the badge is gone (lighter buttons).
- Add `#orientPop` styling (absolute card near the corner cluster, reusing the
  existing `.rotgrid` rules).
- The `#left`/options `fadeInUp` `nth-of-type` animation delays are unaffected.

## 7 · Testing

This is **UI wiring only** — no geometry, parser, or `Cleanup`/`Paint` logic
changes — so the `vm` harness does not exercise it. The existing **74-test
`node --test` suite stays green** (no new unit tests, no count change).

Browser-verified checklist:

- Toolbar shows **5 tools in two groups** with a divider; **no kbd badges**;
  hovering a tool shows its shortcut in the tooltip.
- **On load nothing is highlighted**; left-drag orbits, right-drag pans, scroll
  zooms; the options strip shows the navigate hint.
- Each of Brush/Ring/Fill/Split/Cut selects and behaves exactly as before;
  orbit-while-editing still works (pick: drag orbits, click picks; brush:
  background-drag and Alt+left orbit).
- **Esc** / clicking the active tool returns to looking (nothing highlighted).
- With a model loaded, the **⟳ Orient** button opens the popover; each
  `X±/Y±/Z±` rotates the model 90°; it works both while navigating and while a
  tool is armed; it closes on outside-click and Esc; **R** toggles it.
- **⤢ reframe** still refits the view (absorbs the old "Refit view").
- Undo/redo/Export and the brush mirror/symmetry behavior are unaffected.

## Out of scope

- Left sidebar (zone B) and any options-strip restructure beyond §2.
- Collapsing tools into nested menus (rejected: buries the most-used paint
  tools behind an extra click).
- Icon/visual redesign of the buttons; persisting tool or orient state.
