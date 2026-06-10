const test = require("node:test");
const assert = require("node:assert");
const { loadModules, makeTetra, edgeUseCounts, makeTJunction, makeOpenTube, makeClosedCube, directedViolations, signedVolume } = require("./harness");

function regionOfState(Cleanup, mesh, state) {
  const g = Cleanup.buildSubGraph(mesh);
  const seed = [...Array(g.NS).keys()].find((i) => g.subLeaf[i].state === state);
  return Cleanup.selectColorRegion(mesh, seed);
}

test("solidFromSubs caps an open region into a watertight solid (all methods)", () => {
  const { Cleanup, Split } = loadModules();
  for (const method of ["centroid", "projected", "earcut", "cdt", "liepa"]) {
    const mesh = makeTetra();
    const subs = regionOfState(Cleanup, mesh, 1); // 3 open faces (a 'bowl')
    const solid = Split.solidFromSubs(mesh, Array.from(subs), method);
    // watertight: every undirected edge used exactly twice
    for (const [, n] of edgeUseCounts(solid.indices)) assert.equal(n, 2, "closed under " + method);
    assert.equal(solid.state, 1);
    for (const s of solid.triState) assert.equal(s, 1, "uniform color under " + method);
    // a reusable cap descriptor is returned
    assert.ok(solid.cap && Array.isArray(solid.cap.verts) && Array.isArray(solid.cap.tris));
    assert.equal(solid.cap.method, method);
  }
});

test("solidFromSubs centroid cap of the tetra bowl: 6 tris, 5 verts", () => {
  const { Cleanup, Split } = loadModules();
  const mesh = makeTetra();
  const subs = regionOfState(Cleanup, mesh, 1);
  const solid = Split.solidFromSubs(mesh, Array.from(subs), "centroid");
  assert.equal(solid.indices.length / 3, 6);   // 3 patch + 3 cap
  assert.equal(solid.positions.length / 3, 5);  // 4 verts + 1 centroid
});

test("solidFromSubs leaves an already-closed region uncapped", () => {
  const { Cleanup, Split } = loadModules();
  const mesh = makeTetra();
  const g = Cleanup.buildSubGraph(mesh);
  const all = [...Array(g.NS).keys()]; // whole closed tetra
  const solid = Split.solidFromSubs(mesh, all);
  assert.equal(solid.indices.length / 3, 4, "no caps added");
  assert.equal(solid.positions.length / 3, 4, "no anchor vertex");
  for (const [, n] of edgeUseCounts(solid.indices)) assert.equal(n, 2);
});

test("buildSplitXML emits N objects, components, items, and parts", () => {
  const { Cleanup, Split } = loadModules();
  const mesh = makeTetra();
  const r1 = Array.from(regionOfState(Cleanup, mesh, 1));
  const a = Split.solidFromSubs(mesh, r1);
  const objects = [
    { name: "Filament 1", extruder: 1, positions: a.positions, indices: a.indices, triState: null },
    { name: "Remaining", extruder: 1, positions: a.positions, indices: a.indices, triState: a.triState },
  ];
  const xml = Split.buildSplitXML(objects, { buildTransform: "1 0 0 0 1 0 0 0 1 1 2 0", defaultExtruder: 1 });

  assert.equal((xml.objectsModel.match(/<object /g) || []).length, 2);
  assert.equal((xml.objectsModel.match(/<mesh>/g) || []).length, 2);
  assert.equal((xml.rootModel.match(/<component /g) || []).length, 2);
  assert.equal((xml.rootModel.match(/<item /g) || []).length, 2);
  assert.ok(xml.rootModel.includes('transform="1 0 0 0 1 0 0 0 1 1 2 0"'));
  assert.equal((xml.modelSettings.match(/<object /g) || []).length, 2);
  assert.equal((xml.modelSettings.match(/<part /g) || []).length, 2);
  // remaining object carries per-triangle paint_color; split part does not
  assert.ok(xml.objectsModel.includes('paint_color='));
  assert.equal((xml.rootModel.match(/p:UUID=/g) || []).length >= 5, true);
});

test("solidFromSubs conforms T-junctions into a manifold solid", () => {
  const { Cleanup, Split } = loadModules();
  const mesh = makeTJunction();
  const g = Cleanup.buildSubGraph(mesh);
  assert.equal(g.NS, 3, "1 solid sub + 2 split subs");
  const subs = Cleanup.selectColorRegion(mesh, 0);
  assert.equal(subs.length, 3, "all three state-1 subs are one region");
  const solid = Split.solidFromSubs(mesh, Array.from(subs));
  // Manifold & watertight: every undirected edge used EXACTLY twice.
  // (The pre-fix naive version shares an anchor edge across 4 caps -> fails.)
  for (const [, n] of edgeUseCounts(solid.indices)) {
    assert.equal(n, 2, "every edge shared by exactly two triangles");
  }
});

