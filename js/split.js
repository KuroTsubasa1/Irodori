/* split.js — volumetric split (plugSolids: region → solid plug + pocketed remainder), row layout, and the multi-object .3mf XML. Depends on Paint + Cleanup + Caps + MeshGeo (on window). */
(function (global) {
  "use strict";

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
      else if (a === o && a > 0) console.warn("plugSolids: ambiguous cap orientation; leaving component as-is");
    }
    if (flip.size) cap.tris.forEach((t, ti) => { if (flip.has(find(ti))) { const tmp = t[1]; t[1] = t[2]; t[2] = tmp; } });
  }

  const ekey = (a, b) => (a < b ? a + "_" + b : b + "_" + a);

  // Edge u-v split at every T-junction midpoint recorded by midOf: [u, ..., v].
  function decomposeEdge(midOf, u, v) {
    const m = midOf ? midOf(u, v) : -1;
    return (m >= 0 && m !== u && m !== v) ? decomposeEdge(midOf, u, m).concat(decomposeEdge(midOf, m, v).slice(1)) : [u, v];
  }

  // Conformed boundary of a sub-triangle set: surface-directed rim loops (gids
  // from the welded sub graph), the surface direction of every rim edge, and a
  // pinch flag (a rim vertex with != 2 rim edges — the region touches itself).
  function patchBoundary(mesh, subs, g) {
    const { sv, midOf } = g;
    const decompose = (u, v) => decomposeEdge(midOf, u, v);
    const edges = new Map(); // key -> { u, v, count }
    for (let k = 0; k < subs.length; k++) {
      const s = subs[k];
      const a = sv[s * 3], b = sv[s * 3 + 1], c = sv[s * 3 + 2];
      const poly = decompose(a, b).concat(decompose(b, c).slice(1), decompose(c, a).slice(1, -1));
      for (let i = 0; i < poly.length; i++) {
        const u = poly[i], v = poly[(i + 1) % poly.length], key = ekey(u, v);
        const e = edges.get(key);
        if (e) e.count++; else edges.set(key, { u, v, count: 1 });
      }
    }
    const directed = [], surfDir = new Map(), deg = new Map();
    for (const [key, e] of edges) {
      if (e.count !== 1) continue;
      directed.push([e.u, e.v]);
      surfDir.set(key, e.u + ">" + e.v);
      deg.set(e.u, (deg.get(e.u) || 0) + 1); deg.set(e.v, (deg.get(e.v) || 0) + 1);
    }
    let pinch = false;
    for (const d of deg.values()) if (d !== 2) { pinch = true; break; }
    const loops = pinch ? [] : Caps.extractLoops(directed);
    return { loops, surfDir, pinch };
  }

  // Unit area-weighted normal at every rim vertex (rim: Set of gids), summed
  // over all incident sub-triangles on BOTH sides of the rim. A sub contributes
  // to every vertex of its conformed polygon, so T-junction midpoints lying on
  // a sub's edge (not a corner) are included.
  function rimNormals(mesh, g, rim) {
    const { sv, vx, vy, vz, NS, midOf } = g;
    const acc = new Map(); for (const gid of rim) acc.set(gid, [0, 0, 0]);
    for (let s = 0; s < NS; s++) {
      const a = sv[s * 3], b = sv[s * 3 + 1], c = sv[s * 3 + 2];
      const poly = decomposeEdge(midOf, a, b).concat(decomposeEdge(midOf, b, c).slice(1), decomposeEdge(midOf, c, a).slice(1, -1));
      if (!poly.some((gid) => rim.has(gid))) continue;
      const ux = vx[b] - vx[a], uy = vy[b] - vy[a], uz = vz[b] - vz[a];
      const wx = vx[c] - vx[a], wy = vy[c] - vy[a], wz = vz[c] - vz[a];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx; // area-weighted
      for (const gid of poly) { const t = acc.get(gid); if (t) { t[0] += nx; t[1] += ny; t[2] += nz; } }
    }
    for (const v of acc.values()) { const L = Math.hypot(v[0], v[1], v[2]) || 1; v[0] /= L; v[1] /= L; v[2] /= L; }
    return acc;
  }

  // Inward direction and depth for every rim vertex. dir = −(smoothed model
  // normal); t = min(depth, 0.5·t_hit) · |cos θ| (θ: normal vs the loop's
  // best-fit plane normal) — see the spec's "Per-rim-vertex depth".
  function rimFrame(mesh, g, loops, depth, grid) {
    const { vx, vy, vz } = g;
    const acc = rimNormals(mesh, g, new Set(loops.reduce((a, L) => a.concat(L), [])));
    const unit = (v) => { const L = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / L, v[1] / L, v[2] / L]; };
    const dir = new Map(), t = new Map();
    const diag = MeshGeo.meshBounds(mesh).diag;
    for (const L of loops) {
      let N = L.map((gid) => acc.get(gid));
      for (let pass = 0; pass < 2; pass++) // two 1-ring smoothing passes along the loop
        N = N.map((n, i) => { const p = N[(i + L.length - 1) % L.length], q = N[(i + 1) % L.length]; return unit([p[0] + n[0] + q[0], p[1] + n[1] + q[1], p[2] + n[2] + q[2]]); });
      const pl = Caps.bestFitPlane(L.map((gid) => [vx[gid], vy[gid], vz[gid]]));
      L.forEach((gid, i) => {
        const n = N[i], d = [-n[0], -n[1], -n[2]];
        const w = Math.abs(n[0] * pl.nx + n[1] * pl.ny + n[2] * pl.nz);
        const hit = MeshGeo.rayHit(mesh, grid, vx[gid], vy[gid], vz[gid], d[0], d[1], d[2], 1e-4 * diag, true);
        dir.set(gid, d);
        t.set(gid, Math.min(depth, 0.5 * hit) * w);
      });
    }
    return { dir, t };
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
    const decompose = (u, v) => decomposeEdge(midOf, u, v);
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

  // Wall + bottom for the current depth scale. Ids: rim gids (< NV), offset
  // points NV + k, bottom extras NV + nOff + j. Returns tris (id triples, PART
  // winding), coords for ids >= NV, and the offset-id of every rim gid.
  function buildPlug(mesh, g, bnd, frame, scale, method) {
    const { vx, vy, vz, NV } = g;
    const diag = MeshGeo.meshBounds(mesh).diag, weldEps = 1e-6 * diag;
    const offId = new Map(), extra = []; // extra[k] = [x,y,z] for id NV + k
    for (const L of bnd.loops) for (const gid of L) {
      const t = frame.t.get(gid) * scale;
      if (t <= weldEps) { offId.set(gid, gid); continue; }
      const d = frame.dir.get(gid);
      offId.set(gid, NV + extra.length);
      extra.push([vx[gid] + d[0] * t, vy[gid] + d[1] * t, vz[gid] + d[2] * t]);
    }
    const pt = (id) => (id < NV ? [vx[id], vy[id], vz[id]] : extra[id - NV]);
    const tris = [];
    const wallDir = new Map(); // offset-edge key -> "u'>v'" (direction the wall traverses)
    for (const L of bnd.loops) for (let i = 0; i < L.length; i++) {
      const u = L[i], v = L[(i + 1) % L.length], u2 = offId.get(u), v2 = offId.get(v);
      if (u2 !== u || v2 !== v) {
        if (u2 !== u) tris.push([v, u, u2]);
        if (v2 !== v) tris.push([v, u2, v2]);
      }
      wallDir.set(ekey(u2, v2), u2 + ">" + v2);
    }
    const offLoops = bnd.loops.map((L) => L.map((gid) => offId.get(gid)));
    const cap = Caps.triangulateLoops(offLoops, pt, method);
    orientCapComponents(cap, wallDir);
    const base = NV + extra.length;
    for (const ep of cap.extraPts) extra.push(ep);
    const ref = (i) => (i < cap.verts.length ? cap.verts[i] : base + (i - cap.verts.length));
    for (const [a, b, c] of cap.tris) tris.push([ref(a), ref(b), ref(c)]);
    return { tris, pt, nWall: tris.length - cap.tris.length };
  }

  // Do any of the new triangles cross each other or the mesh? Each new tri is
  // shrunk 2% toward its centroid so legitimate touching along the rim (and
  // between adjacent new tris) is not counted; true crossings survive.
  function anyIntersection(newTris, pt, mesh, grid) {
    const shrink = (t) => {
      const p = t.map(pt);
      const cx = (p[0][0] + p[1][0] + p[2][0]) / 3, cy = (p[0][1] + p[1][1] + p[2][1]) / 3, cz = (p[0][2] + p[1][2] + p[2][2]) / 3;
      return p.map((q) => [cx + (q[0] - cx) * 0.98, cy + (q[1] - cy) * 0.98, cz + (q[2] - cz) * 0.98]);
    };
    const S = newTris.map(shrink);
    const { n, min, cell, start, list } = grid;
    const ci = (x, k) => Math.max(0, Math.min(n - 1, Math.floor((x - min[k]) / cell[k])));
    const box = (tri) => [0, 1, 2].map((k) => [ci(Math.min(tri[0][k], tri[1][k], tri[2][k]), k), ci(Math.max(tri[0][k], tri[1][k], tri[2][k]), k)]);
    const P = mesh.positions;
    const faceTri = (f) => [mesh.v1[f], mesh.v2[f], mesh.v3[f]].map((v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
    // bucket the new tris by cell for the new-vs-new pass
    const cellNew = new Map();
    const boxes = S.map(box);
    boxes.forEach((bx, i) => {
      for (let x = bx[0][0]; x <= bx[0][1]; x++) for (let y = bx[1][0]; y <= bx[1][1]; y++) for (let z = bx[2][0]; z <= bx[2][1]; z++) {
        const c = (x * n + y) * n + z;
        let arr = cellNew.get(c); if (!arr) cellNew.set(c, (arr = [])); arr.push(i);
      }
    });
    const tested = new Set();
    for (let i = 0; i < S.length; i++) {
      const bx = boxes[i];
      for (let x = bx[0][0]; x <= bx[0][1]; x++) for (let y = bx[1][0]; y <= bx[1][1]; y++) for (let z = bx[2][0]; z <= bx[2][1]; z++) {
        const c = (x * n + y) * n + z;
        for (const j of cellNew.get(c) || []) {
          if (j <= i) continue;
          const key = i * S.length + j; if (tested.has(key)) continue; tested.add(key);
          if (MeshGeo.triTriIntersect(...S[i], ...S[j])) return true;
        }
        for (let e = start[c]; e < start[c + 1]; e++) {
          const f = list[e], key = -1 - (i * mesh.nf + f); if (tested.has(key)) continue; tested.add(key);
          if (MeshGeo.triTriIntersect(...S[i], ...faceTri(f))) return true;
        }
      }
    }
    return false;
  }

  // Volumetric split: the region as a solid plug (patch + inward wall + bottom)
  // and the remainder with the matching pocket. Both are plain document meshes.
  // See docs/superpowers/specs/2026-10-13-volumetric-split-design.md.
  function plugSolids(mesh, subs, opts) {
    const depth = Math.max(0, +(opts && opts.depth) || 0), method = (opts && opts.method) || "liepa";
    const g = Cleanup.buildSubGraph(mesh);
    if (!subs.length) return { error: "Nothing to split there" };
    if (subs.length >= g.NS) return { error: "That's the whole object" };
    const bnd = patchBoundary(mesh, subs, g);
    if (bnd.pinch) return { error: "Region touches itself at a point — paint a wider bridge or gap" };
    if (!bnd.loops.length) return { error: "Couldn't find the region's outline" };
    const grid = MeshGeo.faceGrid(mesh);
    const frame = rimFrame(mesh, g, bnd.loops, depth, grid);
    let scale = 1, halvings = 0, plug;
    for (;;) {
      plug = buildPlug(mesh, g, bnd, frame, scale, method);
      if (scale === 0 || !anyIntersection(plug.tris, plug.pt, mesh, grid)) break;
      halvings++;
      scale = halvings >= 4 ? 0 : scale / 2;
    }
    const inSet = new Set(subs);
    const rest = []; for (let s = 0; s < g.NS; s++) if (!inSet.has(s)) rest.push(s);
    const partState = g.subLeaf[subs[0]].state;
    const pocketState = majorityBorderColor(mesh, g, { subs, state: partState });
    const solid = (st) => Paint.encode({ leaf: true, state: st });
    // assemble one mesh: conformed surface + plug tris (optionally reversed)
    const assemble = (surfSubs, reverse, plugState) => {
      const surf = openSurface(mesh, surfSubs, g);
      const px = surf.px, py = surf.py, pz = surf.pz, F = surf.F, paints = surf.triSt.map(solid);
      const local = new Map();
      const lid = (id) => {
        if (id < g.NV) return surf.lid(id);
        let i = local.get(id);
        if (i === undefined) { const p = plug.pt(id); i = px.length; local.set(id, i); px.push(p[0]); py.push(p[1]); pz.push(p[2]); }
        return i;
      };
      for (const [a, b, c] of plug.tris) {
        if (reverse) F.push(lid(a), lid(c), lid(b)); else F.push(lid(a), lid(b), lid(c));
        paints.push(solid(plugState));
      }
      const nf = F.length / 3, v1 = new Int32Array(nf), v2 = new Int32Array(nf), v3 = new Int32Array(nf);
      for (let f = 0; f < nf; f++) { v1[f] = F[f * 3]; v2[f] = F[f * 3 + 1]; v3[f] = F[f * 3 + 2]; }
      const positions = new Float32Array(px.length * 3);
      for (let i = 0; i < px.length; i++) { positions[i * 3] = px[i]; positions[i * 3 + 1] = py[i]; positions[i * 3 + 2] = pz[i]; }
      return { positions, nf, v1, v2, v3, paints };
    };
    const part = assemble(subs, false, partState);
    const remainder = assemble(rest, true, pocketState);
    const bad = (m) => MeshGeo.checkClosed(m) || !(MeshGeo.signedVolume(m) > 0);
    if (bad(part) || bad(remainder)) return { error: "Couldn't make a clean solid here (pocket-shaped or too sharp region)", info: { halvings, shell: scale === 0, faces: subs.length } };
    return { part, remainder, info: { halvings, shell: scale === 0, faces: subs.length } };
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

  // Row layout for split parts: slots along +X beside the body, y-centered on
  // it, bottoms aligned to its base plane. Boxes: { min:[x,y,z], max:[x,y,z] }.
  // Returns one [dx, dy, dz] offset per part box.
  function layoutParts(bodyBox, partBoxes, margin) {
    margin = margin || 0;
    const bcy = (bodyBox.min[1] + bodyBox.max[1]) / 2;
    let cursor = bodyBox.max[0] + margin;
    return partBoxes.map((p) => {
      const dx = cursor - p.min[0];
      const dy = bcy - (p.min[1] + p.max[1]) / 2;
      const dz = bodyBox.min[2] - p.min[2];
      cursor += (p.max[0] - p.min[0]) + margin;
      return [dx, dy, dz];
    });
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
      const P = o.positions, I = o.indices, TS = o.triState, PS = o.paints;
      const vlines = [];
      for (let i = 0; i < P.length; i += 3)
        vlines.push('     <vertex x="' + fnum(P[i]) + '" y="' + fnum(P[i + 1]) +
          '" z="' + fnum(P[i + 2]) + '"/>');
      const tlines = [];
      for (let t = 0; t < I.length; t += 3) {
        let line = '     <triangle v1="' + I[t] + '" v2="' + I[t + 1] +
          '" v3="' + I[t + 2] + '"';
        if (PS) {
          const p = PS[t / 3];
          if (p) line += ' paint_color="' + p + '"';
        } else if (TS) {
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

global.Split = { plugSolids, patchBoundary, rimNormals, rimFrame, buildSplitXML, uuid, layoutParts };
})(window);
