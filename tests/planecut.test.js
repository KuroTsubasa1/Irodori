const test = require("node:test");
const assert = require("node:assert");
const { loadModules, makeClosedCube, directedViolations, signedVolume } = require("./harness");

test("stateAtPoint descends the paint tree with tessellate geometry", () => {
  const { Paint } = loadModules();
  // "841" = 1-way split (special 0): child0 (A,B,M) -> state 2, child1 (M,D,A) -> state 1
  const tree = Paint.decode("841");
  const A = [0, 0, 0], B = [2, 0, 0], D = [2, 0, 2]; // M = mid(B,D) = (2,0,1)
  const at = (p) => Paint.stateAtPoint(tree, A[0],A[1],A[2], B[0],B[1],B[2], D[0],D[1],D[2], p[0],p[1],p[2]);
  assert.equal(at([1, 0, 0.25]), 2, "inside (A,B,M)");
  assert.equal(at([1.5, 0, 1.5]), 1, "inside (M,D,A)");
});

function asIndices(m) {
  const I = new Uint32Array(m.nf * 3);
  for (let f = 0; f < m.nf; f++) { I[f * 3] = m.v1[f]; I[f * 3 + 1] = m.v2[f]; I[f * 3 + 2] = m.v3[f]; }
  return I;
}

test("cutMesh: axis cut of a cube yields two watertight, oriented, capped halves", () => {
  const { PlaneCut } = loadModules();
  const cube = makeClosedCube();
  assert.equal(directedViolations(asIndices(cube)), 0, "fixture sanity: cube is consistently wound");
  const plane = { px: 0, py: 0, pz: 1, nx: 0, ny: 0, nz: 1 };
  const { above, below } = PlaneCut.cutMesh(cube, plane);
  assert.ok(above && below, "both halves exist");
  for (const [name, h, want] of [["above", above, -1], ["below", below, +1]]) {
    const I = asIndices(h);
    assert.equal(directedViolations(I), 0, name + " directed-watertight");
    const vol = signedVolume(I, h.positions);
    assert.ok(vol > 3.9 && vol < 4.1, name + " volume ~4, got " + vol.toFixed(2));
    // flat caps: triangles whose three verts sit on the plane; correctly wound
    let caps = 0;
    for (let f = 0; f < h.nf; f++) {
      const vs = [h.v1[f], h.v2[f], h.v3[f]];
      if (!vs.every((v) => Math.abs(h.positions[v * 3 + 2] - 1) < 1e-6)) continue;
      caps++;
      const [a, b, c] = vs.map((v) => [h.positions[v * 3], h.positions[v * 3 + 1], h.positions[v * 3 + 2]]);
      const nz2 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      assert.ok(nz2 * want > 0, name + " cap winding faces " + (want > 0 ? "+" : "-") + "n");
    }
    assert.ok(caps >= 2, name + " has cap triangles (" + caps + ")");
    for (const p of h.paints) assert.equal(p, "4", name + " keeps state-1 paint");
  }
});

test("cutMesh: a plane that misses returns the source side untouched", () => {
  const { PlaneCut } = loadModules();
  const r = PlaneCut.cutMesh(makeClosedCube(), { px: 0, py: 0, pz: 5, nx: 0, ny: 0, nz: 1 });
  assert.equal(r.above, null);
  assert.ok(r.below && r.below.nf === 12, "below is the whole cube");
});
