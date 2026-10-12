const test = require("node:test");
const assert = require("node:assert");
const { loadModules, makeGridBox, makeRoofPrism, makeUChannel, makeBentStrip, signedVolume } = require("./harness");

const flat = (m) => { const I = []; for (let f = 0; f < m.nf; f++) I.push(m.v1[f], m.v2[f], m.v3[f]); return I; };
const vol = (m) => signedVolume(flat(m), m.positions);
// faces whose centroid satisfies pred(x,y,z) -> paint them `state`; returns face list
function paintWhere(mesh, pred, state) {
  const P = mesh.positions, out = [];
  for (let f = 0; f < mesh.nf; f++) {
    const a = mesh.v1[f] * 3, b = mesh.v2[f] * 3, c = mesh.v3[f] * 3;
    const x = (P[a] + P[b] + P[c]) / 3, y = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, z = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    if (pred(x, y, z)) { mesh.paints[f] = String(state << 2); out.push(f); } // solid leaf: nibble (state<<2)
  }
  return out;
}
// seed sub of a state (solid faces: sub index == face index)
function regionOf(Cleanup, mesh, state) {
  const g = Cleanup.buildSubGraph(mesh);
  const seed = [...Array(g.NS).keys()].find((i) => g.subLeaf[i].state === state);
  return Cleanup.selectColorRegion(mesh, seed);
}

test("fixtures: grid box and roof prism are closed with the expected volume", () => {
  const { MeshGeo } = loadModules();
  const box = makeGridBox(4, 4, 4, 4), roof = makeRoofPrism(4, 3, 2, 4);
  assert.strictEqual(MeshGeo.checkClosed(box), 0);
  assert.ok(Math.abs(vol(box) - 64) < 1e-6, "box volume " + vol(box));
  assert.strictEqual(MeshGeo.checkClosed(roof), 0);
  assert.ok(Math.abs(vol(roof) - 12) < 1e-6, "roof volume " + vol(roof));
  const u = makeUChannel(4);
  assert.strictEqual(MeshGeo.checkClosed(u), 0);
  assert.ok(Math.abs(vol(u) - 48) < 1e-6, "u-channel volume " + vol(u));
  assert.strictEqual(box.nf, 6 * 16 * 2);
  assert.strictEqual(roof.nf, 8 * 16);
});

test("patchBoundary: one surface-directed loop around a central top block", () => {
  const { Cleanup, Split } = loadModules();
  const box = makeGridBox(4, 4, 4, 4);
  paintWhere(box, (x, y, z) => z === 4 && x > 1 && x < 3 && y > 1 && y < 3, 1);
  const subs = regionOf(Cleanup, box, 1);
  assert.strictEqual(subs.length, 8);
  const g = Cleanup.buildSubGraph(box);
  const b = Split.patchBoundary(box, subs, g);
  assert.strictEqual(b.pinch, false);
  assert.strictEqual(b.loops.length, 1);
  assert.strictEqual(b.loops[0].length, 8);
  // consecutive pairs follow the surface direction recorded in surfDir
  const L = b.loops[0];
  for (let i = 0; i < L.length; i++) {
    const u = L[i], v = L[(i + 1) % L.length];
    assert.strictEqual(b.surfDir.get(u < v ? u + "_" + v : v + "_" + u), u + ">" + v);
  }
});

test("patchBoundary flags a pinch (two holes meeting at a vertex)", () => {
  const { Cleanup, Split } = loadModules();
  const box = makeGridBox(4, 4, 4, 4);
  const hole = (x, y) => (x > 1 && x < 2 && y > 1 && y < 2) || (x > 2 && x < 3 && y > 2 && y < 3);
  paintWhere(box, (x, y, z) => z === 4 && !hole(x, y), 1);
  const subs = regionOf(Cleanup, box, 1);
  assert.strictEqual(Split.patchBoundary(box, subs, Cleanup.buildSubGraph(box)).pinch, true);
});

