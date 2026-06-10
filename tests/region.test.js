const test = require("node:test");
const assert = require("node:assert");
const { loadModules, makeTetra, makeMirrorPair } = require("./harness");

test("harness loads modules and Paint decodes", () => {
  const { Paint, Cleanup } = loadModules();
  assert.ok(Paint && Cleanup, "Paint and Cleanup present");
  assert.equal(Paint.leafCount(Paint.decode("4")), 1);
});

test("buildSubGraph on tetra has 4 sub-triangles", () => {
  const { Cleanup } = loadModules();
  const g = Cleanup.buildSubGraph(makeTetra());
  assert.equal(g.NS, 4);
});

test("buildSubGraph exposes welded verts (sv, vx/vy/vz, NV)", () => {
  const { Cleanup } = loadModules();
  const g = Cleanup.buildSubGraph(makeTetra());
  assert.equal(g.NV, 4, "4 welded vertices");
  assert.equal(g.sv.length, g.NS * 3, "3 vertex ids per sub");
  assert.equal(g.vx.length, g.NV);
  // every sv id is a valid vertex index
  for (let i = 0; i < g.sv.length; i++) assert.ok(g.sv[i] >= 0 && g.sv[i] < g.NV);
});

test("selectColorRegion floods the connected same-color region", () => {
  const { Cleanup } = loadModules();
  const mesh = makeTetra();
  const g = Cleanup.buildSubGraph(mesh);
  // find a sub of state 1 and a sub of state 2
  const s1 = [...Array(g.NS).keys()].find((i) => g.subLeaf[i].state === 1);
  const s2 = [...Array(g.NS).keys()].find((i) => g.subLeaf[i].state === 2);
  const r1 = Cleanup.selectColorRegion(mesh, s1);
  const r2 = Cleanup.selectColorRegion(mesh, s2);
  assert.equal(r1.length, 3, "three state-1 faces are one region");
  assert.equal(r2.length, 1, "single state-2 face");
  for (const s of r1) assert.equal(g.subLeaf[s].state, 1);
});

test("mirrorMap pairs X-mirrored sub-triangles; no partner on the Y axis", () => {
  const { Cleanup } = loadModules();
  const mesh = makeMirrorPair();
  const mx = Cleanup.mirrorMap(mesh, 0); // X
  assert.equal(mx.length, 2);
  assert.equal(mx[0], 1, "sub 0 mirrors to sub 1 across X");
  assert.equal(mx[1], 0, "sub 1 mirrors to sub 0 across X");
  const my = Cleanup.mirrorMap(mesh, 1); // Y — the two subs are not Y-mirrors
  assert.equal(my[0], -1);
  assert.equal(my[1], -1);
});

test("mirrorMap returns -1 where no mirror exists (asymmetric tetra)", () => {
  const { Cleanup } = loadModules();
  const m = Cleanup.mirrorMap(makeTetra(), 0);
  // tetra is not X-symmetric, so at least one sub has no partner
  assert.ok([...m].some((p) => p === -1));
});

test("selectColorRegion honors an exclude set", () => {
  const { Cleanup } = loadModules();
  const mesh = makeTetra();
  const g = Cleanup.buildSubGraph(mesh);
  const s1 = [...Array(g.NS).keys()].filter((i) => g.subLeaf[i].state === 1);
  const r = Cleanup.selectColorRegion(mesh, s1[0], new Set([s1[1]]));
  assert.equal(r.length, 2, "excluded sub is not flooded");
  assert.ok(![...r].includes(s1[1]));
});

test("collapseDeep merges uniform subtrees and keeps mixed ones", () => {
  const { Paint } = loadModules();
  const leaf = (s) => ({ leaf: true, state: s });
  const uniform = { leaf: false, split: 3, special: 0, kids: [leaf(2), leaf(2), leaf(2), leaf(2)] };
  const nested = { leaf: false, split: 1, special: 0, kids: [uniform, leaf(2)] };
  const collapsed = Paint.collapseDeep(nested);
  assert.ok(collapsed.leaf, "fully uniform tree becomes one leaf");
  assert.equal(collapsed.state, 2);
  const mixed = { leaf: false, split: 1, special: 0, kids: [leaf(1), leaf(2)] };
  const kept = Paint.collapseDeep(mixed);
  assert.ok(!kept.leaf, "mixed tree stays split");
});
