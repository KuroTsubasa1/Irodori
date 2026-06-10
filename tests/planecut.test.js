const test = require("node:test");
const assert = require("node:assert");
const { loadModules } = require("./harness");

test("stateAtPoint descends the paint tree with tessellate geometry", () => {
  const { Paint } = loadModules();
  // "841" = 1-way split (special 0): child0 (A,B,M) -> state 2, child1 (M,D,A) -> state 1
  const tree = Paint.decode("841");
  const A = [0, 0, 0], B = [2, 0, 0], D = [2, 0, 2]; // M = mid(B,D) = (2,0,1)
  const at = (p) => Paint.stateAtPoint(tree, A[0],A[1],A[2], B[0],B[1],B[2], D[0],D[1],D[2], p[0],p[1],p[2]);
  assert.equal(at([1, 0, 0.25]), 2, "inside (A,B,M)");
  assert.equal(at([1.5, 0, 1.5]), 1, "inside (M,D,A)");
});
