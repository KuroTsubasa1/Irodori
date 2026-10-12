const test = require("node:test");
const assert = require("node:assert");
const { loadModules, makeClosedCube, makeOpenTube, directedViolations } = require("./harness");

test("checkClosed: 0 for the cube, matches directedViolations on the open tube", () => {
  const { MeshGeo } = loadModules();
  const cube = makeClosedCube(), tube = makeOpenTube();
  assert.strictEqual(MeshGeo.checkClosed(cube), 0);
  const flat = (m) => { const I = []; for (let f = 0; f < m.nf; f++) I.push(m.v1[f], m.v2[f], m.v3[f]); return I; };
  assert.strictEqual(MeshGeo.checkClosed(tube), directedViolations(flat(tube)));
  assert.ok(MeshGeo.checkClosed(tube) > 0);
  // flip one cube face -> 3 edges now traversed twice in the same direction
  const bad = makeClosedCube(); const t = bad.v2[0]; bad.v2[0] = bad.v3[0]; bad.v3[0] = t;
  assert.strictEqual(MeshGeo.checkClosed(bad), 3);
});

test("signedVolume: outward cube is 8, a flipped face changes it", () => {
  const { MeshGeo } = loadModules();
  const cube = makeClosedCube();
  assert.ok(Math.abs(MeshGeo.signedVolume(cube) - 8) < 1e-9);
  const bad = makeClosedCube(); const t = bad.v2[2]; bad.v2[2] = bad.v3[2]; bad.v3[2] = t; // face off the origin plane
  assert.ok(MeshGeo.signedVolume(bad) < 8);
});

test("triTriIntersect: crossing yes, separated no, coplanar no", () => {
  const { MeshGeo } = loadModules();
  const A = [[0, 0, 0], [2, 0, 0], [0, 2, 0]];           // z=0
  const B = [[0.5, 0.5, -1], [0.5, 0.5, 1], [1, 1, 1]];   // pierces A
  assert.strictEqual(MeshGeo.triTriIntersect(...A, ...B), true);
  const C = [[0.5, 0.5, 1], [0.5, 0.5, 2], [1, 1, 2]];    // entirely above
  assert.strictEqual(MeshGeo.triTriIntersect(...A, ...C), false);
  const D = [[0, 0, 0], [2, 0, 0], [0, 2, 0]];           // coplanar copy -> ignored
  assert.strictEqual(MeshGeo.triTriIntersect(...A, ...D), false);
  const E = [[5, 5, -1], [6, 5, 1], [5, 6, 1]];          // crosses z=0 outside A
  assert.strictEqual(MeshGeo.triTriIntersect(...A, ...E), false);
});

test("rayHit: inward ray from the cube top hits the bottom from behind at t=2; backOnly ignores front faces", () => {
  const { MeshGeo } = loadModules();
  const cube = makeClosedCube(); // [0,2]^3
  const grid = MeshGeo.faceGrid(cube);
  const t = MeshGeo.rayHit(cube, grid, 1, 1, 2, 0, 0, -1, 1e-4, true);
  assert.ok(Math.abs(t - 2) < 1e-6, "hit bottom at " + t);
  // from outside above the cube, pointing down: the top is a FRONT face -> backOnly skips it, bottom is hit at t=3
  const t2 = MeshGeo.rayHit(cube, grid, 1, 1, 3, 0, 0, -1, 1e-4, true);
  assert.ok(Math.abs(t2 - 3) < 1e-6, "backOnly skipped the top: " + t2);
  const t3 = MeshGeo.rayHit(cube, grid, 1, 1, 3, 0, 0, -1, 1e-4, false);
  assert.ok(Math.abs(t3 - 1) < 1e-6, "front hit allowed: " + t3);
  assert.strictEqual(MeshGeo.rayHit(cube, grid, 1, 1, 2, 0, 0, 1, 1e-4, true), Infinity, "upward ray leaves");
});

test("meshBounds recomputes after invalidateSub", () => {
  const { MeshGeo, Cleanup } = loadModules();
  const cube = makeClosedCube();
  const b = MeshGeo.meshBounds(cube);
  // Array.from: bounds arrays are created in the vm sandbox realm (cross-realm deepStrictEqual fails)
  assert.deepStrictEqual([Array.from(b.min), Array.from(b.max)], [[0, 0, 0], [2, 2, 2]]);
  cube.positions[0] = -1; // mutate; cached bounds are stale until invalidated
  assert.strictEqual(MeshGeo.meshBounds(cube).min[0], 0);
  Cleanup.invalidateSub(cube);
  assert.strictEqual(MeshGeo.meshBounds(cube).min[0], -1);
  assert.strictEqual(cube._grid, null);
});
