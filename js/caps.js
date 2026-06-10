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

  // --- 2D helpers (operate on [x,y] arrays) -------------------------------
  function signedArea2(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }
  function cross2(o, a, b) {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  }
  function pointInTri(p, a, b, c) {
    const d1 = cross2(a, b, p), d2 = cross2(b, c, p), d3 = cross2(c, a, p);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  }

  // Ear-clipping triangulation of a simple polygon (array of [x,y]).
  // Returns triangles as triples of indices into `poly`. CCW-normalised.
  function earClip2D(poly) {
    const n = poly.length;
    const V = [];
    for (let i = 0; i < n; i++) V.push(i);
    if (signedArea2(poly) < 0) V.reverse();
    const tris = [];
    let guard = 0;
    while (V.length > 3 && guard++ < 10 * n) {
      let clipped = false;
      for (let i = 0; i < V.length; i++) {
        const i0 = V[(i + V.length - 1) % V.length], i1 = V[i], i2 = V[(i + 1) % V.length];
        const a = poly[i0], b = poly[i1], c = poly[i2];
        if (cross2(a, b, c) <= 0) continue; // reflex / collinear
        let ear = true;
        for (const j of V) {
          if (j === i0 || j === i1 || j === i2) continue;
          if (pointInTri(poly[j], a, b, c)) { ear = false; break; }
        }
        if (!ear) continue;
        tris.push([i0, i1, i2]);
        V.splice(i, 1);
        clipped = true;
        break;
      }
      if (!clipped) break; // numerically stuck; bail with what we have
    }
    if (V.length === 3) tris.push([V[0], V[1], V[2]]);
    return tris;
  }

  // Triangulate boundary loops with one of: centroid | projected | earcut | cdt.
  // loops: array of vid-arrays. getPt(vid) -> [x,y,z]. Returns the cap descriptor
  // { verts, extraPts, tris } (see file header). earcut/cdt are added in Task 5.
  function triangulateLoops(loops, getPt, method) {
    const verts = [];
    const vIndex = new Map();
    const idxOf = (vid) => {
      let i = vIndex.get(vid);
      if (i === undefined) { i = verts.length; vIndex.set(vid, i); verts.push(vid); }
      return i;
    };
    for (const loop of loops) for (const v of loop) idxOf(v);
    const extraPts = [];
    const tris = [];

    if (method === "centroid") {
      for (const loop of loops) {
        let cx = 0, cy = 0, cz = 0;
        for (const v of loop) { const p = getPt(v); cx += p[0]; cy += p[1]; cz += p[2]; }
        cx /= loop.length; cy /= loop.length; cz /= loop.length;
        const cRef = verts.length + extraPts.length;
        extraPts.push([cx, cy, cz]);
        for (let i = 0; i < loop.length; i++) {
          tris.push([cRef, idxOf(loop[i]), idxOf(loop[(i + 1) % loop.length])]);
        }
      }
      return { verts, extraPts, tris };
    }

    if (method === "projected") {
      for (const loop of loops) {
        const pts3 = loop.map(getPt);
        const pl = bestFitPlane(pts3);
        const poly2 = pts3.map((p) => project(pl, p));
        for (const [a, b, c] of earClip2D(poly2)) {
          tris.push([idxOf(loop[a]), idxOf(loop[b]), idxOf(loop[c])]);
        }
      }
      return { verts, extraPts, tris };
    }

    throw new Error("Unknown cap method: " + method);
  }

  global.Caps = { extractLoops, bestFitPlane, project, triangulateLoops };
})(window);
