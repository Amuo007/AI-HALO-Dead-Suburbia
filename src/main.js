import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TextureLoader } from 'three';
import { loadZombieTemplate, Zombie, makeZombieSkin } from './zombie.js';
import { generateMap } from './logic/mapgen.js';
import { buildNavGrid, flowField, flowDir, nearestFree } from './logic/nav.js';
import { collideCircle } from './logic/collision.js';
import { buildMap } from './map.js';

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
scene.fog = new THREE.Fog(0x070b14, 20, 95);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 400);

const viewScene = new THREE.Scene();
const viewCamera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.01, 10);
viewScene.add(viewCamera);
const vmLight = new THREE.PointLight(0xbfd4ff, 30, 6);
vmLight.position.set(0.4, 0.6, 0.4);
viewCamera.add(vmLight);
viewScene.add(new THREE.AmbientLight(0x667788, 2.5));

// ---------- night lighting ----------
const moon = new THREE.DirectionalLight(0x8fa8ff, 1.0);
moon.position.set(-30, 45, -20);
moon.castShadow = true;
moon.shadow.mapSize.set(2048, 2048);
const SH = 55;
moon.shadow.camera.left = -SH; moon.shadow.camera.right = SH;
moon.shadow.camera.top = SH; moon.shadow.camera.bottom = -SH;
moon.shadow.camera.far = 160;
scene.add(moon);
scene.add(new THREE.AmbientLight(0x223044, 1.0));
scene.add(new THREE.HemisphereLight(0x334466, 0x0a0a10, 0.5));
const fill = new THREE.DirectionalLight(0x6a7fa8, 0.6);
fill.position.set(6, 8, 18);
scene.add(fill);
const moonMesh = new THREE.Mesh(new THREE.SphereGeometry(4, 16, 16), new THREE.MeshBasicMaterial({ color: 0xdde6ff }));
moonMesh.position.set(-120, 90, -160);
scene.add(moonMesh);

// ---------- assets ----------
const texLoader = new TextureLoader();
const gltfLoader = new GLTFLoader();
const ASSET = 'assets/characters-survivors/';
const BLASTER = 'assets/blaster-kit/Models/GLB%20format/';

const map = generateMap(1337);
const navGrid = buildNavGrid(map);
let mapWorld = null;
const zombies = [];
let zombieTemplate = null, skinA = null, skinC = null;

async function loadAssets() {
  zombieTemplate = await loadZombieTemplate(FBXLoader, ASSET);
  skinA = makeZombieSkin(texLoader, ASSET + 'Skins/zombieA.png');
  skinC = makeZombieSkin(texLoader, ASSET + 'Skins/zombieC.png');
  mapWorld = await buildMap(scene, map, gltfLoader);
  const gun = (await gltfLoader.loadAsync(BLASTER + 'blaster-h.glb')).scene;
  return { gun };
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
  pos: new THREE.Vector3(), kick: 0, kickRot: 0,
  bobT: 0, bob: 0, swayX: 0, swayY: 0, adsAmt: 0,
};
function setupViewModel(gun) {
  gun.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
  const box = new THREE.Box3().setFromObject(gun);
  const size = new THREE.Vector3(); box.getSize(size);
  gun.scale.setScalar(0.26 / Math.max(size.x, size.y, size.z));
  const c = new THREE.Vector3(); box.getCenter(c);
  gun.position.sub(c);
  const holder = new THREE.Group(); holder.add(gun);
  vm.group.add(holder); vm.holder = holder;
  viewCamera.add(vm.group);
  vm.pos.copy(vm.base); vm.group.position.copy(vm.base);
}

// ---------- effects ----------
function makeFlashTexture() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 2, 64, 64, 60);
  gr.addColorStop(0, 'rgba(255,255,220,1)'); gr.addColorStop(0.25, 'rgba(255,200,90,0.9)'); gr.addColorStop(1, 'rgba(255,120,20,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
}
const muzzle = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeFlashTexture(), blending: THREE.AdditiveBlending, depthWrite: false }));
muzzle.scale.setScalar(0.5); muzzle.visible = false; scene.add(muzzle);
const muzzleLight = new THREE.PointLight(0xffc873, 0, 14, 2); scene.add(muzzleLight);
let flashFrames = 0;
const tracers = [];
function fireEffects(from, to) {
  const dir = new THREE.Vector3().subVectors(to, from).normalize();
  muzzle.position.copy(to).addScaledVector(dir, -0.1); muzzle.position.y += 0.05;
  muzzle.material.rotation = Math.random() * Math.PI * 2;
  muzzle.visible = true; flashFrames = 2;
  muzzleLight.position.copy(muzzle.position); muzzleLight.intensity = 60;
  const d2 = new THREE.Vector3().subVectors(to, from); const len = d2.length();
  const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.004, len, 5),
    new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  tr.position.copy(from).addScaledVector(d2, 0.5);
  tr.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d2.normalize());
  tr.userData.life = 0.07; scene.add(tr); tracers.push(tr);
}

