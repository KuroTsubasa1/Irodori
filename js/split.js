/* split.js — volumetric split (plugSolids: region → solid plug + pocketed remainder), row layout, and the multi-object .3mf XML. Depends on Paint + Cleanup + MeshGeo (on window). */
(function (global) {
  "use strict";

  // Edge u-v split at every T-junction midpoint recorded by midOf: [u, ..., v].
  function decomposeEdge(midOf, u, v) {
    const m = midOf ? midOf(u, v) : -1;
    return (m >= 0 && m !== u && m !== v) ? decomposeEdge(midOf, u, m).concat(decomposeEdge(midOf, m, v).slice(1)) : [u, v];
  }

  // Conformed surface of EVERY sub-triangle in one id space, cached on the sub
  // graph (so invalidateSub drops it with mesh._sub). Ids < NV are the welded
  // sub-graph vertices; NV + k is the centroid of the k-th T-junction polygon
  // (a sub whose edges carry neighbours' midpoints is fanned from its
  // centroid). Patch and remainder index the same ids, so their shared rim is
  // welded by construction. Also caches unit sub normals (subN, 3 per sub).
  function conformedSurface(g) {
    if (g._conf) return g._conf;
    const { sv, NS, NV, midOf, vx, vy, vz } = g;
    const tri = [], triSub = [], cp = [];
    const subN = new Float64Array(NS * 3);
    for (let s = 0; s < NS; s++) {
      const a = sv[s * 3], b = sv[s * 3 + 1], c = sv[s * 3 + 2];
      const ux = vx[b] - vx[a], uy = vy[b] - vy[a], uz = vz[b] - vz[a];
      const wx = vx[c] - vx[a], wy = vy[c] - vy[a], wz = vz[c] - vz[a];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, L = Math.hypot(nx, ny, nz) || 1;
      subN[s * 3] = nx / L; subN[s * 3 + 1] = ny / L; subN[s * 3 + 2] = nz / L;
      const poly = decomposeEdge(midOf, a, b).concat(decomposeEdge(midOf, b, c).slice(1), decomposeEdge(midOf, c, a).slice(1, -1));
      if (poly.length === 3) { tri.push(a, b, c); triSub.push(s); continue; }
      let x = 0, y = 0, z = 0;
      for (const v of poly) { x += vx[v]; y += vy[v]; z += vz[v]; }
      const n = poly.length, cid = NV + cp.length / 3;
      cp.push(x / n, y / n, z / n);
      for (let i = 0; i < n; i++) { tri.push(cid, poly[i], poly[(i + 1) % n]); triSub.push(s); }
    }
    return (g._conf = { tri: Int32Array.from(tri), triSub: Int32Array.from(triSub), nT: triSub.length, cpos: Float64Array.from(cp), NC: cp.length / 3, subN });
  }

  // ---- the plug's displacement field -------------------------------------
  //
  // Every patch vertex q moves to q + s(q)·D(q). The plug is the patch, the
  // displaced patch ("skin", reversed) and a wall along the rim joining them.
  // Real paint rims are fractal (0.004 mm edges against a 3 mm depth), so the
  // field must be smooth in SPACE, not per vertex: a per-vertex normal/depth
  // tangles the offset curve (measured Lipschitz ~2600 on the sample).
  //   D: inward unit direction = −(kernel-smoothed patch normal), radius
  //      R = 2·depth over a voxel accumulation of the patch's area-weighted
  //      normals — Euclidean-smooth, so s·|∇D| stays below 1.
  //   s: min(depth, ½·thickness along D) · τ, τ = transversality ramp of D
  //      against EVERY sub incident to the vertex (both sides of the rim), so
  //      the plug never slides along the surface; then a geodesic Lipschitz
  //      envelope (slope ≤ L_SLOPE) so the skin cannot fold onto itself.
  const L_SLOPE = 0.5, TAU0 = 0.2, TAU1 = 0.5;

  function plugField(mesh, g, conf, inSub, depth) {
    const { NV, vx, vy, vz } = g;
    const { tri, triSub, nT, cpos, subN } = conf;
    const NI = NV + conf.NC;
    const X = (id) => (id < NV ? vx[id] : cpos[(id - NV) * 3]);
    const Y = (id) => (id < NV ? vy[id] : cpos[(id - NV) * 3 + 1]);
    const Z = (id) => (id < NV ? vz[id] : cpos[(id - NV) * 3 + 2]);
    // patch triangles and their vertices (local index)
    const loc = new Int32Array(NI).fill(-1), ids = [], pTris = [];
    for (let t = 0; t < nT; t++) {
      if (!inSub[triSub[t]]) continue;
      pTris.push(t);
      for (let k = 0; k < 3; k++) { const id = tri[t * 3 + k]; if (loc[id] < 0) { loc[id] = ids.length; ids.push(id); } }
    }
    const n = ids.length;
    const diag = MeshGeo.meshBounds(mesh).diag;
    const R = Math.max(2 * depth, 1e-3 * diag);
    // --- voxel accumulation of area-weighted patch normals (dense over the patch bounding box)
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const id of ids) { const p = [X(id), Y(id), Z(id)]; for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; } }
    let h = R / 3, dim;
    for (;;) {
      dim = [0, 1, 2].map((k) => Math.floor((hi[k] - lo[k]) / h) + 1);
      if (dim[0] * dim[1] * dim[2] <= 2e6) break;
      h *= 1.25;
    }
    const cells = dim[0] * dim[1] * dim[2];
    const vn = new Float64Array(cells * 3), vc = new Float64Array(cells * 3), va = new Float64Array(cells);
    const cellOf = (x, y, z) => {
      const i = Math.min(dim[0] - 1, Math.floor((x - lo[0]) / h)), j = Math.min(dim[1] - 1, Math.floor((y - lo[1]) / h)), k = Math.min(dim[2] - 1, Math.floor((z - lo[2]) / h));
      return (i * dim[1] + j) * dim[2] + k;
    };
    // area-weighted vertex normals from the conformed patch triangles; each
    // vertex is one kernel sample, so a vertex always sees at least itself
    const VN = new Float64Array(n * 3);
    for (const t of pTris) {
      const a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2];
      const ux = X(b) - X(a), uy = Y(b) - Y(a), uz = Z(b) - Z(a), wx = X(c) - X(a), wy = Y(c) - Y(a), wz = Z(c) - Z(a);
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      for (const id of [a, b, c]) { const i = loc[id]; VN[i * 3] += nx; VN[i * 3 + 1] += ny; VN[i * 3 + 2] += nz; }
    }
    for (let i = 0; i < n; i++) {
      const id = ids[i], A = Math.hypot(VN[i * 3], VN[i * 3 + 1], VN[i * 3 + 2]), ci = cellOf(X(id), Y(id), Z(id));
      vn[ci * 3] += VN[i * 3]; vn[ci * 3 + 1] += VN[i * 3 + 1]; vn[ci * 3 + 2] += VN[i * 3 + 2];
      vc[ci * 3] += X(id) * A; vc[ci * 3 + 1] += Y(id) * A; vc[ci * 3 + 2] += Z(id) * A; va[ci] += A;
    }
    for (let c = 0; c < cells; c++) if (va[c] > 0) { vc[c * 3] /= va[c]; vc[c * 3 + 1] /= va[c]; vc[c * 3 + 2] /= va[c]; }
    // --- D per patch vertex: weights (1 − d²/R²)² over voxel centroids within R
    const D = new Float64Array(n * 3), r = Math.ceil(R / h);
    for (let i = 0; i < n; i++) {
      const id = ids[i], x = X(id), y = Y(id), z = Z(id);
      const ci = Math.min(dim[0] - 1, Math.floor((x - lo[0]) / h)), cj = Math.min(dim[1] - 1, Math.floor((y - lo[1]) / h)), ck = Math.min(dim[2] - 1, Math.floor((z - lo[2]) / h));
      let sx = 0, sy = 0, sz = 0, mass = 0;
      for (let a = Math.max(0, ci - r); a <= Math.min(dim[0] - 1, ci + r); a++)
        for (let b = Math.max(0, cj - r); b <= Math.min(dim[1] - 1, cj + r); b++)
          for (let c = Math.max(0, ck - r); c <= Math.min(dim[2] - 1, ck + r); c++) {
            const q = (a * dim[1] + b) * dim[2] + c;
            if (!(va[q] > 0)) continue;
            const d2 = ((vc[q * 3] - x) ** 2 + (vc[q * 3 + 1] - y) ** 2 + (vc[q * 3 + 2] - z) ** 2) / (R * R);
            if (d2 >= 1) continue;
            const w = (1 - d2) * (1 - d2);
            sx += w * vn[q * 3]; sy += w * vn[q * 3 + 1]; sz += w * vn[q * 3 + 2]; mass += w * va[q];
          }
      let L = Math.hypot(sx, sy, sz);
      if (!(L > 1e-6 * mass)) { sx = VN[i * 3]; sy = VN[i * 3 + 1]; sz = VN[i * 3 + 2]; L = Math.hypot(sx, sy, sz) || 1; } // normals cancel: own normal
      D[i * 3] = -sx / L; D[i * 3 + 1] = -sy / L; D[i * 3 + 2] = -sz / L;
    }
    // --- transversality: the least-entering incident sub (both rim sides)
    const tr = new Float64Array(n).fill(Infinity);
    for (let t = 0; t < nT; t++) {
      const s = triSub[t];
      for (let k = 0; k < 3; k++) {
        const i = loc[tri[t * 3 + k]];
        if (i < 0) continue;
        const d = -(subN[s * 3] * D[i * 3] + subN[s * 3 + 1] * D[i * 3 + 1] + subN[s * 3 + 2] * D[i * 3 + 2]);
        if (d < tr[i]) tr[i] = d;
      }
    }
    // --- raw depth: min(depth, ½·thickness along D)·τ
    const grid = MeshGeo.faceGrid(mesh);
    const s = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const tau = Math.max(0, Math.min(1, (tr[i] - TAU0) / (TAU1 - TAU0)));
      if (!(tau > 0) || !(depth > 0)) continue;
      const id = ids[i];
      const hit = MeshGeo.rayHit(mesh, grid, X(id), Y(id), Z(id), D[i * 3], D[i * 3 + 1], D[i * 3 + 2], 1e-4 * diag, true);
      s[i] = Math.min(depth, 0.5 * hit) * tau;
    }
    // --- geodesic Lipschitz envelope over the patch graph (Dijkstra, slope L_SLOPE)
    const deg = new Int32Array(n + 1);
    for (const t of pTris) for (let k = 0; k < 3; k++) deg[loc[tri[t * 3 + k]] + 1] += 2;
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    const adj = new Int32Array(deg[n]), fill = deg.slice(0, n);
    for (const t of pTris) for (let k = 0; k < 3; k++) {
      const a = loc[tri[t * 3 + k]], b = loc[tri[t * 3 + (k + 1) % 3]];
      adj[fill[a]++] = b; adj[fill[b]++] = a;
    }
    const heapK = [], heapV = [];
    const push = (v, key) => {
      let i = heapK.length; heapK.push(key); heapV.push(v);
      while (i > 0) { const p = (i - 1) >> 1; if (heapK[p] <= key) break; heapK[i] = heapK[p]; heapV[i] = heapV[p]; i = p; }
      heapK[i] = key; heapV[i] = v;
    };
    const pop = () => {
      const v = heapV[0], lk = heapK.pop(), lv = heapV.pop(), m = heapK.length;
      if (m) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= m) break;
          if (c + 1 < m && heapK[c + 1] < heapK[c]) c++;
          if (heapK[c] >= lk) break;
          heapK[i] = heapK[c]; heapV[i] = heapV[c]; i = c;
        }
        heapK[i] = lk; heapV[i] = lv;
      }
      return v;
    };
    for (let i = 0; i < n; i++) push(i, s[i]);
    const done = new Uint8Array(n);
    while (heapK.length) {
      const key = heapK[0], v = pop();
      if (done[v] || key > s[v]) continue;
      done[v] = 1;
      const iv = ids[v];
      for (let e = deg[v]; e < deg[v + 1]; e++) {
        const u = adj[e]; if (done[u]) continue;
        const iu = ids[u];
        const nk = key + L_SLOPE * Math.hypot(X(iv) - X(iu), Y(iv) - Y(iu), Z(iv) - Z(iu));
        if (nk < s[u]) { s[u] = nk; push(u, nk); }
      }
    }
    for (let i = 0; i < n; i++) { const L = Math.hypot(VN[i * 3], VN[i * 3 + 1], VN[i * 3 + 2]) || 1; VN[i * 3] /= L; VN[i * 3 + 1] /= L; VN[i * 3 + 2] /= L; }
    return { ids, loc, D, s, pTris, n, NI, X, Y, Z, VN };
  }

  // ---- plug geometry for one depth scale ---------------------------------
  //
  // Skin vertices are per WEDGE (a fan of patch triangles connected through
  // edges around the vertex): a pinch vertex, where the region touches itself,
  // has two wedges and gets two coincident copies, so both outputs stay
  // edge-manifold without refusing the region. A vertex whose scaled depth is
  // ≤ snap stays welded to the surface (same id); a patch triangle whose three
  // vertices are welded has a zero-thickness plug and is "cancelled": it moves
  // to the remainder unchanged instead of being doubled by its skin.
  function buildPlug(field, conf, scale, snap) {
    const { tri } = conf;
    const { ids, loc, D, s, pTris, NI, X, Y, Z, VN } = field;
    const nP = pTris.length;
    // union-find over patch corners (3·j + k)
    const parent = new Int32Array(nP * 3);
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
    const edges = new Map(); // undirected key -> [corner at lower id, corner at higher id, j, k(, j2)]: rim edges have length 4
    for (let j = 0; j < nP; j++) {
      const t = pTris[j];
      for (let k = 0; k < 3; k++) {
        const u = tri[t * 3 + k], v = tri[t * 3 + (k + 1) % 3];
        const key = u < v ? u * NI + v : v * NI + u;
        const cu = j * 3 + k, cv = j * 3 + (k + 1) % 3;
        const e = edges.get(key);
        if (!e) edges.set(key, [u < v ? cu : cv, u < v ? cv : cu, j, k]);
        else { unite(e[0], u < v ? cu : cv); unite(e[1], u < v ? cv : cu); e.push(j); }
      }
    }
    // welded vertices. An INTERIOR edge with both ends welded whose two
    // triangles both keep a deep vertex would be shared by the patch and both
    // skins (a zero-thickness "pinch line", e.g. along a sharp crease where
    // τ = 0): un-weld its ends to the snap depth, until no such edge is left.
    const welded = new Uint8Array(field.n);
    for (let i = 0; i < field.n; i++) welded[i] = s[i] * scale > snap ? 0 : 1;
    const allWelded = (j) => { const t = pTris[j]; return welded[loc[tri[t * 3]]] && welded[loc[tri[t * 3 + 1]]] && welded[loc[tri[t * 3 + 2]]]; };
    for (let changed = true; changed;) {
      changed = false;
      for (const [key, e] of edges) {
        if (e.length !== 5) continue;
        const a = loc[Math.floor(key / NI)], b = loc[key % NI];
        if (!welded[a] || !welded[b] || allWelded(e[2]) || allWelded(e[4])) continue;
        welded[a] = welded[b] = 0; changed = true;
      }
    }
    // skin id per corner
    const extra = [], src = []; // extra coords + source vertex of every plug vertex (id NI + k)
    const rootId = new Map(), skin = new Int32Array(nP * 3);
    for (let j = 0; j < nP; j++) {
      const t = pTris[j];
      for (let k = 0; k < 3; k++) {
        const id = tri[t * 3 + k], i = loc[id], forced = !(s[i] * scale > snap), d = forced ? snap : s[i] * scale;
        if (welded[i]) { skin[j * 3 + k] = id; continue; }
        const root = find(j * 3 + k);
        let sid = rootId.get(root);
        if (sid === undefined) {
          sid = NI + src.length; rootId.set(root, sid); src.push(id);
          // an un-welded (forced) vertex sits where D may not enter every face
          // (that is why its depth was ~0): step along its own inward normal
          const dx = forced ? -VN[i * 3] : D[i * 3], dy = forced ? -VN[i * 3 + 1] : D[i * 3 + 1], dz = forced ? -VN[i * 3 + 2] : D[i * 3 + 2];
          extra.push(X(id) + dx * d, Y(id) + dy * d, Z(id) + dz * d, d);
        }
        skin[j * 3 + k] = sid;
      }
    }
    const walls = [], skins = [];
    // walls along rim edges (an edge owned by exactly one patch triangle):
    // patch traverses u→v; the wall (v,u,u'), (v,u',v') traverses v→u and u'→v'
    for (const e of edges.values()) {
      if (e.length !== 4) continue;
      const j = e[2], k = e[3], t = pTris[j];
      const u = tri[t * 3 + k], v = tri[t * 3 + (k + 1) % 3];
      const u2 = skin[j * 3 + k], v2 = skin[j * 3 + (k + 1) % 3];
      if (u2 !== u) walls.push(v, u, u2);
      if (v2 !== v) walls.push(v, u2, v2);
    }
    const cancelled = new Uint8Array(nP);
    for (let j = 0; j < nP; j++) {
      const t = pTris[j], a = skin[j * 3], b = skin[j * 3 + 1], c = skin[j * 3 + 2];
      if (a === tri[t * 3] && b === tri[t * 3 + 1] && c === tri[t * 3 + 2]) { cancelled[j] = 1; continue; }
      skins.push(a, c, b); // reversed: the skin faces into the pocket
    }
    return { walls, skins, cancelled, extra, src };
  }

  // ---- self-intersection gate ----------------------------------------------
  //
  // Do the new triangles (wall + skin) cross each other or the original mesh?
  // Not an exact predicate — a toleranced one:
  //  - pair classification by shared SOURCE vertex (copies of one vertex count
  //    as shared): edge-adjacent -> only a flat fold (or a duplicate) counts;
  //    vertex-adjacent -> the far edge of one piercing the other; otherwise
  //    Möller with a scale-relative on-plane epsilon;
  //  - contact rule, decided on the CROSSING itself: the plug depth of a new
  //    triangle at a point is its vertices' depths (0 on the surface)
  //    interpolated barycentrically; a crossing whose points all lie in the
  //    surface layer (depth <= tol) on every new triangle involved — or a
  //    touch with no crossing segment at all (shared vertex) — is contact.
  //    Fast path: a triangle whose vertices are all within tol is in that
  //    layer everywhere, so it skips the mesh test and tests against other
  //    such triangles.
  function plugIntersects(mesh, grid, newTris, pos, depthOf, canon, tol) {
    const m = newTris.length / 3;
    if (!m) return false;
    const C = new Float64Array(m * 9), bb = new Float64Array(m * 6);
    const near = new Uint8Array(m), CN = new Float64Array(m * 3), DP = new Float64Array(m * 3);
    for (let i = 0; i < m; i++) {
      let deep = 0;
      for (let k = 0; k < 3; k++) {
        const id = newTris[i * 3 + k], p = pos(id), d = depthOf(id), o = i * 9 + k * 3;
        C[o] = p[0]; C[o + 1] = p[1]; C[o + 2] = p[2];
        CN[i * 3 + k] = canon(id); DP[i * 3 + k] = d;
        if (d > deep) deep = d;
      }
      near[i] = deep <= tol ? 1 : 0;
      for (let a = 0; a < 3; a++) {
        bb[i * 6 + a] = Math.min(C[i * 9 + a], C[i * 9 + 3 + a], C[i * 9 + 6 + a]);
        bb[i * 6 + 3 + a] = Math.max(C[i * 9 + a], C[i * 9 + 3 + a], C[i * 9 + 6 + a]);
      }
    }
    const { n, min, cell, start, list } = grid;
    const ci = (x, k) => Math.max(0, Math.min(n - 1, Math.floor((x - min[k]) / cell[k])));
    // CSR buckets of new triangles per grid cell
    const cnt = new Int32Array(n * n * n + 1);
    const forCells = (i, fn) => {
      const x0 = ci(bb[i * 6], 0), x1 = ci(bb[i * 6 + 3], 0), y0 = ci(bb[i * 6 + 1], 1), y1 = ci(bb[i * 6 + 4], 1), z0 = ci(bb[i * 6 + 2], 2), z1 = ci(bb[i * 6 + 5], 2);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) if (fn((x * n + y) * n + z)) return true;
      return false;
    };
    for (let i = 0; i < m; i++) forCells(i, (c) => { cnt[c + 1]++; });
    for (let c = 0; c < n * n * n; c++) cnt[c + 1] += cnt[c];
    const bucket = new Int32Array(cnt[n * n * n]), fillc = cnt.slice(0, n * n * n);
    for (let i = 0; i < m; i++) forCells(i, (c) => { bucket[fillc[c]++] = i; });
    const P = mesh.positions, F = new Float64Array(9);
    const pt = (A, o) => [A[o], A[o + 1], A[o + 2]];
    const pairHit = (i, j) => {
      const a0 = CN[i * 3], a1 = CN[i * 3 + 1], a2 = CN[i * 3 + 2], b0 = CN[j * 3], b1 = CN[j * 3 + 1], b2 = CN[j * 3 + 2];
      // which corners of i are shared with j
      const s0 = a0 === b0 || a0 === b1 || a0 === b2, s1 = a1 === b0 || a1 === b1 || a1 === b2, s2 = a2 === b0 || a2 === b1 || a2 === b2;
      const ns = (s0 ? 1 : 0) + (s1 ? 1 : 0) + (s2 ? 1 : 0);
      if (!ns) return MeshGeo.triTriFlat(C, i * 9, C, j * 9);
      if (ns === 3) return 2; // duplicate triangle: overlaps like a fold
      const kb = (x) => (x === b0 ? 0 : x === b1 ? 1 : 2); // corner of j holding canonical x
      if (ns === 2) { // edge-adjacent: only a flat fold overlaps
        const ka = !s0 ? 0 : !s1 ? 1 : 2, A = [a0, a1, a2];
        const sA = [0, 1, 2].filter((k) => k !== ka);
        const ob = [0, 1, 2].find((k) => [b0, b1, b2][k] !== A[sA[0]] && [b0, b1, b2][k] !== A[sA[1]]);
        return MeshGeo.foldedPair(pt(C, i * 9 + sA[0] * 3), pt(C, i * 9 + sA[1] * 3), pt(C, i * 9 + ka * 3), pt(C, j * 9 + ob * 3)) ? 2 : false;
      }
      // vertex-adjacent: the far edge of one piercing the other
      const sa = s0 ? 0 : s1 ? 1 : 2, sb = kb([a0, a1, a2][sa]);
      const TAi = [pt(C, i * 9), pt(C, i * 9 + 3), pt(C, i * 9 + 6)], TBj = [pt(C, j * 9), pt(C, j * 9 + 3), pt(C, j * 9 + 6)];
      return MeshGeo.segTriCross(TAi[(sa + 1) % 3], TAi[(sa + 2) % 3], TBj[0], TBj[1], TBj[2]) ||
        MeshGeo.segTriCross(TBj[(sb + 1) % 3], TBj[(sb + 2) % 3], TAi[0], TAi[1], TAi[2]);
    };
    // per-triangle planes (unit normal, offset, on-plane tolerance) for a cheap
    // separating-plane reject before the full test
    const PL = new Float64Array(m * 5);
    const plane = (A, i, out) => {
      const o = i * 9;
      const ux = A[o + 3] - A[o], uy = A[o + 4] - A[o + 1], uz = A[o + 5] - A[o + 2], wx = A[o + 6] - A[o], wy = A[o + 7] - A[o + 1], wz = A[o + 8] - A[o + 2];
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const L = Math.hypot(nx, ny, nz);
      if (!(L > 0)) { out[i * 5 + 4] = -1; return; } // degenerate: never rejected
      nx /= L; ny /= L; nz /= L;
      out[i * 5] = nx; out[i * 5 + 1] = ny; out[i * 5 + 2] = nz; out[i * 5 + 3] = -(nx * A[o] + ny * A[o + 1] + nz * A[o + 2]);
      out[i * 5 + 4] = 1e-9 * Math.max(Math.hypot(ux, uy, uz), Math.hypot(wx, wy, wz));
    };
    for (let i = 0; i < m; i++) plane(C, i, PL);
    // all three points strictly on one side of plane i (tolerance-aware)?
    const oneSide = (Pl, i, A, o) => {
      const e = Pl[i * 5 + 4];
      if (e < 0) return false;
      const nx = Pl[i * 5], ny = Pl[i * 5 + 1], nz = Pl[i * 5 + 2], d = Pl[i * 5 + 3];
      const s0 = nx * A[o] + ny * A[o + 1] + nz * A[o + 2] + d, s1 = nx * A[o + 3] + ny * A[o + 4] + nz * A[o + 5] + d, s2 = nx * A[o + 6] + ny * A[o + 7] + nz * A[o + 8] + d;
      return (s0 > e && s1 > e && s2 > e) || (s0 < -e && s1 < -e && s2 < -e);
    };
    // Contact is a property of the CROSSING: the plug depth of new triangle i
    // at point p is its vertices' depths interpolated barycentrically. A
    // crossing all of whose points lie in the surface layer (depth <= tol) on
    // every new triangle involved is contact; anything deeper is a crossing.
    const depthAt = (i, x, y, z) => {
      const o = i * 9;
      const e1x = C[o + 3] - C[o], e1y = C[o + 4] - C[o + 1], e1z = C[o + 5] - C[o + 2], e2x = C[o + 6] - C[o], e2y = C[o + 7] - C[o + 1], e2z = C[o + 8] - C[o + 2];
      const wx = x - C[o], wy = y - C[o + 1], wz = z - C[o + 2];
      const d11 = e1x * e1x + e1y * e1y + e1z * e1z, d12 = e1x * e2x + e1y * e2y + e1z * e2z, d22 = e2x * e2x + e2y * e2y + e2z * e2z;
      const w1 = wx * e1x + wy * e1y + wz * e1z, w2 = wx * e2x + wy * e2y + wz * e2z, den = d11 * d22 - d12 * d12;
      if (!(den > 0)) return Math.max(DP[i * 3], DP[i * 3 + 1], DP[i * 3 + 2]);
      let u = (d22 * w1 - d12 * w2) / den, v = (d11 * w2 - d12 * w1) / den;
      u = Math.max(0, Math.min(1, u)); v = Math.max(0, Math.min(1 - u, v));
      return DP[i * 3] * (1 - u - v) + DP[i * 3 + 1] * u + DP[i * 3 + 2] * v;
    };
    const X = new Float64Array(18);
    const contact = (i, j, B, ob) => { // j < 0: original face B[ob..]
      const k = MeshGeo.crossPoints(C, i * 9, B, ob, X);
      if (!k) return true; // touching at a point (shared vertex): no crossing segment
      for (let q = 0; q < k; q++) {
        if (depthAt(i, X[q * 3], X[q * 3 + 1], X[q * 3 + 2]) > tol) return false;
        if (j >= 0 && depthAt(j, X[q * 3], X[q * 3 + 1], X[q * 3 + 2]) > tol) return false;
      }
      return true;
    };
    const markNew = new Int32Array(m).fill(-1), markFace = new Int32Array(mesh.nf).fill(-1);
    const v1 = mesh.v1, v2 = mesh.v2, v3 = mesh.v3;
    for (let i = 0; i < m; i++) {
      const i6 = i * 6, ni = near[i];
      const x0 = ci(bb[i6], 0), x1 = ci(bb[i6 + 3], 0), y0 = ci(bb[i6 + 1], 1), y1 = ci(bb[i6 + 4], 1), z0 = ci(bb[i6 + 2], 2), z1 = ci(bb[i6 + 5], 2);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        const c = (x * n + y) * n + z;
        for (let e = cnt[c], end = cnt[c + 1]; e < end; e++) {
          const j = bucket[e];
          if (j <= i || markNew[j] === i) continue;
          markNew[j] = i;
          if (ni && near[j]) continue;
          const j6 = j * 6;
          if (bb[i6] > bb[j6 + 3] || bb[j6] > bb[i6 + 3] || bb[i6 + 1] > bb[j6 + 4] || bb[j6 + 1] > bb[i6 + 4] || bb[i6 + 2] > bb[j6 + 5] || bb[j6 + 2] > bb[i6 + 5]) continue;
          if (oneSide(PL, i, C, j * 9) || oneSide(PL, j, C, i * 9)) continue;
          const hit = pairHit(i, j);
          if (hit === 2 ? !(near[i] && near[j]) : hit && !contact(i, j, C, j * 9)) return true; // 2: flat fold / duplicate
        }
        if (ni) continue;
        for (let e = start[c], end = start[c + 1]; e < end; e++) {
          const f = list[e];
          if (markFace[f] === i) continue;
          markFace[f] = i;
          const a = v1[f] * 3, b = v2[f] * 3, cc = v3[f] * 3;
          if (Math.min(P[a], P[b], P[cc]) > bb[i6 + 3] || Math.max(P[a], P[b], P[cc]) < bb[i6] ||
              Math.min(P[a + 1], P[b + 1], P[cc + 1]) > bb[i6 + 4] || Math.max(P[a + 1], P[b + 1], P[cc + 1]) < bb[i6 + 1] ||
              Math.min(P[a + 2], P[b + 2], P[cc + 2]) > bb[i6 + 5] || Math.max(P[a + 2], P[b + 2], P[cc + 2]) < bb[i6 + 2]) continue;
          for (let k = 0; k < 3; k++) { F[k] = P[a + k]; F[3 + k] = P[b + k]; F[6 + k] = P[cc + k]; }
          if (oneSide(PL, i, F, 0)) continue;
          if (MeshGeo.triTriFlat(C, i * 9, F, 0) && !contact(i, -1, F, 0)) return true;
        }
      }
    }
    return false;
  }

  // Euler characteristic χ = V − E + F of the conformed triangles of a sub set,
  // pinch vertices counted once per wedge (a region touching itself at a
  // vertex is still a disc): 1 for a disc, 0 for a band, 1 − h with h holes.
  function patchEuler(conf, inSet) {
    const { tri, triSub, nT } = conf;
    const T = [];
    for (let t = 0; t < nT; t++) if (inSet[triSub[t]]) T.push(t);
    const nP = T.length, parent = new Int32Array(nP * 3);
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
    const edges = new Map(), NI = conf.NC + 1e9; // keys only need to be unique
    for (let j = 0; j < nP; j++) for (let k = 0; k < 3; k++) {
      const t = T[j], u = tri[t * 3 + k], v = tri[t * 3 + (k + 1) % 3];
      const key = u < v ? u * NI + v : v * NI + u, cu = j * 3 + k, cv = j * 3 + (k + 1) % 3;
      const e = edges.get(key);
      if (!e) edges.set(key, [u < v ? cu : cv, u < v ? cv : cu]);
      else { unite(e[0], u < v ? cu : cv); unite(e[1], u < v ? cv : cu); }
    }
    const roots = new Set();
    for (let c = 0; c < nP * 3; c++) roots.add(find(c));
    return roots.size - edges.size + nP;
  }

  // Does the part wrap around the model (so it cannot be slid into its
  // pocket)? euler: χ of the region itself. wraps: χ ≠ 1 after filling the
  // paint specks — complement components under 1% of the region's area
  // (real rims enclose 0.001 mm² islands that are holes topologically but
  // never block assembly).
  function wrapInfo(g, conf, inSub) {
    const { NS, sv, vx, vy, vz, start, list } = g;
    const area = (s) => {
      const a = sv[s * 3], b = sv[s * 3 + 1], c = sv[s * 3 + 2];
      const ux = vx[b] - vx[a], uy = vy[b] - vy[a], uz = vz[b] - vz[a], wx = vx[c] - vx[a], wy = vy[c] - vy[a], wz = vz[c] - vz[a];
      return Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
    };
    let regionArea = 0;
    for (let s = 0; s < NS; s++) if (inSub[s]) regionArea += area(s);
    const filled = Uint8Array.from(inSub), comp = new Int32Array(NS).fill(-1);
    let specks = 0;
    for (let s0 = 0; s0 < NS; s0++) {
      if (inSub[s0] || comp[s0] >= 0) continue;
      const members = [s0]; comp[s0] = s0;
      let a = 0;
      for (let i = 0; i < members.length; i++) {
        const s = members[i]; a += area(s);
        for (let e = start[s]; e < start[s + 1]; e++) { const v = list[e]; if (!inSub[v] && comp[v] < 0) { comp[v] = s0; members.push(v); } }
      }
      if (a < 0.01 * regionArea) { specks++; for (const s of members) filled[s] = 1; }
    }
    const euler = patchEuler(conf, inSub);
    return { euler, specks, wraps: (specks ? patchEuler(conf, filled) : euler) !== 1 };
  }

  // The faces whose conformed triangulation must replace the original
  // triangle: the region's faces plus, transitively, every face sharing an
  // edge that carries a T-junction midpoint with an affected face (a kept
  // original triangle next to a conformed one would leave a T-junction).
  // corner: welded sub-graph id of every original face corner (the conformed
  // triangles index the same ids, so kept and conformed faces weld there).
  function affectedFaces(mesh, g, subs) {
    const nf = mesh.nf, P = mesh.positions, NVo = P.length / 3;
    const vmapO = new Int32Array(NVo).fill(-2);
    const corner = new Int32Array(nf * 3);
    const affected = new Uint8Array(nf);
    const wid = (v) => { if (vmapO[v] === -2) vmapO[v] = g.vid(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); return vmapO[v]; };
    const edges = new Map(); // welded undirected edge -> faces
    const NV = g.NV;
    for (let f = 0; f < nf; f++) {
      const c = [wid(mesh.v1[f]), wid(mesh.v2[f]), wid(mesh.v3[f])];
      corner[f * 3] = c[0]; corner[f * 3 + 1] = c[1]; corner[f * 3 + 2] = c[2];
      if (c[0] < 0 || c[1] < 0 || c[2] < 0) { affected[f] = 1; continue; } // corner not in the graph: conform it
      for (let k = 0; k < 3; k++) {
        const u = c[k], v = c[(k + 1) % 3], key = u < v ? u * NV + v : v * NV + u;
        const L = edges.get(key);
        if (L) L.push(f); else edges.set(key, [f]);
      }
    }
    const stack = [];
    for (let f = 0; f < nf; f++) if (affected[f]) stack.push(f);
    for (const s of subs) { const f = g.subFace[s]; if (!affected[f]) { affected[f] = 1; stack.push(f); } }
    while (stack.length) {
      const f = stack.pop();
      for (let k = 0; k < 3; k++) {
        const u = corner[f * 3 + k], v = corner[f * 3 + (k + 1) % 3];
        if (u < 0 || v < 0) continue;
        const m = g.midOf(u, v);
        if (m < 0 || m === u || m === v) continue;
        for (const h of edges.get(u < v ? u * NV + v : v * NV + u)) if (!affected[h]) { affected[h] = 1; stack.push(h); }
      }
    }
    return { affected, corner };
  }

  // Volumetric split: the region as a solid plug (patch + inward wall + skin)
  // and the remainder with the matching pocket. Both are plain document meshes.
  // See docs/superpowers/specs/2026-10-13-volumetric-split-design.md.
  function plugSolids(mesh, subs, opts) {
    const depth = Math.max(0, +(opts && opts.depth) || 0);
    const g = Cleanup.buildSubGraph(mesh);
    if (!subs.length) return { error: "Nothing to split there" };
    if (subs.length >= g.NS) return { error: "That's the whole object" };
    if (!(depth > 0)) return { error: "Set a split depth greater than 0" };
    const conf = conformedSurface(g);
    const inSub = new Uint8Array(g.NS);
    for (const s of subs) inSub[s] = 1;
    const field = plugField(mesh, g, conf, inSub, depth);
    const diag = MeshGeo.meshBounds(mesh).diag;
    // weld below snap; contact tolerance ≈0.06 mm on the 63 mm sample, capped at
    // 0.05 mm (below a nozzle width) — print tolerances are absolute
    const snap = 1e-4 * diag, tol = Math.min(1e-3 * diag, 0.05);
    const grid = MeshGeo.faceGrid(mesh);
    const { NV, vx, vy, vz } = g, NI = field.NI, cpos = conf.cpos;
    let scale = 1, halvings = 0, plug, clean = false;
    for (;;) {
      plug = buildPlug(field, conf, scale, snap);
      const ex = plug.extra, src = plug.src;
      const pos = (id) => (id < NV ? [vx[id], vy[id], vz[id]] : id < NI ? [cpos[(id - NV) * 3], cpos[(id - NV) * 3 + 1], cpos[(id - NV) * 3 + 2]] : [ex[(id - NI) * 4], ex[(id - NI) * 4 + 1], ex[(id - NI) * 4 + 2]]);
      const depthOf = (id) => (id < NI ? 0 : ex[(id - NI) * 4 + 3]);
      const canon = (id) => (id < NI ? id : -1 - src[id - NI]);
      plug.pos = pos;
      if (!plugIntersects(mesh, grid, plug.walls.concat(plug.skins), pos, depthOf, canon, tol)) { clean = true; break; }
      if (halvings >= 4) break;
      halvings++; scale /= 2;
    }
    const info = { halvings, shell: false, faces: subs.length, ...wrapInfo(g, conf, inSub) };
    if (!clean) return { error: "Couldn't make a clean solid here (region too thin or sharp for a plug)", info };
    const partState = g.subLeaf[subs[0]].state;
    const pocketState = majorityBorderColor(mesh, g, { subs, state: partState });
    const solid = (st) => Paint.encode({ leaf: true, state: st });
    const { tri, triSub, nT } = conf;
    // one output mesh from id triples + per-triangle paint strings (compact vertex ids)
    const emit = (F, paints) => {
      const remap = new Map(), xyz = [];
      const nf = F.length / 3, v1 = new Int32Array(nf), v2 = new Int32Array(nf), v3 = new Int32Array(nf);
      const P = mesh.positions, at = (id) => (id < 0 ? [P[(-1 - id) * 3], P[(-1 - id) * 3 + 1], P[(-1 - id) * 3 + 2]] : plug.pos(id));
      const lid = (id) => { let i = remap.get(id); if (i === undefined) { i = remap.size; remap.set(id, i); xyz.push(...at(id)); } return i; };
      for (let f = 0; f < nf; f++) { v1[f] = lid(F[f * 3]); v2[f] = lid(F[f * 3 + 1]); v3[f] = lid(F[f * 3 + 2]); }
      return { positions: Float32Array.from(xyz), nf, v1, v2, v3, paints };
    };
    // Only AFFECTED faces are re-triangulated (conformed); every other face of
    // the remainder is its original triangle with its original paint string.
    const { affected, corner } = affectedFaces(mesh, g, subs);
    info.affectedFaces = affected.reduce((n, a) => n + a, 0);
    const PF = [], PS = [], RF = [], RS = [];
    const isPatch = new Int8Array(nT).fill(-1); // 1: patch kept in the part, 2: cancelled patch (-> remainder), -1: remainder
    field.pTris.forEach((t, j) => { isPatch[t] = plug.cancelled[j] ? 2 : 1; });
    for (let t = 0; t < nT; t++) {
      if (!affected[g.subFace[triSub[t]]]) continue;
      const p = solid(g.subLeaf[triSub[t]].state);
      if (isPatch[t] === 1) { PF.push(tri[t * 3], tri[t * 3 + 1], tri[t * 3 + 2]); PS.push(p); }
      else { RF.push(tri[t * 3], tri[t * 3 + 1], tri[t * 3 + 2]); RS.push(p); } // remainder + cancelled patch
    }
    // kept faces keep their ORIGINAL vertex ids (encoded −1 − v), except at
    // vertices they share with affected faces, which take the welded id so
    // the two weld. (Welding everything by coordinate would merge coincident
    // vertices an earlier split kept apart — the per-wedge pinch copies.)
    const touches = new Uint8Array(mesh.positions.length / 3), VO = [mesh.v1, mesh.v2, mesh.v3];
    for (let f = 0; f < mesh.nf; f++) if (affected[f]) for (const V of VO) touches[V[f]] = 1;
    for (let f = 0; f < mesh.nf; f++) {
      if (affected[f]) continue;
      for (let k = 0; k < 3; k++) { const v = VO[k][f]; RF.push(touches[v] ? corner[f * 3 + k] : -1 - v); }
      RS.push(mesh.paints[f]);
    }
    const partP = solid(partState), pocketP = solid(pocketState);
    for (const L of [plug.walls, plug.skins]) for (let i = 0; i < L.length; i += 3) {
      PF.push(L[i], L[i + 1], L[i + 2]); PS.push(partP);
      RF.push(L[i], L[i + 2], L[i + 1]); RS.push(pocketP);
    }
    const part = emit(PF, PS), remainder = emit(RF, RS);
    const bad = (mm) => MeshGeo.checkClosed(mm) || !(MeshGeo.signedVolume(mm) > 0);
    if (bad(part) || bad(remainder)) return { error: "Couldn't make a clean solid here (region too thin or sharp for a plug)", info };
    const out = { part, remainder, info };
    if (opts && opts.debug) { // test hook: the new triangles (part winding) and where each plug vertex came from
      const src = plug.src;
      out.debug = { tris: plug.walls.concat(plug.skins), pos: plug.pos, NI, source: (id) => (id < NI ? id : src[id - NI]), conf, subFace: g.subFace, affected };
    }
    return out;
  }

  // Test hook: the displacement field of a region, per welded sub-graph vertex.
  function plugFieldOf(mesh, subs, depth) {
    const g = Cleanup.buildSubGraph(mesh), conf = conformedSurface(g);
    const inSub = new Uint8Array(g.NS); for (const s of subs) inSub[s] = 1;
    const f = plugField(mesh, g, conf, inSub, depth);
    const dir = new Map(), t = new Map();
    f.ids.forEach((id, i) => { if (id < g.NV) { dir.set(id, [f.D[i * 3], f.D[i * 3 + 1], f.D[i * 3 + 2]]); t.set(id, f.s[i]); } });
    return { dir, t };
  }
  // Most common remainder state adjacent to the part's boundary (the part's subs'
  // neighbouring sub-triangles that are NOT in the part). Falls back to the part's
  // own state.
  function majorityBorderColor(mesh, g, part) {
    const inPart = new Set(part.subs);
    const votes = new Map();
    const { start, list, subLeaf } = g;
    for (const s of part.subs) {
      for (let e = start[s]; e < start[s + 1]; e++) {
        const v = list[e];
        if (!inPart.has(v)) votes.set(subLeaf[v].state, (votes.get(subLeaf[v].state) || 0) + 1);
      }
    }
    let best = -1, col = part.state;
    votes.forEach((n, st) => { if (n > best) { best = n; col = st; } });
    return col;
  }

  // Row layout for split parts: slots along +X beside the body, y-centered on
  // it, bottoms aligned to its base plane. Boxes: { min:[x,y,z], max:[x,y,z] }.
  // Returns one [dx, dy, dz] offset per part box.
  function layoutParts(bodyBox, partBoxes, margin) {
    margin = margin || 0;
    const bcy = (bodyBox.min[1] + bodyBox.max[1]) / 2;
    let cursor = bodyBox.max[0] + margin;
    return partBoxes.map((p) => {
      const dx = cursor - p.min[0];
      const dy = bcy - (p.min[1] + p.max[1]) / 2;
      const dz = bodyBox.min[2] - p.min[2];
      cursor += (p.max[0] - p.min[0]) + margin;
      return [dx, dy, dz];
    });
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
      const P = o.positions, I = o.indices, TS = o.triState, PS = o.paints;
      const vlines = [];
      for (let i = 0; i < P.length; i += 3)
        vlines.push('     <vertex x="' + fnum(P[i]) + '" y="' + fnum(P[i + 1]) +
          '" z="' + fnum(P[i + 2]) + '"/>');
      const tlines = [];
      for (let t = 0; t < I.length; t += 3) {
        let line = '     <triangle v1="' + I[t] + '" v2="' + I[t + 1] +
          '" v3="' + I[t + 2] + '"';
        if (PS) {
          const p = PS[t / 3];
          if (p) line += ' paint_color="' + p + '"';
        } else if (TS) {
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

global.Split = { plugSolids, plugField: plugFieldOf, _plugIntersects: plugIntersects, buildSplitXML, uuid, layoutParts };
})(window);
