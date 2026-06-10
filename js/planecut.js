/* planecut.js — true geometric plane cut: clip a mesh's triangles exactly at a
 * plane, weld the section deterministically, cap both sides with flat earcut
 * caps (winding ±n by construction), and return two watertight mesh-shaped
 * halves. Pure geometry; reads Paint (piece states) and THREE.ShapeUtils
 * (cap triangulation) from globals at call time.
 */
(function (global) {
  "use strict";

  // mesh: { positions, v1, v2, v3, nf, paints }; plane: { px,py,pz, nx,ny,nz }
  // (unit normal; "above" = signed distance >= 0). Returns { above, below },
  // each a mesh-shaped object or null when the plane misses that side.
  function cutMesh(mesh, plane) {
    const P = mesh.positions, NV = P.length / 3;
    const { px, py, pz, nx, ny, nz } = plane;
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) { const v = P[i + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
    const eps = 1e-6 * (Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1);

    // per-vertex snapped signed distance (vertex-global, so neighbors agree)
    const D = new Float64Array(NV);
    let anyPos = false, anyNeg = false;
    for (let i = 0; i < NV; i++) {
      let d = (P[i * 3] - px) * nx + (P[i * 3 + 1] - py) * ny + (P[i * 3 + 2] - pz) * nz;
      if (Math.abs(d) <= eps) d = 0;
      D[i] = d;
      if (d > 0) anyPos = true; else if (d < 0) anyNeg = true;
    }
    const clone = () => ({
      positions: mesh.positions.slice(), nf: mesh.nf,
      v1: Int32Array.from(mesh.v1), v2: Int32Array.from(mesh.v2), v3: Int32Array.from(mesh.v3),
      paints: mesh.paints.slice(),
    });
    if (!anyNeg) return { above: clone(), below: null };
    if (!anyPos) return { above: null, below: clone() };

    const mkSide = () => ({ x: [], y: [], z: [], v1: [], v2: [], v3: [], paints: [], orig: new Map(), sect: new Map() });
    const above = mkSide(), below = mkSide();
    const addOrig = (S, vid) => {
      let i = S.orig.get(vid);
      if (i === undefined) { i = S.x.length; S.orig.set(vid, i); S.x.push(P[vid * 3]); S.y.push(P[vid * 3 + 1]); S.z.push(P[vid * 3 + 2]); }
      return i;
    };
    // section points live in their own keyed space; "v<id>" keys route back to
    // the ORIGINAL vertex so caps weld to the surface at on-plane vertices
    const sectPts = new Map(); // key -> [x,y,z]
    const addSect = (S, key) => {
      if (key[0] === "v") return addOrig(S, +key.slice(1));
      let i = S.sect.get(key);
      if (i === undefined) { const p = sectPts.get(key); i = S.x.length; S.sect.set(key, i); S.x.push(p[0]); S.y.push(p[1]); S.z.push(p[2]); }
      return i;
    };
    const interKey = (u, w) => "e" + (u < w ? u + "_" + w : w + "_" + u);
    const interPt = (u, w) => {
      const key = interKey(u, w);
      if (!sectPts.has(key)) {
        const a = Math.min(u, w), b = Math.max(u, w); // deterministic endpoint order
        const t = D[a] / (D[a] - D[b]);
        sectPts.set(key, [P[a * 3] + t * (P[b * 3] - P[a * 3]), P[a * 3 + 1] + t * (P[b * 3 + 1] - P[a * 3 + 1]), P[a * 3 + 2] + t * (P[b * 3 + 2] - P[a * 3 + 2])]);
      }
      return key;
    };
    const onKey = (vid) => { const key = "v" + vid; if (!sectPts.has(key)) sectPts.set(key, [P[vid * 3], P[vid * 3 + 1], P[vid * 3 + 2]]); return key; };

    const solidCode = (s) => Paint.encode({ leaf: true, state: s });
    const emitWhole = (S, vs, code) => { S.v1.push(addOrig(S, vs[0])); S.v2.push(addOrig(S, vs[1])); S.v3.push(addOrig(S, vs[2])); S.paints.push(code); };
    const emitPoly = (S, poly, code) => { // entries: {vid} | {key}; fan from 0, parent winding preserved
      const id = (q) => (q.vid !== undefined ? addOrig(S, q.vid) : addSect(S, q.key));
      const i0 = id(poly[0]);
      for (let i = 1; i + 1 < poly.length; i++) { S.v1.push(i0); S.v2.push(id(poly[i])); S.v3.push(id(poly[i + 1])); S.paints.push(code); }
    };
    const ptOf = (q) => (q.vid !== undefined ? [P[q.vid * 3], P[q.vid * 3 + 1], P[q.vid * 3 + 2]] : sectPts.get(q.key));

    const chords = []; // { a, b, stAbove, stBelow } (section-point keys)
    for (let f = 0; f < mesh.nf; f++) {
      const vs = [mesh.v1[f], mesh.v2[f], mesh.v3[f]];
      const ds = [D[vs[0]], D[vs[1]], D[vs[2]]];
      if (ds[0] >= 0 && ds[1] >= 0 && ds[2] >= 0) { emitWhole(above, vs, mesh.paints[f]); continue; }
      if (ds[0] <= 0 && ds[1] <= 0 && ds[2] <= 0) { emitWhole(below, vs, mesh.paints[f]); continue; }
      // mixed: walk the cycle building one polygon per side; plane points to both
      const pa = [], pb = [], plKeys = [];
      for (let i = 0; i < 3; i++) {
        const u = vs[i], w = vs[(i + 1) % 3], du = ds[i], dw = ds[(i + 1) % 3];
        if (du >= 0) pa.push({ vid: u });
        if (du <= 0) pb.push({ vid: u });
        if (du === 0) plKeys.push(onKey(u));
        if ((du > 0 && dw < 0) || (du < 0 && dw > 0)) {
          const key = interPt(u, w);
          pa.push({ key }); pb.push({ key }); plKeys.push(key);
        }
      }
      const tree = Paint.decode(mesh.paints[f]);
      const a0 = vs[0] * 3, b0 = vs[1] * 3, c0 = vs[2] * 3;
      const centroidState = (poly) => {
        let mx = 0, my = 0, mz = 0;
        for (const q of poly) { const p = ptOf(q); mx += p[0]; my += p[1]; mz += p[2]; }
        const n = poly.length;
        return Paint.stateAtPoint(tree, P[a0], P[a0 + 1], P[a0 + 2], P[b0], P[b0 + 1], P[b0 + 2], P[c0], P[c0 + 1], P[c0 + 2], mx / n, my / n, mz / n);
      };
      let stA = 0, stB = 0;
      if (pa.length >= 3) { stA = centroidState(pa); emitPoly(above, pa, solidCode(stA)); }
      if (pb.length >= 3) { stB = centroidState(pb); emitPoly(below, pb, solidCode(stB)); }
      if (plKeys.length === 2) chords.push({ a: plKeys[0], b: plKeys[1], stAbove: stA, stBelow: stB });
    }

    // chain chords into closed section loops (degree-2 walk; pinch -> warn)
    const adj = new Map();
    chords.forEach((ch, i) => {
      if (!adj.has(ch.a)) adj.set(ch.a, []);
      if (!adj.has(ch.b)) adj.set(ch.b, []);
      adj.get(ch.a).push({ o: ch.b, i });
      adj.get(ch.b).push({ o: ch.a, i });
    });
    const usedChord = new Uint8Array(chords.length);
    const loops = [];
    let pinch = false;
    for (const startKey of adj.keys()) {
      for (;;) {
        const open = adj.get(startKey).filter((e) => !usedChord[e.i]);
        if (!open.length) break;
        const keys = [startKey], idx = [];
        let cur = startKey, guard = 0, closed = false;
        while (guard++ <= chords.length) {
          const opts = adj.get(cur).filter((e) => !usedChord[e.i]);
          if (!opts.length) break;
          const e = opts[0];
          usedChord[e.i] = 1;
          idx.push(e.i);
          cur = e.o;
          if (cur === startKey) { closed = true; break; }
          keys.push(cur);
        }
        if (closed && keys.length >= 3) loops.push({ keys, idx });
        else pinch = true;
      }
    }
    if (pinch) console.warn("cutMesh: non-manifold section (pinch); some section loops skipped");

    // flat caps per loop group (outer + coplanar holes), winding ±n by construction
    if (loops.length) {
      let bx2, by2, bz2;
      const axn = Math.abs(nx), ayn = Math.abs(ny), azn = Math.abs(nz);
      if (axn <= ayn && axn <= azn) { bx2 = 0; by2 = -nz; bz2 = ny; }
      else if (ayn <= azn) { bx2 = -nz; by2 = 0; bz2 = nx; }
      else { bx2 = -ny; by2 = nx; bz2 = 0; }
      let L = Math.hypot(bx2, by2, bz2) || 1; bx2 /= L; by2 /= L; bz2 /= L;
      const cx2 = ny * bz2 - nz * by2, cy2 = nz * bx2 - nx * bz2, cz2 = nx * by2 - ny * bx2;
      const proj = (p) => [(p[0] - px) * bx2 + (p[1] - py) * by2 + (p[2] - pz) * bz2, (p[0] - px) * cx2 + (p[1] - py) * cy2 + (p[2] - pz) * cz2];
      const recs = loops.map((lp) => {
        const pts3 = lp.keys.map((k) => sectPts.get(k));
        let poly2 = pts3.map(proj), keys = lp.keys.slice();
        let area2 = 0;
        for (let i = 0; i < poly2.length; i++) { const p = poly2[i], q = poly2[(i + 1) % poly2.length]; area2 += p[0] * q[1] - q[0] * p[1]; }
        if (area2 < 0) { poly2 = poly2.slice().reverse(); keys = keys.slice().reverse(); area2 = -area2; }
        let mx = 0, my = 0; for (const p of poly2) { mx += p[0]; my += p[1]; }
        const tally = (side) => { const m = new Map(); for (const ci of lp.idx) { const s = chords[ci][side]; m.set(s, (m.get(s) || 0) + 1); } let best = 0, bn = -1; m.forEach((n2, s) => { if (n2 > bn) { bn = n2; best = s; } }); return best; };
        return { keys, poly2, area: area2 / 2, c2: [mx / poly2.length, my / poly2.length], stA: tally("stAbove"), stB: tally("stBelow") };
      });
      const inPoly = (pt, poly) => {
        let ins = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const a = poly[i], b = poly[j];
          if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1] || 1e-12) + a[0]) ins = !ins;
        }
        return ins;
      };
      const SU = global.THREE && global.THREE.ShapeUtils;
      if (!(SU && SU.triangulateShape)) throw new Error("THREE.ShapeUtils not loaded");
      const order = recs.map((_, i) => i).sort((a, b) => recs[b].area - recs[a].area);
      const used = new Set();
      for (const oi of order) {
        if (used.has(oi)) continue;
        used.add(oi);
        const holes = [];
        for (const hi of order) { if (used.has(hi)) continue; if (inPoly(recs[hi].c2, recs[oi].poly2)) { holes.push(hi); used.add(hi); } }
        const O = recs[oi];
        const V2 = (p) => (global.THREE.Vector2 ? new global.THREE.Vector2(p[0], p[1]) : { x: p[0], y: p[1] });
        const flatKeys = O.keys.concat(...holes.map((h) => recs[h].keys));
        const capTris = SU.triangulateShape(O.poly2.map(V2), holes.map((h) => recs[h].poly2.map(V2)));
        const emitCap = (S, want, st) => {
          const code = solidCode(st);
          for (const [a, b, c] of capTris) {
            const A3 = sectPts.get(flatKeys[a]), B3 = sectPts.get(flatKeys[b]), C3 = sectPts.get(flatKeys[c]);
            const e1 = [B3[0] - A3[0], B3[1] - A3[1], B3[2] - A3[2]], e2 = [C3[0] - A3[0], C3[1] - A3[1], C3[2] - A3[2]];
            const dn = (e1[1] * e2[2] - e1[2] * e2[1]) * nx + (e1[2] * e2[0] - e1[0] * e2[2]) * ny + (e1[0] * e2[1] - e1[1] * e2[0]) * nz;
            const ia = addSect(S, flatKeys[a]), ib = addSect(S, flatKeys[b]), ic = addSect(S, flatKeys[c]);
            if (dn * want < 0) { S.v1.push(ia); S.v2.push(ic); S.v3.push(ib); }
            else { S.v1.push(ia); S.v2.push(ib); S.v3.push(ic); }
            S.paints.push(code);
          }
        };
        emitCap(above, -1, O.stA); // above half: cap faces down (-n) = outward
        emitCap(below, +1, O.stB);
      }
    }

    const fin = (S) => {
      if (!S.v1.length) return null;
      const positions = new Float32Array(S.x.length * 3);
      for (let i = 0; i < S.x.length; i++) { positions[i * 3] = S.x[i]; positions[i * 3 + 1] = S.y[i]; positions[i * 3 + 2] = S.z[i]; }
      return { positions, nf: S.v1.length, v1: Int32Array.from(S.v1), v2: Int32Array.from(S.v2), v3: Int32Array.from(S.v3), paints: S.paints };
    };
    return { above: fin(above), below: fin(below) };
  }

  global.PlaneCut = { cutMesh };
})(window);
