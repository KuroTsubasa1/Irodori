const test = require("node:test");
const assert = require("node:assert");
const { loadModules, capBoundaryEdges } = require("./harness");

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

// helper: the loop's own edge set (by the cap's combined vertex indexing,
// where loop vid k is at index = position in `verts`)
function loopEdgeSet(cap, loopVids) {
  const idx = new Map(cap.verts.map((v, i) => [v, i]));
  const key = (a, b) => (a < b ? a + "_" + b : b + "_" + a);
  const s = new Set();
  for (let i = 0; i < loopVids.length; i++) {
    s.add(key(idx.get(loopVids[i]), idx.get(loopVids[(i + 1) % loopVids.length])));
  }
  return s;
}

test("centroid: square loop -> fan of 4 tris + 1 centroid point, fills the loop", () => {
  const { Caps } = loadModules();
  const coords = { 0: [0, 0, 0], 1: [4, 0, 0], 2: [4, 4, 0], 3: [0, 4, 0] };
  const loops = [[0, 1, 2, 3]];
  const cap = Caps.triangulateLoops(loops, (v) => coords[v], "centroid");
  assert.equal(cap.tris.length, 4, "4 fan triangles");
  assert.equal(cap.extraPts.length, 1, "one centroid point");
  assert.deepEqual(cap.extraPts[0], [2, 2, 0]);
  assert.deepEqual([...capBoundaryEdges(cap.tris)].sort(), [...loopEdgeSet(cap, [0, 1, 2, 3])].sort());
});

test("projected: convex square -> ear-clip 2 tris, no extra points, fills the loop", () => {
  const { Caps } = loadModules();
  const coords = { 0: [0, 0, 0], 1: [4, 0, 0], 2: [4, 4, 0], 3: [0, 4, 0] };
  const cap = Caps.triangulateLoops([[0, 1, 2, 3]], (v) => coords[v], "projected");
  assert.equal(cap.tris.length, 2, "two triangles");
  assert.equal(cap.extraPts.length, 0, "no invented points");
  assert.deepEqual([...capBoundaryEdges(cap.tris)].sort(), [...loopEdgeSet(cap, [0, 1, 2, 3])].sort());
});

test("projected: concave L-pentagon triangulates without self-overlap", () => {
  const { Caps } = loadModules();
  // an L shape (reflex vertex at index 4)
  const coords = { 0: [0, 0, 0], 1: [4, 0, 0], 2: [4, 2, 0], 3: [2, 2, 0], 4: [2, 4, 0], 5: [0, 4, 0] };
  const cap = Caps.triangulateLoops([[0, 1, 2, 3, 4, 5]], (v) => coords[v], "projected");
  assert.equal(cap.tris.length, 4, "n-2 triangles for a simple polygon");
  assert.deepEqual([...capBoundaryEdges(cap.tris)].sort(),
    [...loopEdgeSet(cap, [0, 1, 2, 3, 4, 5])].sort());
});
