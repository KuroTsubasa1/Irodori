# Color & UI Polish (Batch G) — Design

**Date:** 2026-06-10
**Status:** Approved (ready for implementation plan)

## Summary

Five small items:

1. **Generic PLA on export (item 2)** — every export sets all filaments'
   `filament_settings_id` to `"Generic PLA"` and `filament_type` to `"PLA"`
   (user decision: **all** filaments, both export paths; the reference file
   currently carries `"Bambu PLA Basic @BBL X1C"`).
2. **Color-picker placement (item 5)** — the native picker opens anchored under
   the palette's "+" swatch instead of off-screen left.
3. **Delete added colors (item 6)** — an × on added swatches; deleting an
   in-use color **repaints those areas to the model default** (user decision),
   remaps later paint states down, and is **undoable** (snapshots now carry the
   filament list).
4. **Shortcut badges (item 7)** — each tool button shows its key as a small
   `kbd` chip.
5. **"Colors to clean" refresh (item 8)** — the list shows all palette
   filaments (count 0 if unpainted), rebuilds after add/delete/paint/undo, and
   preserves the on/off toggles.

Touches `js/threemf.js`, `js/cleanup.js` (remapStates), `js/app.js`,
`index.html`, `css/style.css`. Items 1 and 3's cores are pure and Node-tested.

## Non-goals

- Deleting **original** filaments (only colors added via "+").
- Editing an existing filament's color.
- Preserving the original `filament_settings_id` values (explicitly
  overwritten per the user's request).

## Design

### 1. `ThreeMF.normalizeFilamentConfig` (pure) + always-on export rewrite

`normalizeFilamentConfig(configText, origCount, filaments)`:
calls the existing `extendFilamentConfig` (per-filament arrays grown, colours
written), then sets `filament_settings_id = filaments.map(() => "Generic PLA")`
and `filament_type = filaments.map(() => "PLA")`, returns JSON text.

- `exportZip`: the currently *conditional* config rewrite becomes
  unconditional — always read `project_settings.config` (if present) and write
  `normalizeFilamentConfig(...)` back.
- `exportSplit`: the verbatim-copied `project_settings.config` is likewise
  normalized before being added to the fresh zip.

### 2. Picker anchored to the "+" swatch

The hidden `<input type="color" id="addColorInput">` moves inside the palette's
add-swatch (`.pal.add` becomes `position: relative`; the input is absolutely
positioned at its bottom edge, 1×1 px, `opacity: 0`, `pointer-events: none`).
The add-click handler calls `input.showPicker()` when available, falling back
to `input.click()`. Browsers anchor the native picker to the input's box → it
opens directly below the palette.

### 3. Delete added colors (with repaint + remap + undo)

- **UI:** swatches of added filaments (`index > doc.origFilamentCount`) show an
  × chip on hover; clicking it deletes that filament (click elsewhere on the
  swatch still selects it).
- **`Cleanup.remapStates(mesh, mapFn)`** (new, Node-tested): for every face,
  decode → `Paint.remapLeaves(tree, mapFn)` → collapse → encode; updates `dom`;
  invalidates the sub-graph; returns the changed-face count. (No-op faces are
  detected cheaply and skipped.)
- **Delete flow** for filament index `k` (state `k`): build
  `mapFn = s => (s === k ? 0 : s > k ? s - 1 : s)` — in-use areas repaint to
  state 0 (the model default) and later filaments shift down — apply to every
  mesh; remove `doc.filaments[k-1]` and re-index; clamp `paintState` if it
  pointed at/after `k`; `pushHistory("Delete color")`; rebuild palette,
  filament list, stats, view.
- **Undo:** `snap()`/`restore()` now carry a deep copy of `doc.filaments`
  (small array). UI rebuilds (palette + filament list) happen in the history
  **navigation** paths (`jumpTo`, `doReset`) — not inside `restore()`, which
  also runs for cheap preview rollbacks. This makes add-color undoable too
  (consistent behavior, a small change from Batch B where filaments were
  outside history).

### 4. Shortcut badges

Each toolbar button gains `<kbd class="kbd">X</kbd>` after its label
(O/R/B/N/F/S). CSS: a small rounded chip, muted on idle buttons, translucent
white on the active button.

### 5. "Colors to clean" refresh

`buildFilamentUI()` becomes `refreshFilamentUI()`: lists the union of states
present in the meshes (`gatherStates`) and all palette filaments `1..N`
(count 0 when unpainted), ordered by state. Before rebuilding it snapshots the
current checkbox map and reapplies it (new states default to on). It runs
inside `updateStats()` (which already fires after load, paint, clean, fill,
undo/redo, delete/add color), replacing the one-shot call at load.

## Testing

- **Unit (`node --test`):**
  - `normalizeFilamentConfig`: ids → all `"Generic PLA"`, types → all `"PLA"`,
    arrays still extended for added filaments, other keys untouched.
  - `Cleanup.remapStates` on a fixture with solid and split (tree) faces:
    `k→0` repaint + `>k` down-shift both land in the re-encoded paints
    (verified via decode), `dom` updated, unchanged faces' strings identical.
- **Browser-verified:** "+" opens the picker under the palette; adding then
  deleting an in-use color repaints those areas to the default color and the
  palette/clean-list shrink; undo restores both the color and the paint;
  shortcut chips visible on all six tools (highlighted state legible); the
  clean-list shows a freshly added color with count 0, and counts update after
  painting with it; export (normal + split) carries `"Generic PLA"` ids and
  `"PLA"` types for every filament.
