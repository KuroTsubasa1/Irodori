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

test("selectSmartFaces: cube at 30° selects only the coplanar pair", () => {
  const { Cleanup } = loadModules();
  const mesh = makeClosedCube();
  const r = Cleanup.selectSmartFaces(mesh, 0, 30);
  assert.equal(r.length, 2, "seed face + its coplanar diagonal partner");
  const g = Cleanup.faceGraph(mesh);
  const [a, b] = r;
  const dot = g.faceN[a * 3] * g.faceN[b * 3] + g.faceN[a * 3 + 1] * g.faceN[b * 3 + 1] + g.faceN[a * 3 + 2] * g.faceN[b * 3 + 2];
  assert.ok(dot > 0.999, "the two member faces are coplanar");
});

test("selectSmartFaces: cube at 90° floods all 12 (epsilon regression)", () => {
  // cos(90°) is ~6e-17, not 0 — without the epsilon tolerance the exactly
  // perpendicular cube edges (dot exactly 0) would NOT pass at θ=90.
  const { Cleanup } = loadModules();
  const r = Cleanup.selectSmartFaces(makeClosedCube(), 0, 90);
  assert.equal(r.length, 12);
});

test("selectSmartFaces: 20° bend crossed at θ=30, blocked at θ=10", () => {
  const { Cleanup } = loadModules();
  const mesh = makeBentStrip(20);
  assert.equal(Cleanup.selectSmartFaces(mesh, 0, 30).length, 4, "crosses the bend");
  const r10 = Cleanup.selectSmartFaces(mesh, 0, 10);
  assert.deepEqual([...r10].sort(), [0, 1], "stops at the bend");
});

test("selectSmartFaces: threshold is inclusive at exactly θ", () => {
  const { Cleanup } = loadModules();
  assert.equal(Cleanup.selectSmartFaces(makeBentStrip(30), 0, 30).length, 4);
});

test("selectSmartFaces: degenerate faces are never crossed, even at 90°", () => {
  const { Cleanup } = loadModules();
  const mesh = makeBentStrip(20, true); // face 4 = zero-area on band 1's edge
  const r = Cleanup.selectSmartFaces(mesh, 0, 90);
  assert.equal(r.length, 4, "all real faces, not the degenerate one");
  assert.ok(![...r].includes(4));
});

test("facesToSubs expands faces to exactly their sub-triangles", () => {
  const { Cleanup } = loadModules();
  const mesh = makeTJunction(); // face 0 solid (1 sub), face 1 split "441" (2 subs)
  const g = Cleanup.buildSubGraph(mesh);
  const subs1 = Cleanup.facesToSubs(mesh, Int32Array.from([1]));
  assert.equal(subs1.length, 2);
  for (const s of subs1) assert.equal(g.subFace[s], 1);
  assert.equal(Cleanup.facesToSubs(mesh, Int32Array.from([0, 1])).length, 3);
});
