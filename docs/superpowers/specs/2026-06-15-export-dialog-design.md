# Export Dialog (Batch O) — Design

**Date:** 2026-06-15
**Status:** Shipped (Batch O).

## Problem

Export is fragmented across three entry points in two places: the top bar
holds **Export** (`#exportBtn` → `_fixed.3mf`), a **.obj** button
(`#exportObjBtn` → `_paint.zip`) and its **Weld** checkbox (`#objWeld`); the
Split tool's options panel holds **Export split (.3mf)** (`#exportSplitBtn` →
`_split.3mf`). The formats and their cryptic output names aren't legible, the
top bar is crowded (right after the Batch N toolbar declutter), and there's no
single place to choose a format, set its options, or name the file.

Goal (all four confirmed): **consolidate** the three entry points into one
**Export** button that opens a **dialog**; **clarify** what each format
produces; give **control** (per-format options + an editable output name); and
**rehome** split export into the dialog.

Chosen interaction (over format-rows and a dropdown): a **pick-format modal** —
a format selector at top, the chosen format's description + options below, an
editable output-name field, and Cancel / Export.

## 1 · Markup (`index.html`)

- **Top bar (`.topactions`):** remove `#objWeldWrap` (the Weld label+checkbox)
  and `#exportObjBtn` (.obj button). Keep `#exportBtn` "Export" (it now opens
  the dialog instead of exporting directly).
- **Split panel (`data-panel="split"`):** remove `#exportSplitBtn`. The
  `#capMethod` select stays — cap method is a Split-tool concern; the dialog
  exports with whatever is set.
- **New modal**, appended inside `#app` (sibling of `#main`):

  ```html
  <div id="exportModal" class="modal" hidden>
    <div class="modal-card" role="dialog" aria-modal="true" aria-label="Export">
      <h2>Export</h2>
      <span class="optlabel">Format</span>
      <div class="axes" id="exportFmt">
        <button type="button" data-fmt="3mf" class="on">3MF</button>
        <button type="button" data-fmt="obj">OBJ</button>
        <button type="button" data-fmt="split">Split</button>
      </div>
      <p id="exportDesc" class="hint"></p>
      <label class="check" id="exportWeldWrap"><input type="checkbox" id="exportWeld" checked /><span>Weld vertices — smaller file, smooth shading</span></label>
      <div class="field">
        <label for="exportName">Output name</label>
        <input type="text" id="exportName" />
      </div>
      <div class="btnrow">
        <button id="exportCancel" class="ghost">Cancel</button>
        <button id="exportGo" class="primary">Export</button>
      </div>
    </div>
  </div>
  ```

  Reuses existing idioms: `.axes` chips (as `symAxes`/`cutAxes`/`fillModes`),
  `.check` (weld), `.field`/`.btnrow` (as the Auto-clean card).

## 2 · Dialog state & behavior (`js/app.js`)

A small module-local block (near the other UI wiring):

- **`exportDefaultName(fmt)`** → `base + suffix`, where
  `base = fileName.replace(/\.3mf$/i, "")` and suffix is `_fixed.3mf` (3mf),
  `_paint.zip` (obj), `_split.3mf` (split). This is the single source of the
  per-format default names.
- **`exportDescribe(fmt)`** → the description string:
  - `3mf` → "Repaired model, ready to re-slice."
  - `obj` → "Colored mesh as .obj + .mtl, zipped — for other tools."
  - `split` → `"Each painted region as its own watertight solid (" + splitParts.length + " parts)."`
- **`selectExportFmt(fmt)`** — toggle `.on` on the matching `#exportFmt`
  chip; set `#exportDesc` text via `exportDescribe`; show `#exportWeldWrap`
  only when `fmt === "obj"` (else hidden); set `#exportName.value =
  exportDefaultName(fmt)`. Switching format always repopulates the name with
  that format's default.
- **`openExportDialog()`** — guard `if (!doc) return;`. Set the `split` chip's
  `disabled` state from `splitParts.length === 0` (and add a `title` hint "Split
  a region first" when disabled). Call `selectExportFmt("3mf")` (always reset to
  3MF on open). Show the modal (`hidden = false`); focus `#exportName`.
- **`closeExportDialog()`** — `hidden = true`.
- **Chip clicks** (`#exportFmt button`): ignore when the chip is `disabled`;
  else `selectExportFmt(b.dataset.fmt)`.

Wiring changes: `#exportBtn` listener becomes `openExportDialog` (was
`doExport`). Remove the `#exportObjBtn` and `#exportSplitBtn` listeners and the
`$("exportObjBtn").disabled = false;` line in the load block (that button no
longer exists; `#exportBtn` already enables on load).

## 3 · Export dispatch & download (`js/app.js`)

