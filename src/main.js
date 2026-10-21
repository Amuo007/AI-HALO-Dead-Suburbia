import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadZombieTemplate, Zombie, makeZombieSkin } from './zombie.js';

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
const VIEW = params.get('view') || 'street';
const ANIM = params.get('anim');
const DEBUG_AI = params.get('debug') === 'ai';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.autoClear = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070b14);
scene.fog = new THREE.Fog(0x070b14, 18, 90);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 400);
camera.position.set(0, 1.6, 6);

// view model scene (separate pass, never clips)
const viewScene = new THREE.Scene();
const viewCamera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.01, 10);
viewScene.add(viewCamera);
const vmLight = new THREE.PointLight(0xbfd4ff, 30, 6);
vmLight.position.set(0.4, 0.6, 0.4);
viewCamera.add(vmLight);
const vmAmb = new THREE.AmbientLight(0x556677, 2.2);
viewScene.add(vmAmb);

// ---------- lighting (night) ----------
const moon = new THREE.DirectionalLight(0x8fa8ff, 1.1);
moon.position.set(-30, 45, -20);
moon.castShadow = true;
moon.shadow.mapSize.set(2048, 2048);
moon.shadow.camera.left = -60; moon.shadow.camera.right = 60;
moon.shadow.camera.top = 60; moon.shadow.camera.bottom = -60;
moon.shadow.camera.far = 150;
scene.add(moon);
scene.add(new THREE.AmbientLight(0x223044, 0.9));
scene.add(new THREE.HemisphereLight(0x334466, 0x0a0a10, 0.5));
const fill = new THREE.DirectionalLight(0x6a7fa8, 0.7);
fill.position.set(6, 8, 18);
scene.add(fill);

// moon disc
const moonMesh = new THREE.Mesh(new THREE.SphereGeometry(4, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0xdde6ff }));
moonMesh.position.set(-120, 90, -160);
scene.add(moonMesh);

// street lamps
function streetLamp(x, z) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 5.4, 6),
    new THREE.MeshStandardMaterial({ color: 0x222831, roughness: 0.8 }));
  pole.position.y = 2.7; g.add(pole);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xffe9b0 }));
  head.position.y = 5.4; g.add(head);
  const l = new THREE.PointLight(0xffd28a, 26, 22, 1.8);
  l.position.y = 5.3; g.add(l);
  g.position.set(x, 0, z);
  g.userData.flicker = Math.random() * 10;
  scene.add(g);
  return g;
}
const lamps = [streetLamp(-8, 0), streetLamp(8, 0), streetLamp(-8, -24), streetLamp(8, -24)];

// ---------- ground ----------
const groundMat = new THREE.MeshStandardMaterial({ color: 0x1c2027, roughness: 0.95 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
// street strip
const street = new THREE.Mesh(new THREE.PlaneGeometry(9, 300), new THREE.MeshStandardMaterial({ color: 0x252a33, roughness: 0.9 }));
street.rotation.x = -Math.PI / 2; street.position.y = 0.01; street.receiveShadow = true;
scene.add(street);

// ---------- assets ----------
const texLoader = new THREE.TextureLoader();
const gltfLoader = new GLTFLoader();
const ASSET = 'assets/characters-survivors/';
const BLASTER = 'assets/blaster-kit/Models/GLB%20format/';

let zombieTemplate = null;
const zombies = [];

async function loadAssets() {
  zombieTemplate = await loadZombieTemplate(FBXLoader, ASSET);
  const skinA = makeZombieSkin(texLoader, ASSET + 'Skins/zombieA.png');
  const skinC = makeZombieSkin(texLoader, ASSET + 'Skins/zombieC.png');
  const gun = (await gltfLoader.loadAsync(BLASTER + 'blaster-h.glb')).scene;
  return { skinA, skinC, gun };
}

function spawnZombie(x, z, skin, opts = {}) {
  const zom = new Zombie(zombieTemplate, skin, opts);
  zom.root.position.set(x, 0, z);
  scene.add(zom.root);
  zombies.push(zom);
  return zom;
}

// ---------- view model ----------
const vm = {
  group: new THREE.Group(),
  base: new THREE.Vector3(0.28, -0.24, -0.5),
  ads: new THREE.Vector3(0, -0.115, -0.34),
  pos: new THREE.Vector3(0.28, -0.24, -0.5),
  rot: new THREE.Euler(),
  kick: 0, kickRot: 0,
  bobT: 0, bob: 0,
  swayX: 0, swayY: 0,
  adsAmt: 0,
  lowered: 0,
};

function setupViewModel(gun) {
  gun.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
  const box = new THREE.Box3().setFromObject(gun);
  const size = new THREE.Vector3(); box.getSize(size);
  const s = 0.26 / Math.max(size.x, size.y, size.z);
  gun.scale.setScalar(s);
  const c = new THREE.Vector3(); box.getCenter(c);
  const holder = new THREE.Group();
  gun.position.sub(c);
  holder.add(gun);
  vm.group.add(holder);
  vm.holder = holder;
  viewCamera.add(vm.group);
  vm.group.position.copy(vm.base);
}

// ---------- effects (muzzle flash, tracer) ----------
function makeFlashTexture() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 2, 64, 64, 60);
  gr.addColorStop(0, 'rgba(255,255,220,1)');
  gr.addColorStop(0.25, 'rgba(255,200,90,0.9)');
  gr.addColorStop(1, 'rgba(255,120,20,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(cv);
  return t;
}
const flashTex = makeFlashTexture();
const muzzle = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false }));
muzzle.scale.setScalar(0.5); muzzle.visible = false;
scene.add(muzzle);
const muzzleLight = new THREE.PointLight(0xffc873, 0, 14, 2);
scene.add(muzzleLight);
let flashFrames = 0;

