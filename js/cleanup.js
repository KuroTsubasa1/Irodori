/* cleanup.js — color-correction operations over a painted mesh.
 *
 * Two operations:
 *   removeIslands  — find connected same-color regions and reassign the small
 *                    ones (<= maxFaces) to the surrounding majority color.
 *                    Removes stray blobs and short lines of a wrong color.
 *   removeSlivers  — inside boundary (subdivided) faces, drop sub-triangles of
 *                    a chosen color when they are a minority, replacing them
 *                    with the face's dominant color. Cleans thin color seams.
 *
 * The mesh keeps two parallel views, both updated by these ops:
 *   mesh.dom    Int32Array  — dominant state per face (drives the 3D colors)
 *   mesh.paints string[]    — paint_color codes (drives .3mf export)
 */
(function (global) {
  "use strict";

  function computeDominant(mesh) {
    if (mesh.dom) return mesh.dom;
    const nf = mesh.nf;
    const dom = new Int32Array(nf);
    for (let i = 0; i < nf; i++) {
      const p = mesh.paints[i];
      const s = Paint.solidState(p);
      dom[i] = s >= 0 ? s : Paint.dominantState(Paint.decode(p));
    }
    mesh.dom = dom;
    return dom;
  }

  // CSR adjacency over original faces (neighbors share an edge).
  function buildAdjacency(mesh) {
    if (mesh.adj) return mesh.adj;
    const nf = mesh.nf,
      nv = mesh.nv;
    const v1 = mesh.v1,
      v2 = mesh.v2,
      v3 = mesh.v3;
    const edgeMap = new Map(); // key -> faceIndex (first occupant)
    // count neighbors first for CSR sizing
    const deg = new Int32Array(nf);
    const pairs = []; // flat [faceA, faceB, ...]
    function edge(a, b, f) {
      const key = a < b ? a * nv + b : b * nv + a;
      const prev = edgeMap.get(key);
      if (prev === undefined) {
        edgeMap.set(key, f);
      } else {
        pairs.push(prev, f);
        deg[prev]++;
        deg[f]++;
        edgeMap.set(key, -1); // mark used (ignore further faces on this edge)
      }
    }
    for (let f = 0; f < nf; f++) {
      const a = v1[f],
        b = v2[f],
        c = v3[f];
      edge(a, b, f);
      edge(b, c, f);
      edge(a, c, f);
    }
    const start = new Int32Array(nf + 1);
    for (let f = 0; f < nf; f++) start[f + 1] = start[f] + deg[f];
    const list = new Int32Array(start[nf]);
    const cur = start.slice(0, nf);
    for (let i = 0; i < pairs.length; i += 2) {
      const a = pairs[i],
        b = pairs[i + 1];
      list[cur[a]++] = b;
      list[cur[b]++] = a;
    }
    mesh.adj = { start, list };
    return mesh.adj;
  }

  function setSolid(mesh, i, state) {
    mesh.dom[i] = state;
    mesh.paints[i] = state === 0 ? "" : Paint.encode({ leaf: true, state: state });
  }

  /* Connected-component island removal.
   * opts: { maxFaces, removable:Set<state>, passes }
   * Returns { count, changed:[faceIndex], details:[{face,from,to}] }. */
  function removeIslands(mesh, opts) {
    const dom = computeDominant(mesh);
    const { start, list } = buildAdjacency(mesh);
    const nf = mesh.nf;
    const maxFaces = opts.maxFaces;
    const removable = opts.removable; // Set of states allowed to be removed
    const passes = opts.passes || 5;

    const allChanged = new Map(); // face -> from-state (first time it changed)
    const stack = new Int32Array(64);

    for (let pass = 0; pass < passes; pass++) {
      const snap = dom.slice(); // components computed from a stable snapshot
      const comp = new Int32Array(nf).fill(-1);
      let changedThisPass = 0;

      for (let seed = 0; seed < nf; seed++) {
        if (comp[seed] !== -1) continue;
        const st = snap[seed];
        // flood the component
        const members = [];
        let sp = 0;
        let s = stack;
        s[sp++] = seed;
        comp[seed] = seed;
        while (sp > 0) {
          const u = s[--sp];
          members.push(u);
          for (let e = start[u]; e < start[u + 1]; e++) {
            const v = list[e];
            if (comp[v] === -1 && snap[v] === st) {
              comp[v] = seed;
              if (sp >= s.length) {
                const ns = new Int32Array(s.length * 2);
                ns.set(s);
                s = ns;
              }
              s[sp++] = v;
            }
          }
        }

        if (members.length > maxFaces) continue;
        if (!removable.has(st)) continue;

        // tally surrounding states (by shared-edge count) outside the component
        const votes = new Map();
        for (let k = 0; k < members.length; k++) {
          const u = members[k];
          for (let e = start[u]; e < start[u + 1]; e++) {
            const v = list[e];
            if (comp[v] !== seed) {
              const vs = snap[v];
              votes.set(vs, (votes.get(vs) || 0) + 1);
            }
          }
        }
        if (votes.size === 0) continue; // floating region, nothing to merge into
        let target = -1,
          best = -1;
        votes.forEach((n, vs) => {
          if (vs !== st && (n > best || (n === best && vs < target))) {
            best = n;
            target = vs;
          }
        });
        if (target === -1) continue;

        for (let k = 0; k < members.length; k++) {
          const u = members[k];
          if (!allChanged.has(u)) allChanged.set(u, st);
          setSolid(mesh, u, target);
          changedThisPass++;
        }
      }
      if (changedThisPass === 0) break;
    }

    const changed = [];
    const details = [];
    allChanged.forEach((from, face) => {
      changed.push(face);
      details.push({ face, from, to: dom[face] });
    });
    return { count: changed.length, changed, details };
  }

  /* Sub-triangle sliver removal: in subdivided faces, replace minority
   * sub-triangles whose state is in `targets` with the face's dominant state.
   * opts: { targets:Set<state> }. */
  function removeSlivers(mesh, opts) {
    const dom = computeDominant(mesh);
    const targets = opts.targets;
    const nf = mesh.nf;
    const changed = [];
    for (let i = 0; i < nf; i++) {
      const p = mesh.paints[i];
      if (Paint.solidState(p) >= 0) continue; // not subdivided
      const tree = Paint.decode(p);
      const counts = {};
      Paint.addLeafCounts(tree, counts);
      const d = mesh.dom[i];
      // does it contain a minority target?
      let hit = false;
      targets.forEach((t) => {
        if (t !== d && counts[t] && counts[t] < (counts[d] || 0)) hit = true;
      });
      if (!hit) continue;
      const mapped = Paint.remapLeaves(tree, (s) =>
        targets.has(s) && s !== d && (counts[s] || 0) < (counts[d] || 0) ? d : s
      );
      const collapsed = Paint.collapseIfUniform(mapped);
      mesh.paints[i] = Paint.encode(collapsed);
      mesh.dom[i] = Paint.dominantState(collapsed);
      changed.push(i);
    }
    return { count: changed.length, changed };
  }

  /* Stats: face counts and component summary per state. */
  function stats(mesh, smallThreshold) {
    const dom = computeDominant(mesh);
    const { start, list } = buildAdjacency(mesh);
    const nf = mesh.nf;
    const faceCount = {};
    for (let i = 0; i < nf; i++) faceCount[dom[i]] = (faceCount[dom[i]] || 0) + 1;

    const comp = new Int32Array(nf).fill(-1);
    const small = {}; // state -> number of small components
    const total = {}; // state -> total components
    let stk = new Int32Array(64);
    for (let seed = 0; seed < nf; seed++) {
      if (comp[seed] !== -1) continue;
      const st = dom[seed];
      let sp = 0,
        sz = 0;
      stk[sp++] = seed;
      comp[seed] = seed;
      while (sp > 0) {
        const u = stk[--sp];
        sz++;
        for (let e = start[u]; e < start[u + 1]; e++) {
          const v = list[e];
          if (comp[v] === -1 && dom[v] === st) {
            comp[v] = seed;
            if (sp >= stk.length) {
              const ns = new Int32Array(stk.length * 2);
              ns.set(stk);
              stk = ns;
            }
            stk[sp++] = v;
          }
        }
      }
      total[st] = (total[st] || 0) + 1;
      if (sz <= smallThreshold) small[st] = (small[st] || 0) + 1;
    }
    return { faceCount, small, total };
  }

  global.Cleanup = {
    computeDominant,
    buildAdjacency,
    removeIslands,
    removeSlivers,
    stats,
    setSolid,
  };
})(window);
