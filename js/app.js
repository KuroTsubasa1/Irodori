/* app.js — UI glue: load, preview/apply cleanup, undo/redo history, export. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  Viewer.init($("viewer"));

  let doc = null;
  let fileName = "model.3mf";

  // ---- edit history ----
  let history = []; // [{ state:[{paints,dom}...], label }]
  let histIndex = -1;
  let previewActive = false;
  const HIST_CAP = 60;

  // ---------- snapshot helpers ----------
  function snap() {
    return doc.meshes.map((m) => ({
      paints: m.paints.slice(),
      dom: Int32Array.from(m.dom),
    }));
  }
  function restore(state) {
    doc.meshes.forEach((m, i) => {
      m.paints = state[i].paints.slice();
      m.dom = Int32Array.from(state[i].dom);
    });
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
    const cur = history[histIndex];
    $("histInfo").textContent =
      "Step " + (histIndex + 1) + "/" + history.length + " · " + cur.label;
  }

  // ---------- rendering ----------
  function render(highlightSet) {
    Viewer.build(doc);
    if (highlightSet) Viewer.setHighlight(highlightSet);
  }

  // ---------- helpers ----------
  function stateColor(s) {
    let idx = s === 0 ? doc.defaultExtruder : s;
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
    document
      .querySelectorAll("#filamentList input[data-state]:checked")
      .forEach((cb) => set.add(+cb.dataset.state));
    return set;
  }
  function sliverTargets() {
    const set = new Set();
    document
      .querySelectorAll("#sliverList input[data-state]:checked")
      .forEach((cb) => set.add(+cb.dataset.state));
    return set;
  }

  // ---------- loading ----------
  async function loadFile(file) {
    try {
      toast("Loading " + file.name + " …");
      fileName = file.name;
      doc = await ThreeMF.load(await file.arrayBuffer());
      if (!doc.meshes.length) {
        toast("No mesh found in this .3mf", true);
        return;
      }
      for (const m of doc.meshes) Cleanup.computeDominant(m);
      render(null);
      Viewer.frame();
      history = [{ state: snap(), label: "Loaded" }];
      histIndex = 0;
      previewActive = false;
      buildFilamentUI();
      buildSliverUI();
      updateStats();
      updateHist();
      const nf = doc.meshes.reduce((a, m) => a + m.nf, 0);
      $("fileInfo").innerHTML =
        "<b>" + file.name + "</b><br>" +
        nf.toLocaleString() + " faces · " +
        Viewer.subTriangleCount().toLocaleString() + " painted sub-triangles · " +
        doc.filaments.length + " filaments";
      ["filamentCard", "cleanCard", "sliverCard", "statsCard", "actionCard"].forEach(
        (id) => ($(id).hidden = false)
      );
      $("reframeBtn").hidden = false;
      $("overlay").classList.add("hide");
      toast("Loaded · drag to rotate, scroll to zoom");
    } catch (e) {
      console.error(e);
      toast("Failed to load: " + e.message, true);
    }
  }

  function buildColorList(listId, checkedDefault, onChange) {
    const fc = gatherStates();
    const list = $(listId);
    list.innerHTML = "";
    Object.keys(fc)
      .map(Number)
      .sort((a, b) => a - b)
      .forEach((s) => {
        const li = document.createElement("li");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = checkedDefault;
        cb.dataset.state = s;
        if (onChange) cb.addEventListener("change", onChange);
        const sw = document.createElement("span");
        sw.className = "swatch";
        sw.style.background = stateColor(s);
        const nm = document.createElement("span");
        nm.className = "fname";
        nm.textContent = colorName(s);
        li.append(cb, sw, nm);
        if (listId === "filamentList") {
          const ct = document.createElement("span");
          ct.className = "fcount";
          ct.textContent = fc[s].toLocaleString();
          li.appendChild(ct);
        }
        list.appendChild(li);
      });
  }
  const buildFilamentUI = () => buildColorList("filamentList", true, clearPreview);
  const buildSliverUI = () => buildColorList("sliverList", false, null);

  function updateStats() {
    const thr = +$("sizeRange").value;
    const fcAll = {},
      smallAll = {};
    for (const m of doc.meshes) {
      const s = Cleanup.stats(m, thr);
      for (const k in s.faceCount) fcAll[k] = (fcAll[k] || 0) + s.faceCount[k];
      for (const k in s.small) smallAll[k] = (smallAll[k] || 0) + s.small[k];
    }
    const rows = Object.keys(fcAll)
      .map(Number)
      .sort((a, b) => a - b)
      .map((s) => {
        const small = smallAll[s] || 0;
        return (
          '<div class="row" style="gap:8px;margin:3px 0">' +
          '<span class="swatch" style="flex:0 0 auto;background:' + stateColor(s) + '"></span>' +
          '<span class="fname">' + colorName(s) + "</span>" +
          '<span class="fcount">' + (small ? small + " small" : "clean") + "</span></div>"
        );
      })
      .join("");
    $("statsBody").innerHTML =
      rows + '<p class="hint" style="margin-top:8px">“small” = regions ≤ ' +
      thr + " faces (current threshold).</p>";
  }

  // ---------- cleanup ops ----------
  // Runs island removal in place (mesh must already hold current() state) and
  // returns the changed global-face set by diffing against current().
  function runIslands() {
    const removable = removableSet();
    const maxFaces = +$("sizeRange").value;
    let count = 0;
    for (const m of doc.meshes)
      count += Cleanup.removeIslands(m, { maxFaces, removable, passes: 8 }).count;

    const cur = current();
    const changedGlobal = new Set();
    let off = 0;
    doc.meshes.forEach((m, mi) => {
      const prev = cur[mi].paints;
      for (let i = 0; i < m.nf; i++)
        if (m.paints[i] !== prev[i]) changedGlobal.add(off + i);
      off += m.nf;
    });
    return { count, changedGlobal };
  }

  function clearPreview() {
    if (!doc) return;
    if (previewActive) {
      restore(current());
      previewActive = false;
      render(null);
    }
    $("previewInfo").textContent = "";
    updateStats();
  }

  function doPreview() {
    if (!doc) return;
    restore(current());
    const { count, changedGlobal } = runIslands();
    previewActive = true;
    render(changedGlobal);
    $("previewInfo").innerHTML =
      count === 0
        ? "Nothing to remove at this threshold."
        : "<b>" + count.toLocaleString() +
          "</b> faces will change (shown in <b style='color:#ff00e6'>pink</b>). Click Apply to keep.";
  }

  function doApply() {
    if (!doc) return;
    restore(current());
    const { count } = runIslands();
    previewActive = false;
    pushHistory("Remove islands (≤" + $("sizeRange").value + ")");
    render(null);
    updateStats();
    $("previewInfo").textContent = "";
    toast(count === 0 ? "No islands to remove" : "Removed " + count.toLocaleString() + " island faces");
  }

  function doSlivers() {
    if (!doc) return;
    const targets = sliverTargets();
    if (targets.size === 0) {
      toast("Tick at least one color first", true);
      return;
    }
    restore(current());
    let count = 0;
    for (const m of doc.meshes) count += Cleanup.removeSlivers(m, { targets }).count;
    previewActive = false;
    pushHistory("Clean seams");
    render(null);
    updateStats();
    $("sliverInfo").textContent =
      count === 0 ? "No seams matched." : "Cleaned " + count.toLocaleString() + " boundary faces.";
  }

  function doReset() {
    if (!doc) return;
    restore(history[0].state);
    previewActive = false;
    pushHistory("Reset to original");
    render(null);
    updateStats();
    $("previewInfo").textContent = "";
    $("sliverInfo").textContent = "";
    toast("Reverted to original");
  }

  function jumpTo(idx) {
    if (!doc || idx < 0 || idx >= history.length) return;
    previewActive = false;
    histIndex = idx;
    restore(current());
    render(null);
    updateStats();
    updateHist();
    $("previewInfo").textContent = "";
  }
  const doUndo = () => jumpTo(histIndex - 1);
  const doRedo = () => jumpTo(histIndex + 1);

  async function doExport() {
    if (!doc) return;
    try {
      if (previewActive) {
        restore(current());
        previewActive = false;
        render(null);
      }
      restore(current());
      toast("Packing .3mf …");
      const blob = await ThreeMF.exportZip(doc);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fileName.replace(/\.3mf$/i, "") + "_fixed.3mf";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast("Saved " + a.download);
    } catch (e) {
      console.error(e);
      toast("Export failed: " + e.message, true);
    }
  }

  // ---------- events ----------
  $("fileInput").addEventListener("change", (e) => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
  });
  $("sizeRange").addEventListener("input", () => {
    $("sizeOut").value = $("sizeRange").value;
    clearPreview();
  });
  $("previewBtn").addEventListener("click", doPreview);
  $("applyBtn").addEventListener("click", doApply);
  $("sliverBtn").addEventListener("click", doSlivers);
  $("resetBtn").addEventListener("click", doReset);
  $("undoBtn").addEventListener("click", doUndo);
  $("redoBtn").addEventListener("click", doRedo);
  $("exportBtn").addEventListener("click", doExport);
  $("reframeBtn").addEventListener("click", () => Viewer.frame());

  document.addEventListener("keydown", (e) => {
    if (!doc) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) doRedo();
      else doUndo();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      doRedo();
    }
  });

  // drag & drop
  const stage = $("stage");
  ["dragenter", "dragover"].forEach((ev) =>
    stage.addEventListener(ev, (e) => {
      e.preventDefault();
      stage.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    stage.addEventListener(ev, (e) => {
      e.preventDefault();
      stage.classList.remove("dragover");
    })
  );
  stage.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f && /\.3mf$/i.test(f.name)) loadFile(f);
    else toast("Please drop a .3mf file", true);
  });
})();
