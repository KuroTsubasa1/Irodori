// Loads the browser IIFE modules into a Node vm sandbox (window-shimmed) and
// returns their globals, plus small mesh fixtures for tests.
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function loadModules() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.console = console;
  vm.createContext(sandbox);
  for (const f of [
    "vendor/three.min.js",
    "vendor/poly2tri.min.js",
    "js/paint.js",
    "js/objexport.js",
    "js/subgraph.js",
    "js/select.js",
    "js/cleanup.js",
    "js/liepa.js",
    "js/caps.js",
    "js/split.js",
    "js/planecut.js",
    "js/threemf.js",
  ]) {
    const code = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    vm.runInContext(code, sandbox, { filename: f });
  }
  return {
    Paint: sandbox.Paint,
    ObjExport: sandbox.ObjExport,
    Cleanup: sandbox.Cleanup,
    Split: sandbox.Split,
    Caps: sandbox.Caps,
    THREE: sandbox.THREE,
    poly2tri: sandbox.poly2tri,
    ThreeMF: sandbox.ThreeMF,
    Liepa: sandbox.Liepa,
    PlaneCut: sandbox.PlaneCut,
    window: sandbox,
  };
}

// Unit tetrahedron: faces 0,1,2 painted state 1 ("4"); face 3 painted state 2 ("8").
// State-1 faces are mutually edge-connected -> one color region of 3 sub-triangles.
function makeTetra() {
  return {
    nf: 4,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    v1: Int32Array.from([0, 0, 0, 1]),
    v2: Int32Array.from([1, 1, 2, 2]),
    v3: Int32Array.from([2, 3, 3, 3]),
    paints: ["4", "4", "4", "8"],
  };
}

// Count how many times each undirected edge is used across an index buffer.
// Watertight (closed, manifold) <=> every edge used exactly twice.
function edgeUseCounts(indices) {
  const m = new Map();
  const key = (a, b) => (a < b ? a + "_" + b : b + "_" + a);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = key(u, v);
      m.set(k, (m.get(k) || 0) + 1);
    }
  }
  return m;
}

// Two faces sharing edge vA-vB. Face 1 is painted with a 1-way split ("441")
// whose tessellation puts a midpoint M at mid(vA,vB) -> a T-junction with the
// solid face 0. Both faces are filament state 1 -> a single 3-sub region.
function makeTJunction() {
  return {
    nf: 2,
    positions: new Float32Array([0,0,0, 2,0,0, 1,1,0, 1,-1,0]), // vA,vB,vC,vX
    v1: Int32Array.from([0, 3]),
    v2: Int32Array.from([1, 0]),
    v3: Int32Array.from([2, 1]),
    paints: ["4", "441"],
  };
}

// Edges used by exactly one triangle (the open boundary of a triangle fan/cap).
// tris: array of [a,b,c] index triples. Returns a Set of "min_max" strings.
function capBoundaryEdges(tris) {
  const m = new Map();
  const key = (a, b) => (a < b ? a + "_" + b : b + "_" + a);
  for (const [a, b, c] of tris) {
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = key(u, v);
      m.set(k, (m.get(k) || 0) + 1);
    }
  }
  const once = new Set();
  for (const [k, n] of m) if (n === 1) once.add(k);
  return once;
}

// Two solid triangles that are exact mirror images across x = 0 (one sub each).
function makeMirrorPair() {
  return {
    nf: 2,
    positions: new Float32Array([1, 0, 0, 2, 0, 0, 1.5, 1, 0,  -1, 0, 0, -2, 0, 0, -1.5, 1, 0]),
    v1: Int32Array.from([0, 3]),
    v2: Int32Array.from([1, 4]),
    v3: Int32Array.from([2, 5]),
    paints: ["4", "4"],
  };
}

// An open square tube (cuboid sides, no top/bottom): 8 verts, 8 triangles,
// two square rims (z=0 and z=2). All faces solid state 1. Its open boundary
// is exactly the two rims — the minimal "band region" shape.
function makeOpenTube() {
  return {
    nf: 8,
    positions: new Float32Array([
      0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0,   // bottom rim 0..3
      0, 0, 2, 2, 0, 2, 2, 2, 2, 0, 2, 2,   // top rim 4..7
    ]),
    v1: Int32Array.from([0, 0, 1, 1, 2, 2, 3, 3]),
    v2: Int32Array.from([1, 5, 2, 6, 3, 7, 0, 4]),
    v3: Int32Array.from([5, 4, 6, 5, 7, 6, 4, 7]),
    paints: ["4", "4", "4", "4", "4", "4", "4", "4"],
  };
}

