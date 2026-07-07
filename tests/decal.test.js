const test = require("node:test");
const assert = require("node:assert");
const { loadModules } = require("./harness");

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
