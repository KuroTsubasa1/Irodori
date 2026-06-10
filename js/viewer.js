/* viewer.js — three.js rendering of the painted mesh at full sub-triangle
 * resolution (matches what the slicer shows: a face can be painted in pieces).
 *
 * Each face's paint tree is tessellated into leaf sub-triangles via
 * Paint.tessellate. Geometry is rebuilt on structural changes; colors are a
 * separate cheap pass so previews can highlight changed faces.
 */
(function (global) {
  "use strict";

  let scene, camera, renderer, controls, root, meshObj;
  let doc = null;
  let geom = null,
    colorAttr = null;

  // per-build state
  let triState = null; // Int32Array: state of each sub-triangle
  let faceStart = null; // Int32Array(totalFaces+1): sub-tri range per global face
  let meshFaceOffset = []; // global face offset per mesh
  let meshSubOffset = []; // global sub-triangle offset per mesh (+sentinel)
  let totalSub = 0;
  let renderMap = [];    // per mesh: rendered-sub index -> original localSub
  let origToRender = []; // per mesh: Map<original localSub, rendered-sub index>
  let splitObjs = [];    // [{ mesh, target:THREE.Vector3, cur:THREE.Vector3 }]
  let remainderCapObjs = []; // separate double-sided meshes that fill split holes
  let claimedSets = [];  // per mesh: Set<localSub> hidden from the main mesh

  // picking
  let raycaster, mouse;
  let toolMode = "orbit",
    pickCb = null,
    paintCb = null,
    pointerDown = null,
    painting = false,
    moveRaf = false,
    lastMove = null;
  let altOrbit = false; // Alt held in paint mode -> temporary left-drag orbit
  // brush/ring cursor preview
  let cursorLoop = null,
    hoverEnabled = false,
    hoverCb = null;
  const ZUP = new THREE.Vector3(0, 0, 1);
  const tmpV = new THREE.Vector3(),
    tmpQ = new THREE.Quaternion();

  const HIGHLIGHT = new THREE.Color("#1fe3ff").convertSRGBToLinear();

  function init(container) {
    scene = new THREE.Scene();
    scene.background = null; // let the CSS gradient stage show through
    const w = container.clientWidth,
      h = container.clientHeight;
    camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 5000);
    camera.up.set(0, 0, 1); // Z is up (printer convention) so models stand upright
    camera.position.set(80, -120, 80);
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(w, h);
    renderer.setClearColor(0x000000, 0);
    renderer.outputEncoding = THREE.sRGBEncoding;
    container.appendChild(renderer.domElement);
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    // studio lighting: soft ambient + key / fill / rim for form and separation
    scene.add(new THREE.HemisphereLight(0xffffff, 0xb9bfc9, 0.7));
    scene.add(new THREE.AmbientLight(0xffffff, 0.25));
    const key = new THREE.DirectionalLight(0xffffff, 0.95);
    key.position.set(0.7, 1.0, 0.85);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-0.9, 0.35, 0.5);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.7);
    rim.position.set(-0.4, 0.7, -1.0); // back light to outline the silhouette
    scene.add(rim);
    root = new THREE.Group();
    scene.add(root);

    cursorLoop = circleLoop("#111111");
    scene.add(cursorLoop);

    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();
    const el = renderer.domElement;
    el.addEventListener("pointerdown", (e) => {
      pointerDown = { x: e.clientX, y: e.clientY };
      if (toolMode === "paint" && e.button === 0 && paintCb && !altOrbit) {
        painting = true;
        const hit = pick(e.clientX, e.clientY);
        if (hit && paintCb.down) paintCb.down(hit);
      }
    });
    el.addEventListener("pointermove", (e) => {
      lastMove = { x: e.clientX, y: e.clientY };
      if (moveRaf) return;
      moveRaf = true;
      requestAnimationFrame(() => {
        moveRaf = false;
        if (!lastMove) return;
        const want = painting || hoverEnabled;
        const hit = want ? pick(lastMove.x, lastMove.y) : null;
        if (painting && hit && paintCb && paintCb.move) paintCb.move(hit);
        if (hoverEnabled && !painting && hoverCb) hoverCb(hit);
      });
    });
    el.addEventListener("pointerleave", () => { if (hoverCb) hoverCb(null); });
    window.addEventListener("pointerup", (e) => {
      if (painting) {
        painting = false;
        if (paintCb && paintCb.up) paintCb.up();
        pointerDown = null;
        return;
      }
      const d = pointerDown;
      pointerDown = null;
      if (toolMode !== "pick" || !pickCb || !d) return;
      const dx = e.clientX - d.x,
        dy = e.clientY - d.y;
      if (dx * dx + dy * dy > 36) return; // a drag (rotate), not a click
      const hit = pick(e.clientX, e.clientY);
      if (hit) pickCb(hit);
    });

    window.addEventListener("resize", () => onResize(container));
    window.addEventListener("keydown", (e) => {
      if (e.key === "Alt" && toolMode === "paint" && !altOrbit) {
        altOrbit = true;
        controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
        renderer.domElement.style.cursor = "grab";
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.key === "Alt" && altOrbit) {
        altOrbit = false;
        if (toolMode === "paint") {
          controls.mouseButtons.LEFT = null;
          renderer.domElement.style.cursor = "crosshair";
        }
      }
    });
    animate();
  }

  // Tool/interaction mode: 'orbit' | 'pick' (click) | 'paint' (drag).
  function setTool(mode) {
    toolMode = mode;
    altOrbit = false;
    if (!controls) return;
    const M = THREE.MOUSE;
    if (mode === "paint") {
      // left paints, right-drag rotates
      controls.mouseButtons = { LEFT: null, MIDDLE: M.DOLLY, RIGHT: M.ROTATE };
      renderer.domElement.style.cursor = "crosshair";
    } else {
      controls.mouseButtons = { LEFT: M.ROTATE, MIDDLE: M.DOLLY, RIGHT: M.PAN };
      renderer.domElement.style.cursor = mode === "pick" ? "crosshair" : "";
    }
  }
  function onPaint(handlers) {
    paintCb = handlers;
  }
  // Map an original (graph) sub index to its rendered slot. Returns -1 when the
  // sub is claimed by a split part (not present in the main mesh), so callers
  // that recolor live (paintSubs) skip it.
  function toGlobalSub(meshIndex, localSub) {
    const map = origToRender[meshIndex];
    if (!map) return -1;
    const r = map.get(localSub);
    return r === undefined ? -1 : meshSubOffset[meshIndex] + r;
  }
  // Live recolor of specific sub-triangles (no rebuild) — used while brushing.
  function paintSubs(globalSubs, state) {
    if (!colorAttr) return;
    const col = linColor(state);
    const colors = colorAttr.array;
    for (let i = 0; i < globalSubs.length; i++) {
      const gi = globalSubs[i];
      if (gi < 0) continue; // claimed-by-split sub: not in the main mesh
      const o = gi * 9;
      for (let k = 0; k < 9; k += 3) {
        colors[o + k] = col.r;
        colors[o + k + 1] = col.g;
        colors[o + k + 2] = col.b;
      }
    }
    colorAttr.needsUpdate = true;
  }

  // Raycast the mesh; returns { meshIndex, localSub, state, point } or null.
  function pick(clientX, clientY) {
    if (!meshObj) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObject(meshObj, false);
    if (!hits.length) return null;
    const gsub = hits[0].faceIndex; // one geometry triangle == one sub-triangle
    let mi = 0;
    while (mi + 2 < meshSubOffset.length && meshSubOffset[mi + 1] <= gsub) mi++;
    const renderedLocal = gsub - meshSubOffset[mi];
    return {
      meshIndex: mi,
      localSub: renderMap[mi][renderedLocal],
      state: triState[gsub],
      point: hits[0].point,
      normal: hits[0].face ? hits[0].face.normal : ZUP,
    };
  }

  // a unit circle line loop (XY plane), drawn on top as a cursor
  function circleLoop(color) {
    const seg = 56;
    const pos = new Float32Array(seg * 3);
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      pos[i * 3] = Math.cos(a);
      pos[i * 3 + 1] = Math.sin(a);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const m = new THREE.LineBasicMaterial({ color: color, transparent: true, depthTest: false });
    const l = new THREE.LineLoop(g, m);
    l.renderOrder = 999;
    l.visible = false;
    return l;
  }
  function hideCursor() {
    if (cursorLoop) cursorLoop.visible = false;
  }
  function enableHover(on) {
    hoverEnabled = on;
    if (!on) hideCursor();
  }
  function onHover(cb) {
    hoverCb = cb;
  }
  // Position the cursor loop at (cx,cy,cz), perpendicular to (ax,ay,az), sized r.
  function setCursorTransform(cx, cy, cz, ax, ay, az, r) {
    if (!cursorLoop) return;
    tmpV.set(ax, ay, az);
    if (tmpV.lengthSq() < 1e-9) tmpV.set(0, 0, 1);
    tmpV.normalize();
    tmpQ.setFromUnitVectors(ZUP, tmpV);
    cursorLoop.quaternion.copy(tmpQ);
    cursorLoop.position.set(cx, cy, cz).addScaledVector(tmpV, (r || 1) * 0.02);
    cursorLoop.scale.setScalar(r || 1);
    cursorLoop.visible = true;
  }

  function onPick(cb) {
    pickCb = cb;
  }

  function onResize(container) {
    const w = container.clientWidth,
      h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    for (const o of splitObjs) {
      o.cur.lerp(o.target, 0.15);
      o.mesh.position.copy(o.cur);
    }
    renderer.render(scene, camera);
  }

  function colorForState(state) {
    let idx = state === 0 ? doc.defaultExtruder : state;
    const f = doc.filaments[idx - 1] || doc.filaments[0];
    return f ? f.hex : "#cccccc";
  }
  let stateColorCache = {};
  function linColor(state) {
    let c = stateColorCache[state];
    if (!c) {
      c = new THREE.Color(colorForState(state)).convertSRGBToLinear();
      stateColorCache[state] = c;
    }
    return c;
  }

  const EXPLODE_K = 0.45;

  function clearSplitObjs() {
    for (const o of splitObjs) { root.remove(o.mesh); o.mesh.geometry.dispose(); o.mesh.material.dispose(); }
    splitObjs = [];
  }

  const CAP_FILL = new THREE.Color("#9aa3b2").convertSRGBToLinear();
  function clearRemainderCaps() {
    for (const m of remainderCapObjs) { root.remove(m); m.geometry.dispose(); m.material.dispose(); }
    remainderCapObjs = [];
  }
  // A double-sided mesh that fills the hole a split part left, built from the
  // part's cap (reversed so it faces out of the remainder). Stays at the original
  // position (no explode offset), so it plugs the hole while the part floats away.
  function capMeshFor(part, solid) {
    const cap = solid.cap;
    if (!cap || !cap.tris || !cap.tris.length) return null;
    const g = Cleanup.buildSubGraph(doc.meshes[part.meshIndex]);
    const nv = cap.verts.length + cap.extraPts.length;
    const pos = new Float32Array(nv * 3);
    for (let i = 0; i < cap.verts.length; i++) {
      const gid = cap.verts[i];
      pos[i * 3] = g.vx[gid]; pos[i * 3 + 1] = g.vy[gid]; pos[i * 3 + 2] = g.vz[gid];
    }
    for (let i = 0; i < cap.extraPts.length; i++) {
      const e = cap.extraPts[i], o = (cap.verts.length + i) * 3;
      pos[o] = e[0]; pos[o + 1] = e[1]; pos[o + 2] = e[2];
    }
    const idx = new Uint32Array(cap.tris.length * 3);
    for (let t = 0; t < cap.tris.length; t++) {
      // reversed winding (remainder side); double-sided anyway for safe visibility
      idx[t * 3] = cap.tris[t][0]; idx[t * 3 + 1] = cap.tris[t][2]; idx[t * 3 + 2] = cap.tris[t][1];
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    gg.setIndex(new THREE.BufferAttribute(idx, 1));
    gg.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: CAP_FILL.clone(), roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide });
    return new THREE.Mesh(gg, mat);
  }

  // parts: [{ meshIndex, subs, state }]
  function setSplitParts(parts) {
    clearSplitObjs();
    clearRemainderCaps();
    if (!geom || !parts || !parts.length) return;
    const c = geom.boundingSphere ? geom.boundingSphere.center : new THREE.Vector3();
    const r = geom.boundingSphere ? geom.boundingSphere.radius || 50 : 50;
    for (const p of parts) {
      const s = Split.solidFromSubs(doc.meshes[p.meshIndex], Array.from(p.subs), p.method || "earcut");
      const gg = new THREE.BufferGeometry();
      gg.setAttribute("position", new THREE.BufferAttribute(s.positions, 3));
      gg.setIndex(new THREE.BufferAttribute(s.indices, 1));
      gg.computeVertexNormals();
      gg.computeBoundingSphere();
      const mat = new THREE.MeshStandardMaterial({
        color: linColor(p.state).clone(), roughness: 0.75, metalness: 0.0,
      });
      const mesh = new THREE.Mesh(gg, mat);
      const pc = gg.boundingSphere.center;
      const dir = new THREE.Vector3().subVectors(pc, c);
      if (dir.lengthSq() < 1e-9) dir.set(0, 0, 1);
      dir.normalize();
      const target = dir.multiplyScalar(r * EXPLODE_K);
      root.add(mesh);
      splitObjs.push({ mesh, target, cur: new THREE.Vector3() });
      const capMesh = capMeshFor(p, s);
      if (capMesh) { root.add(capMesh); remainderCapObjs.push(capMesh); }
    }
  }

  // (Re)build the sub-triangle geometry from each mesh's current paints.
  function build(d, claimed) {
    doc = d;
    stateColorCache = {};
    if (!claimed) claimedSets = d.meshes.map(() => new Set());
    else claimedSets = claimed;
    renderMap = d.meshes.map(() => []);
    origToRender = d.meshes.map(() => new Map());

    // count total faces and sub-triangles; cache per-face solid/tree
    let totalFaces = 0;
    meshFaceOffset = [];
    meshSubOffset = [];
    const meshTrees = []; // per mesh: { solid:Int32Array(-1|state), tree:Array }
    totalSub = 0;
    for (const m of doc.meshes) {
      meshFaceOffset.push(totalFaces);
      totalFaces += m.nf;
      const solid = new Int32Array(m.nf);
      const trees = new Array(m.nf);
      for (let i = 0; i < m.nf; i++) {
        const s = Paint.solidState(m.paints[i]);
        if (s >= 0) {
          solid[i] = s;
          trees[i] = null;
          totalSub += 1;
        } else {
          solid[i] = -1;
          const t = Paint.decode(m.paints[i]);
          trees[i] = t;
          totalSub += Paint.leafCount(t);
        }
      }
      meshTrees.push({ solid, trees });
    }

    const positions = new Float32Array(totalSub * 9);
    triState = new Int32Array(totalSub);
    faceStart = new Int32Array(totalFaces + 1);

    let off = 0; // float offset into positions
    let t = 0; // sub-tri index
    let gf = 0; // global face index
    for (let mi = 0; mi < doc.meshes.length; mi++) {
      const m = doc.meshes[mi];
      const P = m.positions;
      const { solid, trees } = meshTrees[mi];
      meshSubOffset[mi] = t;
      let origLocal = 0; // original leaf index within this mesh (claimed + unclaimed)
      const claimedSet = claimedSets[mi] || new Set();
      for (let i = 0; i < m.nf; i++) {
        faceStart[gf] = t;
        const a = m.v1[i] * 3, b = m.v2[i] * 3, c = m.v3[i] * 3;
        const ax = P[a], ay = P[a + 1], az = P[a + 2];
        const bx = P[b], by = P[b + 1], bz = P[b + 2];
        const cx = P[c], cy = P[c + 1], cz = P[c + 2];
        const emitLeaf = (state, x0,y0,z0,x1,y1,z1,x2,y2,z2) => {
          const mine = origLocal; origLocal++;
          if (claimedSet.has(mine)) return;        // hidden: this part lifted out
          positions[off] = x0; positions[off+1] = y0; positions[off+2] = z0;
          positions[off+3] = x1; positions[off+4] = y1; positions[off+5] = z1;
          positions[off+6] = x2; positions[off+7] = y2; positions[off+8] = z2;
          triState[t] = state;
          origToRender[mi].set(mine, renderMap[mi].length);
          renderMap[mi].push(mine);
          off += 9; t += 1;
        };
        if (solid[i] >= 0) {
          emitLeaf(solid[i], ax,ay,az, bx,by,bz, cx,cy,cz);
        } else {
          Paint.tessellate(trees[i], ax,ay,az, bx,by,bz, cx,cy,cz,
            (leaf, x0,y0,z0,x1,y1,z1,x2,y2,z2) =>
              emitLeaf(leaf.state, x0,y0,z0,x1,y1,z1,x2,y2,z2));
        }
        gf += 1;
      }
    }
    meshSubOffset.push(t); // sentinel (rendered count)
    faceStart[totalFaces] = t;

    if (geom) {
      root.remove(meshObj);
      geom.dispose();
    }
    const usedTris = t;
    const pos = positions.subarray(0, usedTris * 9);
    geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    colorAttr = new THREE.BufferAttribute(new Float32Array(usedTris * 9), 3);
    geom.setAttribute("color", colorAttr);
    geom.computeVertexNormals();
    geom.computeBoundingSphere();
    hideCursor();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.75,
      metalness: 0.0,
    });
    meshObj = new THREE.Mesh(geom, mat);
    root.add(meshObj);

    setHighlight(null);
  }

  // Recolor sub-triangles; faces in highlightSet (global indices) flash cyan.
  function setHighlight(highlightSet) {
    if (!colorAttr) return;
    const colors = colorAttr.array;
    const nFaces = faceStart.length - 1;
    for (let g = 0; g < nFaces; g++) {
      const hi = highlightSet && highlightSet.has(g);
      for (let st = faceStart[g]; st < faceStart[g + 1]; st++) {
        const col = hi ? HIGHLIGHT : linColor(triState[st]);
        const o = st * 9;
        colors[o] = col.r; colors[o + 1] = col.g; colors[o + 2] = col.b;
        colors[o + 3] = col.r; colors[o + 4] = col.g; colors[o + 5] = col.b;
        colors[o + 6] = col.r; colors[o + 7] = col.g; colors[o + 8] = col.b;
      }
    }
    colorAttr.needsUpdate = true;
  }

  function frame() {
    if (!geom) return;
    const bs = geom.boundingSphere;
    const c = bs.center,
      r = bs.radius || 50;
    controls.target.copy(c);
    // Z-up: view from front (-Y), slightly to the side and above.
    const dir = new THREE.Vector3(0.5, -1.0, 0.45).normalize();
    camera.position.copy(c).add(dir.multiplyScalar(r * 2.6));
    camera.near = r / 100;
    camera.far = r * 100;
    camera.updateProjectionMatrix();
    controls.update();
  }

  global.Viewer = {
    init,
    build,
    setHighlight,
    frame,
    pick,
    onPick,
    onPaint,
    setTool,
    enableHover,
    onHover,
    setCursorTransform,
    hideCursor,
    paintSubs,
    toGlobalSub,
    subTriangleCount: () => totalSub,
    setSplitParts,
  };
})(window);
