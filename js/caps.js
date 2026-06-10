/* caps.js — boundary-loop extraction + cap triangulation for split solids.
 *
 * Pure geometry over coordinate arrays; no DOM. The Earcut method uses
 * THREE.ShapeUtils.triangulateShape (already in the vendored three.js) and CDT
 * uses poly2tri (vendored); both are read from the module global when needed.
 *
 * A cap is returned as { verts:number[], extraPts:number[][], tris:[[i,j,k]] }:
 *   index i <  verts.length  -> welded global vertex id verts[i]
 *   index i >= verts.length  -> extraPts[i - verts.length]  (model-space xyz)
 * Triangles are emitted with a consistent winding; the caller orients them.
 */
(function (global) {
  "use strict";

  // Chain directed boundary edges [u,v] (each in its owning triangle's order)
  // into ordered, oriented loops (open arrays of vertex ids; first not repeated).
  // Pinch vertices (a start with several outgoing edges) are walked greedily;
  // any chain that fails to close is dropped (documented limitation).
  function extractLoops(edges) {
    const byStart = new Map();
    for (const [u, v] of edges) {
      if (!byStart.has(u)) byStart.set(u, []);
      byStart.get(u).push(v);
    }
    const next = (u) => {
      const lst = byStart.get(u);
      return lst && lst.length ? lst.pop() : undefined;
    };
    const loops = [];
    for (const start of byStart.keys()) {
      while (byStart.get(start).length) {
        const loop = [start];
        let cur = next(start);
        while (cur !== undefined && cur !== start) {
          loop.push(cur);
          cur = next(cur);
        }
        if (cur === start && loop.length >= 3) loops.push(loop);
      }
    }
    return loops;
  }

  // Best-fit plane through pts (Newell's method — robust for non-planar loops).
  // Returns origin o, unit normal n, and an in-plane orthonormal basis (u, v).
  function bestFitPlane(pts) {
    const n = pts.length;
    let ox = 0, oy = 0, oz = 0;
    for (const p of pts) { ox += p[0]; oy += p[1]; oz += p[2]; }
    ox /= n; oy /= n; oz /= n;
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    let L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
    // an in-plane axis u = normalize(n × smallest-axis)
    let ux, uy, uz;
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    if (ax <= ay && ax <= az) { ux = 0; uy = -nz; uz = ny; }
    else if (ay <= az) { ux = -nz; uy = 0; uz = nx; }
    else { ux = -ny; uy = nx; uz = 0; }
    L = Math.hypot(ux, uy, uz) || 1;
    ux /= L; uy /= L; uz /= L;
    const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
    return { ox, oy, oz, nx, ny, nz, ux, uy, uz, vx, vy, vz };
  }

  // Project a model-space point onto the plane's (u, v) coordinates.
  function project(pl, p) {
    const dx = p[0] - pl.ox, dy = p[1] - pl.oy, dz = p[2] - pl.oz;
    return [dx * pl.ux + dy * pl.uy + dz * pl.uz, dx * pl.vx + dy * pl.vy + dz * pl.vz];
  }

  global.Caps = { extractLoops, bestFitPlane, project };
})(window);
