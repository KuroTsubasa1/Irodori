/* viewer.js — three.js rendering of the painted mesh, colored per filament. */
(function (global) {
  "use strict";

  let scene, camera, renderer, controls, root;
  let doc = null;
  let geom = null,
    colorAttr = null;
  let faceIndex = []; // global face -> {mesh, local}
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

    window.addEventListener("resize", () => onResize(container));
    animate();
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
    const fil = doc.filaments;
    let idx = state;
    if (state === 0) idx = doc.defaultExtruder; // unpainted -> object extruder
    const f = fil[idx - 1] || fil[0];
    return f ? f.hex : "#cccccc";
  }

  // Cache THREE.Color (linear) per state.
  let stateColorCache = {};
  function linColor(state) {
    if (stateColorCache[state]) return stateColorCache[state];
    const c = new THREE.Color(colorForState(state)).convertSRGBToLinear();
    stateColorCache[state] = c;
    return c;
  }

  function load(d) {
    doc = d;
    stateColorCache = {};
    if (root) {
      root.clear();
      if (geom) geom.dispose();
    }
    faceIndex = [];

    // total faces & verts
    let totalFaces = 0;
    for (const m of doc.meshes) {
      Cleanup.computeDominant(m);
      totalFaces += m.nf;
    }

    const positions = new Float32Array(totalFaces * 9);
    const colors = new Float32Array(totalFaces * 9);
    let fo = 0; // running global face offset

    for (const m of doc.meshes) {
      const P = m.positions;
      for (let i = 0; i < m.nf; i++) {
        const a = m.v1[i] * 3,
          b = m.v2[i] * 3,
          c = m.v3[i] * 3;
        const o = (fo + i) * 9;
        positions[o] = P[a];
        positions[o + 1] = P[a + 1];
        positions[o + 2] = P[a + 2];
        positions[o + 3] = P[b];
        positions[o + 4] = P[b + 1];
        positions[o + 5] = P[b + 2];
        positions[o + 6] = P[c];
        positions[o + 7] = P[c + 1];
        positions[o + 8] = P[c + 2];
        faceIndex.push(m, i);
      }
      m._faceOffset = fo;
      fo += m.nf;
    }

    geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    colorAttr = new THREE.BufferAttribute(colors, 3);
    geom.setAttribute("color", colorAttr);
    geom.computeVertexNormals();
    geom.computeBoundingBox();
    geom.computeBoundingSphere();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.75,
      metalness: 0.0,
      flatShading: true,
    });
    const mesh = new THREE.Mesh(geom, mat);
    root.add(mesh);

    refreshColors();
    frame();
  }

  // Write the current per-face dominant colors into the color attribute.
  function refreshColors(highlightSet) {
    const colors = colorAttr.array;
    for (let i = 0; i < doc.meshes.length; i++) {
      const m = doc.meshes[i];
      const off = m._faceOffset;
      const dom = m.dom;
      for (let f = 0; f < m.nf; f++) {
        let col;
        if (highlightSet && highlightSet.has(off + f)) col = HIGHLIGHT;
        else col = linColor(dom[f]);
        const o = (off + f) * 9;
        for (let k = 0; k < 9; k += 3) {
          colors[o + k] = col.r;
          colors[o + k + 1] = col.g;
          colors[o + k + 2] = col.b;
        }
      }
    }
    colorAttr.needsUpdate = true;
  }

  function frame() {
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

  function setBackground(hex) {
    scene.background = new THREE.Color(hex);
  }

  global.Viewer = {
    init,
    load,
    refreshColors,
    frame,
    setBackground,
    // expose global-face -> mesh/local for the UI if needed
    faceCount: () => faceIndex.length / 2,
  };
})(window);
