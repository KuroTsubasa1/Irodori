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
