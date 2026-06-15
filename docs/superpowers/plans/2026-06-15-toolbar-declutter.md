# Toolbar Declutter (Batch N) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Slim the top toolbar from 7 tools to 5 grouped edit tools, make navigation the ambient resting state (no Orbit button), and move model-orientation (Rotate) to a stage-corner "Orient" popover.

**Architecture:** Pure UI rewiring across three files — `index.html` (markup), `css/style.css` (toolbar grouping + popover), `js/app.js` (tool dispatch, the relocated rotate handler, keyboard). No geometry, parser, or `Cleanup`/`Paint`/`Viewer` logic changes. The viewer's existing `"orbit"` mode already *is* the resting state; we simply stop drawing a button for it. Spec: `docs/superpowers/specs/2026-06-15-toolbar-declutter-design.md`.

**Tech Stack:** Vanilla JS IIFEs, no build step. three.js (vendored) for the 3D view.

> **Note on line numbers:** all `path:line` references are hints against the *pre-edit* files. Tasks run in order and insert/remove lines, so numbers drift between tasks. **Locate each edit by the quoted code block, not the line number** — every step quotes the exact text to find.

### How to verify (read once, applies to every task)

This is UI wiring — the `node --test` harness loads only the pure logic modules, **not** `app.js`/`viewer.js`, so it cannot catch DOM-wiring regressions. Verification is in the browser:

1. **Stale-cache gotcha (from CLAUDE.md):** after editing files under `js/`, Chrome + `http.server` serve stale modules. **Start the server on a NEW port every time** (bump the number): `python3 -m http.server 8131` → open `http://localhost:8131`. Or hard-reload (⌘⇧R).
2. Open DevTools Console — it must be **clean** (no "X is not a function" / null errors on load or interaction).
3. Load the reference model: drag `samples/`'s `.3mf` onto the stage (or use "Choose a .3mf file").
4. `npm test` at the end of each task must still report **`pass 74 / fail 0`** (proves no logic module was disturbed).

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `index.html` | Toolbar + options-strip + stage markup | Remove orbit/rotate buttons & kbd badges; add toolbar divider; remove rotate options panel; add `#orientBtn` + `#orientPop` |
| `css/style.css` | Toolbar & stage styling | Drop `.tool .kbd` rules; add `.tooldiv`; add `.orientpop` + `#orientBtn` position |
| `js/app.js` | Tool dispatch, rotate handler binding, keyboard | Toggle-off on active tool; rebind `[data-rot]` to popover; drop `recenterBtn` handler; reveal `#orientBtn`; popover toggle/close; keymap (`r`→popover, drop `rotate`, add `Esc`) |

---

## Task 1: Slim the toolbar (markup + style only)

Removes Orbit & Rotate buttons and the keyboard-key badges, and groups the five remaining tools paint·cut with a divider. No JS behavior changes — the load path still calls `setTool("orbit")`, which now highlights nothing (no matching button) and shows the orbit hint panel. The Rotate tool stays reachable via the `r` key for this one task (its options panel still exists); Task 2 relocates it.

**Files:**
- Modify: `index.html:18-54` (the `#toolbar` block)
- Modify: `css/style.css:48-59` (`.tool` padding; remove `.kbd` rules), add `.tooldiv` near `:47`

- [ ] **Step 1: Replace the `#toolbar` block in `index.html`**

Replace the entire `<div class="tools" id="toolbar"> … </div>` (lines 18-54) with:

```html
        <div class="tools" id="toolbar">
          <button class="tool" data-tool="brush" title="Brush (B) — paint by dragging">
            <svg class="ic" viewBox="0 0 24 24"><path d="M3 21c2.2 0 3.3-1.1 3.8-2.6"/><path d="M6.7 18.4c-1-1-1-2.5 0-3.5L15 6.6l2.9 2.9-8.3 8.3c-1 1-2.6 1-3.6 0z"/><path d="M14 5.6l2.4-2.4a1.9 1.9 0 0 1 2.7 2.7L16.7 8.3z"/></svg>
            <span>Brush</span>
          </button>
          <button class="tool" data-tool="ring" title="Ring (N) — wrap a colored band">
            <svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.4"/></svg>
            <span>Ring</span>
          </button>
          <button class="tool" data-tool="fill" title="Fill (F) a same-color region">
            <svg class="ic" viewBox="0 0 24 24"><path d="M10.5 3.6l8 8-6.2 6.2a2.4 2.4 0 0 1-3.4 0L4 13a2.4 2.4 0 0 1 0-3.4z"/><path d="M8.9 5.2 7.1 3.4"/><path d="M4.7 12.4h13.6"/><path d="M20 13.6c1 1.3 1 2.8 0 3.8s-2.3.3-2.3-1.4 1.3-2.4 2.3-2.4z"/></svg>
            <span>Fill</span>
          </button>
          <span class="tooldiv" aria-hidden="true"></span>
          <button class="tool" data-tool="split" title="Split (S) a color into its own solid">
            <svg class="ic" viewBox="0 0 24 24"><path d="M12 3v18"/><path d="M5 8l-2 4 2 4"/><path d="M19 8l2 4-2 4"/></svg>
            <span>Split</span>
          </button>
          <button class="tool" data-tool="cut" title="Cut (C) — plane cut into two solids">
            <svg class="ic" viewBox="0 0 24 24"><path d="M4 5l16 14"/><path d="M20 5L4 19"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/></svg>
            <span>Cut</span>
          </button>
        </div>
```

