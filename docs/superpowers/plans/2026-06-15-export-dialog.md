# Export Dialog (Batch O) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the three scattered export entry points (Export .3mf, .obj button + Weld checkbox, Export-split) into one **Export** button that opens a pick-format modal with per-format options and an editable output name.

**Architecture:** Pure UI rewiring + a small refactor in three files — `index.html` (remove the .obj/Weld/split buttons, add a modal), `css/style.css` (modal styles), `js/app.js` (a `triggerDownload` helper, parameterize the three `doExport*` functions by output name/weld, and add the dialog's open/select/close/dispatch logic). No change to the export *build* logic (`ThreeMF.exportZip`/`exportSplit`, `ObjExport.build`). Spec: `docs/superpowers/specs/2026-06-15-export-dialog-design.md`.

**Tech Stack:** Vanilla JS IIFEs, no build step. JSZip (vendored) for the OBJ zip.

> **Note on line numbers:** all `path:line` references are pre-edit hints; Task 1 shifts Task 2's lines. **Locate each edit by the quoted code block, not the line number.**

### How to verify (read once, applies to every task)

UI wiring — the `node --test` harness loads only the pure logic modules, not `app.js`. So:

1. After any `js/app.js` edit, run `node --check js/app.js` (catches syntax errors the harness can't).
2. Run `npm test` — must stay **`pass 76 / fail 0`** (proves the export build logic / modules are undisturbed).
3. Browser checks happen in Task 3. Do **not** start a web server in Tasks 1–2.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `index.html` | Top bar, Split panel, modal markup | Remove `#objWeldWrap`/`#exportObjBtn` (top bar) and `#exportSplitBtn` (Split panel); add `#exportModal` |
| `css/style.css` | Modal styling | Add `.modal` / `.modal-card` / disabled-chip rules |
| `js/app.js` | Export functions + dialog wiring | `triggerDownload` + `exportDefaultName` helpers; parameterize `doExport*`; dialog open/select/close/dispatch; keymap modal-Esc; remove dead button wiring |

---

## Task 1: Parameterize the exporters + shared download helper (`js/app.js` only)

Refactors the three export functions to take the chosen output name (and weld), routing through one `triggerDownload` helper, while keeping the existing buttons working identically (they pass the current default names). Self-contained; the UI is unchanged after this task.

**Files:**
- Modify: `js/app.js` (the `doExportSplit`/`doExportObj`/`doExport` functions; the three export listeners)

- [ ] **Step 1: Add the `exportDefaultName` + `triggerDownload` helpers**

Find the start of `doExportSplit`:

```js
  async function doExportSplit() {
```

Insert these helpers immediately **above** that line:

```js
  function exportBase() { return fileName.replace(/\.3mf$/i, ""); }
  function exportDefaultName(fmt) {
    const base = exportBase();
    return fmt === "obj" ? base + "_paint.zip" : fmt === "split" ? base + "_split.3mf" : base + "_fixed.3mf";
  }
  function triggerDownload(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("Saved " + name);
  }
```

- [ ] **Step 2: Parameterize `doExportSplit`**

Replace the whole function:

```js
  async function doExportSplit() {
    if (!doc) return;
    if (!splitParts.length) { toast("Split a region first", true); return; }
    try {
      toast("Packing split .3mf …");
      const blob = await ThreeMF.exportSplit(doc, splitParts);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fileName.replace(/\.3mf$/i, "") + "_split.3mf";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast("Saved " + a.download);
    } catch (e) { console.error(e); toast("Split export failed: " + e.message, true); }
  }
```

with:

```js
  async function doExportSplit(outName) {
    if (!doc) return;
    if (!splitParts.length) { toast("Split a region first", true); return; }
    try {
      toast("Packing split .3mf …");
      triggerDownload(await ThreeMF.exportSplit(doc, splitParts), outName);
    } catch (e) { console.error(e); toast("Split export failed: " + e.message, true); }
  }
```

- [ ] **Step 3: Parameterize `doExportObj`**

Replace the whole function:

```js
  async function doExportObj() {
    if (!doc) return;
    try {
      const weld = $("objWeld") ? $("objWeld").checked : true;
      toast("Building .obj …");
      const base = fileName.replace(/\.3mf$/i, "");
      const { obj, mtl } = ObjExport.build(doc, { weld, mtlName: base + ".mtl" });
      const zip = new JSZip();
      zip.file(base + ".obj", obj);
      zip.file(base + ".mtl", mtl);
      const blob = await zip.generateAsync({
        type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 },
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = base + "_paint.zip";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast("Saved " + a.download);
    } catch (e) { console.error(e); toast("OBJ export failed: " + e.message, true); }
  }
```

with (weld is now a parameter; archive names derive from the output name):

```js
  async function doExportObj(outName, weld) {
    if (!doc) return;
    try {
      toast("Building .obj …");
      const zipBase = outName.replace(/\.zip$/i, "");
      const { obj, mtl } = ObjExport.build(doc, { weld: weld !== false, mtlName: zipBase + ".mtl" });
      const zip = new JSZip();
      zip.file(zipBase + ".obj", obj);
      zip.file(zipBase + ".mtl", mtl);
      const blob = await zip.generateAsync({
        type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 },
      });
      triggerDownload(blob, outName);
    } catch (e) { console.error(e); toast("OBJ export failed: " + e.message, true); }
  }
```

- [ ] **Step 4: Parameterize `doExport`**

Replace the whole function:

```js
  async function doExport() {
    if (!doc) return;
    try {
      if (previewActive) { restore(current()); previewActive = false; render(null); }
      restore(current());
      toast("Packing .3mf …");
      const blob = await ThreeMF.exportZip(doc);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fileName.replace(/\.3mf$/i, "") + "_fixed.3mf";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast("Saved " + a.download);
    } catch (e) { console.error(e); toast("Export failed: " + e.message, true); }
  }
```

with:

```js
  async function doExport(outName) {
    if (!doc) return;
    try {
      if (previewActive) { restore(current()); previewActive = false; render(null); }
      restore(current());
      toast("Packing .3mf …");
      triggerDownload(await ThreeMF.exportZip(doc), outName);
    } catch (e) { console.error(e); toast("Export failed: " + e.message, true); }
  }
```

- [ ] **Step 5: Update the three listeners to pass default names**

Replace:

```js
  $("exportBtn").addEventListener("click", doExport);
  $("exportObjBtn").addEventListener("click", doExportObj);
  $("exportSplitBtn").addEventListener("click", doExportSplit);
```

with (behavior identical to before; these get re-wired in Task 2):

```js
  $("exportBtn").addEventListener("click", () => doExport(exportDefaultName("3mf")));
  $("exportObjBtn").addEventListener("click", () => doExportObj(exportDefaultName("obj"), $("objWeld").checked));
  $("exportSplitBtn").addEventListener("click", () => doExportSplit(exportDefaultName("split")));
```

- [ ] **Step 6: Verify**

Run: `node --check js/app.js` → clean.
Run: `npm test` → `ℹ pass 76` / `ℹ fail 0`.

- [ ] **Step 7: Commit**

```bash
git add js/app.js
git commit -m "refactor(export): parameterize exporters by name + shared triggerDownload

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Build the export modal & consolidate (`index.html`, `css/style.css`, `js/app.js`)

Adds the modal, wires the top-bar **Export** button to open it, and removes the now-redundant `.obj`/Weld/Export-split controls and their listeners. After this task the dialog is the single export hub.

**Files:**
- Modify: `index.html` (top bar, Split panel, add modal)
- Modify: `css/style.css` (modal styles)
- Modify: `js/app.js` (dialog logic, re-wire, load block, keymap)

- [ ] **Step 1: Remove the `.obj` button + Weld checkbox from the top bar (`index.html`)**

Delete these lines (between the redo button and the `#exportBtn`):

```html
          <label class="check" id="objWeldWrap" title="Share coincident vertices — smaller file, smooth shading"><input type="checkbox" id="objWeld" checked /><span>Weld</span></label>
          <button id="exportObjBtn" class="secondary" disabled title="Export the painted model as a colored .obj (+.mtl, zipped)">
            <svg class="ic" viewBox="0 0 24 24"><path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>
            .obj
          </button>
```

(`#exportBtn` "Export" stays and becomes the dialog trigger.)

- [ ] **Step 2: Remove the Export-split button from the Split panel (`index.html`)**

Replace:

```html
          <span class="muted">Click a colored part to lift it out as its own solid.</span>
          <button id="exportSplitBtn" class="secondary slim">Export split (.3mf)</button>
```

with:

```html
          <span class="muted">Click a colored part to lift it out as its own solid.</span>
```

- [ ] **Step 3: Add the modal markup (`index.html`)**

Find the end of `#main` and the closing of `#app`:

```html
        </main>
      </div>
    </div>
```

Insert the modal between the `#main` close and the `#app` close, so it reads:

```html
        </main>
      </div>

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
    </div>
```

- [ ] **Step 4: Add modal CSS (`css/style.css`)**

Append at the end of the file:

```css
/* ---------- export modal ---------- */
.modal { position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; background: rgba(15, 18, 24, 0.45); -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px); }
.modal[hidden] { display: none; }
.modal-card { width: min(360px, 92vw); display: flex; flex-direction: column; gap: 12px; padding: 20px; background: var(--panel); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 24px 60px -20px rgba(16, 24, 40, 0.5); }
.modal-card h2 { margin: 0; font-size: 16px; }
.modal-card .btnrow { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
#exportFmt button[disabled] { opacity: .4; cursor: not-allowed; }
```

- [ ] **Step 5: Add the dialog logic (`js/app.js`)**

Find the line that begins the events section:

```js
  // ---------- events ----------
```

Insert this block immediately **above** that line:

```js
  // ---------- export dialog ----------
  function exportDescribe(fmt) {
    if (fmt === "obj") return "Colored mesh as .obj + .mtl, zipped — for other tools.";
    if (fmt === "split") return "Each painted region as its own watertight solid (" + splitParts.length + " parts).";
    return "Repaired model, ready to re-slice.";
  }
  function selectExportFmt(fmt) {
    document.querySelectorAll("#exportFmt button").forEach((b) => b.classList.toggle("on", b.dataset.fmt === fmt));
    $("exportDesc").textContent = exportDescribe(fmt);
    $("exportWeldWrap").hidden = fmt !== "obj";
    $("exportName").value = exportDefaultName(fmt);
  }
  function openExportDialog() {
    if (!doc) return;
    const splitChip = document.querySelector('#exportFmt button[data-fmt="split"]');
    const noParts = splitParts.length === 0;
    splitChip.disabled = noParts;
    splitChip.title = noParts ? "Split a region first" : "";
    selectExportFmt("3mf");
    $("exportModal").hidden = false;
    $("exportName").focus();
  }
  function closeExportDialog() { $("exportModal").hidden = true; }
  function runExport() {
    const active = document.querySelector("#exportFmt button.on");
    const fmt = active ? active.dataset.fmt : "3mf";
    const name = $("exportName").value.trim() || exportDefaultName(fmt);
    closeExportDialog();
    if (fmt === "obj") doExportObj(name, $("exportWeld").checked);
    else if (fmt === "split") doExportSplit(name);
    else doExport(name);
  }
```

- [ ] **Step 6: Re-wire the buttons (`js/app.js`)**

Replace the three listeners added in Task 1:

```js
  $("exportBtn").addEventListener("click", () => doExport(exportDefaultName("3mf")));
  $("exportObjBtn").addEventListener("click", () => doExportObj(exportDefaultName("obj"), $("objWeld").checked));
  $("exportSplitBtn").addEventListener("click", () => doExportSplit(exportDefaultName("split")));
```

with (Export now opens the dialog; the old buttons are gone, so their listeners are removed; the dialog controls are wired):

```js
  $("exportBtn").addEventListener("click", openExportDialog);
  document.querySelectorAll("#exportFmt button").forEach((b) =>
    b.addEventListener("click", () => { if (!b.disabled) selectExportFmt(b.dataset.fmt); })
  );
  $("exportCancel").addEventListener("click", closeExportDialog);
  $("exportGo").addEventListener("click", runExport);
  $("exportModal").addEventListener("click", (e) => { if (e.target === $("exportModal")) closeExportDialog(); });
```

- [ ] **Step 7: Drop the dead load-block line (`js/app.js`)**

In the load block, delete this line (the `#exportObjBtn` no longer exists; `#exportBtn` on the line above still enables):

```js
      $("exportObjBtn").disabled = false;
```

- [ ] **Step 8: Add the modal-Esc handler to the keydown listener (`js/app.js`)**

Find the start of the keydown handler (the `document.addEventListener("keydown"` line is unique — don't match a bare `if (!doc) return;`, which appears in many functions):

```js
  document.addEventListener("keydown", (e) => {
    if (!doc) return;
```

Replace it with (adds the modal gate above the undo/redo lines, so native text-editing keys reach the name field and Esc closes the dialog regardless of focus):

```js
  document.addEventListener("keydown", (e) => {
    if (!doc) return;
    if (!$("exportModal").hidden) { if (e.key === "Escape") closeExportDialog(); return; }
```

- [ ] **Step 9: Verify**

Run: `node --check js/app.js` → clean.
Run: `grep -n "objWeld\|exportObjBtn\|exportSplitBtn" js/app.js index.html` → **no matches** (all old references gone).
Run: `npm test` → `ℹ pass 76` / `ℹ fail 0`.

- [ ] **Step 10: Commit**

```bash
git add index.html css/style.css js/app.js
git commit -m "feat(export): unified export dialog (format + options + name)

One Export button opens a modal to pick 3MF / OBJ / Split, set per-format
options (weld) and an editable output name. Replaces the scattered .obj /
Weld / Export-split controls; Esc/backdrop/Cancel close it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: Browser verification + mark spec shipped

No code beyond the spec status line — a full walk of the spec's browser checklist, then mark it shipped.

**Files:**
- Modify: `docs/superpowers/specs/2026-06-15-export-dialog-design.md` (status line)

- [ ] **Step 1: Verify in the browser**

Start fresh: `python3 -m http.server 8141` → open `http://localhost:8141`. Load the reference model (`samples/`'s `.3mf`). Confirm:
- Top bar shows a single **Export** button — no `.obj` button, no Weld checkbox; the Split panel has no Export-split button.
- Click **Export** → modal opens, default **3MF**, description "Repaired model, ready to re-slice.", output name `<base>_fixed.3mf`, Weld hidden.
- Switch to **OBJ** → Weld appears, name becomes `<base>_paint.zip`; toggle Weld; click Export → a `.zip` downloads; modal closes; toast.
- Switch back to **3MF** → Weld hidden, name `<base>_fixed.3mf`; Export downloads a `.3mf`.
- **Split** chip is disabled before splitting; use the Split tool to lift a part, reopen Export → Split enabled, description shows the part count, name `<base>_split.3mf`; Export downloads.
- Edit the **Output name** field → the downloaded file uses the edited name.
- **Cancel**, **backdrop click**, and **Esc** each close the modal with no export; with the modal closed, Esc still returns to looking (Batch N). Console clean.

If anything fails, fix it in the relevant file and re-verify.

- [ ] **Step 2: Mark the spec shipped**

In `docs/superpowers/specs/2026-06-15-export-dialog-design.md`, change:

```markdown
**Status:** Approved (ready for implementation plan)
```

to:

```markdown
**Status:** Shipped (Batch O).
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-15-export-dialog-design.md
git commit -m "docs: mark Batch O export dialog spec shipped

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Out of scope (do not implement)

- Changing export *build* logic, cap-method selection (stays in the Split tool), or filament normalization.
- Remembering last-used format/name; export presets; choosing a save directory.
- A keyboard shortcut to open the dialog.