// ---------- player ----------
const player = {
  pos: new THREE.Vector3(0, 0, 8), vel: new THREE.Vector3(),
  yaw: 0, pitch: 0, eye: 1.6, crouch: 0, onGround: true,
  health: 100, stamina: 100, sprinting: false, radius: 0.35,
};
const keys = {};
let mouseDX = 0, mouseDY = 0, firing = false, aiming = false;
addEventListener('keydown', e => { keys[e.code] = true; });
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('mousemove', e => { if (document.pointerLockElement) { mouseDX += e.movementX; mouseDY += e.movementY; } });
addEventListener('mousedown', e => { if (e.button === 0) firing = true; if (e.button === 2) aiming = true; });
addEventListener('mouseup', e => { if (e.button === 0) firing = false; if (e.button === 2) aiming = false; });
addEventListener('contextmenu', e => e.preventDefault());

function collidersNow() {
  return mapWorld ? [...mapWorld.colliders, ...mapWorld.fenceColliders] : [];
}

function updatePlayer(dt) {
  const sens = 0.0022;
  player.yaw -= mouseDX * sens; player.pitch -= mouseDY * sens;
  player.pitch = Math.max(-1.5, Math.min(1.5, player.pitch));
  vm.swayX += (-mouseDX * 0.0015 - vm.swayX) * Math.min(1, dt * 8);
  vm.swayY += (-mouseDY * 0.0015 - vm.swayY) * Math.min(1, dt * 8);
  mouseDX = mouseDY = 0;

  const crouchT = keys.KeyC ? 1 : 0;
  player.crouch += (crouchT - player.crouch) * Math.min(1, dt * 10);
  const wantSprint = keys.ShiftLeft && (keys.KeyW || keys.KeyS || keys.KeyA || keys.KeyD) && player.stamina > 1 && !player.crouch;
  player.sprinting = wantSprint;
  player.stamina = Math.max(0, Math.min(100, player.stamina + (wantSprint ? -22 : 14) * dt));

  let speed = (player.sprinting ? 6.2 : 3.6) * (1 - player.crouch * 0.55);
  const f = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  const r = new THREE.Vector3(-f.z, 0, f.x);
  const wish = new THREE.Vector3();
  if (keys.KeyW) wish.add(f); if (keys.KeyS) wish.sub(f);
  if (keys.KeyD) wish.add(r); if (keys.KeyA) wish.sub(r);
  if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
  player.vel.x = wish.x; player.vel.z = wish.z;

  if (keys.Space && player.onGround) { player.vel.y = 5.2; player.onGround = false; }
  player.vel.y -= 14 * dt;

  let nx = player.pos.x + player.vel.x * dt;
  let nz = player.pos.z + player.vel.z * dt;
  const res = collideCircle(nx, nz, player.radius, collidersNow());
  nx = Math.max(-58, Math.min(58, res.x)); nz = Math.max(-58, Math.min(58, res.z));
  player.pos.x = nx; player.pos.z = nz;
  player.pos.y += player.vel.y * dt;
  if (player.pos.y <= 0) { player.pos.y = 0; player.vel.y = 0; player.onGround = true; }

  player.eye = 1.6 - player.crouch * 0.6;
  camera.position.set(player.pos.x, player.pos.y + player.eye, player.pos.z);
  camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
  return wish.lengthSq() > 0;
}

// ---------- demo ----------
let demoMode = DEMO;
if (DEMO) document.getElementById('startScreen').classList.remove('on');