(Orbit & Rotate buttons gone; every `<kbd class="kbd">…</kbd>` removed; `.tooldiv` inserted between Fill and Split; the previously-`active` class is gone so nothing is highlighted by default.)

- [ ] **Step 2: Remove the dead kbd rules in `css/style.css`**

Delete these two lines (58-59):

```css
.tool .kbd { font-family: inherit; font-size: 10.5px; line-height: 1; font-weight: 700; padding: 3px 5px; border-radius: 5px; background: var(--card-2); color: var(--muted); border: 1px solid var(--line); }
.tool.active .kbd { background: rgba(255, 255, 255, 0.18); color: #fff; border-color: transparent; }
```

- [ ] **Step 3: Add the divider + tighten the button padding in `css/style.css`**

Change `.tool`'s padding (line 49) from `padding: 0 14px;` to `padding: 0 13px;`, then add this rule immediately after the `.tools` rule (line 47):

```css
.tooldiv { width: 1px; height: 24px; background: var(--line); margin: 0 4px; flex: 0 0 auto; align-self: center; }
```

- [ ] **Step 4: Verify in the browser**

Start fresh: `python3 -m http.server 8131` → open `http://localhost:8131`. Confirm:
- Toolbar shows exactly **5** buttons: Brush · Ring · Fill ┃ Split · Cut, with a thin divider before Split.
- **No** keyboard-key badges on any button. Hovering a button shows the shortcut in the tooltip (e.g. "Brush (B) — paint by dragging").
- On load nothing is highlighted; load a model — left-drag orbits, right-drag pans, scroll zooms; the options strip shows "Drag to rotate · scroll to zoom · right-drag to pan".
- Clicking Brush/Ring/Fill/Split/Cut still selects and works. Console is clean.

- [ ] **Step 5: Confirm logic suite untouched**

Run: `npm test`
Expected: `ℹ pass 74` / `ℹ fail 0`

- [ ] **Step 6: Commit**

```bash
git add index.html css/style.css
git commit -m "refactor(ui): slim toolbar to 5 edit tools, grouped, no kbd badges

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Relocate Rotate to a stage "Orient" popover

Moves the model-orient 90° grid out of the options strip into a stage-corner popover, rebinds its click handler, drops the now-defunct "Refit view" button (its job is the existing ⤢ reframe button), reveals the new button on load, and updates the keyboard so `r` toggles the popover instead of selecting a (now-removed) Rotate tool.

**Files:**
- Modify: `index.html:76-84` (remove rotate panel), `index.html:216-217` (add stage button + popover)
- Modify: `css/style.css:250-253` (add `#orientBtn` position + `.orientpop`)
- Modify: `js/app.js:708-711` (rebind `[data-rot]`, drop `recenterBtn`), `:170` (reveal button), `:752-753` (popover wiring), `:775-776` (keymap)

- [ ] **Step 1: Remove the rotate options panel from `index.html`**

Delete the whole block (lines 76-84):

```html
        <div class="opt" data-panel="rotate" hidden>
          <span class="optlabel">Rotate 90°</span>
          <div class="rotgrid">
            <button data-rot="x:-1">X−</button><button data-rot="x:1">X+</button>
            <button data-rot="y:-1">Y−</button><button data-rot="y:1">Y+</button>
            <button data-rot="z:-1">Z−</button><button data-rot="z:1">Z+</button>
          </div>
          <button id="recenterBtn" class="ghost slim">Refit view</button>
        </div>
```