function fireEffects(from, to) {
  muzzle.position.copy(to).addScaledVector(new THREE.Vector3().subVectors(to, from).normalize(), -0.1);
  muzzle.position.y += 0.05;
  muzzle.material.rotation = Math.random() * Math.PI * 2;
  muzzle.visible = true; flashFrames = 2;
  muzzleLight.position.copy(muzzle.position); muzzleLight.intensity = 60;
  // tracer
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = dir.length();
  const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.004, len, 5),
    new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  tr.position.copy(from).addScaledVector(dir, 0.5);
  tr.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  tr.userData.life = 0.07;
  scene.add(tr); tracers.push(tr);
}
const tracers = [];

// ---------- input ----------
const keys = {};
let mouseDX = 0, mouseDY = 0, firing = false, aiming = false, yaw = 0, pitch = 0;
addEventListener('keydown', e => { keys[e.code] = true; });
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('mousemove', e => {
  if (document.pointerLockElement) {
    mouseDX += e.movementX; mouseDY += e.movementY;
  }
});
addEventListener('mousedown', e => { if (e.button === 0) firing = true; if (e.button === 2) aiming = true; });
addEventListener('mouseup', e => { if (e.button === 0) firing = false; if (e.button === 2) aiming = false; });
addEventListener('contextmenu', e => e.preventDefault());

// ---------- demo setup ----------
let demoMode = DEMO;
if (DEMO) document.getElementById('startScreen').classList.remove('on');
async function init() {
  const { skinA, skinC, gun } = await loadAssets();
  setupViewModel(gun.clone ? gun : gun);

  if (VIEW === 'map') {
    camera.position.set(0, 55, 0.01); camera.lookAt(0, 0, 0);
  } else if (VIEW === 'weapon') {
    camera.position.set(0.1, 1.15, -0.05); camera.lookAt(0.28, 0.9, -0.5);
  } else {
    camera.position.set(0, 1.5, VIEW === 'zombies' ? 1.6 : 6);
    yaw = 0; pitch = VIEW === 'zombies' ? -0.12 : -0.05; // camera faces -Z toward the zombie group
  }

  // zombie group
  const group = [];
  if (ANIM) {
    for (let i = 0; i < 5; i++) {
      const z = spawnZombie((i - 2) * 1.3, -3, i % 2 ? skinA : skinC);
      z.root.rotation.y = Math.PI; // face player
      group.push(z);
      const a = z.a; a.freeze = true; a.time = 3.3;
      if (ANIM === 'walk') { a.freeze = false; z.setMove(1); }
      if (ANIM === 'attack') { a.attackT = 0.42 * a.attackDur; }
      if (ANIM === 'hit') { a.flinchT = 0.1; a.flinchDur = 0.4; a.flinchKind = i % 3 === 0 ? 'head' : (i % 3 === 1 ? 'body' : 'leg'); }
      if (ANIM === 'crawl') { a.crawl = true; a.move = 0.8; }
      if (ANIM === 'death') { a.death = { t: 0.55, x: 0.9, v: 0.4, fallYaw: Math.PI }; }
    }
  } else {
    for (let i = 0; i < 4; i++) {
      const z = spawnZombie((i - 1.5) * 1.4, VIEW === 'zombies' ? -2.6 : -4 - (i % 2), i % 2 ? skinA : skinC);
      z.root.rotation.y = Math.PI;
      z.setMove(1);
      group.push(z);
    }
  }
  if (VIEW === 'fire') {
    setTimeout(() => {
      const from = camera.position.clone();
      const to = zombies[0].root.position.clone().setY(1.2);
      fireEffects(from, to);
      zombies[0].flinch('body', 0.5);
    }, 100);
  }
  const bb = new THREE.Box3();
  for (const z of zombies) { z.root.updateMatrixWorld(true); bb.expandByObject(z.root); }
  console.log('[DBG] zombie world bounds', JSON.stringify({ min: bb.min.toArray().map(v => +v.toFixed(2)), max: bb.max.toArray().map(v => +v.toFixed(2)) }));
    window.__gameReady = true;
}
init();

