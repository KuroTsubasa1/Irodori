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

test("earcut: square outer + square hole -> 8 tris, fills outer minus hole", () => {
  const { Caps } = loadModules();
  const coords = {
    0: [0, 0, 0], 1: [6, 0, 0], 2: [6, 6, 0], 3: [0, 6, 0],   // outer (CCW)
    4: [2, 2, 0], 5: [2, 4, 0], 6: [4, 4, 0], 7: [4, 2, 0],   // hole (CW)
  };
  const cap = Caps.triangulateLoops([[0, 1, 2, 3], [4, 5, 6, 7]], (v) => coords[v], "earcut");
  assert.equal(cap.tris.length, 8, "8 triangles for square-with-square-hole");
  assert.equal(cap.extraPts.length, 0, "earcut invents no points");
  // boundary = outer 4 edges + hole 4 edges (each used once)
  assert.equal(capBoundaryEdges(cap.tris).size, 8);
});

test("cdt: square outer + square hole -> triangulated with no invented points", () => {
  const { Caps } = loadModules();
  const coords = {
    0: [0, 0, 0], 1: [6, 0, 0], 2: [6, 6, 0], 3: [0, 6, 0],
    4: [2, 2, 0], 5: [2, 4, 0], 6: [4, 4, 0], 7: [4, 2, 0],
  };
  const cap = Caps.triangulateLoops([[0, 1, 2, 3], [4, 5, 6, 7]], (v) => coords[v], "cdt");
  assert.ok(cap.tris.length >= 8, "at least 8 triangles");
  assert.equal(cap.extraPts.length, 0, "cdt invents no points");
  assert.equal(capBoundaryEdges(cap.tris).size, 8, "outer + hole boundary preserved");
});

test("earcut: single convex loop (no holes) still triangulates", () => {
  const { Caps } = loadModules();
  const coords = { 0: [0, 0, 0], 1: [4, 0, 0], 2: [4, 4, 0], 3: [0, 4, 0] };
  const cap = Caps.triangulateLoops([[0, 1, 2, 3]], (v) => coords[v], "earcut");
  assert.equal(cap.tris.length, 2);
});

test("triangulateLoops throws on an unknown method", () => {
  const { Caps } = loadModules();
  const coords = { 0: [0, 0, 0], 1: [1, 0, 0], 2: [1, 1, 0] };
  assert.throws(() => Caps.triangulateLoops([[0, 1, 2]], (v) => coords[v], "nope"), /Unknown cap method/);
});

test("earcut: two independent outers (no nesting) -> 4 tris, 0 extra, 8 boundary edges", () => {
  const { Caps } = loadModules();
  const coords = {
    0: [0, 0, 0], 1: [2, 0, 0], 2: [2, 2, 0], 3: [0, 2, 0],
    4: [5, 0, 0], 5: [7, 0, 0], 6: [7, 2, 0], 7: [5, 2, 0],
  };
  const cap = Caps.triangulateLoops([[0, 1, 2, 3], [4, 5, 6, 7]], (v) => coords[v], "earcut");
  assert.equal(cap.tris.length, 4);
  assert.equal(cap.extraPts.length, 0);
  assert.equal(capBoundaryEdges(cap.tris).size, 8);
});

test("earcut/cdt: a degenerate (collinear) loop still caps via centroid fallback", () => {
  const { Caps } = loadModules();
  const coords = { 0: [0, 0, 0], 1: [1, 0, 0], 2: [2, 0, 0], 3: [3, 0, 0] }; // collinear
  for (const method of ["earcut", "cdt"]) {
    const cap = Caps.triangulateLoops([[0, 1, 2, 3]], (v) => coords[v], method);
    assert.equal(cap.extraPts.length, 1, method + " used the centroid fallback");
    assert.equal(cap.tris.length, 4, method + " fanned the 4-vertex loop");
    assert.equal(capBoundaryEdges(cap.tris).size, 4, method + " cap covers the loop boundary");
  }
});

