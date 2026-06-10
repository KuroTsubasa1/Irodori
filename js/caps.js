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

  global.Caps = { extractLoops };
})(window);
