// Regression test for assembleGeneratedPackage (exportSplit / exportGenerated).
//
// The generated package writes geometry to a FIXED path
// (3D/Objects/object_1.model) and references it from 3dmodel.model via a
// production-extension <component p:path=.../>. That component is only
// resolvable if 3D/_rels/3dmodel.model.rels declares a matching relationship.
//
// Bug: the assembler used to COPY the source file's 3dmodel.model.rels. Files
// that store geometry inline in 3dmodel.model have an empty model.rels, so the
// copied rels never pointed at the generated Objects part -> the slicer opened
// the export with no model. The fix generates the OPC plumbing fresh.
//
// This test needs JSZip (a browser global the shared harness doesn't load), so
// it builds its own vm sandbox with the vendored JSZip plus a minimal Blob shim
// (node has no Blob for JSZip's type:"blob" output).

const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function loadWithZip() {
  const root = path.join(__dirname, "..");
  const sandbox = {};
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.console = console;
  sandbox.setTimeout = setTimeout; sandbox.clearTimeout = clearTimeout;
  // Minimal Blob shim so JSZip's generateAsync({type:"blob"}) works in node.
  sandbox.Blob = class Blob {
    constructor(parts) { this._buf = Buffer.concat(parts.map((p) => Buffer.from(p))); this.size = this._buf.length; }
    async arrayBuffer() { return this._buf; }
    get __buf() { return this._buf; }
  };
  vm.createContext(sandbox);
  for (const f of [
    "vendor/three.min.js", "vendor/poly2tri.min.js", "vendor/jszip.min.js",
    "js/paint.js", "js/objexport.js", "js/subgraph.js", "js/select.js",
    "js/cleanup.js", "js/liepa.js", "js/caps.js", "js/split.js",
    "js/planecut.js", "js/threemf.js",
  ]) vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), sandbox, { filename: f });
  return sandbox;
}

// A source .3mf whose single triangle lives INLINE in 3dmodel.model — so its
// 3dmodel.model.rels is empty (no Objects part to reference). This is the case
// the old assembler mishandled.
function buildInlineSourceZip(JSZip) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
    ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n</Types>\n');
  zip.file("_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    ' <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n');
  // EMPTY model rels — the trap.
  zip.file("3D/_rels/3dmodel.model.rels",
    '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n</Relationships>\n');
  zip.file("3D/3dmodel.model",
    '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter"><resources>' +
    '<object id="1" type="model"><mesh><vertices>' +
    '<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>' +
    '</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>' +
    '</resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 5 5 0"/></build></model>\n');
  zip.file("Metadata/project_settings.config", JSON.stringify({ filament_colour: ["#FFFFFFFF"] }));
  return zip;
}

test("assembleGeneratedPackage declares the Objects relationship regardless of source layout", async () => {
  const sb = loadWithZip();
  const { ThreeMF, JSZip } = sb;

  const doc = {
    zip: buildInlineSourceZip(JSZip),
    filaments: [{ hex: "#FFFFFF" }],
    origFilamentCount: 1,
    defaultExtruder: 1,
    meshes: [{
      nf: 1,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      v1: Int32Array.from([0]), v2: Int32Array.from([1]), v3: Int32Array.from([2]),
      paints: [""],
    }],
  };

  const blob = await ThreeMF.exportGenerated(doc);
  // base64 round-trips across the vm realm boundary (a host Buffer is not an
  // instanceof the sandbox's Uint8Array, which JSZip.loadAsync requires).
  const out = await JSZip.loadAsync(blob.__buf.toString("base64"), { base64: true });

  const rels = await out.file("3D/_rels/3dmodel.model.rels").async("string");
  assert.match(rels, /Target="\/3D\/Objects\/object_1\.model"/,
    "model.rels must declare a relationship to the generated Objects part");

  // The geometry part must exist and the root must reference it by that path.
  assert.ok(out.file("3D/Objects/object_1.model"), "Objects/object_1.model must be present");
  const rootModel = await out.file("3D/3dmodel.model").async("string");
  assert.match(rootModel, /p:path="\/3D\/Objects\/object_1\.model"/);
});
