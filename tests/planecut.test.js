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

test("cutMesh: a tilted cut still yields watertight halves summing to the source volume", () => {
  const { PlaneCut } = loadModules();
  const s = Math.SQRT1_2;
  const { above, below } = PlaneCut.cutMesh(makeClosedCube(), { px: 1, py: 1, pz: 1, nx: s, ny: 0, nz: s });
  assert.ok(above && below);
  let sum = 0;
  for (const h of [above, below]) {
    const I = asIndices(h);
    assert.equal(directedViolations(I), 0, "directed-watertight");
    sum += signedVolume(I, h.positions);
  }
  assert.ok(Math.abs(sum - 8) < 1e-6, "volumes sum to the cube (8), got " + sum.toFixed(4));
});

// Hollow square tube (outer 4x4, inner 2x2, z in [0,2], annular ends): cutting
// it produces an outer-loop + hole section — the spec's single-level nesting.
function makeHollowBox() {
  const O = [[0, 0], [4, 0], [4, 4], [0, 4]];
  const I = [[1, 1], [3, 1], [3, 3], [1, 3]];
  const pos = [];
  for (const [x, y] of O) pos.push(x, y, 0);
  for (const [x, y] of I) pos.push(x, y, 0);
  for (const [x, y] of O) pos.push(x, y, 2);
  for (const [x, y] of I) pos.push(x, y, 2);
  const v1 = [], v2 = [], v3 = [];
  const quad = (a, b, c, d) => { v1.push(a, a); v2.push(b, c); v3.push(c, d); };
  for (let i = 0; i < 4; i++) { const a = i, b = (i + 1) % 4; quad(a, b, b + 8, a + 8); } // outer walls
  for (let i = 0; i < 4; i++) { const a = i + 4, b = ((i + 1) % 4) + 4; quad(b, a, a + 8, b + 8); } // inner walls
  for (let i = 0; i < 4; i++) { const oa = i, ob = (i + 1) % 4; quad(ob, oa, oa + 4, ob + 4); } // bottom annulus (-z)
  for (let i = 0; i < 4; i++) { const oa = i + 8, ob = ((i + 1) % 4) + 8; quad(oa, ob, ob + 4, oa + 4); } // top annulus (+z)
  return {
    nf: v1.length,
    positions: new Float32Array(pos),
    v1: Int32Array.from(v1), v2: Int32Array.from(v2), v3: Int32Array.from(v3),
    paints: new Array(v1.length).fill("4"),
  };
}

test("cutMesh: annular sections cap as outer + hole (single-level nesting)", () => {
  const { PlaneCut } = loadModules();
  const tube = makeHollowBox();
  assert.equal(directedViolations(asIndices(tube)), 0, "fixture sanity");
  assert.ok(Math.abs(signedVolume(asIndices(tube), tube.positions) - 24) < 1e-6, "fixture volume 24");
  const { above, below } = PlaneCut.cutMesh(tube, { px: 0, py: 0, pz: 1, nx: 0, ny: 0, nz: 1 });
  assert.ok(above && below);
  for (const [name, h] of [["above", above], ["below", below]]) {
    assert.equal(directedViolations(asIndices(h)), 0, name + " directed-watertight");
    const vol = signedVolume(asIndices(h), h.positions);
    assert.ok(Math.abs(vol - 12) < 1e-6, name + " annular volume 12, got " + vol.toFixed(3));
  }
});

test("cutMesh: clipped pieces inherit the parent's paint at their centroid", () => {
  const { PlaneCut } = loadModules();
  const cube = makeClosedCube();
  cube.paints[4] = "841"; // front face (0,1,5): child (A,B,M)->state 2, (M,D,A)->state 1
  const { above, below } = PlaneCut.cutMesh(cube, { px: 0, py: 0, pz: 1, nx: 0, ny: 0, nz: 1 });
  // (A,B,M) spans z in [0,1] -> its pieces land below as state 2 ("8")
  assert.ok(below.paints.includes("8"), "below got a state-2 piece from the painted face");
  assert.ok(above.paints.includes("4"), "above keeps state-1 geometry");
  assert.ok(!above.paints.includes("841") || !below.paints.includes("841"), "the crossing face was actually clipped");
});
