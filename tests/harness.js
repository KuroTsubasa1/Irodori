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
    "js/cleanup.js",
    "js/caps.js",
    "js/split.js",
    "js/threemf.js",
  ]) {
    const code = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    vm.runInContext(code, sandbox, { filename: f });
  }
  return {
    Paint: sandbox.Paint,
    Cleanup: sandbox.Cleanup,
    Split: sandbox.Split,
    Caps: sandbox.Caps,
    THREE: sandbox.THREE,
    poly2tri: sandbox.poly2tri,
    ThreeMF: sandbox.ThreeMF,
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

module.exports = { loadModules, makeTetra, edgeUseCounts, makeTJunction, capBoundaryEdges, makeMirrorPair, makeOpenTube, makeBigTriangle };
