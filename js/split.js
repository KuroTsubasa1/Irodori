/* split.js — build watertight solids from sets of leaf sub-triangles, and
 * assemble a multi-object .3mf. Depends on Paint + Cleanup (on window). */
(function (global) {
  "use strict";

  // Build a capped watertight solid from leaf sub-triangle indices (indices into
  // the mesh's buildSubGraph enumeration).
  // Returns { positions:Float32Array, indices:Uint32Array, triState:Int32Array, state }.
  function solidFromSubs(mesh, subs, method) {
    method = method || "centroid";
    const g = Cleanup.buildSubGraph(mesh);
    const { sv, vx, vy, vz, subLeaf, midOf } = g;

    // local vertex remap: global welded id -> local id
    const remap = new Map();
    const px = [], py = [], pz = [];
    const lid = (gid) => {
      let id = remap.get(gid);
      if (id === undefined) {
        id = px.length; remap.set(gid, id);
        px.push(vx[gid]); py.push(vy[gid]); pz.push(vz[gid]);
      }
      return id;
    };

    function decompose(u, v) {
      const m = midOf ? midOf(u, v) : -1;
      if (m >= 0 && m !== u && m !== v) {
        return decompose(u, m).concat(decompose(m, v).slice(1));
      }
      return [u, v];
    }

    const F = [], triSt = [];          // local surface triangles + per-tri state
    const bEdge = new Map();           // global-edge key -> { u, v, count }
    const ekeyG = (a, b) => (a < b ? a + "_" + b : b + "_" + a);
    const addPerim = (u, v) => {
      const k = ekeyG(u, v);
      const e = bEdge.get(k);
      if (e) e.count++;
      else bEdge.set(k, { u, v, count: 1 }); // direction from first (owning) tri
    };

    for (let k = 0; k < subs.length; k++) {
      const s = subs[k];
      const a = sv[s * 3], b = sv[s * 3 + 1], c = sv[s * 3 + 2];
      const st = subLeaf[s].state;
      const eab = decompose(a, b), ebc = decompose(b, c), eca = decompose(c, a);
      const poly = eab.concat(ebc.slice(1), eca.slice(1, -1)); // conformed, CCW
      // perimeter edges (global) for boundary detection
      for (let i = 0; i < poly.length; i++) addPerim(poly[i], poly[(i + 1) % poly.length]);
      if (poly.length === 3) {
        F.push(lid(poly[0]), lid(poly[1]), lid(poly[2]));
        triSt.push(st);
      } else {
        // fan from the polygon centroid (interior point; never collinear)
        let gx = 0, gy = 0, gz = 0;
        for (const gid of poly) { gx += vx[gid]; gy += vy[gid]; gz += vz[gid]; }
        const nP = poly.length, gLocal = px.length;
        px.push(gx / nP); py.push(gy / nP); pz.push(gz / nP);
        for (let i = 0; i < nP; i++) {
          F.push(gLocal, lid(poly[i]), lid(poly[(i + 1) % nP]));
          triSt.push(st);
        }
      }
    }

    const out = F.slice(), outSt = triSt.slice();

    // boundary edges (used once); rebuild directed adjacency by walking the cycle
    // so that edges chain head-to-tail for extractLoops (bEdge stores first-seen
    // direction which can be inconsistent across polygons).
    const bndAdj = new Map();  // vertex -> [neighbor, ...]  (undirected)
    for (const e of bEdge.values()) {
      if (e.count !== 1) continue;
      if (!bndAdj.has(e.u)) bndAdj.set(e.u, []);
      if (!bndAdj.has(e.v)) bndAdj.set(e.v, []);
      bndAdj.get(e.u).push(e.v);
      bndAdj.get(e.v).push(e.u);
    }
    const boundary = [];
    const bndVisited = new Set();
    let bndEdgeCount = 0;
    for (const e of bEdge.values()) { if (e.count === 1) bndEdgeCount++; }
    let consumedEdgeCount = 0;
    let boundaryFullyClosed = true;
    for (const start of bndAdj.keys()) {
      if (bndVisited.has(start)) continue;
      const loop = [start]; bndVisited.add(start);
      let cur = start;
      while (true) {
        const next = (bndAdj.get(cur) || []).find(n => !bndVisited.has(n));
        if (next === undefined) break;
        bndVisited.add(next); loop.push(next); cur = next;
      }
      // check that the chain closed back to its start (last vertex rejoins start)
      const closes = (bndAdj.get(cur) || []).includes(start);
      if (!closes) boundaryFullyClosed = false;
      if (loop.length >= 3) {
        consumedEdgeCount += loop.length;
        for (let i = 0; i < loop.length; i++) boundary.push([loop[i], loop[(i + 1) % loop.length]]);
      }
    }
    if (!boundaryFullyClosed || consumedEdgeCount !== bndEdgeCount) {
      console.warn("solidFromSubs: boundary not fully closed (pinch topology); cap may be incomplete");
    }

    let cap = { verts: [], extraPts: [], tris: [], method };
    if (boundary.length) {
      // the walk above already ordered the boundary into consistent directed cycles; extractLoops groups them into per-loop vertex arrays
      const loops = Caps.extractLoops(boundary);
      const getPt = (gid) => [vx[gid], vy[gid], vz[gid]];
      cap = Caps.triangulateLoops(loops, getPt, method);
      cap.method = method;
      // orient each cap COMPONENT exactly against the surface's boundary
      // winding (replaces the global best-fit-plane heuristic, which inverted
      // caps on multi-loop parts whose rims face opposite directions)
      const surfDir = new Map();
      for (const e of bEdge.values()) if (e.count === 1) surfDir.set(ekeyG(e.u, e.v), e.u + ">" + e.v);
      orientCapComponents(cap, surfDir);
      // emit the cap into the part: loop verts weld via lid(); extras append locally
      const capLocal = cap.verts.map((gid) => lid(gid));
      const extraBase = px.length;
      for (const ep of cap.extraPts) { px.push(ep[0]); py.push(ep[1]); pz.push(ep[2]); }
      const refLocal = (i) => (i < cap.verts.length ? capLocal[i] : extraBase + (i - cap.verts.length));
      const capState = subs.length ? subLeaf[subs[0]].state : 0;
      for (const [a, b, c] of cap.tris) { out.push(refLocal(a), refLocal(b), refLocal(c)); outSt.push(capState); }
    }

    const positions = new Float32Array(px.length * 3);
    for (let i = 0; i < px.length; i++) { positions[i * 3] = px[i]; positions[i * 3 + 1] = py[i]; positions[i * 3 + 2] = pz[i]; }
    return {
      positions,
      indices: Uint32Array.from(out),
      triState: Int32Array.from(outSt),
      state: subs.length ? subLeaf[subs[0]].state : 0,
      cap, // { verts:globalVids, extraPts, tris (part-outward), method }
    };
  }

  // Exact cap orientation: an orientable closed solid traverses every rim edge
  // once in each direction, and the SURFACE's direction is known (bEdge
  // first-seen = surface winding). Majority-vote each connected cap component's
  // rim-edge directions against surfDir and flip components that agree instead
  // of oppose. cap.tris reference cap.verts (global vids) for i < verts.length.
  function orientCapComponents(cap, surfDir) {
    const nT = cap.tris.length;
    if (!nT) return;
    // union-find over triangles sharing any ref
    const parent = new Int32Array(nT);
    for (let i = 0; i < nT; i++) parent[i] = i;
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const refOwner = new Map();
    cap.tris.forEach((t, ti) => {
      for (const r of t) {
        const o = refOwner.get(r);
        if (o === undefined) refOwner.set(r, ti);
        else { const a = find(o), b = find(ti); if (a !== b) parent[a] = b; }
      }
    });
    const ek = (a, b) => (a < b ? a + "_" + b : b + "_" + a);
    const agree = new Map(), oppose = new Map();
    cap.tris.forEach((t, ti) => {
      const root = find(ti);
      for (let i = 0; i < 3; i++) {
        const x = t[i], y = t[(i + 1) % 3];
        if (x >= cap.verts.length || y >= cap.verts.length) continue; // extras: never rim
        const u = cap.verts[x], v = cap.verts[y];
        const sd = surfDir.get(ek(u, v));
        if (!sd) continue; // not a boundary edge (e.g. a cap diagonal between rim vids)
        if (sd === u + ">" + v) agree.set(root, (agree.get(root) || 0) + 1);
        else oppose.set(root, (oppose.get(root) || 0) + 1);
      }
    });
    const flip = new Set();
    for (const root of new Set([...agree.keys(), ...oppose.keys()])) {
      const a = agree.get(root) || 0, o = oppose.get(root) || 0;
      if (a > o) flip.add(root);
      else if (a === o && a > 0) console.warn("solidFromSubs: ambiguous cap orientation; leaving component as-is");
    }
    if (flip.size) cap.tris.forEach((t, ti) => { if (flip.has(find(ti))) { const tmp = t[1]; t[1] = t[2]; t[2] = tmp; } });
  }

  // Build the remaining mesh (sub-triangles NOT in any part) as a watertight
  // solid: its conformed surface + every part's cap, reversed, each coloured the
  // loop's majority bordering color. parts: [{ subs, cap, state }]; claimed: Set.
  function remainderSolid(mesh, parts, claimed) {
    const g = Cleanup.buildSubGraph(mesh);
    const rem = [];
    for (let s = 0; s < g.NS; s++) if (!claimed.has(s)) rem.push(s);
    // open (uncapped) conformed surface of the remainder; we add the parts' caps
    const surf = openSurface(mesh, rem, g);
    const px = surf.px, py = surf.py, pz = surf.pz;
    const out = surf.F, outSt = surf.triSt;
    const lidG = surf.lid; // global vid -> local (creates from welded coords)

    for (const part of parts) {
      const cap = part.cap;
      // cap.verts are global welded ids on the part boundary, which is also the
      // remainder boundary, so lidG welds them onto existing remainder vertices
      // (a coincident duplicate is only created for degenerate non-manifold input).
      const capLocal = cap.verts.map((gid) => lidG(gid));
      const extraBase = px.length;
      for (const ep of cap.extraPts) { px.push(ep[0]); py.push(ep[1]); pz.push(ep[2]); }
      const refLocal = (i) => (i < cap.verts.length ? capLocal[i] : extraBase + (i - cap.verts.length));
      const col = majorityBorderColor(mesh, g, part);
      for (const [a, b, c] of cap.tris) {
        out.push(refLocal(a), refLocal(c), refLocal(b)); // reversed winding
        outSt.push(col);
      }
    }
    const positions = new Float32Array(px.length * 3);
    for (let i = 0; i < px.length; i++) { positions[i * 3] = px[i]; positions[i * 3 + 1] = py[i]; positions[i * 3 + 2] = pz[i]; }
    return { positions, indices: Uint32Array.from(out), triState: Int32Array.from(outSt) };
  }

  // Conformed open surface (no cap) for a set of subs. Returns growable local
  // coord arrays, the surface triangles F (flat), per-tri state, and a global->
  // local vertex mapper `lid` shared for appending caps.
  function openSurface(mesh, subs, g) {
    g = g || Cleanup.buildSubGraph(mesh);
    const { sv, vx, vy, vz, subLeaf, midOf } = g;
    const remap = new Map(), px = [], py = [], pz = [];
    const lid = (gid) => {
      let id = remap.get(gid);
      if (id === undefined) { id = px.length; remap.set(gid, id); px.push(vx[gid]); py.push(vy[gid]); pz.push(vz[gid]); }
      return id;
    };
    const decompose = (u, v) => {
      const m = midOf ? midOf(u, v) : -1;
      return (m >= 0 && m !== u && m !== v) ? decompose(u, m).concat(decompose(m, v).slice(1)) : [u, v];
    };
    const F = [], triSt = [];
    for (const s of subs) {
      const a = sv[s * 3], b = sv[s * 3 + 1], c = sv[s * 3 + 2], st = subLeaf[s].state;
      const poly = decompose(a, b).concat(decompose(b, c).slice(1), decompose(c, a).slice(1, -1));
      if (poly.length === 3) { F.push(lid(poly[0]), lid(poly[1]), lid(poly[2])); triSt.push(st); }
      else {
        let gx = 0, gy = 0, gz = 0; for (const gid of poly) { gx += vx[gid]; gy += vy[gid]; gz += vz[gid]; }
        const nP = poly.length, gL = px.length; px.push(gx / nP); py.push(gy / nP); pz.push(gz / nP);
        for (let i = 0; i < nP; i++) { F.push(gL, lid(poly[i]), lid(poly[(i + 1) % nP])); triSt.push(st); }
      }
    }
    return { px, py, pz, F, triSt, lid };
  }

  // Most common remainder state adjacent to the part's boundary (the part's subs'
  // neighbouring sub-triangles that are NOT in the part). Falls back to the part's
  // own state.
  function majorityBorderColor(mesh, g, part) {
    const inPart = new Set(part.subs);
    const votes = new Map();
    const { start, list, subLeaf } = g;
    for (const s of part.subs) {
      for (let e = start[s]; e < start[s + 1]; e++) {
        const v = list[e];
        if (!inPart.has(v)) votes.set(subLeaf[v].state, (votes.get(subLeaf[v].state) || 0) + 1);
      }
    }
    let best = -1, col = part.state;
    votes.forEach((n, st) => { if (n > best) { best = n; col = st; } });
    return col;
  }

  function uuid() {
    const h = "0123456789abcdef";
    let s = "";
    for (let i = 0; i < 32; i++) {
      if (i === 8 || i === 12 || i === 16 || i === 20) s += "-";
      s += h[(Math.random() * 16) | 0];
    }
    return s;
  }

  const fnum = (v) =>
    Number.isInteger(v) ? String(v) : parseFloat(v.toFixed(5)).toString();

  // objects: [{ name, extruder, positions, indices, triState|null }]
  // opts: { buildTransform, defaultExtruder, objectsPath }
  // Returns { objectsModel, rootModel, modelSettings } (strings).
  function buildSplitXML(objects, opts) {
    opts = opts || {};
    const bt = opts.buildTransform || "1 0 0 0 1 0 0 0 1 125 125 0";
    const objectsPath = opts.objectsPath || "/3D/Objects/object_1.model";
    const NS_HEADER =
      '<model unit="millimeter" xml:lang="en-US" ' +
      'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
      'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" ' +
      'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" ' +
      'requiredextensions="p">';

    // --- objects file: one <object> mesh per color ---
    const objBlocks = objects.map((o, k) => {
      const id = k + 1;
      const P = o.positions, I = o.indices, TS = o.triState;
      const vlines = [];
      for (let i = 0; i < P.length; i += 3)
        vlines.push('     <vertex x="' + fnum(P[i]) + '" y="' + fnum(P[i + 1]) +
          '" z="' + fnum(P[i + 2]) + '"/>');
      const tlines = [];
      for (let t = 0; t < I.length; t += 3) {
        let line = '     <triangle v1="' + I[t] + '" v2="' + I[t + 1] +
          '" v3="' + I[t + 2] + '"';
        if (TS) {
          const code = Paint.encode({ leaf: true, state: TS[t / 3] });
          if (code) line += ' paint_color="' + code + '"';
        }
        tlines.push(line + "/>");
      }
      return '  <object id="' + id + '" type="model">\n   <mesh>\n    <vertices>\n' +
        vlines.join("\n") + "\n    </vertices>\n    <triangles>\n" +
        tlines.join("\n") + "\n    </triangles>\n   </mesh>\n  </object>";
    });
    const objectsModel =
      '<?xml version="1.0" encoding="UTF-8"?>\n' + NS_HEADER + "\n" +
      ' <metadata name="BambuStudio:3mfVersion">2</metadata>\n' +
      " <resources>\n" + objBlocks.join("\n") + "\n </resources>\n <build/>\n</model>\n";

    // --- root file: N wrapper objects + N build items ---
    const wrap = objects.map((o, k) => {
      const meshId = k + 1, wid = 100 + meshId;
      return '  <object id="' + wid + '" p:UUID="' + uuid() + '" type="model">\n' +
        "   <components>\n" +
        '    <component p:path="' + objectsPath + '" objectid="' + meshId +
        '" p:UUID="' + uuid() + '" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n' +
        "   </components>\n  </object>";
    });
    const items = objects.map((o, k) =>
      '  <item objectid="' + (100 + k + 1) + '" p:UUID="' + uuid() +
      '" transform="' + bt + '" printable="1"/>');
    const rootModel =
      '<?xml version="1.0" encoding="UTF-8"?>\n' + NS_HEADER + "\n" +
      ' <metadata name="Application">Irodori</metadata>\n' +
      ' <metadata name="BambuStudio:3mfVersion">2</metadata>\n' +
      " <resources>\n" + wrap.join("\n") + "\n </resources>\n" +
      ' <build p:UUID="' + uuid() + '">\n' + items.join("\n") + "\n </build>\n</model>\n";

    // --- model_settings.config ---
    const sObjs = objects.map((o, k) => {
      const wid = 100 + k + 1, meshId = k + 1;
      return '  <object id="' + wid + '">\n' +
        '    <metadata key="name" value="' + o.name + '"/>\n' +
        '    <metadata key="extruder" value="' + o.extruder + '"/>\n' +
        '    <part id="' + meshId + '" subtype="normal_part">\n' +
        '      <metadata key="name" value="' + o.name + '"/>\n' +
        '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n' +
        '      <metadata key="extruder" value="' + o.extruder + '"/>\n' +
        "    </part>\n  </object>";
    });
    const insts = objects.map((o, k) =>
      "    <model_instance>\n" +
      '      <metadata key="object_id" value="' + (100 + k + 1) + '"/>\n' +
      '      <metadata key="instance_id" value="0"/>\n    </model_instance>');
    const modelSettings =
      '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' + sObjs.join("\n") + "\n" +
      '  <plate>\n    <metadata key="plater_id" value="1"/>\n' + insts.join("\n") +
      "\n  </plate>\n  <assemble>\n  </assemble>\n</config>\n";

    return { objectsModel, rootModel, modelSettings };
  }

  global.Split = { solidFromSubs, remainderSolid, majorityBorderColor, buildSplitXML, uuid };
})(window);