// A closed, consistently outward-wound 2x2x2 cube (12 triangles), solid state 1.
function makeClosedCube() {
  return {
    nf: 12,
    positions: new Float32Array([0,0,0, 2,0,0, 2,2,0, 0,2,0, 0,0,2, 2,0,2, 2,2,2, 0,2,2]),
    v1: Int32Array.from([0, 0, 4, 4, 0, 0, 2, 2, 0, 0, 1, 1]),
    v2: Int32Array.from([2, 3, 5, 6, 1, 5, 3, 7, 4, 7, 2, 6]),
    v3: Int32Array.from([1, 2, 6, 7, 5, 4, 7, 6, 7, 3, 6, 5]),
    paints: ["4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4", "4"],
  };
}

// Two planar 2-triangle bands hinged at the y=1 edge, bent by `angleDeg`
// about the hinge. Band 1 (faces 0,1) lies in z=0 with normal +z; band 2
// (faces 2,3) has its normal exactly angleDeg away. All solid state 1.
// Adjacent pairs: 0-1 (coplanar), 1-2 (the hinge), 2-3 (coplanar).
// `withDegenerate` appends a zero-area triangle (vertex ON the A-B segment)
// sharing band 1's free edge — for the zero-normal guard test.
function makeBentStrip(angleDeg, withDegenerate) {
  const a = (angleDeg * Math.PI) / 180;
  const pos = [
    0, 0, 0,  2, 0, 0,  2, 1, 0,  0, 1, 0,   // A B C D (band 1)
    0, 1 + Math.cos(a), Math.sin(a),          // E (hinged above D)
    2, 1 + Math.cos(a), Math.sin(a),          // F (hinged above C)
  ];
  const v1 = [0, 0, 3, 3], v2 = [1, 2, 2, 5], v3 = [2, 3, 5, 4];
  const paints = ["4", "4", "4", "4"];
  if (withDegenerate) {
    pos.push(1, 0, 0);                        // G — collinear on A-B
    v1.push(0); v2.push(1); v3.push(6);
    paints.push("4");
  }
  return {
    nf: paints.length,
    positions: new Float32Array(pos),
    v1: Int32Array.from(v1), v2: Int32Array.from(v2), v3: Int32Array.from(v3),
    paints,
  };
}

// One large unpainted face (state 0) for stamp-refinement tests.
function makeBigTriangle() {
  return {
    nf: 1,
    positions: new Float32Array([0, 0, 0, 8, 0, 0, 0, 8, 0]),
    v1: Int32Array.from([0]),
    v2: Int32Array.from([1]),
    v3: Int32Array.from([2]),
    paints: [""],
  };
}

// Directed watertight check: a consistently-oriented closed mesh traverses
// every undirected edge exactly once in each direction. Returns the number of
// violating undirected edges.
function directedViolations(indices) {
  const dir = new Map(), und = new Set();
  for (let t = 0; t < indices.length; t += 3) {
    for (const [u, v] of [[indices[t], indices[t + 1]], [indices[t + 1], indices[t + 2]], [indices[t + 2], indices[t]]]) {
      dir.set(u + ">" + v, (dir.get(u + ">" + v) || 0) + 1);
      und.add(u < v ? u + "_" + v : v + "_" + u);
    }
  }
  let bad = 0;
  for (const k of und) {
    const [a, b] = k.split("_").map(Number);
    if ((dir.get(a + ">" + b) || 0) !== 1 || (dir.get(b + ">" + a) || 0) !== 1) bad++;
  }
  return bad;
}

// Signed volume of a closed triangle mesh (positive when outward-oriented).
function signedVolume(indices, positions) {
  let v6 = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    v6 += positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
        - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c])
        + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return v6 / 6;
}

module.exports = { loadModules, makeTetra, edgeUseCounts, makeTJunction, capBoundaryEdges, makeMirrorPair, makeOpenTube, makeClosedCube, makeBentStrip, makeBigTriangle, directedViolations, signedVolume };
