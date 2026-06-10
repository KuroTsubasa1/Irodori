const test = require("node:test");
const assert = require("node:assert");
const { loadModules } = require("./harness");

test("dpFill: a triangle passes through unchanged", () => {
  const { Liepa } = loadModules();
  const tris = Liepa.dpFill([[0, 0, 0], [2, 0, 0], [0, 2, 0]]);
  assert.deepEqual(tris, [[0, 1, 2]]);
});

test("dpFill: a planar square yields two triangles covering it", () => {
  const { Liepa } = loadModules();
  const tris = Liepa.dpFill([[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]]);
  assert.equal(tris.length, 2);
  let area = 0;
  for (const [a, b, c] of tris) area += 0.5 * 2 * 2; // each half of the 2x2 square
  assert.equal(area, 4);
});

test("dpFill: a bent quad picks the flatter diagonal", () => {
  const { Liepa } = loadModules();
  // fold the quad along the 1-3 diagonal: corners 0 and 2 lifted, 1 and 3 on the floor.
  // Splitting along 1-3 gives two coplanar-with-floor-ish triangles (dihedral 0 across
  // the fold line is impossible; the flat split is 1-3, the creased one is 0-2).
  const pts = [[0, 0, 1], [2, 0, 0], [4, 0, 1], [2, 2, 0]];
  const tris = Liepa.dpFill(pts);
  assert.equal(tris.length, 2);
  const usesDiag13 = tris.every((t) => t.includes(1) && t.includes(3));
  assert.ok(usesDiag13, "min-dihedral DP chooses the 1-3 diagonal, got " + JSON.stringify(tris));
});
