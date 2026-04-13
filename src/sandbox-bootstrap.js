/**
 * sandbox-bootstrap.js
 *
 * This file is read at runtime and embedded verbatim inside every game iframe.
 * It sets up:
 *   • Three.js globals (THREE, GLTFLoader, PointerLockControls, OrbitControls)
 *   • loadModel(keyword) — searches open 3D model libraries + procedural fallback
 *   • A friendly runtime error overlay
 *
 * It is intentionally written as a plain IIFE (no ES modules) so it works as
 * an inline <script> inside a srcdoc iframe alongside the generated game code.
 */

(function () {
  'use strict';

  // ── Curated model database ─────────────────────────────────────────────────
  // Models from Three.js examples (threejs.org CDN) and KhronosGroup samples
  // (raw.githubusercontent.com). Both hosts send CORS headers.
  const MODEL_DB = [
    // ── Characters / humanoids ────────────────────────────────────────────
    { tags: ['robot', 'mech', 'android', 'machine'],
      url: 'https://threejs.org/examples/models/gltf/RobotExpressive/RobotExpressive.glb', scale: 1 },
    { tags: ['soldier', 'guard', 'military', 'army', 'fighter'],
      url: 'https://threejs.org/examples/models/gltf/soldier.glb', scale: 1 },
    { tags: ['human', 'person', 'woman', 'girl', 'character', 'npc', 'michelle'],
      url: 'https://threejs.org/examples/models/gltf/Michelle.glb', scale: 1 },
    { tags: ['man', 'cesium', 'explorer', 'male'],
      url: 'https://threejs.org/examples/models/gltf/CesiumMan/glTF/CesiumMan.gltf', scale: 1 },

    // ── Animals ───────────────────────────────────────────────────────────
    { tags: ['fox', 'animal'],
      url: 'https://threejs.org/examples/models/gltf/Fox/Fox.glb', scale: 0.02 },
    { tags: ['horse', 'pony', 'steed', 'mount'],
      url: 'https://threejs.org/examples/models/gltf/Horse.glb', scale: 0.01 },
    { tags: ['flamingo', 'bird', 'pink bird'],
      url: 'https://threejs.org/examples/models/gltf/Flamingo.glb', scale: 0.01 },
    { tags: ['parrot', 'bird', 'colorful bird'],
      url: 'https://threejs.org/examples/models/gltf/Parrot.glb', scale: 0.01 },
    { tags: ['stork', 'bird', 'white bird'],
      url: 'https://threejs.org/examples/models/gltf/Stork.glb', scale: 0.01 },
    { tags: ['duck', 'rubber duck', 'toy'],
      url: 'https://threejs.org/examples/models/gltf/Duck/glTF/Duck.gltf', scale: 0.5 },

    // ── Vehicles ──────────────────────────────────────────────────────────
    { tags: ['truck', 'milk truck', 'van', 'vehicle', 'car', 'automobile'],
      url: 'https://threejs.org/examples/models/gltf/CesiumMilkTruck/glTF/CesiumMilkTruck.gltf', scale: 1 },

    // ── Props / objects ───────────────────────────────────────────────────
    { tags: ['helmet', 'armor', 'damaged helmet', 'sci-fi helmet', 'space helmet'],
      url: 'https://threejs.org/examples/models/gltf/DamagedHelmet/glTF/DamagedHelmet.gltf', scale: 1 },
    { tags: ['boombox', 'radio', 'stereo', 'gadget', 'electronics'],
      url: 'https://threejs.org/examples/models/gltf/BoomBox/glTF/BoomBox.gltf', scale: 40 },
    { tags: ['avocado', 'food', 'fruit'],
      url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/Avocado/glTF/Avocado.gltf', scale: 10 },

    // ── Scenes ────────────────────────────────────────────────────────────
    { tags: ['tokyo', 'city', 'japanese', 'japan', 'urban', 'town'],
      url: 'https://threejs.org/examples/models/gltf/LittlestTokyo.glb', scale: 0.01 },
  ];

  // ── Poly Pizza search ─────────────────────────────────────────────────────
  // Poly Pizza (poly.pizza) hosts thousands of CC0 / CC-BY low-poly 3D models
  // and provides a public search API with CORS headers.
  async function searchPolyPizza(keyword) {
    try {
      const url = `https://api.poly.pizza/v1/models/search?q=${encodeURIComponent(keyword)}&limit=6&format=glb`;
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return null;
      const data = await res.json();
      const results = data.results || data.models || [];
      if (!results.length) return null;

      // Pick the first result with a direct download URL
      for (const m of results) {
        const downloadUrl = m.Download || m.download || m.url || m.fileUrl;
        if (downloadUrl) return { url: downloadUrl, scale: 1 };
      }
      return null;
    } catch {
      return null;
    }
  }

  // ── Keyword matching ──────────────────────────────────────────────────────
  function findInDB(keyword) {
    const kw = keyword.toLowerCase();
    const words = kw.split(/\s+/);

    let bestMatch = null;
    let bestScore = 0;

    for (const entry of MODEL_DB) {
      for (const tag of entry.tags) {
        let score = 0;
        if (tag === kw) { score = 3; }
        else if (kw.includes(tag) || tag.includes(kw)) { score = 2; }
        else {
          for (const w of words) {
            if (tag.includes(w) && w.length > 2) score = 1;
          }
        }
        if (score > bestScore) { bestScore = score; bestMatch = entry; }
      }
    }

    return bestScore > 0 ? bestMatch : null;
  }

  // ── GLTF loading ──────────────────────────────────────────────────────────
  function loadGLTF(url, scale) {
    return new Promise((resolve) => {
      const loader = new GLTFLoader();
      loader.load(
        url,
        (gltf) => {
          const obj = gltf.scene;
          obj.scale.setScalar(scale);
          // Enable shadows on every mesh
          obj.traverse((child) => {
            if (child.isMesh) {
              child.castShadow = true;
              child.receiveShadow = true;
            }
          });
          resolve(obj);
        },
        undefined,
        (err) => {
          console.warn('[loadModel] GLTF load failed:', url, err);
          resolve(null);
        }
      );
    });
  }

  // ── Procedural geometry fallback ──────────────────────────────────────────
  // Returns a THREE.Group shaped vaguely like the keyword, using only basic
  // Three.js geometries. Part of the charm — wild art styles are expected!
  function proceduralModel(keyword) {
    const kw = keyword.toLowerCase();
    const g = new THREE.Group();

    const mat = (color) => new THREE.MeshLambertMaterial({ color });

    // helper: add a mesh to group
    const add = (geom, color, px = 0, py = 0, pz = 0, sx = 1, sy = 1, sz = 1) => {
      const m = new THREE.Mesh(geom, mat(color));
      m.position.set(px, py, pz);
      m.scale.set(sx, sy, sz);
      m.castShadow = true;
      g.add(m);
      return m;
    };

    if (/tree|pine|oak|palm|birch|forest|jungle/.test(kw)) {
      add(new THREE.CylinderGeometry(0.18, 0.28, 1.4, 7), 0x5c3317, 0, 0.7, 0);
      add(new THREE.ConeGeometry(1.3, 2.2, 8), 0x2d7a2d, 0, 2.6, 0);
      if (/pine/.test(kw)) {
        add(new THREE.ConeGeometry(1.0, 1.6, 8), 0x267326, 0, 3.5, 0);
        add(new THREE.ConeGeometry(0.65, 1.2, 8), 0x1f5c1f, 0, 4.3, 0);
      }

    } else if (/rock|stone|boulder|pebble/.test(kw)) {
      const geo = new THREE.IcosahedronGeometry(1, 0);
      const mesh = add(geo, 0x888888, 0, 0.6, 0);
      mesh.scale.set(1, 0.65, 0.85);
      mesh.rotation.y = Math.random() * Math.PI;

    } else if (/crystal|gem|diamond|shard/.test(kw)) {
      add(new THREE.OctahedronGeometry(0.6, 0), 0x44ddff, 0, 0.6, 0);

    } else if (/mushroom|shroom/.test(kw)) {
      add(new THREE.CylinderGeometry(0.12, 0.18, 0.8, 7), 0xeeddcc, 0, 0.4, 0);
      add(new THREE.SphereGeometry(0.55, 8, 6), 0xcc3300, 0, 1.05, 0);

    } else if (/house|home|cabin|cottage|building/.test(kw)) {
      add(new THREE.BoxGeometry(4, 2.5, 4), 0xcc9966, 0, 1.25, 0);
      const roof = add(new THREE.ConeGeometry(3.2, 2, 4), 0x8b1a1a, 0, 3.3, 0);
      roof.rotation.y = Math.PI / 4;
      add(new THREE.BoxGeometry(0.9, 1.5, 0.15), 0x5c3317, 0, 0.75, 2.08);

    } else if (/castle|fortress|keep/.test(kw)) {
      add(new THREE.BoxGeometry(6, 5, 6), 0x888888, 0, 2.5, 0);
      [[-3, -3], [3, -3], [-3, 3], [3, 3]].forEach(([x, z]) => {
        add(new THREE.CylinderGeometry(0.9, 0.9, 7, 8), 0x999999, x, 3.5, z);
      });

    } else if (/tower|spire/.test(kw)) {
      add(new THREE.CylinderGeometry(1, 1.2, 6, 10), 0x888888, 0, 3, 0);
      add(new THREE.ConeGeometry(1.3, 2, 10), 0x6b1a1a, 0, 7, 0);

    } else if (/barrel|cask/.test(kw)) {
      add(new THREE.CylinderGeometry(0.5, 0.5, 1, 10), 0x7a4a1a, 0, 0.5, 0);
      [0.1, 0.5, 0.9].forEach(y =>
        add(new THREE.TorusGeometry(0.52, 0.04, 6, 16), 0x4a3a1a, 0, y, 0)
      );

    } else if (/crate|box|container/.test(kw)) {
      add(new THREE.BoxGeometry(1, 1, 1), 0xbb8833, 0, 0.5, 0);

    } else if (/chest|treasure/.test(kw)) {
      add(new THREE.BoxGeometry(1.2, 0.7, 0.8), 0x7a4a1a, 0, 0.35, 0);
      add(new THREE.BoxGeometry(1.2, 0.3, 0.8), 0x7a4a1a, 0, 0.85, 0);
      add(new THREE.BoxGeometry(1.25, 0.08, 0.85), 0xaa8800, 0, 0.7, 0);

    } else if (/torch|candle|fire/.test(kw)) {
      add(new THREE.CylinderGeometry(0.08, 0.1, 0.8, 8), 0x5c3317, 0, 0.4, 0);
      add(new THREE.SphereGeometry(0.15, 6, 6), 0xff8800, 0, 0.95, 0);

    } else if (/sword|blade|weapon/.test(kw)) {
      add(new THREE.BoxGeometry(0.12, 1.4, 0.04), 0xcccccc, 0, 0.7, 0);
      add(new THREE.BoxGeometry(0.5, 0.08, 0.08), 0xaa8800, 0, 0.1, 0);
      add(new THREE.CylinderGeometry(0.07, 0.07, 0.45, 8), 0x5c3317, 0, -0.22, 0);

    } else if (/portal|gate|arch|vortex/.test(kw)) {
      add(new THREE.TorusGeometry(1.4, 0.2, 12, 32), 0xaa00ff, 0, 1.4, 0);

    } else if (/orb|sphere|ball|globe/.test(kw)) {
      add(new THREE.SphereGeometry(0.8, 12, 10), 0x44aaff, 0, 0.8, 0);

    } else if (/pillar|column/.test(kw)) {
      add(new THREE.CylinderGeometry(0.4, 0.45, 4, 10), 0xccbbaa, 0, 2, 0);

    } else if (/asteroid|meteor|comet/.test(kw)) {
      const geo = new THREE.IcosahedronGeometry(1.2, 1);
      const arr = geo.attributes.position.array;
      for (let i = 0; i < arr.length; i++) arr[i] += (Math.random() - 0.5) * 0.35;
      geo.computeVertexNormals();
      add(geo, 0x555555, 0, 1, 0);

    } else if (/car|vehicle|automobile/.test(kw)) {
      add(new THREE.BoxGeometry(3.5, 0.9, 1.7), 0xcc2222, 0, 0.7, 0);
      add(new THREE.BoxGeometry(2.2, 0.8, 1.6), 0xcc2222, -0.3, 1.5, 0);
      [[-1.1, -0.7], [1.1, -0.7], [-1.1, 0.7], [1.1, 0.7]].forEach(([x, z]) => {
        add(new THREE.CylinderGeometry(0.45, 0.45, 0.3, 12), 0x222222, x, 0.35, z)
          .rotation.z = Math.PI / 2;
      });

    } else if (/spaceship|rocket|ufo|starship/.test(kw)) {
      add(new THREE.ConeGeometry(0.6, 2.5, 8), 0xaaaaaa, 0, 1.25, 0);
      add(new THREE.CylinderGeometry(0.6, 0.6, 1, 8), 0x888888, 0, 0, 0);
      add(new THREE.TorusGeometry(1.1, 0.18, 8, 20), 0x4488ff, 0, 0.15, 0);

    } else if (/dragon|wyvern|wyrm/.test(kw)) {
      add(new THREE.SphereGeometry(0.8, 8, 6), 0x226622, 0, 1, 0);       // body
      add(new THREE.SphereGeometry(0.45, 8, 6), 0x226622, 1.1, 1.5, 0);  // head
      add(new THREE.ConeGeometry(0.25, 1.2, 6), 0x336633, -1.3, 0.7, 0)  // tail
        .rotation.z = -0.5;

    } else if (/zombie|undead|skeleton|ghost/.test(kw)) {
      add(new THREE.BoxGeometry(0.5, 0.6, 0.3), 0x88aa88, 0, 1.3, 0);
      add(new THREE.SphereGeometry(0.3, 8, 6), 0x88aa88, 0, 1.9, 0);
      add(new THREE.BoxGeometry(0.15, 0.65, 0.15), 0x88aa88, -0.38, 1.1, 0);
      add(new THREE.BoxGeometry(0.15, 0.65, 0.15), 0x88aa88, 0.38, 1.1, 0);
      add(new THREE.BoxGeometry(0.22, 0.7, 0.22), 0x88aa88, -0.18, 0.35, 0);
      add(new THREE.BoxGeometry(0.22, 0.7, 0.22), 0x88aa88, 0.18, 0.35, 0);

    } else if (/knight|warrior|soldier|fighter|hero/.test(kw)) {
      add(new THREE.BoxGeometry(0.55, 0.65, 0.32), 0x999999, 0, 1.32, 0);
      add(new THREE.SphereGeometry(0.28, 8, 6), 0x888888, 0, 1.9, 0);
      add(new THREE.BoxGeometry(0.18, 0.7, 0.18), 0x999999, -0.42, 1.05, 0);
      add(new THREE.BoxGeometry(0.18, 0.7, 0.18), 0x999999, 0.42, 1.05, 0);
      add(new THREE.BoxGeometry(0.25, 0.8, 0.25), 0x999999, -0.2, 0.4, 0);
      add(new THREE.BoxGeometry(0.25, 0.8, 0.25), 0x999999, 0.2, 0.4, 0);

    } else if (/wolf|dog|cat|creature|beast/.test(kw)) {
      add(new THREE.BoxGeometry(0.8, 0.5, 0.4), 0x888888, 0, 0.6, 0);
      add(new THREE.SphereGeometry(0.28, 8, 6), 0x888888, 0.62, 0.75, 0);
      add(new THREE.CylinderGeometry(0.08, 0.1, 0.55, 6), 0x888888, -0.15, 0.2, 0.15);
      add(new THREE.CylinderGeometry(0.08, 0.1, 0.55, 6), 0x888888, 0.15, 0.2, 0.15);
      add(new THREE.CylinderGeometry(0.08, 0.1, 0.55, 6), 0x888888, -0.15, 0.2, -0.15);
      add(new THREE.CylinderGeometry(0.08, 0.1, 0.55, 6), 0x888888, 0.15, 0.2, -0.15);

    } else {
      // Generic fallback: a coloured sphere on a small stub
      const hue = Math.floor(Math.random() * 360);
      const color = new THREE.Color(`hsl(${hue},70%,45%)`);
      add(new THREE.SphereGeometry(0.7, 10, 8), color, 0, 0.7, 0);
    }

    return g;
  }

  // ── Public loadModel ──────────────────────────────────────────────────────
  /**
   * loadModel(keyword) → Promise<THREE.Object3D>
   *
   * Search order:
   *   1. Curated DB (Three.js examples, KhronosGroup)
   *   2. Poly Pizza public API (CC0 / CC-BY low-poly models)
   *   3. Procedural geometry fallback (always succeeds)
   */
  window.loadModel = async function loadModel(keyword) {
    const kw = String(keyword || 'object').trim();

    // 1. Curated DB
    const entry = findInDB(kw);
    if (entry) {
      const obj = await loadGLTF(entry.url, entry.scale);
      if (obj) return obj;
    }

    // 2. Poly Pizza
    const ppResult = await searchPolyPizza(kw);
    if (ppResult) {
      const obj = await loadGLTF(ppResult.url, ppResult.scale);
      if (obj) return obj;
    }

    // 3. Procedural fallback
    console.info(`[loadModel] Using procedural geometry for "${kw}"`);
    return proceduralModel(kw);
  };

  // ── Runtime error overlay ─────────────────────────────────────────────────
  window.addEventListener('error', (e) => {
    const div = document.getElementById('__error_overlay__') || (() => {
      const d = document.createElement('div');
      d.id = '__error_overlay__';
      d.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:99999',
        'background:rgba(10,0,0,.88)', 'color:#ff8888',
        'font:14px/1.6 monospace', 'padding:32px',
        'overflow:auto', 'white-space:pre-wrap',
      ].join(';');
      document.body.appendChild(d);
      return d;
    })();
    div.textContent += `\n⚠ ${e.message}\n  at ${e.filename}:${e.lineno}:${e.colno}`;
  });

  window.addEventListener('unhandledrejection', (e) => {
    console.error('[unhandledrejection]', e.reason);
  });
})();
