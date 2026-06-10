/* split.js — build watertight solids from sets of leaf sub-triangles, and
 * assemble a multi-object .3mf. Depends on Paint + Cleanup (on window). */
(function (global) {
  "use strict";

  // Build a capped watertight solid from leaf sub-triangle indices (indices into
  // the mesh's buildSubGraph enumeration).
  // Returns { positions:Float32Array, indices:Uint32Array, triState:Int32Array, state }.
  function solidFromSubs(mesh, subs) {
    const g = Cleanup.buildSubGraph(mesh);
    const { sv, vx, vy, vz, subLeaf, midOf } = g;

    // local vertex remap: global welded id -> local id
    const remap = new Map();
    const px = [], py = [], pz = [];
    const lid = (gid) => {
      let id = remap.get(gid);
      if (id === undefined) {
        id = px.length; remap.set(gid, id);
        px.push(vx[gid]); py.push(vy[gid]); pz.push(vz[gid]);
      }
      return id;
    };

    // Decompose edge (global ids u..v) into the ordered list of global ids,
    // splitting at any welded midpoint a neighbour introduced (T-junctions).
    function decompose(u, v) {
      const m = midOf ? midOf(u, v) : -1;
      if (m >= 0 && m !== u && m !== v) {
        return decompose(u, m).concat(decompose(m, v).slice(1));
      }
      return [u, v];
    }

    const F = [], triSt = []; // local triangle indices + per-triangle state
    for (let k = 0; k < subs.length; k++) {
      const s = subs[k];
      const a = sv[s * 3], b = sv[s * 3 + 1], c = sv[s * 3 + 2];
      const st = subLeaf[s].state;
      const eab = decompose(a, b), ebc = decompose(b, c), eca = decompose(c, a);
      // conformed boundary polygon (global ids), CCW like the original triangle
      const poly = eab.concat(ebc.slice(1), eca.slice(1, -1));
      if (poly.length === 3) {
        F.push(lid(poly[0]), lid(poly[1]), lid(poly[2]));
        triSt.push(st);
      } else {
        // fan from the polygon centroid (interior -> never collinear with an edge)
        let gx = 0, gy = 0, gz = 0;
        for (const gid of poly) { gx += vx[gid]; gy += vy[gid]; gz += vz[gid]; }
        const n = poly.length;
        const gLocal = px.length;
        px.push(gx / n); py.push(gy / n); pz.push(gz / n);
        for (let i = 0; i < n; i++) {
          F.push(gLocal, lid(poly[i]), lid(poly[(i + 1) % n]));
          triSt.push(st);
        }
      }
    }
    const NV = px.length;
    const nTri = F.length / 3;

    // boundary detection on the conformed mesh; remember owning directed edge + tri
    const ekey = (u, v) => (u < v ? u * NV + v : v * NV + u);
    const eIdx = new Map();
    const eCount = [], eA = [], eB = [], eTri = [];
    const addEdge = (u, v, t) => {
      const k = ekey(u, v);
      let i = eIdx.get(k);
      if (i === undefined) {
        i = eCount.length; eIdx.set(k, i);
        eCount.push(1); eA.push(u); eB.push(v); eTri.push(t);
      } else eCount[i]++;
    };
    for (let t = 0; t < nTri; t++) {
      addEdge(F[t * 3], F[t * 3 + 1], t);
      addEdge(F[t * 3 + 1], F[t * 3 + 2], t);
      addEdge(F[t * 3 + 2], F[t * 3], t);
    }

    const out = [], outSt = [];
    for (let t = 0; t < nTri; t++) {
      out.push(F[t * 3], F[t * 3 + 1], F[t * 3 + 2]);
      outSt.push(triSt[t]);
    }

    const bnd = [];
    for (let i = 0; i < eCount.length; i++) if (eCount[i] === 1) bnd.push(i);

    let posCount = NV;
    if (bnd.length) {
      let ax = 0, ay = 0, az = 0;
      for (let i = 0; i < NV; i++) { ax += px[i]; ay += py[i]; az += pz[i]; }
      ax /= NV; ay /= NV; az /= NV;
      const anchor = NV;
      px.push(ax); py.push(ay); pz.push(az);
      posCount = NV + 1;
      for (const i of bnd) {
        const u = eA[i], v = eB[i];
        const ux = px[v] - px[u], uy = py[v] - py[u], uz = pz[v] - pz[u];
        const wx = ax - px[u], wy = ay - py[u], wz = az - pz[u];
        const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        const mx = (px[u] + px[v] + ax) / 3 - ax;
        const my = (py[u] + py[v] + ay) / 3 - ay;
        const mz = (pz[u] + pz[v] + az) / 3 - az;
        if (nx * mx + ny * my + nz * mz >= 0) out.push(u, v, anchor);
        else out.push(v, u, anchor);
        outSt.push(triSt[eTri[i]]);
      }
    }

    const positions = new Float32Array(posCount * 3);
    for (let i = 0; i < posCount; i++) {
      positions[i * 3] = px[i];
      positions[i * 3 + 1] = py[i];
      positions[i * 3 + 2] = pz[i];
    }
    return {
      positions,
      indices: Uint32Array.from(out),
      triState: Int32Array.from(outSt),
      state: subs.length ? subLeaf[subs[0]].state : 0,
    };
  }

  function uuid() {
    const h = "0123456789abcdef";
    let s = "";
    for (let i = 0; i < 32; i++) {
      if (i === 8 || i === 12 || i === 16 || i === 20) s += "-";
      s += h[(Math.random() * 16) | 0];
    }
    return s;
  }

  const fnum = (v) =>
    Number.isInteger(v) ? String(v) : parseFloat(v.toFixed(5)).toString();

  // objects: [{ name, extruder, positions, indices, triState|null }]
  // opts: { buildTransform, defaultExtruder, objectsPath }
  // Returns { objectsModel, rootModel, modelSettings } (strings).
  function buildSplitXML(objects, opts) {
    opts = opts || {};
    const bt = opts.buildTransform || "1 0 0 0 1 0 0 0 1 125 125 0";
    const objectsPath = opts.objectsPath || "/3D/Objects/object_1.model";
    const NS_HEADER =
      '<model unit="millimeter" xml:lang="en-US" ' +
      'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
      'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" ' +
      'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" ' +
      'requiredextensions="p">';

    // --- objects file: one <object> mesh per color ---
    const objBlocks = objects.map((o, k) => {
      const id = k + 1;
      const P = o.positions, I = o.indices, TS = o.triState;
      const vlines = [];
      for (let i = 0; i < P.length; i += 3)
        vlines.push('     <vertex x="' + fnum(P[i]) + '" y="' + fnum(P[i + 1]) +
          '" z="' + fnum(P[i + 2]) + '"/>');
      const tlines = [];
      for (let t = 0; t < I.length; t += 3) {
        let line = '     <triangle v1="' + I[t] + '" v2="' + I[t + 1] +
          '" v3="' + I[t + 2] + '"';
        if (TS) {
          const code = Paint.encode({ leaf: true, state: TS[t / 3] });
          if (code) line += ' paint_color="' + code + '"';
        }
        tlines.push(line + "/>");
      }
      return '  <object id="' + id + '" type="model">\n   <mesh>\n    <vertices>\n' +
        vlines.join("\n") + "\n    </vertices>\n    <triangles>\n" +
        tlines.join("\n") + "\n    </triangles>\n   </mesh>\n  </object>";
    });
    const objectsModel =
      '<?xml version="1.0" encoding="UTF-8"?>\n' + NS_HEADER + "\n" +
      ' <metadata name="BambuStudio:3mfVersion">2</metadata>\n' +
      " <resources>\n" + objBlocks.join("\n") + "\n </resources>\n <build/>\n</model>\n";

    // --- root file: N wrapper objects + N build items ---
    const wrap = objects.map((o, k) => {
      const meshId = k + 1, wid = 100 + meshId;
      return '  <object id="' + wid + '" p:UUID="' + uuid() + '" type="model">\n' +
        "   <components>\n" +
        '    <component p:path="' + objectsPath + '" objectid="' + meshId +
        '" p:UUID="' + uuid() + '" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n' +
        "   </components>\n  </object>";
    });
    const items = objects.map((o, k) =>
      '  <item objectid="' + (100 + k + 1) + '" p:UUID="' + uuid() +
      '" transform="' + bt + '" printable="1"/>');
    const rootModel =
      '<?xml version="1.0" encoding="UTF-8"?>\n' + NS_HEADER + "\n" +
      ' <metadata name="Application">Irodori</metadata>\n' +
      ' <metadata name="BambuStudio:3mfVersion">2</metadata>\n' +
      " <resources>\n" + wrap.join("\n") + "\n </resources>\n" +
      ' <build p:UUID="' + uuid() + '">\n' + items.join("\n") + "\n </build>\n</model>\n";

    // --- model_settings.config ---
    const sObjs = objects.map((o, k) => {
      const wid = 100 + k + 1, meshId = k + 1;
      return '  <object id="' + wid + '">\n' +
        '    <metadata key="name" value="' + o.name + '"/>\n' +
        '    <metadata key="extruder" value="' + o.extruder + '"/>\n' +
        '    <part id="' + meshId + '" subtype="normal_part">\n' +
        '      <metadata key="name" value="' + o.name + '"/>\n' +
        '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n' +
        '      <metadata key="extruder" value="' + o.extruder + '"/>\n' +
        "    </part>\n  </object>";
    });
    const insts = objects.map((o, k) =>
      "    <model_instance>\n" +
      '      <metadata key="object_id" value="' + (100 + k + 1) + '"/>\n' +
      '      <metadata key="instance_id" value="0"/>\n    </model_instance>');
    const modelSettings =
      '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' + sObjs.join("\n") + "\n" +
      '  <plate>\n    <metadata key="plater_id" value="1"/>\n' + insts.join("\n") +
      "\n  </plate>\n  <assemble>\n  </assemble>\n</config>\n";

    return { objectsModel, rootModel, modelSettings };
  }

  global.Split = { solidFromSubs, buildSplitXML, uuid };
})(window);
