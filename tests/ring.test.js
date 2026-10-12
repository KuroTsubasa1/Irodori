const test = require("node:test");
const assert = require("node:assert");
const { loadModules } = require("./harness");

// The Cut tool's tilt math as it was before the refactor (regression oracle).
function oldCutNormal(axis, ta, tb) {
  const n = [0, 0, 0];
  n[axis] = 1;
  const rot = (v, ax2, ang) => { const i = (ax2 + 1) % 3, j = (ax2 + 2) % 3; const vi = v[i], vj = v[j]; v[i] = vi * Math.cos(ang) - vj * Math.sin(ang); v[j] = vi * Math.sin(ang) + vj * Math.cos(ang); };
  rot(n, (axis + 1) % 3, ta);
  rot(n, (axis + 2) % 3, tb);
  return n;
}
const unitAxes = (k) => { const n = [0, 0, 0], u = [0, 0, 0]; n[k] = 1; u[(k + 1) % 3] = 1; return { n, u }; };
const close = (a, b, eps = 1e-9) => a.every((x, i) => Math.abs(x - b[i]) < eps);

test("tiltAxis with zero tilts returns the base axis", () => {
  const { Cleanup } = loadModules();
  for (let k = 0; k < 3; k++) {
    const { n, u } = unitAxes(k);
    assert.ok(close(Cleanup.tiltAxis(n, u, 0, 0), n), "axis " + k);
  }
});

test("tiltAxis matches the Cut tool's previous tilt convention", () => {
  const { Cleanup } = loadModules();
  for (let k = 0; k < 3; k++) {
    for (const [ta, tb] of [[0.3, -0.5], [-1.2, 0.7], [Math.PI / 2, 0], [0, -Math.PI / 2]]) {
      const { n, u } = unitAxes(k);
      const got = Cleanup.tiltAxis(n, u, ta, tb);
      assert.ok(close(got, oldCutNormal(k, ta, tb)), `axis ${k} ta ${ta} tb ${tb}: ${got}`);
    }
  }
});

test("tiltAxis works for an arbitrary (fitted) base axis", () => {
  const { Cleanup } = loadModules();
  const s = Math.SQRT1_2;
  const n = [s, s, 0], u = [0, 0, 1]; // u ⊥ n
  const v = Cleanup.tiltAxis(n, u, Math.PI / 2, 0); // 90° about z: (s,s,0) -> (-s,s,0)
  assert.ok(close(v, [-s, s, 0]), String(v));
  assert.ok(Math.abs(Math.hypot(...Cleanup.tiltAxis(n, u, 0.4, 1.1)) - 1) < 1e-12, "unit length");
});

const { makeClosedCube } = require("./harness");

// Open cylinder along +z through (ox,0): `segs` segments, ONE row of long
// triangles spanning z=0..len (the coarse case that left half-rings before).
// Unpainted (state 0). Faces 2i, 2i+1 belong to segment i.
function makeCylinder(segs, r, len, ox) {
  const pos = [];
  for (const z of [0, len]) for (let i = 0; i < segs; i++) {
    const a = (2 * Math.PI * i) / segs;
    pos.push(ox + r * Math.cos(a), r * Math.sin(a), z);
  }
  const v1 = [], v2 = [], v3 = [];
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % segs;
    v1.push(i); v2.push(j); v3.push(segs + j);
    v1.push(i); v2.push(segs + j); v3.push(segs + i);
  }
  return {
    nf: v1.length, positions: new Float32Array(pos),
    v1: Int32Array.from(v1), v2: Int32Array.from(v2), v3: Int32Array.from(v3),
    paints: v1.map(() => ""),
  };
}
// Concatenate two meshes into one (disjoint vertex sets).
function joinMeshes(a, b) {
  const off = a.positions.length / 3;
  const shift = (arr) => Array.from(arr, (v) => v + off);
  return {
    nf: a.nf + b.nf,
    positions: Float32Array.from([...a.positions, ...b.positions]),
    v1: Int32Array.from([...a.v1, ...shift(b.v1)]),
    v2: Int32Array.from([...a.v2, ...shift(b.v2)]),
    v3: Int32Array.from([...a.v3, ...shift(b.v3)]),
    paints: [...a.paints, ...b.paints],
  };
}
const unit = (v) => { const L = Math.hypot(...v); return v.map((x) => x / L); };