test("rimFrame: flat interior rim -> straight down, t = depth; slab clamps to half thickness", () => {
  const { Cleanup, Split, MeshGeo } = loadModules();
  for (const [sz, depth, want] of [[4, 0.5, 0.5], [0.5, 10, 0.25]]) {
    const box = makeGridBox(4, 4, 4, sz);
    paintWhere(box, (x, y, z) => z === sz && x > 1 && x < 3 && y > 1 && y < 3, 1);
    const subs = regionOf(Cleanup, box, 1);
    const g = Cleanup.buildSubGraph(box);
    const b = Split.patchBoundary(box, subs, g);
    const fr = Split.rimFrame(box, g, b.loops, depth, MeshGeo.faceGrid(box));
    for (const gid of b.loops[0]) {
      const d = fr.dir.get(gid);
      assert.ok(Math.abs(d[0]) < 1e-6 && Math.abs(d[1]) < 1e-6 && Math.abs(d[2] + 1) < 1e-6, "inward -z: " + d);
      assert.ok(Math.abs(fr.t.get(gid) - want) < 1e-6, "t=" + fr.t.get(gid) + " want " + want);
    }
  }
});

test("rimFrame: cross-section rim (upper half of the box) gets no wall", () => {
  const { Cleanup, Split, MeshGeo } = loadModules();
  const box = makeGridBox(4, 4, 4, 4);
  paintWhere(box, (x, y, z) => z > 2, 1); // top + upper two rows of every side
  const subs = regionOf(Cleanup, box, 1);
  const g = Cleanup.buildSubGraph(box);
  const b = Split.patchBoundary(box, subs, g);
  assert.strictEqual(b.loops.length, 1);
  const fr = Split.rimFrame(box, g, b.loops, 1, MeshGeo.faceGrid(box));
  for (const gid of b.loops[0]) assert.ok(fr.t.get(gid) < 1e-6, "t " + fr.t.get(gid));
});

