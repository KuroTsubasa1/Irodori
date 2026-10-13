/* app.js — UI glue: edit tools (brush/ring/fill/split/cut), orbit + model-orient,
 * auto-clean, undo/redo history, export. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  Viewer.init($("viewer"));

  let doc = null;
  let fileName = "model.3mf";
  let modelSize = 100;
  let modelBBox = { lo: [0, 0, 0], hi: [100, 100, 100] };

  // history
  let history = [];
  let histIndex = -1;
  let previewActive = false;
  const HIST_CAP = 60;

  // tools
  let activeTool = "orbit";
  let paintState = null; // selected palette color
  let stroke = null; // active brush stroke
  let lastHit = null; // last hovered surface hit (for live cursor)
  let previewCache = null; // { tool, meshIndex, members:Set<localSub>, globalSubs, subs }
  function clearHoverPreview() { if (previewCache) { Viewer.clearPreview(); previewCache = null; } }
  let isolated = null; // { kind:"mesh", index } | null
  function rebuildView(highlightSet) { Viewer.build(doc); if (highlightSet) Viewer.setHighlight(highlightSet); }

  // island-size control (log slider + number)
  const SIZE_MAX = 50000;
  const tickToVal = (t) => Math.min(SIZE_MAX, Math.max(1, Math.round(Math.pow(SIZE_MAX, t / 1000))));
  const valToTick = (v) => Math.round((Math.log(Math.min(SIZE_MAX, Math.max(1, v))) / Math.log(SIZE_MAX)) * 1000);
  const getThreshold = () => Math.min(SIZE_MAX, Math.max(1, +$("sizeNum").value || 1));

  // ---------- snapshots / history ----------
  function snap() {
    return {
      meshes: doc.meshes.map((m) => ({ paints: m.paints.slice(), dom: Int32Array.from(m.dom), part: m.part ? { ...m.part } : null })),
      filaments: doc.filaments.map((f) => ({ index: f.index, hex: f.hex })),
      meshList: doc.meshes.slice(),
      synthetic: !!doc.synthetic,
    };
  }
  function restore(state) {
    if (state.meshList) doc.meshes = state.meshList.slice();
    doc.synthetic = !!state.synthetic;
    doc.meshes.forEach((m, i) => {
      m.paints = state.meshes[i].paints.slice();
      m.dom = Int32Array.from(state.meshes[i].dom);
      if ("part" in state.meshes[i]) m.part = state.meshes[i].part ? { ...state.meshes[i].part } : null;
      Cleanup.invalidateSub(m);
    });
    if (state.filaments) doc.filaments = state.filaments.map((f) => ({ index: f.index, hex: f.hex }));
  }
  const current = () => history[histIndex].state;
  function pushHistory(label, stateClone) {
    history = history.slice(0, histIndex + 1);
    history.push({ state: stateClone || snap(), label });
    if (history.length > HIST_CAP) history.shift();
    histIndex = history.length - 1;
    updateHist();
  }
  function updateHist() {
    $("undoBtn").disabled = histIndex <= 0;
    $("redoBtn").disabled = histIndex >= history.length - 1;
    $("histInfo").textContent = "Step " + (histIndex + 1) + "/" + history.length + " · " + history[histIndex].label;
  }

  function render(highlightSet) {
    rebuildView(highlightSet);
  }

  // ---------- helpers ----------
  function stateColor(s) {
    const idx = s === 0 ? doc.defaultExtruder : s;
    const f = doc.filaments[idx - 1] || doc.filaments[0];
    return f ? f.hex : "#cccccc";
  }
  function colorName(s) {
    const idx = s === 0 ? doc.defaultExtruder : s;
    return doc.filaments[idx - 1] ? "Filament " + idx : "state " + s;
  }
  // Object name: a part's colour suffix is derived from its CURRENT state, so
  // deleting/shifting a colour can never leave a stale label (Objects list + export).
  function partLabel(m, i) {
    return m.part ? "Part " + m.part.seq + " · " + colorName(m.part.state) : "Object " + (i + 1);
  }
  function toast(msg, isErr) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 2600);
  }
  function busy(msg, fn) {
    toast(msg);
    setTimeout(() => {
      try { fn(); } catch (e) { console.error(e); toast("Error: " + e.message, true); }
    }, 30);
  }
  function gatherStates() {
    const fc = {};
    for (const m of doc.meshes) {
      const dom = Cleanup.computeDominant(m);
      for (let i = 0; i < m.nf; i++) fc[dom[i]] = (fc[dom[i]] || 0) + 1;
    }
    return fc;
  }
  function removableSet() {
    const set = new Set();
    document.querySelectorAll("#filamentList input[data-state]:checked").forEach((cb) => set.add(+cb.dataset.state));
    return set;
  }
  function computeModelSize() {
    let a = Infinity, b = Infinity, c = Infinity, d = -Infinity, e = -Infinity, f = -Infinity;
    for (const m of doc.meshes) {
      const P = m.positions;
      for (let i = 0; i < P.length; i += 3) {
        const x = P[i], y = P[i + 1], z = P[i + 2];
        if (x < a) a = x; if (x > d) d = x;
        if (y < b) b = y; if (y > e) e = y;
        if (z < c) c = z; if (z > f) f = z;
      }
    }
    modelSize = Math.hypot(d - a, e - b, f - c) || 100;
    modelBBox = { lo: [a, b, c], hi: [d, e, f] };
    $("splitDepth").max = (modelSize / 2).toFixed(1);
  }
  const brushRadius = () => { const t = (+$("brushSize").value) / 100; return modelSize * (0.0015 + 0.06 * t * t); };
  const ringHalf = () => { const t = (+$("ringThick").value) / 100; return modelSize * (0.001 + 0.04 * t * t); };

  // ---------- loading ----------
  async function loadFile(file) {
    try {
      toast("Loading " + file.name + " …");
      fileName = file.name;
      doc = await ThreeMF.load(await file.arrayBuffer());
      if (!doc.meshes.length) { toast("No mesh found in this .3mf", true); return; }
      isolated = null;
      pendingDecal = null;
      partSeq = 0;
      cancelRing();
      Viewer.setVisibleMeshes(null);
      for (const m of doc.meshes) Cleanup.computeDominant(m);
      computeModelSize();
      render(null);
      Viewer.frame();
      history = [{ state: snap(), label: "Loaded" }];
      histIndex = 0;
      previewActive = false;
      buildPalette();
      buildObjects();
      setTool("orbit");
      updateStats();
      updateHist();
      const nf = doc.meshes.reduce((a, m) => a + m.nf, 0);
      $("fileInfo").innerHTML =
        "<b>" + file.name + "</b><br>" + nf.toLocaleString() + " faces · " +
        Viewer.subTriangleCount().toLocaleString() + " sub-triangles · " + doc.filaments.length + " filaments";
      ["objectsCard", "filamentCard", "cleanCard", "statsCard", "historyCard"].forEach((id) => ($(id).hidden = false));
      $("exportBtn").disabled = false;
      $("reframeBtn").hidden = false;
      $("bgToggle").hidden = false;
      $("orientBtn").hidden = false;
      $("overlay").classList.add("hide");
      toast("Loaded · pick a tool up top to edit");
    } catch (e) {
      console.error(e);
      toast("Failed to load: " + e.message, true);
    }
  }

  // The clean-list shows every paintable colour (union of states present in the
  // meshes and all palette filaments; count 0 when unpainted) and preserves the
  // user's protect-toggles across rebuilds.
  function refreshFilamentUI() {
    const fc = gatherStates();
    const list = $("filamentList");
    const prev = {};
    list.querySelectorAll("input[data-state]").forEach((cb) => (prev[cb.dataset.state] = cb.checked));
    list.innerHTML = "";
    const states = new Set(Object.keys(fc).map(Number));
    for (let i = 1; i <= doc.filaments.length; i++) states.add(i);
    [...states].sort((a, b) => a - b).forEach((s) => {
      const li = document.createElement("li");
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = prev[s] !== undefined ? prev[s] : true; cb.dataset.state = s;
      cb.addEventListener("change", clearPreview);
      const sw = document.createElement("span");
      sw.className = "swatch"; sw.style.background = stateColor(s);
      const nm = document.createElement("span");
      nm.className = "fname"; nm.textContent = colorName(s);
      const ct = document.createElement("span");
      ct.className = "fcount"; ct.textContent = (fc[s] || 0).toLocaleString();
      li.append(cb, sw, nm, ct);
      list.appendChild(li);
    });
  }

  // ---------- palette / tools ----------
  function buildPalette() {
    const pal = $("palette");
    pal.innerHTML = "";
    const orig = doc.origFilamentCount ?? doc.filaments.length;
    doc.filaments.forEach((f, i) => {
      const s = i + 1; // filament index = paint state
      const d = document.createElement("div");
      d.className = "pal"; d.dataset.state = s; d.style.background = f.hex; d.title = "Filament " + s;
      d.addEventListener("click", () => selectPaint(s));
      if (s > orig) {
        const x = document.createElement("span");
        x.className = "del"; x.textContent = "×"; x.title = "Delete this color";
        x.addEventListener("click", (e) => { e.stopPropagation(); deleteColor(s); });
        d.appendChild(x);
      }
      pal.appendChild(d);
    });
    const add = document.createElement("div");
    add.className = "pal add"; add.title = "Add a new color"; add.textContent = "+";
    add.addEventListener("click", () => {
      const inp = $("addColorInput");
      const r = add.getBoundingClientRect();
      inp.style.left = r.left + "px";          // anchor the native picker under the +
      inp.style.top = r.bottom + 4 + "px";
      if (inp.showPicker) inp.showPicker(); else inp.click();
    });
    pal.appendChild(add);
    if (doc.filaments.length) selectPaint(Math.min(paintState || doc.filaments.length, doc.filaments.length));
  }
  // Delete an ADDED filament: areas painted with it return to the model default,
  // higher paint states shift down, and the whole operation is one undo step.
  function deleteColor(k) {
    if (!doc || k <= (doc.origFilamentCount ?? 0)) return;
    if (previewActive) { restore(current()); previewActive = false; }
    clearHoverPreview();
    busy("Removing color…", () => {
      const mapFn = (s) => (s === k ? 0 : s > k ? s - 1 : s);
      for (const m of doc.meshes) {
        Cleanup.remapStates(m, mapFn);
        // a part carries its own state: replace (never mutate — history
        // snapshots share mesh objects) so its swatch and name follow the remap
        if (m.part) m.part = { ...m.part, state: mapFn(m.part.state) };
      }
      doc.filaments.splice(k - 1, 1);
      doc.filaments.forEach((f, i) => (f.index = i + 1));
      pushHistory("Delete color");
      buildPalette(); // re-selects a valid paint colour
      buildObjects(); // part swatches/names follow the remapped states
      render(null);
      updateStats();
      toast("Color removed · repainted to default where used");
      ensureSubGraphs("Preparing tool…");
    });
  }

  function buildObjects() {
    const ul = $("objectsList");
    ul.innerHTML = "";
    doc.meshes.forEach((m, i) => {
      const li = document.createElement("li");
      li.className = "objrow";
      const nm = document.createElement("span"); nm.className = "fname"; nm.textContent = partLabel(m, i);
      const ct = document.createElement("span"); ct.className = "fcount"; ct.textContent = m.nf.toLocaleString();
      nm.addEventListener("click", () => isolate({ kind: "mesh", index: i }));
      ct.addEventListener("click", () => isolate({ kind: "mesh", index: i }));
      if (m.part) { const sw = document.createElement("span"); sw.className = "swatch"; sw.style.background = stateColor(m.part.state); li.append(sw); }
      li.append(nm, ct);
      ul.appendChild(li);
    });
    $("showAllBtn").hidden = !isolated;
  }
  function isolate(target) {
    isolated = target;
    Viewer.setVisibleMeshes(new Set([target.index]));
    render(null);                       // rebuild with only this mesh
    Viewer.frame();                      // recenter on the built geometry
    buildObjects();
  }
  function showAll() {
    isolated = null;
    Viewer.setVisibleMeshes(null);
    render(null);
    Viewer.setMainVisible(true);
    Viewer.frame();
    buildObjects();
  }

  function selectPaint(s) {
    paintState = s;
    document.querySelectorAll(".pal").forEach((p) => p.classList.toggle("sel", +p.dataset.state === s));
  }
  const sizeDotPx = (v) => { const t = v / 100; return Math.round(5 + t * t * 33); };
  function updateSizeDots() {
    const b = sizeDotPx(+$("brushSize").value);
    $("brushPrev").style.width = $("brushPrev").style.height = b + "px";
    const r = sizeDotPx(+$("ringThick").value);
    $("ringPrev").style.width = $("ringPrev").style.height = r + "px";
  }
  // Warm the sub-triangle graph for every mesh that lost it (paint ops that
  // subdivide invalidate it). Runs under a spinner so the rebuild never blocks
  // a mouse event at the start of the next stroke.
  function ensureSubGraphs(msg) {
    if (doc && doc.meshes.some((m) => !m._sub)) {
      busy(msg || "Preparing tool…", () => { for (const m of doc.meshes) Cleanup.buildSubGraph(m); });
    }
  }
  function setTool(name) {
    activeTool = name;
    document.querySelectorAll("#toolbar .tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === name));
    document.querySelectorAll("#optionsbar .opt").forEach((p) => (p.hidden = p.dataset.panel !== name));
    const paintTool = name === "brush" || name === "ring" || name === "fill" || name === "stamp";
    $("palette").classList.toggle("hide", !paintTool);
    Viewer.setTool(name === "brush" ? "paint" : (name === "ring" || name === "fill" || name === "split" || name === "stamp") ? "pick" : "orbit");
    Viewer.enableHover(name === "brush" || name === "ring" || name === "split" || name === "fill" || name === "stamp");
    if (name !== "stamp" && typeof cancelStamp === "function") cancelStamp();
    if (name !== "ring" && typeof cancelRing === "function") cancelRing();
    if (name !== "split" && name !== "ring" && name !== "fill") clearHoverPreview();
    if (Viewer.setLayout(name !== "cut") && doc) render(null);
    if (name === "cut") updateCutPlane(); else Viewer.setCutPlane(null);
    if (doc && (paintTool || name === "split")) ensureSubGraphs("Preparing tool…");
    updateSizeDots();
  }

  // ---------- rotate ----------
  function rotateMesh(m, axis, ang) {
    const P = m.positions, cos = Math.cos(ang), sin = Math.sin(ang);
    let a = Infinity, b = Infinity, c = Infinity, d = -Infinity, e = -Infinity, f = -Infinity;
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      if (x < a) a = x; if (x > d) d = x; if (y < b) b = y; if (y > e) e = y; if (z < c) c = z; if (z > f) f = z;
    }
    const cx = (a + d) / 2, cy = (b + e) / 2, cz = (c + f) / 2;
    for (let i = 0; i < P.length; i += 3) {
      let x = P[i] - cx, y = P[i + 1] - cy, z = P[i + 2] - cz;
      if (axis === 0) { const ny = y * cos - z * sin, nz = y * sin + z * cos; y = ny; z = nz; }
      else if (axis === 1) { const nx = x * cos + z * sin, nz = -x * sin + z * cos; x = nx; z = nz; }
      else { const nx = x * cos - y * sin, ny = x * sin + y * cos; x = nx; y = ny; }
      P[i] = x + cx; P[i + 1] = y + cy; P[i + 2] = z + cz;
    }
  }
  function doRotate(axis, dir) {
    if (!doc) return;
    const ang = (dir * Math.PI) / 2;
    cancelRing(); // placement point and fitted axis are in the old frame
    if (ringFit) { ringFit = null; document.querySelectorAll("#ringAxes button").forEach((x) => x.classList.toggle("on", x.dataset.axis === "2")); }
    for (const m of doc.meshes) { rotateMesh(m, axis, ang); Cleanup.invalidateSub(m); }
    computeModelSize();
    render(null);
    Viewer.frame();
    ensureSubGraphs("Preparing tool…");
  }

  // ---------- brush / ring / fill ----------
  function startStroke(hit) {
    if (paintState == null) return;
    if (previewActive) { restore(current()); previewActive = false; }
    ensureSubGraphs("Preparing tool…");
    stroke = { mi: hit.meshIndex, pend: new Set(), stamps: [] };
    brushAt(hit);
  }
  const enabledAxes = () => [...document.querySelectorAll("#symAxes button.on")].map((b) => +b.dataset.axis);
  const fillSmart = () => document.querySelector("#fillModes button.on").dataset.mode === "smart";
  function updateFillPanel() {
    const smart = fillSmart();
    $("fillAutoWrap").hidden = smart;
    $("fillAngleLabel").hidden = !smart;
    $("fillAngle").hidden = !smart;
  }
  function brushAt(hit) {
    if (!stroke || hit.meshIndex !== stroke.mi) return;
    const m = doc.meshes[hit.meshIndex];
    const r = brushRadius();
    stroke.stamps.push({ x: hit.point.x, y: hit.point.y, z: hit.point.z, r });
    // live preview: whole-leaf tint (the precise stamp refinement runs on release)
    const subs = Cleanup.selectRadius(m, hit.localSub, hit.point.x, hit.point.y, hit.point.z, r);
    let all = subs;
    const axes = enabledAxes();
    if (axes.length) {
      const set = new Set(subs);
      for (const a of axes) {
        const mir = Cleanup.mirrorMap(m, a);
        for (const s of [...set]) { const p = mir[s]; if (p >= 0) set.add(p); }
      }
      all = [...set];
    }
    const g = [];
    for (const s of all) { stroke.pend.add(s); g.push(Viewer.toGlobalSub(hit.meshIndex, s)); }
    Viewer.paintSubs(g, paintState);
  }
  function endStroke() {
    if (!stroke) return;
    const m = doc.meshes[stroke.mi], stamps = stroke.stamps, pend = stroke.pend;
    stroke = null;
    if (!stamps.length) return;
    if (!$("brushRefine").checked) {
      // refine off: commit the whole-leaf live preview (state-only, no subdivision)
      const res = Cleanup.applyStates(m, [...pend], paintState);
      if (!res.changedFaces.size) { render(null); return; } // painted same-over-same
      pushHistory("Brush");
      render(null);
      updateStats();
      return;
    }
    const expanded = Cleanup.mirrorStamps(m, stamps, enabledAxes());
    busy("Refining stroke…", () => {
      const res = Cleanup.paintStamps(m, expanded, paintState, { maxDepth: 4 });
      if (!res.count) { render(null); return; } // painted same-over-same: just restore the live tint
      pushHistory("Brush");
      Cleanup.buildSubGraph(m); // re-warm under this spinner so the next mousedown doesn't stall
      render(null);
      updateStats();
    });
  }
  Viewer.onPaint({
    down: (hit) => { if (activeTool === "brush") startStroke(hit); },
    move: (hit) => { if (activeTool === "brush") brushAt(hit); },
    up: () => endStroke(),
  });

  const ringNeighborhood = () => modelSize * 0.2;
  // ---------- ring tool ----------
  // Placement source: { meshIndex, face, sub, c:[x,y,z], nrm:[x,y,z] }.
  let pendingRing = null; // frozen placement once the user clicks
  let ringFit = null;     // fitted base axis [x,y,z] while "Fit" is the active base
  const ringSrcFromHit = (hit) => ({
    meshIndex: hit.meshIndex,
    face: Cleanup.buildSubGraph(doc.meshes[hit.meshIndex]).subFace[hit.localSub],
    sub: hit.localSub,
    c: [hit.point.x, hit.point.y, hit.point.z],
    nrm: [hit.normal.x, hit.normal.y, hit.normal.z],
  });
  // Current ring axis: X/Y/Z (or the fitted axis) tilted by the two sliders.
  function ringAxis() {
    const on = document.querySelector("#ringAxes button.on");
    const ta = (+$("ringTiltA").value) * Math.PI / 180, tb = (+$("ringTiltB").value) * Math.PI / 180;
    if (on && on.dataset.axis === "fit" && ringFit) {
      const n = ringFit, a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const u = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
      const L = Math.hypot(u[0], u[1], u[2]);
      return Cleanup.tiltAxis(n, [u[0] / L, u[1] / L, u[2] / L], ta, tb);
    }
    const k = on && on.dataset.axis !== "fit" ? +on.dataset.axis : 2;
    const n = [0, 0, 0], u = [0, 0, 0];
    n[k] = 1; u[(k + 1) % 3] = 1;
    return Cleanup.tiltAxis(n, u, ta, tb);
  }
  function hideRing() { clearHoverPreview(); Viewer.setRingPlanes(null); }
  // Tint the ring's in-slab leaves and draw the slab gizmo for `src`.
  function showRing(src) {
    clearHoverPreview();
    const m = doc.meshes[src.meshIndex];
    const g = Cleanup.buildSubGraph(m);
    const n = ringAxis(), h = ringHalf(), c = src.c;
    const subs = Cleanup.ringLeaves(m, Cleanup.ringFaces(m, src.face, c, n, h), c, n, h);
    const gl = [];
    for (const s of subs) { const gi = Viewer.toGlobalSub(src.meshIndex, s); if (gi >= 0) gl.push(gi); }
    Viewer.setPreview(gl);
    previewCache = { tool: "ring", meshIndex: src.meshIndex, members: new Set(subs), globalSubs: gl, subs };
    // gizmo: loop centroid projected onto the mid-plane; radius covers the loop
    let mx = 0, my = 0, mz = 0;
    for (const s of subs) { mx += g.cen[s * 3]; my += g.cen[s * 3 + 1]; mz += g.cen[s * 3 + 2]; }
    let r = modelSize * 0.15;
    if (subs.length) {
      mx /= subs.length; my /= subs.length; mz /= subs.length;
      const dd = (mx - c[0]) * n[0] + (my - c[1]) * n[1] + (mz - c[2]) * n[2];
      mx -= dd * n[0]; my -= dd * n[1]; mz -= dd * n[2];
      let r2 = 0;
      for (const s of subs) {
        const x = g.cen[s * 3] - mx, y = g.cen[s * 3 + 1] - my, z = g.cen[s * 3 + 2] - mz;
        const p = x * n[0] + y * n[1] + z * n[2];
        r2 = Math.max(r2, (x - p * n[0]) ** 2 + (y - p * n[1]) ** 2 + (z - p * n[2]) ** 2);
      }
      r = Math.sqrt(r2) * 1.3 || r;
    } else { mx = c[0]; my = c[1]; mz = c[2]; }
    const o = Viewer.meshOffset(src.meshIndex);
    Viewer.setRingPlanes({ cx: mx + o[0], cy: my + o[1], cz: mz + o[2], nx: n[0], ny: n[1], nz: n[2], h, r });
  }
  // Recompute after an axis/tilt/thickness change.
  function refreshRing() {
    if (!doc || activeTool !== "ring") return;
    if (pendingRing) showRing(pendingRing);
    else { hideRing(); if (lastHit) onHover(lastHit); }
  }
  function placeRing(hit) {
    if (!hit || hit.localSub == null) return;
    // resolve the face on the graph the hit was picked on — face indices
    // survive the restore below, sub indices do not
    const src = ringSrcFromHit(hit);
    if (previewActive) clearPreview();
    pendingRing = src;
    $("ringApply").disabled = false;
    $("ringCancel").disabled = false;
    showRing(pendingRing);
  }
  function cancelRing() {
    pendingRing = null;
    if (doc) hideRing();
    $("ringApply").disabled = true;
    $("ringCancel").disabled = true;
  }
  function applyRing() {
    if (!pendingRing) { toast("Click the model to place the ring first", true); return; }
    if (paintState == null) { toast("Pick a paint color first", true); return; }
    if (previewActive) clearPreview(); // never commit an auto-clean preview under "Ring"
    const src = pendingRing;
    const m = doc.meshes[src.meshIndex];
    const n = ringAxis(), h = ringHalf();
    busy("Painting ring…", () => {
      const faces = Cleanup.ringFaces(m, src.face, src.c, n, h);
      const res = Cleanup.paintRing(m, faces, src.c, n, h, paintState, { refine: $("ringRefine").checked, maxDepth: 4 });
      if (!res.changedFaces.size) { toast("Nothing painted — already that color", true); return; }
      pushHistory("Ring");
      cancelRing();
      render(null);
      ensureSubGraphs("Preparing tool…");
      updateStats();
      toast("Ring · " + faces.length.toLocaleString() + " faces");
    });
  }
  // Fit: one-shot PCA feature axis at the placed (or hovered) point.
  function fitRing() {
    const src = pendingRing || (lastHit && lastHit.localSub != null ? ringSrcFromHit(lastHit) : null);
    if (!src) { toast("Hover or place the ring on the model first", true); return; }
    const fa = Cleanup.featureAxis(doc.meshes[src.meshIndex], src.sub, ringNeighborhood(), src.nrm[0], src.nrm[1], src.nrm[2]);
    ringFit = [fa.ax, fa.ay, fa.az];
    document.querySelectorAll("#ringAxes button").forEach((x) => x.classList.toggle("on", x.dataset.axis === "fit"));
    $("ringTiltA").value = 0; $("ringTiltB").value = 0;
    refreshRing();
  }

  function onHover(hit) {
    lastHit = hit;
    if (activeTool === "stamp") {
      Viewer.hideCursor();
      if (!stampImg) return;
      // while un-placed, follow the hover point; once placed, keep pendingDecal
      const src = pendingDecal || (hit && hit.localSub != null
        ? { meshIndex: hit.meshIndex, frame: Decal.frame(hit.point.x, hit.point.y, hit.point.z,
              hit.normal.x, hit.normal.y, hit.normal.z, 0, 1, 0, (+$("stampRot").value) * Math.PI / 180) }
        : null);
      if (!src) { clearHoverPreview(); return; }
      clearHoverPreview();
      const m = doc.meshes[src.meshIndex];
      const { w, h } = stampWH();
      const subs = decalPreviewSubs(m, src.frame, w, h, stampMaskObj());
      const g = [];
      for (const s of subs) { const gi = Viewer.toGlobalSub(src.meshIndex, s); if (gi >= 0) g.push(gi); }
      Viewer.setPreview(g);
      previewCache = { tool: "stamp", meshIndex: src.meshIndex, members: new Set(subs), globalSubs: g, subs };
      return;
    }
    if (activeTool === "ring") {
      Viewer.hideCursor();
      if (pendingRing) return; // frozen until re-placed, applied or cancelled
      if (!hit || hit.localSub == null) { hideRing(); return; }
      if (previewCache && previewCache.tool === "ring" && previewCache.meshIndex === hit.meshIndex && previewCache.members.has(hit.localSub)) return;
      showRing(ringSrcFromHit(hit));
      return;
    }
    if (activeTool === "split" || activeTool === "fill") {
      Viewer.hideCursor();
      if (!hit || hit.localSub == null) { clearHoverPreview(); return; }
      if (previewCache && previewCache.tool === activeTool && previewCache.meshIndex === hit.meshIndex && previewCache.members.has(hit.localSub)) return;
      clearHoverPreview();
      const m = doc.meshes[hit.meshIndex];
      let subs;
      if (activeTool === "split") {
        subs = Cleanup.selectColorRegion(m, hit.localSub);
      } else {
        if (fillSmart()) {
          const faces = Cleanup.selectSmartFaces(m, Cleanup.buildSubGraph(m).subFace[hit.localSub], +$("fillAngle").value);
          subs = Cleanup.facesToSubs(m, faces);
        } else {
          subs = Cleanup.selectColorRegion(m, hit.localSub); // fillRegion's flood
        }
      }
      if (!subs.length) return;
      const members = new Set(subs);
      const g = [];
      for (const s of subs) { const gi = Viewer.toGlobalSub(hit.meshIndex, s); if (gi >= 0) g.push(gi); }
      Viewer.setPreview(g);
      previewCache = { tool: activeTool, meshIndex: hit.meshIndex, members, globalSubs: g, subs };
      return;
    }
    if (!hit) { Viewer.hideCursor(); return; }
    if (activeTool === "brush") {
      const n = hit.normal;
      Viewer.setCursorTransform(hit.world.x, hit.world.y, hit.world.z, n.x, n.y, n.z, brushRadius());
    }
  }
  Viewer.onHover(onHover);

  // ---------- stamp tool ----------
  let stampImg = null; // { mask:{data,w,h}, aspect }
  $("stampFile").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const MAXD = 512; // cap decode resolution
      let w = img.width, h = img.height;
      const sc = Math.min(1, MAXD / Math.max(w, h));
      w = Math.max(1, Math.round(w * sc)); h = Math.max(1, Math.round(h * sc));
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      const px = ctx.getImageData(0, 0, w, h).data;
      const lum = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const r = px[i * 4], gg = px[i * 4 + 1], b = px[i * 4 + 2];
        lum[i] = (0.299 * r + 0.587 * gg + 0.114 * b) | 0;
      }
      stampImg = { mask: { data: lum, w, h }, aspect: w / h };
      $("stampApply").disabled = false;
      toast("Image loaded — click the model to place");
      if (lastHit) onHover(lastHit);
    };
    img.onerror = () => toast("Could not read that image", true);
    img.src = URL.createObjectURL(file);
  });

  let pendingDecal = null; // { meshIndex, frame } once the user clicks to place
  const stampSizeWorld = () => { const t = (+$("stampSize").value) / 100; return modelSize * (0.02 + 0.5 * t); };
  function stampWH() {
    const s = stampSizeWorld();
    const a = stampImg ? stampImg.aspect : 1;
    return a >= 1 ? { w: s, h: s / a } : { w: s * a, h: s }; // longest edge = s
  }
  function stampMaskObj() {
    return { data: stampImg.mask.data, w: stampImg.mask.w, h: stampImg.mask.h,
             threshold: +$("stampThresh").value, invert: $("stampInvert").checked };
  }
  // Shallow, shared depth band so preview and both commit paths agree (guards thin-wall bleed-through).
  const stampDepthBand = (w, h) => 0.2 * Math.max(w, h);
  // Whole-leaf preview: which local subs sample as "paint" under this frame.
  function decalPreviewSubs(m, frame, w, h, mask) {
    const g = Cleanup.buildSubGraph(m);
    const depthBand = stampDepthBand(w, h);
    const out = [];
    for (let s = 0; s < g.NS; s++) {
      const x = g.cen[s * 3], y = g.cen[s * 3 + 1], z = g.cen[s * 3 + 2];
      const d = (x - frame.ox) * frame.nx + (y - frame.oy) * frame.ny + (z - frame.oz) * frame.nz;
      if (Math.abs(d) > depthBand) continue;
      const a = g.sv[s * 3], b = g.sv[s * 3 + 1], c2 = g.sv[s * 3 + 2];
      const ex1 = g.vx[b] - g.vx[a], ey1 = g.vy[b] - g.vy[a], ez1 = g.vz[b] - g.vz[a];
      const ex2 = g.vx[c2] - g.vx[a], ey2 = g.vy[c2] - g.vy[a], ez2 = g.vz[c2] - g.vz[a];
      const fnx = ey1 * ez2 - ez1 * ey2, fny = ez1 * ex2 - ex1 * ez2, fnz = ex1 * ey2 - ey1 * ex2;
      if (fnx * frame.nx + fny * frame.ny + fnz * frame.nz <= 0) continue; // back-facing
      const c = Decal.uv(frame, x, y, z, w, h);
      if (Decal.sampleMask(mask, c.u, c.v)) out.push(s);
    }
    return out;
  }
  function cancelStamp() {
    pendingDecal = null;
    clearHoverPreview();
    $("stampCancel").disabled = true;
  }
  $("stampCancel").addEventListener("click", cancelStamp);
  $("stampApply").addEventListener("click", () => {
    if (!stampImg) return;
    const src = pendingDecal;
    if (!src) { toast("Click the model to place the stamp first", true); return; }
    const m = doc.meshes[src.meshIndex];
    const { w, h } = stampWH();
    const mask = stampMaskObj();
    busy("Stamping…", () => {
      let res;
      if ($("stampRefine").checked) {
        res = Cleanup.stampMask(m, src.frame, mask, w, h, paintState, { depthBand: stampDepthBand(w, h), maxDepth: 4 });
      } else {
        const subs = decalPreviewSubs(m, src.frame, w, h, mask);
        res = Cleanup.applyStates(m, subs, paintState);
      }
      if (!res.changedFaces.size) { toast("Nothing painted (adjust threshold or size)"); return; }
      pushHistory("Stamp");
      cancelStamp();
      render(null);
      ensureSubGraphs("Preparing tool…");
      updateStats();
    });
  });
  ["stampThresh", "stampInvert", "stampSize", "stampRot"].forEach((id) =>
    $(id).addEventListener("input", () => {
      if (activeTool !== "stamp" || !stampImg) return;
      if (pendingDecal) { // rotation changed: rebuild the frozen frame's rotation
        const f = pendingDecal.frame;
        pendingDecal.frame = Decal.frame(f.ox, f.oy, f.oz, f.nx, f.ny, f.nz, 0, 1, 0, (+$("stampRot").value) * Math.PI / 180);
        onHover(lastHit);
      } else if (lastHit) onHover(lastHit);
    }));

  function doFill(hit) {
    if (previewActive) { restore(current()); previewActive = false; }
    clearHoverPreview();
    const m = doc.meshes[hit.meshIndex];
    const target = $("fillAuto").checked ? null : paintState;
    const res = Cleanup.fillRegion(m, hit.localSub, target);
    if (!res.count) { toast("Nothing to fill there", true); return; }
    pushHistory("Fill");
    render(null);
    updateStats();
    toast("Filled " + res.count.toLocaleString() + " sub-triangles");
  }
  function doSmartFill(hit) {
    if (paintState == null) return;
    if (previewActive) { restore(current()); previewActive = false; }
    clearHoverPreview();
    const m = doc.meshes[hit.meshIndex];
    const faces = Cleanup.selectSmartFaces(m, Cleanup.buildSubGraph(m).subFace[hit.localSub], +$("fillAngle").value);
    // no-op when the whole region already carries the active color solid
    const code = Paint.encode({ leaf: true, state: paintState });
    let same = true;
    for (let i = 0; i < faces.length; i++) if ((m.paints[faces[i]] || "") !== code) { same = false; break; }
    if (same) { toast("Already that color", true); return; }
    Cleanup.paintFacesSolid(m, faces, paintState);
    pushHistory("Smart fill");
    render(null);
    updateStats();
    toast("Filled " + faces.length.toLocaleString() + " faces");
  }
  let partSeq = 0;
  function doSplit(hit) {
    if (previewActive) clearPreview();
    clearHoverPreview();
    if (hit.localSub == null) return;
    const mi = hit.meshIndex, m = doc.meshes[mi];
    const subs = Cleanup.selectColorRegion(m, hit.localSub);
    const depth = Math.max(0, +$("splitDepth").value || 0);
    busy("Splitting…", () => {
      const r = Split.plugSolids(m, subs, { depth });
      if (r.error) { toast(r.error, true); return; }
      partSeq++;
      r.part.part = { seq: partSeq, state: hit.state };
      if (m.part) r.remainder.part = m.part; // splitting a part: what's left is still that part
      doc.meshes.splice(mi, 1, r.remainder, r.part);
      doc.synthetic = true;
      for (const mm of [r.remainder, r.part]) { Cleanup.invalidateSub(mm); mm.dom = null; Cleanup.computeDominant(mm); }
      isolated = null;
      Viewer.setVisibleMeshes(null);
      computeModelSize();
      pushHistory("Split");
      render(null);
      Viewer.frame();
      buildObjects();
      updateStats();
      ensureSubGraphs("Preparing tool…");
      toast("Split out " + partLabel(r.part) + (r.info.wraps ? " — wraps around the model; it can't be slid into place without cutting" : ""));
    });
  }
  Viewer.onPick((hit) => {
    if (activeTool === "ring") placeRing(hit);
    else if (activeTool === "fill") (fillSmart() ? doSmartFill : doFill)(hit);
    else if (activeTool === "split") doSplit(hit);
    else if (activeTool === "stamp") {
      if (!stampImg || !hit || hit.localSub == null) return;
      pendingDecal = { meshIndex: hit.meshIndex,
        frame: Decal.frame(hit.point.x, hit.point.y, hit.point.z, hit.normal.x, hit.normal.y, hit.normal.z,
          0, 1, 0, (+$("stampRot").value) * Math.PI / 180) };
      $("stampCancel").disabled = false;
      onHover(hit); // refresh preview at the frozen frame
    }
  });

  function cutPlane() {
    const axis = +document.querySelector("#cutAxes button.on").dataset.axis;
    const t = (+$("cutPos").value) / 100;
    const ta = (+$("cutTiltA").value) * Math.PI / 180;
    const tb = (+$("cutTiltB").value) * Math.PI / 180;
    const lo = modelBBox.lo, hi = modelBBox.hi;
    const p = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    p[axis] = lo[axis] + t * (hi[axis] - lo[axis]);
    const base = [0, 0, 0], u = [0, 0, 0];
    base[axis] = 1;
    u[(axis + 1) % 3] = 1;
    const n = Cleanup.tiltAxis(base, u, ta, tb);
    return { px: p[0], py: p[1], pz: p[2], nx: n[0], ny: n[1], nz: n[2] };
  }
  function updateCutPlane() { if (!doc || activeTool !== "cut") return; Viewer.setCutPlane(cutPlane()); }
  // Apply the cut: clip targets, replace them with the kept halves, one undo step.
  function doCut(keep) {
    if (!doc) return;
    if (previewActive) { restore(current()); previewActive = false; }
    clearHoverPreview();
    const plane = cutPlane();
    const targets = isolated && isolated.kind === "mesh" ? new Set([isolated.index]) : null;
    busy("Cutting…", () => {
      const out = [];
      let cutAny = false;
      doc.meshes.forEach((m, i) => {
        if (targets && !targets.has(i)) { out.push(m); return; }
        const r = PlaneCut.cutMesh(m, plane);
        if (!r.above || !r.below) { out.push(m); return; } // plane missed this mesh
        cutAny = true;
        if (m.part) { r.above.part = m.part; r.below.part = m.part; }
        if (keep !== "lower") out.push(r.above);
        if (keep !== "upper") out.push(r.below);
      });
      if (!cutAny) { toast("The plane doesn't intersect the model", true); return; }
      doc.meshes = out;
      doc.synthetic = true; // original file XML no longer matches; export via the generated package
      for (const m of doc.meshes) { Cleanup.invalidateSub(m); m.dom = null; Cleanup.computeDominant(m); }
      isolated = null;
      Viewer.setVisibleMeshes(null);
      computeModelSize();
      pushHistory(keep === "both" ? "Plane cut" : "Plane cut (keep " + keep + ")");
      render(null);
      Viewer.frame();
      buildObjects();
      updateStats();
      updateCutPlane();
      ensureSubGraphs("Preparing tool…");
      toast("Cut into " + doc.meshes.length + " object(s)");
    });
  }

  // ---------- auto-clean ----------
  function updateStats() {
    refreshFilamentUI();
    const thr = getThreshold();
    const sizesAll = {};
    for (const m of doc.meshes) {
      const s = Cleanup.subSizes(m);
      for (const k in s) (sizesAll[k] || (sizesAll[k] = [])).push(...s[k]);
    }
    const rows = Object.keys(sizesAll).map(Number).sort((a, b) => a - b).map((s) => {
      const small = sizesAll[s].filter((x) => x <= thr).length;
      return '<div class="row" style="gap:8px;margin:4px 0"><span class="swatch" style="flex:0 0 auto;background:' +
        stateColor(s) + '"></span><span class="fname">' + colorName(s) + '</span><span class="fcount">' +
        (small ? small + " small" : "clean") + "</span></div>";
    }).join("");
    $("statsBody").innerHTML = rows +
      '<p class="hint" style="margin-top:8px">“small” = sub-triangle regions ≤ ' + thr + ".</p>";
  }
  function runIslands() {
    const removable = removableSet(), maxSize = getThreshold();
    let count = 0; const changedGlobal = new Set(); let off = 0;
    for (const m of doc.meshes) {
      const res = Cleanup.removeIslandsSub(m, { maxSize, removable, passes: 3 });
      count += res.count;
      res.changedFaces.forEach((fc) => changedGlobal.add(off + fc));
      off += m.nf;
    }
    return { count, changedGlobal };
  }
  function clearPreview() {
    if (!doc) return;
    if (previewActive) { restore(current()); previewActive = false; render(null); }
    $("previewInfo").textContent = "";
    updateStats();
  }
  let previewResult = null;
  function doPreview() {
    if (!doc) return;
    clearHoverPreview(); // the rebuild invalidates any cached ring/split hover band
    busy("Analyzing…", () => {
      if (previewActive) restore(current());
      const { count, changedGlobal } = runIslands();
      previewActive = true; previewResult = { count };
      render(changedGlobal);
      $("previewInfo").innerHTML = count === 0 ? "Nothing to remove at this size."
        : "<b>" + count.toLocaleString() + "</b> sub-triangles will change (in <b style='color:#1fa8c4'>cyan</b>). Click Clean to keep.";
    });
  }
  function doApply() {
    if (!doc) return;
    clearHoverPreview(); // the rebuild invalidates any cached ring/split hover band
    busy("Cleaning…", () => {
      let count;
      if (previewActive) { count = previewResult ? previewResult.count : 0; }
      else { restore(current()); count = runIslands().count; }
      previewActive = false;
      pushHistory("Auto-clean (≤" + getThreshold() + ")");
      render(null); updateStats();
      $("previewInfo").textContent = "";
      toast(count === 0 ? "Nothing to remove" : "Cleaned " + count.toLocaleString() + " stray sub-triangles");
    });
  }
  function doReset() {
    if (!doc) return;
    if (isolated) { isolated = null; Viewer.setVisibleMeshes(null); }
    clearHoverPreview();
    cancelRing(); // reset can swap the mesh list (plane cuts)
    restore(history[0].state);
    previewActive = false;
    buildPalette();
    pushHistory("Reset to original");
    render(null); updateStats();
    $("previewInfo").textContent = "";
    toast("Reverted to original");
    buildObjects();
  }
  function jumpTo(idx) {
    if (!doc || idx < 0 || idx >= history.length) return;
    if (isolated) { isolated = null; Viewer.setVisibleMeshes(null); }
    clearHoverPreview();
    cancelRing(); // undo/redo can change faces under a placed ring
    previewActive = false; histIndex = idx;
    restore(current()); buildPalette(); render(null); updateStats(); updateHist();
    $("previewInfo").textContent = "";
    buildObjects();
    computeModelSize(); // undo can swap the mesh list (plane cuts)
    updateCutPlane();
  }
  const doUndo = () => jumpTo(histIndex - 1);
  const doRedo = () => jumpTo(histIndex + 1);

  function exportBase() { return fileName.replace(/\.3mf$/i, ""); }
  function exportDefaultName(fmt) {
    const base = exportBase();
    return fmt === "obj" ? base + "_paint.zip" : base + "_fixed.3mf";
  }
  function triggerDownload(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("Saved " + name);
  }

  async function doExportObj(outName, weld) {
    if (!doc) return;
    try {
      toast("Building .obj …");
      const zipBase = outName.replace(/\.[^.]+$/, "");
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
  async function doExport(outName) {
    if (!doc) return;
    try {
      if (previewActive) { restore(current()); previewActive = false; render(null); }
      restore(current());
      toast("Packing .3mf …");
      triggerDownload(await ThreeMF.exportZip(doc, { nameOf: partLabel }), outName);
    } catch (e) { console.error(e); toast("Export failed: " + e.message, true); }
  }

  // ---------- export dialog ----------
  function exportDescribe(fmt) {
    if (fmt === "obj") return "Colored mesh as .obj + .mtl, zipped — for other tools.";
    return doc.meshes.length > 1 ? "Repaired model as " + doc.meshes.length + " objects (parts coincident), ready to re-slice." : "Repaired model, ready to re-slice.";
  }
  function selectExportFmt(fmt) {
    document.querySelectorAll("#exportFmt button").forEach((b) => b.classList.toggle("on", b.dataset.fmt === fmt));
    $("exportDesc").textContent = exportDescribe(fmt);
    $("exportWeldWrap").hidden = fmt !== "obj";
    $("exportName").value = exportDefaultName(fmt);
  }
  function openExportDialog() {
    if (!doc) return;
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
    else doExport(name);
  }

  // ---------- events ----------
  $("fileInput").addEventListener("change", (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); });
  $("addColorInput").addEventListener("change", (e) => {
    if (!doc) return;
    const hex = e.target.value; // "#rrggbb"
    doc.filaments.push({ index: doc.filaments.length + 1, hex });
    pushHistory("Add color");
    paintState = doc.filaments.length;
    buildPalette();
    updateStats();
    toast("Added color " + hex.toUpperCase());
  });
  document.querySelectorAll("#toolbar .tool").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool === activeTool ? "orbit" : b.dataset.tool)));
  document.querySelectorAll("#orientPop [data-rot]").forEach((b) =>
    b.addEventListener("click", () => { const [ax, d] = b.dataset.rot.split(":"); doRotate({ x: 0, y: 1, z: 2 }[ax], +d); })
  );
  $("brushSize").addEventListener("input", () => {
    updateSizeDots();
    if (activeTool === "brush" && lastHit) onHover(lastHit);
  });
  $("ringThick").addEventListener("input", () => { updateSizeDots(); refreshRing(); });
  ["ringTiltA", "ringTiltB"].forEach((id) => $(id).addEventListener("input", refreshRing));
  document.querySelectorAll("#ringAxes button").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.axis === "fit") { fitRing(); return; }
      document.querySelectorAll("#ringAxes button").forEach((x) => x.classList.toggle("on", x === b));
      refreshRing();
    })
  );
  $("ringApply").addEventListener("click", applyRing);
  $("ringCancel").addEventListener("click", cancelRing);
  document.querySelectorAll("#symAxes button").forEach((b) =>
    b.addEventListener("click", () => b.classList.toggle("on"))
  );
  document.querySelectorAll("#fillModes button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#fillModes button").forEach((x) => x.classList.toggle("on", x === b));
      updateFillPanel();
      clearHoverPreview(); // mode changes the region a hover/click means
      if (activeTool === "fill" && lastHit) onHover(lastHit);
    })
  );
  $("fillAngle").addEventListener("input", () => {
    $("fillAngleVal").textContent = $("fillAngle").value;
    if (activeTool === "fill") { clearHoverPreview(); if (lastHit) onHover(lastHit); }
  });
  $("sizeRange").addEventListener("input", () => { $("sizeNum").value = tickToVal(+$("sizeRange").value); clearPreview(); });
  $("sizeNum").addEventListener("input", () => { $("sizeRange").value = valToTick(+$("sizeNum").value || 1); clearPreview(); });
  $("previewBtn").addEventListener("click", doPreview);
  $("applyBtn").addEventListener("click", doApply);
  $("resetBtn").addEventListener("click", doReset);
  $("undoBtn").addEventListener("click", doUndo);
  $("redoBtn").addEventListener("click", doRedo);
  $("exportBtn").addEventListener("click", openExportDialog);
  document.querySelectorAll("#exportFmt button").forEach((b) =>
    b.addEventListener("click", () => { if (!b.disabled) selectExportFmt(b.dataset.fmt); })
  );
  $("exportCancel").addEventListener("click", closeExportDialog);
  $("exportGo").addEventListener("click", runExport);
  $("exportModal").addEventListener("click", (e) => { if (e.target === $("exportModal")) closeExportDialog(); });
  $("reframeBtn").addEventListener("click", () => Viewer.frame());
  $("bgToggle").addEventListener("click", () => $("stage").classList.toggle("dark"));
  $("orientBtn").addEventListener("click", (e) => { e.stopPropagation(); $("orientPop").hidden = !$("orientPop").hidden; });
  document.addEventListener("click", (e) => {
    const pop = $("orientPop");
    if (!pop.hidden && !pop.contains(e.target) && e.target !== $("orientBtn")) pop.hidden = true;
  });
  $("showAllBtn").addEventListener("click", showAll);
  document.querySelectorAll("#cutAxes button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#cutAxes button").forEach((x) => x.classList.toggle("on", x === b));
      updateCutPlane();
    })
  );
  ["cutPos", "cutTiltA", "cutTiltB"].forEach((id) => $(id).addEventListener("input", updateCutPlane));
  $("cutBoth").addEventListener("click", () => doCut("both"));
  $("cutUpper").addEventListener("click", () => doCut("upper"));
  $("cutLower").addEventListener("click", () => doCut("lower"));

  document.addEventListener("keydown", (e) => {
    if (!doc) return;
    if (!$("exportModal").hidden) { if (e.key === "Escape") closeExportDialog(); return; }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); doRedo(); return; }
    // tool shortcuts: modifier-free, ignored while typing in a field
    if (mod || e.altKey) return;
    const tag = (e.target && e.target.tagName) || "";
    // placed ring: Enter applies / Esc cancels, even with a ring slider focused
    if (activeTool === "ring" && pendingRing && (e.key === "Enter" || e.key === "Escape")) {
      const t = e.target && e.target.type;
      if (tag !== "INPUT" || t === "range" || t === "checkbox") {
        e.preventDefault();
        if (e.key === "Enter") applyRing(); else cancelRing();
        return;
      }
    }
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === "Escape") { $("orientPop").hidden = true; setTool("orbit"); return; }
    const k = e.key.toLowerCase();
    if (k === "r") { e.preventDefault(); $("orientPop").hidden = !$("orientPop").hidden; return; }
    const tool = { o: "orbit", b: "brush", n: "ring", f: "fill", s: "split", c: "cut", t: "stamp" }[k];
    if (tool) { e.preventDefault(); setTool(tool); }
  });

  const stage = $("stage");
  ["dragenter", "dragover"].forEach((ev) => stage.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) => stage.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.remove("dragover"); }));
  stage.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f && /\.3mf$/i.test(f.name)) loadFile(f);
    else toast("Please drop a .3mf file", true);
  });
})();
