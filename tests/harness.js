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
    "js/decal.js",
    "js/cleanup.js",
    "js/meshgeo.js",
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
    Decal: sandbox.Decal,
    MeshGeo: sandbox.MeshGeo,
    THREE: sandbox.THREE,
    poly2tri: sandbox.poly2tri,
    ThreeMF: sandbox.ThreeMF,
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

// Closed box [0,sx]x[0,sy]x[0,sz] with every side an n x n grid of quads
// (2 tris each), vertices welded by coordinate so edges match across sides.
// Outward-wound. mesh.side[f] names the side of face f. Volume = sx*sy*sz.
function makeGridBox(n, sx, sy, sz) {
  const pos = [], key = new Map(), v1 = [], v2 = [], v3 = [], side = [];
  const vid = (x, y, z) => {
    const k = x.toFixed(9) + "," + y.toFixed(9) + "," + z.toFixed(9);
    let i = key.get(k);
    if (i === undefined) { i = pos.length / 3; key.set(k, i); pos.push(x, y, z); }
    return i;
  };
  // [name, origin, U, V] with U x V pointing OUTWARD
  const sides = [
    ["top",    [0, 0, sz], [sx, 0, 0], [0, sy, 0]],
    ["bottom", [0, 0, 0],  [0, sy, 0], [sx, 0, 0]],
    ["front",  [0, 0, 0],  [sx, 0, 0], [0, 0, sz]],
    ["back",   [0, sy, 0], [0, 0, sz], [sx, 0, 0]],
    ["left",   [0, 0, 0],  [0, 0, sz], [0, sy, 0]],
    ["right",  [sx, 0, 0], [0, sy, 0], [0, 0, sz]],
  ];
  for (const [name, O, U, V] of sides) {
    const P = (i, j) => vid(O[0] + U[0] * i / n + V[0] * j / n, O[1] + U[1] * i / n + V[1] * j / n, O[2] + U[2] * i / n + V[2] * j / n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
      v1.push(a, a); v2.push(b, c); v3.push(c, d); side.push(name, name);
    }
  }
  return {
    nf: v1.length, positions: new Float32Array(pos),
    v1: Int32Array.from(v1), v2: Int32Array.from(v2), v3: Int32Array.from(v3),
    paints: v1.map(() => ""), side,
  };
}

// Gridded triangular prism ("roof"): cross-section (0,0),(w,0),(w/2,h) in XY,
// extruded along z in [0,len]. Every face is subdivided n ways (slopes and
// base n x n quads, ends n^2 triangles), vertices welded by coordinate so the
// grids match across edges. Outward-wound. mesh.side[f] in
// "left"|"right"|"base"|"end0"|"end1". Volume = w*h*len/2. nf = 8*n*n.
function makeRoofPrism(w, h, len, n) {
  const pos = [], key = new Map(), v1 = [], v2 = [], v3 = [], side = [];
  const vid = (x, y, z) => {
    const k = x.toFixed(9) + "," + y.toFixed(9) + "," + z.toFixed(9);
    let i = key.get(k);
    if (i === undefined) { i = pos.length / 3; key.set(k, i); pos.push(x, y, z); }
    return i;
  };
  const at = (O, U, V, i, j) => vid(O[0] + U[0] * i / n + V[0] * j / n, O[1] + U[1] * i / n + V[1] * j / n, O[2] + U[2] * i / n + V[2] * j / n);
  const tri = (a, b, c, name) => { v1.push(a); v2.push(b); v3.push(c); side.push(name); };
  // quad grids: [name, origin, U, V] with U x V outward
  for (const [name, O, U, V] of [
    ["left",  [0, 0, 0], [0, 0, len], [w / 2, h, 0]],
    ["right", [w, 0, 0], [-w / 2, h, 0], [0, 0, len]],
    ["base",  [0, 0, 0], [w, 0, 0], [0, 0, len]],
  ]) {
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const a = at(O, U, V, i, j), b = at(O, U, V, i + 1, j), c = at(O, U, V, i + 1, j + 1), d = at(O, U, V, i, j + 1);
      tri(a, b, c, name); tri(a, c, d, name);
    }
  }
  // end caps: barycentric subdivision of (A,B,C), same orientation as (A,B,C)
  for (const [name, A, B, C] of [
    ["end0", [0, 0, 0], [w / 2, h, 0], [w, 0, 0]],
    ["end1", [0, 0, len], [w, 0, len], [w / 2, h, len]],
  ]) {
    const U = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], V = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) {
      tri(at(A, U, V, i, j), at(A, U, V, i + 1, j), at(A, U, V, i, j + 1), name);
      if (i + j < n - 1) tri(at(A, U, V, i + 1, j), at(A, U, V, i + 1, j + 1), at(A, U, V, i, j + 1), name);
    }
  }
  return {
    nf: v1.length, positions: new Float32Array(pos),
    v1: Int32Array.from(v1), v2: Int32Array.from(v2), v3: Int32Array.from(v3),
    paints: v1.map(() => ""), side,
  };
}

