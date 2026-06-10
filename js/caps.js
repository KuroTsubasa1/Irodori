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

    // Centroid fan over a single loop (also the degenerate fallback below): adds
    // the loop's centroid as an interior point and fans to it. Always yields a
    // watertight cap (each loop edge used once) for any loop with >= 3 vids.
    const emitCentroidFan = (loopVids) => {
      let cx = 0, cy = 0, cz = 0;
      for (const v of loopVids) { const p = getPt(v); cx += p[0]; cy += p[1]; cz += p[2]; }
      const n = loopVids.length;
      cx /= n; cy /= n; cz /= n;
      const cRef = verts.length + extraPts.length;
      extraPts.push([cx, cy, cz]);
      for (let i = 0; i < n; i++) tris.push([cRef, idxOf(loopVids[i]), idxOf(loopVids[(i + 1) % n])]);
    };

    if (method === "centroid") {
      for (const loop of loops) emitCentroidFan(loop);
      return { verts, extraPts, tris };
    }

    if (method === "projected") {
      for (const loop of loops) {
        const pts3 = loop.map(getPt);
        const pl = bestFitPlane(pts3);
        const poly2 = pts3.map((p) => project(pl, p));
        const before = tris.length;
        for (const [a, b, c] of earClip2D(poly2)) {
          tris.push([idxOf(loop[a]), idxOf(loop[b]), idxOf(loop[c])]);
        }
        if (tris.length === before) emitCentroidFan(loop); // degenerate -> guarantee a cap
      }
      return { verts, extraPts, tris };
    }

    // --- earcut / cdt: per-loop planes; classify outer+holes in the outer's own frame ---
    // each loop -> its own best-fit plane (a concatenated-loops plane is unsound:
    // opposite-winding rims cancel Newell's normal), own-plane CCW projection, area,
    // and 3-D centroid (for classification in another loop's frame)
    const L = loops.map((loop) => {
      const pts3 = loop.map(getPt);
      const lpl = bestFitPlane(pts3);
      let poly2 = pts3.map((p) => project(lpl, p));
      let vids = loop.slice();
      if (signedArea2(poly2) < 0) { poly2 = poly2.slice().reverse(); vids = vids.slice().reverse(); }
      const c3 = [0, 0, 0];
      for (const p of pts3) { c3[0] += p[0]; c3[1] += p[1]; c3[2] += p[2]; }
      c3[0] /= pts3.length; c3[1] /= pts3.length; c3[2] /= pts3.length;
      return { vids, pts3, pl: lpl, poly2, area: Math.abs(signedArea2(poly2)), c3 };
    });
    // group: largest-area loop is the outer; loops whose centroid lies inside it
    // are holes; any loop not inside becomes its own independent outer (no holes).
    const inPoly = (pt, poly) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a[1] > pt[1]) !== (b[1] > pt[1]) &&
            pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1] || 1e-12) + a[0]) inside = !inside;
      }
      return inside;
    };
    // One nesting level only: outer + its holes. A loop nested inside a hole (an
    // "island") is treated as a sibling hole (documented limitation; deeper
    // co-planar nesting is rare for paint-region cuts).
    // A loop only counts as a hole of an outer if it is near-coplanar with it;
    // loops far apart along the plane normal (a band's two end-rings, which
    // project on top of each other) are capped independently instead.
    const COPLANAR_FRAC = 0.25;
    const order = L.map((_, i) => i).sort((a, b) => L[b].area - L[a].area);
    const used = new Set();
    const groups = []; // { outer:index, holes:index[] }
    for (const oi of order) {
      if (used.has(oi)) continue;
      used.add(oi);
      const holes = [];
      for (const hi of order) {
        if (used.has(hi)) continue;
        const O = L[oi], H = L[hi];
        const offN = Math.abs((H.c3[0] - O.pl.ox) * O.pl.nx + (H.c3[1] - O.pl.oy) * O.pl.ny + (H.c3[2] - O.pl.oz) * O.pl.nz);
        if (inPoly(project(O.pl, H.c3), O.poly2) && offN <= COPLANAR_FRAC * Math.sqrt(O.area)) {
          holes.push(hi); used.add(hi);
        }
      }
      groups.push({ outer: oi, holes });
    }

    const useCDT = method === "cdt";
    if (!useCDT && method !== "earcut") throw new Error("Unknown cap method: " + method);
    const P2T = global.poly2tri;
    const SU = global.THREE && global.THREE.ShapeUtils;
    if (useCDT && !(P2T && P2T.SweepContext)) throw new Error("poly2tri not loaded (CDT)");
    if (!(SU && SU.triangulateShape)) throw new Error("THREE.ShapeUtils not loaded (Earcut)");

    // Emit ear-clipped triangles for one outer+holes group (robust; also the CDT
    // fallback). THREE.ShapeUtils.triangulateShape returns index triples into the
    // concatenated [contour, ...holes] point list; map back to vids.
    const emitEarcut = (outer, holes) => {
      const V2 = (p) => (global.THREE.Vector2 ? new global.THREE.Vector2(p[0], p[1]) : { x: p[0], y: p[1] });
      const contour = outer.poly2.map(V2);
      const holeContours = holes.map((h) => h.poly2.map(V2));
      const flatVids = outer.vids.concat(...holes.map((h) => h.vids));
      for (const [a, b, c] of SU.triangulateShape(contour, holeContours)) {
        tris.push([idxOf(flatVids[a]), idxOf(flatVids[b]), idxOf(flatVids[c])]);
      }
    };

    for (const grp of groups) {
      const outer = L[grp.outer];
      // holes re-projected into the OUTER's plane (their own poly2 is in their own frame);
      // earcut/poly2tri normalize hole winding internally, so vid order stays as-is
      const holes = grp.holes.map((i) => ({ vids: L[i].vids, poly2: L[i].pts3.map((p) => project(outer.pl, p)) }));
      const before = tris.length;
      if (!useCDT) {
        emitEarcut(outer, holes);
      } else {
        // CDT path: poly2tri throws on duplicate/coincident points -> dedupe per loop.
        const EPS = 1e-7;
        const mkPts = (loopObj) => {
          const ptsOut = [];
          for (let k = 0; k < loopObj.poly2.length; k++) {
            const p = loopObj.poly2[k], prev = ptsOut.length ? ptsOut[ptsOut.length - 1] : null;
            if (prev && Math.abs(prev.x - p[0]) < EPS && Math.abs(prev.y - p[1]) < EPS) continue;
            const pt = new P2T.Point(p[0], p[1]); pt._vid = loopObj.vids[k]; ptsOut.push(pt);
          }
          if (ptsOut.length > 1) {
            const a = ptsOut[0], b = ptsOut[ptsOut.length - 1];
            if (Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS) ptsOut.pop();
          }
          return ptsOut;
        };
        const outerPts = mkPts(outer);
        if (outerPts.length >= 3) {
          try {
            const ctx = new P2T.SweepContext(outerPts);
            for (const h of holes) { const hp = mkPts(h); if (hp.length >= 3) ctx.addHole(hp); }
            ctx.triangulate();
            for (const t of ctx.getTriangles()) {
              tris.push([idxOf(t.getPoint(0)._vid), idxOf(t.getPoint(1)._vid), idxOf(t.getPoint(2)._vid)]);
            }
          } catch (e) {
            emitEarcut(outer, holes); // collinear / boundary-touching -> robust earcut
          }
        } else {
          emitEarcut(outer, holes); // degenerate after dedupe -> try earcut
        }
      }
      // Guarantee a watertight cap: if nothing was emitted for this group
      // (fully degenerate/collinear loop), fall back to a centroid fan.
      if (tris.length === before) emitCentroidFan(outer.vids);
    }
    return { verts, extraPts, tris };
  }

  global.Caps = { extractLoops, bestFitPlane, project, triangulateLoops };
})(window);