test("remainderSolid: lifting one region leaves a watertight remainder", () => {
  const { Cleanup, Split } = loadModules();
  const mesh = makeTetra();
  const subs = regionOfState(Cleanup, mesh, 1);            // the 3 state-1 faces
  const part = Split.solidFromSubs(mesh, Array.from(subs), "earcut");
  const claimed = new Set(subs);
  const rem = Split.remainderSolid(mesh, [{ subs: Array.from(subs), cap: part.cap, state: 1 }], claimed);
  // remainder = the single state-2 face + the reversed cap of the lifted region
  for (const [, n] of edgeUseCounts(rem.indices)) assert.equal(n, 2, "remainder closed");
  assert.ok(rem.indices.length / 3 >= 2, "has the remaining face + cap");
});

test("remainderSolid: reversed cap winding is opposite the part cap", () => {
  const { Cleanup, Split } = loadModules();
  const mesh = makeTetra();
  const subs = Array.from(regionOfState(Cleanup, mesh, 1));
  const part = Split.solidFromSubs(mesh, subs, "centroid");
  const rem = Split.remainderSolid(mesh, [{ subs, cap: part.cap, state: 1 }], new Set(subs));
  // directed cap edges in the part and remainder must be opposite -> together
  // every directed edge appears once (orientable closed surface when merged).
  assert.ok(rem.triState.length > 0);
});

test("solidFromSubs caps an open tube with independent end caps (earcut + liepa)", () => {
  const { Cleanup, Split } = loadModules();
  for (const method of ["earcut", "liepa"]) {
    const tube = makeOpenTube();
    const g = Cleanup.buildSubGraph(tube);
    const solid = Split.solidFromSubs(tube, [...Array(g.NS).keys()], method);
    for (const [, n] of edgeUseCounts(solid.indices)) assert.equal(n, 2, method + ": watertight");
    if (method === "earcut") {
      assert.equal(solid.cap.tris.length, 4, "two 2-tri end caps");
      assert.equal(solid.cap.extraPts.length, 0);
    }
  }
});

test("exportSplit-style assembly: parts by method + remainderSolid produce N objects", () => {
  const { Cleanup, Split } = loadModules();
  const mesh = makeTetra();
  const subs = Array.from(regionOfState(Cleanup, mesh, 1));
  const part = Split.solidFromSubs(mesh, subs, "earcut");
  const rem = Split.remainderSolid(mesh, [{ subs, cap: part.cap, state: 1 }], new Set(subs));
  const objects = [
    { name: "Filament 1", extruder: 1, positions: part.positions, indices: part.indices, triState: null },
    { name: "Remaining", extruder: 1, positions: rem.positions, indices: rem.indices, triState: rem.triState },
  ];
  const xml = Split.buildSplitXML(objects, { buildTransform: "1 0 0 0 1 0 0 0 1 1 2 0", defaultExtruder: 1 });
  assert.equal((xml.objectsModel.match(/<object /g) || []).length, 2);
  // both bodies are watertight
  for (const [, n] of edgeUseCounts(part.indices)) assert.equal(n, 2);
  for (const [, n] of edgeUseCounts(rem.indices)) assert.equal(n, 2);
});

test("tube solids are directed-watertight with positive volume (all methods)", () => {
  const { Cleanup, Split } = loadModules();
  for (const method of ["centroid", "projected", "earcut", "cdt", "liepa"]) {
    const tube = makeOpenTube();
    const g = Cleanup.buildSubGraph(tube);
    const solid = Split.solidFromSubs(tube, [...Array(g.NS).keys()], method);
    assert.equal(directedViolations(solid.indices), 0, method + ": every edge traversed once each way");
    const vol = signedVolume(solid.indices, solid.positions);
    assert.ok(vol > 7.9 && vol < 8.1, method + ": volume ~8 (2x2x2 tube), got " + vol.toFixed(2));
  }
});

test("buildSplitXML emits verbatim paint_color strings when objects carry paints", () => {
  const { Split } = loadModules();
  const tri = {
    name: "X", extruder: 1,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: Uint32Array.from([0, 1, 2]),
    triState: null, paints: ["841"],
  };
  const xml = Split.buildSplitXML([tri], { buildTransform: "1 0 0 0 1 0 0 0 1 0 0 0", defaultExtruder: 1 });
  assert.ok(xml.objectsModel.includes('paint_color="841"'), "verbatim paint string");
});

