/* objexport.js — export the painted model as a colored OBJ (+MTL) at full
 * sub-triangle resolution, matching the viewer. Depends on Paint (on window). */
(function (global) {
  "use strict";

  const QSCALE = 100000;
  const q = (v) => Math.round(v * QSCALE);
  const fnum = (v) =>
    Number.isInteger(v) ? String(v) : parseFloat(v.toFixed(5)).toString();

  // "#RRGGBB" -> "r g b" (0..1, 3 dp). Falls back to gray.
  function hexToKd(hex) {
    let s = (hex || "").trim().replace(/^#/, "");
    if (s.length < 6) s = "cccccc";
    const c = (i) => parseInt(s.slice(i, i + 2), 16) / 255;
    const f = (x) => (Math.round(x * 1000) / 1000).toString();
    return f(c(0)) + " " + f(c(2)) + " " + f(c(4));
  }

  // doc: { meshes:[{nf,positions,v1,v2,v3,paints}], filaments:[{index,hex}], defaultExtruder }
  // opts: { weld:boolean, mtlName:string }
  // Returns { obj, mtl } strings.
  function build(doc, opts) {
    opts = opts || {};
    const weld = !!opts.weld;
    const mtlName = opts.mtlName || "model.mtl";
    const resolved = (state) => (state === 0 ? doc.defaultExtruder : state);

    const vlines = [];
    let vcount = 0; // running 1-based vertex count
    const facesByMat = new Map(); // resolved filament idx -> ["f a b c", ...]

    for (let mi = 0; mi < doc.meshes.length; mi++) {
      const m = doc.meshes[mi];
      const P = m.positions;
      const wmap = weld ? new Map() : null; // per-mesh dedup
      const vid = (x, y, z) => {
        if (wmap) {
          const k = q(x) + "_" + q(y) + "_" + q(z);
          let id = wmap.get(k);
          if (id !== undefined) return id;
          vlines.push("v " + fnum(x) + " " + fnum(y) + " " + fnum(z));
          id = ++vcount;
          wmap.set(k, id);
          return id;
        }
        vlines.push("v " + fnum(x) + " " + fnum(y) + " " + fnum(z));
        return ++vcount;
      };
      const emit = (state, x0, y0, z0, x1, y1, z1, x2, y2, z2) => {
        const a = vid(x0, y0, z0), b = vid(x1, y1, z1), c = vid(x2, y2, z2);
        const idx = resolved(state);
        let arr = facesByMat.get(idx);
        if (!arr) { arr = []; facesByMat.set(idx, arr); }
        arr.push("f " + a + " " + b + " " + c);
      };
      for (let i = 0; i < m.nf; i++) {
        const a = m.v1[i] * 3, b = m.v2[i] * 3, c = m.v3[i] * 3;
        const ax = P[a], ay = P[a + 1], az = P[a + 2];
        const bx = P[b], by = P[b + 1], bz = P[b + 2];
        const cx = P[c], cy = P[c + 1], cz = P[c + 2];
        const s = Paint.solidState(m.paints[i]);
        if (s >= 0) {
          emit(s, ax, ay, az, bx, by, bz, cx, cy, cz);
        } else {
          Paint.tessellate(Paint.decode(m.paints[i]), ax, ay, az, bx, by, bz, cx, cy, cz,
            (leaf, x0, y0, z0, x1, y1, z1, x2, y2, z2) =>
              emit(leaf.state, x0, y0, z0, x1, y1, z1, x2, y2, z2));
        }
      }
    }

    const mats = [...facesByMat.keys()].sort((a, b) => a - b);

    const objParts = ["# Irodori paint export", "mtllib " + mtlName];
    for (const l of vlines) objParts.push(l);
    objParts.push("g model");
    for (const idx of mats) {
      objParts.push("usemtl filament_" + idx);
      for (const f of facesByMat.get(idx)) objParts.push(f);
    }
    const obj = objParts.join("\n") + "\n";

    const colorFor = (idx) => {
      const f = doc.filaments && (doc.filaments[idx - 1] || doc.filaments[0]);
      return f ? f.hex : "#cccccc";
    };
    const mtlParts = ["# Irodori paint export"];
    for (const idx of mats) {
      mtlParts.push("newmtl filament_" + idx, "Kd " + hexToKd(colorFor(idx)), "d 1", "");
    }
    const mtl = mtlParts.join("\n");

    return { obj, mtl };
  }

  global.ObjExport = { build };
})(window);