async function init() {
  const { gun } = await loadAssets();
  setupViewModel(gun);

  if (VIEW === 'map') {
    scene.fog = null;
    moon.intensity = 3.5; fill.intensity = 2.5;
    scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    vm.group.visible = false;
    camera.position.set(0, 70, 0.01); camera.rotation.set(-Math.PI / 2, 0, 0);
  } else {
    const [sx, sz] = nearestFree(navGrid, 0, 8);
    player.pos.set(sx, 0, sz);
    if (VIEW === 'zombies') player.pos.set(0, 0, 0.5);
    player.yaw = 0; player.pitch = -0.05;
  }

  const group = [];
  const zbase = VIEW === 'zombies' ? -2.6 : -4;
  if (ANIM) {
    for (let i = 0; i < 5; i++) {
      const z = spawnZombie((i - 2) * 1.3, zbase, i % 2 ? skinA : skinC);
      z.root.rotation.y = Math.PI; group.push(z);
      const a = z.a; a.freeze = true; a.time = 3.3;
      if (ANIM === 'walk') { a.freeze = false; z.setMove(1); }
      if (ANIM === 'attack') { a.attackT = 0.42 * a.attackDur; }
      if (ANIM === 'hit') { a.flinchT = 0.1; a.flinchDur = 0.4; a.flinchKind = i % 3 === 0 ? 'head' : (i % 3 === 1 ? 'body' : 'leg'); }
      if (ANIM === 'crawl') { a.crawl = true; a.move = 0.8; }
      if (ANIM === 'death') { a.death = { t: 0.55, x: 0.9, v: 0.4, fallYaw: Math.PI }; }
    }
  } else {
    for (let i = 0; i < 4; i++) {
      const z = spawnZombie((i - 1.5) * 1.4, zbase - (i % 2), i % 2 ? skinA : skinC);
      z.root.rotation.y = Math.PI; z.setMove(1); group.push(z);
    }
  }
  if (VIEW === 'fire') {
    setTimeout(() => {
      const from = camera.position.clone();
      const to = zombies[0].root.position.clone().setY(1.2);
      fireEffects(from, to); zombies[0].flinch('body', 0.5);
    }, 100);
  }
  console.log('[main] ready'); window.__gameReady = true;
}
init().catch(e => console.error('[init failed]', e));

// ---------- loop ----------
const clock = new THREE.Clock();
let lastShot = 0;
function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  let moving = false;
  if (VIEW !== 'map') moving = updatePlayer(dt);

  const adsTarget = aiming ? 1 : 0;
  vm.adsAmt += (adsTarget - vm.adsAmt) * Math.min(1, dt * 10);
  camera.fov = 75 - 20 * vm.adsAmt; camera.updateProjectionMatrix();

  vm.bobT += dt * (moving ? 8 : 3);
  vm.bob = Math.sin(vm.bobT) * (moving ? 0.012 : 0.004);
  vm.kick = Math.max(0, vm.kick - dt * 6);
  vm.kickRot = Math.max(0, vm.kickRot - dt * 6);
  const bp = vm.base.clone().lerp(vm.ads, vm.adsAmt);
  vm.pos.copy(bp);
  vm.pos.x += vm.bob * 0.6 * (1 - vm.adsAmt) + vm.swayX * (1 - vm.adsAmt);
  vm.pos.y += Math.abs(Math.sin(vm.bobT)) * 0.008 * (1 - vm.adsAmt) + vm.swayY * (1 - vm.adsAmt) - vm.kick * 0.06;
  vm.pos.z += vm.kick * 0.09;
  vm.group.position.copy(vm.pos);
  if (vm.holder) vm.holder.rotation.set(vm.kickRot * 0.5 + vm.swayY * 0.5 * (1 - vm.adsAmt), vm.swayX * 0.8 * (1 - vm.adsAmt), 0);

  if (firing && t - lastShot > 0.12 && !demoMode) {
    lastShot = t; vm.kick = 1; vm.kickRot = 1; player.pitch += 0.012;
    const from = camera.position.clone();
    const to = camera.position.clone().add(new THREE.Vector3(0, 0, -20).applyEuler(camera.rotation));
    fireEffects(from, to);
  }
  if (flashFrames > 0) { flashFrames--; if (flashFrames === 0) { muzzle.visible = false; muzzleLight.intensity = 0; } }
  for (let i = tracers.length - 1; i >= 0; i--) {
    tracers[i].userData.life -= dt;
    tracers[i].material.opacity = Math.max(0, tracers[i].userData.life / 0.07);
    if (tracers[i].userData.life <= 0) { scene.remove(tracers[i]); tracers.splice(i, 1); }
  }
  if (mapWorld) for (const l of mapWorld.lamps) {
    const f = Math.sin(t * 13 + l.userData.flicker) > -0.92 ? 1 : 0.3;
    l.children[2].intensity = 30 * f;
  }
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
