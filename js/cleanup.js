/* cleanup.js — paint-MUTATING operations over the sub-triangle graph:
 * brush/ring writes (applyStates), stamp-refinement painting (paintStamps),
 * flood fill, small-island auto-clean, and whole-mesh state remaps.
 *
 * Part of the `Cleanup` namespace (loads after subgraph.js + select.js).
 * Cross-file calls (buildSubGraph, invalidateSub, floodComponent) go through
 * the shared namespace at call time.
 */
(function (global) {
  "use strict";
  const Cleanup = (global.Cleanup = global.Cleanup || {});

  // Rewrite every face's paint states through mapFn (decode -> remapLeaves ->
  // collapse -> encode). Used when deleting a filament (k -> 0, >k shifts down).
  // Note: remapLeaves returns the same node only for untouched LEAF faces;
  // split faces are always rebuilt, so the encode comparison filters no-ops.
  function remapStates(mesh, mapFn) {
    let changed = 0;
    for (let f = 0; f < mesh.nf; f++) {
      const tree = Paint.decode(mesh.paints[f]);
      const mapped = Paint.remapLeaves(tree, mapFn);
      if (mapped === tree) continue;
      const col = Paint.collapseDeep(mapped);
      const enc = Paint.encode(col);
      if (enc !== mesh.paints[f]) {
        mesh.paints[f] = enc;
        changed++;
        if (mesh.dom) mesh.dom[f] = Paint.dominantState(col);
      }
    }
    if (changed) Cleanup.invalidateSub(mesh);
    return changed;
  }

  // Paint the given local sub-triangles to `state`; re-encode affected faces.
  // Does NOT collapse, so the cached graph stays valid for fast repeated paints.
  function applyStates(mesh, subs, state) {
    const g = Cleanup.buildSubGraph(mesh);
    const { subLeaf, subFace, trees } = g;
    const changedFaces = new Set();
    for (let k = 0; k < subs.length; k++) {
      const s = subs[k];
      if (subLeaf[s].state !== state) {
        subLeaf[s].state = state;
        changedFaces.add(subFace[s]);
      }
    }
    const dom = mesh.dom;
    changedFaces.forEach((f) => {
      mesh.paints[f] = Paint.encode(trees[f]);
      if (dom) dom[f] = Paint.dominantState(trees[f]);
    });
    mesh._subSizes = null; // states changed; graph geometry unchanged
    return { changedFaces, count: subs.length };
  }

  /* Remove small same-color sub-triangle islands.
   * opts: { maxSize, removable:Set<state>, passes }
   * Returns { count, changedFaces:Set }. Mutates mesh.paints/dom in place. */
  function removeIslandsSub(mesh, opts) {
    const g = Cleanup.buildSubGraph(mesh);
    const { start, list, subLeaf, subFace, trees, NS } = g;
    const maxSize = opts.maxSize,
      removable = opts.removable,
      passes = opts.passes || 3;

    const state = new Int32Array(NS);
    for (let i = 0; i < NS; i++) state[i] = subLeaf[i].state;

    const comp = new Int32Array(NS);
    const scratch = { stk: new Int32Array(1024) };

    for (let pass = 0; pass < passes; pass++) {
      comp.fill(-1);
      let changed = 0;
      for (let seed = 0; seed < NS; seed++) {
        if (comp[seed] !== -1) continue;
        const st = state[seed];
        const members = Cleanup.floodComponent(start, list, state, comp, seed, scratch);
        if (members.length > maxSize || !removable.has(st)) continue;
        // vote on surrounding color (by shared sub-edge count)
        const votes = new Map();
        for (let k = 0; k < members.length; k++) {
          const u = members[k];
          for (let e = start[u]; e < start[u + 1]; e++) {
            const v = list[e];
            if (comp[v] !== seed) votes.set(state[v], (votes.get(state[v]) || 0) + 1);
          }
        }
        let target = -1,
          best = -1;
        votes.forEach((n, vs) => {
          if (vs !== st && (n > best || (n === best && vs < target))) {
            best = n;
            target = vs;
          }
        });
        if (target === -1) continue;
        for (let k = 0; k < members.length; k++) state[members[k]] = target;
        changed += members.length;
      }
      if (changed === 0) break;
    }

    // write back changed states into the paint trees and re-encode
    const changedFaces = new Set();
    let count = 0;
    for (let i = 0; i < NS; i++) {
      if (state[i] !== subLeaf[i].state) {
        subLeaf[i].state = state[i];
        changedFaces.add(subFace[i]);
        count++;
      }
    }
    const dom = mesh.dom;
    changedFaces.forEach((f) => {
      const col = Paint.collapseIfUniform(trees[f]);
      mesh.paints[f] = Paint.encode(col);
      if (dom) dom[f] = Paint.dominantState(col);
    });
    Cleanup.invalidateSub(mesh);
    return { count, changedFaces };
  }

  /* Manual flood fill: from sub-triangle `seedSub`, flood its connected
   * same-color region and recolor it. targetState = a state to paint with, or
   * null to use the surrounding majority color (like auto-cleanup, per click).
   * Keeps the cached graph valid (no collapse), so repeated fills stay fast.
   * Returns { count, changedFaces, from, to }. */
  function fillRegion(mesh, seedSub, targetState) {
    const g = Cleanup.buildSubGraph(mesh);
    const { start, list, subLeaf, subFace, trees, NS } = g;
    if (seedSub < 0 || seedSub >= NS) return { count: 0, changedFaces: new Set() };
    const seedState = subLeaf[seedSub].state;

    // flood the same-state component
    const seen = new Uint8Array(NS);
    const members = [];
    const stk = [seedSub];
    seen[seedSub] = 1;
    while (stk.length) {
      const u = stk.pop();
      members.push(u);
      for (let e = start[u]; e < start[u + 1]; e++) {
        const v = list[e];
        if (!seen[v] && subLeaf[v].state === seedState) {
          seen[v] = 1;
          stk.push(v);
        }
      }
    }

    let target = targetState;
    if (target == null) {
      const votes = new Map();
      for (let k = 0; k < members.length; k++) {
        const u = members[k];
        for (let e = start[u]; e < start[u + 1]; e++) {
          const v = list[e];
          if (!seen[v]) votes.set(subLeaf[v].state, (votes.get(subLeaf[v].state) || 0) + 1);
        }
      }
      let best = -1;
      target = seedState;
      votes.forEach((n, s) => {
        if (s !== seedState && (n > best || (n === best && s < target))) {
          best = n;
          target = s;
        }
      });
    }
    if (target === seedState) return { count: 0, changedFaces: new Set() };

    const changedFaces = new Set();
    for (let k = 0; k < members.length; k++) {
      subLeaf[members[k]].state = target;
      changedFaces.add(subFace[members[k]]);
    }
    const dom = mesh.dom;
    changedFaces.forEach((f) => {
      mesh.paints[f] = Paint.encode(trees[f]); // no collapse -> graph stays valid
      if (dom) dom[f] = Paint.dominantState(trees[f]);
    });
    mesh._subSizes = null; // component sizes changed (graph geometry unchanged)
    return { count: members.length, changedFaces, from: seedState, to: target };
  }

  // Squared distance from point p to triangle (a,b,c) — Ericson's closest-point
  // construction, all inputs flat scalars.
  function dist2PointTri(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const v = d1 / (d1 - d3);
      const qx = ax + abx * v - px, qy = ay + aby * v - py, qz = az + abz * v - pz;
      return qx * qx + qy * qy + qz * qz;
    }
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const w = d2 / (d2 - d6);
      const qx = ax + acx * w - px, qy = ay + acy * w - py, qz = az + acz * w - pz;
      return qx * qx + qy * qy + qz * qz;
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
      const qx = bx + (cx - bx) * w - px, qy = by + (cy - by) * w - py, qz = bz + (cz - bz) * w - pz;
      return qx * qx + qy * qy + qz * qz;
    }
    const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
    const qx = ax + abx * v + acx * w - px, qy = ay + aby * v + acy * w - py, qz = az + abz * v + acz * w - pz;
    return qx * qx + qy * qy + qz * qz;
  }

  /* Slicer-style stamp painting: paint leaves fully inside the stamp union and
   * SUBDIVIDE leaves crossing the stamp edge (4-way splits, depth-capped), so
   * stroke edges follow the brush instead of whole leaves. Child geometry uses
   * Paint.tessellate's exact conventions (corner rotation by `special`,
   * midpoints, reversed kid order). Trees are re-collapsed and re-encoded.
   * stamps: [{x,y,z,r}]. Returns { count, changedFaces }.
   * maxDepth is ABSOLUTE depth from the face root (not additional levels), so
   * leaves the slicer already split deeply refine less — their leaves are tiny
   * (~4^-depth of the face), keeping edge error sub-leaf-sized either way. */
  function paintStamps(mesh, stamps, state, opts) {
    const maxDepth = (opts && opts.maxDepth) || 4;
    const P = mesh.positions;
    const covered = (x, y, z) => {
      for (const s of stamps) {
        const dx = x - s.x, dy = y - s.y, dz = z - s.z;
        if (dx * dx + dy * dy + dz * dz <= s.r * s.r) return true;
      }
      return false;
    };
    const overlaps = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
      for (const s of stamps) {
        if (dist2PointTri(s.x, s.y, s.z, ax, ay, az, bx, by, bz, cx, cy, cz) <= s.r * s.r) return true;
      }
      return false;
    };
    // broad phase: stamp union AABB vs face AABB
    let sx0 = Infinity, sy0 = Infinity, sz0 = Infinity, sx1 = -Infinity, sy1 = -Infinity, sz1 = -Infinity;
    for (const s of stamps) {
      sx0 = Math.min(sx0, s.x - s.r); sy0 = Math.min(sy0, s.y - s.r); sz0 = Math.min(sz0, s.z - s.r);
      sx1 = Math.max(sx1, s.x + s.r); sy1 = Math.max(sy1, s.y + s.r); sz1 = Math.max(sz1, s.z + s.r);
    }

    let count = 0;
    const changedFaces = new Set();
    let faceChanged = false;

    function walk(node, depth, ax, ay, az, bx, by, bz, cx, cy, cz) {
      if (node.leaf) {
        if (!overlaps(ax, ay, az, bx, by, bz, cx, cy, cz)) return;
        const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;
        const full = covered(ax, ay, az) && covered(bx, by, bz) && covered(cx, cy, cz) && covered(mx, my, mz);
        if (full) {
          if (node.state !== state) { node.state = state; count++; faceChanged = true; }
          return;
        }
        if (depth >= maxDepth) {
          if (covered(mx, my, mz) && node.state !== state) { node.state = state; count++; faceChanged = true; }
          return;
        }
        // partial overlap: split this leaf in place (children inherit its state)
        const st = node.state;
        node.leaf = false; node.split = 3; node.special = 0;
        node.kids = [
          { leaf: true, state: st }, { leaf: true, state: st },
          { leaf: true, state: st }, { leaf: true, state: st },
        ];
        faceChanged = true;
        // fall through into the split handling below
      }
      const sp = node.special, split = node.split, kids = node.kids;
      const cs = [ax, ay, az, bx, by, bz, cx, cy, cz];
      const A = sp * 3, B = ((sp + 1) % 3) * 3, D = ((sp + 2) % 3) * 3;
      const Ax = cs[A], Ay = cs[A + 1], Az = cs[A + 2];
      const Bx = cs[B], By = cs[B + 1], Bz = cs[B + 2];
      const Dx = cs[D], Dy = cs[D + 1], Dz = cs[D + 2];
      const k = (g) => kids[split - g]; // tessellate's reversed kid mapping
      if (split === 1) {
        const mx = (Bx + Dx) / 2, my = (By + Dy) / 2, mz = (Bz + Dz) / 2;
        walk(k(0), depth + 1, Ax, Ay, Az, Bx, By, Bz, mx, my, mz);
        walk(k(1), depth + 1, mx, my, mz, Dx, Dy, Dz, Ax, Ay, Az);
      } else if (split === 2) {
        const m1x = (Ax + Bx) / 2, m1y = (Ay + By) / 2, m1z = (Az + Bz) / 2;
        const m2x = (Ax + Dx) / 2, m2y = (Ay + Dy) / 2, m2z = (Az + Dz) / 2;
        walk(k(0), depth + 1, Ax, Ay, Az, m1x, m1y, m1z, m2x, m2y, m2z);
        walk(k(1), depth + 1, m1x, m1y, m1z, Bx, By, Bz, m2x, m2y, m2z);
        walk(k(2), depth + 1, Bx, By, Bz, Dx, Dy, Dz, m2x, m2y, m2z);
      } else {
        const m1x = (Ax + Bx) / 2, m1y = (Ay + By) / 2, m1z = (Az + Bz) / 2;
        const m2x = (Bx + Dx) / 2, m2y = (By + Dy) / 2, m2z = (Bz + Dz) / 2;
        const m3x = (Ax + Dx) / 2, m3y = (Ay + Dy) / 2, m3z = (Az + Dz) / 2;
        walk(k(0), depth + 1, Ax, Ay, Az, m1x, m1y, m1z, m3x, m3y, m3z);
        walk(k(1), depth + 1, m1x, m1y, m1z, Bx, By, Bz, m2x, m2y, m2z);
        walk(k(2), depth + 1, m2x, m2y, m2z, Dx, Dy, Dz, m3x, m3y, m3z);
        walk(k(3), depth + 1, m1x, m1y, m1z, m2x, m2y, m2z, m3x, m3y, m3z);
      }
    }

    for (let f = 0; f < mesh.nf; f++) {
      const a = mesh.v1[f] * 3, b = mesh.v2[f] * 3, c = mesh.v3[f] * 3;
      const x0 = P[a], y0 = P[a + 1], z0 = P[a + 2];
      const x1 = P[b], y1 = P[b + 1], z1 = P[b + 2];
      const x2 = P[c], y2 = P[c + 1], z2 = P[c + 2];
      if (Math.max(x0, x1, x2) < sx0 || Math.min(x0, x1, x2) > sx1 ||
          Math.max(y0, y1, y2) < sy0 || Math.min(y0, y1, y2) > sy1 ||
          Math.max(z0, z1, z2) < sz0 || Math.min(z0, z1, z2) > sz1) continue;
      const tree = Paint.decode(mesh.paints[f]);
      faceChanged = false;
      walk(tree, 0, x0, y0, z0, x1, y1, z1, x2, y2, z2);
      if (faceChanged) {
        const col = Paint.collapseDeep(tree);
        mesh.paints[f] = Paint.encode(col);
        if (mesh.dom) mesh.dom[f] = Paint.dominantState(col);
        changedFaces.add(f);
      }
    }
    if (changedFaces.size) Cleanup.invalidateSub(mesh);
    return { count, changedFaces };
  }

  Object.assign(Cleanup, {
    applyStates,
    removeIslandsSub,
    fillRegion,
    paintStamps,
    remapStates,
  });
})(window);
