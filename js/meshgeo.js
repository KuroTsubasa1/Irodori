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
  // (Sorted directed-edge keys instead of a Map: ~10x faster on the ~1M-face
  // remainders of a real split.)
  function checkClosed(mesh) {
    const NV = mesh.positions.length / 3, nf = mesh.nf;
    const K = new Float64Array(nf * 3);
    for (let f = 0; f < nf; f++) {
      const a = mesh.v1[f], b = mesh.v2[f], c = mesh.v3[f];
      K[f * 3] = a * NV + b; K[f * 3 + 1] = b * NV + c; K[f * 3 + 2] = c * NV + a;
    }
    K.sort();
    const count = (k) => { // occurrences of key k (binary search)
      let lo = 0, hi = K.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (K[mid] < k) lo = mid + 1; else hi = mid; }
      let n = 0; while (lo + n < K.length && K[lo + n] === k) n++;
      return n;
    };
    let bad = 0;
    for (let i = 0; i < K.length;) {
      const k = K[i]; let c = 1;
      while (i + c < K.length && K[i + c] === k) c++;
      i += c;
      const u = Math.floor(k / NV), v = k - u * NV;
      const rc = count(v * NV + u);
      if (u === v) { if (c !== 1) bad++; }
      else if (u < v) { if (c !== 1 || rc !== 1) bad++; } // undirected edge counted from its u<v side…
      else if (rc === 0) bad++;                       // …or here when that side never occurs
    }
    return bad;
  }

  // Möller 1997 "NoDivTriTriIsect" with the epsilon test. Coplanar -> false
  // (we never need coplanar overlap for self-intersection screening).
  // The on-plane snap is SCALE-RELATIVE: a signed distance (in units of the
  // unnormalised normal) snaps to 0 only within REL_EPS of the pair's size.
  // An absolute 1e-9 on |N| ~ 1e-5 (0.005 mm triangles) snapped planes 3e-5 mm
  // apart and reported near-parallel, laterally SEPARATED neighbours as crossing.
  const REL_EPS = 1e-9;
  // Interval endpoints on the intersection line (NoDiv form) -> out[0..4];
  // false when the triangle lies in the other's plane (coplanar).
  function intervals(out, VV0, VV1, VV2, D0, D1, D2, D0D1, D0D2) {
    if (D0D1 > 0) { out[0] = VV2; out[1] = (VV0 - VV2) * D2; out[2] = (VV1 - VV2) * D2; out[3] = D2 - D0; out[4] = D2 - D1; }
    else if (D0D2 > 0) { out[0] = VV1; out[1] = (VV0 - VV1) * D1; out[2] = (VV2 - VV1) * D1; out[3] = D1 - D0; out[4] = D1 - D2; }
    else if (D1 * D2 > 0 || D0 !== 0) { out[0] = VV0; out[1] = (VV1 - VV0) * D0; out[2] = (VV2 - VV0) * D0; out[3] = D0 - D1; out[4] = D0 - D2; }
    else if (D1 !== 0) { out[0] = VV1; out[1] = (VV0 - VV1) * D1; out[2] = (VV2 - VV1) * D1; out[3] = D1 - D0; out[4] = D1 - D2; }
    else if (D2 !== 0) { out[0] = VV2; out[1] = (VV0 - VV2) * D2; out[2] = (VV1 - VV2) * D2; out[3] = D2 - D0; out[4] = D2 - D1; }
    else return false;
    return true;
  }
  const I1 = new Float64Array(5), I2 = new Float64Array(5);
  // Allocation-free core: triangle V = A[a..a+8], U = B[b..b+8] (xyz xyz xyz).
  function triTriFlat(A, a, B, b) {
    const v0x = A[a], v0y = A[a + 1], v0z = A[a + 2], v1x = A[a + 3], v1y = A[a + 4], v1z = A[a + 5], v2x = A[a + 6], v2y = A[a + 7], v2z = A[a + 8];
    const u0x = B[b], u0y = B[b + 1], u0z = B[b + 2], u1x = B[b + 3], u1y = B[b + 4], u1z = B[b + 5], u2x = B[b + 6], u2y = B[b + 7], u2z = B[b + 8];
    const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z, e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
    const f1x = u1x - u0x, f1y = u1y - u0y, f1z = u1z - u0z, f2x = u2x - u0x, f2y = u2y - u0y, f2z = u2z - u0z;
    const size = Math.sqrt(Math.max(e1x * e1x + e1y * e1y + e1z * e1z, e2x * e2x + e2y * e2y + e2z * e2z, f1x * f1x + f1y * f1y + f1z * f1z, f2x * f2x + f2y * f2y + f2z * f2z));
    const n1x = e1y * e2z - e1z * e2y, n1y = e1z * e2x - e1x * e2z, n1z = e1x * e2y - e1y * e2x;
    const d1 = -(n1x * v0x + n1y * v0y + n1z * v0z), eps1 = REL_EPS * Math.hypot(n1x, n1y, n1z) * size;
    let du0 = n1x * u0x + n1y * u0y + n1z * u0z + d1, du1 = n1x * u1x + n1y * u1y + n1z * u1z + d1, du2 = n1x * u2x + n1y * u2y + n1z * u2z + d1;
    if (Math.abs(du0) < eps1) du0 = 0; if (Math.abs(du1) < eps1) du1 = 0; if (Math.abs(du2) < eps1) du2 = 0;
    const du0du1 = du0 * du1, du0du2 = du0 * du2;
    if (du0du1 > 0 && du0du2 > 0) return false;
    const n2x = f1y * f2z - f1z * f2y, n2y = f1z * f2x - f1x * f2z, n2z = f1x * f2y - f1y * f2x;
    const d2 = -(n2x * u0x + n2y * u0y + n2z * u0z), eps2 = REL_EPS * Math.hypot(n2x, n2y, n2z) * size;
    let dv0 = n2x * v0x + n2y * v0y + n2z * v0z + d2, dv1 = n2x * v1x + n2y * v1y + n2z * v1z + d2, dv2 = n2x * v2x + n2y * v2y + n2z * v2z + d2;
    if (Math.abs(dv0) < eps2) dv0 = 0; if (Math.abs(dv1) < eps2) dv1 = 0; if (Math.abs(dv2) < eps2) dv2 = 0;
    const dv0dv1 = dv0 * dv1, dv0dv2 = dv0 * dv2;
    if (dv0dv1 > 0 && dv0dv2 > 0) return false;
    const Dx = Math.abs(n1y * n2z - n1z * n2y), Dy = Math.abs(n1z * n2x - n1x * n2z), Dz = Math.abs(n1x * n2y - n1y * n2x);
    const idx = Dx >= Dy && Dx >= Dz ? 0 : Dy >= Dz ? 1 : 2;
    if (!intervals(I1, A[a + idx], A[a + 3 + idx], A[a + 6 + idx], dv0, dv1, dv2, dv0dv1, dv0dv2)) return false;
    if (!intervals(I2, B[b + idx], B[b + 3 + idx], B[b + 6 + idx], du0, du1, du2, du0du1, du0du2)) return false;
    const x0 = I1[3], x1 = I1[4], y0 = I2[3], y1 = I2[4];
    const xx = x0 * x1, yy = y0 * y1, xxyy = xx * yy;
    let tmp = I1[0] * xxyy;
    let i10 = tmp + I1[1] * x1 * yy, i11 = tmp + I1[2] * x0 * yy;
    tmp = I2[0] * xxyy;
    let i20 = tmp + I2[1] * xx * y1, i21 = tmp + I2[2] * xx * y0;
    if (i10 > i11) { const s = i10; i10 = i11; i11 = s; }
    if (i20 > i21) { const s = i20; i20 = i21; i21 = s; }
    return !(i11 < i20 || i21 < i10);
  }
  const TA = new Float64Array(9), TB = new Float64Array(9);
  function triTriIntersect(V0, V1, V2, U0, U1, U2) {
    for (let k = 0; k < 3; k++) { TA[k] = V0[k]; TA[3 + k] = V1[k]; TA[6 + k] = V2[k]; TB[k] = U0[k]; TB[3 + k] = U1[k]; TB[6 + k] = U2[k]; }
    return triTriFlat(TA, 0, TB, 0);
  }

  // Does segment p→q pass through the INTERIOR of triangle abc (strictly
  // between its endpoints)? Segments (nearly) parallel to the triangle's plane
  // return false — coplanar contact is never counted, as in triTriIntersect.
  function segTriCross(p, q, a, b, c) {
    const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
    const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
    const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
    const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    if (Math.abs(det) <= 1e-9 * Math.hypot(dx, dy, dz) * Math.hypot(nx, ny, nz)) return false;
    const f = 1 / det, sx = p[0] - a[0], sy = p[1] - a[1], sz = p[2] - a[2];
    const u = f * (sx * hx + sy * hy + sz * hz);
    if (u <= 1e-9 || u >= 1 - 1e-9) return false;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = f * (dx * qx + dy * qy + dz * qz);
    if (v <= 1e-9 || u + v >= 1 - 1e-9) return false;
    const t = f * (e2x * qx + e2y * qy + e2z * qz);
    return t > 1e-9 && t < 1 - 1e-9;
  }

  // Points of the crossing between triangles V = A[a..a+8] and U = B[b..b+8]:
  // every edge of one meeting the other (closed, non-parallel), written as xyz
  // triples into out (room for 6 points). Returns the point count — for a
  // proper crossing these span the actual intersection segment.
  function crossPoints(A, a, B, b, out) {
    let n = 0;
    const edgesVs = (P, p, Q, q) => {
      const e1x = Q[q + 3] - Q[q], e1y = Q[q + 4] - Q[q + 1], e1z = Q[q + 5] - Q[q + 2];
      const e2x = Q[q + 6] - Q[q], e2y = Q[q + 7] - Q[q + 1], e2z = Q[q + 8] - Q[q + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const nn = nx * nx + ny * ny + nz * nz;
      if (!(nn > 0)) return;
      const d0 = -(nx * Q[q] + ny * Q[q + 1] + nz * Q[q + 2]);
      for (let k = 0; k < 3; k++) {
        const o0 = p + k * 3, o1 = p + ((k + 1) % 3) * 3;
        const s0 = nx * P[o0] + ny * P[o0 + 1] + nz * P[o0 + 2] + d0, s1 = nx * P[o1] + ny * P[o1 + 1] + nz * P[o1 + 2] + d0;
        if ((s0 > 0 && s1 > 0) || (s0 < 0 && s1 < 0) || s0 === s1) continue;
        const t = s0 / (s0 - s1);
        const x = P[o0] + (P[o1] - P[o0]) * t, y = P[o0 + 1] + (P[o1 + 1] - P[o0 + 1]) * t, z = P[o0 + 2] + (P[o1 + 2] - P[o0 + 2]) * t;
        // inside Q (barycentric, small tolerance)
        const wx = x - Q[q], wy = y - Q[q + 1], wz = z - Q[q + 2];
        const cx = e1y * wz - e1z * wy, cy = e1z * wx - e1x * wz, cz = e1x * wy - e1y * wx; // e1 x w
        const v = (cx * nx + cy * ny + cz * nz) / nn;
        const dx = wy * e2z - wz * e2y, dy = wz * e2x - wx * e2z, dz = wx * e2y - wy * e2x; // w x e2
        const u = (dx * nx + dy * ny + dz * nz) / nn;
        if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9 || n >= 6) continue;
        out[n * 3] = x; out[n * 3 + 1] = y; out[n * 3 + 2] = z; n++;
      }
    };
    edgesVs(A, a, B, b);
    edgesVs(B, b, A, a);
    return n;
  }

  // Edge-adjacent triangles (s0,s1,a) and (s0,s1,b) overlap beyond their
  // shared edge only when folded flat onto each other: coplanar, with a and b
  // on the same side of the edge.
  function foldedPair(s0, s1, a, b) {
    const ex = s1[0] - s0[0], ey = s1[1] - s0[1], ez = s1[2] - s0[2];
    const ax = a[0] - s0[0], ay = a[1] - s0[1], az = a[2] - s0[2], bx = b[0] - s0[0], by = b[1] - s0[1], bz = b[2] - s0[2];
    const nax = ey * az - ez * ay, nay = ez * ax - ex * az, naz = ex * ay - ey * ax;
    const nbx = ey * bz - ez * by, nby = ez * bx - ex * bz, nbz = ex * by - ey * bx;
    const la = Math.hypot(nax, nay, naz), lb = Math.hypot(nbx, nby, nbz);
    if (!(la > 0) || !(lb > 0)) return false;
    return (nax * nbx + nay * nby + naz * nbz) / (la * lb) > 1 - 1e-9;
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

  global.MeshGeo = { meshBounds, checkClosed, signedVolume, triTriIntersect, triTriFlat, crossPoints, segTriCross, foldedPair, faceGrid, rayHit };
})(window);
