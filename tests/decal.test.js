const test = require("node:test");
const assert = require("node:assert");
const { loadModules } = require("./harness");
const { makeBigTriangle } = require("./harness");

function totalLeaves(Paint, mesh) {
  let n = 0; for (const p of mesh.paints) n += Paint.leafCount(Paint.decode(p)); return n;
}

test("frame is orthonormal with n preserved", () => {
  const { Decal } = loadModules();
  const f = Decal.frame(0, 0, 0, 0, 0, 1, 0, 1, 0, 0);
  // n unchanged
  assert.ok(Math.abs(f.nx) < 1e-9 && Math.abs(f.ny) < 1e-9 && Math.abs(f.nz - 1) < 1e-9);
  // r,u,n mutually orthonormal
  const dot = (ax, ay, az, bx, by, bz) => ax * bx + ay * by + az * bz;
  assert.ok(Math.abs(dot(f.rx, f.ry, f.rz, f.ux, f.uy, f.uz)) < 1e-9, "r⊥u");
  assert.ok(Math.abs(dot(f.rx, f.ry, f.rz, f.nx, f.ny, f.nz)) < 1e-9, "r⊥n");
  assert.ok(Math.abs(dot(f.ux, f.uy, f.uz, f.nx, f.ny, f.nz)) < 1e-9, "u⊥n");
  assert.ok(Math.abs(Math.hypot(f.rx, f.ry, f.rz) - 1) < 1e-9, "r unit");
});

test("frame falls back when refUp parallel to n", () => {
  const { Decal } = loadModules();
  // n = +Y, refUp = +Y (parallel) -> must not produce NaN
  const f = Decal.frame(0, 0, 0, 0, 1, 0, 0, 1, 0, 0);
  assert.ok(Number.isFinite(f.rx) && Number.isFinite(f.ux));
  assert.ok(Math.abs(Math.hypot(f.rx, f.ry, f.rz) - 1) < 1e-9);
});

test("uv maps origin to center and axes to ±0.5", () => {
  const { Decal } = loadModules();
  const f = Decal.frame(0, 0, 0, 0, 0, 1, 0, 1, 0, 0); // r along +X-ish, u along +Y-ish
  const c = Decal.uv(f, 0, 0, 0, 2, 2);
  assert.ok(Math.abs(c.u - 0.5) < 1e-9 && Math.abs(c.v - 0.5) < 1e-9);
  // move one full half-width along r -> u = 1.0
  const p = Decal.uv(f, f.rx, f.ry, f.rz, 2, 2); // point at distance 1 along r; w=2 -> +0.5
  assert.ok(Math.abs(p.u - 1.0) < 1e-9, "u at +half-width");
  // move one full half-width along -r -> u = 0
  const q = Decal.uv(f, -f.rx, -f.ry, -f.rz, 2, 2);
  assert.ok(Math.abs(q.u - 0.0) < 1e-9, "u at -half-width");
  // move one full half-height along u-axis -> v = 1.0
  const r = Decal.uv(f, f.ux, f.uy, f.uz, 2, 2);
  assert.ok(Math.abs(r.v - 1.0) < 1e-9, "v at +half-height");
});

test("frame rotation: rotRad=PI/2 about N=+Z rotates refUp=+Y CCW to u≈(-1,0,0)", () => {
  const { Decal } = loadModules();
  const f = Decal.frame(0, 0, 0, 0, 0, 1, 0, 1, 0, Math.PI / 2);
  assert.ok(Math.abs(f.ux - -1) < 1e-9 && Math.abs(f.uy) < 1e-9 && Math.abs(f.uz) < 1e-9,
    `expected u≈(-1,0,0), got (${f.ux},${f.uy},${f.uz})`);
  const dot = (ax, ay, az, bx, by, bz) => ax * bx + ay * by + az * bz;
  assert.ok(Math.abs(dot(f.rx, f.ry, f.rz, f.ux, f.uy, f.uz)) < 1e-9, "r⊥u");
  assert.ok(Math.abs(dot(f.rx, f.ry, f.rz, f.nx, f.ny, f.nz)) < 1e-9, "r⊥n");
  assert.ok(Math.abs(dot(f.ux, f.uy, f.uz, f.nx, f.ny, f.nz)) < 1e-9, "u⊥n");
  assert.ok(Math.abs(Math.hypot(f.rx, f.ry, f.rz) - 1) < 1e-9, "r unit");
  assert.ok(Math.abs(Math.hypot(f.ux, f.uy, f.uz) - 1) < 1e-9, "u unit");
  assert.ok(Math.abs(Math.hypot(f.nx, f.ny, f.nz) - 1) < 1e-9, "n unit");
});