test("stacked end-loops are capped independently (not as outer+hole)", () => {
  const { Caps } = loadModules();
  const coords = {
    0: [0, 0, 0], 1: [4, 0, 0], 2: [4, 4, 0], 3: [0, 4, 0],   // bottom rim (z=0)
    4: [0, 0, 5], 5: [4, 0, 5], 6: [4, 4, 5], 7: [0, 4, 5],   // top rim (z=5)
  };
  for (const method of ["earcut", "cdt"]) {
    const cap = Caps.triangulateLoops([[0, 1, 2, 3], [4, 5, 6, 7]], (v) => coords[v], method);
    assert.equal(cap.extraPts.length, 0, method + ": no fallback fan");
    assert.equal(cap.tris.length, 4, method + ": two 2-tri caps");
    for (const t of cap.tris) {
      const sides = new Set(t.map((r) => (cap.verts[r] <= 3 ? "A" : "B")));
      assert.equal(sides.size, 1, method + ": no cross-loop triangles");
    }
    assert.equal(capBoundaryEdges(cap.tris).size, 8, method + ": both rims capped exactly once");
  }
});

test("coplanar asymmetric hole caps weld to the right vertices (area check)", () => {
  const { Caps } = loadModules();
  // outer 6x6 square (CCW), hole an asymmetric quad listed CW (forces the
  // CCW-normalization reversal). Correct triangulation covers exactly
  // outer minus hole; a reflected vid assignment folds triangles and the
  // absolute-area sum diverges.
  const coords = {
    0: [0, 0, 0], 1: [6, 0, 0], 2: [6, 6, 0], 3: [0, 6, 0],
    // hole CCW order would be (1,1),(4,1.5),(3.5,3),(1.5,4) -> listed reversed (CW):
    4: [1.5, 4, 0], 5: [3.5, 3, 0], 6: [4, 1.5, 0], 7: [1, 1, 0],
  };
  const holeArea = 5.625, outerArea = 36, expected = outerArea - holeArea;
  for (const method of ["earcut", "cdt"]) {
    const cap = Caps.triangulateLoops([[0, 1, 2, 3], [4, 5, 6, 7]], (v) => coords[v], method);
    assert.equal(cap.extraPts.length, 0, method + ": no fallback");
    let sum = 0;
    for (const t of cap.tris) {
      const p = t.map((r) => coords[cap.verts[r]]);
      const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1];
      const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1];
      sum += Math.abs(ux * vy - uy * vx) / 2;
    }
    assert.ok(Math.abs(sum - expected) < 1e-6, method + ": cap area " + sum.toFixed(4) + " == outer-hole " + expected);
  }
});

test("liepa method fills each loop independently with refined interior points", () => {
  const { Caps } = loadModules();
  const n = 40;
  const coords = {};
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; coords[i] = [Math.cos(a) * 8, Math.sin(a) * 8, Math.sin(2 * a)]; }
  const cap = Caps.triangulateLoops([[...Array(n).keys()]], (v) => coords[v], "liepa");
  assert.ok(cap.tris.length >= n - 2, "filled");
  assert.ok(cap.extraPts.length > 0, "refined interior points present");
  assert.equal(capBoundaryEdges(cap.tris).size, n, "rim covered exactly once");
});

test("liepa respects coplanar island holes via the nesting classifier", () => {
  const { Caps } = loadModules();
  const coords = {
    0: [0, 0, 0], 1: [6, 0, 0], 2: [6, 6, 0], 3: [0, 6, 0],   // outer 6x6
    4: [2, 2, 0], 5: [2, 4, 0], 6: [4, 4, 0], 7: [4, 2, 0],   // 2x2 island
  };
  const cap = Caps.triangulateLoops([[0, 1, 2, 3], [4, 5, 6, 7]], (v) => coords[v], "liepa");
  const pt = (r) => (r < cap.verts.length ? coords[cap.verts[r]] : cap.extraPts[r - cap.verts.length]);
  let area = 0;
  for (const t of cap.tris) {
    const a = pt(t[0]), b = pt(t[1]), c = pt(t[2]);
    const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - a[0], vy = c[1] - a[1];
    area += Math.abs(ux * vy - uy * vx) / 2;
  }
  assert.ok(Math.abs(area - 32) < 1e-6, "outer minus island (32), got " + area.toFixed(2));
  assert.equal(capBoundaryEdges(cap.tris).size, 8, "both rims covered exactly once");
});
