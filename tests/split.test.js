const test = require("node:test");
const assert = require("node:assert");
const { loadModules } = require("./harness");

const tri = (name, paints) => ({
  name, extruder: 1,
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: Uint32Array.from([0, 1, 2]),
  triState: null, paints,
});

test("buildSplitXML emits N objects, components, items, and parts", () => {
  const { Split } = loadModules();
  const objects = [tri("Part 1 · black", ["4"]), tri("Object 1", [""])];
  const xml = Split.buildSplitXML(objects, { buildTransform: "1 0 0 0 1 0 0 0 1 1 2 0", defaultExtruder: 1 });
  assert.equal((xml.objectsModel.match(/<object /g) || []).length, 2);
  assert.equal((xml.objectsModel.match(/<mesh>/g) || []).length, 2);
  assert.equal((xml.rootModel.match(/<component /g) || []).length, 2);
  assert.equal((xml.rootModel.match(/<item /g) || []).length, 2);
  assert.ok(xml.rootModel.includes('transform="1 0 0 0 1 0 0 0 1 1 2 0"'));
  assert.equal((xml.modelSettings.match(/<object /g) || []).length, 2);
  assert.equal((xml.modelSettings.match(/<part /g) || []).length, 2);
  assert.ok(xml.modelSettings.includes('value="Part 1 · black"'), "object name carried");
  assert.equal((xml.objectsModel.match(/paint_color=/g) || []).length, 1, "only the painted object carries paint");
  assert.equal((xml.rootModel.match(/p:UUID=/g) || []).length >= 5, true);
});

test("buildSplitXML emits verbatim paint_color strings when objects carry paints", () => {
  const { Split } = loadModules();
  const xml = Split.buildSplitXML([tri("X", ["841"])], { buildTransform: "1 0 0 0 1 0 0 0 1 0 0 0", defaultExtruder: 1 });
  assert.ok(xml.objectsModel.includes('paint_color="841"'), "verbatim paint string");
});

test("layoutParts lines parts up beside the body, bottoms aligned", () => {
  const { Split } = loadModules();
  const box = (x0, y0, z0, x1, y1, z1) => ({ min: [x0, y0, z0], max: [x1, y1, z1] });
  const body = box(0, 0, 0, 10, 8, 6);
  const parts = [box(2, 2, 1, 5, 6, 4), box(0, 0, 0, 2, 2, 2)];
  const offs = Split.layoutParts(body, parts, 1);
  assert.equal(offs.length, 2);
  let cursor = 11;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i], o = offs[i];
    const minX = p.min[0] + o[0], maxX = p.max[0] + o[0];
    assert.ok(Math.abs(minX - cursor) < 1e-9, "part " + i + " starts at the cursor");
    const pcy = (p.min[1] + p.max[1]) / 2 + o[1];
    assert.ok(Math.abs(pcy - 4) < 1e-9, "part " + i + " y-centered on the body");
    assert.ok(Math.abs(p.min[2] + o[2] - 0) < 1e-9, "part " + i + " rests on the body base");
    cursor = maxX + 1;
  }
});

test("overlay API is gone", () => {
  const { Split, ThreeMF } = loadModules();
  assert.strictEqual(Split.solidFromSubs, undefined);
  assert.strictEqual(Split.remainderSolid, undefined);
  assert.strictEqual(ThreeMF.exportSplit, undefined);
});