test("sampleMask thresholds and inverts; out-of-range is transparent", () => {
  const { Decal } = loadModules();
  // 2x2: top-left black(0), rest white(255)
  const mask = { data: Uint8Array.from([0, 255, 255, 255]), w: 2, h: 2, threshold: 128, invert: false };
  // v near 1 = top of image (py=0); u near 0 = left (px=0) -> black -> paint
  assert.equal(Decal.sampleMask(mask, 0.25, 0.75), true);
  assert.equal(Decal.sampleMask(mask, 0.75, 0.75), false); // top-right white
  assert.equal(Decal.sampleMask(mask, 1.5, 0.5), false);   // out of range
  const inv = Object.assign({}, mask, { invert: true });
  assert.equal(Decal.sampleMask(inv, 0.25, 0.75), false);  // inverted: black now transparent
});

test("stampMask with an all-black mask paints the covered footprint", () => {
  const { Paint, Cleanup, Decal } = loadModules();
  const mesh = makeBigTriangle();
  const g = Cleanup.buildSubGraph(mesh);
  // pick the centroid of sub 0 and its face normal ~ +Z for makeBigTriangle (in XY plane)
  const cx = g.cen[0], cy = g.cen[1], cz = g.cen[2];
  const f = Decal.frame(cx, cy, cz, 0, 0, 1, 0, 1, 0, 0);
  const mask = { data: Uint8Array.from([0]), w: 1, h: 1, threshold: 128, invert: false }; // all black
  const res = Cleanup.stampMask(mesh, f, mask, 100, 100, 3, { depthBand: 1, maxDepth: 4 });
  assert.ok(res.count > 0, "painted some leaves");
});

test("stampMask with an all-white mask paints nothing", () => {
  const { Cleanup, Decal } = loadModules();
  const mesh = makeBigTriangle();
  const g = Cleanup.buildSubGraph(mesh);
  const f = Decal.frame(g.cen[0], g.cen[1], g.cen[2], 0, 0, 1, 0, 1, 0, 0);
  const mask = { data: Uint8Array.from([255]), w: 1, h: 1, threshold: 128, invert: false };
  const res = Cleanup.stampMask(mesh, f, mask, 100, 100, 3, { depthBand: 1, maxDepth: 4 });
  assert.equal(res.count, 0, "nothing painted");
});

test("stampMask half/half mask subdivides only near the boundary", () => {
  const { Paint, Cleanup, Decal } = loadModules();
  const mesh = makeBigTriangle();
  const g = Cleanup.buildSubGraph(mesh);
  const before = totalLeaves(Paint, mesh);
  // big footprint centered on the triangle, left half black / right half white
  const bx = (g.vx.reduce((a, b) => a + b, 0)) / g.NV;
  const by = (g.vy.reduce((a, b) => a + b, 0)) / g.NV;
  const bz = (g.vz.reduce((a, b) => a + b, 0)) / g.NV;
  const f = Decal.frame(bx, by, bz, 0, 0, 1, 0, 1, 0, 0);
  const mask = { data: Uint8Array.from([0, 255]), w: 2, h: 1, threshold: 128, invert: false };
  const res = Cleanup.stampMask(mesh, f, mask, 1000, 1000, 3, { depthBand: 5, maxDepth: 4 });
  assert.ok(res.count > 0, "painted the black half");
  assert.ok(totalLeaves(Paint, mesh) > before, "subdivided near the black/white edge");
});
