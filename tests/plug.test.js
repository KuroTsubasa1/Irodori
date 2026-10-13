const test = require("node:test");
const assert = require("node:assert");
const { loadModules, makeGridBox, makeRoofPrism, makeUChannel, makePocketBox, makeHeightBox, signedVolume } = require("./harness");

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
  const pk = makePocketBox();
  assert.strictEqual(MeshGeo.checkClosed(pk), 0);
  assert.ok(Math.abs(vol(pk) - 56) < 1e-6, "pocket box volume " + vol(pk));
  assert.strictEqual(pk.nf, 28);
  assert.strictEqual(box.nf, 6 * 16 * 2);
  assert.strictEqual(roof.nf, 8 * 16);
});

test("plugField: flat interior -> straight down, s = depth; slab clamps to half thickness", () => {
  const { Cleanup, Split } = loadModules();
  for (const [sz, depth, want] of [[4, 0.5, 0.5], [0.5, 10, 0.25]]) {
    const box = makeGridBox(4, 4, 4, sz);
    paintWhere(box, (x, y, z) => z === sz && x > 1 && x < 3 && y > 1 && y < 3, 1);
    const subs = regionOf(Cleanup, box, 1);
    const fr = Split.plugField(box, subs, depth);
    assert.strictEqual(fr.t.size, 9, "3x3 patch vertices");
    for (const [gid, d] of fr.dir) {
      assert.ok(Math.abs(d[0]) < 1e-6 && Math.abs(d[1]) < 1e-6 && Math.abs(d[2] + 1) < 1e-6, "inward -z: " + d);
      assert.ok(Math.abs(fr.t.get(gid) - want) < 1e-6, "s=" + fr.t.get(gid) + " want " + want);
    }
  }
});

