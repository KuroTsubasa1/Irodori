// Real-data guard: volumetric split on the tracked reference model
// (samples/Meshy_AI_Pikachu and the Red Ball.3mf — 199,672 faces, 544,468
// sub-triangles, fractal paint rims with 0.004 mm edges). Every region was
// refused before (task 6); the synthetic fixtures in plug.test.js pin the
// individual failure classes, this file pins the whole pipeline on real data.
// ~20 s: the graph build (~2.5 s) and the conformed surface (~1.2 s) are
// shared by the three tests through the mesh caches.
const test = require("node:test");
const assert = require("node:assert");
const { loadSampleMesh } = require("./harness");

let sample;
const getSample = async () => (sample = sample || (await loadSampleMesh()));

async function splitRegion(seed, depth) {
  const { M, mesh } = await getSample();
  const subs = M.Cleanup.selectColorRegion(mesh, seed);
  const r = M.Split.plugSolids(mesh, subs, { depth });
  assert.ok(!r.error, r.error + " " + JSON.stringify(r.info));
  const v0 = M.MeshGeo.signedVolume(mesh), vp = M.MeshGeo.signedVolume(r.part), vr = M.MeshGeo.signedVolume(r.remainder);
  assert.strictEqual(M.MeshGeo.checkClosed(r.part), 0, "part closed");
  assert.strictEqual(M.MeshGeo.checkClosed(r.remainder), 0, "remainder closed");
  assert.ok(vp > 0 && vr > 0, "positive volumes " + vp + " " + vr);
  assert.ok(Math.abs(vp + vr - v0) < 1e-3 * v0, "volumes sum: " + (vp + vr) + " vs " + v0);
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