- [ ] **Step 2: Add the Orient button + popover to the stage in `index.html`**

Immediately after the `#bgToggle` button (line 217), insert:

```html
          <button id="orientBtn" class="stagebtn" hidden title="Orient — rotate the model 90° (R)">⟳</button>
          <div id="orientPop" class="orientpop" hidden>
            <div class="orientpop-label">Rotate 90°</div>
            <div class="rotgrid">
              <button data-rot="x:-1">X−</button><button data-rot="x:1">X+</button>
              <button data-rot="y:-1">Y−</button><button data-rot="y:1">Y+</button>
              <button data-rot="z:-1">Z−</button><button data-rot="z:1">Z+</button>
            </div>
          </div>
```

- [ ] **Step 3: Style the popover in `css/style.css`**

After the dark-mode stagebtn rules (line 253), add:

```css
#orientBtn { top: 116px; }
.orientpop {
  position: absolute; right: 70px; top: 108px; z-index: 7; padding: 10px 12px;
  background: rgba(255, 255, 255, 0.96); border: 1px solid rgba(0, 0, 0, 0.08); border-radius: 12px;
  box-shadow: 0 12px 30px -10px rgba(16, 24, 40, 0.35); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
}
.orientpop[hidden] { display: none; }
.orientpop-label { font-size: 11px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; margin-bottom: 8px; }
.orientpop .rotgrid button { padding: 8px 0; }
#stage.dark .orientpop { background: rgba(20, 24, 33, 0.85); border-color: rgba(255, 255, 255, 0.14); color: #fff; }
```

(The popover's `.rotgrid` is outside `.opt`, so it picks up the 2-column grid rule at `css/style.css:208` — X±/Y±/Z± in three rows.)

- [ ] **Step 4: Rebind the rotate handler and drop `recenterBtn` in `js/app.js`**

Replace lines 708-711:

```js
  document.querySelectorAll("#optionsbar [data-rot]").forEach((b) =>
    b.addEventListener("click", () => { const [ax, d] = b.dataset.rot.split(":"); doRotate({ x: 0, y: 1, z: 2 }[ax], +d); })
  );
  $("recenterBtn").addEventListener("click", () => Viewer.frame());
```

with (selector now targets the popover; `recenterBtn` line removed entirely — ⤢ `#reframeBtn` already calls `Viewer.frame()` at line 752):

```js
  document.querySelectorAll("#orientPop [data-rot]").forEach((b) =>
    b.addEventListener("click", () => { const [ax, d] = b.dataset.rot.split(":"); doRotate({ x: 0, y: 1, z: 2 }[ax], +d); })
  );
```

- [ ] **Step 5: Reveal the Orient button on load in `js/app.js`**

After `$("bgToggle").hidden = false;` (line 170), add:

```js
      $("orientBtn").hidden = false;
```

- [ ] **Step 6: Wire the popover toggle + outside-click close in `js/app.js`**

After `$("bgToggle").addEventListener("click", …)` (line 753), add:

```js
  $("orientBtn").addEventListener("click", (e) => { e.stopPropagation(); $("orientPop").hidden = !$("orientPop").hidden; });
  document.addEventListener("click", (e) => {
    const pop = $("orientPop");
    if (!pop.hidden && !pop.contains(e.target) && e.target !== $("orientBtn")) pop.hidden = true;
  });
```

- [ ] **Step 7: Update the keymap in `js/app.js`**

Replace lines 775-776:

```js
    const tool = { o: "orbit", r: "rotate", b: "brush", n: "ring", f: "fill", s: "split", c: "cut" }[e.key.toLowerCase()];
    if (tool) { e.preventDefault(); setTool(tool); }
```

with (`r` now toggles the popover; `rotate` is no longer a tool):

```js
    const k = e.key.toLowerCase();
    if (k === "r") { e.preventDefault(); $("orientPop").hidden = !$("orientPop").hidden; return; }
    const tool = { o: "orbit", b: "brush", n: "ring", f: "fill", s: "split", c: "cut" }[k];
    if (tool) { e.preventDefault(); setTool(tool); }
```

- [ ] **Step 8: Verify in the browser**

Fresh server on a new port (`python3 -m http.server 8132`). Load a model. Confirm:
- A **⟳** button appears in the stage's top-right cluster (below ⤢ and ◐).
- Clicking ⟳ opens a "Rotate 90°" popover with X±/Y±/Z±; each button rotates the model 90° about that axis (same as the old Rotate tool).
- The popover works while navigating **and** while a paint/cut tool is armed (no tool switch needed).
- Pressing **R** toggles the popover; clicking anywhere outside it closes it.
- The options strip no longer has a Rotate panel. The ⤢ button still refits the view. Console clean.

- [ ] **Step 9: Confirm logic suite untouched**

Run: `npm test`
Expected: `ℹ pass 74` / `ℹ fail 0`

- [ ] **Step 10: Commit**

```bash
git add index.html css/style.css js/app.js
git commit -m "feat(ui): move model-orient to a stage Orient popover

Drops the Rotate tool/options panel; X/Y/Z 90° grid now lives in a
stage-corner popover (R toggles it), usable with any tool armed. Old
\"Refit view\" folds into the existing reframe button.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: Return-to-looking (deselect) behaviors

Makes the resting "no tool selected = navigate" state reachable: clicking the already-active tool toggles back to orbit, and Esc deselects the current tool and closes the Orient popover. (`O` already maps to `orbit`; `Esc` is added here.)

**Files:**
- Modify: `js/app.js:707` (toolbar click toggle-off), `:770-771` (Esc handler)

- [ ] **Step 1: Toggle off the active tool on re-click in `js/app.js`**

Replace line 707:

```js
  document.querySelectorAll("#toolbar .tool").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
```

with:

```js
  document.querySelectorAll("#toolbar .tool").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool === activeTool ? "orbit" : b.dataset.tool)));
