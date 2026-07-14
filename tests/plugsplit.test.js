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

// The top face (z=2) plus one side face (y=0) painted state 2 — a region whose
// rim WRAPS over a cube edge, so it is non-planar and its per-vertex inward
// normals genuinely differ from the single averaged normal (unlike the flat
// top of makeToppedCube, where the two modes coincide).
function makeEdgeWrapCube() {
  const m = makeClosedCube();
  m.paints = m.paints.slice();
  for (const f of [2, 3, 4, 5]) m.paints[f] = "8"; // top pair + y=0 side pair
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

test("farWallDepth: cube top -> bottom distance is 2; miss -> Infinity", () => {
  const { Cleanup, Split } = loadModules();
  const mesh = makeToppedCube(); // 2x2x2 cube
  // ray from top-center straight down hits the bottom at t=2
  const hit = Split._farWallDepth(mesh, [[1, 1, 2]], [[0, 0, -1]]);
  assert.ok(Math.abs(hit - 2) < 1e-6, "expected 2, got " + hit);
  // ray pointing away from the solid never exits through a front-facing wall
  const miss = Split._farWallDepth(mesh, [[1, 1, 2]], [[0, 0, 1]]);
  assert.equal(miss, Infinity);
});

test("solidFromSubs: depth 0 is identical to the flat cap", () => {
  const { Cleanup, Split } = loadModules();
  const base = () => { const m = makeToppedCube(); return { m, subs: regionOfState(Cleanup, m, 2) }; };
  const A = base(), B = base();
  const flat = Split.solidFromSubs(A.m, A.subs, "centroid");
  const zero = Split.solidFromSubs(B.m, B.subs, "centroid", { depth: 0, wallMode: "averaged" });
  assert.deepEqual(Array.from(zero.indices), Array.from(flat.indices));
  assert.deepEqual(Array.from(zero.positions), Array.from(flat.positions));
  assert.equal(zero.cap.tris.length, flat.cap.tris.length);
});

test("solidFromSubs: depth>0 plug is watertight, outward-wound, deeper", () => {
  const { Cleanup, Split } = loadModules();
  for (const wallMode of ["averaged", "pervertex"]) {
    const mesh = makeToppedCube();
    const subs = regionOfState(Cleanup, mesh, 2);
    const solid = Split.solidFromSubs(mesh, subs, "centroid", { depth: 1, wallMode });
    for (const [, n] of edgeUseCounts(solid.indices)) assert.equal(n, 2, "closed " + wallMode);
    assert.equal(directedViolations(solid.indices), 0, "consistent winding " + wallMode);
    assert.ok(signedVolume(solid.indices, solid.positions) > 0, "outward " + wallMode);
    // the socket pushed points below z=2 (into the body)
    let minZ = Infinity;
    for (let i = 0; i < solid.positions.length; i += 3) minZ = Math.min(minZ, solid.positions[i + 2]);
    assert.ok(minZ < 2 - 1e-6 && minZ >= 0, "plug goes into body, got minZ=" + minZ);
  }
});

test("solidFromSubs: depth is clamped below the far wall", () => {
  const { Cleanup, Split } = loadModules();
  const mesh = makeToppedCube(); // thickness 2 in z
  const subs = regionOfState(Cleanup, mesh, 2);
  const solid = Split.solidFromSubs(mesh, subs, "centroid", { depth: 100, wallMode: "averaged" });
  let minZ = Infinity;
  for (let i = 0; i < solid.positions.length; i += 3) minZ = Math.min(minZ, solid.positions[i + 2]);
  // clamped to 0.9 * 2 = 1.8 -> bottom at z = 2 - 1.8 = 0.2, never crosses z=0
  assert.ok(minZ > 0.1 && minZ < 0.3, "clamped near 0.2, got " + minZ);
});

test("remainder shares the socket -> part+remainder both watertight at depth", () => {
  const { Cleanup, Split } = loadModules();
  const mesh = makeToppedCube();
  const subs = regionOfState(Cleanup, mesh, 2);
  const opts = { depth: 1, wallMode: "averaged" };
  const part = Split.solidFromSubs(mesh, subs, "centroid", opts);
  const claimed = new Set(subs);
  const rem = Split.remainderSolid(mesh, [{ subs, cap: part.cap, state: 2 }], claimed);
  for (const [, n] of edgeUseCounts(part.indices)) assert.equal(n, 2, "part closed");
  for (const [, n] of edgeUseCounts(rem.indices)) assert.equal(n, 2, "remainder closed");
  assert.equal(directedViolations(rem.indices), 0, "remainder winding");
  assert.ok(signedVolume(rem.indices, rem.positions) > 0, "remainder outward");
  // the part's plug reaches the socket depth (top z=2, depth 1 -> bottom z=1)
  let pMin = Infinity;
  for (let i = 0; i < part.positions.length; i += 3) pMin = Math.min(pMin, part.positions[i + 2]);
  assert.ok(Math.abs(pMin - 1) < 1e-6, "part plug bottom at socket depth, got " + pMin);
  // coincidence: the remainder carries the SAME socket, so it contains a
  // vertex at that exact depth (its global min is the cube's far wall at z=0,
  // which is expected and not what we're checking here).
  let remHasSocket = false;
  for (let i = 0; i < rem.positions.length; i += 3)
    if (Math.abs(rem.positions[i + 2] - 1) < 1e-6) { remHasSocket = true; break; }
  assert.ok(remHasSocket, "remainder carries the shared socket at the same depth");
});

test("per-vertex vs averaged: distinct, watertight sockets on a non-planar rim", () => {
  const { Cleanup, Split } = loadModules();
  // makeEdgeWrapCube's region wraps over a cube edge, so per-vertex inward
  // normals differ from the averaged one (unlike the flat topped-cube, where
  // depth>0 exercises the wallMode branch but yields identical geometry).
  const build = (wallMode) => {
    const mesh = makeEdgeWrapCube();
    const subs = regionOfState(Cleanup, mesh, 2);
    return Split.solidFromSubs(mesh, subs, "centroid", { depth: 0.4, wallMode });
  };
  const avg = build("averaged");
  const pv = build("pervertex");
  // both are valid closed solids (winding-blind + winding-checked)
  for (const [, n] of edgeUseCounts(avg.indices)) assert.equal(n, 2, "averaged closed");
  for (const [, n] of edgeUseCounts(pv.indices)) assert.equal(n, 2, "pervertex closed");
  assert.equal(directedViolations(avg.indices), 0, "averaged winding");
  assert.equal(directedViolations(pv.indices), 0, "pervertex winding");
  assert.ok(signedVolume(avg.indices, avg.positions) > 0, "averaged outward");
  assert.ok(signedVolume(pv.indices, pv.positions) > 0, "pervertex outward");
  // the two modes must actually produce DIFFERENT geometry here — otherwise the
  // per-vertex offset path is not really being exercised.
  const differ = avg.positions.length !== pv.positions.length ||
    [...avg.positions].some((v, i) => Math.abs(v - pv.positions[i]) > 1e-9);
  assert.ok(differ, "per-vertex and averaged sockets differ on a curved rim");
});
