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
    mesh._mirror = null;
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

  // Flood from seedSub over adjacency, keeping sub-triangles whose centroid
  // passes `accept(i)`. Returns the connected member indices.
  function floodAccept(g, seedSub, accept) {
    const { start, list, NS } = g;
    const seen = new Uint8Array(NS);
    const out = [];
    const stk = [seedSub];
    seen[seedSub] = 1;
    while (stk.length) {
      const u = stk.pop();
      out.push(u);
      for (let e = start[u]; e < start[u + 1]; e++) {
        const v = list[e];
        if (!seen[v] && accept(v)) {
          seen[v] = 1;
          stk.push(v);
        }
      }
    }
    return out;
  }

  // Brush: connected sub-triangles within `radius` of point p, reachable from
  // seedSub across the surface (so it doesn't bleed through to the far side).
  function selectRadius(mesh, seedSub, px, py, pz, radius) {
    const g = buildSubGraph(mesh);
    const cen = g.cen;
    const r2 = radius * radius;
    const near = (i) => {
      const dx = cen[i * 3] - px, dy = cen[i * 3 + 1] - py, dz = cen[i * 3 + 2] - pz;
      return dx * dx + dy * dy + dz * dz <= r2;
    };
    if (!near(seedSub)) return [seedSub];
    return floodAccept(g, seedSub, near);
  }

  // Ring/contour: connected band on the clicked feature within +/- half of the
  // seed's coordinate along `axis` (0=x,1=y,2=z). Wraps around tubular features.
  function selectBand(mesh, seedSub, axis, half) {
    const g = buildSubGraph(mesh);
    const cen = g.cen;
    const h0 = cen[seedSub * 3 + axis];
    const inBand = (i) => Math.abs(cen[i * 3 + axis] - h0) <= half;
    return floodAccept(g, seedSub, inBand);
  }

  // Estimate the local feature axis at a click via PCA of the surrounding patch
  // (within Euclidean radius Rn). The dominant eigenvector is the direction the
  // feature extends (the ear/tail/limb axis). Returns the axis, a ring center on
  // that axis at the click's cross-section, and a representative ring radius.
  function featureAxis(mesh, seedSub, Rn) {
    const g = buildSubGraph(mesh);
    const { start, list, cen, NS } = g;
    const sx = cen[seedSub * 3], sy = cen[seedSub * 3 + 1], sz = cen[seedSub * 3 + 2];
    const Rn2 = Rn * Rn;
    const seen = new Uint8Array(NS);
    const mem = [];
    const stk = [seedSub];
    seen[seedSub] = 1;
    while (stk.length && mem.length < 3000) {
      const u = stk.pop();
      const dx = cen[u * 3] - sx, dy = cen[u * 3 + 1] - sy, dz = cen[u * 3 + 2] - sz;
      if (dx * dx + dy * dy + dz * dz > Rn2) continue;
      mem.push(u);
      for (let e = start[u]; e < start[u + 1]; e++) {
        const v = list[e];
        if (!seen[v]) { seen[v] = 1; stk.push(v); }
      }
    }
    const n = mem.length;
    if (n < 8) return { ax: 0, ay: 0, az: 1, cx: sx, cy: sy, cz: sz, radius: Rn * 0.5 };
    let mx = 0, my = 0, mz = 0;
    for (const u of mem) { mx += cen[u * 3]; my += cen[u * 3 + 1]; mz += cen[u * 3 + 2]; }
    mx /= n; my /= n; mz /= n;
    let cxx = 0, cyy = 0, czz = 0, cxy = 0, cxz = 0, cyz = 0;
    for (const u of mem) {
      const dx = cen[u * 3] - mx, dy = cen[u * 3 + 1] - my, dz = cen[u * 3 + 2] - mz;
      cxx += dx * dx; cyy += dy * dy; czz += dz * dz;
      cxy += dx * dy; cxz += dx * dz; cyz += dy * dz;
    }
    // dominant eigenvector via power iteration
    let vx = 1, vy = 0, vz = 0;
    if (cyy >= cxx && cyy >= czz) { vx = 0; vy = 1; vz = 0; }
    else if (czz >= cxx && czz >= cyy) { vx = 0; vy = 0; vz = 1; }
    for (let k = 0; k < 40; k++) {
      const nx = cxx * vx + cxy * vy + cxz * vz;
      const ny = cxy * vx + cyy * vy + cyz * vz;
      const nz = cxz * vx + cyz * vy + czz * vz;
      const len = Math.hypot(nx, ny, nz) || 1;
      vx = nx / len; vy = ny / len; vz = nz / len;
    }
    // Snap to vertical when the axis is already nearly vertical — keeps clean
    // horizontal belts on the torso; clearly-tilted features (ears, tail, limbs)
    // keep their own axis so the ring wraps them perpendicularly.
    if (Math.abs(vz) > 0.82) { vx = 0; vy = 0; vz = 1; }
    // representative cross-section radius (avg perpendicular spread)
    let r = 0;
    for (const u of mem) {
      const dx = cen[u * 3] - mx, dy = cen[u * 3 + 1] - my, dz = cen[u * 3 + 2] - mz;
      const p = dx * vx + dy * vy + dz * vz;
      r += Math.hypot(dx - p * vx, dy - p * vy, dz - p * vz);
    }
    r /= n;
    // center on the axis at the clicked cross-section
    const sp = (sx - mx) * vx + (sy - my) * vy + (sz - mz) * vz;
    return {
      ax: vx, ay: vy, az: vz,
      cx: mx + sp * vx, cy: my + sp * vy, cz: mz + sp * vz,
      radius: r * 1.15 || Rn * 0.5,
    };
  }

  // Band of connected sub-triangles within +/- half along an arbitrary axis.
  function selectBandAxis(mesh, seedSub, half, ax, ay, az) {
    const g = buildSubGraph(mesh);
    const cen = g.cen;
    const sx = cen[seedSub * 3], sy = cen[seedSub * 3 + 1], sz = cen[seedSub * 3 + 2];
    const inBand = (i) => {
      const dx = cen[i * 3] - sx, dy = cen[i * 3 + 1] - sy, dz = cen[i * 3 + 2] - sz;
      return Math.abs(dx * ax + dy * ay + dz * az) <= half;
    };
    return floodAccept(g, seedSub, inBand);
  }

  // Paint the given local sub-triangles to `state`; re-encode affected faces.
  // Does NOT collapse, so the cached graph stays valid for fast repeated paints.
  function applyStates(mesh, subs, state) {
    const g = buildSubGraph(mesh);
    const { subLeaf, subFace, trees } = g;
    const changedFaces = new Set();
    for (let k = 0; k < subs.length; k++) {
      const s = subs[k];
      if (subLeaf[s].state !== state) {
        subLeaf[s].state = state;
        changedFaces.add(subFace[s]);
      }
    }
    const dom = mesh.dom;
    changedFaces.forEach((f) => {
      mesh.paints[f] = Paint.encode(trees[f]);
      if (dom) dom[f] = Paint.dominantState(trees[f]);
    });
    mesh._subSizes = null; // states changed; graph geometry unchanged
    return { changedFaces, count: subs.length };
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

  // Flood the connected same-color region containing seedSub. Returns the
  // member sub-triangle indices (Int32Array).
  // Optional `exclude` Set: sub-triangle indices that are never flooded into.
  function selectColorRegion(mesh, seedSub, exclude) {
    const g = buildSubGraph(mesh);
    const { start, list, subLeaf, NS } = g;
    if (seedSub < 0 || seedSub >= NS) return new Int32Array(0);
    if (exclude && exclude.has(seedSub)) return new Int32Array(0);
    const st = subLeaf[seedSub].state;
    const seen = new Uint8Array(NS);
    const out = [];
    const stk = [seedSub];
    seen[seedSub] = 1;
    while (stk.length) {
      const u = stk.pop();
      out.push(u);
      for (let e = start[u]; e < start[u + 1]; e++) {
        const v = list[e];
        if (!seen[v] && subLeaf[v].state === st && !(exclude && exclude.has(v))) {
          seen[v] = 1;
          stk.push(v);
        }
      }
    }
    return Int32Array.from(out);
  }

  // Per-sub mirror partner across the model-center plane perpendicular to `axis`
  // (0=x,1=y,2=z): entry s = the sub whose centroid is the mirror of s's centroid
  // (within a ~1% tolerance via a spatial grid), or -1. Cached per axis on the
  // mesh; tolerant matching so it works on imperfectly-symmetric organic meshes.
  function mirrorMap(mesh, axis) {
    const g = buildSubGraph(mesh);
    if (!mesh._mirror) mesh._mirror = {};
    if (mesh._mirror[axis]) return mesh._mirror[axis];
    const { cen, NS } = g;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < NS; i++) for (let a = 0; a < 3; a++) { const v = cen[i * 3 + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
    const center = (lo[axis] + hi[axis]) / 2;
    const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
    const cell = diag * 0.01;          // grid resolution
    const tol2 = cell * cell;          // match tolerance (squared) ~ one cell
    const ci = (v, a) => Math.floor((v - lo[a]) / cell);
    const bkey = (a, b, c) => a + "," + b + "," + c;
    const buckets = new Map();
    for (let i = 0; i < NS; i++) {
      const k = bkey(ci(cen[i * 3], 0), ci(cen[i * 3 + 1], 1), ci(cen[i * 3 + 2], 2));
      let arr = buckets.get(k); if (!arr) buckets.set(k, arr = []); arr.push(i);
    }
    const map = new Int32Array(NS).fill(-1);
    for (let i = 0; i < NS; i++) {
      let mx = cen[i * 3], my = cen[i * 3 + 1], mz = cen[i * 3 + 2];
      if (axis === 0) mx = 2 * center - mx; else if (axis === 1) my = 2 * center - my; else mz = 2 * center - mz;
      const bx = ci(mx, 0), by = ci(my, 1), bz = ci(mz, 2);
      let best = -1, bestD = tol2;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const arr = buckets.get(bkey(bx + dx, by + dy, bz + dz)); if (!arr) continue;
        for (const j of arr) {
          if (j === i) continue;
          const ddx = cen[j * 3] - mx, ddy = cen[j * 3 + 1] - my, ddz = cen[j * 3 + 2] - mz;
          const d = ddx * ddx + ddy * ddy + ddz * ddz;
          if (d < bestD) { bestD = d; best = j; }
        }
      }
      map[i] = best;
    }
    mesh._mirror[axis] = map;
    return map;
  }

  global.Cleanup = {
    computeDominant,
    buildSubGraph,
    removeIslandsSub,
    fillRegion,
    selectRadius,
    selectBand,
    selectBandAxis,
    featureAxis,
    applyStates,
    subSizes,
    invalidateSub,
    selectColorRegion,
    mirrorMap,
  };
})(window);