// U-channel: box [0,4]x[0,4]x[0,len] with a groove x in [1,3], y in [2,4]
// running along z. Coarse extrusion of a 10-vertex CCW polygon (extra
// vertices at (4,2) and (0,2) so the end caps need no T-junctions).
// Outward-wound. mesh.edge[f] = polygon edge index of a side quad, or -1
// for end-cap triangles. Volume = 12*len.
function makeUChannel(len) {
  const poly = [[0, 0], [4, 0], [4, 2], [4, 4], [3, 4], [3, 2], [1, 2], [1, 4], [0, 4], [0, 2]];
  const n = poly.length, pos = [];
  for (const [x, y] of poly) pos.push(x, y, 0, x, y, len); // ids 2i (z=0), 2i+1 (z=len)
  const v1 = [], v2 = [], v3 = [], edge = [];
  const tri = (a, b, c, e) => { v1.push(a); v2.push(b); v3.push(c); edge.push(e); };
  for (let i = 0; i < n; i++) { // side quads: (i0, j0, j1), (i0, j1, i1) faces outward for a CCW polygon
    const j = (i + 1) % n, i0 = 2 * i, i1 = 2 * i + 1, j0 = 2 * j, j1 = 2 * j + 1;
    tri(i0, j0, j1, i); tri(i0, j1, i1, i);
  }
  // end caps as triangles over poly indices, CCW seen from +z. The bottom slab is
  // fanned over (0,1,2,5,6,9) so its top edge carries the groove-floor vertices
  // (3,2),(1,2) — no T-junctions with the side quads — plus left and right lands.
  for (const [a, b, c] of [[0, 1, 2], [0, 2, 5], [0, 5, 6], [0, 6, 9], [9, 6, 7], [9, 7, 8], [5, 2, 3], [5, 3, 4]]) {
    tri(2 * a + 1, 2 * b + 1, 2 * c + 1, -1); // z=len, +z
    tri(2 * a, 2 * c, 2 * b, -1);             // z=0, -z
  }
  return { nf: v1.length, positions: new Float32Array(pos), v1: Int32Array.from(v1), v2: Int32Array.from(v2), v3: Int32Array.from(v3), paints: v1.map(() => ""), edge };
}

// Box [0,4]^3 with a 2x2x2 pocket open at the top (x,y in [1,3], z in [2,4]).
// Top is an annulus of 4 quads, so no T-junctions. Outward-wound.
// mesh.side[f] in bottom|front|back|left|right|top|wall|floor. Volume 56, nf 28.
function makePocketBox() {
  const pos = [], key = new Map(), v1 = [], v2 = [], v3 = [], side = [];
  const P = (x, y, z) => {
    const k = x + "," + y + "," + z;
    let i = key.get(k);
    if (i === undefined) { i = pos.length / 3; key.set(k, i); pos.push(x, y, z); }
    return i;
  };
  const quad = (a, b, c, d, name) => { v1.push(a, a); v2.push(b, c); v3.push(c, d); side.push(name, name); }; // (a,b,c),(a,c,d)
  quad(P(0, 0, 0), P(0, 4, 0), P(4, 4, 0), P(4, 0, 0), "bottom");
  quad(P(0, 0, 0), P(4, 0, 0), P(4, 0, 4), P(0, 0, 4), "front");
  quad(P(4, 4, 0), P(0, 4, 0), P(0, 4, 4), P(4, 4, 4), "back");
  quad(P(0, 4, 0), P(0, 0, 0), P(0, 0, 4), P(0, 4, 4), "left");
  quad(P(4, 0, 0), P(4, 4, 0), P(4, 4, 4), P(4, 0, 4), "right");
  const O = [[0, 0], [4, 0], [4, 4], [0, 4]], I = [[1, 1], [3, 1], [3, 3], [1, 3]];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(P(O[i][0], O[i][1], 4), P(O[j][0], O[j][1], 4), P(I[j][0], I[j][1], 4), P(I[i][0], I[i][1], 4), "top");   // +z annulus
    quad(P(I[i][0], I[i][1], 4), P(I[j][0], I[j][1], 4), P(I[j][0], I[j][1], 2), P(I[i][0], I[i][1], 2), "wall"); // faces into the pocket air
  }
  quad(P(1, 1, 2), P(3, 1, 2), P(3, 3, 2), P(1, 3, 2), "floor"); // +z, air above
  return { nf: v1.length, positions: new Float32Array(pos), v1: Int32Array.from(v1), v2: Int32Array.from(v2), v3: Int32Array.from(v3), paints: v1.map(() => ""), side };
}

