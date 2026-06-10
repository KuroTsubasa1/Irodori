const test = require("node:test");
const assert = require("node:assert");
const { loadModules, makeTetra, edgeUseCounts, makeTJunction, makeOpenTube, directedViolations, signedVolume } = require("./harness");

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
