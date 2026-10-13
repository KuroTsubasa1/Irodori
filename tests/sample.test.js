// Real-data guard: volumetric split on the tracked reference model
// (samples/Meshy_AI_Pikachu and the Red Ball.3mf — 199,672 faces, 544,468
// sub-triangles, fractal paint rims with 0.004 mm edges). Every region was
// refused before (task 6); the synthetic fixtures in plug.test.js pin the
// individual failure classes, this file pins the whole pipeline on real data.
// ~28 s (incl. the independent validity checks): the graph build (~2.5 s) and the conformed surface (~1.2 s) are
// shared by the three tests through the mesh caches.
const test = require("node:test");
const assert = require("node:assert");
const { loadSampleMesh } = require("./harness");

let sample;
const getSample = async () => (sample = sample || (await loadSampleMesh()));

// Independent validity (does not reuse the gate's rules): (1) every plug
// vertex lies inside the ORIGINAL solid — the nearest hit along a ray is a
// back face, majority of three directions; (2) at zero tolerance, no new
// triangle crosses an original face that is not incident to one of the
// triangle's own surface vertices (those faces are touched by design).
function validity(M, mesh, r) {
  const dbg = r.debug, grid = M.MeshGeo.faceGrid(mesh), P = mesh.positions, T = dbg.tris, m = T.length / 3;
  const dirs = [[0.5773, 0.5774, 0.5775], [-0.31, 0.82, -0.48], [0.7, -0.1, -0.707]].map((d) => { const l = Math.hypot(...d); return d.map((x) => x / l); });
  const inside = (p) => {
    let yes = 0, no = 0;
    for (const d of dirs) {
      const ta = M.MeshGeo.rayHit(mesh, grid, p[0], p[1], p[2], d[0], d[1], d[2], 0, false);
      const tb = M.MeshGeo.rayHit(mesh, grid, p[0], p[1], p[2], d[0], d[1], d[2], 0, true);
      if (ta < Infinity && tb === ta) yes++; else no++;
      if (yes === 2 || no === 2) break;
    }
    return yes >= 2;
  };
  const seen = new Set(); let outside = 0;
  for (const id of T) if (id >= dbg.NI && !seen.has(id)) { seen.add(id); if (!inside(dbg.pos(id))) outside++; }
  const { tri, triSub, nT } = dbg.conf, star = new Map();
  for (const id of T) if (id < dbg.NI) star.set(id, new Set());
  for (let t = 0; t < nT; t++) for (let k = 0; k < 3; k++) { const st = star.get(tri[t * 3 + k]); if (st) st.add(dbg.subFace[triSub[t]]); }
  const { n, min, cell, start, list } = grid, mark = new Int32Array(mesh.nf).fill(-1);
  const ci = (x, k) => Math.max(0, Math.min(n - 1, Math.floor((x - min[k]) / cell[k])));
  let crossings = 0;
  for (let i = 0; i < m; i++) {
    const V = [0, 1, 2].map((k) => dbg.pos(T[i * 3 + k])), adj = new Set();
    for (let k = 0; k < 3; k++) if (T[i * 3 + k] < dbg.NI) for (const f of star.get(T[i * 3 + k])) adj.add(f);
    const lo = [0, 1, 2].map((a) => Math.min(V[0][a], V[1][a], V[2][a])), hi = [0, 1, 2].map((a) => Math.max(V[0][a], V[1][a], V[2][a]));
    for (let x = ci(lo[0], 0); x <= ci(hi[0], 0); x++) for (let y = ci(lo[1], 1); y <= ci(hi[1], 1); y++) for (let z = ci(lo[2], 2); z <= ci(hi[2], 2); z++) {
      const c = (x * n + y) * n + z;
      for (let e = start[c]; e < start[c + 1]; e++) {
        const f = list[e];
        if (mark[f] === i || adj.has(f)) continue;
        mark[f] = i;
        const F = [mesh.v1[f], mesh.v2[f], mesh.v3[f]].map((v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
        if (M.MeshGeo.triTriIntersect(V[0], V[1], V[2], F[0], F[1], F[2])) crossings++;
      }
    }
  }
  return { plugVertices: seen.size, outside, crossings };
}

async function splitRegion(seed, depth) {
  const { M, mesh } = await getSample();
  const subs = M.Cleanup.selectColorRegion(mesh, seed);
  const r = M.Split.plugSolids(mesh, subs, { depth, debug: true });
  assert.ok(!r.error, r.error + " " + JSON.stringify(r.info));
  const v0 = M.MeshGeo.signedVolume(mesh), vp = M.MeshGeo.signedVolume(r.part), vr = M.MeshGeo.signedVolume(r.remainder);
  assert.strictEqual(M.MeshGeo.checkClosed(r.part), 0, "part closed");
  assert.strictEqual(M.MeshGeo.checkClosed(r.remainder), 0, "remainder closed");
  assert.ok(vp > 0 && vr > 0, "positive volumes " + vp + " " + vr);
  assert.ok(Math.abs(vp + vr - v0) < 1e-6 * v0, "volumes sum: " + (vp + vr) + " vs " + v0);
  const v = validity(M, mesh, r);
  assert.ok(v.plugVertices > 0);
  assert.strictEqual(v.outside, 0, "plug vertices outside the original solid");
  assert.strictEqual(v.crossings, 0, "zero-tolerance crossings with non-adjacent original faces");
  return { subs, r, vp };
}

test("sample: the belly region (seed 490285) splits at depth 3", { timeout: 120000 }, async () => {
  const { subs, vp } = await splitRegion(490285, 3);
  assert.strictEqual(subs.length, 44138);
  assert.ok(vp > 100, "a real plug, not a sliver: " + vp);
});

test("sample: an ear tip (seed 116289) splits at depth 3", { timeout: 120000 }, async () => {
  const { vp } = await splitRegion(116289, 3);
  assert.ok(vp > 10, "ear-tip plug volume " + vp);
});

test("sample: the neck band (seed 89601, 7 pinch vertices on its rim) splits at depth 3", { timeout: 120000 }, async () => {
  const { vp } = await splitRegion(89601, 3);
  assert.ok(vp > 5, "neck-band plug volume " + vp);
});
