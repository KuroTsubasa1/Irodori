/* meshgeo.js — pure mesh geometry utilities for solid construction: cached
 * bounds, directed closed-surface check, Möller triangle–triangle test, a
 * uniform face grid and a grid-marched ray cast. Depends on nothing. */
(function (global) {
  "use strict";

  // Axis-aligned bounds of mesh.positions, cached as mesh._bbox (cleared by
  // Cleanup.invalidateSub alongside the other mesh caches).
  function meshBounds(mesh) {
    if (mesh._bbox) return mesh._bbox;
    const P = mesh.positions;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) {
      for (let k = 0; k < 3; k++) { const v = P[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
    }
    if (!isFinite(min[0])) { min[0] = min[1] = min[2] = 0; max[0] = max[1] = max[2] = 0; }
    const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    return (mesh._bbox = { min, max, diag });
  }

  // Number of undirected edges NOT traversed exactly once in each direction.
  // 0 <=> closed and consistently oriented (the "directed watertight" test).
  function checkClosed(mesh) {
    const NV = mesh.positions.length / 3;
    const dir = new Map(); // directed key -> count
    const add = (u, v) => { const k = u * NV + v; dir.set(k, (dir.get(k) || 0) + 1); };
    for (let f = 0; f < mesh.nf; f++) {
      const a = mesh.v1[f], b = mesh.v2[f], c = mesh.v3[f];
      add(a, b); add(b, c); add(c, a);
    }
    let bad = 0;
    const seen = new Set();
    for (const k of dir.keys()) {
      const u = Math.floor(k / NV), v = k - u * NV;
      const uk = u < v ? k : v * NV + u;
      if (seen.has(uk)) continue;
      seen.add(uk);
      if ((dir.get(u * NV + v) || 0) !== 1 || (dir.get(v * NV + u) || 0) !== 1) bad++;
    }
    return bad;
  }

  // Möller 1997 "NoDivTriTriIsect" with the epsilon test. Coplanar -> false
  // (we never need coplanar overlap for self-intersection screening).
  const EPS = 1e-9;
  function triTriIntersect(V0, V1, V2, U0, U1, U2) {
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const N1 = cross(sub(V1, V0), sub(V2, V0));
    const d1 = -dot(N1, V0);
    let du0 = dot(N1, U0) + d1, du1 = dot(N1, U1) + d1, du2 = dot(N1, U2) + d1;
    if (Math.abs(du0) < EPS) du0 = 0; if (Math.abs(du1) < EPS) du1 = 0; if (Math.abs(du2) < EPS) du2 = 0;
    const du0du1 = du0 * du1, du0du2 = du0 * du2;
    if (du0du1 > 0 && du0du2 > 0) return false;
    const N2 = cross(sub(U1, U0), sub(U2, U0));
    const d2 = -dot(N2, U0);
    let dv0 = dot(N2, V0) + d2, dv1 = dot(N2, V1) + d2, dv2 = dot(N2, V2) + d2;
    if (Math.abs(dv0) < EPS) dv0 = 0; if (Math.abs(dv1) < EPS) dv1 = 0; if (Math.abs(dv2) < EPS) dv2 = 0;
    const dv0dv1 = dv0 * dv1, dv0dv2 = dv0 * dv2;
    if (dv0dv1 > 0 && dv0dv2 > 0) return false;
    const D = cross(N1, N2);
    let idx = 0, mx = Math.abs(D[0]);
    if (Math.abs(D[1]) > mx) { mx = Math.abs(D[1]); idx = 1; }
    if (Math.abs(D[2]) > mx) idx = 2;
    const vp0 = V0[idx], vp1 = V1[idx], vp2 = V2[idx];
    const up0 = U0[idx], up1 = U1[idx], up2 = U2[idx];
    // returns [A, B, C, X0, X1] or null when coplanar
    const intervals = (VV0, VV1, VV2, D0, D1, D2, D0D1, D0D2) => {
      if (D0D1 > 0) return [VV2, (VV0 - VV2) * D2, (VV1 - VV2) * D2, D2 - D0, D2 - D1];
      if (D0D2 > 0) return [VV1, (VV0 - VV1) * D1, (VV2 - VV1) * D1, D1 - D0, D1 - D2];
      if (D1 * D2 > 0 || D0 !== 0) return [VV0, (VV1 - VV0) * D0, (VV2 - VV0) * D0, D0 - D1, D0 - D2];
      if (D1 !== 0) return [VV1, (VV0 - VV1) * D1, (VV2 - VV1) * D1, D1 - D0, D1 - D2];
      if (D2 !== 0) return [VV2, (VV0 - VV2) * D2, (VV1 - VV2) * D2, D2 - D0, D2 - D1];
      return null;
    };
    const I1 = intervals(vp0, vp1, vp2, dv0, dv1, dv2, dv0dv1, dv0dv2);
    const I2 = intervals(up0, up1, up2, du0, du1, du2, du0du1, du0du2);
    if (!I1 || !I2) return false;
    const [a, b, c, x0, x1] = I1, [d, e, f, y0, y1] = I2;
    const xx = x0 * x1, yy = y0 * y1, xxyy = xx * yy;
    let tmp = a * xxyy;
    let i10 = tmp + b * x1 * yy, i11 = tmp + c * x0 * yy;
    tmp = d * xxyy;
    let i20 = tmp + e * xx * y1, i21 = tmp + f * xx * y0;
    if (i10 > i11) { const s = i10; i10 = i11; i11 = s; }
    if (i20 > i21) { const s = i20; i20 = i21; i21 = s; }
    return !(i11 < i20 || i21 < i10);
  }

  // Uniform grid over face AABBs (CSR), cached as mesh._grid.
  function faceGrid(mesh) {
    if (mesh._grid) return mesh._grid;
    const b = meshBounds(mesh);
    const P = mesh.positions, nf = mesh.nf;
    const n = Math.max(8, Math.min(64, Math.round(Math.cbrt(nf))));
    const cell = [0, 1, 2].map((k) => ((b.max[k] - b.min[k]) || 1e-9) / n);
    const ci = (x, k) => Math.max(0, Math.min(n - 1, Math.floor((x - b.min[k]) / cell[k])));
    const lo = new Int32Array(nf * 3), hi = new Int32Array(nf * 3);
    const count = new Int32Array(n * n * n);
    for (let f = 0; f < nf; f++) {
      const a = mesh.v1[f] * 3, b2 = mesh.v2[f] * 3, c = mesh.v3[f] * 3;
      for (let k = 0; k < 3; k++) {
        const x0 = P[a + k], x1 = P[b2 + k], x2 = P[c + k];
        lo[f * 3 + k] = ci(Math.min(x0, x1, x2), k); hi[f * 3 + k] = ci(Math.max(x0, x1, x2), k);
      }
      for (let x = lo[f * 3]; x <= hi[f * 3]; x++) for (let y = lo[f * 3 + 1]; y <= hi[f * 3 + 1]; y++)
        for (let z = lo[f * 3 + 2]; z <= hi[f * 3 + 2]; z++) count[(x * n + y) * n + z]++;
    }
    const start = new Int32Array(n * n * n + 1);
    for (let i = 0; i < count.length; i++) start[i + 1] = start[i] + count[i];
    const list = new Int32Array(start[count.length]);
    const cur = start.slice(0, count.length);
    for (let f = 0; f < nf; f++) {
      for (let x = lo[f * 3]; x <= hi[f * 3]; x++) for (let y = lo[f * 3 + 1]; y <= hi[f * 3 + 1]; y++)
        for (let z = lo[f * 3 + 2]; z <= hi[f * 3 + 2]; z++) list[cur[(x * n + y) * n + z]++] = f;
    }
    return (mesh._grid = { n, min: b.min, max: b.max, cell, start, list, stamp: new Int32Array(nf), stampId: 0 });
  }

  // Möller–Trumbore; returns t or Infinity. backOnly: require dot(dir, e1×e2) > 0.
  function rayTri(P, mesh, f, ox, oy, oz, dx, dy, dz, tMin, backOnly) {
    const a = mesh.v1[f] * 3, b = mesh.v2[f] * 3, c = mesh.v3[f] * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) return Infinity;
    if (backOnly && det >= 0) return Infinity; // det = dir·(e1×e2) < 0 means front-facing... see note
    const inv = 1 / det;
    const tx = ox - P[a], ty = oy - P[a + 1], tz = oz - P[a + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) return Infinity;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) return Infinity;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return t > tMin ? t : Infinity;
  }
  // NOTE on the sign: det = (dir × e2)·e1 = dir·(e2 × e1) = −dir·(e1 × e2). A back-face
  // hit (dir along the outward normal e1×e2) therefore has det < 0.

  // March the grid along the ray; first accepted hit.
  function rayHit(mesh, grid, ox, oy, oz, dx, dy, dz, tMin, backOnly) {
    const P = mesh.positions;
    const { n, min, max, cell, start, list, stamp } = grid;
    const sid = ++grid.stampId;
    // clip the ray to the grid box
    let t0 = 0, t1 = Infinity;
    const o = [ox, oy, oz], d = [dx, dy, dz];
    for (let k = 0; k < 3; k++) {
      if (Math.abs(d[k]) < 1e-15) { if (o[k] < min[k] - 1e-9 || o[k] > max[k] + 1e-9) return Infinity; continue; }
      let ta = (min[k] - o[k]) / d[k], tb = (max[k] - o[k]) / d[k];
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
      if (t0 > t1) return Infinity;
    }
    const sx = ox + dx * t0, sy = oy + dy * t0, sz = oz + dz * t0;
    const cur = [0, 1, 2].map((k) => Math.max(0, Math.min(n - 1, Math.floor((([sx, sy, sz][k]) - min[k]) / cell[k]))));
    const step = d.map((v) => (v > 0 ? 1 : v < 0 ? -1 : 0));
    const tMax = [0, 1, 2].map((k) => step[k] === 0 ? Infinity : ((min[k] + (cur[k] + (step[k] > 0 ? 1 : 0)) * cell[k]) - o[k]) / d[k]);
    const tDelta = [0, 1, 2].map((k) => step[k] === 0 ? Infinity : cell[k] / Math.abs(d[k]));
    let best = Infinity;
    for (let guard = 0; guard < 3 * n + 3; guard++) {
      const c = (cur[0] * n + cur[1]) * n + cur[2];
      for (let i = start[c]; i < start[c + 1]; i++) {
        const f = list[i];
        if (stamp[f] === sid) continue;
        stamp[f] = sid;
        const t = rayTri(P, mesh, f, ox, oy, oz, dx, dy, dz, tMin, backOnly);
        if (t < best) best = t;
      }
      const k = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      if (best <= tMax[k]) break;
      cur[k] += step[k];
      if (cur[k] < 0 || cur[k] >= n) break;
      tMax[k] += tDelta[k];
    }
    return best;
  }

  // Signed volume of a closed mesh (positive when outward-wound).
  function signedVolume(mesh) {
    const P = mesh.positions; let v6 = 0;
    for (let f = 0; f < mesh.nf; f++) {
      const a = mesh.v1[f] * 3, b = mesh.v2[f] * 3, c = mesh.v3[f] * 3;
      v6 += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1])
          - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c])
          + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
    }
    return v6 / 6;
  }

  global.MeshGeo = { meshBounds, checkClosed, signedVolume, triTriIntersect, faceGrid, rayHit };
})(window);