// ---------- loop ----------
const clock = new THREE.Clock();
let lastShot = 0;
function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  // mouse look (demo: static)
  if (demoMode && document.pointerLockElement) demoMode = false;
  if (!demoMode) {
    yaw -= mouseDX * 0.0022; pitch -= mouseDY * 0.0022;
    pitch = Math.max(-1.5, Math.min(1.5, pitch));
    vm.swayX += (-mouseDX * 0.0015 - vm.swayX) * Math.min(1, dt * 8);
    vm.swayY += (-mouseDY * 0.0015 - vm.swayY) * Math.min(1, dt * 8);
  }
  mouseDX = mouseDY = 0;
  camera.rotation.set(pitch, yaw, 0, 'YXZ');

  // ADS
  const adsTarget = aiming ? 1 : 0;
  vm.adsAmt += (adsTarget - vm.adsAmt) * Math.min(1, dt * 10);
  camera.fov = 75 - 20 * vm.adsAmt; camera.updateProjectionMatrix();

  // weapon bob / sway / kick
  vm.bobT += dt * (keys.KeyW || keys.KeyS ? 8 : 3);
  vm.bob = Math.sin(vm.bobT) * (keys.KeyW || keys.KeyS ? 0.012 : 0.004);
  vm.kick = Math.max(0, vm.kick - dt * 6);
  vm.kickRot = Math.max(0, vm.kickRot - dt * 6);
  const bp = vm.base.clone().lerp(vm.ads, vm.adsAmt);
  vm.pos.copy(bp);
  vm.pos.x += vm.bob * 0.6 * (1 - vm.adsAmt) + vm.swayX * (1 - vm.adsAmt);
  vm.pos.y += Math.abs(Math.sin(vm.bobT)) * 0.008 * (1 - vm.adsAmt) + vm.swayY * (1 - vm.adsAmt) - vm.kick * 0.06;
  vm.pos.z += vm.kick * 0.09;
  vm.group.position.copy(vm.pos);
  vm.holder.rotation.set(vm.kickRot * 0.5 + vm.swayY * 0.5 * (1 - vm.adsAmt), vm.swayX * 0.8 * (1 - vm.adsAmt), 0);

  // firing (demo view=fire handled once; live fire on click)
  if (firing && t - lastShot > 0.12 && !demoMode) {
    lastShot = t; vm.kick = 1; vm.kickRot = 1; pitch += 0.012;
    const from = camera.position.clone();
    const to = camera.position.clone().add(new THREE.Vector3(0, 0, -20).applyEuler(camera.rotation));
    fireEffects(from, to);
  }

  // flash frames
  if (flashFrames > 0) { flashFrames--; if (flashFrames === 0) { muzzle.visible = false; muzzleLight.intensity = 0; } }
  for (let i = tracers.length - 1; i >= 0; i--) {
    tracers[i].userData.life -= dt;
    tracers[i].material.opacity = Math.max(0, tracers[i].userData.life / 0.07);
    if (tracers[i].userData.life <= 0) { scene.remove(tracers[i]); tracers.splice(i, 1); }
  }

  // lamp flicker
  for (const l of lamps) {
    const f = Math.sin(t * 13 + l.userData.flicker) > -0.92 ? 1 : 0.3;
    l.children[2].intensity = 26 * f;
  }

  // zombies
  for (const z of zombies) z.update(dt);

  renderer.clear();
  renderer.render(scene, camera);
  renderer.clearDepth();
  renderer.render(viewScene, viewCamera);
}
loop();

addEventListener('resize', () => {
  camera.aspect = viewCamera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix(); viewCamera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
