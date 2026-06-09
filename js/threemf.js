/* threemf.js — load a Bambu/Prusa .3mf, extract painted meshes + filament
 * colors, and write the file back with only the paint_color values changed
 * (everything else preserved byte-for-byte). Depends on JSZip + Paint.
 */
(function (global) {
  "use strict";

  function stripHex(c) {
    // "#FBF0E1FF" -> "#FBF0E1"
    if (!c) return "#cccccc";
    let s = c.trim();
    if (s[0] !== "#") s = "#" + s;
    if (s.length >= 7) return s.slice(0, 7).toUpperCase();
    return s.toUpperCase();
  }

  async function readText(zip, rx) {
    const arr = zip.file(rx);
    if (!arr || !arr.length) return null;
    return await arr[0].async("string");
  }

  function parseMeshFromModel(text, path) {
    const meshIdx = text.indexOf("<mesh>");
    if (meshIdx === -1) return null;

    // vertices
    const vOpen = text.indexOf("<vertices>", meshIdx);
    const vInner = vOpen + "<vertices>".length;
    const vEnd = text.indexOf("</vertices>", vInner);
    const vBlock = text.slice(vInner, vEnd);
    const vre = /<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g;
    const xs = [];
    let m;
    while ((m = vre.exec(vBlock))) {
      xs.push(+m[1], +m[2], +m[3]);
    }
    const positions = new Float32Array(xs);
    const nv = positions.length / 3;

    // triangles
    const tOpen = text.indexOf("<triangles>", vEnd);
    const innerStart = tOpen + "<triangles>".length;
    const tClose = text.indexOf("</triangles>", innerStart);
    const tBlock = text.slice(innerStart, tClose);
    const tre =
      /<triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"(?:\s+paint_color="([^"]*)")?\s*\/>/g;
    const i1 = [],
      i2 = [],
      i3 = [],
      paints = [];
    while ((m = tre.exec(tBlock))) {
      i1.push(+m[1]);
      i2.push(+m[2]);
      i3.push(+m[3]);
      paints.push(m[4] || "");
    }
    const nf = i1.length;
    return {
      path,
      positions,
      nv,
      nf,
      v1: Int32Array.from(i1),
      v2: Int32Array.from(i2),
      v3: Int32Array.from(i3),
      paints, // string[] (mutable; "" == unpainted)
      // pieces needed to rewrite the file on export (vertices + triangles
      // are both regenerated, so geometry edits like rotation are captured):
      _pre: text.slice(0, vInner), // ... <vertices>
      _mid: text.slice(vEnd, innerStart), // </vertices> ... <triangles>
      _tail: text.slice(tClose), // </triangles> ...
    };
  }

  async function load(arrayBuffer) {
    const zip = await JSZip.loadAsync(arrayBuffer);

    // filament colors + default extruder
    let filaments = [];
    let defaultExtruder = 1;
    const projText = await readText(zip, /project_settings\.config$/i);
    if (projText) {
      try {
        const j = JSON.parse(projText);
        if (Array.isArray(j.filament_colour))
          filaments = j.filament_colour.map((c, i) => ({
            index: i + 1,
            hex: stripHex(c),
          }));
      } catch (e) {
        console.warn("project_settings parse failed", e);
      }
    }
    const setText = await readText(zip, /model_settings\.config$/i);
    if (setText) {
      const em = setText.match(/key="extruder"\s+value="(\d+)"/);
      if (em) defaultExtruder = +em[1];
    }

    // every .model file that contains a mesh
    const modelFiles = zip.file(/\.model$/i);
    const meshes = [];
    for (const mf of modelFiles) {
      const txt = await mf.async("string");
      const mesh = parseMeshFromModel(txt, mf.name);
      if (mesh && mesh.nf > 0) meshes.push(mesh);
    }

    if (!filaments.length) {
      // Fallback palette if project settings were missing.
      const fallback = ["#FBF0E1", "#050404", "#C50513", "#FBD041"];
      filaments = fallback.map((h, i) => ({ index: i + 1, hex: h }));
    }

    return { zip, filaments, defaultExtruder, meshes };
  }

  // Compact float formatting (trims trailing zeros, keeps printing precision).
  function fnum(v) {
    return Number.isInteger(v) ? String(v) : parseFloat(v.toFixed(5)).toString();
  }

  // Rebuild both the vertices and triangles blocks from the mesh's current
  // positions/paints (so rotation and color edits are both written) and
  // generate a new .3mf Blob.
  async function exportZip(doc) {
    for (const mesh of doc.meshes) {
      const P = mesh.positions;
      const vlines = new Array(mesh.nv);
      for (let i = 0; i < mesh.nv; i++) {
        const o = i * 3;
        vlines[i] =
          '     <vertex x="' + fnum(P[o]) + '" y="' + fnum(P[o + 1]) +
          '" z="' + fnum(P[o + 2]) + '"/>';
      }
      const tlines = new Array(mesh.nf);
      for (let i = 0; i < mesh.nf; i++) {
        const p = mesh.paints[i];
        const base =
          '     <triangle v1="' + mesh.v1[i] + '" v2="' + mesh.v2[i] +
          '" v3="' + mesh.v3[i] + '"';
        tlines[i] = p ? base + ' paint_color="' + p + '"/>' : base + "/>";
      }
      const vBlock = "\n" + vlines.join("\n") + "\n    ";
      const tBlock = "\n" + tlines.join("\n") + "\n    ";
      const newText = mesh._pre + vBlock + mesh._mid + tBlock + mesh._tail;
      doc.zip.file(mesh.path, newText);
    }
    return await doc.zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
      mimeType: "application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
    });
  }

  global.ThreeMF = { load, exportZip };
})(window);