test("ringFaces closes the loop on coarse long triangles", () => {
  const { Cleanup } = loadModules();
  const m = makeCylinder(8, 1, 10, 0);
  const faces = Cleanup.ringFaces(m, 0, [1, 0, 5], [0, 0, 1], 0.5);
  assert.deepStrictEqual(Array.from(faces).sort((a, b) => a - b), [...Array(16).keys()]);
});

test("ringFaces closes the loop for a tilted axis", () => {
  const { Cleanup } = loadModules();
  const m = makeCylinder(8, 1, 10, 0);
  const faces = Cleanup.ringFaces(m, 0, [1, 0, 5], unit([0.3, 0.2, 1]), 0.5);
  assert.strictEqual(faces.length, 16);
});

test("ringFaces stays on the clicked loop when the slab crosses two parts", () => {
  const { Cleanup } = loadModules();
  const m = joinMeshes(makeCylinder(8, 1, 10, 0), makeCylinder(8, 1, 10, 5));
  const faces = Array.from(Cleanup.ringFaces(m, 0, [1, 0, 5], [0, 0, 1], 0.5));
  assert.strictEqual(faces.length, 16);
  assert.ok(faces.every((f) => f < 16), "no faces from the second cylinder");
});

test("ringFaces includes only faces meeting the slab (cube sides, not caps)", () => {
  const { Cleanup } = loadModules();
  const m = makeClosedCube(); // 2x2x2; faces 0,1 bottom (z=0), 2,3 top (z=2), 4..11 sides
  const faces = Array.from(Cleanup.ringFaces(m, 4, [0, 1, 1], [0, 0, 1], 0.25)).sort((a, b) => a - b);
  assert.deepStrictEqual(faces, [4, 5, 6, 7, 8, 9, 10, 11]);
  // a slab containing the top cap (z=2) pulls the cap in too
  const withTop = Array.from(Cleanup.ringFaces(m, 4, [0, 1, 1.9], [0, 0, 1], 0.25));
  assert.ok(withTop.includes(2) && withTop.includes(3), "top cap included");
  assert.ok(!withTop.includes(0) && !withTop.includes(1), "bottom cap excluded");
});

test("ringFaces returns empty when the seed face misses the slab", () => {
  const { Cleanup } = loadModules();
  const m = makeClosedCube();
  assert.strictEqual(Cleanup.ringFaces(m, 0, [0, 1, 1], [0, 0, 1], 0.25).length, 0); // bottom cap
  assert.strictEqual(Cleanup.ringFaces(m, 99, [0, 1, 1], [0, 0, 1], 0.25).length, 0); // out of range
});

test("ringLeaves keeps only in-slab leaves of the given faces", () => {
  const { Cleanup } = loadModules();
  const m = makeCylinder(8, 1, 10, 0);
  const g = Cleanup.buildSubGraph(m);
  // a slab around z=10/3 contains the centroids of the (v_i, v_j, v_j') faces
  const leaves = Array.from(Cleanup.ringLeaves(m, [0, 1, 2], [1, 0, 10 / 3], [0, 0, 1], 0.5));
  for (const s of leaves) {
    assert.ok([0, 1, 2].includes(g.subFace[s]), "leaf on a given face");
    assert.ok(Math.abs(g.cen[s * 3 + 2] - 10 / 3) <= 0.5, "centroid in slab");
  }
  assert.ok(leaves.length > 0, "found the low-centroid faces' leaves");
});
