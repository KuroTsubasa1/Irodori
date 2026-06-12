const test = require("node:test");
const assert = require("node:assert");
const { loadModules, makeClosedCube, makeBentStrip, makeTetra, makeTJunction } = require("./harness");

test("faceGraph: cube has 12 faces, 3 neighbors each, unit normals", () => {
  const { Cleanup } = loadModules();
  const mesh = makeClosedCube();
  const g = Cleanup.faceGraph(mesh);
  assert.equal(g.nf, 12);
  assert.equal(g.list.length, 36, "closed manifold: 3 neighbors per triangle");
  for (let f = 0; f < 12; f++) {
    assert.equal(g.start[f + 1] - g.start[f], 3, "face " + f + " has 3 neighbors");
    const L = Math.hypot(g.faceN[f * 3], g.faceN[f * 3 + 1], g.faceN[f * 3 + 2]);
    assert.ok(Math.abs(L - 1) < 1e-6, "unit normal on face " + f);
  }
});

test("faceGraph: bent strip adjacency and degenerate normal", () => {
  const { Cleanup } = loadModules();
  const g = Cleanup.faceGraph(makeBentStrip(20, true));
  // pairs: 0-1, 1-2 (hinge), 2-3, 0-4 (degenerate on A-B) -> 8 directed entries
  assert.equal(g.list.length, 8);
  const L = Math.hypot(g.faceN[12], g.faceN[13], g.faceN[14]);
  assert.equal(L, 0, "zero-area face keeps a zero normal");
});

test("faceGraph is cached and invalidateSub clears it", () => {
  const { Cleanup } = loadModules();
  const mesh = makeTetra();
  const g1 = Cleanup.faceGraph(mesh);
  assert.equal(Cleanup.faceGraph(mesh), g1, "second call returns the cache");
  Cleanup.invalidateSub(mesh);
  assert.equal(mesh._faceG, null, "invalidateSub clears _faceG");
});