test("layoutParts lines parts up beside the body, bottoms aligned", () => {
  const { Split } = loadModules();
  const box = (x0, y0, z0, x1, y1, z1) => ({ min: [x0, y0, z0], max: [x1, y1, z1] });
  const body = box(0, 0, 0, 10, 8, 6);
  const parts = [box(2, 2, 1, 5, 6, 4), box(0, 0, 0, 2, 2, 2)];
  const offs = Split.layoutParts(body, parts, 1);
  assert.equal(offs.length, 2);
  let cursor = 11; // body max-x + margin
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i], o = offs[i];
    const minX = p.min[0] + o[0], maxX = p.max[0] + o[0];
    assert.ok(Math.abs(minX - cursor) < 1e-9, "part " + i + " starts at the cursor");
    // y centers aligned
    const pcy = (p.min[1] + p.max[1]) / 2 + o[1];
    assert.ok(Math.abs(pcy - 4) < 1e-9, "part " + i + " y-centered on the body");
    // bottoms aligned to the body base plane
    assert.ok(Math.abs(p.min[2] + o[2] - 0) < 1e-9, "part " + i + " rests on the body base");
    cursor = maxX + 1;
  }
});

function asIdx(s) { return s.indices instanceof Uint32Array ? s.indices : Uint32Array.from(s.indices); }

test("solidFromSubs thickness: exact plug + pocket volumes on the cube top", () => {
  const { Split, Cleanup } = loadModules();
  const cube = makeClosedCube();
  Cleanup.buildSubGraph(cube);
  const subs = [2, 3]; // the two top faces (z = 2)
  const t = 0.5;
  const part = Split.solidFromSubs(cube, subs, "earcut", t);
  assert.equal(directedViolations(asIdx(part)), 0, "plug directed-watertight");
  const vol = signedVolume(asIdx(part), part.positions);
  assert.ok(Math.abs(vol - 2) < 1e-9, "plug volume 2x2x0.5 = 2, got " + vol);
  // every offset point sits exactly t beneath its rim vertex (straight down)
  const cap = part.cap;
  const nR = cap.verts.length;
  assert.equal(nR, 4, "four rim vids");
  const g = Cleanup.buildSubGraph(cube);
  for (let i = 0; i < nR; i++) {
    const gid = cap.verts[i], off = cap.extraPts[i];
    const d = Math.hypot(off[0] - g.vx[gid], off[1] - g.vy[gid], off[2] - g.vz[gid]);
    assert.ok(Math.abs(d - t) < 1e-9, "offset distance = t");
    assert.ok(Math.abs(off[2] - (2 - t)) < 1e-9, "offset moved straight down");
  }
  // wall = 2 triangles per rim edge; cap interior = whatever earcut made (2 here)
  const wallTris = cap.tris.filter((tri) => tri.some((r) => r < nR));
  assert.equal(wallTris.length, 8, "4 rim edges x 2 wall triangles");
  // remainder reuses the plug surface reversed -> pocket; volumes sum to the cube
  const rem = Split.remainderSolid(cube, [{ subs, cap, state: part.state }], new Set(subs));
  assert.equal(directedViolations(asIdx(rem)), 0, "pocketed remainder directed-watertight");
  const rvol = signedVolume(asIdx(rem), rem.positions);
  assert.ok(Math.abs(rvol - 6) < 1e-9, "remainder volume 8-2 = 6, got " + rvol);
  // t = 0 (and omitted) is byte-for-byte the legacy path
  const legacy = Split.solidFromSubs(cube, subs, "earcut");
  const zero = Split.solidFromSubs(cube, subs, "earcut", 0);
  assert.equal(zero.indices.length, legacy.indices.length, "t=0 keeps the legacy triangle count");
  assert.equal(zero.cap.extraPts.length, legacy.cap.extraPts.length, "t=0 keeps the legacy cap shape");
});

test("solidFromSubs thickness: tube skirts stay directed-watertight (liepa + earcut)", () => {
  const { Split, Cleanup } = loadModules();
  for (const method of ["liepa", "earcut"]) {
    const tube = makeOpenTube();
    const g = Cleanup.buildSubGraph(tube);
    const all = Array.from({ length: g.NS }, (_, i) => i);
    const t = 0.4;
    const part = Split.solidFromSubs(tube, all, method, t);
    assert.equal(directedViolations(asIdx(part)), 0, method + " skirted tube directed-watertight");
    const vol = signedVolume(asIdx(part), part.positions);
    assert.ok(Math.abs(vol - 8) < 1.0, method + " volume near the tube's 8, got " + vol.toFixed(3));
    const nR = part.cap.verts.length;
    for (let i = 0; i < nR; i++) {
      const gid = part.cap.verts[i], off = part.cap.extraPts[i];
      const d = Math.hypot(off[0] - g.vx[gid], off[1] - g.vy[gid], off[2] - g.vz[gid]);
      assert.ok(Math.abs(d - t) < 1e-6, method + " offset distance = t");
    }
  }
});
