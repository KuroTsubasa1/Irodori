# Tool Interaction Polish (Batch H) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Brush adopts fill's viewport navigation (left-drag orbits unless it starts on the model; right-drag pans; Alt+left orbits anywhere), and the fill tool gains a hover preview of the region a click would fill.

**Architecture:** A capture-phase pointer-down listener on the viewer container raycasts each left press in paint mode and flips `controls.mouseButtons.LEFT` between paint (hit) and orbit (miss) before OrbitControls sees the event. The fill preview reuses the shared split/ring hover-tint cache in `app.js`.

**Tech Stack:** Vanilla JS, three.js OrbitControls.

**Spec:** `docs/superpowers/specs/2026-06-10-tool-interaction-polish-design.md`

**Conventions:** `node --test` stays **42 pass / 0 fail** (UI wiring only); `node --check` changed files; stage only named files; never the `.3mf`s.

---

### Task 1: Brush navigation = fill's (`js/viewer.js`)

**Files:**
- Modify: `js/viewer.js` (`setTool` paint branch, `init` pointer handling)

- [ ] **Step 1: Right-drag pans in paint mode.** In `setTool(mode)`, the paint branch currently reads:
```javascript
    if (mode === "paint") {
      // left paints, right-drag rotates
      controls.mouseButtons = { LEFT: null, MIDDLE: M.DOLLY, RIGHT: M.ROTATE };
      renderer.domElement.style.cursor = "crosshair";
    }
```
Change it to fill-parity buttons:
```javascript
    if (mode === "paint") {
      // fill-parity navigation: left paints on the model / orbits from the
      // background (per-press dispatch in init), right-drag pans, middle zooms
      controls.mouseButtons = { LEFT: null, MIDDLE: M.DOLLY, RIGHT: M.PAN };
      renderer.domElement.style.cursor = "crosshair";
    }
```

- [ ] **Step 2: Per-press left-button dispatch.** In `init(container)`, immediately BEFORE the existing `el.addEventListener("pointerdown", ...)` line, add a capture-phase listener on the container (ancestor capture runs before OrbitControls' canvas listeners):
```javascript
    // Fill-parity navigation for the brush: decide per press what the left
    // button does — paint when the press starts on the model, orbit when it
    // starts on empty background. Capture phase on the container so the
    // decision lands before OrbitControls reads the event.
    container.addEventListener(
      "pointerdown",
      (e) => {
        if (toolMode !== "paint" || e.button !== 0 || altOrbit) return;
        const hit = pick(e.clientX, e.clientY);
        controls.mouseButtons.LEFT = hit ? null : THREE.MOUSE.ROTATE;
      },
      true
    );
```

- [ ] **Step 3: Only enter painting on a hit.** The existing canvas pointerdown paint branch reads:
```javascript
      if (toolMode === "paint" && e.button === 0 && paintCb && !altOrbit) {
        painting = true;
        const hit = pick(e.clientX, e.clientY);
        if (hit && paintCb.down) paintCb.down(hit);
      }
```
Change it so a background press (which now orbits) never enters painting state:
```javascript
      if (toolMode === "paint" && e.button === 0 && paintCb && !altOrbit) {
        const hit = pick(e.clientX, e.clientY);
        if (hit) {
          painting = true;
          if (paintCb.down) paintCb.down(hit);
        }
      }
```

- [ ] **Step 4: Run** — `node --check js/viewer.js && node --test` → silent; **42 pass / 0 fail**.

- [ ] **Step 5: Commit**
```bash
git add js/viewer.js
git commit -m "feat(brush): fill-parity navigation — background-drag orbits, right-drag pans"
```

---

### Task 2: Fill hover preview (`js/app.js`)

**Files:**
- Modify: `js/app.js` (`setTool`, `onHover`, `doFill`)

- [ ] **Step 1: Enable hover + clear for fill.** In `setTool`, change
```javascript
    Viewer.enableHover(name === "brush" || name === "ring" || name === "split");
    if (name !== "split" && name !== "ring") clearHoverPreview();
```
to
```javascript
    Viewer.enableHover(name === "brush" || name === "ring" || name === "split" || name === "fill");
    if (name !== "split" && name !== "ring" && name !== "fill") clearHoverPreview();
```

- [ ] **Step 2: Tint the fill region on hover.** In `onHover`, the tint branch opens with
```javascript
    if (activeTool === "split" || activeTool === "ring") {
```
— include fill:
```javascript
    if (activeTool === "split" || activeTool === "ring" || activeTool === "fill") {
```
and where the branch picks the subs (`if (activeTool === "split") {...} else {...ring...}`), make fill use the same flood `fillRegion` performs:
```javascript
      let subs;
      if (activeTool === "split") {
        subs = Cleanup.selectColorRegion(m, hit.localSub, claimedByMesh()[hit.meshIndex]);
      } else if (activeTool === "fill") {
        subs = Cleanup.selectColorRegion(m, hit.localSub); // fillRegion's flood (no claimed-exclusion)
      } else {
        const fa = Cleanup.featureAxis(m, hit.localSub, ringNeighborhood(), hit.normal.x, hit.normal.y, hit.normal.z);
        subs = Cleanup.selectBandAxis(m, hit.localSub, ringHalf(), fa.ax, fa.ay, fa.az);
      }
```

- [ ] **Step 3: Clear on apply.** In `doFill(hit)`, add `clearHoverPreview();` immediately after its `previewActive` restore line (mirroring `doSplit`).

- [ ] **Step 4: Run** — `node --check js/app.js && node --test` → silent; **42 pass / 0 fail**.

- [ ] **Step 5: Browser-verify** — Brush: background-drag orbits with no history entry; model-drag paints ("Brush"); right-drag pans; Alt+left orbits from the model. Fill: hover tints the region; click fills it ("Fill"); tool-switch clears the tint.

- [ ] **Step 6: Commit**
```bash
git add js/app.js
git commit -m "feat(fill): hover preview tints the region a click would fill"
```

---

## Self-Review

**Spec coverage:** §1 (buttons, per-press dispatch, painting-only-on-hit, Alt skip) → Task 1. §2 (hover enable/clear, fill tint via the same flood, clear-on-apply) → Task 2. Covered.

**Placeholder scan:** none; full code in every step.

**Type consistency:** `container`/`el`/`pick`/`toolMode`/`altOrbit`/`controls` all exist in `init`'s scope (viewer.js); `clearHoverPreview`/`previewCache`/`claimedByMesh`/`ringNeighborhood`/`ringHalf` exist in app.js (Batch F). The `previewCache` entry for fill reuses the existing `{tool, meshIndex, members, globalSubs, subs}` shape (set by the shared tail of the branch — unchanged).
