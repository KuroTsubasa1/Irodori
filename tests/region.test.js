const test = require("node:test");
const assert = require("node:assert");
const { loadModules, makeTetra } = require("./harness");

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
