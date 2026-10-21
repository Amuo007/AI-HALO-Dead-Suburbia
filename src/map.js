import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { STREETS_X, STREETS_Z, STREET_W, MAP_SIZE } from './logic/mapgen.js';

const CITY = 'assets/city-suburban/Models/GLB%20format/';

export async function buildMap(scene, map, gltfLoader) {
  const need = [...new Set(map.props.map(p => p.model))];
  const geos = {};
  await Promise.all(need.map(async (m) => {
    try {
      const gltf = await gltfLoader.loadAsync(CITY + m + '.glb');
      const parts = [];
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse(o => {
        if (o.isMesh) {
          const g = o.geometry.clone();
          g.applyMatrix4(o.matrixWorld);
          parts.push({ g, mat: o.material });
        }
      });
      if (parts.length) {
        const bb = new THREE.Box3();
        for (const pt of parts) { pt.g.computeBoundingBox(); bb.union(pt.g.boundingBox); }
        geos[m] = parts;
        geos[m].foot = { hw: (bb.max.x - bb.min.x) / 2, hd: (bb.max.z - bb.min.z) / 2, h: bb.max.y };
      }
    } catch (e) { console.warn('missing model', m, e && e.message); }
  }));

  const instCount = {}, instMesh = {};
  for (const p of map.props) instCount[p.model] = (instCount[p.model] || 0) + 1;
  for (const m of Object.keys(geos)) {
    const parts = geos[m];
    const merged = [];
    for (const part of parts) {
      const g = part.g;
      // center geometry per-part around origin of model
      g.computeBoundingBox();
      merged.push({ g, mat: part.mat });
    }
    const first = merged[0].mat;
    const geo = merged.length > 1 ? mergeGeometries(merged.map(x => x.g), false) : merged[0].g;
    if (!geo) console.warn('[map] merge failed for', m);
    const im = new THREE.InstancedMesh(geo, first.clone(), instCount[m] || 1);
    im.castShadow = true; im.receiveShadow = true;
    im.userData.free = [];
    im.userData.key = m;
    scene.add(im);
    instMesh[m] = im;
  }

  const dummy = new THREE.Object3D();
  const used = {};
  const fenceEntries = [];
  for (const p of map.props) {
    const im = instMesh[p.model];
    if (!im) continue;
    const idx = used[p.model] || 0;
    used[p.model] = idx + 1;
    dummy.position.set(p.x, 0, p.z);
    dummy.rotation.set(0, p.rotY, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    im.setMatrixAt(idx, dummy.matrix);
    if (p.model.startsWith('fence')) fenceEntries.push({ im, idx });
  }
  for (const m of Object.keys(instMesh)) {
    instMesh[m].instanceMatrix.needsUpdate = true;
    instMesh[m].computeBoundingSphere();
  }
  // fence props were emitted in same order as map.fences
  const fenceIndex = new Map();
  map.fences.forEach((f, i) => { if (fenceEntries[i]) fenceIndex.set(f, fenceEntries[i]); });

  // ground + streets
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(MAP_SIZE + 40, MAP_SIZE + 40),
    new THREE.MeshStandardMaterial({ color: 0x1a2417, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
  scene.add(ground);
  const roadMat = new THREE.MeshStandardMaterial({ color: 0x23262e, roughness: 0.9 });
  for (const sx of STREETS_X) {
    const r = new THREE.Mesh(new THREE.PlaneGeometry(STREET_W, MAP_SIZE), roadMat);
    r.rotation.x = -Math.PI / 2; r.position.set(sx, 0.02, 0); r.receiveShadow = true; scene.add(r);
  }
  for (const sz of STREETS_Z) {
    const r = new THREE.Mesh(new THREE.PlaneGeometry(MAP_SIZE, STREET_W), roadMat);
    r.rotation.x = -Math.PI / 2; r.position.set(0, 0.02, sz); r.receiveShadow = true; scene.add(r);
  }
  // lane markings
  const markMat = new THREE.MeshBasicMaterial({ color: 0x9a9a6a });
  for (const sx of STREETS_X) for (let z = -56; z < 56; z += 6) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 2.4), markMat);
    m.rotation.x = -Math.PI / 2; m.position.set(sx, 0.03, z); scene.add(m);
  }
  for (const sz of STREETS_Z) for (let x = -56; x < 56; x += 6) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.2), markMat);
    m.rotation.x = -Math.PI / 2; m.position.set(x, 0.03, sz); scene.add(m);
  }

  // street lamps at intersections
  const lamps = [];
  for (const sx of STREETS_X) for (const sz of STREETS_Z) {
    for (const [ox, oz] of [[3.2, 3.2], [-3.2, -3.2]]) {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 5.6, 6),
        new THREE.MeshStandardMaterial({ color: 0x1d222b }));
      pole.position.y = 2.8; pole.castShadow = true; g.add(pole);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffe9b0 }));
      head.position.y = 5.6; g.add(head);
      const l = new THREE.PointLight(0xffd28a, 30, 24, 1.8);
      l.position.y = 5.5; g.add(l);
      g.position.set(sx + ox, 0, sz + oz);
      g.userData.flicker = Math.random() * 10;
      scene.add(g); lamps.push(g);
    }
  }

  // colliders: houses/trees/planters (fences handled separately, breakable)
  const colliders = map.boxes.map(b => {
    const c = { ...b };
    if (b.model && geos[b.model] && geos[b.model].foot) {
      const f = geos[b.model].foot;
      if (f.hw > 0.2) { c.hw = f.hw; c.hd = f.hd; c.h = Math.max(1, f.h); }
    }
    return c;
  });
  const fenceColliders = map.fences.map(f => {
    const rot = Math.abs(Math.sin(f.rotY)) > 0.5;
    return { x: f.x, z: f.z, hw: rot ? f.hd : f.hw, hd: rot ? f.hw : f.hd, h: f.h, kind: 'fence', fence: f };
  });

  console.log('[map] built');
  return {
    colliders, fenceColliders, lamps, fenceIndex,
    removeFence(fence) {
      const e = fenceIndex.get(fence);
      if (!e) return;
      dummy.position.set(0, -50, 0); dummy.scale.setScalar(0.001); dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      e.im.setMatrixAt(e.idx, dummy.matrix);
      e.im.instanceMatrix.needsUpdate = true;
      const ci = fenceColliders.findIndex(c => c.fence === fence);
      if (ci >= 0) fenceColliders.splice(ci, 1);
    },
  };
}