// The depth ramps to 0 where D would slide along ANY incident face: the gable
// ends of the ridge are vertical, D is -z, so the rim vertices on the gable
// edges get no depth (else the wall would lie in the gable plane).
test("plugField: transversality is checked against both rim sides (vertical gable edge gets s = 0)", () => {
  const { Cleanup, Split } = loadModules();
  const roof = makeRoofPrism(4, 3, 2, 4);
  const P = roof.positions;
  for (let f = 0; f < roof.nf; f++) {
    const y = (P[roof.v1[f] * 3 + 1] + P[roof.v2[f] * 3 + 1] + P[roof.v3[f] * 3 + 1]) / 3;
    if ((roof.side[f] === "left" || roof.side[f] === "right") && y > 1.5) roof.paints[f] = "4";
  }
  const g = Cleanup.buildSubGraph(roof);
  const fr = Split.plugField(roof, regionOf(Cleanup, roof, 1), 10);
  let ends = 0, mid = 0;
  for (const [gid, s] of fr.t) {
    const z = g.vz[gid];
    if (z < 1e-6 || z > 2 - 1e-6) { ends++; assert.ok(s < 1e-9, "gable vertex depth " + s); }
    else if (Math.abs(z - 1) < 1e-6) { mid++; assert.ok(s > 0.1, "mid-length vertex depth " + s); }
  }
  assert.ok(ends > 0 && mid > 0);
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

// Bottom = displaced patch ("skin"): a region spanning a cross-section (top +
// upper half of the sides) becomes a uniform-depth cup, not a lens; the rim
// wall is horizontal, so nothing goes below the rim plane.
test("plugSolids: cross-section region becomes a uniform-depth cup", () => {
  const { Cleanup, Split, MeshGeo } = loadModules();
  const box = makeGridBox(4, 4, 4, 4);
  paintWhere(box, (x, y, z) => z > 2, 1); // top + upper two rows of every side
  const r = Split.plugSolids(box, regionOf(Cleanup, box, 1), { depth: 1 });
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.info.halvings, 0);
  closed(MeshGeo, r.part, "part"); closed(MeshGeo, r.remainder, "remainder");
  assert.ok(Math.abs(vol(r.part) + vol(r.remainder) - 64) < 1e-6);
  // thinner than the 32-unit lens, thicker than a 1-unit skin over the 32 sq. units of patch minus corner losses
  assert.ok(vol(r.part) > 20 && vol(r.part) < 32 - 1, "cup volume " + vol(r.part));
  for (let i = 2; i < r.part.positions.length; i += 3) assert.ok(r.part.positions[i] >= 2 - 1e-6, "below the rim plane");
});

test("plugSolids: band over a convex ridge stays clean", () => {
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

// 64 sub-triangles per face (three 4-way levels): the coarse fixtures have
// every vertex on a sharp crease, where transversality forces depth 0.
const finePaint = (Paint) => { const L = { leaf: true, state: 1 }, q = (k) => ({ leaf: false, split: 3, special: 0, kids: [k, k, k, k] }); return Paint.encode(q(q(q(L)))); };

test("plugSolids: a through-groove gets a liner that follows the groove", () => {
  const { Cleanup, Split, MeshGeo, Paint } = loadModules();
  for (const depth of [0.25, 5]) {
    const m = makeUChannel(4);
    for (let f = 0; f < m.nf; f++) if (m.edge[f] === 4 || m.edge[f] === 5 || m.edge[f] === 6) m.paints[f] = finePaint(Paint); // groove walls + floor
    const r = Split.plugSolids(m, regionOf(Cleanup, m, 1), { depth });
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.info.halvings, 0);
    closed(MeshGeo, r.part, "part"); closed(MeshGeo, r.remainder, "remainder");
    assert.ok(vol(r.part) > 0);
    assert.ok(Math.abs(vol(r.part) + vol(r.remainder) - 48) < 1e-6);
  }
});

// The old cap-on-offset-loop bottom closed the pocket's AIR and was refused as
// inside-out; the skin lines the pocket instead.
test("plugSolids: a closed pocket region becomes a liner (no longer refused)", () => {
  const { Cleanup, Split, MeshGeo, Paint } = loadModules();
  for (const depth of [0.3, 5]) {
    const m = makePocketBox();
    for (let f = 0; f < m.nf; f++) if (m.side[f] === "wall" || m.side[f] === "floor") m.paints[f] = finePaint(Paint);
    const r = Split.plugSolids(m, regionOf(Cleanup, m, 1), { depth });
    assert.ok(!r.error, r.error);
    closed(MeshGeo, r.part, "part"); closed(MeshGeo, r.remainder, "remainder");
    assert.ok(vol(r.part) > 0 && vol(r.remainder) > 0);
    assert.ok(Math.abs(vol(r.part) + vol(r.remainder) - 56) < 1e-6);
  }
});

// Fractal paint rims touch themselves at isolated vertices (1-13 per region on
// the sample); the old pinch refusal rejected all such regions. Each wedge of
// patch triangles around a pinch vertex gets its own skin copy instead.
test("plugSolids: a region touching itself at a vertex splits (per-wedge skin copies)", () => {
  const { Cleanup, Split, MeshGeo } = loadModules();
  const box = makeGridBox(4, 4, 4, 4);
  const hole = (x, y) => (x > 1 && x < 2 && y > 1 && y < 2) || (x > 2 && x < 3 && y > 2 && y < 3);
  paintWhere(box, (x, y, z) => z === 4 && !hole(x, y), 1);
  const r = Split.plugSolids(box, regionOf(Cleanup, box, 1), { depth: 1 });
  assert.ok(!r.error, r.error);
  closed(MeshGeo, r.part, "part"); closed(MeshGeo, r.remainder, "remainder");
  assert.ok(vol(r.part) > 0);
  assert.ok(Math.abs(vol(r.part) + vol(r.remainder) - 64) < 1e-6);
});

test("plugSolids refuses whole-mesh, empty and zero-depth requests", () => {
  const { Cleanup, Split } = loadModules();
  const all = makeGridBox(2, 2, 2, 2);
  paintWhere(all, () => true, 1);
  assert.match(Split.plugSolids(all, regionOf(Cleanup, all, 1), { depth: 1 }).error, /whole object/);
  assert.match(Split.plugSolids(all, [], { depth: 1 }).error, /Nothing/);
  const box = makeGridBox(4, 4, 4, 4);
  paintWhere(box, (x, y, z) => z === 4 && x > 1 && x < 3 && y > 1 && y < 3, 1);
  assert.match(Split.plugSolids(box, regionOf(Cleanup, box, 1), { depth: 0 }).error, /depth/);
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

// Real-data failure class (sample belly: halvings 4 -> shell -> refused). A
// region with a staircase rim on a curved surface: the old per-vertex rim
// normal/depth tangled the offset curve (rim edges << depth), the Liepa cap of
// the jagged offset loop folded, and the shell's cap diagonals duplicated
// surface edges. Skin + Euclidean-smooth field: clean at full depth.
test("plugSolids: staircase rim on a curved surface splits cleanly at full depth", () => {
  const { Cleanup, Split, MeshGeo } = loadModules();
  const m = makeHeightBox(24, 4, (x, y) => 4 + 0.6 * Math.cos((x - 2) * 0.7) * Math.cos((y - 2) * 0.7));
  const P = m.positions;
  for (let f = 0; f < m.nf; f++) {
    if (!m.top[f]) continue;
    const a = m.v1[f] * 3, b = m.v2[f] * 3, c = m.v3[f] * 3;
    const x = (P[a] + P[b] + P[c]) / 3 - 2, y = (P[a + 1] + P[b + 1] + P[c + 1]) / 3 - 2;
    if (Math.hypot(x, y) < 1.2 + 0.25 * Math.sin(5 * Math.atan2(y, x))) m.paints[f] = "4";
  }
  const before = vol(m);
  const r = Split.plugSolids(m, regionOf(Cleanup, m, 1), { depth: 1 });
  assert.ok(!r.error, r.error + " " + JSON.stringify(r.info));
  assert.strictEqual(r.info.halvings, 0);
  closed(MeshGeo, r.part, "part"); closed(MeshGeo, r.remainder, "remainder");
  assert.ok(vol(r.part) > 2, "plug has real depth: " + vol(r.part));
  assert.ok(Math.abs(vol(r.part) + vol(r.remainder) - before) < 1e-5);
});

// A sharp V-notch inside the region: the valley's faces nearly face each
// other, so D slides along them (transversality 0) and the valley line stays
// welded while both flanks keep depth — patch and both skins would share the
// valley edges (each used 4x). The valley ends are un-welded instead.
test("plugSolids: a welded crease line inside the region does not pinch the part", () => {
  const { Cleanup, Split, MeshGeo } = loadModules();
  const m = makeHeightBox(40, 4, (x) => 4 - Math.max(0, 1 - Math.abs(x - 2) / 0.1));
  for (let f = 0; f < m.nf; f++) if (m.top[f]) m.paints[f] = "4";
  const before = vol(m);
  const r = Split.plugSolids(m, regionOf(Cleanup, m, 1), { depth: 0.3 });
  assert.ok(!r.error, r.error + " " + JSON.stringify(r.info));
  closed(MeshGeo, r.part, "part"); closed(MeshGeo, r.remainder, "remainder");
  assert.ok(vol(r.part) > 1, "plug volume " + vol(r.part));
  assert.ok(Math.abs(vol(r.part) + vol(r.remainder) - before) < 1e-5);
});

// Fix round 1: contact must be a property of the CROSSING, not of triangle
// size. A tiny new triangle whose vertices are all 1 deep (plug material)
// poking through the cube's top face is a penetration even though the
// triangle is far smaller than the contact tolerance; one lying in the
// surface layer (depth 0) touching the face is contact.
test("plug gate: tiny deep triangle through a face is a crossing; a surface-layer one is contact", () => {
  const { Split, MeshGeo } = loadModules();
  const { makeClosedCube } = require("./harness");
  const cube = makeClosedCube(); // [0,2]^3
  const grid = MeshGeo.faceGrid(cube), tol = 1e-3 * MeshGeo.meshBounds(cube).diag; // ~0.0035
  const P = [[1, 1, 1.999], [1.002, 1, 2.001], [1, 1.002, 2.001]]; // 0.002 mm, straddles z = 2
  const pos = (id) => P[id], canon = (id) => id;
  assert.strictEqual(Split._plugIntersects(cube, grid, [0, 1, 2], pos, () => 1, canon, tol), true, "deep: penetration");
  assert.strictEqual(Split._plugIntersects(cube, grid, [0, 1, 2], pos, () => 0, canon, tol), false, "surface layer: contact");
});
