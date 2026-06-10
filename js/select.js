/* select.js — read-only selections over the sub-triangle graph: radius/band/
 * same-color floods, the ring feature axis, and mirror/symmetry queries.
 *
 * Part of the `Cleanup` namespace (loads after subgraph.js). Cross-file calls
 * (buildSubGraph) go through the shared namespace at call time.
 */
(function (global) {
  "use strict";
  const Cleanup = (global.Cleanup = global.Cleanup || {});

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
    const g = Cleanup.buildSubGraph(mesh);
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
    const g = Cleanup.buildSubGraph(mesh);
    const cen = g.cen;
    const h0 = cen[seedSub * 3 + axis];
    const inBand = (i) => Math.abs(cen[i * 3 + axis] - h0) <= half;
    return floodAccept(g, seedSub, inBand);
  }

  // Estimate the local feature axis at a click via PCA of the surrounding patch
  // (within Euclidean radius Rn). The dominant eigenvector is the direction the
  // feature extends (the ear/tail/limb axis). Returns the axis, a ring center on
  // that axis at the click's cross-section, and a representative ring radius.
  // Optional nx,ny,nz: surface normal — axis is constrained to the plane ⊥ normal.
  function featureAxis(mesh, seedSub, Rn, nx, ny, nz) {
    const g = Cleanup.buildSubGraph(mesh);
    const { start, list, cen, NS } = g;
    const sx = cen[seedSub * 3], sy = cen[seedSub * 3 + 1], sz = cen[seedSub * 3 + 2];
    const Rn2 = Rn * Rn;

    // Constrain an axis to the plane perpendicular to the surface normal (the
    // ring's wrap plane contains the normal). No-op when no normal is given.
    const ortho = (x, y, z) => {
      if (nx === undefined) return [x, y, z];
      const d = x * nx + y * ny + z * nz;
      let ox = x - d * nx, oy = y - d * ny, oz = z - d * nz;
      let L = Math.hypot(ox, oy, oz);
      if (L < 1e-6) { // axis ∥ normal: pick any perpendicular
        ox = ny; oy = -nx; oz = 0;            // n × (0,0,1)
        L = Math.hypot(ox, oy, oz);
        if (L < 1e-6) { ox = 0; oy = nz; oz = -ny; L = Math.hypot(ox, oy, oz); } // n × (1,0,0)
      }
      return [ox / L, oy / L, oz / L];
    };

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
    if (n < 8) { const [eax, eay, eaz] = ortho(0, 0, 1); return { ax: eax, ay: eay, az: eaz, cx: sx, cy: sy, cz: sz, radius: Rn * 0.5 }; }
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
      const nx2 = cxx * vx + cxy * vy + cxz * vz;
      const ny2 = cxy * vx + cyy * vy + cyz * vz;
      const nz2 = cxz * vx + cyz * vy + czz * vz;
      const len = Math.hypot(nx2, ny2, nz2) || 1;
      vx = nx2 / len; vy = ny2 / len; vz = nz2 / len;
    }
    // Orthogonalize axis against the surface normal so the ring wraps the surface.
    const [oax, oay, oaz] = ortho(vx, vy, vz); vx = oax; vy = oay; vz = oaz;
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
    const g = Cleanup.buildSubGraph(mesh);
    const cen = g.cen;
    const sx = cen[seedSub * 3], sy = cen[seedSub * 3 + 1], sz = cen[seedSub * 3 + 2];
    const inBand = (i) => {
      const dx = cen[i * 3] - sx, dy = cen[i * 3 + 1] - sy, dz = cen[i * 3 + 2] - sz;
      return Math.abs(dx * ax + dy * ay + dz * az) <= half;
    };
    return floodAccept(g, seedSub, inBand);
  }

  // Flood the connected same-color region containing seedSub. Returns the
  // member sub-triangle indices (Int32Array).
  // Optional `exclude` Set: sub-triangle indices that are never flooded into.
  function selectColorRegion(mesh, seedSub, exclude) {
    const g = Cleanup.buildSubGraph(mesh);
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
    const g = Cleanup.buildSubGraph(mesh);
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

  // Per-axis center of the sub-triangle centroid bounds — the SAME centers
  // mirrorMap uses, so live mirror previews and stamp reflection agree.
  function axisCenters(mesh) {
    if (mesh._axisCenters) return mesh._axisCenters;
    const g = Cleanup.buildSubGraph(mesh);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < g.NS; i++) for (let a = 0; a < 3; a++) {
      const v = g.cen[i * 3 + a];
      if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v;
    }
    mesh._axisCenters = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    return mesh._axisCenters;
  }

  // Expand a stamp list across the enabled mirror axes (0=x,1=y,2=z): each
  // enabled axis doubles the list with copies reflected about that axis center,
  // yielding all 2^k combinations.
  function mirrorStamps(mesh, stamps, axes) {
    if (!axes || !axes.length) return stamps;
    const c = axisCenters(mesh);
    const keys = ["x", "y", "z"];
    let out = stamps.slice();
    for (const a of axes) {
      const add = out.map((s) => {
        const m = { x: s.x, y: s.y, z: s.z, r: s.r };
        m[keys[a]] = 2 * c[a] - m[keys[a]];
        return m;
      });
      out = out.concat(add);
    }
    return out;
  }

  Object.assign(Cleanup, {
    selectRadius,
    selectBand,
    selectBandAxis,
    selectColorRegion,
    featureAxis,
    mirrorMap,
    axisCenters,
    mirrorStamps,
  });
})(window);
