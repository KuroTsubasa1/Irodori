const test = require("node:test");
const assert = require("node:assert");
const { loadModules, makeBigTriangle } = require("./harness");

function totalLeaves(Paint, mesh) {
  let n = 0;
  for (const p of mesh.paints) n += Paint.leafCount(Paint.decode(p));
  return n;
}

test("applyStates changes state without adding leaves (refine-off invariant)", () => {
  const { Paint, Cleanup } = loadModules();
  const mesh = makeBigTriangle();
  const g = Cleanup.buildSubGraph(mesh);
  const before = totalLeaves(Paint, mesh);
  // paint the first few leaves to a new state
  const subs = [0, 1, 2].filter((i) => i < g.NS);
  const res = Cleanup.applyStates(mesh, subs, 3);
  assert.ok(res.changedFaces.size > 0, "some face changed");
  assert.equal(totalLeaves(Paint, mesh), before, "no leaves added");
});

test("paintStamps subdivides (refine-on adds geometry)", () => {
  const { Paint, Cleanup } = loadModules();
  const mesh = makeBigTriangle();
  const g = Cleanup.buildSubGraph(mesh);
  const before = totalLeaves(Paint, mesh);
  // a small stamp near the centroid of sub 0 forces an edge-crossing split
  const cx = g.cen[0], cy = g.cen[1], cz = g.cen[2];
  const res = Cleanup.paintStamps(mesh, [{ x: cx, y: cy, z: cz, r: 0.01 }], 3, { maxDepth: 4 });
  assert.ok(res.changedFaces.size > 0, "some face changed");
  assert.ok(totalLeaves(Paint, mesh) > before, "leaves added by subdivision");
});