// Closed "height-field box": top surface z = zfn(x, y) over an n x n grid on
// [0,size]^2, four gridded side walls down to z = 0, gridded flat bottom.
// Vertices welded by coordinate (boundary rows shared), outward-wound,
// mesh.top[f] = true for top-surface faces. zfn must stay > 0.
function makeHeightBox(n, size, zfn) {
  const pos = [], key = new Map(), v1 = [], v2 = [], v3 = [], top = [];
  const vid = (x, y, z) => {
    const k = x.toFixed(9) + "," + y.toFixed(9) + "," + z.toFixed(9);
    let i = key.get(k);
    if (i === undefined) { i = pos.length / 3; key.set(k, i); pos.push(x, y, z); }
    return i;
  };
  const g = (i) => (size * i) / n;
  const T = (i, j) => vid(g(i), g(j), zfn(g(i), g(j))), B = (i, j) => vid(g(i), g(j), 0);
  const tri = (a, b, c, t) => { v1.push(a); v2.push(b); v3.push(c); top.push(t); };
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    tri(T(i, j), T(i + 1, j), T(i + 1, j + 1), true); tri(T(i, j), T(i + 1, j + 1), T(i, j + 1), true);   // +z
    tri(B(i, j), B(i + 1, j + 1), B(i + 1, j), false); tri(B(i, j), B(i, j + 1), B(i + 1, j + 1), false); // -z
  }
  for (let k = 0; k < n; k++) { // walls, outward: y=0 (-y), x=size (+x), y=size (+y), x=0 (-x)
    tri(B(k, 0), B(k + 1, 0), T(k + 1, 0), false); tri(B(k, 0), T(k + 1, 0), T(k, 0), false);
    tri(B(n, k), B(n, k + 1), T(n, k + 1), false); tri(B(n, k), T(n, k + 1), T(n, k), false);
    tri(B(k + 1, n), B(k, n), T(k, n), false); tri(B(k + 1, n), T(k, n), T(k + 1, n), false);
    tri(B(0, k + 1), B(0, k), T(0, k), false); tri(B(0, k + 1), T(0, k), T(0, k + 1), false);
  }
  return {
    nf: v1.length, positions: new Float32Array(pos),
    v1: Int32Array.from(v1), v2: Int32Array.from(v2), v3: Int32Array.from(v3),
    paints: v1.map(() => ""), top,
  };
}

// The tracked reference model (samples/), unzipped with the vendored JSZip and
// parsed by the pure ThreeMF.parseMeshes. Resolves to { M, mesh } where M is a
// fresh loadModules() and mesh the single object (199,672 faces).
async function loadSampleMesh() {
  const zipBox = { setTimeout, clearTimeout, console };
  zipBox.window = zipBox; zipBox.self = zipBox;
  vm.createContext(zipBox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "vendor/jszip.min.js"), "utf8"), zipBox, { filename: "jszip.min.js" });
  const buf = fs.readFileSync(path.join(__dirname, "..", "samples", "Meshy_AI_Pikachu and the Red Ball.3mf"));
  const bytes = vm.runInContext("new Uint8Array(" + buf.length + ")", zipBox); // JSZip type checks are realm-bound
  bytes.set(buf);
  const zip = await zipBox.JSZip.loadAsync(bytes);
  const text = await zip.file("3D/Objects/object_1.model").async("string");
  const M = loadModules();
  const meshes = M.ThreeMF.parseMeshes(text, "3D/Objects/object_1.model");
  return { M, mesh: meshes[0] };
}

module.exports = { loadSampleMesh, makeHeightBox, makePocketBox, makeUChannel, makeGridBox, makeRoofPrism, loadModules, makeTetra, edgeUseCounts, makeTJunction, capBoundaryEdges, makeMirrorPair, makeOpenTube, makeClosedCube, makeBentStrip, makeBigTriangle, directedViolations, signedVolume };
