<div align="center">

<img src="docs/assets/logo.svg" alt="Irodori logo" width="104" height="104" />

# 彩 Irodori

**A browser-only studio for repairing, editing and splitting multi-color paint on `.3mf` models.**

*Irodori (彩) — “the tasteful arrangement of color.”*

<br/>

![No build step](https://img.shields.io/badge/build-none-12b981?style=flat-square)
![Vanilla JS](https://img.shields.io/badge/vanilla-JS-f7df1e?style=flat-square)
![three.js](https://img.shields.io/badge/3D-three.js-000000?style=flat-square)
![Runs in your browser](https://img.shields.io/badge/runs-in_your_browser-ff5d4e?style=flat-square)
![100% local](https://img.shields.io/badge/privacy-nothing_uploaded-12b981?style=flat-square)
![Tests](https://img.shields.io/badge/tests-76_passing-12b981?style=flat-square)

</div>

<div align="center">

![Irodori loaded with a painted model](docs/assets/screenshot-main.png)

</div>

---

## Why Irodori?

AI mesh generators (Meshy, Tripo, …) hand you a beautifully **textured** model.
But an AMS/MMU printer doesn't print textures — it prints with a handful of
filaments. The moment you quantize that texture down to 3–5 colors, the
boundaries fill with **stray-color speckle**: tiny blobs and thin lines of the
wrong filament that no slicer will clean up for you.

**Irodori is the missing step between "AI model" and "good color print."**
Drop in a `.3mf`, see exactly where the noise is, wipe it out in one click, then
hand-paint the details that matter — all in the browser, with **nothing ever
uploaded**.

> Load → clean → touch up → split → export. Five minutes, no install, no account,
> no cloud.

---

## What you can do

### 🧹 Auto-clean stray color

Recolor small wrong-color patches to match their surroundings, with a live
preview and a **patch-size** threshold so you decide what counts as "noise."
Switch any filament off to protect its fine details from the sweep.

### 🖌️ Paint like a slicer — only better

| Tool | What it does |
| --- | --- |
| **Brush** `B` | Paint by dragging; slicer-grade edge refinement runs on release. |
| **Ring** `N` | Wraps a colored band around the local feature; the axis follows the surface normal. |
| **Fill** `F` | Flood a connected same-color region (Color / Smart modes, angle threshold). |

Every tool shows an **on-surface hover preview**, and **X/Y/Z mirror painting**
can be combined so symmetric models stay symmetric.

![Brush tool with the filament palette](docs/assets/screenshot-brush.png)

### 🎨 Real, sliceable colors

Paint with the model's existing filaments or add new ones — added colors export
as **genuine sliceable filaments**, and every add/delete is undoable.

### ✂️ Split painted regions into watertight solids

Lift any connected colored region out as its own **watertight** part. Pick a cap
method (Liepa smooth fill by default), then export every part **plus the
remainder** as separate objects in a single `.3mf` — the cut surfaces stay
perfectly coincident.

![Split tool](docs/assets/screenshot-split.png)

### 🔪 Plane cut

Slice the whole mesh with a geometric plane — exact triangle clipping, welded
section points, flat caps. Great for splitting a model for a smaller print bed.

### 📦 Export anywhere

One-click **`.3mf`** (multi-mesh round-trip, filaments normalized to Generic
PLA) or colored **`.obj`** with a weld toggle for shared vs. split vertices.

---

## How it works

```mermaid
flowchart LR
    A([Drop a .3mf]) --> B[Decode paint_color<br/>per-triangle trees]
    B --> C{{Render in 3D<br/>three.js}}
    C --> D[🧹 Auto-clean]
    C --> E[🖌️ Brush / Ring / Fill]
    C --> F[✂️ Split by color]
    C --> G[🔪 Plane cut]
    D --> H([Export .3mf / .obj])
    E --> H
    F --> H
    G --> H
```

Everything — decode, geometry, repair, re-encode and export — happens on the
main thread in your tab. There is no server.

---

## Quick start

No build step. It's plain files served over HTTP:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

> **Heads up:** after editing anything under `js/`, restart the server on a
> **new port** (or hard-reload). `http.server` + the browser's heuristic
> caching will happily serve stale modules and produce phantom
> "X is not a function" errors.

Run the tests (Node's built-in runner, **76 tests**):

```bash
npm test
```

---

## Architecture

Irodori is **vanilla JS with no framework and no bundler**. Each script is an
IIFE that attaches a global to `window`; the `<script>` order in `index.html`
*is* the dependency graph. Keep it that way.

```mermaid
graph TD
    paint["paint.js<br/><i>paint_color codec · tessellate</i>"]
    objexport["objexport.js<br/><i>colored .obj</i>"]
    threemf["threemf.js<br/><i>.3mf load/export</i>"]
    subgraph_["subgraph.js<br/><i>sub-triangle adjacency</i>"]
    select["select.js<br/><i>selections · symmetry</i>"]
    cleanup["cleanup.js<br/><i>paint mutations</i>"]
    liepa["liepa.js<br/><i>min-weight hole fill</i>"]
    caps["caps.js<br/><i>boundary caps</i>"]
    split["split.js<br/><i>watertight solids</i>"]
    planecut["planecut.js<br/><i>geometric plane cut</i>"]
    viewer["viewer.js<br/><i>three.js scene · picking</i>"]
    app["app.js<br/><i>UI glue · tools · history</i>"]

    paint --> threemf
    paint --> subgraph_
    subgraph_ --> select --> cleanup
    paint --> liepa --> caps --> split
    paint --> planecut
    threemf --> viewer
    cleanup --> app
    split --> app
    planecut --> app
    objexport --> app
    viewer --> app
```

| Module | Responsibility |
| --- | --- |
| `paint.js` | Bambu `paint_color` codec; `Paint.tessellate` is **the** geometry convention every subdivision must match. |
| `threemf.js` | `.3mf` zip load/export, multi-mesh round-trip, filament normalization. |
| `subgraph.js` / `select.js` / `cleanup.js` | The `Cleanup` namespace: cached sub-triangle adjacency, read-only selections + symmetry, and paint-mutating ops. |
| `liepa.js` | Liepa hole filling (rim decimation → 3-D min-weight DP → fan strips → refinement → fairing). |
| `caps.js` | Boundary-loop extraction and cap triangulation. |
| `split.js` | Watertight solids from sub-triangle sets; parts and remainder share one cut cap. |
| `planecut.js` | Exact triangle clipping with welded section points and flat earcut caps. |
| `viewer.js` | three.js scene, picking, explode animation, preview tints. |
| `app.js` | UI glue: tools, palette, history (snapshot/undo), panels. |

A test harness (`tests/harness.js`) loads these browser IIFEs into a Node `vm`
sandbox with vendored three.js + poly2tri, so the pure geometry is testable
headlessly. Watertightness is asserted as *every undirected edge used exactly
twice*; winding is covered by an area-weighted Liepa regression.

---

## The `paint_color` format (reverse-engineered)

Bambu/Prusa store per-triangle paint as a hex string whose **nibbles are read
right-to-left**. Each node is one nibble: the low 2 bits are `split_sides`
(`0` = leaf), the high 2 bits are the payload.

```text
node:
  split = nibble & 0b11
  field = nibble >> 2
  if split == 0:                         # leaf
      if field != 0b11: state = field                 # states 0..2
      else:                                            # escape
          s2 = nextNibble
          if s2 != 0b1110: state = s2 + 3             # states 3..16
          else: state = (lo | hi<<4) + 17             # states 17..255
  else:                                  # split into (split+1) children
      special_side = field
      children = (split + 1) nodes, read recursively
```

`state` is the 1-based filament index (state 0 = the object's default
extruder); colors come from `filament_colour` in
`Metadata/project_settings.config`. The codec in `js/paint.js` decodes and
re-encodes all **199,672 triangles** of the reference model with zero loss.

---

## Project layout

```
index.html        # script order = the dependency graph
css/style.css
js/               # the 12 modules above (load order matters)
tests/            # node --test; harness.js sandboxes the browser IIFEs
samples/          # the tracked reference model
vendor/           # three.js + poly2tri (vendored)
docs/             # specs, plans, and these assets
```

The reference model lives in `samples/`. See **`CLAUDE.md`** for the full module
map and contributor conventions. Specs live in `docs/superpowers/specs/`, plans
in `docs/superpowers/plans/` — read the relevant one before extending a feature.

---

<div align="center">

**Runs entirely in your browser — nothing is uploaded.**

</div>
