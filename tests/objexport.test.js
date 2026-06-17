const test = require("node:test");
const assert = require("node:assert");
const { loadModules, makeTetra } = require("./harness");

function makeDoc() {
  return {
    meshes: [makeTetra()],
    filaments: [{ index: 1, hex: "#ff0000" }, { index: 2, hex: "#00ff00" }],
    defaultExtruder: 1,
  };
}
const count = (s, re) => (s.match(re) || []).length;

test("ObjExport.build unwelded: 3 verts per sub-tri, one face each, MTL grouping", () => {
  const { ObjExport } = loadModules();
  const { obj, mtl } = ObjExport.build(makeDoc(), { weld: false, mtlName: "x.mtl" });
  assert.equal(count(obj, /^v /gm), 12, "4 sub-tris * 3 verts");
  assert.equal(count(obj, /^f /gm), 4, "one face per sub-tri");
  assert.equal(count(obj, /^usemtl /gm), 2, "two filaments used");
  assert.ok(obj.includes("mtllib x.mtl"), "mtllib references the given name");
  assert.equal(count(mtl, /^newmtl /gm), 2, "one material per filament");
  assert.ok(mtl.includes("newmtl filament_1"));
  assert.ok(mtl.includes("Kd 1 0 0"), "filament 1 is red");
  assert.ok(mtl.includes("Kd 0 1 0"), "filament 2 is green");
});

test("ObjExport.build welded: shared verts, same face count, valid indices", () => {
  const { ObjExport } = loadModules();
  const { obj } = ObjExport.build(makeDoc(), { weld: true });
  assert.equal(count(obj, /^v /gm), 4, "tetra has 4 distinct corners");
  assert.equal(count(obj, /^f /gm), 4, "still one face per sub-tri");
  for (const m of obj.matchAll(/^f (\d+) (\d+) (\d+)$/gm)) {
    for (let i = 1; i <= 3; i++) {
      const n = +m[i];
      assert.ok(n >= 1 && n <= 4, "face index in range");
    }
  }
});