```

- [ ] **Step 2: Add an Esc handler in the keydown listener in `js/app.js`**

The keydown handler starts at line 766. Immediately after the redo line (line 770: `if (mod && e.key.toLowerCase() === "y") { … return; }`) and before the `// tool shortcuts` comment (line 771), insert:

```js
    if (e.key === "Escape") { $("orientPop").hidden = true; setTool("orbit"); return; }
```

- [ ] **Step 3: Verify in the browser**

Fresh server on a new port (`python3 -m http.server 8133`). Load a model. Confirm:
- Pick Brush (it highlights). Click Brush again → it de-highlights and you're back to looking (left-drag orbits). Repeat with each tool.
- Pick any tool, press **Esc** → tool de-highlights, back to looking; if the Orient popover was open, Esc also closes it.
- Press **O** → also returns to looking (nothing highlighted). Console clean.

- [ ] **Step 4: Confirm logic suite untouched**

Run: `npm test`
Expected: `ℹ pass 74` / `ℹ fail 0`

- [ ] **Step 5: Commit**

```bash
git add js/app.js
git commit -m "feat(ui): no-tool resting state — click-off / Esc / O return to looking

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: Full spec-checklist verification pass

No code — a final walk through the spec's browser checklist to confirm the whole feature hangs together, then mark the spec shipped.

**Files:**
- Modify: `docs/superpowers/specs/2026-06-15-toolbar-declutter-design.md` (status line)

- [ ] **Step 1: Walk the spec §7 checklist in the browser**

Fresh server (`python3 -m http.server 8134`), load a model, and confirm every line of the spec's "Browser-verified checklist":
- 5 tools in two groups with a divider; no kbd badges; tooltips show shortcuts.
- On load nothing highlighted; left-drag orbits, right-drag pans, scroll zooms; options strip shows the nav hint.
- Each of Brush/Ring/Fill/Split/Cut selects and behaves as before; orbit-while-editing works (pick: drag orbits / click picks; brush: background-drag and Alt+left orbit).
- Esc / clicking the active tool returns to looking.
- ⟳ Orient opens the popover; X±/Y±/Z± rotate 90°; works while navigating and while a tool is armed; closes on outside-click and Esc; R toggles it.
- ⤢ reframe refits the view. Undo/redo/Export and brush mirror/symmetry unaffected.

If anything fails, fix it in the relevant file and re-verify before continuing.

- [ ] **Step 2: Mark the spec shipped**

In `docs/superpowers/specs/2026-06-15-toolbar-declutter-design.md`, change the status line from:

```markdown
**Status:** Approved (ready for implementation plan)
```

to:

```markdown
**Status:** Shipped (Batch N).
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-15-toolbar-declutter-design.md
git commit -m "docs: mark Batch N toolbar declutter spec shipped

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Out of scope (do not implement)

- Left sidebar (zone B) or options-strip restructure beyond removing the Rotate panel.
- Collapsing tools into nested menus.
- Icon/visual redesign of buttons; persisting tool or orient state across reloads.
