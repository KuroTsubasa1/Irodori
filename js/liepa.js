/* liepa.js — Liepa-style hole filling: minimum-weight triangulation of a
 * boundary loop directly in 3-D (no plane projection), strip reattachment to
 * the full-resolution rim, density refinement, and Laplacian fairing.
 *
 * Liepa, "Filling Holes in Meshes", SGP 2003. v1 simplifications (see spec):
 * arclength decimation, cap-internal dihedral only, membrane fairing.
 *
 * fillLoop(loop, getPt, opts) -> { extraPts:[[x,y,z]], tris:[[i,j,k]] } with
 * loop-local indexing: i < loop.length -> the i-th loop vertex, otherwise
 * extraPts[i - loop.length]. Rim vertices are never moved.
 */
(function (global) {
  "use strict";

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  function triNormal(a, b, c) {
    const n = cross(sub(b, a), sub(c, a));
    const L = len(n) || 1;
    return [n[0] / L, n[1] / L, n[2] / L];
  }
  const triArea = (a, b, c) => 0.5 * len(cross(sub(b, a), sub(c, a)));
  // dihedral measure between two triangles sharing an edge: angle between
  // normals in [0, PI]; 0 = coplanar, larger = sharper fold.
  function dihedral(n1, n2) {
    return Math.acos(Math.max(-1, Math.min(1, dot(n1, n2))));
  }

  /* Minimum-weight triangulation of a 3-D polygon (Barequet–Sharir DP with
   * Liepa's lexicographic weight: minimize max internal dihedral, then area).
   * pts: [[x,y,z]] in polygon order. Returns triangles as index triples,
   * wound with the polygon's orientation. O(n^3); keep n <= ~200. */
  function dpFill(pts) {
    const n = pts.length;
    if (n < 3) return [];
    if (n === 3) return [[0, 1, 2]];
    // tables for sub-polygon (i..j): best (ang, area) and the chosen k
    const ang = [], area = [], pick = [], norm = [];
    for (let i = 0; i < n; i++) { ang.push(new Float64Array(n)); area.push(new Float64Array(n)); pick.push(new Int32Array(n).fill(-1)); norm.push(new Array(n).fill(null)); }
    // norm[i][j] = normal of the triangle adjacent to edge (i,j) in the best
    // sub-solution (null for rim-adjacent edges j === i+1 — no internal dihedral, v1)
    const EPS = 1e-12;
    for (let gap = 2; gap < n; gap++) {
      for (let i = 0; i + gap < n; i++) {
        const j = i + gap;
        let bestAng = Infinity, bestArea = Infinity, bestK = -1, bestN = null;
        for (let k = i + 1; k < j; k++) {
          const nk = triNormal(pts[i], pts[k], pts[j]);
          let a = 0;
          if (k > i + 1) a = Math.max(a, ang[i][k], dihedral(nk, norm[i][k]));
          if (j > k + 1) a = Math.max(a, ang[k][j], dihedral(nk, norm[k][j]));
          const ar = triArea(pts[i], pts[k], pts[j]) + (k > i + 1 ? area[i][k] : 0) + (j > k + 1 ? area[k][j] : 0);
          if (a < bestAng - EPS || (Math.abs(a - bestAng) <= EPS && ar < bestArea)) {
            bestAng = a; bestArea = ar; bestK = k; bestN = nk;
          }
        }
        ang[i][j] = bestAng; area[i][j] = bestArea; pick[i][j] = bestK; norm[i][j] = bestN;
      }
    }
    const tris = [];
    (function emit(i, j) {
      if (j <= i + 1) return;
      const k = pick[i][j];
      emit(i, k);
      tris.push([i, k, j]);
      emit(k, j);
    })(0, n - 1);
    return tris;
  }

  /* Pick <= maxCoarse rim vertices by accumulated chord length (always keeps
   * index 0). pts: full-resolution rim points in order. Returns ascending
   * indices into pts. */
  function decimate(pts, maxCoarse) {
    const n = pts.length;
    if (n <= maxCoarse) return [...Array(n).keys()];
    let total = 0;
    for (let i = 0; i < n; i++) total += dist(pts[i], pts[(i + 1) % n]);
    const step = total / maxCoarse;
    const idx = [0];
    let acc = 0;
    for (let i = 0; i < n - 1; i++) {
      acc += dist(pts[i], pts[i + 1]);
      if (acc >= step && idx[idx.length - 1] !== i + 1) { idx.push(i + 1); acc -= step; }
    }
    return idx;
  }

  function refine(P, n, extraPts, tris) {} // Task 3
  function fair(P, n, extraPts, tris) {}   // Task 4

  /* Fill one boundary loop: decimate -> DP cap on the coarse polygon -> DP on
   * each fine strip -> (Task 3) refine -> (Task 4) fair. Returns
   * { extraPts, tris } in loop-local indexing. opts: { maxCoarse=200,
   * refine=true, fair=true }. */
  function fillLoop(loop, getPt, opts) {
    opts = opts || {};
    const maxCoarse = opts.maxCoarse || 200;
    const n = loop.length;
    if (n < 3) return { extraPts: [], tris: [] };
    const P = loop.map(getPt);
    const coarse = decimate(P, maxCoarse);
    // coarse cap (indices into `coarse` -> map back to loop indices)
    const coarsePts = coarse.map((i) => P[i]);
    const tris = dpFill(coarsePts).map((t) => t.map((c) => coarse[c]));
    // strips: reattach the skipped fine chain under each coarse edge with the
    // same DP (strip polygon = [a, fine..., b]; its (b,a) edge pairs with the
    // coarse cap's (a,b) edge in the opposite direction — one oriented patch)
    const m = coarse.length;
    for (let t = 0; t < m; t++) {
      const a = coarse[t], b = coarse[(t + 1) % m];
      const chain = [];
      for (let i = (a + 1) % n; i !== b; i = (i + 1) % n) chain.push(i);
      if (!chain.length) continue;
      const stripIdx = [a, ...chain, b];
      const stripTris = dpFill(stripIdx.map((i) => P[i]));
      for (const tri of stripTris) tris.push(tri.map((s) => stripIdx[s]));
    }
    const extraPts = [];
    if (opts.refine !== false) refine(P, n, extraPts, tris);
    if (opts.fair !== false) fair(P, n, extraPts, tris);
    return { extraPts, tris };
  }

  global.Liepa = { dpFill, decimate, fillLoop };
})(window);
