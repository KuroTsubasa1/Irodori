const test = require("node:test");
const assert = require("node:assert");
const { loadModules } = require("./harness");

const TWO_MESH = `<model><resources>
 <object id="1"><mesh>
  <vertices>
   <vertex x="0" y="0" z="0"/>
   <vertex x="1" y="0" z="0"/>
   <vertex x="0" y="1" z="0"/>
  </vertices>
  <triangles>
   <triangle v1="0" v2="1" v3="2"/>
  </triangles>
 </mesh></object>
 <object id="2"><mesh>
  <vertices>
   <vertex x="5" y="5" z="5"/>
   <vertex x="6" y="5" z="5"/>
   <vertex x="5" y="6" z="5"/>
  </vertices>
  <triangles>
   <triangle v1="0" v2="1" v3="2" paint_color="4"/>
  </triangles>
 </mesh></object>
</resources></model>`;

test("parseMeshes finds every mesh in a file", () => {
  const { ThreeMF } = loadModules();
  const ms = ThreeMF.parseMeshes(TWO_MESH, "x.model");
  assert.equal(ms.length, 2);
  assert.equal(ms[0].nv, 3); assert.equal(ms[0].nf, 1);
  assert.equal(ms[1].nv, 3); assert.equal(ms[1].nf, 1);
  assert.equal(ms[1].paints[0], "4");
  assert.equal(ms[0].paints[0], "");
});

test("rebuildModelFile updates one mesh in place and preserves the rest", () => {
  const { ThreeMF } = loadModules();
  const ms = ThreeMF.parseMeshes(TWO_MESH, "x.model");
  ms[0].positions[0] = 9; // change mesh-0 first vertex x
  const out = ThreeMF.rebuildModelFile(TWO_MESH, ms);
  assert.ok(out.includes('x="9"'), "mutated coord written");
  assert.ok(out.includes('x="6"'), "mesh-1 vertex preserved");
  assert.ok(out.includes('paint_color="4"'), "mesh-1 paint preserved");
  assert.equal((out.match(/<mesh>/g) || []).length, 2, "both meshes present");
  assert.equal(ThreeMF.parseMeshes(out, "x").length, 2, "re-parses to 2 meshes");
});
