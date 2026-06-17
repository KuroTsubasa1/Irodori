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

  // circumcenter of a 3-D triangle (in its own plane) and circumradius
  function circumsphere(a, b, c) {
    const ab = sub(b, a), ac = sub(c, a);
    const abXac = cross(ab, ac);
    const d = 2 * dot(abXac, abXac);
    if (d < 1e-20) return null; // degenerate
    const t1 = cross(abXac, ab), t2 = cross(ac, abXac);
    const l1 = dot(ac, ac), l2 = dot(ab, ab);
    const off = [(t2[0] * l1 + t1[0] * l2) / d, (t2[1] * l1 + t1[1] * l2) / d, (t2[2] * l1 + t1[2] * l2) / d];
    const cc = [a[0] + off[0], a[1] + off[1], a[2] + off[2]];
    return { cc, r: dist(cc, a) };
  }

  /* Liepa refinement: split triangles whose centroid is far (vs the local
   * scale sigma) from all corners, then relax INTERIOR edges by the
   * empty-circumsphere test. Mutates extraPts/tris in place. P = rim points
   * (frozen); vertex i >= n reads extraPts[i - n].
   *
   * sigmaFloor/maxTris bound the density: fractal paint rims have edge scales
   * ~100x smaller than the opening, so targeting raw rim density would demand
   * millions of triangles (real-data finding). The floor is the edge length
   * that tiles the cap's own area in <= maxTris equilateral triangles. */
  function refine(P, n, extraPts, tris, sigmaFloor, maxTris) {
    const pos = (i) => (i < n ? P[i] : extraPts[i - n]);
    sigmaFloor = sigmaFloor || 0;
    maxTris = maxTris || 3000;
    // sigma: rim verts = mean of their two rim edge lengths (floored); inserted = corner mean
    const sigma = new Map();
    for (let i = 0; i < n; i++) {
      const local = (dist(P[i], P[(i + 1) % n]) + dist(P[i], P[(i - 1 + n) % n])) / 2;
      sigma.set(i, Math.max(local, sigmaFloor));
    }
    const isRimEdge = (u, v) => u < n && v < n && ((v - u + n) % n === 1 || (u - v + n) % n === 1);
    const SQRT2 = Math.SQRT2;

    for (let pass = 0; pass < 10; pass++) {
      // --- split pass (snapshot the length: children are reconsidered next pass) ---
      let split = 0;
      const end = tris.length;
      for (let t = 0; t < end && tris.length + 2 <= maxTris; t++) {
        const [a, b, c] = tris[t];
        const pa = pos(a), pb = pos(b), pc = pos(c);
        const m = [(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3, (pa[2] + pb[2] + pc[2]) / 3];
        const sm = (sigma.get(a) + sigma.get(b) + sigma.get(c)) / 3;
        const ok = [a, b, c].every((v) => {
          const d = SQRT2 * dist(m, pos(v));
          return d > sm && d > sigma.get(v);
        });
        if (!ok) continue;
        const mi = n + extraPts.length;
        extraPts.push(m);
        sigma.set(mi, Math.max(sm, sigmaFloor));
        tris[t] = [a, b, mi];
        tris.push([b, c, mi], [c, a, mi]);
        split++;
      }
      // --- flip relaxation (interior edges only): sweeps over a per-sweep edge
      // map with a staleness guard, so one map build serves many flips ---
      let flipped = 0;
      const ek = (u, v) => (u < v ? u + "_" + v : v + "_" + u);
      for (let sweep = 0; sweep < 5; sweep++) {
        const edgeTris = new Map(); // "u_v" (sorted) -> [triIndex...]
        tris.forEach((t, ti) => { for (const [u, v] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) { const k = ek(u, v); let a = edgeTris.get(k); if (!a) edgeTris.set(k, (a = [])); a.push(ti); } });
        const liveEdges = new Set(edgeTris.keys());
        let sweepFlips = 0;
        for (const [k, owners] of edgeTris) {
          if (owners.length !== 2) continue;
          const [u, v] = k.split("_").map(Number);
          if (isRimEdge(u, v)) continue;
          const [t1, t2] = owners;
          // staleness guard: an earlier flip this sweep may have retired this edge
          const has = (tri) => tri.includes(u) && tri.includes(v);
          if (!has(tris[t1]) || !has(tris[t2])) continue;
          const o1 = tris[t1].find((x) => x !== u && x !== v);
          const o2 = tris[t2].find((x) => x !== u && x !== v);
          if (o1 === undefined || o2 === undefined || o1 === o2) continue;
          if (isRimEdge(o1, o2)) continue; // don't flip onto a rim edge
          if (liveEdges.has(ek(o1, o2))) continue; // flip target edge already exists
          const cs = circumsphere(pos(u), pos(v), pos(o1));
          if (!cs || dist(pos(o2), cs.cc) >= cs.r - 1e-9) continue;
          // flip (u,v) -> (o1,o2). u < v comes from the sorted edge key, NOT from
          // the triangle's winding — check which direction t1 actually holds the
          // edge in, or ~a third of flipped triangles come out inverted.
          let uToV = false;
          for (let i = 0; i < 3; i++) {
            if (tris[t1][i] === u && tris[t1][(i + 1) % 3] === v) { uToV = true; break; }
          }
          if (uToV) { tris[t1] = [u, o2, o1]; tris[t2] = [v, o1, o2]; }
          else { tris[t1] = [u, o1, o2]; tris[t2] = [v, o2, o1]; }
          liveEdges.delete(k);
          liveEdges.add(ek(o1, o2));
          sweepFlips++;
        }
        flipped += sweepFlips;
        if (!sweepFlips) break;
      }
      if (!split && !flipped) break;
    }
  }

  /* Membrane fairing: Jacobi umbrella iterations on the interior points (the
   * rim is pinned), lambda 0.5, until max displacement < 1e-3 x mean rim edge
   * or 300 iterations. Converges to the harmonic ("soap film") patch. */
  function fair(P, n, extraPts, tris) {
    const nx = extraPts.length;
    if (!nx) return;
    const pos = (i) => (i < n ? P[i] : extraPts[i - n]);
    const nbrs = new Array(nx).fill(null).map(() => new Set());
    for (const [a, b, c] of tris) {
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        if (u >= n) nbrs[u - n].add(v);
        if (v >= n) nbrs[v - n].add(u);
      }
    }
    let meanRim = 0;
    for (let i = 0; i < n; i++) meanRim += dist(P[i], P[(i + 1) % n]);
    meanRim /= n;
    const stop = 1e-3 * meanRim;
    const LAMBDA = 0.5;
    for (let it = 0; it < 300; it++) {
      let maxMove = 0;
      const next = new Array(nx);
      for (let i = 0; i < nx; i++) {
        const cur = extraPts[i];
        let mx = 0, my = 0, mz = 0, c = 0;
        for (const v of nbrs[i]) { const p = pos(v); mx += p[0]; my += p[1]; mz += p[2]; c++; }
        if (!c) { next[i] = cur; continue; }
        mx /= c; my /= c; mz /= c;
        const np = [cur[0] + LAMBDA * (mx - cur[0]), cur[1] + LAMBDA * (my - cur[1]), cur[2] + LAMBDA * (mz - cur[2])];
        maxMove = Math.max(maxMove, dist(np, cur));
        next[i] = np;
      }
      for (let i = 0; i < nx; i++) extraPts[i] = next[i];
      if (maxMove < stop) break;
    }
  }

  /* Fill one boundary loop: decimate -> DP cap on the coarse polygon -> DP on
   * each fine strip -> (Task 3) refine -> (Task 4) fair. Returns
   * { extraPts, tris } in loop-local indexing. opts: { maxCoarse=200,
   * refine=true, fair=true }. */
  function fillLoop(loop, getPt, opts) {
    opts = opts || {};
    const maxCoarse = opts.maxCoarse || 120;
    const n = loop.length;
    if (n < 3) return { extraPts: [], tris: [] };
    const P = loop.map(getPt);
    const coarse = decimate(P, maxCoarse);
    // coarse cap (indices into `coarse` -> map back to loop indices)
    const coarsePts = coarse.map((i) => P[i]);
    const tris = dpFill(coarsePts).map((t) => t.map((c) => coarse[c]));
    // strips: reattach the skipped fine chain under each coarse edge with a fan
    // from the chord endpoint `a` (its (b,a) edge pairs with the coarse cap's
    // (a,b) edge in the opposite direction — one oriented patch). A fan, not a
    // polygon triangulation: fractal chains WEAVE across their chord, making
    // the strip polygon self-intersecting — any polygon triangulation of it
    // must fold. Fan folds only on the rarer bend-back-past-`a` condition,
    // confined to micro-slivers at the rim (sub-print scale; see spec).
    const m = coarse.length;
    for (let t = 0; t < m; t++) {
      const a = coarse[t], b = coarse[(t + 1) % m];
      const chain = [];
      for (let i = (a + 1) % n; i !== b; i = (i + 1) % n) chain.push(i);
      if (!chain.length) continue;
      const stripIdx = [a, ...chain, b];
      for (let j = 1; j < stripIdx.length - 1; j++) {
        tris.push([a, stripIdx[j], stripIdx[j + 1]]);
      }
    }
    const extraPts = [];
    if (opts.refine !== false) {
      // density floor: the edge length that tiles this cap's own area in
      // <= maxTris equilateral triangles (fractal rims would otherwise demand
      // millions of triangles — see refine's doc comment)
      const maxTris = opts.maxTris || 3000;
      let capArea = 0;
      for (const t of tris) capArea += triArea(P[t[0]], P[t[1]], P[t[2]]);
      const sigmaFloor = Math.sqrt((4 * capArea) / (Math.sqrt(3) * maxTris));
      refine(P, n, extraPts, tris, sigmaFloor, maxTris);
    }
    if (opts.fair !== false) fair(P, n, extraPts, tris);
    return { extraPts, tris };
  }

  global.Liepa = { dpFill, decimate, fillLoop };
})(window);
