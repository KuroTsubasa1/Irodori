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
  let splitParts = []; // [{ meshIndex, subs:Int32Array, state, method }]
  let splitSeq = 0; // stable id per split part (for animation carry-over)
  let isolated = null; // { kind:"mesh", index } | { kind:"part", id } | null
  const claimedByMesh = () => {
    const sets = doc.meshes.map(() => new Set());
    for (const p of splitParts) for (const s of p.subs) sets[p.meshIndex].add(s);
    return sets;
  };
  function rebuildView(highlightSet) {
    Viewer.build(doc, claimedByMesh());
    Viewer.setSplitParts(splitParts);
    if (highlightSet) Viewer.setHighlight(highlightSet);
  }

  // island-size control (log slider + number)
  const SIZE_MAX = 50000;
  const tickToVal = (t) => Math.min(SIZE_MAX, Math.max(1, Math.round(Math.pow(SIZE_MAX, t / 1000))));
  const valToTick = (v) => Math.round((Math.log(Math.min(SIZE_MAX, Math.max(1, v))) / Math.log(SIZE_MAX)) * 1000);
  const getThreshold = () => Math.min(SIZE_MAX, Math.max(1, +$("sizeNum").value || 1));

  // ---------- snapshots / history ----------
  function snap() {
    return {
      meshes: doc.meshes.map((m) => ({ paints: m.paints.slice(), dom: Int32Array.from(m.dom) })),
      splits: splitParts.map((p) => ({ id: p.id, meshIndex: p.meshIndex, subs: Int32Array.from(p.subs), state: p.state, method: p.method })),
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
      Cleanup.invalidateSub(m);
    });
    if (state.filaments) doc.filaments = state.filaments.map((f) => ({ index: f.index, hex: f.hex }));
    splitParts = state.splits.map((p) => ({ id: p.id, meshIndex: p.meshIndex, subs: Int32Array.from(p.subs), state: p.state, method: p.method }));
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
      splitParts = [];
      isolated = null;
      Viewer.setVisibleMeshes(null);
      Viewer.setPartVisibility(null);
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
      $("exportObjBtn").disabled = false;
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
      for (const m of doc.meshes) Cleanup.remapStates(m, mapFn);
      // split parts carry their own state — remap those too, or a part painted
      // with the deleted/shifted colour keeps a stale extruder index
      splitParts = splitParts.map((p) => ({ ...p, state: mapFn(p.state) }));
      doc.filaments.splice(k - 1, 1);
      doc.filaments.forEach((f, i) => (f.index = i + 1));
      pushHistory("Delete color");
      buildPalette(); // re-selects a valid paint colour
      render(null);
      updateStats();
      toast("Color removed · repainted to default where used");
    });
  }

  function buildObjects() {
    const ul = $("objectsList");
    ul.innerHTML = "";
    doc.meshes.forEach((m, i) => {
      const li = document.createElement("li");
      li.className = "objrow";
      const nm = document.createElement("span"); nm.className = "fname"; nm.textContent = "Object " + (i + 1);
      const ct = document.createElement("span"); ct.className = "fcount"; ct.textContent = m.nf.toLocaleString();
      nm.addEventListener("click", () => isolate({ kind: "mesh", index: i }));
      ct.addEventListener("click", () => isolate({ kind: "mesh", index: i }));
      li.append(nm, ct);
      ul.appendChild(li);
    });
    splitParts.forEach((p) => {
      const li = document.createElement("li");
      li.className = "objrow";
      const sw = document.createElement("span"); sw.className = "swatch"; sw.style.background = stateColor(p.state);
      const nm = document.createElement("span"); nm.className = "fname"; nm.textContent = colorName(p.state) + " part";
      nm.addEventListener("click", () => isolate({ kind: "part", id: p.id }));
      li.append(sw, nm);
      ul.appendChild(li);
    });
    $("showAllBtn").hidden = !isolated;
  }
  function isolate(target) {
    isolated = target;
    if (target.kind === "mesh") {
      Viewer.setVisibleMeshes(new Set([target.index]));
      render(null);                       // rebuild with only this mesh
      Viewer.setMainVisible(true);
      Viewer.setPartVisibility(new Set()); // hide all split parts
      Viewer.frame();                      // recenter on the built geometry
    } else { // kind === "part" — view-only: hide the main mesh, show+pin the part
      Viewer.setMainVisible(false);
      Viewer.setPartVisibility(new Set([target.id]));
      Viewer.pinPart(target.id);           // park it at origin (no explode)
      Viewer.frame(Viewer.partObject(target.id));
    }
    buildObjects();
  }
  function showAll() {
    isolated = null;
    Viewer.setVisibleMeshes(null);
    render(null);
    Viewer.setMainVisible(true);
    Viewer.setPartVisibility(null);
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
  function setTool(name) {
    activeTool = name;
    document.querySelectorAll("#toolbar .tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === name));
    document.querySelectorAll("#optionsbar .opt").forEach((p) => (p.hidden = p.dataset.panel !== name));
    const paintTool = name === "brush" || name === "ring" || name === "fill";
    $("palette").classList.toggle("hide", !paintTool);
    Viewer.setTool(name === "brush" ? "paint" : (name === "ring" || name === "fill" || name === "split") ? "pick" : "orbit");
    Viewer.enableHover(name === "brush" || name === "ring" || name === "split" || name === "fill");
    if (name !== "split" && name !== "ring" && name !== "fill") clearHoverPreview();
    if (name === "cut") updateCutPlane(); else Viewer.setCutPlane(null);
    if (doc && (paintTool || name === "split") && doc.meshes.some((m) => !m._sub)) {
      busy("Preparing tool…", () => { for (const m of doc.meshes) Cleanup.buildSubGraph(m); });
    }
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
    for (const m of doc.meshes) { rotateMesh(m, axis, ang); Cleanup.invalidateSub(m); }
    computeModelSize();
    render(null);
    Viewer.frame();
  }

  // ---------- brush / ring / fill ----------
  function startStroke(hit) {
    if (paintState == null) return;
    if (previewActive) { restore(current()); previewActive = false; }
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
    const m = doc.meshes[stroke.mi], stamps = stroke.stamps;
    stroke = null;
    if (!stamps.length) return;
    const expanded = Cleanup.mirrorStamps(m, stamps, enabledAxes());
    busy("Refining stroke…", () => {
      const res = Cleanup.paintStamps(m, expanded, paintState, { maxDepth: 4 });
      if (!res.count) { render(null); return; } // painted same-over-same: just restore the live tint
      pushHistory("Brush");
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
  function doRing(hit) {
    if (paintState == null) return;
    if (previewActive) { restore(current()); previewActive = false; }
    const m = doc.meshes[hit.meshIndex];
    let subs;
    if (previewCache && previewCache.tool === "ring" && previewCache.meshIndex === hit.meshIndex && previewCache.members.has(hit.localSub)) {
      subs = previewCache.subs;
    } else {
      const fa = Cleanup.featureAxis(m, hit.localSub, ringNeighborhood(), hit.normal.x, hit.normal.y, hit.normal.z);
      subs = Cleanup.selectBandAxis(m, hit.localSub, ringHalf(), fa.ax, fa.ay, fa.az);
    }
    if (!subs.length) return;
    clearHoverPreview();
    Cleanup.applyStates(m, subs, paintState);
    pushHistory("Ring");
    render(null);
    updateStats();
    toast("Ring · " + subs.length.toLocaleString() + " sub-triangles");
  }

  function onHover(hit) {
    lastHit = hit;
    if (activeTool === "split" || activeTool === "ring" || activeTool === "fill") {
      Viewer.hideCursor();
      if (!hit || hit.localSub == null) { clearHoverPreview(); return; }
      if (previewCache && previewCache.tool === activeTool && previewCache.meshIndex === hit.meshIndex && previewCache.members.has(hit.localSub)) return;
      clearHoverPreview();
      const m = doc.meshes[hit.meshIndex];
      let subs;
      if (activeTool === "split") {
        subs = Cleanup.selectColorRegion(m, hit.localSub, claimedByMesh()[hit.meshIndex]);
      } else if (activeTool === "fill") {
        if (fillSmart()) {
          const faces = Cleanup.selectSmartFaces(m, Cleanup.buildSubGraph(m).subFace[hit.localSub], +$("fillAngle").value);
          subs = Cleanup.facesToSubs(m, faces);
        } else {
          subs = Cleanup.selectColorRegion(m, hit.localSub); // fillRegion's flood (no claimed-exclusion)
        }
      } else {
        const fa = Cleanup.featureAxis(m, hit.localSub, ringNeighborhood(), hit.normal.x, hit.normal.y, hit.normal.z);
        subs = Cleanup.selectBandAxis(m, hit.localSub, ringHalf(), fa.ax, fa.ay, fa.az);
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
      Viewer.setCursorTransform(hit.point.x, hit.point.y, hit.point.z, n.x, n.y, n.z, brushRadius());
    }
  }
  Viewer.onHover(onHover);
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
  function doSplit(hit) {
    if (previewActive) { restore(current()); previewActive = false; }
    clearHoverPreview();
    const m = doc.meshes[hit.meshIndex];
    if (hit.localSub == null) return;
    const subs = Cleanup.selectColorRegion(m, hit.localSub, claimedByMesh()[hit.meshIndex]);
    if (!subs.length) { toast("Nothing to split there", true); return; }
    splitParts.push({ id: splitSeq++, meshIndex: hit.meshIndex, subs, state: hit.state, method: $("capMethod").value });
    pushHistory("Split");
    render(null);
    buildObjects();
    toast("Split " + subs.length.toLocaleString() + " sub-triangles into a new solid");
  }
  Viewer.onPick((hit) => {
    if (activeTool === "ring") doRing(hit);
    else if (activeTool === "fill") (fillSmart() ? doSmartFill : doFill)(hit);
    else if (activeTool === "split") doSplit(hit);
  });

  function cutPlane() {
    const axis = +document.querySelector("#cutAxes button.on").dataset.axis;
    const t = (+$("cutPos").value) / 100;
    const ta = (+$("cutTiltA").value) * Math.PI / 180;
    const tb = (+$("cutTiltB").value) * Math.PI / 180;
    const lo = modelBBox.lo, hi = modelBBox.hi;
    const p = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    p[axis] = lo[axis] + t * (hi[axis] - lo[axis]);
    const n = [0, 0, 0];
    n[axis] = 1;
    const rot = (v, ax2, ang) => { const i = (ax2 + 1) % 3, j = (ax2 + 2) % 3; const vi = v[i], vj = v[j]; v[i] = vi * Math.cos(ang) - vj * Math.sin(ang); v[j] = vi * Math.sin(ang) + vj * Math.cos(ang); };
    rot(n, (axis + 1) % 3, ta);
    rot(n, (axis + 2) % 3, tb);
    return { px: p[0], py: p[1], pz: p[2], nx: n[0], ny: n[1], nz: n[2] };
  }
  function updateCutPlane() { if (!doc || activeTool !== "cut") return; Viewer.setCutPlane(cutPlane()); }
  // Apply the cut: clip targets, replace them with the kept halves, one undo step.
  function doCut(keep) {
    if (!doc) return;
    if (splitParts.length) { toast("Export or undo your split parts before cutting", true); return; }
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
      Viewer.setPartVisibility(null);
      Viewer.frame();
      buildObjects();
      updateStats();
      updateCutPlane();
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
    previewActive = false; histIndex = idx;
    restore(current()); buildPalette(); render(null); updateStats(); updateHist();
    $("previewInfo").textContent = "";
    buildObjects();
    computeModelSize(); // undo can swap the mesh list (plane cuts)
    updateCutPlane();
  }
  const doUndo = () => jumpTo(histIndex - 1);
  const doRedo = () => jumpTo(histIndex + 1);

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
  $("ringThick").addEventListener("input", () => {
    updateSizeDots();
    if (activeTool === "ring") { clearHoverPreview(); if (lastHit) onHover(lastHit); }
  });
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
  $("exportBtn").addEventListener("click", doExport);
  $("exportObjBtn").addEventListener("click", doExportObj);
  $("exportSplitBtn").addEventListener("click", doExportSplit);
  $("capMethod").addEventListener("change", () => {
    if (!doc || !splitParts.length) return;
    const method = $("capMethod").value;
    for (const p of splitParts) p.method = method;
    pushHistory("Cap method: " + method);
    render(null);
    toast("Re-capped " + splitParts.length + " part(s) with " + method);
  });
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
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); doRedo(); return; }
    if (e.key === "Escape") { $("orientPop").hidden = true; setTool("orbit"); return; }
    // tool shortcuts: modifier-free, ignored while typing in a field
    if (mod || e.altKey) return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    const k = e.key.toLowerCase();
    if (k === "r") { e.preventDefault(); $("orientPop").hidden = !$("orientPop").hidden; return; }
    const tool = { o: "orbit", b: "brush", n: "ring", f: "fill", s: "split", c: "cut" }[k];
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
