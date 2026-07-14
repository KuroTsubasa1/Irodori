const test = require("node:test");
const assert = require("node:assert");
const {
  loadModules, makeClosedCube, makeTetra,
  edgeUseCounts, directedViolations, signedVolume,
} = require("./harness");

// The top two faces of the 2x2x2 closed cube (z=2) painted state 2; rest state 1.
function makeToppedCube() {
  const m = makeClosedCube();
  m.paints = m.paints.slice();
  m.paints[2] = "8"; // face 2: verts 4,5,6 (z=2)
  m.paints[3] = "8"; // face 3: verts 4,6,7 (z=2)
  return m;
}

function regionOfState(Cleanup, mesh, state) {
  const g = Cleanup.buildSubGraph(mesh);
  const seed = [...Array(g.NS).keys()].find((i) => g.subLeaf[i].state === state);
  return Array.from(Cleanup.selectColorRegion(mesh, seed));
}

test("inwardNormals: cube top region points straight down (-z)", () => {
  const { Cleanup, Split } = loadModules();
  const mesh = makeToppedCube();
  const g = Cleanup.buildSubGraph(mesh);
  const subs = regionOfState(Cleanup, mesh, 2); // the two top faces
  const { avg, perVid } = Split._inwardNormals(g, subs);
  assert.ok(Math.abs(avg[0]) < 1e-6 && Math.abs(avg[1]) < 1e-6, "avg is axis-aligned in z");
  assert.ok(avg[2] < -0.99, "inward is -z, got " + avg[2]);
  for (const [, n] of perVid) {
    const len = Math.hypot(n[0], n[1], n[2]);
    assert.ok(Math.abs(len - 1) < 1e-6, "unit length");
    assert.ok(n[2] < -0.99, "each rim vertex inward is -z");
  }
});