test("rimNormals: a T-junction midpoint on a crease sees both sides of the rim", () => {
  const { Cleanup, Split, Paint } = loadModules();
  const mesh = makeBentStrip(90, false);
  const L = { leaf: true, state: 1 };
  mesh.paints = ["4", Paint.encode({ leaf: false, split: 3, special: 0, kids: [L, L, L, L] }), "", ""];
  const subs = regionOf(Cleanup, mesh, 1);
  const g = Cleanup.buildSubGraph(mesh);
  const b = Split.patchBoundary(mesh, subs, g);
  assert.strictEqual(b.pinch, false);
  const loop = b.loops[0];
  const N = Split.rimNormals(mesh, g, new Set(loop));
  const M = loop.find((id) => Math.abs(g.vx[id] - 1) < 1e-6 && Math.abs(g.vy[id] - 1) < 1e-6 && Math.abs(g.vz[id]) < 1e-6);
  assert.ok(M !== undefined, "midpoint M on the hinge is a rim vertex");
  const P = mesh.positions, q = (i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  const a = q(mesh.v1[2]), bb = q(mesh.v2[2]), c = q(mesh.v3[2]);
  const u = [bb[0] - a[0], bb[1] - a[1], bb[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  let n2 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const l2 = Math.hypot(...n2); n2 = n2.map((x) => x / l2);
  const n = N.get(M);
  assert.ok(n[2] > 0.3, "+z component " + n);
  assert.ok(n[0] * n2[0] + n[1] * n2[1] + n[2] * n2[2] > 0.3, "band-2 component " + n + " vs " + n2);
});

const closed = (MeshGeo, m, label) => assert.strictEqual(MeshGeo.checkClosed(m), 0, label + " closed");

test("plugSolids: flat plug — volumes sum, bottom at depth, both closed", () => {
  const { Cleanup, Split, MeshGeo } = loadModules();
  const box = makeGridBox(4, 4, 4, 4);
  paintWhere(box, (x, y, z) => z === 4 && x > 1 && x < 3 && y > 1 && y < 3, 1);
  const r = Split.plugSolids(box, regionOf(Cleanup, box, 1), { depth: 0.5 });
  assert.ok(!r.error, r.error);
  closed(MeshGeo, r.part, "part"); closed(MeshGeo, r.remainder, "remainder");
  assert.ok(Math.abs(vol(r.part) - 2) < 1e-6, "part volume " + vol(r.part));
  assert.ok(Math.abs(vol(r.remainder) - 62) < 1e-6, "remainder volume " + vol(r.remainder));
  let minZ = Infinity; for (let i = 2; i < r.part.positions.length; i += 3) minZ = Math.min(minZ, r.part.positions[i]);
  assert.ok(Math.abs(minZ - 3.5) < 1e-6, "bottom at 3.5, got " + minZ);
  assert.strictEqual(r.info.halvings, 0);
  // colors: every part triangle is state 1 ("4"); remainder pocket carries the border color (0 -> "")
  assert.ok(r.part.paints.every((p) => p === "4"));
  assert.strictEqual(r.remainder.paints.filter((p) => p === "4").length, 0);
});

test("plugSolids: slab clamps depth to half thickness", () => {
  const { Cleanup, Split, MeshGeo } = loadModules();
  const slab = makeGridBox(4, 4, 4, 0.5);
  paintWhere(slab, (x, y, z) => z === 0.5 && x > 1 && x < 3 && y > 1 && y < 3, 1);
  const r = Split.plugSolids(slab, regionOf(Cleanup, slab, 1), { depth: 10 });
  assert.ok(!r.error, r.error);
  closed(MeshGeo, r.part, "part"); closed(MeshGeo, r.remainder, "remainder");
  assert.ok(Math.abs(vol(r.part) - 1) < 1e-6, "part volume " + vol(r.part));
  assert.ok(Math.abs(vol(r.part) + vol(r.remainder) - 8) < 1e-6);
});

test("plugSolids: cross-section rim adds no wall (part == lens)", () => {
  const { Cleanup, Split, MeshGeo } = loadModules();
  const box = makeGridBox(4, 4, 4, 4);
  const faces = paintWhere(box, (x, y, z) => z > 2, 1);
  const r = Split.plugSolids(box, regionOf(Cleanup, box, 1), { depth: 1, method: "earcut" });
  assert.ok(!r.error, r.error);
  closed(MeshGeo, r.part, "part"); closed(MeshGeo, r.remainder, "remainder");
  assert.ok(Math.abs(vol(r.part) - 32) < 1e-6, "lens volume " + vol(r.part));
  assert.ok(Math.abs(vol(r.remainder) - 32) < 1e-6);
  // no wall: every part vertex is on the original surface (z >= 2)
  for (let i = 2; i < r.part.positions.length; i += 3) assert.ok(r.part.positions[i] >= 2 - 1e-9);
  assert.ok(r.part.nf >= faces.length, "patch kept");
});

test("plugSolids: band over a convex ridge stays clean (clamp + cos weight keep walls apart)", () => {
  const { Cleanup, Split, MeshGeo } = loadModules();
  const roof = makeRoofPrism(4, 3, 2, 4);
  const P = roof.positions;
  for (let f = 0; f < roof.nf; f++) {
    const y = (P[roof.v1[f] * 3 + 1] + P[roof.v2[f] * 3 + 1] + P[roof.v3[f] * 3 + 1]) / 3;
    if ((roof.side[f] === "left" || roof.side[f] === "right") && y > 1.5) roof.paints[f] = "4";
  }
  const r = Split.plugSolids(roof, regionOf(Cleanup, roof, 1), { depth: 10 });
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.info.halvings, 0);
  closed(MeshGeo, r.part, "part"); closed(MeshGeo, r.remainder, "remainder");
  assert.ok(vol(r.part) > 0 && vol(r.remainder) > 0);
  assert.ok(Math.abs(vol(r.part) + vol(r.remainder) - 12) < 1e-6);
});

test("plugSolids: a pocket-shaped region (groove) runs halving to the shell and is refused as inside-out", () => {
  const { Cleanup, Split } = loadModules();
  const m = makeUChannel(4);
  for (let f = 0; f < m.nf; f++) if (m.edge[f] === 4 || m.edge[f] === 5 || m.edge[f] === 6) m.paints[f] = "4"; // groove walls + floor
  const r = Split.plugSolids(m, regionOf(Cleanup, m, 1), { depth: 5 });
  assert.match(r.error, /clean solid/);
  assert.strictEqual(r.info.shell, true);
  assert.strictEqual(r.info.halvings, 4);
});

test("plugSolids refuses pinch, whole-mesh and empty regions", () => {
  const { Cleanup, Split } = loadModules();
  const box = makeGridBox(4, 4, 4, 4);
  const hole = (x, y) => (x > 1 && x < 2 && y > 1 && y < 2) || (x > 2 && x < 3 && y > 2 && y < 3);
  paintWhere(box, (x, y, z) => z === 4 && !hole(x, y), 1);
  assert.match(Split.plugSolids(box, regionOf(Cleanup, box, 1), { depth: 1 }).error, /touches itself/);
  const all = makeGridBox(2, 2, 2, 2);
  paintWhere(all, () => true, 1);
  assert.match(Split.plugSolids(all, regionOf(Cleanup, all, 1), { depth: 1 }).error, /whole object/);
  assert.match(Split.plugSolids(all, [], { depth: 1 }).error, /Nothing/);
});

test("plugSolids: refined (subdivided) paint splits to closed outputs", () => {
  const { Cleanup, Split, MeshGeo, Paint } = loadModules();
  const box = makeGridBox(2, 4, 4, 4);
  const top = paintWhere(box, (x, y, z) => z === 4, 1);
  const leaf = { leaf: true, state: 1 };
  box.paints[top[0]] = Paint.encode({ leaf: false, split: 3, special: 0, kids: [leaf, leaf, leaf, leaf] });
  const r = Split.plugSolids(box, regionOf(Cleanup, box, 1), { depth: 1 });
  assert.ok(!r.error, r.error);
  closed(MeshGeo, r.part, "part"); closed(MeshGeo, r.remainder, "remainder");
  assert.ok(Math.abs(vol(r.part) + vol(r.remainder) - 64) < 1e-6);
});

test("plugSolids: chained split -> split on remainder -> plane cut conserves volume", () => {
  const { Cleanup, Split, MeshGeo, PlaneCut } = loadModules();
  const box = makeGridBox(4, 4, 4, 4);
  paintWhere(box, (x, y, z) => z === 4 && x > 1 && x < 3 && y > 1 && y < 3, 1);
  paintWhere(box, (x, y, z) => x === 4 && z > 1 && z < 3 && y > 1 && y < 3, 2);
  const a = Split.plugSolids(box, regionOf(Cleanup, box, 1), { depth: 0.5 });
  assert.ok(!a.error, a.error);
  const b = Split.plugSolids(a.remainder, regionOf(Cleanup, a.remainder, 2), { depth: 0.7 });
  assert.ok(!b.error, b.error);
  const cut = PlaneCut.cutMesh(a.part, { px: 0, py: 0, pz: 3.75, nx: 0, ny: 0, nz: 1 });
  assert.ok(cut.above && cut.below, "plane crosses the part");
  const pieces = [b.remainder, b.part, cut.above, cut.below];
  for (const m of pieces) closed(MeshGeo, m, "piece");
  const total = pieces.reduce((s, m) => s + vol(m), 0);
  assert.ok(Math.abs(total - 64) < 1e-5, "total " + total);
});
