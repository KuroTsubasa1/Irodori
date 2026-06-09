/* cleanup.js — sub-triangle-level color correction.
 *
 * The slicer paints individual sub-triangles, so stray color often lives on
 * PART of a boundary face. We therefore tessellate every face into its leaf
 * sub-triangles, build an adjacency graph across them (resolving T-junctions,
 * where a split face borders a less-subdivided one), find connected same-color
 * regions, and recolor the small ones to the color they border most.
 *
 * The graph is cached on the mesh (mesh._sub) and invalidated whenever paints
 * change. Each sub-triangle holds a reference to its leaf node, so a reassigned
 * color is written straight back into the paint tree and re-encoded.
 */
(function (global) {
  "use strict";

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

    mesh._sub = { start, list, subLeaf, subFace, trees, NS };
    return mesh._sub;
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

  /* Remove small same-color sub-triangle islands.
   * opts: { maxSize, removable:Set<state>, passes }
   * Returns { count, changedFaces:Set }. Mutates mesh.paints/dom in place. */
  function removeIslandsSub(mesh, opts) {
    const g = buildSubGraph(mesh);
    const { start, list, subLeaf, subFace, trees, NS } = g;
    const maxSize = opts.maxSize,
      removable = opts.removable,
      passes = opts.passes || 3;

    const state = new Int32Array(NS);
    for (let i = 0; i < NS; i++) state[i] = subLeaf[i].state;

    const comp = new Int32Array(NS);
    const scratch = { stk: new Int32Array(1024) };

    for (let pass = 0; pass < passes; pass++) {
      comp.fill(-1);
      let changed = 0;
      for (let seed = 0; seed < NS; seed++) {
        if (comp[seed] !== -1) continue;
        const st = state[seed];
        const members = floodComponent(start, list, state, comp, seed, scratch);
        if (members.length > maxSize || !removable.has(st)) continue;
        // vote on surrounding color (by shared sub-edge count)
        const votes = new Map();
        for (let k = 0; k < members.length; k++) {
          const u = members[k];
          for (let e = start[u]; e < start[u + 1]; e++) {
            const v = list[e];
            if (comp[v] !== seed) votes.set(state[v], (votes.get(state[v]) || 0) + 1);
          }
        }
        let target = -1,
          best = -1;
        votes.forEach((n, vs) => {
          if (vs !== st && (n > best || (n === best && vs < target))) {
            best = n;
            target = vs;
          }
        });
        if (target === -1) continue;
        for (let k = 0; k < members.length; k++) state[members[k]] = target;
        changed += members.length;
      }
      if (changed === 0) break;
    }

    // write back changed states into the paint trees and re-encode
    const changedFaces = new Set();
    let count = 0;
    for (let i = 0; i < NS; i++) {
      if (state[i] !== subLeaf[i].state) {
        subLeaf[i].state = state[i];
        changedFaces.add(subFace[i]);
        count++;
      }
    }
    const dom = mesh.dom;
    changedFaces.forEach((f) => {
      const col = Paint.collapseIfUniform(trees[f]);
      mesh.paints[f] = Paint.encode(col);
      if (dom) dom[f] = Paint.dominantState(col);
    });
    invalidateSub(mesh);
    return { count, changedFaces };
  }

  /* Manual flood fill: from sub-triangle `seedSub`, flood its connected
   * same-color region and recolor it. targetState = a state to paint with, or
   * null to use the surrounding majority color (like auto-cleanup, per click).
   * Keeps the cached graph valid (no collapse), so repeated fills stay fast.
   * Returns { count, changedFaces, from, to }. */
  function fillRegion(mesh, seedSub, targetState) {
    const g = buildSubGraph(mesh);
    const { start, list, subLeaf, subFace, trees, NS } = g;
    if (seedSub < 0 || seedSub >= NS) return { count: 0, changedFaces: new Set() };
    const seedState = subLeaf[seedSub].state;

    // flood the same-state component
    const seen = new Uint8Array(NS);
    const members = [];
    const stk = [seedSub];
    seen[seedSub] = 1;
    while (stk.length) {
      const u = stk.pop();
      members.push(u);
      for (let e = start[u]; e < start[u + 1]; e++) {
        const v = list[e];
        if (!seen[v] && subLeaf[v].state === seedState) {
          seen[v] = 1;
          stk.push(v);
        }
      }
    }

    let target = targetState;
    if (target == null) {
      const votes = new Map();
      for (let k = 0; k < members.length; k++) {
        const u = members[k];
        for (let e = start[u]; e < start[u + 1]; e++) {
          const v = list[e];
          if (!seen[v]) votes.set(subLeaf[v].state, (votes.get(subLeaf[v].state) || 0) + 1);
        }
      }
      let best = -1;
      target = seedState;
      votes.forEach((n, s) => {
        if (s !== seedState && (n > best || (n === best && s < target))) {
          best = n;
          target = s;
        }
      });
    }
    if (target === seedState) return { count: 0, changedFaces: new Set() };

    const changedFaces = new Set();
    for (let k = 0; k < members.length; k++) {
      subLeaf[members[k]].state = target;
      changedFaces.add(subFace[members[k]]);
    }
    const dom = mesh.dom;
    changedFaces.forEach((f) => {
      mesh.paints[f] = Paint.encode(trees[f]); // no collapse -> graph stays valid
      if (dom) dom[f] = Paint.dominantState(trees[f]);
    });
    mesh._subSizes = null; // component sizes changed (graph geometry unchanged)
    return { count: members.length, changedFaces, from: seedState, to: target };
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

  global.Cleanup = {
    computeDominant,
    buildSubGraph,
    removeIslandsSub,
    fillRegion,
    subSizes,
    invalidateSub,
  };
})(window);
