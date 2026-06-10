const test = require("node:test");
const assert = require("node:assert");
const { loadModules } = require("./harness");

test("dpFill: a triangle passes through unchanged", () => {
  const { Liepa } = loadModules();
  const tris = Liepa.dpFill([[0, 0, 0], [2, 0, 0], [0, 2, 0]]);
  assert.deepEqual(tris, [[0, 1, 2]]);
});

test("dpFill: a planar square yields two triangles covering it", () => {
  const { Liepa } = loadModules();
  const tris = Liepa.dpFill([[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]]);
  assert.equal(tris.length, 2);
  let area = 0;
  for (const [a, b, c] of tris) area += 0.5 * 2 * 2; // each half of the 2x2 square
  assert.equal(area, 4);
});

test("dpFill: a bent quad picks the flatter diagonal", () => {
  const { Liepa } = loadModules();
  // fold the quad along the 1-3 diagonal: corners 0 and 2 lifted, 1 and 3 on the floor.
  // Splitting along 1-3 gives two coplanar-with-floor-ish triangles (dihedral 0 across
  // the fold line is impossible; the flat split is 1-3, the creased one is 0-2).
  const pts = [[0, 0, 1], [2, 0, 0], [4, 0, 1], [2, 2, 0]];
  const tris = Liepa.dpFill(pts);
  assert.equal(tris.length, 2);
  const usesDiag13 = tris.every((t) => t.includes(1) && t.includes(3));
  assert.ok(usesDiag13, "min-dihedral DP chooses the 1-3 diagonal, got " + JSON.stringify(tris));
});

// every fine rim edge (consecutive loop indices) must appear in the cap's
// boundary exactly once; internal edges exactly twice.
function rimCoverage(n, tris) {
  const m = new Map();
  const key = (a, b) => (a < b ? a + "_" + b : b + "_" + a);
  for (const [a, b, c] of tris) for (const [u, v] of [[a, b], [b, c], [c, a]]) m.set(key(u, v), (m.get(key(u, v)) || 0) + 1);
  let rimOnce = 0, rimWrong = 0, internalWrong = 0;
  for (const [k, cnt] of m) {
    const [u, v] = k.split("_").map(Number);
    const isRim = u < n && v < n && ((v - u + n) % n === 1 || (u - v + n) % n === 1);
    if (isRim) { if (cnt === 1) rimOnce++; else rimWrong++; }
    else if (cnt !== 2) internalWrong++;
  }
  return { rimOnce, rimWrong, internalWrong };
}

test("fillLoop (DP-only) covers a wavy 100-vertex rim exactly once per edge", () => {
  const { Liepa } = loadModules();
  const n = 100;
  const loop = [...Array(n).keys()].map((i) => 1000 + i); // arbitrary vids
  const getPt = (vid) => {
    const i = vid - 1000, a = (i / n) * Math.PI * 2;
    return [Math.cos(a) * 10, Math.sin(a) * 10, Math.sin(3 * a) * 1.5]; // wavy circle
  };
  const cap = Liepa.fillLoop(loop, getPt, { maxCoarse: 24, refine: false, fair: false });
  assert.equal(cap.extraPts.length, 0, "DP-only path invents no points");
  const cov = rimCoverage(n, cap.tris);
  assert.equal(cov.rimOnce, n, "all " + n + " rim edges covered once (got " + cov.rimOnce + ")");
  assert.equal(cov.rimWrong, 0);
  assert.equal(cov.internalWrong, 0, "all internal edges paired");
});

test("decimate keeps order, starts at 0, and respects maxCoarse", () => {
  const { Liepa } = loadModules();
  const pts = [...Array(50).keys()].map((i) => { const a = (i / 50) * Math.PI * 2; return [Math.cos(a), Math.sin(a), 0]; });
  const idx = Liepa.decimate(pts, 12);
  assert.equal(idx[0], 0);
  assert.ok(idx.length <= 13 && idx.length >= 10, "got " + idx.length);
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1], "ascending");
});

test("refine inserts interior points and preserves rim coverage", () => {
  const { Liepa } = loadModules();
  const n = 60;
  const loop = [...Array(n).keys()];
  const getPt = (i) => { const a = (i / n) * Math.PI * 2; return [Math.cos(a) * 10, Math.sin(a) * 10, 0]; };
  const cap = Liepa.fillLoop(loop, getPt, { maxCoarse: 16, refine: true, fair: false });
  assert.ok(cap.extraPts.length > 0, "interior points inserted (rim edges ~1, coarse cap tris huge)");
  const cov = rimCoverage(n, cap.tris);
  assert.equal(cov.rimOnce, n, "rim still covered exactly once");
  assert.equal(cov.rimWrong, 0);
  assert.equal(cov.internalWrong, 0, "interior edges still paired after splits+flips");
});

test("fair smooths interior points, pins the rim, and obeys the maximum principle", () => {
  const { Liepa } = loadModules();
  const n = 60;
  const loop = [...Array(n).keys()];
  const getPt = (i) => { const a = (i / n) * Math.PI * 2; return [Math.cos(a) * 10, Math.sin(a) * 10, Math.sin(2 * a) * 2]; }; // saddle rim
  const rough = Liepa.fillLoop(loop, getPt, { maxCoarse: 16, refine: true, fair: false });
  const smooth = Liepa.fillLoop(loop, getPt, { maxCoarse: 16, refine: true, fair: true });
  assert.equal(rough.extraPts.length, smooth.extraPts.length, "same topology");
  assert.ok(rough.extraPts.length > 0);
  let moved = 0;
  for (let i = 0; i < rough.extraPts.length; i++) if (rough.extraPts[i].some((v, k) => Math.abs(v - smooth.extraPts[i][k]) > 1e-9)) moved++;
  assert.ok(moved > 0, "fairing moved interior points");
  // maximum principle per coordinate: faired interior stays inside the rim's bounds
  for (let k = 0; k < 3; k++) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { const v = getPt(i)[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
    for (const p of smooth.extraPts) assert.ok(p[k] >= lo - 1e-6 && p[k] <= hi + 1e-6, "coord " + k + " inside rim range");
  }
});

test("fillLoop stays within budget on a fractal-scale rim (regression: density blow-up)", () => {
  const { Liepa } = loadModules();
  // a rim whose edge lengths are ~100x smaller than the opening (like fractal
  // paint boundaries): the old rim-density target demanded millions of
  // triangles here; the sigma floor must hold the budget instead.
  const n = 1200;
  const loop = [...Array(n).keys()];
  const getPt = (i) => {
    const a = (i / n) * Math.PI * 2;
    const r = 10 + 0.15 * Math.sin(37 * a);
    return [Math.cos(a) * r, Math.sin(a) * r, 0.4 * Math.sin(5 * a)];
  };
  const t0 = Date.now();
  const cap = Liepa.fillLoop(loop, getPt); // default opts — the production path
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, "completed in " + ms + "ms");
  assert.ok(cap.tris.length <= 3000, "triangle budget held (" + cap.tris.length + ")");
  assert.ok(cap.extraPts.length > 2, "real refinement, not a fallback fan (" + cap.extraPts.length + ")");
  const cov = rimCoverage(n, cap.tris);
  assert.equal(cov.rimOnce, n, "rim covered exactly once");
  assert.equal(cov.internalWrong, 0, "interior edges paired");
});