Extract the duplicated download tail (`<a>` + object URL + click + revoke +
toast) shared by all three exporters into one helper:

```js
function triggerDownload(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast("Saved " + name);
}
```

Refactor the three exporters to take the chosen name (and weld), using the
helper — preserving each one's existing pre-export logic:

- **`doExport(outName)`** — keep the `previewActive`/`restore(current())`
  preamble (export reflects committed paint, not a live preview), then
  `triggerDownload(await ThreeMF.exportZip(doc), outName)`.
- **`doExportObj(outName, weld)`** — `weld` is now a parameter (default `true`),
  not read from a checkbox. Inner archive names derive from the chosen name:
  `zipBase = outName.replace(/\.zip$/i, "")`; `zip.file(zipBase + ".obj", obj)`,
  `zip.file(zipBase + ".mtl", mtl)`, `mtlName: zipBase + ".mtl"`; then
  `triggerDownload(blob, outName)`.
- **`doExportSplit(outName)`** — keep the `if (!splitParts.length)` guard, then
  `triggerDownload(await ThreeMF.exportSplit(doc, splitParts), outName)`.

**`#exportGo` (Export) click:** read `fmt` (active chip), `name`
(`#exportName.value`), `weld` (`#exportWeld.checked`); `closeExportDialog()`;
then dispatch — `3mf` → `doExport(name)`, `obj` → `doExportObj(name, weld)`,
`split` → `doExportSplit(name)`. Each exporter keeps its own try/catch + error
toast, so a failed build surfaces a toast after the modal closes.

## 4 · Close paths & keyboard (`js/app.js`)

- **`#exportCancel`** → `closeExportDialog()`.
- **Backdrop click:** a listener on `#exportModal` closes when
  `e.target === exportModal` (click landed on the dim backdrop, not the card).
- **Esc / modal gate:** at the very top of the keydown handler — right after
  `if (!doc) return;`, *above* the undo/redo lines and all guards — insert
  `if (!$("exportModal").hidden) { if (e.key === "Escape") closeExportDialog(); return; }`.
  While the dialog is open this returns early for every key (so app shortcuts
  don't fire and native text-editing keys reach the `#exportName` field), and
  **Esc** closes the dialog. The early placement is essential: the dialog owns a
  text input, so the gate must sit above the `INPUT/SELECT/TEXTAREA` field guard
  (which would otherwise swallow Esc while the name field is focused). When the
  dialog is closed the check is skipped and keydown behaves as Batch N defined
  (its `Esc → looking` branch stays *below* the field guard, preserving Batch
  N's "don't hijack Esc while typing" fix).

## 5 · CSS (`css/style.css`)

- `.modal` — fixed full-viewport flex-centered overlay, dim backdrop
  (`background: rgba(15,18,24,.45)`), high `z-index` (above `#topbar`'s 6 and
  `.orientpop`'s 7), `.modal[hidden] { display: none; }`.
- `.modal-card` — centered card reusing the `.card` look (panel bg, radius,
  padding, shadow), max-width ~360px, `display:flex; flex-direction:column; gap`.
- `#exportFmt button[disabled]` — muted + `cursor:not-allowed` (the Split chip
  when no parts).
- Reuse existing `.axes`, `.check`, `.field`, `.btnrow`, `.hint`, `.optlabel`
  styles for the inner controls.

## 6 · Testing

The export **build** logic (`ThreeMF.exportZip` / `exportSplit`,
`ObjExport.build`) is unchanged and already covered — the **76-test
`node --test` suite stays green** (the `triggerDownload`/filename refactor is
naming + DOM glue the `vm` harness doesn't exercise).

Browser-verified checklist:

- Top bar shows a single **Export** button (no `.obj` button, no Weld
  checkbox); the Split panel has no Export-split button.
- Clicking **Export** opens the modal; default format **3MF**, description and
  the default output name shown; Weld hidden.
- Switching to **OBJ** reveals **Weld** and sets the name to `<base>_paint.zip`;
  back to **3MF** hides Weld and sets `<base>_fixed.3mf`.
- **Split** chip is disabled with no split parts; after splitting a region it
  enables, its description shows the part count, and the name is
  `<base>_split.3mf`.
- Each format's **Export** downloads the right artifact with the (possibly
  edited) name; **Weld** on/off is honored by the OBJ output; the modal closes
  on success and a toast confirms.
- **Cancel**, **backdrop click**, and **Esc** each close the modal with no
  export; when the modal is closed, Esc still returns to looking (Batch N).
- Console clean; the top **Export** button stays disabled until a model loads.

## Out of scope

- Changing the export *build* logic, cap-method selection (stays in the Split
  tool), or filament-config normalization.
- Remembering the last-used format/name across opens; export presets; choosing
  a save directory (browser download only).
- A keyboard shortcut to open the dialog.
