const test = require("node:test");
const assert = require("node:assert");
const { loadModules } = require("./harness");

test("deps: THREE.ShapeUtils.triangulateShape and poly2tri load in the sandbox", () => {
  const { THREE, poly2tri } = loadModules();
  assert.ok(THREE && THREE.ShapeUtils && typeof THREE.ShapeUtils.triangulateShape === "function",
    "THREE.ShapeUtils.triangulateShape available");
  assert.ok(poly2tri && poly2tri.SweepContext && poly2tri.Point,
    "poly2tri.SweepContext and poly2tri.Point available");
});

test("extractLoops: one triangle boundary -> a single 3-vertex loop", () => {
  const { Caps } = loadModules();
  const loops = Caps.extractLoops([[0, 1], [1, 2], [2, 0]]);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].length, 3);
  // starts at 0 and is ordered 0 -> 1 -> 2
  const L = loops[0];
  const at = L.indexOf(0);
  assert.deepEqual([L[at], L[(at + 1) % 3], L[(at + 2) % 3]], [0, 1, 2]);
});

test("extractLoops: two disjoint boundaries -> two loops", () => {
  const { Caps } = loadModules();
  const loops = Caps.extractLoops([
    [0, 1], [1, 2], [2, 0],
    [3, 4], [4, 5], [5, 3],
  ]);
  assert.equal(loops.length, 2);
  assert.deepEqual(loops.map((l) => l.length).sort(), [3, 3]);
});

test("bestFitPlane: normal of a z=5 square is ±Z; projection is an isometry", () => {
  const { Caps } = loadModules();
  const pts = [[0, 0, 5], [4, 0, 5], [4, 4, 5], [0, 4, 5]];
  const pl = Caps.bestFitPlane(pts);
  assert.ok(Math.abs(Math.abs(pl.nz) - 1) < 1e-9, "normal is vertical");
  assert.ok(Math.abs(pl.nx) < 1e-9 && Math.abs(pl.ny) < 1e-9);
  const p = pts.map((q) => Caps.project(pl, q));
  // side lengths preserved (projection preserves distance)
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  assert.ok(Math.abs(d(p[0], p[1]) - 4) < 1e-6);
  assert.ok(Math.abs(d(p[1], p[2]) - 4) < 1e-6);
});
