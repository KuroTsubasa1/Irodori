/* subgraph.js — the cached sub-triangle adjacency graph and its statistics.
 *
 * Part of the `Cleanup` namespace (split across subgraph.js / select.js /
 * cleanup.js by responsibility; this file must load FIRST of the three).
 * The graph is cached on the mesh (mesh._sub); invalidateSub clears every
 * mesh-attached cache (_sub, _subSizes, _mirror, _axisCenters).
 */
(function (global) {
  "use strict";
  const Cleanup = (global.Cleanup = global.Cleanup || {});

  const QSCALE = 100000; // coordinate quantization for vertex welding
  const q = (v) => Math.round(v * QSCALE);

  // dominant filament per face (for the filament-count list / swatches)
  function computeDominant(mesh) {
    if (mesh.dom) return mesh.dom;
    const dom = new Int32Array(mesh.nf);
    for (let i = 0; i < mesh.nf; i++) {
      const s = Paint.solidState(mesh.paints[i]);
      dom[i] = s >= 0 ? s : Paint.dominantState(Paint.decode(mesh.paints[i]));
    }
    mesh.dom = dom;
    return dom;
  }

  function invalidateSub(mesh) {
    mesh._sub = null;
    mesh._subSizes = null;
    mesh._mirror = null;
    mesh._axisCenters = null;
    mesh._faceG = null;
  }

  // Build (or return cached) the sub-triangle adjacency graph for a mesh.
  function buildSubGraph(mesh) {
    if (mesh._sub) return mesh._sub;
    const nf = mesh.nf,
      P = mesh.positions;

    // decode trees and count sub-triangles
    const trees = new Array(nf);
    let NS = 0;
    for (let f = 0; f < nf; f++) {
      const t = Paint.decode(mesh.paints[f]);
      trees[f] = t;
      NS += Paint.leafCount(t);
    }

    const subLeaf = new Array(NS);
    const subFace = new Int32Array(NS);
    const sv = new Int32Array(NS * 3); // 3 vertex ids per sub-triangle
    const cen = new Float32Array(NS * 3); // sub-triangle centroid (model space)

    // vertex welding
    const vmap = new Map();
    const cx = [],
      cy = [],
      cz = [];
    function pid(x, y, z) {
      const k = q(x) + "_" + q(y) + "_" + q(z);
      let id = vmap.get(k);
      if (id === undefined) {
        id = cx.length;
        vmap.set(k, id);
        cx.push(x); cy.push(y); cz.push(z);
      }
      return id;
    }

    let t = 0;
    for (let f = 0; f < nf; f++) {
      const a = mesh.v1[f] * 3,
        b = mesh.v2[f] * 3,
        c = mesh.v3[f] * 3;
      Paint.tessellate(
        trees[f], P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2],
        (leaf, x0, y0, z0, x1, y1, z1, x2, y2, z2) => {
          subLeaf[t] = leaf;
          subFace[t] = f;
          sv[t * 3] = pid(x0, y0, z0);
          sv[t * 3 + 1] = pid(x1, y1, z1);
          sv[t * 3 + 2] = pid(x2, y2, z2);
          cen[t * 3] = (x0 + x1 + x2) / 3;
          cen[t * 3 + 1] = (y0 + y1 + y2) / 3;
          cen[t * 3 + 2] = (z0 + z1 + z2) / 3;
          t += 1;
        }
      );
    }
    const NV = cx.length;

    // midpoint lookup: id of the midpoint vertex of (u,v), or -1
    const midOf = (u, v) => {
      const k =
        q((cx[u] + cx[v]) / 2) + "_" + q((cy[u] + cy[v]) / 2) + "_" + q((cz[u] + cz[v]) / 2);
      const m = vmap.get(k);
      return m === undefined ? -1 : m;
    };

    // register adjacency, splitting an edge at any existing midpoint (T-junctions)
    const edge = new Map(); // key -> first sub-tri, or -1 once paired
    const adjA = [],
      adjB = [];
    function reg(ti, u, v) {
      const key = u < v ? u * NV + v : v * NV + u;
      const p = edge.get(key);
      if (p === undefined) edge.set(key, ti);
      else if (p >= 0 && p !== ti) {
        adjA.push(p); adjB.push(ti);
        edge.set(key, -1);
      }
    }
    function atomic(ti, u, v) {
      const m = midOf(u, v);
      if (m >= 0 && m !== u && m !== v) {
        atomic(ti, u, m);
        atomic(ti, m, v);
      } else reg(ti, u, v);
    }
    for (let i = 0; i < NS; i++) {
      const a = sv[i * 3],
        b = sv[i * 3 + 1],
        c = sv[i * 3 + 2];
      atomic(i, a, b);
      atomic(i, b, c);
      atomic(i, c, a);
    }

    // CSR
    const deg = new Int32Array(NS);
    for (let i = 0; i < adjA.length; i++) {
      deg[adjA[i]]++; deg[adjB[i]]++;
    }
    const start = new Int32Array(NS + 1);
    for (let i = 0; i < NS; i++) start[i + 1] = start[i] + deg[i];
    const list = new Int32Array(start[NS]);
    const cur = start.slice(0, NS);
    for (let i = 0; i < adjA.length; i++) {
      const a = adjA[i],
        b = adjB[i];
      list[cur[a]++] = b;
      list[cur[b]++] = a;
    }

    mesh._sub = {
      start, list, subLeaf, subFace, trees, cen, NS,
      sv, vx: cx, vy: cy, vz: cz, NV, midOf,
    };
    return mesh._sub;
  }

  // Parent-face adjacency (CSR, same shape as the sub graph) + unit face
  // normals. Geometry-only, lazy, cached as mesh._faceG. invalidateSub clears
  // it anyway — one cache story for everything mesh-attached; the rebuild is
  // a single pass over the index buffer.
  function faceGraph(mesh) {
    if (mesh._faceG) return mesh._faceG;
    const nf = mesh.nf, P = mesh.positions;
    const faceN = new Float32Array(nf * 3);
    for (let f = 0; f < nf; f++) {
      const a = mesh.v1[f] * 3, b = mesh.v2[f] * 3, c = mesh.v3[f] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const L = Math.hypot(nx, ny, nz);
      // degenerate faces keep (0,0,0) — selectSmartFaces never crosses them
      if (L > 0) { faceN[f * 3] = nx / L; faceN[f * 3 + 1] = ny / L; faceN[f * 3 + 2] = nz / L; }
    }
    // undirected vertex-index edge -> every face sharing it (non-manifold:
    // all pairs get connected, so no region is orphaned)
    const NV = P.length / 3;
    const edge = new Map();
    const adjA = [], adjB = [];
    for (let f = 0; f < nf; f++) {
      const va = mesh.v1[f], vb = mesh.v2[f], vc = mesh.v3[f];
      for (const [u, v] of [[va, vb], [vb, vc], [vc, va]]) {
        const key = u < v ? u * NV + v : v * NV + u;
        let arr = edge.get(key);
        if (!arr) edge.set(key, (arr = []));
        for (const p of arr) { adjA.push(p); adjB.push(f); }
        arr.push(f);
      }
    }
    const deg = new Int32Array(nf);
    for (let i = 0; i < adjA.length; i++) { deg[adjA[i]]++; deg[adjB[i]]++; }
    const start = new Int32Array(nf + 1);
    for (let i = 0; i < nf; i++) start[i + 1] = start[i] + deg[i];
    const list = new Int32Array(start[nf]);
    const cur = start.slice(0, nf);
    for (let i = 0; i < adjA.length; i++) {
      const a2 = adjA[i], b2 = adjB[i];
      list[cur[a2]++] = b2;
      list[cur[b2]++] = a2;
    }
    mesh._faceG = { start, list, faceN, nf };
    return mesh._faceG;
  }

  // Flood the same-state component containing `seed`; returns member indices.
  function floodComponent(start, list, state, comp, seed, scratch) {
    const st = state[seed];
    const members = [];
    let sp = 0,
      s = scratch.stk;
    s[sp++] = seed;
    comp[seed] = seed;
    while (sp > 0) {
      const u = s[--sp];
      members.push(u);
      for (let e = start[u]; e < start[u + 1]; e++) {
        const v = list[e];
        if (comp[v] === -1 && state[v] === st) {
          comp[v] = seed;
          if (sp >= s.length) {
            const ns = new Int32Array(s.length * 2);
            ns.set(s);
            s = scratch.stk = ns;
          }
          s[sp++] = v;
        }
      }
    }
    return members;
  }

  /* Per-state sorted component sizes (sub-triangles), cached. Used by stats. */
  function subSizes(mesh) {
    if (mesh._subSizes) return mesh._subSizes;
    const g = buildSubGraph(mesh);
    const { start, list, subLeaf, NS } = g;
    const state = new Int32Array(NS);
    for (let i = 0; i < NS; i++) state[i] = subLeaf[i].state;
    const comp = new Int32Array(NS).fill(-1);
    const scratch = { stk: new Int32Array(1024) };
    const sizes = {};
    for (let seed = 0; seed < NS; seed++) {
      if (comp[seed] !== -1) continue;
      const st = state[seed];
      const members = floodComponent(start, list, state, comp, seed, scratch);
      (sizes[st] || (sizes[st] = [])).push(members.length);
    }
    for (const k in sizes) sizes[k].sort((a, b) => b - a);
    mesh._subSizes = sizes;
    return sizes;
  }

  Object.assign(Cleanup, {
    computeDominant,
    buildSubGraph,
    faceGraph,
    invalidateSub,
    subSizes,
    floodComponent, // shared with cleanup.js's removeIslandsSub
  });
})(window);
