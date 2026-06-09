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

  // picking
  let raycaster, mouse;
  let pickEnabled = false,
    pickCb = null,
    pointerDown = null;

  const HIGHLIGHT = new THREE.Color("#ff00e6").convertSRGBToLinear();

  function init(container) {
    scene = new THREE.Scene();
    scene.background = new THREE.Color("#23272e");
    const w = container.clientWidth,
      h = container.clientHeight;
    camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 5000);
    camera.position.set(60, 60, 120);
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(w, h);
    renderer.outputEncoding = THREE.sRGBEncoding;
    container.appendChild(renderer.domElement);
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 0.9));
    const d1 = new THREE.DirectionalLight(0xffffff, 0.7);
    d1.position.set(1, 1, 1);
    scene.add(d1);
    const d2 = new THREE.DirectionalLight(0xffffff, 0.4);
    d2.position.set(-1, 0.5, -1);
    scene.add(d2);
    root = new THREE.Group();
    scene.add(root);

    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();
    const el = renderer.domElement;
    el.addEventListener("pointerdown", (e) => {
      pointerDown = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener("pointerup", (e) => {
      const d = pointerDown;
      pointerDown = null;
      if (!pickEnabled || !pickCb || !d) return;
      const dx = e.clientX - d.x,
        dy = e.clientY - d.y;
      if (dx * dx + dy * dy > 36) return; // a drag (rotate), not a click
      const hit = pick(e.clientX, e.clientY);
      if (hit) pickCb(hit);
    });

    window.addEventListener("resize", () => onResize(container));
    animate();
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
    return {
      meshIndex: mi,
      localSub: gsub - meshSubOffset[mi],
      state: triState[gsub],
      point: hits[0].point,
    };
  }

  function setPickEnabled(b) {
    pickEnabled = b;
    if (renderer) renderer.domElement.style.cursor = b ? "crosshair" : "";
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

  // (Re)build the sub-triangle geometry from each mesh's current paints.
  function build(d) {
    doc = d;
    stateColorCache = {};

    // count total faces and sub-triangles; cache per-face solid/tree
    let totalFaces = 0;
    meshFaceOffset = [];
    meshSubOffset = [];
    const meshTrees = []; // per mesh: { solid:Int32Array(-1|state), tree:Array }
    totalSub = 0;
    for (const m of doc.meshes) {
      meshFaceOffset.push(totalFaces);
      meshSubOffset.push(totalSub);
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
    meshSubOffset.push(totalSub); // sentinel

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
      for (let i = 0; i < m.nf; i++) {
        faceStart[gf] = t;
        const a = m.v1[i] * 3,
          b = m.v2[i] * 3,
          c = m.v3[i] * 3;
        const ax = P[a], ay = P[a + 1], az = P[a + 2];
        const bx = P[b], by = P[b + 1], bz = P[b + 2];
        const cx = P[c], cy = P[c + 1], cz = P[c + 2];
        if (solid[i] >= 0) {
          positions[off] = ax; positions[off + 1] = ay; positions[off + 2] = az;
          positions[off + 3] = bx; positions[off + 4] = by; positions[off + 5] = bz;
          positions[off + 6] = cx; positions[off + 7] = cy; positions[off + 8] = cz;
          triState[t] = solid[i];
          off += 9; t += 1;
        } else {
          Paint.tessellate(
            trees[i], ax, ay, az, bx, by, bz, cx, cy, cz,
            (leaf, x0, y0, z0, x1, y1, z1, x2, y2, z2) => {
              positions[off] = x0; positions[off + 1] = y0; positions[off + 2] = z0;
              positions[off + 3] = x1; positions[off + 4] = y1; positions[off + 5] = z1;
              positions[off + 6] = x2; positions[off + 7] = y2; positions[off + 8] = z2;
              triState[t] = leaf.state;
              off += 9; t += 1;
            }
          );
        }
        gf += 1;
      }
    }
    faceStart[totalFaces] = t;

    if (geom) {
      root.remove(meshObj);
      geom.dispose();
    }
    geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    colorAttr = new THREE.BufferAttribute(new Float32Array(totalSub * 9), 3);
    geom.setAttribute("color", colorAttr);
    geom.computeVertexNormals();
    geom.computeBoundingSphere();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.75,
      metalness: 0.0,
    });
    meshObj = new THREE.Mesh(geom, mat);
    root.add(meshObj);

    setHighlight(null);
  }

  // Recolor sub-triangles; faces in highlightSet (global indices) flash pink.
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
    const dir = new THREE.Vector3(0.6, 0.5, 1).normalize();
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
    setPickEnabled,
    onPick,
    subTriangleCount: () => totalSub,
  };
})(window);
